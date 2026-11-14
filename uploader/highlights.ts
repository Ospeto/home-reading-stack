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
  /** Normalized highlight color token (see uploader/annotation-store.ts). */
  color?: string | null;
  /** Normalized highlight style token (see uploader/annotation-store.ts). */
  style?: string | null;
  /**
   * Comma-separated set of sources that reported this highlight.
   * Owned and interpreted by uploader/annotation-store.ts; NULL/empty means the
   * row predates source tracking and is treated as the `legacy` source.
   */
  sources?: string | null;
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
  color TEXT,
  style TEXT,
  sources TEXT,
  created_at TEXT DEFAULT (datetime('now')),
  UNIQUE(book_title, quote) ON CONFLICT REPLACE
);
CREATE INDEX IF NOT EXISTS idx_book_highlights_book_id ON book_highlights(book_id);
CREATE INDEX IF NOT EXISTS idx_book_highlights_title ON book_highlights(book_title);
CREATE INDEX IF NOT EXISTS idx_book_highlights_color ON book_highlights(color);
CREATE INDEX IF NOT EXISTS idx_book_highlights_style ON book_highlights(style);
CREATE INDEX IF NOT EXISTS idx_book_highlights_sources ON book_highlights(sources);
`;

const _initializedDbs = new WeakSet<Database>();

/**
 * Columns added after the original table shipped.
 * The table above is created with them; existing databases get them via ALTER TABLE
 * so a live cache.db keeps its rows and its UNIQUE(book_title, quote) identity.
 *
 * Each statement is a literal so no identifier is ever interpolated into SQL.
 */
const HIGHLIGHT_ADDED_COLUMNS: Array<{ name: string; ddl: string }> = [
  { name: "color", ddl: "ALTER TABLE book_highlights ADD COLUMN color TEXT;" },
  { name: "style", ddl: "ALTER TABLE book_highlights ADD COLUMN style TEXT;" },
  { name: "sources", ddl: "ALTER TABLE book_highlights ADD COLUMN sources TEXT;" },
];

function addMissingHighlightColumns(db: Database): void {
  const existing = new Set(
    (db.query("PRAGMA table_info(book_highlights);").all() as Array<{ name: string }>).map(
      (c) => c.name,
    ),
  );
  for (const column of HIGHLIGHT_ADDED_COLUMNS) {
    if (!existing.has(column.name)) {
      db.run(column.ddl);
    }
  }
  // Rows written before source tracking have no owner. Mark them explicitly so
  // the reconciliation pass in uploader/annotation-store.ts can retire them
  // instead of leaving them as permanent orphans.
  db.run(
    "UPDATE book_highlights SET sources = 'legacy' WHERE sources IS NULL;",
  );
}

export function initHighlightsTable(db: Database, force = false): void {
  if (!force && _initializedDbs.has(db)) {
    return;
  }
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
      color TEXT,
      style TEXT,
      sources TEXT,
      created_at TEXT DEFAULT (datetime('now')),
      UNIQUE(book_title, quote) ON CONFLICT REPLACE
    );
  `);
  addMissingHighlightColumns(db);
  db.run(
    "CREATE INDEX IF NOT EXISTS idx_book_highlights_book_id ON book_highlights(book_id);",
  );
  db.run(
    "CREATE INDEX IF NOT EXISTS idx_book_highlights_title ON book_highlights(book_title);",
  );
  db.run(
    "CREATE INDEX IF NOT EXISTS idx_book_highlights_color ON book_highlights(color);",
  );
  db.run(
    "CREATE INDEX IF NOT EXISTS idx_book_highlights_style ON book_highlights(style);",
  );
  db.run(
    "CREATE INDEX IF NOT EXISTS idx_book_highlights_sources ON book_highlights(sources);",
  );
  _initializedDbs.add(db);
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
    try {
      dbOrPath.run("PRAGMA journal_mode = WAL;");
      dbOrPath.run("PRAGMA busy_timeout = 5000;");
    } catch (_e) {
      void _e;
    }
    initHighlightsTable(dbOrPath);
    return dbOrPath;
  }
  if (typeof dbOrPath === "string") {
    const db = new Database(dbOrPath);
    try {
      db.run("PRAGMA journal_mode = WAL;");
      db.run("PRAGMA busy_timeout = 5000;");
    } catch (_e) {
      void _e;
    }
    initHighlightsTable(db);
    return db;
  }
  const dbPath = getHighlightsCacheDbPath();
  if (!_cachedHighlightsDb || _cachedHighlightsDbPath !== dbPath) {
    _cachedHighlightsDb = new Database(dbPath);
    _cachedHighlightsDbPath = dbPath;
    try {
      _cachedHighlightsDb.run("PRAGMA journal_mode = WAL;");
      _cachedHighlightsDb.run("PRAGMA busy_timeout = 5000;");
    } catch (_e) {
      void _e;
    }
    initHighlightsTable(_cachedHighlightsDb);
  }
  return _cachedHighlightsDb;
}

