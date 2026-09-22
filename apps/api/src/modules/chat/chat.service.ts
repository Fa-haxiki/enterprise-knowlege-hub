import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { In, Repository } from 'typeorm';
import {
  AgentIntent,
  Complexity,
  ErrorCode,
  MessageRole,
  type Citation,
  type NodeLatency,
  type ToolTrace,
  type Triple,
} from '@ekh/shared';
import { HumanMessage, SystemMessage } from '@langchain/core/messages';
import { ConversationEntity } from '../../database/entities/conversation.entity';
import { MessageEntity } from '../../database/entities/message.entity';
import { QaRecordEntity } from '../../database/entities/qa-record.entity';
import { BizException } from '../../common/filters/http-exception.filter';
import { MemoryService, type WindowMessage } from '../memory/memory.service';
import { LlmService } from '../llm/llm.service';
import { LangfuseService } from '../observability/langfuse.service';
import { ChatRunService } from './chat-run.service';

/**
 * 会话持久化：创建/查询会话、保存问答、回放历史、更新记忆与标题。
 * Agent 推理不在这里，只消费其结果。
 */
@Injectable()
export class ChatService {
  constructor(
    @InjectRepository(ConversationEntity)
    private readonly conversations: Repository<ConversationEntity>,
    @InjectRepository(MessageEntity)
    private readonly messages: Repository<MessageEntity>,
    @InjectRepository(QaRecordEntity)
    private readonly qaRecords: Repository<QaRecordEntity>,
    private readonly memory: MemoryService,
    private readonly llm: LlmService,
    private readonly langfuse: LangfuseService,
    private readonly runs: ChatRunService,
  ) {}

  /**
   * 按客户端传入的 conversationId 取会话；未传则新建。
   * 会话必须属于当前用户，否则按不存在处理，避免泄露他人对话。
   */
  async getOrCreateConversation(userId: string, conversationId: string | undefined, workspaceId?: string) {
    if (conversationId) {
      const conv = await this.conversations.findOne({ where: { id: conversationId } });
      if (!conv || conv.userId !== userId) {
        throw new BizException(ErrorCode.NOT_FOUND, '对话不存在', 404);
      }
      return conv;
    }
    return this.conversations.save(
      this.conversations.create({ userId, workspaceId: workspaceId ?? null }),
    );
  }

  /**
   * AG-UI 语义：threadId 由客户端生成。会话不存在时以 threadId 作为会话 id 直接创建，
   * 保证 threadId 与 conversation_id 始终一致，前端无需处理 id 变更。
   * 返回 created，调用方据此决定是否并行生成标题。
   */
  async getOrCreateByThreadId(userId: string, threadId: string | undefined, workspaceId?: string) {
    if (threadId) {
      const conv = await this.conversations.findOne({ where: { id: threadId } });
      if (conv) {
        if (conv.userId !== userId) {
          throw new BizException(ErrorCode.NOT_FOUND, '对话不存在', 404);
        }
        return { conv, created: false };
      }
      // 用客户端 threadId 当主键，后续事件里的 threadId 不用再替换
      const created = await this.conversations.save(
        this.conversations.create({ id: threadId, userId, workspaceId: workspaceId ?? null }),
      );
      return { conv: created, created: true };
    }
    // 客户端没带 threadId 时由数据库生成 id
    const created = await this.conversations.save(
      this.conversations.create({ userId, workspaceId: workspaceId ?? null }),
    );
    return { conv: created, created: true };
  }

  /** 写入用户提问，角色固定为 user */
  async saveUserMessage(conversationId: string, content: string) {
    return this.messages.save(
      this.messages.create({ conversationId, role: MessageRole.USER, content }),
    );
  }

  /** 写入助手回复，并刷新会话 updatedAt，让列表按最近对话排序 */
  async saveAssistantMessage(
    conversationId: string,
    content: string,
    citations: Citation[],
    usage: { prompt_tokens: number; completion_tokens: number },
    latencyMs: number,
  ) {
    const msg = await this.messages.save(
      this.messages.create({
        conversationId,
        role: MessageRole.ASSISTANT,
        content,
        citations,
        usage,
        latencyMs,
      }),
    );
    await this.conversations.update(conversationId, { updatedAt: new Date() });
    return msg;
  }

