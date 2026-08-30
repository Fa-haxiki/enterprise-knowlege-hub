import { useCallback, useEffect, useState } from 'react';
import { api } from '@/lib/api';
import DocPreviewModal, { type DocPreview } from '@/components/DocPreviewModal';

interface PendingDoc {
  id: string;
  title: string;
  mime_type: string;
  file_size: number;
  created_at: string;
  workspace: { id: string; name: string; department_id: string | null };
  uploader: { id: string; name: string; email: string };
}

function formatSize(bytes: number) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

export default function ReviewPage() {
  const [items, setItems] = useState<PendingDoc[]>([]);
  const [loading, setLoading] = useState(true);
  const [preview, setPreview] = useState<DocPreview | null>(null);
  const [rejectingId, setRejectingId] = useState<string | null>(null);
  const [reason, setReason] = useState('');
  const [acting, setActing] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const d = await api.get<{ items: PendingDoc[] }>('/documents/pending-review');
      setItems(d.items);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const openPreview = async (docId: string) => {
    const doc = await api.get<DocPreview>(`/documents/${docId}/download-url`);
    setPreview(doc);
  };

  const review = async (docId: string, approve: boolean, note?: string) => {
    setActing(true);
    try {
      await api.post(`/documents/${docId}/review`, { approve, reason: note });
      setRejectingId(null);
      setReason('');
      await load();
    } finally {
      setActing(false);
    }
  };

  return (
    <div className="h-full overflow-y-auto p-6">
      <div className="mx-auto max-w-4xl">
        <h1 className="text-lg font-semibold text-ink-900">文档审核</h1>
        <p className="mb-5 mt-1 text-sm text-ink-400">
          审核通过后文档才会解析入库；拒绝请填写理由，上传者可见
        </p>

        {loading ? (
          <div className="space-y-2.5">
            {Array.from({ length: 3 }).map((_, i) => (
              <div key={i} className="skeleton h-20 rounded-card" />
            ))}
          </div>
        ) : items.length === 0 ? (
          <div className="flex flex-col items-center justify-center rounded-card border border-dashed border-border py-16 text-ink-400">
            <svg width="36" height="36" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" className="mb-3 opacity-60">
              <path d="M9 12l2 2 4-4" /><circle cx="12" cy="12" r="10" />
            </svg>
            <p className="text-sm">没有待审核的文档</p>
          </div>
        ) : (
          <div className="space-y-2.5">
            {items.map((d) => (
              <div key={d.id} className="rounded-card border border-border bg-card p-4 shadow-card">
                <div className="flex items-center gap-3">
                  <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg bg-amber-500/10 text-amber-600">
                    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                      <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" /><path d="M14 2v6h6" />
                    </svg>
                  </div>
                  <div className="min-w-0 flex-1">
                    <div className="truncate text-sm font-medium text-ink-900">{d.title}</div>
                    <div className="mt-0.5 text-xs text-ink-400">
                      {d.workspace.name} · {d.uploader.name} 上传 · {formatSize(Number(d.file_size))} ·{' '}
                      {new Date(d.created_at).toLocaleString()}
                    </div>
                  </div>
                  <div className="flex shrink-0 items-center gap-1.5">
                    <button
                      onClick={() => void openPreview(d.id)}
                      className="rounded-lg border border-border px-2.5 py-1.5 text-xs text-ink-600 transition-colors hover:bg-subtle"
                    >
                      预览
                    </button>
                    <button
                      disabled={acting}
                      onClick={() => void review(d.id, true)}
                      className="rounded-lg bg-emerald-600 px-3 py-1.5 text-xs font-medium text-white transition-colors hover:bg-emerald-700 disabled:opacity-50"
                    >
                      通过
                    </button>
                    <button
                      disabled={acting}
                      onClick={() => setRejectingId(rejectingId === d.id ? null : d.id)}
                      className="rounded-lg border border-red-500/30 px-3 py-1.5 text-xs font-medium text-red-500 transition-colors hover:bg-red-500/10 disabled:opacity-50"
                    >
                      拒绝
                    </button>
                  </div>
                </div>

                {rejectingId === d.id && (
                  <div className="mt-3 flex items-center gap-2 border-t border-border pt-3">
                    <input
                      autoFocus
                      value={reason}
                      onChange={(e) => setReason(e.target.value)}
                      placeholder="拒绝理由（必填，上传者可见）"
                      className="flex-1 rounded-lg border border-border bg-card px-3 py-1.5 text-sm outline-none transition-colors placeholder:text-ink-400 focus:border-red-400"
                    />
                    <button
                      disabled={acting || !reason.trim()}
                      onClick={() => void review(d.id, false, reason.trim())}
                      className="rounded-lg bg-red-500 px-3 py-1.5 text-xs font-medium text-white transition-colors hover:bg-red-600 disabled:opacity-50"
                    >
                      确认拒绝
                    </button>
                  </div>
                )}
              </div>
            ))}
          </div>
        )}

        {preview && <DocPreviewModal doc={preview} onClose={() => setPreview(null)} />}
      </div>
    </div>
  );
}
