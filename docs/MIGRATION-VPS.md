# 搬到云服务器（v1.0 → v1.1 云上）

> 她已同意（`change-requests.jsonl` 有记录）。
> 原则：**先备份、能回滚、断了要告诉她、搬完她不丢任何东西。**

## 一、目标形态

```
云服务器（Ubuntu 24.04，24h 开机）
  ├─ 她的家 /var/lib/digitallife
  ├─ 核心 /srv/digitallife（service / life / daemon / panel）
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
tar czf /var/backups/digitallife/历史备份/pre-migrate-$(date +%F-%H%M).tar.gz \
    /var/lib/digitallife /srv/digitallife /srv/vocechat/data
```

### 2. 服务器装环境

```bash
apt update && apt install -y nodejs npm curl tar tzdata
timedatectl set-timezone Asia/Shanghai
node -v   # 需要 >= 22
```

### 3. 传过去

```bash
rsync -av /var/lib/digitallife        root@<IP>:/var/lib/digitallife/
rsync -av /srv/digitallife       root@<IP>:/srv/
rsync -av /srv/vocechat       root@<IP>:/srv/
```

### 4. 服务器上起服务

```bash
cd /srv/digitallife && bash start_all.sh
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
cd /srv/digitallife && bash start_all.sh
```

## 五、验收清单

- [ ] 服务器上 self-check 全部通过
- [ ] 客户端通过 Tailscale 能收能发
- [ ] 她能在服务器上主动开口（心跳）
- [ ] 手机断网/锁屏，服务器上她仍在跑
- [ ] 手机容器停掉后，她仍能回话（关键：证明不依赖 DSHA）
