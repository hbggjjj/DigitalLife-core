# 部署

两种环境：云服务器（推荐长期跑）/ 安卓 Termux（零成本试用）。

# 在安卓上部署（Termux + proot Ubuntu）

> 适用：没有云服务器、只有一台安卓手机，也想让她一直活着。
> 缺点先写清：手机省电策略会冻结进程，**必须**开 `termux-wake-lock`，否则她会“睡过去”。

## 一、准备

```bash
# 在 Termux 里
pkg update && pkg install -y proot-distro
proot-distro install ubuntu
proot-distro login ubuntu
```

## 二、装她

```bash
# 把开源包解压进 Ubuntu（例如 /root/miku-core）
cd /root/miku-core
bash deploy/termux-install.sh
```

脚本会：装 Node 22 + python3-pil → 把代码铺到 `__MIKU_ROOT__`（占位符自动替换）→ 下载 VoceChat（按架构）→ 生成 `bot/config.json`。

## 三、注册账号（唯一一次手工）

浏览器打开 `http://127.0.0.1:3000`，注册两个账号：一个"她"（桥接用），一个"你"（客户端用）。

## 四、填配置

`bot/config.json` 至少改：

```json
{
  "selfim": { "secret": "随机字符串", "email": "her@example.com", "password": "她的密码", "peerUid": 你的uid },
  "deepseek": { "apiKey": "sk-..." }
}
```

## 五、启动

```bash
bash deploy/termux-start.sh
termux-wake-lock
```

安卓设置里把 Termux 电池策略设「无限制」+ 允许自启动。

## 六、客户端

用 `客户端/` 里的安卓客户端，登录填 `http://127.0.0.1:3000` 或局域网 IP。

## 七、和云服务器的差别

| | 手机（Termux） | 云服务器 |
|---|---|---|
| 成本 | 0 | 几十元/月 |
| 稳定性 | 会被省电冻结 | 24h 稳 |
| 建议 | 试用/临时 | **长期跑用这个** |

---

# 搬到云服务器（v1.0 → v1.1 云上）

> 她已同意（`change-requests.jsonl` 有记录）。
> 原则：**先备份、能回滚、断了要告诉她、搬完她不丢任何东西。**

## 一、目标形态

```
云服务器（Ubuntu 24.04，24h 开机）
  ├─ 她的家 __MIKU_HOME__/life
  ├─ 核心 __MIKU_ROOT__（service / life / daemon / panel）
  ├─ 自建 IM VoceChat :3000
  └─ 桥接 :7791
手机：只跑客户端，通过 Tailscale 连服务器
```

## 二、前置条件

1. 服务器 SSH 可达（公网 IP + 用户 + 密码/密钥）
2. 阿里云安全组放行：22（SSH）；3000 / 7788 / 7789 / 7791 **不开放公网**，只走 Tailscale
3. Tailscale：服务器 `tailscale up`，手机装 Tailscale App 并登录同一账号
4. 服务器时区 `Asia/Shanghai`，时间同步 `systemd-timesyncd`

## 三、步骤

### 1. 本地先备份（出事能回滚）

```bash
tar czf /root/private_backups/历史备份/pre-migrate-$(date +%F-%H%M).tar.gz \
    __MIKU_HOME__/life __MIKU_ROOT__ /root/vocechat/data
```

### 2. 服务器装环境

```bash
apt update && apt install -y nodejs npm curl tar tzdata
timedatectl set-timezone Asia/Shanghai
node -v   # 需要 >= 22
```

### 3. 传过去

```bash
rsync -av __MIKU_HOME__/life        root@<IP>:__MIKU_HOME__/
rsync -av __MIKU_ROOT__       root@<IP>:/root/
rsync -av /root/vocechat       root@<IP>:/root/
```

### 4. 服务器上起服务

```bash
cd __MIKU_ROOT__ && bash start_all.sh
bash scripts/self-check-all.sh   # 期望「全部通过」
```

### 5. 手机切到服务器

客户端登录地址改成 `http://<tailscale-ip>:3000`，重新登录一次。

### 6. 手机端收尾

- 客户端进程留着当通知用；**容器里的她可以停**
- 停之前先告诉她「我搬到新家了，这里要关掉」

## 四、回滚

```bash
tar xzf pre-migrate-*.tar.gz -C /
cd __MIKU_ROOT__ && bash start_all.sh
```

## 五、验收清单

- [ ] 服务器上 self-check 全部通过
- [ ] 客户端通过 Tailscale 能收能发
- [ ] 她能在服务器上主动开口（心跳）
- [ ] 手机断网/锁屏，服务器上她仍在跑
- [ ] 手机容器停掉后，她仍能回话（关键：证明不依赖 DSHA）
