/**
 * uploader/koplugin.ts
 *
 * KOReader plugin generator.
 *
 * Builds a `.koplugin` archive (a ZIP whose single root folder is
 * `lighthouse.koplugin/`, the layout KOReader's PluginLoader requires: a
 * directory ending in `.koplugin` holding `main.lua` and `_meta.lua`) from the
 * repo-tracked template in `uploader/koplugin-template/` plus the current
 * server settings.
 *
 * Design constraints:
 * - Credentials are never stored in the template. `lighthouse_config.lua` is
 *   rendered per download from the live environment and only ever lives inside
 *   the returned ZIP bytes; it is never written to a repo path, a log line, or
 *   a URL query string.
 * - The base URL is derived from the request that asked for the download (with
 *   X-Forwarded-* honoured only for the trusted loopback tunnel), so a download
 *   started from the LAN yields a LAN-configured plugin and one started from
 *   the WAN tunnel yields a WAN-configured plugin.
 * - The archive is written in-process (stored entries) so generation does not
 *   depend on a `zip` binary being on launchd's PATH.
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

/** Directory name KOReader requires when the archive is unpacked into `koreader/plugins/`. */
export const KOPLUGIN_DIR_NAME = "lighthouse.koplugin";

/** Name offered to the browser for the generated archive. */
export const KOPLUGIN_DOWNLOAD_FILENAME = "lighthouse.koplugin";

/** Version stamped into the generated configuration. */
export const KOPLUGIN_VERSION = "1.15.0";

/** Per-socket-operation timeout for JSON/OPDS requests, in seconds. */
export const KOPLUGIN_REQUEST_BLOCK_TIMEOUT = 10;

/**
 * Whole-request budget for JSON/OPDS requests, in seconds.
 *
 * 90s rather than the old 40s: the first catalog page over the WAN tunnel on
 * slow Wi-Fi can legitimately take much longer than an API call, and a request
 * budget that expires mid-transfer turns a slow connection into a failed browse.
 */
export const KOPLUGIN_REQUEST_TOTAL_TIMEOUT = 90;

/** Per-socket-operation timeout for EPUB downloads, in seconds. */
export const KOPLUGIN_DOWNLOAD_BLOCK_TIMEOUT = 15;

/** Whole-request budget for EPUB downloads, in seconds. */
export const KOPLUGIN_DOWNLOAD_TOTAL_TIMEOUT = 300;

/** Committed template sources. Contains no credentials. */
export const KOPLUGIN_TEMPLATE_DIR = path.join(
  import.meta.dir,
  "koplugin-template",
);

/** Generated configuration file name inside the plugin folder. */
export const KOPLUGIN_CONFIG_FILE = "lighthouse_config.lua";

/** Default catalog page size baked into the generated plugin. */
export const KOPLUGIN_DEFAULT_PAGE_SIZE = 40;

export interface KopluginConfigOptions {
  /** Server origin the device should talk to, e.g. "http://192.168.31.15:8086". */
  baseUrl: string;
  /** Current server API key. Empty string when the server has none configured. */
  apiKey?: string;
  /** Catalog entries per page. */
  pageSize?: number;
  /** ISO timestamp of generation, for the on-device Connection screen. */
  generatedAt?: string;
}

export interface KopluginSettings {
  baseUrl: string;
  apiKey: string;
  pageSize: number;
  generatedAt: string;
  pluginVersion: string;
  requestBlockTimeout: number;
  requestTotalTimeout: number;
  downloadBlockTimeout: number;
  downloadTotalTimeout: number;
}

export interface KopluginZipEntry {
  /** Path relative to the archive root, using forward slashes. */
  name: string;
  data: Buffer;
}

/**
 * Validates and normalizes a server origin for embedding in the plugin.
 *
 * Only plain origins are accepted: no credentials, no query string, no
 * fragment, no sub-path. Anything else is a configuration mistake we refuse to
 * ship onto a device.
 */
