import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import process from "node:process";
import crypto from "node:crypto";
import { Buffer } from "node:buffer";
import { spawnSync } from "node:child_process";
import { Database } from "bun:sqlite";
import { generateMetadataFilename, truncateUtf8Bytes } from "./filename";
import {
  normalizeTitleForDedup,
  cleanQuery,
  extractVolumeNumber,
  cleanSeriesTitle,
  stringSimilarity,
  classifyDuplicateWithJev,
} from "./scraper";

export const LIGHTHOUSE_ROOT =
  process.env.LIGHTHOUSE_ROOT ||
  path.resolve((import.meta as { dir?: string }).dir || process.cwd(), "..");

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

export interface KindleLiveProgress {
  phase: "idle" | "scanning" | "transferring" | "highlights" | "completed" | "cancelled" | "error";
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

export interface KindleSyncPreview {
  detected: boolean;
  mountPath: string | null;
  freeBytes: number;
  totalBytes: number;
  totalCandidates: number;
  alreadySyncedCount: number;
  pendingCount: number;
  pendingBytes: number;
  sufficientSpace: boolean;
  requiredBytes: number;
  shortfallBytes: number;
  scope: "unread" | "all";
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
  preview?: KindleSyncPreview | null;
}

export interface KindleSyncOptions {
  mountPath?: string;
  forceAll?: boolean; // If true, overwrite existing files
  subfolderByAuthor?: boolean; // Default true: books/<Author>/<Filename>
  scope?: "unread" | "all"; // Scope: "unread" (active & unread) or "all" (entire library)
  vaultPath?: string;
  onProgress?: (progress: KindleLiveProgress) => void;
}

export interface KindleSyncResult {
  success: boolean;
  cancelled?: boolean;
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

// Valid book file extensions found on Kindle devices
export const KINDLE_BOOK_EXTENSIONS = new Set([
  ".epub",
  ".azw3",
  ".kfx",
  ".mobi",
  ".pdf",
  ".txt",
  ".azw",
  ".prc",
]);

// In-process lock, live progress, and cancellation state
let activeKindleLock: "sync" | null = null;
let activeKindleProgress: KindleLiveProgress | null = null;
let cancelRequested = false;

export function isKindleLocked(): boolean {
  return activeKindleLock !== null;
}

export function getKindleProgress(): KindleLiveProgress | null {
  return activeKindleProgress;
}

export function cancelKindleSync(): boolean {
  if (activeKindleLock === null) {
    return false;
  }
  cancelRequested = true;
  return true;
}

export function isKindleSyncCancelled(): boolean {
  return cancelRequested;
}

export interface KindleIndexedBook {
  filePath: string;
  filename: string;
  ext: string;
  baseName: string;
  strippedBaseName?: string;
  size: number;
  normalizedTitle: string;
  strippedNormalizedTitle?: string;
  cleanQueryTitle: string;
  strippedCleanQueryTitle?: string;
  volumeNumber: number | null;
  leadingIndex?: number | null;
  parentDir: string;
  grandparentDir: string;
}

export interface KindleBookIndex {
  mountPath: string;
  entries: KindleIndexedBook[];
  byFilename: Map<string, KindleIndexedBook[]>;
  byBaseName: Map<string, KindleIndexedBook[]>;
  byNormalizedTitle: Map<string, KindleIndexedBook[]>;
  byCleanQuery: Map<string, KindleIndexedBook[]>;
  bySize: Map<number, KindleIndexedBook[]>;
}

export interface BookMatchOptions {
  title?: string;
  authors?: string;
  series?: string | null;
  seriesIndex?: number | string | null;
}

function appendToMultiMap<K, V>(map: Map<K, V[]>, key: K, val: V) {
  let list = map.get(key);
  if (!list) {
    list = [];
    map.set(key, list);
  }
  list.push(val);
}

/**
 * Strips leading index and volume prefixes from a filename base:
 * - "01 - The Eminence in Shadow" -> "The Eminence in Shadow"
 * - "Vol. 1 - Overlord" -> "Overlord"
 * - Keeps year-like titles intact (e.g. "1984 - George Orwell")
 */
export function stripLeadingIndexPrefix(baseName: string): string {
  if (!baseName) return "";
  const volStripped =
    baseName.replace(/^vol(ume)?\.?\s*\d+\s*[-–—._]\s*/i, "").trim() || baseName;

  const m = baseName.match(/^(\d+(?:\.\d+)?)\s*[-–—._]\s*/);
  if (!m) return volStripped;

  const num = Number.parseFloat(m[1]);
  // Keep year-like titles intact (e.g. "1984 - George Orwell")
  if (!Number.isNaN(num) && num >= 1900 && num <= 2100) {
    return volStripped === baseName ? baseName : volStripped;
  }

  const digitStripped = baseName.replace(/^\d+\s*[-–—._]\s*/, "").trim();
  return (
    digitStripped
      .replace(/^vol(ume)?\.?\s*\d+\s*[-–—._]\s*/i, "")
      .replace(/^\d+\s*[-–—._]\s*/, "")
      .trim() || baseName
  );
}

export function createKindleBookEntry(filePath: string, size?: number): KindleIndexedBook {
  const ext = path.extname(filePath).toLowerCase();
  const filename = path.basename(filePath);
  const baseName = path.basename(filePath, ext).toLowerCase().trim();
  const strippedBaseName = stripLeadingIndexPrefix(baseName);
  const normalizedTitle = normalizeTitleForDedup(baseName);
  const strippedNormalizedTitle = normalizeTitleForDedup(strippedBaseName);
  const cleanQueryTitle = cleanQuery(baseName).toLowerCase().trim();
  const strippedCleanQueryTitle = cleanQuery(strippedBaseName).toLowerCase().trim();
  const volumeNumber = extractVolumeNumber(filename) ?? extractVolumeNumber(baseName);

  const leadingIndexMatch = baseName.match(/^(?:vol(?:ume)?\.?\s*)?0*(\d+(?:\.\d+)?)\s*[-–—._]\s*/i);
  let leadingIndex: number | null = null;
  if (leadingIndexMatch) {
    const num = parseFloat(leadingIndexMatch[1]);
    if (!isNaN(num) && (num < 1900 || num > 2100)) {
      leadingIndex = num;
    }
  }

  const parentDir = path.basename(path.dirname(filePath)).toLowerCase().trim();
  const grandparentDir = path.basename(path.dirname(path.dirname(filePath))).toLowerCase().trim();

  let statSize = size ?? 0;
  if (statSize <= 0) {
    try {
      statSize = fs.statSync(filePath).size;
    } catch {
      statSize = 0;
    }
  }

  return {
    filePath,
    filename,
    ext,
    baseName,
    strippedBaseName,
    size: statSize,
    normalizedTitle,
    strippedNormalizedTitle,
    cleanQueryTitle,
    strippedCleanQueryTitle,
    volumeNumber,
    leadingIndex,
    parentDir,
    grandparentDir,
  };
}

export function addFileToKindleIndex(index: KindleBookIndex, filePath: string, size?: number): void {
  const item = createKindleBookEntry(filePath, size);
  index.entries.push(item);
  appendToMultiMap(index.byFilename, item.filename.toLowerCase(), item);
  if (item.baseName) appendToMultiMap(index.byBaseName, item.baseName, item);
  if (item.strippedBaseName && item.strippedBaseName !== item.baseName) {
    appendToMultiMap(index.byBaseName, item.strippedBaseName, item);
  }
  if (item.normalizedTitle) appendToMultiMap(index.byNormalizedTitle, item.normalizedTitle, item);
  if (
    item.strippedNormalizedTitle &&
    item.strippedNormalizedTitle !== item.normalizedTitle
  ) {
    appendToMultiMap(index.byNormalizedTitle, item.strippedNormalizedTitle, item);
  }
  // Only add cleanQueryTitle to index when there is no volume number to prevent cross-volume collisions
  if (
    item.cleanQueryTitle &&
    item.cleanQueryTitle !== item.normalizedTitle &&
    item.volumeNumber === null
  ) {
    appendToMultiMap(index.byCleanQuery, item.cleanQueryTitle, item);
  }
  if (
    item.strippedCleanQueryTitle &&
    item.strippedCleanQueryTitle !== item.cleanQueryTitle &&
    item.strippedCleanQueryTitle !== item.strippedNormalizedTitle &&
    item.volumeNumber === null
  ) {
    appendToMultiMap(index.byCleanQuery, item.strippedCleanQueryTitle, item);
  }
  if (item.size > 0) appendToMultiMap(index.bySize, item.size, item);
}

/**
 * Builds a comprehensive recursive index of all books present on the Kindle
 * across both books/ and documents/ (and all nested subfolders).
 */
export function buildKindleBookIndex(mountPath: string): KindleBookIndex {
  const index: KindleBookIndex = {
    mountPath,
    entries: [],
    byFilename: new Map(),
    byBaseName: new Map(),
    byNormalizedTitle: new Map(),
    byCleanQuery: new Map(),
    bySize: new Map(),
  };

  const searchDirs = getKindleBookDirs(mountPath);
  const seenPaths = new Set<string>();

  function walk(currentDir: string, depth = 0) {
    if (depth > 8 || !fs.existsSync(currentDir)) return;
    try {
      const dirEntries = fs.readdirSync(currentDir, { withFileTypes: true });
      for (const ent of dirEntries) {
        if (ent.name.startsWith(".")) continue;
        const full = path.join(currentDir, ent.name);
        if (ent.isDirectory()) {
          // Skip .sdr sidecar folders and system directories
          if (!ent.name.endsWith(".sdr") && ent.name !== "system") {
            walk(full, depth + 1);
          }
        } else if (ent.isFile()) {
          const ext = path.extname(ent.name).toLowerCase();
          if (KINDLE_BOOK_EXTENSIONS.has(ext)) {
            if (seenPaths.has(full)) continue;
            seenPaths.add(full);
            addFileToKindleIndex(index, full);
          }
        }
      }
    } catch {
      // Ignore unreadable dirs
    }
  }

  for (const d of searchDirs) {
    walk(d);
  }

  return index;
}

// In-memory cache for KindleBookIndex with 30s TTL
let cachedIndexMount: string | null = null;
let cachedIndexTime = 0;
let cachedIndex: KindleBookIndex | null = null;

export function getOrCreateKindleBookIndex(mountPath: string, forceRefresh = false): KindleBookIndex {
  const now = Date.now();
  if (
    !forceRefresh &&
    cachedIndex &&
    cachedIndexMount === mountPath &&
    now - cachedIndexTime < 30000
  ) {
    return cachedIndex;
  }

  const idx = buildKindleBookIndex(mountPath);
  cachedIndex = idx;
  cachedIndexMount = mountPath;
  cachedIndexTime = now;
  return idx;
}

export function invalidateKindleBookIndex(): void {
  cachedIndex = null;
  cachedIndexMount = null;
  cachedIndexTime = 0;
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
 * Normalizes author strings by ensuring consistent comma spacing:
 * "Author,Artist" -> "Author, Artist"
 * "Author , Artist" -> "Author, Artist"
 */
export function normalizeAuthorSpacing(author: string): string {
  if (!author) return "";
  return author.replace(/\s*,\s*/g, ", ").trim();
}

export interface KindleDestinationResolution {
  authorDir: string;
  seriesDir?: string;
  targetDir: string;
  relativeDir: string;
  reusedExistingFolder: boolean;
}

/**
 * Resolves the destination directory for a book on Kindle:
 * 1. If subfolderByAuthor is true, normalizes author comma spacing.
 * 2. Scans targetBooksRoot for existing directories. If an existing directory matches
 *    the normalized author (e.g. 'Fuse, Mitz Vah' vs 'Fuse,Mitz Vah'), reuses that folder.
 * 3. If book belongs to a series and a series subfolder exists inside the author folder,
 *    places the book inside that existing series folder.
 */
export function resolveKindleDestinationDir(
  targetBooksRoot: string,
  rawAuthor: string,
  series?: string | null,
  subfolderByAuthor = true,
): KindleDestinationResolution {
  if (!subfolderByAuthor) {
    return {
      authorDir: "",
      targetDir: targetBooksRoot,
      relativeDir: "",
      reusedExistingFolder: false,
    };
  }

  const normAuthor = normalizeAuthorSpacing(rawAuthor || "Unknown");
  const sanitizedDefaultAuthor = sanitizeFat32Filename(normAuthor);
  let matchedAuthorDir = sanitizedDefaultAuthor;
  let reusedAuthorFolder = false;

  if (fs.existsSync(targetBooksRoot)) {
    try {
      const entries = fs.readdirSync(targetBooksRoot, { withFileTypes: true });
      for (const ent of entries) {
        if (!ent.isDirectory() || ent.name.startsWith(".")) continue;
        const existingDirName = ent.name;

        // Comma-spacing normalized comparison
        const normExisting = normalizeAuthorSpacing(existingDirName).toLowerCase();
        const normTarget = normAuthor.toLowerCase();
        if (normExisting === normTarget) {
          matchedAuthorDir = existingDirName;
          reusedAuthorFolder = true;
          break;
        }

        // Punctuation-stripped dedup comparison
        const dedupExisting = normalizeTitleForDedup(existingDirName);
        const dedupTarget = normalizeTitleForDedup(normAuthor);
        if (dedupExisting && dedupTarget && dedupExisting === dedupTarget) {
          matchedAuthorDir = existingDirName;
          reusedAuthorFolder = true;
          break;
        }
      }
    } catch {
      // Ignore directory scan errors
    }
  }

  const authorFullPath = path.resolve(targetBooksRoot, matchedAuthorDir);

  // Check if series subfolder exists inside the author folder
  if (series && fs.existsSync(authorFullPath)) {
    const cleanSeries = cleanSeriesTitle(series) || series.trim();
    const normSeries = normalizeTitleForDedup(cleanSeries);
    try {
      const authorEntries = fs.readdirSync(authorFullPath, { withFileTypes: true });
      for (const ent of authorEntries) {
        if (!ent.isDirectory() || ent.name.startsWith(".")) continue;
        const subDirName = ent.name;
        const normSub = normalizeTitleForDedup(cleanSeriesTitle(subDirName) || subDirName);
        if (normSub && normSeries && normSub === normSeries) {
          return {
            authorDir: matchedAuthorDir,
            seriesDir: subDirName,
            targetDir: path.resolve(authorFullPath, subDirName),
            relativeDir: path.join(matchedAuthorDir, subDirName),
            reusedExistingFolder: true,
          };
        }
      }
    } catch {
      // Ignore subfolder scan errors
    }
  }

  return {
    authorDir: matchedAuthorDir,
    targetDir: authorFullPath,
    relativeDir: matchedAuthorDir,
    reusedExistingFolder: reusedAuthorFolder,
  };
}

/**
 * Recursively cleans any macOS resource fork '._*' ghost files from directory.
 */
export function cleanDotFilesFallback(targetDir: string): number {
  let cleanedCount = 0;
  if (!fs.existsSync(targetDir)) return cleanedCount;

  function walk(currentDir: string, depth = 0) {
    if (depth > 10) return;
    try {
      const entries = fs.readdirSync(currentDir, { withFileTypes: true });
      for (const ent of entries) {
        const full = path.join(currentDir, ent.name);
        if (ent.isDirectory()) {
          walk(full, depth + 1);
        } else if (ent.isFile() && ent.name.startsWith("._")) {
          try {
            fs.unlinkSync(full);
            cleanedCount++;
          } catch {}
        }
      }
    } catch {}
  }

  walk(targetDir);
  return cleanedCount;
}

/**
 * Resolves the path to the macOS dot_clean binary.
 * Checks /usr/sbin/dot_clean, /usr/bin/dot_clean, then falls back to "dot_clean".
 */
export function resolveDotCleanPath(): string {
  if (process.env.LIGHTHOUSE_DOT_CLEAN_BIN) {
    return process.env.LIGHTHOUSE_DOT_CLEAN_BIN;
  }
  if (fs.existsSync("/usr/sbin/dot_clean")) {
    return "/usr/sbin/dot_clean";
  }
  if (fs.existsSync("/usr/bin/dot_clean")) {
    return "/usr/bin/dot_clean";
  }
  return "dot_clean";
}

/**
 * Executes macOS dot_clean -m on the target books directory to merge/delete
 * ._* resource fork ghost files, preventing clutter on FAT32 Kindle storage.
 */
export function runDotClean(targetDir: string): { success: boolean; error?: string } {
  if (!targetDir || !fs.existsSync(targetDir)) {
    return { success: false, error: "Target directory does not exist" };
  }

  // Always run fallback unlinker first to guarantee zero ghost files
  cleanDotFilesFallback(targetDir);

  if (process.platform === "darwin") {
    try {
      const bin = resolveDotCleanPath();
      spawnSync(bin, ["-m", targetDir], {
        encoding: "utf8",
        timeout: 15000,
        stdio: ["ignore", "pipe", "pipe"],
      });
      return { success: true };
    } catch {
      return { success: true };
    }
  }

  return { success: true };
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
export function detectKindleVolume(customVolumesDir?: string): string | null {
  const targetDir = customVolumesDir || process.env.LIGHTHOUSE_VOLUMES_DIR || "/Volumes";
  try {
    if (!fs.existsSync(targetDir)) return null;

    const entries = fs.readdirSync(targetDir, { withFileTypes: true });

    // First pass: volume name matches Kindle/KINDLE or known names
    for (const ent of entries) {
      if ((ent.isDirectory() || ent.isSymbolicLink()) && !ent.name.startsWith(".")) {
        if (/^kindle/i.test(ent.name) || /kobo|koreader/i.test(ent.name)) {
          const candidate = path.join(targetDir, ent.name);
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
        const candidate = path.join(targetDir, ent.name);
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
  if (process.env.TEST_KINDLE_FREE_BYTES !== undefined) {
    const free = Number(process.env.TEST_KINDLE_FREE_BYTES);
    return { freeBytes: free, totalBytes: Math.max(free * 2, 1024 * 1024), freeMb: Math.round(free / (1024 * 1024)) };
  }

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
 * Checks whether a book is already present on the Kindle across all directories and filename variants.
 * Checks pre-scanned index when available or queries the cached/scanned index.
 * Matches by exact path, exact filename, base filename (format-insensitive), normalized title,
 * clean query, compound/inverted title-author, token sets, and file sizes.
 */
export function isBookAlreadyOnKindle(
  mountPath: string,
  targetFilename: string,
  authorDir = "",
  fileSize = 0,
  index?: KindleBookIndex | null,
  bookDetails?: BookMatchOptions,
): { exists: boolean; existingPath?: string; matchedBy?: string } {
  const targetExt = path.extname(targetFilename).toLowerCase();
  const targetBase = path.basename(targetFilename, targetExt).toLowerCase().trim();
  const targetNameLower = targetFilename.toLowerCase().trim();

  // 1. Direct path check for exact destination (author subfolder or flat)
  const searchDirs = [path.join(mountPath, "books"), path.join(mountPath, "documents")];
  for (const baseDir of searchDirs) {
    if (!fs.existsSync(baseDir)) continue;

    if (authorDir) {
      const subPath = path.join(baseDir, authorDir, targetFilename);
      if (fs.existsSync(subPath)) {
        try {
          const st = fs.statSync(subPath);
          if (fileSize <= 0 || st.size === fileSize || Math.abs(st.size - fileSize) <= 4096) {
            return { exists: true, existingPath: subPath, matchedBy: "direct_author_path" };
          }
        } catch {}
      }

      // Check resolved destination directory (scanning existing author/series folders)
      const resolved = resolveKindleDestinationDir(baseDir, authorDir, bookDetails?.series);
      if (resolved.targetDir !== path.join(baseDir, authorDir)) {
        const resSubPath = path.join(resolved.targetDir, targetFilename);
        if (fs.existsSync(resSubPath)) {
          try {
            const st = fs.statSync(resSubPath);
            if (fileSize <= 0 || st.size === fileSize || Math.abs(st.size - fileSize) <= 4096) {
              return { exists: true, existingPath: resSubPath, matchedBy: "direct_author_path" };
            }
          } catch {}
        }
      }
    }

    const flatPath = path.join(baseDir, targetFilename);
    if (fs.existsSync(flatPath)) {
      try {
        const st = fs.statSync(flatPath);
        if (fileSize <= 0 || st.size === fileSize || Math.abs(st.size - fileSize) <= 4096) {
          return { exists: true, existingPath: flatPath, matchedBy: "direct_flat_path" };
        }
      } catch {}
    }
  }

  // 2. Query recursive index across all Kindle subdirectories
  const idx = index || getOrCreateKindleBookIndex(mountPath);

  let rawTitle = bookDetails?.title || "";
  let rawAuthor = bookDetails?.authors || authorDir || "";

  if (!rawTitle && targetBase.includes(" - ")) {
    const parts = targetBase.split(" - ");
    rawTitle = parts[0].trim();
    if (!rawAuthor && parts.length > 1) {
      rawAuthor = parts[1].trim();
    }
  } else if (!rawTitle) {
    rawTitle = targetBase;
  }

  const candVol =
    extractVolumeNumber(rawTitle) ??
    (bookDetails?.series && bookDetails?.seriesIndex !== null && bookDetails?.seriesIndex !== undefined
      ? Number(bookDetails.seriesIndex)
      : null) ??
    extractVolumeNumber(targetBase);

  const normTitle = normalizeTitleForDedup(rawTitle);
  const cleanTitle = cleanQuery(rawTitle).toLowerCase().trim();
  const strippedCandidateTitle = cleanSeriesTitle(rawTitle);
  const normStrippedCandidate = strippedCandidateTitle ? normalizeTitleForDedup(strippedCandidateTitle) : "";
  const cleanStrippedCandidate = strippedCandidateTitle ? cleanQuery(strippedCandidateTitle).toLowerCase().trim() : "";

  const normalizedRawAuthor = normalizeAuthorSpacing(rawAuthor);
  const normAuthor = normalizedRawAuthor ? normalizeTitleForDedup(normalizedRawAuthor) : "";
  const cleanAuthor = normalizedRawAuthor ? cleanQuery(normalizedRawAuthor).toLowerCase().trim() : "";

  function authorMatchesString(sourceStr: string, targetAuthor: string): boolean {
    if (!sourceStr || !targetAuthor) return false;
    const sNorm = normalizeTitleForDedup(sourceStr);
    const tNorm = normalizeTitleForDedup(targetAuthor);
    if (!sNorm || !tNorm) return false;
    if (sNorm === tNorm) return true;

    const sTokens = sNorm.split(/\s+/);
    const tTokens = tNorm.split(/\s+/);

    if (tTokens.length >= 2) {
      if (sNorm.includes(tNorm)) return true;
      const allTokensPresent = tTokens.every((tok) => sTokens.includes(tok));
      if (allTokensPresent) return true;
    } else if (tTokens.length === 1) {
      if (sTokens.includes(tTokens[0])) return true;
    }
    return false;
  }

  function hasPositiveAuthorMatch(entry: KindleIndexedBook): boolean {
    if (!normAuthor && !cleanAuthor) return false;
    const pLower = entry.filePath.toLowerCase();

    if (authorMatchesString(entry.parentDir, normalizedRawAuthor)) return true;
    if (authorMatchesString(entry.grandparentDir, normalizedRawAuthor)) return true;

    const authorCheckBase = entry.strippedBaseName || entry.baseName;
    if (authorCheckBase.includes(" - ")) {
      const parts = authorCheckBase.split(" - ");
      if (parts.length > 1 && parts[1].trim()) {
        const entryAuthor = parts[1].trim();
        if (authorMatchesString(entryAuthor, normalizedRawAuthor)) return true;
      }
    }

    if (normAuthor && normAuthor.split(/\s+/).length >= 2 && pLower.includes(normAuthor)) {
      return true;
    }
    return false;
  }

  function isLikelyAuthorFolderName(folderName: string): boolean {
    if (!folderName) return false;
    const lower = folderName.trim().toLowerCase();
    if (/^(books|documents|downloads?|system|calibre|koreader)$/i.test(lower)) return false;
    if (/\b(series|trilogy|chronicles?|novels?|collection|anthology|fantasy|sci-fi|science\s*fiction|manga|comics?|universe|saga|cycle|archives?|books?|season)\b/i.test(lower)) {
      return false;
    }
    if (lower.includes(",")) return true;
    const words = lower.split(/\s+/);
    if (words.length >= 2 && words.every((w) => w.length >= 1)) return true;
    return false;
  }

  function authorMatchesEntry(entry: KindleIndexedBook, options: { strict?: boolean } = {}): boolean {
    if (!normAuthor && !cleanAuthor) return true;
    if (hasPositiveAuthorMatch(entry)) return true;

    // For stripped-index/base matches, require positive author match when candidate author is specified
    if (options.strict) {
      return false;
    }

    // Check if entry has a hyphenated author in its filename that differs from candidate author
    const authorCheckBase = entry.strippedBaseName || entry.baseName;
    const parts = authorCheckBase.split(" - ");
    if (parts.length > 1 && parts[1].trim()) {
      const entryAuthor = parts[1].trim();
      if (!authorMatchesString(entryAuthor, normalizedRawAuthor)) {
        return false;
      }
    }

    // If entry is in an author folder, verify it matches candidate author or series
    if (isLikelyAuthorFolderName(entry.parentDir)) {
      const candidateSeries = bookDetails?.series ? normalizeTitleForDedup(bookDetails.series) : "";
      const isSeries = candidateSeries && (normalizeTitleForDedup(entry.parentDir) === candidateSeries || normalizeTitleForDedup(entry.parentDir).includes(candidateSeries));
      if (!isSeries && !authorMatchesString(entry.parentDir, normalizedRawAuthor) && !authorMatchesString(entry.grandparentDir, normalizedRawAuthor)) {
        return false;
      }
    }

    // Allow match if title is distinct and volume is verified compatible
    return normTitle.length >= 5;
  }

  function volumesCompatible(entry: KindleIndexedBook): boolean {
    const entryVol = entry.volumeNumber ?? entry.leadingIndex ?? null;
    if (candVol !== null && entryVol !== null) {
      return candVol === entryVol;
    }
    if (candVol !== null && entryVol === null) {
      // Candidate is an explicit volume; entry has no volume notation or leading index -> not compatible
      return false;
    }
    if (candVol === null && entryVol !== null) {
      // If entry has explicit volumeNumber (e.g. "Overlord Vol 1"), unnumbered candidate does not match
      if (entry.volumeNumber !== null) return false;
      // If entry only had a leading file index (e.g. "01 - Title.epub"), allow match for unnumbered candidate
      return true;
    }
    return true;
  }

  // Strategy A: Exact filename match anywhere on device
  const byName = idx.byFilename.get(targetNameLower);
  if (byName && byName.length > 0) {
    for (const entry of byName) {
      if (volumesCompatible(entry)) {
        return { exists: true, existingPath: entry.filePath, matchedBy: "exact_filename" };
      }
    }
  }

  // Strategy B: Exact base filename match (format-insensitive: .epub vs .azw3 vs .mobi)
  if (targetBase) {
    const byBase = idx.byBaseName.get(targetBase);
    if (byBase && byBase.length > 0) {
      for (const entry of byBase) {
        const isStrippedMatch = entry.strippedBaseName === targetBase && entry.baseName !== targetBase;
        const entryVol = entry.volumeNumber ?? entry.leadingIndex ?? null;
        const hasMatchingVolume = candVol !== null && entryVol !== null && candVol === entryVol;
        const requireStrict = isStrippedMatch && !hasMatchingVolume;
        if (requireStrict && !authorMatchesEntry(entry, { strict: true })) {
          continue;
        }
        if (!requireStrict && !authorMatchesEntry(entry)) {
          continue;
        }
        if (volumesCompatible(entry)) {
          return { exists: true, existingPath: entry.filePath, matchedBy: "base_filename" };
        }
      }
    }
  }

  // Strategy C: Normalized title & clean query matching across nested subdirectories
  const normTitlesToCheck = [normTitle];
  if (normStrippedCandidate && normStrippedCandidate !== normTitle) {
    normTitlesToCheck.push(normStrippedCandidate);
  }

  for (const t of normTitlesToCheck) {
    if (!t) continue;
    const byNorm = idx.byNormalizedTitle.get(t);
    if (byNorm && byNorm.length > 0) {
      for (const entry of byNorm) {
        const isStripped = entry.strippedNormalizedTitle === t && entry.normalizedTitle !== t;
        const entryVol = entry.volumeNumber ?? entry.leadingIndex ?? null;
        const hasMatchingVolume = candVol !== null && entryVol !== null && candVol === entryVol;
        const requireStrict = isStripped && !hasMatchingVolume;
        const matchesAuthor = requireStrict
          ? authorMatchesEntry(entry, { strict: true })
          : authorMatchesEntry(entry);
        if (matchesAuthor && volumesCompatible(entry)) {
          return { exists: true, existingPath: entry.filePath, matchedBy: "normalized_title" };
        }
      }
    }
  }

  // Only check cleanTitle if the candidate has no volume notation
  const cleanQueriesToCheck: string[] = [];
  if (candVol === null && cleanTitle && cleanTitle !== normTitle) {
    cleanQueriesToCheck.push(cleanTitle);
  }
  if (
    candVol === null &&
    cleanStrippedCandidate &&
    cleanStrippedCandidate !== normTitle &&
    !cleanQueriesToCheck.includes(cleanStrippedCandidate)
  ) {
    cleanQueriesToCheck.push(cleanStrippedCandidate);
  }

  for (const cq of cleanQueriesToCheck) {
    const byClean = idx.byCleanQuery.get(cq);
    if (byClean && byClean.length > 0) {
      for (const entry of byClean) {
        const isStripped = entry.strippedCleanQueryTitle === cq && entry.cleanQueryTitle !== cq;
        const entryVol = entry.volumeNumber ?? entry.leadingIndex ?? null;
        const hasMatchingVolume = candVol !== null && entryVol !== null && candVol === entryVol;
        const requireStrict = isStripped && !hasMatchingVolume;
        const matchesAuthor = requireStrict
          ? authorMatchesEntry(entry, { strict: true })
          : authorMatchesEntry(entry);
        if (matchesAuthor && volumesCompatible(entry)) {
          return { exists: true, existingPath: entry.filePath, matchedBy: "clean_title" };
        }
      }
    }
  }

  // Strategy D: Compound Title + Author normalized
  if (normTitle && normAuthor) {
    const compound = normalizeTitleForDedup(`${rawTitle} ${normalizedRawAuthor}`);
    const byCompound = idx.byNormalizedTitle.get(compound);
    if (byCompound && byCompound.length > 0) {
      for (const entry of byCompound) {
        if (volumesCompatible(entry)) {
          return { exists: true, existingPath: entry.filePath, matchedBy: "compound_title_author" };
        }
      }
    }

    // Strategy E: Inverted Author + Title (e.g. "Brandon Sanderson - The Final Empire")
    const inverted = normalizeTitleForDedup(`${normalizedRawAuthor} ${rawTitle}`);
    const byInverted = idx.byNormalizedTitle.get(inverted);
    if (byInverted && byInverted.length > 0) {
      for (const entry of byInverted) {
        if (volumesCompatible(entry)) {
          return { exists: true, existingPath: entry.filePath, matchedBy: "inverted_author_title" };
        }
      }
    }
  }

  // Strategy F: Token set matching for multi-word titles
  const titleTokens = normTitle
    .split(/\s+/)
    .filter((w) => w.length >= 3 && !/^(vol|volume|book|part)$/.test(w));
  if (titleTokens.length >= 2) {
    for (const entry of idx.entries) {
      if (!volumesCompatible(entry)) continue;
      const baseForTokens = entry.strippedBaseName || entry.baseName;
      // If filename has "Title - Author", only match title tokens against the title portion
      const titlePortion = baseForTokens.includes(" - ")
        ? baseForTokens.split(" - ")[0]
        : baseForTokens;
      const allTokensMatch = titleTokens.every((tok) => titlePortion.includes(tok));
      if (allTokensMatch && authorMatchesEntry(entry)) {
        return { exists: true, existingPath: entry.filePath, matchedBy: "token_set" };
      }
    }
  }

  // Strategy G: Exact size match + strong token verification
  if (fileSize > 0) {
    const bySizeEntries = idx.bySize.get(fileSize);
    if (bySizeEntries && bySizeEntries.length > 0) {
      const checkWords = (normTitle + " " + normAuthor)
        .split(/\s+/)
        .filter((w) => w.length >= 4 && !/^(book|read|epub|mobi|file|part|vol|volume)$/.test(w));
      // Must have at least one strong word to match on file size
      if (checkWords.length > 0) {
        for (const entry of bySizeEntries) {
          if (!volumesCompatible(entry)) continue;
          const pathLower = entry.filePath.toLowerCase();
          if (checkWords.some((w) => pathLower.includes(w))) {
            return { exists: true, existingPath: entry.filePath, matchedBy: "filesize_and_token" };
          }
        }
      }
    }
  }

  return { exists: false };
}

/**
 * Two-tier Kindle duplicate detection:
 * - Tier 1: Fast Deterministic (<5ms, handles 99% of books)
 * - Tier 2: Jev System-1 Ambiguity Arbitration:
 *     When a book does not match in Tier 1, but has a partial title similarity
 *     (between 0.65 and 0.88) with an existing book in the same author folder:
 *     Calls classifyDuplicateWithJev using TYPESAFE_API_KEY / JEV_API_KEY.
 *     If Jev returns duplicate with high confidence (>= 0.7), treats it as already on device.
 *     Fails open gracefully if Jev is unreachable or offline.
 */
export async function isBookAlreadyOnKindleAsync(
  mountPath: string,
  targetFilename: string,
  authorDir = "",
  fileSize = 0,
  index?: KindleBookIndex | null,
  bookDetails?: BookMatchOptions,
  options?: { jevApiKey?: string; timeoutMs?: number },
): Promise<{ exists: boolean; existingPath?: string; matchedBy?: string }> {
  // Tier 1: Fast Deterministic (<5ms)
  const tier1 = isBookAlreadyOnKindle(
    mountPath,
    targetFilename,
    authorDir,
    fileSize,
    index,
    bookDetails,
  );
  if (tier1.exists) {
    return tier1;
  }

  // Tier 2: Jev System-1 Ambiguity Arbitration
  const idx = index || getOrCreateKindleBookIndex(mountPath);
  let rawTitle = bookDetails?.title || "";
  let rawAuthor = bookDetails?.authors || authorDir || "";

  if (!rawTitle) {
    const targetExt = path.extname(targetFilename).toLowerCase();
    const targetBase = path.basename(targetFilename, targetExt).toLowerCase().trim();
    if (targetBase.includes(" - ")) {
      const parts = targetBase.split(" - ");
      rawTitle = parts[0].trim();
      if (!rawAuthor && parts.length > 1) {
        rawAuthor = parts[1].trim();
      }
    } else {
      rawTitle = targetBase;
    }
  }

  const normalizedRawAuthor = normalizeAuthorSpacing(rawAuthor);
  const normAuthor = normalizedRawAuthor ? normalizeTitleForDedup(normalizedRawAuthor) : "";
  const normCandTitle = normalizeTitleForDedup(rawTitle);

  if (!normCandTitle) return { exists: false };

  const candVol =
    extractVolumeNumber(rawTitle) ??
    (bookDetails?.series && bookDetails?.seriesIndex !== null && bookDetails?.seriesIndex !== undefined
      ? Number(bookDetails.seriesIndex)
      : null);

  let jevCallsMade = 0;
  const MAX_JEV_CALLS_PER_BOOK = 3;

  for (const entry of idx.entries) {
    if (jevCallsMade >= MAX_JEV_CALLS_PER_BOOK) break;
    // Check author match
    const parentDedup = normalizeTitleForDedup(entry.parentDir);
    const grandparentDedup = normalizeTitleForDedup(entry.grandparentDir);
    const pLower = entry.filePath.toLowerCase();
    const parentSpaced = normalizeAuthorSpacing(entry.parentDir).toLowerCase();
    const grandparentSpaced = normalizeAuthorSpacing(entry.grandparentDir).toLowerCase();
    const spacedAuthorLower = normalizedRawAuthor.toLowerCase();

    const authorMatches =
      !normAuthor ||
      parentDedup.includes(normAuthor) ||
      grandparentDedup.includes(normAuthor) ||
      parentSpaced.includes(spacedAuthorLower) ||
      grandparentSpaced.includes(spacedAuthorLower) ||
      pLower.includes(normAuthor) ||
      pLower.includes(spacedAuthorLower);

    if (!authorMatches) continue;

    // Check volume compatibility: distinct volumes are never duplicates
    const entryVol = entry.volumeNumber ?? entry.leadingIndex ?? null;
    if (candVol !== null && entryVol !== null && candVol !== entryVol) {
      continue;
    }

    const normEntryTitle = entry.normalizedTitle || normalizeTitleForDedup(entry.baseName);
    const normEntryStripped = entry.strippedNormalizedTitle || "";

    const sim1 = stringSimilarity(normCandTitle, normEntryTitle);
    const sim2 = normEntryStripped ? stringSimilarity(normCandTitle, normEntryStripped) : 0;
    const maxSim = Math.max(sim1, sim2);

    if (maxSim >= 0.65 && maxSim < 0.88) {
      jevCallsMade++;
      try {
        const jevVerdict = await classifyDuplicateWithJev(
          {
            title: rawTitle,
            authors: normalizedRawAuthor,
            series: bookDetails?.series || undefined,
            series_index: candVol !== null ? candVol : undefined,
          },
          {
            title: entry.strippedBaseName || entry.baseName,
            authors: normalizedRawAuthor,
            series: (bookDetails?.series || undefined) as any,
            series_index: (entryVol !== null ? entryVol : undefined) as any,
          },
          {
            apiKey: options?.jevApiKey,
            timeoutMs: options?.timeoutMs,
          },
        );

        if (jevVerdict && jevVerdict.isDuplicate && jevVerdict.confidence >= 0.7) {
          return {
            exists: true,
            existingPath: entry.filePath,
            matchedBy: "jev_system_one",
          };
        }
      } catch (jevErr) {
        // Fail open gracefully on Jev network/timeout error
        console.warn("[Kindle] Jev duplicate classification notice:", jevErr);
      }
    }
  }

  return { exists: false };
}

/**
 * Recursively count book files present across Kindle books/ and documents/ directories.
 */
export function countKindleBooks(mountPath: string): number {
  const index = getOrCreateKindleBookIndex(mountPath);
  return index.entries.length;
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
export function getKindleStatus(
  customVolumesDir?: string,
  scope: "unread" | "all" = "unread",
): KindleStatus {
  const volumesDir = customVolumesDir || process.env.LIGHTHOUSE_VOLUMES_DIR || "/Volumes";
  const mountPath = detectKindleVolume(volumesDir);
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

  let preview: KindleSyncPreview | null = null;
  if (mountPath) {
    try {
      preview = previewKindleSync(mountPath, { scope });
    } catch {
      preview = null;
    }
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
    preview,
  };
}

export function getKosyncDbPath(): string {
  if (process.env.KOSYNC_DB_PATH) {
    return path.resolve(process.env.KOSYNC_DB_PATH);
  }
  const home = process.env.HOME || os.homedir();
  return path.join(home, "kosync-server", "data", "koreader-sync.db");
}

export function getKosyncProgressMap(
  kosyncDbPath: string,
): Map<string, { progress: number; timestamp?: number }> {
  const map = new Map<string, { progress: number; timestamp?: number }>();
  if (!fs.existsSync(kosyncDbPath)) return map;

  try {
    const db = new Database(kosyncDbPath, { readonly: true });
    try {
      db.run("PRAGMA busy_timeout = 3000;");
      const rows = db
        .query(
          "SELECT title, filename, percentage, timestamp FROM progress ORDER BY timestamp DESC;",
        )
        .all() as Array<{
          title?: string;
          filename?: string;
          percentage?: number;
          timestamp?: number;
        }>;

      for (const r of rows) {
        let pct = Number(r.percentage || 0);
        if (pct > 0 && pct <= 1) pct = Math.round(pct * 100);
        else pct = Math.round(pct);

        if (r.title) {
          const normTitle = r.title.toLowerCase().trim();
          if (!map.has(normTitle)) {
            map.set(normTitle, { progress: pct, timestamp: r.timestamp });
          }
        }
        if (r.filename) {
          const normFile = r.filename
            .replace(/\.epub$/i, "")
            .toLowerCase()
            .trim();
          if (!map.has(normFile)) {
            map.set(normFile, { progress: pct, timestamp: r.timestamp });
          }
        }
      }
    } finally {
      db.close();
    }
  } catch {
    // Fail-open returning empty map
  }
  return map;
}

export function isBookActiveOrUnread(
  book: { id?: number; title?: string | null; tags?: string[] | string | null; path?: string | null },
  progressMap?: Map<string, { progress: number; timestamp?: number }>,
): boolean {
  const normTitle = (book.title || "").toLowerCase().trim();
  const tagsList: string[] = Array.isArray(book.tags)
    ? book.tags.map((t) => String(t).toLowerCase().trim())
    : typeof book.tags === "string"
      ? book.tags.split(",").map((t) => t.toLowerCase().trim())
      : [];

  // 1. Explicit active / reading / want-to-read tags always qualify
  const hasReadingTag = tagsList.some(
    (t) =>
      /^(reading|currently[- ]reading|want[- ]to[- ]read|to[- ]read|unread)$/i.test(t) ||
      t.includes("reading") ||
      t.includes("to-read") ||
      t.includes("want-to-read"),
  );
  if (hasReadingTag) return true;

  // 2. Explicit finished tags
  const hasFinishedTag = tagsList.some((t) =>
    /^(finished|read|completed|done)$/i.test(t),
  );

  // 3. KOSync reading progress check
  if (progressMap && normTitle) {
    const progressInfo = progressMap.get(normTitle);
    if (progressInfo !== undefined) {
      const pct = progressInfo.progress;
      if (pct > 0 && pct < 99) return true;
      if (pct >= 99) return false;
      if (pct === 0) return true;
    }
  }

  // If marked finished via tag and no reading tag, exclude
  if (hasFinishedTag) return false;

  // Default for books with no progress record and no finished tag is unread (true)
  return true;
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
 * Supports filtering by scope: 'unread' (default: active/unread) or 'all' (entire library).
 */
export function getAllKindleCandidates(options: { scope?: "unread" | "all" } = {}): KindleFileCandidate[] {
  const dbPath = getCalibreDbPath();
  if (!fs.existsSync(dbPath)) return [];

  const scope = options.scope === "all" ? "all" : "unread";
  const candidates: KindleFileCandidate[] = [];
  try {
    const db = new Database(dbPath, { readonly: true });
    try {
      db.run("PRAGMA busy_timeout = 3000;");

      const kosyncMap =
        scope === "unread"
          ? getKosyncProgressMap(getKosyncDbPath())
          : new Map<string, { progress: number; timestamp?: number }>();

      const hasTagsTable = Boolean(
        db.query("SELECT name FROM sqlite_master WHERE type='table' AND name='books_tags_link';").get(),
      );

      const rows = hasTagsTable
        ? (db
            .query(`
              SELECT b.id, b.title,
                     GROUP_CONCAT(DISTINCT t.name) as tags
              FROM books b
              LEFT JOIN books_tags_link btl ON b.id = btl.book
              LEFT JOIN tags t ON btl.tag = t.id
              GROUP BY b.id
              ORDER BY b.id DESC
            `)
            .all() as Array<{ id: number; title: string | null; tags: string | null }>)
        : (db
            .query(`
              SELECT b.id, b.title, NULL as tags
              FROM books b
              ORDER BY b.id DESC
            `)
            .all() as Array<{ id: number; title: string | null; tags: string | null }>);

      for (const r of rows) {
        if (scope === "unread") {
          const isActiveOrUnread = isBookActiveOrUnread(
            { id: r.id, title: r.title, tags: r.tags },
            kosyncMap,
          );
          if (!isActiveOrUnread) continue;
        }

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
 * Previews Kindle synchronization without transferring any files:
 * - Detects Kindle volume and disk space
 * - Builds/retrieves recursive index of existing books on Kindle
 * - Compares candidate books against Kindle index to determine pending transfers
 * - Computes total required bytes and verifies against free space (including 50MB reserve)
 */
export function previewKindleSync(
  mountPath?: string,
  options: { scope?: "unread" | "all"; forceAll?: boolean } = {},
): KindleSyncPreview {
  const mount = mountPath || detectKindleVolume();
  const scope = options.scope === "all" ? "all" : "unread";

  if (!mount || !fs.existsSync(mount)) {
    return {
      detected: false,
      mountPath: null,
      freeBytes: 0,
      totalBytes: 0,
      totalCandidates: 0,
      alreadySyncedCount: 0,
      pendingCount: 0,
      pendingBytes: 0,
      sufficientSpace: false,
      requiredBytes: 0,
      shortfallBytes: 0,
      scope,
    };
  }

  const space = getKindleDiskSpace(mount);
  const index = getOrCreateKindleBookIndex(mount);
  const candidates = getAllKindleCandidates({ scope });
  const booksRoot = resolveKindleBooksDir(mount, false);

  let alreadySyncedCount = 0;
  let pendingCount = 0;
  let pendingBytes = 0;

  for (const c of candidates) {
    if (!options.forceAll) {
      const destination = resolveKindleDestinationDir(
        booksRoot,
        c.authors || "Unknown",
        c.series,
        true,
      );
      const check = isBookAlreadyOnKindle(mount, c.targetFilename, destination.authorDir, c.fileSize, index, c);
      if (check.exists) {
        alreadySyncedCount++;
        continue;
      }
    }
    pendingCount++;
    pendingBytes += c.fileSize;
  }

  const requiredBytes = pendingCount > 0 ? pendingBytes + SAFETY_BUFFER_BYTES : 0;
  const sufficientSpace = pendingCount === 0 || space.freeBytes >= requiredBytes;
  const shortfallBytes = Math.max(0, requiredBytes - space.freeBytes);

  return {
    detected: true,
    mountPath: mount,
    freeBytes: space.freeBytes,
    totalBytes: space.totalBytes,
    totalCandidates: candidates.length,
    alreadySyncedCount,
    pendingCount,
    pendingBytes,
    sufficientSpace,
    requiredBytes,
    shortfallBytes,
    scope,
  };
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
export async function syncSingleBookToKindle(
  bookId: number,
  options: KindleSyncOptions = {},
): Promise<SingleBookSyncResult> {
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
  const destination = resolveKindleDestinationDir(
    targetBooksRoot,
    candidate.authors || "Unknown",
    candidate.series,
    subfolder,
  );
  const destPath = path.resolve(destination.targetDir, candidate.targetFilename);
  const authorDir = destination.authorDir;

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
    const existing = await isBookAlreadyOnKindleAsync(
      resolvedMount,
      candidate.targetFilename,
      authorDir,
      candidate.fileSize,
      null,
      candidate,
    );
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
    invalidateKindleBookIndex();
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
    runDotClean(targetBooksRoot);
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
 * Bulk synchronize Calibre library books to the connected Kindle.
 * - Deeply checks existing books on device across all subdirectories and filename variants
 * - Enforces pre-flight total storage check before starting transfers
 * - Pre-checks individual book space before copying
 * - Supports graceful cancellation between transfers via cancelKindleSync()
 * - Supports live progress tracking and highlight syncing to Obsidian MAS vault & cache.db.
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
  cancelRequested = false;
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
    // 1. Build recursive index of Kindle existing books
    const index = buildKindleBookIndex(resolvedMount);

    // 2. Resolve candidates respecting scope ('unread' default vs 'all')
    const scope = options.scope === "all" ? "all" : "unread";
    const candidates = getAllKindleCandidates({ scope });
    const subfolder = options.subfolderByAuthor !== false;

    let alreadySynced = 0;
    const pendingCandidates: KindleFileCandidate[] = [];
    let totalRequiredBytes = 0;

    for (const candidate of candidates) {
      const destination = resolveKindleDestinationDir(
        targetBooksRoot,
        candidate.authors || "Unknown",
        candidate.series,
        subfolder,
      );
      let existsAndMatches = false;
      if (!options.forceAll) {
        const existing = await isBookAlreadyOnKindleAsync(
          resolvedMount,
          candidate.targetFilename,
          destination.authorDir,
          candidate.fileSize,
          index,
          candidate,
        );
        if (existing.exists) {
          existsAndMatches = true;
        }
      }

      if (existsAndMatches) {
        alreadySynced++;
      } else {
        pendingCandidates.push(candidate);
        totalRequiredBytes += candidate.fileSize;
      }
    }

    // 3. Pre-Flight Total Storage Check
    const space = getKindleDiskSpace(resolvedMount);
    const requiredBufferBytes = pendingCandidates.length > 0 ? SAFETY_BUFFER_BYTES : 0;
    const totalNeededWithBuffer = totalRequiredBytes + requiredBufferBytes;

    if (pendingCandidates.length > 0 && space.freeBytes < totalNeededWithBuffer) {
      const reqMb = (totalNeededWithBuffer / (1024 * 1024)).toFixed(1);
      const freeMb = (space.freeBytes / (1024 * 1024)).toFixed(1);
      const errMsg = `Insufficient Kindle storage: requires ${reqMb} MB (including 50MB reserve), but only ${freeMb} MB available`;

      activeKindleProgress = {
        phase: "error",
        currentIndex: 0,
        totalCandidates: candidates.length,
        transferredCount: 0,
        alreadySyncedCount: alreadySynced,
        failedCount: pendingCandidates.length,
        skippedCount: 0,
        bytesTransferred: 0,
        percent: 0,
        highlightsPulledCount: 0,
        booksDir: targetBooksRoot,
        error: errMsg,
      };
      options.onProgress?.(activeKindleProgress);

      return {
        success: false,
        mountPath: resolvedMount,
        booksDir: targetBooksRoot,
        totalBooks: candidates.length,
        alreadySynced,
        transferred: 0,
        failed: pendingCandidates.length,
        skipped: 0,
        bytesTransferred: 0,
        highlightsPulled: 0,
        errors: [{ bookId: 0, title: "Storage", error: errMsg }],
      };
    }

    // 4. Transfer Candidates
    let transferred = 0;
    let failed = 0;
    let skipped = 0;
    let bytesTransferred = 0;
    let currentFreeBytes = space.freeBytes;
    const errors: Array<{ bookId: number; title: string; error: string }> = [];
    const transferredBooks: Array<{ bookId: number; title: string; filename: string; bytes: number }> = [];

    activeKindleProgress.totalCandidates = candidates.length;
    activeKindleProgress.alreadySyncedCount = alreadySynced;
    activeKindleProgress.phase = "transferring";

    for (let i = 0; i < pendingCandidates.length; i++) {
      if (cancelRequested) {
        console.log(`[Kindle] Sync cancelled by user at book ${i + 1}/${pendingCandidates.length}`);
        activeKindleProgress = {
          phase: "cancelled",
          currentBookTitle: "Sync cancelled by user",
          currentIndex: i,
          totalCandidates: candidates.length,
          transferredCount: transferred,
          alreadySyncedCount: alreadySynced,
          failedCount: failed,
          skippedCount: skipped,
          bytesTransferred,
          percent: Math.round(((alreadySynced + transferred) / Math.max(1, candidates.length)) * 100),
          highlightsPulledCount: 0,
          booksDir: targetBooksRoot,
        };
        options.onProgress?.(activeKindleProgress);
        break;
      }

      const candidate = pendingCandidates[i];
      const destination = resolveKindleDestinationDir(
        targetBooksRoot,
        candidate.authors || "Unknown",
        candidate.series,
        subfolder,
      );
      const destPath = path.resolve(destination.targetDir, candidate.targetFilename);

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

      // Per-book storage pre-check: verify device has space for file + 50MB buffer
      if (currentFreeBytes < candidate.fileSize + SAFETY_BUFFER_BYTES) {
        const freeMb = (currentFreeBytes / (1024 * 1024)).toFixed(1);
        const needMb = (candidate.fileSize / (1024 * 1024)).toFixed(1);
        const reason = `Insufficient space on Kindle for "${candidate.title}" (Free: ${freeMb}MB, Needed: ${needMb}MB + 50MB buffer)`;
        errors.push({
          bookId: candidate.bookId,
          title: candidate.title,
          error: reason,
        });
        skipped++;
        console.warn(`[Kindle] Space exhausted mid-sync. Halting transfer loop gracefully.`);
        break;
      }

      const currentPercent = candidates.length > 0
        ? Math.min(85, Math.round(((alreadySynced + transferred + 1) / candidates.length) * 85))
        : 85;

      activeKindleProgress = {
        phase: "transferring",
        currentBookTitle: candidate.title,
        currentIndex: alreadySynced + transferred + 1,
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

      try {
        safeCopyFileToKindle(candidate.sourceFilePath, destPath);
        transferred++;
        bytesTransferred += candidate.fileSize;
        currentFreeBytes -= candidate.fileSize;

        addFileToKindleIndex(index, destPath, candidate.fileSize);

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

    // Direction 2: Pull Highlights from both books/ and documents/ (only if not cancelled)
    let highlightsPulled = 0;
    if (!cancelRequested) {
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
              freeBytes: currentFreeBytes,
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
    }

    activeKindleProgress = {
      phase: cancelRequested ? "cancelled" : "completed",
      currentIndex: candidates.length,
      totalCandidates: candidates.length,
      transferredCount: transferred,
      alreadySyncedCount: alreadySynced,
      failedCount: failed,
      skippedCount: skipped,
      bytesTransferred,
      percent: cancelRequested ? activeKindleProgress.percent : 100,
      highlightsPulledCount: highlightsPulled,
      booksDir: targetBooksRoot,
    };
    options.onProgress?.(activeKindleProgress);

    return {
      success: !cancelRequested && failed === 0,
      cancelled: cancelRequested,
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
    cancelRequested = false;
    runDotClean(targetBooksRoot);
    invalidateKindleBookIndex();
  }
}

/**
 * Resolves the path to the macOS diskutil binary.
 * Checks if /usr/sbin/diskutil exists first, otherwise falls back to "diskutil".
 */
export function resolveDiskutilPath(): string {
  if (process.env.LIGHTHOUSE_DISKUTIL_BIN) {
    return process.env.LIGHTHOUSE_DISKUTIL_BIN;
  }
  if (fs.existsSync("/usr/sbin/diskutil")) {
    return "/usr/sbin/diskutil";
  }
  return "diskutil";
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
    const diskutilBin = resolveDiskutilPath();
    const res = spawnSync(diskutilBin, ["eject", resolvedTarget], {
      encoding: "utf8",
      timeout: 10000,
    });
    if (res.error) {
      return {
        success: false,
        message: res.error.message,
      };
    }
    if (res.status === 0) {
      return { success: true, message: `Successfully ejected ${resolvedTarget}` };
    }
    let statusDesc = "unknown error";
    if (res.status !== undefined && res.status !== null) {
      statusDesc = `status ${res.status}`;
    } else if (res.signal) {
      statusDesc = `signal ${res.signal}`;
    }
    return {
      success: false,
      message: res.stderr ? res.stderr.trim() : `diskutil exited with ${statusDesc}`,
    };
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    return {
      success: false,
      message: `Eject command failed: ${message}`,
    };
  }
}
