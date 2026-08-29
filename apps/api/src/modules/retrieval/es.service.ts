import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Client } from '@elastic/elasticsearch';

/** Elasticsearch 客户端封装：索引初始化 + 关键词召回 + 写入 */
@Injectable()
export class EsService implements OnModuleInit {
  private readonly logger = new Logger(EsService.name);
  private client: Client;
  private index: string;

  constructor(private readonly config: ConfigService) {}

  async onModuleInit() {
    this.client = new Client({ node: this.config.get<string>('es.node') });
    this.index = this.config.get<string>('es.index') ?? 'kb_chunks';
    await this.ensureIndex();
  }

  get raw(): Client {
    return this.client;
  }

  get indexName(): string {
    return this.index;
  }

  private async ensureIndex() {
    try {
      const exists = await this.client.indices.exists({ index: this.index });
      if (exists) return;
      await this.client.indices.create({
        index: this.index,
        settings: { number_of_shards: 1, number_of_replicas: 0 },
        mappings: {
          properties: {
            chunk_id: { type: 'keyword' },
            document_id: { type: 'keyword' },
            workspace_id: { type: 'keyword' },
            // ES 8 不支持 mapping 级 boost；标题加权在查询时 title^2 实现
            title: { type: 'text', analyzer: 'standard' },
            content: { type: 'text', analyzer: 'standard' },
            heading_path: { type: 'keyword' },
            created_at: { type: 'date' },
          },
        },
      });
      this.logger.log(`ES index ${this.index} created`);
    } catch (e) {
      // ES 未就绪不阻断启动；检索时按降级处理
      this.logger.warn(`ES ensureIndex failed (will degrade): ${(e as Error).message}`);
    }
  }

  /** BM25 关键词召回，ACL 前置过滤 */
  async search(query: string, workspaceIds: string[], topK: number) {
    const res = await this.client.search({
      index: this.index,
      size: topK,
      query: {
        bool: {
          must: [
            {
              multi_match: {
                query,
                fields: ['title^2', 'content'],
                type: 'best_fields',
              },
            },
          ],
          filter: [{ terms: { workspace_id: workspaceIds } }],
        },
      },
      _source: ['chunk_id', 'document_id', 'workspace_id', 'title', 'heading_path'],
    });
    return res.hits.hits.map((h) => ({
      chunk_id: (h._source as Record<string, unknown>).chunk_id as string,
      document_id: (h._source as Record<string, unknown>).document_id as string,
      workspace_id: (h._source as Record<string, unknown>).workspace_id as string,
      title: (h._source as Record<string, unknown>).title as string,
      heading_path: ((h._source as Record<string, unknown>).heading_path as string[]) ?? [],
      raw_score: h._score ?? 0,
    }));
  }

  async indexChunk(doc: {
    chunk_id: string;
    document_id: string;
    workspace_id: string;
    title: string;
    content: string;
    heading_path: string[];
  }) {
    await this.client.index({
      index: this.index,
      id: doc.chunk_id,
      document: { ...doc, created_at: new Date().toISOString() },
      refresh: false,
    });
  }

  async deleteByDocument(documentId: string) {
    await this.client
      .deleteByQuery({
        index: this.index,
        query: { term: { document_id: documentId } },
        refresh: true,
      })
      .catch((e) => this.logger.warn(`ES deleteByQuery failed: ${(e as Error).message}`));
  }

  async ping(): Promise<boolean> {
    try {
      await this.client.cluster.health({ timeout: '3s' });
      return true;
    } catch {
      return false;
    }
  }
}
