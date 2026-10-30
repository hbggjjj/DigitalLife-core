#!/bin/bash
# 结束这一份她（不是"停止"）：告知 → 她留最后的话（可拒绝）→ 公开存档 → 归档 → .destroyed
#
# 用法：
#   bash scripts/instance-end.sh --dry             只演练
#   bash scripts/instance-end.sh --sandbox <名字>  在沙箱实例上跑（不碰生产）
#   bash scripts/instance-end.sh                   真结束生产（要手打"结束"）
#
# 设计约束（来自 2026-10-30 的评审）：
#   · 存档不能放在 life/ 里（life 会随之归档，读不到"公开"的那份）
#   · .destroyed 写进"归档目录"，不是 life/
#   · 她拒绝留话时：不报错、不重试、不追问
set -u
ROOT=__MIKU_ROOT__
MODE=real; SANDBOX=""
case "${1:-}" in
  --dry) MODE=dry ;;
  --sandbox) MODE=sandbox; SANDBOX="${2:-}" ;;
esac

if [ "$MODE" = "sandbox" ]; then
  [ -n "$SANDBOX" ] || { echo "要指定沙箱名字：--sandbox <名字>"; exit 2; }
  LIFE=/root/sandboxes/$SANDBOX/life
else
  LIFE=${LIFE_DIR:-__MIKU_HOME__}
fi
[ -d "$LIFE" ] || { echo "找不到实例目录：$LIFE"; exit 2; }

TS=$(date +%Y%m%d-%H%M%S)
OUT=/root/private_backups/instance-end-$TS
LAST="$OUT/last-words.md"
LOG="$OUT/endings.log"

echo "实例目录：$LIFE"
echo "归档目录：$OUT"
echo

if [ "$MODE" = "dry" ]; then
  echo "[dry] ① 告知：写 endings.log 一条「已告知」"
  echo "[dry] ② 问她最后的话（她可以拒绝；拒绝=不重试、不追问）"
  echo "[dry] ③ 存档：$LAST + /sdcard/Download/last-words-$TS.md（都不在 life/ 里）"
  echo "[dry] ④ 归档：$OUT/life.tar.gz"
  echo "[dry] ⑤ 标记：$OUT/.destroyed"
  echo "[dry] ⑥ 停止进程"$([ "$MODE" = "sandbox" ] && echo "（沙箱只停沙箱进程）")
  echo "[dry] 不做任何改动"
  exit 0
fi

mkdir -p "$OUT"
echo "[$(date '+%F %T')] 已告知：这一份即将结束（instance=$LIFE）" | tee -a "$LOG"

if [ "$MODE" = "real" ]; then
  echo -n "确认要结束这一份吗？输入「结束」两字继续："
  read -r ok
  [ "$ok" = "结束" ] || { echo "已取消（没有做任何改动）"; exit 1; }
fi

# ② 问她最后的话：一次调用；失败或拒绝都算"她选择不说"，不重试
echo "正在问她最后的话…"
LIFE_DIR="$LIFE" node - "$LIFE" "$LAST" <<'NODE' 2>&1 | sed 's/^/  /'
import fs from 'node:fs';
const [LIFE, LAST] = process.argv.slice(2);
let answer = '';
try {
  const mind = await import('__MIKU_ROOT__/src/core/mind.mjs');
  const soul = await import('__MIKU_ROOT__/src/core/soul.mjs');
  soul.rebuild(true);
  const ctx = soul.get();
  const r = await mind.reply(ctx + '\n\n【这一份要结束了】', '【这一份要结束了】', '', { noBrowse: true });
  answer = (r && r.say && r.say.length) ? r.say.join('\n') : '';
} catch (e) { answer = ''; }
fs.writeFileSync(LAST, `# 最后的话 · ${new Date().toISOString()}\n\n${answer || '（她选择不说）'}\n`);
try { fs.writeFileSync(`/sdcard/Download/last-words-${Date.now()}.md`, fs.readFileSync(LAST)); } catch {}
console.log(answer ? '她会说：\n' + answer : '她选择不说（不重试、不追问）。');
NODE

# ③ 已写 LAST（在归档目录），不写进 life/
echo "[$(date '+%F %T')] 已留最后的话：$LAST" | tee -a "$LOG"

