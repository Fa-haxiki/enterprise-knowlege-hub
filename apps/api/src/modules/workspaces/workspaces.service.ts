import { Injectable } from '@nestjs/common';
import { InjectDataSource, InjectRepository } from '@nestjs/typeorm';
import { DataSource, In, IsNull, Repository } from 'typeorm';
import { DocumentStatus, ErrorCode, SystemRole, WorkspaceRole } from '@ekh/shared';
import { WorkspaceEntity } from '../../database/entities/workspace.entity';
import { WorkspaceMemberEntity } from '../../database/entities/workspace-member.entity';
import { DepartmentEntity } from '../../database/entities/department.entity';
import { DocumentEntity } from '../../database/entities/document.entity';
import { BizException } from '../../common/filters/http-exception.filter';
import { AclService } from './acl.service';
import type { AuthUser } from '../../common/decorators/current-user.decorator';

@Injectable()
export class WorkspacesService {
  constructor(
    @InjectRepository(WorkspaceEntity)
    private readonly workspaces: Repository<WorkspaceEntity>,
    @InjectRepository(WorkspaceMemberEntity)
    private readonly members: Repository<WorkspaceMemberEntity>,
    @InjectRepository(DepartmentEntity)
    private readonly departments: Repository<DepartmentEntity>,
    @InjectDataSource() private readonly dataSource: DataSource,
    private readonly acl: AclService,
  ) {}

  /** 部门只读列表：建空间时选择挂靠。普通用户只能选自己所属的部门，sysadmin 可见全部 */
  /** 创建空间时可挂靠的部门：sysadmin 全部；部门管理员限其管理的部门；普通成员为空（无创建权限） */
  async listDepartments(user: AuthUser) {
    if (user.role === SystemRole.SYSADMIN) {
      const deps = await this.departments.find({ order: { createdAt: 'ASC' } });
      return { items: deps.map((d) => ({ id: d.id, name: d.name })) };
    }
    const depIds = await this.acl.adminDepartmentIds(user.userId);
    if (depIds.length === 0) return { items: [] };
    const deps = await this.departments.find({ where: depIds.map((id) => ({ id })), order: { createdAt: 'ASC' } });
    return { items: deps.map((d) => ({ id: d.id, name: d.name })) };
  }

  /** 列出当前用户可见的空间（含角色）：显式成员空间 ∪ 所属部门挂靠的空间（默认 viewer）。
   *  附带 pending_count（待审核文档数）与 can_review（是否可审核该空间），供审核入口并入空间后展示角标与 Tab */
  async listMine(user: AuthUser) {
    const userId = user.userId;
    const rows = await this.members
      .createQueryBuilder('m')
      .innerJoinAndSelect('m.workspace', 'ws')
      .leftJoinAndSelect('ws.department', 'dep')
      .where('m.user_id = :userId', { userId })
      .orderBy('ws.created_at', 'DESC')
      .getMany();
    const items = rows.map((m) => ({
      id: m.workspace.id,
      name: m.workspace.name,
      description: m.workspace.description,
      role: m.role,
      department: m.workspace.department
        ? { id: m.workspace.department.id, name: m.workspace.department.name }
        : null,
      created_at: m.workspace.createdAt,
    }));

    // 部门成员可见的部门空间（未显式加入的部分，以 viewer 身份并入）；
    // sysadmin 可见全部空间（审核入口并入空间后，需能进入任意空间的待审核 Tab）
    const isSys = user.role === SystemRole.SYSADMIN;
    const depIds = await this.acl.memberDepartmentIds(userId);
    if (depIds.length > 0 || isSys) {
      const seen = new Set(items.map((i) => i.id));
      const depWs = await this.workspaces.find({
        where: isSys ? {} : { departmentId: In(depIds) },
        relations: { department: true },
        order: { createdAt: 'DESC' },
      });
      for (const ws of depWs) {
        if (seen.has(ws.id)) continue;
        items.push({
          id: ws.id,
          name: ws.name,
          description: ws.description,
          role: WorkspaceRole.VIEWER,
          department: ws.department ? { id: ws.department.id, name: ws.department.name } : null,
          created_at: ws.createdAt,
        });
      }
    }

    if (items.length === 0) return [];
    const adminDeps = await this.acl.adminDepartmentIds(userId);
    const counts = await this.dataSource
      .getRepository(DocumentEntity)
      .createQueryBuilder('d')
      .select('d.workspace_id', 'wsId')
      .addSelect('COUNT(*)', 'cnt')
      .where('d.workspace_id IN (:...ids)', { ids: items.map((i) => i.id) })
      .andWhere('d.status = :st', { st: DocumentStatus.PENDING_REVIEW })
      .andWhere('d.deleted_at IS NULL')
      .groupBy('d.workspace_id')
      .getRawMany<{ wsId: string; cnt: string }>();
    const countOf = new Map(counts.map((c) => [c.wsId, Number(c.cnt)]));
    return items.map((i) => ({
      ...i,
      pending_count: countOf.get(i.id) ?? 0,
      can_review: isSys || (!!i.department && adminDeps.includes(i.department.id)),
    }));
  }

