import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import neo4j, { Driver } from 'neo4j-driver';
import type { Triple } from '@ekh/shared';

/** 实体类型封闭白名单：Cypher 标签不能参数化，拼进查询前必须落在该集合内 */
export const ENTITY_TYPES = ['Project', 'Supplier', 'Person', 'Policy', 'Department'] as const;
export type EntityType = (typeof ENTITY_TYPES)[number];

const ENTITY_TYPE_SET = new Set<string>(ENTITY_TYPES);

/** 关系类型封闭白名单：与入库抽取提示词保持一致，禁止 LLM 输出任意关系名 */
const RELATION_TYPES = new Set<string>([
  'USES_SUPPLIER',
  'OWNED_BY',
  'GOVERNED_BY',
  'PUBLISHES',
  'SERVES',
  'PARTICIPATES_IN',
  'BELONGS_TO',
]);

export interface ExtractedEntity {
  name: string;
  type: EntityType;
}

/** 建图关系载荷：类型在写入前强制白名单，防止 LLM 输出拼进 Cypher 标签 */
export interface ExtractedRelationInput {
  source: string;
  sourceType: string;
  target: string;
  targetType: string;
  relation: string;
  confidence: number;
}

/** Neo4j 封装：实体对齐、多跳推理、建图写入 */
@Injectable()
export class GraphService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(GraphService.name);
  private driver: Driver;

  constructor(private readonly config: ConfigService) {}

  onModuleInit() {
    this.driver = neo4j.driver(
      this.config.get<string>('neo4j.uri') ?? 'bolt://localhost:7687',
      neo4j.auth.basic(
        this.config.get<string>('neo4j.user') ?? 'neo4j',
        this.config.get<string>('neo4j.password') ?? '',
      ),
      { maxConnectionPoolSize: 20, connectionAcquisitionTimeout: 5_000 },
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

  /** 实体对齐：名称模糊匹配到已有节点；仅对齐白名单空间 MENTIONS 可达的实体，避免跨租户对齐 */
  async alignEntities(entities: ExtractedEntity[], workspaceIds: string[]): Promise<ExtractedEntity[]> {
    if (entities.length === 0 || workspaceIds.length === 0) return [];
    const session = this.driver.session();
    try {
      const aligned: ExtractedEntity[] = [];
      for (const e of entities) {
        if (!ENTITY_TYPE_SET.has(e.type)) continue;
        const res = await session.run(
          `MATCH (c:Chunk)-[:MENTIONS]->(n:${e.type})
           WHERE c.workspace_id IN $wsIds
             AND (n.name = $name OR apoc.text.levenshteinSimilarity(n.name, $name) >= 0.8)
           RETURN n.name AS name
           ORDER BY apoc.text.levenshteinSimilarity(n.name, $name) DESC
           LIMIT 1`,
          { name: e.name, wsIds: workspaceIds },
        );
        const hit = res.records[0]?.get('name');
        if (hit) aligned.push({ name: hit, type: e.type });
      }
      return aligned;
    } finally {
      await session.close();
    }
  }

  /**
   * 多跳推理：以实体为起点扩展 ≤ maxHops 跳，返回推理 triples。
   * 起点与关系边都限制在白名单空间子图内（Chunk-[:MENTIONS]->Entity 可达），
   * 关系边要求 source_chunk_id 所属 Chunk 落在白名单空间，防止跨租户关系泄漏。
   * 查询值全部参数化，禁止字符串拼接。
   */
  async multiHop(entities: ExtractedEntity[], maxHops: number, workspaceIds: string[]): Promise<Triple[]> {
    if (entities.length === 0 || workspaceIds.length === 0) return [];
    const session = this.driver.session();
    try {
      const hops = Math.min(Math.max(maxHops, 1), 3);
      const res = await session.run(
        `MATCH (n)
         WHERE n.name IN $names
           AND EXISTS { MATCH (c0:Chunk)-[:MENTIONS]->(n) WHERE c0.workspace_id IN $wsIds }
         MATCH path = (n)-[*1..${hops}]-(m)
         UNWIND relationships(path) AS rel
         WITH DISTINCT startNode(rel) AS s, rel, endNode(rel) AS t
         WHERE type(rel) <> 'MENTIONS'
           AND EXISTS {
             MATCH (cs:Chunk)-[:MENTIONS]->(s)
             WHERE cs.workspace_id IN $wsIds
           }
           AND EXISTS {
             MATCH (ct:Chunk)-[:MENTIONS]->(t)
             WHERE ct.workspace_id IN $wsIds
           }
         // 按输出三元组去重：同名不同标签节点、反向重复关系都会被合并
         RETURN DISTINCT coalesce(s.name, s.chunk_id) AS source, type(rel) AS relation,
                coalesce(t.name, t.chunk_id) AS target
         LIMIT 30`,
        { names: entities.map((e) => e.name), wsIds: workspaceIds },
      );
      return res.records.map((r) => [
        r.get('source') as string,
        r.get('relation') as string,
        r.get('target') as string,
      ]);
    } finally {
      await session.close();
    }
  }

  /** 图增强检索：按实体反查关联分片（MENTIONS），ACL 过滤 */
  async chunksByEntities(entityNames: string[], workspaceIds: string[], limit = 10): Promise<string[]> {
    const session = this.driver.session();
    try {
      const res = await session.run(
        `MATCH (c:Chunk)-[:MENTIONS]->(e)
         WHERE e.name IN $names AND c.workspace_id IN $wsIds
         RETURN DISTINCT c.chunk_id AS chunkId
         LIMIT $limit`,
        { names: entityNames, wsIds: workspaceIds, limit: neo4j.int(limit) },
      );
      return res.records.map((r) => r.get('chunkId') as string);
    } finally {
      await session.close();
    }
  }

  /** 建图写入：MERGE 实体 + 关系 + Chunk MENTIONS 关联（Worker 调用）。
   *  实体/关系类型强制白名单，防止 LLM 输出被拼进 Cypher 标签造成注入。 */
  async upsertGraph(payload: {
    chunkId: string;
    documentId: string;
    workspaceId: string;
    entities: ExtractedEntity[];
    relations: ExtractedRelationInput[];
  }) {
    const session = this.driver.session();
    try {
      await session.run(
        `MERGE (c:Chunk {chunk_id: $chunkId})
         SET c.document_id = $documentId, c.workspace_id = $workspaceId`,
        { chunkId: payload.chunkId, documentId: payload.documentId, workspaceId: payload.workspaceId },
      );
      // 实体按类型分组批量 MERGE（Cypher 标签不能参数化，按组拼标签 + UNWIND 批量）
      const entitiesByType = new Map<string, string[]>();
      for (const e of payload.entities) {
        if (!ENTITY_TYPE_SET.has(e.type)) continue;
        entitiesByType.set(e.type, [...(entitiesByType.get(e.type) ?? []), e.name]);
      }
      for (const [type, names] of entitiesByType) {
        await session.run(
          `MATCH (c:Chunk {chunk_id: $chunkId})
           UNWIND $names AS name
           MERGE (n:${type} {name: name, workspace_id: $workspaceId})
           MERGE (c)-[:MENTIONS]->(n)`,
          { chunkId: payload.chunkId, names, workspaceId: payload.workspaceId },
        );
      }
      // 关系按「源类型|目标类型|关系类型」分组批量 MERGE；低置信关系进待审核（P2），不入图
      const relGroups = new Map<string, { source: string; target: string; confidence: number }[]>();
      for (const r of payload.relations) {
        if (r.confidence < 0.7) continue;
        if (!ENTITY_TYPE_SET.has(r.sourceType) || !ENTITY_TYPE_SET.has(r.targetType)) continue;
        if (!RELATION_TYPES.has(r.relation)) continue;
        const key = `${r.sourceType}|${r.targetType}|${r.relation}`;
        relGroups.set(key, [
          ...(relGroups.get(key) ?? []),
          { source: r.source, target: r.target, confidence: r.confidence },
        ]);
      }
      for (const [key, rows] of relGroups) {
        const [sourceType, targetType, relation] = key.split('|');
        await session.run(
          `UNWIND $rows AS row
           MERGE (s:${sourceType} {name: row.source, workspace_id: $workspaceId})
           MERGE (t:${targetType} {name: row.target, workspace_id: $workspaceId})
           MERGE (s)-[rel:${relation}]->(t)
           SET rel.source_chunk_id = $chunkId, rel.confidence = row.confidence, rel.extracted_at = datetime()`,
          { rows, chunkId: payload.chunkId, workspaceId: payload.workspaceId },
        );
      }
    } finally {
      await session.close();
    }
  }

  /** 删除文档的图数据：来源关系边 → Chunk 节点 → 孤儿实体清扫。
   *  实体全局 MERGE 可能被多篇文档共享，只删已无任何连接的；关系边带 source_chunk_id 可追溯来源 */
  async deleteByDocument(documentId: string) {
    const session = this.driver.session();
    try {
      await session.run(
        `MATCH (c:Chunk {document_id: $documentId})
         WITH collect(c.chunk_id) AS chunkIds
         MATCH ()-[r]->() WHERE r.source_chunk_id IN chunkIds
         DELETE r`,
        { documentId },
      );
      await session.run(`MATCH (c:Chunk {document_id: $documentId}) DETACH DELETE c`, { documentId });
      await session.run(`MATCH (n) WHERE NOT n:Chunk AND NOT (n)--() DELETE n`);
    } finally {
      await session.close();
    }
  }
}
