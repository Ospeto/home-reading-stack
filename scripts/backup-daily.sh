#!/bin/bash
set -euo pipefail

# Robust symlink resolution loop
SOURCE="${BASH_SOURCE[0]}"
while [ -L "$SOURCE" ]; do
  DIR="$(cd -P "$(dirname "$SOURCE")" && pwd)"
  SOURCE="$(readlink "$SOURCE")"
  [[ $SOURCE != /* ]] && SOURCE="$DIR/$SOURCE"
done
DIR="$(cd -P "$(dirname "$SOURCE")" && pwd)"
LIGHTHOUSE_ROOT="$(cd -P "$DIR/.." && pwd)"
export LIGHTHOUSE_ROOT

export PATH="/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:$PATH"

ENV_FILE="${ENV_FILE:-${LIGHTHOUSE_ROOT}/.env}"
if [ ! -f "$ENV_FILE" ] && [ -f "${LIGHTHOUSE_ROOT}/uploader/.env" ]; then
  ENV_FILE="${LIGHTHOUSE_ROOT}/uploader/.env"
fi

anchor_path() {
  local p="$1"
  case "$p" in
    /*) echo "$p" ;;
    *) echo "${LIGHTHOUSE_ROOT}/${p#./}" ;;
  esac
}

# Load environment configuration if available
TELEGRAM_BOT_TOKEN="${TELEGRAM_BOT_TOKEN:-}"
TELEGRAM_BACKUP_CHAT_ID="${TELEGRAM_BACKUP_CHAT_ID:-}"
BACKUP_DIR="${BACKUP_DIR:-}"
CALIBRE_LIBRARY_DIR="${CALIBRE_LIBRARY_DIR:-}"
CALIBRE_DB_PATH="${CALIBRE_DB_PATH:-}"
KOSYNC_DB_PATH="${KOSYNC_DB_PATH:-}"
CACHE_DB_PATH="${CACHE_DB_PATH:-}"
JOBS_DB_PATH="${JOBS_DB_PATH:-}"
MANGA_DB_PATH="${MANGA_DB_PATH:-}"
SSD_BACKUP_DIR="${SSD_BACKUP_DIR:-}"

if [ -f "$ENV_FILE" ]; then
  while IFS='=' read -r key val || [ -n "$key" ]; do
    key=$(echo "$key" | tr -d '[:space:]')
    [[ "$key" =~ ^#.*$ ]] && continue
    [ -z "$key" ] && continue
    val=$(echo "$val" | sed -e 's/^[[:space:]]*//' -e 's/[[:space:]]*$//' -e 's/^"\(.*\)"$/\1/' -e "s/^'\(.*\)'$/\1/")
    # Evaluate $HOME or ~ if present
    val="${val/#\~/$HOME}"
    val="${val//\$\{HOME\}/$HOME}"
    val="${val//\$HOME/$HOME}"
    case "$key" in
      TELEGRAM_BOT_TOKEN) [ -z "$TELEGRAM_BOT_TOKEN" ] && TELEGRAM_BOT_TOKEN="$val" ;;
      TELEGRAM_BACKUP_CHAT_ID) [ -z "$TELEGRAM_BACKUP_CHAT_ID" ] && TELEGRAM_BACKUP_CHAT_ID="$val" ;;
      BACKUP_DIR) [ -z "$BACKUP_DIR" ] && BACKUP_DIR="$(anchor_path "$val")" ;;
      CALIBRE_LIBRARY_DIR) [ -z "$CALIBRE_LIBRARY_DIR" ] && CALIBRE_LIBRARY_DIR="$(anchor_path "$val")" ;;
      CALIBRE_DB_PATH) [ -z "$CALIBRE_DB_PATH" ] && CALIBRE_DB_PATH="$(anchor_path "$val")" ;;
      KOSYNC_DB_PATH) [ -z "$KOSYNC_DB_PATH" ] && KOSYNC_DB_PATH="$(anchor_path "$val")" ;;
      CACHE_DB_PATH) [ -z "$CACHE_DB_PATH" ] && CACHE_DB_PATH="$(anchor_path "$val")" ;;
      JOBS_DB_PATH) [ -z "$JOBS_DB_PATH" ] && JOBS_DB_PATH="$(anchor_path "$val")" ;;
      MANGA_DB_PATH) [ -z "$MANGA_DB_PATH" ] && MANGA_DB_PATH="$(anchor_path "$val")" ;;
      SSD_BACKUP_DIR) [ -z "$SSD_BACKUP_DIR" ] && SSD_BACKUP_DIR="$(anchor_path "$val")" ;;
      PROXY_URL) [ -z "${PROXY_URL:-}" ] && PROXY_URL="$val" ;;
    esac
  done < "$ENV_FILE"
