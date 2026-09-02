import { Module } from '@nestjs/common';
import { EsService } from './es.service';
import { RetrievalService } from './retrieval.service';

/**
 * 纯服务模块（worker 也引用）：不要在此挂控制器，
 * 控制器依赖 @nestjs/swagger / AuthModule，worker 打包会缺模块——见 SearchModule 注释。
 */
@Module({
  providers: [EsService, RetrievalService],
  exports: [EsService, RetrievalService],
})
export class RetrievalModule {}
