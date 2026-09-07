#!/usr/bin/env bash
set -euo pipefail

CONTAINER_NAME="${CONTAINER_NAME:-qq-deepseek-bot}"

if ! docker ps --format '{{.Names}}' | grep -Fxq "$CONTAINER_NAME"; then
  echo "❌ 容器未运行：$CONTAINER_NAME"
  echo "请先启动容器，例如：docker compose up -d"
  exit 1
fi

echo "▶ 正在进入容器 $CONTAINER_NAME 执行 npm run menu:setup ..."
docker exec "$CONTAINER_NAME" npm run menu:setup

echo "✅ Qgent 自定义菜单配置完成"