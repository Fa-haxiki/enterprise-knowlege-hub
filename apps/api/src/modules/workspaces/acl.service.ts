import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { WorkspaceRole } from '@ekh/shared';
import { WorkspaceMemberEntity } from '../../database/entities/workspace-member.entity';
import { DepartmentAdminEntity } from '../../database/entities/department-admin.entity';
import { DepartmentMemberEntity } from '../../database/entities/department-member.entity';
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
    @InjectRepository(DepartmentAdminEntity)
    private readonly deptAdmins: Repository<DepartmentAdminEntity>,
    @InjectRepository(DepartmentMemberEntity)
    private readonly deptMembers: Repository<DepartmentMemberEntity>,
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

  /** 用户是否为指定部门的管理员 */
  async isDepartmentAdmin(userId: string, departmentId: string): Promise<boolean> {
    return this.deptAdmins.exist({ where: { userId, departmentId } });
  }

  /** 用户作为部门管理员的部门 id 列表 */
  async adminDepartmentIds(userId: string): Promise<string[]> {
    const rows = await this.deptAdmins.find({ where: { userId } });
    return rows.map((r) => r.departmentId);
  }

  /** 用户作为成员所属的部门 id 列表（部门管理员也视为所属） */
  async memberDepartmentIds(userId: string): Promise<string[]> {
    const [memberRows, adminRows] = await Promise.all([
      this.deptMembers.find({ where: { userId } }),
      this.deptAdmins.find({ where: { userId } }),
    ]);
    return [...new Set([...memberRows.map((r) => r.departmentId), ...adminRows.map((r) => r.departmentId)])];
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
