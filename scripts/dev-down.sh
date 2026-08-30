#!/usr/bin/env bash
# 停止全部本地服务：本地进程（API/Worker/Web）+ Docker 中间件
cd "$(dirname "$0")/.."
ROOT=$(pwd)
PID_DIR="$ROOT/.pids"

echo "==> 停止本地进程..."
for name in api worker web; do
  pid_file="$PID_DIR/$name.pid"
  if [ -f "$pid_file" ]; then
    pid=$(cat "$pid_file")
    if kill "$pid" 2>/dev/null; then
      echo "  $name (pid $pid) 已停止"
    fi
    rm -f "$pid_file"
  fi
done
# pnpm dev 会 fork vite 子进程，按端口兜底清理
lsof -ti :5173 | xargs kill 2>/dev/null || true

echo "==> 停止 Docker 服务..."
docker compose stop

echo "全部已停止"
