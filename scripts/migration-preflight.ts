#!/usr/bin/env bun
/**
 * scripts/migration-preflight.ts
 *
 * Safe, read-only preflight analysis and inventory tool for migrating EPUBs
 * from the Mac Mini library (/Volumes/Ospeto_SSD/Calibre Library) into the
 * canonical Calibre library (/Users/ospeto/Calibre Libraries/Agent Library).
 *
 * CRITICAL SAFETY INVARIANT:
 * This script is strictly READ-ONLY. It will NEVER copy, rename, delete,
 * or modify files or databases in either Calibre library.
 */

import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { Database } from "bun:sqlite";

export interface PreflightOptions {
  sourceLibraryPath?: string;
  targetLibraryPath?: string;
  generateBatchScript?: string | null;
  batchSize?: number;
}

export interface MigrationInventory {
  sourcePath: string;
  targetPath: string;
  sourceTotalBooks: number;
  sourceTotalEpubs: number;
  sourceNonEpubsExcluded: Array<{ id: number; title: string; format: string }>;
  targetTotalEpubs: number;
  exactDuplicates: Array<{
    id: number;
    title: string;
    authors: string;
    file: string;
  }>;
  newEpubCandidates: Array<{
    id: number;
    title: string;
    authors: string;
    series: string | null;
    seriesIndex: number | null;
    file: string;
  }>;
}

export function cleanTitle(str: string): string {
  if (!str) return "";
  return str
    .toLowerCase()
    .replace(
      /\[.*?(ebook|pdf|epub|channel|mobi|azw|scan|myanmar|tg|bookr).*?\]/gi,
      " ",
    )
    .replace(
      /\((.*?)(ebook|pdf|epub|channel|mobi|azw|scan|myanmar|tg|bookr)(.*?)\)/gi,
      " ",
    )
    .replace(/[^a-z0-9\u00A0-\uFFFF]+/g, " ")
    .trim();
}

/**
 * Normalizes title and author together for high-accuracy duplicate matching.
 * Prevents false positives between different books sharing common titles.
 */
export function normalizeTitleAndAuthor(
  title: string,
  authors?: string,
): string {
  const t = cleanTitle(title);
  const a = cleanTitle(authors || "");
  const isJunkAuthor =
    !a || a === "unknown" || a === "anonymous" || a === "admin";
  return isJunkAuthor ? `${t}:::unknown` : `${t}:::${a}`;
}

/**
 * Run safe read-only preflight inventory comparing source and target Calibre libraries.
 */
