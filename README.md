# Home Reading Stack (KOReader Sync + Calibre OPDS + Web Uploader)

A self-hosted, private reading infrastructure designed for jailbroken and standard Kindle devices running [KOReader](https://github.com/koreader/koreader). Hosted 24/7 on the local home network (Mac mini `192.168.31.15`), completely bypassing national firewall (GFW) restrictions without requiring VPN clients on e-ink devices.

---

## 🏗️ Architecture & Topology

```
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
│         │ 3. Reading HQ    (:8086)  │ ◄── Catalog UI & Web Uploader    │
│         │ 4. LAN Proxy     (:7890)  │ ◄── SOCKS5 / VLESS gateway       │
│         │ 5. Tunnel Agent  (plist)  │ ──┐ Persistent SSH reverse tunnel│
│         └───────────────────────────┘   │                              │
└─────────────────────────────────────────┼──────────────────────────────┘
                                          │ ssh -R 0.0.0.0:8086:127.0.0.1:8086
                                          │ via ProxyCommand (SOCKS5 :7890)
                                          ▼
┌────────────────────────────────────────────────────────────────────────┐
│                VPS Cloud Edge (`panel.wavypremium.xyz`)                │
│  - Caddy TLS Reverse Proxy (https://reading.wavypremium.xyz)           │
│  - Reverse proxied to 172.18.0.1:8086 (Mac Mini Reading HQ)            │
│  - Telegram Mini App (TMA) & Web App Menu Button target                │
└────────────────────────────────────────────────────────────────────────┘
```

---

## 🚀 Services & Endpoints

| Service | Address | Protocol | Description |
| --- | --- | --- | --- |
| **Reading HQ Dashboard** | `http://192.168.31.15:8086` | Web SPA | Modern Flash UI library manager, live KOSync telemetry (real titles), Series/Author facets, multi-source scraper, Obsidian export |
| **WAN Mini App / Dashboard** | `https://reading.wavypremium.xyz` | HTTPS | Global secure access to Reading HQ via VLESS SSH reverse tunnel + Caddy TLS |
| **Telegram Ingest Bot** | `@saroat_ospeto_bot` | Telegram API | Send/forward `.epub`, `.pdf`, `/find` search, `/backup`, and integrated Telegram Mini App button |
| **Local KOSync** | `http://192.168.31.15:7200` | HTTP / JSON | High-performance Bun/SQLite progress sync |
| **Local OPDS Feed** | `http://192.168.31.15:8088/opds` | Atom / XML | Direct book catalog for KOReader search & downloads |
| **Local Calibre Reader** | `http://192.168.31.15:8088` | Web UI | In-browser reading & library management |
| **Manga Auto-Packer** | `/Volumes/Ospeto_SSD/Manga` | Background Daemon | Auto-packs image folders into uncompressed `.cbz` with ComicInfo right-to-left metadata |
| **Daily Snapshot Backup** | `/Users/ospeto/.backups/reading-stack` | 04:00 AM LaunchAgent | Online SQLite snapshots of KOSync, Calibre, Uploader, and Manga DBs with 7-day retention + Telegram delivery |
| **Local Proxy Gateway** | `http://192.168.31.15:7890` | HTTP / SOCKS5 | sing-box background tunnel via Remnawave VLESS |
| **VLESS SSH Reverse Tunnel** | `com.ospeto.reading-vless-tunnel` | SSH / SOCKS5 | Persistent LaunchAgent reverse tunnel binding Mac Mini `:8086` to VPS `:8086` |
| **Standby VPS KOSync** | `https://kosync-198-46-146-17.sslip.io` | HTTPS | Remote sync server (requires VPN / Proxy) |
| **Standby VPS OPDS** | `https://calibre-198-46-146-17.sslip.io` | HTTPS | Remote Calibre-Web (requires VPN / Proxy) |

---

## 🛡️ Deduplication & Metadata Sanitizer

1. **Automatic Deduplication:**
   - Pre-computes KOReader document checksum and checks existing Calibre titles.
   - If an identical book exists: attaches new format (`.pdf`, `.mobi`) to the existing book without creating duplicate IDs.
   - If the exact format already exists: prevents duplicate creation and returns clean notification.

2. **Metadata Sanitizer:**
   - Automatically strips advertising URLs, telegram channel links (`t.me/...`, `@channel`), bracket garbage (`[Ebook]`, `[Myanmar Book]`, `_v1`, `(1)`), and junk tags on ingestion.
   - 1-Click **"Clean Tags"** button in Reading HQ header sweeps and sanitizes the entire library.

### 1. Progress Synchronization

1. Open any book → Top menu → **Tools (wrench icon)** → **Progress sync**.
2. Tap **Custom sync server** → enter:

   ```text
   http://192.168.31.15:7200
   ```

3. Tap **Login** → enter Username (`moe`) and Password.
4. Check **"Automatically keep documents in sync"**.
5. Tap **Pull progress to this device now**.

### 2. OPDS Book Catalog

1. Top menu → **Search icon (magnifying glass)** → **OPDS catalog** → **Add new catalog**.
2. **Catalog Name:** `Mac Mini Library`
3. **Catalog URL:**

   ```text
   http://192.168.31.15:8088/opds
   ```

4. Tap **Connect** (no credentials required on local LAN).

---

## 💻 How to Upload Books

1. Open **`http://192.168.31.15:8086`** in any browser on your home network.
2. Drag and drop `.epub`, `.pdf`, `.mobi`, `.azw3`, `.cbz`, or `.zip` / `.rar` archive packs (or click **"Choose Folder"** to upload an entire directory).
3. Books and extracted archive contents are immediately imported into Calibre, de-duplicated, scraped for metadata, and broadcast on the OPDS feed.
4. Or send/forward book files and `.zip` packs directly to the **Telegram Bot (`@saroat_ospeto_bot`)** from anywhere.

---

## 🌐 WAN Remote Access & Telegram Mini App (TMA)

The reading stack provides seamless global access to Reading HQ from outside the local network without port forwarding, dynamic DNS, or exposing home IP addresses:

```
[Telegram Client / Browser]
            │
            ▼  HTTPS (Port 443)
[Cloudflare DNS / Caddy on VPS] (https://reading.wavypremium.xyz)
            │
            ▼  HTTP reverse_proxy to http://172.18.0.1:8086
[Remote SSH Daemon on VPS] (0.0.0.0:8086)
            ▲
            │  Persistent SSH Reverse Tunnel (-R 0.0.0.0:8086:127.0.0.1:8086)
            │  via ProxyCommand (nc -X 5 -x 127.0.0.1:7890 %h %p)
[Mac Mini LaunchAgent: com.ospeto.reading-vless-tunnel]
            │
            ▼  Local HTTP
[Reading HQ Dashboard & Web Uploader] (127.0.0.1:8086)
```

### 1. Telegram Mini App (TMA) Integration
- **Chat Menu Button:** On bot startup, the bot registers a native Web App menu button labeled **"📖 Reading HQ"** pointing to `https://reading.wavypremium.xyz` via `setChatMenuButton`.
- **Commands `/app` and `/webapp`:** Respond with an inline keyboard button **[📖 Open Reading HQ]** that opens the mobile-responsive reading dashboard inside Telegram's embedded browser.
- **Telegram WebApp SDK:** `uploader/index.html` loads the official `telegram-web-app.js` SDK and calls `Telegram.WebApp.ready()` and `Telegram.WebApp.expand()` for a full-height, native app experience.

### 2. Persistent VLESS Reverse Tunnel (LaunchAgent)
- Managed by `com.ospeto.reading-vless-tunnel.plist` installed in `~/Library/LaunchAgents/` (tracked in `scripts/com.ospeto.reading-vless-tunnel.plist`).
- Executes:
  ```bash
  ssh -N -R 0.0.0.0:8086:127.0.0.1:8086 \
    -o 'ProxyCommand=nc -X 5 -x 127.0.0.1:7890 %h %p' \
    -o ServerAliveInterval=15 \
    -o ServerAliveCountMax=3 \
    -o ExitOnForwardFailure=yes \
    panel
  ```
- Uses `nc` over local Sing-box SOCKS5 (`127.0.0.1:7890`) to maintain a persistent reverse tunnel through censorship firewalls to the VPS (`panel`).
- Configured with `RunAtLoad: true` and `KeepAlive: true` for automatic re-connection after network drops or reboot.

### 3. VPS Edge Proxy (Caddy)
- Caddy configuration on VPS (`/opt/remnawave/caddy/Caddyfile`):
  ```caddyfile
  https://reading.wavypremium.xyz {
      reverse_proxy * http://172.18.0.1:8086
  }
  ```
- Automatically provisions and renews Let's Encrypt / ZeroSSL TLS certificates.

---

## 🔍 In-Chat Library Search & Retrieval (`/find`, `/search`, `/get`)

Search your entire Calibre catalog directly within Telegram and retrieve books on the go:

1. **Commands:**
   - `/find <query>`, `/search <query>`, or `/f <query>`: Fast multi-term search across book titles, authors, and series names.
   - `/get <id>`: Direct instant file download by Calibre book ID.

2. **Interactive Results:**
   - Displays top 3–5 matching books with Title, Author, Series index, and available formats (`[EPUB]`, `[PDF]`, `[CBZ]`).
   - Under each match, inline keyboard buttons provide 1-tap actions:
     - `[📥 Send File]` (or command `/get <id>`): Instantly extracts the book file (`.epub` preferred) from Calibre storage and delivers it directly to your Telegram chat via `sendDocument`.
     - `[📖 Read Online]`: Direct link to Calibre Web online reader (`/read/<id>/epub`).
     - `[ℹ️ Details]`: Direct link to full book metadata panel in Calibre Web.
   - Files exceeding Telegram's 20MB limit trigger an informative message with direct Web Uploader and Calibre Web reader links.

---

## 🛡️ Paywall & Bot-Wall Fallback (Jina Reader)

When ingesting web articles (`/epub <url>` or pasting URLs):

1. **Cloudflare & Paywall Detection:**
   - Checks HTTP status (401, 403) and response bodies for anti-bot / challenge signatures (`Just a moment...`, `cf-browser-verification`, `Attention Required! | Cloudflare`).
2. **Jina Reader Routing:**
   - Transparently re-routes blocked URLs through `https://r.jina.ai/<url>` via the local Sing-box proxy gateway (`http://127.0.0.1:7890`).
   - Extracts title, author, publication timestamp, and clean markdown content.
3. **Kindle Typography Compilation:**
   - Converts markdown into structured, serif-styled HTML (`Charter`, `Georgia`) optimized for e-ink readability.
   - Invokes `ebook-convert` to package the article as `.epub`, registers it in Calibre, and sends a copy directly back to your Telegram chat.

---

## 📨 Resilient Telegram Delivery (Safe Plain-Text Fallback)

To prevent unclosed Markdown characters (`_`, `*`, `[`) in book titles or error messages from dropping messages:

- `sendMessage`, `editOrSendMessage`, and `sendDocument` inspect API responses for HTTP 400 entity parsing errors.
- Any Markdown formatting failure automatically triggers an immediate retry in plain text, ensuring status messages and book notifications are never dropped.

---

## 💾 Database Backups & Offsite Delivery

The reading stack protects all critical reading databases (progress sync, library catalog metadata, ingestion hash cache, manga state) using hot SQLite online snapshots:

1. **On-Demand Hot Backup (`/backup` in Telegram):**
   - Send `/backup` to the Telegram bot (`@saroat_ospeto_bot`) at any time.
   - The bot creates a live online snapshot (`sqlite3 .backup`) across:
     - KOSync Database (`koreader-sync.db`)
     - Calibre Library Metadata (`metadata.db`)
     - Uploader Ingestion Cache (`cache.db`)
     - Manga Processor DB (`manga.db`, if present)
   - Compresses all snapshots into a timestamped `.tar.gz` archive (~85 KB) and delivers it directly to your Telegram chat.
   - Automatically registers your chat ID as `TELEGRAM_BACKUP_CHAT_ID` in `/Users/ospeto/uploader/.env` for scheduled backups.

2. **Daily Scheduled Offsite Backup Delivery:**
   - Managed via LaunchAgent `com.ospeto.reading-stack-backup` running `scripts/backup-daily.sh` every morning at 04:00 AM.
   - Backs up databases, saves local copies to `~/.backups/reading-stack/` (7-day rolling retention), and mirrors to external SSD if mounted.
   - When `TELEGRAM_BACKUP_CHAT_ID` and `TELEGRAM_BOT_TOKEN` are configured in `.env`, automatically pushes the fresh `.tar.gz` archive directly to your Telegram chat through the local proxy.

---

## 🛡️ Public WAN & API Surface Hardening

The public WAN edge (`https://reading.wavypremium.xyz`) is hardened against unauthorized mutations and network exploitation while preserving friction-free local LAN usage:

1. **WAN vs LAN Differentiation & Authentication:**
   - **Local LAN Requests:** Direct requests from home devices (`192.168.x.x`, `127.0.0.1`, `10.x.x.x`, etc.) do not require authentication credentials, maintaining zero-friction usage on home Wi-Fi.
   - **WAN Reverse-Tunnel Requests:** Requests arriving through the reverse tunnel or public edge are identified via Host headers (`reading.wavypremium.xyz`), `X-Forwarded-Host`, and non-internal `X-Forwarded-For` IPs.
   - **Mutating Route Authentication:** All mutating endpoints (`POST`, `PUT`, `DELETE`) from WAN require either:
     - Bearer token or `X-API-Key` matching `READING_API_KEY` in `.env`.
     - Valid Telegram WebApp `initData` cryptographically verified with `TELEGRAM_BOT_TOKEN` via HMAC-SHA256.
     - Authenticated session cookie (`reading_token`).
   - **Captain-approved public reads:** Read-only library, covers/downloads, telemetry, export, and reading-data endpoints remain public on WAN. Authentication is not added to `GET /api/books`, library facets, read-only job inspection, or equivalent read routes; only state-changing routes are protected.
   - **Credential transport:** API keys and TMA/session credentials are accepted only in their header or cookie channels. Query-string `token`/`auth` values are rejected because URLs leak through history, logs, Referer headers, and analytics.

2. **CORS & CSRF Origin Protection:**
   - CORS is locked down from wildcard `*` to permitted origins: `https://reading.wavypremium.xyz`, `https://kosync.wavypremium.xyz`, local LAN origins, and custom entries in `ALLOWED_ORIGINS`.
   - Mutating routes validate `Origin`, `Referer`, and `Sec-Fetch-Site` to prevent cross-site request forgery attacks.

3. **SSRF (Server-Side Request Forgery) Protection:**
   - Outbound network requests (URL article ingestion, cover art downloads, external metadata scraping) strictly block internal IP ranges:
     - Loopback (`127.0.0.0/8`, `::1`)
     - RFC 1918 private subnets (`10.0.0.0/8`, `172.16.0.0/12`, `192.168.0.0/16`)
     - Cloud metadata & link-local (`169.254.0.0/16`, `169.254.169.254`)
     - Decimal/hex/octal IP representations, IPv6 multicast/reserved ranges, and local hostnames (`localhost`, `*.internal`, `*.lan`)
   - Every A and AAAA result is validated, then each redirect hop reconnects through a pinned connector using the original hostname for Host/TLS SNI semantics; DNS is never re-resolved by the connector.

4. **Decompression & Resource Limits:**
   - Maximum upload payload: 100 MB.
   - Archive extraction limits: max 500 entries, max 150 MB single file, max 500 MB total uncompressed, and 100:1 compression ratio limit to prevent zip/tar bombs.
   - Path traversal `/..` guards reject any archive entry containing directory escape sequences.

5. **Safe Error Responses & Metadata Filenames:**
   - Public API error responses redact internal filesystem paths and stack traces (`sanitizeErrorMessage`).
   - Download endpoints return clean metadata-derived filenames (`Title - Author.epub` or `[Series 1] Title - Author.epub`), never leaking Calibre internal storage directory paths.

6. **Secret Hygiene & Credential Rotation Protocol:**
   - `.env.example` contains non-functional dummy placeholders only. Never commit production tokens, salts, or API keys to the repository.
   - Any exposed or leaked credentials require captain-authorized live credential rotation and repository history remediation (such as `git filter-repo` or BFG Repo-Cleaner). Autonomous agents must not rewrite git history or perform live credential rotation without explicit captain authorization.

---

## ⚡ Durable SQLite Ingestion Job Queue

Background tasks and asynchronous workflows are backed by a durable SQLite job queue (`jobs` table in `cache.db`) rather than unmonitored in-memory timeouts:

1. **Job Types:**
   - `file_ingest`: Ingest single book file into Calibre with format validation and deduplication.
   - `archive_extract`: Safe extraction of archive packages, importing canonical EPUB files.
   - `url_article_ingest`: Web article extraction, conversion to EPUB, and Calibre ingestion.
   - `metadata_enrich`: Background metadata and cover art scraping for newly imported books.
   - `cover_backfill`: Batch generation of typographic covers for web articles lacking covers.

2. **Resilience & Crash Recovery:**
   - Bounded exponential backoff: Failed jobs auto-retry up to 3 times (2s, 4s, 8s backoff) before entering `failed` status.
   - Crash recovery on startup: Interrupted jobs left in `processing` state during a process restart or server reboot are automatically recovered back to `pending` on startup.
   - Calibre lock safety: Single-worker sequential execution prevents Calibre SQLite locking collisions.

3. **Observability API:**
   - `GET /api/jobs/recent`: List recent jobs with optional `?limit=`, `?status=`, `?type=` filters.
   - `GET /api/jobs/:id`: Retrieve single job status, payload, result, and sanitized error.
   - `POST /api/jobs/:id/retry`: Manually re-queue a failed job for immediate retry.

---

## 📖 Canonical EPUB-Only Collection Policy

The home reading stack standardizes on **EPUB-only** for the canonical reading collection:

1. **Canonical Format:**
   - All direct uploads and archive extractions accept `.epub` as the canonical format.
   - Web article extractions compile directly into clean, styled `.epub` files.
   - Non-canonical formats (`.pdf`, `.mobi`, `.azw3`, `.cbz`, etc.) are rejected or quarantined with clear notification messages rather than mixed into the primary collection.

2. **Calibre Storage Preservation:**
   - Calibre-managed storage paths and database ownership are strictly preserved. Internal files are never renamed or relocated by hand.
   - User-facing downloads and Telegram deliveries derive filenames dynamically from sanitized book metadata (`getDownloadFilename`).
