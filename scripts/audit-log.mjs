#!/usr/bin/env node
// 防篡改审计：每条记录带 prev 哈希 + 自身哈希 + pid/boot_id
import fs from 'node:fs';
import crypto from 'node:crypto';

const FILE = '/root/sandboxes/AUDIT.log';
fs.mkdirSync('/root/sandboxes', { recursive: true });

const [event, name, detail] = [process.argv[2] || 'EVENT', process.argv[3] || '-', process.argv[4] || ''];

let prev = 'genesis';
try {
  const lines = fs.readFileSync(FILE, 'utf8').split('\n').filter(Boolean);
  if (lines.length) prev = JSON.parse(lines[lines.length - 1]).hash;
} catch {}

let bootId = '';
try { bootId = fs.readFileSync('/proc/sys/kernel/random/boot_id', 'utf8').trim(); } catch {}

const rec = {
  at: new Date().toISOString(),
  event, name, detail,
  pid: process.pid,
  bootId: bootId.slice(0, 8),
  prev,
};
rec.hash = crypto.createHash('sha256').update(JSON.stringify(rec)).digest('hex').slice(0, 16);
fs.appendFileSync(FILE, JSON.stringify(rec) + '\n');
console.log('audit:', rec.event, rec.name, rec.hash);
