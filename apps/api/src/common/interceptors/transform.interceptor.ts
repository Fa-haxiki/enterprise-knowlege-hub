import {
  CallHandler,
  ExecutionContext,
  Injectable,
  NestInterceptor,
} from '@nestjs/common';
import { Observable, map } from 'rxjs';
import { v4 as uuid } from 'uuid';
import type { Request } from 'express';

/** SSE / 流式端点不包裹统一响应包 */
const RAW_PATHS = ['/api/v1/chat/completions'];

@Injectable()
export class TransformInterceptor implements NestInterceptor {
  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    const req = context.switchToHttp().getRequest<Request>();
    if (RAW_PATHS.some((p) => req.path.startsWith(p))) {
      return next.handle();
    }
    const requestId = uuid();
    return next.handle().pipe(
      map((data) => ({ code: 0, data: data ?? null, request_id: requestId })),
    );
  }
}
