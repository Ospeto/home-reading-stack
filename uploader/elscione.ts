import fs from "node:fs";
import os from "node:os";
import path from "node:path";
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
} from "./scraper";
import {
  streamResponseToFile,
  runCalibredb,
  isVolumeAlreadyInCalibre,
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
export const MAX_VOLUMES_PER_REQUEST = 50;

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
  useHelper?: boolean;
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
  totalCount: number;
  tags: string[];
  calibreBookIds: number[];
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

  // v(\d+) (e.g. "Series v01.epub" or "Series - v02.epub")
  const vMatch = name.match(/(?:^|[\s_\-\[\(])v([0-9]+(?:\.[0-9]+)?)(?:$|[\s_\-\]\)])/i);
  if (vMatch) return parseFloat(vMatch[1]);

  // #01 pattern
  const hashMatch = name.match(/#\s*([0-9]+(?:\.[0-9]+)?)/);
  if (hashMatch) return parseFloat(hashMatch[1]);

  // " - 01" or " - 01 - " pattern
  const dashNumMatch = name.match(/(?:^|\s)-\s*([0-9]+(?:\.[0-9]+)?)(?:\s|-|$)/);
  if (dashNumMatch) return parseFloat(dashNumMatch[1]);

  // Trailing numbers like "Series 01"
  const trailingNumMatch = name.match(/\b([0-9]+(?:\.[0-9]+)?)\s*$/);
  if (trailingNumMatch) return parseFloat(trailingNumMatch[1]);

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
  };
  const currentCookies = getElscioneSessionCookies();
  if (currentCookies) {
    headers["Cookie"] = currentCookies;
  }

  let res: Response;
  try {
    res = await fetcher(passUrl.toString(), {
      method: "GET",
      headers,
      signal: composeSignal(30000, dependencies?.signal),
      redirect: "manual",
    } as any);
  } catch {
    if (dependencies?.signal?.aborted) {
      throw new Error("Anubis pass-challenge aborted by client");
    }
    // Fall back to Sing-box LAN proxy if direct failed
    res = await fetcher(passUrl.toString(), {
      method: "GET",
      headers,
      proxy: PROXY_URL,
      signal: composeSignal(30000, dependencies?.signal),
      redirect: "manual",
    } as any);
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

  const buildHeaders = (baseHeaders?: HeadersInit): Record<string, string> => {
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
    const cookies = getElscioneSessionCookies();
    if (cookies && !h["Cookie"]) {
      h["Cookie"] = cookies;
    }
    return h;
  };

  const doFetch = async (useProxy: boolean, reqHeaders: Record<string, string>): Promise<Response> => {
    const reqInit: any = {
      ...init,
      headers: reqHeaders,
      signal: composeSignal(30000, dependencies?.signal),
    };
    if (useProxy) {
      reqInit.proxy = PROXY_URL;
    }
    return await fetcher(targetUrl, reqInit);
  };

  let res: Response;
  try {
    res = await doFetch(false, buildHeaders(init?.headers));
  } catch {
    if (dependencies?.signal?.aborted) {
      throw new Error("Elscione request aborted by client");
    }
    res = await doFetch(true, buildHeaders(init?.headers));
  }

  updateCookiesFromResponse(res);

  // Check if response contains Anubis challenge HTML
  const contentType = (res.headers.get("content-type") || "").toLowerCase();
  const isBinaryPayload =
    contentType.includes("application/epub") ||
    contentType.includes("application/zip") ||
    contentType.includes("application/octet-stream");

  // Only check for Anubis challenge if it could be an HTML challenge page;
  // NEVER clone or read full text on large binary EPUB/ZIP downloads!
  const couldBeChallenge =
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
      try {
        res = await doFetch(false, buildHeaders(init?.headers));
      } catch {
        if (dependencies?.signal?.aborted) {
          throw new Error("Elscione request retry aborted by client");
        }
        res = await doFetch(true, buildHeaders(init?.headers));
      }
      updateCookiesFromResponse(res);
    }
  }

  return res;
}

