import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  PrimaryGeneratedColumn,
} from 'typeorm';

@Entity('audit_logs')
@Index(['createdAt'])
export class AuditLogEntity {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ name: 'user_id', type: 'uuid', nullable: true })
  userId: string | null;

  /** login / upload / chat / grant / revoke / acl_stripped ... */
  @Column()
  action: string;

  @Column({ name: 'resource_type', type: 'varchar', length: 32, nullable: true })
  resourceType: string | null;

  @Column({ name: 'resource_id', type: 'uuid', nullable: true })
  resourceId: string | null;

  @Column({ type: 'jsonb', default: {} })
  detail: Record<string, unknown>;

  @Column({ type: 'inet', nullable: true })
  ip: string | null;

  @CreateDateColumn({ name: 'created_at', type: 'timestamptz' })
  createdAt: Date;
}