export function runMigrationPreflight(
  options: PreflightOptions = {},
): MigrationInventory {
  const defaultSource =
    process.env.CALIBRE_SOURCE_LIBRARY_DIR ||
    "/Volumes/Ospeto_SSD/Calibre Library";
  const defaultTarget =
    process.env.CALIBRE_LIBRARY_DIR ||
    "/Users/ospeto/Calibre Libraries/Agent Library";

  const sourcePath = options.sourceLibraryPath || defaultSource;
  const targetPath = options.targetLibraryPath || defaultTarget;

  const sourceDbPath = path.join(sourcePath, "metadata.db");
  const targetDbPath = path.join(targetPath, "metadata.db");

  if (!fs.existsSync(sourceDbPath)) {
    throw new Error(`Source Calibre metadata.db not found at: ${sourceDbPath}`);
  }
  if (!fs.existsSync(targetDbPath)) {
    throw new Error(`Target Calibre metadata.db not found at: ${targetDbPath}`);
  }

  // Open both databases in strictly READ-ONLY mode
  const srcDb = new Database(sourceDbPath, { readonly: true });
  const tgtDb = new Database(targetDbPath, { readonly: true });

  srcDb.run("PRAGMA busy_timeout = 5000;");
  tgtDb.run("PRAGMA busy_timeout = 5000;");

  const sourceTotalBooks =
    (srcDb.query("SELECT count(*) as count FROM books;").get() as any)?.count ||
    0;

  // Query all EPUB files in source library
  const srcEpubRows = srcDb
    .query(`
    SELECT b.id, b.title, b.path, b.series_index,
           GROUP_CONCAT(DISTINCT a.name) as authors,
           s.name as series,
           d.format, d.name as filename
    FROM books b
    JOIN data d ON b.id = d.book
    LEFT JOIN books_authors_link bal ON b.id = bal.book
    LEFT JOIN authors a ON bal.author = a.id
    LEFT JOIN books_series_link bsl ON b.id = bsl.book
    LEFT JOIN series s ON bsl.series = s.id
    WHERE UPPER(d.format) = 'EPUB'
    GROUP BY b.id
    ORDER BY b.id ASC;
  `)
    .all() as any[];

  // Query non-EPUB formats in source library to document excluded formats
  const srcNonEpubRows = srcDb
    .query(`
    SELECT b.id, b.title, d.format
    FROM books b
    JOIN data d ON b.id = d.book
    WHERE UPPER(d.format) != 'EPUB'
    GROUP BY b.id, d.format
    ORDER BY d.format ASC;
  `)
    .all() as any[];

  // Query all existing EPUBs in target library
  const tgtEpubRows = tgtDb
    .query(`
    SELECT b.id, b.title, b.path,
           GROUP_CONCAT(DISTINCT a.name) as authors,
           d.name as filename
    FROM books b
    JOIN data d ON b.id = d.book
    LEFT JOIN books_authors_link bal ON b.id = bal.book
    LEFT JOIN authors a ON bal.author = a.id
    WHERE UPPER(d.format) = 'EPUB'
    GROUP BY b.id;
  `)
    .all() as any[];

  srcDb.close();
  tgtDb.close();

  // Index target library books by normalized title PLUS author
  const targetMap = new Map<string, any>();
  const targetTitleMap = new Map<string, any[]>();

  for (const t of tgtEpubRows) {
    const compoundKey = normalizeTitleAndAuthor(t.title, t.authors);
    const titleKey = cleanTitle(t.title);

    if (compoundKey) {
      targetMap.set(compoundKey, t);
    }
    if (titleKey) {
      if (!targetTitleMap.has(titleKey)) {
        targetTitleMap.set(titleKey, []);
      }
      targetTitleMap.get(titleKey)!.push(t);
    }
  }

  const exactDuplicates: MigrationInventory["exactDuplicates"] = [];
  const newEpubCandidates: MigrationInventory["newEpubCandidates"] = [];

  for (const src of srcEpubRows) {
    const relFile = path.join(src.path, `${src.filename}.epub`);
    const fullSourceFilePath = path.join(sourcePath, relFile);

    const compoundKey = normalizeTitleAndAuthor(src.title, src.authors);
    const titleKey = cleanTitle(src.title);
    const srcAuthor = cleanTitle(src.authors || "");

    let isDuplicate = false;

    // 1. Primary match: normalized Title PLUS Author
    if (targetMap.has(compoundKey)) {
      isDuplicate = true;
    } else if (titleKey && targetTitleMap.has(titleKey)) {
      // 2. Secondary match: Title match with author compatibility check
      const candidates = targetTitleMap.get(titleKey)!;
      for (const cand of candidates) {
        const candAuthor = cleanTitle(cand.authors || "");
        const hasBothAuthors =
          srcAuthor &&
          candAuthor &&
          srcAuthor !== "unknown" &&
          candAuthor !== "unknown";

        if (!hasBothAuthors) {
          // If either author is unknown/missing, title match is treated as duplicate to be safe
          isDuplicate = true;
          break;
        }

        // Both authors are known: verify they are actually the same or compatible
        if (
          srcAuthor === candAuthor ||
          srcAuthor.includes(candAuthor) ||
          candAuthor.includes(srcAuthor)
        ) {
          isDuplicate = true;
          break;
        }
      }
    }

    if (isDuplicate) {
      exactDuplicates.push({
        id: src.id,
        title: src.title || "Untitled",
        authors: src.authors || "Unknown",
        file: fullSourceFilePath,
      });
    } else {
      newEpubCandidates.push({
        id: src.id,
        title: src.title || "Untitled",
        authors: src.authors || "Unknown",
        series: src.series || null,
        seriesIndex: src.series_index || null,
        file: fullSourceFilePath,
      });
    }
  }

  return {
    sourcePath,
    targetPath,
    sourceTotalBooks,
    sourceTotalEpubs: srcEpubRows.length,
    sourceNonEpubsExcluded: srcNonEpubRows.map((r) => ({
      id: r.id,
      title: r.title,
      format: r.format,
    })),
    targetTotalEpubs: tgtEpubRows.length,
    exactDuplicates,
    newEpubCandidates,
  };
}

