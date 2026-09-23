#!/usr/bin/env bun
/**
 * scripts/categorize-library.ts
 *
 * LightHouse Library Categorization & Language Fix Script:
 *   - Inspects books in Calibre SQLite database (CALIBRE_DB_PATH).
 *   - Language Classification:
 *       * Deterministic rule: If title, author, or comments contain Myanmar Unicode
 *         characters ([က-႟] or [၀-၉]), classify as 'mya' (Burmese) and add tag 'Burmese Literature'.
 *       * Ambiguous / transliterated titles: Query Jev System-1 (choice: 'my' | 'en' | 'other').
 *       * Pure Latin titles without Burmese: 'eng' (English).
 *   - Genre & Category Tagging with Jev System-1:
 *       * For books missing meaningful tags, query Jev System-1 with title, author, series,
 *         and description to assign standardized categories:
 *         'Light Novel', 'Manga', 'Fiction', 'Non-Fiction', 'Technology', 'Business',
 *         'History', 'Philosophy', 'Burmese Literature'.
 *       * Strip any promotional watermarks or junk tags (zlib, t.me, @channels, epub).
 *   - Batch Updates:
 *       * Updates Calibre metadata via calibredb set_metadata with --with-library http://127.0.0.1:8088.
 *       * Invalidates server SQLite caches and sends reload signal so the web UI
 *         language shelves and tag facets update immediately.
 *   - Safe by default: runs in --dry-run preview unless --apply is passed.
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { spawn, spawnSync } from "node:child_process";
import { Database } from "bun:sqlite";
import type {
  StandardCategory,
  JevClientOptions,
} from "../uploader/jev-shelf";

const jevShelfMod: typeof import("../uploader/jev-shelf") =
  await import("../uploader/jev-shelf").catch(
    () => import("../jev-shelf" as string) as Promise<typeof import("../uploader/jev-shelf")>,
  );

const {
  hasMeaningfulCategoryTag,
  resolveBookLanguageAndTags,
} = jevShelfMod;

export interface CategorizeLibraryOptions {
  libraryDir?: string;
  calibreDbPath?: string;
  calibreServerUrl?: string;
  cacheDbPath?: string;
  concurrency?: number;
  limit?: number;
  dryRun?: boolean;
  verbose?: boolean;
  json?: boolean;
  skipCacheFlush?: boolean;
  jevOptions?: JevClientOptions;
  // Test injection hooks
  booksProvider?: (
    options: CategorizeLibraryOptions,
  ) => Promise<RawBookRow[]> | RawBookRow[];
  metadataSetter?: (
    bookId: number,
    language: string,
    tags: string[],
    options: CategorizeLibraryOptions,
  ) => Promise<{ success: boolean; error?: string }> | { success: boolean; error?: string };
  cacheFlusher?: (options: CategorizeLibraryOptions) => Promise<void> | void;
}

export interface RawBookRow {
  id: number;
  title: string;
  author?: string;
  comments?: string;
  series?: string;
  series_index?: number;
  tags?: string;
  languages?: string;
}

export interface CategorizeBookItem {
  bookId: number;
  title: string;
  author?: string;
  prevLanguages: string[];
  newLanguage: "mya" | "eng" | "other";
  prevTags: string[];
  newTags: string[];
  addedTags: string[];
  removedTags: string[];
  category?: StandardCategory;
  isBurmese: boolean;
  needsLanguageUpdate: boolean;
  needsTagsUpdate: boolean;
  updated: boolean;
  error?: string;
}

export interface CategorizeLibraryResult {
  dryRun: boolean;
  libraryPath: string;
  calibreServerUrl?: string;
  totalBooksScanned: number;
  burmeseBooksCount: number;
  burmeseLanguageFixedCount: number;
  englishBooksCount: number;
  otherLanguageCount: number;
  booksWithCategoryAssigned: number;
  booksWithJunkTagsStripped: number;
  totalNeedingUpdate: number;
  totalUpdated: number;
  totalErrors: number;
  items: CategorizeBookItem[];
  errors: Array<{ bookId: number; title: string; error: string }>;
}

// ----------------------------------------------------------------------------
// Environment & Path Resolution
// ----------------------------------------------------------------------------

export function loadEnvFiles(): void {
  const root =
    process.env.LIGHTHOUSE_ROOT ||
    path.resolve((import.meta as any).dir, "..");
  const home = process.env.HOME || os.homedir();

  const envCandidates = [
    process.env.ENV_FILE,
    path.join(root, ".env"),
    path.join(root, "uploader", ".env"),
    path.join(home, "uploader", ".env"),
  ].filter(Boolean) as string[];

  for (const envPath of envCandidates) {
    if (fs.existsSync(envPath)) {
      try {
        const content = fs.readFileSync(envPath, "utf8");
        for (const line of content.split("\n")) {
          const trimmed = line.trim();
          if (!trimmed || trimmed.startsWith("#")) continue;
          const eqIdx = trimmed.indexOf("=");
          if (eqIdx <= 0) continue;
          const key = trimmed.slice(0, eqIdx).trim();
          let val = trimmed.slice(eqIdx + 1).trim();
          if (
            (val.startsWith('"') && val.endsWith('"')) ||
            (val.startsWith("'") && val.endsWith("'"))
          ) {
            val = val.slice(1, -1);
          }
          if (!process.env[key]) {
            process.env[key] = val;
          }
        }
      } catch (_envErr) {
        void _envErr;
      }
    }
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
  for (const c of candidates) {
    if (fs.existsSync(c)) return c;
  }
  return "calibredb";
}

export function resolveCalibreDbPath(options: CategorizeLibraryOptions = {}): string {
  if (options.calibreDbPath) return path.resolve(options.calibreDbPath);
  if (options.libraryDir) return path.join(path.resolve(options.libraryDir), "metadata.db");
  if (process.env.CALIBRE_DB_PATH) return path.resolve(process.env.CALIBRE_DB_PATH);
  if (process.env.CALIBRE_LIBRARY_DIR)
    return path.join(path.resolve(process.env.CALIBRE_LIBRARY_DIR), "metadata.db");

  const home = process.env.HOME || os.homedir();
  const defaultDir = path.join(home, "Calibre Libraries", "Agent Library", "metadata.db");
  if (fs.existsSync(defaultDir)) return defaultDir;

  const root = process.env.LIGHTHOUSE_ROOT || path.resolve((import.meta as any).dir, "..");
  const dataDir = path.join(root, "data", "calibre-library", "metadata.db");
  if (fs.existsSync(dataDir)) return dataDir;

  return defaultDir;
}

export async function isCalibreServerReachable(url: string): Promise<boolean> {
  try {
    const res = await fetch(url, { method: "HEAD", signal: AbortSignal.timeout(2000) });
    return res.status < 500;
  } catch {
    return false;
  }
}

/**
 * Execute calibredb set_metadata with sanitized environment (strips proxy variables)
 */
