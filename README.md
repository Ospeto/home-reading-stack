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
│         │ 2. OPDS Server  (:8088)  │ ◄── OTA Book Catalog & Downloads │
│         │ 3. Web Uploader (:8086)  │ ◄── Drag & Drop web interface    │
│         │ 4. LAN Proxy    (:7890)  │ ◄── VLESS Reality tunnel gateway │
│         └─────────────┬─────────────┘                                  │
└───────────────────────┼────────────────────────────────────────────────┘
                        │ (Encrypted VLESS Reality / Hysteria2)
                        ▼
┌────────────────────────────────────────────────────────────────────────┐
│               US VPS Standby Stack (198.46.146.17)                     │
│  - Docker KOSync (https://kosync-198-46-146-17.sslip.io)               │
│  - Docker Calibre-Web (https://calibre-198-46-146-17.sslip.io)          │
└────────────────────────────────────────────────────────────────────────┘
```

---

## 🚀 Services & Endpoints

| Service | Address | Protocol | Description |
|---|---|---|---|
| **Reading HQ Dashboard** | `http://192.168.31.15:8086` | Web SPA | Modern Flash UI library manager, live KOSync telemetry (real titles), Series/Author facets, multi-source scraper, Obsidian export |
| **Telegram Ingest Bot** | `@saroat_ospeto_bot` | Telegram API | Send/forward `.epub`, `.pdf`, `.mobi`, `.azw3` directly on Telegram for auto-ingestion |
| **Local KOSync** | `http://192.168.31.15:7200` | HTTP / JSON | High-performance Bun/SQLite progress sync |
| **Local OPDS Feed** | `http://192.168.31.15:8088/opds` | Atom / XML | Direct book catalog for KOReader search & downloads |
| **Local Calibre Reader** | `http://192.168.31.15:8088` | Web UI | In-browser reading & library management |
| **Manga Auto-Packer** | `/Volumes/Ospeto_SSD/Manga` | Background Daemon | Auto-packs image folders into uncompressed `.cbz` with ComicInfo right-to-left metadata |
| **Daily Snapshot Backup** | `/Volumes/Ospeto_SSD/backups` | 04:00 AM LaunchAgent | Online SQLite snapshots of KOSync, Calibre, and Uploader DBs with 7-day retention |
| **Local Proxy Gateway**| `http://192.168.31.15:7890` | HTTP / SOCKS5 | sing-box background tunnel via Remnawave VLESS |
| **Standby VPS KOSync** | `https://kosync-198-46-146-17.sslip.io` | HTTPS | Remote sync server (requires VPN / Proxy) |
| **Standby VPS OPDS**   | `https://calibre-198-46-146-17.sslip.io` | HTTPS | Remote Calibre-Web (requires VPN / Proxy) |

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
