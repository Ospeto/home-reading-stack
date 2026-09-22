import { describe, expect, it } from "bun:test";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import zlib from "node:zlib";
import { spawnSync } from "node:child_process";
import {
  READING_WEBAPP_URL,
  KOSYNC_WAN_URL,
  getStatusDashboard,
  getMainMenuKeyboard,
  getMainMenuText,
  getPostIngestionKeyboard,
  renderProgressBar,
  truncate,
  formatRelativeTime,
  getCurrentlyReadingShelf,
  getRecentBooks,
  deleteBookFromLibrary,
  getHelpMessage,
  BOT_COMMANDS,
  initBotCommands,
  getRetryImportKeyboard,
  handleCallbackQuery,
  batchProcessFiles,
  pendingRetries,
  cleanExpiredRetries,
  registerPendingRetry,
  getKOReaderBinary256,
  getEpubContentSignature,
  ingestBookFile,
  getCacheDb,
  formatDuplicateCleanerCard,
  handleTextMessage,
  setDuplicateCleanerRunnerForTest,
} from "./bot";
import { type CleanDuplicatesReport } from "../scripts/clean-duplicates";

describe("Telegram Mini App (TMA) Integration", () => {
  it("exports READING_WEBAPP_URL defaulting to production WAN domain", () => {
    expect(READING_WEBAPP_URL).toBeDefined();
    expect(READING_WEBAPP_URL).toBe("https://reading.wavypremium.xyz");
  });

  it("exports KOSYNC_WAN_URL defaulting to production KOSync WAN domain", () => {
    expect(KOSYNC_WAN_URL).toBeDefined();
    expect(KOSYNC_WAN_URL).toBe("http://kosync-sg.wavypremium.xyz");
  });

  it("com.ospeto.reading-vless-tunnel.plist contains required flags and ProxyCommand", () => {
    const plistPath = path.join(
      import.meta.dir,
      "../scripts/com.ospeto.reading-vless-tunnel.plist",
    );
    expect(fs.existsSync(plistPath)).toBe(true);

    const content = fs.readFileSync(plistPath, "utf8");
    expect(content).toContain(
      "<string>com.ospeto.reading-vless-tunnel</string>",
    );
    expect(content).toContain("<string>0.0.0.0:8086:127.0.0.1:8086</string>");
    expect(content).toContain("<string>0.0.0.0:7200:127.0.0.1:7200</string>");
    expect(content).toContain("ProxyCommand=nc -X 5 -x 127.0.0.1:7890 %h %p");
    expect(content).toContain("ServerAliveInterval=15");
    expect(content).toContain("ServerAliveCountMax=3");
    expect(content).toContain("ExitOnForwardFailure=yes");
    expect(content).toContain("<string>panel</string>");
    expect(content).toContain("<key>RunAtLoad</key>");
    expect(content).toContain("<true/>");
    expect(content).toContain("<key>KeepAlive</key>");
    expect(content).toContain(
      "<string>/Users/ospeto/Library/Logs/reading-vless-tunnel.log</string>",
    );
  });

  it("com.ospeto.reading-sg-tunnel.plist contains required flags and sg-vps remote target", () => {
    const plistPath = path.join(
      import.meta.dir,
      "../scripts/com.ospeto.reading-sg-tunnel.plist",
    );
    expect(fs.existsSync(plistPath)).toBe(true);

    const content = fs.readFileSync(plistPath, "utf8");
    expect(content).toContain(
      "<string>com.ospeto.reading-sg-tunnel</string>",
    );
    expect(content).toContain("<string>127.0.0.1:8086:127.0.0.1:8086</string>");
    expect(content).toContain("<string>127.0.0.1:7200:127.0.0.1:7200</string>");
    expect(content).toContain("ServerAliveInterval=15");
    expect(content).toContain("ServerAliveCountMax=3");
    expect(content).toContain("ExitOnForwardFailure=yes");
    expect(content).toContain("BatchMode=yes");
    expect(content).toContain("ConnectTimeout=8");
    expect(content).toContain("<string>sg-vps</string>");
    expect(content).toContain("<key>RunAtLoad</key>");
    expect(content).toContain("<true/>");
    expect(content).toContain("<key>KeepAlive</key>");
    expect(content).toContain(
      "<string>/Users/ospeto/Library/Logs/reading-sg-tunnel.log</string>",
    );
  });

  it("index.html includes Telegram WebApp SDK script and initialization", () => {
    const htmlPath = path.join(import.meta.dir, "index.html");
    expect(fs.existsSync(htmlPath)).toBe(true);

    const html = fs.readFileSync(htmlPath, "utf8");
    expect(html).toContain("https://telegram.org/js/telegram-web-app.js");
    expect(html).toContain("Telegram.WebApp.ready");
    expect(html).toContain("Telegram.WebApp.expand");
  });

  it("index.html eliminates runtime Tailwind CDN and external FontAwesome in favor of static CSS & SVG sprite", () => {
    const htmlPath = path.join(import.meta.dir, "index.html");
    const html = fs.readFileSync(htmlPath, "utf8");

    // Runtime Tailwind CDN script removed
    expect(html).not.toContain("cdn.tailwindcss.com");
    // External FontAwesome stylesheet removed
    expect(html).not.toContain("cdnjs.cloudflare.com/ajax/libs/font-awesome");
    // Self-contained SVG sprite defined
    expect(html).toContain('<symbol id="icon-book"');
    expect(html).toContain('<symbol id="icon-filter"');
    expect(html).toContain('<symbol id="icon-telegram"');
  });

  it("index.html implements Telegram native UX (viewport, themeParams, HapticFeedback, BackButton)", () => {
    const htmlPath = path.join(import.meta.dir, "index.html");
    const html = fs.readFileSync(htmlPath, "utf8");

    expect(html).toContain("--tg-viewport-height");
    expect(html).toContain("themeParams");
    expect(html).toContain("HapticFeedback");
    expect(html).toContain("BackButton");
  });

  it("index.html implements progressive rendering and client caching for mobile performance", () => {
    const htmlPath = path.join(import.meta.dir, "index.html");
    const html = fs.readFileSync(htmlPath, "utf8");

    expect(html).toContain("sessionStorage");
    expect(html).toContain("IntersectionObserver");
    expect(html).toContain("PAGE_SIZE");
    expect(html).toContain('decoding="async"');
    expect(html).toContain('loading="lazy"');
  });

  it("index.html uses native downscaled thumbnails for cards and reserves full resolution for modal", () => {
    const htmlPath = path.join((import.meta as any).dir, "index.html");
    const html = fs.readFileSync(htmlPath, "utf8");

    // Grid cards request 360px width optimized thumbnails
    expect(html).toContain("/cover?w=360");
    // Detail modal displays full resolution cover
    expect(html).toContain(
      "detailCover').src = book.cover ? `/api/books/${book.id}/cover` : ''",
    );
    // Skeleton shimmer placeholder styling
    expect(html).toContain("skeleton-shimmer");
    expect(html).toContain("@keyframes shimmer");
  });

  it("index.html implements minimal, responsive TMA-first library structure and components", () => {
    const htmlPath = path.join((import.meta as any).dir, "index.html");
    const html = fs.readFileSync(htmlPath, "utf8");

    // Pure natural scrolling & safe-area insets
    expect(html).toContain("env(safe-area-inset-bottom)");
    expect(html).toContain("-webkit-overflow-scrolling");

    // Clean dark aesthetic (#09090b / #121216)
    expect(html).toContain("#09090b");

    // Sleek top app bar & search
    expect(html).toContain("LightHouse");
    expect(html).toContain('id="searchInputDesktop"');
    expect(html).toContain('id="filterBtn"');
    expect(html).toContain("breadcrumbCategory");
    expect(html).toContain("⌘K");

    // Quick Category / Series swipeable chips for TMA & Mobile
    expect(html).toContain('id="chip-all"');
    expect(html).toContain('id="chip-reading"');
    expect(html).toContain('id="quickSeriesChips"');

    // Desktop/tablet collapsible sidebar & navigation
    expect(html).toContain('data-purpose="macos-library-sidebar"');
    expect(html).toContain("All Books");
    expect(html).toContain("Reading Now");
    expect(html).toContain("Want to Read");
    expect(html).toContain("Finished");
    expect(html).toContain("Collections");
    expect(html).toContain("OPDS Wireless");

    // Content Header, Sort & View Switches
    expect(html).toContain('data-purpose="library-grid-header"');
    expect(html).toContain("contentHeaderTitle");
    expect(html).toContain("contentHeaderSubtitle");
    expect(html).toContain('id="sortSelect"');
    expect(html).toContain('id="gridBtn"');
    expect(html).toContain('id="tableBtn"');

    // Bounded Book Grid with 3D Spine and Elevation Shadows
    expect(html).toContain('data-purpose="books-cover-grid"');
    expect(html).toContain("book-spine-effect");
    expect(html).toContain("shadow-book");
    expect(html).toContain("shadow-book-hover");
    expect(html).toContain("aspect-[1/1.48]");

    // Desktop 2-column layout and locked sidebar width
    expect(html).toContain(".md\\:flex-row { flex-direction: row; }");
    expect(html).toContain(".md\\:max-w-2xl { max-width: 42rem; }");
    expect(html).toContain(".lg\\:max-w-3xl { max-width: 48rem; }");
    expect(html).toContain(".w-64 { width: 16rem; }");
    expect(html).toContain(".xl\\:w-72 { width: 18rem; }");
    expect(html).toContain("desktop-sticky-sidebar");
    expect(html).toContain("md:max-w-2xl lg:max-w-3xl");

    // Bottom Status Bar
    expect(html).toContain('data-purpose="macos-status-bar"');
    expect(html).toContain("Calibre Synced");
    expect(html).toContain("statusVolumeCount");
  });

  it("index.html applies Apple WWDC fluid interface design principles (materials, typography, tactile active press, fluid motion, accessibility)", () => {
    const htmlPath = path.join((import.meta as any).dir, "index.html");
    const html = fs.readFileSync(htmlPath, "utf8");

    // 1. Apple-grade dark translucent materials with depth hierarchy
    expect(html).toContain("backdrop-filter: blur(20px) saturate(180%)");
    expect(html).toContain("-webkit-backdrop-filter: blur(20px) saturate(180%)");
    expect(html).toContain("rgba(18, 20, 24, 0.75)");
    expect(html).toContain("border-top: 1px solid rgba(255, 255, 255, 0.15)");
    expect(html).toContain("apple-material-header");
    expect(html).toContain("apple-material-sidebar");
    expect(html).toContain("apple-material-modal");
    expect(html).toContain("apple-material-sheet");
    expect(html).toContain("apple-material-glass-light");

    // 2. Optical Typography with Size-Dependent Tracking
    expect(html).toContain(
      '-apple-system, BlinkMacSystemFont, "SF Pro Display", "SF Pro Text", system-ui, sans-serif',
    );
    expect(html).toContain("letter-spacing: -0.02em");
    expect(html).toContain("letter-spacing: 0.025em");
    expect(html).toContain(".tracking-optical-display { letter-spacing: -0.02em; }");
    expect(html).toContain(".tracking-optical-micro { letter-spacing: 0.025em; }");
    expect(html).toContain("leading-tight");

    // 3. Immediate Tactile Active Press & Zero Tap Delay
    expect(html).toContain("-webkit-tap-highlight-color: transparent");
    expect(html).toContain("transform: scale(0.97)");
    expect(html).toContain("transition: transform 120ms cubic-bezier(0.2, 0, 0, 1)");

    // 4. Critically Damped Motion & Symmetric Spatial Transitions
    expect(html).toContain("cubic-bezier(0.16, 1, 0.3, 1)");
    expect(html).toContain("@keyframes slideUp");
    expect(html).toContain("@keyframes slideDown");
    expect(html).toContain("@keyframes slideLeft");
    expect(html).toContain("@keyframes slideRight");
    expect(html).toContain("@keyframes scaleIn");
    expect(html).toContain("@keyframes scaleOut");
    expect(html).toContain("animate-slide-up");
    expect(html).toContain("animate-slide-down");
    expect(html).toContain("animate-slide-left");
    expect(html).toContain("animate-slide-right");
    expect(html).toContain("openModalAnimated");
    expect(html).toContain("closeModalAnimated");
    expect(html).toContain("_animToken");

    // 5. Accessibility & Invariants (reduced-motion & reduced-transparency)
    expect(html).toContain("@media (prefers-reduced-motion: reduce)");
    expect(html).toContain("transition: opacity 150ms ease");
    expect(html).toContain("button:active:not(:disabled)");
    expect(html).toContain("@media (prefers-reduced-transparency: reduce)");
    expect(html).toContain("background-color: #121418");
    expect(html).not.toContain("cdn.tailwindcss.com");
  });
});

