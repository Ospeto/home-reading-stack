import { describe, expect, it } from "bun:test";
import fs from "node:fs";
import path from "node:path";
import { READING_WEBAPP_URL } from "./bot";

describe("Telegram Mini App (TMA) Integration", () => {
  it("exports READING_WEBAPP_URL defaulting to production WAN domain", () => {
    expect(READING_WEBAPP_URL).toBeDefined();
    expect(READING_WEBAPP_URL).toBe("https://reading.wavypremium.xyz");
  });

  it("com.ospeto.reading-vless-tunnel.plist contains required flags and ProxyCommand", () => {
    const plistPath = path.join(import.meta.dir, "../scripts/com.ospeto.reading-vless-tunnel.plist");
    expect(fs.existsSync(plistPath)).toBe(true);

    const content = fs.readFileSync(plistPath, "utf8");
    expect(content).toContain("<string>com.ospeto.reading-vless-tunnel</string>");
    expect(content).toContain("<string>0.0.0.0:8086:127.0.0.1:8086</string>");
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
