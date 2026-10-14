import type { ChunkHit } from '@ekh/shared';

/** 一次召回的权限范围：部门空间白名单，以及是否并上/只要公司已发布文档 */
export interface AclScope {
  workspaceIds: string[];
  includeCompanyPublic: boolean;
  companyPublicOnly: boolean;
}

/** 图谱仍只走部门空间，不把已发布文档的实体图开放给全员 */
export function whitelistScope(workspaceIds: string[]): AclScope {
  return { workspaceIds, includeCompanyPublic: false, companyPublicOnly: false };
}

/**
 * 结果级 ACL：白名单外、且未发布到公司的分片不得进入工具返回 / Prompt。
 * companyPublicOnly 时只留已发布分片（会话绑在公共空间）。
 */
export function filterChunksByAcl(chunks: ChunkHit[], scope: AclScope): ChunkHit[] {
  if (scope.companyPublicOnly) return chunks.filter((c) => c.company_public === true);
  const allowed = new Set(scope.workspaceIds);
  return chunks.filter(
    (c) => allowed.has(c.workspace_id) || (scope.includeCompanyPublic && c.company_public === true),
  );
}
