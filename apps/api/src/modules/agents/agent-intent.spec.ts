import { AgentIntent, Complexity, ToolName } from '@ekh/shared';
import {
  complexityFromIntent,
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
