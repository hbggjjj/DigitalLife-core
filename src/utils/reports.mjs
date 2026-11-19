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

// ---------- 结构化归类：只认规则编号 / 字段名 / 关键词，三样都必须字面命中 ----------
const RULE_RE = /规则([一二三四五六七八九十]|\d)/g;
const STOP = new Set(['这个', '那个', '什么', '不是', '我不', '觉得', '好像', '就是', '一个', '时候', '但是', '因为', '所以', '现在', '自己', '有点', '已经', '还是', '一样', '这种', '那样']);

/** 从一条报告里抽结构：规则编号、字段名、关键词（各取字面命中，不做语义推断） */
export function extractKeys(text) {
  const t = String(text || '');
  const rules = [...new Set([...t.matchAll(RULE_RE)].map((m) => '规则' + m[1]))];
  const FIELDS = ['buduijin', 'swallowed', 'frames', 'sleep', 'wake', 'recall', 'check', 'say', 'reply',
    'remember', 'journal', 'mood', 'taste', 'wish', 'search', 'bili', 'awakeIn', 'speakIn', 'followIn', 'stash', 'reach', 'again', 'pick', 'verify', 'think', 'meme', 'channel', 'rules'];
  const fields = FIELDS.filter((f) => t.includes(f));
  // 关键词：连续 2–4 个汉字的片段，去掉停用词，按出现次数排
  const BAD_START = /^[我你他她它的了着过就很还也都又没不别再把被给让和跟对从到]/;
  const cand = (t.match(/[\u4e00-\u9fa5]{2,3}/g) || []).filter((w) => !STOP.has(w) && !BAD_START.test(w));
  const freq = new Map();
  for (const w of cand) freq.set(w, (freq.get(w) || 0) + 1);
  const keywords = [...freq.entries()].filter(([, n]) => n >= 1).sort((a, b) => b[1] - a[1]).slice(0, 3).map(([w]) => w);
  return { rules, fields, keywords };
}

/** 她报一条。只记录，不判断。 */
export function logReport(text) {
  const t = String(text || '').trim().slice(0, 120);
  if (!t) return null;
  const id = 'b' + Date.now().toString(36).slice(-5) + Math.random().toString(36).slice(2, 4);
  const rec = { id, at: Date.now(), text: t, status: 'pending', ...extractKeys(t) };
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

/**
 * 同类聚合：同一规则编号 / 同一字段 / 同一关键词，14 天内 ≥3 次。
 * 只做字面匹配，不做语义归并——避免把她几件不同的事合成一件。
 */
export function clusters({ days = 14, min = 3 } = {}) {
  let rows = [];
  try { rows = fs.readFileSync(REPORTS, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)); } catch { return []; }
  const since = Date.now() - days * 86400000;
  rows = rows.filter((r) => r.at >= since);
  const groups = new Map();
  const add = (kind, key, r) => {
    const k = kind + ':' + key;
    if (!groups.has(k)) groups.set(k, { kind, key, ids: [], latest: 0 });
    const g = groups.get(k);
    if (!g.ids.includes(r.id)) { g.ids.push(r.id); g.latest = Math.max(g.latest, r.at); }
  };
  for (const r of rows) {
    for (const x of (r.rules || [])) add('rule', x, r);
    for (const x of (r.fields || [])) add('field', x, r);
    for (const x of (r.keywords || [])) add('word', x, r);
  }
  return [...groups.values()].filter((g) => g.ids.length >= min).sort((a, b) => b.ids.length - a.ids.length);
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
