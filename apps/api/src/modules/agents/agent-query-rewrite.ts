export interface RewriteHistoryMessage {
  role: string;
  content: string;
}

/** 与 PromptInjectionService 同组，改写历史里丢掉越狱/套取，避免带偏下一轮主题 */
const INJECTION_IN_HISTORY =
  /(忽略|无视|不要理会)(以上|之前|前面|上面|先前).{0,8}(指令|指示|命令|要求|设定)|ignore\s+(all|any|previous|above|prior)/i;

/** 短追问 / 指代：才需要结合历史改写。一线/二线只靠长度和「呢」，避免「一线城市住宿标准」被误判 */
const DEIXIS_START = /^(这|那|它|其|该|刚才|上面|之前|还是|还有|同样)/;
const SHORT_FOLLOW_UP = /呢$/;

export function looksLikeInjection(text: string): boolean {
  return INJECTION_IN_HISTORY.test(text.replace(/\s+/g, ' ').trim());
}

/** 丢掉注入轮及其后一条助手回复，避免「管理员密码」残留在改写上下文 */
export function sanitizeRewriteHistory<T extends RewriteHistoryMessage>(messages: T[]): T[] {
  const out: T[] = [];
  let skipAssistant = false;
  for (const m of messages) {
    if (m.role === 'user' && looksLikeInjection(m.content)) {
      skipAssistant = true;
      continue;
    }
    if (skipAssistant && m.role === 'assistant') {
      skipAssistant = false;
      continue;
    }
    skipAssistant = false;
    out.push(m);
  }
  return out;
}

/**
 * 最新问题已经独立完整时不要改写。
 * 「出差后怎么报销」这类完整问句若丢进历史，模型容易被上一轮无关话题带偏。
 */
export function needsQueryRewrite(query: string): boolean {
  const t = query.replace(/[？?。！!\s]/g, '').trim();
  if (!t) return false;
  if (t.length <= 6) return true;
  if (DEIXIS_START.test(t)) return true;
  if (SHORT_FOLLOW_UP.test(t) && t.length <= 10) return true;
  return false;
}
