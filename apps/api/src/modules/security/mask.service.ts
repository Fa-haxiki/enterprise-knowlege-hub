import { Injectable } from '@nestjs/common';

/**
 * 敏感信息脱敏：日志输出与 LLM 出站内容共用。
 * 只处理高敏结构化数据，避免影响正常语义。
 */
@Injectable()
export class MaskService {
  /** 文本脱敏：身份证、银行卡、手机号、邮箱 */
  maskText(text: string): string {
    return text
      .replace(/\b(\d{6})\d{8}(\d{3}[\dXx])\b/g, '$1********$2') // 身份证 18 位
      .replace(/\b(\d{4})\d{8,11}(\d{4})\b/g, '$1********$2') // 银行卡 16-19 位
      .replace(/\b(1[3-9]\d)\d{4}(\d{4})\b/g, '$1****$2') // 手机号
      .replace(/\b([\w.+-]{1,3})[\w.+-]*(@[\w-]+(?:\.[\w-]+)+)\b/g, '$1***$2'); // 邮箱
  }

  /** 对象脱敏：递归处理字符串字段；敏感字段名直接置 *** */
  maskObject<T>(obj: T): T {
    const SENSITIVE_KEYS = new Set(['password', 'password_hash', 'passwordHash', 'token', 'access_token', 'refresh_token', 'apiKey', 'api_key', 'secret']);
    const walk = (v: unknown): unknown => {
      if (typeof v === 'string') return this.maskText(v);
      if (Array.isArray(v)) return v.map(walk);
      if (v && typeof v === 'object') {
        return Object.fromEntries(
          Object.entries(v as Record<string, unknown>).map(([k, val]) => [
            k,
            SENSITIVE_KEYS.has(k) ? '***' : walk(val),
          ]),
        );
      }
      return v;
    };
    return walk(obj) as T;
  }
}
