import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

/** MinerU 解析结果的结构化块 */
export interface ParsedBlock {
  type: 'heading' | 'paragraph' | 'table' | 'figure' | 'formula';
  level?: number; // heading 层级
  text: string; // 段落文本 / 表格 Markdown / 公式 LaTeX
  page: number;
  bbox?: number[];
}

export interface MineruResult {
  blocks: ParsedBlock[];
  meta: { pages: number; language?: string; parser_version?: string };
}

/** MinerU HTTP 客户端：提交文件内容，返回结构化解析结果 */
@Injectable()
export class MineruClient {
  private readonly logger = new Logger(MineruClient.name);

  constructor(private readonly config: ConfigService) {}

  async parse(file: Buffer, filename: string): Promise<MineruResult> {
    const url = this.config.get<string>('mineru.url');
    const form = new FormData();
    form.append('file', new Blob([file]), filename);

    const res = await fetch(`${url}/parse`, {
      method: 'POST',
      body: form,
      signal: AbortSignal.timeout(10 * 60_000), // 单文件 10min
    });
    if (!res.ok) {
      const body = await res.text();
      this.logger.error(`mineru parse failed: ${res.status} ${body}`);
      throw new Error(`mineru error: ${res.status}`);
    }
    return (await res.json()) as MineruResult;
  }
}
