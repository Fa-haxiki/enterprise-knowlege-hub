import { ChangeEvent, DragEvent, useEffect, useRef, useState } from 'react';
import { useParams } from 'react-router-dom';
import { api, ApiError } from '@/lib/api';
import DocPreviewModal, { type DocPreview } from '@/components/DocPreviewModal';
import { useConfirm } from '@/components/ConfirmDialog';

interface DocumentItem {
  id: string;
  title: string;
  status: string;
  file_size: number;
  error_msg: string | null;
  review_note: string | null;
  created_at: string;
}

const STATUS_LABEL: Record<string, { label: string; className: string }> = {
  PENDING_REVIEW: { label: '待审核', className: 'bg-amber-500/10 text-amber-600 dark:text-amber-400' },
  REJECTED: { label: '已拒绝', className: 'bg-red-500/10 text-red-600 dark:text-red-400' },
  UPLOADED: { label: '待解析', className: 'bg-subtle text-ink-600' },
  PARSING: { label: '解析中', className: 'bg-blue-500/10 text-blue-600 dark:text-blue-400' },
  CHUNKING: { label: '分块中', className: 'bg-blue-500/10 text-blue-600 dark:text-blue-400' },
  INDEXING: { label: '索引中', className: 'bg-blue-500/10 text-blue-600 dark:text-blue-400' },
  GRAPHING: { label: '建图中', className: 'bg-violet-500/10 text-violet-600 dark:text-violet-400' },
  READY: { label: '可检索', className: 'bg-emerald-500/10 text-emerald-600 dark:text-emerald-400' },
  FAILED: { label: '失败', className: 'bg-red-500/10 text-red-600 dark:text-red-400' },
};

const PROCESSING = new Set(['UPLOADED', 'PARSING', 'CHUNKING', 'INDEXING', 'GRAPHING']);

const formatSize = (bytes: number) => {
  if (!Number.isFinite(bytes)) return '-';
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
};

