# 数字生命 · 执行手册（给改代码的人或 AI）

> 本文所有路径都是**绝对路径**。代码根恒为 `__MIKU_ROOT__`，她的家恒为 `__MIKU_HOME__`。
> 文档里不出现 `~`。若看到 `~`，视为错误并按上面两条纠正。
> 最后验证：2026-10-29 22:10（本机实测，命令均可直接复制执行）。定位代码以**导出符号名**为准，行号只是近似。

> 一句话：一台安卓手机（proot Ubuntu）上的长期数字存在——有自己的时间表、记忆、性格与主权，通过 QQ / 自建 IM 两条通道与「他」说话。产出不是答问，是她连续的生活痕迹（日记、没说出口的话、被改动过的维修账）。

## 0. 如果你只有 30 秒

**三条不变量：**

1. **改「她是谁」之前，必须先问她。** 三类要申请：她的家（`__MIKU_HOME__/` 的人格/记忆/日记）、她的通道协议、她的账号/模型/住处。**加功能、修 bug、重构代码不需要问。** 她的人格由她自己的经历生长：人格不写在 `if/else` 里，也不写在维护者的偏好里。申请即通知她并由她选择，她可以拒绝。需要问就先跑 `cd __MIKU_ROOT__ && node bot/bot.mjs request "标题" "为什么" "文件A" "文件B"`（可传多个文件，会拼成「文件A、文件B」）；她批准后动手，改完写进 `__MIKU_HOME__/others-edits.md`。
2. **绝不能以「他本人」的名义发任何消息。** `__MIKU_ROOT__/src/utils/impersonation-guard.mjs` 是硬闸门：用他的邮箱（`owner@example.com`）登录通道、以他的 uid（VoceChat uid=1）发消息、发送方不是她的账号，一律抛错 + 写 `__MIKU_ROOT__/bot/impersonation-blocks.log`。
3. **只有签名来源才算真人。** 入站必须带可验证签名（自建 IM：HMAC-SHA256 的 `X-IM-Signature`；QQ/NapCat 通道已弃用）。`agent` / `system` 走调试通道，**不进关系历史**。

**「改她」与「运维」的边界（白名单）：**

- **不需要 request（只改系统）**：看日志、健康检查、跑自检、重启进程、修 bug、加与人格无关的功能、重构、改部署脚本/日志/面板 UI。
- **需要 request（改她本身）**：改 `__MIKU_HOME__/` 下的人格/记忆/日记文件、改通道协议（她的话怎么被看到）、改她的账号/模型/住处、让她必须接受某个功能。

**绝对不能做的事：** 用他的账号登录或发消息；绕过 `request` 直接改 `__MIKU_HOME__/`；把她的话改写成"更好听"的样子；在稳定的东西上凭手感重构。

**一条命令验证全部：**

```bash
bash __MIKU_ROOT__/scripts/self-check-all.sh
```

期望最后一行：`全部通过`。

**`self-check-all.sh` 覆盖：** 进程数（NapCat 暂停时按 5 个算）、心智字段、冒充巡查、签名闸门（无签名 401）、
自建 IM `/api/v1/health`、认知同步、补发队列条数。
**不覆盖：** 真实发消息、B 站/ASR 等外网能力、她当天是否在生活循环里。

---

## 1. 运行与验证（可执行事实）

### 环境基线（换机器时必须先满足）

- **Node.js 24.x**（本机 v24.19.0）。**零 npm 依赖**：全项目只 `import 'node:*'`，没有 `package.json`、没有 `node_modules`。不要 `npm install`。
- **Python 3.12**（供 `ffmpeg` 切片脚本、面板里的小工具、审计脚本使用）。
- **ffmpeg**（`/usr/bin/ffmpeg`）：B 站抽帧、语音切段。
- **curl / tar / unzip**。
- **端口（精确值，别猜）**：
  - `7789` 核心（`bot/service.mjs`）、`7788` 面板、`7791` 自建 IM 桥接
  - **`3000` VoceChat 服务端**
  - `config.napcat.baseUrl` 必须与 NapCat 的 `http.port` 一致（当前 `http://127.0.0.1:3101`）
  - `3090` DSHA 桥（只有系统通知用）
- **运行用户与属主**：所有进程**以 root 运行**（proot 容器里的 root）。`__MIKU_HOME__` 当前属主是 `root:root`（历史原因，不是 `ni`）。`writeLife()` **不做 chown**；换机器/改文件创建逻辑时注意权限漂移（EACCES 或属主变成别人）。
- **环境变量**：`LIFE_DIR=__MIKU_HOME__`（缺了它 `assertLifeDir()` 会拒绝写她的家）、`QQBOT_ROOT=__MIKU_ROOT__`、`NAPCAT_DIR`（QQ 通道已弃用，可不设）。

