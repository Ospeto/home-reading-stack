import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { spawnSync } from "node:child_process";
import crypto from "node:crypto";
import { Database } from "bun:sqlite";
import {
  sanitizeMetadata,
  extractSeries,
  extractVolumeNumber,
  normalizeTitleForDedup,
  isSameBookAsync,
  normalizeFormat,
  searchUniversalMetadata,
  applyMetadataToCalibre,
  isCommentsEmpty,
  sanitizeSynopsis,
  extractEpubDescription,
  autoEnrichBookSynopsis,
} from "./scraper";
import { isArchiveFile, unpackArchive, isCanonicalEpub } from "./archive";
import { extractUrlFromText, ingestArticleFromUrl, generateTypographicCover } from "./article";
import {
  isLnoriUrl,
  ingestLnoriSeries,
  type LnoriProgressEvent,
  formatLnoriProgress,
} from "./lnori";
import {
  isElscioneUrl,
  ingestElscioneSeries,
  formatElscioneProgress,
} from "./elscione";
import { generateMetadataFilename } from "./filename";
import { getJobQueue } from "./jobs";
import {
  validateEpubContent,
  repairTruncatedEpub,
  extractEpubMetadata,
  safeFetchWithSsrf,
  getBsdtarPath,
  getUnzipPath,
} from "./security";
import {
  runDuplicateCleaner,
  type CleanDuplicatesOptions,
  type CleanDuplicatesReport,
} from "../scripts/clean-duplicates";
import {
  evaluateJunkGate,
  moveToQuarantine,
  extractSeriesWithJev,
  cleanAuthorWithJev,
  resolveBookLanguageAndTags,
  classifyBookSourceCategoryDeterministic,
  containsBurmese,
} from "./jev-shelf";

let _duplicateCleanerRunner: (options: CleanDuplicatesOptions) => Promise<CleanDuplicatesReport> = runDuplicateCleaner;
export function setDuplicateCleanerRunnerForTest(runner: typeof runDuplicateCleaner | null) {
  _duplicateCleanerRunner = runner || runDuplicateCleaner;
}

export function getDropDir(): string {
  if (process.env.BOOKS_DROP_DIR) return process.env.BOOKS_DROP_DIR;
  const home = process.env.HOME || os.homedir();
  const dir = path.join(home, "Books_Drop");
  try {
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
    return dir;
  } catch {
    const fallback = path.join(os.tmpdir(), "Books_Drop");
    if (!fs.existsSync(fallback)) {
      fs.mkdirSync(fallback, { recursive: true });
    }
    return fallback;
  }
}

export const LIGHTHOUSE_ROOT =
  process.env.LIGHTHOUSE_ROOT ||
  path.resolve((import.meta as { dir?: string }).dir || process.cwd(), "..");

const SERVER_URL = process.env.CALIBRE_SERVER_URL || "http://127.0.0.1:8088";
const ENV_PATH =
  process.env.ENV_PATH ||
  (fs.existsSync(path.resolve((import.meta as { dir?: string }).dir || process.cwd(), ".env"))
    ? path.resolve((import.meta as { dir?: string }).dir || process.cwd(), ".env")
    : path.resolve(LIGHTHOUSE_ROOT, ".env"));

export function getCoverCacheDir(): string {
  if (process.env.COVER_CACHE_DIR) return process.env.COVER_CACHE_DIR;
  return path.resolve(
    (import.meta as any).dir || process.cwd(),
    "cache",
    "covers",
  );
}

export function getCacheDbPath(): string {
  if (process.env.CACHE_DB_PATH || process.env.JOBS_DB_PATH) {
    const raw = (process.env.CACHE_DB_PATH || process.env.JOBS_DB_PATH)!;
    return path.isAbsolute(raw) ? raw : path.resolve(LIGHTHOUSE_ROOT, raw);
  }
  const defaultPath = path.resolve(
    LIGHTHOUSE_ROOT,
    "uploader",
    "cache.db",
  );
  try {
    const dir = path.dirname(defaultPath);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
    return defaultPath;
  } catch {
    const fallbackDir = path.join(os.tmpdir(), "uploader_cache");
    if (!fs.existsSync(fallbackDir)) {
      fs.mkdirSync(fallbackDir, { recursive: true });
    }
    return path.join(fallbackDir, "cache.db");
  }
}

let _cacheDbInstance: Database | null = null;
export function getCacheDb(): Database {
  if (!_cacheDbInstance) {
    const dbPath = getCacheDbPath();
    _cacheDbInstance = new Database(dbPath);
    _cacheDbInstance.run("PRAGMA journal_mode = WAL;");
    _cacheDbInstance.run("PRAGMA busy_timeout = 5000;");
    _cacheDbInstance.run(`
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
    _cacheDbInstance.run(
      `CREATE INDEX IF NOT EXISTS idx_file_hashes_hash ON file_hashes(hash);`,
    );
  }
  return _cacheDbInstance;
}
export function getKosyncDbPath(): string {
  if (process.env.KOSYNC_DB_PATH) {
    return path.isAbsolute(process.env.KOSYNC_DB_PATH)
      ? process.env.KOSYNC_DB_PATH
      : path.resolve(LIGHTHOUSE_ROOT, process.env.KOSYNC_DB_PATH);
  }
  const home = process.env.HOME || os.homedir();
  return path.join(home, "kosync-server", "data", "koreader-sync.db");
}
const KOSYNC_DB_PATH = getKosyncDbPath();

export function getCalibredbPath(): string {
  if (process.env.CALIBREDB_PATH) return process.env.CALIBREDB_PATH;
  const probe = spawnSync("which", ["calibredb"], {
    encoding: "utf8",
    timeout: SUBPROCESS_TIMEOUT_MS,
    maxBuffer: SUBPROCESS_MAX_BUFFER,
  });
  throwOnSubprocessTimeout(probe, "which calibredb");
  if (probe.status === 0 && probe.stdout?.trim()) return probe.stdout.trim();
  const candidates = [
    "/opt/homebrew/bin/calibredb",
    "/usr/local/bin/calibredb",
    "/usr/bin/calibredb",
    "/Applications/calibre.app/Contents/MacOS/calibredb",
  ];
  for (const cand of candidates) {
    if (fs.existsSync(cand)) return cand;
  }
  return "calibredb";
}

export function getCalibreDbPath(): string {
  if (process.env.CALIBRE_DB_PATH) {
    return path.isAbsolute(process.env.CALIBRE_DB_PATH)
      ? process.env.CALIBRE_DB_PATH
      : path.resolve(LIGHTHOUSE_ROOT, process.env.CALIBRE_DB_PATH);
  }
  if (process.env.CALIBRE_LIBRARY_DIR) {
    const libDir = path.isAbsolute(process.env.CALIBRE_LIBRARY_DIR)
      ? process.env.CALIBRE_LIBRARY_DIR
      : path.resolve(LIGHTHOUSE_ROOT, process.env.CALIBRE_LIBRARY_DIR);
    return path.join(libDir, "metadata.db");
  }
  const home = process.env.HOME || os.homedir();
  return path.join(
    home,
    "Calibre Libraries",
    "Agent Library",
    "metadata.db",
  );
}
export function getCalibreLibraryDir(): string {
  if (process.env.CALIBRE_LIBRARY_DIR) {
    return path.isAbsolute(process.env.CALIBRE_LIBRARY_DIR)
      ? process.env.CALIBRE_LIBRARY_DIR
      : path.resolve(LIGHTHOUSE_ROOT, process.env.CALIBRE_LIBRARY_DIR);
  }
  return path.dirname(getCalibreDbPath());
}

export function getMangaDbPath(): string {
  if (process.env.MANGA_DB_PATH) {
    return path.isAbsolute(process.env.MANGA_DB_PATH)
      ? process.env.MANGA_DB_PATH
      : path.resolve(LIGHTHOUSE_ROOT, process.env.MANGA_DB_PATH);
  }
  const home = process.env.HOME || os.homedir();
  return path.join(home, "manga-processor", "manga.db");
}
const MANGA_DB_PATH = getMangaDbPath();
const PROXY_URL = "http://127.0.0.1:7890";
const WEB_UPLOADER_URL = "http://192.168.31.15:8086";
const CALIBRE_WEB_URL = "http://192.168.31.15:8088";
export const READING_WEBAPP_URL =
  process.env.READING_WEBAPP_URL || "https://reading-sg.wavypremium.xyz:8443";
export const KOSYNC_WAN_URL =
  process.env.KOSYNC_WAN_URL || "http://kosync-sg.wavypremium.xyz";
const MAX_TELEGRAM_FILE_SIZE = 20 * 1024 * 1024; // 20MB Telegram Bot API limit
export const ALLOWED_EXTS = [".epub", ".zip", ".rar", ".7z", ".tar"];
export const REJECTED_EXTS = [
  ".pdf",
  ".mobi",
  ".azw3",
  ".cbz",
  ".cbr",
  ".azw",
  ".fb2",
  ".djvu",
  ".txt",
  ".docx",
];

const INITIAL_BACKOFF_MS = 2000;
const MAX_BACKOFF_MS = 60000;
const POLL_TIMEOUT_SECONDS = 25;
const POLL_REQUEST_TIMEOUT_MS = 35000;
const SUBPROCESS_TIMEOUT_MS = 60_000;
const SUBPROCESS_MAX_BUFFER = 16 * 1024 * 1024;

// Lazy singleton cacheDb proxy for backward-compatible call-sites
// SAFETY: Proxy delegates Database methods to dynamically initialized Database instance
export const cacheDb = {
  run(...args: any[]) {
    return (getCacheDb().run as any)(...args);
  },
  query(...args: any[]) {
    return (getCacheDb().query as any)(...args);
  },
  prepare(...args: any[]) {
    return (getCacheDb().prepare as any)(...args);
  },
  close() {
    if (_cacheDbInstance) _cacheDbInstance.close();
  },
} as unknown as Database;

let _telegramBotToken: string = "";
export function getTelegramBotToken(): string {
  if (_telegramBotToken) return _telegramBotToken;
  if (process.env.TELEGRAM_BOT_TOKEN) {
    _telegramBotToken = process.env.TELEGRAM_BOT_TOKEN;
    return _telegramBotToken;
  }
  const envPath = process.env.ENV_PATH || ENV_PATH;
  if (fs.existsSync(envPath)) {
    try {
      const envContent = fs.readFileSync(envPath, "utf8");
      for (const line of envContent.split("\n")) {
        const trimmed = line.trim();
        if (trimmed.startsWith("TELEGRAM_BOT_TOKEN=")) {
          _telegramBotToken = trimmed.replace("TELEGRAM_BOT_TOKEN=", "").trim();
          return _telegramBotToken;
        }
      }
    } catch {}
  }
  return _telegramBotToken;
}

function log(msg: string) {
  const ts = new Date().toISOString().replace("T", " ").substring(0, 19);
  console.log(`[${ts}] [TelegramBot] ${msg}`);
}

function logError(msg: string, err?: any) {
  const ts = new Date().toISOString().replace("T", " ").substring(0, 19);
  console.error(`[${ts}] [TelegramBot] ERROR: ${msg}`, err || "");
}

function throwOnSubprocessTimeout(
  result: { error?: { code?: string; message?: string } },
  command: string,
): void {
  if (result.error?.code === "ETIMEDOUT") {
    throw new Error(`${command} timed out after ${SUBPROCESS_TIMEOUT_MS}ms`);
  }
}

export function getKOReaderBinary256(filePath: string): string | null {
  try {
    const stats = fs.statSync(filePath);
    const fd = fs.openSync(filePath, "r");
    try {
      const KOREADER_HASH_ALGO = "md5";
      const hasher = crypto.createHash(KOREADER_HASH_ALGO);
      const size = 1024;
      if (stats.size <= 256) {
        const buf = new Uint8Array(Math.max(1, stats.size));
        const bytesRead = fs.readSync(fd, buf, 0, buf.length, 0);
        if (bytesRead > 0) hasher.update(buf.subarray(0, bytesRead));
      } else {
        for (let i = -1; i <= 10; i++) {
          const offset = i === -1 ? 256 : 1024 * 4 ** i;
          if (offset >= stats.size) break;
          const buf = new Uint8Array(size);
          const bytesRead = fs.readSync(fd, buf, 0, size, offset);
          if (bytesRead > 0) hasher.update(buf.subarray(0, bytesRead));
        }
      }
      return hasher.digest("hex");
    } finally {
      fs.closeSync(fd);
    }
  } catch (_err) {
    void _err;
    return null;
  }
}

/**
 * Computes a content hash fingerprint from the EPUB's content.opf package identifier/UUID.
 * This guarantees that recompressed identical books match even if raw zip checksum differs.
 */
export function getEpubContentSignature(filePath: string): string | null {
  try {
    if (!fs.existsSync(filePath)) return null;

    // Archive Bounds: reject files reaching/exceeding 256MB or empty files (<256MB required)
    const stat = fs.statSync(filePath);
    if (stat.size <= 0 || stat.size >= 256 * 1024 * 1024) {
      return null;
    }

    const ARCHIVE_TIMEOUT_MS = 15000;
    const ARCHIVE_MAX_BUFFER = 16 * 1024 * 1024;
    const execOpts = {
      encoding: "utf8" as const,
      timeout: ARCHIVE_TIMEOUT_MS,
      maxBuffer: ARCHIVE_MAX_BUFFER,
    };

    // 1. Read META-INF/container.xml to locate the OPF rootfile
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

    // 2. Resolve OPF path
    let opfPath = "content.opf";
    if (containerXml) {
      const match = containerXml.match(/full-path=["']([^"']+)["']/i);
      if (match && match[1]) {
        opfPath = match[1].trim();
      }
    }

    // 3. Read OPF XML content
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

    // Fallbacks if specified opfPath was not found
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

    if (!opfXml) return null;

    // 4. Extract Package Identifier / UUID
    let identifier = "";

    // Pattern A: Match unique-identifier attribute in <package> and find corresponding <dc:identifier id="...">
    const uidMatch = opfXml.match(
      /<package[^>]+unique-identifier=["']([^"']+)["']/i,
    );
    if (uidMatch && uidMatch[1]) {
      const idAttr = uidMatch[1].trim();
      const allIdMatches = opfXml.matchAll(
        /<dc:identifier([^>]*)>([\s\S]*?)<\/dc:identifier>/gi,
      );
      for (const m of allIdMatches) {
        const attrs = m[1];
        const val = m[2].replace(/<[^>]+>/g, "").trim();
        const attrMatch = attrs.match(/id=["']([^"']+)["']/i);
        if (attrMatch && attrMatch[1].trim() === idAttr) {
          identifier = val;
          break;
        }
      }
    }

    // Pattern B: Look for UUID pattern inside any dc:identifier
    if (!identifier) {
      const uuidMatch = opfXml.match(
        /<dc:identifier[^>]*>[\s\S]*?(?:urn:uuid:)?([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12})[\s\S]*?<\/dc:identifier>/i,
      );
      if (uuidMatch && uuidMatch[1]) {
        identifier = uuidMatch[1].toLowerCase().trim();
      }
    }

    // Pattern C: Any non-empty dc:identifier
    if (!identifier) {
      const anyIdMatch = opfXml.match(
        /<dc:identifier[^>]*>([\s\S]*?)<\/dc:identifier>/i,
      );
      if (anyIdMatch && anyIdMatch[1]) {
        const candidate = anyIdMatch[1].replace(/<[^>]+>/g, "").trim();
        if (candidate.length > 3) {
          identifier = candidate;
        }
      }
    }

    // Pattern D: Core metadata fallback (title + author)
    if (!identifier) {
      const titleMatch = opfXml.match(
        /<dc:title[^>]*>([\s\S]*?)<\/dc:title>/i,
      );
      const creatorMatch = opfXml.match(
        /<dc:creator[^>]*>([\s\S]*?)<\/dc:creator>/i,
      );
      if (titleMatch && titleMatch[1]) {
        const t = titleMatch[1].replace(/<[^>]+>/g, "").trim().toLowerCase();
        const c = creatorMatch
          ? creatorMatch[1].replace(/<[^>]+>/g, "").trim().toLowerCase()
          : "";
        identifier = `meta:${t}:::${c}`;
      }
    }

    if (!identifier) return null;

    // Standardize and compute SHA-256 fingerprint
    const cleanId = identifier
      .replace(/^urn:uuid:/i, "")
      .replace(/[\s\-_]+/g, "")
      .toLowerCase();

    return crypto
      .createHash("sha256")
      .update(`epub-content-sig:${cleanId}`)
      .digest("hex");
  } catch (_err) {
    void _err;
    return null;
  }
}

function runCalibredb(args: string[]) {
  const env: any = { ...process.env };
  delete env.HTTP_PROXY;
  delete env.http_proxy;
  delete env.HTTPS_PROXY;
  delete env.https_proxy;
  delete env.ALL_PROXY;
  delete env.all_proxy;
  env.PATH =
    "/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:" + (env.PATH || "");

  const result = spawnSync(getCalibredbPath(), args, {
    encoding: "utf8",
    env,
    timeout: SUBPROCESS_TIMEOUT_MS,
    maxBuffer: SUBPROCESS_MAX_BUFFER,
  });
  throwOnSubprocessTimeout(result, "calibredb");
  return result;
}

function safeParseJson(str: string): any {
  if (!str) return null;
  const trimmed = str.trim();
  const startBracket = trimmed.indexOf("[");
  const endBracket = trimmed.lastIndexOf("]");
  if (startBracket !== -1 && endBracket !== -1 && endBracket > startBracket) {
    try {
      return JSON.parse(trimmed.substring(startBracket, endBracket + 1));
    } catch (err: any) {
      void err;
    }
  }
  const startBrace = trimmed.indexOf("{");
  const endBrace = trimmed.lastIndexOf("}");
  if (startBrace !== -1 && endBrace !== -1 && endBrace > startBrace) {
    try {
      return JSON.parse(trimmed.substring(startBrace, endBrace + 1));
    } catch (err: any) {
      void err;
    }
  }
  try {
    return JSON.parse(trimmed);
  } catch (err: any) {
    void err;
    return null;
  }
}

async function tgFetch(endpoint: string, options: any = {}) {
  const token = getTelegramBotToken();
  const url = `https://api.telegram.org/bot${token}/${endpoint}`;
  const timeoutMs = options.timeoutMs || 45000;
  const signal = options.signal || AbortSignal.timeout(timeoutMs);

  const fetchOpts: any = {
    ...options,
    signal,
    proxy: PROXY_URL,
  };
  delete fetchOpts.timeoutMs;
  return await safeFetchWithSsrf(url, fetchOpts);
}

async function sendMessage(
  chatId: number,
  text: string,
  parseMode: string = "",
  replyMarkup: any = null,
): Promise<number | null> {
  try {
    const body: any = { chat_id: chatId, text };
    if (parseMode) body.parse_mode = parseMode;
    if (replyMarkup) body.reply_markup = replyMarkup;
    const res = await tgFetch("sendMessage", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
      timeoutMs: 15000,
    });
    let data = (await res.json()) as any;
    if (data.ok && data.result?.message_id) {
      return data.result.message_id;
    }

    // Fallback 1: If keyboard / reply_markup caused BUTTON_DATA_INVALID or any 400 error
    if (!data.ok && replyMarkup && (data.error_code === 400 || (data.description && /button|markup|reply_markup/i.test(data.description)))) {
      logError(
        `sendMessage failed with reply_markup (${data.description}), retrying without reply_markup...`,
      );
      const noMarkupBody: any = { chat_id: chatId, text };
      if (parseMode) noMarkupBody.parse_mode = parseMode;
      const noMarkupRes = await tgFetch("sendMessage", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(noMarkupBody),
        timeoutMs: 15000,
      });
      data = (await noMarkupRes.json()) as any;
      if (data.ok && data.result?.message_id) {
        return data.result.message_id;
      }
    }

    // Fallback 2: Safe Telegram plain-text fallback (strips markdown entity formatting)
    if (
      !data.ok &&
      parseMode &&
      (data.error_code === 400 ||
        (data.description && /parse|entity|markdown/i.test(data.description)))
    ) {
      logError(
        `sendMessage failed with parseMode="${parseMode}" (${data.description}), retrying as plain text...`,
      );
      const fallbackBody: any = { chat_id: chatId, text };
      const retryRes = await tgFetch("sendMessage", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(fallbackBody),
        timeoutMs: 15000,
      });
      const retryData = (await retryRes.json()) as any;
      if (retryData.ok && retryData.result?.message_id) {
        return retryData.result.message_id;
      } else {
        logError(
          `sendMessage plain-text retry also failed: ${retryData.description}`,
        );
      }
    } else if (!data.ok) {
      logError(`sendMessage failed for chat ${chatId}: ${data.description}`);
    }
  } catch (err: any) {
    logError(`Failed to send message to chat ${chatId}: ${err.message}`);
  }
  return null;
}