// ----------------------------------------------------------------------------
// Calibre Book Lookup Helper
// ----------------------------------------------------------------------------

/**
 * Compares two author strings with token-sort and normalized whole-word matching.
 * Handles "Stephen Fry" ↔ "Fry, Stephen" and multi-author containment without
 * false positives on substring matches (e.g. Ann vs Joanne, Homer vs Homeric).
 */
export function authorsMatch(a?: string, b?: string): boolean {
  if (!a || !b) return false;
  const tokenize = (s: string) =>
    s
      .normalize("NFC")
      .toLowerCase()
      .replace(/[\p{P}\p{S}]+/gu, " ")
      .trim()
      .split(/\s+/)
      .filter(Boolean);

  const tokensA = tokenize(a);
  const tokensB = tokenize(b);
  if (tokensA.length === 0 || tokensB.length === 0) return false;

  const sortedA = [...tokensA].sort().join(" ");
  const sortedB = [...tokensB].sort().join(" ");
  if (sortedA === sortedB) return true;

  // Whole-word token containment (e.g. "Homer" in "Homer, Translator")
  const setA = new Set(tokensA);
  const setB = new Set(tokensB);
  const aInB = tokensA.every((t) => setB.has(t));
  const bInA = tokensB.every((t) => setA.has(t));
  return aInB || bInA;
}