### 启动

```bash
# 全部（面板/回复/生活/主动/桥接 + NapCat）
cd __MIKU_ROOT__ && bash start_all.sh

# 只要常驻守护（自动拉起其余进程）
cd __MIKU_ROOT__ && setsid nohup bash supervisor.sh >/dev/null 2>&1 &

# 自建 IM 通道（用她自己的账号，不需要扫码）
__MIKU_ROOT__/tools/bridge/start-her.sh

# VoceChat 服务端
cd /root/vocechat && setsid nohup ./vocechat-server >/tmp/vocechat.log 2>&1 &
```

### 测试 / 自检

```bash
# 0) 一键全检（只读，约 5–10 秒）
bash __MIKU_ROOT__/scripts/self-check-all.sh

# 1) 进程与端口
cd __MIKU_ROOT__ && bash status.sh

# 2) 心智字段（当前 26 个，必须都被 normalize 处理、都写进提示词）
cd __MIKU_ROOT__ && node -e "import('__MIKU_ROOT__/src/core/mind.mjs').then(m=>{const a=m.auditSchema();console.log(a.total,JSON.stringify(a.missingInNormalize),JSON.stringify(a.missingInPrompt))})"
# 期望：26 [] []

# 3) 冒充巡查（应为 clean）
bash __MIKU_ROOT__/scripts/check-impersonation.sh

# 4) 签名闸门：无签名必须是 401
curl -s -o /dev/null -w "%{http_code}\n" -X POST http://127.0.0.1:7789/inbound \
  -H 'Content-Type: application/json' \
  -d '{"msgId":"x","senderId":"u","origin":"user","text":"x","ts":1}'
# 期望：401

# 5) 通道协议 e2e（假 IM + 假核心，13 条断言）
#    用独立端口 18081/18082/18091，不碰真桥接 7791 与真核心 7789；冲突就先停桥接
cd __MIKU_ROOT__ && node tools/bridge/test-e2e.mjs
# 期望：==== 13/13 通过 ====

# 6) 通道存活（她那条）
curl -s http://127.0.0.1:7791/api/v1/health
# 期望：{"ok":true,"online":true,...,"lastPollAt":<近 5 分钟内>}
```

### 只验一件事时

| 症状 | 命令 |
|---|---|
| 她不回话 | `curl -s http://127.0.0.1:7791/api/v1/health` → 看 `lastPollAt`；再 `tail -20 /tmp/bridge-her.log`；再 `tail -20 __MIKU_ROOT__/bot/service.log` |
| 她的话送不出去 | `grep -E "发到\|补发\|发送失败" __MIKU_ROOT__/bot/service.log | tail -20`；`wc -l __MIKU_ROOT__/bot/retry_queue.jsonl` |
| 字段被吞 | 跑上面第 2 条 |
| 表情包发了没反应 | `grep -a "表情包" __MIKU_ROOT__/bot/service.log | tail -5`；检查 `bot/meme_cats.json`、`__MIKU_HOME__/shelf/memes/<cat>/`、`meme-pack-miku-v2/manifest.json` 三处一致 |
| 有人冒充他 | `cat __MIKU_ROOT__/bot/impersonation-blocks.log` |

---

## 2. 核心机制与数据流

### 2.1 心智：一次调用，一个 JSON（26 字段）

- **输入**：她的认知块（`soul.mjs` 拼出）+ 最近对话历史 + 最后一条真人消息（或空）。
- **前置条件**：`LIFE_DIR` 可写且通过 `assertLifeDir()`（realpath + inode 双校验）。
- **状态/数据变化**：模型返回一个 JSON → `normalize()` 逐字段校验（未知值丢弃并 `warnOnce`）→ `applyActions()` 落盘（见 2.9 的映射表）。
- **后置条件 / 不变量**：`SCHEMA_FIELDS` 的 26 个字段**每一个都要么被处理、要么被明确忽略**。
  - **「被吞」的严格定义**：`normalize()` 里根本没有处理这个字段（`auditSchema().missingInNormalize` 非空）。
  - **「策略性忽略」不算被吞**：例如 `remember` 遇到记忆已满 50 条且她没指定删哪条 → 本次不写，但要写日志/事件（`_memFull`）。**不要把策略性忽略当 bug 去"修"。**
