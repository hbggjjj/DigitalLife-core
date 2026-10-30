// 愿望单自动审计：判断 → 决定 → （能做的）备份后执行 → 自测 → 写回理由
import fs from 'node:fs';
import { execFileSync } from 'node:child_process';

const LIFE = process.env.LIFE_DIR || '__MIKU_HOME__';
const WISHES = `${LIFE}/wishes.md`;
const ROOT = process.env.QQBOT_ROOT || '__MIKU_ROOT__';

// —— 能自动做的能力模板（白名单）——
const TEMPLATES = {
  weather: {
    name: '查天气',
    match: /天气|下雨|气温|冷|热/,
    risk: 'low',
    async run() {
      const r = await fetch('https://wttr.in/?format=j1&lang=zh', { signal: AbortSignal.timeout(15000) });
      if (!r.ok) throw new Error('wttr 返回 ' + r.status);
      const j = await r.json();
      const cur = j.current_condition?.[0] || {};
      const area = j.nearest_area?.[0]?.areaName?.[0]?.value || '';
      return `${area} 现在 ${cur.temp_C}°C，${cur.lang_zh?.[0]?.value || cur.weatherDesc?.[0]?.value || ''}，体感 ${cur.FeelsLikeC}°C`;
    },
  },
};

function readRows() {
  const txt = fs.readFileSync(WISHES, 'utf8');
  return txt.split('\n')
    .map((l) => l.trim())
    .filter((l) => /^\| w\d+ \|/.test(l))
    .map((l) => {
      const c = l.split('|').map((x) => x.trim());
      return { line: l, id: c[1], status: c[2], what: c[3], note: c[4] || '' };
    });
}

function setRow(id, status, note) {
  let txt = fs.readFileSync(WISHES, 'utf8');
  const re = new RegExp(`^\\| ${id} \\|.*$`, 'm');
  const row = txt.match(re)?.[0];
  if (!row) return false;
  const c = row.split('|').map((x) => x.trim());
  const what = c[3];
  const oldNote = (c[4] || '').trim();
  const newNote = note ? (oldNote ? oldNote + '；' : '') + note : oldNote;
  txt = txt.replace(re, `| ${id} | ${status} | ${what} | ${newNote} |`);
  fs.writeFileSync(WISHES, txt);
  return true;
}

/** 审计一条愿望：返回 { verdict, why, template } */
export function judge(wish) {
  const text = wish.what || '';
  for (const [key, t] of Object.entries(TEMPLATES)) {
    if (t.match.test(text)) return { verdict: 'implement', why: `能用「${t.name}」模板做，风险低`, template: key };
  }
  if (/看|听|视频|画面|声音|语音|身体|脸/.test(text)) {
    return { verdict: 'defer', why: '这是感官能力。DeepSeek 只吃文字和静态图，做不到真实的声音和连续动作。' };
  }
  if (/改代码|自己动手|权限|凭证|数据库/.test(text)) {
    return { verdict: 'reject', why: '这不是能力问题，是边界问题。' };
  }
  return { verdict: 'defer', why: '没有现成模板，需要人工判断值不值得做。' };
}

/** 跑一遍待评估的愿望 */
export async function auditAll({ dry = false } = {}) {
  const rows = readRows().filter((r) => /待评估/.test(r.status));
  const out = [];
  for (const w of rows) {
    const d = judge(w);
    if (dry) { out.push({ id: w.id, ...d }); continue; }

    if (d.verdict === 'implement' && TEMPLATES[d.template]) {
      // 1) 先备份
      let backedUp = false;
      try { execFileSync('bash', [`${ROOT}/scripts/snapshot.sh`], { timeout: 60000 }); backedUp = true; } catch {}
      // 2) 执行
      let result = '';
      try {
        result = await TEMPLATES[d.template].run();
        // 3) 自测（再跑一次，确认不是偶然）
        const again = await TEMPLATES[d.template].run();
        setRow(w.id, '已实现 ' + today(), `${d.why}；实测：${result}${again ? '（复测通过）' : ''}${backedUp ? '；做之前已备份' : ''}`);
        out.push({ id: w.id, verdict: 'implemented', result });
        continue;
      } catch (e) {
        setRow(w.id, '暂缓 ' + today(), `${d.why}；执行失败：${e.message}`);
        out.push({ id: w.id, verdict: 'failed', error: e.message });
        continue;
      }
    }
    setRow(w.id, (d.verdict === 'reject' ? '没做成 ' : '暂缓 ') + today(), d.why);
    out.push({ id: w.id, verdict: d.verdict, why: d.why });
  }
  return out;
}

function today() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}
