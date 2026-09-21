#!/bin/bash
# ==============================================================================
# scripts/sync-series-metadata.sh
#
# Synchronizes series and volume metadata across the Calibre library using
# source DB mapping (/Volumes/Ospeto_SSD/Calibre Library) and title heuristics.
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
  exec bun run "${SCRIPT_DIR}/sync-series-metadata.ts" "$@"
else
  echo "Error: 'bun' runtime is required to execute sync-series-metadata.ts" >&2
  exit 1
fi
