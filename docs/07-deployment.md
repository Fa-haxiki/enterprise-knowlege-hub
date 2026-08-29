# 07 部署与运维方案

## 1. 部署拓扑

单机 Docker Compose 起步（中小团队 ≤200 人），组件可平滑拆分到多机。

```mermaid
flowchart TB
    subgraph host [Docker 宿主机]
        Nginx["nginx<br/>反向代理 + TLS"]
        Web["web<br/>React 静态资源"]
        API["api ×2<br/>NestJS 无状态"]
        Worker["worker ×2<br/>BullMQ 消费者"]
        PG["postgres:16-pgvector"]
        ES["elasticsearch:8"]
        Neo4j["neo4j:5"]
        Redis["redis:7"]
        MinIO["minio"]
        MinerU["mineru-api<br/>CPU/GPU"]
        Mem0["mem0"]
        LFWeb["langfuse-web + worker"]
        LFPG["(langfuse 复用 postgres<br/>独立 database)"]
        Click["clickhouse<br/>langfuse 依赖"]
    end
    Nginx --> Web & API
    API --> PG & ES & Neo4j & Redis & MinIO & Mem0 & MinerU
    Worker --> PG & ES & Neo4j & Redis & MinIO & MinerU
    API --> LFWeb --> Click
```

## 2. docker-compose.yml（完整示例）

```yaml
name: ekh
services:
  nginx:
    image: nginx:1.27-alpine
    ports: ["443:443"]
    volumes:
      - ./deploy/nginx.conf:/etc/nginx/nginx.conf:ro
      - ./deploy/certs:/etc/nginx/certs:ro
    depends_on: [web, api]

  web:
    build: { context: ./apps/web }
    expose: ["3000"]

  api:
    build: { context: ./apps/api }
    env_file: .env
    expose: ["8080"]
    depends_on: [postgres, redis, elasticsearch, neo4j, minio]
    deploy: { replicas: 2 }

  worker:
    build: { context: ./apps/worker }
    env_file: .env
    depends_on: [postgres, redis, elasticsearch, neo4j, minio, mineru]
    deploy: { replicas: 2 }

  postgres:
    image: pgvector/pgvector:pg16
    environment:
      POSTGRES_PASSWORD: ${PG_PASSWORD}
      POSTGRES_DB: ekh
    volumes: ["pgdata:/var/lib/postgresql/data"]
    healthcheck: { test: ["CMD-SHELL", "pg_isready -U postgres"], interval: 10s }

  redis:
    image: redis:7-alpine
    command: redis-server --requirepass ${REDIS_PASSWORD} --maxmemory 2gb --maxmemory-policy allkeys-lru
    volumes: ["redisdata:/data"]

  elasticsearch:
    image: docker.elastic.co/elasticsearch/elasticsearch:8.15.0
    environment:
      discovery.type: single-node
      xpack.security.enabled: "false"
      ES_JAVA_OPTS: -Xms2g -Xmx2g
    volumes: ["esdata:/usr/share/elasticsearch/data"]
    # 首次启动后安装 IK 分词器：
    # bin/elasticsearch-plugin install https://get.infini.cloud/elasticsearch/analysis-ik/8.15.0

  neo4j:
    image: neo4j:5-community
    environment:
      NEO4J_AUTH: neo4j/${NEO4J_PASSWORD}
      NEO4J_PLUGINS: '["apoc"]'
      NEO4J_server_memory_heap_max__size: 2G
    volumes: ["neo4jdata:/data"]
    ports: ["127.0.0.1:7474:7474"]

  minio:
    image: minio/minio:latest
    command: server /data --console-address ":9001"
    environment:
      MINIO_ROOT_USER: ${MINIO_USER}
      MINIO_ROOT_PASSWORD: ${MINIO_PASSWORD}
    volumes: ["miniodata:/data"]

  mineru:
    image: ${MINERU_IMAGE:-mineru-api:latest}   # 基于官方 MinerU 镜像封装 FastAPI
    env_file: .env
    expose: ["8700"]
    # GPU 模式追加：
    # deploy: { resources: { reservations: { devices: [{ driver: nvidia, count: 1, capabilities: [gpu] }] } } }

  mem0:
    image: mem0/mem0-api-server:latest
    env_file: .env
    expose: ["8888"]
    depends_on: [postgres]

  langfuse-web:
    image: langfuse/langfuse:2
    environment:
      DATABASE_URL: postgresql://postgres:${PG_PASSWORD}@postgres:5432/langfuse
      CLICKHOUSE_URL: http://clickhouse:8123
      NEXTAUTH_SECRET: ${LANGFUSE_SECRET}
      SALT: ${LANGFUSE_SALT}
      NEXTAUTH_URL: http://localhost:3100
    ports: ["127.0.0.1:3100:3000"]
    depends_on: [postgres, clickhouse, langfuse-worker]

  langfuse-worker:
    image: langfuse/langfuse-worker:2
    environment:
      DATABASE_URL: postgresql://postgres:${PG_PASSWORD}@postgres:5432/langfuse
      CLICKHOUSE_URL: http://clickhouse:8123
    depends_on: [postgres, clickhouse]

  clickhouse:
    image: clickhouse/clickhouse-server:24
    volumes: ["chdata:/var/lib/clickhouse"]

volumes:
  pgdata: {}
  redisdata: {}
  esdata: {}
  neo4jdata: {}
  miniodata: {}
  chdata: {}
```

