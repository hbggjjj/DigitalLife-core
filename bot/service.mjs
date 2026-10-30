#!/usr/bin/env node
// 自动回复：快通道秒回 + 分段连发 + 打字延迟 + 偶尔已读不回
import http from 'node:http';
import fs from 'node:fs';
import dns from 'node:dns';
try { dns.setDefaultResultOrder('ipv4first'); } catch {}
import crypto from 'node:crypto';
import { notify as phoneNotify } from '../src/utils/phone-notify.mjs';
import { instanceName } from '../src/utils/name.mjs';
import { assertNotOwnerUid } from '../src/utils/impersonation-guard.mjs';
import { assertLifeDir } from '../src/utils/lifedir.mjs';
import path from 'node:path';
import { syncFramework, verifySync } from '../src/utils/sync-framework.mjs';
import { reply as mindReply, followup as mindFollowup, applyActions, pickSay, auditSchema, probe as mindProbe } from '../src/core/mind.mjs';
import { emit } from '../src/utils/events.mjs';
import { sync as syncClock, status as clockStatus } from '../src/utils/clock.mjs';
import { logErr, brief as errBrief } from '../src/utils/errlog.mjs';
import { snapshot as guardSnapshot, verify as guardVerify } from '../src/utils/guard.mjs';
import { rebuild as rebuildSoul, get as getSoul } from '../src/core/soul.mjs';

const ROOT = '__MIKU_ROOT__/bot';
let cfg = JSON.parse(fs.readFileSync(path.join(ROOT, 'config.json'), 'utf8'));
const STATE_FILE = path.join(ROOT, 'state.json');
const LOG_FILE = path.join(ROOT, 'reply.log');
const PORT = 7789;
const DRY = process.env.DRY_RUN === '1';

const rc = cfg.reply || {};
const WHITELIST = (rc.whitelist || []).map(String);
const SKIP_CHANCE = rc.skipChance ?? 0.06;
const MAX_SEGMENTS = rc.maxSegments ?? 3;

const p2 = (n) => String(n).padStart(2, '0');
const ts = (d = new Date()) => `${d.getFullYear()}-${p2(d.getMonth() + 1)}-${p2(d.getDate())} ${p2(d.getHours())}:${p2(d.getMinutes())}:${p2(d.getSeconds())}`;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
function log(...a) { const l = `[${ts()}] ${a.join(' ')}`; console.log(l); try { fs.appendFileSync(LOG_FILE, l + '\n'); } catch {} }

function loadState() { try { return JSON.parse(fs.readFileSync(STATE_FILE, 'utf8')); } catch { return { history: [] }; } }
function saveState(s) {
  // 原子替换，避免写一半被读成坏 JSON（多进程仍是"最后写者赢"，见 AGENTS.md §2.10）
  const tmp = STATE_FILE + '.tmp-' + process.pid;
  try { fs.writeFileSync(tmp, JSON.stringify(s, null, 2)); fs.renameSync(tmp, STATE_FILE); }
  catch { try { fs.writeFileSync(STATE_FILE, JSON.stringify(s, null, 2)); } catch {} }
}
function shortId() { return Math.random().toString(16).slice(2, 6); }

function pushHistory(e) {
  try { assertLifeDir(); } catch (err) { log('拒绝写历史：' + err.message); return; }
  // 永久归档：只追加，不随 300 条上限滚掉
  try {
    const arc = process.env.LIFE_DIR || '__MIKU_HOME__';
    fs.appendFileSync(arc + '/chat-archive.jsonl', JSON.stringify(e) + '\n');
  } catch {}
  const s = loadState();
  const entry = e.id ? e : { id: shortId(), ...e };
  s.history = [...(s.history || []), entry].slice(-300);
  saveState(s);
}

function reloadCfg() { try { cfg = JSON.parse(fs.readFileSync(path.join(ROOT, 'config.json'), 'utf8')); } catch {} }

async function onebot(action, params) {
  const r = await fetch(`${cfg.napcat.baseUrl.replace(/\/$/, '')}/${action}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${cfg.napcat.token}` },
    body: JSON.stringify(params), signal: AbortSignal.timeout(25000),
  });
  const t = await r.text();
  let d; try { d = JSON.parse(t); } catch { d = { raw: t }; }
  if (d && d.status === 'failed') throw new Error(JSON.stringify(d).slice(0, 200));
  return d;
}

const LOST = '__MIKU_ROOT__/bot/undelivered.log';
const DEBUG_CHAT = '__MIKU_ROOT__/bot/debug-chat.jsonl';
function pushDebug(dir, text, agent = false) {
  try {
    fs.appendFileSync(DEBUG_CHAT, JSON.stringify({ dir, text, at: Date.now(), agent: !!agent }) + '\n');
    const lines = fs.readFileSync(DEBUG_CHAT, 'utf8').split('\n').filter(Boolean);
    if (lines.length > 200) fs.writeFileSync(DEBUG_CHAT, lines.slice(-200).join('\n') + '\n');
  } catch {}
}
function recentDebug(n = 6) {
  try {
    return fs.readFileSync(DEBUG_CHAT, 'utf8').split('\n').filter(Boolean)
      .map((l) => JSON.parse(l)).slice(-n);
  } catch { return []; }
}
const RETRY_Q = '__MIKU_ROOT__/bot/retry_queue.jsonl';
let lastOnline = null;

function uidOfTarget() {
  const t = cfg.target || {};
  return String(t.uid || t.user_id || (cfg.reply?.whitelist || [])[0] || '');
}

let loginBadStreak = 0;          // 连续"看起来在线但发不出去"的次数
let lastLoginState = 'unknown';
let lastInboundAt = 0;       // 最后一次真实收到他消息的时间
let generating = false;      // 正在生成回复：这段时间别插话

async function onebotRaw(action, body = {}, timeout = 6000) {
  const r = await fetch(`${cfg.napcat.baseUrl.replace(/\/$/, '')}/${action}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${cfg.napcat.token}` },
    body: JSON.stringify(body), signal: AbortSignal.timeout(timeout),
  });
  const d = await r.json();
  if (!d || d.status === 'failed' || (d.retcode && d.retcode !== 0)) throw new Error(d?.message || d?.wording || 'napcat 返回失败');
  return d.data;
}

/**
 * 真·在线检测。
 * get_status 的 online 是本地状态——票据失效时会假在线（今晚就是）。
 * 所以先看 online，再真打一次服务器（get_friend_list），两者都过才算通。
 */
