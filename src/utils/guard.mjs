// 禁区守卫：agent 每次思考前后校验关键文件，被改了就报警并还原
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { emit } from './events.mjs';

const PROTECTED = [
  ...(process.env.NAPCAT_DIR ? [`${process.env.NAPCAT_DIR}/config/onebot11.json`, `${process.env.NAPCAT_DIR}/config/webui.json`] : []),
  '__MIKU_ROOT__/supervisor.sh',
  '__MIKU_ROOT__/start_all.sh',
];
const VOLATILE = ['state.json', 'events.jsonl', 'usage.jsonl', 'retry_queue.jsonl', '.online', '.heartbeat'];
const BACKUP = '__MIKU_ROOT__/.guard-backup';
// 维护者按流程改过的文件：写下 expected hash，guard 认这个，不认旧内存基线
const ALLOW = '__MIKU_ROOT__/.guard-allow.json';

function allowedHash(f) {
  try { return JSON.parse(fs.readFileSync(ALLOW, 'utf8'))[f] || null; } catch { return null; }
}
const LOG = '__MIKU_ROOT__/bot/guard.log';

function sha(file) {
  try { return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex'); }
  catch { return null; }
}
function log(line) {
  try { fs.appendFileSync(LOG, `[${new Date().toISOString()}] ${line}\n`); } catch {}
}

export function snapshot() {
  const out = {};
  for (const f of PROTECTED) out[f] = sha(f);
  return out;
}

export function backupAll() {
  try { fs.mkdirSync(BACKUP, { recursive: true }); } catch {}
  for (const f of PROTECTED) {
    try {
      if (!fs.existsSync(f)) continue;
      const dest = path.join(BACKUP, f.replace(/\//g, '_'));
      if (!fs.existsSync(dest)) fs.copyFileSync(f, dest);
    } catch {}
  }
}

/** 返回被篡改的文件列表（已自动还原） */
export function verify(before) {
  const after = snapshot();
  const changed = [];
  for (const f of PROTECTED) {
    const expected = allowedHash(f);            // 维护者声明的 hash 优先
    const base = expected || before[f];
    if (base !== after[f]) changed.push(f);
  }
  if (!changed.length) return [];
  for (const f of changed) {
    if (VOLATILE.some((v) => f.endsWith(v))) { log(`跳过活数据 ${f}（本来就该一直变）`); continue; }
    const bak = path.join(BACKUP, f.replace(/\//g, '_'));
    try {
      if (fs.existsSync(bak)) { fs.copyFileSync(bak, f); log(`已还原 ${f}`); }
      else log(`无备份，无法还原 ${f}`);
    } catch (e) { log(`还原失败 ${f}: ${e.message}`); }
  }
  const msg = `agent 动了禁区文件：${changed.join('、')}（已尝试还原）`;
  log(msg);
  emit('guard', 'violation', msg, { files: changed });
  return changed;
}

backupAll();
