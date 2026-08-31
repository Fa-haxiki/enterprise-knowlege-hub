#!/usr/bin/env bash
# 从备份归档恢复：PostgreSQL + Neo4j + Elasticsearch + MinIO
# 用法：bash scripts/restore.sh backups/ekh-backup-YYYYMMDD-HHMMSS.tar.gz
# 注意：恢复会覆盖现有数据，操作前请确认服务已停止写入（pnpm dev:down 后仅启动中间件）
set -euo pipefail
cd "$(dirname "$0")/.."

ARCHIVE="${1:?用法: bash scripts/restore.sh <备份归档.tar.gz>}"
[ -f "$ARCHIVE" ] || { echo "归档不存在: $ARCHIVE"; exit 1; }

set -a; source .env; set +a

TMP=$(mktemp -d)
trap 'rm -rf "$TMP"' EXIT
tar -xzf "$ARCHIVE" -C "$TMP"
DIR=$(find "$TMP" -mindepth 1 -maxdepth 1 -type d | head -1)
echo "==> 解包到 $DIR"

echo "==> [1/4] 恢复 PostgreSQL"
cat "$DIR/postgres.sql" | docker exec -i ekh-postgres-1 psql -U "${PG_USER:-postgres}" -d "${PG_DB:-ekh}" >/dev/null

echo "==> [2/4] 恢复 Neo4j（社区版需停库冷恢复）"
mkdir -p "$TMP/neo4j-load"
cp "$DIR/neo4j.dump" "$TMP/neo4j-load/neo4j.dump"
docker stop ekh-neo4j-1 >/dev/null
docker run --rm -v ekh_neo4jdata:/data -v "$TMP/neo4j-load:/backup" neo4j:5-community \
  neo4j-admin database load neo4j --from-path=/backup --overwrite-destination=true
docker start ekh-neo4j-1 >/dev/null
for i in $(seq 1 30); do
  curl -sf http://localhost:7474 >/dev/null 2>&1 && break
  sleep 2
done

echo "==> [3/4] 恢复 Elasticsearch"
docker exec ekh-elasticsearch-1 bash -c "mkdir -p /tmp/es-backup && chmod -R 777 /tmp/es-backup"
docker cp "$DIR/es-snapshot/." ekh-elasticsearch-1:/tmp/es-backup/
curl -s -X PUT "http://localhost:9200/_snapshot/backup_repo" \
  -H 'Content-Type: application/json' -d '{"type":"fs","settings":{"location":"/tmp/es-backup"}}' >/dev/null
SNAP=$(curl -s "http://localhost:9200/_snapshot/backup_repo/_all" | python3 -c "import sys,json;print(json.load(sys.stdin)['snapshots'][-1]['snapshot'])")
curl -s -X POST "http://localhost:9200/${ES_INDEX:-kb_chunks}/_close" >/dev/null
curl -s -X POST "http://localhost:9200/_snapshot/backup_repo/$SNAP/_restore?wait_for_completion=true" \
  -H 'Content-Type: application/json' -d "{\"indices\":\"${ES_INDEX:-kb_chunks}\"}" >/dev/null
curl -s -X POST "http://localhost:9200/${ES_INDEX:-kb_chunks}/_open" >/dev/null
docker exec ekh-elasticsearch-1 rm -rf /tmp/es-backup

echo "==> [4/4] 恢复 MinIO"
docker cp "$DIR/minio/." ekh-minio-1:/data/

echo ""
echo "恢复完成。建议执行健康检查：curl http://localhost:8080/api/v1/health/deps"
