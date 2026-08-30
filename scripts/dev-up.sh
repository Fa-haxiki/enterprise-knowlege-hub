#!/usr/bin/env bash
# 一键启动企业知识库全部本地服务：Docker 中间件 + API + Worker + Web
set -euo pipefail
cd "$(dirname "$0")/.."
ROOT=$(pwd)
LOG_DIR="$ROOT/logs"
PID_DIR="$ROOT/.pids"
mkdir -p "$LOG_DIR" "$PID_DIR"

# 1. Docker 中间件（postgres/neo4j/es/redis/minio/ollama/mineru/langfuse）
echo "==> 启动 Docker 服务..."
docker compose up -d

# 2. 等待关键依赖就绪
echo "==> 等待 PostgreSQL..."
until docker exec ekh-postgres-1 pg_isready -U postgres >/dev/null 2>&1; do sleep 1; done
echo "==> 等待 Elasticsearch..."
until curl -sf http://localhost:9200/_cluster/health >/dev/null 2>&1; do sleep 1; done
echo "==> 等待 Neo4j..."
until curl -sf http://localhost:7474 >/dev/null 2>&1; do sleep 1; done

# 3. dist 缺失时自动构建 API/Worker
if [ ! -f apps/api/dist/main.js ] || [ ! -f apps/worker/dist/main.js ]; then
  echo "==> dist 缺失，执行构建..."
  pnpm -r --filter @ekh/api --filter @ekh/worker build
fi

port_in_use() { lsof -ti :"$1" >/dev/null 2>&1; }
pid_alive() { [ -f "$PID_DIR/$1.pid" ] && kill -0 "$(cat "$PID_DIR/$1.pid")" 2>/dev/null; }

# 守护进程方式启动（fork+setsid），防止脚本退出后服务被托管终端清理
spawn() { # spawn <name> <cwd> <cmd...>
  local name=$1 cwd=$2; shift 2
  python3 "$ROOT/scripts/spawn-daemon.py" "$LOG_DIR/$name.log" "$cwd" "$@" > "$PID_DIR/$name.pid"
}

# 4. API（:8080）
if port_in_use 8080; then
  echo "==> API 已在运行 (:8080)，跳过"
else
  echo "==> 启动 API..."
  spawn api "$ROOT/apps/api" node dist/main.js
fi

# 5. Worker（无端口，按 PID 检测）
if pid_alive worker; then
  echo "==> Worker 已在运行，跳过"
else
  echo "==> 启动 Worker..."
  spawn worker "$ROOT/apps/worker" node dist/main.js
fi

# 6. Web（:5173）
if port_in_use 5173; then
  echo "==> Web 已在运行 (:5173)，跳过"
else
  echo "==> 启动 Web..."
  spawn web "$ROOT/apps/web" pnpm dev
fi

echo ""
echo "全部启动完成："
echo "  Web:    http://localhost:5173"
echo "  API:    http://localhost:8080/api/v1/health"
echo "  MinerU: http://localhost:8700/health"
echo "  日志:   logs/{api,worker,web}.log"
echo "  停止:   pnpm dev:down"
