#!/usr/bin/env node
// 数字生命控制面板：浏览器打开 http://127.0.0.1:7788
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { execFile, exec } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const BOT = '__MIKU_ROOT__/bot';
import { instanceName } from '../src/utils/name.mjs';
const NAPCAT_DIR = process.env.NAPCAT_DIR || '';   // QQ/NapCat 已弃用，留空即不使用
const CFG_FILE = path.join(BOT, 'config.json');
const STATE_FILE = path.join(BOT, 'state.json');
const PERSONA_FILE = path.join(BOT, 'persona.md');
const QR_FILE = path.join(NAPCAT_DIR, 'qrcode.png');
const PORT = 7788;

const readCfg = () => JSON.parse(fs.readFileSync(CFG_FILE, 'utf8'));
const writeCfg = (o) => {
  try {
    fs.appendFileSync('__MIKU_ROOT__/bot/config-writes.log',
      `[${new Date().toISOString()}] panel writeCfg active=${o?.schedule?.activeStart}-${o?.schedule?.activeEnd} pid=${process.pid}\n`);
  } catch {}
  fs.writeFileSync(CFG_FILE, JSON.stringify(o, null, 2));
};
const readState = () => { try { return JSON.parse(fs.readFileSync(STATE_FILE, 'utf8')); } catch { return {}; } };
const writeState = (st) => { try { fs.writeFileSync(STATE_FILE, JSON.stringify(st, null, 2)); return true; } catch { return false; } };

function run(cmd, args = [], opts = {}) {
  return new Promise((resolve) => {
    execFile(cmd, args, { timeout: opts.timeout || 60000, ...opts }, (err, stdout, stderr) => {
      resolve({ ok: !err, code: err ? err.code : 0, stdout: String(stdout || ''), stderr: String(stderr || '') });
    });
  });
}
function sh(cmd, timeout = 120000) {
  return new Promise((resolve) => {
    exec(cmd, { timeout, maxBuffer: 8 * 1024 * 1024 }, (err, stdout, stderr) => {
      resolve({ ok: !err, stdout: String(stdout || ''), stderr: String(stderr || '') });
    });
  });
}

async function procList() {
  const r = await sh('pgrep -af "napcat_loade[r]|bot.mjs daemo[n]|supervisor.s[h]|node servic[e].mjs|node lif[e].mjs"');
  const lines = r.stdout.trim().split('\n').filter(Boolean);
  const has = (kw) => lines.some((l) => l.includes(kw));

  // 守护：优先看 systemd（服务器）；没有 systemd 的机器才回退到 supervisor.sh
  let supervisor = has('supervisor.sh');
  let supervisorLabel = 'supervisor.sh';
  try {
    const u = await sh('systemctl is-active miku-core miku-life miku-daemon miku-panel miku-bridge 2>/dev/null');
    const states = u.stdout.trim().split('\n').filter(Boolean);
    if (states.length) {
      supervisor = states.every((x) => x === 'active');
      supervisorLabel = 'systemd';
    }
  } catch {}

  return {
    napcat: has('napcat_loader'),
    bot: has('bot.mjs daemon'),
    supervisor,
    supervisorLabel,
    reply: has('service.mjs'),
    life: has('life.mjs'),
  };
}

