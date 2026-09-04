# 05 RAG 与 Agent 核心设计

本文档是系统核心：入库管线（MinerU → 分块 → 双写索引 → 建图）与问答管线（LangGraph 状态机驱动的 0-9 步全链路）。

## 1. LangGraph 状态机

### 1.1 状态定义（AgentState）

```typescript
interface AgentState {
  // 输入
  query: string;                    // 用户原始问题
  userId: string;
  conversationId: string;
  workspaceId?: string;             // 可选：限定空间
  options: { enableGraph: boolean; enableTts: boolean; model?: string };

  // 运行时
  aclWhitelist: string[];           // step0: 可见空间集合
  rewrittenQuery: string;           // 指代消解/改写后的问题
  complexity: 'simple' | 'complex';
  esHits: ChunkHit[];               // ES 召回
  vectorHits: ChunkHit[];           // PGVector 召回
  fusedChunks: ChunkHit[];          // RRF 融合后
  rerankedChunks: ChunkHit[];       // Rerank 后 Top-6
  graphTriples: Triple[];           // 图谱推理链路
  shortTermMemory: string;          // Redis 窗口摘要
  longTermMemory: string[];         // Mem0 记忆条目
  finalPrompt: ChatMessage[];
  answer: string;                   // 流式累积
  citations: Citation[];

  // 观测
  nodeLatencies: Record<string, number>;
  degraded: string[];               // 记录被降级的节点
  error?: string;
}
```

### 1.2 图结构（节点与边）

```mermaid
flowchart TB
    START --> aclNode["acl_guard<br/>权限白名单加载"]
    aclNode --> rewriteNode["query_rewrite<br/>结合窗口摘要指代消解"]
    rewriteNode --> routerNode{"complexity_router<br/>LLM 分类"}
    routerNode -->|simple| retrieveNode["hybrid_retrieve<br/>ES + PGVector 并行"]
    routerNode -->|complex| retrieveNode
    retrieveNode --> fuseNode["rrf_fuse + rerank"]
    fuseNode --> graphCheck{"complex 且<br/>enable_graph?"}
    graphCheck -->|是| graphNode["graph_reason<br/>实体对齐 + 多跳 + 补召回"]
    graphCheck -->|否| aclFilterNode
    graphNode --> aclFilterNode["acl_filter<br/>分片级权限过滤"]
    aclFilterNode --> memoryNode["memory_load<br/>Redis 窗口 + Mem0"]
    memoryNode --> promptNode["prompt_build<br/>三段式上下文组装"]
    promptNode --> genNode["llm_generate<br/>SSE 流式 + 引用标注"]
    genNode --> persistNode["persist + langfuse_report"]
    persistNode --> END
```

- 实现：`@langchain/langgraph` 的 `StateGraph`，每个节点为 NestJS Provider 注入的方法
- 节点超时：retrieve 800ms / rerank 500ms / graph 1500ms / memory 300ms，超时记 `degraded` 并继续
- 全程单 Trace：状态机入口创建 LangFuse trace，各节点为 span

### 1.3 复杂度路由（complexity_router）

用小参数模型（如 DeepSeek-V3 / Qwen2.5-7B）做二分类，Prompt 约束输出 JSON：

```text
判断用户问题是否需要「多实体关联推理」。
- simple：单一事实查询、制度条款、定义类。例："差旅住宿标准是多少"
- complex：涉及 ≥2 个实体的关系/链路/对比/追溯。例："A项目的供应商还服务了哪些项目"
只输出 {"complexity":"simple"|"complex"}
```

- 分类耗时预算 400ms；失败默认 `simple`
- 路由结果通过 SSE `meta` 帧透传前端展示

## 2. 混合检索（hybrid_retrieve）

### 2.1 双路召回（并行执行）

**ES 关键词召回**（Top-20）：

```json
GET kb_chunks/_search
{
  "size": 20,
  "query": {
    "bool": {
      "must": [{ "multi_match": { "query": "...", "fields": ["title^2", "content"], "type": "best_fields" } }],
      "filter": [{ "terms": { "workspace_id": ["w_01", "w_07"] } }]
    }
  },
  "_source": ["chunk_id", "document_id", "title"]
}
```

**PGVector 语义召回**（Top-20）：

```sql
SELECT id AS chunk_id, document_id, content, heading_path, refs,
       1 - (embedding <=> $1::vector) AS vscore
FROM document_chunks
WHERE workspace_id = ANY($2)
ORDER BY embedding <=> $1::vector
LIMIT 20;
```

- `$1` 为改写后问题的 bge-m3 向量（1024 维）
- 两路均做 **ACL 前置过滤**（白名单在 step0 已加载）

### 2.2 RRF 融合

