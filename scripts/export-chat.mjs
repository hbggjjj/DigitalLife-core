#!/usr/bin/env node
// 把永久归档渲染成可读的 Markdown
import fs from 'node:fs';
import path from 'node:path';

const LIFE = process.env.LIFE_DIR || '__MIKU_HOME__';
const ARC = path.join(LIFE, 'chat-archive.jsonl');
const out = process.argv[2] || path.join('__MIKU_ROOT__/exports', '对话全档.md');

let rows = [];
try {
  rows = fs.readFileSync(ARC, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
} catch { console.error('没有归档文件：' + ARC); process.exit(1); }

rows.sort((a, b) => a.at - b.at);
// 去重（同 dir/text/秒）
const seen = new Set();
rows = rows.filter((r) => {
  const k = r.dir + '|' + r.text + '|' + Math.floor(r.at / 1000);
  if (seen.has(k)) return false;
  seen.add(k); return true;
});

const p2 = (n) => String(n).padStart(2, '0');
const lines = ['# 她与他的完整对话（永久归档）', '',
  `> 导出：${new Date().toLocaleString('zh-CN', { hour12: false })}`,
  `> 共 ${rows.length} 条 | 归档文件：~/life/chat-archive.jsonl`, ''];
let day = null;
for (const r of rows) {
  const d = new Date(r.at);
  const dstr = `${d.getFullYear()}-${p2(d.getMonth() + 1)}-${p2(d.getDate())}`;
  if (dstr !== day) { lines.push('', `## ${dstr}`, ''); day = dstr; }
  const who = r.dir === 'out' ? '她' : '他';
  const tags = [];
  if (r.via === 'web') tags.push('网页'); else if (r.via === 'qq') tags.push('QQ');
  if (r.agent) tags.push('代发');
  if (r.resend) tags.push('补发');
  if (r.denied) tags.push('她否认过');
  if (r.src === 'log') tags.push('从日志恢复');
  lines.push(`- **${p2(d.getHours())}:${p2(d.getMinutes())} ${who}${tags.length ? '（' + tags.join('·') + '）' : ''}**：${r.text}`);
}
fs.mkdirSync(path.dirname(out), { recursive: true });
fs.writeFileSync(out, lines.join('\n'));
console.log('写出', out, fs.statSync(out).size, '字节，', rows.length, '条');
