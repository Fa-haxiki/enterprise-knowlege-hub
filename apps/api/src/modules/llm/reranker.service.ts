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

/**
 * Reranker 客户端：阿里云百炼 qwen3-rerank。
 * 端点为 compatible-api/v1/reranks（与 embedding 的 compatible-mode 路径不同），
 * 扁平请求体；响应兼容 Cohere 风格 {results:[...]} 与 DashScope 风格 {output:{results:[...]}}。
 */
@Injectable()
export class RerankerService {
  private readonly logger = new Logger(RerankerService.name);

  constructor(private readonly config: ConfigService) {}

  async rerank(input: RerankInput): Promise<RerankResult[]> {
    const url = this.config.get<string>('reranker.url');
    const model = this.config.get<string>('reranker.model');
    const apiKey = this.config.get<string>('reranker.apiKey');

    const res = await fetch(url as string, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(apiKey ? { Authorization: `Bearer ${apiKey}` } : {}),
      },
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
      results?: { index: number; relevance_score: number }[];
      output?: { results?: { index: number; relevance_score: number }[] };
    };
    const results = json.results ?? json.output?.results;
    if (!results) {
      this.logger.error(`reranker unexpected response: ${JSON.stringify(json).slice(0, 300)}`);
      throw new Error('reranker response malformed');
    }
    return results.map((r) => ({ index: r.index, score: r.relevance_score }));
  }
}
