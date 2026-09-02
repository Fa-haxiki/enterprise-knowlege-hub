import { Injectable } from '@nestjs/common';
import type { MineruResult, ParsedBlock } from './mineru.client';

/**
 * 纯文本类文档本地解析：MinerU 线上 API 仅支持 PDF/Office（Doc/Docx/Ppt/Pptx/Xls/Xlsx），
 * md/txt/html 直接本地转为结构化块（ParsedBlock），与 MinerU 结果共用后续分块/索引/建图链路。
 * 无页码概念，page 恒为 1。
 */
@Injectable()
export class TextParser {
  /** 按扩展名判断是否走本地解析 */
  static isTextFile(filename: string): boolean {
    return /\.(md|markdown|txt|html?)$/i.test(filename);
  }

  parse(file: Buffer, filename: string): MineruResult {
    const text = new TextDecoder('utf-8').decode(file);
    let blocks: ParsedBlock[];
    if (/\.(md|markdown)$/i.test(filename)) {
      blocks = this.parseMarkdown(text);
    } else if (/\.html?$/i.test(filename)) {
      blocks = this.parsePlain(this.stripHtml(text));
    } else {
      blocks = this.parsePlain(text);
    }
    return { blocks, meta: { pages: 1, language: 'ch', parser_version: 'local-text' } };
  }

  /** txt：按空行分段 */
  private parsePlain(text: string): ParsedBlock[] {
    return text
      .split(/\n{2,}/)
      .map((t) => t.trim())
      .filter(Boolean)
      .map((t) => ({ type: 'paragraph' as const, text: t, page: 1 }));
  }

  /**
   * md：标题（# 层级）、段落、围栏代码块、管道表格。
   * 表格转 HTML 与 MinerU table 块的 table_body 格式对齐，下游 chunker 整表成块。
   */
  private parseMarkdown(text: string): ParsedBlock[] {
    const blocks: ParsedBlock[] = [];
    let para: string[] = [];
    let tableRows: string[] = [];
    let code: string[] | null = null;

    const flushPara = () => {
      const t = para.join('\n').trim();
      if (t) blocks.push({ type: 'paragraph', text: t, page: 1 });
      para = [];
    };
    const flushTable = () => {
      if (tableRows.length > 0) {
        blocks.push({ type: 'table', text: this.mdTableToHtml(tableRows), page: 1 });
        tableRows = [];
      }
    };

    for (const line of text.split('\n')) {
      const trimmed = line.trim();
      // 围栏代码块：整体作为一个段落块，保留原文换行
      if (trimmed.startsWith('```')) {
        if (code) {
          blocks.push({ type: 'paragraph', text: code.join('\n'), page: 1 });
          code = null;
        } else {
          flushPara();
          flushTable();
          code = [];
        }
        continue;
      }
      if (code) {
        code.push(line);
        continue;
      }
      const heading = /^(#{1,6})\s+(.+)$/.exec(trimmed);
      if (heading) {
        flushPara();
        flushTable();
        blocks.push({ type: 'heading', level: heading[1].length, text: heading[2].trim(), page: 1 });
        continue;
      }
      if (/^\|.*\|$/.test(trimmed)) {
        flushPara();
        tableRows.push(trimmed);
        continue;
      }
      flushTable();
      if (!trimmed) {
        flushPara();
        continue;
      }
      para.push(line);
    }
    if (code) blocks.push({ type: 'paragraph', text: code.join('\n'), page: 1 });
    flushPara();
    flushTable();
    return blocks;
  }

  /** markdown 管道表格 → HTML（首行表头，跳过分隔行 |---|） */
  private mdTableToHtml(rows: string[]): string {
    const cells = (r: string) =>
      r
        .replace(/^\||\|$/g, '')
        .split('|')
        .map((c) => c.trim());
    const isSeparator = (r: string) => /^\|[\s:|-]+\|$/.test(r);
    const [header, ...rest] = rows;
    const body = rest.filter((r) => !isSeparator(r));
    const th = cells(header).map((c) => `<th>${c}</th>`).join('');
    const trs = body
      .map((r) => `<tr>${cells(r).map((c) => `<td>${c}</td>`).join('')}</tr>`)
      .join('');
    return `<table><thead><tr>${th}</tr></thead><tbody>${trs}</tbody></table>`;
  }

  /** html：去脚本/样式后剥标签为纯文本 */
  private stripHtml(html: string): string {
    return html
      .replace(/<(script|style)[\s\S]*?<\/\1>/gi, '')
      .replace(/<br\s*\/?>/gi, '\n')
      .replace(/<\/(p|div|li|tr|h[1-6])>/gi, '\n\n')
      .replace(/<[^>]+>/g, '')
      .replace(/&nbsp;/g, ' ')
      .replace(/&amp;/g, '&')
      .replace(/&lt;/g, '<')
      .replace(/&gt;/g, '>')
      .replace(/&quot;/g, '"');
  }
}
