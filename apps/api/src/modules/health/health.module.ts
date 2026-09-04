import { Module } from '@nestjs/common';
import { HealthController } from './health.controller';
import { RetrievalModule } from '../retrieval/retrieval.module';
import { GraphModule } from '../graph/graph.module';

@Module({
  imports: [RetrievalModule, GraphModule],
  controllers: [HealthController],
})
export class HealthModule {}
