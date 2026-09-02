export interface MemberPerson {
  id: string;
  name: string;
  email: string;
  disabled?: boolean;
  /** 是否为部门管理员（合并列表时用于显示徽章与「设为/取消管理员」按钮） */
  isAdmin?: boolean;
}

interface Props {
  people: MemberPerson[];
  /** 传了才显示禁用/启用按钮 */
  onToggleDisabled?: (id: string, disabled: boolean) => void;
  /** 传了才显示移除按钮 */
  onRemove?: (id: string) => void;
  /** 传了才显示「设为/取消管理员」按钮（依 isAdmin 切换文案） */
  onToggleAdmin?: (id: string, makeAdmin: boolean) => void;
  removeTitle?: string;
  emptyText?: string;
  accent?: 'brand' | 'emerald';
}

/** 人员垂直列表：头像 + 姓名/邮箱 + 徽章 + 操作按钮，部门成员/管理员展示共用 */
export default function MemberList({
  people,
  onToggleDisabled,
  onRemove,
  onToggleAdmin,
  removeTitle = '移除',
  emptyText = '暂无成员',
  accent = 'emerald',
}: Props) {
  const avatarCls =
    accent === 'brand' ? 'bg-brand-600/10 text-brand-700' : 'bg-emerald-600/10 text-emerald-700';
  return (
    <ul className="divide-y divide-border">
      {people.length === 0 && <li className="py-4 text-center text-xs text-ink-400">{emptyText}</li>}
      {people.map((m) => (
        <li key={m.id} className={`flex items-center gap-3 py-2.5 ${m.disabled ? 'opacity-50' : ''}`}>
          <span
            className={`flex h-8 w-8 shrink-0 items-center justify-center rounded-full text-xs font-medium ${
              m.disabled ? 'bg-subtle text-ink-400' : avatarCls
            }`}
          >
            {m.name[0]}
          </span>
          <div className="min-w-0 flex-1">
            <div className="flex items-center gap-2">
              <span className="truncate text-sm text-ink-900">{m.name}</span>
              {m.isAdmin && (
                <span className="shrink-0 rounded-full bg-brand-600/10 px-2 py-0.5 text-xs font-medium text-brand-600">
                  管理员
                </span>
              )}
              {m.disabled && (
                <span className="shrink-0 rounded-full bg-red-500/10 px-2 py-0.5 text-xs font-medium text-red-600">
                  已禁用
                </span>
              )}
            </div>
            <div className="truncate text-xs text-ink-400">{m.email}</div>
          </div>
          {onToggleAdmin && (
            <button
              onClick={() => onToggleAdmin(m.id, !m.isAdmin)}
              className={`shrink-0 rounded-lg border px-2.5 py-1 text-xs transition-colors ${
                m.isAdmin
                  ? 'border-ink-500/30 text-ink-500 hover:bg-subtle'
                  : 'border-brand-500/30 text-brand-600 hover:bg-brand-500/10'
              }`}
            >
              {m.isAdmin ? '取消管理员' : '设为管理员'}
            </button>
          )}
          {onToggleDisabled && (
            <button
              onClick={() => onToggleDisabled(m.id, !m.disabled)}
              className={`shrink-0 rounded-lg border px-2.5 py-1 text-xs transition-colors ${
                m.disabled
                  ? 'border-emerald-500/30 text-emerald-600 hover:bg-emerald-500/10'
                  : 'border-amber-500/30 text-amber-600 hover:bg-amber-500/10'
              }`}
            >
              {m.disabled ? '启用' : '禁用'}
            </button>
          )}
          {onRemove && (
            <button
              onClick={() => onRemove(m.id)}
              className="shrink-0 rounded-lg p-1.5 text-ink-400 transition-colors hover:bg-red-500/10 hover:text-red-500"
              title={removeTitle}
            >
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <path d="M3 6h18" />
                <path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6" />
                <path d="M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2" />
              </svg>
            </button>
          )}
        </li>
      ))}
    </ul>
  );
}
