// 通道协议 v1 的「你方」实现 —— 普通账号版
// 对核心提供 /api/v1/send /api/v1/health /api/v1/media；对 IM 用轮询收消息。
import http from 'node:http';
import crypto from 'node:crypto';
import fs from 'node:fs';
import { createUserDriver } from './driver-vocechat-user.mjs';
import { assertNotOwnerLogin, assertHerAccount, assertNotOwnerUid } from '../../src/utils/impersonation-guard.mjs';

const ENV = process.env;
const PORT = Number(ENV.BRIDGE_PORT || 7791);
const SELFIM_TOKEN = ENV.SELFIM_TOKEN || '';
const IM_SECRET = ENV.IM_SECRET || '';
const CORE_INBOUND = ENV.CORE_INBOUND || 'http://127.0.0.1:7789/inbound';
const DEVICE_PIN = ENV.IM_DEVICE_PIN || '';
const DATA_DIR = ENV.DATA_DIR || '__MIKU_ROOT__/tools/bridge/data';
fs.mkdirSync(DATA_DIR, { recursive: true });
const SEEN = DATA_DIR + '/seen-mid.log';
const seen = new Set();
try { for (const l of fs.readFileSync(SEEN, 'utf8').split('\n')) if (l.trim()) seen.add(l.trim()); } catch {}

const log = (...a) => console.log(new Date().toISOString(), ...a);

// 硬规则：桥接只允许以她自己的账号登录；用他的账号一律拒绝启动
assertHerAccount(ENV.IM_EMAIL);
assertNotOwnerLogin(ENV.IM_EMAIL);

const im = createUserDriver({
  baseUrl: ENV.IM_BASE || 'http://127.0.0.1:3000',
  email: ENV.IM_EMAIL,
  password: ENV.IM_PASSWORD,
  peerUid: ENV.IM_PEER_UID || 1,
  device: 'miku-core',
});

let lastSendOkAt = null;
let online = false;
let lastPollOkAt = null;

function sign(msgId, senderId, origin, ts) {
  return 'hmac-sha256=' + crypto.createHmac('sha256', IM_SECRET).update([msgId, senderId, origin, ts].join('\n')).digest('hex');
}

async function forwardInbound(msg) {
  const ts = Date.now();
  const payload = { ...msg, ts };
  const r = await fetch(CORE_INBOUND, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-im-signature': sign(payload.msgId, payload.senderId, payload.origin, ts),
      'x-im-timestamp': String(ts),
      ...(DEVICE_PIN ? { 'x-im-device-pin': DEVICE_PIN } : {}),
    },
    body: JSON.stringify(payload),
    signal: AbortSignal.timeout(10000),
  });
  return { ok: r.ok, status: r.status };
}

// ---- 轮询收消息 ----
let lastMid = 0;
let clientAt = 0;   // 手机客户端最后一次报“我还在”的时间
let clientMid = 0;  // 它最后读到的消息号
async function pollOnce() {
  try {
    const list = await im.history(lastMid, 20);
    online = true;
    lastPollOkAt = Date.now();
    for (const it of list || []) {
      const mid = Number(it.mid) || 0;
      if (mid && mid <= lastMid) continue;
      const msg = im.parseInbound(it);
      if (!msg) { if (mid) lastMid = Math.max(lastMid, mid); continue; }
      if (seen.has(msg.msgId)) { if (mid) lastMid = Math.max(lastMid, mid); continue; }
      // 图片：先下载到本地，再把路径给核心（核心能直接读本地图）
      if (msg.images && msg.images.length) {
        const saved = [];
        for (const it of msg.images) {
          try { saved.push({ path: (await im.downloadFile(it)).path }); }
          catch (e) { log('[image] 下载失败：' + e.message); }
        }
        msg.images = saved;
      }
      const r = await forwardInbound(msg);
      // 只有核心真的收下了，才记账、才推进游标；失败就下轮再试，绝不静默吞掉
      if (!r.ok) { log('[inbound] 核心没收下（' + r.status + '），下轮重试'); break; }
      seen.add(msg.msgId);
      try { fs.appendFileSync(SEEN, msg.msgId + '\n'); } catch {}
      if (mid) lastMid = Math.max(lastMid, mid);
      log('[inbound]', msg.senderId, String(msg.text).slice(0, 30), '→', r.status);
    }
  } catch (e) {
    online = false;
    log('[poll] 失败：' + e.message);
  }
}
setInterval(pollOnce, 1000);   // 1 秒一轮，配合 3 秒合并窗口
pollOnce();

