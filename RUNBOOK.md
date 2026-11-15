# Operations Runbook: Home Reading Stack

This runbook documents operational commands, health checks, service management, and recovery procedures for the local reading stack on Mac mini (`192.168.31.15`) and the remote standby VPS (`198.46.146.17`).

---

## 🚨 Security Notice: Previously Committed Credentials

This repository used to be private and is being made public. Three real-looking credentials were committed to it earlier in its history. All three are scrubbed from the current tree, but **git history stays readable once the repository is public**, so a clone made before this scrub still contains them.

| Credential | Where it was committed | Status now |
| --- | --- | --- |
| Telegram bot token (`TELEGRAM_BOT_TOKEN`) | earlier history only; not present at `HEAD` | **Reported rotated by the operator**, which this repository cannot verify. Treat the committed value as live until BotFather confirms it is revoked. |
| KOSync password salt (`KOSYNC_PASSWORD_SALT`) | `docker-compose.yml`, `RUNBOOK.md`, `.env.example` in earlier history, and as a hardcoded fallback default at `HEAD` until this scrub | **Not rotated. The value in history is the live production salt.** Production reads that same value from `~/Library/LaunchAgents/com.ospeto.kosync.plist` (`EnvironmentVariables.PASSWORD_SALT`). Scrubbed from `HEAD`, still in use. |
| KOSync `X-Auth-Key` for user `moe` | `RUNBOOK.md` in earlier history, as a sample authenticated request; not present at `HEAD` | **Validity: operator to confirm.** If that value was a real capture rather than an invented example, it authenticates against production as a password-equivalent credential, and changing the salt does **not** revoke it - only changing user `moe`'s password does. |

What this means:

- **Do not trust any credential read from this repository's history.** Anyone who cloned or forked this repository before the scrub should treat the values in their copy as public and already compromised.
- **The residual history is not neutralised.** The salt that history discloses is the salt production still hashes with, so any `koreader-sync.db` copy that lives outside this repository (a backup on other storage, a device restore, a later leak) becomes offline-crackable with `bcrypt(userkey + known_salt)`. The bot token and the `X-Auth-Key` stop working only when the operator revokes them.
- **The rule this repository enforces is not what production does.** `KOSYNC_PASSWORD_SALT` must be set explicitly, with no default, and production reads its salt from the launchd plist rather than from `docker-compose.yml` or this runbook. If you deploy from a clone, generate your own random salt (for example `openssl rand -hex 24`) and never reuse any value that appears in this repository's history - production itself currently reuses exactly such a value.
- **Changing the salt invalidates every existing password hash** in `koreader-sync.db`; every user must reset their password afterwards using the recovery runbooks below. That one-way effect is exactly why the salt is a deliberate, operator-supplied secret rather than a checked-in default.
- **This is not a history rewrite.** Git history stays intact instead of being force-pushed away across every branch and fork, so every value ever committed stays readable to anyone who clones this repository. See the Exposed Credentials Policy at the end of this runbook.

### Before this repository is published

Three decisions belong to the captain, and this repository cannot make them:

1. **Rotate the production `KOSYNC_PASSWORD_SALT`**, or explicitly accept it as disclosed. Rotating revokes access to any database copy that history makes crackable, and forces every user to reset their password.
2. **Change user `moe`'s password** if the `X-Auth-Key` in history was ever a real capture. A salt change alone leaves that key working.
3. **Confirm in BotFather that the committed bot token is revoked.**

---

## 🏗️ Service Architecture on Mac Mini (`192.168.31.15`)

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
| `com.ospeto.reading-vless-tunnel` | `~/Library/LaunchAgents/com.ospeto.reading-vless-tunnel.plist` | `8086, 7200 (remote panel)` | `/Users/ospeto` |
| `com.ospeto.reading-sg-tunnel` | `~/Library/LaunchAgents/com.ospeto.reading-sg-tunnel.plist` | `8086, 7200 (remote sg-vps)` | `/Users/ospeto` |
| `com.ospeto.reading-tunnel-watchdog` | `~/Library/LaunchAgents/com.ospeto.reading-tunnel-watchdog.plist` | — | `/Users/ospeto/uploader` |

---

## 🔍 Routine Health Checks

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

# 6. Check High-Speed Singapore WAN OPDS Feed & Endpoints
curl -s -I http://opds.wavypremium.xyz/opds
curl -s -I -k https://opds.wavypremium.xyz:8443/opds

# 7. Check High-Speed Singapore WAN KOSync Health
curl -i http://kosync-sg.wavypremium.xyz/health
curl -i -k https://kosync-sg.wavypremium.xyz:8443/health

