// 通道协议 v1 的「你方」实现（桥接进程）
// 一个进程同时扮演两个角色：
//   · 对核心：提供 /api/v1/send、/api/v1/health、/api/v1/media、/api/v1/history
//   · 对 IM  ：接收 webhook，签名后转发到核心的 /inbound
//
// 启动（对接真实 VoceChat）：
//   IM_BASE=https://im.example.com IM_API_KEY=xxxx SELFIM_TOKEN=yyyy IM_SECRET=zzzz \
//   CORE_INBOUND=http://127.0.0.1:7789/inbound node bridge.mjs
//
// 所有配置都走环境变量，变量表见同目录 README.md。

import http from 'node:http';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createVoceChatDriver } from './driver-vocechat.mjs';

// ---------------- 配置 ----------------
const ENV = process.env;
const PORT = Number(ENV.BRIDGE_PORT || 7791);
const IM_BASE = ENV.IM_BASE || 'http://127.0.0.1:3000';
const IM_API_KEY = ENV.IM_API_KEY || '';
const IM_BOT_UID = ENV.IM_BOT_UID || null;
const SELFIM_TOKEN = ENV.SELFIM_TOKEN || '';        // 核心调我们时用的 Bearer
const IM_SECRET = ENV.IM_SECRET || '';              // 我们调核心时用的 HMAC 密钥
const CORE_INBOUND = ENV.CORE_INBOUND || 'http://127.0.0.1:7789/inbound';
const CORE_TOKEN = ENV.CORE_TOKEN || '';            // 核心侧的 Bearer（可选）
const DATA_DIR = ENV.DATA_DIR || new URL('./data', import.meta.url).pathname;
const SEEN_LIMIT = 5000;

fs.mkdirSync(DATA_DIR, { recursive: true });

const im = createVoceChatDriver({ baseUrl: IM_BASE, apiKey: IM_API_KEY, botUid: IM_BOT_UID });

// ---------------- 小工具 ----------------
const log = (...a) => console.log(new Date().toISOString(), ...a);

function sign(msgId, senderId, origin, ts) {
  // 协议 §6：msgId \n senderId \n origin \n ts
  return 'hmac-sha256=' + crypto
    .createHmac('sha256', IM_SECRET)
    .update([msgId, senderId, origin, ts].join('\n'))
    .digest('hex');
}

function json(res, code, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(code, { 'content-type': 'application/json; charset=utf-8', 'content-length': Buffer.byteLength(body) });
  res.end(body);
}

function readBody(req, limit = 6 * 1024 * 1024) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (c) => {
      size += c.length;
      if (size > limit) { reject(new Error('body too large')); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

function authed(req) {
  if (!SELFIM_TOKEN) return true;                       // 没配就不校验（只建议内网这么跑）
  const h = req.headers.authorization || '';
  return h === `Bearer ${SELFIM_TOKEN}`;
}

/** "user-123" → "123"；协议里 senderId 是 IM 的用户 ID */
const toImUid = (to) => String(to).replace(/^user-/, '');

// ---------------- 去重账本（协议 §3：同一个 clientMsgId 只能发一条） ----------------
const seen = new Set();
const seenFile = path.join(DATA_DIR, 'seen-client-msg-ids.log');
try {
  for (const line of fs.readFileSync(seenFile, 'utf8').split('\n')) if (line) seen.add(line);
} catch {}

function markSeen(id) {
  if (seen.has(id)) return false;
  seen.add(id);
  fs.appendFile(seenFile, id + '\n', () => {});
  if (seen.size > SEEN_LIMIT) {
    const keep = [...seen].slice(-SEEN_LIMIT);
    seen.clear(); keep.forEach((x) => seen.add(x));
    fs.writeFileSync(seenFile, keep.join('\n') + '\n');
  }
  return true;
}

// ---------------- 健康状态（协议 §4：lastSendOkAt 必须有意义） ----------------
let lastSendOkAt = 0;
let lastSendErr = '';

async function healthSnapshot() {
  let online = false;
  let note = '';
  try {
    const h = await im.health();
    online = !!h.online;
  } catch (e) {
    online = false;
    note = 'IM 探活失败: ' + e.message.slice(0, 120);
  }
  if (!online) note ||= 'IM 不可达';
  else if (lastSendOkAt && Date.now() - lastSendOkAt > 15 * 60 * 1000) note = '15 分钟没有发成功过，可能是假在线';
  return {
    ok: true,
    online,
    queued: 0,                     // 补发队列在核心侧（BaseAdapter.flush），我们这里不攒
    lastSendOkAt: lastSendOkAt || null,
    note,
  };
}

// ---------------- 图片尺寸（只为满足协议 §3 的 w/h 字段） ----------------
function imageSize(buf) {
  try {
    if (buf.length > 24 && buf.readUInt32BE(0) === 0x89504e47) {
      return { w: buf.readUInt32BE(16), h: buf.readUInt32BE(20) };
    }
    if (buf[0] === 0xff && buf[1] === 0xd8) {
      let i = 2;
      while (i < buf.length - 9) {
        if (buf[i] !== 0xff) { i++; continue; }
        const m = buf[i + 1];
        const len = buf.readUInt16BE(i + 2);
        if (m >= 0xc0 && m <= 0xcf && m !== 0xc4 && m !== 0xc8 && m !== 0xcc) {
          return { h: buf.readUInt16BE(i + 5), w: buf.readUInt16BE(i + 7) };
        }
        i += 2 + len;
      }
    }
  } catch {}
  return { w: null, h: null };
}

/** 极简 multipart 解析：协议 §5 只有一个 file 字段，不值得为它引依赖 */
function parseMultipart(buf, contentType) {
  const m = /boundary=(?:"([^"]+)"|([^;]+))/i.exec(contentType || '');
  if (!m) throw new Error('不是 multipart 请求');
  const boundary = Buffer.from('--' + (m[1] || m[2]).trim());
  const parts = [];
  let pos = buf.indexOf(boundary);
  while (pos !== -1) {
    const start = pos + boundary.length;
    const next = buf.indexOf(boundary, start);
    if (next === -1) break;
    const part = buf.subarray(start + 2, next - 2);      // 跳过 \r\n 与尾随 \r\n
    const sep = part.indexOf('\r\n\r\n');
    if (sep !== -1) {
      const head = part.subarray(0, sep).toString('utf8');
      const body = part.subarray(sep + 4);
      const name = /name="([^"]*)"/i.exec(head)?.[1] || '';
      const filename = /filename="([^"]*)"/i.exec(head)?.[1] || 'upload.bin';
      const mime = /content-type:\s*([^\r\n]+)/i.exec(head)?.[1]?.trim() || 'application/octet-stream';
      parts.push({ name, filename, mime, body });
    }
    pos = next;
  }
  const file = parts.find((p) => p.name === 'file') || parts[0];
  if (!file || !file.body.length) throw new Error('multipart 里没有文件');
  return file;
}

