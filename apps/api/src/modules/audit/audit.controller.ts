import { Controller, Get, Query, Res, UseGuards } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import type { Response } from 'express';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { AdminGuard } from '../../common/guards/admin.guard';
import { AuditService } from './audit.service';

@ApiTags('audit')
@UseGuards(JwtAuthGuard, AdminGuard)
@Controller({ version: '1' })
export class AuditController {
  constructor(private readonly audit: AuditService) {}

  /** 审计日志查询：按用户/动作/时间范围过滤 */
  @Get('audit-logs')
  query(
    @Query('user_id') userId?: string,
    @Query('action') action?: string,
    @Query('from') from?: string,
    @Query('to') to?: string,
    @Query('page') page = 1,
    @Query('page_size') pageSize = 50,
  ) {
    return this.audit.query(
      {
        userId,
        action,
        from: from ? new Date(from) : undefined,
        to: to ? new Date(to) : undefined,
      },
      Number(page),
      Math.min(Number(pageSize), 200),
    );
  }

  /** 审计日志 CSV 导出（默认导出当日） */
  @Get('audit-logs/export')
  async exportCsv(@Res() res: Response, @Query('from') from?: string, @Query('to') to?: string) {
    const fromDate = from ? new Date(from) : new Date(new Date().toDateString());
    const toDate = to ? new Date(to) : new Date(fromDate.getTime() + 24 * 3600 * 1000);
    const csv = await this.audit.exportCsv(fromDate, toDate);
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader(
      'Content-Disposition',
      `attachment; filename="audit-${fromDate.toISOString().slice(0, 10)}.csv"`,
    );
    res.send(csv);
  }

  /** 运营看板概览统计 */
  @Get('admin/stats/overview')
  statsOverview() {
    return this.audit.statsOverview();
  }
}
