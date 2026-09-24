import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { safeFetchWithSsrf, validateUrlForSSRF } from "./security";

export interface ExtractedFirecrawlArticle {
  url: string;
  title: string;
  author: string;
  siteName: string;
  publishedDate?: string;
  markdown: string;
  leadImageUrl?: string;
}

export interface FirecrawlStatus {
  enabled: boolean;
  running: boolean;
  url: string;
  composeDir: string;
  idleTimeoutMs: number;
  idleTimerActive: boolean;
  inFlightScrapes: number;
}

export interface EnsureFirecrawlOptions {
  timeoutMs?: number;
  pollIntervalMs?: number;
  spawnCmd?: (cmd: string, args: string[], opts: any) => any;
}

export interface StopFirecrawlOptions {
  force?: boolean;
  spawnCmd?: (cmd: string, args: string[], opts: any) => any;
}

export const FIRECRAWL_ACTIVITY_DIR = path.join(
  os.tmpdir(),
  "lighthouse-firecrawl-activity",
);

function ensureActivityDir(): void {
  try {
    if (!fs.existsSync(FIRECRAWL_ACTIVITY_DIR)) {
      fs.mkdirSync(FIRECRAWL_ACTIVITY_DIR, { recursive: true });
    }
  } catch {
    // Ignore error
  }
}

const HEARTBEAT_FILE = path.join(FIRECRAWL_ACTIVITY_DIR, "last_active");

function updateActivityHeartbeat(): void {
  try {
    ensureActivityDir();
    fs.writeFileSync(HEARTBEAT_FILE, String(Date.now()), "utf8");
  } catch {
    // Ignore error
  }
}

export function getLastActivityAt(): number {
  try {
    if (fs.existsSync(HEARTBEAT_FILE)) {
      const raw = fs.readFileSync(HEARTBEAT_FILE, "utf8").trim();
      const val = parseInt(raw, 10);
      if (!isNaN(val) && val > 0) return val;
      const stat = fs.statSync(HEARTBEAT_FILE);
      return stat.mtimeMs;
    }
  } catch {
    // Ignore error
  }
  return 0;
}

