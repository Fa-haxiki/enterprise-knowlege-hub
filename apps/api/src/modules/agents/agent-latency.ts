import type { NodeLatency } from '@ekh/shared';

/** 循环下同名节点用 #iteration 区分，兼容旧 Record 接口 */
export function toLatencyMap(entries: NodeLatency[]): Record<string, number> {
  const out: Record<string, number> = {};
  for (const e of entries) {
    const key = e.iteration > 0 ? `${e.name}#${e.iteration}` : e.name;
    out[key] = e.latencyMs;
  }
  return out;
}

export function asLatency(
  name: string,
  latencyMs: number,
  iteration = 0,
  degraded = false,
): NodeLatency[] {
  return [{ name, latencyMs, iteration, degraded }];
}
