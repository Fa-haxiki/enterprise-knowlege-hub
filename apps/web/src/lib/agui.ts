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
  output?: Record<string, unknown>;
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
  onStepEnd(name: string, latencyMs?: number, degraded?: boolean, output?: Record<string, unknown>): void;
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

/** 用户点停止 / fetch 被掐断，不当作问答失败文案 */
export function isChatAbortError(err: unknown): boolean {
  if (err && typeof err === 'object' && 'name' in err && (err as { name: string }).name === 'AbortError') {
    return true;
  }
  const raw = err instanceof Error ? err.message : String(err ?? '');
  return /abort|bodystreambuffer/i.test(raw);
}

/** 把 AG-UI / fetch 的 HTTP 400 JSON 收成用户可读的 message */
export function formatChatError(err: unknown): string {
  if (isChatAbortError(err)) return '';
  const raw = err instanceof Error ? err.message : String(err ?? '');
  const jsonMatch = raw.match(/\{[\s\S]*\}/);
  if (jsonMatch) {
    try {
      const parsed = JSON.parse(jsonMatch[0]) as { message?: unknown };
      if (typeof parsed.message === 'string' && parsed.message.trim()) {
        return parsed.message.trim();
      }
    } catch {
      /* 不是 JSON 就走原文 */
    }
  }
  const stripped = raw.replace(/^HTTP\s+\d+:\s*/i, '').trim();
  return stripped || '问答失败';
}

type AguiEvent = {
  type: string;
  stepName?: string;
  meta?: { latencyMs?: number; degraded?: boolean; output?: Record<string, unknown> };
  delta?: string;
  name?: string;
  value?: unknown;
  result?: RunResult;
  message?: string;
  toolCallName?: string;
};

export function dispatchAguiEvent(event: AguiEvent, h: AguiHandlers) {
  switch (event.type) {
    case EventType.STEP_STARTED:
    case 'STEP_STARTED':
      if (event.stepName) h.onStepStart(event.stepName);
      break;
    case EventType.STEP_FINISHED:
    case 'STEP_FINISHED':
      if (event.stepName) {
        h.onStepEnd(event.stepName, event.meta?.latencyMs, event.meta?.degraded, event.meta?.output);
      }
      break;
    case EventType.TEXT_MESSAGE_CONTENT:
    case 'TEXT_MESSAGE_CONTENT':
      if (event.delta) h.onToken(event.delta);
      break;
    case EventType.CUSTOM:
    case 'CUSTOM':
      if (event.name === 'citation') h.onCitation(event.value as Citation);
      else if (event.name === 'citations_reset') h.onCitationsReset?.();
      else if (event.name === 'graph_path') h.onGraphPath((event.value as { triples: Triple[] }).triples);
      else if (event.name === 'usage') h.onUsage(event.value as UsageInfo);
      else if (event.name === 'status_detail') {
        const v = event.value as { stage: string; detail: string };
        h.onStatusDetail(v.stage, v.detail);
      } else if (event.name === 'intent') {
        const v = event.value as { intent: string; suggestedQuery: string };
        h.onIntent?.(v.intent, v.suggestedQuery);
      } else if (event.name === 'think' && typeof event.value === 'string') {
        h.onThinking?.(event.value);
      }
      break;
    case EventType.RUN_FINISHED:
    case 'RUN_FINISHED':
      if (event.result) h.onFinished(event.result);
      break;
    case EventType.RUN_ERROR:
    case 'RUN_ERROR':
      h.onError(event.message ?? '问答失败');
      break;
    default: {
      if (event.type === 'TOOL_CALL_START' && event.toolCallName) h.onToolStart?.(event.toolCallName);
      else if (event.type === 'TOOL_CALL_END' && event.toolCallName) h.onToolEnd?.(event.toolCallName);
      else if (
        (event.type === 'REASONING_MESSAGE_CONTENT' || event.type === 'REASONING_CONTENT') &&
        event.delta
      ) {
        h.onThinking?.(event.delta);
      }
      break;
    }
  }
}

