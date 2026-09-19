#!/usr/bin/env bun
/**
 * scripts/clean-duplicates.ts
 *
 * Library-wide Calibre duplicate scanner and cleaner tool:
 *   - Default --dry-run: Scans Calibre library, groups duplicates by:
 *       1. Content signature / hash (identical decompressed EPUB contents)
 *       2. Series & volume match
 *       3. Normalized title & author similarity
 *     and reports duplicate groups with recommended keeper.
 *   - Supports --apply / --prune: Safely removes duplicate book IDs via calibredb remove,
 *     updates KOSync/cache, and writes an audit log.
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { spawn } from "node:child_process";
import { Database } from "bun:sqlite";
import {
  normalizeTitle,
  normalizeAuthor,
  extractSeries,
  stringSimilarity,
  getEpubContentSignature,
  getKOReaderBinary256,
  getCalibredbPath,
} from "../uploader/scraper";
import { flushReadingCache } from "./sync-series-metadata";

export interface CalibreBookRecord {
  id: number;
  title: string;
  authors: string;
  series: string | null;
  seriesIndex: number | null;
  path: string; // Relative path in library
  formats: string[];
  fullPath?: string;
  hasCover?: boolean;
  contentHash?: string | null;
  fileSize?: number;
}

export type DuplicateReason =
  | "content_hash"
  | "series_volume"
  | "title_author_similarity";

export interface DuplicateGroup {
  reason: DuplicateReason;
  confidence: number;
  recommendedKeeper: CalibreBookRecord;
  duplicatesToRemove: CalibreBookRecord[];
  allBooks: CalibreBookRecord[];
  detail?: string;
}

export interface CleanDuplicatesOptions {
  libraryPath?: string;
  calibreServerUrl?: string;
  cacheDbPath?: string;
  kosyncDbPath?: string;
  auditLogPath?: string;
  dryRun?: boolean;
  apply?: boolean;
  verbose?: boolean;
  skipContentHash?: boolean;
  // Test mocks
  bookRemover?: (
    bookId: number,
    options: CleanDuplicatesOptions,
  ) => Promise<{ success: boolean; error?: string }> | { success: boolean; error?: string };
  booksProvider?: (
    options: CleanDuplicatesOptions,
  ) => Promise<CalibreBookRecord[]> | CalibreBookRecord[];
}

export interface CleanDuplicatesResult {
  libraryPath: string;
  dryRun: boolean;
  totalBooksScanned: number;
  duplicateGroupsFound: number;
  totalDuplicatesToRemove: number;
  groups: DuplicateGroup[];
  removedBookIds: number[];
  failedBookIds: Array<{ id: number; error: string }>;
  auditLogWritten?: string;
}

export function parseArgs(args: string[]): CleanDuplicatesOptions {
  const opts: CleanDuplicatesOptions = {
    dryRun: true,
  };

  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === "--apply" || a === "--prune") {
      opts.apply = true;
      opts.dryRun = false;
    } else if (a === "--dry-run") {
      opts.dryRun = true;
      opts.apply = false;
    } else if (a === "--verbose" || a === "-v") {
      opts.verbose = true;
    } else if (a === "--skip-content-hash") {
      opts.skipContentHash = true;
    } else if (a === "--library-dir" || a === "--library-path" || a === "-l") {
      opts.libraryPath = args[++i];
    } else if (a === "--server-url" || a === "-s") {
      opts.calibreServerUrl = args[++i];
    } else if (a === "--audit-log") {
      opts.auditLogPath = args[++i];
    }
  }

  return opts;
}

export function isCalibreServerReachable(
  url = "http://127.0.0.1:8088",
  timeoutMs = 1500,
): Promise<boolean> {
  return new Promise((resolve) => {
    try {
      const u = new URL(url);
      const testUrl = `${u.origin}/`;
      const controller = new AbortController();
      const t = setTimeout(() => {
        controller.abort();
        resolve(false);
      }, timeoutMs);

      fetch(testUrl, { signal: controller.signal })
        .then((res) => {
          clearTimeout(t);
          resolve(res.status < 500);
        })
        .catch(() => {
          clearTimeout(t);
          resolve(false);
        });
    } catch {
      resolve(false);
    }
  });
}

/**
 * Loads all books from Calibre library's metadata.db
 */