// ---- 给核心的协议接口 ----
const server = http.createServer(async (req, res) => {
  const json = (c, o) => { const b = JSON.stringify(o); res.writeHead(c, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(b) }); res.end(b); };
  const p = (req.url || '').split('?')[0];

  if (p === '/api/v1/client-status' && req.method === 'POST') {
    // 用他的 VoceChat token 验明身份（不额外存密码）
    const tok = String(req.headers['x-api-key'] || '');
    let okAuth = false;
    try {
      const base = (process.env.IM_BASE || 'http://127.0.0.1:3000').replace(/\/$/, '');
      const r = await fetch(base + '/api/user/me', { headers: { 'x-api-key': tok }, signal: AbortSignal.timeout(6000) });
      okAuth = r.ok;
    } catch {}
    if (!okAuth) return json(401, { ok: false, code: 'UNAUTHORIZED' });
    let body = '';
    for await (const c of req) body += c;
    try {
      const d = JSON.parse(body || '{}');
      clientAt = Date.now();
      if (Number.isFinite(Number(d.mid))) clientMid = Number(d.mid);
      try {
        fs.writeFileSync('__MIKU_ROOT__/bot/client-presence.json',
          JSON.stringify({ at: clientAt, mid: clientMid }));
      } catch {}
    } catch {}
    return json(200, { ok: true });
  }

  if (p === '/api/v1/health') {
    const ok = await im.health();
    const clientOnline = clientAt > 0 && Date.now() - clientAt < 3 * 60 * 1000;
    return json(200, { ok: true, online: ok, queued: 0, lastSendOkAt, lastPollAt: lastPollOkAt,
                       clientOnline, clientLastAt: clientAt, clientMid });
  }

  if (p === '/api/v1/send' && req.method === 'POST') {
    if (SELFIM_TOKEN) {
      const auth = String(req.headers.authorization || '').replace(/^Bearer\s+/i, '');
      if (auth !== SELFIM_TOKEN) return json(401, { ok: false, code: 'UNAUTHORIZED', message: 'token 不对' });
    }
    let b = '';
    req.on('data', (c) => { b += c; });
    req.on('end', async () => {
      let d = {}; try { d = JSON.parse(b); } catch {}
      const text = d?.payload?.text;
      const imgPath = d?.payload?.path || d?.payload?.file;
      if (d.kind !== 'text' && imgPath) {
        try {
          const r = await im.sendImage(ENV.IM_PEER_UID || 1, imgPath);
          lastSendOkAt = Date.now();
          return json(200, { ok: true, msgId: r.mid, ts: lastSendOkAt });
        } catch (e) {
          return json(502, { ok: false, code: 'CHANNEL_DOWN', message: e.message });
        }
      }
      if (!text) return json(400, { ok: false, code: 'EMPTY', message: '没有文本' });
      try {
        const r = await im.sendText(ENV.IM_PEER_UID || 1, text);
        lastSendOkAt = Date.now();
        return json(200, { ok: true, msgId: r.mid, ts: lastSendOkAt });
      } catch (e) {
        return json(502, { ok: false, code: 'CHANNEL_DOWN', message: e.message });
      }
    });
    return;
  }

  json(404, { ok: false, code: 'NOT_FOUND', message: p });
});

server.listen(PORT, '0.0.0.0', () => {
  log(`她的通道桥接已启动 :${PORT}（普通账号轮询版）`);
  log(`  核心 = ${CORE_INBOUND}`);
});
