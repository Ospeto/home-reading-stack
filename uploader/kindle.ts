import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import process from "node:process";
import crypto from "node:crypto";
import { Buffer } from "node:buffer";
import { spawnSync } from "node:child_process";
import { Database } from "bun:sqlite";
import { generateMetadataFilename, truncateUtf8Bytes } from "./filename";

export function getCalibreDbPath(): string {
  if (process.env.CALIBRE_DB_PATH) {
    return path.resolve(process.env.CALIBRE_DB_PATH);
  }
  return path.join(os.homedir(), "Calibre Library", "metadata.db");
}

export function getCalibreLibraryDir(): string {
  if (process.env.CALIBRE_LIBRARY_DIR) {
    return path.resolve(process.env.CALIBRE_LIBRARY_DIR);
  }
  if (process.env.CALIBRE_DB_PATH) return path.dirname(getCalibreDbPath());
  return path.join(os.homedir(), "Calibre Library");
}

export interface KindleLiveProgress {
  phase: "idle" | "scanning" | "transferring" | "highlights" | "completed" | "error";
  currentBookTitle?: string;
  currentIndex: number;
  totalCandidates: number;
  transferredCount: number;
  alreadySyncedCount: number;
  failedCount: number;
  skippedCount: number;
  bytesTransferred: number;
  percent: number; // 0 to 100
  highlightsPulledCount: number;
  booksDir?: string;
  error?: string;
}

export interface KindleStatus {
  detected: boolean;
  mountPath: string | null;
  volumeName: string | null;
  booksDir: string | null;
  freeBytes: number;
  totalBytes: number;
  booksOnDevice: number;
  libraryBooks: number;
  syncInProgress: boolean;
  progress?: KindleLiveProgress | null;
}

export interface KindleSyncOptions {
  mountPath?: string;
  forceAll?: boolean; // If true, overwrite existing files
  subfolderByAuthor?: boolean; // Default true: books/<Author>/<Filename>
  vaultPath?: string;
  onProgress?: (progress: KindleLiveProgress) => void;
}

export interface KindleSyncResult {
  success: boolean;
  mountPath: string | null;
  booksDir?: string | null;
  totalBooks: number;
  alreadySynced: number;
  transferred: number;
  failed: number;
  skipped: number;
  bytesTransferred: number;
  highlightsPulled: number;
  errors: Array<{ bookId: number; title: string; error: string }>;
  transferredBooks?: Array<{ bookId: number; title: string; filename: string; bytes: number }>;
}

export interface SingleBookSyncResult {
  success: boolean;
  bookId: number;
  title: string;
  destinationPath?: string;
  bytesTransferred?: number;
  alreadySynced?: boolean;
  error?: string;
}

export interface KindleFileCandidate {
  bookId: number;
  title: string;
  authors: string;
  series?: string | null;
  seriesIndex?: number | string | null;
  sourceFilePath: string;
  fileSize: number;
  format: string;
  targetFilename: string;
}

// 50 MB safety margin for FAT32 / filesystem metadata overhead
export const SAFETY_BUFFER_BYTES = 50 * 1024 * 1024;

// Standard Kindle book extensions in priority order
export const KINDLE_FORMAT_PREFERENCE = ["EPUB", "AZW3", "KFX", "MOBI", "PDF"];

// In-process lock and live progress state
let activeKindleLock: "sync" | null = null;
let activeKindleProgress: KindleLiveProgress | null = null;

export function isKindleLocked(): boolean {
  return activeKindleLock !== null;
}

export function getKindleProgress(): KindleLiveProgress | null {
  return activeKindleProgress;
}