async function loginInfo() {
  const cfg = readCfg();
  try {
    // 先问真实在线状态（get_login_info 掉线时也会返回 ok）
    let online = null;
    try {
      const sr = await fetch(`${cfg.napcat.baseUrl}/get_status`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${cfg.napcat.token}` },
        body: '{}',
        signal: AbortSignal.timeout(5000),
      });
      const sd = await sr.json();
      online = !!(sd && sd.data && sd.data.online);
    } catch {}
    const r = await fetch(`${cfg.napcat.baseUrl}/get_login_info`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${cfg.napcat.token}` },
      body: '{}',
      signal: AbortSignal.timeout(6000),
    });
    const d = await r.json();
    if (d?.data?.user_id) {
      if (online === false) return { ok: false, offline: true, ...d.data };
      return { ok: true, ...d.data };
    }
    return { ok: false };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

function qrInfo() {
  try {
    const st = fs.statSync(QR_FILE);
    return { exists: true, mtime: st.mtimeMs, ageSec: Math.round((Date.now() - st.mtimeMs) / 1000) };
  } catch {
    return { exists: false };
  }
}

function json(res, obj, code = 200) {
  const body = JSON.stringify(obj);
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(body);
}

const PAGE = `<!doctype html>
<html lang="zh"><head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">
<meta name="theme-color" content="#12121a">
<title>__INSTANCE_NAME__ · 数字生命</title>
<style>
*{box-sizing:border-box;-webkit-tap-highlight-color:transparent}
body{margin:0;font:15px/1.5 -apple-system,system-ui,"PingFang SC",sans-serif;background:#0f0f15;color:#e8e8f0;padding:14px 12px 40px}
h1{font-size:17px;margin:4px 0 14px;font-weight:600;letter-spacing:.5px}
.card{background:#1a1a24;border:1px solid #26263a;border-radius:14px;padding:14px;margin-bottom:12px}
.row{display:flex;align-items:center;justify-content:space-between;gap:8px;padding:5px 0}
.k{color:#8b8ba7;font-size:13px}
.v{font-variant-numeric:tabular-nums;font-size:13px}
.dot{width:8px;height:8px;border-radius:50%;display:inline-block;margin-right:6px}
.on{background:#3ddc84;box-shadow:0 0 8px #3ddc8488}.off{background:#ff5c5c}
button{font:600 14px/1 inherit;border:0;border-radius:11px;padding:12px 14px;color:#fff;background:#3a3a52;flex:1}
button:active{transform:scale(.97)}
button.primary{background:#4f6ef7}button.danger{background:#c0392b}button.ghost{background:#23232f;color:#b9b9cc}
.btns{display:flex;gap:8px;margin-top:10px}
#qr{width:100%;max-width:320px;display:block;margin:8px auto;border-radius:12px;background:#fff;padding:8px}
.hint{color:#8b8ba7;font-size:12px;text-align:center;margin-top:6px}
.modes{display:flex;gap:6px;margin-top:4px}
.mode{flex:1;padding:10px 2px;border-radius:10px;background:#23232f;color:#b9b9cc;font-size:12.5px;text-align:center;border:1px solid transparent}
.mode.on{background:#4f6ef7;color:#fff;border-color:#6b85ff}
input,textarea{width:100%;background:#12121a;border:1px solid #2c2c40;color:#e8e8f0;border-radius:10px;padding:11px;font:14px/1.4 inherit}
textarea{min-height:80px;resize:vertical}
.hide{display:none}
#toast{position:fixed;left:50%;bottom:26px;transform:translateX(-50%) translateY(20px);background:#2f2f45;padding:11px 18px;border-radius:12px;font-size:13px;opacity:0;transition:.25s;pointer-events:none;max-width:88vw;text-align:center}
#toast.show{opacity:1;transform:translateX(-50%) translateY(0)}
.badge{font-size:11px;padding:2px 8px;border-radius:20px;background:#26263a;color:#9c9cba}
.ev{display:flex;gap:8px;padding:7px 0;border-bottom:1px solid #22223210;font-size:13px;line-height:1.45}
.ev:last-child{border-bottom:0}
.ev .t{flex:none;color:#6d6d8a;font-size:11px;padding-top:2px;width:44px;font-variant-numeric:tabular-nums}
.ev .b{flex:1;min-width:0;word-break:break-word}
.ev .inner{color:#a99bd6;font-style:italic}
.tag{display:inline-block;font-size:10px;padding:1px 6px;border-radius:5px;margin-right:6px;vertical-align:1px}
.t-in{background:#1e3a5f;color:#7fb6ff}.t-out{background:#1e4634;color:#5fd39a}
.t-think{background:#4a3a15;color:#ffc861}.t-done{background:#17413f;color:#5fd3cc}
.t-skip{background:#2a2a38;color:#8b8ba7}.t-err{background:#4a1f1f;color:#ff8585}
.t-life{background:#33244a;color:#c39bff}.t-check{background:#1c1c28;color:#6d6d8a}
.t-norm{background:#3a3318;color:#e0c060}.t-warn{background:#4a2a12;color:#ffa860}
.thinking{display:inline-block;width:7px;height:7px;border-radius:50%;background:#ffc861;margin-right:6px;animation:pulse 1.1s infinite}
@keyframes pulse{0%,100%{opacity:.25}50%{opacity:1}}
.chat{margin:0}
.chat .m{padding:8px 11px;border-radius:11px;margin:6px 0;font-size:13.5px;max-width:88%;word-break:break-word}
.chat .me{background:#25324d;margin-left:auto}
.chat .you{background:#23232f}
.chat .who{font-size:10px;color:#7a7a96;margin:0 4px 2px}
pre.doc{white-space:pre-wrap;font:12.5px/1.55 ui-monospace,Menlo,monospace;background:#12121a;border:1px solid #26263a;border-radius:10px;padding:10px;max-height:260px;overflow:auto;margin:6px 0 0}
summary{cursor:pointer;font-size:13px;color:#b9b9cc;padding:4px 0}
</style></head><body data-ver="p20261030-1150">
<h1>__INSTANCE_NAME__ <span style="font-size:12px;color:#6d6d8a">· 数字生命 控制台</span> <span id="pageVer" style="font-size:12px;color:#6d6d8a">v…</span></h1>

<div class="card">
  <div class="row"><span class="k">她的寿命</span><span class="v" id="lifetime">—</span></div>
  <div class="row"><span class="k">本次运行</span><span class="v" id="uptime">—</span></div>
  <div class="row"><span class="k">页面版本</span><span class="v" id="pageVerRow" style="font-size:12px;opacity:.7">—</span></div>
  <div class="row"><span class="k">页面刷新</span><span class="v" id="lastTick" style="font-size:12px;opacity:.7">—</span></div>
  <div class="row"><span class="k">QQ（备用通道）</span><span class="v" id="login" style="color:#6d6d8a">已停用</span>
    <button onclick="showQR()" style="margin-left:8px;padding:4px 8px;border-radius:8px;border:1px solid #2c2c40;background:#141420;color:#8a8a9a;font-size:11px">需要时再扫码</button></div>
  <div class="row"><span class="k">通道自检</span><span class="v" id="probe" style="font-size:12px">—</span><button onclick="probeChannel()" style="margin-left:8px;padding:6px 10px;border-radius:8px;border:1px solid #2c2c40;background:#181824;color:#cfcfe6;font-size:12px">立即检查</button></div>
  <div class="row"><span class="k">备用通道（QQ）</span><span class="v" id="s-napcat">—</span></div>
  <div class="row"><span class="k">守护（systemd）</span><span class="v" id="s-sup">—</span></div>
  <div class="row"><span class="k">主动消息</span><span class="v" id="s-bot">—</span></div>
  <div class="row"><span class="k">自动回复</span><span class="v" id="s-reply">—</span></div>
  <div class="row"><span class="k">自己的生活</span><span class="v" id="s-life">—</span></div>
  <div class="row"><span class="k">大脑</span><span class="v" id="s-brain">—</span></div>
  <div class="row"><span class="k">今日 token</span><span class="v" id="tokens">—</span></div>
  <div class="row"><span class="k">最近1小时</span><span class="v" id="tokensHour">—</span></div>
  <div class="row"><span class="k">授时</span><span class="v" id="clock">—</span></div>
  <div class="row"><span class="k">视觉通道</span><span class="v" id="visionState">—</span></div>
  <div class="row"><span class="k">她攒着的话</span><span class="v" id="queued">—</span></div>
  <div class="row"><span class="k">今日主动开口</span><span class="v" id="today">—</span></div>
  <div class="btns">
    <button class="primary" onclick="act('start')">一键启动</button>
    <button class="ghost" onclick="act('restart')">重启</button>
    <button class="danger" onclick="act('stop')">全部停止</button>
  </div>
  <div class="btns">
    <button class="primary" style="background:#2f7d5b" onclick="flushQueue()">补发攒的话</button>
    <button class="ghost" onclick="toggleBrain()">大脑（单次调用）</button>
  </div>
</div>

<div class="card">
  <div class="row"><span class="k">它现在在做什么</span><span class="v" id="brainState">—</span></div>
  <div id="events" style="margin-top:6px"><div class="hint">还没有动静</div></div>
</div>

<div class="card">
  <div class="row"><span class="k">她此刻的心情</span><span class="badge" id="moodAt">—</span></div>
  <div id="moodLabel" style="font-size:23px;margin:10px 0 6px;letter-spacing:1px">—</div>
  <div id="moodEnergy" class="hint" style="text-align:left">—</div>
</div>

<div class="card">
  <div class="row"><span class="k">她脑子里</span><span class="badge" id="innerAt">—</span></div>
  <div id="innerBox" style="margin-top:8px"><div class="hint">还没开始想</div></div>
</div>

<div class="card">
  <div class="row"><span class="k">最近的对话</span><span class="v" id="sourceHint" style="font-size:11px;opacity:.6"></span><span class="v" id="chatHint"></span></div>
  <div class="chat" id="chat"></div>
</div>

<div class="card">
  <details>
    <summary>它的家：SELF / memory / 日记</summary>
    <div class="k" style="margin:10px 0 2px">SELF.md · 我是谁</div>
    <pre class="doc" id="docSelf">加载中…</pre>
    <div class="k" style="margin:10px 0 2px">rules.md · 她给自己定的（可随时打破）</div>
    <pre class="doc" id="docRules">加载中…</pre>
    <div class="k" style="margin:10px 0 2px">memory.md · 记得的事</div>
    <pre class="doc" id="docMem">加载中…</pre>
    <div class="k" style="margin:10px 0 2px">今天的日记</div>
    <pre class="doc" id="docJournal">加载中…</pre>
  </details>
</div>

<div class="card" id="debugCard">
  <div class="row"><span class="k">调试对话</span><span class="badge" id="dbgHint">不会发到 QQ</span></div>
  <div class="hint" style="text-align:left">以「维护者·代发」的身份给她发一条消息。**会标明这是代发**，她的回复只出现在下面这块，不发 QQ、不进历史。</div>
  <textarea id="dbgText" rows="3" style="width:100%;box-sizing:border-box;margin-top:8px;padding:10px;background:#12121a;color:#e8e8f0;border:1px solid #2c2c40;border-radius:10px;font-size:14px" placeholder="输入要测试的内容，比如：你现在有什么想要的吗？"></textarea>
  <div class="btns" style="margin-top:8px">
    <button class="primary" onclick="debugSend('agent')">以维护者·代发（唯一方式）</button>
  </div>
  <div id="dbgLog" style="margin-top:8px;max-height:180px;overflow:auto;border-top:1px solid #22223240;padding-top:6px"></div>
</div>

<div class="card" id="errCard">
  <div class="row"><span class="k">错误日志</span><span class="badge" id="errCount">—</span></div>
  <div class="hint" style="text-align:left">每次报错的来源、消息、上下文。她只看到最近 2 条摘要，这里可以看全部。</div>
  <div id="errBox" style="margin-top:8px;max-height:260px;overflow:auto"></div>
</div>

<div class="card" id="clockCard">
  <div class="row"><span class="k">她的时间安排</span><span class="badge" id="clockBy">—</span></div>
  <div class="hint" style="text-align:left">这四项都是她自己填的，面板只显示，改不了。</div>
  <div class="row"><span class="k">下次醒</span><span class="v" id="hkWake">—</span></div>
  <div class="row"><span class="k">下次看看要不要找他</span><span class="v" id="hkSpeak">—</span></div>
  <div class="row"><span class="k">挂了多久会催</span><span class="v" id="hkFollow">—</span></div>
</div>

<div class="card" id="tasteCard">
  <div class="row"><span class="k">她的口味</span><span class="badge" id="tasteCount">—</span></div>
  <div class="hint" style="text-align:left">她自己写进 taste.md 的。反复出现的喜欢/不喜欢才会记，单次不算。</div>
  <div id="tasteBox" style="margin-top:8px"></div>
</div>

<div class="card" id="channelCard">
  <div class="row"><span class="k">她主动开口投到哪</span><span class="badge" id="channelNow">—</span></div>
  <div class="hint" style="text-align:left">现在是**她自己**在每次主动开口时选投哪儿（她填 channel）。这两个按钮是给你手动改的兜底；你发消息她回你，永远回到你发的那边。记录不分支，一直在。</div>
  <div style="display:flex;gap:8px;margin-top:10px">
    <button class="primary" style="flex:1" onclick="setChannel('qq')">投到 QQ</button>
  </div>
</div>

<div class="card" id="ideasCard">
  <div class="row"><span class="k">她没说出口的话</span><span class="badge" id="ideaCount">—</span></div>
  <div class="hint" style="text-align:left">她写了、但决定不发的。存在 ~/life/ideas/，攒着等你哪天问起。</div>
  <div id="ideasBox" style="margin-top:8px"><div class="hint">还没有</div></div>
</div>

<div class="card" id="framesCard">
  <div class="row"><span class="k">她对自己这套东西的想法</span><span class="badge" id="frameCount">—</span></div>
  <div class="hint" style="text-align:left">她自己写进 framework.md 的「我自己想到的」，系统不覆盖这段。</div>
  <div id="framesBox" style="margin-top:8px"><div class="hint">她还没写过</div></div>
</div>

<div class="card" id="wishesCard">
  <div class="row"><span class="k">她许的愿</span><span class="badge" id="wishCount">—</span></div>
  <div class="hint" style="text-align:left">她自己提的能力需求。做不做由维护者判断，理由会写回她的表里。</div>
  <div id="wishBox" style="margin-top:8px"><div class="hint">她还没许过愿</div></div>
</div>

<div class="card hide" id="goalsCard" style="display:none">
  <div class="row"><span class="k">她想要什么</span><span class="badge" id="goalCount">—</span></div>
  <div id="goalBox" style="margin-top:8px"><div class="hint">还没惦记什么</div></div>
</div>

<div class="card" id="biliCard">
  <div class="row"><span class="k">B 站登录（读字幕用）</span><span class="badge" id="biliState">未登录</span></div>
  <div class="hint" style="text-align:left">登录后能读视频的 CC 字幕原文。不登录也能刷，只是只能看标题和弹幕。</div>
  <img id="biliQr" alt="B站二维码" style="display:none;width:200px;height:200px;background:#fff;border-radius:10px;margin:6px auto">
  <div class="btns"><button class="primary" onclick="biliQr()">生成 B 站二维码</button></div>
</div>

<div class="card" id="qrCard">
  <div class="row"><span class="k">扫码登录（同一台手机也能扫）</span><span class="badge" id="qrage">—</span></div>
  <img id="qr" alt="二维码" onerror="this.style.display='none';document.getElementById('qrHint').style.display='block'">
  <div id="qrHint" class="hint" style="display:none;color:#ff8585">二维码还没生成，点下面「换一张新码」</div>
  <div class="hint">QQ → ＋ → 扫一扫 → 相册 → 选下载目录里的二维码图</div>
  <div class="btns">
    <button class="primary" onclick="refreshQR()">换一张新码</button>
    <button class="ghost" onclick="saveQR()">存到相册</button>
  </div>
</div>

<div class="card">
  <div class="k" style="margin-bottom:8px">主动程度</div>
  <div class="modes" id="modes"></div>
  <div class="hint" id="modeHint" style="text-align:left;margin-top:8px">—</div>

  <div class="row"><span class="k">她可以自己追问(开/关)</span><select id="fuon" style="width:110px;padding:8px;background:#12121a;color:#e8e8f0;border:1px solid #2c2c40;border-radius:10px"><option value="1">开启</option><option value="0">关闭</option></select></div>
  <div class="hint" style="text-align:left;margin-top:2px">具体隔几分钟、要不要问，由她每次自己判断（你回得快她就不问）。</div>
  <div class="hint" style="text-align:left;margin-top:8px">要不要回、要不要憋着、发不发表情包、多久后追问——这些现在都是她自己判断的，没有概率。</div>
  <div class="row"><span class="k">表情包开关</span><select id="memeon" style="width:110px;padding:8px;background:#12121a;color:#e8e8f0;border:1px solid #2c2c40;border-radius:10px"><option value="1">开启</option><option value="0">关闭</option></select></div>
  <div class="btns"><button class="primary" onclick="saveTemper()">保存细节</button></div>
</div>

<div class="card">
  <div class="k" style="margin-bottom:4px">时间设置</div>
  <div class="hint" style="text-align:left;margin-bottom:12px">这三项管的是不同的事，别弄混</div>

  <div class="k" style="margin:2px 0 6px;color:#5fd39a">① 她能主动找你的时间</div>
  <div class="row"><span class="k">从</span><input id="actFrom" type="time" style="width:120px;padding:8px"></div>
  <div class="row"><span class="k">到（次日）</span><input id="actTo" type="time" style="width:120px;padding:8px"></div>
  <div class="btns" style="margin-top:8px">
    <button class="ghost" onclick="setWindow('00:00','23:59')">设为全天</button>
    <button class="ghost" onclick="setWindow('22:00','02:00')">设为夜间</button>
  </div>
  <div class="hint" id="actHint" style="text-align:left"></div>

  <div class="k" style="margin:16px 0 6px;color:#5fd39a">② 她自己活动的频率</div>
  <div class="row"><span class="k">她下次行动</span><span class="v" id="nextWake">—</span></div>
  <div class="hint" style="text-align:left">由她自己决定（1–240 分钟，最短 1 分钟）。这里只显示，不能改。</div>

  <div class="k" style="margin:16px 0 6px;color:#5fd39a">③ 她多久想一次要不要找你</div>
  <div class="row"><span class="k">默认节奏</span><span class="v" id="heartInfo">—</span></div>
  <div class="hint" style="text-align:left">她自己排了档期就按她的来；没排时才用这个默认间隔。</div>

  <div class="btns"><button class="primary" id="saveTimeBtn" onclick="saveTime()">保存时间设置</button></div>
</div>

<div class="card">
  <div class="k" style="margin-bottom:8px">配置</div>
  <div class="row"><span class="k">发给</span><input id="tid" style="width:120px;padding:8px"></div>
  <div class="row"><span class="k">今天已主动开口</span><span class="v" id="dmaxInfo">—</span></div>
  <div class="btns"><button class="primary" onclick="saveCfg()">保存配置</button></div>
</div>

<div id="toast"></div>
<script>
function showErr(msg){
  try {
    var b = document.getElementById('errBar');
    if (!b) {
      b = document.createElement('div');
      b.id = 'errBar';
      b.style.cssText = 'position:fixed;top:0;left:0;right:0;background:#a33;color:#fff;padding:8px 12px;font-size:12px;z-index:9999;white-space:pre-wrap';
      document.body.appendChild(b);
    }
    b.textContent = msg;
  } catch(e) {}
}
window.addEventListener('unhandledrejection', function(e){ showErr('异步出错：' + (e.reason && e.reason.message || e.reason)); });
window.onerror = function(m, src, line, col){
  try {
    var b = document.getElementById('errBar');
    if (!b) {
      b = document.createElement('div');
      b.id = 'errBar';
      b.style.cssText = 'position:fixed;top:0;left:0;right:0;background:#a33;color:#fff;padding:8px 12px;font-size:12px;z-index:9999;white-space:pre-wrap';
      document.body.appendChild(b);
    }
    b.textContent = '页面脚本出错：' + m + '（第 ' + line + ' 行）';
  } catch(e) {}
};

let cfg=null;
const $=id=>document.getElementById(id);
function toast(m){const t=$('toast');t.textContent=m;t.classList.add('show');clearTimeout(t._h);t._h=setTimeout(()=>t.classList.remove('show'),2200)}
async function api(p,body){
  const r=await fetch(p,body?{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)}:{});
  return r.json();
}

var MODES=[
 {k:'冷淡',v:75,note:'几乎不主动找你，除非憋很久'},
 {k:'安静',v:62,note:'很少开口，一天也就一两条'},
 {k:'正常',v:48,note:'隔一两个小时想起来说一句'},
 {k:'主动',v:36,note:'一小时左右就会来一句'},
 {k:'黏人',v:25,note:'时不时就想找你说话'}
];
function renderModes(th){
  // 只读：开口与否由她自己排的档期决定，这里只是历史参考
  var box=document.getElementById('modes'); if(!box) return;
  var best=0,bd=999;
  for(var i=0;i<MODES.length;i++){var d=Math.abs(MODES[i].v-th); if(d<bd){bd=d;best=i}}
  var html='';
  for(var j=0;j<MODES.length;j++){
    html+='<div class="mode'+(j===best?' on':'')+'" style="opacity:'+(j===best?'1':'.45')+';cursor:default">'+MODES[j].k+'</div>';
  }
  box.innerHTML=html;
  var h=document.getElementById('modeHint');
  if(h) h.textContent='只读：现在开不开口由她自己排的档期决定，这一档只是历史参考。';
}
function setWindow(a, b){
  var af=$('actFrom'), at=$('actTo');
  if(af) af.value=a;
  if(at) at.value=b;
  return saveWindow(a, b, '已设为 ');
}
function checkTimeValid(){
  var af=$('actFrom'), at=$('actTo'), btn=$('saveTimeBtn');
  if(!btn) return;
  // time 控件只会给合法值或空串，别再用正则卡（之前把 22:00 判成了不合法）
  var ok = !!(af && af.value) && !!(at && at.value);
  btn.disabled = !ok;
  btn.style.opacity = ok ? '1' : '.45';
  btn.textContent = ok ? '保存时间设置' : '先把时间填完整';
}
document.addEventListener('input', function(e){
  if(e.target && (e.target.id==='actFrom'||e.target.id==='actTo')) checkTimeValid();
});
setInterval(checkTimeValid, 2000);
function saveTime(){
  var a=$('actFrom').value, b=$('actTo').value;
  if(!a || !b){ toast('先把时间填完整'); return; }
  return saveWindow(a, b, '时间已保存：');
}

// 时间保存只有这一处（setWindow / saveTime 都走它）
async function saveWindow(a, b, prefix){
  var r=await api('/api/config',{activeStart:a, activeEnd:b});
  var af=$('actFrom'), at=$('actTo');
  if(r && r.savedSchedule){
    if(af) af.value=r.savedSchedule.activeStart;
    if(at) at.value=r.savedSchedule.activeEnd;
    renderActHint(r.savedSchedule.activeStart, r.savedSchedule.activeEnd);
    var ok = (r.savedSchedule.activeStart===a && r.savedSchedule.activeEnd===b);
    toast(ok ? (prefix+a+'–'+b) : ('没保存成功，现在是 '+r.savedSchedule.activeStart+'–'+r.savedSchedule.activeEnd));
  } else {
    toast((r && r.message) || '失败');
  }
  setTimeout(refresh,1200);
}

async function saveTemper(){
  var r=await api('/api/config',{

    memeOn:$('memeon').value==='1',
    fuOn:$('fuon').value==='1'
    // 注意：不再带 activeStart/activeEnd——时间只由它自己的按钮写，
    // 否则点「保存细节」会把旧的时间框值一起提交回去（时段被"自动改"的根源）
  });
  if (r.savedSchedule) {
    var af=$('actFrom'), at=$('actTo');
    if(af) af.value=r.savedSchedule.activeStart;
    if(at) at.value=r.savedSchedule.activeEnd;
    renderActHint(r.savedSchedule.activeStart, r.savedSchedule.activeEnd);
  }
  if (r && r.savedSchedule) {
    var wantA=$('actFrom').value, wantB=$('actTo').value;
    if (wantA && wantA !== r.savedSchedule.activeStart) toast('时间没存进去：现在是 '+r.savedSchedule.activeStart+'–'+r.savedSchedule.activeEnd+'（手机时间选择器可能没提交，试试「设为全天」）');
    else toast(r.ok?(r.message||'细节已保存'):(r.message||'失败'));
  } else {
    toast(r.ok?(r.message||'细节已保存'):(r.message||'失败'));
  }
  setTimeout(refresh,1500);
}
function fillTemper(c){
  var im=(c&&c.impulse)||{}, rp=(c&&c.reply)||{};
  renderModes(im.threshold!=null?im.threshold:48);
  var set=function(id,v){var el=$(id); if(el&&document.activeElement!==el) el.value=v;};

  var mo=$('memeon'); if(mo && document.activeElement!==mo) mo.value=(rp.memeEnabled===false?'0':'1');
  var fu=rp.followUp||{};
  var fo=$('fuon'); if(fo && document.activeElement!==fo) fo.value=(fu.enabled===false?'0':'1');

}

function minutesOf(hm){var p=String(hm).split(':');return Number(p[0])*60+Number(p[1])}
function renderActHint(from,to){
  var el=$('actHint'); if(!el) return;
  var a=minutesOf(from), b=minutesOf(to);
  var span=(b-a+1440)%1440; if(span===0) span=1440;
  var hrs=(span/60).toFixed(1);
  var now=new Date(); var cur=now.getHours()*60+now.getMinutes();
  var inside = a<=b ? (cur>=a&&cur<=b) : (cur>=a||cur<=b);
  var cross = b<a;
  el.innerHTML='共 <b>'+hrs+' 小时</b>'+(cross?'，跨过午夜（到今天结束再到次日 '+to+'）':'，不跨午夜')
    +'<br>现在 '+String(now.getHours()).padStart(2,'0')+':'+String(now.getMinutes()).padStart(2,'0')
    +'：'+(inside?'<span style="color:#5fd39a">✅ 在时段内，她可以主动找你</span>':'<span style="color:#ff8585">❌ 不在时段内，她不会主动开口</span>');
}
function renderDebug(list){
  var box=$('dbgLog'); if(!box) return;
  if(!list || !list.length){ box.innerHTML='<div class="hint">还没有调试记录</div>'; return; }
  var h='';
  for(var i=0;i<list.length;i++){
    var d=list[i];
    if(!d) continue;
    var isAgent = !!d.agent;
    var who = d.dir==='out' ? '她' : (isAgent ? '维护者·代发' : '风');
    var c = d.dir==='out' ? '#5fd39a' : (isAgent ? '#c58cff' : '#7fb6ff');
    h+='<div style="padding:2px 0;font-size:13px"><span style="color:'+c+'">'+who+'</span>'
     + '<span style="color:#5a5a72;font-size:11px;margin:0 6px">'+new Date(d.at).toLocaleTimeString('zh-CN',{hour12:false}).slice(0,5)+'</span>'
     + esc(d.text)+'</div>';
  }
  box.innerHTML=h;
}
async function debugSend(as){
  var el=$('dbgText'); var t=(el&&el.value||'').trim();
  if(!t){ toast('先写点什么'); return; }
  toast('正在发送…');
  var r=await api('/api/debug/send',{ text:t, as: as||'user' });
  toast(r.message||'已发送');
  if(el) el.value='';
  setTimeout(refresh,2500);
}
function renderErrs(list){
  var box=$('errBox'); if(!box) return;
  if(!list || !list.length){ box.innerHTML='<div class="hint">最近没有报错</div>'; if($('errCount')) $('errCount').textContent='0'; return; }
  var h='';
  for(var i=0;i<list.length;i++){
    var e=list[i];
    var t=new Date(e.ts);
    var hh=String(t.getHours()).padStart(2,'0')+':'+String(t.getMinutes()).padStart(2,'0');
    h+='<div style="padding:6px 0;border-bottom:1px solid #22223240">'
     + '<div style="font-size:12px;color:#8b8ba7"><span style="color:#ff8585">'+hh+'</span> '
     + esc(e.source||'')+'</div>'
     + '<div style="font-size:13px;color:#e0e0f0;margin:2px 0">'+esc((e.message||'').slice(0,120))+'</div>'
     + (e.meta && Object.keys(e.meta).length ? '<div style="font-size:11px;color:#6d6d8a">'+esc(JSON.stringify(e.meta).slice(0,120))+'</div>' : '')
     + '</div>';
  }
  box.innerHTML=h;
  if($('errCount')) $('errCount').textContent=list.length+' 条';
}
function fmtClock(ts){
  if(!ts) return '';
  var d=new Date(ts);
  return String(d.getHours()).padStart(2,'0')+':'+String(d.getMinutes()).padStart(2,'0');
}
async function probeChannel(){
  var el=$('probe'); if(el) el.textContent='检查中…';
  try {
    var r=await api('/api/channel/check');
    if(el) el.textContent=(r.moved?'✅ ':'⚠️ ')+(r.verdict||'');
  } catch(e){ if(el) el.textContent='检查失败：'+e.message; }
}
function showQR(){
  var c=$('qrCard'); if(!c) return;
  c.classList.remove('hide');
  c.scrollIntoView({behavior:'smooth', block:'center'});
}
function fmtDur(ms){
  if(!ms || ms < 0) return '—';
  var m = Math.floor(ms/60000), h = Math.floor(m/60), d = Math.floor(h/24);
  if(d > 0) return d+' 天 '+(h%24)+' 小时 '+(m%60)+' 分';
  if(h > 0) return h+' 小时 '+(m%60)+' 分';
  return m+' 分钟';
}
function renderLifetime(l){
  if(!l) return;
  var e1=$('lifetime'), e2=$('uptime');
  if(e1){
    var acc = (l.accumMs || 0);
    if(acc > 0) e1.textContent = fmtDur(acc) + '（累计在线，中断不算；第一句话在 ' + (l.born ? new Date(l.born).toLocaleString('zh-CN',{hour12:false}).slice(0,10) : '—') + '）';
    else e1.textContent = fmtDur(l.now - l.uptimeFrom);
  }
  if(e2) e2.textContent = fmtDur(l.now - l.uptimeFrom);
}
function renderHerClock(c){
  if(!c) return;
  var w=$('hkWake'), sp=$('hkSpeak'), fo=$('hkFollow'), by=$('clockBy');
  if(w){
    if(c.nextWakeAt){
      var raw=Math.round((c.nextWakeAt-Date.now())/60000);
      w.textContent=fmtClock(c.nextWakeAt)+(raw<0?'（已到点，等系统恢复）':('（'+raw+' 分钟后）'));
      w.style.color=c.nextWakeBy==='herself'?'#5fd39a':'#8b8ba7';
    } else { w.textContent='还没排'; }
  }
  if(by) by.textContent = c.nextWakeBy==='herself' ? '她自己排的' : '默认节奏';
  if(sp){
    if(c.speakInAt && c.speakInAt>Date.now()){
      var l2=Math.max(0,Math.round((c.speakInAt-Date.now())/60000));
      sp.textContent=fmtClock(c.speakInAt)+'（'+l2+' 分钟后）'; sp.style.color='#5fd39a';
    } else { sp.textContent='没排（按默认心跳）'; sp.style.color='#8b8ba7'; }
  }
  if(fo){
    fo.textContent = c.followIn ? (c.followIn+' 分钟没回她才会问一次') : '不催（她没填）';
    fo.style.color = c.followIn ? '#ffc861' : '#8b8ba7';
  }
}
function renderTaste(t){
  var box=$('tasteBox'); if(!box) return;
  t=t||{like:[],dislike:[],watch:[]};
  var total=(t.like||[]).length+(t.dislike||[]).length+(t.watch||[]).length;
  if($('tasteCount')) $('tasteCount').textContent = total ? total+' 条' : '0';
  var sec=function(name,arr,color){
    if(!arr||!arr.length) return '';
    var h='<div style="margin-top:6px"><span style="color:'+color+';font-size:12px">'+name+'</span></div>';
    for(var i=0;i<arr.length;i++) h+='<div style="padding:3px 0 3px 10px;font-size:13px;color:#d8d8e8">· '+esc(arr[i])+'</div>';
    return h;
  };
  var html = sec('喜欢', t.like, '#5fd39a') + sec('不喜欢', t.dislike, '#ff8585') + sec('最近在意的', t.watch, '#ffc861');
  box.innerHTML = html || '<div class="hint">还没记下什么</div>';
}
function setChannel(ch){
  api('/api/channel',{method:'POST',body:JSON.stringify({channel:ch})}).then(function(r){
    if(r && r.ok){ var el=$('channelNow'); if(el) el.textContent = ch==='selfim'?'自建IM':'QQ'; }
  }).catch(function(e){ showErr('切换失败：'+e.message); });
}
function renderChannel(ch){
  var el=$('channelNow'); if(!el) return;
  el.textContent = (ch==='selfim' ? '自建IM' : 'QQ') + '（她自己的选择）';
  el.style.color = ch==='selfim' ? '#8fb4ff' : '';
}
function viaLabel(h){
  if(!h) return '';
  var t = h.dir==='out' ? (h.via==='selfim' ? '我·自建IM' : '我·QQ') : (h.via==='selfim' ? '他·自建IM' : '他·QQ');
  if(h.agent) t += '·代发';
  if(h.resend) t += '·补发';
  return t;
}
function renderIdeas(list){
  var box=$('ideasBox'); if(!box) return;
  if(!list || !list.length){ box.innerHTML='<div class="hint">还没有</div>'; if($('ideaCount')) $('ideaCount').textContent='0'; return; }
  var h='';
  for(var i=0;i<list.length;i++){
    var it=list[i];
    h+='<div style="padding:6px 0;border-bottom:1px solid #22223240">'
     + '<div style="font-size:11px;color:#6d6d8a">'+esc(it.at.slice(4,6)+'-'+it.at.slice(6,8)+' '+it.at.slice(9,11)+':'+it.at.slice(11,13))+'</div>'
     + '<div style="font-size:13px;color:#d8d8e8;line-height:1.5">'+esc(it.text)+'</div></div>';
  }
  box.innerHTML=h;
  if($('ideaCount')) $('ideaCount').textContent=list.length+' 条';
}
function renderFrames(list){
  var box=$('framesBox'); if(!box) return;
  if(!list || !list.length){ box.innerHTML='<div class="hint">她还没写过</div>'; if($('frameCount')) $('frameCount').textContent='0'; return; }
  var h='';
  for(var i=list.length-1;i>=0;i--){
    var t=list[i];
    h+='<div style="padding:5px 0;font-size:13px;line-height:1.5;color:#d8d8e8;border-bottom:1px solid #22223240">'+esc(t)+'</div>';
  }
  box.innerHTML=h;
  if($('frameCount')) $('frameCount').textContent=list.length+' 条';
}
function renderWishes(list){
  var box=$('wishBox'); if(!box) return;
  if(!list || !list.length){ box.innerHTML='<div class="hint">她还没许过愿</div>'; $('wishCount').textContent='0'; return; }
  var color=function(st){
    if(/已实现/.test(st)) return '#5fd39a';
    if(/没做成/.test(st)) return '#ff8585';
    if(/暂缓/.test(st)) return '#ffc861';
    return '#8b8ba7';
  };
  var h='';
  for(var i=list.length-1;i>=0;i--){
    var w=list[i], c=color(w.status);
    h+='<div style="padding:6px 0;border-bottom:1px solid #22223240">'
      + '<div style="font-size:13px"><span style="color:#6d6d8a;margin-right:6px">'+w.id+'</span>'
      + '<span style="color:'+c+';font-size:12px;margin-right:6px">'+esc(w.status)+'</span>'
      + esc(w.what)+'</div>'
      + (w.note ? '<div style="color:#8b8ba7;font-size:12px;margin:3px 0 0 22px">'+esc(w.note)+'</div>' : '')
      + '</div>';
  }
  box.innerHTML=h;
  var open=list.filter(function(x){ return /待评估/.test(x.status); }).length;
  $('wishCount').textContent = open ? (open+' 条待评估') : (list.length+' 条');
}
function renderGoals(g){
  var box=$('goalBox'); if(!box) return;
  if(!g || (!g.doing.length && !g.want.length && !g.dropped.length)){
    box.innerHTML='<div class="hint">还没惦记什么</div>'; $('goalCount').textContent='0'; return;
  }
  function block(title, arr, color, style){
    if(!arr.length) return '';
    var h='<div style="margin:4px 0 2px;color:'+color+';font-size:12px">'+title+'</div>';
    for(var i=0;i<arr.length;i++){
      h+='<div style="padding:3px 0 3px 8px;font-size:13px;'+(style||'')+'border-left:2px solid '+color+'20">'+esc(arr[i])+'</div>';
    }
    return h;
  }
  var html='';
  html+=block('在做', g.doing, '#5fd39a');
  html+=block('想做', g.want, '#ffc861');
  html+=block('放下了', g.dropped, '#6d6d8a', 'opacity:.75');
  box.innerHTML=html;
  $('goalCount').textContent = (g.doing.length + g.want.length) + ' 件在惦记';
}
function renderInner(list){
  var box=$('innerBox'); if(!box) return;
  if(!list || !list.length){ box.innerHTML='<div class="hint">还没开始想</div>'; return; }
  var html='';
  for(var i=list.length-1;i>=0;i--){
    var e=list[i];
    var t=new Date(e.ts); var hm=String(t.getHours()).padStart(2,'0')+':'+String(t.getMinutes()).padStart(2,'0');
    html+='<div style="padding:6px 0;border-bottom:1px solid #22223240;font-style:italic;color:#b8a9e6;font-size:13.5px">'
      + '<span style="color:#6d6d8a;font-style:normal;font-size:11px;margin-right:8px">'+hm+'</span>'
      + esc(e.text||'') + '</div>';
  }
  box.innerHTML=html;
  var last=list[list.length-1];
  var d=new Date(last.ts);
  $('innerAt').textContent = String(d.getHours()).padStart(2,'0')+':'+String(d.getMinutes()).padStart(2,'0');
}
function renderMood(md){
  if(!md) return;
  const m=md.match(/心情：\s*(.+)/), e=md.match(/精力：\s*(.+)/), t=md.match(/更新时间：\s*(.+)/);
  if(m) $('moodLabel').textContent=m[1].trim();
  if(e) $('moodEnergy').textContent='精力：'+e[1].trim();
  if(t) $('moodAt').textContent=t[1].trim();
}
async function refresh(){
  try {
  const s=await api('/api/status');
  // 先把表单填上：后面哪个渲染挂了都不影响输入框
  try { if (s.cfg) { cfg=s.cfg; fillForm(s.cfg); fillTemper(s.cfg); } } catch(e) { showErr('填表单失败：'+e.message); }
  var lh = s.loginHealth || {};
  var lastOk = (s.state && s.state.lastSendOkAt) || 0;
  var okFresh = lastOk && (Date.now() - lastOk) < 15 * 60 * 1000;
  if (s.login.ok && lh.online && lh.state === 'ok' && okFresh) {
    $('login').innerHTML = '<span class="dot on"></span>'+s.login.nickname+' '+s.login.user_id+'<span style="font-size:11px;opacity:.55;margin-left:6px">已验证（'+Math.round((Date.now()-lastOk)/60000)+' 分钟前发过）</span>';
  } else if (s.login.ok && lh.online && lh.state === 'ok') {
    $('login').innerHTML = '<span class="dot" style="background:#d8b34a"></span>'+s.login.nickname+' '+s.login.user_id+'<span style="font-size:11px;opacity:.55;margin-left:6px">未验证：接口在线，但最近 15 分钟没成功发过（可能假在线）</span>';
  } else if (s.login.ok && lh.online) {
    $('login').innerHTML = '<span class="dot off"></span>'+s.login.nickname+'（假在线：发不出去）';
  } else if (s.login.ok) {
    $('login').innerHTML = '<span class="dot off"></span>'+s.login.nickname+'（连不上服务器）';
  } else {
    $('login').innerHTML = '<span class="dot off"></span>未登录';
  }
  const mk=(v)=>v?'<span class="dot on"></span>运行中':'<span class="dot off"></span>已停止';
  $('s-napcat').innerHTML = s.proc.napcat
    ? mk(true)
    : '<span style="color:#6d6d8a">未启用（备用通道）</span>';
  $('s-sup').innerHTML=mk(s.proc.supervisor);
  $('s-bot').innerHTML=mk(s.proc.bot);
  $('s-reply').innerHTML=mk(s.proc.reply);
  $('s-life').innerHTML=mk(s.proc.life);
  const bm=(s.cfg.brain&&s.cfg.brain.mode)||'api';
  $('s-brain').innerHTML='<span class="badge">单次调用（agent 已停用）</span>';
  if (s.tokensToday) {
    var t=s.tokensToday;
    $('tokens').textContent = (t.in+t.out).toLocaleString() + '（' + t.calls + ' 次调用）';
  }
  if ($('heartInfo')) {
    var hb = (s.cfg.impulse && s.cfg.impulse.heartMinutes) || 5;
    $('heartInfo').textContent = hb + ' 分钟（她不排档期时才用）';
    $('heartInfo').style.color = '#8b8ba7';
  }
  if ($('dmaxInfo')) {
    var dmx = (s.cfg.schedule && s.cfg.schedule.dailyMax) || 12;
    var used = (s.state && s.state.todayCount) || 0;
    $('dmaxInfo').textContent = used + ' / ' + dmx;
    $('dmaxInfo').style.color = used >= dmx ? '#ffc861' : '';
  }
  if (s.nextWake) {
    var nw = s.nextWake;
    var when = new Date(nw.at);
    var hh = String(when.getHours()).padStart(2,'0'), mm = String(when.getMinutes()).padStart(2,'0');
    var minsLeft = Math.max(0, Math.round((nw.at - Date.now()) / 60000));
    var el = $('nextWake');
    if (el) {
      var leftTxt = (nw.at - Date.now()) < -60000 ? '已到点，等系统恢复' : (minsLeft + ' 分钟后');
      el.textContent = hh + ':' + mm + '（' + leftTxt + (nw.by === 'herself' ? '，她自己定的' : '，默认') + '）';
      el.style.color = nw.by === 'herself' ? '#5fd39a' : '#8b8ba7';
    }
  }
  if (s.vision) {
    var ve = $('visionState');
    if (ve) {
      if (s.vision.ok) ve.innerHTML = '<span class="badge">'+esc(s.vision.model)+'</span>';
      else if (s.vision.enabled && !s.vision.hasKey) ve.innerHTML = '<span class="badge">缺 API key</span>';
      else ve.innerHTML = '<span class="badge">未接</span>';
    }
  }
  if (s.clock) {
    var c = s.clock;
    var clockEl = $('clock');
    if (!c.calibratedAt) { clockEl.textContent = '从未校准（用的是手机本地时钟）'; clockEl.style.color = '#ff8585'; }
    else if (c.ageMin > 360) { clockEl.textContent = '超过 ' + Math.floor(c.ageMin/60) + ' 小时没校准，时间可能不准'; clockEl.style.color = '#ffc861'; }
    else { clockEl.textContent = '已校准（' + Math.abs(c.skewSec) + ' 秒偏差，' + c.ageMin + ' 分钟前）'; clockEl.style.color = ''; }
  }
  if (typeof s.queuedCount === 'number') {
    $('queued').textContent = s.queuedCount ? (s.queuedCount + ' 条（等通道恢复：' + ((s.channel==='selfim')?'自建IM':'QQ') + '）') : '0';
    $('queued').style.color = s.queuedCount ? '#ffc861' : '';
  }
  if (s.tokensHour) {
    var h=s.tokensHour;
    $('tokensHour').textContent = (h.in+h.out).toLocaleString() + '（' + h.calls + ' 次）';
  }
  $('today').textContent = (s.state.todayCount||0)+' / '+(s.cfg.schedule.dailyMax||'-');
  // 只在"登录成功 且 15 分钟内真的发出去过"时才收起二维码；否则一直露着
  var lh2 = s.loginHealth || {};
  var lastOk2 = (s.state && s.state.lastSendOkAt) || 0;
  var verified = !!s.login.ok && lh2.state === 'ok' && lastOk2 && (Date.now() - lastOk2) < 15 * 60 * 1000;
  $('qrCard').classList.toggle('hide', verified);
  $('qrCard').dataset.verified = verified ? '1' : '0';
  api('/api/bili/status',{}).then(b=>{
    const el=$('biliState'); if(!el) return;
    el.textContent = b.logged ? ('已登录' + (b.uname ? '：' + b.uname : '')) : '未登录';
    el.style.color = b.logged ? '#5fd39a' : '';
  }).catch(()=>{});
  try { renderMood(s.mood); } catch(e) { showErr('心情渲染失败：'+e.message); }
  try { renderInner(s.innerThoughts); } catch(e) { showErr('心里话渲染失败：'+e.message); }
  try { renderGoals(s.goals); } catch(e) { showErr('目标渲染失败：'+e.message); }
  try { renderHerClock(s.herClock); } catch(e) { showErr('时间安排渲染失败：'+e.message); }
  try { renderErrs(s.errs); } catch(e) { showErr('错误日志渲染失败：'+e.message); }
  try { renderTaste(s.taste); } catch(e) { showErr('口味渲染失败：'+e.message); }
  try { renderLifetime(s.lifetime); } catch(e) {}
  try { renderChannel(s.channel); } catch(e) {}
  try { renderIdeas(s.ideas); } catch(e) { showErr('想法渲染失败：'+e.message); }
  try { renderFrames(s.frames); } catch(e) { showErr('框架想法渲染失败：'+e.message); }
  try { renderWishes(s.wishes); } catch(e) { showErr('愿望渲染失败：'+e.message); }
  try { renderDebug(s.debugTail); } catch(e) { showErr('调试记录渲染失败：'+e.message); }
  if (!s.login.ok && s.qr.exists) {
    const img=$('qr');
    const want='/api/qr?t='+Math.round(s.qr.mtime);
    if (img.getAttribute('data-src')!==want) { img.setAttribute('data-src',want); img.src=want; }
  }
  if(s.qr.exists){ $('qrage').textContent='生成于 '+s.qr.ageSec+' 秒前'; }
  // 表单已在开头填过
  } catch(e) { showErr('刷新失败：' + (e && e.message ? e.message : e)); }
}
function fillForm(c){
  const im=(c&&c.impulse)||{}, rp=(c&&c.reply)||{}, sc=(c&&c.schedule)||{}, tg=(c&&c.target)||{};
  const set=function(id,val){
    const el=$(id); if(!el) return;
    if(document.activeElement===el) return;
    el.value=val;
  };
  set('tid', tg.id||'');

  var af=$('actFrom'), at=$('actTo');
  var padHM = function(v){ if(!v) return ''; var m=String(v).match(/^(\d{1,2}):(\d{2})$/); return m ? (m[1].padStart(2,'0')+':'+m[2]) : ''; };
  if(af && document.activeElement!==af) af.value=padHM(sc.activeStart)||'22:00';
  if(at && document.activeElement!==at) at.value=sc.activeEnd||'02:00';
  renderActHint(padHM(sc.activeStart)||'22:00', padHM(sc.activeEnd)||'02:00');
  try { checkTimeValid(); } catch(e) {}

  set('stash', Math.round((im.stashChance!=null?im.stashChance:0.28)*100));
  set('skipc', Math.round((rp.skipChance!=null?rp.skipChance:0.06)*100));
}
async function act(a){
  toast('执行中…');
  const r=await api('/api/'+a,{});
  toast(r.message||(r.ok?'完成':'失败'));
  setTimeout(refresh,2500);
}
async function toggleBrain(){
  const r=await api('/api/brain',{}); toast(r.message||'');
  setTimeout(refresh,1200);
}
async function flushQueue(){
  toast('正在补发…');
  const r=await api('/api/flush',{});
  toast(r.message||'已提交');
  setTimeout(refresh,2000);
}
async function askLogin(){
  toast('正在向手机推送登录确认…');
  const r=await api('/api/login',{});
  toast(r.message||'已发送');
  setTimeout(refresh,2000);
}
async function biliQr(){
  toast('正在生成 B 站二维码…');
  const r = await api('/api/bili/qr',{});
  if(!r.ok){ toast(r.message||'失败'); return; }
  $('biliQr').src='/api/bili/png?t='+Date.now();
  $('biliQr').style.display='inline-block';
  toast('扫一下这张码');
  const t=setInterval(async()=>{
    const p=await api('/api/bili/poll',{});
    if(p.status==='ok'){ clearInterval(t); $('biliState').textContent='已登录'; $('biliQr').style.display='none'; toast('B 站登录成功'); }
    else if(p.status==='expired'){ clearInterval(t); toast('码过期了，重新生成'); }
    else if(p.status==='waiting'){ $('biliState').textContent=p.message||'等待扫码'; }
  },2500);
}
async function refreshQR(){
  toast('正在生成新二维码…');
  const r=await api('/api/qr/refresh',{});
  toast(r.message||'已生成');
  $('qr').src='/api/qr?t='+Date.now();
  setTimeout(refresh,1500);
}
async function saveQR(){
  const r=await api('/api/qr/save',{});
  toast(r.message||'已保存');
}
async function saveCfg(){
  const dm=parseInt($('dmax').value);
  if(!(dm>=1&&dm<=50)){ toast('每天最多要在 1~50 之间'); return; }
  const r=await api('/api/config',{
    id:$('tid').value.trim(),
    dailyMax:dm
  });
  toast(r.message||'已保存');
}
// ===== 行为透明：事件流 =====
var lastTs=0, evBuf=[];
var TAGS={in_msg:['t-in','收到'],out_msg:['t-out','发出'],think_start:['t-think','思考'],
  think_end:['t-done','想完'],skip:['t-skip','跳过'],degrade:['t-err','降级'],timeout:['t-err','超时'],
  error:['t-err','出错'],decide:['t-think','决定'],check:['t-check','检查'],reset:['t-skip','重置'],quick:['t-done','秒回'],stash:['t-life','忍住'],delay:['t-think','晚点回'],silence:['t-skip','已读不回'],inner:['t-life','心里'],bili:['t-life','刷B站'],normalize:['t-norm','修正'],warn:['t-warn','警告'],invalid:['t-err','作废'],followup:['t-think','追问'],queued:['t-think','攒着'],debug_reply:['t-check','调试回复'],sysline:['t-think','系统代说']};
function fmtTime(ts){var d=new Date(ts),p=function(n){return String(n).padStart(2,'0')};return p(d.getHours())+':'+p(d.getMinutes())+':'+p(d.getSeconds())}
function esc(s){return String(s).replace(/[&<>]/g,function(c){return {'&':'&amp;','<':'&lt;','>':'&gt;'}[c]})}
function renderEvents(){
  var box=$('events');
  if(!evBuf.length){box.innerHTML='<div class="hint">还没有动静</div>';return}
  var arr=evBuf.slice(-40).reverse(), html='';
  for(var i=0;i<arr.length;i++){
    var e=arr[i], t=TAGS[e.type]||['t-skip',e.type];
    if(e.type==='out_msg' && e.meta && e.meta.followup) t=['t-think','追问'];
    var cls = e.type==='inner' ? ' inner' : '';
    html+='<div class="ev"><div class="t">'+fmtTime(e.ts)+'</div><div class="b'+cls+'"><span class="tag '+t[0]+'">'+t[1]+'</span>'+esc(e.text||'')+'</div></div>';
  }
  box.innerHTML=html;
  var last=evBuf[evBuf.length-1];
  if(last&&last.type==='think_start'){
    $('brainState').innerHTML='<span class="thinking"></span><span style="color:#ffc861">思考中…</span>';
  }else{
    $('brainState').innerHTML='<span class="badge">待命中</span>';
  }
}
function stampTick(){
  var pvr=$('pageVerRow'); if(pvr) pvr.textContent = document.body.dataset.ver || '';

  var el=$('lastTick'); if(el) el.textContent = new Date().toLocaleTimeString('zh-CN',{hour12:false});
}
function pollAll(){
  try{ pollEvents(); }catch(e){}
  try{ loadChat(); }catch(e){}
  try{ refresh(); }catch(e){}
  stampTick();
}
// 切回前台立刻拉一次（安卓后台会冻结定时器，这是页面"看着不动"的主因）
document.addEventListener('visibilitychange', function(){ if(!document.hidden) pollAll(); });
window.addEventListener('focus', pollAll);
function pollEvents(){
  api('/api/events?since='+lastTs).then(function(r){
    if(!r.events||!r.events.length)return;
    for(var i=0;i<r.events.length;i++){var e=r.events[i];evBuf.push(e);if(e.ts>lastTs)lastTs=e.ts}
    if(evBuf.length>200)evBuf=evBuf.slice(-200);
    renderEvents();
  }).catch(function(){});
}
function loadChat(){
  api('/api/status').then(function(d){
    var h=(d.state&&d.state.history)||[], last=h.slice(-14), html='';
    for(var i=0;i<last.length;i++){
      var m=last[i];
      var tag=viaLabel(m);
      html+='<div class="m '+(m.dir==='out'?'me':'you')+'"><span style="font-size:10px;opacity:.55;display:block;margin-bottom:2px">'+esc(tag)+'</span>'+esc(m.text)+'</div>';
    }
    $('chat').innerHTML=html||'<div class="hint">还没聊过</div>';
    $('chatHint').textContent=h.length?('共 '+h.length+' 条'):'';
    var sh=$('sourceHint'); if(sh){ var qq=0,web=0; for(var j=0;j<h.length;j++){ if(h[j].via==='selfim') web++; else qq++; } sh.textContent='QQ '+qq+' · 自建IM '+web; }
  }).catch(function(){});
}
function loadLife(){
  api('/api/life').then(function(d){
    $('docSelf').textContent=d.self||'(空)';
    $('docRules').textContent=d.rules||'(还没定)';
    $('docMem').textContent=d.memory||'(空)';
    $('docJournal').textContent=(d.journal&&d.journal[0])?d.journal[0].content:'(今天还没写)';
  }).catch(function(){});
}
pollEvents();loadChat();loadLife();
setInterval(pollEvents,2500);setInterval(loadChat,8000);setInterval(loadLife,60000);setInterval(stampTick,2000);
refreshQRIfStale();
function refreshQRIfStale(){}
const PAGE_VERSION = '2026-10-30 11:50 时间窗口独立文件';
const pv = $('pageVer'); if (pv) pv.textContent = PAGE_VERSION;
setInterval(refresh,4000);refresh();
setInterval(()=>{const a=$('qrage').textContent;},10000);
</script></body></html>`;

const server = http.createServer(async (req, res) => {
  const u = new URL(req.url, 'http://x');
  const p = u.pathname;
  try {
    if (p === '/' ) {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store, no-cache, must-revalidate', Pragma: 'no-cache', Expires: '0' });
      return res.end(PAGE.replaceAll('__INSTANCE_NAME__', instanceName()));
    }
      if (p === '/api/channel/check') {
      try {
        const c = readCfg();
        const h = { 'Content-Type': 'application/json', Authorization: 'Bearer ' + ((c.napcat || {}).token || '') };
        const post = (a, b = {}) => fetch(`${(c.napcat || {}).baseUrl}/` + a, { method: 'POST', headers: h, body: JSON.stringify(b), signal: AbortSignal.timeout(8000) }).then((r) => r.json());
        const s1 = await post('get_status');
        await new Promise((r) => setTimeout(r, 3000));
        const s2 = await post('get_status');
        const p1 = Number(s1?.data?.stat?.packet_received || 0) + Number(s1?.data?.stat?.packet_sent || 0);
        const p2 = Number(s2?.data?.stat?.packet_received || 0) + Number(s2?.data?.stat?.packet_sent || 0);
        const moved = p2 > p1;
        const st = readState();
        st.napcatProbe = { at: Date.now(), p1, p2, moved };
        writeState(st);
        return json(res, { ok: true, moved, p1, p2, verdict: moved ? '数据包在动，通道活着' : '3 秒内数据包没动，可能已掉线' });
      } catch (e) { return json(res, { ok: false, message: e.message }); }
    }
    if (p === '/api/channel' && req.method === 'POST') {
        let b = ''; req.on('data', (c) => { b += c; });
        req.on('end', () => {
          let d = {}; try { d = JSON.parse(b); } catch {}
          const ch = d.channel === 'selfim' ? 'selfim' : 'qq';
          const st = readState(); st.channel = ch; writeState(st);
          try {                                   // 配置也要写，避免被并发覆盖
            const cfgPath = '__MIKU_ROOT__/bot/config.json';
            const c = JSON.parse(fs.readFileSync(cfgPath, 'utf8'));
            c.channels = { ...(c.channels || {}), active: ch };
            fs.writeFileSync(cfgPath, JSON.stringify(c, null, 2));
          } catch {}
          json(res, { ok: true, channel: ch });
        });
        return;
      }
    if (p === '/api/status') {
      const [proc, login] = await Promise.all([procList(), loginInfo()]);
      let mood = '';
      try { mood = fs.readFileSync('__MIKU_HOME__/mood.md', 'utf8'); } catch {}
      let vision = null;
      try {
        const { available } = await import('../src/services/vision.mjs');
        const vc = (readCfg().vision) || {};
        vision = { ok: available(), model: vc.model || '', enabled: !!vc.enabled, hasKey: !!vc.apiKey };
      } catch {}
      let debugTail = [];
      try {
        debugTail = fs.readFileSync('__MIKU_ROOT__/bot/debug-chat.jsonl', 'utf8')
          .split('\n').filter(Boolean).map((l) => JSON.parse(l)).slice(-8);
      } catch {}
      let herClock = null;
      try {
        const stc = JSON.parse(fs.readFileSync('__MIKU_ROOT__/bot/state.json', 'utf8'));
        herClock = {
          awakeIn: stc.nextWakeMinutes || 0,
          nextWakeAt: stc.nextWakeAt || 0,
          nextWakeBy: stc.nextWakeBy || '',
          speakInAt: stc.speakInAt || 0,
          followIn: (stc.lastOut && stc.lastOut.followIn) || 0,
          lastOutAt: (stc.lastOut && stc.lastOut.at) || 0,
        };
      } catch {}
      let nextWake = null;
      try {
        const stx = JSON.parse(fs.readFileSync('__MIKU_ROOT__/bot/state.json', 'utf8'));
        if (stx.nextWakeAt) nextWake = { at: stx.nextWakeAt, minutes: stx.nextWakeMinutes || 0, by: stx.nextWakeBy || '' };
      } catch {}
      let loginHealth = null;
      try {
        const o = JSON.parse(fs.readFileSync('__MIKU_ROOT__/bot/.online', 'utf8'));
        loginHealth = { online: !!o.online, state: o.state || 'unknown', badStreak: o.badStreak || 0, at: o.at };
      } catch {}
      let errs = [];
      try {
        const { readErrors } = await import('../src/utils/errlog.mjs');
        errs = readErrors(12).reverse();
      } catch {}
      let taste = { like: [], dislike: [], watch: [] };
      try {
        const tt = fs.readFileSync('__MIKU_HOME__/taste.md', 'utf8');
        const grab = (title) => {
          const m = tt.match(new RegExp('## ' + title + '([\\s\\S]*?)(?=\\n## |$)'));
          return m ? m[1].split('\n').filter((l) => l.trim().startsWith('- ')).map((l) => l.trim().slice(2)) : [];
        };
        taste = { like: grab('我喜欢'), dislike: grab('我不喜欢'), watch: grab('最近在意的') };
      } catch {}
      let ideas = [];
      try {
        const dir = '__MIKU_HOME__/ideas';
        const files = fs.readdirSync(dir).filter((f) => f.endsWith('.md')).sort().slice(-10).reverse();
        for (const f of files) {
          const txt = fs.readFileSync(path.join(dir, f), 'utf8');
          const body = txt.split('\n').filter((l) => l.trim() && !l.startsWith('#')).join(' ').trim();
          if (body) ideas.push({ file: f, at: f.replace('.md',''), text: body.slice(0, 120) });
        }
      } catch {}
      let frames = [];
      let framesEvicted = '';
      try {
        const ft = fs.readFileSync('__MIKU_HOME__/framework.md', 'utf8');
        const m = ft.match(/## 我自己想到的([\s\S]*?)(?=\n## |$)/);
        if (m) {
          frames = m[1].split('\n').filter((l) => /^- \[f\d+\]/.test(l.trim()))
            .map((l) => l.trim().replace(/^- /, ''));
        }
      } catch {}
      try {
        const ed = fs.readFileSync('__MIKU_HOME__/others-edits.md', 'utf8');
        const rows = ed.split('\n').filter((l) => l.includes('容量') || l.includes('frame_evicted'));
        framesEvicted = rows.slice(-1)[0] || '';
      } catch {}
      let wishes = [];
      try {
        const wt = fs.readFileSync('__MIKU_HOME__/wishes.md', 'utf8');
        wishes = wt.split('\n').filter((l) => /^\| w\d+ \|/.test(l)).map((l) => {
          const c = l.split('|').map((x) => x.trim());
          return { id: c[1], status: c[2], what: c[3], note: c[4] || '' };
        });
      } catch {}
      let goals = { doing: [], want: [], dropped: [] };
      try {
        const gt = fs.readFileSync('__MIKU_HOME__/goals.md', 'utf8');
        const sec = (name) => {
          const m = gt.match(new RegExp('## ' + name + '\\n([\\s\\S]*?)(?=\\n## |$)'));
          return (m ? m[1] : '').split('\n').map((x) => x.replace(/^-\s*/, '').trim()).filter(Boolean);
        };
        goals = { doing: sec('在做'), want: sec('想做，还没动'), dropped: sec('放下了') };
      } catch {}
      let clock = null;
      try {
        const { status } = await import('../src/utils/clock.mjs');
        clock = status();
      } catch {}
      let queuedCount = 0;
      try {
        queuedCount = fs.readFileSync('__MIKU_ROOT__/bot/retry_queue.jsonl', 'utf8').split('\n').filter(Boolean).length;
      } catch {}
      let tokensToday = null, tokensHour = null;
      try {
        const { execSync } = await import('node:child_process');
        const lines = fs.readFileSync('__MIKU_ROOT__/bot/usage.jsonl', 'utf8').split('\n').filter(Boolean);
        const today = new Date(); today.setHours(0, 0, 0, 0);
        let inTok = 0, outTok = 0, n = 0;
        for (const l of lines) {
          try {
            const r = JSON.parse(l);
            if (r.ts >= today.getTime()) { inTok += r.in || 0; outTok += r.out || 0; n++; }
          } catch {}
        }
        let hIn = 0, hOut = 0, hN = 0;
        const hourAgo = Date.now() - 3600e3;
        for (const l of lines) {
          try {
            const r = JSON.parse(l);
            if (r.ts >= hourAgo) { hIn += r.in || 0; hOut += r.out || 0; hN++; }
          } catch {}
        }
        tokensToday = { in: inTok, out: outTok, calls: n };
        tokensHour = { in: hIn, out: hOut, calls: hN };
      } catch {}
      let innerThoughts = [];
      try {
        const { readEvents } = await import('../src/utils/events.mjs');
        innerThoughts = readEvents(0, 400).filter((e) => e.type === 'inner').slice(-6);
      } catch {}
      let lifetime = null;
      try {
        let born = 0;
        try {
          const first = fs.readFileSync('__MIKU_HOME__/chat-archive.jsonl', 'utf8').split('\n').find(Boolean);
          born = JSON.parse(first).at || 0;
        } catch {}
        const st0 = readState();
        let started = Number(st0.stackStartedAt) || 0;
        if (!started || Date.now() - started > 7 * 24 * 3600e3) started = Date.now();
        const accum = Number(st0.lifetimeAccumMs) || 0;
        const lastTick = Number(st0.lifetimeLastTick) || 0;
        // 正在跑的这几十秒也算进去（还没落盘的零头）
        const live = lastTick ? Math.min(Date.now() - lastTick, 90e3) : 0;
        lifetime = { born, now: Date.now(), uptimeFrom: started, accumMs: accum + (live > 0 ? live : 0), liveMs: live };
      } catch {}
      return json(res, { lifetime, proc, login, qr: qrInfo(), state: readState(), channel: (((readCfg().channels || {}).active) || readState().channel || 'qq'), cfg: (() => { const c = readCfg(); try { const w = JSON.parse(fs.readFileSync('__MIKU_ROOT__/bot/schedule.json','utf8')); if (w && w.activeStart) { c.schedule = { ...c.schedule, activeStart: w.activeStart, activeEnd: w.activeEnd }; } } catch {} return c; })(), mood, innerThoughts, tokensToday, tokensHour, queuedCount, goals, clock, wishes, debugTail, vision, frames, framesEvicted, taste, errs, loginHealth, nextWake, herClock, ideas });
    }
    if (p === '/api/events') {
      const since = Number(u.searchParams.get('since') || 0);
      const limit = Math.min(300, Number(u.searchParams.get('limit') || 120));
      const { readEvents } = await import('../src/utils/events.mjs');
      return json(res, { events: readEvents(since, limit) });
    }
    if (p === '/api/life') {
      const read = (f) => { try { return fs.readFileSync(f, 'utf8'); } catch { return ''; } };
      let journal = [];
      try {
        journal = fs.readdirSync('__MIKU_HOME__/journal')
          .filter((f) => f.endsWith('.md'))
          .sort().reverse().slice(0, 3)
          .map((f) => ({ name: f, content: read('__MIKU_HOME__/journal/' + f), mtime: fs.statSync('__MIKU_HOME__/journal/' + f).mtimeMs }));
      } catch {}
      let notes = [];
      try { notes = fs.readdirSync('__MIKU_HOME__/notes').filter((f) => f.endsWith('.md')).slice(0, 10); } catch {}
      return json(res, {
        self: read('__MIKU_HOME__/SELF.md'),
        rules: read('__MIKU_HOME__/rules.md'),
        memory: read('__MIKU_HOME__/memory.md'),
        journal, notes,
      });
    }
    if (p === '/api/debug/send' && req.method === 'POST') {
      const body = JSON.parse(await readBody(req));
      const text = String(body.text || '').slice(0, 500);
      if (!text) return json(res, { ok: false, message: '内容为空' });
      const uid = String((readCfg().target || {}).id || '');
      if (!uid) return json(res, { ok: false, message: '没有目标 QQ 号' });
      // 硬规则：这个入口只能"代发"。想以他本人身份说话，只有他本人在 QQ/网页里自己发。
      try {
        const r = await fetch('http://127.0.0.1:7789/', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            post_type: 'message', message_type: 'private',
            user_id: Number(uid), self_id: Number(readCfg().botUin || 0),
            message: [{ type: 'text', data: { text } }],
            _debug: true,
            _agent: true,
            origin: 'agent',
          }),
          signal: AbortSignal.timeout(8000),
        });
        if (!r.ok) return json(res, { ok: false, message: '入口没接住：' + r.status });
        return json(res, { ok: true, message: '已发送（标为：维护者·代发）' });
      } catch (e) { return json(res, { ok: false, message: '发送失败：' + e.message }); }
    }
    if (p === '/api/flush') {
      try {
        const r = await fetch('http://127.0.0.1:7789/flush', { method: 'POST', signal: AbortSignal.timeout(8000) });
        return json(res, { ok: r.ok, message: r.ok ? '已开始补发' : '回复服务没响应' });
      } catch (e) {
        return json(res, { ok: false, message: '补发失败：' + e.message });
      }
    }
    if (p === '/api/bili/qr') {
      try {
        const { generate } = await import('../src/services/bili_login.mjs');
        const g = await generate();
        return json(res, { ok: true, key: g.key, message: 'B 站二维码已生成' });
      } catch (e) { return json(res, { ok: false, message: '生成失败：' + e.message }); }
    }
    if (p === '/api/bili/png') {
      try {
        const buf = fs.readFileSync('__MIKU_ROOT__/bot/bili_qr.png');
        res.writeHead(200, { 'Content-Type': 'image/png', 'Cache-Control': 'no-store' });
        return res.end(buf);
      } catch { return json(res, { ok: false, message: '还没有二维码' }); }
    }
    if (p === '/api/bili/poll') {
      try {
        const { poll, loggedIn } = await import('../src/services/bili_login.mjs');
        const r2 = await poll();
        return json(res, { ...r2, logged: loggedIn() });
      } catch (e) { return json(res, { status: 'error', message: e.message }); }
    }
    if (p === '/api/bili/status') {
      try {
        const { check } = await import('../src/services/bili_login.mjs');
        const c = await check();
        return json(res, { ok: c.ok, logged: c.ok, uname: c.uname || null, reason: c.reason || null });
      } catch { return json(res, { ok: false, logged: false }); }
    }
    if (p === '/api/qr') {
      if (!fs.existsSync(QR_FILE)) { res.writeHead(404); return res.end('no qr'); }
      const buf = fs.readFileSync(QR_FILE);
      res.writeHead(200, { 'Content-Type': 'image/png', 'Cache-Control': 'no-store' });
      return res.end(buf);
    }
    if (p === '/api/qr/refresh') {
      const r = await sh('__MIKU_ROOT__/qr.sh', 120000);
      return json(res, { ok: r.ok, message: r.ok ? '新二维码已生成，去相册选最新那张' : '生成失败：' + r.stderr.slice(0, 120) });
    }
    if (p === '/api/qr/save') {
      const r = await sh(`cp -f ${NAPCAT_DIR}/qrcode_big.png /sdcard/Download/qq_login_qrcode_big.png 2>/dev/null || cp -f ${NAPCAT_DIR}/qrcode.png /sdcard/Download/qq_login_qrcode.png`, 20000);
      return json(res, { ok: r.ok, message: r.ok ? '已存到 Download/qq_login_qrcode_big.png' : '保存失败' });
    }
    if (p === '/api/brain' && req.method === 'POST') {
      const cfg = readCfg();
      // agent 模式已经不再接线：只有 mind.mjs 这一条调用路径
      return json(res, { ok: false, message: '大脑模式已停用：现在只有一种大脑（mind.mjs 单次调用），没有可切换的第二条路径' });
    }
    if (p === '/api/login') {
      // 先看是不是已经在线
      const before = await loginInfo();
      if (before.ok) {
        return json(res, { ok: true, message: '已经是登录状态：' + before.nickname + '，不用再确认' });
      }
      // 用已保存的会话试一次快速登录
      await sh('__MIKU_ROOT__/start_napcat.sh', 120000);
      await new Promise((z) => setTimeout(z, 8000));
      const li = await loginInfo();
      if (li.ok) return json(res, { ok: true, message: '已登录：' + li.nickname });
      // 快速登录失败 = 会话票据失效，只能扫码；顺手生成新码
      let qrMsg = '';
      try {
        const q = await sh('__MIKU_ROOT__/qr.sh', 150000);
        qrMsg = q.ok ? '，已生成新的二维码' : '，二维码生成失败';
      } catch {}
      return json(res, {
        ok: false, needQR: true,
        message: '手机推送没用了：这个号的登录票据已经失效，腾讯不会推确认。请扫码' + qrMsg,
      });
    }
    if (p === '/api/start') {
      const r = await sh('__MIKU_ROOT__/start_all.sh', 180000);
      return json(res, { ok: r.ok, message: r.ok ? '已启动，稍等十几秒' : '启动失败' });
    }
    if (p === '/api/stop') {
      // 用统一脚本：六个进程全停（之前漏了 service/life/panel）
      sh('__MIKU_ROOT__/stop_all.sh', 30000).catch(() => {});
      return json(res, { ok: true, message: '正在全部停止…' });
    }
    if (p === '/api/restart') {
      await sh('pkill -f "supervisor.s[h]"; pkill -f "bot.mjs daemo[n]"; pkill -f "napcat_loade[r]"', 30000);
      await new Promise((r) => setTimeout(r, 3000));
      const r2 = await sh('__MIKU_ROOT__/start_all.sh', 180000);
      return json(res, { ok: r2.ok, message: '已重启' });
    }
            if (p === '/api/config' && req.method === 'POST') {
      const body = JSON.parse(await readBody(req));
      const cfg = readCfg();
      if (body.id) { cfg.target = { mode: 'fixed', type: 'private', id: String(body.id) }; }
      if (Number.isFinite(body.idleMinutes)) cfg.schedule.idleMinutes = body.idleMinutes;
      if (Number.isFinite(body.followUpMinutes)) cfg.schedule.followUpMinutes = body.followUpMinutes;
      if (Number.isFinite(body.dailyMax)) cfg.schedule.dailyMax = body.dailyMax;
      if (Number.isFinite(body.lifeDay)) { cfg.life = cfg.life || {}; cfg.life.dayIntervalMinutes = Math.max(5, body.lifeDay); }
      const okHM = (v) => typeof v === 'string' && /^([01]?\d|2[0-3]):[0-5]\d$/.test(v.trim());
      const normHM = (v) => { const m = v.trim().match(/^(\d{1,2}):(\d{2})$/); return m ? m[1].padStart(2, '0') + ':' + m[2] : v.trim(); };
      const before = { start: cfg.schedule.activeStart, end: cfg.schedule.activeEnd };
      const rejected = [];
      if (okHM(body.activeStart)) cfg.schedule.activeStart = normHM(body.activeStart);
      else rejected.push('从（格式不对，没保存）');
      if (okHM(body.activeEnd)) cfg.schedule.activeEnd = normHM(body.activeEnd);
      else rejected.push('到（格式不对，没保存）');

      cfg.impulse = cfg.impulse || {};
      cfg.reply = cfg.reply || {};
      if (Number.isFinite(body.impulseThreshold)) cfg.impulse.threshold = body.impulseThreshold;
      if (Number.isFinite(body.heartMinutes)) cfg.impulse.heartMinutes = body.heartMinutes;
      if (Number.isFinite(body.stashPct)) cfg.impulse.stashChance = body.stashPct / 100;
      if (Number.isFinite(body.skipPct)) cfg.reply.skipChance = body.skipPct / 100;
      if (Number.isFinite(body.memePct)) cfg.reply.memeChance = body.memePct / 100;
      if (typeof body.memeOn === 'boolean') cfg.reply.memeEnabled = body.memeOn;
      cfg.reply.followUp = cfg.reply.followUp || {chance:0.55, maxMinutes:9};
      if (typeof body.fuOn === 'boolean') cfg.reply.followUp.enabled = body.fuOn;
      if (Number.isFinite(body.fuMin)) cfg.reply.followUp.minMinutes = body.fuMin;
      // 值没变就别写：挡住页面反复自动保存造成的抖动与日志刷屏
      const changed = (before.start !== cfg.schedule.activeStart) || (before.end !== cfg.schedule.activeEnd)
        || JSON.stringify(readCfg()) !== JSON.stringify(cfg);
      // 时间窗口：写独立文件 bot/schedule.json（config.json 会被别的进程整文件重写）
      if (changed) {
        try {
          fs.writeFileSync('__MIKU_ROOT__/bot/schedule.json',
            JSON.stringify({ activeStart: cfg.schedule.activeStart, activeEnd: cfg.schedule.activeEnd }, null, 2));
        } catch {}
      }
      if (changed) {
        try {
          fs.appendFileSync('__MIKU_ROOT__/bot/config-changes.log',
            `[${new Date().toISOString()}] 活跃时段 ${before.start}–${before.end} → ${cfg.schedule.activeStart}–${cfg.schedule.activeEnd}\n`);
        } catch {}
      }
      if (!changed) {
        return json(res, { ok: true, message: '值没有变化（未写入）',
          savedSchedule: { activeStart: cfg.schedule.activeStart, activeEnd: cfg.schedule.activeEnd }, rejected: [] });
      }
      writeCfg(cfg);
      return json(res, {
        ok: true,
        message: rejected.length ? ('部分没保存：' + rejected.join('、')) : '已保存',
        savedSchedule: { activeStart: cfg.schedule.activeStart, activeEnd: cfg.schedule.activeEnd },
        rejected,
      });
    }
    res.writeHead(404); res.end('not found');
  } catch (e) {
    json(res, { ok: false, message: String(e.message || e) }, 500);
  }
});

function readBody(req) {
  return new Promise((resolve) => {
    let d = '';
    req.on('data', (c) => { d += c; if (d.length > 1e6) req.destroy(); });
    req.on('end', () => resolve(d || '{}'));
  });
}

server.listen(PORT, '0.0.0.0', async () => {
  console.log('控制台已启动: http://127.0.0.1:' + PORT);
  // 启动时自检页面脚本，语法错了要当场喊出来（否则整页静默不工作）
  try {
    const { execFileSync } = await import('node:child_process');
    execFileSync(process.execPath, ['__MIKU_ROOT__/panel/check-page.mjs'], { stdio: 'pipe' });
    console.log('页面脚本自检：OK');
  } catch (e) {
    console.log('⚠ 页面脚本语法错误，浏览器里会全部显示为 —');
    console.log(String(e.stdout || '') + String(e.stderr || '').slice(0, 300));
  }
});
