<p align="center">
  <img src="assets/logo.svg" alt="LightHouse Spiral Book Tower Logo" width="144" height="144" />
</p>

<h1 align="center">LightHouse Reading Stack</h1>

<p align="center">
  <strong>Unified, self-hosted private reading infrastructure for Kindle and mobile devices running <a href="https://github.com/koreader/koreader">KOReader</a>.</strong>
</p>

LightHouse turns a home Mac mini or Linux host into an always-on personal reading command center. It bridges physical e-ink readers (Kindle Paperwhite, Basic, Oasis) and mobile devices to a centralized Calibre library, real-time reading progress synchronization, automated web article extraction, and secure worldwide remote access—completely bypassing restrictive firewalls (GFW/DPI) without needing VPN apps installed on e-ink devices.

---

## 🏗️ Architecture & Topology

```text
┌────────────────────────────────────────────────────────────────────────┐
│                        Local Home Network (Wi-Fi)                     │
│                                                                        │
│   ┌────────────────┐       ┌────────────────┐                          │
│   │ Kindle Paperw. │       │  Kindle Basic  │                          │
│   │ (192.168.31.x) │       │ (192.168.31.x) │                          │
│   └───────┬────────┘       └───────┬────────┘                          │
│           │                        │                                   │
│           └───────────┬────────────┘                                   │
│                       ▼                                                │
│         ┌───────────────────────────┐                                  │
│         │    Mac Mini (Home Hub)    │                                  │
│         │       192.168.31.15       │                                  │
│         ├───────────────────────────┤                                  │
│         │ 1. KOSync Server (:7200)  │ ◄── Real-time progress/bookmark  │
│         │ 2. OPDS Server   (:8088)  │ ◄── OTA Book Catalog & Downloads │
│         │ 3. LightHouse UI (:8086)  │ ◄── Catalog Manager & Ingestion  │
│         │ 4. LAN Proxy     (:7890)  │ ◄── sing-box SOCKS5 / VLESS      │
│         │ 5. Tunnel Agents (launchd)│ ──┐ Persistent SSH Tunnels       │
│         └───────────────────────────┘   │                              │
└─────────────────────────────────────────┼──────────────────────────────┘
                                          │ ssh reverse tunnels
                                          │ via ProxyCommand (SOCKS5 :7890)
                                          ▼
┌────────────────────────────────────────────────────────────────────────┐
│         Singapore Edge (`sg-vps`) & US Edge (`panel.wavypremium.xyz`)  │
│  - Caddy TLS Reverse Proxy (https://reading.wavypremium.xyz)           │
│  - Low-latency Singapore WAN: KOSync (:80/:8443) & OPDS (:80/:8443)    │
│  - Singapore Web App & TMA (:8443) / Caddy Edge (https://reading...)   │
└────────────────────────────────────────────────────────────────────────┘
```

### Core Components

1. **LightHouse Web Manager (`uploader/server.ts`, port `8086`):**
   - High-performance Bun/TypeScript server with in-process SQLite queries.
   - Minimalist, responsive Telegram Mini App (TMA) and desktop catalog interface (`uploader/index.html`).
   - Durable SQLite-backed ingestion job queue (`cache.db`) and EPUB-only canonical enforcement.
   - Built-in OPDS feed reverse proxy forwarding `/opds` and `/get/*` directly to Calibre with range requests, client-facing URL rewriting, exact UTF-8 `Content-Length` accounting, and clean RFC 9110 validator hygiene.
2. **KOSync Server (`kosync/`, port `7200`):**
   - Lightweight, self-hosted KOReader synchronization backend backed by SQLite (`koreader-sync.db`).
   - Syncs reading positions, progress percentage, and timestamps across devices instantly.
3. **Calibre Content & OPDS Server (port `8088`):**
   - Native Calibre library server running over `metadata.db` in WAL mode.
   - Provides Open Publication Distribution System (OPDS) XML/Atom catalog feeds for direct wireless book downloads.
4. **sing-box LAN Proxy Gateway (port `7890`):**
   - Inbound HTTP & SOCKS5 proxy routing outbound external requests through low-latency VLESS nodes.
   - Serves as the Wi-Fi HTTP proxy for Kindle devices needing to bypass GFW/DPI firewalls.
5. **Reverse SSH Tunnels & Auto-Healing Watchdog:**
   - Dual WAN tunnels routing traffic through Singapore (`sg-vps`) and US (`panel`) edge nodes.
   - Monitored by `scripts/tunnel-watchdog.sh` every 120s with automatic remote port collision recovery (`fuser -k`).

---

## 🌐 Services & Endpoints Reference

Singapore WAN endpoints are the **primary recommended routes** for low-latency progress sync and wireless book downloads on KOReader.

| Service | Address | Protocol | Description |
| --- | --- | --- | --- |
| **Singapore WAN KOSync (Recommended)** | `http://kosync-sg.wavypremium.xyz` | HTTP (Port 80) | High-speed Singapore WAN KOSync progress sync (KOReader default) |
| **Singapore WAN KOSync (TLS)** | `https://kosync-sg.wavypremium.xyz:8443` | HTTPS (8443) | Encrypted Singapore WAN KOSync progress sync |
| **Singapore WAN OPDS Feed (Recommended)** | `http://opds.wavypremium.xyz/opds` | HTTP / Atom | High-speed wireless OPDS catalog for KOReader & mobile devices |
| **Singapore WAN OPDS Feed (TLS)** | `https://opds.wavypremium.xyz:8443/opds` | HTTPS (8443) | Encrypted Singapore wireless OPDS catalog |
| **KOReader Joplin Highlight Sync (LAN)** | `http://192.168.31.15:8086` / private `JOPLIN_TOKEN` from `.env` | HTTP / Joplin | Primary Joplin export target. KOReader's Joplin plugin is plain HTTP-only (`socket.http`, no TLS). Do not publish the token. |
| **KOReader Joplin Highlight Sync (WAN, optional)** | `http://opds.wavypremium.xyz` port `80` | HTTP / Joplin | Optional only. `?token=` travels in cleartext and is logged in proxy access logs. Do not publish the token. |
| **Singapore WAN Web & Mini App** | `https://reading-sg.wavypremium.xyz:8443` | HTTPS (8443) | Low-latency Singapore WAN Telegram Mini App & Web App |
| **Global WAN Dashboard & Mini App** | `https://reading.wavypremium.xyz` | HTTPS | Global secure access to LightHouse via SSH reverse tunnel + Caddy TLS |
| **LightHouse Dashboard (Local)** | `http://192.168.31.15:8086` | Web SPA | Fast catalog manager, KOSync reading telemetry, facets, and upload manager |
| **Telegram Bot & Mini App** | `@saroat_ospeto_bot` | Telegram API | Ingest books, search catalog (`/find`), view shelf (`/reading`), hot backups (`/backup`) |
| **Local KOSync** | `http://192.168.31.15:7200` | HTTP / JSON | Direct LAN progress sync for KOReader |
| **Local Calibre OPDS Feed** | `http://192.168.31.15:8088/opds` | Atom / XML | Direct home LAN book catalog |
| **Native LightHouse OPDS Feed** | `http://192.168.31.15:8086/api/opds` | Atom / XML | Zero-downtime native OPDS 1.2 catalog feed with filtered title/author/series search generated directly from SQLite metadata. Supports OPDS paging (`?start=N&count=M` → `rel="next"`) and exposes Calibre ratings as `<lighthouse:rating>` |
| **KOReader Plugin Generator** | `http://192.168.31.15:8086/api/koplugin/download` | ZIP (`.koplugin`) | Generates a pre-configured KOReader plugin archive per request from the current server settings. Requires the same authentication as the web app; the API key is baked into the generated `lighthouse_config.lua` and never logged or placed in a query string |
| **Local Calibre Web Reader** | `http://192.168.31.15:8088` | Web UI | In-browser reading and Calibre catalog manager |
| **Local LAN Proxy Gateway** | `http://192.168.31.15:7890` | HTTP / SOCKS5 | sing-box proxy gateway for Kindle GFW bypass |
| **Singapore Reverse Tunnel Daemon** | `com.ospeto.reading-sg-tunnel` | SSH | LaunchAgent binding Mac Mini `:8086` and `:7200` to `sg-vps` |
| **VLESS Reverse Tunnel Daemon** | `com.ospeto.reading-vless-tunnel` | SSH / SOCKS5 | LaunchAgent binding Mac Mini `:8086` to VPS `panel` via ProxyCommand |
| **Tunnel Watchdog Daemon** | `com.ospeto.reading-tunnel-watchdog` | Bash Script | Periodic health watchdog executing `scripts/tunnel-watchdog.sh` every 120s |

---

## ⚡ Unified Control CLI (`bin/lighthouse`)

LightHouse includes a portable management CLI (`bin/lighthouse`) for service lifecycle, health diagnostics, automated daemon installation, and hot database backup/restore.

| Command | Description |
| --- | --- |
| `bin/lighthouse status` | Displays full one-screen dashboard of all ports (8086, 7200, 8088, 7890, 3002 Firecrawl), tunnels, launchd daemons (accurately distinguishing running, loaded-idle scheduled, disabled, and missing plists), and database record counts. |
| `bin/lighthouse up` | Starts all services gracefully in strict dependency order (Calibre, KOSync, LightHouse UI, LAN proxy, reverse tunnels). |
| `bin/lighthouse down` | Stops all services gracefully in reverse dependency order without leaving orphaned processes. |
| `bin/lighthouse restart` | Performs safe sequential stop and restart of reading stack services (`down; sleep 1; up`). |
| `bin/lighthouse health` | Probes HTTP/TCP endpoints, checks response codes, and auto-heals stale remote listeners (`fuser -k`). |
| `bin/lighthouse categorize` | Classifies book languages (`mya`, `eng`, `other`), assigns standardized category tags, and prunes promotional tags. |
| `bin/lighthouse enrich-synopsis` | Populates descriptions for Calibre books prioritizing per-volume lookups (EPUB metadata, online volume queries) with AniList series fallback and duplicate series overview re-enrichment. |
| `bin/lighthouse heal-covers` | Audits and heals Calibre on-disk volume covers from EPUBs and purges stale/duplicate downscaled thumbnail caches. |
| `bin/lighthouse ingest-novel <url>` | Ingests web serials and fanfiction (RoyalRoad, AO3, ScribbleHub, FanFiction.net) via FanFicFare with cover extraction, tags, and chapter updates. |
| `bin/lighthouse sync-kindle` | Two-way USB-C sync: pushes active/unread books from Calibre to Kindle (/Volumes/Kindle/books) and pulls clippings & KOReader highlights to Obsidian. |
| `bin/lighthouse sync-obsidian` | Syncs highlights, notes, and progress from KOReader/Kindle to Obsidian with idempotent markers. |
| `bin/lighthouse firecrawl <cmd>` | Control self-hosted Firecrawl on-demand cluster (`status`, `up`, `down`) to conserve host RAM (~2.5 GB). |
| `bin/lighthouse install-daemons` | Dynamically generates and registers macOS LaunchAgents for the current user and repository root. |
| `bin/lighthouse backup-ssd` | Incremental whole-library backup to external SSD (`rsync -av --delete` + hot SQLite snapshots). |
| `bin/lighthouse backup` | Flushes SQLite WAL frames and creates an atomic snapshot bundle with SHA-256 checksum and manifest. |
| `bin/lighthouse restore <archive>` | Performs verified disaster recovery with cryptographic checksum verification and integrity scan. |

