import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  ParseUUIDPipe,
  Post,
  Query,
  UseGuards,
} from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { WorkspaceRole } from '@ekh/shared';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { CurrentUser, type AuthUser } from '../../common/decorators/current-user.decorator';
import { AclGuard, RequireWorkspaceRole } from '../workspaces/guards/acl.guard';
import { DocumentsService } from './documents.service';
import { UploadCompleteDto, UploadInitDto } from './dto/document.dto';

@ApiTags('documents')
@UseGuards(JwtAuthGuard)
@Controller({ version: '1' })
export class DocumentsController {
  constructor(private readonly documents: DocumentsService) {}

  @Post('workspaces/:workspaceId/documents/upload-init')
  @UseGuards(AclGuard)
  @RequireWorkspaceRole(WorkspaceRole.EDITOR)
  uploadInit(
    @Param('workspaceId', ParseUUIDPipe) workspaceId: string,
    @CurrentUser() user: AuthUser,
    @Body() dto: UploadInitDto,
  ) {
    return this.documents.uploadInit(workspaceId, user.userId, dto.filename, dto.file_size, dto.mime_type);
  }

  @Post('documents/:id/upload-complete')
  uploadComplete(
    @Param('id', ParseUUIDPipe) id: string,
    @CurrentUser() user: AuthUser,
    @Body() dto: UploadCompleteDto,
  ) {
    return this.documents.assertRole(user.userId, id, WorkspaceRole.EDITOR).then(() =>
      this.documents.uploadComplete(id, dto.upload_id, dto.part_count),
    );
  }

  @Get('workspaces/:workspaceId/documents')
  @UseGuards(AclGuard)
  @RequireWorkspaceRole(WorkspaceRole.VIEWER)
  list(
    @Param('workspaceId', ParseUUIDPipe) workspaceId: string,
    @Query('page') page = 1,
    @Query('page_size') pageSize = 20,
  ) {
    return this.documents.list(workspaceId, Number(page), Number(pageSize));
  }

  @Get('documents/:id')
  detail(@Param('id', ParseUUIDPipe) id: string, @CurrentUser() user: AuthUser) {
    return this.documents.assertRole(user.userId, id, WorkspaceRole.VIEWER).then(() =>
      this.documents.detail(id),
    );
  }

  @Get('documents/:id/download-url')
  downloadUrl(@Param('id', ParseUUIDPipe) id: string, @CurrentUser() user: AuthUser) {
    return this.documents.assertRole(user.userId, id, WorkspaceRole.VIEWER).then(() =>
      this.documents.downloadUrl(id),
    );
  }

  @Get('documents/:id/progress')
  progress(@Param('id', ParseUUIDPipe) id: string, @CurrentUser() user: AuthUser) {
    return this.documents.assertRole(user.userId, id, WorkspaceRole.VIEWER).then(() =>
      this.documents.progress(id),
    );
  }

  @Post('documents/:id/reindex')
  reindex(
    @Param('id', ParseUUIDPipe) id: string,
    @CurrentUser() user: AuthUser,
    @Query('from_stage') fromStage?: 'parse' | 'chunk' | 'index' | 'graph',
  ) {
    return this.documents.assertRole(user.userId, id, WorkspaceRole.EDITOR).then(() =>
      this.documents.reindex(id, fromStage),
    );
  }

  @Delete('documents/:id')
  remove(@Param('id', ParseUUIDPipe) id: string, @CurrentUser() user: AuthUser) {
    return this.documents.assertRole(user.userId, id, WorkspaceRole.EDITOR).then(() =>
      this.documents.remove(id),
    );
  }
}
