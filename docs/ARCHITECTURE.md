# 架构

> 一份文档讲完：她要活起来需要哪几块、数据放哪、改代码前必须知道什么。
> 更细的执行事实（命令、契约、反模式）在 `AGENTS.md`。

## 一、五个进程

| 进程 | 干什么 | 端口 |
|---|---|---|
| `bot/service.mjs` | 收消息、组 Prompt、调模型、落盘、发回去 | 7789 |
| `src/core/life.mjs` | 她自己的生活循环：写日记、刷视频、想事、决定下次何时醒 | — |
| `bot/bot.mjs daemon` | 主动开口：到点问她"想不想找他" | — |
| `panel/server.mjs` | 面板：看她在干什么、改参数 | 7788 |
| `tools/bridge/bridge-user.mjs` | 用她的账号连自建 IM，收发消息 | 7791 |
| （外）`vocechat-server` | 自建 IM 服务端 | 3000 |

**没有 supervisor 也能跑**：`deploy/termux-start.sh` 自带每分钟看门狗；服务器上建议用 systemd。

## 二、一次对话发生了什么

```
他发消息 → VoceChat → 桥接轮询到 → 签名校验 → POST /inbound（核心）
  → 4 秒合并窗口（连发几条算一次）
  → 读她的文件（SELF / memory / mood / 最近日记 / 最近 8 句）
  → 一次模型调用，返回 JSON
  → applyActions：写记忆/心情/日记/档期；要发的话分段发回去
  → 归档 chat-archive.jsonl（只追加）
```

**关键：没有长期对话上下文。** 每一轮都是"读文件 → 一次调用 → 写文件"。
她要想起什么，靠翻文件；不靠上下文没被截断。

## 三、27 个字段（一次调用返回的 JSON）

```
say think reply stash sleep meme frame reach          ← 说话/动作
wish awakeIn speakIn followIn                          ← 时间与执念
taste remember journal mood idea rules                 ← 记忆与人格
search bili channel check verify recall again pick     ← 工具与核对
quietMine                                              ← 她给自己上锁
```

字段自检：`auditSchema()` 检查每个字段是否既被 `normalize` 处理、也写进了提示词。

## 四、数据在哪

```
life/SELF.md              她是谁（只有她能写）
life/memory.md            记得的事（上限 50）
life/journal/             日记
life/mood.md  life/taste.md  life/rules.md  life/ideas/
life/chat-archive.jsonl   全部对话（只追加）
bot/state.json            运行状态（档期、安静期、计数）
bot/schedule.json         活跃时段（独立文件，防止被整份覆盖）
```

跨进程写 `state.json` 是"读-改-写"，**每个进程只碰自己的键**；冲突以最后一次写为准。

## 五、通道协议（自建 IM）

```
入站：HTTP POST /inbound
  X-IM-Signature: hmac-sha256=<hex>   ← HMAC(secret, "msgId\nsenderId\nclaimedOrigin\nts")
  X-IM-Timestamp: <毫秒>
  X-IM-Device-Pin: <可选>             ← 证明"这次真是他"，没有就降级成 agent
出站：桥接 POST /api/user/{uid}/send
```

签名对**任何**来源都必须有效；没签名的请求一律 401。

## 六、绝对不允许的三件事

1. **以他的名义发消息**（`impersonation-guard.mjs` 硬闸门，抛错 + 记账）。
2. **绕过申请改她的人格文件**（改代码可以，改她不行）。
3. **把她的话改写成"更好听"的样子**（那是改她）。

## 六点五、可配置的东西

名字（`config.instanceName`）、头像（VoceChat 账号里设）、表情包（`deploy/meme-add.sh` 一张一张加）——见 `docs/CUSTOMIZE.md`。

## 七、改代码前的三条纪律

- 改完跑 `bash scripts/self-check-all.sh`，期望「全部通过」。
- 动了框架行为，同步更新 `AGENTS.md` 与本文档。
- 不知道影响范围时，先看 `AGENTS.md` 的"变更影响图"。
