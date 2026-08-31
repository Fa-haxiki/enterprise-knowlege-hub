import { useState } from 'react';
import { STEP_LABELS, STEP_ORDER, type AgentStep } from './types';

interface ExecutionTraceProps {
  /** 流式消息的实时步骤（含状态与耗时） */
  steps?: AgentStep[];
  /** 历史消息：各节点耗时（usage 事件 / 消息接口带出） */
  nodeLatencies?: Record<string, number> | null;
  degraded?: string[];
  latencyMs?: number | null;
  tokens?: number;
}

function RowIcon({ status }: { status: AgentStep['status'] }) {
  if (status === 'degraded') {
    return (
      <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" className="shrink-0 text-amber-500">
        <path d="M12 9v4m0 4h.01M10.3 3.9 1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0Z" />
      </svg>
    );
  }
  return (
    <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" className="shrink-0 text-emerald-500">
      <path d="M20 6 9 17l-5-5" />
    </svg>
  );
}

/**
 * 执行链路面板：回答完成后展示完整 Agent 链路（纵向步骤 + 耗时 + 汇总），
 * 数据优先取实时 steps，历史消息由 node_latencies 重建。
 */
export default function ExecutionTrace({
  steps,
  nodeLatencies,
  degraded,
  latencyMs,
  tokens,
}: ExecutionTraceProps) {
  const [collapsed, setCollapsed] = useState(false);

  const all: AgentStep[] =
    steps && steps.length > 0
      ? steps
      : Object.entries(nodeLatencies ?? {}).map(([name, ms]) => ({
          name,
          status: (degraded?.includes(name) ? 'degraded' : 'done') as AgentStep['status'],
          startedAt: 0,
          latencyMs: ms,
        }));

  // 隐藏瞬时完成的内部节点（权限校验/加载对话等 <50ms），只展示有实际耗时的核心步骤；
  // 并按真实执行顺序排序（node_latencies 的 key 顺序是 state 合并序，不可靠）
  const orderOf = (name: string) => {
    const i = STEP_ORDER.indexOf(name);
    return i === -1 ? STEP_ORDER.length : i;
  };
  const rows = all
    .filter((s) => (s.latencyMs ?? 0) >= 50)
    .sort((a, b) => orderOf(a.name) - orderOf(b.name));

  if (rows.length === 0) return null;

  const totalMs = latencyMs ?? rows.reduce((sum, r) => sum + (r.latencyMs ?? 0), 0);
  const hasDegraded = rows.some((r) => r.status === 'degraded');

  return (
    <div className="mb-3 overflow-hidden rounded-xl border border-border bg-card">
      <button
        onClick={() => setCollapsed((v) => !v)}
        className="flex w-full items-center gap-2 px-3 py-2 text-xs font-medium text-ink-600 transition-colors hover:bg-subtle/60"
      >
        <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="text-brand-600">
          <path d="M4 17l6-6-6-6" />
          <path d="M12 19h8" />
        </svg>
        执行链路
        <span className="text-ink-400">共 {rows.length} 步</span>
        <svg
          width="12"
          height="12"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
          strokeLinecap="round"
          strokeLinejoin="round"
          className={`ml-auto text-ink-400 transition-transform ${collapsed ? '' : 'rotate-180'}`}
        >
          <path d="m18 15-6-6-6 6" />
        </svg>
      </button>

      {!collapsed && (
        <div className="border-t border-border px-3 py-2">
          <div className="space-y-1.5">
            {rows.map((s, i) => (
              <div key={`${s.name}-${i}`} className="flex items-center gap-2 text-xs">
                <RowIcon status={s.status} />
                <span className={s.status === 'degraded' ? 'text-amber-600 dark:text-amber-400' : 'text-ink-700 dark:text-ink-300'}>
                  {STEP_LABELS[s.name] ?? s.name}
                </span>
                {s.status === 'degraded' && <span className="text-ink-400">（已降级）</span>}
                <span className="ml-auto tabular-nums text-ink-400">
                  {s.latencyMs != null ? `${(s.latencyMs / 1000).toFixed(1)}s` : ''}
                </span>
              </div>
            ))}
          </div>
          <div className="mt-2 flex items-center gap-1.5 border-t border-border pt-2 text-xs text-ink-400">
            {hasDegraded ? (
              <span className="text-amber-600 dark:text-amber-400">部分降级</span>
            ) : (
              <span className="text-emerald-600 dark:text-emerald-400">已完成</span>
            )}
            <span>· {(totalMs / 1000).toFixed(1)}s</span>
            {tokens != null && tokens > 0 && <span>· {tokens} tokens</span>}
          </div>
        </div>
      )}
    </div>
  );
}
