import { Module } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { TypeOrmModule } from '@nestjs/typeorm';
import { BullModule } from '@nestjs/bullmq';
import { ThrottlerModule } from '@nestjs/throttler';
import * as path from 'path';
import configuration from './config/configuration';
import { AuthModule } from './modules/auth/auth.module';
import { UsersModule } from './modules/users/users.module';
import { WorkspacesModule } from './modules/workspaces/workspaces.module';
import { DocumentsModule } from './modules/documents/documents.module';
import { IngestionModule } from './modules/ingestion/ingestion.module';
import { RetrievalModule } from './modules/retrieval/retrieval.module';
import { MemoryModule } from './modules/memory/memory.module';
import { AgentsModule } from './modules/agents/agents.module';
import { ChatModule } from './modules/chat/chat.module';
import { LlmModule } from './modules/llm/llm.module';
import { ObservabilityModule } from './modules/observability/observability.module';
import { AuditModule } from './modules/audit/audit.module';
import { HealthModule } from './modules/health/health.module';
import { RedisModule } from './redis/redis.module';
import { DatabaseInitService } from './database/database-init.service';
import { DocumentChunkEntity } from './database/entities/document-chunk.entity';
import { IngestionJobEntity } from './database/entities/ingestion-job.entity';

@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
      load: [configuration],
      // monorepo：.env 位于仓库根目录
      envFilePath: [path.resolve(process.cwd(), '../../.env'), path.resolve(process.cwd(), '.env')],
    }),
    TypeOrmModule.forRootAsync({
      inject: [ConfigService],
      useFactory: (config: ConfigService) => ({
        type: 'postgres' as const,
        url: config.get<string>('database.url'),
        // autoLoadEntities 仅覆盖 forFeature 注册的实体；
        // 以下实体仅被原生 SQL / Worker 使用，需显式登记以建表
        entities: [DocumentChunkEntity, IngestionJobEntity],
        autoLoadEntities: true,
        synchronize: config.get<string>('app.nodeEnv') !== 'production',
        logging: false,
      }),
    }),
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
    ThrottlerModule.forRoot([{ ttl: 60_000, limit: 120 }]),
    RedisModule,
    AuthModule,
    UsersModule,
    WorkspacesModule,
    DocumentsModule,
    IngestionModule,
    RetrievalModule,
    MemoryModule,
    AgentsModule,
    ChatModule,
    LlmModule,
    ObservabilityModule,
    AuditModule,
    HealthModule,
  ],
  providers: [DatabaseInitService],
})
export class AppModule {}
