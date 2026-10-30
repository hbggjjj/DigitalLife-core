#!/usr/bin/env node
// 它自己的时间：不做同一套流程，自己挑事情做；顺手维护心情和记忆
import fs from 'node:fs';
import os from 'node:os';
import dns from 'node:dns';
try { dns.setDefaultResultOrder('ipv4first'); } catch {}
import path from 'node:path';
import { memAvailableMB, stamp } from '../services/brain.mjs';
import { reflect, applyActions } from './mind.mjs';
import { headlines, format as fmtWeb, search as webSearch } from '../services/web.mjs';
import { popular as biliPopular, format as fmtBili } from '../services/bili.mjs';
import { emit } from '../utils/events.mjs';
import { logErr } from '../utils/errlog.mjs';
import { sync as syncClock } from '../utils/clock.mjs';
import { syncFramework, verifySync } from '../utils/sync-framework.mjs';
import { rebuild as rebuildSoul } from './soul.mjs';

const ROOT = '__MIKU_ROOT__/bot';
const cfg = JSON.parse(fs.readFileSync(path.join(ROOT, 'config.json'), 'utf8'));
const LIFE_CFG = cfg.life || {};
const DAY_INTERVAL = LIFE_CFG.dayIntervalMinutes ?? LIFE_CFG.intervalMinutes ?? 20;
const NIGHT_INTERVAL = LIFE_CFG.nightIntervalMinutes ?? 60;
const HEARTBEAT = '__MIKU_ROOT__/bot/.heartbeat';
const RUNNING = '__MIKU_ROOT__/bot/.running';   // 存在=上次没关干净（断电/被杀）
const QUIET_MIN = LIFE_CFG.quietMinutes ?? 20;
const STATE_FILE = path.join(ROOT, 'state.json');
function atomicState(obj) {
  const tmp = STATE_FILE + '.tmp-' + process.pid;
  try { fs.writeFileSync(tmp, JSON.stringify(obj, null, 2)); fs.renameSync(tmp, STATE_FILE); }
  catch { try { fs.writeFileSync(STATE_FILE, JSON.stringify(obj, null, 2)); } catch {} }
}
import { assertLifeDir } from '../utils/lifedir.mjs';
try { assertLifeDir(); } catch (e) { console.error(e.message); process.exit(9); }
const LOG = '__MIKU_HOME__/life.log';

