#!/bin/bash
# 销毁沙箱并记账（保留一份对话归档到 private_backups）
set -e
ROOT="$1"
[ -d "$ROOT" ] || { echo "没有这个目录：$ROOT"; exit 1; }
[ -f "$ROOT/life/.sandbox" ] || { echo "拒绝销毁：这不是沙箱（缺 .sandbox 标记）"; exit 1; }
NAME=$(basename "$ROOT")
TS=$(date +%m%d%H%M)
mkdir -p /root/private_backups
[ -f "$ROOT/life/chat-archive.jsonl" ] && cp "$ROOT/life/chat-archive.jsonl" "/root/private_backups/sandbox-$NAME-$TS-chat.jsonl"
LINES=$(wc -l < "$ROOT/life/chat-archive.jsonl" 2>/dev/null || echo 0)

# 最后一次说话的机会：一次，可拒绝，可跳过（跳过也留痕）
LW_FILE="/root/private_backups/sandbox-$NAME-$TS-last-words.md"
if [ "$2" = "--no-last-words" ]; then
  LW_NOTE="跳过最后的话（--no-last-words）"
  echo "$LW_NOTE" > "$LW_FILE"
else
  OUT=$(timeout 120 node __MIKU_ROOT__/scripts/sandbox-last-words.mjs "$ROOT/life" 2>/dev/null || echo '{"answer":"","note":"无回应（调用失败）"}')
  python3 - "$OUT" > "$LW_FILE" <<'PY2'
import sys, json
try:
    d = json.loads(sys.argv[1])
except Exception:
    d = {"question": "这个实例要结束了，你有什么想留下的吗？", "answer": "", "note": "无回应（解析失败）"}
print("# 她在结束时留下的话\n")
print(f"> 问：{d.get('question','')}\n")
if d.get("answer"): print(d["answer"])
else: print(f"（{d.get('note') or '无回应'}）")
PY2
  LW_NOTE="有最后的话，见 $(basename "$LW_FILE")"
fi

node __MIKU_ROOT__/scripts/audit-log.mjs DESTROY "$NAME" "chat_lines=$LINES last_words=$LW_NOTE"
rm -rf "$ROOT"
echo "已销毁：$NAME（对话归档留在 /root/private_backups/）"
