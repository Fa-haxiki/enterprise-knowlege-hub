import { useState } from 'react';
import { STEP_LABELS, type AgentStep, type ToolCallInfo } from './types';

interface ExecutionTraceProps {
  steps?: AgentStep[];
  toolCalls?: ToolCallInfo[];
  nodeLatencies?: Record<string, number> | null;
  degraded?: string[];
  latencyMs?: number | null;
  tokens?: number;
  streaming?: boolean;
}

function RowIcon({ status }: { status: AgentStep['status'] }) {
  if (status === 'running') {
    return (
      <span className="inline-block h-3 w-3 shrink-0 animate-spin rounded-full border-[1.5px] border-brand-600/30 border-t-brand-600" />
    );
  }
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

function parseHistoryName(key: string): { name: string; round: number } {
  const m = key.match(/^(.*)#(\d+)$/);
  if (!m) return { name: key, round: 0 };
  return { name: m[1], round: Number(m[2]) };
}

/**
 * 本轮过程：按发生顺序展示，同名步骤带轮次。
 */
export default function ExecutionTrace({
  steps,
  toolCalls,
  nodeLatencies,
  degraded,
  latencyMs,
  tokens,
  streaming,
}: ExecutionTraceProps) {
  const [collapsed, setCollapsed] = useState(false);

  const all: AgentStep[] =
    steps && steps.length > 0
      ? steps
      : Object.entries(nodeLatencies ?? {}).map(([key, ms]) => {
          const { name } = parseHistoryName(key);
          return {
            name,
            status: (degraded?.includes(name) ? 'degraded' : 'done') as AgentStep['status'],
            startedAt: 0,
            latencyMs: ms,
            detail: key.includes('#') ? `第 ${parseHistoryName(key).round + 1} 轮` : undefined,
          };
        });

  const counts = new Map<string, number>();
  const rows = all
    .filter((s) => s.status === 'running' || (s.latencyMs ?? 0) >= 50 || !!s.detail)
    .map((s) => {
      const n = (counts.get(s.name) ?? 0) + 1;
      counts.set(s.name, n);
      return { ...s, round: n };
    });

  if (rows.length === 0) return null;

  const totalMs = latencyMs ?? rows.reduce((sum, r) => sum + (r.latencyMs ?? 0), 0);
  const hasDegraded = rows.some((r) => r.status === 'degraded');
  const doneCount = rows.filter((r) => r.status !== 'running').length;
  const multi = [...counts.values()].some((n) => n > 1);

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
        本轮过程
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
                {multi && s.round > 1 && (
                  <span className="rounded bg-subtle px-1 text-[10px] text-ink-400">第 {s.round} 轮</span>
                )}
                {s.status === 'degraded' && <span className="text-ink-400">（已降级）</span>}
                {s.detail && <span className="truncate text-ink-400">{s.detail}</span>}
                {!s.detail && toolCalls?.find((t) => t.name === s.name)?.summary && (
                  <span className="truncate text-ink-400">
                    {toolCalls.find((t) => t.name === s.name)?.summary}
                  </span>
                )}
                <span className="ml-auto tabular-nums text-ink-400">
                  {s.latencyMs != null ? `${(s.latencyMs / 1000).toFixed(1)}s` : ''}
                </span>
              </div>
            ))}
          </div>
          <div className="mt-2 flex items-center gap-1.5 border-t border-border pt-2 text-xs text-ink-400">
            {streaming ? (
              <>
                <span className="inline-block h-3 w-3 animate-spin rounded-full border-[1.5px] border-brand-600/30 border-t-brand-600" />
                <span>执行中 · 已完成 {doneCount}/{rows.length} 步</span>
              </>
            ) : (
              <>
                {hasDegraded ? (
                  <span className="text-amber-600 dark:text-amber-400">部分降级</span>
                ) : (
                  <span className="text-emerald-600 dark:text-emerald-400">已完成</span>
                )}
                <span>· {(totalMs / 1000).toFixed(1)}s</span>
                {tokens != null && tokens > 0 && <span>· {tokens} tokens</span>}
              </>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
