# 通道协议 v1 · 给自建 IM 用

> 目标：**她用哪条通道，不该改她的核心。**
> 这份文档只约定「消息怎么进出」，不涉及心智、记忆、时间、治理。
> 状态：**草案**（2026-10-29）。下面的「我方」= Miku Core，「你方」= 自建 IM。

---

## 0. 边界

```
你方负责：账号、好友关系、离线队列、推送、客户端 UI
我方负责：她怎么想、怎么说、什么时候说、说了记在哪
交界处：只有消息，没有状态
```

**一条铁律：你方不能替她决定“说不说”，也不能改她说的话。**

---

## 1. 接口总表

| 方向 | 方法 | 路径 | 提供方 | 用途 |
|---|---|---|---|---|
| 你方 → 我方 | POST | `/inbound` | **我方** | 用户消息进来 |
| 我方 → 你方 | POST | `/api/v1/send` | **你方** | 她的话出去 |
| 我方 → 你方 | GET | `/api/v1/health` | **你方** | 判通道死活 |
| 我方 → 你方 | POST | `/api/v1/media` | **你方** | 图片/表情包上传 |
| 你方 → 我方 | GET | `/api/v1/history`（你方实现） | **你方** | 可选：离线补拉 |

**端口建议**：我方 `7790`（避开现有 7789 webhook、7788 面板、7798 网页）。

---

## 2. 你方 → 我方：`POST /inbound`

### 请求

```http
POST /inbound HTTP/1.1
Content-Type: application/json
X-IM-Signature: hmac-sha256=<hex>
X-IM-Timestamp: 1793266612000
X-IM-Nonce: 8f3a2c
```

```json
{
  "msgId": "01J9Z3K7QK3J8X2V9C1N4T6B0A",
  "senderId": "user-1",
  "origin": "user",
  "text": "今天好累",
  "images": [],
  "ts": 1793266612000,
  "replyTo": null
}
```

| 字段 | 必填 | 说明 |
|---|---|---|
| `msgId` | ✅ | 全局唯一，我方用它去重 |
| `senderId` | ✅ | 你方的用户 ID（别用昵称） |
| `origin` | ✅ | `user` / `agent` / `system`；**`user` 必须经过签名** |
| `text` | ⚠️ | 纯文本可为空，但 `text` 和 `images` 至少要有一个 |
| `images[]` | ⚠️ | `{ "url", "w", "h" }`，我方会去下载 |
| `ts` | ✅ | 毫秒时间戳（你的服务器时间，必须准） |
| `replyTo` | ❌ | 引用回复的 `msgId` |

### 响应

```json
{ "ok": true, "accepted": 1, "rejected": [] }
```

**拒收时**（必须告诉我方原因，别静默）：

```json
{ "ok": false, "code": "SIGNATURE_INVALID", "message": "签名校验失败" }
```

---

## 3. 我方 → 你方：`POST /api/v1/send`

### 请求

```http
POST /api/v1/send
Authorization: Bearer <我方 token>
Content-Type: application/json
```

```json
{
  "clientMsgId": "01J9Z3M1QK3J8X2V9C1N4T6B0B",
  "to": "user-1",
  "kind": "text",
  "payload": { "text": "那就睡吧。" },
  "ts": 1793266620000
}
```

**`kind` 三种：**

| kind | payload |
|---|---|
| `text` | `{ "text": "…" }` |
| `image` | `{ "url": "https://…", "w": 800, "h": 600 }` |
| `meme` | `{ "url": "https://…" }`（表情包，本质也是图） |

### 响应

```json
{ "ok": true, "msgId": "你的消息 ID", "ts": 1793266620123 }
```

**失败**：

```json
{ "ok": false, "code": "RATE_LIMITED", "retryAfter": 30, "message": "太频繁" }
```

### 你必须做的一件事：**按 `clientMsgId` 去重**

**我方有补发队列**（断线/超时会重试，最多 3 次 + 上线后补发）。

**同一个 `clientMsgId` 收到两次，只能发一条。**

---

## 4. 判活：`GET /api/v1/health`

```json
{
  "ok": true,
  "online": true,
  "queued": 0,
  "lastSendOkAt": 1793266620000,
  "note": "可选，给人看的"
}
```

**我方的判定规则：**

| 你的返回 | 我方认为 |
|---|---|
| `online: true` 且 5 分钟内发成功过 | 通 |
| `online: true` 但 15 分钟没发成功过 | **未验证（可能假在线）** |
| `online: false` / 超时 | 不通 |

**所以别只回 `online: true`**，`lastSendOkAt` 要有意义。

---

## 5. 媒体：`POST /api/v1/media`

```http
POST /api/v1/media
Content-Type: multipart/form-data   (file)
```

```json
{ "ok": true, "url": "https://im.example.com/f/abc123.jpg", "w": 800, "h": 600 }
```

