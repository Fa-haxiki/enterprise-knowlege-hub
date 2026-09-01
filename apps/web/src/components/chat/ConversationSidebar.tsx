import { useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import type { Conversation } from './types';

interface Props {
  conversations: Conversation[];
  activeId?: string;
  loading: boolean;
  /** 是否还有更多历史对话可加载 */
  hasMore: boolean;
  loadingMore: boolean;
  onLoadMore(): void;
  onRename(id: string, title: string): Promise<void>;
  onRemove(id: string): Promise<void>;
}

export default function ConversationSidebar({ conversations, activeId, loading, hasMore, loadingMore, onLoadMore, onRename, onRemove }: Props) {
  const navigate = useNavigate();
  const [keyword, setKeyword] = useState('');
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editingTitle, setEditingTitle] = useState('');

  // 平铺列表：后端已按 updated_at 倒序返回（最新 → 最旧），不再按日期分组
  const filtered = useMemo(() => {
    const kw = keyword.trim().toLowerCase();
    return kw ? conversations.filter((c) => c.title.toLowerCase().includes(kw)) : conversations;
  }, [conversations, keyword]);

  const submitRename = async () => {
    if (!editingId) return;
    const title = editingTitle.trim();
    if (title) await onRename(editingId, title);
    setEditingId(null);
  };

  return (
    <div className="flex w-64 flex-col border-r border-border bg-card">
      <div className="space-y-2 border-b border-border p-3">
        <button
          onClick={() => navigate('/chat')}
          className="flex w-full items-center justify-center gap-1.5 rounded-lg bg-brand-600 py-2 text-sm font-medium text-white shadow-sm transition-colors hover:bg-brand-700"
        >
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round">
            <path d="M12 5v14M5 12h14" />
          </svg>
          新对话
        </button>
        <div className="relative">
          <svg
            width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round"
            className="pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2 text-ink-400"
          >
            <circle cx="11" cy="11" r="7" />
            <path d="m21 21-4.3-4.3" />
          </svg>
          <input
            value={keyword}
            onChange={(e) => setKeyword(e.target.value)}
            placeholder="搜索对话…"
            className="w-full rounded-lg border border-border bg-subtle/50 py-1.5 pl-8 pr-2 text-xs outline-none transition-colors placeholder:text-ink-400 focus:border-brand-500 focus:bg-card"
          />
        </div>
      </div>

      <div
        className="flex-1 overflow-y-auto p-2"
        onScroll={(e) => {
          const el = e.currentTarget;
          // 搜索时只过滤已加载数据，不触发翻页
          if (!keyword && hasMore && !loadingMore && el.scrollHeight - el.scrollTop - el.clientHeight < 60) {
            onLoadMore();
          }
        }}
      >
        {loading ? (
          <div className="space-y-2 p-1">
            {Array.from({ length: 6 }).map((_, i) => (
              <div key={i} className="skeleton h-8 rounded-lg" />
            ))}
          </div>
        ) : filtered.length === 0 ? (
          <p className="py-10 text-center text-xs text-ink-400">
            {keyword ? '没有匹配的对话' : '暂无对话'}
          </p>
        ) : (
          filtered.map((c) => (
            <div
              key={c.id}
              className={`group relative flex items-center rounded-lg transition-colors ${
                c.id === activeId ? 'bg-brand-600/10 text-brand-700' : 'text-ink-600 hover:bg-subtle'
              }`}
            >
              {editingId === c.id ? (
                <input
                  autoFocus
                  className="m-1 w-full rounded-md border border-brand-500 bg-card px-2 py-1.5 text-sm outline-none"
                  value={editingTitle}
                  onChange={(e) => setEditingTitle(e.target.value)}
                  onBlur={() => void submitRename()}
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
                        setEditingId(c.id);
                        setEditingTitle(c.title);
                      }}
                      className="rounded-md bg-card/80 p-1 text-ink-400 shadow-sm hover:text-ink-900"
                      title="重命名"
                    >
                      <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                        <path d="M17 3a2.85 2.83 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5Z" />
                      </svg>
                    </button>
                    <button
                      onClick={(e) => {
                        e.stopPropagation();
                        void onRemove(c.id);
                      }}
                      className="rounded-md bg-card/80 p-1 text-ink-400 shadow-sm hover:text-red-500"
                      title="删除"
                    >
                      <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                        <path d="M3 6h18" />
                        <path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6" />
                        <path d="M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2" />
                      </svg>
                    </button>
                  </div>
                </>
              )}
            </div>
          ))
        )}
        {loadingMore && (
          <div className="flex items-center justify-center gap-1.5 py-2 text-xs text-ink-400">
            <span className="h-3 w-3 animate-spin rounded-full border border-ink-400/30 border-t-ink-400" />
            加载更多…
          </div>
        )}
      </div>
    </div>
  );
}
