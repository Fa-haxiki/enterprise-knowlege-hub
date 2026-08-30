import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  Query,
  Res,
  UseGuards,
} from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import type { Response } from 'express';
import { IsBoolean, IsIn, IsOptional, IsString, IsUUID, MaxLength, MinLength } from 'class-validator';
import { SseEvent } from '@ekh/shared';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { CurrentUser, type AuthUser } from '../../common/decorators/current-user.decorator';
import { AgentService } from '../agents/agent.service';
import { ChatService } from './chat.service';
import { AuditService } from '../audit/audit.service';
import { PromptInjectionService } from '../security/prompt-injection.service';
import { RedisService } from '../../redis/redis.service';
import { ConfigService } from '@nestjs/config';
import { BizException } from '../../common/filters/http-exception.filter';
import { ErrorCode } from '@ekh/shared';

class ChatCompletionDto {
  @IsOptional()
  @IsUUID()
  conversation_id?: string;

  @IsOptional()
  @IsUUID()
  workspace_id?: string;

  @IsString()
  @MinLength(1)
  @MaxLength(4000)
  query: string;

  @IsOptional()
  options?: {
    enable_graph?: boolean;
    enable_tts?: boolean;
    model?: string;
  };
}

class RenameDto {
  @IsString()
  @MinLength(1)
  @MaxLength(256)
  title: string;
}

class FeedbackDto {
  @IsIn([1, -1])
  feedback: 1 | -1;

  @IsOptional()
  @IsString()
  @MaxLength(1000)
  comment?: string;
}

@ApiTags('chat')
@UseGuards(JwtAuthGuard)
@Controller({ version: '1' })
export class ChatController {
  constructor(
    private readonly agent: AgentService,
    private readonly chat: ChatService,
    private readonly audit: AuditService,
    private readonly redis: RedisService,
    private readonly config: ConfigService,
    private readonly injection: PromptInjectionService,
  ) {}

  /** 问答主接口：SSE 流式 */
  @Post('chat/completions')
  async completions(
    @Body() dto: ChatCompletionDto,
    @CurrentUser() user: AuthUser,
    @Res() res: Response,
  ) {
    await this.checkRateLimit(user.userId);

    // Prompt 注入检测：命中后拒绝进入 LLM 链路并落审计
    if (this.config.get<boolean>('security.injectionBlockEnabled')) {
      const hit = this.injection.detect(dto.query);
      if (hit) {
        this.audit.record({
          userId: user.userId,
          action: 'prompt_injection_blocked',
          resourceType: 'conversation',
          resourceId: dto.conversation_id,
          detail: { pattern: hit, query_preview: dto.query.slice(0, 100) },
        });
        throw new BizException(
          ErrorCode.PARAM_INVALID,
          '您的问题包含不安全指令，请调整后重试',
          400,
        );
      }
    }

    const conv = await this.chat.getOrCreateConversation(user.userId, dto.conversation_id, dto.workspace_id);
    // 新对话用首个问题自动生成标题
    if (!dto.conversation_id) {
      const autoTitle = dto.query.length > 20 ? `${dto.query.slice(0, 20)}…` : dto.query;
      await this.chat.rename(user.userId, conv.id, autoTitle);
    }
    await this.chat.saveUserMessage(conv.id, dto.query);

    res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
    res.setHeader('Cache-Control', 'no-cache, no-transform');
    res.setHeader('Connection', 'keep-alive');
    res.setHeader('X-Accel-Buffering', 'no');
    res.flushHeaders();

    const send = (event: SseEvent, data: unknown) => {
      res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
    };

    const t0 = Date.now();
    try {
      const { state: result, traceId } = await this.agent.run(
        {
          query: dto.query,
          userId: user.userId,
          conversationId: conv.id,
          workspaceId: dto.workspace_id ?? conv.workspaceId ?? undefined,
          enableGraph: dto.options?.enable_graph ?? true,
        },
        {
          onStatus: (stage, detail) => send(SseEvent.STATUS, { stage, detail }),
          onToken: (delta) => send(SseEvent.TOKEN, { delta }),
          onCitation: (citation) => send(SseEvent.CITATION, citation),
          onGraphPath: (triples) => send(SseEvent.GRAPH_PATH, { triples }),
        },
      );

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

      // meta 帧在生成前未能发出（message_id 依赖落库），此处通过 done 帧补齐
      send(SseEvent.USAGE, {
        ...result.usage,
        latency_ms: latencyMs,
        node_latencies: result.nodeLatencies,
        degraded: result.degraded,
      });
      send(SseEvent.DONE, {
        message_id: assistantMsg.id,
        conversation_id: conv.id,
        complexity: result.complexity ?? null,
      });

      this.audit.record({
        userId: user.userId,
        action: 'chat',
        resourceType: 'conversation',
        resourceId: conv.id,
        detail: { complexity: result.complexity, latency_ms: latencyMs },
      });
      void this.chat.updateMemory(conv.id, user.userId, [
        { role: 'user', content: dto.query },
        { role: 'assistant', content: result.answer },
      ]);
    } catch (e) {
      send(SseEvent.ERROR, {
        code: ErrorCode.INTERNAL,
        message: (e as Error).message || '问答失败',
      });
    } finally {
      res.end();
    }
  }

  @Get('conversations')
  listConversations(
    @CurrentUser() user: AuthUser,
    @Query('page') page = 1,
    @Query('page_size') pageSize = 20,
  ) {
    return this.chat.listConversations(user.userId, Number(page), Number(pageSize));
  }

  @Get('conversations/:id/messages')
  listMessages(
    @CurrentUser() user: AuthUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Query('page') page = 1,
    @Query('page_size') pageSize = 50,
  ) {
    return this.chat.listMessages(user.userId, id, Number(page), Number(pageSize));
  }

  @Patch('conversations/:id')
  rename(
    @CurrentUser() user: AuthUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: RenameDto,
  ) {
    return this.chat.rename(user.userId, id, dto.title);
  }

  @Delete('conversations/:id')
  removeConversation(@CurrentUser() user: AuthUser, @Param('id', ParseUUIDPipe) id: string) {
    return this.chat.remove(user.userId, id);
  }

  @Post('messages/:id/feedback')
  async feedback(
    @CurrentUser() user: AuthUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: FeedbackDto,
  ) {
    const result = await this.chat.feedback(user.userId, id, dto.feedback, dto.comment);
    this.audit.record({
      userId: user.userId,
      action: 'feedback',
      resourceType: 'message',
      resourceId: id,
      detail: { feedback: dto.feedback },
    });
    return result;
  }

  /** 问答限流：20 次/分/用户 */
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
