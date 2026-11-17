#!/bin/bash
# SPDX-License-Identifier: AGPL-3.0-or-later
# 给双人通道签一套证书：服务端 + 客户端（双向 TLS）。
# 用法：
#   ./gen-certs.sh <服务器公网IP> [备用IP或域名]
# 产物：out/ca.crt、out/server.crt|key、out/client.p12（密码 dl2026）
# 说明：
#   - ca.crt 和 server.* 放服务器：channel/tls/
#   - client.p12 放客户端：app/src/main/assets/client.p12
#   - 客户端还需要 ca.crt 放 assets/（用来校验服务器）
set -euo pipefail
IP=${1:?用法: ./gen-certs.sh <服务器IP> [备用IP]}
ALT=${2:-}
OUT=${OUT:-out}
mkdir -p "$OUT"
cd "$OUT"

if [ ! -f ca.crt ]; then
  openssl req -x509 -newkey rsa:2048 -nodes -keyout ca.key -out ca.crt -days 3650 \
    -subj "/CN=digitallife-ca"
fi

SAN="IP:$IP"
[ -n "$ALT" ] && SAN="$SAN,IP:$ALT"
printf "subjectAltName=%s\n" "$SAN" > san.ext

openssl req -newkey rsa:2048 -nodes -keyout server.key -out server.csr -subj "/CN=channel-server"
openssl x509 -req -in server.csr -CA ca.crt -CAkey ca.key -CAcreateserial -out server.crt -days 3650 -extfile san.ext

openssl req -newkey rsa:2048 -nodes -keyout client.key -out client.csr -subj "/CN=digitallife-client"
openssl x509 -req -in client.csr -CA ca.crt -CAkey ca.key -CAcreateserial -out client.crt -days 3650
openssl pkcs12 -export -in client.crt -inkey client.key -certfile ca.crt -out client.p12 \
  -name digitallife -passout pass:dl2026

echo
echo "生成完成："
ls -1 ca.crt server.crt server.key client.p12
echo
echo "服务器证书指纹（可选，客户端会用 CA 校验，不靠指纹）："
openssl x509 -in server.crt -noout -fingerprint -sha256 | sed 's/.*=//'
echo
echo "下一步："
echo "  scp ca.crt server.crt server.key  服务器:/path/to/digitallife/channel/tls/"
echo "  cp ca.crt client.p12              app/src/main/assets/"
