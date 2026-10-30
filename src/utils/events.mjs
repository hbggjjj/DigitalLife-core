// 结构化事件流：机器人每一步决策都写进 events.jsonl，供控制面板展示
import fs from 'node:fs';
import path from 'node:path';

const FILE = '__MIKU_ROOT__/bot/events.jsonl';
const MAX_BYTES = 4 * 1024 * 1024;

let lastRotateCheck = 0;
let lastEmit = { key: '', at: 0 };   // 同一件事 3 秒内重复写，只留一条

export function emit(src, type, text = '', meta = null) {
  const key = src + '|' + type + '|' + String(text || '').slice(0, 120);
  const nowMs = Date.now();
  if (key === lastEmit.key && nowMs - lastEmit.at < 3000) return { deduped: true, ts: nowMs };
  lastEmit = { key, at: nowMs };
  const rec = { ts: Date.now(), src, type, text: String(text || '').slice(0, 2000), meta };
  try {
    const now = Date.now();
    if (now - lastRotateCheck > 60000) {
      lastRotateCheck = now;
      try {
        const st = fs.statSync(FILE);
        if (st.size > MAX_BYTES) fs.renameSync(FILE, FILE + '.1');
      } catch {}
    }
    fs.appendFileSync(FILE, JSON.stringify(rec) + '\n');
  } catch {}
  return rec;
}

export function readEvents(sinceTs = 0, limit = 200) {
  try {
    const raw = fs.readFileSync(FILE, 'utf8');
    const lines = raw.split('\n').filter(Boolean);
    const out = [];
    for (let i = lines.length - 1; i >= 0 && out.length < limit; i--) {
      try {
        const r = JSON.parse(lines[i]);
        if (r.ts > sinceTs) out.push(r);
      } catch {}
    }
    return out.reverse();
  } catch { return []; }
}

export { FILE };
