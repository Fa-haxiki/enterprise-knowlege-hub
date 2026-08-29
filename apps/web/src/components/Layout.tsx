import { NavLink, Outlet, useNavigate } from 'react-router-dom';
import { useAuthStore } from '@/store/auth';

const navItems = [
  { to: '/chat', label: '智能问答' },
  { to: '/workspaces', label: '知识空间' },
];

export default function Layout() {
  const { user, clear } = useAuthStore();
  const navigate = useNavigate();

  const logout = () => {
    clear();
    navigate('/login');
  };

  return (
    <div className="flex h-screen">
      <aside className="flex w-56 flex-col border-r border-slate-200 bg-white">
        <div className="flex h-14 items-center border-b border-slate-200 px-4">
          <span className="text-base font-semibold">企业知识库</span>
        </div>
        <nav className="flex-1 space-y-1 p-3">
          {navItems.map((item) => (
            <NavLink
              key={item.to}
              to={item.to}
              className={({ isActive }) =>
                `block rounded-md px-3 py-2 text-sm ${
                  isActive
                    ? 'bg-slate-900 text-white'
                    : 'text-slate-600 hover:bg-slate-100'
                }`
              }
            >
              {item.label}
            </NavLink>
          ))}
        </nav>
        <div className="border-t border-slate-200 p-3">
          <div className="truncate text-sm text-slate-700">{user?.name}</div>
          <div className="truncate text-xs text-slate-400">{user?.email}</div>
          <button
            onClick={logout}
            className="mt-2 w-full rounded-md border border-slate-200 px-3 py-1.5 text-xs text-slate-600 hover:bg-slate-100"
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
