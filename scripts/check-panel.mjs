// SPDX-License-Identifier: AGPL-3.0-or-later
// 面板自检：把页面里的每个 <script> 抽出来做语法检查，防止 HTML 插进 JS 里这种错。
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const url = process.env.PANEL_URL || 'http://127.0.0.1:7788/';
const html = await (await fetch(url, { signal: AbortSignal.timeout(8000) })).text();
const scripts = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map((m) => m[1]);
if (!scripts.length) { console.log('面板自检：页面里没有脚本'); process.exit(0); }
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'panel-'));
let bad = 0;
scripts.forEach((code, i) => {
  const f = path.join(dir, `s${i}.js`);
  fs.writeFileSync(f, code);
  try { execFileSync(process.execPath, ['--check', f], { stdio: 'pipe' }); }
  catch (e) { bad++; console.log(`脚本 #${i} 语法错误：` + String(e.stderr || '').split('\n').slice(0, 3).join(' ')); }
});
console.log(bad ? `面板自检 FAIL（${bad}/${scripts.length}）` : `面板自检 OK（${scripts.length} 个脚本）`);
process.exit(bad ? 1 : 0);
