import { Controller, Get, Query, UseGuards } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { CurrentUser, type AuthUser } from '../../common/decorators/current-user.decorator';
import { BizException } from '../../common/filters/http-exception.filter';
import { ErrorCode } from '@ekh/shared';
import { AclService } from '../workspaces/acl.service';
import { EsService } from './es.service';
import type { AclScope } from '../agents/agent-acl';

/**
 * 文档关键词搜索（召回测试）：ES BM25 + 高亮片段。
 * 只搜用户可见空间（ACL 白名单）以及已发布到公司的文档；ES 中仅有已完成索引的文档，天然过滤待审/处理中数据。
 */
@ApiTags('search')
@UseGuards(JwtAuthGuard)
@Controller({ path: 'search', version: '1' })
export class SearchController {
  constructor(
    private readonly es: EsService,
    private readonly acl: AclService,
  ) {}

  /** 文档类型筛选 → 扩展名集合（ES doc_type 存的是标题扩展名） */
  private static readonly TYPE_EXT: Record<string, string[]> = {
    pdf: ['pdf'],
    word: ['doc', 'docx'],
    excel: ['xls', 'xlsx', 'csv'],
    ppt: ['ppt', 'pptx'],
    md: ['md', 'markdown'],
    txt: ['txt'],
    html: ['html', 'htm'],
  };

  @Get('chunks')
  async searchChunks(
    @CurrentUser() user: AuthUser,
    @Query('q') q?: string,
    @Query('workspace_id') workspaceId?: string,
    @Query('type') type?: string,
    @Query('date_from') dateFrom?: string,
    @Query('date_to') dateTo?: string,
    @Query('limit') limit?: string,
  ) {
    const query = (q ?? '').trim();
    if (!query) return { total: 0, items: [] };
    if (query.length > 200) {
      throw new BizException(ErrorCode.PARAM_INVALID, '关键词长度超出限制', 400);
    }

    const scope = await this.searchScope(user.userId, workspaceId);
    // 指定了无权的部门空间时直接空结果；公共空间或未选空间仍可搜已发布文档
    if (!scope.companyPublicOnly && !scope.includeCompanyPublic && scope.workspaceIds.length === 0) {
      return { total: 0, items: [] };
    }

    const topK = Math.min(20, Math.max(1, parseInt(limit ?? '10', 10) || 10));
    const items = await this.es.searchWithHighlight(query, scope, topK, {
      docTypes: type ? SearchController.TYPE_EXT[type] : undefined,
      // 按本地时区解析日期边界（含结束当天），转 UTC ISO 供 ES range 查询
      dateFrom: dateFrom ? new Date(`${dateFrom}T00:00:00`).toISOString() : undefined,
      dateTo: dateTo ? new Date(`${dateTo}T23:59:59.999`).toISOString() : undefined,
    });
    return { total: items.length, items };
  }

  /**
   * 未选空间：白名单 ∪ 已发布。
   * 选了公共空间：只要已发布（分片上的 workspace_id 仍是部门空间）。
   * 选了部门空间：仅该空间，且必须在白名单内。
   */
  private async searchScope(userId: string, workspaceId?: string): Promise<AclScope> {
    if (workspaceId && (await this.acl.isCompanyWorkspace(workspaceId))) {
      return { workspaceIds: [], includeCompanyPublic: false, companyPublicOnly: true };
    }
    const whitelist = await this.acl.getWhitelist(userId);
    if (workspaceId) {
      return {
        workspaceIds: whitelist.includes(workspaceId) ? [workspaceId] : [],
        includeCompanyPublic: false,
        companyPublicOnly: false,
      };
    }
    return { workspaceIds: whitelist, includeCompanyPublic: true, companyPublicOnly: false };
  }
}
