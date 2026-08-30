import { STEP_LABELS, type AgentStep } from './types';

function StepIcon({ status }: { status: AgentStep['status'] }) {
  if (status === 'running') {
    return (
      <span className="inline-block h-3 w-3 animate-spin rounded-full border-[1.5px] border-brand-600/30 border-t-brand-600" />
    );
  }
  if (status === 'degraded') {
    return (
      <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" className="text-amber-500">
        <path d="M12 9v4m0 4h.01M10.3 3.9 1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0Z" />
      </svg>
    );
  }
  return (
    <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" className="text-emerald-500">
      <path d="M20 6 9 17l-5-5" />
    </svg>
  );
}

/** Agent 工作步骤条：由 AG-UI STEP_STARTED/STEP_FINISHED 事件驱动 */
export default function AgentSteps({ steps }: { steps: AgentStep[] }) {
  if (steps.length === 0) return null;
  return (
    <div className="mb-3 flex flex-wrap items-center gap-1.5">
      {steps.map((s, i) => (
        <div key={`${s.name}-${i}`} className="flex items-center gap-1.5">
          {i > 0 && <span className="text-ink-400/50">›</span>}
          <span
            className={`inline-flex items-center gap-1.5 rounded-full border px-2 py-0.5 text-xs transition-colors ${
              s.status === 'running'
                ? 'border-brand-600/30 bg-brand-50 text-brand-700'
                : s.status === 'degraded'
                  ? 'border-amber-500/30 bg-amber-50 text-amber-700 dark:bg-amber-500/10 dark:text-amber-400'
                  : 'border-border bg-subtle text-ink-600'
            }`}
            title={s.detail}
          >
            <StepIcon status={s.status} />
            {STEP_LABELS[s.name] ?? s.name}
            {s.latencyMs != null && (
              <span className="text-ink-400">{(s.latencyMs / 1000).toFixed(1)}s</span>
            )}
          </span>
          {s.status === 'running' && s.detail && (
            <span className="text-xs text-ink-400">{s.detail}</span>
          )}
        </div>
      ))}
    </div>
  );
}