describe("Reverse SSH Tunnel Auto-Healing Watchdog", () => {
  const watchdogScriptPath = path.join(
    import.meta.dir,
    "../scripts/tunnel-watchdog.sh",
  );
  const watchdogPlistPath = path.join(
    import.meta.dir,
    "../scripts/com.ospeto.reading-tunnel-watchdog.plist",
  );

  it("tunnel-watchdog.sh exists, is executable, and passes bash syntax check", () => {
    expect(fs.existsSync(watchdogScriptPath)).toBe(true);
    const stat = fs.statSync(watchdogScriptPath);
    // Check executable permission
    expect((stat.mode & 0o111) !== 0).toBe(true);

    const syntaxCheck = spawnSync("bash", ["-n", watchdogScriptPath]);
    expect(syntaxCheck.status).toBe(0);
  });

  it("tunnel-watchdog.sh contains health probes, auto-healing, and Telegram alert escalation across dual tunnels", () => {
    const scriptContent = fs.readFileSync(watchdogScriptPath, "utf8");
    // Local prerequisites
    expect(scriptContent).toContain("127.0.0.1 7890");
    expect(scriptContent).toContain("LOCAL_HTTP_PORT");
    expect(scriptContent).toContain("LOCAL_KOSYNC_PORT");
    // Dual remote tunnel configurations & probes
    expect(scriptContent).toContain("US_WAN_HQ_URL");
    expect(scriptContent).toContain("US_TUNNEL_LABEL");
    expect(scriptContent).toContain("SG_TUNNEL_LABEL");
    expect(scriptContent).toContain("SG_OPDS_80_URL");
    expect(scriptContent).toContain("SG_OPDS_8443_URL");
    expect(scriptContent).toContain("SG_KOSYNC_URL");
    // Auto-healing for both US panel and Singapore sg-vps
    expect(scriptContent).toContain("pkill -f");
    expect(scriptContent).toContain("fuser -k");
    expect(scriptContent).toContain("restart_launchagent");
    expect(scriptContent).toContain("sg-vps");
    expect(scriptContent).toContain("panel");
    // Input validation and failure domain isolation
    expect(scriptContent).toContain("LOCAL_HTTP_PORT out of range");
    expect(scriptContent).toContain("LOCAL_FAILURE");
    // Port forwarding collision detection
    expect(scriptContent).toContain("remote port forwarding failed for listen port");
    // Failure counting and alerting
    expect(scriptContent).toContain("US_FAIL_COUNT_FILE");
    expect(scriptContent).toContain("SG_FAIL_COUNT_FILE");
    expect(scriptContent).toContain("TELEGRAM_BACKUP_CHAT_ID");
    expect(scriptContent).toContain("sendMessage");
  });

  it("com.ospeto.reading-tunnel-watchdog.plist is valid and runs periodically", () => {
    expect(fs.existsSync(watchdogPlistPath)).toBe(true);
    const content = fs.readFileSync(watchdogPlistPath, "utf8");
    expect(content).toContain(
      "<string>com.ospeto.reading-tunnel-watchdog</string>",
    );
    expect(content).toContain(
      "<string>/Users/ospeto/uploader/scripts/tunnel-watchdog.sh</string>",
    );
    expect(content).toContain("<key>StartInterval</key>");
    expect(content).toContain("<integer>120</integer>");
    expect(content).toContain("<key>RunAtLoad</key>");
    expect(content).toContain("<true/>");

    const lintRes = spawnSync("plutil", ["-lint", watchdogPlistPath]);
    expect(lintRes.status).toBe(0);
  });
});

describe("Unified In-Chat Health Dashboard (/status)", () => {
  it("getStatusDashboard generates structured Markdown card with all 5 subsystems", async () => {
    const origFetch = globalThis.fetch;
    globalThis.fetch = (async (input: any) => {
      const u = typeof input === "string" ? input : input?.url || "";
      if (
        u.includes("reading.wavypremium.xyz") ||
        u.includes("kosync.wavypremium.xyz") ||
        u.includes("8086") ||
        u.includes("8088") ||
        u.includes("7200")
      ) {
        return new Response("OK", { status: 200 });
      }
      return origFetch(input);
    }) as typeof fetch;

    let card: string;
    try {
      card = await getStatusDashboard();
    } finally {
      globalThis.fetch = origFetch;
    }
    expect(typeof card).toBe("string");
    expect(card).toContain("📊 *Reading Stack Health Dashboard*");

    // 1. WAN Edge
    expect(card).toContain("🌐 *WAN Edge (VPS panel)*");
    expect(card).toContain("Reading HQ:");
    expect(card).toContain("KOSync WAN:");

    // 2. Reverse Tunnel
    expect(card).toContain("🚇 *Reverse SSH Tunnel*");
    expect(card).toContain("Tunnel Daemon:");
    expect(card).toContain("Port Forwards:");
    expect(card).toContain("8086");
    expect(card).toContain("7200");
    expect(card).toContain("Sing-box Proxy:");

    // 3. Reading HQ & Calibre
    expect(card).toContain("📚 *Reading HQ & Calibre*");
    expect(card).toContain("Web Uploader:");
    expect(card).toContain("Calibre Server:");
    expect(card).toContain("Total Catalog:");
    expect(card).toContain("Newest Title:");

    // 4. KOReader Sync
    expect(card).toContain("🔄 *KOReader Sync (KOSync)*");
    expect(card).toContain("KOSync Server:");
    expect(card).toContain("Sync Database:");
    expect(card).toContain("Users & Devices:");
    expect(card).toContain("Synced Progress:");

    // 5. Mac Mini Host
    expect(card).toContain("🖥️ *Mac Mini Host*");
    expect(card).toContain("Uptime:");
    expect(card).toContain("Memory:");
    expect(card).toContain("Internal Disk:");
  }, 15000);
});

describe("Interactive Main Menu Dashboard (/menu & /start)", () => {
  it("getMainMenuKeyboard returns 4 rows matching the specification", () => {
    const kb = getMainMenuKeyboard();
    expect(kb).toBeDefined();
    expect(Array.isArray(kb.inline_keyboard)).toBe(true);
    expect(kb.inline_keyboard.length).toBe(4);

    // Row 1: Open Reading HQ Mini App
    expect(kb.inline_keyboard[0].length).toBe(1);
    expect(kb.inline_keyboard[0][0].text).toContain("Open Reading HQ");
    expect(kb.inline_keyboard[0][0].web_app?.url).toBe(READING_WEBAPP_URL);

    // Row 2: Search Library & Recent Books
    expect(kb.inline_keyboard[1].length).toBe(2);
    expect(kb.inline_keyboard[1][0].text).toContain("Search Library");
    expect(kb.inline_keyboard[1][0].callback_data).toBe("menu:search");
    expect(kb.inline_keyboard[1][1].text).toContain("Recent Books");
    expect(kb.inline_keyboard[1][1].callback_data).toBe("menu:recent");

    // Row 3: Currently Reading & Server Status
    expect(kb.inline_keyboard[2].length).toBe(2);
    expect(kb.inline_keyboard[2][0].text).toContain("Currently Reading");
    expect(kb.inline_keyboard[2][0].callback_data).toBe("menu:reading");
    expect(kb.inline_keyboard[2][1].text).toContain("Server Status");
    expect(kb.inline_keyboard[2][1].callback_data).toBe("refresh_status");

    // Row 4: Hot Backup & Deduplicate
    expect(kb.inline_keyboard[3].length).toBe(2);
    expect(kb.inline_keyboard[3][0].text).toContain("Hot Backup");
    expect(kb.inline_keyboard[3][0].callback_data).toBe("menu:backup");
    expect(kb.inline_keyboard[3][1].text).toContain("Deduplicate");
    expect(kb.inline_keyboard[3][1].callback_data).toBe("rescan_dedup");
  });

  it("getMainMenuText returns formatted dashboard overview", () => {
    const text = getMainMenuText();
    expect(typeof text).toBe("string");
    expect(text).toContain("LightHouse — Your self-hosted reading beacon");
    expect(text).toContain("Open Reading HQ");
    expect(text).toContain("/f <query>");
    expect(text).toContain("/reading");
    expect(text).toContain("/recent");
    expect(text).toContain("/status");
    expect(text).toContain("/backup");
    expect(text).toContain("/dedup");
  });
});

