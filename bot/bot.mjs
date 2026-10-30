#!/usr/bin/env node
// 主动开口：不用定时器，用「冲动值」决定要不要说话
import fs from 'node:fs';
import dns from 'node:dns';
try { dns.setDefaultResultOrder('ipv4first'); } catch {}
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spontaneous, applyActions, pickSay } from '../src/core/mind.mjs';
import { emit } from '../src/utils/events.mjs';
import { rebuild as rebuildSoul, get as getSoul, addIdea, listIdeas, readMood } from '../src/core/soul.mjs';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
let cfg = JSON.parse(fs.readFileSync(path.join(ROOT, 'config.json'), 'utf8'));
const STATE_FILE = path.join(ROOT, 'state.json');
const LOG_FILE = path.join(ROOT, 'bot.log');

const p2 = (n) => String(n).padStart(2, '0');
const ts = (d = new Date()) => `${d.getFullYear()}-${p2(d.getMonth() + 1)}-${p2(d.getDate())} ${p2(d.getHours())}:${p2(d.getMinutes())}:${p2(d.getSeconds())}`;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const localDate = () => {
  const d = new Date();
  const p2 = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p2(d.getMonth() + 1)}-${p2(d.getDate())}`;
};
function log(...a) { const l = `[${ts()}] ${a.join(' ')}`; console.log(l); try { fs.appendFileSync(LOG_FILE, l + '\n'); } catch {} }

const loadState = () => { try { return JSON.parse(fs.readFileSync(STATE_FILE, 'utf8')); } catch { return { history: [] }; } };
const saveState = (s) => fs.writeFileSync(STATE_FILE, JSON.stringify(s, null, 2));

function reloadCfg() { try { cfg = JSON.parse(fs.readFileSync(path.join(ROOT, 'config.json'), 'utf8')); } catch {} }

async function onebot(action, params = {}) {
  const r = await fetch(`${cfg.napcat.baseUrl.replace(/\/$/, '')}/${action}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${cfg.napcat.token}` },
    body: JSON.stringify(params), signal: AbortSignal.timeout(20000),
  });
  const d = await r.json();
  if (d.status === 'failed') throw new Error(JSON.stringify(d).slice(0, 200));
  return d;
}
async function loginInfo() {
  const d = await onebot('get_login_info');
  if (!d?.data?.user_id) throw new Error('未登录');
  return d.data;
}
async function target() {
  const t = cfg.target || {};
  if (t.mode === 'self') { const me = await loginInfo(); return { type: 'private', id: String(me.user_id) }; }
  return { type: t.type || 'private', id: String(t.id) };
}
function channelNow() {
  // 真源是 config.channels.active（state.channel 会被并发写覆盖，见 AGENTS.md §2.3b）
  try {
    if (cfg.channels && cfg.channels.active) return cfg.channels.active === 'selfim' ? 'selfim' : 'qq';
    const st = loadState();
    return st.channel === 'selfim' ? 'selfim' : 'qq';
  } catch { return 'qq'; }
}

// 走自建 IM：协议 §3 的 /api/v1/send（她自己的账号由桥接持有）
async function sendSelfim(text) {
  const sc = cfg.selfim || {};
  const base = String(sc.baseUrl || 'http://127.0.0.1:7791').replace(/\/$/, '');
  const r = await fetch(base + '/api/v1/send', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...(sc.token ? { Authorization: 'Bearer ' + sc.token } : {}) },
    body: JSON.stringify({ clientMsgId: Date.now().toString(36) + Math.random().toString(36).slice(2, 8),
      to: sc.to || 'user-1', kind: 'text', payload: { text }, ts: Date.now() }),
    signal: AbortSignal.timeout(10000),
  });
  const d = await r.json().catch(() => ({}));
  if (!r.ok || d.ok === false) throw new Error(d.message || ('自建 IM HTTP ' + r.status));
  return d;
}

// 自建 IM 发不出去时，进同一个补发队列（带 channel，等哪条通补哪条）
function enqueueSelfim(text) {
  try {
    const fsq = fs;   // 顶部已 import fs
    const item = { ts: Date.now(), channel: 'selfim', kind: 'text', payload: { to: (cfg.selfim && cfg.selfim.to) || 'user-1', text }, attempts: 0 };
    fsq.appendFileSync('__MIKU_ROOT__/bot/retry_queue.jsonl', JSON.stringify(item) + '\n');
    emit('nudge', 'queued', `她攒了一句（自建 IM）：${String(text).slice(0, 40)}`);
  } catch {}
}

async function sendText(text) {
  if (process.env.SANDBOX === '1') { log(`[沙箱] 不发送：${String(text).slice(0, 40)}`); return { ok: true }; }
  if (channelNow() === 'selfim') {
    try {
      await sendSelfim(text);
      log(`发送 -> 自建 IM: ${text}`);
      return { ok: true };
    } catch (e) {
      log('投自建 IM 失败，进补发队列：' + e.message);
      enqueueSelfim(text);
      throw e;
    }
  }
  if (channelNow() === 'web') {
    try {
      await fetch('http://127.0.0.1:7798/push', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text }), signal: AbortSignal.timeout(5000),
      });
      log(`发送 -> 网页: ${text}`);
      return { ok: true };
    } catch (e) { log('投网页失败，退回 QQ：' + e.message); }
  }
  const tg = await target();
  log(`发送 -> ${tg.id}: ${text}`);
  if (tg.type === 'group') return onebot('send_group_msg', { group_id: Number(tg.id), message: [{ type: 'text', data: { text } }] });
  return sendWithRetry('send_private_msg', { user_id: Number(tg.id), message: [{ type: 'text', data: { text } }] });
}
async function sendWithRetry(action, params, tries = 3) {
  let lastErr = '';
  for (let i = 1; i <= tries; i++) {
    try { return await onebot(action, params); }
    catch (e) {
      lastErr = e.message || String(e);
      log(`发送失败（第 ${i}/${tries} 次）: ${lastErr}`);
      if (i < tries) await sleep(1200 * i);
    }
  }
  // 没送到就攒着，等用户登 QQ 时补发（跟 service 走同一个队列）
  try {
    const fsq = await import('node:fs');
    const item = { ts: Date.now(), channel: 'qq', action, params, attempts: 0 };
    fsq.appendFileSync('__MIKU_ROOT__/bot/retry_queue.jsonl', JSON.stringify(item) + '\n');
    const lines = fsq.readFileSync('__MIKU_ROOT__/bot/retry_queue.jsonl', 'utf8').split('\n').filter(Boolean);
    if (lines.length > 40) fsq.writeFileSync('__MIKU_ROOT__/bot/retry_queue.jsonl', lines.slice(-40).join('\n') + '\n');
    const txt = (params && params.message && params.message[0] && params.message[0].data && params.message[0].data.text) || '';
    emit('nudge', 'queued', `她攒了一句（共 ${Math.min(lines.length, 40)} 条）：${String(txt).slice(0, 40)}`);
  } catch {}
  emit('nudge', 'error', '消息没送到：' + lastErr);
  throw new Error('发送最终失败: ' + lastErr);
}

async function deepseek(messages) {
  const { apiKey, baseUrl, model, temperature } = cfg.deepseek;
  const r = await fetch(`${baseUrl.replace(/\/$/, '')}/chat/completions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
    body: JSON.stringify({ model: model || 'deepseek-chat', messages, temperature: temperature ?? 1.3, max_tokens: 220 }),
    signal: AbortSignal.timeout(30000),
  });
  const t = await r.text();
  if (!r.ok) throw new Error(`DeepSeek ${r.status}: ${t.slice(0, 200)}`);
  return (JSON.parse(t).choices?.[0]?.message?.content || '').trim();
}

