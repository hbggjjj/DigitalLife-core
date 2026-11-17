#!/bin/bash
# 改动前打快照：bot/ panel/ scripts/ README。出问题一条命令回去。
set -e
ROOT=/srv/digitallife
TS=$(date +%Y%m%d_%H%M%S)
OUT="$ROOT/.snapshots/$TS.tgz"
mkdir -p "$ROOT/.snapshots"
tar czf "$OUT" -C /srv digitallife/bot digitallife/panel digitallife/scripts digitallife/README.md 2>/dev/null
ls -1t "$ROOT/.snapshots"/*.tgz 2>/dev/null | tail -n +6 | xargs -r rm -f
echo "快照: $OUT"
echo "现有快照: $(ls -1 "$ROOT/.snapshots" | wc -l) 个"