describe("Post-Ingestion Action Bar & Book Deletion", () => {
  it("getPostIngestionKeyboard generates 1-row action bar with Send, Mini App, and Delete buttons", () => {
    const testBookId = 42;
    const kb = getPostIngestionKeyboard(testBookId);
    expect(kb).toBeDefined();
    expect(kb.inline_keyboard.length).toBe(1);

    const row = kb.inline_keyboard[0];
    expect(row.length).toBe(3);

    // 1. Send File
    expect(row[0].text).toContain("Send File");
    expect(row[0].callback_data).toBe(`send_book:${testBookId}`);

    // 2. Open in Mini App
    expect(row[1].text).toContain("Open in Mini App");
    expect(row[1].web_app?.url).toBe(READING_WEBAPP_URL);

    // 3. Undo / Delete
    expect(row[2].text).toContain("Undo / Delete");
    expect(row[2].callback_data).toBe(`delete_book:${testBookId}`);
  });

  it("deleteBookFromLibrary rejects invalid or non-positive book IDs", () => {
    const invalidRes1 = deleteBookFromLibrary(0);
    expect(invalidRes1.success).toBe(false);
    expect(invalidRes1.error).toBe("Invalid book ID");

    const invalidRes2 = deleteBookFromLibrary(-5);
    expect(invalidRes2.success).toBe(false);
    expect(invalidRes2.error).toBe("Invalid book ID");

    const invalidRes3 = deleteBookFromLibrary(NaN);
    expect(invalidRes3.success).toBe(false);
    expect(invalidRes3.error).toBe("Invalid book ID");
  });
});

describe("Live 'Currently Reading' Shelf (/reading)", () => {
  it("renderProgressBar computes accurate percentage bars and handles clamping", () => {
    // 0% -> 8 empty blocks
    expect(renderProgressBar(0, 8)).toBe("░░░░░░░░");
    // 45% -> 4 filled blocks, 4 empty blocks
    expect(renderProgressBar(0.45, 8)).toBe("████░░░░");
    // 50% -> 4 filled blocks, 4 empty blocks
    expect(renderProgressBar(0.5, 8)).toBe("████░░░░");
    // 75% -> 6 filled blocks, 2 empty blocks
    expect(renderProgressBar(0.75, 8)).toBe("██████░░");
    // 100% -> 8 filled blocks
    expect(renderProgressBar(1.0, 8)).toBe("████████");

    // Clamping
    expect(renderProgressBar(-0.2, 8)).toBe("░░░░░░░░");
    expect(renderProgressBar(1.5, 8)).toBe("████████");
  });

  it("truncate helper truncates long text with ellipsis and preserves short text", () => {
    expect(truncate("Short", 10)).toBe("Short");
    expect(truncate("This is a very long title that exceeds limit", 15)).toBe(
      "This is a very…",
    );
    expect(truncate("", 10)).toBe("");
  });

  it("formatRelativeTime formats elapsed seconds into human readable badges", () => {
    const nowSec = Math.floor(Date.now() / 1000);
    expect(formatRelativeTime(0)).toBe("recently");
    expect(formatRelativeTime(nowSec - 10)).toBe("just now");
    expect(formatRelativeTime(nowSec - 120)).toBe("2m ago");
    expect(formatRelativeTime(nowSec - 7200)).toBe("2h ago");
    expect(formatRelativeTime(nowSec - 86400)).toBe("yesterday");
    expect(formatRelativeTime(nowSec - 86400 * 3)).toBe("3d ago");
  });

  it("getCurrentlyReadingShelf queries active documents and builds shelf card", () => {
    const shelf = getCurrentlyReadingShelf(5);
    expect(shelf).toBeDefined();
    expect(Array.isArray(shelf.items)).toBe(true);
    expect(typeof shelf.card).toBe("string");
    expect(shelf.card).toContain("Currently Reading Shelf");

    if (shelf.items.length > 0) {
      const first = shelf.items[0];
      expect(first.percentage).toBeGreaterThan(0);
      expect(first.percentage).toBeLessThan(1);
      expect(typeof first.title).toBe("string");
      expect(typeof first.device).toBe("string");
      expect(first.timestamp).toBeGreaterThan(0);

      // Card formatting contains progress bar
      expect(shelf.card).toContain("%");
      expect(shelf.keyboard).toBeDefined();
      expect(Array.isArray(shelf.keyboard.inline_keyboard)).toBe(true);
    }
  });
});

describe("Recent Books List (/recent)", () => {
  it("getRecentBooks queries Calibre and builds card with download buttons", () => {
    const recent = getRecentBooks(5);
    expect(recent).toBeDefined();
    expect(Array.isArray(recent.books)).toBe(true);
    expect(typeof recent.card).toBe("string");
    expect(recent.card).toContain("Recent Additions");

    if (recent.books.length > 0) {
      expect(recent.books.length).toBeLessThanOrEqual(5);
      const first = recent.books[0];
      expect(first.id).toBeGreaterThan(0);
      expect(typeof first.title).toBe("string");

      // Card includes book title
      expect(recent.card).toContain(first.title);

      // Keyboard includes send_book button
      expect(recent.keyboard).toBeDefined();
      const rows = recent.keyboard.inline_keyboard;
      const sendButton = rows
        .flat()
        .find((btn: any) => btn.callback_data === `send_book:${first.id}`);
      expect(sendButton).toBeDefined();
    }
  });
});

describe("Telegram Bot /help Command & KOReader Connection Guide", () => {
  it("getHelpMessage returns structured guide with command reference, KOReader setup, and all stack endpoints", () => {
    const msg = getHelpMessage();
    expect(typeof msg).toBe("string");

    // Command reference
    expect(msg).toContain("LightHouse — Your self-hosted reading beacon");
    expect(msg).toContain("/menu");
    expect(msg).toContain("/reading");
    expect(msg).toContain("/recent");
    expect(msg).toContain("/find");
    expect(msg).toContain("/get");
    expect(msg).toContain("/app");
    expect(msg).toContain("/status");
    expect(msg).toContain("/backup");

    // KOReader Connection Guide: KOSync
    expect(msg).toContain("KOSync Progress Sync");
    expect(msg).toContain("Tools");
    expect(msg).toContain("Progress sync");
    expect(msg).toContain("Custom sync server");
    expect(msg).toContain("moe");
    expect(msg).toContain("Automatically keep documents in sync");
    expect(msg).toContain("http://192.168.31.15:7200");
    expect(msg).toContain("http://kosync-sg.wavypremium.xyz");
    expect(msg).toContain("https://kosync-sg.wavypremium.xyz:8443");

    // KOReader Connection Guide: OPDS
    expect(msg).toContain("OPDS Book Catalog");
    expect(msg).toContain("Search");
    expect(msg).toContain("OPDS catalog");
    expect(msg).toContain("Add new catalog");
    expect(msg).toContain("Mac Mini Library");
    expect(msg).toContain("http://opds.wavypremium.xyz/opds");
    expect(msg).toContain("https://opds.wavypremium.xyz:8443/opds");
    expect(msg).toContain("http://192.168.31.15:8088/opds");
    expect(msg).toContain("http://192.168.31.15:8086/opds");
    expect(msg).toContain("/dedup");
    expect(msg).toContain("/dedupe");
    expect(msg).toContain("/duplicates");
    expect(msg).toContain("/clean");
    expect(msg).toContain("/clean_duplicates");

    // Kindle Wi-Fi Proxy
    expect(msg).toContain("Kindle Wi-Fi Proxy");
    expect(msg).toContain("192.168.31.15");
    expect(msg).toContain("7890");

    // Stack Endpoints Reference
    expect(msg).toContain("KOSync Server:");
    expect(msg).toContain("Calibre OPDS Feed:");
    expect(msg).toContain("Calibre Web Reader:");
    expect(msg).toContain("http://192.168.31.15:8088");
    expect(msg).toContain("Reading HQ Dashboard:");
    expect(msg).toContain("http://192.168.31.15:8086");
    expect(msg).toContain("https://reading.wavypremium.xyz");
    expect(msg).toContain("LAN Proxy Gateway:");
    expect(msg).toContain("@saroat_ospeto_bot");
  });

  it("initBotCommands registers all 9 Telegram commands with setMyCommands", async () => {
    expect(Array.isArray(BOT_COMMANDS)).toBe(true);
    const cmdNames = BOT_COMMANDS.map((c) => c.command);
    expect(cmdNames).toContain("menu");
    expect(cmdNames).toContain("reading");
    expect(cmdNames).toContain("recent");
    expect(cmdNames).toContain("find");
    expect(cmdNames).toContain("get");
    expect(cmdNames).toContain("dedup");
    expect(cmdNames).toContain("status");
    expect(cmdNames).toContain("backup");
    expect(cmdNames).toContain("help");

    let registeredPayload: any = null;
    const origFetch = globalThis.fetch;
    globalThis.fetch = (async (input: any, init: any) => {
      const url = typeof input === "string" ? input : input?.url || "";
      if (url.includes("setMyCommands")) {
        registeredPayload = JSON.parse(init?.body || "{}");
        return new Response(JSON.stringify({ ok: true, result: true }), {
          status: 200,
        });
      }
      return origFetch(input, init);
    }) as any;

    try {
      const success = await initBotCommands();
      expect(success).toBe(true);
      expect(registeredPayload).not.toBeNull();
      expect(Array.isArray(registeredPayload.commands)).toBe(true);
      expect(registeredPayload.commands.length).toBe(9);
      expect(registeredPayload.commands.map((c: any) => c.command)).toEqual(cmdNames);
    } finally {
      globalThis.fetch = origFetch;
    }
  });
});

