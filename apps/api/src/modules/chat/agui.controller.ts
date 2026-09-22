import { Body, Controller, Get, Param, ParseUUIDPipe, Post, Req, Res, UseGuards } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import type { Request, Response } from 'express';
import { IsArray, IsOptional, IsString, IsUUID } from 'class-validator';
import { ConfigService } from '@nestjs/config';
import { randomUUID } from 'crypto';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { CurrentUser, type AuthUser } from '../../common/decorators/current-user.decorator';
import { AgentService } from '../agents/agent.service';
import { ChatService } from './chat.service';
import { ChatRunService } from './chat-run.service';
import { RunSnapshot } from './run-snapshot';
import { AuditService } from '../audit/audit.service';
import { PromptInjectionService } from '../security/prompt-injection.service';
import { RedisService } from '../../redis/redis.service';
import { BizException } from '../../common/filters/http-exception.filter';
import { ErrorCode } from '@ekh/shared';

/** 客户端传来的单条消息，本接口只用 role=user 的最后一条作为本轮问题 */
class AguiMessageDto {
  @IsString()
  role: string;

  @IsString()
  content: string;
}

/**
 * AG-UI RunAgentInput 子集：
 * threadId ↔ conversation_id；messages 末条 user 消息为本次 query；
 * state 可携带 workspace_id / enable_graph。
 */
class AguiRunDto {
  @IsOptional()
  @IsUUID()
  threadId?: string;

  @IsOptional()
  @IsString()
  runId?: string;

  @IsArray()
  messages: AguiMessageDto[];

  @IsOptional()
  state?: {
    workspace_id?: string;
    enable_graph?: boolean;
  };

  /** AG-UI 标准 RunAgentInput 字段：客户端会携带，声明以通过 DTO 白名单（暂不使用） */
  @IsOptional()
  @IsArray()
  tools?: unknown[];

  @IsOptional()
  @IsArray()
  context?: unknown[];

  @IsOptional()
  forwardedProps?: Record<string, unknown>;
}

/**
 * AG-UI 协议端点：https://docs.ag-ui.com
 * 输出标准事件流（SSE data 帧，type 在 JSON 内）：
 * RUN_STARTED → STEP_STARTED/STEP_FINISHED ×N →
 * TEXT_MESSAGE_START/CONTENT/END → CUSTOM(citation/graph_path/usage) → RUN_FINISHED | RUN_ERROR
 */
@ApiTags('agui')
@UseGuards(JwtAuthGuard)
@Controller({ path: 'agui', version: '1' })
export class AguiController {
  constructor(
    private readonly agent: AgentService,
    private readonly chat: ChatService,
    private readonly audit: AuditService,
    private readonly redis: RedisService,
    private readonly config: ConfigService,
    private readonly injection: PromptInjectionService,
    private readonly runs: ChatRunService,
  ) {}

  private writeSse(res: Response, payload: Record<string, unknown>) {
    if (res.writableEnded || res.destroyed) return;
    try {
      res.write(`data: ${JSON.stringify(payload)}\n\n`);
    } catch {
      /* 客户端已断开 */
    }
  }

  private beginSse(res: Response) {
    res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
    res.setHeader('Cache-Control', 'no-cache, no-transform');
    res.setHeader('Connection', 'keep-alive');
    res.setHeader('X-Accel-Buffering', 'no');
    res.setTimeout(0);
    res.flushHeaders();
  }