export function setCalibreLanguageAndTagsAsync(
  bookId: number,
  language: string,
  tags: string[],
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
    ];
    if (language && language !== "other") {
      args.push("--field", `languages:${language}`);
    }
    if (tags && tags.length > 0) {
      args.push("--field", `tags:${tags.join(",")}`);
    }

    const child = spawn(getCalibredbPath(), args, { env });
    let stderr = "";
    let stdout = "";
    let killed = false;

    const timer = setTimeout(() => {
      killed = true;
      try {
        child.kill("SIGKILL");
      } catch (_killErr) {
        void _killErr;
      }
      resolve({ success: false, error: `Command timed out after ${timeoutMs}ms` });
    }, timeoutMs);

    child.stdout?.on("data", (d: Uint8Array | string) => {
      stdout += d.toString();
    });
    child.stderr?.on("data", (d: Uint8Array | string) => {
      stderr += d.toString();
    });

    child.on("close", (code: number | null) => {
      clearTimeout(timer);
      if (killed) return;
      if (code === 0) {
        resolve({ success: true });
      } else {
        resolve({
          success: false,
          error: stderr.trim() || stdout.trim() || `calibredb exited with code ${code}`,
        });
      }
    });

    child.on("error", (err: Error) => {
      clearTimeout(timer);
      if (killed) return;
      resolve({ success: false, error: err.message });
    });
  });
}

/**
 * Flushes Reading HQ cache.db and kickstarts book-uploader LaunchAgent.
 */
export function flushReadingCache(cacheDbPath?: string): void {
  const lighthouseRoot =
    process.env.LIGHTHOUSE_ROOT ||
    path.resolve((import.meta as any).dir, "..");
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
    // Non-fatal if launchd service not found
  }
}

