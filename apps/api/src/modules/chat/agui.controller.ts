import { Body, Controller, Post, Res, UseGuards } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import type { Response } from 'express';
import { IsArray, IsOptional, IsString, IsUUID } from 'class-validator';
import { ConfigService } from '@nestjs/config';
import { randomUUID } from 'crypto';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { CurrentUser, type AuthUser } from '../../common/decorators/current-user.decorator';
import { AgentService } from '../agents/agent.service';
import { ChatService } from './chat.service';
import { AuditService } from '../audit/audit.service';
import { PromptInjectionService } from '../security/prompt-injection.service';
import { RedisService } from '../../redis/redis.service';
import { BizException } from '../../common/filters/http-exception.filter';
import { ErrorCode } from '@ekh/shared';

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
  ) {}

  @Post('chat')
  async run(@Body() dto: AguiRunDto, @CurrentUser() user: AuthUser, @Res() res: Response) {
    const query = [...dto.messages].reverse().find((m) => m.role === 'user')?.content?.trim();
    if (!query) {
      throw new BizException(ErrorCode.PARAM_INVALID, 'messages 中缺少 user 消息', 400);
    }
    if (query.length > 4000) {
      throw new BizException(ErrorCode.PARAM_INVALID, '问题长度超出限制', 400);
    }
    await this.checkRateLimit(user.userId);

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

    const { conv, created } = await this.chat.getOrCreateByThreadId(
      user.userId,
      dto.threadId,
      dto.state?.workspace_id,
    );
    // 新会话用首个问题自动生成标题
    if (created) {
      const autoTitle = query.length > 20 ? `${query.slice(0, 20)}…` : query;
      await this.chat.rename(user.userId, conv.id, autoTitle);
    }
    await this.chat.saveUserMessage(conv.id, query);

    res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
    res.setHeader('Cache-Control', 'no-cache, no-transform');
    res.setHeader('Connection', 'keep-alive');
    res.setHeader('X-Accel-Buffering', 'no');
    res.flushHeaders();

    const threadId = conv.id;
    const runId = dto.runId ?? randomUUID();
    const streamMsgId = `agui-${runId}`;
    const send = (payload: Record<string, unknown>) => {
      res.write(`data: ${JSON.stringify(payload)}\n\n`);
    };

    let textStarted = false;
    const ensureTextStart = () => {
      if (!textStarted) {
        textStarted = true;
        send({ type: 'TEXT_MESSAGE_START', messageId: streamMsgId, role: 'assistant' });
      }
    };

    const t0 = Date.now();
    try {
      send({ type: 'RUN_STARTED', threadId, runId });

      const { state: result, traceId } = await this.agent.run(
        {
          query,
          userId: user.userId,
          conversationId: conv.id,
          workspaceId: dto.state?.workspace_id ?? conv.workspaceId ?? undefined,
          enableGraph: dto.state?.enable_graph ?? true,
        },
        {
          onStatus: (stage, detail) =>
            send({ type: 'CUSTOM', name: 'status_detail', value: { stage, detail } }),
          onStepStart: (node) => send({ type: 'STEP_STARTED', stepName: node }),
          onStepEnd: (node, latencyMs, degraded) =>
            send({ type: 'STEP_FINISHED', stepName: node, meta: { latencyMs, degraded } }),
          onToken: (delta) => {
            ensureTextStart();
            send({ type: 'TEXT_MESSAGE_CONTENT', messageId: streamMsgId, delta });
          },
          onCitation: (citation) => send({ type: 'CUSTOM', name: 'citation', value: citation }),
          onGraphPath: (triples) => send({ type: 'CUSTOM', name: 'graph_path', value: { triples } }),
        },
      );
      if (textStarted) send({ type: 'TEXT_MESSAGE_END', messageId: streamMsgId });

      const latencyMs = Date.now() - t0;
      const assistantMsg = await this.chat.saveAssistantMessage(
        conv.id,
        result.answer,
        result.citations,
        result.usage,
        latencyMs,
      );
      await this.chat.saveQaRecord(assistantMsg.id, {
        complexity: result.complexity ?? null,
        recalledChunkIds: result.rerankedChunks.map((c) => c.chunk_id),
        graphTriples: result.graphTriples,
        nodeLatencies: result.nodeLatencies,
        degradedNodes: result.degraded,
        langfuseTraceId: traceId ?? undefined,
      });

      send({
        type: 'CUSTOM',
        name: 'usage',
        value: {
          ...result.usage,
          latency_ms: latencyMs,
          node_latencies: result.nodeLatencies,
          degraded: result.degraded,
        },
      });
      send({
        type: 'RUN_FINISHED',
        threadId,
        runId,
        result: {
          message_id: assistantMsg.id,
          conversation_id: conv.id,
          complexity: result.complexity ?? null,
        },
      });

      this.audit.record({
        userId: user.userId,
        action: 'chat',
        resourceType: 'conversation',
        resourceId: conv.id,
        detail: { complexity: result.complexity, latency_ms: latencyMs, protocol: 'ag-ui' },
      });
      void this.chat.updateMemory(conv.id, user.userId, [
        { role: 'user', content: query },
        { role: 'assistant', content: result.answer },
      ]);
    } catch (e) {
      if (textStarted) send({ type: 'TEXT_MESSAGE_END', messageId: streamMsgId });
      send({ type: 'RUN_ERROR', message: (e as Error).message || '问答失败', code: ErrorCode.INTERNAL });
    } finally {
      res.end();
    }
  }

  /** 与 chat.controller 一致的限流策略：20 次/分/用户 */
  private async checkRateLimit(userId: string) {
    const limit = this.config.get<number>('rag.chatRateLimitPerMin') ?? 20;
    const key = `chat:rate:${userId}`;
    const count = await this.redis.raw.incr(key);
    if (count === 1) await this.redis.raw.expire(key, 60);
    if (count > limit) {
      throw new BizException(ErrorCode.RATE_LIMITED, '提问过于频繁，请稍后再试', 429);
    }
  }
}
