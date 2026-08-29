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
import { DocumentStatus } from '@ekh/shared';
import { WorkspaceEntity } from './workspace.entity';
import { UserEntity } from './user.entity';

@Entity('documents')
@Index(['workspaceId', 'status'])
export class DocumentEntity {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ name: 'workspace_id' })
  workspaceId: string;

  @ManyToOne(() => WorkspaceEntity, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'workspace_id' })
  workspace: WorkspaceEntity;

  @Column()
  title: string;

  @Column({ name: 'file_key' })
  fileKey: string;

  @Column({ name: 'mime_type' })
  mimeType: string;

  @Column({ name: 'file_size', type: 'bigint' })
  fileSize: number;

  @Column({ type: 'varchar', length: 16, default: DocumentStatus.UPLOADED })
  status: DocumentStatus;

  @Column({ name: 'error_msg', type: 'text', nullable: true })
  errorMsg: string | null;

  @Column({ type: 'jsonb', default: {} })
  meta: Record<string, unknown>;

  @Column({ name: 'uploader_id' })
  uploaderId: string;

  @ManyToOne(() => UserEntity)
  @JoinColumn({ name: 'uploader_id' })
  uploader: UserEntity;

  @Column({ name: 'deleted_at', type: 'timestamptz', nullable: true })
  deletedAt: Date | null;

  @CreateDateColumn({ name: 'created_at' })
  createdAt: Date;

  @UpdateDateColumn({ name: 'updated_at' })
  updatedAt: Date;
}
