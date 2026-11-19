// SPDX-License-Identifier: AGPL-3.0-or-later
// 记忆事件：只追加，记录"程序确实做过的事"。
//   injected  —— 这条记忆被放进了本轮提示词
//   retrieved —— 检索/重排把它挑了出来（recall、rerank）
// 不推断模型内部是否"真的想起"，只记我们能确认的两个动作。
import fs from 'node:fs';
import path from 'node:path';

const LIFE = process.env.LIFE_DIR || '/var/lib/digitallife';
const FILE = path.join(LIFE, 'mem-events.jsonl');
const seen = new Map();   // turnId -> Set(id)

export function logMemoryEvent(kind, items, turnId = '') {
  try {
    const raw = Array.isArray(items) ? items : [items];
    const list = raw.filter(Boolean).map((x) => (typeof x === 'object' ? x : { id: x }));
    if (!list.length) return;
    const turn = turnId || String(Date.now());
    let set = seen.get(turn);
    if (!set) { set = new Set(); seen.set(turn, set); if (seen.size > 200) seen.delete(seen.keys().next().value); }
    const rows = [];
    for (const it of list) {
      const id = it.id;
      if (!id) continue;
      const key = kind + ':' + id;
      if (set.has(key)) continue;      // 同一轮同一条只记一次
      set.add(key);
      const row = { at: Date.now(), kind, id, turn };
      if (it.state) row.state = it.state;
      if (typeof it.score === 'number') row.score = Math.round(it.score * 100) / 100;
      rows.push(JSON.stringify(row));
    }
    if (rows.length) fs.appendFileSync(FILE, rows.join('\n') + '\n');
  } catch {}
}

export function readEvents(limit = 20000) {
  try {
    return fs.readFileSync(FILE, 'utf8').split('\n').filter(Boolean).slice(-limit).map((l) => JSON.parse(l));
  } catch { return []; }
}