// 最轻的自检：只问一句"你还活着吗"，返回 HTTP 200 就算通，不碰模型
async function pingNapcat() {
  try {
    const r = await fetch(`${cfg.napcat.baseUrl.replace(/\/$/, '')}/get_status`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${cfg.napcat.token}` },
      body: '{}', signal: AbortSignal.timeout(5000),
    });
    return r.status === 200;
  } catch { return false; }
}

async function onlineNow() {
  try {
    const st = await onebotRaw('get_status', {}, 5000);
    if (!(st && st.online && st.good)) { lastLoginState = 'offline'; return false; }
    await onebotRaw('get_friend_list', { no_cache: true }, 8000);   // 这一步才真的碰到服务器
    lastLoginState = 'ok';
    return true;
  } catch (e) {
    const wasDead = lastLoginState === 'dead';
    lastLoginState = 'dead';
    log('在线检测失败（可能假在线）：' + e.message);
    // 只在"第一次坏"时记错误，别每次心跳刷一遍
    if (!wasDead) logErr('login', e, { action: 'health', note: '首次失败，后续同一状态不再重复记' });
    return false;
  }
}

async function selfimOnline() {
  try {
    const base = ((cfg.selfim && cfg.selfim.baseUrl) || '').replace(/\/$/, '');
    if (!base) return false;
    const r = await fetch(base + '/api/v1/health', { signal: AbortSignal.timeout(6000) });
    const d = await r.json();
    return !!(d && d.ok && d.online);
  } catch { return false; }
}

async function flushRetryQueue(reason = '') {
  let items = [];
  try {
    items = fs.readFileSync(RETRY_Q, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
  } catch { return; }
  if (!items.length) return;

  // 哪条通道通了就补哪条；两条都断就集体挂起，不扣次数
  let qqOk = null, selfimOk = null;
  const qqUp = async () => (qqOk === null ? (qqOk = await onlineNow()) : qqOk);
  const imUp = async () => (selfimOk === null ? (selfimOk = await selfimOnline()) : selfimOk);
  if (!(await qqUp()) && !(await imUp())) {
    log(`两条通道都不通（${reason || '例行'}），补发先挂起，不扣次数`);
    return;
  }

  const keep = [];
  let sent = 0;
  for (const it of items) {
    if (Date.now() - it.ts > 24 * 3600 * 1000) {
      try { fs.appendFileSync(LOST, `[${new Date().toISOString()}] 超过 24 小时，放弃：${JSON.stringify(it.params)}\n`); } catch {}
      continue;
    }
    try {
      const ch = it.channel || (it.action ? 'qq' : 'selfim');
      if (ch === 'selfim') {
        if (!(await imUp())) { keep.push(it); continue; }     // 这条通道还没通，留着
        const { createAdapter } = await import('../src/adapters/index.mjs');
        const ad = createAdapter('selfim', cfg.selfim || {}, {});
        await ad._send(it.kind || 'text', it.payload || {});
        // 通知只由客户端负责（他曾要求脱离 DSHA）；除非显式打开 serverSide
        if ((cfg.notify || {}).serverSide === true) {
          await phoneNotify(instanceName(), (it.payload && it.payload.text) || '（之前攒着的话补发了）');
        }
      } else {
        if (!(await qqUp())) { keep.push(it); continue; }
        await onebot(it.action, it.params);
      }
      sent++;
      await sleep(800);
    } catch (e) {
      it.attempts = (it.attempts || 0) + 1;
      if (it.attempts <= 5) keep.push(it);
      else {
        // 死也要留全尸：原文写进 undelivered.log，事后能捡回来
        try { fs.appendFileSync(LOST, `[${new Date().toISOString()}] 重试 ${it.attempts} 次失败：${JSON.stringify(it.params)} | ${e.message}\n`); } catch {}
        try { emit('reply', 'lost', '有条话补发多次失败，原文存在 undelivered.log：' + String(it.params?.message?.[0]?.data?.text || '').slice(0, 40)); } catch {}
        log('放弃一条，原文已写进 undelivered.log');
      }
    }
  }
  try { fs.writeFileSync(RETRY_Q, keep.map((x) => JSON.stringify(x)).join('\n') + (keep.length ? '\n' : '')); } catch {}
  if (sent) {
    log(`补发成功 ${sent} 条${reason ? '（' + reason + '）' : ''}`);
    emit('reply', 'resend', `补发了 ${sent} 条之前没送到的消息${reason ? '（' + reason + '）' : ''}`);
  }
}

async function sendWithRetry(action, params, tries = 3) {
  let lastErr = '';
  for (let i = 1; i <= tries; i++) {
    try {
      const r = await onebot(action, params);
      loginBadStreak = 0;                       // 发得出去就说明通
      try {
        const sH = loadState();
        sH.loginBadStreak = 0;
        sH.lastSendOkAt = Date.now();      // "最近一次真的发出去"的证据
        saveState(sH);
      } catch {}
      return r;
    } catch (e) {
      lastErr = e.message || String(e);
      log(`发送失败（第 ${i}/${tries} 次）: ${lastErr}`);
      if (i < tries) await sleep(1200 * i);
    }
  }
  try {
    fs.appendFileSync(LOST, `[${ts()}] ${JSON.stringify(params).slice(0, 300)} | ${lastErr}\n`);
  } catch {}
  // 存进补发队列：等会话恢复后再发一次，不丢
  try {
    const item = { ts: Date.now(), action, params, attempts: 0 };
    item.channel = 'qq';
    fs.appendFileSync(RETRY_Q, JSON.stringify(item) + '\n');
    const lines = fs.readFileSync(RETRY_Q, 'utf8').split('\n').filter(Boolean);
    if (lines.length > 40) fs.writeFileSync(RETRY_Q, lines.slice(-40).join('\n') + '\n');  // 只留最近 40 条
    const n = Math.min(lines.length, 40);
    const txt = (params && params.message && params.message[0] && params.message[0].data && params.message[0].data.text) || '';
    emit('reply', 'queued', `她说的话先攒着（共 ${n} 条）：${String(txt).slice(0, 40)}`);
    log(`话攒着了（共 ${n} 条）：${String(txt).slice(0, 40)}`);
  } catch (e) { log('写补发队列失败:', e.message); }
  // 连续发送失败 = 会话说"在线"但其实死了，插旗让守护进程重启 NapCat
  try {
    fs.writeFileSync('__MIKU_ROOT__/.session-dead', new Date().toISOString());
    log('已标记会话死亡，等待守护进程重启 NapCat');
  } catch {}
  loginBadStreak++;
  try { const sH = loadState(); sH.loginBadStreak = loginBadStreak; sH.lastSendFailAt = Date.now(); saveState(sH); } catch {}
  emit('reply', 'error', `消息没送到（已重试 3 次，连续 ${loginBadStreak} 次）：` + lastErr);
  if (loginBadStreak >= 2) {
    emit('reply', 'health', `连续 ${loginBadStreak} 次发不出去，判定会话假死，正在重启 NapCat`);
    try { fs.writeFileSync('__MIKU_ROOT__/.session-dead', new Date().toISOString()); } catch {}
  }
  logErr('send', new Error(lastErr || '发送失败'), {
    action,
    uid: params && params.user_id,
    text: String((params && params.message && params.message[0] && params.message[0].data && params.message[0].data.text) || '').slice(0, 60),
    tries,
  });
  throw new Error('发送最终失败: ' + lastErr);
}

async function deepseek(messages, opt = {}) {
  const { apiKey, baseUrl, model } = cfg.deepseek;
  const r = await fetch(`${baseUrl.replace(/\/$/, '')}/chat/completions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
    body: JSON.stringify({
      model: model || 'deepseek-chat', messages,
      temperature: opt.temperature ?? 1.25, max_tokens: opt.maxTokens ?? 220,
    }),
    signal: AbortSignal.timeout(30000),
  });
  const t = await r.text();
  if (!r.ok) throw new Error(`DeepSeek ${r.status}: ${t.slice(0, 200)}`);
  return (JSON.parse(t).choices?.[0]?.message?.content || '').trim();
}

const SEG_MAP = {
  text: (d) => d?.text || '',
  image: () => '[图片]',
  mface: () => '[表情包]',
  face: () => '[QQ表情]',
  record: () => '[语音]',
  video: () => '[视频]',
  file: () => '[文件]',
  json: () => '[卡片]',
  xml: () => '[卡片]',
  at: (d) => (d?.qq ? '@' + (d.name || d.qq) : ''),
  reply: () => '',
  forward: () => '[合并转发]',
  node: () => '[合并转发]',
};
const SLEEP_RE = /(睡了|再见|晚安|睡觉|困了|先睡|去睡|休息了|闭眼)/;
const MEDIA_RE = /\[(图片|表情包|QQ表情|语音|视频|文件|卡片|合并转发)\]/;

// 把图暂时落在 /tmp，让她在同一次思考里直接看；生成完就删
function stashImages(msg) {
  if (!Array.isArray(msg)) return [];
  const out = [];
  for (const seg of msg.filter((x) => x && x.type === 'image')) {
    const d = seg.data || {};
    const src = d.url || d.file || '';
    if (!src) continue;
    const tmp = `/tmp/her-look-${Date.now()}-${Math.random().toString(36).slice(2, 6)}.jpg`;
    out.push({ src, seg, tmp });
  }
  return out;
}

