import { toLatencyMap } from './agent-latency';

describe('toLatencyMap', () => {
  it('iteration>0 用 #n 区分同名节点', () => {
    const map = toLatencyMap([
      { name: 'evaluate', latencyMs: 10, iteration: 0, degraded: false },
      { name: 'evaluate', latencyMs: 20, iteration: 1, degraded: false },
    ]);
    expect(map.evaluate).toBe(10);
    expect(map['evaluate#1']).toBe(20);
  });
});
