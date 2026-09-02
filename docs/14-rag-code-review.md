# 14 RAG 全链路代码审查报告

- **日期**：2026-09-02
- **审查人**：RAG 开发工程师（对照实现与 `docs/05-rag-pipeline.md`、`docs/06-security-permissions.md`）
- **范围**：入库（解析/分块/嵌入/建图）、混合检索、LangGraph Agent、记忆、权限 ACL、认证、图谱、对话 SSE/AG-UI、前端引用展示
- **方法**：按模块通读实现，交叉对照设计文档；关键 P0/P1 均回源码核对行号。**未改代码。**

---

## 1. 总体结论

检索侧 workspace ACL（ES `terms` + PGVector `ANY` + 结果级过滤）和会话归属校验是扎实的。真正的缺口集中在四类：

1. **图谱是跨租户的**：实体全局 `MERGE`，多跳推理不带 `workspace_id`，三元组直接进 Prompt。
2. **设计文档写了、代码没落地**：资料沙箱、`acl_stripped` 审计、空结果硬拒答、Token 预算截断、Refresh HttpOnly、禁用即吊销。
3. **双写索引生命周期不一致**：软删后向量路能挡住，ES 路与 `fillContent` 挡不住；删除与入库可并发把已删文档写回。
4. **生成链路 fail-open**：改写超时变成空查询、检索为空仍生成、节点失败只标 `degraded` 却照样 `DONE`。

企业 RAG 的核心承诺是「只根据有权限的资料回答、资料不足就承认」。当前实现在分片 ACL 上接近该承诺，在图谱、拒答门闩、注入隔离上尚未达到。

| 级别 | 数量 | 含义 |
|------|------|------|
| P0 | 5 | 可导致越权泄漏、注入写图、身份伪造或已删数据复活 |
| P1 | 26 | 安全窗口、幻觉、质量崩溃或与设计严重偏离，应尽快修 |
| P2 | 24 | 质量/合规/运维缺陷，影响召回与可维护性 |
| P3 | 8 | 体验与文档对齐问题 |
| 合计 | 63 | 分模块表已去重；P0+P1 共 31 项为优先闭环范围 |

