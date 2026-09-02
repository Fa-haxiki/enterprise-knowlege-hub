import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import * as argon2 from 'argon2';
import { v4 as uuid } from 'uuid';
import { ErrorCode, SystemRole, UserStatus } from '@ekh/shared';
import { UserEntity } from '../../database/entities/user.entity';
import { DepartmentAdminEntity } from '../../database/entities/department-admin.entity';
import { RedisService } from '../../redis/redis.service';
import { AuditService } from '../audit/audit.service';
import { BizException } from '../../common/filters/http-exception.filter';
import type { AuthUser } from '../../common/decorators/current-user.decorator';

const MAX_LOGIN_FAILURES = 5;
const LOCK_SECONDS = 15 * 60;

@Injectable()
export class AuthService {
  private readonly logger = new Logger(AuthService.name);

  constructor(
    @InjectRepository(UserEntity)
    private readonly users: Repository<UserEntity>,
    @InjectRepository(DepartmentAdminEntity)
    private readonly deptAdmins: Repository<DepartmentAdminEntity>,
    private readonly jwt: JwtService,
    private readonly config: ConfigService,
    private readonly redis: RedisService,
    private readonly audit: AuditService,
  ) {}

  /** 注册申请制：创建 PENDING 账号，不签发 token，待 sysadmin 审核通过后方可登录 */
  async register(email: string, password: string, name: string) {
    const exists = await this.users.findOne({ where: { email } });
    if (exists) throw new BizException(ErrorCode.CONFLICT, '邮箱已注册', 409);

    const user = this.users.create({
      email,
      name,
      passwordHash: await argon2.hash(password),
      role: SystemRole.MEMBER,
      status: UserStatus.PENDING,
    });
    await this.users.save(user);
    this.audit.record({ userId: user.id, action: 'register', resourceType: 'user', resourceId: user.id });
    return { pending: true as const, message: '注册申请已提交，请等待管理员审核' };
  }

  async login(email: string, password: string, ip?: string) {
    const lockKey = `auth:lock:${email}`;
    const locked = await this.redis.raw.get(lockKey);
    if (locked) throw new BizException(ErrorCode.ACCOUNT_LOCKED, '账号已锁定，请 15 分钟后重试', 401);

    const user = await this.users.findOne({ where: { email } });
    // 审核状态优先于密码校验：避免泄露"账号存在但密码错误"的信息
    if (user && user.status === UserStatus.PENDING) {
      throw new BizException(ErrorCode.ACCOUNT_PENDING, '账号正在审核中，请耐心等待', 401);
    }
    if (user && user.status === UserStatus.REJECTED) {
      const note = user.reviewNote ? `：${user.reviewNote}` : '';
      throw new BizException(ErrorCode.ACCOUNT_REJECTED, `注册申请未通过${note}`, 401);
    }
    const valid = user && !user.disabledAt && (await argon2.verify(user.passwordHash, password));
    if (!valid) {
      const failKey = `auth:fail:${email}`;
      const fails = await this.redis.raw.incr(failKey);
      if (fails === 1) await this.redis.raw.expire(failKey, LOCK_SECONDS);
      if (fails >= MAX_LOGIN_FAILURES) {
        await this.redis.raw.set(lockKey, '1', 'EX', LOCK_SECONDS);
        await this.redis.raw.del(failKey);
      }
      this.audit.record({
        userId: user?.id ?? null,
        action: 'login_failed',
        resourceType: 'user',
        resourceId: user?.id,
        detail: { email, fails },
        ip,
      });
      throw new BizException(ErrorCode.CREDENTIAL_INVALID, '邮箱或密码错误', 401);
    }

    await this.redis.raw.del(`auth:fail:${email}`);
    this.logger.log(`user ${user.id} login from ${ip ?? 'unknown'}`);
    this.audit.record({ userId: user.id, action: 'login', resourceType: 'user', resourceId: user.id, ip });
    return this.issueTokens(user);
  }