// 拿到一张图的原始字节：本地路径 → URL（带 UA/Referer 重试）→ NapCat 的 get_image
async function resolveImage(seg) {
  const d = seg.data || {};
  const file = d.file || '';
  const url = d.url || '';

  // 1) 已经是本地路径
  for (const p of [file, file.replace('file://', '')]) {
    if (p && p.startsWith('/')) {
      try {
        const b = fs.readFileSync(p);
        if (b.length) return { ok: true, buf: b, from: 'local' };
      } catch {}
    }
  }

  // 2) URL：QQ 的图床不带 UA/Referer 会 400
  if (/^https?:/.test(url)) {
    for (const headers of [
      { 'User-Agent': 'Mozilla/5.0 (Linux; Android 14) AppleWebKit/537.36', Accept: 'image/*,*/*' },
      { 'User-Agent': 'Mozilla/5.0', Referer: 'https://im.qq.com/' },
    ]) {
      try {
        const r = await fetch(url, { headers, signal: AbortSignal.timeout(20000) });
        if (r.ok) {
          const b = Buffer.from(await r.arrayBuffer());
          if (b.length) return { ok: true, buf: b, from: 'url' };
        }
      } catch {}
    }
  }

  // 3) 让 NapCat 自己把图吐出来（它本地有缓存）
  if (file) {
    try {
      const r = await onebot('get_image', { file });
      const b64 = r?.data?.base64 || r?.base64 || '';
      if (b64) return { ok: true, buf: Buffer.from(b64, 'base64'), from: 'get_image' };
      const p = r?.data?.file || r?.file || '';
      if (p) {
        const b = fs.readFileSync(p.replace('file://', ''));
        if (b.length) return { ok: true, buf: b, from: 'get_image-path' };
      }
    } catch {}
  }

  const host = (() => { try { return new URL(url).host; } catch { return '无 url'; } })();
  return { ok: false, note: `拿不到这张图（${host}）` };
}

async function fetchTo(seg, dest) {
  const got = await resolveImage(seg);
  if (!got.ok) return got;
  const tmpRaw = dest + '.raw';
  try { fs.writeFileSync(tmpRaw, got.buf); } catch { return { ok: false, note: '写临时文件失败' }; }
  const { normalize } = await import('../src/services/imgprep.mjs');
  const r = normalize(tmpRaw, dest);
  try { fs.unlinkSync(tmpRaw); } catch {}
  if (!r.ok) return { ok: false, note: r.note };
  return { ok: true, from: got.from };
}

// 把收到的图片交给视觉通道，换成一段文字；原图不落盘进记忆
async function lookAtImages(msg) {
  if (!Array.isArray(msg)) return null;
  const imgs = msg.filter((x) => x && x.type === 'image');
  if (!imgs.length) return null;
  let V;
  try { V = await import('../src/services/vision.mjs'); } catch { return null; }
  const out = [];
  for (const seg of imgs) {
    const d = seg.data || {};
    const src = d.url || d.file || '';
    if (!src) { out.push('[图片]（没拿到图）'); continue; }
    if (!V.available()) { out.push('[图片]（她看不了：视觉通道没配置）'); continue; }
    let buf = null;
    try {
      if (/^https?:/.test(src)) {
        const r = await fetch(src, { signal: AbortSignal.timeout(20000) });
        buf = Buffer.from(await r.arrayBuffer());
      } else if (src.startsWith('file://') || src.startsWith('/')) {
        buf = fs.readFileSync(src.replace('file://', ''));
      }
    } catch {}
    if (!buf) { out.push('[图片]（下载失败）'); continue; }
    const tmp = `/tmp/her-img-${Date.now()}-${Math.random().toString(36).slice(2, 6)}.jpg`;
    try {
      fs.writeFileSync(tmp, buf);
      const r = await V.describe(tmp, '');
      out.push(r.ok ? `[图片：${r.text}]` : `[图片]（她没看清：${r.error}）`);
      emit('reply', 'look', r.ok ? '她看了一张图：' + r.text.slice(0, 60) : '看图失败：' + r.error);
    } finally {
      try { fs.unlinkSync(tmp); } catch {}   // 原图不留下
    }
  }
  return out.join('\n');
}

function extractText(msg) {
  if (typeof msg === 'string') return msg;
  if (Array.isArray(msg)) {
    return msg.map((s) => {
      const f = SEG_MAP[s.type];
      if (f) return f(s.data || {});
      return '[不支持的消息]';
    }).join('').trim();
  }
  return '';
}
function hasMedia(text) { return MEDIA_RE.test(text); }

// ---- 限流 ----
const buckets = new Map();
const lastSeen = new Map();   // key: uid|text → 上次收到的时间

/**
 * 只拦"平台把同一条重复投递两次"，不拦人。
 * 白名单里的人不设每小时上限、不设冷却——回不回是她的事（reply:false）。
 */
function allow(uid, text = '') {
  const now = Date.now();
  const key = uid + '|' + String(text).slice(0, 80);
  const prev = lastSeen.get(key);
  if (prev && now - prev < 2000) return false;   // 2 秒内同一条 = 重复投递
  lastSeen.set(key, now);
  if (lastSeen.size > 300) {                     // 简单清理，别涨内存
    for (const [k, t] of lastSeen) if (now - t > 60000) lastSeen.delete(k);
  }
  return true;
}

// ---- 拟人延迟 ----
function typingDelay(text) {
  const base = 700 + text.length * 55;
  const jitter = 0.75 + Math.random() * 0.6;
  return Math.min(4500, Math.max(900, Math.round(base * jitter)));
}

// ---- 分段 ----
function splitSegments(reply) {
  let parts = String(reply).split(/\|\|\||\n+/).map((s) => s.trim()).filter(Boolean);
  const out = [];
  for (const p of parts) {
    if (p.length <= 42) { out.push(p); continue; }
    // 长句按标点再切
    const chunks = p.split(/(?<=[。！？…~～!?])/).map((s) => s.trim()).filter(Boolean);
    let cur = '';
    for (const c of chunks) {
      if ((cur + c).length > 42 && cur) { out.push(cur); cur = c; }
      else cur += c;
    }
    if (cur) out.push(cur);
  }
  return out.slice(0, MAX_SEGMENTS);
}

let lastMeme = '';
let resultMeme = '';

// ---- 他半天不回，她会不会再问一句 ----
async function maybeFollowUp() {
  const cfg2 = JSON.parse(fs.readFileSync(path.join(ROOT, 'config.json'), 'utf8'));
  const fu = (cfg2.reply || {}).followUp || {};
  if (fu.enabled === false) return;

  const st = loadState();
  if (st.quietUntil && Date.now() < st.quietUntil) {
    // 安静期唯一例外：刚道过晚安那十几分钟，她还能再补一两句
    const inGrace = st.sleepGraceUntil && Date.now() < st.sleepGraceUntil && (st.sleepNudges || 0) < 2;
    if (!inGrace) return;
  }
  const lo = st.lastOut;
  if (!lo || !lo.uid) return;

  // 他回过了 → 这一轮结束
  const lastIn = (st.history || []).filter((e) => e.dir === 'in').slice(-1)[0];
  if (lastIn && lastIn.at > lo.at) return;

  // 她在这一次沉默里最多主动几次，间隔逐步拉长
  // 主动程度（阈值）决定她多频繁地想接话：档位越黏，判断点越密、次数越多
  // 追问不再按阈值表：只看她自己填的 followIn
  const inGrace = st.sleepGraceUntil && Date.now() < st.sleepGraceUntil && (st.sleepNudges || 0) < 2;
  const followIn = inGrace ? 3 : Number(lo.followIn || 0);
  if (!followIn) return;                 // 她没填 = 不催，真的放在那儿
  const checks = lo.checks || 0;
  if (checks >= 1) return;               // 一次沉默只问一次
  const mins = (Date.now() - lo.at) / 60000;
  if (mins < followIn) return;

  lo.checks = checks + 1;        // 先记上，避免同一档反复触发
  saveState(st);

  let result;
  try { result = await mindFollowup(Math.round(mins), lo.text); }
  catch (e) {
    log('追问生成失败:', e.message);
    logErr('followup', e, { uid: String(uid || '') });
    emit('reply', 'warn', '她想追问，但生成失败，这一档被吃掉了：' + String(e.message).slice(0, 40));
    return;
  }

  const segs = pickSay(result);
  if (!segs.length) {
    log(`第 ${checks + 1} 次想说话，她决定先不说`);
    emit('reply', 'skip', `他 ${Math.round(mins)} 分钟没回，她想过了，决定不说`);
    return;
  }

  await sleep(600 + Math.random() * 1200);
  await sendSegments(lo.uid, segs);
  for (const sg of segs) pushHistory({ dir: 'out', text: sg, at: Date.now(), via: uid === 'selfim' ? 'selfim' : 'qq' });
  lo.at = Date.now();            // 她说话了，下一次判断从现在算
  lo.text = segs.join(' ');
  if (st.quietUntil && st.sleepGraceUntil && Date.now() < st.sleepGraceUntil) {
    st.sleepNudges = (st.sleepNudges || 0) + 1;
    log(`睡前后劲儿：第 ${st.sleepNudges} 次`);
  }
  saveState(st);
  // 发出去就是发出去：记成 out_msg，面板才会像正常发言一样显示"发出"
  for (const g2 of segs) emit('reply', 'out_msg', g2, { uid: lo.uid, via: lo.uid === 'selfim' ? 'selfim' : 'qq', followup: true });
  log(`（他 ${Math.round(mins)} 分钟没回，她主动接了一句）`);
  log(`她又主动说了（隔 ${Math.round(mins)} 分钟）: ${segs.join(' / ')}`);
}

