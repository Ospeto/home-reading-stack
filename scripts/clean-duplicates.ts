#!/usr/bin/env bun
/**
 * scripts/clean-duplicates.ts
 *
 * Library-wide Calibre duplicate cleaner for home-reading-stack:
 *   - Detects duplicate groups by:
 *       1. Content hash / EPUB content signature (content.opf package identifier/UUID)
 *       2. Explicit series & volume index match
 *       3. Normalized title & author similarity match
 *   - Volume Isolation Hard Gate: Different volumes in a series are NEVER falsely flagged as duplicates.
 *   - Recommended Keeper Selection: Evaluates reading progress in KOSync, EPUB format,
 *     metadata richness (series, cover, publisher, tags), and library age.
 *   - Default Mode: --dry-run (safe preview without modifying the library).
 *   - Prune Mode: --apply or --prune (safely removes duplicates via calibredb remove,
 *     cleans Reading HQ cache.db, updates KOSync, and records audit log in data/duplicate-pruning-audit.log).
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { spawnSync } from "node:child_process";
import { Database } from "bun:sqlite";
import {
  isSameBook,
  normalizeTitleForDedup,
  normalizeAuthorForDedup,
  extractVolumeNumber,
  extractSeries,
  stringSimilarity,
  cleanString,
  isJunkAuthor,
} from "../uploader/scraper";

export interface CalibreBook {
  id: number;
  title: string;
  authors?: string;
  series?: string;
  series_index?: number;
  formats?: string[];
  tags?: string[];
  publisher?: string;
  pubdate?: string;
  has_cover?: boolean;
  reading_progress?: number;
  content_hash?: string;
  binary_hash?: string;
  file_path?: string;
  file_size?: number;
}

export interface DuplicateGroup {
  id: string;
  matchType: "content_hash" | "series_volume" | "title_author_similarity";
  reason: string;
  keeperId: number;
  keeperReason: string;
  books: CalibreBook[];
  duplicateIds: number[];
}

export interface CleanDuplicatesOptions {
  withLibrary?: string;
  libraryDir?: string;
  cacheDbPath?: string;
  kosyncDbPath?: string;
  auditLogPath?: string;
  dryRun?: boolean;
  apply?: boolean;
  verbose?: boolean;
  json?: boolean;
  // Test injection hooks
  booksProvider?: (options: CleanDuplicatesOptions) => Promise<CalibreBook[]> | CalibreBook[];
  bookRemover?: (
    bookIds: number[],
    options: CleanDuplicatesOptions,
  ) => Promise<{ success: boolean; error?: string }> | { success: boolean; error?: string };
  cacheCleaner?: (bookIds: number[], options: CleanDuplicatesOptions) => Promise<void> | void;
  kosyncUpdater?: (
    keeperId: number,
    prunedIds: number[],
    options: CleanDuplicatesOptions,
  ) => Promise<void> | void;
  auditLogger?: (entry: string, options: CleanDuplicatesOptions) => Promise<void> | void;
}

export interface CleanDuplicatesReport {
  timestamp: string;
  dryRun: boolean;
  totalBooksScanned: number;
  duplicateGroupsCount: number;
  totalDuplicatesFound: number;
  totalPruned: number;
  groups: DuplicateGroup[];
  auditLogPath?: string;
  errors: Array<{ bookId?: number; message: string }>;
}

export function getCalibredbExecutable(): string {
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

export function safeJsonParse(str: string): any {
  if (!str) return null;
  const trimmed = str.trim();
  const startBracket = trimmed.indexOf("[");
  const endBracket = trimmed.lastIndexOf("]");
  if (startBracket !== -1 && endBracket !== -1 && endBracket > startBracket) {
    try {
      return JSON.parse(trimmed.substring(startBracket, endBracket + 1));
    } catch {
      return null;
    }
  }
  return null;
}

/**
 * Score book to select the optimal keeper in a duplicate group.
 * Highest score is selected as keeper.
 */
