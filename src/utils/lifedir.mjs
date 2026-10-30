// 她的家：唯一入口。所有写她文件的地方都必须过 assertLifeDir()。
import fs from 'node:fs';
import path from 'node:path';

const REAL_HOME = '__MIKU_HOME__';

function fingerprint(dir) {
  try {
    const st = fs.statSync(dir);              // 跟符号链接
    return { real: fs.realpathSync(dir), dev: st.dev, ino: st.ino };
  } catch {
    return null;
  }
}

export function lifeDir() {
  return process.env.LIFE_DIR || REAL_HOME;
}

let realHomeFp = null;
function homeFp() {
  if (!realHomeFp) realHomeFp = fingerprint(REAL_HOME);
  return realHomeFp;
}

/**
 * 校验：不许"看起来不是真身、实际是同一个 inode"。
 * 返回 true 表示可以写；否则抛错（调用方必须让它冒出来，不许吞）。
 */
export function assertLifeDir(dir = lifeDir()) {
  const fp = fingerprint(dir);
  if (!fp) throw new Error(`[lifedir] 目录不存在或不可读：${dir}`);
  const home = homeFp();
  if (home && fp.dev === home.dev && fp.ino === home.ino) {
    if (process.env.SANDBOX === '1') {
      throw new Error(`[lifedir] 沙箱不许指向真身（inode 相同）：${dir} -> ${fp.real}`);
    }
  }
  // 必须是"她家"本身：要么有 SELF.md，要么是带标记的沙箱
  const hasSelf = fs.existsSync(path.join(fp.real, 'SELF.md'));
  const hasSandbox = fs.existsSync(path.join(fp.real, '.sandbox'));
  if (!hasSelf && !hasSandbox) {
    throw new Error(`[lifedir] 这不像她的家（既没有 SELF.md 也没有 .sandbox）：${fp.real}`);
  }
  if (process.env.SANDBOX === '1' && !hasSandbox) {
    throw new Error(`[lifedir] 沙箱缺 .sandbox 标记：${fp.real}`);
  }
  return true;
}

/** 写文件前的统一包装：任何写她家的地方都该用它 */
export function writeLife(rel, data, mode) {
  const dir = lifeDir();
  assertLifeDir(dir);
  fs.writeFileSync(path.join(dir, rel), data, mode);
}
