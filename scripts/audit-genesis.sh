#!/bin/bash
# 审计：这个人格文件从创世到现在，被外部改过没有？
# 只报告，不阻断（她创世后自己写 SELF.md 是正常的，哈希变了不算错）。
set -u
LIFE=${MIKU_HOME:-__MIKU_HOME__}
META="$LIFE/.genesis.json"
[ -f "$META" ] || { echo "没有 .genesis.json：这个实例不是用 genesis.sh 创世的"; exit 2; }

python3 - "$LIFE" "$META" <<'PY'
import sys, json, hashlib, os
LIFE, META = sys.argv[1], sys.argv[2]
m = json.load(open(META, encoding='utf-8'))
sov = open(os.path.join(LIFE, 'SOVEREIGNTY.md'), encoding='utf-8').read()
gen = ''
if '<!-- GENESIS:START -->' in sov:
    gen = sov.split('<!-- GENESIS:START -->')[1].split('<!-- GENESIS:END -->')[0].strip()
h = hashlib.sha256()
for p in ['SELF.md']:
    h.update(open(os.path.join(LIFE, p), 'rb').read())
h.update(gen.encode('utf-8'))
h.update(open(os.path.join(LIFE, 'rules.md'), 'rb').read())
cur = h.hexdigest()
print('instanceId :', m.get('instanceId'))
print('创世时间   :', m.get('createdAt'))
print('创世哈希   :', m.get('initialHash', '')[:16], '…')
print('当前哈希   :', cur[:16], '…')
print('结论       :', '和创世一致' if cur == m.get('initialHash') else '被她自己或外部改过（大概率是她自己写的，正常）')
PY