// ---- 生成回复：统一走心智模型（无工具、无 shell）----
// 模型有时会模仿历史里的 " / " 分隔符，把它写进同一段里 —— 这里拆开
function splitArtifacts(segs) {
  return segs
    .flatMap((x) => String(x).split(/\|\|\|/))
    .map((x) => x.trim())
    .filter(Boolean)
    .slice(0, 3);
}

function clientPresenceLine() {
  try {
    const p = JSON.parse(fs.readFileSync('__MIKU_ROOT__/bot/client-presence.json', 'utf8'));
    const fresh = p.at && Date.now() - p.at < 3 * 60 * 1000;
    return fresh
      ? '\n【他那边】他手机上的客户端在线，这条发出去他马上能看到。'
      : '\n【他那边】他手机上的客户端现在不在线——这条会存着，等他打开客户端才看到。你自己掂量要不要现在说。';
  } catch {
    return '\n【他那边】还不知道他的客户端在不在（没有上报过）。';
  }
}

function buildSelfStats() {
  try {
    const h = (loadState().history || []).filter((e) => e.dir === 'out');
    if (!h.length) return '';
    const recent = h.slice(-10).length;
    const st = loadState();
    const skipped = st.silenceCount || 0;
    return skipped === 0
      ? `最近 ${recent} 条里你全回了，一条都没落过`
      : `最近 ${recent} 条里你回过 ${recent - Math.min(skipped, recent)} 条，漏了 ${skipped} 条`;
  } catch { return ''; }
}


async function generateReply(historyLines, userText, imagePath = null, channel = 'qq', flags = {}) {
  generating = true;
  try { return await generateReplyInner(historyLines, userText, imagePath, channel, flags); }
  finally { generating = false; }
}

async function generateReplyInner(historyLines, userText, imagePath = null, channel = 'qq', flags = {}) {
  if (imagePath) setTimeout(() => { try { fs.unlinkSync(imagePath); } catch {} }, 15000);
  const t0 = Date.now();
  const sleepHint = SLEEP_RE.test(userText)
    ? '\n（他这句话里出现了"睡"字——但这不代表他现在就要去睡：他可能是在说昨晚睡的、在开玩笑、或者在解释。\n你自己判断：他是不是真的要去睡了？\n如果是 → sleep 填 true（我会安静下来，不打扰他）；如果你想再聊两句 → sleep 填 false，正常回。\n别因为一个字就把他晾六小时。）'
    : '';
  const channelNote = channel === 'debug'
      ? '（这条来自调试框：他不会收到你的回复，只会显示在调试面板里。）'
      : (/\[调试\]/.test(historyLines)
        ? '（这条是他本人在 QQ 里直接发给你的，不是调试框。上面那些 [调试] 的开头，是维护者在调试面板里说的，不算他本人。以这条为准。）'
        : '');
  const fromTag = channel === 'debug'
      ? '调试框'
      : (channel === 'web' ? '他·网页' : '他·QQ')
        + (flags.agent ? '·代发' : '')
        + (flags.resend ? '·补发' : '');
  const result = await mindReply(historyLines, userText, buildSelfStats() + sleepHint + clientPresenceLine(), { noBrowse: SLEEP_RE.test(userText), imagePath, channelNote, fromTag });
  const segs = pickSay(result);
  const applied = applyActions(result);
  // 她可以在任何一次回复里改自己的"下次醒来"——不用等下一次生活循环
  try {
    const aim = Number(result && result.awakeIn);
    if (Number.isFinite(aim) && aim >= 1) {
      const min = Math.max(1, Math.min(240, Math.round(aim)));
      const stA = loadState();
      stA.nextWakeAt = Date.now() + min * 60000;
      stA.nextWakeMinutes = min;
      stA.nextWakeBy = 'herself';
      saveState(stA);
      log(`她在回复里把下次醒来改到 ${new Date(stA.nextWakeAt).toTimeString().slice(0, 5)}（${min} 分钟后）`);
      emit('life', 'reschedule', `她把下次醒来改到 ${min} 分钟后`);
    }
  } catch {}
  // 她这一轮要翻归档：存起来，下一轮把原文调出来
  try {
    if (result && result.recall) {
      const stR = loadState();
      stR.pendingRecall = result.recall;
      saveState(stR);
      log('她要求翻永久归档：' + JSON.stringify(result.recall));
    }
  } catch {}
  // 她这一轮要求核对：存起来，下一轮把原话调出来
  try {
    if (result && Number(result.check) > 0) {
      const stC = loadState();
      stC.pendingCheck = Math.min(30, Math.round(Number(result.check)));
      saveState(stC);
      log(`她要求核对最近 ${stC.pendingCheck} 句自己的原话`);
    }
  } catch {}
  if (result && typeof result.think === 'string' && result.think.trim()) {
    emit('brain', 'inner', result.think.trim().slice(0, 60));
  }
  emit('brain', 'quick', `想好了（${Date.now() - t0}ms）${applied.length ? '｜' + applied.join('、') : ''}`);
  lastMeme = (result && typeof result.meme === 'string' && result.meme.trim()) ? result.meme.trim() : '';
  return { segs: splitArtifacts(segs), result };
}

function pickMeme(cat) {
  try {
    const dir = `__MIKU_HOME__/shelf/memes/${cat}`;
    const files = fs.readdirSync(dir).filter((f) => /\.(png|jpg|jpeg|gif)$/i.test(f));
    if (!files.length) return null;
    return `${dir}/${files[Math.floor(Math.random() * files.length)]}`;
  } catch { return null; }
}

async function sendMeme(uid, cat) {
  const file = pickMeme(cat);
  if (!file) return false;
  if (DRY) { log(`[DRY] 表情包 -> ${cat}/${path.basename(file)}`); return true; }
  try {
    if (uid === 'selfim') {
      const { createAdapter } = await import('../src/adapters/index.mjs');
      const ad = createAdapter('selfim', cfg.selfim || {}, {});
      await ad.send('meme', { to: (cfg.selfim && cfg.selfim.to) || 'user-1', path: file });
      log(`发了表情包: ${cat}`);
      emit('reply', 'meme', `表情包：${cat}`);
      return true;
    }
    await sendWithRetry('send_private_msg', { user_id: Number(uid), message: [{ type: 'image', data: { file: 'file://' + file } }] }, 2);
    log(`发了表情包: ${cat}`);
    emit('reply', 'meme', `表情包：${cat}`);
    return true;
  } catch (e) { log('表情包发送失败:', e.message); return false; }
}

// 主动开口投到哪个通道（她在面板上选，默认 QQ）
function proactiveTarget() {
  try {
    const st = loadState();
    return st.channel === 'web' ? 'web' : String((cfg.target || {}).id || '');
  } catch { return String((cfg.target || {}).id || ''); }
}

