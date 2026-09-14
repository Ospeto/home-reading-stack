#!/bin/bash
set -euo pipefail

export PATH="/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:$PATH"

LOCAL_BACKUP_DIR="${LOCAL_BACKUP_DIR:-/Users/ospeto/.backups/reading-stack}"
SSD_BACKUP_DIR="${SSD_BACKUP_DIR:-/Volumes/Ospeto_SSD/backups/reading-stack}"
TEMP_DIR=$(mktemp -d /tmp/reading-stack-backup-XXXXXX)
TIMESTAMP=$(date "+%Y-%m-%d_%H%M%S")
DISPLAY_DATE=$(date "+%Y-%m-%d %H:%M:%S")
LOG_FILE="${LOG_FILE:-/Users/ospeto/Library/Logs/reading-stack-backup.log}"
ENV_FILE="${ENV_FILE:-/Users/ospeto/uploader/.env}"
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
KOSYNC_DB="${KOSYNC_DB:-/Users/ospeto/kosync-server/data/koreader-sync.db}"
if [ -f "$KOSYNC_DB" ]; then
  if sqlite3 "$KOSYNC_DB" ".backup '${TEMP_DIR}/koreader-sync.db'"; then
    log "Backed up KOSync database"
    BACKED_UP_DBS+=("KOSync")
  else
    log "Warning: Failed to back up KOSync database"
  fi
else
  log "Notice: KOSync database not found at $KOSYNC_DB, skipping"
fi

# 2. Hot SQLite Backup Calibre Library metadata.db
CALIBRE_DB="${CALIBRE_DB:-/Users/ospeto/Calibre Libraries/Agent Library/metadata.db}"
if [ -f "$CALIBRE_DB" ]; then
  if sqlite3 "$CALIBRE_DB" ".backup '${TEMP_DIR}/metadata.db'"; then
    log "Backed up Calibre metadata database"
    BACKED_UP_DBS+=("Calibre")
  else
    log "Warning: Failed to back up Calibre metadata database"
  fi
else
  log "Notice: Calibre database not found at $CALIBRE_DB, skipping"
fi

# 3. Hot SQLite Backup Uploader Cache DB
CACHE_DB="${CACHE_DB:-/Users/ospeto/uploader/cache.db}"
if [ -f "$CACHE_DB" ]; then
  if sqlite3 "$CACHE_DB" ".backup '${TEMP_DIR}/cache.db'"; then
    log "Backed up Uploader cache database"
    BACKED_UP_DBS+=("Uploader Cache")
  else
    log "Warning: Failed to back up Uploader cache database"
  fi
else
  log "Notice: Uploader cache database not found at $CACHE_DB, skipping"
fi

# 4. Hot SQLite Backup Manga Processor DB (if present)
MANGA_DB="${MANGA_DB:-/Users/ospeto/manga-processor/manga.db}"
if [ -f "$MANGA_DB" ]; then
  if sqlite3 "$MANGA_DB" ".backup '${TEMP_DIR}/manga.db'"; then
    log "Backed up Manga processor database"
    BACKED_UP_DBS+=("Manga")
  else
    log "Warning: Failed to back up Manga processor database"
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
ARCHIVE_SIZE_BYTES=$(stat -f%z "$LOCAL_ARCHIVE" 2>/dev/null || stat -c%s "$LOCAL_ARCHIVE" 2>/dev/null || echo 0)
ARCHIVE_SIZE_KB=$(( (ARCHIVE_SIZE_BYTES + 1023) / 1024 ))
log "Created local backup archive: ${ARCHIVE_NAME} (${ARCHIVE_SIZE_KB} KB)"

# 6. Mirror to External SSD if Available & Writable
if [ -d "/Volumes/Ospeto_SSD" ]; then
  mkdir -p "$SSD_BACKUP_DIR" 2>/dev/null || true
  if cp "$LOCAL_ARCHIVE" "${SSD_BACKUP_DIR}/${ARCHIVE_NAME}" 2>/dev/null; then
    log "Mirrored backup snapshot to External SSD: ${SSD_BACKUP_DIR}/${ARCHIVE_NAME}"
    find "$SSD_BACKUP_DIR" -name "reading-stack-backup-*.tar.gz" -mtime +7 -delete 2>/dev/null || true
  else
    log "Notice: External SSD write skipped. Local backup is fully secured."
  fi
fi

# 7. Auto-Prune Local Backups Older Than 7 Days
PRUNED=$(find "$LOCAL_BACKUP_DIR" -name "reading-stack-backup-*.tar.gz" -mtime +7 -print -delete 2>/dev/null | wc -l | tr -d " ")
log "Pruned ${PRUNED} local backup(s) older than 7 days."

# 8. Log Hygiene: Cap active log files at 10MB
for logf in /Users/ospeto/Library/Logs/telegram-bot.log \
            /Users/ospeto/Library/Logs/uploader.log \
            /Users/ospeto/Library/Logs/calibre-server.log \
            /Users/ospeto/Library/Logs/kosync.log \
            /Users/ospeto/Library/Logs/manga-processor.log; do
  if [ -f "$logf" ] && [ "$(stat -f%z "$logf" 2>/dev/null || echo 0)" -gt 10485760 ]; then
    tail -n 2000 "$logf" > "${logf}.tmp" && mv "${logf}.tmp" "$logf"
    log "Rotated log: $(basename "$logf") (>10MB)"
  fi
done

# 9. Deliver Daily Backup to Telegram if configured
TELEGRAM_BOT_TOKEN="${TELEGRAM_BOT_TOKEN:-}"
TELEGRAM_BACKUP_CHAT_ID="${TELEGRAM_BACKUP_CHAT_ID:-}"

if [ -f "$ENV_FILE" ]; then
  while IFS='=' read -r key val || [ -n "$key" ]; do
    key=$(echo "$key" | tr -d '[:space:]')
    [[ "$key" =~ ^#.*$ ]] && continue
    [ -z "$key" ] && continue
    val=$(echo "$val" | sed -e 's/^[[:space:]]*//' -e 's/[[:space:]]*$//' -e 's/^"\(.*\)"$/\1/' -e "s/^'\(.*\)'$/\1/")
    if [ "$key" = "TELEGRAM_BOT_TOKEN" ] && [ -z "$TELEGRAM_BOT_TOKEN" ]; then
      TELEGRAM_BOT_TOKEN="$val"
    fi
    if [ "$key" = "TELEGRAM_BACKUP_CHAT_ID" ] && [ -z "$TELEGRAM_BACKUP_CHAT_ID" ]; then
      TELEGRAM_BACKUP_CHAT_ID="$val"
    fi
  done < "$ENV_FILE"
fi

if [ -n "$TELEGRAM_BOT_TOKEN" ] && [ -n "$TELEGRAM_BACKUP_CHAT_ID" ]; then
  DB_LIST=$(printf ", %s" "${BACKED_UP_DBS[@]}")
  DB_LIST="${DB_LIST:2}"
  CAPTION=$(cat << EOF
📦 *Reading Stack Database Backup*
📅 *Date:* ${DISPLAY_DATE}
📊 *Size:* ${ARCHIVE_SIZE_KB} KB
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
