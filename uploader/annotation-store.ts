/**
 * uploader/annotation-store.ts
 *
 * The LightHouse annotation store: one queryable owner for every highlight that
 * KOReader, Kindle, the LightHouse web reader, and Obsidian note sync bring in.
 *
 * `book_highlights` (uploader/highlights.ts) owns the table, the columns, and the
 * upsert statement. This module owns what those columns mean:
 *
 *   - `sources` is a set of ingestion paths that currently report the highlight.
 *     One row can be claimed by several paths at once.
 *   - `color` and `style` are normalized tokens so a filter can name a color the
 *     way a person does instead of matching a vendor's drawer string.
 *   - Reconciliation is snapshot-based. Ingesting a source's full highlight list
 *     for a book retires every row that source used to report and no longer does.
 *     A highlight deleted at its source therefore leaves the store, and every
 *     exporter (Markdown, CSV, JSON, the Obsidian note) reads the store rather
 *     than the last snapshot anyone happened to write.
 *
 * Parsing is NOT reimplemented here: markdown/caption parsing stays in
 * uploader/highlights.ts and uploader/joplin.ts, and callers hand this module
 * already-parsed entries.
 */

import { Database } from "bun:sqlite";

import {
  batchUpsertHighlights,
  cleanQuoteText,
  getHighlightById,
  getHighlightsByTitle,
  getHighlightsForBook,
  initHighlightsTable,
  invalidateHighlightCountsCache,
  parseHighlightsFromMarkdown,
  selectAllHighlights,
} from "./highlights";

// ----------------------------------------------------------------------------
// Vocabulary
// ----------------------------------------------------------------------------

/** Every ingestion path that can claim a highlight. */
export const ANNOTATION_SOURCES = [
  "koreader",
  "kindle",
  "web",
  "obsidian",
  "legacy",
] as const;

export type AnnotationSource = (typeof ANNOTATION_SOURCES)[number];

/**
 * Rows written before source tracking existed. A row may hold `legacy` only as a
 * sole owner; the moment a real source claims it, `legacy` is dropped, so a
 * retired highlight does not survive as an unattributed ghost.
 */
export const LEGACY_SOURCE: AnnotationSource = "legacy";

/** Color tokens the store will name. Anything else is kept as its own token. */
export const ANNOTATION_COLORS = [
  "red",
  "orange",
  "yellow",
  "green",
  "cyan",
  "blue",
  "purple",
  "pink",
  "grey",
] as const;

/** Style tokens the store will name. */
export const ANNOTATION_STYLES = [
  "highlight",
  "underline",
  "strikethrough",
  "invert",
  "note",
  "bookmark",
] as const;

const COLOR_ALIASES = new Map<string, string>([
  ["gray", "grey"],
  ["grey", "grey"],
  ["silver", "grey"],
  ["magenta", "pink"],
  ["violet", "purple"],
  ["indigo", "blue"],
  ["teal", "cyan"],
]);

const STYLE_ALIASES = new Map<string, string>([
  ["lighten", "highlight"],
  ["highlight", "highlight"],
  ["highlights", "highlight"],
  ["highlighted", "highlight"],
  ["underscore", "underline"],
  ["underscored", "underline"],
  ["underline", "underline"],
  ["underlined", "underline"],
  ["strikeout", "strikethrough"],
  ["strike", "strikethrough"],
  ["strikethrough", "strikethrough"],
  ["strikethroughs", "strikethrough"],
  ["invert", "invert"],
  ["inverted", "invert"],
  ["note", "note"],
  ["notes", "note"],
  ["bookmark", "bookmark"],
]);

// ----------------------------------------------------------------------------
// Input / Output Shapes
// ----------------------------------------------------------------------------

export interface AnnotationInput {
  quote: string;
  note?: string | null;
  chapter?: string | null;
  page?: number | null;
  timestamp?: string | null;
  color?: string | null;
  style?: string | null;
}

export interface AnnotationRecord {
  id: number;
  book_id: number | null;
  book_title: string;
  chapter: string | null;
  page: number | null;
  quote: string;
  note: string | null;
  timestamp: string | null;
  created_at: string | null;
  color: string | null;
  style: string | null;
  sources: AnnotationSource[];
}

