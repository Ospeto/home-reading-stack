import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import net from "node:net";
import process from "node:process";
import crypto from "node:crypto";
import { spawn, spawnSync } from "node:child_process";
import readline from "node:readline";
import {
  safeFetchWithSsrf,
  getBsdtarPath,
  getUnzipPath,
  extractEpubMetadata,
} from "./security";
import {
  isCommentsEmpty,
  extractEpubDescription,
  fetchOnlineSynopsis,
  parseRetryAfterMs,
} from "./scraper";
import {
  streamResponseToFile,
  runCalibredb,
  isVolumeAlreadyInCalibre,
  resolveIngestVolumeAssignment,
  getSipsPath,
  composeSignal,
  escapeTelegramMarkdown,
  validateDownloadedEpub,
  MAX_EPUB_BYTES,
} from "./lnori";

const SERVER_URL = "http://127.0.0.1:8088";
const PROXY_URL = "http://127.0.0.1:7890";
const USER_AGENT =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";
const SUBPROCESS_TIMEOUT_MS = 60_000;
const SUBPROCESS_MAX_BUFFER = 16 * 1024 * 1024;
const PYTHON_PROBE_TIMEOUT_MS = 8_000;
const PROXY_PROBE_TIMEOUT_MS = 400;
const PROXY_HEALTH_TTL_MS = 30_000;
export const MAX_VOLUMES_PER_REQUEST = 50;

/** Machine-readable codes so callers (and the reader-facing classifier) can name the real cause. */
export const ELSCIONE_PYTHON_DEPENDENCY_CODE = "ELSCIONE_PYTHON_DEPENDENCY_MISSING";
export const ELSCIONE_BLOCKED_CODE = "ELSCIONE_SOURCE_BLOCKED";

/**
 * Reader-meaningful text for the one failure that is neither the source's fault nor the reader's:
 * the host has no Python interpreter able to import `curl_cffi`, which the Elscione helper needs.
 */
export const ELSCIONE_PYTHON_DEPENDENCY_MESSAGE =
  "Elsci.one needs the Python curl_cffi package on the server, which is not installed. Install it with 'pip3 install curl_cffi' and retry.";

/**
 * Fail-closed text for a source that answered by blocking the automated request (Cloudflare
 * interstitial on top of an Anubis challenge) instead of by denying or by having nothing.
 */
export const ELSCIONE_BLOCKED_MESSAGE =
  "Elscione source blocked the automated request; this source is verified via browser only.";

export interface ElscioneDependencyError extends Error {
  code: typeof ELSCIONE_PYTHON_DEPENDENCY_CODE;
  dependencyMissing: true;
}

function createDependencyError(detail?: string): ElscioneDependencyError {
  const base = ELSCIONE_PYTHON_DEPENDENCY_MESSAGE;
  const err = new Error(
    detail && !base.includes(detail.trim()) ? `${base} (${detail.trim()})` : base,
  ) as ElscioneDependencyError;
  err.code = ELSCIONE_PYTHON_DEPENDENCY_CODE;
  err.dependencyMissing = true;
  return err;
}

export function isElscioneDependencyError(err: any): boolean {
  if (!err) return false;
  if (err.code === ELSCIONE_PYTHON_DEPENDENCY_CODE) return true;
  const msg = String(err?.message || err);
  return /curl_cffi/i.test(msg);
}

export function isElscioneBlockedError(err: any): boolean {
  return Boolean(err && err.code === ELSCIONE_BLOCKED_CODE);
}

function createBlockedError(detail?: string): Error {
  const err = new Error(
    detail ? `${ELSCIONE_BLOCKED_MESSAGE} (${detail})` : ELSCIONE_BLOCKED_MESSAGE,
  );
  (err as any).code = ELSCIONE_BLOCKED_CODE;
  return err;
}

/**
 * True when a response body is a Cloudflare interstitial ("Just a moment...", "Attention
 * required!") rather than the site or its bot challenge. Distinguishing the two matters: an
 * Anubis challenge can be solved, a Cloudflare interstitial on the pass-challenge hop cannot.
 */
export function isCloudflareInterstitial(text: string, res?: Response): boolean {
  if (res) {
    const mitigated = (res.headers.get("cf-mitigated") || "").toLowerCase();
    if (mitigated.includes("challenge")) return true;
  }
  if (!text) return false;
  return (
    /<title>\s*just a moment\.\.\.\s*<\/title>/i.test(text) ||
    /attention required!?\s*\|?\s*cloudflare/i.test(text) ||
    /cf_chl_opt|cdn-cgi\/challenge-platform|__cf_chl_/i.test(text) ||
    /checking your browser before accessing/i.test(text)
  );
}

/**
 * Browser-shaped headers a same-origin `fetch()` from the site itself would send.
 *
 * The source's edge rejects a bare POST (403 + Cloudflare "Attention Required!") but serves the
 * same request with 200 once `Accept-Language` and the Sec-Fetch family are present, so these are
 * part of talking to the source at all, not cosmetic.
 */
export function browserRequestHeaders(referer?: string): Record<string, string> {
  const headers: Record<string, string> = {
    "Accept-Language": "en-US,en;q=0.9",
    "Sec-Fetch-Dest": "empty",
    "Sec-Fetch-Mode": "cors",
    "Sec-Fetch-Site": "same-origin",
    "Sec-Ch-Ua": '"Google Chrome";v="131", "Chromium";v="131", "Not_A Brand";v="24"',
    "Sec-Ch-Ua-Mobile": "?0",
    "Sec-Ch-Ua-Platform": '"macOS"',
  };
  if (referer) {
    headers["Referer"] = referer;
    headers["Origin"] = safeCreateUrl(referer)?.origin || referer;
  }
  return headers;
}

let proxyHealthCache: { url: string; healthy: boolean; checkedAt: number } | null = null;

/** Test hook: forget the cached proxy health verdict. */
export function resetElscioneProxyHealthCacheForTest(): void {
  proxyHealthCache = null;
}

function defaultProxyProbe(proxyUrl: string): Promise<boolean> {
  return new Promise<boolean>((resolve) => {
    let settled = false;
    const finish = (healthy: boolean) => {
      if (settled) return;
      settled = true;
      resolve(healthy);
    };
    const parsed = safeCreateUrl(proxyUrl);
    if (!parsed) return finish(false);
    const port = Number(parsed.port || (parsed.protocol === "https:" ? 443 : 80));
    let socket: any;
    try {
      socket = net.connect({ host: parsed.hostname, port });
    } catch {
      return finish(false);
    }
    const timer = setTimeout(() => {
      try {
        socket.destroy();
      } catch {
        // ignore
      }
      finish(false);
    }, PROXY_PROBE_TIMEOUT_MS);
    socket.once("connect", () => {
      clearTimeout(timer);
      try {
        socket.destroy();
      } catch {
        // ignore
      }
      finish(true);
    });
    socket.once("error", () => {
      clearTimeout(timer);
      finish(false);
    });
  });
}

/**
 * The local sing-box listener accepts a TCP connection even when it cannot serve, so "something is
 * listening" proves nothing. Only a completed handshake counts, and the verdict is cached briefly
 * because a dead proxy must not add a probe to every request.
 */
export async function isElscioneProxyUsable(
  dependencies?: ElscioneDependencies,
): Promise<boolean> {
  const proxyUrl = dependencies?.proxyUrl || PROXY_URL;
  const probe = dependencies?.proxyProbe ?? defaultProxyProbe;
  const now = Date.now();
  if (
    proxyHealthCache &&
    proxyHealthCache.url === proxyUrl &&
    now - proxyHealthCache.checkedAt < PROXY_HEALTH_TTL_MS
  ) {
    return proxyHealthCache.healthy;
  }
  let healthy = false;
  try {
    healthy = (await probe(proxyUrl)) === true;
  } catch {
    healthy = false;
  }
  // Injected probes are per-test: never let one poison the cached verdict.
  if (!dependencies?.proxyProbe) {
    proxyHealthCache = { url: proxyUrl, healthy, checkedAt: now };
  }
  return healthy;
}

export interface ElscioneDependencies {
  fetch?: (url: string, init?: RequestInit) => Promise<Response>;
  spawnSync?: (...args: any[]) => any;
  spawn?: (...args: any[]) => any;
  sipsPath?: string;
  bsdtarPath?: string;
  unzipPath?: string;
  calibreDbPath?: string;
  isVolumeInLibrary?: (seriesTitle: string, volumeIndex: number, title: string) => boolean;
  sleep?: (ms: number) => Promise<void>;
  signal?: AbortSignal;
  helperPath?: string;
  pythonPath?: string;
  /**
   * Interpreter capability probe. Returning true means "can import curl_cffi". Injected in tests so
   * interpreter selection never depends on the host's real pythons.
   */
  pythonProbe?: (candidate: string) => boolean;
  /** Local proxy health probe. Returning true means "the proxy actually accepts and serves". */
  proxyProbe?: (proxyUrl: string) => Promise<boolean> | boolean;
  proxyUrl?: string;
  useHelper?: boolean;
  fetchOnlineSynopsis?: typeof fetchOnlineSynopsis;
  force?: boolean;
}

export interface AnubisChallenge {
  id: string;
  difficulty: number;
  randomData: string;
}

export interface AnubisSolution {
  id: string;
  hash: string;
  nonce: number;
  elapsedTime: number;
}

export interface ElscioneVolumeMeta {
  volumeNumber: number;
  partNumber?: number;
  filename: string;
  downloadUrl: string;
  title: string;
  size?: number;
}

export interface ElscioneManifest {
  seriesTitle: string;
  url: string;
  isSingleVolume: boolean;
  totalCount?: number;
  volumes: ElscioneVolumeMeta[];
}

