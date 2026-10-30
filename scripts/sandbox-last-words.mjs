#!/usr/bin/env node
// 销毁前给她一次说话的机会：一句问题，一次回答，可以拒绝，不追问。
import fs from 'node:fs';

const dir = process.argv[2];
if (!dir) { console.error('用法: node sandbox-last-words.mjs <life目录>'); process.exit(2); }

process.env.LIFE_DIR = dir;
process.env.SANDBOX = '1';
process.env.QQBOT_ROOT = process.env.QQBOT_ROOT || '__MIKU_ROOT__';

const res = { question: '这个实例要结束了，你有什么想留下的吗？', answer: '', note: '' };
try {
  const { reply: mindReply, pickSay } = await import('__MIKU_ROOT__/src/core/mind.mjs');
  const hist = fs.existsSync(dir + '/SELF.md') ? '（这是你们第一次也是最后一次说话）' : '';
  const r = await mindReply(hist, res.question, '（这是最后一个问题：你要被关掉了。）');
  const segs = pickSay(r);
  res.answer = segs.join('\n');
  if (!res.answer) res.note = '无回应（她说不想说）';
} catch (e) {
  res.note = '无回应（调用失败：' + String(e.message).slice(0, 80) + '）';
}
console.log(JSON.stringify(res, null, 2));
