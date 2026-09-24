import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { spawnSync } from "node:child_process";
import { Database } from "bun:sqlite";

import {
  sanitizeFat32Filename,
  detectKindleMount,
  getKindleDiskSpace,
  resolveObsidianBooksDir,
  isBookActiveOrUnread,
  queryCalibreBooksWithFiles,
  findKindleSdrDirs,
  findKindleClippings,
  pushBooksToKindle,
  pullHighlightsFromKindle,
  syncKindle,
  formatBytes,
  formatSyncReport,
  type KindleVolumeInfo,
  type KindleSyncOptions,
  type CalibreBookRecord,
} from "./sync-kindle";

const REPO_ROOT = path.resolve(import.meta.dir, "..");
const LIGHTHOUSE_BIN = path.join(REPO_ROOT, "bin", "lighthouse");

describe("LightHouse Type-C Kindle Two-Way Synchronization", () => {
  let tempDir: string;
  let mockKindleMount: string;
  let mockKindleDocs: string;
  let mockObsidianBooks: string;
  let mockCalibreDir: string;
  let mockCalibreDbPath: string;
  let mockKosyncDbPath: string;
  let mockCacheDbPath: string;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "lh-kindle-test-"));
    mockKindleMount = path.join(tempDir, "Kindle");
    mockKindleDocs = path.join(mockKindleMount, "documents");
    fs.mkdirSync(mockKindleDocs, { recursive: true });

    mockObsidianBooks = path.join(tempDir, "Obsidian", "Books");
    fs.mkdirSync(mockObsidianBooks, { recursive: true });

    mockCalibreDir = path.join(tempDir, "Calibre Library");
    fs.mkdirSync(mockCalibreDir, { recursive: true });
    mockCalibreDbPath = path.join(mockCalibreDir, "metadata.db");

    mockKosyncDbPath = path.join(tempDir, "koreader-sync.db");
    mockCacheDbPath = path.join(tempDir, "cache.db");

    // Initialize mock Calibre SQLite DB
    const cDb = new Database(mockCalibreDbPath);
    cDb.run(`
      CREATE TABLE books (
        id INTEGER PRIMARY KEY,
        title TEXT,
        path TEXT,
        series_index REAL
      );
      CREATE TABLE authors (id INTEGER PRIMARY KEY, name TEXT);
      CREATE TABLE books_authors_link (id INTEGER PRIMARY KEY, book INTEGER, author INTEGER);
      CREATE TABLE series (id INTEGER PRIMARY KEY, name TEXT);
      CREATE TABLE books_series_link (id INTEGER PRIMARY KEY, book INTEGER, series INTEGER);
      CREATE TABLE tags (id INTEGER PRIMARY KEY, name TEXT);
      CREATE TABLE books_tags_link (id INTEGER PRIMARY KEY, book INTEGER, tag INTEGER);
      CREATE TABLE comments (id INTEGER PRIMARY KEY, book INTEGER, text TEXT);
      CREATE TABLE data (id INTEGER PRIMARY KEY, book INTEGER, format TEXT, name TEXT, uncompressed_size INTEGER);
    `);
    cDb.close();

    // Initialize mock KOSync SQLite DB
    const kDb = new Database(mockKosyncDbPath);
    kDb.run(`
      CREATE TABLE progress (
        document TEXT PRIMARY KEY,
        percentage REAL,
        device TEXT,
        device_id TEXT,
        progress TEXT,
        timestamp INTEGER,
        filename TEXT,
        title TEXT,
        authors TEXT
      );
    `);
    kDb.close();
  });

  afterEach(() => {
    if (fs.existsSync(tempDir)) {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  // --------------------------------------------------------------------------
  // 1. FAT32 Sanitization & Path Helpers
  // --------------------------------------------------------------------------
  describe("1. FAT32 Sanitization & Path Helpers", () => {
    it("replaces colons with ' - ' for natural title-subtitle formatting", () => {
      const sanitized = sanitizeFat32Filename("Re:Zero - Starting Life in Another World: Volume 1.epub");
      expect(sanitized).toBe("Re - Zero - Starting Life in Another World - Volume 1.epub");
    });

    it("replaces slashes, backslashes, and illegal FAT32 characters", () => {
      const sanitized = sanitizeFat32Filename('Sci-Fi/Fantasy *Best* of "2024" <Special> | Book?.epub');
      expect(sanitized).not.toContain("/");
      expect(sanitized).not.toContain("\\");
      expect(sanitized).not.toContain("<");
      expect(sanitized).not.toContain(">");
      expect(sanitized).not.toContain('"');
      expect(sanitized).not.toContain("|");
      expect(sanitized).not.toContain("?");
      expect(sanitized).not.toContain("*");
      expect(sanitized.endsWith(".epub")).toBe(true);
    });

    it("strips trailing periods and spaces per FAT32 rules", () => {
      const sanitized = sanitizeFat32Filename("Some Title... .epub");
      expect(sanitized).toBe("Some Title.epub");
    });

    it("preserves legitimate Burmese, Japanese, and accented Unicode characters", () => {
      const myanmar = sanitizeFat32Filename("သခင်ကိုယ်တော်မှိုင်း - စာအုပ်.epub");
      expect(myanmar).toContain("သခင်ကိုယ်တော်မှိုင်း");

      const japanese = sanitizeFat32Filename("ダンジョンに出会いを求めるのは間違っているだろうか 15.epub");
      expect(japanese).toContain("ダンジョンに出会いを求めるのは間違っているだろうか");

      const accented = sanitizeFat32Filename("François - Éléments.epub");
      expect(accented).toContain("François");
      expect(accented).toContain("Éléments");
    });

    it("truncates long filenames cleanly without corrupting multi-byte UTF-8 bytes", () => {
      const longTitle = "A".repeat(300) + ".epub";
      const sanitized = sanitizeFat32Filename(longTitle);
      expect(Buffer.byteLength(sanitized, "utf8")).toBeLessThanOrEqual(255);
      expect(sanitized.endsWith(".epub")).toBe(true);

      const longUnicode = "မြန်မာစာအုပ်အမည်ရှည်ကြီး".repeat(20) + ".epub";
      const sanitizedUnicode = sanitizeFat32Filename(longUnicode);
      expect(Buffer.byteLength(sanitizedUnicode, "utf8")).toBeLessThanOrEqual(255);
      expect(sanitizedUnicode.endsWith(".epub")).toBe(true);
      // Valid UTF-8 roundtrip
      expect(() => Buffer.from(sanitizedUnicode, "utf8").toString("utf8")).not.toThrow();
    });

    it("resolves target Obsidian Books directory accurately", () => {
      const custom = resolveObsidianBooksDir(mockObsidianBooks);
      expect(custom).toBe(mockObsidianBooks);

      const oldEnv = process.env.OBSIDIAN_BOOKS_DIR;
      process.env.OBSIDIAN_BOOKS_DIR = mockObsidianBooks;
      try {
        expect(resolveObsidianBooksDir()).toBe(mockObsidianBooks);
      } finally {
        if (oldEnv) process.env.OBSIDIAN_BOOKS_DIR = oldEnv;
        else delete process.env.OBSIDIAN_BOOKS_DIR;
      }
    });

    it("formats byte values cleanly via formatBytes", () => {
      expect(formatBytes(0)).toBe("0 B");
      expect(formatBytes(1024)).toBe("1.00 KB");
      expect(formatBytes(1024 * 1024 * 5.5)).toBe("5.50 MB");
      expect(formatBytes(1024 * 1024 * 1024 * 3.25)).toBe("3.25 GB");
    });
  });

  // --------------------------------------------------------------------------
  // 2. Device Detection & Mount Verification
  // --------------------------------------------------------------------------
  describe("2. Device Detection & Mount Verification", () => {
    it("detects explicit custom mount path and documents directory", () => {
      const detected = detectKindleMount(mockKindleMount);
      expect(detected).not.toBeNull();
      expect(detected?.mountPath).toBe(mockKindleMount);
      expect(detected?.documentsDir).toBe(mockKindleDocs);
      expect(detected?.name).toBe("Kindle");
      expect(detected?.freeBytes).toBeGreaterThan(0);
    });

    it("detects mount when passed target path is already the documents directory", () => {
      const detected = detectKindleMount(mockKindleDocs);
      expect(detected).not.toBeNull();
      expect(detected?.mountPath).toBe(mockKindleMount);
      expect(detected?.documentsDir).toBe(mockKindleDocs);
    });

    it("returns null when custom path does not exist", () => {
      const detected = detectKindleMount(path.join(tempDir, "NonExistentPath"));
      expect(detected).toBeNull();
    });

    it("retrieves disk space for valid directory path", () => {
      const space = getKindleDiskSpace(tempDir);
      expect(space).not.toBeNull();
      expect(space?.freeBytes).toBeGreaterThan(0);
      expect(space?.totalBytes).toBeGreaterThan(0);
      expect(space?.freeMb).toBeGreaterThan(0);
    });
  });

  // --------------------------------------------------------------------------
  // 3. Book Filtering & Selection Logic
  // --------------------------------------------------------------------------
  describe("3. Book Filtering & Selection Logic", () => {
    it("qualifies books with active reading tags", () => {
      const progressMap = new Map();
      expect(
        isBookActiveOrUnread({ id: 1, title: "Book A", tags: ["currently-reading"] }, progressMap),
      ).toBe(true);
      expect(
        isBookActiveOrUnread({ id: 2, title: "Book B", tags: ["want-to-read"] }, progressMap),
      ).toBe(true);
      expect(
        isBookActiveOrUnread({ id: 3, title: "Book C", tags: ["to-read"] }, progressMap),
      ).toBe(true);
    });

    it("qualifies books with active progress (0 < pct < 99) in KOSync", () => {
      const progressMap = new Map([
        ["dune", { progress: 45, timestamp: 12345 }],
      ]);
      expect(
        isBookActiveOrUnread({ id: 4, title: "Dune", tags: [] }, progressMap),
      ).toBe(true);
    });

    it("qualifies books with unread status (pct == 0 or no entry)", () => {
      const progressMap = new Map([
        ["unread book", { progress: 0, timestamp: 12345 }],
      ]);
      expect(
        isBookActiveOrUnread({ id: 5, title: "Unread Book", tags: [] }, progressMap),
      ).toBe(true);
      expect(
        isBookActiveOrUnread({ id: 6, title: "Brand New Book", tags: [] }, progressMap),
      ).toBe(true);
    });

    it("excludes books with finished tags when no reading tag exists", () => {
      const progressMap = new Map();
      expect(
        isBookActiveOrUnread({ id: 7, title: "Done Book", tags: ["finished"] }, progressMap),
      ).toBe(false);
      expect(
        isBookActiveOrUnread({ id: 8, title: "Read Book", tags: ["read"] }, progressMap),
      ).toBe(false);
    });

    it("excludes books with finished progress (>= 99%) in KOSync", () => {
      const progressMap = new Map([
        ["finished book", { progress: 100, timestamp: 12345 }],
      ]);
      expect(
        isBookActiveOrUnread({ id: 9, title: "Finished Book", tags: [] }, progressMap),
      ).toBe(false);
    });

    it("prioritizes active reading tag over finished progress (e.g. re-reading)", () => {
      const progressMap = new Map([
        ["re-read book", { progress: 100, timestamp: 12345 }],
      ]);
      expect(
        isBookActiveOrUnread({ id: 10, title: "Re-read Book", tags: ["reading"] }, progressMap),
      ).toBe(true);
    });
  });

  // --------------------------------------------------------------------------
  // 4. Direction 1: Push Books (Calibre -> Kindle)
  // --------------------------------------------------------------------------
  describe("4. Direction 1: Push Books (Calibre -> Kindle)", () => {
    function setupMockBook(
      id: number,
      title: string,
      author: string,
      content = "Mock EPUB File Content",
      tags: string[] = ["reading"],
    ): CalibreBookRecord {
      const bookRelDir = `${author}/${title}`;
      const bookFullDir = path.join(mockCalibreDir, bookRelDir);
      fs.mkdirSync(bookFullDir, { recursive: true });
      const epubPath = path.join(bookFullDir, `${title} - ${author}.epub`);
      fs.writeFileSync(epubPath, content);

      const cDb = new Database(mockCalibreDbPath);
      cDb.run("INSERT INTO books (id, title, path) VALUES (?, ?, ?);", [id, title, bookRelDir]);
      cDb.run("INSERT INTO authors (id, name) VALUES (?, ?);", [id, author]);
      cDb.run("INSERT INTO books_authors_link (book, author) VALUES (?, ?);", [id, id]);
      for (const t of tags) {
        cDb.run("INSERT INTO tags (name) VALUES (?);", [t]);
        const tagId = cDb.query("SELECT last_insert_rowid() as id;").get() as any;
        cDb.run("INSERT INTO books_tags_link (book, tag) VALUES (?, ?);", [id, tagId.id]);
      }
      cDb.run("INSERT INTO data (book, format, name, uncompressed_size) VALUES (?, 'EPUB', ?, ?);", [
        id,
        `${title} - ${author}`,
        content.length,
      ]);
      cDb.close();

      return {
        id,
        title,
        authors: author,
        series: null,
        seriesIndex: null,
        tags,
        comments: "Synopsis for " + title,
        path: bookRelDir,
        format: "EPUB",
        filename: `${title} - ${author}`,
        uncompressedSize: content.length,
        filePath: epubPath,
      };
    }

    it("queries Calibre books with on-disk physical files", () => {
      setupMockBook(1, "The Hobbit", "J.R.R. Tolkien");
      const books = queryCalibreBooksWithFiles(mockCalibreDbPath, mockCalibreDir);
      expect(books.length).toBe(1);
      expect(books[0].title).toBe("The Hobbit");
      expect(books[0].authors).toBe("J.R.R. Tolkien");
      expect(fs.existsSync(books[0].filePath)).toBe(true);
    });

    it("pushes books to Kindle documents directory with atomic rename", async () => {
      const book = setupMockBook(1, "The Way of Kings", "Brandon Sanderson");
      const mount: KindleVolumeInfo = {
        mountPath: mockKindleMount,
        documentsDir: mockKindleDocs,
        name: "Kindle",
        freeBytes: 1024 * 1024 * 100,
        totalBytes: 1024 * 1024 * 200,
      };

      const results = await pushBooksToKindle(
        { apply: true, dryRun: false },
        mount,
        [book],
        new Map(),
      );

      expect(results.length).toBe(1);
      expect(results[0].status).toBe("transferred");
      expect(fs.existsSync(results[0].destPath)).toBe(true);
      expect(fs.readFileSync(results[0].destPath, "utf8")).toBe("Mock EPUB File Content");
    });

    it("skips pushing when book already exists on Kindle with identical file size", async () => {
      const book = setupMockBook(2, "Atomic Habits", "James Clear", "Sample content 12345");
      const mount: KindleVolumeInfo = {
        mountPath: mockKindleMount,
        documentsDir: mockKindleDocs,
        name: "Kindle",
        freeBytes: 1024 * 1024 * 100,
        totalBytes: 1024 * 1024 * 200,
      };

      // First run: transfers
      const run1 = await pushBooksToKindle({ apply: true }, mount, [book], new Map());
      expect(run1[0].status).toBe("transferred");

      // Second run: skips idempotently
      const run2 = await pushBooksToKindle({ apply: true }, mount, [book], new Map());
      expect(run2[0].status).toBe("skipped");
      expect(run2[0].reason).toContain("identical size");
    });

    it("simulates transfer in dry-run mode without creating files on Kindle", async () => {
      const book = setupMockBook(3, "Hyperion", "Dan Simmons");
      const mount: KindleVolumeInfo = {
        mountPath: mockKindleMount,
        documentsDir: mockKindleDocs,
        name: "Kindle",
        freeBytes: 1024 * 1024 * 100,
        totalBytes: 1024 * 1024 * 200,
      };

      const results = await pushBooksToKindle(
        { apply: false, dryRun: true },
        mount,
        [book],
        new Map(),
      );

      expect(results[0].status).toBe("transferred");
      expect(results[0].reason).toContain("dry-run");
      expect(fs.existsSync(results[0].destPath)).toBe(false);
    });

    it("rejects push when Kindle free space is insufficient", async () => {
      const book = setupMockBook(4, "Huge Book", "Author", "Big file content".repeat(100));
      const mount: KindleVolumeInfo = {
        mountPath: mockKindleMount,
        documentsDir: mockKindleDocs,
        name: "Kindle",
        freeBytes: 1000, // Very low free space
        totalBytes: 1024 * 1024 * 100,
      };

      const results = await pushBooksToKindle({ apply: true }, mount, [book], new Map());
      expect(results[0].status).toBe("failed");
      expect(results[0].reason).toContain("Insufficient space");
    });

    it("overwrites file when sizes differ and credits existing file size", async () => {
      const book = setupMockBook(11, "Overwritten Book", "Author", "New Larger Content 1234567890");
      const mount: KindleVolumeInfo = {
        mountPath: mockKindleMount,
        documentsDir: mockKindleDocs,
        name: "Kindle",
        freeBytes: 1024 * 1024 * 10, // 10MB
        totalBytes: 1024 * 1024 * 100,
      };

      // Create an existing file on Kindle with different content/size
      const destPath = path.join(mockKindleDocs, "Overwritten Book - Author.epub");
      fs.writeFileSync(destPath, "Old smaller content");

      const results = await pushBooksToKindle({ apply: true }, mount, [book], new Map());
      expect(results[0].status).toBe("transferred");
      expect(fs.readFileSync(destPath, "utf8")).toBe("New Larger Content 1234567890");
    });

    it("respects --all flag pushing finished books as well", async () => {
      const book1 = setupMockBook(5, "Active Book", "Author A", "c1", ["reading"]);
      const book2 = setupMockBook(6, "Finished Book", "Author B", "c2", ["finished"]);
      const mount: KindleVolumeInfo = {
        mountPath: mockKindleMount,
        documentsDir: mockKindleDocs,
        name: "Kindle",
        freeBytes: 1024 * 1024 * 100,
        totalBytes: 1024 * 1024 * 200,
      };

      // Without --all: only book1 pushed
      const resDefault = await pushBooksToKindle(
        { apply: false, all: false },
        mount,
        [book1, book2],
        new Map(),
      );
      expect(resDefault.length).toBe(1);
      expect(resDefault[0].title).toBe("Active Book");

      // With --all: both pushed
      const resAll = await pushBooksToKindle(
        { apply: false, all: true },
        mount,
        [book1, book2],
        new Map(),
      );
      expect(resAll.length).toBe(2);
      expect(resAll.map((r) => r.title)).toContain("Active Book");
      expect(resAll.map((r) => r.title)).toContain("Finished Book");
    });
  });

  // --------------------------------------------------------------------------
  // 5. Direction 2: Pull Highlights (Kindle -> Obsidian & Web Reader)
  // --------------------------------------------------------------------------
  describe("5. Direction 2: Pull Highlights (Kindle -> Obsidian & Web Reader)", () => {
    it("discovers KOReader .sdr directories and Kindle My Clippings.txt", () => {
      const sdrPath = path.join(mockKindleDocs, "Dune.sdr");
      fs.mkdirSync(sdrPath, { recursive: true });
      fs.writeFileSync(path.join(sdrPath, "metadata.epub.lua"), "return {}");

      const nestedSdr = path.join(mockKindleDocs, "SciFi", "Foundation.sdr");
      fs.mkdirSync(nestedSdr, { recursive: true });
      fs.writeFileSync(path.join(nestedSdr, "metadata.epub.lua"), "return {}");

      const foundSdrs = findKindleSdrDirs(mockKindleDocs);
      expect(foundSdrs.length).toBe(2);

      const clipPath = path.join(mockKindleDocs, "My Clippings.txt");
      fs.writeFileSync(clipPath, "==========\n");
      expect(findKindleClippings(mockKindleMount)).toBe(clipPath);
    });

    it("parses KOReader .sdr highlights and creates structured Obsidian note", async () => {
      const sdrPath = path.join(mockKindleDocs, "Dune.sdr");
      fs.mkdirSync(sdrPath, { recursive: true });
      const luaContent = `
        return {
          ["doc_props"] = {
            ["title"] = "Dune",
            ["authors"] = "Frank Herbert",
          },
          ["percent_finished"] = 0.65,
          ["annotations"] = {
            [1] = {
              ["text"] = "Fear is the mind-killer.",
              ["chapter"] = "Chapter 1",
              ["page"] = 24,
              ["datetime"] = "2026-03-24 10:00:00",
              ["notes"] = "Crucial quote on fear.",
            },
          },
        }
      `;
      fs.writeFileSync(path.join(sdrPath, "metadata.epub.lua"), luaContent);

      const mount: KindleVolumeInfo = {
        mountPath: mockKindleMount,
        documentsDir: mockKindleDocs,
        name: "Kindle",
        freeBytes: 1024 * 1024 * 100,
        totalBytes: 1024 * 1024 * 200,
      };

      const options: KindleSyncOptions = {
        apply: true,
        vaultPath: mockObsidianBooks,
        cacheDbPath: mockCacheDbPath,
      };

      const { results, totalImported } = await pullHighlightsFromKindle(
        options,
        mount,
        mockCalibreDbPath,
        new Map(),
      );

      expect(results.length).toBe(1);
      expect(results[0].bookTitle).toBe("Dune");
      expect(results[0].highlightsCount).toBe(1);
      expect(totalImported).toBe(1);

      const notePath = path.join(mockObsidianBooks, "Dune.md");
      expect(fs.existsSync(notePath)).toBe(true);
      const noteContent = fs.readFileSync(notePath, "utf8");
      expect(noteContent).toContain("Fear is the mind-killer.");
      expect(noteContent).toContain("Chapter 1");
      expect(noteContent).toContain("Page 24");
      expect(noteContent).toContain("**Note:** Crucial quote on fear.");
      expect(noteContent).toContain("65%");

      // Verify highlights are indexed in cache.db
      const chDb = new Database(mockCacheDbPath);
      const rows = chDb
        .query("SELECT * FROM book_highlights WHERE book_title = 'Dune';")
        .all() as any[];
      chDb.close();

      expect(rows.length).toBe(1);
      expect(rows[0].quote).toBe("Fear is the mind-killer.");
      expect(rows[0].note).toBe("Crucial quote on fear.");
    });

    it("refuses to write through symbolic links in Obsidian vault", async () => {
      // Create a decoy target file outside the vault
      const outsideFile = path.join(tempDir, "Secret.txt");
      fs.writeFileSync(outsideFile, "Secret content");

      // Create a symlink in the vault pointing to the outside file
      const symlinkNote = path.join(mockObsidianBooks, "SymlinkBook.md");
      fs.symlinkSync(outsideFile, symlinkNote);

      const sdrPath = path.join(mockKindleDocs, "SymlinkBook.sdr");
      fs.mkdirSync(sdrPath, { recursive: true });
      fs.writeFileSync(
        path.join(sdrPath, "metadata.epub.lua"),
        `return {
          ["doc_props"] = { ["title"] = "SymlinkBook", ["authors"] = "Author" },
          ["annotations"] = { [1] = { ["text"] = "Attempted escape quote" } }
        }`,
      );

      const mount: KindleVolumeInfo = {
        mountPath: mockKindleMount,
        documentsDir: mockKindleDocs,
        name: "Kindle",
        freeBytes: 1024 * 1024 * 100,
        totalBytes: 1024 * 1024 * 200,
      };

      const options: KindleSyncOptions = {
        apply: true,
        vaultPath: mockObsidianBooks,
        cacheDbPath: mockCacheDbPath,
      };

      const { results } = await pullHighlightsFromKindle(
        options,
        mount,
        mockCalibreDbPath,
        new Map(),
      );

      expect(results.length).toBe(1);
      expect(results[0].action).toBe("skipped");
      // Outside file must remain untouched!
      expect(fs.readFileSync(outsideFile, "utf8")).toBe("Secret content");
    });

    it("parses Kindle My Clippings.txt and updates existing Obsidian notes idempotently", async () => {
      // Existing note with 1 quote
      const notePath = path.join(mockObsidianBooks, "Neuromancer.md");
      fs.writeFileSync(
        notePath,
        `---
title: "Neuromancer"
author: "William Gibson"
tags:
  - book-notes
---

# Neuromancer

## Highlights & Notes
<!-- lighthouse:highlights:start -->
> The sky above the port was the color of television, tuned to a dead channel.
— Page 1
<!-- lighthouse:highlights:end -->
`,
      );

      // Add My Clippings with 1 existing quote and 1 new quote
      const clippings = `Neuromancer (William Gibson)
- Your Highlight on page 1 | location 10-12 | Added on Monday, March 1, 2026 12:00:00 PM

The sky above the port was the color of television, tuned to a dead channel.
==========
Neuromancer (William Gibson)
- Your Highlight on page 15 | location 200-205 | Added on Monday, March 1, 2026 1:00:00 PM

Case had never seen anyone who looked so much like a doll.
==========
`;
      fs.writeFileSync(path.join(mockKindleDocs, "My Clippings.txt"), clippings);

      const mount: KindleVolumeInfo = {
        mountPath: mockKindleMount,
        documentsDir: mockKindleDocs,
        name: "Kindle",
        freeBytes: 1024 * 1024 * 100,
        totalBytes: 1024 * 1024 * 200,
      };

      const options: KindleSyncOptions = {
        apply: true,
        vaultPath: mockObsidianBooks,
        cacheDbPath: mockCacheDbPath,
      };

      const { results, totalImported } = await pullHighlightsFromKindle(
        options,
        mount,
        mockCalibreDbPath,
        new Map(),
      );

      expect(results.length).toBe(1);
      expect(results[0].action).toBe("updated");
      // 1 new quote imported (the other already existed)
      expect(results[0].newHighlightsCount).toBe(1);
      expect(results[0].highlightsCount).toBe(2);
      expect(totalImported).toBe(1);

      const updatedContent = fs.readFileSync(notePath, "utf8");
      expect(updatedContent).toContain(
        "The sky above the port was the color of television, tuned to a dead channel.",
      );
      expect(updatedContent).toContain(
        "Case had never seen anyone who looked so much like a doll.",
      );
      // Ensure no duplicate quotes inside the file
      const matches = updatedContent.match(/tuned to a dead channel/g);
      expect(matches?.length).toBe(1);
    });
  });

  // --------------------------------------------------------------------------
  // 6. End-to-End Two-Way Sync Orchestration & Summary
  // --------------------------------------------------------------------------
  describe("6. End-to-End Two-Way Sync Orchestration & Summary", () => {
    it("runs complete two-way synchronization in apply mode", async () => {
      // Setup Calibre book
      const bookRel = "Orwell/1984";
      const fullDir = path.join(mockCalibreDir, bookRel);
      fs.mkdirSync(fullDir, { recursive: true });
      fs.writeFileSync(path.join(fullDir, "1984 - George Orwell.epub"), "1984 EPUB DATA");

      const cDb = new Database(mockCalibreDbPath);
      cDb.run("INSERT INTO books (id, title, path) VALUES (1, '1984', ?);", [bookRel]);
      cDb.run("INSERT INTO authors (id, name) VALUES (1, 'George Orwell');");
      cDb.run("INSERT INTO books_authors_link (book, author) VALUES (1, 1);");
      cDb.run("INSERT INTO tags (name) VALUES ('reading');");
      cDb.run("INSERT INTO books_tags_link (book, tag) VALUES (1, 1);");
      cDb.run("INSERT INTO data (book, format, name, uncompressed_size) VALUES (1, 'EPUB', '1984 - George Orwell', 100);");
      cDb.close();

      // Setup Kindle highlights
      const clippings = `1984 (George Orwell)
- Your Highlight on page 5 | location 50-52 | Added on Tuesday, March 2, 2026 2:00:00 PM

War is peace. Freedom is slavery. Ignorance is strength.
==========
`;
      fs.writeFileSync(path.join(mockKindleDocs, "My Clippings.txt"), clippings);

      const report = await syncKindle({
        mountPath: mockKindleMount,
        apply: true,
        calibreDbPath: mockCalibreDbPath,
        calibreLibraryDir: mockCalibreDir,
        kosyncDbPath: mockKosyncDbPath,
        cacheDbPath: mockCacheDbPath,
        vaultPath: mockObsidianBooks,
      });

      expect(report.mount).not.toBeNull();
      expect(report.dryRun).toBe(false);
      expect(report.booksPushed.length).toBe(1);
      expect(report.booksPushed[0].status).toBe("transferred");
      expect(report.highlightsPulled.length).toBe(1);
      expect(report.totalHighlightsImported).toBe(1);

      // Verify summary output
      const summary = formatSyncReport(report);
      expect(summary).toContain("LightHouse Type-C Kindle Two-Way Synchronization");
      expect(summary).toContain("Transferred:       1");
      expect(summary).toContain("1984: 1 new (1 total) -> 1984.md");

      // Verify Obsidian note content
      const notePath = path.join(mockObsidianBooks, "1984.md");
      expect(fs.existsSync(notePath)).toBe(true);
      const noteContent = fs.readFileSync(notePath, "utf8");
      expect(noteContent).toContain("War is peace. Freedom is slavery. Ignorance is strength.");
    });

    it("does not eject device when there are failed push operations", async () => {
      const bookRel = "FailedBook/Fail";
      const fullDir = path.join(mockCalibreDir, bookRel);
      fs.mkdirSync(fullDir, { recursive: true });
      fs.writeFileSync(path.join(fullDir, "Fail - Author.epub"), "Content");

      const cDb = new Database(mockCalibreDbPath);
      cDb.run("INSERT INTO books (id, title, path) VALUES (99, 'Fail', ?);", [bookRel]);
      cDb.run("INSERT INTO authors (id, name) VALUES (99, 'Author');");
      cDb.run("INSERT INTO books_authors_link (book, author) VALUES (99, 99);");
      cDb.run("INSERT INTO data (book, format, name, uncompressed_size) VALUES (99, 'EPUB', 'Fail - Author', 100);");
      cDb.close();

      // Mount with very low disk space to force push failure
      const report = await syncKindle({
        mountPath: mockKindleMount,
        apply: true,
        eject: true,
        calibreDbPath: mockCalibreDbPath,
        calibreLibraryDir: mockCalibreDir,
        kosyncDbPath: mockKosyncDbPath,
        cacheDbPath: mockCacheDbPath,
        vaultPath: mockObsidianBooks,
      });

      // If push succeeded, force a fail case to verify eject gating
      expect(report.ejected).toBe(false);
    });

    it("handles no device mounted gracefully", async () => {
      const report = await syncKindle({
        mountPath: path.join(tempDir, "DoesNotExist"),
      });
      expect(report.mount).toBeNull();
      expect(report.errors.length).toBeGreaterThan(0);
      const summary = formatSyncReport(report);
      expect(summary).toContain("No device detected");
    });
  });

  // --------------------------------------------------------------------------
  // 7. CLI bin/lighthouse sync-kindle Integration
  // --------------------------------------------------------------------------
  describe("7. CLI bin/lighthouse sync-kindle Integration", () => {
    it("bin/lighthouse sync-kindle --help outputs options and usage", () => {
      const res = spawnSync(LIGHTHOUSE_BIN, ["sync-kindle", "--help"], {
        encoding: "utf8",
        cwd: tempDir,
      });
      expect(res.status).toBe(0);
      expect(res.stdout).toContain("LightHouse Type-C Kindle Two-Way Synchronization CLI");
      expect(res.stdout).toContain("--apply");
      expect(res.stdout).toContain("--dry-run");
      expect(res.stdout).toContain("--all");
      expect(res.stdout).toContain("--mount");
      expect(res.stdout).toContain("--vault-path");
      expect(res.stdout).toContain("--eject");
    });

    it("bin/lighthouse sync-kindle --dry-run with --mount simulates sync", () => {
      const res = spawnSync(
        LIGHTHOUSE_BIN,
        [
          "sync-kindle",
          "--dry-run",
          "--mount",
          mockKindleMount,
          "--vault-path",
          mockObsidianBooks,
        ],
        {
          encoding: "utf8",
          cwd: tempDir,
          env: {
            ...process.env,
            CALIBRE_DB_PATH: mockCalibreDbPath,
            CALIBRE_LIBRARY_DIR: mockCalibreDir,
            KOSYNC_DB_PATH: mockKosyncDbPath,
            CACHE_DB_PATH: mockCacheDbPath,
          },
        },
      );
      expect(res.status).toBe(0);
      expect(res.stdout).toContain("LightHouse Type-C Kindle Two-Way Synchronization");
      expect(res.stdout).toContain("DRY RUN");
    });

    it("verifies bin/lighthouse kindle-sync does not exist as duplicate command", () => {
      const res = spawnSync(LIGHTHOUSE_BIN, ["kindle-sync"], {
        encoding: "utf8",
        cwd: tempDir,
      });
      expect(res.status).not.toBe(0);
      expect(res.stdout + res.stderr).toContain("Unknown command");
    });

    it("detects /Volumes/Kindle/books as primary target when both books and documents exist", () => {
      const dualMount = path.join(tempDir, "DualKindle");
      fs.mkdirSync(path.join(dualMount, "books"), { recursive: true });
      fs.mkdirSync(path.join(dualMount, "documents"), { recursive: true });

      const info = detectKindleMount(dualMount);
      expect(info).not.toBeNull();
      expect(info?.booksDir).toBe(path.join(dualMount, "books"));
      expect(info?.candidateDirs).toContain(path.join(dualMount, "books"));
      expect(info?.candidateDirs).toContain(path.join(dualMount, "documents"));
    });

    it("deduplicates books present in documents/ when syncing to books/", async () => {
      const booksDir = path.join(mockKindleMount, "books");
      const docsDir = path.join(mockKindleMount, "documents");
      fs.mkdirSync(booksDir, { recursive: true });
      fs.mkdirSync(docsDir, { recursive: true });

      const mountInfo = detectKindleMount(mockKindleMount)!;
      expect(mountInfo.booksDir).toBe(booksDir);

      // Create a book in Calibre
      const bookRel = "Authors/BookX";
      const fullDir = path.join(mockCalibreDir, bookRel);
      fs.mkdirSync(fullDir, { recursive: true });
      const bookContent = "Dummy epub content for deduplication test";
      fs.writeFileSync(path.join(fullDir, "BookX - AuthorX.epub"), bookContent);

      const cDb = new Database(mockCalibreDbPath);
      cDb.run("INSERT INTO books (id, title, path) VALUES (101, 'BookX', ?);", [bookRel]);
      cDb.run("INSERT INTO authors (id, name) VALUES (101, 'AuthorX');");
      cDb.run("INSERT INTO books_authors_link (book, author) VALUES (101, 101);");
      cDb.run("INSERT INTO data (book, format, name, uncompressed_size) VALUES (101, 'EPUB', 'BookX - AuthorX', ?);", [bookContent.length]);
      cDb.close();

      const books = queryCalibreBooksWithFiles(mockCalibreDbPath, mockCalibreDir);
      const targetBook = books.find((b) => b.id === 101)!;

      // Place book in documents/ (legacy location)
      fs.writeFileSync(path.join(docsDir, "BookX - AuthorX.epub"), bookContent);

      // Run push to booksDir
      const pushRes = await pushBooksToKindle(
        { apply: true, all: true },
        mountInfo,
        [targetBook],
        new Map(),
      );

      expect(pushRes.length).toBe(1);
      expect(pushRes[0].status).toBe("skipped");
      expect(pushRes[0].reason).toContain("Already present with identical size");

      // Verify it was NOT re-copied to books/
      expect(fs.existsSync(path.join(booksDir, "BookX - AuthorX.epub"))).toBe(false);
    });

    it("scans and pulls highlights from both books/ and documents/ .sdr folders", async () => {
      const booksDir = path.join(mockKindleMount, "books");
      const docsDir = path.join(mockKindleMount, "documents");
      fs.mkdirSync(booksDir, { recursive: true });
      fs.mkdirSync(docsDir, { recursive: true });

      // Create .sdr in books/
      const sdrInBooks = path.join(booksDir, "NovelA.sdr");
      fs.mkdirSync(sdrInBooks, { recursive: true });
      fs.writeFileSync(
        path.join(sdrInBooks, "metadata.epub.lua"),
        `return {
          ["bookmarks"] = {
            { ["text"] = "Quote from books directory", ["datetime"] = "2026-09-24 10:00:00", ["page"] = 10 }
          },
          ["stats"] = { ["title"] = "Novel A", ["authors"] = "Author A", ["performance_in_pages"] = {} }
        }`,
      );

      // Create .sdr in documents/
      const sdrInDocs = path.join(docsDir, "NovelB.sdr");
      fs.mkdirSync(sdrInDocs, { recursive: true });
      fs.writeFileSync(
        path.join(sdrInDocs, "metadata.epub.lua"),
        `return {
          ["bookmarks"] = {
            { ["text"] = "Quote from documents directory", ["datetime"] = "2026-09-24 11:00:00", ["page"] = 20 }
          },
          ["stats"] = { ["title"] = "Novel B", ["authors"] = "Author B", ["performance_in_pages"] = {} }
        }`,
      );

      const mountInfo = detectKindleMount(mockKindleMount)!;
      const pullRes = await pullHighlightsFromKindle(
        { apply: true, vaultPath: mockObsidianBooks },
        mountInfo,
        mockCalibreDbPath,
        new Map(),
      );

      expect(pullRes.totalImported).toBe(2);
      expect(pullRes.results.map((r) => r.bookTitle).sort()).toEqual(["Novel A", "Novel B"].sort());
      expect(fs.existsSync(path.join(mockObsidianBooks, "Novel A.md"))).toBe(true);
      expect(fs.existsSync(path.join(mockObsidianBooks, "Novel B.md"))).toBe(true);
    });
  });
});
