#!/usr/bin/env bun
/**
 * scripts/sync-series-metadata.ts
 *
 * Synchronizes series and volume metadata across the Calibre library:
 *   - Part A: Maps explicit series links and volume indices from the source Calibre
 *             library ($CALIBRE_SOURCE_LIBRARY_DIR) by matching file size
 *             and relative path.
 *   - Part B: Extracts series names and volume numbers from book titles for remaining
 *             books using heuristic regex patterns (<Series> Vol(ume) <N>, <Series> #<N>,
 *             <Series> Book <N>, and Burmese volume notations).
 *   - Part C: Invalids Reading HQ cache (cache.db) and verifies that total registered
 *             series increase to cover all collections (25+ series).
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { spawn, spawnSync } from "node:child_process";
import { Database } from "bun:sqlite";

export interface SyncSeriesOptions {
  sourceLibraryPath?: string;
  targetLibraryPath?: string;
  calibreServerUrl?: string;
  cacheDbPath?: string;
  concurrency?: number;
  dryRun?: boolean;
  verbose?: boolean;
  skipCacheFlush?: boolean;
  // Custom setter for unit testing / hermetic mocks
  metadataSetter?: (
    bookId: number,
    series: string,
    seriesIndex: number,
    options: SyncSeriesOptions,
  ) => Promise<{ success: boolean; error?: string }> | { success: boolean; error?: string };
  // Custom cache flusher for unit testing / hermetic mocks
  cacheFlusher?: (options: SyncSeriesOptions) => Promise<void> | void;
}

export interface MatchedSeriesBook {
  targetBookId: number;
  title: string;
  series: string;
  seriesIndex: number;
  matchType: "source_db_mapping" | "title_heuristic";
  pattern?: string;
  updated: boolean;
  error?: string;
}

export interface SyncSeriesResult {
  sourceLibraryPath: string;
  targetLibraryPath: string;
  calibreServerUrl?: string;
  dryRun: boolean;
  targetTotalBooks: number;
  initialSeriesCount: number;
  initialBooksWithSeries: number;
  partAMatches: MatchedSeriesBook[];
  partBMatches: MatchedSeriesBook[];
  skippedAlreadyHasSeries: number;
  totalUpdated: number;
  totalErrors: number;
  errors: Array<{ bookId: number; title: string; error: string }>;
  finalSeriesCount: number;
  finalBooksWithSeries: number;
  seriesList: Array<{ name: string; count: number }>;
}

export interface ExtractedSeries {
  series: string;
  volume: number;
  pattern: string;
}

/**
 * Strips Calibre's book ID folder suffix: "Author/Title (123)" -> "Author/Title"
 */
export function stripBookIdFromPath(calibrePath: string): string {
  if (!calibrePath) return "";
  return calibrePath.replace(/\s*\(\d+\)$/, "").trim();
}

/**
 * Cleans and normalizes extracted series name, stripping trailing punctuation or volume remnants.
 */
export function cleanExtractedSeriesName(name: string): string {
  if (!name) return "";
  let s = name.trim();
  // Remove trailing colon, dashes, commas, underscores, spaces
  s = s.replace(/[,:\-–—_\s]+$/, "").trim();
  // Remove leading punctuation
  s = s.replace(/^[,:\-–—_\s]+/, "").trim();
  return s;
}

const BURMESE_DIGIT_MAP: Record<string, number> = {
  "၀": 0,
  "၁": 1,
  "၂": 2,
  "၃": 3,
  "၄": 4,
  "၅": 5,
  "၆": 6,
  "၇": 7,
  "၈": 8,
  "၉": 9,
};

export function parseBurmeseNumber(str: string): number {
  if (!str) return 1;
  if (/^\d+(\.\d+)?$/.test(str)) return parseFloat(str);
  let n = 0;
  for (const ch of str) {
    if (BURMESE_DIGIT_MAP[ch] !== undefined) {
      n = n * 10 + BURMESE_DIGIT_MAP[ch];
    }
  }
  return n || 1;
}