## 3. 环境变量清单（.env.example）

```bash
# ---- 基础 ----
NODE_ENV=production
API_PORT=8080
JWT_SECRET=change-me-32bytes
CORS_ORIGIN=https://kb.corp.local

# ---- 存储 ----
PG_HOST=postgres
PG_PASSWORD=change-me
DATABASE_URL=postgresql://postgres:change-me@postgres:5432/ekh
REDIS_URL=redis://:change-me@redis:6379
ES_NODE=http://elasticsearch:9200
NEO4J_URI=bolt://neo4j:7687
NEO4J_PASSWORD=change-me
MINIO_ENDPOINT=minio:9000
MINIO_USER=ekh
MINIO_PASSWORD=change-me
MINIO_BUCKET=ekh-docs

# ---- AI 服务 ----
LLM_BASE_URL=https://api.deepseek.com/v1      # 任意 OpenAI 兼容端点
LLM_API_KEY=sk-...
LLM_MODEL=deepseek-chat
LLM_ROUTER_MODEL=deepseek-chat                 # 复杂度分类可配小模型
EMBEDDING_BASE_URL=http://embedding:8001/v1
EMBEDDING_MODEL=bge-m3
EMBEDDING_DIM=1024
RERANKER_URL=http://reranker:8002
RERANKER_MODEL=bge-reranker-v2-m3
TTS_BASE_URL=                                   # 空则关闭语音能力
TTS_API_KEY=

# ---- 内部服务 ----
MINERU_URL=http://mineru:8700
MEM0_URL=http://mem0:8888
LANGFUSE_HOST=http://langfuse-web:3000
LANGFUSE_PUBLIC_KEY=pk-lf-...
LANGFUSE_SECRET_KEY=sk-lf-...

# ---- 参数 ----
CHUNK_SIZE=512
CHUNK_OVERLAP=64
RETRIEVE_TOP_K=20
RERANK_TOP_N=6
GRAPH_MAX_HOPS=3
ACL_CACHE_TTL_SECONDS=600
CHAT_RATE_LIMIT_PER_MIN=20
```

## 4. 资源规格建议

| 规模 | 节点 | CPU/内存 | 备注 |
| --- | --- | --- | --- |
| 最小（≤50 人） | 单机 | 16C / 32G | 全部组件一机，MinerU CPU 模式 |
| 推荐（≤200 人） | 2 台 | 应用 8C/16G + 数据 16C/32G | PG/ES/Neo4j/Redis/MinIO 集中数据机 |
| 大规模（≤1000 人） | 4+ 台 | 应用×2、数据 32C/64G、GPU 节点（MinerU/Embedding/Reranker）、ES 3 节点 | LLM 走企业网关 |

## 5. 初始化与启动

```bash
cp .env.example .env          # 修改全部 change-me
docker compose up -d postgres redis elasticsearch neo4j minio
docker compose exec elasticsearch bin/elasticsearch-plugin install --batch <ik-url> && docker compose restart elasticsearch
docker compose up -d          # 全量启动
docker compose exec api pnpm migration:run
docker compose exec api pnpm seed:admin    # 创建首个 sysadmin
```

## 6. 备份策略

| 数据 | 方式 | 频率 | 保留 |
| --- | --- | --- | --- |
| PostgreSQL | `pg_dump` 加密归档至 MinIO `backup/` bucket | 每日 02:00 | 30 天 |
| MinIO 文档 | `mc mirror` 到备份 bucket（跨机） | 每日 03:00 | 30 天 |
| Neo4j | `neo4j-admin database dump` | 每日 03:30 | 14 天 |
| ES | snapshot 至 MinIO（S3 插件） | 每日 04:00 | 7 天（可从 PG 重建，容忍短保留） |
| Redis | 不备份（缓存与队列均可重建） | - | - |

恢复演练：每季度一次，RTO ≤ 4h，RPO ≤ 24h。

## 7. 监控与告警

| 层 | 手段 |
| --- | --- |
| 应用 | `/health`（liveness）与 `/health/deps`（PG/ES/Neo4j/Redis/LLM 连通性）；LangFuse 看板监控 P95 延迟、Token 成本、low_recall 率 |
| 容器 | cAdvisor + node_exporter 指标（可选 Prometheus + Grafana，compose profile `monitoring`） |
| 日志 | 容器 stdout 统一 JSON；`docker logs` / Loki 采集（可选） |
| 告警 | 健康检查失败、磁盘 >80%、ES 黄红状态、LLM 熔断开启 → Webhook 推送（企业微信/钉钉） |

## 8. 升级与迁移

- 数据库变更一律走 TypeORM migration，禁止手工改库
- 版本升级顺序：备份 → 停 worker → 升 api（migration 自动）→ 升 worker → 验证
- Embedding 模型更换需全量重建向量：提供 `pnpm reindex:all --model=xxx` 离线任务，期间检索降级为 ES 单路
