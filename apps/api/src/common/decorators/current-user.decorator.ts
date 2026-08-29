import { createParamDecorator, ExecutionContext } from '@nestjs/common';
import { SystemRole } from '@ekh/shared';

export interface AuthUser {
  userId: string;
  email: string;
  role: SystemRole;
}

export const CurrentUser = createParamDecorator(
  (_data: unknown, ctx: ExecutionContext): AuthUser => {
    const request = ctx.switchToHttp().getRequest();
    return request.user;
  },
);
