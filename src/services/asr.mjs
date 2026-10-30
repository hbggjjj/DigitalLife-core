// 云语音识别（阿里云智能语音 一句话识别）：给"没字幕的视频"补上"说了什么"
// 隐私约定：音频只在本机切片、即时上传、用完即删；文字只进这一次的上下文，不写归档。
import fs from 'node:fs';
import { execFileSync } from 'node:child_process';
import { http4 } from '../utils/http4.mjs';
import { ensureToken } from './asr-token.mjs';

const ENDPOINT = 'https://nls-gateway-cn-shanghai.aliyuncs.com/stream/v1/asr';
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/124.0 Safari/537.36';

function cfgOf(all) {
  const a = all.asr || {};
  return {
    enabled: a.enabled !== false && !!a.appkey && !!a.token,
    appkey: a.appkey || '',
    token: a.token || '',
    maxSeconds: Number(a.maxSeconds || 240),   // 最多转 4 分钟，防烧钱
    segSeconds: Number(a.segSeconds || 50),    // 阿里云一句话识别上限 60 秒
    log: a.log !== false,
  };
}

async function transcribeSeg(buf, c) {
  const url = `${ENDPOINT}?appkey=${encodeURIComponent(c.appkey)}&format=mp3&sample_rate=16000&enable_punctuation_prediction=true&enable_inverse_text_normalization=true`;
  const r = await http4(url, {
    method: 'POST',
    headers: { 'X-NLS-Token': c.token, 'Content-Type': 'application/octet-stream' },
    body: buf,
    timeout: 25000,
  });
  let j;
  try { j = r.json(); } catch { return { ok: false, reason: '返回不是 JSON：' + r.text().slice(0, 80) }; }
  if (j.status !== 20000000) {
    const expired = /token|expire|40000001|40000004/i.test(String(j.message || '') + j.status);
    return { ok: false, reason: (expired ? 'Token 可能过期：' : '识别失败：') + (j.message || j.status) };
  }
  return { ok: true, text: String(j.result || '').trim() };
}

/**
 * 从一个音频地址转出文字。返回 { ok, text, segments, seconds, cost }
 * 音频只在 /tmp 里活一会儿，函数结束前删掉。
 */
export async function transcribeUrl(audioUrl, allCfg, { referer = 'https://www.bilibili.com/', maxSeconds } = {}) {
  const c = cfgOf(allCfg);
  if (!c.enabled) return { ok: false, reason: 'ASR 没配置（缺 appkey/token）' };
  // 自动续期：快过期就用 AK/SK 换新的
  try {
    const fresh = await ensureToken(allCfg);
    if (fresh) c.token = fresh;
  } catch (e) {
    return { ok: false, reason: 'Token 续期失败：' + e.message.slice(0, 80) };
  }
  const limit = Math.min(maxSeconds || c.maxSeconds, c.maxSeconds);
  const dir = `/tmp/asr-${Date.now()}`;
  fs.mkdirSync(dir, { recursive: true });
  try {
    // 用 ffmpeg 直接拉流并切片（不整段落盘）
    execFileSync('ffmpeg', [
      '-y',
      '-headers', `Referer: ${referer}\r\nUser-Agent: ${UA}\r\n`,
      '-i', audioUrl,
      '-t', String(limit),
      '-ar', '16000', '-ac', '1', '-b:a', '64k',
      '-f', 'segment', '-segment_time', String(c.segSeconds),
      `${dir}/s%03d.mp3`,
    ], { stdio: 'ignore', timeout: 90000 });

    const files = fs.readdirSync(dir).filter((f) => f.endsWith('.mp3')).sort();
    if (!files.length) return { ok: false, reason: '没切出音频（可能这段视频没有音轨）' };

    const parts = [];
    let okCount = 0;
    let lastReason = '';
    for (const f of files) {
      const buf = fs.readFileSync(`${dir}/${f}`);
      if (!buf.length) continue;
      const r = await transcribeSeg(buf, c);
      if (r.ok) { okCount++; if (r.text) parts.push(r.text); }
      else { lastReason = r.reason; }
    }
    fs.rmSync(dir, { recursive: true, force: true });
    if (!okCount) return { ok: false, reason: lastReason || '全部识别失败' };
    return {
      ok: true,
      text: parts.join(' ').slice(0, 4000),
      segments: okCount,
      seconds: limit,
      costYuan: Number((okCount * 0.003).toFixed(3)),
    };
  } catch (e) {
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch {}
    return { ok: false, reason: e.message.slice(0, 120) };
  }
}
