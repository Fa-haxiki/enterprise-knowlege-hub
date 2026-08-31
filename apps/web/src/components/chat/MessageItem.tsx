import { Suspense, lazy, useEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import { api } from '@/lib/api';
import DocPreviewModal, { type DocPreview } from '@/components/DocPreviewModal';
import AgentSteps from './AgentSteps';
import ExecutionTrace from './ExecutionTrace';
import MarkdownBody from './MarkdownBody';
import type { Message } from './types';

const GraphView = lazy(() => import('./GraphView'));

interface Props {
  message: Message;
  playing: boolean;
  onFeedback(id: string, value: 1 | -1): void;
  onSpeak(m: Message): void;
}

function CitationPanel({ message }: { message: Message }) {
  const [preview, setPreview] = useState<DocPreview | null>(null);

  const openDocument = async (documentId: string) => {
    try {
      const doc = await api.get<DocPreview>(`/documents/${documentId}/download-url`);
      setPreview(doc);
    } catch {
      /* 无权限或文档已删除时静默（按钮本就只展示给有权限用户） */
    }
  };

  if (!message.citations?.length) return null;
  return (
    <div className="mt-3 border-t border-border pt-2">
      <div className="mb-1.5 text-xs font-medium text-ink-400">引用来源</div>
      <div className="flex flex-wrap gap-1">
        {[...message.citations].sort((a, b) => a.ref_id - b.ref_id).map((c) => (
          <button
            key={c.ref_id}
            onClick={() => void openDocument(c.document_id)}
            className="group flex max-w-64 items-center gap-1.5 rounded-md border border-border bg-subtle/50 px-1.5 py-1 text-left text-xs transition-colors hover:border-brand-500/40 hover:bg-brand-600/5"
            title={c.snippet}
          >
            <span className="flex h-4 w-4 shrink-0 items-center justify-center rounded bg-brand-600/10 text-[10px] font-semibold text-brand-600">
              {c.ref_id}
            </span>
            <span className="truncate font-medium text-ink-600 group-hover:text-brand-700">
              《{c.title}》
            </span>
            {c.page != null && (
              <span className="shrink-0 rounded bg-subtle px-1 py-px text-[10px] text-ink-400">
                P{c.page}
              </span>
            )}
            <svg
              width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"
              className="ml-auto shrink-0 text-ink-400 opacity-0 transition-opacity group-hover:opacity-100"
            >
              <path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z" /><circle cx="12" cy="12" r="3" />
            </svg>
          </button>
        ))}
      </div>
      {preview && <DocPreviewModal doc={preview} onClose={() => setPreview(null)} />}
    </div>
  );
}

function GraphPanel({ triples }: { triples: NonNullable<Message['triples']> }) {
  const [open, setOpen] = useState(false);
  const entityCount = new Set(triples.flatMap((t) => [t[0], t[2]])).size;

  // ESC 关闭弹窗
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open]);

  return (
    <div className="mt-4 rounded-lg border border-brand-600/15 bg-brand-50/50 p-3 dark:bg-brand-600/5">
      <button
        onClick={() => setOpen(true)}
        className="flex w-full items-center gap-1.5 text-xs font-medium text-brand-700 dark:text-brand-700"
      >
        <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
          <circle cx="5" cy="6" r="2.5" />
          <circle cx="19" cy="6" r="2.5" />
          <circle cx="12" cy="18" r="2.5" />
          <path d="M7.5 6h9M6.2 8.2l4 7.5M17.8 8.2l-4 7.5" />
        </svg>
        图谱推理链路
        <span className="text-ink-400">
          · {entityCount} 个实体 / {triples.length} 条关系
        </span>
        <span className="ml-auto inline-flex items-center gap-1 rounded-md bg-brand-600/10 px-2 py-0.5 text-[11px] text-brand-600 transition-colors hover:bg-brand-600/20">
          <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <path d="M15 3h6v6M9 21H3v-6M21 3l-7 7M3 21l7-7" />
          </svg>
          查看图谱
        </span>
      </button>

      {/* Portal 到 body：祖先的 transform 动画会让 fixed 定位失效 */}
      {open &&
        createPortal(
          <div
            className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-6 backdrop-blur-sm animate-fadeUp"
            onClick={() => setOpen(false)}
          >
          <div
            className="flex h-full max-h-[82vh] w-full max-w-5xl flex-col rounded-card bg-card p-4 shadow-pop"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="mb-3 flex items-center gap-2">
              <span className="text-sm font-semibold text-ink-900">图谱推理链路</span>
              <span className="text-xs text-ink-400">
                {entityCount} 个实体 / {triples.length} 条关系
              </span>
              <span className="ml-3 hidden text-[11px] text-ink-400 sm:inline">
                节点可拖拽、滚轮缩放；点击节点查看其关联链路
              </span>
              <button
                onClick={() => setOpen(false)}
                className="ml-auto rounded-lg p-1.5 text-ink-400 transition-colors hover:bg-subtle hover:text-ink-900"
                title="关闭（Esc）"
              >
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
                  <path d="M18 6 6 18M6 6l12 12" />
                </svg>
              </button>
            </div>
            <div className="min-h-0 flex-1">
              <Suspense fallback={<div className="skeleton h-full rounded-lg" />}>
                <GraphView triples={triples} />
              </Suspense>
            </div>
          </div>
          </div>,
          document.body,
        )}
    </div>
  );
}