export function safeDecodeURIComponent(str: string): string {
  if (!str) return "";
  try {
    return decodeURIComponent(str);
  } catch {
    return str;
  }
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

export function getPythonPath(dependencies?: ElscioneDependencies): string {
  if (dependencies?.pythonPath) return dependencies.pythonPath;
  if (process.env.PYTHON_PATH) return process.env.PYTHON_PATH;

  // Prefer Homebrew python3 on macOS where curl_cffi and certificates are installed
  const homebrewPaths = [
    "/opt/homebrew/bin/python3", // Apple Silicon Homebrew
    "/usr/local/bin/python3",    // Intel Homebrew
  ];
  for (const p of homebrewPaths) {
    if (fs.existsSync(p)) {
      return p;
    }
  }

  return "python3";
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

  return {
    seriesTitle: parsed.seriesTitle || "Light Novel",
    url: parsed.url || url,
    isSingleVolume: Boolean(parsed.isSingleVolume),
    totalCount: typeof parsed.totalCount === "number" ? parsed.totalCount : parsed.volumes.length,
    volumes: parsed.volumes
      .filter((v: any) => v && typeof v.downloadUrl === "string" && isElscioneUrl(v.downloadUrl))
      .map((v: any) => ({
        volumeNumber: v.volumeNumber,
        partNumber: typeof v.partNumber === "number" ? v.partNumber : undefined,
        filename: v.filename,
        downloadUrl: v.downloadUrl,
        title: v.title,
        size: typeof v.size === "number" ? v.size : undefined,
      })),
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
        Referer: targetFolderUrl,
      },
      body: h5aiPayload,
    },
    dependencies,
  );

  if (!res.ok) {
    throw new Error(
      `Failed to fetch directory manifest from Elscione (${res.status}): ${targetFolderUrl}`,
    );
  }

  let bodyJson: any;
  try {
    bodyJson = await res.json();
  } catch (err: any) {
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

  const unquotedTarget = safeDecodeURIComponent(folderPath);
  const normTarget = path.posix.normalize(unquotedTarget).replace(/\/+$/, "") + "/";

  for (const item of rawItems) {
    const href = item.href || item.name;
    if (!href || typeof href !== "string") continue;
    if (!/\.epub$/i.test(href)) continue;

    const unquotedRaw = safeDecodeURIComponent(href);
    const absUnquoted = unquotedRaw.startsWith("/")
      ? path.posix.normalize(unquotedRaw)
      : path.posix.normalize(path.posix.join(normTarget, unquotedRaw));

    // Strict folder scoping check
    if (!absUnquoted.startsWith(normTarget)) continue;

    const filename = path.posix.basename(absUnquoted);
    const volNum = extractVolumeNumberFromFilename(filename);
    const partMatch = filename.match(/Part\s*(\d+)/i);
    const partNum = partMatch ? parseInt(partMatch[1], 10) : undefined;
    const downloadUrlObj = safeCreateUrl(href, targetFolderUrl);
    const downloadUrl = downloadUrlObj ? downloadUrlObj.toString() : "";
    if (!downloadUrl) continue;

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

  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    if (dependencies?.signal?.aborted) {
      throw new Error("Elscione ingestion aborted by client");
    }

    if (attempt > 0) {
      const backoffMs = Math.min(10000, 1000 * 2 ** (attempt - 1));
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
        throw new Error(`Failed to download EPUB (${res.status}): ${normalizedDownloadUrl}`);
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

  try {
    for (let i = 0; i < manifest.volumes.length; i++) {
      if (dependencies?.signal?.aborted) {
        throw new Error("Elscione ingestion aborted by client");
      }

      const vol = manifest.volumes[i];
      const volNum = vol.volumeNumber;
      const title = vol.title || `${manifest.seriesTitle}: Volume ${volNum}`;
      const seriesIndex = vol.partNumber !== undefined && vol.partNumber > 1
        ? vol.partNumber * 100 + volNum
        : volNum;

      // Pre-download duplicate check
      if (isVolumeAlreadyInCalibre(manifest.seriesTitle, seriesIndex, title, dependencies)) {
        console.log(
          `[Elscione] Volume ${volNum} of "${manifest.seriesTitle}" already in library, skipping`,
        );
        await reportProgress(onProgress, {
          phase: "volume",
          index: i + 1,
          total: totalCount,
          volumeTitle: title,
          status: `⏭️ _[Volume ${escapeTelegramMarkdown(String(i + 1))}/${escapeTelegramMarkdown(String(totalCount))}] Volume ${escapeTelegramMarkdown(String(volNum))} already in library, skipping..._`,
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
        status: `⬇️ _[Volume ${escapeTelegramMarkdown(String(i + 1))}/${escapeTelegramMarkdown(String(totalCount))}] Downloading EPUB..._\n*${escapeTelegramMarkdown(vol.filename)}*`,
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
            status: `⚠️ _[Volume ${escapeTelegramMarkdown(String(i + 1))}/${escapeTelegramMarkdown(String(totalCount))}] Skipped volume due to download error, continuing with next volume..._\n*${escapeTelegramMarkdown(vol.filename)}*`,
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
          status: `📚 _[Volume ${escapeTelegramMarkdown(String(i + 1))}/${escapeTelegramMarkdown(String(totalCount))}] Ingesting into Calibre library..._\n*Volume ${escapeTelegramMarkdown(String(volNum))}*`,
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
          status: `⚠️ _[Volume ${escapeTelegramMarkdown(String(i + 1))}/${escapeTelegramMarkdown(String(totalCount))}] Skipped volume due to error, continuing with next volume..._\n*${escapeTelegramMarkdown(vol.filename)}*`,
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
  const finalResult: ElscioneIngestResult = {
    // Succeeded if at least one book was imported, OR if volumes already existed and there were no unhandled download/import errors
    success: importedCount > 0 || (skippedExisting > 0 && skippedErrors === 0),
    seriesTitle: manifest.seriesTitle,
    author: seriesAuthor,
    importedCount,
    skippedCount: totalSkipped,
    duplicateCount: skippedExisting,
    totalCount,
    tags: ["Light Novel", "Elscione"],
    calibreBookIds,
  };

  await reportProgress(onProgress, {
    phase: "complete",
    total: totalCount,
    volumeTitle: manifest.seriesTitle,
    status: `Completed: ${importedCount} imported, ${totalSkipped} skipped (${skippedExisting} duplicates, ${skippedErrors} errors) of ${totalCount} volumes`,
    data: finalResult,
  });

  return finalResult;
}
