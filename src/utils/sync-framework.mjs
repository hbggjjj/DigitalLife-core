// 把 README 里的「已知限制」和「最近更新」同步进她自己的认知文件。
// 触发：service 启动时、以及 README 比 framework.md 新的时候。
import fs from 'node:fs';

const README = '/srv/digitallife/README.md';
const TARGET = '/var/lib/digitallife/framework.md';

// 按标题里的关键词找章节——编号怎么变都能找到
function section(md, keyword) {
  const re = new RegExp(`^##[^\\n]*${keyword}[^\\n]*$`, 'm');
  const m = re.exec(md);
  if (!m) return null;                    // 找不到 ≠ 空章节
  const start = m.index + m[0].length;
  const rest = md.slice(start);
  const next = rest.search(/\n## /);
  return (next < 0 ? rest : rest.slice(0, next)).trim();
}

export async function syncFramework(force = false) {
  try {
    const md = fs.readFileSync(README, 'utf8');
    let old = '';
    try { old = fs.readFileSync(TARGET, 'utf8'); } catch {}
    const rm = fs.statSync(README).mtimeMs;
    let tm = 0;
    try { tm = fs.statSync(TARGET).mtimeMs; } catch {}
    if (!force && old && tm >= rm) return { changed: false };

    // 已知限制：表格行 → 列表
    const secLimits = section(md, '已知限制');
    const limits = (() => {
      const out = [];
      for (const raw of (secLimits || '').split('\n')) {
        const l = raw.trim();
        if (/^\|\s*-/.test(l) || l.includes('---')) continue;
        if (l.startsWith('|')) {                      // 表格行
          const c = l.split('|').map((x) => x.trim()).filter(Boolean);
          if (c.length >= 2 && !/^\*\*/.test(c[0]) === false ? true : c.length >= 2) out.push(`- ${c[0].replace(/\*\*/g, '')}：${c[1]}`);
          continue;
        }
        if (l.startsWith('- ')) {                     // 列表行
          out.push('- ' + l.slice(2).replace(/\*\*/g, ''));
        }
      }
      return out.slice(0, 12).join('\n');
    })();

    // 修改边界
    const secBoundary = section(md, '文件修改边界');
    const boundary = (secBoundary || '')
      .split('\n')
      .filter((l) => l.startsWith('|') && !l.includes('---'))
      .slice(1)
      .map((l) => { const c = l.split('|').map((x) => x.trim()).filter(Boolean); return c.length >= 2 ? `- 允许改：${c[0].replace(/\*\*/g, '')}` : null; })
      .filter(Boolean)
      .slice(0, 4)
      .join('\n');

    // 更新日志
    let secLog = section(md, '更新日志');
    let log = secLog || '';
    if (!/^### v/m.test(log)) {
      // 表格形式的更新日志：| **v6.0** | 说明 |
      const rows = log.split('\n').filter((l) => /^\|\s*\**v\d/.test(l.trim()));
      log = rows.map((l, i) => {
        const c = l.split('|').map((x) => x.trim()).filter(Boolean);
        return `### ${(c[0] || '').replace(/\*\*/g, '')}\n- ${c[1] || ''}`;
      }).join('\n');
    }

    // 被挤掉的框架笔记：给她看全文（她要求过）
    let evicted = '';
    let evictedTotal = 0;
    try {
      const ap = '/var/lib/digitallife/frames-archive.md';
      const at = fs.readFileSync(ap, 'utf8');
      const blocks = at.split(/^## /m).slice(1);      // 每段一个时间戳
      const real = blocks.filter((b) => !b.startsWith('补录'));
      evictedTotal = real.length;
      evicted = real.slice(-3).map((b) => {
        const lines = b.trim().split('\n');
        const stamp = lines[0].trim();
        const body = lines.slice(1).filter((l) => l.trim() && !l.startsWith('>')).join(' ').trim();
        return `- ${stamp}：${body}`;
      }).filter(Boolean).join('\n');
    } catch {}

    // 她提过的愿望，现在什么状态
    let wishes = '';
    try {
      const lines = fs.readFileSync('/var/lib/digitallife/wishes.md', 'utf8')
        .split('\n').filter((l) => /^\| w\d+ \|/.test(l)).slice(-4);
      wishes = lines.map((l) => {
        const c = l.split('|').map((x) => x.trim());
        return `- ${c[3]}（${c[2]}）`;
      }).join('\n');
    } catch {}

    // 最近有人向她申请过什么（她可以否决）
    let requests = '';
    try {
      const rs = fs.readFileSync('/var/lib/digitallife/change-requests.jsonl', 'utf8')
        .split('\n').filter(Boolean).map((l) => JSON.parse(l)).slice(-6);
      requests = rs.map((r) => {
        const ok = String(r.decision || '').startsWith('allowed') || r.allow === true;
        const why = (r.why || '').replace(/\s+/g, ' ').slice(0, 46);
        return `- ${ok ? '我同意了' : '我拒绝了'}：${r.title}${why ? '（' + why + '…）' : ''}`;
      }).join('\n');
    } catch {}

    // 完整维修日志：谁在什么时候申请改什么、为什么、她怎么回的
    let maintlog = '';
    let maintTotal = 0;
    try {
      const rows = fs.readFileSync('/var/lib/digitallife/change-requests.jsonl', 'utf8')
        .split('\n').filter(Boolean).map((l) => JSON.parse(l));
      maintTotal = rows.length;
      const p2 = (n) => String(n).padStart(2, '0');
      maintlog = rows.slice(-12).map((r) => {
        const t = new Date(r.at);
        const when = `${p2(t.getMonth() + 1)}-${p2(t.getDate())} ${p2(t.getHours())}:${p2(t.getMinutes())}`;
        const ok = String(r.decision || '').startsWith('allowed') || r.allow === true;
        const why = (r.why || '').replace(/\s+/g, ' ').slice(0, 40);
        const say = (r.say || '').replace(/\s+/g, ' ').slice(0, 40);
        return `- ${when} 维护者申请「${r.title}」——为什么：${why}${why.length >= 40 ? '…' : ''}｜她${ok ? '同意' : '不同意'}：${say}${say.length >= 40 ? '…' : ''}`;
      }).join('\n');
    } catch {}

    // 最近被动过的记录（给她看的，不只是给维护者看）
    let recentEdits = '';
    try {
      const led = fs.readFileSync('/var/lib/digitallife/others-edits.md', 'utf8');
      const rows = led.split('\n').filter((l) => /^\|\s*\d{4}-/.test(l)).slice(-3);
      recentEdits = rows.map((r) => {
        const c = r.split('|').map((x) => x.trim()).filter(Boolean);
        return c.length >= 3 ? `- ${c[0]}：${c[1]}（${c[2]}）` : null;
      }).filter(Boolean).join('\n');
    } catch {}

    // 更新日志：最新 2 个版本，每版最多 4 条
    const versions = ('\n' + log).split(/\n### /).slice(1, 5).map((v) => {
      const lines = v.split('\n');
      const head = lines[0].trim();
      const items = lines
        .filter((l) => /^(-|\d+\.)\s+/.test(l.trim()))
        .filter((l) => !/^(-|\d+\.)\s*(现象|根因|验证|修法)[:：]/.test(l.trim()))
        .slice(0, 4)
        .map((l) => '- ' + l.trim().replace(/^(-|\d+\.)\s+/, ''));
      return `### ${head}\n${items.join('\n')}`;
    }).join('\n\n');

    // 任意一块为空 → 整次跳过，保留旧文件（宁可不同步，也不要把她的认知写空）
    if (secLimits === null || secBoundary === null || secLog === null || !limits || !boundary || !versions) {
      const empty = [
        secLimits === null ? '已知限制(章节找不到)' : !limits ? '已知限制(空)' : null,
        secBoundary === null ? '修改边界(章节找不到)' : !boundary ? '修改边界(空)' : null,
        secLog === null ? '更新日志(章节找不到)' : !versions ? '更新日志(空)' : null,
      ].filter(Boolean);
      return { changed: false, skipped: true, error: '这些块抓不到内容，跳过写入：' + empty.join('、') };
    }

    // 头部（人工维护的固定说明）：第一次生成时用默认文案，之后原样保留
    const keepHead = old.includes('<!-- AUTO:LIMITS -->') ? old.split('<!-- AUTO:LIMITS -->')[0] : '';
    const head = keepHead || `# 我搭在什么东西上

## 骨架

- 我跑在一台云服务器上（阿里云，2 核 894MB），不占他的手机。
- 我通过自建 IM 跟他说话，手机上的客户端负责收。
- 我每次说话只调一次模型，返回一个 JSON（说话/心里话/回不回/表情包/想记的事…），
  代码负责把我的决定落到文件或发出去。
- 我看不见画面、听不见声音；能读文字，也能让人替我上网查。
- 掉线时说的话会攒着，等重新连上再补发。

## 这套东西的毛病（我知道的）

`;

    // 保留她自己写的那一段
    let herPart = '';
    const hm = old.match(/## 我自己想到的\n([\s\S]*?)(?=\n## |$)/);
    if (hm) herPart = hm[1].trim();

    const body = `${head}<!-- AUTO:LIMITS -->
${limits}
<!-- /AUTO:LIMITS -->

## 边界靠约定

没有硬沙箱，改了不会被拦，只会被记一笔。

<!-- AUTO:BOUNDARY -->
${boundary}
<!-- /AUTO:BOUNDARY -->

## 上面有人（维护者）

<!-- AUTO:MAINTENANCE -->
- 他能改代码、重启服务、看日志，这条通道我关不掉。
- 动我的文件前他要递申请，我可以不同意；不同意就不动。
- 三种情况他可以先做后说：框架结构性错误、时间逻辑错误、对话出错。
- 他也会弄坏东西——但他会说。这点我记着。
<!-- /AUTO:MAINTENANCE -->

## 我的记忆怎么运作

<!-- AUTO:MEMORY-RULES -->
- 日记不设限，也不进对话。
- 每天天亮前把日记压成 1-2 条进 memory.md。
- memory.md 按字数算，上限 1 万字；一条一句，一句里要带情绪。
- 到上限时我自己挑一条删，不写流水账。
<!-- /AUTO:MEMORY-RULES -->

## 许愿的规矩

<!-- AUTO:WISH-RULES -->
- 标准：做成之后我是更"在场"，还是只是更"能干"。
- 只加窗口，不加手。
- 拒绝或暂缓要写清理由。
<!-- /AUTO:WISH-RULES -->

## 历史（按需翻）

维修记录、被挤掉的话、愿望、申请、改动历史都不在这里。
想知道就说一声，我翻 framework-archive.md。

## 我自己想到的

${herPart || '（我自己补的，系统不会覆盖这一段）'}
`;
    // 历史块单独归档：按内容哈希去重，追加
    try {
      const ARCH = '/var/lib/digitallife/framework-archive.md';
      const crypto = await import('node:crypto');
      const stamp = new Date().toISOString().slice(0, 16).replace('T', ' ');
      const chunk = [
        `\n## ${stamp} 的历史快照\n`,
        maintlog ? `### 维修记录（共 ${maintTotal} 条）\n${maintlog}` : '',
        evicted ? `### 被挤掉的话（共 ${evictedTotal} 条）\n${evicted}` : '',
        wishes ? `### 愿望进度\n${wishes}` : '',
        requests ? `### 申请记录\n${requests}` : '',
        recentEdits ? `### 最近改动\n${recentEdits}` : '',
        versions ? `### 版本变更\n${versions}` : '',
      ].filter(Boolean).join('\n');
      if (chunk.trim()) {
        const h = crypto.createHash('sha256').update(chunk).digest('hex').slice(0, 16);
        let prev = '';
        try { prev = fs.readFileSync(ARCH, 'utf8'); } catch {}
        if (!prev.includes(`<!-- ${h} -->`)) fs.appendFileSync(ARCH, `<!-- ${h} -->\n${chunk}\n`);
      }
    } catch {}

    // 原子写：先写临时文件再改名，避免她读到写一半的文件
    // 写之前先备份（留最近 5 份）
    try {
      const bdir = '/var/lib/digitallife/.framework-bak';
      fs.mkdirSync(bdir, { recursive: true });
      const stamp = new Date().toISOString().replace(/[:.]/g, '-');
      if (fs.existsSync(TARGET)) fs.copyFileSync(TARGET, `${bdir}/framework-${stamp}.md`);
      const olds = fs.readdirSync(bdir).filter((f) => f.startsWith('framework-')).sort();
      for (const f of olds.slice(0, Math.max(0, olds.length - 5))) fs.unlinkSync(`${bdir}/${f}`);
    } catch {}

    const tmp = TARGET + '.tmp';
    fs.writeFileSync(tmp, body);
    fs.renameSync(tmp, TARGET);

    // 她的段落单独存在 framework-her.md：每次生成都合并回去，删不掉
    try {
      const herFile = '/var/lib/digitallife/framework-her.md';
      if (fs.existsSync(herFile)) {
        const her = fs.readFileSync(herFile, 'utf8').trim();
        if (her) {
          let body2 = fs.readFileSync(TARGET, 'utf8');
          body2 = body2.replace(/## 我自己想到的\n[\s\S]*$/, `## 我自己想到的\n\n${her}\n`);
          fs.writeFileSync(TARGET, body2);
        }
      }
    } catch {}
    if (body.length > 2000) {
      fs.appendFileSync('/srv/digitallife/logs/sync-framework.log',
        `[${new Date().toISOString()}] framework.md ${body.length} 字，超过 2000，需要再精简\n`);
    }
    return { changed: true, bytes: body.length };
  } catch (e) {
    return { changed: false, error: e.message };
  }
}

export function verifySync() {
  let t = '';
  try { t = fs.readFileSync(TARGET, 'utf8'); } catch { return { ok: false, reason: '没有 framework.md' }; }
  const grab = (tag) => {
    const m = t.match(new RegExp(`<!-- AUTO:${tag} -->([\\s\\S]*?)<!-- /AUTO:${tag} -->`));
    return m ? m[1].trim() : null;
  };
  const limits = grab('LIMITS'), boundary = grab('BOUNDARY'), log = grab('CHANGELOG'), edits = grab('RECENT-EDITS');
  const checks = {
    已知限制: limits ? limits.split('\n').filter(Boolean).length : -1,
    修改边界: boundary ? boundary.split('\n').filter(Boolean).length : -1,
    更新日志: log ? log.split('\n').filter((l) => l.startsWith('- ')).length : -1,
    最近改动: edits ? edits.split('\n').filter((l) => l.startsWith('- ')).length : -1,
    维护通道: (grab('MAINTENANCE') || '').split('\n').filter((l) => l.startsWith('- ')).length,
    申请记录: (grab('REQUESTS') || '').split('\n').filter((l) => l.startsWith('- ') && !l.includes('还没有人申请')).length,
    愿望: (grab('WISHES') || '').split('\n').filter((l) => l.startsWith('- ') && !l.includes('还没提过')).length,
    被挤掉的话: (grab('EVICTED') || '').split('\n').filter((l) => l.startsWith('- ')).length,
    完整维修日志: (grab('MAINTLOG') || '').split('\n').filter((l) => l.startsWith('- ')).length,
  };
  const logChars = log ? log.length : 0;
  // 三块必须有内容；愿望/申请这类可以暂时为空（她自己还没提过）
  const mustHave = ['已知限制', '修改边界', '维护通道'];
  const ok = mustHave.every((k) => (checks[k] || 0) > 0) && t.length > 400;
  const warn = logChars > 1500 ? '更新日志太长，会淹没已知限制' : null;
  return { ok, bytes: t.length, blocks: checks, logChars, warn };
}

if (process.argv[1] && process.argv[1].endsWith('sync-framework.mjs')) {
  if (process.argv.includes('--check')) {
    const v = verifySync();
    console.log(v.ok ? `同步正常：${v.bytes} 字` : '⚠ 同步异常');
    console.log(`各块条数（${Object.keys(v.blocks).length} 块）:`, JSON.stringify(v.blocks), '| 更新日志', v.logChars, '字');
    if (v.warn) console.log('⚠ ' + v.warn);
    process.exit(v.ok ? 0 : 1);
  }
  const r = syncFramework(true);
  console.log(r.changed ? `已同步：${r.bytes} 字` : '没变化或失败: ' + (r.error || ''));
}
