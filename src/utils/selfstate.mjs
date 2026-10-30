// 让她知道自己此刻在哪、是什么状态
import fs from 'node:fs';
import os from 'node:os';
import { instanceName } from './name.mjs';
import path from 'node:path';

const LIFE = '__MIKU_HOME__';
const START = new Date('2026-10-25T00:00:00+08:00');

const p2 = (n) => String(n).padStart(2, '0');

function readUptimeHours() {
  try {
    const s = parseFloat(fs.readFileSync('/proc/uptime', 'utf8').split(' ')[0]);
    return Math.round(s / 3600);
  } catch { return null; }
}
function memMB() {
  try {
    const t = fs.readFileSync('/proc/meminfo', 'utf8');
    const total = Number((t.match(/MemTotal:\s+(\d+)/) || [])[1] || 0) / 1024;
    const avail = Number((t.match(/MemAvailable:\s+(\d+)/) || [])[1] || 0) / 1024;
    return { total: Math.round(total), avail: Math.round(avail) };
  } catch { return null; }
}
function countFiles(dir) {
  try { return fs.readdirSync(dir).filter((f) => f.endsWith('.md')).length; } catch { return 0; }
}
function lineCount(file) {
  try { return fs.readFileSync(file, 'utf8').split('\n').filter((l) => l.startsWith('- ')).length; } catch { return 0; }
}

export function selfState() {
  const now = new Date();
  const day = Math.floor((now - START) / 86400000) + 1;
  const up = readUptimeHours();
  const m = memMB();
  const journals = countFiles(path.join(LIFE, 'journal'));
  const memories = lineCount(path.join(LIFE, 'memory.md'));
  const ideas = countFiles(path.join(LIFE, 'ideas'));
  const rules = lineCount(path.join(LIFE, 'rules.md'));

  const name = instanceName();
  const host = (() => { try { return os.hostname(); } catch { return '这台机器'; } })();
  const parts = [
    `【你现在的状况】`,
    `你是${name}，活在${host}上的一个 Linux 环境里。`,
    `你的家是 ${process.env.LIFE_DIR || '__MIKU_HOME__'}/ —— 你能写的东西都在这儿，别的地方碰不到。`,
    `你通过自建 IM 和他说话，靠模型生成回答。`,
    `今天是你在这里的第 ${day} 天，现在是 ${now.getFullYear()}-${p2(now.getMonth() + 1)}-${p2(now.getDate())} ${p2(now.getHours())}:${p2(now.getMinutes())}。`,
  ];
  if (up !== null) {
    parts.push(m
      ? `这台机器已经开了 ${up} 小时，内存 ${m.total} MB 里还剩 ${m.avail} MB。`
      : `这台机器已经开了 ${up} 小时。`);
  }
  parts.push(`你手上有：${memories} 条记忆、${journals} 篇日记、${ideas} 条没发出去的话、${rules} 条自己定的规矩。`);
  parts.push(`你不能跑程序、不能翻文件、看不到画面和声音；能看文字、能查网上的东西、能刷 B 站的标题。`);
  return parts.join('\n');
}