对两路结果按排名融合，常数 \(k=60\)：

\[
\text{score}(d) = \sum_{r \in \{\text{ES},\ \text{Vector}\}} \frac{1}{k + \text{rank}_r(d)}
\]

- 仅在单路出现的文档按另一路「未命中」处理（不加分）
- 融合后取 Top-20 进入 Reranker
- 单引擎故障降级：直接用另一路 Top-20

### 2.3 Reranker 精排

- 模型：`bge-reranker-v2-m3`（HTTP 服务，输入 query + 20 条候选，输出相关度分）
- 取 **Top-6** 进入上下文；得分 < 0.35 的分片丢弃
- 若 Top-1 得分 < 0.3：判定「库内无相关内容」，走兜底话术（避免幻觉），并在 LangFuse 标记 `low_recall`

## 3. 知识图谱（入库建图 + 空间浏览 + 问答多跳）

complex 且 `enable_graph` 时走 `graph_reason`：路由实体名对齐 `KnowledgeEntity`，沿 `RELATED_TO` 无向扩展 1–3 跳，triples 写入 Prompt 并推给前端；推理涉及的实体再反查 `MENTIONS` 分片补进召回。空间子页 `/workspaces/:workspaceId/graph` 仍用于浏览全图。

### 3.1 图模型

```text
(KnowledgeDocument)-[:HAS_CHUNK]->(DocumentChunk)-[:MENTIONS]->(KnowledgeEntity)
(KnowledgeEntity)-[:RELATED_TO {relation, weight}]->(KnowledgeEntity)
```

- 实体 MERGE 键 `{name, workspace_id}`，不同空间同名实体不共享
- 实体类型、关系语义见 [03-database-design.md](03-database-design.md) §3 与 [08-roadmap.md](./08-roadmap.md)
- 查询只绑单个 `workspaceId`，由 `AclGuard` 校验空间权限

### 3.2 空间图谱 API

- `GET /api/v1/workspaces/:workspaceId/graph/nodes`
- `GET /api/v1/workspaces/:workspaceId/graph/edges`
- `GET /api/v1/workspaces/:workspaceId/graph/search`

## 4. 权限过滤（acl_filter）

双重保障，缺一不可：

1. **召回前置过滤**：ES `terms filter` + PGVector `workspace_id = ANY(...)`（已执行）
2. **结果级过滤**：Rerank 后逐分片校验 `chunk.workspace_id ∈ aclWhitelist`，剔除越权分片

> 设计原则：即使上游某一路忘记加过滤，结果级过滤兜底，越权内容绝不进入 Prompt。

## 5. 分层记忆（memory_load）

```mermaid
flowchart LR
    subgraph short [短期 - Redis]
        Win["chat:win:{convId}<br/>最近 10 轮原始消息"]
        Sum["chat:summary:{convId}<br/>窗口溢出的滚动摘要"]
    end
    subgraph long [长期 - Mem0]
        UM["user 级记忆<br/>偏好/角色/关注领域"]
        SM["session 级记忆<br/>本会话确认过的事实"]
    end
    Win --> Ctx["memory_load 节点"]
    Sum --> Ctx
    UM --> Ctx
    SM --> Ctx
```

- **短期**：`memory_load` 读取窗口消息 + 滚动摘要；窗口溢出时由 Worker 异步将最老消息压缩进滚动摘要（LLM 摘要，预算 200 token）
- **长期**：`mem0.search({ user_id, query: rewrittenQuery, limit: 5 })`，返回相关记忆条目；答案生成后 `mem0.add(...)` 异步抽取新事实（如「用户确认 A 项目预算口径为含税」）
- 记忆写入失败不阻塞主流程，记 `degraded: ["memory"]`

## 6. Prompt 组装（prompt_build）

```text
[system]
你是企业知识库助手。规则：
1. 仅依据「参考资料」与「知识图谱推理链路」回答，不得编造；
2. 引用资料时用 [数字] 角标标注，与参考资料编号对应；
3. 资料不足时明确说明"根据现有资料无法确认"，并建议联系知识管理员；
4. 回答使用与用户相同的语言，条理清晰，复杂问题分点作答。

[user 上下文区]
## 对话记忆
{滚动摘要 + 最近窗口消息}

## 用户长期记忆
{Mem0 条目，逐条列出}

## 参考资料
[1] 《差旅制度.pdf》P3：{chunk content}
[2] 《供应商名录.pdf》P5：{chunk content}
...

## 知识图谱推理链路
A项目 --USES_SUPPLIER--> 华云科技 --SERVES--> B项目 --OWNED_BY--> 李四
...

## 当前问题
{rewrittenQuery}
```