/**
 * CLI Execution Handler
 */
if (import.meta.main) {
  console.log(
    "===================================================================",
  );
  console.log(
    "  Home Reading Stack: EPUB Migration Preflight & Inventory Analysis",
  );
  console.log(
    "===================================================================\n",
  );
  console.log(
    "🔒 [SAFETY CHECK]: Running in strictly READ-ONLY analysis mode.",
  );
  console.log(
    "   No live Calibre files or metadata databases will be modified.\n",
  );

  try {
    const inventory = runMigrationPreflight();

    console.log(`📁 Source Library: ${inventory.sourcePath}`);
    console.log(`   - Total Registered Books: ${inventory.sourceTotalBooks}`);
    console.log(`   - EPUB Format Books:      ${inventory.sourceTotalEpubs}`);
    console.log(
      `   - Non-EPUB Formats Skipped: ${inventory.sourceNonEpubsExcluded.length} (e.g. KFX, AZW, TXT)\n`,
    );

    console.log(`📁 Target Canonical Library: ${inventory.targetPath}`);
    console.log(`   - Existing EPUB Books:    ${inventory.targetTotalEpubs}\n`);

    console.log(
      "-------------------------------------------------------------------",
    );
    console.log("  INVENTORY MATCHING RESULTS");
    console.log(
      "-------------------------------------------------------------------",
    );
    console.log(
      `✅ New Unique EPUBs to Migrate:     ${inventory.newEpubCandidates.length}`,
    );
    console.log(
      `⚠️ Existing Duplicates (Will Skip): ${inventory.exactDuplicates.length}\n`,
    );

    if (inventory.exactDuplicates.length > 0) {
      console.log(
        "Sample Existing Duplicates Detected (Matched on Title + Author):",
      );
      for (const d of inventory.exactDuplicates.slice(0, 5)) {
        console.log(`  • [#${d.id}] "${d.title}" by ${d.authors}`);
      }
      if (inventory.exactDuplicates.length > 5) {
        console.log(
          `    ... and ${inventory.exactDuplicates.length - 5} more.`,
        );
      }
      console.log("");
    }

    console.log("Sample New Unique EPUB Candidates Ready for Migration:");
    for (const c of inventory.newEpubCandidates.slice(0, 8)) {
      const seriesBadge = c.series
        ? ` [Series: ${c.series} #${c.seriesIndex || 1}]`
        : "";
      console.log(`  • [#${c.id}] "${c.title}" by ${c.authors}${seriesBadge}`);
    }
    if (inventory.newEpubCandidates.length > 8) {
      console.log(
        `    ... and ${inventory.newEpubCandidates.length - 8} more.`,
      );
    }
    console.log("");

    console.log(
      "===================================================================",
    );
    console.log("  RECOMMENDED MIGRATION PROCEDURE (SUPERVISED STEP)");
    console.log(
      "===================================================================",
    );
    console.log("1. OFFLINE SNAPSHOT BACKUP (MANDATORY BEFORE IMPORT):");
    console.log("   Run this command while calibre-server is stopped or idle:");
    console.log(
      `   cp -a "${inventory.targetPath}" "${inventory.targetPath}.backup.$(date +%Y%m%d_%H%M%S)"\n`,
    );

    console.log("2. BATCH IMPORT COMMAND (VIA CALIBREDB HTTP API):");
    console.log(
      "   calibredb add --with-library http://127.0.0.1:8088 --automerge ignore <path-to-epub>\n",
    );

    console.log("3. POST-MIGRATION VERIFICATION CHECKLIST:");
    console.log(
      "   • OPDS Feed:       curl -s http://127.0.0.1:8088/opds | head -n 25",
    );
    console.log(
      "   • Reading HQ API:  curl -s http://127.0.0.1:8086/api/books | jq length",
    );
    console.log(
      "   • Telegram Bot:    Send /recent and /reading to verify catalog refresh",
    );
    console.log(
      "   • KOReader Sync:   Verify synchronization at https://kosync.wavypremium.xyz\n",
    );

    console.log(
      "🔒 [SAFETY GUARD VERIFIED]: Preflight analysis completed successfully.",
    );
    console.log(
      "   Zero files were modified. The live libraries remain intact.\n",
    );
  } catch (err: any) {
    console.error("❌ Preflight check failed:", err.message);
    process.exit(1);
  }
}
