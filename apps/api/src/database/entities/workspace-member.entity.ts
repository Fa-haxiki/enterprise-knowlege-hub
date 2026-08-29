import {
  Column,
  CreateDateColumn,
  Entity,
  JoinColumn,
  ManyToOne,
  PrimaryColumn,
} from 'typeorm';
import { WorkspaceRole } from '@ekh/shared';
import { WorkspaceEntity } from './workspace.entity';
import { UserEntity } from './user.entity';

@Entity('workspace_members')
export class WorkspaceMemberEntity {
  @PrimaryColumn({ name: 'workspace_id' })
  workspaceId: string;

  @PrimaryColumn({ name: 'user_id' })
  userId: string;

  @ManyToOne(() => WorkspaceEntity, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'workspace_id' })
  workspace: WorkspaceEntity;

  @ManyToOne(() => UserEntity, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'user_id' })
  user: UserEntity;

  @Column({ type: 'varchar', length: 16 })
  role: WorkspaceRole;

  @CreateDateColumn({ name: 'granted_at' })
  grantedAt: Date;
}
