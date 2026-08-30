import type { Complexity } from './enums';

/** 引用分片（SSE citation 帧 + messages.citations 落库结构） */
export interface Citation {
  ref_id: number;
  chunk_id: string;
  document_id: string;
  title: string;
  page?: number;
  snippet: string;
  score?: number;
}

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
  stage: 'retrieval' | 'rerank' | 'graph' | 'memory' | 'generate';
  detail: string;
}

export interface SseTokenPayload {
  delta: string;
}

export interface SseUsagePayload {
  prompt_tokens: number;
  completion_tokens: number;
  latency_ms: number;
  node_latencies: Record<string, number>;
  degraded: string[];
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
