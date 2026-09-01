/** 页码序列：≤7 页全展示，否则当前页前后各 1 页、首尾固定、中间省略 */
export const pageNumbers = (page: number, totalPages: number): (number | '…')[] => {
  if (totalPages <= 7) return Array.from({ length: totalPages }, (_, i) => i + 1);
  const pages: (number | '…')[] = [1];
  if (page > 3) pages.push('…');
  for (let i = Math.max(2, page - 1); i <= Math.min(totalPages - 1, page + 1); i++) pages.push(i);
  if (page < totalPages - 2) pages.push('…');
  pages.push(totalPages);
  return pages;
};

interface PaginationProps {
  page: number;
  total: number;
  pageSize: number;
  onChange: (page: number) => void;
  /** 左侧统计文案，如「共 32 篇」 */
  totalLabel?: string;
}

/** 通用分页器：左侧总数 + 右侧页码导航（首尾固定、中间省略） */
export default function Pagination({ page, total, pageSize, onChange, totalLabel }: PaginationProps) {
  const totalPages = Math.max(1, Math.ceil(total / pageSize));
  if (total <= 0) return null;

  return (
    <div className="flex items-center justify-between gap-2 px-1 py-3">
      <span className="text-xs text-ink-400">{totalLabel ?? `共 ${total} 条`}</span>
      <div className="flex items-center gap-1 text-xs">
        <button
          disabled={page <= 1}
          onClick={() => onChange(page - 1)}
          className="rounded-md px-2 py-1 text-ink-600 hover:bg-subtle disabled:opacity-40"
        >
          上一页
        </button>
        {pageNumbers(page, totalPages).map((p, i) =>
          p === '…' ? (
            <span key={`ellipsis-${i}`} className="px-1 text-ink-300">
              …
            </span>
          ) : (
            <button
              key={p}
              onClick={() => onChange(p)}
              className={`min-w-7 rounded-md px-2 py-1 transition-colors ${
                p === page ? 'bg-brand-600 font-medium text-white' : 'text-ink-600 hover:bg-subtle'
              }`}
            >
              {p}
            </button>
          ),
        )}
        <button
          disabled={page >= totalPages}
          onClick={() => onChange(page + 1)}
          className="rounded-md px-2 py-1 text-ink-600 hover:bg-subtle disabled:opacity-40"
        >
          下一页
        </button>
      </div>
    </div>
  );
}