  async refresh(refreshToken: string) {
    let payload: { sub: string; jti: string };
    try {
      payload = await this.jwt.verifyAsync(refreshToken, {
        secret: this.config.get<string>('jwt.secret'),
      });
    } catch {
      throw new BizException(ErrorCode.TOKEN_EXPIRED, 'Refresh Token 无效或已过期', 401);
    }

    const allowKey = this.refreshKey(payload.sub, payload.jti);
    const alive = await this.redis.raw.get(allowKey);
    if (!alive) throw new BizException(ErrorCode.TOKEN_INVALID, 'Refresh Token 已吊销', 401);

    const user = await this.users.findOne({ where: { id: payload.sub } });
    if (!user || user.disabledAt || user.status !== UserStatus.ACTIVE) {
      throw new BizException(ErrorCode.TOKEN_INVALID, '用户不存在或已禁用', 401);
    }

    // 滑动续期：旧 Refresh Token 吊销，签发新对
    await this.redis.raw.del(allowKey);
    return this.issueTokens(user);
  }

  /** 登出：吊销当前 Refresh Token；同时清 Guard 用户状态缓存。
   *  传 refreshToken 时按 jti 精确吊销；未传则退化为吊销该用户全部 Refresh（防残留）。 */
  async logout(userId: string, refreshToken?: string) {
    if (refreshToken) {
      try {
        const payload = await this.jwt.verifyAsync<{ sub: string; jti: string }>(refreshToken, {
          secret: this.config.get<string>('jwt.secret'),
        });
        if (payload.sub === userId) {
          await this.redis.raw.del(this.refreshKey(userId, payload.jti));
        }
      } catch {
        // refresh 已过期/无效：忽略，仍清状态缓存
      }
    } else {
      await this.revokeAll(userId);
    }
    await this.clearUserStateCache(userId);
    this.audit.record({ userId, action: 'logout', resourceType: 'user', resourceId: userId });
  }

  /** 吊销该用户全部 Refresh Token，并清 Guard 用户状态缓存（禁用/降权/登出全部设备时调用） */
  async revokeAll(userId: string) {
    const pattern = this.refreshKey(userId, '*');
    const keys = await this.redis.raw.keys(pattern);
    if (keys.length > 0) await this.redis.raw.del(...keys);
    await this.clearUserStateCache(userId);
  }

  /** 清 Guard 的用户状态短缓存，使禁用/降权立即生效（不等 30s TTL） */
  async clearUserStateCache(userId: string) {
    await this.redis.raw.del(`auth:user_state:${userId}`);
  }

  private async issueTokens(user: UserEntity) {
    const jti = uuid();
    const accessTtl = this.config.get<number>('jwt.accessTtlSeconds') ?? 7200;
    const refreshTtl = this.config.get<number>('jwt.refreshTtlSeconds') ?? 604800;

    const accessToken = await this.jwt.signAsync(
      { sub: user.id, email: user.email, role: user.role },
      { secret: this.config.get<string>('jwt.secret'), expiresIn: accessTtl },
    );
    const refreshToken = await this.jwt.signAsync(
      { sub: user.id, jti },
      { secret: this.config.get<string>('jwt.secret'), expiresIn: refreshTtl },
    );
    await this.redis.raw.set(this.refreshKey(user.id, jti), '1', 'EX', refreshTtl);

    const isDeptAdmin = await this.deptAdmins.exist({ where: { userId: user.id } });
    return {
      access_token: accessToken,
      refresh_token: refreshToken,
      expires_in: accessTtl,
      user: { id: user.id, email: user.email, name: user.name, role: user.role, is_dept_admin: isDeptAdmin },
    };
  }

  toAuthUser(user: UserEntity): AuthUser {
    return { userId: user.id, email: user.email, role: user.role };
  }

  private refreshKey(userId: string, jti: string) {
    return `auth:refresh:${userId}:${jti}`;
  }
}
