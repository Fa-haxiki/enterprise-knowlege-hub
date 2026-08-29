import { Module } from '@nestjs/common';
import { HealthController } from './health.controller';
import { RetrievalModule } from '../retrieval/retrieval.module';

@Module({
  imports: [RetrievalModule],
  controllers: [HealthController],
})
export class HealthModule {}
