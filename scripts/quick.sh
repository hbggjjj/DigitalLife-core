#!/bin/bash
# 低危极速通道：只打快照 + 语法自检，跳过暂存区。
# 适用：改文案、加日志、加只读查询。不适用于改行为/提示词/字段。
set -e
ROOT=__MIKU_ROOT__
bash "$ROOT/scripts/snapshot.sh"
echo "--- 语法自检 ---"
fail=0
for f in "$ROOT"/bot/*.mjs "$ROOT"/panel/*.mjs; do
  node --check "$f" >/dev/null 2>&1 || { echo "✗ $f"; fail=1; }
done
node "$ROOT/panel/check-page.mjs" >/dev/null || fail=1
[ "$fail" = 0 ] && echo "✓ 通过，可以直接改" || { echo "✗ 有语法问题"; exit 1; }