// ---------------- 收消息：IM webhook → 核心 /inbound ----------------
async function forwardInbound(msg) {
  const ts = Date.now();                       // 用我们的时间，避免 IM 时钟偏差导致 §6 校验失败
  const payload = { ...msg, ts };
  const headers = {
    'content-type': 'application/json',
    'x-im-signature': sign(payload.msgId, payload.senderId, payload.origin, ts),
    'x-im-timestamp': String(ts),
    'x-im-nonce': crypto.randomBytes(4).toString('hex'),
  };
  if (CORE_TOKEN) headers.authorization = 'Bearer ' + CORE_TOKEN;
  if (process.env.IM_DEVICE_PIN) headers['x-im-device-pin'] = process.env.IM_DEVICE_PIN;   // 证明"他本人"的设备 PIN

  let lastErr;
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      const r = await fetch(CORE_INBOUND, {
        method: 'POST',
        headers,
        body: JSON.stringify(payload),
        signal: AbortSignal.timeout(10000),
      });
      const text = await r.text();
      if (r.ok) return { ok: true, status: r.status, text };
      // 4xx 是签名/时间戳这类硬错误，重试没意义
      if (r.status >= 400 && r.status < 500) return { ok: false, status: r.status, text, fatal: true };
      lastErr = new Error(`HTTP ${r.status} ${text.slice(0, 200)}`);
    } catch (e) {
      lastErr = e;
    }
    if (attempt < 3) await new Promise((r) => setTimeout(r, 500 * attempt));
  }
  return { ok: false, error: lastErr?.message || 'unknown' };
}

