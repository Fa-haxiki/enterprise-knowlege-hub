import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { WorkspacesModule } from '../workspaces/workspaces.module';
import { GraphController } from './graph.controller';
import { GraphModule } from './graph.module';

/**
 * 图谱查询入口单独成模块：GraphModule 被 worker 引用（拿 GraphService），
 * 控制器（含 @nestjs/swagger）不能挂在其上。
 */
@Module({
  imports: [GraphModule, WorkspacesModule, AuthModule],
  controllers: [GraphController],
})
export class GraphQueryModule {}
