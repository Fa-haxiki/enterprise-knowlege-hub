import { filterChunksByAcl, whitelistScope, type AclScope } from './agent-acl';
import type { ChunkHit } from '@ekh/shared';

function hit(workspace_id: string, chunk_id: string, company_public = false): ChunkHit {
  return {
    chunk_id,
    document_id: `d-${chunk_id}`,
    workspace_id,
    title: 't',
    content: 'secret',
    heading_path: [],
    company_public,
  };
}

function scope(workspaceIds: string[], extra?: Partial<AclScope>): AclScope {
  return { ...whitelistScope(workspaceIds), ...extra };
}

describe('filterChunksByAcl', () => {
  it('白名单外 workspace 的 chunk 不得出现', () => {
    const out = filterChunksByAcl(
      [hit('ws-a', '1'), hit('ws-b', '2'), hit('ws-a', '3')],
      scope(['ws-a']),
    );
    expect(out.map((c) => c.chunk_id)).toEqual(['1', '3']);
    expect(out.every((c) => c.workspace_id === 'ws-a')).toBe(true);
  });

  it('白名单为空则全部剔除', () => {
    expect(filterChunksByAcl([hit('ws-a', '1')], scope([]))).toEqual([]);
  });

  it('未选空间时，已发布分片即使不在白名单也保留', () => {
    const out = filterChunksByAcl(
      [hit('ws-a', '1'), hit('ws-b', '9', true)],
      scope([], { includeCompanyPublic: true }),
    );
    expect(out.map((c) => c.chunk_id)).toEqual(['9']);
  });

  it('只看公共空间时丢掉未发布分片', () => {
    const out = filterChunksByAcl(
      [hit('ws-a', '1', true), hit('ws-b', '2')],
      scope(['ws-a'], { companyPublicOnly: true }),
    );
    expect(out.map((c) => c.chunk_id)).toEqual(['1']);
  });
});
