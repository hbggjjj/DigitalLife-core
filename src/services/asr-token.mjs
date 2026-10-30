// 阿里云 Token 自动续期（NLS CreateToken，RPC 签名）
// 只在本机内存 + 私有 config 里存 token；AK/SK 不进日志、不进开源包。
import crypto from 'node:crypto';
import fs from 'node:fs';
import { http4 } from '../utils/http4.mjs';

const CFG = '__MIKU_ROOT__/bot/config.json';

function pct(s) {
  return encodeURIComponent(String(s))
    .replace(/!/g, '%21').replace(/'/g, '%27')
    .replace(/\(/g, '%28').replace(/\)/g, '%29').replace(/\*/g, '%2A');
}

function sign(params, secret) {
  const canon = Object.keys(params).sort()
    .map((k) => `${pct(k)}=${pct(params[k])}`).join('&');
  const toSign = 'GET&%2F&' + pct(canon);
  const sig = crypto.createHmac('sha1', secret + '&').update(toSign).digest('base64');
  return canon + '&Signature=' + pct(sig);
}

export async function createToken(akId, akSecret) {
  const params = {
    AccessKeyId: akId,
    Action: 'CreateToken',
    Format: 'JSON',
    RegionId: 'cn-shanghai',
    SignatureMethod: 'HMAC-SHA1',
    SignatureNonce: crypto.randomUUID(),
    SignatureVersion: '1.0',
    Timestamp: new Date().toISOString().replace(/\.\d{3}Z$/, 'Z'),
    Version: '2019-02-28',
  };
  const url = 'https://nls-meta.cn-shanghai.aliyuncs.com/?' + sign(params, akSecret);
  const r = await http4(url, { timeout: 10000, headers: { Accept: 'application/json' } });
  let j;
  try { j = r.json(); } catch { throw new Error('Token 返回不是 JSON：' + r.text().slice(0, 100)); }
  if (!j.Token || !j.Token.Id) {
    throw new Error('换 Token 失败：' + (j.Message || j.Code || JSON.stringify(j).slice(0, 120)));
  }
  return { token: j.Token.Id, expireAt: Number(j.Token.ExpireTime) * 1000 };
}

/** 拿一个可用的 token：快过期就自动换，换了写回私有配置 */
export async function ensureToken(cfg) {
  const a = cfg.asr || {};
  const now = Date.now();
  if (a.token && a.tokenExpireAt && a.tokenExpireAt - now > 2 * 3600 * 1000) {
    return a.token;
  }
  if (!a.akId || !a.akSecret) {
    if (a.token && (!a.tokenExpireAt || a.tokenExpireAt > now)) return a.token;  // 临时 token 还能用
    throw new Error('没有长期凭证（akId/akSecret），且临时 token 已过期');
  }
  const t = await createToken(a.akId, a.akSecret);
  try {
    const cur = JSON.parse(fs.readFileSync(CFG, 'utf8'));
    cur.asr = { ...(cur.asr || {}), token: t.token, tokenExpireAt: t.expireAt };
    try {
      const fsx = await import('node:fs');
      fsx.appendFileSync('__MIKU_ROOT__/bot/config-writes.log',
        `[${new Date().toISOString()}] asr-token write active=${cur?.schedule?.activeStart}-${cur?.schedule?.activeEnd} pid=${process.pid}\n`);
    } catch {}
    fs.writeFileSync(CFG, JSON.stringify(cur, null, 2));
    fs.chmodSync(CFG, 0o600);
  } catch {}
  return t.token;
}
