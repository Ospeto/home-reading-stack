# Operations Runbook: Home Reading Stack

This runbook documents operational commands, health checks, service management, and recovery procedures for the local reading stack on Mac mini (`192.168.31.15`) and the remote standby VPS (`198.46.146.17`).

---

## 🚨 Security Notice: Previously Committed Credentials

This repository used to be private and is being made public. Three credential values were committed to it earlier in its history: two of them are confirmed real, and the third is a KOSync `X-Auth-Key` example whose validity is recorded as operator-to-confirm. All three literals were removed from the working tree at `HEAD`, **git history stays readable once the repository is public**, so a clone made before this scrub still contains them, and two of the three exposures were accepted by the captain rather than revoked.

| Credential | Where it was committed | Status now |
| --- | --- | --- |
| Telegram bot token (`TELEGRAM_BOT_TOKEN`) | earlier history only; removed from the working tree at `HEAD` | **Rotated and confirmed.** The operator rotated it in BotFather, and the old value was verified out-of-band to return `401` while the replacement returns `200`. The dead literal stays readable in git history. |
| KOSync password salt (`KOSYNC_PASSWORD_SALT`) | `docker-compose.yml`, `RUNBOOK.md`, and `.env.example` in earlier history, and as a hardcoded fallback default at `HEAD` until this scrub | **Exposed and accepted, not rotated.** The literal was removed from the working tree at `HEAD`, is still readable in git history, and is still the salt production hashes with (read from `~/Library/LaunchAgents/com.ospeto.kosync.plist`, `EnvironmentVariables.PASSWORD_SALT`). The captain accepted this exposure rather than force every user through a password reset. Stored hashes are argon2id (`Bun.password.hash`) with their own embedded per-hash salt, so the disclosed salt alone reveals no password - an attacker also needs a `koreader-sync.db` copy. |
| KOSync `X-Auth-Key` for user `moe` | `RUNBOOK.md` in earlier history, as a sample authenticated request; removed from the working tree at `HEAD` | **Exposed and accepted, not revoked.** The literal is still readable in git history, and if it was a real capture it authenticates against production as a password-equivalent credential. Changing the salt does **not** revoke it: revoking it requires changing user `moe`'s password, which the captain chose not to do. |

What this means:

- **Do not trust any credential read from this repository's history.** Anyone who cloned or forked this repository before the scrub should treat the values in their copy as public and already compromised.
- **Two exposures are accepted, not fixed.** The salt history discloses is the salt production still hashes with, and the `moe` `X-Auth-Key` may still authenticate until that password changes (operator to confirm whether that value was a real capture). Any `koreader-sync.db` copy outside this repository (a backup on other storage, a device restore, a later leak) is therefore crackable offline against a known salt. Only the bot token has been revoked.
- **Fail-closed is enforced by this repository's compose file, not by the launchd server.** `docker-compose.yml` refuses to start unless `KOSYNC_PASSWORD_SALT` is non-empty, and production reads its salt from the launchd plist rather than from `docker-compose.yml` or this runbook. The server on the launchd path (`/Users/ospeto/kosync-server`) has no such guard: with `PASSWORD_SALT` unset or empty it falls back to the published placeholder `default_salt_change_in_production` and silently hashes passwords with that guessable string, so an unset salt there is a misconfiguration, not a safe default. Removing that fallback belongs in that server's source, outside this repository.
- **Generate your own salt, with one restore exception.** If you deploy from a clone, generate your own random salt (for example `openssl rand -hex 24`) and never reuse any value that appears in this repository's history - production itself currently reuses exactly such a value. **The exception: restoring an existing `koreader-sync.db` requires the salt that database was hashed with.** A fresh salt leaves every stored hash unverifiable, and users are locked out with HTTP `401` on `/users/auth` with no startup error (see the next bullet).
- **Changing the salt invalidates every existing password hash** in `koreader-sync.db`; every user must reset their password afterwards using the recovery runbooks below. That one-way effect is exactly why the salt is a deliberate, operator-supplied secret rather than a checked-in default.
- **This is not a history rewrite.** Git history stays intact instead of being force-pushed away across every branch and fork, so every value ever committed stays readable to anyone who clones this repository. See the Exposed Credentials Policy at the end of this runbook.

