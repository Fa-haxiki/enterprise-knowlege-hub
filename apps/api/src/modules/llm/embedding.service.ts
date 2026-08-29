import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

/** Embedding 客户端：OpenAI 兼容 /embeddings 接口（bge-m3 等） */
@Injectable()
export class EmbeddingService {
  private readonly logger = new Logger(EmbeddingService.name);

  constructor(private readonly config: ConfigService) {}

  async embed(texts: string[]): Promise<number[][]> {
    const baseURL = this.config.get<string>('embedding.baseURL');
    const model = this.config.get<string>('embedding.model');
    const apiKey = this.config.get<string>('embedding.apiKey');

    const res = await fetch(`${baseURL}/embeddings`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({ model, input: texts }),
      signal: AbortSignal.timeout(30_000),
    });
    if (!res.ok) {
      const body = await res.text();
      this.logger.error(`embedding failed: ${res.status} ${body}`);
      throw new Error(`embedding service error: ${res.status}`);
    }
    const json = (await res.json()) as { data: { embedding: number[] }[] };
    return json.data.map((d) => d.embedding);
  }

  async embedOne(text: string): Promise<number[]> {
    const [vec] = await this.embed([text]);
    return vec;
  }
}
