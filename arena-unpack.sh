#!/usr/bin/env bash
# arena-unpack — разложить присланный архив обратно в проект (macOS/Linux).
#   ./arena-unpack.sh reply.zip [--into ~/dev/my-app] [--dry-run]
set -euo pipefail
DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
exec node "$DIR/tools/arena-unpack.mjs" "$@"
