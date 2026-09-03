import { useState } from 'react';
import { api } from '@/lib/api';
import DocPreviewModal, { type DocPreview } from '@/components/DocPreviewModal';
import ExecutionTrace from './ExecutionTrace';
import MarkdownBody from './MarkdownBody';
import type { Message } from './types';

interface Props {
  message: Message;
  playing: boolean;
  onFeedback(m: Message, value: 1 | -1): void;
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
        {/* 执行链路面板：流式进行中与完成后为同一组件，无切换闪烁（历史消息由 node_latencies 重建） */}
        {(m.steps?.length || m.nodeLatencies) && (
          <ExecutionTrace
            steps={m.steps}
            nodeLatencies={m.nodeLatencies}
            degraded={m.degradedNodes}
            latencyMs={m.latencyMs}
            streaming={m.streaming}
            tokens={
              (m.usage?.prompt_tokens ?? 0) + (m.usage?.completion_tokens ?? 0) || undefined
            }
          />
        )}

        {/* 播放语音时保持 Markdown 渲染样式，仅按钮状态变化 */}
        <MarkdownBody content={m.content} />
        {m.streaming && (
          <span className="ml-0.5 inline-block h-4 w-2 animate-blink bg-brand-600 align-text-bottom" />
        )}

        {/* 图谱推理已下线，不再渲染图谱面板（含历史消息） */}
        <CitationPanel message={m} />

        {/* 操作栏：反馈 + 语音 */}
        {!m.streaming && m.content && (
          <div className="mt-3 flex items-center gap-1 border-t border-border pt-2 text-xs text-ink-400">
            <button
              onClick={() => onFeedback(m, 1)}
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
              onClick={() => onFeedback(m, -1)}
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
