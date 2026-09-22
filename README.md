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
| `bin/lighthouse enrich-synopsis` | Populates missing descriptions for Calibre books combining local EPUB metadata extraction with online APIs (RanobeDB, Bangumi, Google Books). |
| `bin/lighthouse install-daemons` | Dynamically generates and registers macOS LaunchAgents for the current user and repository root. |
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

# Dynamically generate and register macOS LaunchAgents for the current user
bin/lighthouse install-daemons

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

### 3. Kindle Wi-Fi Proxy Gateway (GFW / DPI Bypass)

If your Kindle displays *"Check your network connection"* when connecting to overseas servers:
1. On Kindle: Go to **Settings** → **Wi-Fi Networks** → select your Wi-Fi network → tap **Advanced**.
2. Configure **HTTP Proxy**:
   - **Proxy Host:** `192.168.31.15`
   - **Proxy Port:** `7890`
3. Save network settings. All Kindle network requests will now route through the home host's sing-box proxy gateway.

### 4. Telegram Mini App & Web App Access

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
     - **Light Novels:** Queries [RanobeDB API](https://ranobedb.org/api/v0) and Bangumi first, extracting high-resolution cover art and staff metadata before falling back to Google Books.
     - **Manga:** Queries MangaDex API and Bangumi.
     - **General Literature:** Queries Google Books and OpenLibrary.
     - **Burmese Literature:** Bypasses overseas providers and applies localized typographic cover synthesis and Burmese font styling.

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
   - Hovering over any book card on desktop immediately reveals an Apple glassmorphism overlay featuring a multi-line clamped synopsis preview, one-click EPUB download, direct Obsidian Markdown note export, metadata editing, and book deletion.
6. **3D Skeuomorphic Depth & Accessibility:**
   - 3D book spine curvature overlay (`.book-spine-effect`), multi-layer shadows (`.shadow-book`, `.shadow-book-hover`), and skeleton shimmer loading states.
   - Comprehensive accessibility support respecting `prefers-reduced-motion` (instant 150ms opacity fades, scale suppression) and `prefers-reduced-transparency` (solid opaque dark surfaces).

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
