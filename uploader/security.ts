import crypto from "node:crypto";
import dns from "node:dns/promises";
import net from "node:net";
import path from "node:path";
import process from "node:process";
import fs from "node:fs";
import zlib from "node:zlib";
import { spawnSync } from "node:child_process";
import { Buffer } from "node:buffer";
import { Agent, buildConnector } from "undici";

// Default production WAN domain and ports
export const DEFAULT_WAN_DOMAIN = "reading.wavypremium.xyz";
export const READING_SG_WAN_DOMAIN = "reading-sg.wavypremium.xyz";
export const KOSYNC_WAN_DOMAIN = "kosync.wavypremium.xyz";
export const KOSYNC_SG_WAN_DOMAIN = "kosync-sg.wavypremium.xyz";
export const OPDS_SG_WAN_DOMAIN = "opds.wavypremium.xyz";

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
function expandIpv6(ip: string): number[] | null {
  const lower = ip.toLowerCase();
  const halves = lower.split("::");
  if (halves.length > 2) return null;

  const parseGroups = (part: string): number[] => {
    if (!part) return [];
    const groups = part.split(":");
    const last = groups[groups.length - 1];
    if (last?.includes(".")) {
      if (!net.isIPv4(last)) return [];
      const octets = last.split(".").map((octet) => parseInt(octet, 10));
      groups.splice(
        groups.length - 1,
        1,
        ((octets[0] << 8) | octets[1]).toString(16),
        ((octets[2] << 8) | octets[3]).toString(16),
      );
    }
    if (groups.some((group) => !/^[0-9a-f]{1,4}$/.test(group))) return [];
    return groups.map((group) => parseInt(group, 16));
  };

  const left = parseGroups(halves[0]);
  const right = halves.length === 2 ? parseGroups(halves[1]) : [];
  if ((halves[0] && left.length === 0) || (halves[1] && right.length === 0)) {
    return null;
  }
  if (halves.length === 1 && left.length !== 8) return null;
  if (halves.length === 2 && left.length + right.length >= 8) return null;

  return halves.length === 2
    ? [...left, ...Array(8 - left.length - right.length).fill(0), ...right]
    : left;
}

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

  // Check IPv6. Expand the address so range checks are based on bits rather
  // than textual prefixes (which are unsafe across equivalent compressed forms).
  if (net.isIPv6(ip)) {
    const groups = expandIpv6(ip);
    if (!groups) return true;

    const first = groups[0];
    const isIpv4Mapped =
      groups[0] === 0 &&
      groups[1] === 0 &&
      groups[2] === 0 &&
      groups[3] === 0 &&
      groups[4] === 0 &&
      groups[5] === 0xffff;
    if (isIpv4Mapped) {
      const high = groups[6];
      const low = groups[7];
      const dotted = `${(high >> 8) & 0xff}.${high & 0xff}.${(low >> 8) & 0xff}.${low & 0xff}`;
      return isPrivateOrInternalIp(dotted);
    }

    // Unspecified, loopback, IPv4-compatible, and other ::/8 special-use space.
    if (first === 0) return true;
    // Unique local: fc00::/7.
    if ((first & 0xfe00) === 0xfc00) return true;
    // Link-local: fe80::/10.
    if ((first & 0xffc0) === 0xfe80) return true;
    // Multicast: ff00::/8.
    if ((first & 0xff00) === 0xff00) return true;
    // Documentation, benchmarking, and ORCHIDv2 reservations.
    if (first === 0x2001 && groups[1] === 0x0db8) return true;
    if (first === 0x2001 && groups[1] === 0x0002 && groups[2] === 0)
      return true;
    if (first === 0x2001 && groups[1] === 0x0010) return true;
    if (first === 0x3fff && groups[1] === 0) return true;

    return false;
  }

  return true;
}

export function getBsdtarPath(): string {
  if (process.env.BSDTAR_PATH) return process.env.BSDTAR_PATH;
  const probe = spawnSync("which", ["bsdtar"], { encoding: "utf8" });
  if (probe.status === 0 && probe.stdout?.trim()) return probe.stdout.trim();
  const candidates = [
    "/usr/bin/bsdtar",
    "/opt/homebrew/bin/bsdtar",
    "/usr/local/bin/bsdtar",
  ];
  for (const cand of candidates) {
    if (fs.existsSync(cand)) return cand;
  }
  return "bsdtar";
}

export function getUnzipPath(): string {
  if (process.env.UNZIP_PATH) return process.env.UNZIP_PATH;
  const probe = spawnSync("which", ["unzip"], { encoding: "utf8" });
  if (probe.status === 0 && probe.stdout?.trim()) return probe.stdout.trim();
  const candidates = [
    "/usr/bin/unzip",
    "/opt/homebrew/bin/unzip",
    "/usr/local/bin/unzip",
  ];
  for (const cand of candidates) {
    if (fs.existsSync(cand)) return cand;
  }
  return "unzip";
}

export function parseUnzipListOutput(stdout: string): string[] {
  const entries: string[] = [];
  const lines = stdout.split("\n");
  let inEntries = false;
  for (const line of lines) {
    if (/^\s*[-]{4,}\s+[-]{4,}/.test(line)) {
      inEntries = !inEntries;
      continue;
    }
    if (inEntries) {
      const match = line.match(/^\s*\d+\s+\S+\s+\S+\s+(.+)$/);
      if (match && match[1]) {
        entries.push(match[1].trim());
      }
    }
  }
  return entries;
}

export interface ResolvedAddress {
  address: string;
  family: number;
}

export type DnsLookup = (hostname: string) => Promise<ResolvedAddress[]>;

export interface ValidateUrlOptions {
  allowProxyBypass?: boolean;
  allowCalibreServer?: boolean;
  allowFirecrawlServer?: boolean;
  allowInternalServices?: boolean;
  bindIp?: boolean;
  allowedProxyUrls?: string[];
  /** Test-only resolver seam; every returned address is still validated. */
  dnsLookup?: DnsLookup;
}

function isLoopbackIp(rawIp: string): boolean {
  const ip = normalizeIpString(rawIp);
  if (net.isIPv4(ip)) return ip.split(".")[0] === "127";
  if (!net.isIPv6(ip)) return false;
  const groups = expandIpv6(ip);
  return Boolean(
    groups &&
      groups.slice(0, 7).every((group) => group === 0) &&
      groups[7] === 1,
  );
}

async function resolveAll(
  hostname: string,
  options: ValidateUrlOptions,
): Promise<ResolvedAddress[]> {
  if (options.dnsLookup) return options.dnsLookup(hostname);
  return dns.lookup(hostname, { all: true });
}

/**
 * Validates a target URL against SSRF threats.
 * Blocks private IP ranges, link-local, cloud metadata endpoints (169.254.169.254),
 * and local hostnames. For allowed hosts, the complete validated DNS snapshot is
 * returned so the caller can connect without performing an unconstrained lookup.
 */
