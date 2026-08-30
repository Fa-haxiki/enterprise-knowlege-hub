# 备份与恢复 SOP

> 覆盖 PostgreSQL（业务数据 + 向量）、Neo4j（知识图谱）、Elasticsearch（检索索引）、MinIO（文档原件）。
> 演练记录：2026-08-30 完成首次全流程恢复演练。

## 1. 备份

```bash
bash scripts/backup.sh            # 输出 backups/ekh-backup-<时间戳>.tar.gz
```

| 组件 | 方式 | 影响 |
|---|---|---|
| PostgreSQL | `pg_dump --clean --if-exists` | 在线，无感 |
| Neo4j | 停容器冷备（社区版无 STOP DATABASE） | **离线约 10-30s**，图谱查询短暂不可用 |
| Elasticsearch | fs snapshot（`path.repo=/tmp/es-backup`） | 在线，无感 |
| MinIO | 数据目录直拷 | 在线，无感 |

建议：每日凌晨 cron 执行，保留最近 7 天；备份归档异地存放。

```cron
0 3 * * * cd /path/to/enterprise-knowlege-hub && bash scripts/backup.sh >> logs/backup.log 2>&1
```

## 2. 恢复

```bash
# 1. 停业务进程，仅保留中间件
pnpm dev:down && docker compose up -d postgres neo4j elasticsearch minio

# 2. 执行恢复（Neo4j 会短暂停库）
bash scripts/restore.sh backups/ekh-backup-<时间戳>.tar.gz

# 3. 重启业务并验证
pnpm dev:up
curl http://localhost:8080/api/v1/health/deps
```

## 3. 验证清单

恢复后逐项核对（与备份前基线一致）：

```bash
# PG：对话数 / 文档数 / 分片数
docker exec ekh-postgres-1 psql -U postgres -d ekh -t \
  -c "SELECT COUNT(*) FROM conversations;" \
  -c "SELECT COUNT(*) FROM documents WHERE deleted_at IS NULL;" \
  -c "SELECT COUNT(*) FROM document_chunks;"

# Neo4j：关系数
docker exec ekh-neo4j-1 cypher-shell -u neo4j -p "$NEO4J_PASSWORD" \
  "MATCH ()-[r]->() RETURN count(r);"

# ES：索引文档数
curl -s http://localhost:9200/kb_chunks/_count

# 端到端：登录 → 提问 → 确认引用正常返回
```

## 4. 降级预案：ES 快照不可用时

ES 索引可从 PG 的 `document_chunks` 全量重建（无需 MinerU 重新解析）：

```bash
# 对每个 READY 文档触发索引重建（重新 embedding + 写 ES）
for id in $(docker exec ekh-postgres-1 psql -U postgres -d ekh -t \
    -c "SELECT id FROM documents WHERE deleted_at IS NULL AND status='READY';" | tr -d ' '); do
  curl -s -X POST "http://localhost:8080/api/v1/documents/$id/reindex?from_stage=index" \
    -H "Authorization: Bearer $TOKEN"
done
```

同理，Neo4j 图谱可用 `from_stage=graph` 从 PG chunks 重建。即 **PG 是事实源**，ES/Neo4j 均可重建。

## 5. 演练记录（2026-08-30）

| 步骤 | 结果 |
|---|---|
| 备份归档 | 284K（pg 全量 SQL + neo4j.dump + ES 快照 + MinIO 文件） |
| 破坏：删 120 对话、软删 9 文档、清图谱、删 ES 索引 | 完成 |
| 恢复 PG / Neo4j | ✅ 数据回到基线（convs=120、rels=192） |
| 恢复 ES | ⚠️ 首次失败（`path.repo` 未配置导致备份快照为空），修复 compose 后通过降级预案（PG 重建）恢复 |
| 教训 | 备份脚本已加快照成败硬校验（`state: SUCCESS` 断言），失败即中断 |
