# Agent / LangGraph / RAG 坑点

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