async function sendSegments(uid, segments) {
  if (process.env.SANDBOX === '1') {           // 沙箱里绝不真发出去
    for (const sg of segments) log(`[沙箱] 不发送：${sg.slice(0, 40)}`);
    return;
  }
  for (let i = 0; i < segments.length; i++) {
    const seg = segments[i];
    await sleep(typingDelay(seg));
    if (DRY) { log(`[DRY] 第${i + 1}段 -> ${seg}`); continue; }
    const via = uid === 'selfim' ? 'selfim' : 'qq';
    if (uid === 'selfim') {                    // 自建 IM：走协议里的 /api/v1/send
      assertNotOwnerUid(uid, 'selfim 出站');   // 硬规则：不许以他的身份发
      try {
        const { createAdapter } = await import('../src/adapters/index.mjs');
        const ad = createAdapter('selfim', cfg.selfim || {}, {});
        // 用基类的 send：自带 3 次重试 + 失败进补发队列
        await ad.send('text', { uid: 'user-1', to: (cfg.selfim && cfg.selfim.to) || 'user-1', text: seg });
        log(`发到自建 IM 第${i + 1}/${segments.length}段: ${seg}`);
        // 他手机上的客户端此刻在不在线：不在就攒着，等她/他知道
        try {
          const hr = await fetch('http://127.0.0.1:7791/api/v1/health', { signal: AbortSignal.timeout(3000) });
          const hj = await hr.json();
          if (hj && hj.clientOnline === false) {
            emit('reply', 'queued', '他手机上的客户端现在不在线——这条先攒着，等他打开会一次收到');
          }
        } catch {}
        // 服务端通知默认关闭：他要脱离 DSHA，通知应由他自己的客户端负责
        try {
          const notifyCfg = (cfg.notify || {});
          if (notifyCfg.serverSide === true && i === 0) {
            const lastIn = Number(loadState().lastInboundAt) || 0;
            if ((Date.now() - lastIn) / 60000 > 2) phoneNotify(instanceName(), seg);
          }
        } catch {}
        emit('reply', 'out_msg', seg, { uid, via, seg: i + 1, total: segments.length });
      } catch (e) {
        log('自建 IM 发送失败：' + e.message);
        emit('reply', 'error', '自建 IM 没发出去，先攒着：' + e.message.slice(0, 60));
      }
      if (i < segments.length - 1) await sleep(400 + Math.random() * 600);
      continue;
    }
    await sendWithRetry('send_private_msg', { user_id: Number(uid), message: [{ type: 'text', data: { text: seg } }] });
    log(`发出第${i + 1}/${segments.length}段: ${seg}`);
    emit('reply', 'out_msg', seg, { uid, via: 'qq', seg: i + 1, total: segments.length });
    if (i < segments.length - 1) await sleep(500 + Math.random() * 1200);
  }
}