  /**
   * 一次流式问答：校验 → 建会话 → 跑 Agent → 把事件推给前端 → 落库。
   * 用 @Res() 接管响应，自行写 SSE，不走 Nest 默认 JSON 序列化。
   */
  @Post('chat')
  async run(
    @Body() dto: AguiRunDto,
    @CurrentUser() user: AuthUser,
    @Res() res: Response,
  ) {
    // 从消息列表末尾往前找最近一条用户消息，作为本轮问题
    const query = [...dto.messages].reverse().find((m) => m.role === 'user')?.content?.trim();
    if (!query) {
      throw new BizException(ErrorCode.PARAM_INVALID, 'messages 中缺少 user 消息', 400);
    }
    if (query.length > 4000) {
      throw new BizException(ErrorCode.PARAM_INVALID, '问题长度超出限制', 400);
    }
    // 按用户限流，超限直接 429，不进入后续流程
    await this.checkRateLimit(user.userId);

    // 开启拦截时，命中注入特征则记审计并拒绝，避免恶意指令进入 Agent
    if (this.config.get<boolean>('security.injectionBlockEnabled')) {
      const hit = this.injection.detect(query);
      if (hit) {
        this.audit.record({
          userId: user.userId,
          action: 'prompt_injection_blocked',
          resourceType: 'conversation',
          resourceId: dto.threadId,
          detail: { pattern: hit, query_preview: query.slice(0, 100) },
        });
        throw new BizException(ErrorCode.PARAM_INVALID, '您的问题包含不安全指令，请调整后重试', 400);
      }
    }

    // threadId 即会话 id：已有则复用，没有则创建；created 表示这是新会话
    const { conv, created } = await this.chat.getOrCreateByThreadId(
      user.userId,
      dto.threadId,
      dto.state?.workspace_id,
    );
    // 新会话标题与问答流并行生成（长问题走 LLM 总结，失败降级截取），不阻塞流式输出
    let title = conv.title;
    const titlePromise = created ? this.chat.generateTitle(query) : null;
    if (this.runs.isLive(conv.id)) {
      throw new BizException(ErrorCode.CONFLICT, '当前对话正在生成，请稍后再试', 409);
    }

    // 用户问题先落库，后续即使 Agent 失败，提问记录仍在
    await this.chat.saveUserMessage(conv.id, query);

    const threadId = conv.id;
    const runId = dto.runId ?? randomUUID();
    const abort = new AbortController();
    try {
      await this.runs.begin(threadId, { userId: user.userId, query, runId }, abort);
    } catch {
      throw new BizException(ErrorCode.CONFLICT, '当前对话正在生成，请稍后再试', 409);
    }

    // 声明 SSE：禁止缓存和反向代理缓冲，保证 token 能逐段到达浏览器
    this.beginSse(res);

    // 本轮助手消息在事件流里的临时 id，落库后的真实 id 在 RUN_FINISHED.result 里返回
    const streamMsgId = `agui-${runId}`;
    let appendQueue = Promise.resolve();
    const send = (payload: Record<string, unknown>) => {
      appendQueue = appendQueue.then(() => this.runs.append(threadId, payload));
      this.writeSse(res, payload);
    };

    // 正文开始事件只发一次：第一个 token 到来时补发 TEXT_MESSAGE_START
    let textStarted = false;
    const ensureTextStart = () => {
      if (!textStarted) {
        textStarted = true;
        send({ type: 'TEXT_MESSAGE_START', messageId: streamMsgId, role: 'assistant' });
      }
    };

    const t0 = Date.now();
    let partialAnswer = '';
    const snapshot = new RunSnapshot();
    let runStatus: 'done' | 'aborted' = 'done';
    try {
      send({ type: 'RUN_STARTED', threadId, runId });

      // 跑完整条 Agent：回调把检索、步骤、token、引用等实时转成 AG-UI 事件
      const { state: result, traceId } = await this.agent.run(
        {
          query,
          userId: user.userId,
          conversationId: conv.id,
          workspaceId: dto.state?.workspace_id ?? conv.workspaceId ?? undefined,
          enableGraph: dto.state?.enable_graph ?? true,
        },
        {
          // 当前阶段的简短状态，供前端展示「正在检索」之类的提示
          onStatus: (stage, detail) =>
            send({ type: 'CUSTOM', name: 'status_detail', value: { stage, detail } }),
          onStepStart: (node) => {
            snapshot.startStep(node);
            send({ type: 'STEP_STARTED', stepName: node });
          },
          onStepEnd: (node, latencyMs, degraded, output) => {
            snapshot.endStep(node, latencyMs ?? 0, !!degraded, output);
            send({ type: 'STEP_FINISHED', stepName: node, meta: { latencyMs, degraded, output } });
          },
          onToken: (delta) => {
            partialAnswer += delta;
            ensureTextStart();
            send({ type: 'TEXT_MESSAGE_CONTENT', messageId: streamMsgId, delta });
          },
          onCitation: (citation) => {
            snapshot.addCitation(citation);
            send({ type: 'CUSTOM', name: 'citation', value: citation });
          },
          // 重检索时清空前端已展示的引用，避免旧引用残留
          onCitationsReset: () => {
            snapshot.resetCitations();
            send({ type: 'CUSTOM', name: 'citations_reset', value: true });
          },
          onGraphPath: (triples) => {
            snapshot.setGraph(triples);
            send({ type: 'CUSTOM', name: 'graph_path', value: { triples } });
          },
          onIntent: (intent, suggestedQuery) => {
            snapshot.setIntent(intent, suggestedQuery);
            send({ type: 'CUSTOM', name: 'intent', value: { intent, suggestedQuery } });
          },
          onToolStart: (name, args) => {
            snapshot.startTool(name, args);
            send({ type: 'TOOL_CALL_START', toolCallName: name, toolCallId: `${runId}-${name}` });
            if (args) send({ type: 'TOOL_CALL_ARGS', toolCallId: `${runId}-${name}`, delta: JSON.stringify(args) });
          },
          onToolEnd: (name, summary) => {
            snapshot.endTool(name, summary);
            send({ type: 'TOOL_CALL_END', toolCallId: `${runId}-${name}`, toolCallName: name, result: summary });
          },
          onThinking: (text) => {
            snapshot.setThinking(text);
            // @ag-ui/core 0.0.59 没有 REASONING_CONTENT；正文必须走 REASONING_MESSAGE_*
            send({ type: 'REASONING_START', messageId: streamMsgId });
            send({ type: 'REASONING_MESSAGE_START', messageId: streamMsgId, role: 'reasoning' });
            send({ type: 'REASONING_MESSAGE_CONTENT', messageId: streamMsgId, delta: text });
            send({ type: 'REASONING_MESSAGE_END', messageId: streamMsgId });
            send({ type: 'REASONING_END', messageId: streamMsgId });
            // 自定义事件给自研前端用，上面的标准事件给 AG-UI 客户端用
            send({ type: 'CUSTOM', name: 'think', value: text });
          },
        },
        abort.signal,
      );
      if (textStarted) send({ type: 'TEXT_MESSAGE_END', messageId: streamMsgId });

      // 标题生成与问答并行，此处只需等剩余时间（通常已完成）
      if (titlePromise) {
        title = await titlePromise;
        await this.chat.rename(user.userId, conv.id, title);
      }

      const latencyMs = Date.now() - t0;
      // 助手回复、引用和 token 用量写入 messages
      const assistantMsg = await this.chat.saveAssistantMessage(
        conv.id,
        result.answer,
        result.citations,
        result.usage,
        latencyMs,
      );
      // 推理过程写入 qa_records，历史回放时前端靠它还原步骤与图谱
      await this.chat.saveQaRecord(assistantMsg.id, {
        complexity: result.complexity ?? null,
        intent: result.intent ?? null,
        suggestedQuery: result.suggestedQuery || null,
        iterations: result.iteration,
        thinking: result.thinking || null,
        toolTrace: result.toolTrace,
        stepTrace: result.nodeLatencies,
        recalledChunkIds: result.rerankedChunks.map((c) => c.chunk_id),
        graphTriples: result.graphTriples,
        nodeLatencies: this.agent.latencyMap(result),
        degradedNodes: result.degraded,
        langfuseTraceId: traceId ?? undefined,
      });

      // 用量与降级信息单独推一次，前端可在正文结束后展示耗时
      send({
        type: 'CUSTOM',
        name: 'usage',
        value: {
          ...result.usage,
          latency_ms: latencyMs,
          node_latencies: this.agent.latencyMap(result),
          degraded: result.degraded,
          intent: result.intent,
          thinking: result.thinking,
        },
      });
      // 结束帧带回真实 message_id 和会话标题，前端用它们替换流式临时 id
      send({
        type: 'RUN_FINISHED',
        threadId,
        runId,
        messageId: streamMsgId,
        result: {
          message_id: assistantMsg.id,
          conversation_id: conv.id,
          complexity: result.complexity ?? null,
          intent: result.intent ?? null,
          title,
        },
      });

      this.audit.record({
        userId: user.userId,
        action: 'chat',
        resourceType: 'conversation',
        resourceId: conv.id,
        detail: { complexity: result.complexity, latency_ms: latencyMs, protocol: 'ag-ui' },
      });
      // 记忆更新不阻塞响应结束：窗口追加、溢出压缩、长期记忆都在后台做
      void this.chat.updateMemory(
        conv.id,
        user.userId,
        [
          { role: 'user', content: query },
          { role: 'assistant', content: result.answer },
        ],
        result.webHits.map((h) => `${h.title} ${h.url}`.trim()).filter(Boolean),
      );
    } catch (e) {
      // 问答失败也要把已生成的标题落库，避免新会话停留在默认标题
      if (titlePromise) {
        void titlePromise
          .then((t) => this.chat.rename(user.userId, conv.id, t))
          .catch(() => undefined);
      }
      const errMsg = (e as Error).message || '';
      const aborted = abort.signal.aborted || /abort|BodyStreamBuffer/i.test(errMsg);
      if (aborted) {
        runStatus = 'aborted';
        snapshot.flushOpen();
        let messageId: string | undefined;
        if (snapshot.hasProgress(partialAnswer)) {
          const saved = await this.chat.saveAssistantMessage(
            conv.id,
            partialAnswer,
            snapshot.citations,
            { prompt_tokens: 0, completion_tokens: 0 },
            Date.now() - t0,
          );
          messageId = saved.id;
          await this.chat.saveQaRecord(saved.id, snapshot.qaPayload());
        }
        try {
          if (textStarted) send({ type: 'TEXT_MESSAGE_END', messageId: streamMsgId });
          send({
            type: 'RUN_FINISHED',
            threadId,
            runId,
            messageId: streamMsgId,
            result: {
              message_id: messageId,
              conversation_id: conv.id,
              complexity: null,
              intent: snapshot.intent,
              title,
            },
          });
        } catch {
          /* 客户端已断开，落库即可 */
        }
      } else {
        if (textStarted) send({ type: 'TEXT_MESSAGE_END', messageId: streamMsgId });
        send({ type: 'RUN_ERROR', message: (e as Error).message || '问答失败', code: ErrorCode.INTERNAL });
      }
    } finally {
      await appendQueue.catch(() => undefined);
      await this.runs.markDone(threadId, runStatus);
      res.end();
    }
  }

