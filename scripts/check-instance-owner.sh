#!/bin/bash
# 抓"开错实例"：检查正在跑的核心进程，工作目录是不是 __MIKU_ROOT__。
# 旧栈 /root/qqbot 一旦被拉起，会静默占住 7788/7789，v5 反而起不来。
# 用法：bash scripts/check-instance-owner.sh
set -u
ROOT=__MIKU_ROOT__
FAIL=0
say() { printf '%-22s %s\n' "$1" "$2"; }

found=0
for p in /proc/[0-9]*; do
  cmd=$(tr '\0' ' ' < "$p/cmdline" 2>/dev/null) || continue
  case "$cmd" in
    *"node service.mjs"*|*"node life.mjs"*|*"node server.mjs"*|*"node bot.mjs daemon"*) ;;
    *) continue ;;
  esac
  found=$((found+1))
  cwd=$(readlink "$p/cwd" 2>/dev/null)
  name=$(echo "$cmd" | sed 's/.*node \([a-z]*\.mjs\).*/\1/')
  case "$cwd" in
    "$ROOT"|"$ROOT"/*) say "$name" "OK（$cwd）" ;;
    *) say "$name" "FAIL（跑在 $cwd —— 不是 v5）"; FAIL=1 ;;
  esac
done

if [ "$found" = "0" ]; then say "实例" "没在运行"; fi
echo "---"
[ "$FAIL" = "0" ] && echo "实例归属正确" || echo "检测到别的实例在跑——先停掉它，再启动 v5"
exit "$FAIL"
