import { useEffect, useRef, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { api } from '@/lib/api';
import {
  formatChatError,
  getChatSession,
  isChatAbortError,
  startChatSession,
  startResumeSession,
  type AguiHandlers,
  type ChatStreamSession,
} from '@/lib/agui';
import { TtsPlayer } from '@/lib/tts';
import { useAuthStore } from '@/store/auth';
import ConversationSidebar from '@/components/chat/ConversationSidebar';
import MessageItem from '@/components/chat/MessageItem';
import ChatInput from '@/components/chat/ChatInput';
import EmptyChat from '@/components/chat/EmptyChat';
import { useConfirm } from '@/components/ConfirmDialog';
import type { AgentStep, Conversation, Message } from '@/components/chat/types';

/** status_detail 的 stage → LangGraph 节点名（用于把详情挂到对应步骤上） */
const STAGE_TO_NODE: Record<string, string> = {
  router: 'intent_router',
  intent: 'intent_router',
  retrieval: 'kb_retrieve',
  graph: 'graph_reason',
  evaluate: 'evaluate',
  rewrite: 'rewrite_retrieve',
  tool: 'web_search',
  think: 'think',
};

function updateLastStep(steps: AgentStep[], pred: (s: AgentStep) => boolean, patch: Partial<AgentStep>): AgentStep[] {
  for (let i = steps.length - 1; i >= 0; i--) {
    if (pred(steps[i])) {
      const next = [...steps];
      next[i] = { ...next[i], ...patch };
      return next;
    }
  }
  return steps;
}

function markStepsStopped(steps: AgentStep[]): AgentStep[] {
  return steps.map((s) =>
    s.status === 'running'
      ? { ...s, status: 'done' as const, latencyMs: Date.now() - s.startedAt, detail: s.detail || '已停止' }
      : s,
  );
}

function finishStopped(m: Message): Message {
  return {
    ...m,
    streaming: false,
    steps: markStepsStopped(m.steps ?? []),
  };
}

export default function ChatPage() {
  const { conversationId } = useParams<{ conversationId: string }>();
  const navigate = useNavigate();
  const accessToken = useAuthStore((s) => s.accessToken);

  const [conversations, setConversations] = useState<Conversation[]>([]);
  const [loadingConvs, setLoadingConvs] = useState(true);
  const [loadingMsgs, setLoadingMsgs] = useState(false);
  const [messages, setMessages] = useState<Message[]>([]);
  const [generatingIds, setGeneratingIds] = useState<Set<string>>(() => new Set());
  const [autoSpeak, setAutoSpeak] = useState(() => localStorage.getItem('ekh-tts-auto') === '1');
  const [playingMsgId, setPlayingMsgId] = useState<string | null>(null);
  const [hasMoreMsgs, setHasMoreMsgs] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);
  const [hasMoreConvs, setHasMoreConvs] = useState(false);
  const [loadingMoreConvs, setLoadingMoreConvs] = useState(false);
  const { confirm, confirmDialog } = useConfirm();
  const convPageRef = useRef(1);
  const bottomRef = useRef<HTMLDivElement>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const msgPageRef = useRef(1);
  const skipAutoScrollRef = useRef(false);
  const stickToBottomRef = useRef(true);
  const [showJumpBottom, setShowJumpBottom] = useState(false);
  const NEAR_BOTTOM_PX = 96;
  /** 新对话首轮结束后 navigate 到会话页：本地已有完整消息，跳过本次 messages 拉取 */
  const skipMsgLoadRef = useRef<string | null>(null);
  const abortRunRef = useRef<(() => void) | null>(null);
  const detachRef = useRef<(() => void) | null>(null);
  const streamThreadRef = useRef<string | null>(null);
  const conversationIdRef = useRef(conversationId);
  conversationIdRef.current = conversationId;
  const stoppedIdsRef = useRef(new Set<string>());

  const markGenerating = (threadId: string, on: boolean) => {
    setGeneratingIds((prev) => {
      const has = prev.has(threadId);
      if (on === has) return prev;
      const next = new Set(prev);
      if (on) next.add(threadId);
      else next.delete(threadId);
      return next;
    });
  };

  const currentGenerating = !!conversationId && generatingIds.has(conversationId);
  const ttsRef = useRef<TtsPlayer | null>(null);
  const autoSpeakRef = useRef(autoSpeak);
  autoSpeakRef.current = autoSpeak;

  const getTts = () => {
    if (!ttsRef.current) {
      ttsRef.current = new TtsPlayer({
        onDone: () => {
          // done 时可能还有排队音频，延迟清除播放状态
          setTimeout(() => setPlayingMsgId(null), 500);
        },
        onError: () => setPlayingMsgId(null),
      });
      ttsRef.current.connect(useAuthStore.getState().accessToken ?? '');
    }
    return ttsRef.current;
  };

  const stopSpeak = () => {
    ttsRef.current?.stopPlayback();
    setPlayingMsgId(null);
  };

  const speakMessage = (m: Message) => {
    if (playingMsgId === m.id) {
      stopSpeak();
      return;
    }
    setPlayingMsgId(m.id);
    getTts().speak(m.content);
  };

  const toggleAutoSpeak = () => {
    const next = !autoSpeak;
    setAutoSpeak(next);
    localStorage.setItem('ekh-tts-auto', next ? '1' : '0');
    if (!next) stopSpeak();
  };

  useEffect(() => () => ttsRef.current?.disconnect(), []);

  /** 刷新对话列表第一页（新对话/重命名/删除后调用） */
  const loadConversations = () => {
    convPageRef.current = 1;
    return api
      .get<{ items: Conversation[]; has_more: boolean }>('/conversations?page=1&page_size=40')
      .then((d) => {
        setConversations(d.items);
        setHasMoreConvs(d.has_more);
      })
      .catch(() => undefined)
      .finally(() => setLoadingConvs(false));
  };

  /** 侧边栏滚动到底部时追加更早的一页（按 id 去重，防止 updatedAt 变化导致分页偏移重复） */
  const loadMoreConversations = async () => {
    if (loadingMoreConvs || !hasMoreConvs) return;
    setLoadingMoreConvs(true);
    try {
      const next = convPageRef.current + 1;
      const d = await api.get<{ items: Conversation[]; has_more: boolean }>(
        `/conversations?page=${next}&page_size=40`,
      );
      convPageRef.current = next;
      setHasMoreConvs(d.has_more);
      setConversations((prev) => {
        const seen = new Set(prev.map((c) => c.id));
        return [...prev, ...d.items.filter((c) => !seen.has(c.id))];
      });
    } catch {
      /* 失败保持现状，下次滚动再试 */
    } finally {
      setLoadingMoreConvs(false);
    }
  };

  useEffect(() => {
    void loadConversations();
  }, []);

  useEffect(() => {
    if (!conversationId) {
      setMessages([]);
      setHasMoreMsgs(false);
      return;
    }
    // 新对话首轮流式中 navigate 过来：消息已在本地，跳过重拉
    if (skipMsgLoadRef.current === conversationId) {
      skipMsgLoadRef.current = null;
      setHasMoreMsgs(false);
      return () => {
        if (streamThreadRef.current === conversationId) detachRef.current?.();
      };
    }
    let cancelled = false;
    setLoadingMsgs(true);
    msgPageRef.current = 1;
    api
      .get<{
        items: Message[];
        has_more: boolean;
        active_run: { query: string; run_id: string } | null;
      }>(`/conversations/${conversationId}/messages?page=1&page_size=20`)
      .then((d) => {
        if (cancelled) return;
        setHasMoreMsgs(d.has_more);
        const parked = getChatSession(conversationId);
        const last = d.items[d.items.length - 1];
        const shouldResume = !!parked || !!d.active_run || last?.role === 'user';
        if (!shouldResume) {
          setMessages(d.items);
          return;
        }
        const history = d.items.filter((m) => !(m.role === 'assistant' && !m.content));
        const session = parked ?? startResumeSession({
          accessToken: accessToken ?? '',
          threadId: conversationId,
        });
        attachSession(conversationId, history, session);
      })
      .catch(() => {
        if (!cancelled) setMessages([]);
      })
      .finally(() => {
        if (!cancelled) setLoadingMsgs(false);
      });
    return () => {
      cancelled = true;
      if (streamThreadRef.current === conversationId) detachRef.current?.();
    };
  }, [conversationId]);

  const isNearBottom = (el: HTMLElement) =>
    el.scrollHeight - el.scrollTop - el.clientHeight < NEAR_BOTTOM_PX;

  const jumpToBottom = () => {
    stickToBottomRef.current = true;
    setShowJumpBottom(false);
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' });
  };

  useEffect(() => {
    // 向前翻页 prepend 时不滚到底部
    if (skipAutoScrollRef.current) {
      skipAutoScrollRef.current = false;
      return;
    }
    if (!stickToBottomRef.current) return;
    bottomRef.current?.scrollIntoView({ behavior: 'auto' });
  }, [messages]);

  /** 滚动到顶部时加载更早的一页，并保持视口位置不跳动 */
  const loadEarlier = async () => {
    if (!conversationId || loadingMore || !hasMoreMsgs) return;
    setLoadingMore(true);
    const el = scrollRef.current;
    const prevHeight = el?.scrollHeight ?? 0;
    try {
      const next = msgPageRef.current + 1;
      const d = await api.get<{ items: Message[]; has_more: boolean }>(
        `/conversations/${conversationId}/messages?page=${next}&page_size=20`,
      );
      msgPageRef.current = next;
      setHasMoreMsgs(d.has_more);
      skipAutoScrollRef.current = true;
      setMessages((prev) => [...d.items, ...prev]);
      requestAnimationFrame(() => {
        if (el) el.scrollTop = el.scrollHeight - prevHeight;
      });
    } catch {
      /* 加载失败保持现状，下次滚动再试 */
    } finally {
      setLoadingMore(false);
    }
  };

  const bindHandlers = (
    assistantId: string,
    threadId: string,
    contentRef: { current: string },
  ): AguiHandlers => {
    const update = (fn: (m: Message) => Message) =>
      setMessages((prev) => prev.map((m) => (m.id === assistantId ? fn(m) : m)));
    return {
      onStepStart: (name) =>
        update((m) => ({
          ...m,
          steps: [...(m.steps ?? []), { name, status: 'running' as const, startedAt: Date.now() }],
        })),
      onStepEnd: (name, latencyMs, degraded, output) =>
        update((m) => ({
          ...m,
          steps: updateLastStep(m.steps ?? [], (s) => s.name === name && s.status === 'running', {
            status: degraded ? 'degraded' : 'done',
            latencyMs,
            output,
            detail: (typeof output?.summary === 'string' ? output.summary : undefined) ?? undefined,
          }),
        })),
      onStatusDetail: (stage, detail) =>
        update((m) => {
          const node = STAGE_TO_NODE[stage];
          return {
            ...m,
            steps: updateLastStep(m.steps ?? [], (s) => (node ? s.name === node : s.status === 'running'), {
              detail,
            }),
          };
        }),
      onToken: (delta) => {
        contentRef.current += delta;
        update((m) => ({ ...m, content: m.content + delta }));
      },
      onCitation: (c) => update((m) => ({ ...m, citations: [...(m.citations ?? []), c] })),
      onCitationsReset: () => update((m) => ({ ...m, citations: [] })),
      onGraphPath: (triples) => update((m) => ({ ...m, triples })),
      onIntent: (intent, suggestedQuery) =>
        update((m) => ({
          ...m,
          intent: intent as Message['intent'],
          suggestedQuery,
        })),
      onToolStart: (name) =>
        update((m) => ({
          ...m,
          toolCalls: [...(m.toolCalls ?? []), { name }],
        })),
      onToolEnd: (name, summary) =>
        update((m) => ({
          ...m,
          toolCalls: (m.toolCalls ?? []).map((t, i, arr) =>
            i === arr.map((x) => x.name).lastIndexOf(name) ? { ...t, summary } : t,
          ),
        })),
      onThinking: (text) =>
        update((m) => ({
          ...m,
          thinking: text,
          steps: updateLastStep(m.steps ?? [], (s) => s.name === 'think', {
            detail: text.slice(0, 80),
            output: { summary: '已生成思考', text },
          }),
        })),
      onUsage: (u) =>
        update((m) => ({
          ...m,
          usage: { prompt_tokens: u.prompt_tokens, completion_tokens: u.completion_tokens },
          latencyMs: u.latency_ms ?? null,
          nodeLatencies: u.node_latencies ?? null,
          degradedNodes: u.degraded ?? [],
          intent: (u.intent as Message['intent']) ?? m.intent,
          thinking: u.thinking ?? m.thinking,
        })),
      onFinished: (result) => {
        update((m) => ({
          ...m,
          serverId: result.message_id,
          streaming: false,
          complexity: result.complexity,
          intent: (result.intent as Message['intent']) ?? m.intent,
        }));
        setConversations((prev) => {
          const existing = prev.find((c) => c.id === result.conversation_id);
          const item: Conversation = {
            id: result.conversation_id,
            title: existing?.title ?? result.title ?? '新对话',
            updated_at: new Date().toISOString(),
          };
          return [item, ...prev.filter((c) => c.id !== result.conversation_id)];
        });
        if (autoSpeakRef.current && contentRef.current && conversationIdRef.current === threadId) {
          setPlayingMsgId(assistantId);
          getTts().speak(contentRef.current);
        }
      },
      onError: (message) => {
        if (stoppedIdsRef.current.has(threadId)) {
          update(finishStopped);
          return;
        }
        if (isChatAbortError(message)) return;
        update((m) => ({
          ...m,
          content: m.content || formatChatError(message),
          streaming: false,
          steps: markStepsStopped(m.steps ?? []),
        }));
      },
    };
  };

  const attachSession = (threadId: string, history: Message[], session: ChatStreamSession) => {
    const last = history[history.length - 1];
    const reuse = last?.role === 'assistant' && !last.content;
    const assistantId = reuse ? last.id : `tmp-a-${Date.now()}`;
    const items = reuse
      ? history.map((m) => (m.id === last.id ? { ...m, streaming: true, content: '', steps: [], citations: [] } : m))
      : [
          ...history,
          {
            id: assistantId,
            role: 'assistant' as const,
            content: '',
            streaming: true,
            citations: [],
            triples: [],
            steps: [],
          },
        ];
    setMessages(items);
    void listenSession(threadId, assistantId, session);
  };

  const listenSession = async (threadId: string, assistantId: string, session: ChatStreamSession) => {
    streamThreadRef.current = threadId;
    stoppedIdsRef.current.delete(threadId);
    markGenerating(threadId, true);
    const contentRef = { current: '' };
    const handlers = bindHandlers(assistantId, threadId, contentRef);
    session.replay(handlers);
    session.setHandlers(handlers);
    detachRef.current = () => session.setHandlers(null);
    abortRunRef.current = () => session.abort();
    try {
      const outcome = await session.promise;
      if (outcome === 'empty' && conversationIdRef.current === threadId) {
        const d = await api.get<{ items: Message[] }>(
          `/conversations/${threadId}/messages?page=1&page_size=20`,
        );
        setMessages(d.items);
        return;
      }
      if (stoppedIdsRef.current.has(threadId) && conversationIdRef.current === threadId) {
        setMessages((prev) => prev.map((m) => (m.id === assistantId ? finishStopped(m) : m)));
      }
    } catch (err) {
      if (stoppedIdsRef.current.has(threadId) && conversationIdRef.current === threadId) {
        setMessages((prev) => prev.map((m) => (m.id === assistantId ? finishStopped(m) : m)));
      } else if (!isChatAbortError(err) && conversationIdRef.current === threadId) {
        setMessages((prev) =>
          prev.map((m) =>
            m.id === assistantId
              ? {
                  ...m,
                  content: formatChatError(err),
                  streaming: false,
                  steps: markStepsStopped(m.steps ?? []),
                }
              : m,
          ),
        );
      }
    } finally {
      if (streamThreadRef.current === threadId) {
        detachRef.current = null;
        abortRunRef.current = null;
      }
      markGenerating(threadId, false);
    }
  };

  const send = async (query: string) => {
    if (conversationId && generatingIds.has(conversationId)) return;
    stickToBottomRef.current = true;
    setShowJumpBottom(false);

    let threadId = conversationId;
    if (!threadId) {
      threadId = crypto.randomUUID();
      skipMsgLoadRef.current = threadId;
      navigate(`/chat/${threadId}`, { replace: true });
    }

    const userMsg: Message = { id: `tmp-u-${Date.now()}`, role: 'user', content: query };
    const assistantMsg: Message = {
      id: `tmp-a-${Date.now()}`,
      role: 'assistant',
      content: '',
      streaming: true,
      citations: [],
      triples: [],
      steps: [],
    };
    setMessages((prev) => [...prev, userMsg, assistantMsg]);
    const session = startChatSession({
      accessToken: accessToken ?? '',
      threadId,
      query,
    });
    await listenSession(threadId, assistantMsg.id, session);
  };

  const stopGenerate = () => {
    const threadId = conversationId;
    if (!threadId) return;
    stoppedIdsRef.current.add(threadId);
    void api.post(`/agui/chat/${threadId}/cancel`).catch(() => undefined);
    getChatSession(threadId)?.abort();
  };

  const renameConversation = async (id: string, title: string) => {
    await api.patch(`/conversations/${id}`, { title }).catch(() => undefined);
    setConversations((prev) => prev.map((c) => (c.id === id ? { ...c, title } : c)));
  };

  const removeConversation = async (id: string) => {
    const ok = await confirm({
      title: '删除对话',
      description: '该对话的全部消息记录将一并删除，此操作不可恢复。',
    });
    if (!ok) return;
    await api.delete(`/conversations/${id}`).catch(() => undefined);
    setConversations((prev) => prev.filter((c) => c.id !== id));
    if (id === conversationId) navigate('/chat');
  };

  const feedback = async (message: Message, value: 1 | -1, comment?: string) => {
    const serverId = message.serverId ?? message.id;
    if (serverId.startsWith('tmp-')) return;
    await api
      .post(`/messages/${serverId}/feedback`, { feedback: value, comment })
      .catch(() => undefined);
    setMessages((prev) =>
      prev.map((m) =>
        m.id === message.id ? { ...m, feedback: value, feedbackComment: comment ?? null } : m,
      ),
    );
  };

  return (
    <div className="flex h-full">
      <ConversationSidebar
        conversations={conversations}
        activeId={conversationId}
        loading={loadingConvs}
        hasMore={hasMoreConvs}
        loadingMore={loadingMoreConvs}
        onLoadMore={() => void loadMoreConversations()}
        onRename={renameConversation}
        onRemove={removeConversation}
      />

      <div className="relative flex flex-1 flex-col">
        <div
          ref={scrollRef}
          onScroll={(e) => {
            const el = e.currentTarget;
            if (el.scrollTop < 60) void loadEarlier();
            const near = isNearBottom(el);
            stickToBottomRef.current = near;
            setShowJumpBottom(!near);
          }}
          className="flex-1 overflow-y-auto px-6 py-6"
        >
          <div className="mx-auto max-w-3xl space-y-6">
            {loadingMore && (
              <div className="flex items-center justify-center gap-1.5 py-1 text-xs text-ink-400">
                <span className="h-3 w-3 animate-spin rounded-full border border-ink-400/30 border-t-ink-400" />
                加载更早的消息…
              </div>
            )}
            {loadingMsgs ? (
              <div className="space-y-6 pt-4">
                <div className="flex justify-end">
                  <div className="skeleton h-10 w-2/5 rounded-bubble" />
                </div>
                <div className="flex gap-3">
                  <div className="skeleton h-8 w-8 shrink-0 rounded-lg" />
                  <div className="skeleton h-28 flex-1 rounded-bubble" />
                </div>
                <div className="flex justify-end">
                  <div className="skeleton h-10 w-1/3 rounded-bubble" />
                </div>
              </div>
            ) : messages.length === 0 ? (
              <EmptyChat onAsk={send} />
            ) : (
              messages.map((m) => (
                <MessageItem
                  key={m.id}
                  message={m}
                  playing={playingMsgId === m.id}
                  onFeedback={feedback}
                  onSpeak={speakMessage}
                />
              ))
            )}
            <div ref={bottomRef} />
          </div>
        </div>

        {showJumpBottom && (
          <button
            type="button"
            onClick={jumpToBottom}
            className="absolute bottom-24 left-1/2 z-10 flex -translate-x-1/2 items-center gap-1.5 rounded-full border border-border bg-card px-3 py-1.5 text-xs font-medium text-ink-600 shadow-md transition-colors hover:border-brand-500/40 hover:text-brand-600"
          >
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
              <path d="M12 5v14M19 12l-7 7-7-7" />
            </svg>
            回到底部
          </button>
        )}
        <ChatInput
          generating={currentGenerating}
          autoSpeak={autoSpeak}
          onToggleAutoSpeak={toggleAutoSpeak}
          onSend={send}
          onStop={stopGenerate}
        />
        {confirmDialog}
      </div>
    </div>
  );
}
