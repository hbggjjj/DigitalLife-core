#!/bin/bash
# 改动前打快照：bot/ panel/ scripts/ README。出问题一条命令回去。
set -e
ROOT=__MIKU_ROOT__
TS=$(date +%Y%m%d_%H%M%S)
OUT="$ROOT/.snapshots/$TS.tgz"
mkdir -p "$ROOT/.snapshots"
tar czf "$OUT" -C /root qqbot/bot qqbot/panel qqbot/scripts qqbot/README.md 2>/dev/null
ls -1t "$ROOT/.snapshots"/*.tgz 2>/dev/null | tail -n +6 | xargs -r rm -f
echo "快照: $OUT"
echo "现有快照: $(ls -1 "$ROOT/.snapshots" | wc -l) 个"
