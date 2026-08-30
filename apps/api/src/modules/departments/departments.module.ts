import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { UserEntity } from '../../database/entities/user.entity';
import { DepartmentEntity } from '../../database/entities/department.entity';
import { DepartmentMemberEntity } from '../../database/entities/department-member.entity';
import { AuditModule } from '../audit/audit.module';
import { AuthModule } from '../auth/auth.module';
import { WorkspacesModule } from '../workspaces/workspaces.module';
import { DepartmentsController } from './departments.controller';
import { DepartmentsService } from './departments.service';

@Module({
  imports: [
    TypeOrmModule.forFeature([DepartmentEntity, DepartmentMemberEntity, UserEntity]),
    AuditModule,
    AuthModule,
    WorkspacesModule,
  ],
  controllers: [DepartmentsController],
  providers: [DepartmentsService],
})
export class DepartmentsModule {}