```bash
# Display full one-screen status dashboard of all ports, tunnels, and services
bin/lighthouse status

# Start all services gracefully in dependency order
bin/lighthouse up

# Stop all services gracefully in reverse dependency order
bin/lighthouse down

# Restart the entire stack
bin/lighthouse restart

# Run automated health probes and auto-heal stale listeners/workers
bin/lighthouse health

# Preview missing synopsis enrichment across library (safe dry-run)
bin/lighthouse enrich-synopsis

# Apply enriched synopses and missing covers via Calibre server metadata update
bin/lighthouse enrich-synopsis --apply

# Limit enrichment to first 20 books or restrict source strategy (epub, online, all)
bin/lighthouse enrich-synopsis --apply --limit 20 --source=online

# Re-enrich volumes holding duplicate series overviews with true volume synopses
bin/lighthouse enrich-synopsis --apply --re-enrich-duplicates

# Preview stale/duplicate cover thumbnail audit across library (safe dry-run)
bin/lighthouse heal-covers

# Apply cover healing: restore missing covers from EPUBs and purge stale thumbnail caches
bin/lighthouse heal-covers --apply

# Preview web novel metadata without downloading (safe dry-run)
bin/lighthouse ingest-novel https://www.royalroad.com/fiction/12345/sample --dry-run

# Ingest web novel into Calibre with custom tags (default includes 'webnovel')
bin/lighthouse ingest-novel https://archiveofourown.org/works/123456 --tags "LitRPG,Fantasy"

# Update existing downloaded novel with newly released chapters
bin/lighthouse ingest-novel https://www.royalroad.com/fiction/12345/sample --update

# Preview Type-C USB Kindle two-way sync (safe dry-run)
bin/lighthouse sync-kindle

# Apply two-way Kindle sync (push active books, pull highlights to Obsidian & web reader)
bin/lighthouse sync-kindle --apply

# Push entire Calibre library to Kindle and auto-eject when finished
bin/lighthouse sync-kindle --apply --all --eject

# Synchronize KOReader/Kindle highlights and reading notes to Obsidian vault
bin/lighthouse sync-obsidian --apply

# Watch Calibre library and KOSync DB for continuous live Obsidian sync
bin/lighthouse sync-obsidian --apply --watch

# Inspect Firecrawl on-demand cluster state and auto-sleep timer
bin/lighthouse firecrawl status

# Wake Firecrawl cluster manually via docker compose
bin/lighthouse firecrawl up

# Stop Firecrawl cluster immediately to release ~2.5 GB RAM back to macOS
bin/lighthouse firecrawl down

# Inspect USB-C Kindle connection status and storage metrics
bin/lighthouse sync-kindle --status

# Scan and prune redundant duplicate book files from Kindle storage
bin/lighthouse sync-kindle --clean-duplicates

# Scan and prune with TypeSafe Jev System-1 arbitration for cross-script & subtitle variants
bin/lighthouse sync-kindle --clean-duplicates --jev

# Force re-transfer of books to Kindle even if file size matches
bin/lighthouse sync-kindle --apply --force

# Dynamically generate and register macOS LaunchAgents for the current user
bin/lighthouse install-daemons

# Run immediate incremental whole-library backup to external SSD
bin/lighthouse backup-ssd

# Inspect external SSD backup status and drive detection
bin/lighthouse backup-ssd status

# Update daily scheduled backup time (managed via LaunchAgent)
bin/lighthouse backup-ssd set-time 03:00

# Preview whole-library SSD backup without modifying external drive
bin/lighthouse backup-ssd --dry-run

# Create a hot SQLite backup bundle with checksum and manifest
bin/lighthouse backup

# Perform verified restoration of complete stack from backup bundle
bin/lighthouse restore ~/.backups/reading-stack/lighthouse-backup-YYYY-MM-DD_HHMMSS.tar.gz --dry-run
```

---

## 💾 Hot SQLite Backup & Restore Kit

LightHouse protects all critical reading databases (progress sync, library catalog metadata, ingestion hash cache, manga state) using zero-downtime hot SQLite online snapshots with integrity checksums and WAL truncation.

### 1. Backup Producers

The reading stack supports three complementary backup workflows:
- **Unified CLI (`bin/lighthouse backup`):**
  1. Runs `sqlite3 <db> "PRAGMA wal_checkpoint(TRUNCATE);"` to flush pending transactions from WAL files back into the primary database pages.
  2. Creates atomic snapshots via `sqlite3 <db> ".backup <dest>"` across all four databases:
     - KOSync Database (`koreader-sync.db`)
     - Calibre Library Metadata (`metadata.db`)
     - Ingestion Job & Hash Cache (`cache.db`)
     - Manga State Database (`manga.db`, if present)
  3. Packages snapshots into `~/.backups/reading-stack/lighthouse-backup-YYYY-MM-DD_HHMMSS.tar.gz` (or `.tar.zst` if `zstd` is installed).
  4. Generates a sibling SHA-256 integrity checksum file (`.sha256`) and an embedded JSON backup manifest (`manifest.json`).
- **Automated Scheduled Daily Snapshots (`scripts/backup-daily.sh`):**
  - Runs automatically every morning at 04:00 AM via LaunchAgent `com.ospeto.reading-stack-backup`.
  - Produces `reading-stack-backup-YYYY-MM-DD_HHMMSS.tar.gz` with 7-day rolling retention and mirrors to external SSD when mounted.
  - Automatically delivers backup archives to Telegram when `TELEGRAM_BACKUP_CHAT_ID` is set.
- **In-Chat Telegram On-Demand Backups (`/backup`):**
  - Instant online backup created by the Telegram bot producing `reading-stack-backup-YYYY-MM-DD_HHMMSS.tar.gz` and delivered directly to the chat as a `.tar.gz` document.
- **External SSD Incremental Whole-Library Mirror (`bin/lighthouse backup-ssd`):**
  - Incremental whole-library backup to external storage (e.g. `/Volumes/Ospeto_SSD`).
  - Mirrors entire Calibre library (EPUBs, covers, author directories, `metadata.db`) via `rsync -av --delete` to `<SSD>/Calibre_Library/` so subsequent backups take only seconds.
  - Takes hot atomic SQLite snapshots of all four databases (`metadata.db`, `cache.db`, `koreader-sync.db`, `manga.db`) into `<SSD>/Databases/` with SHA-256 integrity checksums.
  - Writes `<SSD>/backup_manifest.json` recording timestamp, book count, total size, database hashes, and duration.
  - **Dynamic LaunchAgent Scheduling:** Managed via `com.ospeto.reading-ssd-backup.plist` with `StartCalendarInterval` matching configured schedule time (e.g. daily at `03:00`). `bin/lighthouse status` reflects loaded/scheduled idle calendar agent, disabled, or missing plist states accurately without false dead-process reporting.
  - **Safe Mount Detection:** If the SSD is unmounted at scheduled run time, logs a clean notice and exits with code 0 without erroring or crashing.
  - **Web UI & REST APIs:** Configurable via Web UI Settings & Storage modal (`openStorageModal`), with endpoints `GET /api/backup/ssd/status`, `POST /api/backup/ssd/config`, and `POST /api/backup/ssd/run`.

### 2. Verified Restore Engine (`bin/lighthouse restore`)

The restore engine in `bin/lighthouse restore` automates safe, verified disaster recovery:

```bash
# 1. First verify archive integrity and checksum without modifying any files
bin/lighthouse restore ~/.backups/reading-stack/lighthouse-backup-2026-03-24_120000.tar.gz --dry-run

# 2. Execute verified restore (stops services, cleans sidecars, restores, and verifies SQLite integrity)
bin/lighthouse restore ~/.backups/reading-stack/lighthouse-backup-2026-03-24_120000.tar.gz --force

# 3. Bring services back online
bin/lighthouse up
bin/lighthouse status
```

*Note: The restore engine can restore bundles created by `bin/lighthouse backup` as well as daily archives produced by `scripts/backup-daily.sh`.*

**Automated Safety Guarantees:**
- **Cryptographic Checksum Verification:** Verifies the archive matches its SHA-256 checksum before extracting.
- **Archive Safety Scan:** Inspects archive members to reject symlinks and directory traversal (`..`) sequences.
- **Automatic Service Quiescence:** Calls `cmd_down` to safely stop running services before modifying destination databases.
- **Hermetic WAL Cleanup:** Automatically unlinks preexisting `.db-wal` and `.db-shm` sidecars to prevent stale WAL frames from replaying over restored databases.
- **Schema-Aware Content & Optional-Table Verification:** Handles databases with optional schemas (such as `cache.db` with or without `jobs` table, or empty/populated jobs), verifying data-bearing rows (`highlights`, `file_hashes`, `jobs`) and content fidelity rather than simple row counts, while preserving present-table errors and rollback snapshots (`.bak.<timestamp>`) on failure.
- **Pre-Execution CLI Option Validation:** Validates required options (`--output`, `--output-dir`, `--target`) upfront against missing, empty, or next-option values, preventing directory, database, or service side effects on malformed input.

---

## 📖 KOReader Device Setup Guide

The primary path is the **generated LightHouse plugin**: the server builds it on demand and it arrives already pointed at the right server and already authenticated, so nothing has to be typed on the device. Manual setup (sections 2 and 3) stays fully supported as the fallback for any device that cannot load an external plugin.

### 1. Generated LightHouse Plugin (Primary)