export function loadCalibreBooksFromDb(libraryPath: string): CalibreBookRecord[] {
  const dbPath = path.join(libraryPath, "metadata.db");
  if (!fs.existsSync(dbPath)) {
    throw new Error(`Calibre metadata.db not found at: ${dbPath}`);
  }

  const db = new Database(dbPath, { readonly: true });
  db.run("PRAGMA busy_timeout = 5000;");

  const rows = db
    .query(`
      SELECT 
        b.id,
        b.title,
        b.path,
        b.has_cover,
        b.series_index,
        (SELECT group_concat(a.name, ' & ') 
         FROM books_authors_link bal 
         JOIN authors a ON bal.author = a.id 
         WHERE bal.book = b.id) as authors,
        (SELECT s.name 
         FROM books_series_link bsl 
         JOIN series s ON bsl.series = s.id 
         WHERE bsl.book = b.id LIMIT 1) as series,
        (SELECT group_concat(d.format, ',') 
         FROM data d 
         WHERE d.book = b.id) as formats
      FROM books b
      ORDER BY b.id ASC;
    `)
    .all() as any[];

  db.close();

  return rows.map((r) => {
    const formats = (r.formats || "")
      .split(",")
      .map((f: string) => f.trim().toUpperCase())
      .filter(Boolean);

    let fullPath: string | undefined;
    let fileSize: number | undefined;

    // Locate primary file (prioritize EPUB)
    if (r.path) {
      const bookDir = path.join(libraryPath, r.path);
      if (fs.existsSync(bookDir)) {
        const files = fs.readdirSync(bookDir);
        const epubFile = files.find((f) => f.toLowerCase().endsWith(".epub"));
        const targetFile = epubFile || files.find((f) => !f.startsWith(".") && f !== "cover.jpg" && !f.endsWith(".opf"));
        if (targetFile) {
          fullPath = path.join(bookDir, targetFile);
          try {
            fileSize = fs.statSync(fullPath).size;
          } catch (_e) {
            void _e;
          }
        }
      }
    }

    return {
      id: r.id,
      title: r.title || "Untitled",
      authors: r.authors || "Unknown",
      series: r.series || null,
      seriesIndex: r.series_index !== null && r.series_index !== undefined ? Number(r.series_index) : null,
      path: r.path || "",
      formats,
      fullPath,
      hasCover: !!r.has_cover,
      fileSize,
    };
  });
}

/**
 * Recommends which book in a duplicate cluster to keep.
 * Scoring criteria:
 * 1. Has EPUB format (+10)
 * 2. Has cover image (+5)
 * 3. Has explicit series & volume (+4)
 * 4. Larger file size (+2 for higher quality/completeness)
 * 5. Lower ID (older/established book in library) (+1)
 */
export function scoreBookKeeper(book: CalibreBookRecord): number {
  let score = 0;
  if (book.formats.includes("EPUB")) score += 10;
  if (book.hasCover) score += 5;
  if (book.series && book.seriesIndex !== null) score += 4;
  if (book.fileSize && book.fileSize > 100000) score += 2;
  // Favor earlier additions
  score += Math.max(0, 1 - book.id / 100000);
  return score;
}

export function pickRecommendedKeeper(books: CalibreBookRecord[]): {
  keeper: CalibreBookRecord;
  duplicates: CalibreBookRecord[];
} {
  if (books.length <= 1) {
    return { keeper: books[0], duplicates: [] };
  }

  const sorted = [...books].sort((a, b) => {
    const scoreA = scoreBookKeeper(a);
    const scoreB = scoreBookKeeper(b);
    if (scoreB !== scoreA) return scoreB - scoreA;
    return a.id - b.id;
  });

  const keeper = sorted[0];
  const duplicates = sorted.slice(1);
  return { keeper, duplicates };
}

/**
 * Groups Calibre books into duplicate clusters across:
 * 1. Content signature / hash
 * 2. Exact Series + Volume
 * 3. Normalized Title + Author similarity
 */
