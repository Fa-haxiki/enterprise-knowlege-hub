import { create } from 'zustand';
import { api } from '@/lib/api';

export type FeatureFlag = 'graph_reasoning' | 'graph_explorer';
export type FeatureFlags = Record<FeatureFlag, boolean>;

interface FeaturesState {
  flags: FeatureFlags;
  /** 首次拉取完成前不据此做重定向，避免开关未知时把用户弹走 */
  loaded: boolean;
  fetch: () => Promise<void>;
  set: (flags: Partial<FeatureFlags>) => void;
}

/**
 * 运行时功能开关（管理后台一键下架 / 上架）。
 * 前端只做显隐，服务端才是强制点；Layout 挂载与标签页切回时刷新。
 */
export const useFeaturesStore = create<FeaturesState>()((set) => ({
  flags: { graph_reasoning: true, graph_explorer: true },
  loaded: false,
  fetch: async () => {
    try {
      const flags = await api.get<FeatureFlags>('/features');
      set({ flags, loaded: true });
    } catch {
      set({ loaded: true });
    }
  },
  set: (flags) => set((s) => ({ flags: { ...s.flags, ...flags } })),
}));
