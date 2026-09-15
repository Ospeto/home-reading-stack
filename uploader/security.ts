import crypto from "node:crypto";
import dns from "node:dns/promises";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { Buffer } from "node:buffer";
import { spawnSync } from "node:child_process";
// @ts-expect-error
import { Database } from "bun:sqlite";

// Default production WAN domain and ports
export const DEFAULT_WAN_DOMAIN = "reading.wavypremium.xyz";
export const KOSYNC_WAN_DOMAIN = "kosync.wavypremium.xyz";

export function getBsdtarPath(): string {
  if (process.env.BSDTAR_PATH) return process.env.BSDTAR_PATH;
  const resolved = resolveExecutable("bsdtar");
  if (resolved !== "bsdtar") return resolved;
  return resolveExecutable("tar");
}

/**
 * Resolves the books drop directory portably and lazily.
 * Respects BOOKS_DROP_DIR or DROP_DIR env variables, falling back to a per-user local path.
 */
export function getDropDir(): string {
  const dir =
    process.env.BOOKS_DROP_DIR ||
    process.env.DROP_DIR ||
    path.join(process.env.HOME || os.homedir(), "Books_Drop");
  try {
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
    return dir;
  } catch {
    const fallback = path.join(os.tmpdir(), "Books_Drop");
    if (!fs.existsSync(fallback)) {
      try {
        fs.mkdirSync(fallback, { recursive: true });
      } catch {
        // Ignore fallback creation error
      }
    }
    return fallback;
  }
}

/**
 * Resolves the cover cache directory portably and lazily.
 * Avoids import-time filesystem side effects and host-specific defaults.
 */
export function getCoverCacheDir(): string {
  const custom = process.env.COVER_CACHE_DIR;
  if (custom) {
    try {
      if (!fs.existsSync(custom)) fs.mkdirSync(custom, { recursive: true });
      return custom;
    } catch {
      // fallback
    }
  }
  const defaultDir = path.join(os.tmpdir(), "reading-hq", "covers");
  try {
    if (!fs.existsSync(defaultDir)) {
      fs.mkdirSync(defaultDir, { recursive: true });
    }
    return defaultDir;
  } catch {
    const fallback = path.join(os.tmpdir(), "reading-hq-fallback", "covers");
    try {
      if (!fs.existsSync(fallback)) fs.mkdirSync(fallback, { recursive: true });
    } catch {
      // Ignore fallback creation error
    }
    return fallback;
  }
}

let sharedCacheDb: Database | null = null;

function initCacheDbSchema(db: Database) {
  try {
    db.run("PRAGMA busy_timeout = 5000;");
    db.run(`
      CREATE TABLE IF NOT EXISTS file_hashes (
        filepath TEXT PRIMARY KEY,
        mtime INTEGER NOT NULL,
        hash TEXT NOT NULL,
        book_id INTEGER,
        title TEXT,
        authors TEXT,
        cover INTEGER
      );
    `);
    db.run(
      "CREATE INDEX IF NOT EXISTS idx_file_hashes_hash ON file_hashes(hash);",
    );
  } catch (_err) {
    void _err;
  }
}

/**
 * Lazily opens and initializes the SQLite cache database.
 * Falls back to the operating system temporary directory if the configured path is absent or unwritable.
 */
export function resolveExecutable(command: string, envVar?: string): string {
  const configured = envVar ? process.env[envVar] : undefined;
  if (configured) return configured;
  const whichResult = spawnSync("which", [command], { encoding: "utf8" });
  return whichResult.status === 0 && whichResult.stdout?.trim()
    ? whichResult.stdout.trim()
    : command;
}

export function getCacheDb(customPath?: string): Database {
  if (sharedCacheDb && !customPath) {
    return sharedCacheDb;
  }

  const resolvePath = (): string => {
    if (customPath) return customPath;
    if (process.env.CACHE_DB_PATH) return process.env.CACHE_DB_PATH;
    return path.join(os.tmpdir(), "reading-hq", "cache.db");
  };

  const targetPath = resolvePath();
  const dir = path.dirname(targetPath);
  try {
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
  } catch {
    const fallbackPath = path.join(os.tmpdir(), "reading-hq-fallback.db");
    const db = new Database(fallbackPath);
    initCacheDbSchema(db);
    if (!customPath) sharedCacheDb = db;
    return db;
  }

  try {
    const db = new Database(targetPath);
    initCacheDbSchema(db);
    if (!customPath) sharedCacheDb = db;
    return db;
  } catch {
    const fallbackPath = path.join(os.tmpdir(), "reading-hq-fallback.db");
    const db = new Database(fallbackPath);
    initCacheDbSchema(db);
    if (!customPath) sharedCacheDb = db;
    return db;
  }
}

// ---------------------------------------------------------------------------
// 1. IP & SSRF Protection
// ---------------------------------------------------------------------------

/**
 * Validates if a hostname string is an exact RFC 1918 or loopback private IPv4 address.
 * Rejects lookalike domain names such as '192.168.attacker.example'.
 */
export function isPrivateIPv4(host: string): boolean {
  if (!host || !net.isIPv4(host)) return false;
  const parts = host.split(".").map((p) => parseInt(p, 10));
  if (parts.length !== 4 || parts.some(isNaN)) return false;
  if (parts.some((n) => n < 0 || n > 255)) return false;
  const [b0, b1] = parts;
  if (b0 === 127) return true; // 127.0.0.0/8 (Loopback)
  if (b0 === 10) return true; // 10.0.0.0/8 (Private Class A)
  if (b0 === 172 && b1 >= 16 && b1 <= 31) return true; // 172.16.0.0/12 (Private Class B)
  if (b0 === 192 && b1 === 168) return true; // 192.168.0.0/16 (Private Class C)
  return false;
}

/**
 * Parses numeric/hex/octal IP representations into standard dotted-decimal IPv4 if applicable.
 */
