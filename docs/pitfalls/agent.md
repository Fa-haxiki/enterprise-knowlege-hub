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

## 实体对齐：向量相似度分不开同指/非同指，需名称门控补召回

- **现象**：全量重建后「星云ERP项目」与「星云ERP升级项目」（cos 0.722）、「天枢软件科技有限公司」与「天枢软件」（0.639）、「智能工厂项目」与「智能工厂一期项目」（0.707）都低于 LLM 门槛 0.75 被直接新建，成为孤岛；而非同指的「财务组织架构与职责手册 vs 主要财务制度」反而有 0.739
- **根因**：对齐 embedding 文本是「名称（类型，又称别名）：描述」，不同文档对同一实体的描述差异会把同指对拉到 0.6~0.75，与非同指对重叠，任何固定余弦阈值都无法分离
- **修复（后改为纯 embedding）**：同指对靠「名称沾边 + `GRAPH_ALIGN_MERGE_COS`（默认 0.55）」自动合并，中英文完全不同写法靠 `GRAPH_ALIGN_AUTO_COS`（0.90）兜底；不再交 LLM 判定。观测方法：worker DEBUG 日志 `align candidates X: Y@score`
- **相关**：`apps/worker/src/pipelines/entity-aligner.ts#resolve`、`apps/api/src/modules/graph/entity-normalizer.ts`、`configuration.ts#graph.alignMergeCos`

## 对齐 LLM 把「描述不同」当「矛盾」，全称/简称判为不同实体

- **现象**：`align judge 天枢软件科技有限公司 ~ 天枢软件 (0.669): same=false conf=0.9 → KEEP`，明显的全称/简称对被小模型高置信判为不同
- **根因**：两侧描述来自不同文档（一个「承接智能工厂数据中台」、一个「服务星云ERP升级项目」），提示词只写了「描述矛盾判不同、拿不准判不同」，模型把「服务的项目不同」泛化为业务矛盾
- **修复**：`ALIGN_SYSTEM_PROMPT` 改为名称关系为首要依据，明确「描述是各文档的片面事实，不同≠矛盾（同一供应商服务多个项目是正常互补）」，并穷举什么算真正冲突（业务性质不同、同期职务冲突、明确标注不同期数/年份、制度主题不同）
- **相关**：`apps/worker/src/pipelines/entity-aligner.ts#ALIGN_SYSTEM_PROMPT`

## 抽取时注入的文档标题泄漏成实体/别名（编号、.pdf、《》、本办法）

- **现象**：图谱出现 Policy「06-2025年度全面预算方案」「财务组织架构与职责手册」，别名里混入「《03-供应商付款审批制度.pdf》」「本办法(费用部分)」「财务部（主责）」，同一制度因编号前缀不同分裂成两个节点
- **根因**：为解决分块后「本项目」指代不清，把 `《标题》> 章节路径` 前置进抽取输入，LLM 顺手把文件名当实体或别名输出；归一化只去装饰符号，不认识编号前缀和扩展名
- **修复**：`entity-normalizer.ts` 新增 `cleanEntitySurface`（去成对书名号/引号、`03-` 编号前缀、文件扩展名、尾部短括注）并在 `normalizeEntityName` 前置调用；`entity-extractor.ts` 对 name/aliases/关系端点统一清洗，新增 `SELF_REFERENCE_RE`（本办法/该项目/上述供应商）噪声过滤，提示词声明标题仅用于消歧。清洗必须同时作用于关系端点，否则端点与实体名对不上、关系落空
- **相关**：`apps/api/src/modules/graph/entity-normalizer.ts`、`apps/worker/src/pipelines/entity-extractor.ts`

## 对齐 LLM 借用 Embedding 的百炼 Key 报 403 Free quota exhausted

- **现象**：worker 对齐阶段 `align llm batch failed: 403 ... Free quota exhausted`，所有灰区实体对按「不同」处理，图谱重复节点激增
- **根因**：`GRAPH_LLM_API_KEY` 未配时回退用了 `EMBEDDING_API_KEY` 调 `qwen-flash`，该 Key 只开通了 Embedding 免费额度，不含 LLM 对话额度
- **修复**：`configuration.ts#graph.llm` 不再借用 Embedding Key；`LlmService.graphProfile()` 在未配 `GRAPH_LLM_API_KEY` 时回退主 LLM 的路由小模型（`LLM_ROUTER_MODEL`），独立百炼小模型改为可选覆盖（`.env.example` 注释说明）
- **相关**：`apps/api/src/config/configuration.ts`、`apps/api/src/modules/llm/llm.service.ts#graphProfile`

## LangGraph 节点超时降级后，原 Promise 迟到的回调仍推到前端

- **现象**：路由节点 10s 超时降级（`degraded: ['complexity_router']`）后，SSE 仍收到 status「复杂问题，启用图谱推理」，且出现在「混合检索完成」之后，而 graph_reason 实际未执行、`complexity` 为 null，前端阶段提示自相矛盾
- **根因**：`withTimeout` 用 `Promise.race` 只是放弃等待，节点内的 LLM 调用继续在后台完成并触发 `onStatus`；同理 graph_reason 超时后迟到的 `onGraphPath` 会渲染出答案没用到的子图
- **修复**：`agent.service.ts#wrap` 给节点传 `guardedConfig`：回调（onStatus/onToken/onCitation/onGraphPath）套 `alive` 闸门，节点抛错/超时后置 `alive=false`，迟到回调一律丢弃
- **相关**：`apps/api/src/modules/agents/agent.service.ts#wrap / guardedConfig`
