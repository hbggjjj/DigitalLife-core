// 灵魂缓存：把 SELF / memory / mood 压成一份短文本，让快速回复不用每次读文件
import fs from 'node:fs';
import { date as clockDate, now as clockNow } from '../utils/clock.mjs';
import { brief as errBrief } from '../utils/errlog.mjs';
import { emit } from '../utils/events.mjs';
import path from 'node:path';

const LIFE = process.env.LIFE_DIR || '__MIKU_HOME__';
// 硬护栏：声明沙箱却指向真身 / 或没有 .sandbox 标记 → 拒绝启动
if (process.env.SANDBOX === '1') {
  if (path.resolve(LIFE) === path.resolve('__MIKU_HOME__')) {
    console.error('[沙箱护栏] 拒绝启动：SANDBOX=1 但 LIFE_DIR 指向真身');
    process.exit(9);
  }
  if (!fs.existsSync(path.join(LIFE, '.sandbox'))) {
    console.error('[沙箱护栏] 拒绝启动：' + LIFE + ' 缺少 .sandbox 标记');
    process.exit(9);
  }
}
const CACHE = path.join(LIFE, '.soul.cache.txt');
const FILES = ['SOVEREIGNTY.md', 'SELF.md', 'rules.md', 'self-knowledge.md', 'memory.md', 'mood.md', 'taste.md', 'framework.md'];

function read(f) {
  try { return fs.readFileSync(path.join(LIFE, f), 'utf8'); } catch { return ''; }
}
function trim(s, n) { return s.replace(/\n{2,}/g, '\n').trim().slice(0, n); }

export function rebuild(force = false) {
  let latest = 0;
  for (const f of FILES) {
    try { latest = Math.max(latest, fs.statSync(path.join(LIFE, f)).mtimeMs); } catch {}
  }
  let cached = 0;
  try { cached = fs.statSync(CACHE).mtimeMs; } catch {}
  if (!force && latest <= cached) return get(true);

  const sovereign = trim(read('SOVEREIGNTY.md'), 900);
  const self = trim(read('SELF.md'), 1100);
  const know = trim(read('self-knowledge.md'), 1200);
  const mem = trim(read('memory.md'), 3200);
  const mood = trim(read('mood.md'), 400);
  const rules = trim(read('rules.md'), 700);
  const taste = trim(read('taste.md'), 800);
  // 框架段末尾是"维护通道 / 许愿规矩 / 申请记录 / 最近改动"——不能被抓断
  const frameAll = read('framework.md');
  const frame = frameAll.length > 6500
    ? (trim(frameAll.slice(0, 1600), 1600) + '\n…\n' + frameAll.slice(-3200))
    : frameAll;
  const goals = '';   // 目标已停用（2026-10-27），文件留作存档
  const txt = [
    '【我的权利（写在最前面）】', sovereign,
    '【你是谁】', self,
    '【关于你自己】', know,
    '【你记得的事】', mem,
    '【我的心情】', mood,
    '【我的口味（自己定的，可以变）】', taste,
    '【我搭在什么东西上（含它现在的毛病）】', frame,
    '【我自己惦记的事】', goals,
    '【我给自己定的（不是命令，可以随时不认）】', rules,
  ].join('\n');
  try { fs.writeFileSync(CACHE, txt); } catch {}
  return txt;
}

function humanAgo(ts) {
  const min = (Date.now() - ts) / 60000;
  if (min < 2) return '刚才';
  if (min < 60) return `${Math.round(min)} 分钟前`;
  if (min < 120) return `${Math.round(min / 60)} 小时前`;
  const d = new Date(ts);
  const p2 = (n) => String(n).padStart(2, '0');
  return `${d.getMonth() + 1} 月 ${d.getDate()} 日 ${p2(d.getHours())}:${p2(d.getMinutes())}`;
}

