import { FormEvent, useCallback, useEffect, useState } from 'react';
import { api, ApiError } from '@/lib/api';
import MemberList, { type MemberPerson } from '@/components/MemberList';
import Pagination from '@/components/Pagination';
import { useConfirm } from '@/components/ConfirmDialog';

interface AdminUser {
  id: string;
  email: string;
  name: string;
  role: string;
  status: 'PENDING' | 'ACTIVE' | 'REJECTED';
  review_note: string | null;
  disabled: boolean;
  departments: { id: string; name: string; is_admin: boolean }[];
  created_at: string;
}

/** 部门列表项（轻量）：只带人数统计 */
interface Department {
  id: string;
  name: string;
  description: string | null;
  admin_count: number;
  member_count: number;
  created_at: string;
}

/** 部门详情：点击时按需加载，含管理员与成员列表 */
interface DepartmentDetail {
  id: string;
  name: string;
  description: string | null;
  admins: MemberPerson[];
  members: MemberPerson[];
  created_at: string;
}

const USER_STATUS: Record<string, { label: string; cls: string }> = {
  PENDING: { label: '待审核', cls: 'bg-amber-500/10 text-amber-600 dark:text-amber-400' },
  ACTIVE: { label: '正常', cls: 'bg-emerald-500/10 text-emerald-600 dark:text-emerald-400' },
  REJECTED: { label: '已拒绝', cls: 'bg-red-500/10 text-red-500' },
};

const inputCls =
  'rounded-lg border border-border bg-card px-3 py-1.5 text-sm outline-none transition-colors placeholder:text-ink-400 focus:border-brand-500';

export default function AdminPage() {
  const [tab, setTab] = useState<'users' | 'departments'>('users');
  return (
    <div className="h-full overflow-y-auto p-6">
      <div className="mx-auto max-w-5xl">
        <h1 className="text-lg font-semibold text-ink-900">管理后台</h1>
        <p className="mb-5 mt-1 text-sm text-ink-400">账号审核、用户管理与部门管理员配置</p>

        <div className="mb-5 flex gap-1 rounded-lg border border-border bg-card p-1 shadow-card w-fit">
          {(
            [
              { key: 'users', label: '用户管理' },
              { key: 'departments', label: '部门管理' },
            ] as const
          ).map((t) => (
            <button
              key={t.key}
              onClick={() => setTab(t.key)}
              className={`rounded-md px-4 py-1.5 text-sm transition-colors ${
                tab === t.key ? 'bg-brand-600 text-white shadow-sm' : 'text-ink-600 hover:bg-subtle'
              }`}
            >
              {t.label}
            </button>
          ))}
        </div>

        {tab === 'users' ? <UsersPanel /> : <DepartmentsPanel />}
      </div>
    </div>
  );
}

/* ---------------- 用户管理 ---------------- */

const PAGE_SIZE = 10;