// ---------------- 主服务 ----------------
const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost');
  const p = url.pathname;

  try {
    // ---- 核心 → 我方 ----
    if (p === '/api/v1/health' && req.method === 'GET') {
      return json(res, 200, await healthSnapshot());
    }

    if (p === '/api/v1/send' && req.method === 'POST') {
      if (!authed(req)) return json(res, 401, { ok: false, code: 'UNAUTHORIZED', message: 'token 错' });
      const raw = await readBody(req);
      let d;
      try { d = JSON.parse(raw.toString('utf8')); } catch { return json(res, 400, { ok: false, code: 'BAD_JSON', message: '请求体不是 JSON' }); }

      const id = d.clientMsgId;
      if (!id) return json(res, 400, { ok: false, code: 'BAD_REQUEST', message: '缺 clientMsgId' });
      const uid = toImUid(d.to || '');
      if (!uid) return json(res, 400, { ok: false, code: 'BAD_REQUEST', message: '缺 to' });

      // 幂等：同一个 clientMsgId 第二次进来直接认，不再发
      if (!markSeen(id)) return json(res, 200, { ok: true, msgId: 'dup-' + id, ts: Date.now(), deduped: true });

      try {
        let out = {};
        if (d.kind === 'text') {
          out = await im.sendText(uid, String(d.payload?.text ?? ''));
        } else if (d.kind === 'image' || d.kind === 'meme') {
          // 核心给的是 url，IM 要的是已上传的 path：先下载再上传（协议 §5）
          const src = d.payload?.url;
          if (!src) throw new Error('image/meme 缺 payload.url');

          // 快路径：url 就在 IM 自己身上（核心先走了 /api/v1/media），直接把 path 交给 IM，不必再下载再上传
          const imOrigin = IM_BASE.replace(/\/+$/, '');
          if (src.startsWith(imOrigin + '/')) {
            out = await im.sendFile(uid, { path: src.slice(imOrigin.length).split('?')[0] });
            lastSendOkAt = Date.now();
            return json(res, 200, { ok: true, msgId: out.mid ?? out.msgId ?? 'vc-' + crypto.randomUUID(), ts: Date.now() });
          }

          const r = await fetch(src, { signal: AbortSignal.timeout(15000) });
          if (!r.ok) throw new Error('拉取图片失败 HTTP ' + r.status);
          const buf = Buffer.from(await r.arrayBuffer());
          if (buf.length > 5 * 1024 * 1024) {
            return json(res, 413, { ok: false, code: 'MEDIA_TOO_LARGE', message: '文件超过 5MB' });
          }
          const { path: imPath } = await im.upload(buf, 'img', r.headers.get('content-type') || 'image/jpeg');
          out = await im.sendFile(uid, { path: imPath });
        } else {
          return json(res, 400, { ok: false, code: 'BAD_REQUEST', message: '未知 kind: ' + d.kind });
        }
        lastSendOkAt = Date.now();
        lastSendErr = '';
        return json(res, 200, { ok: true, msgId: out.mid ?? out.msgId ?? 'vc-' + crypto.randomUUID(), ts: Date.now() });
      } catch (e) {
        lastSendErr = e.message;
        log('[send] 失败', e.message);
        const code = e.status === 429 ? 'RATE_LIMITED' : 'CHANNEL_DOWN';
        return json(res, 200, { ok: false, code, retryAfter: 30, message: e.message.slice(0, 200) });
      }
    }

    if (p === '/api/v1/media' && req.method === 'POST') {
      if (!authed(req)) return json(res, 401, { ok: false, code: 'UNAUTHORIZED', message: 'token 错' });
      const buf = await readBody(req);
      let f;
      try { f = parseMultipart(buf, req.headers['content-type']); } catch (e) {
        return json(res, 400, { ok: false, code: 'BAD_REQUEST', message: e.message });
      }
      if (f.body.length > 5 * 1024 * 1024) return json(res, 413, { ok: false, code: 'MEDIA_TOO_LARGE', message: '文件超过 5MB' });
      try {
        const { path: imPath } = await im.upload(f.body, f.filename || 'upload.bin', f.mime);
        const { w, h } = imageSize(f.body);
        const publicUrl = url.searchParams.get('token')
          ? im.fileUrl(imPath) + '?token=' + encodeURIComponent(url.searchParams.get('token'))
          : im.fileUrl(imPath);
        return json(res, 200, { ok: true, url: publicUrl, w, h });
      } catch (e) {
        return json(res, 502, { ok: false, code: 'UPLOAD_FAILED', message: e.message.slice(0, 200) });
      }
    }

    if (p === '/api/v1/history' && req.method === 'GET') {
      // 协议里标的是"可选：离线补拉"。VoceChat 这边要拿历史得用登录态 API，
      // 不值得为可选功能维护两套凭据，先返回空数组。
      return json(res, 200, { ok: true, messages: [], note: '未实现（协议 §1 标为可选）' });
    }

    // ---- IM → 我方（VoceChat 后台填的 webhook 地址） ----
    if (p === '/webhook/vocechat' && req.method === 'POST') {
      const raw = await readBody(req);
      let body;
      try { body = JSON.parse(raw.toString('utf8')); } catch { return json(res, 200, { ok: true, ignored: 'bad json' }); }

      const msg = im.parseInbound(body);
      if (!msg) return json(res, 200, { ok: true, ignored: true });

      const r = await forwardInbound(msg);
      if (!r.ok) log('[inbound] 转发失败', JSON.stringify(r).slice(0, 300));
      else log('[inbound]', msg.senderId, String(msg.text).slice(0, 40), '→', r.status);
      // 始终 200：webhook 报错会让 VoceChat 反复重投，失败已经在我们日志里
      return json(res, 200, { ok: true, forwarded: !!r.ok });
    }

    json(res, 404, { ok: false, code: 'NOT_FOUND', message: p });
  } catch (e) {
    log('[error]', e.message);
    json(res, 500, { ok: false, code: 'INTERNAL', message: e.message.slice(0, 200) });
  }
});

server.listen(PORT, '0.0.0.0', () => {
  log(`通道桥接已启动 :${PORT}`);
  log(`  IM      = ${IM_BASE} (${im.name})`);
  log(`  核心    = ${CORE_INBOUND}`);
  log(`  webhook = POST /webhook/vocechat`);
  log(`  自检    = GET  /api/v1/health`);
});

export { server, healthSnapshot, parseMultipart, imageSize, sign };
