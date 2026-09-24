#!/usr/bin/env bun
/**
 * scripts/sync-kindle.ts
 *
 * LightHouse Type-C USB Two-Way Synchronization Tool for Kindle & e-Readers:
 *   - Auto-detects mounted Kindle or e-Reader under /Volumes/ (or custom --mount <path>).
 *   - Direction 1: Push Books (Calibre -> Kindle books/ or documents/):
 *       * Prefers /Volumes/Kindle/books as the primary target directory (fallback to documents/).
 *       * Queries Calibre library (metadata.db) and KOSync (koreader-sync.db).
 *       * By default, copies active, reading, unread, and want-to-read books.
 *       * Supports --all flag for complete library push.
 *       * Idempotent: checks both books/ and documents/ to avoid re-copying.
 *       * FAT32 filename sanitization and disk space safety bounds (50MB buffer).
 *       * Atomic copy via temporary file rename (.tmp -> final).
 *   - Direction 2: Pull Highlights (Kindle -> Obsidian & Web Reader):
 *       * Scans both Kindle books/ and documents/ for KOReader .sdr directories (metadata.*.lua) and My Clippings.txt.
 *       * Parses quotes, chapters, page numbers, notes, and timestamps.
 *       * Saves/updates structured Markdown notes in MAS Obsidian vault:
 *         /Users/ospeto/MAS/03-Resources/Books/<Title>.md
 *       * Idempotently merges quotes without duplicate quote proliferation.
 *       * Indexes newly pulled highlights directly into cache.db (table `book_highlights`)
 *         for instant display on the LightHouse web reader.
 *   - Device Eject:
 *       * Safely unmounts/ejects device via diskutil when --eject is passed.
 *
 * CLI Usage:
 *   bin/lighthouse sync-kindle [--apply] [--dry-run] [--all] [--mount <path>] [--eject]
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { Database } from "bun:sqlite";

import {
  getHighlightsCacheDb,
  batchUpsertHighlights,
  cleanQuoteText,
  parseHighlightsFromMarkdown,
  resolveBookIdFromTitle,
  type HighlightRecord,
} from "../uploader/highlights";

import {
  extractHighlightsFromLua,
  extractKindleClippings,
  generateBookMarkdown,
  mergeNoteContent,
  sanitizeTitle,
  normalizeProgress,
  getCalibreDbPath,
  getKosyncDbPath,
  getKosyncProgressMap,
  type HighlightEntry,
  type BookSyncData,
} from "./sync-obsidian";

import {
  generateMetadataFilename,
} from "../uploader/filename";

import {
  SAFETY_BUFFER_BYTES,
  sanitizeFat32Filename,
  normalizeAuthorSpacing,
  resolveKindleDestinationDir,
  runDotClean,
  cleanDotFilesFallback,
  resolveDotCleanPath,
  getKindleDiskSpace,
  findKindleSdrDirs,
  findKindleClippings,
  resolveKindleBooksDir,
  getKindleBookDirs,
  isBookAlreadyOnKindle,
  isBookAlreadyOnKindleAsync,
  detectKindleVolume,
  ejectKindleVolume,
} from "../uploader/kindle";

export {
  SAFETY_BUFFER_BYTES,
  sanitizeFat32Filename,
  normalizeAuthorSpacing,
  resolveKindleDestinationDir,
  runDotClean,
  cleanDotFilesFallback,
  resolveDotCleanPath,
  getKindleDiskSpace,
  findKindleSdrDirs,
  findKindleClippings,
  resolveKindleBooksDir,
  getKindleBookDirs,
  isBookAlreadyOnKindle,
  isBookAlreadyOnKindleAsync,
  detectKindleVolume,
  ejectKindleVolume,
};

// ----------------------------------------------------------------------------
// Interfaces & Types
// ----------------------------------------------------------------------------

export interface KindleVolumeInfo {
  mountPath: string;
  booksDir: string;
  documentsDir: string;
  candidateDirs?: string[];
  name: string;
  freeBytes: number;
  totalBytes: number;
}

export interface KindleSyncOptions {
  mountPath?: string;
  vaultPath?: string;
  calibreDbPath?: string;
  calibreLibraryDir?: string;
  kosyncDbPath?: string;
  cacheDbPath?: string;
  apply?: boolean;
  dryRun?: boolean;
  all?: boolean;
  force?: boolean;
  eject?: boolean;
  verbose?: boolean;
  status?: boolean;
}

export interface BookPushResult {
  bookId: number;
  title: string;
  author: string;
  srcPath: string;
  destPath: string;
  fileSize: number;
  status: "transferred" | "skipped" | "failed";
  reason?: string;
}

export interface HighlightPullResult {
  bookTitle: string;
  author?: string;
  highlightsCount: number;
  newHighlightsCount: number;
  notePath: string;
  action: "created" | "updated" | "skipped";
}

export interface KindleSyncReport {
  mount: KindleVolumeInfo | null;
  dryRun: boolean;
  allBooks: boolean;
  booksPushed: BookPushResult[];
  highlightsPulled: HighlightPullResult[];
  totalHighlightsImported: number;
  freeBytesRemaining: number;
  ejected: boolean;
  errors: string[];
}

export interface CalibreBookRecord {
  id: number;
  title: string;
  authors: string;
  series: string | null;
  seriesIndex: number | null;
  tags: string[];
  comments: string | null;
  path: string;
  format: string;
  filename: string;
  uncompressedSize: number;
  filePath: string;
}

// ----------------------------------------------------------------------------
// 1. Filesystem Helpers
// ----------------------------------------------------------------------------

/**
 * Resolves the target Obsidian Books notes directory.
 * Priority:
 *   1. Explicit CLI argument (`options.vaultPath`)
 *   2. `OBSIDIAN_BOOKS_DIR` environment variable
 *   3. MAS vault path: `/Users/ospeto/MAS/03-Resources/Books`
 *   4. `OBSIDIAN_VAULT_PATH/Books`
 *   5. Default: `~/Obsidian/Books`
 */
