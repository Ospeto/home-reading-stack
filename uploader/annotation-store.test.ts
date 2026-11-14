import { describe, expect, it, beforeEach, afterEach } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Database } from "bun:sqlite";

import {
  ANNOTATION_COLORS,
  LEGACY_SOURCE,
  annotationSummary,
  annotationsToNoteEntries,
  deleteAnnotation,
  effectiveSources,
  ensureAnnotationSchema,
  formatSources,
  normalizeColor,
  normalizePage,
  normalizeQuoteKey,
  normalizeStyle,
  parseSources,
  pruneLegacyAnnotations,
  queryAnnotations,
  reconcileAnnotations,
  resolveSource,
  upsertAnnotation,
  type AnnotationInput,
} from "./annotation-store";
import { batchUpsertHighlights, initHighlightsTable } from "./highlights";

function makeCalibreDb(dbPath: string): void {
  const cDb = new Database(dbPath);
  cDb.run(`
    CREATE TABLE books (id INTEGER PRIMARY KEY, title TEXT, path TEXT, has_cover INTEGER, pubdate TEXT, series_index REAL);
    CREATE TABLE data (id INTEGER PRIMARY KEY, book INTEGER, format TEXT, name TEXT, uncompressed_size INTEGER);
    CREATE TABLE authors (id INTEGER PRIMARY KEY, name TEXT);
    CREATE TABLE books_authors_link (id INTEGER PRIMARY KEY, book INTEGER, author INTEGER);
    CREATE TABLE series (id INTEGER PRIMARY KEY, name TEXT);
    CREATE TABLE books_series_link (id INTEGER PRIMARY KEY, book INTEGER, series INTEGER);
    CREATE TABLE comments (id INTEGER PRIMARY KEY, book INTEGER, text TEXT);
  `);
  cDb.run(
    "INSERT INTO books (id, title, path, has_cover) VALUES (1, 'Dune', 'Frank Herbert/Dune (1)', 1);",
  );
  cDb.run("INSERT INTO authors (id, name) VALUES (1, 'Frank Herbert');");
  cDb.run("INSERT INTO books_authors_link (id, book, author) VALUES (1, 1, 1);");
  cDb.run(
    "INSERT INTO books (id, title, path, has_cover) VALUES (2, 'Neuromancer', 'William Gibson/Neuromancer (2)', 1);",
  );
  cDb.run("INSERT INTO authors (id, name) VALUES (2, 'William Gibson');");
  cDb.run("INSERT INTO books_authors_link (id, book, author) VALUES (2, 2, 2);");
  cDb.close();
}

const DUNE = { bookId: 1, bookTitle: "Dune" };

function entry(quote: string, extra: Partial<AnnotationInput> = {}): AnnotationInput {
  return { quote, ...extra };
}

