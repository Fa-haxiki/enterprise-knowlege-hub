import { FormEvent, useEffect, useRef, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { api } from '@/lib/api';
import { sseStream } from '@/lib/sse';
import { useAuthStore } from '@/store/auth';

interface Citation {
  ref_id: number;
  chunk_id: string;
  document_id: string;
  title: string;
  page?: number;
  snippet: string;
}

interface Message {
  id: string;
  role: 'user' | 'assistant';
  content: string;
  citations?: Citation[];
  feedback?: number;
  streaming?: boolean;
  statusText?: string;
  triples?: [string, string, string][];
}

interface Conversation {
  id: string;
  title: string;
  updated_at: string;
}

export default function ChatPage() {
  const { conversationId } = useParams<{ conversationId: string }>();
  const navigate = useNavigate();
  const accessToken = useAuthStore((s) => s.accessToken);

  const [conversations, setConversations] = useState<Conversation[]>([]);
  const [messages, setMessages] = useState<Message[]>([]);
  const [input, setInput] = useState('');
  const [generating, setGenerating] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editingTitle, setEditingTitle] = useState('');
  const bottomRef = useRef<HTMLDivElement>(null);

  const loadConversations = () =>
    api
      .get<{ items: Conversation[] }>('/conversations?page_size=50')
      .then((d) => setConversations(d.items))
      .catch(() => undefined);

  useEffect(() => {
    void loadConversations();
  }, []);

  useEffect(() => {
    if (!conversationId) {
      setMessages([]);
      return;
    }
    api
      .get<{ items: Message[] }>(`/conversations/${conversationId}/messages?page_size=100`)
      .then((d) => setMessages(d.items))
      .catch(() => setMessages([]));
  }, [conversationId]);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages]);

  const send = async (e: FormEvent) => {
    e.preventDefault();
    const query = input.trim();
    if (!query || generating) return;
    setInput('');
    setGenerating(true);

    const userMsg: Message = { id: `tmp-u-${Date.now()}`, role: 'user', content: query };
    const assistantMsg: Message = {
      id: `tmp-a-${Date.now()}`,
      role: 'assistant',
      content: '',
      streaming: true,
      citations: [],
      triples: [],
    };
    setMessages((prev) => [...prev, userMsg, assistantMsg]);

    try {
      const res = await fetch('/api/v1/chat/completions', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${accessToken}`,
          Accept: 'text/event-stream',
        },
        body: JSON.stringify({
          conversation_id: conversationId,
          query,
          options: { enable_graph: true },
        }),
      });
      if (!res.ok) throw new Error(`请求失败 ${res.status}`);

      for await (const frame of sseStream(res)) {
        const data = JSON.parse(frame.data);
        setMessages((prev) =>
          prev.map((m) => {
            if (m.id !== assistantMsg.id) return m;
            switch (frame.event) {
              case 'status':
                return { ...m, statusText: data.detail };
              case 'token':
                return { ...m, content: m.content + data.delta, statusText: undefined };
              case 'citation':
                return { ...m, citations: [...(m.citations ?? []), data] };
              case 'graph_path':
                return { ...m, triples: data.triples };
              default:
                return m;
            }
          }),
        );
        if (frame.event === 'done') {
          setMessages((prev) =>
            prev.map((m) =>
              m.id === assistantMsg.id ? { ...m, id: data.message_id, streaming: false } : m,
            ),
          );
          if (!conversationId) navigate(`/chat/${data.conversation_id}`, { replace: true });
          void loadConversations();
        }
        if (frame.event === 'error') {
          setMessages((prev) =>
            prev.map((m) =>
              m.id === assistantMsg.id
                ? { ...m, content: m.content || `出错了：${data.message}`, streaming: false }
                : m,
            ),
          );
        }
      }
    } catch (err) {
      setMessages((prev) =>
        prev.map((m) =>
          m.id === assistantMsg.id
            ? { ...m, content: `请求失败：${(err as Error).message}`, streaming: false }
            : m,
        ),
      );
    } finally {
      setGenerating(false);
    }
  };

  const startRename = (c: Conversation) => {
    setEditingId(c.id);
    setEditingTitle(c.title);
  };

  const submitRename = async () => {
    if (!editingId) return;
    const title = editingTitle.trim();
    if (title) {
      await api.patch(`/conversations/${editingId}`, { title }).catch(() => undefined);
      setConversations((prev) =>
        prev.map((c) => (c.id === editingId ? { ...c, title } : c)),
      );
    }
    setEditingId(null);
  };

  const removeConversation = async (id: string) => {
    if (!confirm('确认删除该对话？消息记录将一并删除。')) return;
    await api.delete(`/conversations/${id}`).catch(() => undefined);
    setConversations((prev) => prev.filter((c) => c.id !== id));
    if (id === conversationId) navigate('/chat');
  };

  const feedback = async (messageId: string, value: 1 | -1) => {
    if (messageId.startsWith('tmp-')) return;
    await api.post(`/messages/${messageId}/feedback`, { feedback: value }).catch(() => undefined);
    setMessages((prev) =>
      prev.map((m) => (m.id === messageId ? { ...m, feedback: value } : m)),
    );
  };

  return (
    <div className="flex h-full">
      {/* 对话列表 */}
      <div className="flex w-60 flex-col border-r border-slate-200 bg-white">
        <div className="border-b border-slate-200 p-3">
          <button
            onClick={() => navigate('/chat')}
            className="w-full rounded-md bg-slate-900 py-2 text-sm text-white hover:bg-slate-800"
          >
            新对话
          </button>
        </div>
        <div className="flex-1 overflow-y-auto p-2">
          {conversations.map((c) => (
            <div
              key={c.id}
              className={`group relative flex items-center rounded-md ${
                c.id === conversationId
                  ? 'bg-slate-100 text-slate-900'
                  : 'text-slate-600 hover:bg-slate-50'
              }`}
            >
              {editingId === c.id ? (
                <input
                  autoFocus
                  className="m-1 w-full rounded border border-slate-300 px-2 py-1 text-sm outline-none focus:border-slate-500"
                  value={editingTitle}
                  onChange={(e) => setEditingTitle(e.target.value)}
                  onBlur={submitRename}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') void submitRename();
                    if (e.key === 'Escape') setEditingId(null);
                  }}
                />
              ) : (
                <>
                  <button
                    onClick={() => navigate(`/chat/${c.id}`)}
                    className="min-w-0 flex-1 truncate px-3 py-2 text-left text-sm"
                    title={c.title}
                  >
                    {c.title}
                  </button>
                  <div className="absolute right-1 hidden items-center gap-0.5 group-hover:flex">
                    <button
                      onClick={(e) => {
                        e.stopPropagation();
                        startRename(c);
                      }}
                      className="rounded p-1 text-slate-400 hover:bg-slate-200 hover:text-slate-700"
                      title="重命名"
                    >
                      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                        <path d="M17 3a2.85 2.83 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5Z" />
                      </svg>
                    </button>
                    <button
                      onClick={(e) => {
                        e.stopPropagation();
                        void removeConversation(c.id);
                      }}
                      className="rounded p-1 text-slate-400 hover:bg-red-50 hover:text-red-600"
                      title="删除"
                    >
                      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                        <path d="M3 6h18" />
                        <path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6" />
                        <path d="M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2" />
                      </svg>
                    </button>
                  </div>
                </>
              )}
            </div>
          ))}
        </div>
      </div>

      {/* 对话区 */}
      <div className="flex flex-1 flex-col">
        <div className="flex-1 overflow-y-auto px-6 py-4">
          <div className="mx-auto max-w-3xl space-y-6">
            {messages.length === 0 && (
              <div className="py-24 text-center">
                <p className="text-lg font-medium text-slate-700">向知识库提问</p>
                <p className="mt-2 text-sm text-slate-400">
                  支持制度查询、项目关联分析等多轮问答，答案附引用来源
                </p>
              </div>
            )}
            {messages.map((m) => (
              <div key={m.id} className={m.role === 'user' ? 'text-right' : ''}>
                <div
                  className={`inline-block max-w-full rounded-lg px-4 py-3 text-left text-sm leading-6 ${
                    m.role === 'user'
                      ? 'bg-slate-900 text-white'
                      : 'w-full border border-slate-200 bg-white'
                  }`}
                >
                  {m.statusText && (
                    <div className="mb-2 flex items-center gap-2 text-xs text-slate-400">
                      <span className="inline-block h-3 w-3 animate-spin rounded-full border border-slate-300 border-t-slate-600" />
                      {m.statusText}
                    </div>
                  )}
                  <div className="whitespace-pre-wrap">{m.content}</div>

                  {/* 图谱推理链路 */}
                  {m.triples && m.triples.length > 0 && (
                    <div className="mt-3 rounded-md bg-slate-50 p-3">
                      <div className="mb-1 text-xs font-medium text-slate-500">图谱推理链路</div>
                      <div className="space-y-1">
                        {m.triples.map((t, i) => (
                          <div key={i} className="text-xs text-slate-600">
                            <span className="font-medium">{t[0]}</span>
                            <span className="mx-1 text-slate-400">—{t[1]}→</span>
                            <span className="font-medium">{t[2]}</span>
                          </div>
                        ))}
                      </div>
                    </div>
                  )}

                  {/* 引用面板 */}
                  {m.citations && m.citations.length > 0 && (
                    <div className="mt-3 border-t border-slate-100 pt-2">
                      <div className="mb-1 text-xs font-medium text-slate-500">引用来源</div>
                      <div className="space-y-1">
                        {m.citations.map((c) => (
                          <div key={c.ref_id} className="text-xs text-slate-500">
                            <span className="mr-1 rounded bg-slate-100 px-1 text-slate-600">
                              {c.ref_id}
                            </span>
                            《{c.title}》{c.page ? ` P${c.page}` : ''} — {c.snippet}…
                          </div>
                        ))}
                      </div>
                    </div>
                  )}

                  {/* 反馈 */}
                  {m.role === 'assistant' && !m.streaming && m.content && (
                    <div className="mt-2 flex gap-2 text-xs text-slate-400">
                      <button
                        onClick={() => feedback(m.id, 1)}
                        className={m.feedback === 1 ? 'text-green-600' : 'hover:text-slate-600'}
                      >
                        有用
                      </button>
                      <button
                        onClick={() => feedback(m.id, -1)}
                        className={m.feedback === -1 ? 'text-red-600' : 'hover:text-slate-600'}
                      >
                        无用
                      </button>
                    </div>
                  )}
                </div>
              </div>
            ))}
            <div ref={bottomRef} />
          </div>
        </div>

        {/* 输入区 */}
        <div className="border-t border-slate-200 bg-white p-4">
          <form onSubmit={send} className="mx-auto flex max-w-3xl gap-2">
            <input
              className="flex-1 rounded-md border border-slate-300 px-4 py-2.5 text-sm outline-none focus:border-slate-500"
              placeholder="输入问题，Enter 发送…"
              value={input}
              onChange={(e) => setInput(e.target.value)}
              disabled={generating}
            />
            <button
              type="submit"
              disabled={generating || !input.trim()}
              className="rounded-md bg-slate-900 px-5 py-2.5 text-sm text-white hover:bg-slate-800 disabled:opacity-50"
            >
              发送
            </button>
          </form>
        </div>
      </div>
    </div>
  );
}
