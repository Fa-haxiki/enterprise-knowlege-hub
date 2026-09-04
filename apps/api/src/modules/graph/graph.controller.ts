import { Controller, Get, Param, ParseUUIDPipe, Query, UseGuards } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { WorkspaceRole } from '@ekh/shared';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { AclGuard, RequireWorkspaceRole } from '../workspaces/guards/acl.guard';
import { GraphQueryDto, GraphSearchDto } from './dto/graph-query.dto';
import { GraphService } from './graph.service';

/**
 * 空间级图谱查询：只返回该 workspace 的子图，禁止跨空间聚合。
 * 单独成模块挂到 API 进程，避免 Worker 引用带 swagger 的 Controller。
 */
@ApiTags('graph')
@UseGuards(JwtAuthGuard, AclGuard)
@RequireWorkspaceRole(WorkspaceRole.VIEWER)
@Controller({ path: 'workspaces/:workspaceId/graph', version: '1' })
export class GraphController {
  constructor(private readonly graph: GraphService) {}

  @Get('nodes')
  async listNodes(
    @Param('workspaceId', ParseUUIDPipe) workspaceId: string,
    @Query() query: GraphQueryDto,
  ) {
    const items = await this.graph.listNodes(workspaceId, query.type, query.limit ?? 200);
    return { items };
  }

  @Get('edges')
  async listEdges(
    @Param('workspaceId', ParseUUIDPipe) workspaceId: string,
    @Query() query: GraphQueryDto,
  ) {
    const items = await this.graph.listEdges(workspaceId, query.limit ?? 500);
    return { items };
  }

  @Get('search')
  async search(
    @Param('workspaceId', ParseUUIDPipe) workspaceId: string,
    @Query() query: GraphSearchDto,
  ) {
    const items = await this.graph.searchGraph(workspaceId, query.keyword, query.limit ?? 50);
    return { items };
  }
}
