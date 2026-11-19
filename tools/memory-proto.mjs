// SPDX-License-Identifier: AGPL-3.0-or-later
// 只读原型：拿现有 memory.md 算激活度、做检索、看上下文会选到哪些。
// 不写任何文件，不改运行逻辑。
// 用法：node tools/memory-proto.mjs [life目录] [查询词]
import fs from 'node:fs';
import crypto from 'node:crypto';
import path from 'node:path';

const LIFE = process.argv[2] || process.env.LIFE_DIR || '/var/lib/digitallife';
const QUERY = process.argv[3] || '';
const FLOOR = process.argv[4] !== undefined ? Number(process.argv[4]) : -0.5;   // legacy_unknown 的临时下限
const DECAY = 0.5;        // ACT-R 的 d
const NOISE = 0.25;       // 每次读入时的随机扰动（模拟"有时想得起有时想不起"）

const now = Date.now();
const DAY = 86400000;

function parseMemory(text) {
  const items = [];
  let section = '';
  for (const line of text.split('\n')) {
    if (line.startsWith('## ')) { section = line.slice(3).trim(); continue; }
    if (!line.startsWith('- ')) continue;
    const m = line.match(/^- (?:\[superseded\] )?(\d{4}-\d{2}-\d{2})?[：:]?\s*([\s\S]*?)\s*(?:\[src:(\w+)\])?\s*(?:\[h(\d+)\])?\s*$/);
    if (!m) continue;
    const date = m[1] || '';
    const text2 = (m[2] || '').trim();
    if (!text2) continue;
    const at = date ? new Date(date + 'T12:00:00+08:00').getTime() : now - 30 * DAY;
    const id = 'm-' + crypto.createHash('sha1').update(date + '|' + text2).digest('hex').slice(0, 10);
    items.push({
      id, date, text: text2, at,
      src: m[3] || 'chat',
      hits: m[4] ? Number(m[4]) : 0,
      superseded: line.startsWith('- [superseded]'),
      section,
    });
  }
  return items;
}

// 优先用 mem-events.jsonl 里的真实时间戳；没有事件才退回按 hits 平铺估算
function loadEvents() {
  const f = path.join(LIFE, 'mem-events.jsonl');
  const map = new Map();
  try {
    for (const line of fs.readFileSync(f, 'utf8').split('\n')) {
      if (!line.trim()) continue;
      let e; try { e = JSON.parse(line); } catch { continue; }
      if (!e.id || !e.at) continue;
      if (!map.has(e.id)) map.set(e.id, []);
      map.get(e.id).push(e.at);
    }
  } catch {}
  return map;
}

function activation(it) {
  const age = Math.max(1, (now - it.at) / DAY);          // 天
  const hits = Math.max(0, it.hits);
  if (hits === 0) return -DECAY * Math.log(age);          // 没有任何真实回想记录：只按时间衰减
  // 注意：memory.md 里的 [hN] 是旧口径（soul 重建就 +1），已不可信，只用于展示，不参与计算
  if (true) return -DECAY * Math.log(age);
  let sum = 0;
  for (let j = 0; j < hits; j++) {
    const t = age * (1 - (j + 0.5) / hits);              // 均分在历史里
    sum += Math.pow(Math.max(0.2, t), -DECAY);
  }
  return Math.log(sum);
}

const W_STRONG = ['喜欢', '爱', '舍不得', '记住', '永远', '谢谢', '对不起', '哭', '怕', '难受', '心疼', '重要', '第一次', '答应', '承诺', '走了', '不在'];
const W_MID = ['有点', '闷', '凉', '空', '惦记', '想', '等', '吵', '气', '笑', '安心'];
function weightOf(t) {
  let w = 3;
  for (const k of W_STRONG) if (t.includes(k)) { w += 1; break; }
  for (const k of W_MID) if (t.includes(k)) { w += 0.5; break; }
  if (/他/.test(t) && /我/.test(t)) w += 0.5;
  if (t.length > 80) w -= 0.3;
  return Math.max(1, Math.min(5, Math.round(w)));
}

const events = loadEvents();

// 事件体系从第一条事件开始生效；早于这个时刻、又没有事件的，是 legacy_unknown（历史未知）
let EPOCH = Infinity;
for (const arr of events.values()) for (const t of arr) if (t < EPOCH) EPOCH = t;
if (!Number.isFinite(EPOCH)) EPOCH = Date.now();

const file = path.join(LIFE, 'memory.md');
const raw = fs.readFileSync(file, 'utf8');
const items = parseMemory(raw).map((it) => {
  const ev = events.get(it.id) || [];
  let act, state;
  if (ev.length) {
    let sum = 0;
    for (const t of ev) sum += Math.pow(Math.max(0.2, (now - t) / DAY), -DECAY);
    act = Math.log(sum);
    state = 'tracked';
  } else if (it.at < EPOCH) {
    // 历史未知：统计体系建立之前的记忆，不能当成"从未被想起"
    act = Math.max(activation(it), FLOOR);
    state = 'legacy_unknown';
  } else {
    act = activation(it);          // 统计体系建立后确实没被调用过：正常衰减
    state = 'idle';
  }
  let scored = act + (Math.random() - 0.5) * 2 * NOISE;
  if (state === 'legacy_unknown') scored = Math.max(scored, FLOOR);   // 严格下限：噪声也不许穿
  return { ...it, ev: ev.length, state, w: weightOf(it.text), act: scored };
});