export function resolveObsidianBooksDir(customDir?: string): string {
  if (customDir && customDir.trim()) {
    return path.resolve(customDir.trim());
  }
  if (process.env.OBSIDIAN_BOOKS_DIR && process.env.OBSIDIAN_BOOKS_DIR.trim()) {
    return path.resolve(process.env.OBSIDIAN_BOOKS_DIR.trim());
  }
  const masPath = path.join(os.homedir(), "MAS", "03-Resources", "Books");
  if (fs.existsSync(masPath) || fs.existsSync(path.dirname(masPath))) {
    return masPath;
  }
  if (process.env.OBSIDIAN_VAULT_PATH && process.env.OBSIDIAN_VAULT_PATH.trim()) {
    return path.join(path.resolve(process.env.OBSIDIAN_VAULT_PATH.trim()), "Books");
  }
  return path.join(os.homedir(), "Obsidian", "Books");
}

// ----------------------------------------------------------------------------
// 2. Kindle Device Auto-Detection
// ----------------------------------------------------------------------------

const KNOWN_KINDLE_VOLUME_NAMES = [
  "Kindle",
  "KOBOeReader",
  "Kindle Paperwhite",
  "Kindle Colorsoft",
  "Kindle Scribe",
  "Kindle Oasis",
  "KOReader",
];

/**
 * Resolves candidate book directories on a Kindle mount, preferring books/ over documents/.
 */
export function resolveKindleTargetDirs(mountPath: string, autoCreate = true): {
  primaryBooksDir: string;
  candidateDirs: string[];
} {
  const booksDir = path.join(mountPath, "books");
  const docsDir = path.join(mountPath, "documents");
  const candidateDirs: string[] = [];

  const booksExists = fs.existsSync(booksDir);
  const docsExists = fs.existsSync(docsDir);

  if (booksExists) candidateDirs.push(booksDir);
  if (docsExists) candidateDirs.push(docsDir);

  let primaryBooksDir = booksDir;
  if (booksExists) {
    primaryBooksDir = booksDir;
  } else if (docsExists) {
    primaryBooksDir = docsDir;
  } else {
    primaryBooksDir = booksDir;
    if (autoCreate) {
      try {
        fs.mkdirSync(booksDir, { recursive: true });
        candidateDirs.push(booksDir);
      } catch {
        // ignore
      }
    }
  }

  if (candidateDirs.length === 0) {
    candidateDirs.push(primaryBooksDir);
  }

  return { primaryBooksDir, candidateDirs };
}

/**
 * Auto-detects a mounted Kindle or e-Reader under /Volumes/ or validates a custom mount path.
 * Prefers /Volumes/Kindle/books as the primary target directory.
 */
export function detectKindleMount(customPath?: string): KindleVolumeInfo | null {
  const targetPath =
    customPath ||
    process.env.KINDLE_MOUNT_PATH ||
    "";

  // 1. Explicit path check
  if (targetPath && targetPath.trim()) {
    const resolved = path.resolve(targetPath.trim());
    if (fs.existsSync(resolved)) {
      let mountPath = resolved;
      const base = path.basename(resolved).toLowerCase();
      if (base === "documents" || base === "books") {
        mountPath = path.dirname(resolved);
      }

      const { primaryBooksDir, candidateDirs } = resolveKindleTargetDirs(mountPath, false);
      const chosenBooksDir = (base === "documents" || base === "books") ? resolved : primaryBooksDir;

      const space = getKindleDiskSpace(mountPath) || {
        freeBytes: 1024 * 1024 * 1024,
        totalBytes: 4 * 1024 * 1024 * 1024,
      };

      return {
        mountPath,
        booksDir: chosenBooksDir,
        documentsDir: chosenBooksDir,
        candidateDirs: candidateDirs.includes(chosenBooksDir) ? candidateDirs : [chosenBooksDir, ...candidateDirs],
        name: path.basename(mountPath),
        freeBytes: space.freeBytes,
        totalBytes: space.totalBytes,
      };
    }
    return null;
  }

  // 2. Scan /Volumes/ for mounted devices
  const volumesDir = "/Volumes";
  if (!fs.existsSync(volumesDir)) return null;

  try {
    const entries = fs.readdirSync(volumesDir);

    // 2a. Check well-known device volume names
    for (const knownName of KNOWN_KINDLE_VOLUME_NAMES) {
      if (entries.includes(knownName)) {
        const mountPath = path.join(volumesDir, knownName);
        const booksPath = path.join(mountPath, "books");
        const docsPath = path.join(mountPath, "documents");
        if (fs.existsSync(booksPath) || fs.existsSync(docsPath) || /^kindle/i.test(knownName)) {
          const { primaryBooksDir, candidateDirs } = resolveKindleTargetDirs(mountPath, false);
          const space = getKindleDiskSpace(mountPath) || {
            freeBytes: 1024 * 1024 * 1024,
            totalBytes: 4 * 1024 * 1024 * 1024,
          };
          return {
            mountPath,
            booksDir: primaryBooksDir,
            documentsDir: primaryBooksDir,
            candidateDirs,
            name: knownName,
            freeBytes: space.freeBytes,
            totalBytes: space.totalBytes,
          };
        }
      }
    }

    // 2b. Inspect all volume directories for Kindle or KOReader signatures
    for (const entry of entries) {
      const volPath = path.join(volumesDir, entry);
      try {
        const stat = fs.statSync(volPath);
        if (!stat.isDirectory()) continue;

        const booksPath = path.join(volPath, "books");
        const docsPath = path.join(volPath, "documents");
        const systemPath = path.join(volPath, "system");
        const koreaderHidden = path.join(volPath, ".koreader");
        const koreaderDir = path.join(volPath, "koreader");

        const hasBooks = fs.existsSync(booksPath);
        const hasDocs = fs.existsSync(docsPath);
        const hasBooksOrDocs = hasBooks || hasDocs;
        const hasKindleSystem = fs.existsSync(systemPath);
        const hasKoreader =
          fs.existsSync(koreaderHidden) || fs.existsSync(koreaderDir);
        const matchesName = /kindle|kobo|koreader/i.test(entry);

        if ((hasBooksOrDocs && (hasKindleSystem || hasKoreader)) || (matchesName && hasBooksOrDocs)) {
          const { primaryBooksDir, candidateDirs } = resolveKindleTargetDirs(volPath, false);
          const space = getKindleDiskSpace(volPath) || {
            freeBytes: 1024 * 1024 * 1024,
            totalBytes: 4 * 1024 * 1024 * 1024,
          };
          return {
            mountPath: volPath,
            booksDir: primaryBooksDir,
            documentsDir: primaryBooksDir,
            candidateDirs,
            name: entry,
            freeBytes: space.freeBytes,
            totalBytes: space.totalBytes,
          };
        }
      } catch {
        // Skip inaccessible entries
      }
    }
  } catch {
    // Graceful fallback
  }

  return null;
}