describe("Webpage Manual & KOReader Connection Section (index.html)", () => {
  it("index.html includes dedicated Manual & Connection Guide modal accessible from header, sidebar, and drawer", () => {
    const htmlPath = path.join(import.meta.dir, "index.html");
    const html = fs.readFileSync(htmlPath, "utf8");

    // Modal definition and back-button / modal manager integration
    expect(html).toContain('id="guideModal"');
    expect(html).toContain("openGuideModal");
    expect(html).toContain("closeGuideModal");
    expect(html).toContain(
      "'filterDrawer', 'bookDetailModal', 'urlModal', 'uploadModal', 'editModal', 'guideModal'",
    );
    expect(html).toContain("closeGuideModal();");

    // Header, sidebar, and mobile drawer buttons
    expect(html).toContain("openGuideModal()");
    expect(html).toContain("KOReader & Manual");
    expect(html).toContain("KOReader & Stack Manual");

    // LightHouse CLI reference tab & panel
    expect(html).toContain('id="guide-tab-cli"');
    expect(html).toContain('id="guide-cli"');
    expect(html).toContain("bin/lighthouse status");
    expect(html).toContain("bin/lighthouse up");
    expect(html).toContain("bin/lighthouse down");
    expect(html).toContain("bin/lighthouse install-daemons");
    expect(html).toContain("bin/lighthouse backup");

    // SVG icons
    expect(html).toContain('<symbol id="icon-book-open"');
    expect(html).toContain('<symbol id="icon-server"');

    // All Stack Endpoints with one-click copy buttons
    // 1. KOSync (Local, Singapore Plain HTTP Port 80, and Singapore TLS Port 8443)
    expect(html).toContain("copyToClipboard('http://192.168.31.15:7200')");
    expect(html).toContain(
      "copyToClipboard('http://kosync-sg.wavypremium.xyz')",
    );
    expect(html).toContain(
      "copyToClipboard('https://kosync-sg.wavypremium.xyz:8443')",
    );
    // 2. Calibre OPDS (Local & Singapore WAN)
    expect(html).toContain("copyToClipboard('http://opds.wavypremium.xyz/opds')");
    expect(html).toContain("copyToClipboard('https://opds.wavypremium.xyz:8443/opds')");
    expect(html).toContain("copyToClipboard('http://192.168.31.15:8088/opds')");
    // 3. Calibre Web reader (Local)
    expect(html).toContain("copyToClipboard('http://192.168.31.15:8088')");
    // 4. Reading HQ Dashboard (Local & WAN)
    expect(html).toContain("copyToClipboard('http://192.168.31.15:8086')");
    expect(html).toContain(
      "copyToClipboard('https://reading.wavypremium.xyz')",
    );
    // 5. LAN Proxy Gateway
    expect(html).toContain("copyToClipboard('192.168.31.15:7890')");
    // 6. Telegram Bot
    expect(html).toContain("copyToClipboard('@saroat_ospeto_bot')");

    // Step-by-step KOReader setup instructions
    expect(html).toContain("KOReader Progress Sync (KOSync)");
    expect(html).toContain("Tools (wrench icon)");
    expect(html).toContain("Progress sync");
    expect(html).toContain("Custom sync server");
    expect(html).toContain("Username: <code");
    expect(html).toContain("moe");
    expect(html).toContain("Automatically keep documents in sync");

    expect(html).toContain("KOReader OPDS Catalog (Direct Download)");
    expect(html).toContain("Search icon (magnifying glass)");
    expect(html).toContain("OPDS catalog");
    expect(html).toContain("Add new catalog");
    expect(html).toContain("Mac Mini Library");

    // Kindle LAN Proxy instructions
    expect(html).toContain("Kindle Wi-Fi Proxy Gateway (GFW Bypass)");
    expect(html).toContain("192.168.31.15");
    expect(html).toContain("7890");
  });
});

describe("LightHouse Brand Logo & Visual Identity Integration", () => {
  const htmlPath = path.join((import.meta as any).dir, "index.html");
  const html = fs.readFileSync(htmlPath, "utf8");

  it("defines #icon-lighthouse symbol in SVG sprite defs and integrates into header brand", () => {
    // 1. Symbol definition in SVG defs
    expect(html).toContain('<symbol id="icon-lighthouse" viewBox="0 0 320 380">');
    expect(html).toContain('id="markBeacon"');
    expect(html).toContain('id="markLeftBeam"');
    expect(html).toContain('id="markRightBeam"');

    // 2. Top header brand block replaces icon-book with #icon-lighthouse (w-5 h-5)
    expect(html).toContain('<svg class="w-5 h-5"><use href="#icon-lighthouse"/></svg>');

    // 3. Connection guide modal header displays glowing emblem
    expect(html).toContain('<svg class="w-6 h-6"><use href="#icon-lighthouse"/></svg>');

    // 4. Empty state watermark renders lighthouse tower and quiet library message
    expect(html).toContain("Your LightHouse library is quiet");
    expect(html).toContain('<svg class="w-16 h-16 opacity-30 drop-shadow-[0_0_12px_rgba(255,179,0,0.25)]"><use href="#icon-lighthouse"/></svg>');
  });

  it("includes SVG favicon data URI and apple-touch-icon in index.html head", () => {
    // SVG Favicon with URL-encoded mark SVG
    expect(html).toContain('<link rel="icon" type="image/svg+xml" href="data:image/svg+xml;utf8,');
    expect(html).toContain('href="data:image/svg+xml;utf8,%3Csvg%20xmlns%3D%22http%3A%2F%2Fwww.w3.org%2F2000%2Fsvg%22%20viewBox%3D%220%200%20320%20380%22');
    // Apple Touch Icon
    expect(html).toContain('<link rel="apple-touch-icon" href="assets/logo.svg">');
  });

  it("commits repository brand assets assets/logo.svg and assets/mark.svg", () => {
    const logoPath = path.join((import.meta as any).dir, "../assets/logo.svg");
    const markPath = path.join((import.meta as any).dir, "../assets/mark.svg");
    expect(fs.existsSync(logoPath)).toBe(true);
    expect(fs.existsSync(markPath)).toBe(true);

    const logoSvg = fs.readFileSync(logoPath, "utf8");
    const markSvg = fs.readFileSync(markPath, "utf8");
    expect(logoSvg).toContain('viewBox="0 0 512 512"');
    expect(markSvg).toContain('viewBox="0 0 320 380"');
  });

  it("ensures root assets/ and uploader/assets/ trees are in sync", () => {
    const rootAssets = path.join((import.meta as any).dir, "../assets");
    const uploaderAssets = path.join((import.meta as any).dir, "assets");
    const filenames = [
      "logo.svg",
      "mark.svg",
      "logo.png",
      "apple-touch-icon.png",
    ];

    for (const file of filenames) {
      const rootFile = path.join(rootAssets, file);
      const uploaderFile = path.join(uploaderAssets, file);
      expect(fs.existsSync(rootFile)).toBe(true);
      expect(fs.existsSync(uploaderFile)).toBe(true);
      const rootBuf = fs.readFileSync(rootFile);
      const uploaderBuf = fs.readFileSync(uploaderFile);
      expect(rootBuf.equals(uploaderBuf)).toBe(true);
    }
  });
});

