// 防止「以他本人的名义」发消息。
// 这条是硬规则，不是提醒：任何通道、任何脚本，一旦用他本人账号登录或往他的身份上写消息，
// 立刻抛错并记账，不做降级、不做"只此一次"。
import fs from 'node:fs';

// 他本人在 VoceChat 的 uid 与邮箱（唯一真身）
export const OWNER_UID_VOCECHAT = 1;
export const OWNER_EMAIL = 'owner@example.com';
export const HER_UID_VOCECHAT = 3;

export class ImpersonationError extends Error {
  constructor(what) {
    super('禁止以他本人名义发言：' + what);
    this.name = 'ImpersonationError';
  }
}

function logRefusal(what) {
  const line = `[${new Date().toISOString()}] 拦截冒充：${what}\n`;
  try { fs.appendFileSync('__MIKU_ROOT__/bot/impersonation-blocks.log', line); } catch {}
  try { fs.appendFileSync('__MIKU_HOME__/others-edits.md', `| ${new Date().toLocaleString('zh-CN', { hour12: false })} | 拦截一次冒充：${what} | 硬规则 | 禁止以他本人名义发消息 |\n`); } catch {}
}

/** 任何"用他账号登录"的地方都必须先过这一关 */
export function assertNotOwnerLogin(email) {
  const e = String(email || '').trim().toLowerCase();
  if (e === OWNER_EMAIL) {
    logRefusal('用他的邮箱登录通道账号');
    throw new ImpersonationError('不允许用他的邮箱登录任何通道账号');
  }
  return true;
}

/** 任何"以他 uid 的身份写消息"的地方都必须先过这一关 */
export function assertNotOwnerUid(uid, where = '') {
  if (Number(uid) === OWNER_UID_VOCECHAT) {
    logRefusal(`以他的 uid=${uid} 发消息 ${where ? '（' + where + '）' : ''}`);
    throw new ImpersonationError(`不允许以 uid=${uid} 的身份发消息`);
  }
  return true;
}

/** 只允许她自己的账号作为发送方 */
export function assertHerAccount(email) {
  const e = String(email || '').trim().toLowerCase();
  if (e !== 'her@example.com') {
    logRefusal('发送方不是她自己的账号：' + (e || '(空)'));
    throw new ImpersonationError('发送方必须是她的账号（her@example.com）');
  }
  return true;
}