fi

LOG_DIR="${LOG_DIR:-${HOME}/Library/Logs}"
LOG_FILE="${LOG_FILE:-${LOG_DIR}/reading-stack-backup.log}"
LOCAL_BACKUP_DIR="${LOCAL_BACKUP_DIR:-${BACKUP_DIR:-${HOME}/.backups/reading-stack}}"
TEMP_DIR=$(mktemp -d /tmp/reading-stack-backup-XXXXXX)
TIMESTAMP=$(date "+%Y-%m-%d_%H%M%S")
DISPLAY_DATE=$(date "+%Y-%m-%d %H:%M:%S")
PROXY_URL="${PROXY_URL:-http://127.0.0.1:7890}"

log() {
  local NOW
  NOW=$(date "+%Y-%m-%d %H:%M:%S")
  echo "${NOW} [BACKUP] $1" | tee -a "$LOG_FILE"
}

cleanup() {
  rm -rf "$TEMP_DIR"
}
trap cleanup EXIT

log "Starting Daily Reading Stack Backup..."

mkdir -p "$LOCAL_BACKUP_DIR"
mkdir -p "$(dirname "$LOG_FILE")"

BACKED_UP_DBS=()

# 1. Hot SQLite Backup KOSync DB
KOSYNC_DB="${KOSYNC_DB:-${KOSYNC_DB_PATH:-${HOME}/kosync-server/data/koreader-sync.db}}"
if [ -f "$KOSYNC_DB" ]; then
  sqlite3 "$KOSYNC_DB" "PRAGMA wal_checkpoint(TRUNCATE);" >/dev/null 2>&1 || true
  if sqlite3 "$KOSYNC_DB" ".backup '${TEMP_DIR}/koreader-sync.db'"; then
    sqlite3 "${TEMP_DIR}/koreader-sync.db" "PRAGMA quick_check;" >/dev/null 2>&1 || {
      log "Error: Integrity check failed on backed up KOSync database"
      exit 1
    }
    log "Backed up KOSync database"
    BACKED_UP_DBS+=("KOSync")
  else
    log "Error: Failed to back up KOSync database"
    exit 1
  fi
else
  log "Notice: KOSync database not found at $KOSYNC_DB, skipping"
fi

# 2. Hot SQLite Backup Calibre Library metadata.db
CALIBRE_DB="${CALIBRE_DB:-${CALIBRE_DB_PATH:-}}"
if [ -z "$CALIBRE_DB" ]; then
  if [ -n "$CALIBRE_LIBRARY_DIR" ] && [ -f "${CALIBRE_LIBRARY_DIR}/metadata.db" ]; then
    CALIBRE_DB="${CALIBRE_LIBRARY_DIR}/metadata.db"
  else
    CALIBRE_DB="${HOME}/Calibre Libraries/Agent Library/metadata.db"
  fi
fi
if [ -f "$CALIBRE_DB" ]; then
  sqlite3 "$CALIBRE_DB" "PRAGMA wal_checkpoint(TRUNCATE);" >/dev/null 2>&1 || true
  if sqlite3 "$CALIBRE_DB" ".backup '${TEMP_DIR}/metadata.db'"; then
    sqlite3 "${TEMP_DIR}/metadata.db" "PRAGMA quick_check;" >/dev/null 2>&1 || {
      log "Error: Integrity check failed on backed up Calibre database"
      exit 1
    }
    log "Backed up Calibre metadata database"
    BACKED_UP_DBS+=("Calibre")
  else
    log "Error: Failed to back up Calibre metadata database"
    exit 1
  fi
