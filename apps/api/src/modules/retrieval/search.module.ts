import { Module } from '@nestjs/common';
import { SearchController } from './search.controller';
import { RetrievalModule } from './retrieval.module';
import { WorkspacesModule } from '../workspaces/workspaces.module';
import { AuthModule } from '../auth/auth.module';

/**
 * 搜索入口单独成模块：RetrievalModule 被 worker 引用（拿 EsService），
 * 控制器（含 @nestjs/swagger 依赖）不能挂在其上，否则 worker 打包后缺 swagger 模块无法启动。
 */
@Module({
  // AuthModule 导出 JwtService，是 JwtAuthGuard 的依赖
  imports: [RetrievalModule, WorkspacesModule, AuthModule],
  controllers: [SearchController],
})
export class SearchModule {}
