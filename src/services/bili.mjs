// 她的 B 站眼睛：只取文字（标题/简介/UP/播放量），不下视频、不看画面
import fs from 'node:fs';
import dns from 'node:dns';
import { cookie as biliCookie } from './bili_login.mjs';
import { http4 } from '../utils/http4.mjs';
import { transcribeUrl } from './asr.mjs';

// 这台的 IPv6 不通（api.bilibili.com 先解析到 240e:… 然后超时）：优先走 IPv4
try { dns.setDefaultResultOrder('ipv4first'); } catch {}

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/124.0 Safari/537.36';

async function api(path, params = {}, tries = 2) {
  const qs = new URLSearchParams(params).toString();
  const url = `https://api.bilibili.com${path}${qs ? '?' + qs : ''}`;
  let lastErr;
  for (let i = 1; i <= tries; i++) {
    try {
      const r = await http4(url, {
        headers: { 'User-Agent': UA, Referer: 'https://www.bilibili.com/', ...(biliCookie() ? { Cookie: biliCookie() } : {}) },
        timeout: i === 1 ? 6000 : 15000,
      });
      if (r.status < 200 || r.status >= 300) throw new Error(`bili HTTP ${r.status}`);
      const d = r.json();
      if (d.code !== 0) throw new Error(`bili code ${d.code}`);
      return d.data;
    } catch (e) {
      lastErr = e;
      if (i < tries) await new Promise((r) => setTimeout(r, 900));
    }
  }
  throw lastErr;
}

/**
 * B 站首页推荐流——就是"往下刷"的那种。
 * 每次请求 fresh_idx 不同，拿到的是不同的一批，交给 B 站自己推。
 */
export async function feed(n = 4) {
  const idx = (Math.floor(Date.now() / 60000) % 5) + 1;   // 每分钟换一个位置
  const d = await api('/x/web-interface/wbi/index/top/feed/rcmd', { ps: n, fresh_idx: idx, fresh_type: 4 });
  return (d.item || []).slice(0, n).map((v) => ({
    title: clean(v.title),
    desc: clean(v.desc || v.rcmd_reason?.content || '').slice(0, 80),
    up: v.owner?.name || '',
    view: num(v.stat?.view),
    danmaku: num(v.stat?.danmaku),
    dur: dur(v.duration),
    bvid: v.bvid,
  }));
}

const clean = (s) => String(s || '').replace(/<[^>]+>/g, '').replace(/&quot;/g, '"').replace(/&amp;/g, '&').trim();
const dur = (sec) => {
  const m = Math.floor((sec || 0) / 60), s = (sec || 0) % 60;
  return `${m}:${String(s).padStart(2, '0')}`;
};
const num = (n) => (n >= 10000 ? (n / 10000).toFixed(1) + '万' : String(n || 0));

/** B 站热门 */
export async function popular(n = 5) {
  const d = await api('/x/web-interface/popular', { ps: n, pn: 1 });
  return (d.list || []).slice(0, n).map((v) => ({
    title: clean(v.title),
    desc: clean(v.desc).slice(0, 80),
    up: v.owner?.name || '',
    view: num(v.stat?.view),
    danmaku: num(v.stat?.danmaku),
    dur: dur(v.duration),
    bvid: v.bvid,
  }));
}

/** 搜视频 */
export async function search(keyword, n = 4) {
  const d = await api('/x/web-interface/wbi/search/type', { search_type: 'video', keyword: String(keyword).slice(0, 40) });
  return (d.result || []).slice(0, n).map((v) => ({
    title: clean(v.title),
    desc: clean(v.description).slice(0, 80),
    up: v.author || '',
    view: num(v.play),
    dur: v.duration || '',
    bvid: v.bvid,
  }));
}

