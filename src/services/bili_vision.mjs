// 视频画面：用 B 站自带的预览雪碧图抽帧，交给她的多模态调用。
// 她看到的是几个不同时间点的画面（连环画），不是连续动作。
import fs from 'node:fs';
import { execFileSync } from 'node:child_process';

const UA = {
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
  Referer: 'https://www.bilibili.com/',
  Origin: 'https://www.bilibili.com',
  Accept: 'application/json, text/plain, */*',
  'Accept-Language': 'zh-CN,zh;q=0.9',
};

let COOKIE = '';
let cookieAt = 0;

/** 先访问首页拿 buvid3 等 cookie——机房 IP 没有它，videoshot 会 412 */
async function ensureCookie(force = false) {
  if (!force && COOKIE && Date.now() - cookieAt < 30 * 60 * 1000) return COOKIE;
  try {
    const r = await fetch('https://www.bilibili.com/', { headers: UA, signal: AbortSignal.timeout(15000) });
    const list = typeof r.headers.getSetCookie === 'function' ? r.headers.getSetCookie() : [];
    const jar = list.map((c) => String(c).split(';')[0]).filter(Boolean);
    COOKIE = jar.join('; ');
    cookieAt = Date.now();
  } catch {}
  return COOKIE;
}

function withCookie(extra = {}) {
  return COOKIE ? { ...extra, Cookie: COOKIE } : extra;
}

async function jget(url) {
  let lastErr;
  for (let i = 0; i < 3; i++) {
    try {
      if (!COOKIE) await ensureCookie();
      const r = await fetch(url, { headers: withCookie(UA), signal: AbortSignal.timeout(20000) });
      if (r.ok) return r.json();
      lastErr = new Error('HTTP ' + r.status);
      if (r.status === 412) await ensureCookie(true);   // 被风控：换一次 cookie 再来
      else if (r.status < 500) throw lastErr;
    } catch (e) { lastErr = e; }
    await new Promise((res) => setTimeout(res, 800 * (i + 1)));
  }
  throw lastErr;
}

export async function sprite(bvid) {
  const v = await jget('https://api.bilibili.com/x/web-interface/view?bvid=' + bvid);
  const d = v.data;
  const cid = d.pages?.[0]?.cid;
  const s = await jget(`https://api.bilibili.com/x/player/videoshot?aid=${d.aid}&cid=${cid}`);
  const info = s.data || {};
  const url = (info.image && info.image[0]) || '';
  return {
    title: d.title, up: d.owner?.name, dur: d.duration,
    cover: d.pic, sprite: url.startsWith('//') ? 'https:' + url : url,
    cols: info.img_x_len || 10, rows: info.img_y_len || 10,
    fw: info.img_x_size || 480, fh: info.img_y_size || 270,
  };
}

export async function frames(bvid, n = 4) {
  const info = await sprite(bvid);
  if (!info.sprite) throw new Error('这个视频拿不到预览图');
  await ensureCookie();
  const r = await fetch(info.sprite, { headers: withCookie(UA), signal: AbortSignal.timeout(30000) });
  if (!r.ok) throw new Error('预览图下载失败 ' + r.status);
  const dir = `/tmp/hframes-${bvid}`;
  fs.rmSync(dir, { recursive: true, force: true });
  fs.mkdirSync(dir, { recursive: true });
  const raw = `${dir}/sprite.jpg`;
  fs.writeFileSync(raw, Buffer.from(await r.arrayBuffer()));
  const total = info.cols * info.rows;
  // 候选取 12 个点，筛掉纯黑和糊的，再补一张 UP 主挑的封面
  const CAND = 12;
  const step = Math.max(1, Math.floor(total / (CAND + 1)));
  const coverPath = `${dir}/cover.jpg`;
  let coverOk = false;
  try {
    if (info.cover) {
      const cr = await fetch(info.cover.startsWith('//') ? 'https:' + info.cover : info.cover, { headers: withCookie(UA), signal: AbortSignal.timeout(15000) });
      if (cr.ok) { fs.writeFileSync(coverPath, Buffer.from(await cr.arrayBuffer())); coverOk = true; }
    }
  } catch {}

  const py = `
import json
from PIL import Image, ImageStat
im = Image.open(${JSON.stringify(raw)})
cols, rows, fw, fh = ${info.cols}, ${info.rows}, ${info.fw}, ${info.fh}
total = cols * rows
cands = []
for i in range(${CAND}):
    k = min(total - 1, (i + 1) * ${step})
    x = (k % cols) * fw; y = (k // cols) * fh
    tile = im.crop((x, y, x + fw, y + fh)).convert('L')
    st = ImageStat.Stat(tile)
    mean = st.mean[0]; std = st.stddev[0]
    cands.append({'k': k, 'x': x, 'y': y, 'mean': mean, 'std': std})

def usable(c):
    # 纯黑（几乎没信息）和糊成一片（对比度极低）都不要
    return c['mean'] >= 20 and c['std'] >= 12

ok = [c for c in cands if usable(c)]
if len(ok) < ${n}:
    # 筛完不够就用对比度最高的补
    ok = sorted(cands, key=lambda c: -c['std'])[:${n}]
ok = ok[:${n}]

out = []
for i, c in enumerate(ok):
    im.crop((c['x'], c['y'], c['x'] + fw, c['y'] + fh)).save(${JSON.stringify(dir)} + f'/f{i}.jpg', quality=88)
    out.append({'i': i, 'mean': round(c['mean'], 1), 'std': round(c['std'], 1)})
print(json.dumps(out))
`;
  let picked = [];
  try {
    const r = execFileSync('python3', ['-c', py], { timeout: 40000 });
    picked = JSON.parse(String(r).trim() || '[]');
  } catch (e) { throw new Error('切帧失败：' + e.message); }

  const out = [];
  picked.forEach((p, i) => {
    const path = `${dir}/f${i}.jpg`;
    if (fs.existsSync(path)) out.push({ path, at: Math.round(((p.k ?? (i + 1) * step) / total) * info.dur) });
  });
  if (coverOk) out.push({ path: coverPath, at: null, cover: true });
  return { info, frames: out, dir };
}

export function cleanup(dir) {
  try { fs.rmSync(dir, { recursive: true, force: true }); } catch {}
}
