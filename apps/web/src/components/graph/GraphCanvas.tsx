import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import ForceGraph2D, { type ForceGraphMethods, type LinkObject, type NodeObject } from 'react-force-graph-2d';
import { forceCollide } from 'd3-force';
import { useThemeStore } from '@/store/theme';
import { ENTITY_TYPES, relLabel, typeMeta, type GraphNode, type GraphSubgraph } from '@/lib/graph';

interface GNode extends NodeObject {
  id: string;
  name: string;
  type: GraphNode['type'];
  degree: number;
  data: GraphNode;
}

interface GLink extends LinkObject {
  source: string | GNode;
  target: string | GNode;
  relation: string;
  label: string;
  weight: number;
  /** 平行边曲率：同对节点的多条边按序号错开（0 为直线） */
  curvature: number;
}

type FG = ForceGraphMethods<NodeObject<GNode>, LinkObject<GNode, GLink>>;

interface GraphCanvasProps {
  data: GraphSubgraph;
  /** 当前选中实体：其它无关节点/边淡化 */
  selectedId?: string | null;
  /** 需要强调的实体（推理起点 / 邻域中心）：描边光环 */
  highlightIds?: string[];
  onSelect?: (node: GraphNode | null) => void;
  /** 双击节点：展开邻居（由父组件合并子图） */
  onExpand?: (node: GraphNode) => void;
  /** 紧凑模式（聊天面板）：更短的标签、更小的字号 */
  compact?: boolean;
  /** 图例开关 */
  legend?: boolean;
  className?: string;
  emptyText?: string;
}

/** 暗色模式调色板：canvas 绘制不吃 Tailwind 暗色类，需按主题显式切换 */
const PALETTE = {
  light: {
    nodeStroke: '#1e1b4b',
    nodeText: '#1c1917',
    nodeTextDim: '#c7c3c0',
    link: '#d6d3d1',
    linkActive: '#6366f1',
    linkLabel: '#a8a29e',
    linkLabelActive: '#4f46e5',
    halo: 'rgba(99, 102, 241, 0.28)',
    labelBg: 'rgba(255,255,255,0.82)',
  },
  dark: {
    nodeStroke: '#e0e7ff',
    nodeText: '#e7e5e4',
    nodeTextDim: '#57534e',
    link: '#44403c',
    linkActive: '#818cf8',
    linkLabel: '#78716c',
    linkLabelActive: '#c7d2fe',
    halo: 'rgba(129, 140, 248, 0.32)',
    labelBg: 'rgba(28,25,23,0.82)',
  },
} as const;

const radiusOf = (degree: number) => Math.min(5 + Math.sqrt(degree) * 2.2, 14);
const truncate = (s: string, max: number) => (s.length > max ? `${s.slice(0, max)}…` : s);
const idOf = (v: string | GNode) => (typeof v === 'object' ? v.id : v);

/**
 * 通用力导向图：节点按实体类型着色、按度数定半径，边带箭头与中文关系名，
 * 平行边自动弯曲；支持选中淡化、光环高亮、双击展开。
 * 节点对象跨数据更新复用（保留坐标），展开邻居时已有节点不会重新飞散。
 */