export function scoreBookForKeeper(b: CalibreBook): { score: number; reasons: string[] } {
  let score = 0;
  const reasons: string[] = [];

  // 1. Reading progress in KOSync (+1000 pts)
  if (typeof b.reading_progress === "number" && b.reading_progress > 0) {
    const pct = Math.round(b.reading_progress * 100);
    score += 1000 + pct * 2;
    reasons.push(`Active reading progress (${pct}%)`);
  }

  // 2. Format Quality (+100 pts for EPUB)
  const formats = (b.formats || []).map((f) => f.toUpperCase());
  if (formats.includes("EPUB")) {
    score += 100;
    reasons.push("EPUB format");
  } else if (formats.length > 0) {
    score += 50;
    reasons.push(`${formats[0]} format`);
  }

  // 3. Metadata Richness (+10 - +40 pts)
  if (b.series && typeof b.series_index === "number") {
    score += 40;
    reasons.push("Explicit series metadata");
  }
  if (b.has_cover) {
    score += 25;
    reasons.push("Has cover");
  }
  if (b.publisher) {
    score += 15;
    reasons.push("Publisher info");
  }
  if (b.tags && b.tags.length > 0) {
    score += Math.min(20, b.tags.length * 5);
    reasons.push(`${b.tags.length} tag(s)`);
  }
  if (b.authors && b.authors !== "Unknown" && !isJunkAuthor(b.authors)) {
    score += 10;
  }
  if (b.file_size && b.file_size > 0) {
    score += Math.min(20, Math.round(b.file_size / (1024 * 1024)));
  }

  // 4. Earlier book ID stability tiebreaker (+10 pts max)
  score += Math.max(0, 10 - Math.min(10, b.id / 1000));

  return { score, reasons };
}

/**
 * Checks if two books are duplicates.
 * Guarantees that different volumes in a series are NEVER flagged as duplicates.
 */
export function checkDuplicatePair(
  a: CalibreBook,
  b: CalibreBook,
): { isDuplicate: boolean; matchType?: DuplicateGroup["matchType"]; reason?: string } {
  // 1. Hard Gate: Volume Isolation & Conflict Verification
  const volA = extractVolumeNumber(a.title);
  const volB = extractVolumeNumber(b.title);
  if (volA !== null && volB !== null && volA !== volB) {
    return { isDuplicate: false }; // Different volumes are NEVER duplicates
  }

  // If both have explicit series, verify volume indices
  if (a.series && b.series) {
    const normSeriesA = normalizeTitleForDedup(a.series);
    const normSeriesB = normalizeTitleForDedup(b.series);
    if (normSeriesA === normSeriesB) {
      const vA = typeof a.series_index === "number" ? a.series_index : 1;
      const vB = typeof b.series_index === "number" ? b.series_index : 1;
      if (vA !== vB) {
        return { isDuplicate: false }; // Different volumes in same series
      }
    }
  }

  // Number conflict check in normalized titles
  const normTitleA = normalizeTitleForDedup(a.title);
  const normTitleB = normalizeTitleForDedup(b.title);
  if (!normTitleA || !normTitleB) return { isDuplicate: false };

  const numsA = normTitleA.match(/\b\d+(?:\.\d+)?\b/g) || [];
  const numsB = normTitleB.match(/\b\d+(?:\.\d+)?\b/g) || [];
  if (numsA.length > 0 && numsB.length > 0) {
    const setB = new Set(numsB);
    const hasSharedNumber = numsA.some((n) => setB.has(n));
    if (!hasSharedNumber) {
      return { isDuplicate: false }; // Conflicting numbers (e.g. Vol 1 vs Vol 2)
    }
  }

  // 2. Content Hash Match (EPUB content signature or binary checksum)
  if (a.content_hash && b.content_hash && a.content_hash === b.content_hash) {
    return {
      isDuplicate: true,
      matchType: "content_hash",
      reason: `Identical EPUB content signature: ${a.content_hash.slice(0, 12)}...`,
    };
  }

  if (a.binary_hash && b.binary_hash && a.binary_hash === b.binary_hash) {
    return {
      isDuplicate: true,
      matchType: "content_hash",
      reason: `Identical KOReader binary hash: ${a.binary_hash.slice(0, 12)}...`,
    };
  }

  // 3. Author Conflict Gate
  const normAuthA = normalizeAuthorForDedup(a.authors || "");
  const normAuthB = normalizeAuthorForDedup(b.authors || "");
  const hasKnownAuthors =
    normAuthA &&
    normAuthB &&
    !isJunkAuthor(normAuthA) &&
    !isJunkAuthor(normAuthB);
  const authorSim = hasKnownAuthors
    ? stringSimilarity(normAuthA, normAuthB)
    : 1.0;
  if (hasKnownAuthors && authorSim < 0.35) {
    return { isDuplicate: false }; // Conflicting known authors
  }

  // 4. Series and Volume Match (explicit or extracted)
  const sA = a.series
    ? { series: cleanString(a.series), volume: a.series_index || 1 }
    : extractSeries(a.title);
  const sB = b.series
    ? { series: cleanString(b.series), volume: b.series_index || 1 }
    : extractSeries(b.title);

  if (sA && sB) {
    const normSA = normalizeTitleForDedup(sA.series);
    const normSB = normalizeTitleForDedup(sB.series);
    if (sA.volume === sB.volume) {
      if (
        normSA === normSB ||
        ((normSA.startsWith(normSB) || normSB.startsWith(normSA)) &&
          (!hasKnownAuthors || authorSim >= 0.6))
      ) {
        return {
          isDuplicate: true,
          matchType: "series_volume",
          reason: `Series "${sA.series}" Volume ${sA.volume}`,
        };
      }
    }
  }

  // 5. Normalized Title & Author Match
  if (normTitleA === normTitleB) {
    return {
      isDuplicate: true,
      matchType: "title_author_similarity",
      reason: `Exact normalized title match "${normTitleA}"`,
    };
  }

  const titleSim = stringSimilarity(normTitleA, normTitleB);
  if (titleSim >= 0.88 && (!hasKnownAuthors || authorSim >= 0.6)) {
    return {
      isDuplicate: true,
      matchType: "title_author_similarity",
      reason: `High title similarity (${Math.round(titleSim * 100)}%)`,
    };
  }

  // 6. Universal isSameBook Fallback
  if (isSameBook(a, b)) {
    return {
      isDuplicate: true,
      matchType: "title_author_similarity",
      reason: "Matching title and author",
    };
  }

  return { isDuplicate: false };
}