export function normalizeIpString(ip: string): string {
  const trimmed = ip.trim();
  // Check for decimal integer representation (e.g. 2130706433 -> 127.0.0.1)
  if (/^\d+$/.test(trimmed)) {
    const num = parseInt(trimmed, 10);
    if (num >= 0 && num <= 0xffffffff) {
      return [
        (num >>> 24) & 255,
        (num >>> 16) & 255,
        (num >>> 8) & 255,
        num & 255,
      ].join(".");
    }
  }

  // Check for hex representation (e.g. 0x7f000001)
  if (/^0x[0-9a-f]+$/i.test(trimmed)) {
    const num = parseInt(trimmed, 16);
    if (num >= 0 && num <= 0xffffffff) {
      return [
        (num >>> 24) & 255,
        (num >>> 16) & 255,
        (num >>> 8) & 255,
        num & 255,
      ].join(".");
    }
  }

  // Check for octal in dotted parts (e.g. 0177.0.0.1)
  const parts = trimmed.split(".");
  if (parts.length === 4) {
    const parsedParts: number[] = [];
    let isOctalOrHex = false;
    for (const p of parts) {
      if (/^0[0-7]+$/.test(p)) {
        parsedParts.push(parseInt(p, 8));
        isOctalOrHex = true;
      } else if (/^0x[0-9a-f]+$/i.test(p)) {
        parsedParts.push(parseInt(p, 16));
        isOctalOrHex = true;
      } else if (/^\d+$/.test(p)) {
        parsedParts.push(parseInt(p, 10));
      } else {
        return trimmed;
      }
    }
    if (isOctalOrHex && parsedParts.every((n) => n >= 0 && n <= 255)) {
      return parsedParts.join(".");
    }
  }

  return trimmed;
}

/**
 * Checks if an IP string is a private, loopback, link-local, or cloud metadata address.
 */
export function isPrivateOrInternalIp(rawIp: string): boolean {
  if (!rawIp) return true;
  const ip = normalizeIpString(rawIp);

  // Check IPv4
  if (net.isIPv4(ip)) {
    const parts = ip.split(".").map((p) => parseInt(p, 10));
    if (parts.length !== 4 || parts.some(isNaN)) return true;

    const [b0, b1, b2, b3] = parts;

    // 0.0.0.0/8 (Current network)
    if (b0 === 0) return true;

    // 10.0.0.0/8 (Private Class A)
    if (b0 === 10) return true;

    // 100.64.0.0/10 (Carrier-grade NAT)
    if (b0 === 100 && b1 >= 64 && b1 <= 127) return true;

    // 127.0.0.0/8 (Loopback)
    if (b0 === 127) return true;

    // 169.254.0.0/16 (Link-local & AWS/GCP/Azure Metadata 169.254.169.254)
    if (b0 === 169 && b1 === 254) return true;

    // 172.16.0.0/12 (Private Class B: 172.16.0.0 - 172.31.255.255)
    if (b0 === 172 && b1 >= 16 && b1 <= 31) return true;

    // 192.0.0.0/24 (IETF Protocol Assignments)
    if (b0 === 192 && b1 === 0 && b2 === 0) return true;

    // 192.0.2.0/24, 198.51.100.0/24, 203.0.113.0/24 (Documentation / Test-Net)
    if (b0 === 192 && b1 === 0 && b2 === 2) return true;
    if (b0 === 198 && b1 === 51 && b2 === 100) return true;
    if (b0 === 203 && b1 === 0 && b2 === 113) return true;

    // 192.168.0.0/16 (Private Class C)
    if (b0 === 192 && b1 === 168) return true;

    // 198.18.0.0/15 (Network Benchmark)
    if (b0 === 198 && b1 >= 18 && b1 <= 19) return true;

    // 224.0.0.0/4 (Multicast)
    if (b0 >= 224 && b0 <= 239) return true;

    // 240.0.0.0/4 (Reserved / Future Use)
    if (b0 >= 240) return true;

    // 255.255.255.255 (Broadcast)
    if (b0 === 255 && b1 === 255 && b2 === 255 && b3 === 255) return true;

    return false;
  }

  // Check IPv6. Use the normalized 128-bit value so compressed forms and
  // alternate spellings cannot evade special-use prefix checks.
  if (net.isIPv6(ip)) {
    const lower = ip.toLowerCase();
    const groups = lower.split(":");
    const missing = groups.indexOf("");
    let expanded: string[];
    if (missing >= 0) {
      const present = groups.filter(Boolean);
      expanded = [
        ...groups.slice(0, missing).filter(Boolean),
        ...Array(8 - present.length).fill("0"),
        ...groups.slice(missing + 1).filter(Boolean),
      ];
    } else {
      expanded = groups;
    }
    if (expanded.length === 8) {
      const value = expanded.reduce(
        (acc, group) => (acc << 16n) | BigInt(parseInt(group || "0", 16)),
        0n,
      );
      const prefix = (bits: number) => value >> BigInt(128 - bits);
      const prefixMatches = (bits: number, expected: bigint) =>
        prefix(bits) === expected;

      // Unspecified, loopback, IPv4-compatible/mapped, and discard ranges.
      if (value === 0n || value === 1n) return true;
      if (prefixMatches(96, 0n) || prefixMatches(96, 0xffffn)) {
        const v4 = Number(value & 0xffffffffn);
        const mapped = [
          (v4 >>> 24) & 255,
          (v4 >>> 16) & 255,
          (v4 >>> 8) & 255,
          v4 & 255,
        ].join(".");
        return isPrivateOrInternalIp(mapped) || prefixMatches(96, 0n);
      }
      // fc00::/7 (ULA), fe80::/10 (link-local), ff00::/8 (multicast).
      if (prefixMatches(7, 0x7en) || prefixMatches(10, 0x3fan) || prefixMatches(8, 0xffn)) {
        return true;
      }
      // Documentation, benchmarking, deprecated site-local, and other
      // special-use IPv6 ranges must never be network destinations here.
      if (
        prefixMatches(32, 0x20010db8n) ||
        prefixMatches(32, 0x20010000n) ||
        prefixMatches(48, 0x200100020000n) ||
        prefixMatches(28, 0x2001001n) ||
        prefixMatches(10, 0x3fbn) ||
        prefixMatches(64, 0x100n) ||
        prefixMatches(20, 0x3fffn)
      ) {
        return true;
      }
    }
    return false;
  }

  return true;
}

/**
 * Validates a target URL against SSRF threats.
 * Blocks private IP ranges, link-local, cloud metadata endpoints (169.254.169.254),
 * and local hostnames.
 */
