#!/bin/bash
# SPDX-License-Identifier: AGPL-3.0-or-later
# 把超过 N 天的 trace 按天压成 .gz（默认 30 天，保留原文件名+.gz）
set -u
DIR=${LIFE_DIR:-/var/lib/digitallife}/trace
DAYS=${1:-30}
[ -d "$DIR" ] || exit 0
find "$DIR" -maxdepth 1 -name '*.jsonl' -mtime +"$DAYS" -print0 2>/dev/null | while IFS= read -r -d '' f; do
  gzip -9 "$f" && echo "压缩 $(basename "$f")"
done