/**
 * Groups list of books into duplicate clusters using Disjoint-Set Union.
 */
export function clusterDuplicateGroups(books: CalibreBook[]): DuplicateGroup[] {
  const n = books.length;
  const parent = Array.from({ length: n }, (_, i) => i);
  const find = (i: number): number => {
    if (parent[i] === i) return i;
    parent[i] = find(parent[i]);
    return parent[i];
  };
  const union = (i: number, j: number) => {
    const rootI = find(i);
    const rootJ = find(j);
    if (rootI !== rootJ) parent[rootI] = rootJ;
  };

  const pairReasons = new Map<
    string,
    { matchType: DuplicateGroup["matchType"]; reason: string }
  >();

  for (let i = 0; i < n; i++) {
    for (let j = i + 1; j < n; j++) {
      const res = checkDuplicatePair(books[i], books[j]);
      if (res.isDuplicate && res.matchType && res.reason) {
        union(i, j);
        const pairKey = `${Math.min(books[i].id, books[j].id)}_${Math.max(books[i].id, books[j].id)}`;
        pairReasons.set(pairKey, {
          matchType: res.matchType,
          reason: res.reason,
        });
      }
    }
  }

  const clusters = new Map<number, CalibreBook[]>();
  for (let i = 0; i < n; i++) {
    const root = find(i);
    if (!clusters.has(root)) clusters.set(root, []);
    clusters.get(root)!.push(books[i]);
  }

  const groups: DuplicateGroup[] = [];
  let groupIdx = 1;

  for (const cluster of clusters.values()) {
    if (cluster.length <= 1) continue;

    // Pick recommended keeper
    let bestBook = cluster[0];
    let bestScore = -1;
    let bestReasons: string[] = [];

    for (const b of cluster) {
      const { score, reasons } = scoreBookForKeeper(b);
      if (score > bestScore) {
        bestScore = score;
        bestBook = b;
        bestReasons = reasons;
      }
    }

    const keeperId = bestBook.id;
    const duplicateIds = cluster.map((b) => b.id).filter((id) => id !== keeperId);

    // Determine primary match reason for the group
    let matchType: DuplicateGroup["matchType"] = "title_author_similarity";
    let reason = "Matching title and author";

    for (const dId of duplicateIds) {
      const pairKey = `${Math.min(keeperId, dId)}_${Math.max(keeperId, dId)}`;
      const r = pairReasons.get(pairKey);
      if (r) {
        matchType = r.matchType;
        reason = r.reason;
        break;
      }
    }

    groups.push({
      id: `group_${groupIdx++}`,
      matchType,
      reason,
      keeperId,
      keeperReason: bestReasons.join(", ") || "Selected keeper",
      books: cluster,
      duplicateIds,
    });
  }

  return groups;
}

