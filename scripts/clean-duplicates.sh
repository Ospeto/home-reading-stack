#!/bin/bash
# ==============================================================================
# scripts/clean-duplicates.sh
#
# Library-wide Calibre duplicate cleaner for home-reading-stack.
# Defaults to --dry-run; pass --apply or --prune to execute removals.
# ==============================================================================

set -euo pipefail

SOURCE="${BASH_SOURCE[0]}"
while [ -L "$SOURCE" ]; do
  DIR="$(cd -P "$(dirname "$SOURCE")" && pwd)"
  SOURCE="$(readlink "$SOURCE")"
  [[ $SOURCE != /* ]] && SOURCE="$DIR/$SOURCE"
done
SCRIPT_DIR="$(cd -P "$(dirname "$SOURCE")" && pwd)"
LIGHTHOUSE_ROOT="$(cd -P "$SCRIPT_DIR/.." && pwd)"
export LIGHTHOUSE_ROOT

# Ensure uploader alias exists for flattened deployment layouts
[ ! -e "${LIGHTHOUSE_ROOT}/uploader" ] && ln -s . "${LIGHTHOUSE_ROOT}/uploader" 2>/dev/null || true

export PATH="/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:$PATH"

if command -v bun >/dev/null 2>&1; then
  exec bun run "${SCRIPT_DIR}/clean-duplicates.ts" "$@"
else
  echo "Error: 'bun' runtime is required to execute clean-duplicates.ts" >&2
  exit 1
fi
