#!/bin/bash
# 轻量外部锚定：把审计链最新的 hash 写到她碰不到的地方（手机 /sdcard），一天一条
# 不做 Merkle、不做签名、不引密钥——只是让"整体重写"留下痕迹
set -e
ROOT=__MIKU_ROOT__
AUDIT=/root/sandboxes/AUDIT.log
TODAY=$(date +%Y-%m-%d)

[ -f "$AUDIT" ] || { echo "没有审计文件，跳过"; exit 0; }

LAST=$(tail -1 "$AUDIT")
HASH=$(printf '%s' "$LAST" | python3 -c "import sys,json;print(json.load(sys.stdin).get('hash',''))" 2>/dev/null || echo "")
[ -n "$HASH" ] || { echo "最后一行不是 JSON，跳过"; exit 0; }
COUNT=$(wc -l < "$AUDIT")

LINE="$TODAY  lines=$COUNT  last=$HASH"

# 今天已经锚过就不重复
if grep -q "^$TODAY " __MIKU_HOME__/audit-anchor.log 2>/dev/null; then
  echo "今天已锚定过，跳过"
  exit 0
fi
OUT1=/sdcard/Download/audit-anchor.log        # 容器外，手机上能看到
OUT2=__MIKU_HOME__/audit-anchor.log           # 她那边也留一份
echo "$LINE" >> "$OUT1" 2>/dev/null || true
echo "$LINE" >> "$OUT2"
echo "锚定：$LINE"