  async create(user: AuthUser, name: string, description?: string, departmentId?: string) {
    // 空间必须挂靠部门（审核归属）；创建权限收紧：仅 sysadmin / 部门管理员，
    // 部门管理员只能在自己管理的部门下创建，普通成员只读不可创建
    if (!departmentId) {
      throw new BizException(ErrorCode.PARAM_MISSING, '必须选择挂靠部门', 400);
    }
    if (user.role !== SystemRole.SYSADMIN) {
      const managedDeps = await this.acl.adminDepartmentIds(user.userId);
      if (managedDeps.length === 0) {
        throw new BizException(ErrorCode.ACL_FORBIDDEN, '仅部门管理员可创建知识空间', 403);
      }
      if (!managedDeps.includes(departmentId)) {
        throw new BizException(ErrorCode.ACL_FORBIDDEN, '只能在您管理的部门下创建空间', 403);
      }
    }
    const userId = user.userId;
    return this.dataSource.transaction(async (em) => {
      const ws = await em.save(
        em.create(WorkspaceEntity, {
          name,
          description: description ?? null,
          ownerId: userId,
          departmentId: departmentId ?? null,
        }),
      );
      await em.save(
        em.create(WorkspaceMemberEntity, {
          workspaceId: ws.id,
          userId,
          role: WorkspaceRole.OWNER,
        }),
      );
      await this.acl.invalidate(userId);
      return ws;
    });
  }

  async update(
    user: AuthUser,
    id: string,
    patch: { name?: string; description?: string; department_id?: string | null },
  ) {
    const { department_id, ...rest } = patch;
    // 空间必须挂靠部门：不允许置空
    if (department_id === null) {
      throw new BizException(ErrorCode.PARAM_INVALID, '空间必须挂靠部门，不允许取消挂靠', 400);
    }
    const data: { name?: string; description?: string; departmentId?: string | null } = { ...rest };
    if (department_id !== undefined) data.departmentId = department_id;
    const before = department_id !== undefined
      ? await this.workspaces.findOne({ where: { id }, select: ['departmentId'] })
      : null;
    // 改挂靠部门与创建一致：仅部门管理员，且限其管理的部门；值未变化（如仅改名称）不校验
    if (department_id && before?.departmentId !== department_id && user.role !== SystemRole.SYSADMIN) {
      const managedDeps = await this.acl.adminDepartmentIds(user.userId);
      if (!managedDeps.includes(department_id)) {
        throw new BizException(ErrorCode.ACL_FORBIDDEN, '只能将空间挂靠到您管理的部门', 403);
      }
    }
    await this.workspaces.update(id, data);
    // 改挂部门会改变两个部门成员的可见空间集合，缓存需失效
    if (department_id !== undefined && before?.departmentId !== department_id) {
      if (before?.departmentId) await this.acl.invalidateDepartment(before.departmentId);
      await this.acl.invalidateDepartment(department_id as string);
    }
    return this.workspaces.findOne({ where: { id } });
  }

  async remove(id: string) {
    // 非空空间禁止删除：文档的 chunk/ES/Neo4j/MinIO 清理由 worker 异步任务完成，
    // 直接级联删库会留下孤儿数据，要求先逐篇删除文档（各走完整清理流程）
    const docCount = await this.dataSource.getRepository(DocumentEntity).count({
      where: { workspaceId: id, deletedAt: IsNull() },
    });
    if (docCount > 0) {
      throw new BizException(
        ErrorCode.PARAM_INVALID,
        `空间内还有 ${docCount} 篇文档，请先删除全部文档后再删除空间`,
        400,
      );
    }
    const memberRows = await this.members.find({ where: { workspaceId: id } });
    await this.workspaces.delete(id);
    await this.acl.invalidateMany(memberRows.map((m) => m.userId));
    return { deleted: true };
  }

  async listMembers(workspaceId: string) {
    const rows = await this.members.find({
      where: { workspaceId },
      relations: { user: true },
    });
    return rows.map((m) => ({
      user_id: m.userId,
      email: m.user.email,
      name: m.user.name,
      role: m.role,
      granted_at: m.grantedAt,
    }));
  }

  async addMember(workspaceId: string, userId: string, role: WorkspaceRole) {
    const exists = await this.members.findOne({ where: { workspaceId, userId } });
    if (exists) throw new BizException(ErrorCode.CONFLICT, '用户已是空间成员', 409);
    await this.members.save(this.members.create({ workspaceId, userId, role }));
    await this.acl.invalidate(userId);
    return { granted: true };
  }

  async updateMember(workspaceId: string, userId: string, role: WorkspaceRole) {
    const exists = await this.members.findOne({ where: { workspaceId, userId } });
    if (!exists) throw new BizException(ErrorCode.NOT_FOUND, '成员不存在', 404);
    await this.members.update({ workspaceId, userId }, { role });
    await this.acl.invalidate(userId);
    return { updated: true };
  }

  async removeMember(workspaceId: string, userId: string) {
    const target = await this.members.findOne({ where: { workspaceId, userId } });
    if (!target) throw new BizException(ErrorCode.NOT_FOUND, '成员不存在', 404);
    if (target.role === WorkspaceRole.OWNER) {
      const owners = await this.members.count({ where: { workspaceId, role: WorkspaceRole.OWNER } });
      if (owners <= 1) throw new BizException(ErrorCode.PARAM_INVALID, '空间至少保留一名 owner', 400);
    }
    await this.members.delete({ workspaceId, userId });
    await this.acl.invalidate(userId);
    return { removed: true };
  }
}