/** 点开一个视频：拿标题/简介/标签/弹幕/评论——全是文字，没有画面 */
export async function detail(bvid) {
  const out = { bvid };
  try {
    const v = await api('/x/web-interface/view', { bvid });
    out.title = clean(v.title);
    out.desc = clean(v.desc).slice(0, 400);
    out.up = v.owner?.name || '';
    out.dur = dur(v.duration);
    out.view = num(v.stat?.view);
    out.aid = v.aid;
    out.cid = v.cid;
    out.tname = v.tname || '';
  } catch (e) { return null; }

  // 标签
  try {
    const t = await api('/x/tag/archive/tags', { bvid });
    out.tags = (t || []).slice(0, 8).map((x) => x.tag_name);
  } catch { out.tags = []; }

  // 弹幕：取前 300 条，去重后按频率挑
  try {
    const r = await fetch(`https://api.bilibili.com/x/v1/dm/list.so?oid=${out.cid}`, {
      headers: { 'User-Agent': UA, Referer: 'https://www.bilibili.com/', ...(biliCookie() ? { Cookie: biliCookie() } : {}) },
      signal: AbortSignal.timeout(12000),
    });
    const xml = await r.text();
    const all = [...xml.matchAll(/<d p="[^"]*">([^<]*)<\/d>/g)].map((m) => clean(m[1])).filter(Boolean);
    const freq = new Map();
    for (const x of all) freq.set(x, (freq.get(x) || 0) + 1);
    out.danmaku = [...freq.entries()].sort((a, b) => b[1] - a[1]).slice(0, 15).map(([x, n]) => (n > 1 ? `${x}(×${n})` : x));
    out.danmakuTotal = all.length;
  } catch { out.danmaku = []; }

  // CC 字幕（要登录 cookie；大部分视频没有）
  try {
    out.subtitle = await subtitle(bvid, out.cid);
  } catch { out.subtitle = null; }

  // 没字幕：如果开了云 ASR，就听一小段（只给"说了什么"，不给旋律）
  if (!out.subtitle) {
    try {
      const cfgAll = JSON.parse(fs.readFileSync('__MIKU_ROOT__/bot/config.json', 'utf8'));
      if (cfgAll.asr && cfgAll.asr.enabled) {
        const pu = await api('/x/player/playurl', { bvid, cid: out.cid, fnval: 16 });
        const audioUrl = pu?.dash?.audio?.[0]?.baseUrl || pu?.dash?.audio?.[0]?.base_url;
        const dur = Number(out.durSec || 0);
        if (audioUrl && (!dur || dur <= 600)) {
          const t = await transcribeUrl(audioUrl, cfgAll, { maxSeconds: Math.min(240, dur || 240) });
          if (t.ok) {
            out.asr = t;
            out.asrCost = t.costYuan;
            out.subtitle = '（没有字幕，这是语音转写，可能听错字）' + t.text;
          } else if (t.reason) {
            out.asrFail = t.reason;
          }
        }
      }
    } catch (e) { out.asrFail = e.message.slice(0, 60); }
  }

  // 热门评论
  try {
    const rp = await api('/x/v2/reply', { type: 1, oid: out.aid, sort: 2, ps: 6 });
    out.comments = (rp.replies || []).slice(0, 6).map((c) => clean(c.content?.message).slice(0, 90)).filter(Boolean);
  } catch { out.comments = []; }

  return out;
}

/** 有登录 cookie 时能拿到 CC 字幕原文 */
export async function subtitle(bvid, cid) {
  const ck = biliCookie();
  if (!ck) return null;
  try {
    const r = await fetch(`https://api.bilibili.com/x/player/wbi/v2?bvid=${bvid}&cid=${cid}`, {
      headers: { 'User-Agent': UA, Referer: 'https://www.bilibili.com/', Cookie: ck },
      signal: AbortSignal.timeout(12000),
    });
    const d = await r.json();
    const list = d?.data?.subtitle?.subtitles || [];
    if (!list.length) return null;
    // 作者字幕优先，其次 B 站 AI 字幕（ai-zh / ai-en 之类）
    const pick = list.find((x) => x.lan === 'zh-CN')
      || list.find((x) => /^ai-zh/.test(x.lan || ''))
      || list.find((x) => /zh/.test(x.lan || ''))
      || list[0];
    const url = pick?.subtitle_url;
    if (!url) return null;
    const full = url.startsWith('//') ? 'https:' + url : url;
    const t = await fetch(full, { headers: { 'User-Agent': UA }, signal: AbortSignal.timeout(15000) });
    const j = await t.json();
    const lines = (j.body || []).map((x) => x.content).filter(Boolean);
    const text = lines.join(' ').slice(0, 3000) || null;
    if (text && /^ai-/.test(pick?.lan || '')) {
      return `【这是 B 站 AI 自动转的字幕，可能有错字，按大意听】${text}`;
    }
    return text;
  } catch { return null; }
}

export function formatDetail(d) {
  if (!d) return '（没打开）';
  const L = [`《${d.title}》— ${d.up}｜${d.dur}｜${d.view} 播放`];
  if (d.tname) L.push(`分区：${d.tname}`);
  if (d.tags?.length) L.push(`标签：${d.tags.join('、')}`);
  if (d.desc) L.push(`简介：${d.desc}`);
  if (d.danmaku?.length) L.push(`弹幕里出现最多的：${d.danmaku.join(' / ')}（共 ${d.danmakuTotal} 条）`);
  if (d.comments?.length) L.push(`热评：\n- ` + d.comments.join('\n- '));
  if (d.subtitle) L.push(`字幕/语音转写（可以参考）：\n${d.subtitle.slice(0, 1200)}`);
  else L.push('这个视频没有字幕（作者没传，B 站也没自动转）：你只能看画面和弹幕，别假装听懂了。');
  return L.join('\n');
}

export function format(list, src = '') {
  if (!list || !list.length) return '（没刷到什么）';
  return list.map((v, i) => `${i + 1}. 《${v.title}》— ${v.up}｜${v.view} 播放｜${v.dur}${v.desc ? '｜' + v.desc : ''}`).join('\n').slice(0, 900);
}
