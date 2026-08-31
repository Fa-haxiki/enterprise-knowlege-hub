import { FormEvent, useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { api, ApiError } from '@/lib/api';

interface Workspace {
  id: string;
  name: string;
  description: string | null;
  role: 'owner' | 'editor' | 'viewer';
  department: { id: string; name: string } | null;
  created_at: string;
}

interface DepartmentOption {
  id: string;
  name: string;
}

const ROLE_LABEL = { owner: '所有者', editor: '编辑者', viewer: '查看者' } as const;
const ROLE_CLS = {
  owner: 'bg-amber-500/10 text-amber-600 dark:text-amber-400',
  editor: 'bg-brand-600/10 text-brand-600',
  viewer: 'bg-subtle text-ink-400',
} as const;

export default function WorkspacesPage() {
  const [list, setList] = useState<Workspace[]>([]);
  const [departments, setDepartments] = useState<DepartmentOption[]>([]);
  const [loading, setLoading] = useState(true);
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [departmentId, setDepartmentId] = useState('');
  const [error, setError] = useState('');

  const load = () =>
    api
      .get<Workspace[]>('/workspaces')
      .then(setList)
      .catch(() => setList([]))
      .finally(() => setLoading(false));

  useEffect(() => {
    void load();
    api
      .get<{ items: DepartmentOption[] }>('/workspaces/departments')
      .then((d) => {
        setDepartments(d.items);
        // 部门必选：默认选中第一个
        if (d.items.length > 0) setDepartmentId((prev) => prev || d.items[0].id);
      })
      .catch(() => setDepartments([]));
  }, []);

  const create = async (e: FormEvent) => {
    e.preventDefault();
    setError('');
    try {
      await api.post('/workspaces', {
        name,
        description: description || undefined,
        department_id: departmentId,
      });
      setName('');
      setDescription('');
      await load();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : '创建失败');
    }
  };

  return (
    <div className="h-full overflow-y-auto p-6">
      <div className="mx-auto max-w-4xl">
        <h1 className="mb-1 text-lg font-semibold text-ink-900">知识空间</h1>
        <p className="mb-5 text-sm text-ink-400">按团队或主题组织文档，空间成员共享检索权限</p>

        {departments.length === 0 && !loading ? (
          <div className="mb-6 rounded-card border border-dashed border-border bg-card p-4 text-sm text-ink-400">
            您还未加入任何部门，暂时无法创建空间。请联系您的部门管理员将您加入部门。
          </div>
        ) : (
          <form
            onSubmit={create}
            className="mb-6 flex flex-wrap gap-2 rounded-card border border-border bg-card p-4 shadow-card"
          >
            <input
              className="flex-1 min-w-40 rounded-lg border border-border bg-card px-3 py-2 text-sm outline-none transition-colors placeholder:text-ink-400 focus:border-brand-500"
              placeholder="空间名称，如：财务部制度库"
              value={name}
              onChange={(e) => setName(e.target.value)}
              required
            />
            <input
              className="flex-1 min-w-40 rounded-lg border border-border bg-card px-3 py-2 text-sm outline-none transition-colors placeholder:text-ink-400 focus:border-brand-500"
              placeholder="描述（可选）"
              value={description}
              onChange={(e) => setDescription(e.target.value)}
            />
            <select
              value={departmentId}
              onChange={(e) => setDepartmentId(e.target.value)}
              required
              className="rounded-lg border border-border bg-card px-3 py-2 text-sm text-ink-600 outline-none transition-colors focus:border-brand-500"
              title="挂靠部门：文档由该部门的管理员审核"
            >
              {departments.map((d) => (
                <option key={d.id} value={d.id}>
                  {d.name}
                </option>
              ))}
            </select>
            <button className="rounded-lg bg-brand-600 px-4 py-2 text-sm font-medium text-white shadow-sm transition-colors hover:bg-brand-700">
              创建
            </button>
          </form>
        )}
        {error && (
          <p className="mb-4 rounded-lg bg-red-500/10 px-3 py-2 text-sm text-red-600 dark:text-red-400">
            {error}
          </p>
        )}

        {loading ? (
          <div className="grid gap-3 sm:grid-cols-2">
            {Array.from({ length: 4 }).map((_, i) => (
              <div key={i} className="skeleton h-24 rounded-card" />
            ))}
          </div>
        ) : (
          <div className="grid gap-3 sm:grid-cols-2">
            {list.map((ws) => (
              <Link
                key={ws.id}
                to={`/workspaces/${ws.id}/documents`}
                className="group rounded-card border border-border bg-card p-4 shadow-card transition-all hover:-translate-y-0.5 hover:border-brand-500/50 hover:shadow-pop"
              >
                <div className="flex items-start justify-between gap-2">
                  <div className="flex items-center gap-2.5">
                    <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-brand-600/10 text-brand-600">
                      <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                        <path d="M4 19.5A2.5 2.5 0 0 1 6.5 17H20" />
                        <path d="M6.5 2H20v20H6.5A2.5 2.5 0 0 1 4 19.5v-15A2.5 2.5 0 0 1 6.5 2Z" />
                      </svg>
                    </div>
                    <div className="font-medium text-ink-900">{ws.name}</div>
                  </div>
                  <span className={`shrink-0 rounded-full px-2.5 py-1 text-xs ${ROLE_CLS[ws.role]}`}>
                    {ROLE_LABEL[ws.role]}
                  </span>
                </div>
                {ws.description && (
                  <div className="mt-2 line-clamp-2 text-sm leading-5 text-ink-400">{ws.description}</div>
                )}
                {ws.department && (
                  <div className="mt-2 flex items-center gap-1 text-xs text-ink-400">
                    <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                      <path d="M3 21h18M5 21V7l7-4 7 4v14M9 21v-6h6v6" />
                    </svg>
                    {ws.department.name}
                  </div>
                )}
              </Link>
            ))}
            {list.length === 0 && (
              <div className="col-span-full rounded-card border border-dashed border-border py-16 text-center">
                <p className="text-sm text-ink-400">暂无空间，先创建一个吧</p>
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