export default function DocumentsPage() {
  const { workspaceId } = useParams<{ workspaceId: string }>();
  const [docs, setDocs] = useState<DocumentItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [progress, setProgress] = useState<Record<string, number>>({});
  const [uploading, setUploading] = useState(false);
  const [dragOver, setDragOver] = useState(false);
  const [error, setError] = useState('');
  const [preview, setPreview] = useState<DocPreview | null>(null);
  const { confirm, confirmDialog } = useConfirm();
  const fileInput = useRef<HTMLInputElement>(null);

  const openPreview = async (docId: string) => {
    try {
      const doc = await api.get<DocPreview>(`/documents/${docId}/download-url`);
      setPreview(doc);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : '获取预览失败');
    }
  };

  const load = async () => {
    if (!workspaceId) return;
    try {
      const data = await api.get<{ items: DocumentItem[] }>(
        `/workspaces/${workspaceId}/documents?page_size=100`,
      );
      setDocs(data.items);
    } catch {
      setDocs([]);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    void load();
  }, [workspaceId]);

  // 处理中文档的进度轮询
  useEffect(() => {
    const processing = docs.filter((d) => PROCESSING.has(d.status));
    if (processing.length === 0) return;
    const timer = setInterval(async () => {
      for (const doc of processing) {
        try {
          const p = await api.get<{ status: string; percent: number | null }>(
            `/documents/${doc.id}/progress`,
          );
          setProgress((prev) => ({ ...prev, [doc.id]: p.percent ?? 0 }));
          if (!PROCESSING.has(p.status)) await load();
        } catch {
          /* 忽略单次轮询失败 */
        }
      }
    }, 2000);
    return () => clearInterval(timer);
  }, [docs]);

  const doUpload = async (file: File) => {
    if (!workspaceId || uploading) return;
    setUploading(true);
    setError('');
    try {
      // 1. 初始化分片上传
      const init = await api.post<{
        document_id: string;
        upload_id: string;
        part_urls: string[];
      }>(`/workspaces/${workspaceId}/documents/upload-init`, {
        filename: file.name,
        file_size: file.size,
        mime_type: file.type || 'application/octet-stream',
      });

      // 2. 直传 MinIO
      const partSize = Math.ceil(file.size / init.part_urls.length);
      for (let i = 0; i < init.part_urls.length; i++) {
        const blob = file.slice(i * partSize, (i + 1) * partSize);
        const res = await fetch(init.part_urls[i], { method: 'PUT', body: blob });
        if (!res.ok) throw new Error(`分片 ${i + 1} 上传失败`);
      }

      // 3. 合并并触发入库
      await api.post(`/documents/${init.document_id}/upload-complete`, {
        upload_id: init.upload_id,
        part_count: init.part_urls.length,
      });
      await load();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : (err as Error).message);
    } finally {
      setUploading(false);
      if (fileInput.current) fileInput.current.value = '';
    }
  };

  const upload = async (e: ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (file) await doUpload(file);
  };

  const onDrop = async (e: DragEvent) => {
    e.preventDefault();
    setDragOver(false);
    const file = e.dataTransfer.files?.[0];
    if (file) await doUpload(file);
  };

  const remove = async (id: string) => {
    const ok = await confirm({
      title: '删除文档',
      description: '文档的分片、索引与图谱数据将被一并清理，此操作不可恢复。',
    });
    if (!ok) return;
    await api.delete(`/documents/${id}`);
    await load();
  };

  return (
    <div className="h-full overflow-y-auto p-6">
      <div className="mx-auto max-w-4xl">
        <div className="mb-5">
          <h1 className="text-lg font-semibold text-ink-900">文档管理</h1>
          <p className="mt-1 text-sm text-ink-400">上传后需部门审核员审核，通过后自动解析、分块、索引并构建知识图谱</p>
        </div>
        {error && (
          <p className="mb-4 rounded-lg bg-red-500/10 px-3 py-2 text-sm text-red-600 dark:text-red-400">
            {error}
          </p>
        )}

        {/* 拖拽上传区 */}
        <div
          onDragOver={(e) => {
            e.preventDefault();
            setDragOver(true);
          }}
          onDragLeave={() => setDragOver(false)}
          onDrop={onDrop}
          onClick={() => !uploading && fileInput.current?.click()}
          className={`mb-5 flex cursor-pointer flex-col items-center justify-center rounded-card border-2 border-dashed px-6 py-10 transition-all ${
            dragOver
              ? 'border-brand-500 bg-brand-600/5 scale-[1.01]'
              : 'border-border bg-card hover:border-brand-500/40 hover:bg-subtle/40'
          }`}
        >
          <input
            ref={fileInput}
            type="file"
            className="hidden"
            onChange={upload}
            accept=".pdf,.docx,.xlsx,.pptx,.md,.txt,.html"
          />
          <div
            className={`mb-3 flex h-11 w-11 items-center justify-center rounded-xl transition-colors ${
              dragOver ? 'bg-brand-600 text-white' : 'bg-brand-600/10 text-brand-600'
            }`}
          >
            <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
              <path d="m17 8-5-5-5 5" />
              <path d="M12 3v12" />
            </svg>
          </div>
          <p className="text-sm font-medium text-ink-900">
            {uploading ? '上传中，请稍候…' : dragOver ? '松开以上传文档' : '点击或拖拽文件到此处上传'}
          </p>
          <p className="mt-1 text-xs text-ink-400">支持 PDF / Word / Excel / PPT / Markdown / TXT</p>
        </div>

        {/* 文档列表 */}
        {loading ? (
          <div className="space-y-2.5">
            {Array.from({ length: 3 }).map((_, i) => (
              <div key={i} className="skeleton h-16 rounded-card" />
            ))}
          </div>
        ) : docs.length === 0 ? (
          <div className="rounded-card border border-dashed border-border py-14 text-center">
            <p className="text-sm text-ink-400">暂无文档，上传后自动解析入库</p>
          </div>
        ) : (
          <div className="space-y-2.5">
            {docs.map((doc) => {
              const st = STATUS_LABEL[doc.status] ?? STATUS_LABEL.UPLOADED;
              return (
                <div
                  key={doc.id}
                  className="group flex items-center gap-3 rounded-card border border-border bg-card px-4 py-3 shadow-card transition-colors hover:border-brand-500/30"
                >
                  <button
                    onClick={() => void openPreview(doc.id)}
                    className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-red-500/10 text-red-500 transition-transform group-hover:scale-105"
                    title="预览文档"
                  >
                    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                      <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8Z" />
                      <path d="M14 2v6h6" />
                    </svg>
                  </button>
                  <div className="min-w-0 flex-1 cursor-pointer" onClick={() => void openPreview(doc.id)}>
                    <div className="truncate text-sm font-medium text-ink-900 transition-colors group-hover:text-brand-700">{doc.title}</div>
                    <div className="mt-0.5 flex items-center gap-2 text-xs text-ink-400">
                      <span>{formatSize(doc.file_size)}</span>
                      {doc.error_msg && <span className="truncate text-red-500">{doc.error_msg}</span>}
                      {doc.status === 'REJECTED' && doc.review_note && (
                        <span className="truncate text-red-500">拒绝理由：{doc.review_note}</span>
                      )}
                    </div>
                    {PROCESSING.has(doc.status) && progress[doc.id] != null && (
                      <div className="mt-1.5 h-1 w-40 overflow-hidden rounded-full bg-subtle">
                        <div
                          className="h-full rounded-full bg-brand-500 transition-all duration-500"
                          style={{ width: `${progress[doc.id]}%` }}
                        />
                      </div>
                    )}
                  </div>
                  <span className={`shrink-0 rounded-full px-2.5 py-1 text-xs font-medium ${st.className}`}>
                    {st.label}
                  </span>
                  <button
                    onClick={() => remove(doc.id)}
                    className="shrink-0 rounded-lg p-1.5 text-ink-400 transition-colors hover:bg-red-500/10 hover:text-red-500"
                    title="删除文档"
                  >
                    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                      <path d="M3 6h18" />
                      <path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6" />
                      <path d="M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2" />
                    </svg>
                  </button>
                </div>
              );
            })}
          </div>
        )}

        {preview && <DocPreviewModal doc={preview} onClose={() => setPreview(null)} />}
        {confirmDialog}
      </div>
    </div>
  );
}
