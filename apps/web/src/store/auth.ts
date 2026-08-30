import { create } from 'zustand';
import { persist } from 'zustand/middleware';

export interface UserInfo {
  id: string;
  email: string;
  name: string;
  role: string;
  /** 是否为任一部门的管理员（决定"文档审核/我的部门"导航显隐） */
  is_dept_admin?: boolean;
}

interface AuthState {
  accessToken: string | null;
  refreshToken: string | null;
  user: UserInfo | null;
  setTokens: (access: string, refresh: string, user: UserInfo) => void;
  clear: () => void;
}

export const useAuthStore = create<AuthState>()(
  persist(
    (set) => ({
      accessToken: null,
      refreshToken: null,
      user: null,
      setTokens: (accessToken, refreshToken, user) => set({ accessToken, refreshToken, user }),
      clear: () => set({ accessToken: null, refreshToken: null, user: null }),
    }),
    {
      name: 'ekh-auth',
      version: 2,
      // v1 的 user 使用旧字段 is_reviewer，迁移为 is_dept_admin，避免旧登录态丢失导航入口
      migrate: (state) => {
        const s = state as AuthState & { user?: (UserInfo & { is_reviewer?: boolean }) | null };
        if (s?.user && s.user.is_dept_admin === undefined && s.user.is_reviewer !== undefined) {
          s.user.is_dept_admin = s.user.is_reviewer;
        }
        return s;
      },
    },
  ),
);
