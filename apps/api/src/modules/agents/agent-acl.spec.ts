import { filterChunksByAcl } from './agent-acl';
import type { ChunkHit } from '@ekh/shared';

function hit(workspace_id: string, chunk_id: string): ChunkHit {
  return {
    chunk_id,
    document_id: `d-${chunk_id}`,
    workspace_id,
    title: 't',
    content: 'secret',
    heading_path: [],
  };
}

describe('filterChunksByAcl', () => {
  it('白名单外 workspace 的 chunk 不得出现', () => {
    const out = filterChunksByAcl(
      [hit('ws-a', '1'), hit('ws-b', '2'), hit('ws-a', '3')],
      ['ws-a'],
    );
    expect(out.map((c) => c.chunk_id)).toEqual(['1', '3']);
    expect(out.every((c) => c.workspace_id === 'ws-a')).toBe(true);
  });

  it('白名单为空则全部剔除', () => {
    expect(filterChunksByAcl([hit('ws-a', '1')], [])).toEqual([]);
  });
});
