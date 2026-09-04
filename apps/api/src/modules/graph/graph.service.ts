import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import neo4j, { Driver, Session } from 'neo4j-driver';

export interface ExtractedEntity {
  name: string;
  type: string;
  description?: string;
  aliases?: string[];
}

export interface ExtractedRelation {
  source: string;
  target: string;
  relation: string;
  weight?: number;
}

export interface GraphDocumentInput {
  id: string;
  title: string;
  status: string;
  workspaceId: string;
}

export interface GraphChunkExtraction {
  chunkId: string;
  content: string;
  heading: string | null;
  chunkIndex: number;
  totalChunks: number;
  entities: ExtractedEntity[];
  relations: ExtractedRelation[];
}

export interface GraphNodeDto {
  id: string;
  name: string;
  type: string | null;
  description: string | null;
}

export interface GraphEdgeDto {
  source: string;
  target: string;
  relation: string;
  weight: number;
}

export interface GraphSearchHit {
  id: string;
  name: string;
  label: string | null;
  type: string | null;
  title: string | null;
  description: string | null;
  heading: string | null;
  documentId: string | null;
  snippet: string | null;
}

/** 与抽取枚举对齐；多跳 Cypher 只允许这些 relation 属性，防止 LLM 输出拼进查询 */
export const GRAPH_RELATION_TYPES = [
  'BELONGS_TO',
  'MANAGES',
  'PARTICIPATES_IN',
  'RESPONSIBLE_FOR',
  'DEPENDS_ON',
  'RELATED_TO',
] as const;

const RELATION_TYPE_SET = new Set<string>(GRAPH_RELATION_TYPES);

/**
 * Neo4j 图模型（按知识空间隔离）：
 *   (KnowledgeDocument)-[:HAS_CHUNK]->(DocumentChunk)-[:MENTIONS]->(KnowledgeEntity)
 *   (KnowledgeEntity)-[:RELATED_TO {relation, weight}]->(KnowledgeEntity)
 * 实体 MERGE 键为 {name, workspace_id}，不同空间同名实体互不共享。
 */