export function findDuplicateGroups(
  books: CalibreBookRecord[],
  options: { skipContentHash?: boolean; verbose?: boolean } = {},
): DuplicateGroup[] {
  const groups: DuplicateGroup[] = [];
  const handledIds = new Set<number>();

  // -------------------------------------------------------------------------
  // 1. Group by Content Signature (Decompressed EPUB Content / KOReader Hash)
  // -------------------------------------------------------------------------
  if (!options.skipContentHash) {
    const hashGroups = new Map<string, CalibreBookRecord[]>();

    for (const book of books) {
      if (handledIds.has(book.id)) continue;
      if (!book.fullPath || !fs.existsSync(book.fullPath)) continue;

      let sig: string | null = null;
      if (book.fullPath.toLowerCase().endsWith(".epub")) {
        sig = getEpubContentSignature(book.fullPath);
      }
      if (!sig) {
        sig = getKOReaderBinary256(book.fullPath);
      }

      if (sig) {
        book.contentHash = sig;
        const list = hashGroups.get(sig) || [];
        list.push(book);
        hashGroups.set(sig, list);
      }
    }

    for (const [hash, cluster] of hashGroups.entries()) {
      if (cluster.length > 1) {
        const { keeper, duplicates } = pickRecommendedKeeper(cluster);
        groups.push({
          reason: "content_hash",
          confidence: 1.0,
          recommendedKeeper: keeper,
          duplicatesToRemove: duplicates,
          allBooks: cluster,
          detail: `Identical content signature: ${hash.substring(0, 12)}...`,
        });
        for (const b of cluster) handledIds.add(b.id);
      }
    }
  }

  // -------------------------------------------------------------------------
  // 2. Group by Exact Series + Volume Match
  // -------------------------------------------------------------------------
  const seriesGroups = new Map<string, CalibreBookRecord[]>();
  for (const book of books) {
    if (handledIds.has(book.id)) continue;
    if (book.series && book.seriesIndex !== null && book.seriesIndex !== undefined) {
      const normSeries = normalizeTitle(book.series);
      const key = `${normSeries}:::${book.seriesIndex}`;
      const list = seriesGroups.get(key) || [];
      list.push(book);
      seriesGroups.set(key, list);
    }
  }

  for (const [, cluster] of seriesGroups.entries()) {
    if (cluster.length > 1) {
      // Check that author similarity doesn't conflict
      const authorA = normalizeAuthor(cluster[0].authors);
      const allCompatibleAuthors = cluster.every((b) => {
        const authorB = normalizeAuthor(b.authors);
        if (!authorA || !authorB) return true;
        return stringSimilarity(authorA, authorB) >= 0.35;
      });

      // Verify that title text extraction does not report conflicting volume numbers
      // (e.g. Vol 4 vs Vol 4.5 sharing the same rounded/truncated series_index integer)
      const hasConflictingVolumes = cluster.some((b1) => {
        const ex1 = extractSeries(b1.title);
        return cluster.some((b2) => {
          const ex2 = extractSeries(b2.title);
          return ex1 && ex2 && ex1.volume !== ex2.volume;
        });
      });

      // Verify title similarity within the series cluster to ensure they are
      // genuinely the same volume rather than distinct sub-volumes (e.g. Vol 4 vs Vol 4.5)
      const baseTitleA = normalizeTitle(cluster[0].title);
      const allCompatibleTitles = cluster.every((b) => {
        const titleB = normalizeTitle(b.title);
        if (baseTitleA === titleB) return true;
        const sim = stringSimilarity(baseTitleA, titleB);
        return sim >= 0.85;
      });

      if (allCompatibleAuthors && allCompatibleTitles && !hasConflictingVolumes) {
        const { keeper, duplicates } = pickRecommendedKeeper(cluster);
        groups.push({
          reason: "series_volume",
          confidence: 0.95,
          recommendedKeeper: keeper,
          duplicatesToRemove: duplicates,
          allBooks: cluster,
          detail: `Same series "${cluster[0].series}" Volume ${cluster[0].seriesIndex}`,
        });
        for (const b of cluster) handledIds.add(b.id);
      }
    }
  }

  // -------------------------------------------------------------------------
  // 3. Group by Normalized Title + Author Similarity
  // -------------------------------------------------------------------------
  const remaining = books.filter((b) => !handledIds.has(b.id));

  // Bucketed pairwise matching
  for (let i = 0; i < remaining.length; i++) {
    const bookA = remaining[i];
    if (handledIds.has(bookA.id)) continue;

    const cluster: CalibreBookRecord[] = [bookA];
    const normTitleA = normalizeTitle(bookA.title);
    const normAuthorA = normalizeAuthor(bookA.authors);

    for (let j = i + 1; j < remaining.length; j++) {
      const bookB = remaining[j];
      if (handledIds.has(bookB.id)) continue;

      // If one has an explicit series volume and the other has a DIFFERENT volume, skip
      if (
        bookA.series &&
        bookB.series &&
        bookA.seriesIndex !== null &&
        bookB.seriesIndex !== null &&
        bookA.seriesIndex !== bookB.seriesIndex
      ) {
        continue;
      }

      // Check series extraction from title text as well (e.g. Vol 10 vs Vol 11)
      const extractA = extractSeries(bookA.title);
      const extractB = extractSeries(bookB.title);
      if (
        extractA &&
        extractB &&
        (normalizeTitle(extractA.series) === normalizeTitle(extractB.series) ||
          stringSimilarity(normalizeTitle(extractA.series), normalizeTitle(extractB.series)) >= 0.75) &&
        extractA.volume !== extractB.volume
      ) {
        continue;
      }
      if ((extractA && !extractB) || (!extractA && extractB)) {
        // One is an explicit numbered volume in a series and the other is not
        continue;
      }

      const normTitleB = normalizeTitle(bookB.title);
      const normAuthorB = normalizeAuthor(bookB.authors);

      // Check author compatibility
      let authorsMatch = true;
      if (normAuthorA && normAuthorB) {
        const authorSim = stringSimilarity(normAuthorA, normAuthorB);
        if (authorSim < 0.35) {
          authorsMatch = false;
        }
      }

      if (!authorsMatch) continue;

      const minLen = Math.min(normTitleA.length, normTitleB.length);
      const prefixMatch =
        minLen >= 5 &&
        (normTitleA.startsWith(normTitleB) || normTitleB.startsWith(normTitleA)) &&
        (!extractA || !extractB || extractA.volume === extractB.volume);

      const titleMatch =
        normTitleA === normTitleB ||
        stringSimilarity(normTitleA, normTitleB) >= 0.88 ||
        prefixMatch;

      if (titleMatch) {
        cluster.push(bookB);
        handledIds.add(bookB.id);
      }
    }

    if (cluster.length > 1) {
      handledIds.add(bookA.id);
      const { keeper, duplicates } = pickRecommendedKeeper(cluster);
      groups.push({
        reason: "title_author_similarity",
        confidence: 0.9,
        recommendedKeeper: keeper,
        duplicatesToRemove: duplicates,
        allBooks: cluster,
        detail: `Matching normalized title "${normTitleA}"`,
      });
    }
  }

  return groups;
}

