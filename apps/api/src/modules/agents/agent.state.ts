import { Annotation } from '@langchain/langgraph';
import type { BaseMessage } from '@langchain/core/messages';
import type { ChunkHit, Citation, Complexity, Triple } from '@ekh/shared';
import type { WindowMessage } from '../memory/memory.service';

/** LangGraph 全局状态：贯穿问答全链路 0-9 步 */
export const AgentStateAnnotation = Annotation.Root({
  // ---- 输入 ----
  query: Annotation<string>,
  userId: Annotation<string>,
  conversationId: Annotation<string>,
  workspaceId: Annotation<string | undefined>,
  enableGraph: Annotation<boolean>,

  // ---- 运行时 ----
  aclWhitelist: Annotation<string[]>({ reducer: (_a, b) => b, default: () => [] }),
  windowMessages: Annotation<WindowMessage[]>({ reducer: (_a, b) => b, default: () => [] }),
  rollingSummary: Annotation<string>({ reducer: (_a, b) => b, default: () => '' }),
  rewrittenQuery: Annotation<string>({ reducer: (_a, b) => b, default: () => '' }),
  complexity: Annotation<Complexity>,
  routerEntities: Annotation<{ name: string; type: string }[]>({
    reducer: (_a, b) => b,
    default: () => [],
  }),
  rerankedChunks: Annotation<ChunkHit[]>({ reducer: (_a, b) => b, default: () => [] }),
  graphTriples: Annotation<Triple[]>({ reducer: (_a, b) => b, default: () => [] }),
  longTermMemories: Annotation<string[]>({ reducer: (_a, b) => b, default: () => [] }),
  /** prompt_build 组装的消息序列（节点间必须通过 state 传递，config 不可共享可变状态） */
  promptMessages: Annotation<BaseMessage[]>({ reducer: (_a, b) => b, default: () => [] }),
  answer: Annotation<string>({ reducer: (_a, b) => b, default: () => '' }),
  citations: Annotation<Citation[]>({ reducer: (_a, b) => b, default: () => [] }),
  usage: Annotation<{ prompt_tokens: number; completion_tokens: number }>({
    reducer: (_a, b) => b,
    default: () => ({ prompt_tokens: 0, completion_tokens: 0 }),
  }),

  // ---- 观测 ----
  nodeLatencies: Annotation<Record<string, number>>({
    reducer: (a, b) => ({ ...a, ...b }),
    default: () => ({}),
  }),
  degraded: Annotation<string[]>({
    reducer: (a, b) => [...a, ...b],
    default: () => [],
  }),
});

export type AgentState = typeof AgentStateAnnotation.State;

/** SSE 推送回调，由 chat 层注入 */
export interface AgentCallbacks {
  onStatus(stage: string, detail: string): void;
  onToken(delta: string): void;
  onCitation(citation: Citation): void;
  onGraphPath(triples: Triple[]): void;
}
