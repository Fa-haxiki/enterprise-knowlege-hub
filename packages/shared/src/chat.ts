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

/** 图谱推理三元组（实体规范名，供 Prompt 拼接与历史回放） */
export type Triple = [string, string, string];

/** 图谱实体类型（与 Neo4j 标签一致的封闭集合） */
export type GraphEntityType = 'Project' | 'Supplier' | 'Person' | 'Policy' | 'Department';

/** 图谱节点：id 为对齐后的稳定实体 id，name 为规范名 */
export interface GraphNode {
  id: string;
  name: string;
  type: GraphEntityType;
  /** 出入度之和（overview / 邻居查询带出，供前端定节点大小） */
  degree?: number;
  aliases?: string[];
  description?: string;
  mention_count?: number;
  /** 问答子图跨空间，节点带所属空间以便前端「在图谱中打开」 */
  workspace_id?: string;
}

/** 图谱边：同一对实体的同类关系按溯源 chunk 聚合，weight = 支撑该关系的分片数 */
export interface GraphEdge {
  source: string;
  target: string;
  relation: string;
  weight?: number;
  confidence?: number;
}

export interface GraphSubgraph {
  nodes: GraphNode[];
  edges: GraphEdge[];
  /** 推理起点实体 id（问答子图中用于高亮） */
  seeds?: string[];
}

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
  /** 带实体 id/类型的推理子图，供前端渲染拓扑并跳转图谱页 */
  subgraph?: GraphSubgraph;
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
