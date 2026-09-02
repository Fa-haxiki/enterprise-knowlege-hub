import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import * as argon2 from 'argon2';
import { ErrorCode, SystemRole, UserStatus } from '@ekh/shared';
import { UserEntity } from '../../database/entities/user.entity';
import { DepartmentEntity } from '../../database/entities/department.entity';
import { DepartmentMemberEntity } from '../../database/entities/department-member.entity';
import { AuditService } from '../audit/audit.service';
import { AclService } from '../workspaces/acl.service';
import { AuthService } from '../auth/auth.service';
import { BizException } from '../../common/filters/http-exception.filter';
import type { AuthUser } from '../../common/decorators/current-user.decorator';

@Injectable()
export class DepartmentsService {
  constructor(
    @InjectRepository(DepartmentEntity)
    private readonly departments: Repository<DepartmentEntity>,
    @InjectRepository(DepartmentMemberEntity)
    private readonly members: Repository<DepartmentMemberEntity>,
    @InjectRepository(UserEntity)
    private readonly users: Repository<UserEntity>,
    private readonly acl: AclService,
    private readonly audit: AuditService,
    private readonly auth: AuthService,
  ) {}

  /** 我作为管理员负责的部门列表 */
  async myManagedDepartments(userId: string) {
    const depIds = await this.acl.adminDepartmentIds(userId);
    if (depIds.length === 0) return { items: [] };
    const deps = await this.departments.find({ where: depIds.map((id) => ({ id })) });
    const items = [];
    for (const d of deps) {
      const rows = await this.members.find({ where: { departmentId: d.id }, relations: { user: true } });
      items.push({
        id: d.id,
        name: d.name,
        description: d.description,
        members: rows.map((m) => ({
          id: m.user.id,
          name: m.user.name,
          email: m.user.email,
          status: m.user.status,
          disabled: !!m.user.disabledAt,
        })),
      });
    }
    return { items };
  }

  async listMembers(user: AuthUser, departmentId: string) {
    await this.assertManager(user, departmentId);
    const rows = await this.members.find({ where: { departmentId }, relations: { user: true } });
    return {
      items: rows.map((m) => ({
        id: m.user.id,
        name: m.user.name,
        email: m.user.email,
        status: m.user.status,
        disabled: !!m.user.disabledAt,
        added_at: m.addedAt,
      })),
    };
  }

  /** 可添加为成员的候选用户：ACTIVE 且尚未加入本部门 */
  async candidates(user: AuthUser, departmentId: string, keyword?: string) {
    await this.assertManager(user, departmentId);
    const existing = await this.members.find({ where: { departmentId } });
    const existingIds = new Set(existing.map((m) => m.userId));
    const qb = this.users
      .createQueryBuilder('u')
      .where('u.status = :status', { status: UserStatus.ACTIVE })
      .orderBy('u.created_at', 'DESC')
      .take(50);
    if (keyword) qb.andWhere('(u.email ILIKE :kw OR u.name ILIKE :kw)', { kw: `%${keyword}%` });
    const rows = await qb.getMany();
    return {
      items: rows
        .filter((u) => !existingIds.has(u.id))
        .map((u) => ({ id: u.id, name: u.name, email: u.email })),
    };
  }

  /** 添加部门成员：本部门管理员或 sysadmin */
  async addMember(operator: AuthUser, departmentId: string, userId: string) {
    await this.assertManager(operator, departmentId);
    const target = await this.users.findOne({ where: { id: userId } });
    if (!target || target.status !== UserStatus.ACTIVE) {
      throw new BizException(ErrorCode.PARAM_INVALID, '用户不存在或未激活', 400);
    }
    await this.members.save(this.members.create({ departmentId, userId, addedBy: operator.userId }));
    await this.acl.invalidate(userId);
    this.audit.record({
      userId: operator.userId,
      action: 'dept_member_add',
      resourceType: 'department',
      resourceId: departmentId,
      detail: { member_id: userId },
    });
    return { ok: true };
  }

  /**
   * 初始化创建部门成员：部门管理员（限本部门）或 sysadmin 直接创建账号，
   * 角色固定 member、直接 ACTIVE 并加入本部门，无需注册审核。
   */
  async createMember(
    operator: AuthUser,
    departmentId: string,
    params: { email: string; name: string; password: string },
  ) {
    await this.assertManager(operator, departmentId);
    const exists = await this.users.findOne({ where: { email: params.email } });
    if (exists) throw new BizException(ErrorCode.CONFLICT, '邮箱已注册', 409);
    const user = await this.users.save(
      this.users.create({
        email: params.email,
        name: params.name,
        passwordHash: await argon2.hash(params.password),
        role: SystemRole.MEMBER,
        status: UserStatus.ACTIVE,
      }),
    );
    await this.members.save(this.members.create({ departmentId, userId: user.id, addedBy: operator.userId }));
    await this.acl.invalidate(user.id);
    this.audit.record({
      userId: operator.userId,
      action: 'dept_member_create',
      resourceType: 'department',
      resourceId: departmentId,
      detail: { member_id: user.id, email: params.email },
    });
    return { id: user.id, email: user.email, name: user.name };
  }

  /** 禁用/启用本部门成员：禁用后立即无法登录，refresh 时也会被拦截 */
  async setMemberDisabled(operator: AuthUser, departmentId: string, userId: string, disabled: boolean) {
    await this.assertManager(operator, departmentId);
    if (operator.userId === userId) {
      throw new BizException(ErrorCode.PARAM_INVALID, '不能禁用自己的账号', 400);
    }
    const membership = await this.members.findOne({ where: { departmentId, userId }, relations: { user: true } });
    if (!membership) {
      throw new BizException(ErrorCode.PARAM_INVALID, '该用户不是本部门成员', 400);
    }
    if (membership.user.role === SystemRole.SYSADMIN) {
      throw new BizException(ErrorCode.PARAM_INVALID, '不能禁用系统管理员', 400);
    }
    membership.user.disabledAt = disabled ? new Date() : null;
    await this.users.save(membership.user);
    // 禁用立即吊销全部 Refresh Token + 清 Guard 状态缓存；启用只需清缓存让 Guard 回源
    if (disabled) {
      await this.auth.revokeAll(userId);
    } else {
      await this.auth.clearUserStateCache(userId);
    }
    await this.acl.invalidate(userId);
    this.audit.record({
      userId: operator.userId,
      action: disabled ? 'dept_member_disable' : 'dept_member_enable',
      resourceType: 'department',
      resourceId: departmentId,
      detail: { member_id: userId },
    });
    return { ok: true };
  }

  async removeMember(operator: AuthUser, departmentId: string, userId: string) {
    await this.assertManager(operator, departmentId);
    await this.members.delete({ departmentId, userId });
    await this.acl.invalidate(userId);
    this.audit.record({
      userId: operator.userId,
      action: 'dept_member_remove',
      resourceType: 'department',
      resourceId: departmentId,
      detail: { member_id: userId },
    });
    return { ok: true };
  }

  /** 管理权限：sysadmin 或本部门管理员 */
  private async assertManager(user: AuthUser, departmentId: string) {
    if (user.role === SystemRole.SYSADMIN) return;
    if (await this.acl.isDepartmentAdmin(user.userId, departmentId)) return;
    throw new BizException(ErrorCode.ACL_FORBIDDEN, '仅部门管理员或系统管理员可管理部门成员', 403);
  }
}