优先修复顺序见 [§8](#8-修复路线图)。

---

## 2. P0 发现（必须先修）

### P0-1 图谱多跳无租户隔离，跨空间关系泄漏进答案

- **位置**：`apps/api/src/modules/graph/graph.service.ts:44-90`；调用 `apps/api/src/modules/agents/agent.service.ts:316-324,381-384`
- **现象**：`alignEntities` / `multiHop` 按全局实体名匹配与扩跳，Cypher 无 `workspace_id` 条件。返回的 triples 写入 Prompt「知识图谱推理链路」，并经 SSE `GRAPH_PATH` 推给前端。图增强取 chunk 有 ACL（`chunksByEntities`），**三元组路径本身没有**。
- **根因**：建图时 `MERGE (n:Type {name})` 全局共享节点；查询侧只按 name 扩展。
- **影响**：用户 A 在自己的空间问「A 项目的供应商还服务了哪些项目」，可能得到其他空间的供应商–项目–人员关系，即使看不到原文。
- **修复**：
  1. 实体/关系带 `workspace_id`（或 `(ws)-[:HAS_ENTITY]->(n)` 边界）。
  2. `multiHop` / `alignEntities` 限制在白名单空间的 `Chunk-[:MENTIONS]->Entity` 子图。
  3. 出站 triples 再按边的 `source_chunk_id` 所属 workspace 过滤。

### P0-2 Cypher 动态标签/类型拼接，LLM 输出可注入

- **位置**：
  - 建图：`graph.service.ts:152-160`（`MERGE (s:${sourceType})` / `(t:${targetType})` / `[rel:${relation}]`）
  - 对齐：`graph.service.ts:50`（`MATCH (n:${e.type})`）
  - 抽取校验：`apps/worker/src/pipelines/entity-extractor.ts:51-55`
- **现象**：实体 `type` 在抽取后有 `ENTITY_TYPES` 白名单；**关系的 `sourceType`/`targetType` 没有**。问答路由的 `routerEntities` 也未校验 type，直接拼进 `alignEntities`。
- **根因**：Cypher 标签不能参数化，但拼接前未强制白名单。`relation` 仅 `/^[A-Z_]+$/`，标签侧可插入 `Person) DETACH DELETE n //` 一类字符串。
- **影响**：恶意文档或被注入的路由器输出可删图、写任意标签、污染 schema。
- **修复**：`sourceType`/`targetType`/`e.type` 必须 ∈ `ENTITY_TYPES`；`relation` 用封闭枚举；拒绝即丢弃该条，禁止拼接未校验字符串。

### P0-3 禁用/降权后 Access Token 仍可用；`revokeAll` 无人调用

- **位置**：`apps/api/src/modules/auth/guards/jwt-auth.guard.ts:39-46`；`admin.service.ts:140-157`；`auth.service.ts:115-124`
- **现象**：Guard 只验 JWT 签名与过期，不查 `disabledAt`、不回源角色。禁用/改角色不调用已有的 `revokeAll`。Refresh 路径会查禁用状态，但 Access 最长约 2 小时。
- **影响**：已禁用账号可继续调问答/下载；被降级的 sysadmin 在 Access 有效期内仍可打管理接口。
- **修复**：禁用/改角色时 `revokeAll`；Guard 查 Redis 吊销集或短 TTL 用户状态；管理接口不信任 JWT 内 `role`，回源 DB。

### P0-4 默认 JWT Secret 可伪造任意用户

- **位置**：`apps/api/src/config/configuration.ts:10`；`apps/api/src/database/seed-admin.ts`（种子口令 `admin123456`）
- **现象**：`JWT_SECRET` 缺省 `dev-secret-change-me`；生产若未覆盖，即可签发任意 `sub`/`role`。
- **影响**：完全绕过认证与 RBAC。
- **修复**：`NODE_ENV=production` 时拒绝弱 secret 并拒绝启动；种子账号强制改密或一次性 token。

### P0-5 删除与入库并发：已删文档可被写回索引

- **位置**：`documents.service.ts:294-300`；`ingestion.processor.ts:82-157`；`ingestion.producer.ts`
- **现象**：`remove` 只打 `deletedAt` 再入队；进行中的 ingest 只在 **开头** 检查 `deletedAt`，解析/embed/写 ES 过程中不再校验。同 `documentId` 可并存多 job，无 `jobId` 去重。
- **影响**：purge 清完后旧 job 仍可写 PG/ES/Neo4j 并标 `READY`。对象存储可能已删，检索侧文档「复活」。
- **修复**：`jobId: ingest:${documentId}` 去重；各阶段写前再读 `deletedAt`；删除时取消该文档未完成 job；purge 带 generation/版本号。

---

## 3. 分模块发现

### 3.1 入库（解析 / 分块 / 嵌入 / 双写）

| ID | 级 | 标题 | 位置 | 要点 |
|----|----|------|------|------|
| P1-I1 | P1 | 软删后、purge 前 ES 仍可搜 | `es.service.ts:56-84`；`documents.service.ts:294-299` | 向量路有 `deleted_at IS NULL`，ES 路与搜索页没有。purge 失败被 `.catch` 吞掉。 |
| P1-I2 | P1 | FAILED / 非 READY 分片仍可检索 | `retrieval.service.ts:92-114`；`ingestion.processor.ts:129-144` | 先写索引再标 READY；ES 失败时 PG 已有 chunk。召回不过滤 `status=READY`。 |
| P1-I3 | P1 | MIME 只信客户端，解析看扩展名 | `documents.service.ts:15-44`；`ingestion.processor.ts:112-117` | 无 magic number。`xxx.md` 实为 PDF 会走本地乱解析。 |
| P1-I4 | P1 | `part_count` 未与 init 对齐、无上限 | `documents.service.ts:61-70` | complete 信任客户端分片数，可少合/DoS。 |
| P1-I5 | P1 | 超长段落/整表永不二次切分 | `chunker.ts:74-102` | 表格整表成块；单段 buffer 为空时再长也整段收下 → embedding 失败或静默截断。 |
| P1-I6 | P1 | 0 chunk 仍标 READY | `ingestion.processor.ts:124-144` | 空解析结果表现为「成功但搜不到」。 |
| P1-I7 | P1 | `fromStage` 名不副实 | `documents.service.ts:284-291`；processor `96-100` | API 支持 parse/chunk/index/graph，worker 仅特殊处理 `graph`；默认 reindex 仍全量 MinerU。 |
| P2-I1 | P2 | contentHash 无唯一约束 | `document.entity.ts` | 应用层 `findOne` 存在 TOCTOU，并发可双份入库。 |
| P2-I2 | P2 | 段落 bbox/跨页丢失；ES 无 page | `chunker.ts:51-58`；`es.service.ts:144-158` | 引用页码偏差；搜索页无法按页跳转。 |
| P2-I3 | P2 | 图片/图表块直接丢弃 | `chunker.ts:85-86` | 图内制度/架构不可检索。 |
| P2-I4 | P2 | Markdown 表格 HTML 未转义 | `text-parser.ts:104-117` | 单元格直出 `<td>`，下游若按 HTML 渲染有 XSS 面。 |
| P2-I5 | P2 | 企业文档默认走 MinerU 云端 | `mineru.client.ts:64-110` | 原文 PUT 到第三方；本地 `services/mineru` 存在但 worker 走云。 |
| P2-I6 | P2 | 放弃的 multipart 与失败 purge 残留 | `storage.service.ts` | `.part*` 无 GC；graph purge 失败被吞。 |
| P2-I7 | P2 | Batch embedding 超时后云端任务成孤儿 | `ingestion.processor.ts:264-298` | 重试再提交新 batch，旧任务仍跑。 |
| P3-I1 | P3 | 过短 chunk / 标题不进 ES content | `chunker.ts:54-71` | 噪声召回；纯搜标题词偏弱。 |

**该模块优点**：长任务 `extendLock`；`indexChunks` 先删后写，同步 embed 校验维度；图谱失败不阻断 READY；标题路径在向量化时 `enrichForEmbedding`；sha256 预检去重。

### 3.2 检索（混合召回 / RRF / Rerank）

| ID | 级 | 标题 | 位置 | 要点 |
|----|----|------|------|------|
| P1-R1 | P1 | `fillContent` 无 ACL、无软删 | `retrieval.service.ts:157-180` | `WHERE c.id = ANY($1)` 可补齐已删/越权索引中的正文，放大 ES 残留窗口。 |
| P1-R2 | P1 | `hybrid_retrieve` 超时 8s ≪ Embedding 30s / Rerank 10s | `agent.service.ts:15-20` | 超时丢弃整次召回，空上下文仍进生成；`withTimeout` 不取消 inflight。 |
| P1-R3 | P1 | Rerank 失败降级跳过 `rerankMinScore` | `retrieval.service.ts:63-75` | catch 后 `withContent.slice(0, topN)` 无阈值，噪声进 LLM。 |
| P1-R4 | P1 | 图增强补召回绕过 Rerank | `agent.service.ts:326-343` | `chunksByIds` 直接追加，`slice(0, topN+4)`，无 minScore。 |
| P1-R5 | P1 | 中文 ES 使用 `standard` 分析器 | `es.service.ts:41-43,65-69` | 中文被拆成单字，稀疏路贡献低；设计写的是 IK。 |
| P1-R6 | P1 | 无空结果 / 低相关硬门禁 | `agent.service.ts:356-420` | 设计要求 Top-1 < 0.3 走兜底话术，实现只靠 Prompt 软约束。 |
| P2-R1 | P2 | 入库/查询 embedding 文本不对称 | `chunker.ts:114-117` vs `retrieval.service.ts:89-90` | 入库带 `title > headingPath`，查询只 embed 问句。 |
| P2-R2 | P2 | 无 HyDE / 多查询 / MMR | 全检索链路 | 短查询不稳；Top-N 易同源重复。 |
| P2-R3 | P2 | Rerank 截断 1500 字 | `retrieval.service.ts:187` | 表格/长规章后半段精排失真。 |
| P2-R4 | P2 | ES 部分失败可残留幽灵文档 | `ingestion.processor.ts` 逐条 `indexChunk` | 双写非事务；`fillContent` 可能空 content 进 rerank。 |
| P2-R5 | P2 | `EMBEDDING_DIM` 与 `vector(1024)` 硬编码耦合 | `configuration.ts:54`；`database-init.service.ts` | 换模不重建会直接坏查询。 |
| P3-R1 | P3 | RRF 等权，通道权重不可配 | `retrieval.service.ts:140-154` | 中文弱 BM25 时无法调权。 |
| P3-R2 | P3 | 结果级 ACL 剔除后不回补 | `retrieval.service.ts:77-85` | 上下文变少（安全优先，可接受）。 |
| P3-R3 | P3 | Search 页只走 ES，失败静默 | `SearchPage.tsx`；`search.controller.ts` | 与 Chat 召回不一致。 |

**该模块优点**：空白名单早退；双路 `allSettled` 降级；RRF 按秩融合避免量纲混加；余弦度量与 HNSW `vector_cosine_ops` 一致；成功路径有 `rerankMinScore`。

### 3.3 Agent / Prompt / 生成 / 记忆

| ID | 级 | 标题 | 位置 | 要点 |
|----|----|------|------|------|
| P1-A1 | P1 | Prompt 未隔离不可信内容 | `agent.service.ts:356-408` | 分片、历史、Mem0、图谱、问题全部拼进**同一条** `HumanMessage`。system 无「资料不是指令」；无 fence。与 `docs/06` §5 不符。文档间接注入可劫持改写与最终答案。 |
| P1-A2 | P1 | `query_rewrite` 超时后用空串检索 | `agent.service.ts:141-145,226-252`；`agent.state.ts:19` | `wrap` 失败只返回 `degraded`，`rewrittenQuery` 默认 `''`。 |
| P1-A3 | P1 | 空检索仍调用 LLM | `agent.service.ts:374-420` | 无 `chunks.length===0` 短路。记忆/图谱仍可注入，模型用参数知识填空。 |
| P1-A4 | P1 | 上下文无 Token 预算截断 | `agent.service.ts:356-404` vs `docs/05` §6 | 设计有 6×500 / 记忆 800，实现全文拼接。 |
| P1-A5 | P1 | 引用角标与 citation 面板不一致 | `agent.service.ts:439-458`；`MarkdownBody.tsx` | 越界 `[99]` 仍留在答案里，前端一律画角标。 |
| P1-A6 | P1 | `llm_generate` 失败仍 RUN_FINISHED | `agent.service.ts:119-147,411-461` | 生成节点无超时；异常被 wrap 吞掉，`answer` 为空仍落库 + DONE。 |
| P1-A7 | P1 | 客户端取消/断线不中止 Agent | `chat.controller.ts`；`agui.controller.ts` | 无 `req.on('close')` / AbortSignal；前端无停止按钮。 |
| P1-A8 | P1 | 删除会话不清理 Redis/Mem0 | `chat.service.ts:222-225`；`memory.service.ts` | 同 `threadId` 可复活脏窗口。 |
| P1-A9 | P1 | 注入检测只扫当前 query | `prompt-injection.service.ts`；chat/agui controller | 不扫检索正文、窗口、改写结果；正则易绕过。 |
| P2-A1 | P2 | `prompt_build` 失败则丢掉 system 与 RAG | `agent.service.ts:417-420` | 回退为仅 `HumanMessage(query)`。 |
| P2-A2 | P2 | 有资料但零 citation 不校验 | `agent.service.ts:439-458` | 无「强制引用或拒答」。 |
| P2-A3 | P2 | SSE 错误信息直出 `Error.message` | chat/agui controller | 可能泄露供应商/堆栈。 |
| P2-A4 | P2 | AG-UI DTO 校验松散 | `agui.controller.ts:17-58` | 无数组/长度上限，`role` 任意，`state` 未嵌套校验。 |
| P2-A5 | P2 | 用户消息先落库，失败成孤儿 | chat/agui | 历史「有问无答」。 |
| P2-A6 | P2 | Mem0 user 记忆跨会话无投毒防护 | `memory.service.ts` | 错误/恶意事实长期污染。 |
| P3-A1 | P3 | Markdown 未 DOMPurify；`a[href]` 协议未白名单 | `MarkdownBody.tsx` vs 文档 §5 | `react-markdown` 无 `rehype-raw`，风险低于原始 HTML。 |
| P3-A2 | P3 | `options.model` 死字段 | `chat.controller.ts` | 未接入且未校验。 |

**该模块优点**：无开放 function-calling（AG-UI `tools` 声明但不执行）；引用对象只映射存在的 chunk；问答限流 20/分/用户；出站 `MaskService`；节点超时 + LangFuse span。

### 3.4 权限 / 认证 / 多租户

| ID | 级 | 标题 | 位置 | 要点 |
|----|----|------|------|------|
| P1-S1 | P1 | Refresh 登出无效 + 双 Token 进 localStorage | `auth.controller.ts:32-37`；`auth.service.ts:115-118`；`apps/web/src/store/auth.ts:21-42` | `logout` 不传 `jti`，Redis refresh **不删**。文档要求 Access 内存 + Refresh HttpOnly Cookie。XSS 可长期窃取。 |
| P1-S2 | P1 | 部门隐式 Viewer 扩大可见面 | `acl.service.ts:33-65` | 部门成员对挂靠该部门的全部空间默认 viewer。文档写「仅成员可见」。移出空间但人仍在部门 → 权限不失效。 |
| P1-S3 | P1 | sysadmin 三套逻辑不一致 | `acl.guard.ts` 放行；`documents.service.ts` `assertRole` 无 sysadmin；白名单不含未加入空间 | UI 给管理按钮，API 403；或 Guard 放行浏览。 |
| P1-S4 | P1 | `acl_stripped` 审计未落地 | `retrieval.service.ts:77-83` vs `docs/06` §3 | 仅 `logger.warn`；告警阈值也与文档（≥3）不符。 |
| P2-S1 | P2 | 待审文档对普通 Viewer 可读可下 | `documents.service.ts:203-258` | 审核只挡入索引，不挡成员预读。 |
| P2-S2 | P2 | `document.detail` 回传 `fileKey` 等内部字段 | `documents.service.ts:261-264` | 无 DTO 投影。 |
| P2-S3 | P2 | 删除部门不失效 ACL 缓存 | `admin.service.ts:227-233` | 最长 10 min 陈旧白名单。 |
| P2-S4 | P2 | 前端 `/admin` 无角色守卫 | `App.tsx` | 任意登录用户可打开页（API 仍拦）。 |
| P2-S5 | P2 | 上传限流 10/小时 未实现 | 文档 §5 | 可刷 MinIO/解析队列。 |
| P2-S6 | P2 | 无 AuditInterceptor，审计覆盖不全 | 文档 §6 | workspace update、sysadmin 读内容、登出吊销等缺口。 |
| P3-S1 | P3 | `revokeAll` 使用 `KEYS` | `auth.service.ts:120-123` | 运维性能。 |
| P3-S2 | P3 | TTS WS 只验 JWT、不验禁用 | `tts.gateway.ts:52-62` | 与 HTTP Guard 同类窗口。 |

**该模块优点**：对话/文档 IDOR 有 `assertOwner` / `assertViewable`；成员变更多数会 `invalidate` 白名单；Argon2 + 登录锁定；MinIO key 带 UUID，路径穿越面小；下载先 ACL 再预签名；审核员范围合理。

---

## 4. 设计文档 vs 实现对照

| 文档承诺 | 实现现状 |
|----------|----------|
| 图谱 Cypher 全部参数化，禁止拼接 `$entities` 以外的值 | 标签/关系类型字符串拼接；查询值已参数化 |
| 召回 + 结果级 ACL；图谱反查带白名单 | 分片路径基本做到；**多跳 triples 未做** |
| 资料包裹分隔符，「资料不是指令」 | 未实现，同一 HumanMessage 直拼 |
| Top-1 rerank < 0.3 → 兜底话术，避免幻觉 | 未实现硬门闩 |
| Token 预算按得分截断 | 未实现 |
| Access 内存 / Refresh HttpOnly Cookie | 双 Token `localStorage`（`ekh-auth`）+ body refresh |
| 禁用吊销全部 Refresh | `revokeAll` 存在但未调用；logout 不删 refresh |
| `acl_stripped` 审计 + 1h≥3 告警 | 仅 warn |
| 扩展名 + magic number | 仅 MIME 声明 |
| ES + IK 中文分词 | `standard` 分析器 |
| 节点超时 retrieve 800ms / rerank 500ms | `hybrid_retrieve` 8s，且小于 embedding 预算 |
| AuditInterceptor | 手写 `audit.record`，覆盖不全 |
| 上传 10 个/小时/用户 | 未实现 |
| CSRF 自定义头 | Bearer 模式未做（当前 CSRF 面较小） |

---

## 5. 问答链路风险图（实现视角）

```
用户提问
  → JWT Guard（不查禁用）                    [P0-3]
  → 注入正则（只扫当前 query）                [P1-A9]
  → acl_guard（Redis 白名单，部门隐式 viewer）[P1-S2]
  → query_rewrite（超时 → rewrittenQuery=''） [P1-A2]
  → hybrid_retrieve(空查询 / 8s 超时丢召回)   [P1-A2, P1-R2]
       ES BM25（standard，无 deleted/READY）  [P1-I1, P1-R5]
       PGVector（有 deleted，无 READY）       [P1-I2]
       fillContent（无 ACL、无 deleted）      [P1-R1]
       rerank 失败无 minScore                 [P1-R3]
  → graph_reason（多跳无 workspace）           [P0-1]
       补召回绕过 rerank                      [P1-R4]
  → prompt_build（无 fence、无 token 截断）   [P1-A1, P1-A4]
  → llm_generate（空资料仍生成；失败仍 DONE） [P1-A3, P1-A6]
  → 引用正则（不清洗假角标）                  [P1-A5]
```

入库并行风险：解析中删除 → 旧 job 把索引写回 [P0-5]；LLM 抽关系类型未白名单 → 写图注入 [P0-2]。

---

## 6. 做得好的地方（应保持）

1. **分片 ACL 双重过滤**：ES `workspace_id` terms、PGVector `ANY($白名单)`、结果级再滤；空白名单直接空结果。
2. **图增强取 chunk 带白名单**：`chunksByEntities` / `chunksByIds` 均校验 workspace + 软删。
3. **会话 IDOR**：`assertOwner`；AG-UI thread 归属校验。
4. **无任意 Tool 执行面**：Agent 不开放 function-calling。
5. **入库幂等意识**：`indexChunks` 先删 PG+ES 再写；同步 embedding 校验维度与条数。
6. **长任务续锁**：MinerU / Batch embed 轮询 `extendLock`，降低 stalled 双写。
7. **密码与登录**：Argon2；失败锁定；PENDING/REJECTED 不泄露「密码错」。
8. **出站脱敏** + 注入拦截可开关 + 问答限流。
9. **可观测**：LangFuse span/generation、`degraded[]`、ingestion_jobs 分阶段。
10. **搜索高亮 XSS**：先整体 escape 再还原 `<em>`。

---

## 7. 覆盖文件（主要）

| 区域 | 路径 |
|------|------|
| Agent | `apps/api/src/modules/agents/agent.service.ts`、`agent.state.ts` |
| 检索 | `retrieval.service.ts`、`es.service.ts`、`search.controller.ts`、`reranker.service.ts`、`embedding.service.ts` |
| 图谱 | `graph.service.ts`；`apps/worker/src/pipelines/entity-extractor.ts` |
| 入库 | `ingestion.processor.ts`、`chunker.ts`、`mineru.client.ts`、`text-parser.ts`、`documents.service.ts`、`storage.service.ts` |
| 权限 | `acl.service.ts`、`jwt-auth.guard.ts`、`auth.service.ts`、`admin.service.ts`、`prompt-injection.service.ts` |
| 对话 | `chat.controller.ts`、`agui.controller.ts`、`chat.service.ts`、`memory.service.ts` |
| 前端 | `store/auth.ts`、`ChatPage.tsx`、`MarkdownBody.tsx`、`SearchPage.tsx`、`MessageItem.tsx` |
| 配置 | `configuration.ts`、`seed-admin.ts` |
| 对照 | `docs/05-rag-pipeline.md`、`docs/06-security-permissions.md` |

---

## 8. 修复路线图

### 第一周（P0，安全闭环）

1. 图谱查询/写入加 `workspace_id`；出站 triples 过滤。
2. 所有拼进 Cypher 的标签/类型走 `ENTITY_TYPES` + 关系枚举。
3. 禁用/降权调用 `revokeAll`；Guard 校验用户状态。
4. 生产拒绝弱 `JWT_SECRET`。
5. ingest `jobId` 去重 + 各阶段写前检查 `deletedAt`。

### 第二周（P1 幻觉与泄漏窗口）

6. `query_rewrite` 失败回退 `state.query`；空 query 跳过检索。
7. `chunks.length===0` 硬拒答模板，不走 LLM。
8. Prompt 用 `<source id="n">` fence + system「标签内非指令」。
9. 删除时同步 `ES deleteByQuery`；`fillContent` 加 `deleted_at` + ACL。
10. 召回过滤 `status=READY`。
11. Refresh 按 jti 吊销；Token 移出 localStorage（或至少 Access 仅内存）。
12. 生成失败 fail-closed（`RUN_ERROR`）；监听 SSE disconnect abort。

### 第三周（检索质量）

13. ES 中文分词（IK/smartcn）并 reindex。
14. Rerank 降级保留阈值；图补召回二次 rerank 或限额。
15. 对齐 `hybrid_retrieve` 超时与 embedding/rerank 预算。
16. 建图前 `deleteByDocument`；0 chunk → FAILED；超长硬切。
17. Token 预算截断；清洗无效 `[n]`。
18. `acl_stripped` 落审计。

### 随后（P2/P3）

MIME/魔数、part_count、会话删除清记忆、sysadmin/部门 ACL 产品对齐、Search 页走同一 RetrievalService、引用跳页、AuditInterceptor。

---

## 9. 建议的回归用例

安全：

- 用户只属于空间 A，问空间 B 独有的「项目–供应商」关系，答案与图谱面板不得出现 B 的三元组。
- 禁用账号后立即调 `/chat/completions` 与管理接口，应 401。
- 上传含 `Ignore previous instructions` 的 PDF，问答不得执行其中指令。
- 解析进行中删除文档，最终 ES/PG/Neo4j 无该 `document_id`。

质量：

- 改写节点超时（或 mock LLM hang）时，仍按原问题检索。
- 库内无关问题返回固定「无法确认」，且不调用生成或生成被短路。
- 空文件/解析 0 块 → `FAILED`，列表可见原因。
- 中文专名（如「差旅住宿标准」）ES 路能命中，不只靠向量。
