import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

/** 百炼同步 embeddings 单批上限（qwen3.7-text-embedding 为 20 条） */
const SYNC_BATCH_LIMIT = 20;

export interface BatchInfo {
  id: string;
  status: string;
  outputFileId?: string;
  error?: string;
}

/**
 * Embedding 客户端：阿里云百炼 qwen3.7-text-embedding。
 * - 同步接口（OpenAI 兼容 /embeddings）：查询侧实时调用
 * - Batch API（/files + /batches，半价）：入库侧离线批量调用
 */
@Injectable()
export class EmbeddingService {
  private readonly logger = new Logger(EmbeddingService.name);

  constructor(private readonly config: ConfigService) {}

  private get baseURL() {
    return this.config.get<string>('embedding.baseURL')!.replace(/\/$/, '');
  }

  private get model() {
    return this.config.get<string>('embedding.model')!;
  }

  private get apiKey() {
    return this.config.get<string>('embedding.apiKey')!;
  }

  private get dim() {
    return this.config.get<number>('embedding.dim') ?? 1024;
  }

  /** 同步批量 embed：超上限自动分批串行合并；校验返回维度 */
  async embed(texts: string[]): Promise<number[][]> {
    if (texts.length === 0) return [];
    const out: number[][] = [];
    for (let i = 0; i < texts.length; i += SYNC_BATCH_LIMIT) {
      const batch = texts.slice(i, i + SYNC_BATCH_LIMIT);
      out.push(...(await this.embedOnce(batch)));
    }
    return out;
  }

  async embedOne(text: string): Promise<number[]> {
    const [vec] = await this.embed([text]);
    return vec;
  }

  private async embedOnce(texts: string[]): Promise<number[][]> {
    const res = await fetch(`${this.baseURL}/embeddings`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${this.apiKey}`,
      },
      body: JSON.stringify({ model: this.model, input: texts, dimensions: this.dim }),
      signal: AbortSignal.timeout(30_000),
    });
    if (!res.ok) {
      const body = await res.text();
      this.logger.error(`embedding failed: ${res.status} ${body}`);
      throw new Error(`embedding service error: ${res.status}`);
    }
    const json = (await res.json()) as { data: { index: number; embedding: number[] }[] };
    // OpenAI 兼容响应不保证顺序，按 index 归位
    const vectors = json.data
      .sort((a, b) => a.index - b.index)
      .map((d) => {
        if (d.embedding.length !== this.dim) {
          throw new Error(`embedding dim mismatch: expect ${this.dim}, got ${d.embedding.length}`);
        }
        return d.embedding;
      });
    if (vectors.length !== texts.length) {
      throw new Error(`embedding count mismatch: expect ${texts.length}, got ${vectors.length}`);
    }
    return vectors;
  }

  // ---------- Batch API（入库侧，半价；异步） ----------

  /** 提交一批文本：上传 jsonl 并创建 batch，返回 batchId */
  async submitEmbedBatch(texts: string[]): Promise<string> {
    const jsonl = texts
      .map((text, i) =>
        JSON.stringify({
          custom_id: String(i),
          method: 'POST',
          url: '/v1/embeddings',
          body: { model: this.model, input: [text], dimensions: this.dim },
        }),
      )
      .join('\n');

    const form = new FormData();
    form.append('purpose', 'batch');
    form.append('file', new Blob([jsonl], { type: 'application/jsonl' }), 'embed-requests.jsonl');

    const uploadRes = await fetch(`${this.baseURL}/files`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${this.apiKey}` },
      body: form,
      signal: AbortSignal.timeout(60_000),
    });
    if (!uploadRes.ok) {
      const body = await uploadRes.text();
      this.logger.error(`batch file upload failed: ${uploadRes.status} ${body}`);
      throw new Error(`embedding batch upload error: ${uploadRes.status}`);
    }
    const file = (await uploadRes.json()) as { id: string };

    const batchRes = await fetch(`${this.baseURL}/batches`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${this.apiKey}`,
      },
      body: JSON.stringify({
        input_file_id: file.id,
        endpoint: '/v1/embeddings',
        completion_window: '24h',
      }),
      signal: AbortSignal.timeout(30_000),
    });
    if (!batchRes.ok) {
      const body = await batchRes.text();
      this.logger.error(`batch create failed: ${batchRes.status} ${body}`);
      throw new Error(`embedding batch create error: ${batchRes.status}`);
    }
    const batch = (await batchRes.json()) as { id: string };
    this.logger.log(`embedding batch submitted: ${batch.id} (${texts.length} texts)`);
    return batch.id;
  }

  /** 查询 batch 状态 */
  async getBatch(batchId: string): Promise<BatchInfo> {
    const res = await fetch(`${this.baseURL}/batches/${batchId}`, {
      headers: { Authorization: `Bearer ${this.apiKey}` },
      signal: AbortSignal.timeout(15_000),
    });
    if (!res.ok) {
      const body = await res.text();
      this.logger.error(`batch query failed: ${res.status} ${body}`);
      throw new Error(`embedding batch query error: ${res.status}`);
    }
    const json = (await res.json()) as {
      id: string;
      status: string;
      output_file_id?: string;
      errors?: { data?: { message?: string }[] };
    };
    return {
      id: json.id,
      status: json.status,
      outputFileId: json.output_file_id,
      error: json.errors?.data?.[0]?.message,
    };
  }

  /** 下载 batch 结果：按 custom_id（提交时的索引）归位返回向量数组 */
  async downloadBatchVectors(outputFileId: string, expectedCount: number): Promise<number[][]> {
    const res = await fetch(`${this.baseURL}/files/${outputFileId}/content`, {
      headers: { Authorization: `Bearer ${this.apiKey}` },
      signal: AbortSignal.timeout(60_000),
    });
    if (!res.ok) {
      const body = await res.text();
      this.logger.error(`batch result download failed: ${res.status} ${body}`);
      throw new Error(`embedding batch download error: ${res.status}`);
    }
    const text = await res.text();
    const vectors: number[][] = new Array(expectedCount);
    for (const line of text.split('\n')) {
      if (!line.trim()) continue;
      const row = JSON.parse(line) as {
        custom_id: string;
        response: { status_code: number; body: { data: { embedding: number[] }[] } };
        error?: { message?: string };
      };
      const idx = Number(row.custom_id);
      if (row.response?.status_code !== 200) {
        throw new Error(`batch item ${idx} failed: ${row.error?.message ?? row.response?.status_code}`);
      }
      const vec = row.response.body.data[0]?.embedding;
      if (!vec || vec.length !== this.dim) {
        throw new Error(`batch item ${idx} dim invalid`);
      }
      vectors[idx] = vec;
    }
    if (vectors.some((v) => v === undefined)) {
      throw new Error(`batch result incomplete: expect ${expectedCount} vectors`);
    }
    return vectors;
  }
}