export async function validateUrlForSSRF(
  rawUrl: string,
  options: ValidateUrlOptions = {},
): Promise<{
  safe: boolean;
  error?: string;
  resolvedIp?: string;
  resolvedAddresses?: ResolvedAddress[];
}> {
  try {
    const u = new URL(rawUrl);

    if (u.protocol !== "http:" && u.protocol !== "https:") {
      return { safe: false, error: `Disallowed protocol: ${u.protocol}` };
    }
    if (u.username || u.password) {
      return { safe: false, error: "Embedded URL credentials not allowed" };
    }

    const host = u.hostname.toLowerCase();
    const normalizedHost = normalizeIpString(host);
    const isIpLiteral = net.isIP(normalizedHost) !== 0;
    const port = u.port || (u.protocol === "https:" ? "443" : "80");

    // Explicit internal-service access is a narrow, opt-in allowlist. It is
    // intentionally checked only after deriving host and only for loopback hosts.
    if (
      options.allowInternalServices &&
      (host === "localhost" || isLoopbackIp(normalizedHost)) &&
      ["8086", "8088", "7200"].includes(port)
    ) {
      const addresses = isIpLiteral
        ? [{ address: normalizedHost, family: net.isIP(normalizedHost) }]
        : await resolveAll(host, options);
      if (
        addresses.length > 0 &&
        addresses.every((addr) => isLoopbackIp(addr.address))
      ) {
        return {
          safe: true,
          resolvedIp: addresses[0].address,
          resolvedAddresses: addresses,
        };
      }
      return {
        safe: false,
        error: `Internal service ${host}:${port} did not resolve exclusively to loopback addresses`,
      };
    }

    if (options.allowFirecrawlServer) {
      let fcUrlStr = (process.env.FIRECRAWL_URL || "").trim();
      if (!fcUrlStr && process.env.FIRECRAWL_PORT) {
        const portNum = parseInt(process.env.FIRECRAWL_PORT, 10);
        if (!isNaN(portNum) && portNum > 0) {
          fcUrlStr = `http://127.0.0.1:${portNum}`;
        }
      }
      if (!fcUrlStr) {
        fcUrlStr = "http://127.0.0.1:3002";
      }

      let fcUrl: URL;
      try {
        fcUrl = new URL(fcUrlStr);
      } catch {
        return {
          safe: false,
          error: "Invalid FIRECRAWL_URL configured",
        };
      }

      const fcHost = fcUrl.hostname.toLowerCase();
      const fcNormHost = normalizeIpString(fcHost);
      const isFcIp = net.isIP(fcNormHost) !== 0;

      let fcAddresses: ResolvedAddress[] = [];
      if (isFcIp) {
        if (!isLoopbackIp(fcNormHost)) {
          return {
            safe: false,
            error: `Configured Firecrawl server IP ${fcNormHost} is not a loopback address`,
          };
        }
        fcAddresses = [{ address: fcNormHost, family: net.isIP(fcNormHost) }];
      } else {
        if (fcHost !== "localhost" && !fcHost.endsWith(".localhost")) {
          try {
            fcAddresses = await resolveAll(fcHost, options);
          } catch {
            return {
              safe: false,
              error: `DNS resolution failed for configured Firecrawl server host: ${fcHost}`,
            };
          }
        } else {
          fcAddresses = [{ address: "127.0.0.1", family: 4 }];
        }

        if (
          fcAddresses.length === 0 ||
          !fcAddresses.every((addr) => isLoopbackIp(addr.address))
        ) {
          return {
            safe: false,
            error: `Configured Firecrawl server host ${fcHost} did not resolve exclusively to loopback addresses`,
          };
        }
      }

      const fcPort = fcUrl.port || (fcUrl.protocol === "https:" ? "443" : "80");
      const isLoopbackTarget =
        host === "localhost" ||
        host.endsWith(".localhost") ||
        isLoopbackIp(normalizedHost);

      if (isLoopbackTarget && port === fcPort) {
        const targetAddresses = isIpLiteral
          ? [{ address: normalizedHost, family: net.isIP(normalizedHost) }]
          : await resolveAll(host, options);

        if (
          targetAddresses.length > 0 &&
          targetAddresses.every((addr) => isLoopbackIp(addr.address))
        ) {
          return {
            safe: true,
            resolvedIp: targetAddresses[0].address,
            resolvedAddresses: targetAddresses,
          };
        }
      }
    }

    if (options.allowCalibreServer) {
      let calibreUrl: URL;
      try {
        calibreUrl = new URL(
          process.env.CALIBRE_SERVER_URL || "http://127.0.0.1:8088",
        );
      } catch {
        return {
          safe: false,
          error: "Invalid CALIBRE_SERVER_URL configured",
        };
      }

      const calibreHost = calibreUrl.hostname.toLowerCase();
      const calibreNormHost = normalizeIpString(calibreHost);
      const isCalibreIp = net.isIP(calibreNormHost) !== 0;

      // Verify that the configured CALIBRE_SERVER_URL resolves strictly to loopback IP (127.0.0.1, ::1)
      let calibreAddresses: ResolvedAddress[] = [];
      if (isCalibreIp) {
        if (!isLoopbackIp(calibreNormHost)) {
          return {
            safe: false,
            error: `Configured Calibre server IP ${calibreNormHost} is not a loopback address`,
          };
        }
        calibreAddresses = [
          { address: calibreNormHost, family: net.isIP(calibreNormHost) },
        ];
      } else {
        if (calibreHost !== "localhost" && !calibreHost.endsWith(".localhost")) {
          try {
            calibreAddresses = await resolveAll(calibreHost, options);
          } catch {
            return {
              safe: false,
              error: `DNS resolution failed for configured Calibre server host: ${calibreHost}`,
            };
          }
        } else {
          calibreAddresses = [{ address: "127.0.0.1", family: 4 }];
        }

        if (
          calibreAddresses.length === 0 ||
          !calibreAddresses.every((addr) => isLoopbackIp(addr.address))
        ) {
          return {
            safe: false,
            error: `Configured Calibre server host ${calibreHost} did not resolve exclusively to loopback addresses`,
          };
        }
      }

      // Verify the target URL targets the loopback Calibre server
      const calibrePort =
        calibreUrl.port || (calibreUrl.protocol === "https:" ? "443" : "80");
      const isLoopbackTarget =
        host === "localhost" ||
        host.endsWith(".localhost") ||
        isLoopbackIp(normalizedHost);

      if (isLoopbackTarget && port === calibrePort) {
        const targetAddresses = isIpLiteral
          ? [{ address: normalizedHost, family: net.isIP(normalizedHost) }]
          : await resolveAll(host, options);

        if (
          targetAddresses.length > 0 &&
          targetAddresses.every((addr) => isLoopbackIp(addr.address)) &&
          (u.pathname === "/opds" ||
            u.pathname.startsWith("/opds/") ||
            u.pathname.startsWith("/get/") ||
            u.pathname === "/favicon.png")
        ) {
          return {
            safe: true,
            resolvedIp: targetAddresses[0].address,
            resolvedAddresses: targetAddresses,
          };
        }
      }
    }

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

    if (isIpLiteral) {
      if (isPrivateOrInternalIp(normalizedHost)) {
        return {
          safe: false,
          error: `Restricted private or loopback IP: ${normalizedHost}`,
        };
      }
      const address = {
        address: normalizedHost,
        family: net.isIP(normalizedHost),
      };
      return {
        safe: true,
        resolvedIp: normalizedHost,
        resolvedAddresses: [address],
      };
    }

    try {
      const addresses = await resolveAll(host, options);
      if (addresses.length === 0) {
        return {
          safe: false,
          error: `DNS resolution returned no addresses for ${host}`,
        };
      }
      for (const addr of addresses) {
        if (isPrivateOrInternalIp(addr.address)) {
          return {
            safe: false,
            error: `Domain ${host} resolved to restricted internal IP: ${addr.address}`,
            resolvedIp: addr.address,
          };
        }
      }
      return {
        safe: true,
        resolvedIp: addresses[0].address,
        resolvedAddresses: addresses,
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

export function isLanHost(host: string): boolean {
  const clean = host.toLowerCase().split(":")[0].trim();
  if (!clean) return false;
  if (clean === "localhost" || clean === "127.0.0.1" || clean === "::1")
    return true;
  if (clean.startsWith("192.168.") || clean.startsWith("10.")) return true;
  if (/^172\.(1[6-9]|2[0-9]|3[0-1])\./.test(clean)) return true;
  if (
    clean.endsWith(".local") ||
    clean.endsWith(".lan") ||
    clean.endsWith(".home.arpa")
  )
    return true;
  return false;
}

export interface IsWanRequestOptions {
  wanDomain?: string;
  clientIp?: string;
  remoteAddress?: string;
  server?: { requestIP?: (req: Request) => { address: string } | null };
}

/**
 * Determines whether a request originated from the public WAN vs local LAN.
 * Strictly verifies the actual remote socket address.
 * Proxy headers (X-Forwarded-*) are ONLY trusted if the connecting socket is 127.0.0.1 / ::1 (the local reverse tunnel).
 * Direct connections from outside 127.0.0.1 cannot spoof LAN status via Host or X-Forwarded headers.
 */
export function isWanRequest(
  req: Request,
  options: IsWanRequestOptions = {},
): boolean {
  const wanDomain = (
    options.wanDomain ||
    process.env.READING_WEBAPP_URL ||
    DEFAULT_WAN_DOMAIN
  )
    .replace(/^https?:\/\//i, "")
    .split("/")[0]
    .toLowerCase();

  const kosyncWanDomain = (process.env.KOSYNC_WAN_URL || KOSYNC_SG_WAN_DOMAIN)
    .replace(/^https?:\/\//i, "")
    .split("/")[0]
    .toLowerCase();

  // Standard recognized WAN domains
  const defaultWanDomains = new Set([
    wanDomain,
    READING_SG_WAN_DOMAIN,
    kosyncWanDomain,
    KOSYNC_WAN_DOMAIN,
    KOSYNC_SG_WAN_DOMAIN,
    OPDS_SG_WAN_DOMAIN,
  ]);

  // Extract socket address from server or options
  let socketIp = options.remoteAddress || options.clientIp || "";
  if (!socketIp && options.server?.requestIP) {
    const sock = options.server.requestIP(req);
    if (sock?.address) socketIp = sock.address;
  }
  const cleanSocketIp = socketIp.trim().replace(/^::ffff:/, "");

  const isLocalhostSocket =
    cleanSocketIp === "127.0.0.1" ||
    cleanSocketIp === "::1" ||
    cleanSocketIp === "localhost";

  // CASE 1: Socket is 127.0.0.1 / ::1 (traffic from local reverse tunnel)
  // Proxy headers are ONLY trusted when connecting socket is 127.0.0.1
  if (isLocalhostSocket) {
    const hostHeader = (
      req.headers.get("x-forwarded-host") ||
      req.headers.get("host") ||
      ""
    )
      .toLowerCase()
      .split(":")[0];

    if (defaultWanDomains.has(hostHeader)) {
      return true;
    }

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

    const proto = req.headers.get("x-forwarded-proto");
    if (proto === "https") {
      return true;
    }

    return false;
  }

  // CASE 2: Socket address is provided and NOT 127.0.0.1
  // Disregard all X-Forwarded headers because peer is not our trusted 127.0.0.1 tunnel
  if (cleanSocketIp) {
    // If socket IP is not a private RFC 1918 address, it is a direct public internet request -> WAN
    if (!isPrivateOrInternalIp(cleanSocketIp)) {
      return true;
    }
    // Socket IP is from private home LAN (192.168.*, 10.*, etc.) -> LAN
    return false;
  }

  // CASE 3: No verified peer socket address supplied -> FAIL CLOSED (treat as WAN)
  return true;
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
  method?: "lan" | "bearer" | "api_key" | "tma" | "cookie" | "origin";
  user?: any;
  error?: string;
}

export interface AuthenticateRequestOptions {
  apiKey?: string;
  botToken?: string;
  wanDomain?: string;
  clientIp?: string;
  remoteAddress?: string;
  isWan?: boolean;
  server?: { requestIP?: (req: Request) => { address: string } | null };
}

/**
 * Authenticates an incoming request.
 * Local LAN requests pass automatically. WAN requests must present:
 * - Bearer token matching READING_API_KEY
 * - X-API-Key matching READING_API_KEY
 * - Valid Telegram WebApp initData (via X-Telegram-Init-Data or Authorization: Bearer tma_...)
 * - Valid session cookie
 * - Or when READING_API_KEY is unset, a verified production WAN origin (Origin or Referer)
 */
export function authenticateRequest(
  req: Request,
  options: AuthenticateRequestOptions = {},
): AuthResult {
  // If caller already classified WAN status, use it; otherwise compute using socket peer address
  const isWan =
    options.isWan === undefined ? isWanRequest(req, options) : options.isWan;
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

  // 5. Allow verified production WAN origins when READING_API_KEY is unset.
  // When no API key is configured, public WAN access from the trusted web UI
  // is authenticated via production origin verification (Origin or Referer).
  // Local LAN / loopback origins are explicitly excluded from WAN authentication.
  if (!apiKey) {
    const origin = req.headers.get("origin");
    if (origin && isAllowedProductionWanOrigin(origin)) {
      return { authenticated: true, method: "origin" };
    }
    const referer = req.headers.get("referer");
    if (referer) {
      try {
        const refUrl = new URL(referer);
        const refOrigin = `${refUrl.protocol}//${refUrl.host}`;
        if (isAllowedProductionWanOrigin(refOrigin)) {
          return { authenticated: true, method: "origin" };
        }
      } catch {
        // Malformed referer ignored
      }
    }
  }

  // Credentials in query strings are intentionally not accepted. URLs leak via
  // browser history, proxy logs, Referer headers, and analytics; use a header or
  // the intended secure cookie channel instead.
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

/**
 * Checks if an origin matches verified production WAN origins (excluding local LAN/loopback).
 * Used strictly for authenticating WAN requests when READING_API_KEY is unset.
 */
export function isAllowedProductionWanOrigin(
  origin: string,
  extraAllowedOrigins: string[] = [],
): boolean {
  if (!origin) return false;
  const lower = origin.toLowerCase().trim();

  // Allow standard production WAN domains
  if (
    lower === "https://reading.wavypremium.xyz" ||
    lower === "http://reading.wavypremium.xyz" ||
    lower === "http://reading.wavypremium.xyz:80" ||
    lower === "https://reading-sg.wavypremium.xyz:8443" ||
    lower === "https://reading-sg.wavypremium.xyz" ||
    lower === "http://reading-sg.wavypremium.xyz" ||
    lower === "http://reading-sg.wavypremium.xyz:80" ||
    lower === "https://kosync.wavypremium.xyz" ||
    lower === "http://kosync-sg.wavypremium.xyz" ||
    lower === "https://kosync-sg.wavypremium.xyz:8443" ||
    lower === "http://opds.wavypremium.xyz" ||
    lower === "https://opds.wavypremium.xyz:8443"
  ) {
    return true;
  }

  // Allow configured WAN URLs (ensuring they are not local/private IPs)
  const isSafeWanUrl = (urlStr: string) => {
    try {
      const u = new URL(urlStr);
      const h = u.hostname.replace(/^\[|\]$/g, "");
      if (h === "localhost" || h.endsWith(".localhost") || isPrivateOrInternalIp(h)) {
        return false;
      }
      return true;
    } catch {
      return false;
    }
  };

  const readingWan = process.env.READING_WEBAPP_URL;
  if (
    readingWan &&
    isSafeWanUrl(readingWan) &&
    lower === readingWan.toLowerCase().replace(/\/+$/, "")
  ) {
    return true;
  }
  const kosyncWan = process.env.KOSYNC_WAN_URL;
  if (
    kosyncWan &&
    isSafeWanUrl(kosyncWan) &&
    lower === kosyncWan.toLowerCase().replace(/\/+$/, "")
  ) {
    return true;
  }

  // Check extra allowed origins from options or env (ensuring they are not local LAN)
  const envOrigins = (process.env.ALLOWED_ORIGINS || "")
    .split(",")
    .map((o: string) => o.trim().toLowerCase())
    .filter(Boolean);
  const allAllowed = [
    ...extraAllowedOrigins.map((o: string) => o.toLowerCase()),
    ...envOrigins,
  ];
  if (allAllowed.includes(lower) && isSafeWanUrl(lower)) {
    return true;
  }

  return false;
}

export function isAllowedOrigin(
  origin: string,
  extraAllowedOrigins: string[] = [],
): boolean {
  if (!origin) return false;
  const lower = origin.toLowerCase().trim();

  // Allow standard production WAN domains
  if (isAllowedProductionWanOrigin(origin, extraAllowedOrigins)) {
    return true;
  }

  // Check extra allowed origins from options or env
  const envOrigins = (process.env.ALLOWED_ORIGINS || "")
    .split(",")
    .map((o: string) => o.trim().toLowerCase())
    .filter(Boolean);
  const allAllowed = [
    ...extraAllowedOrigins.map((o: string) => o.toLowerCase()),
    ...envOrigins,
  ];
  if (allAllowed.includes(lower)) {
    return true;
  }

  // Allow local LAN origins: http://127.0.0.1:*, http://localhost:*, http://192.168.*:*
  try {
    const u = new URL(lower);
    const h = u.hostname;
    if (h === "localhost" || h === "127.0.0.1") return true;
    if (
      h.startsWith("192.168.") ||
      h.startsWith("10.") ||
      /^172\.(1[6-9]|2[0-9]|3[0-1])\./.test(h)
    ) {
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
  extraAllowedOrigins: string[] = [],
): { valid: boolean; error?: string } {
  const method = req.method.toUpperCase();
  const isMutating = ["POST", "PUT", "DELETE", "PATCH"].includes(method);

  // Read-only requests without origin are safe
  if (!isMutating && !req.headers.has("origin")) {
    return { valid: true };
  }

  const origin = req.headers.get("origin");
  const referer = req.headers.get("referer");
  const hasCookie = req.headers.has("cookie");
  const hasAuthHeader =
    req.headers.has("authorization") ||
    req.headers.has("x-api-key") ||
    req.headers.has("x-telegram-init-data");

  // CSRF protection: mutating requests with cookie authentication MUST provide Origin or Referer
  if (isMutating && hasCookie && !hasAuthHeader && !origin && !referer) {
    return {
      valid: false,
      error:
        "CSRF protection: mutating request with cookie authentication must provide Origin or Referer header",
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

export interface EpubValidationResult {
  valid: boolean;
  error?: string;
}

/**
 * Validates the physical content of an EPUB container:
 * - Checks ZIP magic bytes (0x50, 0x4B, 0x03, 0x04)
 * - Verifies mimetype entry contains application/epub+zip
 * - Verifies required container entry: META-INF/container.xml
 */
export function validateEpubContent(filePath: string): EpubValidationResult {
  try {
    if (!fs.existsSync(filePath)) {
      return { valid: false, error: "File does not exist" };
    }
    const stat = fs.statSync(filePath);
    if (stat.size < 58) {
      return { valid: false, error: "File size too small for a valid EPUB" };
    }

    const fd = fs.openSync(filePath, "r");
    const headerBuf = Buffer.alloc(128);
    const bytesRead = fs.readSync(fd, headerBuf, 0, 128, 0);
    fs.closeSync(fd);

    if (bytesRead < 30) {
      return { valid: false, error: "Truncated file header" };
    }

    // 1. Check ZIP magic bytes (PK\x03\x04)
    if (
      headerBuf[0] !== 0x50 ||
      headerBuf[1] !== 0x4b ||
      headerBuf[2] !== 0x03 ||
      headerBuf[3] !== 0x04
    ) {
      return {
        valid: false,
        error: "Invalid magic bytes: not a valid ZIP/EPUB container",
      };
    }

    // 2. Inspect archive entries with bsdtar -tf (with Info-ZIP unzip fallback)
    const execOpts = {
      encoding: "utf8" as const,
      timeout: 30000,
      maxBuffer: 16 * 1024 * 1024,
    };

    let lines: string[] = [];
    const listRes = spawnSync(getBsdtarPath(), ["-tf", filePath], execOpts);

    if (
      listRes.status === 0 &&
      listRes.stdout &&
      listRes.stdout.trim().length > 0
    ) {
      lines = listRes.stdout
        .split("\n")
        .map((e: string) => e.trim())
        .filter(Boolean);
    } else {
      // bsdtar failed or yielded empty stdout: attempt Info-ZIP unzip fallback
      const unzipRes = spawnSync(
        getUnzipPath(),
        ["-Z1", filePath],
        execOpts,
      );

      if (
        (unzipRes.status === 0 || unzipRes.status === 1) &&
        unzipRes.stdout &&
        unzipRes.stdout.trim().length > 0
      ) {
        lines = unzipRes.stdout
          .split("\n")
          .map((e: string) => e.trim())
          .filter(Boolean);
      } else {
        // Try unzip -l if unzip -Z1 yielded no entries
        const unzipLRes = spawnSync(
          getUnzipPath(),
          ["-l", filePath],
          execOpts,
        );
        const parsedL =
          (unzipLRes.status === 0 || unzipLRes.status === 1) && unzipLRes.stdout
            ? parseUnzipListOutput(unzipLRes.stdout)
            : [];

        if (parsedL.length > 0) {
          lines = parsedL;
        } else {
          const bsdtarErr =
            listRes.error?.message ||
            (listRes.stderr && listRes.stderr.trim()) ||
            (listRes.status !== null && listRes.status !== undefined
              ? `exit code ${listRes.status}`
              : "");
          const unzipErr =
            unzipRes.error?.message ||
            (unzipRes.stderr && unzipRes.stderr.trim()) ||
            (unzipRes.status !== null && unzipRes.status !== undefined
              ? `exit code ${unzipRes.status}`
              : "");
          const details = [
            bsdtarErr ? `bsdtar: ${bsdtarErr}` : "",
            unzipErr ? `unzip: ${unzipErr}` : "",
          ]
            .filter(Boolean)
            .join("; ");

          return {
            valid: false,
            error: details
              ? `Failed to read EPUB ZIP entries: ${details}`
              : "Failed to read EPUB ZIP entries",
          };
        }
      }
    }

    // Reject absolute paths, path traversal, drive letters, or non-canonical names BEFORE any normalization
    for (const entry of lines) {
      if (
        entry.includes("..") ||
        entry.startsWith("/") ||
        entry.startsWith("\\") ||
        entry.startsWith("./") ||
        entry.startsWith(".\\") ||
        /^[a-zA-Z]:[\\/]/.test(entry) ||
        entry.includes("\0")
      ) {
        return {
          valid: false,
          error: `Unsafe or non-canonical path in EPUB archive entry: "${entry}"`,
        };
      }
    }

    const rawEntries = lines;

    // 3. Mimetype must be the exact root entry 'mimetype' matching 'application/epub+zip'
    const hasExactRootMimetype = rawEntries.includes("mimetype");
    const hasNestedMimetype = rawEntries.some(
      (e: string) => e !== "mimetype" && e.endsWith("mimetype"),
    );
    if (!hasExactRootMimetype || hasNestedMimetype) {
      return {
        valid: false,
        error: "Missing required exact root EPUB 'mimetype' entry",
      };
    }

    const mimeRes = spawnSync(
      getBsdtarPath(),
      ["-xOf", filePath, "mimetype"],
      execOpts,
    );
    let mimeContent =
      mimeRes.status === 0 && mimeRes.stdout ? mimeRes.stdout.trim() : "";

    if (mimeContent !== "application/epub+zip") {
      // Fallback to Info-ZIP unzip -p
      const unzipMime = spawnSync(
        getUnzipPath(),
        ["-p", filePath, "mimetype"],
        execOpts,
      );
      if (
        (unzipMime.status === 0 || unzipMime.status === 1) &&
        unzipMime.stdout &&
        unzipMime.stdout.trim() === "application/epub+zip"
      ) {
        mimeContent = unzipMime.stdout.trim();
      } else {
        const actualGot = (
          unzipMime.stdout ||
          mimeRes.stdout ||
          ""
        ).trim().slice(0, 50);
        return {
          valid: false,
          error: `Invalid EPUB mimetype content: expected 'application/epub+zip', got '${actualGot}'`,
        };
      }
    }

    // 4. Container entry must be exactly 'META-INF/container.xml' (not nested in subfolders)
    const hasExactContainer = rawEntries.includes("META-INF/container.xml");
    if (!hasExactContainer) {
      return {
        valid: false,
        error:
          "Missing required exact root EPUB container definition: META-INF/container.xml",
      };
    }

    return { valid: true };
  } catch (err: any) {
    return {
      valid: false,
      error: `EPUB content validation error: ${err?.message || err}`,
    };
  }
}

interface ParsedLocalHeaderEntry {
  offset: number;
  versionNeeded: number;
  flags: number;
  compMethod: number;
  modTime: number;
  modDate: number;
  crc32: number;
  compSize: number;
  uncompSize: number;
  fileNameLen: number;
  extraLen: number;
  fileName: string;
  dataOffset: number;
  dataEnd: number;
}

export interface XmlElement {
  name: string;
  attributes: Record<string, string>;
  children: XmlElement[];
}

const MAX_REPAIR_FILE_SIZE = 64 * 1024 * 1024; // 64 MiB bound
const MAX_GLOBAL_DECOMPRESSED_BUDGET = 128 * 1024 * 1024; // 128 MiB global budget
const MAX_ENTRIES = 5000;
const MAX_DESCRIPTOR_SCAN_WINDOW = 16 * 1024 * 1024; // 16 MiB
const MAX_UNCOMPRESSED_ENTRY_SIZE = 64 * 1024 * 1024; // 64 MiB
const MAX_COMPRESSION_RATIO = 100; // 100:1
const PK_MAGIC = Buffer.from([0x50, 0x4b]);

/**
 * Strict well-formed XML parser in pure TypeScript with full-input cursor tracking.
 * - Tracks a position cursor from 0 to text.length.
 * - Allows optional <?xml ...?> strictly at index 0 without leading whitespace (rejects leading ws and <?xml?> inside elements).
 * - Requires whitespace after '<?xml' (rejects <?xml-stuff?>).
 * - Masks CDATA and comments before checking for stray '<?xml'.
 * - Quote-aware tag-end scanning so '>' inside attribute values (e.g. <root a="x>y"/>) is not treated as tag end.
 * - Requires whitespace before every attribute token (rejects '<root a="1"b="2"/>').
 * - Rejects duplicate attribute names on the same element including duplicate '__proto__' via Set tracking.
 * - Verifies that all characters outside tags are valid whitespace/text and contain no unparsed '<'.
 * - Enforces balanced, closed tags (rejects unclosed elements like '<container><rootfile></container>').
 * - Returns null if the cursor does not consume the entire input (e.g. trailing '<' or '<broken').
 */
export function parseStrictXml(xmlStr: string): XmlElement | null {
  if (!xmlStr || typeof xmlStr !== "string") return null;

  // XML declaration must be strictly at index 0 without leading whitespace
  let src = xmlStr;
  if (src.startsWith("<?xml")) {
    if (src.length < 6 || !/\s/.test(src[5])) {
      return null; // Reject malformed processing instruction like <?xml-stuff?>
    }
    const declEnd = src.indexOf("?>");
    if (declEnd === -1) {
      return null;
    }
    src = src.slice(declEnd + 2);
  }

  // Mask CDATA, comments, and DOCTYPE before checking for stray <?xml
  src = src.replace(/<!--[\s\S]*?-->/g, "");
  src = src.replace(/<!\[CDATA\[[\s\S]*?\]\]>/g, "");
  src = src.replace(/<!DOCTYPE\b[\s\S]*?>/gi, "");

  // Reject any <?xml placed after leading whitespace, inside elements, or later in the document
  if (/<\?xml\b/i.test(src)) {
    return null;
  }

  const stack: XmlElement[] = [];
  let root: XmlElement | null = null;
  let cursor = 0;

  while (cursor < src.length) {
    const nextLt = src.indexOf("<", cursor);
    if (nextLt === -1) {
      // No more tags. Check remainder for valid whitespace/text outside tags.
      const remaining = src.slice(cursor);
      if (stack.length === 0 && root !== null && remaining.trim().length > 0) {
        return null; // Non-whitespace trailing text after root element
      }
      cursor = src.length;
      break;
    }

    // Outside root element, only whitespace is allowed before opening tag
    const textBetween = src.slice(cursor, nextLt);
    if (stack.length === 0 && textBetween.trim().length > 0) {
      return null;
    }

    // Quote-aware scan for closing '>' so '>' inside attribute values is ignored
    let nextGt = -1;
    let inQuote: '"' | "'" | null = null;
    for (let i = nextLt + 1; i < src.length; i++) {
      const ch = src[i];
      if (inQuote === null) {
        if (ch === '"' || ch === "'") {
          inQuote = ch;
        } else if (ch === "<") {
          return null; // Malformed tag containing nested unescaped '<'
        } else if (ch === ">") {
          nextGt = i;
          break;
        }
      } else if (ch === inQuote) {
        inQuote = null;
      }
    }

    if (nextGt === -1 || inQuote !== null) {
      // Malformed: unclosed '<...' without '>' or unclosed quote
      return null;
    }

    const inner = src.slice(nextLt + 1, nextGt);
    const tagContent = inner.trim();
    if (tagContent.length === 0) {
      return null; // Empty tag: <>
    }

    cursor = nextGt + 1;

    // Closing tag: </tagName>
    if (tagContent.startsWith("/")) {
      const closingName = tagContent.slice(1).trim();
      if (!/^[a-zA-Z0-9_:.-]+$/.test(closingName)) {
        return null; // Invalid tag name or attributes in closing tag
      }
      if (stack.length === 0) {
        return null; // Unbalanced closing tag
      }
      const top = stack.pop()!;
      if (top.name.toLowerCase() !== closingName.toLowerCase()) {
        return null; // Mismatched tag nesting
      }
      continue;
    }

    // Opening or self-closing tag
    let isSelfClosing = false;
    let body = tagContent;
    if (body.endsWith("/")) {
      isSelfClosing = true;
      body = body.slice(0, -1).trim();
    }

    const spaceIdx = body.search(/\s/);
    let tagName = "";
    let rawAttrs = "";
    if (spaceIdx === -1) {
      tagName = body;
    } else {
      tagName = body.slice(0, spaceIdx);
      rawAttrs = body.slice(spaceIdx);
    }

    if (!/^[a-zA-Z0-9_:.-]+$/.test(tagName)) {
      return null; // Invalid tag name
    }

    // Strictly validate all attribute tokens (require whitespace before each token, reject duplicates via Set)
    const attributes: Record<string, string> = Object.create(null);
    const seenAttrs = new Set<string>();
    if (rawAttrs.length > 0) {
      let attrPos = 0;
      while (attrPos < rawAttrs.length) {
        let hasLeadingWhitespace = false;
        while (attrPos < rawAttrs.length && /\s/.test(rawAttrs[attrPos])) {
          hasLeadingWhitespace = true;
          attrPos++;
        }
        if (attrPos >= rawAttrs.length) break;

        // Reject glued attributes like <root a="1"b="2"/>
        if (!hasLeadingWhitespace) {
          return null;
        }

        const eqIdx = rawAttrs.indexOf("=", attrPos);
        if (eqIdx === -1) {
          return null; // Malformed attribute: missing '='
        }

        const attrName = rawAttrs.slice(attrPos, eqIdx).trim();
        if (!/^[a-zA-Z0-9_:.-]+$/.test(attrName)) {
          return null; // Invalid attribute identifier
        }

        // Reject duplicate attribute names on the same element
        if (seenAttrs.has(attrName)) {
          return null;
        }
        seenAttrs.add(attrName);

        let valStart = eqIdx + 1;
        while (valStart < rawAttrs.length && /\s/.test(rawAttrs[valStart])) {
          valStart++;
        }
        if (valStart >= rawAttrs.length) {
          return null; // Missing attribute value
        }

        const quote = rawAttrs[valStart];
        if (quote !== '"' && quote !== "'") {
          return null; // Unquoted attribute value
        }

        const valEnd = rawAttrs.indexOf(quote, valStart + 1);
        if (valEnd === -1) {
          return null; // Unclosed attribute quote
        }

        attributes[attrName] = rawAttrs.slice(valStart + 1, valEnd);
        attrPos = valEnd + 1;
      }
    }

    const element: XmlElement = {
      name: tagName,
      attributes,
      children: [],
    };

    if (stack.length === 0) {
      if (root !== null) {
        return null; // Multiple root elements
      }
      root = element;
    } else {
      stack[stack.length - 1].children.push(element);
    }

    if (!isSelfClosing) {
      stack.push(element);
    }
  }

  // Full-input consumption check: stack must be empty and root element present
  if (stack.length > 0 || root === null || cursor < src.length) {
    return null;
  }

  return root;
}

function extractEntryContent(
  buf: Buffer,
  entry: ParsedLocalHeaderEntry,
  maxSize = 10 * 1024 * 1024,
  maxRatio = 100,
): Buffer | null {
  try {
    const rawSlice = buf.subarray(entry.dataOffset, entry.dataOffset + entry.compSize);
    if (entry.compMethod === 0) {
      if (entry.compSize > maxSize) return null;
      return rawSlice;
    }
    if (entry.compMethod === 8) {
      if (entry.uncompSize > maxSize) return null;
      if (rawSlice.length > 0 && entry.uncompSize / rawSlice.length > maxRatio) {
        return null;
      }
      const decompressed = zlib.inflateRawSync(rawSlice, {
        maxOutputLength: Math.min(maxSize, Math.max(1024, (rawSlice.length + 1) * maxRatio)),
      });
      if (decompressed.length > maxSize) return null;
      if (rawSlice.length > 0 && decompressed.length / rawSlice.length > maxRatio) {
        return null;
      }
      return decompressed;
    }
    return null;
  } catch {
    return null;
  }
}

/**
 * Pure in-process structural and strict XML verification of core EPUB metadata.
 * Verifies:
 * 1. Mimetype is method 0 (stored) and matches 'application/epub+zip'.
 * 2. META-INF/container.xml is well-formed XML with root <container>, inside it <rootfiles>,
 *    and inside that <rootfile full-path="...">.
 * 3. OPF file referenced in container.xml exists, is well-formed XML with root <package>,
 *    and contains child elements <metadata>, <manifest>, and <spine> with matching closing tags.
 */
export function validateHealedZipInProcess(
  buf: Buffer,
  entries: ParsedLocalHeaderEntry[],
): boolean {
  if (!entries || entries.length === 0) return false;

  // 1. Verify mimetype entry is method 0 and contains 'application/epub+zip'
  const mimeEntry = entries.find((e) => e.fileName === "mimetype");
  if (!mimeEntry || mimeEntry.compMethod !== 0) {
    return false;
  }
  const mimeBytes = extractEntryContent(buf, mimeEntry, 1024);
  if (!mimeBytes) return false;
  const mimeStr = mimeBytes.toString("utf8").trim();
  if (mimeStr !== "application/epub+zip") {
    return false;
  }

  // 2. Extract and strictly parse META-INF/container.xml:
  // Must have root element <container>, inside it <rootfiles>, inside that <rootfile full-path="...">
  const containerEntry = entries.find((e) => e.fileName === "META-INF/container.xml");
  if (!containerEntry) return false;
  const containerBytes = extractEntryContent(buf, containerEntry);
  if (!containerBytes) return false;
  const containerXml = containerBytes.toString("utf8");

  const containerTree = parseStrictXml(containerXml);
  if (!containerTree || containerTree.name.toLowerCase() !== "container") {
    return false;
  }
  const rootfiles = containerTree.children.find((c) => c.name.toLowerCase() === "rootfiles");
  if (!rootfiles) {
    return false;
  }
  const rootfile = rootfiles.children.find((c) => c.name.toLowerCase() === "rootfile");
  if (!rootfile) {
    return false;
  }
  const rawOpfPath = (rootfile.attributes["full-path"] || "").trim().replace(/^\/+/, "");
  if (!rawOpfPath) {
    return false;
  }

  // 3. Verify that the OPF path exists in entries, strictly parse it:
  // Must have root element <package>, and contain child elements <metadata>, <manifest>, and <spine>
  const opfEntry = entries.find(
    (e) => e.fileName === rawOpfPath || e.fileName.toLowerCase() === rawOpfPath.toLowerCase(),
  );
  if (!opfEntry) {
    return false;
  }
  const opfBytes = extractEntryContent(buf, opfEntry);
  if (!opfBytes) return false;
  const opfXml = opfBytes.toString("utf8");

  const opfTree = parseStrictXml(opfXml);
  if (!opfTree || opfTree.name.toLowerCase() !== "package") {
    return false;
  }

  const hasMetadata = opfTree.children.some((c) => c.name.toLowerCase() === "metadata");
  const hasManifest = opfTree.children.some((c) => c.name.toLowerCase() === "manifest");
  const hasSpine = opfTree.children.some((c) => c.name.toLowerCase() === "spine");

  if (!hasMetadata || !hasManifest || !hasSpine) {
    return false;
  }

  return true;
}

/**
 * Parses Central Directory records from a standard ZIP buffer to extract entries.
 */
export function parseCentralDirectoryEntries(buf: Buffer): ParsedLocalHeaderEntry[] | null {
  if (buf.length < 22) return null;
  const eocdOffset = buf.length - 22;
  if (buf.readUInt32LE(eocdOffset) !== 0x06054b50) return null;

  const totalEntries = buf.readUInt16LE(eocdOffset + 10);
  const cdSize = buf.readUInt32LE(eocdOffset + 12);
  const cdOffset = buf.readUInt32LE(eocdOffset + 16);

  if (cdOffset + cdSize > eocdOffset) return null;

  const entries: ParsedLocalHeaderEntry[] = [];
  let pos = cdOffset;

  for (let i = 0; i < totalEntries; i++) {
    if (pos + 46 > cdOffset + cdSize) return null;
    if (buf.readUInt32LE(pos) !== 0x02014b50) return null;

    const versionNeeded = buf.readUInt16LE(pos + 6);
    const flags = buf.readUInt16LE(pos + 8);
    const compMethod = buf.readUInt16LE(pos + 10);
    const modTime = buf.readUInt16LE(pos + 12);
    const modDate = buf.readUInt16LE(pos + 14);
    const crc32 = buf.readUInt32LE(pos + 16);
    const compSize = buf.readUInt32LE(pos + 20);
    const uncompSize = buf.readUInt32LE(pos + 24);
    const fileNameLen = buf.readUInt16LE(pos + 28);
    const extraLen = buf.readUInt16LE(pos + 30);
    const commentLen = buf.readUInt16LE(pos + 32);
    const localHeaderOffset = buf.readUInt32LE(pos + 42);

    if (pos + 46 + fileNameLen + extraLen + commentLen > cdOffset + cdSize) return null;
    const fileName = buf.toString("utf8", pos + 46, pos + 46 + fileNameLen);

    if (localHeaderOffset + 30 > buf.length) return null;
    if (buf.readUInt32LE(localHeaderOffset) !== 0x04034b50) return null;
    const localFileNameLen = buf.readUInt16LE(localHeaderOffset + 26);
    const localExtraLen = buf.readUInt16LE(localHeaderOffset + 28);
    const dataOffset = localHeaderOffset + 30 + localFileNameLen + localExtraLen;
    const dataEnd = dataOffset + compSize;

    entries.push({
      offset: localHeaderOffset,
      versionNeeded,
      flags,
      compMethod,
      modTime,
      modDate,
      crc32,
      compSize,
      uncompSize,
      fileNameLen,
      extraLen,
      fileName,
      dataOffset,
      dataEnd,
    });

    pos += 46 + fileNameLen + extraLen + commentLen;
  }

  return entries;
}

/**
 * In-process ZIP auto-healer for truncated EPUB files (missing Central Directory,
 * trailing null padding, or incomplete trailing stream from interrupted uploads).
 *
 * Pure TypeScript/Bun in-process header reconstruction and structural validation:
 * 1. Verifies file begins with standard ZIP magic bytes PK\x03\x04.
 * 2. Sequentially parses local file headers with strict bounds (64MB file size, 5000 max entries,
 *    16MB max descriptor scan window, 128MB global decompression budget).
 * 3. Validates trailing entry compressed streams with 100:1 ratio limits and drops incomplete entries.
 * 4. Validates core EPUB metadata in-process (strict XML parse of container.xml and OPF package structure).
 * 5. Builds standard ZIP Central Directory (PK\x01\x02) and EOCD (PK\x05\x06) records.
 * 6. Atomically validates candidate file on disk before replacing target file.
 */
export function repairTruncatedEpub(filePath: string): boolean {
  let tempRepairedPath: string | null = null;
  try {
    if (!fs.existsSync(filePath)) {
      return false;
    }
    const stat = fs.statSync(filePath);
    if (stat.size < 30 || stat.size > MAX_REPAIR_FILE_SIZE) {
      return false;
    }

    let buf: Buffer;
    // SAFETY: Inspect globalThis for Bun runtime mmap API without introducing external type dependencies
    const bunGlobal = (globalThis as unknown as { Bun?: { mmap?: (p: string) => Uint8Array } }).Bun;
    if (bunGlobal && typeof bunGlobal.mmap === "function") {
      try {
        const m = bunGlobal.mmap(filePath);
        buf = Buffer.from(m.buffer, m.byteOffset, m.byteLength);
      } catch {
        buf = fs.readFileSync(filePath);
      }
    } else {
      buf = fs.readFileSync(filePath);
    }
    if (buf.length < 30) {
      return false;
    }

    // 1. Verify standard ZIP magic bytes (PK\x03\x04)
    if (
      buf[0] !== 0x50 ||
      buf[1] !== 0x4b ||
      buf[2] !== 0x03 ||
      buf[3] !== 0x04
    ) {
      return false;
    }

    // 2. Sequentially parse local file headers
    let offset = 0;
    const entries: ParsedLocalHeaderEntry[] = [];
    let lastValidDataEnd = 0;

    while (offset + 30 <= buf.length) {
      if (entries.length >= MAX_ENTRIES) {
        break;
      }

      const sig = buf.readUInt32LE(offset);
      // If we hit Central Directory or EOCD, stop reading local headers
      if (sig === 0x02014b50 || sig === 0x06054b50) {
        break;
      }
      // If not a local header, stop before trailing garbage or null padding
      if (sig !== 0x04034b50) {
        break;
      }

      const versionNeeded = buf.readUInt16LE(offset + 4);
      const flags = buf.readUInt16LE(offset + 6);
      const compMethod = buf.readUInt16LE(offset + 8);
      const modTime = buf.readUInt16LE(offset + 10);
      const modDate = buf.readUInt16LE(offset + 12);
      let crc32 = buf.readUInt32LE(offset + 14);
      let compSize = buf.readUInt32LE(offset + 18);
      let uncompSize = buf.readUInt32LE(offset + 22);
      const fileNameLen = buf.readUInt16LE(offset + 26);
      const extraLen = buf.readUInt16LE(offset + 28);

      const headerSize = 30 + fileNameLen + extraLen;
      if (offset + headerSize > buf.length) {
        // Truncated local header
        break;
      }

      const fileName = buf.toString("utf8", offset + 30, offset + 30 + fileNameLen);
      const dataOffset = offset + headerSize;
      let dataEnd = dataOffset + compSize;

      // Handle streaming data descriptor if bit 3 is set
      if ((flags & 0x0008) !== 0) {
        if (compSize === 0) {
          const scanLimit = Math.min(buf.length, dataOffset + MAX_DESCRIPTOR_SCAN_WINDOW);
          const MAX_DESCRIPTOR_PROBES = 128;
          let probes = 0;
          let p = dataOffset;
          let foundDescriptor = false;
          while (p + 4 <= scanLimit) {
            const nextPk = buf.subarray(0, scanLimit).indexOf(PK_MAGIC, p);
            if (nextPk === -1 || nextPk + 4 > scanLimit) break;
            if (++probes > MAX_DESCRIPTOR_PROBES) break;
            const descSig = buf.readUInt32LE(nextPk);
            if (descSig === 0x08074b50 && nextPk + 16 <= buf.length) {
              compSize = nextPk - dataOffset;
              crc32 = buf.readUInt32LE(nextPk + 4);
              uncompSize = buf.readUInt32LE(nextPk + 12);
              dataEnd = nextPk + 16;
              foundDescriptor = true;
              break;
            }
            if (descSig === 0x04034b50 || descSig === 0x02014b50) {
              if (nextPk >= dataOffset + 12) {
                const descOffset = nextPk - 12;
                compSize = descOffset - dataOffset;
                crc32 = buf.readUInt32LE(descOffset);
                uncompSize = buf.readUInt32LE(descOffset + 8);
                dataEnd = nextPk;
                foundDescriptor = true;
                break;
              }
            }
            p = nextPk + 1;
          }
          if (!foundDescriptor) {
            break;
          }
        } else if (dataEnd + 16 <= buf.length && buf.readUInt32LE(dataEnd) === 0x08074b50) {
          dataEnd += 16;
        }
      }

      // Check if compressed data overflows buffer
      if (dataEnd > buf.length) {
        break;
      }

      entries.push({
        offset,
        versionNeeded,
        flags,
        compMethod,
        modTime,
        modDate,
        crc32,
        compSize,
        uncompSize,
        fileNameLen,
        extraLen,
        fileName,
        dataOffset,
        dataEnd,
      });

      lastValidDataEnd = dataEnd;
      offset = dataEnd;
    }

    // 4. Validate compressed stream of trailing entries and discard if incomplete
    let totalDecompressedBytes = 0;
    while (entries.length > 0) {
      const last = entries[entries.length - 1];
      if (last.compMethod === 8) {
        try {
          const rawSlice = buf.subarray(last.dataOffset, last.dataOffset + last.compSize);
          if (
            last.uncompSize > MAX_UNCOMPRESSED_ENTRY_SIZE ||
            totalDecompressedBytes + last.uncompSize > MAX_GLOBAL_DECOMPRESSED_BUDGET ||
            (rawSlice.length > 0 && last.uncompSize / rawSlice.length > MAX_COMPRESSION_RATIO)
          ) {
            throw new Error("Decompression ratio or budget exceeded");
          }
          const decomp = zlib.inflateRawSync(rawSlice, {
            maxOutputLength: Math.min(
              MAX_UNCOMPRESSED_ENTRY_SIZE,
              Math.max(1024, (rawSlice.length + 1) * MAX_COMPRESSION_RATIO),
            ),
          });
          totalDecompressedBytes += decomp.length;
          break;
        } catch {
          entries.pop();
          lastValidDataEnd = entries.length > 0 ? entries[entries.length - 1].dataEnd : 0;
        }
      } else {
        break;
      }
    }

    if (entries.length === 0 || lastValidDataEnd === 0) {
      return false;
    }

    // Pure in-process validation of core metadata (mimetype, container.xml, OPF and strict XML structure)
    if (!validateHealedZipInProcess(buf, entries)) {
      return false;
    }

    // 5. Build standard ZIP Central Directory (PK\x01\x02) and EOCD (PK\x05\x06)
    const cdBuffers: Buffer[] = [];
    for (const entry of entries) {
      const cd = Buffer.alloc(46 + entry.fileNameLen + entry.extraLen);
      cd.writeUInt32LE(0x02014b50, 0); // PK\x01\x02 signature
      cd.writeUInt16LE(20, 4); // Version made by (2.0)
      cd.writeUInt16LE(entry.versionNeeded || 20, 6); // Version needed to extract
      cd.writeUInt16LE(entry.flags, 8); // General purpose bit flag
      cd.writeUInt16LE(entry.compMethod, 10); // Compression method
      cd.writeUInt16LE(entry.modTime, 12); // Last mod file time
      cd.writeUInt16LE(entry.modDate, 14); // Last mod file date
      cd.writeUInt32LE(entry.crc32, 16); // CRC-32
      cd.writeUInt32LE(entry.compSize, 20); // Compressed size
      cd.writeUInt32LE(entry.uncompSize, 24); // Uncompressed size
      cd.writeUInt16LE(entry.fileNameLen, 28); // File name length
      cd.writeUInt16LE(entry.extraLen, 30); // Extra field length
      cd.writeUInt16LE(0, 32); // File comment length
      cd.writeUInt16LE(0, 34); // Disk number start
      cd.writeUInt16LE(0, 36); // Internal file attributes
      const isDir = entry.fileName.endsWith("/");
      cd.writeUInt32LE(isDir ? 0x10 : 0x81a40000, 38); // External file attributes
      cd.writeUInt32LE(entry.offset, 42); // Relative offset of local header

      buf.copy(cd, 46, entry.offset + 30, entry.offset + 30 + entry.fileNameLen);
      if (entry.extraLen > 0) {
        buf.copy(
          cd,
          46 + entry.fileNameLen,
          entry.offset + 30 + entry.fileNameLen,
          entry.offset + 30 + entry.fileNameLen + entry.extraLen,
        );
      }
      cdBuffers.push(cd);
    }

    const cdSize = cdBuffers.reduce((sum, b) => sum + b.length, 0);
    const cdOffset = lastValidDataEnd;

    // Build EOCD
    const eocd = Buffer.alloc(22);
    eocd.writeUInt32LE(0x06054b50, 0); // PK\x05\x06 signature
    eocd.writeUInt16LE(0, 4); // Number of this disk
    eocd.writeUInt16LE(0, 6); // Disk where central directory starts
    eocd.writeUInt16LE(entries.length, 8); // Number of central directory records on this disk
    eocd.writeUInt16LE(entries.length, 10); // Total number of central directory records
    eocd.writeUInt32LE(cdSize, 12); // Size of central directory
    eocd.writeUInt32LE(cdOffset, 16); // Offset of start of central directory
    eocd.writeUInt16LE(0, 20); // ZIP file comment length

    const repaired = Buffer.concat([
      buf.subarray(0, lastValidDataEnd),
      ...cdBuffers,
      eocd,
    ]);

    // 6. Write repaired candidate to temporary file and perform full semantic validation
    tempRepairedPath = `${filePath}.repair.tmp`;
    fs.writeFileSync(tempRepairedPath, repaired);

    const candBuf = fs.readFileSync(tempRepairedPath);
    if (
      candBuf.length < 22 ||
      candBuf.length !== repaired.length ||
      candBuf.readUInt32LE(0) !== 0x04034b50 ||
      candBuf.readUInt32LE(candBuf.length - 22) !== 0x06054b50
    ) {
      try {
        fs.unlinkSync(tempRepairedPath);
      } catch {}
      return false;
    }

    // Full semantic verification on candidate buffer directly
    const candEntries = parseCentralDirectoryEntries(candBuf);
    if (!candEntries || !validateHealedZipInProcess(candBuf, candEntries)) {
      try {
        fs.unlinkSync(tempRepairedPath);
      } catch {}
      return false;
    }

    // Atomic replacement only after full candidate validation passes
    fs.renameSync(tempRepairedPath, filePath);
    tempRepairedPath = null;

    return true;
  } catch {
    if (tempRepairedPath) {
      try {
        fs.unlinkSync(tempRepairedPath);
      } catch {}
    }
    return false;
  }
}

/**
 * Checks if a filename is a canonical EPUB.
 * Optionally validates the physical file content if filePath is provided.
 */
export function isCanonicalEpub(filename: string, filePath?: string): boolean {
  if (!filename) return false;
  const ext = path.extname(filename).toLowerCase();
  const base = path.basename(filename);
  if (ext !== ".epub" || base.startsWith(".") || base.startsWith("._")) {
    return false;
  }
  if (filePath && fs.existsSync(filePath)) {
    return validateEpubContent(filePath).valid;
  }
  return true;
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

export interface ExtractedEpubMetadata {
  title?: string;
  author?: string;
  description?: string;
  language?: string;
}

/**
 * Extracts embedded metadata (title, author, description, language) directly from an EPUB container.
 * Inspects META-INF/container.xml and the rootfile OPF XML without depending on filename heuristics.
 */
export function extractEpubMetadata(filePath: string): ExtractedEpubMetadata {
  try {
    if (!fs.existsSync(filePath)) return {};
    const stat = fs.statSync(filePath);
    if (stat.size <= 0 || stat.size >= 256 * 1024 * 1024) return {};

    const execOpts = {
      encoding: "utf8" as const,
      timeout: 15000,
      maxBuffer: 16 * 1024 * 1024,
    };

    // 1. Locate the OPF rootfile path via container.xml
    let containerXml = "";
    const bsdtar = spawnSync(
      getBsdtarPath(),
      ["-xOf", filePath, "META-INF/container.xml"],
      execOpts,
    );
    if (bsdtar.status === 0 && bsdtar.stdout) {
      containerXml = bsdtar.stdout;
    } else {
      const unzip = spawnSync(
        getUnzipPath(),
        ["-p", filePath, "META-INF/container.xml"],
        execOpts,
      );
      if ((unzip.status === 0 || unzip.status === 1) && unzip.stdout) {
        containerXml = unzip.stdout;
      }
    }

    let opfPath = "content.opf";
    if (containerXml) {
      const match = containerXml.match(/full-path=["']([^"']+)["']/i);
      if (match && match[1]) {
        opfPath = match[1].trim();
      }
    }

    // 2. Read OPF XML content
    let opfXml = "";
    const bsdtarOpf = spawnSync(
      getBsdtarPath(),
      ["-xOf", filePath, opfPath],
      execOpts,
    );
    if (bsdtarOpf.status === 0 && bsdtarOpf.stdout) {
      opfXml = bsdtarOpf.stdout;
    } else {
      const unzipOpf = spawnSync(
        getUnzipPath(),
        ["-p", filePath, opfPath],
        execOpts,
      );
      if ((unzipOpf.status === 0 || unzipOpf.status === 1) && unzipOpf.stdout) {
        opfXml = unzipOpf.stdout;
      }
    }

    if (!opfXml && opfPath !== "content.opf") {
      const alt = spawnSync(
        getBsdtarPath(),
        ["-xOf", filePath, "content.opf"],
        execOpts,
      );
      if (alt.status === 0 && alt.stdout) opfXml = alt.stdout;
    }
    if (!opfXml && opfPath !== "OEBPS/content.opf") {
      const alt2 = spawnSync(
        getBsdtarPath(),
        ["-xOf", filePath, "OEBPS/content.opf"],
        execOpts,
      );
      if (alt2.status === 0 && alt2.stdout) opfXml = alt2.stdout;
    }

    if (!opfXml) return {};

    const cleanTag = (str: string) =>
      cleanString(str.replace(/<[^>]+>/g, "")).trim();

    let title: string | undefined;
    const titleMatch = opfXml.match(/<dc:title[^>]*>([\s\S]*?)<\/dc:title>/i);
    if (titleMatch && titleMatch[1]) {
      const t = cleanTag(titleMatch[1]);
      if (t) title = t;
    }

    let author: string | undefined;
    const creatorMatch = opfXml.match(/<dc:creator[^>]*>([\s\S]*?)<\/dc:creator>/i);
    if (creatorMatch && creatorMatch[1]) {
      const a = cleanTag(creatorMatch[1]);
      if (a) author = a;
    }

    let description: string | undefined;
    const descMatch = opfXml.match(/<dc:description[^>]*>([\s\S]*?)<\/dc:description>/i);
    if (descMatch && descMatch[1]) {
      const d = cleanTag(descMatch[1]);
      if (d) description = d;
    }

    let language: string | undefined;
    const langMatch = opfXml.match(/<dc:language[^>]*>([\s\S]*?)<\/dc:language>/i);
    if (langMatch && langMatch[1]) {
      const l = cleanTag(langMatch[1]);
      if (l) language = l;
    }

    return { title, author, description, language };
  } catch {
    return {};
  }
}

// ---------------------------------------------------------------------------
// 7. Safe Error Handling
// ---------------------------------------------------------------------------

/**
 * Creates an Undici dispatcher whose connector never performs DNS. The original
 * hostname remains in the URL, so HTTP Host and TLS SNI/certificate semantics
 * are preserved, while socket lookup is limited to the already validated DNS
 * snapshot for this redirect hop.
 */
function createBoundDispatcher(
  parsed: URL,
  addresses: ResolvedAddress[],
): Agent {
  let nextAddress = 0;
  const lookup = (
    _hostname: string,
    lookupOptions: { all?: boolean; family?: number },
    callback: (error: Error | null, address?: any, family?: number) => void,
  ) => {
    const candidates = lookupOptions?.family
      ? addresses.filter((address) => address.family === lookupOptions.family)
      : addresses;
    if (candidates.length === 0) {
      callback(new Error(`No validated address for requested address family`));
      return;
    }
    if (lookupOptions?.all) {
      callback(null, candidates);
      return;
    }
    const selected = candidates[nextAddress++ % candidates.length];
    callback(null, selected.address, selected.family);
  };

  const connector = buildConnector({ lookup } as any);
  return new Agent({
    connect(connectOptions: any, callback: any) {
      connector(
        {
          ...connectOptions,
          // Undici uses servername for TLS verification/SNI. The URL hostname
          // is deliberately retained; only the connector's lookup is pinned.
          servername: parsed.hostname,
        },
        callback,
      );
    },
    connections: Math.max(1, addresses.length),
    pipelining: 0,
  } as any);
}

/**
 * Performs a network fetch with strict SSRF validation on the initial URL AND all redirect hops.
 * Uses manual redirect handling (redirect: 'manual') to intercept and validate every Location header.
 */
export async function safeFetchWithSsrf(
  targetUrl: string,
  init: RequestInit = {},
  maxRedirects = 5,
  options: ValidateUrlOptions = {},
): Promise<Response> {
  let currentUrl = targetUrl;
  let remaining = maxRedirects;

  // Validate proxy if specified
  const proxyOption = (init as any)?.proxy;
  if (proxyOption) {
    const proxyStr = String(proxyOption);
    const configuredProxy =
      process.env.HTTP_PROXY ||
      process.env.HTTPS_PROXY ||
      "http://127.0.0.1:7890";
    const allowedProxies = [
      configuredProxy,
      "http://127.0.0.1:7890",
      ...(options.allowedProxyUrls || []),
    ].map((p) => p.toLowerCase().replace(/\/$/, ""));

    const normalizedProxy = proxyStr.toLowerCase().replace(/\/$/, "");
    if (!allowedProxies.includes(normalizedProxy)) {
      const proxyCheck = await validateUrlForSSRF(proxyStr, {
        allowProxyBypass: false,
      });
      if (!proxyCheck.safe) {
        throw new Error(
          `SSRF guard blocked proxy target: ${proxyCheck.error || "Forbidden proxy"}`,
        );
      }
    }
  }

  while (true) {
    const ssrfCheck = await validateUrlForSSRF(currentUrl, options);
    if (!ssrfCheck.safe) {
      throw new Error(
        `SSRF guard blocked target: ${ssrfCheck.error || "Forbidden target"}`,
      );
    }

    let parsed: URL;
    try {
      parsed = new URL(currentUrl);
    } catch (urlErr: any) {
      throw new Error(`Invalid URL target: ${urlErr?.message || urlErr}`);
    }
    const hostIsIp = net.isIP(normalizeIpString(parsed.hostname));
    const fetchOpts: any = {
      ...init,
      redirect: init.redirect === "error" ? "error" : "manual",
    };

    // IP binding uses a supported dispatcher/connector rather than replacing
    // the URL hostname with an IP literal. This keeps Host and TLS SNI intact.
    if (
      options.bindIp !== false &&
      !hostIsIp &&
      ssrfCheck.resolvedAddresses?.length
    ) {
      const headers = new Headers(init.headers || {});
      if (!headers.has("host")) headers.set("host", parsed.host);
      fetchOpts.headers = headers;
      fetchOpts.dispatcher = createBoundDispatcher(
        parsed,
        ssrfCheck.resolvedAddresses,
      );
      if (parsed.protocol === "https:") {
        fetchOpts.tls = {
          ...(fetchOpts.tls || {}),
          serverName: parsed.hostname,
        };
      }
    }

    const res = await fetch(currentUrl, fetchOpts);
    try {
      Object.defineProperty(res, "url", {
        value: currentUrl,
        configurable: true,
      });
    } catch {
      // ignore
    }

    if (res.status >= 300 && res.status < 400) {
      if (init.redirect === "error") {
        throw new Error(
          `Redirect blocked: request specified redirect: "error" (status ${res.status})`,
        );
      }
      if (init.redirect === "manual") {
        return res;
      }
      const loc = res.headers.get("location");
      if (!loc) {
        throw new Error(`HTTP ${res.status} redirect without Location header`);
      }
      if (remaining <= 0) {
        throw new Error("Too many redirects (exceeded limit of 5)");
      }
      remaining--;
      try {
        currentUrl = new URL(loc, currentUrl).href;
      } catch (redirectErr: any) {
        throw new Error(
          `Invalid redirect location URL: ${redirectErr?.message || redirectErr}`,
        );
      }
      continue;
    }

    return res;
  }
}
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

  // Remove filesystem paths (e.g. /Users/ospeto/..., /tmp/..., C:\...)
  let sanitized = rawMsg
    .replace(/(?:\/[a-zA-Z0-9._-]+)+/g, "[path]")
    .replace(/[a-zA-Z]:\\[a-zA-Z0-9._\-\\]+/g, "[path]")
    .replace(/at\s+.*\(.*:[0-9]+:[0-9]+\)/g, "") // Stack trace fragments
    .trim();

  // Strip token/key patterns
  sanitized = sanitized.replace(
    /(token|key|secret)=[a-zA-Z0-9_-]+/gi,
    "$1=[REDACTED]",
  );

  if (sanitized.length > 300) {
    sanitized = sanitized.substring(0, 300) + "...";
  }

  return sanitized || "Operation failed";
}
