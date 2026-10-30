// B 站扫码登录：拿 cookie（用于读 CC 字幕），跟 QQ 登录一样走二维码
import fs from 'node:fs';
import { execFileSync } from 'node:child_process';

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/124.0 Safari/537.36';
const COOKIE_FILE = '__MIKU_ROOT__/bot/bili_cookie.json';
const QR_FILE = '__MIKU_ROOT__/bot/bili_qr.png';

let session = null;   // { key, url, at }

export async function generate() {
  const r = await fetch('https://passport.bilibili.com/x/passport-login/web/qrcode/generate', {
    headers: { 'User-Agent': UA, Referer: 'https://www.bilibili.com/' },
    signal: AbortSignal.timeout(12000),
  });
  const d = await r.json();
  if (d.code !== 0) throw new Error('生成二维码失败: ' + d.message);
  session = { key: d.data.qrcode_key, url: d.data.url, at: Date.now() };
  try {
    execFileSync('qrencode', ['-o', QR_FILE, '-s', '8', '-m', '4', '-l', 'M', d.data.url]);
  } catch (e) { throw new Error('画二维码失败: ' + e.message); }
  return { ...session, file: QR_FILE };
}

export async function poll() {
  if (!session) return { status: 'none', message: '还没有二维码' };
  const r = await fetch(`https://passport.bilibili.com/x/passport-login/web/qrcode/poll?qrcode_key=${session.key}`, {
    headers: { 'User-Agent': UA, Referer: 'https://www.bilibili.com/' },
    signal: AbortSignal.timeout(12000),
  });
  const d = await r.json();
  const code = d.data?.code;
  const msg = { 86101: '等待扫码', 86090: '已扫码，等确认', 86038: '二维码过期', 0: '登录成功' }[code] || ('未知 ' + code);
  if (code !== 0) return { status: code === 86038 ? 'expired' : 'waiting', message: msg };

  // 从 Set-Cookie 里拼出 cookie
  const raw = r.headers.getSetCookie?.() || [];
  const jar = {};
  for (const c of raw) {
    const [kv] = c.split(';');
    const i = kv.indexOf('=');
    if (i > 0) jar[kv.slice(0, i)] = kv.slice(i + 1);
  }
  const cookie = Object.entries(jar).map(([k, v]) => `${k}=${v}`).join('; ');
  fs.writeFileSync('__MIKU_ROOT__/bot/bili_login_debug.json', JSON.stringify({ raw, jar, at: Date.now() }, null, 2));
  if (!cookie.includes('SESSDATA')) return { status: 'failed', message: '扫码成功但没拿到 SESSDATA（多半是没在手机上点确认）' };

  fs.writeFileSync(COOKIE_FILE, JSON.stringify({ cookie, at: Date.now() }, null, 2));
  // 立刻验一次：cookie 拿得到 ≠ 登录有效
  const c = await check();
  if (!c.ok) {
    try { fs.unlinkSync(COOKIE_FILE); } catch {}
    return { status: 'failed', message: `扫码返回成功，但这个 cookie 无效（${c.reason}）——可能你扫的是没登录的 B 站，或者手机上没点确认` };
  }
  session = null;
  return { status: 'ok', message: `登录成功：${c.uname}` };
}

export function cookie() {
  try { return JSON.parse(fs.readFileSync(COOKIE_FILE, 'utf8')).cookie || ''; } catch { return ''; }
}
export function loggedIn() { return !!cookie(); }

/** 用 cookie 问一下 B 站：这个登录还有效吗 */
export async function check() {
  const ck = cookie();
  if (!ck) return { ok: false, reason: '没有 cookie' };
  try {
    const r = await fetch('https://api.bilibili.com/x/web-interface/nav', {
      headers: { 'User-Agent': UA, Referer: 'https://www.bilibili.com/', Cookie: ck },
      signal: AbortSignal.timeout(10000),
    });
    const d = await r.json();
    if (d?.data?.isLogin) return { ok: true, uname: d.data.uname, mid: d.data.mid };
    return { ok: false, reason: 'cookie 已失效' };
  } catch (e) { return { ok: false, reason: '检查失败: ' + e.message }; }
}