async function editOrSendMessage(
  chatId: number,
  messageId: number | null,
  text: string,
  parseMode: string = "",
  replyMarkup: any = null,
): Promise<number | null> {
  if (messageId) {
    try {
      const body: any = { chat_id: chatId, message_id: messageId, text };
      if (parseMode) body.parse_mode = parseMode;
      if (replyMarkup) body.reply_markup = replyMarkup;
      const res = await tgFetch("editMessageText", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
        timeoutMs: 15000,
      });
      let data = (await res.json()) as any;
      if (data.ok && data.result?.message_id) {
        return data.result.message_id;
      }

      // Fallback 1: If reply_markup caused BUTTON_DATA_INVALID or any 400 error
      if (!data.ok && replyMarkup && (data.error_code === 400 || (data.description && /button|markup|reply_markup/i.test(data.description)))) {
        logError(
          `editMessageText failed with reply_markup (${data.description}), retrying without reply_markup...`,
        );
        const noMarkupBody: any = {
          chat_id: chatId,
          message_id: messageId,
          text,
        };
        if (parseMode) noMarkupBody.parse_mode = parseMode;
        const noMarkupRes = await tgFetch("editMessageText", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(noMarkupBody),
          timeoutMs: 15000,
        });
        data = (await noMarkupRes.json()) as any;
        if (data.ok && data.result?.message_id) {
          return data.result.message_id;
        }
      }

      // Fallback 2: Safe Telegram plain-text fallback (strips markdown entities)
      if (
        !data.ok &&
        parseMode &&
        (data.error_code === 400 ||
          (data.description && /parse|entity|markdown/i.test(data.description)))
      ) {
        logError(
          `editMessageText failed with parseMode="${parseMode}" (${data.description}), retrying as plain text...`,
        );
        const fallbackBody: any = {
          chat_id: chatId,
          message_id: messageId,
          text,
        };
        const retryRes = await tgFetch("editMessageText", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(fallbackBody),
          timeoutMs: 15000,
        });
        const retryData = (await retryRes.json()) as any;
        if (retryData.ok && retryData.result?.message_id) {
          return retryData.result.message_id;
        }
      }
    } catch (err: any) {
      logError(
        `editMessageText failed for message ${messageId}, falling back to sendMessage: ${err?.message || err}`,
      );
    }
  }
  return await sendMessage(chatId, text, parseMode, replyMarkup);
}

async function sendDocument(
  chatId: number,
  filePath: string,
  caption: string = "",
  parseMode: string = "",
  mimeType: string = "",
  customFileName: string = "",
): Promise<boolean> {
  try {
    const formData = new FormData();
    formData.append("chat_id", String(chatId));
    const fileBytes = fs.readFileSync(filePath);
    const fileName = customFileName || path.basename(filePath);
    let type = mimeType;
    if (!type) {
      if (fileName.endsWith(".tar.gz") || fileName.endsWith(".tgz")) {
        type = "application/gzip";
      } else if (fileName.endsWith(".epub")) {
        type = "application/epub+zip";
      } else if (fileName.endsWith(".pdf")) {
        type = "application/pdf";
      } else if (fileName.endsWith(".cbz")) {
        type = "application/vnd.comicbook+zip";
      } else {
        type = "application/octet-stream";
      }
    }
    const blob = new Blob([fileBytes], { type });
    formData.append("document", blob, fileName);
    if (caption) {
      formData.append("caption", caption);
      if (parseMode) {
        formData.append("parse_mode", parseMode);
      }
    }

    const res = await tgFetch("sendDocument", {
      method: "POST",
      body: formData,
      timeoutMs: 60000,
    });

    const data = (await res.json()) as any;
    if (data.ok) {
      log(`Sent document "${fileName}" to chat ${chatId}`);
      return true;
    } else if (
      parseMode &&
      (data.error_code === 400 ||
        (data.description && /parse|entity|caption/i.test(data.description)))
    ) {
      logError(
        `sendDocument failed with parseMode="${parseMode}" (${data.description}), retrying caption as plain text...`,
      );
      const fallbackFormData = new FormData();
      fallbackFormData.append("chat_id", String(chatId));
      fallbackFormData.append("document", blob, fileName);
      if (caption) {
        fallbackFormData.append("caption", caption);
      }
      const retryRes = await tgFetch("sendDocument", {
        method: "POST",
        body: fallbackFormData,
        timeoutMs: 60000,
      });
      const retryData = (await retryRes.json()) as any;
      if (retryData.ok) {
        log(
          `Sent document "${fileName}" to chat ${chatId} (plain-text caption fallback)`,
        );
        return true;
      } else {
        logError(
          `sendDocument plain-text retry failed for chat ${chatId}: ${retryData.description}`,
        );
        return false;
      }
    } else {
      logError(`sendDocument failed for chat ${chatId}: ${data.description}`);
      return false;
    }
  } catch (err: any) {
    logError(`sendDocument exception for chat ${chatId}: ${err.message}`);
    return false;
  }
}

export async function initChatMenuButton(chatId?: number): Promise<boolean> {
  try {
    const payload: any = {
      menu_button: {
        type: "web_app",
        text: "📖 Reading HQ",
        web_app: { url: READING_WEBAPP_URL },
      },
    };
    if (chatId) {
      payload.chat_id = chatId;
    }
    const res = await tgFetch("setChatMenuButton", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
      timeoutMs: 15000,
    });
    const data = (await res.json()) as any;
    if (data.ok) {
      log(
        `Registered Telegram Web App Menu Button (${chatId ? `chatId: ${chatId}` : "global default"}) -> ${READING_WEBAPP_URL}`,
      );
      return true;
    } else {
      logError(
        `Failed to set Telegram Chat Menu Button: ${data.description || "Unknown error"}`,
      );
      return false;
    }
  } catch (err: any) {
    logError(`Exception in setChatMenuButton: ${err.message}`);
    return false;
  }
}

export const BOT_COMMANDS = [
  { command: "menu", description: "Interactive dashboard with one-tap access" },
  { command: "reading", description: "Currently reading shelf with progress bars" },
  { command: "recent", description: "5 newest books in Calibre library" },
  { command: "find", description: "Search library by title, author, or series" },
  { command: "get", description: "Download any book by ID" },
  { command: "dedup", description: "Inspect and clean duplicate books" },
  { command: "status", description: "System health and tunnel status" },
  { command: "backup", description: "Hot backup of SQLite databases" },
  { command: "help", description: "KOReader setup and stack guide" },
];

export async function initBotCommands(): Promise<boolean> {
  try {
    const payload = {
      commands: BOT_COMMANDS,
    };
    const res = await tgFetch("setMyCommands", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
      timeoutMs: 15000,
    });
    const data = (await res.json()) as any;
    if (data.ok) {
      log(
        `Registered ${BOT_COMMANDS.length} Telegram bot commands via setMyCommands`,
      );
      return true;
    } else {
      logError(
        `Failed to set Telegram bot commands: ${data.description || "Unknown error"}`,
      );
      return false;
    }
  } catch (err: any) {
    logError(`Exception in setMyCommands: ${err.message}`);
    return false;
  }
}

export interface DatabaseBackupResult {
  stagingDir: string;
  archivePath: string;
  fileName: string;
  sizeKb: number;
  timestamp: string;
  displayTimestamp: string;
  backedUpDbs: string[];
}

export function saveBackupChatId(chatId: number): void {
  try {
    const envPath = process.env.ENV_PATH || ENV_PATH;
    let content = "";
    if (fs.existsSync(envPath)) {
      content = fs.readFileSync(envPath, "utf8");
    }
    const lines = content.split("\n");
    let found = false;
    const newLines = lines.map((line) => {
      if (line.trim().startsWith("TELEGRAM_BACKUP_CHAT_ID=")) {
        found = true;
        return `TELEGRAM_BACKUP_CHAT_ID=${chatId}`;
      }
      return line;
    });
    if (!found) {
      if (content.length > 0 && !content.endsWith("\n")) {
        newLines.push("");
      }
      newLines.push(`TELEGRAM_BACKUP_CHAT_ID=${chatId}`);
    }
    fs.writeFileSync(envPath, newLines.join("\n"));
    log(`Saved TELEGRAM_BACKUP_CHAT_ID=${chatId} to ${envPath}`);
  } catch (err: any) {
    logError(
      `Failed to save TELEGRAM_BACKUP_CHAT_ID to ${ENV_PATH}: ${err?.message || err}`,
    );
  }
}

export function createHotDatabaseBackup(): DatabaseBackupResult | null {
  const targets = [
    { name: "KOSync", fileName: "koreader-sync.db", path: KOSYNC_DB_PATH },
    { name: "Calibre", fileName: "metadata.db", path: getCalibreDbPath() },
    { name: "Uploader Cache", fileName: "cache.db", path: getCacheDbPath() },
    { name: "Manga", fileName: "manga.db", path: MANGA_DB_PATH },
  ];

  const stagingDir = fs.mkdtempSync(path.join("/tmp", "reading-stack-backup-"));
  const backedUpFiles: string[] = [];
  const backedUpDbs: string[] = [];

  const env: any = {
    ...process.env,
    PATH:
      "/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:" +
      (process.env.PATH || ""),
  };

  try {
    for (const target of targets) {
      if (!fs.existsSync(target.path)) {
        log(`Database not found at ${target.path}, skipping.`);
        continue;
      }

      const destPath = path.join(stagingDir, target.fileName);
      log(`Backing up ${target.name} (${target.path}) -> ${destPath}...`);
      const backupRes = spawnSync(
        "sqlite3",
        [target.path, `.backup '${destPath}'`],
        {
          encoding: "utf8",
          env,
          timeout: SUBPROCESS_TIMEOUT_MS,
          maxBuffer: SUBPROCESS_MAX_BUFFER,
        },
      );
      throwOnSubprocessTimeout(backupRes, "sqlite3 backup");

      if (backupRes.status === 0 && fs.existsSync(destPath)) {
        backedUpFiles.push(target.fileName);
        backedUpDbs.push(target.name);
        log(
          `Successfully backed up ${target.name} (${(fs.statSync(destPath).size / 1024).toFixed(1)} KB)`,
        );
      } else {
        logError(
          `Failed to back up ${target.name}: ${backupRes.stderr || "sqlite3 exited with code " + backupRes.status}`,
        );
      }
    }

    if (backedUpFiles.length === 0) {
      logError("No databases were successfully backed up.");
      fs.rmSync(stagingDir, { recursive: true, force: true });
      return null;
    }

    const now = new Date();
    const pad = (n: number) => String(n).padStart(2, "0");
    const fileTimestamp = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}_${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`;
    const displayTimestamp = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())} ${pad(now.getHours())}:${pad(now.getMinutes())}:${pad(now.getSeconds())}`;

    const fileName = `reading-stack-backup-${fileTimestamp}.tar.gz`;
    const archivePath = path.join("/tmp", fileName);

    log(`Archiving ${backedUpFiles.length} database(s) into ${archivePath}...`);
    const tarRes = spawnSync(
      "tar",
      ["-czf", archivePath, "-C", stagingDir, ...backedUpFiles],
      {
        encoding: "utf8",
        env,
        timeout: SUBPROCESS_TIMEOUT_MS,
        maxBuffer: SUBPROCESS_MAX_BUFFER,
      },
    );
    throwOnSubprocessTimeout(tarRes, "tar backup");

    if (tarRes.status !== 0 || !fs.existsSync(archivePath)) {
      logError(
        `Failed to create tar archive: ${tarRes.stderr || "tar exited with code " + tarRes.status}`,
      );
      fs.rmSync(stagingDir, { recursive: true, force: true });
      return null;
    }

    const sizeBytes = fs.statSync(archivePath).size;
    const sizeKb = Math.round(sizeBytes / 1024);

    return {
      stagingDir,
      archivePath,
      fileName,
      sizeKb,
      timestamp: fileTimestamp,
      displayTimestamp,
      backedUpDbs,
    };
  } catch (err: any) {
    logError(`Exception during database backup: ${err?.message || err}`);
    try {
      fs.rmSync(stagingDir, { recursive: true, force: true });
    } catch (_cleanupErr) {
      void _cleanupErr;
    }
    return null;
  }
}

export interface CalibreBookResult {
  id: number;
  title: string;
  authors: string;
  series?: string | null;
  series_index?: number | null;
  formats: string;
}

export function escapeTelegramMarkdown(text: string): string {
  if (!text) return "";
  return text.replace(/([_*`[\]])/g, "\\$1");
}

export function searchCalibreLibrary(
  query: string,
  limit: number = 5,
): CalibreBookResult[] {
  const trimmed = query.trim();
  if (!trimmed) return [];

  // 1. Try querying Calibre SQLite database first for instant sub-millisecond response
  const calibreDbPath = getCalibreDbPath();
  if (fs.existsSync(calibreDbPath)) {
    try {
      const db = new Database(calibreDbPath, { readonly: true });
      db.run("PRAGMA busy_timeout = 3000;");

      const words = trimmed.split(/\s+/).filter(Boolean);

      // Primary query: whole phrase match against title, author, or series (EPUB only)
      const primarySql = `
        SELECT b.id, b.title, b.path, b.series_index,
               GROUP_CONCAT(DISTINCT a.name) as authors,
               s.name as series,
               GROUP_CONCAT(DISTINCT d.format) as formats
        FROM books b
        LEFT JOIN books_authors_link bal ON b.id = bal.book
        LEFT JOIN authors a ON bal.author = a.id
        LEFT JOIN books_series_link bsl ON b.id = bsl.book
        LEFT JOIN series s ON bsl.series = s.id
        JOIN data d ON b.id = d.book
        WHERE UPPER(d.format) = 'EPUB' AND (b.title LIKE ? OR a.name LIKE ? OR s.name LIKE ?)
        GROUP BY b.id
        ORDER BY b.id DESC
        LIMIT ?
      `;

      const wildcardQuery = `%${trimmed}%`;
      const primaryRows = db
        .query(primarySql)
        .all(wildcardQuery, wildcardQuery, wildcardQuery, limit) as any[];

      const matchedBooks: CalibreBookResult[] = primaryRows.map((r) => ({
        id: r.id,
        title: r.title || "Untitled",
        authors: r.authors || "Unknown",
        series: r.series || null,
        series_index: r.series_index || null,
        formats: r.formats || "",
      }));

      // If fewer than limit and query had multiple terms, perform multi-term matching
      if (matchedBooks.length < limit && words.length > 1) {
        const existingIds = new Set(matchedBooks.map((b) => b.id));
        const conditions = words
          .map(() => "(b.title LIKE ? OR a.name LIKE ? OR s.name LIKE ?)")
          .join(" AND ");

        const multiSql = `
          SELECT b.id, b.title, b.path, b.series_index,
                 GROUP_CONCAT(DISTINCT a.name) as authors,
                 s.name as series,
                 GROUP_CONCAT(DISTINCT d.format) as formats
          FROM books b
          LEFT JOIN books_authors_link bal ON b.id = bal.book
          LEFT JOIN authors a ON bal.author = a.id
          LEFT JOIN books_series_link bsl ON b.id = bsl.book
          LEFT JOIN series s ON bsl.series = s.id
          JOIN data d ON b.id = d.book
          WHERE UPPER(d.format) = 'EPUB' AND ${conditions}
          GROUP BY b.id
          ORDER BY b.id DESC
          LIMIT ?
        `;

        const params: any[] = [];
        for (const w of words) {
          const p = `%${w}%`;
          params.push(p, p, p);
        }
        params.push(limit);

        const multiRows = db.query(multiSql).all(...params) as any[];
        for (const r of multiRows) {
          if (!existingIds.has(r.id)) {
            existingIds.add(r.id);
            matchedBooks.push({
              id: r.id,
              title: r.title || "Untitled",
              authors: r.authors || "Unknown",
              series: r.series || null,
              series_index: r.series_index || null,
              formats: r.formats || "",
            });
            if (matchedBooks.length >= limit) break;
          }
        }
      }

      db.close();
      if (matchedBooks.length > 0) {
        return matchedBooks.slice(0, limit);
      }
    } catch (err: any) {
      logError(
        `SQLite search failed, falling back to calibredb: ${err?.message || err}`,
      );
    }
  }

  // 2. Fallback to calibredb list (EPUB only)
  try {
    const listRes = runCalibredb([
      "list",
      "--with-library",
      SERVER_URL,
      "--search",
      `${trimmed} and format:epub`,
      "--fields",
      "id,title,authors,series,series_index,formats",
      "--for-machine",
    ]);

    if (listRes.status === 0 && listRes.stdout) {
      const parsed = safeParseJson(listRes.stdout);
      if (Array.isArray(parsed)) {
        return parsed
          .filter((item: any) => {
            const fmts = Array.isArray(item.formats)
              ? item.formats.map(
                  (f: string) =>
                    path.extname(f).replace(/^\./, "").toUpperCase() || f,
                )
              : [String(item.formats || "")];
            return fmts.some((f: string) => f.toUpperCase().includes("EPUB"));
          })
          .slice(0, limit)
          .map((item: any) => ({
            id: item.id,
            title: item.title || "Untitled",
            authors: Array.isArray(item.authors)
              ? item.authors.join(", ")
              : String(item.authors || "Unknown"),
            series: item.series || null,
            series_index: item.series_index || null,
            formats: "EPUB",
          }));
      }
    }
  } catch (err: any) {
    logError(`calibredb search fallback failed: ${err?.message || err}`);
  }

  return [];
}

export interface BookFileDetails {
  bookId: number;
  title: string;
  authors: string;
  series?: string | null;
  seriesIndex?: number | string | null;
  chosenFormat: string;
  filePath: string;
  fileSize: number;
}

export function locateBookFile(bookId: number): BookFileDetails | null {
  const PREFERRED_FORMATS = ["EPUB"];

  const dbPath = getCalibreDbPath();
  const libDir = getCalibreLibraryDir();

  if (fs.existsSync(dbPath)) {
    try {
      const db = new Database(dbPath, { readonly: true });
      db.run("PRAGMA busy_timeout = 3000;");

      const rows = db
        .query(`
        SELECT b.id, b.title, b.path, b.series_index,
               GROUP_CONCAT(DISTINCT a.name) as authors,
               s.name as series,
               d.format, d.name as filename, d.uncompressed_size
        FROM books b
        JOIN data d ON b.id = d.book
        LEFT JOIN books_authors_link bal ON b.id = bal.book
        LEFT JOIN authors a ON bal.author = a.id
        LEFT JOIN books_series_link bsl ON b.id = bsl.book
        LEFT JOIN series s ON bsl.series = s.id
        WHERE b.id = ? AND UPPER(d.format) = 'EPUB'
        GROUP BY d.id
      `)
        .all(bookId) as any[];

      db.close();

      if (rows && rows.length > 0) {
        const title = rows[0].title || "Book";
        const authors = rows[0].authors || "Unknown";
        const series = rows[0].series || null;
        const seriesIndex = rows[0].series_index || null;
        const bookRelPath = rows[0].path;
        const basePath = path.join(libDir, bookRelPath);

        // EPUB only
        rows.sort((a, b) => {
          const idxA = PREFERRED_FORMATS.indexOf(
            String(a.format || "").toUpperCase(),
          );
          const idxB = PREFERRED_FORMATS.indexOf(
            String(b.format || "").toUpperCase(),
          );
          const scoreA = idxA === -1 ? 999 : idxA;
          const scoreB = idxB === -1 ? 999 : idxB;
          return scoreA - scoreB;
        });

        for (const row of rows) {
          const fmt = String(row.format || "").toUpperCase();
          const filename = row.filename;

          const candidate1 = path.join(
            basePath,
            `${filename}.${fmt.toLowerCase()}`,
          );
          const candidate2 = path.join(
            basePath,
            `${filename}.${fmt.toUpperCase()}`,
          );

          if (fs.existsSync(candidate1)) {
            const stat = fs.statSync(candidate1);
            return {
              bookId,
              title,
              authors,
              series,
              seriesIndex,
              chosenFormat: fmt,
              filePath: candidate1,
              fileSize: stat.size,
            };
          }
          if (fs.existsSync(candidate2)) {
            const stat = fs.statSync(candidate2);
            return {
              bookId,
              title,
              authors,
              series,
              seriesIndex,
              chosenFormat: fmt,
              filePath: candidate2,
              fileSize: stat.size,
            };
          }

          if (fs.existsSync(basePath)) {
            const files = fs.readdirSync(basePath);
            const extLower = `.${fmt.toLowerCase()}`;
            const matchedFile = files.find((f: string) =>
              f.toLowerCase().endsWith(extLower),
            );
            if (matchedFile) {
              const fullPath = path.join(basePath, matchedFile);
              const stat = fs.statSync(fullPath);
              return {
                bookId,
                title,
                authors,
                series,
                seriesIndex,
                chosenFormat: fmt,
                filePath: fullPath,
                fileSize: stat.size,
              };
            }
          }
        }
      }
    } catch (err: any) {
      logError(
        `Error locating book file via SQLite for #${bookId}: ${err?.message || err}`,
      );
    }
  }

  // Fallback: search via calibredb
  try {
    const listRes = runCalibredb([
      "list",
      "--with-library",
      SERVER_URL,
      "--search",
      `id:${bookId} and format:epub`,
      "--fields",
      "id,title,authors,formats,series,series_index",
      "--for-machine",
    ]);

    if (listRes.status === 0 && listRes.stdout) {
      const parsed = safeParseJson(listRes.stdout);
      if (Array.isArray(parsed) && parsed.length > 0) {
        const item = parsed[0];
        const title = item.title || "Book";
        const authors = Array.isArray(item.authors)
          ? item.authors.join(", ")
          : String(item.authors || "Unknown");
        const series = item.series || null;
        const seriesIndex = item.series_index || null;
        const fmts: string[] = Array.isArray(item.formats) ? item.formats : [];

        for (const f of fmts) {
          if (fs.existsSync(f) && f.toLowerCase().endsWith(".epub")) {
            const stat = fs.statSync(f);
            return {
              bookId,
              title,
              authors,
              series,
              seriesIndex,
              chosenFormat: "EPUB",
              filePath: f,
              fileSize: stat.size,
            };
          }
        }
      }
    }
  } catch (err: any) {
    logError(
      `calibredb fallback failed for #${bookId}: ${err?.message || err}`,
    );
  }

  return null;
}

