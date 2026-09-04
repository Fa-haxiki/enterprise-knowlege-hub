import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { api } from '@/lib/api';
import DocPreviewModal, { type DocPreview } from '@/components/DocPreviewModal';
import DocTypeIcon from '@/components/DocTypeIcon';

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
 * BM25 原始分无上限、不可直接读成「多相关」。
 * 以本页最高段落分为 100%，其余按比例换算，命中项至少显示 1%。
 */
function relevancePercent(score: number, maxScore: number): number {
  if (maxScore <= 0) return 0;
  return Math.max(1, Math.round((score / maxScore) * 100));
}

/** 排名加权平均：第 k 段权重 1/k，综合整篇而不只取最高段，弱段也不会把分拉太低 */
function rankWeightedScore(scores: number[]): number {
  let num = 0;
  let den = 0;
  scores.forEach((s, i) => {
    const w = 1 / (i + 1);
    num += s * w;
    den += w;
  });
  return den > 0 ? num / den : 0;
}

interface DocGroup {
  document_id: string;
  title: string;
  title_highlights: string[];
  combinedScore: number;
  chunks: ChunkHit[];
}

/** 同一文档的分片收成一组，组内按相关度降序，文档按综合分排序 */
function groupHitsByDocument(hits: ChunkHit[]): DocGroup[] {
  const map = new Map<string, DocGroup>();
  for (const hit of hits) {
    const existing = map.get(hit.document_id);
    if (!existing) {
      map.set(hit.document_id, {
        document_id: hit.document_id,
        title: hit.title,
        title_highlights: hit.title_highlights,
        combinedScore: 0,
        chunks: [hit],
      });
      continue;
    }
    existing.chunks.push(hit);
    if (!existing.title_highlights.length && hit.title_highlights.length) {
      existing.title_highlights = hit.title_highlights;
    }
  }
  for (const g of map.values()) {
    g.chunks.sort((a, b) => b.score - a.score);
    g.combinedScore = rankWeightedScore(g.chunks.map((c) => c.score));
  }
  return [...map.values()].sort((a, b) => b.combinedScore - a.combinedScore);
}

const SCORE_COL = 'w-[4.75rem] shrink-0 text-right text-[10px] tabular-nums text-ink-300';
const ACTION_COL = 'inline-flex w-3.5 shrink-0 items-center justify-center';

function ScoreLabel({ percent, title }: { percent: number; title?: string }) {
  return (
    <span className={SCORE_COL} title={title}>
      相关度 {percent}%
    </span>
  );
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

  const groups = useMemo(() => groupHitsByDocument(hits), [hits]);
  const maxScore = hits[0]?.score ?? 0;

  const openDocument = async (documentId: string) => {
    try {
      const doc = await api.get<DocPreview>(`/documents/${documentId}/download-url`);
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
            <p className="text-xs text-ink-400">
              共 {groups.length} 篇文档 · {hits.length} 个命中段落
            </p>
          )}

          {!searching &&
            groups.map((group) => (
              <div
                key={group.document_id}
                className="overflow-hidden rounded-card border border-border bg-card shadow-card"
              >
                <button
                  type="button"
                  onClick={() => void openDocument(group.document_id)}
                  className="group flex w-full items-center gap-2 px-4 py-3 text-left transition-colors hover:bg-subtle/60"
                >
                  <DocTypeIcon title={group.title} size={16} className="shrink-0" />
                  <span className="min-w-0 flex-1 truncate text-sm font-medium text-ink-900 group-hover:text-brand-700">
                    {group.title_highlights.length > 0
                      ? group.title_highlights.map((t, i) => <HighlightedText key={i} text={t} />)
                      : `《${group.title}》`}
                  </span>
                  {group.chunks.length > 1 && (
                    <span className="shrink-0 rounded-full bg-subtle px-1.5 py-0.5 text-[10px] text-ink-400">
                      {group.chunks.length} 个段落
                    </span>
                  )}
                  <ScoreLabel
                    percent={relevancePercent(group.combinedScore, maxScore)}
                    title="各命中段落按相关度加权综合，不只取最高段"
                  />
                  <span className={ACTION_COL}>
                    <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="text-brand-600 opacity-0 transition-opacity group-hover:opacity-100">
                      <path d="M7 17 17 7M8 7h9v9" />
                    </svg>
                  </span>
                </button>
                <div className="border-t border-border/70">
                  {group.chunks.map((hit) => {
                    const heading = hit.heading_path.filter(Boolean).join(' / ');
                    return (
                      <button
                        key={hit.chunk_id}
                        type="button"
                        onClick={() => void openDocument(hit.document_id)}
                        className="flex w-full items-start gap-2 border-b border-border/50 px-4 py-2.5 text-left last:border-b-0 transition-colors hover:bg-subtle/50"
                      >
                        <span className="w-4 shrink-0" aria-hidden />
                        <div className="min-w-0 flex-1">
                          {heading ? (
                            <div className="truncate text-[11px] text-ink-400">{heading}</div>
                          ) : null}
                          <p className="mt-0.5 line-clamp-3 text-xs leading-6 text-ink-600">
                            {hit.highlights.length > 0 ? (
                              <>
                                …<HighlightedText text={hit.highlights[0]} />…
                              </>
                            ) : (
                              <span className="text-ink-400">命中在文档标题</span>
                            )}
                          </p>
                        </div>
                        <ScoreLabel percent={relevancePercent(hit.score, maxScore)} />
                        <span className={ACTION_COL} aria-hidden />
                      </button>
                    );
                  })}
                </div>
              </div>
            ))}
        </div>
      </div>

      {preview && <DocPreviewModal doc={preview} onClose={() => setPreview(null)} />}
    </div>
  );
}