describe("Annotation store vocabulary (uploader/annotation-store.ts)", () => {
  it("names hex colors by hue so a filter can say 'yellow'", () => {
    expect(normalizeColor("#ffff00")).toBe("yellow");
    expect(normalizeColor("#FFC000")).toBe("orange");
    expect(normalizeColor("#ff0000")).toBe("red");
    expect(normalizeColor("#00ff00")).toBe("green");
    expect(normalizeColor("#0000ff")).toBe("blue");
    expect(normalizeColor("#800080")).toBe("purple");
    expect(normalizeColor("#ffc0cb")).toBe("pink");
    expect(normalizeColor("#00ffff")).toBe("cyan");
    expect(normalizeColor("#808080")).toBe("grey");
  });

  it("accepts a KOReader drawer string as a color", () => {
    // KOReader stores the paint style and the color in one drawer token.
    expect(normalizeColor("lighten#ffff00")).toBe("yellow");
    expect(normalizeColor("underscore#ff0000")).toBe("red");
  });

  it("passes through a color already named in words and folds aliases", () => {
    expect(normalizeColor("Yellow")).toBe("yellow");
    expect(normalizeColor("gray")).toBe("grey");
    expect(normalizeColor("magenta")).toBe("pink");
    expect(normalizeColor("")).toBeNull();
    expect(normalizeColor(null)).toBeNull();
    expect(normalizeColor(undefined)).toBeNull();
    // Every named bucket the module can produce is in the documented set.
    for (const name of ANNOTATION_COLORS) {
      expect(normalizeColor(name)).toBe(name);
    }
  });

  it("folds KOReader drawers and Kindle kinds into style tokens", () => {
    expect(normalizeStyle("lighten")).toBe("highlight");
    expect(normalizeStyle("lighten#ffff00")).toBe("highlight");
    expect(normalizeStyle("underscore")).toBe("underline");
    expect(normalizeStyle("strikeout")).toBe("strikethrough");
    expect(normalizeStyle("invert")).toBe("invert");
    expect(normalizeStyle("Note")).toBe("note");
    expect(normalizeStyle("Highlight")).toBe("highlight");
    expect(normalizeStyle("")).toBeNull();
  });

  it("round-trips the source set and treats an unattributed row as legacy", () => {
    expect(parseSources("koreader,kindle")).toEqual(["koreader", "kindle"]);
    expect(parseSources("koreader, koreader ,kindle")).toEqual(["koreader", "kindle"]);
    expect(parseSources("")).toEqual([]);
    expect(parseSources(null)).toEqual([]);
    expect(formatSources(["kindle", "koreader", "kindle"])).toBe("kindle,koreader");
    expect(effectiveSources(null)).toEqual([LEGACY_SOURCE]);
    expect(effectiveSources("")).toEqual([LEGACY_SOURCE]);
    expect(effectiveSources("web")).toEqual(["web"]);
  });

  it("rejects an unknown source so a typo cannot create a phantom owner", () => {
    expect(resolveSource("KOREADER")).toBe("koreader");
    expect(resolveSource("web")).toBe("web");
    expect(resolveSource("koreder")).toBeNull();
    expect(resolveSource("")).toBeNull();
  });

  it("normalizes quote identity and page numbers", () => {
    expect(normalizeQuoteKey("> A quote\n> continues")).toBe(
      normalizeQuoteKey("“A quote continues”"),
    );
    expect(normalizeQuoteKey("  ")).toBe("");
    expect(normalizePage("42")).toBe(42);
    expect(normalizePage(42.9)).toBe(42);
    expect(normalizePage("")).toBeNull();
    expect(normalizePage("abc")).toBeNull();
  });
});

