import type { AgentStep, Citation, Triple, UsageInfo } from '@/lib/agui';

export type { AgentStep, Citation, Triple, UsageInfo };

export interface Message {
  /** 渲染 key：流式期间为本地 tmp id，完成后保持不变，避免 React 重挂载闪烁 */
  id: string;
  /** 服务端消息 id（流式完成后由 RUN_FINISHED 带出），反馈等 API 使用 */
  serverId?: string;
  role: 'user' | 'assistant';
  content: string;
  citations?: Citation[];
  feedback?: number;
  streaming?: boolean;
  steps?: AgentStep[];
  triples?: Triple[];
  complexity?: 'simple' | 'complex' | null;
  /** 完成后由 usage 事件 / 历史接口带出：各节点耗时与降级节点（与消息实体一致的 camelCase） */
  nodeLatencies?: Record<string, number> | null;
  degradedNodes?: string[];
  usage?: { prompt_tokens?: number; completion_tokens?: number };
  latencyMs?: number | null;
}

export interface Conversation {
  id: string;
  title: string;
  updated_at: string;
}

/** LangGraph 节点 → 步骤条中文标签 */
export const STEP_LABELS: Record<string, string> = {
  acl_guard: '权限校验',
  load_window: '加载对话',
  query_rewrite: '问题改写',
  complexity_router: '复杂度判断',
  hybrid_retrieve: '混合检索',
  memory_load: '记忆加载',
  prompt_build: '构建提示词',
  llm_generate: '生成回答',
};

/** 节点实际执行顺序：node_latencies 由 state 合并而来 key 顺序不可靠，历史回放按此排序 */
export const STEP_ORDER = [
  'acl_guard',
  'load_window',
  'query_rewrite',
  'complexity_router',
  'hybrid_retrieve',
  'memory_load',
  'prompt_build',
  'llm_generate',
];

/** 与后端 splitSentences 保持一致的切分（保留供后续按句高亮等场景复用） */
export function splitSentences(text: string): string[] {
  const raw = text.match(/[^。！？!?；;\n]+[。！？!?；;\n]?/g) ?? [];
  const sentences: string[] = [];
  for (const piece of raw.map((s) => s.trim()).filter(Boolean)) {
    const last = sentences[sentences.length - 1];
    if (last !== undefined && last.length < 6) {
      sentences[sentences.length - 1] = last + piece;
    } else {
      sentences.push(piece);
    }
  }
  return sentences;
}
