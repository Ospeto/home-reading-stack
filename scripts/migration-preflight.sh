#!/bin/bash
# ==============================================================================
# scripts/migration-preflight.sh
#
# Preflight analysis and dry-run inventory for migrating EPUBs from Mac Mini
# (/Volumes/Ospeto_SSD/Calibre Library) into canonical library (/Users/ospeto/Calibre Libraries/Agent Library).
#
# CRITICAL SAFETY GUARANTEE:
# Strictly READ-ONLY. Does not copy, rename, delete, or merge live Calibre folders.
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
  exec bun run "${SCRIPT_DIR}/migration-preflight.ts" "$@"
else
  echo "Error: 'bun' runtime is required to execute migration-preflight.ts" >&2
  exit 1
fi