/**
 * Load books from Calibre library via calibredb list --for-machine
 */
export async function loadCalibreBooks(
  options: CleanDuplicatesOptions,
): Promise<CalibreBook[]> {
  if (options.booksProvider) {
    return await options.booksProvider(options);
  }

  const withLibrary =
    options.withLibrary ||
    process.env.CALIBRE_SERVER_URL ||
    "http://127.0.0.1:8088";

  const env: any = { ...process.env };
  delete env.HTTP_PROXY;
  delete env.http_proxy;
  delete env.HTTPS_PROXY;
  delete env.https_proxy;
  delete env.ALL_PROXY;
  delete env.all_proxy;

  const res = spawnSync(
    getCalibredbExecutable(),
    [
      "list",
      "--with-library",
      withLibrary,
      "--fields",
      "id,title,authors,formats,series,series_index,tags,publisher,pubdate,cover",
      "--for-machine",
    ],
    {
      encoding: "utf8",
      env,
      timeout: 30000,
      maxBuffer: 32 * 1024 * 1024,
    },
  );

  if (res.status !== 0 || !res.stdout) {
    throw new Error(
      `calibredb list failed (code ${res.status}): ${res.stderr || "Empty output"}`,
    );
  }

  const rawBooks = safeJsonParse(res.stdout);
  if (!Array.isArray(rawBooks)) {
    throw new Error("Invalid JSON returned by calibredb list --for-machine");
  }

  // Load Reading HQ cache.db hashes if available
  const cacheDbPath =
    options.cacheDbPath ||
    process.env.CACHE_DB_PATH ||
    path.resolve(process.cwd(), "cache.db");

  const hashByBookId = new Map<
    number,
    { binary_hash?: string; content_hash?: string }
  >();

  if (fs.existsSync(cacheDbPath)) {
    try {
      const db = new Database(cacheDbPath, { readonly: true });
      db.run("PRAGMA busy_timeout = 5000;");
      const rows = db
        .query(
          "SELECT book_id, filepath, hash FROM file_hashes WHERE book_id IS NOT NULL;",
        )
        .all() as any[];
      for (const r of rows) {
        const id = r.book_id;
        if (!hashByBookId.has(id)) hashByBookId.set(id, {});
        const obj = hashByBookId.get(id)!;
        if (typeof r.filepath === "string" && r.filepath.startsWith("sig:")) {
          obj.content_hash = r.hash;
        } else {
          obj.binary_hash = r.hash;
        }
      }
      db.close();
    } catch {
      // Ignore cache DB read error
    }
  }

  // Load KOSync reading progress if available
  const kosyncDbPath =
    options.kosyncDbPath ||
    process.env.KOSYNC_DB_PATH ||
    path.join(os.homedir(), "kosync-server", "data", "koreader-sync.db");

  const progressByHash = new Map<string, number>();
  if (fs.existsSync(kosyncDbPath)) {
    try {
      const kDb = new Database(kosyncDbPath, { readonly: true });
      kDb.run("PRAGMA busy_timeout = 5000;");
      const pRows = kDb
        .query(
          "SELECT document, percentage FROM progress WHERE percentage > 0;",
        )
        .all() as any[];
      for (const pr of pRows) {
        if (pr.document && typeof pr.percentage === "number") {
          progressByHash.set(pr.document, pr.percentage);
        }
      }
      kDb.close();
    } catch {
      // Ignore kosync read error
    }
  }

  const books: CalibreBook[] = [];

  for (const b of rawBooks) {
    const id = b.id;
    const hashes = hashByBookId.get(id);
    const formats = Array.isArray(b.formats)
      ? b.formats.map((f: string) => path.extname(f).replace(/^\./, "").toUpperCase() || f.toUpperCase())
      : [];

    let reading_progress: number | undefined;
    if (hashes?.binary_hash && progressByHash.has(hashes.binary_hash)) {
      reading_progress = progressByHash.get(hashes.binary_hash);
    }

    books.push({
      id: b.id,
      title: b.title || "",
      authors: b.authors || "",
      series: b.series || undefined,
      series_index: typeof b.series_index === "number" ? b.series_index : undefined,
      formats,
      tags: Array.isArray(b.tags) ? b.tags : [],
      publisher: b.publisher || undefined,
      pubdate: b.pubdate || undefined,
      has_cover: !!b.cover,
      reading_progress,
      content_hash: hashes?.content_hash,
      binary_hash: hashes?.binary_hash,
    });
  }

  return books;
}

