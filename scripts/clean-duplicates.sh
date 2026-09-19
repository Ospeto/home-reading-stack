#!/bin/bash
# ==============================================================================
# scripts/clean-duplicates.sh
#
# Scans the Calibre library for duplicates (by content hash, series/volume match,
# or normalized title/author similarity).
#
# Usage:
#   scripts/clean-duplicates.sh [--dry-run] [--apply] [--library-dir <path>]
# ==============================================================================

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

export PATH="/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:$PATH"

if command -v bun >/dev/null 2>&1; then
  exec bun run "${SCRIPT_DIR}/clean-duplicates.ts" "$@"
else
  echo "Error: 'bun' runtime is required to execute clean-duplicates.ts" >&2
  exit 1
fi
