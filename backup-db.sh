#!/usr/bin/env bash
set -euo pipefail

cd -- "$(dirname -- "${BASH_SOURCE[0]}")"

if [[ $# -gt 1 ]]; then
  echo "用法: ./backup-db.sh [容器内的数据库路径，默认 /app/data/qgent.db]" >&2
  exit 1
fi

# A temporary container also works when the bot is stopped; it shares ./data.
exec docker compose run --rm --no-deps -T qq-deepseek-bot \
  npm run db:backup -- --source "${1:-/app/data/qgent.db}"
