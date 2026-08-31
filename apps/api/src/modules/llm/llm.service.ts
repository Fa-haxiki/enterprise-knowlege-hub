import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { ChatOpenAI } from '@langchain/openai';
import type { BaseMessage } from '@langchain/core/messages';
import { MaskService } from '../security/mask.service';

export interface ChatUsage {
  prompt_tokens: number;
  completion_tokens: number;
}

/**
 * LLM 统一客户端：OpenAI 兼容协议，可接 DeepSeek / 通义 / OpenAI / Ollama。
 * 所有模型调用经此出口，便于熔断、脱敏与 LangFuse 追踪。
 */
@Injectable()
export class LlmService {
  private readonly logger = new Logger(LlmService.name);

  constructor(
    private readonly config: ConfigService,
    private readonly mask: MaskService,
  ) {}

  /** 出站脱敏：替换高敏信息（身份证/银行卡/手机号/邮箱），不改动原消息对象 */
  private maskMessages(messages: BaseMessage[]): BaseMessage[] {
    if (!this.config.get<boolean>('security.llmMaskEnabled')) return messages;
    return messages.map((m) => {
      if (typeof m.content !== 'string') return m;
      const masked = this.mask.maskText(m.content);
      if (masked === m.content) return m;
      return Object.assign(Object.create(Object.getPrototypeOf(m)), m, { content: masked });
    });
  }

  createChatModel(options?: { model?: string; temperature?: number; streaming?: boolean; timeout?: number }) {
    return new ChatOpenAI({
      model: options?.model ?? this.config.get<string>('llm.model') ?? 'deepseek-chat',
      temperature: options?.temperature ?? 0.1,
      streaming: options?.streaming ?? false,
      apiKey: this.config.get<string>('llm.apiKey'),
      configuration: { baseURL: this.config.get<string>('llm.baseURL') },
      maxRetries: 2,
      timeout: options?.timeout ?? 60_000,
    });
  }

  /** 非流式调用：用于路由分类、实体抽取、查询改写等内部环节 */
  async invoke(
    messages: BaseMessage[],
    options?: { model?: string; temperature?: number; timeout?: number },
  ): Promise<string> {
    const { text } = await this.invokeWithUsage(messages, options);
    return text;
  }

  /** 非流式调用（含 token 用量）：供 LangFuse generation 埋点使用 */
  async invokeWithUsage(
    messages: BaseMessage[],
    options?: { model?: string; temperature?: number; timeout?: number },
  ): Promise<{ text: string; usage: ChatUsage }> {
    const model = this.createChatModel(options);
    const res = await model.invoke(this.maskMessages(messages));
    const text = typeof res.content === 'string' ? res.content : JSON.stringify(res.content);
    const u = res.usage_metadata;
    return {
      text,
      usage: { prompt_tokens: u?.input_tokens ?? 0, completion_tokens: u?.output_tokens ?? 0 },
    };
  }

  /**
   * 流式调用：返回 token 迭代器与共享 usage 对象。
   * usage 在迭代过程中被填充，迭代结束后读取即为最终值。
   */
  streamChat(messages: BaseMessage[], options?: { model?: string }) {
    const usage: ChatUsage = { prompt_tokens: 0, completion_tokens: 0 };
    const model = this.createChatModel({ ...options, streaming: true });
    const maskedMessages = this.maskMessages(messages);

    const iterator = (async function* () {
      const stream = await model.stream(maskedMessages);
      for await (const chunk of stream) {
        const delta = typeof chunk.content === 'string' ? chunk.content : '';
        if (delta) yield delta;
        const u = chunk.usage_metadata;
        if (u) {
          usage.prompt_tokens = u.input_tokens ?? usage.prompt_tokens;
          usage.completion_tokens = u.output_tokens ?? usage.completion_tokens;
        }
      }
    })();

    return { iterator, usage };
  }
}
