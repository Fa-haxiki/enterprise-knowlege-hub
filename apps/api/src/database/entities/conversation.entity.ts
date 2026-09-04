import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  JoinColumn,
  ManyToOne,
  PrimaryGeneratedColumn,
  UpdateDateColumn,
} from 'typeorm';
import { UserEntity } from './user.entity';
import { WorkspaceEntity } from './workspace.entity';

@Entity('conversations')
@Index(['userId', 'updatedAt'])
export class ConversationEntity {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ name: 'user_id' })
  userId: string;

  @ManyToOne(() => UserEntity, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'user_id' })
  user: UserEntity;

  /** 问答作用域：限定检索空间，null 表示全部有权限空间 */
  @Column({ name: 'workspace_id', type: 'uuid', nullable: true })
  workspaceId: string | null;

  @ManyToOne(() => WorkspaceEntity, { onDelete: 'SET NULL', nullable: true })
  @JoinColumn({ name: 'workspace_id' })
  workspace: WorkspaceEntity | null;

  @Column({ default: '新对话' })
  title: string;

  @CreateDateColumn({ name: 'created_at', type: 'timestamptz' })
  createdAt: Date;

  @UpdateDateColumn({ name: 'updated_at', type: 'timestamptz' })
  updatedAt: Date;
}
