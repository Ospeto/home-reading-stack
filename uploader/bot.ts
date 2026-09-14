import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import crypto from "node:crypto";
import { Database } from "bun:sqlite";
import {
  searchUniversalMetadata,
  applyMetadataToCalibre,
  sanitizeMetadata,
  extractSeries,
  isSameBook,
  normalizeFormat
} from "./scraper";
import { isArchiveFile, unpackArchive } from "./archive";
import { extractUrlFromText, ingestArticleFromUrl } from "./article";

const DROP_DIR = "/Users/ospeto/Books_Drop";
const SERVER_URL = "http://127.0.0.1:8088";
const ENV_PATH = process.env.ENV_PATH || "/Users/ospeto/uploader/.env";
const CACHE_DB_PATH = "/Users/ospeto/uploader/cache.db";
const KOSYNC_DB_PATH = process.env.KOSYNC_DB_PATH || "/Users/ospeto/kosync-server/data/koreader-sync.db";
const CALIBRE_DB_PATH = process.env.CALIBRE_DB_PATH || "/Users/ospeto/Calibre Libraries/Agent Library/metadata.db";
const CALIBRE_LIBRARY_DIR = process.env.CALIBRE_LIBRARY_DIR || path.dirname(CALIBRE_DB_PATH);
const MANGA_DB_PATH = process.env.MANGA_DB_PATH || "/Users/ospeto/manga-processor/manga.db";
const PROXY_URL = "http://127.0.0.1:7890";
const WEB_UPLOADER_URL = "http://192.168.31.15:8086";
const CALIBRE_WEB_URL = "http://192.168.31.15:8088";
export const READING_WEBAPP_URL = process.env.READING_WEBAPP_URL || "https://reading.wavypremium.xyz";
const MAX_TELEGRAM_FILE_SIZE = 20 * 1024 * 1024; // 20MB Telegram Bot API limit
const ALLOWED_EXTS = [".epub", ".pdf", ".mobi", ".azw3", ".cbz", ".cbr", ".azw", ".zip", ".rar", ".7z", ".tar"];

const INITIAL_BACKOFF_MS = 2000;
const MAX_BACKOFF_MS = 60000;
const POLL_TIMEOUT_SECONDS = 25;
const POLL_REQUEST_TIMEOUT_MS = 35000;

if (!fs.existsSync(DROP_DIR)) {
  fs.mkdirSync(DROP_DIR, { recursive: true });
}

