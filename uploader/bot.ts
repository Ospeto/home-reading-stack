import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { Buffer } from "node:buffer";
import { spawnSync } from "node:child_process";
import crypto from "node:crypto";
import { Database } from "bun:sqlite";
import {
  sanitizeMetadata,
  extractSeries,
  isSameBook,
  normalizeFormat,
} from "./scraper";
import { isArchiveFile, unpackArchive } from "./archive";
import { extractUrlFromText, ingestArticleFromUrl } from "./article";
import {
  getDownloadFilename,
  validateEpubContent,
  getDropDir,
  getCoverCacheDir,
  resolveExecutable,
  safeFetchWithSsrf,
  sanitizeErrorMessage,
  getCacheDb,
} from "./security";
import { getJobQueue, withCalibreLockSync } from "./jobs";

const DROP_DIR = getDropDir();
const SERVER_URL = process.env.CALIBRE_SERVER_URL || "http://127.0.0.1:8088";
let RUNTIME_DIR = process.cwd();
try {
  RUNTIME_DIR = path.dirname(new URL(import.meta.url).pathname);
} catch {
  // Keep the portable process-relative fallback.
}
const HOME_DIR = process.env.HOME || os.homedir();
const ENV_PATH = process.env.ENV_PATH || path.join(RUNTIME_DIR, ".env");
const CACHE_DB_PATH =
  process.env.CACHE_DB_PATH || path.join(RUNTIME_DIR, "cache.db");
const KOSYNC_DB_PATH =
  process.env.KOSYNC_DB_PATH ||
  path.join(HOME_DIR, "kosync-server", "data", "koreader-sync.db");
const CALIBRE_DB_PATH =
  process.env.CALIBRE_DB_PATH ||
  path.join(HOME_DIR, "Calibre Library", "metadata.db");
const CALIBRE_LIBRARY_DIR =
  process.env.CALIBRE_LIBRARY_DIR || path.dirname(CALIBRE_DB_PATH);
const MANGA_DB_PATH =
  process.env.MANGA_DB_PATH || path.join(HOME_DIR, "manga-processor", "manga.db");
const PROXY_URL = process.env.HTTP_PROXY || "http://127.0.0.1:7890";
const WEB_UPLOADER_URL =
  process.env.WEB_UPLOADER_URL || "http://127.0.0.1:8086";
const CALIBRE_WEB_URL =
  process.env.CALIBRE_WEB_URL || "http://127.0.0.1:8088";
export const READING_WEBAPP_URL =
  process.env.READING_WEBAPP_URL || "https://reading.wavypremium.xyz";
export const KOSYNC_WAN_URL =
  process.env.KOSYNC_WAN_URL || "https://kosync.wavypremium.xyz";

async function fetchSafeResponse(
  url: string,
  options: any = {},
  allowPrivateHosts = false,
): Promise<Response> {
  const result = await safeFetchWithSsrf(url, {
    ...options,
    allowPrivateHosts,
  });
  return new Response(result.buffer, {
    status: result.status,
    statusText: result.statusText,
    headers: result.headers,
  });
}

const MAX_TELEGRAM_FILE_SIZE = 20 * 1024 * 1024; // 20MB Telegram Bot API limit
const ALLOWED_EXTS = [".epub", ".zip", ".rar", ".7z", ".tar"];

const INITIAL_BACKOFF_MS = 2000;
const MAX_BACKOFF_MS = 60000;
const POLL_TIMEOUT_SECONDS = 25;
const POLL_REQUEST_TIMEOUT_MS = 35000;

const cacheDb: Database = new Proxy({} as Database, {
  get(_target, prop) {
    const db = getCacheDb();
    const val = (db as any)[prop];
    return typeof val === "function" ? val.bind(db) : val;
  },
});

let TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN || "";
if (fs.existsSync(ENV_PATH)) {
  const envContent = fs.readFileSync(ENV_PATH, "utf8");
  for (const line of envContent.split("\n")) {
    const trimmed = line.trim();
    if (trimmed.startsWith("TELEGRAM_BOT_TOKEN=")) {
      TELEGRAM_BOT_TOKEN = trimmed.replace("TELEGRAM_BOT_TOKEN=", "").trim();
    }
  }
}

if (!TELEGRAM_BOT_TOKEN) {
  if ((import.meta as any).main) {
    console.error("[TelegramBot] Missing TELEGRAM_BOT_TOKEN. Exiting.");
    process.exit(1);
  } else {
    TELEGRAM_BOT_TOKEN = "test_bot_token";
  }
}

function log(msg: string) {
  const ts = new Date().toISOString().replace("T", " ").substring(0, 19);
  console.log(`[${ts}] [TelegramBot] ${msg}`);
}

function logError(msg: string, err?: any) {
  const ts = new Date().toISOString().replace("T", " ").substring(0, 19);
  console.error(`[${ts}] [TelegramBot] ERROR: ${msg}`, err || "");
}

function getKOReaderBinary256(filePath: string): string | null {
  try {
    const stats = fs.statSync(filePath);
    const fd = fs.openSync(filePath, "r");
    const KOREADER_HASH_ALGO = "md5";
    const hasher = crypto.createHash(KOREADER_HASH_ALGO);
    const size = 1024;
    for (let i = -1; i <= 10; i++) {
      const offset = i === -1 ? 256 : 1024 * 4 ** i;
      if (offset >= stats.size) break;
      const buf = Buffer.alloc(size);
      const bytesRead = fs.readSync(fd, buf, 0, size, offset);
      if (bytesRead > 0) hasher.update(buf.subarray(0, bytesRead));
    }
    fs.closeSync(fd);
    return hasher.digest("hex");
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
  return spawnSync(resolveExecutable("calibredb", "CALIBREDB_PATH"), args, {
    encoding: "utf8",
    env,
  });
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
  const url = `https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/${endpoint}`;
  const timeoutMs = options.timeoutMs || 45000;
  const fetchOpts: any = {
    ...options,
    timeoutMs,
    proxy: PROXY_URL,
  };
  delete fetchOpts.timeoutMs;

  const result = await safeFetchWithSsrf(url, fetchOpts);
  return new Response(result.buffer, {
    status: result.status,
    statusText: result.statusText,
    headers: result.headers,
  });
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
    const data = (await res.json()) as any;
    if (data.ok && data.result?.message_id) {
      return data.result.message_id;
    }
    // Safe Telegram plain-text fallback:
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
      if (replyMarkup) fallbackBody.reply_markup = replyMarkup;
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
      const data = (await res.json()) as any;
      if (data.ok && data.result?.message_id) {
        return data.result.message_id;
      }
      // Safe Telegram plain-text fallback:
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
        if (replyMarkup) fallbackBody.reply_markup = replyMarkup;
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
  customFilename?: string,
): Promise<boolean> {
  try {
    const formData = new FormData();
    formData.append("chat_id", String(chatId));
    const fileBytes = fs.readFileSync(filePath);
    const fileName = customFilename || path.basename(filePath);
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
    { name: "Calibre", fileName: "metadata.db", path: CALIBRE_DB_PATH },
    { name: "Uploader Cache", fileName: "cache.db", path: CACHE_DB_PATH },
    { name: "Manga", fileName: "manga.db", path: MANGA_DB_PATH },
  ];

  const stagingDir = fs.mkdtempSync(
    path.join(os.tmpdir(), "reading-stack-backup-"),
  );
  const backedUpFiles: string[] = [];
  const backedUpDbs: string[] = [];

  const env: any = {
    ...process.env,
    PATH: process.env.PATH || "",
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
        },
      );

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
    const archivePath = path.join(os.tmpdir(), fileName);

    log(`Archiving ${backedUpFiles.length} database(s) into ${archivePath}...`);
    const tarRes = spawnSync(
      "tar",
      ["-czf", archivePath, "-C", stagingDir, ...backedUpFiles],
      {
        encoding: "utf8",
        env,
      },
    );

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
  if (fs.existsSync(CALIBRE_DB_PATH)) {
    try {
      const db = new Database(CALIBRE_DB_PATH, { readonly: true });
      db.run("PRAGMA busy_timeout = 3000;");

      const words = trimmed.split(/\s+/).filter(Boolean);

      // Primary query: whole phrase match against title, author, or series
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
        LEFT JOIN data d ON b.id = d.book
        WHERE b.title LIKE ? OR a.name LIKE ? OR s.name LIKE ?
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
          LEFT JOIN data d ON b.id = d.book
          WHERE ${conditions}
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

  // 2. Fallback to calibredb list
  try {
    const listRes = runCalibredb([
      "list",
      "--with-library",
      SERVER_URL,
      "--search",
      trimmed,
      "--fields",
      "id,title,authors,series,series_index,formats",
      "--for-machine",
    ]);

    if (listRes.status === 0 && listRes.stdout) {
      const parsed = safeParseJson(listRes.stdout);
      if (Array.isArray(parsed)) {
        return parsed.slice(0, limit).map((item: any) => {
          const fmts = Array.isArray(item.formats)
            ? item.formats
                .map(
                  (f: string) =>
                    path.extname(f).replace(/^\./, "").toUpperCase() || f,
                )
                .join(",")
            : String(item.formats || "");
          return {
            id: item.id,
            title: item.title || "Untitled",
            authors: Array.isArray(item.authors)
              ? item.authors.join(", ")
              : String(item.authors || "Unknown"),
            series: item.series || null,
            series_index: item.series_index || null,
            formats: fmts,
          };
        });
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

export function getCalibreDbPath(): string {
  return process.env.CALIBRE_DB_PATH || CALIBRE_DB_PATH;
}

export function getCalibreLibraryDir(): string {
  return process.env.CALIBRE_LIBRARY_DIR || CALIBRE_LIBRARY_DIR;
}

export function locateBookFile(bookId: number): BookFileDetails | null {
  const preferredFormats = ["EPUB"];
  const calibreDbPath = getCalibreDbPath();
  const calibreLibraryDir = getCalibreLibraryDir();

  if (fs.existsSync(calibreDbPath)) {
    try {
      const db = new Database(calibreDbPath, { readonly: true });
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
        const basePath = path.join(calibreLibraryDir, bookRelPath);

        // The canonical collection is EPUB-only; do not deliver other formats.
        const epubRows = rows.filter((row) => String(row.format || "").toUpperCase() === "EPUB");
        epubRows.sort((a, b) => {
          const idxA = preferredFormats.indexOf(
            String(a.format || "").toUpperCase(),
          );
          const idxB = preferredFormats.indexOf(
            String(b.format || "").toUpperCase(),
          );
          const scoreA = idxA === -1 ? 999 : idxA;
          const scoreB = idxB === -1 ? 999 : idxB;
          return scoreA - scoreB;
        });

        for (const row of epubRows) {
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
      `id:${bookId}`,
      "--fields",
      "id,title,authors,formats",
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
        const fmts: string[] = Array.isArray(item.formats) ? item.formats : [];

        for (const f of fmts) {
          if (path.extname(f).toLowerCase() !== ".epub") continue;
          if (fs.existsSync(f)) {
            const stat = fs.statSync(f);
            const fmtName =
              path.extname(f).replace(/^\./, "").toUpperCase() || "FILE";
            return {
              bookId,
              title,
              authors,
              chosenFormat: fmtName,
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

  const downloadName = getDownloadFilename({ title, authors }, chosenFormat);
  const sent = await sendDocument(
    chatId,
    filePath,
    caption,
    "Markdown",
    "",
    downloadName,
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

export function getExternalVolumeStatusPath(): string {
  return (
    process.env.EXTERNAL_VOLUME_STATUS_PATH ||
    process.env.EXTERNAL_VOLUME_PATH ||
    ""
  );
}

export async function getStatusDashboard(): Promise<string> {
  const ts = new Date()
    .toLocaleString("en-GB", { timeZone: "Asia/Yangon" })
    .replace(",", "");

  // 1. WAN Edge
  let wanReadingStatus = "🔴 `Unreachable`";
  const t0 = performance.now();
  try {
    const res = await fetchSafeResponse(READING_WEBAPP_URL, {
      proxy: PROXY_URL,
      timeoutMs: 8000,
    });
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
    const res = await fetchSafeResponse(KOSYNC_WAN_URL, {
      proxy: PROXY_URL,
      timeoutMs: 4000,
    });
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
    });
    const pid = (pg.stdout || "").trim().split("\n")[0];
    if (pid) tunnelStatus = `🟢 \`Active\` (PID ${pid})`;
  } catch (_e) {
    void _e;
  }

  let proxyStatus = "🔴 `Disconnected`";
  try {
    const pCheck = spawnSync("nc", ["-z", "127.0.0.1", "7890"], {
      timeout: 1500,
    });
    if (pCheck.status === 0) proxyStatus = "🟢 `Connected` (127.0.0.1:7890)";
  } catch (_e) {
    void _e;
  }

  // 3. Reading HQ & Calibre
  let uploaderLocal = "🔴 `Inactive`";
  try {
    const res = await fetchSafeResponse(
      "http://127.0.0.1:8086/api/books",
      { timeoutMs: 2000 },
      true,
    );
    if (res.status === 200) uploaderLocal = "🟢 `Active` (:8086)";
  } catch (_e) {
    void _e;
  }

  let calibreLocal = "🔴 `Inactive`";
  try {
    const res = await fetchSafeResponse(
      "http://127.0.0.1:8088/opds",
      { timeoutMs: 2000 },
      true,
    );
    if (res.status === 200) calibreLocal = "🟢 `Active` (:8088 / OPDS)";
  } catch (_e) {
    void _e;
  }

  let totalBooks = 0;
  let formatStats = "None";
  let newestTitle = "None";
  if (fs.existsSync(CALIBRE_DB_PATH)) {
    try {
      const db = new Database(CALIBRE_DB_PATH, { readonly: true });
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
    const res = await fetchSafeResponse(
      "http://127.0.0.1:7200/",
      { timeoutMs: 2000 },
      true,
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
    let kDb: Database | null = null;
    try {
      kDb = new Database(KOSYNC_DB_PATH, { readonly: true });
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
    } finally {
      try {
        kDb?.close();
      } catch (_closeErr) {
        void _closeErr;
      }
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
      timeout: 2000,
    });
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
    const df = spawnSync("df", ["-h", path.dirname(CALIBRE_DB_PATH)], {
      encoding: "utf8",
      timeout: 2000,
    });
    const lines = (df.stdout || "").trim().split("\n");
    if (lines.length > 1) {
      const parts = lines[1].split(/\s+/);
      internalDiskStr = `\`${parts[3]} free\` / ${parts[1]} (${parts[4]} used)`;
    }
  } catch (_e) {
    void _e;
  }

  let ssdDiskStr = "";
  const externalVolumePath = getExternalVolumeStatusPath();
  if (externalVolumePath && fs.existsSync(externalVolumePath)) {
    try {
      const df = spawnSync("df", ["-h", externalVolumePath], {
        encoding: "utf8",
        timeout: 2000,
      });
      const lines = (df.stdout || "").trim().split("\n");
      if (lines.length > 1) {
        const parts = lines[1].split(/\s+/);
        ssdDiskStr = `\n• *External SSD:* \`${parts[3]} free\` / ${parts[1]} (${parts[4]} used)`;
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
      [{ text: "💾 Hot Backup", callback_data: "menu:backup" }],
    ],
  };
}

export function getMainMenuText(): string {
  return (
    `📚 *Reading HQ Dashboard*\n\n` +
    `Welcome to your personal library and reading companion.\n\n` +
    `• *Mini App:* Tap *[📖 Open Reading HQ]* to explore your visual catalog.\n` +
    `• *Search Library:* Find any book by title, author, or series (\`/f <query>\`).\n` +
    `• *Currently Reading:* Track reading progress synchronized from KOReader (\`/reading\`).\n` +
    `• *Recent Books:* View newest additions to your library (\`/recent\`).\n` +
    `• *Ingest:* Send eBook files (\`.epub\`, \`.pdf\`, \`.cbz\`, etc.) or paste any article URL.\n` +
    `• *Server Status:* Monitor WAN edge, reverse tunnel, and host metrics (\`/status\`).\n` +
    `• *Hot Backup:* Snapshot reading databases to Telegram (\`/backup\`).`
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

export function deleteBookFromLibrary(bookId: number): {
  success: boolean;
  title?: string;
  error?: string;
} {
  if (isNaN(bookId) || bookId <= 0) {
    return { success: false, error: "Invalid book ID" };
  }

  let bookTitle: string | null = null;
  if (fs.existsSync(CALIBRE_DB_PATH)) {
    try {
      const db = new Database(CALIBRE_DB_PATH, { readonly: true });
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

  const res = withCalibreLockSync(() =>
    runCalibredb(["remove", String(bookId), "--with-library", SERVER_URL]),
  );
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
    let kDb: Database | null = null;
    try {
      kDb = new Database(KOSYNC_DB_PATH, { readonly: true });
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
    } finally {
      try {
        kDb?.close();
      } catch (_closeErr) {
        void _closeErr;
      }
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

  if (fs.existsSync(CALIBRE_DB_PATH)) {
    try {
      const db = new Database(CALIBRE_DB_PATH, { readonly: true });
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
        LEFT JOIN data d ON b.id = d.book
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
  else if (data.startsWith("delete_book:")) answerText = "Deleting book...";
  else if (data.startsWith("send_book:")) answerText = "Retrieving book...";

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

function ingestBookFile(
  filePath: string,
  originalFileName: string,
): IngestResult {
  const format = normalizeFormat(path.extname(originalFileName));
  const preliminary = sanitizeMetadata("", "", [], originalFileName);

  if (format === "EPUB") {
    const contentCheck = validateEpubContent(filePath);
    if (!contentCheck.valid) {
      return {
        success: false,
        duplicate: false,
        displayTitle: preliminary.title || originalFileName,
        author: preliminary.author,
        format,
        error: `Invalid EPUB content: ${contentCheck.error || "file is not a valid EPUB archive"}`,
      };
    }
  }

  // 1. Level 1: KOReader Binary Checksum Deduplication
  const fileHash = getKOReaderBinary256(filePath);
  if (fileHash) {
    const hashMatch = cacheDb
      .query(
        "SELECT book_id, title, authors FROM file_hashes WHERE hash = ? LIMIT 1",
      )
      .get(fileHash) as any;

    if (hashMatch && hashMatch.book_id) {
      log(
        `Duplicate detected via KOReader binary hash: "${hashMatch.title}" (ID: ${hashMatch.book_id})`,
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
  }

  // 2. Level 2: Semantic Title, Serialization & Format Deduplication
  const incomingSeries = extractSeries(preliminary.title, originalFileName);

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

    const existingBook = books.find((b: any) =>
      isSameBook(
        {
          title: b.title,
          authors: b.authors,
          series: b.series,
          series_index: b.series_index,
        },
        {
          title: preliminary.title,
          author: preliminary.author,
          series: incomingSeries,
        },
      ),
    );

    if (existingBook) {
      const existingFormats = (existingBook.formats || []).map((f: string) =>
        normalizeFormat(f),
      );
      if (existingFormats.includes(format)) {
        log(
          `Duplicate detected via title/series match: "${existingBook.title}" (has format: ${format})`,
        );
        return {
          success: true,
          duplicate: true,
          bookId: existingBook.id,
          displayTitle: existingBook.title,
          author: existingBook.authors || preliminary.author,
          format,
          message: `Already exists in format ${format}`,
        };
      } else {
        // Multi-format attach
        log(
          `Attaching new format ${format} to existing book "${existingBook.title}" (ID: ${existingBook.id})`,
        );
        withCalibreLockSync(() =>
          runCalibredb([
            "add_format",
            String(existingBook.id),
            filePath,
            "--with-library",
            SERVER_URL,
          ]),
        );

        if (fileHash) {
          cacheDb.run(
            "INSERT OR REPLACE INTO file_hashes (filepath, mtime, hash, book_id, title, authors, cover) VALUES (?, ?, ?, ?, ?, ?, ?)",
            filePath,
            Date.now(),
            fileHash,
            existingBook.id,
            existingBook.title,
            existingBook.authors || "",
            0,
          );
        }

        return {
          success: true,
          duplicate: false,
          attachedFormat: true,
          bookId: existingBook.id,
          displayTitle: existingBook.title,
          author: existingBook.authors || preliminary.author,
          format,
          message: `Attached ${format} format to existing book`,
        };
      }
    }

    // 3. Level 3: Add to Calibre with --automerge ignore guard
    const addRes = withCalibreLockSync(() =>
      runCalibredb([
        "add",
        filePath,
        "--with-library",
        SERVER_URL,
        "--automerge",
        "ignore",
      ]),
    );

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
        finalTitle = clean.title || preliminary.title;
        finalAuthor = clean.author || preliminary.author;

        const setArgs = [
          "set_metadata",
          String(newId),
          "--with-library",
          SERVER_URL,
        ];
        if (clean.title && clean.title !== rawTitle)
          setArgs.push("--field", `title:${clean.title}`);
        if (
          clean.author &&
          clean.author !== rawAuthors &&
          clean.author !== "Unknown"
        )
          setArgs.push("--field", `authors:${clean.author}`);
        if (clean.tags && clean.tags.length)
          setArgs.push("--field", `tags:${clean.tags.join(",")}`);

        // Serialization auto-tagging
        if (!rawSeries && incomingSeries) {
          setArgs.push("--field", `series:${incomingSeries.series}`);
          setArgs.push("--field", `series_index:${incomingSeries.volume}`);
          log(
            `Auto-assigned series "${incomingSeries.series}" #${incomingSeries.volume} to ID ${newId}`,
          );
        }

        if (setArgs.length > 4) {
          withCalibreLockSync(() => runCalibredb(setArgs));
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

        // Durable metadata enrichment via Job Queue
        const isManga =
          format === "CBZ" ||
          format === "CBR" ||
          (clean.tags || []).some((t) => /manga|comic/i.test(t));
        botJobQueue.enqueue("metadata_enrich", {
          bookId: newId,
          title: finalTitle,
          isManga,
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

// Register Durable Job Queue Handlers for Bot Ingestion
const botJobQueue = getJobQueue();
botJobQueue.registerHandler(
  "file_ingest",
  async (payload: {
    filePath: string;
    originalFileName: string;
    deleteAfterIngest?: boolean;
  }) => {
    const result = ingestBookFile(payload.filePath, payload.originalFileName);
    if (
      result.success &&
      payload.deleteAfterIngest &&
      fs.existsSync(payload.filePath)
    ) {
      try {
        fs.unlinkSync(payload.filePath);
      } catch (_unlinkErr) {
        void _unlinkErr;
      }
    }
    if (!result.success) {
      throw new Error(result.error || "File ingestion failed");
    }
    return result;
  },
);
botJobQueue.registerHandler(
  "archive_ingest",
  async (payload: {
    archivePath: string;
    archiveName: string;
    deleteAfterExtract?: boolean;
  }) => {
    const unp = unpackArchive(payload.archivePath);
    if (!unp.success) {
      throw new Error(unp.error || "Archive extraction failed");
    }
    if (payload.deleteAfterExtract && fs.existsSync(payload.archivePath)) {
      try {
        fs.unlinkSync(payload.archivePath);
      } catch (_unlinkErr) {
        void _unlinkErr;
      }
    }
    const results: any[] = [];
    try {
      for (const book of unp.books) {
        const r = ingestBookFile(book.tempPath, book.originalName);
        results.push({
          name: book.originalName,
          ...r,
          error: r.error ? sanitizeErrorMessage(r.error) : undefined,
        });
      }
    } finally {
      unp.cleanup();
    }
    const importedCount = results.filter(
      (r: any) => r.success && !r.duplicate,
    ).length;
    return {
      isArchive: true,
      archiveName: payload.archiveName,
      total: unp.books.length,
      imported: importedCount,
      quarantined: unp.quarantined || [],
      results,
    };
  },
);
botJobQueue.registerHandler("url_ingest", async (payload: { url: string }) => {
  const result = await ingestArticleFromUrl(payload.url);
  if (!result.success) {
    throw new Error(result.error || "Article ingestion failed");
  }
  return result;
});

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

    if (!ALLOWED_EXTS.includes(ext)) {
      results.push({
        name: fileName,
        format,
        status: "error",
        note: `Unsupported format: ${ext}`,
      });
      continue;
    }

    if (fileSize > MAX_TELEGRAM_FILE_SIZE) {
      results.push({
        name: fileName,
        format,
        status: "error",
        note: `Exceeds 20MB limit (${sizeMB} MB). Use Web Uploader: ${WEB_UPLOADER_URL}`,
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
        results.push({ name: fileName, format, status: "error", note: errMsg });
        continue;
      }

      const dlUrl = `https://api.telegram.org/file/bot${TELEGRAM_BOT_TOKEN}/${fileJson.result.file_path}`;
      const dl = await safeFetchWithSsrf(dlUrl, {
        proxy: PROXY_URL,
        timeoutMs: 30000,
      });
      if (!dl.ok) {
        results.push({
          name: fileName,
          format,
          status: "error",
          note: `Download failed (HTTP ${dl.status})`,
        });
        continue;
      }

      const arrayBuf = dl.buffer;
      const uniqueSuffix = `${Date.now()}_${Math.random().toString(36).substring(2, 6)}`;
      const safeBase = path.basename(fileName, ext);
      const tempFileName = `${safeBase}_${uniqueSuffix}${ext}`;
      const destPath = path.join(DROP_DIR, tempFileName);

      fs.writeFileSync(destPath, Buffer.from(arrayBuf));

      if (isArchiveFile(fileName)) {
        log(`Unpacking archive "${fileName}" via durable queue...`);
        const queue = botJobQueue;
        const job = queue.enqueue("archive_ingest", {
          archivePath: destPath,
          archiveName: fileName,
          deleteAfterExtract: true,
        });
        const outcome = await queue.waitForJob(job.id);
        if (outcome.status !== "completed") {
          results.push({
            name: fileName,
            format,
            status: "error",
            note: outcome.error || "Archive extraction failed",
          });
          continue;
        }

        const outcomeResult = outcome.result;
        for (const r of outcomeResult?.results || []) {
          results.push({
            name: r.name,
            title: r.displayTitle || r.title,
            author: r.author || r.authors,
            format: r.format,
            bookId: r.bookId,
            attachedFormat: r.attachedFormat,
            status: r.duplicate ? "duplicate" : r.success ? "success" : "error",
            note: r.message || r.error || "Processed",
          });
        }
        continue;
      }

      const queue = botJobQueue;
      const job = queue.enqueue("file_ingest", {
        filePath: destPath,
        originalFileName: fileName,
        deleteAfterIngest: true,
      });
      const outcome = await queue.waitForJob(job.id);
      const res = outcome.result || { success: false, error: outcome.error };

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
      });
    } catch (err: any) {
      results.push({
        name: fileName,
        format,
        status: "error",
        note: err.message,
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
      );
    }
  }
}

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

async function pollTelegram() {
  log(
    `Polling started via proxy ${PROXY_URL} for bot: ${TELEGRAM_BOT_TOKEN.substring(0, 10)}...`,
  );

  await initChatMenuButton();

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
              continue;
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
              continue;
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
              continue;
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
              continue;
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
              continue;
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
                continue;
              }

              log(`Searching library for "${query}" from ${sender}`);
              const results = searchCalibreLibrary(query, 5);

              if (results.length === 0) {
                await sendMessage(
                  chatId,
                  `🔍 *No books found matching "${escapeTelegramMarkdown(query)}".*\n\nTry searching by title, author name, or series name.`,
                  "Markdown",
                );
                continue;
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
              continue;
            }

            // Book Retrieval: /get <id> or /get_<id>
            const getMatch = text.match(/^\/get(?:_|\s+)(\d+)$/i);
            if (getMatch) {
              const bookId = parseInt(getMatch[1], 10);
              log(`Handling /get command for book #${bookId} from ${sender}`);
              await retrieveAndSendBook(chatId, bookId);
              continue;
            }
            if (/^\/get(?:@\w+)?$/i.test(text)) {
              await sendMessage(
                chatId,
                `ℹ️ *Book Retrieval*\n\nPlease specify a book ID:\nUsage: \`/get <id>\`\nExample: \`/get 6\``,
                "Markdown",
              );
              continue;
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
              continue;
            }

            const articleUrl = extractUrlFromText(text);

            if (articleUrl) {
              log(
                `Detected article URL in message: "${articleUrl}" from ${sender}`,
              );
              const statusMsgId = await sendMessage(
                chatId,
                `⏳ *Extracting article from URL...*\n\`${articleUrl}\``,
                "Markdown",
              );

              try {
                const queue = botJobQueue;
                const job = queue.enqueue("url_ingest", { url: articleUrl });
                const outcome = await queue.waitForJob(job.id);
                const result = outcome.result || {
                  success: false,
                  error: outcome.error,
                };

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
                    await sendDocument(
                      chatId,
                      result.epubPath,
                      caption,
                      "Markdown",
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
              text.startsWith("/help ")
            ) {
              await sendMessage(
                chatId,
                `📚 *Reading HQ Commands & Features*\n\n` +
                  `• \`/menu\` - Interactive dashboard with one-tap access\n` +
                  `• \`/reading\` - Currently reading shelf with progress bars\n` +
                  `• \`/recent\` - 5 newest books in Calibre library\n` +
                  `• \`/find <query>\` (or \`/f <query>\`) - Search library\n` +
                  `• \`/get <id>\` - Download any book by ID\n` +
                  `• \`/app\` - Launch Reading HQ Mini App\n` +
                  `• \`/status\` (or \`/health\`) - System health dashboard\n` +
                  `• \`/backup\` - Hot backup of SQLite databases\n\n` +
                  `_Send any eBook file (.epub, .pdf, .cbz) or article URL to ingest immediately._`,
                "Markdown",
                getMainMenuKeyboard(),
              );
              initChatMenuButton(chatId).catch(() => {});
            } else {
              await sendMessage(
                chatId,
                `📚 Please send eBook files (\`.epub\`, \`.pdf\`, \`.mobi\`, \`.cbz\`), paste an article URL, search your library (\`/find <query>\`), view current reads (\`/reading\`), view recent books (\`/recent\`), open the dashboard (\`/menu\`), check system status (\`/status\`), or send \`/backup\`. For files over 20MB, use [Reading HQ](${READING_WEBAPP_URL}).`,
                "Markdown",
                getMainMenuKeyboard(),
              );
            }
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
