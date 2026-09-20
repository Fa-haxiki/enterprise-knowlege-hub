import type { AgentIntent, Complexity, EvidenceGrade, ToolName } from './enums';

/** 引用分片（SSE citation 帧 + messages.citations 落库结构） */
export interface Citation {
  ref_id: number;
  chunk_id: string;
  document_id: string;
  title: string;
  page?: number;
  snippet: string;
  score?: number;
  /** 缺省为内部知识库；联网结果带 url */
  source?: 'kb' | 'web';
  url?: string;
}

/** 节点耗时（循环下同名节点可出现多次） */
export interface NodeLatency {
  name: string;
  latencyMs: number;
  iteration: number;
  degraded: boolean;
}

/** 工具调用痕迹 */
export interface ToolTrace {
  name: ToolName | string;
  args?: Record<string, unknown>;
  summary?: string;
  latencyMs: number;
  iteration: number;
  degraded?: boolean;
}

export type { AgentIntent, EvidenceGrade, ToolName };

/** 图谱推理三元组 */
export type Triple = [string, string, string];

/** SSE 事件类型 */
export enum SseEvent {
  META = 'meta',
  STATUS = 'status',
  TOKEN = 'token',
  CITATION = 'citation',
  GRAPH_PATH = 'graph_path',
  USAGE = 'usage',
  ERROR = 'error',
  DONE = 'done',
}

export interface SseMetaPayload {
  conversation_id: string;
  message_id: string;
  complexity: Complexity;
  trace_id?: string;
}

export interface SseStatusPayload {
  stage: 'retrieval' | 'rerank' | 'graph' | 'memory' | 'generate' | 'intent' | 'evaluate' | 'tool' | 'think';
  detail: string;
}

export interface SseUsagePayload {
  prompt_tokens: number;
  completion_tokens: number;
  latency_ms: number;
  /** 兼容旧前端：同名取最后一次 */
  node_latencies: Record<string, number>;
  degraded: string[];
  intent?: AgentIntent;
  thinking?: string;
}

export interface SseTokenPayload {
  delta: string;
}

export interface SseErrorPayload {
  code: number;
  message: string;
}

export interface SseGraphPathPayload {
  triples: Triple[];
}

/** 问答请求体 */
export interface ChatCompletionRequest {
  conversation_id?: string;
  workspace_id?: string;
  query: string;
  options?: {
    enable_graph?: boolean;
    enable_tts?: boolean;
    model?: string;
  };
}

/** 召回分片（检索层内部结构） */
export interface ChunkHit {
  chunk_id: string;
  document_id: string;
  workspace_id: string;
  title: string;
  content: string;
  page?: number;
  heading_path: string[];
  /** 各路召回的原始分（ES BM25 / 向量余弦） */
  raw_score?: number;
  /** RRF 融合分 */
  rrf_score?: number;
  /** Reranker 分 */
  rerank_score?: number;
  /** 是否由图谱实体反查补充（图增强检索） */
  via_graph?: boolean;
}
