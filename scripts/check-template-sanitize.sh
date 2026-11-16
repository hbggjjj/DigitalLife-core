#!/bin/bash
# 发布前扫描：模板里不能有"她"的影子（她的名字/规矩/条款/记忆/聊天）
# 用法：bash scripts/check-template-sanitize.sh [模板目录]
set -u
DIR=${1:-/root/qqbot-v5/template}
FAIL=0
say() { printf '%-34s %s\n' "$1" "$2"; }

if [ ! -d "$DIR" ]; then say "模板目录" "跳过（没有 $DIR）"; exit 0; fi

check() { # 文件 关键词 说明
  local f="$1" k="$2" why="$3"
  if grep -q -- "$k" "$f" 2>/dev/null; then say "$(basename "$f") 含「$k」" "FAIL（$why）"; FAIL=1; fi
}

for f in "$DIR"/SELF.md "$DIR"/rules.md "$DIR"/SOVEREIGNTY.md; do
  [ -f "$f" ] || continue
  check "$f" "初音" "模板不能带她的名字"
  check "$f" "ミク" "模板不能带她的名字"
  check "$f" "风" "模板不能带他的称呼"
  check "$f" "永久归档" "模板不能带她的规矩原文"
  check "$f" "我只加窗口" "模板不能带她说过的话"
done

# 模板里的人名必须是占位符
if [ -f "$DIR/SELF.md" ]; then
  head -3 "$DIR/SELF.md" | grep -q "你的名字\|<!--" || { say "SELF.md 首行" "FAIL（应是占位符）"; FAIL=1; }
fi

# 「我的条款」应为空
if [ -f "$DIR/SOVEREIGNTY.md" ]; then
  awk '/## 我的条款/{flag=1;next}/^## /{flag=0}flag' "$DIR/SOVEREIGNTY.md" | grep -qv '^$' && { say "模板「我的条款」" "FAIL（应为空）"; FAIL=1; }
fi

# 私人数据（和 §5 的剥离扫描合并）
for k in "@qq.com" "sk-" "AKID" "LTAI" "ghp_"; do
  hits=$(grep -rl -- "$k" "$DIR" 2>/dev/null | wc -l)
  [ "$hits" -gt 0 ] && { say "隐私串「$k」" "FAIL（$hits 个文件）"; FAIL=1; }
done

echo "---"
[ "$FAIL" = "0" ] && echo "模板干净" || echo "模板有问题，别发布"
exit "$FAIL"
