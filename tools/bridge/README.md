# 通道桥接（协议 v1 的「你方」）

一个零依赖的 Node 进程，同时实现两侧：

- **对核心**：`POST /api/v1/send`、`GET /api/v1/health`、`POST /api/v1/media`、`GET /api/v1/history`
- **对 IM** ：`POST /webhook/vocechat`（VoceChat 的 Bot Webhook 打到这里）→ 签名后转核心 `/inbound`

```
核心 ──/api/v1/send──▶ 桥接 ──/api/bot/send_to_user/{uid}──▶ VoceChat ──▶ 手机
核心 ◀──/inbound──────── 桥接 ◀──/webhook/vocechat──────────── VoceChat ◀── 手机
```

## 跑起来

```bash
IM_BASE="https://im.example.com" \
IM_API_KEY="VoceChat Bot 的 API Key" \
IM_BOT_UID="Bot 的 uid" \
SELFIM_TOKEN="核心调你时用的 Bearer" \
IM_SECRET="和核心约定的 HMAC 密钥" \
CORE_INBOUND="http://127.0.0.1:7789/inbound" \
node bridge.mjs
```

| 变量 | 必填 | 说明 |
|---|---|---|
| `IM_BASE` | ✅ | VoceChat 根地址，不带尾斜杠 |
| `IM_API_KEY` | ✅ | Settings → Bot&Webhook 里生成的 Key |
| `IM_BOT_UID` | 建议 | Bot 的 uid；用来过滤"她自己发的消息"，防止回灌 |
| `SELFIM_TOKEN` | 建议 | 核心调 `/api/v1/*` 时的 `Authorization: Bearer`；留空=不校验（仅限内网） |
| `IM_SECRET` | ✅ | 协议 §6 的共享密钥 |
| `CORE_INBOUND` | ✅ | 核心的 `/inbound` 地址 |
| `CORE_TOKEN` | ❌ | 核心那边如果要 Bearer 就填 |
| `BRIDGE_PORT` | ❌ | 默认 `7791` |
| `DATA_DIR` | ❌ | 去重账本目录，默认 `./data` |

## VoceChat 侧的三步

1. `Settings → Bot&Webhook → 新建 Bot`，Webhook URL 填 `http://<桥接地址>:7791/webhook/vocechat`
2. 给这个 Bot 生成 **API Key**（`x-api-key` 用它）
3. **用他的账号先给 Bot 发一句话**——Bot 不能给陌生人发消息，没有这条会话后面发不出去

## 接口速查

```bash
# 判活
curl -s localhost:7791/api/v1/health

# 发文本
curl -s -X POST localhost:7791/api/v1/send \
  -H 'Authorization: Bearer <SELFIM_TOKEN>' -H 'Content-Type: application/json' \
  -d '{"clientMsgId":"c-1","to":"user-1","kind":"text","payload":{"text":"那就睡吧。"},"ts":1793266620000}'

# 上传图片（拿回可直连 url）
curl -s -X POST localhost:7791/api/v1/media \
  -H 'Authorization: Bearer <SELFIM_TOKEN>' -F 'file=@a.png'
```

## 和协议的差异（有意为之的三处）

1. **`/api/v1/history` 返回空数组**。协议标的是"可选"。VoceChat 的历史要登录态凭据，不值得为可选功能维护第二套鉴权。
2. **图片快路径**。如果 `payload.url` 本来就指向 `IM_BASE`（说明核心先走了 `/api/v1/media`），桥接直接把 path 交给 IM，不再下载重传。
3. **`/webhook/vocechat` 永远回 200**。VoceChat 遇到非 2xx 会反复重投；转发失败已经落在桥接日志里，不需要让 IM 跟着抖。

## 自测

```bash
node test-e2e.mjs
```

会起一个假 VoceChat（18081）、一个假核心（18082，带真验签），把桥接拉起来跑 13 条断言，覆盖协议 §10 的四项验收。不依赖任何外网。

## 换 IM 要改哪里

只需要新写一个 `driver-xxx.mjs`，导出同样 7 个方法（`health / sendText / sendFile / upload / fileUrl / parseInbound / name`），
在 `bridge.mjs` 第 20 行左右把 `createVoceChatDriver` 换掉。`bridge.mjs` 其余部分与 IM 无关。

Tinode 的驱动思路：用官方 `chatbot` 示例跑常驻 gRPC 客户端，`parseInbound` 变成"从长连接消息回调里取"，其余不变。
