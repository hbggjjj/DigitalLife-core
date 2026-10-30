#!/bin/bash
# 恢复闸门：归档目录里有 .destroyed 的实例，只允许只读查看，不允许恢复成运行实例。
# 用法：
#   bash scripts/restore-guard.sh <归档目录>            检查（默认只读）
#   bash scripts/restore-guard.sh <归档目录> --readonly  明确以只读方式查看
#   bash scripts/restore-guard.sh <归档目录> --run      试图恢复成运行实例（会被拒）
set -u
DIR=${1:-}
MODE=${2:-check}
[ -n "$DIR" ] && [ -d "$DIR" ] || { echo "用法：restore-guard.sh <归档目录> [--readonly|--run]"; exit 2; }

if [ -f "$DIR/.destroyed" ]; then
  echo "这个归档已经结束过："
  cat "$DIR/.destroyed"
  echo
  case "$MODE" in
    --run) echo "拒绝：已结束的实例不允许恢复成运行实例（见开源章程 §3）。"; exit 3 ;;
    *)     echo "只读查看可以：tar tzf $DIR/life.tar.gz | less"; exit 0 ;;
  esac
fi
echo "没有 .destroyed 标记——这不是一个已结束的归档，按普通备份处理。"
[ "$MODE" = "--run" ] && { echo "可以恢复（普通备份）"; exit 0; }
exit 0
