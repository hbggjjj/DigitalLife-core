#!/bin/bash
# 安卓自建：Termux + proot Ubuntu 上装一套"她"。
# 在 Termux 里执行：
#   pkg update && pkg install -y proot-distro
#   proot-distro install ubuntu
#   proot-distro login ubuntu
# 然后在 Ubuntu 里跑本脚本（它会把代码装到 /root/qqbot-v5）。
set -e
SRC_DIR=$(cd "$(dirname "$0")/.." && pwd)
APP=/root/qqbot-v5
LIFE=__MIKU_HOME__

echo "== 装系统依赖 =="
apt-get update -qq
DEBIAN_FRONTEND=noninteractive apt-get install -y -qq curl ca-certificates tar python3 python3-pil tzdata >/dev/null
timedatectl set-timezone Asia/Shanghai || true

if ! command -v node >/dev/null 2>&1; then
  echo "== 装 Node 22 =="
  ARCH=$(uname -m); [ "$ARCH" = "aarch64" ] && NARCH=arm64 || NARCH=x64
  curl -fsSL -o /tmp/node.tar.xz "https://nodejs.org/dist/v22.20.0/node-v22.20.0-linux-${NARCH}.tar.xz"
  mkdir -p /usr/local/node && tar xf /tmp/node.tar.xz -C /usr/local/node --strip-components=1
  ln -sf /usr/local/node/bin/node /usr/local/bin/node
  ln -sf /usr/local/node/bin/npm /usr/local/bin/npm
fi
node -v

echo "== 铺代码 =="
mkdir -p "$APP" "$LIFE"
rsync -a --delete "$SRC_DIR/" "$APP/" 2>/dev/null || cp -a "$SRC_DIR/." "$APP/"

# 把占位符换成本机真实路径
find "$APP" -type f \( -name '*.mjs' -o -name '*.sh' -o -name '*.json' \) -print0 2>/dev/null | while IFS= read -r -d '' f; do
  sed -i "s#__MIKU_ROOT__#$APP#g; s#__MIKU_HOME__#$LIFE#g" "$f"
done

echo "== 自建 IM（VoceChat）=="
if [ ! -x /root/vocechat/vocechat-server ]; then
  mkdir -p /root/vocechat
  ARCH=$(uname -m)
  if [ "$ARCH" = "aarch64" ]; then VC=aarch64; else VC=x86_64; fi
  curl -fsSL -o /tmp/vc.zip "https://github.com/Privoce/vocechat-server-rust/releases/download/v0.5.39/vocechat-server-v0.5.39-${VC}-unknown-linux-musl.zip" || {
    echo "VoceChat 下载失败：请手动把二进制放到 /root/vocechat/vocechat-server"; }
  (cd /root/vocechat && unzip -o /tmp/vc.zip >/dev/null 2>&1 || true; chmod +x vocechat-server 2>/dev/null || true)
fi

echo "== 生成示例配置 =="
[ -f "$APP/bot/config.json" ] || cp "$APP/config.example.json" "$APP/bot/config.json" 2>/dev/null || true
[ -f "$APP/bot/schedule.json" ] || echo '{"activeStart":"00:00","activeEnd":"23:59"}' > "$APP/bot/schedule.json"

echo "== 起服务 =="
bash "$APP/deploy/termux-start.sh"

cat <<TIP

装好了。接下来要做的三件事：
1) 打开 http://127.0.0.1:3000 注册两个账号：一个"她"，一个"你"
2) 填 $APP/bot/config.json：模型 key、selfim.secret、她的邮箱密码
3) 再跑一次：bash $APP/deploy/termux-start.sh

安卓上要保活：
  termux-wake-lock
  设置 → 电池 → Termux → 无限制
TIP