/**
 * Removes a book by ID via calibredb remove asynchronously
 */
export function removeCalibreBookAsync(
  bookId: number,
  withLibrary: string,
  timeoutMs = 30000,
): Promise<{ success: boolean; error?: string }> {
  return new Promise((resolve) => {
    const env = { ...process.env };
    delete env.HTTP_PROXY;
    delete env.http_proxy;
    delete env.HTTPS_PROXY;
    delete env.https_proxy;
    delete env.ALL_PROXY;
    delete env.all_proxy;
    env.PATH =
      "/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:" + (env.PATH || "");

    const args = [
      "remove",
      String(bookId),
      "--with-library",
      withLibrary,
    ];

    const child = spawn(getCalibredbPath(), args, { env });
    let stdout = "";
    let stderr = "";

    const timer = setTimeout(() => {
      child.kill();
      resolve({ success: false, error: `calibredb remove timed out after ${timeoutMs}ms` });
    }, timeoutMs);

    child.stdout?.on("data", (d) => {
      stdout += d.toString();
    });
    child.stderr?.on("data", (d) => {
      stderr += d.toString();
    });

    child.on("close", (code) => {
      clearTimeout(timer);
      if (code === 0) {
        resolve({ success: true });
      } else {
        const err = stderr.trim() || stdout.trim() || `Exit code ${code}`;
        resolve({ success: false, error: err });
      }
    });

    child.on("error", (err) => {
      clearTimeout(timer);
      resolve({ success: false, error: err.message });
    });
  });
}

