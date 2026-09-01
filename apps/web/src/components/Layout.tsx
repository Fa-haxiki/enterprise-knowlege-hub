import { useEffect, useState } from 'react';
import { NavLink, Outlet, useLocation, useNavigate } from 'react-router-dom';
import { api } from '@/lib/api';
import { useAuthStore } from '@/store/auth';
import { useThemeStore } from '@/store/theme';

interface NavItem {
  to: string;
  label: string;
  icon: JSX.Element;
  /** 可见条件：sysadmin 仅系统管理员；deptAdmin 部门管理员或系统管理员 */
  visible?: (user: { role: string; is_dept_admin?: boolean }) => boolean;
}

const navItems: NavItem[] = [
  {
    to: '/chat',
    label: '智能问答',
    icon: (
      <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
        <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2Z" />
      </svg>
    ),
  },
  {
    to: '/workspaces',
    label: '知识空间',
    icon: (
      <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
        <path d="M4 19.5A2.5 2.5 0 0 1 6.5 17H20" />
        <path d="M6.5 2H20v20H6.5A2.5 2.5 0 0 1 4 19.5v-15A2.5 2.5 0 0 1 6.5 2Z" />
      </svg>
    ),
  },
  {
    to: '/review',
    label: '文档审核',
    visible: (u) => u.role === 'sysadmin' || !!u.is_dept_admin,
    icon: (
      <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
        <path d="M9 12l2 2 4-4" />
        <path d="M12 3l7 4v5c0 4.5-3 8-7 9-4-1-7-4.5-7-9V7l7-4Z" />
      </svg>
    ),
  },
  {
    to: '/department',
    label: '我的部门',
    visible: (u) => u.role !== 'sysadmin' && !!u.is_dept_admin,
    icon: (
      <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
        <path d="M3 21h18M5 21V7l7-4 7 4v14M9 21v-6h6v6" />
      </svg>
    ),
  },
  {
    to: '/admin',
    label: '管理后台',
    visible: (u) => u.role === 'sysadmin',
    icon: (
      <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
        <circle cx="12" cy="12" r="3" />
        <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 1 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 1 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 1 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 1 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1Z" />
      </svg>
    ),
  },
];

export default function Layout() {
  const { user, clear } = useAuthStore();
  const { theme, toggle } = useThemeStore();
  const navigate = useNavigate();
  const location = useLocation();
  const [pendingReviewCount, setPendingReviewCount] = useState(0);

  const canReview = !!user && (user.role === 'sysadmin' || !!user.is_dept_admin);

  // 待审核角标：挂载/路由变化时刷新；浏览器切回本标签页时再刷新一次（不轮询）
  useEffect(() => {
    if (!canReview) return;
    let cancelled = false;
    const fetchCount = () =>
      api
        .get<{ total: number }>('/documents/pending-review?page=1&page_size=1')
        .then((d) => !cancelled && setPendingReviewCount(d.total))
        .catch(() => undefined);
    void fetchCount();
    const onVisible = () => {
      if (document.visibilityState === 'visible') void fetchCount();
    };
    document.addEventListener('visibilitychange', onVisible);
    return () => {
      cancelled = true;
      document.removeEventListener('visibilitychange', onVisible);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [canReview, location.pathname]);

  const logout = () => {
    clear();
    navigate('/login');
  };

  const visibleItems = navItems.filter((item) => !item.visible || (user && item.visible(user)));

  return (
    <div className="flex h-screen">
      <aside className="flex w-56 flex-col border-r border-border bg-card">
        <div className="flex h-14 items-center gap-2.5 border-b border-border px-4">
          <div className="flex h-7 w-7 items-center justify-center rounded-lg bg-gradient-to-br from-brand-500 to-brand-700 text-white shadow-sm">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <path d="M12 3l1.9 5.1L19 10l-5.1 1.9L12 17l-1.9-5.1L5 10l5.1-1.9L12 3Z" />
            </svg>
          </div>
          <span className="text-base font-semibold tracking-tight">企业知识库</span>
        </div>
        <nav className="flex-1 space-y-1 p-3">
          {visibleItems.map((item) => (
            <NavLink
              key={item.to}
              to={item.to}
              className={({ isActive }) =>
                `flex items-center gap-2.5 rounded-lg px-3 py-2 text-sm transition-colors ${
                  isActive
                    ? 'bg-brand-600/10 font-medium text-brand-700'
                    : 'text-ink-600 hover:bg-subtle'
                }`
              }
            >
              {item.icon}
              {item.label}
              {item.to === '/review' && pendingReviewCount > 0 && (
                <span className="ml-auto flex h-4 min-w-4 items-center justify-center rounded-full bg-red-500 px-1 text-[10px] font-semibold text-white">
                  {pendingReviewCount > 99 ? '99+' : pendingReviewCount}
                </span>
              )}
            </NavLink>
          ))}
        </nav>
        <div className="border-t border-border p-3">
          <div className="flex items-center gap-2.5">
            <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-brand-600/10 text-sm font-medium text-brand-700">
              {user?.name?.[0] ?? 'U'}
            </div>
            <div className="min-w-0 flex-1">
              <div className="truncate text-sm text-ink-900">{user?.name}</div>
              <div className="truncate text-xs text-ink-400">{user?.email}</div>
            </div>
            <button
              onClick={toggle}
              className="rounded-lg p-1.5 text-ink-400 transition-colors hover:bg-subtle hover:text-ink-600"
              title={theme === 'dark' ? '切换浅色模式' : '切换暗色模式'}
            >
              {theme === 'dark' ? (
                <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <circle cx="12" cy="12" r="4" />
                  <path d="M12 2v2m0 16v2M4.9 4.9l1.4 1.4m11.4 11.4 1.4 1.4M2 12h2m16 0h2M4.9 19.1l1.4-1.4m11.4-11.4 1.4-1.4" />
                </svg>
              ) : (
                <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M21 12.8A9 9 0 1 1 11.2 3 7 7 0 0 0 21 12.8Z" />
                </svg>
              )}
            </button>
          </div>
          <button
            onClick={logout}
            className="mt-2.5 w-full rounded-lg border border-border px-3 py-1.5 text-xs text-ink-600 transition-colors hover:bg-subtle"
          >
            退出登录
          </button>
        </div>
      </aside>
      <main className="flex-1 overflow-hidden">
        <Outlet />
      </main>
    </div>
  );
}