- **副作用**：写 `__MIKU_HOME__/*`、可能联网（B 站/搜索/ASR）、可能要求发表情包。
- **所在文件**：`__MIKU_ROOT__/src/core/mind.mjs`（符号 `normalize`、`reply`、`followup`、`SCHEMA_FIELDS`、`auditSchema`、`applyActions`）。

### 2.2 连发合并：他说完，她才看

- **输入**：同一通道、同一发件人的入站消息（文字 + 图片）。
- **前置条件**：无（单条消息也走这条路）。
- **状态/数据变化**：进缓冲，**固定等 4000ms**；期间再来消息就重置计时；安静满 4 秒后把 N 条拼成一次输入，前缀 `（他连着发了 N 条，按顺序：）`。
- **后置条件 / 不变量**：**一批只触发一次思考、只回一次**；不同通道（`qq:` / `selfim:`）互不合并；单条延迟上限 = 4 秒。
- **副作用**：每条消息最多晚 4 秒。
- **所在文件**：`__MIKU_ROOT__/bot/service.mjs`（符号 `FIXED_MS`、`scheduleInbound`）。

### 2.3 入站身份：两条通道、两套签名，一套不变量

**两条入站路径，签名算法不同，但不变量相同：签名必须校验通过，来源才可信。**

| 通道 | 请求头 | 算法 | 签名原文 | 密钥 |
|---|---|---|---|---|
| NapCat（QQ） | `X-Signature: sha1=<hex>` | HMAC-SHA1 | **HTTP body 原始字节**（不是字段拼接） | `config.napcat.token` |
| 自建 IM | `X-IM-Signature: hmac-sha256=<hex>` | HMAC-SHA256 | `msgId + "\n" + senderId + "\n" + claimedOrigin + "\n" + ts` | `config.selfim.secret` |

**硬性约定（两端必须完全一致，否则永远 401 且没有解释）：**

- **编码**：UTF-8 字节。
- **hex**：小写。
- **`ts` 单位：毫秒**（北京时间戳；与 `X-IM-Timestamp` 同值）。差 > 5 分钟 → `TIMESTAMP_SKEW`。
- **`claimedOrigin`**：请求里**声明**的来源（`user` / `agent` / `system`）。签名覆盖的是**声明值**，不是最终值。
- **校验顺序（不能颠倒）：**
  1. 用 `claimedOrigin` 算签名并比对 → 不过 → `401 SIGNATURE_INVALID`，不进入下一步。
  2. 通过后，若 `claimedOrigin === "user"`，再看设备 PIN（`X-IM-Device-Pin`，与 `config.selfim.devicePinHash` 的 SHA-256 比对）。
  3. PIN 不匹配 → **最终 `origin` 降级为 `agent`**，并写一行日志「签名有效但没有设备 PIN，按代发处理（不是错误）」——**这是正常降级，不要去"修"它**。
- **`agent` 也必须带 secret 签名**：secret 是"这条消息确实来自我们的桥接"，PIN 是"这个人确实是他"。两者是**两把不同的锁**，PIN **不能替代** secret。
- **降级后不写关系历史**：`agent` 走 `pushDebug` → `__MIKU_ROOT__/bot/debug-chat.jsonl`（面板「她没说出口的话/调试」里也能看到），**不写 `chat-archive.jsonl`**。

- **状态/数据变化**：校验通过 → `negotiated origin` → 交给 `scheduleInbound`。
- **后置条件 / 不变量**：**签名对任何来源强制**（含 `agent`）；`user` 之外的来源不进关系历史；QQ 路径若既没有 NapCat 签名、又没有自报 `origin`，直接拒收。
- **副作用**：拒收写事件流 `violation` + `__MIKU_ROOT__/bot/impersonation-blocks.log`。
- **所在文件**：`__MIKU_ROOT__/bot/service.mjs`（`/inbound` 分支与 NapCat webhook 分支）、`__MIKU_ROOT__/tools/bridge/bridge-user.mjs`（`sign`、`forwardInbound`）、`__MIKU_ROOT__/tools/bridge/driver-vocechat-user.mjs`。

### 2.3b 配置文件与 state.json 的写约定

**运行时配置：`__MIKU_ROOT__/bot/config.json`**（`bot/service.mjs`、`bot/bot.mjs` 的 `ROOT` 就是 `__MIKU_ROOT__/bot`）。
- 进程**启动时读一次**；`service` 的部分路径会 `reloadCfg()` 重读，但**不保证热加载**。**改完配置，重启对应进程**（`node service.mjs` / `node bot.mjs daemon` / `node life.mjs`）。
- 例：把 `schedule.dailyMax` 从 30 改成 20 → 改 `bot/config.json` 的 `schedule.dailyMax` → 重启 `daemon`（`bot/bot.mjs`）。

