# Agent / LangGraph / RAG 坑点

## LangGraph 节点间传可变数据不要用 config.configurable

- **现象**：LLM 回答不用检索上下文，prompt tokens 异常低——`promptBuild` 组装的 messages 没传到 `llmGenerate`
- **根因**：`config.configurable` 在节点间传递可变状态不可靠
- **修复**：在 `AgentState` 增加 `promptMessages: Annotation<BaseMessage[]>`，通过 state 传递
- **相关**：`apps/api/src/modules/agents/agent.state.ts`、`agent.service.ts`
