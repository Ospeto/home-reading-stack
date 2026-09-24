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
  resolveDiskutilPath,
  buildKindleBookIndex,
  isBookAlreadyOnKindle,
  isBookAlreadyOnKindleAsync,
  normalizeAuthorSpacing,
  resolveKindleDestinationDir,
  runDotClean,
  cleanDotFilesFallback,
  cancelKindleSync,
  previewKindleSync,
  isBookActiveOrUnread,
  getAllKindleCandidates,
  invalidateKindleBookIndex,
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
    process.env.LIGHTHOUSE_VOLUMES_DIR = fakeVolumesDir;
    invalidateKindleBookIndex();
  });

  afterEach(() => {
    delete process.env.LIGHTHOUSE_VOLUMES_DIR;
    invalidateKindleBookIndex();
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
    tags?: string[];
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
      CREATE TABLE tags (id INTEGER PRIMARY KEY, name TEXT);
      CREATE TABLE books_tags_link (id INTEGER PRIMARY KEY, book INTEGER, tag INTEGER);
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

      if (b.tags) {
        for (let tIdx = 0; tIdx < b.tags.length; tIdx++) {
          const tagName = b.tags[tIdx];
          const tagId = b.id * 100 + tIdx + 1;
          db.run("INSERT INTO tags (id, name) VALUES (?, ?)", [tagId, tagName]);
          db.run("INSERT INTO books_tags_link (id, book, tag) VALUES (?, ?, ?)", [tagId, b.id, tagId]);
        }
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
    it("syncs single book to Kindle with author subfolder", async () => {
      setupFakeCalibreDatabase([
        { id: 1, title: "Way of Kings", author: "Brandon Sanderson", format: "EPUB", fileContent: "stormlight 1" },
      ]);

      const kindleMount = path.join(fakeVolumesDir, "Kindle");
      fs.mkdirSync(path.join(kindleMount, "documents"), { recursive: true });

      const res = await syncSingleBookToKindle(1, { mountPath: kindleMount });
      expect(res.success).toBe(true);
      expect(res.bookId).toBe(1);
      expect(res.alreadySynced).toBe(false);
      expect(res.bytesTransferred).toBeGreaterThan(0);
      expect(fs.existsSync(res.destinationPath!)).toBe(true);

      // Re-syncing same book skips transfer (alreadySynced)
      const res2 = await syncSingleBookToKindle(1, { mountPath: kindleMount });
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

    it("resolveDiskutilPath returns /usr/sbin/diskutil when binary exists", () => {
      const origExists = fs.existsSync;
      const origBin = process.env.LIGHTHOUSE_DISKUTIL_BIN;
      try {
        delete process.env.LIGHTHOUSE_DISKUTIL_BIN;
        (fs as any).existsSync = (p: string) => {
          if (p === "/usr/sbin/diskutil") return true;
          return origExists(p);
        };
        expect(resolveDiskutilPath()).toBe("/usr/sbin/diskutil");
      } finally {
        fs.existsSync = origExists;
        if (origBin !== undefined) process.env.LIGHTHOUSE_DISKUTIL_BIN = origBin;
      }
    });

    it("resolveDiskutilPath falls back to diskutil when /usr/sbin/diskutil does not exist", () => {
      const origExists = fs.existsSync;
      const origBin = process.env.LIGHTHOUSE_DISKUTIL_BIN;
      try {
        delete process.env.LIGHTHOUSE_DISKUTIL_BIN;
        (fs as any).existsSync = (p: string) => {
          if (p === "/usr/sbin/diskutil") return false;
          return origExists(p);
        };
        expect(resolveDiskutilPath()).toBe("diskutil");
      } finally {
        fs.existsSync = origExists;
        if (origBin !== undefined) process.env.LIGHTHOUSE_DISKUTIL_BIN = origBin;
      }
    });

    it("resolveDiskutilPath respects LIGHTHOUSE_DISKUTIL_BIN override when set", () => {
      const origBin = process.env.LIGHTHOUSE_DISKUTIL_BIN;
      try {
        process.env.LIGHTHOUSE_DISKUTIL_BIN = "/custom/path/diskutil";
        expect(resolveDiskutilPath()).toBe("/custom/path/diskutil");
      } finally {
        if (origBin !== undefined) {
          process.env.LIGHTHOUSE_DISKUTIL_BIN = origBin;
        } else {
          delete process.env.LIGHTHOUSE_DISKUTIL_BIN;
        }
      }
    });

    it("ejectKindleVolume handles res.error gracefully when spawnSync fails", () => {
      const testMount = path.join(tempBaseDir, "ErrorMount");
      fs.mkdirSync(testMount, { recursive: true });
      const origAllow = process.env.LIGHTHOUSE_TEST_ALLOW_EJECT_PATH;
      const origBin = process.env.LIGHTHOUSE_DISKUTIL_BIN;

      try {
        process.env.LIGHTHOUSE_TEST_ALLOW_EJECT_PATH = tempBaseDir;
        process.env.LIGHTHOUSE_DISKUTIL_BIN = path.join(tempBaseDir, "nonexistent-diskutil-bin");

        const res = ejectKindleVolume(testMount);
        expect(res.success).toBe(false);
        expect(res.message).not.toContain("undefined");
        expect(res.message).toMatch(/ENOENT|no such file/i);
      } finally {
        if (origAllow !== undefined) {
          process.env.LIGHTHOUSE_TEST_ALLOW_EJECT_PATH = origAllow;
        } else {
          delete process.env.LIGHTHOUSE_TEST_ALLOW_EJECT_PATH;
        }
        if (origBin !== undefined) {
          process.env.LIGHTHOUSE_DISKUTIL_BIN = origBin;
        } else {
          delete process.env.LIGHTHOUSE_DISKUTIL_BIN;
        }
      }
    });

    it("ejectKindleVolume succeeds when diskutil process exits 0", () => {
      const testMount = path.join(tempBaseDir, "SuccessMount");
      fs.mkdirSync(testMount, { recursive: true });
      const mockScript = path.join(tempBaseDir, "mock_diskutil_success.sh");
      fs.writeFileSync(mockScript, "#!/bin/sh\nexit 0\n", { mode: 0o755 });

      const origAllow = process.env.LIGHTHOUSE_TEST_ALLOW_EJECT_PATH;
      const origBin = process.env.LIGHTHOUSE_DISKUTIL_BIN;

      try {
        process.env.LIGHTHOUSE_TEST_ALLOW_EJECT_PATH = tempBaseDir;
        process.env.LIGHTHOUSE_DISKUTIL_BIN = mockScript;

        const res = ejectKindleVolume(testMount);
        expect(res.success).toBe(true);
        expect(res.message).toContain(`Successfully ejected ${testMount}`);
      } finally {
        if (origAllow !== undefined) {
          process.env.LIGHTHOUSE_TEST_ALLOW_EJECT_PATH = origAllow;
        } else {
          delete process.env.LIGHTHOUSE_TEST_ALLOW_EJECT_PATH;
        }
        if (origBin !== undefined) {
          process.env.LIGHTHOUSE_DISKUTIL_BIN = origBin;
        } else {
          delete process.env.LIGHTHOUSE_DISKUTIL_BIN;
        }
      }
    });

    it("ejectKindleVolume reports stderr when diskutil process exits with error", () => {
      const testMount = path.join(tempBaseDir, "FailMount");
      fs.mkdirSync(testMount, { recursive: true });
      const mockScript = path.join(tempBaseDir, "mock_diskutil_fail.sh");
      fs.writeFileSync(mockScript, '#!/bin/sh\necho "Volume is busy" >&2\nexit 1\n', { mode: 0o755 });

      const origAllow = process.env.LIGHTHOUSE_TEST_ALLOW_EJECT_PATH;
      const origBin = process.env.LIGHTHOUSE_DISKUTIL_BIN;

      try {
        process.env.LIGHTHOUSE_TEST_ALLOW_EJECT_PATH = tempBaseDir;
        process.env.LIGHTHOUSE_DISKUTIL_BIN = mockScript;

        const res = ejectKindleVolume(testMount);
        expect(res.success).toBe(false);
        expect(res.message).toBe("Volume is busy");
      } finally {
        if (origAllow !== undefined) {
          process.env.LIGHTHOUSE_TEST_ALLOW_EJECT_PATH = origAllow;
        } else {
          delete process.env.LIGHTHOUSE_TEST_ALLOW_EJECT_PATH;
        }
        if (origBin !== undefined) {
          process.env.LIGHTHOUSE_DISKUTIL_BIN = origBin;
        } else {
          delete process.env.LIGHTHOUSE_DISKUTIL_BIN;
        }
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

    it("POST /api/kindle/cancel responds with JSON cancellation confirmation", async () => {
      const req = new Request("http://127.0.0.1:8086/api/kindle/cancel", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
      });
      const res = await handleRequest(req, localServer);
      expect(res.status).toBe(200);

      const data = (await res.json()) as any;
      expect(data.success).toBe(true);
      expect(data.message).toBe("Sync cancellation requested");
    });

    it("GET /api/kindle/preview returns sync preview metrics", async () => {
      const kindleMount = path.join(fakeVolumesDir, "Kindle");
      fs.mkdirSync(path.join(kindleMount, "books"), { recursive: true });

      const req = new Request("http://127.0.0.1:8086/api/kindle/preview?scope=unread", {
        method: "GET",
      });
      const res = await handleRequest(req, localServer);
      expect(res.status).toBe(200);

      const data = (await res.json()) as any;
      expect(data.detected).toBe(true);
      expect(data).toHaveProperty("pendingCount");
      expect(data).toHaveProperty("pendingBytes");
      expect(data).toHaveProperty("sufficientSpace");
      expect(data).toHaveProperty("requiredBytes");
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

      // Scope Selection & Preview UI
      expect(html).toContain('id="kindleScopeUnreadBtn"');
      expect(html).toContain('id="kindleScopeAllBtn"');
      expect(html).toContain('id="kindlePreviewStats"');
      expect(html).toContain('id="kindleStorageWarning"');
      expect(html).toContain('id="kindleStorageWarningText"');
      expect(html).toContain("Active &amp; Unread");
      expect(html).toContain("All Books");

      // Stop Sync Button
      expect(html).toContain('id="kindleStopSyncBtn"');
      expect(html).toContain("Stop Sync");

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

  describe("6. Deep Recursive Duplicate Detection & Indexing", () => {
    it("buildKindleBookIndex recursively catalogs books in nested subdirectories", () => {
      const kindleMount = path.join(fakeVolumesDir, "Kindle");
      const nestedDir = path.join(kindleMount, "books", "Brandon Sanderson", "Mistborn");
      const docsNestedDir = path.join(kindleMount, "documents", "Sci-Fi", "Frank Herbert");
      fs.mkdirSync(nestedDir, { recursive: true });
      fs.mkdirSync(docsNestedDir, { recursive: true });

      fs.writeFileSync(path.join(nestedDir, "The Final Empire.epub"), "sample content", "utf8");
      fs.writeFileSync(path.join(docsNestedDir, "Dune.mobi"), "dune mobi", "utf8");

      const index = buildKindleBookIndex(kindleMount);
      expect(index.entries.length).toBe(2);
      expect(index.byFilename.has("the final empire.epub")).toBe(true);
      expect(index.byBaseName.has("dune")).toBe(true);
      expect(index.byNormalizedTitle.has("the final empire")).toBe(true);
    });

    it("isBookAlreadyOnKindle detects books across nested subfolders and format variants", () => {
      const kindleMount = path.join(fakeVolumesDir, "Kindle");
      const nestedDir = path.join(kindleMount, "books", "Brandon Sanderson", "The Stormlight Archive");
      const docsDir = path.join(kindleMount, "documents", "Light Novels");
      fs.mkdirSync(nestedDir, { recursive: true });
      fs.mkdirSync(docsDir, { recursive: true });

      // 1. Deeply nested book
      fs.writeFileSync(path.join(nestedDir, "The Way of Kings.epub"), "kings content", "utf8");
      // 2. Format variant (.azw3 instead of .epub)
      fs.writeFileSync(path.join(docsDir, "Overlord Vol 1.azw3"), "overlord content", "utf8");
      // 3. Inverted author - title
      fs.writeFileSync(path.join(kindleMount, "books", "Frank Herbert - Dune.epub"), "dune content", "utf8");

      const index = buildKindleBookIndex(kindleMount);

      // Match deeply nested book with author
      const match1 = isBookAlreadyOnKindle(
        kindleMount,
        "The Way of Kings - Brandon Sanderson.epub",
        "Brandon Sanderson",
        0,
        index,
        { title: "The Way of Kings", authors: "Brandon Sanderson" },
      );
      expect(match1.exists).toBe(true);
      expect(match1.existingPath).toContain("The Way of Kings.epub");

      // Match format variant and volume normalization
      const match2 = isBookAlreadyOnKindle(
        kindleMount,
        "Overlord, Vol. 1 - Kugane Maruyama.epub",
        "Kugane Maruyama",
        0,
        index,
        { title: "Overlord, Vol. 1", authors: "Kugane Maruyama" },
      );
      expect(match2.exists).toBe(true);
      expect(match2.existingPath).toContain("Overlord Vol 1.azw3");

      // Match inverted author - title
      const match3 = isBookAlreadyOnKindle(
        kindleMount,
        "Dune - Frank Herbert.epub",
        "Frank Herbert",
        0,
        index,
        { title: "Dune", authors: "Frank Herbert" },
      );
      expect(match3.exists).toBe(true);
      expect(match3.existingPath).toContain("Frank Herbert - Dune.epub");
    });

    it("NEVER matches different volumes in a series as duplicates (Volume Isolation Regression)", () => {
      const kindleMount = path.join(fakeVolumesDir, "Kindle");
      const docsDir = path.join(kindleMount, "documents", "Light Novels");
      fs.mkdirSync(docsDir, { recursive: true });

      // Kindle has Vol 1 of Overlord and Vol 1 of Sword Art Online
      fs.writeFileSync(path.join(docsDir, "Overlord Vol 1.epub"), "overlord 1", "utf8");
      fs.writeFileSync(path.join(docsDir, "Sword Art Online 01 - Aincrad.epub"), "sao 1", "utf8");

      const index = buildKindleBookIndex(kindleMount);

      // Overlord Vol 2 candidate MUST NOT match Overlord Vol 1
      const matchVol2 = isBookAlreadyOnKindle(
        kindleMount,
        "Overlord, Vol. 2 - Kugane Maruyama.epub",
        "Kugane Maruyama",
        0,
        index,
        { title: "Overlord, Vol. 2", authors: "Kugane Maruyama" },
      );
      expect(matchVol2.exists).toBe(false);

      // Overlord Vol 3 candidate MUST NOT match Overlord Vol 1
      const matchVol3 = isBookAlreadyOnKindle(
        kindleMount,
        "Overlord Vol 3 - Kugane Maruyama.epub",
        "Kugane Maruyama",
        0,
        index,
        { title: "Overlord Vol 3", authors: "Kugane Maruyama" },
      );
      expect(matchVol3.exists).toBe(false);

      // Sword Art Online Vol 2 candidate MUST NOT match SAO Vol 1
      const matchSaoVol2 = isBookAlreadyOnKindle(
        kindleMount,
        "Sword Art Online 02 - Aincrad - Reki Kawahara.epub",
        "Reki Kawahara",
        0,
        index,
        { title: "Sword Art Online, Vol. 2 - Aincrad", authors: "Reki Kawahara" },
      );
      expect(matchSaoVol2.exists).toBe(false);

      // Unnumbered series title MUST NOT match a numbered volume
      const matchUnnumbered = isBookAlreadyOnKindle(
        kindleMount,
        "Overlord - Kugane Maruyama.epub",
        "Kugane Maruyama",
        0,
        index,
        { title: "Overlord", authors: "Kugane Maruyama" },
      );
      expect(matchUnnumbered.exists).toBe(false);
    });

    it("filesize_and_token does not falsely match on weak or empty tokens", () => {
      const kindleMount = path.join(fakeVolumesDir, "Kindle");
      fs.mkdirSync(path.join(kindleMount, "books"), { recursive: true });

      // Unrelated file with 12345 bytes
      const targetFile = path.join(kindleMount, "books", "Unrelated Novel.epub");
      fs.writeFileSync(targetFile, "X".repeat(12345), "utf8");

      const index = buildKindleBookIndex(kindleMount);

      // Candidate with short/weak title/author (length < 4) and same byte size
      const matchWeak = isBookAlreadyOnKindle(
        kindleMount,
        "AB - XY.epub",
        "XY",
        12345,
        index,
        { title: "AB", authors: "XY" },
      );
      expect(matchWeak.exists).toBe(false);
    });

    it("syncAllBooksToKindle skips existing books in nested subdirectories without re-transferring", async () => {
      setupFakeCalibreDatabase([
        { id: 1, title: "Mistborn", author: "Brandon Sanderson", format: "EPUB", fileContent: "calibre mistborn" },
        { id: 2, title: "New Book", author: "New Author", format: "EPUB", fileContent: "new content" },
      ]);

      const kindleMount = path.join(fakeVolumesDir, "Kindle");
      const nestedDir = path.join(kindleMount, "books", "Brandon Sanderson", "Mistborn");
      fs.mkdirSync(nestedDir, { recursive: true });
      fs.writeFileSync(path.join(nestedDir, "Mistborn.epub"), "existing kindle content", "utf8");

      const res = await syncAllBooksToKindle({ mountPath: kindleMount });
      expect(res.success).toBe(true);
      expect(res.totalBooks).toBe(2);
      expect(res.alreadySynced).toBe(1); // Mistborn was detected and skipped!
      expect(res.transferred).toBe(1); // Only New Book was transferred!
    });
  });

  describe("7. Stop Sync & Cancellation Engine", () => {
    it("cancelKindleSync aborts active bulk transfer between books and marks cancelled", async () => {
      setupFakeCalibreDatabase([
        { id: 1, title: "Book One", author: "Author One", format: "EPUB", fileContent: "one" },
        { id: 2, title: "Book Two", author: "Author Two", format: "EPUB", fileContent: "two" },
        { id: 3, title: "Book Three", author: "Author Three", format: "EPUB", fileContent: "three" },
      ]);

      const kindleMount = path.join(fakeVolumesDir, "Kindle");
      fs.mkdirSync(path.join(kindleMount, "books"), { recursive: true });

      // Trigger cancellation on progress callback during transfer of first candidate
      let cancelCalled = false;
      const res = await syncAllBooksToKindle({
        mountPath: kindleMount,
        onProgress: (p) => {
          if (p.transferredCount >= 1 && !cancelCalled) {
            cancelCalled = true;
            const cancelled = cancelKindleSync();
            expect(cancelled).toBe(true);
          }
        },
      });

      expect(res.cancelled).toBe(true);
      expect(res.success).toBe(false);
      expect(res.transferred).toBeLessThan(3);
    });

    it("cancelKindleSync returns false when no sync is actively running", () => {
      const res = cancelKindleSync();
      expect(res).toBe(false);
    });
  });

  describe("8. Pre-Flight Storage Verification & Preview", () => {
    it("previewKindleSync computes pending books, pending bytes, and required reserve", () => {
      setupFakeCalibreDatabase([
        { id: 1, title: "Book One", author: "Author A", format: "EPUB", fileContent: "sample content 1" },
        { id: 2, title: "Book Two", author: "Author B", format: "EPUB", fileContent: "sample content 2" },
      ]);

      const kindleMount = path.join(fakeVolumesDir, "Kindle");
      fs.mkdirSync(path.join(kindleMount, "books"), { recursive: true });

      // Pre-add Book One on Kindle
      fs.writeFileSync(path.join(kindleMount, "books", "Book One - Author A.epub"), "existing", "utf8");

      const preview = previewKindleSync(kindleMount, { scope: "all" });
      expect(preview.detected).toBe(true);
      expect(preview.totalCandidates).toBe(2);
      expect(preview.alreadySyncedCount).toBe(1);
      expect(preview.pendingCount).toBe(1);
      expect(preview.pendingBytes).toBeGreaterThan(0);
      expect(preview.sufficientSpace).toBe(true);
    });

    it("syncAllBooksToKindle halts upfront when storage is insufficient for pending candidates", async () => {
      setupFakeCalibreDatabase([
        { id: 1, title: "Huge Book", author: "Author", format: "EPUB", fileContent: "sample content" },
      ]);

      const kindleMount = path.join(fakeVolumesDir, "Kindle");
      fs.mkdirSync(path.join(kindleMount, "books"), { recursive: true });

      // Set free bytes to a tiny amount (100 bytes) so pending candidate + 50MB reserve exceeds it
      process.env.TEST_KINDLE_FREE_BYTES = "100";
      try {
        const preview = previewKindleSync(kindleMount, { scope: "all" });
        expect(preview.sufficientSpace).toBe(false);
        expect(preview.pendingCount).toBe(1);
        expect(preview.shortfallBytes).toBeGreaterThan(0);

        const res = await syncAllBooksToKindle({ mountPath: kindleMount });
        expect(res.success).toBe(false);
        expect(res.transferred).toBe(0);
        expect(res.errors.length).toBeGreaterThan(0);
        expect(res.errors[0].error).toContain("Insufficient Kindle storage");
      } finally {
        delete process.env.TEST_KINDLE_FREE_BYTES;
      }
    });

    it("storage failure with alreadySynced > 0 returns HTTP 507 and is flagged as error", async () => {
      setupFakeCalibreDatabase([
        { id: 1, title: "Book One", author: "Author One", format: "EPUB", fileContent: "book 1" },
        { id: 2, title: "Book Two", author: "Author Two", format: "EPUB", fileContent: "book 2" },
      ]);

      const kindleMount = path.join(fakeVolumesDir, "Kindle");
      fs.mkdirSync(path.join(kindleMount, "books"), { recursive: true });

      // Pre-add Book One on Kindle so alreadySynced = 1
      fs.writeFileSync(path.join(kindleMount, "books", "Book One - Author One.epub"), "existing", "utf8");

      process.env.TEST_KINDLE_FREE_BYTES = "50";
      try {
        const localServer = { requestIP: () => ({ address: "127.0.0.1" }) };
        const req = new Request("http://127.0.0.1:8086/api/kindle/sync", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ scope: "all" }),
        });
        const res = await handleRequest(req, localServer);
        expect(res.status).toBe(507);

        const data = (await res.json()) as any;
        expect(data.success).toBe(false);
        expect(data.error).toContain("Insufficient Kindle storage");
        expect(data.results.alreadySynced).toBe(1);
        expect(data.results.transferred).toBe(0);
      } finally {
        delete process.env.TEST_KINDLE_FREE_BYTES;
      }
    });
  });

  describe("9. Scope Selection (Active & Unread vs All)", () => {
    it("isBookActiveOrUnread accurately qualifies active and unread books and filters finished", () => {
      // 1. Reading tag
      expect(isBookActiveOrUnread({ title: "Book", tags: ["currently-reading"] })).toBe(true);
      // 2. Finished tag
      expect(isBookActiveOrUnread({ title: "Book", tags: ["finished"] })).toBe(false);
      // 3. KOSync active reading progress (45%)
      const kosyncMap = new Map([
        ["reading book", { progress: 45 }],
        ["finished book", { progress: 100 }],
        ["unread book", { progress: 0 }],
      ]);
      expect(isBookActiveOrUnread({ title: "Reading Book" }, kosyncMap)).toBe(true);
      expect(isBookActiveOrUnread({ title: "Finished Book" }, kosyncMap)).toBe(false);
      expect(isBookActiveOrUnread({ title: "Unread Book" }, kosyncMap)).toBe(true);
      // 4. Untagged book with no KOSync entry defaults to unread (true)
      expect(isBookActiveOrUnread({ title: "Brand New Book" }, kosyncMap)).toBe(true);
    });

    it("getAllKindleCandidates defaults to unread scope and excludes finished books", () => {
      setupFakeCalibreDatabase([
        { id: 1, title: "Active Book", author: "Author A", tags: ["currently-reading"], format: "EPUB", fileContent: "active" },
        { id: 2, title: "Finished Book", author: "Author B", tags: ["finished"], format: "EPUB", fileContent: "done" },
        { id: 3, title: "Untagged New Book", author: "Author C", format: "EPUB", fileContent: "new" },
      ]);

      // Scope omitted -> defaults to unread: Finished Book is excluded!
      const defaultCandidates = getAllKindleCandidates();
      expect(defaultCandidates.length).toBe(2);
      expect(defaultCandidates.map((c) => c.title).sort()).toEqual(["Active Book", "Untagged New Book"]);

      // Scope "all" -> includes all books including Finished Book
      const allCandidates = getAllKindleCandidates({ scope: "all" });
      expect(allCandidates.length).toBe(3);
      expect(allCandidates.map((c) => c.title).sort()).toEqual(["Active Book", "Finished Book", "Untagged New Book"]);
    });

    it("GET /api/kindle/status preserves requested scope preview without clobbering", async () => {
      const kindleMount = path.join(fakeVolumesDir, "Kindle");
      fs.mkdirSync(path.join(kindleMount, "books"), { recursive: true });

      const localServer = { requestIP: () => ({ address: "127.0.0.1" }) };
      const reqAll = new Request("http://127.0.0.1:8086/api/kindle/status?scope=all", { method: "GET" });
      const resAll = await handleRequest(reqAll, localServer);
      expect(resAll.status).toBe(200);
      const dataAll = (await resAll.json()) as any;
      expect(dataAll.preview.scope).toBe("all");

      const reqUnread = new Request("http://127.0.0.1:8086/api/kindle/status?scope=unread", { method: "GET" });
      const resUnread = await handleRequest(reqUnread, localServer);
      expect(resUnread.status).toBe(200);
      const dataUnread = (await resUnread.json()) as any;
      expect(dataUnread.preview.scope).toBe("unread");
    });
  });

  describe("10. Leading Index Stripping, Author Normalization & Jev Ambiguity Arbitration", () => {
    it("matches '01 - Title.epub' on Kindle against Calibre candidate 'Title'", () => {
      const kindleMount = path.join(fakeVolumesDir, "Kindle");
      const booksDir = path.join(kindleMount, "books");
      fs.mkdirSync(booksDir, { recursive: true });

      // File on Kindle with leading index prefix
      fs.writeFileSync(path.join(booksDir, "01 - The Eminence in Shadow.epub"), "content 1", "utf8");

      const index = buildKindleBookIndex(kindleMount);

      // Calibre candidate title without leading index
      const match = isBookAlreadyOnKindle(
        kindleMount,
        "The Eminence in Shadow.epub",
        "",
        0,
        index,
        { title: "The Eminence in Shadow" },
      );
      expect(match.exists).toBe(true);
      expect(match.existingPath).toContain("01 - The Eminence in Shadow.epub");
    });

    it("matches 'Vol. 1 - Overlord.epub' on Kindle against candidate 'Overlord, Vol. 1'", () => {
      const kindleMount = path.join(fakeVolumesDir, "Kindle");
      const booksDir = path.join(kindleMount, "books");
      fs.mkdirSync(booksDir, { recursive: true });

      fs.writeFileSync(path.join(booksDir, "Vol. 1 - Overlord.epub"), "overlord 1", "utf8");

      const index = buildKindleBookIndex(kindleMount);

      const match = isBookAlreadyOnKindle(
        kindleMount,
        "Overlord, Vol. 1 - Kugane Maruyama.epub",
        "Kugane Maruyama",
        0,
        index,
        { title: "Overlord, Vol. 1", authors: "Kugane Maruyama" },
      );
      expect(match.exists).toBe(true);
      expect(match.existingPath).toContain("Vol. 1 - Overlord.epub");
    });

    it("preserves volume isolation: '01 - The Eminence in Shadow.epub' does not match candidate with seriesIndex: 2", () => {
      const kindleMount = path.join(fakeVolumesDir, "Kindle");
      const booksDir = path.join(kindleMount, "books");
      fs.mkdirSync(booksDir, { recursive: true });

      fs.writeFileSync(path.join(booksDir, "01 - The Eminence in Shadow.epub"), "content 1", "utf8");

      const index = buildKindleBookIndex(kindleMount);

      // Candidate Volume 2 must not match Volume 1 on device
      const matchVol2 = isBookAlreadyOnKindle(
        kindleMount,
        "The Eminence in Shadow - Daisuke Aizawa.epub",
        "Daisuke Aizawa",
        0,
        index,
        { title: "The Eminence in Shadow", authors: "Daisuke Aizawa", series: "The Eminence in Shadow", seriesIndex: 2 },
      );
      expect(matchVol2.exists).toBe(false);
    });

    it("matches 'Author, Artist' folder on Kindle against Calibre author 'Author,Artist'", () => {
      const kindleMount = path.join(fakeVolumesDir, "Kindle");
      const authorFolder = path.join(kindleMount, "books", "Fuse, Mitz Vah");
      fs.mkdirSync(authorFolder, { recursive: true });

      fs.writeFileSync(path.join(authorFolder, "Slime Vol 1.epub"), "slime content", "utf8");

      const index = buildKindleBookIndex(kindleMount);

      // Candidate has comma without space in authors: "Fuse,Mitz Vah"
      const match = isBookAlreadyOnKindle(
        kindleMount,
        "Slime Vol 1.epub",
        "Fuse,Mitz Vah",
        0,
        index,
        { title: "Slime Vol 1", authors: "Fuse,Mitz Vah" },
      );
      expect(match.exists).toBe(true);
      expect(match.existingPath).toBe(path.join(authorFolder, "Slime Vol 1.epub"));
    });

    it("resolveKindleDestinationDir reuses existing 'Author, Artist' directory over creating comma-variant folder", () => {
      expect(normalizeAuthorSpacing("Author,Artist")).toBe("Author, Artist");
      expect(normalizeAuthorSpacing("Author , Artist")).toBe("Author, Artist");

      const kindleMount = path.join(fakeVolumesDir, "Kindle");
      const booksDir = path.join(kindleMount, "books");
      const existingDir = path.join(booksDir, "Fuse, Mitz Vah");
      fs.mkdirSync(existingDir, { recursive: true });

      // Request destination with comma-missing author
      const res = resolveKindleDestinationDir(booksDir, "Fuse,Mitz Vah");
      expect(res.authorDir).toBe("Fuse, Mitz Vah");
      expect(res.targetDir).toBe(existingDir);
      expect(res.reusedExistingFolder).toBe(true);

      // When folder doesn't exist, formats with clean comma spacing
      const resNew = resolveKindleDestinationDir(booksDir, "NewAuthor,NewArtist");
      expect(resNew.authorDir).toBe("NewAuthor, NewArtist");
      expect(resNew.reusedExistingFolder).toBe(false);
    });

    it("resolveKindleDestinationDir places book inside existing series subfolder inside author directory", () => {
      const kindleMount = path.join(fakeVolumesDir, "Kindle");
      const booksDir = path.join(kindleMount, "books");
      const authorDir = path.join(booksDir, "Kugane Maruyama");
      const seriesDir = path.join(authorDir, "Overlord");
      fs.mkdirSync(seriesDir, { recursive: true });

      const res = resolveKindleDestinationDir(booksDir, "Kugane Maruyama", "Overlord");
      expect(res.authorDir).toBe("Kugane Maruyama");
      expect(res.seriesDir).toBe("Overlord");
      expect(res.targetDir).toBe(seriesDir);
      expect(res.relativeDir).toBe(path.join("Kugane Maruyama", "Overlord"));
      expect(res.reusedExistingFolder).toBe(true);
    });

    it("isBookAlreadyOnKindleAsync arbitrates ambiguous duplicate using Jev System-1 when similarity is in [0.65, 0.88)", async () => {
      const kindleMount = path.join(fakeVolumesDir, "Kindle");
      const authorDir = path.join(kindleMount, "books", "Tappei Nagatsuki");
      fs.mkdirSync(authorDir, { recursive: true });

      fs.writeFileSync(
        path.join(authorDir, "Re Zero Starting Life in Another World Prologue Chapter.epub"),
        "rezero 1",
        "utf8",
      );

      const index = buildKindleBookIndex(kindleMount);

      // Mock Jev System-1 API response
      const origFetch = globalThis.fetch;
      let jevCalled = false;
      (globalThis as any).fetch = async (url: string, init?: any) => {
        if (typeof url === "string" && url.includes("typesafe.ai")) {
          jevCalled = true;
          return new Response(
            JSON.stringify({
              model: "jev-latest",
              answers: {
                is_duplicate: {
                  choice: "duplicate",
                  confidence: 0.95,
                },
              },
            }),
            { status: 200, headers: { "Content-Type": "application/json" } },
          );
        }
        return origFetch(url as any, init);
      };

      try {
        const result = await isBookAlreadyOnKindleAsync(
          kindleMount,
          "Re Zero Life in Another World - Prologue Arc Edition.epub",
          "Tappei Nagatsuki",
          0,
          index,
          {
            title: "Re Zero Life in Another World - Prologue Arc Edition",
            authors: "Tappei Nagatsuki",
          },
          { jevApiKey: "test-key" },
        );

        expect(jevCalled).toBe(true);
        expect(result.exists).toBe(true);
        expect(result.matchedBy).toBe("jev_system_one");
      } finally {
        globalThis.fetch = origFetch;
      }
    });

    it("isBookAlreadyOnKindleAsync treats non-duplicate when Jev returns isDuplicate: false", async () => {
      const kindleMount = path.join(fakeVolumesDir, "Kindle");
      const authorDir = path.join(kindleMount, "books", "Author A");
      fs.mkdirSync(authorDir, { recursive: true });

      fs.writeFileSync(
        path.join(authorDir, "Similar Title Alpha One.epub"),
        "content a",
        "utf8",
      );

      const index = buildKindleBookIndex(kindleMount);

      const origFetch = globalThis.fetch;
      (globalThis as any).fetch = async (url: string, init?: any) => {
        if (typeof url === "string" && url.includes("typesafe.ai")) {
          return new Response(
            JSON.stringify({
              model: "jev-latest",
              answers: {
                is_duplicate: {
                  choice: "distinct",
                  confidence: 0.95,
                },
              },
            }),
            { status: 200, headers: { "Content-Type": "application/json" } },
          );
        }
        return origFetch(url as any, init);
      };

      try {
        const result = await isBookAlreadyOnKindleAsync(
          kindleMount,
          "Similar Title Beta One.epub",
          "Author A",
          0,
          index,
          {
            title: "Similar Title Beta One",
            authors: "Author A",
          },
          { jevApiKey: "test-key" },
        );

        expect(result.exists).toBe(false);
      } finally {
        globalThis.fetch = origFetch;
      }
    });

    it("isBookAlreadyOnKindleAsync fails open gracefully when Jev API errors or times out", async () => {
      const kindleMount = path.join(fakeVolumesDir, "Kindle");
      const authorDir = path.join(kindleMount, "books", "Author A");
      fs.mkdirSync(authorDir, { recursive: true });

      fs.writeFileSync(
        path.join(authorDir, "Similar Title Alpha One.epub"),
        "content a",
        "utf8",
      );

      const index = buildKindleBookIndex(kindleMount);

      const origFetch = globalThis.fetch;
      (globalThis as any).fetch = async (url: string, init?: any) => {
        if (typeof url === "string" && url.includes("typesafe.ai")) {
          throw new Error("Network timeout or connection refused");
        }
        return origFetch(url as any, init);
      };

      try {
        const result = await isBookAlreadyOnKindleAsync(
          kindleMount,
          "Similar Title Beta One.epub",
          "Author A",
          0,
          index,
          {
            title: "Similar Title Beta One",
            authors: "Author A",
          },
          { jevApiKey: "test-key" },
        );

        // Fails open gracefully without throwing
        expect(result.exists).toBe(false);
      } finally {
        globalThis.fetch = origFetch;
      }
    });

    it("runDotClean purges ._* resource fork ghost files from Kindle books directory", () => {
      const kindleMount = path.join(fakeVolumesDir, "Kindle");
      const booksDir = path.join(kindleMount, "books");
      const authorDir = path.join(booksDir, "Author");
      fs.mkdirSync(authorDir, { recursive: true });

      const realBook = path.join(authorDir, "Book.epub");
      const ghostBook = path.join(authorDir, "._Book.epub");
      const rootGhost = path.join(booksDir, "._Ghost.epub");

      fs.writeFileSync(realBook, "valid content");
      fs.writeFileSync(ghostBook, "resource fork bytes");
      fs.writeFileSync(rootGhost, "root resource fork bytes");

      expect(fs.existsSync(ghostBook)).toBe(true);
      expect(fs.existsSync(rootGhost)).toBe(true);

      const res = runDotClean(booksDir);
      expect(res.success).toBe(true);

      // Ghost files must be removed
      expect(fs.existsSync(ghostBook)).toBe(false);
      expect(fs.existsSync(rootGhost)).toBe(false);
      // Real book must remain intact
      expect(fs.existsSync(realBook)).toBe(true);

      // Verify cleanDotFilesFallback returns 0 when no ghost files remain
      expect(cleanDotFilesFallback(booksDir)).toBe(0);
    });

    it("syncSingleBookToKindle executes post-sync dot_clean", async () => {
      const kindleMount = path.join(fakeVolumesDir, "Kindle");
      const booksDir = path.join(kindleMount, "books");
      fs.mkdirSync(booksDir, { recursive: true });

      setupFakeCalibreDatabase([
        {
          id: 1,
          title: "Clean Book",
          author: "Clean Author",
          format: "EPUB",
          fileContent: "epub content",
        },
      ]);

      // Plant a ghost file in the books directory
      const ghost = path.join(booksDir, "._dirty_fork");
      fs.writeFileSync(ghost, "garbage");
      expect(fs.existsSync(ghost)).toBe(true);

      const res = await syncSingleBookToKindle(1, { mountPath: kindleMount });
      expect(res.success).toBe(true);

      // Post-sync dot_clean must have wiped the ghost file
      expect(fs.existsSync(ghost)).toBe(false);
    });

    it("does not strip year-titled books like '1984 - George Orwell' into author name", () => {
      const kindleMount = path.join(fakeVolumesDir, "Kindle");
      const booksDir = path.join(kindleMount, "books");
      fs.mkdirSync(booksDir, { recursive: true });

      fs.writeFileSync(path.join(booksDir, "1984 - George Orwell.epub"), "orwell 1984", "utf8");

      const index = buildKindleBookIndex(kindleMount);

      // Candidate titled "George Orwell" must NOT match "1984 - George Orwell"
      const falseMatch = isBookAlreadyOnKindle(
        kindleMount,
        "George Orwell.epub",
        "",
        0,
        index,
        { title: "George Orwell" },
      );
      expect(falseMatch.exists).toBe(false);

      // Candidate titled "1984" MUST match
      const trueMatch = isBookAlreadyOnKindle(
        kindleMount,
        "1984 - George Orwell.epub",
        "George Orwell",
        0,
        index,
        { title: "1984", authors: "George Orwell" },
      );
      expect(trueMatch.exists).toBe(true);
    });

    it("previewKindleSync resolves destinations against booksRoot and reuses existing author folders", () => {
      const kindleMount = path.join(fakeVolumesDir, "Kindle");
      const booksDir = path.join(kindleMount, "books");
      const existingAuthor = path.join(booksDir, "Fuse, Mitz Vah");
      fs.mkdirSync(existingAuthor, { recursive: true });

      setupFakeCalibreDatabase([
        {
          id: 1,
          title: "Slime 1",
          author: "Fuse,Mitz Vah",
          format: "EPUB",
          fileContent: "content",
        },
      ]);

      // Existing book is inside the reused folder
      fs.writeFileSync(path.join(existingAuthor, "Slime 1 - Fuse, Mitz Vah.epub"), "content", "utf8");

      const preview = previewKindleSync(kindleMount, { scope: "all" });
      expect(preview.detected).toBe(true);
      expect(preview.alreadySyncedCount).toBe(1);
      expect(preview.pendingCount).toBe(0);
    });

    it("Strategy B base_filename does not cross-match stripped titles across different authors", () => {
      const kindleMount = path.join(fakeVolumesDir, "Kindle");
      const authorA = path.join(kindleMount, "books", "Author A");
      fs.mkdirSync(authorA, { recursive: true });

      // Kindle has "01 - Introduction - Author A.epub"
      fs.writeFileSync(path.join(authorA, "01 - Introduction - Author A.epub"), "intro a", "utf8");

      const index = buildKindleBookIndex(kindleMount);

      // Candidate has stripped base name "Introduction - Author B.epub" but belongs to Author B
      const crossMatch = isBookAlreadyOnKindle(
        kindleMount,
        "Introduction - Author B.epub",
        "Author B",
        0,
        index,
        { title: "Introduction", authors: "Author B" },
      );
      expect(crossMatch.exists).toBe(false);

      // Candidate with Author A matches cleanly
      const sameAuthorMatch = isBookAlreadyOnKindle(
        kindleMount,
        "Introduction - Author A.epub",
        "Author A",
        0,
        index,
        { title: "Introduction", authors: "Author A" },
      );
      expect(sameAuthorMatch.exists).toBe(true);
    });

    it("does not cross-match stripped titles across different authors when filename has no author suffix", () => {
      const kindleMount = path.join(fakeVolumesDir, "Kindle");
      const authorA = path.join(kindleMount, "books", "Author A");
      fs.mkdirSync(authorA, { recursive: true });

      // Kindle has "01 - Introduction.epub" inside Author A folder (no author in filename)
      fs.writeFileSync(path.join(authorA, "01 - Introduction.epub"), "intro a", "utf8");

      const index = buildKindleBookIndex(kindleMount);

      // Candidate belongs to Author B
      const crossMatch = isBookAlreadyOnKindle(
        kindleMount,
        "Introduction.epub",
        "Author B",
        0,
        index,
        { title: "Introduction", authors: "Author B" },
      );
      expect(crossMatch.exists).toBe(false);

      // Candidate with Author A matches cleanly
      const sameAuthorMatch = isBookAlreadyOnKindle(
        kindleMount,
        "Introduction.epub",
        "Author A",
        0,
        index,
        { title: "Introduction", authors: "Author A" },
      );
      expect(sameAuthorMatch.exists).toBe(true);
    });

    it("does not cross-match flat stripped titles when candidate author differs", () => {
      const kindleMount = path.join(fakeVolumesDir, "Kindle");
      const booksDir = path.join(kindleMount, "books");
      fs.mkdirSync(booksDir, { recursive: true });

      // Flat on Kindle: "01 - Introduction.epub" with no author on disk
      fs.writeFileSync(path.join(booksDir, "01 - Introduction.epub"), "intro", "utf8");

      const index = buildKindleBookIndex(kindleMount);

      // Candidate specifying Author B must NOT match flat stripped title
      const crossMatch = isBookAlreadyOnKindle(
        kindleMount,
        "Introduction.epub",
        "Author B",
        0,
        index,
        { title: "Introduction", authors: "Author B" },
      );
      expect(crossMatch.exists).toBe(false);

      // Candidate specifying Author B with seriesIndex=1 must ALSO NOT match flat stripped title
      const crossMatchSeries = isBookAlreadyOnKindle(
        kindleMount,
        "Introduction.epub",
        "Author B",
        0,
        index,
        { title: "Introduction", authors: "Author B", series: "Some Series", seriesIndex: 1 },
      );
      expect(crossMatchSeries.exists).toBe(false);

      // Candidate with no author specified matches cleanly
      const noAuthorMatch = isBookAlreadyOnKindle(
        kindleMount,
        "Introduction.epub",
        "",
        0,
        index,
        { title: "Introduction" },
      );
      expect(noAuthorMatch.exists).toBe(true);
    });

    it("matches format-insensitive titles in series folders without author rejection", () => {
      const kindleMount = path.join(fakeVolumesDir, "Kindle");
      const seriesFolder = path.join(kindleMount, "books", "Cool Series");
      fs.mkdirSync(seriesFolder, { recursive: true });

      // Format-insensitive match inside series folder
      fs.writeFileSync(path.join(seriesFolder, "The Final Empire.azw3"), "empire azw3", "utf8");

      const index = buildKindleBookIndex(kindleMount);

      const match = isBookAlreadyOnKindle(
        kindleMount,
        "The Final Empire.epub",
        "Brandon Sanderson",
        0,
        index,
        { title: "The Final Empire", authors: "Brandon Sanderson" },
      );
      expect(match.exists).toBe(true);
      expect(match.existingPath).toContain("The Final Empire.azw3");
    });

    it("does not false-positive on short-author substring matches (e.g. Ann vs Anne Rice)", () => {
      const kindleMount = path.join(fakeVolumesDir, "Kindle");
      const authorDir = path.join(kindleMount, "books", "Anne Rice");
      fs.mkdirSync(authorDir, { recursive: true });

      fs.writeFileSync(path.join(authorDir, "01 - Blood Canticle.epub"), "vampire", "utf8");

      const index = buildKindleBookIndex(kindleMount);

      // Candidate author "Ann" must NOT match folder "Anne Rice"
      const crossMatch = isBookAlreadyOnKindle(
        kindleMount,
        "Blood Canticle.epub",
        "Ann",
        0,
        index,
        { title: "Blood Canticle", authors: "Ann" },
      );
      expect(crossMatch.exists).toBe(false);

      // Candidate author "Anne Rice" matches cleanly
      const match = isBookAlreadyOnKindle(
        kindleMount,
        "Blood Canticle.epub",
        "Anne Rice",
        0,
        index,
        { title: "Blood Canticle", authors: "Anne Rice" },
      );
      expect(match.exists).toBe(true);
    });

    it("does not false-positive on contiguous author substring matches (e.g. Ed Green vs Fred Greenwood)", () => {
      const kindleMount = path.join(fakeVolumesDir, "Kindle");
      const authorDir = path.join(kindleMount, "books", "Fred Greenwood");
      fs.mkdirSync(authorDir, { recursive: true });

      fs.writeFileSync(path.join(authorDir, "01 - Unique Book.epub"), "content", "utf8");

      const index = buildKindleBookIndex(kindleMount);

      // Candidate author "Ed Green" must NOT match folder "Fred Greenwood"
      const matchEd = isBookAlreadyOnKindle(
        kindleMount,
        "Unique Book.epub",
        "Ed Green",
        0,
        index,
        { title: "Unique Book", authors: "Ed Green" },
      );
      expect(matchEd.exists).toBe(false);

      // Candidate author "Fred Green" must NOT match folder "Fred Greenwood"
      const matchFred = isBookAlreadyOnKindle(
        kindleMount,
        "Unique Book.epub",
        "Fred Green",
        0,
        index,
        { title: "Unique Book", authors: "Fred Green" },
      );
      expect(matchFred.exists).toBe(false);

      // Exact author "Fred Greenwood" matches cleanly
      const matchExact = isBookAlreadyOnKindle(
        kindleMount,
        "Unique Book.epub",
        "Fred Greenwood",
        0,
        index,
        { title: "Unique Book", authors: "Fred Greenwood" },
      );
      expect(matchExact.exists).toBe(true);
    });

    it("matches multi-author lists across diverse delimiters (&, and, comma)", () => {
      const kindleMount = path.join(fakeVolumesDir, "Kindle");
      const authorDir = path.join(kindleMount, "books", "Brandon Sanderson");
      fs.mkdirSync(authorDir, { recursive: true });

      fs.writeFileSync(path.join(authorDir, "White Sand.epub"), "white sand", "utf8");

      const index = buildKindleBookIndex(kindleMount);

      // Candidate with "Brandon Sanderson & Isaac Stewart" matches on-disk "Brandon Sanderson"
      const matchAmpersand = isBookAlreadyOnKindle(
        kindleMount,
        "White Sand.epub",
        "Brandon Sanderson & Isaac Stewart",
        0,
        index,
        { title: "White Sand", authors: "Brandon Sanderson & Isaac Stewart" },
      );
      expect(matchAmpersand.exists).toBe(true);

      // Candidate with "Brandon Sanderson, Isaac Stewart" matches on-disk "Brandon Sanderson"
      const matchComma = isBookAlreadyOnKindle(
        kindleMount,
        "White Sand.epub",
        "Brandon Sanderson, Isaac Stewart",
        0,
        index,
        { title: "White Sand", authors: "Brandon Sanderson, Isaac Stewart" },
      );
      expect(matchComma.exists).toBe(true);
    });
  });
});
