import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  UseGuards,
} from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { WorkspaceRole } from '@ekh/shared';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { CurrentUser, type AuthUser } from '../../common/decorators/current-user.decorator';
import { AclGuard, RequireWorkspaceRole } from './guards/acl.guard';
import { AuditService } from '../audit/audit.service';
import {
  AddMemberDto,
  CreateWorkspaceDto,
  UpdateMemberDto,
  UpdateWorkspaceDto,
} from './dto/workspace.dto';
import { WorkspacesService } from './workspaces.service';

@ApiTags('workspaces')
@UseGuards(JwtAuthGuard)
@Controller({ path: 'workspaces', version: '1' })
export class WorkspacesController {
  constructor(
    private readonly workspaces: WorkspacesService,
    private readonly audit: AuditService,
  ) {}

  @Get()
  list(@CurrentUser() user: AuthUser) {
    return this.workspaces.listMine(user);
  }

  /** 部门只读列表（建空间时选择挂靠，仅含我所属的部门），须在 :id 路由之前注册 */
  @Get('departments')
  departments(@CurrentUser() user: AuthUser) {
    return this.workspaces.listDepartments(user);
  }

  @Post()
  async create(@CurrentUser() user: AuthUser, @Body() dto: CreateWorkspaceDto) {
    const ws = await this.workspaces.create(user, dto.name, dto.description, dto.department_id);
    this.audit.record({
      userId: user.userId,
      action: 'workspace_create',
      resourceType: 'workspace',
      resourceId: ws.id,
      detail: { name: dto.name },
    });
    return ws;
  }

  @Patch(':id')
  @UseGuards(AclGuard)
  @RequireWorkspaceRole(WorkspaceRole.OWNER)
  update(
    @CurrentUser() user: AuthUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: UpdateWorkspaceDto,
  ) {
    return this.workspaces.update(user, id, dto);
  }

  @Delete(':id')
  @UseGuards(AclGuard)
  @RequireWorkspaceRole(WorkspaceRole.OWNER)
  async remove(@CurrentUser() user: AuthUser, @Param('id', ParseUUIDPipe) id: string) {
    const result = await this.workspaces.remove(id);
    this.audit.record({
      userId: user.userId,
      action: 'workspace_delete',
      resourceType: 'workspace',
      resourceId: id,
    });
    return result;
  }

  @Get(':id/members')
  @UseGuards(AclGuard)
  @RequireWorkspaceRole(WorkspaceRole.VIEWER)
  listMembers(@Param('id', ParseUUIDPipe) id: string) {
    return this.workspaces.listMembers(id);
  }

  @Post(':id/members')
  @UseGuards(AclGuard)
  @RequireWorkspaceRole(WorkspaceRole.OWNER)
  async addMember(
    @CurrentUser() user: AuthUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: AddMemberDto,
  ) {
    const result = await this.workspaces.addMember(id, dto.user_id, dto.role);
    this.audit.record({
      userId: user.userId,
      action: 'member_grant',
      resourceType: 'workspace',
      resourceId: id,
      detail: { target_user_id: dto.user_id, role: dto.role },
    });
    return result;
  }

  @Patch(':id/members/:userId')
  @UseGuards(AclGuard)
  @RequireWorkspaceRole(WorkspaceRole.OWNER)
  async updateMember(
    @CurrentUser() user: AuthUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Param('userId', ParseUUIDPipe) userId: string,
    @Body() dto: UpdateMemberDto,
  ) {
    const result = await this.workspaces.updateMember(id, userId, dto.role);
    this.audit.record({
      userId: user.userId,
      action: 'member_update',
      resourceType: 'workspace',
      resourceId: id,
      detail: { target_user_id: userId, role: dto.role },
    });
    return result;
  }

  @Delete(':id/members/:userId')
  @UseGuards(AclGuard)
  @RequireWorkspaceRole(WorkspaceRole.OWNER)
  async removeMember(
    @CurrentUser() user: AuthUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Param('userId', ParseUUIDPipe) userId: string,
  ) {
    const result = await this.workspaces.removeMember(id, userId);
    this.audit.record({
      userId: user.userId,
      action: 'member_revoke',
      resourceType: 'workspace',
      resourceId: id,
      detail: { target_user_id: userId },
    });
    return result;
  }
}