// ---------- 冲动模型 ----------
const imp = cfg.impulse || {};
const IDLE_FULL = imp.idleFullMinutes ?? 180;   // 沉默多久算"很想说话"
const THRESHOLD = imp.threshold ?? 58;

function lastActivity(state) {
  let t = 0;
  for (const e of state.history || []) if (e.at > t) t = e.at;
  return t || state.lastSentAt || 0;
}
function lastDir(state) {
  const h = state.history || [];
  return h.length ? h[h.length - 1].dir : '';
}
function parseEnergy(mood) {
  if (/精力：高/.test(mood)) return 1;
  if (/精力：低/.test(mood)) return -1;
  return 0;
}

// 仅 `bot.mjs score` 诊断用；她开口与他否，不依赖这个分数。
function scoreImpulse(state) {
  const now = Date.now();
  const idleMin = lastActivity(state) ? (now - lastActivity(state)) / 60000 : 9999;
  const dir = lastDir(state);
  const ideas = listIdeas(20).length;
  const mood = readMood();
  const energy = parseEnergy(mood);
  const hour = new Date().getHours();
  const todayCount = state.today === localDate() ? (state.todayCount || 0) : 0;

  const parts = [];
  let s = 0;
  const add = (v, why) => { if (v) { s += v; parts.push(`${why} ${v > 0 ? '+' : ''}${v}`); } };

  const idleScore = Math.min(45, Math.round((idleMin / IDLE_FULL) * 45));
  add(idleScore, `沉默${Math.round(idleMin)}分`);
  if (dir === 'in') add(22, '上次是他收尾'); else add(-6, '上次是我收尾');
  add(Math.min(25, ideas * 12), `攒了${ideas}条话`);
  add(energy * 12, energy > 0 ? '精神好' : '没精神');
  add(-Math.min(40, todayCount * 7), `今天已发${todayCount}条`);
  // 她上次选择没回他 → 心里会挂着这件事，更容易想补一句
  if (state.silence && state.silence.at > lastActivity(state)) {
    const mins = Math.round((Date.now() - state.silence.at) / 60000);
    if (mins < 180) add(20, `上次没回他（${mins}分前）`);
  }
  if (hour >= 1 && hour < 8) add(-45, '凌晨他不定睡了');
  else if (hour >= 23) add(-12, '夜深了');

  return { score: Math.max(0, Math.min(100, s)), detail: parts.join('，'), idleMin, ideas, energy, todayCount };
}

