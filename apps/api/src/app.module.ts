import { Module } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { APP_GUARD, APP_INTERCEPTOR } from '@nestjs/core';
import { TypeOrmModule } from '@nestjs/typeorm';
import { BullModule } from '@nestjs/bullmq';
import { ThrottlerModule, ThrottlerGuard } from '@nestjs/throttler';
import * as path from 'path';
import configuration from './config/configuration';
import { LoggingInterceptor } from './common/interceptors/logging.interceptor';
import { SecurityModule } from './modules/security/security.module';
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
import { TtsModule } from './modules/tts/tts.module';
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
    ThrottlerModule.forRootAsync({
      inject: [ConfigService],
      useFactory: (config: ConfigService) => [
        { ttl: 60_000, limit: config.get<number>('app.throttleLimit') ?? 120 },
      ],
    }),
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
    TtsModule,
    HealthModule,
    SecurityModule,
  ],
  providers: [
    DatabaseInitService,
    // 全局限流：默认 120 次/分/IP，登录等敏感接口另有 @Throttle 覆盖
    { provide: APP_GUARD, useClass: ThrottlerGuard },
    { provide: APP_INTERCEPTOR, useClass: LoggingInterceptor },
  ],
})
export class AppModule {}
