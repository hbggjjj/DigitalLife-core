#!/usr/bin/env node
// 维护者按流程改完受保护文件后，显式声明新 hash（并记账）
import fs from 'node:fs';
import crypto from 'node:crypto';
import path from 'node:path';

const { snapshot } = await import('__MIKU_ROOT__/src/utils/guard.mjs');
const ALLOW = '__MIKU_ROOT__/.guard-allow.json';

const snap = snapshot();
let cur = {};
try { cur = JSON.parse(fs.readFileSync(ALLOW, 'utf8')); } catch {}
const merged = { ...cur, ...snap };
fs.writeFileSync(ALLOW, JSON.stringify(merged, null, 2));

// 账本留痕
try {
  const line = `| ${new Date().toLocaleString('zh-CN', { hour12: false }).slice(0, 16)} | bless：受保护文件登记新 hash | 维护通道 | ${Object.keys(snap).length} 个文件 |\n`;
  fs.appendFileSync('__MIKU_HOME__/others-edits.md', line);
} catch {}

console.log('已登记', Object.keys(snap).length, '个受保护文件');
