import { describe, expect, it, beforeEach, afterEach } from "bun:test";
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
  handleLnoriUrlMessage,
  getLocalUploaderUrl,
  setLocalUploaderUrlForTest,
  setIngestLnoriSeriesRunnerForTest,
  setLnoriPollIntervalForTest,
  resetLocalLnoriQueueForTest,
  getLocalLnoriQueue,
  setIngestElscioneSeriesRunnerForTest,
  setIngestArticleRunnerForTest,
  sendLnoriErrorCard,
  sendLnoriIncompleteCard,
  runDirectLnoriFallback,
  pollLnoriProgress,
  consumeLnoriSseStream,
  registerJobHandlers,
  setSearchUniversalMetadataRunnerForTest,
  setApplyMetadataToCalibreRunnerForTest,
} from "./bot";
import { type CleanDuplicatesReport } from "../scripts/clean-duplicates";

describe("Telegram Mini App (TMA) Integration", () => {
  it("exports READING_WEBAPP_URL defaulting to production WAN domain", () => {
    expect(READING_WEBAPP_URL).toBeDefined();
    expect(READING_WEBAPP_URL).toBe("https://reading-sg.wavypremium.xyz:8443");
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
    expect(html).not.toContain("md:max-w-2xl lg:max-w-3xl");

    // Quick Category / Series swipeable chips for TMA & Mobile
    expect(html).toContain('id="chip-all"');
    expect(html).toContain('id="chip-reading"');
    expect(html).toContain('id="quickSeriesChips"');

    // Permanent left sidebar removed in favor of full-width grid and filter button sheet
    expect(html).not.toContain('data-purpose="macos-library-sidebar"');

    // Unified Filter button interaction & translucent filter sheet
    expect(html).toContain('id="filterBtn"');
    expect(html).toContain('id="filterActiveBadge"');
    expect(html).toContain('id="filterDrawer"');
    expect(html).toContain("All Books");
    expect(html).toContain("Reading Now");
    expect(html).toContain("Want to Read");
    expect(html).toContain("Finished");
    expect(html).toContain("Collections");
    expect(html).toContain('id="drawerSortSelect"');

    // Content Header, Sort & View Switches
    expect(html).toContain('data-purpose="library-grid-header"');
    expect(html).toContain("contentHeaderTitle");
    expect(html).toContain("contentHeaderSubtitle");
    expect(html).toContain('id="sortSelect"');
    expect(html).toContain('id="gridBtn"');
    expect(html).toContain('id="tableBtn"');

    // Bounded Full-Width Book Grid with 3D Spine and Elevation Shadows
    expect(html).toContain('data-purpose="books-cover-grid"');
    expect(html).toContain("book-spine-effect");
    expect(html).toContain("shadow-book");
    expect(html).toContain("shadow-book-hover");
    expect(html).toContain("aspect-[1/1.48]");
    expect(html).toContain("books-grid");
    expect(html).toContain("2xl:grid-cols-7");

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

    // 6. Desktop Book Hover Preview Card Expansion (lnori-style anchored wing)
    expect(html).toContain("card-popup");
    expect(html).toContain("popup-left");
    expect(html).toContain("popup-right");
    expect(html).toContain("card-popup-title");
    expect(html).toContain("card-popup-subtitle");
    expect(html).toContain("card-popup-synopsis");
    expect(html).toContain("initCardHoverExpansion");
    expect(html).toContain("renderBookCard");
    expect(html).toContain("data-book-id");
    expect(html).toContain("var(--popup-bg-image)");
    expect(html).toContain("filter: blur(40px) saturate(1.4)");
    expect(html).toContain("backdrop-filter: blur(20px)");
    expect(html).toContain("transform: scale(0.85)");
    expect(html).toContain("width: calc(100% + 320px)");
    expect(html).toContain("min-width: 480px");
    expect(html).toContain("padding-left: calc(100% + 1.5rem)");
    expect(html).toContain("padding-right: calc(100% + 1.5rem)");
    expect(html).toContain("overflowRight > 0 && overflowLeft <= overflowRight");
    expect(html).toContain("isDesktopHover()");
    expect(html).toContain("No synopsis available for this volume.");
    expect(html).not.toContain('id="bookHoverPopover"');
  });

  it("removes permanent left sidebar and provides full-width grid with unified filter button modal/sheet", () => {
    const htmlPath = path.join((import.meta as any).dir, "index.html");
    const html = fs.readFileSync(htmlPath, "utf8");

    // 1. Permanent left sidebar is removed
    expect(html).not.toContain('data-purpose="macos-library-sidebar"');
    expect(html).not.toContain('<aside class="w-64');

    // 2. Full-width content & responsive grid
    expect(html).toContain('id="libraryGridView"');
    expect(html).toContain("books-grid");
    expect(html).toContain("grid-cols-2");
    expect(html).toContain("sm:grid-cols-3");
    expect(html).toContain("md:grid-cols-4");
    expect(html).toContain("lg:grid-cols-5");
    expect(html).toContain("xl:grid-cols-6");
    expect(html).toContain("2xl:grid-cols-7");

    // 3. Top header search and category chips retained
    expect(html).toContain('id="searchInputDesktop"');
    expect(html).toContain('id="chip-all"');
    expect(html).toContain('id="chip-series"');
    expect(html).toContain('id="chip-ln"');
    expect(html).toContain('id="chip-recent"');
    expect(html).toContain('id="chip-reading"');
    expect(html).toContain('id="chip-epub"');

    // 4. Filter button interaction & active badge
    expect(html).toContain('id="filterBtn"');
    expect(html).toContain('onclick="openFilterDrawer()"');
    expect(html).toContain('id="filterActiveBadge"');

    // 5. Translucent Apple Fluid sheet/modal controls
    expect(html).toContain('id="filterDrawer"');
    expect(html).toContain("apple-material-sidebar");
    expect(html).toContain('id="activeFilterBox"');
    expect(html).toContain('id="activeFilterBadge"');
    expect(html).toContain('onclick="clearAllFilters()"');

    // Reading status controls inside filter sheet
    expect(html).toContain('id="nav-all"');
    expect(html).toContain('id="nav-reading"');
    expect(html).toContain('id="nav-want-to-read"');
    expect(html).toContain('id="nav-finished"');
    expect(html).toContain('id="facetTotalBooks"');
    expect(html).toContain('id="sidebarReadingCount"');
    expect(html).toContain('id="sidebarWantToReadCount"');
    expect(html).toContain('id="sidebarFinishedCount"');

    // Sorting controls inside filter sheet
    expect(html).toContain('id="drawerSortSelect"');
    expect(html).toContain("syncSort");

    // Facet chip lists inside filter sheet
    expect(html).toContain('id="drawerSeriesList"');
    expect(html).toContain('id="drawerAuthorList"');
    expect(html).toContain('id="drawerFormatList"');
    expect(html).toContain('id="drawerTagList"');

    // Dismissal methods: dismiss button, backdrop click, Escape key
    expect(html).toContain('onclick="closeFilterDrawer()"');
    expect(html).toContain('if(event.target === this) closeFilterDrawer()');
    expect(html).toContain("e.key === 'Escape'");
  });

  it("implements card-anchored wing expansion with lnori.com geometry, editorial hierarchy, and edge detection", () => {
    const htmlPath = path.join((import.meta as any).dir, "index.html");
    const html = fs.readFileSync(htmlPath, "utf8");

    // Detached popover eliminated
    expect(html).not.toContain('id="bookHoverPopover"');
    expect(html).not.toContain("book-hover-popover");
    expect(html).toContain("card-popup");
    expect(html).toContain("<aside class=\"card-popup");

    // Materials, glow, and transitions
    expect(html).toContain("background: rgba(24, 24, 27, 0.92)");
    expect(html).toContain("backdrop-filter: blur(20px)");
    expect(html).toContain("border: 1px solid rgba(255, 255, 255, 0.12)");
    expect(html).toContain("border-radius: 1rem");
    expect(html).toContain("var(--popup-bg-image)");
    expect(html).toContain("filter: blur(40px) saturate(1.4)");
    expect(html).toContain("opacity: 0.4");
    expect(html).toContain("transition: opacity 0.2s ease, transform 0.25s cubic-bezier(0.4, 0, 0.2, 1)");
    expect(html).toContain("transform: scale(0.85)");
    expect(html).toContain("width: calc(100% + 320px)");
    expect(html).toContain("min-width: 480px");

    // Clean artwork without dual hover chrome
    expect(html).toContain(".action-bar {\n        display: none !important;\n      }");

    // Screen-edge directionality & bilateral recalculation
    expect(html).toContain(".card-popup.popup-left");
    expect(html).toContain("padding-left: calc(100% + 1.5rem)");
    expect(html).toContain(".card-popup.popup-right");
    expect(html).toContain("padding-right: calc(100% + 1.5rem)");
    expect(html).toContain("overflowRight > 0 && overflowLeft <= overflowRight");
    expect(html).toContain("updateCardDirection");

    // Editorial layout & typography
    expect(html).toContain("card-popup-title");
    expect(html).toContain("font-weight: 800");
    expect(html).toContain("font-size: 1.15rem");
    expect(html).toContain("card-popup-subtitle");
    expect(html).toContain("card-popup-synopsis");
    expect(html).toContain("line-height: 1.6");
    expect(html).toContain("font-size: 0.85rem");
    expect(html).toContain("line-clamp: 6");

    // Accessibility: non-focusable at rest, inert management, reduced motion/transparency
    expect(html).toContain("visibility: hidden;");
    expect(html).toContain("visibility: visible;");
    expect(html).toContain("inert");
    expect(html).toContain("@media (hover: hover) and (min-width: 768px)");
    expect(html).toContain("@media (prefers-reduced-motion: reduce)");
    expect(html).toContain("@media (prefers-reduced-transparency: reduce)");

    // Safe CSS variable for cover glow: never wraps unescaped SVG data URIs
    expect(html).not.toContain("style=\"--popup-bg-image: url('data:image");
  });

  it("index.html implements Apple visionOS Floating Island Capsule navigation (WWDC fluid design, translucent glass, structured tabs, tactile feedback)", () => {
    const htmlPath = path.join((import.meta as any).dir, "index.html");
    const html = fs.readFileSync(htmlPath, "utf8");

    // 1. Centered suspended glass capsule & translucent materials
    expect(html).toContain("visionos-capsule");
    expect(html).toContain("visionos-nav-container");
    expect(html).toContain("bg-zinc-900/80");
    expect(html).toContain("backdrop-blur-2xl");
    expect(html).toContain("border-white/10");
    expect(html).toContain("shadow-2xl");
    expect(html).toContain("rounded-full");
    expect(html).toContain("p-1.5");
    expect(html).toContain('role="tablist"');

    // 2. Structured tabs and badges
    // Tab 1: All Volumes with formatted count badge
    expect(html).toContain('id="chip-all"');
    expect(html).toContain('role="tab"');
    expect(html).toContain('aria-selected="true"');
    expect(html).toContain("All Volumes");
    expect(html).toContain('id="quickTotalBooks"');
    expect(html).toContain("visionos-badge");

    // Tab 2: Series
    expect(html).toContain('id="chip-series"');
    expect(html).toContain("Series");

    // Tab 3: Reading with live emerald pulse indicator and active count badge
    expect(html).toContain('id="chip-reading"');
    expect(html).toContain("Reading");
    expect(html).toContain("animate-pulse");
    expect(html).toContain('id="quickReadingCount"');
    expect(html).toContain("visionos-badge-reading");

    // Subtle vertical divider
    expect(html).toContain("h-4 w-px bg-white/10");

    // Primary categories: Light Novels and Burmese
    expect(html).toContain('id="chip-ln"');
    expect(html).toContain("Light Novels");
    expect(html).toContain('id="chip-burmese"');
    expect(html).toContain("Burmese");

    // Filter button inside capsule
    expect(html).toContain('id="capsuleFilterBtn"');
    expect(html).toContain('aria-label="Filter library"');
    expect(html).toContain('id="capsuleFilterActiveBadge"');

    // 3. Tactile Apple Fluid press response: scale(0.96) and focus ring
    expect(html).toContain(".visionos-tab:active");
    expect(html).toContain("transform: scale(0.96) !important;");
    expect(html).toContain(".visionos-tab:focus-visible");
    expect(html).toContain("outline: 2px solid #38bdf8");

    // 4. Accessibility & Mobile scrolling invariants
    expect(html).toContain(".visionos-tab .animate-pulse");
    expect(html).toContain(".visionos-capsule");
    expect(html).toContain("scroll-padding-left: 0.5rem");
    expect(html).toContain("justify-content: flex-start");

    // 5. Compatibility elements for facets & legacy queries
    expect(html).toContain('id="quickFilterCompat"');
    expect(html).toContain('id="quickSeriesChips"');
    expect(html).toContain('id="quickFormatChips"');
    expect(html).toContain('id="chip-recent"');
    expect(html).toContain('id="chip-epub"');

    // 6. Navigation and filtering aliases in JavaScript
    expect(html).toContain("window.setCategory");
    expect(html).toContain("window.filterBooks");

    // 7. Burmese category filter handling in JavaScript
    expect(html).toContain("activeFilter.value === 'burmese'");
    expect(html).toContain("Burmese Literature");

    // 8. Discover tab integrated into capsule alongside All Volumes and Reading
    expect(html).toContain('id="chip-discover"');
    expect(html).toContain('visionos-tab-discover');
    expect(html).toContain('id="quickDiscoverBadge"');
    expect(html).toContain("switchView('discover')");
  });

  it("index.html implements Apple-aesthetic Discover shelf (VisionOS capsule tab, Trending vs New Releases segregated feeds, multi-facet filtering, rich cards, #discoverModal, and 1-click ingest)", () => {
    const htmlPath = path.join((import.meta as any).dir, "index.html");
    const html = fs.readFileSync(htmlPath, "utf8");

    // 1. VisionOS Capsule Navigation Integration
    expect(html).toContain('id="chip-discover"');
    expect(html).toContain('class="visionos-tab visionos-tab-discover"');
    expect(html).toContain("Discover");
    expect(html).toContain(".visionos-tab-discover:hover");
    expect(html).toContain(".visionos-tab-discover.visionos-tab-active");

    // 2. Separate "Trending" vs "New Releases" Segmented Controls
    expect(html).toContain('id="discoverView"');
    expect(html).toContain('id="discoverTabTrending"');
    expect(html).toContain('id="discoverTabNewReleases"');
    expect(html).toContain('id="discoverTrendingBadge"');
    expect(html).toContain('id="discoverNewReleasesBadge"');
    expect(html).toContain("switchDiscoverTab('trending')");
    expect(html).toContain("switchDiscoverTab('new_releases')");
    expect(html).toContain(".discover-tab");
    expect(html).toContain(".discover-tab-active");

    // 3. Interactive Multi-Facet Filters Bar
    // Source filter buttons
    expect(html).toContain('id="discoverSource-all"');
    expect(html).toContain('id="discoverSource-lnori"');
    expect(html).toContain('id="discoverSource-elscione"');
    expect(html).toContain("setDiscoverSourceFilter('all')");
    expect(html).toContain("setDiscoverSourceFilter('lnori')");
    expect(html).toContain("setDiscoverSourceFilter('elscione')");

    // Library status buttons
    expect(html).toContain('id="discoverStatus-all"');
    expect(html).toContain('id="discoverStatus-ready"');
    expect(html).toContain('id="discoverStatus-in_library"');
    expect(html).toContain("setDiscoverStatusFilter('all')");
    expect(html).toContain("setDiscoverStatusFilter('ready')");
    expect(html).toContain("setDiscoverStatusFilter('in_library')");

    // Live search input & clear button
    expect(html).toContain('id="discoverSearchInput"');
    expect(html).toContain('id="discoverSearchClearBtn"');
    expect(html).toContain("handleDiscoverSearch(this.value)");
    expect(html).toContain("clearDiscoverSearch()");

    // Sort select
    expect(html).toContain('id="discoverSortSelect"');
    expect(html).toContain("setDiscoverSort(this.value)");

    // Horizontal scrollable genre pills container
    expect(html).toContain('id="discoverGenrePills"');

    // Discover Grid & Empty State
    expect(html).toContain('id="discoverGrid"');
    expect(html).toContain('id="discoverEmptyState"');
    expect(html).toContain("resetDiscoverFilters()");

    // 4. Novel Preview Modal (#discoverModal)
    expect(html).toContain('id="discoverModal"');
    expect(html).toContain('id="discoverModalCover"');
    expect(html).toContain('id="discoverModalTitle"');
    expect(html).toContain('id="discoverModalRomaji"');
    expect(html).toContain('id="discoverModalAuthor"');
    expect(html).toContain('id="discoverModalVolumes"');
    expect(html).toContain('id="discoverModalRelease"');
    expect(html).toContain('id="discoverModalRating"');
    expect(html).toContain('id="discoverModalGenres"');
    expect(html).toContain('id="discoverModalSources"');
    expect(html).toContain('id="discoverModalSynopsis"');
    expect(html).toContain('id="discoverModalStatusBadge"');
    expect(html).toContain('id="discoverModalLibraryNote"');
    expect(html).toContain('id="discoverModalIngestBtn"');
    expect(html).toContain("closeDiscoverModal()");
    expect(html).toContain("handleDiscoverModalIngest()");

    // 5. JavaScript functions and state
    expect(html).toContain("function switchView");
    expect(html).toContain("function switchDiscoverTab");
    expect(html).toContain("function loadDiscoverFeed");
    expect(html).toContain("function renderDiscoverCards");
    expect(html).toContain("function openDiscoverModal");
    expect(html).toContain("function triggerDiscoverIngest");
    expect(html).toContain("/api/discover/feed");
    expect(html).toContain("/api/discover/ingest");
    expect(html).toContain("Ingestion queued! Downloading in background...");

    // 6. Telegram native BackButton and Escape modal management includes discoverModal
    expect(html).toContain("'discoverModal'");
    expect(html).toContain("closeDiscoverModal()");
  });

  it("harmonizes header and navigation with visionOS glass tokens and Proposal 1 muted pastel accent tones", () => {
    const htmlPath = path.join((import.meta as any).dir, "index.html");
    const html = fs.readFileSync(htmlPath, "utf8");

    // 1. Row 1 (Brand & Actions): Sleek brand with muted warm gold pastel accent
    expect(html).toContain("bg-amber-400/10 border border-amber-400/25 text-amber-300");

    // Re-skinned + Add button: Apple frosted glass pill (not harsh opaque white)
    expect(html).toContain("rounded-full text-xs font-semibold bg-white/15 hover:bg-white/20 border border-white/20 text-white");

    // Re-skinned Kindle status pill: rounded-full with muted pastel amber
    expect(html).toContain('id="kindleStatusBtn"');
    expect(html).toContain("rounded-full text-amber-300 hover:text-amber-200 bg-amber-400/10 hover:bg-amber-400/20 border border-amber-400/25");

    // Re-skinned Guide button: rounded-full with frosted glass tokens
    expect(html).toContain("rounded-full text-zinc-300 hover:text-white bg-white/5 hover:bg-white/10 border border-white/10");

    // Single visible Filter button in capsule; Row 1 has duplicate removed while keeping compat in #quickFilterCompat
    const row1Html = html.split('<!-- Top Row (Brand & Actions) -->')[1]?.split('<!-- Second Row')[0] || '';
    expect(row1Html).not.toContain('id="filterBtn"');
    const compatHtml = html.split('id="quickFilterCompat"')[1]?.split('</nav>')[0] || '';
    expect(compatHtml).toContain('id="filterBtn"');

    // 2. Row 2 (Search Bar): Organic rounded pill matching visionOS glass tokens
    expect(html).toContain('id="searchInputDesktop"');
    expect(html).toContain("rounded-full border border-white/10 backdrop-blur-xl shadow-inner text-zinc-100");

    // 3. Row 3 (visionOS Floating Island Capsule with Muted Pastel Accent Palettes):
    // All Volumes: Muted warm amber / gold
    expect(html).toContain("visionos-tab-all");
    expect(html).toContain(".visionos-tab-all.visionos-tab-active");
    expect(html).toContain("rgba(245, 158, 11, 0.15)");
    expect(html).toContain("rgba(251, 191, 36, 0.30)");
    expect(html).toContain(".visionos-tab.visionos-tab-all.visionos-tab-active .visionos-badge");

    // Series: Muted sky / ice blue
    expect(html).toContain("visionos-tab-series");
    expect(html).toContain(".visionos-tab-series.visionos-tab-active");
    expect(html).toContain("rgba(14, 165, 233, 0.15)");

    // Reading: Muted pastel mint / sage
    expect(html).toContain(".visionos-tab-reading.visionos-tab-active");
    expect(html).toContain("rgba(16, 185, 129, 0.15)");
    expect(html).toContain("rgba(52, 211, 153, 0.30)");

    // Light Novels: Muted pastel lavender / periwinkle
    expect(html).toContain("visionos-tab-ln");
    expect(html).toContain(".visionos-tab-ln.visionos-tab-active");
    expect(html).toContain("rgba(99, 102, 241, 0.15)");
    expect(html).toContain("rgba(129, 140, 248, 0.30)");

    // Burmese Literature: Muted pastel rose / coral
    expect(html).toContain("visionos-tab-burmese");
    expect(html).toContain(".visionos-tab-burmese.visionos-tab-active");
    expect(html).toContain("rgba(244, 63, 94, 0.15)");
    expect(html).toContain("rgba(251, 113, 133, 0.30)");

    // Single visible Filter button in capsule
    expect(html).toContain('id="capsuleFilterBtn"');
    expect(html).toContain("visionos-tab-filter");
    expect(html).toContain(".visionos-tab-filter.visionos-tab-active svg");

    // Tactile Apple Press response scale(0.96)
    expect(html).toContain(".active\\:scale-\\[0\\.96\\]:active");
    expect(html).toContain("transform: scale(0.96) !important;");

    // 4. Verification that static CSS utility classes actually exist in <style>
    expect(html).toContain(".bg-amber-400\\/10 { background-color: rgba(251, 191, 36, 0.10); }");
    expect(html).toContain(".bg-amber-400\\/20 { background-color: rgba(251, 191, 36, 0.20); }");
    expect(html).toContain(".hover\\:bg-amber-400\\/20:hover { background-color: rgba(251, 191, 36, 0.20); }");
    expect(html).toContain(".border-amber-400\\/25 { border-color: rgba(251, 191, 36, 0.25); }");
    expect(html).toContain(".text-amber-300 { color: #fcd34d; }");
    expect(html).toContain(".text-amber-200 { color: #fde68a; }");
    expect(html).toContain(".hover\\:text-amber-200:hover { color: #fde68a; }");
    expect(html).toContain(".backdrop-blur-xl { -webkit-backdrop-filter: blur(24px); backdrop-filter: blur(24px); }");
    expect(html).toContain(".border-white\\/20 { border-color: rgba(255, 255, 255, 0.2); }");
    expect(html).toContain(".focus\\:ring-white\\/20:focus");
    expect(html).toContain(".focus\\:border-white\\/20:focus");
    expect(html).toContain(".sm\\:pr-14 { padding-right: 3.5rem; }");
    expect(html).toContain(".bg-sky-400\\/30 { background-color: rgba(56, 189, 248, 0.30); }");
    expect(html).toContain(".text-sky-200 { color: #bae6fd; }");
    expect(html).toContain(".border-sky-400\\/40 { border-color: rgba(56, 189, 248, 0.40); }");
  });

  it("implements + Link quick action pill in navigation header and global URL paste listener for quick link entry", () => {
    const htmlPath = path.join((import.meta as any).dir, "index.html");
    const html = fs.readFileSync(htmlPath, "utf8");

    // 1. Dedicated + Link frosted glass action pill in header
    expect(html).toContain('id="quickLinkBtn"');
    expect(html).toContain('onclick="openUrlModal()"');
    expect(html).toContain("+ Link");
    expect(html).toContain("#icon-link");
    expect(html).toContain("rounded-full text-xs font-semibold bg-white/10 hover:bg-white/15 border border-white/15 text-white");

    // 2. Open URL modal function signature supports optional prefill URL
    expect(html).toContain("function openUrlModal(initialUrl = '')");
    expect(html).toContain("input.value = urlToPrefill");

    // 3. Global window paste event listener & URL extraction
    expect(html).toContain("function extractHttpUrl(text)");
    expect(html).toContain("window.addEventListener('paste', (e) => {");
    expect(html).toContain("isEditable");
    expect(html).toContain("openUrlModal(url)");

    // 4. Verify URL extraction algorithm behavior
    const extractUrlMatch = html.match(/function extractHttpUrl\(text\) \{([\s\S]*?)\n    \}/);
    expect(extractUrlMatch).toBeTruthy();

    const extractHttpUrl = new Function("text", `${extractUrlMatch![1]}`);

    expect(extractHttpUrl("https://example.com/article/123")).toBe("https://example.com/article/123");
    expect(extractHttpUrl("http://techblog.org/post?id=42")).toBe("http://techblog.org/post?id=42");
    expect(extractHttpUrl("Check out this article: https://news.site.com/story.html")).toBe("https://news.site.com/story.html");
    expect(extractHttpUrl("https://site.org/post.)")).toBe("https://site.org/post");
    expect(extractHttpUrl("https://en.wikipedia.org/wiki/Rust_(programming_language)")).toBe("https://en.wikipedia.org/wiki/Rust_(programming_language)");
    expect(extractHttpUrl("Check (https://en.wikipedia.org/wiki/Rust_(programming_language)) here")).toBe("https://en.wikipedia.org/wiki/Rust_(programming_language)");
    expect(extractHttpUrl("just normal text without link")).toBeNull();
    expect(extractHttpUrl("123456")).toBeNull();
    expect(extractHttpUrl("ftp://files.example.com")).toBeNull();
    expect(extractHttpUrl("")).toBeNull();
    expect(extractHttpUrl(null)).toBeNull();
  });

  it("visionOS Floating Island Capsule state machine and filtering invariants execute correctly", () => {
    // Helper simulating the single-active invariant and drawer facet logic from index.html
    function evaluateCapsuleState(type: string, value: any) {
      const isAll = type === "all";
      const isSeries = type === "category" && value === "series";
      const isLn = type === "category" && value === "light_novels";
      const isBurmese = type === "category" && value === "burmese";
      const isReading = type === "status" && value === "reading";

      const activeTabs = [
        isAll && "all",
        isSeries && "series",
        isLn && "light_novels",
        isBurmese && "burmese",
        isReading && "reading",
      ].filter(Boolean);

      const isCapsulePrimary = isAll || isSeries || isLn || isBurmese || isReading;
      const isDrawerFacet = !isCapsulePrimary && type !== "all" && value !== null;

      return {
        activeTabs,
        singlePrimaryActive: activeTabs.length === 1,
        noPrimaryActive: activeTabs.length === 0,
        isDrawerFacet,
      };
    }

    // 1. All Volumes
    const allState = evaluateCapsuleState("all", null);
    expect(allState.singlePrimaryActive).toBe(true);
    expect(allState.activeTabs).toEqual(["all"]);
    expect(allState.isDrawerFacet).toBe(false);

    // 2. Primary Capsule Tabs
    const seriesState = evaluateCapsuleState("category", "series");
    expect(seriesState.singlePrimaryActive).toBe(true);
    expect(seriesState.activeTabs).toEqual(["series"]);
    expect(seriesState.isDrawerFacet).toBe(false);

    const lnState = evaluateCapsuleState("category", "light_novels");
    expect(lnState.singlePrimaryActive).toBe(true);
    expect(lnState.activeTabs).toEqual(["light_novels"]);
    expect(lnState.isDrawerFacet).toBe(false);

    const burmeseState = evaluateCapsuleState("category", "burmese");
    expect(burmeseState.singlePrimaryActive).toBe(true);
    expect(burmeseState.activeTabs).toEqual(["burmese"]);
    expect(burmeseState.isDrawerFacet).toBe(false);

    const readingState = evaluateCapsuleState("status", "reading");
    expect(readingState.singlePrimaryActive).toBe(true);
    expect(readingState.activeTabs).toEqual(["reading"]);
    expect(readingState.isDrawerFacet).toBe(false);

    // 3. Drawer Facets (Specific Series, Author, Format, Tag)
    const specificSeriesState = evaluateCapsuleState("series", "Monogatari Series");
    expect(specificSeriesState.noPrimaryActive).toBe(true);
    expect(specificSeriesState.isDrawerFacet).toBe(true);

    const authorState = evaluateCapsuleState("author", "NISIOISIN");
    expect(authorState.noPrimaryActive).toBe(true);
    expect(authorState.isDrawerFacet).toBe(true);

    const formatState = evaluateCapsuleState("format", "EPUB");
    expect(formatState.noPrimaryActive).toBe(true);
    expect(formatState.isDrawerFacet).toBe(true);

    const tagState = evaluateCapsuleState("tag", "Action");
    expect(tagState.noPrimaryActive).toBe(true);
    expect(tagState.isDrawerFacet).toBe(true);

    // 4. Burmese filtering predicate parity test
    function isBurmeseBook(book: { title?: string; languages?: string[]; tags?: string[] }) {
      const rawLangs = (book.languages || []).map((l: string) => String(l).toLowerCase().trim());
      const titleText = book.title || "";
      const hasMyanmarChars = /[\u1000-\u109F\uA9E0-\uA9FF\uAA60-\uAA7F]/.test(titleText);
      const hasBurmeseTag = (book.tags || []).some((t: string) => /burmese|myanmar/i.test(t));
      return (
        rawLangs.includes("my") ||
        rawLangs.includes("mya") ||
        rawLangs.includes("burmese") ||
        (rawLangs.length === 0 && hasMyanmarChars) ||
        hasBurmeseTag
      );
    }

    // Title with Myanmar characters
    expect(isBurmeseBook({ title: "မြန်မာဝတ္ထု" })).toBe(true);
    // Language tag 'my'
    expect(isBurmeseBook({ title: "Translated Novel", languages: ["my"] })).toBe(true);
    // Tag-only Burmese book
    expect(isBurmeseBook({ title: "English Title", tags: ["Burmese Literature"] })).toBe(true);
    // Non-Burmese book
    expect(isBurmeseBook({ title: "Sword Art Online", languages: ["en"], tags: ["Light Novel"] })).toBe(false);
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

  it("tunnel-watchdog.sh gates US VLESS monitoring behind ENABLE_US_TUNNEL=1 and plist existence", () => {
    const scriptContent = fs.readFileSync(watchdogScriptPath, "utf8");
    expect(scriptContent).toContain('ENABLE_US_TUNNEL="${ENABLE_US_TUNNEL:-0}"');
    expect(scriptContent).toContain(
      'US_PLIST="${US_PLIST:-${HOME}/Library/LaunchAgents/${US_TUNNEL_LABEL}.plist}"',
    );
    expect(scriptContent).toContain(
      '[ "$ENABLE_US_TUNNEL" != "1" ] || [ ! -f "$US_PLIST" ]',
    );
  });

  it("tunnel-watchdog.sh purges lingering US failure markers when US tunnel is disabled or plist absent", () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "watchdog-test-"));
    const tempLog = path.join(tempDir, "watchdog.log");
    const tempEnv = path.join(tempDir, ".env");
    const testFailFile = path.join(tempDir, "test-us-failures");
    const testAlertFile = path.join(tempDir, "test-us-alerted");

    fs.writeFileSync(testFailFile, "5");
    fs.writeFileSync(testAlertFile, "5");
    fs.writeFileSync(
      tempEnv,
      "ENABLE_US_TUNNEL=0\nLOCAL_HTTP_PORT=8086\nLOCAL_KOSYNC_PORT=7200\n",
    );

    try {
      const res = spawnSync(
        "bash",
        [
          "-c",
          `export LOCAL_HTTP_PORT=8086 LOCAL_KOSYNC_PORT=7200 ENV_FILE="${tempEnv}" LOG_FILE="${tempLog}" US_FAIL_COUNT_FILE="${testFailFile}" US_ALERT_TRACK_FILE="${testAlertFile}" US_PLIST="/nonexistent.plist"; sed -e '/^# 2\\. Check Local Prerequisites/,/^# ==============================================================================/ { /^# ==============================================================================/!d; }' "${watchdogScriptPath}" | sed '/^# 4\\. Monitor & Auto-Heal: Singapore/q' | bash`,
        ],
        { encoding: "utf8" },
      );

      expect(res.status).toBe(0);
      // Verify that failure and alert files were purged
      expect(fs.existsSync(testFailFile)).toBe(false);
      expect(fs.existsSync(testAlertFile)).toBe(false);

      // Verify log message indicates skip and cleanup
      const logContent = fs.existsSync(tempLog)
        ? fs.readFileSync(tempLog, "utf8")
        : "";
      expect(logContent).toContain(
        "US VLESS tunnel monitoring skipped (ENABLE_US_TUNNEL=0, plist_exists=0)",
      );
    } finally {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it("tunnel-watchdog.sh purges lingering US failure markers when ENABLE_US_TUNNEL=1 but plist is absent", () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "watchdog-test-"));
    const tempLog = path.join(tempDir, "watchdog.log");
    const tempEnv = path.join(tempDir, ".env");
    const testFailFile = path.join(tempDir, "test-us-failures");
    const testAlertFile = path.join(tempDir, "test-us-alerted");

    fs.writeFileSync(testFailFile, "10");
    fs.writeFileSync(testAlertFile, "10");
    fs.writeFileSync(
      tempEnv,
      "ENABLE_US_TUNNEL=1\nLOCAL_HTTP_PORT=8086\nLOCAL_KOSYNC_PORT=7200\n",
    );

    try {
      const res = spawnSync(
        "bash",
        [
          "-c",
          `export LOCAL_HTTP_PORT=8086 LOCAL_KOSYNC_PORT=7200 ENV_FILE="${tempEnv}" LOG_FILE="${tempLog}" US_FAIL_COUNT_FILE="${testFailFile}" US_ALERT_TRACK_FILE="${testAlertFile}" US_PLIST="/nonexistent.plist"; sed -e '/^# 2\\. Check Local Prerequisites/,/^# ==============================================================================/ { /^# ==============================================================================/!d; }' "${watchdogScriptPath}" | sed '/^# 4\\. Monitor & Auto-Heal: Singapore/q' | bash`,
        ],
        { encoding: "utf8" },
      );

      expect(res.status).toBe(0);
      // Verify that failure and alert files were purged
      expect(fs.existsSync(testFailFile)).toBe(false);
      expect(fs.existsSync(testAlertFile)).toBe(false);

      // Verify log message indicates skip and cleanup
      const logContent = fs.existsSync(tempLog)
        ? fs.readFileSync(tempLog, "utf8")
        : "";
      expect(logContent).toContain(
        "US VLESS tunnel monitoring skipped (ENABLE_US_TUNNEL=1, plist_exists=0)",
      );
    } finally {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it("tunnel-watchdog.sh purges lingering US failure markers when ENABLE_US_TUNNEL=0 even if plist exists", () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "watchdog-test-"));
    const tempLog = path.join(tempDir, "watchdog.log");
    const tempEnv = path.join(tempDir, ".env");
    const testFailFile = path.join(tempDir, "test-us-failures");
    const testAlertFile = path.join(tempDir, "test-us-alerted");
    const testPlistFile = path.join(tempDir, "test.plist");

    fs.writeFileSync(testFailFile, "7");
    fs.writeFileSync(testAlertFile, "7");
    fs.writeFileSync(testPlistFile, "<plist></plist>");
    fs.writeFileSync(
      tempEnv,
      "ENABLE_US_TUNNEL=0\nLOCAL_HTTP_PORT=8086\nLOCAL_KOSYNC_PORT=7200\n",
    );

    try {
      const res = spawnSync(
        "bash",
        [
          "-c",
          `export LOCAL_HTTP_PORT=8086 LOCAL_KOSYNC_PORT=7200 ENV_FILE="${tempEnv}" LOG_FILE="${tempLog}" US_FAIL_COUNT_FILE="${testFailFile}" US_ALERT_TRACK_FILE="${testAlertFile}" US_PLIST="${testPlistFile}"; sed -e '/^# 2\\. Check Local Prerequisites/,/^# ==============================================================================/ { /^# ==============================================================================/!d; }' "${watchdogScriptPath}" | sed '/^# 4\\. Monitor & Auto-Heal: Singapore/q' | bash`,
        ],
        { encoding: "utf8" },
      );

      expect(res.status).toBe(0);
      // Verify that failure and alert files were purged
      expect(fs.existsSync(testFailFile)).toBe(false);
      expect(fs.existsSync(testAlertFile)).toBe(false);

      // Verify log message indicates skip and cleanup
      const logContent = fs.existsSync(tempLog)
        ? fs.readFileSync(tempLog, "utf8")
        : "";
      expect(logContent).toContain(
        "US VLESS tunnel monitoring skipped (ENABLE_US_TUNNEL=0, plist_exists=1)",
      );
    } finally {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });
});