export default function GraphCanvas({
  data,
  selectedId,
  highlightIds,
  onSelect,
  onExpand,
  compact = false,
  legend = true,
  className = '',
  emptyText = '暂无图谱数据',
}: GraphCanvasProps) {
  const wrapRef = useRef<HTMLDivElement>(null);
  const fgRef = useRef<FG | undefined>(undefined);
  const nodeCache = useRef(new Map<string, GNode>());
  const needsFit = useRef(true);
  const [{ width, height }, setSize] = useState({ width: 0, height: 0 });
  const [hoverId, setHoverId] = useState<string | null>(null);

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

  const labelMax = compact ? 6 : 10;

  const { nodes, links } = useMemo(() => {
    const cache = nodeCache.current;
    const next = new Map<string, GNode>();
    const degree = new Map<string, number>();
    for (const e of data.edges) {
      degree.set(e.source, (degree.get(e.source) ?? 0) + 1);
      degree.set(e.target, (degree.get(e.target) ?? 0) + 1);
    }
    for (const n of data.nodes) {
      const d = Math.max(n.degree ?? 0, degree.get(n.id) ?? 0);
      const cached = cache.get(n.id);
      if (cached) {
        cached.name = n.name;
        cached.type = n.type;
        cached.degree = d;
        cached.data = n;
        next.set(n.id, cached);
      } else {
        next.set(n.id, { id: n.id, name: n.name, type: n.type, degree: d, data: n });
      }
    }
    // 新节点出生在某个已有邻居旁边，避免从原点飞入
    for (const e of data.edges) {
      const s = next.get(e.source);
      const t = next.get(e.target);
      if (!s || !t) continue;
      const seed = (from: GNode, to: GNode) => {
        if (to.x == null && from.x != null && from.y != null) {
          to.x = from.x + (Math.random() - 0.5) * 40;
          to.y = from.y + (Math.random() - 0.5) * 40;
        }
      };
      seed(s, t);
      seed(t, s);
    }
    nodeCache.current = next;

    const links: GLink[] = [];
    const seen = new Set<string>();
    for (const e of data.edges) {
      if (!next.has(e.source) || !next.has(e.target)) continue;
      const key = `${e.source}|${e.relation}|${e.target}`;
      if (seen.has(key)) continue;
      seen.add(key);
      const weight = e.weight ?? 1;
      links.push({
        source: e.source,
        target: e.target,
        relation: e.relation,
        label: weight > 1 ? `${relLabel(e.relation)} ×${weight}` : relLabel(e.relation),
        weight,
        curvature: 0,
      });
    }
    // 平行边曲率分配：同对节点（不区分方向）的第 2/3/4… 条边交替向两侧弯曲
    const pairCount = new Map<string, number>();
    for (const l of links) {
      const key = [idOf(l.source), idOf(l.target)].sort().join('~');
      const idx = pairCount.get(key) ?? 0;
      pairCount.set(key, idx + 1);
      if (idx > 0) l.curvature = Math.ceil(idx / 2) * 0.22 * (idx % 2 === 0 ? 1 : -1);
    }
    needsFit.current = true;
    return { nodes: [...next.values()], links };
  }, [data]);

  // 力参数：大斥力 + 长连线 + 按标签宽度碰撞，三重防重叠
  useEffect(() => {
    const fg = fgRef.current;
    if (!fg) return;
    (fg.d3Force('charge') as { strength?: (v: number) => void } | undefined)?.strength?.(compact ? -220 : -360);
    (fg.d3Force('link') as { distance?: (v: number) => void } | undefined)?.distance?.(compact ? 80 : 120);
    fg.d3Force(
      'collide',
      forceCollide((node) => {
        const n = node as GNode;
        const labelHalf = (Math.min(n.name.length, labelMax) * (compact ? 8 : 10)) / 2;
        return radiusOf(n.degree) + labelHalf + 6;
      }),
    );
    fg.d3ReheatSimulation();
  }, [width, height, nodes.length, links.length, compact, labelMax]);

  const neighborIds = useMemo(() => {
    if (!selectedId) return null;
    const set = new Set<string>([selectedId]);
    for (const l of links) {
      const s = idOf(l.source);
      const t = idOf(l.target);
      if (s === selectedId) set.add(t);
      if (t === selectedId) set.add(s);
    }
    return set;
  }, [links, selectedId]);

  const highlight = useMemo(() => new Set(highlightIds ?? data.seeds ?? []), [highlightIds, data.seeds]);

  const isDark = useThemeStore((s) => s.theme === 'dark');
  const pal = isDark ? PALETTE.dark : PALETTE.light;

  const drawNode = useCallback(
    (node: GNode, ctx: CanvasRenderingContext2D, globalScale: number) => {
      if (node.x == null || node.y == null) return;
      const dimmed = !!neighborIds && !neighborIds.has(node.id);
      const r = radiusOf(node.degree);
      const meta = typeMeta(node.type);
      const fill = isDark ? meta.colorDark : meta.color;
      const isSelected = node.id === selectedId;
      const isHover = node.id === hoverId;

      if (highlight.has(node.id) && !dimmed) {
        ctx.beginPath();
        ctx.arc(node.x, node.y, r + 5 / Math.sqrt(globalScale), 0, 2 * Math.PI);
        ctx.fillStyle = pal.halo;
        ctx.fill();
      }

      ctx.beginPath();
      ctx.arc(node.x, node.y, r, 0, 2 * Math.PI);
      ctx.globalAlpha = dimmed ? 0.25 : 1;
      ctx.fillStyle = fill;
      ctx.fill();
      if (isSelected || isHover) {
        ctx.lineWidth = (isSelected ? 2.2 : 1.4) / globalScale;
        ctx.strokeStyle = pal.nodeStroke;
        ctx.stroke();
      }
      ctx.globalAlpha = 1;

      const label = isSelected || isHover ? node.name : truncate(node.name, labelMax);
      const fontSize = Math.max((compact ? 9 : 10.5) / globalScale, 2.5);
      ctx.font = `${isSelected ? '600 ' : ''}${fontSize}px system-ui, sans-serif`;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'top';
      const ty = node.y + r + 2.5 / globalScale;
      if (!dimmed && (isSelected || isHover)) {
        const w = ctx.measureText(label).width;
        ctx.fillStyle = pal.labelBg;
        ctx.fillRect(node.x - w / 2 - 2 / globalScale, ty - 1 / globalScale, w + 4 / globalScale, fontSize + 2 / globalScale);
      }
      ctx.fillStyle = dimmed ? pal.nodeTextDim : pal.nodeText;
      ctx.fillText(label, node.x, ty);
    },
    [neighborIds, selectedId, hoverId, highlight, isDark, pal, labelMax, compact],
  );

  /** 命中区域：自绘节点必须同步给 force-graph 的指针检测层，否则点击只认默认半径 */
  const paintPointerArea = useCallback((node: GNode, color: string, ctx: CanvasRenderingContext2D) => {
    if (node.x == null || node.y == null) return;
    ctx.beginPath();
    ctx.arc(node.x, node.y, radiusOf(node.degree) + 4, 0, 2 * Math.PI);
    ctx.fillStyle = color;
    ctx.fill();
  }, []);

  const drawLink = useCallback(
    (link: GLink, ctx: CanvasRenderingContext2D, globalScale: number) => {
      const s = link.source as GNode;
      const t = link.target as GNode;
      if (s.x == null || t.x == null || s.y == null || t.y == null) return;
      const active = !neighborIds || (neighborIds.has(s.id) && neighborIds.has(t.id) && (s.id === selectedId || t.id === selectedId));
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
        labelX = 0.25 * s.x + 0.5 * cx + 0.25 * t.x;
        labelY = 0.25 * s.y + 0.5 * cy + 0.25 * t.y;
        tipDirX = t.x - cx;
        tipDirY = t.y - cy;
      }
      ctx.globalAlpha = active ? 1 : 0.25;
      ctx.lineWidth = (active && selectedId ? 1.8 : Math.min(0.8 + link.weight * 0.25, 2.2)) / globalScale;
      ctx.strokeStyle = active && selectedId ? pal.linkActive : pal.link;
      ctx.stroke();

      // 方向箭头：画在目标节点边缘，沿边的终点切线方向
      const targetR = radiusOf(t.degree ?? 0);
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
      ctx.fillStyle = active && selectedId ? pal.linkActive : pal.linkLabel;
      ctx.fill();

      // 关系名：缩得太小时不画，避免一团噪点
      if (globalScale * (compact ? 1.4 : 1) >= 0.55) {
        const fontSize = Math.max((compact ? 8 : 9) / globalScale, 2);
        ctx.font = `${fontSize}px system-ui, sans-serif`;
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.fillStyle = active && selectedId ? pal.linkLabelActive : pal.linkLabel;
        ctx.fillText(link.label, labelX, labelY);
      }
      ctx.globalAlpha = 1;
    },
    [neighborIds, selectedId, pal, compact],
  );

  const presentTypes = useMemo(() => {
    const set = new Set(nodes.map((n) => n.type));
    return ENTITY_TYPES.filter((t) => set.has(t));
  }, [nodes]);

  return (
    <div ref={wrapRef} className={`relative h-full w-full overflow-hidden ${className}`}>
      {nodes.length === 0 ? (
        <div className="flex h-full items-center justify-center text-xs text-ink-400">{emptyText}</div>
      ) : (
        width > 0 &&
        height > 0 && (
          <ForceGraph2D
            ref={fgRef}
            width={width}
            height={height}
            graphData={{ nodes, links }}
            nodeCanvasObject={drawNode}
            nodePointerAreaPaint={paintPointerArea}
            nodeLabel={(n) => {
              const node = n as GNode;
              const meta = typeMeta(node.type);
              const desc = node.data.description ? `<div style="opacity:.75;margin-top:2px;max-width:240px">${node.data.description}</div>` : '';
              return `<div style="font-size:12px"><b>${node.name}</b> <span style="opacity:.6">${meta.label}</span>${desc}</div>`;
            }}
            linkCanvasObject={drawLink}
            linkCanvasObjectMode={() => 'replace'}
            onNodeClick={(node) => {
              const n = node as GNode;
              onSelect?.(selectedId === n.id ? null : n.data);
            }}
            onNodeRightClick={(node) => onExpand?.((node as GNode).data)}
            onNodeHover={(node) => setHoverId(node ? (node as GNode).id : null)}
            onBackgroundClick={() => onSelect?.(null)}
            cooldownTicks={compact ? 120 : 200}
            onEngineStop={() => {
              if (!needsFit.current) return;
              needsFit.current = false;
              fgRef.current?.zoomToFit(400, compact ? 24 : 48);
            }}
            enableNodeDrag
            enableZoomInteraction
            enablePanInteraction
            backgroundColor="rgba(0,0,0,0)"
          />
        )
      )}

      {legend && presentTypes.length > 0 && (
        <div className="pointer-events-none absolute bottom-2 left-2 flex flex-wrap gap-x-3 gap-y-1 rounded-md bg-card/80 px-2 py-1 text-[11px] text-ink-600 backdrop-blur">
          {presentTypes.map((t) => {
            const meta = typeMeta(t);
            return (
              <span key={t} className="flex items-center gap-1">
                <span className="inline-block h-2 w-2 rounded-full" style={{ background: isDark ? meta.colorDark : meta.color }} />
                {meta.label}
              </span>
            );
          })}
          {onExpand && <span className="text-ink-400">右键节点展开邻居</span>}
        </div>
      )}
    </div>
  );
}
