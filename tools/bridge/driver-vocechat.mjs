// VoceChat 驱动：把 VoceChat 的 Bot API 收敛成通道协议需要的最小动作集。
// 换 IM 只需要再写一个同签名的文件，bridge.mjs 不用动。
//
// 对应关系（对照 CHANNEL-PROTOCOL.md）：
//   sendText   → POST /api/bot/send_to_user/{uid}   content-type: text/plain      （协议 §3）
//   sendFile   → POST /api/bot/send_to_user/{uid}   content-type: vocechat/file   （协议 §3 image/meme）
//   upload     → POST /api/bot/file/upload                                        （协议 §5）
//   health     → GET  /api/bot                      用 x-api-key 探活               （协议 §4）
//   parseInbound ← VoceChat webhook POST 的 JSON                                  （协议 §2）

export function createVoceChatDriver({ baseUrl, apiKey, botUid = null }) {
  const base = String(baseUrl || '').replace(/\/+$/, '');
  const key = apiKey;

  async function call(path, { method = 'GET', headers = {}, body, timeoutMs = 8000 } = {}) {
    const res = await fetch(base + path, {
      method,
      headers: { 'x-api-key': key, ...headers },
      body,
      signal: AbortSignal.timeout(timeoutMs),
    });
    const text = await res.text();
    let data = null;
    try { data = text ? JSON.parse(text) : null; } catch { data = null; }
    if (!res.ok) {
      const err = new Error(`vocechat ${method} ${path} → HTTP ${res.status} ${text.slice(0, 200)}`);
      err.status = res.status;
      err.data = data;
      throw err;
    }
    return data ?? {};
  }

  return {
    name: 'vocechat',
    baseUrl: base,

    /** 探活：能读到 bot 自己的信息，就说明 API Key 有效、服务在线 */
    async health() {
      const data = await call('/api/bot', { timeoutMs: 4000 });
      return { ok: true, online: true, raw: data };
    },

    async sendText(uid, text) {
      const data = await call(`/api/bot/send_to_user/${encodeURIComponent(uid)}`, {
        method: 'POST',
        headers: { 'content-type': 'text/plain' },   // VoceChat 只认精确的 text/plain，带 charset 会 415
        body: text,
      });
      return data;
    },

    /** payload.path 是 upload() 返回的路径 */
    async sendFile(uid, { path: filePath }) {
      const data = await call(`/api/bot/send_to_user/${encodeURIComponent(uid)}`, {
        method: 'POST',
        headers: { 'content-type': 'vocechat/file' },
        body: JSON.stringify({ path: filePath }),
      });
      return data;
    },

    /** 上传二进制，返回 { path } —— VoceChat 要求先传再发 */
    async upload(buffer, filename, mime = 'application/octet-stream') {
      const form = new FormData();
      form.append('file', new Blob([buffer], { type: mime }), filename);
      const data = await call('/api/bot/file/upload', { method: 'POST', body: form, timeoutMs: 20000 });
      const filePath = data.path || data.url || data.file || data.result?.path;
      if (!filePath) throw new Error('上传成功但没拿到 path: ' + JSON.stringify(data).slice(0, 200));
      return { path: filePath };
    },

    /** 把 IM 内部的文件路径变成外部能 GET 的 url（协议 §5 要求可直连） */
    fileUrl(filePath) {
      if (!filePath) return null;
      if (/^https?:\/\//i.test(filePath)) return filePath;
      return base + (filePath.startsWith('/') ? filePath : '/' + filePath);
    },

    /**
     * 把 VoceChat 的 webhook 事件解析成协议需要的形状。
     * 返回 null 表示这条事件不用送进核心（删除/编辑/非私聊/机器人自己发的）。
     *
     * VoceChat 事件长这样：
     * { created_at, from_uid, mid, target: { uid } | { gid },
     *   detail: { content, content_type, type: normal|edit|delete|reply, properties } }
     */
    parseInbound(body) {
      if (!body || typeof body !== 'object') return null;
      const mid = body.mid;
      const fromUid = body.from_uid;
      if (mid == null || fromUid == null) return null;
      if (botUid != null && String(fromUid) === String(botUid)) return null;      // 自己说的话不要回灌
      if (body.target?.gid != null) return null;                                   // 协议 §11：不做群聊

      const detail = body.detail || {};
      const type = detail.type || 'normal';
      if (!['normal', 'reply'].includes(type)) return null;                        // 编辑/删除/点赞一律丢弃

      const ctype = detail.content_type || 'text/plain';
      const content = detail.content ?? '';
      const ts = Number(body.created_at) || Date.now();

      let text = '';
      const images = [];

      if (ctype === 'vocechat/file') {
        let p = content;
        try { p = JSON.parse(content)?.path || content; } catch {}
        if (!p) return null;
        const meta = detail.properties?.image || {};
        images.push({ url: this.fileUrl(p), w: meta.width ?? null, h: meta.height ?? null });
      } else {
        text = String(content);
      }

      if (!text && !images.length) return null;

      return {
        // 用 IM 自己的 mid 做幂等键：webhook 重投时核心能靠 msgId 去重
        msgId: `vc-${mid}`,
        senderId: `user-${fromUid}`,
        origin: 'user',
        text,
        images,
        ts,
        replyTo: type === 'reply' && detail.mid ? `vc-${detail.mid}` : null,
      };
    },
  };
}
