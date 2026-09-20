import { AgentIntent, Complexity, ToolName } from '@ekh/shared';

const INTENT_SET = new Set<string>(Object.values(AgentIntent));

export interface ParsedIntent {
  intent: AgentIntent;
  suggestedQuery: string;
  entities: { name: string; type: string }[];
  relations: string[];
}

export function parseIntentJson(raw: string, fallbackQuery: string): ParsedIntent {
  try {
    const match = raw.match(/\{[\s\S]*\}/);
    const parsed = JSON.parse(match ? match[0] : raw) as {
      intent?: string;
      suggestedQuery?: string;
      query?: string;
      entities?: { name: string; type: string }[];
      relations?: string[];
    };
    const intent = INTENT_SET.has(parsed.intent ?? '')
      ? (parsed.intent as AgentIntent)
      : AgentIntent.KB;
    const suggested =
      (parsed.suggestedQuery || parsed.query || '').trim() || fallbackQuery;
    return {
      intent,
      suggestedQuery: suggested,
      entities: (parsed.entities ?? []).filter((e) => typeof e?.name === 'string' && e.name.trim()),
      relations: (parsed.relations ?? []).filter((r) => typeof r === 'string'),
    };
  } catch {
    return { intent: AgentIntent.KB, suggestedQuery: fallbackQuery, entities: [], relations: [] };
  }
}

export function toolsForIntent(
  intent: AgentIntent,
  opts: { webEnabled: boolean; enableGraph: boolean },
): ToolName[] {
  switch (intent) {
    case AgentIntent.CHITCHAT:
    case AgentIntent.PREFERENCE:
      return [];
    case AgentIntent.WEB:
      return opts.webEnabled ? [ToolName.WEB_SEARCH] : [ToolName.KB_RETRIEVE];
    case AgentIntent.KB_THEN_WEB:
      return opts.webEnabled
        ? [ToolName.KB_RETRIEVE, ToolName.WEB_SEARCH]
        : [ToolName.KB_RETRIEVE];
    case AgentIntent.KB:
    default:
      return opts.enableGraph
        ? [ToolName.KB_RETRIEVE, ToolName.GRAPH_REASON]
        : [ToolName.KB_RETRIEVE];
  }
}

/** 兼容旧客户端：多实体 / 图谱意图视为 complex */
export function complexityFromIntent(
  intent: AgentIntent,
  entities: { name: string }[],
): Complexity {
  if (intent === AgentIntent.KB || intent === AgentIntent.KB_THEN_WEB) {
    return entities.length >= 2 ? Complexity.COMPLEX : Complexity.SIMPLE;
  }
  return Complexity.SIMPLE;
}

export function skipsRetrieve(intent: AgentIntent): boolean {
  return intent === AgentIntent.CHITCHAT || intent === AgentIntent.PREFERENCE;
}

/** 本轮先执行的工具（kb_then_web 先只跑知识库） */
export function initialToolsForIntent(
  intent: AgentIntent,
  opts: { webEnabled: boolean; enableGraph: boolean; wantGraph: boolean },
): ToolName[] {
  switch (intent) {
    case AgentIntent.WEB:
      return opts.webEnabled ? [ToolName.WEB_SEARCH] : [ToolName.KB_RETRIEVE];
    case AgentIntent.KB_THEN_WEB:
    case AgentIntent.KB:
      return opts.wantGraph && opts.enableGraph
        ? [ToolName.KB_RETRIEVE, ToolName.GRAPH_REASON]
        : [ToolName.KB_RETRIEVE];
    default:
      return [];
  }
}
