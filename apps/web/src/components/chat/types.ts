import type { AgentStep, Citation, Triple, UsageInfo } from '@/lib/agui';

export type { AgentStep, Citation, Triple, UsageInfo };

export type AgentIntent = 'chitchat' | 'preference' | 'kb' | 'web' | 'kb_then_web';

export interface ToolCallInfo {
  name: string;
  args?: Record<string, unknown>;
  summary?: string;
  latencyMs?: number;
  iteration?: number;
}

export interface Message {
  id: string;
  serverId?: string;
  role: 'user' | 'assistant';
  content: string;
  citations?: Citation[];
  feedback?: number;
  feedbackComment?: string | null;
  streaming?: boolean;
  steps?: AgentStep[];
  triples?: Triple[];
  complexity?: 'simple' | 'complex' | null;
  intent?: AgentIntent | null;
  suggestedQuery?: string;
  thinking?: string;
  toolCalls?: ToolCallInfo[];
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

export const INTENT_LABELS: Record<string, string> = {
  chitchat: '闲聊',
  preference: '个人偏好',
  kb: '知识库',
  web: '联网',
  kb_then_web: '知识库 + 联网',
};

export const STEP_LABELS: Record<string, string> = {
  acl_guard: '权限校验',
  load_window: '加载对话',
  query_rewrite: '问题改写',
  intent_router: '意图路由',
  complexity_router: '复杂度判断',
  plan_or_act: '规划工具',
  execute_tools: '执行工具',
  kb_retrieve: '知识库检索',
  hybrid_retrieve: '混合检索',
  graph_reason: '图谱推理',
  web_search: '联网搜索',
  evaluate: '评估资料',
  rewrite_retrieve: '改写再检索',
  memory_load: '记忆加载',
  think: '思考',
  prompt_build: '构建提示词',
  llm_generate: '生成回答',
};

/** 过程面板里出现的内部代号 → 中文 */
export const TRACE_LABELS: Record<string, string> = {
  ...STEP_LABELS,
  ...INTENT_LABELS,
  sufficient: '资料充分',
  rewrite: '改写再检索',
  give_up: '资料不足',
  web_hits: '已有检索结果',
  web_empty: '未检索到公开来源',
  max_iterations: '已达检索轮次上限',
  empty_recall: '知识库无召回',
  low_score: '相关度不足',
  kb_weak_need_web: '内部资料不足，需公开信息',
  heuristic_ok: '资料充分',
  loop_disabled: '未开启循环',
  fast_path: '资料充分',
};

export function localizeTrace(value: string | undefined | null): string {
  if (!value) return '';
  if (TRACE_LABELS[value]) return TRACE_LABELS[value];
  return value.replace(/[a-z][a-z0-9_]*/g, (token) => TRACE_LABELS[token] ?? token);
}

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
