import { CallHandler, ExecutionContext, Injectable, Logger, NestInterceptor } from '@nestjs/common';
import type { Request } from 'express';
import { Observable, tap } from 'rxjs';
import { MaskService } from '../../modules/security/mask.service';

/** 请求访问日志：method/path/status/耗时，body 脱敏后仅在非 2xx 时记录 */
@Injectable()
export class LoggingInterceptor implements NestInterceptor {
  private readonly logger = new Logger('HTTP');

  constructor(private readonly mask: MaskService) {}

  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    const req = context.switchToHttp().getRequest<Request & { user?: { userId: string } }>();
    const { method, originalUrl } = req;
    const t0 = Date.now();

    return next.handle().pipe(
      tap({
        next: () => {
          const status = context.switchToHttp().getResponse().statusCode;
          this.logger.log(`${method} ${originalUrl} ${status} ${Date.now() - t0}ms user=${req.user?.userId ?? '-'}`);
        },
        error: (err: Error) => {
          const status = (err as { status?: number }).status ?? 500;
          const safeBody = req.method === 'GET' ? undefined : this.mask.maskObject(req.body);
          this.logger.warn(
            `${method} ${originalUrl} ${status} ${Date.now() - t0}ms user=${req.user?.userId ?? '-'} body=${JSON.stringify(safeBody ?? {})}`,
          );
        },
      }),
    );
  }
}