const byAct = [...items].sort((a, b) => b.act - a.act);
const band = (d) => (d < 7 ? '近 7 天' : d < 30 ? '8–30 天' : d < 90 ? '1–3 个月' : '3 个月以上');
const groups = {};
for (const it of items) {
  const d = (now - it.at) / DAY;
  const k = band(d);
  groups[k] = groups[k] || { n: 0, act: [], w: [] };
  groups[k].n++; groups[k].act.push(it.act); groups[k].w.push(it.w);
}
const avg = (a) => (a.reduce((x, y) => x + y, 0) / (a.length || 1));

// 上下文选择：核心 + 相关 + 最新（三段，各有配额）
const CORE_Q = 20, REL_Q = 12, REC_Q = 10;
const core = byAct.filter((x) => x.w >= 4).slice(0, CORE_Q);
const coreSet = new Set(core);
const recent = items.filter((x) => (now - x.at) / DAY <= 7 && !coreSet.has(x)).sort((a, b) => b.at - a.at).slice(0, REC_Q);
const rel = QUERY
  ? items.filter((x) => !coreSet.has(x) && !recent.includes(x)
      && (x.text.includes(QUERY) || QUERY.split(/\s+/).some((q) => q && x.text.includes(q))))
      .sort((a, b) => b.act - a.act).slice(0, REL_Q)
  : [];

const chosen = new Set([...core, ...recent, ...rel]);
const chars = [...chosen].reduce((n, x) => n + x.text.length + 12, 0);

console.log('=== 记忆只读原型 ===');
console.log(`文件：${file}`);
console.log(`条目：${items.length}   文件字数：${raw.length}   上限：10000`);
console.log('');

console.log('--- 按年龄段看激活度 ---');
for (const k of ['近 7 天', '8–30 天', '1–3 个月', '3 个月以上']) {
  const g = groups[k];
  if (!g) continue;
  console.log(`${k.padEnd(10)} ${String(g.n).padStart(3)} 条   平均激活 ${avg(g.act).toFixed(2)}   平均权重 ${avg(g.w).toFixed(1)}`);
}
console.log('');

const byState = {};
for (const it of items) byState[it.state] = (byState[it.state] || 0) + 1;
console.log(`状态：tracked ${byState.tracked || 0} 条 · legacy_unknown ${byState.legacy_unknown || 0} 条 · idle ${byState.idle || 0} 条   （legacy 下限 ${FLOOR}）`);
console.log('');

console.log('--- 上下文会读到哪些（三段配额）---');
console.log(`核心 ${core.length} 条（w≥4）  最新 ${recent.length} 条（7 天内）  相关 ${rel.length} 条${QUERY ? '（查询：' + QUERY + '）' : '（未给查询）'}`);
console.log(`共 ${chosen.size} 条 / ${chars} 字  （上一次实际注入上限 10000 字）`);
console.log('');

if (QUERY) {
  console.log(`--- 查询「${QUERY}」勾到的条目（前 8）---`);
  for (const it of [...rel].slice(0, 8)) {
    console.log(`  ${it.state.padEnd(14)} w${it.w}  ${it.date || '(无日期)'}  ${it.text.slice(0, 30)}`);
  }
  console.log('');
}

console.log('--- 激活度最高的 12 条 ---');
for (const it of byAct.slice(0, 12)) {
  console.log(`  ${it.act.toFixed(2).padStart(6)}  ${it.state.padEnd(14)} w${it.w}  ev${String(it.ev).padStart(2)}  ${it.date || '(无日期)'}  ${it.text.slice(0, 28)}`);
}
console.log('');

console.log('--- 激活度最低的 8 条（"想不起来"的候选）---');
for (const it of byAct.slice(-8)) {
  console.log(`  ${it.act.toFixed(2).padStart(6)}  ${it.state.padEnd(14)} w${it.w}  ev${String(it.ev).padStart(2)}  ${it.date || '(无日期)'}  ${it.text.slice(0, 28)}`);
}
console.log('');

const oldImportant = items.filter((x) => x.w >= 5 && (now - x.at) / DAY > 30);
console.log(`--- 低频但重要（w≥5 且 >30 天）：${oldImportant.length} 条，仍在核心段：${oldImportant.filter((x) => coreSet.has(x)).length} 条 ---`);
for (const it of oldImportant.slice(0, 6)) {
  console.log(`  ${it.act.toFixed(2).padStart(6)}  w${it.w}  h${String(it.hits).padStart(2)}  ${it.date}  ${it.text.slice(0, 34)}`);
}
