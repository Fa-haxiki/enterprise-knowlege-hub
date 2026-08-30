import { Injectable } from '@nestjs/common';
import { InjectDataSource, InjectRepository } from '@nestjs/typeorm';
import { DataSource, Repository } from 'typeorm';
import { ErrorCode, SystemRole, WorkspaceRole } from '@ekh/shared';
import { WorkspaceEntity } from '../../database/entities/workspace.entity';
import { WorkspaceMemberEntity } from '../../database/entities/workspace-member.entity';
import { DepartmentEntity } from '../../database/entities/department.entity';
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
  async listDepartments(user: AuthUser) {
    if (user.role === SystemRole.SYSADMIN) {
      const deps = await this.departments.find({ order: { createdAt: 'ASC' } });
      return { items: deps.map((d) => ({ id: d.id, name: d.name })) };
    }
    const depIds = await this.acl.memberDepartmentIds(user.userId);
    if (depIds.length === 0) return { items: [] };
    const deps = await this.departments.find({ where: depIds.map((id) => ({ id })), order: { createdAt: 'ASC' } });
    return { items: deps.map((d) => ({ id: d.id, name: d.name })) };
  }

  /** 列出当前用户可见的空间（含角色） */
  async listMine(userId: string) {
    const rows = await this.members
      .createQueryBuilder('m')
      .innerJoinAndSelect('m.workspace', 'ws')
      .leftJoinAndSelect('ws.department', 'dep')
      .where('m.user_id = :userId', { userId })
      .orderBy('ws.created_at', 'DESC')
      .getMany();
    return rows.map((m) => ({
      id: m.workspace.id,
      name: m.workspace.name,
      description: m.workspace.description,
      role: m.role,
      department: m.workspace.department
        ? { id: m.workspace.department.id, name: m.workspace.department.name }
        : null,
      created_at: m.workspace.createdAt,
    }));
  }

  async create(user: AuthUser, name: string, description?: string, departmentId?: string) {
    // 空间必须挂靠部门（审核归属）；普通用户只能挂自己所属的部门，sysadmin 可挂任意部门
    if (!departmentId) {
      throw new BizException(ErrorCode.PARAM_MISSING, '必须选择挂靠部门', 400);
    }
    if (user.role !== SystemRole.SYSADMIN) {
      const myDeps = await this.acl.memberDepartmentIds(user.userId);
      if (!myDeps.includes(departmentId)) {
        throw new BizException(ErrorCode.ACL_FORBIDDEN, '只能将空间挂靠到您所属的部门', 403);
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
    // 改挂靠部门同样限制在自己所属的部门内
    if (department_id && user.role !== SystemRole.SYSADMIN) {
      const myDeps = await this.acl.memberDepartmentIds(user.userId);
      if (!myDeps.includes(department_id)) {
        throw new BizException(ErrorCode.ACL_FORBIDDEN, '只能将空间挂靠到您所属的部门', 403);
      }
    }
    const data: { name?: string; description?: string; departmentId?: string | null } = { ...rest };
    if (department_id !== undefined) data.departmentId = department_id;
    await this.workspaces.update(id, data);
    return this.workspaces.findOne({ where: { id } });
  }

  async remove(id: string) {
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
