import { useEffect, useMemo, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { api, ApiError } from '@/lib/api';
import GraphView, { type GraphViewLink, type GraphViewNode } from '@/components/chat/GraphView';

interface GraphNode {
  id: string;
  name: string;
  type: string | null;
  description: string | null;
}

interface GraphEdge {
  source: string;
  target: string;
  relation: string;
  weight: number;
}

const ENTITY_TYPE_OPTIONS: { value: string; label: string }[] = [
  { value: '', label: '全部类型' },
  { value: 'PERSON', label: '人物' },
  { value: 'DEPARTMENT', label: '部门' },
  { value: 'PROJECT', label: '项目' },
  { value: 'COMPANY', label: '公司' },
  { value: 'PRODUCT', label: '产品' },
  { value: 'DOCUMENT', label: '文档' },
];

/** 知识空间内的图谱浏览：只展示当前空间子图，不跨空间 */
export default function GraphPage() {
  const { workspaceId } = useParams<{ workspaceId: string }>();
  const navigate = useNavigate();
  const [wsName, setWsName] = useState('');
  const [nodes, setNodes] = useState<GraphNode[]>([]);
  const [edges, setEdges] = useState<GraphEdge[]>([]);
  const [type, setType] = useState('');
  const [keyword, setKeyword] = useState('');
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  useEffect(() => {
    if (!workspaceId) return;
    let cancelled = false;
    setLoading(true);
    setError('');

    const load = async () => {
      try {
        const [wsList, nodeRes, edgeRes] = await Promise.all([
          api.get<{ id: string; name: string }[]>('/workspaces'),
          api.get<{ items: GraphNode[] }>(`/workspaces/${workspaceId}/graph/nodes?limit=500`),
          api.get<{ items: GraphEdge[] }>(`/workspaces/${workspaceId}/graph/edges?limit=1000`),
        ]);
        if (cancelled) return;
        const ws = wsList.find((w) => w.id === workspaceId);
        if (!ws) {
          navigate('/workspaces', { replace: true });
          return;
        }
        setWsName(ws.name);
        setNodes(nodeRes.items);
        setEdges(edgeRes.items);
      } catch (err) {
        if (cancelled) return;
        if (err instanceof ApiError && err.status === 403) {
          navigate('/workspaces', { replace: true });
          return;
        }
        setError(err instanceof ApiError ? err.message : '图谱加载失败');
      } finally {
        if (!cancelled) setLoading(false);
      }
    };

    void load();
    return () => {
      cancelled = true;
    };
  }, [workspaceId, navigate]);

  const graph = useMemo(() => {
    const kw = keyword.trim().toLowerCase();
    const visible = new Set(
      nodes
        .filter((n) => (!type || n.type === type) && (!kw || n.name.toLowerCase().includes(kw)))
        .map((n) => n.id),
    );
    const graphNodes: GraphViewNode[] = nodes
      .filter((n) => visible.has(n.id))
      .map((n) => ({ id: n.id, name: n.name, type: n.type }));
    const links: GraphViewLink[] = edges
      .filter((e) => visible.has(e.source) && visible.has(e.target))
      .map((e) => ({ source: e.source, target: e.target, relation: e.relation }));
    return { nodes: graphNodes, links };
  }, [nodes, edges, type, keyword]);

  return (
    <div className="flex h-full flex-col overflow-hidden p-6">
      <nav className="mb-4 flex items-center gap-2 rounded-card border border-border bg-card px-4 py-3 shadow-card">
        <Link
          to="/workspaces"
          className="flex items-center gap-1.5 rounded-lg py-1 pr-2 text-sm font-medium text-ink-600 transition-colors hover:text-brand-600"
        >
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <path d="m15 18-6-6 6-6" />
          </svg>
          知识空间
        </Link>
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="text-ink-300">
          <path d="m9 18 6-6-6-6" />
        </svg>
        <Link
          to={`/workspaces/${workspaceId}/documents`}
          className="truncate text-sm font-medium text-ink-600 transition-colors hover:text-brand-600"
        >
          {wsName || '文档'}
        </Link>
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="text-ink-300">
          <path d="m9 18 6-6-6-6" />
        </svg>
        <span className="truncate text-sm font-semibold text-ink-900">知识图谱</span>
        <span className="ml-auto hidden text-xs text-ink-400 sm:block">
          仅本空间文档抽取的实体与关系
        </span>
      </nav>

      <div className="mb-4 flex flex-wrap items-center gap-2">
        <select
          className="rounded-lg border border-border bg-card px-3 py-2 text-sm text-ink-600 outline-none transition-colors focus:border-brand-500"
          value={type}
          onChange={(e) => setType(e.target.value)}
        >
          {ENTITY_TYPE_OPTIONS.map((opt) => (
            <option key={opt.value || 'all'} value={opt.value}>
              {opt.label}
            </option>
          ))}
        </select>
        <input
          className="min-w-[200px] flex-1 rounded-lg border border-border bg-card px-3 py-2 text-sm outline-none transition-colors focus:border-brand-500"
          placeholder="搜索实体名称"
          value={keyword}
          onChange={(e) => setKeyword(e.target.value)}
        />
        <span className="text-xs text-ink-400">
          {graph.nodes.length} 个实体 / {graph.links.length} 条关系
        </span>
      </div>

      {error && (
        <p className="mb-4 rounded-lg bg-red-500/10 px-3 py-2 text-sm text-red-600 dark:text-red-400">{error}</p>
      )}

      <div className="min-h-0 flex-1">
        {loading ? (
          <div className="skeleton h-full rounded-card" />
        ) : graph.nodes.length === 0 ? (
          <div className="flex h-full items-center justify-center rounded-card border border-dashed border-border">
            <p className="text-sm text-ink-400">
              {nodes.length === 0 ? '该空间还没有图谱数据，请先入库文档' : '没有符合筛选条件的实体'}
            </p>
          </div>
        ) : (
          <GraphView graph={graph} />
        )}
      </div>
    </div>
  );
}
