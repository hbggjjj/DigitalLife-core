// 任何格式的图片都先转成标准 JPEG 再交给她。
// 为什么：DeepSeek 只认 webp/png/jpeg/gif，而且 QQ 转发过来的图经常是
// HEIC / BMP / 带 alpha 的 webp / 半截下载，直接塞会 400。
import fs from 'node:fs';
import { execFileSync } from 'node:child_process';

const PY = `
import sys
from PIL import Image
src, dst = sys.argv[1], sys.argv[2]
try:
    im = Image.open(src)
    im.load()
except Exception as e:
    print('打不开：' + str(e)[:80]); sys.exit(2)
try:
    if im.mode in ('RGBA', 'LA', 'P'):
        bg = Image.new('RGB', im.size, (255, 255, 255))
        im = im.convert('RGBA')
        bg.paste(im, mask=im.split()[-1])
        im = bg
    else:
        im = im.convert('RGB')
    w, h = im.size
    if max(w, h) > 1024:
        im.thumbnail((1024, 1024), Image.LANCZOS)
    im.save(dst, 'JPEG', quality=88, optimize=True)
except Exception as e:
    print('转码失败：' + str(e)[:80]); sys.exit(3)
print('ok')
`;

/** 把任意图片转成标准 JPEG。返回 { ok, path, note } */
export function normalize(src, dst) {
  try {
    if (!fs.existsSync(src)) return { ok: false, note: '图没下载下来' };
    execFileSync('python3', ['-c', PY, src, dst], { timeout: 25000 });
    const size = fs.statSync(dst).size;
    if (!size) return { ok: false, note: '转出来的图是空的' };
    return { ok: true, path: dst, bytes: size };
  } catch (e) {
    const msg = (e.stderr && e.stderr.toString().trim()) || (e.stdout && e.stdout.toString().trim()) || e.message;
    return { ok: false, note: String(msg).split('\n').pop().slice(0, 60) };
  }
}
