import { ChangeEvent, useEffect, useRef, useState } from 'react';
import { useParams } from 'react-router-dom';
import { api, ApiError } from '@/lib/api';
import { useAuthStore } from '@/store/auth';

interface DocumentItem {
  id: string;
  title: string;
  status: string;
  file_size: number;
  error_msg: string | null;
  created_at: string;
}

const STATUS_LABEL: Record<string, { label: string; className: string }> = {
  UPLOADED: { label: '待解析', className: 'bg-slate-100 text-slate-600' },
  PARSING: { label: '解析中', className: 'bg-blue-50 text-blue-600' },
  CHUNKING: { label: '分块中', className: 'bg-blue-50 text-blue-600' },
  INDEXING: { label: '索引中', className: 'bg-blue-50 text-blue-600' },
  GRAPHING: { label: '建图中', className: 'bg-blue-50 text-blue-600' },
  READY: { label: '可检索', className: 'bg-green-50 text-green-600' },
  FAILED: { label: '失败', className: 'bg-red-50 text-red-600' },
};

const PROCESSING = new Set(['UPLOADED', 'PARSING', 'CHUNKING', 'INDEXING', 'GRAPHING']);

export default function DocumentsPage() {
  const { workspaceId } = useParams<{ workspaceId: string }>();
  const [docs, setDocs] = useState<DocumentItem[]>([]);
  const [progress, setProgress] = useState<Record<string, number>>({});
  const [uploading, setUploading] = useState(false);
  const [error, setError] = useState('');
  const fileInput = useRef<HTMLInputElement>(null);
  const accessToken = useAuthStore((s) => s.accessToken);

  const load = async () => {
    if (!workspaceId) return;
    try {
      const data = await api.get<{ items: DocumentItem[] }>(
        `/workspaces/${workspaceId}/documents?page_size=100`,
      );
      setDocs(data.items);
    } catch {
      setDocs([]);
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

  const upload = async (e: ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file || !workspaceId) return;
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

  const remove = async (id: string) => {
    if (!confirm('确认删除该文档？其分片、索引与图谱数据将被清理。')) return;
    await api.delete(`/documents/${id}`);
    await load();
  };

  return (
    <div className="h-full overflow-y-auto p-6">
      <div className="mx-auto max-w-4xl">
        <div className="mb-4 flex items-center justify-between">
          <h1 className="text-lg font-semibold">文档管理</h1>
          <div>
            <input ref={fileInput} type="file" className="hidden" onChange={upload}
              accept=".pdf,.docx,.xlsx,.pptx,.md,.txt,.html" />
            <button
              onClick={() => fileInput.current?.click()}
              disabled={uploading}
              className="rounded-md bg-slate-900 px-4 py-2 text-sm text-white hover:bg-slate-800 disabled:opacity-50"
            >
              {uploading ? '上传中…' : '上传文档'}
            </button>
          </div>
        </div>
        {error && <p className="mb-4 text-sm text-red-600">{error}</p>}

        <div className="overflow-hidden rounded-lg border border-slate-200 bg-white">
          <table className="w-full text-sm">
            <thead className="bg-slate-50 text-left text-xs text-slate-500">
              <tr>
                <th className="px-4 py-3">文档</th>
                <th className="w-28 px-4 py-3">大小</th>
                <th className="w-40 px-4 py-3">状态</th>
                <th className="w-24 px-4 py-3"></th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {docs.map((doc) => {
                const st = STATUS_LABEL[doc.status] ?? STATUS_LABEL.UPLOADED;
                return (
                  <tr key={doc.id}>
                    <td className="px-4 py-3">
                      <div className="font-medium">{doc.title}</div>
                      {doc.error_msg && (
                        <div className="mt-0.5 text-xs text-red-500">{doc.error_msg}</div>
                      )}
                    </td>
                    <td className="px-4 py-3 text-slate-500">
                      {(doc.file_size / 1024 / 1024).toFixed(1)} MB
                    </td>
                    <td className="px-4 py-3">
                      <span className={`rounded-full px-2.5 py-1 text-xs ${st.className}`}>
                        {st.label}
                      </span>
                      {PROCESSING.has(doc.status) && progress[doc.id] != null && (
                        <div className="mt-1.5 h-1 w-28 overflow-hidden rounded bg-slate-100">
                          <div
                            className="h-full bg-blue-500 transition-all"
                            style={{ width: `${progress[doc.id]}%` }}
                          />
                        </div>
                      )}
                    </td>
                    <td className="px-4 py-3 text-right">
                      <button
                        onClick={() => remove(doc.id)}
                        className="text-xs text-slate-400 hover:text-red-600"
                      >
                        删除
                      </button>
                    </td>
                  </tr>
                );
              })}
              {docs.length === 0 && (
                <tr>
                  <td colSpan={4} className="py-12 text-center text-slate-400">
                    暂无文档，上传后自动解析入库
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}
