# 前端改造方案：AG-UI 协议适配 + UI 视觉重构

> 日期：2026-08-30　状态：待评审
> 背景：当前前端功能完整但视觉简陋（灰白工程师风格）；问答 SSE 协议为自定义事件，拟对齐 AG-UI 开放标准。

## 1. AG-UI 协议适配

### 1.1 协议概述

AG-UI（Agent–User Interaction Protocol）是 CopilotKit 联合 LangChain 等推出的开放标准，定义 Agent 后端与前端之间的双向事件流。核心约定：

- **传输**：HTTP POST + SSE，事件为 JSON（`type` 字段区分）
- **输入**：`RunAgentInput { threadId, runId, messages, tools, context, state }`
- **16 种标准事件**，分四类：
  - 生命周期：`RUN_STARTED` / `RUN_FINISHED` / `RUN_ERROR` / `STEP_STARTED` / `STEP_FINISHED`
  - 文本消息：`TEXT_MESSAGE_START` / `TEXT_MESSAGE_CONTENT` / `TEXT_MESSAGE_END`
  - 工具调用：`TOOL_CALL_START` / `TOOL_CALL_ARGS` / `TOOL_CALL_END`
  - 状态同步：`STATE_SNAPSHOT` / `STATE_DELTA` / `MESSAGES_SNAPSHOT`
  - 扩展：`RAW` / `CUSTOM`

### 1.2 现有协议 → AG-UI 事件映射

| 现有 SSE 事件 | AG-UI 事件 | 说明 |
|---|---|---|
| `meta`（conversation_id） | `RUN_STARTED { threadId, runId }` | 会话/运行标识 |
| `status`（节点进度文本） | `STEP_STARTED` / `STEP_FINISHED { stepName }` | 检索/图谱/记忆/生成各节点，驱动步骤可视化 |
| `token`（增量文本） | `TEXT_MESSAGE_START` → `TEXT_MESSAGE_CONTENT { delta }` ×N → `TEXT_MESSAGE_END` | 文本流三段式 |
| `citation` | `CUSTOM { name: "citation", value }` | 引用分片 |
| `graph_path` | `CUSTOM { name: "graph_path", value }` | 图谱推理链路 |
| `usage` | `CUSTOM { name: "usage", value }` | Token 用量 |
| `error` | `RUN_ERROR { message }` | 错误 |
| `done` | `RUN_FINISHED` | 完成 |

### 1.3 后端改造

新增适配层而非替换现有协议（保留旧端点兼容）：

- 新端点：`POST /api/v1/agui/chat`，接受 `RunAgentInput` 风格入参（`threadId` ↔ conversation_id，`messages` 末条为 query）
- 实现：`AguiEncoder` 将 `AgentService.run()` 的节点回调与 token 流转译为上述事件流
- LangGraph 节点包装器（现有 `wrap()`）内增发 `STEP_STARTED/STEP_FINISHED`，前端即可获得**每个节点的实时进度**，这是当前 `status` 文本事件的结构化升级

### 1.4 前端接入

| 选项 | 做法 | 取舍 |
|---|---|---|
| A（推荐） | 引入 `@ag-ui/client` 的 `HttpAgent` | 真正遵循标准，未来可换接任何 AG-UI Agent；事件处理用其 subscriber 机制 |
| B | 保留自研 `sseStream`，仅改事件名映射 | 改动最小，但只是"同名"而非"遵标" |

推荐 A：依赖体积小（纯 client 无 UI 绑定），且后续若引入 CopilotKit 组件可无缝衔接。

## 2. UI 视觉重构

### 2.1 现状问题（基于当前截图）

- 无品牌色：全站 slate 灰，视觉层级弱
- 侧边栏深色与主区浅色对比突兀、无过渡
- 引用/图谱面板为纯文本堆叠，信息密度低
- 节点进度只有一行小字，Agent 工作过程不可感知
- 无骨架屏/空状态/微动效

### 2.2 设计系统（Design Tokens）

```css
:root {
  /* 品牌主色：靛蓝系（专业感 + 与图谱推理徽章同族） */
  --brand-50: #eef2ff; --brand-100: #e0e7ff; --brand-500: #6366f1;
  --brand-600: #4f46e5; --brand-700: #4338ca;
  /* 中性色：暖灰替代冷灰 slate，降低"工程师感" */
  --surface: #fafaf9; --surface-card: #ffffff; --border: #e7e5e4;
  /* 圆角 / 阴影 */
  --radius-bubble: 16px; --radius-card: 12px;
  --shadow-card: 0 1px 3px rgb(0 0 0 / 0.06), 0 4px 12px rgb(0 0 0 / 0.04);
}
```

字体：中文系统字栈 + `font-feature-settings: "tnum"`（数字等宽，引用编号对齐）。

### 2.3 对话页重构（核心）

1. **Agent 步骤可视化**（AG-UI STEP 事件驱动）
   - 回答生成前显示步骤条：`检索分片 → 重排 →（图谱推理）→ 生成回答`
   - 每步：图标 + 名称 + 耗时（STEP_FINISHED 携带），进行中旋转、完成打勾
   - 替代现有单行 statusText
2. **消息气泡**
   - 用户：右侧，品牌色渐变气泡，白字
   - AI：左侧全宽卡片（白底 + 柔和阴影 + 圆角），头像位放 Agent 图标
   - 流式时光标 `▍` 呼吸闪烁
3. **引用面板**：卡片化——文档图标 + 标题 + 页码徽章 + snippet 两行截断，hover 展开；点击可跳文档（后续）
4. **图谱链路**：横向节点流 `A —关系→ B —关系→ C`，节点用胶囊徽章，替代当前逐行文本
5. **TTS 播放**：播放中句子高亮改为品牌色底（当前黄色突兀），播放器按钮收入消息操作栏

### 2.4 其余页面

- **侧边栏**：改浅色（与主区统一），对话分组（今天/昨天/7 天内/更早），顶部搜索框，hover 操作按钮淡入
- **文档页**：上传区改虚线拖拽卡片（drag-over 高亮），文档列表卡片化（状态徽章彩色化：READY 绿/PARSING 蓝/FAILED 红）
- **登录页**：左侧品牌区（产品名 + 一句话介绍 + 渐变背景），右侧表单卡片
- **空状态**：对话空态加引导问题卡片（点击直接提问）；文档空态加上传引导
- **骨架屏**：对话列表、消息历史、文档列表加载时 shimmer 占位

### 2.5 可选增强（二期）

- 暗色模式（`prefers-color-scheme` + 手动开关，CSS 变量已就绪）
- CopilotKit 组件评估（若采用，AG-UI 适配层直接复用）

## 3. 实施分期

| 阶段 | 内容 | 预计工作量 |
|---|---|---|
| P1 | 设计 Tokens + 对话页重构（气泡/步骤条/引用卡片/图谱胶囊） | 1-1.5 天 |
| P2 | AG-UI 后端适配端点 + 前端 `@ag-ui/client` 接入 | 1 天 |
| P3 | 侧边栏/文档页/登录页/空状态/骨架屏 | 1 天 |
| P4 | 暗色模式 + 细节打磨 | 0.5 天 |

P1 与 P2 可并行（前端先用映射层模拟 STEP 事件）。

## 4. 验收标准

- 问答全流程 STEP 事件驱动步骤条，节点耗时可感知
- `POST /agui/chat` 输出符合 AG-UI 16 事件规范（用协议示例事件流校验）
- 视觉：对话页达到现代 Agent 产品水准（参照 ChatGPT/Claude 信息层级），全站 Tokens 统一
- 旧 SSE 端点保持可用（兼容期），前端可随时切回
