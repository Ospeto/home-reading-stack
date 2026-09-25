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
   - Built-in OPDS feed reverse proxy forwarding `/opds` and `/get/*` directly to Calibre with range requests.
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
| `bin/lighthouse status` | Displays full one-screen dashboard of all ports (8086, 7200, 8088, 7890), tunnels, launchd daemons, and database record counts (books, progress, and jobs). |
| `bin/lighthouse up` | Starts all services gracefully in strict dependency order (Calibre, KOSync, LightHouse UI, LAN proxy, reverse tunnels). |
| `bin/lighthouse down` | Stops all services gracefully in reverse dependency order without leaving orphaned processes. |
| `bin/lighthouse restart` | Performs safe sequential stop and restart of reading stack services (`down; sleep 1; up`). |
| `bin/lighthouse health` | Probes HTTP/TCP endpoints, checks response codes, and auto-heals stale remote listeners (`fuser -k`). |
| `bin/lighthouse categorize` | Classifies book languages (`mya`, `eng`, `other`), assigns standardized category tags, and prunes promotional tags. |
| `bin/lighthouse enrich-synopsis` | Populates descriptions for Calibre books prioritizing per-volume lookups (EPUB metadata, online volume queries) with AniList series fallback and duplicate series overview re-enrichment. |
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
  - **Dynamic LaunchAgent Scheduling:** Managed via `com.ospeto.reading-ssd-backup.plist` with `StartCalendarInterval` matching configured schedule time (e.g. daily at `03:00`).
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

---

## 📖 KOReader Device Setup Guide

### 1. Progress Synchronization (KOSync)

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

### 2. OPDS Wireless Book Catalog

1. In KOReader, tap top menu → **Search icon (magnifying glass)** → **OPDS catalog**.
2. Tap **Add new catalog**.
3. Set Catalog Name to: `LightHouse Library` (or `Mac Mini Library`).
4. Enter Catalog URL:
   ```text
   http://opds.wavypremium.xyz/opds
   ```
   *(Encrypted TLS: `https://opds.wavypremium.xyz:8443/opds` | Local LAN: `http://192.168.31.15:8088/opds`)*
5. Tap **Connect** (no credentials required). Books can now be browsed, searched, and downloaded directly over Wi-Fi.

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
7. Highlights and notes are immediately written into your Obsidian vault at `<vault>/Books/<Title>.md` with clean YAML frontmatter, book synopsis, and idempotent markers (`<!-- lighthouse:highlights:start -->` / `<!-- lighthouse:highlights:end -->`). Re-exporting never creates duplicates.

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
   - **On-Device Duplicate Scanner & One-Click Pruner:** Detects redundant duplicate book copies already lingering on Kindle storage (from past manual copies or different folder naming). `GET /api/kindle/status` reports `deviceDuplicatesCount`. If duplicates are detected, `#kindleModal` presents an Apple Material notice (`⚠️ Found X duplicate files on device [Clean Duplicates]`) triggering `POST /api/kindle/clean-device-duplicates` to safely prune redundant files, clean orphan `.sdr` sidecars, and prune empty folders while strictly preserving the canonical copy. Also runnable via CLI: `bin/lighthouse sync-kindle --clean-duplicates` (preview in dry-run with `--dry-run`).
   - **Asynchronous Non-Blocking Transfer Engine:** `POST /api/kindle/sync` performs fast atomic pre-flight validation (admit gate, device presence, storage check) and returns `{ success: true, started: true }` immediately in milliseconds, completely eliminating 60s gateway timeouts (`Failed to fetch`) over reverse proxies and SSH tunnels on large collections. File copying and highlight indexing run safely in the background protected by atomic in-process lock semantics (`tryAcquireKindleSyncLock()`), while the frontend polling loop (`/api/kindle/status` every 350ms) tracks live progress, byte counts, and completion summaries with watchdog guards.
   - **Pre-Flight Total Storage Verification:** Calculates the sum of file sizes for all pending (non-skipped) book candidates before beginning transfers. Halts upfront with an explicit error if required space exceeds available Kindle storage (including a 50MB safety reserve), preventing partial transfers that leave the Kindle full.
   - **Per-Book Space Pre-Check:** Re-verifies available storage before copying each individual book, halting gracefully with clear stats if space is exhausted mid-sync.
   - **Instant Sync Cancellation ("Stop Sync"):** Provides an immediate Stop Sync / Cancel capability (`POST /api/kindle/cancel`) in the web UI and sync engine, halting active transfers between books without corrupting files or requiring cable disconnection.
   - **Scope Selection (Active & Unread vs All Books):** Choice between syncing active and unread books (default: currently reading in KOSync or tagged reading/to-read) versus complete library synchronization.
   - **FAT32 Filename Sanitization:** Enforces strictly valid FAT32 filenames, stripping illegal characters (`: * ? " < > | \ /`), trimming whitespace, and bounding lengths safely without filename collisions.
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
   - Ingestion deduplication (`uploader/scraper.ts`, `uploader/bot.ts`) isolates volume numbering so distinct volumes in a series are never merged, while invoking Jev System-1 arbitration (`isSameBookAsync`) for ambiguous title similarity scores (0.65–0.88).
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