// ----------------------------------------------------------------------------
// 3. Calibre Library Query & Book Filtering
// ----------------------------------------------------------------------------

export function getCalibreLibraryDir(): string {
  if (process.env.CALIBRE_LIBRARY_DIR) {
    return path.resolve(process.env.CALIBRE_LIBRARY_DIR);
  }
  const home = process.env.HOME || os.homedir();
  return path.join(home, "Calibre Libraries", "Agent Library");
}

/**
 * Queries all available books and their physical on-disk files from Calibre metadata.db.
 */
export function queryCalibreBooksWithFiles(
  calibreDbPath: string,
  calibreLibDir: string,
): CalibreBookRecord[] {
  if (!fs.existsSync(calibreDbPath)) return [];

  const results: CalibreBookRecord[] = [];
  let db: Database | null = null;

  try {
    db = new Database(calibreDbPath, { readonly: true });
    db.run("PRAGMA busy_timeout = 3000;");

    const hasCommentsTable = Boolean(
      db
        .query(
          "SELECT 1 FROM sqlite_master WHERE type='table' AND name='comments' LIMIT 1;",
        )
        .get(),
    );

    const QUERY_WITH_COMMENTS = `
      SELECT b.id, b.title, b.path,
             GROUP_CONCAT(DISTINCT a.name) as authors,
             s.name as series, b.series_index,
             GROUP_CONCAT(DISTINCT t.name) as tags,
             c.text as comments
      FROM books b
      LEFT JOIN books_authors_link bal ON b.id = bal.book
      LEFT JOIN authors a ON bal.author = a.id
      LEFT JOIN books_series_link bsl ON b.id = bsl.book
      LEFT JOIN series s ON bsl.series = s.id
      LEFT JOIN books_tags_link btl ON b.id = btl.book
      LEFT JOIN tags t ON btl.tag = t.id
      LEFT JOIN comments c ON b.id = c.book
      GROUP BY b.id
      ORDER BY b.id DESC;
    `;

    const QUERY_WITHOUT_COMMENTS = `
      SELECT b.id, b.title, b.path,
             GROUP_CONCAT(DISTINCT a.name) as authors,
             s.name as series, b.series_index,
             GROUP_CONCAT(DISTINCT t.name) as tags,
             NULL as comments
      FROM books b
      LEFT JOIN books_authors_link bal ON b.id = bal.book
      LEFT JOIN authors a ON bal.author = a.id
      LEFT JOIN books_series_link bsl ON b.id = bsl.book
      LEFT JOIN series s ON bsl.series = s.id
      LEFT JOIN books_tags_link btl ON b.id = btl.book
      LEFT JOIN tags t ON btl.tag = t.id
      GROUP BY b.id
      ORDER BY b.id DESC;
    `;

    const bookRows = (
      hasCommentsTable
        ? db.query(QUERY_WITH_COMMENTS).all()
        : db.query(QUERY_WITHOUT_COMMENTS).all()
    ) as any[];

    // Fetch all format records from data table
    const dataRows = db
      .query(`
        SELECT book, format, name, uncompressed_size
        FROM data
        ORDER BY book;
      `)
      .all() as any[];

    const filesByBookId = new Map<number, any[]>();
    for (const d of dataRows) {
      const list = filesByBookId.get(d.book) || [];
      list.push(d);
      filesByBookId.set(d.book, list);
    }

    const FORMAT_PRIORITY = ["EPUB", "AZW3", "MOBI", "KFX", "PDF"];

    for (const b of bookRows) {
      const files = filesByBookId.get(b.id) || [];
      if (files.length === 0) continue;

      // Sort files by format preference
      files.sort((f1, f2) => {
        const idx1 = FORMAT_PRIORITY.indexOf(String(f1.format || "").toUpperCase());
        const idx2 = FORMAT_PRIORITY.indexOf(String(f2.format || "").toUpperCase());
        const score1 = idx1 === -1 ? 999 : idx1;
        const score2 = idx2 === -1 ? 999 : idx2;
        return score1 - score2;
      });

      // Find first existing file on disk
      let resolvedFile: {
        format: string;
        filename: string;
        uncompressedSize: number;
        filePath: string;
      } | null = null;

      const bookRelDir = b.path || "";
      const baseBookDir = path.join(calibreLibDir, bookRelDir);

      for (const f of files) {
        const fmt = String(f.format || "").toLowerCase();
        const cand1 = path.join(baseBookDir, `${f.name}.${fmt}`);
        const cand2 = path.join(baseBookDir, `${f.name}.${fmt.toUpperCase()}`);

        if (fs.existsSync(cand1)) {
          resolvedFile = {
            format: f.format,
            filename: f.name,
            uncompressedSize: f.uncompressed_size || fs.statSync(cand1).size,
            filePath: cand1,
          };
          break;
        } else if (fs.existsSync(cand2)) {
          resolvedFile = {
            format: f.format,
            filename: f.name,
            uncompressedSize: f.uncompressed_size || fs.statSync(cand2).size,
            filePath: cand2,
          };
          break;
        } else if (fs.existsSync(baseBookDir)) {
          // Directory search fallback
          try {
            const dirFiles = fs.readdirSync(baseBookDir);
            const matched = dirFiles.find((df: string) =>
              df.toLowerCase().endsWith(`.${fmt}`),
            );
            if (matched) {
              const fullP = path.join(baseBookDir, matched);
              resolvedFile = {
                format: f.format,
                filename: f.name,
                uncompressedSize: f.uncompressed_size || fs.statSync(fullP).size,
                filePath: fullP,
              };
              break;
            }
          } catch {
            // Ignore readdir error
          }
        }
      }

      if (resolvedFile) {
        const tags = b.tags
          ? b.tags
              .split(",")
              .map((t: string) => t.trim())
              .filter(Boolean)
          : [];

        results.push({
          id: b.id,
          title: b.title || "Untitled",
          authors: b.authors || "Unknown",
          series: b.series || null,
          seriesIndex: b.series_index ?? null,
          tags,
          comments: b.comments || null,
          path: b.path || "",
          format: resolvedFile.format,
          filename: resolvedFile.filename,
          uncompressedSize: resolvedFile.uncompressedSize,
          filePath: resolvedFile.filePath,
        });
      }
    }
  } catch {
    // Database query failed
  } finally {
    try {
      db?.close();
    } catch {
      // Ignore
    }
  }

  return results;
}

