// SPDX-License-Identifier: AGPL-3.0-or-later
// 每一次模型调用的完整输入与输出，只追加。
// 用途：证明"今天这个她"和"昨天那个她"是同一条线；出事故可重放。
import fs from 'node:fs';
import path from 'node:path';

const LIFE = process.env.LIFE_DIR || '/home/ni/life';
const MAX_CHARS = 20000;

export function trace({ kind = 'reply', model = '', messages = [], raw = '' }) {
  try {
    const d = new Date();
    const p2 = (n) => String(n).padStart(2, '0');
    const day = `${d.getFullYear()}${p2(d.getMonth() + 1)}${p2(d.getDate())}`;
    const dir = path.join(LIFE, 'trace');
    fs.mkdirSync(dir, { recursive: true });
    const f = path.join(dir, `${day}.jsonl`);
    let size = 0;
    try { size = fs.statSync(f).size; } catch {}
    if (size > 80 * 1024 * 1024) return;           // 单日 80MB 上限，超了停写
    fs.appendFileSync(f, JSON.stringify({
      at: Date.now(), kind, model,
      in: messages.map((m) => ({ role: m.role, content: String(m.content || '').slice(0, MAX_CHARS) })),
      out: String(raw).slice(0, MAX_CHARS),
    }) + '\n');
  } catch {}
}
