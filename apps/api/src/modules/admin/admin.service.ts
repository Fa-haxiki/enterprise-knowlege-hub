import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import * as argon2 from 'argon2';
import { ErrorCode, SystemRole, UserStatus } from '@ekh/shared';
import { UserEntity } from '../../database/entities/user.entity';
import { DepartmentEntity } from '../../database/entities/department.entity';
import { DepartmentAdminEntity } from '../../database/entities/department-admin.entity';
import { DepartmentMemberEntity } from '../../database/entities/department-member.entity';
import { AuditService } from '../audit/audit.service';
import { AclService } from '../workspaces/acl.service';
import { BizException } from '../../common/filters/http-exception.filter';

@Injectable()
export class AdminService {
  constructor(
    @InjectRepository(UserEntity)
    private readonly users: Repository<UserEntity>,
    @InjectRepository(DepartmentEntity)
    private readonly departments: Repository<DepartmentEntity>,
    @InjectRepository(DepartmentAdminEntity)
    private readonly deptAdmins: Repository<DepartmentAdminEntity>,
    @InjectRepository(DepartmentMemberEntity)
    private readonly deptMembers: Repository<DepartmentMemberEntity>,
    private readonly audit: AuditService,
    private readonly acl: AclService,
  ) {}

  // ---------- 用户管理 ----------

  async listUsers(params: { status?: UserStatus; keyword?: string; page: number; pageSize: number }) {
    const qb = this.users
      .createQueryBuilder('u')
      .orderBy('u.created_at', 'DESC')
      .skip((params.page - 1) * params.pageSize)
      .take(params.pageSize);
    if (params.status) qb.andWhere('u.status = :status', { status: params.status });
    if (params.keyword) {
      qb.andWhere('(u.email ILIKE :kw OR u.name ILIKE :kw)', { kw: `%${params.keyword}%` });
    }
    const [items, total] = await qb.getManyAndCount();
    // 部门归属：成员关系 + 管理员标记
    const memberRows = await this.deptMembers.find({ relations: { department: true } });
    const adminRows = await this.deptAdmins.find({ relations: { department: true } });
    const depsOf = new Map<string, { id: string; name: string; is_admin: boolean }[]>();
    for (const m of memberRows) {
      const list = depsOf.get(m.userId) ?? [];
      list.push({ id: m.department.id, name: m.department.name, is_admin: false });
      depsOf.set(m.userId, list);
    }
    for (const a of adminRows) {
      const list = depsOf.get(a.userId) ?? [];
      const existing = list.find((d) => d.id === a.department.id);
      if (existing) existing.is_admin = true;
      else list.push({ id: a.department.id, name: a.department.name, is_admin: true });
      depsOf.set(a.userId, list);
    }
    return {
      total,
      page: params.page,
      page_size: params.pageSize,
      has_more: params.page * params.pageSize < total,
      items: items.map((u) => ({
        id: u.id,
        email: u.email,
        name: u.name,
        role: u.role,
        status: u.status,
        review_note: u.reviewNote,
        disabled: !!u.disabledAt,
        departments: depsOf.get(u.id) ?? [],
        created_at: u.createdAt,
      })),
    };
  }

  /** 管理员手动创建用户：直接 ACTIVE，无需审核；可选直接加入部门成为成员 */
  async createUser(
    adminId: string,
    params: { email: string; name: string; password: string; role?: SystemRole; department_id?: string },
  ) {
    const exists = await this.users.findOne({ where: { email: params.email } });
    if (exists) throw new BizException(ErrorCode.CONFLICT, '邮箱已注册', 409);
    if (params.department_id) await this.mustGetDepartment(params.department_id);
    const user = await this.users.save(
      this.users.create({
        email: params.email,
        name: params.name,
        passwordHash: await argon2.hash(params.password),
        role: params.role ?? SystemRole.MEMBER,
        status: UserStatus.ACTIVE,
      }),
    );
    if (params.department_id) {
      await this.deptMembers.save(
        this.deptMembers.create({ departmentId: params.department_id, userId: user.id, addedBy: adminId }),
      );
    }
    this.audit.record({
      userId: adminId,
      action: 'user_create',
      resourceType: 'user',
      resourceId: user.id,
      detail: { email: params.email, role: user.role, department_id: params.department_id ?? null },
    });
    return { id: user.id, email: user.email, name: user.name, role: user.role, status: user.status };
  }

  /** 注册审核通过：激活账号 */
  async approveUser(adminId: string, userId: string) {
    const user = await this.mustGetUser(userId);
    if (user.status !== UserStatus.PENDING) {
      throw new BizException(ErrorCode.PARAM_INVALID, '该用户不在待审核状态', 400);
    }
    user.status = UserStatus.ACTIVE;
    user.reviewNote = null;
    await this.users.save(user);
    this.audit.record({ userId: adminId, action: 'user_approve', resourceType: 'user', resourceId: userId });
    return { ok: true };
  }

  async rejectUser(adminId: string, userId: string, reason?: string) {
    const user = await this.mustGetUser(userId);
    if (user.status !== UserStatus.PENDING) {
      throw new BizException(ErrorCode.PARAM_INVALID, '该用户不在待审核状态', 400);
    }
    user.status = UserStatus.REJECTED;
    user.reviewNote = reason?.trim() || null;
    await this.users.save(user);
    this.audit.record({
      userId: adminId,
      action: 'user_reject',
      resourceType: 'user',
      resourceId: userId,
      detail: { reason: reason ?? null },
    });
    return { ok: true };
  }