export async function retrieveAndSendBook(
  chatId: number,
  bookId: number,
): Promise<boolean> {
  const fileDetails = locateBookFile(bookId);

  if (!fileDetails) {
    log(`Book #${bookId} not found on disk.`);
    await sendMessage(
      chatId,
      `❌ *Book #${bookId} Not Found*\n\nUnable to locate the file in Calibre library. Verify the book exists via [Calibre Web](${CALIBRE_WEB_URL}).`,
      "Markdown",
    );
    return false;
  }

  const { title, authors, chosenFormat, filePath, fileSize } = fileDetails;

  // Check 20MB Telegram limit
  if (fileSize > MAX_TELEGRAM_FILE_SIZE) {
    const sizeMB = (fileSize / (1024 * 1024)).toFixed(1);
    log(
      `Book #${bookId} (${title}) exceeds 20MB (${sizeMB} MB). Sending web links.`,
    );
    await sendMessage(
      chatId,
      `⚠️ *File Exceeds Telegram Bot Limit*\n\n` +
        `📚 *${escapeTelegramMarkdown(title)}* (\`${chosenFormat}\`) is *${sizeMB} MB*, exceeding Telegram Bot API's *20 MB* download ceiling.\n\n` +
        `👉 *Read Online or Download via Calibre Web:*\n` +
        `• [Read Online](${CALIBRE_WEB_URL}/read/${bookId}/epub)\n` +
        `• [Book Details](${CALIBRE_WEB_URL}/#book_id=${bookId}&panel=book_details)`,
      "Markdown",
    );
    return false;
  }

  const statusMsgId = await sendMessage(
    chatId,
    `⏳ *Retrieving \`${chosenFormat}\` for "${escapeTelegramMarkdown(title)}"...*`,
    "Markdown",
  );

  const caption =
    `📚 *${escapeTelegramMarkdown(title)}*\n` +
    `👤 *Author:* ${escapeTelegramMarkdown(authors)}\n` +
    `📦 *Format:* \`${chosenFormat}\`\n\n` +
    `[Read Online](${CALIBRE_WEB_URL}/read/${bookId}/epub) • [Book Details](${CALIBRE_WEB_URL}/#book_id=${bookId}&panel=book_details)`;

  const deliveryFileName = generateMetadataFilename({
    title,
    authors,
    series: fileDetails.series,
    seriesIndex: fileDetails.seriesIndex,
    format: "epub",
    fallbackBase: `book-${bookId}`,
  });

  const sent = await sendDocument(
    chatId,
    filePath,
    caption,
    "Markdown",
    "application/epub+zip",
    deliveryFileName,
  );

  if (sent) {
    if (statusMsgId) {
      await editOrSendMessage(
        chatId,
        statusMsgId,
        `✅ *Delivered "${escapeTelegramMarkdown(title)}" below.*`,
        "Markdown",
      );
    }
    return true;
  } else {
    if (statusMsgId) {
      await editOrSendMessage(
        chatId,
        statusMsgId,
        `⚠️ Failed to send *${escapeTelegramMarkdown(title)}*. Check bot logs.`,
        "Markdown",
      );
    }
    return false;
  }
}

export async function getStatusDashboard(): Promise<string> {
  const ts = new Date()
    .toLocaleString("en-GB", { timeZone: "Asia/Yangon" })
    .replace(",", "");

  // 1. WAN Edge
  let wanReadingStatus = "🔴 `Unreachable`";
  const t0 = performance.now();
  try {
    const res = await safeFetchWithSsrf(READING_WEBAPP_URL, {
      proxy: PROXY_URL,
      signal: AbortSignal.timeout(8000),
    } as any);
    const dt = Math.round(performance.now() - t0);
    wanReadingStatus =
      res.status === 200
        ? `🟢 \`200 OK\` (${dt}ms)`
        : `🔴 \`HTTP ${res.status}\` (${dt}ms)`;
  } catch (_e) {
    void _e;
    const dt = Math.round(performance.now() - t0);
    wanReadingStatus = `🔴 \`Timeout/Error\` (${dt}ms)`;
  }

  let wanKosyncStatus = "🟡 `Pending WAN Setup`";
  try {
    const res = await safeFetchWithSsrf(KOSYNC_WAN_URL, {
      proxy: PROXY_URL,
      signal: AbortSignal.timeout(4000),
    } as any);
    wanKosyncStatus =
      res.status === 200 ? `🟢 \`200 OK\`` : `🟡 \`HTTP ${res.status}\``;
  } catch (_e) {
    void _e;
    wanKosyncStatus = `🟡 \`Tunnel Forwarded (:7200)\` (DNS Pending)`;
  }

  // 2. Reverse SSH Tunnel
  let tunnelStatus = "🔴 `Stopped`";
  try {
    const pg = spawnSync("pgrep", ["-f", "ssh.*0.0.0.0:8086"], {
      encoding: "utf8",
      timeout: SUBPROCESS_TIMEOUT_MS,
      maxBuffer: SUBPROCESS_MAX_BUFFER,
    });
    throwOnSubprocessTimeout(pg, "pgrep tunnel");
    const pid = (pg.stdout || "").trim().split("\n")[0];
    if (pid) tunnelStatus = `🟢 \`Active\` (PID ${pid})`;
  } catch (_e) {
    void _e;
  }

  let proxyStatus = "🔴 `Disconnected`";
  try {
    const pCheck = spawnSync("nc", ["-z", "127.0.0.1", "7890"], {
      timeout: SUBPROCESS_TIMEOUT_MS,
      maxBuffer: SUBPROCESS_MAX_BUFFER,
    });
    throwOnSubprocessTimeout(pCheck, "nc proxy check");
    if (pCheck.status === 0) proxyStatus = "🟢 `Connected` (127.0.0.1:7890)";
  } catch (_e) {
    void _e;
  }

  // 3. Reading HQ & Calibre
  let uploaderLocal = "🔴 `Inactive`";
  try {
    const res = await safeFetchWithSsrf(
      "http://127.0.0.1:8086/api/books",
      {
        signal: AbortSignal.timeout(2000),
      },
      5,
      { allowInternalServices: true },
    );
    if (res.status === 200) uploaderLocal = "🟢 `Active` (:8086)";
  } catch (_e) {
    void _e;
  }

  let calibreLocal = "🔴 `Inactive`";
  try {
    const res = await safeFetchWithSsrf(
      "http://127.0.0.1:8088/opds",
      {
        signal: AbortSignal.timeout(2000),
      },
      5,
      { allowInternalServices: true },
    );
    if (res.status === 200) calibreLocal = "🟢 `Active` (:8088 / OPDS)";
  } catch (_e) {
    void _e;
  }

  let totalBooks = 0;
  let formatStats = "None";
  let newestTitle = "None";
  const calibreDbPath = getCalibreDbPath();
  if (fs.existsSync(calibreDbPath)) {
    try {
      const db = new Database(calibreDbPath, { readonly: true });
      const bRow = db.query("SELECT COUNT(*) as cnt FROM books").get() as any;
      totalBooks = bRow?.cnt || 0;
      const fRows = db
        .query(
          "SELECT format, count(*) as cnt FROM data GROUP BY format ORDER BY cnt DESC LIMIT 4",
        )
        .all() as any[];
      if (fRows && fRows.length > 0) {
        formatStats = fRows.map((f) => `${f.format}: ${f.cnt}`).join(", ");
      }
      const nRow = db
        .query("SELECT id, title FROM books ORDER BY id DESC LIMIT 1")
        .get() as any;
      if (nRow) {
        newestTitle = `#${nRow.id} ${escapeTelegramMarkdown(nRow.title || "Untitled")}`;
      }
    } catch (_e) {
      void _e;
    }
  }

  // 4. KOSync
  let kosyncLocal = "🔴 `Inactive`";
  try {
    const res = await safeFetchWithSsrf(
      "http://127.0.0.1:7200/",
      {
        signal: AbortSignal.timeout(2000),
      },
      5,
      { allowInternalServices: true },
    );
    if (res.status === 200) kosyncLocal = "🟢 `Active` (:7200)";
  } catch (_e) {
    void _e;
  }

  let kosyncDbStatus = "🔴 `Not Found`";
  let kosyncUsers = 0;
  let kosyncProgress = 0;
  let deviceNames = "";
  if (fs.existsSync(KOSYNC_DB_PATH)) {
    try {
      const kDb = new Database(KOSYNC_DB_PATH, { readonly: true });
      kosyncDbStatus = "🟢 `Healthy` (SQLite WAL)";
      const uRow = kDb.query("SELECT COUNT(*) as cnt FROM users").get() as any;
      kosyncUsers = uRow?.cnt || 0;
      const pRow = kDb
        .query("SELECT COUNT(*) as cnt FROM progress")
        .get() as any;
      kosyncProgress = pRow?.cnt || 0;
      const dRows = kDb
        .query(
          'SELECT DISTINCT device FROM progress WHERE device IS NOT NULL AND device != ""',
        )
        .all() as any[];
      if (dRows && dRows.length > 0) {
        deviceNames = dRows.map((d) => d.device).join(", ");
      }
    } catch (_e) {
      void _e;
    }
  }

  // 5. Host Metrics
  const uptimeSec = os.uptime();
  const days = Math.floor(uptimeSec / 86400);
  const hours = Math.floor((uptimeSec % 86400) / 3600);
  const mins = Math.floor((uptimeSec % 3600) / 60);
  const uptimeStr = `${days}d ${hours}h ${mins}m`;

  let memStr = "";
  try {
    const mp = spawnSync("memory_pressure", ["-Q"], {
      encoding: "utf8",
      timeout: SUBPROCESS_TIMEOUT_MS,
      maxBuffer: SUBPROCESS_MAX_BUFFER,
    });
    throwOnSubprocessTimeout(mp, "memory_pressure");
    const match = mp.stdout?.match(
      /System-wide memory free percentage:\s*(\d+)%/i,
    );
    const totalGb = (os.totalmem() / 1024 ** 3).toFixed(1);
    if (match) {
      memStr = `\`${match[1]}% free\` (${totalGb} GB RAM)`;
    } else {
      const freeGb = (os.freemem() / 1024 ** 3).toFixed(1);
      memStr = `\`${freeGb} GB free\` / ${totalGb} GB`;
    }
  } catch (_e) {
    void _e;
    const totalGb = (os.totalmem() / 1024 ** 3).toFixed(1);
    const freeGb = (os.freemem() / 1024 ** 3).toFixed(1);
    memStr = `\`${freeGb} GB free\` / ${totalGb} GB`;
  }

  let internalDiskStr = "N/A";
  try {
    const df = spawnSync("df", ["-h", path.dirname(getCalibreDbPath())], {
      encoding: "utf8",
      timeout: SUBPROCESS_TIMEOUT_MS,
      maxBuffer: SUBPROCESS_MAX_BUFFER,
    });
    throwOnSubprocessTimeout(df, "df internal disk");
    const lines = (df.stdout || "").trim().split("\n");
    if (lines.length > 1) {
      const parts = lines[1].split(/\s+/);
      internalDiskStr = `\`${parts[3]} free\` / ${parts[1]} (${parts[4]} used)`;
    }
  } catch (_e) {
    void _e;
  }

  const ssdMount = process.env.STORAGE_MOUNT || null;
  let ssdDiskStr = "";
  if (ssdMount && fs.existsSync(ssdMount)) {
    try {
      const df = spawnSync("df", ["-h", ssdMount], {
        encoding: "utf8",
        timeout: SUBPROCESS_TIMEOUT_MS,
        maxBuffer: SUBPROCESS_MAX_BUFFER,
      });
      throwOnSubprocessTimeout(df, "df SSD disk");
      const lines = (df.stdout || "").trim().split("\n");
      if (lines.length > 1) {
        const parts = lines[1].split(/\s+/);
        ssdDiskStr = `\n• *Storage Mount:* \`${parts[3]} free\` / ${parts[1]} (${parts[4]} used)`;
      }
    } catch (_e) {
      void _e;
    }
  }

  const deviceText = deviceNames ? ` (${deviceNames})` : "";

  return (
    `📊 *Reading Stack Health Dashboard*\n` +
    `_Updated: ${ts} (Asia/Yangon)_\n\n` +
    `🌐 *WAN Edge (VPS panel)*\n` +
    `• *Reading HQ:* ${wanReadingStatus} • [reading.wavypremium.xyz](${READING_WEBAPP_URL})\n` +
    `• *KOSync WAN:* ${wanKosyncStatus}\n\n` +
    `🚇 *Reverse SSH Tunnel*\n` +
    `• *Tunnel Daemon:* ${tunnelStatus}\n` +
    `• *Port Forwards:* \`8086\` (HQ) • \`7200\` (KOSync)\n` +
    `• *Sing-box Proxy:* ${proxyStatus}\n\n` +
    `📚 *Reading HQ & Calibre*\n` +
    `• *Web Uploader:* ${uploaderLocal}\n` +
    `• *Calibre Server:* ${calibreLocal}\n` +
    `• *Total Catalog:* \`${totalBooks} books\` (\`${formatStats}\`)\n` +
    `• *Newest Title:* ${newestTitle}\n\n` +
    `🔄 *KOReader Sync (KOSync)*\n` +
    `• *KOSync Server:* ${kosyncLocal}\n` +
    `• *Sync Database:* ${kosyncDbStatus}\n` +
    `• *Users & Devices:* \`${kosyncUsers} user(s)\` • \`${deviceNames ? "Active" : "None"}${deviceText}\`\n` +
    `• *Synced Progress:* \`${kosyncProgress} reading record(s)\`\n\n` +
    `🖥️ *Mac Mini Host*\n` +
    `• *Uptime:* \`${uptimeStr}\`\n` +
    `• *Memory:* ${memStr}\n` +
    `• *Internal Disk:* ${internalDiskStr}` +
    ssdDiskStr
  );
}

export function renderProgressBar(
  percentage: number,
  length: number = 8,
): string {
  const clamped = Math.max(0, Math.min(1, percentage));
  const filled = Math.round(clamped * length);
  const empty = length - filled;
  return "█".repeat(filled) + "░".repeat(empty);
}

export function truncate(str: string, maxLen: number): string {
  if (!str) return "";
  return str.length > maxLen ? str.substring(0, maxLen - 1) + "…" : str;
}

export function formatRelativeTime(timestampSec: number): string {
  if (!timestampSec) return "recently";
  const nowSec = Math.floor(Date.now() / 1000);
  const diff = Math.max(0, nowSec - timestampSec);
  if (diff < 60) return "just now";
  if (diff < 3600) return `${Math.floor(diff / 60)}m ago`;
  if (diff < 86400) return `${Math.floor(diff / 3600)}h ago`;
  const days = Math.floor(diff / 86400);
  if (days === 1) return "yesterday";
  if (days < 30) return `${days}d ago`;
  return `${Math.floor(days / 30)}mo ago`;
}

export function getMainMenuKeyboard() {
  return {
    inline_keyboard: [
      [{ text: "📖 Open Reading HQ", web_app: { url: READING_WEBAPP_URL } }],
      [
        { text: "🔍 Search Library", callback_data: "menu:search" },
        { text: "📚 Recent Books", callback_data: "menu:recent" },
      ],
      [
        { text: "📖 Currently Reading", callback_data: "menu:reading" },
        { text: "⚡ Server Status", callback_data: "refresh_status" },
      ],
      [
        { text: "💾 Hot Backup", callback_data: "menu:backup" },
        { text: "🧹 Deduplicate", callback_data: "rescan_dedup" },
      ],
    ],
  };
}

export function getMainMenuText(): string {
  return (
    `🏮 *LightHouse — Your self-hosted reading beacon*\n\n` +
    `Welcome to your personal library and reading companion.\n\n` +
    `• *Mini App:* Tap *[📖 Open Reading HQ]* to explore your visual catalog.\n` +
    `• *Search Library:* Find any book by title, author, or series (\`/f <query>\`).\n` +
    `• *Currently Reading:* Track reading progress synchronized from KOReader (\`/reading\`).\n` +
    `• *Recent Books:* View newest additions to your library (\`/recent\`).\n` +
    `• *Ingest:* Send eBook files (\`.epub\`, \`.pdf\`, \`.cbz\`, etc.) or paste any article URL.\n` +
    `• *Server Status:* Monitor WAN edge, reverse tunnel, and host metrics (\`/status\`).\n` +
    `• *Hot Backup:* Snapshot reading databases to Telegram (\`/backup\`).\n` +
    `• *Deduplicate:* Inspect and clean duplicate books (\`/dedup\`).`
  );
}

export function getHelpMessage(): string {
  return (
    `🏮 *LightHouse — Your self-hosted reading beacon*\n\n` +
    `*Command Reference*\n` +
    `• \`/menu\` - Interactive dashboard with one-tap access\n` +
    `• \`/reading\` - Currently reading shelf with progress bars\n` +
    `• \`/recent\` - 5 newest books in Calibre library\n` +
    `• \`/find <query>\` (or \`/f <query>\`) - Search library\n` +
    `• \`/get <id>\` - Download any book by ID\n` +
    `• \`/app\` - Launch Reading HQ Mini App\n` +
    `• \`/status\` (or \`/health\`) - System health dashboard\n` +
    `• \`/backup\` - Hot backup of SQLite databases\n` +
    `• \`/dedup\` (or \`/dedupe\`, \`/duplicates\`, \`/clean\`, \`/clean_duplicates\`) - Inspect and clean duplicate books\n\n` +
    `*KOReader Connection Guide*\n\n` +
    `*1. KOSync Progress Sync*\n` +
    `• In KOReader: open any book → Top menu → *Tools* (wrench icon) → *Progress sync*\n` +
    `• Tap *Custom sync server* → enter server address:\n` +
    `  • Plain HTTP (Port 80 - Recommended): \`http://kosync-sg.wavypremium.xyz\`\n` +
    `  • Encrypted TLS (Port 8443): \`https://kosync-sg.wavypremium.xyz:8443\`\n` +
    `  • Local LAN: \`http://192.168.31.15:7200\`\n` +
    `• Tap *Login* → enter Username: \`moe\` (password as configured)\n` +
    `• Check *"Automatically keep documents in sync"*\n` +
    `• Tap *"Pull progress to this device now"* to test sync\n\n` +
    `*2. OPDS Book Catalog (Wireless Downloads)*\n` +
    `• In KOReader: top menu → *Search* (magnifying glass) → *OPDS catalog*\n` +
    `• Tap *Add new catalog*:\n` +
    `  • Catalog Name: \`Mac Mini Library\`\n` +
    `  • Plain HTTP (Port 80 - Recommended): \`http://opds.wavypremium.xyz/opds\`\n` +
    `  • Encrypted TLS (Port 8443): \`https://opds.wavypremium.xyz:8443/opds\`\n` +
    `  • Local LAN: \`http://192.168.31.15:8088/opds\` or \`http://192.168.31.15:8086/opds\`\n` +
    `• Tap *Connect* (no login required on local LAN or WAN)\n\n` +
    `*3. Kindle Wi-Fi Proxy (GFW / DPI Bypass)*\n` +
    `• If Kindle displays connection errors reaching external servers:\n` +
    `• Wi-Fi Settings → connected network → Advanced → HTTP Proxy:\n` +
    `  • Host: \`192.168.31.15\` | Port: \`7890\`\n\n` +
    `*Stack Endpoints Reference*\n` +
    `• *KOSync Server:*\n` +
    `  • Plain HTTP (Port 80 - Recommended): \`http://kosync-sg.wavypremium.xyz\`\n` +
    `  • Encrypted TLS (Port 8443): \`https://kosync-sg.wavypremium.xyz:8443\`\n` +
    `  • Local LAN: \`http://192.168.31.15:7200\`\n` +
    `• *Calibre OPDS Feed:*\n` +
    `  • Plain HTTP (Port 80 - Recommended): \`http://opds.wavypremium.xyz/opds\`\n` +
    `  • Encrypted TLS (Port 8443): \`https://opds.wavypremium.xyz:8443/opds\`\n` +
    `  • Local LAN: \`http://192.168.31.15:8088/opds\` or \`http://192.168.31.15:8086/opds\`\n` +
    `• *Calibre Web Reader:*\n` +
    `  • Local: \`http://192.168.31.15:8088\`\n` +
    `• *Reading HQ Dashboard:*\n` +
    `  • Local: \`http://192.168.31.15:8086\`\n` +
    `  • WAN / Mini App: \`https://reading.wavypremium.xyz\`\n` +
    `• *LAN Proxy Gateway:*\n` +
    `  • \`192.168.31.15:7890\` (HTTP/SOCKS5)\n` +
    `• *Telegram Bot:* \`@saroat_ospeto_bot\`\n\n` +
    `_Send any EPUB file (.epub or .zip/.7z archive) or article URL to ingest immediately._`
  );
}

export function getPostIngestionKeyboard(bookId: number) {
  return {
    inline_keyboard: [
      [
        { text: "📥 Send File", callback_data: `send_book:${bookId}` },
        { text: "📖 Open in Mini App", web_app: { url: READING_WEBAPP_URL } },
        { text: "🗑️ Undo / Delete", callback_data: `delete_book:${bookId}` },
      ],
    ],
  };
}

