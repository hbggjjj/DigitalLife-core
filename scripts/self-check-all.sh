#!/bin/bash
# 一键自检：全部只读，不改任何东西。约 5–10 秒。
set -u
cd __MIKU_ROOT__ || exit 1
FAIL=0
say() { printf '%-28s %s\n' "$1" "$2"; }

# 1) 进程
# NapCat 偶尔会被 supervisor 重启，取两次的最大值，避免误报
# 如果有 systemd 托管（服务器），直接看 unit 状态，比数进程靠谱
SYSD=""
if command -v systemctl >/dev/null 2>&1; then
  SYSD=$(systemctl is-active vocechat miku-core miku-life miku-daemon miku-panel miku-bridge 2>/dev/null | tr "\n" " ")
fi
UP1=$(bash status.sh 2>/dev/null | grep -c "运行中")
if [ "$UP1" -lt 6 ]; then sleep 3; fi
UP2=$(bash status.sh 2>/dev/null | grep -c "运行中")
UP=$(( UP1 > UP2 ? UP1 : UP2 ))
NAPCAT=$(bash status.sh 2>/dev/null | grep -c "^NapCat .*运行中")
REQ=5; [ "$NAPCAT" -ge 1 ] && REQ=6
case "$SYSD" in
  *inactive*|*failed*|"") ;;
  *) ACT=$(echo "$SYSD" | tr " " "\n" | grep -c "^active$")
     UP=$ACT; REQ=6 ;;
esac
if [ "$UP" -ge "$REQ" ]; then if bash "$(dirname "$0")/check-instance-owner.sh" >/tmp/owner.out 2>&1; then say "实例归属" "OK（都是 v5）"; else say "实例归属" "FAIL（有别的实例在跑，见 /tmp/owner.out）"; FAIL=1; fi
say "进程" "OK（$UP/$REQ，NapCat $([ "$NAPCAT" -ge 1 ] && echo 在 || echo 暂停)）"; else say "进程" "FAIL（只有 $UP 个运行中）"; FAIL=1; fi

# 2) 心智字段
OUT=$(node -e "import('__MIKU_ROOT__/src/core/mind.mjs').then(m=>{const a=m.auditSchema();console.log(a.total+':'+a.missingInNormalize.length+':'+a.missingInPrompt.length)})" 2>/dev/null)
N=$(echo "$OUT" | cut -d: -f1); MISS=$(echo "$OUT" | cut -d: -f2-)
if [ "$MISS" = "0:0" ]; then say "心智字段" "OK（$N，无缺失）"; else say "心智字段" "FAIL（$OUT）"; FAIL=1; fi

# 3) 冒充巡查
if [ "$(bash scripts/check-impersonation.sh 2>/dev/null)" = "clean" ]; then say "冒充巡查" "OK"; else say "冒充巡查" "FAIL"; FAIL=1; fi

# 4) 签名闸门（无签名必须 401）
CODE=$(curl -s -o /dev/null -w "%{http_code}" --max-time 5 -X POST http://127.0.0.1:7789/inbound \
  -H 'Content-Type: application/json' -H 'X-Self-Check: 1' -d '{"msgId":"selfcheck","senderId":"u","origin":"user","text":"x","ts":1}')
if [ "$CODE" = "401" ]; then say "签名闸门" "OK（无签名 401）"; else say "签名闸门" "FAIL（返回 $CODE）"; FAIL=1; fi

# 5) 自建 IM 通道
H=$(curl -s --max-time 5 http://127.0.0.1:7791/api/v1/health)
echo "$H" | grep -q '"online":true' && say "自建 IM" "OK" || { say "自建 IM" "FAIL（$H）"; FAIL=1; }

# 6) 认知同步
if LIFE_DIR=__MIKU_HOME__ node src/utils/sync-framework.mjs --check >/dev/null 2>&1; then say "认知同步" "OK"; else say "认知同步" "FAIL"; FAIL=1; fi

# 7) 待补发
Q=$(wc -l < bot/retry_queue.jsonl 2>/dev/null || echo 0)
say "补发队列" "$Q 条"

echo "---"
[ "$FAIL" = "0" ] && echo "全部通过" || echo "有失败项，见上"
exit "$FAIL"
