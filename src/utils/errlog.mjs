// 详细错误日志：每次报错写一行 JSON，带堆栈和上下文。
// 她只看最近几条摘要；完整记录给维护者排障。
import fs from 'node:fs';

const FILE = '__MIKU_ROOT__/bot/errors.log';
const MAX_BYTES = 2 * 1024 * 1024;
let lastRotate = 0;

function rotate() {
  const now = Date.now();
  if (now - lastRotate < 60000) return;
  lastRotate = now;
  try {
    const st = fs.statSync(FILE);
    if (st.size > MAX_BYTES) fs.renameSync(FILE, FILE + '.1');
  } catch {}
}

/** 记一条错误。meta 里放和这次错误有关的上下文（url/bvid/uid…） */
export function logErr(source, err, meta = {}) {
  try {
    rotate();
    const e = err instanceof Error ? err : new Error(String(err));
    const rec = {
      ts: Date.now(),
      at: new Date().toISOString(),
      source,                                  // 哪一块出的错
      message: String(e.message || e).slice(0, 500),
      code: e.code || null,
      cause: e.cause ? String(e.cause).slice(0, 200) : null,
      stack: String(e.stack || '').split('\n').slice(0, 6).join('\n'),
      meta,                                    // 上下文
    };
    fs.appendFileSync(FILE, JSON.stringify(rec) + '\n');
    return rec;
  } catch { return null; }
}

/** 读最近 n 条（可过滤 source） */
export function readErrors(n = 10, source = '') {
  try {
    const lines = fs.readFileSync(FILE, 'utf8').split('\n').filter(Boolean);
    const out = lines.map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
    const filtered = source ? out.filter((r) => r.source === source) : out;
    return filtered.slice(-n);
  } catch { return []; }
}

/** 给她的摘要：最近 n 条，一句话一条 */
export function brief(n = 2) {
  const rows = readErrors(n);
  if (!rows.length) return '';
  return rows.map((r) => {
    const t = new Date(r.ts);
    const hh = String(t.getHours()).padStart(2, '0');
    const mm = String(t.getMinutes()).padStart(2, '0');
    const msg = r.message.replace(/\s+/g, ' ').slice(0, 46);
    return `${hh}:${mm} ${r.source}：${msg}`;
  }).join('；');
}