async function handleMessage(ev) {
  reloadCfg();
  const isSelfim = !!ev._selfim;       // 从自建 IM 进来的
  const isDebug = !!ev._debug;
  // 强制来源声明：没写 origin 的，一律按"维护者代发"处理，宁可标错也不冒充他
  let origin = ev.origin;
  if (!origin) {
    log('来源未声明（origin 缺失），这条不处理');
    try { emit('reply', 'error', '有消息没带来源声明（origin），已拒收——请通道补上 origin'); } catch {}
    return;                                  // 拒发：不猜、不冒充
  }
  if (origin !== 'user' && origin !== 'agent' && origin !== 'system') {
    log('来源非法：' + origin + '，拒收');
    try { emit('reply', 'error', '来源声明非法（' + origin + '），已拒收'); } catch {}
    return;
  }
  const isResend = !!ev._resend;      // 被拦下、事后补发给她的那条
  const uid = isSelfim ? 'selfim' : String(ev.user_id);
  if (!isSelfim && !WHITELIST.includes(uid)) { emit('reply', 'skip', `非白名单 ${uid}，不理`, { uid }); return; }
  let text = extractText(ev.message);
  let lookPath = null;
  let imageTried = false;
  try {
    const stash = stashImages(ev.message);
    for (const it of stash) {
      imageTried = true;
      const got = await fetchTo(it.seg, it.tmp);
      if (got.ok) { lookPath = it.tmp; break; }
      log('这张图没看成就跳过了：' + got.note);
      logErr('image', new Error(got.note), { uid: String(ev.user_id) });
      text = text.replace(/\[图片\]/g, `[图片]（这张图我打不开：${got.note}）`);
    }
    if (lookPath) text = text.replace(/\[图片\]/g, '').trim();
  } catch (e) { log('取图出错：' + e.message); }

  try {
    const seen = (lookPath || imageTried) ? null : await lookAtImages(ev.message);
    if (seen) text = text.replace(/\[图片\]/g, '').trim();
    if (seen) text = (seen + (text ? '\n' + text : '')).trim();
  } catch (e) { log('看图出错：' + e.message); logErr('image', e, { uid: String(ev.user_id) }); }
  if (!text && !lookPath) return;      // 纯图（已经能看）不再被吞
  if (!text) text = '[图片]';          // 给她一个占位，她知道这是图
  log(`收到 ${uid}: ${text}`);
  emit('reply', 'in_msg', text, { uid });
  if (isResend) text = '（补发：这条当时被系统拦下了，你现在才看到）' + text;
  if (!isDebug) {
    lastInboundAt = Date.now();
    try { const sI = loadState(); sI.lastInboundAt = lastInboundAt; saveState(sI); } catch {}
  }
  const agentSent = origin === 'agent';   // 只认 origin，不再靠记得加 _agent
  // 代发不进关系历史：她读的最近对话里不该有"别人拿他的名义说的话"
  if (isDebug || agentSent) pushDebug('in', text, agentSent);
  else pushHistory({ dir: 'in', text, at: Date.now(), via: isSelfim ? 'selfim' : 'qq', ...(isResend ? { resend: true } : {}) });
  const stIn = loadState();
  if (stIn.lastOut) { stIn.lastOut.followed = true; }
  if (stIn.quietUntil && Date.now() < stIn.quietUntil) {
    stIn.quietUntil = 0;
    log('他又说话了，解除安静状态');
  }
  saveState(stIn);

  if (!allow(uid, text)) { emit('reply', 'skip', '同一条消息重复投递，跳过', { uid }); return; }


  const state = loadState();
  const hist = (state.history || []).slice(-12);
  let lines = hist.map((h) => {
    // 每条都标清楚：谁说的、从哪条道来的
    const who = h.dir === 'out' ? '我' : '你';
    let tag = h.dir === 'out'
      ? (h.via === 'web' ? '我·网页' : '我·QQ')
      : (h.via === 'web' ? '他·网页' : '他·QQ');
    if (h.agent) tag += '·维护者代发（不是他本人）';
    if (h.resend) tag += '·补发（当时被系统拦下）';
    if (h.corrected) tag += '·原话有错别字';
    if (h.sys) tag = '系统';
    return `[${tag}] ${who}: ${h.text}`;
  }).join('\n');
  // 上一轮她要求翻归档：这一轮把原文调出来
  try {
    const pr = state.pendingRecall;
    if (pr) {
      const rows = fs.readFileSync((process.env.LIFE_DIR || '__MIKU_HOME__') + '/chat-archive.jsonl', 'utf8')
        .split('\n').filter(Boolean).map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
      let pick = rows;
      if (pr.since) {
        const md = pr.since.slice(5);           // "10-25"
        pick = pick.filter((r) => new Date(r.at).toISOString().slice(5, 10) >= md);
      }
      if (pr.q) pick = pick.filter((r) => String(r.text).includes(pr.q));
      pick = pick.slice(-(pr.n || 10));
      if (pick.length) {
        const p2 = (n) => String(n).padStart(2, '0');
        lines += '\n\n（你自己要翻的永久归档，原文，没摘要：\n' +
          pick.map((r) => {
            const d = new Date(r.at);
            const who = r.dir === 'out' ? '我' : '他';
            const via = r.via === 'web' ? '网页' : (r.via === 'qq' ? 'QQ' : '');
            const flags = [via, r.agent ? '代发' : '', r.denied ? '你否认过' : ''].filter(Boolean).join('·');
            return `- ${p2(d.getMonth() + 1)}-${p2(d.getDate())} ${p2(d.getHours())}:${p2(d.getMinutes())} ${who}${flags ? '（' + flags + '）' : ''}：${r.text}`;
          }).join('\n') + '）';
      } else {
        lines += '\n\n（你翻的这段归档里没找到记录。）';
      }
      delete state.pendingRecall;
      saveState(state);
    }
  } catch (e) { log('翻归档出错：' + e.message); }
  // 上一轮她要求核对：这一轮把原话调出来给她看
  try {
    const pend = Number(state.pendingCheck) || 0;
    if (pend > 0) {
      const mine = (state.history || []).filter((h) => h.dir === 'out').slice(-pend);
      if (mine.length) {
        lines += '\n\n（你自己要求核对的、你最近说过的话，原样，没改过：\n' +
          mine.map((h) => `[${h.id}] ${new Date(h.at).toTimeString().slice(0, 5)} ${h.via === 'web' ? '网页' : 'QQ'}${h.denied ? '（你否认过）' : ''}：${h.text}`).join('\n') +
          '\n对不上填 verify 的 no，对得上填 ok。）';
      }
      state.pendingCheck = 0;
      saveState(state);
    }
  } catch {}
  const dbg = recentDebug(6);
  if (dbg.length) {
    lines += agentSent
      ? '\n\n（重要：刚刚那句「' + text.slice(0, 30) + '」不是他本人发的，是维护者用他的名义代发的。你可以照常回答，但要知道这句话不是他的。如果他问起，也可以直接问他是不是本人在说。）\n'
      : '';
    lines += '\n\n（下面是调试对话，不是真聊天。你在这里说的每一句都不会发给他，只会显示在调试框里——所以可以随便说，也可以直接说"这是测试"。）\n' +
      dbg.map((h) => `[调试] ${h.dir === 'out' ? '我' : '你'}: ${h.text}`).join('\n');
  }

  let segs = [];
  let result0 = null;
  let genError = '';
  try {
    const gen = await generateReply(lines, text, lookPath, isDebug ? 'debug' : (isSelfim ? 'selfim' : 'qq'), { agent: agentSent, resend: isResend });
    segs = gen.segs || [];
    result0 = gen.result || null;
    resultMeme = lastMeme;
  } catch (e) {
    genError = e.message;
    log('生成失败:', e.message);
    emit('brain', 'error', e.message);
  }
  const decidedNotToReply = result0 && result0.reply === false;
  if (!segs.length || decidedNotToReply) {
    // 生成失败 ≠ 她选择不回。故障不写进她的状态，不然下一轮她会看到假话
    if (genError) {
      log('生成失败（不记成沉默）:', genError);
      emit('reply', 'skip', '生成失败：' + genError, { uid });
      return;
    }
    const st = loadState();
    st.silence = { at: Date.now(), uid };   // 记下来：她这次没开口
    st.silenceCount = Math.min(5, (st.silenceCount || 0) + 1);
    st.lastSilenceAt = Date.now();
    saveState(st);
    if (decidedNotToReply) {
      if (segs.length) {
        const { addIdea } = await import('../src/core/soul.mjs');
        for (const sg of segs) addIdea(sg);
        log('她决定不回，但写好的话存进了 ideas');
        emit('reply', 'silence', '她决定这条不回，但话留下来了：' + segs.join(' ｜ '), { uid });
        return;
      }
      log('她自己决定这条不回');
      emit('reply', 'silence', '她决定这条不回（已读不回，是她选的）', { uid });
    } else {
      log('她这次选择不说');
      emit('reply', 'silence', '她这次选择不说', { uid });
    }
    return;
  }
  // 冷不丁冒出一个她从没见过的字（多半是模型抖动）——记一笔，不拦
  try {
    const { oddChars } = await import('../src/utils/knownchars.mjs');
    const odd = oddChars(segs.join(''));
    if (odd.length) {
      // 白名单永远不够全，误报太多：只写日志，不再上面板
      log('她这句里有几个不在白名单的字（不一定错）：' + odd.join('、'));
    }
  } catch {}

  // 认识没几天却说"上周/以前"——记一笔，不拦
  try {
    const dayNo = Math.floor((Date.now() - new Date('2026-10-25T00:00:00+08:00').getTime()) / 86400000) + 1;
    if (dayNo <= 7) {
      const m = segs.join('').match(/(上周|上个月|去年|以前你说|你以前|我们一直|那阵子|上次你说的)/);
      if (m) {
        log(`⚠ 她说了「${m[1]}」，但你们只认识 ${dayNo} 天`);
        emit('reply', 'warn', `她很自然地说「${m[1]}」，但你们才认识 ${dayNo} 天——这多半是编的`);
      }
    }
  } catch {}

  // 她拿自己的目标当共同记忆时，留个痕（不拦，只记）
  try {
    const askId = result0?.goal?.ask;
    if (askId) {
      const gt = fs.readFileSync('__MIKU_HOME__/goals.md', 'utf8');
      const line = gt.split('\n').find((l) => l.includes(`[${askId}]`)) || '';
      const key = (line.match(/\]\s*([^｜]{2,30})/) || [])[1] || '';
      const kw = key.replace(/[搞明白想为什么的\s]/g, '').slice(0, 4);
      if (kw && !segs.join('').includes(kw)) {
        log(`⚠ 她提到目标 ${askId} 但没交代背景（关键词「${kw}」没出现）`);
        emit('reply', 'warn', `她提了自己在查的事，但没说是什么——他可能看不懂（目标 ${askId}）`);
      }
    }
  } catch {}

  // 她决定破例说一句（过了活跃时段也认）——一晚最多一次
  try {
    const reach = result0 && typeof result0.reach === 'string' ? result0.reach.trim() : '';
    if (reach) {
      const stR = loadState();
      const today = new Date().toISOString().slice(0, 10);
      const used = stR.reachDay === today ? (stR.reachCount || 0) : 0;
      const REACH_MAX = Number((cfg.schedule && cfg.schedule.reachPerNight) || 3);
      if (used >= REACH_MAX) {
        log(`她今晚已经破例 ${used} 次（上限 ${REACH_MAX}），这句不发了`);
        emit('reply', 'warn', `她想再破例，但今晚已经 ${used} 次（上限 ${REACH_MAX}）`);
      } else {
        await sendSegments(proactiveTarget(), [reach]);
        pushHistory({ dir: 'out', text: reach, at: Date.now(), via: proactiveTarget() === 'web' ? 'web' : 'qq' });
        stR.reachDay = today;
        stR.reachCount = used + 1;
        saveState(stR);
        emit('reply', 'out_msg', reach, { reach: true, via: proactiveTarget() === 'web' ? 'web' : 'qq' });
        emit('reply', 'reach', '她自己决定破例说了一句（不在活跃时段）：' + reach);
        try {
          const fs2 = await import('node:fs');
          fs2.appendFileSync('__MIKU_HOME__/others-edits.md',
            `| ${new Date().toLocaleString('zh-CN', { hour12: false }).slice(0, 16)} | 她破例说了一句：${reach.slice(0, 20)} | 她自己的决定 | 过了活跃时段，她自己选的 |\n`);
        } catch {}
        log('破例发出：' + reach);
        return;
      }
    }
  } catch {}

  // 她要是决定憋着，一个字都不发（在发送之前判断）
  if (result0 && result0.stash === true) {
    const { addIdea } = await import('../src/core/soul.mjs');
    for (const sg of segs) addIdea(sg);
    if (isDebug) {
      for (const sg of segs) pushDebug('out', sg + '（忍住没发）');
      emit('reply', 'debug_reply', segs.join(' ｜ '), { debug: true });
      return;
    }
    // 憋着的话只进想法，不进 history——否则她下一轮会以为自己真说过
    emit('reply', 'stash', '她想说，但决定先不发：' + segs.join(' ｜ '));
    log('她自己决定忍住：' + segs.join(' / '));
    return;
  }

  if (DRY) {
    emit('reply', 'skip', `[干跑测试] 没有真的发出：${segs.join(' ｜ ')}`, { uid, dry: true });
    return;
  }

  if (isDebug || agentSent) {        // 调试 / 代发：只留在调试框，绝不进关系历史
    for (const sg of segs) pushDebug('out', sg);
    emit('reply', 'debug_reply', segs.join(' ｜ '), { debug: true });
    log('（调试）她要说的：' + segs.join(' / ') + ' —— 没发到 QQ');
    return;
  }

  await sendSegments(uid, segs);

  const rc2 = cfg.reply || {};
  if (rc2.memeEnabled !== false && resultMeme) {   // 她自己给了分类就发，不再掷骰子
    await sleep(400 + Math.random() * 700);
    await sendMeme(uid, resultMeme);
  }
  for (const sg of segs) pushHistory({ dir: 'out', text: sg, at: Date.now(), via: uid === 'selfim' ? 'selfim' : 'qq' });
  const st2 = loadState();
  if (st2.lastSilenceAt && Date.now() - st2.lastSilenceAt > 2 * 3600 * 1000) st2.silenceCount = 0;
  saveState(st2);
  const speakIn = Number(result0 && result0.speakIn) || 0;
  if (speakIn) { st2.speakInAt = Date.now() + speakIn * 60000; log(`她自己排了档期：${speakIn} 分钟后再看要不要找他`); }
  const followIn = Number(result0 && result0.followIn) || 0;
  st2.lastOut = { at: Date.now(), text: segs.join(' '), uid, checks: 0, followIn };
  if (result0 && (result0.sleep === true || Number(result0.sleep) > 0)) {   // 她自己判断他要睡了；也可以自己给分钟数
    const byMins = Number(result0 && result0.sleep) > 0 && result0.sleep !== true;
    const hours = byMins ? (Number(result0.sleep) / 60) : Number((cfg.reply || {}).sleepQuietHours ?? 6);
    const grace = Number((cfg.reply || {}).sleepGraceMinutes ?? 12);
    st2.quietUntil = Date.now() + hours * 3600 * 1000;
    st2.sleepAt = Date.now();
    st2.sleepNudges = 0;
    st2.sleepGraceUntil = Date.now() + grace * 60000;
    log(byMins ? `她自己定了安静 ${result0.sleep} 分钟` : `他要去睡了：${grace} 分钟内她还能补一两句，之后安静 ${hours} 小时`);
    emit('reply', 'quiet', `晚安。${grace} 分钟内她可能还会补一两句，之后安静 ${hours} 小时`);
  }
  saveState(st2);
}

