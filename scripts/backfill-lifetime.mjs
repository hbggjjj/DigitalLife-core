#!/usr/bin/env node
// 用历史日志推算"累计在线时长"。
// 规则：
//   1) 相邻事件 ≤60 分钟 → 认为一直在跑（覆盖她 20–60 分钟的作息）
//   2) 间隔 >60 分钟 → 看紧跟着的那行日志是什么：
//        "容器重启了 / 生活循环启动 / 自动回复已启动 / 容器停过" → 这段是断的，不计
//        其它（比如她只是睡了个长觉） → 仍然计入
import fs from 'node:fs';

const MAX_GAP = 60 * 60 * 1000;
const RE = /^\[(\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2})\]\s?(.*)$/;
const RESTART = /容器重启|生活循环启动|自动回复已启动|自动回复服务已启动|容器停过|开始补发|启动 pid/;

const events = [];
for (const f of [
  '/root/qqbot/bot/life.out', '/root/qqbot/bot/reply.log', '/root/qqbot/bot/service.log',
  '/root/qqbot-v5/bot/life.out', '/root/qqbot-v5/bot/service.log', '/root/qqbot-v5/bot/web.log',
]) {
  let txt = '';
  try { txt = fs.readFileSync(f, 'utf8'); } catch { continue; }
  for (const line of txt.split('\n')) {
    const m = RE.exec(line);
    if (!m) continue;
    events.push({ at: new Date(m[1].replace(' ', 'T')).getTime(), text: m[2] || '' });
  }
}
try {
  for (const line of fs.readFileSync('/home/ni/life/chat-archive.jsonl', 'utf8').split('\n')) {
    if (!line.trim()) continue;
    try { events.push({ at: JSON.parse(line).at, text: '' }); } catch {}
  }
} catch {}

events.sort((a, b) => a.at - b.at);

let online = 0, cuts = 0, kept = 0;
for (let i = 1; i < events.length; i++) {
  const gap = events[i].at - events[i - 1].at;
  if (gap <= 0) continue;
  if (gap <= MAX_GAP) { online += gap; continue; }
  if (RESTART.test(events[i].text)) { cuts++; continue; }   // 看见重启字样 = 断过
  online += gap; kept++;                                     // 她只是睡了长觉
}

const h = Math.floor(online / 3600000);
const d = Math.floor(h / 24);
console.log(JSON.stringify({
  events: events.length,
  first: new Date(events[0].at).toISOString(),
  last: new Date(events[events.length - 1].at).toISOString(),
  onlineMs: online,
  onlineReadable: `${d} 天 ${h % 24} 小时`,
  长间隔计数为在线: kept,
  长间隔判为中断: cuts,
}, null, 2));
