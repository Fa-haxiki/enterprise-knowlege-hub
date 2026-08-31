import { FormEvent, useState } from 'react';

interface Props {
  generating: boolean;
  autoSpeak: boolean;
  onToggleAutoSpeak(): void;
  onSend(query: string): void;
}

export default function ChatInput({ generating, autoSpeak, onToggleAutoSpeak, onSend }: Props) {
  const [input, setInput] = useState('');

  const submit = (e: FormEvent) => {
    e.preventDefault();
    const query = input.trim();
    if (!query || generating) return;
    setInput('');
    onSend(query);
  };

  return (
    <div className="border-t border-border bg-card/80 p-4 backdrop-blur">
      <form
        onSubmit={submit}
        className="mx-auto flex max-w-3xl items-end gap-2 rounded-bubble border border-border bg-card p-2 shadow-card transition-colors focus-within:border-brand-500"
      >
        <button
          type="button"
          onClick={onToggleAutoSpeak}
          className={`flex items-center gap-1 rounded-lg px-2.5 py-2 text-xs transition-colors ${
            autoSpeak ? 'bg-brand-600/10 text-brand-600' : 'text-ink-400 hover:bg-subtle hover:text-ink-600'
          }`}
          title={autoSpeak ? '关闭自动语音播报' : '开启自动语音播报'}
        >
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5" fill="currentColor" />
            <path d="M15.54 8.46a5 5 0 0 1 0 7.07" />
          </svg>
          {autoSpeak ? '语音开' : '语音关'}
        </button>
        <textarea
          rows={1}
          className="max-h-40 flex-1 resize-none bg-transparent px-2 py-2 text-sm outline-none placeholder:text-ink-400"
          placeholder="输入问题，Enter 发送，Shift+Enter 换行…"
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
              e.preventDefault();
              submit(e);
            }
          }}
          disabled={generating}
        />
        <button
          type="submit"
          disabled={generating || !input.trim()}
          className="flex items-center gap-1.5 rounded-xl bg-brand-600 px-4 py-2 text-sm font-medium text-white shadow-sm transition-all hover:bg-brand-700 disabled:opacity-40"
        >
          {generating ? (
            <span className="inline-block h-3.5 w-3.5 animate-spin rounded-full border-2 border-white/40 border-t-white" />
          ) : (
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <path d="m22 2-7 20-4-9-9-4Z" />
              <path d="M22 2 11 13" />
            </svg>
          )}
          发送
        </button>
      </form>
    </div>
  );
}