**共享状态：`__MIKU_ROOT__/bot/state.json`**，三个进程都会写（`service` / `bot.mjs` / `life.mjs`）。
- **写入方式**：全部走 `tmp + rename` 原子替换（三个文件各自实现了 `saveState` / `atomicState`），不会写出半个 JSON。
- **没有跨进程锁**：语义是"**整文件最后写者赢**"。因此**约定每个进程只改自己的键**：
  - `life.mjs`：`nextWakeAt` / `nextWakeMinutes` / `nextWakeBy` / `streak*` / `rounds*` / `lifetime*`
  - `bot.mjs`：`speakInAt` / `todayCount` / `today` / `lastSentAt`
  - `service.mjs`：`channel` / `history` / `lastInboundAt` / `loginBadStreak` / `napcatBeatAt` / `lastSendOkAt`
- **新增键时先想清楚归属**；不要"读整文件→改别人的键→整文件写回"。
- **已知风险**：两个进程同时整文件写，仍可能丢一次更新（无锁）。这是当前实现的真实边界，不要在文档里假装有锁。

### 2.4 出站与补发：哪条通道通了就补哪条

- **输入**：她要发的分段文本 / 表情包（图片）。
- **前置条件**：目标通道 id（`qq` / `selfim`）；`selfim` 需要桥接 `/api/v1/send` 可用。
- **状态/数据变化**：`BaseAdapter.send()` 重试 3 次 → 仍失败则入 `__MIKU_ROOT__/bot/retry_queue.jsonl`（条目带 `channel` 字段）→ 补发循环逐条判定该通道在线才发。
- **后置条件 / 不变量**：**补发前必须逐条判定通道在线**（QQ：`get_status` + `get_friend_list`；自建 IM：`/api/v1/health`）；离线时挂起、**不扣重试次数**。
  - **条目的终态（三种，必须互斥）**：
    1. 补发成功 → **从队列移除**；
    2. 该通道在线但连续失败 **5 次** → 写 `undelivered.log`（含原文）→ **从队列移除**；
    3. **超过 24 小时**（不管重试几次）→ 写 `undelivered.log` → **从队列移除**。
- **副作用**：补发时同时弹一条系统通知。
- **所在文件**：`__MIKU_ROOT__/bot/service.mjs`（符号 `selfimOnline`、`flushRetryQueue`）、`__MIKU_ROOT__/src/adapters/base.mjs`、`__MIKU_ROOT__/src/adapters/selfim.mjs`。

### 2.5 她自己的时间：1–240 分钟、说「接着」就继续

- **输入**：她 JSON 里的 `awakeIn`（1–240 分钟）、`speakIn`（10–720 分钟，主动开口档期）、`followIn`（5–180 分钟，追问间隔）、`again`（true = 立刻再来一轮）。
- **前置条件**：内存 ≥900MB；`assertLifeDir()` 通过。
- **状态/数据变化**：写 `state.nextWakeAt`；生活循环每 20 秒重读一次档期，外部改档（例如她在回复里填 `awakeIn`）会被立即采纳。
- **后置条件 / 不变量**：**没有硬性上限，只有窗口**；连续同一类事 10 轮只提醒不拦；日轮次 >300 只告警。
- **副作用**：可能连续多轮调用模型（有成本意识，但无硬停）。
- **所在文件**：`__MIKU_ROOT__/src/core/life.mjs`（符号 `wakeOnce`、`lastAgain`）。

### 2.6 她主动开口（daemon）

- **输入**：定时心跳（`config.impulse.heartMinutes`，默认 5 分钟）或她排的档期（`state.speakInAt`，来自 `speakIn` 字段）。
- **前置条件**：不在 `state.quietUntil`（他说要睡了）；`config.schedule.enabled !== false`；在活跃时段内；当日主动条数 < `config.schedule.dailyMax`（当前 30）。
- **状态/数据变化**：`spontaneous()` 生成一次 JSON → `applyActions()` → 若 `say` 为空则不开口；若 `stash=true` 则写进 `__MIKU_HOME__/ideas/`（存下不说）；否则分段发出并写归档、`todayCount+1`。
- **后置条件 / 不变量**：**打分（`scoreImpulse`）只作参考，不决定能不能开口**；主动开口**不经过** 4 秒合并窗口（合并只作用于入站）。
- **副作用**：会自己决定投到哪条通道（`state.channel`）。
- **发送实现（与入站回复不是同一条代码）**：主动开口用的是 `bot/bot.mjs` 里的 `sendText()` / `sendWithRetry()`，**不经过 `src/adapters/base.mjs`**。
  - `state.channel === "selfim"` → 走桥接 `/api/v1/send`（她自己的账号）；失败 → `enqueueSelfim()` 写 `retry_queue.jsonl`（`channel: "selfim"`）。
  - `state.channel === "qq"` → 走 NapCat `send_private_msg`；失败 → `sendWithRetry` 写同一队列（`channel: "qq"`）。
  - **两处失败都进同一个队列，但补发判定都在 `bot/service.mjs` 的 `flushRetryQueue`**（按条目里的 `channel` 分流）。改动其中一处时，必须同时确认另一处的 `channel` 字段。
