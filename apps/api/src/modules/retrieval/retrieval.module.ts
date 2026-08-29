import { Module } from '@nestjs/common';
import { EsService } from './es.service';
import { RetrievalService } from './retrieval.service';

@Module({
  providers: [EsService, RetrievalService],
  exports: [EsService, RetrievalService],
})
export class RetrievalModule {}