export interface ElscioneProgressEvent {
  phase: "manifest" | "volume" | "complete" | "error";
  index?: number;
  total?: number;
  volumeTitle?: string;
  status?: string;
  data?: any;
}

export type ElscioneProgressCallback = (
  event: ElscioneProgressEvent,
) => Promise<void> | void;

export interface ElscioneIngestResult {
  success: boolean;
  seriesTitle: string;
  author: string;
  importedCount: number;
  skippedCount: number;
  duplicateCount: number;
  skippedErrors?: number;
  totalCount: number;
  tags: string[];
  calibreBookIds: number[];
  volumes?: number[];
  error?: string;
}

function safeCreateUrl(input: string, base?: string): URL | null {
  try {
    return base ? new URL(input, base) : new URL(input);
  } catch {
    return null;
  }
}

// Session cookie cache for server.elscione.com
const sessionCookies = new Map<string, string>();

export function getElscioneSessionCookies(): string {
  if (sessionCookies.size === 0) return "";
  return Array.from(sessionCookies.entries())
    .map(([k, v]) => `${k}=${v}`)
    .join("; ");
}

export function setElscioneSessionCookies(cookieHeaderOrString: string): void {
  if (!cookieHeaderOrString) return;
  const parts = cookieHeaderOrString.split(";");
  const COOKIE_ATTRIBUTES = new Set([
    "path",
    "domain",
    "expires",
    "samesite",
    "max-age",
    "secure",
    "httponly",
  ]);
  for (const part of parts) {
    const trimmed = part.trim();
    if (!trimmed) continue;
    const eqIdx = trimmed.indexOf("=");
    if (eqIdx > 0) {
      const name = trimmed.slice(0, eqIdx).trim();
      const value = trimmed.slice(eqIdx + 1).trim();
      if (!COOKIE_ATTRIBUTES.has(name.toLowerCase())) {
        sessionCookies.set(name, value);
      }
    }
  }
}

export function updateCookiesFromResponse(res: Response): void {
  const setCookies: string[] = [];
  if (typeof (res.headers as any).getSetCookie === "function") {
    setCookies.push(...(res.headers as any).getSetCookie());
  } else {
    const sc = res.headers.get("set-cookie");
    if (sc) setCookies.push(sc);
  }

  for (const cookieStr of setCookies) {
    setElscioneSessionCookies(cookieStr);
  }
}

export function resetElscioneSessionForTest(): void {
  sessionCookies.clear();
}

/**
 * Normalizes novel and folder URLs:
 * - Prepends https:// if protocol is missing (or //)
 * - Auto-encodes unencoded spaces in pathname as %20
 * - Preserves already-encoded %20, %27, query parameters, and hashes
 */