export function normalizeBaseUrl(raw: string | null | undefined): string | null {
  if (typeof raw !== "string") return null;
  const trimmed = raw.trim();
  if (!trimmed) return null;
  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    return null;
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return null;
  if (parsed.username || parsed.password) return null;
  if (parsed.search || parsed.hash) return null;
  if (parsed.pathname !== "/" && parsed.pathname !== "") return null;
  return parsed.origin;
}

const LOOPBACK_HOSTS = new Set(["127.0.0.1", "localhost", "::1", "[::1]"]);

/** Returns true when a URL hostname points at the local loopback interface. */
export function isLoopbackHostname(hostname: string | null | undefined): boolean {
  if (typeof hostname !== "string") return false;
  const clean = hostname.trim().toLowerCase();
  return LOOPBACK_HOSTS.has(clean) || clean.startsWith("127.");
}

/**
 * Returns the host's primary non-internal IPv4 LAN address, or null if offline.
 * Excludes loopback (`127.*`) and link-local (`169.254.*`) addresses.
 */
export function detectLanIpv4(): string | null {
  const nets = os.networkInterfaces();
  for (const name of Object.keys(nets)) {
    const addrs = nets[name];
    if (!addrs) continue;
    for (const addr of addrs) {
      if (addr.internal) continue;
      const family = String(addr.family);
      if (family !== "IPv4" && family !== "4") continue;
      if (addr.address.startsWith("127.") || addr.address.startsWith("169.254.")) {
        continue;
      }
      return addr.address;
    }
  }
  return null;
}

/**
 * Resolves the origin a downloading client is using.
 *
 * X-Forwarded-* headers are only honoured when the request arrived from the
 * trusted loopback reverse tunnel, matching how the rest of the server decides
 * WAN vs LAN identity. When `allowLoopback === false` (used by `/api/koplugin/download`),
 * a loopback hostname like `127.0.0.1:8086` is rewritten to `LIGHTHOUSE_LAN_URL`
 * or the machine's LAN IPv4 so a Kindle never ends up calling itself.
 */
export function resolvePluginBaseUrl(
  req: Request,
  url: URL,
  options: {
    trustForwarded?: boolean;
    allowLoopback?: boolean;
    lanIpOverride?: string | null;
  } = {},
): string {
  const trustForwarded = options.trustForwarded === true;
  const socketProto = url.protocol.replace(/:$/, "") || "http";

  const firstHeaderValue = (name: string): string => {
    const raw = req.headers.get(name) || "";
    return raw.split(",")[0].trim();
  };

  const host = (trustForwarded ? firstHeaderValue("x-forwarded-host") || firstHeaderValue("host") : firstHeaderValue("host"))
    || url.host;
  const proto = (trustForwarded ? firstHeaderValue("x-forwarded-proto") || socketProto : socketProto);

  const resolved = normalizeBaseUrl(`${proto}://${host}`) || url.origin;
  if (options.allowLoopback === false) {
    try {
      const parsed = new URL(resolved);
      if (isLoopbackHostname(parsed.hostname)) {
        const envLan = normalizeBaseUrl(process.env.LIGHTHOUSE_LAN_URL);
        if (envLan) return envLan;
        const lanIp = options.lanIpOverride !== undefined ? options.lanIpOverride : detectLanIpv4();
        if (lanIp) {
          const portSuffix = parsed.port ? `:${parsed.port}` : "";
          return normalizeBaseUrl(`${parsed.protocol}//${lanIp}${portSuffix}`) || resolved;
        }
      }
    } catch {
      // Keep resolved fallback if URL parsing fails unexpectedly.
    }
  }
  return resolved;
}