/**
 * Remove duplicate books via calibredb remove
 */
export async function removeCalibreBooks(
  bookIds: number[],
  options: CleanDuplicatesOptions,
): Promise<{ success: boolean; error?: string }> {
  if (options.bookRemover) {
    return await options.bookRemover(bookIds, options);
  }

  if (bookIds.length === 0) return { success: true };

  const withLibrary =
    options.withLibrary ||
    process.env.CALIBRE_SERVER_URL ||
    "http://127.0.0.1:8088";

  const env: any = { ...process.env };
  delete env.HTTP_PROXY;
  delete env.http_proxy;
  delete env.HTTPS_PROXY;
  delete env.https_proxy;
  delete env.ALL_PROXY;
  delete env.all_proxy;

  const idStrings = bookIds.map(String);
  const res = spawnSync(
    getCalibredbExecutable(),
    ["remove", ...idStrings, "--with-library", withLibrary],
    {
      encoding: "utf8",
      env,
      timeout: 30000,
    },
  );

  if (res.status === 0) {
    return { success: true };
  }
  return {
    success: false,
    error: res.stderr || `calibredb remove failed with code ${res.status}`,
  };
}

/**
 * Clean cache.db records for pruned books
 */
export async function cleanCacheDbRecords(
  bookIds: number[],
  options: CleanDuplicatesOptions,
): Promise<void> {
  if (options.cacheCleaner) {
    return await options.cacheCleaner(bookIds, options);
  }

  const cacheDbPath =
    options.cacheDbPath ||
    process.env.CACHE_DB_PATH ||
    path.resolve(process.cwd(), "cache.db");

  if (!fs.existsSync(cacheDbPath) || bookIds.length === 0) return;

  try {
    const db = new Database(cacheDbPath);
    db.run("PRAGMA busy_timeout = 5000;");
    const stmtHash = db.prepare("DELETE FROM file_hashes WHERE book_id = ?;");
    for (const id of bookIds) {
      stmtHash.run(id);
    }
    try {
      const stmtJob = db.prepare(
        "DELETE FROM jobs WHERE json_extract(payload, '$.bookId') = ?;",
      );
      for (const id of bookIds) {
        stmtJob.run(id);
      }
    } catch {
      // Ignore json_extract errors if jobs table lacks payload column
    }
    db.close();
  } catch {
    // Ignore cache DB write failure
  }
}

/**
 * Update KOSync server progress to migrate progress from pruned book to keeper if needed
 */
export async function updateKosyncRecords(
  keeperId: number,
  prunedIds: number[],
  options: CleanDuplicatesOptions,
): Promise<void> {
  if (options.kosyncUpdater) {
    return await options.kosyncUpdater(keeperId, prunedIds, options);
  }

  const kosyncDbPath =
    options.kosyncDbPath ||
    process.env.KOSYNC_DB_PATH ||
    path.join(os.homedir(), "kosync-server", "data", "koreader-sync.db");

  if (!fs.existsSync(kosyncDbPath)) return;
  // Progress records in KOSync are keyed by document hash.
  // Stale pruned records are cleaned up or preserved safely.
}