@Injectable()
export class GraphService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(GraphService.name);
  private driver: Driver | null = null;

  constructor(private readonly config: ConfigService) {}

  async onModuleInit() {
    if (this.config.get<string>('neo4j.enabled') === 'false') {
      this.logger.warn('Neo4j 已禁用（NEO4J_ENABLED=false）');
      return;
    }
    const uri = this.config.get<string>('neo4j.uri') ?? 'bolt://localhost:7687';
    this.driver = neo4j.driver(
      uri,
      neo4j.auth.basic(
        this.config.get<string>('neo4j.user') ?? 'neo4j',
        this.config.get<string>('neo4j.password') ?? '',
      ),
      { maxConnectionPoolSize: 20, connectionAcquisitionTimeout: 5_000 },
    );
    try {
      await this.driver.verifyConnectivity();
      this.logger.log(`Neo4j 已连接：${uri}`);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.logger.warn(`Neo4j 不可用，KG 写入将跳过：${message}`);
      await this.driver.close();
      this.driver = null;
    }
  }

  async onModuleDestroy() {
    await this.driver?.close();
  }

  async ping(): Promise<boolean> {
    if (!this.driver) return false;
    try {
      await this.driver.getServerInfo();
      return true;
    } catch {
      return false;
    }
  }

  /** 单篇文档先清后建；Neo4j 不可用时返回 0，不抛错 */
  async buildForDocument(doc: GraphDocumentInput, chunks: GraphChunkExtraction[]): Promise<number> {
    if (!this.driver) {
      this.logger.warn(`跳过 KG 构建（Neo4j 不可用）：documentId=${doc.id}`);
      return 0;
    }

    await this.deleteForDocument(doc.id, doc.workspaceId);

    const session = this.driver.session();
    const now = new Date().toISOString();
    try {
      await session.run(
        `
        MERGE (d:KnowledgeDocument {id: $id})
        SET d.title = $title, d.status = $status, d.workspace_id = $workspaceId,
            d.updatedAt = $now, d.createdAt = coalesce(d.createdAt, $now)
        `,
        {
          id: doc.id,
          title: doc.title,
          status: doc.status,
          workspaceId: doc.workspaceId,
          now,
        },
      );

      let totalEntities = 0;
      for (const chunk of chunks) {
        await session.run(
          `
          MERGE (c:DocumentChunk {chunkId: $chunkId})
          SET c.documentId = $documentId, c.workspace_id = $workspaceId, c.content = $content,
              c.heading = $heading, c.chunkIndex = $chunkIndex, c.totalChunks = $totalChunks,
              c.updatedAt = $now
          WITH c
          MATCH (d:KnowledgeDocument {id: $documentId})
          MERGE (d)-[r:HAS_CHUNK]->(c)
          SET r.chunkIndex = $chunkIndex
          `,
          {
            chunkId: chunk.chunkId,
            documentId: doc.id,
            workspaceId: doc.workspaceId,
            content: chunk.content,
            heading: chunk.heading,
            chunkIndex: chunk.chunkIndex,
            totalChunks: chunk.totalChunks,
            now,
          },
        );
        totalEntities += await this.writeExtraction(session, doc.workspaceId, chunk);
      }

      this.logger.log(
        `KG 图谱构建完成：documentId=${doc.id}, workspaceId=${doc.workspaceId}, chunks=${chunks.length}, entities=${totalEntities}`,
      );
      return totalEntities;
    } finally {
      await session.close();
    }
  }

  /**
   * 删除文档及其 chunk；再清理同空间「已无人提及」的孤儿实体。
   * workspaceId 缺省时从文档节点读取，避免误删其他空间实体。
   */
  async deleteForDocument(documentId: string, workspaceId?: string) {
    if (!this.driver) return;
    const session = this.driver.session();
    try {
      let wsId = workspaceId ?? null;
      if (!wsId) {
        const found = await session.run(
          `MATCH (d:KnowledgeDocument {id: $id}) RETURN d.workspace_id AS wsId`,
          { id: documentId },
        );
        wsId = (found.records[0]?.get('wsId') as string | null) ?? null;
      }

      await session.run(
        `
        MATCH (d:KnowledgeDocument {id: $id})
        OPTIONAL MATCH (d)-[:HAS_CHUNK]->(c:DocumentChunk)
        DETACH DELETE c, d
        `,
        { id: documentId },
      );

      if (wsId) {
        await session.run(
          `
          MATCH (e:KnowledgeEntity {workspace_id: $wsId})
          WHERE NOT (e)<-[:MENTIONS]-()
          DETACH DELETE e
          `,
          { wsId },
        );
      }
      this.logger.log(`KG 图谱已删除：documentId=${documentId}`);
    } finally {
      await session.close();
    }
  }

  async listNodes(workspaceId: string, type?: string, limit = 200): Promise<GraphNodeDto[]> {
    if (!this.driver) return [];
    const cap = Math.min(Math.max(limit, 1), 500);
    const session = this.driver.session();
    try {
      const result = await session.run(
        `
        MATCH (e:KnowledgeEntity {workspace_id: $workspaceId})
        WHERE $type IS NULL OR $type = '' OR e.type = $type
        RETURN e.name AS id, e.name AS name, e.type AS type, e.description AS description
        LIMIT $limit
        `,
        { workspaceId, type: type ?? null, limit: neo4j.int(cap) },
      );
      return result.records.map((record) => ({
        id: record.get('id') as string,
        name: record.get('name') as string,
        type: (record.get('type') as string) ?? null,
        description: (record.get('description') as string) ?? null,
      }));
    } catch (error) {
      this.logger.warn(`图谱节点查询失败：${error instanceof Error ? error.message : String(error)}`);
      return [];
    } finally {
      await session.close();
    }
  }

  async listEdges(workspaceId: string, limit = 500): Promise<GraphEdgeDto[]> {
    if (!this.driver) return [];
    const cap = Math.min(Math.max(limit, 1), 1000);
    const session = this.driver.session();
    try {
      const result = await session.run(
        `
        MATCH (a:KnowledgeEntity {workspace_id: $workspaceId})-[r:RELATED_TO]->(b:KnowledgeEntity {workspace_id: $workspaceId})
        RETURN a.name AS source, b.name AS target, r.relation AS relation, r.weight AS weight
        LIMIT $limit
        `,
        { workspaceId, limit: neo4j.int(cap) },
      );
      return result.records.map((record) => ({
        source: record.get('source') as string,
        target: record.get('target') as string,
        relation: (record.get('relation') as string) ?? 'RELATED_TO',
        weight: this.toNumber(record.get('weight'), 0.5),
      }));
    } catch (error) {
      this.logger.warn(`图谱边查询失败：${error instanceof Error ? error.message : String(error)}`);
      return [];
    } finally {
      await session.close();
    }
  }

  async searchGraph(workspaceId: string, keyword: string, limit = 50): Promise<GraphSearchHit[]> {
    if (!this.driver) return [];
    const kw = keyword.trim();
    if (!kw) return [];

    const cap = Math.min(Math.max(limit, 1), 200);
    const session = this.driver.session();
    try {
      const result = await session.run(
        `
        MATCH (n)
        WHERE n.workspace_id = $workspaceId
          AND (
            toLower(coalesce(n.name, '')) CONTAINS toLower($kw)
            OR toLower(coalesce(n.title, '')) CONTAINS toLower($kw)
            OR toLower(coalesce(n.heading, '')) CONTAINS toLower($kw)
            OR toLower(coalesce(n.description, '')) CONTAINS toLower($kw)
            OR toLower(coalesce(n.content, '')) CONTAINS toLower($kw)
          )
        RETURN labels(n)[0] AS label,
               coalesce(n.name, n.title, n.heading, n.id, n.chunkId) AS name,
               coalesce(n.id, n.chunkId, n.name) AS id,
               n.type AS type,
               n.title AS title,
               n.description AS description,
               n.heading AS heading,
               n.documentId AS documentId,
               CASE
                 WHEN n.content IS NULL THEN null
                 ELSE substring(n.content, 0, 160)
               END AS snippet
        ORDER BY label, name
        LIMIT $limit
        `,
        { workspaceId, kw, limit: neo4j.int(cap) },
      );
      return result.records.map((record) => ({
        id: record.get('id') as string,
        name: record.get('name') as string,
        label: (record.get('label') as string) ?? null,
        type: (record.get('type') as string) ?? null,
        title: (record.get('title') as string) ?? null,
        description: (record.get('description') as string) ?? null,
        heading: (record.get('heading') as string) ?? null,
        documentId: (record.get('documentId') as string) ?? null,
        snippet: (record.get('snippet') as string) ?? null,
      }));
    } catch (error) {
      this.logger.warn(`图谱检索失败：${error instanceof Error ? error.message : String(error)}`);
      return [];
    } finally {
      await session.close();
    }
  }

  /**
   * 把问题里的实体名对齐到图谱节点：精确名 / 别名 / 互相包含。
   * 返回去重后的实体名（当前 MERGE 键就是 name + workspace_id）。
   */
  async resolveEntityNames(names: string[], workspaceIds: string[]): Promise<string[]> {
    if (!this.driver || names.length === 0 || workspaceIds.length === 0) return [];
    const queries = [...new Set(names.map((n) => n.trim()).filter(Boolean))].slice(0, 12);
    if (queries.length === 0) return [];

    const session = this.driver.session();
    try {
      const result = await session.run(
        `
        UNWIND $queries AS q
        MATCH (e:KnowledgeEntity)
        WHERE e.workspace_id IN $wsIds
          AND (
            toLower(e.name) = toLower(q)
            OR any(a IN coalesce(e.aliases, []) WHERE toLower(toString(a)) = toLower(q))
            OR toLower(e.name) CONTAINS toLower(q)
            OR toLower(q) CONTAINS toLower(e.name)
          )
        WITH q, e,
          CASE
            WHEN toLower(e.name) = toLower(q) THEN 0
            WHEN any(a IN coalesce(e.aliases, []) WHERE toLower(toString(a)) = toLower(q)) THEN 1
            ELSE 2
          END AS rank
        ORDER BY q, rank, e.name
        WITH q, collect(e.name)[0] AS name
        WHERE name IS NOT NULL
        RETURN collect(DISTINCT name) AS names
        `,
        { queries, wsIds: workspaceIds },
      );
      return (result.records[0]?.get('names') as string[] | undefined) ?? [];
    } catch (error) {
      this.logger.warn(`实体对齐失败：${error instanceof Error ? error.message : String(error)}`);
      return [];
    } finally {
      await session.close();
    }
  }

  /** 检索命中分片提及的实体，作为问题未点名实体时的多跳起点 */
  async entityNamesByChunkIds(chunkIds: string[], workspaceIds: string[], limit = 3): Promise<string[]> {
    if (!this.driver || chunkIds.length === 0 || workspaceIds.length === 0) return [];
    const cap = Math.min(Math.max(limit, 1), 8);
    const session = this.driver.session();
    try {
      const result = await session.run(
        `
        MATCH (c:DocumentChunk)-[:MENTIONS]->(e:KnowledgeEntity)
        WHERE c.chunkId IN $chunkIds AND e.workspace_id IN $wsIds
        RETURN e.name AS name, count(*) AS mentions
        ORDER BY mentions DESC, e.name
        LIMIT $limit
        `,
        { chunkIds, wsIds: workspaceIds, limit: neo4j.int(cap) },
      );
      return result.records.map((r) => r.get('name') as string).filter(Boolean);
    } catch (error) {
      this.logger.warn(`分片反查实体失败：${error instanceof Error ? error.message : String(error)}`);
      return [];
    } finally {
      await session.close();
    }
  }

  /**
   * 从种子实体沿 RELATED_TO 无向扩展 1..maxHops 跳。
   * hops 经钳制后写入 Cypher，relation 属性走白名单参数，避免注入。
   */
  async multiHop(
    seedNames: string[],
    maxHops: number,
    workspaceIds: string[],
    relationTypes?: string[],
  ): Promise<{ triples: [string, string, string][] }> {
    const empty = { triples: [] as [string, string, string][] };
    if (!this.driver || seedNames.length === 0 || workspaceIds.length === 0) return empty;
    const hops = Math.min(Math.max(maxHops, 1), 3);
    const relFilter =
      relationTypes && relationTypes.length > 0
        ? relationTypes.filter((r) => RELATION_TYPE_SET.has(r))
        : [...GRAPH_RELATION_TYPES];
    if (relFilter.length === 0) return empty;

    const session = this.driver.session();
    try {
      const result = await session.run(
        `
        MATCH (n:KnowledgeEntity)
        WHERE n.name IN $names AND n.workspace_id IN $wsIds
        MATCH path = (n)-[:RELATED_TO*1..${hops}]-(m:KnowledgeEntity)
        WHERE all(x IN nodes(path) WHERE x.workspace_id IN $wsIds)
          AND all(r IN relationships(path) WHERE r.relation IN $relTypes)
        UNWIND relationships(path) AS rel
        WITH startNode(rel) AS s, endNode(rel) AS t, rel.relation AS relType
        RETURN DISTINCT s.name AS source, relType AS relation, t.name AS target
        LIMIT 60
        `,
        { names: seedNames, wsIds: workspaceIds, relTypes: relFilter },
      );
      const triples: [string, string, string][] = [];
      const seen = new Set<string>();
      for (const record of result.records) {
        const source = record.get('source') as string;
        const relation = (record.get('relation') as string) ?? 'RELATED_TO';
        const target = record.get('target') as string;
        const key = `${source}|${relation}|${target}`;
        if (!source || !target || seen.has(key)) continue;
        seen.add(key);
        triples.push([source, relation, target]);
      }
      return { triples };
    } catch (error) {
      this.logger.warn(`多跳推理失败：${error instanceof Error ? error.message : String(error)}`);
      return empty;
    } finally {
      await session.close();
    }
  }

  /** 图增强检索：实体反查 MENTIONS 分片 id */
  async chunkIdsByEntityNames(names: string[], workspaceIds: string[], limit = 8): Promise<string[]> {
    if (!this.driver || names.length === 0 || workspaceIds.length === 0) return [];
    const cap = Math.min(Math.max(limit, 1), 20);
    const session = this.driver.session();
    try {
      const result = await session.run(
        `
        MATCH (c:DocumentChunk)-[:MENTIONS]->(e:KnowledgeEntity)
        WHERE e.name IN $names AND e.workspace_id IN $wsIds AND c.workspace_id IN $wsIds
        RETURN DISTINCT c.chunkId AS chunkId
        LIMIT $limit
        `,
        { names, wsIds: workspaceIds, limit: neo4j.int(cap) },
      );
      return result.records.map((r) => r.get('chunkId') as string).filter(Boolean);
    } catch (error) {
      this.logger.warn(`实体反查分片失败：${error instanceof Error ? error.message : String(error)}`);
      return [];
    } finally {
      await session.close();
    }
  }

  private toNumber(value: unknown, fallback: number): number {
    if (typeof value === 'number' && Number.isFinite(value)) return value;
    if (neo4j.isInt(value)) return value.toNumber();
    return fallback;
  }

  private async writeExtraction(
    session: Session,
    workspaceId: string,
    chunk: GraphChunkExtraction,
  ): Promise<number> {
    const now = new Date().toISOString();
    const entities = chunk.entities
      .map((e) => ({
        name: e.name.trim(),
        type: e.type,
        description: e.description ?? '',
        aliases: e.aliases ?? [],
      }))
      .filter((e) => e.name);
    if (entities.length > 0) {
      await session.run(
        `
        MATCH (c:DocumentChunk {chunkId: $chunkId})
        UNWIND $entities AS e
        MERGE (n:KnowledgeEntity {name: e.name, workspace_id: $workspaceId})
        ON CREATE SET n.type = e.type, n.description = e.description,
                      n.aliases = e.aliases, n.createdAt = $now, n.updatedAt = $now
        ON MATCH SET n.type = coalesce(e.type, n.type),
                     n.description = CASE WHEN e.description <> '' THEN e.description ELSE n.description END,
                     n.updatedAt = $now
        MERGE (c)-[:MENTIONS]->(n)
        `,
        { chunkId: chunk.chunkId, workspaceId, entities, now },
      );
    }

    const relations = chunk.relations
      .map((r) => ({
        source: r.source.trim(),
        target: r.target.trim(),
        relation: r.relation,
        weight: typeof r.weight === 'number' ? r.weight : 0.5,
      }))
      .filter((r) => r.source && r.target);
    if (relations.length > 0) {
      await session.run(
        `
        UNWIND $relations AS r
        MATCH (a:KnowledgeEntity {name: r.source, workspace_id: $workspaceId})
        MATCH (b:KnowledgeEntity {name: r.target, workspace_id: $workspaceId})
        MERGE (a)-[rel:RELATED_TO]->(b)
        ON CREATE SET rel.relation = r.relation, rel.weight = r.weight, rel.createdAt = datetime()
        ON MATCH SET rel.weight = coalesce(r.weight, rel.weight),
                     rel.relation = coalesce(r.relation, rel.relation)
        `,
        { workspaceId, relations },
      );
    }

    return entities.length;
  }
}