function windowCfg() {
  // 时间窗口单独一个文件：config.json 会被别的进程整文件重写，窗口不能跟着丢
  try {
    const w = JSON.parse(fs.readFileSync(path.join(ROOT, 'schedule.json'), 'utf8'));
    if (w && w.activeStart && w.activeEnd) return { activeStart: w.activeStart, activeEnd: w.activeEnd };
  } catch {}
  return { activeStart: cfg.schedule?.activeStart || '22:00', activeEnd: cfg.schedule?.activeEnd || '02:00' };
}

function inActiveWindow(d = new Date()) {
  const sc = windowCfg();
  const cur = d.getHours() * 60 + d.getMinutes();
  const [sh, sm] = String(sc.activeStart || '08:00').split(':').map(Number);
  const [eh, em] = String(sc.activeEnd || '02:00').split(':').map(Number);
  const s = sh * 60 + sm, e = eh * 60 + em;
  return s <= e ? cur >= s && cur <= e : cur >= s || cur <= e;
}

function agentTask(mode) {
  const idea = listIdeas(3);
  return [
    '你在 __MIKU_HOME__ 里生活，只能在这个目录里活动。不要读写、不要修改 __MIKU_HOME__ 之外的任何路径（/root、/opt、/app、/data 都是禁区）。读 SELF.md、memory.md、mood.md，翻一眼 journal/。',
    '现在没有人跟你说话。你可以看看自己想说什么。',
    '写一条要发给风的消息。1~3 段，每段不超过 40 字，段间用 ||| 分隔。',
    '不要说"我刚在想"，不要解释你为什么发这条。',
    '最后单独一行：SEND: <内容>',
  ].join('\n');
}

function clientPresenceLine() {
  try {
    const p = JSON.parse(fs.readFileSync(path.join(ROOT, 'client-presence.json'), 'utf8'));
    const fresh = p.at && Date.now() - p.at < 3 * 60 * 1000;
    return fresh ? '\n【他那边】他手机上的客户端在线，这条他马上能看到。'
                 : '\n【他那边】他手机上的客户端现在不在线——会存着，等他打开才看到。';
  } catch { return ''; }
}

