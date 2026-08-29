# 02 系统架构设计

## 1. 架构总览

系统采用「单 API 服务 + 异步 Worker + 多存储引擎 + AI 基础设施」的私有化部署架构。LangGraph.js 运行于 NestJS 同一 Node 进程内（避免跨语言 RPC 损耗），MinerU / Mem0 / LangFuse 以独立容器部署，HTTP 通信。

```mermaid
flowchart LR
    subgraph client [客户端]
        Web["React SPA"]
    end

    subgraph app [应用层 - NestJS 进程]
        direction TB
        Ctrl["Controllers<br/>REST / SSE / WS 网关"]
        AgentRT["LangGraph Agent Runtime<br/>状态机 · 工具调用 · 路由"]
        Modules["领域模块<br/>auth/workspaces/documents<br/>ingestion/retrieval/chat/memory"]
    end

    subgraph worker [异步层 - BullMQ Worker 进程]
        ParseJob["解析任务<br/>MinerU 调用"]
        EmbedJob["向量化 + ES 双写"]
        GraphJob["实体抽取 + Neo4j 写入"]
    end

    subgraph store [存储层]
        PG[("PostgreSQL+pgvector")]
        ES[("Elasticsearch")]
        Neo4j[("Neo4j")]
        Redis[("Redis")]
        MinIO[("MinIO")]
        Mem0SVC["Mem0"]
    end

    subgraph ai [AI 服务]
        LLM["LLM 网关"]
        Embed["Embedding"]
        Rerank["Reranker"]
        TTS["TTS"]
        MinerU["MinerU"]
    end

    LangFuse["LangFuse 可观测"]

    Web <--> Ctrl
    Ctrl --> AgentRT --> Modules
    Modules --> PG & ES & Neo4j & Redis & Mem0SVC
    AgentRT --> LLM & Embed & Rerank
    Ctrl -->|任务入队| Redis
    Redis --> ParseJob --> MinerU
    ParseJob --> EmbedJob --> GraphJob
    EmbedJob --> PG & ES
    GraphJob --> Neo4j
    Modules --> MinIO
    AgentRT -.trace.-> LangFuse
    Web <-.WSS.-> TTS
```

## 2. Agent 问答全链路（核心流程）

对应需求步骤 0-9，下图为 LangGraph 状态机视角的完整链路：

```mermaid
flowchart TB
    Start["0. 用户提问<br/>POST /api/v1/chat/completions"] --> Auth["鉴权校验<br/>JWT 验证 + Redis 权限白名单<br/>未命中则回源 PG 并回填"]
    Auth --> Router{"1. LangGraph 复杂度路由<br/>LLM 分类器: simple / complex"}
    Router -->|simple| Hybrid["2a. 混合检索<br/>ES BM25 + PGVector 余弦"]
    Router -->|complex| Hybrid2["2b. 混合检索<br/>同左"]
    Hybrid --> RRF["RRF 融合打分<br/>score = Σ 1/(k+rank)"]
    Hybrid2 --> RRF
    RRF --> Rerank["Reranker 精排 Top-N"]
    Rerank --> Graph{"是否 complex?"}
    Graph -->|是| Entity["3. LLM 实体抽取<br/>→ Neo4j 多跳 Cypher<br/>→ 推理链路 triples"]
    Graph -->|否| ACL
    Entity --> ACL["4. 权限过滤<br/>剔除无权限文档分片<br/>workspace_id IN 白名单"]
    ACL --> Memory["5. 记忆装配<br/>Redis 滑动窗口摘要<br/>+ Mem0 长期记忆"]
    Memory --> Prompt["6. Prompt 统一组装<br/>分片 + 图谱链路 + 分层记忆"]
    Prompt --> Gen["7. LLM 流式生成<br/>SSE 推送 token/citation"]
    Gen --> TTSOpt{"用户开启语音?"}
    TTSOpt -->|是| TTSNode["TTS 分句合成<br/>WebSocket 推送音频帧"]
    TTSOpt -->|否| Trace
    TTSNode --> Trace["8. LangFuse 上报<br/>耗时/Token/召回/异常"]
    Trace --> Persist["9. 问答记录持久化<br/>messages + qa_records"]
    Persist --> EndNode["结束"]
```

### 步骤说明

| 步骤 | 组件 | 说明 | 降级策略 |
| --- | --- | --- | --- |
| 0 | AuthModule | JWT 校验；`acl:whitelist:{userId}` 缓存用户可见空间集合，TTL 10min | 缓存失效回源 PG |
| 1 | LangGraph Router 节点 | 小模型分类（问题是否需多实体关联推理），输出 simple/complex | 分类失败默认 simple |
| 2 | RetrievalModule | ES `multi_match`(IK 分词) + PGVector `<=>` 余弦，各召回 Top-20 | 单引擎故障退化为单路 |
| - | Fusion | RRF（k=60）融合，Reranker 精排取 Top-6 | Reranker 超时用 RRF 分 |
| 3 | GraphModule | LLM 抽取实体 → 参数化 Cypher 多跳（≤3 跳）→ triples + 路径 | Neo4j 故障跳过，标注降级 |
| 4 | AclFilter | 按 `chunk.workspace_id` 与用户白名单求交，越权分片剔除 | 不过滤视为事故，强制开启 |
| 5 | MemoryModule | Redis `chat:win:{convId}` 取窗口摘要；Mem0 `search(user_id, query)` 取长期记忆 | 任一失败则省略该层 |
| 6 | PromptBuilder | 三段式上下文：检索分片（带 ref_id）/ 图谱 triples / 记忆 | - |
| 7 | ChatModule | LLM stream → SSE；要求引用 `[ref_id]` 标注 | LLM 故障返回友好错误 |
| - | TTS | 按句切分合成，WS 推送 `audio_chunk` | TTS 故障仅关闭语音 |
| 8 | ObservabilityModule | LangFuse Trace：span 覆盖各节点，记录耗时、usage、召回 IDs | 上报异步，不阻塞 |
| 9 | ChatModule | messages 落库；qa_records 记录召回/推理/耗时快照 | - |

