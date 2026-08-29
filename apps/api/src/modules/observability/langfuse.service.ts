import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Langfuse } from 'langfuse';

export type TraceHandle = ReturnType<Langfuse['trace']>;
export type SpanHandle = ReturnType<TraceHandle['span']>;
export type GenerationHandle = ReturnType<TraceHandle['generation']>;

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

  createTrace(name: string, metadata: Record<string, unknown>): TraceHandle | null {
    if (!this.client) return null;
    return this.client.trace({ name, metadata });
  }

  /** 节点级 span；trace 为 null 时返回 null，调用方需空安全 */
  createSpan(
    trace: TraceHandle | null,
    name: string,
    input: Record<string, unknown>,
  ): SpanHandle | null {
    if (!trace) return null;
    try {
      return trace.span({ name, input });
    } catch (e) {
      this.logger.warn(`span create failed: ${(e as Error).message}`);
      return null;
    }
  }

  endSpan(span: SpanHandle | null, output: Record<string, unknown>, error?: Error) {
    if (!span) return;
    try {
      span.end(
        error
          ? { level: 'ERROR', statusMessage: error.message }
          : { output },
      );
    } catch (e) {
      this.logger.warn(`span end failed: ${(e as Error).message}`);
    }
  }

  /** LLM 生成埋点：记录模型与 token 消耗 */
  createGeneration(
    trace: TraceHandle | null,
    args: { name: string; model: string; input: unknown },
  ): GenerationHandle | null {
    if (!trace) return null;
    try {
      return trace.generation({ name: args.name, model: args.model, input: args.input });
    } catch (e) {
      this.logger.warn(`generation create failed: ${(e as Error).message}`);
      return null;
    }
  }

  endGeneration(
    generation: GenerationHandle | null,
    args: { output: string; usage: { prompt_tokens: number; completion_tokens: number } },
  ) {
    if (!generation) return;
    try {
      generation.end({
        output: args.output,
        usageDetails: {
          input: args.usage.prompt_tokens,
          output: args.usage.completion_tokens,
          total: args.usage.prompt_tokens + args.usage.completion_tokens,
        },
      });
    } catch (e) {
      this.logger.warn(`generation end failed: ${(e as Error).message}`);
    }
  }

  async shutdown() {
    await this.client?.shutdownAsync().catch((e) => this.logger.warn(e.message));
  }
}