const TITLE_SERIES_PATTERNS = [
  // 1. <Series Name>, Vol(ume).? N (with optional subtitle or parenthetical)
  // e.g. "Overlord, Vol. 14: The Witch of the Doomed Kingdom"
  // e.g. "CubexCursedxCurious - Volume 17 - Closing Episode, Last Part"
  // e.g. "Peddler in Another World: I Can Go Back to My World Whenever I Want! Volume 7"
  // e.g. "Classroom of the Elite: Year 2 Vol. 4.5"
  {
    name: "volume",
    regex:
      /^(.*?)(?:,\s*|\s+-\s+|\s+)Vol(?:ume)?\.?\s*#?(\d+(?:\.\d+)?)(?:\s*[:\-–—]\s*.*|\s*\([^)]*\))?$/i,
  },
  // 2. <Series Name> #N (with optional subtitle)
  // e.g. "Series Name #1" or "Series Name #02"
  {
    name: "hash",
    regex:
      /^(.*?)(?:,\s*|\s+-\s+|\s+)#(\d+(?:\.\d+)?)(?:\s*[:\-–—]\s*.*|\s*\([^)]*\))?$/i,
  },
  // 3. <Series Name> Book <N> (with optional subtitle)
  // e.g. "The Beginning After the End: Book 10: Retribution"
  // e.g. "Providence, Book 11"
  {
    name: "book",
    regex:
      /^(.*?)(?:,\s*|\s+-\s+|\s+)Book\s*#?(\d+(?:\.\d+)?)(?:\s*[:\-–—]\s*.*|\s*\([^)]*\))?$/i,
  },
  // 4. Burmese: <Series Name> (အတွဲ N) or အတွဲ N
  // e.g. "စစ်နှင့်ငြိမ်းချမ်းရေး (အတွဲ ၂)"
  {
    name: "burmese_volume",
    regex: /^(.*?)(?:\s+|\()?(?:အတွဲ|တွဲ)\s*([၀-၉\d]+)\)?$/i,
  },
];

/**
 * Extracts series name and volume index from title using regex heuristics.
 */
export function extractSeriesFromTitle(title: string): ExtractedSeries | null {
  if (!title) return null;
  const t = title.trim();

  // Reject generic or standalone titles that contain false-positive words
  if (/^finished\s+book$/i.test(t)) return null;
  // Ignore publishers/formats in parentheses like (Kolowalu Books (Paperback))
  if (/\(.*?books.*?\)/i.test(t) && !/vol|volume|#|book\s*\d/i.test(t.replace(/\(.*?\)/g, ""))) {
    return null;
  }

  for (const pat of TITLE_SERIES_PATTERNS) {
    const m = t.match(pat.regex);
    if (m) {
      const rawSeries = m[1];
      const series = cleanExtractedSeriesName(rawSeries);
      const vol =
        pat.name === "burmese_volume"
          ? parseBurmeseNumber(m[2])
          : parseFloat(m[2]);

      if (series.length >= 2 && !isNaN(vol) && vol > 0) {
        return { series, volume: vol, pattern: pat.name };
      }
    }
  }

  return null;
}

export function getCalibredbPath(): string {
  if (process.env.CALIBREDB_PATH) return process.env.CALIBREDB_PATH;
  const probe = spawnSync("which", ["calibredb"], { encoding: "utf8" });
  if (probe.status === 0 && probe.stdout.trim()) {
    return probe.stdout.trim();
  }
  const standardPaths = [
    "/opt/homebrew/bin/calibredb",
    "/usr/local/bin/calibredb",
    "/usr/bin/calibredb",
    "/Applications/calibre.app/Contents/MacOS/calibredb",
  ];
  for (const p of standardPaths) {
    if (fs.existsSync(p)) return p;
  }
  return "calibredb";
}

export function runCalibredb(args: string[], timeoutMs = 30000): {
  status: number | null;
  stdout: string;
  stderr: string;
} {
  const env = { ...process.env };
  delete env.HTTP_PROXY;
  delete env.http_proxy;
  delete env.HTTPS_PROXY;
  delete env.https_proxy;
  delete env.ALL_PROXY;
  delete env.all_proxy;
  env.PATH =
    "/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:" + (env.PATH || "");

  const res = spawnSync(getCalibredbPath(), args, {
    encoding: "utf8",
    env,
    timeout: timeoutMs,
  });

  return {
    status: res.status,
    stdout: res.stdout || "",
    stderr: res.stderr || "",
  };
}