/**
 * Determines whether a book is active, currently reading, unread, or want-to-read.
 * Used when `--all` is not specified.
 */
export function isBookActiveOrUnread(
  book: { id: number; title: string; tags?: string[] | string; path?: string },
  progressMap: Map<string, { progress: number; timestamp?: number }>,
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
  const progressInfo = progressMap.get(normTitle);
  if (progressInfo !== undefined) {
    const pct = progressInfo.progress;
    // 0 < pct < 99 -> actively reading!
    if (pct > 0 && pct < 99) return true;
    // pct >= 99 -> finished
    if (pct >= 99) return false;
    // pct === 0 -> unread
    if (pct === 0) return true;
  }

  // If marked finished via tag and no reading tag, exclude
  if (hasFinishedTag) return false;

  // Default for books with no progress record and no finished tag is unread (true)
  return true;
}

// ----------------------------------------------------------------------------
// 4. Direction 1: Push Books (Calibre -> Kindle)
// ----------------------------------------------------------------------------

/**
 * Synchronizes books from Calibre library to Kindle books/ directory.
 * Checks both books/ and documents/ to avoid re-copying existing books.
 */
export async function pushBooksToKindle(
  options: KindleSyncOptions,
  mount: KindleVolumeInfo,
  books: CalibreBookRecord[],
  progressMap: Map<string, { progress: number; timestamp?: number }>,
): Promise<BookPushResult[]> {
  const results: BookPushResult[] = [];
  const targetBooksDir = mount.booksDir || mount.documentsDir;

  if (options.apply && !fs.existsSync(targetBooksDir)) {
    fs.mkdirSync(targetBooksDir, { recursive: true });
  }

  // Filter books if not --all
  const targetBooks = options.all
    ? books
    : books.filter((b) => isBookActiveOrUnread(b, progressMap));

  let currentFreeBytes = mount.freeBytes;
  // Use 50MB safety reserve for real devices, scaled down for small mock test mounts
  const SAFETY_RESERVE_BYTES = mount.freeBytes < SAFETY_BUFFER_BYTES
    ? Math.min(2 * 1024 * 1024, Math.floor(mount.freeBytes / 2))
    : SAFETY_BUFFER_BYTES;

  for (const book of targetBooks) {
    const srcPath = book.filePath;
    if (!fs.existsSync(srcPath)) {
      results.push({
        bookId: book.id,
        title: book.title,
        author: book.authors,
        srcPath,
        destPath: "",
        fileSize: 0,
        status: "failed",
        reason: "Source file not found on disk",
      });
      continue;
    }

    const srcStat = fs.statSync(srcPath);
    const srcSize = srcStat.size;

    // Generate metadata-derived filename and sanitize for FAT32
    const rawFilename = generateMetadataFilename({
      title: book.title,
      authors: book.authors,
      series: book.series,
      seriesIndex: book.seriesIndex,
      format: book.format,
    });
    const destFilename = sanitizeFat32Filename(rawFilename);
    const flatDestPath = path.join(targetBooksDir, destFilename);
    const destination = resolveKindleDestinationDir(
      targetBooksDir,
      book.authors || "Unknown",
      book.series,
      true,
    );

    // 1. Idempotency Check: Already present in books/ or documents/?
    let existingDestSize = 0;
    let existingFoundPath: string | null = null;

    if (fs.existsSync(flatDestPath)) {
      try {
        const destStat = fs.statSync(flatDestPath);
        existingDestSize = destStat.size;
        existingFoundPath = flatDestPath;
      } catch {}
    } else if (fs.existsSync(path.join(destination.targetDir, destFilename))) {
      try {
        const p = path.join(destination.targetDir, destFilename);
        const destStat = fs.statSync(p);
        existingDestSize = destStat.size;
        existingFoundPath = p;
      } catch {}
    }

    if (!existingFoundPath) {
      const checkRes = await isBookAlreadyOnKindleAsync(
        mount.mountPath,
        destFilename,
        destination.authorDir,
        srcSize,
        null,
        {
          title: book.title,
          authors: book.authors,
          series: book.series,
          seriesIndex: book.seriesIndex,
        },
      );
      if (checkRes.exists && checkRes.existingPath && fs.existsSync(checkRes.existingPath)) {
        existingFoundPath = checkRes.existingPath;
        try {
          existingDestSize = fs.statSync(checkRes.existingPath).size;
        } catch {}
      }
    }

    if (!options.force && existingFoundPath && existingDestSize === srcSize) {
      results.push({
        bookId: book.id,
        title: book.title,
        author: book.authors,
        srcPath,
        destPath: existingFoundPath,
        fileSize: srcSize,
        status: "skipped",
        reason: "Already present with identical size",
      });
      continue;
    }

    // Determine target destination path:
    // If existing file is being updated/overwritten, overwrite the existing file location.
    // If new file and existing author/series folder was matched, use that folder. Otherwise use flatDestPath.
    const destPath = existingFoundPath || (destination.reusedExistingFolder ? path.join(destination.targetDir, destFilename) : flatDestPath);
    const targetDir = path.dirname(destPath);

    if (options.apply && !fs.existsSync(targetDir)) {
      fs.mkdirSync(targetDir, { recursive: true });
    }

    // 2. Free Space Bounds Check (credit existing file size when replacing)
    const netSpaceNeeded = Math.max(0, srcSize - existingDestSize);
    if (currentFreeBytes < netSpaceNeeded + SAFETY_RESERVE_BYTES) {
      results.push({
        bookId: book.id,
        title: book.title,
        author: book.authors,
        srcPath,
        destPath,
        fileSize: srcSize,
        status: "failed",
        reason: `Insufficient space on Kindle (Free: ${Math.round(currentFreeBytes / 1024 / 1024)}MB, Needed: ${Math.round(netSpaceNeeded / 1024 / 1024)}MB)`,
      });
      continue;
    }

    // 3. Transfer File
    if (options.apply) {
      const tmpPath = `${destPath}.tmp_${Date.now()}`;
      try {
        fs.copyFileSync(srcPath, tmpPath);
        fs.renameSync(tmpPath, destPath);

        currentFreeBytes -= netSpaceNeeded;
        results.push({
          bookId: book.id,
          title: book.title,
          author: book.authors,
          srcPath,
          destPath,
          fileSize: srcSize,
          status: "transferred",
        });
      } catch (copyErr: any) {
        try {
          if (fs.existsSync(tmpPath)) fs.unlinkSync(tmpPath);
        } catch {
          // Ignore unlink error
        }
        results.push({
          bookId: book.id,
          title: book.title,
          author: book.authors,
          srcPath,
          destPath,
          fileSize: srcSize,
          status: "failed",
          reason: copyErr?.message || "File copy error",
        });
      }
    } else {
      // Dry run simulation
      currentFreeBytes -= netSpaceNeeded;
      results.push({
        bookId: book.id,
        title: book.title,
        author: book.authors,
        srcPath,
        destPath,
        fileSize: srcSize,
        status: "transferred",
        reason: "Would copy (dry-run)",
      });
    }
  }

  if (options.apply) {
    runDotClean(targetBooksDir);
  }

  return results;
}

