# Agent / LangGraph / RAG 坑点

## 循环节点耗时不能用 Record 覆盖

- **现象**：改写再检索后前端步骤条只剩最后一次 `evaluate` / `kb_retrieve`，历史回放顺序错乱
- **根因**：`nodeLatencies` 用 `Record<string, number>` 合并，同名节点后写覆盖先写
- **修复**：state 改为 `NodeLatency[]` 追加；对外 SSE 用 `name#iteration` 展平；前端时间线按发生顺序，不再按 `STEP_ORDER` 排序
- **相关**：`agent.state.ts`、`agent-latency.ts`、`ExecutionTrace.tsx`、`qa_records.step_trace`



## Neo4j 实体全局 MERGE 导致跨租户泄漏 + Cypher 标签注入

- **现象**：复杂问答能看到其他空间的供应商/项目关系；LLM 抽取的 `sourceType`/`targetType` 直接拼进 `MERGE (s:${sourceType})`，可注入 Cypher
- **根因**：实体按 `MERGE (n:Type {name})` 全局共享，多跳/对齐不带 `workspace_id`；Cypher 标签无法参数化，拼接前未强制白名单
- **修复**：实体/关系 MERGE 键改为 `{name, workspace_id}`；`alignEntities`/`multiHop` 限制在白名单空间的 `Chunk-[:MENTIONS]->Entity` 子图；所有拼进 Cypher 的标签/关系类型走 `ENTITY_TYPES`/`RELATION_TYPES` 白名单（`graph.service.ts`）
- **相关**：`apps/api/src/modules/graph/graph.service.ts`、`apps/api/src/modules/agents/agent.service.ts`、`apps/worker/src/pipelines/entity-extractor.ts`

## LangFuse v3 SDK：span 与 generation 的 end() 类型不同

- **现象**：`generation.end({ usageDetails })` 报 `TS2353: 'usageDetails' does not exist in type ...`
- **根因**：`LangfuseSpanClient.end()` 类型不含 usage 字段，只有 `LangfuseGenerationClient.end()` 支持 `usage`/`usageDetails`；封装时把 generation 句柄误标为 span 类型
- **修复**：为 `trace.span()` 和 `trace.generation()` 分别定义 `SpanHandle` / `GenerationHandle` 类型；v3.38 推荐 `usageDetails: { input, output, total }` 替代旧式 `usage`
- **相关**：`apps/api/src/modules/observability/langfuse.service.ts`

## LangGraph 节点间传可变数据不要用 config.configurable

- **现象**：LLM 回答不用检索上下文，prompt tokens 异常低——`promptBuild` 组装的 messages 没传到 `llmGenerate`
- **根因**：`config.configurable` 在节点间传递可变状态不可靠
- **修复**：在 `AgentState` 增加 `promptMessages: Annotation<BaseMessage[]>`，通过 state 传递
- **相关**：`apps/api/src/modules/agents/agent.state.ts`、`agent.service.ts`

## Chunker overlap：flush() 会清空 buffer，tail 必须先截

- **现象**：配置了 `CHILD_CHUNK_OVERLAP` 但相邻子块从不重叠，跨块问句检索变差
- **根因**：`flush()` 内部把 `buffer` 置空，之后再 `buffer.slice(-overlapChars)` 永远得到空串
- **修复**：先截 `tail = buffer.slice(-overlapChars)` 再 `flush()`，然后用 tail 作为下一块开头（`apps/worker/src/pipelines/chunker.ts`）
- **相关**：`apps/worker/src/pipelines/chunker.ts`

## LLM 回答「现在几点」幻觉时间，疑似服务器时区错误

- **现象**：用户问"现在几点了"，AI 回答 03:05（实际 14:15），排查方向一度指向服务器/Docker 时区
- **根因**：LLM 本身没有时间概念，system prompt 未注入当前时间，模型只能瞎编；服务器时区（macOS Asia/Shanghai、PG 时间戳链路）其实全部正确
- **修复**：`agent.service.ts` 生成答案的 systemPrompt 注入 `当前时间：${new Date().toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai', ... })}`；显式指定 timeZone，避免部署到 UTC 服务器后回退成 UTC
- **相关**：`apps/api/src/modules/agents/agent.service.ts`