export interface RetryEntry {
  fileId: string;
  fileName: string;
  fileSize: number;
  chatId: number;
  createdAt: number;
}

export const pendingRetries = new Map<string, RetryEntry>();
const RETRY_TTL_MS = 60 * 60 * 1000; // 1 hour

export function cleanExpiredRetries() {
  const now = Date.now();
  for (const [token, entry] of pendingRetries.entries()) {
    if (now - entry.createdAt > RETRY_TTL_MS) {
      pendingRetries.delete(token);
    }
  }
}

export function registerPendingRetry(info: {
  fileId: string;
  fileName?: string;
  fileSize?: number;
  chatId: number;
}): string {
  cleanExpiredRetries();
  const retryToken = crypto.randomBytes(8).toString("hex");
  pendingRetries.set(retryToken, {
    fileId: info.fileId,
    fileName: info.fileName || "retry.epub",
    fileSize: info.fileSize || 0,
    chatId: info.chatId,
    createdAt: Date.now(),
  });
  return retryToken;
}

export function getRetryImportKeyboard(
  tokenOrFileId: string,
  info?: { fileName?: string; fileSize?: number; chatId?: number }
) {
  let token = tokenOrFileId;
  if (token.startsWith("retry:")) {
    token = token.replace("retry:", "");
  } else if (token.startsWith("retry_file:")) {
    token = token.replace("retry_file:", "");
  }

  // If the identifier is longer than 32 chars (e.g. Telegram raw file_id),
  // map it to a short random token so callback_data remains well under 64 bytes.
  if (token.length > 32) {
    token = registerPendingRetry({
      fileId: token,
      fileName: info?.fileName,
      fileSize: info?.fileSize,
      chatId: info?.chatId || 0,
    });
  }

  return {
    inline_keyboard: [
      [
        {
          text: "🔄 Retry Import",
          callback_data: `retry:${token}`,
        },
      ],
    ],
  };
}

export function deleteBookFromLibrary(bookId: number): {
  success: boolean;
  title?: string;
  error?: string;
} {
  if (isNaN(bookId) || bookId <= 0) {
    return { success: false, error: "Invalid book ID" };
  }

  let bookTitle: string | null = null;
  const calibreDbPath = getCalibreDbPath();
  if (fs.existsSync(calibreDbPath)) {
    try {
      const db = new Database(calibreDbPath, { readonly: true });
      const row = db
        .query("SELECT title FROM books WHERE id = ?")
        .get(bookId) as any;
      if (row && row.title) {
        bookTitle = row.title;
      }
      db.close();
    } catch (_e) {
      void _e;
    }
  }

  const res = runCalibredb([
    "remove",
    String(bookId),
    "--with-library",
    SERVER_URL,
  ]);
  if (res.status === 0) {
    try {
      cacheDb.run("DELETE FROM file_hashes WHERE book_id = ?", bookId);
    } catch (_e) {
      void _e;
    }
    try {
      const thumbDir = getCoverCacheDir();
      if (fs.existsSync(thumbDir)) {
        const files = fs.readdirSync(thumbDir);
        for (const f of files) {
          if (f.startsWith(`${bookId}_`)) {
            fs.unlinkSync(path.join(thumbDir, f));
          }
        }
      }
    } catch (_e) {
      void _e;
    }
    return { success: true, title: bookTitle || `Book #${bookId}` };
  } else {
    return {
      success: false,
      title: bookTitle || `Book #${bookId}`,
      error: res.stderr || "Calibre remove failed",
    };
  }
}

export interface ActiveReadingDoc {
  document: string;
  percentage: number;
  title: string;
  author: string;
  device: string;
  timestamp: number;
  bookId: number | null;
}

export function getCurrentlyReadingShelf(limit: number = 5): {
  items: ActiveReadingDoc[];
  card: string;
  keyboard: any;
} {
  const items: ActiveReadingDoc[] = [];

  if (fs.existsSync(KOSYNC_DB_PATH)) {
    try {
      const kDb = new Database(KOSYNC_DB_PATH, { readonly: true });
      kDb.run("PRAGMA busy_timeout = 3000;");

      const rows = kDb
        .query(`
        SELECT document, percentage, device, filename, title, authors, timestamp
        FROM progress
        WHERE percentage > 0 AND percentage < 0.99
        ORDER BY timestamp DESC
        LIMIT ?
      `)
        .all(limit) as any[];

      kDb.close();

      for (const r of rows) {
        let title = (r.title || "").trim();
        if (!title && r.filename) {
          title = path.basename(r.filename, path.extname(r.filename));
        }
        if (!title) {
          title =
            "Document " + (r.document ? r.document.substring(0, 8) : "Unknown");
        }

        const author = (r.authors || "Unknown").trim();
        const device = (r.device || "Unknown Device").trim();
        const pct = Math.max(
          0,
          Math.min(
            1,
            typeof r.percentage === "number"
              ? r.percentage
              : parseFloat(r.percentage) || 0,
          ),
        );
        const timestamp =
          typeof r.timestamp === "number"
            ? r.timestamp
            : parseInt(r.timestamp, 10) || 0;

        let bookId: number | null = null;

        // Try mapping via cacheDb file_hashes (hash = document)
        try {
          const hashRow = cacheDb
            .query(
              "SELECT book_id FROM file_hashes WHERE hash = ? AND book_id IS NOT NULL LIMIT 1",
            )
            .get(r.document) as any;
          if (hashRow?.book_id) {
            bookId = hashRow.book_id;
          }
        } catch (_e) {
          void _e;
        }

        // Try mapping via Calibre title match if not found via hash
        if (!bookId && title && !title.startsWith("Document ")) {
          try {
            const results = searchCalibreLibrary(title, 1);
            if (results && results.length > 0) {
              bookId = results[0].id;
            }
          } catch (_e) {
            void _e;
          }
        }

        items.push({
          document: r.document,
          percentage: pct,
          title,
          author,
          device,
          timestamp,
          bookId,
        });
      }
    } catch (_e) {
      logError("Failed to query koreader-sync.db for currently reading", _e);
    }
  }

  if (items.length === 0) {
    const card =
      `📖 *Currently Reading Shelf*\n\n` +
      `No active reading sessions found (progress between 1% and 99%).\n\n` +
      `_Start reading on your KOReader device or open Reading HQ to sync progress!_`;
    const keyboard = {
      inline_keyboard: [
        [
          { text: "📖 Open Reading HQ", web_app: { url: READING_WEBAPP_URL } },
          { text: "🔙 Main Menu", callback_data: "menu:main" },
        ],
      ],
    };
    return { items, card, keyboard };
  }

  let card = `📖 *Currently Reading Shelf*\n\nActive reading sessions synced from your devices:\n\n`;
  const keyboardRows: any[][] = [];

  for (let i = 0; i < items.length; i++) {
    const it = items[i];
    const pctInt = Math.round(it.percentage * 100);
    const bar = renderProgressBar(it.percentage, 8);
    const deviceIcon = it.device.toLowerCase().includes("phone") ? "📱" : "📖";
    const timeAgo = formatRelativeTime(it.timestamp);

    card += `${i + 1}. *${escapeTelegramMarkdown(it.title)}*\n`;
    if (it.author && it.author !== "Unknown") {
      card += `   👤 _${escapeTelegramMarkdown(it.author)}_\n`;
    }
    card += `   \`${bar} ${pctInt}%\` • ${deviceIcon} ${escapeTelegramMarkdown(it.device)} • _${timeAgo}_\n\n`;

    if (it.bookId) {
      keyboardRows.push([
        {
          text: `📥 Get "${truncate(it.title, 18)}"`,
          callback_data: `send_book:${it.bookId}`,
        },
        {
          text: "ℹ️ Details",
          url: `${CALIBRE_WEB_URL}/#book_id=${it.bookId}&panel=book_details`,
        },
      ]);
    }
  }

  keyboardRows.push([
    { text: "🔄 Refresh", callback_data: "menu:reading" },
    { text: "📖 Open Reading HQ", web_app: { url: READING_WEBAPP_URL } },
  ]);
  keyboardRows.push([{ text: "🔙 Main Menu", callback_data: "menu:main" }]);

  return { items, card, keyboard: { inline_keyboard: keyboardRows } };
}

export function getRecentBooks(limit: number = 5): {
  books: CalibreBookResult[];
  card: string;
  keyboard: any;
} {
  let books: CalibreBookResult[] = [];
  const calibreDbPath = getCalibreDbPath();

  if (fs.existsSync(calibreDbPath)) {
    try {
      const db = new Database(calibreDbPath, { readonly: true });
      db.run("PRAGMA busy_timeout = 3000;");

      const rows = db
        .query(`
        SELECT b.id, b.title, b.path, b.series_index,
               GROUP_CONCAT(DISTINCT a.name) as authors,
               s.name as series,
               GROUP_CONCAT(DISTINCT d.format) as formats
        FROM books b
        LEFT JOIN books_authors_link bal ON b.id = bal.book
        LEFT JOIN authors a ON bal.author = a.id
        LEFT JOIN books_series_link bsl ON b.id = bsl.book
        LEFT JOIN series s ON bsl.series = s.id
        JOIN data d ON b.id = d.book
        WHERE UPPER(d.format) = 'EPUB'
        GROUP BY b.id
        ORDER BY b.id DESC
        LIMIT ?
      `)
        .all(limit) as any[];

      db.close();

      books = rows.map((r) => ({
        id: r.id,
        title: r.title || "Untitled",
        authors: r.authors || "Unknown",
        series: r.series || null,
        series_index: r.series_index || null,
        formats: r.formats || "",
      }));
    } catch (_e) {
      logError("Failed to query Calibre library for recent books", _e);
    }
  }

  if (books.length === 0) {
    const card =
      `📚 *Recent Additions*\n\n` +
      `No books found in the Calibre library yet.\n\n` +
      `_Send eBook files or web article links to add them!_`;
    const keyboard = {
      inline_keyboard: [
        [
          { text: "📖 Open Reading HQ", web_app: { url: READING_WEBAPP_URL } },
          { text: "🔙 Main Menu", callback_data: "menu:main" },
        ],
      ],
    };
    return { books, card, keyboard };
  }

  let card = `📚 *Recent Additions*\n\nThe latest ${books.length} book(s) added to your library:\n\n`;
  const keyboardRows: any[][] = [];

  for (let i = 0; i < books.length; i++) {
    const b = books[i];
    const formatBadges = (b.formats || "")
      .split(",")
      .flatMap((f: string) => (f.trim() ? [`[${f.trim()}]`] : []))
      .join(" ");

    card += `${i + 1}. *${escapeTelegramMarkdown(b.title)}*\n`;
    card += `   👤 _${escapeTelegramMarkdown(b.authors || "Unknown")}_`;
    if (b.series) {
      const idx = b.series_index ? ` (#${b.series_index})` : "";
      card += ` • 🏷️ _${escapeTelegramMarkdown(b.series)}${idx}_`;
    }
    if (formatBadges) {
      card += ` • \`${formatBadges}\``;
    }
    card += `\n\n`;

    keyboardRows.push([
      {
        text: `📥 Get "${truncate(b.title, 18)}"`,
        callback_data: `send_book:${b.id}`,
      },
      {
        text: "ℹ️ Details",
        url: `${CALIBRE_WEB_URL}/#book_id=${b.id}&panel=book_details`,
      },
    ]);
  }

  keyboardRows.push([
    { text: "🔄 Refresh", callback_data: "menu:recent" },
    { text: "📖 Open Reading HQ", web_app: { url: READING_WEBAPP_URL } },
  ]);
  keyboardRows.push([{ text: "🔙 Main Menu", callback_data: "menu:main" }]);

  return { books, card, keyboard: { inline_keyboard: keyboardRows } };
}

export function formatDuplicateCleanerCard(report: CleanDuplicatesReport): {
  card: string;
  keyboard: any;
} {
  if (report.duplicateGroupsCount === 0 || report.groups.length === 0) {
    const card =
      `\u2705 *Library is Clean: No duplicates detected across your books.*\n\n` +
      `\u2022 *Books Scanned:* ${report.totalBooksScanned}\n` +
      `\u2022 *Duplicates Detected:* 0\n\n` +
      `_All books in your Calibre library are distinct._`;
    const keyboard = {
      inline_keyboard: [
        [
          { text: "\ud83d\udd04 Rescan", callback_data: "rescan_dedup" },
          { text: "\ud83d\udcd6 Open Reading HQ", web_app: { url: READING_WEBAPP_URL } },
        ],
        [{ text: "\ud83c\udfe0 Main Menu", callback_data: "menu:main" }],
      ],
    };
    return { card, keyboard };
  }

  let card =
    `\ud83e\uddf9 *Calibre Duplicate Detection Summary*\n\n` +
    `\u2022 *Books Scanned:* ${report.totalBooksScanned}\n` +
    `\u2022 *Duplicate Groups Detected:* ${report.duplicateGroupsCount}\n` +
    `\u2022 *Total Identified Duplicates:* ${report.totalDuplicatesFound}\n\n` +
    `*Detected Duplicate Groups (Top ${Math.min(report.groups.length, 5)}):*\n\n`;

  const displayLimit = Math.min(report.groups.length, 5);
  for (let i = 0; i < displayLimit; i++) {
    const g = report.groups[i];
    const keeper = g.books.find((b) => b.id === g.keeperId);
    const keeperTitle = keeper ? keeper.title : `Book #${g.keeperId}`;
    const keeperAuthors = keeper?.authors || "Unknown";
    const keeperSeries = keeper?.series
      ? ` \u2022 \ud83c\udff7\ufe0f _${escapeTelegramMarkdown(keeper.series)}${keeper.series_index ? ` (#${keeper.series_index})` : ""}_`
      : "";
    const keeperFormats = (keeper?.formats || []).join(", ") || "None";

    card += `*Group ${i + 1}/${report.groups.length}:* ${escapeTelegramMarkdown(keeperTitle)}\n`;
    card += `\u2b50 *Keeper (#${g.keeperId}):* ${escapeTelegramMarkdown(keeperTitle)}\n`;
    card += `   \ud83d\udc64 _${escapeTelegramMarkdown(keeperAuthors)}_${keeperSeries}\n`;
    card += `   \ud83d\udce6 Formats: \`${escapeTelegramMarkdown(keeperFormats)}\` \u2022 Rationale: _${escapeTelegramMarkdown(g.keeperReason)}_\n`;

    card += `\ud83d\uddd1\ufe0f *Duplicates to Prune:*\n`;
    for (const dId of g.duplicateIds) {
      const d = g.books.find((b) => b.id === dId);
      const dTitle = d ? d.title : `Book #${dId}`;
      const dAuthors = d?.authors || "Unknown";
      const dFormats = (d?.formats || []).join(", ") || "None";
      card += `   \u274c *#${dId}:* ${escapeTelegramMarkdown(dTitle)} (${escapeTelegramMarkdown(dAuthors)})\n`;
      card += `      \ud83d\udce6 Formats: \`${escapeTelegramMarkdown(dFormats)}\`\n`;
    }
    card += `\n`;
  }

  if (report.groups.length > displayLimit) {
    card += `_...and ${report.groups.length - displayLimit} more duplicate group(s)._\n\n`;
  }

  card += `\u26a0\ufe0f _Tap [Prune Duplicates] to safely prune redundant copies while preserving reading progress & annotations on keepers._`;

  const keyboard = {
    inline_keyboard: [
      [
        { text: "\ud83e\uddf9 Prune Duplicates", callback_data: "apply_dedup_confirm" },
        { text: "\ud83d\udd04 Rescan", callback_data: "rescan_dedup" },
      ],
      [
        { text: "\ud83d\udcd6 Open Reading HQ", web_app: { url: READING_WEBAPP_URL } },
        { text: "\ud83c\udfe0 Main Menu", callback_data: "menu:main" },
      ],
    ],
  };

  return { card, keyboard };
}

export async function triggerBackup(chatId: number): Promise<boolean> {
  const statusMsgId = await sendMessage(
    chatId,
    `⏳ *Creating hot SQLite backup of reading stack databases...*`,
    "Markdown",
  );

  saveBackupChatId(chatId);

  const backupResult = createHotDatabaseBackup();
  if (backupResult) {
    try {
      const dbList = backupResult.backedUpDbs.join(", ");
      const caption =
        `📦 *Reading Stack Database Backup*\n` +
        `📅 *Date:* ${backupResult.displayTimestamp}\n` +
        `📊 *Size:* ${backupResult.sizeKb} KB\n` +
        `🗄️ *Databases:* ${dbList}\n` +
        `✨ _Secure offline snapshot stored in your Telegram history._`;

      const sent = await sendDocument(
        chatId,
        backupResult.archivePath,
        caption,
        "Markdown",
      );

      if (sent) {
        if (statusMsgId) {
          await editOrSendMessage(
            chatId,
            statusMsgId,
            `✅ *Hot SQLite backup created successfully.* Delivered below.`,
            "Markdown",
          );
        }
        return true;
      } else {
        if (statusMsgId) {
          await editOrSendMessage(
            chatId,
            statusMsgId,
            `⚠️ *Backup Delivery Failed*\n\nUnable to deliver backup archive to Telegram. Check bot logs for details.`,
            "Markdown",
          );
        }
        return false;
      }
    } finally {
      try {
        fs.rmSync(backupResult.stagingDir, { recursive: true, force: true });
      } catch (_cleanupErr) {
        void _cleanupErr;
      }
      try {
        fs.unlinkSync(backupResult.archivePath);
      } catch (_unlinkErr) {
        void _unlinkErr;
      }
    }
  } else {
    if (statusMsgId) {
      await editOrSendMessage(
        chatId,
        statusMsgId,
        `⚠️ *Database Backup Failed*\n\nCould not snapshot reading stack databases. Please check system logs.`,
        "Markdown",
      );
    }
    return false;
  }
}

export async function handleCallbackQuery(cq: any): Promise<void> {
  const callbackId = cq.id;
  const chatId = cq.message?.chat?.id || cq.from?.id;
  const messageId = cq.message?.message_id;
  const data = cq.data || "";
  const sender = cq.from?.username || cq.from?.first_name || `ID ${chatId}`;

  log(`Received callback_query: "${data}" from ${sender} (chatId: ${chatId})`);

  let answerText: string | undefined;
  if (data === "refresh_status" || data === "menu:status")
    answerText = "Refreshing status...";
  else if (data === "menu:reading") answerText = "Loading currently reading...";
  else if (data === "menu:recent") answerText = "Loading recent books...";
  else if (data === "menu:backup") answerText = "Starting backup...";
  else if (data === "menu:main") answerText = "Loading menu...";
  else if (data === "menu:search") answerText = "Search Library...";
  else if (data === "rescan_dedup")
    answerText = "Scanning library for duplicates...";
  else if (data === "apply_dedup_confirm")
    answerText = "Confirming duplicate pruning...";
  else if (data === "apply_dedup_confirmed")
    answerText = "Pruning duplicate books...";
  else if (data === "cancel_dedup") answerText = "Cancelled.";
  else if (data.startsWith("delete_book:")) answerText = "Deleting book...";
  else if (data.startsWith("send_book:")) answerText = "Retrieving book...";
  else if (data.startsWith("retry:") || data.startsWith("retry_file:")) answerText = "Retrying import...";

  // Answer callback query immediately so Telegram client stops loading animation
  try {
    await tgFetch("answerCallbackQuery", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ callback_query_id: callbackId, text: answerText }),
      timeoutMs: 10000,
    });
  } catch (err: any) {
    logError(`answerCallbackQuery failed: ${err?.message || err}`);
  }

  if (data === "refresh_status" || data === "menu:status") {
    const card = await getStatusDashboard();
    const inlineKeyboard = {
      inline_keyboard: [
        [
          { text: "🔄 Refresh Status", callback_data: "refresh_status" },
          { text: "📖 Open Reading HQ", web_app: { url: READING_WEBAPP_URL } },
        ],
        [{ text: "🔙 Main Menu", callback_data: "menu:main" }],
      ],
    };
    await editOrSendMessage(
      chatId,
      messageId,
      card,
      "Markdown",
      inlineKeyboard,
    );
    return;
  }

  if (data === "menu:main") {
    await editOrSendMessage(
      chatId,
      messageId,
      getMainMenuText(),
      "Markdown",
      getMainMenuKeyboard(),
    );
    return;
  }

  if (data === "menu:search") {
    const searchCard =
      `🔍 *Library Search*\n\n` +
      `Send \`/find <query>\`, \`/search <query>\`, or \`/f <query>\` to instantly search your Calibre library by title, author, or series.\n\n` +
      `*Examples:*\n` +
      `• \`/f Foundation\`\n` +
      `• \`/f Isaac Asimov\`\n` +
      `• \`/f One Piece\``;
    const keyboard = {
      inline_keyboard: [
        [
          { text: "📚 Recent Books", callback_data: "menu:recent" },
          { text: "📖 Open Reading HQ", web_app: { url: READING_WEBAPP_URL } },
        ],
        [{ text: "🔙 Main Menu", callback_data: "menu:main" }],
      ],
    };
    await editOrSendMessage(
      chatId,
      messageId,
      searchCard,
      "Markdown",
      keyboard,
    );
    return;
  }

  if (data === "menu:reading") {
    const { card, keyboard } = getCurrentlyReadingShelf(5);
    await editOrSendMessage(chatId, messageId, card, "Markdown", keyboard);
    return;
  }

  if (data === "menu:recent") {
    const { card, keyboard } = getRecentBooks(5);
    await editOrSendMessage(chatId, messageId, card, "Markdown", keyboard);
    return;
  }

  if (data === "menu:backup") {
    await triggerBackup(chatId);
    return;
  }

  if (data === "rescan_dedup") {
    const report = await _duplicateCleanerRunner({ dryRun: true });
    const { card, keyboard } = formatDuplicateCleanerCard(report);
    await editOrSendMessage(chatId, messageId, card, "Markdown", keyboard);
    return;
  }

  if (data === "apply_dedup_confirm") {
    const confirmPrompt =
      `\u26a0\ufe0f *Confirm Duplicate Pruning*\n\n` +
      `Are you sure you want to remove duplicate books from Calibre?\n` +
      `- Reading progress & annotations are preserved on keepers.\n` +
      `- Audit log written to data/duplicate-pruning-audit.log.`;
    const confirmKeyboard = {
      inline_keyboard: [
        [
          { text: "✅ Confirm & Prune", callback_data: "apply_dedup_confirmed" },
          { text: "❌ Cancel", callback_data: "cancel_dedup" },
        ],
      ],
    };
    await editOrSendMessage(
      chatId,
      messageId,
      confirmPrompt,
      "Markdown",
      confirmKeyboard,
    );
    return;
  }

  if (data === "apply_dedup_confirmed") {
    const report = await _duplicateCleanerRunner({ apply: true });
    let resultCard =
      `✅ *Duplicate Pruning Complete*\n\n` +
      `• *Books Scanned:* ${report.totalBooksScanned}\n` +
      `• *Duplicate Books Pruned:* ${report.totalPruned}\n` +
      `• *Duplicate Groups Resolved:* ${report.duplicateGroupsCount}\n`;

    if (report.auditLogPath) {
      resultCard += `• *Audit Log:* \`${escapeTelegramMarkdown(report.auditLogPath)}\`\n`;
    }

    if (report.errors.length > 0) {
      resultCard += `\n⚠️ *Encountered ${report.errors.length} error(s):*\n`;
      for (const err of report.errors.slice(0, 3)) {
        resultCard += `- ${escapeTelegramMarkdown(err.message)}\n`;
      }
    } else {
      resultCard += `\n_Your library is now deduplicated. Keepers retain all metadata and reading progress._`;
    }

    const keyboard = {
      inline_keyboard: [
        [
          { text: "🔄 Rescan", callback_data: "rescan_dedup" },
          { text: "📖 Open Reading HQ", web_app: { url: READING_WEBAPP_URL } },
        ],
        [{ text: "🏠 Main Menu", callback_data: "menu:main" }],
      ],
    };

    await editOrSendMessage(
      chatId,
      messageId,
      resultCard,
      "Markdown",
      keyboard,
    );
    return;
  }

  if (data === "cancel_dedup") {
    const cancelMsg = "❌ *Duplicate pruning cancelled. No books were modified.*";
    const cancelKeyboard = {
      inline_keyboard: [
        [
          { text: "🔄 Rescan", callback_data: "rescan_dedup" },
          { text: "🏠 Main Menu", callback_data: "menu:main" },
        ],
      ],
    };
    await editOrSendMessage(
      chatId,
      messageId,
      cancelMsg,
      "Markdown",
      cancelKeyboard,
    );
    return;
  }

  if (data.startsWith("delete_book:")) {
    const rawId = data.replace("delete_book:", "").trim();
    const bookId = parseInt(rawId, 10);
    if (!isNaN(bookId) && bookId > 0) {
      const delRes = deleteBookFromLibrary(bookId);
      if (delRes.success) {
        await editOrSendMessage(
          chatId,
          messageId,
          `🗑️ *Book Removed*\n\n*${escapeTelegramMarkdown(delRes.title || `Book #${bookId}`)}* has been deleted from your Calibre library.`,
          "Markdown",
          {
            inline_keyboard: [
              [
                {
                  text: "📖 Open Reading HQ",
                  web_app: { url: READING_WEBAPP_URL },
                },
                { text: "🔙 Main Menu", callback_data: "menu:main" },
              ],
            ],
          },
        );
      } else {
        await editOrSendMessage(
          chatId,
          messageId,
          `⚠️ *Failed to Delete Book #${bookId}*\n\n${escapeTelegramMarkdown(delRes.error || "Unknown error")}`,
          "Markdown",
        );
      }
    } else {
      await sendMessage(chatId, `❌ Invalid book ID: \`${rawId}\``, "Markdown");
    }
    return;
  }

  if (data.startsWith("send_book:")) {
    const rawId = data.replace("send_book:", "").trim();
    const bookId = parseInt(rawId, 10);
    if (!isNaN(bookId) && bookId > 0) {
      await retrieveAndSendBook(chatId, bookId);
    } else {
      await sendMessage(chatId, `❌ Invalid book ID: \`${rawId}\``, "Markdown");
    }
    return;
  }

  if (data.startsWith("retry:") || data.startsWith("retry_file:")) {
    let fileId = "";
    let cachedFileName = "";
    let cachedFileSize = 0;

    if (data.startsWith("retry:")) {
      const token = data.replace("retry:", "").trim();
      const entry = pendingRetries.get(token);
      if (entry) {
        fileId = entry.fileId;
        cachedFileName = entry.fileName;
        cachedFileSize = entry.fileSize;
      } else {
        // Fallback: if token was actually a direct fileId (e.g. backward compat)
        fileId = token;
      }
    } else {
      fileId = data.replace("retry_file:", "").trim();
    }

    if (!fileId) {
      await sendMessage(chatId, `❌ Invalid file ID for retry`, "Markdown");
      return;
    }

    try {
      const fileRes = await tgFetch(`getFile?file_id=${fileId}`, {
        timeoutMs: 20000,
      });
      const fileJson = (await fileRes.json()) as any;

      if (!fileJson.ok || !fileJson.result?.file_path) {
        const errMsg =
          fileJson.description || "Failed to retrieve file from Telegram";
        await sendMessage(
          chatId,
          `⚠️ *Retry Failed*\n\nUnable to retrieve file from Telegram: ${errMsg}`,
          "Markdown",
        );
        return;
      }

      const filePath = fileJson.result.file_path;
      const fileName = cachedFileName || path.basename(filePath || "retry.epub");
      const fileSize = fileJson.result.file_size || cachedFileSize || 0;

      const item: QueuedDoc = {
        doc: {
          file_id: fileId,
          file_name: fileName,
          file_size: fileSize,
        },
        fileName,
        fileSize,
        chatId,
        sender,
      };

      await processBatch(chatId, [item]);
    } catch (err: any) {
      logError(`Failed to retry file import ${fileId}: ${err?.message || err}`);
      await sendMessage(
        chatId,
        `⚠️ *Retry Failed*\n\nError initiating retry: ${err?.message || err}`,
        "Markdown",
      );
    }
    return;
  }
}

