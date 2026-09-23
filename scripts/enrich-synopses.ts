#!/usr/bin/env bun
/**
 * scripts/enrich-synopses.ts
 *
 * LightHouse Batch Synopsis Enrichment Tool:
 *   - Scans Calibre database (metadata.db) for books where comments is NULL, empty, or placeholder.
 *   - Tier 1: Local EPUB Inspection (Zero Network):
 *       * Locates physical .epub file from Calibre book.path and data table.
 *       * Inspects content.opf (or OEBPS/content.opf) for <dc:description> or <meta property="schema:description">.
 *       * Sanitizes HTML (strips script, style, boilerplate, cleans whitespace).
 *   - Tier 2: Volume-Specific Online Lookups (Intelligent Source Routing):
 *       * Uses classifyBookSourceCategory and cleanQuery with preserveVolume to route full volume titles:
 *           - Light Novels & Web Novels: Queries RanobeDB and Bangumi using volume titles, falling back to Google Books and OpenLibrary.
 *           - Manga: Queries MangaDex and Bangumi using volume titles.
 *           - General Books: Queries Google Books and OpenLibrary using volume titles.
 *           - Burmese: Skips overseas searches.
 *   - Tier 3: Series Synopsis Fallback (Last Resort Only):
 *       * Only when individual volume queries and EPUB OPF inspection return no description:
 *           - Queries AniList using the cleaned canonical series title.
 *           - Caches the series overview in seriesCache as a fallback for other volumes that lack volume synopses.
 *           - seriesCache strictly serves as the Tier 3 fallback and never short-circuits Tier 1 or Tier 2 volume lookups.
 *       * Strips watermarks, promotional links (zlib, t.me, etc.).
 *   - Batch Updates:
 *       * Updates Calibre comments via calibredb set_metadata with --with-library http://127.0.0.1:8088.
 *       * If online provider returns a cover and book currently has no cover (has_cover=0),
 *         applies the cover as well.
 *       * Invalidates server cache (cache.db) so desktop hover popovers and modals
 *         immediately display the synopses.
 *   - Safe by default: runs in --dry-run preview unless --apply is passed.
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { spawnSync } from "node:child_process";
import { Database } from "bun:sqlite";
import {
  cleanQuery,
  cleanSeriesTitle,
  isAllowedCoverUrl,
  getCalibredbPath,
  isCommentsEmpty,
  decodeHtmlEntities,
  sanitizeSynopsis,
  cleanVolumeQuery,
  extractDescriptionFromOpfXml,
  extractEpubDescription,
  fetchOnlineSynopsis,
  MIN_CONFIDENCE_THRESHOLD,
  SERIES_FALLBACK_MIN_CONFIDENCE,
} from "../uploader/scraper";
export {
  cleanQuery,
  isCommentsEmpty,
  decodeHtmlEntities,
  sanitizeSynopsis,
  cleanVolumeQuery,
  extractDescriptionFromOpfXml,
  extractEpubDescription,
  fetchOnlineSynopsis,
  MIN_CONFIDENCE_THRESHOLD,
  SERIES_FALLBACK_MIN_CONFIDENCE,
};
import { safeFetchWithSsrf } from "../uploader/security";

export type SynopsisSourceFilter = "all" | "epub" | "online";

export interface EnrichSynopsesOptions {
  libraryDir?: string;
  calibreDbPath?: string;
  calibreServerUrl?: string;
  cacheDbPath?: string;
  concurrency?: number;
  limit?: number;
  source?: SynopsisSourceFilter;
  dryRun?: boolean;
  verbose?: boolean;
  json?: boolean;
  skipCacheFlush?: boolean;
  reEnrichDuplicates?: boolean;
  seriesCache?: Map<
    string,
    { description: string; coverUrl?: string; source?: string }
  >;
  // Test injection hooks
  booksProvider?: (
    options: EnrichSynopsesOptions,
  ) => Promise<EnrichBookCandidate[]> | EnrichBookCandidate[];
  epubExtractor?: (
    filePath: string,
  ) => Promise<string | null> | (string | null);
  onlineFetcher?: (
    book: EnrichBookCandidate,
    options: EnrichSynopsesOptions,
  ) => Promise<{ description?: string; coverUrl?: string; source?: string } | null>;
  metadataSetter?: (
    bookId: number,
    comments: string,
    coverUrl?: string,
    options?: EnrichSynopsesOptions,
  ) =>
    | Promise<{ success: boolean; coverApplied?: boolean; error?: string }>
    | { success: boolean; coverApplied?: boolean; error?: string };
  cacheFlusher?: (options: EnrichSynopsesOptions) => Promise<void> | void;
}

export interface EnrichBookCandidate {
  id: number;
  title: string;
  author?: string;
  path?: string; // Calibre relative folder e.g. "Author/Title (123)"
  has_cover?: number; // 0 or 1
  series?: string;
  series_index?: number;
  tags?: string;
  comments?: string;
  data_name?: string;
  data_format?: string;
  isbn?: string;
}

export interface EnrichBookItem {
  bookId: number;
  title: string;
  author?: string;
  sourceType: "epub" | "online" | "none";
  foundSource?: string; // e.g. "EPUB", "RanobeDB", "Bangumi", "GoogleBooks", "OpenLibrary", "MangaDex"
  synopsis: string;
  coverUrl?: string;
  appliedCover: boolean;
  updated: boolean;
  error?: string;
}

export interface EnrichSynopsesResult {
  dryRun: boolean;
  sourceStrategy: SynopsisSourceFilter;
  libraryPath: string;
  calibreServerUrl?: string;
  totalBooksScanned: number;
  synopsesFoundEpub: number;
  synopsesFoundOnline: number;
  synopsesNotFound: number;
  totalNeedingUpdate: number;
  totalUpdated: number;
  coversUpdated: number;
  totalErrors: number;
  items: EnrichBookItem[];
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

export function resolveCalibreDbPath(options: EnrichSynopsesOptions = {}): string {
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

export function getCalibreLibraryDir(options: EnrichSynopsesOptions = {}): string {
  if (options.libraryDir) return path.resolve(options.libraryDir);
  const dbPath = resolveCalibreDbPath(options);
  return path.dirname(dbPath);
}

export async function isCalibreServerReachable(url: string): Promise<boolean> {
  try {
    const res = await fetch(url, { method: "HEAD", signal: AbortSignal.timeout(2000) });
    return res.status < 500;
  } catch {
    return false;
  }
}

export function resolveEpubFilePath(
  libraryDir: string,
  book: { path?: string; data_name?: string; data_format?: string },
): string | null {
  if (!book.path) return null;
  const resolvedLib = path.resolve(libraryDir);
  const bookDir = path.resolve(resolvedLib, book.path);

  // Path containment check: bookDir must strictly reside within resolvedLib
  if (!bookDir.startsWith(resolvedLib + path.sep) && bookDir !== resolvedLib) {
    return null;
  }
  if (!fs.existsSync(bookDir)) return null;

  if (book.data_name && book.data_format) {
    const ext = book.data_format.toLowerCase();
    const candidate1 = path.resolve(bookDir, `${book.data_name}.${ext}`);
    if (
      candidate1.startsWith(bookDir + path.sep) &&
      fs.existsSync(candidate1)
    ) {
      return candidate1;
    }

    const candidate2 = path.resolve(
      bookDir,
      `${book.data_name}.${book.data_format.toUpperCase()}`,
    );
    if (
      candidate2.startsWith(bookDir + path.sep) &&
      fs.existsSync(candidate2)
    ) {
      return candidate2;
    }
  }

  try {
    const files = fs.readdirSync(bookDir);
    const epubFile = files.find((f: string) => f.toLowerCase().endsWith(".epub"));
    if (epubFile) {
      const fullPath = path.resolve(bookDir, epubFile);
      if (fullPath.startsWith(bookDir + path.sep)) {
        return fullPath;
      }
    }
  } catch {
    // Ignore directory read errors
  }
  return null;
}

// ----------------------------------------------------------------------------
// Batch Metadata Updates & Cache Flushing
// ----------------------------------------------------------------------------

export async function setCalibreCommentsAndCoverAsync(
  bookId: number,
  comments: string,
  coverUrl: string | undefined,
  withLibrary: string,
  timeoutMs = 30000,
): Promise<{ success: boolean; coverApplied: boolean; error?: string }> {
  let tempCoverPath = "";
  try {
    const args = [
      "set_metadata",
      String(bookId),
      "--with-library",
      withLibrary,
      "--field",
      `comments:${comments}`,
    ];

    let coverApplied = false;
    if (coverUrl && isAllowedCoverUrl(coverUrl)) {
      try {
        const coverRes = await safeFetchWithSsrf(coverUrl, {
          signal: AbortSignal.timeout(12000),
          proxy: process.env.PROXY_URL || "http://127.0.0.1:7890",
          allowProxyBypass: true,
        } as any);

        if (coverRes.ok) {
          const buf = await coverRes.arrayBuffer();
          if (buf.byteLength > 1024) {
            tempCoverPath = path.join(
              os.tmpdir(),
              `cover_enrich_${bookId}_${Date.now()}.jpg`,
            );
            fs.writeFileSync(tempCoverPath, new Uint8Array(buf));
            args.push("--field", `cover:${tempCoverPath}`);
            coverApplied = true;
          }
        }
      } catch (coverErr: any) {
        // Non-fatal if cover download fails, still update comments
        console.warn(
          `[EnrichSynopsis] Warning downloading cover for #${bookId}: ${coverErr.message}`,
        );
      }
    }

    const env = { ...process.env };
    delete env.HTTP_PROXY;
    delete env.http_proxy;
    delete env.HTTPS_PROXY;
    delete env.https_proxy;
    delete env.ALL_PROXY;
    delete env.all_proxy;
    env.PATH =
      "/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:" + (env.PATH || "");

    const child = spawnSync(getCalibredbPath(), args, {
      encoding: "utf8",
      env,
      timeout: timeoutMs,
    });

    if (tempCoverPath && fs.existsSync(tempCoverPath)) {
      try {
        fs.unlinkSync(tempCoverPath);
      } catch (_unlinkErr) {
        void _unlinkErr;
      }
    }

    if (child.status === 0) {
      return { success: true, coverApplied };
    } else {
      return {
        success: false,
        coverApplied: false,
        error:
          child.stderr?.trim() ||
          child.stdout?.trim() ||
          `calibredb exited with code ${child.status}`,
      };
    }
  } catch (err: any) {
    if (tempCoverPath && fs.existsSync(tempCoverPath)) {
      try {
        fs.unlinkSync(tempCoverPath);
      } catch (_unlinkErr) {
        void _unlinkErr;
      }
    }
    return { success: false, coverApplied: false, error: err.message };
  }
}

export function flushReadingCache(_cacheDbPath?: string): void {
  // Kickstart LaunchAgent if on macOS so server reloads in-memory cache
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
// Core Enrichment Engine
// ----------------------------------------------------------------------------

export async function runEnrichSynopses(
  options: EnrichSynopsesOptions = {},
): Promise<EnrichSynopsesResult> {
  const dryRun = options.dryRun !== false; // Defaults to true
  const verbose = Boolean(options.verbose);
  const sourceStrategy: SynopsisSourceFilter = options.source || "all";
  const concurrency = Math.max(1, Math.min(16, options.concurrency || 4));
  const calibreServerUrl =
    options.calibreServerUrl ||
    process.env.CALIBRE_SERVER_URL ||
    "http://127.0.0.1:8088";
  const dbPath = resolveCalibreDbPath(options);
  const libraryDir = options.libraryDir || path.dirname(dbPath);

  let rawCandidates: EnrichBookCandidate[] = [];

  if (options.booksProvider) {
    rawCandidates = await options.booksProvider(options);
  } else {
    if (!fs.existsSync(dbPath)) {
      throw new Error(`Calibre database not found at: ${dbPath}`);
    }

    const db = new Database(dbPath, { readonly: true });
    db.run("PRAGMA busy_timeout = 5000;");

    const sql = `
      SELECT
        b.id,
        b.title,
        b.path,
        b.has_cover,
        b.series_index,
        GROUP_CONCAT(DISTINCT a.name) as author,
        s.name as series,
        GROUP_CONCAT(DISTINCT t.name) as tags,
        c.text as comments,
        d.name as data_name,
        d.format as data_format,
        (SELECT val FROM identifiers WHERE book = b.id AND LOWER(type) = 'isbn' LIMIT 1) as isbn
      FROM books b
      LEFT JOIN comments c ON b.id = c.book
      LEFT JOIN books_authors_link bal ON b.id = bal.book
      LEFT JOIN authors a ON bal.author = a.id
      LEFT JOIN books_series_link bsl ON b.id = bsl.book
      LEFT JOIN series s ON bsl.series = s.id
      LEFT JOIN books_tags_link btl ON b.id = btl.book
      LEFT JOIN tags t ON btl.tag = t.id
      LEFT JOIN data d ON b.id = d.book AND UPPER(d.format) = 'EPUB'
      WHERE (
        c.text IS NULL 
        OR trim(c.text) = ''
        OR trim(replace(replace(replace(replace(c.text, '<p>', ''), '</p>', ''), '<br>', ''), '&nbsp;', '')) = ''
        OR lower(trim(replace(replace(replace(replace(replace(c.text, '<p>', ''), '</p>', ''), '*', ''), '.', ''), ' ', ''))) IN ('nosynopsisavailable', 'nosynopsisavailableforthisvolume')
        ${
          options.reEnrichDuplicates
            ? `OR (
          bsl.series IS NOT NULL 
          AND c.text IS NOT NULL
          AND trim(c.text) != ''
          AND bsl.series IN (
            SELECT bsl2.series
            FROM books_series_link bsl2
            JOIN comments c2 ON bsl2.book = c2.book
            WHERE c2.text IS NOT NULL AND trim(c2.text) != ''
            GROUP BY bsl2.series, trim(c2.text)
            HAVING COUNT(DISTINCT bsl2.book) > 1
          )
        )`
            : ""
        }
      )
      GROUP BY b.id
      ORDER BY b.id ASC;
    `;

    rawCandidates = db.query(sql).all() as EnrichBookCandidate[];
    db.close();
  }

  // Ensure candidate books have empty comments or are duplicate series summaries if reEnrichDuplicates
  rawCandidates = rawCandidates.filter((b) => {
    if (isCommentsEmpty(b.comments)) return true;
    if (options.reEnrichDuplicates && b.series?.trim() && b.comments) {
      const sName = b.series.trim();
      const hasDupe = rawCandidates.some(
        (other) =>
          other.id !== b.id &&
          other.series?.trim() === sName &&
          other.comments &&
          other.comments === b.comments,
      );
      if (hasDupe) return true;
    }
    return false;
  });

  if (typeof options.limit === "number" && options.limit > 0) {
    rawCandidates = rawCandidates.slice(0, options.limit);
  }

  const items: EnrichBookItem[] = [];
  let synopsesFoundEpub = 0;
  let synopsesFoundOnline = 0;
  let synopsesNotFound = 0;

  const seriesCache =
    options.seriesCache ||
    new Map<
      string,
      { description: string; coverUrl?: string; source?: string }
    >();
  options.seriesCache = seriesCache;

  // 1. Process candidate books to find descriptions with per-book error isolation
  for (const b of rawCandidates) {
    try {
      let foundSynopsis: string | null = null;
      let foundCoverUrl: string | undefined;
      let sourceType: "epub" | "online" | "none" = "none";
      let foundSource: string | undefined;

      const seriesName = b.series?.trim() || cleanSeriesTitle(b.title);
      const seriesKey = seriesName
        ? cleanSeriesTitle(seriesName).toLowerCase()
        : "";

      // Tier 1: Local EPUB Inspection (Volume-specific)
      if (sourceStrategy === "all" || sourceStrategy === "epub") {
        if (options.epubExtractor) {
          foundSynopsis = await options.epubExtractor(b.path || "");
        } else {
          const epubPath = resolveEpubFilePath(libraryDir, b);
          if (epubPath) {
            foundSynopsis = extractEpubDescription(epubPath);
          }
        }

        if (foundSynopsis) {
          sourceType = "epub";
          foundSource = "EPUB";
          synopsesFoundEpub++;
          if (verbose) {
            console.log(
              `[Tier 1: EPUB] #${b.id} "${b.title}" -> Found description`,
            );
          }
        }
      }

      // Tier 2: Volume-specific Online Lookup
      if (
        !foundSynopsis &&
        (sourceStrategy === "all" || sourceStrategy === "online")
      ) {
        let onlineRes: {
          description?: string;
          coverUrl?: string;
          source?: string;
        } | null = null;
        if (options.onlineFetcher) {
          onlineRes = await options.onlineFetcher(b, options);
        } else {
          onlineRes = await fetchOnlineSynopsis(b, options);
        }

        if (onlineRes && onlineRes.description) {
          foundSynopsis = onlineRes.description;
          foundCoverUrl =
            b.has_cover === 0 || !b.has_cover ? onlineRes.coverUrl : undefined;
          sourceType = "online";
          foundSource = onlineRes.source || "Online";
          synopsesFoundOnline++;
          if (seriesKey && (onlineRes.source === "AniList" || (onlineRes as any).isSeriesOverview)) {
            seriesCache.set(seriesKey, {
              description: onlineRes.description,
              coverUrl: onlineRes.coverUrl,
              source: onlineRes.source || "AniList",
            });
          }
          if (verbose) {
            console.log(
              `[Tier 2: Online] #${b.id} "${b.title}" -> Found description via ${foundSource}${foundCoverUrl ? " (+cover)" : ""}`,
            );
          }
        }
      }

      // Tier 3: Series Synopsis Fallback (Only if Tier 1 & Tier 2 returned no synopsis, and seriesCache has an overview)
      if (
        !foundSynopsis &&
        seriesKey &&
        seriesCache.has(seriesKey) &&
        (sourceStrategy === "all" || sourceStrategy === "online")
      ) {
        const cached = seriesCache.get(seriesKey)!;
        foundSynopsis = cached.description;
        foundCoverUrl =
          b.has_cover === 0 || !b.has_cover ? cached.coverUrl : undefined;
        sourceType = "online";
        foundSource = cached.source || "Online";
        synopsesFoundOnline++;
        if (verbose) {
          console.log(
            `[Tier 3: Series Inherited] #${b.id} "${b.title}" -> Inherited series synopsis for "${seriesKey}" from ${foundSource}`,
          );
        }
      }

      if (!foundSynopsis) {
        synopsesNotFound++;
      }

      items.push({
        bookId: b.id,
        title: b.title || `Book #${b.id}`,
        author: b.author,
        sourceType,
        foundSource,
        synopsis: foundSynopsis || "",
        coverUrl: foundCoverUrl,
        appliedCover: false,
        updated: false,
      });
    } catch (discErr: any) {
      if (verbose) {
        console.warn(
          `[EnrichSynopsis] Error inspecting #${b.id} "${b.title}": ${discErr.message}`,
        );
      }
      synopsesNotFound++;
      items.push({
        bookId: b.id,
        title: b.title || `Book #${b.id}`,
        author: b.author,
        sourceType: "none",
        synopsis: "",
        appliedCover: false,
        updated: false,
        error: discErr.message,
      });
    }
  }

  const candidatesMap = new Map(rawCandidates.map((c) => [c.id, c]));
  const itemsNeedingUpdate = items.filter((i) => {
    if (i.sourceType === "none" || !i.synopsis) return false;
    const c = candidatesMap.get(i.bookId);
    return isCommentsEmpty(c?.comments) || i.synopsis !== c?.comments;
  });

  let totalUpdated = 0;
  let coversUpdated = 0;
  const errors: Array<{ bookId: number; title: string; error: string }> = [];

  // Determine calibredb target: if server active, use server URL to avoid SQLite locking
  let withLibraryTarget = libraryDir;
  if (!options.metadataSetter) {
    const serverActive = await isCalibreServerReachable(calibreServerUrl);
    if (serverActive) {
      withLibraryTarget = calibreServerUrl;
    }
  }

  // 2. Apply metadata updates if --apply mode
  if (!dryRun && itemsNeedingUpdate.length > 0) {
    let currentIndex = 0;

    const worker = async () => {
      while (currentIndex < itemsNeedingUpdate.length) {
        const item = itemsNeedingUpdate[currentIndex++];
        if (!item) break;

        let res: { success: boolean; coverApplied?: boolean; error?: string };
        if (options.metadataSetter) {
          res = await options.metadataSetter(
            item.bookId,
            item.synopsis,
            item.coverUrl,
            options,
          );
        } else {
          res = await setCalibreCommentsAndCoverAsync(
            item.bookId,
            item.synopsis,
            item.coverUrl,
            withLibraryTarget,
          );
        }

        if (res.success) {
          item.updated = true;
          totalUpdated++;
          if (res.coverApplied) {
            item.appliedCover = true;
            coversUpdated++;
          }
          if (verbose) {
            console.log(
              `[Updated] #${item.bookId} "${item.title}" [${item.foundSource}]${item.appliedCover ? " (+cover)" : ""}`,
            );
          }
        } else {
          item.updated = false;
          item.error = res.error;
          errors.push({
            bookId: item.bookId,
            title: item.title,
            error: res.error || "Unknown error",
          });
          console.error(
            `[Error] Failed to update synopsis for #${item.bookId} "${item.title}": ${res.error}`,
          );
        }
      }
    };

    const pool = Array.from({ length: concurrency }, () => worker());
    await Promise.all(pool);

    // Invalidate caches and kickstart uploader daemon
    if (!options.skipCacheFlush && totalUpdated > 0) {
      if (options.cacheFlusher) {
        await options.cacheFlusher(options);
      } else {
        flushReadingCache(options.cacheDbPath);
      }
    }
  }

  return {
    dryRun,
    sourceStrategy,
    libraryPath: libraryDir,
    calibreServerUrl,
    totalBooksScanned: rawCandidates.length,
    synopsesFoundEpub,
    synopsesFoundOnline,
    synopsesNotFound,
    totalNeedingUpdate: itemsNeedingUpdate.length,
    totalUpdated,
    coversUpdated,
    totalErrors: errors.length,
    items,
    errors,
  };
}

// ----------------------------------------------------------------------------
// CLI Output Formatting & Help
// ----------------------------------------------------------------------------

export function formatEnrichReport(result: EnrichSynopsesResult): string {
  const lines: string[] = [];
  const modeStr = result.dryRun ? "DRY-RUN (Preview Only)" : "APPLY (Live Updates)";

  lines.push("========================================================================");
  lines.push(`  LightHouse Synopsis Enrichment — ${modeStr}`);
  lines.push(`  Library:  ${result.libraryPath}`);
  lines.push(`  Strategy: ${result.sourceStrategy}`);
  lines.push("========================================================================");
  lines.push("");

  const foundItems = result.items.filter((i) => i.sourceType !== "none");

  if (foundItems.length > 0) {
    lines.push("  ENRICHED SYNOPSES SAMPLE:");
    const sample = foundItems.slice(0, 15);
    for (const item of sample) {
      const coverNote = item.coverUrl
        ? item.appliedCover
          ? " (+cover updated)"
          : " (+cover available)"
        : "";
      // Strip tags for clean terminal sample preview
      const previewText = item.synopsis
        .replace(/<[^>]+>/g, " ")
        .replace(/\s+/g, " ")
        .trim();
      const snippet =
        previewText.length > 90
          ? `${previewText.slice(0, 90)}...`
          : previewText;

      lines.push(
        `    #${item.bookId} "${item.title.slice(0, 45)}" [${item.foundSource}]${coverNote}`,
      );
      lines.push(`      Synopsis: "${snippet}"`);
    }
    if (foundItems.length > 15) {
      lines.push(`    ... and ${foundItems.length - 15} more books.`);
    }
    lines.push("");
  }

  lines.push("  SUMMARY METRICS:");
  lines.push("  ----------------------------------------------------------------------");
  lines.push(`  Total Books Scanned:            ${result.totalBooksScanned}`);
  lines.push(`  Synopses Found from Local EPUB: ${result.synopsesFoundEpub}`);
  lines.push(`  Synopses Found from Online APIs:${result.synopsesFoundOnline}`);
  lines.push(`  Synopses Not Found:             ${result.synopsesNotFound}`);
  lines.push(`  Total Books Needing Update:     ${result.totalNeedingUpdate}`);
  if (!result.dryRun) {
    lines.push(`  Total Books Updated in Calibre: ${result.totalUpdated}`);
    lines.push(`  Covers Applied:                 ${result.coversUpdated}`);
    lines.push(`  Total Errors:                   ${result.totalErrors}`);
  }
  lines.push("  ----------------------------------------------------------------------");

  if (result.dryRun) {
    lines.push("");
    lines.push("  To apply these changes, re-run with --apply:");
    lines.push("    bin/lighthouse enrich-synopsis --apply");
  }

  lines.push("========================================================================");
  return lines.join("\n");
}

export function printHelp(): void {
  console.log(`
LightHouse Synopsis Enrichment Tool

Populates missing descriptions for books in Calibre library combining
local EPUB metadata extraction with online light novel and book APIs
(RanobeDB, Bangumi, Google Books, OpenLibrary, MangaDex).

Usage:
  bin/lighthouse enrich-synopsis [options]
  bun run scripts/enrich-synopses.ts [options]

Options:
  --dry-run                 Preview synopses without modifying library (default)
  --apply                   Execute metadata updates via calibredb set_metadata
  --limit <N>               Limit processing to first N books
  --source <type>           Source strategy: all (default), epub, or online
  --re-enrich-duplicates    Re-enrich volumes holding duplicate series summaries when true volume synopsis is available
  --library-path <path>     Explicit path to Calibre library folder
  --calibre-server-url <url> Calibre server URL (default: http://127.0.0.1:8088)
  --concurrency <N>         Worker concurrency for updates (default: 4)
  --verbose, -v             Log detailed step-by-step search and extraction
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
  const options: EnrichSynopsesOptions = {};

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
    } else if (a.startsWith("--limit=")) {
      options.limit = parseInt(a.slice(8), 10);
    } else if (a === "--source" && i + 1 < args.length) {
      const s = args[++i].toLowerCase();
      if (s === "all" || s === "epub" || s === "online") {
        options.source = s;
      }
    } else if (a.startsWith("--source=")) {
      const s = a.slice(9).toLowerCase();
      if (s === "all" || s === "epub" || s === "online") {
        options.source = s;
      }
    } else if (a === "--re-enrich-duplicates" || a === "--re-enrich-series-duplicates") {
      options.reEnrichDuplicates = true;
    } else if (a === "--library-path" && i + 1 < args.length) {
      options.libraryDir = args[++i];
    } else if (a.startsWith("--library-path=")) {
      options.libraryDir = a.slice(15);
    } else if (a === "--calibre-server-url" && i + 1 < args.length) {
      options.calibreServerUrl = args[++i];
    } else if (a === "--concurrency" && i + 1 < args.length) {
      options.concurrency = parseInt(args[++i], 10);
    }
  }

  runEnrichSynopses(options)
    .then((result) => {
      if (options.json) {
        console.log(JSON.stringify(result, null, 2));
      } else {
        console.log(formatEnrichReport(result));
      }
      if (result.totalErrors > 0 && !result.dryRun) {
        process.exit(1);
      }
      process.exit(0);
    })
    .catch((err) => {
      console.error(`[Error] Synopsis enrichment failed: ${err.message}`);
      process.exit(1);
    });
}