export interface AnnotationFilter {
  bookId?: number | null;
  title?: string | null;
  color?: string | null;
  style?: string | null;
  source?: string | null;
  /** Case-insensitive substring over quote, note, chapter, and book title. */
  query?: string | null;
  limit?: number;
  calibreDbPath?: string;
}

export interface AnnotationReconcileInput {
  db: Database;
  bookId?: number | null;
  bookTitle: string;
  source: AnnotationSource;
  /** The source's complete current highlight list for this book. */
  entries: AnnotationInput[];
  /**
   * Retire unattributed (`legacy`) rows for this book that the snapshot no
   * longer reports. Only safe when the caller knows the snapshot is complete
   * for the book, so it defaults to off.
   */
  adoptLegacy?: boolean;
  calibreDbPath?: string;
}

export interface AnnotationReconcileResult {
  bookTitle: string;
  source: AnnotationSource;
  added: number;
  refreshed: number;
  removed: number;
  removedQuotes: string[];
  total: number;
}

export interface AnnotationSummary {
  total: number;
  byColor: Record<string, number>;
  byStyle: Record<string, number>;
  bySource: Record<string, number>;
}

// ----------------------------------------------------------------------------
// Normalization
// ----------------------------------------------------------------------------

/**
 * Splits a `sources` cell into its tokens.
 * Returns an empty array for a row that never had a source recorded.
 */
export function parseSources(raw?: string | null): string[] {
  if (!raw) return [];
  const seen = new Set<string>();
  const out: string[] = [];
  for (const part of String(raw).split(",")) {
    const token = part.trim().toLowerCase();
    if (token && !seen.has(token)) {
      seen.add(token);
      out.push(token);
    }
  }
  return out;
}

/** Joins source tokens into the stored `sources` representation. */
export function formatSources(sources: Iterable<string>): string {
  const seen = new Set<string>();
  for (const s of sources) {
    const token = String(s ?? "").trim().toLowerCase();
    if (token) seen.add(token);
  }
  return Array.from(seen).join(",");
}

/**
 * Effective source set for a row.
 * An unattributed row reports the `legacy` source so reconciliation can reason
 * about it instead of silently ignoring it.
 */
export function effectiveSources(raw?: string | null): AnnotationSource[] {
  const parsed = parseSources(raw);
  if (parsed.length === 0) return [LEGACY_SOURCE];
  return parsed as AnnotationSource[];
}

/**
 * Maps a hex color to the nearest named bucket by hue, and passes through a
 * color already named in words. Nothing here depends on a vendor's palette: the
 * same input always produces the same token, so filters and exports agree.
 */
