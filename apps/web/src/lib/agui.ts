import { HttpAgent } from '@ag-ui/client';
import { EventType } from '@ag-ui/core';

export interface Citation {
  ref_id: number;
  chunk_id: string;
  document_id: string;
  title: string;
  page?: number;
  snippet: string;
  source?: 'kb' | 'web';
  url?: string;
}

export type Triple = [string, string, string];

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
  intent?: string | null;
  title?: string;
}

export interface UsageInfo {
  prompt_tokens?: number;
  completion_tokens?: number;
  latency_ms?: number;
  node_latencies?: Record<string, number>;
  degraded?: string[];
  intent?: string;
  thinking?: string;
}

export interface AguiHandlers {
  onStepStart(name: string): void;
  onStepEnd(name: string, latencyMs?: number, degraded?: boolean): void;
  onStatusDetail(stage: string, detail: string): void;
  onToken(delta: string): void;
  onCitation(c: Citation): void;
  onCitationsReset?(): void;
  onGraphPath(triples: Triple[]): void;
  onUsage(u: UsageInfo): void;
  onIntent?(intent: string, suggestedQuery: string): void;
  onToolStart?(name: string): void;
  onToolEnd?(name: string, summary?: string): void;
  onThinking?(text: string): void;
  onFinished(result: RunResult): void;
  onError(message: string): void;
}

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
          toolCallName?: string;
          toolCallId?: string;
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
            else if (e.name === 'citations_reset') h.onCitationsReset?.();
            else if (e.name === 'graph_path') h.onGraphPath((e.value as { triples: Triple[] }).triples);
            else if (e.name === 'usage') h.onUsage(e.value as UsageInfo);
            else if (e.name === 'status_detail') {
              const v = e.value as { stage: string; detail: string };
              h.onStatusDetail(v.stage, v.detail);
            } else if (e.name === 'intent') {
              const v = e.value as { intent: string; suggestedQuery: string };
              h.onIntent?.(v.intent, v.suggestedQuery);
            } else if (e.name === 'think' && typeof e.value === 'string') {
              h.onThinking?.(e.value);
            }
            break;
          case EventType.RUN_FINISHED:
            if (e.result) h.onFinished(e.result);
            break;
          case EventType.RUN_ERROR:
            h.onError(e.message ?? '问答失败');
            break;
          default: {
            const t = event.type as string;
            if (t === 'TOOL_CALL_START' && e.toolCallName) h.onToolStart?.(e.toolCallName);
            else if (t === 'TOOL_CALL_END' && e.toolCallName) h.onToolEnd?.(e.toolCallName);
            else if (t === 'REASONING_CONTENT' && e.delta) h.onThinking?.(e.delta);
            break;
          }
        }
      },
    },
  );
}
