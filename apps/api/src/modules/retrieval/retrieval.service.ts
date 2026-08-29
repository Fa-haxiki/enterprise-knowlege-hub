import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';
import type { ChunkHit } from '@ekh/shared';
import { EmbeddingService } from '../llm/embedding.service';
import { RerankerService } from '../llm/reranker.service';
import { EsService } from './es.service';

export interface RetrieveResult {
  chunks: ChunkHit[];
  degraded: string[];
  latencies: Record<string, number>;
}

/**
 * 混合检索：ES BM25 + PGVector 余弦双路召回（ACL 前置过滤），
 * RRF 融合，Reranker 精排 Top-N，结果级 ACL 兜底过滤。
 */
@Injectable()
export class RetrievalService {
  private readonly logger = new Logger(RetrievalService.name);

  constructor(
    @InjectDataSource() private readonly dataSource: DataSource,
    private readonly es: EsService,
    private readonly embedding: EmbeddingService,
    private readonly reranker: RerankerService,
    private readonly config: ConfigService,
  ) {}

  async retrieve(query: string, aclWhitelist: string[]): Promise<RetrieveResult> {
    const topK = this.config.get<number>('rag.retrieveTopK') ?? 20;
    const degraded: string[] = [];
    const latencies: Record<string, number> = {};

    if (aclWhitelist.length === 0) {
      return { chunks: [], degraded: ['acl_empty'], latencies };
    }

    // ---- 双路召回（并行，单路故障降级） ----
    const t0 = Date.now();
    const [esResult, vectorResult] = await Promise.allSettled([
      this.es.search(query, aclWhitelist, topK),
      this.vectorSearch(query, aclWhitelist, topK),
    ]);
    latencies.recall = Date.now() - t0;

    const esHits: ChunkHit[] =
      esResult.status === 'fulfilled'
        ? esResult.value.map((h) => ({ ...h, content: '', page: undefined }))
        : (degraded.push('es'), []);
    const vectorHits: ChunkHit[] =
      vectorResult.status === 'fulfilled' ? vectorResult.value : (degraded.push('pgvector'), []);

    // ---- RRF 融合 ----
    const rrfK = this.config.get<number>('rag.rrfK') ?? 60;
    const fused = this.rrfFuse([esHits, vectorHits], rrfK).slice(0, topK);

    // 融合候选需要 content（ES 路未返回 content，从 PG 补齐）
    const withContent = await this.fillContent(fused);

    // ---- Reranker 精排 ----
    const topN = this.config.get<number>('rag.rerankTopN') ?? 6;
    const minScore = this.config.get<number>('rag.rerankMinScore') ?? 0.35;
    const t1 = Date.now();
    let reranked: ChunkHit[];
    try {
      reranked = await this.rerank(query, withContent, topN, minScore);
      latencies.rerank = Date.now() - t1;
    } catch (e) {
      this.logger.warn(`reranker degraded: ${(e as Error).message}`);
      degraded.push('reranker');
      reranked = withContent.slice(0, topN);
    }

    // ---- 结果级 ACL 兜底过滤 ----
    const allowed = new Set(aclWhitelist);
    const filtered = reranked.filter((c) => allowed.has(c.workspace_id));
    const stripped = reranked.length - filtered.length;
    if (stripped > 0) {
      this.logger.warn(`acl_filter stripped ${stripped} chunks`);
    }

    return { chunks: filtered, degraded, latencies };
  }

  /** PGVector 余弦召回（ACL 前置过滤） */
  private async vectorSearch(query: string, workspaceIds: string[], topK: number): Promise<ChunkHit[]> {
    const vec = await this.embedding.embedOne(query);
    const vecLiteral = `[${vec.join(',')}]`;
    const rows = await this.dataSource.query(
      `
      SELECT c.id AS chunk_id, c.document_id, c.workspace_id, c.content,
             c.heading_path, c.refs, d.title,
             1 - (c.embedding <=> $1::vector) AS raw_score
      FROM document_chunks c
      JOIN documents d ON d.id = c.document_id
      WHERE c.workspace_id = ANY($2) AND c.embedding IS NOT NULL AND d.deleted_at IS NULL
      ORDER BY c.embedding <=> $1::vector
      LIMIT $3
      `,
      [vecLiteral, workspaceIds, topK],
    );
    return rows.map((r: Record<string, unknown>) => ({
      chunk_id: r.chunk_id as string,
      document_id: r.document_id as string,
      workspace_id: r.workspace_id as string,
      title: r.title as string,
      content: r.content as string,
      heading_path: (r.heading_path as string[]) ?? [],
      page: (r.refs as { page?: number })?.page,
      raw_score: Number(r.raw_score),
    }));
  }

  /** RRF 融合：score = Σ 1/(k + rank) */
  private rrfFuse(lists: ChunkHit[][], k: number): ChunkHit[] {
    const scores = new Map<string, { hit: ChunkHit; score: number }>();
    for (const list of lists) {
      list.forEach((hit, rank) => {
        const entry = scores.get(hit.chunk_id) ?? { hit, score: 0 };
        entry.score += 1 / (k + rank + 1);
        // 向量路带 content，优先保留
        if (!entry.hit.content && hit.content) entry.hit = hit;
        scores.set(hit.chunk_id, entry);
      });
    }
    return [...scores.values()]
      .sort((a, b) => b.score - a.score)
      .map((e) => ({ ...e.hit, rrf_score: e.score }));
  }

  /** 从 PG 补齐融合候选的 content（ES 路未返回正文） */
  private async fillContent(hits: ChunkHit[]): Promise<ChunkHit[]> {
    const missing = hits.filter((h) => !h.content).map((h) => h.chunk_id);
    if (missing.length === 0) return hits;

    const rows = await this.dataSource.query(
      `SELECT c.id, c.content, c.refs, d.title FROM document_chunks c
       JOIN documents d ON d.id = c.document_id WHERE c.id = ANY($1)`,
      [missing],
    );
    const map = new Map<string, { content: string; page?: number; title: string }>(
      rows.map((r: Record<string, unknown>) => [
        r.id as string,
        {
          content: r.content as string,
          page: (r.refs as { page?: number })?.page,
          title: r.title as string,
        },
      ]),
    );
    return hits.map((h) => {
      const fill = map.get(h.chunk_id);
      return fill ? { ...h, content: fill.content, page: fill.page, title: h.title || fill.title } : h;
    });
  }

  private async rerank(query: string, hits: ChunkHit[], topN: number, minScore: number): Promise<ChunkHit[]> {
    if (hits.length === 0) return [];
    const results = await this.reranker.rerank({
      query,
      documents: hits.map((h) => h.content.slice(0, 1500)),
      topN,
    });
    return results
      .filter((r) => r.score >= minScore)
      .map((r) => ({ ...hits[r.index], rerank_score: r.score }));
  }
}