/**
 * Updates KOSync / cache database after book removals
 */
export function pruneCacheEntries(bookIds: number[], cacheDbPath?: string): void {
  const candidates = [
    cacheDbPath,
    process.env.CACHE_DB_PATH,
    "/Users/ospeto/uploader/cache.db",
    path.join(process.cwd(), "uploader", "cache.db"),
  ].filter(Boolean) as string[];

  for (const cPath of candidates) {
    if (fs.existsSync(cPath)) {
      try {
        const db = new Database(cPath);
        for (const id of bookIds) {
          db.run("DELETE FROM file_hashes WHERE book_id = ?", id);
        }
        db.close();
      } catch (_e) {
        void _e;
      }
    }
  }
}

/**
 * Core cleaner execution
 */
export async function runCleanDuplicates(
  options: CleanDuplicatesOptions = {},
): Promise<CleanDuplicatesResult> {
  const home = process.env.HOME || os.homedir();
  const defaultTarget =
    process.env.CALIBRE_LIBRARY_DIR ||
    path.join(home, "Calibre Libraries", "Agent Library");
  const defaultServer =
    process.env.CALIBRE_SERVER_URL || "http://127.0.0.1:8088";

  const libraryPath = options.libraryPath || defaultTarget;
  const calibreServerUrl = options.calibreServerUrl || defaultServer;
  const dryRun = options.apply ? false : options.dryRun ?? true;
  const verbose = !!options.verbose;

  // 1. Fetch books
  let books: CalibreBookRecord[] = [];
  if (options.booksProvider) {
    books = await options.booksProvider(options);
  } else {
    books = loadCalibreBooksFromDb(libraryPath);
  }

  // 2. Scan & group duplicates
  const groups = findDuplicateGroups(books, {
    skipContentHash: options.skipContentHash,
    verbose,
  });

  const totalDuplicatesToRemove = groups.reduce(
    (acc, g) => acc + g.duplicatesToRemove.length,
    0,
  );

  const removedBookIds: number[] = [];
  const failedBookIds: Array<{ id: number; error: string }> = [];

  // Determine library target for calibredb
  let withLibraryTarget = libraryPath;
  if (!options.bookRemover) {
    const serverActive = await isCalibreServerReachable(calibreServerUrl);
    if (serverActive) {
      withLibraryTarget = calibreServerUrl;
    }
  }

  // 3. Apply removals if not dry-run
  if (!dryRun && totalDuplicatesToRemove > 0) {
    for (const group of groups) {
      for (const dup of group.duplicatesToRemove) {
        let res: { success: boolean; error?: string };
        if (options.bookRemover) {
          res = await options.bookRemover(dup.id, options);
        } else {
          res = await removeCalibreBookAsync(dup.id, withLibraryTarget);
        }

        if (res.success) {
          removedBookIds.push(dup.id);
          if (verbose) {
            console.log(
              `[Pruned] Removed Book ID #${dup.id} "${dup.title}" (Kept #${group.recommendedKeeper.id})`,
            );
          }
        } else {
          failedBookIds.push({ id: dup.id, error: res.error || "Unknown error" });
          console.error(
            `[Error] Failed to remove Book ID #${dup.id} "${dup.title}": ${res.error}`,
          );
        }
      }
    }

    // Update caches
    if (removedBookIds.length > 0) {
      pruneCacheEntries(removedBookIds, options.cacheDbPath);
      flushReadingCache(options.cacheDbPath);
    }
  }

  // 4. Write audit log
  let auditLogWritten: string | undefined;
  if (groups.length > 0) {
    const logDir = path.join(process.cwd(), "logs");
    const logPath =
      options.auditLogPath ||
      path.join(
        logDir,
        `clean-duplicates-${new Date().toISOString().replace(/[:.]/g, "-")}.json`,
      );

    try {
      if (!fs.existsSync(path.dirname(logPath))) {
        fs.mkdirSync(path.dirname(logPath), { recursive: true });
      }

      const logPayload = {
        timestamp: new Date().toISOString(),
        dryRun,
        libraryPath,
        totalBooksScanned: books.length,
        duplicateGroupsCount: groups.length,
        totalDuplicatesToRemove,
        removedBookIds,
        failedBookIds,
        groups: groups.map((g) => ({
          reason: g.reason,
          confidence: g.confidence,
          detail: g.detail,
          keeper: {
            id: g.recommendedKeeper.id,
            title: g.recommendedKeeper.title,
            authors: g.recommendedKeeper.authors,
            series: g.recommendedKeeper.series,
            seriesIndex: g.recommendedKeeper.seriesIndex,
          },
          duplicates: g.duplicatesToRemove.map((d) => ({
            id: d.id,
            title: d.title,
            authors: d.authors,
            series: d.series,
            seriesIndex: d.seriesIndex,
          })),
        })),
      };

      fs.writeFileSync(logPath, JSON.stringify(logPayload, null, 2), "utf8");
      auditLogWritten = logPath;
    } catch (e: any) {
      console.warn(`[AuditLog] Could not write audit log to ${logPath}: ${e.message}`);
    }
  }

  return {
    libraryPath,
    dryRun,
    totalBooksScanned: books.length,
    duplicateGroupsFound: groups.length,
    totalDuplicatesToRemove,
    groups,
    removedBookIds,
    failedBookIds,
    auditLogWritten,
  };
}

