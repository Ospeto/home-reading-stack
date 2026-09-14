# Operations Runbook: Home Reading Stack

This runbook documents operational commands, health checks, service management, and recovery procedures for the local reading stack on Mac mini (`192.168.31.15`) and the remote standby VPS (`198.46.146.17`).

---

## 🛠️ Service Architecture on Mac Mini (`192.168.31.15`)

All services on the Mac mini run as native macOS LaunchAgents under `/Users/ospeto/Library/LaunchAgents/`:

| LaunchAgent Label | File Path | Port | Work Directory |
| --- | --- | --- | --- |
| `com.ospeto.kosync` | `~/Library/LaunchAgents/com.ospeto.kosync.plist` | `7200` | `/Users/ospeto/kosync-server` |
| `com.ospeto.calibre-server` | `~/Library/LaunchAgents/com.ospeto.calibre-server.plist` | `8088` | `/Users/ospeto/Calibre Libraries/Agent Library` |
| `com.ospeto.book-uploader` | `~/Library/LaunchAgents/com.ospeto.book-uploader.plist` | `8086` | `/Users/ospeto/uploader` |
| `com.ospeto.reading-telegram-bot` | `~/Library/LaunchAgents/com.ospeto.reading-telegram-bot.plist` | — | `/Users/ospeto/uploader` |
| `com.ospeto.calibre-autoimport` | `~/Library/LaunchAgents/com.ospeto.calibre-autoimport.plist` | — | `/Users/ospeto/kosync-server` |
| `com.ospeto.manga-processor` | `~/Library/LaunchAgents/com.ospeto.manga-processor.plist` | — | `/Users/ospeto/manga-processor` |
| `com.ospeto.reading-stack-backup` | `~/Library/LaunchAgents/com.ospeto.reading-stack-backup.plist` | — | `/Users/ospeto/kosync-server` |
| `com.ospeto.kosync-watchdog` | `~/Library/LaunchAgents/com.ospeto.kosync-watchdog.plist` | — | `/Users/ospeto/kosync-server` |
| `com.ospeto.singbox-proxy` | `~/Library/LaunchAgents/com.ospeto.singbox-proxy.plist` | `7890` | `/Users/ospeto/.config/sing-box` |
| `com.ospeto.reading-vless-tunnel` | `~/Library/LaunchAgents/com.ospeto.reading-vless-tunnel.plist` | `8086, 7200 (remote)` | `/Users/ospeto` |
| `com.ospeto.reading-tunnel-watchdog` | `~/Library/LaunchAgents/com.ospeto.reading-tunnel-watchdog.plist` | — | `/Users/ospeto/uploader` |

---

## 🩺 Routine Health Checks

Run from your Mac laptop:

```bash
# 1. Check KOSync Health
curl -i http://192.168.31.15:7200/health

# 2. Check Calibre OPDS Feed
curl -s -i http://192.168.31.15:8088/opds | head -n 15

# 3. Check Web Uploader API
curl -s http://192.168.31.15:8086/api/books

# 4. Check Sing-box Proxy Connectivity
curl -s --proxy http://192.168.31.15:7890 https://ipinfo.io/json

# 5. Check WAN Reading HQ Public Endpoint & TLS
curl -s -I https://reading.wavypremium.xyz

# 6. Check Persistent Reverse Tunnel LaunchAgent Status
launchctl list | grep com.ospeto.reading-vless-tunnel
```

---

## 🔄 Service Control & Lifecycle

### Restart All Services

```bash
ssh mac-mini "
  launchctl unload ~/Library/LaunchAgents/com.ospeto.kosync.plist 2>/dev/null || true
  launchctl load -w ~/Library/LaunchAgents/com.ospeto.kosync.plist

  launchctl unload ~/Library/LaunchAgents/com.ospeto.calibre-server.plist 2>/dev/null || true
  launchctl load -w ~/Library/LaunchAgents/com.ospeto.calibre-server.plist

  launchctl unload ~/Library/LaunchAgents/com.ospeto.book-uploader.plist 2>/dev/null || true
  launchctl load -w ~/Library/LaunchAgents/com.ospeto.book-uploader.plist

  launchctl unload ~/Library/LaunchAgents/com.ospeto.reading-telegram-bot.plist 2>/dev/null || true
  launchctl load -w ~/Library/LaunchAgents/com.ospeto.reading-telegram-bot.plist

  launchctl unload ~/Library/LaunchAgents/com.ospeto.singbox-proxy.plist 2>/dev/null || true
  launchctl load -w ~/Library/LaunchAgents/com.ospeto.singbox-proxy.plist

  launchctl unload ~/Library/LaunchAgents/com.ospeto.reading-vless-tunnel.plist 2>/dev/null || true
  launchctl load -w ~/Library/LaunchAgents/com.ospeto.reading-vless-tunnel.plist
"
```

