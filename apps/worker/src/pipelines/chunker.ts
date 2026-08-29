import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { ParsedBlock } from './mineru.client';

export interface ChunkDraft {
  content: string;
  headingPath: string[];
  refs: { page?: number; bbox?: number[] };
}

/**
 * 语义分块：
 * 1. 按 MinerU 标题层级聚合段落（heading 更新路径）
 * 2. 表格整块保留（不跨块拆分）
 * 3. 超 chunkSize 按段落边界二次切分，overlap 重叠
 * 粗略按 1 token ≈ 1.5 中文字符估算
 */
@Injectable()
export class Chunker {
  constructor(private readonly config: ConfigService) {}

  chunk(blocks: ParsedBlock[]): ChunkDraft[] {
    const chunkSize = this.config.get<number>('rag.chunkSize') ?? 512;
    const overlap = this.config.get<number>('rag.chunkOverlap') ?? 64;
    const maxChars = chunkSize * 1.5;
    const overlapChars = overlap * 1.5;

    const chunks: ChunkDraft[] = [];
    let headingPath: string[] = [];
    let buffer = '';
    let bufferPage: number | undefined;

    const flush = () => {
      const text = buffer.trim();
      if (text) {
        chunks.push({ content: text, headingPath: [...headingPath], refs: { page: bufferPage } });
      }
      buffer = '';
    };

    for (const block of blocks) {
      if (block.type === 'heading') {
        flush();
        const level = Math.min(Math.max(block.level ?? 1, 1), 6);
        headingPath = headingPath.slice(0, level - 1);
        headingPath[level - 1] = block.text.trim();
        continue;
      }

      if (block.type === 'table') {
        flush();
        chunks.push({
          content: block.text,
          headingPath: [...headingPath],
          refs: { page: block.page, bbox: block.bbox },
        });
        continue;
      }

      if (block.type === 'figure') continue; // 图片锚点一期不入 chunk

      bufferPage = bufferPage ?? block.page;
      const candidate = buffer ? `${buffer}\n\n${block.text}` : block.text;
      if (candidate.length > maxChars && buffer) {
        flush();
        // overlap：取上一块尾部作为下一块开头
        const tail = buffer.slice(-overlapChars);
        buffer = tail ? `${tail}\n\n${block.text}` : block.text;
        bufferPage = block.page;
      } else {
        buffer = candidate;
      }
    }
    flush();
    return chunks;
  }

  /** chunk 富化：拼接「文档标题 > 标题路径」前缀后再向量化 */
  enrichForEmbedding(docTitle: string, chunk: ChunkDraft): string {
    const path = chunk.headingPath.join(' > ');
    return path ? `${docTitle} > ${path}\n\n${chunk.content}` : `${docTitle}\n\n${chunk.content}`;
  }
}
