import { Injectable, Logger } from '@nestjs/common';
import { RedisService } from '../../redis/redis.service';

// 生成中事件要留得够久，刷新/切走回来还能回放
const EVENTS_TTL_RUNNING = 20 * 60;
// 结束后只短留一会儿，给还没接上的 resume 用完就过期
const EVENTS_TTL_DONE = 90;
// 回放跟上新帧的轮询间隔，太密会空打 Redis
const TAIL_INTERVAL_MS = 150;

export interface ChatRunMeta {
  userId: string;
  query: string;
  runId: string;
  status: 'running' | 'done' | 'aborted';
}

/** 图跑完或报错，resume 看到这两种帧就可以停，不必再轮询 */
export function isTerminalAguiEvent(payload: { type?: string }): boolean {
  return payload.type === 'RUN_FINISHED' || payload.type === 'RUN_ERROR';
}

/** 只活在当前进程：用来 abort 这场图，多实例时别的进程看不到 */
interface LiveRun {
  abort: AbortController;
  meta: ChatRunMeta;
}

/**
 * 一场问答的「还在不在跑」和「已经吐过哪些帧」。
 * 进程内 Map 管取消；Redis 管断线后续上——关页后前端缓冲没了，靠事件列表回放。
 */
@Injectable()
export class ChatRunService {
  private readonly logger = new Logger(ChatRunService.name);
  private readonly live = new Map<string, LiveRun>();

  constructor(private readonly redis: RedisService) {}

  /** 本进程是否正在跑这场问答（别的进程的 run 会是 false） */
  isLive(conversationId: string): boolean {
    return this.live.has(conversationId);
  }

  /** 给 Agent 挂上的中止信号；没有这场 run 就返回 undefined */
  getLiveAbort(conversationId: string): AbortSignal | undefined {
    return this.live.get(conversationId)?.abort.signal;
  }

  /**
   * 先看本进程，没有再读 Redis。
   * 刷新后进程里可能还在跑，但新请求不一定打到同一份内存，所以 meta 必须落 Redis。
   */
  async getMeta(conversationId: string): Promise<ChatRunMeta | null> {
    const live = this.live.get(conversationId);
    if (live) return live.meta;
    const raw = await this.redis.raw.get(this.metaKey(conversationId));
    if (!raw) return null;
    try {
      return JSON.parse(raw) as ChatRunMeta;
    } catch {
      return null; // 脏数据不当成还在跑，避免前端误走 resume
    }
  }

  /** 当前仍在跑的会话，给历史接口带回，前端据此自动 resume */
  async getActiveRun(conversationId: string): Promise<{ query: string; run_id: string } | null> {
    const meta = await this.getMeta(conversationId);
    if (meta?.status !== 'running') return null; // 已结束或从未开始，前端按普通历史渲染
    return { query: meta.query, run_id: meta.runId };
  }

  /**
   * 登记一场新问答。同会话已有进行中的 run 直接拒绝，避免两路 SSE 抢同一份事件列表。
   * 同时清掉上一场残留帧，防止这次回放混进旧内容。
   */
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

  /**
   * 每吐一帧就追加到 Redis 列表，刷新后 resume 按顺序重放。
   * 写失败只打日志：画面可以缺一帧，不能因为 Redis 抖动把整场问答打断。
   */
  async append(conversationId: string, event: Record<string, unknown>): Promise<void> {
    const key = this.eventsKey(conversationId);
    try {
      // 顺手续上 TTL，长问答不会在生成到一半时列表过期
      await this.redis.raw.pipeline().rpush(key, JSON.stringify(event)).expire(key, EVENTS_TTL_RUNNING).exec();
    } catch (e) {
      this.logger.warn(`append run event failed: ${(e as Error).message}`);
    }
  }

  /**
   * 这场问答结束：移出本进程，并把 Redis 状态改成 done/aborted，TTL 收到 90 秒。
   * 不立刻删事件，迟到的 resume 还能把最后几帧补上。
   */
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
        next = null; // meta 坏了就只缩短过期时间，不再覆盖成半截 JSON
      }
    }
    const pipe = this.redis.raw.pipeline();
    if (next) pipe.set(this.metaKey(conversationId), JSON.stringify(next), 'EX', EVENTS_TTL_DONE);
    else pipe.expire(this.metaKey(conversationId), EVENTS_TTL_DONE);
    pipe.expire(this.eventsKey(conversationId), EVENTS_TTL_DONE);
    await pipe.exec();
  }

  /**
   * 用户点停止时调用：只 abort 本进程这场图，真正收尾在 Agent 抛出后走 markDone。
   * 返回 false 表示这场已经不在本进程（可能已结束，或打到了别的实例）。
   */
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
    let idx = 0; // 已经交给客户端的条数，下次只读新增
    let idle = 0; // 连续多少轮列表没涨，用来判断是不是已经停了
    while (!signal.aborted) {
      const chunk = await this.redis.raw.lrange(this.eventsKey(conversationId), idx, -1);
      for (const raw of chunk) {
        let event: Record<string, unknown>;
        try {
          event = JSON.parse(raw) as Record<string, unknown>;
        } catch {
          idx += 1; // 坏帧跳过，避免卡在同一条上死循环
          continue;
        }
        write(event);
        idx += 1;
        if (isTerminalAguiEvent(event)) return; // 跑完或报错，后面不会再有帧
      }
      // 本进程还在跑：空转不算结束，继续等下一帧
      if (this.live.has(conversationId)) {
        idle = 0;
        await this.sleep(TAIL_INTERVAL_MS, signal);
        continue;
      }
      idle += 1;
      // 一条都没有：多半是 meta 还在、事件还没写出来，再等几轮
      if (idx === 0 && idle > 4) return;
      // 有帧但没有终态、进程也不在跑：生成可能已经落库，别一直挂着
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

  /** 可被客户端断开打断的等待，避免 resume 关掉后还在空转 */
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
