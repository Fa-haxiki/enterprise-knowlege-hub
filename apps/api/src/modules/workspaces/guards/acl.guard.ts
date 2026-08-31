import { CanActivate, ExecutionContext, Injectable, SetMetadata } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { Request } from 'express';
import { ErrorCode, SystemRole, WorkspaceRole } from '@ekh/shared';
import { BizException } from '../../../common/filters/http-exception.filter';
import type { AuthUser } from '../../../common/decorators/current-user.decorator';
import { AclService } from '../acl.service';
import { AclAlertService } from '../../audit/acl-alert.service';

export const REQUIRED_ROLE_KEY = 'requiredWorkspaceRole';

/** 标注接口所需的最低空间角色 */
export const RequireWorkspaceRole = (role: WorkspaceRole) =>
  SetMetadata(REQUIRED_ROLE_KEY, role);

const ROLE_RANK: Record<WorkspaceRole, number> = {
  [WorkspaceRole.VIEWER]: 1,
  [WorkspaceRole.EDITOR]: 2,
  [WorkspaceRole.OWNER]: 3,
};

/**
 * 空间级 ACL 守卫：从路径参数 workspaceId / id 取空间，
 * 校验当前用户角色是否满足最低要求。sysadmin 放行（操作仍落审计）。
 */
@Injectable()
export class AclGuard implements CanActivate {
  constructor(
    private readonly acl: AclService,
    private readonly reflector: Reflector,
    private readonly alert: AclAlertService,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const req = context
      .switchToHttp()
      .getRequest<Request & { user: AuthUser; memberRole?: WorkspaceRole }>();
    const user = req.user;
    if (!user) throw new BizException(ErrorCode.TOKEN_INVALID, '未认证', 401);
    if (user.role === SystemRole.SYSADMIN) return true;

    const workspaceId =
      (req.params as Record<string, string>).workspaceId ??
      (req.params as Record<string, string>).id;
    if (!workspaceId) return true; // 非空间资源接口由业务层自行校验

    const role = await this.acl.getRole(user.userId, workspaceId);
    if (!role) {
      await this.alert.trackDenied({
        userId: user.userId,
        ip: req.ip,
        resource: 'workspace',
        detail: { workspace_id: workspaceId, path: req.path, reason: 'not_member' },
      });
      throw new BizException(ErrorCode.ACL_FORBIDDEN, '无该知识空间访问权限', 403);
    }

    const required = this.reflector.getAllAndOverride<WorkspaceRole>(REQUIRED_ROLE_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (required && ROLE_RANK[role] < ROLE_RANK[required]) {
      await this.alert.trackDenied({
        userId: user.userId,
        ip: req.ip,
        resource: 'workspace',
        detail: { workspace_id: workspaceId, path: req.path, role, required },
      });
      throw new BizException(ErrorCode.ACL_FORBIDDEN, '当前角色无权执行此操作', 403);
    }

    req.memberRole = role;
    return true;
  }
}
