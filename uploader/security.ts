import crypto from "node:crypto";
import dns from "node:dns/promises";
import net from "node:net";
import path from "node:path";
import process from "node:process";

// Default production WAN domain and ports
export const DEFAULT_WAN_DOMAIN = "reading.wavypremium.xyz";
export const KOSYNC_WAN_DOMAIN = "kosync.wavypremium.xyz";

// ---------------------------------------------------------------------------
// 1. IP & SSRF Protection
// ---------------------------------------------------------------------------

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
        num & 255
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
        num & 255
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

  // Check IPv6
  if (net.isIPv6(ip)) {
    const lower = ip.toLowerCase();

    // ::1 (Loopback)
    if (lower === "::1" || lower === "0:0:0:0:0:0:0:1") return true;

    // :: (Unspecified)
    if (lower === "::" || lower === "0:0:0:0:0:0:0:0") return true;

    // Link-local: fe80::/10
    if (lower.startsWith("fe8") || lower.startsWith("fe9") || lower.startsWith("fea") || lower.startsWith("feb")) {
      return true;
    }

    // Unique local (ULA): fc00::/7 (fc00:: and fd00::)
    if (lower.startsWith("fc") || lower.startsWith("fd")) {
      return true;
    }

    // IPv4-mapped IPv6: ::ffff:a.b.c.d
    const v4MappedMatch = lower.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/);
    if (v4MappedMatch) {
      return isPrivateOrInternalIp(v4MappedMatch[1]);
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
  options: { allowProxyBypass?: boolean } = {}
): Promise<{ safe: boolean; error?: string; resolvedIp?: string }> {
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
      host === "localhost" ||
      host.endsWith(".localhost") ||
      host.endsWith(".local") ||
      host.endsWith(".internal") ||
      host.endsWith(".lan") ||
      host.endsWith(".home.arpa")
    ) {
      return { safe: false, error: `Restricted internal hostname: ${host}` };
    }

    // Check if host is direct IP literal (or numeric/hex representation)
    const normalizedHost = normalizeIpString(host);
    if (net.isIP(normalizedHost)) {
      if (isPrivateOrInternalIp(normalizedHost)) {
        return { safe: false, error: `Restricted private or loopback IP: ${normalizedHost}` };
      }
      return { safe: true, resolvedIp: normalizedHost };
    }

    // If configured to allow designated proxy routing, outbound requests to public
    // domains through the proxy are accepted. But we still perform DNS validation
    // to block resolution to local/internal IP addresses.
    try {
      const addresses = await dns.lookup(host, { all: true });
      for (const addr of addresses) {
        if (isPrivateOrInternalIp(addr.address)) {
          return {
            safe: false,
            error: `Domain ${host} resolved to restricted internal IP: ${addr.address}`,
            resolvedIp: addr.address
          };
        }
      }
      return { safe: true, resolvedIp: addresses[0]?.address };
    } catch (dnsErr: any) {
      // In offline / test environments with mock domains, if allowProxyBypass is set,
      // allow domain if host format is valid FQDN
      if (options.allowProxyBypass && /^[a-z0-9-]+(\.[a-z0-9-]+)+$/i.test(host)) {
        return { safe: true };
      }
      return { safe: false, error: `DNS resolution failed for ${host}: ${dnsErr?.message || dnsErr}` };
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
  options: { wanDomain?: string; clientIp?: string } = {}
): boolean {
  const wanDomain = (options.wanDomain || process.env.READING_WEBAPP_URL || DEFAULT_WAN_DOMAIN)
    .replace(/^https?:\/\//i, "")
    .split("/")[0]
    .toLowerCase();

  const kosyncWanDomain = (process.env.KOSYNC_WAN_URL || KOSYNC_WAN_DOMAIN)
    .replace(/^https?:\/\//i, "")
    .split("/")[0]
    .toLowerCase();

  const hostHeader = (req.headers.get("x-forwarded-host") || req.headers.get("host") || "").toLowerCase().split(":")[0];

  // 1. Host or X-Forwarded-Host matches WAN domain
  if (hostHeader === wanDomain || hostHeader === kosyncWanDomain) {
    return true;
  }

  // 2. Check X-Forwarded-For: if it contains any public (non-internal) IP, it arrived via WAN
  const xForwardedFor = req.headers.get("x-forwarded-for");
  if (xForwardedFor) {
    const ips = xForwardedFor.split(",").map((s) => s.trim()).filter(Boolean);
    for (const ip of ips) {
      if (!isPrivateOrInternalIp(ip)) {
        return true;
      }
    }
  }

  // 3. Check client IP if provided
  if (options.clientIp && !isPrivateOrInternalIp(options.clientIp)) {
    return true;
  }

  // 4. Check X-Forwarded-Proto combined with reverse-tunnel headers
  const proto = req.headers.get("x-forwarded-proto");
  const via = req.headers.get("via");
  if (proto === "https" && (via || hostHeader.includes("."))) {
    // If it's HTTPS through a proxy and not on a local LAN host name
    if (!hostHeader.startsWith("192.168.") && !hostHeader.startsWith("10.") && !hostHeader.startsWith("127.") && hostHeader !== "localhost") {
      return true;
    }
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
  maxAgeSec = 86400 // 24 hours
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

    const secretKey = crypto.createHmac("sha256", "WebAppData").update(botToken).digest();
    const calculatedHash = crypto.createHmac("sha256", secretKey).update(dataCheckString).digest("hex");

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
    return { valid: false, error: `Failed to parse initData: ${err?.message || err}` };
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
  } = {}
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
    if (apiKey && (cookies.reading_token === apiKey || cookies.reading_session === apiKey)) {
      return { authenticated: true, method: "cookie" };
    }
    if (cookies.reading_tma && botToken) {
      const tmaRes = validateTelegramWebAppData(cookies.reading_tma, botToken);
      if (tmaRes.valid) {
        return { authenticated: true, method: "cookie", user: tmaRes.user };
      }
    }
  }

  // 5. Check URL query param ?token= or ?auth= (for downloads or webview handoffs)
  try {
    const url = new URL(req.url);
    const queryToken = url.searchParams.get("token") || url.searchParams.get("auth") || "";
    if (apiKey && queryToken === apiKey) {
      return { authenticated: true, method: "bearer" };
    }
  } catch (_urlErr) {
    void _urlErr;
  }

  return {
    authenticated: false,
    error: "Authentication required for public WAN access"
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
  extraAllowedOrigins: string[] = []
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
    .map((o) => o.trim().toLowerCase())
    .filter(Boolean);
  const allAllowed = [...extraAllowedOrigins.map((o) => o.toLowerCase()), ...envOrigins];
  if (allAllowed.includes(lower)) {
    return true;
  }

  // Allow local LAN origins: http://127.0.0.1:*, http://localhost:*, http://192.168.*:*
  try {
    const u = new URL(lower);
    const h = u.hostname;
    if (h === "localhost" || h === "127.0.0.1") return true;
    if (h.startsWith("192.168.") || h.startsWith("10.") || /^172\.(1[6-9]|2[0-9]|3[0-1])\./.test(h)) {
      return true;
    }
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
  extraAllowedOrigins: string[] = []
): { valid: boolean; error?: string } {
  const method = req.method.toUpperCase();
  const isMutating = ["POST", "PUT", "DELETE", "PATCH"].includes(method);

  // Read-only requests without origin are safe
  if (!isMutating && !req.headers.has("origin")) {
    return { valid: true };
  }

  const origin = req.headers.get("origin");
  const referer = req.headers.get("referer");

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
        return { valid: false, error: `Disallowed Referer origin: ${refOrigin}` };
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
      return { valid: false, error: "Cross-site request blocked by Sec-Fetch-Site policy" };
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
export const LEGACY_EBOOK_FORMATS = ["EPUB", "PDF", "MOBI", "AZW3", "CBZ", "CBR"] as const;

/**
 * Validates an eBook format against allowed formats.
 */
export function validateBookFormat(format: string, allowLegacy = true): string | null {
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
  format = "epub"
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
  s = s.replace(/\[.*?(?:ebook|pdf|epub|channel|mobi|azw|scan|myanmar|tg|bookr|z-?lib|libgen).*?\]/gi, " ");
  s = s.replace(/\((.*?)(?:ebook|pdf|epub|channel|mobi|azw|scan|myanmar|tg|bookr|z-?lib|libgen)(.*?)\)/gi, " ");
  s = s.replace(/_v[0-9]+/gi, " ");
  s = s.replace(/\([0-9]+\)$/g, " ");
  s = s.replace(/\b(epub|pdf|mobi|azw3|cbz|cbr)\b/gi, " ");
  s = s.replace(/[\s_]+/g, " ").trim();
  s = s.replace(/^[-–—:_.\s]+|[-–—:_.\s]+$/g, "").trim();
  return s;
}

// ---------------------------------------------------------------------------
// 7. Safe Error Handling
// ---------------------------------------------------------------------------

/**
 * Sanitizes an error to prevent leaking server filesystem paths, internal stack traces,
 * or host usernames in public HTTP responses.
 */
export function sanitizeErrorMessage(err: any): string {
  if (!err) return "An unexpected error occurred";
  const rawMsg = typeof err === "string" ? err : err.message || "An unexpected error occurred";

  // Remove filesystem paths (e.g. /Users/ospeto/..., /tmp/..., C:\...)
  let sanitized = rawMsg
    .replace(/(?:\/[a-zA-Z0-9._-]+)+/g, "[path]")
    .replace(/[a-zA-Z]:\\[a-zA-Z0-9._\-\\]+/g, "[path]")
    .replace(/at\s+.*\(.*:[0-9]+:[0-9]+\)/g, "") // Stack trace fragments
    .trim();

  // Strip token/key patterns
  sanitized = sanitized.replace(/(?:token|key|secret)=[a-zA-Z0-9_-]+/gi, "$1=[REDACTED]");

  if (sanitized.length > 300) {
    sanitized = sanitized.substring(0, 300) + "...";
  }

  return sanitized || "Operation failed";
}
