import { api } from '@/lib/api';

/** 与后端 @ekh/shared GraphNode / GraphEdge / GraphSubgraph 对齐 */
export type GraphEntityType = 'Project' | 'Supplier' | 'Person' | 'Policy' | 'Department';

export interface GraphNode {
  id: string;
  name: string;
  type: GraphEntityType;
  degree?: number;
  aliases?: string[];
  description?: string;
  mention_count?: number;
  /** 问答子图跨空间，节点带所属空间以便「在图谱中打开」 */
  workspace_id?: string;
}

export interface GraphEdge {
  source: string;
  target: string;
  relation: string;
  weight?: number;
  confidence?: number;
}

export interface GraphSubgraph {
  nodes: GraphNode[];
  edges: GraphEdge[];
  /** 推理起点 / 邻域中心，用于高亮 */
  seeds?: string[];
}

export interface EntityMentionDoc {
  document_id: string;
  title: string;
  chunks: { chunk_id: string; snippet: string; page?: number; heading_path: string[] }[];
}

export interface EntityDetail extends GraphNode {
  workspaceId: string;
  createdAt?: string;
  updatedAt?: string;
  relations: { direction: 'out' | 'in'; relation: string; other: GraphNode; weight: number }[];
  documents: EntityMentionDoc[];
}

export interface GraphStats {
  entities: number;
  entitiesByType: Record<string, number>;
  relations: number;
  documents: number;
}

export const ENTITY_TYPES: GraphEntityType[] = ['Project', 'Supplier', 'Person', 'Policy', 'Department'];

/** 实体类型的中文名与配色（浅/暗色各一组，canvas 绘制不吃 Tailwind 类） */
export const ENTITY_TYPE_META: Record<GraphEntityType, { label: string; color: string; colorDark: string; badge: string }> = {
  Project: { label: '项目', color: '#4f46e5', colorDark: '#818cf8', badge: 'bg-indigo-500/10 text-indigo-600 dark:text-indigo-300' },
  Supplier: { label: '供应商', color: '#0d9488', colorDark: '#2dd4bf', badge: 'bg-teal-500/10 text-teal-700 dark:text-teal-300' },
  Person: { label: '人员', color: '#d97706', colorDark: '#fbbf24', badge: 'bg-amber-500/10 text-amber-700 dark:text-amber-300' },
  Policy: { label: '制度', color: '#db2777', colorDark: '#f472b6', badge: 'bg-pink-500/10 text-pink-700 dark:text-pink-300' },
  Department: { label: '部门', color: '#2563eb', colorDark: '#60a5fa', badge: 'bg-blue-500/10 text-blue-700 dark:text-blue-300' },
};

export function typeMeta(type: string) {
  return ENTITY_TYPE_META[type as GraphEntityType] ?? { label: type, color: '#6b7280', colorDark: '#9ca3af', badge: 'bg-subtle text-ink-600' };
}

/** 关系类型英文 → 中文 */
export const RELATION_ZH: Record<string, string> = {
  USES_SUPPLIER: '选用供应商',
  SERVES: '服务于',
  OWNED_BY: '归属于',
  GOVERNED_BY: '受约束于',
  PUBLISHES: '发布',
  PARTICIPATES_IN: '参与',
  BELONGS_TO: '隶属于',
  MENTIONS: '提及',
};

export function relLabel(rel: string): string {
  return RELATION_ZH[rel] ?? rel.toLowerCase().replace(/_/g, ' ');
}

/** 合并两个子图：节点按 id 去重（保留信息更全的一份），边按 (source, relation, target) 去重 */
export function mergeSubgraphs(base: GraphSubgraph, extra: GraphSubgraph): GraphSubgraph {
  const nodes = new Map(base.nodes.map((n) => [n.id, n]));
  for (const n of extra.nodes) {
    const cur = nodes.get(n.id);
    nodes.set(n.id, cur ? { ...cur, ...n, degree: Math.max(cur.degree ?? 0, n.degree ?? 0) } : n);
  }
  const edgeKey = (e: GraphEdge) => `${e.source}|${e.relation}|${e.target}`;
  const edges = new Map(base.edges.map((e) => [edgeKey(e), e]));
  for (const e of extra.edges) if (!edges.has(edgeKey(e))) edges.set(edgeKey(e), e);
  return { nodes: [...nodes.values()], edges: [...edges.values()], seeds: base.seeds };
}

/** 图谱页跳转链接：带空间与聚焦实体 */
export function graphPageUrl(params: { workspace?: string | null; entity?: string; document?: string }): string {
  const q = new URLSearchParams();
  if (params.workspace) q.set('workspace', params.workspace);
  if (params.entity) q.set('entity', params.entity);
  if (params.document) q.set('document', params.document);
  const s = q.toString();
  return s ? `/graph?${s}` : '/graph';
}

const base = (ws: string) => `/workspaces/${ws}/graph`;

export const graphApi = {
  overview: (ws: string, opts?: { limit?: number; types?: string[] }) => {
    const q = new URLSearchParams();
    if (opts?.limit) q.set('limit', String(opts.limit));
    if (opts?.types?.length) q.set('types', opts.types.join(','));
    const s = q.toString();
    return api.get<GraphSubgraph>(`${base(ws)}/overview${s ? `?${s}` : ''}`);
  },
  search: (ws: string, q: string) =>
    api.get<{ items: GraphNode[] }>(`${base(ws)}/search?q=${encodeURIComponent(q)}`).then((d) => d.items),
  stats: (ws: string) => api.get<GraphStats>(`${base(ws)}/stats`),
  entity: (ws: string, id: string) => api.get<EntityDetail>(`${base(ws)}/entities/${id}`),
  neighbors: (ws: string, id: string, hops = 1) =>
    api.get<GraphSubgraph>(`${base(ws)}/entities/${id}/neighbors?hops=${hops}`),
  document: (ws: string, documentId: string) => api.get<GraphSubgraph>(`${base(ws)}/documents/${documentId}`),
  rebuild: (ws: string) => api.post<{ documents: number }>(`${base(ws)}/rebuild`),
  rebuildAll: () => api.post<{ documents: number; deletedNodes: number }>('/admin/graph/rebuild-all'),
};
