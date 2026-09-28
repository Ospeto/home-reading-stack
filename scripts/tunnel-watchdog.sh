#!/bin/bash
set -u

export PATH="${PATH}:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin"

# Robust symlink resolution loop
SOURCE="${BASH_SOURCE[0]:-${0}}"
while [ -L "$SOURCE" ]; do
  DIR="$(cd -P "$(dirname "$SOURCE")" && pwd)"
  SOURCE="$(readlink "$SOURCE")"
  [[ $SOURCE != /* ]] && SOURCE="$DIR/$SOURCE"
done
DIR="$(cd -P "$(dirname "$SOURCE")" && pwd)"
LIGHTHOUSE_ROOT="$(cd -P "$DIR/.." && pwd)"
export LIGHTHOUSE_ROOT

LOG_DIR="${LOG_DIR:-${HOME}/Library/Logs}"
LOG_FILE="${LOG_FILE:-${LOG_DIR}/reading-tunnel-watchdog.log}"
ENV_FILE="${ENV_FILE:-${LIGHTHOUSE_ROOT}/.env}"
if [ ! -f "$ENV_FILE" ] && [ -f "${LIGHTHOUSE_ROOT}/uploader/.env" ]; then
  ENV_FILE="${LIGHTHOUSE_ROOT}/uploader/.env"
fi
UID_NUM=$(id -u)
CURRENT_USER="$(id -un 2>/dev/null || echo "$USER")"
DAEMON_PREFIX="${LIGHTHOUSE_DAEMON_PREFIX:-com.${CURRENT_USER}}"

# Load environment configuration if available
TELEGRAM_BOT_TOKEN="${TELEGRAM_BOT_TOKEN:-}"
TELEGRAM_BACKUP_CHAT_ID="${TELEGRAM_BACKUP_CHAT_ID:-}"
ENABLE_US_TUNNEL="${ENABLE_US_TUNNEL:-}"

if [ -f "$ENV_FILE" ]; then
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
    case "$key" in
      ENABLE_US_TUNNEL) ENABLE_US_TUNNEL="${ENABLE_US_TUNNEL:-$val}" ;;
      UPLOADER_PORT) LOCAL_HTTP_PORT="${LOCAL_HTTP_PORT:-$val}" ;;
      KOSYNC_PORT) LOCAL_KOSYNC_PORT="${LOCAL_KOSYNC_PORT:-$val}" ;;
      PROXY_URL) PROXY_URL="${PROXY_URL:-$val}" ;;
      US_REMOTE_HOST) US_REMOTE_HOST="${US_REMOTE_HOST:-$val}" ;;
      SG_REMOTE_HOST) SG_REMOTE_HOST="${SG_REMOTE_HOST:-$val}" ;;
      US_WAN_HQ_URL) US_WAN_HQ_URL="${US_WAN_HQ_URL:-$val}" ;;
      SG_OPDS_80_URL) SG_OPDS_80_URL="${SG_OPDS_80_URL:-$val}" ;;
      SG_OPDS_8443_URL) SG_OPDS_8443_URL="${SG_OPDS_8443_URL:-$val}" ;;
      SG_KOSYNC_URL) SG_KOSYNC_URL="${SG_KOSYNC_URL:-$val}" ;;
      LIGHTHOUSE_DAEMON_PREFIX) DAEMON_PREFIX="$val" ;;
      TELEGRAM_BOT_TOKEN) [ -z "$TELEGRAM_BOT_TOKEN" ] && TELEGRAM_BOT_TOKEN="$val" ;;
      TELEGRAM_BACKUP_CHAT_ID) [ -z "$TELEGRAM_BACKUP_CHAT_ID" ] && TELEGRAM_BACKUP_CHAT_ID="$val" ;;
    esac
  done < "$ENV_FILE"
fi

# Local prerequisite services
PROXY_URL="${PROXY_URL:-http://127.0.0.1:7890}"
LOCAL_HTTP_PORT="${LOCAL_HTTP_PORT:-8086}"
LOCAL_KOSYNC_PORT="${LOCAL_KOSYNC_PORT:-7200}"

# --- US VLESS Tunnel Configurations ---
ENABLE_US_TUNNEL="${ENABLE_US_TUNNEL:-0}"
US_TUNNEL_LABEL="${US_TUNNEL_LABEL:-${DAEMON_PREFIX}.reading-vless-tunnel}"
US_REMOTE_HOST="${US_REMOTE_HOST:-panel}"
US_WAN_HQ_URL="${US_WAN_HQ_URL:-https://reading.wavypremium.xyz}"
US_FAIL_COUNT_FILE="${US_FAIL_COUNT_FILE:-/tmp/reading-tunnel-failures-us}"
US_ALERT_TRACK_FILE="${US_ALERT_TRACK_FILE:-/tmp/reading-tunnel-alerted-us}"
# Backward compatibility for single-tunnel env var overrides
if [ -n "${FAIL_COUNT_FILE:-}" ]; then
  US_FAIL_COUNT_FILE="$FAIL_COUNT_FILE"
fi
if [ -n "${ALERT_TRACK_FILE:-}" ]; then
  US_ALERT_TRACK_FILE="$ALERT_TRACK_FILE"
fi
if [ -n "${TUNNEL_LABEL:-}" ]; then
  US_TUNNEL_LABEL="$TUNNEL_LABEL"
fi
if [ -n "${REMOTE_HOST:-}" ]; then
  US_REMOTE_HOST="$REMOTE_HOST"
fi
if [ -n "${WAN_HQ_URL:-}" ]; then
  US_WAN_HQ_URL="$WAN_HQ_URL"
fi
US_PLIST="${US_PLIST:-${HOME}/Library/LaunchAgents/${US_TUNNEL_LABEL}.plist}"
US_LOG_FILE="${US_LOG_FILE:-${LOG_DIR}/reading-vless-tunnel.log}"

# --- Singapore Tunnel Configurations ---
SG_TUNNEL_LABEL="${SG_TUNNEL_LABEL:-${DAEMON_PREFIX}.reading-sg-tunnel}"
SG_REMOTE_HOST="${SG_REMOTE_HOST:-sg-vps}"
SG_OPDS_80_URL="${SG_OPDS_80_URL:-http://opds.wavypremium.xyz/opds}"
SG_OPDS_8443_URL="${SG_OPDS_8443_URL:-https://opds.wavypremium.xyz:8443/opds}"
SG_KOSYNC_URL="${SG_KOSYNC_URL:-http://kosync-sg.wavypremium.xyz/health}"
SG_FAIL_COUNT_FILE="${SG_FAIL_COUNT_FILE:-/tmp/reading-tunnel-failures-sg}"
SG_ALERT_TRACK_FILE="${SG_ALERT_TRACK_FILE:-/tmp/reading-tunnel-alerted-sg}"
SG_LOG_FILE="${SG_LOG_FILE:-${LOG_DIR}/reading-sg-tunnel.log}"

log() {
  local NOW
  NOW=$(date "+%Y-%m-%d %H:%M:%S")
  echo "[${NOW}] [TunnelWatchdog] $1" | tee -a "$LOG_FILE"
}

# Strict input validation: port numbers must be positive integers between 1 and 65535
case "$LOCAL_HTTP_PORT" in ''|*[!0-9]*) log "ERROR: Invalid LOCAL_HTTP_PORT"; exit 1 ;; esac
case "$LOCAL_KOSYNC_PORT" in ''|*[!0-9]*) log "ERROR: Invalid LOCAL_KOSYNC_PORT"; exit 1 ;; esac
[ "$LOCAL_HTTP_PORT" -ge 1 ] && [ "$LOCAL_HTTP_PORT" -le 65535 ] || { log "ERROR: LOCAL_HTTP_PORT out of range"; exit 1; }
[ "$LOCAL_KOSYNC_PORT" -ge 1 ] && [ "$LOCAL_KOSYNC_PORT" -le 65535 ] || { log "ERROR: LOCAL_KOSYNC_PORT out of range"; exit 1; }

restart_launchagent() {
  local LABEL="$1"
  local PLIST="${HOME}/Library/LaunchAgents/${LABEL}.plist"
  log "Restarting LaunchAgent ${LABEL}..."
  if launchctl print "gui/${UID_NUM}/${LABEL}" >/dev/null 2>&1; then
    launchctl kickstart -k "gui/${UID_NUM}/${LABEL}" 2>/dev/null || true
  elif [ -f "$PLIST" ]; then
    launchctl load -w "$PLIST" 2>/dev/null || true
  fi
}

probe_http_status() {
  local TARGET_URL="$1"
  local TARGET_PROXY="${2:-}"
  local INSECURE_FLAG="${3:-0}"
  local TIMEOUT_SEC="${4:-8}"

  local CURL_CMD=(curl -s -o /dev/null -w "%{http_code}" -m "$TIMEOUT_SEC")
  if [ -n "$TARGET_PROXY" ]; then
    CURL_CMD+=(--proxy "$TARGET_PROXY")
  fi
  if [ "$INSECURE_FLAG" -eq 1 ]; then
    CURL_CMD+=(-k)
  fi

  local RAW_CODE
  RAW_CODE=$("${CURL_CMD[@]}" "$TARGET_URL" 2>/dev/null || true)
  local CLEAN_CODE
  CLEAN_CODE=$(echo "$RAW_CODE" | grep -oE '[0-9]{3}' | head -n 1)
  if [ -z "$CLEAN_CODE" ]; then
    CLEAN_CODE="000"
  fi
  echo "$CLEAN_CODE"
}

send_telegram_alert() {
  local ALERT_TEXT="$1"
  if [ -n "$TELEGRAM_BOT_TOKEN" ] && [ -n "$TELEGRAM_BACKUP_CHAT_ID" ]; then
    log "Escalating: Sending failure alert to Telegram chat ${TELEGRAM_BACKUP_CHAT_ID}..."
    local TG_RESP
    TG_RESP=$(curl -s --max-time 15 --proxy "$PROXY_URL" \
      -d "chat_id=${TELEGRAM_BACKUP_CHAT_ID}" \
      --data-urlencode "text=${ALERT_TEXT}" \
      -d "parse_mode=Markdown" \
      "https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage" 2>&1 || echo "curl_failed")

    if echo "$TG_RESP" | grep -q '"ok":true'; then
      log "Telegram alert sent successfully."
      return 0
    else
      log "WARNING: Failed to send Telegram alert: ${TG_RESP}"
      return 1
    fi
  else
    log "Telegram alert skipped: TELEGRAM_BOT_TOKEN or TELEGRAM_BACKUP_CHAT_ID missing in ${ENV_FILE}."
    return 1
  fi
}

# 1. Load Telegram Bot Credentials for Alerts
TELEGRAM_BOT_TOKEN="${TELEGRAM_BOT_TOKEN:-}"
TELEGRAM_BACKUP_CHAT_ID="${TELEGRAM_BACKUP_CHAT_ID:-}"

if [ -f "$ENV_FILE" ]; then
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
    if [ "$key" = "TELEGRAM_BOT_TOKEN" ] && [ -z "$TELEGRAM_BOT_TOKEN" ]; then
      TELEGRAM_BOT_TOKEN="$val"
    fi
    if [ "$key" = "TELEGRAM_BACKUP_CHAT_ID" ] && [ -z "$TELEGRAM_BACKUP_CHAT_ID" ]; then
      TELEGRAM_BACKUP_CHAT_ID="$val"
    fi
  done < "$ENV_FILE"
fi

# Ensure log directory exists
mkdir -p "$(dirname "$LOG_FILE")"

# 2. Check Local Prerequisites & Failure Domain Isolation
# If local prerequisites fail, restart them and exit 0 for this cycle so local restarts do not falsely kill remote tunnels.
LOCAL_FAILURE=0

# A. Local Sing-box proxy (:7890)
if ! nc -z 127.0.0.1 7890 2>/dev/null; then
  log "WARNING: Sing-box proxy gateway (127.0.0.1:7890) is not listening. Kickstarting..."
  restart_launchagent "${DAEMON_PREFIX}.singbox-proxy"
  LOCAL_FAILURE=1
fi

# B. Local Web Uploader (:8086)
LOCAL_8086_CODE=$(probe_http_status "http://127.0.0.1:${LOCAL_HTTP_PORT}/api/books" "" 0 3)
if [ "$LOCAL_8086_CODE" != "200" ]; then
  log "WARNING: Local Reading HQ (:8086) returned HTTP ${LOCAL_8086_CODE}. Kickstarting uploader..."
  restart_launchagent "${DAEMON_PREFIX}.book-uploader"
  LOCAL_FAILURE=1
fi

# C. Local KOSync Server (:7200)
LOCAL_7200_CODE=$(probe_http_status "http://127.0.0.1:${LOCAL_KOSYNC_PORT}/" "" 0 3)
if [ "$LOCAL_7200_CODE" != "200" ]; then
  log "WARNING: Local KOSync server (:7200) returned HTTP ${LOCAL_7200_CODE}. Kickstarting kosync..."
  restart_launchagent "${DAEMON_PREFIX}.kosync"
  LOCAL_FAILURE=1
fi

if [ "$LOCAL_FAILURE" -eq 1 ]; then
  log "NOTICE: Local prerequisite services were restarted. Deferring remote tunnel checks to next cycle to avoid false tunnel restarts."
  exit 0
fi

# ==============================================================================
# 3. Monitor & Auto-Heal: US VLESS Reverse Tunnel (panel)
# ==============================================================================
if [ "$ENABLE_US_TUNNEL" != "1" ] || [ ! -f "$US_PLIST" ]; then
  PLIST_EXISTS=0
  [ -f "$US_PLIST" ] && PLIST_EXISTS=1
  if [ -f "$US_FAIL_COUNT_FILE" ] || [ -f "$US_ALERT_TRACK_FILE" ] || [ -f /tmp/reading-tunnel-failures ]; then
    log "US VLESS tunnel monitoring skipped (ENABLE_US_TUNNEL=${ENABLE_US_TUNNEL}, plist_exists=${PLIST_EXISTS}). Cleaning up stale failure markers."
  fi
  rm -f "$US_FAIL_COUNT_FILE" "$US_ALERT_TRACK_FILE" /tmp/reading-tunnel-failures 2>/dev/null || true
else
  US_PROBE_CODE=$(probe_http_status "$US_WAN_HQ_URL" "$PROXY_URL" 0 8)

  # Check for collision marker in recent logs
  US_COLLISION=0
  if [ -f "$US_LOG_FILE" ] && tail -n 15 "$US_LOG_FILE" 2>/dev/null | grep -q "remote port forwarding failed for listen port"; then
    US_COLLISION=1
  fi

  # Tunnel is healthy if remote probe returns 200.
  # Only treat port collision as actionable if the probe has ALSO failed (probe status != 200).
  if [ "$US_PROBE_CODE" = "200" ]; then
    PREV_US_FAILURES=$(cat "$US_FAIL_COUNT_FILE" 2>/dev/null || echo 0)
    if [ "$PREV_US_FAILURES" -gt 0 ]; then
      log "US Tunnel recovered! Remote probe returned HTTP 200. Resetting US failure counter (was ${PREV_US_FAILURES})."
    fi
    echo 0 > "$US_FAIL_COUNT_FILE"
    # Also maintain legacy failure file if specified
    echo 0 > /tmp/reading-tunnel-failures 2>/dev/null || true
    rm -f "$US_ALERT_TRACK_FILE" 2>/dev/null || true
  else
    US_FAILURES=$(( $(cat "$US_FAIL_COUNT_FILE" 2>/dev/null || echo 0) + 1 ))
    echo "$US_FAILURES" > "$US_FAIL_COUNT_FILE"
    echo "$US_FAILURES" > /tmp/reading-tunnel-failures 2>/dev/null || true
    log "WARNING: US tunnel probe to ${US_WAN_HQ_URL} failed (HTTP ${US_PROBE_CODE}, collision=${US_COLLISION}). Consecutive failures: ${US_FAILURES}."

    # Step A: Terminate hanging local SSH process for US tunnel using precise port-forwarding pattern
    log "Auto-healing (US): Terminating stale local tunnel process..."
    pkill -f "ssh.*0.0.0.0:${LOCAL_HTTP_PORT}.*${US_REMOTE_HOST}" 2>/dev/null || true

    # Step B: Clear orphaned listeners on remote VPS panel holding port 8086 or 7200
    log "Auto-healing (US): Clearing orphaned sockets on remote host ${US_REMOTE_HOST}..."
    ssh -o ProxyCommand="nc -X 5 -x 127.0.0.1:7890 %h %p" \
        -o ConnectTimeout=8 \
        -o BatchMode=yes \
        -o ServerAliveInterval=5 \
        -o ServerAliveCountMax=2 \
        "$US_REMOTE_HOST" "fuser -k ${LOCAL_HTTP_PORT}/tcp ${LOCAL_KOSYNC_PORT}/tcp 2>/dev/null || true" 2>/dev/null || true

    # Step C: Kickstart local LaunchAgent
    log "Auto-healing (US): Kickstarting ${US_TUNNEL_LABEL}..."
    restart_launchagent "$US_TUNNEL_LABEL"

    # Step D: Allow connection to establish, then re-probe
    sleep 4
    US_REPROBE_CODE=$(probe_http_status "$US_WAN_HQ_URL" "$PROXY_URL" 0 8)

    if [ "$US_REPROBE_CODE" = "200" ]; then
      log "Auto-healing (US) SUCCESS: US tunnel restored and verified healthy (HTTP 200). Resetting failure counter."
      echo 0 > "$US_FAIL_COUNT_FILE"
      echo 0 > /tmp/reading-tunnel-failures 2>/dev/null || true
      rm -f "$US_ALERT_TRACK_FILE" 2>/dev/null || true
    else
      log "Auto-healing (US) INCOMPLETE: Post-restart probe returned HTTP ${US_REPROBE_CODE}."
    fi

    # Escalate to Telegram Alert if Failures >= 3
    if [ "$US_FAILURES" -ge 3 ]; then
      LAST_US_ALERTED=$(cat "$US_ALERT_TRACK_FILE" 2>/dev/null || echo 0)
      if [ "$LAST_US_ALERTED" -eq 0 ] || [ $(( US_FAILURES - LAST_US_ALERTED )) -ge 10 ]; then
        US_ALERT_TEXT=$(cat << EOF
🚨 *Reading Stack Tunnel Alert: US VLESS Tunnel*

The reverse SSH tunnel to VPS (*${US_REMOTE_HOST}*) has failed *${US_FAILURES}* consecutive health checks.

• *WAN Endpoint:* \`${US_WAN_HQ_URL}\` (HTTP ${US_PROBE_CODE})
• *Local Ports:* \`8086\` (${LOCAL_8086_CODE}), \`7200\` (${LOCAL_7200_CODE})
• *Sing-box Proxy:* \`127.0.0.1:7890\`
• *Auto-Heal Status:* Restart attempted, endpoint still unreachable.

_Please inspect Mac Mini host logs and VPS panel connectivity._
EOF
)
        if send_telegram_alert "$US_ALERT_TEXT"; then
          echo "$US_FAILURES" > "$US_ALERT_TRACK_FILE"
        fi
      fi
    fi
  fi
fi

# ==============================================================================
# 4. Monitor & Auto-Heal: Singapore Reverse Tunnel (sg-vps)
# ==============================================================================
# Strict TLS validation on port 8443 (INSECURE_FLAG = 0)
SG_80_CODE=$(probe_http_status "$SG_OPDS_80_URL" "" 0 8)
SG_8443_CODE=$(probe_http_status "$SG_OPDS_8443_URL" "" 0 8)
SG_KOSYNC_CODE=$(probe_http_status "$SG_KOSYNC_URL" "" 0 8)

# Check for collision marker in recent logs
SG_COLLISION=0
if [ -f "$SG_LOG_FILE" ] && tail -n 15 "$SG_LOG_FILE" 2>/dev/null | grep -q "remote port forwarding failed for listen port"; then
  SG_COLLISION=1
fi

# Singapore tunnel is healthy when probes return acceptable status codes (200 or 302).
# Only trigger auto-healing if at least one endpoint probe has ALSO failed (probe status != 200 and != 302).
if { [ "$SG_80_CODE" = "200" ] || [ "$SG_80_CODE" = "302" ]; } && \
   { [ "$SG_8443_CODE" = "200" ] || [ "$SG_8443_CODE" = "302" ]; } && \
   { [ "$SG_KOSYNC_CODE" = "200" ] || [ "$SG_KOSYNC_CODE" = "302" ]; }; then
  PREV_SG_FAILURES=$(cat "$SG_FAIL_COUNT_FILE" 2>/dev/null || echo 0)
  if [ "$PREV_SG_FAILURES" -gt 0 ]; then
    log "Singapore Tunnel recovered! All endpoints healthy. Resetting SG failure counter (was ${PREV_SG_FAILURES})."
  fi
  echo 0 > "$SG_FAIL_COUNT_FILE"
  rm -f "$SG_ALERT_TRACK_FILE" 2>/dev/null || true
else
  SG_FAILURES=$(( $(cat "$SG_FAIL_COUNT_FILE" 2>/dev/null || echo 0) + 1 ))
  echo "$SG_FAILURES" > "$SG_FAIL_COUNT_FILE"
  log "WARNING: Singapore tunnel health check failed (OPDS :80=${SG_80_CODE}, OPDS :8443=${SG_8443_CODE}, KOSync=${SG_KOSYNC_CODE}, collision=${SG_COLLISION}). Consecutive failures: ${SG_FAILURES}."

  # Step A: Terminate hanging local SSH process for Singapore tunnel using precise port-forwarding pattern
  log "Auto-healing (Singapore): Terminating stale local tunnel process..."
  pkill -f "ssh.*-R.*127\.0\.0\.1:${LOCAL_HTTP_PORT}.*${SG_REMOTE_HOST}" 2>/dev/null || true

  # Step B: Clear orphaned listeners on remote Singapore VPS (sg-vps)
  log "Auto-healing (Singapore): Clearing orphaned sockets on remote host ${SG_REMOTE_HOST}..."
  ssh -o BatchMode=yes \
      -o ConnectTimeout=5 \
      -o ServerAliveInterval=5 \
      -o ServerAliveCountMax=2 \
      "$SG_REMOTE_HOST" "fuser -k ${LOCAL_HTTP_PORT}/tcp ${LOCAL_KOSYNC_PORT}/tcp 2>/dev/null || true" 2>/dev/null || true

  # Step C: Kickstart local LaunchAgent
  log "Auto-healing (Singapore): Kickstarting ${SG_TUNNEL_LABEL}..."
  restart_launchagent "$SG_TUNNEL_LABEL"

  # Step D: Allow connection to establish, then re-probe with strict TLS
  sleep 4
  SG_RE_80_CODE=$(probe_http_status "$SG_OPDS_80_URL" "" 0 8)
  SG_RE_8443_CODE=$(probe_http_status "$SG_OPDS_8443_URL" "" 0 8)
  SG_RE_KOSYNC_CODE=$(probe_http_status "$SG_KOSYNC_URL" "" 0 8)

  if { [ "$SG_RE_80_CODE" = "200" ] || [ "$SG_RE_80_CODE" = "302" ]; } && \
     { [ "$SG_RE_8443_CODE" = "200" ] || [ "$SG_RE_8443_CODE" = "302" ]; } && \
     { [ "$SG_RE_KOSYNC_CODE" = "200" ] || [ "$SG_RE_KOSYNC_CODE" = "302" ]; }; then
    log "Auto-healing (Singapore) SUCCESS: Singapore tunnel restored and verified healthy. Resetting failure counter."
    echo 0 > "$SG_FAIL_COUNT_FILE"
    rm -f "$SG_ALERT_TRACK_FILE" 2>/dev/null || true
  else
    log "Auto-healing (Singapore) INCOMPLETE: Post-restart probe returned OPDS :80=${SG_RE_80_CODE}, OPDS :8443=${SG_RE_8443_CODE}, KOSync=${SG_RE_KOSYNC_CODE}."
  fi

  # Escalate to Telegram Alert if Failures >= 3
  if [ "$SG_FAILURES" -ge 3 ]; then
    LAST_SG_ALERTED=$(cat "$SG_ALERT_TRACK_FILE" 2>/dev/null || echo 0)
    if [ "$LAST_SG_ALERTED" -eq 0 ] || [ $(( SG_FAILURES - LAST_SG_ALERTED )) -ge 10 ]; then
      SG_ALERT_TEXT=$(cat << EOF
🚨 *Reading Stack Tunnel Alert: Singapore Tunnel*

The reverse SSH tunnel to Singapore VPS (*${SG_REMOTE_HOST}*) has failed *${SG_FAILURES}* consecutive health checks.

• *OPDS Endpoint (Port 80):* \`${SG_OPDS_80_URL}\` (HTTP ${SG_80_CODE})
• *OPDS Endpoint (Port 8443):* \`${SG_OPDS_8443_URL}\` (HTTP ${SG_8443_CODE})
• *KOSync Endpoint:* \`${SG_KOSYNC_URL}\` (HTTP ${SG_KOSYNC_CODE})
• *Local Ports:* \`8086\` (${LOCAL_8086_CODE}), \`7200\` (${LOCAL_7200_CODE})
• *Auto-Heal Status:* Restart attempted, endpoint still unreachable.

_Please inspect Mac Mini host logs and sg-vps remote listeners._
EOF
)
      if send_telegram_alert "$SG_ALERT_TEXT"; then
        echo "$SG_FAILURES" > "$SG_ALERT_TRACK_FILE"
      fi
    fi
  fi
fi

# ==============================================================================
# 5. Log Hygiene: Cap watchdog log at 2000 lines
# ==============================================================================
if [ -f "$LOG_FILE" ] && [ "$(wc -l <"$LOG_FILE" 2>/dev/null || echo 0)" -gt 2000 ]; then
  tail -n 1000 "$LOG_FILE" > "${LOG_FILE}.tmp" && mv "${LOG_FILE}.tmp" "$LOG_FILE"
fi
