import type { ChunkHit } from '@ekh/shared';

/** 结果级 ACL：白名单外 workspace 的分片不得进入工具返回 / Prompt */
export function filterChunksByAcl(chunks: ChunkHit[], whitelist: string[]): ChunkHit[] {
  const allowed = new Set(whitelist);
  return chunks.filter((c) => allowed.has(c.workspace_id));
}
