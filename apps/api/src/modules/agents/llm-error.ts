/**
 * 把模型调用失败收成一句可展示的原文。
 * 优先用接口体里的 error.message（额度、余额、限流），否则用 Error.message 的首行。
 */
export function formatLlmError(e: unknown): string {
  const texts = collectMessages(e);
  for (const text of texts) {
    const fromBody = extractApiMessage(text);
    if (fromBody) return fromBody;
  }
  const raw = texts.map((t) => t.split('\n')[0]?.trim()).find(Boolean);
  return raw || '模型调用失败';
}

function collectMessages(e: unknown, depth = 0): string[] {
  if (depth > 4 || e == null) return [];
  if (typeof e === 'string') return [e];
  if (typeof e !== 'object') return [String(e)];
  const obj = e as Record<string, unknown>;
  const out: string[] = [];
  const nested = obj.error;
  if (nested && typeof nested === 'object') {
    const msg = (nested as { message?: unknown }).message;
    if (typeof msg === 'string' && msg.trim()) out.push(msg.trim());
  }
  if (typeof obj.message === 'string' && obj.message.trim()) out.push(obj.message.trim());
  if ('cause' in obj) out.push(...collectMessages(obj.cause, depth + 1));
  return out;
}

/** 报错原文里如果嵌了 JSON，取出 error.message，避免整段堆栈进回答 */
function extractApiMessage(text: string): string | null {
  const start = text.indexOf('{');
  if (start < 0) return null;
  try {
    const json = JSON.parse(text.slice(start)) as { error?: { message?: unknown }; message?: unknown };
    const msg = json?.error?.message ?? json?.message;
    return typeof msg === 'string' && msg.trim() ? msg.trim() : null;
  } catch {
    return null;
  }
}
