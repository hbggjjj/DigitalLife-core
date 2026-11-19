// SPDX-License-Identifier: AGPL-3.0-or-later
// 报警通道：需要维护者立刻知道的事，走这里。不写她的文件、不进她的对话。
// 三个去处（能用的都发，失败不抛）：
//   ① 维护者手机上的一条系统通知（DSHA /app/notify）
//   ② 面板事件流（emit），他自己开面板就能看到
//   ③ bot/alerts.log（只追加，事后能查）
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// 项目根目录：本文件在 <root>/src/utils/ 下，所以往上两级就是 root
const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = process.env.QQBOT_ROOT || path.resolve(HERE, '../..');
const LOG = path.join(ROOT, 'bot', 'alerts.log');
const DSHA = process.env.DSHA_BRIDGE || 'http://127.0.0.1:3090';

let lastSent = new Map();     // key -> ts，同一件事 10 分钟内不重复轰炸

export async function alert(key, title, detail = '', { cooldownMs = 10 * 60e3 } = {}) {
  const now = Date.now();
  const prev = lastSent.get(key) || 0;
  if (now - prev < cooldownMs) return false;
  lastSent.set(key, now);

  const line = `${new Date().toISOString()} [${key}] ${title}${detail ? ' — ' + String(detail).slice(0, 300) : ''}`;
  try { fs.appendFileSync(LOG, line + '\n'); } catch {}

  try { const { emit } = await import('./events.mjs'); emit('alert', key, title, { detail: String(detail).slice(0, 300) }); } catch {}

  try {
    const url = `${DSHA}/app/notify?title=${encodeURIComponent('数字生命：' + title)}&text=${encodeURIComponent(String(detail).slice(0, 120))}`;
    await fetch(url, { signal: AbortSignal.timeout(4000) });
  } catch {}
  return true;
}
