import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { DocumentEntity } from '../../database/entities/document.entity';
import { AuthModule } from '../auth/auth.module';
import { WorkspacesModule } from '../workspaces/workspaces.module';
import { IngestionModule } from '../ingestion/ingestion.module';
import { GraphModule } from './graph.module';
import { GraphExplorerService } from './graph-explorer.service';
import { GraphAdminController, GraphController } from './graph.controller';

/**
 * 图谱 HTTP 层单独成模块：GraphModule 只含 Neo4j 客户端并被 Worker 复用，
 * 这里的守卫 / 队列 / 文档仓储依赖不应带进 Worker。
 */
@Module({
  imports: [TypeOrmModule.forFeature([DocumentEntity]), AuthModule, WorkspacesModule, IngestionModule, GraphModule],
  controllers: [GraphController, GraphAdminController],
  providers: [GraphExplorerService],
})
export class GraphApiModule {}
