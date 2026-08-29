import {
  ArgumentsHost,
  Catch,
  ExceptionFilter,
  HttpException,
  HttpStatus,
  Logger,
} from '@nestjs/common';
import type { Response } from 'express';
import { ErrorCode } from '@ekh/shared';
import { v4 as uuid } from 'uuid';

export class BizException extends HttpException {
  constructor(
    public readonly bizCode: number,
    message: string,
    httpStatus: HttpStatus = HttpStatus.BAD_REQUEST,
  ) {
    super(message, httpStatus);
  }
}

@Catch()
export class HttpExceptionFilter implements ExceptionFilter {
  private readonly logger = new Logger(HttpExceptionFilter.name);

  catch(exception: unknown, host: ArgumentsHost) {
    const res = host.switchToHttp().getResponse<Response>();
    const requestId = uuid();

    let httpStatus = HttpStatus.INTERNAL_SERVER_ERROR;
    let code: number = ErrorCode.INTERNAL;
    let message = '内部错误';

    if (exception instanceof BizException) {
      httpStatus = exception.getStatus();
      code = exception.bizCode;
      message = exception.message;
    } else if (exception instanceof HttpException) {
      httpStatus = exception.getStatus();
      const body = exception.getResponse();
      const raw =
        typeof body === 'string'
          ? body
          : ((body as { message?: string | string[] }).message ?? exception.message);
      message = Array.isArray(raw) ? raw.join('; ') : raw;
      code = this.mapHttpToBiz(httpStatus);
    } else {
      this.logger.error(
        `unhandled: ${(exception as Error)?.message}`,
        (exception as Error)?.stack,
      );
    }

    res.status(httpStatus).json({ code, message, request_id: requestId });
  }

  private mapHttpToBiz(status: number): number {
    switch (status) {
      case HttpStatus.BAD_REQUEST:
        return ErrorCode.PARAM_INVALID;
      case HttpStatus.UNAUTHORIZED:
        return ErrorCode.TOKEN_INVALID;
      case HttpStatus.FORBIDDEN:
        return ErrorCode.ACL_FORBIDDEN;
      case HttpStatus.NOT_FOUND:
        return ErrorCode.NOT_FOUND;
      case HttpStatus.CONFLICT:
        return ErrorCode.CONFLICT;
      case HttpStatus.TOO_MANY_REQUESTS:
        return ErrorCode.RATE_LIMITED;
      default:
        return ErrorCode.INTERNAL;
    }
  }
}
