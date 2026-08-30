import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { DocumentEntity } from '../../database/entities/document.entity';
import { WorkspaceEntity } from '../../database/entities/workspace.entity';
import { AuthModule } from '../auth/auth.module';
import { WorkspacesModule } from '../workspaces/workspaces.module';
import { IngestionModule } from '../ingestion/ingestion.module';
import { DocumentsController } from './documents.controller';
import { DocumentsService } from './documents.service';
import { StorageService } from './storage.service';

@Module({
  imports: [
    TypeOrmModule.forFeature([DocumentEntity, WorkspaceEntity]),
    AuthModule,
    WorkspacesModule,
    IngestionModule,
  ],
  controllers: [DocumentsController],
  providers: [DocumentsService, StorageService],
  exports: [DocumentsService, StorageService],
})
export class DocumentsModule {}