### Inspect Live Logs

```bash
# KOSync logs
ssh mac-mini "tail -f ~/Library/Logs/kosync.log"

# Calibre Server logs
ssh mac-mini "tail -f ~/Library/Logs/calibre-server.log"

# Uploader logs
ssh mac-mini "tail -f ~/Library/Logs/uploader.log ~/Library/Logs/uploader-error.log"

# Sing-box Proxy logs
ssh mac-mini "tail -f ~/Library/Logs/sing-box/stderr.log"

# VLESS SSH Reverse Tunnel logs
ssh mac-mini "tail -f ~/Library/Logs/reading-vless-tunnel.log"
```

---

## 💾 Database & Library Management

### 1. KOSync SQLite Database

- Location: `/Users/ospeto/kosync-server/data/koreader-sync.db`
- Inspect active sync records:

  ```bash
  ssh mac-mini "python3 -c \"
  import sqlite3
  con = sqlite3.connect('/Users/ospeto/kosync-server/data/koreader-sync.db')
  print('Users:', con.execute('SELECT id, username FROM users;').fetchall())
  print('Syncs:', con.execute('SELECT document, percentage, device FROM progress;').fetchall())
  \""
  ```

### 2. Calibre Library Database

- Location: `/Users/ospeto/Calibre Libraries/Agent Library/metadata.db`
- List books via CLI:

  ```bash
  ssh mac-mini "export PATH=/opt/homebrew/bin:\$PATH; calibredb list --with-library http://127.0.0.1:8088"
  ```

- Manually add a book:

  ```bash
  ssh mac-mini "export PATH=/opt/homebrew/bin:\$PATH; calibredb add /path/to/book.epub --with-library http://127.0.0.1:8088"
  ```

- Remove a book:

  ```bash
  ssh mac-mini "export PATH=/opt/homebrew/bin:\$PATH; calibredb remove <BOOK_ID> --with-library http://127.0.0.1:8088"
  ```

### 3. Manga Processing & Ingestion

- Watch root: `/Volumes/Ospeto_SSD/Manga/<Series Name>/<Chapter Name>/`
- Processed archive: `/Volumes/Ospeto_SSD/Manga/.processed/`
- Trigger one-shot scan:

  ```bash
  ssh mac-mini "/opt/homebrew/bin/python3 /Users/ospeto/manga-processor/processor.py --scan"
  ```

- Inspect processor logs:

  ```bash
  ssh mac-mini "tail -f ~/Library/Logs/manga-processor.log ~/Library/Logs/manga-processor-error.log"
  ```

### 4. Database Snapshot Backups, Telegram Delivery & WAL Durability

- Primary Local Storage: `/Users/ospeto/.backups/reading-stack/` (Always writable, immune to TCC / drive unmounts)
- Secondary Mirror: `/Volumes/Ospeto_SSD/backups/reading-stack/` (Automated sync when SSD is mounted)
- SQLite Database Resiliency: All databases (`koreader-sync.db`, `cache.db`, `manga.db`, `metadata.db`) run in `WAL` mode (`PRAGMA journal_mode=WAL; PRAGMA synchronous=NORMAL;`) for zero-corruption power loss safety.
- Retention: 7 days rolling retention
- Log Hygiene: Auto-truncates logs in `~/Library/Logs/` if exceeding 10 MB.

#### On-Demand Telegram Backup (`/backup`)

- Send `/backup` to `@saroat_ospeto_bot` in Telegram.
- The bot performs a hot SQLite snapshot (`.backup`) of:
  1. KOSync database (`koreader-sync.db`)
  2. Calibre metadata (`metadata.db`)
  3. Uploader cache (`cache.db`)
  4. Manga processor DB (`manga.db`)
- The compressed `.tar.gz` (~85 KB) is delivered directly into your Telegram chat.
- The command automatically updates `TELEGRAM_BACKUP_CHAT_ID` in `/Users/ospeto/uploader/.env` so daily scheduled backups know where to deliver.

#### Scheduled Daily Backups (`scripts/backup-daily.sh`)

- Tracked in git at `scripts/backup-daily.sh`.
- Run automatically at 04:00 AM daily by LaunchAgent `com.ospeto.reading-stack-backup`.
- Checks `/Users/ospeto/uploader/.env` for `TELEGRAM_BOT_TOKEN` and `TELEGRAM_BACKUP_CHAT_ID`. If present, sends the daily `.tar.gz` archive to Telegram via proxy `http://127.0.0.1:7890`.
- Manual backup run:

  ```bash
  ssh mac-mini "/Users/ospeto/uploader/scripts/backup-daily.sh"
  # Or:
  /Users/ospeto/.treehouse/home-reading-stack-6428f1/1/home-reading-stack/scripts/backup-daily.sh
  ```