export async function validateUrlForSSRF(
  rawUrl: string,
  _options: {
    allowProxyBypass?: boolean;
    allowPrivateHosts?: boolean;
  } = {},
): Promise<{
  safe: boolean;
  error?: string;
  resolvedIp?: string;
  resolvedIps?: string[];
}> {
  try {
    const u = new URL(rawUrl);

    // Only HTTP and HTTPS are permitted
    if (u.protocol !== "http:" && u.protocol !== "https:") {
      return { safe: false, error: `Disallowed protocol: ${u.protocol}` };
    }

    // Reject userinfo (@ credentials in URL)
    if (u.username || u.password) {
      return { safe: false, error: "Embedded URL credentials not allowed" };
    }

    const host = u.hostname.toLowerCase();

    // Block common internal/local hostname patterns
    if (
      !_options.allowPrivateHosts &&
      (host === "localhost" ||
        host.endsWith(".localhost") ||
        host.endsWith(".local") ||
        host.endsWith(".internal") ||
        host.endsWith(".lan") ||
        host.endsWith(".home.arpa"))
    ) {
      return { safe: false, error: `Restricted internal hostname: ${host}` };
    }

    // Check if host is direct IP literal (or numeric/hex representation)
    const normalizedHost = normalizeIpString(host);
    if (net.isIP(normalizedHost)) {
      if (
        isPrivateOrInternalIp(normalizedHost) &&
        !_options.allowPrivateHosts
      ) {
        return {
          safe: false,
          error: `Restricted private or loopback IP: ${normalizedHost}`,
        };
      }
      return {
        safe: true,
        resolvedIp: normalizedHost,
        resolvedIps: [normalizedHost],
      };
    }

    // If configured to allow designated proxy routing, outbound requests to public
    // domains through the proxy are accepted. But we still perform DNS validation
    // to block resolution to local/internal IP addresses.
    try {
      const addresses = await dns.lookup(host, { all: true });
      if (!addresses || addresses.length === 0) {
        return { safe: false, error: `No DNS records found for ${host}` };
      }
      for (const addr of addresses) {
        if (
          isPrivateOrInternalIp(addr.address) &&
          !_options.allowPrivateHosts
        ) {
          return {
            safe: false,
            error: `Domain ${host} resolved to restricted internal IP: ${addr.address}`,
            resolvedIp: addr.address,
          };
        }
      }
      const resolvedIps = addresses.map(
        (address: { address: string }) => address.address,
      );
      return {
        safe: true,
        resolvedIp: resolvedIps[0],
        resolvedIps,
      };
    } catch (dnsErr: any) {
      return {
        safe: false,
        error: `DNS resolution failed for ${host}: ${dnsErr?.message || dnsErr}`,
      };
    }
  } catch (err: any) {
    return { safe: false, error: `Invalid URL: ${err?.message || err}` };
  }
}

// ---------------------------------------------------------------------------
// 2. WAN vs LAN Detection
// ---------------------------------------------------------------------------

/**
 * Determines whether a request originated from the public WAN (via reverse tunnel / Caddy)
 * vs a local LAN client (direct connection to 192.168.x.x, 127.0.0.1, etc.).
 */