## 📚 Lnori Light Novel & Series Ingestion Pipeline

LightHouse features end-to-end automated light novel series and volume ingestion from [Lnori](https://lnori.com) across both the **Web UI** and the **Telegram Bot**:

1. **Dual Ingestion Surfaces:**
   - **LightHouse Web UI:** Click **Upload Books** &rarr; **Add from Lnori** (or paste an `lnori.com` link into the web article ingestion modal to auto-switch). The dedicated Apple fluid modal accepts series URLs (`https://lnori.com/series/...`) or individual volume URLs (`https://lnori.com/book/...`).
   - **Telegram Ingestion Bot:** Paste any `lnori.com/series/...` or `lnori.com/book/...` URL directly into chat with `@saroat_ospeto_bot`.
   - **REST API (`POST /api/lnori/ingest`):** Accepts `{ url: string, stream?: boolean }`, validates target with SSRF and origin guards, supports live Server-Sent Events (`text/event-stream`) and NDJSON streaming progress updates, and returns series metadata, imported volume counts, and tags.
2. **Robust Manifest & Volume Orchestration:**
   - Automatically parses LD+JSON metadata and HTML schemas to extract series title, author, genres, and all associated volume endpoints (`/book/<id>/...`).
   - Limits volume batches safely (`MAX_VOLUMES_PER_REQUEST = 50`).
3. **Pre-Download Duplicate Prevention:**
   - Before downloading multi-megabyte EPUB binaries, queries Calibre's database via series name and volume index or book title. Existing volumes are skipped, preventing wasted bandwidth and duplicate library entries.
4. **Resilient Downloader & In-Process ZIP Auto-Healing:**
   - Downloads EPUB files with exponential retry backoff and proxy routing (`http://127.0.0.1:7890`).
   - If an EPUB is missing its Central Directory or End-of-Central-Directory (EOCD) signature, `repairTruncatedEpub` automatically repairs the container in-process.
5. **High-Resolution Cover Conversion:**
   - Downloads original high-resolution WebP covers from `cdn.lnori.com` and converts them to standard JPEGs via macOS `sips` for seamless Calibre and e-reader compatibility.
6. **Automatic Calibre & Catalog Refresh:**
   - Ingests into Calibre with standardized series indexing (`<Series>: Volume <N>`), applies metadata tags, and flushes cache to immediately reflect new books in KOReader OPDS and the web catalog.

---

## 🎨 Apple WWDC Fluid Interface Design System

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
   - **Row 1 (Brand & Actions):** Sleek LightHouse logo with muted warm gold pastel accent (`bg-amber-400/10 border border-amber-400/25 text-amber-300`), Apple frosted glass `+ Add` button (`rounded-full bg-white/15 hover:bg-white/20 border border-white/20 text-white font-semibold text-xs shadow-sm`) replacing harsh solid opaque white, muted pastel amber USB `Kindle` pill (`rounded-full bg-amber-400/10 border-amber-400/25 text-amber-300`), and frosted glass `Guide` button (`rounded-full bg-white/5 border-white/10 text-zinc-300`). Duplicate `Filters` button removed from Row 1 so the visionOS capsule in Row 3 serves as the clean, single filter trigger.
   - **Row 2 (Search Bar):** Transformed rectangular search box into a smooth organic rounded pill (`rounded-full`) matching visionOS glass tokens (`bg-zinc-900/80 border border-white/10 backdrop-blur-xl shadow-inner text-xs sm:text-sm`).
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

---

## ⚡ Durable Ingestion Job Queue (`cache.db`)

Background tasks and asynchronous workflows run via a durable SQLite job queue (`jobs` table in `cache.db`):

1. **Job Types:**
   - `file_ingest`: Single book file ingestion into Calibre with format validation and deduplication.
   - `archive_extract`: Safe extraction of archive packages, importing canonical EPUB files.
   - `url_article_ingest`: Web article extraction, conversion to EPUB, and Calibre ingestion.
   - `metadata_enrich`: Background metadata and cover art scraping for newly imported books.
   - `cover_backfill`: Batch generation of typographic covers for web articles lacking covers.
2. **Resilience & Crash Recovery:**
   - Bounded exponential backoff: Failed jobs auto-retry up to 3 times (2s, 4s, 8s backoff) before entering `failed` status.
   - Interrupted jobs left in `processing` state across process restarts are recovered back to `pending`.
   - Single-worker sequential execution prevents Calibre SQLite locking collisions.
3. **Observability API:**
   - `GET /api/jobs/recent`: List recent jobs with optional `?limit=`, `?status=`, `?type=` filters.
   - `GET /api/jobs/:id`: Retrieve single job status, payload, result, and sanitized error.
   - `POST /api/jobs/:id/retry`: Manually re-queue a failed job for immediate retry.

---

## 🤖 Telegram Bot & Automation

Search your library and retrieve books anywhere via Telegram (`@saroat_ospeto_bot`):
- **Search & Retrieval (`/find`, `/search`, `/f`):** Fast multi-term search across titles, authors, and series. Delivers results with 1-tap interactive buttons: `[📥 Send File]` (or command `/get <id>`), `[📖 Read Online]`, and `[ℹ️ Details]`. Files over 20MB trigger an informative message with direct Web Uploader links.
- **On-Demand Firecrawl Cluster & Web Article Ingestion:** Web article extraction (`/epub <url>` or pasted links) prioritizes the local on-demand Firecrawl cluster (`http://127.0.0.1:3002`). LightHouse wakes containers on demand (~2.5s) upon scrape requests and automatically shuts them down after 15 minutes of inactivity (`docker compose stop`) to release ~2.5 GB of RAM back to macOS, with fail-open fallback to direct fetch and Jina Reader (`https://r.jina.ai`).
- **Paywall & Cloudflare Bypass:** Web article extraction (`/epub <url>` or pasted links) transparently re-routes blocked pages through Jina Reader (`https://r.jina.ai`) via sing-box proxy with Kindle typography formatting.
- **Formatting Resilience:** Automatic plain-text retry on Telegram HTTP 400 parsing errors prevents dropped notifications from unescaped characters.

---

## 📋 Operational Runbooks & Documentation

- [RUNBOOK.md](RUNBOOK.md) — Comprehensive operations manual, health troubleshooting, system migration, and daemon lifecycle.
  - [Service Architecture on Mac Mini](RUNBOOK.md#%EF%B8%8F-service-architecture-on-mac-mini-1921683115)
  - [WAN Reverse Tunnels & Public Edge Operations](RUNBOOK.md#8-wan-reverse-tunnels--public-edge-operations)
  - [Database Snapshot Backups & Restoring](RUNBOOK.md#4-database-snapshot-backups-telegram-delivery--wal-durability)
  - [Safe EPUB-Only Library Collection](RUNBOOK.md#14-safe-epub-only-library-collection--ssd-migration-preflight)
- [INCIDENTS.md](INCIDENTS.md) — Incident postmortems, root cause analysis, and architectural learnings.
