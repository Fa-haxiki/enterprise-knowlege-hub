import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

export interface WebHit {
  title: string;
  url: string;
  snippet: string;
}

const BLOCKED_HOST = /^(localhost|127\.|10\.|192\.168\.|169\.254\.|0\.0\.0\.|\[::1\])/i;

@Injectable()
export class WebSearchService {
  private readonly logger = new Logger(WebSearchService.name);

  constructor(private readonly config: ConfigService) {}

  enabled(): boolean {
    return this.config.get<boolean>('agent.enableWeb') === true;
  }

  async search(query: string): Promise<WebHit[]> {
    if (!this.enabled()) return [];
    const provider = this.config.get<string>('agent.webProvider') ?? 'searxng';
    const timeout = this.config.get<number>('agent.webTimeoutMs') ?? 5_000;
    const limit = this.config.get<number>('agent.webMaxResults') ?? 5;
    try {
      const hits = provider === 'tavily' ? await this.searchTavily(query, timeout) : await this.searchSearx(query, timeout);
      return hits.filter((h) => this.allowedUrl(h.url)).slice(0, limit);
    } catch (e) {
      this.logger.warn(`web_search degraded: ${(e as Error).message}`);
      return [];
    }
  }

  private allowedUrl(url: string): boolean {
    try {
      const u = new URL(url);
      if (u.protocol !== 'http:' && u.protocol !== 'https:') return false;
      return !BLOCKED_HOST.test(u.hostname);
    } catch {
      return false;
    }
  }

  private async searchSearx(query: string, timeout: number): Promise<WebHit[]> {
    const base = this.config.get<string>('agent.webUrl') ?? 'http://localhost:8088';
    const params = new URLSearchParams({
      q: query,
      format: 'json',
      language: 'zh-CN',
      categories: 'general',
    });
    const url = `${base.replace(/\/$/, '')}/search?${params.toString()}`;
    const res = await fetch(url, {
      headers: { Accept: 'application/json' },
      signal: AbortSignal.timeout(timeout),
    });
    if (!res.ok) throw new Error(`searxng ${res.status}`);
    const json = (await res.json()) as { results?: { title?: string; url?: string; content?: string }[] };
    return (json.results ?? []).map((r) => ({
      title: r.title ?? r.url ?? '',
      url: r.url ?? '',
      snippet: (r.content ?? '').slice(0, 240),
    }));
  }

  private async searchTavily(query: string, timeout: number): Promise<WebHit[]> {
    const key = this.config.get<string>('agent.webApiKey') ?? '';
    if (!key) throw new Error('tavily api key missing');
    const res = await fetch('https://api.tavily.com/search', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ api_key: key, query, max_results: 5 }),
      signal: AbortSignal.timeout(timeout),
    });
    if (!res.ok) throw new Error(`tavily ${res.status}`);
    const json = (await res.json()) as { results?: { title?: string; url?: string; content?: string }[] };
    return (json.results ?? []).map((r) => ({
      title: r.title ?? r.url ?? '',
      url: r.url ?? '',
      snippet: (r.content ?? '').slice(0, 240),
    }));
  }
}