const FAT32_ILLEGAL_REGEX = /[<>:"/\\|?*\x00-\x1F\x7F]+/g;

/**
 * Sanitize filename strictly for FAT32/VFAT filesystems:
 * - Illegal characters: / \ : * ? " < > |
 * - Normalizes colons to ' - ' for title-subtitle separation
 * - Strips leading / trailing dots and spaces (invalid on FAT32)
 * - Length limit (FAT32 limit 255 chars, keep base within 180 for path safety)
 * - Uses UTF-8 byte truncation to never break multi-byte characters or surrogate pairs
 */
export function sanitizeFat32Filename(name: string): string {
  if (!name) return "document.epub";
  let s = name.normalize("NFC");
  const ext = path.extname(s);
  let base = path.basename(s, ext);

  // Normalize colons to clean " - " separators
  base = base.replace(/:+/g, " - ");
  // Replace directory separators
  base = base.replace(/[/\\]+/g, "-");
  // Replace all other FAT32 illegal characters
  base = base.replace(FAT32_ILLEGAL_REGEX, "_");
  // Collapse whitespace and multiple hyphens
  base = base.replace(/\s+/g, " ");
  base = base.replace(/\s*[-–—]\s*/g, " - ");
  base = base.replace(/(?: - )+/g, " - ");
  // Strip leading/trailing dots, spaces, dashes (invalid on FAT32)
  base = base.replace(/^[\s.\-–—]+|[\s.\-–—]+$/g, "").trim();
  if (!base) base = "document";

  // Bound length while preserving extension safely with truncateUtf8Bytes
  // FAT32 total filename max is 255 bytes; keep total length within 180 bytes for safety margin
  const extBytes = Buffer.byteLength(ext, "utf8");
  const maxBaseBytes = Math.max(1, 180 - extBytes);
  const boundedBase = truncateUtf8Bytes(base, maxBaseBytes);
  const finalBase = boundedBase.replace(/[\s.]+$/, "").trim() || "document";

  return `${finalBase}${ext}`;
}

/**
 * Resolves the primary books directory on a Kindle mount.
 * Preference:
 *   1. `<mountPath>/books` if it exists
 *   2. `<mountPath>/documents` if it exists
 *   3. If neither exists, creates and returns `<mountPath>/books` (when autoCreate is true)
 */
export function resolveKindleBooksDir(mountPath: string, autoCreate = true): string {
  const booksPath = path.join(mountPath, "books");
  const docsPath = path.join(mountPath, "documents");

  if (fs.existsSync(booksPath)) {
    return booksPath;
  }
  if (fs.existsSync(docsPath)) {
    return docsPath;
  }
  if (autoCreate) {
    try {
      fs.mkdirSync(booksPath, { recursive: true });
    } catch {
      // Ignore directory creation errors
    }
  }
  return booksPath;
}

/**
 * Returns candidate book directories to search for existing files or highlights.
 */
export function getKindleBookDirs(mountPath: string): string[] {
  const dirs: string[] = [];
  const booksPath = path.join(mountPath, "books");
  const docsPath = path.join(mountPath, "documents");

  if (fs.existsSync(booksPath)) dirs.push(booksPath);
  if (fs.existsSync(docsPath)) dirs.push(docsPath);

  if (dirs.length === 0) {
    dirs.push(booksPath);
  }
  return dirs;
}

/**
 * Detect a mounted Kindle volume.
 * Looks for:
 * 1. Volumes named Kindle or KINDLE (or starting with Kindle / Kobo / KOReader) having books/ or documents/
 * 2. Any volume under /Volumes/* containing books/ or documents/ AND Kindle markers (system/ directory or name match)
 */
export function detectKindleVolume(customVolumesDir = "/Volumes"): string | null {
  try {
    if (!fs.existsSync(customVolumesDir)) return null;

    const entries = fs.readdirSync(customVolumesDir, { withFileTypes: true });

    // First pass: volume name matches Kindle/KINDLE or known names
    for (const ent of entries) {
      if ((ent.isDirectory() || ent.isSymbolicLink()) && !ent.name.startsWith(".")) {
        if (/^kindle/i.test(ent.name) || /kobo|koreader/i.test(ent.name)) {
          const candidate = path.join(customVolumesDir, ent.name);
          const booksPath = path.join(candidate, "books");
          const docsPath = path.join(candidate, "documents");
          if (fs.existsSync(booksPath) || fs.existsSync(docsPath)) {
            return candidate;
          }
        }
      }
    }

    // Second pass: any other volume containing books or documents directory and Kindle system markers
    for (const ent of entries) {
      if ((ent.isDirectory() || ent.isSymbolicLink()) && !ent.name.startsWith(".")) {
        const candidate = path.join(customVolumesDir, ent.name);
        try {
          const booksPath = path.join(candidate, "books");
          const docsPath = path.join(candidate, "documents");
          const systemPath = path.join(candidate, "system");
          const hasBooks = fs.existsSync(booksPath) && fs.statSync(booksPath).isDirectory();
          const hasDocs = fs.existsSync(docsPath) && fs.statSync(docsPath).isDirectory();
          if ((hasBooks || hasDocs) && (fs.existsSync(systemPath) || ent.name.toLowerCase().includes("kindle"))) {
            return candidate;
          }
        } catch {
          // Skip unreadable mounts
        }
      }
    }
  } catch {
    // Fail-open returning null
  }
  return null;
}

/**
 * Query filesystem storage statistics (free and total bytes) via statfs / df -k
 */
export function getKindleDiskSpace(mountPath: string): { freeBytes: number; totalBytes: number; freeMb: number } {
  try {
    if (!fs.existsSync(mountPath)) {
      return { freeBytes: 0, totalBytes: 0, freeMb: 0 };
    }

    // Method 1: fs.statfsSync if supported by Bun / Node
    // SAFETY: Node.js 19.6+ and Bun provide fs.statfsSync which may not be present in standard ambient Node definitions
    const fsAny = fs as unknown as { statfsSync?: (p: string) => { bsize: number; bavail: number; bfree: number; blocks: number } };
    if (typeof fsAny.statfsSync === "function") {
      try {
        const stats = fsAny.statfsSync(mountPath);
        const bsize = Number(stats.bsize || 4096);
        const freeBytes = Number(stats.bavail || stats.bfree || 0) * bsize;
        const totalBytes = Number(stats.blocks || 0) * bsize;
        if (totalBytes > 0) {
          return { freeBytes, totalBytes, freeMb: Math.round(freeBytes / (1024 * 1024)) };
        }
      } catch {
        // Fall back to df -k
      }
    }

    // Method 2: df -k using spawnSync
    const dfRes = spawnSync("df", ["-k", mountPath], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
      timeout: 5000,
    });
    if (dfRes.status === 0 && dfRes.stdout) {
      const lines = dfRes.stdout.trim().split("\n");
      if (lines.length >= 2) {
        const tokens = lines[1].trim().split(/\s+/);
        if (tokens.length >= 4) {
          const total1024 = parseInt(tokens[1], 10);
          const avail1024 = parseInt(tokens[3], 10);
          if (!Number.isNaN(total1024) && !Number.isNaN(avail1024)) {
            const freeBytes = avail1024 * 1024;
            return {
              totalBytes: total1024 * 1024,
              freeBytes,
              freeMb: Math.round(freeBytes / (1024 * 1024)),
            };
          }
        }
      }
    }
  } catch {
    // Return zeroes on error
  }
  return { freeBytes: 0, totalBytes: 0, freeMb: 0 };
}