async function readSseStream(
  body: ReadableStream<Uint8Array>,
  onEvent: (event: AguiEvent) => void,
  signal?: AbortSignal,
) {
  const reader = body.getReader();
  const onAbort = () => {
    void reader.cancel().catch(() => undefined);
  };
  signal?.addEventListener('abort', onAbort, { once: true });
  const decoder = new TextDecoder();
  let buf = '';
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });
      const parts = buf.split('\n\n');
      buf = parts.pop() ?? '';
      for (const part of parts) {
        const line = part.split('\n').find((l) => l.startsWith('data:'));
        if (!line) continue;
        const json = line.replace(/^data:\s?/, '').trim();
        if (!json) continue;
        try {
          onEvent(JSON.parse(json) as AguiEvent);
        } catch {
          /* 半帧忽略 */
        }
      }
    }
  } finally {
    signal?.removeEventListener('abort', onAbort);
  }
}

export interface ChatStreamSession {
  threadId: string;
  promise: Promise<unknown>;
  abort: () => void;
  setHandlers: (h: AguiHandlers | null) => void;
  replay: (h: AguiHandlers) => void;
}

const sessions = new Map<string, ChatStreamSession>();

export function getChatSession(threadId: string | undefined | null): ChatStreamSession | undefined {
  return threadId ? sessions.get(threadId) : undefined;
}

function createSession(
  threadId: string,
  start: (onEvent: (event: AguiEvent) => void) => { promise: Promise<unknown>; abort: () => void },
): ChatStreamSession {
  const events: AguiEvent[] = [];
  let handlers: AguiHandlers | null = null;
  const { promise, abort } = start((event) => {
    events.push(event);
    if (handlers) dispatchAguiEvent(event, handlers);
  });
  const session: ChatStreamSession = {
    threadId,
    promise,
    abort: () => {
      abort();
      if (sessions.get(threadId) === session) sessions.delete(threadId);
    },
    setHandlers: (h) => {
      handlers = h;
    },
    replay: (h) => {
      for (const event of events) dispatchAguiEvent(event, h);
    },
  };
  sessions.set(threadId, session);
  void promise.finally(() => {
    if (sessions.get(threadId) === session) sessions.delete(threadId);
  });
  return session;
}

export function runChatAgent(args: {
  accessToken: string;
  threadId?: string;
  query: string;
  enableGraph?: boolean;
  handlers: AguiHandlers;
}): { promise: Promise<unknown>; abort: () => void } {
  const session = startChatSession({
    accessToken: args.accessToken,
    threadId: args.threadId ?? `tmp-${Date.now()}`,
    query: args.query,
    enableGraph: args.enableGraph,
  });
  session.setHandlers(args.handlers);
  return { promise: session.promise, abort: session.abort };
}

export function startChatSession(args: {
  accessToken: string;
  threadId: string;
  query: string;
  enableGraph?: boolean;
}): ChatStreamSession {
  getChatSession(args.threadId)?.abort();
  return createSession(args.threadId, (onEvent) => {
    const agent = new HttpAgent({
      url: '/api/v1/agui/chat',
      headers: { Authorization: `Bearer ${args.accessToken}` },
      threadId: args.threadId,
    });
    agent.state = { enable_graph: args.enableGraph ?? true };
    agent.addMessage({ id: `u-${Date.now()}`, role: 'user', content: args.query });
    const promise = agent.runAgent(
      {},
      {
        onEvent: ({ event }) => onEvent(event as unknown as AguiEvent),
      },
    );
    return { promise, abort: () => agent.abortRun() };
  });
}

/** 挂回仍在跑的生成：回放已发生事件并继续收后续帧。只断开本地读取，不取消后台。 */
export function resumeChatAgent(args: {
  accessToken: string;
  threadId: string;
  handlers: AguiHandlers;
}): { promise: Promise<unknown>; abort: () => void } {
  const session = startResumeSession({
    accessToken: args.accessToken,
    threadId: args.threadId,
  });
  session.setHandlers(args.handlers);
  return { promise: session.promise, abort: session.abort };
}

export function startResumeSession(args: {
  accessToken: string;
  threadId: string;
}): ChatStreamSession {
  return createSession(args.threadId, (onEvent) => {
    const ac = new AbortController();
    const promise = (async () => {
      const res = await fetch(`/api/v1/agui/chat/${args.threadId}/resume`, {
        headers: { Authorization: `Bearer ${args.accessToken}` },
        signal: ac.signal,
      });
      if (res.status === 204 || !res.body) return 'empty' as const;
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      await readSseStream(res.body, onEvent, ac.signal);
      return 'streamed' as const;
    })();
    return { promise, abort: () => ac.abort() };
  });
}

