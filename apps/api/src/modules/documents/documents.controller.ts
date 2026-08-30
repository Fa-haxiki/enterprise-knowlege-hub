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
import { IsBoolean, IsNotEmpty, IsOptional, IsString, MaxLength } from 'class-validator';
import { WorkspaceRole } from '@ekh/shared';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { CurrentUser, type AuthUser } from '../../common/decorators/current-user.decorator';
import { AclGuard, RequireWorkspaceRole } from '../workspaces/guards/acl.guard';
import { AuditService } from '../audit/audit.service';
import { DocumentsService } from './documents.service';
import { UploadCompleteDto, UploadInitDto } from './dto/document.dto';

class ReviewDocumentDto {
  @IsBoolean()
  approve: boolean;

  @IsOptional()
  @IsString()
  @IsNotEmpty()
  @MaxLength(500)
  reason?: string;
}

@ApiTags('documents')
@UseGuards(JwtAuthGuard)
@Controller({ version: '1' })
export class DocumentsController {
  constructor(
    private readonly documents: DocumentsService,
    private readonly audit: AuditService,
  ) {}

  /** 待审核列表（审核员/sysadmin）；须在 documents/:id 之前注册避免被 :id 吞掉 */
  @Get('documents/pending-review')
  pendingReview(@CurrentUser() user: AuthUser) {
    return this.documents.pendingReviewList(user);
  }

  /** 文档审核：通过入队解析 / 拒绝标记理由（service 内校验审核员权限） */
  @Post('documents/:id/review')
  async review(
    @Param('id', ParseUUIDPipe) id: string,
    @CurrentUser() user: AuthUser,
    @Body() dto: ReviewDocumentDto,
  ) {
    const result = await this.documents.review(user, id, dto.approve, dto.reason);
    this.audit.record({
      userId: user.userId,
      action: 'document_review',
      resourceType: 'document',
      resourceId: id,
      detail: { approve: dto.approve, reason: dto.reason ?? null },
    });
    return result;
  }

  @Post('workspaces/:workspaceId/documents/upload-init')
  @UseGuards(AclGuard)
  @RequireWorkspaceRole(WorkspaceRole.EDITOR)
  async uploadInit(
    @Param('workspaceId', ParseUUIDPipe) workspaceId: string,
    @CurrentUser() user: AuthUser,
    @Body() dto: UploadInitDto,
  ) {
    const result = await this.documents.uploadInit(workspaceId, user.userId, dto.filename, dto.file_size, dto.mime_type);
    this.audit.record({
      userId: user.userId,
      action: 'document_upload',
      resourceType: 'document',
      resourceId: result.document_id,
      detail: { workspace_id: workspaceId, filename: dto.filename, file_size: dto.file_size },
    });
    return result;
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
    return this.documents.assertViewable(user, id).then(() => this.documents.detail(id));
  }

  @Get('documents/:id/download-url')
  downloadUrl(@Param('id', ParseUUIDPipe) id: string, @CurrentUser() user: AuthUser) {
    return this.documents.assertViewable(user, id).then(() => this.documents.downloadUrl(id));
  }

  @Get('documents/:id/progress')
  progress(@Param('id', ParseUUIDPipe) id: string, @CurrentUser() user: AuthUser) {
    return this.documents.assertRole(user.userId, id, WorkspaceRole.VIEWER).then(() =>
      this.documents.progress(id),
    );
  }

  @Post('documents/:id/reindex')
  async reindex(
    @Param('id', ParseUUIDPipe) id: string,
    @CurrentUser() user: AuthUser,
    @Query('from_stage') fromStage?: 'parse' | 'chunk' | 'index' | 'graph',
  ) {
    await this.documents.assertRole(user.userId, id, WorkspaceRole.EDITOR);
    const result = await this.documents.reindex(id, fromStage);
    this.audit.record({
      userId: user.userId,
      action: 'document_reindex',
      resourceType: 'document',
      resourceId: id,
      detail: { from_stage: fromStage ?? 'index' },
    });
    return result;
  }

  @Delete('documents/:id')
  async remove(@Param('id', ParseUUIDPipe) id: string, @CurrentUser() user: AuthUser) {
    await this.documents.assertRole(user.userId, id, WorkspaceRole.EDITOR);
    const result = await this.documents.remove(id);
    this.audit.record({
      userId: user.userId,
      action: 'document_delete',
      resourceType: 'document',
      resourceId: id,
    });
    return result;
  }
}
