import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import ForceGraph2D, {
  type ForceGraphMethods,
  type LinkObject,
  type NodeObject,
} from 'react-force-graph-2d';
import { forceCollide } from 'd3-force';
import { useThemeStore } from '@/store/theme';
import type { Triple } from './types';

/** 关系类型英文 → 中文（LLM 抽取的自由动词，未命中时降级为原文小写分词） */
const REL_ZH: Record<string, string> = {
  PARTICIPATES_IN: '参与',
  SUPPLIES_TO: '供应给',
  SIGNED_WITH: '签约',
  USES_SUPPLIER: '选用供应商',
  OWNED_BY: '归属于',
  GOVERNED_BY: '受约束于',
  PUBLISHES: '发布',
  SERVES: '服务于',
  WORKS_FOR: '任职于',
  BELONGS_TO: '隶属于',
  COOPERATES_WITH: '合作',
  MANAGES: '管理',
  RESPONSIBLE_FOR: '负责',
  INVOLVES: '涉及',
  APPROVES: '审批',
  MENTIONS: '提及',
};

function relLabel(rel: string): string {
  return REL_ZH[rel] ?? rel.toLowerCase().replace(/_/g, ' ');
}

interface GNode extends NodeObject {
  id: string;
  degree: number;
}
interface GLink extends LinkObject {
  source: string | GNode;
  target: string | GNode;
  label: string;
  /** 平行边曲率：同对节点的多条边按序号错开（0 为直线） */
  curvature: number;
}

/** 节点配色：按度数在品牌色系内区分 */
const NODE_FILL = '#6366f1';
const NODE_FILL_ACTIVE = '#4f46e5';
const NODE_FILL_DIM = '#c7d2fe';

/** 暗色模式调色板：canvas 绘制不吃 Tailwind 暗色类，需按主题显式切换 */
const PALETTE = {
  light: {
    nodeActive: NODE_FILL_ACTIVE,
    nodeDim: NODE_FILL_DIM,
    nodeStroke: '#312e81',
    nodeText: '#1e1b4b',
    nodeTextDim: '#a5b4fc',
    link: '#e0e7ff',
    linkActive: '#818cf8',
    linkLabel: '#c7d2fe',
    linkLabelActive: '#4f46e5',
  },
  dark: {
    nodeActive: '#818cf8',
    nodeDim: '#3730a3',
    nodeStroke: '#c7d2fe',
    nodeText: '#e0e7ff',
    nodeTextDim: '#6366f1',
    link: '#4338ca',
    linkActive: '#818cf8',
    linkLabel: '#818cf8',
    linkLabelActive: '#c7d2fe',
  },
} as const;

function truncate(name: string, max = 8): string {
  return name.length > max ? `${name.slice(0, max)}…` : name;
}

