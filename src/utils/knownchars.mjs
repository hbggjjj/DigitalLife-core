// 她"用过"的字：life 全部 + 项目文档 + 最近对话。
// 生僻字检测靠这个当白名单，所以要够宽——宁可漏报，不要误报。
import fs from 'node:fs';

// 常见语气词/口语字：她第一次用也不该被当成"陌生字"
const COMMON = '诶呗喏晃呀啦嘛哦嘿哎咦唔嗯哼嘞咯喔嗷额呃唉哎哟嗨喂喔噢哇嘞喽喽叽喳啰嗦嘟囔';

let cache = null;
let builtAt = 0;
const TTL = 30 * 60 * 1000;

function addFromFile(set, path) {
  try {
    const t = fs.readFileSync(path, 'utf8');
    for (const c of t) if (/[\u4e00-\u9fa5]/.test(c)) set.add(c);
  } catch {}
}

export function knownChars() {
  if (cache && Date.now() - builtAt < TTL) return cache;
  const set = new Set();
  for (const c of COMMON) set.add(c);
  const LIFE = '__MIKU_HOME__';
  addFromFile(set, `${LIFE}/SELF.md`);
  addFromFile(set, `${LIFE}/memory.md`);
  addFromFile(set, `${LIFE}/mood.md`);
  addFromFile(set, `${LIFE}/taste.md`);
  addFromFile(set, `${LIFE}/goals.md`);
  addFromFile(set, `${LIFE}/framework.md`);
  addFromFile(set, `${LIFE}/rules.md`);
  addFromFile(set, `${LIFE}/self-knowledge.md`);
  addFromFile(set, `${LIFE}/others-edits.md`);
  try {
    for (const f of fs.readdirSync(`${LIFE}/journal`)) addFromFile(set, `${LIFE}/journal/${f}`);
  } catch {}
  // 项目文档里出现过的字，也算她"读得到"的字
  for (const f of ['README.md', 'PROMPT-视频理解.md', 'INSTALL-AGENT.md']) {
    addFromFile(set, `__MIKU_ROOT__/${f}`);
  }
  try {
    const h = JSON.parse(fs.readFileSync('__MIKU_ROOT__/bot/state.json', 'utf8')).history || [];
    // 只用他发来的话，不含她自己的输出——否则一个错字出现一次就"合法"了
    for (const x of h) {
      if (x.dir !== 'in') continue;
      for (const c of x.text || '') if (/[\u4e00-\u9fa5]/.test(c)) set.add(c);
    }
  } catch {}
  cache = set;
  builtAt = Date.now();
  return set;
}

/** 她没见过的字（可能是模型抖动，也可能只是新词） */
export function oddChars(text) {
  const set = knownChars();
  return [...new Set([...String(text)].filter((c) => /[\u4e00-\u9fa5]/.test(c) && !set.has(c)))];
}