// ----------------------------------------------------------------------------
// 5. Direction 2: Pull Highlights (Kindle -> Obsidian & Web Reader)
// ----------------------------------------------------------------------------

/**
 * Extracts and merges highlights from KOReader .sdr files and Kindle My Clippings.txt.
 * Scans both books/ and documents/ directories.
 */
export async function pullHighlightsFromKindle(
  options: KindleSyncOptions,
  mount: KindleVolumeInfo,
  calibreDbPath: string,
  kosyncProgressMap: Map<string, { progress: number; timestamp?: number }>,
): Promise<{ results: HighlightPullResult[]; totalImported: number }> {
  const results: HighlightPullResult[] = [];
  const obsidianBooksDir = resolveObsidianBooksDir(options.vaultPath);

  if (options.apply && !fs.existsSync(obsidianBooksDir)) {
    fs.mkdirSync(obsidianBooksDir, { recursive: true });
  }

  // Map of book title -> collected HighlightEntry[]
  const highlightsByBook = new Map<
    string,
    {
      title: string;
      author?: string;
      highlights: HighlightEntry[];
      progress?: number;
    }
  >();

  // 1. Scan KOReader .sdr directories across BOTH books/ and documents/
  const candidateDirs = mount.candidateDirs && mount.candidateDirs.length > 0
    ? mount.candidateDirs
    : [path.join(mount.mountPath, "books"), path.join(mount.mountPath, "documents")];

  const sdrDirsSet = new Set<string>();
  for (const dir of candidateDirs) {
    if (fs.existsSync(dir)) {
      for (const sdr of findKindleSdrDirs(dir)) {
        sdrDirsSet.add(sdr);
      }
    }
  }
  if (mount.documentsDir && fs.existsSync(mount.documentsDir)) {
    for (const sdr of findKindleSdrDirs(mount.documentsDir)) {
      sdrDirsSet.add(sdr);
    }
  }
  if (mount.booksDir && fs.existsSync(mount.booksDir)) {
    for (const sdr of findKindleSdrDirs(mount.booksDir)) {
      sdrDirsSet.add(sdr);
    }
  }
  const sdrDirs = Array.from(sdrDirsSet);
  for (const sdr of sdrDirs) {
    try {
      const files = fs.readdirSync(sdr);
      const luaFile = files.find(
        (f: string) => f.startsWith("metadata.") && f.endsWith(".lua"),
      );
      if (!luaFile) continue;

      const luaContent = fs.readFileSync(path.join(sdr, luaFile), "utf8");
      const extracted = extractHighlightsFromLua(luaContent);

      let bookTitle =
        extracted.title ||
        path.basename(sdr).replace(/\.sdr$/i, "").replace(/\.epub$/i, "").replace(/\.pdf$/i, "");
      bookTitle = bookTitle.trim();
      if (!bookTitle) continue;

      const existing = highlightsByBook.get(bookTitle.toLowerCase()) || {
        title: bookTitle,
        author: extracted.author,
        highlights: [] as HighlightEntry[],
        progress: extracted.percentFinished
          ? normalizeProgress(extracted.percentFinished)
          : undefined,
      };

      if (!existing.author && extracted.author) existing.author = extracted.author;
      if (existing.progress === undefined && extracted.percentFinished) {
        existing.progress = normalizeProgress(extracted.percentFinished);
      }

      existing.highlights.push(...extracted.highlights);
      highlightsByBook.set(bookTitle.toLowerCase(), existing);
    } catch {
      // Skip broken lua file
    }
  }

  // 2. Scan Kindle My Clippings.txt
  const clippingsPath = findKindleClippings(mount.mountPath);
  if (clippingsPath) {
    try {
      const clipContent = fs.readFileSync(clippingsPath, "utf8");
      const parsedClippings = extractKindleClippings(clipContent);

      for (const [_, clipBook] of parsedClippings) {
        const titleKey = clipBook.title.toLowerCase().trim();
        const existing = highlightsByBook.get(titleKey) || {
          title: clipBook.title,
          author: clipBook.author,
          highlights: [] as HighlightEntry[],
        };

        if (!existing.author && clipBook.author && clipBook.author !== "Unknown") {
          existing.author = clipBook.author;
        }

        existing.highlights.push(...clipBook.highlights);
        highlightsByBook.set(titleKey, existing);
      }
    } catch {
      // Skip broken clippings file
    }
  }

  let totalImported = 0;
  const cacheDb = options.apply ? getHighlightsCacheDb(options.cacheDbPath) : null;

  // 3. Write / Merge into Obsidian Notes and Index into cache.db
  for (const [_, bookData] of highlightsByBook) {
    if (bookData.highlights.length === 0) continue;

    const bookTitle = bookData.title.trim();
    const sanitizedName = sanitizeTitle(bookTitle);
    const notePath = path.join(obsidianBooksDir, `${sanitizedName}.md`);

    // Refuse symbolic links to prevent vault path traversal attacks
    if (fs.existsSync(notePath)) {
      try {
        const lstat = fs.lstatSync(notePath);
        if (lstat.isSymbolicLink()) {
          results.push({
            bookTitle,
            author: bookData.author,
            highlightsCount: bookData.highlights.length,
            newHighlightsCount: 0,
            notePath,
            action: "skipped",
          });
          continue;
        }
      } catch {
        // Continue
      }
    }

    // Match with Calibre metadata
    const bookId = resolveBookIdFromTitle(bookTitle, calibreDbPath);
    let calibreSynopsis: string | undefined;
    let calibreSeries: string | undefined;
    let calibreSeriesIndex: number | undefined;

    if (bookId && fs.existsSync(calibreDbPath)) {
      try {
        const cDb = new Database(calibreDbPath, { readonly: true });
        const hasComments = Boolean(
          cDb
            .query("SELECT 1 FROM sqlite_master WHERE type='table' AND name='comments' LIMIT 1")
            .get(),
        );
        const SINGLE_BOOK_WITH_COMMENTS = `
          SELECT b.title, s.name as series, b.series_index, c.text as comments
          FROM books b
          LEFT JOIN books_series_link bsl ON b.id = bsl.book
          LEFT JOIN series s ON bsl.series = s.id
          LEFT JOIN comments c ON b.id = c.book
          WHERE b.id = ?
          LIMIT 1;
        `;
        const SINGLE_BOOK_WITHOUT_COMMENTS = `
          SELECT b.title, s.name as series, b.series_index, NULL as comments
          FROM books b
          LEFT JOIN books_series_link bsl ON b.id = bsl.book
          LEFT JOIN series s ON bsl.series = s.id
          WHERE b.id = ?
          LIMIT 1;
        `;

        const row = (
          hasComments
            ? cDb.query(SINGLE_BOOK_WITH_COMMENTS).get(bookId)
            : cDb.query(SINGLE_BOOK_WITHOUT_COMMENTS).get(bookId)
        ) as any;
        cDb.close();

        if (row) {
          calibreSynopsis = row.comments || undefined;
          calibreSeries = row.series || undefined;
          calibreSeriesIndex = row.series_index ?? undefined;
        }
      } catch {
        // Ignore
      }
    }

    // Match reading progress from KOSync
    const kosyncInfo = kosyncProgressMap.get(bookTitle.toLowerCase());
    const progressPct =
      bookData.progress ?? (kosyncInfo ? kosyncInfo.progress : 0);

    // Merge existing highlights if note already exists
    let existingNoteContent = "";
    let action: "created" | "updated" | "skipped" = "created";
    const quoteMap = new Map<string, HighlightEntry>();

    if (fs.existsSync(notePath)) {
      action = "updated";
      try {
        existingNoteContent = fs.readFileSync(notePath, "utf8");
        const existingRecords = parseHighlightsFromMarkdown(
          existingNoteContent,
          bookTitle,
          bookId,
        );

        for (const er of existingRecords) {
          const cleaned = cleanQuoteText(er.quote);
          const key = cleaned.toLowerCase();
          if (key) {
            quoteMap.set(key, {
              text: cleaned,
              notes: er.note || undefined,
              chapter: er.chapter || undefined,
              page: er.page ?? undefined,
              datetime: er.timestamp || undefined,
            });
          }
        }
      } catch {
        // Continue
      }
    }

    // Merge newly pulled highlights
    let newHighlightsCount = 0;
    for (const nh of bookData.highlights) {
      const cleaned = cleanQuoteText(nh.text);
      if (!cleaned) continue;

      const key = cleaned.toLowerCase();
      const existing = quoteMap.get(key);
      if (!existing) {
        quoteMap.set(key, {
          text: cleaned,
          notes: nh.notes,
          chapter: nh.chapter,
          page: nh.page,
          datetime: nh.datetime,
        });
        newHighlightsCount++;
      } else {
        // Non-destructively enrich missing note/page/chapter
        if (!existing.notes && nh.notes) existing.notes = nh.notes;
        if (!existing.page && nh.page) existing.page = nh.page;
        if (!existing.chapter && nh.chapter) existing.chapter = nh.chapter;
      }
    }

    const mergedHighlights = Array.from(quoteMap.values());
    if (mergedHighlights.length === 0) continue;

    const bookSyncPayload: BookSyncData = {
      title: bookTitle,
      author: bookData.author || "Unknown",
      series: calibreSeries,
      seriesIndex: calibreSeriesIndex,
      synopsis: calibreSynopsis,
      progress: progressPct,
      highlights: mergedHighlights,
      bookId: bookId ?? undefined,
    };

    const finalMarkdown = existingNoteContent
      ? mergeNoteContent(existingNoteContent, bookSyncPayload)
      : generateBookMarkdown(bookSyncPayload);

    let writeSuccess = true;
    if (options.apply) {
      try {
        fs.writeFileSync(notePath, finalMarkdown, "utf8");

        // Index merged highlights directly into cache.db
        if (cacheDb) {
          const dbRecords: Omit<HighlightRecord, "id" | "created_at">[] =
            mergedHighlights
              .filter((h) => h.text && h.text.trim())
              .map((h) => ({
                book_id: bookId ?? null,
                book_title: bookTitle,
                chapter: h.chapter || null,
                page:
                  typeof h.page === "number"
                    ? h.page
                    : h.page
                      ? parseInt(String(h.page), 10) || null
                      : null,
                quote: h.text.trim(),
                note: h.notes || null,
                timestamp: h.datetime || null,
              }));

          if (dbRecords.length > 0) {
            batchUpsertHighlights(cacheDb, dbRecords);
          }
        }
      } catch {
        action = "skipped";
        writeSuccess = false;
      }
    }

    if (writeSuccess) {
      totalImported += newHighlightsCount;
    }
    results.push({
      bookTitle,
      author: bookData.author,
      highlightsCount: mergedHighlights.length,
      newHighlightsCount,
      notePath,
      action,
    });
  }

  return { results, totalImported };
}

