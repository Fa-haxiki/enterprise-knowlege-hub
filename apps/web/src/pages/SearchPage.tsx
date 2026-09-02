import { useCallback, useEffect, useRef, useState } from 'react';
import { api } from '@/lib/api';
import DocPreviewModal, { type DocPreview } from '@/components/DocPreviewModal';

interface ChunkHit {
  chunk_id: string;
  document_id: string;
  workspace_id: string;
  title: string;
  heading_path: string[];
  score: number;
  title_highlights: string[];
  highlights: string[];
}

interface WorkspaceOption {
  id: string;
  name: string;
}

/**
 * ES 高亮片段渲染：先整体转义防 XSS，再把 ES 的 <em> 占位还原成 <mark>。
 * 命中样式由 [&_mark] 任意变体提供。
 */
function HighlightedText({ text }: { text: string }) {
  const html = text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    // ES standard 分词把中文拆成单字，相邻 <em> 合并避免"报销"被标成两段
    .replace(/&lt;\/em&gt;&lt;em&gt;/g, '')
    .replace(/&lt;em&gt;/g, '<mark>')
    .replace(/&lt;\/em&gt;/g, '</mark>');
  return (
    <span
      className="[&_mark]:bg-amber-200/70 [&_mark]:font-medium [&_mark]:text-amber-900 dark:[&_mark]:bg-amber-500/30 dark:[&_mark]:text-amber-200"
      dangerouslySetInnerHTML={{ __html: html }}
    />
  );
}

