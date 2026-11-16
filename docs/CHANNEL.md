# 双人通道（自建，7790）

**只做四个动作**：下行推送、上行发送、增量拉历史、已读回执。
没有账号体系、没有群、没有好友、没有多端同步、没有数据库。

## 为什么要有它

VoceChat 是完整的 IM（用户、频道、推送、多端），对一个"两个人说话"的场景来说太重，
而且它的历史存在自己的库里，和"文件即记忆"是两套东西。

这个通道把消息存成 **append-only 的 `messages.jsonl`**，和 `chat-archive.jsonl` 同构：

```json
{"id":3743,"at":1794839925058,"dir":"out","text":"灯记得关。"}
```

## 接口

| 方法 | 路径 | 作用 |
|---|---|---|
| POST | `/send` | 他说的话 → 落盘 → 带 HMAC 转发给 service `/inbound` |
| POST | `/push` | 她的话 → 落盘 → SSE 推给在线客户端 |
| GET | `/history?since=<id>` | 增量拉取（最多 200 条） |
| POST | `/read` | 已读回执（只存一个 lastRead） |
| POST | `/mirror` | 别的通道（QQ / VoceChat）的消息旁路镜像 |
| GET | `/events` | SSE 长连接 |
| GET | `/health` | 存活与消息数 |
| GET/POST | `/api/v1/*` | 兼容 bot 现有的 selfim 适配器 |

## 鉴权

- 客户端与 bot 之间：`X-Channel-Token`（或 `Authorization: Bearer`）
- 通道与 service 之间：`X-IM-Signature`（HMAC-SHA256）+ `X-IM-Device-Pin`
- **设备 PIN 的 sha256 存在 service 的 `config.selfim.devicePinHash`**：
  对上了才把来源标成 `user`（他本人），否则标成 `agent`（维护者代发）。
  她能在上下文里区分这两者。

## 去重

同一条消息可能从多条链路写入（QQ 主链、selfim 适配器、镜像）。
通道在 `append()` 里做最后一道闸：**3 秒内、同方向、同文本只收一次。**

## 部署

```bash
systemctl enable --now miku-channel
# 环境变量：CHANNEL_DATA / CHANNEL_PORT / CHANNEL_TOKEN / SELFIM_SECRET / CHANNEL_PIN / SERVICE_URL
```

## 迁移策略

VoceChat 不立刻下线：两条通道并行一周，比对三件事——是否漏消息、是否乱序、断线能否补齐。
历史从 `chat-archive.jsonl` 全量导入（导入时过滤测试消息），之后进出都镜像，
**切过去也不会断历史。**
