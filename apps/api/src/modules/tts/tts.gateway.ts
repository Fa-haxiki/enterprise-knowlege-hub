import { Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';
import {
  OnGatewayConnection,
  OnGatewayDisconnect,
  SubscribeMessage,
  WebSocketGateway,
  WebSocketServer,
} from '@nestjs/websockets';
import type { Server, Socket } from 'socket.io';

interface SpeakPayload {
  text: string;
  voice?: string;
  rate?: string;
  /** 客户端代次：帧原样回带，前端据此丢弃过期音频；服务端据此中断旧合成循环 */
  gen?: number;
}

/** 按句切分：中英文句末标点 + 换行；过短句并入下一句，避免碎片音频 */
export function splitSentences(text: string): string[] {
  const raw = text.match(/[^。！？!?；;\n]+[。！？!?；;\n]?/g) ?? [];
  const sentences: string[] = [];
  for (const piece of raw.map((s) => s.trim()).filter(Boolean)) {
    const last = sentences[sentences.length - 1];
    if (last !== undefined && last.length < 6) {
      sentences[sentences.length - 1] = last + piece;
    } else {
      sentences.push(piece);
    }
  }
  return sentences;
}

/**
 * TTS 推送网关：客户端发 speak（含完整回答文本），
 * 服务端按句合成并逐句回推音频（base64 MP3），前端按序播放。
 */
@WebSocketGateway({ namespace: '/tts', cors: { origin: true, credentials: true } })
export class TtsGateway implements OnGatewayConnection, OnGatewayDisconnect {
  private readonly logger = new Logger(TtsGateway.name);

  @WebSocketServer()
  private server!: Server;

  constructor(
    private readonly jwt: JwtService,
    private readonly config: ConfigService,
  ) {}

  async handleConnection(client: Socket) {
    try {
      const token = (client.handshake.auth as Record<string, unknown>).token as string;
      const payload = await this.jwt.verifyAsync<{ sub: string }>(token, {
        secret: this.config.get<string>('jwt.secret'),
      });
      client.data.userId = payload.sub;
    } catch {
      client.emit('error', { message: 'unauthorized' });
      client.disconnect(true);
    }
  }

  handleDisconnect(client: Socket) {
    client.removeAllListeners('speak');
  }

  @SubscribeMessage('speak')
  async speak(client: Socket, payload: SpeakPayload) {
    const text = (payload?.text ?? '').trim();
    if (!text) {
      client.emit('error', { message: 'empty text' });
      return;
    }
    if (text.length > 4000) {
      client.emit('error', { message: 'text too long' });
      return;
    }

    const gen = payload.gen ?? Date.now();
    client.data.speakGen = gen;
    const sentences = splitSentences(text);
    const ttsUrl = this.config.get<string>('tts.serviceUrl') ?? 'http://localhost:8750';

    for (let i = 0; i < sentences.length; i++) {
      // 被新 speak 或 stop 取代时中断合成循环
      if (client.data.speakGen !== gen) return;
      const sentence = sentences[i];
      client.emit('sentence', { index: i, total: sentences.length, text: sentence, gen });
      try {
        const res = await fetch(`${ttsUrl}/synthesize`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ text: sentence, voice: payload.voice, rate: payload.rate }),
          signal: AbortSignal.timeout(30_000),
        });
        if (!res.ok) throw new Error(`tts service ${res.status}`);
        const buf = Buffer.from(await res.arrayBuffer());
        if (client.data.speakGen !== gen) return;
        client.emit('audio', { index: i, format: 'mp3', data: buf.toString('base64'), gen });
      } catch (e) {
        this.logger.warn(`tts sentence ${i} failed: ${(e as Error).message}`);
        client.emit('error', { message: `第 ${i + 1} 句合成失败`, index: i, gen });
        // 合成失败即终止：使循环退出且不再合成后续语句，前端收到 error 后停止播放
        client.data.speakGen = -1;
        return;
      }
    }
    client.emit('done', { total: sentences.length, gen });
  }

  /** 停止播报：使进行中的合成循环退出 */
  @SubscribeMessage('stop')
  stop(client: Socket) {
    client.data.speakGen = -1;
  }
}
