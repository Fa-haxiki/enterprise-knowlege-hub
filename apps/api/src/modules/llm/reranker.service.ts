import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

export interface RerankInput {
  query: string;
  documents: string[];
  topN: number;
}

export interface RerankResult {
  index: number;
  score: number;
}

/** Reranker 客户端：bge-reranker 兼容 HTTP 接口 */
@Injectable()
export class RerankerService {
  private readonly logger = new Logger(RerankerService.name);

  constructor(private readonly config: ConfigService) {}

  async rerank(input: RerankInput): Promise<RerankResult[]> {
    const url = this.config.get<string>('reranker.url');
    const model = this.config.get<string>('reranker.model');

    const res = await fetch(url as string, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model,
        query: input.query,
        documents: input.documents,
        top_n: input.topN,
      }),
      signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) {
      const body = await res.text();
      this.logger.error(`reranker failed: ${res.status} ${body}`);
      throw new Error(`reranker service error: ${res.status}`);
    }
    const json = (await res.json()) as {
      results: { index: number; relevance_score: number }[];
    };
    return json.results.map((r) => ({ index: r.index, score: r.relevance_score }));
  }
}
