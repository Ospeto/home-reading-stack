#!/bin/bash
set -u

export PATH="/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:$PATH"

LOG_FILE="${LOG_FILE:-/Users/ospeto/Library/Logs/reading-tunnel-watchdog.log}"
FAIL_COUNT_FILE="${FAIL_COUNT_FILE:-/tmp/reading-tunnel-failures}"
ALERT_TRACK_FILE="${ALERT_TRACK_FILE:-/tmp/reading-tunnel-alerted}"
PROXY_URL="${PROXY_URL:-http://127.0.0.1:7890}"
LOCAL_HTTP_PORT="${LOCAL_HTTP_PORT:-8086}"
LOCAL_KOSYNC_PORT="${LOCAL_KOSYNC_PORT:-7200}"
TUNNEL_LABEL="${TUNNEL_LABEL:-com.ospeto.reading-vless-tunnel}"
REMOTE_HOST="${REMOTE_HOST:-panel}"
WAN_HQ_URL="${WAN_HQ_URL:-https://reading.wavypremium.xyz}"
ENV_FILE="${ENV_FILE:-/Users/ospeto/uploader/.env}"
UID_NUM=$(id -u)

log() {
  local NOW
  NOW=$(date "+%Y-%m-%d %H:%M:%S")
  echo "[${NOW}] [TunnelWatchdog] $1" | tee -a "$LOG_FILE"
}