/**
 * Checks whether a book is already present on the Kindle in either books/ or documents/.
 * Checks both author subfolder (`<dir>/<author>/<filename>`) and flat (`<dir>/<filename>`).
 */
export function isBookAlreadyOnKindle(
  mountPath: string,
  targetFilename: string,
  authorDir = "",
  fileSize = 0,
): { exists: boolean; existingPath?: string } {
  const searchDirs = [path.join(mountPath, "books"), path.join(mountPath, "documents")];

  for (const baseDir of searchDirs) {
    if (!fs.existsSync(baseDir)) continue;

    // Check author subfolder if provided
    if (authorDir) {
      const subPath = path.join(baseDir, authorDir, targetFilename);
      if (fs.existsSync(subPath)) {
        try {
          const st = fs.statSync(subPath);
          if (fileSize <= 0 || st.size === fileSize) {
            return { exists: true, existingPath: subPath };
          }
        } catch {}
      }
    }

    // Check flat in baseDir
    const flatPath = path.join(baseDir, targetFilename);
    if (fs.existsSync(flatPath)) {
      try {
        const st = fs.statSync(flatPath);
        if (fileSize <= 0 || st.size === fileSize) {
          return { exists: true, existingPath: flatPath };
        }
      } catch {}
    }
  }

  return { exists: false };
}

/**
 * Recursively count book files present across Kindle books/ and documents/ directories.
 */
export function countKindleBooks(mountPath: string): number {
  const validExts = new Set([".epub", ".azw3", ".kfx", ".mobi", ".pdf", ".txt", ".azw", ".prc"]);
  const foundBookKeys = new Set<string>();

  function walk(dir: string, depth = 0) {
    if (depth > 6 || !fs.existsSync(dir)) return;
    try {
      const entries = fs.readdirSync(dir, { withFileTypes: true });
      for (const ent of entries) {
        if (ent.name.startsWith(".")) continue;
        const full = path.join(dir, ent.name);
        if (ent.isDirectory()) {
          // Skip system directories like .sdr
          if (!ent.name.endsWith(".sdr")) {
            walk(full, depth + 1);
          }
        } else if (ent.isFile()) {
          const ext = path.extname(ent.name).toLowerCase();
          if (validExts.has(ext)) {
            foundBookKeys.add(ent.name.toLowerCase());
          }
        }
      }
    } catch {
      // Ignore unreadable dirs
    }
  }

  walk(path.join(mountPath, "books"));
  walk(path.join(mountPath, "documents"));
  return foundBookKeys.size;
}

