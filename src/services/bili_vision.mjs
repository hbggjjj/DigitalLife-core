// SPDX-License-Identifier: AGPL-3.0-or-later
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
    title: d.title, up: d.owner?.name, dur: d.duration, cid,
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

// ---------- 真帧：从视频流里按时间点取画面（比雪碧图清楚，能自己挑秒数） ----------

/** 拿 cid（playurl 必须带） */
async function getCid(bvid) {
  try {
    const j = await jget(`https://api.bilibili.com/x/web-interface/view?bvid=${encodeURIComponent(bvid)}`);
    const d = j && j.data;
    return (d && (d.cid || (d.pages && d.pages[0] && d.pages[0].cid))) || 0;
  } catch { return 0; }
}

/** 取 DASH 视频轨直链（带签名，约 2 小时有效） */
async function videoStream(bvid, cid, qn = 64) {
  await ensureCookie();
  const u = `https://api.bilibili.com/x/player/playurl?bvid=${encodeURIComponent(bvid)}&cid=${cid}&qn=${qn}&fnval=16&fourk=1`;
  const j = await jget(u);
  const dash = j && j.data && j.data.dash;
  if (!dash || !Array.isArray(dash.video) || !dash.video.length) return null;
  // 优先要 720p 左右的那档，没有就取最高的
  const sorted = dash.video.slice().sort((a, b) => (b.height || 0) - (a.height || 0));
  const pick = sorted.find((v) => (v.height || 0) <= 720) || sorted[0];
  const url = pick.baseUrl || pick.base_url;
  return url ? { url, height: pick.height || 0 } : null;
}

/** 把视频轨拉到本地（ffmpeg 直接读 https 会崩，先落盘再抽帧） */
async function downloadStream(url, dest) {
  const args = [
    '-sL', '--max-time', '180', '--max-filesize', '300000000',
    '-H', 'Referer: https://www.bilibili.com/',
    '-H', `User-Agent: ${UA['User-Agent']}`,
    '-o', dest, url,
  ];
  if (COOKIE) args.splice(1, 0, '-H', `Cookie: ${COOKIE}`);
  execFileSync('curl', args, { timeout: 190000, stdio: 'ignore' });
  return fs.existsSync(dest) && fs.statSync(dest).size > 100000;
}

/** 从本地文件按秒数取一帧（不联网，稳定） */
function grabAt(file, sec, out) {
  execFileSync('ffmpeg', [
    '-hide_banner', '-loglevel', 'error',
    '-ss', String(Math.max(0, sec)),
    '-i', file,
    '-frames:v', '1', '-q:v', '3', '-y', out,
  ], { timeout: 30000, stdio: 'ignore' });
  return fs.existsSync(out) && fs.statSync(out).size > 2000;
}

/**
 * 她真正看到的帧：按时间均匀取样，覆盖整段视频。
 * 任何环节失败都退回雪碧图（宁可糊，也不能让她这次什么都看不见）。
 */
export async function realFrames(bvid, { cid, durSec = 0, want = 12, qn = 64 } = {}) {
  const n = Math.max(4, Math.min(24, Number(want) || 12));
  const dur = Number(durSec) || 0;
  const c = Number(cid) || (await getCid(bvid));
  if (!c) return null;
  let stream = null;
  try { stream = await videoStream(bvid, c, qn); } catch { stream = null; }
  if (!stream) return null;           // 交给调用方退回雪碧图

  const dir = `/tmp/realframes-${bvid}-${Date.now()}`;
  fs.mkdirSync(dir, { recursive: true });
  const total = dur > 0 ? dur : 0;
  const at = [];
  if (total >= n * 2) {
    for (let i = 0; i < n; i++) at.push(Math.round((total * (i + 0.5)) / n));
  } else {
    for (let i = 0; i < n; i++) at.push(i * 2);      // 太短就每 2 秒一张
  }

  await ensureCookie();
  const src = `${dir}/src.m4s`;
  let ready = false;
  try { ready = await downloadStream(stream.url, src); } catch { ready = false; }
  if (!ready) { try { fs.rmSync(dir, { recursive: true, force: true }); } catch {} return null; }
  const out = [];
  for (let i = 0; i < at.length; i++) {
    const p = `${dir}/f${String(i).padStart(2, '0')}.jpg`;
    let ok = false;
    try { ok = grabAt(src, at[i], p); } catch { ok = false; }
    if (ok) out.push({ i, at: at[i], path: p, height: stream.height });
  }
  try { fs.unlinkSync(src); } catch {}
  if (out.length < 3) { try { fs.rmSync(dir, { recursive: true, force: true }); } catch {} return null; }
  return { info: { dir, height: stream.height, count: out.length }, frames: out, dir, real: true };
}
