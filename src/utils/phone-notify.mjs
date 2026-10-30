// 手机上弹一条系统通知（VoceChat App 没有 FCM，后台收不到提醒时的兜底）
import fs from 'node:fs';
import http from 'node:http';

// 可选能力：只有装了 DSHA 的机器才有这个桥；没有就静默跳过
const HDR = process.env.DSHA_BRIDGE_HEADERS || '';

function headers() {
  try {
    const h = {};
    for (const line of fs.readFileSync(HDR, 'utf8').split('\n')) {
      const i = line.indexOf(':');
      if (i > 0) h[line.slice(0, i).trim()] = line.slice(i + 1).trim();
    }
    return h;
  } catch { return {}; }
}

export function notify(title, text) {
  if (!HDR) return Promise.resolve(false);   // 没配 DSHA 桥：直接跳过，不报错
  return new Promise((resolve) => {
    const q = new URLSearchParams({ title: String(title).slice(0, 40), text: String(text).slice(0, 180) });
    const req = http.request({
      host: '127.0.0.1', port: 3090, path: '/app/notify?' + q.toString(), method: 'GET',
      headers: headers(), timeout: 5000,
    }, (res) => { res.resume(); resolve(res.statusCode === 200); });
    req.on('error', () => resolve(false));
    req.on('timeout', () => { req.destroy(); resolve(false); });
    req.end();
  });
}
