import { Injectable } from '@nestjs/common';
import { InjectDataSource, InjectRepository } from '@nestjs/typeorm';
import { DataSource, Repository } from 'typeorm';
import { ErrorCode, WorkspaceRole } from '@ekh/shared';
import { WorkspaceEntity } from '../../database/entities/workspace.entity';
import { WorkspaceMemberEntity } from '../../database/entities/workspace-member.entity';
import { BizException } from '../../common/filters/http-exception.filter';
import { AclService } from './acl.service';

@Injectable()
export class WorkspacesService {
  constructor(
    @InjectRepository(WorkspaceEntity)
    private readonly workspaces: Repository<WorkspaceEntity>,
    @InjectRepository(WorkspaceMemberEntity)
    private readonly members: Repository<WorkspaceMemberEntity>,
    @InjectDataSource() private readonly dataSource: DataSource,
    private readonly acl: AclService,
  ) {}

  /** 列出当前用户可见的空间（含角色） */
  async listMine(userId: string) {
    const rows = await this.members
      .createQueryBuilder('m')
      .innerJoinAndSelect('m.workspace', 'ws')
      .where('m.user_id = :userId', { userId })
      .orderBy('ws.created_at', 'DESC')
      .getMany();
    return rows.map((m) => ({
      id: m.workspace.id,
      name: m.workspace.name,
      description: m.workspace.description,
      role: m.role,
      created_at: m.workspace.createdAt,
    }));
  }

  async create(userId: string, name: string, description?: string) {
    return this.dataSource.transaction(async (em) => {
      const ws = await em.save(
        em.create(WorkspaceEntity, { name, description: description ?? null, ownerId: userId }),
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

  async update(id: string, patch: { name?: string; description?: string }) {
    await this.workspaces.update(id, patch);
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
