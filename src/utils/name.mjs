// 实例的名字：不写死在代码里。优先 config.instanceName，其次她自己的 SELF.md。
import fs from 'node:fs';
import path from 'node:path';

export function instanceName() {
  const root = process.env.QQBOT_ROOT || '__MIKU_ROOT__';
  try {
    const cfg = JSON.parse(fs.readFileSync(path.join(root, 'bot', 'config.json'), 'utf8'));
    if (cfg && cfg.instanceName) return String(cfg.instanceName).trim();
  } catch {}
  try {
    const life = process.env.LIFE_DIR || '__MIKU_HOME__';
    const self = fs.readFileSync(path.join(life, 'SELF.md'), 'utf8');
    const m = self.match(/我叫\s*([^\n。，,]{1,24})/) || self.match(/我是\s*([^\n。，,]{1,24})/);
    if (m) return m[1].trim();
  } catch {}
  return '她';
}
