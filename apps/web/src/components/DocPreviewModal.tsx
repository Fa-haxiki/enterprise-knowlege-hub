import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import DocTypeIcon from '@/components/DocTypeIcon';

export interface DocPreview {
  url: string;
  previewable: boolean;
  title: string;
}

const MIN_W = 480;
const MIN_H = 320;

/** 文档预览弹窗：可预览类型 iframe 内嵌，其余提供下载；支持最大化与拖拽调整大小 */
export default function DocPreviewModal({ doc, onClose }: { doc: DocPreview; onClose: () => void }) {
  const boxRef = useRef<HTMLDivElement>(null);
  const [maximized, setMaximized] = useState(false);
  /** 自定义尺寸（拖拽产生）；null 表示默认尺寸 */
  const [size, setSize] = useState<{ w: number; h: number } | null>(null);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  /** 右下角拖拽调整：弹窗居中，鼠标位移按 2 倍反映到宽高；上限为浏览器窗口 */
  const onHandleDown = (e: React.MouseEvent) => {
    e.preventDefault();
    const rect = boxRef.current?.getBoundingClientRect();
    if (!rect) return;
    const startX = e.clientX;
    const startY = e.clientY;
    const startW = rect.width;
    const startH = rect.height;
    const onMove = (ev: MouseEvent) => {
      setSize({
        w: Math.min(window.innerWidth, Math.max(MIN_W, startW + (ev.clientX - startX) * 2)),
        h: Math.min(window.innerHeight, Math.max(MIN_H, startH + (ev.clientY - startY) * 2)),
      });
    };
    const onUp = () => {
      document.removeEventListener('mousemove', onMove);
      document.removeEventListener('mouseup', onUp);
    };
    document.addEventListener('mousemove', onMove);
    document.addEventListener('mouseup', onUp);
  };

  return createPortal(
    <div
      className={`fixed inset-0 z-50 flex items-center justify-center bg-black/50 backdrop-blur-sm animate-fadeUp ${maximized ? '' : 'p-6'}`}
      onClick={onClose}
    >
      <div
        ref={boxRef}
        className={`relative flex flex-col bg-card shadow-pop ${
          maximized
            ? 'h-full w-full'
            : 'h-full max-h-[86vh] w-full max-w-4xl rounded-card'
        }`}
        style={maximized ? undefined : size ? { width: size.w, height: size.h, maxWidth: 'none', maxHeight: 'none' } : undefined}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between border-b border-border px-4 py-3">
          <div className="flex min-w-0 items-center gap-2">
            <DocTypeIcon title={doc.title} size={16} className="shrink-0" />
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
            <button
              onClick={() => setMaximized((v) => !v)}
              className="rounded-lg p-1.5 text-ink-400 transition-colors hover:bg-subtle hover:text-ink-600"
              title={maximized ? '还原' : '最大化'}
            >
              {maximized ? (
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M8 3v3a2 2 0 0 1-2 2H3m18 0h-3a2 2 0 0 1-2-2V3m0 18v-3a2 2 0 0 1 2-2h3M3 16h3a2 2 0 0 1 2 2v3" />
                </svg>
              ) : (
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M8 3H5a2 2 0 0 0-2 2v3m18 0V5a2 2 0 0 0-2-2h-3m0 18h3a2 2 0 0 0 2-2v-3M3 16v3a2 2 0 0 0 2 2h3" />
                </svg>
              )}
            </button>
            <button onClick={onClose} className="rounded-lg p-1.5 text-ink-400 transition-colors hover:bg-subtle hover:text-ink-600" title="关闭">
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round"><path d="M18 6 6 18M6 6l12 12" /></svg>
            </button>
          </div>
        </div>
        {doc.previewable ? (
          <iframe src={doc.url} title={doc.title} className={`min-h-0 flex-1 bg-white ${maximized ? '' : 'rounded-b-card'}`} />
        ) : (
          <div className="flex flex-1 flex-col items-center justify-center gap-3 text-ink-400">
            <DocTypeIcon title={doc.title} size={48} />
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
        {/* 右下角拖拽手柄：调整弹窗大小（最大化时隐藏） */}
        {!maximized && (
          <div
            onMouseDown={onHandleDown}
            className="absolute bottom-1 right-1 cursor-nwse-resize rounded p-1 text-ink-300 transition-colors hover:text-ink-500"
            title="拖拽调整大小"
          >
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
              <path d="M21 15l-6 6M21 9l-12 12" />
            </svg>
          </div>
        )}
      </div>
    </div>,
    document.body,
  );
}