/**
 * Backward compatibility alias for countKindleBooks.
 */
export function countKindleDocuments(mountPath: string): number {
  return countKindleBooks(mountPath);
}

/**
 * Recursively discovers all KOReader .sdr directories inside a folder.
 */
export function findKindleSdrDirs(rootDir: string): string[] {
  const sdrDirs: string[] = [];
  if (!fs.existsSync(rootDir)) return sdrDirs;

  function walk(currentDir: string, depth = 0) {
    if (depth > 6) return;
    try {
      const entries = fs.readdirSync(currentDir, { withFileTypes: true });
      for (const entry of entries) {
        if (!entry.isDirectory()) continue;
        const fullPath = path.join(currentDir, entry.name);
        if (entry.name.endsWith(".sdr")) {
          sdrDirs.push(fullPath);
        } else if (!entry.name.startsWith(".")) {
          walk(fullPath, depth + 1);
        }
      }
    } catch {
      // Ignore directory read errors
    }
  }

  walk(rootDir);
  return sdrDirs;
}

/**
 * Searches for Kindle "My Clippings.txt" inside books, documents, root, or system.
 */
export function findKindleClippings(mountPath: string): string | null {
  const candidates = [
    path.join(mountPath, "books", "My Clippings.txt"),
    path.join(mountPath, "documents", "My Clippings.txt"),
    path.join(mountPath, "My Clippings.txt"),
    path.join(mountPath, "system", "My Clippings.txt"),
  ];
  for (const c of candidates) {
    if (fs.existsSync(c)) return c;
  }
  return null;
}

/**
 * Return current status of USB Kindle device.
 */
export function getKindleStatus(customVolumesDir = "/Volumes"): KindleStatus {
  const mountPath = detectKindleVolume(customVolumesDir);
  let freeBytes = 0;
  let totalBytes = 0;
  let booksOnDevice = 0;
  let volumeName: string | null = null;
  let booksDir: string | null = null;

  if (mountPath) {
    volumeName = path.basename(mountPath);
    const space = getKindleDiskSpace(mountPath);
    freeBytes = space.freeBytes;
    totalBytes = space.totalBytes;
    booksDir = resolveKindleBooksDir(mountPath, false);
    booksOnDevice = countKindleBooks(mountPath);
  } else {
    // If device is no longer mounted, clear active live progress
    activeKindleProgress = null;
  }

  let libraryBooks = 0;
  try {
    const dbPath = getCalibreDbPath();
    if (fs.existsSync(dbPath)) {
      const db = new Database(dbPath, { readonly: true });
      try {
        const row = db.query(`
          SELECT COUNT(DISTINCT book) as cnt
          FROM data
          WHERE UPPER(format) IN ('EPUB', 'AZW3', 'KFX', 'MOBI', 'PDF')
        `).get() as { cnt: number } | null;
        libraryBooks = row?.cnt ?? 0;
      } finally {
        db.close();
      }
    }
  } catch {
    libraryBooks = 0;
  }

  return {
    detected: Boolean(mountPath),
    mountPath,
    volumeName,
    booksDir,
    freeBytes,
    totalBytes,
    booksOnDevice,
    libraryBooks,
    syncInProgress: activeKindleLock !== null,
    progress: activeKindleProgress,
  };
}

/**
 * Resolve book file path and details from Calibre library.
 * Prioritizes EPUB first, then AZW3, KFX, MOBI, PDF.
 * Explicitly guards library path containment to prevent path traversal.
 */
