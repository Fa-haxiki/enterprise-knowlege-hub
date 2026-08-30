# 运维手册

> 面向部署与值班运维。开发环境操作见 README.md。

## 1. 架构与组件

| 组件 | 端口 | 职责 | 数据卷 |
|---|---|---|---|
| web (nginx) | 443/80 | 前端静态资源 + TLS + 反代 | - |
| api | 8080（内部） | 业务 API + SSE + WebSocket(TTS) | - |
| worker | -（内部） | 文档入库流水线 | - |
| postgres | 5432（内部） | 业务数据 + pgvector | pgdata |
| redis | 6379（内部） | 缓存/会话/队列 | redisdata |
| elasticsearch | 9200（内部） | 关键词检索 | esdata |
| neo4j | 7687/7474（内部） | 知识图谱 | neo4jdata |
| minio | 9000（内部） | 文档原件 | miniodata |
| mineru | 8700（内部） | 文档解析 | data/models |
| tts | 8750（内部） | 语音合成 | - |
| ollama | 11434（内部） | embedding/reranker | ollamadata |

## 2. 生产部署

```bash
# 1. 准备配置
cp .env.example .env   # 编辑：数据库口令、JWT_SECRET、LLM key 等
bash scripts/gen-cert.sh your-domain.com   # 或放置正式证书到 deploy/certs/

# 2. 构建并启动
docker compose -f docker-compose.prod.yml up -d --build

# 3. 首次初始化
docker exec ekh-ollama-1 ollama pull bge-m3
docker exec ekh-ollama-1 ollama pull qllama/bge-reranker-v2-m3
docker exec ekh-api-1 node dist/main.js &  # API 启动时自动建表（synchronize）
pnpm seed:admin   # 或在容器内执行等价脚本

# 4. 验证
curl -k https://localhost/api/v1/health/deps
```

## 3. 日常巡检

```bash
bash scripts/healthcheck.sh                  # 手动巡检
bash scripts/healthcheck.sh https://qyapi.weixin.qq.com/...  # 带企业微信 webhook 告警
```

建议 cron 每 5 分钟：

```cron
*/5 * * * * cd /opt/ekh && bash scripts/healthcheck.sh "$ALERT_WEBHOOK" >> logs/healthcheck.log 2>&1
```

## 4. 备份与恢复

见 [11-backup-restore-sop.md](./11-backup-restore-sop.md)。要点：

- 每日 `bash scripts/backup.sh`，保留 7 天，异地存放
- **PG 是事实源**：ES 索引与 Neo4j 图谱均可从 PG 重建（`reindex?from_stage=index|graph`）
- 每季度至少一次恢复演练

## 5. 常见故障处置

| 现象 | 排查 | 处置 |
|---|---|---|
| 问答无响应 | `docker logs ekh-api-1`；查 LLM 网关连通性 | LLM key 失效则更新 .env 并重启 api |
| 文档一直"解析中" | `docker logs ekh-worker-1`；`curl localhost:8700/health` | MinerU 异常则 `docker compose -f docker-compose.prod.yml restart mineru`；失败文档用 `reindex` 重试 |
| 回答无引用 | ES 索引为空：`curl localhost:9200/kb_chunks/_count` | 按 SOP §4 从 PG 重建索引 |
| 语音播放无声 | `curl localhost:8750/health`；浏览器控制台 WS 错误 | 重启 tts 容器；确认 nginx `/socket.io` 反代配置 |
| 磁盘告警 | `docker system df`；`du -sh data/models` | 清理旧备份、docker 悬空镜像 |

## 6. 安全基线

- 所有中间件端口仅容器网络内可达，对外仅 443
- 登录限流 10 次/分/IP；全局限流 120 次/分/IP；问答 20 次/分/用户
- Prompt 注入检测默认开启（`PROMPT_INJECTION_BLOCK=false` 可关）
- LLM 出站脱敏默认开启（`LLM_MASK_SENSITIVE=false` 可关）
- 审计日志：登录/授权/删除/问答/越权全量落 `audit_logs`，管理员可查询/导出 CSV
- 越权告警：同一用户 1 小时内 403 达 10 次触发告警日志 + `acl_alert` 审计

## 7. 升级流程

```bash
git pull
docker compose -f docker-compose.prod.yml build api worker web
bash scripts/backup.sh   # 升级前备份
docker compose -f docker-compose.prod.yml up -d api worker web
bash scripts/healthcheck.sh
```