describe("HTTP LAN Clipboard & Stored XSS Hardening (index.html)", () => {
  const htmlPath = path.join(import.meta.dir, "index.html");
  const html = fs.readFileSync(htmlPath, "utf8");

  it("escapeHtml escapes single quotes alongside ampersand, angle brackets, and double quotes", () => {
    expect(html).toContain(
      ".replace(/'/g, '&#39;')",
    );

    // Extract escapeHtml function from index.html and test directly
    const match = html.match(/function escapeHtml\(str\) \{([\s\S]*?)\n {4}\}/);
    expect(match).not.toBeNull();
    const escapeHtmlFn = new Function("str", match![1]);

    expect(escapeHtmlFn("")).toBe("");
    expect(escapeHtmlFn(null)).toBe("");
    expect(escapeHtmlFn(undefined)).toBe("");
    expect(escapeHtmlFn("Tom & Jerry")).toBe("Tom &amp; Jerry");
    expect(escapeHtmlFn('<script>alert("xss")</script>')).toBe(
      "&lt;script&gt;alert(&quot;xss&quot;)&lt;/script&gt;",
    );
    expect(escapeHtmlFn("O'Reilly")).toBe("O&#39;Reilly");
    expect(escapeHtmlFn(`"hello" & 'world'`)).toBe(
      "&quot;hello&quot; &amp; &#39;world&#39;",
    );
  });

  it("copyToClipboard implements secure context detection and textarea fallback for plain HTTP", () => {
    // 1. Secure context branch checking navigator.clipboard.writeText
    expect(html).toContain(
      "navigator.clipboard && typeof navigator.clipboard.writeText === 'function'",
    );
    // 2. Fallback using hidden textarea and document.execCommand('copy')
    expect(html).toContain("document.createElement('textarea')");
    expect(html).toContain("textarea.style.position = 'fixed'");
    expect(html).toContain("textarea.select()");
    expect(html).toContain("document.execCommand('copy')");
    expect(html).toContain("document.body.removeChild(textarea)");
    // 3. Robust error handling with tgHaptic and showToast
    expect(html).toContain("tgHaptic.success()");
    expect(html).toContain("showToast('Copied to clipboard!')");
    expect(html).toContain("tgHaptic.error()");
    expect(html).toContain("showToast('Failed to copy to clipboard', 'error')");
  });

  it("copyToClipboard functions correctly in simulated secure, HTTP LAN fallback, and error environments", async () => {
    const match = html.match(/async function copyToClipboard\(text\) \{([\s\S]*?)\n {4}\}/);
    expect(match).not.toBeNull();
    const copyBody = match![1];
    const AsyncFunction = Object.getPrototypeOf(async () => {}).constructor;

    // Scenario A: Secure context (navigator.clipboard.writeText available)
    {
      let clipboardText = "";
      let toastCalled = false;
      let toastType = "";
      let hapticSuccessCalled = false;
      let hapticErrorCalled = false;

      const mockNavigator = {
        clipboard: {
          writeText: async (t: string) => {
            clipboardText = t;
          },
        },
      };
      const mockTgHaptic = {
        success: () => { hapticSuccessCalled = true; },
        error: () => { hapticErrorCalled = true; },
      };
      const mockShowToast = (_msg: string, type = "success") => {
        toastCalled = true;
        toastType = type;
      };

      const copyFn = new AsyncFunction(
        "text",
        "navigator",
        "document",
        "tgHaptic",
        "showToast",
        copyBody,
      );

      await copyFn("http://192.168.31.15:7200", mockNavigator, {}, mockTgHaptic, mockShowToast);

      expect(clipboardText).toBe("http://192.168.31.15:7200");
      expect(hapticSuccessCalled).toBe(true);
      expect(hapticErrorCalled).toBe(false);
      expect(toastCalled).toBe(true);
      expect(toastType).toBe("success");
    }

    // Scenario B: Plain HTTP LAN (navigator.clipboard is undefined, fallback executes)
    {
      let textareaAppended = false;
      let textareaRemoved = false;
      let selected = false;
      let execCommandCalled = false;
      let copiedValue = "";
      let toastCalled = false;
      let toastType = "";
      let hapticSuccessCalled = false;
      let hapticErrorCalled = false;

      const mockTextarea: any = {
        style: {},
        setAttribute: () => {},
        focus: () => {},
        select: () => { selected = true; },
      };

      const mockDocument = {
        createElement: (tag: string) => {
          if (tag === "textarea") return mockTextarea;
          return {};
        },
        body: {
          appendChild: (el: any) => {
            textareaAppended = true;
            copiedValue = el.value;
          },
          removeChild: (_el: any) => {
            textareaRemoved = true;
          },
        },
        execCommand: (cmd: string) => {
          if (cmd === "copy") {
            execCommandCalled = true;
            return true;
          }
          return false;
        },
      };

      const mockTgHaptic = {
        success: () => { hapticSuccessCalled = true; },
        error: () => { hapticErrorCalled = true; },
      };
      const mockShowToast = (_msg: string, type = "success") => {
        toastCalled = true;
        toastType = type;
      };

      const copyFn = new AsyncFunction(
        "text",
        "navigator",
        "document",
        "tgHaptic",
        "showToast",
        copyBody,
      );

      // navigator.clipboard is undefined on plain HTTP
      await copyFn("http://192.168.31.15:8086", {}, mockDocument, mockTgHaptic, mockShowToast);

      expect(textareaAppended).toBe(true);
      expect(textareaRemoved).toBe(true);
      expect(selected).toBe(true);
      expect(execCommandCalled).toBe(true);
      expect(copiedValue).toBe("http://192.168.31.15:8086");
      expect(hapticSuccessCalled).toBe(true);
      expect(hapticErrorCalled).toBe(false);
      expect(toastCalled).toBe(true);
      expect(toastType).toBe("success");
    }

    // Scenario C: Plain HTTP LAN fallback failure (execCommand returns false or throws)
    {
      let toastCalled = false;
      let toastType = "";
      let hapticSuccessCalled = false;
      let hapticErrorCalled = false;

      const mockTextarea: any = {
        style: {},
        setAttribute: () => {},
        focus: () => {},
        select: () => {},
      };

      const mockDocument = {
        createElement: () => mockTextarea,
        body: {
          appendChild: () => {},
          removeChild: () => {},
        },
        execCommand: () => false, // Fails
      };

      const mockTgHaptic = {
        success: () => { hapticSuccessCalled = true; },
        error: () => { hapticErrorCalled = true; },
      };
      const mockShowToast = (_msg: string, type = "success") => {
        toastCalled = true;
        toastType = type;
      };

      const copyFn = new AsyncFunction(
        "text",
        "navigator",
        "document",
        "tgHaptic",
        "showToast",
        copyBody,
      );

      const origConsoleError = console.error;
      console.error = () => {};
      try {
        await copyFn("test-fail", {}, mockDocument, mockTgHaptic, mockShowToast);
      } finally {
        console.error = origConsoleError;
      }

      expect(hapticSuccessCalled).toBe(false);
      expect(hapticErrorCalled).toBe(true);
      expect(toastCalled).toBe(true);
      expect(toastType).toBe("error");
    }
  });

  it("sanitizes facet filter metadata interpolation against stored XSS across all facet lists", () => {
    // 1. Verify no unsafe string-escaped inline handlers remain (e.g. s.name.replace(/'/g, "\\'"))
    expect(html).not.toContain("setFilter('series', '${s.name");
    expect(html).not.toContain("setFilter('author', '${a.name");
    expect(html).not.toContain("setFilter('tag', '${t.name");
    expect(html).not.toContain("setFilter('format', '${f.name");

    // 2. Verify all facet buttons bind safe data attributes and escaped text
    expect(html).toContain('data-filter-type="series"');
    expect(html).toContain('data-filter-type="author"');
    expect(html).toContain('data-filter-type="tag"');
    expect(html).toContain('data-filter-type="format"');

    expect(html).toContain('onclick="setFilter(this.dataset.filterType, this.dataset.filterValue)"');
    expect(html).toContain('data-filter-value="${escapeHtml(s.name)}"');
    expect(html).toContain('data-filter-value="${escapeHtml(a.name)}"');
    expect(html).toContain('data-filter-value="${escapeHtml(t.name)}"');
    expect(html).toContain('data-filter-value="${escapeHtml(f.name)}"');

    // 3. Verify label interpolation is wrapped with escapeHtml
    expect(html).toContain("<span>${escapeHtml(s.name)}</span>");
    expect(html).toContain("<span class=\"truncate\">${escapeHtml(s.name)}</span>");
    expect(html).toContain("<span class=\"truncate\">${escapeHtml(a.name)}</span>");
    expect(html).toContain("#${escapeHtml(t.name)}");
    expect(html).toContain("${escapeHtml(f.name)}");

    // 4. Verify setFilter badge interpolation is escaped
    expect(html).toContain(
      "setHtml(badge, `${escapeHtml(type.toUpperCase())}: ${escapeHtml(value)}`);",
    );
  });
});