// -----------------------------------------------------------------------------
// CLI Execution Entry Point
// -----------------------------------------------------------------------------
if ((import.meta as any).main) {
  const args = process.argv.slice(2);
  const options = parseArgs(args);

  console.log("===============================================================");
  console.log(" Reading HQ Calibre Duplicate Scanner & Cleaner Tool");
  console.log("===============================================================");
  console.log(` Mode:        ${options.apply ? "APPLY / PRUNE (Destructive)" : "DRY RUN (Analysis Only)"}`);
  console.log(` Target Lib:  ${options.libraryPath || "Default canonical Agent Library"}`);
  console.log("---------------------------------------------------------------");

  runCleanDuplicates(options)
    .then((result) => {
      console.log(`Total books scanned:     ${result.totalBooksScanned}`);
      console.log(`Duplicate groups found:  ${result.duplicateGroupsFound}`);
      console.log(`Duplicates to remove:    ${result.totalDuplicatesToRemove}`);

      if (result.groups.length > 0) {
        console.log("\nDuplicate Clusters:");
        for (const [idx, g] of result.groups.entries()) {
          console.log(`\n  [Group ${idx + 1}] Reason: ${g.reason.toUpperCase()} (Confidence: ${(g.confidence * 100).toFixed(0)}%)`);
          if (g.detail) console.log(`    Detail: ${g.detail}`);
          console.log(`    ⭐ KEEP:  ID #${g.recommendedKeeper.id} "${g.recommendedKeeper.title}" by ${g.recommendedKeeper.authors}`);
          for (const d of g.duplicatesToRemove) {
            console.log(`    🗑️ PRUNE: ID #${d.id} "${d.title}" by ${d.authors}`);
          }
        }
      }

      if (result.auditLogWritten) {
        console.log(`\nAudit log saved to: ${result.auditLogWritten}`);
      }

      if (result.dryRun && result.totalDuplicatesToRemove > 0) {
        console.log("\nNotice: This was a DRY RUN. Pass --apply to safely remove these duplicate IDs via calibredb.");
      }

      process.exit(0);
    })
    .catch((err) => {
      console.error("\nExecution failed:", err);
      process.exit(1);
    });
}