else
  log "Notice: Calibre database not found at $CALIBRE_DB, skipping"
fi

# 3. Hot SQLite Backup Uploader Cache DB
CACHE_DB="${CACHE_DB:-${CACHE_DB_PATH:-${JOBS_DB_PATH:-}}}"
if [ -z "$CACHE_DB" ]; then
  if [ -f "${LIGHTHOUSE_ROOT}/cache.db" ]; then
    CACHE_DB="${LIGHTHOUSE_ROOT}/cache.db"
  else
    CACHE_DB="${LIGHTHOUSE_ROOT}/uploader/cache.db"
  fi
fi
if [ -f "$CACHE_DB" ]; then
  sqlite3 "$CACHE_DB" "PRAGMA wal_checkpoint(TRUNCATE);" >/dev/null 2>&1 || true
  if sqlite3 "$CACHE_DB" ".backup '${TEMP_DIR}/cache.db'"; then
    sqlite3 "${TEMP_DIR}/cache.db" "PRAGMA quick_check;" >/dev/null 2>&1 || {
      log "Error: Integrity check failed on backed up Uploader cache database"
      exit 1
    }
    log "Backed up Uploader cache database"
    BACKED_UP_DBS+=("Uploader Cache")
  else
    log "Error: Failed to back up Uploader cache database"
    exit 1
  fi
else
  log "Notice: Uploader cache database not found at $CACHE_DB, skipping"
fi

# 4. Hot SQLite Backup Manga Processor DB (if present)
MANGA_DB="${MANGA_DB:-${MANGA_DB_PATH:-${HOME}/manga-processor/manga.db}}"
if [ -f "$MANGA_DB" ]; then
  sqlite3 "$MANGA_DB" "PRAGMA wal_checkpoint(TRUNCATE);" >/dev/null 2>&1 || true
  if sqlite3 "$MANGA_DB" ".backup '${TEMP_DIR}/manga.db'"; then
    sqlite3 "${TEMP_DIR}/manga.db" "PRAGMA quick_check;" >/dev/null 2>&1 || {
      log "Error: Integrity check failed on backed up Manga database"
      exit 1
    }
    log "Backed up Manga processor database"
    BACKED_UP_DBS+=("Manga")
  else
    log "Error: Failed to back up Manga processor database"
    exit 1
  fi
else
  log "Notice: Manga processor database not found at $MANGA_DB, skipping"
fi

