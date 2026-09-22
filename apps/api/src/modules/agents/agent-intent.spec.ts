import { AgentIntent, Complexity, ToolName } from '@ekh/shared';
import {
  allowsGraph,
  complexityFromIntent,
  inferIntentFallback,
  initialToolsForIntent,
  parseIntentJson,
  skipsRetrieve,
  toolsForIntent,
} from './agent-intent';

describe('parseIntentJson', () => {
  it('失败默认 kb', () => {
    expect(parseIntentJson('not-json', '原问').intent).toBe(AgentIntent.KB);
  });

  it('解析五类意图', () => {
    const p = parseIntentJson('{"intent":"chitchat","suggestedQuery":"你好"}', 'hi');
    expect(p.intent).toBe(AgentIntent.CHITCHAT);
    expect(p.suggestedQuery).toBe('你好');
  });
});

describe('toolsForIntent / skipsRetrieve', () => {
  it('闲聊 / 偏好零检索', () => {
    expect(skipsRetrieve(AgentIntent.CHITCHAT)).toBe(true);
    expect(skipsRetrieve(AgentIntent.PREFERENCE)).toBe(true);
    expect(toolsForIntent(AgentIntent.CHITCHAT, { webEnabled: true, enableGraph: true })).toEqual([]);
  });

  it('kb 不挂 web', () => {
    const tools = toolsForIntent(AgentIntent.KB, { webEnabled: true, enableGraph: false });
    expect(tools).toEqual([ToolName.KB_RETRIEVE]);
    expect(tools).not.toContain(ToolName.WEB_SEARCH);
  });

  it('联网未开时 web / kb_then_web 降级为 kb 工具', () => {
    expect(toolsForIntent(AgentIntent.WEB, { webEnabled: false, enableGraph: false })).toEqual([
      ToolName.KB_RETRIEVE,
    ]);
    expect(toolsForIntent(AgentIntent.KB_THEN_WEB, { webEnabled: false, enableGraph: false })).toEqual([
      ToolName.KB_RETRIEVE,
    ]);
  });

  it('kb_then_web 先只跑知识库', () => {
    expect(
      initialToolsForIntent(AgentIntent.KB_THEN_WEB, {
        webEnabled: true,
        enableGraph: false,
        wantGraph: false,
      }),
    ).toEqual([ToolName.KB_RETRIEVE]);
  });
});

describe('complexityFromIntent', () => {
  it('多实体 kb 视为 complex', () => {
    expect(
      complexityFromIntent(AgentIntent.KB, [{ name: 'A' }, { name: 'B' }]),
    ).toBe(Complexity.COMPLEX);
  });
});

describe('inferIntentFallback / allowsGraph', () => {
  it('公开时效 / GitHub / 官方文档 → web', () => {
    expect(
      inferIntentFallback(
        'SearXNG 最新稳定版发布说明改了什么？请查 GitHub 或官方文档。',
        true,
      ),
    ).toBe(AgentIntent.WEB);
  });

  it('联网关闭时不降成 web', () => {
    expect(inferIntentFallback('最新 GitHub release', false)).toBe(AgentIntent.KB);
  });

  it('寒暄 → chitchat', () => {
    expect(inferIntentFallback('谢谢', true)).toBe(AgentIntent.CHITCHAT);
  });

  it('web 意图不挂图谱', () => {
    expect(allowsGraph(AgentIntent.WEB)).toBe(false);
    expect(toolsForIntent(AgentIntent.WEB, { webEnabled: true, enableGraph: true })).toEqual([
      ToolName.WEB_SEARCH,
    ]);
    expect(
      initialToolsForIntent(AgentIntent.WEB, {
        webEnabled: true,
        enableGraph: true,
        wantGraph: true,
      }),
    ).toEqual([ToolName.WEB_SEARCH]);
  });
});