export function resolveCalibreBookFile(bookId: number, dbInstance?: Database): KindleFileCandidate | null {
  const dbPath = getCalibreDbPath();
  const libDir = getCalibreLibraryDir();

  if (!fs.existsSync(dbPath)) return null;

  const shouldClose = !dbInstance;
  const db = dbInstance || new Database(dbPath, { readonly: true });

  try {
    if (shouldClose) {
      db.run("PRAGMA busy_timeout = 3000;");
    }

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
      WHERE b.id = ?
      GROUP BY d.id
    `)
      .all(bookId) as Array<{
        id: number;
        title: string | null;
        path: string;
        series_index: number | null;
        authors: string | null;
        series: string | null;
        format: string;
        filename: string;
        uncompressed_size: number;
      }>;

    if (!rows || rows.length === 0) return null;

    // Filter strictly to supported formats
    const supportedRows = rows.filter((r) => KINDLE_FORMAT_PREFERENCE.includes(String(r.format || "").toUpperCase()));
    if (supportedRows.length === 0) return null;

    // Sort by format preference
    supportedRows.sort((a, b) => {
      const idxA = KINDLE_FORMAT_PREFERENCE.indexOf(String(a.format || "").toUpperCase());
      const idxB = KINDLE_FORMAT_PREFERENCE.indexOf(String(b.format || "").toUpperCase());
      return idxA - idxB;
    });

    const title = supportedRows[0].title || "Book";
    const authors = supportedRows[0].authors || "Unknown";
    const series = supportedRows[0].series || null;
    const seriesIndex = supportedRows[0].series_index || null;
    const bookRelPath = supportedRows[0].path;

    // Verify Calibre path containment inside library directory
    const resolvedLibDir = path.resolve(libDir);
    const basePath = path.resolve(libDir, bookRelPath);
    if (!basePath.startsWith(resolvedLibDir + path.sep) && basePath !== resolvedLibDir) {
      console.warn(`[Kindle] Security: Book #${bookId} path escapes library directory: ${bookRelPath}`);
      return null;
    }

    for (const row of supportedRows) {
      const fmt = String(row.format || "").toUpperCase();
      const filename = row.filename;
      const candidate1 = path.join(basePath, `${filename}.${fmt.toLowerCase()}`);
      const candidate2 = path.join(basePath, `${filename}.${fmt.toUpperCase()}`);

      let resolvedPath: string | null = null;
      let statSize = 0;

      if (fs.existsSync(candidate1)) {
        resolvedPath = candidate1;
        statSize = fs.statSync(candidate1).size;
      } else if (fs.existsSync(candidate2)) {
        resolvedPath = candidate2;
        statSize = fs.statSync(candidate2).size;
      } else if (fs.existsSync(basePath)) {
        const files = fs.readdirSync(basePath);
        const extLower = `.${fmt.toLowerCase()}`;
        const matched = files.find((f: string) => f.toLowerCase().endsWith(extLower));
        if (matched) {
          const p = path.join(basePath, matched);
          resolvedPath = p;
          statSize = fs.statSync(p).size;
        }
      }

      if (resolvedPath) {
        const generatedName = generateMetadataFilename({
          title,
          authors,
          series,
          seriesIndex,
          format: fmt,
        });
        const targetFilename = sanitizeFat32Filename(generatedName);

        return {
          bookId,
          title,
          authors,
          series,
          seriesIndex,
          sourceFilePath: resolvedPath,
          fileSize: statSize,
          format: fmt,
          targetFilename,
        };
      }
    }
  } catch (err) {
    console.error(`[Kindle] Error resolving book ${bookId}:`, err);
  } finally {
    if (shouldClose) {
      db.close();
    }
  }
  return null;
}

/**
 * Retrieve all candidates for Kindle bulk sync from Calibre metadata.db.
 * Reuses a single open database connection to eliminate N+1 reopen churn.
 */
export function getAllKindleCandidates(): KindleFileCandidate[] {
  const dbPath = getCalibreDbPath();
  if (!fs.existsSync(dbPath)) return [];

  const candidates: KindleFileCandidate[] = [];
  try {
    const db = new Database(dbPath, { readonly: true });
    try {
      db.run("PRAGMA busy_timeout = 3000;");
      const rows = db.query("SELECT DISTINCT id FROM books ORDER BY id DESC").all() as Array<{ id: number }>;
      for (const r of rows) {
        const candidate = resolveCalibreBookFile(r.id, db);
        if (candidate) {
          candidates.push(candidate);
        }
      }
    } finally {
      db.close();
    }
  } catch (err) {
    console.error("[Kindle] Error retrieving candidates:", err);
  }
  return candidates;
}

/**
 * Safely copy a file to Kindle with temporary file and atomic rename.
 */
