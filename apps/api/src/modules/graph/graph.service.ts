import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import neo4j, { Driver } from 'neo4j-driver';
import type { Triple } from '@ekh/shared';

export interface ExtractedEntity {
  name: string;
  type: 'Project' | 'Supplier' | 'Person' | 'Policy' | 'Department';
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

  /** 实体对齐：名称模糊匹配到已有节点，返回图内实体名 */
  async alignEntities(entities: ExtractedEntity[]): Promise<ExtractedEntity[]> {
    const session = this.driver.session();
    try {
      const aligned: ExtractedEntity[] = [];
      for (const e of entities) {
        const res = await session.run(
          `MATCH (n:${e.type})
           WHERE n.name = $name
              OR apoc.text.levenshteinSimilarity(n.name, $name) >= 0.8
           RETURN n.name AS name ORDER BY apoc.text.levenshteinSimilarity(n.name, $name) DESC LIMIT 1`,
          { name: e.name },
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
   * 全部参数化，禁止字符串拼接查询值。
   */
  async multiHop(entities: ExtractedEntity[], maxHops: number): Promise<Triple[]> {
    if (entities.length === 0) return [];
    const session = this.driver.session();
    try {
      const hops = Math.min(Math.max(maxHops, 1), 3);
      const res = await session.run(
        `MATCH path = (n)-[*1..${hops}]-(m)
         WHERE n.name IN $names
         UNWIND relationships(path) AS rel
         WITH DISTINCT startNode(rel) AS s, rel, endNode(rel) AS t
         WHERE type(rel) <> 'MENTIONS'
         // 按输出三元组去重：同名不同标签节点、反向重复关系都会被合并
         RETURN DISTINCT coalesce(s.name, s.chunk_id) AS source, type(rel) AS relation,
                coalesce(t.name, t.chunk_id) AS target
         LIMIT 30`,
        { names: entities.map((e) => e.name) },
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

  /** 建图写入：MERGE 实体 + 关系 + Chunk MENTIONS 关联（Worker 调用） */
  async upsertGraph(payload: {
    chunkId: string;
    documentId: string;
    workspaceId: string;
    entities: ExtractedEntity[];
    relations: { source: string; sourceType: string; target: string; targetType: string; relation: string; confidence: number }[];
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
        entitiesByType.set(e.type, [...(entitiesByType.get(e.type) ?? []), e.name]);
      }
      for (const [type, names] of entitiesByType) {
        await session.run(
          `MATCH (c:Chunk {chunk_id: $chunkId})
           UNWIND $names AS name
           MERGE (n:${type} {name: name})
           MERGE (c)-[:MENTIONS]->(n)`,
          { chunkId: payload.chunkId, names },
        );
      }
      // 关系按「源类型|目标类型|关系类型」分组批量 MERGE；低置信关系进待审核（P2），不入图
      const relGroups = new Map<string, { source: string; target: string; confidence: number }[]>();
      for (const r of payload.relations) {
        if (r.confidence < 0.7) continue;
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
           MERGE (s:${sourceType} {name: row.source})
           MERGE (t:${targetType} {name: row.target})
           MERGE (s)-[rel:${relation}]->(t)
           SET rel.source_chunk_id = $chunkId, rel.confidence = row.confidence, rel.extracted_at = datetime()`,
          { rows, chunkId: payload.chunkId },
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
