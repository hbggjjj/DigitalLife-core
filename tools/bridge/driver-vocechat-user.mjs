// VoceChat「普通账号」驱动：她的账号就是一个普通用户，看得见、联系人里有。
// 没有 webhook（webhook 只有 bot 有），所以改成轮询历史。
import crypto from 'node:crypto';

export function createUserDriver({ baseUrl, email, password, peerUid, device = 'miku-core' }) {
  const base = baseUrl.replace(/\/$/, '');
  let token = '';
  let tokenAt = 0;
  let uid = 0;
  let refresh = '';

  async function login() {
    const r = await fetch(`${base}/api/token/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ credential: { type: 'password', email, password }, device }),
      signal: AbortSignal.timeout(10000),
    });
    const d = await r.json();
    if (!r.ok || !d.token) throw new Error('登录失败：' + (d.message || r.status));
    token = d.token; tokenAt = Date.now(); uid = d.user.uid;
    refresh = d.refresh_token || '';
    return d.user;
  }

  /** 用 refresh_token 续期；失败返回 false，让调用方回退到密码登录 */
  async function renew() {
    if (!refresh) return false;
    try {
      const r = await fetch(`${base}/api/token/renew`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-api-key': refresh },
        body: JSON.stringify({ refresh_token: refresh }),
        signal: AbortSignal.timeout(8000),
      });
      if (!r.ok) return false;
      const d = await r.json();
      if (!d.token) return false;
      token = d.token; tokenAt = Date.now();
      if (d.refresh_token) refresh = d.refresh_token;
      return true;
    } catch { return false; }
  }

  async function ensure() {
    if (!token) { await login(); return token; }
    if (Date.now() - tokenAt > 4 * 60 * 1000) {
      if (!(await renew())) await login();   // 续期优先，令牌过期才重新登录
    }
    return token;
  }

  async function sendText(toUid, text) {
    await ensure();
    const r = await fetch(`${base}/api/user/${toUid}/send`, {
      method: 'POST',
      headers: { 'x-api-key': token, 'content-type': 'text/plain' },
      body: String(text),
      signal: AbortSignal.timeout(10000),
    });
    if (!r.ok) throw new Error('发送失败 HTTP ' + r.status + ' ' + (await r.text()).slice(0, 120));
    const mid = (await r.text()).trim();
    return { mid };
  }

  /** 发一张本机图片：prepare → upload → send(vocechat/file) */
  async function sendImage(toUid, filePath) {
    await ensure();
    const fs = await import('node:fs');
    const buf = fs.readFileSync(filePath);
    const name = filePath.split('/').pop() || 'image.jpg';
    const ct = /\.png$/i.test(name) ? 'image/png' : 'image/jpeg';
    const pr = await fetch(`${base}/api/resource/file/prepare`, {
      method: 'POST', headers: { 'x-api-key': token, 'content-type': 'application/json' },
      body: JSON.stringify({ content_type: ct, filename: name, size: buf.length }),
      signal: AbortSignal.timeout(10000),
    });
    if (!pr.ok) throw new Error('prepare 失败 HTTP ' + pr.status);
    const fid = (await pr.text()).replace(/"/g, '').trim();
    const fd = new FormData();
    fd.append('file_id', fid);
    fd.append('chunk_is_last', 'true');
    fd.append('chunk_data', new Blob([buf], { type: ct }), name);
    const up = await fetch(`${base}/api/resource/file/upload`, {
      method: 'POST', headers: { 'x-api-key': token }, body: fd,
      signal: AbortSignal.timeout(30000),
    });
    const uj = await up.json().catch(() => ({}));
    if (!up.ok || !uj.path) throw new Error('upload 失败 HTTP ' + up.status + ' ' + JSON.stringify(uj).slice(0, 100));
    const sd = await fetch(`${base}/api/user/${toUid}/send`, {
      method: 'POST', headers: { 'x-api-key': token, 'content-type': 'vocechat/file' },
      body: JSON.stringify({ path: uj.path }),
      signal: AbortSignal.timeout(10000),
    });
    if (!sd.ok) throw new Error('发图失败 HTTP ' + sd.status);
    return { mid: (await sd.text()).trim(), path: uj.path };
  }

  async function history(afterMid = 0, limit = 50) {
    await ensure();
    const r = await fetch(`${base}/api/user/${peerUid}/history?after_mid=${afterMid}&limit=${limit}`, {
      headers: { 'x-api-key': token },
      signal: AbortSignal.timeout(10000),
    });
    if (!r.ok) throw new Error('拉历史失败 HTTP ' + r.status);
    return r.json();
  }

  /** 把一条 vocechat/file 消息下载到本地，返回路径 */
  async function downloadFile(entry) {
    await ensure();
    const p = entry.content || entry.file || '';
    const fp = encodeURIComponent(p);
    const r = await fetch(`${base}/api/resource/file?file_path=${fp}`, {
      headers: { 'x-api-key': token },
      signal: AbortSignal.timeout(20000),
    });
    if (!r.ok) throw new Error('下载失败 HTTP ' + r.status);
    const buf = Buffer.from(await r.arrayBuffer());
    const ext = /jpe?g/i.test(entry.properties?.content_type || '') ? '.jpg' : '.bin';
    const out = `/tmp/im-in-${entry.mid}${ext}`;
    const fs = await import('node:fs');
    fs.writeFileSync(out, buf);
    return { path: out, w: entry.properties?.width || 0, h: entry.properties?.height || 0, bytes: buf.length };
  }

  function parseInbound(body) {
    // 轮询拿到的历史项 → 统一形状（和 bot 版保持一致）
    const from = Number(body.from_uid ?? body.uid ?? 0);
    if (peerUid && from !== Number(peerUid)) return null;
    // VoceChat 历史项的真实结构：detail.content + detail.content_type
    const d = body.detail || body;
    const ct = d.content_type || 'text/plain';
    const isFile = ct === 'vocechat/file';
    const text = isFile ? '' : (typeof body.content === 'string' ? body.content : (d.content || ''));
    if (!text && !isFile) return null;
    return {
      msgId: 'vc-' + (body.mid ?? crypto.randomUUID()),
      senderId: 'user-' + from,
      origin: 'user',
      text,
      images: isFile && /image/i.test(d.properties?.content_type || '') ? [{ file: d.content, properties: d.properties }] : [],
      ts: Number(body.created_at) || Date.now(),
    };
  }

  async function health() {
    try { await ensure(); return true; } catch { return false; }
  }

  return { name: 'vocechat-user', login, sendText, sendImage, history, parseInbound, downloadFile, health, getUid: () => uid };
}
