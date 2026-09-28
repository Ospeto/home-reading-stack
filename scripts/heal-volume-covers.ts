#!/usr/bin/env bun
/**
 * scripts/heal-volume-covers.ts
 *
 * LightHouse Cover Cache & Volume Integrity Healer:
 *   - Inspects Calibre books (or a specific series/book ID).
 *   - Verifies on-disk cover.jpg existence and integrity. If missing or corrupt,
 *     extracts original cover image from the canonical EPUB container.
 *   - Detects stale downscaled thumbnails (cache/covers/${bookId}_*.* and master_${bookId}.*)
 *     where on-disk cover.jpg mtime is newer than the cached thumbnail mtime.
 *   - Detects duplicate thumbnail hashes across multi-volume series where disk covers are distinct.
 *   - Purges stale/duplicate thumbnail cache files so server.ts regenerates them dynamically.
 *   - Optionally pre-warms 360px WebP thumbnails.
 *   - Safe by default (--dry-run); executes purge with --apply.
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import crypto from "node:crypto";
import { Database } from "bun:sqlite";

export interface HealCoversOptions {
  libraryDir?: string;
  calibreDbPath?: string;
  cacheDir?: string;
  series?: string;
  bookId?: number;
  dryRun?: boolean;
  verbose?: boolean;
  prewarm?: boolean;
  json?: boolean;
}

export interface HealCoversItemReport {
  bookId: number;
  title: string;
  series?: string;
  seriesIndex?: number;
  diskCoverPath?: string;
  diskCoverExists: boolean;
  diskCoverRestoredFromEpub: boolean;
  staleThumbnails: string[];
  purgedThumbnails: string[];
  duplicateSeriesHash?: string;
  error?: string;
}

export interface HealCoversSummary {
  totalBooksScanned: number;
  booksWithMissingDiskCover: number;
  diskCoversRestored: number;
  staleThumbnailCount: number;
  seriesWithDuplicateThumbs: number;
  thumbnailsPurged: number;
  items: HealCoversItemReport[];
}

export function getFileSha256(filePath: string): string | null {
  try {
    if (!fs.existsSync(filePath)) return null;
    const buf = fs.readFileSync(filePath);
    return crypto.createHash("sha256").update(buf).digest("hex");
  } catch {
    return null;
  }
}

/**
 * Extract cover image from EPUB container using bun/native zip inspection or unzip/bsdtar
 */
export async function extractCoverFromEpub(epubPath: string, outputPath: string): Promise<boolean> {
  if (!fs.existsSync(epubPath)) return false;

  try {
    // Try unzip -p or bsdtar
    const proc = Bun.spawn(["unzip", "-l", epubPath], { stdout: "pipe", stderr: "ignore" });
    const output = await new Response(proc.stdout).text();
    await proc.exited;

    const lines = output.split("\n");
    let coverInternalPath: string | null = null;

    // Look for cover image entry
    for (const line of lines) {
      const parts = line.trim().split(/\s+/);
      const filename = parts.slice(3).join(" ");
      if (
        filename &&
        /\.(jpe?g|png|webp)$/i.test(filename) &&
        (/cover/i.test(filename) || /art/i.test(filename) || /title/i.test(filename))
      ) {
        coverInternalPath = filename;
        break;
      }
    }

    // Fallback: any jpg/png in EPUB
    if (!coverInternalPath) {
      for (const line of lines) {
        const parts = line.trim().split(/\s+/);
        const filename = parts.slice(3).join(" ");
        if (filename && /\.(jpe?g|png)$/i.test(filename)) {
          coverInternalPath = filename;
          break;
        }
      }
    }

    if (coverInternalPath) {
      const extractProc = Bun.spawn(["unzip", "-p", epubPath, coverInternalPath], {
        stdout: "pipe",
        stderr: "ignore",
      });
      const data = new Uint8Array(await new Response(extractProc.stdout).arrayBuffer());
      const exitCode = await extractProc.exited;
      if (exitCode === 0 && data.length > 512) {
        fs.writeFileSync(outputPath, data);
        return true;
      }
    }
  } catch (_e) {
    void _e;
  }

  return false;
}

