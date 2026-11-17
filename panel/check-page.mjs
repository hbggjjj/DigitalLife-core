// 面板改完必跑：把页面里的 <script> 抽出来做语法检查
// 用法：node /srv/digitallife/panel/check-page.mjs
import fs from 'node:fs';
import { execFileSync } from 'node:child_process';

const src = fs.readFileSync('/srv/digitallife/panel/server.mjs', 'utf8');
const i = src.indexOf('<script>');
const j = src.indexOf('</script>', i);
if (i < 0 || j < 0) { console.error('没找到 <script> 段'); process.exit(2); }
const js = src.slice(i + 8, j);
fs.writeFileSync('/tmp/panel-page-check.js', js);
try {
  execFileSync(process.execPath, ['--check', '/tmp/panel-page-check.js'], { stdio: 'pipe' });
  console.log(`面板脚本语法 OK（${js.length} 字符）`);
} catch (e) {
  console.error('面板脚本语法错误：');
  console.error(String(e.stderr || e.message).split('\n').slice(0, 6).join('\n'));
  process.exit(1);
}
