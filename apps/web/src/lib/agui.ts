import { HttpAgent } from '@ag-ui/client';
import { EventType } from '@ag-ui/core';
import type { GraphSubgraph } from '@/lib/graph';

export interface Citation {
  ref_id: number;
  chunk_id: string;
  document_id: string;
  title: string;
  page?: number;
  snippet: string;
}

export type Triple = [string, string, string];

/** graph_path CUSTOM 事件：推理链路三元组 + 可视化子图（按实体 id） */
export interface GraphPathPayload {
  triples: Triple[];
  subgraph?: GraphSubgraph | null;
}

export interface AgentStep {
  name: string;
  status: 'running' | 'done' | 'degraded';
  startedAt: number;
  latencyMs?: number;
  detail?: string;
}

export interface RunResult {
  message_id: string;
  conversation_id: string;
  complexity: 'simple' | 'complex' | null;
  /** 会话标题（新会话为自动生成的标题），用于前端本地更新侧边栏 */
  title?: string;
}

/** usage CUSTOM 事件：汇总耗时 / token / 各节点耗时 / 降级节点 */
export interface UsageInfo {
  prompt_tokens?: number;
  completion_tokens?: number;
  latency_ms?: number;
  node_latencies?: Record<string, number>;
  degraded?: string[];
}

export interface AguiHandlers {
  onStepStart(name: string): void;
  onStepEnd(name: string, latencyMs?: number, degraded?: boolean): void;
  onStatusDetail(stage: string, detail: string): void;
  onToken(delta: string): void;
  onCitation(c: Citation): void;
  onGraphPath(payload: GraphPathPayload): void;
  onUsage(u: UsageInfo): void;
  onFinished(result: RunResult): void;
  onError(message: string): void;
}

/**
 * 通过 AG-UI 协议发起一次问答运行。
 * threadId 即会话 id（新对话传 undefined，由 client 生成并作为会话 id 落库）。
 */
export async function runChatAgent(args: {
  accessToken: string;
  threadId?: string;
  query: string;
  enableGraph?: boolean;
  handlers: AguiHandlers;
}): Promise<void> {
  const agent = new HttpAgent({
    url: '/api/v1/agui/chat',
    headers: { Authorization: `Bearer ${args.accessToken}` },
    ...(args.threadId ? { threadId: args.threadId } : {}),
  });
  agent.state = { enable_graph: args.enableGraph ?? true };
  agent.addMessage({ id: `u-${Date.now()}`, role: 'user', content: args.query });

  await agent.runAgent(
    {},
    {
      onEvent: ({ event }) => {
        const h = args.handlers;
        const e = event as unknown as {
          stepName?: string;
          meta?: { latencyMs?: number; degraded?: boolean };
          delta?: string;
          name?: string;
          value?: unknown;
          result?: RunResult;
          message?: string;
        };
        switch (event.type) {
          case EventType.STEP_STARTED:
            if (e.stepName) h.onStepStart(e.stepName);
            break;
          case EventType.STEP_FINISHED:
            if (e.stepName) h.onStepEnd(e.stepName, e.meta?.latencyMs, e.meta?.degraded);
            break;
          case EventType.TEXT_MESSAGE_CONTENT:
            if (e.delta) h.onToken(e.delta);
            break;
          case EventType.CUSTOM:
            if (e.name === 'citation') h.onCitation(e.value as Citation);
            else if (e.name === 'graph_path') {
              const v = e.value as GraphPathPayload;
              h.onGraphPath({ triples: v?.triples ?? [], subgraph: v?.subgraph ?? null });
            }
            else if (e.name === 'usage') h.onUsage(e.value as UsageInfo);
            else if (e.name === 'status_detail') {
              const v = e.value as { stage: string; detail: string };
              h.onStatusDetail(v.stage, v.detail);
            }
            break;
          case EventType.RUN_FINISHED:
            if (e.result) h.onFinished(e.result);
            break;
          case EventType.RUN_ERROR:
            h.onError(e.message ?? '问答失败');
            break;
          default:
            break;
        }
      },
    },
  );
}