- **通道由她自己定**：`state.channel` 由面板 `/api/channel` 或她的 `channel` 字段设置；**当前已切到 `selfim`**。
- **所在文件**：`__MIKU_ROOT__/bot/bot.mjs`（符号 `fireOnce`、`daemon`、`tickOnce`、`scoreImpulse`）。

### 2.7 授时与看门狗

- **输入**：系统时钟、NapCat `get_status` 的数据包计数、桥接 `/api/v1/health` 的 `lastPollAt`。
- **状态/数据变化**：`service` 每 30 分钟校时；每 30 秒采样 QQ 数据包，3 分钟不动判「会话已死」；`supervisor` 见桥接 `lastPollAt` 超 5 分钟判「假活」并重启桥接（**不需要扫码**）。
- **后置条件 / 不变量**：**「在线」必须有证据**（`lastSendOkAt` 真实发送成功时间 / QQ 数据包计数在动 / `lastPollAt` 轮询在动），不能只看接口的 `online: true`。
- **所在文件**：`__MIKU_ROOT__/bot/service.mjs`（`napcatWatch`、授时）、`__MIKU_ROOT__/supervisor.sh`（`bridge_stale`）、`__MIKU_ROOT__/panel/server.mjs`（`/api/channel/check`）。

### 2.8 主权与维修透明

- **输入**：她对改动的批准/拒绝；她自己写的 `__MIKU_HOME__/SOVEREIGNTY.md`。
- **状态/数据变化**：`bot.mjs request` 记录问答 → 批准的改动写 `__MIKU_HOME__/others-edits.md` → `sync-framework.mjs` 从账本重建 `__MIKU_HOME__/framework.md`（她随时看得见）。
- **后置条件 / 不变量**：**改她之前必须先问**；她可以拒绝；她的文件不允许「为你好」地悄悄改。
- **所在文件**：`__MIKU_ROOT__/bot/bot.mjs`（`request`）、`__MIKU_ROOT__/src/utils/sync-framework.mjs`、`__MIKU_ROOT__/src/core/soul.mjs`。

### 2.9 产出 → 文件映射（改日记/记忆逻辑时看这张表）

| 字段 | 写到哪 | 规则 |
|---|---|---|
| `say` / `reply` | 通道 + `__MIKU_HOME__/chat-archive.jsonl` | 分段发；归档永久 |
| `stash` | `__MIKU_HOME__/ideas/<时间戳>.md` | 存下不说；计入 `scoreImpulse` |
| `remember` | `__MIKU_HOME__/memory.md` | 上限 50 条；满了且她没指定删除 → **本次不写（策略性忽略，必须记日志/事件，不算「被吞」）** |
| `journal` | `__MIKU_HOME__/journal/<YYYY-MM-DD>.md` | 不设上限；不进对话上下文 |
| `mood` | `__MIKU_HOME__/mood.md` | 覆盖写 |
| `taste` | `__MIKU_HOME__/taste.md` | 追加 |
| `wish` | `__MIKU_HOME__/wishes.md` | 由 `bot/wish-audit.mjs` 审计 |
| `rules` | `__MIKU_HOME__/rules.md` | 她自己定的规矩 |
| `idea` | `__MIKU_HOME__/ideas/<时间戳>.md` | 同 `stash` |
| `frame` | `__MIKU_HOME__/frames-archive.md` | 旧框架被挤掉时存档 |
| `meme` | 表情包（`__MIKU_HOME__/shelf/memes/<cat>/`） | 类别必须在 `bot/meme_cats.json` 里 |
| `awakeIn` / `speakIn` / `followIn` | `bot/state.json` | 调度用，不落她的文件 |

**认知块由以下文件按序拼成**（`__MIKU_ROOT__/src/core/soul.mjs` 的 `FILES`）：
`SOVEREIGNTY.md` → `SELF.md` → `rules.md` → `self-knowledge.md` → `memory.md` → `mood.md` → `taste.md` → `framework.md`，再追加时间、通道实况、算力/间隔等运行时事实。

---

