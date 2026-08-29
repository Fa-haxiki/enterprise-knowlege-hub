import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { AuditLogEntity } from '../../database/entities/audit-log.entity';

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
}