// ---- 连发合并：他说完之前，不一条一条惊动她 ----
// 动态合并窗口：短句快，长句按字数给阅读时间，连发继续等，整轮有上限
const FIXED_MS = Number((cfg.reply || {}).mergeWindowMs || 4000);   // 连发合并窗口：固定 4 秒
const buffers = new Map();   // key(uid|channel) -> { parts, images, timer, ev }
function scheduleInbound(ev, uidKey, channel) {
  const key = `${channel}:${uidKey}`;
  let b = buffers.get(key);
  if (!b) { b = { parts: [], images: [], ev, timer: null, n: 0 }; buffers.set(key, b); }
  // 把这条拆成文字/图片塞进缓冲
  const segs = ev.message || [];
  for (const sg of segs) {
    if (sg.type === 'text') { const t = String(sg.data?.text || '').trim(); if (t) b.parts.push(t); }
    else if (sg.type === 'image') b.images.push(sg);
  }
  b.n++;
  // 固定窗口（他要求：动态容易出问题，改回固定 4 秒）
  const wait = FIXED_MS;
  b.lastWait = wait;
  if (b.timer) clearTimeout(b.timer);
  b.timer = setTimeout(() => {
    buffers.delete(key);
    const merged = { ...b.ev };
    const head = b.n > 1 ? `（他连着发了 ${b.n} 条，按顺序：）\n` : '';
    const text = head + b.parts.join('\n');
    merged.message = [
      ...(text ? [{ type: 'text', data: { text } }] : []),
      ...b.images,
    ];
    merged._merged = b.n;
    if (b.n > 1) log(`合并 ${b.n} 条（${b.parts.join('').length} 字，等了 ${b.lastWait}ms）→ 一次输入`);
    enqueue(() => handleMessage(merged));
  }, wait);   // 固定窗口
}

const queue = [];
let busy = false;
function enqueue(t) { queue.push(t); pump(); }
async function pump() {
  if (busy || !queue.length) return;
  busy = true;
  try { await queue.shift()(); } catch (e) { log('任务失败:', e.message); }
  busy = false;
  if (queue.length) pump();
}

const server = http.createServer((req, res) => {
  let body = '';
  req.on('data', (c) => { body += c; if (body.length > 2e6) req.destroy(); });
  req.on('end', () => {
    // ---- 自建 IM 入口：按 docs/CHANNEL-PROTOCOL.md 校验签名 ----
    // 注意：必须在 writeHead 之前处理，否则会 ERR_HTTP_HEADERS_SENT
    if (req.url === '/inbound' && req.method === 'POST') {
      let d = {};
      try { d = JSON.parse(body); } catch { return; }
      const h = req.headers || {};
      const sig = String(h['x-im-signature'] || '').replace(/^hmac-sha256=/, '').toLowerCase();
      const ts = Number(h['x-im-timestamp'] || d.ts || 0);
      const secret = String((cfg.selfim && cfg.selfim.secret) || '');
      const claimed = String(d.origin || 'user');
      // 自建 IM 默认不认"他本人"：除非请求里带了他手机上输入的一次性设备密钥
      const pin = String(h['x-im-device-pin'] || '');
      const pinHash = String((cfg.selfim && cfg.selfim.devicePinHash) || '');
      const pinOk = !!(pinHash && pin && crypto.createHash('sha256').update(pin).digest('hex') === pinHash);
      const origin = pinOk ? claimed : 'agent';
      if (!pinOk && claimed === 'user') log('自建 IM：签名有效但没有设备 PIN，按「代发」处理（不是错误）');
      let ok = false;
      try {
        if (secret && sig) {
          const stringToSign = [d.msgId, d.senderId, claimed, ts].join('\n');   // 必须用他声称的 origin 验签
          const expect = crypto.createHmac('sha256', secret).update(stringToSign).digest('hex');
          ok = expect.length === sig.length && crypto.timingSafeEqual(Buffer.from(expect), Buffer.from(sig));
        }
      } catch {}
      if (!ok) {   // 签名对任何来源都必须有效，否则谁都能往这里塞消息
        const selfCheck = String(h['x-self-check'] || '') === '1';
        if (selfCheck) {
          log('自检：无签名请求被拒（预期，不再报 violation）');
        } else {
          log('自建 IM 拒收：签名不符');
          try { emit('reply', 'violation', '自建 IM 上有一条想冒充他本人的消息，签名不对，已拒收'); } catch {}
        }
        res.writeHead(401, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ ok: false, code: 'SIGNATURE_INVALID', message: '签名校验失败' }));
      }
      if (ts && Math.abs(Date.now() - ts) > 5 * 60 * 1000) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ ok: false, code: 'TIMESTAMP_SKEW', message: '时间差过大' }));
      }
      if (!d.text && !(d.images && d.images.length)) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ ok: false, code: 'EMPTY', message: '没有内容' }));
      }
      scheduleInbound({
        post_type: 'message', message_type: 'private',
        user_id: 'selfim', self_id: 'selfim',
        message: [
          ...(d.text ? [{ type: 'text', data: { text: d.text } }] : []),
          ...((d.images || []).map((im) => ({ type: 'image', data: { file: im.path || im.file || '' } }))),
          ...((!d.text && !(d.images || []).length) ? [{ type: 'text', data: { text: '[空]' } }] : []),
        ],
        origin, _selfim: true,
      }, 'selfim', 'selfim');
      res.writeHead(200, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ ok: true, accepted: 1, rejected: [] }));
    }

    res.writeHead(200, { 'Content-Type': 'application/json' });
    if (req.url === '/flush') {                 // 面板「补发攒的话」调这里
      res.end('{"ok":true}');
      flushRetryQueue('手动').catch(() => {});
      return;
    }
    res.end('{"ok":true}');
    if (!body) return;
    let ev; try { ev = JSON.parse(body); } catch { return; }
    // NapCat 每 30 秒发一次心跳：它停了就说明 QQ 客户端已经冻住（假在线）
    if (ev.post_type === 'meta_event') {
      try { const stB = loadState(); stB.napcatBeatAt = Date.now(); saveState(stB); } catch {}
      return;
    }
    // 只有 NapCat 自己推来的消息才算"真人"。别的来源必须自带 origin。
    // 判据是 NapCat 的连接头（别人的 curl 伪造不了整套头也没必要，但至少挡住本地脚本冒充）。
    const h = req.headers || {};

    // NapCat 的特征：X-Self-ID + X-Signature(sha1=HMAC-SHA1(body, secret))
    const selfId = String(h['x-self-id'] || '');
    const sig = String(h['x-signature'] || '').replace(/^sha1=/, '').toLowerCase();
    let sigOk = false;
    try {
      const secret = String((cfg.napcat && cfg.napcat.token) || '');
      if (secret && sig) {
        const expect = crypto.createHmac('sha1', secret).update(body).digest('hex');
        sigOk = expect.length === sig.length && crypto.timingSafeEqual(Buffer.from(expect), Buffer.from(sig));
      }
    } catch {}
    const fromNapcat = !!selfId && sigOk;
    if (!ev.origin) {
      if (fromNapcat && !ev._web && !ev._agent && !ev._debug) {
        ev.origin = 'user';
      } else {
        log('拒收：来源不是 NapCat，且没有声明 origin（不允许以他的名义发消息）');
        try { emit('reply', 'violation', '有消息想冒充他本人（没有经过 NapCat、也没声明 origin），已拒收'); } catch {}
        return;
      }
    }
    if (ev.post_type === 'message' && ev.message_type === 'private' && String(ev.user_id) !== String(ev.self_id)) {
      scheduleInbound(ev, String(ev.user_id || ''), 'qq');
    }
  });
});

