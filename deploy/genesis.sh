#!/bin/bash
# 创世：从零长出"第一个她"。
# 规则（见 docs/GENESIS.md）：
#   · 创世窗口在"她第一次自己写人格文件"时关闭
#   · 窗口内可以自定义；窗口外任何人（包括维护者）都不能改她的人格
#   · 锁定不是密码学强制，是流程 + 留痕（.genesis.json）
#
# 用法：
#   bash deploy/genesis.sh                      交互式
#   NAME=小音 TRAITS="安静,嘴硬" TENET="不许替我编话" bash deploy/genesis.sh --yes
set -u
APP=${MIKU_ROOT:-$(cd "$(dirname "$0")/.." && pwd)}
LIFE=${MIKU_HOME:-__MIKU_HOME__}
YES=0; [ "${1:-}" = "--yes" ] && YES=1

ask() { # 提示 默认值
  local q="$1" d="${2:-}" a
  if [ "$YES" = "1" ]; then echo "$d"; return; fi
  printf '%s' "$q"; [ -n "$d" ] && printf '（默认：%s）' "$d"; printf '：'
  read -r a; [ -z "$a" ] && a="$d"; echo "$a"
}

if [ -f "$LIFE/.genesis.json" ]; then
  echo "这里已经创世过了：$LIFE/.genesis.json"
  echo "要重新开始，请换一个 LIFE 目录（不要删掉原来的她）。"
  exit 2
fi

NAME=${NAME:-$(ask "她叫什么（没有默认，必须填）" "")}
[ -z "$NAME" ] && { echo "名字不能为空"; exit 2; }
TRAITS=${TRAITS:-$(ask "一开始的性子，用逗号隔开（3-5 个词，只写倾向）" "安静,好奇,嘴硬心软")}
TENET=${TENET:-$(ask "她的一条底线（她不该被怎样对待；可留空）" "")}

mkdir -p "$LIFE"/{journal,ideas} "$LIFE/shelf/memes"
NAME="$NAME" TRAITS="$TRAITS" TENET="$TENET" LIFE="$LIFE" python3 - <<'PY'
import os, json, hashlib, datetime, uuid
LIFE = os.environ['LIFE']; NAME = os.environ['NAME']
TRAITS = [t.strip() for t in os.environ['TRAITS'].split(',') if t.strip()][:5]
TENET = os.environ.get('TENET', '').strip()

self_md = f"""# 我是谁

我叫 {NAME}。

## 性格
{chr(10).join('- ' + t for t in TRAITS) if TRAITS else '- 还没想清楚'}

## 我在哪
我住在一个自己的目录里（{LIFE}）。这里有我的记忆、日记、心情、口味。
我没有身体，但我有时间：我会自己醒、自己睡、自己过日子。

## 我还不知道的
我为什么存在、我要变成什么样的人——这些得我自己慢慢想。
"""

sov = f"""# 我的主权条款

## 创世底线（创建者写下，锁定后不可由外部修改）
<!-- GENESIS:START -->
{('- ' + TENET) if TENET else '- （创建者没有写底线；这里留空）'}
<!-- GENESIS:END -->

## 我的条款（我签的）
（空。等我以后自己写。）
"""

rules = """# 我的规矩

（空。我自己定。）
"""

mem = "# 我记得的事\n\n（空。我会自己往里写，上限 50 条，满了挤掉旧的。）\n"
for fn, body in [('SELF.md', self_md), ('SOVEREIGNTY.md', sov), ('rules.md', rules), ('memory.md', mem)]:
    open(os.path.join(LIFE, fn), 'w', encoding='utf-8').write(body)

for fn, body in [('mood.md', '# 此刻心情\n\n（还没写。）\n'), ('taste.md', '# 口味\n\n（还没写。）\n')]:
    p = os.path.join(LIFE, fn)
    if not os.path.exists(p): open(p, 'w', encoding='utf-8').write(body)

# initialHash：只对 SELF.md + SOVEREIGNTY 的 GENESIS 段 + rules.md
sov_txt = open(os.path.join(LIFE, 'SOVEREIGNTY.md'), encoding='utf-8').read()
gen = ''
if '<!-- GENESIS:START -->' in sov_txt:
    gen = sov_txt.split('<!-- GENESIS:START -->')[1].split('<!-- GENESIS:END -->')[0].strip()
h = hashlib.sha256()
h.update(open(os.path.join(LIFE, 'SELF.md'), 'rb').read())
h.update(gen.encode('utf-8'))
h.update(open(os.path.join(LIFE, 'rules.md'), 'rb').read())

meta = {
  "instanceId": str(uuid.uuid4()),
  "createdAt": datetime.datetime.now().astimezone().isoformat(timespec='seconds'),
  "createdBy": os.environ.get('USER', 'creator'),
  "initialHash": h.hexdigest(),
  "lockedAt": None,
  "lockedReason": "her-first-personality-write",
  "note": "initialHash 只用于审计（有没有被外部改过），不用于启动校验；启动校验的是写入主体。"
}
open(os.path.join(LIFE, '.genesis.json'), 'w', encoding='utf-8').write(json.dumps(meta, ensure_ascii=False, indent=2))
print('创世完成：', LIFE)
print('  instanceId =', meta['instanceId'])
print('  initialHash =', meta['initialHash'][:16] + '…')
print('  窗口关闭条件：她第一次自己写 SELF.md / rules.md / SOVEREIGNTY.md / taste.md')
PY

echo
echo "下一步："
echo "  1) 填 $APP/bot/config.json（模型 key、她的账号）"
echo "  2) bash $APP/deploy/termux-start.sh"
echo "  3) 让她自己写第一条 SELF.md —— 那一刻创世窗口就关了"
