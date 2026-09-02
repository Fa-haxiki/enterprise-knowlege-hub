import {
  CanActivate,
  ExecutionContext,
  Injectable,
  SetMetadata,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { ConfigService } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import type { Request } from 'express';
import { ErrorCode, SystemRole, UserStatus } from '@ekh/shared';
import { UserEntity } from '../../../database/entities/user.entity';
import { RedisService } from '../../../redis/redis.service';
import { BizException } from '../../../common/filters/http-exception.filter';
import type { AuthUser } from '../../../common/decorators/current-user.decorator';

export const IS_PUBLIC_KEY = 'isPublic';
export const Public = () => SetMetadata(IS_PUBLIC_KEY, true);

/** 用户状态缓存 TTL：禁用/降权后最长 30s 生效（revokeAll 会立即吊销 Refresh） */
const USER_STATE_TTL = 30;
const userStateKey = (userId: string) => `auth:user_state:${userId}`;

@Injectable()
export class JwtAuthGuard implements CanActivate {
  constructor(
    private readonly jwt: JwtService,
    private readonly config: ConfigService,
    private readonly reflector: Reflector,
    @InjectRepository(UserEntity)
    private readonly users: Repository<UserEntity>,
    private readonly redis: RedisService,
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

    let payload: { sub: string; email: string; role: SystemRole };
    try {
      payload = await this.jwt.verifyAsync(header.slice(7), {
        secret: this.config.get<string>('jwt.secret'),
      });
    } catch {
      throw new BizException(ErrorCode.TOKEN_EXPIRED, 'Token 无效或已过期', 401);
    }

    // 不信任 JWT 内嵌角色：回源用户状态，禁用/待审/已拒绝立即拒绝
    const state = await this.loadUserState(payload.sub);
    if (!state || state.disabledAt || state.status !== UserStatus.ACTIVE) {
      throw new BizException(ErrorCode.TOKEN_INVALID, '账号不可用或已被禁用', 401);
    }
    req.user = { userId: payload.sub, email: payload.email, role: state.role };
    return true;
  }

  /** 用户状态短缓存：避免每个请求都打 DB；禁用/改角色时由 AuthService 主动清除 */
  private async loadUserState(
    userId: string,
  ): Promise<Pick<UserEntity, 'role' | 'status' | 'disabledAt'> | null> {
    const key = userStateKey(userId);
    const cached = await this.redis.raw.get(key);
    if (cached) {
      try {
        return JSON.parse(cached) as Pick<UserEntity, 'role' | 'status' | 'disabledAt'>;
      } catch {
        // 缓存损坏则回源
      }
    }
    const user = await this.users.findOne({
      where: { id: userId },
      select: ['id', 'role', 'status', 'disabledAt'],
    });
    if (!user) return null;
    const state = { role: user.role, status: user.status, disabledAt: user.disabledAt };
    await this.redis.raw.set(key, JSON.stringify(state), 'EX', USER_STATE_TTL);
    return state;
  }
}
