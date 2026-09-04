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

  private async hasIkPlugin(): Promise<boolean> {
    try {
      const plugins = (await this.client.cat.plugins({ format: 'json' })) as Array<{
        component?: string;
      }>;
      return plugins.some((p) => p.component === 'analysis-ik');
    } catch {
      return false;
    }
  }

  private async currentAnalyzer(field: string): Promise<string | null> {
    try {
      const mapping = await this.client.indices.getMapping({ index: this.index });
      const props = (mapping[this.index] as { mappings?: { properties?: Record<string, { analyzer?: string }> } })
        ?.mappings?.properties;
      return props?.[field]?.analyzer ?? null;
    } catch {
      return null;
    }
  }

  private async ensureIndex() {
    try {
      const useIk = await this.hasIkPlugin();
      if (!useIk) {
        this.logger.warn('未检测到 analysis-ik 插件，索引仍用 standard（中文按字切）');
      }

      const exists = await this.client.indices.exists({ index: this.index });
      if (exists) {
        const analyzer = await this.currentAnalyzer('content');
        const want = useIk ? 'ik_max_word' : 'standard';
        if (analyzer === want) return;
        if (this.config.get<string>('app.nodeEnv') === 'production') {
          this.logger.warn(`ES 索引分析器为 ${analyzer}，期望 ${want}；生产环境不自动重建，请手动删索引后回填`);
          return;
        }
        await this.client.indices.delete({ index: this.index });
        this.logger.warn(`已删除旧索引 ${this.index}（${analyzer} → ${want}），启动后需回填分片`);
      }

      await this.client.indices.create({
        index: this.index,
        settings: { number_of_shards: 1, number_of_replicas: 0 },
        mappings: {
          properties: {
            chunk_id: { type: 'keyword' },
            document_id: { type: 'keyword' },
            workspace_id: { type: 'keyword' },
            doc_type: { type: 'keyword' },
            // 索引细切、查询粗切；标题加权在查询时 title^2（ES 8 不支持 mapping boost）
            title: {
              type: 'text',
              analyzer: useIk ? 'ik_max_word' : 'standard',
              search_analyzer: useIk ? 'ik_smart' : 'standard',
            },
            content: {
              type: 'text',
              analyzer: useIk ? 'ik_max_word' : 'standard',
              search_analyzer: useIk ? 'ik_smart' : 'standard',
            },
            heading_path: { type: 'keyword' },
            created_at: { type: 'date' },
          },
        },
      });
      this.logger.log(`ES index ${this.index} created (analyzer=${useIk ? 'ik_max_word/ik_smart' : 'standard'})`);
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

  /** 关键词搜索（带高亮片段）：供文档搜索页使用，ACL 前置过滤；支持类型/入库时间筛选 */
  async searchWithHighlight(
    query: string,
    workspaceIds: string[],
    topK: number,
    filters?: { docTypes?: string[]; dateFrom?: string; dateTo?: string },
  ) {
    const filter: Record<string, unknown>[] = [{ terms: { workspace_id: workspaceIds } }];
    if (filters?.docTypes?.length) filter.push({ terms: { doc_type: filters.docTypes } });
    if (filters?.dateFrom || filters?.dateTo) {
      const range: Record<string, string> = {};
      if (filters.dateFrom) range.gte = filters.dateFrom;
      if (filters.dateTo) range.lte = filters.dateTo;
      filter.push({ range: { created_at: range } });
    }
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
          filter,
        },
      },
      _source: ['chunk_id', 'document_id', 'workspace_id', 'title', 'heading_path'],
      highlight: {
        pre_tags: ['<em>'],
        post_tags: ['</em>'],
        fields: {
          content: { fragment_size: 160, number_of_fragments: 2 },
          title: {},
        },
      },
    });
    return res.hits.hits.map((h) => {
      const src = h._source as Record<string, unknown>;
      return {
        chunk_id: src.chunk_id as string,
        document_id: src.document_id as string,
        workspace_id: src.workspace_id as string,
        title: src.title as string,
        heading_path: (src.heading_path as string[]) ?? [],
        score: h._score ?? 0,
        title_highlights: h.highlight?.title ?? [],
        highlights: h.highlight?.content ?? [],
      };
    });
  }

  async indexChunk(doc: {
    chunk_id: string;
    document_id: string;
    workspace_id: string;
    doc_type: string;
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
