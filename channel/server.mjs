// SPDX-License-Identifier: AGPL-3.0-or-later
// 双人通道：只有四个动作——下行推送、上行发送、增量拉历史、已读回执。
// 没有账号、没有群、没有好友、没有多端同步。存储就是 append-only 的 messages.jsonl。
// 和 service 分开跑（7790），通道崩了历史还在，她的进程不受影响。
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

const ROOT = process.env.QQBOT_ROOT || process.cwd();
const DATA = process.env.CHANNEL_DATA || '/var/lib/digitallife-channel';
const PORT = Number(process.env.CHANNEL_PORT || 7790);
const HOST = process.env.CHANNEL_HOST || '0.0.0.0';
const TOKEN = process.env.CHANNEL_TOKEN || '';
const SERVICE = process.env.SERVICE_URL || 'http://127.0.0.1:7789';
const SECRET = process.env.SELFIM_SECRET || '';
const DEVICE_PIN = process.env.CHANNEL_PIN || '';

fs.mkdirSync(DATA, { recursive: true });
const MSG = path.join(DATA, 'messages.jsonl');
const READ = path.join(DATA, 'read.json');
const MEDIA = path.join(DATA, 'media');
fs.mkdirSync(MEDIA, { recursive: true });

// —— 存储：只追加
let cache = [];
function load() {
  try {
    cache = fs.readFileSync(MSG, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
  } catch { cache = []; }
}
load();
let seq = cache.length ? cache[cache.length - 1].id : 0;

// 去重：优先用来源消息 id（QQ msg_id / VoceChat mid / clientMsgId），没有 id 才退回文本比对
const seenIds = new Map();   // srcId -> id
function isDupById(srcId) {
  if (!srcId) return null;
  const id = seenIds.get(String(srcId));
  if (!id) return null;
  return cache.find((m) => m.id === id) || null;
}

// 兜底：3 秒内同方向同文本（没有来源 id 的多链路镜像）
function isDup(dir, text) {
  const now = Date.now();
  for (let i = cache.length - 1; i >= 0 && i > cache.length - 12; i--) {
    const m = cache[i];
    if (now - m.at > 3000) break;
    if (m.dir === dir && String(m.text) === String(text)) return m;
  }
  return null;
}

function append(rec) {
  const bySrc = isDupById(rec.srcId);
  if (bySrc) return bySrc;
  const dup = isDup(rec.dir, rec.text);
  if (dup) { if (rec.srcId) seenIds.set(String(rec.srcId), dup.id); return dup; }
  seq += 1;
  const item = { id: seq, at: Date.now(), ...rec };
  fs.appendFileSync(MSG, JSON.stringify(item) + '\n');
  cache.push(item);
  if (item.srcId) seenIds.set(String(item.srcId), item.id);
  return item;
}
function readState() {
  try { return JSON.parse(fs.readFileSync(READ, 'utf8')); } catch { return { lastRead: 0 }; }
}
function writeRead(v) {
  fs.writeFileSync(READ, JSON.stringify({ lastRead: v, at: Date.now() }));
}

// —— 上行：转给 service 的 /inbound（带 HMAC，和她现有的验签一致）
function sign(msgId, senderId, origin, ts) {
  return crypto.createHmac('sha256', SECRET).update([msgId, senderId, origin, ts].join('\n')).digest('hex');
}
async function forward(text, origin = 'user', images = []) {
  const msgId = 'c' + seq;
  const ts = Date.now();
  const headers = {
    'Content-Type': 'application/json',
    'X-IM-Signature': 'hmac-sha256=' + sign(msgId, 'user-1', origin, ts),
    'X-IM-Timestamp': String(ts),
  };
  if (origin === 'user' && DEVICE_PIN) headers['X-IM-Device-Pin'] = DEVICE_PIN;
  const r = await fetch(`${SERVICE}/inbound`, {
    method: 'POST', headers,
    body: JSON.stringify({ msgId, senderId: 'user-1', origin, text, ts, images: images.map((x) => ({ path: x.path })) }),
    signal: AbortSignal.timeout(15000),
  });
  return r.ok;
}

// —— 下行：bot 调这个把她的话推进来
function push({ text, images = [], mid }) {
  images = (images || []).map((x) => {
    const raw = typeof x === 'string' ? x : (x && (x.url || x.path)) || '';
    if (!raw) return null;
    if (raw.startsWith('/media/')) return { name: path.basename(raw), path: path.join(MEDIA, path.basename(raw)) };
    if (raw.startsWith('/')) return { name: path.basename(raw), path: raw };
    return null;
  }).filter(Boolean);
  const item = append({ dir: 'out', text: String(text || ''), images, mid: mid || null });
  broadcast(item);
  return item;
}

// —— SSE：客户端只保持一条长连接
const clients = new Set();
function broadcast(item) {
  const payload = `event: message\ndata: ${JSON.stringify(item)}\n\n`;
  for (const res of clients) { try { res.write(payload); } catch {} }
}

function json(res, obj, code = 200) {
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(obj));
}