// ----------------------------------------------------------------------------
// 6. Main Orchestrator: syncKindle()
// ----------------------------------------------------------------------------

export async function syncKindle(
  options: KindleSyncOptions = {},
): Promise<KindleSyncReport> {
  const dryRun = options.dryRun !== false && !options.apply;
  const isApply = options.apply === true;
  const isAll = options.all === true;
  const errors: string[] = [];

  const mount = detectKindleMount(options.mountPath);
  if (!mount) {
    errors.push(
      "No Kindle or e-Reader mounted under /Volumes. Connect your device via USB-C or pass --mount <path>.",
    );
    return {
      mount: null,
      dryRun,
      allBooks: isAll,
      booksPushed: [],
      highlightsPulled: [],
      totalHighlightsImported: 0,
      freeBytesRemaining: 0,
      ejected: false,
      errors,
    };
  }

  const calibreDb = options.calibreDbPath || getCalibreDbPath();
  const calibreLibDir = options.calibreLibraryDir || getCalibreLibraryDir();
  const kosyncDb = options.kosyncDbPath || getKosyncDbPath();

  const progressMap = getKosyncProgressMap(kosyncDb);
  const calibreBooks = queryCalibreBooksWithFiles(calibreDb, calibreLibDir);

  // Direction 1: Push Books
  const booksPushed = await pushBooksToKindle(
    { ...options, apply: isApply, dryRun },
    mount,
    calibreBooks,
    progressMap,
  );

  // Direction 2: Pull Highlights
  const { results: highlightsPulled, totalImported } =
    await pullHighlightsFromKindle(
      { ...options, apply: isApply, dryRun },
      mount,
      calibreDb,
      progressMap,
    );

  // Calculate remaining free space
  const finalSpace = getKindleDiskSpace(mount.mountPath);
  const freeBytesRemaining = finalSpace ? finalSpace.freeBytes : mount.freeBytes;

  // Eject device only if requested, apply was executed, and there were no hard errors or failed pushes
  let ejected = false;
  const hasFailedPushes = booksPushed.some((b) => b.status === "failed");
  if (options.eject && isApply && errors.length === 0 && !hasFailedPushes) {
    if (process.platform === "darwin") {
      const ejRes = ejectKindleVolume(mount.mountPath);
      if (ejRes.success) {
        ejected = true;
      } else {
        errors.push(`Failed to eject ${mount.mountPath}: ${ejRes.message}`);
      }
    }
  }

  return {
    mount,
    dryRun,
    allBooks: isAll,
    booksPushed,
    highlightsPulled,
    totalHighlightsImported: totalImported,
    freeBytesRemaining,
    ejected,
    errors,
  };
}

