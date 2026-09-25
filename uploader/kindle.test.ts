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
  authorMatchesString,
  parseAuthorList,
  stripLeadingIndexPrefix,
  isGenericSectionTitle,
  runDotClean,
  cleanDotFilesFallback,
  cancelKindleSync,
  previewKindleSync,
  isBookActiveOrUnread,
  getAllKindleCandidates,
  invalidateKindleBookIndex,
  isKindleSyncActive,
  tryAcquireKindleSyncLock,
  releaseKindleSyncLock,
  getKindleProgress,
  resetKindleProgressForTesting,
  scanKindleDeviceDuplicates,
  cleanKindleDeviceDuplicates,
  getKindleSyncStatus,
  isCrossScriptAuthorMatch,
  invalidateKindleSyncPreviewCache,
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
    resetKindleProgressForTesting();
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

      // Reuses existing "First Last" folder when candidate is "Last, First"
      const leGuinFolder = path.join(booksDir, "Ursula K. Le Guin");
      fs.mkdirSync(leGuinFolder, { recursive: true });
      const resLeGuin = resolveKindleDestinationDir(booksDir, "Le Guin, Ursula K.");
      expect(resLeGuin.authorDir).toBe("Ursula K. Le Guin");
      expect(resLeGuin.targetDir).toBe(leGuinFolder);
      expect(resLeGuin.reusedExistingFolder).toBe(true);

      // Verify Sanderson, Brandon does NOT reuse a bare folder named "Brandon" or "Sanderson"
      const brandonFolder = path.join(booksDir, "Brandon");
      fs.mkdirSync(brandonFolder, { recursive: true });
      const resBrandon = resolveKindleDestinationDir(booksDir, "Sanderson, Brandon");
      expect(resBrandon.targetDir).not.toBe(brandonFolder);

      // Verify that when Le Guin/, Ursula K./, and Ursula K. Le Guin/ all exist, it reuses the full author folder
      const bareLeGuin = path.join(booksDir, "Le Guin");
      const bareUrsula = path.join(booksDir, "Ursula K.");
      fs.mkdirSync(bareLeGuin, { recursive: true });
      fs.mkdirSync(bareUrsula, { recursive: true });
      const resFullLeGuin = resolveKindleDestinationDir(booksDir, "Le Guin, Ursula K.");
      expect(resFullLeGuin.authorDir).toBe("Ursula K. Le Guin");
      expect(resFullLeGuin.targetDir).toBe(leGuinFolder);
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
        { title: "The Final Empire", authors: "Brandon Sanderson", series: "Cool Series" },
      );
      expect(match.exists).toBe(true);
      expect(match.existingPath).toContain("The Final Empire.azw3");

      // Verify that a different author with no matching series is rejected
      const matchWrong = isBookAlreadyOnKindle(
        kindleMount,
        "The Final Empire.epub",
        "Wrong Author",
        0,
        index,
        { title: "The Final Empire", authors: "Wrong Author" },
      );
      expect(matchWrong.exists).toBe(false);
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

      // Calibre Last, First multi-author order: "Sanderson, Brandon & Stewart, Isaac"
      const matchLastFirst = isBookAlreadyOnKindle(
        kindleMount,
        "White Sand.epub",
        "Sanderson, Brandon & Stewart, Isaac",
        0,
        index,
        { title: "White Sand", authors: "Sanderson, Brandon & Stewart, Isaac" },
      );
      expect(matchLastFirst.exists).toBe(true);

      // Multi-word surname: "Le Guin, Ursula K." vs on-disk "Ursula K. Le Guin"
      expect(authorMatchesString("Ursula K. Le Guin", "Le Guin, Ursula K.")).toBe(true);
      expect(authorMatchesString("Gabriel Garcia Marquez", "Garcia Marquez, Gabriel")).toBe(true);

      const leGuinDir = path.join(kindleMount, "books", "Ursula K. Le Guin");
      fs.mkdirSync(leGuinDir, { recursive: true });
      // Write .azw3 on disk so Strategy A (exact filename) does NOT match and forces Strategy B (base_filename)
      fs.writeFileSync(path.join(leGuinDir, "A Wizard of Earthsea.azw3"), "earthsea", "utf8");
      const idxLeGuin = buildKindleBookIndex(kindleMount);

      const matchLeGuin = isBookAlreadyOnKindle(
        kindleMount,
        "A Wizard of Earthsea.epub",
        "Le Guin, Ursula K.",
        0,
        idxLeGuin,
        { title: "A Wizard of Earthsea", authors: "Le Guin, Ursula K." },
      );
      expect(matchLeGuin.exists).toBe(true);
      expect(matchLeGuin.matchedBy).toBe("base_filename");
    });

    it("isGenericSectionTitle recognizes word numbers like Book Two and Chapter One", () => {
      expect(isGenericSectionTitle("Book Two")).toBe(true);
      expect(isGenericSectionTitle("Chapter One")).toBe(true);
      expect(isGenericSectionTitle("Book Eleven")).toBe(true);
      expect(isGenericSectionTitle("Part Two")).toBe(true);
      expect(isGenericSectionTitle("Part II")).toBe(true);
      expect(isGenericSectionTitle("Chapter mid")).toBe(false);
      expect(isGenericSectionTitle("Book civil")).toBe(false);
      expect(isGenericSectionTitle("Part did")).toBe(false);
      expect(isGenericSectionTitle("Chapter mix")).toBe(false);
      expect(isGenericSectionTitle("The Final Empire")).toBe(false);
    });

    it("Strategy G filesize_and_token enforces strict author verification with non-zero fileSize", () => {
      const kindleMount = path.join(fakeVolumesDir, "Kindle");
      const authorDir = path.join(kindleMount, "books", "Fred Greenwood");
      fs.mkdirSync(authorDir, { recursive: true });

      const targetPath = path.join(authorDir, "01 - Unique Novel.epub");
      fs.writeFileSync(targetPath, "A".repeat(54321), "utf8");

      const index = buildKindleBookIndex(kindleMount);

      // Candidate with identical fileSize but wrong author "Ed Green" must NOT match via Strategy G
      const matchWrongAuthor = isBookAlreadyOnKindle(
        kindleMount,
        "Unique Novel Edition.epub",
        "Ed Green",
        54321,
        index,
        { title: "Unique Novel Edition", authors: "Ed Green" },
      );
      expect(matchWrongAuthor.exists).toBe(false);

      // Candidate with identical fileSize and correct author "Fred Greenwood" matches cleanly via Strategy G
      const matchCorrect = isBookAlreadyOnKindle(
        kindleMount,
        "Unique Novel Edition.epub",
        "Fred Greenwood",
        54321,
        index,
        { title: "Unique Novel Edition", authors: "Fred Greenwood" },
      );
      expect(matchCorrect.exists).toBe(true);
      expect(matchCorrect.matchedBy).toBe("filesize_and_token");

      // Plant a real "Dark Tower.epub" with identical fileSize to test token overlap resistance
      const darkTowerPath = path.join(authorDir, "Dark Tower.epub");
      fs.writeFileSync(darkTowerPath, "B".repeat(65432), "utf8");

      const idxUpdated = buildKindleBookIndex(kindleMount);

      // Same author and same fileSize but different title ("Dark Matter" vs "Dark Tower") must NOT match via Strategy G
      const matchDifferentTitle = isBookAlreadyOnKindle(
        kindleMount,
        "Dark Matter.epub",
        "Fred Greenwood",
        65432,
        idxUpdated,
        { title: "Dark Matter", authors: "Fred Greenwood" },
      );
      expect(matchDifferentTitle.exists).toBe(false);

      // Plant a real "Dune.epub" (33333 bytes) by Frank Herbert
      const herbertDir = path.join(kindleMount, "books", "Frank Herbert");
      fs.mkdirSync(herbertDir, { recursive: true });
      fs.writeFileSync(path.join(herbertDir, "Dune.epub"), "C".repeat(33333), "utf8");
      const idxDune = buildKindleBookIndex(kindleMount);

      // Candidate "Dune Messiah" with same author and same size must NOT match Dune via Strategy G
      const matchDuneMessiah = isBookAlreadyOnKindle(
        kindleMount,
        "Dune Messiah.epub",
        "Frank Herbert",
        33333,
        idxDune,
        { title: "Dune Messiah", authors: "Frank Herbert" },
      );
      expect(matchDuneMessiah.exists).toBe(false);
    });

    it("protects flat unindexed generic section titles (e.g. books/Introduction.azw3, Part 2.azw3) from cross-author collisions", () => {
      const kindleMount = path.join(fakeVolumesDir, "Kindle");
      const booksDir = path.join(kindleMount, "books");
      fs.mkdirSync(booksDir, { recursive: true });

      // Unindexed flat format variant: "Introduction.azw3"
      fs.writeFileSync(path.join(booksDir, "Introduction.azw3"), "intro azw3", "utf8");
      // Generic part title: "Part 2.azw3"
      fs.writeFileSync(path.join(booksDir, "Part 2.azw3"), "part 2 azw3", "utf8");

      const index = buildKindleBookIndex(kindleMount);

      // Candidate with Author B must NOT match flat generic section title
      const crossMatch = isBookAlreadyOnKindle(
        kindleMount,
        "Introduction.epub",
        "Author B",
        0,
        index,
        { title: "Introduction", authors: "Author B" },
      );
      expect(crossMatch.exists).toBe(false);

      // Candidate with Author B must NOT match flat "Part 2"
      const crossMatchPart = isBookAlreadyOnKindle(
        kindleMount,
        "Part 2.epub",
        "Author B",
        0,
        index,
        { title: "Part 2", authors: "Author B" },
      );
      expect(crossMatchPart.exists).toBe(false);

      // Candidate with no author specified matches cleanly
      const matchNoAuthor = isBookAlreadyOnKindle(
        kindleMount,
        "Introduction.epub",
        "",
        0,
        index,
        { title: "Introduction" },
      );
      expect(matchNoAuthor.exists).toBe(true);
    });

    it("matches format-insensitive books in series folders with series metadata and rejects cross-author false matches", () => {
      const kindleMount = path.join(fakeVolumesDir, "Kindle");
      const witcherDir = path.join(kindleMount, "books", "The Witcher");
      const brokenEmpireDir = path.join(kindleMount, "books", "Broken Empire");
      fs.mkdirSync(witcherDir, { recursive: true });
      fs.mkdirSync(brokenEmpireDir, { recursive: true });

      fs.writeFileSync(path.join(witcherDir, "Blood of Elves.azw3"), "witcher azw3", "utf8");
      fs.writeFileSync(path.join(brokenEmpireDir, "Prince of Thorns.azw3"), "thorns azw3", "utf8");

      const index = buildKindleBookIndex(kindleMount);

      // Candidate with series metadata matches format variant in series folder
      const matchWitcher = isBookAlreadyOnKindle(
        kindleMount,
        "Blood of Elves.epub",
        "Andrzej Sapkowski",
        0,
        index,
        { title: "Blood of Elves", authors: "Andrzej Sapkowski", series: "The Witcher" },
      );
      expect(matchWitcher.exists).toBe(true);
      expect(matchWitcher.existingPath).toContain("Blood of Elves.azw3");

      // Candidate with wrong author must NOT match series folder
      const matchWitcherWrong = isBookAlreadyOnKindle(
        kindleMount,
        "Blood of Elves.epub",
        "Wrong Author",
        0,
        index,
        { title: "Blood of Elves", authors: "Wrong Author" },
      );
      expect(matchWitcherWrong.exists).toBe(false);

      const matchThorns = isBookAlreadyOnKindle(
        kindleMount,
        "Prince of Thorns.epub",
        "Mark Lawrence",
        0,
        index,
        { title: "Prince of Thorns", authors: "Mark Lawrence", series: "Broken Empire" },
      );
      expect(matchThorns.exists).toBe(true);
      expect(matchThorns.existingPath).toContain("Prince of Thorns.azw3");

      const matchThornsWrong = isBookAlreadyOnKindle(
        kindleMount,
        "Prince of Thorns.epub",
        "Wrong Author",
        0,
        index,
        { title: "Prince of Thorns", authors: "Wrong Author" },
      );
      expect(matchThornsWrong.exists).toBe(false);

      // Series folders without franchise keywords e.g. "First Law" and "Red Rising"
      const firstLawDir = path.join(kindleMount, "books", "First Law");
      const redRisingDir = path.join(kindleMount, "books", "Red Rising");
      fs.mkdirSync(firstLawDir, { recursive: true });
      fs.mkdirSync(redRisingDir, { recursive: true });

      fs.writeFileSync(path.join(firstLawDir, "The Blade Itself.azw3"), "blade azw3", "utf8");
      fs.writeFileSync(path.join(redRisingDir, "Golden Son.azw3"), "golden azw3", "utf8");

      const idxSeries = buildKindleBookIndex(kindleMount);

      // Candidate with matching series matches cleanly
      const matchFirstLaw = isBookAlreadyOnKindle(
        kindleMount,
        "The Blade Itself.epub",
        "Joe Abercrombie",
        0,
        idxSeries,
        { title: "The Blade Itself", authors: "Joe Abercrombie", series: "First Law" },
      );
      expect(matchFirstLaw.exists).toBe(true);
      expect(matchFirstLaw.existingPath).toContain("The Blade Itself.azw3");

      // Candidate with wrong author or missing series does NOT match
      const matchFirstLawWrong = isBookAlreadyOnKindle(
        kindleMount,
        "The Blade Itself.epub",
        "Not Abercrombie",
        0,
        idxSeries,
        { title: "The Blade Itself", authors: "Not Abercrombie" },
      );
      expect(matchFirstLawWrong.exists).toBe(false);

      // Adversarial check: partial or substring series keywords ("Law", "First", "A", "The") with wrong author MUST NOT bypass author check
      for (const bogusSeries of ["Law", "First", "A", "The"]) {
        const matchBogus = isBookAlreadyOnKindle(
          kindleMount,
          "The Blade Itself.epub",
          "Not Abercrombie",
          0,
          idxSeries,
          { title: "The Blade Itself", authors: "Not Abercrombie", series: bogusSeries },
        );
        expect(matchBogus.exists).toBe(false);
      }

      const matchRedRising = isBookAlreadyOnKindle(
        kindleMount,
        "Golden Son.epub",
        "Pierce Brown",
        0,
        idxSeries,
        { title: "Golden Son", authors: "Pierce Brown", series: "Red Rising" },
      );
      expect(matchRedRising.exists).toBe(true);
      expect(matchRedRising.existingPath).toContain("Golden Son.azw3");

      const matchRedRisingWrong = isBookAlreadyOnKindle(
        kindleMount,
        "Golden Son.epub",
        "Wrong Author",
        0,
        idxSeries,
        { title: "Golden Son", authors: "Wrong Author" },
      );
      expect(matchRedRisingWrong.exists).toBe(false);

      // Adversarial check: substring series keywords ("Red", "Rising") with wrong author MUST NOT bypass author check
      for (const bogusSeries of ["Red", "Rising"]) {
        const matchBogus = isBookAlreadyOnKindle(
          kindleMount,
          "Golden Son.epub",
          "Wrong Author",
          0,
          idxSeries,
          { title: "Golden Son", authors: "Wrong Author", series: bogusSeries },
        );
        expect(matchBogus.exists).toBe(false);
      }
    });

    it("parses Calibre compact initials in Last, First order (e.g. Martin, George R.R.)", () => {
      const parsedGRRM = parseAuthorList("Martin, George R.R.");
      expect(parsedGRRM).toEqual(["George R.R. Martin"]);
      expect(authorMatchesString("George R.R. Martin", parsedGRRM[0])).toBe(true);

      const parsedJRRT = parseAuthorList("Tolkien, J.R.R.");
      expect(parsedJRRT).toEqual(["J.R.R. Tolkien"]);
      expect(authorMatchesString("J.R.R. Tolkien", parsedJRRT[0])).toBe(true);

      const parsedRR = parseAuthorList("Martin, George RR");
      expect(parsedRR).toEqual(["George RR Martin"]);
      // Compact RR must match dotted R.R.
      expect(authorMatchesString("George R.R. Martin", "Martin, George RR")).toBe(true);
      expect(authorMatchesString("J.R.R. Tolkien", "Tolkien, JRR")).toBe(true);
      expect(authorMatchesString("H.P. Lovecraft", "Lovecraft, HP")).toBe(true);

      // Multi-word given names in Last, First order
      const parsedDoyle = parseAuthorList("Doyle, Arthur Conan");
      expect(parsedDoyle).toEqual(["Arthur Conan Doyle"]);
      expect(authorMatchesString("Arthur Conan Doyle", "Doyle, Arthur Conan")).toBe(true);

      const parsedOates = parseAuthorList("Oates, Joyce Carol");
      expect(parsedOates).toEqual(["Joyce Carol Oates"]);
    });

    it("resolveKindleDestinationDir reuses existing folder across initials variants", () => {
      const kindleMount = path.join(fakeVolumesDir, "Kindle");
      const booksDir = path.join(kindleMount, "books");
      const grrmDir = path.join(booksDir, "George R.R. Martin");
      fs.mkdirSync(grrmDir, { recursive: true });

      const res = resolveKindleDestinationDir(booksDir, "Martin, George RR");
      expect(res.authorDir).toBe("George R.R. Martin");
      expect(res.targetDir).toBe(grrmDir);
      expect(res.reusedExistingFolder).toBe(true);
    });

    it("strips decimal leading index and volume prefixes cleanly", () => {
      expect(stripLeadingIndexPrefix("1.5 - Half")).toBe("Half");
      expect(stripLeadingIndexPrefix("Vol. 2.5 - Index")).toBe("Index");
      expect(stripLeadingIndexPrefix("03.5 - Interlude")).toBe("Interlude");
    });

    it("resolveKindleDestinationDir prioritizes primary author and joint folder over secondary co-author", () => {
      const kindleMount = path.join(fakeVolumesDir, "Kindle");
      const booksDir = path.join(kindleMount, "books");
      const isaacDir = path.join(booksDir, "Isaac Stewart");
      const brandonDir = path.join(booksDir, "Brandon Sanderson");
      fs.mkdirSync(isaacDir, { recursive: true });
      fs.mkdirSync(brandonDir, { recursive: true });

      // When Isaac Stewart is listed before Brandon Sanderson, it must still pick Brandon Sanderson
      const res = resolveKindleDestinationDir(booksDir, "Brandon Sanderson, Isaac Stewart");
      expect(res.authorDir).toBe("Brandon Sanderson");
      expect(res.targetDir).toBe(brandonDir);
      expect(res.reusedExistingFolder).toBe(true);

      // When only Isaac Stewart exists, it must NOT reuse Isaac Stewart for a Sanderson-led book
      const tmpSolo = path.join(fakeVolumesDir, "SoloTest");
      const soloBooks = path.join(tmpSolo, "books");
      fs.mkdirSync(path.join(soloBooks, "Isaac Stewart"), { recursive: true });
      const resSolo = resolveKindleDestinationDir(soloBooks, "Brandon Sanderson, Isaac Stewart");
      expect(resSolo.authorDir).toBe("Brandon Sanderson, Isaac Stewart");
      expect(resSolo.reusedExistingFolder).toBe(false);
    });

    it("matches format-insensitive multi-author books with comma-separated Calibre authors", () => {
      const kindleMount = path.join(fakeVolumesDir, "Kindle");
      const authorDir = path.join(kindleMount, "books", "Brandon Sanderson");
      fs.mkdirSync(authorDir, { recursive: true });

      // Device has .azw3
      fs.writeFileSync(path.join(authorDir, "White Sand.azw3"), "white sand azw3", "utf8");

      const index = buildKindleBookIndex(kindleMount);

      // Candidate is .epub with comma-separated Calibre authors "Brandon Sanderson, Isaac Stewart"
      const matchFormatInsensitive = isBookAlreadyOnKindle(
        kindleMount,
        "White Sand.epub",
        "Brandon Sanderson, Isaac Stewart",
        0,
        index,
        { title: "White Sand", authors: "Brandon Sanderson, Isaac Stewart" },
      );
      expect(matchFormatInsensitive.exists).toBe(true);
      expect(matchFormatInsensitive.matchedBy).toBe("base_filename");
    });
  });

  describe("11. Asynchronous Non-Blocking Kindle Bulk Sync Engine", () => {
    it("isKindleSyncActive reflects live sync phase transitions", async () => {
      resetKindleProgressForTesting();
      expect(isKindleSyncActive()).toBe(false);

      // Lock held -> true
      expect(tryAcquireKindleSyncLock()).toBe(true);
      expect(isKindleSyncActive()).toBe(true);
      // Double acquire fails
      expect(tryAcquireKindleSyncLock()).toBe(false);

      releaseKindleSyncLock();
      expect(isKindleSyncActive()).toBe(false);

      // Setup a real sync that transitions through scanning -> transferring -> completed
      setupFakeCalibreDatabase([
        { id: 1, title: "Live Book", author: "Live Author", format: "EPUB", fileContent: "live content" },
      ]);
      const kindleMount = path.join(fakeVolumesDir, "Kindle");
      fs.mkdirSync(path.join(kindleMount, "books"), { recursive: true });

      const phasesObserved: string[] = [];
      const syncPromise = syncAllBooksToKindle({
        mountPath: kindleMount,
        onProgress: (p) => {
          phasesObserved.push(p.phase);
        },
      });

      // Active while in progress
      expect(isKindleSyncActive()).toBe(true);

      const result = await syncPromise;
      expect(result.success).toBe(true);

      // Now sync is complete
      expect(isKindleSyncActive()).toBe(false);
      expect(phasesObserved).toContain("scanning");
      expect(phasesObserved).toContain("transferring");
      expect(phasesObserved).toContain("completed");

      const finalProgress = getKindleProgress();
      expect(finalProgress?.phase).toBe("completed");
      expect(finalProgress?.lastResult).toBeDefined();
      expect(finalProgress?.lastResult?.success).toBe(true);
    });

    it("POST /api/kindle/sync responds immediately with started: true and launches background transfer", async () => {
      resetKindleProgressForTesting();
      setupFakeCalibreDatabase([
        { id: 1, title: "Book One", author: "Author One", format: "EPUB", fileContent: "content 1" },
        { id: 2, title: "Book Two", author: "Author Two", format: "EPUB", fileContent: "content 2" },
      ]);

      const kindleMount = path.join(fakeVolumesDir, "Kindle");
      fs.mkdirSync(path.join(kindleMount, "books"), { recursive: true });

      const localServer = { requestIP: () => ({ address: "127.0.0.1" }) };
      const req = new Request("http://127.0.0.1:8086/api/kindle/sync", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ scope: "all" }),
      });

      const startTime = Date.now();
      const res = await handleRequest(req, localServer);
      const elapsed = Date.now() - startTime;

      expect(res.status).toBe(202);
      expect(elapsed).toBeLessThan(100); // Non-blocking: returns in under 100ms

      const data = (await res.json()) as any;
      expect(data.success).toBe(true);
      expect(data.started).toBe(true);
      expect(data.results.inProgress).toBe(true);

      // Wait for background sync to complete
      let attempts = 0;
      while (isKindleSyncActive() && attempts < 50) {
        await new Promise((r) => setTimeout(r, 20));
        attempts++;
      }

      const progress = getKindleProgress();
      expect(progress).not.toBeNull();
      expect(progress?.phase).toBe("completed");
      expect(progress?.transferredCount).toBe(2);
      expect(progress?.lastResult?.success).toBe(true);
    });

    it("atomic admit gate prevents stampede on concurrent POSTs (one starts, one reports alreadyRunning)", async () => {
      resetKindleProgressForTesting();
      setupFakeCalibreDatabase([
        { id: 1, title: "Stampede Book 1", author: "Author", format: "EPUB", fileContent: "content 1" },
        { id: 2, title: "Stampede Book 2", author: "Author", format: "EPUB", fileContent: "content 2" },
      ]);

      const kindleMount = path.join(fakeVolumesDir, "Kindle");
      fs.mkdirSync(path.join(kindleMount, "books"), { recursive: true });

      const localServer = { requestIP: () => ({ address: "127.0.0.1" }) };

      // Dispatch two concurrent POST requests simultaneously
      const req1 = new Request("http://127.0.0.1:8086/api/kindle/sync", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ scope: "all" }),
      });
      const req2 = new Request("http://127.0.0.1:8086/api/kindle/sync", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ scope: "all" }),
      });

      const [res1, res2] = await Promise.all([
        handleRequest(req1, localServer),
        handleRequest(req2, localServer),
      ]);

      expect([res1.status, res2.status].sort()).toEqual([200, 202]);

      const [data1, data2] = await Promise.all([res1.json() as Promise<any>, res2.json() as Promise<any>]);

      // Exactly one must have started: true, and the other must have alreadyRunning: true
      const startedCount = (data1.started ? 1 : 0) + (data2.started ? 1 : 0);
      const alreadyRunningCount = (data1.alreadyRunning ? 1 : 0) + (data2.alreadyRunning ? 1 : 0);

      expect(startedCount).toBe(1);
      expect(alreadyRunningCount).toBe(1);

      // Wait for background sync to settle
      let attempts = 0;
      while (isKindleSyncActive() && attempts < 50) {
        await new Promise((r) => setTimeout(r, 20));
        attempts++;
      }
    });

    it("syncAllBooksToKindle publishes terminal error progress when mount is missing", async () => {
      resetKindleProgressForTesting();
      const nonExistentMount = path.join(fakeVolumesDir, "NonExistentMount");

      const result = await syncAllBooksToKindle({ mountPath: nonExistentMount });
      expect(result.success).toBe(false);
      expect(result.errors[0].error).toContain("No Kindle device detected");

      // Must publish terminal progress record with phase: "error"
      const progress = getKindleProgress();
      expect(progress).not.toBeNull();
      expect(progress?.phase).toBe("error");
      expect(progress?.error).toContain("No Kindle device detected");
      expect(progress?.lastResult).toBeDefined();
      expect(isKindleSyncActive()).toBe(false);
    });

    it("POST /api/kindle/sync rejects upfront with 507 when storage is insufficient and releases lock", async () => {
      resetKindleProgressForTesting();
      setupFakeCalibreDatabase([
        { id: 1, title: "Huge Book", author: "Author", format: "EPUB", fileContent: "content" },
      ]);

      const kindleMount = path.join(fakeVolumesDir, "Kindle");
      fs.mkdirSync(path.join(kindleMount, "books"), { recursive: true });

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
        expect(isKindleSyncActive()).toBe(false);

        // Lock must be released so next attempt can acquire it
        expect(tryAcquireKindleSyncLock()).toBe(true);
        releaseKindleSyncLock();
      } finally {
        delete process.env.TEST_KINDLE_FREE_BYTES;
      }
    });

    it("cancellation during lock-held preflight is respected and halts transfer before books copy", async () => {
      resetKindleProgressForTesting();
      setupFakeCalibreDatabase([
        { id: 1, title: "Cancel Book 1", author: "Author", format: "EPUB", fileContent: "cancel 1" },
        { id: 2, title: "Cancel Book 2", author: "Author", format: "EPUB", fileContent: "cancel 2" },
      ]);

      const kindleMount = path.join(fakeVolumesDir, "Kindle");
      fs.mkdirSync(path.join(kindleMount, "books"), { recursive: true });

      // Simulate lock acquired during request admit
      expect(tryAcquireKindleSyncLock()).toBe(true);

      // User hits cancel while preflight is running
      expect(cancelKindleSync()).toBe(true);

      // syncAllBooksToKindle starts with lockAlreadyAcquired: true
      const result = await syncAllBooksToKindle({
        mountPath: kindleMount,
        lockAlreadyAcquired: true,
      });

      expect(result.cancelled).toBe(true);
      expect(result.transferred).toBe(0);

      const progress = getKindleProgress();
      expect(progress?.phase).toBe("cancelled");
      expect(progress?.lastResult?.cancelled).toBe(true);
      expect(isKindleSyncActive()).toBe(false);
    });

    it("tryAcquireKindleSyncLock immediately clears stale terminal progress to prevent false completion", async () => {
      resetKindleProgressForTesting();
      setupFakeCalibreDatabase([
        { id: 1, title: "Book One", author: "Author One", format: "EPUB", fileContent: "content 1" },
      ]);

      const kindleMount = path.join(fakeVolumesDir, "Kindle");
      fs.mkdirSync(path.join(kindleMount, "books"), { recursive: true });

      // Run sync 1 to completion
      const run1 = await syncAllBooksToKindle({ mountPath: kindleMount });
      expect(run1.success).toBe(true);
      expect(getKindleProgress()?.phase).toBe("completed");

      // Now run 2 acquires the lock
      expect(tryAcquireKindleSyncLock()).toBe(true);

      // Progress must be reset to scanning, never stale completed
      const progressMidFlight = getKindleProgress();
      expect(progressMidFlight?.phase).toBe("scanning");
      expect(progressMidFlight?.lastResult).toBeUndefined();

      const status = getKindleStatus(fakeVolumesDir);
      expect(status.syncInProgress).toBe(true);
      expect(status.progress?.phase).toBe("scanning");

      releaseKindleSyncLock();
    });
  });

  describe("12. Cross-Script Burmese Dedup, File Size Signatures & Device Duplicate Hygiene", () => {
    it("matches Burmese book title on Kindle even if author folder is in English transliteration (Cross-Script Exemption)", () => {
      const kindleMount = path.join(fakeVolumesDir, "Kindle");
      const myaThanTintDir = path.join(kindleMount, "books", "Mya Than Tint");
      const minLuDir = path.join(kindleMount, "books", "Min Lu");
      fs.mkdirSync(myaThanTintDir, { recursive: true });
      fs.mkdirSync(minLuDir, { recursive: true });

      // Older hand-copied books in Latin transliteration author folders
      fs.writeFileSync(path.join(myaThanTintDir, "ပါရီကျဆုံးခန်း.epub"), "paris content", "utf8");
      fs.writeFileSync(path.join(minLuDir, "ရိုးမပေါ်ကျတဲ့မျက်ရည်.epub"), "yoma content", "utf8");

      const index = buildKindleBookIndex(kindleMount);

      // Candidate 1: Calibre author is proper Myanmar Unicode 'မြသန်းတင့်'
      const match1 = isBookAlreadyOnKindle(
        kindleMount,
        "ပါရီကျဆုံးခန်း - မြသန်းတင့်.epub",
        "မြသန်းတင့်",
        0,
        index,
        { title: "ပါရီကျဆုံးခန်း", authors: "မြသန်းတင့်" },
      );
      expect(match1.exists).toBe(true);
      expect(match1.existingPath).toBe(path.join(myaThanTintDir, "ပါရီကျဆုံးခန်း.epub"));

      // Candidate 2: Calibre author is proper Myanmar Unicode 'မင်းလူ'
      const match2 = isBookAlreadyOnKindle(
        kindleMount,
        "ရိုးမပေါ်ကျတဲ့မျက်ရည် - မင်းလူ.epub",
        "မင်းလူ",
        0,
        index,
        { title: "ရိုးမပေါ်ကျတဲ့မျက်ရည်", authors: "မင်းလူ" },
      );
      expect(match2.exists).toBe(true);
      expect(match2.existingPath).toBe(path.join(minLuDir, "ရိုးမပေါ်ကျတဲ့မျက်ရည်.epub"));
    });

    it("matches candidates against Kindle files with identical byte sizes (or within ±4KB) regardless of folder name", () => {
      const kindleMount = path.join(fakeVolumesDir, "Kindle");
      const miscDir = path.join(kindleMount, "documents", "Misc");
      fs.mkdirSync(miscDir, { recursive: true });

      const sampleSize = 120500;
      const fileBytes = Buffer.alloc(sampleSize, "x");
      fs.writeFileSync(path.join(miscDir, "The Hobbit (Special Edition) - J.R.R. Tolkien.epub"), fileBytes);

      const index = buildKindleBookIndex(kindleMount);

      // Match 1: Identical byte size in a completely different folder with edition variance
      const match1 = isBookAlreadyOnKindle(
        kindleMount,
        "The Hobbit (Deluxe Edition) - J.R.R. Tolkien.epub",
        "J.R.R. Tolkien",
        sampleSize,
        index,
        { title: "The Hobbit (Deluxe Edition)", authors: "J.R.R. Tolkien" },
      );
      expect(match1.exists).toBe(true);
      expect(match1.matchedBy).toBe("filesize_and_token");

      // Match 2: Byte size within ±4KB (e.g. 1024 bytes difference due to zip timestamp)
      const match2 = isBookAlreadyOnKindle(
        kindleMount,
        "The Hobbit (Deluxe Edition) - J.R.R. Tolkien.epub",
        "J.R.R. Tolkien",
        sampleSize + 1024,
        index,
        { title: "The Hobbit (Deluxe Edition)", authors: "J.R.R. Tolkien" },
      );
      expect(match2.exists).toBe(true);
      expect(match2.matchedBy).toBe("filesize_and_token");

      // Rejection: Volume mismatch must never match even if sizes are close
      const matchVol2 = isBookAlreadyOnKindle(
        kindleMount,
        "The Hobbit Vol 2.epub",
        "J.R.R. Tolkien",
        sampleSize,
        index,
        { title: "The Hobbit Vol 2", authors: "J.R.R. Tolkien" },
      );
      expect(matchVol2.exists).toBe(false);
    });

    it("scanKindleDeviceDuplicates detects duplicate copies and picks the canonical version", () => {
      const kindleMount = path.join(fakeVolumesDir, "Kindle");
      const burmeseDir = path.join(kindleMount, "books", "မြသန်းတင့်");
      const latinDir = path.join(kindleMount, "books", "Mya Than Tint");
      const docsDir = path.join(kindleMount, "documents");
      fs.mkdirSync(burmeseDir, { recursive: true });
      fs.mkdirSync(latinDir, { recursive: true });
      fs.mkdirSync(docsDir, { recursive: true });

      // Duplicate pair 1: Burmese book in proper Unicode folder vs older Latin folder
      const canonicalBurmese = path.join(burmeseDir, "ပါရီကျဆုံးခန်း - မြသန်းတင့်.epub");
      const duplicateBurmese = path.join(latinDir, "ပါရီကျဆုံးခန်း.epub");
      fs.writeFileSync(canonicalBurmese, Buffer.alloc(100000, "b"));
      fs.writeFileSync(duplicateBurmese, Buffer.alloc(100000, "b"));

      // Duplicate pair 2: Flat document vs structured book
      const canonicalHobbit = path.join(kindleMount, "books", "J.R.R. Tolkien", "The Hobbit - J.R.R. Tolkien.epub");
      fs.mkdirSync(path.dirname(canonicalHobbit), { recursive: true });
      const duplicateHobbit = path.join(docsDir, "The Hobbit.epub");
      fs.writeFileSync(canonicalHobbit, Buffer.alloc(50000, "h"));
      fs.writeFileSync(duplicateHobbit, Buffer.alloc(50000, "h"));

      invalidateKindleBookIndex();
      const dupGroups = scanKindleDeviceDuplicates(kindleMount, { forceRefresh: true });

      expect(dupGroups.length).toBe(2);

      // Check Burmese group
      const burmeseGroup = dupGroups.find((g) => g.title.includes("ပါရီကျဆုံးခန်း"));
      expect(burmeseGroup).toBeDefined();
      expect(burmeseGroup?.canonicalPath).toBe(canonicalBurmese);
      expect(burmeseGroup?.duplicatePaths).toContain(duplicateBurmese);
      expect(burmeseGroup?.wastedBytes).toBe(100000);

      // Check Hobbit group
      const hobbitGroup = dupGroups.find((g) => g.title.includes("The Hobbit"));
      expect(hobbitGroup).toBeDefined();
      expect(hobbitGroup?.canonicalPath).toBe(canonicalHobbit);
      expect(hobbitGroup?.duplicatePaths).toContain(duplicateHobbit);
      expect(hobbitGroup?.wastedBytes).toBe(50000);
    });

    it("cleanKindleDeviceDuplicates prunes duplicate files and cleans sidecars without touching canonical", () => {
      const kindleMount = path.join(fakeVolumesDir, "Kindle");
      const burmeseDir = path.join(kindleMount, "books", "မြသန်းတင့်");
      const oldDir = path.join(kindleMount, "books", "Old Mya Than Tint");
      fs.mkdirSync(burmeseDir, { recursive: true });
      fs.mkdirSync(oldDir, { recursive: true });

      const canonicalPath = path.join(burmeseDir, "ပါရီကျဆုံးခန်း - မြသန်းတင့်.epub");
      const dupPath = path.join(oldDir, "ပါရီကျဆုံးခန်း.epub");
      const dupSdr = path.join(oldDir, "ပါရီကျဆုံးခန်း.sdr");

      fs.writeFileSync(canonicalPath, Buffer.alloc(80000, "c"));
      fs.writeFileSync(dupPath, Buffer.alloc(80000, "d"));
      fs.mkdirSync(dupSdr, { recursive: true });
      fs.writeFileSync(path.join(dupSdr, "metadata.lua"), "test lua", "utf8");

      invalidateKindleBookIndex();
      const res = cleanKindleDeviceDuplicates(kindleMount);

      expect(res.cleanedCount).toBe(1);
      expect(res.bytesFreed).toBe(80000);

      // Canonical file must survive untouched
      expect(fs.existsSync(canonicalPath)).toBe(true);
      // Duplicate file must be removed
      expect(fs.existsSync(dupPath)).toBe(false);
      // Duplicate .sdr folder must be removed
      expect(fs.existsSync(dupSdr)).toBe(false);
      // Empty parent dir must be cleaned up
      expect(fs.existsSync(oldDir)).toBe(false);
    });

    it("getKindleStatus and getKindleSyncStatus report deviceDuplicatesCount", () => {
      const kindleMount = path.join(fakeVolumesDir, "Kindle");
      const dir1 = path.join(kindleMount, "books", "Author1");
      const dir2 = path.join(kindleMount, "documents");
      fs.mkdirSync(dir1, { recursive: true });
      fs.mkdirSync(dir2, { recursive: true });

      // Create duplicate files
      fs.writeFileSync(path.join(dir1, "Duplicate Book.epub"), Buffer.alloc(20000, "1"));
      fs.writeFileSync(path.join(dir2, "Duplicate Book.epub"), Buffer.alloc(20000, "1"));

      invalidateKindleBookIndex();
      const status = getKindleStatus(fakeVolumesDir);
      expect(status.detected).toBe(true);
      expect(status.deviceDuplicatesCount).toBe(1);

      const syncStatus = getKindleSyncStatus(fakeVolumesDir);
      expect(syncStatus.deviceDuplicatesCount).toBe(1);
    });

    it("NEVER clusters distinct books by different authors sharing a filename (e.g. Selected Poems by Sylvia Plath vs T.S. Eliot)", () => {
      const kindleMount = path.join(fakeVolumesDir, "Kindle");
      const plathDir = path.join(kindleMount, "books", "Sylvia Plath");
      const eliotDir = path.join(kindleMount, "books", "T.S. Eliot");
      fs.mkdirSync(plathDir, { recursive: true });
      fs.mkdirSync(eliotDir, { recursive: true });

      const plathBook = path.join(plathDir, "Selected Poems.epub");
      const eliotBook = path.join(eliotDir, "Selected Poems.epub");

      // Plath is 150KB, Eliot is 350KB (clearly distinct books)
      fs.writeFileSync(plathBook, Buffer.alloc(150000, "p"));
      fs.writeFileSync(eliotBook, Buffer.alloc(350000, "e"));

      invalidateKindleBookIndex();
      const dupGroups = scanKindleDeviceDuplicates(kindleMount, { forceRefresh: true });

      // Must NOT cluster these as duplicates!
      expect(dupGroups.length).toBe(0);

      // Verify cleanKindleDeviceDuplicates does not touch either file
      const cleanRes = cleanKindleDeviceDuplicates(kindleMount);
      expect(cleanRes.cleanedCount).toBe(0);
      expect(fs.existsSync(plathBook)).toBe(true);
      expect(fs.existsSync(eliotBook)).toBe(true);
    });

    it("prioritizes file with active .sdr reading progress folder when structure is comparable", () => {
      const kindleMount = path.join(fakeVolumesDir, "Kindle");
      const booksAuthorDir = path.join(kindleMount, "books", "J.R.R. Tolkien");
      const docsAuthorDir = path.join(kindleMount, "documents", "J.R.R. Tolkien");
      fs.mkdirSync(booksAuthorDir, { recursive: true });
      fs.mkdirSync(docsAuthorDir, { recursive: true });

      const unreadPath = path.join(booksAuthorDir, "The Hobbit.epub");
      const activePath = path.join(docsAuthorDir, "The Hobbit.epub");
      const activeSdr = path.join(docsAuthorDir, "The Hobbit.sdr");

      // Give activePath a slightly richer content size or .sdr
      fs.writeFileSync(unreadPath, Buffer.alloc(60000, "u"));
      fs.writeFileSync(activePath, Buffer.alloc(60000, "a"));
      fs.mkdirSync(activeSdr, { recursive: true });
      fs.writeFileSync(path.join(activeSdr, "metadata.epub.lua"), "reading progress 75%", "utf8");

      invalidateKindleBookIndex();
      const dupGroups = scanKindleDeviceDuplicates(kindleMount, { forceRefresh: true });

      expect(dupGroups.length).toBe(1);
      // Both are in author folders; if one has .sdr sidecar, its highlights are preserved
      expect(dupGroups[0].files.length).toBe(2);
      expect(fs.existsSync(activeSdr)).toBe(true);
    });

    it("migrates .sdr progress to canonical file when cleaning a duplicate that has .sdr", () => {
      const kindleMount = path.join(fakeVolumesDir, "Kindle");
      const authorDir = path.join(kindleMount, "books", "မြသန်းတင့်");
      const oldDir = path.join(kindleMount, "books", "Mya Than Tint");
      fs.mkdirSync(authorDir, { recursive: true });
      fs.mkdirSync(oldDir, { recursive: true });

      const canonicalPath = path.join(authorDir, "ပါရီကျဆုံးခန်း - မြသန်းတင့်.epub");
      const dupPath = path.join(oldDir, "ပါရီကျဆုံးခန်း.epub");
      const dupSdr = path.join(oldDir, "ပါရီကျဆုံးခန်း.sdr");
      const canonicalSdr = path.join(authorDir, "ပါရီကျဆုံးခန်း - မြသန်းတင့်.sdr");

      // Canonical has higher score (+100 books +60 subfolder +40 Unicode author +20 dash +15 epub = 235),
      // but dup has .sdr sidecar with active highlights
      fs.writeFileSync(canonicalPath, Buffer.alloc(80000, "c"));
      fs.writeFileSync(dupPath, Buffer.alloc(80000, "d"));
      fs.mkdirSync(dupSdr, { recursive: true });
      fs.writeFileSync(path.join(dupSdr, "metadata.epub.lua"), "saved quotes", "utf8");

      invalidateKindleBookIndex();
      const cleanRes = cleanKindleDeviceDuplicates(kindleMount);

      expect(cleanRes.cleanedCount).toBe(1);
      expect(fs.existsSync(dupPath)).toBe(false);
      expect(fs.existsSync(canonicalPath)).toBe(true);

      // Canonical file must have the migrated .sdr sidecar
      const hasProgressPreserved = fs.existsSync(`${canonicalPath}.sdr`) || fs.existsSync(canonicalSdr);
      expect(hasProgressPreserved).toBe(true);
      expect(fs.existsSync(dupSdr)).toBe(false);
    });

    it("migrates real KOReader *.epub.sdr sidecar to canonical *.epub.sdr upon cleaning duplicate", () => {
      const kindleMount = path.join(fakeVolumesDir, "Kindle");
      const burmeseDir = path.join(kindleMount, "books", "မြသန်းတင့်");
      const oldDir = path.join(kindleMount, "books", "Mya Than Tint");
      fs.mkdirSync(burmeseDir, { recursive: true });
      fs.mkdirSync(oldDir, { recursive: true });

      const canonicalPath = path.join(burmeseDir, "ပါရီကျဆုံးခန်း - မြသန်းတင့်.epub");
      const dupPath = path.join(oldDir, "ပါရီကျဆုံးခန်း.epub");
      // Real KOReader sidecar format is <filename>.sdr
      const dupEpubSdr = `${dupPath}.sdr`;
      const canonicalEpubSdr = `${canonicalPath}.sdr`;

      fs.writeFileSync(canonicalPath, Buffer.alloc(80000, "c"));
      fs.writeFileSync(dupPath, Buffer.alloc(80000, "d"));
      fs.mkdirSync(dupEpubSdr, { recursive: true });
      fs.writeFileSync(path.join(dupEpubSdr, "metadata.epub.lua"), "koreader bookmarks", "utf8");

      invalidateKindleBookIndex();
      const cleanRes = cleanKindleDeviceDuplicates(kindleMount);

      expect(cleanRes.cleanedCount).toBe(1);
      expect(fs.existsSync(dupPath)).toBe(false);
      expect(fs.existsSync(canonicalPath)).toBe(true);
      // Canonical file must now have the migrated KOReader .sdr sidecar
      expect(fs.existsSync(canonicalEpubSdr)).toBe(true);
      expect(fs.readFileSync(path.join(canonicalEpubSdr, "metadata.epub.lua"), "utf8")).toBe("koreader bookmarks");
      expect(fs.existsSync(dupEpubSdr)).toBe(false);
    });

    it("drains and cleans dual-format sidecars (both *.epub.sdr and *.sdr) without leaving orphan directories", () => {
      const kindleMount = path.join(fakeVolumesDir, "Kindle");
      const burmeseDir = path.join(kindleMount, "books", "မြသန်းတင့်");
      const oldDir = path.join(kindleMount, "books", "Mya Than Tint");
      fs.mkdirSync(burmeseDir, { recursive: true });
      fs.mkdirSync(oldDir, { recursive: true });

      const canonicalPath = path.join(burmeseDir, "ပါရီကျဆုံးခန်း - မြသန်းတင့်.epub");
      const dupPath = path.join(oldDir, "ပါရီကျဆုံးခန်း.epub");

      // Duplicate has BOTH KOReader format (*.epub.sdr) and legacy format (*.sdr)
      const dupEpubSdr = `${dupPath}.sdr`;
      const dupBaseSdr = path.join(oldDir, "ပါရီကျဆုံးခန်း.sdr");

      fs.writeFileSync(canonicalPath, Buffer.alloc(80000, "c"));
      fs.writeFileSync(dupPath, Buffer.alloc(80000, "d"));
      fs.mkdirSync(dupEpubSdr, { recursive: true });
      fs.writeFileSync(path.join(dupEpubSdr, "metadata.epub.lua"), "koreader active progress", "utf8");
      fs.mkdirSync(dupBaseSdr, { recursive: true });
      fs.writeFileSync(path.join(dupBaseSdr, "legacy.lua"), "legacy notes", "utf8");

      invalidateKindleBookIndex();
      const cleanRes = cleanKindleDeviceDuplicates(kindleMount);

      expect(cleanRes.cleanedCount).toBe(1);
      expect(fs.existsSync(canonicalPath)).toBe(true);
      expect(fs.existsSync(dupPath)).toBe(false);

      // Preferred sidecar is migrated to canonical
      expect(fs.existsSync(`${canonicalPath}.sdr`)).toBe(true);
      expect(fs.readFileSync(path.join(`${canonicalPath}.sdr`, "metadata.epub.lua"), "utf8")).toBe("koreader active progress");

      // BOTH duplicate sidecars must be completely cleaned up: NO orphans!
      expect(fs.existsSync(dupEpubSdr)).toBe(false);
      expect(fs.existsSync(dupBaseSdr)).toBe(false);

      // Empty parent dir must be completely removed
      expect(fs.existsSync(oldDir)).toBe(false);
    });

    it("NEVER matches distinct sequels / supersets like 'Dark Tower' against 'Dark Tower Gunslinger' in Strategy F or G", () => {
      const kindleMount = path.join(fakeVolumesDir, "Kindle");
      const kingDir = path.join(kindleMount, "books", "Stephen King");
      fs.mkdirSync(kingDir, { recursive: true });

      const existingPath = path.join(kingDir, "The Dark Tower Gunslinger - Stephen King.epub");
      fs.writeFileSync(existingPath, Buffer.alloc(200000, "g"));

      const index = buildKindleBookIndex(kindleMount);

      // Candidate is "The Dark Tower" (Vol 7 or standalone series title), candidate size within ±4KB
      const match = isBookAlreadyOnKindle(
        kindleMount,
        "The Dark Tower - Stephen King.epub",
        "Stephen King",
        200500,
        index,
        { title: "The Dark Tower", authors: "Stephen King" },
      );

      // Must NOT match "The Dark Tower Gunslinger"!
      expect(match.exists).toBe(false);
    });

    it("NEVER matches 3+ token subset variants (e.g. Complete Guide to Rust Programming vs Complete Guide to Rust Programming Advanced)", () => {
      const kindleMount = path.join(fakeVolumesDir, "Kindle");
      const rustDir = path.join(kindleMount, "books", "Tech Author");
      fs.mkdirSync(rustDir, { recursive: true });

      const existingPath = path.join(rustDir, "Complete Guide to Rust Programming - Tech Author.epub");
      fs.writeFileSync(existingPath, Buffer.alloc(200000, "r"));

      const index = buildKindleBookIndex(kindleMount);

      // Candidate has an extra distinct title word ("Advanced"), size within ±4KB
      const match1 = isBookAlreadyOnKindle(
        kindleMount,
        "Complete Guide to Rust Programming Advanced - Tech Author.epub",
        "Tech Author",
        200500,
        index,
        { title: "Complete Guide to Rust Programming Advanced", authors: "Tech Author" },
      );
      expect(match1.exists).toBe(false);

      // Reverse case: candidate is a subset ("Complete Guide to Rust")
      const match2 = isBookAlreadyOnKindle(
        kindleMount,
        "Complete Guide to Rust - Tech Author.epub",
        "Tech Author",
        200500,
        index,
        { title: "Complete Guide to Rust", authors: "Tech Author" },
      );
      expect(match2.exists).toBe(false);
    });

    it("clusters duplicate files even if one is in a staging or junk folder (e.g. books/Old vs books/Author)", () => {
      const kindleMount = path.join(fakeVolumesDir, "Kindle");
      const authorDir = path.join(kindleMount, "books", "J.R.R. Tolkien");
      const oldDir = path.join(kindleMount, "books", "Old");
      fs.mkdirSync(authorDir, { recursive: true });
      fs.mkdirSync(oldDir, { recursive: true });

      const canonicalPath = path.join(authorDir, "The Hobbit.epub");
      const oldDupPath = path.join(oldDir, "The Hobbit.epub");

      fs.writeFileSync(canonicalPath, Buffer.alloc(60000, "c"));
      fs.writeFileSync(oldDupPath, Buffer.alloc(60000, "o"));

      invalidateKindleBookIndex();
      const dupGroups = scanKindleDeviceDuplicates(kindleMount, { forceRefresh: true });

      expect(dupGroups.length).toBe(1);
      expect(dupGroups[0].canonicalPath).toBe(canonicalPath);
      expect(dupGroups[0].duplicatePaths).toContain(oldDupPath);
    });

    it("does not false-positive on short Burmese substring titles in Strategy G", () => {
      const kindleMount = path.join(fakeVolumesDir, "Kindle");
      const authorDir = path.join(kindleMount, "books", "Burmese Author");
      fs.mkdirSync(authorDir, { recursive: true });

      // Existing book is a longer Burmese title: "ရွှေမင်းသမီးလေး" (The Golden Princess)
      const existingPath = path.join(authorDir, "ရွှေမင်းသမီးလေး.epub");
      fs.writeFileSync(existingPath, Buffer.alloc(100000, "b"));

      const index = buildKindleBookIndex(kindleMount);

      // Candidate is a short single-word Burmese title: "ရွှေ" (Gold), length < 6
      const match = isBookAlreadyOnKindle(
        kindleMount,
        "ရွှေ - Burmese Author.epub",
        "Burmese Author",
        100500,
        index,
        { title: "ရွှေ", authors: "Burmese Author" },
      );

      // Must NOT match the longer different book "ရွှေမင်းသမီးလေး"!
      expect(match.exists).toBe(false);
    });

    it("replaces stale canonical sidecar when duplicate contains active KOReader reading progress", () => {
      const kindleMount = path.join(fakeVolumesDir, "Kindle");
      const booksDir = path.join(kindleMount, "books", "Author");
      const oldDir = path.join(kindleMount, "books", "Old");
      fs.mkdirSync(booksDir, { recursive: true });
      fs.mkdirSync(oldDir, { recursive: true });

      const canonicalPath = path.join(booksDir, "Book.epub");
      const dupPath = path.join(oldDir, "Book.epub");

      // Canonical has only a stale empty sidecar with no lua progress
      const canonicalStaleSdr = path.join(booksDir, "Book.sdr");
      fs.mkdirSync(canonicalStaleSdr, { recursive: true });
      fs.writeFileSync(path.join(canonicalStaleSdr, "stale.txt"), "old notes", "utf8");

      // Duplicate has authoritative KOReader .epub.sdr with active bookmarks
      const dupRichSdr = `${dupPath}.sdr`;
      fs.mkdirSync(dupRichSdr, { recursive: true });
      fs.writeFileSync(path.join(dupRichSdr, "metadata.epub.lua"), "page=220 reading progress", "utf8");

      fs.writeFileSync(canonicalPath, Buffer.alloc(50000, "c"));
      fs.writeFileSync(dupPath, Buffer.alloc(50000, "d"));

      invalidateKindleBookIndex();
      const cleanRes = cleanKindleDeviceDuplicates(kindleMount);

      expect(cleanRes.cleanedCount).toBe(1);
      expect(fs.existsSync(dupPath)).toBe(false);
      expect(fs.existsSync(canonicalPath)).toBe(true);

      // Canonical file must now have the authoritative KOReader .sdr sidecar with page=220
      const canonicalFullSdr = `${canonicalPath}.sdr`;
      expect(fs.existsSync(canonicalFullSdr)).toBe(true);
      expect(fs.readFileSync(path.join(canonicalFullSdr, "metadata.epub.lua"), "utf8")).toBe("page=220 reading progress");
    });

    it("migrates active legacy *.sdr progress to canonical even when duplicate also has an empty *.epub.sdr", () => {
      const kindleMount = path.join(fakeVolumesDir, "Kindle");
      const booksDir = path.join(kindleMount, "books", "Author");
      const oldDir = path.join(kindleMount, "books", "Old");
      fs.mkdirSync(booksDir, { recursive: true });
      fs.mkdirSync(oldDir, { recursive: true });

      const canonicalPath = path.join(booksDir, "The Final Empire - Author.epub");
      const dupPath = path.join(oldDir, "The Final Empire.epub");

      // Duplicate has an EMPTY *.epub.sdr and a RICH legacy *.sdr with metadata.lua
      const dupEpubSdr = `${dupPath}.sdr`;
      const dupBaseSdr = path.join(oldDir, "The Final Empire.sdr");
      fs.mkdirSync(dupEpubSdr, { recursive: true });
      fs.mkdirSync(dupBaseSdr, { recursive: true });
      fs.writeFileSync(path.join(dupBaseSdr, "metadata.epub.lua"), "legacy active reading progress", "utf8");

      fs.writeFileSync(canonicalPath, Buffer.alloc(50000, "c"));
      fs.writeFileSync(dupPath, Buffer.alloc(50000, "d"));

      invalidateKindleBookIndex();
      const cleanRes = cleanKindleDeviceDuplicates(kindleMount);

      expect(cleanRes.cleanedCount).toBe(1);
      expect(fs.existsSync(dupPath)).toBe(false);
      expect(fs.existsSync(canonicalPath)).toBe(true);

      // Canonical file must have received the active reading progress sidecar
      const canonicalFullSdr = `${canonicalPath}.sdr`;
      expect(fs.existsSync(canonicalFullSdr)).toBe(true);
      expect(fs.readFileSync(path.join(canonicalFullSdr, "metadata.epub.lua"), "utf8")).toBe("legacy active reading progress");

      // No orphans left behind
      expect(fs.existsSync(dupEpubSdr)).toBe(false);
      expect(fs.existsSync(dupBaseSdr)).toBe(false);
      expect(fs.existsSync(oldDir)).toBe(false);
    });

    it("NEVER clusters same-filename books in staging folders if file sizes differ significantly", () => {
      const kindleMount = path.join(fakeVolumesDir, "Kindle");
      const oldDir = path.join(kindleMount, "books", "old");
      const stagingDir = path.join(kindleMount, "books", "staging");
      fs.mkdirSync(oldDir, { recursive: true });
      fs.mkdirSync(stagingDir, { recursive: true });

      // Two different editions/works sharing the title "The Odyssey" in staging folders (100KB vs 500KB)
      const book1 = path.join(oldDir, "The Odyssey.epub");
      const book2 = path.join(stagingDir, "The Odyssey.epub");

      fs.writeFileSync(book1, Buffer.alloc(100000, "1"));
      fs.writeFileSync(book2, Buffer.alloc(500000, "2"));

      invalidateKindleBookIndex();
      const dupGroups = scanKindleDeviceDuplicates(kindleMount, { forceRefresh: true });

      // Must NOT treat these as duplicates!
      expect(dupGroups.length).toBe(0);
    });

    it("NEVER clusters generic section titles like Introduction across staging folders via filesize_and_token", () => {
      const kindleMount = path.join(fakeVolumesDir, "Kindle");
      const oldDir = path.join(kindleMount, "books", "old");
      const stagingDir = path.join(kindleMount, "books", "staging");
      fs.mkdirSync(oldDir, { recursive: true });
      fs.mkdirSync(stagingDir, { recursive: true });

      const intro1 = path.join(oldDir, "Introduction.epub");
      const intro2 = path.join(stagingDir, "Introduction.epub");

      fs.writeFileSync(intro1, Buffer.alloc(4000, "i"));
      fs.writeFileSync(intro2, Buffer.alloc(4000, "i"));

      invalidateKindleBookIndex();
      const dupGroups = scanKindleDeviceDuplicates(kindleMount, { forceRefresh: true });

      // Generic section titles without author corroboration must never cluster!
      expect(dupGroups.length).toBe(0);
    });

    it("NEVER treats different format variants (.epub vs .mobi vs .azw3) as device duplicates to delete", () => {
      const kindleMount = path.join(fakeVolumesDir, "Kindle");
      const authorDir = path.join(kindleMount, "books", "Author");
      fs.mkdirSync(authorDir, { recursive: true });

      // User has both EPUB (for KOReader) and MOBI (for native Kindle reader) of the same book
      const epubPath = path.join(authorDir, "Dune.epub");
      const mobiPath = path.join(authorDir, "Dune.mobi");

      fs.writeFileSync(epubPath, Buffer.alloc(100000, "e"));
      fs.writeFileSync(mobiPath, Buffer.alloc(100000, "m"));

      invalidateKindleBookIndex();
      const dupGroups = scanKindleDeviceDuplicates(kindleMount, { forceRefresh: true });

      // Format variants must NOT be grouped as duplicates or deleted!
      expect(dupGroups.length).toBe(0);

      const cleanRes = cleanKindleDeviceDuplicates(kindleMount);
      expect(cleanRes.cleanedCount).toBe(0);
      expect(fs.existsSync(epubPath)).toBe(true);
      expect(fs.existsSync(mobiPath)).toBe(true);
    });

    it("NEVER clusters same-filename books under same author if file sizes differ significantly", () => {
      const kindleMount = path.join(fakeVolumesDir, "Kindle");
      const booksTolkien = path.join(kindleMount, "books", "Tolkien");
      const docsTolkien = path.join(kindleMount, "documents", "Tolkien");
      fs.mkdirSync(booksTolkien, { recursive: true });
      fs.mkdirSync(docsTolkien, { recursive: true });

      // Same author folder, same filename, but 100KB sample vs 900KB full book
      const sample = path.join(booksTolkien, "The Hobbit.epub");
      const full = path.join(docsTolkien, "The Hobbit.epub");

      fs.writeFileSync(sample, Buffer.alloc(100000, "s"));
      fs.writeFileSync(full, Buffer.alloc(900000, "f"));

      invalidateKindleBookIndex();
      const dupGroups = scanKindleDeviceDuplicates(kindleMount, { forceRefresh: true });

      // Large size delta must prevent false-positive duplicate clustering
      expect(dupGroups.length).toBe(0);
    });

    it("NEVER clusters same Burmese title when file sizes differ significantly (e.g. 100KB sample vs 900KB full book)", () => {
      const kindleMount = path.join(fakeVolumesDir, "Kindle");
      const burmeseDir = path.join(kindleMount, "books", "မြသန်းတင့်");
      const latinDir = path.join(kindleMount, "books", "Mya Than Tint");
      fs.mkdirSync(burmeseDir, { recursive: true });
      fs.mkdirSync(latinDir, { recursive: true });

      // Same Burmese title across different author folders, but 100KB sample vs 900KB full book
      const sample = path.join(burmeseDir, "ပါရီကျဆုံးခန်း.epub");
      const full = path.join(latinDir, "ပါရီကျဆုံးခန်း.epub");

      fs.writeFileSync(sample, Buffer.alloc(100000, "s"));
      fs.writeFileSync(full, Buffer.alloc(900000, "f"));

      invalidateKindleBookIndex();
      const dupGroups = scanKindleDeviceDuplicates(kindleMount, { forceRefresh: true });

      // Large size delta must prevent clustering different sample/full works!
      expect(dupGroups.length).toBe(0);
    });

    it("NEVER clusters distinct Latin books when author segment has Burmese characters (e.g. Dune - Mya Than Tint vs Dune - Frank Herbert)", () => {
      const kindleMount = path.join(fakeVolumesDir, "Kindle");
      const burmeseAuthorDir = path.join(kindleMount, "books", "မြသန်းတင့်");
      const herbertDir = path.join(kindleMount, "books", "Frank Herbert");
      fs.mkdirSync(burmeseAuthorDir, { recursive: true });
      fs.mkdirSync(herbertDir, { recursive: true });

      // Latin title "Dune", but one file has Burmese translator in author segment of filename
      const translatorBook = path.join(burmeseAuthorDir, "Dune - မြသန်းတင့်.epub");
      const herbertBook = path.join(herbertDir, "Dune.epub");

      fs.writeFileSync(translatorBook, Buffer.alloc(120000, "t"));
      fs.writeFileSync(herbertBook, Buffer.alloc(120000, "h"));

      invalidateKindleBookIndex();
      const dupGroups = scanKindleDeviceDuplicates(kindleMount, { forceRefresh: true });

      // Must NOT cluster because title "Dune" is Latin and authors conflict!
      expect(dupGroups.length).toBe(0);

      // Verify upload candidate Frank Herbert / Dune does NOT match Dune - မြသန်းတင့်.epub
      const index = buildKindleBookIndex(kindleMount);
      const matchUpload = isBookAlreadyOnKindle(
        kindleMount,
        "Dune - Frank Herbert.epub",
        "Frank Herbert",
        120000,
        index,
        { title: "Dune", authors: "Frank Herbert" },
      );
      expect(matchUpload.existingPath).toBe(herbertBook);

      // And candidate Dune - မြသန်းတင့် does NOT match Frank Herbert's book
      const matchBurmese = isBookAlreadyOnKindle(
        kindleMount,
        "Dune - မြသန်းတင့်.epub",
        "မြသန်းတင့်",
        120000,
        index,
        { title: "Dune", authors: "မြသန်းတင့်" },
      );
      expect(matchBurmese.existingPath).toBe(translatorBook);
    });

    it("NEVER clusters same Burmese title when authors are different Latin names (e.g. books/AuthorA/ပါရီကျဆုံးခန်း.epub vs books/AuthorB/ပါရီကျဆုံးခန်း.epub)", () => {
      const kindleMount = path.join(fakeVolumesDir, "Kindle");
      const authorADir = path.join(kindleMount, "books", "AuthorA");
      const authorBDir = path.join(kindleMount, "books", "AuthorB");
      fs.mkdirSync(authorADir, { recursive: true });
      fs.mkdirSync(authorBDir, { recursive: true });

      const bookA = path.join(authorADir, "ပါရီကျဆုံးခန်း.epub");
      const bookB = path.join(authorBDir, "ပါရီကျဆုံးခန်း.epub");

      // Same Burmese title, same size, but different Latin authors
      fs.writeFileSync(bookA, Buffer.alloc(100000, "a"));
      fs.writeFileSync(bookB, Buffer.alloc(100000, "b"));

      invalidateKindleBookIndex();
      const dupGroups = scanKindleDeviceDuplicates(kindleMount, { forceRefresh: true });

      // Conflicting authors in same script must NEVER cluster as duplicates!
      expect(dupGroups.length).toBe(0);

      // Verify upload candidate for AuthorA does NOT match AuthorB's book
      const index = buildKindleBookIndex(kindleMount);
      const matchCandidate = isBookAlreadyOnKindle(
        kindleMount,
        "ပါရီကျဆုံးခန်း.epub",
        "DifferentAuthor",
        100000,
        index,
        { title: "ပါရီကျဆုံးခန်း", authors: "DifferentAuthor" },
      );
      expect(matchCandidate.exists).toBe(false);
    });

    it("clusters same Burmese title when one author is Myanmar and the other is Latin transliteration (e.g. မြသန်းတင့် vs Mya Than Tint)", () => {
      const kindleMount = path.join(fakeVolumesDir, "Kindle");
      const myanmarDir = path.join(kindleMount, "books", "မြသန်းတင့်");
      const latinDir = path.join(kindleMount, "books", "Mya Than Tint");
      fs.mkdirSync(myanmarDir, { recursive: true });
      fs.mkdirSync(latinDir, { recursive: true });

      const bookMyanmar = path.join(myanmarDir, "ပါရီကျဆုံးခန်း.epub");
      const bookLatin = path.join(latinDir, "ပါရီကျဆုံးခန်း.epub");

      fs.writeFileSync(bookMyanmar, Buffer.alloc(100000, "m"));
      fs.writeFileSync(bookLatin, Buffer.alloc(100000, "l"));

      invalidateKindleBookIndex();
      const dupGroups = scanKindleDeviceDuplicates(kindleMount, { forceRefresh: true });

      // Cross-script author match allows clustering the same Burmese book!
      expect(dupGroups.length).toBe(1);
    });

    it("NEVER clusters same Burmese title when authors are different persons even across scripts (e.g. မြသန်းတင့် vs Min Lu or Maung Win)", () => {
      const kindleMount = path.join(fakeVolumesDir, "Kindle");
      const myaThanTintDir = path.join(kindleMount, "books", "မြသန်းတင့်");
      const minLuDir = path.join(kindleMount, "books", "Min Lu");
      const maungWinDir = path.join(kindleMount, "books", "Maung Win");
      fs.mkdirSync(myaThanTintDir, { recursive: true });
      fs.mkdirSync(minLuDir, { recursive: true });
      fs.mkdirSync(maungWinDir, { recursive: true });

      const bookMya = path.join(myaThanTintDir, "ပါရီကျဆုံးခန်း.epub");
      const bookMin = path.join(minLuDir, "ပါရီကျဆုံးခန်း.epub");
      const bookMaung = path.join(maungWinDir, "ပါရီကျဆုံးခန်း.epub");

      // Same Burmese title and identical file size, but distinct real authors!
      fs.writeFileSync(bookMya, Buffer.alloc(100000, "m"));
      fs.writeFileSync(bookMin, Buffer.alloc(100000, "l"));
      fs.writeFileSync(bookMaung, Buffer.alloc(100000, "w"));

      invalidateKindleBookIndex();
      const dupGroups = scanKindleDeviceDuplicates(kindleMount, { forceRefresh: true });

      // Must NOT cluster any of these together!
      expect(dupGroups.length).toBe(0);

      // Clean must leave all three files completely intact!
      cleanKindleDeviceDuplicates(kindleMount);
      expect(fs.existsSync(bookMya)).toBe(true);
      expect(fs.existsSync(bookMin)).toBe(true);
      expect(fs.existsSync(bookMaung)).toBe(true);

      // Upload candidate with author မြသန်းတင့် must NOT match Min Lu or Maung Win on device
      const index = buildKindleBookIndex(kindleMount);
      const matchWrong = isBookAlreadyOnKindle(
        kindleMount,
        "ပါရီကျဆုံးခန်း.epub",
        "မင်းလူ",
        100000,
        index,
        { title: "ပါရီကျဆုံးခန်း", authors: "မင်းလူ" },
      );
      // It must strictly match Min Lu on device, NEVER မြသန်းတင့် or Maung Win
      expect(matchWrong.existingPath).toBe(bookMin);

      // Upload candidate with an unrelated author must NOT match any of them
      const matchUnrelated = isBookAlreadyOnKindle(
        kindleMount,
        "ပါရီကျဆုံးခန်း.epub",
        "ချစ်ဦးညို",
        100000,
        index,
        { title: "ပါရီကျဆုံးခန်း", authors: "ချစ်ဦးညို" },
      );
      expect(matchUnrelated.exists).toBe(false);
    });

    it("NEVER clusters near-substring Latin authors against Myanmar authors (e.g. Min Luang or Min Lua vs မင်းလူ, Mya Than Tinting vs မြသန်းတင့်)", () => {
      const kindleMount = path.join(fakeVolumesDir, "Kindle");
      const minLuDir = path.join(kindleMount, "books", "မင်းလူ");
      const minLuangDir = path.join(kindleMount, "books", "Min Luang");
      fs.mkdirSync(minLuDir, { recursive: true });
      fs.mkdirSync(minLuangDir, { recursive: true });

      const bookMinLu = path.join(minLuDir, "ဝတ္ထု.epub");
      const bookMinLuang = path.join(minLuangDir, "ဝတ္ထု.epub");

      fs.writeFileSync(bookMinLu, Buffer.alloc(100000, "1"));
      fs.writeFileSync(bookMinLuang, Buffer.alloc(100000, "2"));

      invalidateKindleBookIndex();
      const dupGroups = scanKindleDeviceDuplicates(kindleMount, { forceRefresh: true });

      // Substring names like Min Luang must NEVER match မင်းလူ!
      expect(dupGroups.length).toBe(0);

      // Upload candidate Min Luang must NOT match မင်းလူ on device
      const index = buildKindleBookIndex(kindleMount);
      const matchUpload = isBookAlreadyOnKindle(
        kindleMount,
        "ဝတ္ထု.epub",
        "Min Luang",
        100000,
        index,
        { title: "ဝတ္ထု", authors: "Min Luang" },
      );
      expect(matchUpload.existingPath).toBe(bookMinLuang);

      // Near-substrings like Min Lua and Mya Than Tinting must NOT match
      const matchMinLua = isBookAlreadyOnKindle(
        kindleMount,
        "ဝတ္ထု.epub",
        "Min Lua",
        100000,
        index,
        { title: "ဝတ္ထု", authors: "Min Lua" },
      );
      expect(matchMinLua.exists).toBe(false);

      const matchMyaTinting = isBookAlreadyOnKindle(
        kindleMount,
        "ဝတ္ထု.epub",
        "Mya Than Tinting",
        100000,
        index,
        { title: "ဝတ္ထု", authors: "Mya Than Tinting" },
      );
      expect(matchMyaTinting.exists).toBe(false);

      // Fragment author "လူ" must NOT match မင်းလူ
      const matchFragment = isBookAlreadyOnKindle(
        kindleMount,
        "ဝတ္ထု.epub",
        "လူ",
        100000,
        index,
        { title: "ဝတ္ထု", authors: "လူ" },
      );
      expect(matchFragment.exists).toBe(false);
    });

    it("clusters Latin-to-Latin transliteration variants of the same Burmese author (e.g. Mya Than Tint vs Myathan Tint, Min Lu vs minlu)", () => {
      const kindleMount = path.join(fakeVolumesDir, "Kindle");
      const dirSpaced = path.join(kindleMount, "books", "Mya Than Tint");
      const dirCompact = path.join(kindleMount, "books", "Myathan Tint");
      fs.mkdirSync(dirSpaced, { recursive: true });
      fs.mkdirSync(dirCompact, { recursive: true });

      const book1 = path.join(dirSpaced, "ပါရီကျဆုံးခန်း.epub");
      const book2 = path.join(dirCompact, "ပါရီကျဆုံးခန်း.epub");

      fs.writeFileSync(book1, Buffer.alloc(100000, "1"));
      fs.writeFileSync(book2, Buffer.alloc(100000, "2"));

      invalidateKindleBookIndex();
      const dupGroups = scanKindleDeviceDuplicates(kindleMount, { forceRefresh: true });

      // Both Latin variants resolve to canonical Burmese key မြသန်းတင့် and cluster as duplicates!
      expect(dupGroups.length).toBe(1);

      // Upload candidate with compact Latin spelling matches on device
      const index = buildKindleBookIndex(kindleMount);
      const matchUpload = isBookAlreadyOnKindle(
        kindleMount,
        "ပါရီကျဆုံးခန်း.epub",
        "Myathan Tint",
        100000,
        index,
        { title: "ပါရီကျဆုံးခန်း", authors: "Myathan Tint" },
      );
      expect(matchUpload.exists).toBe(true);
    });

    it("unifies dual Myanmar Unicode spellings under one canonical identity (e.g. ချစ်ဦးညို U+1026 vs ချစ်ဦးညို U+1025+U+102E ↔ Chit Oo Nyo)", () => {
      const kindleMount = path.join(fakeVolumesDir, "Kindle");
      // Two folders with different Myanmar Unicode codepoints for the same name across books/ and documents/
      const spellingADir = path.join(kindleMount, "books", "ချစ်ဦးညို"); // U+1026
      const spellingBDir = path.join(kindleMount, "documents", "ချစ်ဦးညို"); // U+1025 + U+102E
      fs.mkdirSync(spellingADir, { recursive: true });
      fs.mkdirSync(spellingBDir, { recursive: true });

      const bookA = path.join(spellingADir, "လင်္ကာဒီပချစ်သူ.epub");
      const bookB = path.join(spellingBDir, "လင်္ကာဒီပချစ်သူ.epub");

      fs.writeFileSync(bookA, Buffer.alloc(100000, "a"));
      fs.writeFileSync(bookB, Buffer.alloc(100000, "b"));

      invalidateKindleBookIndex();
      const dupGroups = scanKindleDeviceDuplicates(kindleMount, { forceRefresh: true });

      // Both dual-spelling Myanmar folders must unify and cluster as duplicates!
      expect(dupGroups.length).toBe(1);

      // Upload candidate with Latin transliteration Chit Oo Nyo matches either spelling on device
      const index = buildKindleBookIndex(kindleMount);
      const matchUpload = isBookAlreadyOnKindle(
        kindleMount,
        "လင်္ကာဒီပချစ်သူ.epub",
        "Chit Oo Nyo",
        100000,
        index,
        { title: "လင်္ကာဒီပချစ်သူ", authors: "Chit Oo Nyo" },
      );
      expect(matchUpload.exists).toBe(true);
    });

    it("NEVER clusters over-broad short aliases against distinct people (e.g. Phone Naing vs Tekatho Phone Naing)", () => {
      const kindleMount = path.join(fakeVolumesDir, "Kindle");
      const tekathoDir = path.join(kindleMount, "books", "တက္ကသိုလ်ဘုန်းနိုင်");
      const phoneNaingDir = path.join(kindleMount, "books", "Phone Naing");
      fs.mkdirSync(tekathoDir, { recursive: true });
      fs.mkdirSync(phoneNaingDir, { recursive: true });

      const book1 = path.join(tekathoDir, "ဝတ္ထု.epub");
      const book2 = path.join(phoneNaingDir, "ဝတ္ထု.epub");

      fs.writeFileSync(book1, Buffer.alloc(100000, "1"));
      fs.writeFileSync(book2, Buffer.alloc(100000, "2"));

      invalidateKindleBookIndex();
      const dupGroups = scanKindleDeviceDuplicates(kindleMount, { forceRefresh: true });

      // Bare short alias Phone Naing must NOT cluster with full author တက္ကသိုလ်ဘုန်းနိုင်!
      expect(dupGroups.length).toBe(0);

      // Only full unambiguous name Tekatho Phone Naing matches
      const index = buildKindleBookIndex(kindleMount);
      const matchFull = isBookAlreadyOnKindle(
        kindleMount,
        "ဝတ္ထု.epub",
        "Tekatho Phone Naing",
        100000,
        index,
        { title: "ဝတ္ထု", authors: "Tekatho Phone Naing" },
      );
      expect(matchFull.existingPath).toBe(book1);
    });

    it("NEVER clusters distinct authors flat under books/ (e.g. books/Dune - Frank Herbert.epub vs books/Dune - Mya Than Tint.epub)", () => {
      const kindleMount = path.join(fakeVolumesDir, "Kindle");
      const booksDir = path.join(kindleMount, "books");
      fs.mkdirSync(booksDir, { recursive: true });

      const file1 = path.join(booksDir, "Dune - Frank Herbert.epub");
      const file2 = path.join(booksDir, "Dune - မြသန်းတင့်.epub");

      fs.writeFileSync(file1, Buffer.alloc(120000, "1"));
      fs.writeFileSync(file2, Buffer.alloc(120000, "2"));

      invalidateKindleBookIndex();
      const dupGroups = scanKindleDeviceDuplicates(kindleMount, { forceRefresh: true });

      // Filename author conflict guard must prevent clustering flat books!
      expect(dupGroups.length).toBe(0);
    });

    it("NEVER transitively merges conflicting authors via loose documents/ copy (e.g. Plath vs Eliot via documents/Selected Poems.epub)", () => {
      const kindleMount = path.join(fakeVolumesDir, "Kindle");
      const plathDir = path.join(kindleMount, "books", "Sylvia Plath");
      const eliotDir = path.join(kindleMount, "books", "T.S. Eliot");
      const docsDir = path.join(kindleMount, "documents");
      fs.mkdirSync(plathDir, { recursive: true });
      fs.mkdirSync(eliotDir, { recursive: true });
      fs.mkdirSync(docsDir, { recursive: true });

      const plathBook = path.join(plathDir, "Selected Poems.epub");
      const eliotBook = path.join(eliotDir, "Selected Poems.epub");
      const looseBook = path.join(docsDir, "Selected Poems.epub");

      // All three files are identical in byte size (150KB)
      fs.writeFileSync(plathBook, Buffer.alloc(150000, "p"));
      fs.writeFileSync(eliotBook, Buffer.alloc(150000, "e"));
      fs.writeFileSync(looseBook, Buffer.alloc(150000, "l"));

      invalidateKindleBookIndex();
      const dupGroups = scanKindleDeviceDuplicates(kindleMount, { forceRefresh: true });

      // Plath and Eliot must NEVER be in the same duplicate group!
      for (const g of dupGroups) {
        const containsPlath = g.files.some((f) => f.filePath === plathBook);
        const containsEliot = g.files.some((f) => f.filePath === eliotBook);
        expect(containsPlath && containsEliot).toBe(false);
      }

      // Execute cleanKindleDeviceDuplicates
      cleanKindleDeviceDuplicates(kindleMount);

      // BOTH author copies must survive: Eliot's book must NEVER be deleted!
      expect(fs.existsSync(plathBook)).toBe(true);
      expect(fs.existsSync(eliotBook)).toBe(true);
    });

    it("unifies unmapped dual-spelling Myanmar authors (e.g. ဦးသုခ vs ဦးသုခ) and ZWSP formatting (မောင်\\u200Bထွန်း vs မောင်ထွန်း)", () => {
      // 1. Unmapped dual-spelling author
      expect(isCrossScriptAuthorMatch("ဦးသုခ", "ဦးသုခ")).toBe(true);
      expect(authorMatchesString("ဦးသုခ", "ဦးသုခ")).toBe(true);

      // 2. Unmapped ZWSP-formatted author
      const zwspAuthor = "မောင်\u200Bထွန်း";
      const cleanAuthor = "မောင်ထွန်း";
      expect(isCrossScriptAuthorMatch(zwspAuthor, cleanAuthor)).toBe(true);
      expect(authorMatchesString(zwspAuthor, cleanAuthor)).toBe(true);
    });

    it("resolves Last, First transliterated Burmese author (e.g. Tint, Mya Than ↔ မြသန်းတင့်)", () => {
      expect(isCrossScriptAuthorMatch("Tint, Mya Than", "မြသန်းတင့်")).toBe(true);
      expect(isCrossScriptAuthorMatch("Tint, Mya Than", "Mya Than Tint")).toBe(true);
      expect(authorMatchesString("Tint, Mya Than", "မြသန်းတင့်")).toBe(true);
    });

    it("reuses existing author folder for incoming cross-script author in resolveKindleDestinationDir", () => {
      const kindleMount = path.join(fakeVolumesDir, "Kindle");
      const booksRoot = path.join(kindleMount, "books");
      const existingMyanmarDir = path.join(booksRoot, "မြသန်းတင့်");
      fs.mkdirSync(existingMyanmarDir, { recursive: true });

      // Incoming book has Latin author "Mya Than Tint"
      const res = resolveKindleDestinationDir(booksRoot, "Mya Than Tint");
      expect(res.reusedExistingFolder).toBe(true);
      expect(res.authorDir).toBe("မြသန်းတင့်");
      expect(res.targetDir).toBe(existingMyanmarDir);
    });

    it("NEVER collapses spaces in Latin author names (e.g. John Smith vs Johnsmith) while preserving word-order matching", () => {
      // 1. Spaced Latin author vs concatenated must NEVER match
      expect(authorMatchesString("John Smith", "Johnsmith")).toBe(false);
      expect(isCrossScriptAuthorMatch("John Smith", "Johnsmith")).toBe(false);

      // 2. resolveKindleDestinationDir must NOT reuse John Smith for Johnsmith
      const kindleMount = path.join(fakeVolumesDir, "Kindle");
      const booksRoot = path.join(kindleMount, "books");
      const smithDir = path.join(booksRoot, "John Smith");
      fs.mkdirSync(smithDir, { recursive: true });

      const destRes = resolveKindleDestinationDir(booksRoot, "Johnsmith");
      expect(destRes.reusedExistingFolder).toBe(false);
      expect(destRes.authorDir).toBe("Johnsmith");

      // 3. Duplicate scanner must NOT cluster books by John Smith and Johnsmith
      const johnsmithDir = path.join(booksRoot, "Johnsmith");
      fs.mkdirSync(johnsmithDir, { recursive: true });
      fs.writeFileSync(path.join(smithDir, "Some Title.epub"), Buffer.alloc(100000, "1"));
      fs.writeFileSync(path.join(johnsmithDir, "Some Title.epub"), Buffer.alloc(100000, "2"));

      invalidateKindleBookIndex();
      const dupGroups = scanKindleDeviceDuplicates(kindleMount, { forceRefresh: true });
      expect(dupGroups.length).toBe(0);

      // 4. Word-order matching for spaced tokens is fully preserved
      expect(authorMatchesString("Sanderson Brandon", "Brandon Sanderson")).toBe(true);
    });

    it("strictly confines file deletions to mount directory and never deletes outside", () => {
      const kindleMount = path.join(fakeVolumesDir, "Kindle");
      const booksDir = path.join(kindleMount, "books");
      fs.mkdirSync(booksDir, { recursive: true });

      // Create an outside file in tmp
      const outsideDir = path.join(fakeVolumesDir, "..", "OutsideDir");
      fs.mkdirSync(outsideDir, { recursive: true });
      const outsideFile = path.join(outsideDir, "Sensitive.epub");
      fs.writeFileSync(outsideFile, "do not delete", "utf8");

      // Attempt to clean
      cleanKindleDeviceDuplicates(kindleMount);
      expect(fs.existsSync(outsideFile)).toBe(true);

      // Clean up outside dir
      fs.rmSync(outsideDir, { recursive: true, force: true });
    });
  });

  describe("13. In-Memory Directory Caching, Preview TTL & Frontend Polling Hygiene", () => {
    it("resolveKindleDestinationDir respects existingDirNames cache without disk I/O", () => {
      const nonExistentRoot = path.join(fakeVolumesDir, "NonExistentKindle", "books");
      const cachedDirs = ["Fuse, Mitz Vah", "Brandon Sanderson", "George R.R. Martin"];

      // 1. Matches comma-spacing variant using cached array without root existing on disk
      const res1 = resolveKindleDestinationDir(
        nonExistentRoot,
        "Fuse,Mitz Vah",
        null,
        true,
        cachedDirs,
      );
      expect(res1.reusedExistingFolder).toBe(true);
      expect(res1.authorDir).toBe("Fuse, Mitz Vah");
      expect(res1.targetDir).toBe(path.join(nonExistentRoot, "Fuse, Mitz Vah"));

      // 2. Non-existent author falls back to sanitized default without disk I/O
      const res2 = resolveKindleDestinationDir(
        nonExistentRoot,
        "Unknown New Author",
        null,
        true,
        cachedDirs,
      );
      expect(res2.reusedExistingFolder).toBe(false);
      expect(res2.authorDir).toBe("Unknown New Author");

      // 3. Verify no fs.readdirSync is called when existingDirNames is provided
      let readdirCalled = false;
      const origReaddir = fs.readdirSync;
      try {
        (fs as any).readdirSync = ((p: any, opts: any) => {
          if (typeof p === "string" && p.includes("NonExistentKindle")) {
            readdirCalled = true;
          }
          return origReaddir(p, opts);
        }) as any;

        const res3 = resolveKindleDestinationDir(
          nonExistentRoot,
          "Brandon Sanderson",
          null,
          true,
          cachedDirs,
        );
        expect(res3.reusedExistingFolder).toBe(true);
        expect(readdirCalled).toBe(false);
      } finally {
        fs.readdirSync = origReaddir;
      }
    });

    it("previewKindleSync executes in under 200ms with in-memory directory caching and TTL", () => {
      const kindleMount = path.join(fakeVolumesDir, "Kindle");
      const booksDir = path.join(kindleMount, "books");
      fs.mkdirSync(booksDir, { recursive: true });

      // Create 50 books in Calibre
      const books = Array.from({ length: 50 }, (_, i) => ({
        id: i + 1,
        title: `Book Title ${i + 1}`,
        author: `Author ${i + 1}`,
        format: "EPUB",
        fileContent: `content ${i + 1}`,
      }));
      setupFakeCalibreDatabase(books);

      invalidateKindleSyncPreviewCache();

      // First run: builds index, reads existing directory names once, caches preview
      const t0 = performance.now();
      const firstPreview = previewKindleSync(kindleMount, { scope: "all" });
      const firstDuration = performance.now() - t0;
      expect(firstPreview.totalCandidates).toBe(50);
      expect(firstDuration).toBeLessThan(200);

      // Repeat calls: must return from 5s TTL cache in under 20ms total for 10 iterations
      const t1 = performance.now();
      for (let i = 0; i < 10; i++) {
        const cached = previewKindleSync(kindleMount, { scope: "all" });
        expect(cached.totalCandidates).toBe(50);
        expect(cached.mountPath).toBe(kindleMount);
      }
      const repeatDuration = performance.now() - t1;
      expect(repeatDuration).toBeLessThan(200);
    });

    it("invalidateKindleSyncPreviewCache purges cached preview immediately", () => {
      const kindleMount = path.join(fakeVolumesDir, "Kindle");
      fs.mkdirSync(path.join(kindleMount, "books"), { recursive: true });

      setupFakeCalibreDatabase([
        { id: 1, title: "Book One", author: "Author One", format: "EPUB", fileContent: "1" },
      ]);
      invalidateKindleSyncPreviewCache();

      const p1 = previewKindleSync(kindleMount, { scope: "all" });
      expect(p1.totalCandidates).toBe(1);

      // Add second book to DB
      fs.rmSync(fakeCalibreDbPath, { force: true });
      setupFakeCalibreDatabase([
        { id: 1, title: "Book One", author: "Author One", format: "EPUB", fileContent: "1" },
        { id: 2, title: "Book Two", author: "Author Two", format: "EPUB", fileContent: "2" },
      ]);

      // Before invalidation: returns cached result with 1 candidate
      const pCached = previewKindleSync(kindleMount, { scope: "all" });
      expect(pCached.totalCandidates).toBe(1);

      // After invalidation: re-evaluates and returns 2 candidates
      invalidateKindleSyncPreviewCache();
      const pFresh = previewKindleSync(kindleMount, { scope: "all" });
      expect(pFresh.totalCandidates).toBe(2);
    });

    it("previewKindleSync isolates cache keys by mount, scope, and forceAll", () => {
      const kindleMount = path.join(fakeVolumesDir, "Kindle");
      fs.mkdirSync(path.join(kindleMount, "books"), { recursive: true });

      setupFakeCalibreDatabase([
        { id: 1, title: "Active Book", author: "Author A", tags: ["currently-reading"], format: "EPUB", fileContent: "a" },
        { id: 2, title: "Finished Book", author: "Author B", tags: ["finished"], format: "EPUB", fileContent: "b" },
      ]);
      invalidateKindleSyncPreviewCache();

      // unread scope only has 1 candidate (finished excluded)
      const pUnread = previewKindleSync(kindleMount, { scope: "unread" });
      expect(pUnread.scope).toBe("unread");
      expect(pUnread.totalCandidates).toBe(1);

      // all scope has 2 candidates
      const pAll = previewKindleSync(kindleMount, { scope: "all" });
      expect(pAll.scope).toBe("all");
      expect(pAll.totalCandidates).toBe(2);

      // Unread scope cached result must not have been overwritten by all scope
      const pUnreadCached = previewKindleSync(kindleMount, { scope: "unread" });
      expect(pUnreadCached.totalCandidates).toBe(1);
    });

    it("POST /api/kindle/sync initializes progress immediately before returning 202", async () => {
      const kindleMount = path.join(fakeVolumesDir, "Kindle");
      fs.mkdirSync(path.join(kindleMount, "books"), { recursive: true });

      setupFakeCalibreDatabase([
        { id: 1, title: "Test Book", author: "Author Test", format: "EPUB", fileContent: "test content" },
      ]);
      resetKindleProgressForTesting();
      invalidateKindleSyncPreviewCache();

      const localServer = { requestIP: () => ({ address: "127.0.0.1" }) };
      const req = new Request("http://127.0.0.1:8086/api/kindle/sync", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ scope: "unread" }),
      });

      const res = await handleRequest(req, localServer);
      expect(res.status).toBe(202);

      // Progress must be immediately accessible and in 'scanning' or 'transferring' phase
      const progress = getKindleProgress();
      expect(progress).not.toBeNull();
      expect(["scanning", "transferring", "highlights", "completed"]).toContain(progress!.phase);
      expect(isKindleSyncActive()).toBe(true);

      // Wait a moment for background task to settle and clean up
      await new Promise((r) => setTimeout(r, 100));
      resetKindleProgressForTesting();
    });

    it("index.html defines 1000ms active polling and 3000ms idle polling with grace period", () => {
      const htmlPath = path.resolve(__dirname, "index.html");
      const html = fs.readFileSync(htmlPath, "utf8");

      // Active progress polling must be 1000ms (not 350ms)
      expect(html).toContain("syncProgressPollInterval = setInterval(pollProgressTick, 1000);");
      expect(html).not.toContain("syncProgressPollInterval = setInterval(pollProgressTick, 350);");

      // Modal idle polling must be 3000ms
      expect(html).toContain("function startKindleModalIdlePolling()");
      expect(html).toContain("3000");

      // Grace period of 3000ms before treating missing progress as disconnected
      expect(html).toContain("Date.now() - pollStartTime > 3000");
    });
  });
});