# Verify at least one database was backed up
if [ ${#BACKED_UP_DBS[@]} -eq 0 ]; then
  log "Error: No databases found or backed up. Aborting archive creation."
  exit 1
fi

# 5. Archive and Compress to Local Safe Storage
ARCHIVE_NAME="reading-stack-backup-${TIMESTAMP}.tar.gz"
LOCAL_ARCHIVE="${LOCAL_BACKUP_DIR}/${ARCHIVE_NAME}"

tar -czf "$LOCAL_ARCHIVE" -C "$TEMP_DIR" .
chmod 600 "$LOCAL_ARCHIVE"

# Generate SHA256 Checksum file
SHA_FILE="${LOCAL_ARCHIVE}.sha256"
if command -v shasum >/dev/null 2>&1; then
  (cd "$LOCAL_BACKUP_DIR" && shasum -a 256 "$ARCHIVE_NAME" > "$(basename "$SHA_FILE")")
elif command -v sha256sum >/dev/null 2>&1; then
  (cd "$LOCAL_BACKUP_DIR" && sha256sum "$ARCHIVE_NAME" > "$(basename "$SHA_FILE")")
fi

ARCHIVE_SIZE_BYTES=$(stat -f%z "$LOCAL_ARCHIVE" 2>/dev/null || stat -c%s "$LOCAL_ARCHIVE" 2>/dev/null || echo 0)
ARCHIVE_SIZE_KB=$(( (ARCHIVE_SIZE_BYTES + 1023) / 1024 ))
log "Created local backup archive: ${ARCHIVE_NAME} (${ARCHIVE_SIZE_KB} KB, checksum: $(basename "$SHA_FILE"))"

# 6. Mirror to External Storage if Available & Writable
if [ -n "$SSD_BACKUP_DIR" ] && [ -d "$(dirname "$SSD_BACKUP_DIR")" ]; then
  mkdir -p "$SSD_BACKUP_DIR" 2>/dev/null || true
  if cp "$LOCAL_ARCHIVE" "${SSD_BACKUP_DIR}/${ARCHIVE_NAME}" 2>/dev/null; then
    [ -f "$SHA_FILE" ] && cp "$SHA_FILE" "${SSD_BACKUP_DIR}/" 2>/dev/null || true
    log "Mirrored backup snapshot to External SSD: ${SSD_BACKUP_DIR}/${ARCHIVE_NAME}"
    find "$SSD_BACKUP_DIR" -name "reading-stack-backup-*.tar.gz" -mtime +7 -delete 2>/dev/null || true
  else
    log "Notice: External SSD write skipped. Local backup is fully secured."
  fi
fi

# 7. Auto-Prune Local Backups Older Than 7 Days
PRUNED=$(find "$LOCAL_BACKUP_DIR" -name "reading-stack-backup-*.tar.gz" -mtime +7 -print -delete 2>/dev/null | wc -l | tr -d " ")
find "$LOCAL_BACKUP_DIR" -name "reading-stack-backup-*.tar.gz.sha256" -mtime +7 -delete 2>/dev/null || true
log "Pruned ${PRUNED} local backup(s) older than 7 days."

# 8. Log Hygiene: Cap active log files at 10MB
for logf in "${LOG_DIR}/telegram-bot.log" \
            "${LOG_DIR}/uploader.log" \
            "${LOG_DIR}/calibre-server.log" \
            "${LOG_DIR}/kosync.log" \
            "${LOG_DIR}/manga-processor.log"; do
  if [ -f "$logf" ] && [ "$(stat -f%z "$logf" 2>/dev/null || echo 0)" -gt 10485760 ]; then
    tail -n 2000 "$logf" > "${logf}.tmp" && mv "${logf}.tmp" "$logf"
    log "Rotated log: $(basename "$logf") (>10MB)"
  fi
done

# 9. Deliver Daily Backup to Telegram if configured
if [ -n "$TELEGRAM_BOT_TOKEN" ] && [ -n "$TELEGRAM_BACKUP_CHAT_ID" ]; then
  DB_LIST=$(printf ", %s" "${BACKED_UP_DBS[@]}")
  DB_LIST="${DB_LIST:2}"
  CAPTION=$(cat << EOF
📊 *Reading Stack Database Backup*
📅 *Date:* ${DISPLAY_DATE}
💾 *Size:* ${ARCHIVE_SIZE_KB} KB
🗄️ *Databases:* ${DB_LIST}
✨ _Secure offline snapshot stored in your Telegram history._
EOF
)

  log "Delivering daily backup archive to Telegram chat ${TELEGRAM_BACKUP_CHAT_ID}..."
  
  TG_RESPONSE=$(curl -s -S --max-time 60 --proxy "$PROXY_URL" \
    -F "chat_id=${TELEGRAM_BACKUP_CHAT_ID}" \
    -F "document=@${LOCAL_ARCHIVE};filename=${ARCHIVE_NAME}" \
    -F "caption=${CAPTION}" \
    -F "parse_mode=Markdown" \
    "https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendDocument" 2>&1 || echo "curl_failed")

  if echo "$TG_RESPONSE" | grep -q '"ok":true'; then
    log "Successfully delivered daily backup to Telegram chat ${TELEGRAM_BACKUP_CHAT_ID}."
  else
    log "Warning: Telegram backup delivery failed: ${TG_RESPONSE}"
  fi
else
  log "Notice: Telegram delivery skipped (TELEGRAM_BOT_TOKEN or TELEGRAM_BACKUP_CHAT_ID not configured)."
fi

log "Daily Reading Stack Backup completed successfully."
