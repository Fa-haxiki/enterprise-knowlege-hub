import { InjectQueue } from '@nestjs/bullmq';
import { Injectable } from '@nestjs/common';
import type { Queue } from 'bullmq';

export const INGESTION_QUEUE = 'ingestion';

export interface IngestionJobData {
  documentId: string;
  /** 仅重建图谱等场景使用；默认全管线 */
  fromStage?: 'parse' | 'chunk' | 'index' | 'graph';
}

@Injectable()
export class IngestionProducer {
  constructor(@InjectQueue(INGESTION_QUEUE) private readonly queue: Queue) {}

  /**
   * 入队；返回是否真正入队（同文档已有在途任务时去重跳过）。
   * 同一文档只允许一个在途任务：jobId 去重，避免删除/重建/审核入队并发导致重复入库。
   * 注意：BullMQ 的 jobId 不允许包含冒号（Custom Id cannot contain :），用连字符。
   */
  async enqueue(data: IngestionJobData): Promise<{ queued: boolean; state?: string }> {
    const jobId = `ingest-${data.documentId}`;
    // removeOnComplete/removeOnFail 会保留最近的已结束任务，BullMQ 对同 jobId 的 add 会静默忽略（duplicated 事件）
    // → 重建/重跑前必须先把已结束的旧任务移走，否则入队无效、文档卡在处理中状态
    const existing = await this.queue.getJob(jobId);
    if (existing) {
      const state = await existing.getState();
      if (state === 'completed' || state === 'failed' || state === 'unknown') {
        await existing.remove().catch(() => undefined);
      } else {
        return { queued: false, state };
      }
    }
    await this.queue.add('ingest', data, {
      jobId,
      attempts: 3,
      backoff: { type: 'exponential', delay: 10_000 },
      removeOnComplete: 100,
      removeOnFail: 500,
    });
    return { queued: true };
  }

  /** 删除文档时取消该文档尚未开始的在途任务，防止 purge 后旧任务把索引写回 */
  async removePending(documentId: string) {
    const job = await this.queue.getJob(`ingest-${documentId}`);
    if (!job) return;
    const state = await job.getState();
    if (state === 'waiting' || state === 'delayed' || state === 'prioritized') {
      await job.remove().catch(() => undefined);
    }
  }
}
