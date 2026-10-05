#!/usr/bin/env bash
# arena-pack — упаковать проект для отправки в чат (macOS/Linux).
#   ./arena-pack.sh [папка] [--include src] [--all] [--max 20] ...
set -euo pipefail
DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
exec node "$DIR/tools/arena-pack.mjs" "$@"
