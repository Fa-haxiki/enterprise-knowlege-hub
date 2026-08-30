import { useEffect } from 'react';
import { createPortal } from 'react-dom';

export interface DocPreview {
  url: string;
  previewable: boolean;
  title: string;
}

/** 文档预览弹窗：可预览类型 iframe 内嵌，其余提供下载 */
export default function DocPreviewModal({ doc, onClose }: { doc: DocPreview; onClose: () => void }) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  return createPortal(
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-6 backdrop-blur-sm animate-fadeUp"
      onClick={onClose}
    >
      <div
        className="flex h-full max-h-[86vh] w-full max-w-4xl flex-col rounded-card bg-card shadow-pop"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between border-b border-border px-4 py-3">
          <div className="flex min-w-0 items-center gap-2">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="shrink-0 text-brand-600">
              <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" /><path d="M14 2v6h6" />
            </svg>
            <span className="truncate text-sm font-medium text-ink-900">{doc.title}</span>
          </div>
          <div className="flex shrink-0 items-center gap-1">
            <a
              href={doc.url}
              target="_blank"
              rel="noopener"
              className="flex items-center gap-1 rounded-lg px-2 py-1 text-xs text-ink-600 transition-colors hover:bg-subtle"
            >
              <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4M7 10l5 5 5-5M12 15V3" />
              </svg>
              下载
            </a>
            <button onClick={onClose} className="rounded-lg p-1.5 text-ink-400 transition-colors hover:bg-subtle hover:text-ink-600">
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round"><path d="M18 6 6 18M6 6l12 12" /></svg>
            </button>
          </div>
        </div>
        {doc.previewable ? (
          <iframe src={doc.url} title={doc.title} className="min-h-0 flex-1 rounded-b-card bg-white" />
        ) : (
          <div className="flex flex-1 flex-col items-center justify-center gap-3 text-ink-400">
            <svg width="40" height="40" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
              <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" /><path d="M14 2v6h6" />
            </svg>
            <p className="text-sm">该格式不支持在线预览</p>
            <a
              href={doc.url}
              target="_blank"
              rel="noopener"
              className="rounded-lg bg-brand-600 px-4 py-2 text-sm font-medium text-white transition-colors hover:bg-brand-700"
            >
              下载文档
            </a>
          </div>
        )}
      </div>
    </div>,
    document.body,
  );
}
