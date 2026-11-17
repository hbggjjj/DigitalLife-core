# 通道客户端（最小实现）

一个只做四件事的 Android 客户端：**拉历史、发消息、发图、标已读**。
没有动画、没有主题、没有第三方依赖，只有两个类。

## 验证方式

服务端是三层的，缺一不可：

| 层 | 客户端提供 | 服务端怎么验 |
|---|---|---|
| mTLS | `assets/client.p12` | TLS 握手要求出示客户端证书，且必须由同一个 CA 签 |
| Token | `X-Channel-Token` | 与 `CHANNEL_TOKEN` 比对 |
| PIN | `X-Device-Pin` | 服务端只存 `sha256`；不匹配返回 `401 PIN_REQUIRED`，该条消息不入库 |

## 签证书

仓库不含任何证书或私钥。自己签：

```bash
chmod +x scripts/gen-certs.sh
./scripts/gen-certs.sh 1.2.3.4        # 服务器 IP（可选第二个参数作为备用 IP/域名）
```

产物在 `out/`：

```
ca.crt        → 服务端 channel/tls/  与  客户端 app/src/main/assets/
server.crt    → 服务端 channel/tls/
server.key    → 服务端 channel/tls/
client.p12    → 客户端 app/src/main/assets/client.p12（默认密码 dl2026）
```

`Channel.buildTls(this, "CHANGE_ME")` 的密码改成你自己设的。

## 服务端配置

```ini
# /etc/systemd/system/<服务名>.service.d/tls.conf
[Service]
Environment=CHANNEL_TLS_PORT=7792
Environment=CHANNEL_TLS_CERT=/path/to/tls/server.crt
Environment=CHANNEL_TLS_KEY=/path/to/tls/server.key
Environment=CHANNEL_TLS_CA=/path/to/tls/ca.crt
```

安全组放行 TCP 7792；明文端口只对本机。

`CHANNEL_TOKEN` 在服务单元里设置；设备 PIN 的哈希存在服务端配置 `selfim.devicePinHash`（`sha256(PIN)`）。

## 编译

```bash
./gradlew assembleDebug
adb install -r app/build/outputs/apk/debug/app-debug.apk
```

首次启动填三项：地址（`https://1.2.3.4:7792`）、Token、PIN。

## 协议

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/history?since=<id>&limit=200` | `{messages:[{id,at,dir,text,images}], hasMore}` |
| POST | `/send` | `{text}` 或 `{images:[{path:"/media/…"}]}` |
| POST | `/upload?ext=jpg` | 原始字节 → `{name,path,url}` |
| POST | `/read` | `{id}` |
| GET | `/media/<name>` | 取图 |
| GET | `/health` | `{ok,messages,media}` |

`dir` 为 `in` 或 `out`。

## 这版没做

- 用 4 秒轮询，没有 SSE
- 一次拉 200 条，不分页续拉
- 图片不压缩、不缓存
- 没有后台保活
