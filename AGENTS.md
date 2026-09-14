# Project agent memory

This file is the project's committed home for project-intrinsic agent knowledge: build, test, release, architecture, and sharp-edge notes that should travel with the code.

## Architecture & Integration Notes

- **Calibre Database Access**: The Calibre library SQLite database (`metadata.db`) operates in WAL mode and supports concurrent readonly queries via `bun:sqlite` (`new Database(CALIBRE_DB_PATH, { readonly: true })`). When running `calibredb` CLI commands while `calibre-server` is running, `--with-library http://127.0.0.1:8088` must be passed to avoid locking errors.
- **Web Scraping & Proxy**: Outbound HTTP requests to external web articles route through Sing-box LAN proxy at `http://127.0.0.1:7890`. For paywalled or Cloudflare-protected sites, use Jina Reader (`https://r.jina.ai/<url>`) with header `X-Return-Format: markdown`. Do not send browser `User-Agent` strings to Jina Reader as its gateway may reject them with HTTP 403.
- **Paywall & Navigation Filtering**: Article extraction (`uploader/article.ts`) rejects subscription barrier pages (link density > 50%, prose < 150 words, subscription pricing markers) before EPUB generation to prevent garbage imports into Calibre. Navigation lists and tags (`<map>`, `<area>`, `<nav>`, `<header>`, `<footer>`, `<aside>`) are aggressively stripped.
- **Telegram Formatting Resilience**: Telegram Markdown parsing mode fails with HTTP 400 on unescaped special characters (`_`, `*`, `[`). Always guard `sendMessage`, `editOrSendMessage`, and `sendDocument` with automatic plain-text retry on HTTP 400.
- **Module Exports & Polling**: The Telegram bot script (`uploader/bot.ts`) guards `pollTelegram()` with `if ((import.meta as any).main)` so helper functions can be safely imported without starting conflicting polling loops.
- **WAN Reverse Tunnel & Mini App**: Reading HQ dashboard is exposed via persistent SSH reverse tunnel (`com.ospeto.reading-vless-tunnel.plist`) through Sing-box SOCKS5 (`127.0.0.1:7890`) to the cloud VPS, reverse-proxied by Caddy at `https://reading.wavypremium.xyz`. The bot registers a native Telegram Web App menu button via `setChatMenuButton` on startup and handles `/app` and `/webapp`.

## Maintaining this file

Keep this file for knowledge useful to almost every future agent session in this project.
Do not repeat what the codebase already shows; point to the authoritative file or command instead.
Prefer rewriting or pruning existing entries over appending new ones.
When updating this file, preserve this bar for all agents and keep entries concise.
