import { describe, expect, it } from "bun:test";
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { READING_WEBAPP_URL, KOSYNC_WAN_URL, getStatusDashboard } from "./bot";

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
    const plistPath = path.join(import.meta.dir, "../scripts/com.ospeto.reading-vless-tunnel.plist");
    expect(fs.existsSync(plistPath)).toBe(true);

    const content = fs.readFileSync(plistPath, "utf8");
    expect(content).toContain("<string>com.ospeto.reading-vless-tunnel</string>");
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
    expect(content).toContain("<string>/Users/ospeto/Library/Logs/reading-vless-tunnel.log</string>");
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
    expect(html).toContain("<symbol id=\"icon-book\"");
    expect(html).toContain("<symbol id=\"icon-filter\"");
    expect(html).toContain("<symbol id=\"icon-telegram\"");
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
    expect(html).toContain("decoding=\"async\"");
    expect(html).toContain("loading=\"lazy\"");
  });

  it("index.html uses native downscaled thumbnails for cards and reserves full resolution for modal", () => {
    const htmlPath = path.join((import.meta as any).dir, "index.html");
    const html = fs.readFileSync(htmlPath, "utf8");

    // Grid cards request 360px width optimized thumbnails
    expect(html).toContain("/cover?w=360");
    // Detail modal displays full resolution cover
    expect(html).toContain("detailCover').src = book.cover ? `/api/books/${book.id}/cover` : ''");
    // Skeleton shimmer placeholder styling
    expect(html).toContain("skeleton-shimmer");
    expect(html).toContain("@keyframes shimmer");
  });
});

describe("Reverse SSH Tunnel Auto-Healing Watchdog", () => {
  const watchdogScriptPath = path.join(import.meta.dir, "../scripts/tunnel-watchdog.sh");
  const watchdogPlistPath = path.join(import.meta.dir, "../scripts/com.ospeto.reading-tunnel-watchdog.plist");

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
    expect(content).toContain("<string>com.ospeto.reading-tunnel-watchdog</string>");
    expect(content).toContain("<string>/Users/ospeto/uploader/scripts/tunnel-watchdog.sh</string>");
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
    const card = await getStatusDashboard();
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
  });
});
