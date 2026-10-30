// 她的"眼睛"：由我们替她上网取信息，她本身不碰网络。
// 只用公开 RSS / 搜索结果，限时、限量、去标签。
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36';

function decode(s) {
  return String(s)
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1')
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"').replace(/&#39;/g, "'")
    .replace(/&amp;/g, '&').replace(/&nbsp;/g, ' ')
    .replace(/<[^>]+>/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

async function get(url, timeoutMs = 12000) {
  const r = await fetch(url, {
    headers: { 'User-Agent': UA, 'Accept': 'application/rss+xml, application/xml, text/xml, text/html,*/*' },
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  const buf = await r.arrayBuffer();
  return new TextDecoder('utf-8').decode(buf.slice(0, 400 * 1024));
}

function parseRss(xml, limit = 6) {
  const items = [];
  const blocks = xml.split(/<item[\s>]/i).slice(1);
  for (const b of blocks.slice(0, limit)) {
    const t = (b.match(/<title>([\s\S]*?)<\/title>/i) || [])[1];
    const d = (b.match(/<description>([\s\S]*?)<\/description>/i) || [])[1];
    const l = (b.match(/<link>([\s\S]*?)<\/link>/i) || [])[1];
    if (t) items.push({ title: decode(t), desc: decode(d || '').slice(0, 160), link: decode(l || '') });
  }
  return items;
}

/** 搜索：Bing 的 RSS 接口，返回 [{title,desc,link}] */
export async function search(query, limit = 5) {
  const q0 = String(query).slice(0, 80);
  const q = encodeURIComponent(q0);
  let xml = await get(`https://www.bing.com/search?q=${q}&format=rss&setlang=zh-CN`);
  let items = parseRss(xml, limit);

  // 这版 Bing 对多词中文查询基本失效（常回词典/0 条）：先判断结果是否"答非所问"
  const junky = (arr) => !arr.length
    || arr.every((x) => /字典|拼音|部首|笔顺|汉语|百科/.test(x.title + ' ' + (x.link || '')));

  if (junky(items)) {
    // 真人的说法：用 B 站搜索（她能接受的来源），把视频标题当成"别人怎么说"
    try {
      const { search: biliSearch } = await import('./bili.mjs');
      const term = q0.replace(/评价|怎么样|好听|好看|风评|口碑|值得吗?|推荐吗/g, '').trim() || q0;
      const vids = await biliSearch(term, limit);
      if (vids && vids.length) {
        return vids.map((v) => ({
          title: (v.title || '').slice(0, 60),
          desc: 'B 站上的视频（标题就是别人怎么讲这件事）',
          link: v.link || ('https://www.bilibili.com/video/' + (v.bvid || '')),
        }));
      }
    } catch {}
    // 再退一步：用第一个词单独搜（短查询在这条线里是好的）
    try {
      const first = q0.split(/\s+/)[0];
      if (first && first !== q0) {
        const xml3 = await get(`https://www.bing.com/search?q=${encodeURIComponent(first)}&format=rss&setlang=zh-CN`);
        const r3 = parseRss(xml3, limit);
        if (r3.length && !junky(r3)) return r3;
      }
    } catch {}
    return [];
  }
  return items;
}

/** 读一个 RSS 源的最新条目 */
export async function feed(url, limit = 6) {
  const xml = await get(url);
  return parseRss(xml, limit);
}

/** 今日热点：科技/生活类 RSS，多源合并 */
export async function headlines(limit = 8) {
  const sources = ['https://www.36kr.com/feed', 'https://sspai.com/feed'];
  const out = [];
  for (const u of sources) {
    try {
      const items = await feed(u, 4);
      for (const it of items) out.push({ ...it, src: u.includes('36kr') ? '36氪' : '少数派' });
    } catch {}
  }
  return out.slice(0, limit);
}

/** 把搜索结果压成一段给模型看的文本 */
export function format(results) {
  if (!results || !results.length) return '（没搜到有用的）';
  return results.map((r, i) => `${i + 1}. ${r.title}${r.desc ? ' — ' + r.desc : ''}`).join('\n').slice(0, 1600);
}
