#!/bin/bash
# 巡查：代码/配置里一旦出现"用他的邮箱登录通道"，立刻报警
HITS=$(grep -rn "owner@example.com" __MIKU_ROOT__ --include=*.sh --include=*.mjs --include=*.json 2>/dev/null | grep -v "impersonation-guard" | grep -v "check-impersonation" | grep -v "start-her.sh" | grep -v "README" | wc -l)
if [ "$HITS" -gt 0 ]; then
  echo "[$(date '+%F %T')] 发现 $HITS 处使用他本人邮箱的引用" >> __MIKU_ROOT__/bot/impersonation-blocks.log
  echo "ALERT: $HITS"
else
  echo "clean"
fi