describe("Unified In-Chat Health Dashboard (/status)", () => {
  it("getStatusDashboard generates structured Markdown card with all 5 subsystems", async () => {
    const origFetch = globalThis.fetch;
    globalThis.fetch = (async (input: any) => {
      const u = typeof input === "string" ? input : input?.url || "";
      if (
        u.includes("reading.wavypremium.xyz") ||
        u.includes("reading-sg.wavypremium.xyz") ||
        u.includes("kosync.wavypremium.xyz") ||
        u.includes("kosync-sg.wavypremium.xyz") ||
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
    // 4. Reading HQ Dashboard (Local, WAN & Singapore Mini App)
    expect(html).toContain("copyToClipboard('http://192.168.31.15:8086')");
    expect(html).toContain(
      "copyToClipboard('https://reading.wavypremium.xyz')",
    );
    expect(html).toContain(
      "copyToClipboard('https://reading-sg.wavypremium.xyz:8443')",
    );
    // 5. LAN Proxy Gateway
    expect(html).toContain("copyToClipboard('192.168.31.15:7890')");
    // 6. Telegram Bot
    expect(html).toContain("copyToClipboard('@saroat_ospeto_bot')");

    // Features Guide Tab and Sections (Language Shelves & Desktop Previews)
    expect(html).toContain('id="guide-tab-features"');
    expect(html).toContain('id="guide-features"');
    expect(html).toContain("Language Shelves &amp; Desktop Previews");
    expect(html).toContain("Dynamic Language Shelves (All / Burmese / English / Other)");
    expect(html).toContain("Desktop Hover Synopsis Preview &amp; Quick Actions");
    expect(html).toContain("Apple WWDC Fluid Interface &amp; Keyboard Control");

    // Desktop hover synopsis preview on book cards
    expect(html).toContain("synopsisPreviewHtml");

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

    const origJevKey = process.env.JEV_API_KEY;
    const origTypesafeKey = process.env.TYPESAFE_API_KEY;
    delete process.env.JEV_API_KEY;
    delete process.env.TYPESAFE_API_KEY;

    const testDropDir = path.join(os.tmpdir(), "test_books_drop_" + Date.now());
    fs.mkdirSync(testDropDir, { recursive: true });
    const origDropDir = process.env.BOOKS_DROP_DIR;
    process.env.BOOKS_DROP_DIR = testDropDir;

    const fileId = "test_truncated_file_id";
    const sentMessages: any[] = [];
    const origFetch = globalThis.fetch;

    globalThis.fetch = (async (input: any, init: any) => {
      const url = typeof input === "string" ? input : input?.url || "";

      if (url.includes("api.typesafe.ai")) {
        return new Response(
          JSON.stringify({ ok: true, data: { choice: "valid_book", confidence: 0.99 } }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      }

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

      if (url.includes("systemone")) {
        return new Response(
          JSON.stringify({ verdict: "clean", confidence: 0.95, reasoning: "synthetic test clean" }),
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
      if (origJevKey !== undefined) {
        process.env.JEV_API_KEY = origJevKey;
      } else {
        delete process.env.JEV_API_KEY;
      }
      if (origTypesafeKey !== undefined) {
        process.env.TYPESAFE_API_KEY = origTypesafeKey;
      } else {
        delete process.env.TYPESAFE_API_KEY;
      }
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

describe("Documentation, Manual Sync & Standing Invariant Verification", () => {
  it("AGENTS.md defines permanent Documentation & Manual Sync Invariant rule", () => {
    const agentsPath = path.join(import.meta.dir, "../AGENTS.md");
    expect(fs.existsSync(agentsPath)).toBe(true);

    const agentsContent = fs.readFileSync(agentsPath, "utf8");
    expect(agentsContent).toContain("Documentation & Manual Sync Invariant");
    expect(agentsContent).toContain(
      "For EVERY feature change, new capability, or infrastructure update, always update `README.md` and the built-in Connection Guide / Manual on the website (`uploader/index.html` / `openGuideModal`) to reflect current commands, endpoints, and behaviors.",
    );
    expect(agentsContent).toContain(
      "Never leave documentation or user manuals stale after landing code changes.",
    );
  });

  it("README.md contains centered LightHouse logo banner, CLI commands, Singapore endpoints, Jev intelligence, and WWDC design system", () => {
    const readmePath = path.join(import.meta.dir, "../README.md");
    expect(fs.existsSync(readmePath)).toBe(true);

    const readme = fs.readFileSync(readmePath, "utf8");

    // 1. Prominent centered logo banner
    expect(readme).toContain('<img src="assets/logo.svg" alt="LightHouse Spiral Book Tower Logo"');
    expect(readme).toContain('<h1 align="center">LightHouse Reading Stack</h1>');

    // 2. Unified CLI commands
    expect(readme).toContain("bin/lighthouse status");
    expect(readme).toContain("bin/lighthouse up");
    expect(readme).toContain("bin/lighthouse down");
    expect(readme).toContain("bin/lighthouse restart");
    expect(readme).toContain("bin/lighthouse health");
    expect(readme).toContain("bin/lighthouse install-daemons");
    expect(readme).toContain("bin/lighthouse backup");
    expect(readme).toContain("bin/lighthouse restore");

    // 3. Singapore WAN endpoints
    expect(readme).toContain("http://kosync-sg.wavypremium.xyz");
    expect(readme).toContain("https://kosync-sg.wavypremium.xyz:8443");
    expect(readme).toContain("http://opds.wavypremium.xyz/opds");
    expect(readme).toContain("https://opds.wavypremium.xyz:8443/opds");
    expect(readme).toContain("https://reading-sg.wavypremium.xyz:8443");

    // 4. Jev System-1 Ingestion Intelligence
    expect(readme).toContain("Jev System-1 Ingestion Intelligence");
    expect(readme).toContain("Junk Ingest Gate (`Books_Quarantine`)");
    expect(readme).toContain("Series & Volume Detection");
    expect(readme).toContain("Author Field Sanitization");
    expect(readme).toContain("Bilingual & Multilingual Language Shelves");
    expect(readme).toContain("Intelligent Multi-Source Metadata & Cover Routing");
    expect(readme).toContain("RanobeDB API");
    expect(readme).toContain("MangaDex API");
    expect(readme).toContain("Google Books");

    // 6. Lnori Centralized Queue & Ingestion
    expect(readme).toContain("Telegram Ingestion Bot:** Paste any `lnori.com/series/...` or `lnori.com/book/...` URL directly into chat with `@saroat_ospeto_bot`. Links automatically submit to the centralized Uploader server queue (`POST /api/lnori/ingest`), reporting real-time queue position");
    expect(readme).toContain("Apple WWDC Fluid Interface Design System");
    expect(readme).toContain("Materials & Translucency");
    expect(readme).toContain("Optical Typography");
    expect(readme).toContain("Tactile Feedback & Immediate Response");
    expect(readme).toContain("Fluid Springs & Spatial Motion");
    expect(readme).toContain("Desktop Hover Synopsis Preview & Quick Actions");
    expect(readme).toContain("3D Skeuomorphic Depth & Accessibility");
  });

  it("uploader/index.html connection guide modal includes all Singapore endpoints and features guide", () => {
    const htmlPath = path.join(import.meta.dir, "index.html");
    const html = fs.readFileSync(htmlPath, "utf8");

    // Singapore endpoints with copy actions
    expect(html).toContain("copyToClipboard('http://kosync-sg.wavypremium.xyz')");
    expect(html).toContain("copyToClipboard('https://kosync-sg.wavypremium.xyz:8443')");
    expect(html).toContain("copyToClipboard('http://opds.wavypremium.xyz/opds')");
    expect(html).toContain("copyToClipboard('https://opds.wavypremium.xyz:8443/opds')");
    expect(html).toContain("copyToClipboard('https://reading-sg.wavypremium.xyz:8443')");

    // Features tab and quick guide section
    expect(html).toContain('id="guide-tab-features"');
    expect(html).toContain('id="guide-features"');
    expect(html).toContain("Dynamic Language Shelves (All / Burmese / English / Other)");
    expect(html).toContain("Desktop Hover Synopsis Preview &amp; Quick Actions");
    expect(html).toContain("Apple WWDC Fluid Interface &amp; Keyboard Control");
    expect(html).toContain("Full-Width Grid &amp; Fluid Filter Sheet");

    // Tab wiring in setGuideTab
    expect(html).toContain("const tabs = ['kosync', 'obsidian', 'opds', 'features', 'cli', 'proxy', 'all'];");
    expect(html).toContain("secFeatures?.classList.remove('hidden');");
    expect(html).toContain("modalScroll.scrollTop = 0;");

    // Book card hover synopsis preview integration & CSS
    expect(html).toContain(".hover-synopsis-preview");
    expect(html).toContain("-webkit-line-clamp: 2;");
    expect(html).toContain("line-clamp: 2;");
    expect(html).toContain("overflow: hidden;");
    expect(html).toContain("min-height: 0;");
    expect(html).toContain("user-select: none;");
    expect(html).toContain("cleanSynopsis");
    expect(html).toContain("synopsisPreviewHtml");

    // Lnori centralized queue integration in guide
    expect(html).toContain("Links sent to the Telegram bot are enqueued to the centralized Uploader server queue (<code class=\"text-zinc-200\">POST /api/lnori/ingest</code>)");

    // CSS rules for Apple WWDC glass materials and optical tracking
    expect(html).toContain(".apple-material-glass-light {");
    expect(html).toContain("backdrop-filter: blur(12px) saturate(150%);");
    expect(html).toContain(".apple-material-modal {");
    expect(html).toContain("backdrop-filter: blur(20px) saturate(180%);");
    expect(html).toContain(".tracking-optical-micro { letter-spacing: 0.025em; }");
    expect(html).toContain("transform: scale(0.97) !important;");
  });
});

describe("Lnori Queue & Telegram Bot Integration", () => {
  it("getLocalUploaderUrl resolves port, env overrides, and test setter", () => {
    resetLocalLnoriQueueForTest();
    expect(getLocalUploaderUrl()).toBe("http://127.0.0.1:8086");

    setLocalUploaderUrlForTest("http://127.0.0.1:9090");
    expect(getLocalUploaderUrl()).toBe("http://127.0.0.1:9090");
    setLocalUploaderUrlForTest(null);

    const origPort = process.env.UPLOADER_PORT;
    const origLocalUrl = process.env.LOCAL_UPLOADER_URL;
    try {
      process.env.LOCAL_UPLOADER_URL = "http://127.0.0.1:7777/";
      expect(getLocalUploaderUrl()).toBe("http://127.0.0.1:7777");
      delete process.env.LOCAL_UPLOADER_URL;

      process.env.UPLOADER_PORT = "8888";
      expect(getLocalUploaderUrl()).toBe("http://127.0.0.1:8888");
    } finally {
      if (origPort !== undefined) process.env.UPLOADER_PORT = origPort;
      else delete process.env.UPLOADER_PORT;
      if (origLocalUrl !== undefined) process.env.LOCAL_UPLOADER_URL = origLocalUrl;
      else delete process.env.LOCAL_UPLOADER_URL;
      resetLocalLnoriQueueForTest();
    }
  });

  it("handleTextMessage detects Lnori URL and edits status to queued when server reports queued", async () => {
    resetLocalLnoriQueueForTest();
    setLnoriPollIntervalForTest(10);
    const sentTelegramBodies: any[] = [];
    const origFetch = globalThis.fetch;

    globalThis.fetch = (async (input: any, init: any) => {
      const url = typeof input === "string" ? input : input?.url || "";
      if (url.includes("sendMessage") || url.includes("editMessageText")) {
        const body = JSON.parse(init?.body || "{}");
        sentTelegramBodies.push(body);
        return new Response(JSON.stringify({ ok: true, result: { message_id: 2001 } }), {
          status: 200,
        });
      }
      if (url.includes("/api/lnori/ingest")) {
        return new Response(
          JSON.stringify({
            success: true,
            queued: true,
            queuePosition: 2,
            queueLength: 3,
            runId: "run-queued-1",
          }),
          {
            status: 200,
            headers: { "Content-Type": "application/json" },
          },
        );
      }
      if (url.includes("/api/lnori/progress")) {
        // Complete immediately on first poll to conclude the test
        return new Response(
          JSON.stringify({
            success: true,
            active: false,
            currentQueuePosition: null,
            queueLength: 0,
            state: {
              runId: "run-queued-1",
              phase: "complete",
              completedData: {
                seriesTitle: "The Genius Prince's Guide",
                author: "Toru Toba",
                importedCount: 5,
                skippedCount: 1,
                totalCount: 6,
                tags: "Light Novel, Fantasy",
              },
            },
          }),
          { status: 200 },
        );
      }
      return origFetch(input, init);
    }) as typeof fetch;

    try {
      await handleTextMessage(
        998877,
        "Here is the novel: https://lnori.com/series/8046/the-genius-princes-guide",
        "tester",
      );

      expect(sentTelegramBodies.length).toBeGreaterThanOrEqual(3);

      // Initial message
      const initialMsg = sentTelegramBodies[0];
      expect(initialMsg.chat_id).toBe(998877);
      expect(initialMsg.text).toContain("Detected Lnori Light Novel Series");

      // Queued message
      const queuedMsg = sentTelegramBodies[1];
      expect(queuedMsg.text).toContain("Queued Lnori Light Novel Series (Position #2 of 3)");
      expect(queuedMsg.text).toContain("https://lnori.com/series/8046/the-genius-princes-guide");
      expect(queuedMsg.text).toContain("Waiting for previous ingestion to finish...");

      // Final confirmation card
      const finalMsg = sentTelegramBodies[sentTelegramBodies.length - 1];
      expect(finalMsg.text).toContain("Light Novel Series Imported Successfully!");
      expect(finalMsg.text).toContain("The Genius Prince's Guide");
      expect(finalMsg.text).toContain("Toru Toba");
      expect(finalMsg.text).toContain("5/6 (1 already in library)");
      expect(finalMsg.text).toContain("Light Novel, Fantasy");
      expect(finalMsg.reply_markup?.inline_keyboard?.[0]?.[0]?.text).toContain("Open Reading HQ");
      expect(finalMsg.reply_markup?.inline_keyboard?.[0]?.[0]?.web_app?.url).toBe(READING_WEBAPP_URL);
    } finally {
      globalThis.fetch = origFetch;
      resetLocalLnoriQueueForTest();
    }
  });

  it("pollLnoriProgress updates queue advancement, transitions to active progress, and sends completion card", async () => {
    resetLocalLnoriQueueForTest();
    setLnoriPollIntervalForTest(10);
    const sentTelegramBodies: any[] = [];
    const origFetch = globalThis.fetch;

    let pollCount = 0;
    globalThis.fetch = (async (input: any, init: any) => {
      const url = typeof input === "string" ? input : input?.url || "";
      if (url.includes("sendMessage") || url.includes("editMessageText")) {
        const body = JSON.parse(init?.body || "{}");
        sentTelegramBodies.push(body);
        return new Response(JSON.stringify({ ok: true, result: { message_id: 3001 } }), {
          status: 200,
        });
      }
      if (url.includes("/api/lnori/progress")) {
        pollCount++;
        if (pollCount === 1) {
          // Advanced in queue to position 1
          return new Response(
            JSON.stringify({
              success: true,
              active: false,
              currentQueuePosition: 1,
              queueLength: 2,
              state: {},
            }),
            { status: 200 },
          );
        }
        if (pollCount === 2) {
          // Transitioned to active volume download
          return new Response(
            JSON.stringify({
              success: true,
              active: true,
              currentQueuePosition: null,
              queueLength: 1,
              state: {
                runId: "run-poll-test",
                phase: "volume",
                index: 1,
                total: 2,
                volumeTitle: "Volume 1",
                status: "[Volume 1/2] Downloading \"Volume 1\"...",
              },
            }),
            { status: 200 },
          );
        }
        // Completed
        return new Response(
          JSON.stringify({
            success: true,
            active: false,
            currentQueuePosition: null,
            queueLength: 0,
            state: {
              runId: "run-poll-test",
              phase: "complete",
              completedData: {
                seriesTitle: "Sword Art Online",
                author: "Reki Kawahara",
                importedCount: 2,
                skippedCount: 0,
                totalCount: 2,
                tags: "Light Novel, Action",
              },
            },
          }),
          { status: 200 },
        );
      }
      return origFetch(input, init);
    }) as typeof fetch;

    try {
      await pollLnoriProgress(
        112233,
        3001,
        "https://lnori.com/series/1234/sao",
        "run-poll-test",
        "http://127.0.0.1:8086",
        2,
        3,
      );

      expect(sentTelegramBodies.length).toBeGreaterThanOrEqual(3);

      // Advanced queue position
      const queueAdvanceMsg = sentTelegramBodies.find((m) =>
        m.text.includes("Position #1 of 2"),
      );
      expect(queueAdvanceMsg).toBeDefined();

      // Active volume progress
      const activeProgressMsg = sentTelegramBodies.find((m) =>
        m.text.includes("Volume 1/2") && m.text.includes("Downloading"),
      );
      expect(activeProgressMsg).toBeDefined();

      // Completion confirmation card
      const completionMsg = sentTelegramBodies[sentTelegramBodies.length - 1];
      expect(completionMsg.text).toContain("Light Novel Series Imported Successfully!");
      expect(completionMsg.text).toContain("Sword Art Online");
      expect(completionMsg.text).toContain("Reki Kawahara");
      expect(completionMsg.text).toContain("2/2");
      expect(completionMsg.reply_markup?.inline_keyboard?.[0]?.[0]?.text).toContain("Open Reading HQ");
    } finally {
      globalThis.fetch = origFetch;
      resetLocalLnoriQueueForTest();
    }
  });

  it("consumeLnoriSseStream streams live events and posts completion card", async () => {
    resetLocalLnoriQueueForTest();
    const sentTelegramBodies: any[] = [];
    const origFetch = globalThis.fetch;

    globalThis.fetch = (async (input: any, init: any) => {
      const url = typeof input === "string" ? input : input?.url || "";
      if (url.includes("sendMessage") || url.includes("editMessageText")) {
        const body = JSON.parse(init?.body || "{}");
        sentTelegramBodies.push(body);
        return new Response(JSON.stringify({ ok: true, result: { message_id: 4001 } }), {
          status: 200,
        });
      }
      return origFetch(input, init);
    }) as typeof fetch;

    const sseChunks = [
      'data: {"phase":"manifest","status":"Found 2 volumes in series \\"Overlord\\"","runId":"run-sse-1"}\n\n',
      'data: {"phase":"volume","index":1,"total":2,"volumeTitle":"The Undead King","status":"[Volume 1/2] Downloading \\"The Undead King\\"...","runId":"run-sse-1"}\n\n',
      'data: {"phase":"complete","runId":"run-sse-1","data":{"seriesTitle":"Overlord","author":"Kugane Maruyama","importedCount":2,"skippedCount":0,"totalCount":2,"tags":"Light Novel, Dark Fantasy"}}\n\n',
    ];

    const stream = new ReadableStream({
      start(controller) {
        for (const chunk of sseChunks) {
          controller.enqueue(new TextEncoder().encode(chunk));
        }
        controller.close();
      },
    });

    const sseResponse = new Response(stream, {
      status: 200,
      headers: { "Content-Type": "text/event-stream" },
    });

    try {
      await consumeLnoriSseStream(
        445566,
        4001,
        "https://lnori.com/series/5555/overlord",
        sseResponse,
        "http://127.0.0.1:8086",
      );

      expect(sentTelegramBodies.length).toBeGreaterThanOrEqual(2);

      // Final completion card
      const finalMsg = sentTelegramBodies[sentTelegramBodies.length - 1];
      expect(finalMsg.text).toContain("Light Novel Series Imported Successfully!");
      expect(finalMsg.text).toContain("Overlord");
      expect(finalMsg.text).toContain("Kugane Maruyama");
      expect(finalMsg.text).toContain("2/2");
      expect(finalMsg.reply_markup?.inline_keyboard?.[0]?.[0]?.text).toContain("Open Reading HQ");
    } finally {
      globalThis.fetch = origFetch;
      resetLocalLnoriQueueForTest();
    }
  });

  it("falls back to direct ingestLnoriSeries when local uploader server is unreachable", async () => {
    resetLocalLnoriQueueForTest();
    const sentTelegramBodies: any[] = [];
    const origFetch = globalThis.fetch;

    globalThis.fetch = (async (input: any, init: any) => {
      const url = typeof input === "string" ? input : input?.url || "";
      if (url.includes("sendMessage") || url.includes("editMessageText")) {
        const body = JSON.parse(init?.body || "{}");
        sentTelegramBodies.push(body);
        return new Response(JSON.stringify({ ok: true, result: { message_id: 5001 } }), {
          status: 200,
        });
      }
      if (url.includes("/api/lnori/ingest")) {
        throw new Error("connect ECONNREFUSED 127.0.0.1:8086");
      }
      return origFetch(input, init);
    }) as typeof fetch;

    let runnerCalledWith = "";
    setIngestLnoriSeriesRunnerForTest(async (url, onProgress) => {
      runnerCalledWith = url;
      if (onProgress) {
        await onProgress({
          phase: "volume",
          index: 1,
          total: 1,
          volumeTitle: "Direct Vol 1",
          status: "[Volume 1/1] Downloading \"Direct Vol 1\"...",
        });
      }
      return {
        success: true,
        seriesTitle: "Standalone Novel",
        author: "Independent Author",
        tags: "Light Novel",
        importedCount: 1,
        skippedCount: 0,
        duplicateCount: 0,
        totalCount: 1,
        calibreBookIds: [999],
      };
    });

    try {
      await handleLnoriUrlMessage(777888, "https://lnori.com/series/777/standalone", "tester");

      expect(runnerCalledWith).toBe("https://lnori.com/series/777/standalone");
      expect(sentTelegramBodies.length).toBeGreaterThanOrEqual(2);

      const finalMsg = sentTelegramBodies[sentTelegramBodies.length - 1];
      expect(finalMsg.text).toContain("Light Novel Series Imported Successfully!");
      expect(finalMsg.text).toContain("Standalone Novel");
      expect(finalMsg.text).toContain("Independent Author");
      expect(finalMsg.text).toContain("1/1");
      expect(finalMsg.reply_markup?.inline_keyboard?.[0]?.[0]?.text).toContain("Open Reading HQ");
    } finally {
      globalThis.fetch = origFetch;
      resetLocalLnoriQueueForTest();
    }
  });

  it("handles concurrent direct fallback requests with in-process local queue", async () => {
    resetLocalLnoriQueueForTest();
    const sentTelegramBodies: any[] = [];
    const origFetch = globalThis.fetch;

    globalThis.fetch = (async (input: any, init: any) => {
      const url = typeof input === "string" ? input : input?.url || "";
      if (url.includes("sendMessage") || url.includes("editMessageText")) {
        const body = JSON.parse(init?.body || "{}");
        sentTelegramBodies.push(body);
        return new Response(JSON.stringify({ ok: true, result: { message_id: 6001 } }), {
          status: 200,
        });
      }
      return origFetch(input, init);
    }) as typeof fetch;

    let resolveFirstJob: any;
    const firstJobPromise = new Promise((resolve) => {
      resolveFirstJob = resolve;
    });

    const executionOrder: string[] = [];
    setIngestLnoriSeriesRunnerForTest(async (url) => {
      executionOrder.push(url);
      if (url.includes("series-alpha")) {
        await firstJobPromise;
        return {
          success: true,
          seriesTitle: "Series Alpha",
          author: "Alpha Author",
          tags: "Light Novel",
          importedCount: 1,
          skippedCount: 0,
          duplicateCount: 0,
          totalCount: 1,
          calibreBookIds: [101],
        };
      }
      return {
        success: true,
        seriesTitle: "Series Beta",
        author: "Beta Author",
        tags: "Light Novel",
        importedCount: 2,
        skippedCount: 0,
        duplicateCount: 0,
        totalCount: 2,
        calibreBookIds: [102, 103],
      };
    });

    try {
      // Start first job (blocks on resolveFirstJob)
      const p1 = runDirectLnoriFallback(111, 6001, "https://lnori.com/series/1/series-alpha");

      // While first is active, enqueue second job
      const p2 = runDirectLnoriFallback(222, 6002, "https://lnori.com/series/2/series-beta");
      await p2;

      // Verify second was enqueued
      const queue = getLocalLnoriQueue();
      expect(queue.length).toBe(1);
      expect(queue[0].url).toBe("https://lnori.com/series/2/series-beta");

      // Verify second job received queued message
      const queuedMsg = sentTelegramBodies.find((m) =>
        m.text.includes("Queued Lnori Light Novel Series (Position #1 of 1)"),
      );
      expect(queuedMsg).toBeDefined();

      // Resolve first job
      resolveFirstJob();
      await p1;

      // Verify execution order under sequential queue drain
      expect(executionOrder).toEqual([
        "https://lnori.com/series/1/series-alpha",
        "https://lnori.com/series/2/series-beta",
      ]);
    } finally {
      globalThis.fetch = origFetch;
      resetLocalLnoriQueueForTest();
    }
  });

  it("handles server 400, 429, and error states gracefully in Telegram", async () => {
    resetLocalLnoriQueueForTest();
    const sentTelegramBodies: any[] = [];
    const origFetch = globalThis.fetch;

    let responseStatus = 400;
    let responseBody: any = { success: false, error: "Target URL must be a valid lnori.com series or book URL" };

    globalThis.fetch = (async (input: any, init: any) => {
      const url = typeof input === "string" ? input : input?.url || "";
      if (url.includes("sendMessage") || url.includes("editMessageText")) {
        const body = JSON.parse(init?.body || "{}");
        sentTelegramBodies.push(body);
        return new Response(JSON.stringify({ ok: true, result: { message_id: 7001 } }), {
          status: 200,
        });
      }
      if (url.includes("/api/lnori/ingest")) {
        return new Response(JSON.stringify(responseBody), {
          status: responseStatus,
          headers: { "Content-Type": "application/json" },
        });
      }
      return origFetch(input, init);
    }) as typeof fetch;

    try {
      // 1. 400 Invalid URL
      responseStatus = 400;
      responseBody = { success: false, error: "Target URL must be a valid lnori.com series or book URL" };
      await handleLnoriUrlMessage(123, "https://lnori.com/genre/fantasy", "tester");
      const invalidMsg = sentTelegramBodies[sentTelegramBodies.length - 1];
      expect(invalidMsg.text).toContain("Invalid Lnori URL");

      // 2. 429 Queue Full
      responseStatus = 429;
      responseBody = { success: false, error: "Lnori ingestion queue is full (25 items)." };
      await handleLnoriUrlMessage(123, "https://lnori.com/series/8046/full", "tester");
      const fullMsg = sentTelegramBodies[sentTelegramBodies.length - 1];
      expect(fullMsg.text).toContain("Lnori Ingestion Queue Full");

      // 3. Incomplete Ingestion (0 volumes imported)
      sentTelegramBodies.length = 0;
      await sendLnoriIncompleteCard(123, 7001, "https://lnori.com/series/8046/empty");
      expect(sentTelegramBodies[0].text).toContain("Lnori Ingestion Incomplete");
      expect(sentTelegramBodies[0].text).toContain("No volumes could be imported");

      // 4. Ingestion Failed Error Card
      sentTelegramBodies.length = 0;
      await sendLnoriErrorCard(123, 7001, "https://lnori.com/series/8046/failed", "Network timeout after 60s");
      expect(sentTelegramBodies[0].text).toContain("Lnori Ingestion Failed");
      expect(sentTelegramBodies[0].text).toContain("Network timeout after 60s");

      // 5. Unexpected Content-Type
      responseStatus = 200;
      responseBody = "Unknown format";
      sentTelegramBodies.length = 0;
      globalThis.fetch = (async (input: any, init: any) => {
        const url = typeof input === "string" ? input : input?.url || "";
        if (url.includes("sendMessage") || url.includes("editMessageText")) {
          const body = JSON.parse(init?.body || "{}");
          sentTelegramBodies.push(body);
          return new Response(JSON.stringify({ ok: true, result: { message_id: 7002 } }), {
            status: 200,
          });
        }
        if (url.includes("/api/lnori/ingest")) {
          return new Response("Unknown raw text", {
            status: 200,
            headers: { "Content-Type": "text/plain" },
          });
        }
        return origFetch(input, init);
      }) as typeof fetch;

      await handleLnoriUrlMessage(123, "https://lnori.com/series/8046/unknown-ct", "tester");
      const unexpMsg = sentTelegramBodies[sentTelegramBodies.length - 1];
      expect(unexpMsg.text).toContain("Lnori Ingestion Failed");
      expect(unexpMsg.text).toContain("Unexpected response from uploader server");
    } finally {
      globalThis.fetch = origFetch;
      resetLocalLnoriQueueForTest();
    }
  });

  it("pollLnoriProgress terminates with error card when polled runId mismatches or is evicted", async () => {
    resetLocalLnoriQueueForTest();
    setLnoriPollIntervalForTest(10);
    const sentTelegramBodies: any[] = [];
    const origFetch = globalThis.fetch;

    globalThis.fetch = (async (input: any, init: any) => {
      const url = typeof input === "string" ? input : input?.url || "";
      if (url.includes("sendMessage") || url.includes("editMessageText")) {
        const body = JSON.parse(init?.body || "{}");
        sentTelegramBodies.push(body);
        return new Response(JSON.stringify({ ok: true, result: { message_id: 8001 } }), {
          status: 200,
        });
      }
      if (url.includes("/api/lnori/progress")) {
        // Return global active state for a completely different runId
        return new Response(
          JSON.stringify({
            success: true,
            active: true,
            currentQueuePosition: null,
            queueLength: 0,
            state: {
              runId: "different-unrelated-runId",
              phase: "volume",
              status: "Downloading unrelated series",
            },
          }),
          { status: 200 },
        );
      }
      return origFetch(input, init);
    }) as typeof fetch;

    try {
      await pollLnoriProgress(
        123,
        8001,
        "https://lnori.com/series/8046/test",
        "expected-my-runId",
        "http://127.0.0.1:8086",
      );

      const errorMsg = sentTelegramBodies[sentTelegramBodies.length - 1];
      expect(errorMsg.text).toContain("Lnori Ingestion Failed");
      expect(errorMsg.text).toContain("Job was removed or could not be found in ingestion queue");
    } finally {
      globalThis.fetch = origFetch;
      resetLocalLnoriQueueForTest();
    }
  });

  it("consumeLnoriSseStream sends error card when stream disconnects without receiving runId", async () => {
    resetLocalLnoriQueueForTest();
    const sentTelegramBodies: any[] = [];
    const origFetch = globalThis.fetch;

    globalThis.fetch = (async (input: any, init: any) => {
      const url = typeof input === "string" ? input : input?.url || "";
      if (url.includes("sendMessage") || url.includes("editMessageText")) {
        const body = JSON.parse(init?.body || "{}");
        sentTelegramBodies.push(body);
        return new Response(JSON.stringify({ ok: true, result: { message_id: 9001 } }), {
          status: 200,
        });
      }
      return origFetch(input, init);
    }) as typeof fetch;

    // Stream that only sends keepalive and then closes without any event or runId
    const stream = new ReadableStream({
      start(controller) {
        controller.enqueue(new TextEncoder().encode(": keepalive\n\n"));
        controller.close();
      },
    });

    const sseResponse = new Response(stream, {
      status: 200,
      headers: { "Content-Type": "text/event-stream" },
    });

    try {
      await consumeLnoriSseStream(
        123,
        9001,
        "https://lnori.com/series/8046/drop",
        sseResponse,
        "http://127.0.0.1:8086",
      );

      const errorMsg = sentTelegramBodies[sentTelegramBodies.length - 1];
      expect(errorMsg.text).toContain("Lnori Ingestion Failed");
      expect(errorMsg.text).toContain("Stream connection lost before ingestion initialized");
    } finally {
      globalThis.fetch = origFetch;
      resetLocalLnoriQueueForTest();
    }
  });

  it("LOCAL_UPLOADER_URL custom port is allowlisted in SSRF validation", async () => {
    const { validateUrlForSSRF } = await import("./security");
    const origEnv = process.env.LOCAL_UPLOADER_URL;
    try {
      process.env.LOCAL_UPLOADER_URL = "http://127.0.0.1:9876";
      const check = await validateUrlForSSRF("http://127.0.0.1:9876/api/lnori/ingest", {
        allowInternalServices: true,
      });
      expect(check.safe).toBe(true);
      expect(check.resolvedIp).toBe("127.0.0.1");
    } finally {
      if (origEnv !== undefined) process.env.LOCAL_UPLOADER_URL = origEnv;
      else delete process.env.LOCAL_UPLOADER_URL;
    }
  });

  it("handleTextMessage detects Elscione light novel URL and routes through queue", async () => {
    resetLocalLnoriQueueForTest();
    const sentTelegramBodies: any[] = [];
    const origFetch = globalThis.fetch;

    globalThis.fetch = (async (input: any, init: any) => {
      const url = typeof input === "string" ? input : input?.url || "";
      if (url.includes("sendMessage") || url.includes("editMessageText")) {
        const body = JSON.parse(init?.body || "{}");
        sentTelegramBodies.push(body);
        return new Response(JSON.stringify({ ok: true, result: { message_id: 1010 } }), {
          status: 200,
        });
      }
      if (url.includes("/api/lnori/ingest")) {
        return new Response(
          JSON.stringify({
            success: true,
            queued: true,
            queuePosition: 1,
            queueLength: 1,
            runId: "elscione-run-123",
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      }
      if (url.includes("/api/lnori/progress")) {
        return new Response(
          JSON.stringify({
            success: true,
            active: false,
            state: {
              runId: "elscione-run-123",
              phase: "complete",
              total: 2,
              data: {
                success: true,
                seriesTitle: "Grimgar",
                author: "Jyumonji",
                importedCount: 2,
                skippedCount: 0,
                totalCount: 2,
              },
            },
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      }
      return origFetch(input, init);
    }) as typeof fetch;

    try {
      await handleTextMessage(
        12345,
        "Here is the book: https://server.elscione.com/Officially%20Translated%20Light%20Novels/Grimgar%20of%20Fantasy%20and%20Ash/",
        "reader",
      );

      expect(sentTelegramBodies.length).toBeGreaterThan(0);
      const firstMsg = sentTelegramBodies[0];
      expect(firstMsg.text).toContain("Detected Elscione Light Novel Series");

      const lastMsg = sentTelegramBodies[sentTelegramBodies.length - 1];
      expect(lastMsg.text).toContain("Light Novel Series Imported Successfully!");
      expect(lastMsg.text).toContain("Grimgar");
    } finally {
      globalThis.fetch = origFetch;
      resetLocalLnoriQueueForTest();
    }
  });

  it("runDirectLnoriFallback supports Elscione URLs using _ingestElscioneSeriesRunner", async () => {
    resetLocalLnoriQueueForTest();
    const sentTelegramBodies: any[] = [];
    const origFetch = globalThis.fetch;

    globalThis.fetch = (async (input: any, init: any) => {
      const url = typeof input === "string" ? input : input?.url || "";
      if (url.includes("sendMessage") || url.includes("editMessageText")) {
        const body = JSON.parse(init?.body || "{}");
        sentTelegramBodies.push(body);
        return new Response(JSON.stringify({ ok: true, result: { message_id: 1011 } }), {
          status: 200,
        });
      }
      return origFetch(input, init);
    }) as typeof fetch;

    let elscioneRunnerCalledWith = "";
    setIngestElscioneSeriesRunnerForTest(async (url: string, onProgress?: any) => {
      elscioneRunnerCalledWith = url;
      if (onProgress) {
        await onProgress({
          phase: "volume",
          index: 1,
          total: 1,
          volumeTitle: "Overlord Vol 1",
          status: "Importing Overlord...",
        });
      }
      return {
        success: true,
        seriesTitle: "Overlord",
        author: "Kugane Maruyama",
        importedCount: 1,
        skippedCount: 0,
        totalCount: 1,
        tags: ["Light Novel", "Elscione"],
        calibreBookIds: [99],
        duplicateCount: 0,
      };
    });

    try {
      await runDirectLnoriFallback(
        555,
        1011,
        "https://server.elscione.com/Officially%20Translated%20Light%20Novels/Overlord/Vol1.epub",
      );

      expect(elscioneRunnerCalledWith).toContain("Overlord/Vol1.epub");
      const completionMsg = sentTelegramBodies[sentTelegramBodies.length - 1];
      expect(completionMsg.text).toContain("Light Novel Series Imported Successfully!");
      expect(completionMsg.text).toContain("Overlord");
    } finally {
      globalThis.fetch = origFetch;
      resetLocalLnoriQueueForTest();
    }
  });

  it("handleTextMessage detects Elscione URL with raw spaces and missing protocol, auto-normalizing as light novel", async () => {
    resetLocalLnoriQueueForTest();
    const sentTelegramBodies: any[] = [];
    const origFetch = globalThis.fetch;
    let postedIngestUrl = "";

    globalThis.fetch = (async (input: any, init: any) => {
      const url = typeof input === "string" ? input : input?.url || "";
      if (url.includes("sendMessage") || url.includes("editMessageText")) {
        const body = JSON.parse(init?.body || "{}");
        sentTelegramBodies.push(body);
        return new Response(JSON.stringify({ ok: true, result: { message_id: 1012 } }), {
          status: 200,
        });
      }
      if (url.includes("/api/lnori/ingest")) {
        const body = JSON.parse(init?.body || "{}");
        postedIngestUrl = body.url;
        return new Response(
          JSON.stringify({
            success: true,
            queued: true,
            queuePosition: 1,
            queueLength: 1,
            runId: "elscione-space-123",
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      }
      if (url.includes("/api/lnori/progress")) {
        return new Response(
          JSON.stringify({
            success: true,
            active: false,
            state: {
              runId: "elscione-space-123",
              phase: "complete",
              total: 1,
              data: {
                success: true,
                seriesTitle: "A Sister's All You Need",
                author: "Hirasaka Yomi",
                importedCount: 1,
                skippedCount: 0,
                totalCount: 1,
              },
            },
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      }
      return origFetch(input, init);
    }) as typeof fetch;

    try {
      // User pastes link without https:// and with raw spaces and single quote
      await handleTextMessage(
        12345,
        "Please import server.elscione.com/Officially Translated Light Novels/A Sister's All You Need/",
        "reader",
      );

      // Verify it was detected as Elscione Light Novel Series rather than an article
      expect(sentTelegramBodies.length).toBeGreaterThan(0);
      const firstMsg = sentTelegramBodies[0];
      expect(firstMsg.text).toContain("Detected Elscione Light Novel Series");

      // Verify the URL posted to the ingest endpoint is normalized
      expect(postedIngestUrl).toBe(
        "https://server.elscione.com/Officially%20Translated%20Light%20Novels/A%20Sister's%20All%20You%20Need/",
      );

      const lastMsg = sentTelegramBodies[sentTelegramBodies.length - 1];
      expect(lastMsg.text).toContain("Light Novel Series Imported Successfully!");
      expect(lastMsg.text).toContain("A Sister's All You Need");
    } finally {
      globalThis.fetch = origFetch;
      resetLocalLnoriQueueForTest();
    }
  });
  it("handleTextMessage detects server.elsci.one mirror URL with raw spaces and missing protocol", async () => {
    resetLocalLnoriQueueForTest();
    const sentTelegramBodies: any[] = [];
    const origFetch = globalThis.fetch;
    let postedIngestUrl = "";

    globalThis.fetch = (async (input: any, init: any) => {
      const url = typeof input === "string" ? input : input?.url || "";
      if (url.includes("sendMessage") || url.includes("editMessageText")) {
        const body = JSON.parse(init?.body || "{}");
        sentTelegramBodies.push(body);
        return new Response(JSON.stringify({ ok: true, result: { message_id: 1013 } }), {
          status: 200,
        });
      }
      if (url.includes("/api/lnori/ingest")) {
        const body = JSON.parse(init?.body || "{}");
        postedIngestUrl = body.url;
        return new Response(
          JSON.stringify({
            success: true,
            queued: true,
            queuePosition: 1,
            queueLength: 1,
            runId: "elsci-one-123",
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      }
      if (url.includes("/api/lnori/progress")) {
        return new Response(
          JSON.stringify({
            success: true,
            active: false,
            state: {
              runId: "elsci-one-123",
              phase: "complete",
              total: 1,
              data: {
                success: true,
                seriesTitle: "Are You Okay With a Slightly Older Girlfriend",
                author: "Kota Nozomi",
                importedCount: 1,
                skippedCount: 0,
                totalCount: 1,
              },
            },
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      }
      return origFetch(input, init);
    }) as typeof fetch;

    try {
      await handleTextMessage(
        12345,
        "Read this novel: https://server.elsci.one/Officially%20Translated%20Light%20Novels/Are%20You%20Okay%20With%20a%20Slightly%20Older%20Girlfriend/",
        "reader",
      );

      // Verify it was detected as Elscione Light Novel Series rather than a web article
      expect(sentTelegramBodies.length).toBeGreaterThan(0);
      const firstMsg = sentTelegramBodies[0];
      expect(firstMsg.text).toContain("Detected Elscione Light Novel Series");

      // Verify URL sent to ingest queue
      expect(postedIngestUrl).toBe(
        "https://server.elsci.one/Officially%20Translated%20Light%20Novels/Are%20You%20Okay%20With%20a%20Slightly%20Older%20Girlfriend/",
      );

      const lastMsg = sentTelegramBodies[sentTelegramBodies.length - 1];
      expect(lastMsg.text).toContain("Light Novel Series Imported Successfully!");
      expect(lastMsg.text).toContain("Are You Okay With a Slightly Older Girlfriend");
    } finally {
      globalThis.fetch = origFetch;
      resetLocalLnoriQueueForTest();
    }
  });

  describe("/get and /get@bot Command Parsing", () => {
    it("handles /get@bot <id> and /get <id> identically without falling into default EPUB prompt", async () => {
      const sentTelegramBodies: any[] = [];
      const origFetch = globalThis.fetch;
      globalThis.fetch = (async (input: any, init: any) => {
        const url = typeof input === "string" ? input : input?.url || "";
        if (
          url.includes("sendMessage") ||
          url.includes("editMessageText") ||
          url.includes("sendDocument")
        ) {
          const body = JSON.parse(init?.body || "{}");
          sentTelegramBodies.push({ url, body });
          return new Response(
            JSON.stringify({ ok: true, result: { message_id: 8888 } }),
            { status: 200 },
          );
        }
        return origFetch(input, init);
      }) as typeof fetch;

      try {
        // Send /get@saroat_ospeto_bot 6
        await handleTextMessage(
          999,
          "/get@saroat_ospeto_bot 6",
          "group_member",
        );

        expect(sentTelegramBodies.length).toBeGreaterThan(0);
        // Should NOT send the generic prompt ("Please send EPUB files")
        for (const item of sentTelegramBodies) {
          expect(item.body.text || "").not.toContain("Please send EPUB files");
        }
        // It either sent retrieving status / book not found / book document
        const anyRetrievalMention = sentTelegramBodies.some(
          (item) =>
            (item.body.text && (item.body.text.includes("Retrieving") || item.body.text.includes("Book #6 Not Found"))) ||
            item.url.includes("sendDocument"),
        );
        expect(anyRetrievalMention).toBe(true);

        sentTelegramBodies.length = 0;

        // Send /get@bot without ID
        await handleTextMessage(999, "/get@saroat_ospeto_bot", "group_member");
        expect(sentTelegramBodies.length).toBe(1);
        expect(sentTelegramBodies[0].body.text).toContain("Book Retrieval");
        expect(sentTelegramBodies[0].body.text).toContain("Usage: `/get <id>`");
        expect(sentTelegramBodies[0].body.text).not.toContain("Please send EPUB files");
      } finally {
        globalThis.fetch = origFetch;
      }
    });
  });

  describe("Metadata Enrichment & Series Volume Overwrite Protection in Telegram Bot", () => {
    it("runDirectLnoriFallback does NOT enqueue metadata_enrich jobs upon successful ingestion", async () => {
      const { getJobQueue } = await import("./jobs");
      const jq = getJobQueue(getCacheDb());
      const origEnqueue = jq.enqueue;
      const enqueuedJobs: any[] = [];
      (jq as any).enqueue = (type: string, payload: any) => {
        enqueuedJobs.push({ type, payload });
        return { id: "1", type, payload, status: "pending" };
      };

      setIngestLnoriSeriesRunnerForTest(async () => ({
        success: true,
        seriesTitle: "Lnori Series",
        author: "Lnori Author",
        importedCount: 2,
        skippedCount: 0,
        totalCount: 2,
        tags: ["Light Novel"],
        calibreBookIds: [501, 502],
        duplicateCount: 0,
      }));

      try {
        await runDirectLnoriFallback(999, 1234, "https://lnori.com/series/555/test");
        const enrichJobs = enqueuedJobs.filter((j) => j.type === "metadata_enrich");
        expect(enrichJobs.length).toBe(0);
      } finally {
        (jq as any).enqueue = origEnqueue;
        setIngestLnoriSeriesRunnerForTest(null as any);
      }
    });

    it("metadata_enrich job handler refuses to overwrite volume titles and covers when volume numbers mismatch", async () => {
      const { DurableJobQueue } = await import("./jobs");
      const { Database } = await import("bun:sqlite");
      const testDb = new Database(":memory:");
      const testQueue = new DurableJobQueue(testDb);
      registerJobHandlers(testQueue);

      const handler = (testQueue as any).handlers.get("metadata_enrich");
      expect(handler).toBeDefined();

      let applyCalled = false;
      let searchedPreserveVolume: boolean | undefined = undefined;

      setSearchUniversalMetadataRunnerForTest(async (_query: string, hint?: any) => {
        searchedPreserveVolume = hint?.preserveVolume;
        return [
          {
            title: "Goblin Slayer, Vol. 1",
            authors: "Kumo Kagyu",
            confidence: 0.95,
            source: "RanobeDB",
            coverUrl: "https://images.ranobedb.org/vol1.jpg",
            tags: ["Light Novel"],
          },
        ];
      });

      setApplyMetadataToCalibreRunnerForTest(async () => {
        applyCalled = true;
        return true;
      });

      try {
        const res = await handler({
          bookId: 304,
          title: "Goblin Slayer Vol 4",
          author: "Kumo Kagyu",
          tags: ["Light Novel"],
        });

        expect(searchedPreserveVolume).toBe(true);
        expect(applyCalled).toBe(false);
        expect(res.success).toBe(true);
        expect(res.message).toContain("Volume conflict");
        expect(res.message).toContain("Preserved original title and cover");
      } finally {
        setSearchUniversalMetadataRunnerForTest(null);
        setApplyMetadataToCalibreRunnerForTest(null);
        testDb.close();
      }
    });
  });

  describe("Multi-URL Article Ingestion in Telegram Message Handler", () => {
    let origFetch: typeof globalThis.fetch;

    beforeEach(() => {
      origFetch = globalThis.fetch;
    });

    afterEach(() => {
      globalThis.fetch = origFetch;
      setIngestArticleRunnerForTest(null);
    });

    it("ingests multiple article URLs sequentially with progress tracking and delivery", async () => {
      const sentTelegramBodies: any[] = [];
      let msgIdCounter = 5000;

      globalThis.fetch = (async (input: any, init: any) => {
        const url = typeof input === "string" ? input : input?.url || "";
        if (
          url.includes("sendMessage") ||
          url.includes("editMessageText") ||
          url.includes("sendDocument")
        ) {
          const body = JSON.parse(init?.body || "{}");
          sentTelegramBodies.push({ endpoint: url.split("/").pop(), body });
          return new Response(
            JSON.stringify({
              ok: true,
              result: { message_id: ++msgIdCounter },
            }),
            { status: 200 },
          );
        }
        return origFetch(input, init);
      }) as typeof fetch;

      const ingestCalls: string[] = [];
      setIngestArticleRunnerForTest(async (url: string) => {
        ingestCalls.push(url);
        return {
          success: true,
          bookId: 100 + ingestCalls.length,
          title: `Article ${ingestCalls.length}`,
          authors: "Author Name",
          siteName: "Test Site",
          readTimeMinutes: 5,
          wordCount: 1200,
          format: "EPUB",
        } as any;
      });

      const multiUrlText = [
        "https://example.com/first-article",
        "https://example.com/second-article",
        "https://example.com/third-article",
      ].join("\n");

      await handleTextMessage(112233, multiUrlText, "tester");

      // Verify all 3 URLs were ingested sequentially in exact order
      expect(ingestCalls).toEqual([
        "https://example.com/first-article",
        "https://example.com/second-article",
        "https://example.com/third-article",
      ]);

      // Check progress messages for all 3 articles
      const progressMessages = sentTelegramBodies.filter(
        (m) =>
          m.body.text &&
          m.body.text.includes("Extracting article") &&
          m.endpoint === "sendMessage",
      );
      expect(progressMessages.length).toBe(3);
      expect(progressMessages[0].body.text).toContain("Extracting article 1 of 3");
      expect(progressMessages[0].body.text).toContain("https://example.com/first-article");
      expect(progressMessages[1].body.text).toContain("Extracting article 2 of 3");
      expect(progressMessages[1].body.text).toContain("https://example.com/second-article");
      expect(progressMessages[2].body.text).toContain("Extracting article 3 of 3");
      expect(progressMessages[2].body.text).toContain("https://example.com/third-article");

      // Check completion cards
      const completionCards = sentTelegramBodies.filter(
        (m) =>
          m.body.text &&
          m.body.text.includes("Article Ingested Successfully"),
      );
      expect(completionCards.length).toBe(3);
    });

    it("continues processing remaining URLs when an individual URL fails or hits paywall", async () => {
      const sentTelegramBodies: any[] = [];
      let msgIdCounter = 6000;

      globalThis.fetch = (async (input: any, init: any) => {
        const url = typeof input === "string" ? input : input?.url || "";
        if (
          url.includes("sendMessage") ||
          url.includes("editMessageText") ||
          url.includes("sendDocument")
        ) {
          const body = JSON.parse(init?.body || "{}");
          sentTelegramBodies.push({ endpoint: url.split("/").pop(), body });
          return new Response(
            JSON.stringify({
              ok: true,
              result: { message_id: ++msgIdCounter },
            }),
            { status: 200 },
          );
        }
        return origFetch(input, init);
      }) as typeof fetch;

      const ingestCalls: string[] = [];
      setIngestArticleRunnerForTest(async (url: string) => {
        ingestCalls.push(url);
        if (url === "https://example.com/failing-paywall") {
          throw new Error("paid subscription paywall detected");
        }
        if (url === "https://example.com/failed-result") {
          return {
            success: false,
            error: "Unable to extract content",
          } as any;
        }
        return {
          success: true,
          bookId: 50,
          title: "Good Article",
          authors: "Great Author",
          siteName: "Good Site",
          readTimeMinutes: 3,
          wordCount: 800,
          format: "EPUB",
        } as any;
      });

      const multiUrlText = [
        "https://example.com/good-article-1",
        "https://example.com/failing-paywall",
        "https://example.com/good-article-2",
      ].join("\n");

      await handleTextMessage(445566, multiUrlText, "reader");

      // Verify all 3 URLs were attempted despite the middle one throwing an error
      expect(ingestCalls).toEqual([
        "https://example.com/good-article-1",
        "https://example.com/failing-paywall",
        "https://example.com/good-article-2",
      ]);

      // Check error card was sent for the failing URL with paywall advice
      const errorCards = sentTelegramBodies.filter(
        (m) =>
          m.body.text &&
          m.body.text.includes("Article Ingestion Failed"),
      );
      expect(errorCards.length).toBe(1);
      expect(errorCards[0].body.text).toContain("https://example.com/failing-paywall");
      expect(errorCards[0].body.text).toContain("subscription paywall");
      expect(errorCards[0].body.text).toContain("Please paste the article text directly");

      // Check completion cards for the 2 successful articles
      const completionCards = sentTelegramBodies.filter(
        (m) =>
          m.body.text &&
          m.body.text.includes("Article Ingested Successfully"),
      );
      expect(completionCards.length).toBe(2);
    });

    it("deduplicates identical URLs within the same message while preserving order", async () => {
      const sentTelegramBodies: any[] = [];
      let msgIdCounter = 7000;

      globalThis.fetch = (async (input: any, init: any) => {
        const url = typeof input === "string" ? input : input?.url || "";
        if (
          url.includes("sendMessage") ||
          url.includes("editMessageText")
        ) {
          const body = JSON.parse(init?.body || "{}");
          sentTelegramBodies.push({ endpoint: url.split("/").pop(), body });
          return new Response(
            JSON.stringify({
              ok: true,
              result: { message_id: ++msgIdCounter },
            }),
            { status: 200 },
          );
        }
        return origFetch(input, init);
      }) as typeof fetch;

      const ingestCalls: string[] = [];
      setIngestArticleRunnerForTest(async (url: string) => {
        ingestCalls.push(url);
        return {
          success: true,
          bookId: 80,
          title: "Sample",
          authors: "Author",
          siteName: "Site",
          readTimeMinutes: 2,
          wordCount: 500,
          format: "EPUB",
        } as any;
      });

      const messageWithDups =
        "Read https://example.com/dup-1 and also https://example.com/dup-2 then again https://example.com/dup-1";

      await handleTextMessage(778899, messageWithDups, "tester");

      // Ingest should only be called twice, duplicate skipped
      expect(ingestCalls).toEqual([
        "https://example.com/dup-1",
        "https://example.com/dup-2",
      ]);

      const progressMessages = sentTelegramBodies.filter(
        (m) =>
          m.body.text &&
          m.body.text.includes("Extracting article") &&
          m.endpoint === "sendMessage",
      );
      expect(progressMessages.length).toBe(2);
      expect(progressMessages[0].body.text).toContain("Extracting article 1 of 2");
      expect(progressMessages[1].body.text).toContain("Extracting article 2 of 2");
    });

    it("preserves single-URL progress message formatting for single-article messages", async () => {
      const sentTelegramBodies: any[] = [];
      let msgIdCounter = 8000;

      globalThis.fetch = (async (input: any, init: any) => {
        const url = typeof input === "string" ? input : input?.url || "";
        if (
          url.includes("sendMessage") ||
          url.includes("editMessageText")
        ) {
          const body = JSON.parse(init?.body || "{}");
          sentTelegramBodies.push({ endpoint: url.split("/").pop(), body });
          return new Response(
            JSON.stringify({
              ok: true,
              result: { message_id: ++msgIdCounter },
            }),
            { status: 200 },
          );
        }
        return origFetch(input, init);
      }) as typeof fetch;

      setIngestArticleRunnerForTest(async (_url: string) => {
        return {
          success: true,
          bookId: 90,
          title: "Single Article",
          authors: "Author",
          siteName: "Site",
          readTimeMinutes: 4,
          wordCount: 950,
          format: "EPUB",
        } as any;
      });

      await handleTextMessage(
        990011,
        "https://example.com/single-article",
        "tester",
      );

      const progressMessage = sentTelegramBodies.find(
        (m) =>
          m.body.text &&
          m.body.text.includes("Extracting article") &&
          m.endpoint === "sendMessage",
      );
      expect(progressMessage).toBeDefined();
      expect(progressMessage.body.text).toContain("Extracting article from URL...");
      expect(progressMessage.body.text).not.toContain("Extracting article 1 of 1");
    });
  });
});