const cacheDb = new Database(CACHE_DB_PATH);
cacheDb.run("PRAGMA busy_timeout = 5000;");
cacheDb.run(`
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
cacheDb.run(`CREATE INDEX IF NOT EXISTS idx_file_hashes_hash ON file_hashes(hash);`);

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
  console.error("[TelegramBot] Missing TELEGRAM_BOT_TOKEN. Exiting.");
  process.exit(1);
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
  env.PATH = "/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:" + (env.PATH || "");

  return spawnSync("/opt/homebrew/bin/calibredb", args, {
    encoding: "utf8",
    env
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
  const signal = options.signal || AbortSignal.timeout(timeoutMs);

  const fetchOpts: any = {
    ...options,
    signal,
    proxy: PROXY_URL
  };
  delete fetchOpts.timeoutMs;
  return await fetch(url, fetchOpts);
}

async function sendMessage(
  chatId: number,
  text: string,
  parseMode: string = "",
  replyMarkup: any = null
): Promise<number | null> {
  try {
    const body: any = { chat_id: chatId, text };
    if (parseMode) body.parse_mode = parseMode;
    if (replyMarkup) body.reply_markup = replyMarkup;
    const res = await tgFetch("sendMessage", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
      timeoutMs: 15000
    });
    const data = (await res.json()) as any;
    if (data.ok && data.result?.message_id) {
      return data.result.message_id;
    }
    // Safe Telegram plain-text fallback:
    if (
      !data.ok &&
      parseMode &&
      (data.error_code === 400 || (data.description && /parse|entity|markdown/i.test(data.description)))
    ) {
      logError(`sendMessage failed with parseMode="${parseMode}" (${data.description}), retrying as plain text...`);
      const fallbackBody: any = { chat_id: chatId, text };
      if (replyMarkup) fallbackBody.reply_markup = replyMarkup;
      const retryRes = await tgFetch("sendMessage", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(fallbackBody),
        timeoutMs: 15000
      });
      const retryData = (await retryRes.json()) as any;
      if (retryData.ok && retryData.result?.message_id) {
        return retryData.result.message_id;
      } else {
        logError(`sendMessage plain-text retry also failed: ${retryData.description}`);
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
  replyMarkup: any = null
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
        timeoutMs: 15000
      });
      const data = (await res.json()) as any;
      if (data.ok && data.result?.message_id) {
        return data.result.message_id;
      }
      // Safe Telegram plain-text fallback:
      if (
        !data.ok &&
        parseMode &&
        (data.error_code === 400 || (data.description && /parse|entity|markdown/i.test(data.description)))
      ) {
        logError(`editMessageText failed with parseMode="${parseMode}" (${data.description}), retrying as plain text...`);
        const fallbackBody: any = { chat_id: chatId, message_id: messageId, text };
        if (replyMarkup) fallbackBody.reply_markup = replyMarkup;
        const retryRes = await tgFetch("editMessageText", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(fallbackBody),
          timeoutMs: 15000
        });
        const retryData = (await retryRes.json()) as any;
        if (retryData.ok && retryData.result?.message_id) {
          return retryData.result.message_id;
        }
      }
    } catch (err: any) {
      logError(`editMessageText failed for message ${messageId}, falling back to sendMessage: ${err?.message || err}`);
    }
  }
  return await sendMessage(chatId, text, parseMode, replyMarkup);
}

async function sendDocument(
  chatId: number,
  filePath: string,
  caption: string = "",
  parseMode: string = "",
  mimeType: string = ""
): Promise<boolean> {
  try {
    const formData = new FormData();
    formData.append("chat_id", String(chatId));
    const fileBytes = fs.readFileSync(filePath);
    const fileName = path.basename(filePath);
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
      timeoutMs: 60000
    });

    const data = (await res.json()) as any;
    if (data.ok) {
      log(`Sent document "${fileName}" to chat ${chatId}`);
      return true;
    } else if (
      parseMode &&
      (data.error_code === 400 || (data.description && /parse|entity|caption/i.test(data.description)))
    ) {
      logError(`sendDocument failed with parseMode="${parseMode}" (${data.description}), retrying caption as plain text...`);
      const fallbackFormData = new FormData();
      fallbackFormData.append("chat_id", String(chatId));
      fallbackFormData.append("document", blob, fileName);
      if (caption) {
        fallbackFormData.append("caption", caption);
      }
      const retryRes = await tgFetch("sendDocument", {
        method: "POST",
        body: fallbackFormData,
        timeoutMs: 60000
      });
      const retryData = (await retryRes.json()) as any;
      if (retryData.ok) {
        log(`Sent document "${fileName}" to chat ${chatId} (plain-text caption fallback)`);
        return true;
      } else {
        logError(`sendDocument plain-text retry failed for chat ${chatId}: ${retryData.description}`);
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
        web_app: { url: READING_WEBAPP_URL }
      }
    };
    if (chatId) {
      payload.chat_id = chatId;
    }
    const res = await tgFetch("setChatMenuButton", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
      timeoutMs: 15000
    });
    const data = (await res.json()) as any;
    if (data.ok) {
      log(`Registered Telegram Web App Menu Button (${chatId ? `chatId: ${chatId}` : "global default"}) -> ${READING_WEBAPP_URL}`);
      return true;
    } else {
      logError(`Failed to set Telegram Chat Menu Button: ${data.description || "Unknown error"}`);
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
    logError(`Failed to save TELEGRAM_BACKUP_CHAT_ID to ${ENV_PATH}: ${err?.message || err}`);
  }
}

export function createHotDatabaseBackup(): DatabaseBackupResult | null {
  const targets = [
    { name: "KOSync", fileName: "koreader-sync.db", path: KOSYNC_DB_PATH },
    { name: "Calibre", fileName: "metadata.db", path: CALIBRE_DB_PATH },
    { name: "Uploader Cache", fileName: "cache.db", path: CACHE_DB_PATH },
    { name: "Manga", fileName: "manga.db", path: MANGA_DB_PATH }
  ];

  const stagingDir = fs.mkdtempSync(path.join("/tmp", "reading-stack-backup-"));
  const backedUpFiles: string[] = [];
  const backedUpDbs: string[] = [];

  const env: any = {
    ...process.env,
    PATH: "/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:" + (process.env.PATH || "")
  };

  try {
    for (const target of targets) {
      if (!fs.existsSync(target.path)) {
        log(`Database not found at ${target.path}, skipping.`);
        continue;
      }

      const destPath = path.join(stagingDir, target.fileName);
      log(`Backing up ${target.name} (${target.path}) -> ${destPath}...`);
      const backupRes = spawnSync("sqlite3", [target.path, `.backup '${destPath}'`], {
        encoding: "utf8",
        env
      });

      if (backupRes.status === 0 && fs.existsSync(destPath)) {
        backedUpFiles.push(target.fileName);
        backedUpDbs.push(target.name);
        log(`Successfully backed up ${target.name} (${(fs.statSync(destPath).size / 1024).toFixed(1)} KB)`);
      } else {
        logError(`Failed to back up ${target.name}: ${backupRes.stderr || "sqlite3 exited with code " + backupRes.status}`);
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
    const tarRes = spawnSync("tar", ["-czf", archivePath, "-C", stagingDir, ...backedUpFiles], {
      encoding: "utf8",
      env
    });

    if (tarRes.status !== 0 || !fs.existsSync(archivePath)) {
      logError(`Failed to create tar archive: ${tarRes.stderr || "tar exited with code " + tarRes.status}`);
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
      backedUpDbs
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

export function searchCalibreLibrary(query: string, limit: number = 5): CalibreBookResult[] {
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
      const primaryRows = db.query(primarySql).all(wildcardQuery, wildcardQuery, wildcardQuery, limit) as any[];

      const matchedBooks: CalibreBookResult[] = primaryRows.map((r) => ({
        id: r.id,
        title: r.title || "Untitled",
        authors: r.authors || "Unknown",
        series: r.series || null,
        series_index: r.series_index || null,
        formats: r.formats || ""
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
              formats: r.formats || ""
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
      logError(`SQLite search failed, falling back to calibredb: ${err?.message || err}`);
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
      "--for-machine"
    ]);

    if (listRes.status === 0 && listRes.stdout) {
      const parsed = safeParseJson(listRes.stdout);
      if (Array.isArray(parsed)) {
        return parsed.slice(0, limit).map((item: any) => {
          const fmts = Array.isArray(item.formats)
            ? item.formats.map((f: string) => path.extname(f).replace(/^\./, "").toUpperCase() || f).join(",")
            : String(item.formats || "");
          return {
            id: item.id,
            title: item.title || "Untitled",
            authors: Array.isArray(item.authors) ? item.authors.join(", ") : String(item.authors || "Unknown"),
            series: item.series || null,
            series_index: item.series_index || null,
            formats: fmts
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
  chosenFormat: string;
  filePath: string;
  fileSize: number;
}

export function locateBookFile(bookId: number): BookFileDetails | null {
  const PREFERRED_FORMATS = ["EPUB", "PDF", "MOBI", "AZW3", "CBZ", "CBR", "AZW", "ZIP", "RAR", "7Z"];

  if (fs.existsSync(CALIBRE_DB_PATH)) {
    try {
      const db = new Database(CALIBRE_DB_PATH, { readonly: true });
      db.run("PRAGMA busy_timeout = 3000;");

      const rows = db.query(`
        SELECT b.id, b.title, b.path,
               GROUP_CONCAT(DISTINCT a.name) as authors,
               d.format, d.name as filename, d.uncompressed_size
        FROM books b
        JOIN data d ON b.id = d.book
        LEFT JOIN books_authors_link bal ON b.id = bal.book
        LEFT JOIN authors a ON bal.author = a.id
        WHERE b.id = ?
        GROUP BY d.id
      `).all(bookId) as any[];

      db.close();

      if (rows && rows.length > 0) {
        const title = rows[0].title || "Book";
        const authors = rows[0].authors || "Unknown";
        const bookRelPath = rows[0].path;
        const basePath = path.join(CALIBRE_LIBRARY_DIR, bookRelPath);

        // Sort by preferred formats (EPUB first, etc.)
        rows.sort((a, b) => {
          const idxA = PREFERRED_FORMATS.indexOf(String(a.format || "").toUpperCase());
          const idxB = PREFERRED_FORMATS.indexOf(String(b.format || "").toUpperCase());
          const scoreA = idxA === -1 ? 999 : idxA;
          const scoreB = idxB === -1 ? 999 : idxB;
          return scoreA - scoreB;
        });

        for (const row of rows) {
          const fmt = String(row.format || "").toUpperCase();
          const filename = row.filename;

          const candidate1 = path.join(basePath, `${filename}.${fmt.toLowerCase()}`);
          const candidate2 = path.join(basePath, `${filename}.${fmt.toUpperCase()}`);

          if (fs.existsSync(candidate1)) {
            const stat = fs.statSync(candidate1);
            return { bookId, title, authors, chosenFormat: fmt, filePath: candidate1, fileSize: stat.size };
          }
          if (fs.existsSync(candidate2)) {
            const stat = fs.statSync(candidate2);
            return { bookId, title, authors, chosenFormat: fmt, filePath: candidate2, fileSize: stat.size };
          }

          if (fs.existsSync(basePath)) {
            const files = fs.readdirSync(basePath);
            const extLower = `.${fmt.toLowerCase()}`;
            const matchedFile = files.find((f) => f.toLowerCase().endsWith(extLower));
            if (matchedFile) {
              const fullPath = path.join(basePath, matchedFile);
              const stat = fs.statSync(fullPath);
              return { bookId, title, authors, chosenFormat: fmt, filePath: fullPath, fileSize: stat.size };
            }
          }
        }
      }
    } catch (err: any) {
      logError(`Error locating book file via SQLite for #${bookId}: ${err?.message || err}`);
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
      "--for-machine"
    ]);

    if (listRes.status === 0 && listRes.stdout) {
      const parsed = safeParseJson(listRes.stdout);
      if (Array.isArray(parsed) && parsed.length > 0) {
        const item = parsed[0];
        const title = item.title || "Book";
        const authors = Array.isArray(item.authors) ? item.authors.join(", ") : String(item.authors || "Unknown");
        const fmts: string[] = Array.isArray(item.formats) ? item.formats : [];

        for (const f of fmts) {
          if (fs.existsSync(f)) {
            const stat = fs.statSync(f);
            const fmtName = path.extname(f).replace(/^\./, "").toUpperCase() || "FILE";
            return { bookId, title, authors, chosenFormat: fmtName, filePath: f, fileSize: stat.size };
          }
        }
      }
    }
  } catch (err: any) {
    logError(`calibredb fallback failed for #${bookId}: ${err?.message || err}`);
  }

  return null;
}