1. Open the LightHouse web app → **Guide** (book icon in the header, or the footer link) → **KOReader Plugin** tab.
2. Tap **Download lighthouse.koplugin**. The archive is generated per request from the server you are browsing (`GET /api/koplugin/download`) and contains:
   - `lighthouse.koplugin/main.lua` and `_meta.lua` — the plugin itself,
   - `lighthouse.koplugin/lighthouse_opds.lua`, `lighthouse_client.lua`, and `lighthouse_status.lua` — the pure-Lua OPDS parser, HTTP/HTTPS transport, and reading-progress merge,
   - `lighthouse.koplugin/lighthouse_stats.lua` — pure reading-statistics parsing and formatting,
   - `lighthouse.koplugin/lighthouse_config.lua` — the server origin you downloaded from plus the current server API key.

   Download from the LAN address to bake in the LAN origin, or from the WAN address to bake in the WAN origin.
3. Unpack it so the folder itself ends in `.koplugin` inside KOReader's plugins directory:
   ```bash
   # Kindle (USB mass storage)
   unzip lighthouse.koplugin -d /mnt/us/koreader/plugins/
   # Kobo
   unzip lighthouse.koplugin -d /mnt/onboard/.kobo/koreader/plugins/
   ```
   You must end up with `koreader/plugins/lighthouse.koplugin/main.lua`. Unzipping without `-d` (or extracting in Finder and copying the outer folder) nests the folder one level deeper and KOReader will not load it.
4. Restart KOReader, then open the **Search icon (magnifying glass)** → **LightHouse library** (also available under **Tools** → **LightHouse library**):
   - **Browse library** — paged catalog, 40 books per page (`GET /api/opds?start=N&count=40`).
   - **Search library…** — title / author / series search (`GET /api/opds?search=…`).
   - **Currently reading** — every active KOSync session (`GET /api/kosync/active`).
   - **Reading stats** — the on-device counterpart of the web Reading Statistics modal (`GET /api/kosync/stats`, one request per open, no polling): current streak with the best streak, reading time today / this week / all time, books finished this year, library health as unread / reading / finished counts, the yearly goal (only when a target is set: a progress bar per configured target, and the plain count — `12 read` / `34h read` — for a metric with no target), and a monochrome 26-week activity heatmap. The heatmap uses five distinct shades (`· ░ ▒ ▓ █`) rather than a colour ramp because e-ink has no colour, and its shade key names the same thresholds the server shades by; each row is one week of up to seven days and fits the menu width, and tapping a week lists its days so a tap on a day shows that day's reading time. A field the server does not return renders as *unavailable* instead of zero, and a failed request shows the plugin's normal network / server error message.
   - Book detail — author, series, Calibre rating, per-book reading progress, synopsis, and **Download EPUB** (`GET /api/books/<id>/download/epub`).
5. **Regenerating:** after changing the server address or `READING_API_KEY`, download again and replace `koreader/plugins/lighthouse.koplugin`. An already-installed older plugin keeps working, because it only uses endpoints that already existed and never a bespoke API.

Notes:
- The API key is rendered into `lighthouse_config.lua` inside the archive only. It is never written to a repository file, a log line, or a URL query string, and the download route requires the same authentication as the rest of the web app (LAN requests pass, WAN requests need the Bearer key, a session cookie, or Telegram WebApp `initData`). The route deliberately refuses a *scoped* key (`READING_SCOPED_KEYS`) with `403 insufficient_scope`: the archive embeds the server key, so a limited credential must never be able to trade itself for the master key. Mint the plugin from the web app (global key / LAN / Telegram) instead of widening a scoped key's permissions.
- **HTTPS and redirects:** the client picks its transport from the configured URL scheme — `socket.https` for an `https://` origin and plain `socket.http` for `http://` — and follows up to 5 redirects (`301/302/303/307/308`), resolving relative `Location` headers. A KOReader build without TLS support reports `https_unavailable` on screen instead of failing silently, and the LAN `http://` origin keeps working.
- **Timeouts** are configuration, not constants: `lighthouse_config.lua` carries `request_block_timeout` / `request_total_timeout` (default 10s per operation, 90s per catalog or progress request — enough for a first page over slow Wi-Fi) and `download_block_timeout` / `download_total_timeout` (default 15s / 300s). The Connection screen shows the values in use.
- **Failure reporting:** a failed request names what happened (missing TLS, Wi-Fi, an HTML page instead of a file, a rejected key, too many redirects, an unwritable download folder or a failed file write such as a full disk) and the raw error is written to the KOReader log for diagnosis.
- The plugin speaks the existing OPDS catalog, cover, EPUB download, KOSync progress, and KOSync statistics endpoints, so server upgrades never require reinstalling it. The stats view is a read-only consumer: it renders the payload `GET /api/kosync/stats` already returns and never recomputes sessions on the device.

### 2. Progress Synchronization (KOSync)

1. Open any book in KOReader → tap top of screen for menu bar.
2. Tap the **Tools (wrench icon)** tab → select **Progress sync**.
3. Tap **Custom sync server** and enter the Singapore WAN endpoint:
   ```text
   http://kosync-sg.wavypremium.xyz
   ```
   *(Encrypted TLS: `https://kosync-sg.wavypremium.xyz:8443` | Local LAN: `http://192.168.31.15:7200`)*
4. Tap **Login** → enter Username (`moe`) and password.
5. Enable **"Automatically keep documents in sync"**.
6. Tap **"Pull progress to this device now"** to verify connection.

Reading progress synchronized from KOReader automatically fuels the **Reading Statistics & Telemetry** engine, rendered in the **Stats** modal (top header button):
- **Layout**: the activity heatmap opens directly under the sticky modal header, followed by a compact 2x2 metric-chip grid and a single-line goal row; library health, recent sessions, and stale reads sit in a balanced two-column grid on tablet/desktop, so the whole summary fits one screen without scrolling.
- **Daily Reading Time & Telemetry** (`GET /api/kosync/stats`): derives discrete reading sessions from sequential progress updates with idle gap detection, calculating today, week, month, and all-time reading hours.
- **Reading Streaks**: tracks current active streaks (counting today or yesterday) and longest historical reading streaks.
- **365-Day Activity Heatmap**: renders daily activity levels (0–4), minutes read, and books covered per day in a fluid grid that scales to the viewport width (month labels, no horizontal scroll), showing the last 180 days on phones so each day stays a usable tap target and the full 365 days from the 640px breakpoint up.
- **Library Health**: computes real-time distribution across unread, currently reading, and finished volumes with a proportional distribution bar, flagging stale reads inactive for &gt; 30 days.
- **Yearly Reading Goals** (`GET /api/kosync/goal`, `POST /api/kosync/goal`): optional, strictly additive target books and hours configuration without acting as a blocker or gate. Rendered as one compact row (e.g. `12/24 books (50%) · 47h/120h (39%)`) with progress bars; **Edit Goal** expands an inline drawer to change targets.

### 3. OPDS Wireless Book Catalog (Manual Fallback)

Use this when your device cannot load an external plugin. The generated plugin above gives the same catalog with paging, ratings and reading progress already configured.

1. In KOReader, tap top menu → **Search icon (magnifying glass)** → **OPDS catalog**.
2. Tap **Add new catalog**.
3. Set Catalog Name to: `LightHouse Library` (or `Mac Mini Library`).
4. Enter Catalog URL:
   ```text
   http://opds.wavypremium.xyz/opds
   ```
   *(Encrypted TLS: `https://opds.wavypremium.xyz:8443/opds` | Local LAN: `http://192.168.31.15:8088/opds`)*
5. Tap **Connect** (no credentials required). Books can now be browsed, searched by title/author/series, and downloaded directly over Wi-Fi.

### 3. Joplin Highlight & Note Export (Wireless Obsidian Sync)

KOReader includes a native **Joplin** exporter that syncs your highlights, chapters, and notes wirelessly over Wi-Fi directly into Obsidian:
1. Open any book in KOReader → tap top of screen for menu bar.
2. Tap the **Tools (wrench icon)** tab → select **Export highlights**.
3. Tap **Choose formats and services** → check **Joplin** (and ensure Markdown formatting is enabled).
4. Tap **Set Joplin IP and port number**. KOReader's Joplin exporter is plain HTTP-only (LuaSocket `socket.http`; it cannot open TLS):
   - **Host (IP):** `192.168.31.15` *(primary LAN target)*
   - **Port:** `8086`
   - Optional WAN: Host `opds.wavypremium.xyz`, Port `80` (plain HTTP). The `?token=` query travels in cleartext and is written to proxy access logs.
5. Set `JOPLIN_TOKEN` in the uploader `.env` to a long random secret (for example `openssl rand -hex 24`). If it is unset or empty, Joplin writes are rejected. Enter that same private value in KOReader under **Set authorization token**. Do not commit or publish the token.
6. Tap **Export now** (or choose book) → **Export to Joplin**.
7. Highlights and notes are immediately written into your Obsidian vault at `<vault>/Books/<Title>.md` with clean YAML frontmatter, book synopsis, and idempotent markers (`<!-- lighthouse:highlights:start -->` / `<!-- lighthouse:highlights:end -->`). Generated attribution (chapters, page numbers, timestamps from KOReader, Obsidian, or Kindle) is deduplicated while preserving quote bytes, displayed attribution, and manual notes verbatim. Re-exporting never creates duplicates.

### 4. Kindle Wi-Fi Proxy Gateway (GFW / DPI Bypass)

If your Kindle displays *"Check your network connection"* when connecting to overseas servers:
1. On Kindle: Go to **Settings** → **Wi-Fi Networks** → select your Wi-Fi network → tap **Advanced**.
2. Configure **HTTP Proxy**:
   - **Proxy Host:** `192.168.31.15`
   - **Proxy Port:** `7890`
3. Save network settings. All Kindle network requests will now route through the home host's sing-box proxy gateway.

### 5. Telegram Mini App & Web App Access

LightHouse provides an app-like catalog experience across mobile devices and desktop browsers:
- **Singapore WAN Web App (Low-Latency Port 8443):**
  ```text
  https://reading-sg.wavypremium.xyz:8443
  ```
- **Global Caddy Edge:**
  ```text
  https://reading.wavypremium.xyz
  ```
- **Telegram Native Mini App:** Tap the persistent **Menu** button or send `/app` inside `@saroat_ospeto_bot` to open the full catalog interface inside Telegram with native haptics.

---

## 📝 Automated KOReader & Kindle to Obsidian Highlight Sync

