import { Module } from '@nestjs/common';
import { EsService } from './es.service';
import { RetrievalService } from './retrieval.service';
import { SearchController } from './search.controller';
import { WorkspacesModule } from '../workspaces/workspaces.module';
import { AuthModule } from '../auth/auth.module';

@Module({
  // AuthModule 导出 JwtService，是 JwtAuthGuard 的依赖
  imports: [WorkspacesModule, AuthModule],
  controllers: [SearchController],
  providers: [EsService, RetrievalService],
  exports: [EsService, RetrievalService],
})
export class RetrievalModule {}
