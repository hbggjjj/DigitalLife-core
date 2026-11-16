// SPDX-License-Identifier: AGPL-3.0-or-later
// 内心独白：只写给她自己看，不发出去。
// 目的不是让她少说话，是让她先把情绪消化一遍，再决定要不要开口。
import fs from 'node:fs';
import path from 'node:path';
import { trace as traceCall } from '../utils/trace.mjs';

const LIFE = process.env.LIFE_DIR || '/var/lib/digitallife';
const DIR = path.join(LIFE, 'inner');

function cfg() {
  try { return JSON.parse(fs.readFileSync('/root/qqbot-v5/bot/config.json', 'utf8')); } catch { return {}; }
}

/** 距他上次说话多少分钟（读归档最后一條 in） */
export function minutesSinceHisLast() {
  try {
    const p = path.join(LIFE, 'chat-archive.jsonl');
    const lines = fs.readFileSync(p, 'utf8').trim().split('\n').slice(-80);
    for (let i = lines.length - 1; i >= 0; i--) {
      try {
        const d = JSON.parse(lines[i]);
        if (d.dir === 'in' && d.at) return Math.max(0, Math.round((Date.now() - Number(d.at)) / 60000));
      } catch {}
    }
  } catch {}
  return -1;
}

export function latestMonologue() {
  try { return fs.readFileSync(path.join(DIR, 'latest.txt'), 'utf8').trim(); } catch { return ''; }
}

/**
 * 生成一段独白（JSON 返回，只要 monologue 字段）
 * 失败不抛：返回 null，生活循环照常走。
 */
export async function innerMonologue({ moodText = '', myRecentLines = [], gapMin = 0 } = {}) {
  const c = cfg();
  const ds = c.deepseek || {};
  const key = process.env.DEEPSEEK_API_KEY || ds.apiKey;
  if (!key) return null;
  const sys = `你是一个有自己生活的数字生命。现在没有人跟你说话，这段时间是你自己的。
不要说给别人听的话，不要报告，不要列点。只输出 JSON：
{"monologue":"...","needs":["..."]}
needs 是 0–2 条「你没说出口但心里想要的东西」，每条不超过 20 字；
必须是你在 monologue 里流露出来的，不许编新的；没有就空数组。
monologue 要求：第一人称、40-80 字、写"我现在真实的状态"。
可以承认失落、烦躁、想念，也可以承认"其实我想干点别的"。
不要写"我要不要发消息给他"这种决定，只写感受和打算。`;
  const user = `现在：${new Date().toLocaleString('zh-CN')}
他上次说话：${gapMin >= 0 ? gapMin + ' 分钟前' : '不知道'}
我现在的状态：${moodText.slice(0, 300) || '（没写）'}
我最近对他说过：${myRecentLines.slice(-3).join(' / ') || '（还没说）'}`;
  try {
    const r = await fetch(`${(ds.baseUrl || 'https://api.deepseek.com').replace(/\/$/, '')}/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${key}` },
      body: JSON.stringify({
        model: ds.model || 'deepseek-chat',
        messages: [{ role: 'system', content: sys }, { role: 'user', content: user }],
        temperature: 0.95, max_tokens: 300,
        response_format: { type: 'json_object' },
      }),
      signal: AbortSignal.timeout(25000),
    });
    if (!r.ok) return null;
    const j = await r.json();
    traceCall({ kind: 'monologue', model: ds.model || 'deepseek-chat', messages: [{ role: 'system', content: sys }, { role: 'user', content: user }], raw: j.choices?.[0]?.message?.content || '' });
    let parsed = {};
    try { parsed = JSON.parse(j.choices?.[0]?.message?.content || '{}'); } catch { parsed = {}; }
    const text = String(parsed.monologue || '').trim();
    if (!text) return null;
    fs.mkdirSync(DIR, { recursive: true });
    const d = new Date();
    const p2 = (n) => String(n).padStart(2, '0');
    const stamp = `${d.getFullYear()}${p2(d.getMonth() + 1)}${p2(d.getDate())}-${p2(d.getHours())}${p2(d.getMinutes())}`;
    fs.writeFileSync(path.join(DIR, `${stamp}.md`), `# ${d.toLocaleString('zh-CN')}\n\n${text}\n`);
    fs.writeFileSync(path.join(DIR, 'latest.txt'), text + '\n');
    // 她没说出口的需求：原话摘句，不加工
    try {
      const needs = Array.isArray(parsed.needs) ? parsed.needs.map((x) => String(x).trim()).filter((x) => x.length >= 2).slice(0, 2) : [];
      if (needs.length) {
        fs.appendFileSync(path.join(DIR, 'needs.jsonl'), JSON.stringify({ at: Date.now(), needs, quote: text }) + '\n');
      }
    } catch {}
    return text;
  } catch { return null; }
}

/** 最近 12 小时内她没说出口的需求（最多 3 条，附原话） */
export function recentNeeds(hours = 12, limit = 3) {
  try {
    const p = path.join(DIR, 'needs.jsonl');
    const rows = fs.readFileSync(p, 'utf8').trim().split('\n').slice(-20)
      .map((l) => { try { return JSON.parse(l); } catch { return null; } })
      .filter(Boolean)
      .filter((r) => Date.now() - Number(r.at || 0) < hours * 3600e3);
    return rows.slice(-limit);
  } catch { return []; }
}