/** 文档搜索：跨空间关键词检索分片，高亮命中段落，点击打开原文档预览 */
export default function SearchPage() {
  const [keyword, setKeyword] = useState('');
  const [workspaceId, setWorkspaceId] = useState('');
  const [docType, setDocType] = useState('');
  const [dateFrom, setDateFrom] = useState('');
  const [dateTo, setDateTo] = useState('');
  const [workspaces, setWorkspaces] = useState<WorkspaceOption[]>([]);
  const [hits, setHits] = useState<ChunkHit[]>([]);
  const [searching, setSearching] = useState(false);
  const [searched, setSearched] = useState(false);
  const [preview, setPreview] = useState<DocPreview | null>(null);
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    api
      .get<WorkspaceOption[]>('/workspaces')
      .then(setWorkspaces)
      .catch(() => undefined);
  }, []);

  const search = useCallback(
    async (q: string, wsId: string, type: string, from: string, to: string) => {
      const query = q.trim();
      if (!query) {
        setHits([]);
        setSearched(false);
        return;
      }
      setSearching(true);
      try {
        const params = new URLSearchParams({ q: query, limit: '20' });
        if (wsId) params.set('workspace_id', wsId);
        if (type) params.set('type', type);
        if (from) params.set('date_from', from);
        if (to) params.set('date_to', to);
        const d = await api.get<{ total: number; items: ChunkHit[] }>(`/search/chunks?${params}`);
        setHits(d.items);
        setSearched(true);
      } catch {
        /* 检索失败保持旧结果 */
      } finally {
        setSearching(false);
      }
    },
    [],
  );

  // 输入防抖 300ms 自动搜索；切换筛选条件立即搜索
  useEffect(() => {
    if (debounceRef.current) clearTimeout(debounceRef.current);
    debounceRef.current = setTimeout(() => void search(keyword, workspaceId, docType, dateFrom, dateTo), 300);
    return () => {
      if (debounceRef.current) clearTimeout(debounceRef.current);
    };
  }, [keyword, workspaceId, docType, dateFrom, dateTo, search]);

  const hasFilter = workspaceId || docType || dateFrom || dateTo;
  const clearFilters = () => {
    setWorkspaceId('');
    setDocType('');
    setDateFrom('');
    setDateTo('');
  };

  const openDocument = async (hit: ChunkHit) => {
    try {
      const doc = await api.get<DocPreview>(`/documents/${hit.document_id}/download-url`);
      setPreview(doc);
    } catch {
      /* 无权限或文档已删除时静默 */
    }
  };

  return (
    <div className="flex h-full flex-col overflow-hidden">
      {/* 搜索区 */}
      <div className="border-b border-border bg-card px-6 py-5">
        <div className="mx-auto max-w-5xl">
          <h1 className="mb-1 text-lg font-semibold text-ink-900">智能搜索</h1>
          <p className="mb-4 text-xs text-ink-400">在你有权限的知识空间中检索文档分片，高亮命中段落，点击可打开原文档</p>
          {/* 搜索框与筛选条件同一行：控件等高 h-10，窄屏自动换行 */}
          <div className="flex flex-wrap items-center gap-2">
            <div className="relative min-w-52 flex-1">
              <svg
                width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round"
                className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-ink-400"
              >
                <circle cx="11" cy="11" r="7" />
                <path d="m21 21-4.3-4.3" />
              </svg>
              <input
                autoFocus
                value={keyword}
                onChange={(e) => setKeyword(e.target.value)}
                placeholder="输入关键词，如：差旅报销标准"
                className="h-10 w-full rounded-xl border border-border bg-subtle/50 pl-9 pr-3 text-sm outline-none transition-colors placeholder:text-ink-400 focus:border-brand-500 focus:bg-card"
              />
            </div>
            <select
              value={workspaceId}
              onChange={(e) => setWorkspaceId(e.target.value)}
              className="h-10 rounded-xl border border-border bg-subtle/50 px-2.5 text-xs text-ink-600 outline-none transition-colors focus:border-brand-500"
            >
              <option value="">全部空间</option>
              {workspaces.map((w) => (
                <option key={w.id} value={w.id}>{w.name}</option>
              ))}
            </select>
            <select
              value={docType}
              onChange={(e) => setDocType(e.target.value)}
              className="h-10 rounded-xl border border-border bg-subtle/50 px-2.5 text-xs text-ink-600 outline-none transition-colors focus:border-brand-500"
            >
              <option value="">全部类型</option>
              <option value="pdf">PDF</option>
              <option value="word">Word</option>
              <option value="excel">Excel</option>
              <option value="ppt">PPT</option>
              <option value="md">Markdown</option>
              <option value="txt">TXT</option>
              <option value="html">HTML</option>
            </select>
            <div className="flex h-10 items-center gap-1.5 rounded-xl border border-border bg-subtle/50 px-2.5 text-xs text-ink-600 transition-colors focus-within:border-brand-500">
              <span className="text-ink-400">入库时间</span>
              <input
                type="date"
                value={dateFrom}
                onChange={(e) => setDateFrom(e.target.value)}
                onClick={(e) => e.currentTarget.showPicker()}
                className="cursor-pointer bg-transparent outline-none"
              />
              <span className="text-ink-300">→</span>
              <input
                type="date"
                value={dateTo}
                min={dateFrom || undefined}
                onChange={(e) => setDateTo(e.target.value)}
                onClick={(e) => e.currentTarget.showPicker()}
                className="cursor-pointer bg-transparent outline-none"
              />
            </div>
            {hasFilter && (
              <button
                onClick={clearFilters}
                className="flex h-10 items-center gap-1 rounded-xl px-2.5 text-xs text-ink-400 transition-colors hover:bg-subtle hover:text-ink-600"
              >
                <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round"><path d="M18 6 6 18M6 6l12 12" /></svg>
                清除筛选
              </button>
            )}
          </div>
        </div>
      </div>

      {/* 结果区 */}
      <div className="flex-1 overflow-y-auto px-6 py-5">
        <div className="mx-auto max-w-5xl space-y-3">
          {searching && (
            <div className="space-y-3">
              {Array.from({ length: 3 }).map((_, i) => (
                <div key={i} className="skeleton h-24 rounded-card" />
              ))}
            </div>
          )}

          {!searching && searched && hits.length === 0 && (
            <div className="flex flex-col items-center gap-2 py-16 text-ink-400">
              <svg width="36" height="36" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round">
                <circle cx="11" cy="11" r="7" />
                <path d="m21 21-4.3-4.3" />
              </svg>
              <p className="text-sm">未找到包含「{keyword.trim()}」的文档段落</p>
              <p className="text-xs">换个关键词试试，或确认文档已完成解析入库</p>
            </div>
          )}

          {!searching && !searched && (
            <div className="py-16 text-center text-xs text-ink-400">
              输入关键词后自动搜索，仅检索你有权限访问的空间
            </div>
          )}

          {!searching && searched && hits.length > 0 && (
            <p className="text-xs text-ink-400">共 {hits.length} 个命中分片</p>
          )}

          {!searching &&
            hits.map((hit) => (
              <button
                key={hit.chunk_id}
                onClick={() => void openDocument(hit)}
                className="group w-full rounded-card border border-border bg-card px-4 py-3 text-left shadow-card transition-all hover:border-brand-500/40 hover:shadow-pop"
              >
                {/* 标题行：文档名 + 相关度 + 打开箭头（hover 出现） */}
                <div className="flex items-center gap-2">
                  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="shrink-0 text-brand-600">
                    <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
                    <path d="M14 2v6h6" />
                  </svg>
                  <span className="truncate text-sm font-medium text-ink-900 group-hover:text-brand-700">
                    {hit.title_highlights.length > 0
                      ? hit.title_highlights.map((t, i) => <HighlightedText key={i} text={t} />)
                      : `《${hit.title}》`}
                  </span>
                  <span className="ml-auto shrink-0 text-[10px] tabular-nums text-ink-300">
                    相关度 {hit.score.toFixed(1)}
                  </span>
                  <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="shrink-0 text-brand-600 opacity-0 transition-opacity group-hover:opacity-100">
                    <path d="M7 17 17 7M8 7h9v9" />
                  </svg>
                </div>
                {/* 章节路径 */}
                {hit.heading_path.filter(Boolean).length > 0 && (
                  <div className="mt-1 truncate pl-6 text-[11px] text-ink-400">
                    {hit.heading_path.filter(Boolean).join(' / ')}
                  </div>
                )}
                {/* 最佳命中片段（ES 按相关度排序，只取第一段，避免大段文字堆砌） */}
                <p className="mt-1.5 line-clamp-3 pl-6 text-xs leading-6 text-ink-600">
                  {hit.highlights.length > 0 ? (
                    <>
                                      …<HighlightedText text={hit.highlights[0]} />…
                    </>
                  ) : (
                    <span className="text-ink-400">命中在文档标题</span>
                  )}
                </p>
              </button>
            ))}
        </div>
      </div>

      {preview && <DocPreviewModal doc={preview} onClose={() => setPreview(null)} />}
    </div>
  );
}