async function fireOnce(mode = 'idle') {
  const state = loadState();
  const tk = localDate();
  if (state.today !== tk) { state.today = tk; state.todayCount = 0; }
  // 不再有硬上限：说多少由她自己看情况定（她要求的）
  const cap = cfg.schedule?.dailyMax ?? 12;
  const sentToday = Number(state.todayCount) || 0;

  const nowHM = new Date().toLocaleTimeString('zh-CN', { hour12: false }).slice(0, 5);
  const recent = (state.history || []).slice(-8);
  const h = recent.map((x) => {
    const t = new Date(x.at || Date.now()).toLocaleTimeString('zh-CN', { hour12: false }).slice(0, 5);
    return `[${t}] ${x.dir === 'out' ? '我' : '他'}: ${x.text}`;
  }).join('\n');
  // 他最后一条消息距现在多久
  const lastIn = [...recent].reverse().find((x) => x.dir === 'in');
  const sinceIn = lastIn ? Math.round((Date.now() - (lastIn.at || 0)) / 60000) : null;
  const gapLine = sinceIn == null ? '现在还没聊过。'
    : sinceIn <= 3 ? `他 ${sinceIn} 分钟前还在说话（可能正在等你）。`
    : `他最后一次说话是 ${sinceIn} 分钟前。`;
  let result;
  try {
    result = await spontaneous(h, impulseReason() + `\n现在 ${nowHM}。${gapLine}` + clientPresenceLine());
  } catch (e) {
    log('生成失败:', e.message);
    emit('nudge', 'error', e.message);
    return null;
  }
  if (result && typeof result.think === 'string' && result.think.trim()) {
    emit('nudge', 'inner', result.think.trim().slice(0, 60));
  }
  const applied = applyActions(result);
  const segs = splitArtifacts(pickSay(result));
  if (!segs.length) {
    log('她这会儿不想说话');
    emit('nudge', 'skip', '她这会儿不想说话' + (applied.length ? `（${applied.join('、')}）` : ''));
    return null;
  }

  if (result && result.stash === true) {
    for (const s2 of segs) addIdea(s2);
    emit('nudge', 'stash', `她自己决定先不发：${segs.join(' / ').slice(0, 60)}`);
    log(`她忍住没发：${segs.join(' / ')}`);
    return null;
  }

  for (let i = 0; i < segs.length; i++) {
    await sleep(700 + segs[i].length * 55 + Math.random() * 800);
    await sendText(segs[i]);
    if (i < segs.length - 1) await sleep(400 + Math.random() * 900);
  }
  const via = channelNow();
  const ARC = (process.env.LIFE_DIR || '__MIKU_HOME__') + '/chat-archive.jsonl';
  const newRows = segs.map((sg) => ({ id: Math.random().toString(16).slice(2, 6), dir: 'out', text: sg, at: Date.now(), via }));
  try { for (const r of newRows) fs.appendFileSync(ARC, JSON.stringify(r) + '\n'); } catch {}
  state.history = [...(state.history || []), ...newRows].slice(-300);
  state.todayCount = (state.todayCount || 0) + 1;
  state.sentTimes = [...(state.sentTimes || []).filter((t) => Date.now() - t < 24 * 3600e3), Date.now()];
  state.lastSentAt = Date.now();
  saveState(state);
  emit('nudge', 'out_msg', segs.join(' ｜ '));
  log(`主动发出（今日第 ${state.todayCount} 条）: ${segs.join(' / ')}`);
  return segs.join(' / ');
}

// 只列事实：不在任何地方加总成一个分数
function factsForHer(st) {
  const idleMin = st.lastOut?.at ? Math.round((Date.now() - st.lastOut.at) / 60000) : null;
  const ideas = listIdeas(20).length;
  const sentToday = Number(st.todayCount) || 0;
  const parts = [];
  if (idleMin != null) parts.push(`上次说话 ${idleMin} 分钟前`);
  if (ideas) parts.push(`攒着 ${ideas} 条没发的话`);
  parts.push(`今天已发 ${sentToday} 条`);
  const sent24 = Array.isArray(st.sentTimes) ? st.sentTimes.filter((t) => Date.now() - t < 24 * 3600e3).length : 0;
  if (sent24) parts.push(`最近 24 小时发了 ${sent24} 条`);
  const cap = cfg.schedule?.dailyMax ?? 0;
  if (cap > 0 && sentToday >= cap) parts.push(`已经超过平时的 ${cap} 条了，你自己看要不要收着点`);
  return '事实：' + parts.join(' · ') + '（这些只是参考，开不开口你定）';
}

function impulseReason() {
  const st = loadState();
  const r = scoreImpulse(st);
  const ideas = listIdeas(3).length;
  return `${r.idleMin > 60 ? `你们已经 ${Math.round(r.idleMin)} 分钟没说话了。` : ''}${ideas ? `你脑子里还压着 ${ideas} 条没发出去的话。` : ''}${new Date().getHours() >= 23 ? '夜很深了。' : ''}`;
}

function splitArtifacts(segs) {
  return segs
    .flatMap((x) => String(x).split(/\s+\/\s+|\|\|\||\uFF5C\uFF5C/))
    .map((x) => x.trim())
    .filter(Boolean)
    .slice(0, 3);
}

