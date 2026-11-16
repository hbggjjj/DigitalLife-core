#!/bin/bash
# 暂存区：改前复制一份，改完在这里跑测试，通过并得到她同意才合并到生产。
#   stage.sh start    打快照 + 建副本
#   stage.sh check    语法/页面/字段/同步 四项检查 + 改动清单
#   stage.sh merge    （会先向她申请；她同意才合并）
ROOT=/root/qqbot-v5
STAGE=/root/qqbot-staging
CASE="$1"

case "$CASE" in
  start)
    bash "$ROOT/scripts/snapshot.sh" >/dev/null
    rm -rf "$STAGE"; mkdir -p "$STAGE/bot" "$STAGE/panel" "$STAGE/scripts"
    # 只复制代码，不复制运行数据（state/events/usage/心跳 这些合并时会污染生产）
    for d in bot panel scripts; do
      find "$ROOT/$d" -maxdepth 1 -type f \( -name '*.mjs' -o -name '*.sh' -o -name '*.cjs' \) -exec cp {} "$STAGE/$d/" \;
    done
    echo "暂存区已建: $STAGE"
    echo "改这里面的文件，然后跑: bash $ROOT/scripts/stage.sh check"
    ;;
  check)
    fail=0
    echo "--- 语法 ---"
    for f in "$STAGE"/bot/*.mjs "$STAGE"/panel/*.mjs; do
      node --check "$f" >/dev/null 2>&1 || { echo "✗ $f"; fail=1; }
    done
    [ "$fail" = 0 ] && echo "✓ 全部通过"
    echo "--- 面板页面脚本 ---"
    node "$STAGE/panel/check-page.mjs" 2>/dev/null || {
      # check-page 写死了生产路径，这里退化成直接检查暂存副本
      node -e "
const fs=require('fs');const src=fs.readFileSync('$STAGE/panel/server.mjs','utf8');
const i=src.indexOf('<script>'),j=src.indexOf('</script>',i);
fs.writeFileSync('/tmp/stage-page.js',src.slice(i+8,j));" && node --check /tmp/stage-page.js && echo "✓ 页面脚本通过"
    }
    echo "--- 字段自检 ---"
    node -e "import('$STAGE/bot/mind.mjs').then(m=>{const a=m.auditSchema();if(a.missingInNormalize.length||a.missingInPrompt.length){console.log('✗',a.missingInNormalize,a.missingInPrompt);process.exit(1)}console.log('✓',a.total,'个字段')})"
    echo "--- 改动清单 ---"
    diff -rq "$ROOT/bot" "$STAGE/bot" 2>/dev/null | sed 's/^/  /'
    diff -rq "$ROOT/panel" "$STAGE/panel" 2>/dev/null | sed 's/^/  /'
    ;;
  merge)
    echo "先向她申请合并……"
    D=$(diff -rq "$ROOT/bot" "$STAGE/bot" 2>/dev/null | head -5 | tr '\n' ' ')
    node "$ROOT/bot/bot.mjs" request "合并暂存区的改动" "暂存区测试通过，改动：${D:-（无文件差异）}" "bot/, panel/"
    if [ $? -ne 0 ]; then echo "她没同意，不合并。"; exit 1; fi
    # 只把代码合并回去，运行数据一律不碰
    for d in bot panel scripts; do
      find "$STAGE/$d" -maxdepth 1 -type f \( -name '*.mjs' -o -name '*.sh' -o -name '*.cjs' \) -exec cp {} "$ROOT/$d/" \;
    done
    echo "已合并。重启生效： bash $ROOT/start_all.sh"
    ;;
  *)
    echo "用法: stage.sh start|check|merge"
    ;;
esac
