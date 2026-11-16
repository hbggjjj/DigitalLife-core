// Web 通道（预留）：浏览器/WebSocket 接到 core 的统一入口
// 只实现接口，不接生产。等真要用时，把 sendText 换成 WS 推送即可。
import { BaseAdapter } from './base.mjs';

export class WebAdapter extends BaseAdapter {
  constructor(cfg = {}) {
    super('web', cfg);
    this.outbox = [];              // 没有前端连接时，先放这儿
  }

  async _send(kind, payload) {
    this.outbox.push({ kind, payload, at: Date.now() });
    if (this.outbox.length > 200) this.outbox.shift();
    return { ok: true };
  }

  async ping() { return true; }    // 本地通道永远"通"
  async isConnected() { return true; }

  normalize(msg) {
    return {
      senderId: String(msg?.senderId || 'local'),
      text: String(msg?.text || ''),
      images: msg?.images || [],
      timestamp: Date.now(),
      raw: msg,
    };
  }

  /** 给前端取消息用 */
  drain() { return this.outbox.splice(0, this.outbox.length); }
}
