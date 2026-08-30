import { CanActivate, ExecutionContext, Injectable } from '@nestjs/common';
import type { Request } from 'express';
import { ErrorCode, SystemRole } from '@ekh/shared';
import { BizException } from '../filters/http-exception.filter';
import type { AuthUser } from '../decorators/current-user.decorator';

/** 系统管理员接口守卫：需在 JwtAuthGuard 之后使用 */
@Injectable()
export class AdminGuard implements CanActivate {
  canActivate(context: ExecutionContext): boolean {
    const req = context.switchToHttp().getRequest<Request & { user?: AuthUser }>();
    if (req.user?.role !== SystemRole.SYSADMIN) {
      throw new BizException(ErrorCode.ACL_FORBIDDEN, '需要系统管理员权限', 403);
    }
    return true;
  }
}
