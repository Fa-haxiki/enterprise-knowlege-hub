import { useEffect, useState } from 'react';
import { INTENT_LABELS, STEP_LABELS, localizeTrace, type AgentStep, type ToolCallInfo } from './types';

interface ExecutionTraceProps {
  steps?: AgentStep[];
  toolCalls?: ToolCallInfo[];
  nodeLatencies?: Record<string, number> | null;
  degraded?: string[];
  latencyMs?: number | null;
  tokens?: number;
  streaming?: boolean;
}

const HIDDEN = new Set(['acl_guard', 'prompt_build']);
const TOOL_STEPS = new Set(['kb_retrieve', 'graph_reason', 'web_search']);

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

type Hit = { title?: string; url?: string; snippet?: string; page?: number; score?: number };

function StepBody({ step }: { step: AgentStep }) {
  const output = step.output ?? {};
  const text = typeof output.text === 'string' ? output.text : '';
  const query = typeof output.query === 'string' ? output.query : '';
  const rewritten =
    typeof output.rewrittenQuery === 'string'
      ? output.rewrittenQuery
      : typeof output.suggestedQuery === 'string'
        ? output.suggestedQuery
        : '';
  const intent = typeof output.intent === 'string' ? output.intent : '';
  const grade = typeof output.grade === 'string' ? output.grade : '';
  const reason = typeof output.reason === 'string' ? output.reason : '';
  const tools = Array.isArray(output.tools) ? (output.tools as string[]) : [];
  const memories = Array.isArray(output.memories) ? (output.memories as string[]) : [];
  const webHits = Array.isArray(output.webHits) ? (output.webHits as Hit[]) : [];
  const chunks = Array.isArray(output.chunks) ? (output.chunks as Hit[]) : [];
  const triples = Array.isArray(output.triples) ? (output.triples as [string, string, string][]) : [];
  const entities = Array.isArray(output.entities)
    ? (output.entities as { name?: string; type?: string }[])
    : [];

  const hasRich =
    text ||
    query ||
    rewritten ||
    intent ||
    grade ||
    reason ||
    tools.length ||
    memories.length ||
    webHits.length ||
    chunks.length ||
    triples.length ||
    entities.length;

  if (!hasRich && !step.detail) {
    return <p className="text-ink-400">暂无输出</p>;
  }

  return (
    <div className="space-y-2 text-ink-600">
      {intent && (
        <p>
          <span className="text-ink-400">意图 </span>
          {INTENT_LABELS[intent] ?? localizeTrace(intent)}
        </p>
      )}
      {query && (
        <p>
          <span className="text-ink-400">检索词 </span>
          {query}
        </p>
      )}
      {rewritten && rewritten !== query && (
        <p>
          <span className="text-ink-400">改写 </span>
          {rewritten}
        </p>
      )}
      {grade && (
        <p>
          <span className="text-ink-400">评估 </span>
          {localizeTrace(grade)}
          {reason ? ` · ${localizeTrace(reason)}` : ''}
        </p>
      )}
      {tools.length > 0 && (
        <p>
          <span className="text-ink-400">工具 </span>
          {tools.map((t) => localizeTrace(t)).join('、')}
        </p>
      )}
      {text && <p className="whitespace-pre-wrap leading-5">{text}</p>}
      {memories.length > 0 && (
        <ul className="list-disc space-y-0.5 pl-4">
          {memories.map((m, i) => (
            <li key={i}>{m}</li>
          ))}
        </ul>
      )}
      {entities.length > 0 && (
        <p>
          <span className="text-ink-400">实体 </span>
          {entities.map((e) => e.name).filter(Boolean).join('、')}
        </p>
      )}
      {webHits.length > 0 && (
        <ul className="space-y-1.5">
          {webHits.map((h, i) => (
            <li key={`${h.url ?? h.title ?? i}`} className="min-w-0">
              {h.url ? (
                <a
                  href={h.url}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="font-medium text-brand-700 hover:underline"
                >
                  {h.title || h.url}
                </a>
              ) : (
                <span className="font-medium">{h.title}</span>
              )}
              {h.snippet && <p className="mt-0.5 text-ink-400">{h.snippet}</p>}
            </li>
          ))}
        </ul>
      )}
      {chunks.length > 0 && (
        <ul className="space-y-1.5">
          {chunks.map((c, i) => (
            <li key={`${c.title ?? i}-${i}`}>
              <p className="font-medium">
                {c.title}
                {c.page != null ? <span className="ml-1 font-normal text-ink-400">P{c.page}</span> : null}
                {c.score != null ? (
                  <span className="ml-1 font-normal text-ink-400">{c.score.toFixed(2)}</span>
                ) : null}
              </p>
              {c.snippet && <p className="mt-0.5 text-ink-400">{c.snippet}</p>}
            </li>
          ))}
        </ul>
      )}
      {triples.length > 0 && (
        <ul className="space-y-0.5 text-ink-500">
          {triples.slice(0, 20).map((t, i) => (
            <li key={`${t[0]}-${t[1]}-${t[2]}-${i}`}>
              {t[0]} —{t[1]}→ {t[2]}
            </li>
          ))}
        </ul>
      )}
      {!hasRich && step.detail && <p>{localizeTrace(step.detail)}</p>}
    </div>
  );
}

