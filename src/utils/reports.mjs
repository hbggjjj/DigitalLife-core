// SPDX-License-Identifier: AGPL-3.0-or-later
// 「不对劲」：她报告"规则都合规，但我这里坏了"。
// 不进需求池（wish），也不等于操作失败（swallowed）——它进审计流程，必须有结论。
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = process.env.QQBOT_ROOT || path.resolve(HERE, '../..');
// 她的家：环境变量优先；否则按存在性找，最后才用仓库默认
const LIFE = (() => {
  if (process.env.LIFE_DIR) return process.env.LIFE_DIR;
  for (const c of [path.resolve(ROOT, '../life'), '/var/lib/digitallife', '/var/lib/digitallife']) {
    try { if (fs.existsSync(path.join(c, 'memory.md'))) return c; } catch {}
  }
  return '/var/lib/digitallife';
})();

const REPORTS = path.join(ROOT, 'bot', 'self-reports.jsonl');
const AUDIT = path.join(ROOT, 'bot', 'audit.jsonl');
const RECEIPTS = path.join(ROOT, 'bot', 'pending-report-receipts.json');
const HER_VIEW = path.join(LIFE, 'self-reports.md');

const readJson = (p, d) => { try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch { return d; } };
const writeJson = (p, v) => { try { fs.writeFileSync(p, JSON.stringify(v, null, 2)); } catch {} };

/** 她报一条。只记录，不判断。 */
export function logReport(text) {
  const t = String(text || '').trim().slice(0, 120);
  if (!t) return null;
  const id = 'b' + Date.now().toString(36).slice(-5);
  const rec = { id, at: Date.now(), text: t, status: 'pending' };
  try { fs.appendFileSync(REPORTS, JSON.stringify(rec) + '\n'); } catch {}
  try {
    const ts = new Date(rec.at + 8 * 3600e3).toISOString().slice(0, 16).replace('T', ' ');
    fs.appendFileSync(HER_VIEW, `- ${ts}　${t}（${id}）　状态：待审计\n`);
  } catch {}
  const pend = readJson(RECEIPTS, []);
  pend.push(rec);
  writeJson(RECEIPTS, pend.slice(-10));
  return id;
}

/** 取走待回执（每轮一次，取完即清） */
export function takeReportReceipts() {
  const pend = readJson(RECEIPTS, []);
  if (pend.length) writeJson(RECEIPTS, []);
  return pend;
}

/** 待审计 / 挂起超 7 天的 */
export function pendingReports() {
  try {
    const rows = fs.readFileSync(REPORTS, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
    const done = new Set(
      fs.existsSync(AUDIT)
        ? fs.readFileSync(AUDIT, 'utf8').split('\n').filter(Boolean).map((l) => { try { return JSON.parse(l).id; } catch { return null; } }).filter(Boolean)
        : []
    );
    return rows.filter((r) => !done.has(r.id));
  } catch { return []; }
}

/** 写一条审计结论。依据必填——没有依据的判定视为无效。 */
export function addFinding({ id, verdict, evidence, action, say }) {
  const V = ['defect', 'rule-cost', 'misread', 'unknown'];
  if (!V.includes(verdict)) throw new Error('判定只能是 defect / rule-cost / misread / unknown');
  if (!evidence || String(evidence).trim().length < 8) throw new Error('必须写依据（trace id / 代码位置 / 复现步骤）');
  const rec = { id, at: Date.now(), verdict, evidence: String(evidence).slice(0, 500), action: String(action || '').slice(0, 200), say: String(say || '').slice(0, 200) };
  try { fs.appendFileSync(AUDIT, JSON.stringify(rec) + '\n'); } catch {}
  try {
    const ts = new Date(rec.at + 8 * 3600e3).toISOString().slice(0, 16).replace('T', ' ');
    const zh = { defect: '系统缺陷', 'rule-cost': '规则代价', misread: '我理解错了', unknown: '无法判定（挂起观察）' }[verdict];
    fs.appendFileSync(HER_VIEW, `- ${ts}　${id} 的结论：${zh}｜${rec.say}\n`);
  } catch {}
  return rec;
}
