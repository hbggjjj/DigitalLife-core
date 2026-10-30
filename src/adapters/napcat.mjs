// QQ 通道（NapCat + OneBot HTTP）
import { BaseAdapter } from './base.mjs';

export class NapCatAdapter extends BaseAdapter {
  constructor(cfg = {}) {
    super('napcat', cfg);
    this.baseUrl = (cfg.baseUrl || 'http://127.0.0.1:3000').replace(/\/$/, '');
    this.token = cfg.token || '';
    this.textMap = { text: (d) => d?.text || '', image: () => '[图片]' };
  }

  async call(action, params = {}, timeout = 15000) {
    const r = await fetch(`${this.baseUrl}/${action}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${this.token}` },
      body: JSON.stringify(params),
      signal: AbortSignal.timeout(timeout),
    });
    const d = await r.json().catch(() => ({}));
    if (!d || d.status === 'failed' || (d.retcode && d.retcode !== 0)) {
      throw new Error((d && (d.message || d.wording)) || 'napcat 返回失败');
    }
    return d.data;
  }

  async ping() {
    try {
      const r = await fetch(`${this.baseUrl}/get_status`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${this.token}` },
        body: '{}',
        signal: AbortSignal.timeout(5000),
      });
      return r.status === 200;
    } catch { return false; }
  }

  async isConnected() {
    try {
      const st = await this.call('get_status', {}, 5000);
      if (!(st && st.online && st.good)) return false;
      await this.call('get_friend_list', { no_cache: true }, 8000);   // 真打一次服务器
      return true;
    } catch { return false; }
  }

  async _send(kind, payload) {
    const uid = Number(payload.uid);
    if (kind === 'text') {
      return this.call('send_private_msg', { user_id: uid, message: [{ type: 'text', data: { text: payload.text } }] });
    }
    if (kind === 'image') {
      return this.call('send_private_msg', { user_id: uid, message: [{ type: 'image', data: { file: 'file://' + payload.file } }] }, 30000);
    }
    if (kind === 'meme') {
      return this.call('send_private_msg', { user_id: uid, message: [{ type: 'image', data: { file: 'file://' + payload.file } }] }, 30000);
    }
    throw new Error('未知的消息类型: ' + kind);
  }

  normalize(ev) {
    const segs = Array.isArray(ev?.message) ? ev.message : [];
    const text = segs.map((s) => (s.type === 'text' ? (s.data?.text || '') : (s.type === 'image' ? '' : '[其他]'))).join('').trim();
    const images = segs.filter((s) => s.type === 'image').map((s) => s.data || {});
    return {
      senderId: String(ev?.user_id ?? ''),
      text,
      images,
      timestamp: ev?.time ? ev.time * 1000 : Date.now(),
      debug: !!ev?._debug,
      agent: !!ev?._agent,
      raw: ev,
    };
  }
}
