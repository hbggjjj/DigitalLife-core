// 授时：不让她的时间只依赖手机系统时钟
import fs from 'node:fs';

const FILE = '__MIKU_ROOT__/bot/.clock.json';
const MAX_AGE = 6 * 3600 * 1000;   // 6 小时重新校一次

let lastSystem = 0;    // 上次看到的系统时间
let lastMono = 0;      // 上次的单调时钟
let systemJump = 0;    // 检测到系统时钟跳变的次数

let skew = 0;          // 远端 - 本地
let at = 0;            // 上次校准的时间（本地 ms）

try {
  const j = JSON.parse(fs.readFileSync(FILE, 'utf8'));
  skew = Number(j.skew) || 0;
  at = Number(j.at) || 0;
} catch {}

async function fromTimeApi() {
  const r = await fetch('https://timeapi.io/api/Time/current/zone?timeZone=Asia/Shanghai', {
    signal: AbortSignal.timeout(8000),
  });
  if (!r.ok) throw new Error('timeapi ' + r.status);
  const d = await r.json();
  // 换算成时间戳：它给的是上海时间
  const ms = Date.UTC(d.year, d.month - 1, d.day, d.hour - 8, d.minute, d.seconds, d.milliSeconds || 0);
  return ms;
}

async function fromHttpDate() {
  const r = await fetch('https://www.baidu.com', { method: 'HEAD', signal: AbortSignal.timeout(6000) });
  const h = r.headers.get('date');
  if (!h) throw new Error('没有 Date 头');
  return new Date(h).getTime();
}

/** 校准一次。失败就保留旧偏移，绝不让时间变成 NaN。 */
export async function sync(force = false) {
  if (!force && Date.now() - at < MAX_AGE) return { ok: true, skew, cached: true };
  for (const fn of [fromTimeApi, fromHttpDate]) {
    try {
      const remote = await fn();
      const local = Date.now();
      if (!Number.isFinite(remote)) continue;
      const diff = remote - local;
      if (Math.abs(diff) > 3600e3) {
        try { fs.appendFileSync('__MIKU_ROOT__/bot/clock.log', `[${new Date().toISOString()}] 时差超过一小时：${Math.round(diff / 1000)}s，已采用\n`); } catch {}
      }
      skew = diff;
      at = local;
      try { fs.writeFileSync(FILE, JSON.stringify({ skew, at, atReadable: new Date(local).toISOString() })); } catch {}
      return { ok: true, skew, source: fn.name };
    } catch { /* 换下一个源 */ }
  }
  return { ok: false, skew, cached: at > 0 };
}

export function now() {
  const sys = Date.now();
  const mono = Number(process.hrtime.bigint() / 1000000n);
  // 用单调时钟比对系统时钟：跳超过 60 秒就重校一次
  if (lastSystem && Math.abs((sys - lastSystem) - (mono - lastMono)) > 60e3 && Date.now() - at > 60e3) {
    systemJump++;
    sync(true).catch(() => {});
  }
  lastSystem = sys;
  lastMono = mono;
  return sys + skew;
}

export function date() { return new Date(now()); }
export function status() {
  // 每次都从文件读：面板是另一个进程，内存里的值会过期
  let sk = skew, at2 = at;
  try {
    const j = JSON.parse(fs.readFileSync(FILE, 'utf8'));
    if (Number.isFinite(Number(j.skew))) sk = Number(j.skew);
    if (Number.isFinite(Number(j.at))) at2 = Number(j.at);
  } catch {}
  return {
    skewSec: Math.round(sk / 1000),
    calibratedAt: at2 ? new Date(at2).toISOString() : null,
    ageMin: at2 ? Math.round((Date.now() - at2) / 60000) : null,
    systemJump,
  };
}
