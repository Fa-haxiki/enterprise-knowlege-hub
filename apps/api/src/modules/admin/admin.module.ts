import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { UserEntity } from '../../database/entities/user.entity';
import { DepartmentEntity } from '../../database/entities/department.entity';
import { DepartmentAdminEntity } from '../../database/entities/department-admin.entity';
import { DepartmentMemberEntity } from '../../database/entities/department-member.entity';
import { AuditModule } from '../audit/audit.module';
import { AuthModule } from '../auth/auth.module';
import { WorkspacesModule } from '../workspaces/workspaces.module';
import { AdminController } from './admin.controller';
import { AdminService } from './admin.service';

@Module({
  imports: [
    TypeOrmModule.forFeature([UserEntity, DepartmentEntity, DepartmentAdminEntity, DepartmentMemberEntity]),
    AuditModule,
    AuthModule,
    WorkspacesModule,
  ],
  controllers: [AdminController],
  providers: [AdminService],
})
export class AdminModule {}
