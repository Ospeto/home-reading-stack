import { Database } from "bun:sqlite";
import crypto from "node:crypto";
import { Buffer } from "node:buffer";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import {
  searchUniversalMetadata,
  applyMetadataToCalibre,
  extractSeries as scraperExtractSeries,
  isCommentsEmpty,
  sanitizeSynopsis,
  extractEpubDescription,
  autoEnrichBookSynopsis,
} from "./scraper";
import {
  isArchiveFile,
  unpackArchive,
  MAX_ARCHIVE_SIZE_BYTES,
} from "./archive";
import { ingestArticleFromUrl, generateTypographicCover } from "./article";
import {
  isWanRequest,
  authenticateRequest,
  AuthenticateRequestOptions,
  isAllowedOrigin,
  validateOriginAndCsrf,
  validateUrlForSSRF,
  safeFetchWithSsrf,
  validateIntegerId,
  validateBookFormat,
  isCanonicalEpub,
  validateEpubContent,
  getDownloadFilename,
  sanitizeErrorMessage,
  cleanString,
  extractEpubMetadata,
} from "./security";
import { getJobQueue, DurableJobQueue } from "./jobs";
import { generateMetadataFilename, buildContentDisposition } from "./filename";
import {
  syncObsidian,
  extractHighlightsFromLua,
  type HighlightEntry,
} from "../scripts/sync-obsidian";
import {
  evaluateJunkGate,
  moveToQuarantine,
  extractSeriesWithJev,
  cleanAuthorWithJev,
  resolveBookLanguageAndTags,
  classifyBookSourceCategoryDeterministic,
  containsBurmese,
} from "./jev-shelf";
import { isLnoriUrl, ingestLnoriSeries, type LnoriProgressEvent } from "./lnori";
import { isJoplinRoute, handleJoplinRequest } from "./joplin";
import {
  initHighlightsTable,
  getHighlightsForBook,
  getHighlightsByTitle,
  getHighlightCounts,
  ensureBookHighlightsIndexed,
  batchUpsertHighlights,
  deleteHighlightsForBook,
  cleanQuoteText,
} from "./highlights";
import {
  getKindleStatus,
  getKindleProgress,
  tryAcquireKindleSyncLock,
  releaseKindleSyncLock,
  isKindleSyncCancelled,
  previewKindleSync,
  syncAllBooksToKindle,
  syncSingleBookToKindle,
  cancelKindleSync,
  ejectKindleVolume,
} from "./kindle";
import {
  getSsdBackupStatus,
  saveSsdBackupConfig,
  updateLaunchAgentSchedule,
  performSsdBackup,
  validateScheduleTime,
  validateTargetDirectory,
} from "./ssd-backup";

declare const Bun: any;

export interface ServerDependencies {
  ingestLnoriSeries?: (
    url: string,
    onProgress?: (event: LnoriProgressEvent) => Promise<void> | void,
    dependencies?: any,
  ) => Promise<any>;
  getCalibreBooks?: (forceFresh?: boolean) => any;
}

let serverDependencies: ServerDependencies = {};

export function setServerDependenciesForTest(deps: ServerDependencies) {
  serverDependencies = deps;
}

