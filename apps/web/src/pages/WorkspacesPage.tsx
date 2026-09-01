import { FormEvent, MouseEvent, useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { api, ApiError } from '@/lib/api';
import { useAuthStore } from '@/store/auth';
import { useConfirm } from '@/components/ConfirmDialog';

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
  const user = useAuthStore((s) => s.user);
  const { confirm, confirmDialog } = useConfirm();
  const [list, setList] = useState<Workspace[]>([]);
  const [departments, setDepartments] = useState<DepartmentOption[]>([]);
  const [loading, setLoading] = useState(true);
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [departmentId, setDepartmentId] = useState('');
  const [error, setError] = useState('');
  /** 编辑中的空间；null 表示未打开编辑弹窗 */
  const [editing, setEditing] = useState<Workspace | null>(null);
  const [editName, setEditName] = useState('');
  const [editDesc, setEditDesc] = useState('');
  const [editDeptId, setEditDeptId] = useState('');
  const [editError, setEditError] = useState('');
  const [saving, setSaving] = useState(false);

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

  const canManage = (ws: Workspace) => ws.role === 'owner' || user?.role === 'sysadmin';

  const openEdit = (e: MouseEvent, ws: Workspace) => {
    e.preventDefault();
    e.stopPropagation();
    setEditing(ws);
    setEditName(ws.name);
    setEditDesc(ws.description ?? '');
    setEditDeptId(ws.department?.id ?? '');
    setEditError('');
  };

  const saveEdit = async (e: FormEvent) => {
    e.preventDefault();
    if (!editing) return;
    setSaving(true);
    setEditError('');
    try {
      await api.patch(`/workspaces/${editing.id}`, {
        name: editName,
        description: editDesc || undefined,
        department_id: editDeptId || undefined,
      });
      setEditing(null);
      await load();
    } catch (err) {
      setEditError(err instanceof ApiError ? err.message : '保存失败');
    } finally {
      setSaving(false);
    }
  };

  const remove = async (e: MouseEvent, ws: Workspace) => {
    e.preventDefault();
    e.stopPropagation();
    const ok = await confirm({
      title: '删除知识空间',
      description: `空间「${ws.name}」将被删除，成员授权一并失效。空间内的文档需先逐篇删除，否则无法删除空间。此操作不可恢复。`,
      confirmText: '确认删除',
    });
    if (!ok) return;
    try {
      await api.delete(`/workspaces/${ws.id}`);
      await load();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : '删除失败');
    }
  };

  return (
    <div className="h-full overflow-y-auto p-6">
      <div className="mx-auto max-w-4xl">
        <h1 className="mb-1 text-lg font-semibold text-ink-900">知识空间</h1>
        <p className="mb-5 text-sm text-ink-400">按团队或主题组织文档，空间成员共享检索权限</p>

        {departments.length === 0 && !loading ? (
          <div className="mb-6 rounded-card border border-dashed border-border bg-card p-4 text-sm text-ink-400">
            仅部门管理员可创建空间。您可查看所属部门下的空间，如需新建请联系部门管理员。
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
                <div className="mt-2 flex items-center justify-between gap-2">
                  {ws.department ? (
                    <div className="flex items-center gap-1 text-xs text-ink-400">
                      <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                        <path d="M3 21h18M5 21V7l7-4 7 4v14M9 21v-6h6v6" />
                      </svg>
                      {ws.department.name}
                    </div>
                  ) : (
                    <span />
                  )}
                  {canManage(ws) && (
                    <div className="flex items-center gap-1.5">
                      <button
                        onClick={(e) => void openEdit(e, ws)}
                        title="编辑空间"
                        className="rounded-lg p-1.5 text-ink-400 opacity-0 transition-all hover:bg-subtle hover:text-brand-600 group-hover:opacity-100"
                      >
                        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                          <path d="M17 3a2.85 2.83 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5Z" />
                        </svg>
                      </button>
                      <button
                        onClick={(e) => void remove(e, ws)}
                        title="删除空间"
                        className="rounded-lg p-1.5 text-ink-400 opacity-0 transition-all hover:bg-red-500/10 hover:text-red-600 group-hover:opacity-100"
                      >
                        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                          <path d="M3 6h18M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2m3 0v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6" />
                        </svg>
                      </button>
                    </div>
                  )}
                </div>
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

      {editing && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4"
          onClick={() => setEditing(null)}
        >
          <form
            onSubmit={saveEdit}
            onClick={(e) => e.stopPropagation()}
            className="w-full max-w-md rounded-card border border-border bg-card p-5 shadow-pop"
          >
            <h2 className="mb-4 text-base font-semibold text-ink-900">编辑空间</h2>
            <label className="mb-3 block">
              <span className="mb-1 block text-xs text-ink-400">空间名称</span>
              <input
                className="w-full rounded-lg border border-border bg-card px-3 py-2 text-sm outline-none transition-colors focus:border-brand-500"
                value={editName}
                onChange={(e) => setEditName(e.target.value)}
                required
              />
            </label>
            <label className="mb-3 block">
              <span className="mb-1 block text-xs text-ink-400">描述</span>
              <input
                className="w-full rounded-lg border border-border bg-card px-3 py-2 text-sm outline-none transition-colors focus:border-brand-500"
                value={editDesc}
                onChange={(e) => setEditDesc(e.target.value)}
              />
            </label>
            <label className="mb-4 block">
              <span className="mb-1 block text-xs text-ink-400">挂靠部门</span>
              <select
                className="w-full rounded-lg border border-border bg-card px-3 py-2 text-sm text-ink-600 outline-none transition-colors focus:border-brand-500"
                value={editDeptId}
                onChange={(e) => setEditDeptId(e.target.value)}
                required
              >
                {/* 当前挂靠部门可能不在可管理部门列表中（如 sysadmin 编辑他人空间），合并进选项仅作展示 */}
                {(editing.department && !departments.some((d) => d.id === editing.department!.id)
                  ? [...departments, editing.department]
                  : departments
                ).map((d) => (
                  <option key={d.id} value={d.id}>
                    {d.name}
                  </option>
                ))}
              </select>
            </label>
            {editError && (
              <p className="mb-3 rounded-lg bg-red-500/10 px-3 py-2 text-sm text-red-600 dark:text-red-400">
                {editError}
              </p>
            )}
            <div className="flex justify-end gap-2">
              <button
                type="button"
                onClick={() => setEditing(null)}
                className="rounded-lg border border-border px-4 py-2 text-sm text-ink-600 transition-colors hover:bg-subtle"
              >
                取消
              </button>
              <button
                disabled={saving}
                className="rounded-lg bg-brand-600 px-4 py-2 text-sm font-medium text-white shadow-sm transition-colors hover:bg-brand-700 disabled:opacity-50"
              >
                {saving ? '保存中…' : '保存'}
              </button>
            </div>
          </form>
        </div>
      )}
      {confirmDialog}
    </div>
  );
}