export interface IngestResult {
  success: boolean;
  duplicate: boolean;
  attachedFormat?: boolean;
  bookId?: number | null;
  displayTitle: string;
  author: string;
  format: string;
  message?: string;
  error?: string;
}

export async function ingestBookFile(
  filePath: string,
  originalFileName: string,
  chatId?: number,
): Promise<IngestResult> {
  const ext = path.extname(originalFileName).toLowerCase();
  const format = normalizeFormat(ext);
  const preliminary = sanitizeMetadata("", "", [], originalFileName);
  const epubMeta = extractEpubMetadata(filePath);
  const candidateTitle = epubMeta.title || preliminary.title;
  const candidateAuthor = epubMeta.author && epubMeta.author !== "Unknown" ? epubMeta.author : preliminary.author;
  const candidateComments = epubMeta.description || "";

  // Enforce canonical EPUB format (rejects non-EPUB and hidden/resource-fork files)
  if (!isCanonicalEpub(originalFileName)) {
    return {
      success: false,
      duplicate: false,
      format,
      displayTitle: candidateTitle,
      author: candidateAuthor,
      error: `Rejected non-canonical format "${originalFileName}". home-reading-stack accepts only valid .epub files.`,
    };
  }

  // Junk Ingest Gate: check before proceeding with Calibre add
  const junkCheck = await evaluateJunkGate(
    candidateTitle,
    originalFileName,
    candidateAuthor,
  );
  if (junkCheck.quarantined) {
    log(`[TelegramBot] Quarantined book "${originalFileName}": ${junkCheck.reason}`);
    moveToQuarantine(filePath, path.basename(originalFileName));
    return {
      success: false,
      duplicate: false,
      format,
      displayTitle: candidateTitle,
      author: candidateAuthor,
      error: `Quarantined by junk ingest gate: ${junkCheck.reason || "Invalid artifact"}`,
    };
  }

  // 1. Level 1: KOReader Binary Checksum Deduplication
  const fileHash = getKOReaderBinary256(filePath);
  let hashMatch: any = null;
  if (fileHash) {
    hashMatch = cacheDb
      .query(
        "SELECT book_id, title, authors FROM file_hashes WHERE hash = ? LIMIT 1",
      )
      .get(fileHash) as any;
  }

  // 1b. Content-Signature Fingerprint: fallback if binary SHA-256 is a cache miss
  const contentSig = getEpubContentSignature(filePath);
  if (!hashMatch && contentSig) {
    const candidateMatch = cacheDb
      .query(
        "SELECT book_id, title, authors FROM file_hashes WHERE hash = ? LIMIT 1",
      )
      .get(contentSig) as any;

    if (candidateMatch && candidateMatch.book_id) {
      // Validate volume compatibility before accepting content signature duplicates
      const volIncoming = extractVolumeNumber(candidateTitle);
      const volMatch = extractVolumeNumber(candidateMatch.title || "");
      const seriesIncoming = extractSeries(candidateTitle, originalFileName);
      const seriesMatch = extractSeries(candidateMatch.title || "");

      let hasVolumeConflict = false;
      if (volIncoming !== null && volMatch !== null && volIncoming !== volMatch) {
        hasVolumeConflict = true;
      } else if (
        seriesIncoming &&
        seriesMatch &&
        seriesIncoming.volume !== seriesMatch.volume
      ) {
        const normSI = normalizeTitleForDedup(seriesIncoming.series);
        const normSM = normalizeTitleForDedup(seriesMatch.series);
        if (normSI === normSM || normSI.startsWith(normSM) || normSM.startsWith(normSI)) {
          hasVolumeConflict = true;
        }
      }

      if (hasVolumeConflict) {
        log(
          `[Dedup] Content signature matched ID ${candidateMatch.book_id} ("${candidateMatch.title}") but volume conflicts with incoming ("${candidateTitle}"). Bypassing signature match.`,
        );
      } else {
        hashMatch = candidateMatch;
        log(
          `Duplicate detected via EPUB content signature: "${hashMatch.title}" (ID: ${hashMatch.book_id})`,
        );
      }
    }
  }

  // Final Volume Gate on any hash-based duplicate match
  if (hashMatch && hashMatch.book_id) {
    const volIncoming = extractVolumeNumber(candidateTitle);
    const volMatch = extractVolumeNumber(hashMatch.title || "");
    const seriesIncoming = extractSeries(candidateTitle, originalFileName);
    const seriesMatch = extractSeries(hashMatch.title || "");

    let hasVolumeConflict = false;
    if (volIncoming !== null && volMatch !== null && volIncoming !== volMatch) {
      hasVolumeConflict = true;
    } else if (
      seriesIncoming &&
      seriesMatch &&
      seriesIncoming.volume !== seriesMatch.volume
    ) {
      const normSI = normalizeTitleForDedup(seriesIncoming.series);
      const normSM = normalizeTitleForDedup(seriesMatch.series);
      if (normSI === normSM || normSI.startsWith(normSM) || normSM.startsWith(normSI)) {
        hasVolumeConflict = true;
      }
    }

    if (hasVolumeConflict) {
      log(
        `[Dedup] Hash match found ID ${hashMatch.book_id} ("${hashMatch.title}") but volume conflicts with incoming ("${preliminary.title}"). Bypassing hash match.`,
      );
      hashMatch = null;
    }
  }

  if (hashMatch && hashMatch.book_id) {
    log(
      `Duplicate detected via hash/signature: "${hashMatch.title}" (ID: ${hashMatch.book_id})`,
    );
    return {
      success: true,
      duplicate: true,
      bookId: hashMatch.book_id,
      displayTitle: hashMatch.title || preliminary.title,
      author: hashMatch.authors || preliminary.author,
      format,
      message: "Already in your library (identical content)",
    };
  }

  // 2. Level 2: Semantic Title, Serialization & Format Deduplication
  const incomingSeries = await extractSeriesWithJev(
    candidateTitle,
    originalFileName,
    extractSeries,
  );

  try {
    const listRes = runCalibredb([
      "list",
      "--with-library",
      SERVER_URL,
      "--fields",
      "id,title,authors,formats,series,series_index",
      "--for-machine",
    ]);

    let books: any[] = [];
    if (listRes.status === 0 && listRes.stdout) {
      const parsed = safeParseJson(listRes.stdout);
      if (Array.isArray(parsed)) books = parsed;
    }

    let existingBook: any = null;
    for (const b of books) {
      if (
        await isSameBookAsync(
          {
            title: b.title,
            authors: b.authors,
            series: b.series,
            series_index: b.series_index,
          },
          {
            title: candidateTitle,
            author: candidateAuthor,
            series: incomingSeries,
          },
        )
      ) {
        existingBook = b;
        break;
      }
    }

    if (existingBook) {
      log(
        `Duplicate detected via title/series match: "${existingBook.title}" (existing library book)`,
      );
      return {
        success: true,
        duplicate: true,
        bookId: existingBook.id,
        displayTitle: existingBook.title,
        author: existingBook.authors || preliminary.author,
        format,
        message: `Already exists in library`,
      };
    }

    // 3. Level 3: Add to Calibre with --automerge ignore guard, language, and category tagging
    const preClassification = await resolveBookLanguageAndTags({
      title: candidateTitle,
      author: candidateAuthor,
      comments: candidateComments,
      filename: originalFileName,
      tags: preliminary.tags || [],
      embeddedLanguage: epubMeta.language,
    });

    const addArgs = [
      "add",
      filePath,
      "--with-library",
      SERVER_URL,
      "--automerge",
      "ignore",
    ];
    if (preClassification.language && preClassification.language !== "other") {
      addArgs.push("--languages", preClassification.language);
    }
    if (epubMeta.title) addArgs.push("--title", epubMeta.title);
    if (epubMeta.author && epubMeta.author !== "Unknown")
      addArgs.push("--authors", epubMeta.author);
    if (preClassification.tags.length > 0)
      addArgs.push("--tags", preClassification.tags.join(","));

    const addRes = runCalibredb(addArgs);

    if (addRes.status === 0) {
      const match = addRes.stdout?.match(/Added book ids?:?\s*([0-9]+)/i);
      const newId = match ? parseInt(match[1]) : null;

      let finalTitle = preliminary.title;
      let finalAuthor = preliminary.author;

      if (newId) {
        // Fetch embedded OPF metadata extracted by Calibre
        const listOne = runCalibredb([
          "list",
          "--with-library",
          SERVER_URL,
          "--search",
          `id:${newId}`,
          "--fields",
          "id,title,authors,tags,series,series_index",
          "--for-machine",
        ]);

        let rawTitle = "";
        let rawAuthors = "";
        let rawTags: string[] = [];
        let rawSeries = "";

        if (listOne.status === 0 && listOne.stdout) {
          const parsed = safeParseJson(listOne.stdout);
          if (Array.isArray(parsed) && parsed[0]) {
            rawTitle = parsed[0].title || "";
            rawAuthors = parsed[0].authors || "";
            rawTags = parsed[0].tags || [];
            rawSeries = parsed[0].series || "";
          }
        }

        const clean = sanitizeMetadata(
          rawTitle,
          rawAuthors,
          rawTags,
          originalFileName,
        );
        finalTitle = clean.title || candidateTitle;
        finalAuthor = clean.author || candidateAuthor;
        finalAuthor = await cleanAuthorWithJev(finalAuthor, finalTitle);

        const finalClassification = await resolveBookLanguageAndTags({
          title: finalTitle,
          author: finalAuthor,
          comments: candidateComments,
          filename: originalFileName,
          tags: clean.tags || [],
          embeddedLanguage: epubMeta.language,
        });

        const setArgs = [
          "set_metadata",
          String(newId),
          "--with-library",
          SERVER_URL,
        ];
        if (clean.title && clean.title !== rawTitle)
          setArgs.push("--field", `title:${clean.title}`);
        if (
          finalAuthor &&
          finalAuthor !== rawAuthors
        )
          setArgs.push("--field", `authors:${finalAuthor}`);
        if (finalClassification.tags && finalClassification.tags.length)
          setArgs.push("--field", `tags:${finalClassification.tags.join(",")}`);
        if (finalClassification.language !== "other") {
          setArgs.push("--field", `languages:${finalClassification.language}`);
        }

        // Serialization auto-tagging
        if (!rawSeries && incomingSeries) {
          setArgs.push("--field", `series:${incomingSeries.series}`);
          setArgs.push("--field", `series_index:${incomingSeries.volume}`);
          log(
            `Auto-assigned series "${incomingSeries.series}" #${incomingSeries.volume} to ID ${newId}`,
          );
        }

        // Check if comments metadata is empty or placeholder and auto-populate
        let synopsis = extractEpubDescription(filePath);
        if (!synopsis && candidateComments && !isCommentsEmpty(candidateComments)) {
          synopsis = sanitizeSynopsis(candidateComments);
        }
        if (synopsis && !isCommentsEmpty(synopsis)) {
          setArgs.push("--field", `comments:${synopsis}`);
        }

        if (setArgs.length > 4) {
          runCalibredb(setArgs);
        }

        // If EPUB did not have comments, attempt online synopsis auto-enrichment in background
        if (!synopsis) {
          autoEnrichBookSynopsis(newId, {
            filePath,
            title: finalTitle,
            author: finalAuthor,
            series: incomingSeries?.series || rawSeries,
            series_index: incomingSeries?.volume,
            tags: finalClassification.tags || [],
            filename: originalFileName,
          }).catch(() => {});
        }

        // Cache binary hash for instant future deduplication
        if (fileHash) {
          cacheDb.run(
            "INSERT OR REPLACE INTO file_hashes (filepath, mtime, hash, book_id, title, authors, cover) VALUES (?, ?, ?, ?, ?, ?, ?)",
            filePath,
            Date.now(),
            fileHash,
            newId,
            finalTitle,
            finalAuthor,
            0,
          );
        }

        // Cache content signature for recompressed identical copies deduplication
        if (contentSig && contentSig !== fileHash) {
          cacheDb.run(
            "INSERT OR REPLACE INTO file_hashes (filepath, mtime, hash, book_id, title, authors, cover) VALUES (?, ?, ?, ?, ?, ?, ?)",
            `sig:${newId}`,
            Date.now(),
            contentSig,
            newId,
            finalTitle,
            finalAuthor,
            0,
          );
        }

        // Durable metadata enrichment via Job Queue
        const isManga =
          format === "CBZ" ||
          format === "CBR" ||
          (clean.tags || []).some((t) => /manga|comic/i.test(t));
        getJobQueue(getCacheDb()).enqueue("metadata_enrich", {
          bookId: newId,
          title: finalTitle,
          author: finalAuthor,
          filename: originalFileName,
          tags: clean.tags || [],
          isManga,
          chatId,
        });
      }

      return {
        success: true,
        duplicate: false,
        bookId: newId,
        displayTitle: finalTitle,
        author: finalAuthor,
        format,
        message: incomingSeries
          ? `Added (${incomingSeries.series} #${incomingSeries.volume})`
          : `Added to library`,
      };
    } else {
      return {
        success: false,
        duplicate: false,
        displayTitle: preliminary.title || originalFileName,
        author: preliminary.author,
        format,
        error: addRes.stderr || "Failed to add book to Calibre",
      };
    }
  } catch (err: any) {
    return {
      success: false,
      duplicate: false,
      displayTitle: preliminary.title || originalFileName,
      author: preliminary.author,
      format,
      error: err.message,
    };
  }
}

interface QueuedDoc {
  doc: any;
  fileName: string;
  fileSize: number;
  chatId: number;
  sender: string;
}

const pendingBatches = new Map<
  number,
  {
    docs: QueuedDoc[];
    timer: any;
  }
>();