  /** 运行时管理：改系统角色 / 禁用启用 */
  async updateUser(adminId: string, userId: string, patch: { role?: SystemRole; disabled?: boolean }) {
    const user = await this.mustGetUser(userId);
    if (userId === adminId && (patch.disabled || (patch.role && patch.role !== SystemRole.SYSADMIN))) {
      throw new BizException(ErrorCode.PARAM_INVALID, '不能禁用或降级自己的账号', 400);
    }
    if (patch.role) user.role = patch.role;
    if (patch.disabled !== undefined) user.disabledAt = patch.disabled ? new Date() : null;
    await this.users.save(user);
    this.audit.record({
      userId: adminId,
      action: 'user_update',
      resourceType: 'user',
      resourceId: userId,
      detail: patch,
    });
    return { ok: true };
  }

  // ---------- 部门管理 ----------

  /** 部门列表（轻量）：只带人数统计，成员明细由 getDepartmentDetail 按需加载 */
  async listDepartments() {
    const deps = await this.departments.find({ order: { createdAt: 'ASC' } });
    const countBy = async (repo: Repository<DepartmentAdminEntity | DepartmentMemberEntity>) => {
      const rows = await repo
        .createQueryBuilder('r')
        .select('r.department_id', 'dep_id')
        .addSelect('COUNT(*)', 'cnt')
        .groupBy('r.department_id')
        .getRawMany<{ dep_id: string; cnt: string }>();
      return new Map(rows.map((r) => [r.dep_id, parseInt(r.cnt, 10)]));
    };
    const [adminCnt, memberCnt] = await Promise.all([countBy(this.deptAdmins), countBy(this.deptMembers)]);
    return {
      items: deps.map((d) => ({
        id: d.id,
        name: d.name,
        description: d.description,
        admin_count: adminCnt.get(d.id) ?? 0,
        member_count: memberCnt.get(d.id) ?? 0,
        created_at: d.createdAt,
      })),
    };
  }

  /** 部门详情：含管理员与成员列表（点击部门时按需加载） */
  async getDepartmentDetail(id: string) {
    const dep = await this.mustGetDepartment(id);
    const pick = (r: DepartmentAdminEntity | DepartmentMemberEntity) => ({
      id: r.user.id,
      name: r.user.name,
      email: r.user.email,
      disabled: !!r.user.disabledAt,
    });
    const [admins, members] = await Promise.all([
      this.deptAdmins.find({ where: { departmentId: id }, relations: { user: true } }),
      this.deptMembers.find({ where: { departmentId: id }, relations: { user: true } }),
    ]);
    return {
      id: dep.id,
      name: dep.name,
      description: dep.description,
      admins: admins.map(pick),
      members: members.map(pick),
      created_at: dep.createdAt,
    };
  }

  async createDepartment(adminId: string, name: string, description?: string) {
    const exists = await this.departments.findOne({ where: { name } });
    if (exists) throw new BizException(ErrorCode.CONFLICT, '部门名称已存在', 409);
    const dep = await this.departments.save(this.departments.create({ name, description: description ?? null }));
    this.audit.record({ userId: adminId, action: 'department_create', resourceType: 'department', resourceId: dep.id });
    return dep;
  }

  async updateDepartment(adminId: string, id: string, patch: { name?: string; description?: string }) {
    const dep = await this.departments.findOne({ where: { id } });
    if (!dep) throw new BizException(ErrorCode.NOT_FOUND, '部门不存在', 404);
    if (patch.name) dep.name = patch.name;
    if (patch.description !== undefined) dep.description = patch.description;
    await this.departments.save(dep);
    this.audit.record({ userId: adminId, action: 'department_update', resourceType: 'department', resourceId: id, detail: patch });
    return { ok: true };
  }

  async removeDepartment(adminId: string, id: string) {
    const dep = await this.departments.findOne({ where: { id } });
    if (!dep) throw new BizException(ErrorCode.NOT_FOUND, '部门不存在', 404);
    // 空间 department_id 由 FK ON DELETE SET NULL 自动置空，后续文档审核落入 sysadmin 兜底
    await this.departments.remove(dep);
    this.audit.record({ userId: adminId, action: 'department_delete', resourceType: 'department', resourceId: id });
    return { ok: true };
  }

  /** 指派部门管理员（仅 sysadmin） */
  async addDepartmentAdmin(adminId: string, departmentId: string, userId: string) {
    await this.mustGetDepartment(departmentId);
    await this.mustGetUser(userId);
    await this.deptAdmins.save(this.deptAdmins.create({ departmentId, userId, grantedBy: adminId }));
    await this.acl.invalidate(userId);
    this.audit.record({
      userId: adminId,
      action: 'dept_admin_add',
      resourceType: 'department',
      resourceId: departmentId,
      detail: { admin_user_id: userId },
    });
    return { ok: true };
  }

  async removeDepartmentAdmin(adminId: string, departmentId: string, userId: string) {
    await this.deptAdmins.delete({ departmentId, userId });
    await this.acl.invalidate(userId);
    this.audit.record({
      userId: adminId,
      action: 'dept_admin_remove',
      resourceType: 'department',
      resourceId: departmentId,
      detail: { admin_user_id: userId },
    });
    return { ok: true };
  }

  private async mustGetUser(id: string) {
    const user = await this.users.findOne({ where: { id } });
    if (!user) throw new BizException(ErrorCode.NOT_FOUND, '用户不存在', 404);
    return user;
  }

  private async mustGetDepartment(id: string) {
    const dep = await this.departments.findOne({ where: { id } });
    if (!dep) throw new BizException(ErrorCode.NOT_FOUND, '部门不存在', 404);
    return dep;
  }
}