# 8. Check Persistent Reverse Tunnel LaunchAgent Status (Main & Singapore)
launchctl list | grep -E "com.ospeto.reading-(vless|sg)-tunnel"
```

---

## 🕹️ Service Control & Lifecycle

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

  launchctl unload ~/Library/LaunchAgents/com.ospeto.reading-sg-tunnel.plist 2>/dev/null || true
  launchctl load -w ~/Library/LaunchAgents/com.ospeto.reading-sg-tunnel.plist
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

# VLESS SSH Reverse Tunnel logs (Main US panel)
ssh mac-mini "tail -f ~/Library/Logs/reading-vless-tunnel.log"

# Singapore SSH Reverse Tunnel logs (Low-latency sg-vps)
ssh mac-mini "tail -f ~/Library/Logs/reading-sg-tunnel.log"
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

#### KOSync Client Authentication Protocol

KOSync client authentication in KOReader and Readest adheres to the following specification:

1. **Client-Side Hashing (`md5`)**:
   - The user inputs their plain-text password into KOReader or Readest.
   - The client never transmits the raw password over the network. Instead, it computes an MD5 digest:
     $$\text{userkey} = \text{md5}(\text{password})$$
   - The client sends this 32-character lowercase hex string as `password` (on registration/login) or in the `X-Auth-Key` HTTP header (on synced reads/updates) alongside `X-Auth-User: <username>`.

2. **Server-Side Salted Hash (`Bun.password.hash`)**:
   - The KOSync server (running Bun) reads `PASSWORD_SALT` from the environment. There is no built-in default: the salt must be set explicitly, because it is a secret and a wrong value silently produces unusable password hashes.
   - Changing `PASSWORD_SALT` invalidates every existing password hash in `koreader-sync.db`. Every user must then reset their password with the recovery runbook below, using the new salt.
   - The server concatenates the client userkey and salt:
     $$\text{saltedPassword} = \text{userkey} + \text{PASSWORD\_SALT}$$
   - The server stores and verifies this using Bun's native bcrypt implementation (`await Bun.password.hash(saltedPassword)` and `await Bun.password.verify(saltedPassword, user.password)`).

3. **Important Client Behavior (Login vs Register)**:
   - When configuring KOReader or Readest for an existing account, **always tap "Login"** (NOT "Register").
   - Tapping "Register" sends a user creation request to `/users/create`, which fails with HTTP 409 `"Username already exists"`.

#### Emergency Password Recovery & Reset Runbook

If a user forgets their password or cannot log in, reset the password directly in SQLite using Bun:

```bash
# 1. Reset user password in SQLite directly on Mac mini
# ssh does not forward PASSWORD_SALT, so read it from the launchd plist on Mac mini
ssh mac-mini "PASSWORD_SALT=\"\$(plutil -extract EnvironmentVariables.PASSWORD_SALT raw ~/Library/LaunchAgents/com.ospeto.kosync.plist)\" bun -e '
  import { Database } from \"bun:sqlite\";
  import crypto from \"node:crypto\";

  const dbPath = \"/Users/ospeto/kosync-server/data/koreader-sync.db\";
  const salt = process.env.PASSWORD_SALT;
  if (!salt) throw new Error(\"PASSWORD_SALT is empty - set EnvironmentVariables.PASSWORD_SALT in ~/Library/LaunchAgents/com.ospeto.kosync.plist\");
  const username = \"moe\";
  const newPlainPassword = \"YOUR_NEW_PASSWORD_HERE\";

  // Step A: Calculate client-side MD5 userkey
  const clientUserKey = crypto.createHash(\"md5\").update(newPlainPassword).digest(\"hex\");

  // Step B: Calculate server-side salted bcrypt hash
  const hashedPassword = await Bun.password.hash(clientUserKey + salt);

  // Step C: Update database record
  const db = new Database(dbPath);
  const res = db.prepare(\"UPDATE users SET password = ? WHERE username = ?\").run(hashedPassword, username);
  console.log(\"Reset password for\", username, \"- affected rows:\", res.changes);
'"

# 2. Verify authentication using curl
ssh mac-mini "bun -e '
  import crypto from \"node:crypto\";
  const pass = \"YOUR_NEW_PASSWORD_HERE\";
  const userkey = crypto.createHash(\"md5\").update(pass).digest(\"hex\");
  const res = await fetch(\"http://127.0.0.1:7200/users/auth\", {
    headers: { \"x-auth-user\": \"moe\", \"x-auth-key\": userkey }
  });
  console.log(\"Auth check status:\", res.status, await res.json());
'"
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
# Expected: Returns matching books with [📤 Send File], [📖 Read Online], and [ℹ️ Details] buttons.
# Tap [📤 Send File] or send /get 6 to test direct file delivery.
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

### 8. WAN Reverse Tunnels & Public Edge Operations

The reading stack employs a dual-tunnel reverse proxy architecture to provide global resilience, Telegram Mini App integration, and ultra-low-latency synchronization across regions.

#### 1. Dual Reverse Tunnel Topology

| Tunnel LaunchAgent | Remote Endpoint | Target Host | Forwarded Ports | Primary Role |
| --- | --- | --- | --- | --- |
| `com.ospeto.reading-vless-tunnel` | `panel` (US VPS) | `198.46.146.17` | `8086, 7200` | Reading HQ Telegram Mini App & US/Global Fallback |
| `com.ospeto.reading-sg-tunnel` | `sg-vps` (Singapore VPS) | `sg-vps` | `8086, 7200` | High-speed, low-latency regional OPDS downloads & KOSync |

#### 2. High-Speed Singapore WAN Endpoints

The Singapore edge VPS (`sg-vps`) provides high-throughput, low-latency connectivity for Southeast Asian and Pacific clients:

- **OPDS Catalog & Book Downloads**:
  - Plain HTTP (Standard Port 80): `http://opds.wavypremium.xyz/opds`
  - Encrypted TLS (Alternate Port 8443): `https://opds.wavypremium.xyz:8443/opds`
- **KOSync Real-Time Reading Progress Sync**:
  - Plain HTTP (Standard Port 80): `http://kosync-sg.wavypremium.xyz`
  - Encrypted TLS (Alternate Port 8443): `https://kosync-sg.wavypremium.xyz:8443`

##### Port Allocation Rationale (Ports 80 & 8443 vs 443)

- Port `443` on `sg-vps` is exclusively bound to the **Remnawave Xray** VPN and proxy infrastructure.
- To prevent port collisions and guarantee zero disruption to Remnawave Xray, reading stack services route through:
  1. **Port 80 (Plain HTTP)**: Ideal for eReaders (Kindle, Kobo, Boox) and KOReader because it requires no port specification in client URLs and avoids TLS handshake overhead on low-power e-ink hardware.
  2. **Port 8443 (HTTPS/TLS)**: Provides full TLS encryption for mobile or WAN clients that require secure transit without conflicting with port 443.

##### VPS SSH Server Configuration (`sg-vps`)

To prevent orphaned reverse port forwarding locks when the Mac Mini reconnects or reloads the tunnel daemon, the SSH server on `sg-vps` is configured with keepalives and stream unlinking:

```sshconfig
# /etc/ssh/sshd_config.d/reading-tunnel.conf on sg-vps
ClientAliveInterval 15
ClientAliveCountMax 3
StreamLocalBindUnlink yes
GatewayPorts yes
```

- **`ClientAliveInterval 15`**: Probes client connectivity every 15 seconds. If the Mac Mini drops offline unexpectedly (e.g. Wi-Fi blip or sleep), the VPS kernel reaps the dead session within 45 seconds.
- **`StreamLocalBindUnlink yes`**: Automatically unlinks and recycles any lingering Unix domain sockets or forwarded TCP port bindings when a new SSH connection requests the same port. This completely prevents `Error: remote port forwarding failed for listen port 8086/7200` errors.

#### 3. Tunnel Lifecycle Management on Mac Mini

```bash
# Check status of both reverse tunnels
launchctl list | grep -E "com.ospeto.reading-(vless|sg)-tunnel"

# View tunnel logs
tail -n 50 ~/Library/Logs/reading-vless-tunnel.log
tail -n 50 ~/Library/Logs/reading-sg-tunnel.log

# Reload US VLESS tunnel LaunchAgent
launchctl unload ~/Library/LaunchAgents/com.ospeto.reading-vless-tunnel.plist
launchctl load -w ~/Library/LaunchAgents/com.ospeto.reading-vless-tunnel.plist

# Reload Singapore tunnel LaunchAgent
launchctl unload ~/Library/LaunchAgents/com.ospeto.reading-sg-tunnel.plist
launchctl load -w ~/Library/LaunchAgents/com.ospeto.reading-sg-tunnel.plist
```

#### 4. Test WAN Endpoints & Edge Proxies

```bash
# Check US WAN Reading HQ endpoint
curl -s -I https://reading.wavypremium.xyz

# Check Singapore WAN OPDS endpoints (Port 80 & Port 8443)
curl -s -I http://opds.wavypremium.xyz/opds
curl -s -I -k https://opds.wavypremium.xyz:8443/opds

# Check Singapore WAN KOSync health endpoints
curl -i http://kosync-sg.wavypremium.xyz/health
curl -i -k https://kosync-sg.wavypremium.xyz:8443/health

# Verify reverse proxy routing on VPS hosts directly
ssh panel "curl -s -I http://172.18.0.1:8086"
ssh sg-vps "curl -s -I http://127.0.0.1:8086"
```

#### 5. Test Telegram Mini App Menu Button Registration

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
2. **Dual Remote WAN Probes**:
   - **US VLESS Tunnel (`panel`)**: Probes `https://reading.wavypremium.xyz` via local Sing-box proxy (`127.0.0.1:7890`). Also inspects recent daemon logs (`reading-vless-tunnel.log`) for remote port forwarding collision markers (`remote port forwarding failed for listen port`).
   - **Singapore Tunnel (`sg-vps`)**: Probes `http://opds.wavypremium.xyz/opds`, `https://opds.wavypremium.xyz:8443/opds`, and `http://kosync-sg.wavypremium.xyz/health`. Also inspects recent daemon logs (`reading-sg-tunnel.log`) for remote port forwarding collision markers.
3. **Auto-Healing**:
   - **US Tunnel Auto-Healing**:
     - Kills hanging local SSH forward processes (`pkill -f "ssh.*8086.*panel" || true`).
     - Clears orphaned remote listeners holding ports 8086/7200 on VPS `panel` via `ssh -o ProxyCommand="nc -X 5 -x 127.0.0.1:7890 %h %p" panel "fuser -k 8086/tcp 7200/tcp || true"`.
     - Kickstarts `com.ospeto.reading-vless-tunnel` via `launchctl kickstart -k gui/$(id -u)/com.ospeto.reading-vless-tunnel`.
     - Re-probes after a 4-second delay.
   - **Singapore Tunnel Auto-Healing**:
     - Kills hanging local SSH forward processes (`pkill -f "ssh.*8086.*sg-vps" || true`).
     - Clears orphaned remote listeners holding ports 8086/7200 on `sg-vps` via `ssh -o BatchMode=yes -o ConnectTimeout=5 sg-vps "fuser -k 8086/tcp 7200/tcp || true"`.
     - Kickstarts `com.ospeto.reading-sg-tunnel` via `launchctl kickstart -k gui/$(id -u)/com.ospeto.reading-sg-tunnel`.
     - Re-probes all Singapore endpoints after a 4-second delay.
4. **Telegram Escalation**:
   - Maintains failure counts in `/tmp/reading-tunnel-failures-us` and `/tmp/reading-tunnel-failures-sg`.
   - If consecutive failures on either tunnel reach 3, dispatches an alert card to the captain via `TELEGRAM_BACKUP_CHAT_ID`.
   - Automatically resets counters to 0 on healthy probes.

#### Manual Watchdog Operations & Collision Recovery

```bash
# 1. Trigger manual watchdog run (checks & heals both US and Singapore tunnels)
/Users/ospeto/uploader/scripts/tunnel-watchdog.sh

# 2. Inspect watchdog logs
tail -f ~/Library/Logs/reading-tunnel-watchdog.log

# 3. Check LaunchAgent status for both tunnels and watchdog
launchctl list | grep -E "com.ospeto.reading-(vless|sg|tunnel-watchdog)"

# 4. Immediate manual auto-clear and recovery for Singapore tunnel port collision:
ssh -o BatchMode=yes -o ConnectTimeout=5 sg-vps "fuser -k 8086/tcp 7200/tcp || true"
launchctl kickstart -k gui/$(id -u)/com.ospeto.reading-sg-tunnel

# 5. Immediate manual auto-clear and recovery for US VLESS tunnel:
ssh -o ProxyCommand="nc -X 5 -x 127.0.0.1:7890 %h %p" panel "fuser -k 8086/tcp 7200/tcp || true"
launchctl kickstart -k gui/$(id -u)/com.ospeto.reading-vless-tunnel
```

#### In-Chat Health Dashboard (`/status` and `/health`)

Send `/status` or `/health` to the Telegram bot to inspect:

- **WAN Edge**: VPS Caddy reverse proxy latency and response code for Reading HQ and KOSync.
- **Reverse Tunnel**: Active SSH PID, forwarded ports (`8086`, `7200`), Sing-box proxy status.
- **Reading HQ & Calibre**: Web Uploader (:8086) and Calibre (:8088) states, total catalog count, top format distribution, and newest ingested title.
- **KOReader Sync**: Server state (:7200), SQLite WAL health, user/device counts, and reading progress records.
- **Mac Mini Host**: System uptime, available memory, and storage free space (internal disk + External SSD).
- **Interactive Controls**: `[🔄 Refresh Status]` updates the message card in-place; `[📱 Open Reading HQ]` launches the Telegram Mini App.

---

### 10. KOSync WAN Setup, KOReader & Readest Client Configuration, and Auth Protocol

To synchronize reading progress across devices over the WAN (cellular / remote Wi-Fi) or local LAN:

#### 1. VPS Edge Caddy Configuration

##### Low-Latency Singapore VPS (`sg-vps` - Default)

Add the following site blocks to Caddy on `sg-vps` (using Ports 80 and 8443 to preserve Port 443 for Remnawave Xray):

```caddy
http://kosync-sg.wavypremium.xyz {
    reverse_proxy * http://127.0.0.1:7200
}

https://kosync-sg.wavypremium.xyz:8443 {
    reverse_proxy * http://127.0.0.1:7200
}
```

Reload Caddy on `sg-vps`:

```bash
ssh sg-vps "systemctl reload caddy || docker exec caddy caddy reload --config /etc/caddy/Caddyfile"
```

#### 2. KOReader Client Setup (Kindle / Android / Kobo)

1. Open **KOReader** on your device.
2. Tap the top menu bar -> **Settings** (gear icon) -> **Sync**.
3. Tap **Custom sync server**.
4. Check **Use custom sync server**.
5. Set **Server URL**:
   - **High-Speed Singapore WAN (Default & Recommended):** `http://kosync-sg.wavypremium.xyz` (Plain HTTP Port 80, no port required)
   - **Encrypted Singapore WAN:** `https://kosync-sg.wavypremium.xyz:8443` (Alternate TLS Port 8443)
   - **Local LAN (Home Wi-Fi):** `http://192.168.31.15:7200`
6. Tap **Register / Login**:
   - ⚠️ **CRITICAL LOGIN STEP**: Existing users must tap **"Login"** (NOT "Register").
   - Tapping "Register" attempts to register a new account and is rejected by the server with HTTP 409 `"Username already exists"`.
   - **Username**: your KOSync username (e.g. `moe`)
   - **Password**: your account password
7. Enable **Auto sync**:
   - Check **Auto sync reading progress when opening and closing books**.
8. Verify sync:
   - Read a page on your Kindle/eReader and close the book.
   - Send `/reading` or `/status` to the Telegram bot or check `/Users/ospeto/kosync-server/data/koreader-sync.db`.
   - The updated progress record and timestamp appear immediately.

#### 3. Readest App Setup (iOS / iPadOS / Android)

The Readest mobile eReader supports native KOSync progress synchronization:

1. Open **Readest** on your mobile device.
2. Open **Settings** -> **Sync** -> **KOSync / KOReader Progress Sync**.
3. Configure connection parameters:
   - **Server URL**: `http://kosync-sg.wavypremium.xyz` (Plain HTTP Port 80, recommended) or `https://kosync-sg.wavypremium.xyz:8443` (TLS), or LAN `http://192.168.31.15:7200`
   - **Username**: `moe`
   - **Password**: your account password
4. Tap **Connect / Test Sync**.
5. Enable **Background Progress Sync**. Reading position, percentage, and timestamps now sync bidirectionally between Readest and KOReader.

#### 4. KOSync Client Authentication Protocol

Both KOReader and Readest use client-side MD5 password hashing:

1. **Client Hash**: The client hashes the plain-text password locally:
   $$\text{userkey} = \text{md5}(\text{password})$$
2. **Network Transmission**: The client sends `userkey` in the `X-Auth-Key` HTTP header alongside `X-Auth-User: <username>`:

   ```http
   GET /users/auth HTTP/1.1
   Host: kosync-sg.wavypremium.xyz
   X-Auth-User: moe
   X-Auth-Key: <md5-of-your-password>
   ```

3. **Server Verification**:
   - The Bun server reads `PASSWORD_SALT` from the environment. It has no built-in default and must be set explicitly; changing it invalidates every existing password hash.
   - It concatenates `userkey + salt` and checks against the stored bcrypt hash using `await Bun.password.verify(userkey + salt, user.password)`.

#### 5. Password Recovery / Reset Runbook in SQLite

If you forget your password or need an emergency reset, update the hash directly in `/Users/ospeto/kosync-server/data/koreader-sync.db`:

```bash
# Reset password directly on Mac mini
# ssh does not forward PASSWORD_SALT, so read it from the launchd plist on Mac mini
ssh mac-mini "PASSWORD_SALT=\"\$(plutil -extract EnvironmentVariables.PASSWORD_SALT raw ~/Library/LaunchAgents/com.ospeto.kosync.plist)\" bun -e '
  import { Database } from \"bun:sqlite\";
  import crypto from \"node:crypto\";

  const dbPath = \"/Users/ospeto/kosync-server/data/koreader-sync.db\";
  const salt = process.env.PASSWORD_SALT;
  if (!salt) throw new Error(\"PASSWORD_SALT is empty - set EnvironmentVariables.PASSWORD_SALT in ~/Library/LaunchAgents/com.ospeto.kosync.plist\");
  const username = \"moe\";
  const newPlainPassword = \"YOUR_NEW_PASSWORD_HERE\";

  // Client-side MD5 simulation (what KOReader / Readest transmits)
  const clientUserKey = crypto.createHash(\"md5\").update(newPlainPassword).digest(\"hex\");
  // Server-side salted bcrypt hash
  const hashedPassword = await Bun.password.hash(clientUserKey + salt);

  const db = new Database(dbPath);
  const info = db.prepare(\"UPDATE users SET password = ? WHERE username = ?\").run(hashedPassword, username);
  console.log(\"Reset password for\", username, \"- modified rows:\", info.changes);
'"
```

---

### 11. Calibre OPDS Reverse Proxy via Web Uploader (:8086)

To securely expose Calibre OPDS catalogs and EPUB downloads over the WAN without exposing raw `calibre-server` (:8088), the Web Uploader service on port `8086` acts as a unified reverse proxy (PR #32).

#### 1. Unified OPDS Access Endpoints

| Scope | Method | Endpoint URL | Target Service |
| --- | --- | --- | --- |
| **High-Speed Singapore WAN (Default)** | HTTP (Port 80) | `http://opds.wavypremium.xyz/opds` | Web Uploader `:8086` -> Calibre `:8088` (Recommended for KOReader/Kindle) |
| **High-Speed Singapore WAN (TLS)** | HTTPS (Port 8443) | `https://opds.wavypremium.xyz:8443/opds` | Web Uploader `:8086` -> Calibre `:8088` |
| **Home LAN** | HTTP | `http://192.168.31.15:8088/opds` or `http://192.168.31.15:8086/opds` | Calibre `:8088` / Web Uploader `:8086` |
| **Local Machine** | HTTP | `http://127.0.0.1:8086/opds` | Calibre `:8088` |

#### 2. Architecture & Security Hardening

1. **SSRF Loopback-Only Target Enforcement**:
   - The proxy strictly routes to `CALIBRE_SERVER_URL` (default: `http://127.0.0.1:8088`).
   - Guarded by `safeFetchWithSsrf(targetUrl, init, maxRedirects, { allowCalibreServer: true })`.
   - The security guard explicitly validates that the configured Calibre server target resolves exclusively to loopback addresses (`127.0.0.1`, `::1`), preventing any intranet SSRF pivoting.

2. **Strict Path Canonicalization & Segment Validation**:
   - The proxy only accepts specific, canonical routes:
     - `/favicon.png`
     - `/opds` or `/opds/<path>` (all segments must match `^[a-zA-Z0-9_\-\.~%!$&'()*+,;=:@]+$`)
     - `/get/<format>/<id>/<library>` (strictly validates format, numeric book ID, and library string)
   - Disallowed characters, directory traversal attempts (`..`), backslashes, or unencoded illegal characters immediately return `HTTP 400 Bad Request`.

3. **HTTP Method Gating**:
   - Only `GET` and `HEAD` requests are permitted.
   - Any mutating requests (`POST`, `PUT`, `DELETE`) return `HTTP 405 Method Not Allowed` with `Allow: GET, HEAD`.

4. **Header Forwarding Allowlist**:
   - To prevent credential and cookie leakage from external clients to internal servers, client headers are strictly filtered.
   - **Allowed Request Headers**: `range`, `if-none-match`, `if-modified-since`, `accept`, `accept-encoding`, `user-agent`.
   - **Stripped Request Headers**: Client `cookie`, `authorization`, `forwarded`, and untrusted `x-forwarded-*` headers are stripped.
   - **Injected Headers**: Injects verified `x-forwarded-host`, `x-forwarded-proto`, and peer socket `x-forwarded-for`.

5. **Response Sanitization & Location Rewriting**:
   - Strips upstream `set-cookie` headers to prevent session fixation.
   - Strips hop-by-hop headers: `connection`, `keep-alive`, `transfer-encoding`, `trailer`, `upgrade`.
   - Rewrites internal `Location` redirects issued by Calibre server to ensure clients remain on the unified public proxy origin.
   - Enforces `X-Content-Type-Options: nosniff`.

6. **High-Throughput Streaming**:
   - Large EPUB binary downloads stream directly using native `ReadableStream` response bodies without buffering entire books in memory.

#### 3. Operational Verification

```bash
# 1. Fetch OPDS root catalog via Web Uploader proxy
curl -s http://127.0.0.1:8086/opds | head -n 25

# 2. Verify HEAD request support
curl -s -I http://127.0.0.1:8086/opds

# 3. Verify mutating methods are blocked (HTTP 405)
curl -s -I -X POST http://127.0.0.1:8086/opds
# Expected: HTTP/1.1 405 Method Not Allowed (Allow: GET, HEAD)

# 4. Verify path traversal rejection (HTTP 400)
curl -s -I "http://127.0.0.1:8086/opds/..%2fadmin"
# Expected: HTTP/1.1 400 Bad Request
```

---

### 12. Telegram Bot Library Deduplication & Calibre Cleaner Tools (PR #30, #31)

To keep the Calibre library clean and prevent duplicate book imports, the stack provides automated ingestion deduplication, interactive Telegram bot cleaning commands, and a standalone CLI cleaner script.

#### 1. Telegram Bot Deduplication Commands

In `@saroat_ospeto_bot`, use any of the following command aliases:

- `/dedup`
- `/dedupe`
- `/clean`
- `/clean_duplicates`
- `/duplicates`

##### Interactive Dry-Run Inspection Workflow

1. Send `/dedup` (or `/clean`) in Telegram.
2. The bot runs a non-destructive analysis and returns a rich summary card:
   - **Total Books Scanned** in Calibre.
   - **Duplicate Groups Detected** and total identified duplicate books.
   - **Top 5 Duplicate Groups Breakdown**:
     - ⭐ **Keeper**: Book ID, title, author, series/volume info, formats, and selection rationale.
     - 🗑️ **Duplicates to Prune**: Book ID, title, author, formats.
3. **Interactive Inline Controls**:
   - `[🧹 Prune Duplicates]` (`apply_dedup_confirm`): Prompts confirmation and executes removal of duplicate copies via `calibredb remove`.
   - `[🔄 Rescan]` (`rescan_dedup`): Re-runs the duplicate scanner and refreshes the card in-place.
   - `[📖 Open Reading HQ]`: Launches the Telegram Mini App.
   - `[🏠 Main Menu]`: Returns to the bot main dashboard.

##### Direct Apply Mode

Send `/dedup apply` or `/clean apply` to immediately execute pruning without the interactive confirmation step.

#### 2. Standalone Duplicate Cleaner CLI Tool

The CLI cleaner is available in `scripts/clean-duplicates.ts` and via shell wrapper `scripts/clean-duplicates.sh`:

```bash
# 1. Safe dry-run preview (DEFAULT: zero changes to Calibre library)
bun run scripts/clean-duplicates.ts --dry-run
# Or using the shell wrapper:
./scripts/clean-duplicates.sh --dry-run

# 2. Execute duplicate pruning (removes duplicates via calibredb remove)
bun run scripts/clean-duplicates.ts --apply
# Or:
./scripts/clean-duplicates.sh --apply

# 3. Custom library or database paths with verbose logging
bun run scripts/clean-duplicates.ts \
  --with-library http://127.0.0.1:8088 \
  --cache-db /Users/ospeto/uploader/cache.db \
  --kosync-db /Users/ospeto/kosync-server/data/koreader-sync.db \
  --audit-log data/duplicate-pruning-audit.log \
  --verbose

# 4. Structured JSON output for scripting or automation
bun run scripts/clean-duplicates.ts --dry-run --json
```

##### Command-Line Options

| Flag | Description | Default |
| --- | --- | --- |
| `--dry-run` | Analyze library and preview duplicate groups without modifications | `true` |
| `--apply`, `--prune` | Actively remove duplicates via `calibredb remove` and update cache | `false` |
| `--with-library <url\|dir>` | Calibre library URL or directory | `http://127.0.0.1:8088` |
| `--library-dir <dir>` | Physical directory containing Calibre books | Auto-discovered |
| `--cache-db <path>` | Path to Reading HQ SQLite cache | `cache.db` |
| `--kosync-db <path>` | Path to KOSync `koreader-sync.db` | `~/kosync-server/data/koreader-sync.db` |
| `--audit-log <path>` | Path for the permanent audit trail | `data/duplicate-pruning-audit.log` |
| `--json` | Output structured JSON report | `false` |
| `--verbose`, `-v` | Enable detailed debug logging | `false` |

#### 3. Deduplication Architecture & Safety Guarantees

1. **Volume Isolation Hard Gate**:
   - Volume and chapter markers are isolated across titles, series volume indices, and subtitle variations.
   - **Safety Guarantee**: Different volumes in a series (e.g. *Volume 1* vs *Volume 2* vs *Volume 14*) are **NEVER** grouped as duplicates, even when series title and author names are identical.

2. **Multi-Tier Matching Engine**:
   - **Tier 1 (Content Signature)**: Identifies books sharing identical EPUB OPF package identifiers / UUIDs or content hashes, even if files were recompressed.
   - **Tier 2 (Series & Volume Match)**: Explicit series name and volume number matches.
   - **Tier 3 (Normalized Title & Author Similarity)**: Computes Dice coefficient similarity on normalized titles (stripping release tags, bracket garbage, publisher noise) and sorted author lists. Ambiguous similarity pairs (0.65–0.88) invoke Jev System-1 arbitration (`isSameBookAsync`).

3. **Keeper Selection Hierarchy**:
   - **Reading Progress**: Books with active reading progress in KOSync (`koreader-sync.db`) receive top priority to prevent losing reading history.
   - **Canonical EPUB Format**: Prioritizes EPUB files over non-canonical or legacy formats.
   - **Metadata Richness**: Scores presence of series metadata, volume indices, custom covers, publishers, and descriptive tags.
   - **Library Longevity**: Preserves the older Calibre book ID / creation date.

4. **Audit Trail Logging**:
   - Every execution of `--apply` writes a permanent audit record to `data/duplicate-pruning-audit.log` containing timestamps, keeper IDs, pruned duplicate IDs, match types, and rationale for auditability.

---

### 13. Public WAN Security & Job Queue Operational Verification

#### 1. Public WAN Security & Authentication

Verify that the WAN surface (`https://reading.wavypremium.xyz`) is locked down while LAN access remains friction-free:

```bash
# 1. Verify friction-free LAN access (mutations allowed without auth on local network)
curl -i -X POST http://192.168.31.15:8086/api/library/facets

# 2. Verify WAN mutating route blocks unauthenticated requests (HTTP 401)
curl -i -X POST https://reading.wavypremium.xyz/api/books/bulk-delete \
  -H "Content-Type: application/json" \
  -d '{"bookIds": [9999]}'
# Expected: HTTP 401 Unauthorized {"success":false,"error":"Authentication required for public WAN access"}

# 3. Verify WAN mutating route succeeds with valid Bearer token
curl -i -X POST https://reading.wavypremium.xyz/api/library/clean-metadata \
  -H "Authorization: Bearer <YOUR_READING_API_KEY>"
# Expected: HTTP 200 OK

# 4. Verify CSRF guard blocks mutating requests with untrusted Origin
curl -i -X POST http://192.168.31.15:8086/api/books/1 \
  -H "Origin: https://malicious-site.com"
# Expected: HTTP 403 Forbidden {"success":false,"error":"Disallowed Origin: https://malicious-site.com"}

# 5. Verify SSRF protection on URL ingestion
curl -i -X POST http://192.168.31.15:8086/api/ingest-url \
  -H "Content-Type: application/json" \
  -d '{"url": "http://169.254.169.254/latest/meta-data/"}'
# Expected: HTTP 400 Bad Request {"success":false,"error":"SSRF protection: ..."}
```

#### 2. Durable Ingestion Job Queue Monitoring & Recovery

Inspect and manage durable background jobs:

```bash
# 1. Query recent jobs via API
curl -s http://192.168.31.15:8086/api/jobs/recent | jq .

# 2. Inspect a specific job by ID
curl -s http://192.168.31.15:8086/api/jobs/<job_id> | jq .

# 3. Retry a failed job manually
curl -i -X POST http://192.168.31.15:8086/api/jobs/<job_id>/retry

# 4. Direct SQLite inspection of the jobs table
sqlite3 /Users/ospeto/uploader/cache.db "SELECT id, type, status, retries, created_at, error FROM jobs ORDER BY created_at DESC LIMIT 10;"

# 5. Job queue process recovery
# If the book-uploader service is restarted while jobs are processing,
# the service automatically recovers any interrupted jobs back to 'pending' on startup.
```

---

### 14. Safe EPUB-Only Library Collection & SSD Migration Preflight

Home Reading Stack operates as a clean, unified **EPUB-only library collection**. This guarantees uniform rendering, typography, reading progress synchronization via KOReader, and seamless OPDS delivery across all eReader devices.

*Note: Per architecture decision, live Calibre library migration is a separately supervised operation executed after backups are verified. Do not physically rename or move files inside Calibre library directories by hand.*

#### 1. Ingestion & Format Quarantine Rules

- **Accepted Formats:** `.epub` files, or `.zip` / `.rar` / `.7z` / `.tar` archives containing `.epub` files.
- **Rejected / Quarantined Formats:** Non-EPUB formats (`.pdf`, `.mobi`, `.azw3`, `.cbz`, `.cbr`, `.kfx`, `.txt`, `.docx`) are rejected with clear error explanations rather than mixing into the collection.
- **Web Articles:** Direct URL ingestion (`POST /api/ingest-url` or Telegram bot link sharing) converts web articles into clean, typography-enhanced `.epub` documents with auto-generated typographic covers.
- **Calibre Queries & Views:** Calibre queries in `server.ts`, Telegram bot search (`/find`), `/recent`, and Reading HQ UI views strictly filter for EPUB format (`WHERE UPPER(d.format) = 'EPUB'`).

#### 2. Sanitized Metadata-Derived Filenames

User-facing downloads (`GET /api/books/:id/download/:format`), Telegram document deliveries, and Obsidian exports use sanitized metadata-derived names:

- **With Series:** `"Series 01 - Title - Author.epub"`
- **Standalone:** `"Title - Author.epub"`
- **Missing Author:** `"Title.epub"`
- **Safety Guarantee:** Internal physical files inside `/Users/ospeto/Calibre Libraries/Agent Library/` are **never renamed, moved, or mutated**. Calibre storage paths are treated as internal and immutable.
- **Headers:** HTTP responses include standard RFC 5987 / RFC 6266 `Content-Disposition` with ASCII fallback and percent-encoded UTF-8 (`filename*=UTF-8''...`).

#### 3. SSD Migration Preflight (`/Volumes/Ospeto_SSD/Calibre Library`)

To safely migrate EPUBs from the external Mac Mini SSD library into the canonical library:

##### Step 1: Mandatory Offline Snapshot Backup

Before initiating any live library import, stop Calibre server and take an offline copy:

```bash
# 1. Stop Calibre server
launchctl unload ~/Library/LaunchAgents/com.ospeto.calibre-server.plist

# 2. Create timestamped offline snapshot
cp -a "/Users/ospeto/Calibre Libraries/Agent Library" "/Users/ospeto/Calibre Libraries/Agent Library.backup.$(date +%Y%m%d_%H%M%S)"

# 3. Restart Calibre server
launchctl load -w ~/Library/LaunchAgents/com.ospeto.calibre-server.plist
```

##### Step 2: Run Read-Only Migration Preflight Inventory

Execute the dry-run preflight tool to analyze source inventory, detect duplicates, and skip non-EPUB formats without modifying any files:

```bash
./scripts/migration-preflight.sh
```

Preflight analysis reports:

- Total registered books in source library (~1,105).
- EPUB format books identified (~1,104).
- Non-EPUB formats excluded (e.g. 1,104 KFX, AZW, TXT).
- Exact duplicates already present in canonical library.
- New unique EPUB candidates ready for batch ingestion.

##### Step 3: Supervised Batch Import (Post-Merge)

When migration is supervised, import unique EPUBs into Calibre using `calibredb add`:

```bash
# Import individual or batch EPUBs through Calibre HTTP server (prevents SQLite locks)
/opt/homebrew/bin/calibredb add \
  --with-library http://127.0.0.1:8088 \
  --automerge ignore \
  "/path/to/incoming/book.epub"
```

##### Step 4: Post-Migration Verification Checklist

Verify each reading stack integration point after import:

1. **OPDS Feed:**

   ```bash
   curl -s http://127.0.0.1:8088/opds | head -n 25
   ```

2. **Reading HQ API & Web App:**

   ```bash
   curl -s http://127.0.0.1:8086/api/books | jq length
   ```

3. **Telegram Bot:**
   - Send `/recent` to inspect newly added EPUBs.
   - Send `/find <title>` to verify instant search.
   - Tap `[Send File]` on a migrated book to verify metadata-derived delivery.
4. **KOReader Device Sync:**
   - Trigger sync from device or check `http://kosync-sg.wavypremium.xyz/health`.

---

### 15. Security, Secret Hygiene & Credential Rotation Protocol

- **Placeholders in Configuration Templates:** `.env.example` contains non-functional dummy placeholders only (`your_kosync_password_salt_here`, `123456789:ABCdefGHIjklMNOpqrsTUVwxyz`). Real secrets, salts, and tokens must never be committed to source control.
- **Exposed Credentials Policy:** If production credentials (such as `TELEGRAM_BOT_TOKEN`, `KOSYNC_PASSWORD_SALT`, or `READING_API_KEY`) are ever exposed or committed to repository history, they require captain-authorized live credential rotation and repository history remediation (e.g. via `git filter-repo` or BFG Repo-Cleaner). Crewmate agents must not rewrite git history or perform live credential rotation autonomously without explicit captain authorization.

---

## ☁️ Remote VPS Standby Stack (`us3` / `198.46.146.17`)

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