async function processBatch(chatId: number, items: QueuedDoc[]) {
  if (items.length === 0) return;

  const isBatch = items.length > 1;
  const total = items.length;
  log(`Processing batch of ${total} item(s) for chat ${chatId}`);

  let statusMsgId: number | null = null;
  if (isBatch) {
    statusMsgId = await sendMessage(
      chatId,
      `\uD83D\uDCE5 Received *${total}* books. Starting batch ingestion...`,
      "Markdown",
    );
  }

  const results: Array<{
    name: string;
    title?: string;
    author?: string;
    format?: string;
    bookId?: number | null;
    attachedFormat?: boolean;
    status: "success" | "duplicate" | "error";
    note: string;
    fileId?: string;
  }> = [];

  for (let i = 0; i < items.length; i++) {
    const item = items[i];
    const { doc, fileName, fileSize, sender } = item;
    const sizeMB = (fileSize / (1024 * 1024)).toFixed(2);
    const ext = path.extname(fileName).toLowerCase();
    const format = normalizeFormat(ext);

    log(
      `[Batch ${i + 1}/${total}] Processing "${fileName}" (${sizeMB} MB) from ${sender}`,
    );

    const isArchive = isArchiveFile(fileName);
    const isEpub = isCanonicalEpub(fileName);

    if (!isArchive && !isEpub) {
      const isKnownNonEpub = REJECTED_EXTS.includes(ext);
      results.push({
        name: fileName,
        format,
        status: "error",
        note: isKnownNonEpub
          ? `Rejected non-EPUB format (${ext}). home-reading-stack is an EPUB-only library collection. Please upload .epub files or archives containing .epub files.`
          : `Rejected non-canonical or hidden file: "${fileName}". home-reading-stack accepts only valid .epub files (or archives containing .epub).`,
        fileId: doc?.file_id,
      });
      continue;
    }

    if (fileSize > MAX_TELEGRAM_FILE_SIZE) {
      results.push({
        name: fileName,
        format,
        status: "error",
        note: `Exceeds 20MB limit (${sizeMB} MB). Use Web Uploader: ${WEB_UPLOADER_URL}`,
        fileId: doc?.file_id,
      });
      continue;
    }

    if (isBatch) {
      await editOrSendMessage(
        chatId,
        statusMsgId,
        `⏳ *[${i + 1}/${total}]* Ingesting "${fileName}"...`,
        "Markdown",
      );
    } else {
      statusMsgId = await sendMessage(
        chatId,
        `⏳ Downloading & Ingesting "${fileName}" (${sizeMB} MB)...`,
      );
    }

    // Download from Telegram
    try {
      const fileRes = await tgFetch(`getFile?file_id=${doc.file_id}`, {
        timeoutMs: 20000,
      });
      const fileJson = (await fileRes.json()) as any;

      if (!fileJson.ok || !fileJson.result?.file_path) {
        const errMsg =
          fileJson.description || "Failed to retrieve file from Telegram";
        results.push({
          name: fileName,
          format,
          status: "error",
          note: errMsg,
          fileId: doc?.file_id,
        });
        continue;
      }

      const token = getTelegramBotToken();
      const dlUrl = `https://api.telegram.org/file/bot${token}/${fileJson.result.file_path}`;
      const expectedSize = doc.file_size || fileJson.result.file_size || 0;

      let arrayBuf: ArrayBuffer | null = null;
      let lastDlError = "";
      const MAX_DL_RETRIES = 3;

      for (let attempt = 1; attempt <= MAX_DL_RETRIES; attempt++) {
        try {
          const dl = await safeFetchWithSsrf(dlUrl, {
            proxy: PROXY_URL,
            signal: AbortSignal.timeout(60000),
          } as any);

          if (!dl.ok) {
            lastDlError = `Download failed (HTTP ${dl.status})`;
            logError(`[TelegramBot] Download attempt ${attempt}/${MAX_DL_RETRIES} failed for "${fileName}": ${lastDlError}`);
            continue;
          }

          const buf = await dl.arrayBuffer();
          if (expectedSize > 0 && buf.byteLength < expectedSize) {
            lastDlError = `Download truncated (${buf.byteLength}/${expectedSize} bytes)`;
            logError(`[TelegramBot] Download attempt ${attempt}/${MAX_DL_RETRIES} truncated for "${fileName}": ${lastDlError}`);
            continue;
          }

          arrayBuf = buf;
          break;
        } catch (dlErr: any) {
          lastDlError = dlErr?.message || "Network error";
          logError(`[TelegramBot] Download attempt ${attempt}/${MAX_DL_RETRIES} error for "${fileName}": ${lastDlError}`);
        }
      }

      if (!arrayBuf) {
        results.push({
          name: fileName,
          format,
          status: "error",
          note: lastDlError || "Download failed",
          fileId: doc?.file_id,
        });
        continue;
      }
      // Junk Ingest Gate: check before writing into Books_Drop or performing heavy work
      const preliminaryCheck = sanitizeMetadata("", "", [], fileName);
      const preJunk = await evaluateJunkGate(
        preliminaryCheck.title,
        fileName,
        preliminaryCheck.author,
      );
      if (preJunk.quarantined) {
        log(`[TelegramBot] Quarantined download "${fileName}": ${preJunk.reason}`);
        const safeBaseName = path.basename(fileName);
        const tempPreFile = path.join(os.tmpdir(), `pre_q_${Date.now()}_${safeBaseName}`);
        fs.writeFileSync(tempPreFile, new Uint8Array(arrayBuf));
        moveToQuarantine(tempPreFile, safeBaseName);
        await sendMessage(
          chatId,
          `⚠️ *File Quarantined*\nFile "${fileName}" was quarantined by Junk Ingest Gate (${preJunk.reason || "Invalid artifact"}).`,
          "Markdown",
        );
        results.push({
          name: fileName,
          format,
          status: "error",
          note: `Quarantined: ${preJunk.reason || "Invalid artifact"}`,
          fileId: doc?.file_id,
        });
        continue;
      }

      const uniqueSuffix = `${Date.now()}_${Math.random().toString(36).substring(2, 6)}`;
      const safeBase = path.basename(fileName, ext);
      const tempFileName = `${safeBase}_${uniqueSuffix}${ext}`;
      const destPath = path.join(getDropDir(), tempFileName);

      fs.writeFileSync(destPath, new Uint8Array(arrayBuf));

      if (!isArchiveFile(fileName)) {
        let contentValidation = validateEpubContent(destPath);
        if (!contentValidation.valid) {
          const errStr = (contentValidation.error || "").toLowerCase();
          const isMissingCentralDir =
            errStr.includes("failed to read epub zip entries") ||
            errStr.includes("central directory") ||
            errStr.includes("end-of-central-directory") ||
            errStr.includes("unreadable") ||
            errStr.includes("truncated") ||
            errStr.includes("damaged") ||
            errStr.includes("cannot find zipfile directory");

          if (isMissingCentralDir) {
            log(
              `[TelegramBot] Attempting in-process auto-heal for "${fileName}" after initial validation failure (${contentValidation.error})...`,
            );
            const repaired = repairTruncatedEpub(destPath);
            if (repaired) {
              log(
                `[TelegramBot] Successfully auto-healed truncated EPUB "${fileName}" via in-process repair`,
              );
              contentValidation = validateEpubContent(destPath);
            }
          }
        }

        if (!contentValidation.valid) {
          logError(
            `[TelegramBot] EPUB validation failed for "${fileName}": ${contentValidation.error}`,
          );
          try {
            fs.unlinkSync(destPath);
          } catch {
            // ignore unlink error
          }
          results.push({
            name: fileName,
            format,
            status: "error",
            note: `Invalid EPUB file: ${contentValidation.error}`,
            fileId: doc?.file_id,
          });
          continue;
        }
      }

      if (isArchiveFile(fileName)) {
        log(`Unpacking archive "${fileName}"...`);
        const unp = unpackArchive(destPath);
        try {
          fs.unlinkSync(destPath);
        } catch {}

        if (!unp.success) {
          results.push({
            name: fileName,
            format,
            status: "error",
            note: unp.error || "Archive extraction failed",
            fileId: doc?.file_id,
          });
          continue;
        }

        if (unp.books.length === 0) {
          unp.cleanup();
          results.push({
            name: fileName,
            format,
            status: "error",
            note: unp.error || "No supported EPUB books found in archive",
            fileId: doc?.file_id,
          });
          continue;
        }

        log(`Archive "${fileName}" yielded ${unp.books.length} EPUB book(s)`);
        // Track any quarantined non-EPUB files from the archive
        if (unp.quarantined && unp.quarantined.length > 0) {
          for (const q of unp.quarantined) {
            results.push({
              name: q.name,
              format: q.format,
              status: "error",
              note: q.reason,
            });
          }
        }
        for (const b of unp.books) {
          const r = await ingestBookFile(b.tempPath, b.originalName, chatId);
          results.push({
            name: b.originalName,
            title: r.displayTitle,
            author: r.author,
            format: r.format,
            bookId: r.bookId,
            attachedFormat: r.attachedFormat,
            status: r.duplicate ? "duplicate" : r.success ? "success" : "error",
            note: r.message || r.error || "Processed",
          });
        }
        unp.cleanup();
        continue;
      }

      const res = await ingestBookFile(destPath, fileName, chatId);
      try {
        fs.unlinkSync(destPath);
      } catch {}

      results.push({
        name: fileName,
        title: res.displayTitle,
        author: res.author,
        format: res.format,
        bookId: res.bookId,
        attachedFormat: res.attachedFormat,
        status: res.duplicate ? "duplicate" : res.success ? "success" : "error",
        note:
          res.message ||
          res.error ||
          (res.success ? "Added" : "Calibre ingest failed"),
        fileId: doc?.file_id,
      });
    } catch (err: any) {
      results.push({
        name: fileName,
        format,
        status: "error",
        note: err.message,
        fileId: doc?.file_id,
      });
    }
  }

  // Send Final Status with Rich Details and Calibre Links
  if (isBatch) {
    const successCount = results.filter((r) => r.status === "success").length;
    const duplicateCount = results.filter(
      (r) => r.status === "duplicate",
    ).length;
    const totalSuccess = successCount + duplicateCount;

    let summary = `\uD83D\uDCDA *Batch Ingestion Complete* (${totalSuccess}/${total} processed)\n\n`;

    for (const r of results) {
      const link = r.bookId
        ? `[Open](${CALIBRE_WEB_URL}/#book_id=${r.bookId}&panel=book_details)`
        : "";
      const authorStr =
        r.author && r.author !== "Unknown" ? ` by _${r.author}_` : "";
      const fmtStr = r.format ? `[\`${r.format}\`]` : "";

      if (r.status === "success") {
        summary += `✅ *${r.title || r.name}* ${fmtStr}${authorStr}\n   └ ${r.note} ${link ? `• ${link}` : ""}\n`;
      } else if (r.status === "duplicate") {
        summary += `ℹ️ *${r.title || r.name}* ${fmtStr}${authorStr}\n   └ ${r.note} ${link ? `• ${link}` : ""}\n`;
      } else {
        summary += `⚠️ \`${r.name}\`\n   └ ${r.note}\n`;
      }
    }

    summary += `\n✨ _All books are cataloged and ready on your Kindle OPDS feed._`;
    const validBooks = results.filter(
      (r) => r.bookId && (r.status === "success" || r.status === "duplicate"),
    );
    let batchKeyboard: any;
    if (validBooks.length === 1 && validBooks[0].bookId) {
      batchKeyboard = getPostIngestionKeyboard(validBooks[0].bookId);
    } else if (validBooks.length > 1) {
      const rows: any[][] = [];
      for (const b of validBooks.slice(0, 4)) {
        rows.push([
          {
            text: `📥 Send "${truncate(b.title || b.name, 16)}"`,
            callback_data: `send_book:${b.bookId}`,
          },
          { text: "🗑️ Undo", callback_data: `delete_book:${b.bookId}` },
        ]);
      }
      rows.push([
        { text: "📖 Open Reading HQ", web_app: { url: READING_WEBAPP_URL } },
      ]);
      batchKeyboard = { inline_keyboard: rows };
    }
    await editOrSendMessage(
      chatId,
      statusMsgId,
      summary,
      "Markdown",
      batchKeyboard,
    );
  } else {
    const single = results[0];
    const detailsLink = single.bookId
      ? `[Book Details](${CALIBRE_WEB_URL}/#book_id=${single.bookId}&panel=book_details)`
      : "";
    const readerLink =
      single.bookId && single.format
        ? `[Read Online](${CALIBRE_WEB_URL}/read/${single.bookId}/${single.format.toLowerCase()})`
        : "";
    const links = [detailsLink, readerLink].filter(Boolean).join(" • ");

    const postIngestKeyboard = single.bookId
      ? getPostIngestionKeyboard(single.bookId)
      : undefined;

    if (single.status === "success") {
      const actionHeader = single.attachedFormat
        ? "\uD83D\uDCCE *Format Attached*"
        : "✅ *Book Ingested Successfully*";
      await editOrSendMessage(
        chatId,
        statusMsgId,
        `${actionHeader}\n\n` +
          `\uD83D\uDCD6 *Title:* ${single.title || single.name}\n` +
          `\uD83D\uDC64 *Author:* ${single.author || "Unknown"}\n` +
          `\uD83D\uDCE6 *Format:* \`${single.format || "Unknown"}\`\n` +
          `ℹ️ ${single.note}\n\n` +
          (links ? `\uD83D\uDD17 ${links}\n\n` : "") +
          `_Ready on your Kindle OPDS feed._`,
        "Markdown",
        postIngestKeyboard,
      );
    } else if (single.status === "duplicate") {
      await editOrSendMessage(
        chatId,
        statusMsgId,
        `ℹ️ *Book Already in Library*\n\n` +
          `\uD83D\uDCD6 *Title:* ${single.title || single.name}\n` +
          `\uD83D\uDC64 *Author:* ${single.author || "Unknown"}\n` +
          `\uD83D\uDCE6 *Format:* \`${single.format || "Unknown"}\`\n` +
          `ℹ️ ${single.note}\n\n` +
          (links ? `\uD83D\uDD17 ${links}\n\n` : "") +
          `_Available on your Kindle and Calibre._`,
        "Markdown",
        postIngestKeyboard,
      );
    } else {
      const isOverSize = single.note.includes("20MB");
      const retryKeyboard =
        single.fileId && !isOverSize
          ? getRetryImportKeyboard(single.fileId, {
              fileName: single.name,
              chatId,
            })
          : undefined;
      await editOrSendMessage(
        chatId,
        statusMsgId,
        `⚠️ *Import Failed*\n\n` +
          `\uD83D\uDCC4 *File:* \`${single.name}\`\n` +
          `❌ *Error:* ${single.note}\n\n` +
          (isOverSize
            ? `\uD83D\uDC49 Upload directly via [Web Uploader](${WEB_UPLOADER_URL}) to bypass the 20MB limit.`
            : `Please check the file format and try again.`),
        "Markdown",
        retryKeyboard,
      );
    }
  }
}

export { processBatch, processBatch as batchProcessFiles };

let offset = 0;
let backoffMs = INITIAL_BACKOFF_MS;
let isPollingRunning = true;

process.on("SIGINT", () => {
  log("Received SIGINT, stopping poll loop...");
  isPollingRunning = false;
});
process.on("SIGTERM", () => {
  log("Received SIGTERM, stopping poll loop...");
  isPollingRunning = false;
});

let _searchUniversalMetadataRunner: typeof searchUniversalMetadata | null = null;
export function setSearchUniversalMetadataRunnerForTest(runner: typeof searchUniversalMetadata | null): void {
  _searchUniversalMetadataRunner = runner;
}

let _applyMetadataToCalibreRunner: typeof applyMetadataToCalibre | null = null;
export function setApplyMetadataToCalibreRunnerForTest(runner: typeof applyMetadataToCalibre | null): void {
  _applyMetadataToCalibreRunner = runner;
}

export function registerJobHandlers(q = getJobQueue(getCacheDb())) {
  q.registerHandler(
    "metadata_enrich",
    async (payload: {
      bookId: number;
      title: string;
      author?: string;
      filename?: string;
      tags?: string[];
      isManga?: boolean;
      chatId?: number;
    }) => {
      log(
        `[JobQueue:MetadataEnrich] Background enrichment for book ID ${payload.bookId} ("${payload.title}")...`,
      );

      // Detect if target book has a volume number
      let targetVol =
        extractVolumeNumber(payload.title) ??
        (payload.filename ? extractVolumeNumber(payload.filename) : null);
      try {
        const db = new Database(getCalibreDbPath(), { readonly: true });
        const bookRow = db
          .prepare(
            "SELECT b.title, b.series_index, s.name as series FROM books b LEFT JOIN books_series_link bsl ON b.id = bsl.book LEFT JOIN series s ON bsl.series = s.id WHERE b.id = ?",
          )
          .get(payload.bookId) as any;
        db.close();
        if (targetVol === null && bookRow) {
          if (
            bookRow.series &&
            bookRow.series_index !== undefined &&
            bookRow.series_index !== null &&
            !isNaN(Number(bookRow.series_index)) &&
            Number(bookRow.series_index) > 0
          ) {
            targetVol = Number(bookRow.series_index);
          } else if (bookRow.title) {
            targetVol = extractVolumeNumber(bookRow.title);
          }
        }
      } catch (_dbErr) {
        void _dbErr;
      }
      const hasVolume = targetVol !== null;

      const searchFn = _searchUniversalMetadataRunner ?? searchUniversalMetadata;
      const applyFn = _applyMetadataToCalibreRunner ?? applyMetadataToCalibre;

      const matches = await searchFn(payload.title, {
        isManga: payload.isManga,
        author: payload.author,
        filename: payload.filename,
        tags: payload.tags,
        preserveVolume: hasVolume,
      });
      if (matches.length > 0) {
        const top = matches[0];
        log(
          `[JobQueue:MetadataEnrich] Top match: "${top.title}" by "${top.authors}" (Confidence: ${top.confidence}, Source: ${top.source})`,
        );

        // Volume conflict check:
        // If target book has a volume, verify candidate does not have a conflicting volume
        const candidateVol = top.title ? extractVolumeNumber(top.title) : null;
        const isVolumeConflict =
          targetVol !== null &&
          ((candidateVol !== null && candidateVol !== targetVol) ||
            (targetVol > 1 && candidateVol === null));

        if (isVolumeConflict) {
          log(
            `[JobQueue:MetadataEnrich] Volume conflict for book ID ${payload.bookId}: target is Vol ${targetVol} but top match is "${top.title}" (Vol ${candidateVol ?? "none"}). Rejecting match to preserve original title and cover.`,
          );
        }

        if (top.confidence >= 0.85 && !isVolumeConflict) {
          const applied = await applyFn(payload.bookId, top);
          // Check if comments is still empty; if so, auto-populate synopsis
          try {
            const db = new Database(getCalibreDbPath(), { readonly: true });
            const row = db.prepare("SELECT text FROM comments WHERE book = ?").get(payload.bookId) as any;
            db.close();
            if (isCommentsEmpty(row?.text)) {
              await autoEnrichBookSynopsis(payload.bookId, {
                title: payload.title,
                author: payload.author,
                filename: payload.filename,
                tags: payload.tags,
              });
            }
          } catch (_dbErr) {
            void _dbErr;
          }
          if (applied && payload.chatId) {
            try {
              await sendMessage(
                payload.chatId,
                `✨ *Metadata Auto-Enriched*\n\n` +
                  `\uD83D\uDCD6 *Title:* ${escapeTelegramMarkdown(top.title)}\n` +
                  `\uD83D\uDC64 *Author:* ${escapeTelegramMarkdown(top.authors || "Unknown")}\n` +
                  `\uD83C\uDF10 *Source:* \`${escapeTelegramMarkdown(top.source)}\` (${Math.round(top.confidence * 100)}% match)`,
                "Markdown",
              );
            } catch (notifyErr) {
              log(
                `Failed to send enrichment notification to chat ${payload.chatId}: ${notifyErr}`,
              );
            }
          }
          return {
            success: applied,
            topMatch: top.title,
            confidence: top.confidence,
            source: top.source,
          };
        } else {
          // If match confidence < 0.85 or volume conflict, still auto-populate synopsis if comments is empty
          try {
            await autoEnrichBookSynopsis(payload.bookId, {
              title: payload.title,
              author: payload.author,
              filename: payload.filename,
              tags: payload.tags,
            });
          } catch (_enrichErr) {
            void _enrichErr;
          }
          return {
            success: true,
            message: isVolumeConflict
              ? `Volume conflict: target is Vol ${targetVol}, top match is "${top.title}". Preserved original title and cover.`
              : `Match confidence ${top.confidence} < 0.85. Preserved original title.`,
            topMatch: top.title,
            source: top.source,
          };
        }
      }

      // If no matches found, attempt synopsis auto-enrichment before Burmese check
      try {
        await autoEnrichBookSynopsis(payload.bookId, {
          title: payload.title,
          author: payload.author,
          filename: payload.filename,
          tags: payload.tags,
        });
      } catch (_enrichErr) {
        void _enrichErr;
      }

      // Check if this book is Burmese: if so, generate local typographic cover if missing
      const detCat = classifyBookSourceCategoryDeterministic(
        payload.title,
        payload.author || "",
        payload.filename || "",
        payload.tags || [],
      );
      if (detCat === "burmese" || containsBurmese(payload.title)) {
        let hasExistingCover = false;
        try {
          const db = new Database(getCalibreDbPath(), { readonly: true });
          const row = db.prepare("SELECT has_cover FROM books WHERE id = ?").get(payload.bookId) as any;
          db.close();
          hasExistingCover = Boolean(row?.has_cover);
        } catch (_dbErr) {
          void _dbErr;
        }

        if (!hasExistingCover) {
          try {
            const coverPath = generateTypographicCover(
              payload.title,
              payload.author || "Unknown",
              "Burmese Literature",
            );
            if (fs.existsSync(coverPath)) {
              const calRes = runCalibredb([
                "set_metadata",
                String(payload.bookId),
                "--with-library",
                SERVER_URL,
                "--field",
                `cover:${coverPath}`,
              ]);
              try {
                fs.unlinkSync(coverPath);
              } catch (_unlinkErr) {
                void _unlinkErr;
              }
              if (calRes.status === 0) {
                return {
                  success: true,
                  message: "Generated local typographic cover for Burmese literature.",
                  source: "Local Typography",
                };
              }
            }
          } catch (coverErr: any) {
            log(`Failed to generate Burmese typographic cover: ${coverErr?.message || coverErr}`);
          }
        }
      }

      return { success: true, message: "No external metadata matches found." };
    },
  );
  return q;
}