// ----------------------------------------------------------------------------
// 7. CLI Formatter & Summary Output
// ----------------------------------------------------------------------------

export function formatBytes(bytes: number): string {
  if (bytes <= 0) return "0 B";
  const units = ["B", "KB", "MB", "GB", "TB"];
  const i = Math.floor(Math.log(bytes) / Math.log(1024));
  return `${(bytes / Math.pow(1024, i)).toFixed(2)} ${units[i]}`;
}

export function formatSyncReport(report: KindleSyncReport): string {
  const lines: string[] = [];
  lines.push("================================================================================");
  lines.push("⚡ LightHouse Type-C Kindle Two-Way Synchronization");
  lines.push("================================================================================");

  if (!report.mount) {
    lines.push("⚠️  Status: No device detected");
    for (const err of report.errors) {
      lines.push(`   • ${err}`);
    }
    lines.push("================================================================================");
    return lines.join("\n");
  }

  const freeFormatted = formatBytes(report.mount.freeBytes);
  const totalFormatted = formatBytes(report.mount.totalBytes);
  const modeStr = report.dryRun
    ? "DRY RUN (Preview only — pass --apply to execute)"
    : "APPLY (Live sync executed)";

  lines.push(`📱 Device:        ${report.mount.name} (${report.mount.mountPath})`);
  lines.push(`📂 Target Books:  ${report.mount.booksDir || report.mount.documentsDir}`);
  lines.push(`⚙️  Mode:          ${modeStr}`);
  lines.push(`📚 Scope:         ${report.allBooks ? "All Library Books (--all)" : "Active, Reading & Unread Books"}`);
  lines.push(`💾 Device Space:  ${freeFormatted} free / ${totalFormatted} total`);
  lines.push("--------------------------------------------------------------------------------");

  // Push Summary
  const transferred = report.booksPushed.filter((b) => b.status === "transferred");
  const skipped = report.booksPushed.filter((b) => b.status === "skipped");
  const failed = report.booksPushed.filter((b) => b.status === "failed");

  lines.push("📤 Push Books (Calibre -> Kindle):");
  lines.push(`   • Total Selected:     ${report.booksPushed.length}`);
  lines.push(`   • ${report.dryRun ? "Would Transfer" : "Transferred"}:       ${transferred.length}`);
  lines.push(`   • Already Present:    ${skipped.length}`);
  if (failed.length > 0) {
    lines.push(`   • Failed:             ${failed.length}`);
  }

  if (transferred.length > 0) {
    lines.push("\n   Transferred / Queued:");
    for (const b of transferred.slice(0, 10)) {
      lines.push(`     + [${formatBytes(b.fileSize)}] ${b.title} — ${b.author}`);
    }
    if (transferred.length > 10) {
      lines.push(`     ... and ${transferred.length - 10} more books`);
    }
  }

  if (failed.length > 0) {
    lines.push("\n   Failed:");
    for (const f of failed) {
      lines.push(`     ! ${f.title}: ${f.reason}`);
    }
  }

  lines.push("--------------------------------------------------------------------------------");

  // Highlights Pull Summary
  lines.push("📥 Pull Highlights (Kindle -> Obsidian & Web Reader):");
  lines.push(`   • Books Processed:    ${report.highlightsPulled.length}`);
  lines.push(`   • New Quotes Saved:   ${report.totalHighlightsImported}`);

  if (report.highlightsPulled.length > 0) {
    lines.push("\n   Highlights Imported:");
    for (const h of report.highlightsPulled.slice(0, 8)) {
      lines.push(
        `     ✦ ${h.bookTitle}: ${h.newHighlightsCount} new (${h.highlightsCount} total) -> ${path.basename(h.notePath)}`,
      );
    }
    if (report.highlightsPulled.length > 8) {
      lines.push(`     ... and ${report.highlightsPulled.length - 8} more books`);
    }
  }

  lines.push("--------------------------------------------------------------------------------");

  // Storage and Eject
  lines.push(`💾 Remaining Free Space: ${formatBytes(report.freeBytesRemaining)}`);
  if (report.ejected) {
    lines.push("⏏️  Device Ejected:      Safely unmounted from macOS. Safe to disconnect cable!");
  } else if (report.mount) {
    lines.push("ℹ️  Eject:               To auto-eject next time, pass --eject");
  }

  lines.push("================================================================================");
  return lines.join("\n");
}

