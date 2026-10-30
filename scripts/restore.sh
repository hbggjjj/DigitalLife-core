#!/bin/bash
# 回到某个快照（不带参数=最近一个）
set -e
ROOT=__MIKU_ROOT__
F="${1:-$(ls -1t "$ROOT/.snapshots"/*.tgz 2>/dev/null | head -1)}"
[ -f "$F" ] || { echo "没有快照可回滚"; exit 1; }
echo "回滚到: $F"
tar xzf "$F" -C /root
echo "已回滚。要生效请重启：bash $ROOT/start_all.sh"
