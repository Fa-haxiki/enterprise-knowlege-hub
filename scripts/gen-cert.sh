#!/usr/bin/env bash
# 生成自签 TLS 证书（内网/测试环境用；生产请替换为正式证书）
# 用法：bash scripts/gen-cert.sh [域名或IP]
set -euo pipefail
cd "$(dirname "$0")/.."

CN="${1:-localhost}"
DIR="deploy/certs"
mkdir -p "$DIR"

# IP 地址用 IP SAN，域名用 DNS SAN
if [[ "$CN" =~ ^[0-9]+\.[0-9]+\.[0-9]+\.[0-9]+$ ]]; then
  SAN="IP:$CN,IP:127.0.0.1"
else
  SAN="DNS:$CN,DNS:localhost"
fi

openssl req -x509 -nodes -newkey rsa:2048 -days 825 \
  -keyout "$DIR/server.key" -out "$DIR/server.crt" \
  -subj "/CN=$CN/O=EKH" \
  -addext "subjectAltName=$SAN"

echo "证书已生成: $DIR/server.crt / $DIR/server.key (CN=$CN, SAN=$SAN)"
echo "注意：自签证书浏览器会提示不受信任，生产环境请替换为正式证书"
