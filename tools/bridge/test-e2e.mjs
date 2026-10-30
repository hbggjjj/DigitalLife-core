// 自测：用一个假 VoceChat + 一个假核心，验证桥接是否满足协议 §10 的四项。
// 跑：node test-e2e.mjs
import http from 'node:http';
import crypto from 'node:crypto';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';

const IM_PORT = 18081, CORE_PORT = 18082, BRIDGE_PORT = 18091;
const SECRET = 'test-secret';
const TOKEN = 'test-token';
const IM = `http://127.0.0.1:${IM_PORT}`;
const results = [];

const ok = (name, cond, extra = '') => {
  results.push({ name, pass: !!cond, extra });
  console.log(`${cond ? '✅' : '❌'} ${name}${extra ? '  ' + extra : ''}`);
};

// ---------- 假 VoceChat ----------
const imReceived = [];
let imDown = false;
let uploadSeq = 0;
const imServer = http.createServer((req, res) => {
  const send = (c, o) => { res.writeHead(c, { 'content-type': 'application/json' }); res.end(JSON.stringify(o)); };
  if (imDown) return send(503, { error: 'down' });

  // 让 /f/xxx 真的能 GET（协议 §5 要求 url 可直连）
  const fm = /^\/f\/([\w.-]+)$/.exec(req.url);
  if (fm && req.method === 'GET') {
    const f = path.join(os.tmpdir(), 'fakevc-' + fm[1]);
    if (!fs.existsSync(f)) return send(404, { error: 'no file' });
    const buf = fs.readFileSync(f);
    res.writeHead(200, { 'content-type': 'application/octet-stream' });
    return res.end(buf);
  }

  if (req.url === '/api/bot' && req.method === 'GET') return send(200, { uid: 9, name: '她' });

  if (req.url === '/api/bot/file/upload' && req.method === 'POST') {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    return req.on('end', () => {
      uploadSeq++;
      const name = `f${uploadSeq}.bin`;
      fs.writeFileSync(path.join(os.tmpdir(), 'fakevc-' + name), Buffer.concat(chunks));
      imReceived.push({ type: 'upload', bytes: Buffer.concat(chunks).length });
      send(200, { path: `/f/${name}` });
    });
  }

  const m = /^\/api\/bot\/send_to_user\/(\d+)$/.exec(req.url);
  if (m && req.method === 'POST') {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    return req.on('end', () => {
      imReceived.push({ type: 'send', uid: m[1], ctype: req.headers['content-type'], body: Buffer.concat(chunks).toString('utf8') });
      send(200, { mid: 1000 + imReceived.length });
    });
  }
  send(404, { error: 'nope' });
});

// ---------- 假核心 ----------
const coreGot = [];
const coreSeen = new Set();
const coreServer = http.createServer((req, res) => {
  const send = (c, o) => { res.writeHead(c, { 'content-type': 'application/json' }); res.end(JSON.stringify(o)); };
  if (req.url === '/__messages') return send(200, { messages: coreGot });
  if (req.url !== '/inbound' || req.method !== 'POST') return send(404, {});

  const chunks = [];
  req.on('data', (c) => chunks.push(c));
  req.on('end', () => {
    const raw = Buffer.concat(chunks).toString('utf8');
    const d = JSON.parse(raw);
    const expect = 'hmac-sha256=' + crypto.createHmac('sha256', SECRET)
      .update([d.msgId, d.senderId, d.origin, d.ts].join('\n')).digest('hex');
    const sig = req.headers['x-im-signature'];
    if (sig !== expect) return send(401, { ok: false, code: 'SIGNATURE_INVALID', message: '签名校验失败' });
    if (Math.abs(Date.now() - Number(d.ts)) > 5 * 60 * 1000) return send(400, { ok: false, code: 'TIMESTAMP_SKEW' });
    if (coreSeen.has(d.msgId)) return send(200, { ok: true, accepted: 0, rejected: [], deduped: true });
    coreSeen.add(d.msgId);
    coreGot.push(d);
    send(200, { ok: true, accepted: 1, rejected: [] });
  });
});

