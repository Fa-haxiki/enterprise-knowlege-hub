import { useCallback, useEffect, useState } from 'react';
import { createPortal } from 'react-dom';

export interface ConfirmOptions {
  title: string;
  description?: string;
  confirmText?: string;
}

interface ConfirmState extends ConfirmOptions {
  resolve: (v: boolean) => void;
}

/**
 * 破坏性操作二次确认。
 * 用法：const { confirm, confirmDialog } = useConfirm();
 *   if (await confirm({ title: '删除文档', description: '...' })) { ... }
 *   渲染时挂载 {confirmDialog}
 */
export function useConfirm() {
  const [state, setState] = useState<ConfirmState | null>(null);

  const confirm = useCallback(
    (opts: ConfirmOptions) =>
      new Promise<boolean>((resolve) => {
        setState({ ...opts, resolve });
      }),
    [],
  );

  const close = useCallback(
    (v: boolean) => {
      state?.resolve(v);
      setState(null);
    },
    [state],
  );

  useEffect(() => {
    if (!state) return;
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && close(false);
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [state, close]);

  const confirmDialog = state
    ? createPortal(
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-6 backdrop-blur-sm animate-fadeUp"
          onClick={() => close(false)}
        >
          <div
            className="w-full max-w-sm rounded-card bg-card p-5 shadow-pop"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="flex items-start gap-3">
              <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-red-500/10 text-red-500">
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M12 9v4M12 17h.01" />
                  <path d="M10.3 3.9 1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0Z" />
                </svg>
              </div>
              <div className="min-w-0 flex-1">
                <div className="text-sm font-medium text-ink-900">{state.title}</div>
                {state.description && <div className="mt-1 text-xs leading-relaxed text-ink-400">{state.description}</div>}
              </div>
            </div>
            <div className="mt-4 flex justify-end gap-2">
              <button
                onClick={() => close(false)}
                className="rounded-lg border border-border px-3.5 py-1.5 text-sm text-ink-600 transition-colors hover:bg-subtle"
              >
                取消
              </button>
              <button
                autoFocus
                onClick={() => close(true)}
                className="rounded-lg bg-red-500 px-3.5 py-1.5 text-sm font-medium text-white transition-colors hover:bg-red-600"
              >
                {state.confirmText ?? '确认删除'}
              </button>
            </div>
          </div>
        </div>,
        document.body,
      )
    : null;

  return { confirm, confirmDialog };
}
