#!/usr/bin/env node
// 给机器人一个"会思考的大脑"：调用 dsh headless 作为一次真正的 agent 会话
// 特性：全局串行锁 / 硬超时 / 内存闸门 / 失败可降级
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { emit } from '../utils/events.mjs';
import { snapshot, verify } from '../utils/guard.mjs';

const LIFE = '__MIKU_HOME__';
const LOCK = path.join(LIFE, '.agent.lock');
const LOG = path.join(LIFE, 'agent.log');

const p2 = (n) => String(n).padStart(2, '0');
function stamp(d = new Date()) {
  return `${d.getFullYear()}-${p2(d.getMonth() + 1)}-${p2(d.getDate())} ${p2(d.getHours())}:${p2(d.getMinutes())}:${p2(d.getSeconds())}`;
}
export function alog(...a) {
  const line = `[${stamp()}] ${a.join(' ')}`;
  try { fs.appendFileSync(LOG, line + '\n'); } catch {}
  console.log(line);
}

export function memAvailableMB() {
  try {
    const m = fs.readFileSync('/proc/meminfo', 'utf8').match(/MemAvailable:\s+(\d+) kB/);
    return Math.round(Number(m[1]) / 1024);
  } catch { return 9999; }
}

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

async function acquireLock(waitMs = 180000) {
  const deadline = Date.now() + waitMs;
  while (Date.now() < deadline) {
    try {
      const fd = fs.openSync(LOCK, 'wx');
      fs.writeSync(fd, String(process.pid));
      fs.closeSync(fd);
      return true;
    } catch {
      // 锁文件可能是崩溃残留：超过 5 分钟就抢过来
      try {
        const st = fs.statSync(LOCK);
        if (Date.now() - st.mtimeMs > 5 * 60 * 1000) { fs.unlinkSync(LOCK); continue; }
      } catch { continue; }
      await sleep(1500);
    }
  }
  return false;
}
function releaseLock() { try { fs.unlinkSync(LOCK); } catch {} }

/**
 * 让 agent 思考一次。
 * @param {string} task 给 agent 的完整任务描述
 * @returns {Promise<string>} agent 输出的消息正文
 */
export async function think(task, opt = {}) {
  const timeoutSec = opt.timeoutSec ?? 120;
  const minMem = opt.minFreeMemMB ?? 800;
  const cwd = opt.cwd || LIFE;

  const avail = memAvailableMB();
  if (avail < minMem) {
    emit('brain','skip',`可用内存只剩 ${avail}MB（低于 ${minMem}MB），这次不思考`,{avail});
    throw new Error(`内存不足（可用 ${avail}MB < ${minMem}MB），跳过 agent`);
  }

  const got = await acquireLock(opt.lockWaitMs ?? 180000);
  if (!got) { emit('brain','skip','等锁超时，可能另一个思考还没结束'); throw new Error('等待 agent 锁超时'); }

  const started = Date.now();
  const guardBefore = snapshot();
  try {
    const out = await new Promise((resolve, reject) => {
      const child = spawn('dsh', ['headless', task], {
        cwd,
        env: { ...process.env, TZ: 'Asia/Shanghai', DSH_PERMISSION_MODE: 'danger-full-access' },
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      let stdout = '', stderr = '';
      child.stdout.on('data', (d) => { stdout += d; });
      child.stderr.on('data', (d) => { stderr += d; });
      const killer = setTimeout(() => {
        try { child.kill('SIGKILL'); } catch {}
        emit('brain','timeout',`思考超过 ${timeoutSec} 秒，强制中断`);
        reject(new Error(`agent 超时 ${timeoutSec}s`));
      }, timeoutSec * 1000);
      child.on('error', (e) => { clearTimeout(killer); reject(e); });
      child.on('close', (code) => {
        clearTimeout(killer);
        if (code === 0) resolve(stdout);
        else reject(new Error(`agent 退出码 ${code}: ${(stderr || stdout).slice(-300)}`));
      });
    });

    const ms = Date.now() - started;
    fs.appendFileSync(path.join(LIFE, 'agent-raw.log'),
      `\n===== ${stamp()} (${ms}ms, 可用内存 ${avail}MB) =====\nTASK: ${task.slice(0, 500)}\n---\n${out}\n`);

    verify(guardBefore);
    const text = extract(out);
    alog(`agent 完成 ${ms}ms，输出 ${text.length} 字`);
    return text;
  } finally {
    releaseLock();
  }
}

// 从 agent 的原始输出里抽出要发的话
export function extract(raw) {
  const lines = String(raw).split('\n').map((s) => s.trim()).filter(Boolean);
  // 优先 SEND:
  for (let i = lines.length - 1; i >= 0; i--) {
    const m = lines[i].match(/^SEND[:：]\s*(.+)$/i);
    if (m) return m[1].trim();
  }
  // 退而求其次：取最后一段不含元信息的文本
  const junk = /^(dsh:|reasoning|tool|调用|----|=====|```)/i;
  for (let i = lines.length - 1; i >= 0; i--) {
    if (!junk.test(lines[i]) && lines[i].length > 1) return lines[i];
  }
  return '';
}

export { LIFE, stamp };
