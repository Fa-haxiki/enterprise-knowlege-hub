import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import neo4j, { Driver, type ManagedTransaction } from 'neo4j-driver';
import type { GraphEdge, GraphEntityType, GraphNode, GraphSubgraph, Triple } from '@ekh/shared';
import { EmbeddingService } from '../llm/embedding.service';
import { cosineSimilarity, normalizeEntityName } from './entity-normalizer';

/** 实体类型封闭白名单：Cypher 标签不能参数化，拼进查询前必须落在该集合内 */
export const ENTITY_TYPES = ['Project', 'Supplier', 'Person', 'Policy', 'Department'] as const;
export type EntityType = (typeof ENTITY_TYPES)[number];

const ENTITY_TYPE_SET = new Set<string>(ENTITY_TYPES);

/** 关系类型封闭白名单：与入库抽取提示词保持一致，禁止 LLM 输出任意关系名 */
export const RELATION_TYPES = new Set<string>([
  'USES_SUPPLIER',
  'OWNED_BY',
  'GOVERNED_BY',
  'PUBLISHES',
  'SERVES',
  'PARTICIPATES_IN',
  'BELONGS_TO',
]);

/** 向量索引名：与 ensureSchema 中的 CREATE VECTOR INDEX 保持一致 */
const ENTITY_VECTOR_INDEX = 'entity_embedding';

export interface ExtractedEntity {
  name: string;
  type: EntityType;
}

/** 抽取关系载荷：类型在写入前强制白名单，防止 LLM 输出拼进 Cypher 标签 */
export interface ExtractedRelationInput {
  source: string;
  sourceType: string;
  target: string;
  targetType: string;
  relation: string;
  confidence: number;
  evidence?: string;
}

/** 对齐候选：图谱中已有的规范实体 + 与待对齐实体的相似度 */
export interface EntityCandidate {
  id: string;
  name: string;
  type: EntityType;
  normName: string;
  aliases: string[];
  normAliases: string[];
  description: string;
  /** 余弦相似度（精确匹配命中时为 1） */
  score: number;
}

/** 对齐后的实体写入指令：isNew 为 CREATE，否则 MERGE 进已有节点 */
export interface AlignedEntityWrite {
  id: string;
  type: EntityType;
  name: string;
  normName: string;
  aliases: string[];
  normAliases: string[];
  description: string;
  /** 新实体必填；已有实体保持原 embedding 不漂移 */
  embedding?: number[];
  isNew: boolean;
  /** 本文档中提及该实体的 chunk_id 列表（写 MENTIONS + mention_count） */
  mentionChunkIds: string[];
}

export interface AlignedRelationWrite {
  sourceId: string;
  targetId: string;
  relation: string;
  confidence: number;
  evidence?: string;
  chunkId: string;
}

export interface AlignedGraphWrite {
  workspaceId: string;
  documentId: string;
  chunkIds: string[];
  entities: AlignedEntityWrite[];
  relations: AlignedRelationWrite[];
}

export interface EntityDetail extends GraphNode {
  workspaceId: string;
  createdAt?: string;
  updatedAt?: string;
  mentions: { chunkId: string; documentId: string }[];
  relations: { direction: 'out' | 'in'; relation: string; other: GraphNode; weight: number }[];
}

export interface GraphStats {
  entities: number;
  entitiesByType: Record<string, number>;
  relations: number;
  documents: number;
}

/** 从节点标签中取实体类型（去掉公共标签 Entity） */
const TYPE_OF_LABELS = "head([l IN labels(%s) WHERE l <> 'Entity'])";
const typeExpr = (v: string) => TYPE_OF_LABELS.replace('%s', v);

/**
 * Neo4j 封装：schema 管理、实体对齐候选召回、对齐写入、多跳推理、拓扑查询。
 *
 * 图模型：
 *   (:Chunk {chunk_id, document_id, workspace_id})-[:MENTIONS]->(:Entity:<Type> {...})
 *   (:Entity)-[:REL {source_chunk_id, document_id, confidence, evidence}]->(:Entity)
 * 实体以对齐后的 uuid `id` 为主键，`name` 为规范名，`aliases` 收集其它写法，
 * `embedding` 存 LIST<FLOAT> 走向量索引做候选召回；关系边按溯源 chunk 一条一边，查询时聚合。
 */