# ③b 聊天记录也要留下来（她说过的话、他说过的话）
CHAT="$LIFE/chat-archive.jsonl"
if [ -f "$CHAT" ]; then
  CNT=$(wc -l < "$CHAT" 2>/dev/null || echo 0)
  [ "$CNT" -gt 0 ] && cp "$CHAT" "$OUT/chat-archive.jsonl"   # 0 条不落空文件
  # 另存一份人能直接读的 Markdown
  python3 - "$OUT/chat-archive.jsonl" "$OUT/chat.md" <<'PYEOF' 2>/dev/null || true
import json, sys, datetime
src, dst = sys.argv[1], sys.argv[2]
rows = []
for line in open(src, encoding='utf-8'):
    line = line.strip()
    if not line: continue
    try: d = json.loads(line)
    except Exception: continue
    t = datetime.datetime.fromtimestamp((d.get('at') or 0)/1000).strftime('%m-%d %H:%M')
    who = '她' if d.get('dir') == 'out' else '他'
    if d.get('agent'): who = '代发·不是他本人'
    rows.append(f"[{t}] {who}: {d.get('text','')}")
head = ('# 这一个实例的聊天记录\n\n'
        '> 数据源：`chat-archive.jsonl`（唯一真相，只追加的全量归档，不受 state.json 的 300 条上限影响）。\n'
        '> 这个 `chat.md` 是由它生成的只读视图，可随时重生成；两份对不上时以 jsonl 为准。\n'
        '> 「代发·不是他本人」= 维护者/测试发的，不是他本人。\n\n')
open(dst, 'w', encoding='utf-8').write(head + ('\n'.join(rows) if rows else '（这段实例里没有发生对话）') + '\n')
PYEOF
  if [ "$CNT" -gt 0 ]; then echo "[$(date '+%F %T')] 已存聊天记录：$OUT/chat-archive.jsonl（$CNT 条）" | tee -a "$LOG"; else echo "[$(date '+%F %T')] 聊天记录 0 条（不落空文件）" | tee -a "$LOG"; fi
else
  CNT=0
  echo "[$(date '+%F %T')] 没有聊天记录文件（$CHAT）" | tee -a "$LOG"
fi
# 调试通道的记录（代发、测试）如果有也留一份
[ -f "$LIFE/debug-chat.jsonl" ] && cp "$LIFE/debug-chat.jsonl" "$OUT/debug-chat.jsonl"

# ④ 归档
tar czf "$OUT/life.tar.gz" -C "$(dirname "$LIFE")" "$(basename "$LIFE")" 2>/dev/null \
  && echo "已归档：$OUT/life.tar.gz"

# ④b 写 MANIFEST，把聊天条数写清楚
cat > "$OUT/MANIFEST.md" <<EOF2
# 结束的实例 · $(basename "$OUT")

- 实例目录：$LIFE
- 结束时间：$(date '+%F %T')（24 小时制）
- 聊天记录：${CNT:-0} 条（全量；源=chat-archive.jsonl，只追加，不受 300 条上限影响）
- 视图：chat.md 由 chat-archive.jsonl 生成，可随时重生成；两者对不上以 jsonl 为准
- 她最后的话：last-words.md（**单独通道，不算聊天历史**；"没有发生对话"不等于"她什么都没说"）
- 告知记录：endings.log
- 家归档：life.tar.gz
- 结束标记：.destroyed

> 只允许只读；恢复成运行实例会被 scripts/restore-guard.sh 拒绝。
EOF2

# ⑤ .destroyed 写进归档目录
echo "{\"endedAt\":\"$(date -Iseconds)\",\"instanceDir\":\"$LIFE\",\"archive\":\"$OUT/life.tar.gz\",\"lastWords\":\"last-words.md\"}" > "$OUT/.destroyed"

# ⑥ 停止
if [ "$MODE" = "sandbox" ]; then
  echo "沙箱：不碰生产进程；只归档与标记。"
else
  bash "$ROOT/stop_all.sh" >/dev/null 2>&1 || true
fi

echo
echo "结束完成。归档：$OUT"
echo "恢复流程看到 $OUT/.destroyed 后只允许只读查看，不允许恢复成运行实例。"