export function resolveBookIdFromTitle(
  title: string,
  calibreDbPath?: string,
  author?: string,
): number | null {
  if (!title || !title.trim()) return null;
  try {
    const dbPath =
      calibreDbPath ||
      process.env.CALIBRE_DB_PATH ||
      path.join(process.env.HOME || os.homedir(), "Calibre Libraries", "Agent Library", "metadata.db");
    if (!fs.existsSync(dbPath)) return null;

    const db = new Database(dbPath, { readonly: true });
    try {
      db.run("PRAGMA busy_timeout = 2000;");
      const normalizedTitle = title.normalize("NFC").trim();
      const normalizedAuthor = author?.normalize("NFC").trim();

      const hasAuthorsTable = Boolean(
        db
          .query(
            "SELECT 1 FROM sqlite_master WHERE type='table' AND name='authors' LIMIT 1;",
          )
          .get(),
      );

      const findAuthorMatch = (rows: Array<{ id: number; authors?: string }>): number | null => {
        if (rows.length === 0) return null;
        if (rows.length === 1) {
          return Number(rows[0].id);
        }
        // Shared title (rows.length > 1): require a positive author match
        if (normalizedAuthor && normalizedAuthor !== "Unknown") {
          for (const r of rows) {
            if (authorsMatch(r.authors, normalizedAuthor)) {
              return Number(r.id);
            }
          }
        }
        // If title is shared and author is missing, Unknown, or unmatched: return null
        return null;
      };

      // 1. Exact match COLLATE NOCASE
      const exactQuery = hasAuthorsTable
        ? `SELECT b.id, GROUP_CONCAT(DISTINCT a.name) as authors
           FROM books b
           LEFT JOIN books_authors_link bal ON b.id = bal.book
           LEFT JOIN authors a ON bal.author = a.id
           WHERE b.title = ? COLLATE NOCASE
           GROUP BY b.id
           ORDER BY b.id ASC;`
        : `SELECT b.id, NULL as authors FROM books b WHERE b.title = ? COLLATE NOCASE ORDER BY b.id ASC;`;

      const exactRows = db.query(exactQuery).all(normalizedTitle) as any[];
      if (exactRows.length > 0) {
        return findAuthorMatch(exactRows);
      }

      // 2. Lowercase trimmed match
      const lowerQuery = hasAuthorsTable
        ? `SELECT b.id, GROUP_CONCAT(DISTINCT a.name) as authors
           FROM books b
           LEFT JOIN books_authors_link bal ON b.id = bal.book
           LEFT JOIN authors a ON bal.author = a.id
           WHERE lower(trim(b.title)) = ?
           GROUP BY b.id
           ORDER BY b.id ASC;`
        : `SELECT b.id, NULL as authors FROM books b WHERE lower(trim(b.title)) = ? ORDER BY b.id ASC;`;

      const lowerRows = db.query(lowerQuery).all(normalizedTitle.toLowerCase()) as any[];
      if (lowerRows.length > 0) {
        return findAuthorMatch(lowerRows);
      }

      // 3. Strict alphanumeric normalized exact match in SQL (no 1000-row cap)
      const cleanNorm = (s: string) =>
        (s || "").toLowerCase().replace(/[\p{P}\p{S}\s]+/gu, "");
      const searchNorm = cleanNorm(normalizedTitle);

      if (searchNorm.length >= 3) {
        const punctChars = [
          ":", "!", "?", ".", ",", ";", "-", "—", "–", "'", "\"", "`", " ", "_",
          "(", ")", "[", "]", "{", "}", "/", "\\", "@", "#", "$", "%", "^", "&",
          "*", "+", "=", "~", "<", ">", "\t", "\n", "\r", "’", "‘", "“", "”", "·", "…",
          "\u00A0", "\u3000", "\u200B", "\u2011", "\u2012", "\u2013", "\u2014", "\u2015",
          "（", "）", "【", "】", "『", "』", "「", "」", "〔", "〕", "〈", "〉", "《", "》", "〖", "〗",
          "：", "！", "？", "，", "；", "、", "。", "・", "～", "‹", "›", "«", "»"
        ];
        const sqlQuote = (ch: string) => "'" + ch.replace(/'/g, "''") + "'";
        const batches: string[][] = [];
        for (let i = 0; i < punctChars.length; i += 12) {
          batches.push(punctChars.slice(i, i + 12));
        }

        const baseSelect = hasAuthorsTable
          ? `SELECT b.id, lower(b.title) AS t, GROUP_CONCAT(DISTINCT a.name) AS authors
             FROM books b
             LEFT JOIN books_authors_link bal ON b.id = bal.book
             LEFT JOIN authors a ON bal.author = a.id
             GROUP BY b.id`
          : `SELECT b.id, lower(b.title) AS t, NULL AS authors FROM books b`;

        let cte = `WITH step0 AS (${baseSelect})`;
        batches.forEach((batch, idx) => {
          let expr = "t";
          for (const ch of batch) {
            expr = `replace(${expr}, ${sqlQuote(ch)}, "")`;
          }
          cte += `, step${idx + 1} AS (SELECT id, authors, ${expr} AS t FROM step${idx})`;
        });

        const sql = `${cte} SELECT id, authors FROM step${batches.length} WHERE t = ? ORDER BY id ASC;`;
        const candidateRows = db.query(sql).all(searchNorm) as any[];

        if (candidateRows.length > 0) {
          return findAuthorMatch(candidateRows);
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
  let text = raw.replace(/\r\n/g, "\n").replace(/\r/g, "\n").trim();

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

  // Strip surrounding quotes if wrapped: "", “”, '', ‘’, «», 「」, 『』
  const quotePairs: Array<[string, string]> = [
    ['"', '"'],
    ["“", "”"],
    ["'", "'"],
    ["‘", "’"],
    ["«", "»"],
    ["「", "」"],
    ["『", "』"],
  ];
  for (const [open, close] of quotePairs) {
    if (
      text.startsWith(open) &&
      text.endsWith(close) &&
      text.length >= open.length + close.length
    ) {
      text = text.slice(open.length, -close.length).trim();
      break;
    }
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

    // Check for KOReader ### Page / Location heading: "### Page 42 @ 2026-09-24 10:00:00" or "### Location 120"
    const pageHeadingMatch = trimmed.match(
      /^###\s+(?:Page|Location|Pos|Position)\s+(\d+)(?:\s*[@·,]\s*([^\n]+))?/i,
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

    // Check for metadata line: "— *Chapter 1*, Page 42, 2026-09-24" or "- Page 10" or "— Location 100"
    if (/^[—\-]\s+/.test(trimmed)) {
      const metaContent = trimmed.replace(/^[—\-]\s+/, "");
      // Extract chapter in asterisks: *Chapter 1*
      const chMatch = metaContent.match(/\*([^*]+)\*/);
      if (chMatch) {
        chapter = chMatch[1].trim();
      }
      // Extract Page \d+ or Location \d+
      const pMatch = metaContent.match(/\b(?:Page|Location|Pos|Position)\s+(\d+)\b/i);
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
  return /^###\s+(?:Page|Location|Pos|Position)\b/i.test(trimmed);
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
  } else if (startIdx !== -1 && (endIdx === -1 || endIdx < startIdx)) {
    content = content.slice(startIdx + HIGHLIGHTS_START_MARKER.length);
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

  const hasPageHeaders = lines.some((l) =>
    /^###\s+(?:Page|Location|Pos|Position)\b/i.test(l.trim()),
  );
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

      // Entry start: "### Page ..." or "### Location ..."
      if (/^###\s+(?:Page|Location|Pos|Position)\b/i.test(trimmed)) {
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

/**
 * Marker for a row written without a named ingestion path.
 * uploader/annotation-store.ts treats this as "unattributed": it is dropped the
 * moment a real source claims the row, so a retired highlight cannot survive
 * behind it.
 */
export const UNATTRIBUTED_SOURCE = "legacy";

/**
 * Single owner of the highlight upsert statement.
 *
 * `sources` is a comma-separated set: an incoming single-source write joins the
 * set rather than replacing it, so one row can be claimed by several ingestion
 * paths at once. An unattributed write never joins a set that a real source
 * already owns, so it cannot resurrect an unowned claim. uploader/annotation-store.ts
 * owns what the set means and when a row is retired; this statement only keeps
 * it well-formed.
 */
const UPSERT_HIGHLIGHT_SQL = `
  INSERT INTO book_highlights
    (book_id, book_title, chapter, page, quote, note, timestamp, color, style, sources)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  ON CONFLICT(book_title, quote) DO UPDATE SET
    book_id = COALESCE(excluded.book_id, book_highlights.book_id),
    chapter = COALESCE(excluded.chapter, book_highlights.chapter),
    page = COALESCE(excluded.page, book_highlights.page),
    note = excluded.note,
    timestamp = COALESCE(excluded.timestamp, book_highlights.timestamp),
    color = COALESCE(excluded.color, book_highlights.color),
    style = COALESCE(excluded.style, book_highlights.style),
    sources = CASE
      WHEN excluded.sources IS NULL
        OR trim(excluded.sources) = ''
        OR trim(excluded.sources) = '${UNATTRIBUTED_SOURCE}'
        THEN book_highlights.sources
      WHEN book_highlights.sources IS NULL OR trim(book_highlights.sources) = ''
        THEN excluded.sources
      WHEN instr(
        ',' || book_highlights.sources || ',',
        ',' || trim(excluded.sources) || ','
      ) > 0
        THEN book_highlights.sources
      ELSE book_highlights.sources || ',' || trim(excluded.sources)
    END,
    created_at = datetime('now');
`;

/**
 * Variant used by snapshot reconciliation: an annotation the note already holds
 * survives a re-export that omits it (KOReader's exporter frequently drops
 * annotations). The direct-edit path keeps the clearing behaviour, which callers
 * rely on to erase an annotation deliberately.
 */
const UPSERT_HIGHLIGHT_PRESERVE_NOTE_SQL = UPSERT_HIGHLIGHT_SQL.replace(
  "    note = excluded.note,",
  "    note = COALESCE(excluded.note, book_highlights.note),",
);

function upsertHighlightRow(
  stmt: ReturnType<Database["prepare"]>,
  highlight: Omit<HighlightRecord, "id" | "created_at">,
): void {
  stmt.run(
    highlight.book_id ?? null,
    highlight.book_title.trim(),
    highlight.chapter ?? null,
    highlight.page ?? null,
    highlight.quote.trim(),
    highlight.note ?? null,
    highlight.timestamp ?? null,
    highlight.color ?? null,
    highlight.style ?? null,
    highlight.sources?.trim() || UNATTRIBUTED_SOURCE,
  );
}

export function insertOrUpdateHighlight(
  db: Database,
  highlight: Omit<HighlightRecord, "id" | "created_at">,
): number {
  initHighlightsTable(db);
  upsertHighlightRow(db.prepare(UPSERT_HIGHLIGHT_SQL), highlight);
  invalidateHighlightCountsCache(db);
  return 1;
}

export function batchUpsertHighlights(
  db: Database,
  highlights: Omit<HighlightRecord, "id" | "created_at">[],
  options: { preserveNotes?: boolean } = {},
): number {
  if (!highlights || highlights.length === 0) return 0;
  initHighlightsTable(db);

  let insertedCount = 0;
  const insertStmt = db.prepare(
    options.preserveNotes
      ? UPSERT_HIGHLIGHT_PRESERVE_NOTE_SQL
      : UPSERT_HIGHLIGHT_SQL,
  );

  db.transaction(() => {
    for (const h of highlights) {
      if (h.quote && h.quote.trim()) {
        upsertHighlightRow(insertStmt, h);
        insertedCount++;
      }
    }
  })();

  if (insertedCount > 0) {
    invalidateHighlightCountsCache(db);
  }
  return insertedCount;
}

/**
 * Checks whether a title is unique to the given book across both book_highlights and Calibre metadata.
 */
export function isTitleUniqueForBook(
  db: Database,
  bookId: number,
  cleanTitle: string,
  calibreDbPath?: string,
): boolean {
  // Check if any other book in book_highlights has this title
  const otherBook = db
    .query(
      "SELECT 1 FROM book_highlights WHERE lower(trim(book_title)) = lower(trim(?)) AND book_id IS NOT NULL AND book_id != ? LIMIT 1;",
    )
    .get(cleanTitle, bookId);
  if (otherBook) return false;

  // Check if Calibre DB has multiple books with this title
  try {
    const dbPath =
      calibreDbPath ||
      process.env.CALIBRE_DB_PATH ||
      path.join(process.env.HOME || os.homedir(), "Calibre Libraries", "Agent Library", "metadata.db");
    if (fs.existsSync(dbPath)) {
      const cDb = new Database(dbPath, { readonly: true });
      const countRow = cDb
        .query("SELECT COUNT(*) as count FROM books WHERE lower(trim(title)) = lower(trim(?));")
        .get(cleanTitle) as any;
      cDb.close();
      if (countRow && countRow.count > 1) {
        return false;
      }
    }
  } catch {
    // Ignore
  }

  return true;
}

/**
 * Static query text for the store's read paths.
 *
 * One literal per scope so the SQL text is provably constant: the shared-title
 * rule only ever changes which of these statements runs, never the text of a
 * statement, so nothing about a caller's book title reaches SQL as syntax.
 */
const HIGHLIGHT_PROJECTION =
  "id, book_id, book_title, chapter, page, quote, note, timestamp, color, style, sources, created_at";

const HIGHLIGHT_PAGE_ORDER =
  "ORDER BY CASE WHEN page IS NULL THEN 999999 ELSE page END ASC, id ASC";

const SQL_SELECT_BY_UNIQUE_TITLE =
  `SELECT ${HIGHLIGHT_PROJECTION} FROM book_highlights WHERE (book_id = ? OR (book_id IS NULL AND lower(trim(book_title)) = lower(trim(?)))) ${HIGHLIGHT_PAGE_ORDER} LIMIT ?;`;

const SQL_SELECT_BY_ID =
  `SELECT ${HIGHLIGHT_PROJECTION} FROM book_highlights WHERE book_id = ? ${HIGHLIGHT_PAGE_ORDER} LIMIT ?;`;

const SQL_SELECT_BY_TITLE =
  `SELECT ${HIGHLIGHT_PROJECTION} FROM book_highlights WHERE lower(trim(book_title)) = lower(trim(?)) ${HIGHLIGHT_PAGE_ORDER} LIMIT ?;`;

const SQL_SELECT_BY_ROW_ID =
  "SELECT id, book_id, book_title, chapter, page, quote, note, timestamp, color, style, sources, created_at FROM book_highlights WHERE id = ?;";

const SQL_SELECT_ALL =
  `SELECT ${HIGHLIGHT_PROJECTION} FROM book_highlights ${HIGHLIGHT_PAGE_ORDER} LIMIT ?;`;

/**
 * Reports whether a book's title is safe to widen to unlinked rows.
 * Single owner of the shared-title rule that the store's read paths share.
 */
export function isBookTitleScoped(
  db: Database,
  bookId: number,
  title?: string,
  calibreDbPath?: string,
): boolean {
  if (!title || !title.trim()) return false;
  return isTitleUniqueForBook(db, bookId, title.trim(), calibreDbPath);
}

/**
 * Retrieves all highlights for a book by book_id, falling back to title match only if title is unique.
 * If title match finds unlinked highlights (book_id IS NULL) and title is unique, auto-links them to book_id.
 */
export function getHighlightsForBook(
  db: Database,
  bookId: number,
  title?: string,
  limit = 1000,
  calibreDbPath?: string,
): HighlightRecord[] {
  initHighlightsTable(db);

  let rows: HighlightRecord[];
  if (isBookTitleScoped(db, bookId, title, calibreDbPath)) {
    const cleanTitle = (title as string).trim();
    // Auto-link unlinked highlights with matching title only if unique
    const updateRes = db.run(
      "UPDATE book_highlights SET book_id = ? WHERE book_id IS NULL AND lower(trim(book_title)) = lower(trim(?));",
      [bookId, cleanTitle],
    );
    if (updateRes && (updateRes as any).changes > 0) {
      invalidateHighlightCountsCache(db);
    }
    rows = db
      .query(SQL_SELECT_BY_UNIQUE_TITLE)
      .all(bookId, cleanTitle, limit) as HighlightRecord[];
  } else {
    // No title, or a title shared with another book: strictly by book_id so no
    // other book's quotes can leak in.
    rows = db.query(SQL_SELECT_BY_ID).all(bookId, limit) as HighlightRecord[];
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

  return db.query(SQL_SELECT_BY_TITLE).all(title.trim(), limit) as HighlightRecord[];
}

/**
 * Retrieves store rows across every book, newest row first.
 * Bounded by `limit`; the annotation store filters this in memory so a filter
 * can never silently truncate a result set.
 */
export function selectAllHighlights(
  db: Database,
  limit = 50_000,
): HighlightRecord[] {
  initHighlightsTable(db);
  return db.query(SQL_SELECT_ALL).all(limit) as HighlightRecord[];
}

/** Reads one store row by primary key. */
export function getHighlightById(
  db: Database,
  id: number,
): HighlightRecord | null {
  initHighlightsTable(db);
  if (!Number.isInteger(id) || id <= 0) return null;
  const row = db.query(SQL_SELECT_BY_ROW_ID).get(id) as HighlightRecord | null;
  return row ?? null;
}

export const HIGHLIGHT_COUNTS_CACHE_TTL_MS = 30_000; // 30 seconds

interface CachedHighlightCounts {
  result: HighlightCountsResult;
  timestamp: number;
  db: Database;
}

let _cachedHighlightCounts: CachedHighlightCounts | null = null;

export function invalidateHighlightCountsCache(db?: Database): void {
  if (!db || _cachedHighlightCounts?.db === db) {
    _cachedHighlightCounts = null;
  }
}

export function getCachedHighlightCountsForTesting(): { timestamp: number } | null {
  return _cachedHighlightCounts ? { timestamp: _cachedHighlightCounts.timestamp } : null;
}

/**
 * Fast aggregate counts across the entire library with latest quote previews.
 * Returns mapped counts and latest quote previews by book_id and lowercase title.
 * Memoized in-memory with a 30-second TTL fallback and auto-invalidated on mutations.
 */
export function getHighlightCounts(
  db: Database,
  options?: { forceFresh?: boolean },
): HighlightCountsResult {
  const now = Date.now();
  if (
    !options?.forceFresh &&
    _cachedHighlightCounts &&
    _cachedHighlightCounts.db === db &&
    now - _cachedHighlightCounts.timestamp < HIGHLIGHT_COUNTS_CACHE_TTL_MS
  ) {
    const res = _cachedHighlightCounts.result;
    return {
      byBookId: { ...res.byBookId },
      byTitle: { ...res.byTitle },
      previewsByBookId: { ...res.previewsByBookId },
      previewsByTitle: { ...res.previewsByTitle },
    };
  }

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

  const result: HighlightCountsResult = {
    byBookId,
    byTitle,
    previewsByBookId,
    previewsByTitle,
  };

  _cachedHighlightCounts = {
    result,
    timestamp: now,
    db,
  };

  return {
    byBookId: { ...byBookId },
    byTitle: { ...byTitle },
    previewsByBookId: { ...previewsByBookId },
    previewsByTitle: { ...previewsByTitle },
  };
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
    const cleanTitle = title.trim();
    const isUnique = isTitleUniqueForBook(db, bookId, cleanTitle);
    if (isUnique) {
      row = db
        .query(
          `SELECT quote, note
           FROM book_highlights
           WHERE book_id = ? OR (book_id IS NULL AND lower(trim(book_title)) = lower(trim(?)))
           ORDER BY id DESC
           LIMIT 1;`,
        )
        .get(bookId, cleanTitle);
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

        let author: string | undefined;
        const fmAuthorMatch = content.match(/^author:\s*(?:"([^"]+)"|'([^']+)'|([^\n]+))/m);
        if (fmAuthorMatch) {
          author = (fmAuthorMatch[1] || fmAuthorMatch[2] || fmAuthorMatch[3] || "").trim() || undefined;
        }

        const bookId = resolveBookIdFromTitle(title, options.calibreDbPath, author);
        const highlights = parseHighlightsFromMarkdown(content, title, bookId);

        if (highlights.length > 0) {
          const isShared = bookId ? !isTitleUniqueForBook(db, bookId, title, options.calibreDbPath) : false;
          if (isShared && author && author !== "Unknown") {
            const disambiguatedTitle = `${title.trim()} - ${author.trim()}`;
            for (const h of highlights) {
              h.book_title = disambiguatedTitle;
            }
          }
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
 * Deletes all highlights for a book by book_id, and also by title only if title is unique.
 */
export function deleteHighlightsForBook(
  db: Database,
  bookId: number,
  title?: string,
  calibreDbPath?: string,
): void {
  initHighlightsTable(db);
  if (title && title.trim()) {
    const cleanTitle = title.trim();
    const isUnique = isTitleUniqueForBook(db, bookId, cleanTitle, calibreDbPath);
    if (isUnique) {
      db.run(
        "DELETE FROM book_highlights WHERE book_id = ? OR (book_id IS NULL AND lower(trim(book_title)) = lower(trim(?)));",
        [bookId, cleanTitle],
      );
    } else {
      db.run("DELETE FROM book_highlights WHERE book_id = ?;", [bookId]);
    }
  } else {
    db.run("DELETE FROM book_highlights WHERE book_id = ?;", [bookId]);
  }
  invalidateHighlightCountsCache(db);
}

/**
 * Checks if highlights are present in DB; if 0 or stale, checks Obsidian Books folder
 * with strict path containment checks.
 */
export function ensureBookHighlightsIndexed(
  db: Database,
  bookId: number,
  title: string,
  options: { booksDir?: string; calibreDbPath?: string; forceFresh?: boolean; author?: string } = {},
): HighlightRecord[] {
  let existing = getHighlightsForBook(db, bookId, title, 1000, options.calibreDbPath);

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

    // Try to resolve author and shared status from Calibre if not provided
    let author = options.author;
    let isSharedInCalibre = false;
    try {
      const dbPath =
        options.calibreDbPath ||
        process.env.CALIBRE_DB_PATH ||
        path.join(process.env.HOME || os.homedir(), "Calibre Libraries", "Agent Library", "metadata.db");
      if (fs.existsSync(dbPath)) {
        const cDb = new Database(dbPath, { readonly: true });
        const aRow = cDb
          .query(
            `SELECT GROUP_CONCAT(DISTINCT a.name) as authors
             FROM books_authors_link bal
             JOIN authors a ON bal.author = a.id
             WHERE bal.book = ?;`,
          )
          .get(bookId) as any;
        if (aRow?.authors && !author) {
          author = aRow.authors;
        }
        const countRow = cDb
          .query("SELECT COUNT(*) as count FROM books WHERE lower(trim(title)) = lower(trim(?));")
          .get(title.trim()) as any;
        if (countRow && countRow.count > 1) {
          isSharedInCalibre = true;
        }
        cDb.close();
      }
    } catch {
      // Ignore
    }

    const isShared = isSharedInCalibre || !isTitleUniqueForBook(db, bookId, title.trim(), options.calibreDbPath);

    const candidateFiles: string[] = [];

    if (author && author.trim() && author !== "Unknown") {
      const safeAuthor = path.basename(author.replace(/[\\/:*?"<>|]/g, "_").trim());
      const cleanAuthor = path.basename(author.replace(/[\/:]/g, " - ").trim());
      candidateFiles.push(`${safeTitleBase} - ${safeAuthor}.md`);
      candidateFiles.push(`${path.basename(title.replace(/[\/:]/g, " - ").trim())} - ${cleanAuthor}.md`);

      // Handle Last, First ↔ First Last (e.g. "Fry, Stephen" ↔ "Stephen Fry")
      if (author.includes(",")) {
        const parts = author.split(",").map((p) => p.trim()).filter(Boolean);
        if (parts.length === 2) {
          const firstLast = path.basename(`${parts[1]} ${parts[0]}`.replace(/[\\/:*?"<>|]/g, "_").trim());
          candidateFiles.push(`${safeTitleBase} - ${firstLast}.md`);
          candidateFiles.push(`${path.basename(title.replace(/[\/:]/g, " - ").trim())} - ${firstLast}.md`);
        }
      } else {
        const words = author.trim().split(/\s+/);
        if (words.length >= 2) {
          const lastFirst = path.basename(`${words[words.length - 1]}, ${words.slice(0, -1).join(" ")}`.replace(/[\\/:*?"<>|]/g, "_").trim());
          candidateFiles.push(`${safeTitleBase} - ${lastFirst}.md`);
        }
      }
    }

    // ONLY check unsuffixed Title.md if the title is NOT shared!
    // When a title is shared, unsuffixed Title.md may belong to another book.
    if (!isShared) {
      candidateFiles.push(`${safeTitleBase}.md`);
      candidateFiles.push(`${path.basename(title.replace(/[\/:]/g, " - ").trim())}.md`);
    }

    // Locate matching file among candidateFiles
    let matchedPath: string | null = null;
    for (const name of candidateFiles) {
      const notePath = path.join(booksDir, name);
      const resolved = path.resolve(notePath);
      if (resolved.startsWith(resolvedBooksDir + path.sep) && fs.existsSync(resolved)) {
        matchedPath = resolved;
        break;
      }
    }

    // If not found in candidateFiles and title is shared, scan directory notes by frontmatter author
    if (!matchedPath && isShared && author && author !== "Unknown") {
      try {
        const entries = fs.readdirSync(booksDir, { withFileTypes: true });
        for (const ent of entries) {
          if (ent.isFile() && ent.name.endsWith(".md") && !ent.name.startsWith(".")) {
            const fullP = path.resolve(path.join(booksDir, ent.name));
            if (fullP.startsWith(resolvedBooksDir + path.sep)) {
              const noteContent = fs.readFileSync(fullP, "utf8");
              const fmTitleMatch = noteContent.match(/^title:\s*(?:"([^"]+)"|'([^']+)'|([^\n]+))/m);
              const fmAuthorMatch = noteContent.match(/^author:\s*(?:"([^"]+)"|'([^']+)'|([^\n]+))/m);
              const nTitle = (fmTitleMatch?.[1] || fmTitleMatch?.[2] || fmTitleMatch?.[3] || "").trim();
              const nAuthor = (fmAuthorMatch?.[1] || fmAuthorMatch?.[2] || fmAuthorMatch?.[3] || "").trim();

              if (nTitle && title.trim().toLowerCase() === nTitle.toLowerCase()) {
                if (authorsMatch(nAuthor, author)) {
                  matchedPath = fullP;
                  break;
                }
              }
            }
          }
        }
      } catch {
        // Ignore
      }
    }

    if (matchedPath) {
      try {
        const st = fs.lstatSync(matchedPath);
        if (!st.isSymbolicLink() && st.isFile()) {
          // Check if file is newer than existing highlights or forceFresh was requested
          let shouldReindex = options.forceFresh || existing.length === 0;
          if (!shouldReindex && existing.length > 0) {
            const latestCreated = isShared
              ? (db
                  .query(
                    `SELECT MAX(created_at) as max_c FROM book_highlights WHERE book_id = ?;`,
                  )
                  .get(bookId) as any)
              : (db
                  .query(
                    `SELECT MAX(created_at) as max_c FROM book_highlights
                     WHERE book_id = ? OR (book_id IS NULL AND lower(trim(book_title)) = lower(trim(?)));`,
                  )
                  .get(bookId, title.trim()) as any);

            if (latestCreated?.max_c) {
              const str = String(latestCreated.max_c).trim();
              const isoStr = str.endsWith("Z")
                ? str
                : str.includes("T")
                  ? `${str}Z`
                  : `${str.replace(" ", "T")}Z`;
              const parsed = new Date(isoStr).getTime();
              const latestMs = Number.isNaN(parsed)
                ? new Date(str).getTime()
                : parsed;
              // Guard threshold of 1000ms prevents infinite reindexing loops from sub-second SQLite datetime truncation
              if (!Number.isNaN(latestMs) && st.mtimeMs > latestMs + 1000) {
                shouldReindex = true;
              }
            }
          }

          if (shouldReindex) {
            const content = fs.readFileSync(matchedPath, "utf8");
            const parsed = parseHighlightsFromMarkdown(content, title, bookId);

            if (options.forceFresh) {
              deleteHighlightsForBook(db, bookId, title, options.calibreDbPath);
            }

            if (parsed.length > 0) {
              if (isShared && author && author !== "Unknown") {
                const disambiguatedTitle = `${title.trim()} - ${author.trim()}`;
                for (const p of parsed) {
                  p.book_title = disambiguatedTitle;
                }
              }
              batchUpsertHighlights(db, parsed);
            }
            return getHighlightsForBook(db, bookId, title, 1000, options.calibreDbPath);
          }
        }
      } catch (_readErr) {
        void _readErr;
      }
    }
  }

  return existing;
}
