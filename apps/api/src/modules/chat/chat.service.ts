import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { In, Repository } from 'typeorm';
import { Complexity, ErrorCode, MessageRole, type Citation, type GraphSubgraph, type Triple } from '@ekh/shared';
import { HumanMessage, SystemMessage } from '@langchain/core/messages';
import { ConversationEntity } from '../../database/entities/conversation.entity';
import { MessageEntity } from '../../database/entities/message.entity';
import { QaRecordEntity } from '../../database/entities/qa-record.entity';
import { BizException } from '../../common/filters/http-exception.filter';
import { MemoryService, type WindowMessage } from '../memory/memory.service';
import { LlmService } from '../llm/llm.service';
import { LangfuseService } from '../observability/langfuse.service';
import { FeatureFlagsService } from '../features/feature-flags.service';

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
    private readonly features: FeatureFlagsService,
  ) {}

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
      const created = await this.conversations.save(
        this.conversations.create({ id: threadId, userId, workspaceId: workspaceId ?? null }),
      );
      return { conv: created, created: true };
    }
    const created = await this.conversations.save(
      this.conversations.create({ userId, workspaceId: workspaceId ?? null }),
    );
    return { conv: created, created: true };
  }

  async saveUserMessage(conversationId: string, content: string) {
    return this.messages.save(
      this.messages.create({ conversationId, role: MessageRole.USER, content }),
    );
  }

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

  async saveQaRecord(
    messageId: string,
    data: {
      complexity: Complexity | null;
      recalledChunkIds: string[];
      graphTriples: Triple[];
      graphSubgraph?: GraphSubgraph | null;
      nodeLatencies: Record<string, number>;
      degradedNodes: string[];
      langfuseTraceId?: string;
    },
  ) {
    await this.qaRecords.save(
      this.qaRecords.create({
        messageId,
        complexity: data.complexity,
        recalledChunkIds: data.recalledChunkIds,
        graphTriples: data.graphTriples,
        graphSubgraph: data.graphSubgraph ?? null,
        nodeLatencies: data.nodeLatencies,
        degradedNodes: data.degradedNodes,
        langfuseTraceId: data.langfuseTraceId ?? null,
      }),
    );
  }

  /** 更新短期窗口；溢出部分异步压缩进滚动摘要 */
  async updateMemory(conversationId: string, userId: string, round: WindowMessage[]) {
    const overflow = await this.memory.appendWindow(conversationId, round);
    if (overflow.length > 0) {
      void this.compressOverflow(conversationId, overflow);
    }
    this.memory.addLongTerm(userId, conversationId, round);
  }

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
      const title = text.trim().replace(/^["'「『《]+|["'」』》.。…]+$/g, '').trim();
      if (!title || title.length > 30) return fallback;
      return title;
    } catch {
      return fallback;
    }
  }

  async listConversations(userId: string, page = 1, pageSize = 20) {
    const [items, total] = await this.conversations.findAndCount({
      where: { userId },
      order: { updatedAt: 'DESC' },
      skip: (page - 1) * pageSize,
      take: pageSize,
    });
    return { total, page, page_size: pageSize, has_more: page * pageSize < total, items };
  }

  /** 历史消息：assistant 消息关联 qa_records 带出图谱推理链路与复杂度，供前端回放 */
  /**
   * 消息分页：page=1 返回最新一页（倒序取页后反转为时间正序），
   * page 递增返回更早的消息，前端滚动到顶部时向前翻页。
   */
  async listMessages(userId: string, conversationId: string, page = 1, pageSize = 50) {
    await this.assertOwner(userId, conversationId);
    const [items, total] = await this.messages.findAndCount({
      where: { conversationId },
      order: { createdAt: 'DESC' },
      skip: (page - 1) * pageSize,
      take: pageSize,
    });
    items.reverse();

    const assistantIds = items.filter((m) => m.role === MessageRole.ASSISTANT).map((m) => m.id);
    const records = assistantIds.length
      ? await this.qaRecords.find({ where: { messageId: In(assistantIds) } })
      : [];
    const recordMap = new Map(records.map((r) => [r.messageId, r]));
    // 图谱推理下架期间历史消息也不带推理链路，聊天面板自然不出现
    const graphEnabled = await this.features.isEnabled('graph_reasoning');

    const enriched = items.map((m) => {
      const record = recordMap.get(m.id);
      return {
        ...m,
        triples: graphEnabled ? (record?.graphTriples ?? []) : [],
        graph_subgraph: graphEnabled ? (record?.graphSubgraph ?? null) : null,
        complexity: record?.complexity ?? null,
        nodeLatencies: record?.nodeLatencies ?? null,
        degradedNodes: record?.degradedNodes ?? [],
      };
    });
    return { total, page, page_size: pageSize, has_more: page * pageSize < total, items: enriched };
  }

  async rename(userId: string, conversationId: string, title: string) {
    await this.assertOwner(userId, conversationId);
    await this.conversations.update(conversationId, { title });
    return { updated: true };
  }

  async remove(userId: string, conversationId: string) {
    await this.assertOwner(userId, conversationId);
    await this.conversations.delete(conversationId);
    return { deleted: true };
  }

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

  private async assertOwner(userId: string, conversationId: string) {
    const conv = await this.conversations.findOne({ where: { id: conversationId } });
    if (!conv || conv.userId !== userId) {
      throw new BizException(ErrorCode.NOT_FOUND, '对话不存在', 404);
    }
  }
}
