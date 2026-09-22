import type { ChunkHit } from '@ekh/shared';
import type { AgentState } from './agent.state';
import type { WebHit } from './tools/web-search.service';

const SNIPPET = 240;

export function compactChunks(chunks: ChunkHit[], limit = 8) {
  return chunks.slice(0, limit).map((c) => ({
    title: c.title,
    page: c.page,
    score: c.rerank_score,
    snippet: (c.content ?? '').slice(0, SNIPPET),
  }));
}

export function compactWebHits(hits: WebHit[], limit = 8) {
  return hits.slice(0, limit).map((h) => ({
    title: h.title,
    url: h.url,
    snippet: (h.snippet ?? '').slice(0, SNIPPET),
  }));
}

/** 给前端时间线 / Langfuse span 用的精简节点输出 */
export function buildNodeOutput(name: string, merged: Partial<AgentState>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  switch (name) {
    case 'query_rewrite':
      if (merged.rewrittenQuery) {
        out.summary = merged.rewrittenQuery;
        out.rewrittenQuery = merged.rewrittenQuery;
      }
      break;
    case 'intent_router':
      out.summary = [merged.intent, merged.suggestedQuery].filter(Boolean).join(' · ');
      out.intent = merged.intent;
      out.suggestedQuery = merged.suggestedQuery;
      out.rewrittenQuery = merged.rewrittenQuery;
      if (merged.routerEntities?.length) out.entities = merged.routerEntities;
      break;
    case 'plan_or_act':
      out.summary = (merged.pendingTools ?? []).join(', ') || '无需工具';
      out.tools = merged.pendingTools;
      break;
    case 'execute_tools':
      out.summary = [
        merged.rerankedChunks?.length ? `知识库 ${merged.rerankedChunks.length} 条` : '',
        merged.webHits?.length ? `联网 ${merged.webHits.length} 条` : '',
        merged.graphTriples?.length ? `图谱 ${merged.graphTriples.length} 条` : '',
      ]
        .filter(Boolean)
        .join(' · ');
      if (merged.rerankedChunks?.length) out.chunks = compactChunks(merged.rerankedChunks);
      if (merged.webHits?.length) out.webHits = compactWebHits(merged.webHits);
      if (merged.graphTriples?.length) out.triples = merged.graphTriples;
      break;
    case 'evaluate':
      out.summary = merged.evidenceNotes || merged.evidenceGrade;
      out.grade = merged.evidenceGrade;
      out.reason = merged.evidenceNotes;
      break;
    case 'rewrite_retrieve':
      out.summary = merged.rewrittenQuery;
      out.rewrittenQuery = merged.rewrittenQuery;
      out.tools = merged.pendingTools;
      break;
    case 'think':
      out.summary = merged.thinking ? '已生成思考' : '跳过思考';
      if (merged.thinking) out.text = merged.thinking;
      break;
    case 'memory_load':
      out.summary = merged.longTermMemories?.length
        ? `${merged.longTermMemories.length} 条记忆`
        : '无长期记忆';
      if (merged.longTermMemories?.length) out.memories = merged.longTermMemories;
      break;
    case 'load_window':
      out.summary = `${merged.windowMessages?.length ?? 0} 条窗口消息`;
      break;
    case 'llm_generate':
      out.summary = merged.answer ? `回答 ${merged.answer.length} 字` : '生成回答';
      break;
    default:
      break;
  }
  return Object.fromEntries(
    Object.entries(out).filter(([, v]) => v !== undefined && v !== ''),
  );
}