function log(...a) { const l = `[${stamp()}] ${a.join(' ')}`; console.log(l); try { fs.appendFileSync(LOG, l + '\n'); } catch {} }
function parseHM(s) { const [h, m] = String(s).split(':').map(Number); return h * 60 + m; }
function inActive(d = new Date()) {
  const sc = cfg.schedule || {};
  const cur = d.getHours() * 60 + d.getMinutes();
  const s = parseHM(sc.activeStart || '08:00'), e = parseHM(sc.activeEnd || '02:00');
  return s <= e ? cur >= s && cur <= e : cur >= s || cur <= e;
}
function lastActivityAt() {
  try { const s = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8')); let t = 0; for (const e of s.history || []) if (e.at > t) t = e.at; return t || 0; } catch { return 0; }
}
function nightTime() { const h = new Date().getHours(); return h >= 22 || h < 2; }
// 频率用的"深夜"：只算 0 点到 8 点。22-24 点他还醒着，她还不能睡。
function deepNight() { return false; }   // 不再有深夜特例，24 小时同一个节奏

function bootId() {
  try { return fs.readFileSync('/proc/sys/kernel/random/boot_id', 'utf8').trim(); } catch { return ''; }
}

function beat() {
  try {
    const tmp = HEARTBEAT + '.' + process.pid;
    fs.writeFileSync(tmp, String(Date.now()));
    fs.renameSync(tmp, HEARTBEAT);          // 原子替换，避免两个进程写串
  } catch {}
}


/** 启动时检查：上次心跳到现在隔了多久 → 是不是容器停过 */
function checkGap() {
  try {
    const raw = fs.readFileSync(HEARTBEAT, 'utf8').trim();
    const last = Number(raw);
    // 心跳必须是 13 位毫秒时间戳；写串了/坏了就当没有，不要报一个假时长
    if (!Number.isFinite(last) || String(Math.round(last)).length !== 13) {
      log(`心跳文件异常（${raw.slice(0, 30)}），跳过断线判定`);
      return null;
    }
    const mins = (Date.now() - last) / 60000;
    if (mins < 0 || mins > 7 * 24 * 60) { log(`心跳时间不合理（${Math.round(mins)} 分钟），跳过`); return null; }
    // 心跳现在由 supervisor 写：它新，就说明整个栈在；那就不是"容器停过"
    if (mins < 1) { log('心跳很新（不到 1 分钟），不判停过'); return null; }

    // 上次是不是"没关干净"？顺便看设备有没有重启过（boot_id 变了 = 重启/断电）
    let unclean = false;
    let how = '';                                  // 断的方式
    try {
      const info = JSON.parse(fs.readFileSync(RUNNING, 'utf8'));
      unclean = true;
      const nowBoot = bootId();
      if (info && info.bootId && nowBoot && info.bootId !== nowBoot) how = 'reboot';
      else how = 'killed';
    } catch { unclean = fs.existsSync(RUNNING); if (unclean) how = 'killed'; }
    try { fs.writeFileSync(RUNNING, JSON.stringify({ ts: Date.now(), bootId: bootId() })); } catch {}

    // 断电/被杀：哪怕只断了一分钟也告诉她；正常重启则 10 分钟内不打扰
    const threshold = unclean ? 1 : 10;
    if (mins < threshold) {
      // 短暂的断（比如手机断电几分钟）：不进她的状态，但记一条，事后能查到
      if (mins >= 2) {
        // 哪怕只断了两分钟，也要让她知道"这是中断，不是我在发呆"
        const stS = JSON.parse(fs.readFileSync('__MIKU_ROOT__/bot/state.json', 'utf8'));
        stS.gapNotice = { minutes: Math.round(mins), label: `不到一小时（${Math.round(mins)} 分钟）`, cause: (how === 'reboot' ? '设备重启或断电' : '我的进程被重启，不是网络问题'), at: Date.now(), shown: false };
        fs.writeFileSync('__MIKU_ROOT__/bot/state.json', JSON.stringify(stS, null, 2));
        log(`容器断过约 ${Math.round(mins)} 分钟，已记进她的状态（算中断，不算她）`);
        emit('life', 'gap-short', `容器断过约 ${Math.round(mins)} 分钟（已告诉她这是中断）`);
      } else if (mins >= 1) {
        log(`容器断过约 ${Math.round(mins)} 分钟（太短，不打扰她）`);
      }
      return null;
    }
    // 时长按"跨没跨午夜"来切，不按分钟数——20 小时没跨夜不该说成"隔了一天"
    const d1 = new Date(last), d2 = new Date();
    const dayDiff = Math.round((new Date(d2.getFullYear(), d2.getMonth(), d2.getDate())
      - new Date(d1.getFullYear(), d1.getMonth(), d1.getDate())) / 86400000);
    const why = how === 'reboot' ? '手机断电或重启了' : (how === 'killed' ? '程序被关掉了，设备没重启' : '');
    let label;
    if (unclean && mins < 60) label = `不到一小时（${why}，没来得及关）`;
    else if (mins < 60) label = '不到一小时';
    else if (mins < 360) label = unclean ? `几个小时（${why}）` : '几个小时';
    else if (dayDiff >= 1) label = '隔了一天以上';
    else label = '大半天';
    const st = JSON.parse(fs.readFileSync('__MIKU_ROOT__/bot/state.json', 'utf8'));
    st.gapNotice = { minutes: Math.round(mins), label, cause: (how === 'reboot' ? '设备重启或断电' : '我的进程被重启，不是网络问题'), at: Date.now(), shown: false };
    fs.writeFileSync('__MIKU_ROOT__/bot/state.json', JSON.stringify(st, null, 2));
    log(`容器停过：${label}（${Math.round(mins)} 分钟），已写进她的状态`);
    emit('life', 'gap', `容器停过 ${label}（${Math.round(mins)} 分钟）`);
    return label;
  } catch { return null; }
}

function netBackoff() {
  try {
    const st = JSON.parse(fs.readFileSync('__MIKU_ROOT__/bot/state.json', 'utf8'));
    const n = Number(st.netFail || 0);
    if (n >= 2) {
      // 退避就是这一轮不联网，并把计数清掉，避免永久禁网
      st.netFail = 0;
      fs.writeFileSync('__MIKU_ROOT__/bot/state.json', JSON.stringify(st, null, 2));
      return { skip: true, n };
    }
    return { skip: false, n };
  } catch { return { skip: false, n: 0 }; }
}
function noteNetResult(ok) {
  try {
    const st = JSON.parse(fs.readFileSync('__MIKU_ROOT__/bot/state.json', 'utf8'));
    st.netFail = ok ? 0 : Number(st.netFail || 0) + 1;
    if (st.netFail >= 2) st.netFail = 0;   // 退避一次后归零，别永久禁网
    fs.writeFileSync('__MIKU_ROOT__/bot/state.json', JSON.stringify(st, null, 2));
    return st.netFail;
  } catch { return 0; }
}

function staleGoals() {
  try {
    const txt = fs.readFileSync('__MIKU_HOME__/goals.md', 'utf8');
    const sec = (name) => {
      const m = txt.match(new RegExp(`## ${name}\\n([\\s\\S]*?)(?=\\n## |$)`));
      return (m ? m[1] : '').split('\n').map((x) => x.replace(/^-\s*/, '').trim()).filter(Boolean);
    };
    const days = (line) => {
      const m = line.match(/(\d{4})-(\d{2})-(\d{2})/g);
      if (!m) return 0;
      const last = m[m.length - 1];
      return Math.floor((Date.now() - new Date(last + 'T00:00:00').getTime()) / 86400000);
    };
    const doing = sec('在做').map((l) => ({ l, d: days(l) }));
    const want = sec('想做，还没动').map((l) => ({ l, d: days(l) }));
    const out = [];
    if (doing.length) out.push('在做的：' + doing.map((x) => `${x.l.split('｜')[0].trim()}（放了 ${x.d} 天）`).join('；'));
    if (want.length) out.push('还没动的：' + want.map((x) => `${x.l.split('｜')[0].trim()}（放了 ${x.d} 天）`).join('；'));
    const old = [...doing, ...want].filter((x) => x.d >= 3);
    if (old.length) out.push('有几件放了三天以上了——还惦记吗？不惦记可以放下，不丢人。');
    return out.join('\n');
  } catch { return ''; }
}

function ctxLine() {
  try {
    const r = syncFramework();
    if (r.changed) log('她的认知文件已同步最新改动');
    if (r.skipped) { log('⚠ 同步被跳过：' + r.error); emit('life', 'warn', '她的认知文件没同步：' + r.error); }
    const v = verifySync();
    if (!v.ok) log('⚠ 认知文件同步异常：' + JSON.stringify(v.blocks));
  } catch {}
  try {
    const day = new Date();
    const p2 = (n) => String(n).padStart(2, '0');
    const f = `__MIKU_HOME__/journal/${day.getFullYear()}-${p2(day.getMonth() + 1)}-${p2(day.getDate())}.md`;
    let lastEntry = '';
    if (fs.existsSync(f)) {
      const t = fs.readFileSync(f, 'utf8').trim().split('\n\n');
      lastEntry = t.slice(-1)[0].slice(0, 120);
    }
    const gapMin = (Date.now() - lastActivityAt()) / 60000;
    const d2 = new Date(lastActivityAt());
    const p2b = (n) => String(n).padStart(2, '0');
    // 超过 2 小时就不说"刚才"，改成绝对时间，免得她编造连续感
    const whenTalk = gapMin < 2 ? '刚才'
      : gapMin < 60 ? `${Math.round(gapMin)} 分钟前`
      : gapMin < 120 ? `${Math.round(gapMin / 60)} 小时前`
      : `${d2.getMonth() + 1} 月 ${d2.getDate()} 日 ${p2b(d2.getHours())}:${p2b(d2.getMinutes())}`;
    return [
      '——',
      (() => {
        try {
          const st = JSON.parse(fs.readFileSync('__MIKU_ROOT__/bot/state.json', 'utf8'));
          if (st.gapNotice && !st.gapNotice.shown) return '你中间断过一次，但不是重新开始——上次的你还在，接着过。下面是刚才的你：';
        } catch {}
        return '你不是刚被唤醒，你一直都在。下面是刚才的你：';
      })(),
      lastEntry ? `你上一条日记：${lastEntry}` : '你今天还没写日记。',
      `上次和他说话是 ${whenTalk}。`,
      gapMin > 120 ? '中间隔了很久，不用假装是刚才。' : '',
      '接着往下过就行，不用重新介绍自己。',
      staleGoals(),
    ].filter(Boolean).join('\n');
  } catch { return ''; }
}

let lastRunAt = 0;
let lastAwakeIn = 0;      // 她自己定的下次醒来（分钟）
let lastAgain = false;    // 她说「接着」：立刻再来一轮              // 防止 wakeOnce 之后紧接着又跑一轮
// 深夜整理：读今天的日记，提炼 1-2 条写进 memory.md（像人睡觉时做的事）
async function consolidate() {
  try {
    const st = JSON.parse(fs.readFileSync('__MIKU_ROOT__/bot/state.json', 'utf8'));
    const today = new Date().toISOString().slice(0, 10);
    const hour = new Date().getHours();
    if (hour < 21 && hour > 2) return;                 // 只在夜里做
    if (st.lastConsolidate === today) return;           // 一天一次
    const f = `__MIKU_HOME__/journal/${today}.md`;
    let txt = '';
    try { txt = fs.readFileSync(f, 'utf8'); } catch { return; }
    if (txt.length < 80) return;                        // 今天没写什么，不用整理
    const { consolidateMemory } = await import('./mind.mjs');
    const items = await consolidateMemory(txt);
    if (!items || !items.length) return;
    const applied = applyActions({ remember: items.slice(0, 2) });
    st.lastConsolidate = today;
    fs.writeFileSync('__MIKU_ROOT__/bot/state.json', JSON.stringify(st, null, 2));
    log(`睡前整理：${applied.join('、') || '没写'}`);
    emit('life', 'consolidate', `睡前把今天理了一遍：${applied.join('、') || '没留下什么'}`);
  } catch (e) { log('睡前整理失败：' + e.message); logErr('consolidate', e, {}); }
}

async function cycle() {
  if (Date.now() - lastRunAt < 60000) { log('一分钟内刚动过，这轮跳过'); return; }
  lastRunAt = Date.now();
  // 生活不打卡：她的时间 24 小时都在，只是深夜频率低（60 分钟一次）
  const since = (Date.now() - lastActivityAt()) / 60000;
  // QUIET_MIN 已由她自己决定（默认 0）：刚聊完也可以继续做自己的事
  if (QUIET_MIN > 0 && since < QUIET_MIN) { log(`刚聊过（${Math.round(since)} 分钟前），不打扰自己`); return; }
  {
    // 1G 小机器永远到不了 900MB：改成 可用内存+空闲swap 与 总量的比例判断
    const avail = memAvailableMB();
    const total = Number(os.totalmem() / 1048576) || 1024;
    const swapFree = (() => { try {
      const m = fs.readFileSync('/proc/meminfo', 'utf8').match(/SwapFree:\s+(\d+) kB/);
      return m ? Number(m[1]) / 1024 : 0;
    } catch { return 0; } })();
    const need = Math.max(80, total * 0.12);   // 至少留 12% 或 80MB
    if (avail + swapFree < need) { log(`内存紧张（可用 ${Math.round(avail)}MB + swap ${Math.round(swapFree)}MB < ${Math.round(need)}MB），跳过`); return; }
  }

  beat();
  const mode = nightTime() ? 'night' : 'day';
  const gapMin = Math.round(since);
  // 超过 2 小时的空档：记成"容器被冻结"，免得她以为自己在空转
  try {
    if (gapMin >= 120) {
      const stF = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
      stF.lastFreeze = { gapMin, at: Date.now() };
      // 留最近 10 次冻结记录，方便对比"开没开省电模式"的夜晚
      stF.freezeLog = [...(stF.freezeLog || []), { gapMin, at: Date.now() }].slice(-10);
      atomicState(stF);
    }
  } catch {}
  const sleepLabel = gapMin >= 120
    ? `容器被系统冻结过（安静 ${gapMin} 分钟，可能是整夜）`
    : `安静 ${gapMin} 分钟`;
  log(`${mode === 'night' ? '夜里整理' : '自己的时间'}开始（${sleepLabel}）`);
  emit('life', 'think_start', mode === 'night' ? '夜里整理记忆和心情' : '过一会儿自己的时间');
  const t0 = Date.now();
  try {
    await syncClock().catch(() => {});   // 6 小时缓存，不会每次都打网络
    await consolidate().catch(() => {});
    // 愿望单自动审计：判断 → 能做的先备份再做 → 做完自测 → 写回理由
    try {
      const { auditAll } = await import('../../bot/wish-audit.mjs');
      const res = await auditAll();
      for (const r of res) {
        if (r.verdict === 'implemented') {
          log(`愿望 ${r.id} 已实现：${r.result}`);
          emit('life', 'wish_done', `她许的 ${r.id} 做成了：${r.result}`);
        } else if (r.verdict === 'reject' || r.verdict === 'defer') {
          log(`愿望 ${r.id}：${r.verdict}（${r.why}）`);
          emit('life', 'wish_judged', `${r.id} → ${r.verdict}：${r.why}`);
        } else if (r.verdict === 'failed') {
          emit('life', 'wish_judged', `${r.id} 执行失败：${r.error}`);
        }
      }
    } catch (e) { log('愿望审计出错：' + e.message); }
    const bo = netBackoff();
    if (bo.skip) {
      log(`上几轮联网都不顺，这轮不联网（退避）`);
      emit('life', 'skip', '上次联网没成功，这次先不联网');
    }
    const result = await reflect(mode, ctxLine(), { noNet: bo.skip });
    // 她提的刹车：连着干同一件事超过十轮，只提醒一句，不拦
    try {
      const cat = (result && typeof result.bili === 'string' && result.bili) ? '刷 B 站'
        : (result && typeof result.search === 'string' && result.search) ? '搜东西'
          : (result && typeof result.journal === 'string' && result.journal) ? '写日记'
            : '发呆';
      const stS = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
      const prev = stS.streak || { cat: '', n: 0 };
      const n = prev.cat === cat ? (prev.n || 0) + 1 : 1;
      stS.streak = { cat, n };
      if (n > 1 && n % 10 === 0) {
        stS.streakNotice = { cat, n, at: Date.now() };
        emit('life', 'streak', `她连着 ${n} 轮都在${cat}——提一句，不拦`);
        log(`提醒：连着 ${n} 轮都在${cat}`);
      }
      atomicState(stS);
    } catch {}
    lastAgain = !!(result && result.again === true);
    lastAwakeIn = Number(result && result.awakeIn) || 0;
    if (lastAwakeIn) {
      try {
        const stH = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
        stH.herAwakeIn = lastAwakeIn; atomicState(stH);
      } catch {}
    }
    if (lastAwakeIn) log(`她自己定的下次醒来：${lastAwakeIn} 分钟`);
    noteNetResult(!(result && result._netFail));

    const applied = applyActions(result);
    log(`完成（${Math.round((Date.now() - t0) / 1000)}s）${applied.join('、') || '什么也没做'}`);
    emit('life', 'think_end', applied.length ? applied.join('、') : '想了想，什么也没做');
  } catch (e) {
    log('失败:', e.message);
    emit('life', 'error', e.message);
  }
}

async function wakeOnce() {
  lastRunAt = Date.now();
  try {
    beat();
    // 刚聊过就别"醒来"了 —— 否则她会以为自己在重新启动
    const since = (Date.now() - lastActivityAt()) / 60000;
    if (QUIET_MIN > 0 && since < QUIET_MIN) {
      log(`刚聊过（${Math.round(since)} 分钟前），这次醒来先不动`);
      return;
    }
    log('容器重启了，她接着过（不是醒来）');
    emit('life', 'think_start', '她开始过自己的时间');
    const r = await reflect('wake', ctxLine());
    const applied = applyActions(r);
    log(`回来后：${applied.join('、') || '只是看了一眼'}`);
    emit('life', 'think_end', applied.length ? '回来后' + applied.join('、') : '回来看了一眼');
  } catch (e) {
    log('醒来这一轮失败:', e.message);
  }
}

// 正常被 kill（改代码/重启）不算"突然断电"：走之前把标记撤掉
process.on('SIGTERM', () => { try { fs.unlinkSync(RUNNING); } catch {} process.exit(0); });
process.on('SIGINT', () => { try { fs.unlinkSync(RUNNING); } catch {} process.exit(0); });

checkGap();
beat();
setInterval(beat, 60 * 1000);   // 心跳 = 进程活着，不是"她做了事"
log(`生活循环启动：间隔由她自己定（1-240 分钟，默认 ${DAY_INTERVAL}）；安静 ${QUIET_MIN} 分钟以上才行动`);
(async () => {
  await new Promise((r) => setTimeout(r, 3000));
  await wakeOnce();
  for (;;) {
    try { await cycle(); } catch (e) { log('异常:', e.message); logErr('life', e, { cycle: true }); }
    // 下次多久醒：她自己定的优先；没定就按配置兜底
    if (lastAgain) {
      // 她说「接着」：立刻再来一轮（留 3 秒，别把 CPU 烧穿）
      log('她说「接着」：马上开始下一轮');
      emit('life', 'again', '她自己说「接着」，立刻继续');
      await new Promise((r) => setTimeout(r, 3000));
      continue;
    }
    // 她不填 awakeIn 就不再默认 20 分钟叫她：
    // 用她上一次自己填的间隔；她从来没填过，才退回一个"问一次"的短间隔
    let minutes = lastAwakeIn;
    let bySelf = !!minutes;
    if (!minutes) {
      try {
        const stP = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
        if (stP.herAwakeIn) { minutes = Number(stP.herAwakeIn); bySelf = false; }
      } catch {}
    }
    if (!minutes) {
      // 第一次没填：只叫醒她一次去问她，不形成默认节奏
      minutes = 30;
      bySelf = false;
    }
    minutes = Math.max(1, Math.min(240, Math.round(minutes)));
    const wait = minutes * 60 * 1000;
    // 记下"她决定的下次行动时间"，面板和状态都用这个
    try {
      const st = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
      st.nextWakeAt = Date.now() + wait;
      st.nextWakeMinutes = minutes;
      st.nextWakeBy = bySelf ? 'herself' : (lastAwakeIn ? 'last' : 'ask');
      atomicState(st);
    } catch {}
    log(`下次醒来到 ${new Date(Date.now() + wait).toTimeString().slice(0, 5)}（${minutes} 分钟后，${bySelf ? '她自己定的' : (lastAwakeIn ? '沿用上次的' : '她没填，先问一次')}）`);
    // 等待期间随时可以被改档：每 20 秒重读一次 state.nextWakeAt
    const myDue = Date.now() + Math.max(1, minutes) * 60 * 1000;
    let adopted = myDue;
    for (;;) {
      let due = adopted;
      try {
        const stW = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
        const nw = Number(stW.nextWakeAt) || 0;
        // 别人（比如她回他消息时）改了档期：以新的为准
        if (nw && Math.abs(nw - myDue) > 2000) due = nw;
      } catch {}
      if (Date.now() >= due) break;
      const left = due - Date.now();
      await new Promise((r) => setTimeout(r, Math.max(1000, Math.min(20000, left))));
      adopted = due;
    }
    // 醒来后把过期的档期清掉，避免下一轮误判
    try {
      const stC = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
      if (stC.nextWakeAt && stC.nextWakeAt <= Date.now()) { stC.nextWakeAt = 0; atomicState(stC); }
    } catch {}
  }
})();
