import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectRepository } from '@nestjs/typeorm';
import { In, Repository } from 'typeorm';
import { WorkspaceRole } from '@ekh/shared';
import { WorkspaceMemberEntity } from '../../database/entities/workspace-member.entity';
import { WorkspaceEntity } from '../../database/entities/workspace.entity';
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
  /** 已确认存在的公共空间 id；未创建前不缓存，避免启动早期把「没有」记死 */
  private companyWorkspaceIdCache: string | null = null;

  constructor(
    @InjectRepository(WorkspaceMemberEntity)
    private readonly members: Repository<WorkspaceMemberEntity>,
    @InjectRepository(DepartmentAdminEntity)
    private readonly deptAdmins: Repository<DepartmentAdminEntity>,
    @InjectRepository(DepartmentMemberEntity)
    private readonly deptMembers: Repository<DepartmentMemberEntity>,
    @InjectRepository(WorkspaceEntity)
    private readonly workspaces: Repository<WorkspaceEntity>,
    private readonly redis: RedisService,
    private readonly config: ConfigService,
  ) {}

  /** 系统公共空间 id；没有则返回 null（种子或列表接口会创建） */
  async companyWorkspaceId(): Promise<string | null> {
    if (this.companyWorkspaceIdCache) return this.companyWorkspaceIdCache;
    const ws = await this.workspaces.findOne({ where: { visibility: 'company' }, select: ['id'] });
    if (ws) this.companyWorkspaceIdCache = ws.id;
    return ws?.id ?? null;
  }

  async isCompanyWorkspace(workspaceId: string): Promise<boolean> {
    const id = await this.companyWorkspaceId();
    return !!id && id === workspaceId;
  }

  /** 加载用户可见空间白名单（缓存优先）：显式成员空间 ∪ 所属部门挂靠的空间。公共空间不进白名单，分片仍挂在部门空间上 */
  async getWhitelist(userId: string): Promise<string[]> {
    const key = whitelistKey(userId);
    const cached = await this.redis.getSet(key);
    const companyId = await this.companyWorkspaceId();
    if (cached.length > 0) return companyId ? cached.filter((id) => id !== companyId) : cached;

    const rows = await this.members.find({ where: { userId } });
    const ids = new Set(rows.map((r) => r.workspaceId));
    const depIds = await this.memberDepartmentIds(userId);
    if (depIds.length > 0) {
      const depWs = await this.workspaces.find({
        where: { departmentId: In(depIds), visibility: 'private' },
        select: ['id'],
      });
      for (const w of depWs) ids.add(w.id);
    }
    if (companyId) ids.delete(companyId);
    const result = [...ids];
    await this.redis.refreshSet(key, result, this.ttl());
    return result;
  }

  /**
   * 用户在空间内的角色；非成员返回 null。
   * 公共空间对任意登录用户固定 viewer（不可上传）。
   * 显式成员角色优先；非成员但属于空间挂靠部门的成员 → 默认 viewer（只读问答，上传需显式授权 editor）
   */
  async getRole(userId: string, workspaceId: string): Promise<WorkspaceRole | null> {
    if (await this.isCompanyWorkspace(workspaceId)) return WorkspaceRole.VIEWER;
    const row = await this.members.findOne({ where: { userId, workspaceId } });
    if (row) return row.role;
    const ws = await this.workspaces.findOne({ where: { id: workspaceId }, select: ['departmentId'] });
    if (!ws?.departmentId) return null;
    const depIds = await this.memberDepartmentIds(userId);
    return depIds.includes(ws.departmentId) ? WorkspaceRole.VIEWER : null;
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

  /** 空间改挂部门时失效该部门全部成员/管理员的缓存（部门可见空间集合变了） */
  async invalidateDepartment(departmentId: string): Promise<void> {
    const [ms, as] = await Promise.all([
      this.deptMembers.find({ where: { departmentId } }),
      this.deptAdmins.find({ where: { departmentId } }),
    ]);
    await this.invalidateMany([...new Set([...ms.map((m) => m.userId), ...as.map((a) => a.userId)])]);
  }

  private ttl(): number {
    return this.config.get<number>('rag.aclCacheTtlSeconds') ?? 600;
  }
}