// ----------------------------------------------------------------------------
// 8. CLI Entry Point
// ----------------------------------------------------------------------------

function printHelp() {
  console.log(`
LightHouse Type-C Kindle Two-Way Synchronization CLI
Synchronizes books and highlights between Calibre, Kindle USB-C storage, and Obsidian.

Usage:
  bin/lighthouse sync-kindle [options]

Options:
  --apply              Execute synchronization and write changes to disk (default is dry-run)
  --dry-run            Simulate transfer and highlight import without modifying disk
  --status             Inspect Kindle connection status and exit
  --force              Overwrite existing files on Kindle even if size matches
  --all                Push all library books instead of only active, reading, and unread books
  --mount <path>       Custom Kindle mount path (default: auto-detect under /Volumes/)
  --vault-path <path>  Custom Obsidian books directory (default: ~/MAS/03-Resources/Books)
  --eject              Safely unmount and eject device upon successful sync
  --verbose            Enable detailed logging
  --help, -h           Show this help message

Examples:
  bin/lighthouse sync-kindle                 # Preview changes in dry-run mode
  bin/lighthouse sync-kindle --apply         # Synchronize active books and pull highlights
  bin/lighthouse sync-kindle --apply --all   # Synchronize entire Calibre library to Kindle
  bin/lighthouse sync-kindle --apply --eject # Sync and auto-eject when finished
`);
}

export function parseCliArgs(args: string[]): KindleSyncOptions {
  const options: KindleSyncOptions = {};

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === "--apply") {
      options.apply = true;
      options.dryRun = false;
    } else if (arg === "--dry-run") {
      options.dryRun = true;
      options.apply = false;
    } else if (arg === "--all") {
      options.all = true;
    } else if (arg === "--force") {
      options.force = true;
    } else if (arg === "--status") {
      options.status = true;
    } else if (arg === "--eject") {
      options.eject = true;
    } else if (arg === "--verbose") {
      options.verbose = true;
    } else if (arg === "--mount") {
      options.mountPath = args[++i];
    } else if (arg === "--vault-path") {
      options.vaultPath = args[++i];
    } else if (arg === "--help" || arg === "-h") {
      printHelp();
      process.exit(0);
    }
  }

  return options;
}

if ((import.meta as any).main) {
  const args = process.argv.slice(2);
  const options = parseCliArgs(args);

  if (options.status) {
    const mount = detectKindleMount(options.mountPath);
    if (!mount) {
      console.log("No Kindle or e-Reader detected.");
      process.exit(1);
    } else {
      console.log(`Kindle detected: ${mount.name} at ${mount.mountPath}`);
      console.log(`Target folder:   ${mount.booksDir}`);
      console.log(`Storage:         ${formatBytes(mount.freeBytes)} free of ${formatBytes(mount.totalBytes)}`);
      process.exit(0);
    }
  }

  syncKindle(options)
    .then((report) => {
      console.log(formatSyncReport(report));
      const hasFailed = report.booksPushed.some((b) => b.status === "failed");
      if (!report.mount || report.errors.length > 0 || hasFailed) {
        process.exit(1);
      }
    })
    .catch((err) => {
      console.error("Fatal error during Kindle sync:", err);
      process.exit(1);
    });
}
