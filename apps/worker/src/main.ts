import { NestFactory } from '@nestjs/core';
import { Logger } from '@nestjs/common';
import { WorkerModule } from './worker.module';
import { IngestionProcessor } from './processors/ingestion.processor';

async function bootstrap() {
  const app = await NestFactory.createApplicationContext(WorkerModule);
  const logger = new Logger('Worker');

  // 不用 enableShutdownHooks()：Nest 的 onModuleDestroy 会先断 Redis / Neo4j，而 BullMQ WorkerHost
  // 要到 onApplicationShutdown 才开始等在途任务跑完，结果任务在对齐/落图阶段报 Connection is closed。
  // 这里先手动 drain（停止取新任务并等 active 任务结束），再关容器释放连接。
  const processor = app.get(IngestionProcessor);
  let shuttingDown = false;
  const shutdown = async (signal: NodeJS.Signals) => {
    if (shuttingDown) return;
    shuttingDown = true;
    logger.log(`${signal} received, draining active jobs before shutdown...`);
    try {
      await processor.worker.close();
      await app.close();
      logger.log('worker stopped');
      process.exit(0);
    } catch (e) {
      logger.error(`shutdown failed: ${(e as Error).message}`);
      process.exit(1);
    }
  };
  process.once('SIGTERM', () => void shutdown('SIGTERM'));
  process.once('SIGINT', () => void shutdown('SIGINT'));

  logger.log('ingestion worker started');
}

bootstrap();