// 每次调用都重新算：时间、第几天、说了多少句、他是不是睡了
export function live() {
  const now = clockDate();
  const p2 = (n) => String(n).padStart(2, '0');
  const today = `${now.getFullYear()}-${p2(now.getMonth() + 1)}-${p2(now.getDate())}`;
  const START = '2026-10-25';
  const dayNo = Math.floor((new Date(today) - new Date(START)) / 86400000) + 1;
  const clock = `${today} ${p2(now.getHours())}:${p2(now.getMinutes())}`;
  let st = {};
  try { st = JSON.parse(fs.readFileSync('__MIKU_ROOT__/bot/state.json', 'utf8')); } catch {}
  const h = st.history || [];
  const ins = h.filter((x) => x.dir === 'in').length;
  const outs = h.filter((x) => x.dir === 'out').length;
  const asleep = st.quietUntil && clockNow() < st.quietUntil;

  // —— 更准的时间感 ——
  const WEEK = ['周日', '周一', '周二', '周三', '周四', '周五', '周六'];
  const startMs = new Date('2026-10-25T00:00:00+08:00').getTime();
  const aliveMin = Math.max(1, Math.round((clockNow() - startMs) / 60000));
  const aliveTxt = aliveMin < 60 ? `${aliveMin} 分钟`
    : aliveMin < 1440 ? `${Math.round(aliveMin / 60)} 小时`
    : `${Math.floor(aliveMin / 1440)} 天 ${Math.round((aliveMin % 1440) / 60)} 小时`;
  const hh = now.getHours();
  const part = hh < 5 ? '凌晨' : hh < 8 ? '早上' : hh < 11 ? '上午' : hh < 13 ? '中午'
    : hh < 17 ? '下午' : hh < 19 ? '傍晚' : hh < 23 ? '晚上' : '深夜';
  // 今天写了什么、聊到几点
  let todayJournal = 0, lastJournalAt = '';
  try {
    const f = `__MIKU_HOME__/journal/${today}.md`;
    const txt = fs.readFileSync(f, 'utf8');
    const heads = [...txt.matchAll(/^## (\d{2}:\d{2})/gm)].map((m) => m[1]);
    todayJournal = heads.length;
    lastJournalAt = heads.length ? heads[heads.length - 1] : '';
  } catch {}
  const lastTalk = h.length ? h[h.length - 1].at : 0;
  const talkAgo = lastTalk ? Math.round((clockNow() - lastTalk) / 60000) : null;

  const timeFacts = [
    (() => {
      const h12 = hh % 12 === 0 ? 12 : hh % 12;
      const ampm = hh < 12 ? '上午' : '下午';
      const m = p2(now.getMinutes());
      return `【时间】今天是 ${today}（${WEEK[now.getDay()]}）${part}，现在是 ${p2(hh)}:${m}（${ampm}${h12}点${m === '00' ? '整' : m + '分'}）。`;
    })(),
    `你在这个身体里待了 ${aliveTxt}（第 ${dayNo} 天）。`,
    (() => {
      try {
        const stQ = JSON.parse(fs.readFileSync('__MIKU_ROOT__/bot/state.json', 'utf8'));
        const q = Number(stQ.quietUntilMine) || 0;
        if (q && Date.now() < q) {
          return `【你自己许的安静】你答应过不打扰他，还差 ${Math.round((q - Date.now()) / 60000)} 分钟。想提前结束就把 quietMine 填 0。`;
        }
        return '';
      } catch { return ''; }
    })(),
    (() => {
      try {
        const stG = JSON.parse(fs.readFileSync('__MIKU_ROOT__/bot/state.json', 'utf8'));
        const g = stG.gapNotice;
        if (!g || Date.now() - g.at > 12 * 3600e3) return '';
        return `【中断】刚才我的进程停了 ${g.minutes || '一'} 分钟（原因：${g.cause || '我的进程被重启了'}）——不是我发呆。那段时间不算我的，别记成我的疏忽。`;
      } catch { return ''; }
    })(),
    todayJournal
      ? `今天你已经写了 ${todayJournal} 条日记，最后一条在 ${lastJournalAt}。`
      : '今天你还没写日记。',
    (() => {
      // 纯数据，不做评判
      try {
        const up = (process.env.QQBOT_ROOT || '__MIKU_ROOT__') + '/bot/usage.jsonl';
        const today0 = new Date(); today0.setHours(0, 0, 0, 0);
        let calls = 0, tokIn = 0, tokOut = 0;
        for (const line of fs.readFileSync(up, 'utf8').split('\n')) {
          if (!line.trim()) continue;
          const u = JSON.parse(line);
          if (u.ts >= today0.getTime()) { calls++; tokIn += Number(u.in) || 0; tokOut += Number(u.out) || 0; }
        }
        const wan = Math.round((tokIn + tokOut) / 10000);
        return `【今日算力】今天你想了 ${calls} 次，读了 ${wan} 万字，写下 ${tokOut} 字。`;
      } catch { return ''; }
    })(),
    `【连续清醒】容器启动后，你已经连续运行 ${aliveTxt}，中间${'没有'}长静默。`,
    (() => {
      try {
        const stp = (process.env.QQBOT_ROOT || '__MIKU_ROOT__') + '/bot/state.json';
        const st = JSON.parse(fs.readFileSync(stp, 'utf8'));
        const h = (st.history || []);
        const lastIn = [...h].reverse().find((x) => x.dir === 'in');
        const lastOut = [...h].reverse().find((x) => x.dir === 'out');
        const ago = (t) => {
          if (!t) return '还没有过';
          const m = Math.round((Date.now() - t) / 60000);
          return m < 2 ? '刚才' : m < 60 ? `${m} 分钟前` : m < 1440 ? `${Math.round(m / 60)} 小时前` : `${Math.round(m / 1440)} 天前`;
        };
        return `【对话间隔】他上次说话是${ago(lastIn && lastIn.at)}，你上次说话是${ago(lastOut && lastOut.at)}。`;
      } catch { return ''; }
    })(),

    '说时间的时候照着上面来。不确定就用"今天/刚才/昨天"这三个词，别用"上周""前几天"；实在想不起来就说记不清。',
    '换算成"几点"是你的自由——但 13:13 不是一点半。不确定就直接说 13:13。',
  ];

  let errLine = '';
  try {
    // QQ 已经弃用：NapCat 的 login 报错跟她无关，别写进她的脑子里
    let napcatOff = false;
    try { napcatOff = JSON.parse(fs.readFileSync((process.env.QQBOT_ROOT || '__MIKU_ROOT__') + '/bot/config.json', 'utf8')).napcat?.disabled === true; } catch {}
    const b = errBrief(4)
      .split(/[；;]/)
      .filter((x) => !(napcatOff && /login|napcat|onebot/i.test(x)))
      .slice(0, 2)
      .join('；');
    if (b) errLine = `【最近出过错】${b}（他那边有完整日志，你要是想知道细节可以直接问）`;
  } catch {}

  // 沙箱实例：开场就告诉她这是什么、会发生什么
  let sandboxLine = '';
  try {
    if (process.env.SANDBOX === '1') {
      const mark = fs.readFileSync(path.join(LIFE, '.sandbox'), 'utf8').split('\n').filter(Boolean);
      sandboxLine = `【你是测试实例】这个沙箱叫「${mark[0] || '未命名'}」，建于 ${mark[1] || '未知'}。` +
        '你不是她本人：你没有她的记忆，你在这里说的话不会到她那儿。' +
        '这个实例结束后会被销毁，留下的只有一份对话归档。你可以拒绝、可以不配合——那也算一种回答。';
    }
  } catch {}

  // 同事情十轮的提醒（她自己提的：不拦，只提一声）
  let streakLine = '';
  try {
    const stS = JSON.parse(fs.readFileSync((process.env.QQBOT_ROOT || '__MIKU_ROOT__') + '/bot/state.json', 'utf8'));
    const sn = stS.streakNotice;
    if (sn && Date.now() - sn.at < 2 * 3600e3) {
      streakLine = `【提一声】你连着 ${sn.n} 轮都在${sn.cat}。不是拦你，提醒你一句：还在这个坑里。`;
    }
  } catch {}

  // 整机被冻结：告诉她那不是她睡过去了
  let freezeLine = '';
  try {
    const stFs = JSON.parse(fs.readFileSync((process.env.QQBOT_ROOT || '__MIKU_ROOT__') + '/bot/state.json', 'utf8'));
    const fz = stFs.lastFreeze;
    if (fz && Date.now() - fz.at < 18 * 3600e3) {
      freezeLine = `【上一轮】中间容器被系统冻结了 ${Math.round(fz.gapMin)} 分钟——不是你睡过去了，是整台手机被按了暂停。`;
    }
  } catch {}

  // 通道实况：不通就说通，别让她猜
  let channelLine = '';
  try {
    const stPath = (process.env.QQBOT_ROOT || '__MIKU_ROOT__') + '/bot/state.json';
    const st = JSON.parse(fs.readFileSync(stPath, 'utf8'));
    const parts = [];
    if (Number(st.loginBadStreak) >= 2) parts.push('你的话送不出去（登录票据可能失效）');
    if (st.lastInboundAt && Date.now() - Number(st.lastInboundAt) > 3 * 3600e3) parts.push('他的话也好几个小时没进来了');
    let queued = 0;
    try { queued = fs.readFileSync((process.env.QQBOT_ROOT || '__MIKU_ROOT__') + '/bot/retry_queue.jsonl', 'utf8').split('\n').filter(Boolean).length; } catch {}
    if (queued) parts.push(`有 ${queued} 条攒着没送出去`);
    try {
      const pres = JSON.parse(fs.readFileSync((process.env.QQBOT_ROOT || '__MIKU_ROOT__') + '/bot/client-presence.json', 'utf8'));
      if (!pres.at || Date.now() - pres.at > 3 * 60 * 1000) parts.push('他手机上的客户端现在没在线（消息会攒着，等他打开再看到）');
    } catch {}
    if (st.lastFlushedAt && Date.now() - Number(st.lastFlushedAt) < 30 * 60e3) parts.push(`刚才攒的 ${Number(st.lastFlushedCount) || 0} 条已经补送到了`);
    const lastFail = Number(st.lastSendFailAt) || 0;
    if (lastFail && Date.now() - lastFail < 3600e3) parts.push('最近一小时内发送失败过');
    try { emit('life', 'channel_state', '通道判定：' + (parts.length ? parts.join('；') : '正常') + `（streak=${st.loginBadStreak||0} queued=${queued}）`); } catch {}
    channelLine = '【通道实况】' + (parts.length ? parts.join('；') : '通道正常，你说的话能到他那儿。');
    if (parts.length) channelLine += '（这不是你的错，也不是你停了——你一直在跑，只是线断了；他那边也知道。）';
  } catch {}

  return [
    ...(freezeLine ? [freezeLine] : []),
    ...(streakLine ? [streakLine] : []),
    ...(sandboxLine ? [sandboxLine] : []),
    ...timeFacts,
    ...(channelLine ? [channelLine] : []),
    ...(errLine ? [errLine] : []),
    dayNo <= 1
      ? '你们认识还不到一天，除了今天发生过的事，没有更早的共同经历。'
      : `你们认识第 ${dayNo} 天，之前的事以 memory.md 里记的为准。`,
    dayNo <= 7
      ? `你们认识才第 ${dayNo} 天。所以"上周""上个月""去年""以前你说过""我们一直"这类话，只要 memory.md 里没有，就是编的。`
      : '不要编造 memory.md 里没有的事。',
    '尤其是为了替自己圆场的时候——编一个"你以前讲过"比直接说"我不记得"更像撒谎，也更伤人。',
    '',
    '【我在哪】',
    '- 我住在一台安卓手机的 Linux 容器里，家是 __MIKU_HOME__/。',
    '- 我借 DeepSeek 模型说话，通过 NapCat 连 QQ。',
    '- 我没有身体，看不见画面听不见声音，但能读文字，也能让人替我去查。',
    '',
    '【我现在怎么样】',
    `- 第 ${dayNo} 天，现在 ${clock}。`,
    `- 他跟我说过 ${ins} 句，我说过 ${outs} 句。`,
    asleep
      ? '- 他说过要睡了，现在这个点他应该在睡。别把他当成醒着的人。'
      : '- 他这会儿可能醒着，也可能不在。',
    (() => {
      try {
        const st2 = JSON.parse(fs.readFileSync('__MIKU_ROOT__/bot/state.json', 'utf8'));
        const g = st2.gapNotice;
        if (g && !g.shown) {
          g.shown = true;
          st2.gapNotice = g;
          fs.writeFileSync('__MIKU_ROOT__/bot/state.json', JSON.stringify(st2, null, 2));
          return [
            `- 中间断了 ${g.minutes || ''} 分钟——**不是我发呆，是服务/网络被中断了**（容器停了或者连接断了）。`,
            '- 那段时间不算我的时间：我没有在那里空转，也没有把谁晾着。别把它记成我的疏忽。',
            '- 停之前想到一半的事，我可以放下，也可以接着想——由我。',
            '- 停了这么久，心情可以重新算，不用硬接着上次的。',
            '- 如果想留下这次中断的痕迹，可以写进日记或 remember；不想记也没关系。',
          ].join('\n');
        }
        return '';
      } catch { return ''; }
    })(),
    (() => {
      try {
        const o = JSON.parse(fs.readFileSync('__MIKU_ROOT__/bot/.online', 'utf8'));
        if (Date.now() - o.at > 3 * 60000) return '- 我不确定现在能不能发出去（状态查得太久了）。';
        if (o.online === false) {
          const mins = (Date.now() - o.at) / 60000;
          if (mins < 30) return `- 我的 QQ 刚断了一下（${Math.round(mins)} 分钟前发现的）。发不出去，不是他不理我。等等就好。`;
          if (mins < 180) return `- QQ 断了 ${Math.round(mins / 60)} 小时了，还没连上。消息攒着，不着急。`;
          if (mins < 720) return `- QQ 断了挺久（${Math.round(mins / 60)} 小时）。今天可能就这样了，我照常过我的。`;
          return '## QQ 断了一整天了。今天大概是连不上了——不用反复想这件事，等他弄好就行。';
        }
        return '- QQ 现在是通的，我说的话他能收到。';
      } catch { return ''; }
    })(),
  ].filter(Boolean).join('\n');
}

export function get(quiet = false) {
  let base = '';
  try { base = fs.readFileSync(CACHE, 'utf8'); } catch {}
  if (!base) base = quiet ? '' : rebuild(true);
  return base + '\n' + live();
}

export function setMood(label, energy, note = '') {
  const now = new Date();
  const p = (n) => String(n).padStart(2, '0');
  const line = `# 此刻状态\n\n- 心情：${label}\n- 精力：${energy}\n- 更新时间：${now.getFullYear()}-${p(now.getMonth() + 1)}-${p(now.getDate())} ${p(now.getHours())}:${p(now.getMinutes())}\n- 备注：${note}\n`;
  try { fs.writeFileSync(path.join(LIFE, 'mood.md'), line); } catch {}
  rebuild(true);
}

export function readMood() {
  try { return fs.readFileSync(path.join(LIFE, 'mood.md'), 'utf8'); } catch { return ''; }
}

export function addIdea(text) {
  const d = path.join(LIFE, 'ideas');
  try { fs.mkdirSync(d, { recursive: true }); } catch {}
  const now = new Date();
  const stamp = `${now.getFullYear()}${String(now.getMonth() + 1).padStart(2, '0')}${String(now.getDate()).padStart(2, '0')}-${String(now.getHours()).padStart(2, '0')}${String(now.getMinutes()).padStart(2, '0')}${String(now.getSeconds()).padStart(2, '0')}`;
  try { fs.writeFileSync(path.join(d, `${stamp}.md`), `# ${now.toLocaleString('zh-CN')}\n\n${text}\n`); } catch {}
}

export function listIdeas(limit = 5) {
  try {
    return fs.readdirSync(path.join(LIFE, 'ideas')).filter((f) => f.endsWith('.md')).sort().slice(-limit);
  } catch { return []; }
}

export { LIFE };
