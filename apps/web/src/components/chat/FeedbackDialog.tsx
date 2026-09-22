import { useEffect, useState } from 'react';
import { createPortal } from 'react-dom';

const MAX_LEN = 1000;

interface Props {
  value: 1 | -1;
  initialComment?: string;
  onCancel(): void;
  onSubmit(comment: string): void;
}

/** 赞/踩后的选填说明，提交到 /messages/:id/feedback 的 comment */
export default function FeedbackDialog({ value, initialComment, onCancel, onSubmit }: Props) {
  const [comment, setComment] = useState(initialComment ?? '');
  const up = value === 1;

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onCancel();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onCancel]);

  return createPortal(
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-6 backdrop-blur-sm animate-fadeUp"
      onClick={onCancel}
    >
      <div
        className="w-full max-w-sm rounded-card bg-card p-5 shadow-pop"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="text-sm font-medium text-ink-900">{up ? '这条回答有用' : '这条回答没用'}</div>
        <p className="mt-1 text-xs leading-relaxed text-ink-400">
          {up ? '可以写一句哪里帮到了你，选填。' : '可以说一下哪里不对或还缺什么，选填。'}
        </p>
        <textarea
          autoFocus
          value={comment}
          maxLength={MAX_LEN}
          rows={4}
          placeholder={up ? '例如：引用准确、结论清楚…' : '例如：事实有误、漏了关键条款…'}
          onChange={(e) => setComment(e.target.value)}
          className="mt-3 w-full resize-none rounded-lg border border-border bg-subtle/40 px-3 py-2 text-sm leading-6 text-ink-900 outline-none transition-colors placeholder:text-ink-400 focus:border-brand-500"
        />
        <div className="mt-1 text-right text-[11px] text-ink-400">
          {comment.length}/{MAX_LEN}
        </div>
        <div className="mt-3 flex justify-end gap-2">
          <button
            type="button"
            onClick={onCancel}
            className="rounded-lg border border-border px-3.5 py-1.5 text-sm text-ink-600 transition-colors hover:bg-subtle"
          >
            取消
          </button>
          <button
            type="button"
            onClick={() => onSubmit(comment.trim())}
            className={`rounded-lg px-3.5 py-1.5 text-sm font-medium text-white transition-colors ${
              up ? 'bg-emerald-600 hover:bg-emerald-700' : 'bg-brand-600 hover:bg-brand-700'
            }`}
          >
            提交
          </button>
        </div>
      </div>
    </div>,
    document.body,
  );
}