export function isWanRequest(
  req: Request,
  options: { wanDomain?: string; clientIp?: string } = {},
): boolean {
  const wanDomain = (
    options.wanDomain ||
    process.env.READING_WEBAPP_URL ||
    DEFAULT_WAN_DOMAIN
  )
    .replace(/^https?:\/\//i, "")
    .split("/")[0]
    .toLowerCase();

  const kosyncWanDomain = (process.env.KOSYNC_WAN_URL || KOSYNC_WAN_DOMAIN)
    .replace(/^https?:\/\//i, "")
    .split("/")[0]
    .toLowerCase();

  // If clientIp is provided (from socket/peer), verify it
  if (options.clientIp) {
    const clientIp = normalizeIpString(options.clientIp);
    // If client IP is not private/loopback, it is definitely WAN
    if (!isPrivateOrInternalIp(clientIp)) {
      return true;
    }
  }

  const rawHost =
    req.headers.get("x-forwarded-host") || req.headers.get("host") || "";
  const hostHeader = rawHost.toLowerCase().split(":")[0].trim();

  // If host header is missing or empty, fail closed -> WAN
  if (!hostHeader) {
    return true;
  }

  // 1. Host or X-Forwarded-Host matches WAN domain
  if (hostHeader === wanDomain || hostHeader === kosyncWanDomain) {
    return true;
  }

  // 2. Check X-Forwarded-For: if it contains any public (non-internal) IP, it arrived via WAN
  const xForwardedFor = req.headers.get("x-forwarded-for");
  if (xForwardedFor) {
    const ips = xForwardedFor
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean);
    for (const ip of ips) {
      if (!isPrivateOrInternalIp(ip)) {
        return true;
      }
    }
  }

  // 3. Proxy indicator headers (X-Forwarded-Proto, Via)
  const proto = req.headers.get("x-forwarded-proto");
  const via = req.headers.get("via");
  if (proto === "https" || via) {
    return true;
  }

  // 4. Verify hostHeader is genuinely a local/private hostname
  // Accept localhost, 127.0.0.1, strict private IPv4, or .local mDNS
  const isLocalhost = hostHeader === "localhost" || hostHeader === "127.0.0.1";
  const isPrivateIp = isPrivateIPv4(hostHeader);
  const isMDNS = hostHeader.endsWith(".local") && !hostHeader.includes("..");

  if (!isLocalhost && !isPrivateIp && !isMDNS) {
    // Non-private host or lookalike domain (e.g. 192.168.attacker.example) -> FAIL CLOSED (treat as WAN)
    return true;
  }

  return false;
}

// ---------------------------------------------------------------------------
// 3. Telegram WebApp initData Validation
// ---------------------------------------------------------------------------

/**
 * Validates Telegram Mini App (TMA) initData using HMAC-SHA256.
 * Official algorithm: https://core.telegram.org/bots/webapps#validating-data-received-via-the-mini-app
 */
export function validateTelegramWebAppData(
  initData: string,
  botToken: string,
  maxAgeSec = 86400, // 24 hours
): { valid: boolean; user?: any; error?: string } {
  if (!initData || !botToken) {
    return { valid: false, error: "Missing initData or botToken" };
  }

  try {
    const params = new URLSearchParams(initData);
    const hash = params.get("hash");
    if (!hash) {
      return { valid: false, error: "Missing hash parameter in initData" };
    }
    params.delete("hash");

    const authDateStr = params.get("auth_date");
    if (authDateStr) {
      const authDate = parseInt(authDateStr, 10);
      const now = Math.floor(Date.now() / 1000);
      if (Math.abs(now - authDate) > maxAgeSec) {
        return { valid: false, error: "Telegram initData is expired" };
      }
    }

    const items: string[] = [];
    for (const [key, val] of params.entries()) {
      items.push(`${key}=${val}`);
    }
    items.sort();
    const dataCheckString = items.join("\n");

    const secretKey = crypto
      .createHmac("sha256", "WebAppData")
      .update(botToken)
      .digest();
    const calculatedHash = crypto
      .createHmac("sha256", secretKey)
      .update(dataCheckString)
      .digest("hex");

    if (calculatedHash !== hash) {
      return { valid: false, error: "Invalid Telegram signature hash" };
    }

    let user: any = null;
    const userStr = params.get("user");
    if (userStr) {
      try {
        user = JSON.parse(userStr);
      } catch (_jsonErr) {
        void _jsonErr;
      }
    }

    return { valid: true, user };
  } catch (err: any) {
    return {
      valid: false,
      error: `Failed to parse initData: ${err?.message || err}`,
    };
  }
}

// ---------------------------------------------------------------------------
// 4. Authentication for WAN Requests
// ---------------------------------------------------------------------------

export interface AuthResult {
  authenticated: boolean;
  method?: "lan" | "bearer" | "api_key" | "tma" | "cookie";
  user?: any;
  error?: string;
}

/**
 * Authenticates an incoming request.
 * Local LAN requests pass automatically. WAN requests must present:
 * - Bearer token matching READING_API_KEY
 * - X-API-Key matching READING_API_KEY
 * - Valid Telegram WebApp initData (via X-Telegram-Init-Data or Authorization: Bearer tma_...)
 * - Valid session cookie
 */
export function authenticateRequest(
  req: Request,
  options: {
    apiKey?: string;
    botToken?: string;
    wanDomain?: string;
    clientIp?: string;
  } = {},
): AuthResult {
  // If request is from local LAN, grant immediate friction-free access
  const isWan = isWanRequest(req, options);
  if (!isWan) {
    return { authenticated: true, method: "lan" };
  }

  const apiKey = options.apiKey || process.env.READING_API_KEY || "";
  const botToken = options.botToken || process.env.TELEGRAM_BOT_TOKEN || "";

  // 1. Check Bearer token or TMA Bearer
  const authHeader = req.headers.get("authorization") || "";
  if (authHeader.startsWith("Bearer ")) {
    const token = authHeader.substring(7).trim();
    if (apiKey && token === apiKey) {
      return { authenticated: true, method: "bearer" };
    }
    if (token.startsWith("tma_") && botToken) {
      const initData = token.substring(4);
      const tmaRes = validateTelegramWebAppData(initData, botToken);
      if (tmaRes.valid) {
        return { authenticated: true, method: "tma", user: tmaRes.user };
      }
    }
  }

  // 2. Check X-API-Key header
  const xApiKey = req.headers.get("x-api-key") || "";
  if (apiKey && xApiKey && xApiKey === apiKey) {
    return { authenticated: true, method: "api_key" };
  }

  // 3. Check X-Telegram-Init-Data header
  const tmaHeader = req.headers.get("x-telegram-init-data") || "";
  if (tmaHeader && botToken) {
    const tmaRes = validateTelegramWebAppData(tmaHeader, botToken);
    if (tmaRes.valid) {
      return { authenticated: true, method: "tma", user: tmaRes.user };
    }
  }

  // 4. Check Cookie (reading_token or reading_session)
  const cookieHeader = req.headers.get("cookie") || "";
  if (cookieHeader) {
    const cookies = parseCookies(cookieHeader);
    if (
      apiKey &&
      (cookies.reading_token === apiKey || cookies.reading_session === apiKey)
    ) {
      return { authenticated: true, method: "cookie" };
    }
    if (cookies.reading_tma && botToken) {
      const tmaRes = validateTelegramWebAppData(cookies.reading_tma, botToken);
      if (tmaRes.valid) {
        return { authenticated: true, method: "cookie", user: tmaRes.user };
      }
    }
  }

  return {
    authenticated: false,
    error: "Authentication required for public WAN access",
  };
}

function parseCookies(header: string): Record<string, string> {
  const result: Record<string, string> = {};
  for (const part of header.split(";")) {
    const [key, ...vals] = part.trim().split("=");
    if (key) {
      result[key.trim()] = decodeURIComponent(vals.join("=").trim());
    }
  }
  return result;
}

// ---------------------------------------------------------------------------
// 5. CORS & CSRF Origin Validation
// ---------------------------------------------------------------------------

export function isAllowedOrigin(
  origin: string,
  extraAllowedOrigins: string[] = [],
): boolean {
  if (!origin) return false;
  const lower = origin.toLowerCase().trim();

  // Allow standard production WAN domains
  if (
    lower === "https://reading.wavypremium.xyz" ||
    lower === "https://kosync.wavypremium.xyz"
  ) {
    return true;
  }

  // Allow configured WAN URLs
  const readingWan = process.env.READING_WEBAPP_URL;
  if (readingWan && lower === readingWan.toLowerCase().replace(/\/+$/, "")) {
    return true;
  }
  const kosyncWan = process.env.KOSYNC_WAN_URL;
  if (kosyncWan && lower === kosyncWan.toLowerCase().replace(/\/+$/, "")) {
    return true;
  }

  // Check extra allowed origins from options or env
  const envOrigins = (process.env.ALLOWED_ORIGINS || "")
    .split(",")
    .map((o: string) => o.trim().toLowerCase())
    .filter(Boolean);
  const allAllowed = [
    ...extraAllowedOrigins.map((o: string): string => o.toLowerCase()),
    ...envOrigins,
  ];
  if (allAllowed.includes(lower)) {
    return true;
  }

  // Allow local LAN origins: http://127.0.0.1:*, http://localhost:*, http://192.168.*:*
  try {
    const u = new URL(lower);
    if (u.protocol !== "http:" && u.protocol !== "https:") return false;
    const h = u.hostname;
    if (h === "localhost" || h === "127.0.0.1") return true;
    if (isPrivateIPv4(h)) return true;
    if (h.endsWith(".local") && !h.includes("..")) return true;
  } catch (_originErr) {
    void _originErr;
  }

  return false;
}

/**
 * Validates CORS origin and guards mutating routes against Cross-Site Request Forgery (CSRF).
 */
export function validateOriginAndCsrf(
  req: Request,
  optionsOrExtra?:
    | string[]
    | { extraAllowedOrigins?: string[]; isCookieAuth?: boolean },
): { valid: boolean; error?: string } {
  let extraAllowedOrigins: string[] = [];
  let isCookieAuth = false;

  if (Array.isArray(optionsOrExtra)) {
    extraAllowedOrigins = optionsOrExtra;
  } else if (optionsOrExtra && typeof optionsOrExtra === "object") {
    extraAllowedOrigins = optionsOrExtra.extraAllowedOrigins || [];
    isCookieAuth = !!optionsOrExtra.isCookieAuth;
  }

  const method = req.method.toUpperCase();
  const isMutating = ["POST", "PUT", "DELETE", "PATCH"].includes(method);

  const origin = req.headers.get("origin");
  const referer = req.headers.get("referer");

  // Read-only requests without origin are safe
  if (!isMutating && !origin) {
    return { valid: true };
  }

  // For state-changing cookie/session mutations: require Origin or Referer
  if (isMutating && isCookieAuth && !origin && !referer) {
    return {
      valid: false,
      error:
        "Origin or Referer header required for cookie-authenticated mutating requests",
    };
  }

  // 1. If Origin header is present, it must be in the allowed list
  if (origin) {
    if (!isAllowedOrigin(origin, extraAllowedOrigins)) {
      return { valid: false, error: `Disallowed Origin: ${origin}` };
    }
  } else if (referer && isMutating) {
    // 2. If Referer is present without Origin on mutating routes
    try {
      const refUrl = new URL(referer);
      const refOrigin = `${refUrl.protocol}//${refUrl.host}`;
      if (!isAllowedOrigin(refOrigin, extraAllowedOrigins)) {
        return {
          valid: false,
          error: `Disallowed Referer origin: ${refOrigin}`,
        };
      }
    } catch {
      return { valid: false, error: "Malformed Referer header" };
    }
  }

  // 3. Sec-Fetch-Site check
  const secFetchSite = req.headers.get("sec-fetch-site");
  if (secFetchSite === "cross-site" && isMutating) {
    // If browser marks it cross-site and origin was not explicitly allowed
    if (!origin || !isAllowedOrigin(origin, extraAllowedOrigins)) {
      return {
        valid: false,
        error: "Cross-site request blocked by Sec-Fetch-Site policy",
      };
    }
  }

  return { valid: true };
}

// ---------------------------------------------------------------------------
// 6. Strict ID, Format & Filename Validation
// ---------------------------------------------------------------------------

/**
 * Sanitizes and validates an ID as a strictly positive integer.
 */
export function validateIntegerId(rawId: any, min = 1): number | null {
  if (typeof rawId === "number") {
    if (Number.isInteger(rawId) && rawId >= min) return rawId;
    return null;
  }
  if (typeof rawId === "string") {
    const trimmed = rawId.trim();
    if (/^\d+$/.test(trimmed)) {
      const parsed = parseInt(trimmed, 10);
      if (parsed >= min && parsed <= Number.MAX_SAFE_INTEGER) {
        return parsed;
      }
    }
  }
  return null;
}

export const CANONICAL_EBOOK_FORMATS = ["EPUB"] as const;
export const LEGACY_EBOOK_FORMATS = [
  "EPUB",
  "PDF",
  "MOBI",
  "AZW3",
  "CBZ",
  "CBR",
] as const;

/**
 * Validates an eBook format against allowed formats.
 */
export function validateBookFormat(
  format: string,
  allowLegacy = true,
): string | null {
  if (!format) return null;
  const upper = format.trim().toUpperCase().replace(/^\./, "");
  const allowed = allowLegacy ? LEGACY_EBOOK_FORMATS : CANONICAL_EBOOK_FORMATS;
  if ((allowed as readonly string[]).includes(upper)) {
    return upper.toLowerCase();
  }
  return null;
}

/**
 * Checks if a filename is a canonical EPUB.
 */
export function isCanonicalEpub(filename: string): boolean {
  if (!filename) return false;
  const ext = path.extname(filename).toLowerCase();
  const base = path.basename(filename);
  return ext === ".epub" && !base.startsWith(".") && !base.startsWith("._");
}

/**
 * Sanitizes a string for safe filesystem and Content-Disposition usage.
 * Strips path traversal characters, illegal characters, and normalizes spacing.
 */
export function sanitizeFilename(name: string): string {
  if (!name) return "document";
  let s = name;
  // Strip control characters and invalid filename characters: / \ : * ? " < > |
  s = s.replace(/[/\x00-\x1f\x7f\\:*?"<>|]+/g, " ");
  // Strip relative directory traversal dot sequences (.. or ...)
  s = s.replace(/\.{2,}/g, " ");
  // Collapse whitespace
  s = s.replace(/\s+/g, " ").trim();
  // Strip leading dots to avoid hidden files
  s = s.replace(/^\.+/, "");
  // Clamp length to 150 chars
  if (s.length > 150) {
    s = s.substring(0, 150).trim();
  }
  return s || "document";
}

/**
 * Formats a clean metadata-based download filename (e.g. 'Title - Author.epub').
 * Includes series and index only when present.
 * Never leaks internal Calibre library storage paths.
 */
export function getDownloadFilename(
  book: {
    title: string;
    authors?: string;
    series?: string;
    series_index?: number;
  },
  format = "epub",
): string {
  const cleanTitle = sanitizeFilename(book.title || "Untitled");
  const cleanAuthor = sanitizeFilename(book.authors || "Unknown");
  const ext = format.toLowerCase().replace(/^\./, "");

  let prefix = "";
  if (book.series) {
    const cleanSeries = sanitizeFilename(book.series);
    const idx = book.series_index === undefined ? "" : ` ${book.series_index}`;
    prefix = `[${cleanSeries}${idx}] `;
  }

  const base = `${prefix}${cleanTitle} - ${cleanAuthor}`;
  return `${sanitizeFilename(base)}.${ext}`;
}

/**
 * Clean strings (titles, authors, filenames) by scrubbing watermarks, digital library
 * tags, channel promos, t.me links, @mentions, bracket garbage, and file format extensions.
 */
export function cleanString(str: string): string {
  if (!str) return "";
  let s = str;
  s = s.replace(/_/g, " ");
  s = s.replace(/https?:\/\/\S+/gi, " ");
  s = s.replace(/(?:t|telegram)\.me\/\S+/gi, " ");
  s = s.replace(/@\w+/gi, " ");
  s = s.replace(/www\.\S+/gi, " ");
  s = s.replace(
    /\[.*?(?:ebook|pdf|epub|channel|mobi|azw|scan|myanmar|tg|bookr|z-?lib|libgen).*?\]/gi,
    " ",
  );
  s = s.replace(
    /\((.*?)(?:ebook|pdf|epub|channel|mobi|azw|scan|myanmar|tg|bookr|z-?lib|libgen)(.*?)\)/gi,
    " ",
  );
  s = s.replace(/_v[0-9]+/gi, " ");
  s = s.replace(/\([0-9]+\)$/g, " ");
  s = s.replace(/\b(epub|pdf|mobi|azw3|cbz|cbr)\b/gi, " ");
  s = s.replace(/[\s_]+/g, " ").trim();
  s = s.replace(/^[-–—:_.\s]+|[-–—:_.\s]+$/g, "").trim();
  return s;
}

// ---------------------------------------------------------------------------
// 7. Safe Error Handling & Payload Redaction
// ---------------------------------------------------------------------------

/**
 * Sanitizes an error to prevent leaking server filesystem paths, internal stack traces,
 * or host usernames in public HTTP responses.
 */
export function sanitizeErrorMessage(err: any): string {
  if (!err) return "An unexpected error occurred";
  const rawMsg =
    typeof err === "string"
      ? err
      : err.message || "An unexpected error occurred";

  // Error strings are hostile input: redact secrets first, then remove
  // filesystem details, stack fragments, and control characters.
  let sanitized = rawMsg
    .replace(/(https?:\/\/)[^\s/@:]+:[^\s/@]+@/gi, "$1[REDACTED]@")
    .replace(
      /((?:token|key|secret|password|api[_-]?key|authorization)\s*[:=]\s*)[^\s,;]+/gi,
      "$1[REDACTED]",
    )
    .replace(/Bearer\s+[^\s,;]+/gi, "Bearer [REDACTED]")
    .replace(/(['"])(?:file:\/\/)?\/[^'"\r\n]*\1/g, "$1[path]$1")
    .replace(/(?:file:\/\/)?\/[^\s,;'"<>()[\]]+/g, "[path]")
    .replace(/[a-zA-Z]:\\[^\s,;'"<>()[\]]+/g, "[path]")
    .replace(/at\s+.*\(.*:[0-9]+:[0-9]+\)/g, "")
    .replace(/[\x00-\x1f\x7f]/g, " ")
    .trim();

  if (sanitized.length > 300) {
    sanitized = sanitized.substring(0, 300) + "...";
  }

  return sanitized || "Operation failed";
}

/**
 * Redacts sensitive tokens, API keys, credentials, and internal server paths
 * from a job record before returning it in public APIs.
 */
export function redactJobRecord(job: any): any {
  if (!job) return job;

  const sanitizeValue = (val: any): any => {
    if (val === null || val === undefined) return val;
    if (typeof val === "string") {
      let s = val;
      // Redact filesystem paths
      s = s.replace(/(?:\/[a-zA-Z0-9._-]+)+/g, (match) => {
        const ext = path.extname(match);
        if (ext) return `[path]/${path.basename(match)}`;
        return "[path]";
      });
      s = s.replace(/[a-zA-Z]:\\[a-zA-Z0-9._\-\\]+/g, "[path]");
      // Redact tokens/secrets
      s = s.replace(
        /(?:token|key|secret|password|auth|apiKey)=[a-zA-Z0-9_.-]+/gi,
        "$1=[REDACTED]",
      );
      s = s.replace(/Bearer\s+[a-zA-Z0-9_.-]+/gi, "Bearer [REDACTED]");
      return s;
    }
    if (Array.isArray(val)) {
      return val.map(sanitizeValue);
    }
    if (typeof val === "object") {
      const out: any = {};
      for (const [k, v] of Object.entries(val)) {
        const lowerKey = k.toLowerCase();
        if (
          lowerKey.includes("token") ||
          lowerKey.includes("key") ||
          lowerKey.includes("secret") ||
          lowerKey.includes("password") ||
          lowerKey.includes("auth") ||
          lowerKey.includes("authorization")
        ) {
          out[k] = "[REDACTED]";
        } else if (lowerKey.includes("path") && typeof v === "string") {
          out[k] = `[path]/${path.basename(v)}`;
        } else {
          out[k] = sanitizeValue(v);
        }
      }
      return out;
    }
    return val;
  };

  return {
    id: job.id,
    type: job.type,
    payload: sanitizeValue(job.payload),
    status: job.status,
    retries: job.retries,
    max_retries: job.max_retries,
    created_at: job.created_at,
    updated_at: job.updated_at,
    next_run_at: job.next_run_at,
    result: sanitizeValue(job.result),
    error: job.error ? sanitizeErrorMessage(job.error) : null,
  };
}

// ---------------------------------------------------------------------------
// 9. Migration Identity & Canonical Book Matching
// ---------------------------------------------------------------------------

export interface BookIdentity {
  id?: number | string | null;
  importId?: string | null;
  isbn?: string | null;
  title: string;
  author?: string | null;
  authors?: string | null;
  series?: string | { series: string; volume: number } | null;
  series_index?: number | null;
}

/**
 * Robust book identity matching for migrations and deduplication.
 * Priority order:
 * 1. Stable Import ID / Calibre ID (if present on both)
 * 2. ISBN / Identifier (if present on both: match if equal, reject if different)
 * 3. Author PLUS Normalized Title (NEVER matches on title alone!)
 */
export function isSameBookIdentity(
  existing: BookIdentity,
  incoming: BookIdentity,
): boolean {
  // 1. Stable import ID or Calibre ID
  if (existing.importId && incoming.importId) {
    return existing.importId === incoming.importId;
  }
  if (
    existing.id !== undefined &&
    existing.id !== null &&
    incoming.id !== undefined &&
    incoming.id !== null &&
    String(existing.id) === String(incoming.id)
  ) {
    return true;
  }

  // 2. ISBN / Identifier
  const cleanIsbn = (str?: string | null) =>
    str ? str.replace(/[^0-9xX]/g, "").toUpperCase() : "";
  const existingIsbn = cleanIsbn(existing.isbn);
  const incomingIsbn = cleanIsbn(incoming.isbn);
  if (existingIsbn && incomingIsbn) {
    return existingIsbn === incomingIsbn;
  }

  // 3. Author PLUS Normalized Title
  const existingTitle = cleanString(existing.title || "").toLowerCase();
  const incomingTitle = cleanString(incoming.title || "").toLowerCase();
  if (!existingTitle || !incomingTitle) return false;

  const existingAuthor = cleanString(
    existing.authors || existing.author || "",
  ).toLowerCase();
  const incomingAuthor = cleanString(
    incoming.authors || incoming.author || "",
  ).toLowerCase();

  // Strict check: NEVER match on title alone! Author must be present and match on both sides.
  const isExistingUnknown =
    !existingAuthor ||
    existingAuthor === "unknown" ||
    existingAuthor.length < 2;
  const isIncomingUnknown =
    !incomingAuthor ||
    incomingAuthor === "unknown" ||
    incomingAuthor.length < 2;

  if (isExistingUnknown || isIncomingUnknown) {
    return false;
  }

  // Verify authors match or have strong overlap
  const authorMatch =
    existingAuthor === incomingAuthor ||
    existingAuthor.includes(incomingAuthor) ||
    incomingAuthor.includes(existingAuthor);
  if (!authorMatch) {
    return false;
  }

  // Verify titles match
  if (existingTitle === incomingTitle) {
    return true;
  }

  const minLen = Math.min(existingTitle.length, incomingTitle.length);
  if (
    minLen >= 5 &&
    (existingTitle.startsWith(incomingTitle) ||
      incomingTitle.startsWith(existingTitle))
  ) {
    return true;
  }

  return false;
}

/**
 * Reads a ReadableStream with a strict byte limit.
 * If the limit is exceeded, cancels the stream and returns exceeded: true.
 */
export async function meterStream(
  stream: ReadableStream<Uint8Array>,
  maxBytes: number,
): Promise<{ buffer: Buffer; exceeded: boolean; totalBytes: number }> {
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  let totalBytes = 0;

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      totalBytes += value.byteLength;
      if (totalBytes > maxBytes) {
        await reader.cancel("Payload limit exceeded");
        return { buffer: Buffer.alloc(0), exceeded: true, totalBytes };
      }
      chunks.push(value);
    }
    return { buffer: Buffer.concat(chunks), exceeded: false, totalBytes };
  } catch (err) {
    try {
      await reader.cancel();
    } catch (_cancelErr) {
      void _cancelErr;
    }
    throw err;
  }
}

/**
 * Validates that a file is a valid EPUB archive.
 * Checks minimum size, ZIP magic bytes (PK\x03\x04), and EPUB internal structure (mimetype or container.xml).
 */
export function validateEpubContent(filePathOrBuffer: string | Buffer): {
  valid: boolean;
  error?: string;
} {
  try {
    let buf: Buffer;
    if (typeof filePathOrBuffer === "string") {
      if (!fs.existsSync(filePathOrBuffer)) {
        return { valid: false, error: "File does not exist" };
      }
      const stat = fs.statSync(filePathOrBuffer);
      if (stat.size < 100) {
        return {
          valid: false,
          error: "File too small to be a valid EPUB archive",
        };
      }
      const fd = fs.openSync(filePathOrBuffer, "r");
      buf = Buffer.alloc(Math.min(stat.size, 65536));
      fs.readSync(fd, buf, 0, buf.length, 0);
      fs.closeSync(fd);
    } else {
      buf = filePathOrBuffer;
      if (buf.length < 100) {
        return {
          valid: false,
          error: "Buffer too small to be a valid EPUB archive",
        };
      }
    }

    // Check ZIP magic bytes: PK\x03\x04
    if (
      buf[0] !== 0x50 ||
      buf[1] !== 0x4b ||
      buf[2] !== 0x03 ||
      buf[3] !== 0x04
    ) {
      return {
        valid: false,
        error: "Invalid EPUB: Missing ZIP container magic bytes",
      };
    }

    // Check for EPUB indicators: 'mimetype' or 'META-INF/container.xml' or 'application/epub+zip'
    const sample = buf.toString("latin1");
    const hasMimetype = sample.includes("mimetype");
    const hasContainer =
      sample.includes("META-INF/container.xml") ||
      sample.includes("container.xml");
    const hasEpubZip = sample.includes("application/epub+zip");

    if (!hasMimetype && !hasContainer && !hasEpubZip) {
      return {
        valid: false,
        error: "Invalid EPUB: Archive missing EPUB structure or mimetype",
      };
    }

    // If a file path is provided, apply archive safety limits to EPUB ZIP contents
    if (typeof filePathOrBuffer === "string") {
      const bsdtar = resolveExecutable("bsdtar", "BSDTAR_PATH");
      const tarCmd = bsdtar === "bsdtar" ? resolveExecutable("tar") : bsdtar;
      const listRes = spawnSync(tarCmd, ["-tvf", filePathOrBuffer], {
        encoding: "utf8",
        timeout: 10000,
      });

      if (listRes.status === 0 && listRes.stdout) {
        const lines = listRes.stdout
          .split("\n")
          .filter((l: string) => l.trim().length > 0);
        if (lines.length > 500) {
          return {
            valid: false,
            error: `Invalid EPUB: Archive contains ${lines.length} entries, exceeding limit of 500`,
          };
        }

        let totalUncompressed = 0;
        for (const line of lines) {
          const tokens = line.trim().split(/\s+/);
          if (tokens.length >= 9) {
            const mode = tokens[0];
            const size = parseInt(tokens[4], 10);
            const entryName = tokens.slice(8).join(" ");

            // Reject symlinks, hardlinks, or path traversal inside EPUB zip
            if (mode.startsWith("l") || line.includes(" -> ")) {
              return {
                valid: false,
                error: `Invalid EPUB: Prohibited symlink entry "${entryName}"`,
              };
            }
            if (mode.startsWith("h") || line.includes(" link to ")) {
              return {
                valid: false,
                error: `Invalid EPUB: Prohibited hardlink entry "${entryName}"`,
              };
            }
            if (
              entryName.includes("..") ||
              entryName.startsWith("/") ||
              entryName.startsWith("\\") ||
              /^[a-zA-Z]:[\\/]/.test(entryName)
            ) {
              return {
                valid: false,
                error: `Invalid EPUB: Path traversal in entry "${entryName}"`,
              };
            }

            if (!isNaN(size) && size > 0) {
              if (size > 150 * 1024 * 1024) {
                return {
                  valid: false,
                  error: `Invalid EPUB: Entry "${entryName}" exceeds 150MB limit`,
                };
              }
              totalUncompressed += size;
            }
          }
        }

        if (totalUncompressed > 250 * 1024 * 1024) {
          return {
            valid: false,
            error:
              "Invalid EPUB: Total uncompressed content exceeds 250MB limit",
          };
        }

        const stat = fs.statSync(filePathOrBuffer);
        if (stat.size > 0 && totalUncompressed > 5 * 1024 * 1024) {
          const ratio = totalUncompressed / stat.size;
          if (ratio > 100) {
            return {
              valid: false,
              error: `Invalid EPUB: Compression ratio ${Math.round(ratio)}:1 exceeds limit of 100:1`,
            };
          }
        }
      }
    }

    return { valid: true };
  } catch (err: any) {
    return {
      valid: false,
      error: `EPUB validation error: ${err?.message || err}`,
    };
  }
}

export interface SafeFetchOptions {
  maxRedirects?: number;
  maxBytes?: number;
  timeoutMs?: number;
  method?: string;
  headers?: Record<string, string>;
  body?: BodyInit | null;
  proxy?: string;
  allowProxyBypass?: boolean;
  /** Only use for fixed, trusted local service endpoints. */
  allowPrivateHosts?: boolean;
}

export interface SafeFetchResult {
  ok: boolean;
  status: number;
  statusText: string;
  headers: Headers;
  buffer: Buffer;
  finalUrl: string;
  contentType: string;
}

/**
 * Performs an outbound HTTP fetch guarded against SSRF.
 * Validates initial URL and EVERY redirect target against private IPs,
 * strictly enforces response byte limits, and sets request timeouts.
 */
export async function safeFetchWithSsrf(
  initialUrl: string,
  options: SafeFetchOptions = {},
): Promise<SafeFetchResult> {
  const maxRedirects = options.maxRedirects ?? 5;
  const maxBytes = options.maxBytes ?? 25 * 1024 * 1024;
  const timeoutMs = options.timeoutMs ?? 20000;
  const allowProxyBypass = options.allowProxyBypass ?? true;

  // Keep the logical URL separate from the per-request connection URL. The
  // former preserves redirect resolution and finalUrl semantics; the latter
  // is pinned to the exact address validated immediately before connect.
  let logicalUrl = initialUrl;
  let redirectCount = 0;

  while (true) {
    const ssrfCheck = await validateUrlForSSRF(logicalUrl, {
      allowProxyBypass,
      allowPrivateHosts: options.allowPrivateHosts,
    });
    if (!ssrfCheck.safe) {
      throw new Error(
        `SSRF validation blocked request: ${ssrfCheck.error || "Unsafe destination"}`,
      );
    }

    let parsedUrl: URL;
    try {
      parsedUrl = new URL(logicalUrl);
    } catch {
      throw new Error("Invalid URL");
    }

    const hostname = parsedUrl.hostname.toLowerCase();
    const originalHost = parsedUrl.host;
    let connectionUrl: URL;
    try {
      connectionUrl = new URL(logicalUrl);
    } catch {
      throw new Error("Invalid URL");
    }
    const fetchHeaders = { ...(options.headers || {}) };
    delete fetchHeaders.Host;
    delete fetchHeaders.host;
    fetchHeaders.Host = originalHost;

    const fetchOptions: any = {
      method: options.method,
      body: options.body,
      headers: fetchHeaders,
      redirect: "manual",
      signal: AbortSignal.timeout(timeoutMs),
    };

    if (ssrfCheck.resolvedIp && !net.isIP(hostname)) {
      // Connect to the just-validated A/AAAA address, while retaining the
      // original hostname for HTTP Host routing and TLS certificate/SNI.
      connectionUrl.hostname = ssrfCheck.resolvedIp;
      if (parsedUrl.protocol === "https:") {
        fetchOptions.tls = { serverName: hostname };
      }
    }

    if (options.proxy) {
      fetchOptions.proxy = options.proxy;
    }

    const res = await fetch(connectionUrl.href, fetchOptions);

    if ([301, 302, 303, 307, 308].includes(res.status)) {
      const location = res.headers.get("location");
      if (!location) {
        throw new Error(
          `Redirect response (${res.status}) missing Location header`,
        );
      }
      redirectCount++;
      if (redirectCount > maxRedirects) {
        throw new Error(`Exceeded maximum redirect limit of ${maxRedirects}`);
      }
      try {
        // Resolve relative redirects against the original hostname, never the
        // pinned numeric address, then validate and pin the next hop anew.
        logicalUrl = new URL(location, logicalUrl).href;
      } catch {
        throw new Error("Invalid redirect Location");
      }
      continue;
    }

    const clHeader = res.headers.get("content-length");
    if (clHeader) {
      const cl = parseInt(clHeader, 10);
      if (!isNaN(cl) && cl > maxBytes) {
        throw new Error(
          `Response size (${Math.round(cl / 1024 / 1024)}MB) exceeds limit of ${Math.round(maxBytes / 1024 / 1024)}MB`,
        );
      }
    }

    if (!res.body) {
      return {
        ok: res.ok,
        status: res.status,
        statusText: res.statusText,
        headers: res.headers,
        buffer: Buffer.alloc(0),
        finalUrl: logicalUrl,
        contentType: res.headers.get("content-type") || "",
      };
    }

    const metered = await meterStream(res.body, maxBytes);
    if (metered.exceeded) {
      throw new Error(
        `Response exceeded maximum allowed size of ${Math.round(maxBytes / 1024 / 1024)}MB`,
      );
    }

    return {
      ok: res.ok,
      status: res.status,
      statusText: res.statusText,
      headers: res.headers,
      buffer: metered.buffer,
      finalUrl: logicalUrl,
      contentType: res.headers.get("content-type") || "",
    };
  }
}
