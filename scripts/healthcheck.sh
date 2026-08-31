#!/usr/bin/env bash
# 健康巡检：检查全部组件存活，异常时输出告警（可接 cron + 邮件/ webhook）
# 用法：bash scripts/healthcheck.sh [告警webhook URL]
set -uo pipefail
cd "$(dirname "$0")/.."

WEBHOOK="${1:-${ALERT_WEBHOOK:-}}"
FAILURES=()

check() { # check <名称> <命令...>
  local name=$1; shift
  if "$@" >/dev/null 2>&1; then
    echo "  [OK] $name"
  else
    echo "  [FAIL] $name"
    FAILURES+=("$name")
  fi
}

echo "==> 组件健康检查 $(date '+%F %T')"
check "API"        curl -sf --max-time 5 http://localhost:8080/api/v1/health
check "API依赖"    curl -sf --max-time 8 http://localhost:8080/api/v1/health/deps
check "Web"        curl -sf --max-time 5 http://localhost:5173/login
check "PostgreSQL" docker exec ekh-postgres-1 pg_isready -U postgres
check "Redis"      docker exec ekh-redis-1 redis-cli -a "$(grep ^REDIS_PASSWORD .env | cut -d= -f2)" --no-auth-warning ping
check "ES"         curl -sf --max-time 5 http://localhost:9200/_cluster/health
check "Neo4j"      curl -sf --max-time 5 http://localhost:7474
check "MinIO"      curl -sf --max-time 5 http://localhost:9000/minio/health/live
check "TTS"        curl -sf --max-time 5 http://localhost:8750/health

if [ ${#FAILURES[@]} -eq 0 ]; then
  echo "==> 全部正常"
  exit 0
fi

MSG="[EKH 告警] 组件异常: ${FAILURES[*]} ($(date '+%F %T'))"
echo "==> $MSG"
if [ -n "$WEBHOOK" ]; then
  curl -sf -X POST "$WEBHOOK" -H 'Content-Type: application/json' \
    -d "{\"msgtype\":\"text\",\"text\":{\"content\":\"$MSG\"}}" >/dev/null || echo "  webhook 发送失败"
fi
exit 1