describe("Annotation store reconciliation and filtering (uploader/annotation-store.ts)", () => {
  let tempDir: string;
  let cacheDbPath: string;
  let calibreDbPath: string;
  let db: Database;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "annotation-store-test-"));
    cacheDbPath = path.join(tempDir, "cache.db");
    calibreDbPath = path.join(tempDir, "metadata.db");
    process.env.CACHE_DB_PATH = cacheDbPath;
    process.env.CALIBRE_DB_PATH = calibreDbPath;
    makeCalibreDb(calibreDbPath);
    db = new Database(cacheDbPath);
    ensureAnnotationSchema(db);
  });

  afterEach(() => {
    db.close();
    delete process.env.CACHE_DB_PATH;
    delete process.env.CALIBRE_DB_PATH;
    if (fs.existsSync(tempDir)) fs.rmSync(tempDir, { recursive: true, force: true });
  });

  it("keeps every source that reported a highlight on one row", () => {
    upsertAnnotation({ db, ...DUNE, source: "koreader", quote: "Fear is the mind-killer." });
    upsertAnnotation({ db, ...DUNE, source: "kindle", quote: "Fear is the mind-killer." });

    const rows = queryAnnotations(db, { bookId: 1, title: "Dune" });
    expect(rows).toHaveLength(1);
    expect(rows[0].sources).toEqual(["koreader", "kindle"]);
  });

  it("persists color and style and filters on them", () => {
    upsertAnnotation({
      db,
      ...DUNE,
      source: "koreader",
      quote: "A beginning is the time for taking the most delicate care.",
      color: "lighten#ffc000",
      style: "lighten",
    });
    upsertAnnotation({
      db,
      ...DUNE,
      source: "koreader",
      quote: "There is no escape — we pay for the violence of our ancestors.",
      color: "#0000ff",
      style: "underscore",
    });

    expect(queryAnnotations(db, { bookId: 1, title: "Dune", color: "orange" })).toHaveLength(1);
    expect(queryAnnotations(db, { bookId: 1, title: "Dune", color: "blue" })).toHaveLength(1);
    expect(
      queryAnnotations(db, { bookId: 1, title: "Dune", style: "underline" }),
    ).toHaveLength(1);
    expect(
      queryAnnotations(db, { bookId: 1, title: "Dune", style: "highlight" }),
    ).toHaveLength(1);
    expect(queryAnnotations(db, { bookId: 1, title: "Dune", color: "yellow" })).toHaveLength(0);
  });

  it("filters by source, text query, and book scope", () => {
    upsertAnnotation({ db, ...DUNE, source: "koreader", quote: "First koreader quote" });
    upsertAnnotation({ db, ...DUNE, source: "kindle", quote: "Second kindle quote" });
    upsertAnnotation({
      db,
      bookId: 2,
      bookTitle: "Neuromancer",
      source: "web",
      quote: "The sky above the port was the color of television",
    });

    expect(queryAnnotations(db, { source: "koreader" }).map((r) => r.quote)).toEqual([
      "First koreader quote",
    ]);
    expect(queryAnnotations(db, { source: "kindle" }).map((r) => r.quote)).toEqual([
      "Second kindle quote",
    ]);
    expect(queryAnnotations(db, { query: "sky above" }).map((r) => r.book_title)).toEqual([
      "Neuromancer",
    ]);
    expect(queryAnnotations(db, { bookId: 2, title: "Neuromancer" })).toHaveLength(1);
    expect(queryAnnotations(db, { source: "obsidian" })).toHaveLength(0);
  });

  it("summarizes counts per color, style, and source", () => {
    upsertAnnotation({ db, ...DUNE, source: "koreader", quote: "q1", color: "yellow", style: "highlight" });
    upsertAnnotation({ db, ...DUNE, source: "kindle", quote: "q2", color: "yellow", style: "note" });
    upsertAnnotation({ db, ...DUNE, source: "kindle", quote: "q3" });

    const summary = annotationSummary(db);
    expect(summary.total).toBe(3);
    expect(summary.byColor.yellow).toBe(2);
    expect(summary.byStyle.highlight).toBe(1);
    expect(summary.byStyle.note).toBe(1);
    expect(summary.bySource.kindle).toBe(2);
    expect(summary.bySource.koreader).toBe(1);
  });

  it("deletes one annotation by id", () => {
    upsertAnnotation({ db, ...DUNE, source: "web", quote: "Doomed quote" });
    const [row] = queryAnnotations(db, { bookId: 1, title: "Dune" });
    expect(deleteAnnotation(db, row.id)).toBe(true);
    expect(queryAnnotations(db, { bookId: 1, title: "Dune" })).toHaveLength(0);
    expect(deleteAnnotation(db, row.id)).toBe(false);
    expect(deleteAnnotation(db, 0)).toBe(false);
  });

  it("adapts store rows to the note-entry shape exporters render", () => {
    upsertAnnotation({
      db,
      ...DUNE,
      source: "koreader",
      quote: "Adapted quote",
      note: "my reflection",
      chapter: "Chapter 1",
      page: 12,
      color: "yellow",
      style: "highlight",
    });
    const entries = annotationsToNoteEntries(queryAnnotations(db, { bookId: 1, title: "Dune" }));
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({
      text: "Adapted quote",
      notes: "my reflection",
      chapter: "Chapter 1",
      page: 12,
      color: "yellow",
      style: "highlight",
      sources: ["koreader"],
    });
  });
});