@Injectable()
export class GraphService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(GraphService.name);
  private driver: Driver;
  private schemaReady: Promise<void> | null = null;

  constructor(
    private readonly config: ConfigService,
    private readonly embedding: EmbeddingService,
  ) {}

  async onModuleInit() {
    this.driver = neo4j.driver(
      this.config.get<string>('neo4j.uri') ?? 'bolt://localhost:7687',
      neo4j.auth.basic(
        this.config.get<string>('neo4j.user') ?? 'neo4j',
        this.config.get<string>('neo4j.password') ?? '',
      ),
      // 计数/度数直接以 JS number 返回，免去逐字段 Integer 转换
      { maxConnectionPoolSize: 20, connectionAcquisitionTimeout: 5_000, disableLosslessIntegers: true },
    );
    // Neo4j 未就绪不阻断进程启动：schema 会在首次写入前再次尝试
    await this.ensureSchema().catch((e) =>
      this.logger.warn(`neo4j schema init deferred: ${(e as Error).message}`),
    );
  }

  async onModuleDestroy() {
    await this.driver?.close();
  }

  async ping(): Promise<boolean> {
    try {
      await this.driver.getServerInfo();
      return true;
    } catch {
      return false;
    }
  }

  private get embeddingDim(): number {
    return this.config.get<number>('embedding.dim') ?? 1024;
  }

  // ---------------- schema ----------------

  /**
   * 幂等建 schema：唯一约束 + 查找索引 + 实体向量索引。
   * 社区版向量索引只能建在 LIST<FLOAT> 属性上；维度在建索引时固定，改 EMBEDDING_DIM 需 resetAll 重建。
   */
  ensureSchema(): Promise<void> {
    if (!this.schemaReady) {
      this.schemaReady = this.createSchema().catch((e) => {
        this.schemaReady = null;
        throw e;
      });
    }
    return this.schemaReady;
  }

  private async createSchema() {
    const session = this.driver.session();
    try {
      const statements = [
        'CREATE CONSTRAINT entity_id_unique IF NOT EXISTS FOR (n:Entity) REQUIRE n.id IS UNIQUE',
        'CREATE INDEX entity_workspace IF NOT EXISTS FOR (n:Entity) ON (n.workspace_id)',
        'CREATE INDEX entity_ws_norm IF NOT EXISTS FOR (n:Entity) ON (n.workspace_id, n.norm_name)',
        'CREATE CONSTRAINT chunk_id_unique IF NOT EXISTS FOR (c:Chunk) REQUIRE c.chunk_id IS UNIQUE',
        'CREATE INDEX chunk_document IF NOT EXISTS FOR (c:Chunk) ON (c.document_id)',
        `CREATE VECTOR INDEX ${ENTITY_VECTOR_INDEX} IF NOT EXISTS FOR (n:Entity) ON (n.embedding)
         OPTIONS {indexConfig: {\`vector.dimensions\`: ${this.embeddingDim}, \`vector.similarity_function\`: 'cosine'}}`,
      ];
      for (const stmt of statements) await session.run(stmt);
      this.logger.log('neo4j schema ready');
    } finally {
      await session.close();
    }
  }

  /**
   * 全量清空：分批删除全部节点/关系 → 删除全部约束与索引 → 重建 schema。
   * 用于新 schema 上线或图谱质量整体重建，调用方随后需对所有文档重跑 fromStage=graph。
   */
  async resetAll(): Promise<{ deletedNodes: number }> {
    const session = this.driver.session();
    let deletedNodes = 0;
    try {
      for (;;) {
        const res = await session.run(
          'MATCH (n) WITH n LIMIT 10000 DETACH DELETE n RETURN count(n) AS deleted',
        );
        const deleted = (res.records[0]?.get('deleted') as number) ?? 0;
        deletedNodes += deleted;
        if (deleted === 0) break;
      }
      const constraints = await session.run('SHOW CONSTRAINTS YIELD name RETURN name');
      for (const r of constraints.records) {
        await session.run(`DROP CONSTRAINT \`${r.get('name') as string}\` IF EXISTS`);
      }
      const indexes = await session.run(
        "SHOW INDEXES YIELD name, type WHERE type <> 'LOOKUP' RETURN name",
      );
      for (const r of indexes.records) {
        await session.run(`DROP INDEX \`${r.get('name') as string}\` IF EXISTS`);
      }
    } finally {
      await session.close();
    }
    this.schemaReady = null;
    await this.ensureSchema();
    this.logger.warn(`neo4j graph reset: ${deletedNodes} nodes deleted, schema recreated`);
    return { deletedNodes };
  }

  // ---------------- 对齐：候选召回 ----------------

  /**
   * 规则通道：归一化名或归一化别名精确命中（同 workspace、同类型）。
   * 返回所有命中的候选，由调用方按 normName/normAliases 回填到各自输入。
   */
  async findExact(workspaceIds: string[], type: EntityType, normNames: string[]): Promise<EntityCandidate[]> {
    if (!ENTITY_TYPE_SET.has(type) || normNames.length === 0 || workspaceIds.length === 0) return [];
    const session = this.driver.session();
    try {
      const res = await session.run(
        `MATCH (n:Entity:${type})
         WHERE n.workspace_id IN $wsIds
           AND (n.norm_name IN $norms OR any(a IN coalesce(n.norm_aliases, []) WHERE a IN $norms))
         RETURN n.id AS id, n.name AS name, n.norm_name AS normName,
                coalesce(n.aliases, []) AS aliases, coalesce(n.norm_aliases, []) AS normAliases,
                coalesce(n.description, '') AS description`,
        { wsIds: workspaceIds, norms: normNames },
      );
      return res.records.map((r) => ({
        id: r.get('id') as string,
        name: r.get('name') as string,
        type,
        normName: r.get('normName') as string,
        aliases: r.get('aliases') as string[],
        normAliases: r.get('normAliases') as string[],
        description: r.get('description') as string,
        score: 1,
      }));
    } finally {
      await session.close();
    }
  }

  /**
   * 向量通道：kNN 召回同类型候选。索引不支持预过滤，先取 vectorK 个再按 workspace/type 过滤。
   * 相似度用候选 embedding 在本地重新算精确余弦，不依赖索引 score 的归一化方式。
   */
  async findSimilar(
    workspaceIds: string[],
    type: EntityType,
    vector: number[],
    opts?: { vectorK?: number; topK?: number },
  ): Promise<EntityCandidate[]> {
    if (!ENTITY_TYPE_SET.has(type) || workspaceIds.length === 0) return [];
    await this.ensureSchema();
    const vectorK = opts?.vectorK ?? this.config.get<number>('graph.alignVectorK') ?? 50;
    const topK = opts?.topK ?? this.config.get<number>('graph.alignTopK') ?? 5;
    const session = this.driver.session();
    try {
      const res = await session.run(
        `CALL db.index.vector.queryNodes($index, $k, $vec) YIELD node, score
         WHERE node.workspace_id IN $wsIds AND node:${type}
         WITH node, score ORDER BY score DESC LIMIT $top
         RETURN node.id AS id, node.name AS name, node.norm_name AS normName,
                coalesce(node.aliases, []) AS aliases, coalesce(node.norm_aliases, []) AS normAliases,
                coalesce(node.description, '') AS description, node.embedding AS embedding, score`,
        { index: ENTITY_VECTOR_INDEX, k: neo4j.int(vectorK), vec: vector, wsIds: workspaceIds, top: neo4j.int(topK) },
      );
      return res.records
        .map((r) => {
          const emb = r.get('embedding') as number[] | null;
          const cos = emb ? cosineSimilarity(vector, emb) : (r.get('score') as number) * 2 - 1;
          return {
            id: r.get('id') as string,
            name: r.get('name') as string,
            type,
            normName: r.get('normName') as string,
            aliases: r.get('aliases') as string[],
            normAliases: r.get('normAliases') as string[],
            description: r.get('description') as string,
            score: cos,
          };
        })
        .sort((a, b) => b.score - a.score);
    } finally {
      await session.close();
    }
  }

  // ---------------- 对齐：写入 ----------------

  /**
   * 对齐结果落图（单写事务）：Chunk MERGE → 新实体 CREATE / 已有实体 SET → MENTIONS → 关系边。
   * 实体/关系类型强制白名单，防止 LLM 输出被拼进 Cypher 标签造成注入。
   */
  async writeAlignedGraph(payload: AlignedGraphWrite): Promise<void> {
    await this.ensureSchema();
    const session = this.driver.session();
    try {
      await session.executeWrite(async (tx) => {
        await tx.run(
          `UNWIND $chunkIds AS cid
           MERGE (c:Chunk {chunk_id: cid})
           SET c.document_id = $documentId, c.workspace_id = $workspaceId`,
          { chunkIds: payload.chunkIds, documentId: payload.documentId, workspaceId: payload.workspaceId },
        );
        await this.writeEntities(tx, payload);
        await this.writeMentions(tx, payload);
        await this.writeRelations(tx, payload);
      });
    } finally {
      await session.close();
    }
  }

  private async writeEntities(tx: ManagedTransaction, payload: AlignedGraphWrite) {
    const newByType = new Map<string, AlignedEntityWrite[]>();
    const existing: AlignedEntityWrite[] = [];
    for (const e of payload.entities) {
      if (!ENTITY_TYPE_SET.has(e.type)) continue;
      if (e.isNew) newByType.set(e.type, [...(newByType.get(e.type) ?? []), e]);
      else existing.push(e);
    }

    // 新实体：按 id MERGE（任务重试幂等），首次创建时打类型标签并写 embedding
    for (const [type, rows] of newByType) {
      await tx.run(
        `UNWIND $rows AS row
         MERGE (n:Entity {id: row.id})
         ON CREATE SET n:${type},
                       n.name = row.name, n.norm_name = row.normName,
                       n.aliases = row.aliases, n.norm_aliases = row.normAliases,
                       n.description = row.description, n.workspace_id = $workspaceId,
                       n.mention_count = row.mentions, n.created_at = datetime(), n.updated_at = datetime()
         WITH n, row
         WHERE row.embedding IS NOT NULL
         CALL db.create.setNodeVectorProperty(n, 'embedding', row.embedding)
         RETURN count(n) AS created`,
        {
          rows: rows.map((e) => ({
            id: e.id,
            name: e.name,
            normName: e.normName,
            aliases: e.aliases,
            normAliases: e.normAliases,
            description: e.description,
            mentions: e.mentionChunkIds.length,
            embedding: e.embedding ?? null,
          })),
          workspaceId: payload.workspaceId,
        },
      );
    }

    // 已有实体：别名去重追加（不含规范名本身）、描述取信息量更大的一份、提及计数累加
    if (existing.length > 0) {
      await tx.run(
        `UNWIND $rows AS row
         MATCH (n:Entity {id: row.id})
         SET n.aliases = reduce(acc = coalesce(n.aliases, []), a IN row.aliases |
                           CASE WHEN a IN acc OR a = n.name OR a = '' THEN acc ELSE acc + a END),
             n.norm_aliases = reduce(acc = coalesce(n.norm_aliases, []), a IN row.normAliases |
                           CASE WHEN a IN acc OR a = n.norm_name OR a = '' THEN acc ELSE acc + a END),
             n.description = CASE
                               WHEN size(coalesce(n.description, '')) >= size(coalesce(row.description, ''))
                               THEN coalesce(n.description, '') ELSE row.description END,
             n.mention_count = coalesce(n.mention_count, 0) + row.mentions,
             n.updated_at = datetime()`,
        {
          rows: existing.map((e) => ({
            id: e.id,
            aliases: e.aliases,
            normAliases: e.normAliases,
            description: e.description,
            mentions: e.mentionChunkIds.length,
          })),
        },
      );
    }
  }

  private async writeMentions(tx: ManagedTransaction, payload: AlignedGraphWrite) {
    const mentions = payload.entities.flatMap((e) =>
      e.mentionChunkIds.map((chunkId) => ({ chunkId, entityId: e.id })),
    );
    if (mentions.length === 0) return;
    await tx.run(
      `UNWIND $mentions AS m
       MATCH (c:Chunk {chunk_id: m.chunkId})
       MATCH (n:Entity {id: m.entityId})
       MERGE (c)-[:MENTIONS]->(n)`,
      { mentions },
    );
  }

  private async writeRelations(tx: ManagedTransaction, payload: AlignedGraphWrite) {
    const byRelation = new Map<string, AlignedRelationWrite[]>();
    for (const r of payload.relations) {
      if (!RELATION_TYPES.has(r.relation)) continue;
      if (r.sourceId === r.targetId) continue;
      byRelation.set(r.relation, [...(byRelation.get(r.relation) ?? []), r]);
    }
    for (const [relation, rows] of byRelation) {
      await tx.run(
        `UNWIND $rows AS row
         MATCH (s:Entity {id: row.sourceId})
         MATCH (t:Entity {id: row.targetId})
         MERGE (s)-[r:${relation} {source_chunk_id: row.chunkId}]->(t)
         SET r.confidence = row.confidence, r.evidence = row.evidence,
             r.document_id = $documentId, r.extracted_at = datetime()`,
        {
          rows: rows.map((r) => ({
            sourceId: r.sourceId,
            targetId: r.targetId,
            chunkId: r.chunkId,
            confidence: r.confidence,
            evidence: r.evidence ?? null,
          })),
          documentId: payload.documentId,
        },
      );
    }
  }

  // ---------------- 问答：实体对齐 + 多跳 ----------------

  /**
   * 路由实体 → 图谱实体：规则精确命中优先，其次向量 kNN（同类型、白名单空间）取最相似且 ≥ queryAlignCos。
   * 返回带 id 的图谱节点，作为多跳起点。
   */
  async alignQueryEntities(entities: ExtractedEntity[], workspaceIds: string[]): Promise<GraphNode[]> {
    if (entities.length === 0 || workspaceIds.length === 0) return [];
    const valid = entities.filter((e) => ENTITY_TYPE_SET.has(e.type) && e.name?.trim());
    if (valid.length === 0) return [];

    const resolved = new Map<string, GraphNode>();
    const pending: ExtractedEntity[] = [];
    for (const e of valid) {
      const norm = normalizeEntityName(e.name, e.type);
      const hits = norm ? await this.findExact(workspaceIds, e.type, [norm]) : [];
      if (hits[0]) resolved.set(hits[0].id, { id: hits[0].id, name: hits[0].name, type: e.type });
      else pending.push(e);
    }
    if (pending.length === 0) return [...resolved.values()];

    const minCos = this.config.get<number>('graph.queryAlignCos') ?? 0.85;
    const vectors = await this.embedding.embed(pending.map((e) => e.name));
    for (let i = 0; i < pending.length; i++) {
      const e = pending[i];
      const [best] = await this.findSimilar(workspaceIds, e.type, vectors[i], { topK: 1 });
      if (best && best.score >= minCos) {
        resolved.set(best.id, { id: best.id, name: best.name, type: e.type });
      } else {
        this.logger.debug(
          `query align miss: ${e.type}/${e.name} best=${best ? `${best.name}@${best.score.toFixed(3)}` : 'none'}`,
        );
      }
    }
    return [...resolved.values()];
  }

  /** 兜底起点：召回分片提及的实体（按提及数排序），用于路由实体对齐不到图谱时 */
  async entitiesByChunkIds(chunkIds: string[], workspaceIds: string[], limit = 5): Promise<GraphNode[]> {
    if (chunkIds.length === 0 || workspaceIds.length === 0) return [];
    const session = this.driver.session();
    try {
      const res = await session.run(
        `MATCH (c:Chunk)-[:MENTIONS]->(e:Entity)
         WHERE c.chunk_id IN $chunkIds AND e.workspace_id IN $wsIds
         WITH e, count(c) AS hits
         ORDER BY hits DESC, e.mention_count DESC
         LIMIT $limit
         RETURN e.id AS id, e.name AS name, ${typeExpr('e')} AS type`,
        { chunkIds, wsIds: workspaceIds, limit: neo4j.int(limit) },
      );
      return res.records.map((r) => ({
        id: r.get('id') as string,
        name: r.get('name') as string,
        type: r.get('type') as GraphEntityType,
      }));
    } finally {
      await session.close();
    }
  }

  /**
   * 多跳推理：从起点实体沿有向出边扩展 ≤ maxHops 跳（与语义链方向一致，避免无向扩展发散），
   * 仅沿问题意图相关的关系类型，路径上所有节点都限定在白名单空间。
   * 返回带 id 的子图（平行边按溯源 chunk 聚合为 weight）与去重后的 triples（供 Prompt）。
   */
  async multiHop(
    seedIds: string[],
    maxHops: number,
    workspaceIds: string[],
    relationTypes?: string[],
  ): Promise<{ subgraph: GraphSubgraph; triples: Triple[] }> {
    const empty = { subgraph: { nodes: [], edges: [], seeds: seedIds }, triples: [] as Triple[] };
    if (seedIds.length === 0 || workspaceIds.length === 0) return empty;
    const hops = Math.min(Math.max(maxHops, 1), 3);
    const relFilter =
      relationTypes && relationTypes.length > 0
        ? relationTypes.filter((r) => RELATION_TYPES.has(r))
        : [...RELATION_TYPES];
    if (relFilter.length === 0) return empty;

    const session = this.driver.session();
    try {
      const res = await session.run(
        `MATCH (n:Entity) WHERE n.id IN $ids AND n.workspace_id IN $wsIds
         MATCH path = (n)-[*1..${hops}]->(m:Entity)
         WHERE all(r IN relationships(path) WHERE type(r) IN $relTypes)
           AND all(x IN nodes(path) WHERE x.workspace_id IN $wsIds)
         UNWIND relationships(path) AS rel
         WITH startNode(rel) AS s, endNode(rel) AS t, type(rel) AS relType,
              collect(DISTINCT rel.source_chunk_id) AS chunks, avg(rel.confidence) AS confidence
         RETURN s.id AS sid, s.name AS sname, ${typeExpr('s')} AS stype, s.workspace_id AS sws,
                t.id AS tid, t.name AS tname, ${typeExpr('t')} AS ttype, t.workspace_id AS tws,
                relType, size(chunks) AS weight, confidence
         ORDER BY weight DESC
         LIMIT 60`,
        { ids: seedIds, wsIds: workspaceIds, relTypes: relFilter },
      );
      const nodes = new Map<string, GraphNode>();
      const edges: GraphEdge[] = [];
      const triples: Triple[] = [];
      const seenTriple = new Set<string>();
      for (const r of res.records) {
        const sid = r.get('sid') as string;
        const tid = r.get('tid') as string;
        const sname = r.get('sname') as string;
        const tname = r.get('tname') as string;
        const relType = r.get('relType') as string;
        if (!nodes.has(sid)) {
          nodes.set(sid, {
            id: sid,
            name: sname,
            type: r.get('stype') as GraphEntityType,
            workspace_id: r.get('sws') as string,
          });
        }
        if (!nodes.has(tid)) {
          nodes.set(tid, {
            id: tid,
            name: tname,
            type: r.get('ttype') as GraphEntityType,
            workspace_id: r.get('tws') as string,
          });
        }
        edges.push({
          source: sid,
          target: tid,
          relation: relType,
          weight: r.get('weight') as number,
          confidence: (r.get('confidence') as number | null) ?? undefined,
        });
        const key = `${sname}|${relType}|${tname}`;
        if (!seenTriple.has(key)) {
          seenTriple.add(key);
          triples.push([sname, relType, tname]);
        }
      }
      return { subgraph: { nodes: [...nodes.values()], edges, seeds: seedIds }, triples };
    } finally {
      await session.close();
    }
  }

  /** 图增强检索：按实体 id 反查关联分片（MENTIONS），ACL 过滤 */
  async chunksByEntityIds(entityIds: string[], workspaceIds: string[], limit = 10): Promise<string[]> {
    if (entityIds.length === 0 || workspaceIds.length === 0) return [];
    const session = this.driver.session();
    try {
      const res = await session.run(
        `MATCH (c:Chunk)-[:MENTIONS]->(e:Entity)
         WHERE e.id IN $ids AND c.workspace_id IN $wsIds
         RETURN DISTINCT c.chunk_id AS chunkId
         LIMIT $limit`,
        { ids: entityIds, wsIds: workspaceIds, limit: neo4j.int(limit) },
      );
      return res.records.map((r) => r.get('chunkId') as string);
    } finally {
      await session.close();
    }
  }

  // ---------------- 拓扑查询（知识图谱页面） ----------------

  /** 空间概览：按度数取 Top-N 实体及它们之间的关系 */
  async overview(workspaceId: string, limit = 150, types?: string[]): Promise<GraphSubgraph> {
    const typeFilter = (types ?? []).filter((t) => ENTITY_TYPE_SET.has(t));
    const session = this.driver.session();
    try {
      const res = await session.run(
        `MATCH (n:Entity) WHERE n.workspace_id = $ws
           ${typeFilter.length > 0 ? 'AND any(l IN labels(n) WHERE l IN $types)' : ''}
         OPTIONAL MATCH (n)-[r]-(:Entity)
         WITH n, count(r) AS degree
         ORDER BY degree DESC, n.mention_count DESC
         LIMIT $limit
         RETURN n.id AS id`,
        { ws: workspaceId, types: typeFilter, limit: neo4j.int(limit) },
      );
      const ids = res.records.map((r) => r.get('id') as string);
      return this.loadSubgraph(workspaceId, ids);
    } finally {
      await session.close();
    }
  }

  /** 实体搜索：规范名或别名包含关键词（大小写不敏感），按提及数排序 */
  async searchEntities(workspaceId: string, keyword: string, limit = 20): Promise<GraphNode[]> {
    const q = keyword.trim().toLowerCase();
    if (!q) return [];
    const session = this.driver.session();
    try {
      const res = await session.run(
        `MATCH (n:Entity) WHERE n.workspace_id = $ws
           AND (toLower(n.name) CONTAINS $q OR any(a IN coalesce(n.aliases, []) WHERE toLower(a) CONTAINS $q))
         RETURN n.id AS id, n.name AS name, ${typeExpr('n')} AS type,
                coalesce(n.aliases, []) AS aliases, coalesce(n.description, '') AS description,
                coalesce(n.mention_count, 0) AS mentionCount
         ORDER BY mentionCount DESC, n.name
         LIMIT $limit`,
        { ws: workspaceId, q, limit: neo4j.int(limit) },
      );
      return res.records.map((r) => ({
        id: r.get('id') as string,
        name: r.get('name') as string,
        type: r.get('type') as GraphEntityType,
        aliases: r.get('aliases') as string[],
        description: r.get('description') as string,
        mention_count: r.get('mentionCount') as number,
      }));
    } finally {
      await session.close();
    }
  }

  /** 邻域子图：以实体为中心无向扩展 ≤ hops 跳（不含 MENTIONS），节点上限 limit */
  async neighborhood(workspaceId: string, entityId: string, hops = 1, limit = 80): Promise<GraphSubgraph> {
    const h = Math.min(Math.max(hops, 1), 2);
    const session = this.driver.session();
    try {
      const res = await session.run(
        `MATCH (n:Entity {id: $id}) WHERE n.workspace_id = $ws
         OPTIONAL MATCH path = (n)-[*1..${h}]-(m:Entity)
         WHERE all(x IN nodes(path) WHERE x.workspace_id = $ws)
           AND none(r IN relationships(path) WHERE type(r) = 'MENTIONS')
         WITH n, m, min(length(path)) AS dist
         ORDER BY dist, m.mention_count DESC
         LIMIT $limit
         RETURN n.id AS center, collect(m.id) AS others`,
        { id: entityId, ws: workspaceId, limit: neo4j.int(limit) },
      );
      const rec = res.records[0];
      if (!rec) return { nodes: [], edges: [], seeds: [entityId] };
      const ids = [rec.get('center') as string, ...((rec.get('others') as (string | null)[]).filter(Boolean) as string[])];
      const sub = await this.loadSubgraph(workspaceId, ids);
      return { ...sub, seeds: [entityId] };
    } finally {
      await session.close();
    }
  }

  /** 文档子图：该文档提及的实体 + 由该文档抽出的关系 */
  async documentSubgraph(workspaceId: string, documentId: string): Promise<GraphSubgraph> {
    const session = this.driver.session();
    try {
      const res = await session.run(
        `MATCH (c:Chunk {document_id: $documentId})-[:MENTIONS]->(n:Entity)
         WHERE n.workspace_id = $ws
         RETURN DISTINCT n.id AS id`,
        { documentId, ws: workspaceId },
      );
      const ids = res.records.map((r) => r.get('id') as string);
      return this.loadSubgraph(workspaceId, ids, documentId);
    } finally {
      await session.close();
    }
  }

  /** 实体详情：属性 + 提及分片 + 一跳关系（含方向） */
  async entityDetail(workspaceId: string, entityId: string): Promise<EntityDetail | null> {
    const session = this.driver.session();
    try {
      const res = await session.run(
        `MATCH (n:Entity {id: $id}) WHERE n.workspace_id = $ws
         OPTIONAL MATCH (c:Chunk)-[:MENTIONS]->(n)
         WITH n, collect(DISTINCT {chunkId: c.chunk_id, documentId: c.document_id}) AS mentions
         OPTIONAL MATCH (n)-[r]-(m:Entity) WHERE type(r) <> 'MENTIONS'
         WITH n, mentions, m, type(r) AS relType,
              CASE WHEN startNode(r) = n THEN 'out' ELSE 'in' END AS direction, count(r) AS weight
         RETURN n.id AS id, n.name AS name, ${typeExpr('n')} AS type, n.workspace_id AS workspaceId,
                coalesce(n.aliases, []) AS aliases, coalesce(n.description, '') AS description,
                coalesce(n.mention_count, 0) AS mentionCount,
                toString(n.created_at) AS createdAt, toString(n.updated_at) AS updatedAt,
                mentions,
                collect(CASE WHEN m IS NULL THEN NULL ELSE {
                  direction: direction, relation: relType, weight: weight,
                  other: {id: m.id, name: m.name, type: ${typeExpr('m')}}
                } END) AS relations`,
        { id: entityId, ws: workspaceId },
      );
      const rec = res.records[0];
      if (!rec) return null;
      const mentions = (rec.get('mentions') as { chunkId: string | null; documentId: string | null }[]).filter(
        (m) => m.chunkId,
      ) as { chunkId: string; documentId: string }[];
      const relations = (rec.get('relations') as (EntityDetail['relations'][number] | null)[]).filter(
        (r): r is EntityDetail['relations'][number] => r !== null,
      );
      return {
        id: rec.get('id') as string,
        name: rec.get('name') as string,
        type: rec.get('type') as GraphEntityType,
        workspaceId: rec.get('workspaceId') as string,
        aliases: rec.get('aliases') as string[],
        description: rec.get('description') as string,
        mention_count: rec.get('mentionCount') as number,
        degree: relations.reduce((acc, r) => acc + r.weight, 0),
        createdAt: (rec.get('createdAt') as string | null) ?? undefined,
        updatedAt: (rec.get('updatedAt') as string | null) ?? undefined,
        mentions,
        relations,
      };
    } finally {
      await session.close();
    }
  }

  async stats(workspaceId: string): Promise<GraphStats> {
    // 同一 session 不能并发跑查询，三条统计串行执行
    const session = this.driver.session();
    try {
      const ent = await session.run(
        `MATCH (n:Entity) WHERE n.workspace_id = $ws
         RETURN ${typeExpr('n')} AS type, count(n) AS cnt`,
        { ws: workspaceId },
      );
      const rel = await session.run(
        `MATCH (:Entity {workspace_id: $ws})-[r]->(:Entity) RETURN count(r) AS cnt`,
        { ws: workspaceId },
      );
      const docs = await session.run(
        `MATCH (c:Chunk {workspace_id: $ws}) RETURN count(DISTINCT c.document_id) AS cnt`,
        { ws: workspaceId },
      );
      const entitiesByType: Record<string, number> = {};
      let entities = 0;
      for (const r of ent.records) {
        const cnt = r.get('cnt') as number;
        entitiesByType[r.get('type') as string] = cnt;
        entities += cnt;
      }
      return {
        entities,
        entitiesByType,
        relations: (rel.records[0]?.get('cnt') as number) ?? 0,
        documents: (docs.records[0]?.get('cnt') as number) ?? 0,
      };
    } finally {
      await session.close();
    }
  }

  /** 按 id 集合装载子图：节点（含度数/别名/描述）+ 节点间聚合边；documentId 限定只取该文档抽出的边 */
  private async loadSubgraph(workspaceId: string, ids: string[], documentId?: string): Promise<GraphSubgraph> {
    if (ids.length === 0) return { nodes: [], edges: [] };
    const session = this.driver.session();
    try {
      const nodeRes = await session.run(
        `MATCH (n:Entity) WHERE n.id IN $ids AND n.workspace_id = $ws
         OPTIONAL MATCH (n)-[r]-(:Entity)
         RETURN n.id AS id, n.name AS name, ${typeExpr('n')} AS type,
                coalesce(n.aliases, []) AS aliases, coalesce(n.description, '') AS description,
                coalesce(n.mention_count, 0) AS mentionCount, count(r) AS degree`,
        { ids, ws: workspaceId },
      );
      const edgeRes = await session.run(
        `MATCH (a:Entity)-[r]->(b:Entity)
         WHERE a.id IN $ids AND b.id IN $ids
           ${documentId ? 'AND r.document_id = $documentId' : ''}
         RETURN a.id AS source, b.id AS target, type(r) AS relation,
                count(r) AS weight, avg(r.confidence) AS confidence`,
        { ids, documentId: documentId ?? null },
      );
      const nodes: GraphNode[] = nodeRes.records.map((r) => ({
        id: r.get('id') as string,
        name: r.get('name') as string,
        type: r.get('type') as GraphEntityType,
        aliases: r.get('aliases') as string[],
        description: r.get('description') as string,
        mention_count: r.get('mentionCount') as number,
        degree: r.get('degree') as number,
      }));
      const edges: GraphEdge[] = edgeRes.records.map((r) => ({
        source: r.get('source') as string,
        target: r.get('target') as string,
        relation: r.get('relation') as string,
        weight: r.get('weight') as number,
        confidence: (r.get('confidence') as number | null) ?? undefined,
      }));
      return { nodes, edges };
    } finally {
      await session.close();
    }
  }

  // ---------------- 删除 ----------------

  /**
   * 删除文档的图数据：该文档抽出的关系边 → Chunk 节点 → 不再被任何分片提及的孤儿实体。
   * 实体被多篇文档共享，只删已无 MENTIONS 的；关系边带 document_id / source_chunk_id 可追溯来源。
   */
  async deleteByDocument(documentId: string) {
    const session = this.driver.session();
    try {
      await session.run(
        `MATCH (c:Chunk {document_id: $documentId})
         WITH collect(c.chunk_id) AS chunkIds
         MATCH (:Entity)-[r]->(:Entity)
         WHERE r.document_id = $documentId OR r.source_chunk_id IN chunkIds
         DELETE r`,
        { documentId },
      );
      await session.run(`MATCH (c:Chunk {document_id: $documentId}) DETACH DELETE c`, { documentId });
      await session.run(`MATCH (n:Entity) WHERE NOT (n)<-[:MENTIONS]-(:Chunk) DETACH DELETE n`);
    } finally {
      await session.close();
    }
  }

  /** 清空某空间的全部图数据（重建前置） */
  async deleteByWorkspace(workspaceId: string) {
    const session = this.driver.session();
    try {
      await session.run(`MATCH (c:Chunk {workspace_id: $ws}) DETACH DELETE c`, { ws: workspaceId });
      await session.run(`MATCH (n:Entity {workspace_id: $ws}) DETACH DELETE n`, { ws: workspaceId });
    } finally {
      await session.close();
    }
  }
}
