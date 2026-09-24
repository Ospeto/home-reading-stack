/**
 * uploader/highlights.ts
 *
 * LightHouse Highlights Database & Indexing Engine.
 *
 * Manages storage, indexing, retrieval, deduplication, and on-demand backfilling
 * of book highlights and quotes from:
 *   - KOReader Joplin Clipper sync (POST /notes)
 *   - LightHouse Obsidian sync (scripts/sync-obsidian.ts)
 *   - Local Obsidian vault markdown notes (<vault>/Books/*.md)
 *   - KOReader .sdr sidecar metadata files
 *
 * Schema:
 *   Table `book_highlights` in `cache.db` with UNIQUE(book_title, quote) ON CONFLICT REPLACE
 *   Indexes on book_id and book_title for instant sub-millisecond queries.
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { Database } from "bun:sqlite";

// ----------------------------------------------------------------------------
// Interfaces & Types
// ----------------------------------------------------------------------------

export interface HighlightRecord {
  id?: number;
  book_id: number | null;
  book_title: string;
  chapter: string | null;
  page: number | null;
  quote: string;
  note: string | null;
  timestamp: string | null;
  created_at?: string;
}

export interface HighlightCountsResult {
  byBookId: Record<number, number>;
  byTitle: Record<string, number>;
  previewsByBookId: Record<number, string>;
  previewsByTitle: Record<string, string>;
}

export interface BackfillResult {
  totalFiles: number;
  totalHighlights: number;
  booksProcessed: string[];
}

export const HIGHLIGHTS_START_MARKER = "<!-- lighthouse:highlights:start -->";
export const HIGHLIGHTS_END_MARKER = "<!-- lighthouse:highlights:end -->";

// ----------------------------------------------------------------------------
// Database Initialization & Table Schema
// ----------------------------------------------------------------------------

export const CREATE_HIGHLIGHTS_TABLE_SQL = `
CREATE TABLE IF NOT EXISTS book_highlights (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  book_id INTEGER,
  book_title TEXT NOT NULL,
  chapter TEXT,
  page INTEGER,
  quote TEXT NOT NULL,
  note TEXT,
  timestamp TEXT,
  created_at TEXT DEFAULT (datetime('now')),
  UNIQUE(book_title, quote) ON CONFLICT REPLACE
);
CREATE INDEX IF NOT EXISTS idx_book_highlights_book_id ON book_highlights(book_id);
CREATE INDEX IF NOT EXISTS idx_book_highlights_title ON book_highlights(book_title);
`;

export function initHighlightsTable(db: Database): void {
  db.run("PRAGMA busy_timeout = 5000;");
  db.run(`
    CREATE TABLE IF NOT EXISTS book_highlights (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      book_id INTEGER,
      book_title TEXT NOT NULL,
      chapter TEXT,
      page INTEGER,
      quote TEXT NOT NULL,
      note TEXT,
      timestamp TEXT,
      created_at TEXT DEFAULT (datetime('now')),
      UNIQUE(book_title, quote) ON CONFLICT REPLACE
    );
  `);
  db.run(
    "CREATE INDEX IF NOT EXISTS idx_book_highlights_book_id ON book_highlights(book_id);",
  );
  db.run(
    "CREATE INDEX IF NOT EXISTS idx_book_highlights_title ON book_highlights(book_title);",
  );
}

export function getHighlightsCacheDbPath(customPath?: string): string {
  if (customPath) return customPath;
  if (process.env.CACHE_DB_PATH || process.env.JOBS_DB_PATH) {
    return (process.env.CACHE_DB_PATH || process.env.JOBS_DB_PATH)!;
  }
  const rootDir = process.env.LIGHTHOUSE_ROOT || process.cwd();
  const defaultPath = path.resolve(rootDir, "uploader", "cache.db");
  try {
    const dir = path.dirname(defaultPath);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    return defaultPath;
  } catch {
    return path.join(os.tmpdir(), "cache.db");
  }
}

let _cachedHighlightsDb: Database | null = null;
let _cachedHighlightsDbPath: string | null = null;

export function getHighlightsCacheDb(dbOrPath?: Database | string): Database {
  if (dbOrPath instanceof Database) {
    initHighlightsTable(dbOrPath);
    return dbOrPath;
  }
  if (typeof dbOrPath === "string") {
    const db = new Database(dbOrPath);
    initHighlightsTable(db);
    return db;
  }
  const dbPath = getHighlightsCacheDbPath();
  if (!_cachedHighlightsDb || _cachedHighlightsDbPath !== dbPath) {
    _cachedHighlightsDb = new Database(dbPath);
    _cachedHighlightsDbPath = dbPath;
    initHighlightsTable(_cachedHighlightsDb);
  }
  return _cachedHighlightsDb;
}

// ----------------------------------------------------------------------------
// Calibre Book Lookup Helper
// ----------------------------------------------------------------------------

export function resolveBookIdFromTitle(
  title: string,
  calibreDbPath?: string,
): number | null {
  if (!title || !title.trim()) return null;
  try {
    const dbPath =
      calibreDbPath ||
      process.env.CALIBRE_DB_PATH ||
      path.join(os.homedir(), "Calibre Library", "metadata.db");
    if (!fs.existsSync(dbPath)) return null;

    const db = new Database(dbPath, { readonly: true });
    try {
      db.run("PRAGMA busy_timeout = 2000;");
      const normalizedTitle = title.trim();

      // 1. Exact match COLLATE NOCASE
      let bookRow = db
        .query("SELECT id FROM books WHERE title = ? COLLATE NOCASE ORDER BY id ASC LIMIT 1;")
        .get(normalizedTitle) as any;

      if (bookRow?.id) return Number(bookRow.id);

      // 2. Lowercase trimmed match
      bookRow = db
        .query("SELECT id FROM books WHERE lower(trim(title)) = ? ORDER BY id ASC LIMIT 1;")
        .get(normalizedTitle.toLowerCase()) as any;

      if (bookRow?.id) return Number(bookRow.id);

      // 3. Strict alphanumeric normalized exact match
      const cleanNorm = (s: string) =>
        (s || "").toLowerCase().replace(/[\p{P}\p{S}\s]+/gu, "");
      const searchNorm = cleanNorm(normalizedTitle);

      if (searchNorm.length >= 3) {
        const rows = db.query("SELECT id, title FROM books ORDER BY id ASC LIMIT 1000;").all() as any[];
        for (const r of rows) {
          const rNorm = cleanNorm(r.title);
          if (rNorm === searchNorm) {
            return Number(r.id);
          }
        }
      }
    } finally {
      db.close();
    }
  } catch (_err) {
    void _err;
  }
  return null;
}

// ----------------------------------------------------------------------------
// Markdown Highlight Parsing
// ----------------------------------------------------------------------------

export function cleanQuoteText(raw: string): string {
  if (!raw) return "";
  let text = raw.trim();

  // Strip leading highlight markers ==...==
  const markedMatch = text.match(/^==([\s\S]*?)==$/);
  if (markedMatch) {
    text = markedMatch[1].trim();
  }

  // Strip leading blockquote '>' markers
  const lines = text.split("\n").map((l) => {
    let line = l.trim();
    if (line.startsWith(">")) {
      line = line.replace(/^>\s?/, "");
    }
    return line;
  });

  text = lines.join("\n").trim();

  // Strip surrounding quotes if wrapped
  if (
    (text.startsWith('"') && text.endsWith('"') && text.length >= 2) ||
    (text.startsWith('“') && text.endsWith('”') && text.length >= 2)
  ) {
    text = text.slice(1, -1).trim();
  }

  return text;
}

/**
 * Extracts structured fields from an individual raw highlight block.
 */