async function tickOnce() {
  reloadCfg();
  const st0 = loadState();
  if (st0.quietUntil && Date.now() < st0.quietUntil) {
    emit('nudge', 'skip', '系统跳过：你说过要睡了，暂时不打扰');
    return;
  }
  if (cfg.schedule?.enabled === false) return;
  if (!inActiveWindow()) { emit('nudge', 'skip', '系统跳过：不在活跃时段（不是你选的）'); return; }
  const state = loadState();
  // 她自己给自己上的安静：这期间不问她（她自己能提前取消）
  const qm = Number(state.quietUntilMine) || 0;
  if (qm && Date.now() < qm) {
    const left = Math.round((qm - Date.now()) / 60000);
    emit('nudge', 'skip', `她自己答应安静，还差 ${left} 分钟（她可以随时取消）`);
    return;
  }
  // 「他刚说完 3 分钟内不插嘴」这条已按她的要求删除：
  // 正常人也会插嘴，接不接由她自己判断。
  // 不再有数值闸门：到点就把情况摆给她，她自己决定开不开口。
  // 剩下的"挡"只有：他说过要睡了 / 不在活跃时段。
  emit('nudge', 'check', factsForHer(state));
  emit('nudge', 'decide', '到她自己排的档期了，问她想不想开口');
  await fireOnce('idle');
}

function beatMs() {
  // 每轮重读：面板改了心跳间隔，下一跳就生效
  try {
    const fresh = JSON.parse(fs.readFileSync(path.join(ROOT, 'config.json'), 'utf8')).impulse || {};
    return Math.max(60, (fresh.heartMinutes ?? imp.heartMinutes ?? 5) * 60 * 1000);
  } catch { return Math.max(60, (imp.heartMinutes ?? 5) * 60 * 1000); }
}

async function daemon() {
  log(`心跳模式启动：默认每 ${beatMs() / 60000} 分钟醒一次；她自己填了档期就按她的来`);
  for (;;) {
    let wait = beatMs();
    let byHer = false;
    try {
      const st = loadState();
      if (st.speakInAt && st.speakInAt > Date.now()) {
        wait = Math.max(60 * 1000, st.speakInAt - Date.now());
        byHer = true;
      } else if (st.speakInAt) {
        st.speakInAt = 0; saveState(st);
      }
    } catch {}
    if (byHer) log(`按她排的档期醒（${Math.round(wait / 60000)} 分钟后）`);
    await sleep(wait);
    try {
      await tickOnce();
      // 用掉这次档期
      const st2 = loadState();
      if (st2.speakInAt && st2.speakInAt <= Date.now()) { st2.speakInAt = 0; saveState(st2); }
    } catch (e) { log('本轮失败:', e.message); }
  }
}