// ----------------------------------------------------------------------------
// Core Categorization Engine
// ----------------------------------------------------------------------------

export async function runCategorizeLibrary(
  options: CategorizeLibraryOptions = {},
): Promise<CategorizeLibraryResult> {
  const dryRun = options.dryRun !== false; // Defaults to true
  const verbose = Boolean(options.verbose);
  const concurrency = Math.max(1, Math.min(16, options.concurrency || 4));
  const calibreServerUrl = options.calibreServerUrl || process.env.CALIBRE_SERVER_URL || "http://127.0.0.1:8088";
  const dbPath = resolveCalibreDbPath(options);
  const libraryDir = options.libraryDir || path.dirname(dbPath);

  let rawBooks: RawBookRow[] = [];

  if (options.booksProvider) {
    rawBooks = await options.booksProvider(options);
  } else {
    if (!fs.existsSync(dbPath)) {
      throw new Error(`Calibre database not found at: ${dbPath}`);
    }

    const db = new Database(dbPath, { readonly: true });
    db.run("PRAGMA busy_timeout = 5000;");

    // Check if books_languages_link table exists
    const hasLangTable = db
      .query("SELECT 1 FROM sqlite_master WHERE type='table' AND name='books_languages_link' LIMIT 1")
      .get();

    const sql = `
      SELECT 
        b.id,
        b.title,
        GROUP_CONCAT(DISTINCT a.name) as author,
        c.text as comments,
        s.name as series,
        b.series_index,
        GROUP_CONCAT(DISTINCT t.name) as tags
        ${hasLangTable ? ", GROUP_CONCAT(DISTINCT l.lang_code) as languages" : ", NULL as languages"}
      FROM books b
      LEFT JOIN books_authors_link bal ON b.id = bal.book
      LEFT JOIN authors a ON bal.author = a.id
      LEFT JOIN comments c ON b.id = c.book
      LEFT JOIN books_series_link bsl ON b.id = bsl.book
      LEFT JOIN series s ON bsl.series = s.id
      LEFT JOIN books_tags_link btl ON b.id = btl.book
      LEFT JOIN tags t ON btl.tag = t.id
      ${hasLangTable ? "LEFT JOIN books_languages_link bll ON b.id = bll.book LEFT JOIN languages l ON bll.lang_code = l.id" : ""}
      GROUP BY b.id
      ORDER BY b.id ASC;
    `;

    rawBooks = db.query(sql).all() as RawBookRow[];
    db.close();
  }

  if (typeof options.limit === "number" && options.limit > 0) {
    rawBooks = rawBooks.slice(0, options.limit);
  }

  const items: CategorizeBookItem[] = [];
  let burmeseBooksCount = 0;
  let burmeseLanguageFixedCount = 0;
  let englishBooksCount = 0;
  let otherLanguageCount = 0;
  let booksWithCategoryAssigned = 0;
  let booksWithJunkTagsStripped = 0;

  // Process book classification
  for (const b of rawBooks) {
    const prevLangs = b.languages
      ? b.languages.split(",").map((l) => l.trim().toLowerCase()).filter(Boolean)
      : [];
    const prevTags = b.tags
      ? b.tags.split(",").map((t) => t.trim()).filter(Boolean)
      : [];

    const classification = await resolveBookLanguageAndTags(
      {
        id: b.id,
        title: b.title || "",
        author: b.author || "",
        comments: b.comments || "",
        series: b.series || "",
        tags: prevTags,
        currentLanguages: prevLangs,
      },
      options.jevOptions || {},
    );

    if (classification.isBurmese) {
      burmeseBooksCount++;
      if (prevLangs.includes("eng") && !prevLangs.includes("mya")) {
        burmeseLanguageFixedCount++;
      }
    } else if (classification.language === "eng") {
      englishBooksCount++;
    } else {
      otherLanguageCount++;
    }

    if (classification.category && !hasMeaningfulCategoryTag(prevTags)) {
      booksWithCategoryAssigned++;
    }
    if (classification.removedTags.length > 0) {
      booksWithJunkTagsStripped++;
    }

    const item: CategorizeBookItem = {
      bookId: b.id,
      title: b.title || `Book #${b.id}`,
      author: b.author,
      prevLanguages: prevLangs,
      newLanguage: classification.language,
      prevTags,
      newTags: classification.tags,
      addedTags: classification.addedTags,
      removedTags: classification.removedTags,
      category: classification.category,
      isBurmese: classification.isBurmese,
      needsLanguageUpdate: classification.needsLanguageUpdate,
      needsTagsUpdate: classification.needsTagsUpdate,
      updated: false,
    };

    items.push(item);
  }

  const itemsNeedingUpdate = items.filter(
    (i) => i.needsLanguageUpdate || i.needsTagsUpdate,
  );

  let totalUpdated = 0;
  const errors: Array<{ bookId: number; title: string; error: string }> = [];

  // Determine calibredb target: if server active, use server URL to avoid database locking
  let withLibraryTarget = libraryDir;
  if (!options.metadataSetter) {
    const serverActive = await isCalibreServerReachable(calibreServerUrl);
    if (serverActive) {
      withLibraryTarget = calibreServerUrl;
    }
  }

  if (!dryRun && itemsNeedingUpdate.length > 0) {
    let currentIndex = 0;

    const worker = async () => {
      while (currentIndex < itemsNeedingUpdate.length) {
        const item = itemsNeedingUpdate[currentIndex++];
        if (!item) break;

        let res: { success: boolean; error?: string };
        if (options.metadataSetter) {
          res = await options.metadataSetter(
            item.bookId,
            item.newLanguage,
            item.newTags,
            options,
          );
        } else {
          res = await setCalibreLanguageAndTagsAsync(
            item.bookId,
            item.newLanguage,
            item.newTags,
            withLibraryTarget,
          );
        }

        if (res.success) {
          item.updated = true;
          totalUpdated++;
          if (verbose) {
            console.log(
              `[Updated] #${item.bookId} "${item.title}" -> lang: ${item.newLanguage}, tags: [${item.newTags.join(", ")}]`,
            );
          }
        } else {
          item.error = res.error;
          errors.push({
            bookId: item.bookId,
            title: item.title,
            error: res.error || "Unknown error",
          });
          console.error(
            `[Error] Failed to update metadata for #${item.bookId} "${item.title}": ${res.error}`,
          );
        }
      }
    };

    const pool = Array.from({ length: concurrency }, () => worker());
    await Promise.all(pool);

    // Invalidate caches and kickstart uploader daemon
    if (!options.skipCacheFlush) {
      if (options.cacheFlusher) {
        await options.cacheFlusher(options);
      } else {
        flushReadingCache(options.cacheDbPath);
      }
    }
  }

  return {
    dryRun,
    libraryPath: libraryDir,
    calibreServerUrl,
    totalBooksScanned: rawBooks.length,
    burmeseBooksCount,
    burmeseLanguageFixedCount,
    englishBooksCount,
    otherLanguageCount,
    booksWithCategoryAssigned,
    booksWithJunkTagsStripped,
    totalNeedingUpdate: itemsNeedingUpdate.length,
    totalUpdated,
    totalErrors: errors.length,
    items,
    errors,
  };
}