// ---------- 启动 ----------
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'bridge-data-'));

await new Promise((r) => imServer.listen(IM_PORT, '127.0.0.1', r));
await new Promise((r) => coreServer.listen(CORE_PORT, '127.0.0.1', r));

const bridge = spawn(process.execPath, [fileURLToPath(new URL('./bridge.mjs', import.meta.url))], {
  env: {
    ...process.env,
    BRIDGE_PORT: String(BRIDGE_PORT),
    IM_BASE: IM, IM_API_KEY: 'k', IM_BOT_UID: '9',
    SELFIM_TOKEN: TOKEN, IM_SECRET: SECRET,
    CORE_INBOUND: `http://127.0.0.1:${CORE_PORT}/inbound`,
    DATA_DIR: dataDir,
  },
  stdio: ['ignore', 'pipe', 'pipe'],
});
let bridgeLog = '';
bridge.stdout.on('data', (c) => { bridgeLog += c; });
bridge.stderr.on('data', (c) => { bridgeLog += c; });
await wait(900);

const B = `http://127.0.0.1:${BRIDGE_PORT}`;
const postJSON = async (url, body, headers = {}) => {
  const r = await fetch(B + url, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(body) });
  return { status: r.status, data: await r.json().catch(() => null) };
};

try {
  // ① 她在 IM 里说一句 → 桥接签名转发 → 核心收到
  const vcEvent = {
    created_at: Date.now(), from_uid: 1, mid: 2978,
    target: { uid: 9 },
    detail: { content: '今天好累', content_type: 'text/plain', properties: null, type: 'normal' },
  };
  await postJSON('/webhook/vocechat', vcEvent);
  await wait(200);
  ok('① 入站消息送达核心（签名校验通过）', coreGot.length === 1 && coreGot[0].text === '今天好累', `msgId=${coreGot[0]?.msgId}`);
  ok('   幂等键来自 IM 的 mid', coreGot[0]?.msgId === 'vc-2978');

  // ①b webhook 重投同一条 → 核心按 msgId 幂等，不重复处理
  await postJSON('/webhook/vocechat', { ...vcEvent, created_at: Date.now() });
  await wait(200);
  ok('①b 重投不产生第二条消息', coreGot.length === 1, `核心共 ${coreGot.length} 条`);

  // ② 核心回话 → 桥接发到 IM
  const sendRes = await postJSON('/api/v1/send', {
    clientMsgId: 'c-001', to: 'user-1', kind: 'text', payload: { text: '那就睡吧。' }, ts: Date.now(),
  }, { authorization: 'Bearer ' + TOKEN });
  await wait(200);
  const lastSend = imReceived.filter((x) => x.type === 'send').at(-1);
  ok('② 出站文本到达 IM', sendRes.data?.ok && lastSend?.body === '那就睡吧。' && lastSend.uid === '1');
  ok('   响应带 msgId/ts', !!sendRes.data?.msgId && !!sendRes.data?.ts);

  // ③ 同一个 clientMsgId 再发一次 → 只能发一条
  const before = imReceived.filter((x) => x.type === 'send').length;
  await postJSON('/api/v1/send', {
    clientMsgId: 'c-001', to: 'user-1', kind: 'text', payload: { text: '那就睡吧。' }, ts: Date.now(),
  }, { authorization: 'Bearer ' + TOKEN });
  await wait(200);
  const after = imReceived.filter((x) => x.type === 'send').length;
  ok('③ clientMsgId 去重（重试不会重复发）', after === before, `${before} → ${after}`);

  // ④ 健康：正常时 online + lastSendOkAt
  const h1 = await (await fetch(B + '/api/v1/health')).json();
  ok('④ 健康检查 online 且 lastSendOkAt 有意义', h1.online === true && h1.lastSendOkAt > 0);

  // ⑤ IM 挂掉 → 健康报不通，发送返回 CHANNEL_DOWN
  imDown = true;
  const h2 = await (await fetch(B + '/api/v1/health')).json();
  const sendDown = await postJSON('/api/v1/send', {
    clientMsgId: 'c-002', to: 'user-1', kind: 'text', payload: { text: '在吗' }, ts: Date.now(),
  }, { authorization: 'Bearer ' + TOKEN });
  ok('⑤ IM 挂了：health.online=false', h2.online === false, h2.note || '');
  ok('   IM 挂了：send 返回 ok:false + CHANNEL_DOWN', sendDown.data?.ok === false && sendDown.data?.code === 'CHANNEL_DOWN');
  imDown = false;

  // ⑥ 错误签名必须被核心拒（协议 §6 的核心红线）
  const bad = await fetch(`http://127.0.0.1:${CORE_PORT}/inbound`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-im-signature': 'hmac-sha256=deadbeef' },
    body: JSON.stringify({ msgId: 'x-1', senderId: 'user-1', origin: 'user', text: 'hi', images: [], ts: Date.now() }),
  });
  ok('⑥ 错误签名被核心拒收', bad.status === 401);

  // ⑦ 媒体：multipart 上传 → 回 url
  const png = Buffer.from('89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c48900000000', 'hex');
  const form = new FormData();
  form.append('file', new Blob([png], { type: 'image/png' }), 'a.png');
  const up = await (await fetch(B + '/api/v1/media', { method: 'POST', headers: { authorization: 'Bearer ' + TOKEN }, body: form })).json();
  ok('⑦ 媒体上传返回可直连 url', up.ok === true && String(up.url).startsWith(IM), up.url);

  // ⑧ 核心侧 transport：OneBot 的 send_private_msg 原样走通
  const { createSelfimTransport } = await import(fileURLToPath(new URL('../core-patch/selfim-transport.mjs', import.meta.url)));
  const tx = createSelfimTransport({ baseUrl: B, token: TOKEN, secret: SECRET });
  const imgFile = path.join(os.tmpdir(), 't.png');
  fs.writeFileSync(imgFile, Buffer.from('89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c48900000000', 'hex'));
  const n0 = imReceived.filter((x) => x.type === 'send').length;
  await tx.send('send_private_msg', { user_id: 1, message: [{ type: 'text', data: { text: '核心侧适配' } }] });
  await tx.send('send_private_msg', { user_id: 1, message: [{ type: 'image', data: { file: 'file://' + imgFile } }] });
  const sends = imReceived.filter((x) => x.type === 'send').slice(n0);
  ok('⑧ OneBot 形状的文本/图片都转成了协议调用', sends.length === 2 && sends[1].ctype === 'vocechat/file', sends.map((s) => s.ctype).join(' | '));

  // ⑨ 核心侧验签：正确签名通过、篡改签名被拒、时间戳过期被拒
  const msg = { msgId: 'vc-9', senderId: 'user-1', origin: 'user', text: 'hi', images: [], ts: Date.now() };
  const goodSig = 'hmac-sha256=' + crypto.createHmac('sha256', SECRET)
    .update([msg.msgId, msg.senderId, msg.origin, msg.ts].join('\n')).digest('hex');
  const v1 = tx.verify(JSON.stringify(msg), { 'x-im-signature': goodSig });
  const v2 = tx.verify(JSON.stringify(msg), { 'x-im-signature': 'hmac-sha256=00' });
  const v3 = tx.verify(JSON.stringify({ ...msg, ts: Date.now() - 10 * 60 * 1000 }), { 'x-im-signature': goodSig });
  ok('⑨ 验签：对→通、错→SIGNATURE_INVALID、过期→TIMESTAMP_SKEW',
    v1.ok === true && v2.code === 'SIGNATURE_INVALID' && v3.code === 'TIMESTAMP_SKEW');
} catch (e) {
  console.error('测试异常：', e);
} finally {
  bridge.kill();
  imServer.close();
  coreServer.close();
  const pass = results.filter((r) => r.pass).length;
  console.log(`\n==== ${pass}/${results.length} 通过 ====`);
  if (pass !== results.length) { console.log(bridgeLog.slice(-1500)); process.exitCode = 1; }
  setTimeout(() => process.exit(process.exitCode || 0), 300);
}