LightHouse bridges your reading devices (KOReader on Kobo/Kindle/Android, native Kindle clippings, and KOSync progress) directly into your Obsidian second brain:

1. **Structured Note Generation:**
   - Notes are written to `<vault>/Books/<Sanitized_Title>.md` (default vault: `OBSIDIAN_VAULT_PATH` or `~/Obsidian`).
   - Every note is generated with rich YAML frontmatter:
     ```yaml
     ---
     title: "Atomic Habits: An Easy & Proven Way to Build Good Habits & Break Bad Ones"
     author: "James Clear"
     series: ""
     progress: 65
     status: reading
     tags:
       - book-notes
       - lighthouse
       - reading
     date_synced: 2026-09-23T01:23:45.000Z
     ---
     ```
   - Formatted book synopsis extracted from Calibre library comments.
   - Dynamic reading progress bar (`**Progress:** 65% [█████░░░]`) and last read timestamp from KOSync (`koreader-sync.db`).

2. **Idempotent Preservation Guarantee:**
   - Highlights and captured notes are bounded by marker comments:
     ```markdown
     ## Highlights & Notes
     <!-- lighthouse:highlights:start -->
     > Desire is the difference between where you are now and where you want to be in the future.
     — *Chapter 10*, Page 189 • 2025-01-30 16:52:58
     **Note:** Fundamental motive behind habits.
     <!-- lighthouse:highlights:end -->
     ```
   - On repeated syncs, only the block inside the markers is updated; any manual user reflections, synthesis notes, or custom frontmatter properties outside the markers are 100% preserved.

3. **Four Seamless Synchronization Pathways:**
   - **Native KOReader Joplin Clipper Exporter (`POST /notes`, `PUT /notes/:id`):** One-tap wireless sync built directly into KOReader. The plugin is plain HTTP-only. Point it at LAN `http://192.168.31.15:8086` (primary) and the private `JOPLIN_TOKEN` from `.env`. Optional WAN is plain HTTP port `80` on `opds.wavypremium.xyz`; `?token=` is cleartext and lands in proxy access logs. Do not publish the token. The server implements native Joplin Clipper HTTP compatibility (`/ping`, `/folders`, `/notes`), writes structured Markdown notes with block-style YAML tags to `<vault>/Books/<Title>.md`, and merges highlights idempotently. Unset tokens fail closed.
   - **Wireless Over-The-Air Ingest (`POST /api/highlights/sync`):** Configure KOReader's bundled **Export highlights** plugin to send JSON/Markdown exports directly to `http://192.168.31.15:8086/api/highlights/sync` on LAN or `https://reading-sg.wavypremium.xyz:8443/api/highlights/sync` on WAN.
   - **Type-C Kindle USB Two-Way Sync (`bin/lighthouse sync-kindle`):** Two-way USB-C sync between Calibre, Kindle, and Obsidian. Auto-detects Kindle or e-Reader under `/Volumes/`, pushes active/reading/unread books from Calibre into `books/` (fallback to `documents/`) with FAT32 filename sanitization and 50MB free-space safety bounds, checking existing files across both directories to avoid re-copying, and pulls clippings & KOReader `.sdr` highlights into the MAS Obsidian vault (`/Users/ospeto/MAS/03-Resources/Books/<Title>.md`) and indexes them into `cache.db` (`book_highlights`). Supports `--apply`, `--dry-run`, `--all`, and `--eject`.
   - **CLI Batch & Continuous Watch (`bin/lighthouse sync-obsidian`):** Auto-discovers connected Kindle / KOReader storage mounts (`/Volumes/*/`) and sidecar `.sdr` folders (`metadata.epub.lua`), merging with live KOSync databases. Pass `--watch` for continuous auto-syncing.

4. **USB-C Kindle Bulk Sync Workflow:**
   - **Automatic Local Mount Detection:** Automatically discovers connected Kindle e-readers mounted at `/Volumes/Kindle`, `/Volumes/KINDLE`, or any `/Volumes/*` volume containing a `books` or `documents` folder (preferring `books/`).
   - **Recursive Deep Duplicate Detection & Index Normalization:** Builds an in-memory recursive index of all book files across both `books/` and `documents/` (including all nested subdirectories like `<author>/<title>`, `<series>/...`). Strips leading index numbers (`01 - `, `Vol. 1 - `) during Kindle index creation, normalizes author strings with consistent comma spacing (`Author, Artist` vs `Author,Artist`), and reuses existing Kindle author and series directories over creating new comma-variant duplicate folders. Duplicate detection implements a two-tier engine: Tier 1 fast deterministic matching (<5ms) with cross-script Burmese Unicode author exemption (`[\u1000-\u109F]` matching Latin transliterated author folders on disk like `Mya Than Tint` vs `မြသန်းတင့်` to prevent duplicate copies), fallback byte size (identical or within ±4KB) + volume and title token matching, and Tier 2 Jev System-1 ambiguity arbitration querying `classifyDuplicateWithJev` when partial title similarity is in `[0.65, 0.88)` in the same author folder, failing open gracefully. Transfers automatically execute `dot_clean -m` (with fallback unlinking) after any file operations so macOS never leaves `._*` resource fork ghost files on the Kindle. Matches candidates across exact filenames, base filenames (format-insensitive: `.epub`, `.azw3`, `.kfx`, `.mobi`, `.pdf`), normalized titles, clean queries, compound and inverted author-title strings, and token sets. Already-present books are safely skipped without redundant re-transfers.
   - **On-Device Duplicate Scanner & One-Click Pruner:** Detects redundant duplicate book copies already lingering on Kindle storage (from past manual copies or different folder naming). Supports two-tier scanning with TypeSafe Jev System-1 arbitration (`scanKindleDeviceDuplicatesAsync`, `cleanKindleDeviceDuplicatesAsync`, `classifyKindleDeviceDuplicateWithJev`) to resolve Zawgyi vs Myanmar Unicode codepoint mismatches, English transliterations vs Myanmar script authors, and light novel subtitle/volume variations. `GET /api/kindle/status` reports `deviceDuplicatesCount`. If duplicates are detected, `#kindleModal` presents an Apple Material notice (`⚠️ Found X duplicate files on device [Remove Duplicates]`) triggering `POST /api/kindle/clean-device-duplicates` (accepts `{ useJev: boolean }`) to safely prune redundant files, clean orphan `.sdr` sidecars, and prune empty folders while strictly preserving the canonical copy. Also runnable via CLI: `bin/lighthouse sync-kindle --clean-duplicates [--jev]` (preview in dry-run with `--dry-run`).
   - **Asynchronous Non-Blocking Transfer Engine:** `POST /api/kindle/sync` performs fast atomic pre-flight validation (admit gate, device presence, storage check) and returns `{ success: true, started: true }` immediately in milliseconds, completely eliminating 60s gateway timeouts (`Failed to fetch`) over reverse proxies and SSH tunnels on large collections. File copying and highlight indexing run safely in the background protected by atomic in-process lock semantics (`tryAcquireKindleSyncLock()`), while the frontend polling loop (`/api/kindle/status` every 350ms) tracks live progress, byte counts, and completion summaries with watchdog guards.
   - **Pre-Flight Total Storage Verification:** Calculates the sum of file sizes for all pending (non-skipped) book candidates before beginning transfers. Halts upfront with an explicit error if required space exceeds available Kindle storage (including a 50MB safety reserve), preventing partial transfers that leave the Kindle full.
   - **Per-Book Space Pre-Check:** Re-verifies available storage before copying each individual book, halting gracefully with clear stats if space is exhausted mid-sync.
   - **Instant Sync Cancellation ("Stop Sync"):** Provides an immediate Stop Sync / Cancel capability (`POST /api/kindle/cancel`) in the web UI and sync engine, halting active transfers between books without corrupting files or requiring cable disconnection.
   - **Scope Selection (Active & Unread vs All Books):** Choice between syncing active and unread books (default: currently reading in KOSync or tagged reading/to-read) versus complete library synchronization.
   - **FAT32 Filename Sanitization & File Size Bounds:** Enforces strictly valid FAT32 filenames, stripping illegal characters (`: * ? " < > | \ /`), trimming whitespace, and bounding lengths safely without filename collisions. Strictly enforces FAT32 filesystem bounds by validating candidate file sizes against the 4GB legal limit (maximum legal size: 4,294,967,295 bytes); files strictly exceeding 4,294,967,295 bytes are rejected in pre-flight checks across preview, single-book, and bulk sync, excluding rejected files from required storage calculations while allowing valid books in the batch to transfer unimpeded.
   - **Web UI & REST Endpoints:**
     - Auto-prompt pop-up banner when Kindle is detected over USB (`GET /api/kindle/status`) with pending transfer count and size preview.
     - Header status pill (`#kindleStatusBtn`) indicates connection status and free space.
     - Apple Fluid modal (`#kindleModal`) provides scope selection, storage preview, live real-time progress bar, high-contrast **"⏹️ Stop Sync"** button, and safe ejection.
     - Individual book modal includes contextual "Send to Kindle" for fast single-title transfers.
     - `GET /api/kindle/status`, `GET /api/kindle/preview`, `POST /api/kindle/sync`, `POST /api/kindle/cancel`, `POST /api/kindle/eject`, and `POST /api/books/:id/send-kindle`.
   - **Unified CLI Command (`bin/lighthouse sync-kindle`):** Two-way synchronization: push books, pull highlights to Obsidian & cache.db, check status, or safely eject (`--eject`) directly from terminal.

5. **LightHouse Web Highlights & Quotes Viewer:**
   - **In-Browser Quotes & Notes Browsing:** Synced book highlights and annotations are indexed into `cache.db` (`book_highlights` table) and accessible directly on the LightHouse web reader (`uploader/index.html`).
   - **Book Details Modal (`#bookDetailModal`):** Dedicated `✦ Highlights` tab renders elegant Apple Fluid translucent cards (`backdrop-filter: blur(20px) saturate(180%)`) with amber accent bars, chapter badges, page numbers, timestamps, notes, and a one-click copy button with tactile checkmark feedback.
   - **Book Cards & Desktop Hover Wing Panel (`.card-popup`):** Books with highlights display a subtle indicator badge (`✦ 12`) on the cover and quote preview snippets in the desktop hover popover.
   - **REST API Endpoints:**
     - `GET /api/books/:id/highlights`: Returns structured JSON list of quotes, chapters, page numbers, notes, and timestamps with on-demand Obsidian/SDR backfill.
     - `GET /api/highlights?title=...`: Query highlights by title or retrieve aggregate counts.
     - `GET /api/books`: Book list payload includes `highlightCount` and `highlightPreview` for instant UI rendering.