function UsersPanel() {
  const [items, setItems] = useState<AdminUser[]>([]);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(1);
  const [status, setStatus] = useState('');
  const [keyword, setKeyword] = useState('');
  const [loading, setLoading] = useState(true);
  const [rejectingId, setRejectingId] = useState<string | null>(null);
  const [rejectReason, setRejectReason] = useState('');
  const [showCreate, setShowCreate] = useState(false);
  const { confirm, confirmDialog } = useConfirm();

  const load = useCallback(async (p = page, st = status, kw = keyword) => {
    setLoading(true);
    try {
      const q = new URLSearchParams({ page: String(p), page_size: String(PAGE_SIZE) });
      if (st) q.set('status', st);
      if (kw.trim()) q.set('keyword', kw.trim());
      const d = await api.get<{ items: AdminUser[]; total: number }>(`/admin/users?${q}`);
      setItems(d.items);
      setTotal(d.total);
    } finally {
      setLoading(false);
    }
  }, [page, status, keyword]);

  useEffect(() => {
    void load(1, status, keyword);
    setPage(1);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [status]);

  const act = async (fn: () => Promise<unknown>) => {
    await fn();
    await load();
  };

  const goPage = (p: number) => {
    setPage(p);
    void load(p);
  };

  return (
    <div className="rounded-card border border-border bg-card shadow-card">
      <div className="flex flex-wrap items-center gap-2 border-b border-border p-3">
        <select
          value={status}
          onChange={(e) => setStatus(e.target.value)}
          className={`${inputCls} w-32`}
        >
          <option value="">全部状态</option>
          <option value="PENDING">待审核</option>
          <option value="ACTIVE">正常</option>
          <option value="REJECTED">已拒绝</option>
        </select>
        <form
          onSubmit={(e) => {
            e.preventDefault();
            void load(1, status, keyword);
          }}
          className="flex gap-2"
        >
          <input
            value={keyword}
            onChange={(e) => setKeyword(e.target.value)}
            placeholder="搜索邮箱 / 姓名"
            className={`${inputCls} w-52`}
          />
          <button type="submit" className="rounded-lg bg-brand-600 px-3 py-1.5 text-sm text-white hover:bg-brand-700">
            搜索
          </button>
        </form>
        <span className="ml-auto text-xs text-ink-400">共 {total} 个账号</span>
        <button
          onClick={() => setShowCreate(!showCreate)}
          className="rounded-lg bg-brand-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-brand-700"
        >
          {showCreate ? '收起' : '新建用户'}
        </button>
      </div>

      {showCreate && (
        <CreateUserForm
          onCreated={() => {
            setShowCreate(false);
            void load();
          }}
        />
      )}

      {loading ? (
        <div className="space-y-2 p-4">
          {Array.from({ length: 5 }).map((_, i) => (
            <div key={i} className="skeleton h-12 rounded-lg" />
          ))}
        </div>
      ) : items.length === 0 ? (
        <p className="py-14 text-center text-sm text-ink-400">没有匹配的账号</p>
      ) : (
        <div className="divide-y divide-border">
          {items.map((u) => {
            const st = USER_STATUS[u.status] ?? USER_STATUS.ACTIVE;
            return (
              <div key={u.id} className="flex items-center gap-3 px-4 py-3">
                <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-brand-600/10 text-sm font-medium text-brand-700">
                  {u.name[0] ?? 'U'}
                </div>
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-2">
                    <span className="truncate text-sm font-medium text-ink-900">{u.name}</span>
                    <span className={`rounded px-1.5 py-px text-[11px] ${st.cls}`}>{st.label}</span>
                    {u.disabled && (
                      <span className="rounded bg-ink-400/10 px-1.5 py-px text-[11px] text-ink-400">已禁用</span>
                    )}
                    {u.role === 'sysadmin' && (
                      <span className="rounded bg-brand-600/10 px-1.5 py-px text-[11px] text-brand-600">管理员</span>
                    )}
                  </div>
                  <div className="mt-0.5 flex items-center gap-1.5 text-xs text-ink-400">
                    <span className="truncate">
                      {u.email} · 注册于 {new Date(u.created_at).toLocaleDateString()}
                      {u.review_note && <span className="ml-1 text-red-400">拒绝理由：{u.review_note}</span>}
                    </span>
                    {u.departments.map((d) => (
                      <span
                        key={d.id}
                        className={`inline-flex shrink-0 items-center gap-0.5 rounded px-1.5 py-px text-[11px] ${
                          d.is_admin
                            ? 'bg-brand-600/10 font-medium text-brand-600'
                            : 'bg-subtle text-ink-400'
                        }`}
                        title={d.is_admin ? `${d.name} · 部门管理员` : `${d.name} · 成员`}
                      >
                        <svg width="9" height="9" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                          <path d="M3 21h18M5 21V7l7-4 7 4v14M9 21v-6h6v6" />
                        </svg>
                        {d.name}
                        {d.is_admin && '·管理'}
                      </span>
                    ))}
                  </div>
                </div>

                <div className="flex shrink-0 items-center gap-1.5">
                  {u.status === 'PENDING' && (
                    <>
                      <button
                        onClick={() => void act(() => api.post(`/admin/users/${u.id}/approve`, {}))}
                        className="rounded-lg bg-emerald-600 px-2.5 py-1 text-xs text-white hover:bg-emerald-700"
                      >
                        通过
                      </button>
                      {rejectingId === u.id ? (
                        <span className="flex items-center gap-1">
                          <input
                            autoFocus
                            value={rejectReason}
                            onChange={(e) => setRejectReason(e.target.value)}
                            placeholder="拒绝理由"
                            className={`${inputCls} w-36 py-1 text-xs`}
                          />
                          <button
                            onClick={() =>
                              void act(async () => {
                                await api.post(`/admin/users/${u.id}/reject`, { reason: rejectReason });
                                setRejectingId(null);
                                setRejectReason('');
                              })
                            }
                            className="rounded-lg bg-red-500 px-2.5 py-1 text-xs text-white hover:bg-red-600"
                          >
                            确认
                          </button>
                          <button
                            onClick={() => setRejectingId(null)}
                            className="rounded-lg px-2 py-1 text-xs text-ink-400 hover:bg-subtle"
                          >
                            取消
                          </button>
                        </span>
                      ) : (
                        <button
                          onClick={() => setRejectingId(u.id)}
                          className="rounded-lg border border-red-500/30 px-2.5 py-1 text-xs text-red-500 hover:bg-red-500/10"
                        >
                          拒绝
                        </button>
                      )}
                    </>
                  )}
                  {u.status === 'ACTIVE' && (
                    <>
                      <button
                        onClick={() =>
                          void act(() =>
                            api.patch(`/admin/users/${u.id}`, {
                              role: u.role === 'sysadmin' ? 'member' : 'sysadmin',
                            }),
                          )
                        }
                        className="rounded-lg border border-border px-2.5 py-1 text-xs text-ink-600 hover:bg-subtle"
                      >
                        {u.role === 'sysadmin' ? '降为成员' : '设为管理员'}
                      </button>
                      <button
                        onClick={async () => {
                          const ok = await confirm({
                            title: u.disabled ? '启用账号' : '禁用账号',
                            description: u.disabled
                              ? `启用后「${u.name}」可正常登录系统。`
                              : `禁用后「${u.name}」将无法登录系统。`,
                            confirmText: u.disabled ? '确认启用' : '确认禁用',
                          });
                          if (ok) await act(() => api.patch(`/admin/users/${u.id}`, { disabled: !u.disabled }));
                        }}
                        className={`rounded-lg border px-2.5 py-1 text-xs ${
                          u.disabled
                            ? 'border-emerald-500/30 text-emerald-600 hover:bg-emerald-500/10'
                            : 'border-border text-ink-600 hover:bg-subtle'
                        }`}
                      >
                        {u.disabled ? '启用' : '禁用'}
                      </button>
                    </>
                  )}
                </div>
              </div>
            );
          })}
        </div>
      )}

      <div className="border-t border-border px-3">
        <Pagination page={page} total={total} pageSize={PAGE_SIZE} onChange={goPage} totalLabel={`共 ${total} 人`} />
      </div>
      {confirmDialog}
    </div>
  );
}

/** 管理员手动新建用户：直接激活，无需审核；可选直接加入部门 */
function CreateUserForm({ onCreated }: { onCreated: () => void }) {
  const [email, setEmail] = useState('');
  const [name, setName] = useState('');
  const [password, setPassword] = useState('');
  const [role, setRole] = useState('member');
  const [departmentId, setDepartmentId] = useState('');
  const [departments, setDepartments] = useState<{ id: string; name: string }[]>([]);
  const [error, setError] = useState('');
  const [submitting, setSubmitting] = useState(false);

  useEffect(() => {
    api
      .get<{ items: { id: string; name: string }[] }>('/admin/departments')
      .then((d) => setDepartments(d.items))
      .catch(() => setDepartments([]));
  }, []);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setError('');
    setSubmitting(true);
    try {
      await api.post('/admin/users', {
        email,
        name,
        password,
        role,
        department_id: departmentId || undefined,
      });
      onCreated();
    } catch (err) {
      setError(err instanceof Error ? err.message : '创建失败');
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <form onSubmit={submit} className="flex flex-wrap items-center gap-2 border-b border-border bg-subtle/40 p-3">
      <input
        type="email"
        value={email}
        onChange={(e) => setEmail(e.target.value)}
        placeholder="邮箱"
        required
        className={`${inputCls} w-52`}
      />
      <input
        value={name}
        onChange={(e) => setName(e.target.value)}
        placeholder="姓名"
        required
        className={`${inputCls} w-32`}
      />
      <input
        type="password"
        value={password}
        onChange={(e) => setPassword(e.target.value)}
        placeholder="初始密码（至少 8 位）"
        minLength={8}
        required
        className={`${inputCls} w-44`}
      />
      <select value={role} onChange={(e) => setRole(e.target.value)} className={`${inputCls} w-28`}>
        <option value="member">成员</option>
        <option value="sysadmin">管理员</option>
      </select>
      <select
        value={departmentId}
        onChange={(e) => setDepartmentId(e.target.value)}
        className={`${inputCls} w-36`}
        title="创建后直接加入该部门"
      >
        <option value="">不加入部门</option>
        {departments.map((d) => (
          <option key={d.id} value={d.id}>
            {d.name}
          </option>
        ))}
      </select>
      <button
        type="submit"
        disabled={submitting}
        className="rounded-lg bg-emerald-600 px-3.5 py-1.5 text-sm font-medium text-white hover:bg-emerald-700 disabled:opacity-50"
      >
        {submitting ? '创建中…' : '确认创建'}
      </button>
      {error && <p className="w-full text-xs text-red-500">{error}</p>}
    </form>
  );
}

/* ---------------- 部门管理 ---------------- */

function DepartmentsPanel() {
  const [items, setItems] = useState<Department[]>([]);
  const [allUsers, setAllUsers] = useState<AdminUser[]>([]);
  const [loading, setLoading] = useState(true);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [detail, setDetail] = useState<DepartmentDetail | null>(null);
  const [detailLoading, setDetailLoading] = useState(false);
  const [showCreate, setShowCreate] = useState(false);
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [error, setError] = useState('');

  /** 部门列表（轻量，含人数统计）+ 候选用户（添加成员用） */
  const load = useCallback(async () => {
    setLoading(true);
    try {
      const [deps, users] = await Promise.all([
        api.get<{ items: Department[] }>('/admin/departments'),
        api.get<{ items: AdminUser[] }>('/admin/users?status=ACTIVE&page_size=200'),
      ]);
      setItems(deps.items);
      setAllUsers(users.items);
      // 保持选中态；选中项被删则回落到第一个
      setSelectedId((prev) =>
        prev && deps.items.some((d) => d.id === prev) ? prev : (deps.items[0]?.id ?? null),
      );
    } finally {
      setLoading(false);
    }
  }, []);

  /** 选中部门的成员详情：点击时才请求 */
  const loadDetail = useCallback(async (id: string) => {
    setDetailLoading(true);
    try {
      setDetail(await api.get<DepartmentDetail>(`/admin/departments/${id}`));
    } finally {
      setDetailLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  useEffect(() => {
    if (selectedId) void loadDetail(selectedId);
    else setDetail(null);
  }, [selectedId, loadDetail]);

  /** 成员操作后：刷新详情（成员列表）与左栏统计 */
  const reload = async () => {
    if (selectedId) await loadDetail(selectedId);
    const deps = await api.get<{ items: Department[] }>('/admin/departments');
    setItems(deps.items);
  };

  const create = async (e: FormEvent) => {
    e.preventDefault();
    setError('');
    try {
      await api.post('/admin/departments', { name, description: description || undefined });
      setName('');
      setDescription('');
      setShowCreate(false);
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : '创建失败');
    }
  };

  return (
    <div className="flex gap-4" style={{ height: 'calc(100vh - 210px)' }}>
      {/* 左栏：部门列表（内部滚动，页面不随部门数变长） */}
      <div className="flex w-60 shrink-0 flex-col rounded-card border border-border bg-card shadow-card">
        <div className="border-b border-border p-3">
          <button
            onClick={() => {
              setShowCreate(true);
              setError('');
            }}
            className="w-full rounded-lg border border-dashed border-border px-3 py-2 text-sm text-ink-600 transition-colors hover:border-brand-500/50 hover:text-brand-700"
          >
            + 新建部门
          </button>
        </div>
        <div className="flex-1 overflow-y-auto p-2">
          {loading ? (
            <div className="space-y-2 p-1">
              {Array.from({ length: 3 }).map((_, i) => (
                <div key={i} className="skeleton h-10 rounded-lg" />
              ))}
            </div>
          ) : (
            items.map((d) => (
              <button
                key={d.id}
                onClick={() => setSelectedId(d.id)}
                className={`mb-1 flex w-full items-center justify-between rounded-lg px-3 py-2.5 text-left text-sm transition-colors ${
                  d.id === selectedId
                    ? 'bg-brand-600/10 font-medium text-brand-700'
                    : 'text-ink-600 hover:bg-subtle'
                }`}
              >
                <span className="truncate">{d.name}</span>
                <span className="ml-2 shrink-0 text-xs text-ink-400">{d.member_count} 人</span>
              </button>
            ))
          )}
          {!loading && items.length === 0 && (
            <p className="py-10 text-center text-xs text-ink-400">还没有部门，先创建一个</p>
          )}
        </div>
      </div>

      {/* 右栏：选中部门详情，成员区内部滚动 */}
      <div className="min-w-0 flex-1 overflow-y-auto">
        {detailLoading ? (
          <div className="space-y-3 rounded-card border border-border bg-card p-4 shadow-card">
            <div className="skeleton h-6 w-48 rounded" />
            <div className="skeleton h-32 rounded-lg" />
          </div>
        ) : detail ? (
          <DepartmentAdminCard
            dep={detail}
            allUsers={allUsers}
            onAction={async (fn) => {
              await fn();
              await reload();
            }}
            onDelete={() =>
              void api.delete(`/admin/departments/${detail.id}`).then(() => {
                setSelectedId(null);
                void load();
              })
            }
          />
        ) : (
          !loading && (
            <p className="rounded-card border border-dashed border-border py-16 text-center text-sm text-ink-400">
              选择左侧部门查看成员
            </p>
          )
        )}
      </div>

      {showCreate && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4"
          onClick={() => setShowCreate(false)}
        >
          <form
            onSubmit={create}
            onClick={(e) => e.stopPropagation()}
            className="w-full max-w-sm rounded-card border border-border bg-card p-5 shadow-pop"
          >
            <h2 className="mb-4 text-base font-semibold text-ink-900">新建部门</h2>
            <label className="mb-3 block">
              <span className="mb-1 block text-xs text-ink-400">部门名称</span>
              <input
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder="如：财务部"
                required
                autoFocus
                className={`${inputCls} w-full`}
              />
            </label>
            <label className="mb-4 block">
              <span className="mb-1 block text-xs text-ink-400">描述（可选）</span>
              <input
                value={description}
                onChange={(e) => setDescription(e.target.value)}
                placeholder="部门职责说明"
                className={`${inputCls} w-full`}
              />
            </label>
            {error && (
              <p className="mb-3 rounded-lg bg-red-500/10 px-3 py-2 text-sm text-red-600 dark:text-red-400">
                {error}
              </p>
            )}
            <div className="flex justify-end gap-2">
              <button
                type="button"
                onClick={() => setShowCreate(false)}
                className="rounded-lg border border-border px-4 py-2 text-sm text-ink-600 transition-colors hover:bg-subtle"
              >
                取消
              </button>
              <button
                type="submit"
                className="rounded-lg bg-brand-600 px-4 py-2 text-sm font-medium text-white shadow-sm transition-colors hover:bg-brand-700"
              >
                创建
              </button>
            </div>
          </form>
        </div>
      )}
    </div>
  );
}

/** 系统管理员的部门卡片：管理员/成员垂直列表，支持添加、移除、禁用、新建成员 */
function DepartmentAdminCard({
  dep,
  allUsers,
  onAction,
  onDelete,
}: {
  dep: DepartmentDetail;
  allUsers: AdminUser[];
  onAction: (fn: () => Promise<unknown>) => Promise<void>;
  onDelete: () => void;
}) {
  const adminCandidates = allUsers.filter((u) => !dep.admins.some((a) => a.id === u.id));
  const memberCandidates = allUsers.filter((u) => !dep.members.some((m) => m.id === u.id));
  const { confirm, confirmDialog } = useConfirm();
  const [editing, setEditing] = useState(false);
  const [editName, setEditName] = useState(dep.name);
  const [editDesc, setEditDesc] = useState(dep.description ?? '');
  const [editError, setEditError] = useState('');
  const [saving, setSaving] = useState(false);

  const saveEdit = async (e: FormEvent) => {
    e.preventDefault();
    setSaving(true);
    setEditError('');
    try {
      await api.patch(`/admin/departments/${dep.id}`, {
        name: editName,
        description: editDesc || undefined,
      });
      setEditing(false);
      await onAction(async () => {});
    } catch (err) {
      setEditError(err instanceof ApiError ? err.message : '保存失败');
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="rounded-card border border-border bg-card p-4 shadow-card">
      <div className="flex items-start justify-between">
        <div>
          <span className="text-sm font-medium text-ink-900">{dep.name}</span>
          <span className="ml-2 text-xs text-ink-400">
            {dep.admins.length} 名管理员 · {dep.members.length} 名成员
          </span>
          {dep.description && <div className="mt-0.5 text-xs text-ink-400">{dep.description}</div>}
        </div>
        <div className="flex shrink-0 items-center gap-1">
          <button
            onClick={() => {
              setEditing(true);
              setEditName(dep.name);
              setEditDesc(dep.description ?? '');
              setEditError('');
            }}
            className="rounded-lg p-1.5 text-ink-400 transition-colors hover:bg-subtle hover:text-brand-600"
            title="编辑部门"
          >
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <path d="M17 3a2.85 2.83 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5Z" />
            </svg>
          </button>
          <button
            onClick={async () => {
              const ok = await confirm({
                title: '删除部门',
                description: `删除「${dep.name}」后，其下空间将解除挂靠（空间与文档保留）。`,
              });
              if (ok) onDelete();
            }}
            className="rounded-lg p-1.5 text-ink-400 transition-colors hover:bg-red-500/10 hover:text-red-500"
            title="删除部门（空间将解除挂靠）"
          >
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <path d="M3 6h18M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2" />
            </svg>
          </button>
        </div>
      </div>

      <div className="mt-3 grid gap-4 border-t border-border pt-3 lg:grid-cols-2">
        <section>
          <div className="text-xs font-medium text-ink-600">部门管理员（{dep.admins.length}）</div>
          {/* 列表内部滚动：成员多时不拉长页面 */}
          <div className="mt-1 max-h-72 overflow-y-auto pr-1">
            <MemberList
              people={dep.admins}
              accent="brand"
              emptyText="暂无管理员"
              removeTitle="移除管理员"
              onRemove={async (uid) => {
                const a = dep.admins.find((x) => x.id === uid);
                const ok = await confirm({
                  title: '移除部门管理员',
                  description: `「${a?.name ?? uid}」将失去本部门的管理与审核权限。`,
                  confirmText: '确认移除',
                });
                if (ok) await onAction(() => api.delete(`/admin/departments/${dep.id}/admins/${uid}`));
              }}
            />
          </div>
          <AddPerson
            label="添加管理员"
            accent="brand"
            candidates={adminCandidates}
            onAdd={(uid) => onAction(() => api.put(`/admin/departments/${dep.id}/admins/${uid}`, {}))}
          />
        </section>
        <section>
          <div className="text-xs font-medium text-ink-600">部门成员（{dep.members.length}）</div>
          <div className="mt-1 max-h-72 overflow-y-auto pr-1">
            <MemberList
              people={dep.members}
              emptyText="暂无成员"
              removeTitle="移出部门"
              onToggleDisabled={async (uid, disabled) => {
                const m = dep.members.find((x) => x.id === uid);
                const ok = await confirm({
                  title: disabled ? '禁用成员' : '启用成员',
                  description: disabled
                    ? `禁用后「${m?.name ?? uid}」将无法登录系统。`
                    : `启用后「${m?.name ?? uid}」可正常登录系统。`,
                  confirmText: disabled ? '确认禁用' : '确认启用',
                });
                if (ok) await onAction(() => api.patch(`/departments/${dep.id}/members/${uid}/disabled`, { disabled }));
              }}
              onRemove={async (uid) => {
                const m = dep.members.find((x) => x.id === uid);
                const ok = await confirm({
                  title: '移出部门成员',
                  description: `将「${m?.name ?? uid}」移出本部门，其本部门空间的访问权限将失效。`,
                  confirmText: '确认移出',
                });
                if (ok) await onAction(() => api.delete(`/departments/${dep.id}/members/${uid}`));
              }}
            />
          </div>
          <AddPerson
            label="添加成员"
            candidates={memberCandidates}
            onAdd={(uid) => onAction(() => api.post(`/departments/${dep.id}/members`, { user_id: uid }))}
          />
          <CreateMember onCreate={(data) => onAction(() => api.post(`/departments/${dep.id}/members/create`, data))} />
        </section>
      </div>
      {editing && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4"
          onClick={() => setEditing(false)}
        >
          <form
            onSubmit={saveEdit}
            onClick={(e) => e.stopPropagation()}
            className="w-full max-w-sm rounded-card border border-border bg-card p-5 shadow-pop"
          >
            <h2 className="mb-4 text-base font-semibold text-ink-900">编辑部门</h2>
            <label className="mb-3 block">
              <span className="mb-1 block text-xs text-ink-400">部门名称</span>
              <input
                value={editName}
                onChange={(e) => setEditName(e.target.value)}
                required
                autoFocus
                className={`${inputCls} w-full`}
              />
            </label>
            <label className="mb-4 block">
              <span className="mb-1 block text-xs text-ink-400">描述</span>
              <input
                value={editDesc}
                onChange={(e) => setEditDesc(e.target.value)}
                placeholder="部门职责说明"
                className={`${inputCls} w-full`}
              />
            </label>
            {editError && (
              <p className="mb-3 rounded-lg bg-red-500/10 px-3 py-2 text-sm text-red-600 dark:text-red-400">
                {editError}
              </p>
            )}
            <div className="flex justify-end gap-2">
              <button
                type="button"
                onClick={() => setEditing(false)}
                className="rounded-lg border border-border px-4 py-2 text-sm text-ink-600 transition-colors hover:bg-subtle"
              >
                取消
              </button>
              <button
                type="submit"
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

/** 展开式下拉：从候选用户中添加 */
function AddPerson({
  label,
  candidates,
  onAdd,
  accent = 'emerald',
}: {
  label: string;
  candidates: MemberPerson[];
  onAdd: (userId: string) => Promise<void>;
  accent?: 'brand' | 'emerald';
}) {
  const [open, setOpen] = useState(false);
  const [selected, setSelected] = useState('');
  const btnCls =
    accent === 'brand'
      ? 'hover:border-brand-500/50 hover:text-brand-700'
      : 'hover:border-emerald-500/50 hover:text-emerald-700';
  const confirmCls = accent === 'brand' ? 'bg-brand-600 hover:bg-brand-700' : 'bg-emerald-600 hover:bg-emerald-700';

  if (!open) {
    return (
      <button
        onClick={() => setOpen(true)}
        className={`mt-2 rounded-lg border border-dashed border-border px-3 py-1.5 text-xs text-ink-600 transition-colors ${btnCls}`}
      >
        + {label}
      </button>
    );
  }
  return (
    <div className="mt-2 flex flex-wrap items-center gap-2">
      <select
        value={selected}
        onChange={(e) => setSelected(e.target.value)}
        className="rounded-lg border border-border bg-card px-2.5 py-1.5 text-xs text-ink-600 outline-none focus:border-brand-500"
      >
        <option value="">选择用户…</option>
        {candidates.map((c) => (
          <option key={c.id} value={c.id}>
            {c.name}（{c.email}）
          </option>
        ))}
      </select>
      <button
        disabled={!selected}
        onClick={() =>
          void onAdd(selected).then(() => {
            setOpen(false);
            setSelected('');
          })
        }
        className={`rounded-lg px-3 py-1.5 text-xs font-medium text-white transition-colors disabled:opacity-40 ${confirmCls}`}
      >
        添加
      </button>
      <button
        onClick={() => setOpen(false)}
        className="rounded-lg px-2 py-1.5 text-xs text-ink-400 transition-colors hover:bg-subtle"
      >
        取消
      </button>
    </div>
  );
}

/** 展开式表单：直接创建新成员账号并加入部门 */
function CreateMember({
  onCreate,
}: {
  onCreate: (data: { name: string; email: string; password: string }) => Promise<void>;
}) {
  const [open, setOpen] = useState(false);
  const [name, setName] = useState('');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  if (!open) {
    return (
      <button
        onClick={() => setOpen(true)}
        className="mt-2 ml-2 rounded-lg border border-dashed border-border px-3 py-1.5 text-xs text-ink-600 transition-colors hover:border-emerald-500/50 hover:text-emerald-700"
      >
        + 新建成员账号
      </button>
    );
  }

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError('');
    try {
      await onCreate({ name, email, password });
      setOpen(false);
      setName('');
      setEmail('');
      setPassword('');
    } catch (err) {
      setError(err instanceof ApiError ? err.message : '创建失败');
    } finally {
      setBusy(false);
    }
  };

  return (
    <form onSubmit={submit} className="mt-2 flex flex-wrap items-center gap-2">
      <input
        className="w-28 rounded-lg border border-border bg-card px-2.5 py-1.5 text-xs outline-none focus:border-emerald-500"
        placeholder="姓名"
        value={name}
        onChange={(e) => setName(e.target.value)}
        required
      />
      <input
        className="w-44 rounded-lg border border-border bg-card px-2.5 py-1.5 text-xs outline-none focus:border-emerald-500"
        placeholder="邮箱"
        type="email"
        value={email}
        onChange={(e) => setEmail(e.target.value)}
        required
      />
      <input
        className="w-32 rounded-lg border border-border bg-card px-2.5 py-1.5 text-xs outline-none focus:border-emerald-500"
        placeholder="初始密码（≥8位）"
        type="password"
        minLength={8}
        value={password}
        onChange={(e) => setPassword(e.target.value)}
        required
      />
      <button
        disabled={busy}
        className="rounded-lg bg-emerald-600 px-3 py-1.5 text-xs font-medium text-white transition-colors hover:bg-emerald-700 disabled:opacity-40"
      >
        创建并加入
      </button>
      <button
        type="button"
        onClick={() => setOpen(false)}
        className="rounded-lg px-2 py-1.5 text-xs text-ink-400 transition-colors hover:bg-subtle"
      >
        取消
      </button>
      {error && <span className="w-full text-xs text-red-500">{error}</span>}
    </form>
  );
}
