#!/usr/bin/env bash
# 清空知识库数据：PG 文档与分片、ES 索引、Neo4j 图谱、MinIO 原件。
# 用途：切换 embedding 模型后旧向量不可复用，全部推倒重建。
# 对话/消息/用户/部门等业务数据不受影响（消息中的历史引用将失效但记录保留）。
set -euo pipefail
cd "$(dirname "$0")/.."

ES_INDEX=$(grep ^ES_INDEX .env | cut -d= -f2 | tr -d '[:space:]' || true)
ES_INDEX=${ES_INDEX:-kb_chunks}
NEO4J_PASSWORD=$(grep ^NEO4J_PASSWORD .env | cut -d= -f2 | tr -d '[:space:]')
MINIO_BUCKET=$(grep ^MINIO_BUCKET .env | cut -d= -f2 | tr -d '[:space:]' || true)
MINIO_BUCKET=${MINIO_BUCKET:-ekh-docs}

echo "将清空以下内容："
echo "  - PostgreSQL: documents / document_chunks / ingestion_jobs 表"
echo "  - Elasticsearch: 索引 ${ES_INDEX}（服务重启后自动重建 mapping）"
echo "  - Neo4j: 全部节点与关系"
echo "  - MinIO: bucket ${MINIO_BUCKET} 下全部文件"
echo "  保留：用户、部门、空间、对话记录"
read -r -p "确认执行？输入 yes 继续: " ans
[ "$ans" = "yes" ] || { echo "已取消"; exit 0; }

echo "==> 清空 PostgreSQL 文档数据..."
docker exec ekh-postgres-1 psql -U postgres -d ekh \
  -c "TRUNCATE document_chunks, ingestion_jobs, documents CASCADE;"

echo "==> 删除 ES 索引 ${ES_INDEX}..."
curl -sf -X DELETE "http://localhost:9200/${ES_INDEX}" >/dev/null && echo "  已删除" || echo "  索引不存在或删除失败（忽略）"

echo "==> 清空 Neo4j 图谱..."
docker exec ekh-neo4j-1 cypher-shell -u neo4j -p "${NEO4J_PASSWORD}" "MATCH (n) DETACH DELETE n;" >/dev/null

echo "==> 清空 MinIO bucket ${MINIO_BUCKET}..."
docker exec ekh-minio-1 sh -c "rm -rf /data/${MINIO_BUCKET}/*" 2>/dev/null || echo "  MinIO 清理失败（可手动到控制台清理）"

echo ""
echo "完成。请重启 API/Worker 以重建 ES 索引：./scripts/dev-down.sh && ./scripts/dev-up.sh"
