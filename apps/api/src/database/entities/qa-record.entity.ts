import {
  Column,
  CreateDateColumn,
  Entity,
  JoinColumn,
  ManyToOne,
  PrimaryGeneratedColumn,
} from 'typeorm';
import { AgentIntent, Complexity, type NodeLatency, type ToolTrace, type Triple } from '@ekh/shared';
import { MessageEntity } from './message.entity';

/** 问答观测快照：召回分片、图谱链路、各节点耗时 */
@Entity('qa_records')
export class QaRecordEntity {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ name: 'message_id' })
  messageId: string;

  @ManyToOne(() => MessageEntity, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'message_id' })
  message: MessageEntity;

  @Column({ type: 'varchar', length: 16, nullable: true })
  complexity: Complexity | null;

  @Column({ type: 'varchar', length: 32, nullable: true })
  intent: AgentIntent | null;

  @Column({ type: 'int', default: 0 })
  iterations: number;

  @Column({ name: 'tool_trace', type: 'jsonb', default: [] })
  toolTrace: ToolTrace[];

  @Column({ name: 'step_trace', type: 'jsonb', default: [] })
  stepTrace: NodeLatency[];

  @Column({ name: 'suggested_query', type: 'text', nullable: true })
  suggestedQuery: string | null;

  @Column({ type: 'text', nullable: true })
  thinking: string | null;

  @Column({ name: 'recalled_chunk_ids', type: 'jsonb', default: [] })
  recalledChunkIds: string[];

  @Column({ name: 'graph_triples', type: 'jsonb', default: [] })
  graphTriples: Triple[];

  @Column({ name: 'node_latencies', type: 'jsonb', default: {} })
  nodeLatencies: Record<string, number>;

  @Column({ name: 'degraded_nodes', type: 'jsonb', default: [] })
  degradedNodes: string[];

  @Column({ name: 'langfuse_trace_id', type: 'varchar', length: 64, nullable: true })
  langfuseTraceId: string | null;

  @CreateDateColumn({ name: 'created_at', type: 'timestamptz' })
  createdAt: Date;
}
