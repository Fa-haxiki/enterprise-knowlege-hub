import { Injectable, Logger } from '@nestjs/common';
import { RedisService } from '../../redis/redis.service';
import { AuditService } from './audit.service';

const WINDOW_SECONDS = 3600;
const ALERT_THRESHOLD = 10;

/** 越权访问追踪：每次 403 落审计，滑动窗口内超阈值触发告警 */
@Injectable()
export class AclAlertService {
  private readonly logger = new Logger(AclAlertService.name);

  constructor(
    private readonly audit: AuditService,
    private readonly redis: RedisService,
  ) {}

  async trackDenied(args: {
    userId: string;
    ip?: string;
    resource: string;
    detail?: Record<string, unknown>;
  }): Promise<void> {
    this.audit.record({
      userId: args.userId,
      action: 'acl_denied',
      resourceType: args.resource,
      detail: args.detail,
      ip: args.ip,
    });

    const key = `acl:denied:${args.userId}`;
    const count = await this.redis.raw.incr(key);
    if (count === 1) await this.redis.raw.expire(key, WINDOW_SECONDS);
    if (count === ALERT_THRESHOLD) {
      this.logger.warn(
        `[越权告警] 用户 ${args.userId} 1 小时内越权访问达 ${count} 次，IP ${args.ip ?? 'unknown'}，资源 ${args.resource}`,
      );
      this.audit.record({
        userId: args.userId,
        action: 'acl_alert',
        resourceType: args.resource,
        detail: { count, window_seconds: WINDOW_SECONDS },
        ip: args.ip,
      });
    }
  }
}
