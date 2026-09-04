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
import { IngestionStage, JobStatus } from '@ekh/shared';
import { DocumentEntity } from './document.entity';

@Entity('ingestion_jobs')
@Index(['documentId', 'stage'])
export class IngestionJobEntity {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ name: 'document_id' })
  documentId: string;

  @ManyToOne(() => DocumentEntity, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'document_id' })
  document: DocumentEntity;

  @Column({ type: 'varchar', length: 16 })
  stage: IngestionStage;

  @Column({ type: 'varchar', length: 16, default: JobStatus.PENDING })
  status: JobStatus;

  @Column({ name: 'retry_count', type: 'int', default: 0 })
  retryCount: number;

  @Column({ name: 'error_msg', type: 'text', nullable: true })
  errorMsg: string | null;

  @CreateDateColumn({ name: 'created_at', type: 'timestamptz' })
  createdAt: Date;

  @UpdateDateColumn({ name: 'updated_at', type: 'timestamptz' })
  updatedAt: Date;
}
