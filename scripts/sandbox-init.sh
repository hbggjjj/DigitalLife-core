#!/bin/bash
# 建一个干净沙箱：独立目录 + .sandbox 标记 + 建账
set -e
NAME="${1:-shadow-$(date +%m%d%H%M)}"
ROOT="/root/sandboxes/$NAME"
[ -e "$ROOT" ] && { echo "已存在：$ROOT"; exit 1; }

mkdir -p "$ROOT/life" "$ROOT/bot"
cp -a __MIKU_HOME__/SELF.md "$ROOT/life/SELF.md"
for f in memory.md mood.md taste.md rules.md framework.md self-knowledge.md wishes.md goals.md others-edits.md; do
  : > "$ROOT/life/$f"
done
mkdir -p "$ROOT/life/journal" "$ROOT/life/ideas" "$ROOT/life/shelf/memes"
printf '%s\n' "${NAME}" "$(date -Iseconds)" "这是一个测试实例：结束会被销毁" > "$ROOT/life/.sandbox"
: > "$ROOT/life/chat-archive.jsonl"

node __MIKU_ROOT__/scripts/audit-log.mjs CREATE "$NAME" "dir=$ROOT"
echo "沙箱已建：$ROOT"
echo "启动示例："
echo "  SANDBOX=1 LIFE_DIR=$ROOT/life QQBOT_ROOT=__MIKU_ROOT__ WEB_PORT=7898 node __MIKU_ROOT__/web/server.mjs"
