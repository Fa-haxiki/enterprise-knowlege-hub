import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { RedisService } from '../../redis/redis.service';

/** 运行时功能开关（一键下架 / 上架，无需改配置或重启） */
export const FEATURE_FLAGS = ['graph_reasoning', 'graph_explorer'] as const;
export type FeatureFlag = (typeof FEATURE_FLAGS)[number];

export const FEATURE_FLAG_LABELS: Record<FeatureFlag, string> = {
  graph_reasoning: '问答图谱推理',
  graph_explorer: '知识图谱页面',
};

/** 进程内缓存时长：问答每次都会查开关，避免逐次打 Redis */
const CACHE_TTL_MS = 5_000;

/**
 * 功能开关：Redis 键 `feature:{flag}`（1/0）为运行时值，未设置时回退 env 默认（configuration.features）。
 * 服务端是开关的生效点（接口拒绝 / 节点跳过），前端只做隐藏。
 */
@Injectable()
export class FeatureFlagsService {
  private readonly logger = new Logger(FeatureFlagsService.name);
  private readonly cache = new Map<FeatureFlag, { value: boolean; expiresAt: number }>();

  constructor(
    private readonly redis: RedisService,
    private readonly config: ConfigService,
  ) {}

  private key(flag: FeatureFlag) {
    return `feature:${flag}`;
  }

  private defaultOf(flag: FeatureFlag): boolean {
    switch (flag) {
      case 'graph_reasoning':
        return this.config.get<boolean>('features.graphReasoning') ?? true;
      case 'graph_explorer':
        return this.config.get<boolean>('features.graphExplorer') ?? true;
      default:
        return true;
    }
  }

  async isEnabled(flag: FeatureFlag): Promise<boolean> {
    const cached = this.cache.get(flag);
    if (cached && cached.expiresAt > Date.now()) return cached.value;
    let value = this.defaultOf(flag);
    try {
      const raw = await this.redis.raw.get(this.key(flag));
      if (raw === '1') value = true;
      else if (raw === '0') value = false;
    } catch (e) {
      // Redis 抖动时按默认值放行，不让开关查询拖垮主链路
      this.logger.warn(`feature flag read failed (${flag}), fallback default: ${(e as Error).message}`);
    }
    this.cache.set(flag, { value, expiresAt: Date.now() + CACHE_TTL_MS });
    return value;
  }

  async set(flag: FeatureFlag, enabled: boolean): Promise<void> {
    await this.redis.raw.set(this.key(flag), enabled ? '1' : '0');
    this.cache.delete(flag);
  }

  async all(): Promise<Record<FeatureFlag, boolean>> {
    const out = {} as Record<FeatureFlag, boolean>;
    for (const flag of FEATURE_FLAGS) out[flag] = await this.isEnabled(flag);
    return out;
  }
}