function isPidAlive(pid: number): boolean {
  if (pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/**
 * Prunes stale lock files (>45s or dead PID) and returns the number of active in-flight scrapes.
 */
export function getActiveLockCount(): number {
  ensureActivityDir();
  let activeCount = 0;
  try {
    const files = fs.readdirSync(FIRECRAWL_ACTIVITY_DIR);
    const now = Date.now();
    for (const f of files) {
      if (!f.endsWith(".lock")) continue;
      const fullPath = path.join(FIRECRAWL_ACTIVITY_DIR, f);
      // Format: <pid>_<timestamp>_<rand>.lock
      const parts = f.replace(/\.lock$/, "").split("_");
      const pid = parseInt(parts[0], 10);
      const startedAt = parseInt(parts[1], 10);

      // Prune if dead PID or older than 45s (beyond 35s scrape timeout)
      if (
        isNaN(pid) ||
        isNaN(startedAt) ||
        now - startedAt > 45000 ||
        !isPidAlive(pid)
      ) {
        try {
          fs.unlinkSync(fullPath);
        } catch {
          // Ignore unlink error
        }
        continue;
      }
      activeCount++;
    }
  } catch {
    // Ignore read error
  }
  return activeCount;
}

let localInFlightScrapes = 0;

export function getInFlightScrapesCount(): number {
  return localInFlightScrapes;
}

export function createScrapeLock(): string {
  localInFlightScrapes++;
  ensureActivityDir();
  updateActivityHeartbeat();
  const lockFileName = `${process.pid}_${Date.now()}_${Math.random().toString(36).slice(2, 8)}.lock`;
  const lockPath = path.join(FIRECRAWL_ACTIVITY_DIR, lockFileName);
  try {
    fs.writeFileSync(lockPath, String(process.pid), { flag: "wx" });
  } catch {
    try {
      fs.writeFileSync(lockPath, String(process.pid));
    } catch {
      // Ignore write error
    }
  }
  return lockPath;
}

export function releaseScrapeLock(lockPath: string): void {
  localInFlightScrapes = Math.max(0, localInFlightScrapes - 1);
  updateActivityHeartbeat();
  try {
    if (fs.existsSync(lockPath)) {
      fs.unlinkSync(lockPath);
    }
  } catch {
    // Ignore error
  }
}

export function getFirecrawlUrl(): string {
  if (process.env.FIRECRAWL_URL) {
    return process.env.FIRECRAWL_URL.replace(/\/+$/, "");
  }
  if (process.env.FIRECRAWL_PORT) {
    const port = parseInt(process.env.FIRECRAWL_PORT, 10);
    if (!isNaN(port) && port > 0) {
      return `http://127.0.0.1:${port}`;
    }
  }
  return "http://127.0.0.1:3002";
}

export function getFirecrawlComposeDir(): string {
  if (process.env.FIRECRAWL_COMPOSE_DIR) {
    return process.env.FIRECRAWL_COMPOSE_DIR;
  }
  const home = process.env.HOME || os.homedir();
  const homeCandidate = path.join(home, "Documents/Firecrawl/firecrawl");
  if (fs.existsSync(homeCandidate)) {
    return homeCandidate;
  }
  return "/Users/ospeto/Documents/Firecrawl/firecrawl";
}

export function getFirecrawlIdleTimeoutMs(): number {
  if (process.env.FIRECRAWL_IDLE_TIMEOUT_MS) {
    const parsed = parseInt(process.env.FIRECRAWL_IDLE_TIMEOUT_MS, 10);
    if (!isNaN(parsed) && parsed >= 0) return parsed;
  }
  return 15 * 60 * 1000; // 15 minutes default
}

let firecrawlEnabledOverride: boolean | null = null;

export function isFirecrawlEnabled(): boolean {
  if (firecrawlEnabledOverride !== null) {
    return firecrawlEnabledOverride;
  }
  const val = process.env.FIRECRAWL_ENABLED;
  if (val === "false" || val === "0") return false;
  return true;
}

export function setFirecrawlEnabled(enabled: boolean | null): void {
  firecrawlEnabledOverride = enabled;
}

export function getDockerPath(): string {
  if (process.env.DOCKER_PATH) return process.env.DOCKER_PATH;
  const probe = spawnSync("which", ["docker"], { encoding: "utf8" });
  if (probe.status === 0 && probe.stdout?.trim()) return probe.stdout.trim();
  const candidates = [
    "/opt/homebrew/bin/docker",
    "/usr/local/bin/docker",
    "/usr/bin/docker",
    path.join(process.env.HOME || "", ".orbstack/bin/docker"),
  ];
  for (const cand of candidates) {
    if (fs.existsSync(cand)) return cand;
  }
  return "docker";
}

let idleTimer: ReturnType<typeof setTimeout> | null = null;

export function resetFirecrawlIdleTimer(delayMs?: number): void {
  cancelFirecrawlIdleTimer();
  const timeoutMs = getFirecrawlIdleTimeoutMs();
  if (timeoutMs <= 0) return;

  const waitMs = delayMs !== undefined ? delayMs : timeoutMs;

  idleTimer = setTimeout(async () => {
    idleTimer = null;

    // 1. Guard against local in-flight scrapes
    if (localInFlightScrapes > 0) {
      console.log(
        `[Firecrawl] Local in-flight scrape (${localInFlightScrapes}) active. Rescheduling auto-sleep...`,
      );
      resetFirecrawlIdleTimer();
      return;
    }

    // 2. Guard against cross-process active lock files
    const activeLocks = getActiveLockCount();
    if (activeLocks > 0) {
      console.log(
        `[Firecrawl] Detected ${activeLocks} active in-flight scrape(s) across processes. Rescheduling auto-sleep...`,
      );
      resetFirecrawlIdleTimer();
      return;
    }

    // 3. Check elapsed time since last activity across all processes
    const lastActiveAt = getLastActivityAt();
    const timeSinceActivity = Date.now() - lastActiveAt;
    if (lastActiveAt > 0 && timeSinceActivity < timeoutMs) {
      const remainingMs = Math.max(2000, timeoutMs - timeSinceActivity);
      console.log(
        `[Firecrawl] Scrape activity occurred ${Math.round(timeSinceActivity / 1000)}s ago. Re-checking auto-sleep in ${Math.round(remainingMs / 1000)}s...`,
      );
      // Wait ONLY the remaining window! When remainingMs elapses, it will check again without adding extra timeoutMs.
      resetFirecrawlIdleTimer(remainingMs);
      return;
    }

    console.log(
      `[Firecrawl] Inactivity window (${Math.round(timeoutMs / 60000)}m) reached without new scrape requests. Auto-stopping containers...`,
    );
    try {
      await stopFirecrawl();
    } catch (err: any) {
      console.warn(`[Firecrawl] Auto-stop failed: ${err.message}`);
    }
  }, waitMs);

  if (typeof (idleTimer as any)?.unref === "function") {
    (idleTimer as any).unref();
  }
}

export function cancelFirecrawlIdleTimer(): void {
  if (idleTimer) {
    clearTimeout(idleTimer);
    idleTimer = null;
  }
}

export function isFirecrawlIdleTimerActive(): boolean {
  return idleTimer !== null;
}

/**
 * Check if the Firecrawl service is currently running and responding to HTTP requests.
 */
export async function isFirecrawlRunning(timeoutMs = 2000): Promise<boolean> {
  const baseUrl = getFirecrawlUrl();
  try {
    const res = await safeFetchWithSsrf(
      `${baseUrl}/`,
      {
        method: "GET",
        signal: AbortSignal.timeout(timeoutMs),
      },
      5,
      { allowFirecrawlServer: true },
    );
    // Any HTTP response (200, 404, etc.) indicates the HTTP server is up and listening
    return res.status < 500;
  } catch {
    return false;
  }
}

/**
 * Ensure Firecrawl containers are running. If stopped, executes `docker compose start`
 * to wake the cluster and polls until ready.
 */
export async function ensureFirecrawlRunning(
  options: EnsureFirecrawlOptions = {},
): Promise<boolean> {
  if (!isFirecrawlEnabled()) {
    return false;
  }

  // If already running, reset the idle timer and proceed
  if (await isFirecrawlRunning()) {
    resetFirecrawlIdleTimer();
    return true;
  }

  const composeDir = getFirecrawlComposeDir();
  if (!fs.existsSync(composeDir)) {
    console.warn(
      `[Firecrawl] Compose directory not found at ${composeDir}. Cannot start Firecrawl containers.`,
    );
    return false;
  }

  const dockerBin = getDockerPath();
  const spawnFn = options.spawnCmd || spawnSync;

  console.log(`[Firecrawl] Waking containers via docker compose start in ${composeDir}...`);
  const startResult = spawnFn(dockerBin, ["compose", "start"], {
    cwd: composeDir,
    encoding: "utf8",
    timeout: 10000,
  });

  if (startResult.error || (startResult.status !== null && startResult.status !== 0)) {
    console.warn(
      `[Firecrawl] docker compose start failed (${startResult.error?.message || startResult.stderr || "exit " + startResult.status}). Trying docker compose up -d...`,
    );
    const upResult = spawnFn(dockerBin, ["compose", "up", "-d"], {
      cwd: composeDir,
      encoding: "utf8",
      timeout: 15000,
    });
    if (upResult.error || (upResult.status !== null && upResult.status !== 0)) {
      console.warn(
        `[Firecrawl] docker compose up -d failed: ${upResult.error?.message || upResult.stderr}`,
      );
      return false;
    }
  }

  // Poll until HTTP endpoint responds
  const totalTimeout = options.timeoutMs ?? 10000;
  const pollInterval = options.pollIntervalMs ?? 500;
  const startTime = Date.now();

  while (Date.now() - startTime < totalTimeout) {
    if (await isFirecrawlRunning(1000)) {
      console.log(
        `[Firecrawl] Cluster woke up and ready in ${Date.now() - startTime}ms.`,
      );
      resetFirecrawlIdleTimer();
      return true;
    }
    await new Promise((resolve) => setTimeout(resolve, pollInterval));
  }

  console.warn(
    `[Firecrawl] Timed out waiting for Firecrawl cluster to become ready (${totalTimeout}ms).`,
  );
  return false;
}

/**
 * Shut down Firecrawl containers to release RAM back to macOS.
 */
export async function stopFirecrawl(
  options: StopFirecrawlOptions = {},
): Promise<boolean> {
  // If not forced, check if there are in-flight scrapes locally or across processes
  if (!options.force) {
    if (localInFlightScrapes > 0) {
      console.warn(
        `[Firecrawl] Refusing to stop containers: ${localInFlightScrapes} scrape(s) in-flight locally.`,
      );
      return false;
    }
    const activeLocks = getActiveLockCount();
    if (activeLocks > 0) {
      console.warn(
        `[Firecrawl] Refusing to stop containers: ${activeLocks} scrape(s) in-flight across processes.`,
      );
      return false;
    }
  }

  cancelFirecrawlIdleTimer();

  // Clear directory lock files on stop
  try {
    if (fs.existsSync(FIRECRAWL_ACTIVITY_DIR)) {
      const files = fs.readdirSync(FIRECRAWL_ACTIVITY_DIR);
      for (const f of files) {
        try {
          fs.unlinkSync(path.join(FIRECRAWL_ACTIVITY_DIR, f));
        } catch {
          // Ignore unlink error
        }
      }
    }
  } catch {
    // Ignore error
  }

  const composeDir = getFirecrawlComposeDir();
  if (!fs.existsSync(composeDir)) {
    return false;
  }

  const dockerBin = getDockerPath();
  const spawnFn = options.spawnCmd || spawnSync;

  console.log(`[Firecrawl] Stopping containers via docker compose stop in ${composeDir}...`);
  const stopResult = spawnFn(dockerBin, ["compose", "stop"], {
    cwd: composeDir,
    encoding: "utf8",
    timeout: 15000,
  });

  if (stopResult.error || (stopResult.status !== null && stopResult.status !== 0)) {
    console.warn(
      `[Firecrawl] docker compose stop failed: ${stopResult.error?.message || stopResult.stderr}`,
    );
    return false;
  }

  console.log(`[Firecrawl] Successfully stopped containers. RAM released.`);
  return true;
}

/**
 * Scrape a web article via Firecrawl /v1/scrape endpoint.
 * Automatically wakes containers on demand and resets the auto-sleep idle timer.
 */
export async function scrapeArticleWithFirecrawl(
  targetUrl: string,
): Promise<ExtractedFirecrawlArticle | null> {
  if (!isFirecrawlEnabled()) {
    return null;
  }

  // Pre-flight SSRF check on target URL before delegating to Firecrawl
  const ssrfCheck = await validateUrlForSSRF(targetUrl, { allowProxyBypass: false });
  if (!ssrfCheck.safe) {
    console.warn(
      `[Firecrawl] SSRF check blocked target URL ${targetUrl}: ${ssrfCheck.error || "Restricted address"}`,
    );
    return null;
  }

  // Ensure containers are running (wake on demand)
  const isReady = await ensureFirecrawlRunning();
  if (!isReady) {
    console.log(
      `[Firecrawl] Service offline or failed to wake up. Falling back to next tier.`,
    );
    return null;
  }

  const lockPath = createScrapeLock();
  try {
    resetFirecrawlIdleTimer();

    const baseUrl = getFirecrawlUrl();
    const endpoint = `${baseUrl}/v1/scrape`;
    const apiKey = (process.env.FIRECRAWL_API_KEY || "").trim();

    const headers: Record<string, string> = {
      "Content-Type": "application/json",
    };
    if (apiKey) {
      headers["Authorization"] = `Bearer ${apiKey}`;
    }

    const payload = {
      url: targetUrl,
      formats: ["markdown"],
      onlyMainContent: true,
    };

    let res: Response;
    try {
      res = await safeFetchWithSsrf(
        endpoint,
        {
          method: "POST",
          headers,
          body: JSON.stringify(payload),
          signal: AbortSignal.timeout(35000),
        },
        5,
        { allowFirecrawlServer: true },
      );
    } catch (err: any) {
      console.warn(`[Firecrawl] Scrape request connection error: ${err.message}`);
      return null;
    }

    if (!res.ok) {
      console.warn(
        `[Firecrawl] Scrape request returned HTTP ${res.status} ${res.statusText}`,
      );
      return null;
    }

    let body: any;
    try {
      body = await res.json();
    } catch (jsonErr: any) {
      console.warn(
        `[Firecrawl] Failed to parse JSON response: ${jsonErr.message}`,
      );
      return null;
    }

    if (body?.success === false) {
      console.warn(
        `[Firecrawl] Scrape response indicated failure: ${body?.error || "Unknown error"}`,
      );
      return null;
    }

    const data = body?.data;
    if (!data || typeof data !== "object") {
      console.warn(`[Firecrawl] Response missing data object`);
      return null;
    }

    const markdown = (data.markdown || data.content || "").trim();
    if (!markdown) {
      console.warn(`[Firecrawl] Empty markdown returned from scraper`);
      return null;
    }

    const meta = data.metadata || {};
    const title = (
      meta.title ||
      meta["og:title"] ||
      meta["twitter:title"] ||
      ""
    ).trim();

    const author = (
      meta.author ||
      meta.byline ||
      meta["article:author"] ||
      meta["twitter:creator"] ||
      ""
    ).trim();

    const siteName = (
      meta["og:site_name"] ||
      meta.siteName ||
      meta.site_name ||
      ""
    ).trim();

    const publishedDate = (
      meta.publishedTime ||
      meta.publishedDate ||
      meta.date ||
      meta["article:published_time"] ||
      ""
    ).trim();

    const leadImageUrl = (
      meta["og:image"] ||
      meta.ogImage ||
      meta.image ||
      meta.leadImage ||
      meta.leadImageUrl ||
      meta["twitter:image"] ||
      ""
    ).trim();

    return {
      url: targetUrl,
      title,
      author,
      siteName,
      publishedDate: publishedDate || undefined,
      markdown,
      leadImageUrl: leadImageUrl || undefined,
    };
  } finally {
    releaseScrapeLock(lockPath);
    resetFirecrawlIdleTimer();
  }
}

/**
 * Returns detailed status of the Firecrawl cluster.
 */
export async function getFirecrawlStatus(): Promise<FirecrawlStatus> {
  const enabled = isFirecrawlEnabled();
  const running = enabled ? await isFirecrawlRunning(1500) : false;
  return {
    enabled,
    running,
    url: getFirecrawlUrl(),
    composeDir: getFirecrawlComposeDir(),
    idleTimeoutMs: getFirecrawlIdleTimeoutMs(),
    idleTimerActive: isFirecrawlIdleTimerActive(),
    inFlightScrapes: getInFlightScrapesCount(),
  };
}
