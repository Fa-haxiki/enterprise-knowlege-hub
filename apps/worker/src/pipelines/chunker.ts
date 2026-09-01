import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { ParsedBlock } from './mineru.client';

/**
 * 尚未落库的分片草稿。index 阶段会把它写成 PG `document_chunks` + ES 文档。
 *
 * - content：纯正文（不含文档标题前缀；前缀只在向量化时由 enrichForEmbedding 拼接）
 * - headingPath：当前块所属标题栈，如 `['第二章', '2.1 范围']`，检索时可按章节过滤
 * - refs.page / bbox：溯源定位；段落只记起始页，表格额外带 bbox 方便前端高亮
 */
export interface ChunkDraft {
  content: string;
  headingPath: string[];
  refs: { page?: number; bbox?: number[] };
}

/**
 * 语义分块：把 MinerU 的线性 blocks 收成检索友好的 chunks。
 *
 * 策略（按优先级）：
 *   1. 标题   只更新 headingPath，本身不进 chunk（避免「第二章」这种无内容块）
 *   2. 表格   整表单独成块，不与前后段落合并，也不按长度再切（拆开会丢掉行列结构）
 *   3. 图片   一期跳过（figure 无 OCR 正文，进向量库没有检索价值）
 *   4. 段落/公式  写入 buffer，凑到约 chunkSize 再按段落边界 flush
 *
 * 长度估算：配置项 CHUNK_SIZE / CHUNK_OVERLAP 按 token 计，
 * 中文粗略 1 token ≈ 1.5 字，所以比较时用 `chunkSize * 1.5` 字符。
 *
 * 例：blocks = [H1「薪资」, 段A, 段B(超长), 表1, H2「加班」, 段C]
 *   → chunk1: 段A（path=[薪资]）
 *   → chunk2: overlap(段A尾) + 段B（path=[薪资]）
 *   → chunk3: 表1 整表（path=[薪资]）
 *   → chunk4: 段C（path=[薪资, 加班]）
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
    /** 标题栈：下标 0=H1、1=H2…；遇到同级或更高级标题时截断后半段 */
    let headingPath: string[] = [];
    /** 正在累积的段落文本；遇到标题/表格/超长时 flush 成一块 */
    let buffer = '';
    /** buffer 里第一段的页码，作为该 chunk 的溯源页 */
    let bufferPage: number | undefined;

    /** 把 buffer 收成一块并清空。headingPath 用浅拷贝，避免后续改栈污染已产出的 chunk。 */
    const flush = () => {
      const text = buffer.trim();
      if (text) {
        chunks.push({ content: text, headingPath: [...headingPath], refs: { page: bufferPage } });
      }
      buffer = '';
    };

    for (const block of blocks) {
      // —— 标题：先结算上文，再按 level 维护标题栈 ——
      // H1「总则」→ H2「范围」→ 再遇 H1「附录」时 slice(0, 0) 丢掉「范围」，栈变成 [附录]
      if (block.type === 'heading') {
        flush();
        const level = Math.min(Math.max(block.level ?? 1, 1), 6);
        headingPath = headingPath.slice(0, level - 1);
        headingPath[level - 1] = block.text.trim();
        continue;
      }

      // —— 表格：独立成块，不进 buffer（避免被 overlap / 二次切分拆开） ——
      if (block.type === 'table') {
        flush();
        chunks.push({
          content: block.text,
          headingPath: [...headingPath],
          refs: { page: block.page, bbox: block.bbox },
        });
        continue;
      }

      // —— 图片：无可用正文，一期不入检索库 ——
      if (block.type === 'figure') continue;

      // —— 段落 / 公式：往 buffer 里攒，超长则按「已有段落」边界切开 ——
      // 单个超长段落不会在句中切开：buffer 为空时 candidate 再长也整段收下
      // （宁可一块偏长，也不把一段话拆成两截破坏语义）
      bufferPage = bufferPage ?? block.page;
      const candidate = buffer ? `${buffer}\n\n${block.text}` : block.text;
      if (candidate.length > maxChars && buffer) {
        // 必须先截 tail 再 flush：flush 会把 buffer 置空
        const tail = buffer.slice(-overlapChars);
        flush();
        // overlap：下一块以上一块尾部开头，检索时跨块问句仍能命中
        buffer = tail ? `${tail}\n\n${block.text}` : block.text;
        bufferPage = block.page;
      } else {
        buffer = candidate;
      }
    }
    flush();
    return chunks;
  }

  /**
   * 向量化前把章节路径拼到正文前面。
   * Embedding 只看这段字符串，检索「加班费怎么算」时，
   * 带上「员工手册 > 薪资 > 加班」比裸正文更容易和问题对齐。
   * 落库的 content 仍是裸正文，避免前端引用把前缀展示给用户。
   */
  enrichForEmbedding(docTitle: string, chunk: ChunkDraft): string {
    const path = chunk.headingPath.join(' > ');
    return path ? `${docTitle} > ${path}\n\n${chunk.content}` : `${docTitle}\n\n${chunk.content}`;
  }
}