export async function isCalibreServerReachable(url: string): Promise<boolean> {
  try {
    const res = await fetch(url, { method: "HEAD", signal: AbortSignal.timeout(1500) });
    return res.status < 500;
  } catch {
    return false;
  }
}

/**
 * Set metadata via calibredb async child process with sanitized environment
 */
export function setCalibreMetadataAsync(
  bookId: number,
  series: string,
  seriesIndex: number,
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
      "set_metadata",
      String(bookId),
      "--with-library",
      withLibrary,
      "--field",
      `series:${series}`,
      "--field",
      `series_index:${seriesIndex}`,
    ];

    const child = spawn(getCalibredbPath(), args, { env });
    let stdout = "";
    let stderr = "";

    const timer = setTimeout(() => {
      child.kill();
      resolve({ success: false, error: `calibredb timed out after ${timeoutMs}ms` });
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
 * Flushes Reading HQ cache.db and kickstarts book-uploader if active.
 */
export function flushReadingCache(cacheDbPath?: string): void {
  const lighthouseRoot =
    process.env.LIGHTHOUSE_ROOT ||
    path.resolve(import.meta.dir, "..");
  const candidates = [
    cacheDbPath,
    process.env.CACHE_DB_PATH,
    process.env.JOBS_DB_PATH,
    path.join(lighthouseRoot, "uploader", "cache.db"),
    path.join(lighthouseRoot, "cache.db"),
    path.join(process.cwd(), "uploader", "cache.db"),
    path.join(process.cwd(), "cache.db"),
  ].filter(Boolean) as string[];

  for (const p of candidates) {
    if (fs.existsSync(p)) {
      try {
        const db = new Database(p);
        const hasFileHashes = db
          .query(
            "SELECT count(*) as c FROM sqlite_master WHERE type='table' AND name='file_hashes';",
          )
          .get() as any;
        if (hasFileHashes?.c) {
          db.run("DELETE FROM file_hashes;");
          db.run("VACUUM;");
        }
        db.close();
      } catch (e: any) {
        console.warn(`[Cache] Warning clearing ${p}: ${e.message}`);
      }
    }
  }

  // Kickstart LaunchAgent if on macOS
  try {
    const uid = process.getuid ? process.getuid() : 501;
    const prefix =
      process.env.LIGHTHOUSE_DAEMON_PREFIX ||
      `com.${process.env.USER || "ospeto"}`;
    spawnSync("launchctl", [
      "kickstart",
      "-k",
      `gui/${uid}/${prefix}.book-uploader`,
    ]);
  } catch {
    // Non-fatal if launchd service not found or running in test container
  }
}

/**
 * Core series metadata synchronization engine
 */
export async function syncSeriesMetadata(
  options: SyncSeriesOptions = {},
): Promise<SyncSeriesResult> {
  const home = process.env.HOME || os.homedir();
  const defaultSource =
    process.env.CALIBRE_SOURCE_LIBRARY_DIR ||
    path.join(home, "Calibre Source Library");
  const defaultTarget =
    process.env.CALIBRE_LIBRARY_DIR ||
    path.join(home, "Calibre Libraries", "Agent Library");
  const defaultServer =
    process.env.CALIBRE_SERVER_URL || "http://127.0.0.1:8088";

  const sourceLibraryPath = options.sourceLibraryPath || defaultSource;
  const targetLibraryPath = options.targetLibraryPath || defaultTarget;
  const calibreServerUrl = options.calibreServerUrl || defaultServer;
  const concurrency = Math.max(1, Math.min(16, options.concurrency || 4));
  const dryRun = !!options.dryRun;
  const verbose = !!options.verbose;

  const sourceDbPath = path.join(sourceLibraryPath, "metadata.db");
  const targetDbPath = path.join(targetLibraryPath, "metadata.db");

  if (!fs.existsSync(sourceDbPath)) {
    throw new Error(`Source Calibre metadata.db not found at: ${sourceDbPath}`);
  }
  if (!fs.existsSync(targetDbPath)) {
    throw new Error(`Target Calibre metadata.db not found at: ${targetDbPath}`);
  }

  // Open both databases in readonly mode to prevent lock contention
  const srcDb = new Database(sourceDbPath, { readonly: true });
  const tgtDb = new Database(targetDbPath, { readonly: true });
  srcDb.run("PRAGMA busy_timeout = 5000;");
  tgtDb.run("PRAGMA busy_timeout = 5000;");

  // Query source library for books with series
  const srcRows = srcDb
    .query(`
    SELECT b.id as src_id, b.title as src_title, b.path as src_path, b.series_index as src_series_index,
           s.name as series, d.uncompressed_size as src_size, d.name as src_filename
    FROM books b
    JOIN books_series_link bsl ON b.id = bsl.book
    JOIN series s ON bsl.series = s.id
    JOIN data d ON b.id = d.book
    WHERE UPPER(d.format) = 'EPUB';
  `)
    .all() as any[];

  // Query target library for all EPUB books and existing series state
  const tgtRows = tgtDb
    .query(`
    SELECT b.id as tgt_id, b.title as tgt_title, b.path as tgt_path, b.series_index as tgt_series_index,
           s.name as tgt_series, d.uncompressed_size as tgt_size, d.name as tgt_filename
    FROM books b
    JOIN data d ON b.id = d.book
    LEFT JOIN books_series_link bsl ON b.id = bsl.book
    LEFT JOIN series s ON bsl.series = s.id
    WHERE UPPER(d.format) = 'EPUB';
  `)
    .all() as any[];

  // Initial counts
  const initialSeriesRow = tgtDb
    .query("SELECT count(DISTINCT s.name) as count FROM series s JOIN books_series_link bsl ON s.id = bsl.series;")
    .get() as any;
  const initialBooksWithSeriesRow = tgtDb
    .query("SELECT count(*) as count FROM books_series_link;")
    .get() as any;

  const initialSeriesCount = initialSeriesRow?.count || 0;
  const initialBooksWithSeries = initialBooksWithSeriesRow?.count || 0;

  srcDb.close();
  tgtDb.close();

  // Index source books by:
  // 1. normalized relative path (without id) + file size
  // 2. unique file size
  const srcByPathAndSize = new Map<string, any>();
  const srcBySize = new Map<number, any[]>();

  for (const s of srcRows) {
    const relPathNoId = stripBookIdFromPath(s.src_path).toLowerCase();
    const key = `${relPathNoId}::${s.src_size}`;
    srcByPathAndSize.set(key, s);

    if (!srcBySize.has(s.src_size)) srcBySize.set(s.src_size, []);
    srcBySize.get(s.src_size)!.push(s);
  }

  // Part A: Source DB Mapping
  const partAMatches: MatchedSeriesBook[] = [];
  const assignedBookIds = new Set<number>();
  let skippedAlreadyHasSeries = 0;

  for (const t of tgtRows) {
    if (t.tgt_series) {
      assignedBookIds.add(t.tgt_id);
      skippedAlreadyHasSeries++;
      continue;
    }

    const relPathNoId = stripBookIdFromPath(t.tgt_path).toLowerCase();
    const key = `${relPathNoId}::${t.tgt_size}`;

    // 1. Primary: exact relative path without ID + uncompressed size
    let match = srcByPathAndSize.get(key);

    // 2. Secondary: unique file size match
    if (!match) {
      const candidates = srcBySize.get(t.tgt_size) || [];
      if (candidates.length === 1) {
        match = candidates[0];
      }
    }

    if (match) {
      partAMatches.push({
        targetBookId: t.tgt_id,
        title: t.tgt_title,
        series: match.series,
        seriesIndex: match.src_series_index,
        matchType: "source_db_mapping",
        updated: false,
      });
      assignedBookIds.add(t.tgt_id);
    }
  }

  // Part B: Title Heuristic Series Extraction for remaining books
  const partBMatches: MatchedSeriesBook[] = [];

  for (const t of tgtRows) {
    if (assignedBookIds.has(t.tgt_id)) continue;

    const extracted = extractSeriesFromTitle(t.tgt_title);
    if (extracted) {
      partBMatches.push({
        targetBookId: t.tgt_id,
        title: t.tgt_title,
        series: extracted.series,
        seriesIndex: extracted.volume,
        matchType: "title_heuristic",
        pattern: extracted.pattern,
        updated: false,
      });
      assignedBookIds.add(t.tgt_id);
    }
  }

  // Determine library target for calibredb:
  // If server is reachable, use server URL to avoid database locking;
  // otherwise fallback to target directory.
  let withLibraryTarget = targetLibraryPath;
  if (!options.metadataSetter) {
    const serverActive = await isCalibreServerReachable(calibreServerUrl);
    if (serverActive) {
      withLibraryTarget = calibreServerUrl;
    }
  }

  const allUpdates = [...partAMatches, ...partBMatches];
  const errors: Array<{ bookId: number; title: string; error: string }> = [];
  let totalUpdated = 0;

  if (!dryRun && allUpdates.length > 0) {
    // Execute updates with worker pool concurrency
    let currentIndex = 0;

    const worker = async () => {
      while (currentIndex < allUpdates.length) {
        const item = allUpdates[currentIndex++];
        if (!item) break;

        let res: { success: boolean; error?: string };
        if (options.metadataSetter) {
          res = await options.metadataSetter(
            item.targetBookId,
            item.series,
            item.seriesIndex,
            options,
          );
        } else {
          res = await setCalibreMetadataAsync(
            item.targetBookId,
            item.series,
            item.seriesIndex,
            withLibraryTarget,
          );
        }

        if (res.success) {
          item.updated = true;
          totalUpdated++;
          if (verbose) {
            console.log(
              `[Updated] #${item.targetBookId} "${item.title}" -> "${item.series}" #${item.seriesIndex}`,
            );
          }
        } else {
          item.error = res.error;
          errors.push({
            bookId: item.targetBookId,
            title: item.title,
            error: res.error || "Unknown error",
          });
          console.error(
            `[Error] Failed to set series for #${item.targetBookId} "${item.title}": ${res.error}`,
          );
        }
      }
    };

    const pool = Array.from({ length: concurrency }, () => worker());
    await Promise.all(pool);

    // Part C: Cache Invalidation
    if (!options.skipCacheFlush) {
      if (options.cacheFlusher) {
        await options.cacheFlusher(options);
      } else {
        flushReadingCache(options.cacheDbPath);
      }
    }
  }

  // Query final library state
  let finalSeriesCount = initialSeriesCount;
  let finalBooksWithSeries = initialBooksWithSeries;
  let seriesList: Array<{ name: string; count: number }> = [];

  try {
    const checkDb = new Database(targetDbPath, { readonly: true });
    checkDb.run("PRAGMA busy_timeout = 5000;");
    const countRow = checkDb
      .query("SELECT count(DISTINCT s.name) as count FROM series s JOIN books_series_link bsl ON s.id = bsl.series;")
      .get() as any;
    const booksRow = checkDb
      .query("SELECT count(*) as count FROM books_series_link;")
      .get() as any;
    const seriesRows = checkDb
      .query("SELECT s.name, count(bsl.book) as count FROM series s JOIN books_series_link bsl ON s.id = bsl.series GROUP BY s.name ORDER BY count DESC;")
      .all() as any[];

    finalSeriesCount = countRow?.count || initialSeriesCount;
    finalBooksWithSeries = booksRow?.count || initialBooksWithSeries;
    seriesList = seriesRows || [];
    checkDb.close();
  } catch (e: any) {
    if (verbose) {
      console.warn("Could not read final series count from target DB:", e.message);
    }
  }

  return {
    sourceLibraryPath,
    targetLibraryPath,
    calibreServerUrl,
    dryRun,
    targetTotalBooks: tgtRows.length,
    initialSeriesCount,
    initialBooksWithSeries,
    partAMatches,
    partBMatches,
    skippedAlreadyHasSeries,
    totalUpdated,
    totalErrors: errors.length,
    errors,
    finalSeriesCount,
    finalBooksWithSeries,
    seriesList,
  };
}

// CLI Execution Wrapper
if ((import.meta as any).main) {
  const args = process.argv.slice(2);
  const options: SyncSeriesOptions = {};

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === "--source" && args[i + 1]) {
      options.sourceLibraryPath = args[++i];
    } else if (arg === "--target" && args[i + 1]) {
      options.targetLibraryPath = args[++i];
    } else if (arg === "--server-url" && args[i + 1]) {
      options.calibreServerUrl = args[++i];
    } else if (arg === "--cache-db" && args[i + 1]) {
      options.cacheDbPath = args[++i];
    } else if (arg === "--concurrency" && args[i + 1]) {
      options.concurrency = parseInt(args[++i], 10);
    } else if (arg === "--dry-run") {
      options.dryRun = true;
    } else if (arg === "--verbose" || arg === "-v") {
      options.verbose = true;
    } else if (arg === "--skip-cache-flush") {
      options.skipCacheFlush = true;
    } else if (arg === "--help" || arg === "-h") {
      console.log(`
Usage: bun run scripts/sync-series-metadata.ts [options]

Options:
  --source <path>        Source Calibre library directory (default: $CALIBRE_SOURCE_LIBRARY_DIR or ~/Calibre Source Library)
  --target <path>        Target Calibre library directory (default: $CALIBRE_LIBRARY_DIR or ~/Calibre Libraries/Agent Library)
  --server-url <url>     Calibre Content Server URL (default: http://127.0.0.1:8088)
  --cache-db <path>      Path to cache.db
  --concurrency <N>      Worker concurrency for calibredb commands (default: 4)
  --dry-run              Report matched series without modifying Calibre or cache
  --verbose, -v          Verbose log output
  --skip-cache-flush     Do not flush Reading HQ cache.db or reload LaunchAgent
  --help, -h             Show this help message
`);
      process.exit(0);
    }
  }

  console.log("=== Calibre Series Metadata Synchronization ===");
  if (options.dryRun) console.log("MODE: DRY RUN (No changes will be written)");

  syncSeriesMetadata(options)
    .then((res) => {
      console.log("\n--- Synchronization Summary ---");
      console.log(`Target Library Total Books: ${res.targetTotalBooks}`);
      console.log(
        `Initial State: ${res.initialSeriesCount} series (${res.initialBooksWithSeries} books with series)`,
      );
      console.log(
        `Part A (Source DB Mapping): ${res.partAMatches.length} books matched`,
      );
      console.log(
        `Part B (Title Heuristics):  ${res.partBMatches.length} books extracted`,
      );
      console.log(
        `Skipped (Already Has Series): ${res.skippedAlreadyHasSeries} books`,
      );
      if (!res.dryRun) {
        console.log(`Total Successfully Updated: ${res.totalUpdated} books`);
        if (res.totalErrors > 0) {
          console.log(`Errors: ${res.totalErrors} books failed`);
        }
        console.log(
          `Final State:   ${res.finalSeriesCount} series (${res.finalBooksWithSeries} books with series)`,
        );
      }

      console.log(
        `\nTotal Unique Series: ${res.seriesList.length || res.finalSeriesCount}`,
      );
      if (res.seriesList.length > 0) {
        console.log("\nTop Series in Library:");
        for (const s of res.seriesList.slice(0, 15)) {
          console.log(`  - ${s.name}: ${s.count} books`);
        }
        if (res.seriesList.length > 15) {
          console.log(`  ... and ${res.seriesList.length - 15} more series.`);
        }
      }

      if (res.finalSeriesCount < 25 && !res.dryRun) {
        console.error(
          `\nVerification Warning: Expected at least 25 series, but found ${res.finalSeriesCount}`,
        );
        process.exit(1);
      } else {
        console.log("\nVerification Passed: Series registration complete.");
      }
    })
    .catch((err) => {
      console.error("\nFatal Error during series sync:", err);
      process.exit(1);
    });
}