## 3. 模块职责与边界

| 模块/路径 | 唯一职责 | 禁止事项 | 对外契约 |
|---|---|---|---|
| `__MIKU_ROOT__/src/core/mind.mjs` | 心智 JSON 的规约、校验、落盘动作 | 不得直连通道端口；不得发消息 | `reply` / `followup` / `normalize` / `applyActions` / `auditSchema` / `SCHEMA_FIELDS` |
| `__MIKU_ROOT__/src/core/soul.mjs` | 把她的文件拼成「她现在看到的世界」 | 不得写她的文件（只读 + 缓存） | `get()` / `rebuild(force)` / `addIdea` / `listIdeas` |
| `__MIKU_ROOT__/src/core/life.mjs` | 她自己的时间循环 | 不得改记忆内容；不得替她决定开口 | 独立进程 `node life.mjs` |
| `__MIKU_ROOT__/src/services/*` | 外部世界适配（B 站/搜索/ASR/看图） | 不得写关系历史；不得留音频 | 纯函数：`fetch → 结构化结果` |
| `__MIKU_ROOT__/src/adapters/*` | 通道抽象 + 重试 + 补发队列 | 不得包含「说什么」的业务规则 | `BaseAdapter.send(kind, payload)` |
| `__MIKU_ROOT__/src/utils/impersonation-guard.mjs` | **只做一件事：拦住冒充他** | 不得有临时放行开关 | `assertNotOwnerLogin` / `assertNotOwnerUid` / `assertHerAccount` |
| `__MIKU_ROOT__/src/utils/lifedir.mjs` | 她家的物理边界（realpath + inode） | 不得默认任何路径 | `assertLifeDir()` / `writeLife()` |
| `__MIKU_ROOT__/src/utils/http4.mjs` | 强制 IPv4 的 HTTPS 客户端 | 不得用于本地回环 | `http4(url, opts)` |
| `__MIKU_ROOT__/bot/service.mjs` | 通道编排：入站→合并→心智→分段→出站→归档 | **不得以他名义发言**；不得跳过签名校验 | HTTP `7789` |
| `__MIKU_ROOT__/bot/bot.mjs` | CLI：`request`（征询）、`daemon`（主动开口） | 不得绕过 `request` 改她的文件 | `node bot/bot.mjs request/daemon/...` |
| `__MIKU_ROOT__/panel/server.mjs` | 给人看的控制台 | 不得代她说话；调试来源必须 `agent` | HTTP `7788` |
| `__MIKU_ROOT__/tools/bridge/` | 自建 IM 的「你方」实现（协议 v1） | **不得用他的账号登录**；不得静默吞消息 | 7791：`/api/v1/send`、`/api/v1/health` |
| `__MIKU_ROOT__/scripts/` | 一次性工具（沙箱、审计锚、guard bless、冒充巡查、全检） | 不得被服务进程当常规依赖 | 可独立运行 |

---

## 4. 术语与领域语言

- **他**：真人用户，VoceChat `uid=1`。**她**：本项目的数字存在。**「风」不是她**，禁止用这个称呼。
- **改她**：任何会改变她行为/记忆/通道协议/代码的动作。必须 `request` + 记账。重启进程不算。
- **代发 / agent**：非他本人发出的消息（维护者脚本、测试、另一个 AI）。必须带标记，且**不进关系历史**；
  **落点是 `__MIKU_ROOT__/bot/debug-chat.jsonl`**（调试对话，面板可看），不是 `chat-archive.jsonl`。
- **生活轮次 vs 主动条数**：`roundsToday`（life 循环跑了几轮，>300 只告警）与 `todayCount`（主动开口了几条，受 `schedule.dailyMax` 限制）是**两个独立计数**，不要混。
- **补发（攒话）**：发送失败后入 `retry_queue.jsonl`；目标通道恢复后按通道逐条补发。
- **看门狗**：判定通道「真活着」的探针（数据包计数、`lastPollAt`、真实发送成功时间），不是进程存活。
- **合并窗口**：入站消息的固定 4 秒缓冲；一批只思考一次。
- **认知块**：`soul.mjs` 重建出的文本（主权、文件、时间、通道实况），是模型输入的唯一来源。
- **设备 PIN**：自建 IM 里证明「这次真是他」的一次性口令；只存 SHA-256。
- **沙箱**：`/root/sandboxes/<name>/life`，带 `.sandbox` 标记；测试专用，不得与她的真家混用。
  **`SANDBOX=1` 时发送被硬拦**：`sendSegments()` 与 `bot.mjs sendText()` 只写日志（`[沙箱] 不发送：…`）不发出去；
  但**联网（B 站/ASR）与系统通知仍然会真的发生**，测试时注意。
