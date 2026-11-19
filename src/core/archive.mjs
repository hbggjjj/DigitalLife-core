// SPDX-License-Identifier: AGPL-3.0-or-later
// 历史原文检索：只读 chat-archive.jsonl，不改任何记忆。
// 目的：当他问"我当时怎么说的"时，能给出原文；找不到就说找不到，不用概括补。
import fs from 'node:fs';
import path from 'node:path';

const LIFE = process.env.LIFE_DIR || '/var/lib/digitallife';
const ARCHIVE = path.join(LIFE, 'chat-archive.jsonl');

function load({ sinceMs = 0, who = 'in' } = {}) {
  const out = [];
  try {
    for (const line of fs.readFileSync(ARCHIVE, 'utf8').split('\n')) {
      if (!line.trim()) continue;
      let d; try { d = JSON.parse(line); } catch { continue; }
      if (!d.at || !d.text) continue;
      if (d.at < sinceMs) continue;
      if (who !== 'all' && d.dir !== who) continue;
      out.push(d);
    }
  } catch {}
  return out;
}

/** 按关键词（任何一词命中即算）检索；返回最近的若干条原始记录 */
export function searchArchive({ keywords = [], sinceDays = 45, who = 'in', limit = 6 } = {}) {
  const sinceMs = Date.now() - sinceDays * 86400000;
  // 最近两天的对话还在"最近聊天"里，不必再从归档里翻，避免把当前的问句当原文
  const cut = Date.now() - 2 * 86400000;
  const rows = load({ sinceMs, who }).filter((d) => d.at < cut);
  const STOP = new Set(['当时', '上次', '那次', '那天', '之前', '原话', '原句', '什么', '怎么', '说的', '讲过', '记不记得', '我', '你', '他', '她']);
  const kws = keywords.map((k) => String(k).trim()).filter((k) => k.length >= 1 && !STOP.has(k));
  // 关键词全是单字时不可靠（"脸"会命中歌词和无关句子）：宁可不给，也不能给错原文
  if (kws.length && kws.every((k) => k.length <= 1)) return [];

  // 打分：命中关键词加分；像在反问的句子减分；全是疑问语气的不要
  const META = /我当时(说|讲|怎么)|原话|我那句|你记不记得/;
  const scored = rows.map((d) => {
    const t = String(d.text);
    let sc = 0;
    for (const k of kws) if (t.includes(k)) sc += 1;
    if (META.test(t)) sc -= 2;
    if (/[？?]$/.test(t)) sc -= 1;
    if (t.length < 6) sc -= 1;
    return { d, sc };
  }).filter((x) => x.sc >= 1).sort((a, b) => a.d.at - b.d.at);
  const hit = scored.map((x) => x.d);
  return hit.slice(-limit).map((d) => ({
    at: d.at,
    dir: d.dir,
    text: String(d.text).slice(0, 240),
  }));
}

/** 给提示词用的一段：只放原文，明确告诉她"这些是原文，找不到别补" */
export function formatArchiveHits(hits, { question = '' } = {}) {
  if (!hits || !hits.length) {
    return '【归档里没有找到原话】他可能在问过去的某句具体的话，但归档里没有对得上的记录。'
      + '可以说"我没找到你当时的原话"，或者只说大意并标成大意；不要补造具体措辞。';
  }
  const lines = hits.map((h) => {
    const d = new Date(h.at + 8 * 3600e3);
    const mm = String(d.getUTCMonth() + 1).padStart(2, '0');
    const dd = String(d.getUTCDate()).padStart(2, '0');
    const hh = String(d.getUTCHours()).padStart(2, '0');
    const mi = String(d.getUTCMinutes()).padStart(2, '0');
    return `- [${mm}-${dd} ${hh}:${mi}] ${h.dir === 'in' ? '他' : '我'}：${h.text}`;
  }).join('\n');
  return `【归档里找到的原文】他可能在问${question ? '「' + question.slice(0, 20) + '」' : '过去的某句话'}，下面是当时的原始记录：\n`
    + lines
    + '\n（要引用就照这里的原文引，带上时间；这里没有的，不要补。）';
}