- Inspect backup logs:

  ```bash
  ssh mac-mini "tail -f ~/Library/Logs/reading-stack-backup.log"
  ```

#### Restoring from a Backup Archive

To restore databases from a Telegram or disk backup archive:

```bash
# 1. Extract archive to a temporary inspection directory
mkdir -p /tmp/reading-restore
tar -xzf reading-stack-backup-YYYY-MM-DD_HHMMSS.tar.gz -C /tmp/reading-restore

# 2. Stop running stack services
launchctl unload ~/Library/LaunchAgents/com.ospeto.kosync.plist
launchctl unload ~/Library/LaunchAgents/com.ospeto.calibre-server.plist
launchctl unload ~/Library/LaunchAgents/com.ospeto.book-uploader.plist

# 3. Copy restored SQLite databases into place
cp /tmp/reading-restore/koreader-sync.db /Users/ospeto/kosync-server/data/koreader-sync.db
cp /tmp/reading-restore/metadata.db "/Users/ospeto/Calibre Libraries/Agent Library/metadata.db"
cp /tmp/reading-restore/cache.db /Users/ospeto/uploader/cache.db
[ -f /tmp/reading-restore/manga.db ] && cp /tmp/reading-restore/manga.db /Users/ospeto/manga-processor/manga.db

# 4. Restart stack services
launchctl load -w ~/Library/LaunchAgents/com.ospeto.kosync.plist
launchctl load -w ~/Library/LaunchAgents/com.ospeto.calibre-server.plist
launchctl load -w ~/Library/LaunchAgents/com.ospeto.book-uploader.plist
```

### 5. Automated Self-Healing Watchdog

- Agent: `com.ospeto.kosync-watchdog` (Runs every 15 minutes)
- Monitored services:
  1. KOSync Server (`:7200`)
  2. Calibre OPDS Feed (`:8088/opds`)
  3. Web Uploader API (`:8086/api/books`)
  4. Telegram Ingestion Bot (`bot.ts`)
  5. Manga Auto-Packer Daemon (`processor.py`)
  6. Sing-box VLESS Gateway (`:7890`)
- Manual watchdog trigger:

  ```bash
  ssh mac-mini "/Users/ospeto/kosync-server/watchdog.sh"
  ```

- Inspect watchdog logs:

  ```bash
  ssh mac-mini "tail -f ~/Library/Logs/reading-stack-watchdog.log"
  ```

### 6. Library Search & Retrieval Verification

Verify the Telegram bot's in-chat library search and retrieval functionality:

```bash
# 1. Search library books from CLI or test runner
bun -e '
  import { searchCalibreLibrary, locateBookFile } from "./uploader/bot.ts";
  console.log("Search Piece:", searchCalibreLibrary("Piece", 3));
  console.log("Locate Book 6:", locateBookFile(6));
'

# 2. In Telegram (@saroat_ospeto_bot):
# Send: /find One Piece
# Expected: Returns matching books with [📥 Send File], [📖 Read Online], and [ℹ️ Details] buttons.
# Tap [📥 Send File] or send /get 6 to test direct file delivery.
```

### 7. Jina Reader Fallback & Paywall Verification

Verify that blocked/paywalled article URLs automatically route through Jina Reader:

```bash
# 1. Test Jina Reader fallback fetch via local proxy
bun -e '
  import { extractArticleViaJina } from "./uploader/article.ts";
  const article = await extractArticleViaJina("https://paulgraham.com/foundermode.html");
  console.log("Jina Extracted:", article.title, "words:", article.wordCount);
'

# 2. In Telegram:
# Send an article URL from a Cloudflare-protected or paywalled site.
# The bot detects 401/403 or challenge HTML and falls back to Jina Reader transparently.
```

---

### 8. WAN Reverse Tunnel & Telegram Mini App Operations

Manage and verify the persistent reverse tunnel and Telegram Mini App integration:

#### Tunnel Lifecycle on Mac Mini

```bash
# Check LaunchAgent job status
launchctl list | grep com.ospeto.reading-vless-tunnel

# View tunnel output logs
tail -n 50 ~/Library/Logs/reading-vless-tunnel.log

# Manually reload the LaunchAgent
launchctl unload ~/Library/LaunchAgents/com.ospeto.reading-vless-tunnel.plist
launchctl load -w ~/Library/LaunchAgents/com.ospeto.reading-vless-tunnel.plist
```

#### Test WAN Endpoint & Edge Proxy

```bash
# Check public HTTPS response from WAN
curl -s -I https://reading.wavypremium.xyz

# Check reverse proxy routing on VPS (panel)
ssh panel "curl -s -I http://172.18.0.1:8086"
```

#### Test Telegram Mini App Menu Button Registration

