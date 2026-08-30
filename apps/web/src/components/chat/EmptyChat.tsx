const SUGGESTIONS = [
  { icon: '📋', title: '制度查询', query: '差旅费用报销的住宿标准是多少？' },
  { icon: '🔗', title: '关联分析', query: '华云科技参与了哪些项目，合作情况如何？' },
  { icon: '🔐', title: '合规问答', query: '数据安全管理办法对敏感数据外发有什么要求？' },
  { icon: '📊', title: '流程咨询', query: '项目立项需要经过哪些审批环节？' },
];

interface Props {
  onAsk(query: string): void;
}

export default function EmptyChat({ onAsk }: Props) {
  return (
    <div className="flex h-full flex-col items-center justify-center py-16 animate-fadeUp">
      <div className="mb-4 flex h-14 w-14 items-center justify-center rounded-2xl bg-gradient-to-br from-brand-500 to-brand-700 text-white shadow-pop">
        <svg width="26" height="26" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <path d="M12 3l1.9 5.1L19 10l-5.1 1.9L12 17l-1.9-5.1L5 10l5.1-1.9L12 3Z" />
        </svg>
      </div>
      <h2 className="text-xl font-semibold text-ink-900">向知识库提问</h2>
      <p className="mt-2 text-sm text-ink-400">支持制度查询、项目关联分析等多轮问答，答案附引用来源</p>
      <div className="mt-8 grid w-full max-w-xl grid-cols-1 gap-2 sm:grid-cols-2">
        {SUGGESTIONS.map((s) => (
          <button
            key={s.title}
            onClick={() => onAsk(s.query)}
            className="group rounded-card border border-border bg-card p-3 text-left shadow-card transition-all hover:-translate-y-0.5 hover:border-brand-500/50 hover:shadow-pop"
          >
            <div className="text-sm font-medium text-ink-900">
              {s.icon} {s.title}
            </div>
            <div className="mt-1 line-clamp-2 text-xs leading-5 text-ink-400">{s.query}</div>
          </button>
        ))}
      </div>
    </div>
  );
}
