#!/bin/bash
# ==============================================================================
# scripts/categorize-library.sh
#
# Library-wide Calibre categorization & language correction for home-reading-stack.
# Defaults to --dry-run; pass --apply to execute updates via calibredb set_metadata.
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

export PATH="/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:$PATH"

if command -v bun >/dev/null 2>&1; then
  exec bun run "${SCRIPT_DIR}/categorize-library.ts" "$@"
else
  echo "Error: 'bun' runtime is required to execute categorize-library.ts" >&2
  exit 1
fi
