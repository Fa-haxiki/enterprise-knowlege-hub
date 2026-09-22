import { Annotation } from '@langchain/langgraph';
import type { BaseMessage } from '@langchain/core/messages';
import {
  AgentIntent,
  EvidenceGrade,
  type ChunkHit,
  type Citation,
  type Complexity,
  type NodeLatency,
  type ToolName,
  type ToolTrace,
  type Triple,
} from '@ekh/shared';
import type { WindowMessage } from '../memory/memory.service';
import type { WebHit } from './tools/web-search.service';

/** LangGraph 全局状态：Agentic RAG 全链路 */
export const AgentStateAnnotation = Annotation.Root({
  query: Annotation<string>,
  userId: Annotation<string>,
  conversationId: Annotation<string>,
  workspaceId: Annotation<string | undefined>,
  enableGraph: Annotation<boolean>,

  aclWhitelist: Annotation<string[]>({ reducer: (_a, b) => b, default: () => [] }),
  windowMessages: Annotation<WindowMessage[]>({ reducer: (_a, b) => b, default: () => [] }),
  rollingSummary: Annotation<string>({ reducer: (_a, b) => b, default: () => '' }),
  rewrittenQuery: Annotation<string>({ reducer: (_a, b) => b, default: () => '' }),
  suggestedQuery: Annotation<string>({ reducer: (_a, b) => b, default: () => '' }),
  intent: Annotation<AgentIntent>({ reducer: (_a, b) => b, default: () => AgentIntent.KB }),
  availableTools: Annotation<ToolName[]>({ reducer: (_a, b) => b, default: () => [] }),
  pendingTools: Annotation<ToolName[]>({ reducer: (_a, b) => b, default: () => [] }),
  complexity: Annotation<Complexity>,
  routerEntities: Annotation<{ name: string; type: string }[]>({
    reducer: (_a, b) => b,
    default: () => [],
  }),
  routerRelations: Annotation<string[]>({ reducer: (_a, b) => b, default: () => [] }),
  rerankedChunks: Annotation<ChunkHit[]>({ reducer: (_a, b) => b, default: () => [] }),
  graphTriples: Annotation<Triple[]>({ reducer: (_a, b) => b, default: () => [] }),
  webHits: Annotation<WebHit[]>({ reducer: (_a, b) => b, default: () => [] }),
  longTermMemories: Annotation<string[]>({ reducer: (_a, b) => b, default: () => [] }),
  iteration: Annotation<number>({ reducer: (_a, b) => b, default: () => 0 }),
  evidenceGrade: Annotation<EvidenceGrade>({
    reducer: (_a, b) => b,
    default: () => EvidenceGrade.SUFFICIENT,
  }),
  evidenceNotes: Annotation<string>({ reducer: (_a, b) => b, default: () => '' }),
  thinking: Annotation<string>({ reducer: (_a, b) => b, default: () => '' }),
  toolTrace: Annotation<ToolTrace[]>({
    reducer: (a, b) => [...a, ...b],
    default: () => [],
  }),
  promptMessages: Annotation<BaseMessage[]>({ reducer: (_a, b) => b, default: () => [] }),
  answer: Annotation<string>({ reducer: (_a, b) => b, default: () => '' }),
  citations: Annotation<Citation[]>({ reducer: (_a, b) => b, default: () => [] }),
  usage: Annotation<{ prompt_tokens: number; completion_tokens: number }>({
    reducer: (_a, b) => b,
    default: () => ({ prompt_tokens: 0, completion_tokens: 0 }),
  }),

  nodeLatencies: Annotation<NodeLatency[]>({
    reducer: (a, b) => [...a, ...b],
    default: () => [],
  }),
  degraded: Annotation<string[]>({
    reducer: (a, b) => [...a, ...b],
    default: () => [],
  }),
});

export type AgentState = typeof AgentStateAnnotation.State;

export interface AgentCallbacks {
  onStatus(stage: string, detail: string): void;
  onToken(delta: string): void;
  onCitation(citation: Citation): void;
  onCitationsReset?(): void;
  onGraphPath(triples: Triple[]): void;
  onStepStart?(node: string): void;
  onStepEnd?(node: string, latencyMs: number, degraded: boolean, output?: Record<string, unknown>): void;
  onIntent?(intent: AgentIntent, suggestedQuery: string): void;
  onToolStart?(name: string, args?: Record<string, unknown>): void;
  onToolEnd?(name: string, summary?: string): void;
  onThinking?(text: string): void;
}
