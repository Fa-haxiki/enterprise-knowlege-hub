import { Body, Controller, Get, Param, Patch, UseGuards } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { IsBoolean } from 'class-validator';
import { ErrorCode } from '@ekh/shared';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { AdminGuard } from '../../common/guards/admin.guard';
import { CurrentUser, type AuthUser } from '../../common/decorators/current-user.decorator';
import { BizException } from '../../common/filters/http-exception.filter';
import { AuditService } from '../audit/audit.service';
import { FEATURE_FLAGS, FeatureFlagsService, type FeatureFlag } from './feature-flags.service';

class ToggleFeatureDto {
  @IsBoolean()
  enabled: boolean;
}

@ApiTags('features')
@UseGuards(JwtAuthGuard)
@Controller({ version: '1' })
export class FeaturesController {
  constructor(
    private readonly features: FeatureFlagsService,
    private readonly audit: AuditService,
  ) {}

  /** 登录用户可读：前端按开关显示导航 / 面板 */
  @Get('features')
  all() {
    return this.features.all();
  }

  /** 管理员一键下架 / 上架 */
  @UseGuards(AdminGuard)
  @Patch('admin/features/:flag')
  async toggle(@CurrentUser() user: AuthUser, @Param('flag') flag: string, @Body() dto: ToggleFeatureDto) {
    if (!(FEATURE_FLAGS as readonly string[]).includes(flag)) {
      throw new BizException(ErrorCode.PARAM_INVALID, `未知功能开关: ${flag}`, 400);
    }
    await this.features.set(flag as FeatureFlag, dto.enabled);
    this.audit.record({
      userId: user.userId,
      action: 'feature_toggle',
      resourceType: 'feature',
      resourceId: flag,
      detail: { enabled: dto.enabled },
    });
    return this.features.all();
  }
}