const server = http.createServer(async (req, res) => {
 try {
  const u = new URL(req.url, 'http://x');
  const p = u.pathname;
  const token = req.headers['x-channel-token'] || u.searchParams.get('token')
    || String(req.headers.authorization || '').replace(/^Bearer\s+/i, '');
  const authOk = !TOKEN || token === TOKEN;

  // 页面不需要 token（本机/内网用），API 需要
  if (p === '/' || p === '/index.html') {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
    return res.end(WEB.replace('__TOKEN__', TOKEN));
  }

  if (!authOk) return json(res, { ok: false, message: 'token 不对' }, 401);

  // 增量拉历史：?since=<id>
  if (p === '/history') {
    const since = Number(u.searchParams.get('since') || 0);
    const limit = Math.min(500, Math.max(1, Number(u.searchParams.get('limit') || 200)));
    const rest = cache.filter((m) => m.id > since);
    const page = rest.slice(0, limit);
    return json(res, {
      ok: true, messages: page, hasMore: rest.length > page.length, lastRead: readState().lastRead,
    });
  }

  // 已读回执
  if (p === '/read' && req.method === 'POST') {
    let b = ''; req.on('data', (c) => (b += c));
    req.on('end', () => { try { writeRead(Number(JSON.parse(b).id || 0)); } catch {} json(res, { ok: true }); });
    return;
  }

  // 上传一张图：原始字节直接进来，存到 media/，返回相对路径
  if (p === '/upload' && req.method === 'POST') {
    const ext = (u.searchParams.get('ext') || 'jpg').replace(/[^a-z0-9]/gi, '').slice(0, 5) || 'jpg';
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      const buf = Buffer.concat(chunks);
      if (!buf.length) return json(res, { ok: false, message: '空文件' }, 400);
      if (buf.length > 12 * 1024 * 1024) return json(res, { ok: false, message: '图太大（>12MB）' }, 413);
      const d = new Date();
      const bucket = `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, '0')}`;
      fs.mkdirSync(path.join(MEDIA, bucket), { recursive: true });
      const name = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}.${ext}`;
      const rel = bucket + '/' + name;
      fs.writeFileSync(path.join(MEDIA, rel), buf);
      return json(res, { ok: true, name: rel, path: path.join(MEDIA, rel), url: '/media/' + rel });
    });
    return;
  }

  // 取图
  if (p.startsWith('/media/')) {
    const rel = p.slice('/media/'.length).split('/').filter(Boolean).map((x) => path.basename(x)).join('/');
    const f = path.join(MEDIA, rel);
    if (!fs.existsSync(f)) return json(res, { ok: false, message: '没有这张图' }, 404);
    const type = /\.png$/i.test(rel) ? 'image/png'
      : /\.gif$/i.test(rel) ? 'image/gif'
      : /\.webp$/i.test(rel) ? 'image/webp'
      : 'image/jpeg';
    res.writeHead(200, { 'Content-Type': type, 'Cache-Control': 'max-age=86400' });
    return res.end(fs.readFileSync(f));
  }

  // 上行：他说的话
  if (p === '/send' && req.method === 'POST') {
    let b = ''; req.on('data', (c) => (b += c));
    req.on('end', async () => {
      let d = {}; try { d = JSON.parse(b); } catch {}
      const text = String(d.text || '').trim();
      const norm = (x) => {
        const raw = typeof x === 'string' ? x : (x && (x.path || x.url)) || '';
        if (!raw) return null;
        if (raw.startsWith('/media/')) return { path: path.join(MEDIA, path.basename(raw)), name: path.basename(raw) };
        return { path: raw, name: path.basename(raw) };
      };
      const images = (Array.isArray(d.images) ? d.images : []).map(norm).filter(Boolean);
      if (!text && !images.length) return json(res, { ok: false, message: '空消息' }, 400);
      const item = append({ dir: 'in', text, images });
      broadcast(item);
      let accepted = false;
      try { accepted = await forward(text, 'user', images); } catch {}
      return json(res, { ok: true, id: item.id, accepted });
    });
    return;
  }

  // 旁路镜像：别的通道（QQ / VoceChat）进出的消息也记一份，保持两边同一部历史
  if (p === '/mirror' && req.method === 'POST') {
    let b = ''; req.on('data', (c) => (b += c));
    req.on('end', () => {
      let d = {}; try { d = JSON.parse(b); } catch {}
      const text = String(d.text || '').trim();
      if (!text) return json(res, { ok: false, message: '空消息' }, 400);
      const dir = d.dir === 'out' ? 'out' : 'in';
      const item = append({ dir, text, at: Number(d.at) || Date.now(), mirror: true });
      broadcast(item);
      return json(res, { ok: true, id: item.id });
    });
    return;
  }

  // 下行：bot 把她的话推进来
  if (p === '/push' && req.method === 'POST') {
    let b = ''; req.on('data', (c) => (b += c));
    req.on('end', () => {
      let d = {}; try { d = JSON.parse(b); } catch {}
      const items = Array.isArray(d.items) ? d.items : [d];
      const out = items.filter((x) => x && (x.text || (x.images && x.images.length))).map((x) => push(x));
      return json(res, { ok: true, pushed: out.length, ids: out.map((x) => x.id) });
    });
    return;
  }

  // 长连接
  if (p === '/events') {
    res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive' });
    res.write(`event: hello\ndata: ${JSON.stringify({ lastId: seq })}\n\n`);
    clients.add(res);
    const ping = setInterval(() => { try { res.write(': ping\n\n'); } catch {} }, 25000);
    req.on('close', () => { clearInterval(ping); clients.delete(res); });
    return;
  }

  if (p === '/health') {
    let mediaCount = 0, mediaBytes = 0;
    try {
      const walk = (dir) => {
        for (const it of fs.readdirSync(dir, { withFileTypes: true })) {
          const fp = path.join(dir, it.name);
          if (it.isDirectory()) walk(fp);
          else { mediaCount++; try { mediaBytes += fs.statSync(fp).size; } catch {} }
        }
      };
      walk(MEDIA);
    } catch {}
    return json(res, {
      ok: true, messages: cache.length, lastId: seq, clients: clients.size,
      media: { count: mediaCount, mb: Math.round(mediaBytes / 1048576) },
    });
  }

  // —— 兼容 bot 现有 selfim 适配器的 /api/v1/*（这样她自己里也能直接发进来）
  if (p === '/api/v1/health') {
    return json(res, { ok: true, online: true, clientOnline: clients.size > 0, lastSendOkAt: Date.now() });
  }
  if (p === '/api/v1/send' && req.method === 'POST') {
    let b = ''; req.on('data', (c) => (b += c));
    req.on('end', () => {
      let d = {}; try { d = JSON.parse(b); } catch {}
      const text = String(
        d.text
        || (d.payload && d.payload.text)
        || (d.message && d.message.text)
        || ''
      ).trim();
      // 图片/表情包：adapter 传的是 payload.path（服务器本地路径）
      const imgPath = (d.payload && (d.payload.path || d.payload.file)) || '';
      if (!text && imgPath) {
        try {
          const buf = fs.readFileSync(imgPath);
          const dd = new Date();
          const bucket = `${dd.getFullYear()}${String(dd.getMonth() + 1).padStart(2, '0')}`;
          fs.mkdirSync(path.join(MEDIA, bucket), { recursive: true });
          const name = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}.${(path.extname(imgPath) || '.jpg').replace('.', '')}`;
          const rel = bucket + '/' + name;
          fs.writeFileSync(path.join(MEDIA, rel), buf);
          const it = push({ text: '', images: [{ name: rel, path: path.join(MEDIA, rel) }] });
          return json(res, { ok: true, id: it.id });
        } catch (e) {
          return json(res, { ok: false, message: '读不到这张图: ' + e.message }, 400);
        }
      }
      if (!text) return json(res, { ok: false, message: '空消息' }, 400);
      const it = push({ text, mid: d.mid || null });
      return json(res, { ok: true, id: it.id });
    });
    return;
  }
  return json(res, { ok: false, message: '没有这个接口' }, 404);
} catch (e) {
    try { if (!res.headersSent) { res.writeHead(500, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ ok: false, message: String(e && e.message || e) })); } } catch {}
  }
});

