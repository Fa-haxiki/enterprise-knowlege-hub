import { io, type Socket } from 'socket.io-client';

export interface TtsCallbacks {
  /** 某句开始合成（可用于高亮准备） */
  onSentence?: (index: number, total: number, text: string) => void;
  /** 某句音频开始播放（用于句子高亮） */
  onPlaySentence?: (index: number) => void;
  onDone?: () => void;
  onError?: (message: string) => void;
}

/**
 * TTS 播放器：WebSocket 接收按句合成的 MP3，按序播放。
 * 音频可能先于前一句播放完成到达，用队列保证顺序。
 */
export class TtsPlayer {
  private socket: Socket | null = null;
  private queue: Array<{ index: number; url: string }> = [];
  private playing = false;
  private stopped = false;
  private currentAudio: HTMLAudioElement | null = null;

  constructor(private readonly callbacks: TtsCallbacks) {}

  connect(token: string) {
    if (this.socket?.connected) return;
    this.socket = io('/tts', { auth: { token }, transports: ['websocket'] });
    this.socket.on('sentence', (d: { index: number; total: number; text: string }) => {
      this.callbacks.onSentence?.(d.index, d.total, d.text);
    });
    this.socket.on('audio', (d: { index: number; format: string; data: string }) => {
      if (this.stopped) return;
      const bytes = Uint8Array.from(atob(d.data), (c) => c.charCodeAt(0));
      const url = URL.createObjectURL(new Blob([bytes], { type: 'audio/mpeg' }));
      this.queue.push({ index: d.index, url });
      void this.pump();
    });
    this.socket.on('done', () => this.callbacks.onDone?.());
    this.socket.on('error', (d: { message: string }) => this.callbacks.onError?.(d.message));
  }

  speak(text: string) {
    this.stopPlayback();
    this.socket?.emit('speak', { text });
  }

  /** 停止播放并清空队列（不断开连接） */
  stopPlayback() {
    this.stopped = true;
    this.currentAudio?.pause();
    this.currentAudio = null;
    for (const item of this.queue) URL.revokeObjectURL(item.url);
    this.queue = [];
    this.playing = false;
    // 下一句 speak 时重置
    setTimeout(() => (this.stopped = false), 0);
  }

  disconnect() {
    this.stopPlayback();
    this.socket?.disconnect();
    this.socket = null;
  }

  private async pump() {
    if (this.playing) return;
    this.playing = true;
    while (this.queue.length > 0 && !this.stopped) {
      this.queue.sort((a, b) => a.index - b.index);
      const item = this.queue.shift()!;
      this.callbacks.onPlaySentence?.(item.index);
      await new Promise<void>((resolve) => {
        const audio = new Audio(item.url);
        this.currentAudio = audio;
        audio.onended = () => resolve();
        audio.onerror = () => resolve();
        void audio.play().catch(() => resolve());
      });
      URL.revokeObjectURL(item.url);
    }
    this.playing = false;
    this.currentAudio = null;
  }
}