  /** 切走/关页后重新挂上：回放 Redis 里的事件并跟上尚未结束的生成 */
  @Get('chat/:threadId/resume')
  async resume(
    @Param('threadId', ParseUUIDPipe) threadId: string,
    @CurrentUser() user: AuthUser,
    @Req() req: Request,
    @Res() res: Response,
  ) {
    await this.chat.requireOwned(user.userId, threadId);
    const meta = await this.runs.getMeta(threadId);
    if (!meta && !this.runs.isLive(threadId)) {
      res.status(204).end();
      return;
    }
    this.beginSse(res);
    const detach = new AbortController();
    req.on('close', () => detach.abort());
    try {
      await this.runs.replayAndTail(threadId, (event) => this.writeSse(res, event), detach.signal);
    } finally {
      res.end();
    }
  }

  /** 用户点停止：中止后台 Agent（切走对话不会走这里） */
  @Post('chat/:threadId/cancel')
  async cancel(
    @Param('threadId', ParseUUIDPipe) threadId: string,
    @CurrentUser() user: AuthUser,
  ) {
    await this.chat.requireOwned(user.userId, threadId);
    return { cancelled: this.runs.cancel(threadId) };
  }

  /** 与 chat.controller 一致的限流策略：20 次/分/用户 */
  private async checkRateLimit(userId: string) {
    const limit = this.config.get<number>('rag.chatRateLimitPerMin') ?? 20;
    const key = `chat:rate:${userId}`;
    // INCR 原子计数；第一次写入时设置 60 秒过期，形成滑动窗口的近似
    const count = await this.redis.raw.incr(key);
    if (count === 1) await this.redis.raw.expire(key, 60);
    if (count > limit) {
      throw new BizException(ErrorCode.RATE_LIMITED, '提问过于频繁，请稍后再试', 429);
    }
  }
}
