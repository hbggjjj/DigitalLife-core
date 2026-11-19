// SPDX-License-Identifier: AGPL-3.0-or-later
// 上下文组装：按"轮次"而不是按"条数"截取。
// 原则：不删她说过的任何话，只把连续的单向独白压成一行，防止模型被自己的焦虑反复喂。
export function buildContext(history, { maxTurns = 4, maxLines = 16 } = {}) {
  const list = Array.isArray(history) ? history : [];

  // 1) 连续同向的压成段
  const segs = [];
  for (const h of list) {
    const last = segs[segs.length - 1];
    if (last && last.dir === h.dir) { last.items.push(h); continue; }
    segs.push({ dir: h.dir, items: [h] });
  }

  // 2) 从后往前保留最近 maxTurns 个"有他发言"的轮次
  const keep = [];
  let turns = 0;
  for (let i = segs.length - 1; i >= 0; i--) {
    keep.unshift(segs[i]);
    if (segs[i].dir === 'in') turns++;
    if (turns >= maxTurns) break;
  }

  // 3) 她连发 3 条以上：第一条原样，其余合一句"后面又说了 N 句"
  const out = [];
  for (const s of keep) {
    if (s.dir === 'out' && s.items.length >= 3) {
      const [first, ...rest] = s.items;
      out.push(fmt(first));
      const tail = rest.map((x) => x.text).join(' / ').slice(0, 140);
      out.push(`[我·连着又说了 ${rest.length} 句，他没回] ${tail}`);
    } else {
      for (const h of s.items) out.push(fmt(h));
    }
  }
  return out.slice(-maxLines);
}

function fmt(h) {
  const who = h.dir === 'out' ? '我' : '你';
  let tag = h.dir === 'out'
    ? (h.via === 'web' ? '我·网页' : '我·QQ')
    : (h.via === 'web' ? '他·网页' : '他·QQ');
  if (h.agent) tag += '·维护者代发（不是他本人）';
  if (h.resend) tag += '·补发（当时被系统拦下）';
  if (h.corrected) tag += '·原话有错别字';
  if (h.sys) tag = '系统';
  // 带上时间：不然她只能靠猜"这是几点说的"
  let t = '';
  if (h.at) {
    const d = new Date(Number(h.at) + 8 * 3600e3);
    const hh = String(d.getUTCHours()).padStart(2, '0');
    const mi = String(d.getUTCMinutes()).padStart(2, '0');
    t = `${hh}:${mi} `;
  }
  return `[${tag}] ${who}${t ? ' ' + t : ' '}: ${h.text}`;
}
