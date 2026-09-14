import type { MineruResult, ParsedBlock } from './mineru.client';

const USABLE_TYPES = new Set<ParsedBlock['type']>(['heading', 'paragraph', 'table', 'formula']);

export const NO_EXTRACTABLE_TEXT_MSG = '文档解析后无可检索正文（空文档或仅含图片），暂不支持入库';

/** 去掉空白、Markdown 图片、HTML 标签后的残留文字 */
export function residualText(text: string): string {
  return text
    .replace(/!\[[^\]]*\]\([^)]*\)/g, '')
    .replace(/<img\b[^>]*>/gi, '')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/gi, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

export function hasExtractableText(parsed: Pick<MineruResult, 'blocks'>): boolean {
  return parsed.blocks.some((block) => USABLE_TYPES.has(block.type) && residualText(block.text).length > 0);
}

export function assertHasExtractableText(parsed: Pick<MineruResult, 'blocks'>): void {
  if (!hasExtractableText(parsed)) {
    throw new Error(NO_EXTRACTABLE_TEXT_MSG);
  }
}