  /**
   * 保存一轮问答的可观测数据：复杂度、意图、工具轨迹、召回片段、图谱三元组等。
   * 与 messages 分开存，历史回放时按 messageId 再拼回去。
   */
  async saveQaRecord(
    messageId: string,
    data: {
      complexity: Complexity | null;
      intent?: AgentIntent | null;
      iterations?: number;
      thinking?: string | null;
      suggestedQuery?: string | null;
      toolTrace?: ToolTrace[];
      stepTrace?: NodeLatency[];
      recalledChunkIds: string[];
      graphTriples: Triple[];
      nodeLatencies: Record<string, number>;
      degradedNodes: string[];
      langfuseTraceId?: string;
      externalFacts?: string[];
    },
  ) {
    await this.qaRecords.save(
      this.qaRecords.create({
        messageId,
        complexity: data.complexity,
        intent: data.intent ?? null,
        iterations: data.iterations ?? 0,
        thinking: data.thinking ?? null,
        suggestedQuery: data.suggestedQuery ?? null,
        toolTrace: data.toolTrace ?? [],
        stepTrace: data.stepTrace ?? [],
        recalledChunkIds: data.recalledChunkIds,
        graphTriples: data.graphTriples,
        nodeLatencies: data.nodeLatencies,
        degradedNodes: data.degradedNodes,
        langfuseTraceId: data.langfuseTraceId ?? null,
      }),
    );
  }

  /**
   * 更新短期窗口；溢出部分异步压缩进滚动摘要。
   * 有外部检索结果时，把标题和链接拼成一条助手消息，一并写入长期记忆。
   */
  async updateMemory(
    conversationId: string,
    userId: string,
    round: WindowMessage[],
    externalFacts: string[] = [],
  ) {
    // 追加本轮到短期窗口，返回被挤出窗口的旧消息
    const overflow = await this.memory.appendWindow(conversationId, round);
    if (overflow.length > 0) {
      // 压缩失败不影响本轮回答，所以不等待
      void this.compressOverflow(conversationId, overflow);
    }
    const longTerm = externalFacts.length
      ? [
          ...round,
          {
            role: 'assistant' as const,
            content: `本轮确认的外部事实：\n${externalFacts.map((f) => `- ${f}`).join('\n')}`,
          },
        ]
      : round;
    this.memory.addLongTerm(userId, conversationId, longTerm);
  }

  /** 把挤出窗口的对话压成不超过 200 字的滚动摘要，与已有摘要合并 */
  private async compressOverflow(conversationId: string, overflow: WindowMessage[]) {
    try {
      const existing = await this.memory.getSummary(conversationId);
      const text = overflow.map((m) => `${m.role === 'user' ? '用户' : '助手'}：${m.content}`).join('\n');
      const summary = await this.llm.invoke(
        [
          new SystemMessage(
            '将以下对话片段压缩为不超过 200 字的滚动摘要，保留关键事实、结论与用户偏好。' +
              (existing ? `已有摘要：${existing}` : ''),
          ),
          new HumanMessage(text),
        ],
        { temperature: 0 },
      );
      await this.memory.updateSummary(conversationId, summary.trim());
    } catch {
      // 摘要压缩失败不影响主流程
    }
  }