export function safeCopyFileToKindle(srcPath: string, destPath: string): void {
  const destDir = path.dirname(destPath);
  if (!fs.existsSync(destDir)) {
    fs.mkdirSync(destDir, { recursive: true });
  }

  const nonce = crypto.randomBytes(6).toString("hex");
  const tmpPath = `${destPath}.tmp.${Date.now()}.${nonce}`;
  try {
    fs.copyFileSync(srcPath, tmpPath);
    fs.renameSync(tmpPath, destPath);
  } catch (err) {
    try {
      if (fs.existsSync(tmpPath)) {
        fs.unlinkSync(tmpPath);
      }
    } catch {
      // Ignore unlink errors on failed temp
    }
    throw err;
  }
}

/**
 * Synchronize a single book to the connected Kindle.
 */
export function syncSingleBookToKindle(
  bookId: number,
  options: KindleSyncOptions = {},
): SingleBookSyncResult {
  if (activeKindleLock) {
    return {
      success: false,
      bookId,
      title: "Unknown",
      error: "Kindle synchronization is currently in progress. Please wait for it to finish.",
    };
  }

  const mountPath = options.mountPath || detectKindleVolume();
  if (!mountPath || !fs.existsSync(mountPath)) {
    return {
      success: false,
      bookId,
      title: "Unknown",
      error: "No Kindle device detected under /Volumes",
    };
  }

  const resolvedMount = path.resolve(mountPath);
  const targetBooksRoot = resolveKindleBooksDir(resolvedMount, true);

  const candidate = resolveCalibreBookFile(bookId);
  if (!candidate) {
    return {
      success: false,
      bookId,
      title: "Unknown",
      error: `Book #${bookId} not found or has no supported format on disk`,
    };
  }

  const subfolder = options.subfolderByAuthor !== false;
  const authorDir = subfolder ? sanitizeFat32Filename(candidate.authors || "Unknown") : "";
  const destPath = path.resolve(targetBooksRoot, authorDir, candidate.targetFilename);

  // Assert destination path containment
  if (!destPath.startsWith(targetBooksRoot + path.sep) && destPath !== targetBooksRoot) {
    return {
      success: false,
      bookId,
      title: candidate.title,
      error: "Security: Target path escapes Kindle books directory",
    };
  }

  // Check if already synced across books/ or documents/
  if (!options.forceAll) {
    const existing = isBookAlreadyOnKindle(resolvedMount, candidate.targetFilename, authorDir, candidate.fileSize);
    if (existing.exists) {
      return {
        success: true,
        bookId,
        title: candidate.title,
        destinationPath: existing.existingPath || destPath,
        alreadySynced: true,
        bytesTransferred: 0,
      };
    }
  }

  // Check disk capacity
  const space = getKindleDiskSpace(resolvedMount);
  if (space.freeBytes < candidate.fileSize + SAFETY_BUFFER_BYTES) {
    return {
      success: false,
      bookId,
      title: candidate.title,
      error: `Insufficient disk space on Kindle. Free: ${(space.freeBytes / 1024 / 1024).toFixed(1)}MB, Required: ${((candidate.fileSize + SAFETY_BUFFER_BYTES) / 1024 / 1024).toFixed(1)}MB`,
    };
  }

  activeKindleLock = "sync";
  try {
    safeCopyFileToKindle(candidate.sourceFilePath, destPath);
    return {
      success: true,
      bookId,
      title: candidate.title,
      destinationPath: destPath,
      bytesTransferred: candidate.fileSize,
      alreadySynced: false,
    };
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    return {
      success: false,
      bookId,
      title: candidate.title,
      error: `Transfer failed: ${message}`,
    };
  } finally {
    activeKindleLock = null;
  }
}

/**
 * Dynamic loader for highlight pulling from scripts/sync-kindle
 */
let pullHighlightsFromKindleFn: any = null;
async function getPullHighlightsFn() {
  if (pullHighlightsFromKindleFn) return pullHighlightsFromKindleFn;
  try {
    const mod = await import("../scripts/sync-kindle");
    pullHighlightsFromKindleFn = mod.pullHighlightsFromKindle;
  } catch {
    const altPath = "./scripts/sync-kindle";
    try {
      const mod = await import(altPath);
      pullHighlightsFromKindleFn = mod.pullHighlightsFromKindle;
    } catch {
      pullHighlightsFromKindleFn = null;
    }
  }
  return pullHighlightsFromKindleFn;
}

/**
 * Bulk synchronize all Calibre library books to the connected Kindle.
 * Supports live progress tracking and highlight syncing to Obsidian MAS vault & cache.db.
 */