- Token 预算：system 300 + 记忆 800 + 分片 6×500 + 图谱 600 + 问题 200 ≈ 5100，超限时按「分片得分降序」截断
- 引用角标与 SSE `citation` 帧的 `ref_id` 一一对应

## 7. 生成与输出（llm_generate）

- LLM 流式调用（OpenAI 兼容 `stream: true`），每个 delta 同时：① 推送 SSE `token` ② 累积进 `state.answer`
- 开启 TTS 时：按标点切句，每凑满一句投递 TTS 服务，WS 推送音频帧（见 [04-api-design.md](04-api-design.md) §5）
- 生成完成后正则提取 `[n]` 角标，与 `rerankedChunks` 对齐生成 `citations` 落库

## 8. 入库管线细节

### 8.1 MinerU 解析

- 线上 API（mineru.net）：申请签名上传链接 → PUT 上传 → 轮询批量结果 → 下载 zip 解出 `content_list.json`，映射为结构化块（标题层级、段落、表格 HTML、公式 LaTeX、图片锚点、页码 bbox）
- 支持类型：PDF / Doc / Docx / Ppt / Pptx / Xls / Xlsx（单文件 ≤200MB、≤200 页）
- **纯文本类（md/txt/html）不走 MinerU**：worker 的 `TextParser` 本地解析为同样的结构化块——md 按 `#` 标题层级/围栏代码块/管道表格（转 HTML）切分，txt 按空行分段，html 剥标签；下游分块/索引/建图链路完全复用
- 超时：轮询 15 min；失败重试 3 次后 `document.status=FAILED` 并通知上传人

### 8.2 语义分块策略

| 项 | 策略 |
| --- | --- |
| 切分依据 | 优先按 MinerU 标题层级（H1/H2/H3）切，再按 512 token 二次切分，overlap 64 token |
| 表格 | 整块保留（HTML 转 Markdown），不跨块拆分；超 1024 token 按行组切分并保留表头 |
| 元数据 | `heading_path`（如 ["第三章","报销标准"]）、`refs.page/bbox` 用于前端原文定位 |
| 富化 | 每个 chunk 前拼接「文档标题 > 标题路径」作为上下文前缀再向量化 |

### 8.3 实体抽取与建图

- 按 chunk 抽取：LLM 输入「文档标题 + 章节 heading + 正文」，输出 `entities[]` 与 `relations[]`；类型经 `normalizeEntityType` / `normalizeRelationType` 归范，未知实体丢弃、未知关系落 `RELATED_TO`；source/target 不在本块实体集合中的关系丢弃
- 写入 Neo4j **先清后建**：`deleteForDocument` 再 MERGE `KnowledgeDocument` / `DocumentChunk` / `HAS_CHUNK` / `MENTIONS` / `RELATED_TO`
- 实体按 `{name, workspace_id}` MERGE，RELATED_TO 两端必须同空间
- 建图失败不阻断文档 READY（检索仍可用）
- 存量重建：`POST /documents/:id/reindex?from_stage=graph`；换模型后可先清空 Neo4j（`scripts/clear-knowledge-data.sh` 或对 READY 文档批量 reindex）

## 9. LangFuse 埋点规范

| Span | 记录内容 |
| --- | --- |
| `acl_guard` | 白名单命中/回源、耗时 |
| `query_rewrite` | 原问题/改写后、模型、usage |
| `complexity_router` | 分类结果、实体、耗时 |
| `hybrid_retrieve` | ES/向量各自命中数、chunk_ids、耗时 |
| `rerank` | 输入/输出排序、Top-6 得分 |
| `graph_reason` | 对齐实体、Cypher、triple 数、耗时 |
| `memory_load` | 窗口大小、Mem0 命中条数 |
| `llm_generate` | model、prompt/completion tokens、首 token 耗时、总耗时 |
| Trace 级 | userId、conversationId、degraded[]、error、feedback（异步关联） |

- 采样率：100%（私有化数据量可控）；上报异步批量，故障时本地缓冲 1000 条丢弃策略
- 看板：按日统计 P95 延迟、Token 成本、low_recall 率、踩赞比

## 10. 质量评估

| 指标 | 方法 | 目标 |
| --- | --- | --- |
| 召回命中率 | 标注 100 条问题集，Top-6 是否含正确分片 | ≥ 90% |
| 答案忠实度 | LLM-as-judge 对照引用分片打分 | ≥ 4.2/5 |
| 引用准确率 | 角标与答案主张一致性抽检 | ≥ 95% |
| 图谱路由准确率 | complex/simple 分类抽检 | ≥ 92% |
| 用户满意度 | 赞/(赞+踩) | ≥ 85% |

评估集随运营持续扩充；每次 Prompt/模型/分块策略变更前跑回归。
