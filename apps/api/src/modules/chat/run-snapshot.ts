import {
  AgentIntent,
  type Citation,
  type NodeLatency,
  type ToolTrace,
  type Triple,
} from '@ekh/shared';
import { toLatencyMap } from '../agents/agent-latency';

/** 流式过程中收集步骤/工具，中止时按已跑到的进度落库 */
export class RunSnapshot {
  steps: NodeLatency[] = [];
  tools: ToolTrace[] = [];
  citations: Citation[] = [];
  triples: Triple[] = [];
  intent: AgentIntent | null = null;
  suggestedQuery: string | null = null;
  thinking: string | null = null;

  private open: { name: string; t0: number } | null = null;
  private seen = new Map<string, number>();
  private openTool: { name: string; t0: number; args?: Record<string, unknown> } | null = null;

  startStep(name: string) {
    this.open = { name, t0: Date.now() };
  }

  endStep(name: string, latencyMs: number, degraded: boolean, output?: Record<string, unknown>) {
    const iteration = this.seen.get(name) ?? 0;
    this.seen.set(name, iteration + 1);
    this.steps.push({
      name,
      latencyMs,
      iteration,
      degraded,
      detail: typeof output?.summary === 'string' ? output.summary : undefined,
      output,
    });
    if (this.open?.name === name) this.open = null;
  }

  flushOpen(label = '已停止') {
    if (!this.open) return;
    this.endStep(this.open.name, Date.now() - this.open.t0, true, { summary: label });
  }

  startTool(name: string, args?: Record<string, unknown>) {
    this.openTool = { name, t0: Date.now(), args };
  }

  endTool(name: string, summary?: string) {
    const t0 = this.openTool?.name === name ? this.openTool.t0 : Date.now();
    const args = this.openTool?.name === name ? this.openTool.args : undefined;
    this.tools.push({
      name,
      args,
      summary,
      latencyMs: Date.now() - t0,
      iteration: 0,
    });
    if (this.openTool?.name === name) this.openTool = null;
  }

  addCitation(c: Citation) {
    this.citations.push(c);
  }

  resetCitations() {
    this.citations = [];
  }

  setGraph(triples: Triple[]) {
    this.triples = triples;
  }

  setIntent(intent: string, suggestedQuery: string) {
    this.intent = (Object.values(AgentIntent) as string[]).includes(intent)
      ? (intent as AgentIntent)
      : null;
    this.suggestedQuery = suggestedQuery || null;
  }

  setThinking(text: string) {
    this.thinking = text;
  }

  hasProgress(partialAnswer: string) {
    return (
      this.steps.length > 0 ||
      this.tools.length > 0 ||
      this.citations.length > 0 ||
      !!partialAnswer
    );
  }

  qaPayload() {
    return {
      complexity: null,
      intent: this.intent,
      suggestedQuery: this.suggestedQuery,
      thinking: this.thinking,
      toolTrace: this.tools,
      stepTrace: this.steps,
      recalledChunkIds: [],
      graphTriples: this.triples,
      nodeLatencies: toLatencyMap(this.steps),
      degradedNodes: [...new Set(this.steps.filter((s) => s.degraded).map((s) => s.name))],
    };
  }
}