describe("Deletion propagation through the annotation store", () => {
  let tempDir: string;
  let cacheDbPath: string;
  let calibreDbPath: string;
  let db: Database;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "annotation-delete-test-"));
    cacheDbPath = path.join(tempDir, "cache.db");
    calibreDbPath = path.join(tempDir, "metadata.db");
    process.env.CACHE_DB_PATH = cacheDbPath;
    process.env.CALIBRE_DB_PATH = calibreDbPath;
    makeCalibreDb(calibreDbPath);
    db = new Database(cacheDbPath);
    ensureAnnotationSchema(db);
  });

  afterEach(() => {
    db.close();
    delete process.env.CACHE_DB_PATH;
    delete process.env.CALIBRE_DB_PATH;
    if (fs.existsSync(tempDir)) fs.rmSync(tempDir, { recursive: true, force: true });
  });

  it("removes a highlight deleted at its source from the store", () => {
    // Snapshot 1: the device reports three highlights.
    const first = reconcileAnnotations({
      db,
      ...DUNE,
      source: "koreader",
      entries: [
        entry("First highlight", { page: 1 }),
        entry("Second highlight", { page: 2 }),
        entry("Third highlight", { page: 3 }),
      ],
    });
    expect(first.added).toBe(3);
    expect(first.removed).toBe(0);
    expect(first.total).toBe(3);
    expect(queryAnnotations(db, { bookId: 1, title: "Dune" })).toHaveLength(3);

    // Snapshot 2: the middle highlight was deleted on the device.
    const second = reconcileAnnotations({
      db,
      ...DUNE,
      source: "koreader",
      entries: [entry("First highlight", { page: 1 }), entry("Third highlight", { page: 3 })],
    });

    expect(second.removed).toBe(1);
    expect(second.removedQuotes).toEqual(["Second highlight"]);
    expect(second.total).toBe(2);

    const remaining = queryAnnotations(db, { bookId: 1, title: "Dune" }).map((r) => r.quote);
    expect(remaining).toEqual(["First highlight", "Third highlight"]);
    expect(remaining).not.toContain("Second highlight");
  });

  it("keeps a highlight another source still reports until the last owner drops it", () => {
    // Both paths report the same highlight.
    reconcileAnnotations({
      db,
      ...DUNE,
      source: "koreader",
      entries: [entry("Shared quote"), entry("Koreader only")],
    });
    reconcileAnnotations({
      db,
      ...DUNE,
      source: "kindle",
      entries: [entry("Shared quote")],
    });
    expect(
      queryAnnotations(db, { bookId: 1, title: "Dune" }).find((r) => r.quote === "Shared quote")
        ?.sources,
    ).toEqual(["koreader", "kindle"]);

    // The Kindle deleted it, but KOReader still reports it, so it is not gone
    // yet: one device dropping a quote is not the source going away.
    const kindle = reconcileAnnotations({ db, ...DUNE, source: "kindle", entries: [] });
    expect(kindle.removed).toBe(0);
    expect(kindle.removedQuotes).toEqual([]);
    expect(
      queryAnnotations(db, { bookId: 1, title: "Dune" }).find((r) => r.quote === "Shared quote")
        ?.sources,
    ).toEqual(["koreader"]);

    // Now the last owner drops it, so it leaves the store.
    const koreader = reconcileAnnotations({
      db,
      ...DUNE,
      source: "koreader",
      entries: [entry("Koreader only")],
    });
    expect(koreader.removed).toBe(1);
    expect(koreader.removedQuotes).toEqual(["Shared quote"]);

    const rows = queryAnnotations(db, { bookId: 1, title: "Dune" });
    expect(rows.map((r) => r.quote)).toEqual(["Koreader only"]);
  });

  it("leaves another source's highlights alone during a partial snapshot", () => {
    reconcileAnnotations({ db, ...DUNE, source: "koreader", entries: [entry("Koreader quote")] });
    reconcileAnnotations({ db, ...DUNE, source: "kindle", entries: [entry("Kindle quote")] });

    // A Kindle run that reports nothing must not touch the KOReader row.
    const kindle = reconcileAnnotations({ db, ...DUNE, source: "kindle", entries: [] });
    expect(kindle.removed).toBe(1);
    expect(kindle.removedQuotes).toEqual(["Kindle quote"]);

    const rows = queryAnnotations(db, { bookId: 1, title: "Dune" });
    expect(rows.map((r) => r.quote)).toEqual(["Koreader quote"]);
    expect(rows[0].sources).toEqual(["koreader"]);
  });

  it("treats a re-typed quote variant as the same highlight, not a new one", () => {
    reconcileAnnotations({ db, ...DUNE, source: "koreader", entries: [entry("A   spaced quote")] });

    const second = reconcileAnnotations({
      db,
      ...DUNE,
      source: "koreader",
      entries: [entry("“A spaced quote”")],
    });

    expect(second.removed).toBe(0);
    expect(second.added).toBe(0);
    expect(queryAnnotations(db, { bookId: 1, title: "Dune" })).toHaveLength(1);
  });

  it("retires unattributed legacy rows only when the caller opts in", () => {
    // A row written before source tracking existed.
    batchUpsertHighlights(db, [
      {
        book_id: 1,
        book_title: "Dune",
        chapter: null,
        page: null,
        quote: "Orphan from the one-way era",
        note: null,
        timestamp: null,
      },
    ]);
    const rowsBefore = db
      .query("SELECT quote, sources FROM book_highlights WHERE book_id = 1;")
      .all() as Array<{ quote: string; sources: string }>;
    expect(rowsBefore[0].sources).toBe("legacy");

    // Without opt-in, a snapshot leaves the unattributed row in place.
    const cautious = reconcileAnnotations({
      db,
      ...DUNE,
      source: "koreader",
      entries: [entry("Live highlight")],
    });
    expect(cautious.removed).toBe(0);
    expect(queryAnnotations(db, { bookId: 1, title: "Dune" })).toHaveLength(2);

    // Opted in, the row the snapshot no longer reports is retired.
    const adopted = reconcileAnnotations({
      db,
      ...DUNE,
      source: "koreader",
      entries: [entry("Live highlight")],
      adoptLegacy: true,
    });
    expect(adopted.removed).toBe(1);
    expect(adopted.removedQuotes).toEqual(["Orphan from the one-way era"]);
    expect(queryAnnotations(db, { bookId: 1, title: "Dune" }).map((r) => r.quote)).toEqual([
      "Live highlight",
    ]);
  });

  it("drops the legacy marker once a real source claims the row, so a later deletion sticks", () => {
    batchUpsertHighlights(db, [
      {
        book_id: 1,
        book_title: "Dune",
        chapter: null,
        page: null,
        quote: "Previously unattributed",
        note: null,
        timestamp: null,
      },
    ]);

    // A source now reports it: the row gains a real owner.
    reconcileAnnotations({
      db,
      ...DUNE,
      source: "koreader",
      entries: [entry("Previously unattributed")],
    });
    expect(queryAnnotations(db, { bookId: 1, title: "Dune" })[0].sources).toEqual(["koreader"]);

    // Deleting it at the source now removes it, with no lingering legacy claim.
    const removed = reconcileAnnotations({ db, ...DUNE, source: "koreader", entries: [] });
    expect(removed.removed).toBe(1);
    expect(queryAnnotations(db, { bookId: 1, title: "Dune" })).toHaveLength(0);
  });

  it("prunes legacy-only rows deliberately", () => {
    batchUpsertHighlights(db, [
      {
        book_id: 1,
        book_title: "Dune",
        chapter: null,
        page: null,
        quote: "Stale orphan one",
        note: null,
        timestamp: null,
      },
      {
        book_id: 1,
        book_title: "Dune",
        chapter: null,
        page: null,
        quote: "Stale orphan two",
        note: null,
        timestamp: null,
      },
    ]);
    upsertAnnotation({ db, ...DUNE, source: "koreader", quote: "Owned quote" });

    expect(pruneLegacyAnnotations(db)).toBe(2);
    expect(queryAnnotations(db, { bookId: 1, title: "Dune" }).map((r) => r.quote)).toEqual([
      "Owned quote",
    ]);
    // Idempotent: nothing left to prune.
    expect(pruneLegacyAnnotations(db)).toBe(0);
  });

  it("migrates an existing database that predates source tracking", () => {
    const legacyPath = path.join(tempDir, "legacy-cache.db");
    const legacyDb = new Database(legacyPath);
    // The shipped pre-upgrade schema, exactly.
    legacyDb.run(`
      CREATE TABLE book_highlights (
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
    legacyDb.run(
      "INSERT INTO book_highlights (book_id, book_title, quote) VALUES (1, 'Dune', 'Pre-upgrade quote');",
    );

    initHighlightsTable(legacyDb, true);
    ensureAnnotationSchema(legacyDb);

    const columns = (
      legacyDb.query("PRAGMA table_info(book_highlights);").all() as Array<{ name: string }>
    ).map((c) => c.name);
    expect(columns).toContain("color");
    expect(columns).toContain("style");
    expect(columns).toContain("sources");

    const [row] = queryAnnotations(legacyDb, { bookId: 1, title: "Dune" });
    expect(row.quote).toBe("Pre-upgrade quote");
    expect(row.sources).toEqual([LEGACY_SOURCE]);
    legacyDb.close();
  });

  it("rejects a snapshot without a book title instead of writing rows nobody owns", () => {
    expect(() =>
      reconcileAnnotations({ db, bookId: 1, bookTitle: "   ", source: "koreader", entries: [] }),
    ).toThrow(/book title/i);
  });

  it("ignores empty quotes and dedupes a repeated quote inside one snapshot", () => {
    const result = reconcileAnnotations({
      db,
      ...DUNE,
      source: "koreader",
      entries: [
        entry(""),
        entry("   "),
        entry("Real quote"),
        entry("Real quote", { note: "enriched later" }),
      ],
    });
    expect(result.added).toBe(1);
    const rows = queryAnnotations(db, { bookId: 1, title: "Dune" });
    expect(rows).toHaveLength(1);
    expect(rows[0].note).toBe("enriched later");
  });
});