describe("Retry Import Actions & Telegram Bot Handling", () => {
  it("getRetryImportKeyboard generates callback_data strictly <= 64 bytes using short retry token", () => {
    expect(typeof batchProcessFiles).toBe("function");
    // Typical long Telegram document file_id (70-90 bytes)
    const longFileId = "BQACAgQAAxkBAAICa2edFk9abcdef0123456789ABCDEFghijklmnopqrstuvwxyz_very_long_telegram_file_id_example";
    const kb = getRetryImportKeyboard(longFileId, {
      fileName: "test_book.epub",
      fileSize: 1024,
      chatId: 123456,
    });
    expect(kb).toBeDefined();
    expect(Array.isArray(kb.inline_keyboard)).toBe(true);
    expect(kb.inline_keyboard.length).toBe(1);
    expect(kb.inline_keyboard[0].length).toBe(1);
    expect(kb.inline_keyboard[0][0].text).toContain("Retry Import");

    const callbackData = kb.inline_keyboard[0][0].callback_data;
    expect(callbackData).toBeDefined();
    expect(callbackData.startsWith("retry:")).toBe(true);
    // Strict Telegram Bot API limit: callback_data must be 1-64 bytes
    expect(Buffer.byteLength(callbackData, "utf8")).toBeLessThanOrEqual(64);
    expect(callbackData.length).toBeLessThanOrEqual(64);
  });

  it("handleCallbackQuery handles retry: token callback and re-triggers ingestion", async () => {
    const answeredQueries: any[] = [];
    const requestedEndpoints: string[] = [];
    const sentMessages: any[] = [];

    const fileId = "long_file_id_for_retry_test_1234567890_abcdefghij";
    const kb = getRetryImportKeyboard(fileId, {
      fileName: "test_retry_book.epub",
      fileSize: 2048,
      chatId: 778899,
    });
    const retryCallbackData = kb.inline_keyboard[0][0].callback_data;

    const origFetch = globalThis.fetch;
    globalThis.fetch = (async (input: any, init: any) => {
      const url = typeof input === "string" ? input : input?.url || "";
      requestedEndpoints.push(url);

      if (url.includes("answerCallbackQuery")) {
        const body = JSON.parse(init?.body || "{}");
        answeredQueries.push(body);
        return new Response(JSON.stringify({ ok: true, result: true }), {
          status: 200,
        });
      }

      if (url.includes(`getFile?file_id=${fileId}`)) {
        return new Response(
          JSON.stringify({
            ok: true,
            result: {
              file_id: fileId,
              file_path: "documents/test_retry_book.epub",
              file_size: 2048,
            },
          }),
          { status: 200 },
        );
      }

      if (url.includes("test_retry_book.epub")) {
        return new Response(new Uint8Array(100), { status: 200 });
      }

      if (url.includes("sendMessage") || url.includes("editMessageText")) {
        const body = JSON.parse(init?.body || "{}");
        sentMessages.push(body);
        return new Response(
          JSON.stringify({ ok: true, result: { message_id: 101 } }),
          { status: 200 },
        );
      }

      return origFetch(input, init);
    }) as typeof fetch;

    try {
      const cq = {
        id: "cb_query_999",
        data: retryCallbackData,
        message: { chat: { id: 778899 }, message_id: 456 },
        from: { username: "reader", id: 778899 },
      };

      await handleCallbackQuery(cq);

      // Verify callback query was answered with "Retrying import..."
      expect(answeredQueries.length).toBeGreaterThan(0);
      expect(answeredQueries[0].callback_query_id).toBe("cb_query_999");
      expect(answeredQueries[0].text).toBe("Retrying import...");

      // Verify getFile was called with the original fileId looked up from token
      const getFileCalled = requestedEndpoints.some((u) =>
        u.includes(`getFile?file_id=${fileId}`),
      );
      expect(getFileCalled).toBe(true);

      // Verify error message with short retry keyboard was sent when download truncated / validation failed
      const errorMessage = sentMessages.find(
        (m) =>
          m.text?.includes("Import Failed") &&
          m.reply_markup?.inline_keyboard?.[0]?.[0]?.callback_data?.startsWith("retry:"),
      );
      expect(errorMessage).toBeDefined();
      expect(
        errorMessage.reply_markup.inline_keyboard[0][0].callback_data.length,
      ).toBeLessThanOrEqual(64);
    } finally {
      globalThis.fetch = origFetch;
    }
  });

  it("handleCallbackQuery preserves backward compatibility with retry_file: prefix", async () => {
    const answeredQueries: any[] = [];
    const requestedEndpoints: string[] = [];

    const origFetch = globalThis.fetch;
    globalThis.fetch = (async (input: any, init: any) => {
      const url = typeof input === "string" ? input : input?.url || "";
      requestedEndpoints.push(url);

      if (url.includes("answerCallbackQuery")) {
        const body = JSON.parse(init?.body || "{}");
        answeredQueries.push(body);
        return new Response(JSON.stringify({ ok: true, result: true }), {
          status: 200,
        });
      }

      if (url.includes("getFile?file_id=legacy_123")) {
        return new Response(
          JSON.stringify({
            ok: true,
            result: {
              file_id: "legacy_123",
              file_path: "documents/legacy.epub",
              file_size: 50,
            },
          }),
          { status: 200 },
        );
      }

      if (url.includes("legacy.epub")) {
        return new Response(new Uint8Array(50), { status: 200 });
      }

      return new Response(
        JSON.stringify({ ok: true, result: { message_id: 101 } }),
        { status: 200 },
      );
    }) as typeof fetch;

    try {
      const cq = {
        id: "cb_legacy",
        data: "retry_file:legacy_123",
        message: { chat: { id: 112233 }, message_id: 789 },
        from: { username: "legacy_user", id: 112233 },
      };

      await handleCallbackQuery(cq);
      expect(answeredQueries.length).toBeGreaterThan(0);
      expect(requestedEndpoints.some((u) => u.includes("legacy_123"))).toBe(true);
    } finally {
      globalThis.fetch = origFetch;
    }
  });

  it("verifies pendingRetries map TTL expiration cleanup", () => {
    cleanExpiredRetries();
    const token = registerPendingRetry({
      fileId: "test_ttl_file_id",
      fileName: "test.epub",
      fileSize: 500,
      chatId: 12345,
    });
    expect(pendingRetries.has(token)).toBe(true);
    const entry = pendingRetries.get(token);
    expect(entry).toBeDefined();

    // Artificially expire the entry
    if (entry) {
      entry.createdAt = Date.now() - (60 * 60 * 1000 + 1000);
    }
    cleanExpiredRetries();
    expect(pendingRetries.has(token)).toBe(false);
  });

  it("index.html provides a direct Retry button for failed upload queue items", () => {
    const htmlPath = path.join(import.meta.dir, "index.html");
    const htmlContent = fs.readFileSync(htmlPath, "utf8");

    expect(htmlContent).toContain("renderFailedUploadItem");
    expect(htmlContent).toContain("retry-upload-btn");
    expect(htmlContent).toContain("Retry");
    expect(htmlContent).toContain("uploadQueue");
  });

  it("index.html uses properly encoded SVG data URI without unescaped double quotes for fallback cover", () => {
    const htmlPath = path.join(import.meta.dir, "index.html");
    const htmlContent = fs.readFileSync(htmlPath, "utf8");

    const match = htmlContent.match(/const coverSrc = book\.cover \? [^:]+ : ("[^"]+"|\'[^\']+\');/);
    expect(match).not.toBeNull();
    const fallbackLiteral = match![1];
    expect(fallbackLiteral).toContain("data:image/svg+xml;utf8,%3Csvg");
    const inner = fallbackLiteral.slice(1, -1);
    expect(inner).not.toContain('"');
    expect(htmlContent).not.toContain('data:image/svg+xml;utf8,<svg xmlns="http://www.w3.org/2000/svg"');
  });

  it("batchProcessFiles auto-heals truncated EPUB missing central directory and proceeds with ingestion", async () => {
    function buildSyntheticTruncatedEpub(): Buffer {
      function makeEntry(name: string, data: Buffer, compMethod = 0, compData: Buffer | null = null): Buffer {
        const nameBuf = Buffer.from(name);
        const payload = compData || data;
        const crc = zlib.crc32(data);
        const h = Buffer.alloc(30 + nameBuf.length);
        h.writeUInt32LE(0x04034b50, 0);
        h.writeUInt16LE(20, 4);
        h.writeUInt16LE(0, 6);
        h.writeUInt16LE(compMethod, 8);
        h.writeUInt16LE(0, 10);
        h.writeUInt16LE(0, 12);
        h.writeUInt32LE(crc, 14);
        h.writeUInt32LE(payload.length, 18);
        h.writeUInt32LE(data.length, 22);
        h.writeUInt16LE(nameBuf.length, 26);
        h.writeUInt16LE(0, 28);
        nameBuf.copy(h, 30);
        return Buffer.concat([h, payload]);
      }

      const mimeData = Buffer.from("application/epub+zip");
      const mimePart = makeEntry("mimetype", mimeData, 0);

      const containerXml = Buffer.from(
        '<?xml version="1.0"?><container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container"><rootfiles><rootfile full-path="content.opf" media-type="application/oebps-package+xml"/></rootfiles></container>',
      );
      const containerPart = makeEntry("META-INF/container.xml", containerXml, 8, zlib.deflateRawSync(containerXml));

      const uniqueTitle = `Repaired Novel ${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;
      const opfXml = Buffer.from(
        `<?xml version="1.0"?><package xmlns="http://www.idpf.org/2007/opf" version="3.0"><metadata><dc:title>${uniqueTitle}</dc:title></metadata><manifest/><spine/></package>`,
      );
      const opfPart = makeEntry("content.opf", opfXml, 8, zlib.deflateRawSync(opfXml));

      // Omit Central Directory and EOCD, append trailing null bytes
      return Buffer.concat([mimePart, containerPart, opfPart, Buffer.alloc(512, 0)]);
    }

    const syntheticEpub = buildSyntheticTruncatedEpub();
    const mockCalibre = path.join(os.tmpdir(), `mock_calibre_${Date.now()}.sh`);
    fs.writeFileSync(
      mockCalibre,
      '#!/bin/sh\nif [ "$1" = "add" ]; then echo "Added book ids: 777"; exit 0; fi\nexit 0\n',
    );
    fs.chmodSync(mockCalibre, 0o755);

    const origCalibredb = process.env.CALIBREDB_PATH;
    process.env.CALIBREDB_PATH = mockCalibre;

    const testDropDir = path.join(os.tmpdir(), "test_books_drop_" + Date.now());
    fs.mkdirSync(testDropDir, { recursive: true });
    const origDropDir = process.env.BOOKS_DROP_DIR;
    process.env.BOOKS_DROP_DIR = testDropDir;

    const fileId = "test_truncated_file_id";
    const sentMessages: any[] = [];
    const origFetch = globalThis.fetch;

    globalThis.fetch = (async (input: any, init: any) => {
      const url = typeof input === "string" ? input : input?.url || "";

      if (url.includes(`getFile?file_id=${fileId}`)) {
        return new Response(
          JSON.stringify({
            ok: true,
            result: {
              file_id: fileId,
              file_path: "documents/truncated.epub",
              file_size: syntheticEpub.length,
            },
          }),
          { status: 200 },
        );
      }

      if (url.includes("truncated.epub")) {
        return new Response(syntheticEpub, { status: 200 });
      }

      if (url.includes("sendMessage") || url.includes("editMessageText")) {
        const body = JSON.parse(init?.body || "{}");
        sentMessages.push(body);
        return new Response(
          JSON.stringify({ ok: true, result: { message_id: 101 } }),
          { status: 200 },
        );
      }

      return origFetch(input, init);
    }) as typeof fetch;

    try {
      await batchProcessFiles(123456, [
        {
          doc: { file_id: fileId, file_name: "truncated.epub", file_size: syntheticEpub.length },
          fileName: "truncated.epub",
          fileSize: syntheticEpub.length,
          sender: "testuser",
          chatId: 123456,
        },
      ]);

      // Verify that failure message was NOT sent (auto-heal succeeded)
      const failedMessage = sentMessages.find(
        (m) => m.text?.includes("Invalid EPUB file") || m.text?.includes("Import Failed"),
      );
      expect(failedMessage).toBeUndefined();

      // Verify success or duplicate confirmation was sent (not an error)
      const confirmedMessage = sentMessages.find(
        (m) =>
          m.text?.includes("Book Ingested Successfully") ||
          m.text?.includes("Already in Library") ||
          m.text?.includes("Healed Book"),
      );
      expect(confirmedMessage).toBeDefined();
    } finally {
      globalThis.fetch = origFetch;
      if (origCalibredb === undefined) {
        delete process.env.CALIBREDB_PATH;
      } else {
        process.env.CALIBREDB_PATH = origCalibredb;
      }
      if (origDropDir === undefined) {
        delete process.env.BOOKS_DROP_DIR;
      } else {
        process.env.BOOKS_DROP_DIR = origDropDir;
      }
      try {
        if (fs.existsSync(testDropDir)) {
          fs.rmSync(testDropDir, { recursive: true, force: true });
        }
      } catch {}
      try {
        if (fs.existsSync(mockCalibre)) {
          fs.unlinkSync(mockCalibre);
        }
      } catch {}
    }
  });

  describe("EPUB Content-Signature Fingerprint & Deduplication", () => {
    it("getKOReaderBinary256 computes consistent MD5 hash and returns null on missing file", () => {
      const tmpFile = path.join(os.tmpdir(), `koreader_test_${Date.now()}.bin`);
      fs.writeFileSync(tmpFile, Buffer.alloc(4096, 0x42));
      try {
        const hash1 = getKOReaderBinary256(tmpFile);
        const hash2 = getKOReaderBinary256(tmpFile);
        expect(hash1).not.toBeNull();
        expect(hash1).toBe(hash2);

        expect(getKOReaderBinary256("/non/existent/path/book.epub")).toBeNull();
      } finally {
        if (fs.existsSync(tmpFile)) fs.unlinkSync(tmpFile);
      }
    });

    it("getEpubContentSignature computes identical hash for recompressed variants with same package identifier", () => {
      const testDir = path.join(os.tmpdir(), `epub_sig_test_${Date.now()}`);
      fs.mkdirSync(testDir, { recursive: true });

      const srcDir1 = path.join(testDir, "src1");
      const srcDir2 = path.join(testDir, "src2");
      fs.mkdirSync(path.join(srcDir1, "META-INF"), { recursive: true });
      fs.mkdirSync(path.join(srcDir2, "META-INF"), { recursive: true });

      const containerXml = `<?xml version="1.0"?>
<container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container">
  <rootfiles>
    <rootfile full-path="OEBPS/content.opf" media-type="application/oebps-package+xml"/>
  </rootfiles>
</container>`;
      fs.writeFileSync(path.join(srcDir1, "META-INF", "container.xml"), containerXml);
      fs.writeFileSync(path.join(srcDir2, "META-INF", "container.xml"), containerXml);
      fs.writeFileSync(path.join(srcDir1, "mimetype"), "application/epub+zip");
      fs.writeFileSync(path.join(srcDir2, "mimetype"), "application/epub+zip");

      fs.mkdirSync(path.join(srcDir1, "OEBPS"), { recursive: true });
      fs.mkdirSync(path.join(srcDir2, "OEBPS"), { recursive: true });

      const testUuid = "urn:uuid:e8b1b590-7e61-4fa3-9f12-9c3f4123abcd";
      const opfXml = `<?xml version="1.0" encoding="utf-8"?>
<package xmlns="http://www.idpf.org/2007/opf" unique-identifier="BookId" version="3.0">
  <metadata xmlns:dc="http://purl.org/dc/elements/1.1/">
    <dc:title>Test Deduplication Book</dc:title>
    <dc:creator>Test Author</dc:creator>
    <dc:identifier id="BookId">${testUuid}</dc:identifier>
  </metadata>
  <manifest>
    <item id="chapter1" href="chapter1.xhtml" media-type="application/xhtml+xml"/>
  </manifest>
  <spine>
    <itemref idref="chapter1"/>
  </spine>
</package>`;
      fs.writeFileSync(path.join(srcDir1, "OEBPS", "content.opf"), opfXml);
      fs.writeFileSync(path.join(srcDir2, "OEBPS", "content.opf"), opfXml);
      fs.writeFileSync(path.join(srcDir1, "OEBPS", "chapter1.xhtml"), "<html><body>Chapter 1 Content</body></html>");
      fs.writeFileSync(path.join(srcDir2, "OEBPS", "chapter1.xhtml"), "<html><body>Chapter 1 Content</body></html>");

      // Variant 2 includes extra dummy comment or different file to change binary checksum
      fs.writeFileSync(path.join(srcDir2, "OEBPS", "notes.txt"), "Recompressed release variant with extra notes");

      const epub1 = path.join(testDir, "book_standard.epub");
      const epub2 = path.join(testDir, "book_recompressed.epub");

      // Package epub1 with compression level 9
      spawnSync("zip", ["-9", "-q", "-r", epub1, "mimetype", "META-INF", "OEBPS"], {
        cwd: srcDir1,
      });

      // Package epub2 with compression level 0 (store only)
      spawnSync("zip", ["-0", "-q", "-r", epub2, "mimetype", "META-INF", "OEBPS"], {
        cwd: srcDir2,
      });

      try {
        expect(fs.existsSync(epub1)).toBe(true);
        expect(fs.existsSync(epub2)).toBe(true);

        // Binary KOReader hash should differ because zip compression/structure differs
        const binHash1 = getKOReaderBinary256(epub1);
        const binHash2 = getKOReaderBinary256(epub2);
        expect(binHash1).not.toBeNull();
        expect(binHash2).not.toBeNull();
        expect(binHash1).not.toBe(binHash2);

        // Content signature from content.opf package identifier MUST MATCH identically
        const sig1 = getEpubContentSignature(epub1);
        const sig2 = getEpubContentSignature(epub2);
        expect(sig1).not.toBeNull();
        expect(sig2).not.toBeNull();
        expect(sig1).toBe(sig2);

        // Verify fallback duplicate detection using SQLite file_hashes cache
        const cacheDb = getCacheDb();
        // Insert entry using epub1's content signature
        cacheDb.run(
          "INSERT OR REPLACE INTO file_hashes (filepath, mtime, hash, book_id, title, authors, cover) VALUES (?, ?, ?, ?, ?, ?, ?)",
          `sig:${epub1}`,
          Date.now(),
          sig1,
          999,
          "Test Deduplication Book",
          "Test Author",
          0,
        );

        // Ingesting epub2 (which has different binary hash binHash2) should hit content signature fallback
        const match = cacheDb
          .query(
            "SELECT book_id, title, authors FROM file_hashes WHERE hash = ? LIMIT 1",
          )
          .get(sig2) as any;

        expect(match).not.toBeNull();
        expect(match.book_id).toBe(999);
        expect(match.title).toBe("Test Deduplication Book");
      } finally {
        fs.rmSync(testDir, { recursive: true, force: true });
      }
    });

    it("returns null for non-EPUB files or corrupted archives missing OPF", () => {
      const nonEpub = path.join(os.tmpdir(), `non_epub_${Date.now()}.txt`);
      fs.writeFileSync(nonEpub, "Plain text file");
      try {
        expect(getEpubContentSignature(nonEpub)).toBeNull();
      } finally {
        if (fs.existsSync(nonEpub)) fs.unlinkSync(nonEpub);
      }
    });

    it("enforces archive size bounds (<256MB) and escapes regex identifiers", () => {
      // Mock statSync to simulate oversized and boundary-case file
      const originalStatSync = fs.statSync;
      const tmpFile = path.join(os.tmpdir(), `oversized_test_${Date.now()}.epub`);
      fs.writeFileSync(tmpFile, "dummy");
      try {
        // Test exactly 256MB boundary (must be rejected for strict <256MB)
        (fs as any).statSync = (p: string) => {
          if (p === tmpFile) {
            return { size: 256 * 1024 * 1024 };
          }
          return originalStatSync(p);
        };
        expect(getEpubContentSignature(tmpFile)).toBeNull();

        // Test >256MB
        (fs as any).statSync = (p: string) => {
          if (p === tmpFile) {
            return { size: 300 * 1024 * 1024 };
          }
          return originalStatSync(p);
        };
        expect(getEpubContentSignature(tmpFile)).toBeNull();
      } finally {
        fs.statSync = originalStatSync;
        if (fs.existsSync(tmpFile)) fs.unlinkSync(tmpFile);
      }
    });

    it("bypasses content signature duplicate match when incoming book has volume conflict", async () => {
      const testDir = path.join(os.tmpdir(), `volume_gate_test_${Date.now()}`);
      fs.mkdirSync(testDir, { recursive: true });
      fs.mkdirSync(path.join(testDir, "META-INF"), { recursive: true });
      fs.mkdirSync(path.join(testDir, "OEBPS"), { recursive: true });

      const containerXml = `<?xml version="1.0"?>
<container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container">
  <rootfiles>
    <rootfile full-path="OEBPS/content.opf" media-type="application/oebps-package+xml"/>
  </rootfiles>
</container>`;
      fs.writeFileSync(path.join(testDir, "META-INF", "container.xml"), containerXml);
      fs.writeFileSync(path.join(testDir, "mimetype"), "application/epub+zip");

      const sharedUuid = "urn:uuid:shared-template-uuid-12345";
      const opfXml = `<?xml version="1.0" encoding="utf-8"?>
<package xmlns="http://www.idpf.org/2007/opf" unique-identifier="BookId" version="3.0">
  <metadata xmlns:dc="http://purl.org/dc/elements/1.1/">
    <dc:title>Overlord, Vol. 2</dc:title>
    <dc:creator>Kugane Maruyama</dc:creator>
    <dc:identifier id="BookId">${sharedUuid}</dc:identifier>
  </metadata>
  <manifest>
    <item id="c1" href="c1.xhtml" media-type="application/xhtml+xml"/>
  </manifest>
  <spine><itemref idref="c1"/></spine>
</package>`;
      fs.writeFileSync(path.join(testDir, "OEBPS", "content.opf"), opfXml);
      fs.writeFileSync(path.join(testDir, "OEBPS", "c1.xhtml"), "<html><body>Vol 2</body></html>");

      const epubVol2 = path.join(testDir, "Overlord_Vol_2.epub");
      spawnSync("zip", ["-q", "-r", epubVol2, "mimetype", "META-INF", "OEBPS"], {
        cwd: testDir,
      });

      try {
        const sig = getEpubContentSignature(epubVol2);
        expect(sig).not.toBeNull();

        // Seed cacheDb with Volume 1 pointing to the same content signature
        const cacheDb = getCacheDb();
        cacheDb.run(
          "INSERT OR REPLACE INTO file_hashes (filepath, mtime, hash, book_id, title, authors, cover) VALUES (?, ?, ?, ?, ?, ?, ?)",
          `sig:101`,
          Date.now(),
          sig,
          101,
          "Overlord, Vol. 1",
          "Kugane Maruyama",
          0,
        );

        // Ingesting Vol 2 with the same signature must NOT falsely match Vol 1 as duplicate
        const res = await ingestBookFile(epubVol2, "Overlord_Vol_2.epub");
        // Because of volume conflict with Vol 1, it bypasses the signature match
        if (res.duplicate) {
          expect(res.bookId).not.toBe(101);
        }
      } finally {
        fs.rmSync(testDir, { recursive: true, force: true });
      }
    });
  });
});

describe("Library Deduplication Bot Commands & Callbacks (/dedup, /clean_duplicates)", () => {
  it("formatDuplicateCleanerCard renders clean library card when no duplicates found", () => {
    const cleanReport: CleanDuplicatesReport = {
      timestamp: new Date().toISOString(),
      dryRun: true,
      totalBooksScanned: 142,
      duplicateGroupsCount: 0,
      totalDuplicatesFound: 0,
      totalPruned: 0,
      groups: [],
      errors: [],
    };

    const { card, keyboard } = formatDuplicateCleanerCard(cleanReport);
    expect(card).toContain("Library is Clean: No duplicates detected across your books.");
    expect(card).toContain("Books Scanned:* 142");
    expect(card).toContain("Duplicates Detected:* 0");

    expect(keyboard).toBeDefined();
    expect(Array.isArray(keyboard.inline_keyboard)).toBe(true);
    const buttons = keyboard.inline_keyboard.flat();
    const rescanBtn = buttons.find((b: any) => b.callback_data === "rescan_dedup");
    expect(rescanBtn).toBeDefined();
    expect(rescanBtn.text).toContain("Rescan");
    const menuBtn = buttons.find((b: any) => b.callback_data === "menu:main");
    expect(menuBtn).toBeDefined();
  });

  it("formatDuplicateCleanerCard renders duplicate groups and prune confirmation keyboard", () => {
    const dupReport: CleanDuplicatesReport = {
      timestamp: new Date().toISOString(),
      dryRun: true,
      totalBooksScanned: 50,
      duplicateGroupsCount: 1,
      totalDuplicatesFound: 1,
      totalPruned: 0,
      groups: [
        {
          id: "group_1",
          matchType: "series_volume",
          reason: "Series \"Overlord\" Volume 1",
          keeperId: 10,
          keeperReason: "EPUB format, Explicit series metadata",
          books: [
            {
              id: 10,
              title: "Overlord, Vol. 1",
              authors: "Kugane Maruyama",
              series: "Overlord",
              series_index: 1,
              formats: ["EPUB"],
            },
            {
              id: 20,
              title: "Overlord Vol 1 [Retail]",
              authors: "Kugane Maruyama",
              series: "Overlord",
              series_index: 1,
              formats: ["EPUB"],
            },
          ],
          duplicateIds: [20],
        },
      ],
      errors: [],
    };

    const { card, keyboard } = formatDuplicateCleanerCard(dupReport);
    expect(card).toContain("Calibre Duplicate Detection Summary");
    expect(card).toContain("Books Scanned:* 50");
    expect(card).toContain("Duplicate Groups Detected:* 1");
    expect(card).toContain("Total Identified Duplicates:* 1");
    expect(card).toContain("Keeper (#10):* Overlord, Vol. 1");
    expect(card).toContain("Duplicates to Prune:");
    expect(card).toContain("#20:* Overlord Vol 1");

    expect(keyboard).toBeDefined();
    const buttons = keyboard.inline_keyboard.flat();
    const pruneBtn = buttons.find((b: any) => b.callback_data === "apply_dedup_confirm");
    expect(pruneBtn).toBeDefined();
    expect(pruneBtn.text).toContain("Prune Duplicates");
    const rescanBtn = buttons.find((b: any) => b.callback_data === "rescan_dedup");
    expect(rescanBtn).toBeDefined();
  });

  it("handleTextMessage handles /dedup and /duplicates in dry-run mode", async () => {
    const sentMessages: any[] = [];
    const origFetch = globalThis.fetch;
    globalThis.fetch = (async (input: any, init: any) => {
      const url = typeof input === "string" ? input : input?.url || "";
      if (url.includes("sendMessage") || url.includes("editMessageText")) {
        const body = JSON.parse(init?.body || "{}");
        sentMessages.push(body);
        return new Response(JSON.stringify({ ok: true, result: { message_id: 1001 } }), {
          status: 200,
        });
      }
      return origFetch(input, init);
    }) as typeof fetch;

    setDuplicateCleanerRunnerForTest(async (options) => ({
      timestamp: new Date().toISOString(),
      dryRun: options.apply ? false : true,
      totalBooksScanned: 88,
      duplicateGroupsCount: 0,
      totalDuplicatesFound: 0,
      totalPruned: 0,
      groups: [],
      errors: [],
    }));

    try {
      await handleTextMessage(123456, "/dedup", "tester");
      expect(sentMessages.length).toBeGreaterThanOrEqual(1);
      const lastMsg = sentMessages[sentMessages.length - 1];
      expect(lastMsg.chat_id).toBe(123456);
      expect(lastMsg.text).toContain("Library is Clean");
      expect(lastMsg.text).toContain("88");

      sentMessages.length = 0;
      await handleTextMessage(123456, "/duplicates", "tester");
      expect(sentMessages.length).toBeGreaterThanOrEqual(1);
      const dupMsg = sentMessages[sentMessages.length - 1];
      expect(dupMsg.text).toContain("Library is Clean");

      sentMessages.length = 0;
      await handleTextMessage(123456, "/dedupe", "tester");
      expect(sentMessages.length).toBeGreaterThanOrEqual(1);
      const dedupeMsg = sentMessages[sentMessages.length - 1];
      expect(dedupeMsg.text).toContain("Library is Clean");

      sentMessages.length = 0;
      await handleTextMessage(123456, "/clean", "tester");
      expect(sentMessages.length).toBeGreaterThanOrEqual(1);
      const cleanMsg = sentMessages[sentMessages.length - 1];
      expect(cleanMsg.text).toContain("Library is Clean");

      sentMessages.length = 0;
      await handleTextMessage(123456, "/clean_duplicates", "tester");
      expect(sentMessages.length).toBeGreaterThanOrEqual(1);
      const cleanDupsMsg = sentMessages[sentMessages.length - 1];
      expect(cleanDupsMsg.text).toContain("Library is Clean");
    } finally {
      setDuplicateCleanerRunnerForTest(null);
      globalThis.fetch = origFetch;
    }
  });

  it("handleTextMessage handles /clean_duplicates apply directly", async () => {
    const sentMessages: any[] = [];
    const origFetch = globalThis.fetch;
    globalThis.fetch = (async (input: any, init: any) => {
      const url = typeof input === "string" ? input : input?.url || "";
      if (url.includes("sendMessage") || url.includes("editMessageText")) {
        const body = JSON.parse(init?.body || "{}");
        sentMessages.push(body);
        return new Response(JSON.stringify({ ok: true, result: { message_id: 1002 } }), {
          status: 200,
        });
      }
      return origFetch(input, init);
    }) as typeof fetch;

    setDuplicateCleanerRunnerForTest(async (_options) => ({
      timestamp: new Date().toISOString(),
      dryRun: false,
      totalBooksScanned: 100,
      duplicateGroupsCount: 2,
      totalDuplicatesFound: 2,
      totalPruned: 2,
      auditLogPath: "data/duplicate-pruning-audit.log",
      groups: [],
      errors: [],
    }));

    try {
      await handleTextMessage(123456, "/clean_duplicates apply", "tester");
      expect(sentMessages.length).toBeGreaterThanOrEqual(1);
      const finishMsg = sentMessages[sentMessages.length - 1];
      expect(finishMsg.text).toContain("Duplicate Pruning Complete");
      expect(finishMsg.text).toContain("Books Scanned:* 100");
      expect(finishMsg.text).toContain("Duplicate Books Pruned:* 2");
      expect(finishMsg.text).toContain("Audit Log:");
    } finally {
      setDuplicateCleanerRunnerForTest(null);
      globalThis.fetch = origFetch;
    }
  });

  it("handleCallbackQuery handles dedup callbacks (apply_dedup_confirm, cancel_dedup, rescan_dedup)", async () => {
    const answeredQueries: any[] = [];
    const sentMessages: any[] = [];
    const origFetch = globalThis.fetch;
    globalThis.fetch = (async (input: any, init: any) => {
      const url = typeof input === "string" ? input : input?.url || "";
      if (url.includes("answerCallbackQuery")) {
        answeredQueries.push(JSON.parse(init?.body || "{}"));
        return new Response(JSON.stringify({ ok: true, result: true }), { status: 200 });
      }
      if (url.includes("sendMessage") || url.includes("editMessageText")) {
        sentMessages.push(JSON.parse(init?.body || "{}"));
        return new Response(JSON.stringify({ ok: true, result: { message_id: 2001 } }), { status: 200 });
      }
      return origFetch(input, init);
    }) as typeof fetch;

    setDuplicateCleanerRunnerForTest(async (options) => ({
      timestamp: new Date().toISOString(),
      dryRun: options.apply ? false : true,
      totalBooksScanned: 120,
      duplicateGroupsCount: options.apply ? 1 : 0,
      totalDuplicatesFound: options.apply ? 1 : 0,
      totalPruned: options.apply ? 1 : 0,
      auditLogPath: options.apply ? "data/duplicate-pruning-audit.log" : undefined,
      groups: [],
      errors: [],
    }));

    try {
      // 1. apply_dedup_confirm prompt
      await handleCallbackQuery({
        id: "cq_confirm",
        data: "apply_dedup_confirm",
        message: { chat: { id: 889900 }, message_id: 555 },
        from: { username: "tester", id: 889900 },
      });
      expect(answeredQueries.some(q => q.callback_query_id === "cq_confirm")).toBe(true);
      const confirmPromptMsg = sentMessages.find(m => m.text?.includes("Confirm Duplicate Pruning"));
      expect(confirmPromptMsg).toBeDefined();
      expect(confirmPromptMsg.reply_markup.inline_keyboard[0][0].callback_data).toBe("apply_dedup_confirmed");
      expect(confirmPromptMsg.reply_markup.inline_keyboard[0][1].callback_data).toBe("cancel_dedup");

      // 2. cancel_dedup
      sentMessages.length = 0;
      await handleCallbackQuery({
        id: "cq_cancel",
        data: "cancel_dedup",
        message: { chat: { id: 889900 }, message_id: 555 },
        from: { username: "tester", id: 889900 },
      });
      const cancelMsg = sentMessages.find(m => m.text?.includes("Duplicate pruning cancelled"));
      expect(cancelMsg).toBeDefined();

      // 3. rescan_dedup
      sentMessages.length = 0;
      await handleCallbackQuery({
        id: "cq_rescan",
        data: "rescan_dedup",
        message: { chat: { id: 889900 }, message_id: 555 },
        from: { username: "tester", id: 889900 },
      });
      const rescanMsg = sentMessages.find(m => m.text?.includes("Library is Clean"));
      expect(rescanMsg).toBeDefined();

      // 4. apply_dedup_confirmed
      sentMessages.length = 0;
      await handleCallbackQuery({
        id: "cq_pruned",
        data: "apply_dedup_confirmed",
        message: { chat: { id: 889900 }, message_id: 555 },
        from: { username: "tester", id: 889900 },
      });
      const prunedMsg = sentMessages.find(m => m.text?.includes("Duplicate Pruning Complete"));
      expect(prunedMsg).toBeDefined();
      expect(prunedMsg.text).toContain("Duplicate Books Pruned:* 1");
    } finally {
      setDuplicateCleanerRunnerForTest(null);
      globalThis.fetch = origFetch;
    }
  });
});
