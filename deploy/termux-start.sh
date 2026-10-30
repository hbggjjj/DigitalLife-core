#!/bin/bash
# 安卓/Termux 或任何没有 systemd 的机器：起服务 + 看门狗（每分钟检查，掉了就拉起）
APP=/root/qqbot-v5
export TZ=Asia/Shanghai LIFE_DIR=__MIKU_HOME__/life QQBOT_ROOT=$APP
mkdir -p "$APP/logs"

start_if(){ local pat="$1" dir="$2" cmd="$3" name="$4"
  pgrep -f "$pat" >/dev/null && return
  ( cd "$APP/$dir" && setsid nohup env LIFE_DIR=$LIFE_DIR QQBOT_ROOT=$APP node $cmd >> "$APP/logs/$name.log" 2>&1 < /dev/null & )
}
vc(){ curl -s -o /dev/null -m 2 http://127.0.0.1:3000/; }

[ -x /root/vocechat/vocechat-server ] && ! vc && ( cd /root/vocechat && setsid nohup ./vocechat-server >> /tmp/vc.log 2>&1 < /dev/null & )
sleep 3
start_if "node service.mjs" bot "service.mjs" core
start_if "node life.mjs" src/core "life.mjs" life
start_if "node bot.mjs daemon" bot "bot.mjs daemon" daemon
start_if "node server.mjs" panel "server.mjs" panel
pgrep -f "bridge-user.mjs" >/dev/null || ( setsid nohup bash "$APP/tools/bridge/start-her.sh" >> "$APP/logs/bridge.log" 2>&1 < /dev/null & )
sleep 4
for p in 3000 7789 7788 7791; do printf "%s=%s " "$p" "$(curl -s -o /dev/null -w "%{http_code}" -m 2 http://127.0.0.1:$p/)"; done; echo