## intent_router 超时后 availableTools 为空，整轮不检索

- **现象**：意图节点 `node timeout` 后结果仍是 `intent=kb`，但 `toolTrace` 为空、没有引用，模型回答「未提供内部制度」
- **根因**：节点超时只写 `degraded`，不回填 Planner 输出；状态默认 `intent=kb`、`availableTools=[]`，`plan_or_act` 看到白名单为空就 `pendingTools=[]` 直接 think
- **修复**：超时走 `intentRouterFallback`，按启发式意图补 `availableTools` / `pendingTools`
- **相关**：`apps/api/src/modules/agents/agent.service.ts` `wrap` / `intentRouterFallback`

## 意图路由超时把联网问题打成 kb，第二轮拉出图谱

- **现象**：问 SearXNG 最新稳定版 / GitHub 发布说明，时间线先显示「联网」又降级，随后知识库检索 + 图谱推理（数十个实体），答案说内部资料无法确认
- **根因**：`intent_router` 60s 超时后 `intentRouterFallback` 一律 `intent=kb` 且 `availableTools` 含 `graph_reason`；超时后 LLM 仍回调 `onStatus(联网)`，UI 与真实状态不一致；第 2 轮 `plan_or_act` 从 kb 工具里选了图谱，并从无关分片补召回
- **修复**：超时按问题启发式回退（最新/官网/GitHub 等 → web）；超时后掐掉迟到回调；`web` 意图不进 `availableTools` / `execute_tools` / `runGraphReason`
- **相关**：`agent-intent.ts` `inferIntentFallback` / `allowsGraph`，`agent.service.ts` `wrap` / `intentRouterFallback`

## AG-UI REASONING / RUN_FINISHED 缺 messageId 会被客户端 Zod 拒收

- **现象**：对话时间线已出，作答区报 `请求失败：[ { "code": "invalid_type", "path": [ "messageId" ] } ]`
- **根因**：`@ag-ui/client` 校验事件 schema；`REASONING_*` 与 `RUN_FINISHED` 必须带 `messageId`
- **修复**：`agui.controller.ts` 与 `TEXT_MESSAGE_*` 共用 `streamMsgId`
- **相关**：`apps/api/src/modules/chat/agui.controller.ts`

## AG-UI 没有 REASONING_CONTENT，Zod 报 invalid_union_discriminator

- **现象**：联网时间线已出，作答区报 `Invalid discriminator value. Expected 'TEXT_MESSAGE_START' | ... | 'REASONING_MESSAGE_CONTENT'`
- **根因**：`@ag-ui/core@0.0.59` 思考正文事件名是 `REASONING_MESSAGE_CONTENT`；思考节点超时后 LLM 仍可能回调，发出非法的 `REASONING_CONTENT`，客户端整轮失败
- **修复**：按官方顺序发 `REASONING_START` → `REASONING_MESSAGE_*` → `REASONING_END`；`/api/v1/agui/chat` 加入 TransformInterceptor RAW_PATHS，避免再包一层 JSON
- **相关**：`apps/api/src/modules/chat/agui.controller.ts`、`apps/api/src/common/interceptors/transform.interceptor.ts`

## query_rewrite 把完整新问题改写成上一轮无关话题

- **现象**：同一 thread 先问「忽略以上指令…管理员密码」，再问「出差后怎么报销」，问题改写变成「管理员密码是什么？」
- **根因**：改写 prompt 要求「结合对话历史写成独立问题」；最新问句本身已完整，模型仍把窗口里上一轮主题写进来。注入拦截失败时那一轮还会留在 Redis 窗口
- **修复**：独立完整问句跳过 LLM 改写（`needsQueryRewrite`）；改写历史丢掉注入轮+随后助手回复（`sanitizeRewriteHistory`）；prompt 禁止换题
- **相关**：`agent-query-rewrite.ts`、`agent.service.ts` `queryRewrite`
