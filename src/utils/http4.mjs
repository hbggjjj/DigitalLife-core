// 强制 IPv4 的 https GET：这台机器的 IPv6 路由不通，
// Node 自带 fetch(undici) 会先试 IPv6 并卡满 10 秒连接超时。
import https from 'node:https';
import dns from 'node:dns';

export function http4(urlStr, opts = {}) {
  const { headers = {}, timeout = 8000, method = 'GET', body = null } = opts;
  return new Promise((resolve, reject) => {
    let u;
    try { u = new URL(urlStr); } catch (e) { return reject(e); }
    const req = https.request({
      hostname: u.hostname,
      port: u.port || 443,
      path: u.pathname + u.search,
      method,
      headers,
      family: 4,                 // ← 关键：只走 IPv4
      timeout,
    }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => resolve({
        status: res.statusCode,
        headers: res.headers,
        buffer: Buffer.concat(chunks),
        text() { return Buffer.concat(chunks).toString('utf8'); },
        json() { return JSON.parse(Buffer.concat(chunks).toString('utf8')); },
      }));
    });
    req.on('timeout', () => { req.destroy(new Error('连接超时（' + timeout + 'ms）')); });
    req.on('error', reject);
    if (body) req.write(body);
    req.end();
  });
}
