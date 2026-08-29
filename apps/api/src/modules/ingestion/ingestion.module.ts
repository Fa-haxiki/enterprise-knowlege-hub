import { BullModule } from '@nestjs/bullmq';
import { Module } from '@nestjs/common';
import { IngestionProducer, INGESTION_QUEUE } from './ingestion.producer';

@Module({
  imports: [BullModule.registerQueue({ name: INGESTION_QUEUE })],
  providers: [IngestionProducer],
  exports: [IngestionProducer],
})
export class IngestionModule {}