rebuildSoul(true);
// 禁区守卫：每 5 分钟核对关键文件有没有被改
let guardBase = null;
try { guardBase = guardSnapshot(); } catch {}
setInterval(() => {
  try {
    if (!guardBase) return;
    const changed = guardVerify(guardBase);
    if (changed.length) {
      log('⚠ 关键文件被改动：' + changed.join(','));
      emit('brain', 'warn', '禁区守卫：这些文件被改过并已还原——' + changed.join('、'));
    }
    guardBase = guardSnapshot();
  } catch {}
}, 5 * 60 * 1000);

setInterval(() => { maybeFollowUp().catch((e) => log('追问异常:', e.message)); }, 60 * 1000);
// 每 30 秒看一次在线状态：从掉线恢复时，把积压的消息补发出去
setInterval(async () => {
  const on = await onlineNow();
  try {
    fs.writeFileSync('__MIKU_ROOT__/bot/.online', JSON.stringify({ online: on, at: Date.now(), state: lastLoginState, badStreak: loginBadStreak }));
  } catch {}
  // 假在线：NapCat 说 online，但连续两次发不出去 / 检测失败 → 重启 NapCat
  if (!on && loginBadStreak >= 2) {
    try { fs.writeFileSync('__MIKU_ROOT__/.session-dead', new Date().toISOString()); } catch {}
    emit('reply', 'health', `登录通道异常（连续 ${loginBadStreak} 次失败），已插旗让守护进程重启 NapCat`);
  }
  if (lastOnline === false && on) {
    // 刚跟你说了话就别抢她的话筒：等他安静下来再补发
    const quietMs = Date.now() - lastInboundAt;
    if (quietMs < 90 * 1000 || generating) {
      log(`刚收到过消息（${Math.round(quietMs / 1000)} 秒前）或正在生成，这次先不补发`);
      emit('reply', 'health', '检测到重新上线，但他刚在说话，先不插嘴');
    } else {
      log('检测到重新上线，开始补发');
      emit('reply', 'resend', '检测到她重新上线，正在补发积压的消息');
      await flushRetryQueue('重新上线').catch(() => {});
      // 自检只发一个 200 探测，不经过模型、不替她说话
      const ok2 = await pingNapcat();
      emit('reply', 'health', ok2 ? '自检：NapCat 200，通道活着' : '自检：NapCat 无响应');
      if (!ok2) { try { fs.writeFileSync('__MIKU_ROOT__/.session-dead', new Date().toISOString()); } catch {} }
    }
  }
  lastOnline = on;
}, 30 * 1000);
// ---- 通道实时看门狗：看 QQ 服务器的数据包还在不在动 ----
let lastPackets = null;
let stuckTicks = 0;
async function napcatWatch() {
  try {
    const st = await onebot('get_status', {}, 6000);
    const p = Number(st?.stat?.packet_received || 0) + Number(st?.stat?.packet_sent || 0);
    const prev = lastPackets;
    lastPackets = p;
    if (prev != null && p === prev) stuckTicks++;
    else stuckTicks = 0;

    const dead = stuckTicks >= 6;            // 3 分钟（30 秒一次）包计数不动 = 会话死了
    try {
      const sW = loadState();
      sW.napcatPackets = p;
      sW.napcatStuckTicks = stuckTicks;
      sW.napcatDead = dead;
      sW.napcatCheckedAt = Date.now();
      saveState(sW);
    } catch {}
    if (dead && stuckTicks === 6) {
      log('通道看门狗：数据包 3 分钟没动，判定会话已死');
      emit('reply', 'error', '通道看门狗：NapCat 3 分钟没收到数据包，会话可能已经死了');
    }
  } catch {}
}
setInterval(napcatWatch, 30 * 1000);
napcatWatch();

// 授时：每 30 分钟看一次（clock.sync 自己有缓存，不到期不会真的请求）
setInterval(() => { syncClock().catch(() => {}); }, 30 * 60 * 1000);

// 启动时先补一次
setTimeout(() => { flushRetryQueue('启动').catch(() => {}); }, 5000);   // 离线时它会自己挂起

// 累计在线时长：只算真的在跑的时间，中断的不算（他要求：以前中断的不算，以后也一样）
function tickLifetime() {
  try {
    const st = loadState();
    const now = Date.now();
    const last = Number(st.lifetimeLastTick) || 0;
    const gap = now - last;
    // 一分钟一跳；间隔超过 3 分钟 = 中间断过，那段不算
    if (last && gap > 0 && gap <= 3 * 60 * 1000) {
      st.lifetimeAccumMs = (Number(st.lifetimeAccumMs) || 0) + gap;
    }
    st.lifetimeLastTick = now;
    saveState(st);
  } catch {}
}
setInterval(tickLifetime, 60 * 1000);

// 心跳：由她的核心进程自己写。停了就是她真的不在了（网络断不影响这里）
function writeHeartbeat() {
  try {
    const tmp = HEARTBEAT + '.' + process.pid;
    fs.writeFileSync(tmp, String(Date.now()));
    fs.renameSync(tmp, HEARTBEAT);
  } catch {}
}
writeHeartbeat();
setInterval(writeHeartbeat, 30 * 1000);
tickLifetime();

// 记下这次栈是什么时候起来的（面板显示"本次运行"用）
try {
  const st0 = loadState();
  const ageOk = st0.stackStartedAt && (Date.now() - st0.stackStartedAt) < 7 * 24 * 3600e3;
  if (!ageOk) { st0.stackStartedAt = Date.now(); saveState(st0); }
} catch {}

server.listen(PORT, '127.0.0.1', async () => {
  log(`自动回复已启动 :${PORT} 白名单=${WHITELIST.join(',') || '(空)'}`);
  try {
    await syncClock(true);
    log('授时：' + JSON.stringify(clockStatus()));
  } catch (e) { log('授时失败：' + e.message); }
  try {
    const r = syncFramework();
    if (r.changed) log('已把最近改动同步进她的认知文件');
    if (r.skipped) { log('⚠ 同步被跳过：' + r.error); emit('brain', 'warn', '认知文件没同步：' + r.error); }
    const v = verifySync();
    if (!v.ok) { log('⚠ 她的认知文件同步异常：' + JSON.stringify(v.blocks)); emit('brain', 'warn', '认知文件同步异常'); }
    else if (v.warn) { log('⚠ ' + v.warn); emit('brain', 'warn', v.warn); }
  } catch {}
  try {
    const a = auditSchema();
    const bad = [...a.missingInNormalize.map((f) => f + '(被吞)'), ...a.missingInPrompt.map((f) => f + '(没声明)')];
    if (bad.length) {
      log('⚠ 字段自检不通过：' + bad.join('、'));
      emit('brain', 'warn', '字段自检：' + bad.join('、'));
    } else log(`字段自检：通过（${a.total} 个字段，都被处理也都在提示词里）`);
  } catch (e) { log('字段自检失败:', e.message); }
});