export function parseRawHighlightEntry(
  rawBlock: string,
  inheritedChapter?: string,
): {
  quote: string;
  note: string | null;
  chapter: string | null;
  page: number | null;
  timestamp: string | null;
} | null {
  if (!rawBlock || !rawBlock.trim()) return null;

  const lines = rawBlock.split("\n");
  let page: number | null = null;
  let timestamp: string | null = null;
  let chapter: string | null = inheritedChapter || null;
  let note: string | null = null;

  const quoteLines: string[] = [];
  const noteLines: string[] = [];
  let inNoteSection = false;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const trimmed = line.trim();
    if (!trimmed) continue;

    // Check for chapter heading: ## Chapter Name (if not highlights header)
    if (/^##\s+[^#]/.test(trimmed)) {
      const ch = trimmed.replace(/^##\s+/, "").trim();
      if (!/highlights\s*&?\s*notes/i.test(ch) && !/book\s*summary/i.test(ch)) {
        chapter = ch;
      }
      continue;
    }

    // Check for KOReader ### Page heading: "### Page 42 @ 2026-09-24 10:00:00"
    const pageHeadingMatch = trimmed.match(
      /^###\s+Page\s+(\d+)(?:\s*@\s*([^\n]+))?/i,
    );
    if (pageHeadingMatch) {
      page = parseInt(pageHeadingMatch[1], 10);
      if (pageHeadingMatch[2]) {
        timestamp = pageHeadingMatch[2].trim();
      }
      continue;
    }

    // Check for non-Page ### heading which might be chapter or title
    if (/^###\s+/.test(trimmed) && !isPageHeading(trimmed)) {
      const h3 = trimmed.replace(/^###\s+/, "").trim();
      if (!chapter && !h3.toLowerCase().startsWith("highlight")) {
        chapter = h3;
      }
      continue;
    }

    // Check for metadata line: "— *Chapter 1*, Page 42, 2026-09-24" or "- Page 10"
    if (/^[—\-]\s+/.test(trimmed)) {
      const metaContent = trimmed.replace(/^[—\-]\s+/, "");
      // Extract chapter in asterisks: *Chapter 1*
      const chMatch = metaContent.match(/\*([^*]+)\*/);
      if (chMatch) {
        chapter = chMatch[1].trim();
      }
      // Extract Page \d+
      const pMatch = metaContent.match(/\bPage\s+(\d+)\b/i);
      if (pMatch) {
        page = parseInt(pMatch[1], 10);
      }
      // Extract date / timestamp pattern YYYY-MM-DD or @ date
      const atMatch = metaContent.match(/@\s*([^\n,]+)/);
      if (atMatch) {
        timestamp = atMatch[1].trim();
      } else {
        const dateMatch = metaContent.match(/\b\d{4}-\d{2}-\d{2}(?:\s+\d{2}:\d{2}(?::\d{2})?)?\b/);
        if (dateMatch) {
          timestamp = dateMatch[0].trim();
        }
      }
      continue;
    }

    // Check for note separator: "---" or "***"
    if (/^---\s*$/.test(trimmed) || /^[-*_]{3,}\s*$/.test(trimmed)) {
      inNoteSection = true;
      continue;
    }

    // Check for explicit Note prefix: "**Note:** ..." or "Note: ..."
    if (/^\*{0,2}Note:\*{0,2}\s*/i.test(trimmed)) {
      inNoteSection = true;
      const noteContent = trimmed.replace(/^\*{0,2}Note:\*{0,2}\s*/i, "").trim();
      if (noteContent) noteLines.push(noteContent);
      continue;
    }

    if (inNoteSection) {
      noteLines.push(line);
    } else {
      quoteLines.push(line);
    }
  }

  // Extract and clean the quote
  let quote = cleanQuoteText(quoteLines.join("\n"));
  if (!quote) return null;

  // Extract note text
  if (noteLines.length > 0) {
    const rawNote = noteLines.join("\n").trim();
    if (rawNote) {
      note = rawNote;
    }
  }

  return {
    quote,
    note,
    chapter: chapter || null,
    page: page !== null && !Number.isNaN(page) ? page : null,
    timestamp: timestamp || null,
  };
}

function isPageHeading(trimmed: string): boolean {
  return /^###\s+Page\b/i.test(trimmed);
}

/**
 * Splits raw note markdown into individual highlight candidate blocks.
 */
export function splitNoteIntoHighlightBlocks(markdown: string): Array<{
  raw: string;
  chapter?: string;
}> {
  if (!markdown || !markdown.trim()) return [];

  // 1. If section markers exist, extract only the managed highlights region
  let content = markdown;
  const startIdx = content.indexOf(HIGHLIGHTS_START_MARKER);
  const endIdx = content.indexOf(HIGHLIGHTS_END_MARKER);
  if (startIdx !== -1 && endIdx !== -1 && endIdx > startIdx) {
    content = content.slice(startIdx + HIGHLIGHTS_START_MARKER.length, endIdx);
  }

  const lines = content.replace(/\r\n/g, "\n").split("\n");
  const blocks: Array<{ raw: string; chapter?: string }> = [];

  let currentChapter: string | undefined;
  let currentLines: string[] = [];

  function flush() {
    if (currentLines.length === 0) return;
    const raw = currentLines.join("\n").trim();
    if (raw && !/^\*no highlights recorded yet\.\*$/i.test(raw)) {
      blocks.push({ raw, chapter: currentChapter });
    }
    currentLines = [];
  }

  const hasPageHeaders = lines.some((l) => /^###\s+Page\b/i.test(l.trim()));
  const hasBlockquotes = lines.some((l) => /^>\s+/.test(l.trim()));

  if (hasPageHeaders) {
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      const trimmed = line.trim();

      // Chapter header: "## Chapter"
      if (/^##\s+[^#]/.test(trimmed)) {
        flush();
        const ch = trimmed.replace(/^##\s+/, "").trim();
        if (!/highlights\s*&?\s*notes/i.test(ch) && !/book\s*summary/i.test(ch)) {
          currentChapter = ch;
        }
        continue;
      }

      // Entry start: "### Page ..."
      if (/^###\s+Page\b/i.test(trimmed)) {
        flush();
        currentLines.push(line);
        continue;
      }

      currentLines.push(line);
    }
    flush();
  } else if (hasBlockquotes) {
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      const trimmed = line.trim();

      if (/^##\s+[^#]/.test(trimmed)) {
        flush();
        const ch = trimmed.replace(/^##\s+/, "").trim();
        if (!/highlights\s*&?\s*notes/i.test(ch) && !/book\s*summary/i.test(ch)) {
          currentChapter = ch;
        }
        continue;
      }

      if (/^>\s+/.test(trimmed)) {
        const prevTrimmed = i > 0 ? lines[i - 1].trim() : "";
        if (
          currentLines.length > 0 &&
          (prevTrimmed === "" ||
            /^[—\-]\s+/.test(prevTrimmed) ||
            /^\*{0,2}Note:/i.test(prevTrimmed))
        ) {
          flush();
        }
        currentLines.push(line);
        continue;
      }

      currentLines.push(line);
    }
    flush();
  } else {
    // Split by horizontal rules or double empty lines
    const paragraphs = content.split(/\n\s*[-*_]{3,}\s*\n|\n\n+/);
    for (const p of paragraphs) {
      const trimmed = p.trim();
      if (!trimmed || /^\*no highlights recorded yet\.\*$/i.test(trimmed)) {
        continue;
      }
      blocks.push({ raw: trimmed });
    }
  }

  return blocks;
}

/**
 * Parses all highlights from note markdown into structured HighlightRecord items.
 */
export function parseHighlightsFromMarkdown(
  markdown: string,
  bookTitle: string,
  bookId?: number | null,
): HighlightRecord[] {
  if (!markdown || !markdown.trim() || !bookTitle) return [];

  const rawBlocks = splitNoteIntoHighlightBlocks(markdown);
  const records: HighlightRecord[] = [];

  for (const block of rawBlocks) {
    const parsed = parseRawHighlightEntry(block.raw, block.chapter);
    if (parsed && parsed.quote) {
      records.push({
        book_id: bookId ?? null,
        book_title: bookTitle.trim(),
        chapter: parsed.chapter,
        page: parsed.page,
        quote: parsed.quote,
        note: parsed.note,
        timestamp: parsed.timestamp,
      });
    }
  }

  return records;
}

// ----------------------------------------------------------------------------
// Database CRUD Operations
// ----------------------------------------------------------------------------

export function insertOrUpdateHighlight(
  db: Database,
  highlight: Omit<HighlightRecord, "id" | "created_at">,
): number {
  initHighlightsTable(db);
  const stmt = db.prepare(`
    INSERT INTO book_highlights (book_id, book_title, chapter, page, quote, note, timestamp)
    VALUES (?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(book_title, quote) DO UPDATE SET
      book_id = COALESCE(excluded.book_id, book_highlights.book_id),
      chapter = excluded.chapter,
      page = excluded.page,
      note = excluded.note,
      timestamp = excluded.timestamp;
  `);

  stmt.run(
    highlight.book_id ?? null,
    highlight.book_title.trim(),
    highlight.chapter ?? null,
    highlight.page ?? null,
    highlight.quote.trim(),
    highlight.note ?? null,
    highlight.timestamp ?? null,
  );

  return 1;
}

export function batchUpsertHighlights(
  db: Database,
  highlights: Omit<HighlightRecord, "id" | "created_at">[],
): number {
  if (!highlights || highlights.length === 0) return 0;
  initHighlightsTable(db);

  let insertedCount = 0;
  const insertStmt = db.prepare(`
    INSERT INTO book_highlights (book_id, book_title, chapter, page, quote, note, timestamp)
    VALUES (?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(book_title, quote) DO UPDATE SET
      book_id = COALESCE(excluded.book_id, book_highlights.book_id),
      chapter = excluded.chapter,
      page = excluded.page,
      note = excluded.note,
      timestamp = excluded.timestamp;
  `);

  db.transaction(() => {
    for (const h of highlights) {
      if (h.quote && h.quote.trim()) {
        insertStmt.run(
          h.book_id ?? null,
          h.book_title.trim(),
          h.chapter ?? null,
          h.page ?? null,
          h.quote.trim(),
          h.note ?? null,
          h.timestamp ?? null,
        );
        insertedCount++;
      }
    }
  })();

  return insertedCount;
}

/**
 * Retrieves all highlights for a book by book_id, falling back to title match.
 * If title match finds unlinked highlights (book_id IS NULL), auto-links them to book_id.
 */
export function getHighlightsForBook(
  db: Database,
  bookId: number,
  title?: string,
  limit = 1000,
): HighlightRecord[] {
  initHighlightsTable(db);

  let rows: HighlightRecord[] = [];

  if (title && title.trim()) {
    const cleanTitle = title.trim();
    // Auto-link unlinked highlights with matching title
    db.run(
      "UPDATE book_highlights SET book_id = ? WHERE book_id IS NULL AND lower(trim(book_title)) = lower(trim(?));",
      [bookId, cleanTitle],
    );

    rows = db
      .query(
        `SELECT id, book_id, book_title, chapter, page, quote, note, timestamp, created_at
         FROM book_highlights
         WHERE book_id = ? OR lower(trim(book_title)) = lower(trim(?))
         ORDER BY CASE WHEN page IS NULL THEN 999999 ELSE page END ASC, id ASC
         LIMIT ?;`,
      )
      .all(bookId, cleanTitle, limit) as HighlightRecord[];
  } else {
    rows = db
      .query(
        `SELECT id, book_id, book_title, chapter, page, quote, note, timestamp, created_at
         FROM book_highlights
         WHERE book_id = ?
         ORDER BY CASE WHEN page IS NULL THEN 999999 ELSE page END ASC, id ASC
         LIMIT ?;`,
      )
      .all(bookId, limit) as HighlightRecord[];
  }

  return rows;
}

/**
 * Retrieves highlights by book title.
 */
export function getHighlightsByTitle(
  db: Database,
  title: string,
  limit = 1000,
): HighlightRecord[] {
  if (!title || !title.trim()) return [];
  initHighlightsTable(db);

  return db
    .query(
      `SELECT id, book_id, book_title, chapter, page, quote, note, timestamp, created_at
       FROM book_highlights
       WHERE lower(trim(book_title)) = lower(trim(?))
       ORDER BY CASE WHEN page IS NULL THEN 999999 ELSE page END ASC, id ASC
       LIMIT ?;`,
    )
    .all(title.trim(), limit) as HighlightRecord[];
}

/**
 * Fast aggregate counts across the entire library with latest quote previews.
 * Returns mapped counts and latest quote previews by book_id and lowercase title.
 */
export function getHighlightCounts(db: Database): HighlightCountsResult {
  initHighlightsTable(db);

  const byBookId: Record<number, number> = {};
  const byTitle: Record<string, number> = {};
  const previewsByBookId: Record<number, string> = {};
  const previewsByTitle: Record<string, string> = {};

  const idRows = db
    .query(
      `SELECT book_id, COUNT(*) as count
       FROM book_highlights
       WHERE book_id IS NOT NULL
       GROUP BY book_id;`,
    )
    .all() as Array<{ book_id: number; count: number }>;

  for (const r of idRows) {
    byBookId[r.book_id] = Number(r.count);
  }

  const titleRows = db
    .query(
      `SELECT lower(trim(book_title)) as norm_title, COUNT(*) as count
       FROM book_highlights
       GROUP BY lower(trim(book_title));`,
    )
    .all() as Array<{ norm_title: string; count: number }>;

  for (const r of titleRows) {
    if (r.norm_title) {
      byTitle[r.norm_title] = Number(r.count);
    }
  }

  // Previews: batch retrieve latest quote per book in a single query
  try {
    const previewRows = db
      .query(
        `SELECT id, book_id, lower(trim(book_title)) as norm_title, quote
         FROM book_highlights
         WHERE id IN (
           SELECT MAX(id) FROM book_highlights GROUP BY COALESCE(book_id, lower(trim(book_title)))
         );`,
      )
      .all() as Array<{ id: number; book_id: number | null; norm_title: string; quote: string }>;

    for (const r of previewRows) {
      if (r.book_id) {
        previewsByBookId[r.book_id] = r.quote;
      }
      if (r.norm_title) {
        previewsByTitle[r.norm_title] = r.quote;
      }
    }
  } catch {
    // Fail-open
  }

  return { byBookId, byTitle, previewsByBookId, previewsByTitle };
}

/**
 * Returns latest quote preview snippet for card hover popovers.
 */
export function getLatestQuotePreview(
  db: Database,
  bookId: number,
  title?: string,
): { quote: string; note: string | null } | null {
  initHighlightsTable(db);

  let row: any = null;
  if (title && title.trim()) {
    row = db
      .query(
        `SELECT quote, note
         FROM book_highlights
         WHERE book_id = ? OR lower(trim(book_title)) = lower(trim(?))
         ORDER BY id DESC
         LIMIT 1;`,
      )
      .get(bookId, title.trim());
  } else {
    row = db
      .query(
        `SELECT quote, note
         FROM book_highlights
         WHERE book_id = ?
         ORDER BY id DESC
         LIMIT 1;`,
      )
      .get(bookId);
  }

  if (row) {
    return {
      quote: row.quote,
      note: row.note || null,
    };
  }
  return null;
}

// ----------------------------------------------------------------------------
// On-Demand Backfill & Sync Engine
// ----------------------------------------------------------------------------

export function resolveBooksDir(customDir?: string, vaultPath?: string): string {
  if (customDir && fs.existsSync(customDir)) return customDir;
  if (process.env.OBSIDIAN_BOOKS_DIR && fs.existsSync(process.env.OBSIDIAN_BOOKS_DIR)) {
    return process.env.OBSIDIAN_BOOKS_DIR;
  }
  const vPath =
    vaultPath ||
    process.env.OBSIDIAN_VAULT_PATH ||
    path.join(os.homedir(), "Obsidian");
  return path.join(vPath, "Books");
}

/**
 * Backfills highlights into SQLite from existing Markdown notes in <vault>/Books/*.md.
 */
export async function backfillHighlightsFromObsidian(
  options: {
    booksDir?: string;
    vaultPath?: string;
    calibreDbPath?: string;
    db?: Database;
  } = {},
): Promise<BackfillResult> {
  const booksDir = resolveBooksDir(options.booksDir, options.vaultPath);
  const result: BackfillResult = {
    totalFiles: 0,
    totalHighlights: 0,
    booksProcessed: [],
  };

  if (!fs.existsSync(booksDir)) return result;

  const db = options.db;
  if (!db) return result;

  const resolvedBooksDir = path.resolve(booksDir);
  const entries = fs.readdirSync(booksDir, { withFileTypes: true });
  for (const ent of entries) {
    if (ent.isFile() && ent.name.endsWith(".md") && !ent.name.startsWith(".")) {
      const sanitizedFilename = path.basename(ent.name);
      const filePath = path.join(booksDir, sanitizedFilename);
      const resolvedFilePath = path.resolve(filePath);
      if (!resolvedFilePath.startsWith(resolvedBooksDir + path.sep)) {
        continue;
      }

      result.totalFiles++;
      try {
        const content = fs.readFileSync(resolvedFilePath, "utf8");
        // Extract title from YAML frontmatter or filename
        let title = sanitizedFilename.replace(/\.md$/i, "");
        const fmTitleMatch = content.match(/^title:\s*(?:"([^"]+)"|'([^']+)'|([^\n]+))/m);
        if (fmTitleMatch) {
          title = (fmTitleMatch[1] || fmTitleMatch[2] || fmTitleMatch[3] || title).trim();
        }

        const bookId = resolveBookIdFromTitle(title, options.calibreDbPath);
        const highlights = parseHighlightsFromMarkdown(content, title, bookId);

        if (highlights.length > 0) {
          const inserted = batchUpsertHighlights(db, highlights);
          result.totalHighlights += inserted;
          result.booksProcessed.push(title);
        }
      } catch (_fileErr) {
        void _fileErr;
      }
    }
  }

  return result;
}

/**
 * Deletes all highlights for a book by book_id and optionally book title.
 */
export function deleteHighlightsForBook(
  db: Database,
  bookId: number,
  title?: string,
): void {
  initHighlightsTable(db);
  if (title && title.trim()) {
    db.run(
      "DELETE FROM book_highlights WHERE book_id = ? OR lower(trim(book_title)) = lower(trim(?));",
      [bookId, title.trim()],
    );
  } else {
    db.run("DELETE FROM book_highlights WHERE book_id = ?;", [bookId]);
  }
}

/**
 * Checks if highlights are present in DB; if 0 or stale, checks Obsidian Books folder
 * with strict path containment checks.
 */
export function ensureBookHighlightsIndexed(
  db: Database,
  bookId: number,
  title: string,
  options: { booksDir?: string; calibreDbPath?: string; forceFresh?: boolean } = {},
): HighlightRecord[] {
  let existing = getHighlightsForBook(db, bookId, title);

  // On-demand check in Obsidian Books folder with strict path containment
  const booksDir = resolveBooksDir(options.booksDir);
  if (fs.existsSync(booksDir)) {
    const resolvedBooksDir = path.resolve(booksDir);

    // Sanitize segment using path.basename to defeat path traversal
    const safeTitleBase = path.basename(
      title.replace(/[\\/:*?"<>|]/g, "_").trim(),
    );
    if (!safeTitleBase || safeTitleBase === "." || safeTitleBase === "..") {
      return existing;
    }

    const candidateFiles = [
      `${safeTitleBase}.md`,
      `${path.basename(title.replace(/[\/:]/g, " - ").trim())}.md`,
    ];

    for (const name of candidateFiles) {
      const notePath = path.join(booksDir, name);
      const resolvedNotePath = path.resolve(notePath);

      // Verify strict path containment inside booksDir
      if (!resolvedNotePath.startsWith(resolvedBooksDir + path.sep)) {
        continue;
      }

      if (fs.existsSync(resolvedNotePath)) {
        try {
          const st = fs.lstatSync(resolvedNotePath);
          if (st.isSymbolicLink() || !st.isFile()) continue;

          // Check if file is newer than existing highlights or forceFresh was requested
          let shouldReindex = options.forceFresh || existing.length === 0;
          if (!shouldReindex && existing.length > 0) {
            const latestCreated = db
              .query(
                `SELECT MAX(created_at) as max_c FROM book_highlights
                 WHERE book_id = ? OR lower(trim(book_title)) = lower(trim(?));`,
              )
              .get(bookId, title.trim()) as any;
            if (latestCreated?.max_c) {
              const latestMs = new Date(latestCreated.max_c + "Z").getTime();
              if (st.mtimeMs > latestMs) {
                shouldReindex = true;
              }
            }
          }

          if (shouldReindex) {
            const content = fs.readFileSync(resolvedNotePath, "utf8");
            const parsed = parseHighlightsFromMarkdown(content, title, bookId);
            if (options.forceFresh) {
              db.run(
                "DELETE FROM book_highlights WHERE book_id = ? OR lower(trim(book_title)) = lower(trim(?));",
                [bookId, title.trim()],
              );
            }
            if (parsed.length > 0) {
              batchUpsertHighlights(db, parsed);
            }
            return getHighlightsForBook(db, bookId, title);
          }
        } catch (_readErr) {
          void _readErr;
        }
      }
    }
  }

  return existing;
}