function StepRow({
  step,
  label,
  round,
  multi,
}: {
  step: AgentStep & { round: number };
  label: string;
  round: number;
  multi: boolean;
}) {
  const [open, setOpen] = useState(step.status === 'running');
  useEffect(() => {
    if (step.status === 'running') setOpen(true);
  }, [step.status]);

  const summary = localizeTrace(
    (typeof step.output?.summary === 'string' && step.output.summary) || step.detail || '',
  );

  return (
    <div className="rounded-lg">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="flex w-full min-w-0 items-center gap-2 rounded-lg px-1 py-1 text-left text-xs hover:bg-subtle/60"
      >
        <RowIcon status={step.status} />
        <span
          className={`shrink-0 whitespace-nowrap ${
            step.status === 'degraded' ? 'text-amber-600 dark:text-amber-400' : 'text-ink-700 dark:text-ink-300'
          }`}
        >
          {label}
        </span>
        {multi && round > 1 && (
          <span className="shrink-0 whitespace-nowrap rounded bg-subtle px-1 text-[10px] text-ink-400">
            第 {round} 轮
          </span>
        )}
        {step.status === 'degraded' && <span className="shrink-0 text-ink-400">（已降级）</span>}
        {!open && summary && (
          <span className="min-w-0 flex-1 truncate text-ink-400" title={summary}>
            {summary}
          </span>
        )}
        <span className="ml-auto shrink-0 whitespace-nowrap tabular-nums text-ink-400">
          {step.latencyMs != null ? `${(step.latencyMs / 1000).toFixed(1)}s` : ''}
        </span>
        <svg
          width="11"
          height="11"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
          className={`shrink-0 text-ink-400 transition-transform ${open ? 'rotate-180' : ''}`}
        >
          <path d="m18 15-6-6-6 6" />
        </svg>
      </button>
      {open && (
        <div className="mb-1 ml-5 border-l border-border/80 pl-3 text-xs leading-5">
          <StepBody step={step} />
        </div>
      )}
    </div>
  );
}

/**
 * 过程时间线：每一步单独展开，展示该步完整输出。
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

  const hasToolStep = all.some((s) => TOOL_STEPS.has(s.name));
  const counts = new Map<string, number>();
  const rows = all
    .filter((s) => {
      if (HIDDEN.has(s.name)) return false;
      if (s.name === 'execute_tools' && hasToolStep) return false;
      return s.status === 'running' || (s.latencyMs ?? 0) >= 50 || !!s.detail || !!s.output;
    })
    .map((s) => {
      const n = (counts.get(s.name) ?? 0) + 1;
      counts.set(s.name, n);
      const fromTool = toolCalls?.find((t) => t.name === s.name);
      const stopped = !streaming && s.status === 'running';
      return {
        ...s,
        status: stopped ? ('done' as const) : s.status,
        round: n,
        detail: stopped ? s.detail || '已停止' : s.detail || fromTool?.summary,
        output: s.output ?? (fromTool?.summary ? { summary: fromTool.summary } : undefined),
      };
    });

  if (rows.length === 0) return null;

  const totalMs = latencyMs ?? rows.reduce((sum, r) => sum + (r.latencyMs ?? 0), 0);
  const hasDegraded = rows.some((r) => r.status === 'degraded');
  const doneCount = rows.filter((r) => r.status !== 'running').length;
  const multi = [...counts.values()].some((n) => n > 1);

  return (
    <div className="mb-3">
      <div className="space-y-0.5">
        {rows.map((s, i) => (
          <StepRow
            key={`${s.name}-${i}`}
            step={s}
            label={STEP_LABELS[s.name] ?? s.name}
            round={s.round}
            multi={multi}
          />
        ))}
      </div>
      <div className="mt-2 flex flex-wrap items-center gap-1.5 text-xs text-ink-400">
        {streaming ? (
          <>
            <span className="inline-block h-3 w-3 animate-spin rounded-full border-[1.5px] border-brand-600/30 border-t-brand-600" />
            <span>
              执行中 · 已完成 {doneCount}/{rows.length} 步
            </span>
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
  );
}
