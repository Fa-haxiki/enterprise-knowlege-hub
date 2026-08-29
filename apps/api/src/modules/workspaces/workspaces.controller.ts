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
  constructor(private readonly workspaces: WorkspacesService) {}

  @Get()
  list(@CurrentUser() user: AuthUser) {
    return this.workspaces.listMine(user.userId);
  }

  @Post()
  create(@CurrentUser() user: AuthUser, @Body() dto: CreateWorkspaceDto) {
    return this.workspaces.create(user.userId, dto.name, dto.description);
  }

  @Patch(':id')
  @UseGuards(AclGuard)
  @RequireWorkspaceRole(WorkspaceRole.OWNER)
  update(@Param('id', ParseUUIDPipe) id: string, @Body() dto: UpdateWorkspaceDto) {
    return this.workspaces.update(id, dto);
  }

  @Delete(':id')
  @UseGuards(AclGuard)
  @RequireWorkspaceRole(WorkspaceRole.OWNER)
  remove(@Param('id', ParseUUIDPipe) id: string) {
    return this.workspaces.remove(id);
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
  addMember(@Param('id', ParseUUIDPipe) id: string, @Body() dto: AddMemberDto) {
    return this.workspaces.addMember(id, dto.user_id, dto.role);
  }

  @Patch(':id/members/:userId')
  @UseGuards(AclGuard)
  @RequireWorkspaceRole(WorkspaceRole.OWNER)
  updateMember(
    @Param('id', ParseUUIDPipe) id: string,
    @Param('userId', ParseUUIDPipe) userId: string,
    @Body() dto: UpdateMemberDto,
  ) {
    return this.workspaces.updateMember(id, userId, dto.role);
  }

  @Delete(':id/members/:userId')
  @UseGuards(AclGuard)
  @RequireWorkspaceRole(WorkspaceRole.OWNER)
  removeMember(
    @Param('id', ParseUUIDPipe) id: string,
    @Param('userId', ParseUUIDPipe) userId: string,
  ) {
    return this.workspaces.removeMember(id, userId);
  }
}
