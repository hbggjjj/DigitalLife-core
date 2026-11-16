// SPDX-License-Identifier: AGPL-3.0-or-later
// 记忆反事实实验：只读 trace，只改内存里的字符串，不写她的任何文件。
// 用法：node scripts/experiment-ablation.mjs <trace-at> "<要删的记忆片段>" "<提问>" [次数]
import fs from 'node:fs';

const [AT, FRAGMENT, Q, N0] = process.argv.slice(2);
const N = Number(N0 || 6);
if (!AT || !FRAGMENT || !Q) {
  console.log('用法：node scripts/experiment-ablation.mjs <trace-at> "<记忆片段>" "<提问>" [次数]');
  process.exit(1);
}
const LIFE = process.env.LIFE_DIR || '/home/ni/life';
const ROOT = process.env.QQBOT_ROOT || process.cwd();
const CFG = JSON.parse(fs.readFileSync(`${ROOT}/bot/config.json`, 'utf8'));
const KEY = process.env.DEEPSEEK_API_KEY || CFG.deepseek.apiKey;
const URL = `${(CFG.deepseek.baseUrl || 'https://api.deepseek.com').replace(/\/$/, '')}/chat/completions`;

function find(entryAt) {
  const dir = `${LIFE}/trace`;
  for (const f of fs.readdirSync(dir).filter((x) => x.endsWith('.jsonl')).sort().reverse()) {
    for (const line of fs.readFileSync(`${dir}/${f}`, 'utf8').split('\n')) {
      if (!line.trim()) continue;
      let d; try { d = JSON.parse(line); } catch { continue; }
      if (String(d.at) === String(entryAt) && (d.in || []).some((m) => m.role === 'system')) return d;
    }
  }
  return null;
}

const entry = find(AT);
if (!entry) { console.log('找不到该轮（或该轮没有记录提示词）'); process.exit(1); }
const sys = entry.in.find((m) => m.role === 'system').content;
const target = sys.split('\n').find((l) => l.startsWith('- ') && l.includes(FRAGMENT));
if (!target) { console.log('提示词里没有包含该片段的记忆条目'); process.exit(1); }
const sysB = sys.split('\n').filter((l) => l !== target).join('\n');

async function call(system) {
  const r = await fetch(URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${KEY}` },
    body: JSON.stringify({
      model: CFG.deepseek.model,
      temperature: CFG.deepseek.temperature || 0.95,
      messages: [{ role: 'system', content: system }, { role: 'user', content: `他刚说：「${Q}」` }],
      max_tokens: 520,
      response_format: { type: 'json_object' },
    }),
    signal: AbortSignal.timeout(90000),
  });
  const j = await r.json();
  const t = j.choices?.[0]?.message?.content || '{}';
  let o = {}; try { o = JSON.parse(t); } catch {}
  const say = o.say || o.messages || [];
  return Array.isArray(say) ? say.join(' / ') : String(say || t.slice(0, 60));
}

console.log(`将被删掉的记忆：${target.slice(0, 80)}`);
console.log(`提示词：${sys.length} → ${sysB.length} 字（差 ${sys.length - sysB.length}）\n`);
for (const [label, system] of [['A 含记忆', sys], ['B 删掉', sysB]]) {
  console.log(`=== ${label} ×${N} ===`);
  for (let i = 0; i < N; i++) console.log('  ' + (await call(system)));
  console.log('');
}