const WEB = `<!doctype html><html lang="zh"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">
<title>通道</title><style>
:root{--bg:#0c0d10;--ink:#eef0f4;--line:rgba(255,255,255,.14)}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--ink);font:15px/1.5 -apple-system,system-ui,"PingFang SC",sans-serif;display:flex;flex-direction:column;height:100dvh}
header{padding:10px 12px;border-bottom:1px solid var(--line);font:12px monospace;color:#9aa0aa;display:flex;justify-content:space-between}
#list{flex:1;overflow:auto;padding:12px;display:flex;flex-direction:column;gap:8px}
.m{max-width:80%;padding:8px 11px;border-radius:12px;font-size:14px;white-space:pre-wrap;word-break:break-word}
.in{align-self:flex-end;background:#fff500;color:#101110}
.out{align-self:flex-start;background:#181a18;border:1px solid var(--line)}
form{display:flex;gap:8px;padding:10px;border-top:1px solid var(--line)}
input{flex:1;background:#12141a;border:1px solid #2b2f3a;color:var(--ink);border-radius:10px;padding:11px;font:14px inherit}
button{background:#fff500;color:#101110;border:0;border-radius:10px;padding:11px 16px;font:600 14px inherit}
</style></head><body>
<header><span>双人通道</span><span id="st">连接中…</span></header>
<div id="list"></div>
<form id="f"><input id="t" placeholder="发给她…" autocomplete="off"><button>发送</button></form>
<script>
const TOKEN='__TOKEN__';const list=document.getElementById('list');const st=document.getElementById('st');
let lastId=0;
const h={ 'Content-Type':'application/json' };if(TOKEN)h['X-Channel-Token']=TOKEN;
function add(m){const d=document.createElement('div');d.className='m '+(m.dir==='in'?'in':'out');d.textContent=m.text;list.appendChild(d);list.scrollTop=list.scrollHeight;if(m.id>lastId)lastId=m.id;}
async function hist(){const r=await fetch('/history?since='+lastId,{headers:h});const j=await r.json();(j.messages||[]).forEach(add);st.textContent='已同步 '+lastId;}
function events(){const es=new EventSource('/events'+(TOKEN?'?token='+TOKEN:''));es.addEventListener('message',e=>{try{add(JSON.parse(e.data))}catch{}});es.addEventListener('hello',()=>{st.textContent='在线'});es.onerror=()=>{st.textContent='断开，重连中…'};}
document.getElementById('f').onsubmit=async(e)=>{e.preventDefault();const t=document.getElementById('t');const v=t.value.trim();if(!v)return;t.value='';
 await fetch('/send',{method:'POST',headers:h,body:JSON.stringify({text:v})});};
hist();events();
</script></body></html>`;

server.listen(PORT, HOST, () => {
  console.log(`双人通道已启动: http://${HOST}:${PORT}  数据: ${DATA}  消息数: ${cache.length}`);
});
