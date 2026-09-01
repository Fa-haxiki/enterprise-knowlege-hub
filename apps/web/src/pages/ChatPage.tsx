import { useEffect, useRef, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { api } from '@/lib/api';
import { runChatAgent } from '@/lib/agui';
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
  router: 'complexity_router',
  retrieval: 'hybrid_retrieve',
  graph: 'graph_reason',
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

export default function ChatPage() {
  const { conversationId } = useParams<{ conversationId: string }>();
  const navigate = useNavigate();
  const accessToken = useAuthStore((s) => s.accessToken);

  const [conversations, setConversations] = useState<Conversation[]>([]);
  const [loadingConvs, setLoadingConvs] = useState(true);
  const [loadingMsgs, setLoadingMsgs] = useState(false);
  const [messages, setMessages] = useState<Message[]>([]);
  const [generating, setGenerating] = useState(false);
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
  /** 新对话首轮结束后 navigate 到会话页：本地已有完整消息，跳过本次 messages 拉取 */
  const skipMsgLoadRef = useRef<string | null>(null);
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
    // 新对话首轮流式完成后跳转而来：消息已在本地，直接跳过重拉
    if (skipMsgLoadRef.current === conversationId) {
      skipMsgLoadRef.current = null;
      setHasMoreMsgs(false);
      return;
    }
    setLoadingMsgs(true);
    msgPageRef.current = 1;
    api
      .get<{ items: Message[]; has_more: boolean }>(
        `/conversations/${conversationId}/messages?page=1&page_size=20`,
      )
      .then((d) => {
        setMessages(d.items);
        setHasMoreMsgs(d.has_more);
      })
      .catch(() => setMessages([]))
      .finally(() => setLoadingMsgs(false));
  }, [conversationId]);

  useEffect(() => {
    // 向前翻页 prepend 时不滚到底部
    if (skipAutoScrollRef.current) {
      skipAutoScrollRef.current = false;
      return;
    }
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' });
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

  const send = async (query: string) => {
    if (generating) return;
    setGenerating(true);

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
    const update = (fn: (m: Message) => Message) =>
      setMessages((prev) => prev.map((m) => (m.id === assistantMsg.id ? fn(m) : m)));

    let fullContent = '';
    try {
      await runChatAgent({
        accessToken: accessToken ?? '',
        threadId: conversationId,
        query,
        handlers: {
          onStepStart: (name) =>
            update((m) => ({
              ...m,
              steps: [...(m.steps ?? []), { name, status: 'running' as const, startedAt: Date.now() }],
            })),
          onStepEnd: (name, latencyMs, degraded) =>
            update((m) => ({
              ...m,
              steps: updateLastStep(
                m.steps ?? [],
                (s) => s.name === name && s.status === 'running',
                { status: degraded ? 'degraded' : 'done', latencyMs },
              ),
            })),
          onStatusDetail: (stage, detail) =>
            update((m) => {
              const node = STAGE_TO_NODE[stage];
              return {
                ...m,
                steps: updateLastStep(
                  m.steps ?? [],
                  (s) => (node ? s.name === node : s.status === 'running'),
                  { detail },
                ),
              };
            }),
          onToken: (delta) => {
            fullContent += delta;
            update((m) => ({ ...m, content: m.content + delta }));
          },
          onCitation: (c) => update((m) => ({ ...m, citations: [...(m.citations ?? []), c] })),
          onGraphPath: (triples) => update((m) => ({ ...m, triples })),
          onUsage: (u) =>
            update((m) => ({
              ...m,
              usage: { prompt_tokens: u.prompt_tokens, completion_tokens: u.completion_tokens },
              latencyMs: u.latency_ms ?? null,
              nodeLatencies: u.node_latencies ?? null,
              degradedNodes: u.degraded ?? [],
            })),
          onFinished: (result) => {
            // 仅记录 serverId，不改动 id——id 作为 React key，变更会导致整条消息重挂载闪烁
            update((m) => ({
              ...m,
              serverId: result.message_id,
              streaming: false,
              complexity: result.complexity,
            }));
            if (!conversationId) {
              skipMsgLoadRef.current = result.conversation_id;
              navigate(`/chat/${result.conversation_id}`, { replace: true });
            }
            // 本地更新侧边栏：当前会话置顶（新会话插入），无需整表重拉
            setConversations((prev) => {
              const existing = prev.find((c) => c.id === result.conversation_id);
              const item: Conversation = {
                id: result.conversation_id,
                title: existing?.title ?? result.title ?? '新对话',
                updated_at: new Date().toISOString(),
              };
              return [item, ...prev.filter((c) => c.id !== result.conversation_id)];
            });
            // 自动语音播报新回答
            if (autoSpeakRef.current && fullContent) {
              setPlayingMsgId(assistantMsg.id);
              getTts().speak(fullContent);
            }
          },
          onError: (message) =>
            update((m) => ({
              ...m,
              content: m.content || `出错了：${message}`,
              streaming: false,
            })),
        },
      });
    } catch (err) {
      update((m) => ({
        ...m,
        content: `请求失败：${(err as Error).message}`,
        streaming: false,
      }));
    } finally {
      setGenerating(false);
    }
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

  const feedback = async (message: Message, value: 1 | -1) => {
    const serverId = message.serverId ?? message.id;
    if (serverId.startsWith('tmp-')) return;
    await api.post(`/messages/${serverId}/feedback`, { feedback: value }).catch(() => undefined);
    setMessages((prev) => prev.map((m) => (m.id === message.id ? { ...m, feedback: value } : m)));
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

      <div className="flex flex-1 flex-col">
        <div
          ref={scrollRef}
          onScroll={(e) => {
            if (e.currentTarget.scrollTop < 60) void loadEarlier();
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

        <ChatInput
          generating={generating}
          autoSpeak={autoSpeak}
          onToggleAutoSpeak={toggleAutoSpeak}
          onSend={send}
        />
        {confirmDialog}
      </div>
    </div>
  );
}