// ----------------------------------------------------------------------------
// CLI Output & Help
// ----------------------------------------------------------------------------

export function formatCategorizeReport(result: CategorizeLibraryResult): string {
  const lines: string[] = [];
  const modeStr = result.dryRun ? "DRY-RUN (Preview Only)" : "APPLY (Live Updates)";

  lines.push("========================================================================");
  lines.push(`  LightHouse Library Categorization & Language Fix — ${modeStr}`);
  lines.push(`  Library: ${result.libraryPath}`);
  lines.push("========================================================================");
  lines.push("");

  const needingUpdate = result.items.filter(
    (i) => i.needsLanguageUpdate || i.needsTagsUpdate,
  );

  if (needingUpdate.length > 0) {
    lines.push("  PLANNED UPDATES SAMPLE:");
    const sample = needingUpdate.slice(0, 15);
    for (const item of sample) {
      const langNote = item.needsLanguageUpdate
        ? `lang: [${item.prevLanguages.join(",") || "none"}] -> ${item.newLanguage}`
        : `lang: ${item.newLanguage} (unchanged)`;
      const tagsNote = item.needsTagsUpdate
        ? `tags: +[${item.addedTags.join(", ")}]${item.removedTags.length ? ` -[${item.removedTags.join(", ")}]` : ""}`
        : "tags: (unchanged)";
      lines.push(`    #${item.bookId} "${item.title.slice(0, 45)}"`);
      lines.push(`      ${langNote} | ${tagsNote}`);
    }
    if (needingUpdate.length > 15) {
      lines.push(`    ... and ${needingUpdate.length - 15} more books.`);
    }
    lines.push("");
  }

  lines.push("  SUMMARY METRICS:");
  lines.push("  ----------------------------------------------------------------------");
  lines.push(`  Total Books Scanned:            ${result.totalBooksScanned}`);
  lines.push(`  Burmese Books Identified:       ${result.burmeseBooksCount}`);
  lines.push(`  Burmese Language Fixes (mya):   ${result.burmeseLanguageFixedCount} (previously mislabeled as eng)`);
  lines.push(`  English Books:                  ${result.englishBooksCount}`);
  lines.push(`  Other Languages:                ${result.otherLanguageCount}`);
  lines.push(`  Categories Assigned:            ${result.booksWithCategoryAssigned}`);
  lines.push(`  Junk Tags Stripped:             ${result.booksWithJunkTagsStripped}`);
  lines.push(`  Total Books Needing Update:     ${result.totalNeedingUpdate}`);
  if (!result.dryRun) {
    lines.push(`  Total Books Successfully Updated: ${result.totalUpdated}`);
    lines.push(`  Total Errors:                   ${result.totalErrors}`);
  }
  lines.push("  ----------------------------------------------------------------------");

  if (result.dryRun) {
    lines.push("");
    lines.push("  To apply these changes, re-run with --apply:");
    lines.push("    bin/lighthouse categorize --apply");
  }

  lines.push("========================================================================");
  return lines.join("\n");
}

