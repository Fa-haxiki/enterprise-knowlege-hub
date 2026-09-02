#!/usr/bin/env bash
# 一键启动企业知识库全部本地服务：Docker 中间件 + API + Worker + Web
set -euo pipefail
cd "$(dirname "$0")/.."
ROOT=$(pwd)
LOG_DIR="$ROOT/logs"
PID_DIR="$ROOT/.pids"
mkdir -p "$LOG_DIR" "$PID_DIR"

# 0. 按当前本机 IP 同步 .env 的 MINIO_PUBLIC_ENDPOINT（家/公司网络切换时自动适配）
#    预签名 URL 在 API 启动时一次性读取该值，故须在启动 API 前完成写入
LAN_IP=""
LAN_IP=$(ipconfig getifaddr en0 2>/dev/null || ipconfig getifaddr en1 2>/dev/null || true)
if [ -n "$LAN_IP" ] && [ -f .env ]; then
  CURRENT=$(grep -E '^MINIO_PUBLIC_ENDPOINT=' .env | cut -d= -f2-)
  if [ "$CURRENT" != "$LAN_IP" ]; then
    # 兼容 macOS sed：原地替换需空备份后缀
    sed -i '' -E "s|^MINIO_PUBLIC_ENDPOINT=.*|MINIO_PUBLIC_ENDPOINT=$LAN_IP|" .env
    echo "==> 检测到本机 IP 变化：MINIO_PUBLIC_ENDPOINT ${CURRENT:-（空）} -> $LAN_IP"
  fi
fi

# 1. Docker 中间件（postgres/neo4j/es/redis/minio/tts/mem0）
echo "==> 启动 Docker 服务..."
docker compose up -d

# 2. 等待关键依赖就绪
echo "==> 等待 PostgreSQL..."
until docker exec ekh-postgres-1 pg_isready -U postgres >/dev/null 2>&1; do sleep 1; done
echo "==> 等待 Elasticsearch..."
until curl -sf http://localhost:9200/_cluster/health >/dev/null 2>&1; do sleep 1; done
echo "==> 等待 Neo4j..."
until curl -sf http://localhost:7474 >/dev/null 2>&1; do sleep 1; done

# 2.5 自愈：确保 typeorm_metadata 表存在。
#     历史上 API/Worker 并发 synchronize 曾把库搞成半建状态（缺此表），导致 API 报
#     "relation typeorm_metadata does not exist" 起不来。补上即可修复，无需重置数据卷。
docker exec ekh-postgres-1 psql -U postgres -d "${POSTGRES_DB:-ekh}" -q -c \
  'CREATE TABLE IF NOT EXISTS typeorm_metadata (
     type varchar(255) NOT NULL,
     database varchar(255),
     schema varchar(255),
     "table" varchar(255),
     name varchar(255),
     value text
   );' 2>/dev/null || echo "==> 警告：typeorm_metadata 自愈失败（可忽略，首次空库时正常）"

# 3. dist 缺失时自动构建 API/Worker
if [ ! -f apps/api/dist/main.js ] || [ ! -f apps/worker/dist/main.js ]; then
  echo "==> dist 缺失，执行构建..."
  pnpm -r --filter @ekh/api --filter @ekh/worker build
fi

# 只检测 LISTEN 状态：lsof -ti :port 会匹配到本机出站连接（如微信连远端 8080），导致误判端口被占
port_in_use() { lsof -nP -ti :"$1" -sTCP:LISTEN >/dev/null 2>&1; }
pid_alive() { [ -f "$PID_DIR/$1.pid" ] && kill -0 "$(cat "$PID_DIR/$1.pid")" 2>/dev/null; }

# 守护进程方式启动（fork+setsid），防止脚本退出后服务被托管终端清理
spawn() { # spawn <name> <cwd> <cmd...>
  local name=$1 cwd=$2; shift 2
  python3 "$ROOT/scripts/spawn-daemon.py" "$LOG_DIR/$name.log" "$cwd" "$@" > "$PID_DIR/$name.pid"
}

# 4. API（:8080）—— 必须先于 Worker 启动并等其就绪：
#    只有 API 开 synchronize 建表，Worker 不开；若两者同时首启，空库下并发 synchronize
#    会争抢创建 typeorm_metadata 等元数据表，导致库不一致、API 反复重试退出。
if port_in_use 8080; then
  echo "==> API 已在运行 (:8080)，跳过"
else
  echo "==> 启动 API（等待建表就绪）..."
  spawn api "$ROOT/apps/api" node dist/main.js
  # 等 API 健康：synchronize 建表完成后才监听 8080
  until curl -sf http://localhost:8080/api/v1/health >/dev/null 2>&1; do sleep 1; done
  echo "==> API 就绪"
fi

# 5. 迁移（幂等，已执行过会跳过）：须在 API 建表后、Worker 前
echo "==> 执行数据库迁移..."
pnpm migration:run >/dev/null 2>&1 || true

# 6. Worker（无端口，按 PID 检测）：synchronize=false，安全地在 API 建表后启动
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
if [ -n "${LAN_IP:-}" ]; then
  echo "  局域网: http://${LAN_IP}:5173  （MINIO_PUBLIC_ENDPOINT 已自动同步为 ${LAN_IP}）"
fi
echo "  API:    http://localhost:8080/api/v1/health"
echo "  日志:   logs/{api,worker,web}.log"
echo "  停止:   pnpm dev:down"