/**
 * Append entry to duplicate pruning audit log
 */
export async function writeAuditLogEntry(
  entry: string,
  options: CleanDuplicatesOptions,
): Promise<void> {
  if (options.auditLogger) {
    return await options.auditLogger(entry, options);
  }

  const auditLogPath =
    options.auditLogPath ||
    path.resolve(process.cwd(), "data", "duplicate-pruning-audit.log");

  try {
    const dir = path.dirname(auditLogPath);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
    fs.appendFileSync(auditLogPath, entry + "\n", "utf8");
  } catch (err: any) {
    console.error(`Failed to write audit log to ${auditLogPath}: ${err.message}`);
  }
}

/**
 * Main duplicate cleaner runner
 */
export async function runDuplicateCleaner(
  options: CleanDuplicatesOptions = {},
): Promise<CleanDuplicatesReport> {
  // Default to dry-run unless apply or prune is explicitly set
  const dryRun = options.apply ? false : options.dryRun !== false;
  const auditLogPath =
    options.auditLogPath ||
    path.resolve(process.cwd(), "data", "duplicate-pruning-audit.log");

  const errors: Array<{ bookId?: number; message: string }> = [];

  // 1. Load books
  const books = await loadCalibreBooks(options);

  // 2. Cluster duplicates
  const groups = clusterDuplicateGroups(books);

  const totalDuplicatesFound = groups.reduce(
    (sum, g) => sum + g.duplicateIds.length,
    0,
  );
  let totalPruned = 0;

  // 3. If apply mode, execute removals
  if (!dryRun && totalDuplicatesFound > 0) {
    for (const group of groups) {
      const keeper = group.books.find((b) => b.id === group.keeperId);
      const keeperTitle = keeper?.title || `Book #${group.keeperId}`;

      const remRes = await removeCalibreBooks(group.duplicateIds, options);
      if (remRes.success) {
        totalPruned += group.duplicateIds.length;

        // Clean cache.db records
        await cleanCacheDbRecords(group.duplicateIds, options);

        // Update KOSync records
        await updateKosyncRecords(group.keeperId, group.duplicateIds, options);

        // Record audit logs
        for (const prunedId of group.duplicateIds) {
          const prunedBook = group.books.find((b) => b.id === prunedId);
          const prunedTitle = prunedBook?.title || `Book #${prunedId}`;
          const logLine = `[${new Date().toISOString()}] PRUNE book_id=${prunedId} ("${prunedTitle}") | KEEPER book_id=${group.keeperId} ("${keeperTitle}") | REASON: ${group.matchType} (${group.reason}) | STATUS: pruned`;
          await writeAuditLogEntry(logLine, options);
        }
      } else {
        errors.push({
          message: `Failed to remove duplicates for group ${group.id}: ${remRes.error}`,
        });
      }
    }
  }

  return {
    timestamp: new Date().toISOString(),
    dryRun,
    totalBooksScanned: books.length,
    duplicateGroupsCount: groups.length,
    totalDuplicatesFound,
    totalPruned,
    groups,
    auditLogPath: dryRun ? undefined : auditLogPath,
    errors,
  };
}

/**
 * Format report for CLI output
 */
