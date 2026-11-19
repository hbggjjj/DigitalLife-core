// SPDX-License-Identifier: AGPL-3.0-or-later
// 静默失败的收据：
//   facts   —— 系统侧：她这一轮请求了、但没被执行的动作（结构化事实）
//   receipt —— 她侧：她自己登记的 swallowed，下一轮必须看到回执
// 两条线都只追加，不推断、不补解释。
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = process.env.QQBOT_ROOT || path.resolve(HERE, '../..');
// 她的家：优先环境变量；否则依次试项目旁的 life/、仓库默认的 /var/lib/digitallife
const LIFE = (() => {
  if (process.env.LIFE_DIR) return process.env.LIFE_DIR;
  const beside = path.resolve(ROOT, '../life');
  try { if (fs.existsSync(path.join(beside, 'memory.md')) || fs.existsSync(path.join(beside, 'SELF.md'))) return beside; } catch {}
  return '/var/lib/digitallife';
})();

const FACTS = path.join(ROOT, 'bot', 'action-facts.jsonl');
const FACTS_PENDING = path.join(ROOT, 'bot', 'pending-facts.json');
const SWALLOWED = path.join(ROOT, 'bot', 'swallowed.jsonl');
const RECEIPTS = path.join(ROOT, 'bot', 'pending-receipts.json');
const HER_VIEW = path.join(LIFE, 'swallowed.md');

function readJson(p, dflt) { try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch { return dflt; } }
function writeJson(p, v) { try { fs.writeFileSync(p, JSON.stringify(v, null, 2)); } catch {} }

/** 她请求了某个动作但没执行：记一条事实，下一轮拼上下文时告诉她 */
export function recordFact({ action, request, outcome, reason }) {
  try {
    const rec = { at: Date.now(), action, request: String(request || '').slice(0, 80), outcome, reason: reason || '原因未知' };
    fs.appendFileSync(FACTS, JSON.stringify(rec) + '\n');
    const pend = readJson(FACTS_PENDING, []);
    pend.push(rec);
    writeJson(FACTS_PENDING, pend.slice(-10));
  } catch {}
}

/** 取走待披露的事实（取完就清，避免每轮重复） */
export function takeFacts() {
  const pend = readJson(FACTS_PENDING, []);
  if (pend.length) writeJson(FACTS_PENDING, []);
  return pend;
}

let seq = 0;
/** 她登记"我想做的事没发生"：落盘 + 写进她能读的文件 + 排一条回执 */
export function logSwallowed(text) {
  const t = String(text || '').trim().slice(0, 60);
  if (!t) return null;
  const id = 's' + Date.now().toString(36).slice(-5) + (seq++ % 10);
  const rec = { at: Date.now(), id, text: t };
  try { fs.appendFileSync(SWALLOWED, JSON.stringify(rec) + '\n'); } catch {}
  try {
    fs.appendFileSync(HER_VIEW, `- ${new Date(rec.at + 8 * 3600e3).toISOString().slice(0, 16).replace('T', ' ')}　${t}（${id}）\n`);
  } catch {}
  const pend = readJson(RECEIPTS, []);
  pend.push(rec);
  writeJson(RECEIPTS, pend.slice(-10));
  return id;
}

/** 取走待回执（取完就清；同一条不会每轮重复） */
export function takeReceipts() {
  const pend = readJson(RECEIPTS, []);
  if (pend.length) writeJson(RECEIPTS, []);
  return pend;
}
