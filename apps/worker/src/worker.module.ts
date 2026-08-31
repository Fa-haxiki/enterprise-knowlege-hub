import { Module } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { TypeOrmModule } from '@nestjs/typeorm';
import { BullModule } from '@nestjs/bullmq';
import * as path from 'path';
import configuration from '@ekh/api/config/configuration';
import { RedisModule } from '@ekh/api/redis/redis.module';
import { LlmModule } from '@ekh/api/modules/llm/llm.module';
import { SecurityModule } from '@ekh/api/modules/security/security.module';
import { RetrievalModule } from '@ekh/api/modules/retrieval/retrieval.module';
import { GraphModule } from '@ekh/api/modules/graph/graph.module';
import { StorageService } from '@ekh/api/modules/documents/storage.service';
import { DocumentEntity } from '@ekh/api/database/entities/document.entity';
import { DocumentChunkEntity } from '@ekh/api/database/entities/document-chunk.entity';
import { IngestionJobEntity } from '@ekh/api/database/entities/ingestion-job.entity';
import { WorkspaceEntity } from '@ekh/api/database/entities/workspace.entity';
import { UserEntity } from '@ekh/api/database/entities/user.entity';
import { DepartmentEntity } from '@ekh/api/database/entities/department.entity';
import { IngestionProcessor } from './processors/ingestion.processor';
import { MineruClient } from './pipelines/mineru.client';
import { Chunker } from './pipelines/chunker';
import { EntityExtractor } from './pipelines/entity-extractor';

@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
      load: [configuration],
      envFilePath: [path.resolve(process.cwd(), '../../.env'), path.resolve(process.cwd(), '.env')],
    }),
    TypeOrmModule.forRootAsync({
      inject: [ConfigService],
      useFactory: (config: ConfigService) => ({
        type: 'postgres' as const,
        url: config.get<string>('database.url'),
        // DocumentEntity 关联了 Workspace/User，元数据构建需要完整实体图
        entities: [DocumentEntity, DocumentChunkEntity, IngestionJobEntity, WorkspaceEntity, UserEntity, DepartmentEntity],
        autoLoadEntities: false,
        synchronize: false,
      }),
    }),
    TypeOrmModule.forFeature([DocumentEntity, DocumentChunkEntity, IngestionJobEntity]),
    BullModule.forRootAsync({
      inject: [ConfigService],
      useFactory: (config: ConfigService) => ({
        connection: {
          host: config.get<string>('redis.host'),
          port: config.get<number>('redis.port'),
          password: config.get<string>('redis.password'),
        },
      }),
    }),
    BullModule.registerQueue({ name: 'ingestion' }),
    RedisModule,
    LlmModule,
    SecurityModule,
    RetrievalModule,
    GraphModule,
  ],
  providers: [IngestionProcessor, MineruClient, Chunker, EntityExtractor, StorageService],
})
export class WorkerModule {}
