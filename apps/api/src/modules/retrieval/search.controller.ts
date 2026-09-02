import { Controller, Get, Query, UseGuards } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { CurrentUser, type AuthUser } from '../../common/decorators/current-user.decorator';
import { BizException } from '../../common/filters/http-exception.filter';
import { ErrorCode } from '@ekh/shared';
import { AclService } from '../workspaces/acl.service';
import { EsService } from './es.service';

/**
 * 文档关键词搜索（召回测试）：ES BM25 + 高亮片段。
 * 只搜用户可见空间（ACL 白名单），ES 中仅有已完成索引的文档，天然过滤待审/处理中数据。
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

    let whitelist = await this.acl.getWhitelist(user.userId);
    // 指定空间时收敛到该空间（须本来就在白名单内）
    if (workspaceId) whitelist = whitelist.includes(workspaceId) ? [workspaceId] : [];
    if (whitelist.length === 0) return { total: 0, items: [] };

    const topK = Math.min(20, Math.max(1, parseInt(limit ?? '10', 10) || 10));
    const items = await this.es.searchWithHighlight(query, whitelist, topK, {
      docTypes: type ? SearchController.TYPE_EXT[type] : undefined,
      // 按本地时区解析日期边界（含结束当天），转 UTC ISO 供 ES range 查询
      dateFrom: dateFrom ? new Date(`${dateFrom}T00:00:00`).toISOString() : undefined,
      dateTo: dateTo ? new Date(`${dateTo}T23:59:59.999`).toISOString() : undefined,
    });
    return { total: items.length, items };
  }
}
