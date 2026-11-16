#!/usr/bin/env node
// SPDX-License-Identifier: AGPL-3.0-or-later
// 粗粒度引用检查：找"调用了但没定义/没 import"的名字。
// 目的不是做类型检查，是拦住"加了新模块但忘了 import"这类致命遗漏。
import fs from 'node:fs';
import path from 'node:path';

const ROOTS = ['src', 'bot', 'panel', 'tools'];
const GLOBALS = new Set(['print','resolve','reject','async','send','await','FormData','Blob','File','Headers','Request','Response','Signature','SHA1','scale','translateX','translateY','rotate','opacity','console','JSON','Math','Object','Array','String','Number','Boolean','Promise','Date','RegExp','Error','TypeError','RangeError','SyntaxError','Set','Map','WeakMap','WeakSet','Symbol','BigInt','Intl','Reflect','Proxy','fetch','require','process','Buffer','URL','URLSearchParams','TextEncoder','TextDecoder','AbortSignal','AbortController','setTimeout','clearTimeout','setInterval','clearInterval','setImmediate','queueMicrotask','structuredClone','encodeURIComponent','decodeURIComponent','encodeURI','decodeURI','parseInt','parseFloat','isNaN','isFinite','atob','btoa','crypto','globalThis','undefined','typeof','await','if','for','while','switch','catch','return','function','constructor','super','import','new','delete','void','yield','of','in','do','else','try','finally','this','true','false','null']);

function walk(dir, out = []) {
  let ents = [];
  try { ents = fs.readdirSync(dir, { withFileTypes: true }); } catch { return out; }
  for (const e of ents) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p, out);
    else if (e.name.endsWith('.mjs')) out.push(p);
  }
  return out;
}

function stripNoise(src) {
  // 顺序很重要：先把字符串/模板串换成空，再删注释。
  // 否则 URL 里的 // 会被当注释，把后面整行吃掉。
  return src
    .replace(/`(?:\\.|[^`\\])*`/g, ' "" ')
    .replace(/'(?:\\.|[^'\\])*'/g, ' "" ')
    .replace(/"(?:\\.|[^"\\])*"/g, ' "" ')
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/^\s*\/\/.*$/gm, ' ');
}

function collect(srcRaw) {
  const src = stripNoise(srcRaw);
  const imported = new Set();
  for (const m of src.matchAll(/import\s*\{([^}]+)\}\s*from/g)) {
    for (const part of m[1].split(',')) {
      const n = part.trim().split(/\s+as\s+/).pop().trim();
      if (n) imported.add(n);
    }
  }
  for (const m of src.matchAll(/import\s+([A-Za-z_$][\w$]*)\s+from/g)) imported.add(m[1]);
  for (const m of src.matchAll(/import\s*\*\s*as\s+([A-Za-z_$][\w$]*)/g)) imported.add(m[1]);

  const declared = new Set();
  for (const m of src.matchAll(/(?:async\s+)?function\s+([A-Za-z_$][\w$]*)/g)) declared.add(m[1]);
  for (const m of src.matchAll(/(?:const|let|var)\s+([A-Za-z_$][\w$]*)/g)) declared.add(m[1]);
  for (const m of src.matchAll(/class\s+([A-Za-z_$][\w$]*)/g)) declared.add(m[1]);
  for (const m of src.matchAll(/\)\s*=>/g)) declared.add('__arrow__');
  // 对象/类里的方法简写：name(...) {  或 async name(...) {
  for (const m of src.matchAll(/(?:^|[\s,{])(?:async\s+)?([A-Za-z_$][\w$]*)\s*\([^)]*\)\s*\{/gm)) declared.add(m[1]);
  // 解构声明：const { a, b } = ...
  for (const m of src.matchAll(/(?:const|let|var)\s*\{([^}]+)\}/g)) {
    for (const part of m[1].split(',')) {
      const n = part.trim().split(':').pop().trim();
      if (n) declared.add(n);
    }
  }
  // 函数参数：function f(a, b) 与 (a, b) =>
  for (const m of src.matchAll(/(?:function\s*[\w$]*|(?:async\s+)?[A-Za-z_$][\w$]*|\()\s*\(([^)]*)\)\s*(?:=>|\{)/g)) {
    for (const part of m[1].split(',')) {
      const n = part.trim().split(/[=\s]/)[0];
      if (/^[A-Za-z_$][\w$]*$/.test(n)) declared.add(n);
    }
  }

  const called = new Set();
  // 只抓 "标识符(" 且前面不是 . 的形式
  for (const m of src.matchAll(/(^|[^.\w$])([A-Za-z_$][\w$]*)\s*\(/g)) {
    const name = m[2];
    if (!GLOBALS.has(name)) called.add(name);
  }
  return { imported, declared, called };
}

const problems = [];
for (const root of ROOTS) {
  for (const file of walk(root)) {
    const src = fs.readFileSync(file, 'utf8');
    const { imported, declared, called } = collect(src);
    for (const name of called) {
      if (imported.has(name) || declared.has(name)) continue;
      // 允许对象方法简写/解构等噪声：只报看起来像工具函数的（>=6 字符或含驼峰）
      if (name.length < 4) continue;
      problems.push(`${file}: 调用了未定义的 ${name}()`);
    }
  }
}

if (problems.length) {
  console.log('引用检查 FAIL：');
  for (const p of problems.slice(0, 20)) console.log('  - ' + p);
  process.exit(1);
}
console.log('引用检查 OK');
