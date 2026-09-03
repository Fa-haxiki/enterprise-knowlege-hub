import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { ChatOpenAI } from '@langchain/openai';
import type { BaseMessage } from '@langchain/core/messages';
import { MaskService } from '../security/mask.service';

export interface ChatUsage {
  prompt_tokens: number;
  completion_tokens: number;
}

/** 单次调用可覆盖的模型参数：baseURL/apiKey 允许把某类任务路由到另一家模型服务 */
export interface LlmCallOptions {
  model?: string;
  temperature?: number;
  timeout?: number;
  baseURL?: string;
  apiKey?: string;
  /** json_object：要求服务端强制输出合法 JSON（OpenAI 兼容 response_format） */
  responseFormat?: 'json_object' | 'text';
  /** 透传给服务端的额外请求体字段（如千问 enable_thinking） */
  extraBody?: Record<string, unknown>;
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

  createChatModel(options?: LlmCallOptions & { streaming?: boolean }) {
    const modelKwargs: Record<string, unknown> = { ...options?.extraBody };
    if (options?.responseFormat === 'json_object') {
      modelKwargs.response_format = { type: 'json_object' };
    }
    return new ChatOpenAI({
      model: options?.model ?? this.config.get<string>('llm.model') ?? 'deepseek-chat',
      temperature: options?.temperature ?? 0.1,
      streaming: options?.streaming ?? false,
      apiKey: options?.apiKey ?? this.config.get<string>('llm.apiKey'),
      configuration: { baseURL: options?.baseURL ?? this.config.get<string>('llm.baseURL') },
      maxRetries: 2,
      timeout: options?.timeout ?? 60_000,
      ...(Object.keys(modelKwargs).length > 0 ? { modelKwargs } : {}),
    });
  }

  /**
   * 内部轻量任务档位（复杂度路由、实体抽取）：走 LLM_ROUTER_MODEL。
   * 千问 Qwen3 系列非流式调用必须关 thinking，否则服务端直接报错。
   */
  routerProfile(): Pick<LlmCallOptions, 'model' | 'extraBody'> {
    const model = this.config.get<string>('llm.routerModel') ?? this.config.get<string>('llm.model');
    return {
      model,
      extraBody: model?.startsWith('qwen') ? { enable_thinking: false } : undefined,
    };
  }

  /** 非流式调用：用于路由分类、实体抽取、查询改写等内部环节 */
  async invoke(messages: BaseMessage[], options?: LlmCallOptions): Promise<string> {
    const { text } = await this.invokeWithUsage(messages, options);
    return text;
  }

  /** 非流式调用（含 token 用量）：供 LangFuse generation 埋点使用 */
  async invokeWithUsage(
    messages: BaseMessage[],
    options?: LlmCallOptions,
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