6. **Unified Annotation Store (single queryable owner for every highlight):**
   - `book_highlights` in `cache.db` is the one store KOReader, Kindle, the LightHouse web reader, and Obsidian note sync all write into (`uploader/annotation-store.ts`). Markdown parsing stays in the existing parsers (`uploader/highlights.ts`, `uploader/joplin.ts`); the store owns only storage, filtering, and reconciliation.
   - **Sources:** each row records the set of ingestion paths that currently report it (`koreader`, `kindle`, `web`, `obsidian`, and `legacy` for rows written before source tracking). A highlight reported by two paths is one row claimed by both.
   - **Color and style:** `color` is normalized to a name (`red`, `orange`, `yellow`, `green`, `cyan`, `blue`, `purple`, `pink`, `grey`) from KOReader's drawer token (`lighten#ffc000`) or a named color; `style` is `highlight`, `underline`, `strikethrough`, `invert`, `note`, or `bookmark`. Kindles' `Note`/`Highlight` clipping kinds map onto `style`.
   - **Filterable:** `GET /api/annotations?color=yellow&style=underline&source=koreader&q=spice&book_id=1&limit=250` returns matching annotations plus a `summary` of counts per color, style, and source.
   - **Exportable:** `GET /api/highlights/export?format=markdown|csv|json` (same filter parameters, optional `book_id`/`title`) returns a downloadable document and an `x-annotation-count` header. Markdown groups quotes by book; CSV is RFC 4180 with a spreadsheet formula-injection guard; JSON carries a `sources` array. Configured credentials (including `JOPLIN_TOKEN`) and `token=`/`api_key=`/`Bearer` shapes are redacted as `[redacted]` in every format.
   - **Web reader writes:** `POST /api/annotations` adds a highlight (defaults to the `web` source; an unknown source is rejected rather than invented), and `DELETE /api/annotations/:id` removes one from the store and therefore from every export.
   - **Deletion propagates by evidence, not assumption:** ingestion is snapshot-based. Writing a source's complete highlight list for a book retires every row that source no longer reports, and a row left with no owner at all is deleted. Because the Obsidian note, Markdown, CSV, and JSON all render the store rather than the last snapshot written, a highlight deleted at its source disappears from all of them. The Obsidian note keeps its path, frontmatter, `## Highlights & Notes` heading, and idempotent marker pair; only the managed region is regenerated.
   - **Where snapshots come from:** the KOReader `.sdr` sync (`bin/lighthouse sync-obsidian`) and the Kindle pull (`bin/lighthouse sync-kindle`) read a device's complete state and are therefore authoritative, retiring what the device dropped. Both opt into retiring pre-upgrade unattributed (`legacy`) rows. The Joplin clipper and the OTA `POST /api/highlights/sync` path ingest into the store additively, because a single push payload is not proof that a quote was deleted; their rows are retired by the next authoritative device sync.
   - **Manual note entries:** a quote added by hand inside the markers is claimed by the `obsidian` source so it survives, and removing it from the note removes it from the store. A note copy of a device quote is never adopted, so it cannot resurrect a deletion.
   - **Orphan cleanup:** `pruneLegacyAnnotations()` (exposed for maintenance) deletes rows no ingestion path claims.

---

## 🧠 Jev System-1 Ingestion Intelligence

