import { Global, Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { FeatureFlagsService } from './feature-flags.service';
import { FeaturesController } from './features.controller';

/** 全局导出：chat / graph 等模块直接注入 FeatureFlagsService 做服务端强制 */
@Global()
@Module({
  imports: [AuthModule],
  controllers: [FeaturesController],
  providers: [FeatureFlagsService],
  exports: [FeatureFlagsService],
})
export class FeaturesModule {}