export function cleanAndNormalizeNovelUrl(raw: string): string {
  if (!raw || typeof raw !== "string") return "";
  let clean = raw.trim();
  if (!clean) return "";

  // Strip wrapping quotes/angle brackets (including Unicode curly quotes) if present
  if (
    (clean.startsWith('"') && clean.endsWith('"')) ||
    (clean.startsWith("'") && clean.endsWith("'")) ||
    (clean.startsWith("<") && clean.endsWith(">")) ||
    (clean.startsWith("\u201C") && clean.endsWith("\u201D")) ||
    (clean.startsWith("\u2018") && clean.endsWith("\u2019"))
  ) {
    clean = clean.slice(1, -1).trim();
  }
  // Strip unmatched leading or trailing wrapping quote characters
  clean = clean
    .replace(/^[\u201C\u2018"'<]+/, "")
    .replace(/[\u201D\u2019"'>]+$/, "")
    .trim();
  if (!clean) return "";

  // 1. Missing protocol prefix
  if (clean.startsWith("//")) {
    clean = "https:" + clean;
  } else if (!/^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//.test(clean)) {
    clean = "https://" + clean.replace(/^\/+/, "");
  }

  // 2. Separate origin/authority from pathname + search + hash
  const match = clean.match(/^([a-zA-Z][a-zA-Z0-9+.-]*:\/\/[^/?#]+)(.*)$/s);
  if (!match) return clean;

  const origin = match[1];
  const rest = match[2] || "";

  if (!rest) {
    return origin;
  }

  const restMatch = rest.match(/^([^?#]*)(?:\?([^#]*))?(?:#(.*))?$/s);
  let pathname = restMatch ? restMatch[1] : rest;
  const search = restMatch && restMatch[2] !== undefined ? restMatch[2] : null;
  const hash = restMatch && restMatch[3] !== undefined ? restMatch[3] : null;

  // Auto-encode unencoded spaces in path as %20
  // Note: we replace literal spaces/tabs/NBSP, leaving existing %20, %27, etc. intact
  pathname = pathname.replace(/[ \t\u00A0]/g, "%20");

  let result = origin + pathname;
  if (search !== null) {
    result += "?" + search.replace(/[ \t\u00A0]/g, "%20");
  }
  if (hash !== null) {
    result += "#" + hash.replace(/[ \t\u00A0]/g, "%20");
  }

  return result;
}

/**
 * URL Detection: returns true if the URL points to server.elscione.com or server.elsci.one (and mirror domains)
 */
export function isElscioneUrl(url: string): boolean {
  if (!url || typeof url !== "string") return false;
  try {
    const clean = cleanAndNormalizeNovelUrl(url);
    if (!clean) return false;
    const parsed = new URL(clean);
    const host = parsed.hostname.toLowerCase();
    return (
      host === "server.elscione.com" ||
      host === "elscione.com" ||
      host.endsWith(".elscione.com") ||
      host === "server.elsci.one" ||
      host === "elsci.one" ||
      host.endsWith(".elsci.one")
    );
  } catch {
    return false;
  }
}

/**
 * Parses an Elscione URL into components
 */
export function parseElscioneUrl(url: string): {
  hostname: string;
  pathname: string;
  isEpub: boolean;
  filename?: string;
  folderPath: string;
  seriesTitle?: string;
} | null {
  if (!isElscioneUrl(url)) return null;
  try {
    const clean = cleanAndNormalizeNovelUrl(url);
    const parsed = new URL(clean);
    const pathname = parsed.pathname;
    const isEpub = /\.epub$/i.test(pathname);

    const safeDecode = (s: string) => {
      try {
        return decodeURIComponent(s);
      } catch {
        return s;
      }
    };

    if (isEpub) {
      const filename = path.basename(safeDecode(pathname));
      const dirPath = path.dirname(pathname);
      const folderPath = dirPath.endsWith("/") ? dirPath : `${dirPath}/`;
      const segments = safeDecode(folderPath).split("/").filter(Boolean);
      const seriesTitle = segments.length > 0 ? segments[segments.length - 1] : undefined;
      return {
        hostname: parsed.hostname,
        pathname,
        isEpub: true,
        filename,
        folderPath,
        seriesTitle,
      };
    }

    const folderPath = pathname.endsWith("/") ? pathname : `${pathname}/`;
    const segments = safeDecode(folderPath).split("/").filter(Boolean);
    const seriesTitle = segments.length > 0 ? segments[segments.length - 1] : undefined;
    return {
      hostname: parsed.hostname,
      pathname,
      isEpub: false,
      folderPath,
      seriesTitle,
    };
  } catch {
    return null;
  }
}

const ELSCIONE_ROMAN_NUMERALS: Record<string, number> = {
  i: 1, ii: 2, iii: 3, iv: 4, v: 5, vi: 6, vii: 7, viii: 8, ix: 9, x: 10,
  xi: 11, xii: 12, xiii: 13, xiv: 14, xv: 15, xvi: 16, xvii: 17, xviii: 18, xix: 19, xx: 20,
};

/**
 * Extracts volume index from filename using standard light novel naming conventions
 */
export function extractVolumeNumberFromFilename(filename: string): number | undefined {
  const name = filename.replace(/\.epub$/i, "").trim();

  // Part X ... Volume Y or Part X ... vY (e.g. "Part 1 Volume 2" or "Part 1 Daughter of a Soldier v02")
  const partMatch = name.match(/Part\s*(\d+).*?(?:Volume|Vol\.?|v)\s*(\d+(?:\.\d+)?)/i);
  if (partMatch) {
    return parseFloat(partMatch[2]);
  }

  // Vol / Volume / Book patterns (e.g. "Volume 01", "Vol. 4.5", "Book 3")
  const volMatch = name.match(/(?:vol(?:ume)?|book)\.?\s*([0-9]+(?:\.[0-9]+)?)/i);
  if (volMatch) return parseFloat(volMatch[1]);

  // Roman numeral patterns (e.g. "Vol. IV", "Volume II", "Book III")
  const romanMatch = name.match(/(?:^|[\s_\-\[\(])(?:vol(?:ume)?|book)\.?\s*([ivx]+)(?:$|[\s_\-\]\):])/i);
  if (romanMatch && ELSCIONE_ROMAN_NUMERALS[romanMatch[1].toLowerCase()]) {
    return ELSCIONE_ROMAN_NUMERALS[romanMatch[1].toLowerCase()];
  }

  // v(\d+) (e.g. "Series v01.epub" or "Series - v02.epub")
  const vMatch = name.match(/(?:^|[\s_\-\[\(])v([0-9]+(?:\.[0-9]+)?)(?:$|[\s_\-\]\)])/i);
  if (vMatch) return parseFloat(vMatch[1]);

  // #01 pattern
  const hashMatch = name.match(/#\s*([0-9]+(?:\.[0-9]+)?)/);
  if (hashMatch) return parseFloat(hashMatch[1]);

  // " - 01" or " - 01 - " pattern
  const dashNumMatch = name.match(/(?:^|\s)-\s*([0-9]+(?:\.[0-9]+)?)(?:\s|-|$)/);
  if (dashNumMatch) return parseFloat(dashNumMatch[1]);

  // Trailing numbers like "Series 01" (guard against 4-digit years like 1984 or 2077)
  const trailingNumMatch = name.match(/\b([0-9]+(?:\.[0-9]+)?)\s*$/);
  if (trailingNumMatch) {
    const rawDigits = trailingNumMatch[1];
    const val = parseFloat(rawDigits);
    if (rawDigits.length === 4 && val >= 1800 && val <= 2100) {
      return undefined;
    }
    return val;
  }

  return undefined;
}

/**
 * Parses Anubis challenge JSON from HTML
 */
export function parseAnubisChallenge(html: string): AnubisChallenge | null {
  if (!html || typeof html !== "string") return null;

  const match =
    html.match(/<script[^>]*id=["']anubis_challenge["'][^>]*>([\s\S]*?)<\/script>/i) ||
    html.match(/<script[^>]*type=["']application\/json["'][^>]*id=["']anubis_challenge["'][^>]*>([\s\S]*?)<\/script>/i);

  if (!match || !match[1]) return null;

  try {
    const parsed = JSON.parse(match[1].trim());
    if (!parsed || typeof parsed !== "object") return null;

    // Support both stock Anubis nested format: { rules: { difficulty }, challenge: { id, randomData } }
    // and flat format: { id, difficulty, randomData }
    const ch =
      parsed.challenge && typeof parsed.challenge === "object"
        ? parsed.challenge
        : parsed;

    const id = ch.id;
    const randomData = ch.randomData;
    let difficulty: number | undefined;
    if (typeof parsed.rules?.difficulty === "number") {
      difficulty = parsed.rules.difficulty;
    } else if (typeof ch.difficulty === "number") {
      difficulty = ch.difficulty;
    }

    if (
      typeof id === "string" &&
      typeof randomData === "string" &&
      typeof difficulty === "number" &&
      Number.isFinite(difficulty) &&
      difficulty >= 0 &&
      difficulty <= 64
    ) {
      return {
        id,
        difficulty: Math.floor(difficulty),
        randomData,
      };
    }
  } catch {
    // invalid JSON
  }

  return null;
}

/**
 * Computes SHA-256 hash h = sha256(randomData + nonce) until difficulty leading zero half-bytes are satisfied.
 * Yields periodically to the event loop so SSE progress and queue draining are not blocked.
 */
export async function solveAnubisChallenge(
  challenge: AnubisChallenge,
  signal?: AbortSignal,
): Promise<AnubisSolution> {
  const safeDifficulty = Math.min(
    64,
    Math.max(0, Math.floor(challenge.difficulty || 0)),
  );
  const targetPrefix = "0".repeat(safeDifficulty);
  const startTime = Date.now();
  let nonce = 0;
  let hash = "";
  const MAX_NONCE = 50_000_000;

  while (nonce < MAX_NONCE) {
    if ((nonce & 0x7ff) === 0) {
      if (signal?.aborted) {
        throw new Error("Anubis challenge solving aborted by client");
      }
      // Non-blocking yield to event loop every 2048 nonces
      await new Promise((resolve) => setTimeout(resolve, 0));
    }

    hash = crypto
      .createHash("sha256")
      .update(challenge.randomData + nonce)
      .digest("hex");

    if (hash.startsWith(targetPrefix)) {
      break;
    }
    nonce++;
  }

  if (nonce >= MAX_NONCE) {
    throw new Error("Anubis challenge solving exceeded maximum nonce limit");
  }

  const elapsedTime = Date.now() - startTime;
  return {
    id: challenge.id,
    hash,
    nonce,
    elapsedTime,
  };
}

/**
 * Submits the Anubis solution to pass-challenge and captures authorized session cookies
 */
export async function submitAnubisSolution(
  baseUrl: string,
  solution: AnubisSolution,
  redirPath: string,
  dependencies?: ElscioneDependencies,
): Promise<{ cookies: string }> {
  const fetcher = dependencies?.fetch ?? safeFetchWithSsrf;
  const parsed = safeCreateUrl(baseUrl);
  if (!parsed) {
    throw new Error(`Invalid base URL for Anubis pass-challenge: ${baseUrl}`);
  }
  const passUrl = safeCreateUrl(
    "/.within.website/x/cmd/anubis/api/pass-challenge",
    parsed.origin,
  );
  if (!passUrl) {
    throw new Error("Failed to construct Anubis pass-challenge URL");
  }
  passUrl.searchParams.set("id", solution.id);
  passUrl.searchParams.set("response", solution.hash);
  passUrl.searchParams.set("nonce", String(solution.nonce));
  passUrl.searchParams.set("redir", redirPath || "/");
  passUrl.searchParams.set("elapsedTime", String(solution.elapsedTime));

  const headers: Record<string, string> = {
    "User-Agent": USER_AGENT,
    Referer: baseUrl,
    "Accept-Language": "en-US,en;q=0.9",
  };
  if (isElscioneUrl(passUrl.toString())) {
    const currentCookies = getElscioneSessionCookies();
    if (currentCookies) {
      headers["Cookie"] = currentCookies;
    }
  }

  const requestPassChallenge = async (useProxy: boolean): Promise<Response> => {
    const reqInit: any = {
      method: "GET",
      headers,
      signal: composeSignal(30000, dependencies?.signal),
      redirect: "manual",
    };
    if (useProxy) {
      reqInit.proxy = dependencies?.proxyUrl || PROXY_URL;
    }
    return await fetcher(passUrl.toString(), reqInit);
  };

  let res: Response;
  try {
    res = await requestPassChallenge(false);
  } catch (directErr: any) {
    if (dependencies?.signal?.aborted) {
      throw new Error("Anubis pass-challenge aborted by client");
    }
    // The local proxy is a fallback, not the path: a dead listener must not mask the direct error.
    const proxyUsable = await isElscioneProxyUsable(dependencies);
    if (!proxyUsable) {
      throw new Error(
        `Anubis pass-challenge could not reach the source directly (${directErr?.message || directErr}) and the local proxy is not usable`,
      );
    }
    res = await requestPassChallenge(true);
  }

  // A Cloudflare interstitial here means the edge is refusing this client outright: solving again
  // would hit the same wall, so this outcome is reported as a block, not retried.
  if (res.status === 403 || res.status === 503) {
    const body = await res.clone().text().catch(() => "");
    if (isCloudflareInterstitial(body, res)) {
      throw createBlockedError("blocked at Anubis pass-challenge");
    }
  }

  updateCookiesFromResponse(res);
  return { cookies: getElscioneSessionCookies() };
}

/**
 * Authenticated HTTP request wrapper that detects Anubis challenge, solves PoW, and retries seamlessly
 */
export async function fetchWithAnubis(
  targetUrl: string,
  init?: RequestInit,
  dependencies?: ElscioneDependencies,
): Promise<Response> {
  const fetcher = dependencies?.fetch ?? safeFetchWithSsrf;

  const buildHeaders = (
    baseHeaders?: HeadersInit,
    target: string = targetUrl,
  ): Record<string, string> => {
    const h: Record<string, string> = {
      "User-Agent": USER_AGENT,
    };
    if (baseHeaders) {
      if (baseHeaders instanceof Headers) {
        baseHeaders.forEach((val, key) => {
          h[key] = val;
        });
      } else if (Array.isArray(baseHeaders)) {
        for (const [k, v] of baseHeaders) {
          h[k] = v;
        }
      } else {
        Object.assign(h, baseHeaders);
      }
    }
    // Only attach Elscione session cookies if target is an allowed Elscione host
    if (isElscioneUrl(target)) {
      const cookies = getElscioneSessionCookies();
      if (cookies && !h["Cookie"]) {
        h["Cookie"] = cookies;
      }
    }
    return h;
  };

  const doFetch = async (
    target: string,
    useProxy: boolean,
    reqHeaders: Record<string, string>,
  ): Promise<Response> => {
    const reqInit: any = {
      ...init,
      headers: reqHeaders,
      redirect: "manual",
      signal: composeSignal(30000, dependencies?.signal),
    };
    if (useProxy) {
      reqInit.proxy = dependencies?.proxyUrl || PROXY_URL;
    }
    return await fetcher(target, reqInit);
  };

  const fetchWithRetry = async (target: string): Promise<Response> => {
    try {
      return await doFetch(target, false, buildHeaders(init?.headers, target));
    } catch (directErr: any) {
      if (dependencies?.signal?.aborted) {
        throw new Error("Elscione request aborted by client");
      }
      // Direct is the primary path. The local proxy is only worth a second attempt when it can
      // actually serve, because the sing-box listener accepts connections and then resets, which
      // would turn one honest failure into a second misleading one.
      const proxyUsable = await isElscioneProxyUsable(dependencies);
      if (!proxyUsable) {
        throw new Error(
          `Elscione request failed directly (${directErr?.message || directErr}) and the local proxy is not usable`,
        );
      }
      return await doFetch(target, true, buildHeaders(init?.headers, target));
    }
  };

  let currentUrl = targetUrl;
  let res: Response = await fetchWithRetry(currentUrl);

  // Handle redirects safely: never follow redirects off allowed Elscione hosts
  let redirectCount = 0;
  const MAX_REDIRECTS = 5;
  while (res.status >= 300 && res.status < 400 && redirectCount < MAX_REDIRECTS) {
    const location = res.headers.get("location");
    if (!location) break;
    const redirectUrlObj = safeCreateUrl(location, currentUrl);
    if (!redirectUrlObj) {
      throw new Error(`Invalid redirect location from Elscione: ${location}`);
    }
    const nextUrl = redirectUrlObj.toString();
    if (!isElscioneUrl(nextUrl)) {
      throw new Error(
        `Refusing to follow redirect from Elscione to off-host target: ${nextUrl}`,
      );
    }
    redirectCount++;
    currentUrl = nextUrl;
    res = await fetchWithRetry(currentUrl);
  }

  // Only capture session cookies if landing response URL is an allowed Elscione host
  if (isElscioneUrl(currentUrl)) {
    updateCookiesFromResponse(res);
  }

  // Check if response contains Anubis challenge HTML
  const contentType = (res.headers.get("content-type") || "").toLowerCase();
  const isBinaryPayload =
    contentType.includes("application/epub") ||
    contentType.includes("application/zip") ||
    contentType.includes("application/octet-stream");

  // Only check for Anubis challenge if targetUrl is an allowed Elscione host
  // and response could be an HTML challenge page;
  // NEVER clone or read full text on large binary EPUB/ZIP downloads!
  const couldBeChallenge =
    isElscioneUrl(currentUrl) &&
    !isBinaryPayload &&
    (res.status === 403 ||
      res.status === 401 ||
      (contentType.includes("text/html") && res.status >= 200 && res.status < 500));

  if (couldBeChallenge) {
    const text = await res.clone().text().catch(() => "");
    const challenge = parseAnubisChallenge(text);

    if (challenge) {
      const solution = await solveAnubisChallenge(challenge, dependencies?.signal);
      const parsed = safeCreateUrl(targetUrl);
      const redirPath = parsed ? parsed.pathname : "/";
      await submitAnubisSolution(targetUrl, solution, redirPath, dependencies);

      // Retry original request with newly acquired session cookies
      res = await fetchWithRetry(currentUrl);
      if (isElscioneUrl(currentUrl)) {
        updateCookiesFromResponse(res);
      }

      // One attempt only. A challenge that survives the solved cookie is a block, not a transient
      // hiccup; retrying again would hammer the same wall and still end in a misleading 403.
      const retryContentType = (res.headers.get("content-type") || "").toLowerCase();
      if (
        res.status === 403 ||
        res.status === 401 ||
        (retryContentType.includes("text/html") && res.status >= 200 && res.status < 300)
      ) {
        const retryText = await res.clone().text().catch(() => "");
        if (isCloudflareInterstitial(retryText, res)) {
          throw createBlockedError("Cloudflare interstitial after solving the Anubis challenge");
        }
        if (parseAnubisChallenge(retryText)) {
          throw createBlockedError("Anubis challenge persisted after solving");
        }
      }
    }
  }

  return res;
}

export function safeDecodeURIComponent(str: string): string {
  if (!str) return "";
  let curr = str;
  for (let i = 0; i < 15; i++) {
    try {
      const nxt = decodeURIComponent(curr);
      if (nxt === curr) break;
      curr = nxt;
    } catch {
      break;
    }
  }
  return curr;
}

export function normalizeScopedPath(pathStr: string): string {
  if (!pathStr) return "";
  const fullyDecoded = safeDecodeURIComponent(pathStr).replace(/\\/g, "/");
  // If encoded dot/slash sequences or percent signs still linger after 15 decodes, reject as invalid traversal
  if (/%2[eef]/i.test(fullyDecoded) || /%25/i.test(fullyDecoded)) {
    return "/__DISALLOWED_RECURSIVE_ENCODING__";
  }
  return path.posix.normalize(fullyDecoded);
}

export function getElscioneHelperPath(dependencies?: ElscioneDependencies): string {
  if (dependencies?.helperPath) return dependencies.helperPath;
  let currentDir = "";
  try {
    currentDir = (import.meta as any).dir || path.dirname(new URL(import.meta.url).pathname);
  } catch {
    currentDir = path.join(process.cwd(), "uploader");
  }
  const possiblePaths = [
    path.join(currentDir, "scripts", "elscione_helper.py"),
    path.join(process.cwd(), "uploader", "scripts", "elscione_helper.py"),
    path.join(process.cwd(), "scripts", "elscione_helper.py"),
  ];
  for (const p of possiblePaths) {
    if (fs.existsSync(p)) return p;
  }
  return possiblePaths[0];
}

const PYTHON_CAPABILITY_PROBE_ARGS = ["-c", "import curl_cffi"];
const HOMEBREW_PYTHON_DIRS = ["/opt/homebrew/bin", "/usr/local/bin"];

let cachedCapablePythonPath: string | null = null;

/** Test hook: forget the cached interpreter so capability probing runs again. */
export function resetElscionePythonCacheForTest(): void {
  cachedCapablePythonPath = null;
}

/**
 * Every interpreter worth probing, in priority order: explicit configuration first, then the
 * Homebrew pythons most likely to carry `curl_cffi`, then whatever `python3` resolves to.
 */
export function listPythonCandidates(env: NodeJS.ProcessEnv = process.env): string[] {
  const candidates: string[] = [];
  const seen = new Set<string>();
  const push = (candidate?: string | null) => {
    const clean = typeof candidate === "string" ? candidate.trim() : "";
    if (!clean || seen.has(clean)) return;
    seen.add(clean);
    candidates.push(clean);
  };

  push(env.ELSCIONE_PYTHON_PATH);
  push(env.PYTHON_PATH);
  push("/opt/homebrew/bin/python3.14");
  push("/opt/homebrew/bin/python3");
  push("/usr/local/bin/python3");

  // Remaining Homebrew minors, newest first: an interpreter that is merely present says nothing
  // about whether it can import `curl_cffi`, so all of them are probed rather than trusted.
  const minors: string[] = [];
  for (const dir of HOMEBREW_PYTHON_DIRS) {
    let entries: string[] = [];
    try {
      entries = fs.readdirSync(dir);
    } catch {
      continue;
    }
    for (const entry of entries) {
      const match = entry.match(/^python3\.(\d+)$/);
      if (!match) continue;
      minors.push({ path: path.join(dir, entry), minor: Number(match[1]) } as any);
    }
  }
  const sortedMinors = (minors as any[])
    .sort((a, b) => b.minor - a.minor)
    .map((entry) => entry.path as string);
  for (const p of sortedMinors) push(p);

  push("python3");
  return candidates;
}

/**
 * Default capability probe: the interpreter must actually import `curl_cffi`. Bounded so a hung
 * interpreter cannot stall a request, and fail-closed on a missing binary.
 */
function defaultPythonProbe(candidate: string): boolean {
  try {
    const res = spawnSync(candidate, PYTHON_CAPABILITY_PROBE_ARGS, {
      encoding: "utf8",
      timeout: PYTHON_PROBE_TIMEOUT_MS,
      maxBuffer: 1024 * 1024,
    });
    if (!res || res.error) return false;
    return res.status === 0;
  } catch {
    return false;
  }
}

/**
 * Selects a Python interpreter that can genuinely run the Elscione helper.
 *
 * Existence is not capability: Homebrew's `/opt/homebrew/bin/python3` can be a newer minor with no
 * `curl_cffi`, and choosing it made every Elscione fetch fail while a usable interpreter sat next to
 * it. Candidates are probed in order and the first one that imports `curl_cffi` wins, cached for the
 * process lifetime. When none qualify this throws a dependency error that names the missing package
 * instead of letting the caller report a network failure.
 */
export function getPythonPath(dependencies?: ElscioneDependencies): string {
  if (dependencies?.pythonPath) return dependencies.pythonPath;
  if (cachedCapablePythonPath) return cachedCapablePythonPath;

  const injectedProbe = dependencies?.pythonProbe;
  const probe = injectedProbe ?? defaultPythonProbe;

  for (const candidate of listPythonCandidates()) {
    let capable = false;
    try {
      capable = probe(candidate) === true;
    } catch {
      capable = false;
    }
    if (capable) {
      // Only the real host probe is authoritative enough to cache; an injected probe is per-test.
      if (!injectedProbe) cachedCapablePythonPath = candidate;
      return candidate;
    }
  }

  throw createDependencyError("no Python interpreter on this host can import curl_cffi");
}

/**
 * Invokes uploader/scripts/elscione_helper.py to extract series manifest
 */
export async function runElscioneHelperManifest(
  url: string,
  dependencies?: ElscioneDependencies,
): Promise<ElscioneManifest> {
  const helperPath = getElscioneHelperPath(dependencies);
  if (!fs.existsSync(helperPath)) {
    throw new Error(`Elscione helper script not found at ${helperPath}`);
  }
  const pythonBin = getPythonPath(dependencies);
  const runSpawnSync = dependencies?.spawnSync ?? spawnSync;

  const res = runSpawnSync(pythonBin, [helperPath, "manifest", url], {
    encoding: "utf8",
    timeout: SUBPROCESS_TIMEOUT_MS,
    maxBuffer: SUBPROCESS_MAX_BUFFER,
  });

  if (res.status !== 0) {
    const detail = `${res.stderr || ""}${res.stdout || ""}`;
    // The helper prints the missing-dependency instructions on stderr and exits 1. That is a
    // setup fault on this host, not a network fault, so it is re-thrown as one.
    if (/curl_cffi/i.test(detail)) {
      throw createDependencyError(detail.trim().split("\n").pop() || undefined);
    }
    throw new Error(
      `Elscione helper manifest exited with status ${res.status}: ${res.stderr || res.stdout}`,
    );
  }

  let parsed: any;
  try {
    parsed = JSON.parse(res.stdout);
  } catch (err: any) {
    throw new Error(`Failed to parse Elscione helper JSON: ${err?.message || err}`);
  }

  if (!parsed.success || !Array.isArray(parsed.volumes)) {
    throw new Error(parsed.error || "Elscione helper returned unsuccessful manifest");
  }

  const parsedUrl = parseElscioneUrl(url);
  const targetFolder = parsedUrl && !parsedUrl.isEpub ? parsedUrl.folderPath : null;
  const normTargetFolder = targetFolder
    ? normalizeScopedPath(targetFolder).replace(/\/+$/, "") + "/"
    : null;

  const filteredVolumes = parsed.volumes
    .filter((v: any) => {
      if (!v || typeof v.downloadUrl !== "string") return false;
      if (!isElscioneUrl(v.downloadUrl)) return false;
      if (normTargetFolder) {
        const itemUrl = safeCreateUrl(v.downloadUrl);
        if (!itemUrl) return false;
        const normItemPath = normalizeScopedPath(itemUrl.pathname);
        if (!normItemPath.startsWith(normTargetFolder)) return false;
      }
      return true;
    })
    .map((v: any) => ({
      volumeNumber: v.volumeNumber,
      partNumber: typeof v.partNumber === "number" ? v.partNumber : undefined,
      filename: v.filename,
      downloadUrl: v.downloadUrl,
      title: v.title,
      size: typeof v.size === "number" ? v.size : undefined,
    }));

  return {
    seriesTitle: parsed.seriesTitle || "Light Novel",
    url: parsed.url || url,
    isSingleVolume: Boolean(parsed.isSingleVolume),
    totalCount: filteredVolumes.length,
    volumes: filteredVolumes,
  };
}

const DOWNLOAD_TIMEOUT_MS = 10 * 60 * 1000;
const MAX_STDERR_BYTES = 1024 * 1024;

/**
 * Invokes uploader/scripts/elscione_helper.py to stream EPUB download with progress reporting
 */
export async function runElscioneHelperDownload(
  downloadUrl: string,
  destPath: string,
  onProgress?: (progressPercent: number) => void,
  dependencies?: ElscioneDependencies,
): Promise<void> {
  const helperPath = getElscioneHelperPath(dependencies);
  if (!fs.existsSync(helperPath)) {
    throw new Error(`Elscione helper script not found at ${helperPath}`);
  }
  const pythonBin = getPythonPath(dependencies);
  const runSpawn = dependencies?.spawn ?? spawn;

  await new Promise<void>((resolve, reject) => {
    let settled = false;
    let timer: any = null;

    const cleanup = () => {
      if (timer) {
        clearTimeout(timer);
        timer = null;
      }
      if (abortHandler && dependencies?.signal) {
        dependencies.signal.removeEventListener("abort", abortHandler);
      }
    };

    const safeResolve = () => {
      if (settled) return;
      settled = true;
      cleanup();
      resolve();
    };

    const safeReject = (err: Error) => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(err);
    };

    const proc = runSpawn(pythonBin, [helperPath, "download", downloadUrl, destPath], {
      stdio: ["ignore", "pipe", "pipe"],
    });

    const killProcessWithEscalation = () => {
      if (typeof proc.kill === "function") {
        proc.kill("SIGTERM");
        setTimeout(() => {
          try {
            if (typeof proc.kill === "function") proc.kill("SIGKILL");
          } catch (killErr) {
            console.debug("[Elscione] SIGKILL ignored:", killErr);
          }
        }, 3000);
      }
    };

    let abortHandler: (() => void) | null = null;
    if (dependencies?.signal) {
      if (dependencies.signal.aborted) {
        killProcessWithEscalation();
        return safeReject(new Error("Elscione ingestion aborted by client"));
      }
      abortHandler = () => {
        killProcessWithEscalation();
        safeReject(new Error("Elscione ingestion aborted by client"));
      };
      dependencies.signal.addEventListener("abort", abortHandler, { once: true });
    }

    timer = setTimeout(() => {
      killProcessWithEscalation();
      safeReject(new Error(`Elscione helper download timed out after ${DOWNLOAD_TIMEOUT_MS}ms`));
    }, DOWNLOAD_TIMEOUT_MS);

    let stderr = "";
    if (proc.stderr) {
      proc.stderr.on("data", (chunk: any) => {
        if (stderr.length < MAX_STDERR_BYTES) {
          stderr += chunk.toString().slice(0, MAX_STDERR_BYTES - stderr.length);
        }
      });
    }

    if (proc.stdout) {
      const rl = readline.createInterface({ input: proc.stdout });
      rl.on("line", (line: string) => {
        if (line.startsWith("PROGRESS:") && onProgress) {
          const match = line.match(/PROGRESS:\s*([0-9]+(?:\.[0-9]+)?)%/);
          if (match) {
            onProgress(parseFloat(match[1]));
          }
        }
      });
    }

    proc.on("error", (err: any) => {
      safeReject(err);
    });

    proc.on("close", (code: number) => {
      if (code === 0) {
        safeResolve();
      } else {
        safeReject(new Error(`Elscione helper download failed (exit ${code}): ${stderr}`));
      }
    });
  });

  validateDownloadedEpub(destPath);
}

/**
 * Extracts folder & manifest from server.elscione.com:
 * Handles both series folders (via _h5ai directory API) and direct .epub file URLs.
 */
export async function extractElscioneManifest(
  url: string,
  dependencies?: ElscioneDependencies,
): Promise<ElscioneManifest> {
  const normalizedUrl = cleanAndNormalizeNovelUrl(url);
  const parsed = parseElscioneUrl(normalizedUrl);
  if (!parsed) {
    throw new Error(`Invalid Elscione URL: ${url}. Expected server.elscione.com or server.elsci.one URL.`);
  }

  // 1. Direct .epub file URL: treat as 1-volume manifest
  if (parsed.isEpub && parsed.filename) {
    const volNum = extractVolumeNumberFromFilename(parsed.filename) ?? 1;
    const seriesTitle =
      parsed.seriesTitle ||
      parsed.filename.replace(/\s*-\s*vol(?:ume)?.*$/i, "").replace(/\.epub$/i, "").trim() ||
      "Light Novel";

    const partMatch = parsed.filename.match(/Part\s*(\d+)/i);
    const partNum = partMatch ? parseInt(partMatch[1], 10) : undefined;
    const title = partMatch
      ? `${seriesTitle}: Part ${partMatch[1]} Volume ${volNum}`
      : `${seriesTitle}: Volume ${volNum}`;

    return {
      seriesTitle,
      url: normalizedUrl,
      isSingleVolume: true,
      totalCount: 1,
      volumes: [
        {
          volumeNumber: volNum,
          partNumber: partNum,
          filename: parsed.filename,
          downloadUrl: normalizedUrl,
          title,
        },
      ],
    };
  }

  // Check if helper can be used (disabled if mock fetch dependency is provided for unit tests)
  const hasMockFetch = Boolean(dependencies?.fetch);
  const allowHelper = dependencies?.useHelper !== false && !hasMockFetch;

  if (allowHelper) {
    try {
      const helperManifest = await runElscioneHelperManifest(url, dependencies);
      if (helperManifest && helperManifest.volumes.length > 0) {
        return helperManifest;
      }
    } catch (err: any) {
      if (dependencies?.signal?.aborted) {
        throw err;
      }
      // A missing Python dependency is not a network fault and the in-process fallback cannot fix
      // it: report the real cause instead of a second, unrelated failure.
      if (isElscioneDependencyError(err)) {
        throw createDependencyError(err?.message);
      }
      console.warn(
        `[Elscione] Helper manifest failed, falling back to in-process fetch: ${err?.message || err}`,
      );
    }
  }

  // 2. Pure JS fallback for series folder URL: POST to folder path with _h5ai JSON action
  const folderPath = parsed.folderPath;
  const seriesTitle = parsed.seriesTitle || "Light Novel";

  const targetFolderUrlObj = safeCreateUrl(folderPath, `https://${parsed.hostname}`);
  if (!targetFolderUrlObj) {
    throw new Error(`Failed to construct target folder URL for ${folderPath}`);
  }
  const targetFolderUrl = targetFolderUrlObj.toString();

  const h5aiPayload = JSON.stringify({
    action: "get",
    items: {
      href: folderPath,
      what: 1,
    },
  });

  const res = await fetchWithAnubis(
    targetFolderUrl,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json;charset=utf-8",
        Accept: "application/json, text/plain, */*",
        ...browserRequestHeaders(targetFolderUrl),
      },
      body: h5aiPayload,
    },
    dependencies,
  );

  if (!res.ok) {
    // A block is not the same fact as a refusal or an outage: name it before falling through to
    // the generic status error, so a Cloudflare wall never surfaces as a plain 403.
    const failureBody = await res.clone().text().catch(() => "");
    if (isCloudflareInterstitial(failureBody, res)) {
      throw createBlockedError(`Cloudflare interstitial (HTTP ${res.status})`);
    }
    if (parseAnubisChallenge(failureBody)) {
      throw createBlockedError(`Anubis challenge could not be passed (HTTP ${res.status})`);
    }
    throw new Error(
      `Failed to fetch directory manifest from Elscione (${res.status}): ${targetFolderUrl}`,
    );
  }

  let bodyJson: any;
  try {
    bodyJson = await res.json();
  } catch (err: any) {
    // A challenge or interstitial parses as HTML, not JSON. Saying "failed to parse" there hides
    // the fact that the source blocked the request, and would let callers report "unverified".
    const bodyText = await res.text().catch(() => "");
    if (isCloudflareInterstitial(bodyText, res)) {
      throw createBlockedError("Cloudflare interstitial instead of a manifest");
    }
    if (parseAnubisChallenge(bodyText)) {
      throw createBlockedError("Anubis challenge could not be passed");
    }
    throw new Error(`Failed to parse Elscione _h5ai JSON response: ${err?.message || err}`);
  }

  // _h5ai returns items either as an array or as an object mapping href to item info
  let rawItems: any[] = [];
  const itemsContainer = bodyJson?.items ?? bodyJson?.data?.items;
  if (Array.isArray(itemsContainer)) {
    rawItems = itemsContainer;
  } else if (itemsContainer && typeof itemsContainer === "object") {
    rawItems = Object.values(itemsContainer);
  }

  interface RawItemInfo {
    volNum: number | undefined;
    partNum: number | undefined;
    filename: string;
    downloadUrl: string;
    size?: number;
  }
  const numberedItems: RawItemInfo[] = [];
  const unnumberedItems: RawItemInfo[] = [];

  const normTarget = normalizeScopedPath(folderPath).replace(/\/+$/, "") + "/";

  for (const item of rawItems) {
    const href = item.href || item.name;
    if (!href || typeof href !== "string") continue;
    if (!/\.epub$/i.test(href)) continue;

    // Resolve each listing href against target folder URL
    const downloadUrlObj = safeCreateUrl(href, targetFolderUrl);
    if (!downloadUrlObj) continue;

    // Require host to be an allowed Elscione host
    if (!isElscioneUrl(downloadUrlObj.toString())) continue;

    // Require path to stay inside the target folder (with full recursive decode and backslash normalization)
    const resolvedNormPath = normalizeScopedPath(downloadUrlObj.pathname);
    if (!resolvedNormPath.startsWith(normTarget)) continue;

    const filename = path.posix.basename(resolvedNormPath);
    const volNum = extractVolumeNumberFromFilename(filename);
    const partMatch = filename.match(/Part\s*(\d+)/i);
    const partNum = partMatch ? parseInt(partMatch[1], 10) : undefined;
    const downloadUrl = downloadUrlObj.toString();

    const rawInfo: RawItemInfo = {
      volNum,
      partNum,
      filename,
      downloadUrl,
      size: typeof item.size === "number" ? item.size : undefined,
    };

    if (typeof volNum === "number") {
      numberedItems.push(rawInfo);
    } else {
      unnumberedItems.push(rawInfo);
    }
  }

  const totalFound = numberedItems.length + unnumberedItems.length;
  if (totalFound === 0) {
    throw new Error(`No EPUB volumes found in Elscione folder: ${targetFolderUrl}`);
  }

  // Sort numbered items numerically by (part, volume index, filename)
  numberedItems.sort((a, b) => {
    if ((a.partNum ?? 0) !== (b.partNum ?? 0)) {
      return (a.partNum ?? 0) - (b.partNum ?? 0);
    }
    if (a.volNum !== b.volNum) {
      return (a.volNum ?? 0) - (b.volNum ?? 0);
    }
    return a.filename.localeCompare(b.filename, undefined, { numeric: true });
  });

  // Sort unnumbered items alphabetically by filename
  unnumberedItems.sort((a, b) =>
    a.filename.localeCompare(b.filename, undefined, { numeric: true }),
  );

  const epubItems: ElscioneVolumeMeta[] = [];

  // Add numbered volumes
  for (const item of numberedItems) {
    const title = item.partNum !== undefined
      ? `${seriesTitle}: Part ${item.partNum} Volume ${item.volNum}`
      : `${seriesTitle}: Volume ${item.volNum}`;

    epubItems.push({
      volumeNumber: item.volNum!,
      partNumber: item.partNum,
      filename: item.filename,
      downloadUrl: item.downloadUrl,
      title,
      size: item.size,
    });
  }

  // Assign sequential indices for unnumbered volumes to avoid colliding with existing numbers
  const maxNumbered = numberedItems.length > 0
    ? Math.max(...numberedItems.map((n) => n.volNum!))
    : 0;
  let nextExtraIndex = Math.floor(maxNumbered) + 1;

  for (const item of unnumberedItems) {
    const cleanBase = item.filename.replace(/\.epub$/i, "").trim();
    epubItems.push({
      volumeNumber: nextExtraIndex,
      filename: item.filename,
      downloadUrl: item.downloadUrl,
      title: `${seriesTitle}: Volume ${nextExtraIndex} (${cleanBase})`,
      size: item.size,
    });
    nextExtraIndex++;
  }

  // Enforce MAX_VOLUMES_PER_REQUEST bound for safety parity with Lnori
  if (epubItems.length > MAX_VOLUMES_PER_REQUEST) {
    console.warn(
      `[Elscione] Series has ${epubItems.length} volumes, truncating to maximum allowed (${MAX_VOLUMES_PER_REQUEST})`,
    );
    epubItems.length = MAX_VOLUMES_PER_REQUEST;
  }

  return {
    seriesTitle,
    url: normalizedUrl,
    isSingleVolume: false,
    totalCount: epubItems.length,
    volumes: epubItems,
  };
}

/**
 * Extracts embedded cover image from EPUB container using bsdtar/unzip
 * and converts to WebP/JPEG using sips.
 */
export async function extractAndConvertEpubCover(
  epubPath: string,
  workDir: string,
  dependencies?: ElscioneDependencies,
): Promise<string | null> {
  if (!fs.existsSync(epubPath)) return null;

  const runSpawnSync = dependencies?.spawnSync ?? spawnSync;
  const bsdtarBin = dependencies?.bsdtarPath ?? getBsdtarPath();
  const unzipBin = dependencies?.unzipPath ?? getUnzipPath();
  const sipsBin = dependencies?.sipsPath ?? getSipsPath();

  const execOpts = {
    timeout: SUBPROCESS_TIMEOUT_MS,
    maxBuffer: SUBPROCESS_MAX_BUFFER,
  };

  try {
    // 1. Locate OPF rootfile path via container.xml
    let containerXml = "";
    const bsdContainer = runSpawnSync(
      bsdtarBin,
      ["-xOf", epubPath, "META-INF/container.xml"],
      { ...execOpts, encoding: "utf8" },
    );
    if (bsdContainer.status === 0 && bsdContainer.stdout) {
      containerXml = bsdContainer.stdout;
    } else {
      const unzipContainer = runSpawnSync(
        unzipBin,
        ["-p", epubPath, "META-INF/container.xml"],
        { ...execOpts, encoding: "utf8" },
      );
      if (unzipContainer.status === 0 && unzipContainer.stdout) {
        containerXml = unzipContainer.stdout;
      }
    }

    let opfPath = "content.opf";
    if (containerXml) {
      const match = containerXml.match(/full-path=["']([^"']+)["']/i);
      if (match && match[1]) {
        opfPath = match[1].trim();
      }
    }

    // 2. Read OPF XML
    let opfXml = "";
    const bsdOpf = runSpawnSync(
      bsdtarBin,
      ["-xOf", epubPath, opfPath],
      { ...execOpts, encoding: "utf8" },
    );
    if (bsdOpf.status === 0 && bsdOpf.stdout) {
      opfXml = bsdOpf.stdout;
    } else {
      const unzipOpf = runSpawnSync(
        unzipBin,
        ["-p", epubPath, opfPath],
        { ...execOpts, encoding: "utf8" },
      );
      if (unzipOpf.status === 0 && unzipOpf.stdout) {
        opfXml = unzipOpf.stdout;
      }
    }

    const escapeRegex = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

    let coverHref: string | null = null;
    if (opfXml) {
      // a) <meta name="cover" content="coverId"/>
      const metaCover = opfXml.match(/<meta[^>]*name=["']cover["'][^>]*content=["']([^"']+)["']/i);
      if (metaCover && metaCover[1]) {
        const coverId = escapeRegex(metaCover[1].trim());
        const itemMatch =
          opfXml.match(new RegExp(`<item[^>]*id=["']${coverId}["'][^>]*href=["']([^"']+)["']`, "i")) ||
          opfXml.match(new RegExp(`<item[^>]*href=["']([^"']+)["'][^>]*id=["']${coverId}["']`, "i"));
        if (itemMatch && itemMatch[1]) {
          coverHref = itemMatch[1].trim();
        }
      }

      // b) EPUB3 cover-image property
      if (!coverHref) {
        const ep3Match =
          opfXml.match(/<item[^>]*properties=["'][^"']*cover-image[^"']*["'][^>]*href=["']([^"']+)["']/i) ||
          opfXml.match(/<item[^>]*href=["']([^"']+)["'][^>]*properties=["'][^"']*cover-image[^"']*["']/i);
        if (ep3Match && ep3Match[1]) {
          coverHref = ep3Match[1].trim();
        }
      }

      // c) Any item with "cover" in href and image media-type
      if (!coverHref) {
        const anyCover = opfXml.match(/<item[^>]*media-type=["']image\/[^"']+["'][^>]*href=["']([^"']*cover[^"']*)["']/i);
        if (anyCover && anyCover[1]) {
          coverHref = anyCover[1].trim();
        }
      }
    }

    // 3. Resolve entry path inside EPUB ZIP
    let entryPath: string | null = null;
    if (coverHref) {
      const opfDir = path.posix.dirname(opfPath);
      const joined = opfDir === "." ? coverHref : path.posix.join(opfDir, coverHref);
      entryPath = decodeURIComponent(joined);
    }

    const rawCoverPath = path.join(workDir, "cover-raw");

    // 4. Extract raw cover image bytes
    let extracted = false;
    if (entryPath) {
      const bsdExtract = runSpawnSync(
        bsdtarBin,
        ["-xOf", epubPath, entryPath],
        { ...execOpts, encoding: "buffer" },
      );
      if (bsdExtract.status === 0 && bsdExtract.stdout && bsdExtract.stdout.length > 0) {
        fs.writeFileSync(rawCoverPath, bsdExtract.stdout);
        extracted = true;
      } else {
        const unzipExtract = runSpawnSync(
          unzipBin,
          ["-p", epubPath, entryPath],
          { ...execOpts, encoding: "buffer" },
        );
        if (unzipExtract.status === 0 && unzipExtract.stdout && unzipExtract.stdout.length > 0) {
          fs.writeFileSync(rawCoverPath, unzipExtract.stdout);
          extracted = true;
        }
      }
    }

    if (!extracted || !fs.existsSync(rawCoverPath)) {
      return null;
    }

    // 5. Convert cover with sips to JPEG for standardized Calibre & e-reader compatibility
    const jpegPath = path.join(workDir, "cover.jpg");
    const sipsJpeg = runSpawnSync(
      sipsBin,
      ["-s", "format", "jpeg", rawCoverPath, "--out", jpegPath],
      { ...execOpts, encoding: "utf8" },
    );

    await fs.promises.rm(rawCoverPath, { force: true });

    if (sipsJpeg.status === 0 && fs.existsSync(jpegPath)) {
      return jpegPath;
    }

    return null;
  } catch (err: any) {
    console.warn(`[Elscione] Cover extraction failed: ${err?.message || err}`);
    return null;
  }
}

export function formatElscioneProgress(event: ElscioneProgressEvent): string {
  if (event.status) return event.status;
  if (event.phase === "manifest") {
    return event.volumeTitle
      ? `Found ${event.total || 0} volumes in series "${event.volumeTitle}"`
      : "Inspecting Elscione light novel manifest...";
  }
  if (event.phase === "volume") {
    return `[Volume ${event.index || 1}/${event.total || 1}] ${event.volumeTitle || ""}`;
  }
  if (event.phase === "complete") {
    return `Completed: ${event.data?.importedCount || 0} imported, ${event.data?.skippedCount || 0} skipped`;
  }
  return `[Elscione ${event.phase}]`;
}

async function reportProgress(
  onProgress: ElscioneProgressCallback | undefined,
  event: ElscioneProgressEvent,
): Promise<void> {
  if (!onProgress) return;
  try {
    await onProgress(event);
  } catch (err) {
    console.debug("[Elscione] Progress callback error:", err);
  }
}

/**
 * Downloads a single EPUB volume from server.elscione.com with byte limits and activity timeouts
 */
export async function downloadElscioneEpub(
  downloadUrl: string,
  destPath: string,
  onProgress?: (progressPercent: number) => void,
  dependencies?: ElscioneDependencies,
): Promise<void> {
  const normalizedDownloadUrl = cleanAndNormalizeNovelUrl(downloadUrl);
  if (!isElscioneUrl(normalizedDownloadUrl)) {
    throw new Error(
      `Refusing to download EPUB from non-Elscione host: ${normalizedDownloadUrl}`,
    );
  }
  const isTestEnv =
    process.argv.some((a: string) => a.includes(".test.") || a.includes("test")) ||
    process.env.NODE_ENV === "test";
  const sleep =
    dependencies?.sleep ??
    ((ms: number) => new Promise((resolve) => setTimeout(resolve, isTestEnv ? 0 : ms)));

  // If mock fetch dependency was injected, use pure-JS logic directly so test mocks work as expected (unless explicitly forced by useHelper)
  const hasMockFetch = Boolean(dependencies?.fetch);
  const allowHelper = dependencies?.useHelper ?? (!hasMockFetch);

  if (allowHelper) {
    const MAX_HELPER_ATTEMPTS = 2; // 2 invocations of helper (helper itself retries up to 3 times internally)
    let lastHelperError: any = null;

    for (let attempt = 0; attempt < MAX_HELPER_ATTEMPTS; attempt++) {
      if (dependencies?.signal?.aborted) {
        throw new Error("Elscione ingestion aborted by client");
      }

      if (attempt > 0) {
        const backoffMs = Math.min(5000, 1000 * 2 ** (attempt - 1));
        await sleep(backoffMs);
      }

      if (dependencies?.signal?.aborted) {
        throw new Error("Elscione ingestion aborted by client");
      }

      try {
        await runElscioneHelperDownload(normalizedDownloadUrl, destPath, onProgress, dependencies);
        return;
      } catch (err: any) {
        lastHelperError = err;
        if (
          dependencies?.signal?.aborted ||
          err?.name === "AbortError" ||
          err?.message?.includes("aborted")
        ) {
          throw new Error("Elscione ingestion aborted by client");
        }
        // A missing Python dependency will fail identically on the next attempt: report it once.
        if (isElscioneDependencyError(err)) {
          throw createDependencyError(err?.message);
        }
        console.warn(
          `[Elscione] Helper download attempt ${attempt + 1}/${MAX_HELPER_ATTEMPTS} failed: ${err?.message || err}`,
        );
      }
    }

    throw (
      lastHelperError ||
      new Error(`Failed to download EPUB via helper after ${MAX_HELPER_ATTEMPTS} attempts: ${normalizedDownloadUrl}`)
    );
  }

  const MAX_RETRIES = 3;
  let lastError: any = null;
  // A 429 states when to come back; a permanent 4xx (403/404/410) will answer the same way for
  // every attempt, so retrying it only burns the whole retry budget before failing anyway.
  let retryAfterMs: number | null = null;

  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    if (dependencies?.signal?.aborted) {
      throw new Error("Elscione ingestion aborted by client");
    }

    if (attempt > 0) {
      const backoffMs =
        retryAfterMs !== null ? retryAfterMs : Math.min(10000, 1000 * 2 ** (attempt - 1));
      retryAfterMs = null;
      await sleep(backoffMs);
    }

    if (dependencies?.signal?.aborted) {
      throw new Error("Elscione ingestion aborted by client");
    }

    try {
      const parsed = safeCreateUrl(normalizedDownloadUrl);
      const folderPath = parsed ? path.posix.dirname(parsed.pathname) + "/" : "/";
      const referer = parsed ? `${parsed.origin}${folderPath}` : "https://server.elscione.com/";

      const res = await fetchWithAnubis(
        normalizedDownloadUrl,
        {
          headers: {
            Referer: referer,
          },
        },
        dependencies,
      );

      if (!res.ok) {
        if (res.status === 429) {
          retryAfterMs = parseRetryAfterMs(res.headers.get("retry-after"), 2000, 10000);
        }
        const httpErr = new Error(
          `Failed to download EPUB (${res.status}): ${normalizedDownloadUrl}`,
        );
        (httpErr as any).httpStatus = res.status;
        throw httpErr;
      }

      await streamResponseToFile(
        res,
        destPath,
        MAX_EPUB_BYTES,
        "Elscione EPUB",
        onProgress,
        { activityTimeoutMs: 30000, signal: dependencies?.signal },
      );

      validateDownloadedEpub(destPath);
      return; // Download succeeded and passed validation
    } catch (err: any) {
      lastError = err;
      if (
        dependencies?.signal?.aborted ||
        err?.name === "AbortError" ||
        err?.message?.includes("aborted")
      ) {
        throw new Error("Elscione ingestion aborted by client");
      }
      console.warn(`[Elscione] EPUB download attempt ${attempt + 1} failed: ${err?.message || err}`);
      // A block answers the same way every time and retrying it only burns the retry budget while
      // burying the real cause behind a later, unrelated failure.
      if (isElscioneBlockedError(err)) {
        throw err;
      }
      const httpStatus = Number(err?.httpStatus);
      const isRetryable =
        !Number.isFinite(httpStatus) ||
        httpStatus >= 500 ||
        httpStatus === 408 ||
        httpStatus === 429;
      if (!isRetryable) {
        throw err;
      }
    }
  }

  throw (
    lastError ||
    new Error(`Failed to download EPUB after ${MAX_RETRIES} retries: ${normalizedDownloadUrl}`)
  );
}

/**
 * Main entry point: Ingests an Elscione light novel series folder or direct EPUB volume
 */
export async function ingestElscioneSeries(
  url: string,
  onProgress?: ElscioneProgressCallback,
  dependencies?: ElscioneDependencies,
): Promise<ElscioneIngestResult> {
  const normalizedUrl = cleanAndNormalizeNovelUrl(url);
  if (dependencies?.signal?.aborted) {
    throw new Error("Elscione ingestion aborted by client");
  }

  await reportProgress(onProgress, {
    phase: "manifest",
    status: "Inspecting Elscione light novel manifest...",
  });

  const manifest = await extractElscioneManifest(normalizedUrl, dependencies);
  const totalCount = manifest.volumes.length;

  await reportProgress(onProgress, {
    phase: "manifest",
    total: totalCount,
    volumeTitle: manifest.seriesTitle,
    status: `Found ${totalCount} volumes in series "${manifest.seriesTitle}"`,
    data: {
      seriesTitle: manifest.seriesTitle,
      totalCount,
      volumes: manifest.volumes.map((v) => ({
        volumeNumber: v.volumeNumber,
        filename: v.filename,
      })),
    },
  });

  const workDir = path.join(
    os.tmpdir(),
    `elscione-ingest-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
  );
  await fs.promises.mkdir(workDir, { recursive: true });

  let importedCount = 0;
  let skippedExisting = 0;
  let skippedErrors = 0;
  const calibreBookIds: number[] = [];
  let seriesAuthor = "Unknown";
  const seriesCache = new Map<string, { description: string; coverUrl?: string; source?: string }>();

  try {
    for (let i = 0; i < manifest.volumes.length; i++) {
      if (dependencies?.signal?.aborted) {
        throw new Error("Elscione ingestion aborted by client");
      }

      const vol = manifest.volumes[i];
      const volNum = vol.volumeNumber;
      // One volume model for every source: a part-local volume keeps its part namespace and the
      // assignment tells Calibre what flat `series_index` stores for it.
      const assignment = resolveIngestVolumeAssignment(manifest.seriesTitle, {
        volumeNumber: volNum,
        title: vol.title,
        partNumber: vol.partNumber,
      });
      const title = assignment.title;
      const seriesIndex = assignment.seriesIndex;

      // Pre-download duplicate check
      if (
        isVolumeAlreadyInCalibre(
          manifest.seriesTitle,
          assignment.key.volume,
          title,
          dependencies,
          assignment.key.namespace,
        )
      ) {
        console.log(
          `[Elscione] Volume ${volNum} of "${manifest.seriesTitle}" already in library, skipping`,
        );
        await reportProgress(onProgress, {
          phase: "volume",
          index: i + 1,
          total: totalCount,
          volumeTitle: title,
          status: `_[Volume ${escapeTelegramMarkdown(String(i + 1))}/${escapeTelegramMarkdown(String(totalCount))}] Volume ${escapeTelegramMarkdown(String(volNum))} already in library, skipping..._`,
          data: {
            action: "skipped",
            reason: "already_exists",
            volumeIndex: volNum,
            title,
          },
        });
        skippedExisting++;
        continue;
      }

      await reportProgress(onProgress, {
        phase: "volume",
        index: i + 1,
        total: totalCount,
        volumeTitle: title,
        status: `_[Volume ${escapeTelegramMarkdown(String(i + 1))}/${escapeTelegramMarkdown(String(totalCount))}] Downloading EPUB..._\n*${escapeTelegramMarkdown(vol.filename)}*`,
        data: {
          action: "downloading",
          volumeIndex: volNum,
          title,
          filename: vol.filename,
        },
      });

      const tempEpubPath = path.join(workDir, `volume-${volNum}.epub`);
      let coverPath: string | null = null;

      try {
        try {
          await downloadElscioneEpub(
            vol.downloadUrl,
            tempEpubPath,
            undefined,
            dependencies,
          );
        } catch (dlErr: any) {
          if (
            dependencies?.signal?.aborted ||
            dlErr?.name === "AbortError" ||
            dlErr?.message?.includes("aborted")
          ) {
            throw dlErr;
          }
          console.warn(
            `[Elscione] Failed to download volume ${volNum} ("${title}"):`,
            dlErr?.message || dlErr,
          );
          await reportProgress(onProgress, {
            phase: "volume",
            index: i + 1,
            total: totalCount,
            volumeTitle: title,
            status: `_[Volume ${escapeTelegramMarkdown(String(i + 1))}/${escapeTelegramMarkdown(String(totalCount))}] Skipped volume due to download error, continuing with next volume..._\n*${escapeTelegramMarkdown(vol.filename)}*`,
            data: {
              action: "skipped",
              reason: "download_error",
              volumeIndex: volNum,
              title,
              error: dlErr?.message || String(dlErr),
            },
          });
          skippedErrors++;
          continue;
        }

        await reportProgress(onProgress, {
          phase: "volume",
          index: i + 1,
          total: totalCount,
          volumeTitle: title,
          status: `_[Volume ${escapeTelegramMarkdown(String(i + 1))}/${escapeTelegramMarkdown(String(totalCount))}] Ingesting into Calibre library..._\n*Volume ${escapeTelegramMarkdown(String(volNum))}*`,
          data: {
            action: "adding_calibre",
            volumeIndex: volNum,
            title,
          },
        });

        // Add to Calibre
        const addRes = runCalibredb(
          ["add", "--with-library", SERVER_URL, tempEpubPath],
          dependencies,
        );

        let calibreId: number | null = null;
        if (addRes.status === 0 && addRes.stdout) {
          const idMatch = addRes.stdout.match(/Added book ids?:?\s*([0-9]+)/i);
          if (idMatch) {
            calibreId = parseInt(idMatch[1], 10);
          }
        }

        if (!calibreId) {
          throw new Error(
            `Failed to add volume ${volNum} to Calibre: ${addRes.stderr || addRes.stdout}`,
          );
        }

        calibreBookIds.push(calibreId);

        // Metadata extraction
        let volAuthor: string | null = null;
        let synopsis: string | null = null;
        if (fs.existsSync(tempEpubPath)) {
          const meta = extractEpubMetadata(tempEpubPath);
          if (meta.author) {
            volAuthor = meta.author;
            if (!seriesAuthor || seriesAuthor === "Unknown") {
              seriesAuthor = meta.author;
            }
          }
          synopsis = meta.description || extractEpubDescription(tempEpubPath);
        }

        const authorToSet = volAuthor || seriesAuthor || "Unknown";
        const tags = ["Light Novel", "Elscione"];
        const tagsStr = tags.join(",");

        const setArgs = [
          "set_metadata",
          "--with-library",
          SERVER_URL,
          String(calibreId),
          "--field",
          `title:${title}`,
          "--field",
          `authors:${authorToSet}`,
          "--field",
          `series:${manifest.seriesTitle}`,
          "--field",
          `series_index:${seriesIndex}`,
          "--field",
          `tags:${tagsStr}`,
        ];

        if (synopsis && !isCommentsEmpty(synopsis)) {
          setArgs.push("--field", `comments:${synopsis}`);
        }

        // Cover extraction from EPUB
        try {
          coverPath = await extractAndConvertEpubCover(tempEpubPath, workDir, dependencies);
          if (coverPath && fs.existsSync(coverPath)) {
            setArgs.push("--field", `cover:${coverPath}`);
          }
        } catch (covErr: any) {
          if (dependencies?.signal?.aborted) {
            throw covErr;
          }
          console.warn(`[Elscione] Cover extraction failed for volume ${volNum}:`, covErr?.message || covErr);
        }

        const setRes = runCalibredb(setArgs, dependencies);
        if (setRes.status !== 0) {
          console.warn(
            `[Elscione] Warning: set_metadata failed for Calibre #${calibreId}: ${setRes.stderr}`,
          );
        }

        // Online synopsis fallback: if synopsis is missing or empty, fetch online
        if (!synopsis || isCommentsEmpty(synopsis)) {
          if (dependencies?.signal?.aborted) {
            throw new Error("Elscione ingestion aborted by client");
          }
          try {
            const fetchOnline = dependencies?.fetchOnlineSynopsis ?? fetchOnlineSynopsis;
            const onlineRes = await fetchOnline(
              {
                id: calibreId,
                title,
                author: authorToSet,
                series: manifest.seriesTitle,
                series_index: seriesIndex,
                tags: tagsStr,
              },
              { seriesCache },
            );
            if (dependencies?.signal?.aborted) {
              throw new Error("Elscione ingestion aborted by client");
            }
            if (onlineRes?.description && !isCommentsEmpty(onlineRes.description)) {
              synopsis = onlineRes.description;
              const onlineSetRes = runCalibredb(
                [
                  "set_metadata",
                  String(calibreId),
                  "--with-library",
                  SERVER_URL,
                  "--field",
                  `comments:${synopsis}`,
                ],
                dependencies,
              );
              if (onlineSetRes.status !== 0) {
                console.warn(
                  `[Elscione] Warning: set_metadata (online synopsis) failed for Calibre #${calibreId}: ${onlineSetRes.stderr}`,
                );
              }
            }
          } catch (onlineErr: any) {
            if (
              dependencies?.signal?.aborted ||
              onlineErr?.name === "AbortError" ||
              String(onlineErr?.message || "").includes("aborted")
            ) {
              throw onlineErr;
            }
            console.debug(
              `[Elscione] Online synopsis lookup failed for volume ${volNum} ("${title}"):`,
              onlineErr?.message || onlineErr,
            );
          }
        }

        if (coverPath && fs.existsSync(coverPath)) {
          try {
            fs.unlinkSync(coverPath);
            coverPath = null;
          } catch {}
        }

        importedCount++;

        await reportProgress(onProgress, {
          phase: "volume",
          index: i + 1,
          total: totalCount,
          volumeTitle: title,
          status: `✓ Volume ${volNum} imported successfully`,
          data: {
            action: "imported",
            volumeIndex: volNum,
            title,
            calibreId,
          },
        });
      } catch (volErr: any) {
        if (
          dependencies?.signal?.aborted ||
          volErr?.name === "AbortError" ||
          volErr?.message?.includes("aborted")
        ) {
          throw volErr;
        }
        console.warn(
          `[Elscione] Volume ${volNum} ("${title}") failed during ingestion:`,
          volErr?.message || volErr,
        );
        await reportProgress(onProgress, {
          phase: "volume",
          index: i + 1,
          total: totalCount,
          volumeTitle: title,
          status: `_[Volume ${escapeTelegramMarkdown(String(i + 1))}/${escapeTelegramMarkdown(String(totalCount))}] Skipped volume due to error, continuing with next volume..._\n*${escapeTelegramMarkdown(vol.filename)}*`,
          data: {
            action: "skipped",
            reason: "import_error",
            volumeIndex: volNum,
            title,
            error: volErr?.message || String(volErr),
          },
        });
        skippedErrors++;
      } finally {
        if (coverPath && fs.existsSync(coverPath)) {
          try {
            fs.unlinkSync(coverPath);
          } catch {}
        }
        if (fs.existsSync(tempEpubPath)) {
          try {
            fs.unlinkSync(tempEpubPath);
          } catch {}
        }
      }
    }
  } finally {
    await fs.promises.rm(workDir, { recursive: true, force: true });
  }

  const totalSkipped = skippedExisting + skippedErrors;
  const manifestVolumes = manifest.volumes
    .map((v) => v.volumeNumber)
    .filter((v) => typeof v === "number" && !isNaN(v) && v >= 0);
  const finalResult: ElscioneIngestResult = {
    // Succeeded if at least one book was imported, OR if volumes already existed and there were no unhandled download/import errors
    success: importedCount > 0 || (skippedExisting > 0 && skippedErrors === 0),
    seriesTitle: manifest.seriesTitle,
    author: seriesAuthor,
    importedCount,
    skippedCount: totalSkipped,
    duplicateCount: skippedExisting,
    skippedErrors,
    totalCount,
    volumes: manifestVolumes,
    tags: ["Light Novel", "Elscione"],
    calibreBookIds,
  };

  const summaryStatus = `Finished: ${importedCount} new volumes added, ${skippedExisting} existing volumes preserved.`;

  await reportProgress(onProgress, {
    phase: "complete",
    total: totalCount,
    volumeTitle: manifest.seriesTitle,
    status: summaryStatus,
    data: {
      ...finalResult,
      summary: summaryStatus,
    },
  });

  return finalResult;
}
