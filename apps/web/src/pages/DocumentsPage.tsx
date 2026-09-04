import { ChangeEvent, DragEvent, useCallback, useEffect, useRef, useState } from 'react';
import { Link, useParams, useSearchParams } from 'react-router-dom';
import { sha256 } from 'js-sha256';
import { api, ApiError } from '@/lib/api';
import { notifyPendingReviewChanged, PENDING_REVIEW_CHANGED } from '@/lib/events';
import DocPreviewModal, { type DocPreview } from '@/components/DocPreviewModal';
import DocTypeIcon from '@/components/DocTypeIcon';
import Pagination from '@/components/Pagination';
import { useConfirm } from '@/components/ConfirmDialog';
import { useAuthStore } from '@/store/auth';

interface DocumentItem {
  id: string;
  title: string;
  status: string;
  file_size: number;
  error_msg: string | null;
  review_note: string | null;
  uploader: { id: string; name: string } | null;
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
const PAGE_SIZE = 10;

const formatSize = (bytes: number) => {
  if (!Number.isFinite(bytes)) return '-';
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
};

export default function DocumentsPage() {
  const { workspaceId } = useParams<{ workspaceId: string }>();
  const [searchParams, setSearchParams] = useSearchParams();
  const user = useAuthStore((s) => s.user);
  const [docs, setDocs] = useState<DocumentItem[]>([]);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(1);
  const [wsRole, setWsRole] = useState<string | null>(null);
  const [wsName, setWsName] = useState('');
  /** 审核入口并入空间：canReview 决定「待审核」Tab 是否可见，pendingCount 为角标 */
  const [canReview, setCanReview] = useState(false);
  const [pendingCount, setPendingCount] = useState(0);
  const [tab, setTab] = useState<'all' | 'review'>(searchParams.get('tab') === 'review' ? 'review' : 'all');
  const [loading, setLoading] = useState(true);
  /** 翻页中：保留当前列表半透明过渡，不闪骨架屏 */
  const [paging, setPaging] = useState(false);
  /** 待审核 Tab 的批量选择与驳回状态 */
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [rejectingId, setRejectingId] = useState<string | null>(null);
  const [reason, setReason] = useState('');
  const [acting, setActing] = useState(false);
  const [batchRejecting, setBatchRejecting] = useState(false);
  const [notice, setNotice] = useState('');
  /** 筛选条件：keyword 为输入框即时值，其余为下拉/日期 */
  const [keyword, setKeyword] = useState('');
  const [status, setStatus] = useState('');
  const [docType, setDocType] = useState('');
  const [dateFrom, setDateFrom] = useState('');
  const [dateTo, setDateTo] = useState('');
  const [progress, setProgress] = useState<Record<string, number>>({});
  const [uploading, setUploading] = useState(false);
  const [retrying, setRetrying] = useState<string | null>(null);
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

  const load = useCallback(
    async (p = page, silent = false) => {
      if (!workspaceId) return;
      // silent：进度轮询等后台刷新不闪骨架屏；Tab 切换/筛选/翻页需立即进入 loading，避免残留旧列表
      if (!silent) setLoading(true);
      try {
        const q = new URLSearchParams({ page: String(p), page_size: String(PAGE_SIZE) });
        if (keyword.trim()) q.set('keyword', keyword.trim());
        // 待审核 Tab 固定状态过滤；全部文档 Tab 走用户自选筛选
        if (tab === 'review') q.set('status', 'PENDING_REVIEW');
        else if (status) q.set('status', status);
        if (docType) q.set('type', docType);
        if (dateFrom) q.set('date_from', dateFrom);
        if (dateTo) q.set('date_to', dateTo);
        const data = await api.get<{ items: DocumentItem[]; total: number }>(
          `/workspaces/${workspaceId}/documents?${q}`,
        );
        setDocs(data.items);
        setTotal(data.total);
        // 删除当前页最后一条时回退一页，避免停在空页
        if (data.items.length === 0 && data.total > 0 && p > 1) {
          setPage(p - 1);
          await load(p - 1);
        }
      } catch {
        // 失败时清空总数：否则空列表会配着上一个 Tab/筛选的旧页码导航
        setDocs([]);
        setTotal(0);
      } finally {
        setLoading(false);
      }
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [workspaceId, page, keyword, status, docType, dateFrom, dateTo, tab],
  );

  const goPage = (p: number) => {
    setPage(p);
    setPaging(true);
    void load(p, true).finally(() => setPaging(false));
  };

  // 筛选条件变化：回到第 1 页并重新加载（搜索框 300ms 防抖）
  const firstMount = useRef(true);
  useEffect(() => {
    if (firstMount.current) {
      firstMount.current = false;
      return;
    }
    const timer = setTimeout(() => {
      setPage(1);
      void load(1);
    }, 300);
    return () => clearTimeout(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [keyword, status, docType, dateFrom, dateTo]);

  /** 刷新空间元信息（角色/审核权限/待审数），审核操作后同步角标 */
  const refreshMeta = useCallback(() => {
    if (!workspaceId) return;
    interface WsMeta { id: string; name: string; role: string; can_review?: boolean; pending_count?: number }
    return api
      .get<WsMeta[]>('/workspaces')
      .then((list) => {
        const ws = list.find((w) => w.id === workspaceId);
        setWsRole(ws?.role ?? null);
        setWsName(ws?.name ?? '');
        setCanReview(!!ws?.can_review);
        setPendingCount(ws?.pending_count ?? 0);
      })
      .catch(() => setWsRole(null));
  }, [workspaceId]);

  useEffect(() => {
    setPage(1);
    void load(1);
    // 当前用户在空间内的角色：viewer 隐藏上传/删除/重试等操作入口
    void refreshMeta();
  }, [workspaceId]);

  // 上传/审核/删除都会改变待审数：监听事件刷新 Tab 角标（事件由本页或其他页面派发）
  useEffect(() => {
    const onChanged = () => void refreshMeta();
    window.addEventListener(PENDING_REVIEW_CHANGED, onChanged);
    return () => window.removeEventListener(PENDING_REVIEW_CHANGED, onChanged);
  }, [refreshMeta]);

  // 从空间卡片「待审 N」角标进入时 URL 带 ?tab=review，同步到 Tab 状态
  useEffect(() => {
    if (searchParams.get('tab') === 'review') setTab('review');
  }, [searchParams]);

  const switchTab = (next: 'all' | 'review') => {
    if (next === tab) return;
    setTab(next);
    setPage(1);
    // 立即清空旧 Tab 的列表/总数并进入 loading，否则会先闪一下旧列表与旧页码导航
    setDocs([]);
    setTotal(0);
    setLoading(true);
    setSelected(new Set());
    setRejectingId(null);
    setBatchRejecting(false);
    setNotice('');
    setSearchParams(next === 'review' ? { tab: 'review' } : {}, { replace: true });
  };

  // Tab 切换后重新拉列表
  useEffect(() => {
    void load(1);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tab]);

  const canEdit = wsRole === 'owner' || wsRole === 'editor' || user?.role === 'sysadmin';

  const review = async (docId: string, approve: boolean, note?: string) => {
    if (acting) return;
    setActing(true);
    try {
      await api.post(`/documents/${docId}/review`, { approve, reason: note });
      setRejectingId(null);
      setReason('');
      await load();
      void refreshMeta();
      notifyPendingReviewChanged();
    } finally {
      setActing(false);
    }
  };

  const toggleSelect = (id: string) =>
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  /** 批量审核：通过后小文档自动走同步 embedding（秒级），大文档走 Batch */
  const reviewBatch = async (approve: boolean, note?: string) => {
    if (selected.size === 0 || acting) return;
    setActing(true);
    setNotice('');
    try {
      const res = await api.post<{
        succeeded: number;
        failed: number;
        results: { document_id: string; ok: boolean; message?: string }[];
      }>('/documents/review-batch', { ids: [...selected], approve, reason: note });
      if (res.failed > 0) {
        const names = res.results
          .filter((r) => !r.ok)
          .map((r) => docs.find((d) => d.id === r.document_id)?.title ?? r.document_id);
        setNotice(`成功 ${res.succeeded} 篇，失败 ${res.failed} 篇：${names.join('、')}`);
      }
      setSelected(new Set());
      setBatchRejecting(false);
      setReason('');
      await load();
      void refreshMeta();
      notifyPendingReviewChanged();
    } finally {
      setActing(false);
    }
  };

  // 处理中文档的进度轮询：单次批量请求；按仍在处理中的 id 集合订阅，避免中间状态回写重启定时器
  const processingKey = docs
    .filter((d) => PROCESSING.has(d.status))
    .map((d) => d.id)
    .sort()
    .join(',');

  useEffect(() => {
    const ids = processingKey ? processingKey.split(',') : [];
    if (ids.length === 0) return;
    const timer = setInterval(async () => {
      try {
        const res = await api.post<{
          items: { id: string; status: string; percent: number | null; error_msg?: string | null }[];
        }>('/documents/progress', { ids });
        setProgress((prev) => {
          const next = { ...prev };
          for (const item of res.items) next[item.id] = item.percent ?? 0;
          return next;
        });
        // 进度接口带权威 status：立刻回写列表，PARSING→GRAPHING→READY 不必等整页刷新
        setDocs((prev) => {
          const byId = new Map(res.items.map((it) => [it.id, it]));
          let changed = false;
          const next = prev.map((d) => {
            const item = byId.get(d.id);
            if (!item || item.status === d.status) return d;
            changed = true;
            return { ...d, status: item.status, error_msg: item.error_msg ?? d.error_msg };
          });
          return changed ? next : prev;
        });
        // 任一文档离开处理中（READY/FAILED）再静默拉一次列表，补齐 error_msg 等字段
        if (res.items.some((it) => !PROCESSING.has(it.status))) {
          await load(page, true);
        }
      } catch {
        /* 忽略单次轮询失败 */
      }
    }, 2000);
    return () => clearInterval(timer);
  }, [processingKey, load, page]);

  const doUpload = async (file: File) => {
    if (!workspaceId || uploading) return;
    setUploading(true);
    setError('');
    try {
      // 0. 内容查重预检：前端先算 sha256，命中重复则不上传。
      // crypto.subtle 仅在安全上下文（localhost/HTTPS）可用，http 局域网访问降级为 js-sha256
      const buf = await file.arrayBuffer();
      const contentHash = crypto.subtle
        ? [...new Uint8Array(await crypto.subtle.digest('SHA-256', buf))]
            .map((b) => b.toString(16).padStart(2, '0'))
            .join('')
        : sha256(buf);
      const dup = await api.post<{ duplicate: boolean; title: string | null }>(
        `/workspaces/${workspaceId}/documents/check-duplicate`,
        { content_hash: contentHash },
      );
      if (dup.duplicate) {
        setError(`内容与已有文档《${dup.title}》重复，无需重复上传`);
        return;
      }

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
      // 新文档进入待审核，通知导航角标刷新
      notifyPendingReviewChanged();
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
    // 删除的可能是待审核文档，同步角标
    notifyPendingReviewChanged();
  };

  // 失败重试：从头（解析阶段）完整重跑入库管线
  const retry = async (id: string) => {
    if (retrying) return;
    setRetrying(id);
    setError('');
    try {
      await api.post(`/documents/${id}/reindex?from_stage=parse`);
      await load();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : '重试失败，请稍后再试');
    } finally {
      setRetrying(null);
    }
  };

  return (
    <div className="h-full overflow-y-auto p-6">
      <div className="mx-auto max-w-4xl">
        {/* 面包屑导航栏 */}
        <nav className="mb-5 flex items-center gap-2 rounded-card border border-border bg-card px-4 py-3 shadow-card">
          <Link
            to="/workspaces"
            className="flex items-center gap-1.5 rounded-lg py-1 pr-2 text-sm font-medium text-ink-600 transition-colors hover:text-brand-600"
          >
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <path d="m15 18-6-6 6-6" />
            </svg>
            知识空间
          </Link>
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="text-ink-300">
            <path d="m9 18 6-6-6-6" />
          </svg>
          <span className="truncate text-sm font-semibold text-ink-900">{wsName || '文档管理'}</span>
          <Link
            to={`/workspaces/${workspaceId}/graph`}
            className="ml-2 shrink-0 rounded-lg px-2 py-1 text-xs font-medium text-brand-600 transition-colors hover:bg-brand-600/10"
          >
            知识图谱
          </Link>
          <span className="ml-auto hidden text-xs text-ink-400 sm:block">
            上传后需部门审核，通过后自动解析入库
          </span>
        </nav>
        {error && (
          <p className="mb-4 rounded-lg bg-red-500/10 px-3 py-2 text-sm text-red-600 dark:text-red-400">
            {error}
          </p>
        )}
        {notice && (
          <p className="mb-4 rounded-lg bg-amber-500/10 px-3 py-2 text-sm text-amber-600 dark:text-amber-400">
            {notice}
          </p>
        )}

        {/* Tab：全部文档 / 待审核（仅审核者可见，角标为待审数） */}
        {canReview && (
          <div className="mb-4 flex items-center gap-1 rounded-card border border-border bg-card p-1 shadow-card">
            <button
              onClick={() => switchTab('all')}
              className={`flex-1 rounded-lg px-3 py-1.5 text-sm font-medium transition-colors ${
                tab === 'all' ? 'bg-brand-600/10 text-brand-700' : 'text-ink-500 hover:bg-subtle'
              }`}
            >
              全部文档
            </button>
            <button
              onClick={() => switchTab('review')}
              className={`flex flex-1 items-center justify-center gap-1.5 rounded-lg px-3 py-1.5 text-sm font-medium transition-colors ${
                tab === 'review' ? 'bg-amber-500/10 text-amber-600 dark:text-amber-400' : 'text-ink-500 hover:bg-subtle'
              }`}
            >
              待审核
              {pendingCount > 0 && (
                <span className="flex h-4 min-w-4 items-center justify-center rounded-full bg-amber-500 px-1 text-[10px] font-semibold text-white">
                  {pendingCount > 99 ? '99+' : pendingCount}
                </span>
              )}
            </button>
          </div>
        )}

        {/* 拖拽上传区：viewer 只读不展示；待审核 Tab 下不展示 */}
        {canEdit && tab === 'all' && (
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
        )}

        {/* 待审核 Tab：批量操作栏 */}
        {tab === 'review' && !loading && docs.length > 0 && (
          <div className="mb-4 rounded-card border border-border bg-card px-4 py-2.5 shadow-card">
            <div className="flex items-center gap-3">
              <label className="flex cursor-pointer items-center gap-2 text-sm text-ink-600">
                <input
                  type="checkbox"
                  checked={selected.size === docs.length && docs.length > 0}
                  onChange={() =>
                    setSelected((prev) => (prev.size === docs.length ? new Set() : new Set(docs.map((d) => d.id))))
                  }
                  className="h-4 w-4 accent-brand-600"
                />
                全选
              </label>
              <span className="text-xs text-ink-400">已选 {selected.size} / {docs.length} 篇</span>
              <div className="ml-auto flex items-center gap-1.5">
                <button
                  disabled={acting || selected.size === 0}
                  onClick={() => void reviewBatch(true)}
                  className="rounded-lg bg-emerald-600 px-3 py-1.5 text-xs font-medium text-white transition-colors hover:bg-emerald-700 disabled:opacity-50"
                >
                  批量通过{selected.size > 0 ? `（${selected.size}）` : ''}
                </button>
                <button
                  disabled={acting || selected.size === 0}
                  onClick={() => setBatchRejecting((v) => !v)}
                  className="rounded-lg border border-red-500/30 px-3 py-1.5 text-xs font-medium text-red-500 transition-colors hover:bg-red-500/10 disabled:opacity-50"
                >
                  批量拒绝
                </button>
              </div>
            </div>
            {batchRejecting && (
              <div className="mt-2.5 flex items-center gap-2 border-t border-border pt-2.5">
                <input
                  autoFocus
                  value={reason}
                  onChange={(e) => setReason(e.target.value)}
                  placeholder={`批量拒绝 ${selected.size} 篇的理由（必填，上传者可见）`}
                  className="flex-1 rounded-lg border border-border bg-card px-3 py-1.5 text-sm outline-none transition-colors placeholder:text-ink-400 focus:border-red-400"
                />
                <button
                  disabled={acting || !reason.trim()}
                  onClick={() => void reviewBatch(false, reason.trim())}
                  className="rounded-lg bg-red-500 px-3 py-1.5 text-xs font-medium text-white transition-colors hover:bg-red-600 disabled:opacity-50"
                >
                  确认拒绝
                </button>
              </div>
            )}
          </div>
        )}

        {/* 搜索与筛选工具栏：待审核 Tab 状态固定，不展示 */}
        {tab === 'all' && (
        <div className="mb-4 flex flex-wrap items-center gap-2 rounded-card border border-border bg-card p-3 shadow-card">
          <div className="relative min-w-48 flex-1">
            <svg
              width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"
              className="absolute left-3 top-1/2 -translate-y-1/2 text-ink-400"
            >
              <circle cx="11" cy="11" r="8" />
              <path d="m21 21-4.3-4.3" />
            </svg>
            <input
              value={keyword}
              onChange={(e) => setKeyword(e.target.value)}
              placeholder="搜索文档名称…"
              className="w-full rounded-lg border border-border bg-card py-1.5 pl-9 pr-3 text-sm outline-none transition-colors placeholder:text-ink-400 focus:border-brand-500"
            />
          </div>
          <select
            value={status}
            onChange={(e) => setStatus(e.target.value)}
            className="rounded-lg border border-border bg-card px-2.5 py-1.5 text-sm text-ink-600 outline-none transition-colors focus:border-brand-500"
          >
            <option value="">全部状态</option>
            <option value="PENDING_REVIEW">待审核</option>
            <option value="PROCESSING">处理中</option>
            <option value="READY">可检索</option>
            <option value="FAILED">失败</option>
            <option value="REJECTED">已拒绝</option>
          </select>
          <select
            value={docType}
            onChange={(e) => setDocType(e.target.value)}
            className="rounded-lg border border-border bg-card px-2.5 py-1.5 text-sm text-ink-600 outline-none transition-colors focus:border-brand-500"
          >
            <option value="">全部类型</option>
            <option value="pdf">PDF</option>
            <option value="word">Word</option>
            <option value="excel">Excel</option>
            <option value="ppt">PPT</option>
            <option value="md">Markdown</option>
            <option value="txt">TXT</option>
            <option value="html">HTML</option>
          </select>
          <div className="flex items-center gap-1.5 text-xs text-ink-400">
            <input
              type="date"
              value={dateFrom}
              onChange={(e) => setDateFrom(e.target.value)}
              onClick={(e) => {
                // 点击输入框任意位置都打开日期选择器（默认只有右侧图标可点）
                try {
                  e.currentTarget.showPicker();
                } catch {
                  /* 旧浏览器不支持 showPicker 时保持默认行为 */
                }
              }}
              className="cursor-pointer rounded-lg border border-border bg-card px-2.5 py-1.5 text-sm text-ink-600 outline-none transition-colors focus:border-brand-500"
              title="上传日期起"
            />
            <span>至</span>
            <input
              type="date"
              value={dateTo}
              onChange={(e) => setDateTo(e.target.value)}
              onClick={(e) => {
                try {
                  e.currentTarget.showPicker();
                } catch {
                  /* 旧浏览器不支持 showPicker 时保持默认行为 */
                }
              }}
              className="cursor-pointer rounded-lg border border-border bg-card px-2.5 py-1.5 text-sm text-ink-600 outline-none transition-colors focus:border-brand-500"
              title="上传日期止"
            />
          </div>
          {(keyword || status || docType || dateFrom || dateTo) && (
            <button
              onClick={() => {
                setKeyword('');
                setStatus('');
                setDocType('');
                setDateFrom('');
                setDateTo('');
              }}
              className="rounded-lg px-2.5 py-1.5 text-xs text-ink-400 transition-colors hover:bg-subtle hover:text-ink-600"
            >
              清空筛选
            </button>
          )}
        </div>
        )}

        {/* 文档列表 */}
        {loading ? (
          <div className="space-y-2.5">
            {Array.from({ length: 3 }).map((_, i) => (
              <div key={i} className="skeleton h-16 rounded-card" />
            ))}
          </div>
        ) : docs.length === 0 ? (
          <div className="rounded-card border border-dashed border-border py-14 text-center">
            <p className="text-sm text-ink-400">
              {tab === 'review' ? '没有待审核的文档' : canEdit ? '暂无文档，上传后自动解析入库' : '暂无文档'}
            </p>
          </div>
        ) : (
          <div className={`space-y-2.5 transition-opacity ${paging ? 'pointer-events-none opacity-50' : ''}`}>
            {docs.map((doc) => {
              const st = STATUS_LABEL[doc.status] ?? STATUS_LABEL.UPLOADED;
              return (
                <div
                  key={doc.id}
                  className="group rounded-card border border-border bg-card p-4 shadow-card transition-colors hover:border-brand-500/30"
                >
                  <div className="flex items-center gap-3">
                    {tab === 'review' && (
                      <input
                        type="checkbox"
                        checked={selected.has(doc.id)}
                        onChange={() => toggleSelect(doc.id)}
                        className="h-4 w-4 shrink-0 accent-brand-600"
                      />
                    )}
                    <button
                      onClick={() => void openPreview(doc.id)}
                      className="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg bg-subtle transition-transform group-hover:scale-105"
                      title="预览文档"
                    >
                      <DocTypeIcon title={doc.title} size={24} />
                    </button>
                    <div className="min-w-0 flex-1 cursor-pointer" onClick={() => void openPreview(doc.id)}>
                      <div className="truncate text-sm font-medium text-ink-900 transition-colors group-hover:text-brand-700">{doc.title}</div>
                      <div className="mt-0.5 flex items-center gap-2 text-xs text-ink-400">
                        {tab === 'review' && doc.uploader && (
                          <>
                            <span>{doc.uploader.name} 上传</span>
                            <span>·</span>
                          </>
                        )}
                        <span>{formatSize(doc.file_size)}</span>
                        <span>·</span>
                        <span>{new Date(doc.created_at).toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' })}</span>
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
                    {tab === 'review' ? (
                      <div className="flex shrink-0 items-center gap-1.5">
                        <button
                          disabled={acting}
                          onClick={() => void review(doc.id, true)}
                          className="rounded-lg bg-emerald-600 px-3 py-1.5 text-xs font-medium text-white transition-colors hover:bg-emerald-700 disabled:opacity-50"
                        >
                          通过
                        </button>
                        <button
                          disabled={acting}
                          onClick={() => setRejectingId(rejectingId === doc.id ? null : doc.id)}
                          className="rounded-lg border border-red-500/30 px-3 py-1.5 text-xs font-medium text-red-500 transition-colors hover:bg-red-500/10 disabled:opacity-50"
                        >
                          拒绝
                        </button>
                      </div>
                    ) : (
                      <>
                        <span className={`shrink-0 rounded-full px-2.5 py-1 text-xs font-medium ${st.className}`}>
                          {st.label}
                        </span>
                        {canEdit && doc.status === 'FAILED' && (
                          <button
                            onClick={() => void retry(doc.id)}
                            disabled={retrying === doc.id}
                            className="flex shrink-0 items-center gap-1 rounded-lg border border-brand-500/30 px-2.5 py-1 text-xs font-medium text-brand-600 transition-colors hover:bg-brand-600/10 disabled:opacity-50 dark:text-brand-400"
                            title="从解析阶段重新入库"
                          >
                            <svg
                              width="12"
                              height="12"
                              viewBox="0 0 24 24"
                              fill="none"
                              stroke="currentColor"
                              strokeWidth="2"
                              strokeLinecap="round"
                              strokeLinejoin="round"
                              className={retrying === doc.id ? 'animate-spin' : ''}
                            >
                              <path d="M21 12a9 9 0 1 1-2.64-6.36" />
                              <path d="M21 3v6h-6" />
                            </svg>
                            {retrying === doc.id ? '重试中' : '重试'}
                          </button>
                        )}
                        {canEdit && (
                          <button
                            onClick={() => remove(doc.id)}
                            disabled={PROCESSING.has(doc.status)}
                            className="shrink-0 rounded-lg p-1.5 text-ink-400 transition-colors hover:bg-red-500/10 hover:text-red-500 disabled:cursor-not-allowed disabled:opacity-40 disabled:hover:bg-transparent disabled:hover:text-ink-400"
                            title={PROCESSING.has(doc.status) ? '文档处理中，暂不可删除' : '删除文档'}
                          >
                            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                              <path d="M3 6h18" />
                              <path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6" />
                              <path d="M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2" />
                            </svg>
                          </button>
                        )}
                      </>
                    )}
                  </div>
                  {tab === 'review' && rejectingId === doc.id && (
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
                        onClick={() => void review(doc.id, false, reason.trim())}
                        className="rounded-lg bg-red-500 px-3 py-1.5 text-xs font-medium text-white transition-colors hover:bg-red-600 disabled:opacity-50"
                      >
                        确认拒绝
                      </button>
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        )}

        <Pagination
          page={page}
          total={total}
          pageSize={PAGE_SIZE}
          onChange={goPage}
          totalLabel={tab === 'review' ? `共 ${total} 篇待审核` : `共 ${total} 篇文档`}
        />

        {preview && <DocPreviewModal doc={preview} onClose={() => setPreview(null)} />}
        {confirmDialog}
      </div>
    </div>
  );
}
