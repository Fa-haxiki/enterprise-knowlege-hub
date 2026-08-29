import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { WorkspaceRole } from '@ekh/shared';
import { WorkspaceMemberEntity } from '../../database/entities/workspace-member.entity';
import { RedisService } from '../../redis/redis.service';

const whitelistKey = (userId: string) => `acl:whitelist:${userId}`;

/**
 * 权限白名单：Redis 缓存用户可见空间集合。
 * 命中失败回源 PG 并回填；授权变更时主动失效。
 */
@Injectable()
export class AclService {
  constructor(
    @InjectRepository(WorkspaceMemberEntity)
    private readonly members: Repository<WorkspaceMemberEntity>,
    private readonly redis: RedisService,
    private readonly config: ConfigService,
  ) {}

  /** 加载用户可见空间白名单（缓存优先） */
  async getWhitelist(userId: string): Promise<string[]> {
    const key = whitelistKey(userId);
    const cached = await this.redis.getSet(key);
    if (cached.length > 0) return cached;

    const rows = await this.members.find({ where: { userId } });
    const ids = rows.map((r) => r.workspaceId);
    await this.redis.refreshSet(key, ids, this.ttl());
    return ids;
  }

  /** 用户在空间内的角色；非成员返回 null */
  async getRole(userId: string, workspaceId: string): Promise<WorkspaceRole | null> {
    const row = await this.members.findOne({ where: { userId, workspaceId } });
    return row?.role ?? null;
  }

  /** 授权变更后主动失效单用户缓存 */
  async invalidate(userId: string): Promise<void> {
    await this.redis.raw.del(whitelistKey(userId));
  }

  /** 空间删除/批量变更时失效所有相关用户 */
  async invalidateMany(userIds: string[]): Promise<void> {
    if (userIds.length === 0) return;
    await this.redis.raw.del(...userIds.map(whitelistKey));
  }

  private ttl(): number {
    return this.config.get<number>('rag.aclCacheTtlSeconds') ?? 600;
  }
}