export async function syncAllBooksToKindle(options: KindleSyncOptions = {}): Promise<KindleSyncResult> {
  if (activeKindleLock) {
    return {
      success: false,
      mountPath: null,
      booksDir: null,
      totalBooks: 0,
      alreadySynced: 0,
      transferred: 0,
      failed: 1,
      skipped: 0,
      bytesTransferred: 0,
      highlightsPulled: 0,
      errors: [{ bookId: 0, title: "Lock", error: "Kindle synchronization is currently in progress" }],
    };
  }

  const mountPath = options.mountPath || detectKindleVolume();
  if (!mountPath || !fs.existsSync(mountPath)) {
    return {
      success: false,
      mountPath: mountPath || null,
      booksDir: null,
      totalBooks: 0,
      alreadySynced: 0,
      transferred: 0,
      failed: 0,
      skipped: 0,
      bytesTransferred: 0,
      highlightsPulled: 0,
      errors: [{ bookId: 0, title: "None", error: "No Kindle device detected under /Volumes" }],
    };
  }

  const resolvedMount = path.resolve(mountPath);
  const targetBooksRoot = resolveKindleBooksDir(resolvedMount, true);

  activeKindleLock = "sync";
  activeKindleProgress = {
    phase: "scanning",
    currentIndex: 0,
    totalCandidates: 0,
    transferredCount: 0,
    alreadySyncedCount: 0,
    failedCount: 0,
    skippedCount: 0,
    bytesTransferred: 0,
    percent: 5,
    highlightsPulledCount: 0,
    booksDir: targetBooksRoot,
  };
  options.onProgress?.(activeKindleProgress);

  try {
    const candidates = getAllKindleCandidates();
    const subfolder = options.subfolderByAuthor !== false;

    let alreadySynced = 0;
    let transferred = 0;
    let failed = 0;
    let skipped = 0;
    let bytesTransferred = 0;
    const errors: Array<{ bookId: number; title: string; error: string }> = [];
    const transferredBooks: Array<{ bookId: number; title: string; filename: string; bytes: number }> = [];

    const space = getKindleDiskSpace(resolvedMount);

    activeKindleProgress.totalCandidates = candidates.length;
    activeKindleProgress.phase = "transferring";

    for (let i = 0; i < candidates.length; i++) {
      const candidate = candidates[i];
      const authorDir = subfolder ? sanitizeFat32Filename(candidate.authors || "Unknown") : "";
      const targetDir = authorDir ? path.resolve(targetBooksRoot, authorDir) : targetBooksRoot;
      const destPath = path.resolve(targetDir, candidate.targetFilename);

      // Assert path containment
      if (!destPath.startsWith(targetBooksRoot + path.sep) && destPath !== targetBooksRoot) {
        errors.push({
          bookId: candidate.bookId,
          title: candidate.title,
          error: "Security: Target path escapes Kindle books directory",
        });
        failed++;
        continue;
      }

      // Update live progress
      const currentPercent = candidates.length > 0 ? Math.min(85, Math.round(((i + 1) / candidates.length) * 85)) : 85;
      activeKindleProgress = {
        phase: "transferring",
        currentBookTitle: candidate.title,
        currentIndex: i + 1,
        totalCandidates: candidates.length,
        transferredCount: transferred,
        alreadySyncedCount: alreadySynced,
        failedCount: failed,
        skippedCount: skipped,
        bytesTransferred,
        percent: currentPercent,
        highlightsPulledCount: 0,
        booksDir: targetBooksRoot,
      };
      options.onProgress?.(activeKindleProgress);

      // Check if already present on Kindle in books/ or documents/
      let existsAndMatches = false;
      if (!options.forceAll) {
        const existing = isBookAlreadyOnKindle(resolvedMount, candidate.targetFilename, authorDir, candidate.fileSize);
        if (existing.exists) {
          existsAndMatches = true;
        }
      }

      if (existsAndMatches) {
        alreadySynced++;
        activeKindleProgress.alreadySyncedCount = alreadySynced;
        continue;
      }

      // Check space
      if (space.freeBytes < candidate.fileSize + SAFETY_BUFFER_BYTES) {
        skipped++;
        activeKindleProgress.skippedCount = skipped;
        errors.push({
          bookId: candidate.bookId,
          title: candidate.title,
          error: "Skipped due to low disk space on Kindle",
        });
        continue;
      }

      try {
        safeCopyFileToKindle(candidate.sourceFilePath, destPath);
        transferred++;
        bytesTransferred += candidate.fileSize;
        space.freeBytes -= candidate.fileSize;

        activeKindleProgress.transferredCount = transferred;
        activeKindleProgress.bytesTransferred = bytesTransferred;

        transferredBooks.push({
          bookId: candidate.bookId,
          title: candidate.title,
          filename: candidate.targetFilename,
          bytes: candidate.fileSize,
        });

        // Yield tick to allow concurrent HTTP polling requests to be handled
        await new Promise((r) => setTimeout(r, 0));
      } catch (err: unknown) {
        failed++;
        activeKindleProgress.failedCount = failed;
        const message = err instanceof Error ? err.message : String(err);
        errors.push({
          bookId: candidate.bookId,
          title: candidate.title,
          error: message,
        });
      }
    }

    // Direction 2: Pull Highlights from both books/ and documents/
    let highlightsPulled = 0;
    try {
      activeKindleProgress = {
        ...activeKindleProgress,
        phase: "highlights",
        currentBookTitle: "Syncing highlights to Obsidian MAS vault...",
        percent: 90,
      };
      options.onProgress?.(activeKindleProgress);

      const pullFn = await getPullHighlightsFn();
      if (pullFn) {
        const hlRes = await pullFn(
          { apply: true, vaultPath: options.vaultPath },
          {
            mountPath: resolvedMount,
            booksDir: targetBooksRoot,
            documentsDir: targetBooksRoot,
            candidateDirs: [path.join(resolvedMount, "books"), path.join(resolvedMount, "documents")],
            name: path.basename(resolvedMount),
            freeBytes: space.freeBytes,
            totalBytes: space.totalBytes,
          },
          getCalibreDbPath(),
          new Map(),
        );
        highlightsPulled = hlRes?.totalImported ?? 0;
      }
    } catch (hlErr) {
      console.warn("[Kindle] Notice: Highlight pull step completed with notice:", hlErr);
    }

    activeKindleProgress = {
      phase: "completed",
      currentIndex: candidates.length,
      totalCandidates: candidates.length,
      transferredCount: transferred,
      alreadySyncedCount: alreadySynced,
      failedCount: failed,
      skippedCount: skipped,
      bytesTransferred,
      percent: 100,
      highlightsPulledCount: highlightsPulled,
      booksDir: targetBooksRoot,
    };
    options.onProgress?.(activeKindleProgress);

    return {
      success: failed === 0,
      mountPath: resolvedMount,
      booksDir: targetBooksRoot,
      totalBooks: candidates.length,
      alreadySynced,
      transferred,
      failed,
      skipped,
      bytesTransferred,
      highlightsPulled,
      errors,
      transferredBooks,
    };
  } finally {
    activeKindleLock = null;
  }
}

