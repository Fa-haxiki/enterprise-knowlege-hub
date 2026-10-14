import { formatLlmError } from './llm-error';

describe('formatLlmError', () => {
  it('优先用接口体里的额度说明', () => {
    const err = Object.assign(new Error('429'), {
      error: { message: 'Insufficient Balance' },
    });
    expect(formatLlmError(err)).toBe('Insufficient Balance');
  });

  it('message 里嵌了 JSON 时抽出 error.message', () => {
    const err = new Error(
      '400 {"error":{"message":"You exceeded your current quota","type":"insufficient_quota"}}',
    );
    expect(formatLlmError(err)).toBe('You exceeded your current quota');
  });

  it('没有结构时用首行原文', () => {
    expect(formatLlmError(new Error('Request failed: quota\nstack line'))).toBe('Request failed: quota');
  });

  it('空错误给一句兜底', () => {
    expect(formatLlmError(undefined)).toBe('模型调用失败');
  });
});
