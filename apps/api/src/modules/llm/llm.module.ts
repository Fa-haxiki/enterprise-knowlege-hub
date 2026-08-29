import { Global, Module } from '@nestjs/common';
import { LlmService } from './llm.service';
import { EmbeddingService } from './embedding.service';
import { RerankerService } from './reranker.service';

@Global()
@Module({
  providers: [LlmService, EmbeddingService, RerankerService],
  exports: [LlmService, EmbeddingService, RerankerService],
})
export class LlmModule {}