export async function retrieveAndSendBook(chatId: number, bookId: number): Promise<boolean> {
  const fileDetails = locateBookFile(bookId);

  if (!fileDetails) {
    log(`Book #${bookId} not found on disk.`);
    await sendMessage(
      chatId,
      `❌ *Book #${bookId} Not Found*\n\nUnable to locate the file in Calibre library. Verify the book exists via [Calibre Web](${CALIBRE_WEB_URL}).`,
      "Markdown"
    );
    return false;
  }

  const { title, authors, chosenFormat, filePath, fileSize } = fileDetails;

  // Check 20MB Telegram limit
  if (fileSize > MAX_TELEGRAM_FILE_SIZE) {
    const sizeMB = (fileSize / (1024 * 1024)).toFixed(1);
    log(`Book #${bookId} (${title}) exceeds 20MB (${sizeMB} MB). Sending web links.`);
    await sendMessage(
      chatId,
      `⚠️ *File Exceeds Telegram Bot Limit*\n\n` +
      `📚 *${escapeTelegramMarkdown(title)}* (\`${chosenFormat}\`) is *${sizeMB} MB*, exceeding Telegram Bot API's *20 MB* download ceiling.\n\n` +
      `👉 *Read Online or Download via Calibre Web:*\n` +
      `• [Read Online](${CALIBRE_WEB_URL}/read/${bookId}/epub)\n` +
      `• [Book Details](${CALIBRE_WEB_URL}/#book_id=${bookId}&panel=book_details)`,
      "Markdown"
    );
    return false;
  }

  const statusMsgId = await sendMessage(
    chatId,
    `⏳ *Retrieving \`${chosenFormat}\` for "${escapeTelegramMarkdown(title)}"...*`,
    "Markdown"
  );

  const caption =
    `📚 *${escapeTelegramMarkdown(title)}*\n` +
    `👤 *Author:* ${escapeTelegramMarkdown(authors)}\n` +
    `📦 *Format:* \`${chosenFormat}\`\n\n` +
    `[Read Online](${CALIBRE_WEB_URL}/read/${bookId}/epub) • [Book Details](${CALIBRE_WEB_URL}/#book_id=${bookId}&panel=book_details)`;

  const sent = await sendDocument(chatId, filePath, caption, "Markdown");

  if (sent) {
    if (statusMsgId) {
      await editOrSendMessage(
        chatId,
        statusMsgId,
        `✅ *Delivered "${escapeTelegramMarkdown(title)}" below.*`,
        "Markdown"
      );
    }
    return true;
  } else {
    if (statusMsgId) {
      await editOrSendMessage(
        chatId,
        statusMsgId,
        `⚠️ Failed to send *${escapeTelegramMarkdown(title)}*. Check bot logs.`,
        "Markdown"
      );
    }
    return false;
  }
}