/**
 * Safely unmount/eject the Kindle volume via macOS diskutil.
 * Refuses ejection while an active transfer lock is held or if path escapes /Volumes.
 */
export function ejectKindleVolume(mountPath?: string): { success: boolean; message: string } {
  if (activeKindleLock) {
    return {
      success: false,
      message: "Cannot eject: Kindle synchronization is currently in progress",
    };
  }

  const target = mountPath || detectKindleVolume();
  if (!target || !fs.existsSync(target)) {
    return { success: false, message: "No mounted Kindle volume found to eject" };
  }

  const resolvedTarget = path.resolve(target);
  const volumesRoot = path.resolve("/Volumes");

  // Security guard: require mount path to resolve strictly inside /Volumes (or explicit test fixture mount)
  const isInsideVolumes =
    resolvedTarget.startsWith(volumesRoot + path.sep) && resolvedTarget !== volumesRoot;
  const isExplicitTestAllowed =
    Boolean(process.env.LIGHTHOUSE_TEST_ALLOW_EJECT_PATH) &&
    resolvedTarget.startsWith(path.resolve(process.env.LIGHTHOUSE_TEST_ALLOW_EJECT_PATH));

  if (!isInsideVolumes && !isExplicitTestAllowed) {
    return {
      success: false,
      message: `Security: Target path '${resolvedTarget}' escapes /Volumes/ directory`,
    };
  }

  try {
    const res = spawnSync("diskutil", ["eject", resolvedTarget], {
      encoding: "utf8",
      timeout: 10000,
    });
    if (res.status === 0) {
      return { success: true, message: `Successfully ejected ${resolvedTarget}` };
    }
    return {
      success: false,
      message: res.stderr ? res.stderr.trim() : `diskutil exited with status ${res.status}`,
    };
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    return {
      success: false,
      message: `Eject command failed: ${message}`,
    };
  }
}
