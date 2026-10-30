#!/bin/bash
# 一张一张加表情包：选文件 → 选分类 → 写标签和描述。
# 用法：bash deploy/meme-add.sh /path/to/图.jpg
set -u
APP=${MIKU_ROOT:-$(cd "$(dirname "$0")/.." && pwd)}
LIFE=${MIKU_HOME:-__MIKU_HOME__}
PACK="$LIFE/shelf/memes"
MAN="$PACK/manifest.json"

IMG=${1:-}
[ -z "$IMG" ] && { echo "用法：bash deploy/meme-add.sh 图片路径"; exit 2; }
[ -f "$IMG" ] || { echo "找不到文件：$IMG"; exit 2; }

echo "分类（可自己新写一个）："
ls "$PACK" 2>/dev/null | tr '\n' ' '; echo
read -r -p "分类：" CAT
[ -z "$CAT" ] && CAT="misc"
mkdir -p "$PACK/$CAT"

read -r -p "标签（逗号分隔，她会用这些找图）：" TAGS
read -r -p "描述（一句话，说明这张图什么情绪/场合）：" DESC
[ -z "$DESC" ] && DESC="$CAT"
read -r -p "情绪名（她字段里的 meme 值，例如 happy/shy/tired）：" EMOTION
[ -z "$EMOTION" ] && EMOTION="$CAT"

NAME="$(date +%s)-$(basename "$IMG" | tr ' ' '_')"
cp "$IMG" "$PACK/$CAT/$NAME"
DB="$LIFE/shelf/memes/index.jsonl"
mkdir -p "$(dirname "$DB")"
python3 - "$DB" "$CAT" "$NAME" "$TAGS" "$DESC" "$EMOTION" <<'PY'
import json, sys, time
db, cat, name, tags, desc, emo = sys.argv[1:7]
rec = {"file": f"{cat}/{name}", "cat": cat,
       "tags": [t.strip() for t in tags.split(',') if t.strip()],
       "desc": desc, "emotion": emo, "addedAt": int(time.time()*1000)}
open(db, 'a', encoding='utf-8').write(json.dumps(rec, ensure_ascii=False) + '\n')
print('已加入：', rec["file"])
PY
