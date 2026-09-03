import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Link, Navigate, useSearchParams } from 'react-router-dom';
import { api, ApiError } from '@/lib/api';
import {
  ENTITY_TYPES,
  graphApi,
  mergeSubgraphs,
  relLabel,
  typeMeta,
  type EntityDetail,
  type GraphEntityType,
  type GraphNode,
  type GraphStats,
  type GraphSubgraph,
} from '@/lib/graph';
import { useAuthStore } from '@/store/auth';
import { useFeaturesStore } from '@/store/features';
import GraphCanvas from '@/components/graph/GraphCanvas';
import DocPreviewModal, { type DocPreview } from '@/components/DocPreviewModal';
import { useConfirm } from '@/components/ConfirmDialog';

interface Workspace {
  id: string;
  name: string;
  role: 'owner' | 'editor' | 'viewer';
}

const EMPTY: GraphSubgraph = { nodes: [], edges: [] };
const OVERVIEW_LIMIT = 150;

/**
 * 知识图谱页：空间概览力导向图 + 实体搜索/类型筛选 + 右侧实体详情面板。
 * URL 参数：workspace（空间）、entity（聚焦实体，加载其邻域并选中）、document（只看某文档抽出的子图）。
 */
export default function GraphPage() {
  const user = useAuthStore((s) => s.user);
  const { flags, loaded } = useFeaturesStore();
  const [searchParams, setSearchParams] = useSearchParams();
  const { confirm, confirmDialog } = useConfirm();

  const wsParam = searchParams.get('workspace');
  const entityParam = searchParams.get('entity');
  const documentParam = searchParams.get('document');

  const [workspaces, setWorkspaces] = useState<Workspace[] | null>(null);
  const [graph, setGraph] = useState<GraphSubgraph>(EMPTY);
  const [stats, setStats] = useState<GraphStats | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [types, setTypes] = useState<GraphEntityType[]>([]);
  const [keyword, setKeyword] = useState('');
  const [results, setResults] = useState<GraphNode[]>([]);
  const [searching, setSearching] = useState(false);
  const [showResults, setShowResults] = useState(false);
  const [selected, setSelected] = useState<GraphNode | null>(null);
  const [detail, setDetail] = useState<EntityDetail | null>(null);
  const [detailLoading, setDetailLoading] = useState(false);
  const [preview, setPreview] = useState<DocPreview | null>(null);
  const [notice, setNotice] = useState('');
  const [rebuilding, setRebuilding] = useState(false);
  const searchBoxRef = useRef<HTMLDivElement>(null);
  /** 已展开过邻居的实体：避免重复请求 */
  const expandedRef = useRef(new Set<string>());

  const workspaceId = wsParam ?? workspaces?.[0]?.id ?? null;
  const workspace = workspaces?.find((w) => w.id === workspaceId) ?? null;
  const canRebuild = !!workspace && (workspace.role === 'owner' || user?.role === 'sysadmin');

  useEffect(() => {
    api
      .get<Workspace[]>('/workspaces')
      .then((list) => {
        setWorkspaces(list);
        if (!wsParam && list[0]) {
          setSearchParams((p) => {
            p.set('workspace', list[0].id);
            return p;
          }, { replace: true });
        }
      })
      .catch(() => setWorkspaces([]));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const setParam = useCallback(
    (patch: Record<string, string | null>, replace = false) => {
      setSearchParams((p) => {
        for (const [k, v] of Object.entries(patch)) {
          if (v == null || v === '') p.delete(k);
          else p.set(k, v);
        }
        return p;
      }, { replace });
    },
    [setSearchParams],
  );

  const describeError = (e: unknown) => {
    if (e instanceof ApiError) {
      if (e.status === 403) return e.message || '无权访问该空间的图谱';
      return e.message;
    }
    return '图谱加载失败';
  };

  /** 主图加载：document 模式取该文档子图，否则取空间概览；entity 参数附带其邻域并选中 */
  useEffect(() => {
    if (!workspaceId) return;
    let cancelled = false;
    setLoading(true);
    setError('');
    setSelected(null);
    setDetail(null);
    expandedRef.current = new Set();
    const base = documentParam
      ? graphApi.document(workspaceId, documentParam)
      : graphApi.overview(workspaceId, { limit: OVERVIEW_LIMIT, types });
    const focus = entityParam ? graphApi.neighbors(workspaceId, entityParam, 1).catch(() => null) : Promise.resolve(null);
    Promise.all([base, focus, graphApi.stats(workspaceId).catch(() => null)])
      .then(([sub, neigh, st]) => {
        if (cancelled) return;
        let merged = sub;
        if (neigh) {
          merged = mergeSubgraphs(sub, neigh);
          merged.seeds = neigh.seeds ?? [entityParam!];
          expandedRef.current.add(entityParam!);
          const node = merged.nodes.find((n) => n.id === entityParam);
          if (node) setSelected(node);
        }
        setGraph(merged);
        setStats(st);
      })
      .catch((e) => !cancelled && setError(describeError(e)))
      .finally(() => !cancelled && setLoading(false));
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [workspaceId, documentParam, entityParam, types.join(',')]);

  // 选中实体 → 拉详情
  useEffect(() => {
    if (!workspaceId || !selected) {
      setDetail(null);
      return;
    }
    let cancelled = false;
    setDetailLoading(true);
    graphApi
      .entity(workspaceId, selected.id)
      .then((d) => !cancelled && setDetail(d))
      .catch(() => !cancelled && setDetail(null))
      .finally(() => !cancelled && setDetailLoading(false));
    return () => {
      cancelled = true;
    };
  }, [workspaceId, selected]);

  // 实体搜索（防抖）
  useEffect(() => {
    if (!workspaceId) return;
    const q = keyword.trim();
    if (!q) {
      setResults([]);
      return;
    }
    let cancelled = false;
    const timer = setTimeout(() => {
      setSearching(true);
      graphApi
        .search(workspaceId, q)
        .then((items) => !cancelled && setResults(items))
        .catch(() => !cancelled && setResults([]))
        .finally(() => !cancelled && setSearching(false));
    }, 250);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [workspaceId, keyword]);

  useEffect(() => {
    const onDown = (e: MouseEvent) => {
      if (!searchBoxRef.current?.contains(e.target as Node)) setShowResults(false);
    };
    document.addEventListener('mousedown', onDown);
    return () => document.removeEventListener('mousedown', onDown);
  }, []);

  useEffect(() => {
    if (!notice) return;
    const t = setTimeout(() => setNotice(''), 4000);
    return () => clearTimeout(t);
  }, [notice]);

  /** 展开邻居：把 1 跳邻域合并进画布（已有节点保留坐标） */
  const expand = useCallback(
    async (node: GraphNode) => {
      if (!workspaceId || expandedRef.current.has(node.id)) return;
      expandedRef.current.add(node.id);
      try {
        const neigh = await graphApi.neighbors(workspaceId, node.id, 1);
        setGraph((g) => mergeSubgraphs(g, neigh));
      } catch (e) {
        setNotice(describeError(e));
      }
    },
    [workspaceId],
  );

  /** 搜索结果点击：聚焦到该实体（URL 带 entity，主图加载时并入其邻域） */
  const focusEntity = (node: GraphNode) => {
    setShowResults(false);
    setKeyword('');
    if (graph.nodes.some((n) => n.id === node.id)) {
      setSelected(node);
      void expand(node);
      return;
    }
    setParam({ entity: node.id, document: null });
  };

  const rebuild = async () => {
    if (!workspaceId || !workspace) return;
    const ok = await confirm({
      title: `重建「${workspace.name}」的图谱`,
      description:
        '将清空该空间的全部实体与关系，并对空间内所有已就绪文档重新执行知识抽取与实体对齐。重建期间图谱不可用，会产生较多 LLM 调用；文档本身与检索索引不受影响。',
      confirmText: '确认重建',
    });
    if (!ok) return;
    setRebuilding(true);
    try {
      const r = await graphApi.rebuild(workspaceId);
      setNotice(`已清空图谱，${r.documents} 篇文档排队重建，稍后刷新查看`);
      setGraph(EMPTY);
      setStats(null);
      setSelected(null);
    } catch (e) {
      setNotice(describeError(e));
    } finally {
      setRebuilding(false);
    }
  };

  const openDocument = async (documentId: string) => {
    try {
      setPreview(await api.get<DocPreview>(`/documents/${documentId}/download-url`));
    } catch {
      setNotice('无法预览该文档');
    }
  };

  const toggleType = (t: GraphEntityType) =>
    setTypes((cur) => (cur.includes(t) ? cur.filter((x) => x !== t) : [...cur, t]));

  const relationGroups = useMemo(() => {
    if (!detail) return [];
    const groups = new Map<string, { label: string; items: EntityDetail['relations'] }>();
    for (const r of detail.relations) {
      const key = `${r.direction}|${r.relation}`;
      const label = r.direction === 'out' ? `${relLabel(r.relation)} →` : `← ${relLabel(r.relation)}`;
      const g = groups.get(key) ?? { label, items: [] };
      g.items.push(r);
      groups.set(key, g);
    }
    return [...groups.values()].map((g) => ({ ...g, items: g.items.sort((a, b) => b.weight - a.weight) }));
  }, [detail]);

  if (loaded && !flags.graph_explorer) return <Navigate to="/chat" replace />;

  return (
    <div className="flex h-full flex-col">
      {/* 顶栏 */}
      <div className="flex flex-wrap items-center gap-2 border-b border-border bg-card px-4 py-2.5">
        <div className="flex items-center gap-2">
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="text-brand-600">
            <circle cx="5" cy="6" r="2.5" /><circle cx="19" cy="6" r="2.5" /><circle cx="12" cy="18" r="2.5" />
            <path d="M7 7.5 10.5 16M17 7.5 13.5 16M7.5 6h9" />
          </svg>
          <span className="text-sm font-semibold text-ink-900">知识图谱</span>
        </div>

        <select
          value={workspaceId ?? ''}
          onChange={(e) => setParam({ workspace: e.target.value, entity: null, document: null })}
          className="rounded-lg border border-border bg-card px-2.5 py-1.5 text-sm text-ink-900 focus:border-brand-500 focus:outline-none"
        >
          {workspaces === null && <option value="">加载中…</option>}
          {workspaces?.length === 0 && <option value="">暂无可访问的空间</option>}
          {workspaces?.map((w) => (
            <option key={w.id} value={w.id}>
              {w.name}
            </option>
          ))}
        </select>

        <div ref={searchBoxRef} className="relative">
          <input
            value={keyword}
            onChange={(e) => {
              setKeyword(e.target.value);
              setShowResults(true);
            }}
            onFocus={() => setShowResults(true)}
            placeholder="搜索实体名 / 别名…"
            className="w-56 rounded-lg border border-border bg-card px-2.5 py-1.5 text-sm text-ink-900 placeholder:text-ink-400 focus:border-brand-500 focus:outline-none"
          />
          {showResults && keyword.trim() && (
            <div className="absolute left-0 top-full z-20 mt-1 max-h-72 w-80 overflow-y-auto rounded-lg border border-border bg-card p-1 shadow-pop">
              {searching && results.length === 0 && <div className="px-2 py-1.5 text-xs text-ink-400">搜索中…</div>}
              {!searching && results.length === 0 && <div className="px-2 py-1.5 text-xs text-ink-400">未找到匹配实体</div>}
              {results.map((n) => {
                const meta = typeMeta(n.type);
                return (
                  <button
                    key={n.id}
                    onClick={() => focusEntity(n)}
                    className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-sm transition-colors hover:bg-subtle"
                  >
                    <span className="inline-block h-2 w-2 shrink-0 rounded-full" style={{ background: meta.color }} />
                    <span className="truncate font-medium text-ink-900">{n.name}</span>
                    <span className={`shrink-0 rounded px-1.5 py-px text-[10px] ${meta.badge}`}>{meta.label}</span>
                    {n.aliases && n.aliases.length > 0 && (
                      <span className="ml-auto truncate text-xs text-ink-400">{n.aliases.slice(0, 2).join(' / ')}</span>
                    )}
                  </button>
                );
              })}
            </div>
          )}
        </div>

        <div className="flex items-center gap-1">
          {ENTITY_TYPES.map((t) => {
            const meta = typeMeta(t);
            const on = types.length === 0 || types.includes(t);
            return (
              <button
                key={t}
                onClick={() => toggleType(t)}
                className={`flex items-center gap-1 rounded-full border px-2 py-0.5 text-xs transition-colors ${
                  on ? 'border-transparent bg-subtle text-ink-900' : 'border-border text-ink-400 line-through'
                }`}
                title={types.includes(t) ? '取消筛选' : '只看此类实体'}
              >
                <span className="inline-block h-1.5 w-1.5 rounded-full" style={{ background: meta.color, opacity: on ? 1 : 0.4 }} />
                {meta.label}
              </button>
            );
          })}
          {types.length > 0 && (
            <button onClick={() => setTypes([])} className="rounded px-1.5 py-0.5 text-xs text-ink-400 hover:bg-subtle hover:text-ink-600">
              清除
            </button>
          )}
        </div>

        <div className="ml-auto flex items-center gap-2">
          {(entityParam || documentParam) && (
            <button
              onClick={() => setParam({ entity: null, document: null })}
              className="rounded-lg border border-border px-2.5 py-1 text-xs text-ink-600 transition-colors hover:bg-subtle"
            >
              {documentParam ? '退出文档视图' : '返回概览'}
            </button>
          )}
          {canRebuild && (
            <button
              onClick={() => void rebuild()}
              disabled={rebuilding}
              className="rounded-lg border border-red-500/30 px-2.5 py-1 text-xs text-red-600 transition-colors hover:bg-red-500/10 disabled:opacity-50 dark:text-red-400"
              title="清空并重建本空间图谱"
            >
              {rebuilding ? '提交中…' : '重建图谱'}
            </button>
          )}
        </div>
      </div>

      {(error || notice) && (
        <div className={`px-4 py-2 text-xs ${error ? 'bg-red-500/10 text-red-600 dark:text-red-400' : 'bg-brand-600/10 text-brand-700'}`}>
          {error || notice}
        </div>
      )}

      {/* 主区 */}
      <div className="flex min-h-0 flex-1">
        <div className="relative min-w-0 flex-1 bg-white dark:bg-black/20">
          {loading && (
            <div className="absolute inset-0 z-10 flex items-center justify-center bg-card/40 text-xs text-ink-400 backdrop-blur-[1px]">
              加载图谱…
            </div>
          )}
          {documentParam && (
            <div className="absolute left-3 top-3 z-10 rounded-md bg-card/90 px-2 py-1 text-[11px] text-ink-600 shadow-card">
              文档视图：仅显示该文档抽出的实体与关系
            </div>
          )}
          <GraphCanvas
            data={graph}
            selectedId={selected?.id ?? null}
            onSelect={setSelected}
            onExpand={(n) => void expand(n)}
            emptyText={
              !workspaceId
                ? '请选择知识空间'
                : loading
                  ? ''
                  : '该空间暂无图谱数据：文档入库完成后自动建图，或在文档页重新入库'
            }
          />
        </div>

        {/* 右侧实体面板 */}
        <aside className="flex w-80 shrink-0 flex-col border-l border-border bg-card">
          {!selected ? (
            <div className="flex flex-1 flex-col items-center justify-center gap-2 p-6 text-center text-xs text-ink-400">
              <svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" className="text-ink-300">
                <circle cx="5" cy="6" r="2.5" /><circle cx="19" cy="6" r="2.5" /><circle cx="12" cy="18" r="2.5" />
                <path d="M7 7.5 10.5 16M17 7.5 13.5 16M7.5 6h9" />
              </svg>
              <div>点击节点查看实体详情</div>
              <div>右键节点展开其邻居；拖拽、滚轮缩放画布</div>
            </div>
          ) : (
            <EntityPanel
              node={selected}
              detail={detail}
              loading={detailLoading}
              relationGroups={relationGroups}
              workspaceId={workspaceId!}
              onClose={() => setSelected(null)}
              onExpand={() => void expand(selected)}
              onJump={(other) => {
                setSelected(other);
                void expand(other);
              }}
              onDocumentGraph={(docId) => setParam({ document: docId, entity: null })}
              onPreview={(docId) => void openDocument(docId)}
            />
          )}
        </aside>
      </div>

      {/* 底部统计 */}
      <div className="flex items-center gap-4 border-t border-border bg-card px-4 py-1.5 text-[11px] text-ink-400">
        <span>
          画布：{graph.nodes.length} 实体 / {graph.edges.length} 关系
          {!documentParam && !entityParam && stats && stats.entities > OVERVIEW_LIMIT && (
            <span className="ml-1">（概览仅显示度数最高的 {OVERVIEW_LIMIT} 个，搜索可定位其余实体）</span>
          )}
        </span>
        {stats && (
          <>
            <span className="text-ink-300">|</span>
            <span>空间：{stats.entities} 实体 · {stats.relations} 关系 · 覆盖 {stats.documents} 篇文档</span>
            <span className="hidden items-center gap-2 md:flex">
              {ENTITY_TYPES.filter((t) => stats.entitiesByType[t]).map((t) => (
                <span key={t} className="flex items-center gap-1">
                  <span className="inline-block h-1.5 w-1.5 rounded-full" style={{ background: typeMeta(t).color }} />
                  {typeMeta(t).label} {stats.entitiesByType[t]}
                </span>
              ))}
            </span>
          </>
        )}
      </div>

      {preview && <DocPreviewModal doc={preview} onClose={() => setPreview(null)} />}
      {confirmDialog}
    </div>
  );
}

interface EntityPanelProps {
  node: GraphNode;
  detail: EntityDetail | null;
  loading: boolean;
  relationGroups: { label: string; items: EntityDetail['relations'] }[];
  workspaceId: string;
  onClose: () => void;
  onExpand: () => void;
  onJump: (node: GraphNode) => void;
  onDocumentGraph: (documentId: string) => void;
  onPreview: (documentId: string) => void;
}

function EntityPanel({ node, detail, loading, relationGroups, workspaceId, onClose, onExpand, onJump, onDocumentGraph, onPreview }: EntityPanelProps) {
  const meta = typeMeta(node.type);
  const aliases = detail?.aliases ?? node.aliases ?? [];
  const description = detail?.description ?? node.description ?? '';
  const mentions = detail?.mention_count ?? node.mention_count;

  return (
    <>
      <div className="border-b border-border p-3">
        <div className="flex items-start gap-2">
          <span className={`mt-0.5 shrink-0 rounded px-1.5 py-px text-[10px] font-medium ${meta.badge}`}>{meta.label}</span>
          <div className="min-w-0 flex-1">
            <div className="break-words text-sm font-semibold text-ink-900">{node.name}</div>
            {aliases.length > 0 && (
              <div className="mt-1 flex flex-wrap gap-1">
                {aliases.map((a) => (
                  <span key={a} className="rounded bg-subtle px-1.5 py-px text-[11px] text-ink-600">
                    {a}
                  </span>
                ))}
              </div>
            )}
          </div>
          <button onClick={onClose} className="rounded p-1 text-ink-400 transition-colors hover:bg-subtle hover:text-ink-600" title="关闭">
            <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <path d="M18 6 6 18M6 6l12 12" />
            </svg>
          </button>
        </div>
        {description && <p className="mt-2 text-xs leading-relaxed text-ink-600">{description}</p>}
        <div className="mt-2 flex items-center gap-3 text-[11px] text-ink-400">
          {mentions != null && <span>被提及 {mentions} 次</span>}
          {detail && <span>{detail.relations.reduce((a, r) => a + r.weight, 0)} 条关系</span>}
          {detail && <span>{detail.documents.length} 篇文档</span>}
        </div>
        <div className="mt-2 flex gap-2">
          <button
            onClick={onExpand}
            className="rounded-lg bg-brand-600 px-2.5 py-1 text-xs font-medium text-white transition-colors hover:bg-brand-700"
          >
            展开邻居
          </button>
        </div>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto">
        {loading && !detail && <div className="p-3 text-xs text-ink-400">加载详情…</div>}
        {detail && (
          <>
            <section className="border-b border-border p-3">
              <div className="mb-1.5 text-xs font-medium text-ink-400">关联关系</div>
              {relationGroups.length === 0 && <div className="text-xs text-ink-400">暂无关系</div>}
              <div className="space-y-2">
                {relationGroups.map((g) => (
                  <div key={g.label}>
                    <div className="mb-0.5 text-[11px] text-brand-600">{g.label}</div>
                    <div className="flex flex-wrap gap-1">
                      {g.items.map((r) => {
                        const m = typeMeta(r.other.type);
                        return (
                          <button
                            key={`${r.direction}-${r.relation}-${r.other.id}`}
                            onClick={() => onJump(r.other)}
                            title={`${r.other.name}（${m.label}）· ${r.weight} 处溯源`}
                            className="flex max-w-full items-center gap-1 rounded-md bg-subtle px-1.5 py-0.5 text-xs text-ink-700 transition-colors hover:bg-brand-600/10 hover:text-brand-700 dark:text-ink-300"
                          >
                            <span className="inline-block h-1.5 w-1.5 shrink-0 rounded-full" style={{ background: m.color }} />
                            <span className="truncate">{r.other.name}</span>
                            {r.weight > 1 && <span className="shrink-0 text-[10px] text-ink-400">×{r.weight}</span>}
                          </button>
                        );
                      })}
                    </div>
                  </div>
                ))}
              </div>
            </section>

            <section className="p-3">
              <div className="mb-1.5 flex items-center justify-between text-xs font-medium text-ink-400">
                <span>提及文档</span>
                <Link to={`/workspaces/${workspaceId}/documents`} className="text-[11px] font-normal text-brand-600 hover:underline">
                  文档管理 →
                </Link>
              </div>
              {detail.documents.length === 0 && <div className="text-xs text-ink-400">暂无溯源分片</div>}
              <div className="space-y-2">
                {detail.documents.map((d) => (
                  <div key={d.document_id} className="rounded-lg border border-border p-2">
                    <div className="flex items-center gap-1">
                      <button
                        onClick={() => onPreview(d.document_id)}
                        className="min-w-0 flex-1 truncate text-left text-xs font-medium text-ink-900 hover:text-brand-700"
                        title="预览文档"
                      >
                        《{d.title}》
                      </button>
                      <button
                        onClick={() => onDocumentGraph(d.document_id)}
                        className="shrink-0 rounded px-1.5 py-0.5 text-[10px] text-ink-400 transition-colors hover:bg-subtle hover:text-brand-600"
                        title="只看该文档抽出的图谱"
                      >
                        文档图谱
                      </button>
                    </div>
                    <div className="mt-1 space-y-1">
                      {d.chunks.slice(0, 3).map((c) => (
                        <div key={c.chunk_id} className="text-[11px] leading-relaxed text-ink-600">
                          {c.heading_path.length > 0 && <span className="text-ink-400">{c.heading_path.join(' › ')} · </span>}
                          {c.page != null && <span className="text-ink-400">P{c.page} · </span>}
                          {c.snippet}
                        </div>
                      ))}
                      {d.chunks.length > 3 && <div className="text-[11px] text-ink-400">… 另有 {d.chunks.length - 3} 处提及</div>}
                    </div>
                  </div>
                ))}
              </div>
            </section>
          </>
        )}
      </div>
    </>
  );
}