LightHouse integrates [TypeSafe Jev System-1](https://api.typesafe.ai/v1/systemone) fast linguistic triage across all ingestion pathways (file uploads, archive extractions, and web article conversions):

1. **Junk Ingest Gate (`Books_Quarantine`):**
   - Protects the Calibre library against corrupt downloads, broken test artifacts, and truncated files.
   - Deterministic filters catch truncated ZIP artifacts missing central directories and auto-healed dummy files.
   - Suspicious candidates (e.g. titles with >60% digits, sample upload tokens, or missing authors with timestamp titles) undergo fast Jev System-1 triage (`real_book`, `test_artifact`, or `truncated_download`).
   - Non-book artifacts are automatically moved outside the Calibre auto-import queue into `~/Books_Quarantine` (`Books_Quarantine/`), ensuring library metadata remains pristine.
2. **Series & Volume Detection:**
   - Multi-pattern parsing extracts volume indices from standard numbering (`Vol 1`, `v2`, `#3`), Roman numerals (`Vol. IV`, `Book II`), written English numbers (`Volume One`, `Volume Two`), and Burmese volume markers (`အတွဲ ၁`).
   - When pattern regexes miss but candidate number tokens remain, `extractSeriesWithJev` invokes Jev System-1 classification (`series_volume` vs. `subtitle_same_book` vs. `unrelated`) requiring confidence `>= 0.7`.
   - Ingestion deduplication (`uploader/scraper.ts`, `uploader/bot.ts`, `uploader/server.ts`) isolates volume numbering so distinct volumes in a series are never merged, while invoking Jev System-1 arbitration (`isSameBookAsync`) for ambiguous title similarity scores (0.65–0.88). Read-side active identity validation verifies active Calibre presence and matches titles before triggering duplicate shortcuts, preventing deleted or reassigned book entries from blocking legitimate re-ingestion.
3. **Author Field Sanitization:**
   - Strips noisy release tags, pirate channel watermarks, and role annotations (e.g. `[Illustrator]`, `(Artist)`).
   - Resolves ambiguous multi-author orderings alphabetically for deterministic library deduplication and queries Jev when author identity is suspect.
4. **Bilingual & Multilingual Language Shelves:**
   - Automatically classifies and filters books into four dedicated shelves:
     - **All:** Entire reading library.
     - **Burmese (မြန်မာ):** Dedicated shelf for Burmese literature, detected via Calibre language tags (`my`, `mya`, `burmese`) and Myanmar Unicode range (`[\u1000-\u109F]`).
     - **English:** English books and international releases.
     - **Other:** Japanese light novels, manga, and foreign language editions.
5. **Intelligent Multi-Source Metadata & Cover Routing:**
   - Automatically determines book category and prioritizes specialized metadata engines:
     - **Light Novels & Web Novels:** Queries [RanobeDB API](https://ranobedb.org/api/v0), [AniList GraphQL API](https://graphql.anilist.co), and Bangumi first (with request pacing enforcing >= 700ms intervals and HTTP 429 `Retry-After` backoff protecting quotas), extracting rich plot summaries, series-level overviews for Korean web novels and light novels, high-resolution cover art, and staff metadata before falling back to Google Books.
     - **Manga:** Queries MangaDex API, AniList GraphQL API, and Bangumi.
     - **General Literature:** Queries Google Books and OpenLibrary.
     - **Burmese Literature:** Hardened source classification unconditionally routes any title containing Myanmar Unicode to `burmese` (even with Latin authors), bypassing overseas providers and applying localized typographic cover synthesis and Burmese font styling.

---

## 🔌 Pluggable Metadata Providers & Sidecar Protocol

Enrichment sources are **registered providers**, not hard-coded scraping. The registry (`uploader/metadata-providers.ts`) owns the provider contract, category routing, priority tie-breaking, and an HTTP sidecar protocol, so adding Douban, a RanobeDB mirror, or a private catalog is a **config change** rather than a code change.

1. **The first providers are the existing scrapers.** RanobeDB, AniList, Bangumi, Google Books, OpenLibrary, and MangaDex are registered as `builtin` providers, each declaring its `id`, `label`, `fields` (`title`, `authors`, `synopsis`, `cover`, `tags`, `series`, `volume`), served `categories`, and `priority`.
2. **Routing is data.** `DEFAULT_ROUTING_TABLE` maps each category (`light_novel`, `manga`, `general_book`, `other`, `burmese`) to ordered tiers of provider ids. Tiers run in order with per-provider failure isolation, and a tier short-circuits when its results are usable (any result for series queries; confidence `>= 0.85` **with a real synopsis** when resolving one volume). AniList is `seriesQueryOnly`, so it never answers a single-volume lookup.
3. **Priority breaks ties, not confidence.** Every built-in shares one priority (preserving historical insertion-order tie-breaking); a sidecar configured at `priority: 60` outranks a built-in on an equal-confidence tie, one at `40` defers to it. Providers absent from the routing table are still consulted as always-run sources, so registration alone plugs one in.
4. **Sidecars run beside the server.** A sidecar is any small HTTP service answering `GET /manifest` (optional), `GET /search?q=&category=&volume=&author=` and `GET /book/{id}` with JSON. Register it in `data/metadata-providers.json` (gitignored) or inline via `LIGHTHOUSE_METADATA_PROVIDERS`; `LIGHTHOUSE_METADATA_PROVIDERS_OFF=1` disables them. Timeouts, connection refusals, non-2xx responses, and malformed payloads degrade to an empty result for that provider only.
5. **Security.** Sidecar endpoints are operator config, never user input, and are passed to the SSRF guard as an exact `host:port` allowlist (`allowedSidecarEndpoints`) that must still resolve to loopback/private addresses. All sidecar traffic flows through `safeFetchWithSsrf`, the single outbound fetch entry point.
6. **Overwrite protection is unchanged for every provider.** Volume conflicts still demote candidates to confidence `0`, a numbered volume still keeps its title when the candidate volume differs or is missing, and an existing cover is never replaced across a volume mismatch (`resolveOverwriteGuards` is the single source of truth, shared by all provider paths).

```bash
# Inspect the live registry, capability flags, and routing table
curl -s http://192.168.31.15:8086/api/metadata/providers | jq '.providers[] | {id, kind, priority}'
```

Full interface reference, sidecar protocol details, and configuration precedence: [`docs/metadata-providers.md`](docs/metadata-providers.md). A copyable starting point lives in [`docs/metadata-providers.example.json`](docs/metadata-providers.example.json).

---

## 📚 Lnori & Elscione Light Novel Ingestion Pipeline

LightHouse features end-to-end automated light novel series and volume ingestion from [Lnori](https://lnori.com) and [Elscione](https://server.elscione.com) across both the **Web UI** and the **Telegram Bot**:

1. **Dual Ingestion Surfaces:**
   - **LightHouse Web UI:** Click **Upload Books** &rarr; **Add Light Novel** (or paste an `lnori.com` or `server.elscione.com` link into the web article ingestion modal to auto-switch). The dedicated Apple fluid modal accepts series folder URLs (e.g. `https://server.elscione.com/Officially%20Translated%20Light%20Novels/Grimgar%20of%20Fantasy%20and%20Ash/` or `https://lnori.com/series/...`) and individual volume URLs (`https://server.elscione.com/.../Volume%2001.epub` or `https://lnori.com/book/...`). URLs pasted with raw spaces, unencoded quotes, or missing `https://` protocol prefixes are automatically normalized.
   - **Telegram Ingestion Bot:** Paste any `lnori.com/series/...` or `lnori.com/book/...` URL directly into chat with `@saroat_ospeto_bot`. Links automatically submit to the centralized Uploader server queue (`POST /api/lnori/ingest`), reporting real-time queue position (`⏳ Queued Light Novel Series (Position #N of M)`), streaming volume progress upon activation via SSE/polling, delivering formatted completion cards with 1-tap "Open Reading HQ" Web App links, and falling back gracefully to an in-process queue/mutex if the local uploader server is offline. URLs from `server.elscione.com` (`/Officially%20Translated%20Light%20Novels/...`) are also fully supported with Anubis PoW challenge solving. Conversational links with raw spaces in paths (e.g. `server.elscione.com/Officially Translated Light Novels/A Sister's All You Need/`) are automatically recognized, normalized with `%20`, and parsed as light novels rather than articles.
   - **REST API (`POST /api/elscione/ingest`, `POST /api/lnori/ingest`, `POST /api/novel/ingest`):** Accepts `{ url: string, stream?: boolean }`, validates target with SSRF and origin guards, runs an asynchronous FIFO queue supporting sequential processing across concurrent requests without 409 rejections, runs an autonomous decoupled server background task resilient against client disconnections, supports live Server-Sent Events (`text/event-stream`) and NDJSON streaming progress updates, exposes live status and queue state (`queueLength`, `queuedItems`, `currentQueuePosition`) via `GET /api/lnori/progress` / `GET /api/elscione/progress`, and supports explicit cancellation via `POST /api/lnori/cancel` / `POST /api/elscione/cancel` (by `runId` or active job).
2. **Anubis Proof-of-Work Challenge Solver (Elscione):**
   - Automatically intercepts Anubis challenge HTML pages (`<script id="anubis_challenge" type="application/json">`) on `server.elscione.com`.
   - Computes SHA-256 hash `h = sha256(randomData + nonce)` until the target `difficulty` leading zero half-bytes are satisfied.
   - Submits the solution to `/.within.website/x/cmd/anubis/api/pass-challenge` and caches authorized session cookies (`PHPSESSID`, `anubis-auth`, `download_token`) to transparently authenticate subsequent folder requests and volume downloads.
3. **_h5ai Directory API & Manifest Extraction:**
   - For series folder URLs on `server.elscione.com`, sends authenticated POST requests with `{"action": "get", "items": {"href": folderPath, "what": 1}}`.
   - Filters `.epub` volumes and sorts them numerically by extracted volume index (Volume 1, Volume 2, Volume 10) instead of lexicographical ordering.
   - For direct `.epub` file links, treats the URL as an immediate 1-volume manifest.
   - For `lnori.com`, parses LD+JSON metadata and HTML schemas to extract series title, author, genres, and volume endpoints.
4. **Pre-Download Duplicate Prevention:**
   - Before downloading multi-megabyte EPUB binaries, queries Calibre's database via series name and volume index or book title. Existing volumes are skipped, preventing wasted bandwidth and duplicate library entries.
5. **Resilient Downloader & In-Process ZIP Auto-Healing:**
   - Downloads EPUB files with exponential retry backoff and proxy routing (`http://127.0.0.1:7890`).
   - If an EPUB is missing its Central Directory or End-of-Central-Directory (EOCD) signature, `repairTruncatedEpub` automatically repairs the container in-process.
6. **High-Resolution Cover Extraction & Conversion:**
   - Extracts embedded cover art from internal EPUB container metadata or downloads master covers from `cdn.lnori.com`.
   - Converts covers to standard formats using macOS `sips` for seamless Calibre and e-reader compatibility.
7. **Automatic Calibre & Catalog Refresh:**
   - Ingests into Calibre with standardized series indexing (`<Series>: Volume <N>`), applies metadata tags, and flushes cache to immediately reflect new books in KOReader OPDS and the web catalog.

---

## 📖 FanFicFare Web Novel Ingestion Pipeline

LightHouse integrates FanFicFare for downloading and updating web serials and fanfiction directly into Calibre:

1. **Supported Story Sources:**
   - RoyalRoad, Archive of Our Own (AO3), ScribbleHub, FanFiction.net, FictionPress, Wattpad, SpaceBattles, Sufficient Velocity, Questionable Questing, and all platforms supported by FanFicFare.
2. **Single-Command CLI (`bin/lighthouse ingest-novel`):**
   - Syntax: `bin/lighthouse ingest-novel <url> [options]` (or alias `bin/lighthouse webnovel <url> [options]`).
   - `--update`: Detects existing novel in Calibre, fetches newly released chapters via FanFicFare, and updates the EPUB format and metadata in Calibre.
   - `--tags <tags>`: Attaches custom tags while always preserving `webnovel`.
   - `--dry-run`: Probes story metadata via `fanficfare --meta-only --json-meta --no-output` without downloading or modifying Calibre.
3. **Fail-Closed Verification & Staging Isolation:**
   - Verifies `fanficfare` presence and fails closed with clear diagnostic instructions if missing.
   - Runs downloads in temporary isolated staging directories, validating EPUB containers and extracting cover art via `sips` before adding to Calibre with `--automerge ignore`.

---

## Discover Shelf (Trending & New Releases)

LightHouse features an Apple-aesthetic **Discover Shelf** across both the **Web UI** and the **Telegram Mini App** for effortless exploration and 1-click downloads of top Light Novels and Web Novels:

1. **VisionOS Capsule Navigation:**
   - Dedicated `Discover` tab seamlessly integrated into the floating island capsule alongside `All Volumes` and `Reading`.
   - Distinctive warm amber/gold aesthetic with tactile active touch response (`:active { transform: scale(0.96); }`).
2. **Strictly Segregated Feeds:**
   - Top segmented pill toggle: `[ Trending ]` vs `[ New Releases ]`.
   - Feeds are strictly kept separate and never mashed together into a combined list.
3. **Real Download Sources Guarantee:**
   - Every discovered novel is strictly anchored to real, existing series from Elscione or Lnori (indexed directly against 1200+ Elscione folders and 880+ Lnori series).
   - Eliminates synthetic URL fabrication (preventing 403 errors).
   - AniList media entries are included only if verified to exist on Elscione or Lnori.
   - When available on both sources, Elscione is automatically preferred as the primary download source (`primarySource = "elscione"`).
4. **Complete Engaging Synopses:**
   - Every novel in the feed is guaranteed to have a complete, readable synopsis (never blank or missing), enriched via curated catalogs and genre-aware synthesis.
5. **Interactive Multi-Facet Filtering Bar:**
   - **Source Filter:** `[ All Sources ]`, `[ Lnori ]`, `[ Elsci.one ]`.
   - **Genre Filter:** Horizontal scrollable pills (`All`, `Fantasy`, `Isekai`, `Romance`, `Sci-Fi`, `Action`, `Psychological`, `Comedy`, `Mystery`, `Drama`, `Slice of Life`, `Adventure`).
   - **Library Status Filter:** `[ All ]`, `[ Ready to Download ]`, `[ In Library ]`.
   - **Live Search:** Instant responsive filtering across English titles, Romaji titles, authors, and genres.
   - **Sorting:** `Most Popular`, `Highest Rated`, `Newest`.
6. **Prominent Card-Level Volume Visibility & Verified Source Inventory Reconciliation:**
   - **Separation of Global Catalog Totals from Verified Source Inventories:** Global publication/catalog totals (`CATALOG_VOLUMES` or AniList metadata, e.g. 22 for Date A Live) are strictly separated from verified source inventories (Elsci.one folder manifests, Lnori series manifests).
   - **Verified Downloadable Missing Volumes:** Missing volumes are computed strictly as `verified source volume identities` MINUS `owned Calibre volume identities`. Never manufactures synthetic `1..N` gaps beyond verified source holdings. For series like Date A Live where the library holds all 16 available source volumes, the missing count is 0, the status badge shows `All in Library (16/16)`, and `Download Remaining` is disabled while displaying `All Volumes in Library (16/16)`.
   - **Source Cards with Verified Availability:** Modal source cards display exact verified volume availability (e.g. `Elsci.one • 16 vols available`, `Lnori • 15 vols available`) or an explicit unverified indicator (`vols (unverified)` / `Source offline`) rather than global publication catalog maximums.
   - **Max-Coverage Missing-Volume Source Selection:** Automatically selects the source that contains the highest number of missing volumes when partial series downloads are requested, avoiding gaps left by greedy first-match selection when one source covers more missing volumes than another.
   - **Resilient Source Inventory Verification:** Allows folders with unnumbered bonus or special files (e.g. `Special Story.epub`) to retain all verified numeric volumes rather than demoting the entire inventory to unverified.
   - **Hardened Volume Number Extraction Regexes:** Pre-strips digital edition revision tags (e.g. `[vX.X]`, `[v2.0]`) so revisions do not hijack volume numbers, supports bare Roman numerals (`Overlord VI`, `VII`, `VIII`, `Gosick VI`), Volume 0 prequels (`Jujutsu Kaisen 0`), and fractional volumes (`4.5`).
   - **AniList Ongoing Series Null-Volume Handling:** Resolves ongoing light novels from AniList (`volumes: null`) against verified library owned count, available source inventory, or catalog seeds rather than clamping to 1 volume.
   - **Safe Graceful Fallbacks:** Unverified or failed sources gracefully retain catalog publication totals without assuming zero availability or falsely claiming all volumes are owned.
   - **In-Memory & SQLite Cache:** Verified source volume inventories are cached with 24-hour TTL and concurrent in-flight request deduplication.
   - **High-Precision Title-First Volume Extraction & Multi-Part Resolution:** Prioritizes explicit volume numbers parsed from book titles (`extractVolumeNumber(b.book.title)`) over fractional Calibre `series_index` while preserving fractional volumes (e.g. 4.5, 7.5), canonical multi-part calculations (Bookworm `Part X Volume Y`), and spinoff isolation.
   - Prominent volume count indicators displayed directly on cards without opening the modal:
     - Card status badge: `In Library (${libCount} vols)` when series is owned in Calibre (or `In Library (${libCount}/${totalVols} vols)` when partially owned), or `Available (${totalVols} vols)` when available to ingest.
     - Card metadata row and cover badge: dedicated volume badge (`${totalVols} vols`) strictly bound to computed total volumes alongside source tags and ratings.
     - Novel preview modal (`#discoverModal`): displays true total volumes (`${totalVols} Volumes`) reconciled with verified source availability and local Calibre volumes.
7. **1-Click Direct Ingestion, Persistent Downloads & Live Progress (`POST /api/discover/ingest`):**
   - 1-tap download from card or modal enqueues background ingestion into Calibre.
   - Real-time live download progress tracked via `GET /api/discover/progress/:jobId` with active download state persistently tracked in browser `localStorage` (`discover_active_downloads`).
   - Active downloads automatically resume polling and live progress bars across page refreshes, tab closures, and navigation without losing progress or allowing duplicate download submissions.
   - Cross-tab active job synchronization via `GET /api/discover/jobs/active` discovering in-flight jobs started from other tabs or devices.
   - Resilient polling without arbitrary timeout cutoffs, featuring exponential backoff and subtle reconnection feedback upon transient network interruptions.
   - Developer endpoints: `GET /api/discover/feed?tab=trending|new_releases`, `GET /api/discover/catalog`, `POST /api/discover/ingest`, `GET /api/discover/progress/:jobId`, and `GET /api/discover/jobs/active`.
   - Optimized with in-memory Calibre matching index reuse and signature invalidation, cooperative event-loop yielding every 200 items on catalog-wide status scans, HTTP response compression (Gzip/Deflate), and 24-hour cover caching.
   - Strictly zero emojis across all backend responses and logs.

---

## Apple WWDC Fluid Interface Design System

The LightHouse web interface (`uploader/index.html`) is built according to Apple WWDC fluid interface design principles:

1. **Materials & Translucency:**
   - Multi-tier dark translucent glass surfaces including modals and sheet panels (`apple-material-modal`, `apple-material-sheet`) utilizing `backdrop-filter: blur(20px) saturate(180%)`, and action overlay glass (`apple-material-glass-light`) utilizing `backdrop-filter: blur(12px) saturate(150%)`.
   - Subtle top-edge light catch highlight (`border-top: 1px solid rgba(255, 255, 255, 0.12)`) and strict material weight hierarchy without blur stacking.
2. **Optical Typography & Display Hierarchy:**
   - Native Apple system font stack (`SF Pro Display`, `SF Pro Text`, `-apple-system`).
   - Size-dependent optical tracking (`.tracking-optical-display` at `-0.02em` with tight leading on display titles, `.tracking-optical-micro` at `0.025em` on micro-labels/tags/pills, `0` on body text).
3. **Tactile Feedback & Immediate Response:**
   - Zero tap delay (`-webkit-tap-highlight-color: transparent`).
   - Instant pointer-down active press state (`scale(0.97) !important` with `120ms cubic-bezier(0.2, 0, 0, 1)` physics).
   - Seamless Telegram WebApp HapticFeedback integration (`tgHaptic.light()`, `tgHaptic.selection()`).
4. **Fluid Springs & Spatial Motion:**
   - Critically damped physics-based easing (`cubic-bezier(0.16, 1, 0.3, 1)` ~`0.35s`).
   - Symmetric spatial transitions (bottom sheets slideUp/slideDown, modals scaleIn/scaleOut, drawers slideLeft/slideRight).
5. **Desktop Hover Synopsis Preview & Quick Actions:**
   - Hovering over any book card on desktop smoothly scales down the cover artwork (`transform: scale(0.85)`) and triggers a card-anchored horizontal wing expansion (`min-width: 480px`).
   - Styled with ambient blurred cover glow (`filter: blur(40px) saturate(1.4)` via `var(--popup-bg-image)`), Apple-grade dark frosted glass (`background: rgba(24, 24, 27, 0.92); backdrop-filter: blur(20px)`), bold editorial title, volume subtitle, 6-line clamped synopsis, category and language tag pills, and instant one-click EPUB download, Obsidian export, metadata editing, and book deletion.
   - Built-in smart screen-edge detection dynamically expands rightward (`.popup-left`) or leftward (`.popup-right`) to prevent viewport clipping with zero mouse-leave jitter.
6. **3D Skeuomorphic Depth & Accessibility:**
   - 3D book spine curvature overlay (`.book-spine-effect`), multi-layer shadows (`.shadow-book`, `.shadow-book-hover`), and skeleton shimmer loading states.
   - Comprehensive accessibility support respecting `prefers-reduced-motion` (instant 150ms opacity fades, scale suppression) and `prefers-reduced-transparency` (solid opaque dark surfaces).
7. **Full-Width Responsive Grid & Unified Filter Sheet:**
   - Permanent left sidebar filtering panel is completely removed in favor of an expansive, edge-to-edge full-width book card grid that smoothly adapts from mobile (2 columns), tablet (3-4 columns), desktop (5-6 columns), to ultra-wide viewports (7 columns).
   - Comprehensive library facet filtering (full Collections/Series, Authors, Tags, Reading Status, Formats, and Sort Order) is centralized into an Apple Fluid translucent slide-over sheet (`backdrop-filter: blur(20px) saturate(180%)`), while top category chips and content header sort select remain available for instant shortcuts.
   - Accessible via the visionOS floating capsule `Filters` button featuring an active filter pill badge with live filter count, subtle top-edge light highlights (`border-top: 1px solid rgba(255, 255, 255, 0.15)`), and quick dismissal via dismiss button, outside backdrop click, or the Escape key.
8. **visionOS Floating Island Capsule Navigation & Harmonized Header (Proposal 1 with Muted Pastel Tones):**
   - Centered, suspended Apple visionOS / iOS 18 translucent glass capsule (`bg-zinc-900/80 backdrop-blur-2xl border border-white/10 shadow-2xl rounded-full p-1.5`) harmonized across the entire 3-row header.
   - **Row 1 (Brand & Actions):** Sleek LightHouse logo with muted warm gold pastel accent (`bg-amber-400/10 border border-amber-400/25 text-amber-300`), Apple frosted glass `+ Add` button (`rounded-full bg-white/15 hover:bg-white/20 border border-white/20 text-white font-semibold text-xs shadow-sm`) replacing harsh solid opaque white, dedicated `+ Link` quick article ingestion pill (`rounded-full bg-white/10 hover:bg-white/15 border border-white/15 text-white`) with global clipboard URL paste shortcut, muted pastel amber USB `Kindle` pill (`rounded-full bg-amber-400/10 border-amber-400/25 text-amber-300`), and frosted glass `Guide` button (`rounded-full bg-white/5 border-white/10 text-zinc-300`). Duplicate `Filters` button removed from Row 1 so the visionOS capsule in Row 3 serves as the clean, single filter trigger.
   - **Row 2 (Search Bar):** Smooth organic rounded pill (`rounded-full`) matching visionOS glass tokens (`bg-zinc-900/80 border border-white/10 backdrop-blur-xl shadow-inner text-sm sm:text-base`) with comfortable 48px height (`h-[48px]`), proportional iconography, and generous touch ergonomics for mobile and balanced visual proportion on desktop.
   - **Row 3 (visionOS Floating Island Capsule with Muted Pastel Accent Palettes):**
     * Muted Warm Amber / Gold for All Volumes (`.visionos-tab-all.visionos-tab-active`).
     * Muted Pastel Mint / Sage for Reading status with pulsing emerald indicator (`text-emerald-300 bg-emerald-500/15 border-emerald-400/30`).
     * Muted Pastel Lavender / Periwinkle for Light Novels (`text-indigo-300 bg-indigo-500/15 border-indigo-400/30`).
     * Muted Pastel Rose / Coral for Burmese literature (`text-rose-300 bg-rose-500/15 border-rose-400/30`).
     * Muted Sky / Ice Blue for Series (`.visionos-tab-series.visionos-tab-active`).
   - Structured tabs & badges: `All Volumes` (with formatted locale count badge, e.g. `1,297`), `Series`, `Reading` (with live pulsing emerald indicator and active reading count), subtle vertical divider (`h-4 w-px bg-white/10`), primary categories (`Light Novels`, `Burmese`), and an integrated 1-tap `Filters` trigger button with live active badge.
   - Tactile Apple Fluid press response (`:active { transform: scale(0.96); }`), smooth cubic-bezier transitions, immediate pointer active feedback, full keyboard focus rings (`:focus-visible`), ARIA tabs/accessibility markup, and responsive mobile & Telegram Mini App centering with smooth horizontal swipe adaptation without scrollbars. Secondary facets (Recently Added, EPUB, individual series, and formats) are cleanly managed inside the translucent Filter sheet.

---

## 📚 Canonical EPUB-Only Collection Policy

LightHouse standardizes on **EPUB-only** for its canonical reading collection:

1. **Format Enforcement:**
   - Ingestion strictly accepts `.epub` files (and `.zip` / `.7z` archives containing `.epub` files).
   - Non-canonical eBook formats (`.pdf`, `.mobi`, `.azw3`, `.cbz`, etc.) are automatically rejected or quarantined with descriptive notifications.
   - Web article extractions compile directly into clean, serif-styled `.epub` containers with embedded typographic covers.
2. **Storage Path Immutability:**
   - Physical Calibre library directory structures (`Author/Title (id)/Title - Author.epub`) are immutable and never renamed by hand.
   - User downloads and Telegram file deliveries dynamically derive sanitized, human-friendly filenames (`Title - Author.epub` or `Series 01 - Title - Author.epub`) via RFC 5987 / RFC 6266 `Content-Disposition` headers.

---

## 🔒 Security, SSRF & Edge Hardening

The LightHouse WAN edge (`https://reading.wavypremium.xyz`) is hardened against unauthorized mutations and network attacks while keeping local LAN access completely friction-free:

1. **WAN vs LAN Authentication:**
   - **Local LAN Requests:** Home network requests (`192.168.x.x`, `127.0.0.1`, `10.x.x.x`) pass with zero friction.
   - **WAN Reverse-Tunnel Requests:** Mutating endpoints (`POST`, `PUT`, `DELETE`) require either a Bearer token or `X-API-Key` matching `READING_API_KEY`, cryptographically verified Telegram WebApp `initData` HMAC-SHA256 credentials, or session cookies (`reading_token`).
   - **Scoped API Keys (least privilege):** `READING_SCOPED_KEYS` configures additional named keys with limited scopes, so a monitoring or sync credential can read without being able to mutate:
     - Format (compact): `name=secret:scopes` entries separated by `;` or newlines, e.g. `koreader-sync=ro-secret:read;ci-writer=rw-secret:write`. JSON is also accepted: `{"ci":{"key":"ro-secret","scopes":["read"]}}`.
     - Scopes: `read` < `write` < `admin`. `write` implies `read`; `admin` is only needed for host-wide routes (`/api/backup`, `/api/ssd`, `/api/system`, `/api/daemon`, `/api/admin`). Resource-qualified scopes such as `books:read` or `kosync:write` confine a key to one API resource.
     - Enforcement: a read-only key is accepted on read endpoints (`GET /api/books`, `/api/annotations`, `/api/kosync/*`, OPDS) and refused with **HTTP 403** (`code: "insufficient_scope"`, plus `requiredScope`) on uploads, ingestions, updates, and deletes. An unknown or revoked key gets **HTTP 401**. One exception: `GET /api/koplugin/download` refuses every scoped key with `403 insufficient_scope`, because the generated plugin archive embeds the global key (see the KOReader plugin section).
     - Backward compatibility: `READING_API_KEY` still grants full access (`*`), so existing WAN clients, KOReader plugins, and integrations keep working unchanged. Never reuse the global key as a scoped key — the global key always wins and grants full access.
     - Transports: `Authorization: Bearer <key>`, `X-API-Key: <key>`, or a session cookie. `/api/auth/session` is treated as a read-level probe, and it never mints a session cookie carrying the global key for a scoped key holder.
     - Scope enforcement applies to the WAN edge; local LAN requests stay friction-free.
   - **Query-String Credential Rejection:** Query-string `token`/`auth` parameters are strictly rejected to prevent secret leakage via browser history, server access logs, and `Referer` headers.
   - **Public Read Access:** Read-only library views (`GET /api/books`), book covers, and OPDS feeds remain accessible on WAN for authorized reader devices without credentials.
2. **SSRF (Server-Side Request Forgery) Protection:**
   - Outbound network requests (URL article ingestion, cover art downloads, external metadata scraping) strictly block internal IP ranges:
     - Loopback (`127.0.0.0/8`, `::1`)
     - RFC 1918 private subnets (`10.0.0.0/8`, `172.16.0.0/12`, `192.168.0.0/16`)
     - Cloud metadata & link-local (`169.254.0.0/16`, `169.254.169.254`)
     - Decimal, hex, and octal IP representations, IPv6 multicast/reserved ranges, and local hostnames (`localhost`, `*.internal`, `*.lan`)
   - Every DNS A and AAAA record is validated before socket creation; redirect hops reconnect through pinned connectors using the original hostname for SNI/Host semantics so DNS is never re-resolved.
3. **CORS & CSRF Origin Protection:**
   - CORS is locked down to allowed origins: `https://reading.wavypremium.xyz`, Singapore endpoints, local LAN origins, and custom entries in `ALLOWED_ORIGINS`.
   - Mutating routes validate `Origin`, `Referer`, and `Sec-Fetch-Site` headers to reject cross-site forgery attempts.
4. **Decompression & Resource Protections:**
   - 100 MB maximum upload payload limit.
   - Archive extraction limits: max 500 entries, 150 MB single file, 500 MB total uncompressed, and 100:1 compression ratio limit to prevent zip/tar bombs. Path traversal `/..` guards reject archive escape sequences.
5. **Credential Hygiene:**
   - No secret ships as a hardcoded default. `KOSYNC_PASSWORD_SALT` has no fallback anywhere in this repository: `docker-compose.yml` refuses to start while it is unset or empty, and `.env.example` ships it empty so the compose recipe's documented steps fail closed. Generate your own (`openssl rand -hex 24`) - unless you are restoring an existing `koreader-sync.db`, which only works with the salt that database was hashed with.
   - Changing `KOSYNC_PASSWORD_SALT` invalidates every existing password hash in `koreader-sync.db`, so rotate it deliberately and reset user passwords afterwards.
   - A Telegram bot token, a KOSync password salt, and a KOSync `X-Auth-Key` were committed earlier in this repository's history. Git history stays readable once the repository is public, so treat all three as compromised: the bot token was rotated and verified revoked out-of-band, the salt is no longer disclosed at `HEAD` but is still the live production salt (exposure accepted, not rotated), and the `X-Auth-Key` may still be valid until user `moe`'s password changes (operator to confirm). See the Security Notice at the top of [`RUNBOOK.md`](RUNBOOK.md).

---

## ⚡ Durable Ingestion Job Queue (`cache.db`)

Background tasks and asynchronous workflows run via a durable SQLite job queue (`jobs` table in `cache.db`):

1. **Job Types:**
   - `file_ingest`: Single book file ingestion into Calibre with format validation and deduplication.
   - `archive_extract`: Safe extraction of archive packages, importing canonical EPUB files.
   - `url_article_ingest`: Web article extraction, conversion to EPUB, and Calibre ingestion.
   - `text_article_ingest`: Raw text and markdown paste ingestion with typographic cover and Calibre EPUB generation.
   - `metadata_enrich`: Background metadata and cover art scraping for newly imported books with volume conflict guards and title/cover overwrite protection.
   - `cover_backfill`: Batch generation of typographic covers for web articles lacking covers.
2. **Resilience & Crash Recovery:**
   - Bounded exponential backoff: Failed jobs auto-retry up to 3 times (2s, 4s, 8s backoff) before entering `failed` status.
   - Interrupted jobs left in `processing` state across process restarts are recovered back to `pending`.
   - Handler-aware claim filtering: Workers only claim job types matching registered handlers via atomic conditional transitions; unsupported jobs remain untouched with zero retries.
   - Single-worker sequential execution prevents Calibre SQLite locking collisions.
3. **Observability & Ingestion API:**
   - `POST /api/ingest-url`: Ingest web article into Calibre EPUB. Supports `{ "async": true }` for immediate job ID queueing (`{ success: true, jobId, status: "queued" }`) and progress polling via `/api/jobs/:id`, preventing reverse proxy timeouts on long extractions. Synchronous fallback preserved when `async` is false or omitted.
   - **Batch Multi-Link Ingestion:** Web Uploader modal (`#urlModal`) and Telegram bot support multi-link reading lists (one URL per line). URLs are extracted, sanitized, and ingested sequentially with real-time visual progress (`Ingesting link X of Y`), background job polling, and an itemized completion summary.
   - `POST /api/ingest-text`: Ingest raw text or markdown directly into Calibre as a Kindle-optimized EPUB with typographic cover (`{ title, author?, content, siteName? }`). Supports immediate synchronous ingestion or background job queueing (`{ "async": true }`).
   - `GET /api/jobs/recent`: List recent jobs with optional `?limit=`, `?status=`, `?type=` filters.
   - `GET /api/jobs/:id`: Retrieve single job status (`pending`, `running`, `completed`, `failed`), resulting book payload, and sanitized error.
   - `POST /api/jobs/:id/retry`: Manually re-queue a failed job for immediate retry.

---

## 🤖 Telegram Bot & Automation

Search your library and retrieve books anywhere via Telegram (`@saroat_ospeto_bot`):
- **Search & Retrieval (`/find`, `/search`, `/f`):** Fast multi-term search across titles, authors, and series. Delivers results with 1-tap interactive buttons: `[📥 Send File]` (or command `/get <id>`), `[📖 Read Online]`, and `[ℹ️ Details]`. Files over 20MB trigger an informative message with direct Web Uploader links.
- **On-Demand Firecrawl Cluster & Web Article Ingestion:** Web article extraction (`/epub <url>` or pasted links) prioritizes the local on-demand Firecrawl cluster (`http://127.0.0.1:3002`). LightHouse wakes containers on demand (~2.5s) upon scrape requests and automatically shuts them down after 15 minutes of inactivity (`docker compose stop`) to release ~2.5 GB of RAM back to macOS, with fail-open fallback to direct fetch and Jina Reader (`https://r.jina.ai`).
  - **Supported Configuration:** Configurable via `.env` options: `FIRECRAWL_ENABLED` (toggle on/off, default `true`), `FIRECRAWL_PORT` (default `3002`), `FIRECRAWL_URL` (default `http://127.0.0.1:3002`), `FIRECRAWL_COMPOSE_DIR` (compose path, default `${HOME}/Documents/Firecrawl/firecrawl`), `FIRECRAWL_IDLE_TIMEOUT_MS` (idle shutdown timer, default `900000`), `FIRECRAWL_ACTIVITY_DIR` (heartbeat lock dir, default `/tmp/lighthouse-firecrawl-activity`), and `FIRECRAWL_API_KEY` (optional authentication).
- **Paywall & Cloudflare Bypass:** Web article extraction (`/epub <url>` or pasted links) transparently re-routes blocked pages through Jina Reader (`https://r.jina.ai`) via sing-box proxy with Kindle typography formatting. Bot-protected and JavaScript-rendered domains (`substack.com`, `medium.com`, `bloomberg.com`, `nytimes.com`, `ft.com`, `wsj.com`, `theinformation.com`, `x.com`, `twitter.com`, `wired.com`) fast-fail directly to Firecrawl (Tier 1) or Jina Reader (Tier 3) bypassing 15-second direct fetch timeouts, with single-retry backoff on HTTP 429 rate limits.
- **Formatting Resilience:** Automatic plain-text retry on Telegram HTTP 400 parsing errors prevents dropped notifications from unescaped characters.

---

## 📋 Operational Runbooks & Documentation

- [RUNBOOK.md](RUNBOOK.md) — Comprehensive operations manual, health troubleshooting, system migration, and daemon lifecycle.
  - [Service Architecture on Mac Mini](RUNBOOK.md#%EF%B8%8F-service-architecture-on-mac-mini-1921683115)
  - [WAN Reverse Tunnels & Public Edge Operations](RUNBOOK.md#8-wan-reverse-tunnels--public-edge-operations)
  - [Database Snapshot Backups & Restoring](RUNBOOK.md#4-database-snapshot-backups-telegram-delivery--wal-durability)
  - [Safe EPUB-Only Library Collection](RUNBOOK.md#14-safe-epub-only-library-collection--ssd-migration-preflight)
- [INCIDENTS.md](INCIDENTS.md) — Incident postmortems, root cause analysis, and architectural learnings.
