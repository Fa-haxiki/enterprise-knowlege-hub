import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Langfuse } from 'langfuse';

/**
 * LangFuse 封装：LANGFUSE_ENABLED=false 时全部操作为空实现，
 * 保证本地开发无 LangFuse 依赖。
 */
@Injectable()
export class LangfuseService {
  private readonly logger = new Logger(LangfuseService.name);
  private client: Langfuse | null = null;

  constructor(private readonly config: ConfigService) {
    if (this.config.get<boolean>('langfuse.enabled')) {
      this.client = new Langfuse({
        baseUrl: this.config.get<string>('langfuse.host'),
        publicKey: this.config.get<string>('langfuse.publicKey'),
        secretKey: this.config.get<string>('langfuse.secretKey'),
        flushAt: 10,
        flushInterval: 5_000,
      });
    }
  }

  get enabled(): boolean {
    return this.client !== null;
  }

  createTrace(name: string, metadata: Record<string, unknown>) {
    if (!this.client) return null;
    return this.client.trace({ name, metadata });
  }

  async shutdown() {
    await this.client?.shutdownAsync().catch((e) => this.logger.warn(e.message));
  }
}