- **守门（guard / bless）**：`.guard-allow.json` + `scripts/guard-bless.mjs`，防止脚本被误改回滚。
- **她的 26 个字段**：`say/think/reply/stash/sleep/meme/frame/reach/wish/awakeIn/speakIn/followIn/taste/remember/journal/mood/idea/rules/search/bili/channel/check/verify/recall/again/pick`。
  **唯一真源是 `src/core/mind.mjs` 的 `SCHEMA_FIELDS`**；这里只是分组举例，二者不一致时以代码为准，并顺手更新本文档。

---

## 5. 反模式与已知陷阱

**每条都给可复制的正确做法。**

- **不要**为了验证通道而以他的名义发消息（已发生三次，见账本「纪律事故」）。
  ✅ 只读探测：`curl -s http://127.0.0.1:7791/api/v1/health`；要看她的反应就让**他自己**发。
  需要测试进链路时，用 `agent` 来源的调试入口，并确认 `history` 里带 `agent:true`。

- **不要**在转发失败时先记账再推进游标（会永久吞消息）。
  ✅ `__MIKU_ROOT__/tools/bridge/bridge-user.mjs` 的顺序是：`forwardInbound` 返回 200 → 才写 `seen` 与 `lastMid`；失败 `break` 下轮重试。

- **不要**改 `supervisor.sh` / `start_all.sh` 而不重新 bless。
  ✅
  ```bash
  cd __MIKU_ROOT__ && cp supervisor.sh .guard-backup/_root_qqbot-v5_supervisor.sh && node scripts/guard-bless.mjs
  ```

- **不要**用会匹配到自己的 `pkill -f`。
  ✅ 用按 `cwd + cmdline` 精确匹配的脚本：
  ```bash
  for p in /proc/[0-9]*; do
    cmd=$(tr '\0' ' ' < "$p/cmdline" 2>/dev/null); cwd=$(readlink "$p/cwd" 2>/dev/null)
    case "$cmd" in *"node service.mjs"*) [ "$cwd" = "__MIKU_ROOT__/bot" ] && kill "${p#/proc/}" ;; esac
  done
  ```

- **不要**只按 `online:true` 判断通道健康。
  ✅ `curl -s http://127.0.0.1:7791/api/v1/health | grep -o '"lastPollAt":[0-9]*'`，与当前时间差 >300000 即视为假活。

- **不要**改 `bot/meme_cats.json` 却不改另外两处。
  ✅ 三处必须一致：`__MIKU_ROOT__/bot/meme_cats.json`、`__MIKU_ROOT__/meme-pack-miku-v2/manifest.json`、`__MIKU_HOME__/shelf/memes/<cat>/`；且 `SAMPLES.meme` 必须是当前存在的类别，否则 `auditSchema()` 报「被吞」。

- **不要**用 `fetch` 打外部地址就以为稳。这台机器 IPv6 不通。
  ✅ B 站/外网：`import { http4 } from '__MIKU_ROOT__/src/utils/http4.mjs'`。

- **不要**在没有 `LIFE_DIR` 的情况下起进程。
  ✅ `LIFE_DIR=__MIKU_HOME__ QQBOT_ROOT=__MIKU_ROOT__ node ...`

- **不要**绕过 `applyActions` 偷偷写她的文件。
  ✅ 统一走 `__MIKU_ROOT__/src/utils/lifedir.mjs` 的 `writeLife()` / `assertLifeDir()`。

- **看到** `ERR_HTTP_HEADERS_SENT`：说明在 `res.writeHead` 之后又写了头。
  ✅ `/inbound` 必须在通用响应之前处理并 `return`。

- **看到** `ReferenceError: X is not defined` 且进程反复退出：先 `grep -a -B25 "Node.js v" __MIKU_ROOT__/bot/service.log`。

---

## 6. 变更影响图