  /**
   * 生成会话标题：短问题直接截取；长问题调用 LLM 总结（限时 5s），
   * LLM 失败或输出异常时降级为截取首问。
   */
  async generateTitle(query: string): Promise<string> {
    const fallback = query.length > 20 ? `${query.slice(0, 20)}…` : query;
    if (query.length <= 20) return query;
    try {
      const text = await this.llm.invoke(
        [
          new SystemMessage(
            '为用户的第一个问题生成一个简短的对话标题（不超过 15 个字），概括问题主题。' +
              '只输出标题本身：不要引号、不要书名号、不要标点结尾。',
          ),
          // 首问最长 4000 字，标题生成只需开头部分即可把握主题
          new HumanMessage(query.slice(0, 500)),
        ],
        { temperature: 0, timeout: 5_000 },
      );
      // 去掉模型偶尔带上的引号、书名号和句末标点
      const title = text.trim().replace(/^["'「『《]+|["'」』》.。…]+$/g, '').trim();
      if (!title || title.length > 30) return fallback;
      return title;
    } catch {
      return fallback;
    }
  }

  /** 当前用户的会话列表，按 updatedAt 倒序，带 has_more 供前端判断是否继续翻页 */
  async listConversations(userId: string, page = 1, pageSize = 20) {
    const [items, total] = await this.conversations.findAndCount({
      where: { userId },
      order: { updatedAt: 'DESC' },
      skip: (page - 1) * pageSize,
      take: pageSize,
    });
    return { total, page, page_size: pageSize, has_more: page * pageSize < total, items };
  }

  /**
   * 历史消息：assistant 消息关联 qa_records 带出图谱推理链路与复杂度，供前端回放。
   * 分页：page=1 返回最新一页（倒序取页后反转为时间正序），
   * page 递增返回更早的消息，前端滚动到顶部时向前翻页。
   */
  async listMessages(userId: string, conversationId: string, page = 1, pageSize = 50) {
    await this.assertOwner(userId, conversationId);
    // 先按创建时间倒序取一页，保证 page=1 是最新消息
    const [items, total] = await this.messages.findAndCount({
      where: { conversationId },
      order: { createdAt: 'DESC' },
      skip: (page - 1) * pageSize,
      take: pageSize,
    });
    // 页内再翻成时间正序，前端直接从上往下渲染
    items.reverse();

    // 只给助手消息补问答记录，用户消息没有 qa_record
    const assistantIds = items.filter((m) => m.role === MessageRole.ASSISTANT).map((m) => m.id);
    const records = assistantIds.length
      ? await this.qaRecords.find({ where: { messageId: In(assistantIds) } })
      : [];
    const recordMap = new Map(records.map((r) => [r.messageId, r]));

    const enriched = items.map((m) => {
      const record = recordMap.get(m.id);
      return {
        ...m,
        triples: record?.graphTriples ?? [],
        complexity: record?.complexity ?? null,
        intent: record?.intent ?? null,
        suggestedQuery: record?.suggestedQuery ?? undefined,
        thinking: record?.thinking ?? null,
        toolCalls: record?.toolTrace ?? [],
        // 步骤轨迹转成前端 ExecutionTrace 需要的形状：降级节点标 degraded
        steps: (record?.stepTrace ?? []).map((s) => ({
          name: s.name,
          status: s.degraded ? 'degraded' : 'done',
          startedAt: 0,
          latencyMs: s.latencyMs,
          detail:
            s.detail ??
            (s.iteration > 0 ? `第 ${s.iteration + 1} 轮` : undefined),
          output: s.output,
        })),
        nodeLatencies: record?.nodeLatencies ?? null,
        degradedNodes: record?.degradedNodes ?? [],
      };
    });
    return {
      total,
      page,
      page_size: pageSize,
      has_more: page * pageSize < total,
      items: enriched,
      active_run: await this.runs.getActiveRun(conversationId),
    };
  }

  /** 改标题前先确认会话属于当前用户 */
  async rename(userId: string, conversationId: string, title: string) {
    await this.assertOwner(userId, conversationId);
    await this.conversations.update(conversationId, { title });
    return { updated: true };
  }

  /** 删除会话；归属校验失败时抛 404 */
  async remove(userId: string, conversationId: string) {
    await this.assertOwner(userId, conversationId);
    await this.conversations.delete(conversationId);
    return { deleted: true };
  }

  /** 给一条消息记赞/踩，并把分数报到 Langfuse，关联当时的问答 trace */
  async feedback(userId: string, messageId: string, feedback: 1 | -1, comment?: string) {
    const msg = await this.messages.findOne({
      where: { id: messageId },
      relations: { conversation: true },
    });
    if (!msg || msg.conversation.userId !== userId) {
      throw new BizException(ErrorCode.NOT_FOUND, '消息不存在', 404);
    }
    await this.messages.update(messageId, { feedback, feedbackComment: comment ?? null });
    // 上报 LangFuse score（1=赞 0=踩），关联问答 trace 用于质量看板
    const record = await this.qaRecords.findOne({ where: { messageId } });
    this.langfuse.createScore(record?.langfuseTraceId, feedback === 1 ? 1 : 0, comment);
    return { updated: true };
  }

  /** 会话不存在或不属于该用户时统一返回 404，不区分两种情况 */
  async requireOwned(userId: string, conversationId: string) {
    await this.assertOwner(userId, conversationId);
  }

  /** 会话不存在或不属于该用户时统一返回 404，不区分两种情况 */
  private async assertOwner(userId: string, conversationId: string) {
    const conv = await this.conversations.findOne({ where: { id: conversationId } });
    if (!conv || conv.userId !== userId) {
      throw new BizException(ErrorCode.NOT_FOUND, '对话不存在', 404);
    }
  }
}