/** Escapes a value for inclusion as a Lua string literal. */
export function luaStringLiteral(value: string): string {
  const escaped = String(value)
    .replace(/\\/g, "\\\\")
    .replace(/"/g, '\\"')
    .replace(/\r/g, "\\r")
    .replace(/\n/g, "\\n");
  return `"${escaped}"`;
}

/** Renders a positive timeout, falling back when the value is unusable. */
function timeoutOr(raw: number | undefined, fallback: number): number {
  const value = Number(raw);
  if (!Number.isFinite(value) || value <= 0) return fallback;
  return Math.trunc(value);
}

/**
 * Renders the per-download `lighthouse_config.lua`.
 *
 * The output is a pure data module: no logic, no environment lookups, so the
 * device cannot accidentally fall back to a different server. The timeout
 * fields are the ones `lighthouse_client.lua` reads; omitting them would leave
 * the client on its own defaults with no way to tune a slow link.
 */
export function renderConfigLua(settings: KopluginSettings): string {
  const lines = [
    "--[[--",
    "LightHouse plugin configuration.",
    "",
    "Generated by the LightHouse server for this download. It contains the",
    "server origin and API key this device should use; keep the file private.",
    "Regenerate the plugin from Guide -> KOReader plugin after changing the",
    "server address or key, then replace koreader/plugins/lighthouse.koplugin.",
    "--]]",
    "",
    "return {",
    `    base_url = ${luaStringLiteral(settings.baseUrl)},`,
    `    api_key = ${luaStringLiteral(settings.apiKey)},`,
    `    page_size = ${Math.trunc(settings.pageSize)},`,
    `    plugin_version = ${luaStringLiteral(settings.pluginVersion)},`,
    `    generated_at = ${luaStringLiteral(settings.generatedAt)},`,
    `    request_block_timeout = ${timeoutOr(settings.requestBlockTimeout, KOPLUGIN_REQUEST_BLOCK_TIMEOUT)},`,
    `    request_total_timeout = ${timeoutOr(settings.requestTotalTimeout, KOPLUGIN_REQUEST_TOTAL_TIMEOUT)},`,
    `    download_block_timeout = ${timeoutOr(settings.downloadBlockTimeout, KOPLUGIN_DOWNLOAD_BLOCK_TIMEOUT)},`,
    `    download_total_timeout = ${timeoutOr(settings.downloadTotalTimeout, KOPLUGIN_DOWNLOAD_TOTAL_TIMEOUT)},`,
    "}",
    "",
  ];
  return lines.join("\n");
}

/**
 * Reads the committed template into archive entries.
 *
 * Names are returned relative to the template root with forward slashes so the
 * archive layout is identical on every platform.
 */
export function readTemplateEntries(
  templateDir: string = KOPLUGIN_TEMPLATE_DIR,
): KopluginZipEntry[] {
  const entries: KopluginZipEntry[] = [];

  const walk = (dir: string, prefix: string): void => {
    const dirents = fs.readdirSync(dir, { withFileTypes: true });
    for (const dirent of dirents) {
      if (dirent.name.startsWith(".")) continue;
      const absolute = path.join(dir, dirent.name);
      const relative = prefix ? `${prefix}/${dirent.name}` : dirent.name;
      if (dirent.isDirectory()) {
        walk(absolute, relative);
        continue;
      }
      if (!dirent.isFile()) continue;
      entries.push({ name: relative, data: fs.readFileSync(absolute) });
    }
  };

  walk(templateDir, "");
  entries.sort((a, b) => a.name.localeCompare(b.name));
  return entries;
}

const CRC32_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let i = 0; i < 256; i += 1) {
    let c = i;
    for (let k = 0; k < 8; k += 1) {
      c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    }
    table[i] = c >>> 0;
  }
  return table;
})();

