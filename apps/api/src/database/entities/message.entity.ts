import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  JoinColumn,
  ManyToOne,
  PrimaryGeneratedColumn,
} from 'typeorm';
import { MessageRole, type Citation } from '@ekh/shared';
import { ConversationEntity } from './conversation.entity';

@Entity('messages')
@Index(['conversationId', 'createdAt'])
export class MessageEntity {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ name: 'conversation_id' })
  conversationId: string;

  @ManyToOne(() => ConversationEntity, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'conversation_id' })
  conversation: ConversationEntity;

  @Column({ type: 'varchar', length: 16 })
  role: MessageRole;

  @Column({ type: 'text' })
  content: string;

  @Column({ type: 'jsonb', default: [] })
  citations: Citation[];

  @Column({ type: 'jsonb', default: {} })
  usage: { prompt_tokens?: number; completion_tokens?: number };

  @Column({ name: 'latency_ms', type: 'int', nullable: true })
  latencyMs: number | null;

  /** 1 赞 / -1 踩 / 0 未反馈 */
  @Column({ type: 'smallint', default: 0 })
  feedback: number;

  @Column({ name: 'feedback_comment', type: 'text', nullable: true })
  feedbackComment: string | null;

  @CreateDateColumn({ name: 'created_at' })
  createdAt: Date;
}