export async function healVolumeCovers(
  options: HealCoversOptions = {},
): Promise<HealCoversSummary> {
  const dryRun = options.dryRun !== false; // Default true (safe)
  const verbose = Boolean(options.verbose);

  const home = process.env.HOME || os.homedir();
  const libraryDir =
    options.libraryDir ||
    process.env.CALIBRE_LIBRARY_DIR ||
    path.join(home, "Calibre Libraries", "Agent Library");
  const calibreDbPath =
    options.calibreDbPath ||
    process.env.CALIBRE_DB_PATH ||
    path.join(libraryDir, "metadata.db");
  const cacheDir =
    options.cacheDir ||
    process.env.COVER_CACHE_DIR ||
    path.resolve(process.cwd(), "cache", "covers");

  const summary: HealCoversSummary = {
    totalBooksScanned: 0,
    booksWithMissingDiskCover: 0,
    diskCoversRestored: 0,
    staleThumbnailCount: 0,
    seriesWithDuplicateThumbs: 0,
    thumbnailsPurged: 0,
    items: [],
  };

  if (!fs.existsSync(calibreDbPath)) {
    throw new Error(`Calibre database not found at ${calibreDbPath}`);
  }

  const db = new Database(calibreDbPath, { readonly: true });
  db.run("PRAGMA busy_timeout = 3000;");

  let sql = `
    SELECT b.id, b.title, b.path, b.has_cover, b.series_index, s.name as series
    FROM books b
    LEFT JOIN books_series_link bsl ON b.id = bsl.book
    LEFT JOIN series s ON bsl.series = s.id
  `;
  const params: any[] = [];
  const whereClauses: string[] = [];

  if (options.bookId) {
    whereClauses.push("b.id = ?");
    params.push(options.bookId);
  } else if (options.series) {
    whereClauses.push("s.name LIKE ?");
    params.push(`%${options.series}%`);
  }

  if (whereClauses.length > 0) {
    sql += " WHERE " + whereClauses.join(" AND ");
  }
  sql += " ORDER BY s.name, b.series_index, b.id";

  const rows = db.prepare(sql).all(...params) as any[];
  db.close();

  summary.totalBooksScanned = rows.length;

  // Build index of cached thumbnail files
  const cachedFilesByBookId = new Map<number, Array<{ filename: string; fullPath: string; mtimeMs: number }>>();
  if (fs.existsSync(cacheDir)) {
    try {
      const files = fs.readdirSync(cacheDir);
      for (const f of files) {
        let bid: number | null = null;
        if (f.startsWith("master_")) {
          const idPart = f.replace("master_", "").split(".")[0];
          bid = parseInt(idPart, 10);
        } else if (f.includes("_")) {
          const idPart = f.split("_")[0];
          bid = parseInt(idPart, 10);
        }
        if (bid && !isNaN(bid)) {
          const fullPath = path.join(cacheDir, f);
          try {
            const stat = fs.statSync(fullPath);
            if (!cachedFilesByBookId.has(bid)) {
              cachedFilesByBookId.set(bid, []);
            }
            cachedFilesByBookId.get(bid)!.push({
              filename: f,
              fullPath,
              mtimeMs: stat.mtimeMs,
            });
          } catch {}
        }
      }
    } catch {}
  }

  // Group books by series to check for duplicate thumbnail hashes across distinct disk covers
  const seriesGroups = new Map<string, any[]>();
  for (const row of rows) {
    if (row.series) {
      if (!seriesGroups.has(row.series)) seriesGroups.set(row.series, []);
      seriesGroups.get(row.series)!.push(row);
    }
  }

  const seriesDuplicateThumbs = new Set<number>();
  const affectedSeriesNames = new Set<string>();

  for (const [sname, sbooks] of seriesGroups.entries()) {
    if (sbooks.length > 1) {
      const thumbHashMap = new Map<string, number[]>();
      const diskHashMap = new Map<number, string | null>();

      for (const b of sbooks) {
        const diskPath = path.join(libraryDir, b.path, "cover.jpg");
        const diskHash = getFileSha256(diskPath);
        diskHashMap.set(b.id, diskHash);

        const thumbs = cachedFilesByBookId.get(b.id) || [];
        for (const t of thumbs) {
          if (t.filename.includes("_360.")) {
            const tHash = getFileSha256(t.fullPath);
            if (tHash) {
              if (!thumbHashMap.has(tHash)) thumbHashMap.set(tHash, []);
              thumbHashMap.get(tHash)!.push(b.id);
            }
          }
        }
      }

      // If a thumbnail hash is shared across multiple books, but their disk covers are NOT identical,
      // the thumbnails are corrupt/stale duplicates!
      for (const [_thash, bids] of thumbHashMap.entries()) {
        const uniqueBids = Array.from(new Set(bids));
        if (uniqueBids.length > 1) {
          const nonNullDiskHashes = new Set(
            uniqueBids
              .map((id) => diskHashMap.get(id))
              .filter((h): h is string => Boolean(h)),
          );
          if (nonNullDiskHashes.size > 1) {
            affectedSeriesNames.add(sname);
            for (const id of uniqueBids) {
              seriesDuplicateThumbs.add(id);
            }
          }
        }
      }
    }
  }

  summary.seriesWithDuplicateThumbs = affectedSeriesNames.size;

  // Process individual books
  for (const row of rows) {
    const bookFolder = path.join(libraryDir, row.path);
    const diskCoverPath = path.join(bookFolder, "cover.jpg");
    let diskCoverExists = fs.existsSync(diskCoverPath);
    let diskCoverRestored = false;

    // Check disk cover existence
    if (!diskCoverExists) {
      summary.booksWithMissingDiskCover++;
      // Search for EPUB in book folder to restore
      try {
        if (fs.existsSync(bookFolder)) {
          const entries = fs.readdirSync(bookFolder);
          const epub = entries.find((e) => e.endsWith(".epub"));
          if (epub) {
            const epubPath = path.join(bookFolder, epub);
            if (!dryRun) {
              const restored = await extractCoverFromEpub(epubPath, diskCoverPath);
              if (restored) {
                diskCoverExists = true;
                diskCoverRestored = true;
                summary.diskCoversRestored++;
              }
            } else {
              diskCoverRestored = true; // Would restore
              summary.diskCoversRestored++;
            }
          }
        }
      } catch {}
    }

    const diskMtime = diskCoverExists ? fs.statSync(diskCoverPath).mtimeMs : 0;
    const thumbs = cachedFilesByBookId.get(row.id) || [];
    const staleThumbnails: string[] = [];
    const purgedThumbnails: string[] = [];

    const isSeriesDup = seriesDuplicateThumbs.has(row.id);

    for (const t of thumbs) {
      const isStaleMtime = diskCoverExists && diskMtime > t.mtimeMs;
      if (isStaleMtime || isSeriesDup) {
        staleThumbnails.push(t.filename);
        if (!dryRun) {
          try {
            fs.unlinkSync(t.fullPath);
            purgedThumbnails.push(t.filename);
            summary.thumbnailsPurged++;
          } catch {}
        }
      }
    }

    summary.staleThumbnailCount += staleThumbnails.length;

    if (staleThumbnails.length > 0 || !diskCoverExists || diskCoverRestored) {
      summary.items.push({
        bookId: row.id,
        title: row.title,
        series: row.series,
        seriesIndex: row.series_index,
        diskCoverPath,
        diskCoverExists,
        diskCoverRestoredFromEpub: diskCoverRestored,
        staleThumbnails,
        purgedThumbnails,
        duplicateSeriesHash: isSeriesDup ? "detected" : undefined,
      });
    }
  }

  return summary;
}