restart_launchagent() {
  local LABEL="$1"
  local PLIST="/Users/ospeto/Library/LaunchAgents/${LABEL}.plist"
  log "Restarting LaunchAgent ${LABEL}..."
  if launchctl print "gui/${UID_NUM}/${LABEL}" >/dev/null 2>&1; then
    launchctl kickstart -k "gui/${UID_NUM}/${LABEL}" 2>/dev/null || true
  elif [ -f "$PLIST" ]; then
    launchctl load -w "$PLIST" 2>/dev/null || true
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
    val=$(echo "$val" | sed -e 's/^[[:space:]]*//' -e 's/[[:space:]]*$//' -e 's/^"\(.*\)"$/\1/' -e "s/^'\(.*\)'$/\1/")
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

# 2. Check Local Prerequisites
# A. Local Sing-box proxy (:7890)
if ! nc -z 127.0.0.1 7890 2>/dev/null; then
  log "WARNING: Sing-box proxy gateway (127.0.0.1:7890) is not listening. Kickstarting..."
  restart_launchagent "com.ospeto.singbox-proxy"
  sleep 1
fi

# B. Local Web Uploader (:8086)
LOCAL_8086_CODE=$(curl -s -o /dev/null -w "%{http_code}" -m 3 "http://127.0.0.1:${LOCAL_HTTP_PORT}/api/books" 2>/dev/null || echo "000")
if [ "$LOCAL_8086_CODE" != "200" ]; then
  log "WARNING: Local Reading HQ (:8086) returned HTTP ${LOCAL_8086_CODE}. Kickstarting uploader..."
  restart_launchagent "com.ospeto.book-uploader"
  sleep 1
fi

# C. Local KOSync Server (:7200)
LOCAL_7200_CODE=$(curl -s -o /dev/null -w "%{http_code}" -m 3 "http://127.0.0.1:${LOCAL_KOSYNC_PORT}/" 2>/dev/null || echo "000")
if [ "$LOCAL_7200_CODE" != "200" ]; then
  log "WARNING: Local KOSync server (:7200) returned HTTP ${LOCAL_7200_CODE}. Kickstarting kosync..."
  restart_launchagent "com.ospeto.kosync"
  sleep 1
fi

# 3. Probe Remote Reverse Tunnel Reachability via Sing-box Proxy
PROBE_HTTP_CODE=$(curl -s -o /dev/null -w "%{http_code}" --proxy "$PROXY_URL" -m 8 "$WAN_HQ_URL" 2>/dev/null || echo "000")

if [ "$PROBE_HTTP_CODE" = "200" ]; then
  # Tunnel is healthy
  PREV_FAILURES=$(cat "$FAIL_COUNT_FILE" 2>/dev/null || echo 0)
  if [ "$PREV_FAILURES" -gt 0 ]; then
    log "Tunnel recovered! Remote probe returned HTTP 200. Resetting failure counter (was ${PREV_FAILURES})."
  fi
  echo 0 > "$FAIL_COUNT_FILE"
  rm -f "$ALERT_TRACK_FILE" 2>/dev/null || true
  exit 0
fi

# 4. Tunnel probe failed — initiate auto-healing
FAILURES=$(( $(cat "$FAIL_COUNT_FILE" 2>/dev/null || echo 0) + 1 ))
echo "$FAILURES" > "$FAIL_COUNT_FILE"
log "WARNING: Remote tunnel probe to ${WAN_HQ_URL} failed (HTTP ${PROBE_HTTP_CODE}). Consecutive failures: ${FAILURES}."

# Step A: Terminate any local hanging or orphaned SSH reverse tunnel processes
log "Auto-healing: Terminating stale local tunnel process..."
pkill -f "ssh.*0.0.0.0:${LOCAL_HTTP_PORT}" 2>/dev/null || true

# Step B: Clear orphaned listeners on remote VPS panel holding port 8086 or 7200
log "Auto-healing: Clearing orphaned sockets on remote host ${REMOTE_HOST}..."
ssh -o ProxyCommand="nc -X 5 -x 127.0.0.1:7890 %h %p" \
    -o ConnectTimeout=8 \
    -o BatchMode=yes \
    -o ServerAliveInterval=5 \
    -o ServerAliveCountMax=2 \
    "$REMOTE_HOST" "fuser -k ${LOCAL_HTTP_PORT}/tcp ${LOCAL_KOSYNC_PORT}/tcp 2>/dev/null || true" 2>/dev/null || true

# Step C: Kickstart local LaunchAgent
log "Auto-healing: Kickstarting ${TUNNEL_LABEL}..."
restart_launchagent "$TUNNEL_LABEL"

# Step D: Allow connection to establish, then re-probe
sleep 4
REPROBE_CODE=$(curl -s -o /dev/null -w "%{http_code}" --proxy "$PROXY_URL" -m 8 "$WAN_HQ_URL" 2>/dev/null || echo "000")

if [ "$REPROBE_CODE" = "200" ]; then
  log "Auto-healing SUCCESS: Tunnel restored and verified healthy (HTTP 200). Resetting failure counter."
  echo 0 > "$FAIL_COUNT_FILE"
  rm -f "$ALERT_TRACK_FILE" 2>/dev/null || true
  exit 0
else
  log "Auto-healing INCOMPLETE: Post-restart probe returned HTTP ${REPROBE_CODE}."
fi

# 5. Escalate to Telegram Alert if Failures >= 3
if [ "$FAILURES" -ge 3 ]; then
  LAST_ALERTED=$(cat "$ALERT_TRACK_FILE" 2>/dev/null || echo 0)
  # Alert on 3rd failure, then every 10 failures thereafter to avoid flooding
  if [ "$LAST_ALERTED" -eq 0 ] || [ $(( FAILURES - LAST_ALERTED )) -ge 10 ]; then
    if [ -n "$TELEGRAM_BOT_TOKEN" ] && [ -n "$TELEGRAM_BACKUP_CHAT_ID" ]; then
      log "Escalating: Sending failure alert to Telegram chat ${TELEGRAM_BACKUP_CHAT_ID}..."
      ALERT_TEXT=$(cat << EOF
🚨 *Reading Stack Tunnel Alert*

The reverse SSH tunnel to VPS (*${REMOTE_HOST}*) has failed *${FAILURES}* consecutive health checks.

• *WAN Endpoint:* \`${WAN_HQ_URL}\` (HTTP ${PROBE_HTTP_CODE})
• *Local Ports:* \`8086\` (${LOCAL_8086_CODE}), \`7200\` (${LOCAL_7200_CODE})
• *Sing-box Proxy:* \`127.0.0.1:7890\`
• *Auto-Heal Status:* Restart attempted, endpoint still unreachable.

_Please inspect Mac Mini host logs and VPS panel connectivity._
EOF
)
      TG_RESP=$(curl -s --max-time 15 --proxy "$PROXY_URL" \
        -d "chat_id=${TELEGRAM_BACKUP_CHAT_ID}" \
        --data-urlencode "text=${ALERT_TEXT}" \
        -d "parse_mode=Markdown" \
        "https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage" 2>&1 || echo "curl_failed")

      if echo "$TG_RESP" | grep -q '"ok":true'; then
        log "Telegram alert sent successfully."
        echo "$FAILURES" > "$ALERT_TRACK_FILE"
      else
        log "WARNING: Failed to send Telegram alert: ${TG_RESP}"
      fi
    else
      log "Telegram alert skipped: TELEGRAM_BOT_TOKEN or TELEGRAM_BACKUP_CHAT_ID missing in ${ENV_FILE}."
    fi
  fi
fi

# 6. Log Hygiene: Cap watchdog log at 2000 lines
if [ -f "$LOG_FILE" ] && [ "$(wc -l <"$LOG_FILE" 2>/dev/null || echo 0)" -gt 2000 ]; then
  tail -n 1000 "$LOG_FILE" > "${LOG_FILE}.tmp" && mv "${LOG_FILE}.tmp" "$LOG_FILE"
fi
