import { Controller, Get, Param, ParseUUIDPipe, Post, Query, UseGuards } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { ErrorCode, WorkspaceRole } from '@ekh/shared';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { AdminGuard } from '../../common/guards/admin.guard';
import { AclGuard, RequireWorkspaceRole } from '../workspaces/guards/acl.guard';
import { CurrentUser, type AuthUser } from '../../common/decorators/current-user.decorator';
import { BizException } from '../../common/filters/http-exception.filter';
import { AuditService } from '../audit/audit.service';
import { FeatureFlagsService } from '../features/feature-flags.service';
import { GraphService } from './graph.service';
import { GraphExplorerService } from './graph-explorer.service';

const clampInt = (raw: unknown, fallback: number, min: number, max: number) => {
  const n = Number(raw);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(Math.max(Math.trunc(n), min), max);
};

/**
 * 知识图谱查询接口：AclGuard 按路径 workspaceId 校验空间成员（sysadmin 放行）。
 * 查询类接口受 graph_explorer 开关约束；重建是管理动作，不受开关影响。
 */
@ApiTags('graph')
@UseGuards(JwtAuthGuard, AclGuard)
@Controller({ path: 'workspaces/:workspaceId/graph', version: '1' })
export class GraphController {
  constructor(
    private readonly graph: GraphService,
    private readonly explorer: GraphExplorerService,
    private readonly features: FeatureFlagsService,
    private readonly audit: AuditService,
  ) {}

  private async assertExplorerEnabled() {
    if (!(await this.features.isEnabled('graph_explorer'))) {
      throw new BizException(ErrorCode.FEATURE_DISABLED, '知识图谱功能已下架', 403);
    }
  }

  @Get('overview')
  @RequireWorkspaceRole(WorkspaceRole.VIEWER)
  async overview(
    @Param('workspaceId', ParseUUIDPipe) workspaceId: string,
    @Query('limit') limit?: string,
    @Query('types') types?: string,
  ) {
    await this.assertExplorerEnabled();
    const typeList = (types ?? '').split(',').map((t) => t.trim()).filter(Boolean);
    return this.graph.overview(workspaceId, clampInt(limit, 150, 10, 400), typeList);
  }

  @Get('search')
  @RequireWorkspaceRole(WorkspaceRole.VIEWER)
  async search(@Param('workspaceId', ParseUUIDPipe) workspaceId: string, @Query('q') q?: string) {
    await this.assertExplorerEnabled();
    return { items: await this.graph.searchEntities(workspaceId, q ?? '', 20) };
  }

  @Get('stats')
  @RequireWorkspaceRole(WorkspaceRole.VIEWER)
  async stats(@Param('workspaceId', ParseUUIDPipe) workspaceId: string) {
    await this.assertExplorerEnabled();
    return this.graph.stats(workspaceId);
  }

  @Get('entities/:entityId')
  @RequireWorkspaceRole(WorkspaceRole.VIEWER)
  async entity(
    @Param('workspaceId', ParseUUIDPipe) workspaceId: string,
    @Param('entityId', ParseUUIDPipe) entityId: string,
  ) {
    await this.assertExplorerEnabled();
    return this.explorer.entityDetail(workspaceId, entityId);
  }

  @Get('entities/:entityId/neighbors')
  @RequireWorkspaceRole(WorkspaceRole.VIEWER)
  async neighbors(
    @Param('workspaceId', ParseUUIDPipe) workspaceId: string,
    @Param('entityId', ParseUUIDPipe) entityId: string,
    @Query('hops') hops?: string,
  ) {
    await this.assertExplorerEnabled();
    return this.graph.neighborhood(workspaceId, entityId, clampInt(hops, 1, 1, 2));
  }

  @Get('documents/:documentId')
  @RequireWorkspaceRole(WorkspaceRole.VIEWER)
  async document(
    @Param('workspaceId', ParseUUIDPipe) workspaceId: string,
    @Param('documentId', ParseUUIDPipe) documentId: string,
  ) {
    await this.assertExplorerEnabled();
    return this.graph.documentSubgraph(workspaceId, documentId);
  }

  /** 空间 owner 重建本空间图谱：清空后全部 READY 文档重跑抽取 + 对齐 */
  @Post('rebuild')
  @RequireWorkspaceRole(WorkspaceRole.OWNER)
  async rebuild(@CurrentUser() user: AuthUser, @Param('workspaceId', ParseUUIDPipe) workspaceId: string) {
    const result = await this.explorer.rebuildWorkspace(workspaceId);
    this.audit.record({
      userId: user.userId,
      action: 'graph_rebuild',
      resourceType: 'workspace',
      resourceId: workspaceId,
      detail: result,
    });
    return result;
  }
}

/** 系统管理员：全量清空 Neo4j 并对所有文档重建图谱 */
@ApiTags('admin')
@UseGuards(JwtAuthGuard, AdminGuard)
@Controller({ path: 'admin/graph', version: '1' })
export class GraphAdminController {
  constructor(
    private readonly explorer: GraphExplorerService,
    private readonly audit: AuditService,
  ) {}

  @Post('rebuild-all')
  async rebuildAll(@CurrentUser() user: AuthUser) {
    const result = await this.explorer.rebuildAll();
    this.audit.record({
      userId: user.userId,
      action: 'graph_rebuild_all',
      resourceType: 'graph',
      detail: result,
    });
    return result;
  }
}