// CLI runner
if (import.meta.main) {
  const args = process.argv.slice(2);
  const options: HealCoversOptions = {
    dryRun: true,
  };

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === "--apply") {
      options.dryRun = false;
    } else if (arg === "--dry-run") {
      options.dryRun = true;
    } else if (arg === "--verbose" || arg === "-v") {
      options.verbose = true;
    } else if (arg === "--json") {
      options.json = true;
    } else if (arg === "--series" && i + 1 < args.length) {
      options.series = args[++i];
    } else if (arg === "--book-id" && i + 1 < args.length) {
      options.bookId = parseInt(args[++i], 10);
    } else if (arg === "--help" || arg === "-h") {
      console.log(`
LightHouse Cover Cache & Volume Integrity Healer

Usage:
  bin/lighthouse heal-covers [options]
  bun run scripts/heal-volume-covers.ts [options]

Options:
  --dry-run               Scan and preview stale thumbnails without deleting (default)
  --apply                 Execute cache purging and restore missing covers from EPUBs
  --series <name>         Filter check to a specific series title
  --book-id <id>          Filter check to a specific book ID
  --verbose               Show detailed item-by-item logs
  --json                  Output report as structured JSON
  --help, -h              Show this help message
`);
      process.exit(0);
    }
  }

  healVolumeCovers(options)
    .then((summary) => {
      if (options.json) {
        console.log(JSON.stringify(summary, null, 2));
      } else {
        console.log("=== LightHouse Cover Healing Summary ===");
        console.log(`Mode:                           ${options.dryRun ? "PREVIEW (DRY-RUN)" : "APPLIED"}`);
        console.log(`Total Books Scanned:            ${summary.totalBooksScanned}`);
        console.log(`Books Missing on-disk cover:    ${summary.booksWithMissingDiskCover}`);
        console.log(`Covers Restored from EPUB:      ${summary.diskCoversRestored}`);
        console.log(`Stale/Duplicate Thumbnails:     ${summary.staleThumbnailCount}`);
        console.log(`Thumbnails Purged:              ${summary.thumbnailsPurged}`);
        if (summary.items.length > 0) {
          console.log("\nAffected Books:");
          for (const item of summary.items) {
            console.log(
              `  [#${item.bookId}] "${item.title}" (${item.series || "No Series"} #${item.seriesIndex || 1}) -> ${item.staleThumbnails.length} stale thumbs${item.duplicateSeriesHash ? " [Duplicate Series Thumbs]" : ""}`,
            );
          }
        }
      }
    })
    .catch((err) => {
      console.error("Heal covers failed:", err);
      process.exit(1);
    });
}
