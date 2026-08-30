import {
  Column,
  CreateDateColumn,
  Entity,
  JoinColumn,
  ManyToOne,
  PrimaryColumn,
} from 'typeorm';
import { DepartmentEntity } from './department.entity';
import { UserEntity } from './user.entity';

/** 部门成员：用户与部门的从属关系，由部门管理员或系统管理员维护 */
@Entity('department_members')
export class DepartmentMemberEntity {
  @PrimaryColumn({ name: 'department_id' })
  departmentId: string;

  @PrimaryColumn({ name: 'user_id' })
  userId: string;

  @ManyToOne(() => DepartmentEntity, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'department_id' })
  department: DepartmentEntity;

  @ManyToOne(() => UserEntity, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'user_id' })
  user: UserEntity;

  @Column({ name: 'added_by', type: 'uuid', nullable: true })
  addedBy: string | null;

  @CreateDateColumn({ name: 'added_at' })
  addedAt: Date;
}
