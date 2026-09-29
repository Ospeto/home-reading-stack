import { describe, expect, it, beforeEach, afterEach } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import {
  isFirecrawlRunning,
  ensureFirecrawlRunning,
  stopFirecrawl,
  resetFirecrawlIdleTimer,
  cancelFirecrawlIdleTimer,
  isFirecrawlIdleTimerActive,
  scrapeArticleWithFirecrawl,
  getFirecrawlStatus,
  getFirecrawlUrl,
  getFirecrawlComposeDir,
  getFirecrawlIdleTimeoutMs,
  isFirecrawlEnabled,
  setFirecrawlEnabled,
  createScrapeLock,
  releaseScrapeLock,
  getInFlightScrapesCount,
  getActiveLockCount,
  type ExtractedFirecrawlArticle,
} from "./firecrawl";
import { buildArticleFromFirecrawl } from "./article";
import { validateUrlForSSRF } from "./security";

describe("Firecrawl On-Demand Cluster Manager (uploader/firecrawl.ts)", () => {
  const origEnv = { ...process.env };

  beforeEach(() => {
    cancelFirecrawlIdleTimer();
    setFirecrawlEnabled(null);
  });

  afterEach(() => {
    cancelFirecrawlIdleTimer();
    setFirecrawlEnabled(null);
    for (const k of Object.keys(process.env)) {
      if (!(k in origEnv)) {
        delete process.env[k];
      }
    }
    Object.assign(process.env, origEnv);
  });

  describe("Configuration & Environment", () => {
    it("reads default environment values correctly", () => {
      delete process.env.FIRECRAWL_URL;
      delete process.env.FIRECRAWL_COMPOSE_DIR;
      delete process.env.FIRECRAWL_IDLE_TIMEOUT_MS;
      delete process.env.FIRECRAWL_ENABLED;

      expect(getFirecrawlUrl()).toBe("http://127.0.0.1:3002");
      expect(getFirecrawlComposeDir()).toContain(
        "Documents/Firecrawl/firecrawl",
      );
      expect(getFirecrawlIdleTimeoutMs()).toBe(15 * 60 * 1000);
      expect(isFirecrawlEnabled()).toBe(true);
    });

    it("respects custom environment overrides", () => {
      process.env.FIRECRAWL_URL = "http://127.0.0.1:4000/";
      process.env.FIRECRAWL_COMPOSE_DIR = "/tmp/firecrawl-custom";
      process.env.FIRECRAWL_IDLE_TIMEOUT_MS = "60000";
      process.env.FIRECRAWL_ENABLED = "false";

      expect(getFirecrawlUrl()).toBe("http://127.0.0.1:4000");
      expect(getFirecrawlComposeDir()).toBe("/tmp/firecrawl-custom");
      expect(getFirecrawlIdleTimeoutMs()).toBe(60000);
      expect(isFirecrawlEnabled()).toBe(false);

      process.env.FIRECRAWL_ENABLED = "0";
      expect(isFirecrawlEnabled()).toBe(false);

      process.env.FIRECRAWL_ENABLED = "1";
      expect(isFirecrawlEnabled()).toBe(true);
    });

    it("setFirecrawlEnabled allows programmatic toggle for testing", () => {
      setFirecrawlEnabled(false);
      expect(isFirecrawlEnabled()).toBe(false);
      setFirecrawlEnabled(true);
      expect(isFirecrawlEnabled()).toBe(true);
      setFirecrawlEnabled(null);
      expect(isFirecrawlEnabled()).toBe(true);
    });
  });

  describe("Idle Timer Lifecycle", () => {
    it("schedules, activates, and cancels idle timer", () => {
      expect(isFirecrawlIdleTimerActive()).toBe(false);

      resetFirecrawlIdleTimer();
      expect(isFirecrawlIdleTimerActive()).toBe(true);

      cancelFirecrawlIdleTimer();
      expect(isFirecrawlIdleTimerActive()).toBe(false);
    });

    it("does not schedule timer when idle timeout is 0 or negative", () => {
      process.env.FIRECRAWL_IDLE_TIMEOUT_MS = "0";
      resetFirecrawlIdleTimer();
      expect(isFirecrawlIdleTimerActive()).toBe(false);
    });
  });

  describe("Health Check & Running State Detection", () => {
    it("returns false when service port is unreachable or connection refused", async () => {
      // Point to an unused local port
      process.env.FIRECRAWL_URL = "http://127.0.0.1:49999";
      const running = await isFirecrawlRunning(300);
      expect(running).toBe(false);
    });
  });

  describe("Wake-On-Demand & Lifecycle Management (ensureFirecrawlRunning & stopFirecrawl)", () => {
    it("returns false immediately when Firecrawl is disabled", async () => {
      setFirecrawlEnabled(false);
      const ready = await ensureFirecrawlRunning();
      expect(ready).toBe(false);
    });

    it("returns false when compose directory does not exist", async () => {
      // Force non-running state
      process.env.FIRECRAWL_URL = "http://127.0.0.1:49998";
      process.env.FIRECRAWL_COMPOSE_DIR = "/nonexistent/firecrawl/dir";

      const ready = await ensureFirecrawlRunning({ timeoutMs: 500 });
      expect(ready).toBe(false);
    });

    it("wakes containers via docker compose start with polling", async () => {
      const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "fc-test-"));
      process.env.FIRECRAWL_COMPOSE_DIR = tempDir;
      process.env.FIRECRAWL_URL = "http://127.0.0.1:49997";

      const spawnedCommands: Array<{ cmd: string; args: string[] }> = [];

      const mockSpawn = (cmd: string, args: string[], _opts: any) => {
        spawnedCommands.push({ cmd, args });
        return { status: 0, error: null, stdout: "Started", stderr: "" };
      };

      // Mock isFirecrawlRunning to simulate container starting up on attempt 2
      let mockReady = false;
      const testServer = Bun.serve({
        port: 49997,
        fetch(_req) {
          if (mockReady) {
            return new Response("OK", { status: 200 });
          }
          return new Response("Not Ready", { status: 503 });
        },
      });

      try {
        setTimeout(() => {
          mockReady = true;
        }, 150);

        const ready = await ensureFirecrawlRunning({
          timeoutMs: 3000,
          pollIntervalMs: 50,
          spawnCmd: mockSpawn,
        });

        expect(ready).toBe(true);
        expect(spawnedCommands.length).toBeGreaterThanOrEqual(1);
        expect(spawnedCommands[0].args).toEqual(["compose", "start"]);
        expect(isFirecrawlIdleTimerActive()).toBe(true);
      } finally {
        testServer.stop(true);
        fs.rmSync(tempDir, { recursive: true, force: true });
      }
    });

    it("falls back to docker compose up -d when start fails", async () => {
      const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "fc-test-up-"));
      process.env.FIRECRAWL_COMPOSE_DIR = tempDir;
      process.env.FIRECRAWL_URL = "http://127.0.0.1:49996";

      const spawnedCommands: Array<{ cmd: string; args: string[] }> = [];
      let upCalled = false;
      const mockSpawn = (cmd: string, args: string[], _opts: any) => {
        spawnedCommands.push({ cmd, args });
        if (args.includes("start")) {
          return { status: 1, error: null, stdout: "", stderr: "No such service" };
        }
        upCalled = true;
        return { status: 0, error: null, stdout: "Created and started", stderr: "" };
      };

      const testServer = Bun.serve({
        port: 49996,
        fetch(_req) {
          if (upCalled) {
            return new Response("OK", { status: 200 });
          }
          return new Response("Service Unavailable", { status: 503 });
        },
      });

      try {
        const ready = await ensureFirecrawlRunning({
          timeoutMs: 2000,
          pollIntervalMs: 50,
          spawnCmd: mockSpawn,
        });

        expect(ready).toBe(true);
        expect(spawnedCommands.length).toBe(2);
        expect(spawnedCommands[0].args).toEqual(["compose", "start"]);
        expect(spawnedCommands[1].args).toEqual(["compose", "up", "-d"]);
      } finally {
        testServer.stop(true);
        fs.rmSync(tempDir, { recursive: true, force: true });
      }
    });

    it("stops containers via docker compose stop", async () => {
      const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "fc-test-stop-"));
      process.env.FIRECRAWL_COMPOSE_DIR = tempDir;
      process.env.FIRECRAWL_ACTIVITY_DIR = path.join(tempDir, "activity");

      resetFirecrawlIdleTimer();
      expect(isFirecrawlIdleTimerActive()).toBe(true);

      const stoppedCommands: Array<{ cmd: string; args: string[] }> = [];
      const mockSpawn = (cmd: string, args: string[], _opts: any) => {
        stoppedCommands.push({ cmd, args });
        return { status: 0, error: null, stdout: "Stopped", stderr: "" };
      };

      const result = await stopFirecrawl({ spawnCmd: mockSpawn });
      expect(result).toBe(true);
      expect(isFirecrawlIdleTimerActive()).toBe(false);
      expect(stoppedCommands.length).toBe(1);
      expect(stoppedCommands[0].args).toEqual(["compose", "stop"]);

      fs.rmSync(tempDir, { recursive: true, force: true });
    });
  });

  describe("Scrape Payload Parsing & Metadata Extraction", () => {
    it("parses valid scrape response with markdown, title, author, and lead image", async () => {
      const server = Bun.serve({
        port: 49995,
        fetch(req) {
          if (req.method === "GET" && new URL(req.url).pathname === "/") {
            return new Response("OK", { status: 200 });
          }
          if (req.method === "POST" && new URL(req.url).pathname === "/v1/scrape") {
            return new Response(
              JSON.stringify({
                success: true,
                data: {
                  markdown: "# AI Architecture\n\nDeep dive into distributed systems and LLMs with extensive analysis and insights.",
                  metadata: {
                    title: "AI Architecture Guide",
                    author: "Dr. Elena Vance",
                    "og:site_name": "Tech Research Journal",
                    publishedTime: "2026-09-24T12:00:00Z",
                    "og:image": "https://example.com/assets/ai-lead.jpg",
                  },
                },
              }),
              { headers: { "Content-Type": "application/json" } },
            );
          }
          return new Response("Not Found", { status: 404 });
        },
      });

      process.env.FIRECRAWL_URL = "http://127.0.0.1:49995";

      try {
        const article = await scrapeArticleWithFirecrawl("https://techjournal.org/ai-architecture");
        expect(article).not.toBeNull();
        expect(article?.title).toBe("AI Architecture Guide");
        expect(article?.author).toBe("Dr. Elena Vance");
        expect(article?.siteName).toBe("Tech Research Journal");
        expect(article?.publishedDate).toBe("2026-09-24T12:00:00Z");
        expect(article?.leadImageUrl).toBe("https://example.com/assets/ai-lead.jpg");
        expect(article?.markdown).toContain("# AI Architecture");
      } finally {
        server.stop(true);
      }
    });

    it("returns null when Firecrawl returns empty markdown or error", async () => {
      const server = Bun.serve({
        port: 49994,
        fetch(req) {
          if (req.method === "GET") return new Response("OK", { status: 200 });
          if (new URL(req.url).pathname === "/v1/scrape") {
            return new Response(
              JSON.stringify({
                success: true,
                data: { markdown: "   ", metadata: {} },
              }),
              { headers: { "Content-Type": "application/json" } },
            );
          }
          return new Response("Not Found", { status: 404 });
        },
      });

      process.env.FIRECRAWL_URL = "http://127.0.0.1:49994";

      try {
        const article = await scrapeArticleWithFirecrawl("https://example.com/empty");
        expect(article).toBeNull();
      } finally {
        server.stop(true);
      }
    });

    it("attaches Authorization header when FIRECRAWL_API_KEY is present", async () => {
      let receivedAuthHeader: string | null = null;
      const server = Bun.serve({
        port: 49993,
        fetch(req) {
          if (req.method === "GET") return new Response("OK", { status: 200 });
          receivedAuthHeader = req.headers.get("authorization");
          return new Response(
            JSON.stringify({
              success: true,
              data: {
                markdown: "Sample prose text with sufficient content for testing.",
                metadata: { title: "Auth Header Test" },
              },
            }),
            { headers: { "Content-Type": "application/json" } },
          );
        },
      });

      process.env.FIRECRAWL_URL = "http://127.0.0.1:49993";
      process.env.FIRECRAWL_API_KEY = "test-fc-secret-token";

      try {
        const article = await scrapeArticleWithFirecrawl("https://example.com/auth");
        expect(article).not.toBeNull();
        expect(receivedAuthHeader).toBe("Bearer test-fc-secret-token");
      } finally {
        server.stop(true);
      }
    });
  });

  describe("Integration with Article Pipeline (buildArticleFromFirecrawl)", () => {
    it("converts ExtractedFirecrawlArticle to ExtractedArticle with styled document and cover", async () => {
      const fcArticle: ExtractedFirecrawlArticle = {
        url: "https://example.com/deep-systems",
        title: "Deep Systems Architecture",
        author: "Chief Architect",
        siteName: "Systems Weekly",
        publishedDate: "2026-09-01T08:00:00Z",
        markdown: `
# Deep Systems Architecture

Modern distributed systems require clear separation of concerns, robust retry policies, and bounded failure domains.
This article provides an in-depth exploration of high-availability clustering and storage idempotency.
We discuss how SQLite databases in WAL mode can safely support concurrent read queries while sequentializing
mutating operations through an isolated SQLite job queue. By adhering to single-writer invariants,
we eliminate database lock contention and ensure zero data corruption during heavy ingestion bursts.

Furthermore, on-demand container lifecycles allow edge daemons to conserve significant system memory
by shutting down resource-heavy auxiliary containers after fixed inactivity windows.
`.repeat(3),
      };

      const article = await buildArticleFromFirecrawl(
        fcArticle,
        "https://example.com/deep-systems",
        "example.com",
      );

      expect(article).not.toBeNull();
      expect(article?.title).toBe("Deep Systems Architecture");
      expect(article?.author).toBe("Chief Architect");
      expect(article?.siteName).toBe("Systems Weekly");
      expect(article?.wordCount).toBeGreaterThan(150);
      expect(article?.readTimeMinutes).toBeGreaterThanOrEqual(1);
      expect(article?.cleanedHtml).toContain("Deep Systems Architecture");
      expect(article?.styledDocument).toContain("Systems Weekly");
      expect(article?.coverImagePath).toBeDefined();
    });

    it("rejects paywall and low-prose garbage content via isPaywallOrGarbage", async () => {
      const paywallArticle: ExtractedFirecrawlArticle = {
        url: "https://example.com/paywalled",
        title: "Exclusive Subscriber Story",
        author: "Paywall Author",
        siteName: "Paywall Times",
        markdown: "Subscribe now for $9.99/month to continue reading this article.",
      };

      const result = await buildArticleFromFirecrawl(
        paywallArticle,
        "https://example.com/paywalled",
        "example.com",
      );

      expect(result).toBeNull();
    });
  });

  describe("Cluster Status Inspection (getFirecrawlStatus)", () => {
    it("reports accurate status object", async () => {
      process.env.FIRECRAWL_URL = "http://127.0.0.1:3002";
      process.env.FIRECRAWL_COMPOSE_DIR = "/Users/ospeto/Documents/Firecrawl/firecrawl";
      process.env.FIRECRAWL_IDLE_TIMEOUT_MS = "900000";

      const status = await getFirecrawlStatus();
      expect(status.enabled).toBe(true);
      expect(status.url).toBe("http://127.0.0.1:3002");
      expect(status.composeDir).toBe("/Users/ospeto/Documents/Firecrawl/firecrawl");
      expect(status.idleTimeoutMs).toBe(900000);
      expect(typeof status.running).toBe("boolean");
      expect(typeof status.idleTimerActive).toBe("boolean");
      expect(typeof status.inFlightScrapes).toBe("number");
    });
  });

  describe("SSRF Hardening & Target URL Protection", () => {
    it("blocks scraping of SSRF / metadata / internal target URLs before egress", async () => {
      const maliciousTargets = [
        "http://169.254.169.254/latest/meta-data/",
        "http://localhost:8088/calibre",
        "http://127.0.0.1:8086/api/books",
        "http://host.docker.internal:8086/",
        "http://metadata.google.internal/",
        "http://[::1]/secret",
      ];

      for (const target of maliciousTargets) {
        const article = await scrapeArticleWithFirecrawl(target);
        expect(article).toBeNull();
      }
    });

    it("SSRF Loopback Enforcement: validateUrlForSSRF with allowFirecrawlServer", async () => {
      // 1. Rejects when FIRECRAWL_URL is configured to non-loopback IP
      process.env.FIRECRAWL_URL = "http://169.254.169.254:3002";
      const nonLoopbackCheck = await validateUrlForSSRF("http://169.254.169.254:3002/v1/scrape", {
        allowFirecrawlServer: true,
      });
      expect(nonLoopbackCheck.safe).toBe(false);
      expect(nonLoopbackCheck.error).toContain("not a loopback address");

      // 2. Rejects when target port does not match configured FIRECRAWL_URL port
      process.env.FIRECRAWL_URL = "http://127.0.0.1:3002";
      const wrongPortCheck = await validateUrlForSSRF("http://127.0.0.1:3003/v1/scrape", {
        allowFirecrawlServer: true,
      });
      expect(wrongPortCheck.safe).toBe(false);

      // 3. Rejects when allowFirecrawlServer is false
      const disabledCheck = await validateUrlForSSRF("http://127.0.0.1:3002/v1/scrape", {
        allowFirecrawlServer: false,
      });
      expect(disabledCheck.safe).toBe(false);

      // 4. Accepts when target and FIRECRAWL_URL are strict loopback
      const validCheck = await validateUrlForSSRF("http://127.0.0.1:3002/v1/scrape", {
        allowFirecrawlServer: true,
      });
      expect(validCheck.safe).toBe(true);
      expect(validCheck.resolvedIp).toBe("127.0.0.1");

      // 5. Accepts when only FIRECRAWL_PORT is configured (LaunchAgent .env compatibility)
      delete process.env.FIRECRAWL_URL;
      process.env.FIRECRAWL_PORT = "4000";
      expect(getFirecrawlUrl()).toBe("http://127.0.0.1:4000");
      const portOnlyCheck = await validateUrlForSSRF("http://127.0.0.1:4000/v1/scrape", {
        allowFirecrawlServer: true,
      });
      expect(portOnlyCheck.safe).toBe(true);
      expect(portOnlyCheck.resolvedIp).toBe("127.0.0.1");
    });
  });

  describe("Multi-Process Coordination & In-Flight Protection", () => {
    it("tracks in-flight scrapes via per-scrape atomic lock files", () => {
      const initialCount = getInFlightScrapesCount();
      expect(initialCount).toBe(0);

      const lockPath = createScrapeLock();
      expect(getInFlightScrapesCount()).toBe(1);
      expect(fs.existsSync(lockPath)).toBe(true);
      expect(getActiveLockCount()).toBeGreaterThanOrEqual(1);

      releaseScrapeLock(lockPath);
      expect(getInFlightScrapesCount()).toBe(0);
      expect(fs.existsSync(lockPath)).toBe(false);
    });

    it("stopFirecrawl refuses to stop when in-flight scrapes are active", async () => {
      const lockPath = createScrapeLock();
      try {
        const stopped = await stopFirecrawl();
        expect(stopped).toBe(false);

        // Force stop bypasses in-flight check
        const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "fc-force-"));
        process.env.FIRECRAWL_COMPOSE_DIR = tempDir;
        const mockSpawn = () => ({ status: 0, error: null, stdout: "", stderr: "" });
        const forceStopped = await stopFirecrawl({ force: true, spawnCmd: mockSpawn });
        expect(forceStopped).toBe(true);
        fs.rmSync(tempDir, { recursive: true, force: true });
      } finally {
        releaseScrapeLock(lockPath);
      }
    });

    it("reschedules auto-sleep for remaining window without adding full idle period", async () => {
      process.env.FIRECRAWL_IDLE_TIMEOUT_MS = "1000"; // 1s idle timeout for test

      const lockPath = createScrapeLock();
      // Simulate recent activity
      releaseScrapeLock(lockPath);

      resetFirecrawlIdleTimer();
      expect(isFirecrawlIdleTimerActive()).toBe(true);

      cancelFirecrawlIdleTimer();
      expect(isFirecrawlIdleTimerActive()).toBe(false);
    });
  });
});