// ---------- CLI ----------
const [cmd, ...rest] = process.argv.slice(2);
try {
  if (cmd === 'doctor') {
    const me = await loginInfo();
    log(`NapCat 正常：${me.nickname}(${me.user_id})`);
    try { await deepseek([{ role: 'user', content: '只回复两个字：可用' }]); log('DeepSeek：OK'); } catch (e) { log('DeepSeek：' + e.message); }
  } else if (cmd === 'send') {
    const t = rest.join(' ').trim(); if (!t) throw new Error('用法: send "文字"');
    await sendText(t);
  } else if (cmd === 'once') { await fireOnce('manual'); }
  else if (cmd === 'check') { await tickOnce(); }
  else if (cmd === 'score') { const r = scoreImpulse(loadState()); log(`冲动 ${r.score}：${r.detail}`); }
  else if (cmd === 'request') {
    // 用法: node bot.mjs request "标题" "为什么" "文件A" "文件B" ...（多个文件会被拼起来）
    // 走调试通道：先立项，再问她，同意才允许改
    const [title, why, ...fileParts] = rest;
    if (!title || !why) throw new Error('用法: request "标题" "为什么" ["文件A" "文件B" ...]');
    const files = fileParts.filter(Boolean).join('、') || '(未指定)';
    const { reviewRequest } = await import('../src/core/mind.mjs');
    const fsn = await import('node:fs');
    const id = 'r' + Date.now().toString(36).slice(-4);
    const d = await reviewRequest({ title, why, files });

    const rec = {
      id, at: new Date().toISOString(), title, why,
      files: files || '', decision: d.allow ? (d.trust ? 'allowed-trust' : 'allowed-detail') : 'denied', trust: !!d.trust, say: d.say,
    };
    fsn.appendFileSync('__MIKU_HOME__/change-requests.jsonl', JSON.stringify(rec) + '\n');

    const kind = d.allow ? (d.trust ? '同意（信任授权）' : '同意（要求先看细节）') : '不同意';
    console.log(`[${id}] 她的决定: ${kind}`);
    console.log(`她说: ${d.say}`);
    if (!d.allow) {
      console.log('→ 没同意，什么都不改。要改就换个说法再申请。');
      process.exit(2);
    }
    console.log('→ 已批准。现在可以动手了；改完记得记账。');
    process.exit(0);
  }
  else if (cmd === 'fix') {
    // 用法: node bot.mjs fix "错的原话片段" "正确的话"
    // 只改"他说的话"，不改她的；改完记一笔更正，她下一轮会看到
    const [wrong, right] = rest;
    if (!wrong || !right) throw new Error('用法: fix "错的原话片段" "正确的话"');
    const fsn = await import('node:fs');
    const st = JSON.parse(fsn.readFileSync('./state.json', 'utf8'));
    const hit = (st.history || []).filter((e) => e.dir === 'in' && e.text.includes(wrong));
    if (!hit.length) { console.log('没找到那句话'); process.exit(1); }
    for (const e of hit) {
      e.text = e.text.replace(wrong, right);
      e.corrected = true;
    }
    fsn.writeFileSync('./state.json', JSON.stringify(st, null, 2));
    console.log(`改了 ${hit.length} 条。现在他说的是：${hit[0].text}`);
  }
  else if (cmd === 'wish') {
    // 维护者用：看愿望 / 标记结果
    const fs2 = await import('node:fs');
    const fp = '__MIKU_HOME__/wishes.md';
    const [action, id, ...note] = rest;
    const text = note.join(' ');
    let t = fs2.readFileSync(fp, 'utf8');
    if (!action || action === 'list') {
      console.log(t.split('\n').filter((l) => l.startsWith('| w') || l.startsWith('| 编号')).join('\n'));
      process.exit(0);
    }
    if (!id) throw new Error('用法: wish list | wish ok w1 "做了什么" | wish no w1 "为什么做不到"');
    const stamp = new Date().toISOString().slice(0, 10);
    if (action === 'ok') {
      t = t.replace(new RegExp(`\\| ${id} \\| 待评估 \\| (.*?) \\|`), `| ${id} | 已实现 ${stamp} | $1 |`);
      t = t.replace(new RegExp(`(\\| ${id} \\| [^|]*\\|[^|]*\\|)([^|]*)\\|`), `$1$2；${text}|`);
    } else if (action === 'no') {
      t = t.replace(new RegExp(`\\| ${id} \\| 待评估 \\| (.*?) \\|`), `| ${id} | 没做成 ${stamp} | $1（${text}）|`);
    } else throw new Error('只支持 ok / no');
    fs2.writeFileSync(fp, t);
    console.log(`已标记 ${id}: ${action} ${text}`);
  }
  else if (cmd === 'asr-token') {
    // 用法: node bot.mjs asr-token "<通过控制台拿到的临时 AccessToken>"
    const tok = (rest[0] || '').trim();
    if (tok.length < 16) {
      console.log('用法: node bot.mjs asr-token <AccessToken>');
    } else {
      const cfgPath = path.join(ROOT, 'config.json');
      const c2 = JSON.parse(fs.readFileSync(cfgPath, 'utf8'));
      c2.asr = c2.asr || {};
      c2.asr.token = tok;
      c2.asr.tokenAt = Date.now();
      c2.asr.enabled = true;
      fs.writeFileSync(cfgPath, JSON.stringify(c2, null, 2));
      console.log('已更新 ASR Token（' + tok.slice(0, 6) + '…），重启自动回复后生效');
    }
  }
  else if (cmd === 'wish-audit') {
    const dry = rest.includes('--dry');
    const { auditAll } = await import('./wish-audit.mjs');
    const out = await auditAll({ dry });
    if (!out.length) console.log('没有待评估的愿望');
    for (const o of out) console.log(`[${o.id}] ${o.verdict}${o.why ? '｜' + o.why : ''}${o.result ? '｜' + o.result : ''}${o.error ? '｜' + o.error : ''}`);
  }
  else if (cmd === 'gen') {
    // 面板「让 AI 写一条」用：只生成不发送
    const { spontaneous } = await import('../src/core/mind.mjs');
    const r = await spontaneous('manual');
    const { pickSay } = await import('../src/core/mind.mjs');
    const segs = pickSay(r);
    console.log('生成结果: ' + (segs.join(' ') || '(她这次不想说)'));
  }
  else if (cmd === 'daemon') { await daemon(); }
  else console.log('用法: node bot.mjs <doctor|send|gen|request|wish|wish-audit|asr-token|fix|once|check|score|daemon>');
} catch (e) { log('错误:', e.message); process.exit(1); }
