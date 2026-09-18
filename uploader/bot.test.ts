import { describe, expect, it } from "bun:test";
import fs from "node:fs";
import path from "node:path";
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
} from "./bot";

describe("Telegram Mini App (TMA) Integration", () => {
  it("exports READING_WEBAPP_URL defaulting to production WAN domain", () => {
    expect(READING_WEBAPP_URL).toBeDefined();
    expect(READING_WEBAPP_URL).toBe("https://reading.wavypremium.xyz");
  });

  it("exports KOSYNC_WAN_URL defaulting to production KOSync WAN domain", () => {
    expect(KOSYNC_WAN_URL).toBeDefined();
    expect(KOSYNC_WAN_URL).toBe("https://kosync.wavypremium.xyz");
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

  it("tunnel-watchdog.sh contains health probes, auto-healing, and Telegram alert escalation", () => {
    const scriptContent = fs.readFileSync(watchdogScriptPath, "utf8");
    // Local prerequisites
    expect(scriptContent).toContain("127.0.0.1 7890");
    expect(scriptContent).toContain("LOCAL_HTTP_PORT");
    expect(scriptContent).toContain("LOCAL_KOSYNC_PORT");
    // Remote probe
    expect(scriptContent).toContain("WAN_HQ_URL");
    expect(scriptContent).toContain("PROBE_HTTP_CODE");
    // Auto-healing
    expect(scriptContent).toContain("pkill -f");
    expect(scriptContent).toContain("fuser -k");
    expect(scriptContent).toContain("restart_launchagent");
    // Failure counting and alerting
    expect(scriptContent).toContain("FAIL_COUNT_FILE");
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

    // Row 4: Hot Backup
    expect(kb.inline_keyboard[3].length).toBe(1);
    expect(kb.inline_keyboard[3][0].text).toContain("Hot Backup");
    expect(kb.inline_keyboard[3][0].callback_data).toBe("menu:backup");
  });

  it("getMainMenuText returns formatted dashboard overview", () => {
    const text = getMainMenuText();
    expect(typeof text).toBe("string");
    expect(text).toContain("Reading HQ Dashboard");
    expect(text).toContain("Open Reading HQ");
    expect(text).toContain("/f <query>");
    expect(text).toContain("/reading");
    expect(text).toContain("/recent");
    expect(text).toContain("/status");
    expect(text).toContain("/backup");
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
    expect(msg).toContain("Reading HQ Commands & Guide");
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
    expect(msg).toContain("https://kosync-198-46-146-17.sslip.io");

    // KOReader Connection Guide: OPDS
    expect(msg).toContain("OPDS Book Catalog");
    expect(msg).toContain("Search");
    expect(msg).toContain("OPDS catalog");
    expect(msg).toContain("Add new catalog");
    expect(msg).toContain("Mac Mini Library");
    expect(msg).toContain("http://192.168.31.15:8088/opds");
    expect(msg).toContain("https://calibre-198-46-146-17.sslip.io/opds");

    // Kindle Wi-Fi Proxy
    expect(msg).toContain("Kindle Wi-Fi Proxy");
    expect(msg).toContain("192.168.31.15");
    expect(msg).toContain("7890");

    // Stack Endpoints Reference
    expect(msg).toContain("KOSync Server:");
    expect(msg).toContain("Calibre OPDS Feed:");
    expect(msg).toContain("Calibre Web Reader:");
    expect(msg).toContain("http://192.168.31.15:8088");
    expect(msg).toContain("https://calibre-198-46-146-17.sslip.io");
    expect(msg).toContain("Reading HQ Dashboard:");
    expect(msg).toContain("http://192.168.31.15:8086");
    expect(msg).toContain("https://reading.wavypremium.xyz");
    expect(msg).toContain("LAN Proxy Gateway:");
    expect(msg).toContain("@saroat_ospeto_bot");
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

    // SVG icons
    expect(html).toContain('<symbol id="icon-book-open"');
    expect(html).toContain('<symbol id="icon-server"');

    // All Stack Endpoints with one-click copy buttons
    // 1. KOSync (Local & Standby VPS)
    expect(html).toContain("copyToClipboard('http://192.168.31.15:7200')");
    expect(html).toContain(
      "copyToClipboard('https://kosync-198-46-146-17.sslip.io')",
    );
    // 2. Calibre OPDS (Local & Standby VPS)
    expect(html).toContain("copyToClipboard('http://192.168.31.15:8088/opds')");
    expect(html).toContain(
      "copyToClipboard('https://calibre-198-46-146-17.sslip.io/opds')",
    );
    // 3. Calibre Web reader (Local & Standby VPS)
    expect(html).toContain("copyToClipboard('http://192.168.31.15:8088')");
    expect(html).toContain(
      "copyToClipboard('https://calibre-198-46-146-17.sslip.io')",
    );
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

