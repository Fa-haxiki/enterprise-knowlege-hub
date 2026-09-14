import { randomUUID } from 'crypto';
import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { ParsedBlock } from './mineru.client';

/** 中文粗略 1 token ≈ 1.5 字，配置按 token，比较时用字符。 */
const TOKEN_CHAR_RATIO = 1.5;

export type ChunkRole = 'parent' | 'child';

/**
 * 父子分块草稿。index 阶段先落父块再落子块；仅子块做 embedding / ES。
 *
 * - content：纯正文（不含文档标题前缀；前缀只在向量化时由 enrichForEmbedding 拼接）
 * - headingPath：当前块所属标题栈，如 `['第二章', '2.1 范围']`
 * - refs.page / bbox：溯源定位
 * - draftId / parentDraftId：落库前的临时关联，写入后换成 UUID
 */
export interface ChunkDraft {
  role: ChunkRole;
  draftId: string;
  parentDraftId?: string;
  content: string;
  headingPath: string[];
  refs: { page?: number; bbox?: number[] };
}

/**
 * 父子语义分块：
 *   1. 标题   只更新 headingPath，本身不进父块
 *   2. 表格   整表单独成父块，不与前后段落合并
 *   3. 图片   跳过
 *   4. 段落/公式  按标题节聚成父块；超 PARENT_CHUNK_SIZE 按段落再切，父块之间无 overlap
 *   5. 每个父块内切子块（CHILD_CHUNK_SIZE + overlap）；短父块只产 1 个等长子块
 */
@Injectable()
export class Chunker {
  constructor(private readonly config: ConfigService) {}

  chunk(blocks: ParsedBlock[]): ChunkDraft[] {
    const parentMax = (this.config.get<number>('rag.parentChunkSize') ?? 1024) * TOKEN_CHAR_RATIO;
    const childMax = (this.config.get<number>('rag.childChunkSize') ?? 256) * TOKEN_CHAR_RATIO;
    const childOverlap = (this.config.get<number>('rag.childChunkOverlap') ?? 32) * TOKEN_CHAR_RATIO;

    const out: ChunkDraft[] = [];
    let headingPath: string[] = [];
    let bufferParts: Array<{ text: string; page?: number }> = [];

    const emitParent = (content: string, path: string[], refs: ChunkDraft['refs']) => {
      const text = content.trim();
      if (!text) return;
      const draftId = randomUUID();
      out.push({ role: 'parent', draftId, content: text, headingPath: [...path], refs });
      for (const child of this.splitChildren(text, childMax, childOverlap, refs)) {
        out.push({
          role: 'child',
          draftId: randomUUID(),
          parentDraftId: draftId,
          content: child,
          headingPath: [...path],
          refs,
        });
      }
    };

    const flushBuffer = () => {
      if (bufferParts.length === 0) return;
      let acc = '';
      let accPage: number | undefined;
      const flushAcc = () => {
        const t = acc.trim();
        if (t) emitParent(t, headingPath, { page: accPage });
        acc = '';
        accPage = undefined;
      };
      for (const part of bufferParts) {
        const candidate = acc ? `${acc}\n\n${part.text}` : part.text;
        if (acc && candidate.length > parentMax) {
          flushAcc();
          acc = part.text;
          accPage = part.page;
        } else {
          acc = candidate;
          accPage = accPage ?? part.page;
        }
      }
      flushAcc();
      bufferParts = [];
    };

    for (const block of blocks) {
      if (block.type === 'heading') {
        flushBuffer();
        const level = Math.min(Math.max(block.level ?? 1, 1), 6);
        headingPath = headingPath.slice(0, level - 1);
        headingPath[level - 1] = block.text.trim();
        continue;
      }
      if (block.type === 'table') {
        flushBuffer();
        emitParent(block.text, headingPath, { page: block.page, bbox: block.bbox });
        continue;
      }
      if (block.type === 'figure') continue;
      bufferParts.push({ text: block.text, page: block.page });
    }
    flushBuffer();
    return out;
  }

  /**
   * 向量化前把章节路径拼到正文前面。
   * 落库的 content 仍是裸正文，避免前端引用把前缀展示给用户。
   */
  enrichForEmbedding(docTitle: string, chunk: Pick<ChunkDraft, 'content' | 'headingPath'>): string {
    const path = chunk.headingPath.join(' > ');
    return path ? `${docTitle} > ${path}\n\n${chunk.content}` : `${docTitle}\n\n${chunk.content}`;
  }

  /** 父块内切子块；单段超长整段收下，不在句中切开。 */
  private splitChildren(
    content: string,
    childMax: number,
    overlapChars: number,
    _refs: ChunkDraft['refs'],
  ): string[] {
    if (content.length <= childMax) return [content];

    const paras = content.split(/\n\n/);
    const children: string[] = [];
    let buffer = '';

    const flush = () => {
      const text = buffer.trim();
      if (text) children.push(text);
    };

    for (const para of paras) {
      const candidate = buffer ? `${buffer}\n\n${para}` : para;
      if (buffer && candidate.length > childMax) {
        const tail = buffer.slice(-overlapChars);
        flush();
        buffer = tail ? `${tail}\n\n${para}` : para;
      } else {
        buffer = candidate;
      }
    }
    flush();
    return children;
  }
}
