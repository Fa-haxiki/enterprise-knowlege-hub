import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  JoinColumn,
  ManyToOne,
  PrimaryGeneratedColumn,
} from 'typeorm';
import { DepartmentEntity } from './department.entity';
import { UserEntity } from './user.entity';

@Entity('workspaces')
export class WorkspaceEntity {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column()
  name: string;

  @Column({ type: 'text', nullable: true })
  description: string | null;

  /** 所属部门：决定文档由哪个部门的审核员审核；null 时由 sysadmin 兜底审核 */
  @Column({ name: 'department_id', type: 'uuid', nullable: true })
  departmentId: string | null;

  @ManyToOne(() => DepartmentEntity, { onDelete: 'SET NULL', nullable: true })
  @JoinColumn({ name: 'department_id' })
  department: DepartmentEntity | null;

  @Column({ name: 'owner_id' })
  @Index()
  ownerId: string;

  @ManyToOne(() => UserEntity, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'owner_id' })
  owner: UserEntity;

  @Column({ type: 'varchar', length: 16, default: 'private' })
  visibility: 'private';

  @CreateDateColumn({ name: 'created_at' })
  createdAt: Date;
}
