import {
  AgentIntent,
  type Citation,
  type NodeLatency,
  type ToolTrace,
  type Triple,
} from '@ekh/shared';
import { toLatencyMap } from '../agents/agent-latency';

/**
 * 流式过程中先把步骤、工具、引用攒在内存里。
 * 正常跑完由 Agent 结果落库；用户中途停止时，用这份草稿把「已经跑到哪」写进问答记录。
 */
export class RunSnapshot {
  steps: NodeLatency[] = [];
  tools: ToolTrace[] = [];
  citations: Citation[] = [];
  triples: Triple[] = [];
  intent: AgentIntent | null = null;
  suggestedQuery: string | null = null;
  thinking: string | null = null;

  /** 还没收到结束回调的那一步；停止时靠它补一条「已停止」 */
  private open: { name: string; t0: number } | null = null;
  /** 同名节点可能因改写循环再跑一遍，用出现次数区分第几轮 */
  private seen = new Map<string, number>();
  /** 正在执行的工具，结束时用来算耗时和带上入参 */
  private openTool: { name: string; t0: number; args?: Record<string, unknown> } | null = null;

  /** 某一步开始：先记下来，避免停在半路时这一步从记录里消失 */
  startStep(name: string) {
    this.open = { name, t0: Date.now() };
  }

  /** 某一步正常结束：写入轨迹，并清掉「进行中」标记 */
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
    // 只清掉对得上的那一步，避免迟到的结束回调把下一轮进行中的步骤抹掉
    if (this.open?.name === name) this.open = null;
  }

  /**
   * 用户停止或连接中止时调用。
   * 进行中的一步不会再收到结束回调，这里把它收成降级步骤，前端才能显示停在哪。
   */
  flushOpen(label = '已停止') {
    if (!this.open) return;
    this.endStep(this.open.name, Date.now() - this.open.t0, true, { summary: label });
  }

  /** 工具开始：入参留到结束时一起写入，方便回放时看到搜了什么 */
  startTool(name: string, args?: Record<string, unknown>) {
    this.openTool = { name, t0: Date.now(), args };
  }

  /** 工具结束。若开始事件丢了，仍记一条，耗时按 0 处理，避免整条工具轨迹缺失 */
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

  /** 改写后再检索时，上一轮引用作废，避免落库混进已经不用的来源 */
  resetCitations() {
    this.citations = [];
  }

  /** 图谱结果整份替换：多跳推理后只保留最终路径 */
  setGraph(triples: Triple[]) {
    this.triples = triples;
  }

  /** 意图必须是已知枚举，模型回了别的字符串就丢掉，避免脏值进库 */
  setIntent(intent: string, suggestedQuery: string) {
    this.intent = (Object.values(AgentIntent) as string[]).includes(intent)
      ? (intent as AgentIntent)
      : null;
    this.suggestedQuery = suggestedQuery || null;
  }

  setThinking(text: string) {
    this.thinking = text;
  }

  /** 一步都没跑、正文也没有时不落库，避免刷出一条空的助手消息 */
  hasProgress(partialAnswer: string) {
    return (
      this.steps.length > 0 ||
      this.tools.length > 0 ||
      this.citations.length > 0 ||
      !!partialAnswer
    );
  }

  /** 收成问答记录要的字段。分片 id 已在引用里，这里不再重复一份 */
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
