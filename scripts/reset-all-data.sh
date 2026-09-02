#!/usr/bin/env bash
# 全量重置：删除 ES / MinIO / PostgreSQL / Neo4j / Redis 全部数据与本地日志，并重建。
# 与 clear-knowledge-data.sh 的区别：那个只清知识库（保留用户/部门/对话），本脚本连业务库一起推倒。
#
# 流程：
#   1. 停掉本地 API/Worker/Web 进程与 Docker 中间件
#   2. docker compose down -v 删除所有数据卷（pg/es/neo4j/redis/minio/clickhouse）
#   3. 删除 logs/*.log
#   4. docker compose up -d 重新拉起中间件（空卷）
#   5. 等待 PG/ES/Neo4j 就绪，跑 migration 建扩展与索引
#
# 表结构由 TypeORM synchronize（非 production）在 API 启动时自动建；种子管理员需手动 seed。
set -euo pipefail
cd "$(dirname "$0")/.."
ROOT=$(pwd)

echo "将删除并重建以下全部内容（不可恢复）："
echo "  - PostgreSQL 所有业务表（用户/部门/空间/文档/分片/对话/审计/QA 记录）"
echo "  - Elasticsearch 索引与数据卷"
echo "  - Neo4j 全部节点与关系"
echo "  - MinIO 全部文件"
echo "  - Redis 全部缓存与 BullMQ 队列"
echo "  - logs/ 下全部日志"
echo "  - Docker 数据卷：pgdata / esdata / neo4jdata / redisdata / miniodata / chdata"
read -r -p "确认执行？输入 RESET 继续: " ans
[ "$ans" = "RESET" ] || { echo "已取消"; exit 0; }

echo ""
echo "==> 停止本地进程与 Docker 服务..."
bash "$ROOT/scripts/dev-down.sh" || true

echo "==> 删除 Docker 数据卷（down -v）..."
docker compose --profile full down -v 2>/dev/null || docker compose down -v

echo "==> 删除本地日志..."
rm -f "$ROOT"/logs/*.log 2>/dev/null || true

echo "==> 重新启动 Docker 中间件..."
docker compose up -d

echo "==> 等待 PostgreSQL..."
until docker exec ekh-postgres-1 pg_isready -U postgres >/dev/null 2>&1; do sleep 1; done
echo "==> 等待 Elasticsearch..."
until curl -sf http://localhost:9200/_cluster/health >/dev/null 2>&1; do sleep 1; done
echo "==> 等待 Neo4j..."
until curl -sf http://localhost:7474 >/dev/null 2>&1; do sleep 1; done

echo "==> 执行数据库 migration（扩展 + HNSW/全文索引）..."
pnpm migration:run

echo ""
echo "全部重置完成。接下来："
echo "  1. 启动服务：  pnpm dev:up        （首次会自动 build API/Worker）"
echo "  2. 种子管理员：pnpm seed:admin"
echo "  3. ES 索引在 API 启动时自动重建（EsService.ensureIndex）"
