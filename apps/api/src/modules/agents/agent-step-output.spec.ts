import { AgentIntent, EvidenceGrade } from '@ekh/shared';
import { buildNodeOutput, compactWebHits } from './agent-step-output';

describe('buildNodeOutput', () => {
  it('联网搜索结果压成摘要 + hits', () => {
    const hits = compactWebHits([
      { title: 'SearXNG', url: 'https://example.com', snippet: 'release notes' },
    ]);
    expect(hits[0].url).toBe('https://example.com');
    const out = buildNodeOutput('execute_tools', {
      webHits: [{ title: 'SearXNG', url: 'https://example.com', snippet: 'release notes' }],
    });
    expect(out.summary).toBe('联网 1 条');
    expect((out.webHits as { title: string }[])[0].title).toBe('SearXNG');
  });

  it('意图路由带 suggestedQuery', () => {
    const out = buildNodeOutput('intent_router', {
      intent: AgentIntent.WEB,
      suggestedQuery: 'SearXNG release',
    });
    expect(out.summary).toContain('web');
    expect(out.suggestedQuery).toBe('SearXNG release');
  });

  it('评估带 grade', () => {
    const out = buildNodeOutput('evaluate', {
      evidenceGrade: EvidenceGrade.GIVE_UP,
      evidenceNotes: '资料不足，结束检索',
    });
    expect(out.grade).toBe(EvidenceGrade.GIVE_UP);
    expect(out.summary).toBe('资料不足，结束检索');
  });
});
