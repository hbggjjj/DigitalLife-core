# 通道客户端（最素版）

只做四件事：**拉历史、发消息、发图、标已读**。
没有动画、没有主题、没有花活——**协议和验证跟正式客户端完全一致**。

适合：想接自己的通道、但不需要那套终端风 UI 的人。

## 它验证什么

三层，缺一不可：

| 层 | 你提供 | 服务器怎么验 |
|---|---|---|
| **mTLS** | `assets/client.p12`（你自己的客户端证书） | TLS 握手时要求出示，且必须由同一个 CA 签 |
| **Token** | `X-Channel-Token` | 和服务器 `CHANNEL_TOKEN` 比对 |
| **PIN** | `X-Device-Pin`（4 位数字） | 服务器只存 `sha256`；不对就返回 `401 PIN_REQUIRED`，**消息不入库** |

**PIN 不对 = 那条消息根本不会被记下来，也不会触发她。** 不做「降级成代发」。

## 自己签证书（重要）

仓库里**不带任何证书**。你自己签：

```bash
chmod +x scripts/gen-certs.sh
./scripts/gen-certs.sh 1.2.3.4          # 你的服务器 IP
```

产物在 `out/`：

```
ca.crt        → 服务器 channel/tls/ 和 客户端 app/src/main/assets/
server.crt    → 服务器 channel/tls/
server.key    → 服务器 channel/tls/
client.p12    → 客户端 app/src/main/assets/client.p12（密码 dl2026）
```

**然后改一处代码**：`Channel.buildTls(this, "CHANGE_ME")` 里的密码改成你自己的。

## 服务器怎么配

```ini
# /etc/systemd/system/miku-channel.service.d/tls.conf
[Service]
Environment=CHANNEL_TLS_PORT=7792
Environment=CHANNEL_TLS_CERT=/path/to/channel/tls/server.crt
Environment=CHANNEL_TLS_KEY=/path/to/channel/tls/server.key
Environment=CHANNEL_TLS_CA=/path/to/channel/tls/ca.crt
```

**安全组开 TCP 7792。** 7790 只留本机。

`CHANNEL_TOKEN` 在 `miku-channel.service` 里设；**设备 PIN 的 hash 存在服务端配置的 `selfim.devicePinHash`**（`sha256(你的PIN)`）。

## 编译

```bash
./gradlew assembleDebug
adb install -r app/build/outputs/apk/debug/app-debug.apk
```

首次启动填三项：地址（`https://1.2.3.4:7792`）、token、PIN。

## 协议

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/history?since=<id>&limit=200` | 返回 `{messages:[{id,at,dir,text,images}], hasMore}` |
| POST | `/send` | `{text}` 或 `{images:[{path:"/media/…"}]}` |
| POST | `/upload?ext=jpg` | 原始字节 → `{name,path,url}` |
| POST | `/read` | `{id}` |
| GET | `/media/<name>` | 取图 |
| GET | `/health` | `{ok,messages,media}` |

`dir` 是 `in`（他说的）或 `out`（她说的）。

## 没有做的事

- 不做 SSE，用 4 秒轮询
- 不做分页续拉（一次 200 条，够用就行）
- 不做图片压缩、不做本地缓存
- 不做后台保活

需要这些，去看正式客户端（不在本仓库）。
