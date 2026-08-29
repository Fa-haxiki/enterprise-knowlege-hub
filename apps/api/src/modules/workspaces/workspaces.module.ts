import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { WorkspaceEntity } from '../../database/entities/workspace.entity';
import { WorkspaceMemberEntity } from '../../database/entities/workspace-member.entity';
import { AuthModule } from '../auth/auth.module';
import { AclService } from './acl.service';
import { AclGuard } from './guards/acl.guard';
import { WorkspacesController } from './workspaces.controller';
import { WorkspacesService } from './workspaces.service';

@Module({
  imports: [TypeOrmModule.forFeature([WorkspaceEntity, WorkspaceMemberEntity]), AuthModule],
  controllers: [WorkspacesController],
  providers: [WorkspacesService, AclService, AclGuard],
  exports: [AclService, AclGuard],
})
export class WorkspacesModule {}
