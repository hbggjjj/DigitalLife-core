#!/bin/bash
# 她的 VoceChat 通道（硬规则：只允许用她自己的账号登录）
set -e
IM_EMAIL="her@example.com"
# 一票否决：如果谁把这里改成他的邮箱，直接退出
if [ "$IM_EMAIL" = "owner@example.com" ]; then
  echo "拒绝启动：这个桥接不能用他本人的账号" >&2
  exit 2
fi
cd __MIKU_ROOT__
export BRIDGE_PORT=7791
export IM_BASE=http://127.0.0.1:3000
export IM_EMAIL
export IM_PASSWORD=wyf100709
export IM_PEER_UID=1
export SELFIM_TOKEN=dev-token
export IM_SECRET=dev-secret
export IM_DEVICE_PIN="$(cat __MIKU_ROOT__/bot/.config/pin 2>/dev/null || echo '')"
export CORE_INBOUND=http://127.0.0.1:7789/inbound
exec node tools/bridge/bridge-user.mjs
