#!/bin/bash
# ==============================================================================
# scripts/sync-series-metadata.sh
#
# Synchronizes series and volume metadata across the Calibre library using
# source DB mapping (/Volumes/Ospeto_SSD/Calibre Library) and title heuristics.
# ==============================================================================

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

export PATH="/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:$PATH"

if command -v bun >/dev/null 2>&1; then
  exec bun run "${SCRIPT_DIR}/sync-series-metadata.ts" "$@"
else
  echo "Error: 'bun' runtime is required to execute sync-series-metadata.ts" >&2
  exit 1
fi
