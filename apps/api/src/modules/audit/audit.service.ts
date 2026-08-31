import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { AuditLogEntity } from '../../database/entities/audit-log.entity';
import { DocumentEntity } from '../../database/entities/document.entity';
import { MessageEntity } from '../../database/entities/message.entity';

export interface AuditEntry {
  userId?: string | null;
  action: string;
  resourceType?: string;
  resourceId?: string;
  detail?: Record<string, unknown>;
  ip?: string;
}

@Injectable()
export class AuditService {
  private readonly logger = new Logger(AuditService.name);

  constructor(
    @InjectRepository(AuditLogEntity)
    private readonly logs: Repository<AuditLogEntity>,
    @InjectRepository(DocumentEntity)
    private readonly documents: Repository<DocumentEntity>,
    @InjectRepository(MessageEntity)
    private readonly messages: Repository<MessageEntity>,
  ) {}

  /** 异步落审计日志，失败仅告警不阻断业务 */
  record(entry: AuditEntry): void {
    this.logs
      .save(
        this.logs.create({
          userId: entry.userId ?? null,
          action: entry.action,
          resourceType: entry.resourceType ?? null,
          resourceId: entry.resourceId ?? null,
          detail: entry.detail ?? {},
          ip: entry.ip ?? null,
        }),
      )
      .catch((e) => this.logger.warn(`audit write failed: ${(e as Error).message}`));
  }

  async query(filters: { userId?: string; action?: string; from?: Date; to?: Date }, page = 1, pageSize = 50) {
    const qb = this.logs.createQueryBuilder('a').orderBy('a.created_at', 'DESC');
    if (filters.userId) qb.andWhere('a.user_id = :userId', { userId: filters.userId });
    if (filters.action) qb.andWhere('a.action = :action', { action: filters.action });
    if (filters.from) qb.andWhere('a.created_at >= :from', { from: filters.from });
    if (filters.to) qb.andWhere('a.created_at <= :to', { to: filters.to });
    const [items, total] = await qb.skip((page - 1) * pageSize).take(pageSize).getManyAndCount();
    return { total, page, page_size: pageSize, items };
  }

  /** 导出时间范围内审计日志为 CSV（上限 5 万条防内存溢出） */
  async exportCsv(from: Date, to: Date): Promise<string> {
    const items = await this.logs
      .createQueryBuilder('a')
      .where('a.created_at >= :from AND a.created_at < :to', { from, to })
      .orderBy('a.created_at', 'ASC')
      .take(50_000)
      .getMany();

    const esc = (v: unknown) => {
      const s = v == null ? '' : typeof v === 'string' ? v : JSON.stringify(v);
      return `"${s.replace(/"/g, '""')}"`;
    };
    const header = 'created_at,user_id,action,resource_type,resource_id,ip,detail';
    const rows = items.map((a) =>
      [a.createdAt.toISOString(), a.userId, a.action, a.resourceType, a.resourceId, a.ip, a.detail]
        .map(esc)
        .join(','),
    );
    // BOM 保证 Excel 正确识别 UTF-8
    return `﻿${header}\n${rows.join('\n')}\n`;
  }

  /** 运营看板：今日问答/活跃用户/越权次数 + 文档状态分布 + 反馈踩赞 */
  async statsOverview() {
    const today = new Date(new Date().toDateString());

    const [todayChat, todayActiveUsers, todayDenied] = await Promise.all([
      this.logs
        .createQueryBuilder('a')
        .where("a.action = 'chat' AND a.created_at >= :today", { today })
        .getCount(),
      this.logs
        .createQueryBuilder('a')
        .select('COUNT(DISTINCT a.user_id)', 'cnt')
        .where('a.created_at >= :today', { today })
        .getRawOne<{ cnt: string }>()
        .then((r) => Number(r?.cnt ?? 0)),
      this.logs
        .createQueryBuilder('a')
        .where("a.action = 'acl_denied' AND a.created_at >= :today", { today })
        .getCount(),
    ]);

    const docByStatus = await this.documents
      .createQueryBuilder('d')
      .select('d.status', 'status')
      .addSelect('COUNT(*)', 'cnt')
      .where('d.deleted_at IS NULL')
      .groupBy('d.status')
      .getRawMany<{ status: string; cnt: string }>();

    const feedback = await this.messages
      .createQueryBuilder('m')
      .select('m.feedback', 'feedback')
      .addSelect('COUNT(*)', 'cnt')
      .where('m.feedback IS NOT NULL')
      .groupBy('m.feedback')
      .getRawMany<{ feedback: number; cnt: string }>();

    const fbMap = new Map(feedback.map((f) => [Number(f.feedback), Number(f.cnt)]));
    const up = fbMap.get(1) ?? 0;
    const down = fbMap.get(-1) ?? 0;

    return {
      today: {
        chat_count: todayChat,
        active_users: todayActiveUsers,
        acl_denied_count: todayDenied,
      },
      documents: {
        total: docByStatus.reduce((s, d) => s + Number(d.cnt), 0),
        by_status: Object.fromEntries(docByStatus.map((d) => [d.status, Number(d.cnt)])),
      },
      feedback: {
        up,
        down,
        up_ratio: up + down > 0 ? Number((up / (up + down)).toFixed(3)) : null,
      },
    };
  }
}
