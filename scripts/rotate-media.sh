#!/bin/bash
# SPDX-License-Identifier: AGPL-3.0-or-later
# 通道图片按月分目录；这里只删超过保留期（默认 180 天）的分月目录
set -u
MEDIA=${CHANNEL_MEDIA:-/var/lib/digitallife-channel/media}
DAYS=${1:-180}
[ -d "$MEDIA" ] || exit 0
find "$MEDIA" -mindepth 1 -maxdepth 1 -type d -mtime +"$DAYS" -print0 2>/dev/null | while IFS= read -r -d '' d; do
  rm -rf "$d" && echo "清理旧媒体目录 $(basename "$d")"
done
