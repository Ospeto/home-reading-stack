#!/bin/bash
# ==============================================================================
# scripts/backup-ssd.sh
#
# Incremental whole-library backup to external SSD (e.g. /Volumes/Ospeto_SSD)
# Mirrors Calibre library (EPUBs, covers, author trees) and hot-backups SQLite DBs.
# ==============================================================================

set -euo pipefail

# Robust canonical symlink resolution loop
SOURCE="${BASH_SOURCE[0]}"
while [ -L "$SOURCE" ]; do
  DIR="$(cd -P "$(dirname "$SOURCE")" && pwd)"
  SOURCE="$(readlink "$SOURCE")"
  [[ $SOURCE != /* ]] && SOURCE="$DIR/$SOURCE"
done
DIR="$(cd -P "$(dirname "$SOURCE")" && pwd)"
LIGHTHOUSE_ROOT="$(cd -P "$DIR/.." && pwd)"
export LIGHTHOUSE_ROOT

# Ensure uploader alias exists for flattened deployment layouts
[ ! -e "${LIGHTHOUSE_ROOT}/uploader" ] && ln -s . "${LIGHTHOUSE_ROOT}/uploader" 2>/dev/null || true

export PATH="/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin:$PATH"

ENV_FILE="${ENV_FILE:-${LIGHTHOUSE_ROOT}/.env}"
if [ ! -f "$ENV_FILE" ] && [ -f "${LIGHTHOUSE_ROOT}/uploader/.env" ]; then
  ENV_FILE="${LIGHTHOUSE_ROOT}/uploader/.env"
fi

if [ -f "$ENV_FILE" ]; then
  # Source non-comment environment variables
  while IFS='=' read -r key val || [ -n "$key" ]; do
    key=$(echo "$key" | tr -d '[:space:]')
    [[ "$key" =~ ^#.*$ ]] && continue
    [ -z "$key" ] && continue
    if [[ "$val" =~ ^\"(.*)\"[[:space:]]*(#.*)?$ ]]; then
      val="${BASH_REMATCH[1]}"
    elif [[ "$val" =~ ^\'(.*)\'[[:space:]]*(#.*)?$ ]]; then
      val="${BASH_REMATCH[1]}"
    else
      val="${val%%#*}"
      val=$(echo "$val" | sed -e 's/^[[:space:]]*//' -e 's/[[:space:]]*$//')
    fi
    val="${val/#\~/$HOME}"
    val="${val//\$\{HOME\}/$HOME}"
    val="${val//\$HOME/$HOME}"
    case "$key" in
      CALIBRE_LIBRARY_DIR) [ -z "${CALIBRE_LIBRARY_DIR:-}" ] && export CALIBRE_LIBRARY_DIR="$val" ;;
      CALIBRE_DB_PATH) [ -z "${CALIBRE_DB_PATH:-}" ] && export CALIBRE_DB_PATH="$val" ;;
      KOSYNC_DB_PATH) [ -z "${KOSYNC_DB_PATH:-}" ] && export KOSYNC_DB_PATH="$val" ;;
      CACHE_DB_PATH) [ -z "${CACHE_DB_PATH:-}" ] && export CACHE_DB_PATH="$val" ;;
      MANGA_DB_PATH) [ -z "${MANGA_DB_PATH:-}" ] && export MANGA_DB_PATH="$val" ;;
      SSD_BACKUP_DIR) [ -z "${SSD_BACKUP_DIR:-}" ] && export SSD_BACKUP_DIR="$val" ;;
      LIGHTHOUSE_VOLUMES_DIR) [ -z "${LIGHTHOUSE_VOLUMES_DIR:-}" ] && export LIGHTHOUSE_VOLUMES_DIR="$val" ;;
    esac
  done < "$ENV_FILE"
fi

SCRIPT_PATH="${LIGHTHOUSE_ROOT}/uploader/ssd-backup.ts"
if [ ! -f "$SCRIPT_PATH" ]; then
  echo "Error: SSD backup script not found at ${SCRIPT_PATH}" >&2
  exit 1
fi

if command -v bun >/dev/null 2>&1; then
  exec bun run "$SCRIPT_PATH" "$@"
else
  echo "Error: 'bun' runtime is required to execute ssd-backup.ts" >&2
  exit 1
fi
