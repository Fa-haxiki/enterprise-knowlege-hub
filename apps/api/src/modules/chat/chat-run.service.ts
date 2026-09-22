import { Injectable, Logger } from '@nestjs/common';
import { RedisService } from '../../redis/redis.service';

const EVENTS_TTL_RUNNING = 20 * 60;
const EVENTS_TTL_DONE = 90;
const TAIL_INTERVAL_MS = 150;

export interface ChatRunMeta {
  userId: string;
  query: string;
  runId: string;
  status: 'running' | 'done' | 'aborted';
}

export function isTerminalAguiEvent(payload: { type?: string }): boolean {
  return payload.type === 'RUN_FINISHED' || payload.type === 'RUN_ERROR';
}

interface LiveRun {
  abort: AbortController;
  meta: ChatRunMeta;
}

@Injectable()
export class ChatRunService {
  private readonly logger = new Logger(ChatRunService.name);
  private readonly live = new Map<string, LiveRun>();

  constructor(private readonly redis: RedisService) {}

  isLive(conversationId: string): boolean {
    return this.live.has(conversationId);
  }

  getLiveAbort(conversationId: string): AbortSignal | undefined {
    return this.live.get(conversationId)?.abort.signal;
  }

  async getMeta(conversationId: string): Promise<ChatRunMeta | null> {
    const live = this.live.get(conversationId);
    if (live) return live.meta;
    const raw = await this.redis.raw.get(this.metaKey(conversationId));
    if (!raw) return null;
    try {
      return JSON.parse(raw) as ChatRunMeta;
    } catch {
      return null;
    }
  }

  /** 当前仍在跑的会话，给历史接口带回，前端据此自动 resume */
  async getActiveRun(conversationId: string): Promise<{ query: string; run_id: string } | null> {
    const meta = await this.getMeta(conversationId);
    if (meta?.status !== 'running') return null;
    return { query: meta.query, run_id: meta.runId };
  }

  async begin(conversationId: string, meta: Omit<ChatRunMeta, 'status'>, abort: AbortController): Promise<void> {
    if (this.live.has(conversationId)) {
      throw new Error('run already live');
    }
    this.live.set(conversationId, { abort, meta: { ...meta, status: 'running' } });
    const payload = JSON.stringify({ ...meta, status: 'running' satisfies ChatRunMeta['status'] });
    await this.redis.raw
      .pipeline()
      .set(this.metaKey(conversationId), payload, 'EX', EVENTS_TTL_RUNNING)
      .del(this.eventsKey(conversationId))
      .exec();
  }

  async append(conversationId: string, event: Record<string, unknown>): Promise<void> {
    const key = this.eventsKey(conversationId);
    try {
      await this.redis.raw.pipeline().rpush(key, JSON.stringify(event)).expire(key, EVENTS_TTL_RUNNING).exec();
    } catch (e) {
      this.logger.warn(`append run event failed: ${(e as Error).message}`);
    }
  }

  async markDone(conversationId: string, status: 'done' | 'aborted'): Promise<void> {
    const live = this.live.get(conversationId);
    if (live) live.meta.status = status;
    this.live.delete(conversationId);
    const raw = await this.redis.raw.get(this.metaKey(conversationId));
    let next: ChatRunMeta | null = null;
    if (raw) {
      try {
        next = { ...(JSON.parse(raw) as ChatRunMeta), status };
      } catch {
        next = null;
      }
    }
    const pipe = this.redis.raw.pipeline();
    if (next) pipe.set(this.metaKey(conversationId), JSON.stringify(next), 'EX', EVENTS_TTL_DONE);
    else pipe.expire(this.metaKey(conversationId), EVENTS_TTL_DONE);
    pipe.expire(this.eventsKey(conversationId), EVENTS_TTL_DONE);
    await pipe.exec();
  }

  cancel(conversationId: string): boolean {
    const live = this.live.get(conversationId);
    if (!live) return false;
    live.abort.abort();
    return true;
  }

  /**
   * 回放已缓存事件，再跟着 LIST 增长往下读，直到终态或本端断开。
   * 进程里已经没有这场 run 且缓冲也没有终态时，结束回放（客户端改拉历史）。
   */
  async replayAndTail(
    conversationId: string,
    write: (event: Record<string, unknown>) => void,
    signal: AbortSignal,
  ): Promise<void> {
    let idx = 0;
    let idle = 0;
    while (!signal.aborted) {
      const chunk = await this.redis.raw.lrange(this.eventsKey(conversationId), idx, -1);
      for (const raw of chunk) {
        let event: Record<string, unknown>;
        try {
          event = JSON.parse(raw) as Record<string, unknown>;
        } catch {
          idx += 1;
          continue;
        }
        write(event);
        idx += 1;
        if (isTerminalAguiEvent(event)) return;
      }
      if (this.live.has(conversationId)) {
        idle = 0;
        await this.sleep(TAIL_INTERVAL_MS, signal);
        continue;
      }
      idle += 1;
      if (idx === 0 && idle > 4) return;
      if (idle > 8) return;
      await this.sleep(TAIL_INTERVAL_MS, signal);
    }
  }

  private metaKey(id: string) {
    return `chat:run:meta:${id}`;
  }

  private eventsKey(id: string) {
    return `chat:run:events:${id}`;
  }

  private sleep(ms: number, signal: AbortSignal): Promise<void> {
    return new Promise((resolve) => {
      const t = setTimeout(resolve, ms);
      const onAbort = () => {
        clearTimeout(t);
        resolve();
      };
      if (signal.aborted) {
        clearTimeout(t);
        resolve();
        return;
      }
      signal.addEventListener('abort', onAbort, { once: true });
    });
  }
}
