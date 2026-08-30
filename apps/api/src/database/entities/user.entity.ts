import {
  Column,
  CreateDateColumn,
  Entity,
  PrimaryGeneratedColumn,
  UpdateDateColumn,
} from 'typeorm';
import { SystemRole, UserStatus } from '@ekh/shared';

@Entity('users')
export class UserEntity {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ unique: true })
  email: string;

  @Column({ name: 'password_hash' })
  passwordHash: string;

  @Column()
  name: string;

  @Column({ type: 'varchar', length: 16, default: SystemRole.MEMBER })
  role: SystemRole;

  /** 注册审核状态：PENDING 不可登录，ACTIVE 正常，REJECTED 审核未通过 */
  @Column({ type: 'varchar', length: 16, default: UserStatus.PENDING })
  status: UserStatus;

  /** 注册审核拒绝理由 */
  @Column({ name: 'review_note', type: 'text', nullable: true })
  reviewNote: string | null;

  @Column({ type: 'jsonb', default: {} })
  profile: Record<string, unknown>;

  @Column({ name: 'disabled_at', type: 'timestamptz', nullable: true })
  disabledAt: Date | null;

  @CreateDateColumn({ name: 'created_at' })
  createdAt: Date;

  @UpdateDateColumn({ name: 'updated_at' })
  updatedAt: Date;
}
