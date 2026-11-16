#!/usr/bin/env node
// 假 IM：联调用。50 行服务 + 一个能打字的页面。
// 用法：
//   IM_SECRET=dev-secret IM_PORT=8080 CORE_INBOUND=http://127.0.0.1:7790/inbound node scripts/mock-im.mjs
// 打开 http://127.0.0.1:8080
import http from 'node:http';
import crypto from 'node:crypto';

const PORT = Number(process.env.IM_PORT || 8080);
const SECRET = process.env.IM_SECRET || 'dev-secret';
const CORE = process.env.CORE_INBOUND || 'http://127.0.0.1:7790/inbound';
const TOKEN = process.env.IM_TOKEN || 'dev-token';

const log = [];
let lastSendOkAt = 0;
let seq = 0;

function sign(msgId, senderId, origin, ts) {
  const s = [msgId, senderId, origin, ts].join('\n');
  return 'hmac-sha256=' + crypto.createHmac('sha256', SECRET).update(s).digest('hex');
}

const page = `<!doctype html><meta charset="utf-8"><title>假 IM · 联调</title>
<style>body{background:#111;color:#eee;font:15px system-ui;margin:0;padding:16px}
#log{border:1px solid #333;border-radius:10px;padding:12px;height:50vh;overflow:auto;margin-bottom:12px}
.me{color:#8fb4ff;margin:6px 0}.her{color:#5fd39a;margin:6px 0}.sys{color:#888;font-size:12px}
input{flex:1;padding:10px;background:#1a1a24;border:1px solid #333;color:#eee;border-radius:8px}
button{padding:10px 16px;background:#3b6ef0;border:0;color:#fff;border-radius:8px}
div.row{display:flex;gap:8px}</style>
<h3>假 IM（联调用）</h3>
<div id="log"></div>
<div class="row"><input id="t" placeholder="以他本人的身份发一句（会签名）"><button onclick="send()">发送</button></div>
<script>
async function refresh(){
  const r = await fetch('/_log').then(r=>r.json());
  document.getElementById('log').innerHTML = r.log.map(x=>'<div class="'+x.cls+'">'+x.text+'</div>').join('');
}
async function send(){
  const el=document.getElementById('t'); const t=el.value.trim(); if(!t) return; el.value='';
  const r = await fetch('/_chat',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({text:t})}).then(r=>r.json());
  refresh();
}
setInterval(refresh, 1500); refresh();
</script>`;

const server = http.createServer((req, res) => {
  const send = (code, obj) => { res.writeHead(code, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(obj)); };

  if (req.url === '/' ) {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    return res.end(page);
  }
  if (req.url === '/_log') return send(200, { log });

  if (req.url === '/api/v1/health') {
    return send(200, { ok: true, online: true, queued: 0, lastSendOkAt });
  }

  if (req.url === '/api/v1/send' && req.method === 'POST') {
    let b = '';
    req.on('data', (c) => { b += c; });
    req.on('end', () => {
      let d = {}; try { d = JSON.parse(b); } catch {}
      const text = d.payload?.text || d.payload?.url || '(空)';
      log.unshift({ cls: 'her', text: `[她 → 他] ${d.kind}: ${text}` });
      lastSendOkAt = Date.now();
      console.log('[send]', d.kind, text);
      send(200, { ok: true, msgId: 'mock-' + (++seq), ts: Date.now() });
    });
    return;
  }

  if (req.url === '/_chat' && req.method === 'POST') {
    let b = '';
    req.on('data', (c) => { b += c; });
    req.on('end', async () => {
      let d = {}; try { d = JSON.parse(b); } catch {}
      const msgId = crypto.randomUUID();
      const ts = Date.now();
      const body = JSON.stringify({ msgId, senderId: 'user-1', origin: 'user', text: String(d.text || ''), images: [], ts, replyTo: null });
      log.unshift({ cls: 'me', text: `[他 → 她] ${d.text}` });
      try {
        const r = await fetch(CORE, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Authorization': 'Bearer ' + TOKEN,
            'X-IM-Signature': sign(msgId, 'user-1', 'user', ts),
            'X-IM-Timestamp': String(ts),
            'X-IM-Nonce': crypto.randomBytes(4).toString('hex'),
          },
          body,
          signal: AbortSignal.timeout(8000),
        });
        log.unshift({ cls: 'sys', text: '→ 核心返回 ' + r.status });
      } catch (e) {
        log.unshift({ cls: 'sys', text: '→ 核心没接住：' + e.message + '（正常：/inbound 还没实现）' });
      }
      send(200, { ok: true });
    });
    return;
  }

  send(404, { ok: false, code: 'NOT_FOUND' });
});

server.listen(PORT, '127.0.0.1', () => {
  console.log(`假 IM 在 http://127.0.0.1:${PORT}`);
  console.log(`把消息转给：${CORE}`);
  console.log(`共享密钥：${SECRET}（联调用，别用在真部署）`);
});