export function startJobWorker(intervalMs = 1000) {
  const q = registerJobHandlers();
  q.startWorker(intervalMs);
  return q;
}

let _localUploaderUrl: string | null = null;
export function setLocalUploaderUrlForTest(url: string | null): void {
  _localUploaderUrl = url;
}

export function getLocalUploaderUrl(): string {
  if (_localUploaderUrl) {
    return _localUploaderUrl.replace(/\/+$/, "");
  }
  if (process.env.LOCAL_UPLOADER_URL) {
    return process.env.LOCAL_UPLOADER_URL.replace(/\/+$/, "");
  }
  const port = process.env.UPLOADER_PORT || process.env.PORT || "8086";
  return `http://127.0.0.1:${port}`;
}

let _ingestLnoriSeriesRunner: typeof ingestLnoriSeries = ingestLnoriSeries;
export function setIngestLnoriSeriesRunnerForTest(
  runner: typeof ingestLnoriSeries | null,
): void {
  _ingestLnoriSeriesRunner = runner || ingestLnoriSeries;
}

let _ingestElscioneSeriesRunner: typeof ingestElscioneSeries = ingestElscioneSeries;
export function setIngestElscioneSeriesRunnerForTest(
  runner: typeof ingestElscioneSeries | null,
): void {
  _ingestElscioneSeriesRunner = runner || ingestElscioneSeries;
}

let _lnoriPollIntervalMs = 1500;
export function setLnoriPollIntervalForTest(ms: number): void {
  _lnoriPollIntervalMs = ms;
}

export interface LocalLnoriQueueItem {
  url: string;
  chatId: number;
  statusMsgId: number | null;
}
const localLnoriQueue: LocalLnoriQueueItem[] = [];
let isLocalLnoriActive = false;
const MAX_LOCAL_LNORI_QUEUE = 25;

export function getLocalLnoriQueue(): LocalLnoriQueueItem[] {
  return localLnoriQueue.map((item) => ({ ...item }));
}

export function resetLocalLnoriQueueForTest(): void {
  localLnoriQueue.length = 0;
  isLocalLnoriActive = false;
  _localUploaderUrl = null;
  _ingestLnoriSeriesRunner = ingestLnoriSeries;
  _ingestElscioneSeriesRunner = ingestElscioneSeries;
  _lnoriPollIntervalMs = 1500;
}

export async function sendLnoriCompletionCard(
  chatId: number,
  statusMsgId: number | null,
  _articleUrl: string,
  result: {
    seriesTitle?: string;
    author?: string;
    importedCount?: number;
    skippedCount?: number;
    totalCount?: number;
    tags?: string | string[];
  },
): Promise<number | null> {
  const seriesTitle = result.seriesTitle || "Light Novel Series";
  const author = result.author || "Unknown";
  const importedCount = result.importedCount ?? 0;
  const skippedCount = result.skippedCount ?? 0;
  const totalCount = result.totalCount ?? importedCount;
  const rawTags = result.tags;
  const tags = Array.isArray(rawTags)
    ? rawTags.join(", ")
    : rawTags || "Light Novel";

  const skipText =
    skippedCount > 0 ? ` (${skippedCount} already in library)` : "";

  const confirmation =
    `✅ *Light Novel Series Imported Successfully!*\n\n` +
    `📖 *Series:* ${escapeTelegramMarkdown(seriesTitle)}\n` +
    `✍️ *Author:* ${escapeTelegramMarkdown(author)}\n` +
    `📚 *Volumes Imported:* ${escapeTelegramMarkdown(String(importedCount))}/${escapeTelegramMarkdown(String(totalCount))}${escapeTelegramMarkdown(skipText)}\n` +
    `🏷️ *Tags:* ${escapeTelegramMarkdown(tags)}\n\n` +
    `_Ready in your library and syncable to KOReader._`;

  return await editOrSendMessage(
    chatId,
    statusMsgId,
    confirmation,
    "Markdown",
    {
      inline_keyboard: [
        [
          {
            text: "📖 Open Reading HQ",
            web_app: { url: READING_WEBAPP_URL },
          },
        ],
      ],
    },
  );
}

export async function sendLnoriErrorCard(
  chatId: number,
  statusMsgId: number | null,
  articleUrl: string,
  errorMsg: string,
): Promise<number | null> {
  const sourceName = isElscioneUrl(articleUrl) ? "Elscione" : "Lnori";
  const card =
    `⚠️ *${sourceName} Ingestion Failed*\n\n` +
    `🔗 *URL:* \`${escapeTelegramMarkdown(articleUrl)}\`\n` +
    `❌ *Error:* ${escapeTelegramMarkdown(errorMsg || `Failed to import ${sourceName} series`)}\n\n` +
    `_Please verify the link is accessible and try again._`;

  return await editOrSendMessage(chatId, statusMsgId, card, "Markdown");
}

export async function sendLnoriIncompleteCard(
  chatId: number,
  statusMsgId: number | null,
  articleUrl: string,
): Promise<number | null> {
  const sourceName = isElscioneUrl(articleUrl) ? "Elscione" : "Lnori";
  const card =
    `⚠️ *${sourceName} Ingestion Incomplete*\n\n` +
    `🔗 *URL:* \`${escapeTelegramMarkdown(articleUrl)}\`\n` +
    `❌ *Error:* No volumes could be imported from ${sourceName}.\n\n` +
    `_Please verify the link and try again._`;

  return await editOrSendMessage(chatId, statusMsgId, card, "Markdown");
}

export async function runDirectLnoriFallback(
  chatId: number,
  statusMsgId: number | null,
  articleUrl: string,
): Promise<void> {
  const isElscione = isElscioneUrl(articleUrl);
  const sourceName = isElscione ? "Elscione" : "Lnori";
  if (isLocalLnoriActive) {
    if (localLnoriQueue.length >= MAX_LOCAL_LNORI_QUEUE) {
      await editOrSendMessage(
        chatId,
        statusMsgId,
        `⚠️ *${sourceName} Ingestion Queue Full*\n\n` +
          `🔗 *URL:* \`${escapeTelegramMarkdown(articleUrl)}\`\n` +
          `⏳ *Status:* Local ingestion queue is full (${MAX_LOCAL_LNORI_QUEUE} items). Please wait for active downloads to finish.\n\n` +
          `_Please try again in a few moments._`,
        "Markdown",
      );
      return;
    }
    localLnoriQueue.push({ url: articleUrl, chatId, statusMsgId });
    const queuePosition = localLnoriQueue.length;
    const queueLength = localLnoriQueue.length;
    const queuedText =
      `⏳ *Queued ${sourceName} Light Novel Series (Position #${queuePosition} of ${queueLength})*\n` +
      `\`${escapeTelegramMarkdown(articleUrl)}\`\n\n` +
      `_Waiting for previous ingestion to finish..._`;
    const msgId = await editOrSendMessage(
      chatId,
      statusMsgId,
      queuedText,
      "Markdown",
    );
    if (msgId && !statusMsgId) statusMsgId = msgId;
    return;
  }

  isLocalLnoriActive = true;
  let currentJob: LocalLnoriQueueItem | null = {
    url: articleUrl,
    chatId,
    statusMsgId,
  };

  try {
    while (currentJob) {
      const activeUrl = currentJob.url;
      const activeChatId = currentJob.chatId;
      let activeMsgId = currentJob.statusMsgId;
      const currentIsElscione = isElscioneUrl(activeUrl);
      const activeSourceName = currentIsElscione ? "Elscione" : "Lnori";
      const runner = currentIsElscione
        ? _ingestElscioneSeriesRunner
        : _ingestLnoriSeriesRunner;
      const progressFormatter = currentIsElscione
        ? formatElscioneProgress
        : formatLnoriProgress;

      try {
        let lastProgressText = "";
        let lastEditTime = 0;
        const result = await runner(
          activeUrl,
          async (progress: any) => {
            const text =
              typeof progress === "string"
                ? progress
                : progressFormatter(progress);
            const now = Date.now();
            if (
              text &&
              (text !== lastProgressText || now - lastEditTime >= 1000)
            ) {
              lastProgressText = text;
              lastEditTime = now;
              const cleanText = escapeTelegramMarkdown(text);
              const msgId = await editOrSendMessage(
                activeChatId,
                activeMsgId,
                cleanText,
                "Markdown",
              );
              if (msgId && !activeMsgId) activeMsgId = msgId;
            }
          },
        );

        if (result && result.success) {
          if (result.importedCount === 0 && result.skippedCount === 0) {
            await sendLnoriIncompleteCard(activeChatId, activeMsgId, activeUrl);
          } else {
            await sendLnoriCompletionCard(
              activeChatId,
              activeMsgId,
              activeUrl,
              result,
            );
          }
        } else {
          await sendLnoriIncompleteCard(activeChatId, activeMsgId, activeUrl);
        }
      } catch (err: any) {
        logError(
          `Direct fallback ${activeSourceName} ingestion error for ${activeUrl}: ${err?.message || err}`,
        );
        await sendLnoriErrorCard(
          activeChatId,
          activeMsgId,
          activeUrl,
          err?.message || `Failed to import ${activeSourceName} series`,
        );
      }

      currentJob = localLnoriQueue.shift() || null;
      if (currentJob) {
        const nextSourceName = isElscioneUrl(currentJob.url) ? "Elscione" : "Lnori";
        const activatingText =
          `📖 *Detected ${nextSourceName} Light Novel Series*\n\`${escapeTelegramMarkdown(currentJob.url)}\`\n\n` +
          `⏳ _Fetching volume manifest..._`;
        const msgId = await editOrSendMessage(
          currentJob.chatId,
          currentJob.statusMsgId,
          activatingText,
          "Markdown",
        );
        if (msgId && !currentJob.statusMsgId) currentJob.statusMsgId = msgId;
      }
    }
  } finally {
    isLocalLnoriActive = false;
  }
}

export async function pollLnoriProgress(
  chatId: number,
  statusMsgId: number | null,
  articleUrl: string,
  runId: string,
  uploaderUrl: string,
  initialQueuePos: number | null = null,
  initialQueueLen: number | null = null,
  maxPollAttempts: number = 1200,
): Promise<void> {
  let lastReportedPos = initialQueuePos;
  let lastReportedLen = initialQueueLen;
  let lastProgressText = "";
  let lastEditTime = 0;
  let consecutiveErrors = 0;
  let pollAttempts = 0;

  while (pollAttempts < maxPollAttempts) {
    pollAttempts++;
    await new Promise((r) => setTimeout(r, _lnoriPollIntervalMs));

    let progData: any;
    try {
      const res = await safeFetchWithSsrf(
        `${uploaderUrl}/api/lnori/progress?runId=${encodeURIComponent(runId)}`,
        { timeoutMs: 15000 } as any,
        5,
        { allowInternalServices: true, bindIp: false },
      );
      if (!res.ok) {
        consecutiveErrors++;
        if (consecutiveErrors >= 5) {
          logError(
            `Progress polling failed with status ${res.status} after 5 attempts`,
          );
          await sendLnoriErrorCard(
            chatId,
            statusMsgId,
            articleUrl,
            `Polling error (${res.status})`,
          );
          return;
        }
        continue;
      }
      progData = await res.json();
      consecutiveErrors = 0;
    } catch (pollErr: any) {
      consecutiveErrors++;
      if (consecutiveErrors >= 5) {
        logError(
          `Progress polling network error after 5 attempts: ${pollErr?.message || pollErr}`,
        );
        await sendLnoriErrorCard(
          chatId,
          statusMsgId,
          articleUrl,
          "Connection lost while polling progress",
        );
        return;
      }
      continue;
    }

    if (!progData || !progData.success) {
      consecutiveErrors++;
      if (consecutiveErrors >= 5) {
        logError(
          `Progress polling returned success: false 5 consecutive times`,
        );
        await sendLnoriErrorCard(
          chatId,
          statusMsgId,
          articleUrl,
          "Failed to retrieve ingestion progress from server",
        );
        return;
      }
      continue;
    }

    const currentPos = progData.currentQueuePosition;
    const queueLength = progData.queueLength || 0;
    const state = progData.state || {};

    const sourceName = isElscioneUrl(articleUrl) ? "Elscione" : "Lnori";

    // 1. Still in queue
    if (currentPos !== null && currentPos !== undefined) {
      if (currentPos !== lastReportedPos || queueLength !== lastReportedLen) {
        lastReportedPos = currentPos;
        lastReportedLen = queueLength;
        const queuedText =
          `⏳ *Queued ${sourceName} Light Novel Series (Position #${currentPos} of ${queueLength})*\n` +
          `\`${escapeTelegramMarkdown(articleUrl)}\`\n\n` +
          `_Waiting for previous ingestion to finish..._`;
        const msgId = await editOrSendMessage(
          chatId,
          statusMsgId,
          queuedText,
          "Markdown",
        );
        if (msgId && !statusMsgId) statusMsgId = msgId;
      }
      continue;
    }

    // 2. Not in queue: verify state.runId matches target runId!
    if (state.runId !== runId) {
      logError(
        `${sourceName} progress state runId (${state.runId}) does not match target runId (${runId}) and item is not in queue`,
      );
      await sendLnoriErrorCard(
        chatId,
        statusMsgId,
        articleUrl,
        "Job was removed or could not be found in ingestion queue",
      );
      return;
    }

    // 3. Check terminal states
    if (state.phase === "complete") {
      const result = state.completedData || state.data || {};
      if (
        (result.importedCount ?? 0) === 0 &&
        (result.skippedCount ?? 0) === 0
      ) {
        await sendLnoriIncompleteCard(chatId, statusMsgId, articleUrl);
      } else {
        await sendLnoriCompletionCard(chatId, statusMsgId, articleUrl, result);
      }
      return;
    }

    if (state.phase === "error") {
      const errMsg =
        state.error || state.status || `Failed to import ${sourceName} series`;
      await sendLnoriErrorCard(chatId, statusMsgId, articleUrl, errMsg);
      return;
    }

    // 4. Active progress event
    const text = isElscioneUrl(articleUrl)
      ? formatElscioneProgress(state)
      : formatLnoriProgress(state);
    const now = Date.now();
    if (text && (text !== lastProgressText || now - lastEditTime >= 1000)) {
      lastProgressText = text;
      lastEditTime = now;
      const cleanText = escapeTelegramMarkdown(text);
      const msgId = await editOrSendMessage(
        chatId,
        statusMsgId,
        cleanText,
        "Markdown",
      );
      if (msgId && !statusMsgId) statusMsgId = msgId;
    }
  }

  logError(
    `Progress polling for ${runId} exceeded maximum attempts (${maxPollAttempts})`,
  );
  await sendLnoriErrorCard(
    chatId,
    statusMsgId,
    articleUrl,
    "Ingestion monitoring timed out after 30 minutes",
  );
}

export async function consumeLnoriSseStream(
  chatId: number,
  statusMsgId: number | null,
  articleUrl: string,
  response: Response,
  uploaderUrl: string,
): Promise<void> {
  const reader = response.body?.getReader();
  if (!reader) {
    logError("No response body reader for SSE stream");
    await sendLnoriErrorCard(
      chatId,
      statusMsgId,
      articleUrl,
      "Unable to read streaming progress from server",
    );
    return;
  }

  const decoder = new TextDecoder();
  let buffer = "";
  let lastProgressText = "";
  let lastEditTime = 0;
  let runId: string | null = null;
  let completed = false;

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });

      const lines = buffer.split("\n");
      buffer = lines.pop() || "";

      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed || trimmed.startsWith(":")) continue;

        if (trimmed.startsWith("data:")) {
          const jsonStr = trimmed.slice(5).trim();
          try {
            const event: LnoriProgressEvent & { runId?: string } =
              JSON.parse(jsonStr);
            if (event.runId && !runId) {
              runId = event.runId;
            }

            if (event.phase === "complete") {
              completed = true;
              const result = event.data || {};
              if (
                (result.importedCount ?? 0) === 0 &&
                (result.skippedCount ?? 0) === 0
              ) {
                await sendLnoriIncompleteCard(chatId, statusMsgId, articleUrl);
              } else {
                await sendLnoriCompletionCard(
                  chatId,
                  statusMsgId,
                  articleUrl,
                  result,
                );
              }
              return;
            }

            const sourceName = isElscioneUrl(articleUrl) ? "Elscione" : "Lnori";
            if (event.phase === "error") {
              completed = true;
              const errMsg =
                event.data?.error ||
                event.status ||
                `Failed to import ${sourceName} series`;
              await sendLnoriErrorCard(
                chatId,
                statusMsgId,
                articleUrl,
                errMsg,
              );
              return;
            }

            const text = isElscioneUrl(articleUrl)
              ? formatElscioneProgress(event)
              : formatLnoriProgress(event);
            const now = Date.now();
            if (
              text &&
              (text !== lastProgressText || now - lastEditTime >= 1000)
            ) {
              lastProgressText = text;
              lastEditTime = now;
              const cleanText = escapeTelegramMarkdown(text);
              const msgId = await editOrSendMessage(
                chatId,
                statusMsgId,
                cleanText,
                "Markdown",
              );
              if (msgId && !statusMsgId) statusMsgId = msgId;
            }
          } catch (jsonErr) {
            console.debug("[Lnori SSE] JSON parse error:", jsonErr);
          }
        }
      }
    }
  } catch (streamErr: any) {
    logError(`SSE stream error: ${streamErr?.message || streamErr}`);
  } finally {
    try {
      await reader.cancel();
    } catch (_cancelErr) {
      void _cancelErr;
    }
  }

  if (!completed) {
    if (runId) {
      log(
        `SSE stream disconnected for runId ${runId}, falling back to progress polling...`,
      );
      await pollLnoriProgress(
        chatId,
        statusMsgId,
        articleUrl,
        runId,
        uploaderUrl,
      );
    } else {
      logError("SSE stream disconnected before runId was received");
      await sendLnoriErrorCard(
        chatId,
        statusMsgId,
        articleUrl,
        "Stream connection lost before ingestion initialized",
      );
    }
  }
}

export async function handleLnoriUrlMessage(
  chatId: number,
  articleUrl: string,
  sender: string = "user",
): Promise<void> {
  const isElscione = isElscioneUrl(articleUrl);
  const sourceName = isElscione ? "Elscione" : "Lnori";
  log(
    `Detected ${sourceName} light novel URL in message: "${articleUrl}" from ${sender}`,
  );
  const initialStatus =
    `📖 *Detected ${sourceName} Light Novel Series*\n\`${escapeTelegramMarkdown(articleUrl)}\`\n\n` +
    `⏳ _Fetching volume manifest..._`;
  let statusMsgId = await sendMessage(
    chatId,
    initialStatus,
    "Markdown",
  );

  const uploaderUrl = getLocalUploaderUrl();
  const ingestEndpoint = `${uploaderUrl}/api/lnori/ingest`;

  let serverResponse: Response | null = null;
  try {
    serverResponse = await safeFetchWithSsrf(
      ingestEndpoint,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Accept: "text/event-stream, application/json",
        },
        body: JSON.stringify({ url: articleUrl, stream: true }),
        timeoutMs: 30000,
      } as any,
      5,
      { allowInternalServices: true, bindIp: false },
    );
  } catch (err: any) {
    log(
      `Local uploader server unreachable at ${ingestEndpoint} (${err?.message || err}), falling back to direct in-process queue`,
    );
    await runDirectLnoriFallback(chatId, statusMsgId, articleUrl);
    return;
  }

  if (serverResponse.status === 400) {
    const data = await serverResponse.json().catch(() => ({}));
    await editOrSendMessage(
      chatId,
      statusMsgId,
      `⚠️ *Invalid ${sourceName} URL*\n\n` +
        `🔗 *URL:* \`${escapeTelegramMarkdown(articleUrl)}\`\n` +
        `❌ *Error:* ${escapeTelegramMarkdown(data.error || `Target URL must be a valid ${sourceName} series or book URL`)}\n\n` +
        `_Please verify the link and try again._`,
      "Markdown",
    );
    return;
  }

  if (serverResponse.status === 429) {
    const data = await serverResponse.json().catch(() => ({}));
    await editOrSendMessage(
      chatId,
      statusMsgId,
      `⚠️ *${sourceName} Ingestion Queue Full*\n\n` +
        `🔗 *URL:* \`${escapeTelegramMarkdown(articleUrl)}\`\n` +
        `⏳ *Status:* ${escapeTelegramMarkdown(data.error || "Queue is currently full. Please wait for active downloads to finish.")}\n\n` +
        `_Please try again in a few moments._`,
      "Markdown",
    );
    return;
  }

  if (!serverResponse.ok) {
    const data = await serverResponse.json().catch(() => ({}));
    const errMsg =
      data.error || `Server responded with status ${serverResponse.status}`;
    logError(`${sourceName} ingest API error (${serverResponse.status}): ${errMsg}`);
    await sendLnoriErrorCard(chatId, statusMsgId, articleUrl, errMsg);
    return;
  }

  const contentType = serverResponse.headers.get("content-type") || "";

  if (contentType.includes("application/json")) {
    const data = (await serverResponse.json()) as any;
    if (data.queued) {
      const queuePosition = data.queuePosition || 1;
      const queueLength = data.queueLength || 1;
      const queueRunId = data.runId;

      const queuedText =
        `⏳ *Queued ${sourceName} Light Novel Series (Position #${queuePosition} of ${queueLength})*\n` +
        `\`${escapeTelegramMarkdown(articleUrl)}\`\n\n` +
        `_Waiting for previous ingestion to finish..._`;
      const msgId = await editOrSendMessage(
        chatId,
        statusMsgId,
        queuedText,
        "Markdown",
      );
      if (msgId && !statusMsgId) statusMsgId = msgId;

      if (queueRunId) {
        await pollLnoriProgress(
          chatId,
          statusMsgId,
          articleUrl,
          queueRunId,
          uploaderUrl,
          queuePosition,
          queueLength,
        );
      } else {
        await sendLnoriErrorCard(
          chatId,
          statusMsgId,
          articleUrl,
          "Server queued request but did not return a run ID",
        );
      }
      return;
    }

    if (data.active && data.runId) {
      await pollLnoriProgress(
        chatId,
        statusMsgId,
        articleUrl,
        data.runId,
        uploaderUrl,
      );
      return;
    }

    if (data.success) {
      if (data.importedCount === 0 && data.skippedCount === 0) {
        await sendLnoriIncompleteCard(chatId, statusMsgId, articleUrl);
      } else {
        await sendLnoriCompletionCard(chatId, statusMsgId, articleUrl, data);
      }
      return;
    }

    await sendLnoriErrorCard(
      chatId,
      statusMsgId,
      articleUrl,
      data.error || `Failed to import ${sourceName} series`,
    );
    return;
  }

  if (contentType.includes("text/event-stream")) {
    await consumeLnoriSseStream(
      chatId,
      statusMsgId,
      articleUrl,
      serverResponse,
      uploaderUrl,
    );
    return;
  }

  logError(`Unexpected Content-Type from /api/lnori/ingest: ${contentType}`);
  await sendLnoriErrorCard(
    chatId,
    statusMsgId,
    articleUrl,
    `Unexpected response from uploader server (${contentType || "unknown"})`,
  );
}