export default function MessageItem({ message: m, playing, onFeedback, onSpeak }: Props) {
  const [copied, setCopied] = useState(false);

  const copyContent = async () => {
    try {
      await navigator.clipboard.writeText(m.content);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      /* 剪贴板权限被拒绝时静默 */
    }
  };

  if (m.role === 'user') {
    return (
      <div className="flex justify-end animate-fadeUp">
        <div className="max-w-[80%] rounded-bubble rounded-br-md bg-gradient-to-br from-brand-600 to-brand-700 px-4 py-2.5 text-sm leading-6 text-white shadow-sm">
          <div className="whitespace-pre-wrap">{m.content}</div>
        </div>
      </div>
    );
  }

  return (
    <div className="flex gap-3 animate-fadeUp">
      {/* Agent 头像 */}
      <div className="mt-1 flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-gradient-to-br from-brand-500 to-brand-700 text-white shadow-sm">
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <path d="M12 3l1.9 5.1L19 10l-5.1 1.9L12 17l-1.9-5.1L5 10l5.1-1.9L12 3Z" />
          <path d="M19 15l.8 2.2L22 18l-2.2.8L19 21l-.8-2.2L16 18l2.2-.8L19 15Z" />
        </svg>
      </div>

      <div className="min-w-0 flex-1 rounded-bubble rounded-tl-md border border-border bg-card px-4 py-3 text-sm leading-6 shadow-card">
        {/* 流式中：横向实时步骤条；完成后：纵向执行链路面板（历史消息由 node_latencies 重建） */}
        {m.streaming
          ? m.steps && m.steps.length > 0 && <AgentSteps steps={m.steps} />
          : (m.steps?.length || m.nodeLatencies) && (
              <ExecutionTrace
                steps={m.steps}
                nodeLatencies={m.nodeLatencies}
                degraded={m.degradedNodes}
                latencyMs={m.latencyMs}
                tokens={
                  (m.usage?.prompt_tokens ?? 0) + (m.usage?.completion_tokens ?? 0) || undefined
                }
              />
            )}

        {m.complexity === 'complex' && !m.streaming && (
          <span className="mb-2 inline-flex items-center gap-1 rounded-full bg-brand-600/10 px-2 py-0.5 text-xs font-medium text-brand-600">
            图谱推理
          </span>
        )}

        {/* 播放语音时保持 Markdown 渲染样式，仅按钮状态变化 */}
        <MarkdownBody content={m.content} />
        {m.streaming && (
          <span className="ml-0.5 inline-block h-4 w-2 animate-blink bg-brand-600 align-text-bottom" />
        )}

        {m.triples && m.triples.length > 0 && <GraphPanel triples={m.triples} />}
        <CitationPanel message={m} />

        {/* 操作栏：反馈 + 语音 */}
        {!m.streaming && m.content && (
          <div className="mt-3 flex items-center gap-1 border-t border-border pt-2 text-xs text-ink-400">
            <button
              onClick={() => onFeedback(m.id, 1)}
              className={`flex items-center gap-1 rounded-md px-2 py-1 transition-colors hover:bg-subtle ${
                m.feedback === 1 ? 'text-emerald-600' : ''
              }`}
            >
              <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <path d="M7 10v12M15 5.88 14 10h5.83a2 2 0 0 1 1.92 2.56l-2.33 8A2 2 0 0 1 17.5 22H4a2 2 0 0 1-2-2v-8a2 2 0 0 1 2-2h2.76a2 2 0 0 0 1.79-1.11L12 2a3.13 3.13 0 0 1 3 3.88Z" />
              </svg>
              有用
            </button>
            <button
              onClick={() => onFeedback(m.id, -1)}
              className={`flex items-center gap-1 rounded-md px-2 py-1 transition-colors hover:bg-subtle ${
                m.feedback === -1 ? 'text-red-500' : ''
              }`}
            >
              <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="rotate-180">
                <path d="M7 10v12M15 5.88 14 10h5.83a2 2 0 0 1 1.92 2.56l-2.33 8A2 2 0 0 1 17.5 22H4a2 2 0 0 1-2-2v-8a2 2 0 0 1 2-2h2.76a2 2 0 0 0 1.79-1.11L12 2a3.13 3.13 0 0 1 3 3.88Z" />
              </svg>
              无用
            </button>
            <button
              onClick={() => void copyContent()}
              className={`flex items-center gap-1 rounded-md px-2 py-1 transition-colors hover:bg-subtle ${
                copied ? 'text-emerald-600' : ''
              }`}
              title="复制回答"
            >
              {copied ? (
                <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M20 6 9 17l-5-5" />
                </svg>
              ) : (
                <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <rect x="9" y="9" width="13" height="13" rx="2" /><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" />
                </svg>
              )}
              {copied ? '已复制' : '复制'}
            </button>
            <button
              onClick={() => onSpeak(m)}
              className={`ml-auto flex items-center gap-1 rounded-md px-2 py-1 transition-colors hover:bg-subtle ${
                playing ? 'text-brand-600' : ''
              }`}
              title={playing ? '停止播放' : '语音播放'}
            >
              {playing ? (
                <svg width="13" height="13" viewBox="0 0 24 24" fill="currentColor">
                  <rect x="6" y="5" width="4" height="14" rx="1" />
                  <rect x="14" y="5" width="4" height="14" rx="1" />
                </svg>
              ) : (
                <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5" fill="currentColor" />
                  <path d="M15.54 8.46a5 5 0 0 1 0 7.07" />
                  <path d="M19.07 4.93a10 10 0 0 1 0 14.14" />
                </svg>
              )}
              {playing ? '停止' : '播放'}
            </button>
          </div>
        )}
      </div>
    </div>
  );
}
