// 通道管理中心：配置里写哪个，就用哪个。
import { NapCatAdapter } from './napcat.mjs';
import { WebAdapter } from './web.mjs';
import { SelfIMAdapter } from './selfim.mjs';

const REGISTRY = {
  napcat: (cfg) => new NapCatAdapter(cfg),
  web: (cfg) => new WebAdapter(cfg),
  selfim: (cfg) => new SelfIMAdapter(cfg),
};

let active = null;

export function createAdapter(name, cfg = {}, hooks = {}) {
  const make = REGISTRY[name];
  if (!make) throw new Error('未知通道: ' + name + '（可用：' + Object.keys(REGISTRY).join(', ') + '）');
  active = make({ ...cfg, ...hooks });
  return active;
}

export function getAdapter() {
  if (!active) throw new Error('还没有初始化通道，先 createAdapter()');
  return active;
}

export function available() { return Object.keys(REGISTRY); }
