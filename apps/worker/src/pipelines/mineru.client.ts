import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { unzipSync } from 'fflate';

/** MinerU 解析结果的结构化块 */
export interface ParsedBlock {
  type: 'heading' | 'paragraph' | 'table' | 'figure' | 'formula';
  level?: number; // heading 层级
  text: string; // 段落文本 / 表格 HTML / 公式 LaTeX
  page: number;
  bbox?: number[];
}

export interface MineruResult {
  blocks: ParsedBlock[];
  meta: { pages: number; language?: string; parser_version?: string };
}

/** content_list.json 的条目结构（vlm/pipeline 输出） */
interface ContentItem {
  type: string;
  text?: string;
  text_level?: number;
  text_format?: string;
  table_body?: string;
  img_path?: string;
  bbox?: number[];
  page_idx: number;
}

const POLL_INTERVAL_MS = 10_000;
const POLL_TIMEOUT_MS = 15 * 60_000;

/**
 * MinerU 线上精准解析 API 客户端（https://mineru.net）：
 * 申请签名上传链接 → PUT 上传 → 轮询批量结果 → 下载 zip → content_list.json 映射为结构化块
 */
@Injectable()
export class MineruClient {
  private readonly logger = new Logger(MineruClient.name);

  constructor(private readonly config: ConfigService) {}

  private get base() {
    return this.config.get<string>('mineru.url')!.replace(/\/$/, '');
  }

  private get token() {
    return this.config.get<string>('mineru.token')!;
  }

  private get model() {
    return this.config.get<string>('mineru.model') ?? 'vlm';
  }

  private get headers() {
    return {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${this.token}`,
    };
  }

  /** onPoll：轮询回调（worker 用于续 BullMQ 锁） */
  async parse(file: Buffer, filename: string, onPoll?: () => void): Promise<MineruResult> {
    // 1. 申请签名上传链接（单文件也走 batch 接口，上传后自动提交解析）
    const applyRes = await this.fetchWithCause(`${this.base}/api/v4/file-urls/batch`, {
      method: 'POST',
      headers: this.headers,
      body: JSON.stringify({
        files: [{ name: filename, data_id: filename.slice(0, 128) }],
        model_version: this.model,
        enable_table: true,
        enable_formula: true,
        language: 'ch',
      }),
      signal: AbortSignal.timeout(30_000),
    });
    if (!applyRes.ok) {
      const body = await applyRes.text();
      this.logger.error(`mineru apply upload url failed: ${applyRes.status} ${body}`);
      throw new Error(`mineru error: ${applyRes.status}`);
    }
    const applyJson = (await applyRes.json()) as {
      code: number;
      msg: string;
      data?: { batch_id: string; file_urls: string[] };
    };
    if (applyJson.code !== 0 || !applyJson.data) {
      this.logger.error(`mineru apply upload url rejected: ${applyJson.msg}`);
      throw new Error(`mineru error: ${applyJson.msg}`);
    }
    const { batch_id: batchId, file_urls: fileUrls } = applyJson.data;

    // 2. PUT 上传文件（无须 Content-Type）
    const uploadRes = await this.fetchWithCause(fileUrls[0], {
      method: 'PUT',
      body: new Uint8Array(file),
      signal: AbortSignal.timeout(5 * 60_000),
    });
    if (!uploadRes.ok) {
      this.logger.error(`mineru upload failed: ${uploadRes.status}`);
      throw new Error(`mineru upload error: ${uploadRes.status}`);
    }
    this.logger.log(`mineru task submitted: batch=${batchId} file=${filename}`);

    // 3. 轮询批量结果
    const zipUrl = await this.pollResult(batchId, onPoll);

    // 4. 下载 zip 并解析 content_list.json
    return this.fetchAndMap(zipUrl);
  }

  /** fetch 包装：失败时打出 undici cause 便于定位网络层根因 */
  private async fetchWithCause(url: string, init: Parameters<typeof fetch>[1]): Promise<Response> {
    try {
      return await fetch(url, init);
    } catch (e) {
      const cause = (e as { cause?: { code?: string; message?: string } }).cause;
      this.logger.error(
        `mineru fetch error url=${url.slice(0, 80)}: ${(e as Error).message} cause=${cause?.code ?? ''} ${cause?.message ?? ''}`,
      );
      throw e;
    }
  }

  private async pollResult(batchId: string, onPoll?: () => void): Promise<string> {
    const deadline = Date.now() + POLL_TIMEOUT_MS;
    for (;;) {
      await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS));
      onPoll?.();
      let res: Response;
      try {
        res = await this.fetchWithCause(`${this.base}/api/v4/extract-results/batch/${batchId}`, {
          headers: this.headers,
          signal: AbortSignal.timeout(15_000),
        });
      } catch (e) {
        const cause = (e as { cause?: { code?: string; message?: string } }).cause;
        this.logger.warn(
          `mineru poll fetch error: ${(e as Error).message} cause=${cause?.code ?? ''} ${cause?.message ?? ''}, retrying`,
        );
        if (Date.now() > deadline) throw e;
        continue;
      }
      if (!res.ok) {
        this.logger.warn(`mineru poll failed: ${res.status}, retrying`);
        continue;
      }
      const json = (await res.json()) as {
        code: number;
        data?: { extract_result?: { state: string; full_zip_url?: string; err_msg?: string }[] };
      };
      const item = json.data?.extract_result?.[0];
      if (!item) continue;
      if (item.state === 'done' && item.full_zip_url) return item.full_zip_url;
      if (item.state === 'failed') throw new Error(`mineru parse failed: ${item.err_msg ?? 'unknown'}`);
      if (Date.now() > deadline) throw new Error(`mineru batch ${batchId} timeout after 15min`);
    }
  }

  private async fetchAndMap(zipUrl: string): Promise<MineruResult> {
    const res = await this.fetchWithCause(zipUrl, { signal: AbortSignal.timeout(2 * 60_000) });
    if (!res.ok) throw new Error(`mineru result download error: ${res.status}`);
    const entries = unzipSync(new Uint8Array(await res.arrayBuffer()));

    const contentListName = Object.keys(entries).find(
      (n) => n.endsWith('_content_list.json') && !n.includes('_v2'),
    );
    if (!contentListName) throw new Error('mineru zip missing content_list.json');
    const items = JSON.parse(new TextDecoder().decode(entries[contentListName])) as ContentItem[];

    const blocks: ParsedBlock[] = [];
    let maxPage = 0;
    for (const item of items) {
      maxPage = Math.max(maxPage, item.page_idx + 1);
      const page = item.page_idx + 1; // 对外 1 起始，与本地服务一致
      switch (item.type) {
        case 'text':
          if (!item.text?.trim()) break;
          if (item.text_level) {
            blocks.push({ type: 'heading', level: item.text_level, text: item.text.trim(), page, bbox: item.bbox });
          } else {
            blocks.push({ type: 'paragraph', text: item.text.trim(), page, bbox: item.bbox });
          }
          break;
        case 'table':
          if (item.table_body) {
            blocks.push({ type: 'table', text: item.table_body, page, bbox: item.bbox });
          }
          break;
        case 'equation':
          if (item.text) blocks.push({ type: 'formula', text: item.text, page, bbox: item.bbox });
          break;
        case 'image':
        case 'chart':
          blocks.push({ type: 'figure', text: item.img_path ?? '', page, bbox: item.bbox });
          break;
        default:
          break; // header/footer/page_number/page_footnote/ref_text 等噪声丢弃
      }
    }

    return {
      blocks,
      meta: { pages: maxPage, language: 'ch', parser_version: `mineru-cloud-${this.model}` },
    };
  }
}