```bash
bun -e '
  import { initChatMenuButton, READING_WEBAPP_URL } from "./uploader/bot.ts";
  console.log("Mini App URL:", READING_WEBAPP_URL);
  const ok = await initChatMenuButton();
  console.log("Menu button registered:", ok);
'
```

---

### 9. Reverse SSH Tunnel Auto-Healing Watchdog & /status Dashboard

Manage and verify the tunnel auto-healing watchdog and in-chat diagnostics:

#### Watchdog Architecture & Healing Flow

The auto-healing watchdog (`scripts/tunnel-watchdog.sh`) runs via LaunchAgent `com.ospeto.reading-tunnel-watchdog` every 120 seconds:
1. **Local Health Checks**: Verifies `nc -z 127.0.0.1 7890` (Sing-box proxy), `127.0.0.1:8086` (Reading HQ), and `127.0.0.1:7200` (KOSync).
2. **WAN Probe**: Checks `https://reading.wavypremium.xyz` through the local VLESS proxy.
3. **Auto-Healing**:
   - If unreachable or returning HTTP 502/000:
     * Kills hanging local SSH forward processes (`pkill -f "ssh.*0.0.0.0:8086"`).
     * Clears orphaned remote listeners holding ports 8086/7200 on VPS `panel` via `ssh panel "fuser -k 8086/tcp 7200/tcp"`.
     * Kickstarts `gui/$(id -u)/com.ospeto.reading-vless-tunnel`.
     * Re-probes after a 4-second delay.
4. **Telegram Escalation**:
   - Maintains failure count in `/tmp/reading-tunnel-failures`.
   - If consecutive failures reach 3, dispatches an alert card to the captain via `TELEGRAM_BACKUP_CHAT_ID`.
   - Automatically resets counter to 0 on any healthy probe.

#### Manual Watchdog Operations

```bash
# 1. Trigger manual watchdog run
/Users/ospeto/uploader/scripts/tunnel-watchdog.sh

# 2. Inspect watchdog logs
tail -f ~/Library/Logs/reading-tunnel-watchdog.log

# 3. Check LaunchAgent status
launchctl list | grep com.ospeto.reading-tunnel-watchdog
```

#### In-Chat Health Dashboard (`/status` and `/health`)

Send `/status` or `/health` to the Telegram bot to inspect:
- **WAN Edge**: VPS Caddy reverse proxy latency and response code for Reading HQ and KOSync.
- **Reverse Tunnel**: Active SSH PID, forwarded ports (`8086`, `7200`), Sing-box proxy status.
- **Reading HQ & Calibre**: Web Uploader (:8086) and Calibre (:8088) states, total catalog count, top format distribution, and newest ingested title.
- **KOReader Sync**: Server state (:7200), SQLite WAL health, user/device counts, and reading progress records.
- **Mac Mini Host**: System uptime, available memory, and storage free space (internal disk + External SSD).
- **Interactive Controls**: `[🔄 Refresh Status]` updates the message card in-place; `[📖 Open Reading HQ]` launches the Telegram Mini App.

---

### 10. KOSync WAN Setup & KOReader Client Configuration

To access KOSync over the WAN (cellular / remote WiFi) without VPN:

#### 1. VPS Caddy Configuration (`panel`)

Add the following site block to `/etc/caddy/Caddyfile` on VPS `panel` (or inside the Caddy container):

```caddy
https://kosync.wavypremium.xyz {
    reverse_proxy * http://172.18.0.1:7200
}
```

Reload Caddy:
```bash
ssh panel "systemctl reload caddy || docker exec caddy caddy reload --config /etc/caddy/Caddyfile"
```

#### 2. KOReader Client Setup (Kindle / Android / Kobo)

1. Open **KOReader** on your device.
2. Tap the top menu bar -> **Settings** (gear icon) -> **Sync**.
3. Tap **Custom sync server**.
4. Check **Use custom sync server**.
5. Set **Server URL**:
   - **WAN (Everywhere):** `https://kosync.wavypremium.xyz`
   - **LAN (Home WiFi):** `http://192.168.31.15:7200`
6. Tap **Register / Login**:
   - Username: your KOSync username (e.g. `moe`)
   - Password: your user password
7. Enable **Auto sync**:
   - Check **Auto sync reading progress when opening and closing books**.
8. Verify sync:
   - Read a page on your Kindle/eReader.
   - Send `/status` to the Telegram bot or check `/Users/ospeto/kosync-server/data/koreader-sync.db`.
   - The updated progress record and timestamp appear immediately.

---

## 🌐 Remote VPS Standby Stack (`us3` / `198.46.146.17`)

If ever needing to manage or update the cloud backup stack:

```bash
# SSH into US VPS
ssh us3

# Check container status
cd /opt/kosync && docker compose ps

# View Caddy & App logs
docker compose logs -f --tail=50

# Restart stack
docker compose restart
```