### Before this repository is published

The captain's decisions, recorded so they are not re-opened by accident:

1. **`KOSYNC_PASSWORD_SALT` exposure accepted, no rotation.** The salt in history stays the live production salt; forcing every user to reset their password was judged worse than the disclosed salt.
2. **`moe` `X-Auth-Key` exposure accepted, no revocation.** That user's password is unchanged, so the key may still authenticate; revoking it would mean changing the password.
3. **Bot token rotated and confirmed.** Verified out-of-band: the old value returns `401`, the replacement returns `200`.

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

### 9. Startup Library Preflight (Running But Not Answering — INC-11)

A live PID in `launchctl list` plus a listening port is **not** proof the uploader is healthy. On start the server probes the Calibre library out of process (5s deadline, `LIGHTHOUSE_LIBRARY_PROBE_TIMEOUT_MS` to override) and refuses to bind unless the library root and `metadata.db` are readable — because a library on an unanswering removable volume made `bun` block inside `openat`, which produced a silent wedge instead of an error. `ok` is the only verdict that starts (and it prints nothing); `missing`, `permission-denied`, `unresponsive` and `error` all exit 1 with the cause and both remedies, so an absent or late-mounting volume can never leave a live PID serving no catalog.

```bash
# 1. Is the process serving, or only listening?
launchctl list | grep com.ospeto.book-uploader
curl -s -m 5 -o /dev/null -w '%{http_code}\n' http://127.0.0.1:8086/api/books   # 000 = nothing listening (gate refused) or bound but wedged

# 2. Read the preflight verdict from the agent's log
#    "Fatal:" means it refused to bind: missing | permission-denied | unresponsive | error
tail -20 ~/Library/Logs/uploader.log

# 3. Check whether the library volume answers at all - stat works from cache even
#    when real reads are wedged, so read a directory and a file, not a stat.
ls /Volumes/Ospeto_SSD >/dev/null && echo "volume answers" || echo "volume refuses or hangs"
cat /Volumes/Ospeto_SSD/Lighthouse_Agent_Library/metadata.db >/dev/null && echo "library readable"

# 4. If it is wedged: remount the volume (stops calibre-server) or move the library
#    onto local storage and keep the SSD as a backup target. See INC-11 in INCIDENTS.md.
```

**Expected steady state while the library is unreadable.** The generated `com.ospeto.book-uploader` plist sets `KeepAlive` with no `SuccessfulExit` predicate, so a persisting fatal verdict is a launchd respawn loop (roughly every 10 s), not one failure: `launchctl list` shows a changing PID and `~/Library/Logs/uploader.log` accumulates the same `Fatal:` block once per attempt. That repetition is the intended loud signal — not a second bug, not a start-order race, and not evidence of a crash loop to be chased. It continues until the host action in INC-11 lands, and the log stays bounded while it does: `reading-stack-backup` runs `scripts/backup-daily.sh` log hygiene daily, which caps `uploader.log` at 10 MB (the Calibre step there is a `[ -f ]` guard that skips when the database is absent, so the rotation is still reached in this state). Stop the loop deliberately while you work on the cause:

```bash
bin/lighthouse down            # or: launchctl bootout gui/$(id -u)/com.ospeto.book-uploader
```

**The tunnel watchdog is affected too.** `scripts/tunnel-watchdog.sh` treats a non-200 from `:8086/api/books` as a local failure: it kickstarts the uploader and then exits before its remote WAN probes. While this gate refuses, that means one extra restart per 120 s run and **no US or Singapore tunnel checking or healing at all** — restoring library access is what restores tunnel monitoring.

**Reboot survival is still blocked.** This preflight only makes the failure loud and actionable; the uploader cannot come up after a reboot until the library is readable at boot, which is a host action, not a code path. See INC-11 in `INCIDENTS.md` for the pending action and both remedies.

