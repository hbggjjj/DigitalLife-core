// SPDX-License-Identifier: AGPL-3.0-or-later
// 判断"他是不是在问过去某句具体的话"，并抽出检索用的线索（话题 / 时间 / 说话人）。
// 先用便宜的信号筛一遍，再用一次极小的模型调用确认；模型不可用时退回信号判断。
import fs from 'node:fs';

const SIGNAL = /(我当时|我说过|我说了什么|怎么说的|怎么讲|原话|原句|原话是|你记不记得我|我说那句|那句我|逐字|一字不差)/;

export async function detectQuoteIntent(text) {
  const t = String(text || '').trim();
  if (!t) return null;
  const likely = SIGNAL.test(t) || /[?？].*(说|讲|提)/.test(t) && /(当时|上次|那天|之前|那次)/.test(t);
  if (!likely) return null;                      // 没迹象就不惊动模型
  try {
    const cfg = JSON.parse(fs.readFileSync((process.env.QQBOT_ROOT || '/root/qqbot-v5') + '/bot/config.json', 'utf8'));
    const key = process.env.DEEPSEEK_API_KEY || (cfg.deepseek && cfg.deepseek.apiKey);
    if (!key) return { keywords: pickKeywords(t), sinceDays: 45, who: 'in' };
    const r = await fetch(`${(cfg.deepseek.baseUrl || 'https://api.deepseek.com').replace(/\/$/, '')}/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${key}` },
      body: JSON.stringify({
        model: cfg.deepseek.model || 'deepseek-chat',
        temperature: 0,
        max_tokens: 120,
        response_format: { type: 'json_object' },
        messages: [{
          role: 'system',
          content: '判断这句话是不是在要"过去某句具体的话/原话"，并抽出检索线索。'
            + '只输出 JSON：{"askQuote":true|false,"keywords":["…"],"sinceDays":数字,"who":"in"|"out"|"all"}'
            + '\nkeywords 给 1-3 个最可能出现在原话里的词；sinceDays 是粗略时间范围（天），不确定就 45。',
        }, { role: 'user', content: t.slice(0, 120) }],
      }),
      signal: AbortSignal.timeout(8000),
    });
    const j = JSON.parse((await r.json()).choices?.[0]?.message?.content || '{}');
    if (!j.askQuote) return null;
    return {
      keywords: Array.isArray(j.keywords) ? j.keywords.slice(0, 3).map(String) : pickKeywords(t),
      sinceDays: Number(j.sinceDays) > 0 ? Math.min(365, Number(j.sinceDays)) : 45,
      who: ['in', 'out', 'all'].includes(j.who) ? j.who : 'in',
    };
  } catch {
    return { keywords: pickKeywords(t), sinceDays: 45, who: 'in' };
  }
}

function pickKeywords(t) {
  const stop = /^(我当时|我说|过|的|了|吗|呢|什么|怎么|那句|原话|你|我|他|她|还|记不记得|说|讲|提)/;
  const words = t.replace(/[，。！？、,.!?]/g, ' ').split(/\s+/).filter(Boolean);
  const kw = words.filter((w) => w.length >= 2 && !stop.test(w)).slice(0, 3);
  return kw.length ? kw : [t.slice(0, 6)];
}
