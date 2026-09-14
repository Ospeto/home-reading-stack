# Operations Runbook: Home Reading Stack

This runbook documents operational commands, health checks, service management, and recovery procedures for the local reading stack on Mac mini (`192.168.31.15`) and the remote standby VPS (`198.46.146.17`).

---

## 🛠️ Service Architecture on Mac Mini (`192.168.31.15`)

All services on the Mac mini run as native macOS LaunchAgents under `/Users/ospeto/Library/LaunchAgents/`:

| LaunchAgent Label | File Path | Port | Work Directory |
|---|---|---|---|
| `com.ospeto.kosync` | `~/Library/LaunchAgents/com.ospeto.kosync.plist` | `7200` | `/Users/ospeto/kosync-server` |
| `com.ospeto.calibre-server` | `~/Library/LaunchAgents/com.ospeto.calibre-server.plist` | `8088` | `/Users/ospeto/Calibre Libraries/Agent Library` |
| `com.ospeto.book-uploader` | `~/Library/LaunchAgents/com.ospeto.book-uploader.plist` | `8086` | `/Users/ospeto/uploader` |
| `com.ospeto.reading-telegram-bot` | `~/Library/LaunchAgents/com.ospeto.reading-telegram-bot.plist` | — | `/Users/ospeto/uploader` |
| `com.ospeto.calibre-autoimport` | `~/Library/LaunchAgents/com.ospeto.calibre-autoimport.plist` | — | `/Users/ospeto/kosync-server` |
| `com.ospeto.manga-processor` | `~/Library/LaunchAgents/com.ospeto.manga-processor.plist` | — | `/Users/ospeto/manga-processor` |
| `com.ospeto.reading-stack-backup` | `~/Library/LaunchAgents/com.ospeto.reading-stack-backup.plist` | — | `/Users/ospeto/kosync-server` |
| `com.ospeto.kosync-watchdog` | `~/Library/LaunchAgents/com.ospeto.kosync-watchdog.plist` | — | `/Users/ospeto/kosync-server` |
| `com.ospeto.singbox-proxy` | `~/Library/LaunchAgents/com.ospeto.singbox-proxy.plist` | `7890` | `/Users/ospeto/.config/sing-box` |

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

### 4. Daily Database Snapshot Backup & WAL Durability
- Primary Local Storage: `/Users/ospeto/.backups/reading-stack/` (Always writable, immune to TCC / drive unmounts)
- Secondary Mirror: `/Volumes/Ospeto_SSD/backups/reading-stack/` (Automated sync when SSD is mounted)
- SQLite Database Resiliency: All databases (`koreader-sync.db`, `cache.db`, `manga.db`, `metadata.db`) run in `WAL` mode (`PRAGMA journal_mode=WAL; PRAGMA synchronous=NORMAL;`) for zero-corruption power loss safety.
- Retention: 7 days rolling retention
- Log Hygiene: Auto-truncates logs in `~/Library/Logs/` if exceeding 10 MB.
- Manual backup run:
  ```bash
  ssh mac-mini "/Users/ospeto/kosync-server/backup-daily.sh"
  ```
- Inspect backup logs:
  ```bash
  ssh mac-mini "tail -f ~/Library/Logs/reading-stack-backup.log"
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
