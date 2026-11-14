/**
 * Deletion propagation evidence for the unified annotation store.
 *
 * The claim under test: a highlight deleted at its source leaves the store, and
 * therefore leaves every exporter - the Obsidian-synced note, Markdown, CSV, and
 * JSON - because those exporters read the store instead of the last snapshot
 * anyone happened to write.
 *
 * These tests drive the real public entry points (`syncObsidian`,
 * `processJoplinNote`, and the HTTP routes) against a real SQLite cache.db and a
 * real vault directory on disk, and assert on bytes read back from disk.
 */

import { describe, expect, it, beforeEach, afterEach } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Database } from "bun:sqlite";

import { handleRequest } from "./server";
import { processJoplinNote } from "./joplin";
import { queryAnnotations } from "./annotation-store";
import {
  exportAnnotations,
  renderCsvExport,
  renderJsonExport,
  renderMarkdownExport,
} from "./annotation-export";
import { syncObsidian } from "../scripts/sync-obsidian";
import { getHighlightsCacheDb, batchUpsertHighlights, initHighlightsTable } from "./highlights";

const API_KEY = "deletion-propagation-test-key";

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
  cDb.close();
}

function noteText(notePath: string): string {
  return fs.readFileSync(notePath, "utf8");
}

describe("Deletion propagation: source -> store -> exports -> Obsidian note", () => {
  let tempDir: string;
  let cacheDbPath: string;
  let calibreDbPath: string;
  let vaultPath: string;
  let booksDir: string;
  let db: Database;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "deletion-propagation-"));
    cacheDbPath = path.join(tempDir, "cache.db");
    calibreDbPath = path.join(tempDir, "metadata.db");
    vaultPath = path.join(tempDir, "Vault");
    booksDir = path.join(vaultPath, "Books");
    fs.mkdirSync(booksDir, { recursive: true });

    process.env.CACHE_DB_PATH = cacheDbPath;
    process.env.JOBS_DB_PATH = cacheDbPath;
    process.env.CALIBRE_DB_PATH = calibreDbPath;
    process.env.OBSIDIAN_BOOKS_DIR = booksDir;
    process.env.OBSIDIAN_VAULT_PATH = vaultPath;
    process.env.READING_API_KEY = API_KEY;

    makeCalibreDb(calibreDbPath);
    db = new Database(cacheDbPath);
    initHighlightsTable(db);
  });

  afterEach(() => {
    db.close();
    delete process.env.CACHE_DB_PATH;
    delete process.env.JOBS_DB_PATH;
    delete process.env.CALIBRE_DB_PATH;
    delete process.env.OBSIDIAN_BOOKS_DIR;
    delete process.env.OBSIDIAN_VAULT_PATH;
    delete process.env.READING_API_KEY;
    if (fs.existsSync(tempDir)) fs.rmSync(tempDir, { recursive: true, force: true });
  });

  it("removes a highlight deleted at its source from store, note, and all three exports", async () => {
    const book = {
      title: "Dune",
      author: "Frank Herbert",
      bookId: 1,
      progress: 40,
      source: "koreader" as const,
    };

    // --- Before: three highlights reported by KOReader ------------------------
    const first = await syncObsidian({
      vaultPath,
      apply: true,
      books: [
        {
          ...book,
          highlights: [
            { text: "Fear is the mind-killer.", page: 12, chapter: "Ch1", color: "yellow", style: "highlight" },
            { text: "A beginning is a very delicate time.", page: 3, chapter: "Ch1" },
            { text: "The spice must flow.", page: 88, chapter: "Ch3" },
          ],
        },
      ],
    });
    expect(first.notesCreated + first.notesUpdated).toBe(1);

    const noteFilename = first.items[0].filename;
    const notePath = path.join(booksDir, noteFilename);
    expect(fs.existsSync(notePath)).toBe(true);

    const beforeNote = noteText(notePath);
    expect(beforeNote).toContain("Fear is the mind-killer.");
    expect(beforeNote).toContain("A beginning is a very delicate time.");
    expect(beforeNote).toContain("The spice must flow.");
    // The note still carries its idempotent markers and frontmatter.
    expect(beforeNote).toContain("<!-- lighthouse:highlights:start -->");
    expect(beforeNote).toContain("<!-- lighthouse:highlights:end -->");
    expect(beforeNote).toContain("## Highlights & Notes");

    const storeDb = getHighlightsCacheDb();
    expect(queryAnnotations(storeDb, { bookId: 1, title: "Dune" })).toHaveLength(3);

    const beforeMarkdown = exportAnnotations(storeDb, {
      format: "markdown",
      filter: { bookId: 1, title: "Dune" },
    });
    const beforeCsv = exportAnnotations(storeDb, {
      format: "csv",
      filter: { bookId: 1, title: "Dune" },
    });
    const beforeJson = exportAnnotations(storeDb, {
      format: "json",
      filter: { bookId: 1, title: "Dune" },
    });
    expect(beforeMarkdown.count).toBe(3);
    expect(beforeCsv.count).toBe(3);
    expect(beforeJson.count).toBe(3);
    for (const out of [beforeMarkdown, beforeCsv, beforeJson]) {
      expect(out.content).toContain("A beginning is a very delicate time.");
    }

    // --- The person deletes the middle highlight on the device ----------------
    // KOReader's export is the document's full list, so the deleted quote is
    // simply absent from the next snapshot.
    const second = await syncObsidian({
      vaultPath,
      apply: true,
      books: [
        {
          ...book,
          highlights: [
            { text: "Fear is the mind-killer.", page: 12, chapter: "Ch1", color: "yellow", style: "highlight" },
            { text: "The spice must flow.", page: 88, chapter: "Ch3" },
          ],
        },
      ],
    });
    expect(second.notesUpdated).toBe(1);

    // 1. Gone from the store.
    const afterStore = queryAnnotations(storeDb, { bookId: 1, title: "Dune" });
    expect(afterStore.map((r) => r.quote)).toEqual([
      "Fear is the mind-killer.",
      "The spice must flow.",
    ]);
    expect(afterStore.some((r) => r.quote.includes("delicate time"))).toBe(false);

    // 2. Gone from the Obsidian-synced note on disk.
    const afterNote = noteText(notePath);
    expect(afterNote).not.toContain("A beginning is a very delicate time.");
    expect(afterNote).toContain("Fear is the mind-killer.");
    expect(afterNote).toContain("The spice must flow.");
    // Markers and frontmatter still intact for notes already on disk.
    expect(afterNote).toContain("<!-- lighthouse:highlights:start -->");
    expect(afterNote).toContain("<!-- lighthouse:highlights:end -->");
    expect(afterNote).toMatch(/^---\ntitle: /);

    // 3. Gone from all three exports.
    for (const format of ["markdown", "csv", "json"] as const) {
      const out = exportAnnotations(storeDb, {
        format,
        filter: { bookId: 1, title: "Dune" },
      });
      expect(out.count).toBe(2);
      expect(out.content).not.toContain("A beginning is a very delicate time.");
      expect(out.content).toContain("Fear is the mind-killer.");
    }
  });

  it("ingests clipper exports into the store and retires them on a device sync that drops them", async () => {
    const firstBody = [
      "# Dune",
      "",
      "##### Frank Herbert",
      "",
      "> Fear is the mind-killer.",
      "",
      "— *Ch1*, Page 12",
      "",
      "> The spice must flow.",
      "",
      "— *Ch3*, Page 88",
      "",
    ].join("\n");

    const first = await processJoplinNote(
      { title: "Dune", body: firstBody },
      { booksDir, cacheDbPath, calibreDbPath },
    );
    expect(first.highlightCount).toBe(2);

    const notePath = first.path;
    expect(noteText(notePath)).toContain("The spice must flow.");

    // The clipper's quotes land in the same store as every other source.
    const storeDb = getHighlightsCacheDb(cacheDbPath);
    const ingested = queryAnnotations(storeDb, { bookId: 1, title: "Dune" });
    expect(ingested).toHaveLength(2);
    expect(ingested.every((r) => r.sources.includes("koreader"))).toBe(true);

    // The clipper keeps an additive note (its payloads are per-export pushes, so
    // an omitted quote is not observable as a deletion there). Deleting at the
    // source is observed by the device sync, which reads the document's complete
    // state, and that retires the clipper-ingested row everywhere.
    await syncObsidian({
      vaultPath,
      apply: true,
      books: [
        {
          title: "Dune",
          author: "Frank Herbert",
          bookId: 1,
          source: "koreader",
          adoptLegacy: true,
          highlights: [{ text: "Fear is the mind-killer.", page: 12, chapter: "Ch1" }],
        },
      ],
    });

    const afterStore = queryAnnotations(storeDb, { bookId: 1, title: "Dune" });
    expect(afterStore.map((r) => r.quote)).toEqual(["Fear is the mind-killer."]);

    const afterNote = noteText(notePath);
    expect(afterNote).not.toContain("The spice must flow.");
    expect(afterNote).toContain("Fear is the mind-killer.");

    for (const format of ["markdown", "csv", "json"] as const) {
      const out = exportAnnotations(storeDb, {
        format,
        filter: { bookId: 1, title: "Dune" },
      });
      expect(out.content).not.toContain("The spice must flow.");
    }
  });

  it("serves the deletion through the HTTP export route too", async () => {
    const storeDb = getHighlightsCacheDb();
    const post = async (quote: string) => {
      const res = await handleRequest(
        new Request("http://127.0.0.1:8086/api/annotations", {
          method: "POST",
          headers: {
            "content-type": "application/json",
            authorization: `Bearer ${API_KEY}`,
          },
          body: JSON.stringify({ title: "Dune", quote, source: "web" }),
        }),
      );
      expect(res.status).toBe(201);
    };

    await post("Doomed quote");
    await post("Surviving quote");

    const listRes = await handleRequest(
      new Request("http://127.0.0.1:8086/api/annotations?title=Dune", {
        headers: { authorization: `Bearer ${API_KEY}` },
      }),
    );
    const list = (await listRes.json()) as any;
    expect(list.count).toBe(2);

    const doomed = list.annotations.find((a: any) => a.quote === "Doomed quote");

    const delRes = await handleRequest(
      new Request(`http://127.0.0.1:8086/api/annotations/${doomed.id}`, {
        method: "DELETE",
        headers: { authorization: `Bearer ${API_KEY}` },
      }),
    );
    expect(delRes.status).toBe(200);
    expect(((await delRes.json()) as any).success).toBe(true);

    // Store is down to one row.
    expect(queryAnnotations(storeDb, { title: "Dune" })).toHaveLength(1);

    for (const format of ["markdown", "csv", "json"] as const) {
      const exportRes = await handleRequest(
        new Request(
          `http://127.0.0.1:8086/api/highlights/export?format=${format}&title=Dune`,
          { headers: { authorization: `Bearer ${API_KEY}` } },
        ),
      );
      expect(exportRes.status).toBe(200);
      const text = await exportRes.text();
      expect(text).not.toContain("Doomed quote");
      expect(text).toContain("Surviving quote");
      expect(exportRes.headers.get("x-annotation-count")).toBe("1");
    }
  });

  it("does not let a note-only copy resurrect a highlight its device deleted", async () => {
    // A note already on disk still holds a quote from before the deletion.
    const notePath = path.join(booksDir, "Dune.md");
    fs.writeFileSync(
      notePath,
      [
        "---",
        'title: "Dune"',
        'author: "Frank Herbert"',
        "---",
        "",
        "# Dune",
        "",
        "## Highlights & Notes",
        "<!-- lighthouse:highlights:start -->",
        "> A stale quote the device no longer reports.",
        "",
        "— Page 5",
        "<!-- lighthouse:highlights:end -->",
        "",
      ].join("\n"),
      "utf8",
    );
    expect(noteText(notePath)).toContain("A stale quote the device no longer reports.");

    // Simulate the pre-upgrade store: the note's quotes were indexed before
    // source tracking existed, so they are unattributed (`legacy`) rows.
    batchUpsertHighlights(getHighlightsCacheDb(), [
      {
        book_id: 1,
        book_title: "Dune",
        chapter: null,
        page: 5,
        quote: "A stale quote the device no longer reports.",
        note: null,
        timestamp: null,
      },
    ]);

    // The device reports a different, current highlight. The stale one is absent
    // from the snapshot, so it is retired rather than re-adopted from the note.
    // `adoptLegacy` is what a full-device sync opts into: it covers every source
    // for the book, so pre-upgrade unattributed rows it no longer reports are
    // safe to retire.
    await syncObsidian({
      vaultPath,
      apply: true,
      books: [
        {
          title: "Dune",
          author: "Frank Herbert",
          bookId: 1,
          source: "koreader",
          adoptLegacy: true,
          highlights: [{ text: "A current quote.", page: 9 }],
        },
      ],
    });

    const afterNote = noteText(notePath);
    expect(afterNote).not.toContain("A stale quote the device no longer reports.");
    expect(afterNote).toContain("A current quote.");

    const storeDb = getHighlightsCacheDb();
    expect(
      queryAnnotations(storeDb, { bookId: 1, title: "Dune" }).map((r) => r.quote),
    ).toEqual(["A current quote."]);
  });

  it("keeps a highlight another source still reports until the last source drops it", async () => {
    const storeDb = getHighlightsCacheDb();

    await syncObsidian({
      vaultPath,
      apply: true,
      books: [
        {
          title: "Dune",
          author: "Frank Herbert",
          bookId: 1,
          highlightsBySource: {
            koreader: [{ text: "Shared quote" }, { text: "Koreader only" }],
            kindle: [{ text: "Shared quote" }],
          },
        },
      ],
    });

    const shared = queryAnnotations(storeDb, { bookId: 1, title: "Dune" }).find(
      (r) => r.quote === "Shared quote",
    );
    expect(shared?.sources).toEqual(["koreader", "kindle"]);

    // Kindle drops it; KOReader still reports it, so it stays.
    await syncObsidian({
      vaultPath,
      apply: true,
      books: [
        {
          title: "Dune",
          author: "Frank Herbert",
          bookId: 1,
          highlightsBySource: {
            koreader: [{ text: "Shared quote" }, { text: "Koreader only" }],
            kindle: [],
          },
        },
      ],
    });
    expect(
      queryAnnotations(storeDb, { bookId: 1, title: "Dune" }).find(
        (r) => r.quote === "Shared quote",
      )?.sources,
    ).toEqual(["koreader"]);

    // Now KOReader drops it too, so it leaves the store and the note.
    await syncObsidian({
      vaultPath,
      apply: true,
      books: [
        {
          title: "Dune",
          author: "Frank Herbert",
          bookId: 1,
          highlightsBySource: {
            koreader: [{ text: "Koreader only" }],
            kindle: [],
          },
        },
      ],
    });

    expect(
      queryAnnotations(storeDb, { bookId: 1, title: "Dune" }).map((r) => r.quote),
    ).toEqual(["Koreader only"]);
    const afterNote = noteText(path.join(booksDir, "Dune.md"));
    expect(afterNote).not.toContain("Shared quote");
    expect(afterNote).toContain("Koreader only");
  });

  it("renders an empty managed region when every highlight is deleted", async () => {
    await syncObsidian({
      vaultPath,
      apply: true,
      books: [
        {
          title: "Dune",
          author: "Frank Herbert",
          bookId: 1,
          source: "koreader",
          highlights: [{ text: "Only quote.", page: 1 }],
        },
      ],
    });
    const notePath = path.join(booksDir, "Dune.md");
    expect(noteText(notePath)).toContain("Only quote.");

    await syncObsidian({
      vaultPath,
      apply: true,
      books: [
        {
          title: "Dune",
          author: "Frank Herbert",
          bookId: 1,
          source: "koreader",
          highlights: [],
        },
      ],
    });

    const afterNote = noteText(notePath);
    expect(afterNote).not.toContain("Only quote.");
    expect(afterNote).toContain("*No highlights recorded yet.*");
    expect(queryAnnotations(getHighlightsCacheDb(), { bookId: 1, title: "Dune" })).toHaveLength(0);
  });
});

describe("Export redaction (uploader/annotation-export.ts)", () => {
  it("never emits a configured token in any format", async () => {
    process.env.JOPLIN_TOKEN = "sup3rSecretJoplinToken";
    const record = {
      id: 1,
      book_id: 1,
      book_title: "Dune",
      chapter: null,
      page: 1,
      quote: "A quote pasted with a token in it",
      note: "see http://example.test/notes?token=sup3rSecretJoplinToken and api_key=abc123",
      timestamp: null,
      created_at: null,
      color: null,
      style: null,
      sources: ["web" as const],
    };

    for (const rendered of [
      renderMarkdownExport([record]),
      renderCsvExport([record]),
      renderJsonExport([record]),
    ]) {
      expect(rendered).not.toContain("sup3rSecretJoplinToken");
      expect(rendered).not.toContain("abc123");
      expect(rendered).toContain("[redacted]");
    }

    delete process.env.JOPLIN_TOKEN;
  });
});