A successful manual start is not evidence of supervision: an interactive shell inherits its TCC entitlement, a launchd agent does not.

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
ssh mac-mini "tail -f ~/Library/Logs/uploader.log"

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
   - The KOSync server (running Bun) reads `PASSWORD_SALT` from the environment. The server source this runbook deploys (`/Users/ospeto/kosync-server`) is **not** fail-closed: with the variable unset or empty it falls back to the published placeholder `default_salt_change_in_production`, silently hashing passwords with a guessable string, so an unset salt there is a misconfiguration to fix rather than a safe default. Only the docker-compose path in this repository refuses to start without an explicit salt; dropping the server-side fallback belongs in that server's source, outside this repository.
   - Changing `PASSWORD_SALT` invalidates every existing password hash in `koreader-sync.db`. Every user must then reset their password with the recovery runbook below, using the new salt.
   - The server concatenates the client userkey and salt:
     $$\text{saltedPassword} = \text{userkey} + \text{PASSWORD\_SALT}$$
   - The server stores and verifies this using Bun's native argon2id implementation (`Bun.password.hash`, whose default output embeds its own per-hash salt; `await Bun.password.hash(saltedPassword)` and `await Bun.password.verify(saltedPassword, user.password)`).

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

  // Step B: Calculate server-side salted argon2id hash
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
- Writable Startup Contract (`uploader/sqlite-open.ts`): every writable startup open of `cache.db` (Reading HQ server, Telegram bot, durable job queue) goes through one shared helper with these guarantees:
  - `PRAGMA busy_timeout = 5000` is installed **before** the `journal_mode = WAL` switch. The switch takes a lock, so arming the busy handler afterwards leaves the statement that needs it unprotected.
  - The open and the WAL switch retry a bounded number of times (~8 attempts, 150 ms doubling to a 1.5 s cap per statement) on `SQLITE_BUSY` / `SQLITE_BUSY_RECOVERY` / `SQLITE_LOCKED`, so the server and the bot can start in either order.
  - A silently refused switch (SQLite returns the previous journal mode rather than raising) is retried the same way before it counts as a failure.
  - In-memory databases (`:memory:`, empty path, `file::memory:`) skip the WAL switch entirely; `journal_mode=memory` is correct there, not an error.
  - Fail-fast: when `cache.db` cannot be prepared, the Reading HQ server refuses to bind `:8086` and exits non-zero, and the Telegram bot exits non-zero, instead of leaving a half-started process in a launchd `KeepAlive` respawn loop.
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
   - The Bun server reads `PASSWORD_SALT` from the environment. It has no fail-closed guard: an unset or empty value falls back to the published placeholder `default_salt_change_in_production`, which must be treated as a misconfiguration rather than a working default. Changing the salt invalidates every existing password hash.
   - It concatenates `userkey + salt` and checks against the stored argon2id hash using `await Bun.password.verify(userkey + salt, user.password)`.

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
  // Server-side salted argon2id hash
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

- **Secrets in Configuration Templates:** `.env.example` ships its secret variables empty (`TELEGRAM_BOT_TOKEN=`, `KOSYNC_PASSWORD_SALT=`) rather than carrying fake values: a non-empty dummy would satisfy the compose `:?` guard on `KOSYNC_PASSWORD_SALT` and start the stack on a published default. Real secrets, salts, and tokens must never be committed to source control.
- **Exposed Credentials Policy:** If production credentials (such as `TELEGRAM_BOT_TOKEN`, `KOSYNC_PASSWORD_SALT`, or `READING_API_KEY`) are ever exposed or committed to repository history, they require an explicit captain decision, recorded in the Security Notice at the top of this runbook: either live credential rotation plus repository history remediation (e.g. via `git filter-repo` or BFG Repo-Cleaner), or a recorded acceptance of the exposure. Crewmate agents must not rewrite git history or perform live credential rotation autonomously without explicit captain authorization.

---

## 📱 Kindle SSH Device Access (Wi-Fi first, USB fallback)

Shell access to a Kindle from this Mac mini, so device behaviour can be verified on hardware instead of inferred. There are **two independent routes** and you should use whichever is available; neither depends on a remembered IP address.

| Route | Works when | SSH daemon | Port | Independent of KOReader? |
| --- | --- | --- | --- | --- |
| **A. Wireless** | Device awake, on Wi-Fi, KOReader running with its SSH server started | KOReader `SSH.koplugin` (patched dropbear) | `2222` | **No** — stops when KOReader exits |
| **B. USB cable** | Device plugged in by USB-C; Wi-Fi may be off; KOReader may be closed | USBNetwork dropbear (system level) | `22` on the USB link | **Yes** — outside KOReader |

