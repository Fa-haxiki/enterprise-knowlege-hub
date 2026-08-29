import {
  CanActivate,
  ExecutionContext,
  Injectable,
  SetMetadata,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { ConfigService } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';
import type { Request } from 'express';
import { ErrorCode, SystemRole } from '@ekh/shared';
import { BizException } from '../../../common/filters/http-exception.filter';
import type { AuthUser } from '../../../common/decorators/current-user.decorator';

export const IS_PUBLIC_KEY = 'isPublic';
export const Public = () => SetMetadata(IS_PUBLIC_KEY, true);

@Injectable()
export class JwtAuthGuard implements CanActivate {
  constructor(
    private readonly jwt: JwtService,
    private readonly config: ConfigService,
    private readonly reflector: Reflector,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const isPublic = this.reflector.getAllAndOverride<boolean>(IS_PUBLIC_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (isPublic) return true;

    const req = context.switchToHttp().getRequest<Request & { user?: AuthUser }>();
    const header = req.headers.authorization;
    if (!header?.startsWith('Bearer ')) {
      throw new BizException(ErrorCode.TOKEN_INVALID, '缺少认证令牌', 401);
    }

    try {
      const payload = await this.jwt.verifyAsync<{
        sub: string;
        email: string;
        role: SystemRole;
      }>(header.slice(7), { secret: this.config.get<string>('jwt.secret') });
      req.user = { userId: payload.sub, email: payload.email, role: payload.role };
      return true;
    } catch {
      throw new BizException(ErrorCode.TOKEN_EXPIRED, 'Token 无效或已过期', 401);
    }
  }
}
