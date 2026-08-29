import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { In, Repository } from 'typeorm';
import { Complexity, ErrorCode, MessageRole, type Citation, type Triple } from '@ekh/shared';
import { HumanMessage, SystemMessage } from '@langchain/core/messages';
import { ConversationEntity } from '../../database/entities/conversation.entity';
import { MessageEntity } from '../../database/entities/message.entity';
import { QaRecordEntity } from '../../database/entities/qa-record.entity';
import { BizException } from '../../common/filters/http-exception.filter';
import { MemoryService, type WindowMessage } from '../memory/memory.service';
import { LlmService } from '../llm/llm.service';

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

  async listConversations(userId: string, page = 1, pageSize = 20) {
    const [items, total] = await this.conversations.findAndCount({
      where: { userId },
      order: { updatedAt: 'DESC' },
      skip: (page - 1) * pageSize,
      take: pageSize,
    });
    return { total, page, page_size: pageSize, items };
  }

  /** 历史消息：assistant 消息关联 qa_records 带出图谱推理链路与复杂度，供前端回放 */
  async listMessages(userId: string, conversationId: string, page = 1, pageSize = 50) {
    await this.assertOwner(userId, conversationId);
    const [items, total] = await this.messages.findAndCount({
      where: { conversationId },
      order: { createdAt: 'ASC' },
      skip: (page - 1) * pageSize,
      take: pageSize,
    });

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
      };
    });
    return { total, page, page_size: pageSize, items: enriched };
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
    return { updated: true };
  }

  private async assertOwner(userId: string, conversationId: string) {
    const conv = await this.conversations.findOne({ where: { id: conversationId } });
    if (!conv || conv.userId !== userId) {
      throw new BizException(ErrorCode.NOT_FOUND, '对话不存在', 404);
    }
  }
}
