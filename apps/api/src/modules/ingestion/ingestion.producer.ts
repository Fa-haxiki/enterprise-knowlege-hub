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

  async enqueue(data: IngestionJobData) {
    await this.queue.add('ingest', data, {
      attempts: 3,
      backoff: { type: 'exponential', delay: 10_000 },
      removeOnComplete: 100,
      removeOnFail: 500,
    });
  }
}
