import { RunSnapshot } from './run-snapshot';

describe('RunSnapshot', () => {
  it('记录已结束步骤，中止时补上未结束的一步', () => {
    const snap = new RunSnapshot();
    snap.startStep('load_window');
    snap.endStep('load_window', 12, false, { summary: '6 条窗口消息' });
    snap.startStep('query_rewrite');
    snap.flushOpen();

    expect(snap.steps).toHaveLength(2);
    expect(snap.steps[0].name).toBe('load_window');
    expect(snap.steps[0].degraded).toBe(false);
    expect(snap.steps[1]).toMatchObject({
      name: 'query_rewrite',
      degraded: true,
      detail: '已停止',
    });
    expect(snap.hasProgress('')).toBe(true);
    expect(snap.qaPayload().degradedNodes).toEqual(['query_rewrite']);
  });

  it('没有任何进度时不落库', () => {
    expect(new RunSnapshot().hasProgress('')).toBe(false);
    expect(new RunSnapshot().hasProgress('已生成半句')).toBe(true);
  });
});