export function printHelp(): void {
  console.log(`
LightHouse Library Categorization & Language Fix Tool

Inspects Calibre library, classifies languages ('mya', 'eng', 'other'),
assigns standardized category tags via Jev System-1, strips promotional
junk tags, and updates Calibre metadata.

Usage:
  bin/lighthouse categorize [options]
  bun run scripts/categorize-library.ts [options]

Options:
  --dry-run                 Preview language and category updates without modifying library (default)
  --apply                   Execute metadata updates via calibredb set_metadata
  --limit <N>               Limit processing to first N books
  --library-path <path>     Explicit path to Calibre library folder
  --calibre-server-url <url> Calibre server URL (default: http://127.0.0.1:8088)
  --concurrency <N>         Worker concurrency for updates (default: 4)
  --verbose                 Log every book update details
  --json                    Output report as JSON
  --skip-cache-flush        Skip Reading HQ cache flush and LaunchAgent reload
  --help, -h                Show this help message
`);
}

// ----------------------------------------------------------------------------
// Main CLI Dispatcher
// ----------------------------------------------------------------------------

if ((import.meta as any).main) {
  loadEnvFiles();
  const args = process.argv.slice(2);
  const options: CategorizeLibraryOptions = {};

  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === "--help" || a === "-h") {
      printHelp();
      process.exit(0);
    } else if (a === "--dry-run") {
      options.dryRun = true;
    } else if (a === "--apply") {
      options.dryRun = false;
    } else if (a === "--verbose" || a === "-v") {
      options.verbose = true;
    } else if (a === "--json") {
      options.json = true;
    } else if (a === "--skip-cache-flush") {
      options.skipCacheFlush = true;
    } else if (a === "--limit" && i + 1 < args.length) {
      options.limit = parseInt(args[++i], 10);
    } else if (a === "--concurrency" && i + 1 < args.length) {
      options.concurrency = parseInt(args[++i], 10);
    } else if (a === "--library-path" && i + 1 < args.length) {
      options.libraryDir = args[++i];
    } else if (a === "--calibre-server-url" && i + 1 < args.length) {
      options.calibreServerUrl = args[++i];
    } else {
      console.error(`Unknown option: ${a}`);
      printHelp();
      process.exit(1);
    }
  }

  runCategorizeLibrary(options)
    .then((res) => {
      if (options.json) {
        console.log(JSON.stringify(res, null, 2));
      } else {
        console.log(formatCategorizeReport(res));
      }
      if (res.totalErrors > 0) {
        process.exit(1);
      }
    })
    .catch((err) => {
      console.error(`Fatal error: ${err.message || err}`);
      process.exit(1);
    });
}
