// SPDX-License-Identifier: AGPL-3.0-or-later
// 记忆重量：没有显式标记时，按文字里的情绪/关系信号估一个 W1-W5。
// 只用于"哪些更容易被想起"，不删任何条目。
import { trace as traceCall } from '../utils/trace.mjs';
const STRONG = ['喜欢', '爱', '舍不得', '塌了一小块', '记住', '永远', '谢谢', '对不起', '哭', '怕', '难受', '心疼', '重要', '第一次', '答应', '承诺', '走了', '不在'];
const MID = ['有点', '闷', '凉', '空', '惦记', '想', '等', '吵', '气', '笑', '安心'];

export function weightOf(text, at = 0) {
  const t = String(text || '');
  let w = 3;
  for (const k of STRONG) if (t.includes(k)) { w += 1; break; }
  for (const k of MID) if (t.includes(k)) { w += 0.5; break; }
  if (/他/.test(t) && /我/.test(t)) w += 0.5;         // 有"他"和"我"同在，多半是关系事件
  if (t.length > 80) w -= 0.3;                        // 流水账略微降权
  if (at) {
    const days = (Date.now() - at) / 86400000;
    if (days > 30) w -= 0.5; else if (days < 2) w += 0.3;
  }
  return Math.max(1, Math.min(5, Math.round(w)));
}

/** 解析 "- 2026-11-05：内容" 这种行 */
export function parseMemoryLine(line) {
  const m = String(line).match(/^-\s*(\d{4}-\d{2}-\d{2})?[：:]?\s*(.*)$/);
  if (!m) return null;
  const date = m[1] || '';
  const text = (m[2] || '').trim();
  if (!text) return null;
  const at = date ? new Date(date + 'T12:00:00+08:00').getTime() : 0;
  return { date, text, at, w: weightOf(text, at) };
}

export function rankMemory(lines, { coreMin = 4, coreLimit = 18 } = {}) {
  const items = lines.map(parseMemoryLine).filter(Boolean);
  const core = items.filter((x) => x.w >= coreMin).sort((a, b) => b.w - a.w || b.at - a.at).slice(0, coreLimit);
  const coreSet = new Set(core.map((x) => x.text));
  const recent = items.filter((x) => !coreSet.has(x.text)).slice(-20);
  return { core, recent, items };
}

/**
 * 模糊提问时，让模型在候选里挑 1-2 条（只回编号）。
 * 失败返回 null，调用方沿用原来的候选。
 */
export async function rerank(query, candidates) {
  if (!candidates || candidates.length < 3) return null;
  try {
    const fs = await import('node:fs');
    const cfg = JSON.parse(fs.readFileSync('/root/qqbot-v5/bot/config.json', 'utf8'));
    const key = process.env.DEEPSEEK_API_KEY || (cfg.deepseek && cfg.deepseek.apiKey);
    if (!key) return null;
    const list = candidates.map((c, i) => `${i + 1}. ${String(c.text).slice(0, 80)}`).join('\n');
    const r = await fetch(`${(cfg.deepseek.baseUrl || 'https://api.deepseek.com').replace(/\/$/, '')}/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${key}` },
      body: JSON.stringify({
        model: cfg.deepseek.model || 'deepseek-chat',
        messages: [
          { role: 'system', content: '从候选里挑出最可能回答这个问题的 1-2 条。只输出 JSON：{"pick":[编号]}' },
          { role: 'user', content: `问题：${query.slice(0, 100)}\n候选：\n${list}` },
        ],
        temperature: 0,
        max_tokens: 30,
        response_format: { type: 'json_object' },
      }),
      signal: AbortSignal.timeout(12000),
    });
    if (!r.ok) return null;
    const j = await r.json();
    traceCall({ kind: 'rerank', model: cfg.deepseek.model || 'deepseek-chat', messages: [{ role: 'user', content: query }], raw: j.choices?.[0]?.message?.content || '' });
    const pick = JSON.parse(j.choices?.[0]?.message?.content || '{}').pick;
    if (!Array.isArray(pick) || !pick.length) return null;
    return pick.map((n) => candidates[Number(n) - 1]).filter(Boolean);
  } catch { return null; }
}