export async function handleTextMessage(
  chatId: number,
  text: string,
  sender: string = "user",
): Promise<void> {

            // Status Dashboard: /status or /health
            if (
              text === "/status" ||
              text === "/health" ||
              text.startsWith("/status@") ||
              text.startsWith("/health@") ||
              text.startsWith("/status ") ||
              text.startsWith("/health ")
            ) {
              log(
                `Handling ${text.split(" ")[0]} command from ${sender} (chatId: ${chatId})`,
              );
              const statusMsgId = await sendMessage(
                chatId,
                `⏳ *Gathering reading stack diagnostics...*`,
                "Markdown",
              );

              const card = await getStatusDashboard();
              const inlineKeyboard = {
                inline_keyboard: [
                  [
                    {
                      text: "🔄 Refresh Status",
                      callback_data: "refresh_status",
                    },
                    {
                      text: "📖 Open Reading HQ",
                      web_app: { url: READING_WEBAPP_URL },
                    },
                  ],
                ],
              };
              await editOrSendMessage(
                chatId,
                statusMsgId,
                card,
                "Markdown",
                inlineKeyboard,
              );
              return;
            }

            if (
              text === "/backup" ||
              text.startsWith("/backup@") ||
              text.startsWith("/backup ")
            ) {
              log(
                `Handling /backup command from ${sender} (chatId: ${chatId})`,
              );
              await triggerBackup(chatId);
              return;
            }

            // Currently Reading Shelf: /reading
            if (
              text === "/reading" ||
              text.startsWith("/reading@") ||
              text.startsWith("/reading ")
            ) {
              log(
                `Handling /reading command from ${sender} (chatId: ${chatId})`,
              );
              const { card, keyboard } = getCurrentlyReadingShelf(5);
              await sendMessage(chatId, card, "Markdown", keyboard);
              return;
            }

            // Recent Books: /recent
            if (
              text === "/recent" ||
              text.startsWith("/recent@") ||
              text.startsWith("/recent ")
            ) {
              log(
                `Handling /recent command from ${sender} (chatId: ${chatId})`,
              );
              const { card, keyboard } = getRecentBooks(5);
              await sendMessage(chatId, card, "Markdown", keyboard);
              return;
            }

            // Deduplication & Cleaning: /dedup, /dedupe, /duplicates, /clean_duplicates, /clean
            const dedupMatch = text.match(
              /^\/(?:dedup|dedupe|duplicates|clean_duplicates|clean)(?:@\w+)?(?:\s+(.*))?$/i,
            );
            if (dedupMatch) {
              const arg = (dedupMatch[1] || "").trim().toLowerCase();
              const isApply = arg === "apply" || arg === "confirm";
              log(
                `Handling deduplication command "${text}" (isApply: ${isApply}) from ${sender} (chatId: ${chatId})`,
              );

              if (isApply) {
                const statusMsgId = await sendMessage(
                  chatId,
                  `⏳ *Pruning duplicate books from Calibre...*`,
                  "Markdown",
                );
                const report = await _duplicateCleanerRunner({ apply: true });
                let resultCard =
                  `✅ *Duplicate Pruning Complete*\n\n` +
                  `• *Books Scanned:* ${report.totalBooksScanned}\n` +
                  `• *Duplicate Books Pruned:* ${report.totalPruned}\n` +
                  `• *Duplicate Groups Resolved:* ${report.duplicateGroupsCount}\n`;

                if (report.auditLogPath) {
                  resultCard += `• *Audit Log:* \`${escapeTelegramMarkdown(report.auditLogPath)}\`\n`;
                }

                if (report.errors.length > 0) {
                  resultCard += `\n⚠️ *Encountered ${report.errors.length} error(s):*\n`;
                  for (const err of report.errors.slice(0, 3)) {
                    resultCard += `- ${escapeTelegramMarkdown(err.message)}\n`;
                  }
                } else {
                  resultCard += `\n_Your library is now deduplicated. Keepers retain all metadata and reading progress._`;
                }

                const keyboard = {
                  inline_keyboard: [
                    [
                      { text: "🔄 Rescan", callback_data: "rescan_dedup" },
                      {
                        text: "📖 Open Reading HQ",
                        web_app: { url: READING_WEBAPP_URL },
                      },
                    ],
                    [{ text: "🏠 Main Menu", callback_data: "menu:main" }],
                  ],
                };

                await editOrSendMessage(
                  chatId,
                  statusMsgId,
                  resultCard,
                  "Markdown",
                  keyboard,
                );
              } else {
                const statusMsgId = await sendMessage(
                  chatId,
                  `⏳ *Scanning Calibre library for duplicates...*`,
                  "Markdown",
                );
                const report = await _duplicateCleanerRunner({ dryRun: true });
                const { card, keyboard } = formatDuplicateCleanerCard(report);
                await editOrSendMessage(
                  chatId,
                  statusMsgId,
                  card,
                  "Markdown",
                  keyboard,
                );
              }
              return;
            }

            // Main Menu Dashboard: /menu
            if (
              text === "/menu" ||
              text.startsWith("/menu@") ||
              text.startsWith("/menu ")
            ) {
              log(`Handling /menu command from ${sender} (chatId: ${chatId})`);
              await sendMessage(
                chatId,
                getMainMenuText(),
                "Markdown",
                getMainMenuKeyboard(),
              );
              initChatMenuButton(chatId).catch(() => {});
              return;
            }

            // Library Search: /find <query>, /search <query>, /f <query>
            const searchMatch = text.match(
              /^\/(?:search|find|f)(?:@\w+)?(?:\s+(.*))?$/i,
            );
            if (searchMatch) {
              const query = (searchMatch[1] || "").trim();
              if (!query) {
                await sendMessage(
                  chatId,
                  `🔍 *Library Search*\n\n` +
                    `Usage: \`/find <query>\` or \`/search <query>\` (or \`/f <query>\`)\n\n` +
                    `Examples:\n` +
                    `• \`/find One Piece\`\n` +
                    `• \`/search Foundation\`\n` +
                    `• \`/f Isaac Asimov\``,
                  "Markdown",
                );
                return;
              }

              log(`Searching library for "${query}" from ${sender}`);
              const results = searchCalibreLibrary(query, 5);

              if (results.length === 0) {
                await sendMessage(
                  chatId,
                  `🔍 *No books found matching "${escapeTelegramMarkdown(query)}".*\n\nTry searching by title, author name, or series name.`,
                  "Markdown",
                );
                return;
              }

              await sendMessage(
                chatId,
                `🔍 *Found ${results.length} book(s) matching "${escapeTelegramMarkdown(query)}":*`,
                "Markdown",
              );

              for (const book of results) {
                const formatBadges = (book.formats || "")
                  .split(",")
                  .flatMap((f: string) => (f.trim() ? [`[${f.trim()}]`] : []))
                  .join(" ");

                let card = `📚 *${escapeTelegramMarkdown(book.title)}*\n`;
                card += `👤 *Author:* ${escapeTelegramMarkdown(book.authors || "Unknown")}\n`;
                if (book.series) {
                  const idx = book.series_index
                    ? ` (#${book.series_index})`
                    : "";
                  card += `📖 *Series:* ${escapeTelegramMarkdown(book.series)}${idx}\n`;
                }
                card += `📦 *Formats:* \`${formatBadges || "[None]"}\`\n\n`;
                card += `💡 _Tap below or send_ \`/get ${book.id}\``;

                const inlineKeyboard = {
                  inline_keyboard: [
                    [
                      {
                        text: "📥 Send File",
                        callback_data: `send_book:${book.id}`,
                      },
                      {
                        text: "📖 Read Online",
                        url: `${CALIBRE_WEB_URL}/read/${book.id}/epub`,
                      },
                      {
                        text: "ℹ️ Details",
                        url: `${CALIBRE_WEB_URL}/#book_id=${book.id}&panel=book_details`,
                      },
                    ],
                  ],
                };

                await sendMessage(chatId, card, "Markdown", inlineKeyboard);
              }
              return;
            }

            // Book Retrieval: /get <id>, /get@bot <id>, or /get_<id>
            const getMatch = text.match(/^\/get(?:@\w+)?(?:_|\s+)(\d+)$/i);
            if (getMatch) {
              const bookId = parseInt(getMatch[1], 10);
              log(`Handling /get command for book #${bookId} from ${sender}`);
              await retrieveAndSendBook(chatId, bookId);
              return;
            }
            if (/^\/get(?:@\w+)?$/i.test(text.trim())) {
              await sendMessage(
                chatId,
                `ℹ️ *Book Retrieval*\n\nPlease specify a book ID:\nUsage: \`/get <id>\`\nExample: \`/get 6\``,
                "Markdown",
              );
              return;
            }

            // Telegram Mini App: /app or /webapp
            if (
              text === "/app" ||
              text === "/webapp" ||
              text.startsWith("/app@") ||
              text.startsWith("/webapp@") ||
              text.startsWith("/app ") ||
              text.startsWith("/webapp ")
            ) {
              log(`Handling /app command from ${sender} (chatId: ${chatId})`);
              await sendMessage(
                chatId,
                `📖 *Reading HQ Mini App*\n\n` +
                  `Access your complete reading catalog, search books, edit metadata, and upload files directly inside Telegram:\n\n` +
                  `👉 Tap *[📖 Open Reading HQ]* below or use the *📖 Reading HQ* menu button next to the chat input field.`,
                "Markdown",
                {
                  inline_keyboard: [
                    [
                      {
                        text: "📖 Open Reading HQ",
                        web_app: { url: READING_WEBAPP_URL },
                      },
                    ],
                  ],
                },
              );
              initChatMenuButton(chatId).catch(() => {});
              return;
            }

            const articleUrl = extractUrlFromText(text);

            if (articleUrl) {
              if (isLnoriUrl(articleUrl) || isElscioneUrl(articleUrl)) {
                await handleLnoriUrlMessage(chatId, articleUrl, sender);
                return;
              }

              log(
                `Detected article URL in message: "${articleUrl}" from ${sender}`,
              );
              const statusMsgId = await sendMessage(
                chatId,
                `⏳ *Extracting article from URL...*\n\`${articleUrl}\``,
                "Markdown",
              );

              try {
                const result = await ingestArticleFromUrl(articleUrl);
                if (result.success) {
                  const detailsLink = result.bookId
                    ? `[Book Details](${CALIBRE_WEB_URL}/#book_id=${result.bookId}&panel=book_details)`
                    : "";
                  const readerLink = result.bookId
                    ? `[Read Online](${CALIBRE_WEB_URL}/read/${result.bookId}/epub)`
                    : "";
                  const links = [detailsLink, readerLink]
                    .filter(Boolean)
                    .join(" • ");

                  const confirmation =
                    `✅ *Article Ingested Successfully*\n\n` +
                    `\uD83D\uDCD6 *Title:* ${result.title}\n` +
                    `\uD83D\uDC64 *Author:* ${result.authors || "Unknown"}\n` +
                    `\uD83C\uDF10 *Source:* ${result.siteName}\n` +
                    `⏱️ *Read Time:* ~${result.readTimeMinutes} min (${result.wordCount} words)\n` +
                    `\uD83D\uDCE6 *Format:* \`EPUB\`\n` +
                    `ℹ️ ${result.message || "Added to library"}\n\n` +
                    (links ? `\uD83D\uDD17 ${links}\n\n` : "") +
                    `_Ready on your Kindle OPDS feed. Sending EPUB copy below..._`;

                  const postIngestKeyboard = result.bookId
                    ? getPostIngestionKeyboard(result.bookId)
                    : undefined;
                  await editOrSendMessage(
                    chatId,
                    statusMsgId,
                    confirmation,
                    "Markdown",
                    postIngestKeyboard,
                  );

                  if (result.epubPath && fs.existsSync(result.epubPath)) {
                    log(
                      `Sending generated EPUB to chat ${chatId}: ${result.epubPath}`,
                    );
                    const caption = `\uD83D\uDCD6 *${result.title}*\n\uD83D\uDC64 ${result.authors || "Unknown"}`;
                    const customName = generateMetadataFilename({
                      title: result.title,
                      authors: result.authors,
                      format: "epub",
                    });
                    await sendDocument(
                      chatId,
                      result.epubPath,
                      caption,
                      "Markdown",
                      "application/epub+zip",
                      customName,
                    );
                  }
                } else {
                  await editOrSendMessage(
                    chatId,
                    statusMsgId,
                    `⚠️ *Article Ingestion Failed*\n\n` +
                      `\uD83D\uDD17 *URL:* \`${articleUrl}\`\n` +
                      `❌ *Error:* ${result.error || "Failed to process article"}\n\n` +
                      `_Please verify the link is publicly accessible and try again._`,
                    "Markdown",
                  );
                }
              } catch (err: any) {
                logError(
                  `Article ingestion exception for ${articleUrl}: ${err.message}`,
                );
                const isPaywall =
                  /paid subscription paywall|subscription offer/i.test(
                    err.message,
                  );
                const advice = isPaywall
                  ? `_Please paste the article text directly into Reading HQ or provide an unlocked link._`
                  : `_Please check the URL or paywall access and try again._`;

                await editOrSendMessage(
                  chatId,
                  statusMsgId,
                  `⚠️ *Article Ingestion Failed*\n\n` +
                    `\uD83D\uDD17 *URL:* \`${articleUrl}\`\n` +
                    `❌ *Error:* ${err.message || "Unknown error"}\n\n` +
                    advice,
                  "Markdown",
                );
              }
            } else if (
              text === "/start" ||
              text.startsWith("/start@") ||
              text.startsWith("/start ")
            ) {
              log(`Handling /start command from ${sender} (chatId: ${chatId})`);
              await sendMessage(
                chatId,
                getMainMenuText(),
                "Markdown",
                getMainMenuKeyboard(),
              );
              initChatMenuButton(chatId).catch(() => {});
            } else if (
              text === "/help" ||
              text.startsWith("/help@") ||
              text.startsWith("/help ") ||
              text === "/guide" ||
              text.startsWith("/guide@") ||
              text.startsWith("/guide ") ||
              text === "/manual" ||
              text.startsWith("/manual@") ||
              text.startsWith("/manual ")
            ) {
              await sendMessage(
                chatId,
                getHelpMessage(),
                "Markdown",
                getMainMenuKeyboard(),
              );
              initChatMenuButton(chatId).catch(() => {});
            } else {
              await sendMessage(
                chatId,
                `📚 Please send EPUB files (\`.epub\`, or \`.zip\`/\`.7z\` archives containing .epub), paste an article URL, search your library (\`/find <query>\`), view current reads (\`/reading\`), view recent books (\`/recent\`), open the dashboard (\`/menu\`), check system status (\`/status\`), or send \`/backup\`. For files over 20MB, use [Reading HQ](${READING_WEBAPP_URL}).`,
                "Markdown",
                getMainMenuKeyboard(),
              );
            }

}

async function pollTelegram() {
  const token = getTelegramBotToken();
  if (!token) {
    console.error("[TelegramBot] Missing TELEGRAM_BOT_TOKEN. Exiting.");
    process.exit(1);
  }
  startJobWorker(1000);
  log(
    `Polling started via proxy ${PROXY_URL} for bot: ${token.substring(0, 10)}...`,
  );

  await initChatMenuButton();
  await initBotCommands();

  while (isPollingRunning) {
    try {
      const res = await tgFetch(
        `getUpdates?offset=${offset}&timeout=${POLL_TIMEOUT_SECONDS}`,
        {
          timeoutMs: POLL_REQUEST_TIMEOUT_MS,
        },
      );

      if (!res.ok) {
        const errText = await res.text().catch(() => "");
        logError(
          `getUpdates returned HTTP ${res.status}: ${errText}. Retrying in ${Math.round(backoffMs / 1000)}s...`,
        );
        await new Promise((r) => setTimeout(r, backoffMs));
        backoffMs = Math.min(backoffMs * 2, MAX_BACKOFF_MS);
        continue;
      }

      const json = (await res.json()) as any;
      // On successful polling response, reset backoff to initial delay
      backoffMs = INITIAL_BACKOFF_MS;

      if (json.ok && json.result && json.result.length > 0) {
        for (const update of json.result) {
          offset = update.update_id + 1;

          if (update.callback_query) {
            await handleCallbackQuery(update.callback_query);
            continue;
          }

          const msg = update.message;
          if (!msg) continue;
          const chatId = msg.chat.id;
          const sender =
            msg.from?.username || msg.from?.first_name || `ID ${chatId}`;

          if (msg.document) {
            const doc = msg.document;
            const fileName = doc.file_name || "telegram_book.epub";
            const fileSize = doc.file_size || 0;

            if (fileSize > MAX_TELEGRAM_FILE_SIZE) {
              const sizeMB = (fileSize / (1024 * 1024)).toFixed(1);
              log(
                `File "${fileName}" exceeds 20MB (${sizeMB} MB). Sending instant Web Uploader redirect to chat ${chatId}`,
              );
              await sendMessage(
                chatId,
                `⚠️ *File Exceeds Telegram Bot Limit*\n\n` +
                  `*${fileName}* is *${sizeMB} MB*, which exceeds Telegram Bot API's *20 MB* download ceiling.\n\n` +
                  `👉 *Upload directly via Reading HQ Mini App or Web Uploader:*\n` +
                  `[Reading HQ](${READING_WEBAPP_URL}) • [Web Uploader](${WEB_UPLOADER_URL})\n\n` +
                  `_The Web Uploader accepts books of any size and automatically synchronizes with Calibre._`,
                "Markdown",
                {
                  inline_keyboard: [
                    [
                      {
                        text: "📖 Open Reading HQ",
                        web_app: { url: READING_WEBAPP_URL },
                      },
                    ],
                  ],
                },
              );
              continue;
            }

            let batch = pendingBatches.get(chatId);
            if (!batch) {
              batch = { docs: [], timer: null };
              pendingBatches.set(chatId, batch);
            }
            batch.docs.push({ doc, fileName, fileSize, chatId, sender });

            if (batch.timer) clearTimeout(batch.timer);
            batch.timer = setTimeout(() => {
              const currentDocs = [...batch.docs];
              pendingBatches.delete(chatId);
              processBatch(chatId, currentDocs);
            }, 1800); // 1.8s debounce collects files sent in a burst
          } else if (msg.text) {
            const text = msg.text.trim();
            log(`Received text: "${text}" from ${sender}`);
            await handleTextMessage(chatId, text, sender);
          }
        }
      }
    } catch (err: any) {
      const isAbort = err.name === "AbortError" || err.name === "TimeoutError";
      const isSocketClosed =
        err.message && /socket connection was closed/i.test(err.message);

      if (isAbort || isSocketClosed) {
        // Routine long-poll timeout or idle proxy keep-alive closure: immediate seamless reconnect
        backoffMs = INITIAL_BACKOFF_MS;
        await new Promise((r) => setTimeout(r, 150));
      } else {
        logError(
          `Polling exception (${err.message}). Retrying in ${Math.round(backoffMs / 1000)}s...`,
        );
        await new Promise((r) => setTimeout(r, backoffMs));
        backoffMs = Math.min(backoffMs * 2, MAX_BACKOFF_MS);
      }
    }
  }
}

if ((import.meta as any).main) {
  pollTelegram();
}