export async function handleCallbackQuery(cq: any): Promise<void> {
  const callbackId = cq.id;
  const chatId = cq.message?.chat?.id || cq.from?.id;
  const data = cq.data || "";
  const sender = cq.from?.username || cq.from?.first_name || `ID ${chatId}`;

  log(`Received callback_query: "${data}" from ${sender} (chatId: ${chatId})`);

  // Answer callback query immediately so Telegram client stops loading animation
  try {
    await tgFetch("answerCallbackQuery", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ callback_query_id: callbackId }),
      timeoutMs: 10000
    });
  } catch (err: any) {
    logError(`answerCallbackQuery failed: ${err?.message || err}`);
  }

  if (data.startsWith("send_book:")) {
    const rawId = data.replace("send_book:", "").trim();
    const bookId = parseInt(rawId, 10);
    if (!isNaN(bookId) && bookId > 0) {
      await retrieveAndSendBook(chatId, bookId);
    } else {
      await sendMessage(chatId, `❌ Invalid book ID: \`${rawId}\``, "Markdown");
    }
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

function ingestBookFile(filePath: string, originalFileName: string): IngestResult {
  const format = normalizeFormat(path.extname(originalFileName));
  const preliminary = sanitizeMetadata("", "", [], originalFileName);

  // 1. Level 1: KOReader Binary Checksum Deduplication
  const fileHash = getKOReaderBinary256(filePath);
  if (fileHash) {
    const hashMatch = cacheDb.query(
      "SELECT book_id, title, authors FROM file_hashes WHERE hash = ? LIMIT 1"
    ).get(fileHash) as any;

    if (hashMatch && hashMatch.book_id) {
      log(`Duplicate detected via KOReader binary hash: "${hashMatch.title}" (ID: ${hashMatch.book_id})`);
      return {
        success: true,
        duplicate: true,
        bookId: hashMatch.book_id,
        displayTitle: hashMatch.title || preliminary.title,
        author: hashMatch.authors || preliminary.author,
        format,
        message: "Already in your library (identical content)"
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
      "--for-machine"
    ]);

    let books: any[] = [];
    if (listRes.status === 0 && listRes.stdout) {
      const parsed = safeParseJson(listRes.stdout);
      if (Array.isArray(parsed)) books = parsed;
    }

    const existingBook = books.find((b: any) =>
      isSameBook(
        { title: b.title, authors: b.authors, series: b.series, series_index: b.series_index },
        { title: preliminary.title, author: preliminary.author, series: incomingSeries }
      )
    );

    if (existingBook) {
      const existingFormats = (existingBook.formats || []).map((f: string) => normalizeFormat(f));
      if (existingFormats.includes(format)) {
        log(`Duplicate detected via title/series match: "${existingBook.title}" (has format: ${format})`);
        return {
          success: true,
          duplicate: true,
          bookId: existingBook.id,
          displayTitle: existingBook.title,
          author: existingBook.authors || preliminary.author,
          format,
          message: `Already exists in format ${format}`
        };
      } else {
        // Multi-format attach
        log(`Attaching new format ${format} to existing book "${existingBook.title}" (ID: ${existingBook.id})`);
        runCalibredb([
          "add_format",
          String(existingBook.id),
          filePath,
          "--with-library",
          SERVER_URL
        ]);

        if (fileHash) {
          cacheDb.run(
            "INSERT OR REPLACE INTO file_hashes (filepath, mtime, hash, book_id, title, authors, cover) VALUES (?, ?, ?, ?, ?, ?, ?)",
            filePath, Date.now(), fileHash, existingBook.id, existingBook.title, existingBook.authors || "", 0
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
          message: `Attached ${format} format to existing book`
        };
      }
    }

    // 3. Level 3: Add to Calibre with --automerge ignore guard
    const addRes = runCalibredb([
      "add",
      filePath,
      "--with-library",
      SERVER_URL,
      "--automerge",
      "ignore"
    ]);

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
          "--for-machine"
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

        const clean = sanitizeMetadata(rawTitle, rawAuthors, rawTags, originalFileName);
        finalTitle = clean.title || preliminary.title;
        finalAuthor = clean.author || preliminary.author;

        const setArgs = ["set_metadata", String(newId), "--with-library", SERVER_URL];
        if (clean.title && clean.title !== rawTitle) setArgs.push("--field", `title:${clean.title}`);
        if (clean.author && clean.author !== rawAuthors && clean.author !== "Unknown") setArgs.push("--field", `authors:${clean.author}`);
        if (clean.tags && clean.tags.length) setArgs.push("--field", `tags:${clean.tags.join(",")}`);

        // Serialization auto-tagging
        if (!rawSeries && incomingSeries) {
          setArgs.push("--field", `series:${incomingSeries.series}`);
          setArgs.push("--field", `series_index:${incomingSeries.volume}`);
          log(`Auto-assigned series "${incomingSeries.series}" #${incomingSeries.volume} to ID ${newId}`);
        }

        if (setArgs.length > 4) {
          runCalibredb(setArgs);
        }

        // Cache binary hash for instant future deduplication
        if (fileHash) {
          cacheDb.run(
            "INSERT OR REPLACE INTO file_hashes (filepath, mtime, hash, book_id, title, authors, cover) VALUES (?, ?, ?, ?, ?, ?, ?)",
            filePath, Date.now(), fileHash, newId, finalTitle, finalAuthor, 0
          );
        }

        // Background scraper enrichment
        setTimeout(async () => {
          try {
            const isManga = format === "CBZ" || format === "CBR" || (clean.tags || []).some(t => /manga|comic/i.test(t));
            log(`Background metadata enrichment for book ID ${newId} ("${finalTitle}")...`);
            const matches = await searchUniversalMetadata(finalTitle, isManga);
            if (matches.length > 0 && matches[0].confidence >= 0.85) {
              await applyMetadataToCalibre(newId, matches[0]);
              log(`Auto-applied metadata (${matches[0].source}, confidence: ${matches[0].confidence}) to ID ${newId}`);
            }
          } catch (err: any) {
            logError(`Scraper background task error for ID ${newId}: ${err.message}`);
          }
        }, 300);
      }

      return {
        success: true,
        duplicate: false,
        bookId: newId,
        displayTitle: finalTitle,
        author: finalAuthor,
        format,
        message: incomingSeries ? `Added (${incomingSeries.series} #${incomingSeries.volume})` : `Added to library`
      };
    } else {
      return {
        success: false,
        duplicate: false,
        displayTitle: preliminary.title || originalFileName,
        author: preliminary.author,
        format,
        error: addRes.stderr || "Failed to add book to Calibre"
      };
    }
  } catch (err: any) {
    return {
      success: false,
      duplicate: false,
      displayTitle: preliminary.title || originalFileName,
      author: preliminary.author,
      format,
      error: err.message
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

const pendingBatches = new Map<number, {
  docs: QueuedDoc[];
  timer: any;
}>();

async function processBatch(chatId: number, items: QueuedDoc[]) {
  if (items.length === 0) return;

  const isBatch = items.length > 1;
  const total = items.length;
  log(`Processing batch of ${total} item(s) for chat ${chatId}`);

  let statusMsgId: number | null = null;
  if (isBatch) {
    statusMsgId = await sendMessage(chatId, `\uD83D\uDCE5 Received *${total}* books. Starting batch ingestion...`, "Markdown");
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

    log(`[Batch ${i + 1}/${total}] Processing "${fileName}" (${sizeMB} MB) from ${sender}`);

    if (!ALLOWED_EXTS.includes(ext)) {
      results.push({
        name: fileName,
        format,
        status: "error",
        note: `Unsupported format: ${ext}`
      });
      continue;
    }

    if (fileSize > MAX_TELEGRAM_FILE_SIZE) {
      results.push({
        name: fileName,
        format,
        status: "error",
        note: `Exceeds 20MB limit (${sizeMB} MB). Use Web Uploader: ${WEB_UPLOADER_URL}`
      });
      continue;
    }

    if (isBatch) {
      await editOrSendMessage(chatId, statusMsgId, `⏳ *[${i + 1}/${total}]* Ingesting "${fileName}"...`, "Markdown");
    } else {
      statusMsgId = await sendMessage(chatId, `⏳ Downloading & Ingesting "${fileName}" (${sizeMB} MB)...`);
    }

    // Download from Telegram
    try {
      const fileRes = await tgFetch(`getFile?file_id=${doc.file_id}`, { timeoutMs: 20000 });
      const fileJson = await fileRes.json() as any;

      if (!fileJson.ok || !fileJson.result?.file_path) {
        const errMsg = fileJson.description || "Failed to retrieve file from Telegram";
        results.push({ name: fileName, format, status: "error", note: errMsg });
        continue;
      }

      const dlUrl = `https://api.telegram.org/file/bot${TELEGRAM_BOT_TOKEN}/${fileJson.result.file_path}`;
      const dl = await fetch(dlUrl, { proxy: PROXY_URL } as any);
      if (!dl.ok) {
        results.push({ name: fileName, format, status: "error", note: `Download failed (HTTP ${dl.status})` });
        continue;
      }

      const arrayBuf = await dl.arrayBuffer();
      const uniqueSuffix = `${Date.now()}_${Math.random().toString(36).substring(2, 6)}`;
      const safeBase = path.basename(fileName, ext);
      const tempFileName = `${safeBase}_${uniqueSuffix}${ext}`;
      const destPath = path.join(DROP_DIR, tempFileName);

      fs.writeFileSync(destPath, Buffer.from(arrayBuf));

      if (isArchiveFile(fileName)) {
        log(`Unpacking archive "${fileName}"...`);
        const unp = unpackArchive(destPath);
        try { fs.unlinkSync(destPath); } catch {}

        if (!unp.success) {
          results.push({ name: fileName, format, status: "error", note: unp.error || "Archive extraction failed" });
          continue;
        }

        if (unp.books.length === 0) {
          unp.cleanup();
          results.push({ name: fileName, format, status: "error", note: "No supported eBooks found in archive" });
          continue;
        }

        log(`Archive "${fileName}" yielded ${unp.books.length} book(s)`);
        for (const b of unp.books) {
          const r = ingestBookFile(b.tempPath, b.originalName);
          results.push({
            name: b.originalName,
            title: r.displayTitle,
            author: r.author,
            format: r.format,
            bookId: r.bookId,
            attachedFormat: r.attachedFormat,
            status: r.duplicate ? "duplicate" : (r.success ? "success" : "error"),
            note: r.message || r.error || "Processed"
          });
        }
        unp.cleanup();
        continue;
      }

      const res = ingestBookFile(destPath, fileName);
      try { fs.unlinkSync(destPath); } catch {}

      results.push({
        name: fileName,
        title: res.displayTitle,
        author: res.author,
        format: res.format,
        bookId: res.bookId,
        attachedFormat: res.attachedFormat,
        status: res.duplicate ? "duplicate" : (res.success ? "success" : "error"),
        note: res.message || res.error || (res.success ? "Added" : "Calibre ingest failed")
      });
    } catch (err: any) {
      results.push({ name: fileName, format, status: "error", note: err.message });
    }
  }

  // Send Final Status with Rich Details and Calibre Links
  if (isBatch) {
    const successCount = results.filter(r => r.status === "success").length;
    const duplicateCount = results.filter(r => r.status === "duplicate").length;
    const totalSuccess = successCount + duplicateCount;

    let summary = `\uD83D\uDCDA *Batch Ingestion Complete* (${totalSuccess}/${total} processed)\n\n`;

    for (const r of results) {
      const link = r.bookId ? `[Open](${CALIBRE_WEB_URL}/#book_id=${r.bookId}&panel=book_details)` : "";
      const authorStr = r.author && r.author !== "Unknown" ? ` by _${r.author}_` : "";
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
    await editOrSendMessage(chatId, statusMsgId, summary, "Markdown");
  } else {
    const single = results[0];
    const detailsLink = single.bookId ? `[Book Details](${CALIBRE_WEB_URL}/#book_id=${single.bookId}&panel=book_details)` : "";
    const readerLink = (single.bookId && single.format) ? `[Read Online](${CALIBRE_WEB_URL}/read/${single.bookId}/${single.format.toLowerCase()})` : "";
    const links = [detailsLink, readerLink].filter(Boolean).join(" • ");

    if (single.status === "success") {
      const actionHeader = single.attachedFormat ? "\uD83D\uDCCE *Format Attached*" : "✅ *Book Ingested Successfully*";
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
        "Markdown"
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
        "Markdown"
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
        "Markdown"
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
  log(`Polling started via proxy ${PROXY_URL} for bot: ${TELEGRAM_BOT_TOKEN.substring(0, 10)}...`);

  await initChatMenuButton();

  while (isPollingRunning) {
    try {
      const res = await tgFetch(`getUpdates?offset=${offset}&timeout=${POLL_TIMEOUT_SECONDS}`, {
        timeoutMs: POLL_REQUEST_TIMEOUT_MS
      });

      if (!res.ok) {
        const errText = await res.text().catch(() => "");
        logError(`getUpdates returned HTTP ${res.status}: ${errText}. Retrying in ${Math.round(backoffMs / 1000)}s...`);
        await new Promise((r) => setTimeout(r, backoffMs));
        backoffMs = Math.min(backoffMs * 2, MAX_BACKOFF_MS);
        continue;
      }

      const json = await res.json() as any;
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
          const sender = msg.from?.username || msg.from?.first_name || `ID ${chatId}`;

          if (msg.document) {
            const doc = msg.document;
            const fileName = doc.file_name || "telegram_book.epub";
            const fileSize = doc.file_size || 0;

            if (fileSize > MAX_TELEGRAM_FILE_SIZE) {
              const sizeMB = (fileSize / (1024 * 1024)).toFixed(1);
              log(`File "${fileName}" exceeds 20MB (${sizeMB} MB). Sending instant Web Uploader redirect to chat ${chatId}`);
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
                        web_app: { url: READING_WEBAPP_URL }
                      }
                    ]
                  ]
                }
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

            if (text === "/backup" || text.startsWith("/backup@") || text.startsWith("/backup ")) {
              log(`Handling /backup command from ${sender} (chatId: ${chatId})`);
              const statusMsgId = await sendMessage(
                chatId,
                `⏳ *Creating hot SQLite backup of reading stack databases...*`,
                "Markdown"
              );

              saveBackupChatId(chatId);

              const backupResult = createHotDatabaseBackup();
              if (backupResult) {
                try {
                  const dbList = backupResult.backedUpDbs.join(", ");
                  const caption =
                    `\uD83D\uDCE6 *Reading Stack Database Backup*\n` +
                    `\uD83D\uDCC5 *Date:* ${backupResult.displayTimestamp}\n` +
                    `\uD83D\uDCCA *Size:* ${backupResult.sizeKb} KB\n` +
                    `\uD83D\uDDD4\uFE0F *Databases:* ${dbList}\n` +
                    `✨ _Secure offline snapshot stored in your Telegram history._`;

                  const sent = await sendDocument(
                    chatId,
                    backupResult.archivePath,
                    caption,
                    "Markdown"
                  );

                  if (sent) {
                    if (statusMsgId) {
                      await editOrSendMessage(
                        chatId,
                        statusMsgId,
                        `✅ *Hot SQLite backup created successfully.* Delivered below.`,
                        "Markdown"
                      );
                    }
                  } else {
                    await editOrSendMessage(
                      chatId,
                      statusMsgId,
                      `⚠️ *Backup Delivery Failed*\n\nUnable to deliver backup archive to Telegram. Check bot logs for details.`,
                      "Markdown"
                    );
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
                await editOrSendMessage(
                  chatId,
                  statusMsgId,
                  `⚠️ *Database Backup Failed*\n\nCould not snapshot reading stack databases. Please check system logs.`,
                  "Markdown"
                );
              }
              continue;
            }

            // Library Search: /find <query>, /search <query>, /f <query>
            const searchMatch = text.match(/^\/(?:search|find|f)(?:@\w+)?(?:\s+(.*))?$/i);
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
                  "Markdown"
                );
                continue;
              }

              log(`Searching library for "${query}" from ${sender}`);
              const results = searchCalibreLibrary(query, 5);

              if (results.length === 0) {
                await sendMessage(
                  chatId,
                  `🔍 *No books found matching "${escapeTelegramMarkdown(query)}".*\n\nTry searching by title, author name, or series name.`,
                  "Markdown"
                );
                continue;
              }

              await sendMessage(
                chatId,
                `🔍 *Found ${results.length} book(s) matching "${escapeTelegramMarkdown(query)}":*`,
                "Markdown"
              );

              for (const book of results) {
                const formatBadges = (book.formats || "")
                  .split(",")
                  .flatMap((f: string) => (f.trim() ? [`[${f.trim()}]`] : []))
                  .join(" ");

                let card = `📚 *${escapeTelegramMarkdown(book.title)}*\n`;
                card += `👤 *Author:* ${escapeTelegramMarkdown(book.authors || "Unknown")}\n`;
                if (book.series) {
                  const idx = book.series_index ? ` (#${book.series_index})` : "";
                  card += `📖 *Series:* ${escapeTelegramMarkdown(book.series)}${idx}\n`;
                }
                card += `📦 *Formats:* \`${formatBadges || "[None]"}\`\n\n`;
                card += `💡 _Tap below or send_ \`/get ${book.id}\``;

                const inlineKeyboard = {
                  inline_keyboard: [
                    [
                      { text: "📥 Send File", callback_data: `send_book:${book.id}` },
                      { text: "📖 Read Online", url: `${CALIBRE_WEB_URL}/read/${book.id}/epub` },
                      { text: "ℹ️ Details", url: `${CALIBRE_WEB_URL}/#book_id=${book.id}&panel=book_details` }
                    ]
                  ]
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
                "Markdown"
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
                        web_app: { url: READING_WEBAPP_URL }
                      }
                    ]
                  ]
                }
              );
              initChatMenuButton(chatId).catch(() => {});
              continue;
            }

            const articleUrl = extractUrlFromText(text);

            if (articleUrl) {
              log(`Detected article URL in message: "${articleUrl}" from ${sender}`);
              const statusMsgId = await sendMessage(
                chatId,
                `⏳ *Extracting article from URL...*\n\`${articleUrl}\``,
                "Markdown"
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
                  const links = [detailsLink, readerLink].filter(Boolean).join(" • ");

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

                  await editOrSendMessage(chatId, statusMsgId, confirmation, "Markdown");

                  if (result.epubPath && fs.existsSync(result.epubPath)) {
                    log(`Sending generated EPUB to chat ${chatId}: ${result.epubPath}`);
                    const caption = `\uD83D\uDCD6 *${result.title}*\n\uD83D\uDC64 ${result.authors || "Unknown"}`;
                    await sendDocument(chatId, result.epubPath, caption, "Markdown");
                  }
                } else {
                  await editOrSendMessage(
                    chatId,
                    statusMsgId,
                    `⚠️ *Article Ingestion Failed*\n\n` +
                    `\uD83D\uDD17 *URL:* \`${articleUrl}\`\n` +
                    `❌ *Error:* ${result.error || "Failed to process article"}\n\n` +
                    `_Please verify the link is publicly accessible and try again._`,
                    "Markdown"
                  );
                }
              } catch (err: any) {
                logError(`Article ingestion exception for ${articleUrl}: ${err.message}`);
                const isPaywall = /paid subscription paywall|subscription offer/i.test(err.message);
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
                  "Markdown"
                );
              }
            } else if (text === "/start" || text === "/help") {
              await sendMessage(
                chatId,
                `📖 *Reading HQ Ingestion & Library Bot*\n\n` +
                `Send books, search your library, or ingest web articles directly:\n` +
                `• *Reading HQ Mini App:* Tap the *📖 Reading HQ* menu button or send \`/app\` / \`/webapp\` to launch the responsive catalog dashboard.\n` +
                `• *Library Search:* \`/find <query>\` or \`/search <query>\` (or \`/f <query>\`) to search books by title, author, or series with interactive retrieval.\n` +
                `• *Instant Book Retrieval:* \`/get <id>\` or tap *[📥 Send File]* to download any book directly to Telegram.\n` +
                `• *Web Article Ingestion:* Send or forward any web article URL (or \`/epub <url>\`) to convert into a Kindle-ready EPUB with instant mobile delivery & Calibre sync (includes Jina Reader paywall fallback).\n` +
                `• *Serialization Auto-Group:* Vol 1, Vol 2, Book 3 automatically grouped into Series.\n` +
                `• *Batch Uploads Supported:* Select and send multiple EPUBs/CBZs at once.\n` +
                `• *Duplicate Protection:* Instant binary hash + volume-aware deduplication.\n` +
                `• *Formats:* \`.epub\`, \`.pdf\`, \`.mobi\`, \`.azw3\`, \`.cbz\`, \`.cbr\`\n` +
                `• *File Limit:* Up to *20 MB* per file (Telegram API limit)\n` +
                `• *Large Files (>20MB):* Upload via [Reading HQ](${READING_WEBAPP_URL}) or [Web Uploader](${WEB_UPLOADER_URL})\n` +
                `• \`/backup\`: Instant hot snapshot of all reading databases sent directly to this chat.\n\n` +
                `_Books and articles are automatically de-duplicated, sanitized, and available on your Kindle._`,
                "Markdown",
                {
                  inline_keyboard: [
                    [
                      {
                        text: "📖 Open Reading HQ",
                        web_app: { url: READING_WEBAPP_URL }
                      }
                    ]
                  ]
                }
              );
              initChatMenuButton(chatId).catch(() => {});
            } else {
              await sendMessage(
                chatId,
                `📖 Please send eBook files (\`.epub\`, \`.pdf\`, \`.mobi\`, \`.cbz\`), paste an article URL, search your library (\`/find <query>\`), open the dashboard (\`/app\`), or send \`/backup\` for an instant database snapshot. For files over 20MB, use [Reading HQ](${READING_WEBAPP_URL}).`,
                "Markdown",
                {
                  inline_keyboard: [
                    [
                      {
                        text: "📖 Open Reading HQ",
                        web_app: { url: READING_WEBAPP_URL }
                      }
                    ]
                  ]
                }
              );
            }
          }
        }
      }
    } catch (err: any) {
      const isAbort = err.name === "AbortError" || err.name === "TimeoutError";
      const reason = isAbort ? `Socket timeout after ${POLL_REQUEST_TIMEOUT_MS / 1000}s` : err.message;
      logError(`Polling exception (${reason}). Retrying in ${Math.round(backoffMs / 1000)}s...`);
      await new Promise((r) => setTimeout(r, backoffMs));
      backoffMs = Math.min(backoffMs * 2, MAX_BACKOFF_MS);
    }
  }
}

if ((import.meta as any).main) {
  pollTelegram();
}