/** Standard CRC-32 (IEEE 802.3) used by the ZIP central directory. */
export function crc32(buffer: Buffer): number {
  let crc = 0xffffffff;
  for (let i = 0; i < buffer.length; i += 1) {
    crc = CRC32_TABLE[(crc ^ buffer[i]) & 0xff] ^ (crc >>> 8);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

/** DOS date/time for 2000-01-01 00:00:00, so archives are byte-reproducible. */
const DOS_DATE = ((2000 - 1980) << 9) | (1 << 5) | 1;
const DOS_TIME = 0;

/**
 * Writes a store-only (uncompressed) ZIP archive.
 *
 * Stored entries avoid a zlib dependency and are readable by every unzip
 * implementation users will reach for (Finder, Explorer, `unzip`, `bsdtar`,
 * KOReader's own archiver). The payload is small Lua text either way.
 */
export function buildStoredZip(entries: KopluginZipEntry[]): Buffer {
  const chunks: Buffer[] = [];
  const central: Buffer[] = [];
  let offset = 0;

  for (const entry of entries) {
    const nameBytes = Buffer.from(entry.name, "utf8");
    const data = entry.data;
    const checksum = crc32(data);

    const localHeader = Buffer.alloc(30);
    localHeader.writeUInt32LE(0x04034b50, 0);
    localHeader.writeUInt16LE(20, 4); // version needed to extract
    localHeader.writeUInt16LE(0x0800, 6); // UTF-8 filename flag
    localHeader.writeUInt16LE(0, 8); // method: stored
    localHeader.writeUInt16LE(DOS_TIME, 10);
    localHeader.writeUInt16LE(DOS_DATE, 12);
    localHeader.writeUInt32LE(checksum, 14);
    localHeader.writeUInt32LE(data.length, 18);
    localHeader.writeUInt32LE(data.length, 22);
    localHeader.writeUInt16LE(nameBytes.length, 26);
    localHeader.writeUInt16LE(0, 28);

    chunks.push(localHeader, nameBytes, data);

    const centralHeader = Buffer.alloc(46);
    centralHeader.writeUInt32LE(0x02014b50, 0);
    centralHeader.writeUInt16LE(20, 4); // version made by
    centralHeader.writeUInt16LE(20, 6); // version needed
    centralHeader.writeUInt16LE(0x0800, 8);
    centralHeader.writeUInt16LE(0, 10); // method: stored
    centralHeader.writeUInt16LE(DOS_TIME, 12);
    centralHeader.writeUInt16LE(DOS_DATE, 14);
    centralHeader.writeUInt32LE(checksum, 16);
    centralHeader.writeUInt32LE(data.length, 20);
    centralHeader.writeUInt32LE(data.length, 24);
    centralHeader.writeUInt16LE(nameBytes.length, 28);
    centralHeader.writeUInt16LE(0, 30); // extra field length
    centralHeader.writeUInt16LE(0, 32); // comment length
    centralHeader.writeUInt16LE(0, 34); // disk number start
    centralHeader.writeUInt16LE(0, 36); // internal attributes
    // File mode 0644 in the high 16 bits of the external attributes field.
    // The shift is coerced back to unsigned because JS bitwise ops are signed.
    centralHeader.writeUInt32LE((0o100644 << 16) >>> 0, 38); // external attributes
    centralHeader.writeUInt32LE(offset, 42);

    central.push(centralHeader, nameBytes);

    offset += localHeader.length + nameBytes.length + data.length;
  }

  const centralBytes = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(0, 4);
  end.writeUInt16LE(0, 6);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(centralBytes.length, 12);
  end.writeUInt32LE(offset, 16);
  end.writeUInt16LE(0, 20);

  return Buffer.concat([...chunks, centralBytes, end]);
}

/**
 * Builds the complete plugin archive for one download.
 *
 * @returns the archive bytes plus the archive-relative entry names, so callers
 *          and tests can assert the KOReader-required layout without unzipping.
 */
export function generateKoplugin(options: KopluginConfigOptions): {
  zip: Buffer;
  settings: KopluginSettings;
  entryNames: string[];
} {
  const baseUrl = normalizeBaseUrl(options.baseUrl);
  if (!baseUrl) {
    throw new Error(`Invalid LightHouse base URL for plugin generation: ${options.baseUrl}`);
  }

  const settings: KopluginSettings = {
    baseUrl,
    apiKey: options.apiKey ?? "",
    pageSize: options.pageSize ?? KOPLUGIN_DEFAULT_PAGE_SIZE,
    generatedAt: options.generatedAt ?? new Date().toISOString(),
    pluginVersion: KOPLUGIN_VERSION,
    requestBlockTimeout: KOPLUGIN_REQUEST_BLOCK_TIMEOUT,
    requestTotalTimeout: KOPLUGIN_REQUEST_TOTAL_TIMEOUT,
    downloadBlockTimeout: KOPLUGIN_DOWNLOAD_BLOCK_TIMEOUT,
    downloadTotalTimeout: KOPLUGIN_DOWNLOAD_TOTAL_TIMEOUT,
  };

  const template = readTemplateEntries();
  if (template.length === 0) {
    throw new Error(`KOReader plugin template is empty: ${KOPLUGIN_TEMPLATE_DIR}`);
  }

  const entries: KopluginZipEntry[] = [];
  for (const entry of template) {
    const isConfig = entry.name === KOPLUGIN_CONFIG_FILE;
    entries.push({
      name: `${KOPLUGIN_DIR_NAME}/${entry.name}`,
      data: isConfig
        ? Buffer.from(renderConfigLua(settings), "utf8")
        : entry.data,
    });
  }

  // A generated archive must always carry a config, even if the template copy
  // was removed, otherwise the device would silently fall back to the template's
  // empty (unconfigured) values.
  if (!entries.some((entry) => entry.name === `${KOPLUGIN_DIR_NAME}/${KOPLUGIN_CONFIG_FILE}`)) {
    entries.push({
      name: `${KOPLUGIN_DIR_NAME}/${KOPLUGIN_CONFIG_FILE}`,
      data: Buffer.from(renderConfigLua(settings), "utf8"),
    });
    entries.sort((a, b) => a.name.localeCompare(b.name));
  }

  return {
    zip: buildStoredZip(entries),
    settings,
    entryNames: entries.map((entry) => entry.name),
  };
}

/** Response headers for the generated archive. */
export function kopluginDownloadHeaders(): Record<string, string> {
  return {
    "Content-Type": "application/zip",
    "Content-Disposition": `attachment; filename="${KOPLUGIN_DOWNLOAD_FILENAME}"`,
    "Content-Encoding": "identity",
    "Cache-Control": "no-store, no-cache, must-revalidate, private",
    Pragma: "no-cache",
    "X-Content-Type-Options": "nosniff",
  };
}

/**
 * Reads the current server API key, if any. Never logged by callers.
 *
 * Scoped-key trade-off (deliberate, and why this stays on the global key):
 * the generated archive must embed a working credential because a device cannot
 * be taught the key without a QR/typing flow. A `READING_SCOPED_KEYS` entry
 * with `read` scope would be the least-privilege option, but a *new* key cannot
 * be minted per download: the scoped registry is operator configuration read at
 * startup, so writing a fresh key into it would be a security-state mutation on
 * a read-only route (and would have to be revoked by hand afterwards). Embedding
 * an operator-provided `read` key would work, yet it would silently turn a
 * one-key install into a two-key install and still hand every device the same
 * long-lived secret. So the route keeps refusing scoped keys
 * (`code: "insufficient_scope"`) rather than letting a limited credential trade
 * itself for the master key, and the plugin keeps using the global
 * `READING_API_KEY` exactly as the web app does. Scope is left intact - no
 * permission is widened for the plugin.
 */
export function resolveApiKeyFromEnv(
  env: Record<string, string | undefined> = process.env,
): string {
  const key = env.READING_API_KEY ?? "";
  return typeof key === "string" ? key.trim() : "";
}
