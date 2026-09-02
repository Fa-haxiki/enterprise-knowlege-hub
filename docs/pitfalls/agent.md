# Agent / LangGraph / RAG 坑点

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

- **现象**：配置了 `CHUNK_OVERLAP` 但相邻 chunk 从不重叠，跨块问句检索变差
- **根因**：`flush()` 内部把 `buffer` 置空，之后再 `buffer.slice(-overlapChars)` 永远得到空串
- **修复**：先截 `tail = buffer.slice(-overlapChars)` 再 `flush()`，然后用 tail 作为下一块开头（`apps/worker/src/pipelines/chunker.ts`）
- **相关**：`apps/worker/src/pipelines/chunker.ts`

## LLM 回答「现在几点」幻觉时间，疑似服务器时区错误

- **现象**：用户问"现在几点了"，AI 回答 03:05（实际 14:15），排查方向一度指向服务器/Docker 时区
- **根因**：LLM 本身没有时间概念，system prompt 未注入当前时间，模型只能瞎编；服务器时区（macOS Asia/Shanghai、PG 时间戳链路）其实全部正确
- **修复**：`agent.service.ts` 生成答案的 systemPrompt 注入 `当前时间：${new Date().toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai', ... })}`；显式指定 timeZone，避免部署到 UTC 服务器后回退成 UTC
- **相关**：`apps/api/src/modules/agents/agent.service.ts`
