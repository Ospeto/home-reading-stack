import { describe, expect, it, beforeEach, afterEach } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Database } from "bun:sqlite";
import {
  initHighlightsTable,
  insertOrUpdateHighlight,
  batchUpsertHighlights,
  getHighlightsForBook,
  getHighlightsByTitle,
  getHighlightCounts,
  getLatestQuotePreview,
  parseHighlightsFromMarkdown,
  cleanQuoteText,
  parseRawHighlightEntry,
  splitNoteIntoHighlightBlocks,
  backfillHighlightsFromObsidian,
  ensureBookHighlightsIndexed,
  resolveBookIdFromTitle,
  deleteHighlightsForBook,
  authorsMatch,
} from "./highlights";
import { handleRequest } from "./server";
import { processJoplinNote } from "./joplin";

describe("LightHouse Highlights Database, Indexing & Web API (uploader/highlights.ts)", () => {
  let tempDir: string;
  let cacheDbPath: string;
  let calibreDbPath: string;
  let booksDir: string;
  let testDb: Database;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "highlights-test-"));
    cacheDbPath = path.join(tempDir, "test-cache.db");
    calibreDbPath = path.join(tempDir, "metadata.db");
    booksDir = path.join(tempDir, "Books");
    fs.mkdirSync(booksDir, { recursive: true });

    process.env.CACHE_DB_PATH = cacheDbPath;
    process.env.JOBS_DB_PATH = cacheDbPath;
    process.env.CALIBRE_DB_PATH = calibreDbPath;
    process.env.OBSIDIAN_BOOKS_DIR = booksDir;

    // Create mock Calibre metadata.db
    const cDb = new Database(calibreDbPath);
    cDb.run(`
      CREATE TABLE books (id INTEGER PRIMARY KEY, title TEXT, path TEXT, has_cover INTEGER, pubdate TEXT, series_index REAL);
      CREATE TABLE data (id INTEGER PRIMARY KEY, book INTEGER, format TEXT, name TEXT, uncompressed_size INTEGER);
      CREATE TABLE authors (id INTEGER PRIMARY KEY, name TEXT);
      CREATE TABLE books_authors_link (id INTEGER PRIMARY KEY, book INTEGER, author INTEGER);
      CREATE TABLE series (id INTEGER PRIMARY KEY, name TEXT);
      CREATE TABLE books_series_link (id INTEGER PRIMARY KEY, book INTEGER, series INTEGER);
      CREATE TABLE tags (id INTEGER PRIMARY KEY, name TEXT);
      CREATE TABLE books_tags_link (id INTEGER PRIMARY KEY, book INTEGER, tag INTEGER);
      CREATE TABLE publishers (id INTEGER PRIMARY KEY, name TEXT);
      CREATE TABLE books_publishers_link (id INTEGER PRIMARY KEY, book INTEGER, publisher INTEGER);
      CREATE TABLE books_languages_link (id INTEGER PRIMARY KEY, book INTEGER, lang_code INTEGER);
      CREATE TABLE languages (id INTEGER PRIMARY KEY, lang_code TEXT);
      CREATE TABLE comments (id INTEGER PRIMARY KEY, book INTEGER, text TEXT);
    `);
    cDb.run("INSERT INTO books (id, title, path, has_cover) VALUES (1, 'Dune', 'Frank Herbert/Dune (1)', 1);");
    cDb.run("INSERT INTO data (id, book, format, name) VALUES (1, 1, 'EPUB', 'Dune');");
    cDb.run("INSERT INTO authors (id, name) VALUES (1, 'Frank Herbert');");
    cDb.run("INSERT INTO books_authors_link (id, book, author) VALUES (1, 1, 1);");

    cDb.run("INSERT INTO books (id, title, path, has_cover) VALUES (2, 'Neuromancer', 'William Gibson/Neuromancer (2)', 0);");
    cDb.run("INSERT INTO data (id, book, format, name) VALUES (2, 2, 'EPUB', 'Neuromancer');");
    cDb.run("INSERT INTO authors (id, name) VALUES (2, 'William Gibson');");
    cDb.run("INSERT INTO books_authors_link (id, book, author) VALUES (2, 2, 2);");
    cDb.close();

    testDb = new Database(cacheDbPath);
    initHighlightsTable(testDb);
  });

  afterEach(() => {
    testDb.close();
    delete process.env.CACHE_DB_PATH;
    delete process.env.JOBS_DB_PATH;
    delete process.env.CALIBRE_DB_PATH;
    delete process.env.OBSIDIAN_BOOKS_DIR;
    if (fs.existsSync(tempDir)) {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  describe("Database Schema & Indexes", () => {
    it("creates book_highlights table and required indexes", () => {
      const tableInfo = testDb.query("PRAGMA table_info(book_highlights);").all() as any[];
      const cols = tableInfo.map((c) => c.name);
      expect(cols).toContain("id");
      expect(cols).toContain("book_id");
      expect(cols).toContain("book_title");
      expect(cols).toContain("chapter");
      expect(cols).toContain("page");
      expect(cols).toContain("quote");
      expect(cols).toContain("note");
      expect(cols).toContain("timestamp");
      expect(cols).toContain("created_at");

      const indexList = testDb.query("PRAGMA index_list(book_highlights);").all() as any[];
      const idxNames = indexList.map((i) => i.name);
      expect(idxNames).toContain("idx_book_highlights_book_id");
      expect(idxNames).toContain("idx_book_highlights_title");
    });

    it("enforces UNIQUE(book_title, quote) ON CONFLICT REPLACE deduplication", () => {
      insertOrUpdateHighlight(testDb, {
        book_id: 1,
        book_title: "Dune",
        chapter: "Chapter 1",
        page: 10,
        quote: "Fear is the mind-killer.",
        note: "Initial note",
        timestamp: "2026-09-24",
      });

      let rows = testDb.query("SELECT * FROM book_highlights WHERE book_title = 'Dune';").all() as any[];
      expect(rows.length).toBe(1);
      expect(rows[0].note).toBe("Initial note");
      expect(rows[0].page).toBe(10);

      // Re-insert identical quote with updated note & page
      insertOrUpdateHighlight(testDb, {
        book_id: 1,
        book_title: "Dune",
        chapter: "Chapter 1",
        page: 12,
        quote: "Fear is the mind-killer.",
        note: "Updated reflection",
        timestamp: "2026-09-24 12:00:00",
      });

      rows = testDb.query("SELECT * FROM book_highlights WHERE book_title = 'Dune';").all() as any[];
      expect(rows.length).toBe(1); // Deduplicated!
      expect(rows[0].note).toBe("Updated reflection");
      expect(rows[0].page).toBe(12);
    });

    it("allows different books to have the same quote", () => {
      insertOrUpdateHighlight(testDb, {
        book_id: 1,
        book_title: "Book A",
        chapter: null,
        page: 1,
        quote: "Universal truth.",
        note: null,
        timestamp: null,
      });

      insertOrUpdateHighlight(testDb, {
        book_id: 2,
        book_title: "Book B",
        chapter: null,
        page: 2,
        quote: "Universal truth.",
        note: null,
        timestamp: null,
      });

      const rows = testDb.query("SELECT * FROM book_highlights WHERE quote = 'Universal truth.';").all() as any[];
      expect(rows.length).toBe(2);
    });
  });

  describe("Markdown Parsing & Text Extraction", () => {
    it("cleanQuoteText strips markdown quote marks, == delimiters, and extra whitespace", () => {
      expect(cleanQuoteText("==Important line==")).toBe("Important line");
      expect(cleanQuoteText("> Blockquoted line\n> second line")).toBe("Blockquoted line\nsecond line");
      expect(cleanQuoteText('"Quoted string"')).toBe("Quoted string");
      expect(cleanQuoteText("“Curly quoted string”")).toBe("Curly quoted string");
    });

    it("parseRawHighlightEntry parses KOReader Joplin format with ### Page and --- note separator", () => {
      const block = `### Page 42 @ 2026-09-24 15:30:00
==The mystery of life isn't a problem to solve, but a reality to experience.==
---
Personal reflection on living in the present.`;

      const parsed = parseRawHighlightEntry(block, "Arrakis");
      expect(parsed).not.toBeNull();
      expect(parsed!.page).toBe(42);
      expect(parsed!.timestamp).toBe("2026-09-24 15:30:00");
      expect(parsed!.chapter).toBe("Arrakis");
      expect(parsed!.quote).toBe("The mystery of life isn't a problem to solve, but a reality to experience.");
      expect(parsed!.note).toBe("Personal reflection on living in the present.");
    });

    it("parseRawHighlightEntry parses Obsidian sync-obsidian format with > quote and — metadata", () => {
      const block = `> The sky above the port was the color of television, tuned to a dead channel.
— *Chiba City Blues*, Page 1, 2026-09-20
**Note:** Iconic cyberpunk opening sentence.`;

      const parsed = parseRawHighlightEntry(block);
      expect(parsed).not.toBeNull();
      expect(parsed!.quote).toBe("The sky above the port was the color of television, tuned to a dead channel.");
      expect(parsed!.chapter).toBe("Chiba City Blues");
      expect(parsed!.page).toBe(1);
      expect(parsed!.timestamp).toBe("2026-09-20");
      expect(parsed!.note).toBe("Iconic cyberpunk opening sentence.");
    });

    it("parseHighlightsFromMarkdown extracts multiple highlights bounded by section markers", () => {
      const noteMarkdown = `---
title: "Dune"
author: "Frank Herbert"
---

# Dune

## Highlights & Notes
<!-- lighthouse:highlights:start -->
## Part One: Dune

### Page 5 @ 2026-09-20
==A beginning is the time for taking the most delicate care that the balances are correct.==
---
Princess Irulan epigraph

### Page 22 @ 2026-09-21
==Deep in the human unconscious is a pervasive need for a logical universe that makes sense.==
<!-- lighthouse:highlights:end -->

## Personal Notes Outside Markers
These should not be treated as highlights.`;

      const highlights = parseHighlightsFromMarkdown(noteMarkdown, "Dune", 1);
      expect(highlights.length).toBe(2);

      expect(highlights[0].page).toBe(5);
      expect(highlights[0].chapter).toBe("Part One: Dune");
      expect(highlights[0].quote).toContain("A beginning is the time");
      expect(highlights[0].note).toBe("Princess Irulan epigraph");

      expect(highlights[1].page).toBe(22);
      expect(highlights[1].quote).toContain("Deep in the human unconscious");
    });
  });

  describe("Query Helpers & Aggregations", () => {
    beforeEach(() => {
      batchUpsertHighlights(testDb, [
        {
          book_id: 1,
          book_title: "Dune",
          chapter: "Part 1",
          page: 10,
          quote: "Quote 1",
          note: "Note 1",
          timestamp: "2026-09-24",
        },
        {
          book_id: 1,
          book_title: "Dune",
          chapter: "Part 2",
          page: 50,
          quote: "Quote 2",
          note: null,
          timestamp: "2026-09-24",
        },
        {
          book_id: null,
          book_title: "Dune", // Unlinked initially
          chapter: "Part 3",
          page: 90,
          quote: "Quote 3",
          note: null,
          timestamp: "2026-09-24",
        },
        {
          book_id: 2,
          book_title: "Neuromancer",
          chapter: "Chiba",
          page: 5,
          quote: "Cyber quote",
          note: "Sprawl note",
          timestamp: "2026-09-23",
        },
      ]);
    });

    it("getHighlightsForBook retrieves highlights and auto-links unlinked title matches", () => {
      const duneHighlights = getHighlightsForBook(testDb, 1, "Dune");
      expect(duneHighlights.length).toBe(3);
      expect(duneHighlights[0].page).toBe(10);
      expect(duneHighlights[1].page).toBe(50);
      expect(duneHighlights[2].page).toBe(90);

      // Verify Quote 3 was auto-linked to book_id = 1
      const q3 = testDb.query("SELECT book_id FROM book_highlights WHERE quote = 'Quote 3';").get() as any;
      expect(q3.book_id).toBe(1);
    });

    it("getHighlightsByTitle retrieves highlights by book title", () => {
      const results = getHighlightsByTitle(testDb, "Neuromancer");
      expect(results.length).toBe(1);
      expect(results[0].quote).toBe("Cyber quote");
    });

    it("getHighlightCounts aggregates counts by book_id and lowercase title", () => {
      const counts = getHighlightCounts(testDb);
      expect(counts.byBookId[1]).toBe(2); // Initially 2 linked to ID 1 before auto-link
      expect(counts.byBookId[2]).toBe(1);
      expect(counts.byTitle["dune"]).toBe(3);
      expect(counts.byTitle["neuromancer"]).toBe(1);
    });

    it("getLatestQuotePreview returns the newest quote snippet", () => {
      const preview = getLatestQuotePreview(testDb, 1, "Dune");
      expect(preview).not.toBeNull();
      expect(preview!.quote).toBe("Quote 3");
    });
  });

  describe("On-Demand Backfill & Obsidian Vault Sync", () => {
    it("resolveBookIdFromTitle resolves ID against Calibre metadata.db", () => {
      const duneId = resolveBookIdFromTitle("Dune", calibreDbPath);
      expect(duneId).toBe(1);

      const neuroId = resolveBookIdFromTitle("Neuromancer", calibreDbPath);
      expect(neuroId).toBe(2);

      const unknownId = resolveBookIdFromTitle("Nonexistent Book", calibreDbPath);
      expect(unknownId).toBeNull();
    });

    it("backfillHighlightsFromObsidian scans Books/*.md and populates SQLite", async () => {
      const notePath = path.join(booksDir, "Neuromancer.md");
      fs.writeFileSync(
        notePath,
        `---
title: "Neuromancer"
author: "William Gibson"
---
## Highlights & Notes
<!-- lighthouse:highlights:start -->
### Page 15 @ 2026-09-24
==Night City was not like Tokyo.==
---
Setting the scene
<!-- lighthouse:highlights:end -->
`,
      );

      const res = await backfillHighlightsFromObsidian({
        booksDir,
        calibreDbPath,
        db: testDb,
      });

      expect(res.totalFiles).toBe(1);
      expect(res.totalHighlights).toBe(1);
      expect(res.booksProcessed).toContain("Neuromancer");

      const hl = getHighlightsForBook(testDb, 2, "Neuromancer");
      expect(hl.length).toBe(1);
      expect(hl[0].quote).toBe("Night City was not like Tokyo.");
      expect(hl[0].note).toBe("Setting the scene");
      expect(hl[0].page).toBe(15);
    });

    it("ensureBookHighlightsIndexed indexes on demand if DB has 0 highlights", () => {
      const notePath = path.join(booksDir, "Dune.md");
      fs.writeFileSync(
        notePath,
        `---
title: "Dune"
---
## Highlights & Notes
<!-- lighthouse:highlights:start -->
### Page 100 @ 2026-09-24
==He who can destroy a thing, can control a thing.==
<!-- lighthouse:highlights:end -->
`,
      );

      // Verify DB is initially empty for Dune
      expect(getHighlightsForBook(testDb, 1, "Dune").length).toBe(0);

      // Call ensureBookHighlightsIndexed
      const highlights = ensureBookHighlightsIndexed(testDb, 1, "Dune", {
        booksDir,
        calibreDbPath,
      });

      expect(highlights.length).toBe(1);
      expect(highlights[0].quote).toContain("He who can destroy a thing");
      expect(highlights[0].page).toBe(100);
    });
  });

  describe("API Endpoints & Server Integration (uploader/server.ts)", () => {
    it("GET /api/books/:id/highlights returns 200 with structured highlights", async () => {
      insertOrUpdateHighlight(testDb, {
        book_id: 1,
        book_title: "Dune",
        chapter: "Part One",
        page: 42,
        quote: "Fear is the mind-killer.",
        note: "Litany against fear",
        timestamp: "2026-09-24",
      });

      const req = new Request("http://127.0.0.1:8086/api/books/1/highlights", {
        method: "GET",
      });
      const res = await handleRequest(req);
      expect(res.status).toBe(200);

      const data = (await res.json()) as any;
      expect(data.success).toBe(true);
      expect(data.book_id).toBe(1);
      expect(data.title).toBe("Dune");
      expect(data.count).toBe(1);
      expect(Array.isArray(data.highlights)).toBe(true);
      expect(data.highlights[0].quote).toBe("Fear is the mind-killer.");
      expect(data.highlights[0].page).toBe(42);
      expect(data.highlights[0].note).toBe("Litany against fear");
    });

    it("GET /api/books/:id/highlights returns 400 for invalid book ID", async () => {
      const req = new Request("http://127.0.0.1:8086/api/books/invalid/highlights", {
        method: "GET",
      });
      const res = await handleRequest(req);
      expect(res.status).toBe(400);
      const data = (await res.json()) as any;
      expect(data.success).toBe(false);
      expect(data.error).toContain("Invalid book ID");
    });

    it("GET /api/highlights?title=... returns highlights by book title", async () => {
      insertOrUpdateHighlight(testDb, {
        book_id: 1,
        book_title: "Dune",
        chapter: "Part Two",
        page: 85,
        quote: "The spice must flow.",
        note: null,
        timestamp: "2026-09-24",
      });

      const req = new Request("http://127.0.0.1:8086/api/highlights?title=Dune", {
        method: "GET",
      });
      const res = await handleRequest(req);
      expect(res.status).toBe(200);

      const data = (await res.json()) as any;
      expect(data.success).toBe(true);
      expect(data.count).toBe(1);
      expect(data.title).toBe("Dune");
      expect(data.highlights[0].quote).toBe("The spice must flow.");
    });

    it("GET /api/highlights without parameters returns library-wide counts", async () => {
      insertOrUpdateHighlight(testDb, {
        book_id: 1,
        book_title: "Dune",
        chapter: null,
        page: 1,
        quote: "Quote Dune",
        note: null,
        timestamp: null,
      });

      const req = new Request("http://127.0.0.1:8086/api/highlights", {
        method: "GET",
      });
      const res = await handleRequest(req);
      expect(res.status).toBe(200);

      const data = (await res.json()) as any;
      expect(data.success).toBe(true);
      expect(data.counts).toBeDefined();
      expect(data.counts.byBookId[1]).toBe(1);
      expect(data.counts.byTitle["dune"]).toBe(1);
    });

    it("GET /api/books attaches highlightCount to each book", async () => {
      insertOrUpdateHighlight(testDb, {
        book_id: 1,
        book_title: "Dune",
        chapter: null,
        page: 1,
        quote: "Quote Dune",
        note: null,
        timestamp: null,
      });

      const req = new Request("http://127.0.0.1:8086/api/books", {
        method: "GET",
      });
      const res = await handleRequest(req);
      expect(res.status).toBe(200);

      const books = (await res.json()) as any[];
      expect(Array.isArray(books)).toBe(true);
      const dune = books.find((b) => b.id === 1);
      expect(dune).toBeDefined();
      expect(dune.highlightCount).toBe(1);
      expect(dune.highlightPreview).toBe("Quote Dune");

      const neuro = books.find((b) => b.id === 2);
      expect(neuro).toBeDefined();
      expect(neuro.highlightCount).toBe(0);
      expect(neuro.highlightPreview).toBeNull();
    });

    it("end-to-end Joplin sync indexes highlights and makes them accessible via /api/books/:id/highlights", async () => {
      const payload = {
        title: "Dune",
        body: `### Page 55 @ 2026-09-24 16:00:00
==Without change something sleeps inside us, and seldom awakens. The sleeper must awaken.==
---
Gurney Halleck quote`,
      };

      await processJoplinNote(payload, {
        booksDir,
        calibreDbPath,
        cacheDb: testDb,
      });

      // Query through the API endpoint
      const req = new Request("http://127.0.0.1:8086/api/books/1/highlights", {
        method: "GET",
      });
      const res = await handleRequest(req);
      expect(res.status).toBe(200);

      const data = (await res.json()) as any;
      expect(data.success).toBe(true);
      expect(data.count).toBe(1);
      expect(data.highlights[0].quote).toContain("The sleeper must awaken");
      expect(data.highlights[0].note).toBe("Gurney Halleck quote");
      expect(data.highlights[0].page).toBe(55);
    });

    it("GET /api/books/:id/highlights?refresh=1 dynamically re-indexes updated Obsidian notes", async () => {
      const notePath = path.join(booksDir, "Dune.md");
      fs.writeFileSync(
        notePath,
        `---
title: "Dune"
---
## Highlights & Notes
<!-- lighthouse:highlights:start -->
### Page 10 @ 2026-09-24
==First quote in book.==
<!-- lighthouse:highlights:end -->
`,
      );

      // Initial fetch indexes 1 highlight
      let req = new Request("http://127.0.0.1:8086/api/books/1/highlights", { method: "GET" });
      let res = await handleRequest(req);
      expect(res.status).toBe(200);
      let data = (await res.json()) as any;
      expect(data.count).toBe(1);

      // Now update the Obsidian note on disk with 2 highlights
      fs.writeFileSync(
        notePath,
        `---
title: "Dune"
---
## Highlights & Notes
<!-- lighthouse:highlights:start -->
### Page 10 @ 2026-09-24
==First quote in book.==

### Page 20 @ 2026-09-24
==Second newly added quote.==
<!-- lighthouse:highlights:end -->
`,
      );

      // Query with refresh=1
      req = new Request("http://127.0.0.1:8086/api/books/1/highlights?refresh=1", { method: "GET" });
      res = await handleRequest(req);
      expect(res.status).toBe(200);
      data = (await res.json()) as any;
      expect(data.count).toBe(2);
      expect(data.highlights.some((h: any) => h.quote.includes("Second newly added quote"))).toBe(true);
    });

    it("DELETE /api/books/:id cleans up book highlights from database", async () => {
      insertOrUpdateHighlight(testDb, {
        book_id: 1,
        book_title: "Dune",
        chapter: null,
        page: 1,
        quote: "Quote to be deleted",
        note: null,
        timestamp: null,
      });

      insertOrUpdateHighlight(testDb, {
        book_id: null,
        book_title: "Dune",
        chapter: null,
        page: 2,
        quote: "Unlinked Quote to be deleted",
        note: null,
        timestamp: null,
      });

      expect(getHighlightsForBook(testDb, 1, "Dune").length).toBe(2);

      deleteHighlightsForBook(testDb, 1, "Dune");
      expect(getHighlightsForBook(testDb, 1, "Dune").length).toBe(0);
      expect(getHighlightsByTitle(testDb, "Dune").length).toBe(0);
    });
  });

  describe("Web UI Highlights Integration (uploader/index.html)", () => {
    it("index.html defines Book Detail modal tabs, overview pane, and highlights pane with refresh button", () => {
      const htmlPath = path.resolve((import.meta as any).dir || process.cwd(), "index.html");
      const html = fs.readFileSync(htmlPath, "utf8");

      expect(html).toContain('id="tabBtnDetails"');
      expect(html).toContain('id="tabBtnHighlights"');
      expect(html).toContain('id="detailHighlightsBadge"');
      expect(html).toContain('id="detailOverviewPane"');
      expect(html).toContain('id="detailHighlightsPane"');
      expect(html).toContain('id="detailHighlightsList"');
      expect(html).toContain('id="detailHighlightsSubCount"');
      expect(html).toContain("loadBookHighlights(currentDetailBookId, true)");
      expect(html).toContain("highlights?refresh=1");
    });

    it("index.html defines Apple Fluid translucent quote card styling and accessibility rules", () => {
      const htmlPath = path.resolve((import.meta as any).dir || process.cwd(), "index.html");
      const html = fs.readFileSync(htmlPath, "utf8");

      expect(html).toContain(".highlight-quote-card");
      expect(html).toContain(".quote-accent-bar");
      expect(html).toContain("prefers-reduced-transparency");
      expect(html).toContain("prefers-reduced-motion");
    });

    it("index.html implements highlights viewer functions and card counter indicators", () => {
      const htmlPath = path.resolve((import.meta as any).dir || process.cwd(), "index.html");
      const html = fs.readFileSync(htmlPath, "utf8");

      expect(html).toContain("function switchDetailTab");
      expect(html).toContain("async function loadBookHighlights");
      expect(html).toContain("function renderHighlightsView");
      expect(html).toContain("async function copyQuoteText");
      expect(html).toContain("highlightCoverBadge");
      expect(html).toContain("popupHighlightBadge");
      expect(html).toContain("popupHighlightPreview");
    });

    it("index.html connection guide modal documents Web Highlights & Quotes Viewer", () => {
      const htmlPath = path.resolve((import.meta as any).dir || process.cwd(), "index.html");
      const html = fs.readFileSync(htmlPath, "utf8");

      expect(html).toContain("Web Highlights &amp; Quotes Viewer");
      expect(html).toContain("/api/books/:id/highlights");
    });

    it("index.html avoids inline quote strings in onclick attributes to prevent attribute breakage", () => {
      const htmlPath = path.resolve((import.meta as any).dir || process.cwd(), "index.html");
      const html = fs.readFileSync(htmlPath, "utf8");

      // Verify copy button does not embed unescaped/raw quote in onclick
      expect(html).not.toContain("copyQuoteText(this, ${JSON.stringify");
      expect(html).toContain("copyQuoteById(this");
    });

    it("ensureBookHighlightsIndexed rejects directory traversal in book title", () => {
      // Create a secret file outside the booksDir
      const secretFile = path.join(tempDir, "secret.md");
      fs.writeFileSync(secretFile, `## Highlights & Notes\n<!-- lighthouse:highlights:start -->\n> Leaked secret\n<!-- lighthouse:highlights:end -->`);

      // Attempt traversal
      const evilTitle = "../secret";
      const results = ensureBookHighlightsIndexed(testDb, 999, evilTitle, { booksDir });
      expect(results.length).toBe(0);

      // Verify no leak was indexed into DB
      const leaked = getHighlightsForBook(testDb, 999, evilTitle);
      expect(leaked.length).toBe(0);
    });

    it("updating a highlight with null note correctly clears the old note", () => {
      insertOrUpdateHighlight(testDb, {
        book_id: 1,
        book_title: "Dune",
        chapter: "Part 1",
        page: 10,
        quote: "Unique Quote",
        note: "Initial annotation",
        timestamp: "2026-09-24",
      });

      let hl = getHighlightsForBook(testDb, 1, "Dune");
      expect(hl.find((h) => h.quote === "Unique Quote")?.note).toBe("Initial annotation");

      // Update with note: null
      insertOrUpdateHighlight(testDb, {
        book_id: 1,
        book_title: "Dune",
        chapter: "Part 1",
        page: 10,
        quote: "Unique Quote",
        note: null,
        timestamp: "2026-09-24",
      });

      hl = getHighlightsForBook(testDb, 1, "Dune");
      expect(hl.find((h) => h.quote === "Unique Quote")?.note).toBeNull();
    });
  });

  describe("Regression: Defect 1 & 2 (Shared Title Isolation & Punctuation Resolution Past 1000 IDs)", () => {
    it("opening Homer's book does not show Fry's quotes and deleting Homer's book deletes by book_id", () => {
      insertOrUpdateHighlight(testDb, {
        book_id: 10,
        book_title: "The Odyssey",
        quote: "Homer quote: Sing in me, Muse",
      });
      insertOrUpdateHighlight(testDb, {
        book_id: 20,
        book_title: "The Odyssey",
        quote: "Stephen Fry quote: Troy was taken",
      });

      // Opening Homer's book (id 10) must NOT show Fry's quotes
      const homerQuotes = getHighlightsForBook(testDb, 10, "The Odyssey");
      expect(homerQuotes.map((q) => q.quote)).toEqual(["Homer quote: Sing in me, Muse"]);

      // Opening Fry's book (id 20) must NOT show Homer's quotes
      const fryQuotes = getHighlightsForBook(testDb, 20, "The Odyssey");
      expect(fryQuotes.map((q) => q.quote)).toEqual(["Stephen Fry quote: Troy was taken"]);

      // Deleting Homer's book highlights must delete ONLY Homer's highlights
      deleteHighlightsForBook(testDb, 10, "The Odyssey");
      const homerAfter = getHighlightsForBook(testDb, 10, "The Odyssey");
      const fryAfter = getHighlightsForBook(testDb, 20, "The Odyssey");
      expect(homerAfter.length).toBe(0);
      expect(fryAfter.map((q) => q.quote)).toEqual(["Stephen Fry quote: Troy was taken"]);
    });

    it("resolveBookIdFromTitle resolves book past id 1000 differing only by punctuation and fullwidth characters", () => {
      const tmpDbPath = `/tmp/calibre-punct-1001-${Date.now()}.db`;
      const cDb = new Database(tmpDbPath);
      cDb.run("CREATE TABLE books (id INTEGER PRIMARY KEY, title TEXT);");
      const insert = cDb.prepare("INSERT INTO books (id, title) VALUES (?, ?);");
      cDb.transaction(() => {
        for (let i = 1; i <= 1000; i++) {
          insert.run(i, `Book ${i}`);
        }
        insert.run(1001, "Punctuated：Title！");
        insert.run(1002, "Title（Subtitle）");
      })();
      cDb.close();

      try {
        const resolved1 = resolveBookIdFromTitle("Punctuated Title", tmpDbPath);
        expect(resolved1).toBe(1001);
        const resolved2 = resolveBookIdFromTitle("Title Subtitle", tmpDbPath);
        expect(resolved2).toBe(1002);
      } finally {
        if (fs.existsSync(tmpDbPath)) fs.unlinkSync(tmpDbPath);
      }
    });

    it("resolveBookIdFromTitle preserves unique title resolution even when author is missing or unmatched", () => {
      const tmpDbPath = `/tmp/calibre-unique-author-${Date.now()}.db`;
      const cDb = new Database(tmpDbPath);
      cDb.run("CREATE TABLE books (id INTEGER PRIMARY KEY, title TEXT);");
      cDb.run("CREATE TABLE authors (id INTEGER PRIMARY KEY, name TEXT);");
      cDb.run("CREATE TABLE books_authors_link (id INTEGER PRIMARY KEY, book INTEGER, author INTEGER);");

      // Unique title book with no author linked
      cDb.run("INSERT INTO books (id, title) VALUES (42, 'Unique Title Book');");
      cDb.close();

      try {
        // Author provided but not matching/unlinked: unique title must still resolve to 42!
        expect(resolveBookIdFromTitle("Unique Title Book", tmpDbPath, "Some Random Author")).toBe(42);
        // No author passed: unique title must resolve to 42
        expect(resolveBookIdFromTitle("Unique Title Book", tmpDbPath)).toBe(42);
      } finally {
        if (fs.existsSync(tmpDbPath)) fs.unlinkSync(tmpDbPath);
      }
    });

    it("resolveBookIdFromTitle handles Last, First author order and returns null on unmatched author for shared title", () => {
      const tmpDbPath = `/tmp/calibre-authors-match-${Date.now()}.db`;
      const cDb = new Database(tmpDbPath);
      cDb.run("CREATE TABLE books (id INTEGER PRIMARY KEY, title TEXT);");
      cDb.run("CREATE TABLE authors (id INTEGER PRIMARY KEY, name TEXT);");
      cDb.run("CREATE TABLE books_authors_link (id INTEGER PRIMARY KEY, book INTEGER, author INTEGER);");

      cDb.run("INSERT INTO books (id, title) VALUES (1, 'The Odyssey');");
      cDb.run("INSERT INTO authors (id, name) VALUES (1, 'Homer');");
      cDb.run("INSERT INTO books_authors_link (id, book, author) VALUES (1, 1, 1);");

      cDb.run("INSERT INTO books (id, title) VALUES (2, 'The Odyssey');");
      cDb.run("INSERT INTO authors (id, name) VALUES (2, 'Stephen Fry');");
      cDb.run("INSERT INTO books_authors_link (id, book, author) VALUES (2, 2, 2);");
      cDb.close();

      try {
        // "Fry, Stephen" matches "Stephen Fry" (id 2)
        expect(resolveBookIdFromTitle("The Odyssey", tmpDbPath, "Fry, Stephen")).toBe(2);
        // "Homer" matches Homer (id 1)
        expect(resolveBookIdFromTitle("The Odyssey", tmpDbPath, "Homer")).toBe(1);
        // Unmatched author on shared title returns null (does not falsely fall back to Homer!)
        expect(resolveBookIdFromTitle("The Odyssey", tmpDbPath, "Completely Wrong Author")).toBeNull();
        // Missing or Unknown author on shared title returns null (does not pick the lowest id!)
        expect(resolveBookIdFromTitle("The Odyssey", tmpDbPath)).toBeNull();
        expect(resolveBookIdFromTitle("The Odyssey", tmpDbPath, "Unknown")).toBeNull();
      } finally {
        if (fs.existsSync(tmpDbPath)) fs.unlinkSync(tmpDbPath);
      }
    });

    it("authorsMatch prevents false positive substring matches while matching valid variants", () => {
      // Valid variants match
      expect(authorsMatch("Stephen Fry", "Fry, Stephen")).toBe(true);
      expect(authorsMatch("Homer", "Homer, Translator")).toBe(true);
      expect(authorsMatch("Neil Gaiman & Terry Pratchett", "Terry Pratchett")).toBe(true);

      // Substrings must NOT match
      expect(authorsMatch("Ann", "Joanne")).toBe(false);
      expect(authorsMatch("Homer", "Homeric")).toBe(false);
      expect(authorsMatch("Bob", "Bobby")).toBe(false);
      expect(authorsMatch("Stephen King", "Stephen Fry")).toBe(false);
    });

    it("allows two books sharing a title to hold the exact same quote without conflict", () => {
      // Homer's book (id 1) quotes "Sing in me, Muse"
      insertOrUpdateHighlight(testDb, {
        book_id: 1,
        book_title: "The Odyssey - Homer",
        quote: "Sing in me, Muse",
        page: 1,
      });

      // Fry's book (id 2) quotes the exact same text "Sing in me, Muse"
      insertOrUpdateHighlight(testDb, {
        book_id: 2,
        book_title: "The Odyssey - Stephen Fry",
        quote: "Sing in me, Muse",
        page: 5,
      });

      const homerQuotes = getHighlightsForBook(testDb, 1, "The Odyssey");
      const fryQuotes = getHighlightsForBook(testDb, 2, "The Odyssey");

      expect(homerQuotes.length).toBe(1);
      expect(homerQuotes[0].quote).toBe("Sing in me, Muse");
      expect(homerQuotes[0].page).toBe(1);

      expect(fryQuotes.length).toBe(1);
      expect(fryQuotes[0].quote).toBe("Sing in me, Muse");
      expect(fryQuotes[0].page).toBe(5);
    });

    it("ensureBookHighlightsIndexed discovers author-suffixed notes and forceFresh deletes only target book", () => {
      const booksDir = path.join(os.tmpdir(), `books-author-suffix-${Date.now()}`);
      fs.mkdirSync(booksDir, { recursive: true });

      const homerNote = path.join(booksDir, "The Odyssey - Homer.md");
      fs.writeFileSync(
        homerNote,
        `---
title: "The Odyssey"
author: "Homer"
---
## Highlights & Notes
<!-- lighthouse:highlights:start -->
> Sing in me, Muse
— Page 1
<!-- lighthouse:highlights:end -->
`,
        "utf8",
      );

      // Seed Fry's highlights in DB
      insertOrUpdateHighlight(testDb, {
        book_id: 2,
        book_title: "The Odyssey - Stephen Fry",
        quote: "Fry quote: Troy had fallen",
      });

      try {
        // Opening Homer's book (id 1) should discover The Odyssey - Homer.md
        const homerHl = ensureBookHighlightsIndexed(testDb, 1, "The Odyssey", {
          booksDir,
          author: "Homer",
        });

        expect(homerHl.length).toBe(1);
        expect(homerHl[0].quote).toBe("Sing in me, Muse");

        // Fry's highlights must remain completely intact
        const fryHl = getHighlightsForBook(testDb, 2, "The Odyssey");
        expect(fryHl.length).toBe(1);
        expect(fryHl[0].quote).toBe("Fry quote: Troy had fallen");

        // forceFresh refresh on Homer's book must NOT delete Fry's highlights
        ensureBookHighlightsIndexed(testDb, 1, "The Odyssey", {
          booksDir,
          author: "Homer",
          forceFresh: true,
        });

        const fryAfter = getHighlightsForBook(testDb, 2, "The Odyssey");
        expect(fryAfter.length).toBe(1);
        expect(fryAfter[0].quote).toBe("Fry quote: Troy had fallen");
      } finally {
        fs.rmSync(booksDir, { recursive: true, force: true });
      }
    });

    it("ensureBookHighlightsIndexed never falls back to plain Title.md for shared-title book with different author", () => {
      const booksDir = path.join(os.tmpdir(), `books-no-leak-${Date.now()}`);
      fs.mkdirSync(booksDir, { recursive: true });

      // Plain The Odyssey.md belongs to Homer
      fs.writeFileSync(
        path.join(booksDir, "The Odyssey.md"),
        `---
title: "The Odyssey"
author: "Homer"
---
## Highlights & Notes
<!-- lighthouse:highlights:start -->
> Homer quote: Sing in me, Muse
— Page 1
<!-- lighthouse:highlights:end -->
`,
        "utf8",
      );

      // Suffixed note belongs to Stephen Fry
      fs.writeFileSync(
        path.join(booksDir, "The Odyssey - Stephen Fry.md"),
        `---
title: "The Odyssey"
author: "Stephen Fry"
---
## Highlights & Notes
<!-- lighthouse:highlights:start -->
> Fry quote: Troy was taken
— Page 5
<!-- lighthouse:highlights:end -->
`,
        "utf8",
      );

      // Setup Calibre DB where book 1 is Homer and book 2 is Fry, Stephen
      const customCalibreDb = path.join(os.tmpdir(), `calibre-shared-authors-${Date.now()}.db`);
      const cDb = new Database(customCalibreDb);
      cDb.run("CREATE TABLE books (id INTEGER PRIMARY KEY, title TEXT);");
      cDb.run("CREATE TABLE authors (id INTEGER PRIMARY KEY, name TEXT);");
      cDb.run("CREATE TABLE books_authors_link (id INTEGER PRIMARY KEY, book INTEGER, author INTEGER);");
      cDb.run("INSERT INTO books VALUES (1, 'The Odyssey'), (2, 'The Odyssey');");
      cDb.run("INSERT INTO authors VALUES (1, 'Homer'), (2, 'Fry, Stephen');");
      cDb.run("INSERT INTO books_authors_link VALUES (1, 1, 1), (2, 2, 2);");
      cDb.close();

      try {
        // Open Fry's book (id 2, Calibre author "Fry, Stephen")
        const fryHl = ensureBookHighlightsIndexed(testDb, 2, "The Odyssey", {
          booksDir,
          calibreDbPath: customCalibreDb,
        });

        // Must load Fry's quote and NEVER Homer's quote from plain The Odyssey.md!
        expect(fryHl.length).toBe(1);
        expect(fryHl[0].quote).toBe("Fry quote: Troy was taken");
        expect(fryHl[0].quote).not.toContain("Homer");
      } finally {
        fs.rmSync(booksDir, { recursive: true, force: true });
        if (fs.existsSync(customCalibreDb)) fs.unlinkSync(customCalibreDb);
      }
    });

    it("backfillHighlightsFromObsidian preserves identical quotes across two books sharing a title", async () => {
      const booksDir = path.join(os.tmpdir(), `books-backfill-shared-${Date.now()}`);
      fs.mkdirSync(booksDir, { recursive: true });

      fs.writeFileSync(
        path.join(booksDir, "The Odyssey - Homer.md"),
        `---
title: "The Odyssey"
author: "Homer"
---
## Highlights & Notes
<!-- lighthouse:highlights:start -->
> Shared quote: Sing in me, Muse
— Page 1
<!-- lighthouse:highlights:end -->
`,
        "utf8",
      );

      fs.writeFileSync(
        path.join(booksDir, "The Odyssey - Stephen Fry.md"),
        `---
title: "The Odyssey"
author: "Stephen Fry"
---
## Highlights & Notes
<!-- lighthouse:highlights:start -->
> Shared quote: Sing in me, Muse
— Page 5
<!-- lighthouse:highlights:end -->
`,
        "utf8",
      );

      const customCalibreDb = path.join(os.tmpdir(), `calibre-backfill-shared-${Date.now()}.db`);
      const cDb = new Database(customCalibreDb);
      cDb.run("CREATE TABLE books (id INTEGER PRIMARY KEY, title TEXT);");
      cDb.run("CREATE TABLE authors (id INTEGER PRIMARY KEY, name TEXT);");
      cDb.run("CREATE TABLE books_authors_link (id INTEGER PRIMARY KEY, book INTEGER, author INTEGER);");
      cDb.run("INSERT INTO books VALUES (1, 'The Odyssey'), (2, 'The Odyssey');");
      cDb.run("INSERT INTO authors VALUES (1, 'Homer'), (2, 'Stephen Fry');");
      cDb.run("INSERT INTO books_authors_link VALUES (1, 1, 1), (2, 2, 2);");
      cDb.close();

      const backfillDb = new Database(":memory:");
      initHighlightsTable(backfillDb);

      try {
        await backfillHighlightsFromObsidian({
          booksDir,
          calibreDbPath: customCalibreDb,
          db: backfillDb,
        });

        const homerQuotes = getHighlightsForBook(backfillDb, 1, "The Odyssey");
        const fryQuotes = getHighlightsForBook(backfillDb, 2, "The Odyssey");

        expect(homerQuotes.length).toBe(1);
        expect(homerQuotes[0].quote).toBe("Shared quote: Sing in me, Muse");

        expect(fryQuotes.length).toBe(1);
        expect(fryQuotes[0].quote).toBe("Shared quote: Sing in me, Muse");
      } finally {
        fs.rmSync(booksDir, { recursive: true, force: true });
        if (fs.existsSync(customCalibreDb)) fs.unlinkSync(customCalibreDb);
      }
    });

    it("cleanQuoteText strips diverse international and smart quote pairs cleanly", () => {
      expect(cleanQuoteText("'Single quoted text'")).toBe("Single quoted text");
      expect(cleanQuoteText("‘Smart single quoted text’")).toBe("Smart single quoted text");
      expect(cleanQuoteText("«French guillemets»")).toBe("French guillemets");
      expect(cleanQuoteText("「Japanese corner brackets」")).toBe("Japanese corner brackets");
      expect(cleanQuoteText("『White corner brackets』")).toBe("White corner brackets");
    });

    it("parses ### Location and Pos entries in parseRawHighlightEntry and splitNoteIntoHighlightBlocks", () => {
      const entry = parseRawHighlightEntry("### Location 450 @ 2026-09-24\n> Highlight text here\n");
      expect(entry).not.toBeNull();
      expect(entry?.page).toBe(450);
      expect(entry?.timestamp).toBe("2026-09-24");
      expect(entry?.quote).toBe("Highlight text here");

      const blocks = splitNoteIntoHighlightBlocks("### Page 1\n> First\n\n### Location 450\n> Second\n");
      expect(blocks.length).toBe(2);
    });

    it("preserves chapter, page, and timestamp on highlight updates via COALESCE", () => {
      const db = new Database(":memory:");
      initHighlightsTable(db);

      // Initial insert with full location metadata
      insertOrUpdateHighlight(db, {
        book_id: 1,
        book_title: "Test Book",
        chapter: "Chapter 3",
        page: 42,
        quote: "Persistent location quote",
        note: "Initial note",
        timestamp: "2026-01-01",
      });

      // Update from another source that only provides quote and updated note
      insertOrUpdateHighlight(db, {
        book_id: 1,
        book_title: "Test Book",
        chapter: null,
        page: null,
        quote: "Persistent location quote",
        note: "Updated note",
        timestamp: null,
      });

      const rows = getHighlightsForBook(db, 1);
      expect(rows.length).toBe(1);
      expect(rows[0].chapter).toBe("Chapter 3");
      expect(rows[0].page).toBe(42);
      expect(rows[0].timestamp).toBe("2026-01-01");
      expect(rows[0].note).toBe("Updated note");
    });

    it("updates created_at timestamp on batchUpsertHighlights conflict", async () => {
      const db = new Database(":memory:");
      initHighlightsTable(db);

      batchUpsertHighlights(db, [
        {
          book_id: 1,
          book_title: "Book",
          chapter: null,
          page: 1,
          quote: "Quote to update",
          note: null,
          timestamp: null,
        },
      ]);

      const initial = db.query("SELECT created_at FROM book_highlights WHERE book_id = 1;").get() as any;
      expect(initial.created_at).toBeDefined();

      // Wait a tick and update
      await new Promise((r) => setTimeout(r, 1100));

      batchUpsertHighlights(db, [
        {
          book_id: 1,
          book_title: "Book",
          chapter: null,
          page: 1,
          quote: "Quote to update",
          note: "New note",
          timestamp: null,
        },
      ]);

      const updated = db.query("SELECT created_at, note FROM book_highlights WHERE book_id = 1;").get() as any;
      expect(updated.note).toBe("New note");
      expect(updated.created_at).not.toBe(initial.created_at);
    });

    it("matches accented authors and titles across NFC and NFD Unicode representations", () => {
      const nfcAuthor = "Hélène Cixous".normalize("NFC");
      const nfdAuthor = "Hélène Cixous".normalize("NFD");
      expect(authorsMatch(nfcAuthor, nfdAuthor)).toBe(true);

      const customDb = path.join(os.tmpdir(), `calibre-accent-${Date.now()}.db`);
      const db = new Database(customDb);
      db.run("CREATE TABLE books (id INTEGER PRIMARY KEY, title TEXT);");
      db.run("CREATE TABLE authors (id INTEGER PRIMARY KEY, name TEXT);");
      db.run("CREATE TABLE books_authors_link (id INTEGER PRIMARY KEY, book INTEGER, author INTEGER);");
      db.run("INSERT INTO books VALUES (1, ?);", ["Le Café de Flore".normalize("NFC")]);
      db.run("INSERT INTO authors VALUES (1, ?);", [nfcAuthor]);
      db.run("INSERT INTO books_authors_link VALUES (1, 1, 1);");
      db.close();

      try {
        const resolvedId = resolveBookIdFromTitle("Le Café de Flore".normalize("NFD"), customDb, nfdAuthor);
        expect(resolvedId).toBe(1);
      } finally {
        if (fs.existsSync(customDb)) fs.unlinkSync(customDb);
      }
    });
  });
});
