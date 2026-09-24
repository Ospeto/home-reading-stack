import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { Database } from "bun:sqlite";
import {
  detectKindleVolume,
  countKindleDocuments,
  getKindleStatus,
  sanitizeFat32Filename,
  safeCopyFileToKindle,
  syncSingleBookToKindle,
  syncAllBooksToKindle,
  ejectKindleVolume,
} from "./kindle";
import { handleRequest, resetServerDependenciesForTest } from "./server";

describe("Kindle USB Detection & Bulk Sync Engine", () => {
  let tempBaseDir: string;
  let fakeVolumesDir: string;
  let fakeLibraryDir: string;
  let fakeCalibreDbPath: string;
  let origCalibreDb: string | undefined;
  let origCalibreLib: string | undefined;

  beforeEach(() => {
    tempBaseDir = fs.mkdtempSync(path.join(os.tmpdir(), "kindle-test-"));
    fakeVolumesDir = path.join(tempBaseDir, "Volumes");
    fakeLibraryDir = path.join(tempBaseDir, "Calibre_Library");
    fakeCalibreDbPath = path.join(fakeLibraryDir, "metadata.db");

    fs.mkdirSync(fakeVolumesDir, { recursive: true });
    fs.mkdirSync(fakeLibraryDir, { recursive: true });

    origCalibreDb = process.env.CALIBRE_DB_PATH;
    origCalibreLib = process.env.CALIBRE_LIBRARY_DIR;
    process.env.CALIBRE_DB_PATH = fakeCalibreDbPath;
    process.env.CALIBRE_LIBRARY_DIR = fakeLibraryDir;
  });

  afterEach(() => {
    resetServerDependenciesForTest();
    if (origCalibreDb !== undefined) process.env.CALIBRE_DB_PATH = origCalibreDb;
    else delete process.env.CALIBRE_DB_PATH;
    if (origCalibreLib !== undefined) process.env.CALIBRE_LIBRARY_DIR = origCalibreLib;
    else delete process.env.CALIBRE_LIBRARY_DIR;

    try {
      fs.rmSync(tempBaseDir, { recursive: true, force: true });
    } catch (_cleanupErr) {
      void _cleanupErr;
    }
  });

  function setupFakeCalibreDatabase(books: Array<{
    id: number;
    title: string;
    author: string;
    series?: string;
    seriesIndex?: number;
    format: string;
    fileContent: string;
  }>) {
    const db = new Database(fakeCalibreDbPath);
    db.run(`
      CREATE TABLE books (
        id INTEGER PRIMARY KEY,
        title TEXT,
        path TEXT,
        series_index REAL DEFAULT 1.0,
        has_cover INTEGER DEFAULT 0,
        pubdate TEXT
      );
      CREATE TABLE data (
        id INTEGER PRIMARY KEY,
        book INTEGER,
        format TEXT,
        uncompressed_size INTEGER,
        name TEXT
      );
      CREATE TABLE authors (id INTEGER PRIMARY KEY, name TEXT);
      CREATE TABLE books_authors_link (id INTEGER PRIMARY KEY, book INTEGER, author INTEGER);
      CREATE TABLE series (id INTEGER PRIMARY KEY, name TEXT);
      CREATE TABLE books_series_link (id INTEGER PRIMARY KEY, book INTEGER, series INTEGER);
    `);

    for (const b of books) {
      const bookRelDir = `Author_${b.id}/Book_${b.id}`;
      const bookFullDir = path.join(fakeLibraryDir, bookRelDir);
      fs.mkdirSync(bookFullDir, { recursive: true });

      const fileName = `book_${b.id}`;
      const fileExt = b.format.toLowerCase();
      const filePath = path.join(bookFullDir, `${fileName}.${fileExt}`);
      fs.writeFileSync(filePath, b.fileContent, "utf8");

      db.run("INSERT INTO books (id, title, path, series_index) VALUES (?, ?, ?, ?)", [
        b.id,
        b.title,
        bookRelDir,
        b.seriesIndex ?? 1.0,
      ]);

      const stat = fs.statSync(filePath);
      db.run("INSERT INTO data (id, book, format, uncompressed_size, name) VALUES (?, ?, ?, ?, ?)", [
        b.id,
        b.id,
        b.format.toUpperCase(),
        stat.size,
        fileName,
      ]);

      db.run("INSERT INTO authors (id, name) VALUES (?, ?)", [b.id, b.author]);
      db.run("INSERT INTO books_authors_link (book, author) VALUES (?, ?)", [b.id, b.id]);

      if (b.series) {
        db.run("INSERT INTO series (id, name) VALUES (?, ?)", [b.id, b.series]);
        db.run("INSERT INTO books_series_link (book, series) VALUES (?, ?)", [b.id, b.id]);
      }
    }
    db.close();
  }

  describe("1. Volume Detection & Storage Stats", () => {
    it("returns null when no Kindle or documents directory is found", () => {
      const detected = detectKindleVolume(fakeVolumesDir);
      expect(detected).toBeNull();
    });

    it("detects /Volumes/Kindle with documents folder", () => {
      const kindleMount = path.join(fakeVolumesDir, "Kindle");
      fs.mkdirSync(path.join(kindleMount, "documents"), { recursive: true });

      const detected = detectKindleVolume(fakeVolumesDir);
      expect(detected).toBe(kindleMount);
    });

    it("detects /Volumes/KINDLE with uppercase name", () => {
      const kindleMount = path.join(fakeVolumesDir, "KINDLE");
      fs.mkdirSync(path.join(kindleMount, "documents"), { recursive: true });

      const detected = detectKindleVolume(fakeVolumesDir);
      expect(detected).toBe(kindleMount);
    });

    it("detects arbitrary volume containing a documents directory", () => {
      const customMount = path.join(fakeVolumesDir, "Paperwhite_64GB");
      fs.mkdirSync(path.join(customMount, "documents"), { recursive: true });
      fs.mkdirSync(path.join(customMount, "system"), { recursive: true });

      const detected = detectKindleVolume(fakeVolumesDir);
      expect(detected).toBe(customMount);
    });

    it("counts existing book documents recursively while skipping .sdr directories", () => {
      const kindleMount = path.join(fakeVolumesDir, "Kindle");
      const docs = path.join(kindleMount, "documents");
      const sub = path.join(docs, "Brandon Sanderson");
      const sdr = path.join(docs, "Book1.sdr");

      fs.mkdirSync(sub, { recursive: true });
      fs.mkdirSync(sdr, { recursive: true });

      fs.writeFileSync(path.join(docs, "Book1.epub"), "epub", "utf8");
      fs.writeFileSync(path.join(docs, "Book2.azw3"), "azw3", "utf8");
      fs.writeFileSync(path.join(sub, "Book3.kfx"), "kfx", "utf8");
      fs.writeFileSync(path.join(sub, "Book4.mobi"), "mobi", "utf8");
      fs.writeFileSync(path.join(sub, "Book5.pdf"), "pdf", "utf8");
      fs.writeFileSync(path.join(sub, "Notes.txt"), "notes", "utf8");
      fs.writeFileSync(path.join(sdr, "metadata.lua"), "lua", "utf8"); // should not count

      const count = countKindleDocuments(kindleMount);
      expect(count).toBe(6);
    });

    it("getKindleStatus reports accurate detection and book counts", () => {
      setupFakeCalibreDatabase([
        { id: 1, title: "Mistborn", author: "Brandon Sanderson", format: "EPUB", fileContent: "sample" },
      ]);

      const kindleMount = path.join(fakeVolumesDir, "Kindle");
      fs.mkdirSync(path.join(kindleMount, "documents"), { recursive: true });
      fs.writeFileSync(path.join(kindleMount, "documents", "Existing.epub"), "content", "utf8");

      const status = getKindleStatus(fakeVolumesDir);
      expect(status.detected).toBe(true);
      expect(status.mountPath).toBe(kindleMount);
      expect(status.volumeName).toBe("Kindle");
      expect(status.booksOnDevice).toBe(1);
      expect(status.libraryBooks).toBe(1);
      expect(status.freeBytes).toBeGreaterThanOrEqual(0);
    });
  });

  describe("2. FAT32 Filename Sanitization & Safe Copy", () => {
    it("strips illegal FAT32 characters like colons, asterisks, question marks, and pipe", () => {
      const raw = 'Re:Zero - Starting Life in Another World? *Special Edition* <Vol | 1>.epub';
      const clean = sanitizeFat32Filename(raw);
      expect(clean).not.toContain(":");
      expect(clean).not.toContain("*");
      expect(clean).not.toContain("?");
      expect(clean).not.toContain("<");
      expect(clean).not.toContain(">");
      expect(clean).not.toContain("|");
      expect(clean.endsWith(".epub")).toBe(true);
    });

    it("bounds excessively long filenames while retaining extension", () => {
      const veryLong = "A".repeat(300) + ".epub";
      const clean = sanitizeFat32Filename(veryLong);
      expect(clean.length).toBeLessThanOrEqual(180);
      expect(clean.endsWith(".epub")).toBe(true);
    });

    it("safeCopyFileToKindle creates parent directories and transfers content reliably", () => {
      const srcFile = path.join(tempBaseDir, "source.epub");
      fs.writeFileSync(srcFile, "EPUB binary mock data", "utf8");

      const destFile = path.join(fakeVolumesDir, "Kindle", "documents", "Author", "Book.epub");
      safeCopyFileToKindle(srcFile, destFile);

      expect(fs.existsSync(destFile)).toBe(true);
      expect(fs.readFileSync(destFile, "utf8")).toBe("EPUB binary mock data");
    });
  });

  describe("3. Bulk & Single Book Synchronization", () => {
    it("syncs single book to Kindle with author subfolder", () => {
      setupFakeCalibreDatabase([
        { id: 1, title: "Way of Kings", author: "Brandon Sanderson", format: "EPUB", fileContent: "stormlight 1" },
      ]);

      const kindleMount = path.join(fakeVolumesDir, "Kindle");
      fs.mkdirSync(path.join(kindleMount, "documents"), { recursive: true });

      const res = syncSingleBookToKindle(1, { mountPath: kindleMount });
      expect(res.success).toBe(true);
      expect(res.bookId).toBe(1);
      expect(res.alreadySynced).toBe(false);
      expect(res.bytesTransferred).toBeGreaterThan(0);
      expect(fs.existsSync(res.destinationPath!)).toBe(true);

      // Re-syncing same book skips transfer (alreadySynced)
      const res2 = syncSingleBookToKindle(1, { mountPath: kindleMount });
      expect(res2.success).toBe(true);
      expect(res2.alreadySynced).toBe(true);
      expect(res2.bytesTransferred).toBe(0);
    });

    it("syncAllBooksToKindle performs incremental bulk transfer and skips existing matching files", async () => {
      setupFakeCalibreDatabase([
        { id: 1, title: "Book One", author: "Author A", format: "EPUB", fileContent: "content 1" },
        { id: 2, title: "Book Two", author: "Author B", format: "EPUB", fileContent: "content 2" },
      ]);

      const kindleMount = path.join(fakeVolumesDir, "Kindle");
      fs.mkdirSync(path.join(kindleMount, "books"), { recursive: true });

      // First run: transfers both books
      const run1 = await syncAllBooksToKindle({ mountPath: kindleMount });
      expect(run1.success).toBe(true);
      expect(run1.totalBooks).toBe(2);
      expect(run1.transferred).toBe(2);
      expect(run1.alreadySynced).toBe(0);
      expect(run1.failed).toBe(0);

      // Second run: both already synced
      const run2 = await syncAllBooksToKindle({ mountPath: kindleMount });
      expect(run2.success).toBe(true);
      expect(run2.totalBooks).toBe(2);
      expect(run2.transferred).toBe(0);
      expect(run2.alreadySynced).toBe(2);
      expect(run2.failed).toBe(0);
    });

    it("prefers /Volumes/Kindle/books over documents and avoids re-copying books present in documents", async () => {
      setupFakeCalibreDatabase([
        { id: 1, title: "Book In Documents", author: "Author D", format: "EPUB", fileContent: "already in docs" },
        { id: 2, title: "New Book", author: "Author N", format: "EPUB", fileContent: "new for books" },
      ]);

      const kindleMount = path.join(fakeVolumesDir, "Kindle");
      const booksDir = path.join(kindleMount, "books");
      const docsDir = path.join(kindleMount, "documents");
      fs.mkdirSync(booksDir, { recursive: true });
      fs.mkdirSync(docsDir, { recursive: true });

      // Simulate Book 1 already manually or previously present in documents/
      const file1Name = "Book In Documents - Author D.epub";
      fs.writeFileSync(path.join(docsDir, file1Name), "already in docs");

      const run = await syncAllBooksToKindle({ mountPath: kindleMount });
      expect(run.success).toBe(true);
      expect(run.totalBooks).toBe(2);
      expect(run.transferred).toBe(1); // Only Book 2 transferred
      expect(run.alreadySynced).toBe(1); // Book 1 skipped because it was in documents/

      // Verify Book 2 was placed in books/ (primary target)
      expect(fs.existsSync(path.join(booksDir, "Author N", "New Book - Author N.epub"))).toBe(true);
    });

    it("syncAllBooksToKindle re-transfers when forceAll is true", async () => {
      setupFakeCalibreDatabase([
        { id: 1, title: "Book One", author: "Author A", format: "EPUB", fileContent: "content 1" },
      ]);

      const kindleMount = path.join(fakeVolumesDir, "Kindle");
      fs.mkdirSync(path.join(kindleMount, "documents"), { recursive: true });

      await syncAllBooksToKindle({ mountPath: kindleMount });
      const runForce = await syncAllBooksToKindle({ mountPath: kindleMount, forceAll: true });
      expect(runForce.transferred).toBe(1);
      expect(runForce.alreadySynced).toBe(0);
    });

    it("returns error gracefully when no Kindle device is mounted", async () => {
      const res = await syncAllBooksToKindle({ mountPath: path.join(tempBaseDir, "NonExistent") });
      expect(res.success).toBe(false);
      expect(res.errors.length).toBeGreaterThan(0);
    });

    it("ejectKindleVolume handles missing mount safely", () => {
      const res = ejectKindleVolume(path.join(tempBaseDir, "NonExistentMount"));
      expect(res.success).toBe(false);
      expect(res.message).toBeDefined();
    });

    it("ejectKindleVolume enforces /Volumes directory containment", () => {
      // An arbitrary non-volume directory outside /Volumes and outside test directories
      const origEnv = process.env.NODE_ENV;
      try {
        process.env.NODE_ENV = "production";
        const res = ejectKindleVolume("/etc");
        expect(res.success).toBe(false);
        expect(res.message).toContain("escapes /Volumes/ directory");
      } finally {
        process.env.NODE_ENV = origEnv;
      }
    });
  });

  describe("4. HTTP API Endpoints Integration (uploader/server.ts)", () => {
    const localServer = { requestIP: () => ({ address: "127.0.0.1" }) };

    it("GET /api/kindle/status returns Kindle detection and storage metrics", async () => {
      const kindleMount = path.join(fakeVolumesDir, "Kindle");
      fs.mkdirSync(path.join(kindleMount, "documents"), { recursive: true });

      // Override detect logic by testing endpoint with detected status
      const req = new Request("http://127.0.0.1:8086/api/kindle/status", { method: "GET" });
      const res = await handleRequest(req, localServer);
      expect(res.status).toBe(200);

      const data = (await res.json()) as any;
      expect(data).toHaveProperty("detected");
      expect(data).toHaveProperty("freeBytes");
      expect(data).toHaveProperty("totalBytes");
      expect(data).toHaveProperty("booksOnDevice");
      expect(data).toHaveProperty("libraryBooks");
    });

    it("GET /api/kindle/progress returns current progress and status", async () => {
      const req = new Request("http://127.0.0.1:8086/api/kindle/progress");
      const res = await handleRequest(req, localServer);
      expect(res.status).toBe(200);

      const data = (await res.json()) as any;
      expect(data).toHaveProperty("status");
      expect(data).toHaveProperty("progress");
    });

    it("POST /api/kindle/sync triggers bulk sync and returns 200 or 500 JSON", async () => {
      const req = new Request("http://127.0.0.1:8086/api/kindle/sync", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ subfolderByAuthor: true }),
      });
      const res = await handleRequest(req, localServer);
      expect([200, 500]).toContain(res.status);

      const data = (await res.json()) as any;
      expect(data).toHaveProperty("success");
      expect(data).toHaveProperty("results");
    });

    it("POST /api/kindle/eject responds with JSON result", async () => {
      const req = new Request("http://127.0.0.1:8086/api/kindle/eject", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
      });
      const res = await handleRequest(req, localServer);
      expect([200, 500]).toContain(res.status);

      const data = (await res.json()) as any;
      expect(data).toHaveProperty("success");
      expect(data).toHaveProperty("message");
    });

    it("POST /api/books/:id/send-kindle validates ID and handles transfer", async () => {
      const reqBad = new Request("http://127.0.0.1:8086/api/books/invalid/send-kindle", {
        method: "POST",
      });
      const resBad = await handleRequest(reqBad, localServer);
      expect(resBad.status).toBe(400);

      const reqGood = new Request("http://127.0.0.1:8086/api/books/99999/send-kindle", {
        method: "POST",
      });
      const resGood = await handleRequest(reqGood, localServer);
      expect([200, 400]).toContain(resGood.status);
    });
  });

  describe("5. Web UI (#kindleModal & #bookModal in uploader/index.html)", () => {
    it("index.html contains #kindleStatusBtn, #kindleModal, and #detailSendKindleBtn", () => {
      const htmlPath = path.resolve((import.meta as any).dir, "index.html");
      const html = fs.readFileSync(htmlPath, "utf8");

      expect(html).toContain('id="kindleStatusBtn"');
      expect(html).toContain('id="kindleModal"');
      expect(html).toContain('id="kindleSyncAllBtn"');
      expect(html).toContain('id="kindleEjectBtn"');
      expect(html).toContain('id="detailSendKindleBtn"');

      // Auto-Prompt Pop-up Banner elements
      expect(html).toContain('id="kindleAutoPrompt"');
      expect(html).toContain('id="kindleAutoPromptDetails"');
      expect(html).toContain('id="kindlePromptSyncBtn"');
      expect(html).toContain('id="kindlePromptDismissBtn"');
      expect(html).toContain("Yes, Sync Now");
      expect(html).toContain("No / Later");

      // Live Progress UI elements
      expect(html).toContain('id="kindleSyncProgressBar"');
      expect(html).toContain('id="kindleSyncPercent"');
      expect(html).toContain('id="kindleLiveTitle"');
      expect(html).toContain('id="kindleLiveCount"');
      expect(html).toContain('id="kindleLiveBytes"');

      // Clean Summary Card on completion
      expect(html).toContain('id="kindleSummaryCard"');
      expect(html).toContain('id="kindleSummaryText"');
      expect(html).toContain('id="kindleSummaryEjectBtn"');

      // Obsolete Obsidian action buttons must be removed
      expect(html).not.toContain('id="detailSyncObsidianBtn"');
      expect(html).not.toContain('id="detailObsidianBtn"');
      expect(html).not.toContain("syncCurrentBookToObsidian");
    });

    it("index.html client-side scripts parse without any syntax errors", () => {
      const htmlPath = path.resolve((import.meta as any).dir, "index.html");
      const html = fs.readFileSync(htmlPath, "utf8");
      const scriptMatches = [...html.matchAll(/<script(?:\s+[^>]*)?>([\s\S]*?)<\/script>/gi)];

      expect(scriptMatches.length).toBeGreaterThan(0);
      for (const match of scriptMatches) {
        const scriptCode = match[1];
        if (scriptCode.trim().length > 0) {
          expect(() => {
            // SAFETY: In-memory Function constructor validates script parsing without execution
            new Function(scriptCode);
          }).not.toThrow();
        }
      }
    });
  });
});
