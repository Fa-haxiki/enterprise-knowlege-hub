import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { RedisService } from '../../redis/redis.service';

const WINDOW_SIZE = 10;
const windowKey = (convId: string) => `chat:win:${convId}`;
const summaryKey = (convId: string) => `chat:summary:${convId}`;

export interface WindowMessage {
  role: 'user' | 'assistant';
  content: string;
}

/**
 * 分层记忆：
 * - 短期：Redis 滑动窗口（最近 N 轮）+ 滚动摘要
 * - 长期：Mem0（user 级画像 / session 级事实）
 */
@Injectable()
export class MemoryService {
  private readonly logger = new Logger(MemoryService.name);

  constructor(
    private readonly redis: RedisService,
    private readonly config: ConfigService,
  ) {}

  /** 读取短期窗口消息 */
  async getWindow(conversationId: string): Promise<WindowMessage[]> {
    const raw = await this.redis.raw.lrange(windowKey(conversationId), 0, -1);
    return raw.map((r) => JSON.parse(r) as WindowMessage);
  }

  /** 读取滚动摘要 */
  async getSummary(conversationId: string): Promise<string> {
    return (await this.redis.raw.get(summaryKey(conversationId))) ?? '';
  }

  /** 追加一轮对话到窗口；溢出部分由调用方压缩进滚动摘要 */
  async appendWindow(conversationId: string, messages: WindowMessage[]): Promise<WindowMessage[]> {
    const key = windowKey(conversationId);
    const pipeline = this.redis.raw.pipeline();
    for (const m of messages) pipeline.rpush(key, JSON.stringify(m));
    pipeline.expire(key, 24 * 3600);
    await pipeline.exec();

    const len = await this.redis.raw.llen(key);
    if (len <= WINDOW_SIZE) return [];

    const overflowCount = len - WINDOW_SIZE;
    const overflowRaw = await this.redis.raw.lrange(key, 0, overflowCount - 1);
    await this.redis.raw.ltrim(key, overflowCount, -1);
    return overflowRaw.map((r) => JSON.parse(r) as WindowMessage);
  }

  async updateSummary(conversationId: string, summary: string) {
    await this.redis.raw.set(summaryKey(conversationId), summary, 'EX', 24 * 3600);
  }

  /** Mem0 长期记忆检索；故障返回空（降级） */
  async searchLongTerm(userId: string, conversationId: string, query: string): Promise<string[]> {
    const url = this.config.get<string>('mem0.url');
    try {
      const res = await fetch(`${url}/v1/memories/search/`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...(this.config.get<string>('mem0.apiKey')
            ? { Authorization: `Token ${this.config.get<string>('mem0.apiKey')}` }
            : {}),
        },
        body: JSON.stringify({ query, user_id: userId, limit: 5 }),
        signal: AbortSignal.timeout(3_000),
      });
      if (!res.ok) throw new Error(`mem0 ${res.status}`);
      const json = (await res.json()) as { results?: { memory: string }[] };
      return (json.results ?? []).map((r) => r.memory);
    } catch (e) {
      this.logger.warn(`mem0 search degraded: ${(e as Error).message}`);
      return [];
    }
  }

  /** 异步写入长期记忆（不阻塞主流程） */
  addLongTerm(userId: string, conversationId: string, messages: WindowMessage[]): void {
    const url = this.config.get<string>('mem0.url');
    fetch(`${url}/v1/memories/`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(this.config.get<string>('mem0.apiKey')
          ? { Authorization: `Token ${this.config.get<string>('mem0.apiKey')}` }
          : {}),
      },
      body: JSON.stringify({
        messages: messages.map((m) => ({ role: m.role, content: m.content })),
        user_id: userId,
        session_id: conversationId,
      }),
      signal: AbortSignal.timeout(5_000),
    }).catch((e) => this.logger.warn(`mem0 add failed: ${(e as Error).message}`));
  }
}
