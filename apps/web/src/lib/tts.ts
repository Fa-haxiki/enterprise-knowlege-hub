import { io, type Socket } from 'socket.io-client';

export interface TtsCallbacks {
  /** 某句开始合成（可用于高亮准备） */
  onSentence?: (index: number, total: number, text: string) => void;
  /** 某句音频开始播放（用于句子高亮） */
  onPlaySentence?: (index: number) => void;
  onDone?: () => void;
  onError?: (message: string) => void;
}

/** 朗读前剥离 Markdown 语法符号，避免 "**"、"#" 等被合成语音 */
export function stripMarkdown(md: string): string {
  return (
    md
      // 代码块整体略过
      .replace(/```[\s\S]*?```/g, '。')
      .replace(/`([^`]*)`/g, '$1')
      // 图片/链接：保留可读文本
      .replace(/!\[([^\]]*)\]\([^)]*\)/g, '$1')
      .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
      // 引用角标 [n]：不朗读（须在链接处理之后）
      .replace(/\[\d+\]/g, '')
      // 标题符号（行内空白只用 [ \t]，避免 \s 吞掉换行）
      .replace(/^[ \t]{0,3}#{1,6}[ \t]+/gm, '')
      // 加粗/斜体
      .replace(/(\*\*|__)(.*?)\1/g, '$2')
      .replace(/(\*|_)(.*?)\1/g, '$2')
      // 列表符号：有序列表保留数字（"1." → "1，" 朗读更自然）；无序标记去掉
      .replace(/^[ \t]*(\d+)\.[ \t]+/gm, '$1，')
      .replace(/^[ \t]*[-*+][ \t]+/gm, '')
      // 引用符
      .replace(/^[ \t]*>[ \t]?/gm, '')
      // 表格：分隔行删除；内容行去首尾竖线，中间竖线转停顿
      .replace(/^(?=[ \t|:-]*-)[ \t|:-]+$/gm, '')
      .replace(/^[ \t]*\|(.+)\|[ \t]*$/gm, (_, inner: string) => inner.replace(/\|/g, '，'))
      .replace(/\|/g, '，')
      // HTML 标签
      .replace(/<[^>]+>/g, '')
      .replace(/\n{2,}/g, '\n')
      .trim()
  );
}

/**
 * TTS 播放器：WebSocket 接收按句合成的 MP3，按序播放。
 * 音频可能先于前一句播放完成到达，用队列保证顺序。
 * 代次（gen）机制：speak/stop 递增 gen，过期帧一律丢弃，保证停止立即生效。
 */
export class TtsPlayer {
  private socket: Socket | null = null;
  private queue: Array<{ index: number; url: string; gen: number }> = [];
  private playing = false;
  private generation = 0;
  private currentAudio: HTMLAudioElement | null = null;
  private currentResolve: (() => void) | null = null;

  constructor(private readonly callbacks: TtsCallbacks) {}

  connect(token: string) {
    if (this.socket?.connected) return;
    this.socket = io('/tts', { auth: { token }, transports: ['websocket'] });
    this.socket.on('audio', (d: { index: number; format: string; data: string; gen?: number }) => {
      if (d.gen !== this.generation) return;
      const bytes = Uint8Array.from(atob(d.data), (c) => c.charCodeAt(0));
      const url = URL.createObjectURL(new Blob([bytes], { type: 'audio/mpeg' }));
      this.queue.push({ index: d.index, url, gen: d.gen! });
      void this.pump();
    });
    this.socket.on('done', () => this.callbacks.onDone?.());
    this.socket.on('error', (d: { message: string; gen?: number }) => {
      // 过期代次的错误丢弃；合成失败时停止播放并清空队列，避免半截音频继续播
      if (d.gen != null && d.gen !== this.generation) return;
      this.stopPlayback();
      this.callbacks.onError?.(d.message);
    });
  }

  speak(text: string) {
    const plain = stripMarkdown(text);
    if (!plain) return;
    this.stopPlayback();
    const gen = this.generation;
    this.socket?.emit('speak', { text: plain, gen });
  }

  /** 停止播放并清空队列（不断开连接）；同时通知服务端中断合成 */
  stopPlayback() {
    this.generation++;
    this.socket?.emit('stop');
    this.currentAudio?.pause();
    this.currentAudio = null;
    // pause 不触发 ended，需手动放行 pump 中悬挂的 await
    this.currentResolve?.();
    this.currentResolve = null;
    for (const item of this.queue) URL.revokeObjectURL(item.url);
    this.queue = [];
    this.playing = false;
  }

  disconnect() {
    this.stopPlayback();
    this.socket?.disconnect();
    this.socket = null;
  }

  private async pump() {
    if (this.playing) return;
    this.playing = true;
    for (;;) {
      const item = this.queue.sort((a, b) => a.index - b.index)[0];
      // 队列为空或队首已过期则结束
      if (!item || item.gen !== this.generation) break;
      this.queue.shift();
      this.callbacks.onPlaySentence?.(item.index);
      await new Promise<void>((resolve) => {
        this.currentResolve = resolve;
        const audio = new Audio(item.url);
        this.currentAudio = audio;
        audio.onended = () => resolve();
        audio.onerror = () => resolve();
        void audio.play().catch(() => resolve());
      });
      this.currentResolve = null;
      URL.revokeObjectURL(item.url);
    }
    this.playing = false;
    this.currentAudio = null;
    // stop 与新 speak 交错的极端时序下，新帧可能在 pump 退出前已入队，补一次触发
    if (this.queue.some((i) => i.gen === this.generation)) {
      void this.pump();
    }
  }
}