export function resetServerDependenciesForTest() {
  serverDependencies = {};
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

export function getCoverCacheDir(): string {
  const defaultDir =
    process.env.COVER_CACHE_DIR ||
    path.resolve((import.meta as { dir?: string }).dir || process.cwd(), "cache", "covers");
  try {
    if (!fs.existsSync(defaultDir)) {
      fs.mkdirSync(defaultDir, { recursive: true });
    }
    return defaultDir;
  } catch {
    const fallback = path.join(os.tmpdir(), "uploader_cache", "covers");
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
  if (process.env.CALIBRE_DB_PATH) return path.dirname(getCalibreDbPath());
  const home = process.env.HOME || os.homedir();
  return path.join(home, "Calibre Libraries", "Agent Library");
}

export function getCalibreDbETag(): string {
  try {
    const dbPath = getCalibreDbPath();
    if (fs.existsSync(dbPath)) {
      const stat = fs.statSync(dbPath);
      let mtime = Math.floor(stat.mtimeMs);
      const walPath = `${dbPath}-wal`;
      if (fs.existsSync(walPath)) {
        try {
          const walStat = fs.statSync(walPath);
          mtime = Math.max(mtime, Math.floor(walStat.mtimeMs));
        } catch (_walErr) {
          void _walErr;
        }
      }
      return `"${mtime.toString(16)}-${stat.size.toString(16)}"`;
    }
  } catch (_err) {
    void _err;
  }
  return `"${Date.now().toString(16)}"`;
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
const MAX_UPLOAD_SIZE = MAX_ARCHIVE_SIZE_BYTES; // 100MB

const FILE_EXT_PATH_REGEX =
  /\.(?:epub|pdf|mobi|azw\d*|cbz|cbr|zip|rar|7z|tar|gz|bz2|html|jpg|jpeg|png|svg|db)$/i;
const SENSITIVE_KEY_REGEX = /(?:token|secret|password|key|auth)/i;
const PATH_KEY_REGEX = /(?:path|file|dir)$/i;
const ERROR_KEY_REGEX = /(?:error|message|stderr|stdout|reason|note)$/i;

export function recursivelySanitize(val: any, keyName = ""): any {
  if (val === null || val === undefined) return val;

  if (typeof val === "string") {
    if (SENSITIVE_KEY_REGEX.test(keyName)) {
      return "[REDACTED]";
    }
    if (
      PATH_KEY_REGEX.test(keyName) ||
      ((val.includes("/") || val.includes("\\")) &&
        FILE_EXT_PATH_REGEX.test(val))
    ) {
      return path.basename(val);
    }
    if (ERROR_KEY_REGEX.test(keyName)) {
      return sanitizeErrorMessage(val);
    }
    if (
      val.includes("/Users/") ||
      val.includes("/tmp/") ||
      /^[a-zA-Z]:\\/.test(val)
    ) {
      return sanitizeErrorMessage(val);
    }
    return val;
  }

  if (typeof val !== "object") {
    return val;
  }

  if (Array.isArray(val)) {
    return val.map((item) => recursivelySanitize(item, keyName));
  }

  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(val)) {
    out[k] = recursivelySanitize(v, k);
  }
  return out;
}

export function sanitizeJobForResponse(job: any): any {
  if (!job) return null;
  return recursivelySanitize(job);
}

function resolveHtmlPath(): string {
  if (
    process.env.INDEX_HTML_PATH &&
    fs.existsSync(process.env.INDEX_HTML_PATH)
  ) {
    return process.env.INDEX_HTML_PATH;
  }
  try {
    const dir = path.dirname(new URL(import.meta.url).pathname);
    const localPath = path.join(dir, "index.html");
    if (fs.existsSync(localPath)) return localPath;
  } catch {
    // Fall back to default location
  }
  const rootIndex = path.resolve(process.cwd(), "uploader", "index.html");
  if (fs.existsSync(rootIndex)) return rootIndex;
  return path.resolve(process.cwd(), "index.html");
}

const HTML_PATH = resolveHtmlPath();

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
  const p = defaultPath;
  try {
    const dir = path.dirname(p);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
    return p;
  } catch {
    const fallbackDir = path.join(os.tmpdir(), "uploader_cache");
    if (!fs.existsSync(fallbackDir)) {
      fs.mkdirSync(fallbackDir, { recursive: true });
    }
    return path.join(fallbackDir, "cache.db");
  }
}

let _serverCacheDbInstance: Database | null = null;
let _cachedDbPath: string | null = null;

export function getCacheDb(): Database {
  const dbPath = getCacheDbPath();
  if (!_serverCacheDbInstance || _cachedDbPath !== dbPath) {
    _serverCacheDbInstance = new Database(dbPath);
    _cachedDbPath = dbPath;
    _serverCacheDbInstance.run("PRAGMA busy_timeout = 5000;");
    _serverCacheDbInstance.run(`
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
    _serverCacheDbInstance.run(
      "CREATE INDEX IF NOT EXISTS idx_file_hashes_hash ON file_hashes(hash);",
    );
    initHighlightsTable(_serverCacheDbInstance);
  }
  return _serverCacheDbInstance;
}

// Lazy singleton cacheDb proxy for backward-compatible call-sites
// SAFETY: Proxy delegates Database operations to dynamically initialized Database instance
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
    if (_serverCacheDbInstance) _serverCacheDbInstance.close();
  },
} as unknown as Database;

let _serverJobQueue: DurableJobQueue | null = null;
function registerJobHandlers(q: DurableJobQueue) {
  q.registerHandler(
    "metadata_enrich",
    async (payload: {
      bookId: number;
      title: string;
      author?: string;
      filename?: string;
      tags?: string[];
      isManga?: boolean;
    }) => {
      console.log(
        `[JobQueue:MetadataEnrich] Background enrichment for book ID ${payload.bookId} ("${payload.title}")...`,
      );
      const matches = await searchUniversalMetadata(payload.title, {
        isManga: payload.isManga,
        author: payload.author,
        filename: payload.filename,
        tags: payload.tags,
      });
      if (matches.length > 0) {
        const top = matches[0];
        console.log(
          `[JobQueue:MetadataEnrich] Top match: "${top.title}" by "${top.authors}" (Confidence: ${top.confidence}, Source: ${top.source})`,
        );
        if (top.confidence >= 0.85) {
          const applied = await applyMetadataToCalibre(payload.bookId, top);
          getCalibreBooks(true);
          // Check if comments is still empty; if so, auto-populate synopsis
          const fresh = getCalibreBooks(true).find((b: any) => b.id === payload.bookId);
          if (!fresh || isCommentsEmpty(fresh.comments)) {
            await autoEnrichBookSynopsis(payload.bookId, {
              title: payload.title,
              author: payload.author,
              filename: payload.filename,
              tags: payload.tags,
            });
            getCalibreBooks(true);
          }
          return {
            success: applied,
            topMatch: top.title,
            confidence: top.confidence,
            source: top.source,
          };
        } else {
          // If match confidence < 0.85, still auto-populate synopsis if comments is empty
          await autoEnrichBookSynopsis(payload.bookId, {
            title: payload.title,
            author: payload.author,
            filename: payload.filename,
            tags: payload.tags,
          });
          getCalibreBooks(true);
          return {
            success: true,
            message: `Match confidence ${top.confidence} < 0.85. Preserved original title.`,
            topMatch: top.title,
            source: top.source,
          };
        }
      }

      // If no matches found, attempt synopsis auto-enrichment before Burmese check
      await autoEnrichBookSynopsis(payload.bookId, {
        title: payload.title,
        author: payload.author,
        filename: payload.filename,
        tags: payload.tags,
      });
      getCalibreBooks(true);

      // Check if this book is Burmese: if so, generate local typographic cover if missing
      const detCat = classifyBookSourceCategoryDeterministic(
        payload.title,
        payload.author || "",
        payload.filename || "",
        payload.tags || [],
      );
      if (detCat === "burmese" || containsBurmese(payload.title)) {
        const freshBooks = getCalibreBooks(true);
        const book = freshBooks.find((b: any) => b.id === payload.bookId);
        const hasExistingCover = book && book.cover && book.cover !== 0 && book.cover !== false;

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
                getCalibreBooks(true);
                return {
                  success: true,
                  message: "Generated local typographic cover for Burmese literature.",
                  source: "Local Typography",
                };
              }
            }
          } catch (coverErr: any) {
            console.error(`Failed to generate Burmese typographic cover:`, coverErr);
          }
        }
      }

      return { success: true, message: "No external metadata matches found." };
    },
  );

  q.registerHandler(
    "file_ingest",
    async (payload: {
      filePath: string;
      originalFileName: string;
      deleteAfterIngest?: boolean;
    }) => {
      const result = await ingestBookFile(payload.filePath, payload.originalFileName);
      if (payload.deleteAfterIngest && fs.existsSync(payload.filePath)) {
        try {
          fs.unlinkSync(payload.filePath);
        } catch {}
      }
      if (!result.success) {
        throw new Error(result.error || "File ingestion failed");
      }
      return result;
    },
  );

  q.registerHandler(
    "archive_extract",
    async (payload: {
      archivePath: string;
      archiveName: string;
      deleteAfterExtract?: boolean;
    }) => {
      const unp = unpackArchive(payload.archivePath);
      if (payload.deleteAfterExtract && fs.existsSync(payload.archivePath)) {
        try {
          fs.unlinkSync(payload.archivePath);
        } catch {}
      }
      if (!unp.success) {
        throw new Error(unp.error || "Archive extraction failed");
      }

      const results: any[] = [];
      try {
        for (const book of unp.books) {
          const r = await ingestBookFile(book.tempPath, book.originalName);
          results.push({ name: book.originalName, ...r });
        }
      } finally {
        unp.cleanup();
      }

      const importedCount = results.filter(
        (r: any) => r.success && !r.duplicate,
      ).length;
      return {
        total: unp.books.length,
        imported: importedCount,
        quarantined: unp.quarantined || [],
        results,
      };
    },
  );

  q.registerHandler("url_article_ingest", async (payload: { url: string }) => {
    const result = await ingestArticleFromUrl(payload.url);
    if (!result.success) {
      throw new Error(result.error || "Article ingestion failed");
    }
    getCalibreBooks(true);
    return result;
  });

  q.registerHandler(
    "cover_backfill",
    async (payload: { candidateBookIds?: number[] }) => {
      const books = getCalibreBooks(true);
      const candidates = books.filter((b: any) => {
        if (
          payload.candidateBookIds &&
          !payload.candidateBookIds.includes(b.id)
        )
          return false;
        const tags = Array.isArray(b.tags) ? b.tags : b.tags ? [b.tags] : [];
        const isWeb = tags.some(
          (t: string) => t === "Web Article" || t === "Read Later",
        );
        const hasCover = b.cover && b.cover !== 0 && b.cover !== false;
        return isWeb && !hasCover;
      });

      const updated: Array<{ id: number; title: string }> = [];
      for (const book of candidates) {
        try {
          const tags: string[] = Array.isArray(book.tags)
            ? book.tags
            : book.tags
              ? [book.tags]
              : [];
          const siteTag = tags.find(
            (t: string) => t !== "Web Article" && t !== "Read Later",
          );
          const siteName = siteTag || book.publisher || "Web Article";
          const coverPath = generateTypographicCover(
            book.title,
            book.authors || "Unknown",
            siteName,
          );

          const setRes = runCalibredb([
            "set_metadata",
            String(book.id),
            "--with-library",
            SERVER_URL,
            "--field",
            `cover:${coverPath}`,
          ]);

          if (fs.existsSync(coverPath)) {
            try {
              fs.unlinkSync(coverPath);
            } catch (_unlinkErr) {
              void _unlinkErr;
            }
          }

          if (setRes.status === 0) {
            updated.push({ id: book.id, title: book.title });
            try {
              getCacheDb().run(
                "UPDATE file_hashes SET cover = 1 WHERE book_id = ?",
                [book.id],
              );
            } catch (_dbErr) {
              void _dbErr;
            }
          }
        } catch (itemErr) {
          console.error(`[CoverBackfill] Failed for book ${book.id}:`, itemErr);
        }
      }

      getCalibreBooks(true);
      return { updatedCount: updated.length, updated };
    },
  );
}

export function getJobQueueInstance(): DurableJobQueue {
  if (!_serverJobQueue) {
    _serverJobQueue = getJobQueue(getCacheDb());
    registerJobHandlers(_serverJobQueue);
  }
  return _serverJobQueue;
}

// Lazy singleton jobQueue proxy
// SAFETY: Proxy delegates JobQueue operations to dynamically initialized DurableJobQueue instance
export const jobQueue = {
  enqueue(...args: any[]) {
    return (getJobQueueInstance().enqueue as any)(...args);
  },
  getJob(...args: any[]) {
    return (getJobQueueInstance().getJob as any)(...args);
  },
  getRecentJobs(...args: any[]) {
    return (getJobQueueInstance().getRecentJobs as any)(...args);
  },
  retryJob(...args: any[]) {
    return (getJobQueueInstance().retryJob as any)(...args);
  },
  registerHandler(...args: any[]) {
    return (getJobQueueInstance().registerHandler as any)(...args);
  },
  startWorker(...args: any[]) {
    return (getJobQueueInstance().startWorker as any)(...args);
  },
  recoverInterruptedJobs(...args: any[]) {
    return (getJobQueueInstance().recoverInterruptedJobs as any)(...args);
  },
} as unknown as DurableJobQueue;

const KOREADER_HASH_ALGO = "md5";

function getKOReaderBinary256(filePath: string): string | null {
  try {
    const stats = fs.statSync(filePath);
    const fd = fs.openSync(filePath, "r");
    const md5 = crypto.createHash(KOREADER_HASH_ALGO);
    const size = 1024;
    for (let i = -1; i <= 10; i++) {
      const offset = i === -1 ? 256 : 1024 * 4 ** i;
      if (offset >= stats.size) break;
      const buf = Buffer.alloc(size);
      const bytesRead = fs.readSync(fd, buf, 0, size, offset);
      if (bytesRead > 0) md5.update(buf.subarray(0, bytesRead));
    }
    fs.closeSync(fd);
    return md5.digest("hex");
  } catch {
    return null;
  }
}

function getKOReaderPartial512(filePath: string): string | null {
  try {
    const stats = fs.statSync(filePath);
    const fd = fs.openSync(filePath, "r");
    const md5 = crypto.createHash(KOREADER_HASH_ALGO);
    let offset = 512;
    const buf = Buffer.alloc(1024);
    while (offset < stats.size) {
      const bytesRead = fs.readSync(fd, buf, 0, 1024, offset);
      if (bytesRead > 0) md5.update(buf.subarray(0, bytesRead));
      offset *= 4;
    }
    fs.closeSync(fd);
    return md5.digest("hex");
  } catch {
    return null;
  }
}

function getFilenameMD5(name: string): string {
  return crypto.createHash(KOREADER_HASH_ALGO).update(name).digest("hex");
}

function extractSeries(
  title: string,
  filename?: string,
): { series: string; volume: number } | null {
  return scraperExtractSeries(title, filename || "");
}

function sanitizeMetadata(
  rawTitle: string,
  rawAuthors: string,
  rawTags: string[],
  filename?: string,
) {
  let title = cleanString(rawTitle);
  let author = cleanString(rawAuthors);
  const tags = (rawTags || [])
    .map(cleanString)
    .filter(
      (t) =>
        t &&
        !/http|t\.me|channel|\.com|\.org|download|share|thebookr/i.test(t) &&
        t.length < 30,
    );

  const isAuthorJunk =
    !author ||
    /http|t\.me|channel|admin|unknown|\.com|\.org|thebookr/i.test(author);

  if ((!title || isAuthorJunk) && filename) {
    const base = path.basename(filename, path.extname(filename));
    const parts = base.split(/[-–—]/).map(cleanString).filter(Boolean);
    if (parts.length >= 2) {
      if (!title || title.length < 3) title = parts[1] || parts[0];
      if (isAuthorJunk) author = parts[0] || "Unknown";
    } else {
      if (!title || title.length < 3) title = base;
      if (isAuthorJunk) author = "Unknown";
    }
  }

  return { title: cleanString(title), author: cleanString(author), tags };
}

function safeParseJson(str: string): any {
  if (!str) return null;
  const trimmed = str.trim();
  const startBracket = trimmed.indexOf("[");
  const endBracket = trimmed.lastIndexOf("]");
  if (startBracket !== -1 && endBracket !== -1 && endBracket > startBracket) {
    try {
      return JSON.parse(trimmed.substring(startBracket, endBracket + 1));
    } catch (_err) {
      void _err;
    }
  }
  const startBrace = trimmed.indexOf("{");
  const endBrace = trimmed.lastIndexOf("}");
  if (startBrace !== -1 && endBrace !== -1 && endBrace > startBrace) {
    try {
      return JSON.parse(trimmed.substring(startBrace, endBrace + 1));
    } catch (_err) {
      void _err;
    }
  }
  try {
    return JSON.parse(trimmed);
  } catch (_err) {
    void _err;
    return null;
  }
}

export function getCalibredbPath(): string {
  if (process.env.CALIBREDB_PATH) return process.env.CALIBREDB_PATH;
  const probe = spawnSync("which", ["calibredb"], { encoding: "utf8" });
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

export function getSipsPath(): string {
  if (process.env.SIPS_PATH) return process.env.SIPS_PATH;
  const probe = spawnSync("which", ["sips"], { encoding: "utf8" });
  if (probe.status === 0 && probe.stdout?.trim()) return probe.stdout.trim();
  if (fs.existsSync("/usr/bin/sips")) return "/usr/bin/sips";
  return "sips";
}

let calibreBooksCache: { books: any[]; timestamp: number; etag?: string; dbPath?: string } = {
  books: [],
  timestamp: 0,
};

function runCalibredb(args: string[]) {
  const env = { ...process.env };
  delete env.HTTP_PROXY;
  delete env.http_proxy;
  delete env.HTTPS_PROXY;
  delete env.https_proxy;
  delete env.ALL_PROXY;
  delete env.all_proxy;
  env.PATH =
    "/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:" + (env.PATH || "");

  return spawnSync(getCalibredbPath(), args, {
    encoding: "utf8",
    env,
    timeout: 30000,
  });
}

export function getCalibreBooks(forceFresh = false) {
  const now = Date.now();
  const currentEtag = getCalibreDbETag();
  const dbPath = getCalibreDbPath();
  if (
    !forceFresh &&
    calibreBooksCache.books.length > 0 &&
    calibreBooksCache.etag === currentEtag &&
    calibreBooksCache.dbPath === dbPath &&
    now - calibreBooksCache.timestamp < 10000
  ) {
    return calibreBooksCache.books;
  }

  // 1. Direct in-process bun:sqlite query against Calibre metadata.db in read-only mode
  try {
    const dbPath = getCalibreDbPath();
    if (fs.existsSync(dbPath)) {
      const db = new Database(dbPath, { readonly: true });
      try {
        db.run("PRAGMA busy_timeout = 3000;");

        // Check whether optional tables exist in this database schema
        const hasLangTable = Boolean(
          db.query("SELECT 1 FROM sqlite_master WHERE type='table' AND name='books_languages_link' LIMIT 1").get()
        );
        const hasCommentsTable = Boolean(
          db.query("SELECT 1 FROM sqlite_master WHERE type='table' AND name='comments' LIMIT 1").get()
        );

        const commentsSelect = hasCommentsTable ? "c.text as comments" : "NULL as comments";
        const commentsJoin = hasCommentsTable ? "LEFT JOIN comments c ON b.id = c.book" : "";

        const sqlQuery = hasLangTable
          ? `
            SELECT b.id, b.title, b.path, b.has_cover as cover, b.pubdate,
                   GROUP_CONCAT(DISTINCT a.name) as authors,
                   s.name as series, b.series_index,
                   GROUP_CONCAT(DISTINCT t.name) as tags,
                   pub.name as publisher,
                   GROUP_CONCAT(DISTINCT l.lang_code) as languages,
                   ${commentsSelect}
            FROM books b
            JOIN data d ON b.id = d.book AND UPPER(d.format) = 'EPUB'
            LEFT JOIN books_authors_link bal ON b.id = bal.book
            LEFT JOIN authors a ON bal.author = a.id
            LEFT JOIN books_series_link bsl ON b.id = bsl.book
            LEFT JOIN series s ON bsl.series = s.id
            LEFT JOIN books_tags_link btl ON b.id = btl.book
            LEFT JOIN tags t ON btl.tag = t.id
            LEFT JOIN books_publishers_link bpl ON b.id = bpl.book
            LEFT JOIN publishers pub ON bpl.publisher = pub.id
            LEFT JOIN books_languages_link bll ON b.id = bll.book
            LEFT JOIN languages l ON bll.lang_code = l.id
            ${commentsJoin}
            GROUP BY b.id
            ORDER BY b.id DESC;
          `
          : `
            SELECT b.id, b.title, b.path, b.has_cover as cover, b.pubdate,
                   GROUP_CONCAT(DISTINCT a.name) as authors,
                   s.name as series, b.series_index,
                   GROUP_CONCAT(DISTINCT t.name) as tags,
                   pub.name as publisher,
                   NULL as languages,
                   ${commentsSelect}
            FROM books b
            JOIN data d ON b.id = d.book AND UPPER(d.format) = 'EPUB'
            LEFT JOIN books_authors_link bal ON b.id = bal.book
            LEFT JOIN authors a ON bal.author = a.id
            LEFT JOIN books_series_link bsl ON b.id = bsl.book
            LEFT JOIN series s ON bsl.series = s.id
            LEFT JOIN books_tags_link btl ON b.id = btl.book
            LEFT JOIN tags t ON btl.tag = t.id
            LEFT JOIN books_publishers_link bpl ON b.id = bpl.book
            LEFT JOIN publishers pub ON bpl.publisher = pub.id
            ${commentsJoin}
            GROUP BY b.id
            ORDER BY b.id DESC;
          `;

        const rows = db.query(sqlQuery).all() as any[];

        const epubBooks = rows.map((row) => ({
          id: row.id,
          title: row.title || "Untitled",
          path: row.path || "",
          cover: row.cover ? 1 : null,
          pubdate: row.pubdate || "",
          authors: row.authors || "Unknown",
          series: row.series || null,
          series_index: row.series_index ?? null,
          tags: row.tags
            ? row.tags
                .split(",")
                .map((t: string) => t.trim())
                .filter(Boolean)
            : [],
          publisher: row.publisher || null,
          comments: row.comments || null,
          languages: row.languages
            ? row.languages
                .split(",")
                .map((l: string) => l.trim().toLowerCase())
                .filter(Boolean)
            : [],
          formats: ["EPUB"],
        }));

        calibreBooksCache = {
          books: epubBooks,
          timestamp: now,
          etag: currentEtag,
          dbPath,
        };
        return epubBooks;
      } finally {
        db.close();
      }
    }
  } catch (sqliteErr) {
    console.warn(
      "Direct SQLite Calibre query failed, falling back to calibredb:",
      sqliteErr,
    );
  }

  // 2. Fallback to runCalibredb if direct database read encounters any error
  try {
    const res = runCalibredb([
      "list",
      "--with-library",
      SERVER_URL,
      "--search",
      "format:epub",
      "--fields",
      "id,title,authors,formats,cover,tags,series,series_index,publisher,pubdate,comments,rating,languages",
      "--for-machine",
    ]);
    if (res.status === 0 && res.stdout) {
      const parsed = safeParseJson(res.stdout);
      // Clean EPUB-only collection enforcement
      const epubBooks = (Array.isArray(parsed) ? parsed : [])
        .filter((b: any) => {
          const fmts = (b.formats || []).map((f: string) =>
            String(f).toUpperCase(),
          );
          return fmts.includes("EPUB");
        })
        .map((b: any) => ({
          ...b,
          languages: Array.isArray(b.languages)
            ? b.languages.map((l: string) => String(l).trim().toLowerCase()).filter(Boolean)
            : typeof b.languages === "string" && b.languages
              ? b.languages.split(",").map((l: string) => l.trim().toLowerCase()).filter(Boolean)
              : [],
          formats: ["EPUB"],
        }));
      calibreBooksCache = {
        books: epubBooks,
        timestamp: now,
        etag: currentEtag,
        dbPath,
      };
      return epubBooks;
    }
  } catch (e) {
    console.error("Error listing calibre books via fallback:", e);
  }
  return calibreBooksCache.books || [];
}

export function getBookPath(bookId: number): string | null {
  const books = getCalibreBooks();
  const book = books.find((b: any) => b.id === bookId);
  if (book?.path) return book.path;

  try {
    const dbPath = getCalibreDbPath();
    if (fs.existsSync(dbPath)) {
      const db = new Database(dbPath, { readonly: true });
      try {
        const row = db.query("SELECT path FROM books WHERE id = ?").get(bookId) as any;
        if (row?.path) return row.path;
      } finally {
        db.close();
      }
    }
  } catch (_err) {
    void _err;
  }
  return null;
}

export function getMasterCoverPath(bookId: number): string | null {
  const relPath = getBookPath(bookId);
  if (relPath) {
    const libDir = getCalibreLibraryDir();
    const coverPath = path.join(libDir, relPath, "cover.jpg");
    if (fs.existsSync(coverPath)) {
      return coverPath;
    }
  }
  return null;
}

export class SipsConcurrencyLimiter {
  private active = 0;
  private queue: (() => void)[] = [];
  constructor(public readonly maxConcurrent = 4) {}

  async run<T>(task: () => Promise<T>): Promise<T> {
    if (this.active >= this.maxConcurrent) {
      await new Promise<void>((resolve) => this.queue.push(resolve));
    }
    this.active++;
    try {
      return await task();
    } finally {
      this.active--;
      if (this.queue.length > 0) {
        const next = this.queue.shift();
        if (next) next();
      }
    }
  }

  getActiveCount(): number {
    return this.active;
  }

  getQueueLength(): number {
    return this.queue.length;
  }
}

export const sipsLimiter = new SipsConcurrencyLimiter(4);

export async function downscaleImageAsync(
  inputPath: string,
  outputPath: string,
  targetWidth: number,
): Promise<boolean> {
  const sipsBin = getSipsPath();
  if (!fs.existsSync(sipsBin) && sipsBin !== "sips") {
    return false;
  }

  return sipsLimiter.run(async () => {
    try {
      const proc = Bun.spawn(
        [sipsBin, "-Z", String(targetWidth), inputPath, "--out", outputPath],
        { stdout: "ignore", stderr: "pipe" },
      );
      const timeout = new Promise<number>((_, reject) =>
        setTimeout(() => {
          try {
            proc.kill();
          } catch (_killErr) {
            void _killErr;
          }
          reject(new Error("sips timeout"));
        }, 15000),
      );
      const exitCode = await Promise.race([proc.exited, timeout]);
      return exitCode === 0 && fs.existsSync(outputPath);
    } catch (err) {
      console.warn("Async sips downscaling failed:", err);
      return false;
    }
  });
}

function getCalibreHashMap() {
  const map: Record<
    string,
    { id: number; title: string; authors: string; cover: boolean }
  > = {};
  const books = getCalibreBooks();

  try {
    const allCached = cacheDb
      .query("SELECT hash, book_id, title, authors, cover FROM file_hashes")
      .all() as any[];
    for (const row of allCached) {
      if (row.hash) {
        map[row.hash] = {
          id: row.book_id,
          title: row.title,
          authors: row.authors || "Unknown",
          cover: !!row.cover,
        };
      }
    }
  } catch (_e) {
    void _e;
  }

  const selectStmt = cacheDb.prepare(
    "SELECT hash FROM file_hashes WHERE filepath = ? AND mtime = ?",
  );
  const insertStmt = cacheDb.prepare(
    "INSERT OR REPLACE INTO file_hashes (filepath, mtime, hash, book_id, title, authors, cover) VALUES (?, ?, ?, ?, ?, ?, ?)",
  );

  function scanDir(dir: string) {
    try {
      const entries = fs.readdirSync(dir, { withFileTypes: true });
      for (const e of entries) {
        const full = path.join(dir, e.name);
        if (e.isDirectory()) {
          scanDir(full);
        } else if (e.name.endsWith(".epub")) {
          const stat = fs.statSync(full);
          const mtime = Math.floor(stat.mtimeMs);

          const cached = selectStmt.get(full + "#bin256", mtime) as any;
          if (!cached) {
            const parentDir = path.basename(path.dirname(full));
            const bookMatch = books.find(
              (b: any) =>
                parentDir.includes(`(${b.id})`) ||
                b.title
                  .toLowerCase()
                  .includes(
                    path.basename(e.name, path.extname(e.name)).toLowerCase(),
                  ) ||
                e.name.toLowerCase().includes(b.title.toLowerCase()),
            );
            const bId = bookMatch ? bookMatch.id : null;
            const bTitle = bookMatch
              ? bookMatch.title
              : path.basename(e.name, path.extname(e.name));
            const bAuthors = bookMatch
              ? bookMatch.authors || "Unknown"
              : "Unknown";
            const bCover = bookMatch ? (bookMatch.cover ? 1 : 0) : 0;

            const h1 = getKOReaderBinary256(full);
            const h2 = getKOReaderPartial512(full);
            const h3 = getFilenameMD5(e.name);
            const h4 = getFilenameMD5(bTitle + ".epub");

            const hashSet = new Set(
              [h1, h2, h3, h4].filter(Boolean) as string[],
            );
            for (const h of hashSet) {
              insertStmt.run(
                full + "#" + h,
                mtime,
                h,
                bId,
                bTitle,
                bAuthors,
                bCover,
              );
              map[h] = {
                id: bId,
                title: bTitle,
                authors: bAuthors,
                cover: !!bCover,
              };
            }
          }
        }
      }
    } catch (_e) {
      void _e;
    }
  }

  scanDir(getCalibreLibraryDir());
  return { map, books };
}

/**
 * Ingests a single book file into Calibre.
 * Strictly enforces canonical EPUB-only format policy.
 */
export async function ingestBookFile(filePath: string, originalFileName: string) {
  const ext = path.extname(originalFileName).toLowerCase();
  const format = ext.replace(/^\./, "").toUpperCase();

  // Enforce EPUB-only canonical format
  if (format !== "EPUB" || !isCanonicalEpub(originalFileName)) {
    return {
      success: false,
      rejected: true,
      format,
      error: `Rejected non-canonical format "${ext}". Only EPUB format is accepted for the canonical collection.`,
    };
  }

  // Enforce physical EPUB container validation before reaching calibredb
  const contentValidation = validateEpubContent(filePath);
  if (!contentValidation.valid) {
    return {
      success: false,
      rejected: true,
      format,
      error: `Invalid EPUB container "${originalFileName}": ${contentValidation.error}`,
    };
  }

  const sanitized = sanitizeMetadata("", "", [], originalFileName);
  const epubMeta = extractEpubMetadata(filePath);
  const candidateTitle = epubMeta.title || sanitized.title;
  const candidateAuthor =
    epubMeta.author && epubMeta.author !== "Unknown"
      ? epubMeta.author
      : sanitized.author;
  const candidateComments = epubMeta.description || "";

  // Junk Ingest Gate: check before calibredb add using candidate metadata
  const junkCheck = await evaluateJunkGate(
    candidateTitle,
    originalFileName,
    candidateAuthor,
  );
  if (junkCheck.quarantined) {
    moveToQuarantine(filePath, path.basename(originalFileName));
    return {
      success: false,
      rejected: true,
      format,
      error: `Quarantined by junk ingest gate: ${junkCheck.reason || "Invalid artifact"}`,
    };
  }

  const books = getCalibreBooks(true);
  const fileHash = getKOReaderBinary256(filePath);

  // 1. Check if exact hash exists in Calibre Library
  const { map } = getCalibreHashMap();
  if (fileHash && map[fileHash]) {
    const existing = map[fileHash];
    return {
      success: true,
      duplicate: true,
      bookId: existing.id,
      message: `Book "${existing.title}" is already in your library.`,
    };
  }

  // 2. Check if normalized title already exists
  const incomingSeries = await extractSeriesWithJev(candidateTitle, originalFileName, extractSeries);

  const existingBook = books.find((b: any) => {
    const bTitle = cleanString(b.title).toLowerCase();
    const sTitle = candidateTitle.toLowerCase();

    const bSeries = extractSeries(b.title, "");
    const bActualSeries = b.series
      ? { series: cleanString(b.series), volume: b.series_index || 1 }
      : bSeries;

    if (incomingSeries && bActualSeries) {
      if (
        cleanString(incomingSeries.series).toLowerCase() ===
        cleanString(bActualSeries.series).toLowerCase()
      ) {
        return incomingSeries.volume === bActualSeries.volume;
      }
    } else if (incomingSeries || bActualSeries) {
      return false;
    }

    return (
      bTitle === sTitle ||
      (sTitle.length > 5 &&
        (bTitle === sTitle ||
          bTitle.startsWith(sTitle) ||
          sTitle.startsWith(bTitle)))
    );
  });

  if (existingBook) {
    return {
      success: true,
      duplicate: true,
      bookId: existingBook.id,
      message: `Book "${existingBook.title}" already exists in your library.`,
    };
  }

  // 3. Brand new book: Categorize & detect language before adding to Calibre
  const preClassification = await resolveBookLanguageAndTags({
    title: candidateTitle,
    author: candidateAuthor,
    comments: candidateComments,
    filename: originalFileName,
    tags: sanitized.tags || [],
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
  if (preClassification.tags.length > 0)
    addArgs.push("--tags", preClassification.tags.join(","));
  if (epubMeta.title) addArgs.push("--title", epubMeta.title);
  if (epubMeta.author && epubMeta.author !== "Unknown")
    addArgs.push("--authors", epubMeta.author);

  const addRes = runCalibredb(addArgs);

  if (addRes.status === 0) {
    const match = addRes.stdout?.match(/Added book ids?:?\s*([0-9]+)/i);
    const newId = match ? parseInt(match[1], 10) : null;

    if (newId) {
      const freshBooks = getCalibreBooks(true);
      const newBook = freshBooks.find((b: any) => b.id === newId);
      if (newBook) {
        const clean = sanitizeMetadata(
          newBook.title,
          newBook.authors,
          newBook.tags,
          originalFileName,
        );
        const finalAuthor = await cleanAuthorWithJev(clean.author || newBook.authors, clean.title || newBook.title);
        const finalClassification = await resolveBookLanguageAndTags({
          title: clean.title || newBook.title || candidateTitle,
          author: finalAuthor || candidateAuthor,
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
        if (clean.title && clean.title !== newBook.title)
          setArgs.push("--field", `title:${clean.title}`);
        if (finalAuthor && finalAuthor !== newBook.authors)
          setArgs.push("--field", `authors:${finalAuthor}`);
        if (finalClassification.tags.length)
          setArgs.push("--field", `tags:${finalClassification.tags.join(",")}`);
        if (finalClassification.language !== "other") {
          setArgs.push("--field", `languages:${finalClassification.language}`);
        }
        if (!newBook.series && incomingSeries) {
          setArgs.push("--field", `series:${incomingSeries.series}`);
          setArgs.push("--field", `series_index:${incomingSeries.volume}`);
        }

        // Check if comments metadata is empty or placeholder and auto-populate
        let synopsis: string | null = null;
        if (isCommentsEmpty(newBook.comments)) {
          synopsis = extractEpubDescription(filePath);
          if (!synopsis && candidateComments && !isCommentsEmpty(candidateComments)) {
            synopsis = sanitizeSynopsis(candidateComments);
          }
          if (synopsis && !isCommentsEmpty(synopsis)) {
            setArgs.push("--field", `comments:${synopsis}`);
          }
        }

        if (setArgs.length > 4) {
          runCalibredb(setArgs);
        }

        // If comments was empty and EPUB had no synopsis, attempt online auto-enrichment in background
        if (isCommentsEmpty(newBook.comments) && !synopsis) {
          autoEnrichBookSynopsis(newId, {
            filePath,
            title: clean.title || newBook.title || candidateTitle,
            author: finalAuthor || candidateAuthor,
            series: incomingSeries?.series || newBook.series,
            series_index: incomingSeries?.volume || newBook.series_index,
            tags: finalClassification.tags || [],
            filename: originalFileName,
          })
            .then((res) => {
              if (res.enriched) getCalibreBooks(true);
            })
            .catch(() => {});
        }

        // Durable Metadata Enrichment via Job Queue (survives restarts, auto-retries)
        const isManga =
          format === "CBZ" ||
          format === "CBR" ||
          (finalClassification.tags || []).some((t) => /manga|comic/i.test(t));
        jobQueue.enqueue("metadata_enrich", {
          bookId: newId,
          title: clean.title,
          author: finalAuthor,
          filename: originalFileName,
          tags: finalClassification.tags || [],
          isManga,
        });
      }
    }

    return {
      success: true,
      duplicate: false,
      bookId: newId,
      message: `Added "${sanitized.title}" to library`,
    };
  } else {
    return {
      success: false,
      error: addRes.stderr || "Failed to add book",
    };
  }
}

function getKosyncProgress() {
  try {
    if (fs.existsSync(KOSYNC_DB_PATH)) {
      const db = new Database(KOSYNC_DB_PATH);
      const rows = db
        .query(
          "SELECT id, document, progress, percentage, device, device_id, filename, title, authors, timestamp FROM progress ORDER BY timestamp DESC LIMIT 50;",
        )
        .all() as any[];

      const { map, books } = getCalibreHashMap();

      const norm = (s: string) =>
        (s || "").toLowerCase().replace(/[\p{P}\p{S}\s]+/gu, "");

      return rows.map((r) => {
        let displayTitle = r.title || r.filename;
        let displayAuthors = r.authors;
        let bookId: number | null = null;
        let cover: boolean = false;

        if (map[r.document]) {
          displayTitle = map[r.document].title;
          displayAuthors = map[r.document].authors;
          bookId = map[r.document].id;
          cover = map[r.document].cover;
        }

        if (!bookId && (r.title || r.filename)) {
          const searchNorm = norm(r.title || r.filename);
          const bookMatch = books.find((b: any) => {
            const bNorm = norm(b.title);
            return (
              bNorm === searchNorm ||
              (searchNorm.length > 5 &&
                (bNorm.includes(searchNorm) || searchNorm.includes(bNorm)))
            );
          });
          if (bookMatch) {
            bookId = bookMatch.id;
            cover = !!bookMatch.cover;
            displayTitle = bookMatch.title;
            displayAuthors = bookMatch.authors || displayAuthors;
          }
        }

        if (!bookId) {
          try {
            const alias = db
              .query(
                "SELECT canonical_id, normalized_title, normalized_authors FROM document_aliases WHERE document_hash = ?",
              )
              .get(r.document) as any;

            if (alias) {
              const aliasNorm = norm(alias.normalized_title);
              const bookMatch = books.find(
                (b: any) => norm(b.title) === aliasNorm,
              );
              if (bookMatch) {
                bookId = bookMatch.id;
                cover = !!bookMatch.cover;
                displayTitle = bookMatch.title;
                displayAuthors = bookMatch.authors || displayAuthors;
              } else {
                displayTitle = alias.normalized_title;
                displayAuthors = alias.normalized_authors || "Unknown Author";
              }
            }
          } catch (_e) {
            void _e;
          }
        }

        if (!displayTitle) {
          const match = books.find(
            (b: any) =>
              cleanString(b.title).toLowerCase() ===
              cleanString(r.filename || "").toLowerCase(),
          );
          if (match) {
            displayTitle = match.title;
            displayAuthors = match.authors;
            bookId = match.id;
            cover = !!match.cover;
          } else {
            displayTitle = "Active Reading Session";
            displayAuthors = "KOReader Document";
          }
        }

        if (displayTitle) {
          displayTitle = cleanString(displayTitle);
          if (displayTitle.endsWith(".epub")) {
            displayTitle = displayTitle.replace(/\.epub$/i, "");
          }
        }

        return {
          ...r,
          displayTitle,
          displayAuthors: cleanString(displayAuthors) || "Unknown Author",
          bookId,
          cover,
        };
      });
    }
  } catch (e) {
    console.error("Error reading kosync db:", e);
  }
  return [];
}

function extractHighlightsFromSdr(
  bookId: number,
): Array<{ text: string; notes: string; datetime: string; page?: number; chapter?: string }> {
  const highlights: Array<{
    text: string;
    notes: string;
    datetime: string;
    page?: number;
    chapter?: string;
  }> = [];
  try {
    const books = getCalibreBooks();
    const book = books.find((b: any) => b.id === bookId);
    if (!book) return highlights;

    const parseLuaFile = (filePath: string) => {
      try {
        const luaContent = fs.readFileSync(filePath, "utf8");
        const parsed = extractHighlightsFromLua(luaContent);
        for (const h of parsed.highlights) {
          let pageNum: number | undefined;
          if (typeof h.page === "number") {
            pageNum = h.page;
          } else if (h.page) {
            const n = parseInt(String(h.page), 10);
            if (!Number.isNaN(n)) pageNum = n;
          }
          highlights.push({
            text: h.text,
            notes: h.notes || "",
            datetime: h.datetime || new Date().toISOString(),
            page: pageNum,
            chapter: h.chapter,
          });
        }
      } catch (_parseErr) {
        void _parseErr;
      }
    };

    // 1. Direct targeted check in book directory
    if (book.path) {
      const bookFolder = path.join(getCalibreLibraryDir(), book.path);
      if (fs.existsSync(bookFolder)) {
        const entries = fs.readdirSync(bookFolder, { withFileTypes: true });
        for (const e of entries) {
          if (e.isDirectory() && e.name.endsWith(".sdr")) {
            const sdrDir = path.join(bookFolder, e.name);
            const sdrFiles = fs.readdirSync(sdrDir);
            for (const f of sdrFiles) {
              if (f.endsWith(".lua")) {
                parseLuaFile(path.join(sdrDir, f));
              }
            }
          }
        }
      }
    }

    if (highlights.length > 0) {
      return highlights;
    }
  } catch (e) {
    console.error("Error extracting SDR highlights:", e);
  }
  return highlights;
}

export async function searchAllBookSources(query: string) {
  const results: any[] = [];
  const cleanQ = cleanString(query);

  // 1. Google Books
  try {
    const gRes = await safeFetchWithSsrf(
      `https://www.googleapis.com/books/v1/volumes?q=${encodeURIComponent(cleanQ)}&maxResults=5`,
    );
    if (gRes.ok) {
      const data = (await gRes.json()) as any;
      if (data.items) {
        for (const item of data.items) {
          const info = item.volumeInfo || {};
          let cover =
            info.imageLinks?.extraLarge ||
            info.imageLinks?.large ||
            info.imageLinks?.medium ||
            info.imageLinks?.thumbnail ||
            "";
          if (cover)
            cover = cover
              .replace("http://", "https://")
              .replace("&edge=curl", "");

          results.push({
            title: cleanString(info.title || ""),
            authors: (info.authors || []).map(cleanString).join(", "),
            publisher: cleanString(info.publisher || ""),
            publishedDate: info.publishedDate || "",
            description: info.description || "",
            coverUrl: cover,
            tags: (info.categories || []).map(cleanString).filter(Boolean),
            pageCount: info.pageCount || null,
            source: "Google Books",
          });
        }
      }
    }
  } catch (_e) {
    void _e;
  }

  // 2. OpenLibrary
  try {
    const olRes = await safeFetchWithSsrf(
      `https://openlibrary.org/search.json?q=${encodeURIComponent(cleanQ)}&limit=5`,
    );
    if (olRes.ok) {
      const data = (await olRes.json()) as any;
      if (data.docs) {
        for (const doc of data.docs) {
          const coverId = doc.cover_i;
          results.push({
            title: cleanString(doc.title || ""),
            authors: (doc.author_name || []).map(cleanString).join(", "),
            publisher: cleanString((doc.publisher || [])[0] || ""),
            publishedDate: doc.first_publish_year
              ? String(doc.first_publish_year)
              : "",
            description: Array.isArray(doc.first_sentence)
              ? doc.first_sentence[0]
              : doc.first_sentence || "",
            coverUrl: coverId
              ? `https://covers.openlibrary.org/b/id/${coverId}-L.jpg`
              : "",
            tags: (doc.subject ? doc.subject.slice(0, 4) : [])
              .map(cleanString)
              .filter(Boolean),
            pageCount: doc.number_of_pages_median || null,
            source: "OpenLibrary",
          });
        }
      }
    }
  } catch (_e) {
    void _e;
  }

  return results;
}

function jsonResponse(data: any, status = 200, origin?: string) {
  const headers: Record<string, string> = {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store, no-cache, must-revalidate, proxy-revalidate",
    Pragma: "no-cache",
    Expires: "0",
    "X-Content-Type-Options": "nosniff",
  };

  if (origin && isAllowedOrigin(origin)) {
    headers["Access-Control-Allow-Origin"] = origin;
    headers["Access-Control-Allow-Credentials"] = "true";
    headers["Vary"] = "Origin";
  }

  return new Response(JSON.stringify(data), { status, headers });
}

export interface ProxyPathValidationResult {
  valid: boolean;
  error?: string;
  canonicalPath?: string;
}

/**
 * Strictly validates and canonicalizes proxy paths and query strings before forwarding.
 * Rejects path traversal, %2e%2e, backslashes, null bytes, duplicate slashes, and control characters.
 */
export function validateAndCanonicalizeProxyPath(
  rawPath: string,
  rawSearch: string = "",
): ProxyPathValidationResult {
  if (!rawPath || !rawPath.startsWith("/")) {
    return { valid: false, error: "Path must start with /" };
  }

  // 1. Reject raw null bytes, backslashes, control characters, and duplicate slashes
  if (
    /[\0\r\n\t\x00-\x1f\x7f\\]/.test(rawPath) ||
    /%00/i.test(rawPath) ||
    /%5c/i.test(rawPath) ||
    /%0[0-9a-f]|%1[0-9a-f]|%7f/i.test(rawPath) ||
    rawPath.includes("//")
  ) {
    return {
      valid: false,
      error: "Path contains disallowed characters or duplicate slashes",
    };
  }

  // Check query string for null bytes or control characters as well
  if (
    rawSearch &&
    (/[\0\r\n\t\x00-\x1f\x7f\\]/.test(rawSearch) ||
      /%00/i.test(rawSearch) ||
      /%5c/i.test(rawSearch) ||
      /%0[0-9a-f]|%1[0-9a-f]|%7f/i.test(rawSearch))
  ) {
    return {
      valid: false,
      error: "Query string contains disallowed characters",
    };
  }

  // 2. Reject encoded path traversal tokens before decoding
  if (
    /%2e%2e/i.test(rawPath) ||
    /%2e\./i.test(rawPath) ||
    /\.%2e/i.test(rawPath) ||
    /%2f/i.test(rawPath) ||
    /%252e/i.test(rawPath) ||
    /%252f/i.test(rawPath)
  ) {
    return { valid: false, error: "Encoded path traversal sequence detected" };
  }

  // 3. Decode URI components safely
  let decoded: string;
  try {
    decoded = decodeURI(rawPath);
  } catch {
    return { valid: false, error: "Malformed URI encoding in path" };
  }

  // 4. Verify decoded path doesn't contain backslashes, nulls, control characters, or unrolled traversal
  if (
    /[\0\r\n\t\x00-\x1f\x7f\\]/.test(decoded) ||
    /%2e%2e/i.test(decoded) ||
    /%2f/i.test(decoded)
  ) {
    return {
      valid: false,
      error: "Decoded path contains control characters, backslashes, or nested traversal",
    };
  }

  // 5. Check path segments for traversal or empty segments
  const segments = decoded.split("/");
  for (let i = 1; i < segments.length; i++) {
    const seg = segments[i];
    if (seg === "" && i < segments.length - 1) {
      return { valid: false, error: "Duplicate slashes in path" };
    }
    if (seg === "." || seg === "..") {
      return { valid: false, error: "Path traversal detected" };
    }
  }

  // 6. Strict pattern matching
  // Route A: /favicon.png
  if (rawPath === "/favicon.png") {
    return { valid: true, canonicalPath: "/favicon.png" };
  }

  // Route B: /opds or /opds/...
  if (rawPath === "/opds" || rawPath.startsWith("/opds/")) {
    for (let i = 2; i < segments.length; i++) {
      const seg = segments[i];
      if (!seg && i === segments.length - 1) continue;
      if (!/^[a-zA-Z0-9_\-\.~%!$&'()*+,;=:@]+$/.test(seg)) {
        return {
          valid: false,
          error: "Disallowed characters in OPDS path segment",
        };
      }
    }
    return { valid: true, canonicalPath: rawPath };
  }

  // Route C: /get/<format>/<id>/<library>
  if (rawPath.startsWith("/get/")) {
    if (segments.length !== 5) {
      return {
        valid: false,
        error:
          "Calibre get URL must follow /get/<format>/<id>/<library> structure",
      };
    }
    const [, , format, idStr, library] = segments;
    if (!/^[a-zA-Z0-9_-]+$/.test(format)) {
      return { valid: false, error: "Invalid format in get URL" };
    }
    if (!/^[1-9][0-9]*$/.test(idStr)) {
      return { valid: false, error: "Invalid numeric ID in get URL" };
    }
    if (!/^[a-zA-Z0-9_\-\.~%]+$/.test(library)) {
      return { valid: false, error: "Invalid library name in get URL" };
    }
    return { valid: true, canonicalPath: rawPath };
  }

  return { valid: false, error: "Not an OPDS or Calibre asset route" };
}

/**
 * Primary HTTP Request Handler with Hardened WAN Security, CORS, CSRF,
 * and Durable Job Queue Lifecycle.
 */
export async function handleRequest(
  req: Request,
  server?: any,
): Promise<Response> {
  const origin = req.headers.get("origin") || "";
  const originAllowed = isAllowedOrigin(origin);
  const corsOrigin = originAllowed ? origin : undefined;

  // Handle CORS OPTIONS preflight
  if (req.method === "OPTIONS") {
    const preflightHeaders: Record<string, string> = {
      "Access-Control-Allow-Methods": "GET, POST, PUT, DELETE, OPTIONS",
      "Access-Control-Allow-Headers":
        "Content-Type, Authorization, X-API-Key, X-Telegram-Init-Data, X-Requested-With",
      "X-Content-Type-Options": "nosniff",
    };
    if (originAllowed) {
      preflightHeaders["Access-Control-Allow-Origin"] = origin;
      preflightHeaders["Access-Control-Allow-Credentials"] = "true";
      preflightHeaders["Vary"] = "Origin";
    }
    return new Response(null, { headers: preflightHeaders });
  }

  let url: URL;
  try {
    url = new URL(req.url);
  } catch (_err) {
    void _err;
    return new Response("Bad Request", { status: 400 });
  }

  // Static Brand Assets (LightHouse Logo, Vector Mark & Touch Icons)
  if (url.pathname.startsWith("/assets/")) {
    if (req.method !== "GET" && req.method !== "HEAD") {
      return new Response("Method Not Allowed", {
        status: 405,
        headers: {
          Allow: "GET, HEAD",
          "X-Content-Type-Options": "nosniff",
        },
      });
    }

    const filename = path.basename(url.pathname);
    const allowedAssets: Record<string, string> = {
      "logo.svg": "image/svg+xml",
      "mark.svg": "image/svg+xml",
      "logo.png": "image/png",
      "apple-touch-icon.png": "image/png",
    };

    const mime = allowedAssets[filename];
    if (!mime || filename !== url.pathname.slice("/assets/".length)) {
      return new Response("Not Found", {
        status: 404,
        headers: {
          "Content-Type": "text/plain; charset=utf-8",
          "X-Content-Type-Options": "nosniff",
        },
      });
    }

    const candidatePaths = [
      path.resolve((import.meta as any).dir, "assets", filename),
      path.resolve(LIGHTHOUSE_ROOT, "assets", filename),
      path.resolve(LIGHTHOUSE_ROOT, "uploader", "assets", filename),
    ];
    const assetPath = candidatePaths.find((p) => fs.existsSync(p));

    if (!assetPath) {
      return new Response("Not Found", {
        status: 404,
        headers: {
          "Content-Type": "text/plain; charset=utf-8",
          "X-Content-Type-Options": "nosniff",
        },
      });
    }

    const headers = {
      "Content-Type": mime,
      "Cache-Control": "public, max-age=86400",
      "X-Content-Type-Options": "nosniff",
      "Content-Security-Policy": "default-src 'none'",
    } as Record<string, string>;

    if (corsOrigin && isAllowedOrigin(corsOrigin)) {
      headers["Access-Control-Allow-Origin"] = corsOrigin;
      headers["Vary"] = "Origin";
    }

    if (req.method === "HEAD") {
      return new Response(null, { headers });
    }
    return new Response(fs.readFileSync(assetPath), { headers });
  }

  // Calibre OPDS Server & Download Reverse Proxy (WAN & LAN)
  // Proxies /opds, /opds/*, /get/*, and /favicon.png to Calibre server (SERVER_URL)
  const isOpdsProxyRoute =
    url.pathname === "/opds" ||
    url.pathname.startsWith("/opds/") ||
    url.pathname.startsWith("/get/") ||
    url.pathname === "/favicon.png";

  if (isOpdsProxyRoute) {
    // 1. Path validation & canonicalization
    const pathCheck = validateAndCanonicalizeProxyPath(
      url.pathname,
      url.search,
    );
    if (!pathCheck.valid) {
      return new Response(`Bad Request: ${pathCheck.error || "Invalid path"}`, {
        status: 400,
        headers: {
          "Content-Type": "text/plain; charset=utf-8",
          "X-Content-Type-Options": "nosniff",
        },
      });
    }

    // 2. Restrict proxy to GET and HEAD methods
    if (req.method !== "GET" && req.method !== "HEAD") {
      const notAllowedHeaders: Record<string, string> = {
        Allow: "GET, HEAD",
        "X-Content-Type-Options": "nosniff",
      };
      if (corsOrigin) {
        notAllowedHeaders["Access-Control-Allow-Origin"] = corsOrigin;
        notAllowedHeaders["Access-Control-Allow-Credentials"] = "true";
        notAllowedHeaders["Vary"] = "Origin";
      }
      return new Response("Method Not Allowed", {
        status: 405,
        headers: notAllowedHeaders,
      });
    }

    const serverBase = (process.env.CALIBRE_SERVER_URL || SERVER_URL).replace(
      /\/+$/,
      "",
    );
    const targetUrl = `${serverBase}${pathCheck.canonicalPath}${url.search}`;

    // 3. Header Forwarding Allowlist:
    // Allow only: 'range', 'if-none-match', 'if-modified-since', 'accept', 'accept-encoding', 'user-agent'.
    // Discard client 'cookie', 'authorization', 'forwarded', 'x-forwarded-*'.
    const ALLOWED_FORWARD_HEADERS = new Set([
      "range",
      "if-none-match",
      "if-modified-since",
      "accept",
      "accept-encoding",
      "user-agent",
    ]);

    const forwardedHeaders = new Headers();
    for (const [key, value] of req.headers.entries()) {
      const lower = key.toLowerCase();
      if (ALLOWED_FORWARD_HEADERS.has(lower)) {
        forwardedHeaders.set(lower, value);
      }
    }

    forwardedHeaders.set("x-forwarded-host", url.host);
    forwardedHeaders.set("x-forwarded-proto", url.protocol.replace(":", ""));
    const socketIp = server?.requestIP?.(req)?.address;
    if (socketIp) {
      forwardedHeaders.set("x-forwarded-for", socketIp);
    }

    try {
      const upstreamRes = await safeFetchWithSsrf(
        targetUrl,
        {
          method: req.method,
          headers: forwardedHeaders,
          redirect: "manual",
        },
        5,
        { allowCalibreServer: true },
      );

      // 4. Response Header Filtering:
      // Strip 'set-cookie' and hop-by-hop headers
      const STRIPPED_RESPONSE_HEADERS = new Set([
        "connection",
        "keep-alive",
        "proxy-authenticate",
        "proxy-authorization",
        "set-cookie",
        "te",
        "trailer",
        "trailers",
        "transfer-encoding",
        "upgrade",
      ]);

      const proxyHeaders = new Headers();
      for (const [key, value] of upstreamRes.headers.entries()) {
        const lower = key.toLowerCase();
        if (STRIPPED_RESPONSE_HEADERS.has(lower)) {
          continue;
        }
        proxyHeaders.set(key, value);
      }
      proxyHeaders.delete("set-cookie");

      // Rewrite Location header if Calibre server issues a redirect to its internal origin
      const location = proxyHeaders.get("location");
      if (location) {
        try {
          const locUrl = new URL(location, targetUrl);
          const upstreamOrigin = new URL(serverBase).origin.toLowerCase();
          if (locUrl.origin.toLowerCase() === upstreamOrigin) {
            proxyHeaders.set(
              "location",
              locUrl.pathname + locUrl.search + locUrl.hash,
            );
          }
        } catch {
          // preserve original location if unparseable
        }
      }

      // Ensure proper CORS and security headers
      if (corsOrigin && isAllowedOrigin(corsOrigin)) {
        proxyHeaders.set("Access-Control-Allow-Origin", corsOrigin);
        proxyHeaders.set("Access-Control-Allow-Credentials", "true");
        const existingVary = proxyHeaders.get("Vary");
        proxyHeaders.set(
          "Vary",
          existingVary ? `${existingVary}, Origin` : "Origin",
        );
      }
      if (!proxyHeaders.has("X-Content-Type-Options")) {
        proxyHeaders.set("X-Content-Type-Options", "nosniff");
      }

      if (
        req.method === "HEAD" ||
        upstreamRes.status === 204 ||
        upstreamRes.status === 304
      ) {
        return new Response(null, {
          status: upstreamRes.status,
          statusText: upstreamRes.statusText,
          headers: proxyHeaders,
        });
      }

      // Stream body responses for large file downloads (ReadableStream from fetch)
      return new Response(upstreamRes.body, {
        status: upstreamRes.status,
        statusText: upstreamRes.statusText,
        headers: proxyHeaders,
      });
    } catch (err: any) {
      console.error(`[Server] OPDS reverse proxy error for ${targetUrl}:`, err);
      const errorHeaders: Record<string, string> = {
        "Content-Type": "text/plain; charset=utf-8",
        "X-Content-Type-Options": "nosniff",
      };
      if (corsOrigin) {
        errorHeaders["Access-Control-Allow-Origin"] = corsOrigin;
        errorHeaders["Access-Control-Allow-Credentials"] = "true";
        errorHeaders["Vary"] = "Origin";
      }
      return new Response("Bad Gateway: Unable to connect to Calibre server", {
        status: 502,
        headers: errorHeaders,
      });
    }
  }

  const isMutating = ["POST", "PUT", "DELETE", "PATCH"].includes(
    req.method.toUpperCase(),
  );

  // 1. CSRF & Origin Validation on mutating routes
  if (isMutating) {
    const csrfCheck = validateOriginAndCsrf(req);
    if (!csrfCheck.valid) {
      return jsonResponse(
        {
          success: false,
          error: csrfCheck.error || "CSRF origin validation failed",
        },
        403,
        corsOrigin,
      );
    }
  }

  // 2. WAN Authentication Gate on mutating routes (strictly based on socket address)
  const socketIp = server?.requestIP?.(req)?.address;
  const isWan = isWanRequest(req, {
    server,
    remoteAddress: socketIp,
  });
  const authOpts: AuthenticateRequestOptions = {
    server,
    remoteAddress: socketIp,
    isWan,
  };
  // Joplin Clipper (KOReader highlight export). These routes do not use
  // READING_API_KEY: KOReader sends only its Joplin token. That token must be a
  // private JOPLIN_TOKEN. handleJoplinRequest fails closed (503/401) before any
  // note write, including on WAN. /ping stays unauthenticated for reachability.
  if (isJoplinRoute(url.pathname)) {
    return await handleJoplinRequest(req, url, { corsOrigin, cacheDb: getCacheDb() });
  }

  if (isMutating && isWan) {
    const auth = authenticateRequest(req, authOpts);
    if (!auth.authenticated) {
      return jsonResponse(
        {
          success: false,
          error: auth.error || "Authentication required for public WAN access",
        },
        401,
        corsOrigin,
      );
    }
  }

  // API: Session Verification & Cookie Handoff
  if (
    url.pathname === "/api/auth/session" &&
    (req.method === "GET" || req.method === "POST")
  ) {
    const auth = authenticateRequest(req, authOpts);
    return jsonResponse(
      {
        success: auth.authenticated,
        method: auth.method,
        user: auth.user || null,
        isWan,
      },
      auth.authenticated ? 200 : 401,
      corsOrigin,
    );
  }

  // API: List books
  if (url.pathname === "/api/books" && req.method === "GET") {
    const etag = getCalibreDbETag();
    const ifNoneMatch = req.headers.get("if-none-match");

    const cacheHeaders: Record<string, string> = {
      ETag: etag,
      "Cache-Control": "public, max-age=5, must-revalidate",
    };
    if (corsOrigin && isAllowedOrigin(corsOrigin)) {
      cacheHeaders["Access-Control-Allow-Origin"] = corsOrigin;
      cacheHeaders["Access-Control-Allow-Credentials"] = "true";
      cacheHeaders["Vary"] = "Origin";
    }

    if (
      ifNoneMatch &&
      (ifNoneMatch === etag ||
        ifNoneMatch.includes(etag) ||
        ifNoneMatch === etag.replace(/"/g, ""))
    ) {
      return new Response(null, {
        status: 304,
        headers: cacheHeaders,
      });
    }

    const books = getCalibreBooks();
    let responseBooks = books;
    try {
      const counts = getHighlightCounts(getCacheDb());
      responseBooks = books.map((b: any) => {
        const normT = b.title ? b.title.trim().toLowerCase() : "";
        const count =
          counts.byBookId[b.id] ||
          (normT ? counts.byTitle[normT] : 0) ||
          0;
        const preview =
          counts.previewsByBookId[b.id] ||
          (normT ? counts.previewsByTitle[normT] : "") ||
          null;
        return {
          ...b,
          highlightCount: count,
          highlightPreview: preview,
        };
      });
    } catch {
      // Keep original books array if count lookup fails
    }

    return new Response(JSON.stringify(responseBooks), {
      status: 200,
      headers: {
        "Content-Type": "application/json; charset=utf-8",
        ...cacheHeaders,
      },
    });
  }

  // API: Library Facets
  if (url.pathname === "/api/library/facets" && req.method === "GET") {
    const books = getCalibreBooks();
    const authorMap: Record<string, number> = {};
    const seriesMap: Record<string, number> = {};
    const tagMap: Record<string, number> = {};
    const formatMap: Record<string, number> = {};

    for (const b of books) {
      if (b.authors) {
        const auths = b.authors
          .split(/[&,]/)
          .map((a: string) => cleanString(a))
          .filter(Boolean);
        for (const a of auths) authorMap[a] = (authorMap[a] || 0) + 1;
      }
      if (b.series) {
        const s = cleanString(b.series);
        seriesMap[s] = (seriesMap[s] || 0) + 1;
      }
      if (b.tags && Array.isArray(b.tags)) {
        for (const t of b.tags) {
          const cleanT = cleanString(t);
          if (cleanT && !/http|t\.me|thebookr/i.test(cleanT))
            tagMap[cleanT] = (tagMap[cleanT] || 0) + 1;
        }
      }
      if (b.formats && Array.isArray(b.formats)) {
        for (const f of b.formats) {
          if (f) formatMap[f] = (formatMap[f] || 0) + 1;
        }
      }
    }

    return jsonResponse(
      {
        totalBooks: books.length,
        authors: Object.entries(authorMap)
          .map(([name, count]) => ({ name, count }))
          .sort((a, b) => b.count - a.count),
        series: Object.entries(seriesMap)
          .map(([name, count]) => ({ name, count }))
          .sort((a, b) => b.count - a.count),
        tags: Object.entries(tagMap)
          .map(([name, count]) => ({ name, count }))
          .sort((a, b) => b.count - a.count),
        formats: Object.entries(formatMap)
          .map(([name, count]) => ({ name, count }))
          .sort((a, b) => b.count - a.count),
      },
      200,
      corsOrigin,
    );
  }

  // API: Durable Job Queue Inspection. Read-only library and reading-data
  // endpoints remain public on WAN; only mutation routes use the auth gate above.
  if (url.pathname === "/api/jobs/recent" && req.method === "GET") {
    const limitParam = parseInt(url.searchParams.get("limit") || "50", 10);
    const statusParam = url.searchParams.get("status") as any;
    const typeParam = url.searchParams.get("type") as any;
    const rawJobs = jobQueue.getRecentJobs({
      limit: isNaN(limitParam) ? 50 : limitParam,
      status: statusParam || undefined,
      type: typeParam || undefined,
    });
    const sanitizedJobs = rawJobs.map(sanitizeJobForResponse);

    return jsonResponse(
      { success: true, count: sanitizedJobs.length, jobs: sanitizedJobs },
      200,
      corsOrigin,
    );
  }

  if (url.pathname.startsWith("/api/jobs/") && req.method === "GET") {
    const jobId = url.pathname.split("/")[3];
    if (!jobId)
      return jsonResponse(
        { success: false, error: "Missing job ID" },
        400,
        corsOrigin,
      );
    const job = jobQueue.getJob(jobId);
    if (!job)
      return jsonResponse(
        { success: false, error: "Job not found" },
        404,
        corsOrigin,
      );

    return jsonResponse(
      { success: true, job: sanitizeJobForResponse(job) },
      200,
      corsOrigin,
    );
  }

  if (
    url.pathname.startsWith("/api/jobs/") &&
    url.pathname.endsWith("/retry") &&
    req.method === "POST"
  ) {
    if (isWan) {
      const auth = authenticateRequest(req, authOpts);
      if (!auth.authenticated) {
        return jsonResponse(
          {
            success: false,
            error:
              auth.error || "Authentication required for public WAN job retry",
          },
          401,
          corsOrigin,
        );
      }
    }

    const jobId = url.pathname.split("/")[3];
    if (!jobId)
      return jsonResponse(
        { success: false, error: "Missing job ID" },
        400,
        corsOrigin,
      );
    const retried = jobQueue.retryJob(jobId);
    if (!retried)
      return jsonResponse(
        { success: false, error: "Job not found" },
        404,
        corsOrigin,
      );

    return jsonResponse(
      {
        success: true,
        message: `Job ${jobId} queued for retry`,
        job: sanitizeJobForResponse(retried),
      },
      200,
      corsOrigin,
    );
  }

  // API: Book Cover Proxy & Native Downscaled Thumbnail Cache
  if (
    url.pathname.startsWith("/api/books/") &&
    url.pathname.endsWith("/cover")
  ) {
    const parts = url.pathname.split("/");
    const bookId = validateIntegerId(parts[3]);
    if (!bookId) return new Response("Invalid book ID", { status: 400 });

    const widthParam = url.searchParams.get("w");

    if (widthParam) {
      const targetWidth = Math.min(
        Math.max(parseInt(widthParam, 10) || 360, 64),
        1600,
      );
      const cacheFilePath = path.join(
        getCoverCacheDir(),
        `${bookId}_${targetWidth}.jpg`,
      );

      if (fs.existsSync(cacheFilePath)) {
        const cachedBuffer = fs.readFileSync(cacheFilePath);
        const etag = `"${crypto.createHash("sha256").update(cachedBuffer).digest("hex").slice(0, 16)}"`;

        if (req.headers.get("if-none-match") === etag) {
          return new Response(null, { status: 304 });
        }

        return new Response(cachedBuffer, {
          headers: {
            "Content-Type": "image/jpeg",
            "Cache-Control": "public, max-age=604800, immutable",
            ETag: etag,
          },
        });
      }

      // Check if master cover exists directly on disk
      const diskCoverPath = getMasterCoverPath(bookId);
      let tempMasterPath: string | null = null;
      let masterInputPath: string | null = null;
      let masterBuffer: Buffer | null = null;

      if (diskCoverPath) {
        masterInputPath = diskCoverPath;
      } else {
        // Fallback: Fetch master cover from Calibre server loopback
        const masterRes = await safeFetchWithSsrf(
          `${SERVER_URL}/get/cover/${bookId}/Agent_Library`,
          {},
          5,
          { allowCalibreServer: true },
        );
        if (!masterRes.ok) {
          return new Response("Cover not found", { status: 404 });
        }

        masterBuffer = Buffer.from(await masterRes.arrayBuffer());
        tempMasterPath = `/tmp/master_cover_${bookId}_${Date.now()}.jpg`;
        fs.writeFileSync(tempMasterPath, masterBuffer);
        masterInputPath = tempMasterPath;
      }

      try {
        const success = await downscaleImageAsync(
          masterInputPath,
          cacheFilePath,
          targetWidth,
        );

        if (success && fs.existsSync(cacheFilePath)) {
          const thumbBuffer = fs.readFileSync(cacheFilePath);
          const etag = `"${crypto.createHash("sha256").update(thumbBuffer).digest("hex").slice(0, 16)}"`;

          if (req.headers.get("if-none-match") === etag) {
            return new Response(null, { status: 304 });
          }

          return new Response(thumbBuffer, {
            headers: {
              "Content-Type": "image/jpeg",
              "Cache-Control": "public, max-age=604800, immutable",
              ETag: etag,
            },
          });
        }
      } finally {
        if (tempMasterPath && fs.existsSync(tempMasterPath)) {
          try {
            fs.unlinkSync(tempMasterPath);
          } catch (_unlinkErr) {
            void _unlinkErr;
          }
        }
      }

      // Fallback to original master if downscaling fails
      if (!masterBuffer && diskCoverPath && fs.existsSync(diskCoverPath)) {
        masterBuffer = fs.readFileSync(diskCoverPath);
      }

      if (masterBuffer) {
        const etag = `"${crypto.createHash("sha256").update(masterBuffer).digest("hex").slice(0, 16)}"`;
        if (req.headers.get("if-none-match") === etag) {
          return new Response(null, { status: 304 });
        }
        return new Response(masterBuffer, {
          headers: {
            "Content-Type": "image/jpeg",
            "Cache-Control": "public, max-age=604800, immutable",
            ETag: etag,
          },
        });
      }

      return new Response("Cover not found", { status: 404 });
    }

    // Master cover request (full resolution)
    const diskCoverPath = getMasterCoverPath(bookId);
    if (diskCoverPath) {
      const coverBuf = fs.readFileSync(diskCoverPath);
      const etag = `"${crypto.createHash("sha256").update(coverBuf).digest("hex").slice(0, 16)}"`;

      if (req.headers.get("if-none-match") === etag) {
        return new Response(null, { status: 304 });
      }

      return new Response(coverBuf, {
        headers: {
          "Content-Type": "image/jpeg",
          "Cache-Control": "public, max-age=86400",
          ETag: etag,
        },
      });
    }

    // Fallback: Fetch master cover from Calibre server loopback if not on disk
    const coverRes = await safeFetchWithSsrf(
      `${SERVER_URL}/get/cover/${bookId}/Agent_Library`,
      {},
      5,
      { allowCalibreServer: true },
    );
    if (coverRes.ok) {
      const coverBuf = Buffer.from(await coverRes.arrayBuffer());
      const etag = `"${crypto.createHash("sha256").update(coverBuf).digest("hex").slice(0, 16)}"`;

      if (req.headers.get("if-none-match") === etag) {
        return new Response(null, { status: 304 });
      }

      return new Response(coverBuf, {
        headers: {
          "Content-Type": coverRes.headers.get("Content-Type") || "image/jpeg",
          "Cache-Control": "public, max-age=86400",
          ETag: etag,
        },
      });
    }
    return new Response("Cover not found", { status: 404 });
  }

  // API: Book Download Proxy (Delivers clean sanitized metadata-based filename)
  if (
    url.pathname.startsWith("/api/books/") &&
    url.pathname.includes("/download/")
  ) {
    const parts = url.pathname.split("/");
    const bookId = validateIntegerId(parts[3]);
    const format = validateBookFormat(parts[5]);

    if (!bookId || !format) {
      return new Response("Invalid book ID or format", { status: 400 });
    }

    const fileRes = await safeFetchWithSsrf(
      `${SERVER_URL}/get/${format}/${bookId}/Agent_Library`,
      {},
      5,
      { allowCalibreServer: true },
    );
    if (fileRes.ok) {
      const books = getCalibreBooks();
      const book = books.find((b: any) => b.id === bookId) || {
        title: `Book-${bookId}`,
        authors: "Unknown",
      };
      const downloadFilename = getDownloadFilename(book, format);

      return new Response(await fileRes.arrayBuffer(), {
        headers: {
          "Content-Type":
            fileRes.headers.get("Content-Type") || "application/octet-stream",
          "Content-Disposition": `attachment; filename="${downloadFilename}"`,
          "X-Content-Type-Options": "nosniff",
        },
      });
    }
    return new Response("File not found", { status: 404 });
  }

  // API: KOSync Live Telemetry
  if (url.pathname === "/api/kosync/active" && req.method === "GET") {
    const progress = getKosyncProgress();
    return jsonResponse(progress, 200, corsOrigin);
  }

  // API: Reading Stats
  if (url.pathname === "/api/kosync/stats" && req.method === "GET") {
    const progress = getKosyncProgress();
    const finishedBooks = progress.filter((p) => p.percentage >= 0.99);
    const activeBooks = progress.filter(
      (p) => p.percentage < 0.99 && p.percentage > 0,
    );

    const days = new Set<string>();
    for (const p of progress) {
      if (p.timestamp) {
        const dateStr = new Date(p.timestamp * 1000)
          .toISOString()
          .split("T")[0];
        days.add(dateStr);
      }
    }

    return jsonResponse(
      {
        totalSessions: progress.length,
        readingDaysCount: days.size,
        finishedCount: finishedBooks.length,
        finishedBooks,
        activeBooks,
      },
      200,
      corsOrigin,
    );
  }

  // API: Bulk Clean Metadata
  if (url.pathname === "/api/library/clean-metadata" && req.method === "POST") {
    try {
      const books = getCalibreBooks(true);
      let cleanedCount = 0;

      for (const b of books) {
        const clean = sanitizeMetadata(b.title, b.authors, b.tags);
        const setArgs = [
          "set_metadata",
          String(b.id),
          "--with-library",
          SERVER_URL,
        ];
        let hasChanges = false;

        if (clean.title && clean.title !== b.title) {
          setArgs.push("--field", `title:${clean.title}`);
          hasChanges = true;
        }
        if (clean.author && clean.author !== b.authors) {
          setArgs.push("--field", `authors:${clean.author}`);
          hasChanges = true;
        }
        if (clean.tags) {
          setArgs.push("--field", `tags:${clean.tags.join(",")}`);
          hasChanges = true;
        }

        if (hasChanges) {
          runCalibredb(setArgs);
          cleanedCount++;
        }
      }

      getCalibreBooks(true);
      return jsonResponse(
        {
          success: true,
          message: `Sanitized metadata for ${cleanedCount} books`,
        },
        200,
        corsOrigin,
      );
    } catch (err) {
      return jsonResponse(
        { success: false, error: sanitizeErrorMessage(err) },
        500,
        corsOrigin,
      );
    }
  }

  // API: Backfill Covers for Web Articles without a Cover
  if (
    url.pathname === "/api/library/backfill-covers" &&
    req.method === "POST"
  ) {
    try {
      const books = getCalibreBooks(true);
      const candidates = books.filter((b: any) => {
        const tags = Array.isArray(b.tags) ? b.tags : b.tags ? [b.tags] : [];
        const isWeb = tags.some(
          (t: string) => t === "Web Article" || t === "Read Later",
        );
        const hasCover = b.cover && b.cover !== 0 && b.cover !== false;
        return isWeb && !hasCover;
      });

      const job = jobQueue.enqueue("cover_backfill", {
        candidateBookIds: candidates.map((c: any) => c.id),
      });

      return jsonResponse(
        {
          success: true,
          count: candidates.length,
          jobId: job.id,
          message: `Enqueued cover backfill job for ${candidates.length} web articles.`,
        },
        200,
        corsOrigin,
      );
    } catch (err: any) {
      return jsonResponse(
        { success: false, error: sanitizeErrorMessage(err) },
        500,
        corsOrigin,
      );
    }
  }

  // API: Get highlights for a specific book
  if (
    url.pathname.startsWith("/api/books/") &&
    url.pathname.endsWith("/highlights") &&
    req.method === "GET"
  ) {
    const parts = url.pathname.split("/");
    const bookId = validateIntegerId(parts[3]);
    if (!bookId) {
      return jsonResponse(
        { success: false, error: "Invalid book ID" },
        400,
        corsOrigin,
      );
    }

    try {
      const books = getCalibreBooks();
      const book = books.find((b: any) => b.id === bookId);
      const title = book?.title || `Book #${bookId}`;
      const forceFresh =
        url.searchParams.has("refresh") || url.searchParams.has("fresh");

      const db = getCacheDb();
      let highlights = ensureBookHighlightsIndexed(db, bookId, title, {
        forceFresh,
      });

      // If fresh requested or highlights empty, also recheck SDR highlights
      if (forceFresh || highlights.length === 0) {
        const sdrHighlights = extractHighlightsFromSdr(bookId);
        if (sdrHighlights.length > 0) {
          const records = sdrHighlights
            .map((h) => ({
              book_id: bookId,
              book_title: title,
              chapter: h.chapter || null,
              page: h.page || null,
              quote: cleanQuoteText(h.text),
              note: h.notes || null,
              timestamp: h.datetime || null,
            }))
            .filter((r) => r.quote && r.quote.trim().length > 0);
          if (records.length > 0) {
            batchUpsertHighlights(db, records);
            highlights = getHighlightsForBook(db, bookId, title, 1000);
          }
        }
      }

      // Bound results to 1000 highlights max
      const safeHighlights = highlights.slice(0, 1000).map((h) => ({
        id: h.id,
        chapter: h.chapter || null,
        page: h.page || null,
        quote: h.quote,
        note: h.note || null,
        timestamp: h.timestamp || null,
      }));

      return jsonResponse(
        {
          success: true,
          count: safeHighlights.length,
          book_id: bookId,
          title,
          highlights: safeHighlights,
        },
        200,
        corsOrigin,
      );
    } catch (err: any) {
      return jsonResponse(
        { success: false, error: sanitizeErrorMessage(err) },
        500,
        corsOrigin,
      );
    }
  }

  // API: Highlights lookup and library-wide counts
  if (url.pathname === "/api/highlights" && req.method === "GET") {
    try {
      const db = getCacheDb();
      const titleParam = url.searchParams.get("title");
      const bookIdParam = url.searchParams.get("book_id") || url.searchParams.get("id");

      if (bookIdParam) {
        const bookId = validateIntegerId(bookIdParam);
        if (!bookId) {
          return jsonResponse(
            { success: false, error: "Invalid book ID" },
            400,
            corsOrigin,
          );
        }
        const books = getCalibreBooks();
        const book = books.find((b: any) => b.id === bookId);
        const title = book?.title || `Book #${bookId}`;
        const highlights = ensureBookHighlightsIndexed(db, bookId, title);
        return jsonResponse(
          {
            success: true,
            count: highlights.length,
            book_id: bookId,
            title,
            highlights: highlights.slice(0, 1000).map((h) => ({
              id: h.id,
              chapter: h.chapter || null,
              page: h.page || null,
              quote: h.quote,
              note: h.note || null,
              timestamp: h.timestamp || null,
            })),
          },
          200,
          corsOrigin,
        );
      }

      if (titleParam) {
        const title = titleParam.trim();
        const highlights = getHighlightsByTitle(db, title);
        return jsonResponse(
          {
            success: true,
            count: highlights.length,
            title,
            highlights: highlights.slice(0, 1000).map((h) => ({
              id: h.id,
              chapter: h.chapter || null,
              page: h.page || null,
              quote: h.quote,
              note: h.note || null,
              timestamp: h.timestamp || null,
            })),
          },
          200,
          corsOrigin,
        );
      }

      // Aggregate counts across library
      const counts = getHighlightCounts(db);
      return jsonResponse(
        {
          success: true,
          counts,
        },
        200,
        corsOrigin,
      );
    } catch (err: any) {
      return jsonResponse(
        { success: false, error: sanitizeErrorMessage(err) },
        500,
        corsOrigin,
      );
    }
  }

  // API: Export Obsidian Markdown with Real Highlights
  if (
    url.pathname.startsWith("/api/books/") &&
    url.pathname.endsWith("/obsidian.md")
  ) {
    const parts = url.pathname.split("/");
    const bookId = validateIntegerId(parts[3]);
    if (!bookId) return new Response("Invalid book ID", { status: 400 });

    const books = getCalibreBooks();
    const book = books.find((b: any) => b.id === bookId);
    const progress = getKosyncProgress().find(
      (p) => p.bookId === bookId || (book && p.displayTitle === book.title),
    );

    const title = book?.title || progress?.displayTitle || "Book Notes";
    const author = book?.authors || progress?.displayAuthors || "Unknown";
    const pct = progress ? Math.round(progress.percentage * 100) : 0;
    const dateStr = new Date().toISOString().split("T")[0];

    const highlights = extractHighlightsFromSdr(bookId);

    const highlightLines: string[] = [];
    if (highlights.length > 0) {
      highlights.forEach((h, i) => {
        highlightLines.push(`### Highlight ${i + 1}`);
        highlightLines.push(`> ${h.text}`);
        if (h.notes) highlightLines.push(`**Note:** ${h.notes}`);
        highlightLines.push(
          `*Captured: ${h.datetime}${h.page ? " | Page: " + h.page : ""}*`,
        );
        highlightLines.push("");
      });
    } else {
      highlightLines.push(
        "*(No highlights found in .sdr sidecar for this document)*",
      );
      highlightLines.push("");
      highlightLines.push(`- Current Progress: ${pct}%`);
    }

    const md = [
      "---",
      `title: "${title}"`,
      `author: "${author}"`,
      `series: "${book?.series || ""}"`,
      `date_created: ${dateStr}`,
      `progress_percent: ${pct}%`,
      "tags:",
      "  - book-notes",
      "  - reading-hq",
      "---",
      "",
      `# 📖 ${title}`,
      `> **Author:** ${author}  `,
      `> **Series:** ${book?.series ? book.series + " #" + (book.series_index || 1) : "Standalone"}  `,
      `> **Reading Progress:** ${pct}% (Synced from KOReader)  `,
      `> **Last Read:** ${progress?.timestamp ? new Date(progress.timestamp * 1000).toLocaleString() : dateStr}  `,
      "",
      "---",
      "",
      "## 📑 Book Summary",
      book?.comments
        ? book.comments.replace(/<[^>]*>?/gm, "")
        : "No summary provided.",
      "",
      "---",
      "",
      "## 📝 Highlights & Annotations",
      ...highlightLines,
    ].join("\n");

    const obsidianFilename = generateMetadataFilename({
      title: `${title} Notes`,
      authors: author,
      series: book?.series || null,
      seriesIndex: book?.series_index || null,
      format: "md",
      fallbackBase: "notes",
    });

    return new Response(md, {
      headers: {
        "Content-Type": "text/markdown; charset=utf-8",
        "Content-Disposition": buildContentDisposition(obsidianFilename),
        "X-Content-Type-Options": "nosniff",
      },
    });
  }

  // API: Wireless Over-The-Air Highlights & Note Sync to Obsidian
  if (url.pathname === "/api/highlights/sync" && req.method === "POST") {
    try {
      const MAX_BODY_BYTES = 5 * 1024 * 1024; // 5MB
      const contentLength = req.headers.get("content-length");
      if (contentLength && parseInt(contentLength, 10) > MAX_BODY_BYTES) {
        return jsonResponse(
          { success: false, error: "Payload too large (max 5MB)" },
          413,
          corsOrigin,
        );
      }

      const contentType = req.headers.get("content-type") || "";
      let title: string | undefined;
      let author: string | undefined;
      let highlights: HighlightEntry[] = [];
      let bookId: number | undefined;
      let progress: number | undefined;

      const rawText = await req.text();
      if (Buffer.byteLength(rawText, "utf8") > MAX_BODY_BYTES) {
        return jsonResponse(
          { success: false, error: "Payload too large (max 5MB)" },
          413,
          corsOrigin,
        );
      }

      if (contentType.includes("application/json") || rawText.trim().startsWith("{") || rawText.trim().startsWith("[")) {
        let body: any;
        try {
          body = JSON.parse(rawText);
        } catch (_jsonErr) {
          void _jsonErr;
          return jsonResponse(
            { success: false, error: "Invalid JSON payload" },
            400,
            corsOrigin,
          );
        }

        if (body.bookId !== undefined) {
          const validId = validateIntegerId(body.bookId);
          if (!validId) {
            return jsonResponse(
              { success: false, error: "Invalid bookId" },
              400,
              corsOrigin,
            );
          }
          bookId = validId;
          const books = getCalibreBooks();
          const book = books.find((b: any) => b.id === bookId);
          if (!book) {
            return jsonResponse(
              { success: false, error: "Book not found in Calibre" },
              404,
              corsOrigin,
            );
          }
          title = book.title;
          author = book.authors;
          highlights = extractHighlightsFromSdr(bookId);
        } else if (body.all) {
          const syncRes = await syncObsidian({ apply: true });
          return jsonResponse(
            {
              success: true,
              message: "Synced all books to Obsidian",
              count: syncRes.totalHighlightsFound,
              booksProcessed: syncRes.totalBooksScanned,
            },
            200,
            corsOrigin,
          );
        } else if (Array.isArray(body.documents)) {
          let totalSynced = 0;
          for (const doc of body.documents) {
            const docParsed = extractHighlightsFromLua(doc);
            if (docParsed.title || doc.title) {
              const res = await syncObsidian({
                apply: true,
                books: [
                  {
                    title: docParsed.title || doc.title,
                    author: docParsed.author || doc.author || "Unknown",
                    highlights:
                      docParsed.highlights.length > 0
                        ? docParsed.highlights
                        : (doc.entries || []).map((e: any) => ({
                            text: e.text || e.highlight || "",
                            notes: e.notes || e.note,
                            chapter: e.chapter,
                            page: e.page || e.pageno,
                            datetime: e.datetime || e.time,
                          })),
                    progress:
                      docParsed.percentFinished !== undefined
                        ? docParsed.percentFinished
                        : doc.progress,
                  },
                ],
              });
              totalSynced += res.totalHighlightsFound;
            }
          }
          return jsonResponse(
            {
              success: true,
              message: `Processed ${body.documents.length} document(s)`,
              count: totalSynced,
            },
            200,
            corsOrigin,
          );
        } else if (body.title || body.entries || body.highlights) {
          title = body.title;
          author = body.author;
          progress =
            typeof body.progress === "number" ? body.progress : undefined;
          const rawEntries = body.entries || body.highlights || [];
          if (Array.isArray(rawEntries)) {
            for (const e of rawEntries) {
              const text = (e.text || e.highlight || e.quote || "").trim();
              const notes = (e.notes || e.note || e.comment || "").trim();
              if (text || notes) {
                highlights.push({
                  text,
                  notes: notes || undefined,
                  chapter: e.chapter,
                  page: e.page ?? e.pageno,
                  datetime: e.datetime || e.time,
                });
              }
            }
          }
        } else if (typeof body.markdown === "string") {
          const lines = body.markdown.split("\n");
          for (const l of lines) {
            const trimmed = l.trim();
            if (trimmed.startsWith("# ") && !title) {
              title = trimmed.slice(2).trim();
            } else if (trimmed.startsWith("> ")) {
              highlights.push({ text: trimmed.slice(2).trim() });
            }
          }
          title = title || body.title;
          author = body.author;
        }
      } else {
        const lines = rawText.split("\n");
        for (const l of lines) {
          const trimmed = l.trim();
          if (trimmed.startsWith("# ") && !title) {
            title = trimmed.slice(2).trim();
          } else if (trimmed.startsWith("> ")) {
            highlights.push({ text: trimmed.slice(2).trim() });
          }
        }
      }

      if (!title && highlights.length === 0 && !bookId) {
        return jsonResponse(
          {
            success: false,
            error:
              "Payload must contain book title, bookId, or highlight entries",
          },
          400,
          corsOrigin,
        );
      }

      const syncResult = await syncObsidian({
        apply: true,
        books: [
          {
            title: title || "Untitled",
            author: author || "Unknown",
            bookId,
            progress,
            highlights,
          },
        ],
      });

      const syncedItem = syncResult.items[0];
      const relPath = syncedItem?.filename ? path.join("Books", syncedItem.filename) : "";
      return jsonResponse(
        {
          success: true,
          count: syncResult.totalHighlightsFound,
          bookTitle: syncedItem?.title || title || "Untitled",
          filename: syncedItem?.filename,
          path: relPath,
          action: syncedItem?.action || "updated",
        },
        200,
        corsOrigin,
      );
    } catch (err: any) {
      return jsonResponse(
        { success: false, error: sanitizeErrorMessage(err) },
        500,
        corsOrigin,
      );
    }
  }

  // API: Link Unmapped KOSync Document to Calibre Book
  if (url.pathname === "/api/kosync/link-document" && req.method === "POST") {
    try {
      const body = (await req.json()) as { document: string; bookId: number };
      const bookId = validateIntegerId(body.bookId);
      if (!body.document || !bookId) {
        return jsonResponse(
          { success: false, error: "Valid document and bookId required" },
          400,
          corsOrigin,
        );
      }

      const books = getCalibreBooks();
      const book = books.find((b: any) => b.id === bookId);
      if (!book) {
        return jsonResponse(
          { success: false, error: "Book not found in Calibre" },
          404,
          corsOrigin,
        );
      }

      const canonicalId =
        cleanString(book.title).toLowerCase() +
        "__" +
        cleanString(book.authors || "").toLowerCase();
      const now = Math.floor(Date.now() / 1000);

      if (fs.existsSync(KOSYNC_DB_PATH)) {
        const db = new Database(KOSYNC_DB_PATH);
        db.prepare(
          `INSERT INTO document_aliases (document_hash, canonical_id, normalized_title, normalized_authors, created_at)
           VALUES (?, ?, ?, ?, ?)
           ON CONFLICT(document_hash) DO UPDATE SET
             canonical_id = excluded.canonical_id,
             normalized_title = excluded.normalized_title,
             normalized_authors = excluded.normalized_authors`,
        ).run(
          body.document,
          canonicalId,
          book.title,
          book.authors || "Unknown",
          now,
        );

        db.prepare(
          `UPDATE progress
           SET title = ?, authors = ?
           WHERE document = ?`,
        ).run(book.title, book.authors || "Unknown", body.document);

        return jsonResponse(
          {
            success: true,
            message: `Linked hash ${body.document.substring(0, 8)}... to "${book.title}"`,
          },
          200,
          corsOrigin,
        );
      }

      return jsonResponse(
        { success: false, error: "KOSync database missing" },
        500,
        corsOrigin,
      );
    } catch (err: any) {
      return jsonResponse(
        { success: false, error: sanitizeErrorMessage(err) },
        500,
        corsOrigin,
      );
    }
  }

  // API: Delete Single KOSync Progress Entry
  if (
    url.pathname.startsWith("/api/kosync/progress/") &&
    req.method === "DELETE"
  ) {
    try {
      const parts = url.pathname.split("/");
      const progressId = validateIntegerId(parts[4]);
      if (!progressId) {
        return jsonResponse(
          { success: false, error: "Invalid progress ID" },
          400,
          corsOrigin,
        );
      }

      if (fs.existsSync(KOSYNC_DB_PATH)) {
        const db = new Database(KOSYNC_DB_PATH);
        db.run("DELETE FROM progress WHERE id = ?;", [progressId]);
        return jsonResponse(
          { success: true, message: `Removed progress entry ${progressId}` },
          200,
          corsOrigin,
        );
      }
      return jsonResponse(
        { success: false, error: "KOSync database not found" },
        404,
        corsOrigin,
      );
    } catch (err: any) {
      return jsonResponse(
        { success: false, error: sanitizeErrorMessage(err) },
        500,
        corsOrigin,
      );
    }
  }

  // API: Clear All KOSync Progress Entries
  if (url.pathname === "/api/kosync/progress/clear" && req.method === "POST") {
    try {
      if (fs.existsSync(KOSYNC_DB_PATH)) {
        const db = new Database(KOSYNC_DB_PATH);
        db.run("DELETE FROM progress;");
        return jsonResponse(
          { success: true, message: "Cleared all sync sessions" },
          200,
          corsOrigin,
        );
      }
      return jsonResponse(
        { success: false, error: "KOSync database not found" },
        404,
        corsOrigin,
      );
    } catch (err: any) {
      return jsonResponse(
        { success: false, error: sanitizeErrorMessage(err) },
        500,
        corsOrigin,
      );
    }
  }

  // API: Ingest Web Article from URL (Read Later EPUB with SSRF Protection)
  if (url.pathname === "/api/ingest-url" && req.method === "POST") {
    try {
      const body = (await req.json()) as { url?: string };
      if (!body.url || typeof body.url !== "string") {
        return jsonResponse(
          { success: false, error: "Missing or invalid 'url' parameter" },
          400,
          corsOrigin,
        );
      }
      const targetUrl = body.url.trim();

      // Validate URL against SSRF vulnerabilities
      const ssrfCheck = await validateUrlForSSRF(targetUrl, {
        allowProxyBypass: true,
      });
      if (!ssrfCheck.safe) {
        return jsonResponse(
          {
            success: false,
            error: `SSRF protection: ${ssrfCheck.error || "Unsafe target URL rejected by SSRF guard"}`,
          },
          400,
          corsOrigin,
        );
      }

      const result = await ingestArticleFromUrl(targetUrl);
      if (!result.success) {
        return jsonResponse(result, 500, corsOrigin);
      }

      getCalibreBooks(true);
      return jsonResponse(result, 200, corsOrigin);
    } catch (err: any) {
      return jsonResponse(
        {
          success: false,
          error:
            sanitizeErrorMessage(err) || "Failed to ingest article from URL",
        },
        500,
        corsOrigin,
      );
    }
  }

  // API: Lnori Light Novel Series & Volume Ingestion
  if (url.pathname === "/api/lnori/ingest" && req.method === "POST") {
    try {
      let body: {
        url?: string;
        stream?: boolean | string;
        format?: string;
      };
      try {
        body = (await req.json()) as any;
      } catch {
        return jsonResponse(
          { success: false, error: "Missing or invalid 'url' parameter" },
          400,
          corsOrigin,
        );
      }

      if (!body || !body.url || typeof body.url !== "string" || !body.url.trim()) {
        return jsonResponse(
          { success: false, error: "Missing or invalid 'url' parameter" },
          400,
          corsOrigin,
        );
      }
      const targetUrl = body.url.trim();

      // Validate target URL with isLnoriUrl
      if (!isLnoriUrl(targetUrl)) {
        return jsonResponse(
          {
            success: false,
            error: "Target URL must be a valid lnori.com series or book URL",
          },
          400,
          corsOrigin,
        );
      }

      // Validate URL against SSRF vulnerabilities
      const ssrfCheck = await validateUrlForSSRF(targetUrl, {
        allowProxyBypass: true,
      });
      if (!ssrfCheck.safe) {
        return jsonResponse(
          {
            success: false,
            error: `SSRF protection: ${ssrfCheck.error || "Unsafe target URL rejected by SSRF guard"}`,
          },
          400,
          corsOrigin,
        );
      }

      const acceptHeader = req.headers.get("accept") || "";
      const isNDJSON =
        acceptHeader.includes("application/x-ndjson") ||
        body.stream === "ndjson" ||
        body.format === "ndjson";
      const isSSE =
        acceptHeader.includes("text/event-stream") ||
        body.stream === "sse" ||
        (Boolean(body.stream) && !isNDJSON);
      const isStream = Boolean(body.stream || isSSE || isNDJSON);

      const runIngest = serverDependencies.ingestLnoriSeries ?? ingestLnoriSeries;
      const refreshBooks = serverDependencies.getCalibreBooks ?? getCalibreBooks;

      if (isStream) {
        const contentType =
          isNDJSON && !isSSE
            ? "application/x-ndjson; charset=utf-8"
            : "text/event-stream; charset=utf-8";

        const streamHeaders: Record<string, string> = {
          "Content-Type": contentType,
          "Cache-Control": "no-cache, no-transform",
          Connection: "keep-alive",
          "X-Accel-Buffering": "no",
        };
        if (corsOrigin) {
          streamHeaders["Access-Control-Allow-Origin"] = corsOrigin;
          streamHeaders["Access-Control-Allow-Credentials"] = "true";
          streamHeaders["Vary"] = "Origin";
        }

        const abortController = new AbortController();
        if (req.signal) {
          if (req.signal.aborted) {
            abortController.abort();
          } else {
            req.signal.addEventListener("abort", () => {
              abortController.abort();
            });
          }
        }

        const encoder = new TextEncoder();
        const stream = new ReadableStream({
          async start(controller) {
            const isSSEFormat = contentType.startsWith("text/event-stream");
            let hasErrored = false;

            const sendEvent = (event: LnoriProgressEvent) => {
              try {
                if (event.phase === "error") {
                  hasErrored = true;
                }
                const outboundEvent: LnoriProgressEvent = {
                  ...event,
                  status:
                    event.phase === "error" && event.status
                      ? sanitizeErrorMessage(event.status)
                      : event.status,
                  volumeTitle: event.volumeTitle,
                };
                if (outboundEvent.data) {
                  outboundEvent.data = { ...outboundEvent.data };
                  if (typeof outboundEvent.data.error === "string") {
                    outboundEvent.data.error = sanitizeErrorMessage(
                      outboundEvent.data.error,
                    );
                  }
                }
                const json = JSON.stringify(outboundEvent);
                const chunk = isSSEFormat ? `data: ${json}\n\n` : `${json}\n`;
                controller.enqueue(encoder.encode(chunk));
              } catch (enqueueErr) {
                // Client disconnected or controller closed: abort background work
                abortController.abort();
                console.debug(
                  "[Lnori] Stream controller enqueue failed (client disconnected):",
                  enqueueErr,
                );
              }
            };

            try {
              let hasCompleted = false;
              const result = await runIngest(
                targetUrl,
                async (event: LnoriProgressEvent) => {
                  if (event.phase === "complete") {
                    hasCompleted = true;
                  }
                  sendEvent(event);
                },
                { signal: abortController.signal },
              );

              if (!result || !result.success) {
                if (!hasErrored) {
                  sendEvent({
                    phase: "error",
                    status:
                      sanitizeErrorMessage(result?.error) ||
                      "Failed to ingest light novel from Lnori",
                    data: {
                      error:
                        sanitizeErrorMessage(result?.error) ||
                        "Failed to ingest light novel from Lnori",
                    },
                  });
                }
              } else {
                refreshBooks(true);
                if (!hasCompleted) {
                  sendEvent({
                    phase: "complete",
                    index: result.totalCount,
                    total: result.totalCount,
                    volumeTitle: result.seriesTitle,
                    status: `Completed: ${result.importedCount} imported, ${result.skippedCount} skipped of ${result.totalCount} volumes`,
                    data: {
                      success: true,
                      seriesTitle: result.seriesTitle,
                      author: result.author,
                      importedCount: result.importedCount,
                      skippedCount: result.skippedCount,
                      totalCount: result.totalCount,
                      tags: result.tags,
                      calibreBookIds: result.calibreBookIds,
                    },
                  });
                }
              }
            } catch (err: any) {
              if (!hasErrored) {
                sendEvent({
                  phase: "error",
                  status:
                    sanitizeErrorMessage(err) ||
                    "Failed to ingest light novel from Lnori",
                  data: {
                    error:
                      sanitizeErrorMessage(err) ||
                      "Failed to ingest light novel from Lnori",
                  },
                });
              }
            } finally {
              try {
                controller.close();
              } catch (closeErr) {
                console.debug("[Lnori] Stream controller close failed:", closeErr);
              }
            }
          },
          cancel() {
            abortController.abort();
          },
        });

        return new Response(stream, {
          status: 200,
          headers: streamHeaders,
        });
      }

      const result = await runIngest(targetUrl);
      if (!result || !result.success) {
        return jsonResponse(
          {
            success: false,
            error:
              sanitizeErrorMessage(result?.error) ||
              "Failed to ingest light novel from Lnori",
          },
          500,
          corsOrigin,
        );
      }

      refreshBooks(true);

      return jsonResponse(
        {
          success: true,
          seriesTitle: result.seriesTitle,
          author: result.author,
          importedCount: result.importedCount,
          skippedCount: result.skippedCount,
          totalCount: result.totalCount,
          tags: result.tags,
        },
        200,
        corsOrigin,
      );
    } catch (err: any) {
      return jsonResponse(
        {
          success: false,
          error:
            sanitizeErrorMessage(err) ||
            "Failed to ingest light novel from Lnori",
        },
        500,
        corsOrigin,
      );
    }
  }

  // API: Upload Book (Strict Resource Limits, SSRF/Zip-Bomb Guards & Canonical EPUB Validation)
  if (url.pathname === "/api/upload" && req.method === "POST") {
    try {
      const contentLengthStr = req.headers.get("content-length");
      if (contentLengthStr) {
        const contentLength = parseInt(contentLengthStr, 10);
        if (contentLength > MAX_UPLOAD_SIZE) {
          return jsonResponse(
            {
              success: false,
              error: `Upload payload (${Math.round(contentLength / 1024 / 1024)}MB) exceeds safety limit (${MAX_UPLOAD_SIZE / 1024 / 1024}MB)`,
            },
            413,
            corsOrigin,
          );
        }
      }

      const formData = await req.formData();
      const file = formData.get("file") as File;
      if (!file || typeof file === "string") {
        return jsonResponse(
          { success: false, error: "No file provided" },
          400,
          corsOrigin,
        );
      }

      const fileName = file.name;
      const ext = path.extname(fileName).toLowerCase();

      // Check format eligibility
      const isArchive = isArchiveFile(fileName);
      const isEpub = isCanonicalEpub(fileName);

      if (!isArchive && !isEpub) {
        return jsonResponse(
          {
            success: false,
            error: `Rejected non-canonical format "${ext}". Only EPUB format is accepted for the canonical collection.`,
          },
          400,
          corsOrigin,
        );
      }

      const arrayBuffer = await file.arrayBuffer();

      // Check Junk Ingest Gate on single file uploads before writing into Books_Drop
      if (!isArchive) {
        const preliminaryCheck = sanitizeMetadata("", "", [], fileName);
        const preJunk = await evaluateJunkGate(
          preliminaryCheck.title,
          fileName,
          preliminaryCheck.author,
        );
        if (preJunk.quarantined) {
          const tempPreFile = path.join(os.tmpdir(), `pre_q_upload_${Date.now()}_${path.basename(fileName)}`);
          fs.writeFileSync(tempPreFile, Buffer.from(arrayBuffer));
          moveToQuarantine(tempPreFile, path.basename(fileName));
          return jsonResponse(
            {
              success: false,
              rejected: true,
              format: ext.replace(/^\./, "").toUpperCase() || "UNKNOWN",
              error: `Quarantined by junk ingest gate: ${preJunk.reason || "Invalid artifact"}`,
            },
            400,
            corsOrigin,
          );
        }
      }

      const safeBase = path.basename(fileName, ext);
      const tempName = `${safeBase}_${Date.now()}_${crypto.randomBytes(4).toString("hex")}${ext}`;
      const destPath = path.join(getDropDir(), tempName);
      fs.writeFileSync(destPath, Buffer.from(arrayBuffer));

      if (isArchive) {
        console.log(
          `[Upload] Archive received: ${fileName}. Inspecting and unpacking...`,
        );
        const unp = unpackArchive(destPath);
        try {
          fs.unlinkSync(destPath);
        } catch {}

        if (!unp.success) {
          return jsonResponse(
            {
              success: false,
              error: unp.error || "Archive extraction failed",
              quarantined: unp.quarantined || [],
            },
            400,
            corsOrigin,
          );
        }

        console.log(
          `[Upload] Archive ${fileName} yielded ${unp.books.length} canonical EPUB(s). Processing...`,
        );
        const results: any[] = [];
        for (const book of unp.books) {
          const r = await ingestBookFile(book.tempPath, book.originalName);
          results.push({ name: book.originalName, ...r });
        }
        unp.cleanup();

        const importedCount = results.filter(
          (r: any) => r.success && !r.duplicate,
        ).length;
        const uploadResponsePayload = {
          success: true,
          isArchive: true,
          archiveName: fileName,
          total: unp.books.length,
          imported: importedCount,
          quarantined: unp.quarantined || [],
          quarantinedCount: (unp.quarantined || []).length,
          results,
        };
        return jsonResponse(
          recursivelySanitize(uploadResponsePayload),
          200,
          corsOrigin,
        );
      }

      // Single file ingestion: strictly enforce .epub format
      if (!isEpub) {
        try {
          fs.unlinkSync(destPath);
        } catch {}
        return jsonResponse(
          {
            success: false,
            rejected: true,
            format: ext.replace(/^\./, "").toUpperCase() || "UNKNOWN",
            error: `Rejected format "${ext}". home-reading-stack is an EPUB-only collection; only .epub files (or archives containing .epub files) are accepted.`,
          },
          400,
          corsOrigin,
        );
      }

      const result = await ingestBookFile(destPath, fileName);
      try {
        fs.unlinkSync(destPath);
      } catch {}

      return jsonResponse(result, result.success ? 200 : 500, corsOrigin);
    } catch (err: any) {
      return jsonResponse(
        { success: false, error: sanitizeErrorMessage(err) },
        500,
        corsOrigin,
      );
    }
  }

  // API: Delete Book
  if (url.pathname.startsWith("/api/books/") && req.method === "DELETE") {
    const parts = url.pathname.split("/");
    const bookId = validateIntegerId(parts[3]);
    if (!bookId) {
      return jsonResponse(
        { success: false, error: "Invalid book ID" },
        400,
        corsOrigin,
      );
    }

    const books = getCalibreBooks();
    const book = books.find((b: any) => b.id === bookId);
    const bookTitle = book?.title;

    const delRes = runCalibredb([
      "remove",
      String(bookId),
      "--with-library",
      SERVER_URL,
    ]);

    getCalibreBooks(true);
    if (delRes.status === 0) {
      deleteHighlightsForBook(getCacheDb(), bookId, bookTitle);
      return jsonResponse(
        { success: true, message: `Removed book ${bookId}` },
        200,
        corsOrigin,
      );
    } else {
      return jsonResponse(
        {
          success: false,
          error: sanitizeErrorMessage(delRes.stderr || "Delete failed"),
        },
        500,
        corsOrigin,
      );
    }
  }

  // API: Bulk Delete Books
  if (url.pathname === "/api/books/bulk-delete" && req.method === "POST") {
    try {
      const body = (await req.json()) as { bookIds: (string | number)[] };
      if (
        !body.bookIds ||
        !Array.isArray(body.bookIds) ||
        !body.bookIds.length
      ) {
        return jsonResponse(
          { success: false, error: "No book IDs provided" },
          400,
          corsOrigin,
        );
      }

      const validIds: number[] = [];
      for (const raw of body.bookIds) {
        const id = validateIntegerId(raw);
        if (!id) {
          return jsonResponse(
            { success: false, error: `Invalid book ID: ${raw}` },
            400,
            corsOrigin,
          );
        }
        validIds.push(id);
      }

      const books = getCalibreBooks();
      const titleMap = new Map<number, string>();
      for (const b of books) {
        if (b.id) titleMap.set(b.id, b.title);
      }

      const idsStr = validIds.map(String).join(",");
      const delRes = runCalibredb([
        "remove",
        idsStr,
        "--with-library",
        SERVER_URL,
      ]);

      getCalibreBooks(true);
      if (delRes.status === 0) {
        for (const id of validIds) {
          deleteHighlightsForBook(getCacheDb(), id, titleMap.get(id));
        }
        return jsonResponse(
          { success: true, message: `Removed ${validIds.length} books` },
          200,
          corsOrigin,
        );
      } else {
        return jsonResponse(
          {
            success: false,
            error: sanitizeErrorMessage(delRes.stderr || "Bulk delete failed"),
          },
          500,
          corsOrigin,
        );
      }
    } catch (err: any) {
      return jsonResponse(
        { success: false, error: sanitizeErrorMessage(err) },
        500,
        corsOrigin,
      );
    }
  }

  // API: Multi-Source Metadata Lookup
  if (url.pathname === "/api/metadata/lookup" && req.method === "POST") {
    try {
      const body = (await req.json()) as { query: string };
      const query = body.query;
      if (!query) return jsonResponse({ results: [] }, 200, corsOrigin);

      const isManga = req.url.includes("manga=true");
      const isLn =
        req.url.includes("ln=true") || req.url.includes("lightnovel=true");
      const results = await searchUniversalMetadata(query, {
        isManga: isManga ? true : undefined,
        isLightNovel: isLn ? true : undefined,
      });
      return jsonResponse({ results }, 200, corsOrigin);
    } catch (err: any) {
      return jsonResponse(
        { results: [], error: sanitizeErrorMessage(err) },
        200,
        corsOrigin,
      );
    }
  }

  // API: Update Metadata & Cover
  if (
    url.pathname.startsWith("/api/books/") &&
    url.pathname.endsWith("/metadata") &&
    req.method === "POST"
  ) {
    try {
      const parts = url.pathname.split("/");
      const bookId = validateIntegerId(parts[3]);
      if (!bookId) {
        return jsonResponse(
          { success: false, error: "Invalid book ID" },
          400,
          corsOrigin,
        );
      }

      const body = (await req.json()) as {
        title?: string;
        authors?: string;
        tags?: string;
        series?: string;
        seriesIndex?: string | number;
        comments?: string;
        rating?: number;
        coverUrl?: string;
      };

      const cleanTitle = cleanString(body.title || "");
      const cleanAuth = cleanString(body.authors || "");
      const cleanTags = (body.tags || "")
        .split(",")
        .map(cleanString)
        .filter((t) => t && !/http|t\.me|thebookr/i.test(t))
        .join(",");

      const args = [
        "set_metadata",
        String(bookId),
        "--with-library",
        SERVER_URL,
      ];
      if (cleanTitle) args.push("--field", `title:${cleanTitle}`);
      if (cleanAuth) args.push("--field", `authors:${cleanAuth}`);
      if (cleanTags !== undefined) args.push("--field", `tags:${cleanTags}`);
      if (body.series !== undefined)
        args.push("--field", `series:${cleanString(body.series)}`);
      if (body.seriesIndex !== undefined)
        args.push("--field", `series_index:${body.seriesIndex}`);
      if (body.comments !== undefined)
        args.push("--field", `comments:${body.comments}`);
      if (body.rating !== undefined)
        args.push("--field", `rating:${body.rating}`);

      let tempCover = "";
      if (body.coverUrl) {
        const coverUrl = body.coverUrl;
        const ssrfCheck = await validateUrlForSSRF(coverUrl, {
          allowProxyBypass: true,
        });
        if (!ssrfCheck.safe) {
          return jsonResponse(
            {
              success: false,
              error:
                ssrfCheck.error || "Unsafe cover URL rejected by SSRF guard",
            },
            400,
            corsOrigin,
          );
        }

        try {
          const cRes = await safeFetchWithSsrf(coverUrl);
          if (cRes.ok) {
            tempCover = `/tmp/cover_${bookId}_${Date.now()}.jpg`;
            fs.writeFileSync(tempCover, Buffer.from(await cRes.arrayBuffer()));
            args.push("--field", `cover:${tempCover}`);
          }
        } catch (e) {
          console.error("Cover download error:", e);
        }
      }

      const setRes = runCalibredb(args);
      if (tempCover && fs.existsSync(tempCover)) {
        try {
          fs.unlinkSync(tempCover);
        } catch (_cleanErr) {
          void _cleanErr;
        }
      }

      getCalibreBooks(true);
      if (setRes.status === 0) {
        return jsonResponse(
          { success: true, message: "Metadata sanitized & updated" },
          200,
          corsOrigin,
        );
      } else {
        return jsonResponse(
          {
            success: false,
            error: sanitizeErrorMessage(setRes.stderr || "Update failed"),
          },
          500,
          corsOrigin,
        );
      }
    } catch (err: any) {
      return jsonResponse(
        { success: false, error: sanitizeErrorMessage(err) },
        500,
        corsOrigin,
      );
    }
  }

  // API: Kindle USB Status & Live Progress
  if (url.pathname === "/api/kindle/status" && req.method === "GET") {
    try {
      const scopeParam = url.searchParams.get("scope");
      const scope: "unread" | "all" = scopeParam === "all" ? "all" : "unread";
      const status = getKindleStatus(undefined, scope);
      return jsonResponse(status, 200, corsOrigin);
    } catch (err: any) {
      return jsonResponse(
        { detected: false, error: sanitizeErrorMessage(err) },
        500,
        corsOrigin,
      );
    }
  }

  // API: Kindle Sync Preview
  if (url.pathname === "/api/kindle/preview" && req.method === "GET") {
    try {
      const scopeParam = url.searchParams.get("scope");
      const scope = scopeParam === "all" ? "all" : "unread";
      const forceAll = url.searchParams.get("forceAll") === "true";
      const preview = previewKindleSync(undefined, { scope, forceAll });
      return jsonResponse(preview, 200, corsOrigin);
    } catch (err: any) {
      return jsonResponse(
        { detected: false, error: sanitizeErrorMessage(err) },
        500,
        corsOrigin,
      );
    }
  }

  // API: Kindle Live Progress
  if (url.pathname === "/api/kindle/progress" && req.method === "GET") {
    try {
      const progress = getKindleProgress();
      const status = getKindleStatus();
      return jsonResponse({ progress, status }, 200, corsOrigin);
    } catch (err: any) {
      return jsonResponse(
        { progress: null, error: sanitizeErrorMessage(err) },
        500,
        corsOrigin,
      );
    }
  }

  // API: Kindle Bulk Sync
  if (url.pathname === "/api/kindle/sync" && req.method === "POST") {
    try {
      // 1. Synchronous Atomic Admit Gate
      if (!tryAcquireKindleSyncLock()) {
        return jsonResponse(
          {
            success: true,
            alreadyRunning: true,
            message: "Sync already in progress",
            results: { inProgress: true },
          },
          200,
          corsOrigin,
        );
      }

      let body: Record<string, unknown> = {};
      try {
        body = (await req.json()) as Record<string, unknown>;
      } catch {
        // Fall back to empty options if JSON body was omitted
      }
      let scope: "unread" | "all" = "unread";
      if (body?.scope === "all" || body?.forceAll) {
        scope = "all";
      }

      const forceAll = Boolean(body?.forceAll);
      const subfolderByAuthor = body?.subfolderByAuthor !== false;

      // 2. Upfront pre-flight check via previewKindleSync
      const preview = previewKindleSync(undefined, { scope, forceAll });
      if (!preview.detected) {
        releaseKindleSyncLock("error", "No Kindle device detected under /Volumes");
        return jsonResponse(
          {
            success: false,
            error: "No Kindle device detected under /Volumes",
            results: {
              success: false,
              mountPath: null,
              totalBooks: 0,
              alreadySynced: 0,
              transferred: 0,
              failed: 0,
              skipped: 0,
              bytesTransferred: 0,
              highlightsPulled: 0,
              errors: [{ bookId: 0, title: "None", error: "No Kindle device detected under /Volumes" }],
            },
          },
          500,
          corsOrigin,
        );
      }

      if (!preview.sufficientSpace && preview.pendingCount > 0) {
        const reqMb = (preview.requiredBytes / (1024 * 1024)).toFixed(1);
        const freeMb = (preview.freeBytes / (1024 * 1024)).toFixed(1);
        const errMsg = `Insufficient Kindle storage: requires ${reqMb} MB (including 50MB reserve), but only ${freeMb} MB available`;
        releaseKindleSyncLock("error", errMsg);
        return jsonResponse(
          {
            success: false,
            error: errMsg,
            results: {
              success: false,
              mountPath: preview.mountPath,
              totalBooks: preview.totalCandidates,
              alreadySynced: preview.alreadySyncedCount,
              transferred: 0,
              failed: preview.pendingCount,
              skipped: 0,
              bytesTransferred: 0,
              highlightsPulled: 0,
              errors: [{ bookId: 0, title: "Storage", error: errMsg }],
            },
          },
          507,
          corsOrigin,
        );
      }

      // Check if user requested cancellation during pre-flight
      if (isKindleSyncCancelled()) {
        releaseKindleSyncLock("cancelled");
        const cancelledResult = {
          success: false,
          cancelled: true,
          mountPath: preview.mountPath,
          booksDir: null,
          totalBooks: preview.totalCandidates,
          alreadySynced: preview.alreadySyncedCount,
          transferred: 0,
          failed: 0,
          skipped: 0,
          bytesTransferred: 0,
          highlightsPulled: 0,
          errors: [],
        };
        return jsonResponse(
          {
            success: true,
            cancelled: true,
            started: false,
            message: "Sync cancelled by user",
            results: cancelledResult,
          },
          200,
          corsOrigin,
        );
      }

      // 3. Kick off background transfer with lock already held
      syncAllBooksToKindle({
        forceAll,
        subfolderByAuthor,
        scope,
        lockAlreadyAcquired: true,
      }).catch((syncErr) => {
        console.error("[Kindle] Background sync exception:", syncErr);
      });

      return jsonResponse(
        {
          success: true,
          started: true,
          message: "Kindle sync started in background",
          results: {
            inProgress: true,
            started: true,
            totalBooks: preview.totalCandidates,
            alreadySynced: preview.alreadySyncedCount,
          },
        },
        200,
        corsOrigin,
      );
    } catch (err: any) {
      releaseKindleSyncLock();
      return jsonResponse(
        { success: false, error: sanitizeErrorMessage(err) },
        500,
        corsOrigin,
      );
    }
  }

  // API: Kindle Cancel Sync
  if (url.pathname === "/api/kindle/cancel" && req.method === "POST") {
    try {
      const cancelled = cancelKindleSync();
      return jsonResponse(
        {
          success: true,
          cancelled,
          message: "Sync cancellation requested",
        },
        200,
        corsOrigin,
      );
    } catch (err: any) {
      return jsonResponse(
        { success: false, error: sanitizeErrorMessage(err) },
        500,
        corsOrigin,
      );
    }
  }

  // API: Kindle Eject Device
  if (url.pathname === "/api/kindle/eject" && req.method === "POST") {
    try {
      const ejectRes = ejectKindleVolume();
      return jsonResponse(
        ejectRes,
        ejectRes.success ? 200 : 500,
        corsOrigin,
      );
    } catch (err: any) {
      return jsonResponse(
        { success: false, message: sanitizeErrorMessage(err) },
        500,
        corsOrigin,
      );
    }
  }

  // API: Single Book Send to Kindle
  if (
    url.pathname.startsWith("/api/books/") &&
    url.pathname.endsWith("/send-kindle") &&
    req.method === "POST"
  ) {
    try {
      const parts = url.pathname.split("/");
      const bookId = validateIntegerId(parts[3]);
      if (!bookId) {
        return jsonResponse(
          { success: false, error: "Invalid book ID" },
          400,
          corsOrigin,
        );
      }
      let body: Record<string, unknown> = {};
      try {
        body = (await req.json()) as Record<string, unknown>;
      } catch {
        // Fall back to empty options if JSON body was omitted
      }
      const res = await syncSingleBookToKindle(bookId, {
        forceAll: Boolean(body?.forceAll),
        subfolderByAuthor: body?.subfolderByAuthor !== false,
      });
      return jsonResponse(
        res,
        res.success ? 200 : 400,
        corsOrigin,
      );
    } catch (err: any) {
      return jsonResponse(
        { success: false, error: sanitizeErrorMessage(err) },
        500,
        corsOrigin,
      );
    }
  }

  // API: External SSD Backup Status
  if (url.pathname === "/api/backup/ssd/status" && req.method === "GET") {
    try {
      const status = getSsdBackupStatus();
      return jsonResponse(status, 200, corsOrigin);
    } catch (err: any) {
      return jsonResponse(
        { success: false, error: sanitizeErrorMessage(err) },
        500,
        corsOrigin,
      );
    }
  }

  // API: External SSD Backup Configuration & LaunchAgent Update
  if (url.pathname === "/api/backup/ssd/config" && req.method === "POST") {
    try {
      let body: Record<string, unknown> = {};
      try {
        body = (await req.json()) as Record<string, unknown>;
      } catch {
        return jsonResponse(
          { success: false, error: "Malformed JSON payload" },
          400,
          corsOrigin,
        );
      }

      const patch: Record<string, unknown> = {};
      if (typeof body.enabled === "boolean") patch.enabled = body.enabled;
      if (typeof body.scheduleTime === "string") {
        try {
          validateScheduleTime(body.scheduleTime);
          patch.scheduleTime = body.scheduleTime.trim();
        } catch (err: any) {
          return jsonResponse(
            { success: false, error: err?.message || "Invalid scheduleTime" },
            400,
            corsOrigin,
          );
        }
      }
      if (typeof body.targetMount === "string" && body.targetMount.trim().length > 0) {
        const valRes = validateTargetDirectory(body.targetMount);
        if (!valRes.valid) {
          return jsonResponse(
            { success: false, error: valRes.error },
            400,
            corsOrigin,
          );
        }
        patch.targetMount = valRes.resolvedPath;
      }

      const updatedConfig = saveSsdBackupConfig(patch);
      const launchAgentRes = updateLaunchAgentSchedule({
        scheduleTime: updatedConfig.scheduleTime,
        enabled: updatedConfig.enabled,
      });

      return jsonResponse(
        {
          success: true,
          config: updatedConfig,
          launchAgent: launchAgentRes,
        },
        200,
        corsOrigin,
      );
    } catch (err: any) {
      return jsonResponse(
        { success: false, error: sanitizeErrorMessage(err) },
        500,
        corsOrigin,
      );
    }
  }

  // API: Trigger External SSD Whole-Library Backup Immediately
  if (url.pathname === "/api/backup/ssd/run" && req.method === "POST") {
    try {
      let body: Record<string, unknown> = {};
      try {
        body = (await req.json()) as Record<string, unknown>;
      } catch {
        // Body is optional
      }

      let target: string | undefined = undefined;
      if (typeof body.target === "string" && body.target.trim().length > 0) {
        const valRes = validateTargetDirectory(body.target);
        if (!valRes.valid) {
          return jsonResponse(
            { success: false, error: valRes.error },
            400,
            corsOrigin,
          );
        }
        target = valRes.resolvedPath;
      }
      const dryRun = Boolean(body.dryRun);

      const result = await performSsdBackup({
        target,
        dryRun,
      });

      return jsonResponse(
        result,
        result.success ? 200 : result.skipped ? 200 : 500,
        corsOrigin,
      );
    } catch (err: any) {
      return jsonResponse(
        { success: false, error: sanitizeErrorMessage(err) },
        500,
        corsOrigin,
      );
    }
  }

  // Serve SPA HTML
  try {
    const html = fs.readFileSync(HTML_PATH, "utf8");
    return new Response(html, {
      headers: {
        "Content-Type": "text/html; charset=utf-8",
        "Cache-Control": "no-cache",
        "X-Content-Type-Options": "nosniff",
      },
    });
  } catch (_e) {
    void _e;
    return new Response("Reading HQ Web App", {
      headers: { "Content-Type": "text/plain" },
    });
  }
}

// Start Server & Background Job Queue Worker when run directly
if ((import.meta as any).main) {
  const listenPort = parseInt(
    process.env.UPLOADER_PORT || process.env.PORT || "8086",
    10,
  );
  jobQueue.startWorker(1000);
  (globalThis as any).Bun.serve({
    port: listenPort,
    hostname: "0.0.0.0",
    fetch(req: any, server: any) {
      return handleRequest(req, server);
    },
  });
  console.log(
    `[Server] Reading HQ Web Uploader listening on http://0.0.0.0:${listenPort}`,
  );
}
