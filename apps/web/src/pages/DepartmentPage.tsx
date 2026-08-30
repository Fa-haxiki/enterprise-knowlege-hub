import { FormEvent, useCallback, useEffect, useState } from 'react';
import { api, ApiError } from '@/lib/api';
import MemberList, { type MemberPerson } from '@/components/MemberList';
import { useConfirm } from '@/components/ConfirmDialog';

type Person = MemberPerson;

interface Member extends Person {
  status: string;
  disabled: boolean;
}

interface ManagedDepartment {
  id: string;
  name: string;
  description: string | null;
  members: Member[];
}

/** 部门管理员视角：管理我负责的部门成员（审核入口在"文档审核"页） */
export default function DepartmentPage() {
  const [items, setItems] = useState<ManagedDepartment[]>([]);
  const [candidates, setCandidates] = useState<Record<string, Person[]>>({});
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const d = await api.get<{ items: ManagedDepartment[] }>('/departments/mine');
      setItems(d.items);
      const entries = await Promise.all(
        d.items.map(async (dep) => {
          const c = await api.get<{ items: Person[] }>(`/departments/${dep.id}/candidates`);
          return [dep.id, c.items] as const;
        }),
      );
      setCandidates(Object.fromEntries(entries));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const run = async (fn: () => Promise<unknown>) => {
    setError('');
    try {
      await fn();
      await load();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : '操作失败');
    }
  };

  return (
    <div className="h-full overflow-y-auto p-6">
      <div className="mx-auto max-w-4xl">
        <h1 className="text-lg font-semibold text-ink-900">我的部门</h1>
        <p className="mb-5 mt-1 text-sm text-ink-400">
          管理部门成员；部门下空间上传的文档在"文档审核"页处理
        </p>

        {error && (
          <div className="mb-4 rounded-lg border border-red-500/30 bg-red-500/10 px-3 py-2 text-sm text-red-600">
            {error}
          </div>
        )}

        {loading ? (
          <div className="space-y-3">
            {Array.from({ length: 2 }).map((_, i) => (
              <div key={i} className="skeleton h-40 rounded-card" />
            ))}
          </div>
        ) : items.length === 0 ? (
          <div className="rounded-card border border-dashed border-border py-16 text-center">
            <p className="text-sm text-ink-400">您还不是任何部门的管理员</p>
          </div>
        ) : (
          <div className="space-y-4">
            {items.map((d) => (
              <DepartmentCard
                key={d.id}
                dep={d}
                candidates={candidates[d.id] ?? []}
                onAction={run}
              />
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

function DepartmentCard({
  dep,
  candidates,
  onAction,
}: {
  dep: ManagedDepartment;
  candidates: Person[];
  onAction: (fn: () => Promise<unknown>) => Promise<void>;
}) {
  const [picking, setPicking] = useState(false);
  const [creating, setCreating] = useState(false);
  const [selected, setSelected] = useState('');
  const { confirm, confirmDialog } = useConfirm();

  const addExisting = () => {
    if (!selected) return;
    void onAction(() => api.post(`/departments/${dep.id}/members`, { user_id: selected })).then(() => {
      setPicking(false);
      setSelected('');
    });
  };

  return (
    <div className="rounded-card border border-border bg-card p-4 shadow-card">
      <div className="flex items-center justify-between">
        <div>
          <span className="text-sm font-medium text-ink-900">{dep.name}</span>
          <span className="ml-2 text-xs text-ink-400">{dep.members.length} 名成员</span>
        </div>
      </div>
      {dep.description && <div className="mt-0.5 text-xs text-ink-400">{dep.description}</div>}

      <div className="mt-3 border-t border-border">
        <MemberList
          people={dep.members}
          emptyText="暂无成员，从下方添加"
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
          removeTitle="移出部门"
        />
      </div>
      {confirmDialog}

      <div className="mt-3 flex flex-wrap items-center gap-2 border-t border-border pt-3">
        {!picking && !creating && (
          <>
            <button
              onClick={() => setPicking(true)}
              className="rounded-lg border border-dashed border-border px-3 py-1.5 text-xs text-ink-600 transition-colors hover:border-emerald-500/50 hover:text-emerald-700"
            >
              + 添加已有用户
            </button>
            <button
              onClick={() => setCreating(true)}
              className="rounded-lg border border-dashed border-border px-3 py-1.5 text-xs text-ink-600 transition-colors hover:border-emerald-500/50 hover:text-emerald-700"
            >
              + 新建成员账号
            </button>
          </>
        )}
        {picking && (
          <div className="flex flex-wrap items-center gap-2">
            <select
              value={selected}
              onChange={(e) => setSelected(e.target.value)}
              className="rounded-lg border border-border bg-card px-2.5 py-1.5 text-xs text-ink-600 outline-none focus:border-emerald-500"
            >
              <option value="">选择用户…</option>
              {candidates.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.name}（{c.email}）
                </option>
              ))}
            </select>
            <button
              onClick={addExisting}
              disabled={!selected}
              className="rounded-lg bg-emerald-600 px-3 py-1.5 text-xs font-medium text-white transition-colors hover:bg-emerald-700 disabled:opacity-40"
            >
              添加
            </button>
            <button
              onClick={() => setPicking(false)}
              className="rounded-lg px-2 py-1.5 text-xs text-ink-400 transition-colors hover:bg-subtle"
            >
              取消
            </button>
          </div>
        )}
        {creating && (
          <CreateMemberForm
            onSubmit={(data) =>
              onAction(() => api.post(`/departments/${dep.id}/members/create`, data)).then(() => setCreating(false))
            }
            onCancel={() => setCreating(false)}
          />
        )}
      </div>
    </div>
  );
}

function CreateMemberForm({
  onSubmit,
  onCancel,
}: {
  onSubmit: (data: { name: string; email: string; password: string }) => Promise<void>;
  onCancel: () => void;
}) {
  const [name, setName] = useState('');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError('');
    try {
      await onSubmit({ name, email, password });
    } catch (err) {
      setError(err instanceof ApiError ? err.message : '创建失败');
    } finally {
      setBusy(false);
    }
  };

  return (
    <form onSubmit={submit} className="flex w-full flex-wrap items-center gap-2">
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
        onClick={onCancel}
        className="rounded-lg px-2 py-1.5 text-xs text-ink-400 transition-colors hover:bg-subtle"
      >
        取消
      </button>
      {error && <span className="w-full text-xs text-red-500">{error}</span>}
    </form>
  );
}
