import { AgentIntent, EvidenceGrade } from '@ekh/shared';
import {
  filterUnknownTools,
  heuristicEvaluate,
  parseEvaluateJson,
  shouldTakeFastPath,
} from './agent-evaluate';

const base = {
  chunks: [] as { rerank_score?: number }[],
  hasGraph: false,
  hasWeb: false,
  intent: AgentIntent.KB,
  minScore: 0.35,
  iteration: 0,
  maxIterations: 3,
  loopEnabled: true,
  fastPathEnabled: true,
};

describe('heuristicEvaluate', () => {
  it('空召回 → rewrite', () => {
    const r = heuristicEvaluate({ ...base, chunks: [] });
    expect(r.grade).toBe(EvidenceGrade.REWRITE);
  });

  it('达上限 → give_up', () => {
    const r = heuristicEvaluate({ ...base, iteration: 3, maxIterations: 3 });
    expect(r.grade).toBe(EvidenceGrade.GIVE_UP);
  });

  it('loop 关闭 → sufficient', () => {
    const r = heuristicEvaluate({ ...base, loopEnabled: false });
    expect(r.grade).toBe(EvidenceGrade.SUFFICIENT);
  });

  it('高分 → sufficient', () => {
    const r = heuristicEvaluate({
      ...base,
      chunks: [{ rerank_score: 0.8 }],
    });
    expect(r.grade).toBe(EvidenceGrade.SUFFICIENT);
  });

  it('kb_then_web 低分且未联网 → rewrite（转联网）', () => {
    const r = heuristicEvaluate({
      ...base,
      intent: AgentIntent.KB_THEN_WEB,
      chunks: [{ rerank_score: 0.1 }],
    });
    expect(r.grade).toBe(EvidenceGrade.REWRITE);
    expect(r.reason).toBe('kb_weak_need_web');
  });

  it('web 有结果 → sufficient，无结果才 rewrite', () => {
    expect(
      heuristicEvaluate({ ...base, intent: AgentIntent.WEB, hasWeb: true }).grade,
    ).toBe(EvidenceGrade.SUFFICIENT);
    expect(
      heuristicEvaluate({ ...base, intent: AgentIntent.WEB, hasWeb: false, iteration: 0 }).grade,
    ).toBe(EvidenceGrade.REWRITE);
    expect(
      heuristicEvaluate({
        ...base,
        intent: AgentIntent.WEB,
        hasWeb: false,
        iteration: 1,
        maxIterations: 2,
      }).grade,
    ).toBe(EvidenceGrade.GIVE_UP);
  });
});

describe('shouldTakeFastPath', () => {
  it('闲聊 / 偏好跳过循环', () => {
    expect(shouldTakeFastPath({ ...base, intent: AgentIntent.CHITCHAT })).toBe(true);
    expect(shouldTakeFastPath({ ...base, intent: AgentIntent.PREFERENCE })).toBe(true);
  });

  it('kb + 高分走快路径', () => {
    expect(
      shouldTakeFastPath({ ...base, intent: AgentIntent.KB, chunks: [{ rerank_score: 0.7 }] }),
    ).toBe(true);
  });

  it('kb 低分不走快路径', () => {
    expect(
      shouldTakeFastPath({ ...base, intent: AgentIntent.KB, chunks: [{ rerank_score: 0.1 }] }),
    ).toBe(false);
  });

  it('联网已有结果不再循环', () => {
    expect(
      shouldTakeFastPath({ ...base, intent: AgentIntent.WEB, hasWeb: true }),
    ).toBe(true);
    expect(
      shouldTakeFastPath({ ...base, intent: AgentIntent.WEB, hasWeb: false }),
    ).toBe(false);
  });
});

describe('parseEvaluateJson / filterUnknownTools', () => {
  it('解析合法 grade', () => {
    expect(parseEvaluateJson('{"grade":"rewrite","reason":"x","missing":"y"}')?.grade).toBe(
      EvidenceGrade.REWRITE,
    );
  });

  it('非法 grade 返回 null', () => {
    expect(parseEvaluateJson('{"grade":"maybe"}')).toBeNull();
  });

  it('未知工具丢弃', () => {
    expect(filterUnknownTools(['kb_retrieve', 'shell', 'web_search'], ['kb_retrieve', 'web_search'])).toEqual([
      'kb_retrieve',
      'web_search',
    ]);
  });
});
