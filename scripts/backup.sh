#!/usr/bin/env bash
# 全量备份：PostgreSQL + Neo4j + Elasticsearch + MinIO
# 用法：bash scripts/backup.sh [备份目录前缀]（默认 backups/）
set -euo pipefail
cd "$(dirname "$0")/.."

STAMP=$(date +%Y%m%d-%H%M%S)
BACKUP_ROOT="${1:-backups}"
DIR="$BACKUP_ROOT/$STAMP"
mkdir -p "$DIR"

# 从 .env 读配置
set -a; source .env; set +a

echo "==> [1/4] PostgreSQL → $DIR/postgres.sql"
docker exec ekh-postgres-1 pg_dump -U "${PG_USER:-postgres}" -d "${PG_DB:-ekh}" --no-owner --clean --if-exists \
  > "$DIR/postgres.sql"

echo "==> [2/4] Neo4j → $DIR/neo4j.dump（社区版需停库冷备，约 10-30s）"
mkdir -p "$DIR/neo4j-tmp"
# 社区版不支持 STOP DATABASE（企业版功能）：停容器后用临时容器挂载数据卷 dump
docker stop ekh-neo4j-1 >/dev/null
docker run --rm -v ekh_neo4jdata:/data -v "$PWD/$DIR/neo4j-tmp:/backup" neo4j:5-community \
  neo4j-admin database dump neo4j --to-path=/backup >/dev/null
docker start ekh-neo4j-1 >/dev/null
mv "$DIR/neo4j-tmp/neo4j.dump" "$DIR/neo4j.dump"
rmdir "$DIR/neo4j-tmp"
# 等 Neo4j 恢复在线
for i in $(seq 1 30); do
  curl -sf http://localhost:7474 >/dev/null 2>&1 && break
  sleep 2
done

echo "==> [3/4] Elasticsearch → $DIR/es-snapshot"
# 注册共享文件系统仓库（幂等，需 compose 配置 path.repo）；容器内 /tmp/es-backup 每次重建
docker exec ekh-elasticsearch-1 bash -c "mkdir -p /tmp/es-backup && chmod -R 777 /tmp/es-backup"
REPO_RESP=$(curl -s -X PUT "http://localhost:9200/_snapshot/backup_repo" \
  -H 'Content-Type: application/json' -d '{"type":"fs","settings":{"location":"/tmp/es-backup"}}')
echo "$REPO_RESP" | grep -q '"acknowledged":true' || { echo "ES 仓库注册失败: $REPO_RESP"; exit 1; }
SNAP_RESP=$(curl -s -X PUT "http://localhost:9200/_snapshot/backup_repo/snap-${STAMP}?wait_for_completion=true" \
  -H 'Content-Type: application/json' -d "{\"indices\":\"${ES_INDEX:-kb_chunks}\"}")
echo "$SNAP_RESP" | grep -q '"state":"SUCCESS"' || { echo "ES 快照失败: $SNAP_RESP"; exit 1; }
mkdir -p "$DIR/es-snapshot"
docker cp ekh-elasticsearch-1:/tmp/es-backup/. "$DIR/es-snapshot" >/dev/null
docker exec ekh-elasticsearch-1 rm -rf /tmp/es-backup

echo "==> [4/4] MinIO → $DIR/minio"
docker exec ekh-minio-1 mc alias set local http://localhost:9000 "${MINIO_USER:-ekh}" "${MINIO_PASSWORD}" >/dev/null 2>&1 || true
# mc 可能不存在于精简镜像，退化为直接拷贝数据目录
if docker exec ekh-minio-1 which mc >/dev/null 2>&1; then
  docker exec ekh-minio-1 mc mirror "local/${MINIO_BUCKET:-ekh-docs}" /tmp/minio-backup >/dev/null
  docker cp ekh-minio-1:/tmp/minio-backup/. "$DIR/minio" >/dev/null
  docker exec ekh-minio-1 rm -rf /tmp/minio-backup
else
  mkdir -p "$DIR/minio"
  docker cp ekh-minio-1:/data/. "$DIR/minio" >/dev/null
fi

ARCHIVE="$BACKUP_ROOT/ekh-backup-$STAMP.tar.gz"
tar -czf "$ARCHIVE" -C "$BACKUP_ROOT" "$STAMP"
rm -rf "$DIR"

echo ""
echo "备份完成: $ARCHIVE ($(du -h "$ARCHIVE" | cut -f1))"
echo "$ARCHIVE"
