// 自建 IM 通道（协议见 docs/CHANNEL-PROTOCOL.md）
// 只做"收发 + 判活"，不碰她的心智。
import { BaseAdapter } from './base.mjs';

export class SelfIMAdapter extends BaseAdapter {
  constructor(cfg = {}) {
    super('selfim', cfg);
    this.baseUrl = (cfg.baseUrl || 'http://127.0.0.1:8080').replace(/\/$/, '');
    this.token = cfg.token || '';
    this.secret = cfg.secret || '';
  }

  async _req(path, opts = {}) {
    const r = await fetch(`${this.baseUrl}${path}`, {
      method: opts.method || 'GET',
      headers: {
        'Content-Type': 'application/json',
        ...(this.token ? { Authorization: 'Bearer ' + this.token } : {}),
        ...(opts.headers || {}),
      },
      body: opts.body ? JSON.stringify(opts.body) : undefined,
      signal: AbortSignal.timeout(opts.timeout || 10000),
    });
    const d = await r.json().catch(() => ({}));
    if (!r.ok || d.ok === false) throw new Error(d.message || ('selfim HTTP ' + r.status));
    return d;
  }

  async ping() {
    try { const d = await this._req('/api/v1/health'); return !!d.ok; } catch { return false; }
  }

  async isConnected() {
    try {
      const d = await this._req('/api/v1/health');
      if (!d.online) return false;
      const last = Number(d.lastSendOkAt) || 0;
      return last > 0 && Date.now() - last < 15 * 60 * 1000;
    } catch { return false; }
  }

  async _send(kind, payload) {
    const clientMsgId = payload.clientMsgId || (Date.now().toString(36) + Math.random().toString(36).slice(2, 8));
    const body = {
      clientMsgId,
      to: String(payload.to || payload.uid || ''),
      kind,
      payload: kind === 'text'
        ? { text: String(payload.text || '') }
        : { path: String(payload.path || payload.url || payload.file || '') },
      ts: Date.now(),
    };
    const d = await this._req('/api/v1/send', { method: 'POST', body });
    return d;
  }

  normalize(ev) {
    return {
      senderId: String(ev?.senderId || ''),
      text: String(ev?.text || ''),
      images: Array.isArray(ev?.images) ? ev.images : [],
      timestamp: Number(ev?.ts) || Date.now(),
      origin: ev?.origin || 'user',
      msgId: ev?.msgId || '',
      raw: ev,
    };
  }
}