The distinction matters: route A is the everyday path because it needs no cable, and route B exists precisely for the case route A cannot cover.

### 1. Entry point: find the device, then connect to what you found

Do not assume an address. The Kindles have no stable IP: the DHCP lease can move them, so any address you saw last time - `192.168.31.73` and `192.168.31.167` were the two in the last recorded run - is a snapshot of that lease, not a property of the device. A lease change silently invalidates a pasted address, and the macOS ARP cache is not a source of truth either - `arp -an` returns nothing on this host even while hosts are answering.

```bash
# The entry point. Reports the device's current address from live evidence.
bin/lighthouse kindle-ssh find

# Second device, or machine-readable output
bin/lighthouse kindle-ssh find --device 2
bin/lighthouse kindle-ssh find --json          # full discovery result as JSON
```

Discovery runs three layers in order and reports each one, so a miss tells you *why* it missed:

| Layer | What it checks | What a miss means |
| --- | --- | --- |
| mDNS | `kindle.local`, `kindle1.local`, `kindle2.local`, `kindlepaperwhite.local` | The device publishes no `.local` name (Kindles usually do not) |
| USB gadget | `192.168.15.244` (the device's own USB-network address) | No USB network link, or USB networking is off |
| LAN sweep | TCP `2222` and `22` across the real LAN subnet(s), then an SSH banner read | Nothing on the network is serving Kindle SSH |

Only a **dropbear** banner counts as a Kindle. An `OpenSSH` responder on port 22 is a different machine (this Mac mini itself answers on `22`), and the tool refuses to treat it as a device. This Mac's own addresses are excluded from results.

> **Kindles do not answer `ping`.** Their firmware drops ICMP while serving SSH normally, so any ping-first scan will report a healthy device as absent. The tool therefore probes every address in the subnet on both ports and never pre-filters on ICMP.

`find` exits `0` when a Kindle responder was found and `1` when nothing was found - it is discovery only, so it never authenticates and never returns `2`. When the printed candidates do not include the device you asked for, `find` says so in place of the login command instead of printing another device's address. `probe`, `connect` and `key` exit `0` only on a verified route, and `connect -- <command>` exits with the remote command's own status, exactly as `ssh` does. `usb` exits `0` when the link answered, `2` when the USB route is not up (no candidate link interface, or nothing answered on either port).

### 2. Why there is no DHCP reservation pinning the address

The router **is** reachable - it is a Xiaomi MiWiFi at `192.168.31.1` (nginx/LuCI, ports 80/443/8080 open, 0.7 ms away) - but every device-list API requires an authenticated session:

```bash
curl -s http://192.168.31.1/cgi-bin/luci/api/xqsystem/router_info
# {"code":401,"msg":"Invalid token"}
```

This home holds no router admin credentials, so a reservation cannot be created and none is pretended to exist. **Documented find-first discovery is the accepted answer**, and it is one command. There is deliberately no router-lease discovery layer either: nothing on this host can authenticate to the router, so a layer that could never run would only imply a capability that does not exist.

Once `find` prints a stable address you may pin it yourself in `~/.ssh/config` - the tool prints a ready-to-paste `Host` block for the device you asked for and **never edits your SSH config**. That pin is a convenience, not a substitute for discovery: rerun `find` whenever the device has been off for a while.

> Existing `Host kindle1` / `Host kindle2` entries in `~/.ssh/config` are **wrong in both directions**: `kindle1` points at `192.168.31.167`, which is the *second* device's address, and `kindle2` still carries the literal placeholder `192.168.31.XXX`. A bare `ssh kindle1` therefore reaches the wrong device or fails for a reason that has nothing to do with the daemon. Use `bin/lighthouse kindle-ssh connect`, or update those blocks from what `find` prints.

### 3. Route A - Wireless (KOReader must be running)

**Availability contract:** this route exists only while KOReader is running with its SSH server started. The daemon is `SSH.koplugin`; closing KOReader kills it. This is not a fault and needs no fixing - but it means the route cannot be used to diagnose an app that has crashed.

Get the exact command from `find` (it substitutes the discovered address), or construct it:

```bash
ssh -p 2222 -i ~/.ssh/id_ed25519 \
    -o IdentitiesOnly=yes -o BatchMode=yes \
    -o PreferredAuthentications=publickey \
    -o StrictHostKeyChecking=accept-new -o ConnectTimeout=8 \
    root@<address-from-find> 'uname -srm; cat /etc/kindle-version'
```

The wrapper does discovery, pre-flights the port and the key, and prints a real reason instead of hanging:

```bash
bin/lighthouse kindle-ssh probe                    # full diagnosis: port, banner, key auth, identity
bin/lighthouse kindle-ssh connect                  # verified login + remote identity
bin/lighthouse kindle-ssh connect -- 'uname -srm'  # run one remote command
```

`BatchMode=yes` is deliberate: an untrusted key fails immediately with a message instead of blocking on an invisible password prompt.

**Key-based login (one time per device).** Needs an SSH route that already works once - either a password prompt, or a key that is already trusted.

```bash
# Installs ~/.ssh/id_ed25519.pub on the device, idempotently, then re-verifies.
bin/lighthouse kindle-ssh key --device 1
```

Under the hood it pipes `scripts/kindle-key-install.sh` to the device over `sh -s`. That script resolves root's home from `/etc/passwd`, appends the key only if absent, sets `700`/`600` permissions, and touches nothing else - no KOReader file, no service restart. It warns loudly when the resolved path is RAM-backed (`/tmp/...`), because a Kindle whose root home lives on a volatile mount must have the key reinstalled after each reboot. Reverse it with `--uninstall` (removes exactly that key line).

To confirm key auth end to end, `probe` must report `verified` with a remote identity block - a working port alone is not proof.

### 4. Route B - USB cable fallback

Use when Wi-Fi is off, or when KOReader is closed and route A therefore has no daemon. The jailbroken devices expose a USB network gadget, giving a root shell that does not depend on KOReader at all.

Addressing (device defaults):

| | Value |
| --- | --- |
| Kindle address on the USB link | `192.168.15.244` |
| This Mac must take | `192.168.15.201` / `255.255.255.0` |
| SSH port on the link | `22` (USBNetwork daemon), also `2222` if KOReader's plugin happens to run |

Check the current state first - this is read-only and cannot disturb the device:

```bash
bin/lighthouse kindle-ssh usb          # adapter, mounted volume, USBNetwork presence, link state
bin/lighthouse kindle-ssh usb --json   # machine-readable
```

It probes both link ports, so a link that answers only on `22` (USBNetwork, KOReader closed - the ordinary case) is reported reachable, and the login command it prints carries the port that actually answered. It never runs `sudo` or changes host networking; the Mac-side command in "Mac-side steps" below is yours to run.

**Pre-flight, no shell required.** With the device plugged in as an ordinary USB drive, the user partition is mounted at `/Volumes/<Kindle>/`, so USBNetwork's presence is directly observable:

```bash
ls -d /Volumes/*/usbnet 2>/dev/null && echo "USBNetwork already installed"
```

If that directory exists, **install nothing** - skip to "Enable".

#### Recorded INSTALL steps (only if `/Volumes/<Kindle>/usbnet` does not exist)

The package that provides this is the MobileRead **USBNetwork** hack. Installing it patches the device's root filesystem, which is a real change to the device even though it leaves `/mnt/us/koreader` untouched.

1. Identify the exact model and firmware version (Kindle UI: `Settings -> Device Options -> Device Info`).
2. Download the USBNetwork build that matches **that** model and firmware line.
3. Copy the `Update_usbnet_<model>_install.bin` file into `/Volumes/<Kindle>/mrpackages/`.
4. Eject cleanly, then run it from the device via **KUAL -> Helper -> Install MR Packages** (or the framework's `Menu -> Settings -> Update Your Kindle` when MRPI is installed).
5. After reboot, confirm `/Volumes/<Kindle>/usbnet/bin/usbnetwork` exists.

#### Recorded UNINSTALL steps (record these BEFORE installing)

1. Copy `Update_usbnet_<model>_uninstall.bin` into `/Volumes/<Kindle>/mrpackages/`.
2. Run it through the same MRPI route, then reboot.
3. Verify `/Volumes/<Kindle>/usbnet` is gone and mass-storage mode is back.

If the uninstall `.bin` for the installed build is not on hand, **do not install** - an unremovable rootfs patch on a device with no console access is exactly the trap this section exists to avoid.

#### Enable / disable USB networking (no install needed if already present)

```bash
# On the device, in a shell or via KUAL:
/mnt/us/usbnet/bin/usbnetwork          # toggle USB networking
```

Equivalent from the device's search bar: `;debugOn`, then `~usbNetwork`, then `;debugOff`.

To make it start on every boot, place an empty marker file at `/mnt/us/usbnet/auto`.

**Consequence to know:** while USB networking is active the Kindle stops presenting itself as a USB mass-storage drive. That breaks the drive-based `bin/lighthouse sync-kindle` path until you toggle back - so this is a mode switch, not a permanent state. Disable it (re-run `usbnetwork`, or reboot when the `auto` marker is absent) before doing a normal USB book sync.

#### Mac-side steps (once, per plug-in)

```bash
# Find the Kindle interface: a newly appeared en* adapter holding an address on 192.168.15.0/24
# (the host end's MAC need not be Amazon's - it is often locally administered)
ifconfig -a | grep -B4 'inet 192.168.15.'

# Assign this Mac's address on the USB link
sudo ifconfig <enX> inet 192.168.15.201 netmask 255.255.255.0 up

# Confirm and log in
ping -c 2 192.168.15.244
ssh -p 22 -i ~/.ssh/id_ed25519 -o BatchMode=yes -o ConnectTimeout=8 root@192.168.15.244 'uname -srm'
```

`bin/lighthouse kindle-ssh find` already probes `192.168.15.244` on both ports, so it reports this route automatically once the link is up.

#### Risk to KOReader, and where this stops

- The route itself (enabling the gadget) does not read or write any KOReader file. KOReader's data, settings, plugins and sidecars are never touched by this procedure.
- The **install** step is the only genuinely invasive part: it patches the root filesystem. It is therefore gated on a matching package plus an on-hand uninstall `.bin`, and it is **not** to be run on a guess about model or firmware.
- Hard stop: if the device cannot be identified confidently, or its uninstall `.bin` is unavailable, or the device will not mount as a volume to verify the pre-flight, stop and report rather than installing.

**Current state: nothing was installed.** Both devices were unreachable throughout this work, so the pre-flight (which requires a mounted volume) could not even be run, and no package was downloaded, copied, or executed. Route B is documented and tooled but unproven on hardware - see §6.

### 5. Known failure modes

| Symptom | What it means | What to do |
| --- | --- | --- |
| **The Kindle does not answer `ping` but SSH works** | **Normal.** Kindle firmware drops ICMP. This is the single most misleading symptom on this network | Ignore ping entirely; judge reachability by a TCP connection on `2222` |
| `find` reports all layers empty | Device powered off, off Wi-Fi, or KOReader closed | Wake it, start KOReader's SSH server (Tools -> SSH), rerun `find` |
| Hosts up but `2222` closed | The network is fine; KOReader is not running | Start KOReader's SSH server. Not a network fault |
| `probe` says *key authentication failed* | Route exists, key is not trusted | `bin/lighthouse kindle-ssh key --device 1` (needs password auth once) |
| `22` answers with `OpenSSH` | Not the Kindle - a computer or NAS on the same subnet | Ignore; the tool already refuses it as a candidate |
| Login hangs then says *Connection timed out* | The address moved (DHCP) or the device slept mid-session | Rerun `bin/lighthouse kindle-ssh find`; never reuse an old address |
| Key auth worked yesterday, fails today after reboot | Key landed in a RAM-backed path (`/tmp/root`) | Reinstall the key; make it persistent (see the installer's `VOLATILE` warning) |
| A hand-written `net.connect()` probe says ECONNREFUSED to a device that `ssh` reaches | Runtime sockets to the LAN fail on this host (scoped routing / VPN layering), while native binaries succeed | Do not debug the device - use the tool, which probes through `nc` and `ssh` |
| `usb` says *no candidate USB link interface found* | No Mac interface holds an address on `192.168.15.0/24`, so the link is not up on this end | Plug in a data cable and enable USB networking on the device; confirm the gadget switch |
| `usb` sees a link interface but `192.168.15.244` does not answer | USB networking is off on the device | Enable it (`/mnt/us/usbnet/bin/usbnetwork`) |
| `ping 192.168.15.244` fails on the Mac | No address on the USB link | Run the `sudo ifconfig <enX>` step |
| `sync-kindle` cannot find the Kindle | USB networking is still active, so there is no drive | Disable USB networking, or reboot the device |

### 6. Proof status

Route A (wireless) is **proven on both devices**: key-based login from this Mac mini returned real remote output, no password prompt. Route B (USB cable) is **implemented and documented but not exercised** — no cable was attached. That distinction is deliberate; see the last subsection.

#### Proven: Route A on both devices

| | Device 1 | Device 2 |
| --- | --- | --- |
| Address found by `find` | `192.168.31.73:2222` | `192.168.31.167:2222` |
| Banner | `SSH-2.0-dropbear_2026.92 (KOReader)` | `SSH-2.0-dropbear_2026.92 (KOReader)` |
| Serial (`/proc/usid`) | `G001LG1221170MVV` | `G092AP03315200G6` |
| Kernel | `Linux 4.9.77-lab126 armv7l` | `Linux 4.9.77-lab126 armv7l` |
| Auth | publickey, `BatchMode=yes`, no prompt | publickey, `BatchMode=yes`, no prompt |

The command and its real output, for device 1:

```bash
bin/lighthouse kindle-ssh connect --device 1 -- 'cat /proc/usid; hostname; uname -srm; uptime'
```

```text
G001LG1221170MVV
kindle
Linux 4.9.77-lab126 armv7l
 08:39:06 up 1 day, 17:35,  0 users,  load average: 2.26, 0.97, 0.50
```

and device 2 (same command, `--device 2`):

```text
G092AP03315200G6
kindle
Linux 4.9.77-lab126 armv7l
 08:39:20 up 28 days, 11:45,  0 users,  load average: 0.15, 0.19, 0.17
```

`lab126` is Amazon's Kindle hardware division, so the identity is confirmed by the device itself rather than inferred from its port.

Also verified on this Mac mini (real runs):

| Check | Result |
| --- | --- |
| `find` | Finds both Kindles on `192.168.31.0/24`, rejects the Mac's own `OpenSSH` on `:22` and another host's `OpenSSH`, exit `0` |
| `find --device 2` / `connect --device 2` | Selects the second device by address order; refuses to silently substitute the first |
| `usb` | Reports no USB link - the built-in Ethernet or VPN adapters are not mistaken for the gadget |
| `scripts/kindle-key-install.sh` | Idempotent install, `700`/`600` permissions, exact-line uninstall, `--dry-run` writes nothing, bad key rejected |
| Unit suite | `bun test scripts/kindle-ssh.test.ts` - 86 passing |

#### Not proven: Route B (USB cable)

No USB cable was attached during this work: `/Volumes` held no Kindle, no `192.168.15.0/24` interface existed, and `bin/lighthouse kindle-ssh usb` found no USB link. Consequently:

- the USBNetwork pre-flight (`ls -d /Volumes/*/usbnet`) could not be run, so whether the package is already installed on either device is **unknown**;
- nothing was installed, and no uninstall `.bin` was needed;
- the host-side `sudo ifconfig <enX> inet 192.168.15.201 netmask 255.255.255.0 up` step is untested on this host.

Route B is therefore a documented, gated procedure, not a working route. Closing it needs a cable and a decision about installing USBNetwork if it is absent (that step patches the device root filesystem).

#### Two environmental facts worth remembering

1. **Kindles are ICMP-silent.** Both devices served SSH on `2222` while answering no ping at all. Any scan that pre-filters on ping will conclude the device is absent, so the tool probes every address and uses no ICMP filter.
2. **Runtime sockets to the LAN fail on this host.** A hand-written `net.connect('192.168.31.73', 2222)` returns `ECONNREFUSED` and a Python socket returns `EHOSTUNREACH`, while `nc`, `ssh` and `curl` reach the very same address. This is host scoped-routing/VPN layering, not a device fault. All probing in `scripts/kindle-ssh.ts` therefore delegates to `nc` (and `ssh` for auth/identity) instead of using runtime sockets; a socket-based implementation reports a healthy device as missing.

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
