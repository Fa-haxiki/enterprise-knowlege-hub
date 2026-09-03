# Agent / LangGraph / RAG 坑点

## 关系两端类型配对错误：供应商 SERVES 人名，产生孤岛链路

- **现象**：图谱里出现「华云科技 -SERVES→ 钱志远/黄晓薇」这种供应商直连人名的独立链路，与主链路（供应商→项目→负责人）不连通
- **根因**：LLM 把「供应商服务的项目的负责人是 X」误抽成「供应商 SERVES X」（Supplier→Person）；`SERVES` 的 target 应是 Project，抽取时未校验关系两端的类型配对
- **修复（治本）**：`entity-extractor.ts` 加 `RELATION_SIGNATURE` 关系签名表（每种关系合法的 sourceType→targetType 配对，如 SERVES 只允许 Supplier→Project、OWNED_BY 允许 Project→Person/Department），`isValidRelation` 校验不合法即丢弃；提示词给出每种关系的类型约束 + 「供应商服务的项目负责人是X 应拆成 SERVES 项目 + 项目 OWNED_BY X 两条」的示例
- **相关**：`apps/worker/src/pipelines/entity-extractor.ts`

## 泛化词/子任务被抽成实体，图谱出现不连通的孤岛链路

- **现象**：问「X 项目供应商还服务了哪些项目」，图谱除主链路外还有独立孤岛：「项目→财务相关供应商→项目」「ERP费控实施→华云科技」，与主链路不连通
- **根因**：LLM 抽取时把泛化类别词（项目/供应商/系统/负责人）和子任务名（ERP费控实施）当成实体入库；这些泛化节点成为「枢纽」，把语义无关的实体串成孤立子图
- **修复（治本）**：`entity-extractor.ts` 加 `STOP_ENTITY_NAMES` 黑名单 + `isNoiseEntity`（黑名单命中或去空格 <2 字即噪声），实体与关系两端命中即丢弃；提示词明确「实体必须是具体可辨识的专有名称，禁止抽取泛化类别词/子任务名」。修复后需清空 Neo4j 并对所有 READY 文档跑 `fromStage=graph` 重建
- **重建注意**：`rebuildGraphOnly` 需先 `deleteByDocument` 清旧图再 MERGE（否则残留噪声）；且抽取要走与 buildGraph 相同的并发 worker pool——串行逐 chunk 打 LLM 在大文档上会卡死（stalled）
- **相关**：`apps/worker/src/pipelines/entity-extractor.ts`、`apps/worker/src/processors/ingestion.processor.ts#rebuildGraphOnly`

## 多跳用无向扩展导致图谱发散出多条不相关链路

- **现象**：问「X 项目供应商还服务了哪些项目，负责人是谁」，图谱渲染出 4 条链路，含「鼎信会计师事务所→公司整体年报审计→陈思远」这种与主链无关的孤岛
- **根因**：`multiHop` 用 `MATCH path=(n)-[*1..3]-(m)` **无向**扩展，把起点实体的所有邻居（含入边方向的供应商）都捞回来，每个供应商再扩散出自己的所有项目，图爆炸成多个子图。仅做连通性过滤（BFS）无效——鼎信通过「星云 USES_SUPPLIER 鼎信」与主链连通，其子链仍被判可达
- **修复**：改无向 `-[*1..3]-` 为**有向出边** `-[*1..3]->`。语义链「项目-USES_SUPPLIER→供应商-SERVES→其他项目-OWNED_BY→负责人」全是出边方向，沿语义链走；而「鼎信-SERVES→星云」是指向起点的入边，不作为起点向外扩散，孤岛自然不出现
- **关键认知**：图谱多跳扩展方向必须与语义链方向一致；无向扩展会把「指向起点的实体」也当起点二次扩散，是发散根源
- **相关**：`apps/api/src/modules/graph/graph.service.ts#multiHop`

## 图谱多跳无差别扩展所有关系，发散出与问题无关的节点

- **现象**：问「X 项目的供应商还服务了哪些项目，负责人是谁」，返回的图谱里混进通过 `GOVERNED_BY`（受政策约束）边间接连入的其他项目/制度节点，出现两个不相关的子图
- **根因**：`multiHop` 对 `type(rel)` 只排除 `MENTIONS`，`SERVES`/`OWNED_BY`/`GOVERNED_BY` 等所有关系无差别扩展 ≤3 跳；政策/制度节点成为「枢纽」，把语义上不相关的实体串进推理链路
- **修复**：路由阶段（complexity_router）让 LLM 额外输出该问题意图涉及的关系类型 `relations`（从 `RELATION_TYPES` 白名单选），存入 `state.routerRelations`；`multiHop` 增加 `relationTypes` 参数并在 Cypher 加 `type(rel) IN $relTypes` 过滤，只沿意图相关关系扩展；LLM 输出强制 `RELATION_TYPES` 白名单校验
- **相关**：`apps/api/src/modules/agents/agent.service.ts`（complexityRouter / graphReason）、`agent.state.ts`（routerRelations）、`graph.service.ts`（multiHop relFilter）

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