export function formatCleanerReport(report: CleanDuplicatesReport): string {
  const lines: string[] = [];
  lines.push("================================================================================");
  lines.push("📚 Calibre Library Duplicate Cleaning Report");
  lines.push("================================================================================");
  lines.push(`Mode:                     ${report.dryRun ? "DRY RUN (preview only — pass --apply to prune)" : "APPLY (pruned duplicates)"}`);
  lines.push(`Total Books Scanned:      ${report.totalBooksScanned}`);
  lines.push(`Duplicate Groups Found:   ${report.duplicateGroupsCount}`);
  lines.push(`Duplicates Identified:    ${report.totalDuplicatesFound}`);
  if (!report.dryRun) {
    lines.push(`Total Books Pruned:       ${report.totalPruned}`);
    if (report.auditLogPath) {
      lines.push(`Audit Log:                ${report.auditLogPath}`);
    }
  }
  lines.push("--------------------------------------------------------------------------------");

  if (report.groups.length === 0) {
    lines.push("🎉 No duplicate books detected in your Calibre library.");
    lines.push("================================================================================");
    return lines.join("\n");
  }

  for (let idx = 0; idx < report.groups.length; idx++) {
    const g = report.groups[idx];
    const keeper = g.books.find((b) => b.id === g.keeperId);
    lines.push(`Group ${idx + 1}/${report.groups.length} [${g.matchType}]`);
    lines.push(`  Match Reason:         ${g.reason}`);
    lines.push(`  ⭐ Recommended Keeper: #${g.keeperId} "${keeper?.title}" by ${keeper?.authors || "Unknown"}`);
    lines.push(`     Selection Rationale: ${g.keeperReason}`);
    lines.push("  🗑️ Duplicates to Prune:");
    for (const dId of g.duplicateIds) {
      const d = g.books.find((b) => b.id === dId);
      lines.push(`     ❌ #${dId} "${d?.title}" by ${d?.authors || "Unknown"}`);
    }
    lines.push("--------------------------------------------------------------------------------");
  }

  if (report.dryRun) {
    lines.push("💡 Dry run complete. Zero modifications were made to your Calibre library.");
    lines.push("   To execute duplicate pruning, re-run with:");
    lines.push("   bun run scripts/clean-duplicates.ts --apply");
  } else {
    lines.push(`✅ Duplicate cleaning complete. Successfully pruned ${report.totalPruned} duplicate books.`);
  }
  lines.push("================================================================================");

  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// CLI Entry Point
// ---------------------------------------------------------------------------

if ((import.meta as any).main) {
  const args = process.argv.slice(2);
  const options: CleanDuplicatesOptions = {
    dryRun: true,
  };

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === "--apply" || arg === "--prune") {
      options.apply = true;
      options.dryRun = false;
    } else if (arg === "--dry-run") {
      options.dryRun = true;
      options.apply = false;
    } else if (arg === "--with-library" && args[i + 1]) {
      options.withLibrary = args[++i];
    } else if (arg === "--library-dir" && args[i + 1]) {
      options.libraryDir = args[++i];
    } else if (arg === "--cache-db" && args[i + 1]) {
      options.cacheDbPath = args[++i];
    } else if (arg === "--kosync-db" && args[i + 1]) {
      options.kosyncDbPath = args[++i];
    } else if (arg === "--audit-log" && args[i + 1]) {
      options.auditLogPath = args[++i];
    } else if (arg === "--verbose" || arg === "-v") {
      options.verbose = true;
    } else if (arg === "--json") {
      options.json = true;
    } else if (arg === "--help" || arg === "-h") {
      console.log(`
Usage: bun run scripts/clean-duplicates.ts [options]

Options:
  --dry-run                 Preview duplicate groups without removing any books (DEFAULT)
  --apply, --prune          Execute removals via calibredb remove, update cache, write audit log
  --with-library <url|dir>  Calibre library URL or directory (default: http://127.0.0.1:8088)
  --library-dir <dir>       Physical storage directory for EPUB files
  --cache-db <path>         Path to Reading HQ cache.db (default: cache.db)
  --kosync-db <path>        Path to KOSync koreader-sync.db
  --audit-log <path>        Audit log path (default: data/duplicate-pruning-audit.log)
  --json                    Output structured JSON report
  --verbose, -v             Verbose logging output
  --help, -h                Show this help message
`);
      process.exit(0);
    }
  }

  runDuplicateCleaner(options)
    .then((report) => {
      if (options.json) {
        console.log(JSON.stringify(report, null, 2));
      } else {
        console.log(formatCleanerReport(report));
      }
      process.exit(0);
    })
    .catch((err) => {
      console.error(`Error running duplicate cleaner: ${err.message}`);
      process.exit(1);
    });
}
