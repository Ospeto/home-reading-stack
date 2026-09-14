# Project agent memory

This file is the project's committed home for project-intrinsic agent knowledge: build, test, release, architecture, and sharp-edge notes that should travel with the code.

## Architecture & Integration Notes

- **Calibre Database Access**: The Calibre library SQLite database (`metadata.db`) operates in WAL mode and supports concurrent readonly queries via `bun:sqlite` (`new Database(CALIBRE_DB_PATH, { readonly: true })`). When running `calibredb` CLI commands while `calibre-server` is running, `--with-library http://127.0.0.1:8088` must be passed to avoid locking errors.
- **Web Scraping & Proxy**: Outbound HTTP requests to external web articles route through Sing-box LAN proxy at `http://127.0.0.1:7890`. For paywalled or Cloudflare-protected sites, use Jina Reader (`https://r.jina.ai/<url>`) with header `X-Return-Format: markdown`. Do not send browser `User-Agent` strings to Jina Reader as its gateway may reject them with HTTP 403.
- **Telegram Formatting Resilience**: Telegram Markdown parsing mode fails with HTTP 400 on unescaped special characters (`_`, `*`, `[`). Always guard `sendMessage`, `editOrSendMessage`, and `sendDocument` with automatic plain-text retry on HTTP 400.
- **Module Exports & Polling**: The Telegram bot script (`uploader/bot.ts`) guards `pollTelegram()` with `if ((import.meta as any).main)` so helper functions can be safely imported without starting conflicting polling loops.

## Maintaining this file

Keep this file for knowledge useful to almost every future agent session in this project.
Do not repeat what the codebase already shows; point to the authoritative file or command instead.
Prefer rewriting or pruning existing entries over appending new ones.
When updating this file, preserve this bar for all agents and keep entries concise.