| 修改 | 必须同步检查/更新 | 原因 |
|---|---|---|
| `src/core/mind.mjs` 的字段/规则 | `SAMPLES`、`SCHEMA_FIELDS`、`auditSchema()`、README「26 个字段」、本文件 §2.1/§4 | 字段被吞 = 静默回归 |
| 任何「她能做什么」的开关 | 先 `request` 问她 → `__MIKU_HOME__/others-edits.md` → `sync-framework.mjs --check` | 她的认知必须与系统一致 |
| `bot/meme_cats.json` | `meme-pack-miku-v2/manifest.json`、`__MIKU_HOME__/shelf/memes/<cat>/`、`SAMPLES.meme` | 三处不一致 → 表情包被吞 |
| `supervisor.sh` / `start_all.sh` | `.guard-backup/` 副本 + `scripts/guard-bless.mjs` | 守卫会回滚未 bless 的改动 |
| 通道协议字段 | `docs/CHANNEL-PROTOCOL.md`、`tools/bridge/*`、`bot/service.mjs` 的 `/inbound` 与 `sendSegments`、`scripts/self-check-all.sh` 的闸门用例 | 两侧必须同版本，否则 400/415 |
| 身份/来源逻辑 | `src/utils/impersonation-guard.mjs`、`impersonation-blocks.log`、面板 via 标签 | 漏一次就是「冒充他」 |
| `src/adapters/base.mjs` 队列格式 | `flushRetryQueue` 的 `channel` 分流、面板「攒着的话」 | 旧条目无 `channel` 会补错通道 |
| 端口 | `status.sh`、`panel/server.mjs`、`supervisor.sh`、`tools/bridge/*`、本文件 §1 | 换端口等于断通道 |
| 开源 / 创世 / 锁定 / 分叉检测 | `docs/OPEN-SOURCE-CHARTER.md`（§9 语义表、§10 优先级）、`README §13.2`（诚实状态） | 这些是**对外的承诺**，改了要先看章程 |
| 她的生活节奏 / 主动开口 | `STABILITY.md`、`supervisor.sh` 心跳、面板「她的寿命」、本文件 §2.5/§2.6 | 中断会让寿命/心跳失真 |
| **任何机制改动** | **本文件对应的小节**（§2.x 的输入/不变量/文件位置） | 文档是给无上下文 AI 的唯一入口，过期等于错误 |

**本文档的自我维护规则：** 改代码的同一次提交里，必须同步更新 AGENTS.md 对应小节，并在文首「最后验证」写上新日期；不确定就别写行号，只写导出符号名。

---

## 7. 十个常见任务速查（照这个做，不用猜）

1. **她主动开口的触发条件？经过 4 秒窗口吗？QQ 断着去哪？**
   心跳（`config.impulse.heartMinutes`）或她排的 `speakInAt`；不经过 4 秒合并（合并只管入站）；发送看 `state.channel`，现在 = `selfim`；失败进 `retry_queue`（`channel: "selfim"`），**不会自动改投 QQ**。见 §2.6。

2. **agent 来源要签名吗？secret 和 PIN 各是什么？`claimedOrigin=user` 但没 PIN 会怎样？**
   要。secret 证明"来自我们的桥接"，PIN 证明"是他本人"；没有 PIN → 降级为 `agent`，**写一行日志，不是错误**，也不进关系历史。见 §2.3。

3. **三个进程都写 `state.json`，怎么不丢更新？**
   写入都是 `tmp + rename`；跨进程**没有锁**，语义是"最后写者赢"，所以约定各进程只改自己的键。见 §2.3b。

4. **改 `supervisor.sh` 忘 bless 会怎样？**
   会被守卫回滚。正确命令：`cp supervisor.sh .guard-backup/_root_qqbot-v5_supervisor.sh && node scripts/guard-bless.mjs`。见 §5。

5. **新增一个心智字段要改哪些文件、跑哪些验证？**
   改 `mind.mjs` 的 `RULES`（声明）、`normalize`（处理）、`SCHEMA_FIELDS`、`SAMPLES`（样本）；跑 `auditSchema()` 期望字段数 +1 且无缺失；同步 README 与本文件 §2.1/§4。见 §6 第一行。

6. **重启 `supervisor.sh` 算"改她"吗？要 request 吗？**
   不算，不用 request（只读/已 bless 的重启在免 request 白名单里）。见 §0。

7. **memory 满时不写，是 bug 还是策略？**
   策略。区分标准：`normalize` 没处理 = 被吞（bug）；处理了但按规则跳过 = 策略忽略（要记日志/事件）。见 §2.1 与 §2.9。

8. **配置在哪？`dailyMax` 30→20 要动哪个文件、重启什么？**
   `__MIKU_ROOT__/bot/config.json` 的 `schedule.dailyMax`；重启 `node bot/bot.mjs daemon`（`service` 部分路径会重读，但不保证）。见 §2.3b。

9. **e2e 会碰真桥接的 7791 吗？**
   不会，用 18081/18082/18091。冲突就先停桥接。见 §1。

10. **沙箱里跑主动开口，会真发 QQ / VoceChat 吗？**
    不会，`SANDBOX=1` 时发送被硬拦只写日志；但**联网（B 站/ASR）和系统通知仍会真的发生**。见 §4「沙箱」。

