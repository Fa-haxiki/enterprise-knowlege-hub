import { AgentIntent, EvidenceGrade, type ChunkHit } from '@ekh/shared';

export interface EvaluateInput {
  chunks: Pick<ChunkHit, 'rerank_score'>[];
  hasGraph: boolean;
  hasWeb: boolean;
  intent: AgentIntent;
  minScore: number;
  iteration: number;
  maxIterations: number;
  loopEnabled: boolean;
  fastPathEnabled: boolean;
}

export interface EvaluateResult {
  grade: EvidenceGrade;
  reason: string;
  missing: string;
}

export function parseEvaluateJson(raw: string): EvaluateResult | null {
  try {
    const match = raw.match(/\{[\s\S]*\}/);
    const parsed = JSON.parse(match ? match[0] : raw) as {
      grade?: string;
      reason?: string;
      missing?: string;
    };
    if (
      parsed.grade !== EvidenceGrade.SUFFICIENT &&
      parsed.grade !== EvidenceGrade.REWRITE &&
      parsed.grade !== EvidenceGrade.GIVE_UP
    ) {
      return null;
    }
    return {
      grade: parsed.grade,
      reason: parsed.reason ?? '',
      missing: parsed.missing ?? '',
    };
  } catch {
    return null;
  }
}

/** 不依赖 LLM 的评估兜底，供契约测试与 LLM 失败时使用 */
export function heuristicEvaluate(input: EvaluateInput): EvaluateResult {
  if (!input.loopEnabled) {
    return { grade: EvidenceGrade.SUFFICIENT, reason: 'loop_disabled', missing: '' };
  }
  if (input.iteration >= input.maxIterations) {
    return { grade: EvidenceGrade.GIVE_UP, reason: 'max_iterations', missing: '' };
  }

  const top = input.chunks[0]?.rerank_score;
  const empty = input.chunks.length === 0;

  if (input.intent === AgentIntent.WEB) {
    if (input.hasWeb) return { grade: EvidenceGrade.SUFFICIENT, reason: 'web_hits', missing: '' };
    return input.iteration + 1 >= input.maxIterations
      ? { grade: EvidenceGrade.GIVE_UP, reason: 'web_empty', missing: '公开来源' }
      : { grade: EvidenceGrade.REWRITE, reason: 'web_empty', missing: '公开来源' };
  }

  if (empty || top == null || top < input.minScore) {
    if (input.intent === AgentIntent.KB_THEN_WEB && !input.hasWeb) {
      return { grade: EvidenceGrade.REWRITE, reason: 'kb_weak_need_web', missing: '内部资料不足，需公开信息' };
    }
    if (input.iteration + 1 >= input.maxIterations) {
      return { grade: EvidenceGrade.GIVE_UP, reason: empty ? 'empty_recall' : 'low_score', missing: '相关资料' };
    }
    return {
      grade: EvidenceGrade.REWRITE,
      reason: empty ? 'empty_recall' : 'low_score',
      missing: '更具体的制度/实体/条款',
    };
  }

  return { grade: EvidenceGrade.SUFFICIENT, reason: 'heuristic_ok', missing: '' };
}

export function shouldTakeFastPath(input: EvaluateInput): boolean {
  if (!input.fastPathEnabled || !input.loopEnabled) return true;
  if (input.intent === AgentIntent.CHITCHAT || input.intent === AgentIntent.PREFERENCE) return true;
  if (input.intent !== AgentIntent.KB) return false;
  const top = input.chunks[0]?.rerank_score;
  return top != null && top >= input.minScore;
}

/** 未知工具名直接丢弃 */
export function filterUnknownTools(names: string[], allowed: string[]): string[] {
  const set = new Set(allowed);
  return names.filter((n) => set.has(n));
}