/** 图谱推理链路可视化：力导向图，节点可拖拽，点击节点查看关联链路 */
export default function GraphView({ triples }: { triples: Triple[] }) {
  const wrapRef = useRef<HTMLDivElement>(null);
  const fgRef = useRef<ForceGraphMethods<NodeObject<GNode>, LinkObject<GNode, GLink>> | undefined>(
    undefined,
  );
  const [{ width, height }, setSize] = useState({ width: 0, height: 0 });
  const [selected, setSelected] = useState<string | null>(null);

  useEffect(() => {
    const el = wrapRef.current;
    if (!el) return;
    const ro = new ResizeObserver((entries) => {
      const rect = entries[0].contentRect;
      setSize({ width: rect.width, height: rect.height });
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  // 力参数：大斥力 + 长连线 + 按标签宽度碰撞，三重防重叠
  useEffect(() => {
    const fg = fgRef.current;
    if (!fg) return;
    (fg.d3Force('charge') as { strength?: (v: number) => void } | undefined)?.strength?.(-320);
    (fg.d3Force('link') as { distance?: (v: number) => void } | undefined)?.distance?.(110);
    fg.d3Force(
      'collide',
      forceCollide((node) => {
        const n = node as GNode;
        const r = Math.min(5 + n.degree * 1.5, 12);
        const labelHalf = (Math.min(n.id.length, 8) * 10) / 2;
        return r + labelHalf + 8;
      }),
    );
    fg.d3ReheatSimulation();
  }, [width, height]);

  const { nodes, links } = useMemo(() => {
    const nodeMap = new Map<string, GNode>();
    const links: GLink[] = [];
    const seen = new Set<string>();
    for (const [from, rel, to] of triples) {
      // 防御性去重：相同三元组只保留一条
      const dedupKey = `${from}
el`;
      if (seen.has(dedupKey)) continue;
      seen.add(dedupKey);
      if (!nodeMap.has(from)) nodeMap.set(from, { id: from, degree: 0 });
      if (!nodeMap.has(to)) nodeMap.set(to, { id: to, degree: 0 });
      nodeMap.get(from)!.degree++;
      nodeMap.get(to)!.degree++;
      links.push({ source: from, target: to, label: relLabel(rel), curvature: 0 });
    }
    // 平行边曲率分配：同对节点（不区分方向）的第 2/3/4… 条边交替向两侧弯曲
    const pairCount = new Map<string, number>();
    for (const l of links) {
      const key = [String(l.source), String(l.target)].sort().join('~');
      const idx = pairCount.get(key) ?? 0;
      pairCount.set(key, idx + 1);
      if (idx > 0) l.curvature = Math.ceil(idx / 2) * 0.22 * (idx % 2 === 0 ? 1 : -1);
    }
    return { nodes: [...nodeMap.values()], links };
  }, [triples]);

  /** 与选中节点关联的链路 */
  const related = useMemo(() => {
    if (!selected) return [];
    return triples.filter((t) => t[0] === selected || t[2] === selected);
  }, [triples, selected]);

  const isRelated = useCallback(
    (l: GLink) => {
      if (!selected) return true;
      const s = typeof l.source === 'object' ? l.source.id : l.source;
      const t = typeof l.target === 'object' ? l.target.id : l.target;
      return s === selected || t === selected;
    },
    [selected],
  );

  const isDark = useThemeStore((s) => s.theme === 'dark');
  const pal = isDark ? PALETTE.dark : PALETTE.light;

  const drawNode = useCallback(
    (node: GNode, ctx: CanvasRenderingContext2D, globalScale: number) => {
      const dimmed = selected && node.id !== selected && !related.some((t) => t[0] === node.id || t[2] === node.id);
      const r = Math.min(5 + node.degree * 1.5, 12);
      const label = truncate(node.id);
      const fontSize = Math.max(10 / globalScale, 2.5);

      ctx.beginPath();
      ctx.arc(node.x!, node.y!, r, 0, 2 * Math.PI);
      ctx.fillStyle = dimmed ? pal.nodeDim : node.id === selected ? pal.nodeActive : NODE_FILL;
      ctx.fill();
      if (node.id === selected) {
        ctx.lineWidth = 2 / globalScale;
        ctx.strokeStyle = pal.nodeStroke;
        ctx.stroke();
      }

      ctx.font = `${fontSize}px sans-serif`;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'top';
      ctx.fillStyle = dimmed ? pal.nodeTextDim : pal.nodeText;
      ctx.fillText(label, node.x!, node.y! + r + 2 / globalScale);
    },
    [selected, related, pal],
  );

  const drawLink = useCallback(
    (link: GLink, ctx: CanvasRenderingContext2D, globalScale: number) => {
      const s = link.source as GNode;
      const t = link.target as GNode;
      if (s.x == null || t.x == null || s.y == null || t.y == null) return;
      const active = isRelated(link);
      const k = link.curvature;

      ctx.beginPath();
      ctx.moveTo(s.x, s.y);
      let labelX: number;
      let labelY: number;
      let tipDirX: number;
      let tipDirY: number;
      if (k === 0) {
        ctx.lineTo(t.x, t.y);
        labelX = (s.x + t.x) / 2;
        labelY = (s.y + t.y) / 2;
        tipDirX = t.x - s.x;
        tipDirY = t.y - s.y;
      } else {
        // 二次贝塞尔：控制点沿中点法线偏移 k × 边长
        const mx = (s.x + t.x) / 2;
        const my = (s.y + t.y) / 2;
        const dx = t.x - s.x;
        const dy = t.y - s.y;
        const len = Math.hypot(dx, dy) || 1;
        const cx = mx + (-dy / len) * k * len;
        const cy = my + (dx / len) * k * len;
        ctx.quadraticCurveTo(cx, cy, t.x, t.y);
        // 曲线 t=0.5 处坐标：0.25s + 0.5c + 0.25t
        labelX = 0.25 * s.x + 0.5 * cx + 0.25 * t.x;
        labelY = 0.25 * s.y + 0.5 * cy + 0.25 * t.y;
        // 贝塞尔终点切线方向 = 终点 - 控制点
        tipDirX = t.x - cx;
        tipDirY = t.y - cy;
      }
      ctx.lineWidth = (active && selected ? 1.6 : 1) / globalScale;
      ctx.strokeStyle = active ? pal.linkActive : pal.link;
      ctx.stroke();

      // 方向箭头：画在目标节点边缘，沿边的终点切线方向
      const targetR = Math.min(5 + (t.degree ?? 0) * 1.5, 12);
      const dLen = Math.hypot(tipDirX, tipDirY) || 1;
      const ux = tipDirX / dLen;
      const uy = tipDirY / dLen;
      const tipX = t.x - ux * (targetR + 1.5 / globalScale);
      const tipY = t.y - uy * (targetR + 1.5 / globalScale);
      const arrowLen = 7 / globalScale;
      const arrowW = 5 / globalScale;
      const baseX = tipX - ux * arrowLen;
      const baseY = tipY - uy * arrowLen;
      ctx.beginPath();
      ctx.moveTo(tipX, tipY);
      ctx.lineTo(baseX - uy * (arrowW / 2), baseY + ux * (arrowW / 2));
      ctx.lineTo(baseX + uy * (arrowW / 2), baseY - ux * (arrowW / 2));
      ctx.closePath();
      ctx.fillStyle = active ? pal.linkActive : pal.linkLabel;
      ctx.fill();

      const fontSize = Math.max(9 / globalScale, 2);
      ctx.font = `${fontSize}px sans-serif`;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillStyle = active ? pal.linkLabelActive : pal.linkLabel;
      ctx.fillText(link.label, labelX, labelY);
    },
    [isRelated, selected, pal],
  );

  // 右侧列表：未选中显示全部链路，选中后过滤为关联链路
  const listed = selected ? related : triples;

  return (
    <div className="flex h-full w-full gap-3">
      {/* 左侧：关系图 */}
      <div ref={wrapRef} className="min-w-0 flex-1 overflow-hidden rounded-lg border border-brand-600/15 bg-white dark:bg-black/20">
        {width > 0 && height > 0 && (
          <ForceGraph2D
            ref={fgRef}
            width={width}
            height={height}
            graphData={{ nodes, links }}
            nodeCanvasObject={drawNode}
            linkCanvasObject={drawLink}
            linkCanvasObjectMode={() => 'replace'}
            onNodeClick={(node) => setSelected((cur) => (cur === (node as GNode).id ? null : ((node as GNode).id)))}
            cooldownTicks={150}
            onEngineStop={() => fgRef.current?.zoomToFit(500, 48)}
            enableNodeDrag
            enableZoomInteraction
            enablePanInteraction
            backgroundColor="rgba(0,0,0,0)"
          />
        )}
      </div>

      {/* 右侧：关联链路列表 */}
      <div className="flex w-72 shrink-0 flex-col rounded-lg border border-border bg-card">
        <div className="flex items-center justify-between border-b border-border px-3 py-2.5">
          <span className="text-xs font-medium text-ink-900">
            {selected ? `「${selected}」的关联链路` : '全部链路'}
            <span className="ml-1 text-ink-400">（{listed.length} 条）</span>
          </span>
          {selected && (
            <button
              onClick={() => setSelected(null)}
              className="rounded px-1.5 py-0.5 text-xs text-ink-400 transition-colors hover:bg-subtle hover:text-ink-600"
            >
              显示全部
            </button>
          )}
        </div>
        <div className="min-h-0 flex-1 space-y-1 overflow-y-auto p-2.5">
          {listed.map((t, i) => (
            <div key={i} className="flex items-center rounded-md px-1 py-1 text-xs transition-colors hover:bg-subtle">
              <button
                onClick={() => setSelected((cur) => (cur === t[0] ? null : t[0]))}
                className={`max-w-[38%] truncate rounded px-1.5 py-0.5 font-medium transition-colors ${
                  t[0] === selected ? 'bg-brand-600/15 text-brand-700' : 'bg-subtle text-ink-600 hover:bg-brand-600/10 hover:text-brand-700'
                }`}
                title={t[0]}
              >
                {t[0]}
              </button>
              <span className="mx-1 shrink-0 text-[11px] text-brand-600">—{relLabel(t[1])}→</span>
              <button
                onClick={() => setSelected((cur) => (cur === t[2] ? null : t[2]))}
                className={`max-w-[38%] truncate rounded px-1.5 py-0.5 font-medium transition-colors ${
                  t[2] === selected ? 'bg-brand-600/15 text-brand-700' : 'bg-subtle text-ink-600 hover:bg-brand-600/10 hover:text-brand-700'
                }`}
                title={t[2]}
              >
                {t[2]}
              </button>
            </div>
          ))}
        </div>
        <div className="border-t border-border px-3 py-2 text-[11px] text-ink-400">
          点击左侧节点或列表实体名可筛选
        </div>
      </div>
    </div>
  );
}