export function normalizeColor(raw?: string | null): string | null {
  if (raw === undefined || raw === null) return null;
  let token = String(raw).trim().toLowerCase();
  if (!token) return null;

  // A KOReader drawer carries its color after a '#', e.g. "lighten#ffc000".
  if (token.includes("#") && !token.startsWith("#")) {
    token = token.slice(token.indexOf("#"));
  }

  const hex = token.replace(/^#/, "");
  if (/^[0-9a-f]{3}$/.test(hex) || /^[0-9a-f]{6}$/.test(hex)) {
    const full =
      hex.length === 3
        ? hex
            .split("")
            .map((c) => c + c)
            .join("")
        : hex;
    return colorNameFromHex(full);
  }

  return COLOR_ALIASES.get(token) ?? token;
}

function colorNameFromHex(hex: string): string {
  const r = parseInt(hex.slice(0, 2), 16) / 255;
  const g = parseInt(hex.slice(2, 4), 16) / 255;
  const b = parseInt(hex.slice(4, 6), 16) / 255;

  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const lightness = (max + min) / 2;
  const delta = max - min;

  // Near-neutral paint is a grey marker, not a hue.
  if (delta < 0.08) return "grey";

  let hue: number;
  if (max === r) hue = ((g - b) / delta) % 6;
  else if (max === g) hue = (b - r) / delta + 2;
  else hue = (r - g) / delta + 4;
  hue *= 60;
  if (hue < 0) hue += 360;

  const isPale = lightness > 0.92;
  if (isPale) return "grey";

  if (hue < 15) return "red";
  // 15-48 rather than the textbook 15-45: KOReader's amber marking pen sits at
  // ~45 degrees and reads as orange to anyone looking at the page.
  if (hue < 48) return "orange";
  if (hue < 70) return "yellow";
  if (hue < 165) return "green";
  if (hue < 195) return "cyan";
  if (hue < 260) return "blue";
  if (hue < 315) return "purple";
  return "pink";
}

/** Maps a drawer/kind string to a style token. */
export function normalizeStyle(raw?: string | null): string | null {
  if (raw === undefined || raw === null) return null;
  let token = String(raw).trim().toLowerCase();
  if (!token) return null;

  // "lighten#ffc000" and friends: keep the style half.
  if (token.includes("#")) token = token.slice(0, token.indexOf("#"));
  token = token.replace(/[\s_-]+/g, "");

  return STYLE_ALIASES.get(token) ?? token;
}

/**
 * Compares highlight text for identity. Mirrors cleanQuoteText so a quote and
 * its quoted form (blockquoted, wrapped, retyped casing) are one highlight.
 */
export function normalizeQuoteKey(raw?: string | null): string {
  const cleaned = cleanQuoteText(raw ?? "");
  if (!cleaned) return "";
  return cleaned
    .normalize("NFC")
    .toLowerCase()
    .replace(/\s+/g, " ")
    .trim();
}

export function isAnnotationSource(value: unknown): value is AnnotationSource {
  return (
    typeof value === "string" &&
    (ANNOTATION_SOURCES as readonly string[]).includes(value)
  );
}

/**
 * Resolves a caller's source argument to a known token.
 * Unknown values are rejected so a typo cannot create a phantom source set that
 * reconciliation would then never clean up.
 */
export function resolveSource(raw?: string | null): AnnotationSource | null {
  if (!raw) return null;
  const token = String(raw).trim().toLowerCase();
  return isAnnotationSource(token) ? token : null;
}

// ----------------------------------------------------------------------------
// Schema
// ----------------------------------------------------------------------------

export function ensureAnnotationSchema(db: Database): void {
  initHighlightsTable(db);
}

// ----------------------------------------------------------------------------
// Reads
// ----------------------------------------------------------------------------

function toRecord(row: {
  id?: number;
  book_id: number | null;
  book_title: string;
  chapter: string | null;
  page: number | null;
  quote: string;
  note: string | null;
  timestamp: string | null;
  created_at?: string;
  color?: string | null;
  style?: string | null;
  sources?: string | null;
}): AnnotationRecord {
  return {
    id: Number(row.id ?? 0),
    book_id: row.book_id ?? null,
    book_title: row.book_title,
    chapter: row.chapter ?? null,
    page: row.page ?? null,
    quote: row.quote,
    note: row.note ?? null,
    timestamp: row.timestamp ?? null,
    created_at: row.created_at ?? null,
    color: row.color ?? null,
    style: row.style ?? null,
    sources: effectiveSources(row.sources),
  };
}

function readBookRows(
  db: Database,
  bookId: number | null | undefined,
  bookTitle: string,
  calibreDbPath?: string,
): AnnotationRecord[] {
  const rows =
    bookId === null || bookId === undefined
      ? getHighlightsByTitle(db, bookTitle, 100_000)
      : getHighlightsForBook(db, bookId, bookTitle, 100_000, calibreDbPath);
  return rows.map(toRecord);
}

/**
 * Filters the store. Book scoping reuses the shared-title rule in
 * uploader/highlights.ts; color/style/source/text filters apply in memory so a
 * filter can never silently truncate the result set it was asked for.
 */
export function queryAnnotations(
  db: Database,
  filter: AnnotationFilter = {},
): AnnotationRecord[] {
  ensureAnnotationSchema(db);

  const limit = Math.max(1, Math.min(filter.limit ?? 1000, 50_000));
  const bookId = filter.bookId ?? null;
  const hasBook = bookId !== null || Boolean(filter.title && filter.title.trim());

  const candidates = hasBook
    ? readBookRows(db, bookId, (filter.title ?? "").trim(), filter.calibreDbPath)
    : selectAllHighlights(db, 50_000).map(toRecord);

  const color = normalizeColor(filter.color);
  const style = normalizeStyle(filter.style);
  const source = filter.source ? String(filter.source).trim().toLowerCase() : null;
  const needle = filter.query ? filter.query.trim().toLowerCase() : "";

  const matched = candidates.filter((row) => {
    if (color && row.color !== color) return false;
    if (style && row.style !== style) return false;
    if (source && !row.sources.includes(source as AnnotationSource)) {
      // An explicit "all"/"any" selector means no source restriction.
      if (source !== "all" && source !== "any") return false;
    }
    if (needle) {
      const haystack = [row.quote, row.note, row.chapter, row.book_title]
        .filter(Boolean)
        .join("\n")
        .toLowerCase();
      if (!haystack.includes(needle)) return false;
    }
    return true;
  });

  return matched.slice(0, limit);
}

export function annotationSummary(db: Database): AnnotationSummary {
  ensureAnnotationSchema(db);
  const rows = selectAllHighlights(db, 50_000).map(toRecord);

  const byColor: Record<string, number> = {};
  const byStyle: Record<string, number> = {};
  const bySource: Record<string, number> = {};

  for (const row of rows) {
    if (row.color) byColor[row.color] = (byColor[row.color] ?? 0) + 1;
    if (row.style) byStyle[row.style] = (byStyle[row.style] ?? 0) + 1;
    for (const s of row.sources) bySource[s] = (bySource[s] ?? 0) + 1;
  }

  return { total: rows.length, byColor, byStyle, bySource };
}

// ----------------------------------------------------------------------------
// Writes
// ----------------------------------------------------------------------------

const SQL_UPDATE_SOURCES =
  "UPDATE book_highlights SET sources = ? WHERE id = ?;";

const SQL_DELETE_BY_ID = "DELETE FROM book_highlights WHERE id = ?;";

export interface UpsertAnnotationInput extends AnnotationInput {
  db: Database;
  bookId?: number | null;
  bookTitle: string;
  source: AnnotationSource;
}

/**
 * Writes one annotation, joining `source` into its source set.
 * Returns the number of rows written (0 when the quote is empty).
 */
export function upsertAnnotation(input: UpsertAnnotationInput): number {
  ensureAnnotationSchema(input.db);
  const quote = cleanQuoteText(input.quote ?? "");
  if (!quote) return 0;

  const written = batchUpsertHighlights(input.db, [
    {
      book_id: input.bookId ?? null,
      book_title: input.bookTitle.trim(),
      chapter: input.chapter ?? null,
      page: normalizePage(input.page),
      quote,
      note: input.note ?? null,
      timestamp: input.timestamp ?? null,
      color: normalizeColor(input.color),
      style: normalizeStyle(input.style),
      sources: input.source,
    },
  ]);
  invalidateHighlightCountsCache(input.db);
  return written;
}

export function normalizePage(raw?: number | string | null): number | null {
  if (raw === undefined || raw === null || raw === "") return null;
  if (typeof raw === "number") {
    return Number.isFinite(raw) ? Math.trunc(raw) : null;
  }
  const parsed = parseInt(String(raw), 10);
  return Number.isNaN(parsed) ? null : parsed;
}

/**
 * Removes one annotation from the store.
 *
 * This is an explicit store edit, not source propagation: the row leaves the
 * store and every export immediately, and a device that still reports the
 * highlight will re-add it on its next sync.
 */
/** Reads one annotation by row id. */
export function getAnnotationById(
  db: Database,
  id: number,
): AnnotationRecord | null {
  ensureAnnotationSchema(db);
  const row = getHighlightById(db, id);
  return row ? toRecord(row) : null;
}

export function deleteAnnotation(db: Database, id: number): boolean {
  ensureAnnotationSchema(db);
  if (!Number.isInteger(id) || id <= 0) return false;
  const result = db.run(SQL_DELETE_BY_ID, [id]);
  const changed = Number((result as { changes?: number }).changes ?? 0) > 0;
  if (changed) invalidateHighlightCountsCache(db);
  return changed;
}

function mergeSnapshotEntry(
  target: AnnotationInput,
  incoming: AnnotationInput,
): void {
  if (!target.note && incoming.note) target.note = incoming.note;
  if (target.page === null && incoming.page !== null) target.page = incoming.page;
  if (!target.chapter && incoming.chapter) target.chapter = incoming.chapter;
  if (!target.timestamp && incoming.timestamp) target.timestamp = incoming.timestamp;
  if (!target.color && incoming.color) target.color = incoming.color;
  if (!target.style && incoming.style) target.style = incoming.style;
}

/**
 * Normalizes a source snapshot into one entry per highlight, keyed by quote
 * identity. A later duplicate enriches an earlier one instead of overwriting
 * richer metadata with poorer metadata; an entry with no quotable text is
 * dropped so a snapshot can never create a row nothing can match later.
 */
function buildSnapshot(entries: AnnotationInput[]): Map<string, AnnotationInput> {
  const snapshot = new Map<string, AnnotationInput>();
  for (const entry of entries) {
    const quote = cleanQuoteText(entry?.quote ?? "");
    const key = normalizeQuoteKey(quote);
    if (!key) continue;
    const normalized: AnnotationInput = {
      quote,
      note: entry.note ?? null,
      chapter: entry.chapter ?? null,
      page: normalizePage(entry.page),
      timestamp: entry.timestamp ?? null,
      color: normalizeColor(entry.color),
      style: normalizeStyle(entry.style),
    };
    const existing = snapshot.get(key);
    if (existing) mergeSnapshotEntry(existing, normalized);
    else snapshot.set(key, normalized);
  }
  return snapshot;
}

/**
 * Removes `source` from every row it no longer reports and deletes rows left
 * with no owner at all. Returns what left the store so a caller can report it.
 */
function retireUnreported(
  input: AnnotationReconcileInput,
  bookTitle: string,
  snapshot: Map<string, AnnotationInput>,
): { removed: number; removedQuotes: string[] } {
  const { db, source } = input;
  const removedQuotes: string[] = [];

  for (const row of readBookRows(db, input.bookId, bookTitle, input.calibreDbPath)) {
    const reported = snapshot.has(normalizeQuoteKey(row.quote));
    // `row.sources` is already the effective, de-duplicated set (an unattributed
    // row reports the legacy marker), so it is the only thing to reason about.
    const stored = row.sources.map((s) => String(s));
    let next: string[] = stored;

    // `legacy` is only ever a sole owner: once a real source claims the row, the
    // unattributed marker is dropped so a retired highlight cannot hide there.
    if (next.length > 1) {
      next = next.filter((s) => s !== LEGACY_SOURCE);
    }

    if (next.includes(source) && !reported) {
      next = next.filter((s) => s !== source);
    }

    if (input.adoptLegacy && !reported && next.length === 1 && next[0] === LEGACY_SOURCE) {
      next = [];
    }

    if (next.length === 0) {
      db.run(SQL_DELETE_BY_ID, [row.id]);
      removedQuotes.push(row.quote);
      continue;
    }

    const nextFormatted = formatSources(next);
    if (nextFormatted !== formatSources(stored)) {
      db.run(SQL_UPDATE_SOURCES, [nextFormatted, row.id]);
    }
  }

  return { removed: removedQuotes.length, removedQuotes };
}

/**
 * Snapshot reconciliation: the acceptance-critical deletion path.
 *
 * Given a source's COMPLETE current highlight list for a book:
 *   1. every entry is upserted and `source` joins its source set;
 *   2. a row that `source` used to own but no longer appears in the snapshot
 *      loses `source` from its set;
 *   3. a row left with no owner at all is deleted from the store.
 *
 * Step 3 is what makes a deletion at the source reach every exporter, because
 * exporters render the store rather than the last snapshot written.
 */
export function reconcileAnnotations(
  input: AnnotationReconcileInput,
): AnnotationReconcileResult {
  const { db, source } = input;
  ensureAnnotationSchema(db);

  const bookTitle = (input.bookTitle ?? "").trim();
  if (!bookTitle) {
    throw new Error("reconcileAnnotations requires a book title");
  }

  const before = new Map<string, AnnotationRecord>();
  for (const row of readBookRows(db, input.bookId, bookTitle, input.calibreDbPath)) {
    before.set(normalizeQuoteKey(row.quote), row);
  }

  const snapshot = buildSnapshot(input.entries ?? []);

  // A quote that only differs from a stored row by quoting or whitespace is the
  // same highlight: write it under the row's existing text so the unique key
  // holds and no duplicate row is created.
  batchUpsertHighlights(
    db,
    Array.from(snapshot.entries()).map(([key, entry]) => ({
      book_id: input.bookId ?? null,
      book_title: bookTitle,
      chapter: entry.chapter ?? null,
      page: entry.page ?? null,
      quote: before.get(key)?.quote ?? entry.quote,
      note: entry.note ?? null,
      timestamp: entry.timestamp ?? null,
      color: entry.color ?? null,
      style: entry.style ?? null,
      sources: source as string,
    })),
    // A snapshot that omits an annotation must not erase the one already stored:
    // an annotation is usually written once, on one path, and later exports of
    // the same quote routinely drop it.
    { preserveNotes: true },
  );

  const { removed, removedQuotes } = retireUnreported(input, bookTitle, snapshot);
  invalidateHighlightCountsCache(db);

  const added = Array.from(snapshot.keys()).filter((k) => !before.has(k)).length;
  const refreshed = snapshot.size - added;

  return {
    bookTitle,
    source,
    added,
    refreshed,
    removed,
    removedQuotes,
    total: readBookRows(db, input.bookId, bookTitle, input.calibreDbPath).length,
  };
}

/**
 * Retires every row that no ingestion path claims, i.e. rows that only carry the
 * `legacy` marker. Deliberate maintenance: run it after every device has synced
 * once under source tracking, so a highlight that still exists on a device has
 * already re-claimed its row.
 */
export function pruneLegacyAnnotations(db: Database): number {
  ensureAnnotationSchema(db);
  const rows = selectAllHighlights(db, 50_000).map(toRecord);
  let removed = 0;
  for (const row of rows) {
    if (row.sources.length === 1 && row.sources[0] === LEGACY_SOURCE) {
      db.run(SQL_DELETE_BY_ID, [row.id]);
      removed++;
    }
  }
  if (removed > 0) invalidateHighlightCountsCache(db);
  return removed;
}

// ----------------------------------------------------------------------------
// Exporters share this view
// ----------------------------------------------------------------------------

export interface AnnotationNoteEntry {
  text: string;
  notes?: string;
  chapter?: string;
  page?: number;
  datetime?: string;
  color?: string;
  style?: string;
  sources?: string[];
}

/**
 * Adapts store records to the note-entry shape the Obsidian exporter renders.
 * Exporters hand back this view so the note, CSV, JSON, and Markdown outputs all
 * say the same thing about the same highlight.
 */
export function annotationsToNoteEntries(
  records: AnnotationRecord[],
): AnnotationNoteEntry[] {
  return records.map((row) => ({
    text: row.quote,
    notes: row.note ?? undefined,
    chapter: row.chapter ?? undefined,
    page: row.page ?? undefined,
    datetime: row.timestamp ?? undefined,
    color: row.color ?? undefined,
    style: row.style ?? undefined,
    sources: row.sources,
  }));
}

/** Store rows for one book, in the note-entry shape every exporter renders. */
export function readStoreNoteEntries(
  db: Database,
  bookId: number | null | undefined,
  title: string,
): AnnotationNoteEntry[] {
  return annotationsToNoteEntries(
    queryAnnotations(db, { bookId: bookId ?? null, title, limit: 50_000 }),
  );
}

/**
 * Quote keys already claimed by a device source.
 * An entry the note shares with a device is not the note's to retire, so this is
 * what keeps a store-rendered quote from being mistaken for a manual one.
 */
export function claimedQuoteKeys(records: AnnotationRecord[]): Set<string> {
  const keys = new Set<string>();
  for (const row of records) {
    const deviceOwned = row.sources.some(
      (s) => s !== "obsidian" && s !== LEGACY_SOURCE,
    );
    if (deviceOwned) keys.add(normalizeQuoteKey(row.quote));
  }
  return keys;
}

/**
 * The note entries a person added by hand: present in the note, claimed by no
 * device source. Only these belong to the `obsidian` source, which is what lets
 * deleting one from the note delete it from the store and every export.
 *
 * `retiredNow` holds quotes a device snapshot retired during this same pass.
 * They must never be adopted back from the note: the note copy is our own prior
 * output, so re-adopting it would resurrect exactly the deletion the snapshot
 * just recorded.
 */
export function collectManualNoteEntries(
  noteContent: string,
  title: string,
  bookId: number | null | undefined,
  claimed: Set<string>,
  retiredNow: Set<string> = new Set(),
): AnnotationNoteEntry[] {
  if (!noteContent || !noteContent.trim()) return [];

  let records: ReturnType<typeof parseHighlightsFromMarkdown>;
  try {
    records = parseHighlightsFromMarkdown(noteContent, title, bookId ?? null);
  } catch {
    return [];
  }

  const entries: AnnotationNoteEntry[] = [];
  for (const record of records) {
    const key = normalizeQuoteKey(record.quote);
    if (!key) continue;
    if (claimed.has(key)) continue;
    if (retiredNow.has(key)) continue;
    entries.push({
      text: record.quote,
      notes: record.note ?? undefined,
      chapter: record.chapter ?? undefined,
      page: record.page ?? undefined,
      datetime: record.timestamp ?? undefined,
    });
  }
  return entries;
}

export interface StoreIngestResult {
  added: number;
  removed: string[];
}

/**
 * Single owner of "this book's sources become store state".
 *
 * Device snapshots are reconciled first, so a quote a device still reports is
 * claimed by that device. The note's own hand-added entries are reconciled last
 * as the `obsidian` source. That order is what stops a store-rendered quote from
 * being adopted by the note and outliving the device that deleted it.
 */
export function ingestBookIntoStore(options: {
  db: Database;
  bookId: number | null | undefined;
  title: string;
  snapshots: Partial<Record<AnnotationSource, AnnotationInput[]>>;
  noteContent?: string;
  /**
   * Retire unattributed pre-upgrade rows this pass does not report.
   * Only safe when `snapshots` covers every device source for the book.
   */
  adoptLegacy?: boolean;
}): StoreIngestResult {
  const { db, bookId, title } = options;
  let added = 0;
  const removed: string[] = [];
  const retiredNow = new Set<string>();

  for (const [source, entries] of Object.entries(options.snapshots)) {
    if (source === "obsidian" || source === LEGACY_SOURCE) continue;
    const result = reconcileAnnotations({
      db,
      bookId,
      bookTitle: title,
      source: source as AnnotationSource,
      entries: entries ?? [],
      adoptLegacy: options.adoptLegacy,
    });
    added += result.added;
    removed.push(...result.removedQuotes);
    for (const quote of result.removedQuotes) {
      const key = normalizeQuoteKey(quote);
      if (key) retiredNow.add(key);
    }
  }

  const claimed = claimedQuoteKeys(
    queryAnnotations(db, { bookId: bookId ?? null, title, limit: 50_000 }),
  );
  const manual = collectManualNoteEntries(
    options.noteContent ?? "",
    title,
    bookId,
    claimed,
    retiredNow,
  );
  const manualResult = reconcileAnnotations({
    db,
    bookId,
    bookTitle: title,
    source: "obsidian",
    entries: manual.map((entry) => ({
      quote: entry.text,
      note: entry.notes ?? null,
      chapter: entry.chapter ?? null,
      page: entry.page ?? null,
      timestamp: entry.datetime ?? null,
      color: entry.color ?? null,
      style: entry.style ?? null,
    })),
  });

  return {
    added: added + manualResult.added,
    removed: [...removed, ...manualResult.removedQuotes],
  };
}
