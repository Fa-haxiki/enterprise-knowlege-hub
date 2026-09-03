import { useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import GraphCanvas from '@/components/graph/GraphCanvas';
import { graphPageUrl, relLabel, typeMeta, type GraphNode, type GraphSubgraph } from '@/lib/graph';
import type { Triple } from './types';

interface Props {
  subgraph?: GraphSubgraph | null;
  triples?: Triple[];
}

/**
 * 聊天内的图谱推理面板：默认折叠为「推理链路 N 条」，展开后为紧凑力导向图 + 链路列表。
 * 有子图（按实体 id）时以子图为准；只有历史三元组时降级为纯列表。
 */
export default function GraphPathPanel({ subgraph, triples }: Props) {
  const [open, setOpen] = useState(false);
  const [selected, setSelected] = useState<GraphNode | null>(null);

  const hasGraph = !!subgraph && subgraph.nodes.length > 0 && subgraph.edges.length > 0;
  const count = hasGraph ? subgraph!.edges.length : (triples?.length ?? 0);

  const nameOf = useMemo(() => {
    const m = new Map<string, GraphNode>();
    for (const n of subgraph?.nodes ?? []) m.set(n.id, n);
    return m;
  }, [subgraph]);

  /** 展示用链路：子图边按 (source, relation, target) → 名字；选中节点后只保留与其相连的边 */
  const rows = useMemo(() => {
    if (hasGraph) {
      return subgraph!.edges
        .filter((e) => !selected || e.source === selected.id || e.target === selected.id)
        .map((e) => ({
          key: `${e.source}|${e.relation}|${e.target}`,
          from: nameOf.get(e.source),
          to: nameOf.get(e.target),
          fromName: nameOf.get(e.source)?.name ?? e.source,
          toName: nameOf.get(e.target)?.name ?? e.target,
          relation: e.relation,
          weight: e.weight ?? 1,
        }));
    }
    return (triples ?? []).map(([from, rel, to], i) => ({
      key: `${from}|${rel}|${to}|${i}`,
      from: undefined,
      to: undefined,
      fromName: from,
      toName: to,
      relation: rel,
      weight: 1,
    }));
  }, [hasGraph, subgraph, triples, selected, nameOf]);

  if (count === 0) return null;

  /** 「在图谱中打开」：优先选中实体，其次第一个起点；跨空间子图取该实体所属空间 */
  const focus = selected ?? subgraph?.nodes.find((n) => subgraph.seeds?.includes(n.id)) ?? subgraph?.nodes[0];
  const openHref = focus?.workspace_id ? graphPageUrl({ workspace: focus.workspace_id, entity: focus.id }) : null;

  return (
    <div className="mt-3 overflow-hidden rounded-xl border border-border bg-card">
      <button
        onClick={() => setOpen((v) => !v)}
        className="flex w-full items-center gap-2 px-3 py-2 text-left text-xs transition-colors hover:bg-subtle"
      >
        <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="text-brand-600">
          <circle cx="5" cy="6" r="2.5" /><circle cx="19" cy="6" r="2.5" /><circle cx="12" cy="18" r="2.5" />
          <path d="M7 7.5 10.5 16M17 7.5 13.5 16M7.5 6h9" />
        </svg>
        <span className="font-medium text-ink-900">图谱推理链路</span>
        <span className="text-ink-400">{count} 条</span>
        {hasGraph && <span className="text-ink-400">· {subgraph!.nodes.length} 个实体</span>}
        <svg
          width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"
          className={`ml-auto text-ink-400 transition-transform ${open ? 'rotate-180' : ''}`}
        >
          <path d="m6 9 6 6 6-6" />
        </svg>
      </button>

      {open && (
        <div className="border-t border-border">
          {hasGraph && (
            <div className="h-64 border-b border-border bg-white dark:bg-black/20">
              <GraphCanvas
                data={subgraph!}
                selectedId={selected?.id ?? null}
                onSelect={setSelected}
                compact
                legend
              />
            </div>
          )}
          <div className="max-h-52 space-y-0.5 overflow-y-auto p-2">
            <div className="flex items-center justify-between px-1 pb-1 text-[11px] text-ink-400">
              <span>{selected ? `「${selected.name}」的关联链路（${rows.length} 条）` : `全部链路（${rows.length} 条）`}</span>
              {selected && (
                <button onClick={() => setSelected(null)} className="rounded px-1.5 py-0.5 transition-colors hover:bg-subtle hover:text-ink-600">
                  显示全部
                </button>
              )}
            </div>
            {rows.map((r) => (
              <div key={r.key} className="flex items-center gap-1 rounded-md px-1 py-1 text-xs transition-colors hover:bg-subtle">
                <EntityChip node={r.from} name={r.fromName} active={selected?.id === r.from?.id} onClick={() => r.from && setSelected((cur) => (cur?.id === r.from!.id ? null : r.from!))} />
                <span className="shrink-0 text-[11px] text-brand-600">
                  —{relLabel(r.relation)}{r.weight > 1 ? ` ×${r.weight}` : ''}→
                </span>
                <EntityChip node={r.to} name={r.toName} active={selected?.id === r.to?.id} onClick={() => r.to && setSelected((cur) => (cur?.id === r.to!.id ? null : r.to!))} />
              </div>
            ))}
          </div>
          {openHref && (
            <div className="flex items-center justify-between border-t border-border px-3 py-1.5 text-[11px] text-ink-400">
              <span>点击实体可筛选链路</span>
              <Link to={openHref} className="font-medium text-brand-600 hover:underline">
                在图谱中打开 →
              </Link>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function EntityChip({
  node,
  name,
  active,
  onClick,
}: {
  node?: GraphNode;
  name: string;
  active: boolean;
  onClick: () => void;
}) {
  const meta = node ? typeMeta(node.type) : null;
  return (
    <button
      onClick={onClick}
      disabled={!node}
      title={node ? `${name}（${meta!.label}）` : name}
      className={`flex max-w-[40%] items-center gap-1 truncate rounded px-1.5 py-0.5 font-medium transition-colors ${
        active
          ? 'bg-brand-600/15 text-brand-700'
          : 'bg-subtle text-ink-600 enabled:hover:bg-brand-600/10 enabled:hover:text-brand-700'
      }`}
    >
      {meta && <span className="inline-block h-1.5 w-1.5 shrink-0 rounded-full" style={{ background: meta.color }} />}
      <span className="truncate">{name}</span>
    </button>
  );
}