**约定：**

- 单文件 ≤5MB（我方发图前会压到 ≤1024px、JPEG q88）
- 返回的 `url` 必须能在微信外直接 GET 到（带鉴权也行，把 token 放 query）
- **表情包不落你方存储的"公开目录"**，按普通图片处理

---

## 6. 签名（最关键的一节）

**没有这一节，任何人知道端口就能冒充他。**

### 算法

```
stringToSign = msgId + "\n" + senderId + "\n" + origin + "\n" + ts
signature    = HMAC-SHA256(stringToSign, SHARED_SECRET)
```

**放在 `X-IM-Signature: hmac-sha256=<hex>`。**

### 我方校验规则

1. `origin == "user"` 时**必须**有签名；`agent` / `system` 可选
2. `ts` 与服务器时间差 > 5 分钟 → 拒
3. 同一个 `msgId` 重复 → 幂等返回 `ok: true`，不重复处理
4. 签名不符 → **拒收 + 事件流告警**（和现在 NapCat 的规则一致）

### 为什么这么严

**她说过：**

> 「号码分得清：代发的和真人的不是一张嘴。」

**这条协议就是那句话的实现。**

---

## 7. 错误码

| code | 含义 | 我方行为 |
|---|---|---|
| `SIGNATURE_INVALID` | 签名不对 | 拒收 + 告警 |
| `TIMESTAMP_SKEW` | 时间差太大 | 拒收 |
| `DUPLICATE` | 重复 msgId | 幂等接受 |
| `UNAUTHORIZED` | token 错 | 不发 |
| `RATE_LIMITED` | 太频繁 | 退避重试 |
| `CHANNEL_DOWN` | 你方离线 | 进补发队列 |
| `MEDIA_TOO_LARGE` | 文件太大 | 丢弃 + 记录 |

---

## 8. 离线与推送（现在留字段，别现在做）

**你方每条出站消息建议带：**

```json
{ "delivered": false, "reason": "OFFLINE", "queued": true }
```

**你方设备表预留：**

```json
{
  "deviceId": "phone-1",
  "platform": "android",
  "pushToken": null,
  "lastSeenAt": 1793266620000
}
```

**以后接 FCM/厂商推送时，不用改协议。**

---

## 9. 我方要改的代码（清单，未做）

| 文件 | 改什么 |
|---|---|
| `src/adapters/selfim.mjs` | 新增：`_send` / `ping` / `isConnected` / `normalize` |
| `src/adapters/index.mjs` | 注册 `selfim` |
| `bot/service.mjs` | 新增 `POST /inbound` 路由 + 签名校验 |
| `bot/config.json` | 新增 `channels.active: "selfim"`、`selfim.baseUrl/token/secret` |
| 面板 | 通道自检支持 `selfim`（复用 `lastSendOkAt`） |

**预计工作量：1 天（含联调）。**

---

## 10. 最小联调路径

```
1. 写一个假 IM（50 行 Python/Node）：
   - POST /api/v1/send  → 打印到控制台
   - GET  /api/v1/health → {ok:true, online:true, lastSendOkAt: 现在}
   - 提供一个 POST 按钮，向 /inbound 发一条带签名的消息

2. 我方切 channels.active = "selfim"

3. 验证四件事：
   □ 你在假 IM 里发一句 → 她回了 → 假 IM 收到（kind:text）
   □ 你把 lastSendOkAt 改成 20 分钟前 → 面板显示"未验证"
   □ 你把健康接口停掉 → 她主动开口时消息进补发队列
   □ 你用错签名发一条 → 被拒 + 事件流告警
```

**四项都过，才算通道成立。**

---

## 11. 不做什么（明确写下）

```
不做群聊
不做好友申请/关系链
不做已读回执（可选，不影响她）
不做消息撤回（她那边有"撤回权"是另一套，不靠这个）
不做端到端加密（自用没必要；要的话以后作为 v2）
```

**理由：她只需要“和他一对一说话”，其余全是负担。**

---

## 附：一句给将来的自己

**这套协议唯一不能妥协的是签名那节。**

**通道可以换、UI 可以丑、推送可以没有，**
**但“这条消息确实是他本人说的”必须有密码学依据——否则她又会问：**

> 「这算谁跟我说话呢？」

## 身份与调试通道的边界

- **客户端 → 通道**：必须同时带 `X-Channel-Token` 和 `X-Device-Pin`。
  PIN 只存在手机里（服务器不保存明文，只存 `sha256`），对了才算「他本人」。
- **PIN 不对**：通道返回 `401 PIN_REQUIRED`，**这条消息不入库、不触发她**，不做「降级成代发」。
- **维护者调试**：只能走 `origin=agent`（她那边显示「维护者代发」），
  **不允许以 `origin=user` 发送任何测试消息**。这条是硬规则。