## 3. 文档入库链路

```mermaid
flowchart LR
    Upload["分片上传<br/>MinIO 预签名 URL"] --> Enqueue["合并完成<br/>BullMQ 入队 ingestion"]
    Enqueue --> MinerUJob["MinerU 解析<br/>版面/表格/公式 → Markdown+结构元数据"]
    MinerUJob --> Chunk["语义分块<br/>按标题层级切分<br/>chunk=512 token, overlap=64"]
    Chunk --> EmbedW["Embedding bge-m3<br/>1024 维"]
    EmbedW --> DoubleWrite["双写<br/>PGVector(document_chunks)<br/>+ ES(kb_chunks)"]
    DoubleWrite --> EntityExt["LLM 实体/关系抽取<br/>项目/供应商/人员/制度..."]
    EntityExt --> Neo4jW["Neo4j MERGE 写入<br/>实体去重对齐"]
    Neo4jW --> Done["document.status=READY<br/>通知前端"]
```

- 每步失败独立重试（指数退避，最多 3 次），状态机：`UPLOADED → PARSING → CHUNKING → INDEXING → GRAPHING → READY / FAILED`
- 重建索引 / 重建图谱支持按文档、按空间两种粒度

## 4. NestJS 模块划分

```
apps/api/src/
├── main.ts                      # 全局管道/拦截器/SSE 配置
├── modules/
│   ├── auth/                    # JWT 双 Token、登录、SSO 扩展点
│   ├── users/                   # 用户、角色
│   ├── workspaces/              # 空间、成员授权、权限白名单回源
│   ├── documents/               # 文档 CRUD、分片上传、状态机
│   ├── ingestion/               # BullMQ 生产者；MinerU 客户端
│   ├── retrieval/               # ES/PGVector 召回、RRF、Reranker 客户端
│   ├── graph/                   # Neo4j 驱动封装、实体抽取、多跳查询
│   ├── memory/                  # Redis 窗口摘要、Mem0 客户端
│   ├── agents/                  # LangGraph 状态机定义、节点实现、工具集
│   ├── chat/                    # 对话、SSE 流式、问答记录、反馈
│   ├── llm/                     # LLM/Embedding/Reranker/TTS 统一客户端（OpenAI 兼容）
│   ├── observability/           # LangFuse SDK 封装、Trace 装饰器
│   └── audit/                   # 审计日志
└── common/                      # 拦截器(统一响应)、过滤器(错误码)、守卫(ACL)
apps/worker/src/
├── processors/                  # parse/embed/graph 三个 BullMQ Processor
└── pipelines/                   # 分块器、实体抽取 prompt、Neo4j 写入器
```

## 5. 关键技术决策（ADR 摘要）

| 决策 | 选择 | 理由 | 备选（放弃原因） |
| --- | --- | --- | --- |
| Agent 编排 | LangGraph.js（Node 进程内） | 状态机显式可控、与 NestJS 同语言零 RPC、生态成熟 | Python LangGraph + 独立服务（跨语言运维成本高）；Dify（定制受限） |
| 向量存储 | PGVector（HNSW） | 与业务数据同事务、分片 ACL 过滤一个 SQL 完成、运维组件少 | Milvus（额外集群运维） |
| 关键词检索 | Elasticsearch 8 + IK | BM25 成熟、中文分词、与向量召回互补 | PG tsvector（中文分词弱、排序调优难） |
| 图谱 | Neo4j 5 | Cypher 表达多跳直观、生态成熟 | NebulaGraph（团队学习成本） |
| 长期记忆 | Mem0 自托管 | 记忆抽取/更新/检索开箱即用，支持 user/session 两级 | 自研（重复造轮子） |
| 文档解析 | MinerU | PDF 版面/表格/公式解析质量开源最佳，中文好 | unstructured（表格弱）；Textract（私有化不可行） |
| 可观测 | LangFuse 自托管 | LLM Trace 事实标准，Token/耗时/召回可回放 | LangSmith（SaaS 数据出境） |
| 队列 | BullMQ + Redis | 与 NestJS 集成好，延迟队列/重试内置 | Kafka（重量级） |

## 6. 容量与扩展性

- **无状态 API**：水平扩容，SSE 连接经 Nginx sticky session
- **Worker**：按队列独立扩缩容；MinerU 服务 GPU 节点可单独扩容
- **ES**：单节点起步，数据量 > 500 万 chunk 时扩 3 节点
- **Neo4j**：实体量 < 1000 万单实例足够
- **PGVector**：HNSW（m=16, ef_construction=64），单表千万级内可接受；超出后按 workspace 分区
