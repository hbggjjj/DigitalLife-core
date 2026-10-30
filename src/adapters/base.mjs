// 通道基类：任何通道实现 sendText/sendImage/sendMeme/ping/inbound，
// 就自动拥有"攒话补发"和"失败重试"。
import fs from 'node:fs';

export class BaseAdapter {
  constructor(name, cfg = {}) {
    this.name = name;
    this.cfg = cfg;
    this.queueFile = cfg.queueFile || '__MIKU_ROOT__/bot/retry_queue.jsonl';
    this.lostFile = cfg.lostFile || '__MIKU_ROOT__/bot/undelivered.log';
    this.onEvent = cfg.onEvent || (() => {});
  }

  // ---- 子类必须实现 ----
  async _send(kind, payload) { throw new Error(this.name + ' 没有实现 _send'); }
  async ping() { return false; }

  /** 把通道原始事件归一化成 { senderId, text, images, timestamp, raw } */
  normalize(ev) {
    return {
      senderId: String(ev?.user_id ?? ev?.senderId ?? ''),
      text: '',
      images: [],
      timestamp: Date.now(),
      raw: ev,
    };
  }

  // ---- 通用能力：重试 + 补发队列 ----
  async send(kind, payload, tries = 3) {
    let lastErr = '';
    for (let i = 1; i <= tries; i++) {
      try {
        await this._send(kind, payload);
        return { ok: true };
      } catch (e) {
        lastErr = e.message || String(e);
        if (i < tries) await new Promise((r) => setTimeout(r, 1200 * i));
      }
    }
    this._enqueue(kind, payload, lastErr);
    throw new Error('发送最终失败: ' + lastErr);
  }

  _enqueue(kind, payload, err) {
    try {
      fs.appendFileSync(this.queueFile, JSON.stringify({ ts: Date.now(), channel: this.name, kind, payload, attempts: 0 }) + '\n');
      const lines = fs.readFileSync(this.queueFile, 'utf8').split('\n').filter(Boolean);
      if (lines.length > 40) fs.writeFileSync(this.queueFile, lines.slice(-40).join('\n') + '\n');
      this.onEvent('queued', `消息没送到，先攒着（共 ${Math.min(lines.length, 40)} 条）：${String(payload?.text || '').slice(0, 40)}`);
    } catch {}
    try { fs.appendFileSync(this.lostFile, `[${new Date().toISOString()}] ${JSON.stringify(payload).slice(0, 300)} | ${err}\n`); } catch {}
  }

  /** 上线后补发；离线时挂起，不扣次数 */
  async flush(isOnline) {
    let items = [];
    try {
      items = fs.readFileSync(this.queueFile, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
    } catch { return { sent: 0 }; }
    if (!items.length) return { sent: 0 };
    if (!(await isOnline())) return { sent: 0, skipped: true };

    const keep = [];
    let sent = 0;
    for (const it of items) {
      if (Date.now() - it.ts > 24 * 3600 * 1000) continue;
      try {
        await this._send(it.kind, it.payload);
        sent++;
        await new Promise((r) => setTimeout(r, 800));
      } catch (e) {
        it.attempts = (it.attempts || 0) + 1;
        if (it.attempts <= 5) keep.push(it);
        else this._enqueue(it.kind, it.payload, '超过 5 次：' + e.message);
      }
    }
    try { fs.writeFileSync(this.queueFile, keep.map((x) => JSON.stringify(x)).join('\n') + (keep.length ? '\n' : '')); } catch {}
    return { sent };
  }
}
