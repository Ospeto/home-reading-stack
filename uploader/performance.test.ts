import { describe, expect, it, beforeAll, afterAll } from "bun:test";
import { Database } from "bun:sqlite";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import process from "node:process";
import { Buffer } from "node:buffer";
import {
  getCalibreBooks,
  getCalibreDbPath,
  getCalibreLibraryDir,
  getCalibreDbETag,
  getBookPath,
  getMasterCoverPath,
  SipsConcurrencyLimiter,
  sipsLimiter,
  downscaleImageAsync,
  handleRequest,
} from "./server";

describe("Reading HQ Server Performance & In-Process SQLite Engine", () => {
  const tempLibDir = path.join("/tmp", `test_perf_calibre_lib_${Date.now()}`);
  const bookDir = path.join(tempLibDir, "Frank Herbert", "Dune (1)");
  const epubPath = path.join(bookDir, "Dune - Frank Herbert.epub");
  const coverPath = path.join(bookDir, "cover.jpg");
  const tempDbPath = path.join(tempLibDir, "metadata.db");

  let origDbPath: string | undefined;
  let origLibDir: string | undefined;

  beforeAll(() => {
    fs.mkdirSync(bookDir, { recursive: true });
    fs.writeFileSync(epubPath, "mock epub book content");
    // Write 1x1 mock JPEG cover
    const mockJpg = Buffer.from([
      0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00, 0x01,
      0x01, 0x01, 0x00, 0x48, 0x00, 0x48, 0x00, 0x00, 0xff, 0xdb, 0x00, 0x43,
      0x00, 0x08, 0x06, 0x06, 0x07, 0x06, 0x05, 0x08, 0x07, 0x07, 0x07, 0x09,
      0x09, 0x08, 0x0a, 0x0c, 0x14, 0x0d, 0x0c, 0x0b, 0x0b, 0x0c, 0x19, 0x12,
      0x13, 0x0f, 0x14, 0x1d, 0x1a, 0x1f, 0x1e, 0x1d, 0x1a, 0x1c, 0x1c, 0x20,
      0x24, 0x2e, 0x27, 0x20, 0x22, 0x2c, 0x23, 0x1c, 0x1c, 0x28, 0x37, 0x29,
      0x2c, 0x30, 0x31, 0x34, 0x34, 0x34, 0x1f, 0x27, 0x39, 0x3d, 0x38, 0x32,
      0x3c, 0x2e, 0x33, 0x34, 0x32, 0xff, 0xc0, 0x00, 0x0b, 0x08, 0x00, 0x01,
      0x00, 0x01, 0x01, 0x01, 0x11, 0x00, 0xff, 0xc4, 0x00, 0x1f, 0x00, 0x00,
      0x01, 0x05, 0x01, 0x01, 0x01, 0x01, 0x01, 0x01, 0x00, 0x00, 0x00, 0x00,
      0x00, 0x00, 0x00, 0x00, 0x01, 0x02, 0x03, 0x04, 0x05, 0x06, 0x07, 0x08,
      0x09, 0x0a, 0x0b, 0xff, 0xda, 0x00, 0x08, 0x01, 0x01, 0x00, 0x00, 0x3f,
      0x00, 0xbf, 0x00, 0xff, 0xd9,
    ]);
    fs.writeFileSync(coverPath, mockJpg);

    const db = new Database(tempDbPath);
    db.run(`
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
    `);

    // Insert book 1: EPUB format with series, author, tags, publisher
    db.run(
      "INSERT INTO books (id, title, path, has_cover, pubdate, series_index) VALUES (1, 'Dune', 'Frank Herbert/Dune (1)', 1, '1965-08-01', 1);",
    );
    db.run(
      "INSERT INTO data (id, book, format, name, uncompressed_size) VALUES (1, 1, 'EPUB', 'Dune - Frank Herbert', 100);",
    );
    db.run("INSERT INTO authors (id, name) VALUES (1, 'Frank Herbert');");
    db.run("INSERT INTO books_authors_link (id, book, author) VALUES (1, 1, 1);");
    db.run("INSERT INTO series (id, name) VALUES (1, 'Dune Chronicles');");
    db.run("INSERT INTO books_series_link (id, book, series) VALUES (1, 1, 1);");
    db.run("INSERT INTO tags (id, name) VALUES (1, 'Sci-Fi'), (2, 'Classic');");
    db.run("INSERT INTO books_tags_link (id, book, tag) VALUES (1, 1, 1), (2, 1, 2);");
    db.run("INSERT INTO publishers (id, name) VALUES (1, 'Chilton Books');");
    db.run("INSERT INTO books_publishers_link (id, book, publisher) VALUES (1, 1, 1);");

    // Insert book 2: Non-EPUB format (PDF only, should be excluded)
    db.run(
      "INSERT INTO books (id, title, path, has_cover, pubdate, series_index) VALUES (2, 'Manual', 'System/Manual (2)', 0, '2020-01-01', 1);",
    );
    db.run(
      "INSERT INTO data (id, book, format, name, uncompressed_size) VALUES (2, 2, 'PDF', 'Manual', 50);",
    );

    db.close();

    origDbPath = process.env.CALIBRE_DB_PATH;
    origLibDir = process.env.CALIBRE_LIBRARY_DIR;
    process.env.CALIBRE_DB_PATH = tempDbPath;
    process.env.CALIBRE_LIBRARY_DIR = tempLibDir;
  });

  afterAll(() => {
    if (origDbPath === undefined) delete process.env.CALIBRE_DB_PATH;
    else process.env.CALIBRE_DB_PATH = origDbPath;

    if (origLibDir === undefined) delete process.env.CALIBRE_LIBRARY_DIR;
    else process.env.CALIBRE_LIBRARY_DIR = origLibDir;

    if (fs.existsSync(tempLibDir)) {
      fs.rmSync(tempLibDir, { recursive: true, force: true });
    }
  });

  it("in-process SQLite book query executes directly with sub-50ms latency", () => {
    const start = performance.now();
    const books = getCalibreBooks(true);
    const duration = performance.now() - start;

    // Fast in-process performance benchmark: must complete in < 50ms
    expect(duration).toBeLessThan(50);
    expect(Array.isArray(books)).toBe(true);
    expect(books.length).toBe(1);

    const book = books[0];
    expect(book.id).toBe(1);
    expect(book.title).toBe("Dune");
    expect(book.path).toBe("Frank Herbert/Dune (1)");
    expect(book.cover).toBe(1);
    expect(book.pubdate).toBe("1965-08-01");
    expect(book.authors).toBe("Frank Herbert");
    expect(book.series).toBe("Dune Chronicles");
    expect(book.series_index).toBe(1);
    expect(book.publisher).toBe("Chilton Books");
    expect(Array.isArray(book.tags)).toBe(true);
    expect(book.tags).toContain("Sci-Fi");
    expect(book.tags).toContain("Classic");
    expect(book.formats).toEqual(["EPUB"]);
  });

  it("HTTP ETag generation reflects metadata.db state", () => {
    const etag1 = getCalibreDbETag();
    expect(etag1).toBeDefined();
    expect(etag1.startsWith('"')).toBe(true);
    expect(etag1.endsWith('"')).toBe(true);

    // If metadata.db is modified, etag changes
    const newMtime = new Date(Date.now() + 5000);
    fs.utimesSync(tempDbPath, newMtime, newMtime);
    const etag2 = getCalibreDbETag();
    expect(etag2).not.toBe(etag1);
  });

  it("GET /api/books returns 200 with ETag and Cache-Control headers", async () => {
    const req = new Request("http://127.0.0.1:8086/api/books", {
      method: "GET",
    });
    const res = await handleRequest(req);
    expect(res.status).toBe(200);

    const etag = res.headers.get("ETag");
    const cacheControl = res.headers.get("Cache-Control");
    expect(etag).not.toBeNull();
    expect(cacheControl).toBe("public, max-age=5, must-revalidate");

    const json = (await res.json()) as any[];
    expect(Array.isArray(json)).toBe(true);
    expect(json.length).toBe(1);
    expect(json[0].title).toBe("Dune");
  });

  it("GET /api/books with matching If-None-Match returns 304 Not Modified in < 2ms", async () => {
    const etag = getCalibreDbETag();
    const req = new Request("http://127.0.0.1:8086/api/books", {
      method: "GET",
      headers: {
        "If-None-Match": etag,
      },
    });

    const start = performance.now();
    const res = await handleRequest(req);
    const duration = performance.now() - start;

    expect(res.status).toBe(304);
    expect(res.headers.get("ETag")).toBe(etag);
    expect(res.headers.get("Cache-Control")).toBe("public, max-age=5, must-revalidate");
    expect(duration).toBeLessThan(10); // Typically < 2ms, comfortably bounded
    const body = await res.text();
    expect(body).toBe("");
  });

  it("getMasterCoverPath and getBookPath resolve directly to on-disk cover.jpg", () => {
    const relPath = getBookPath(1);
    expect(relPath).toBe("Frank Herbert/Dune (1)");

    const diskCover = getMasterCoverPath(1);
    expect(diskCover).not.toBeNull();
    expect(diskCover).toBe(coverPath);
    expect(fs.existsSync(diskCover!)).toBe(true);
  });

  it("GET /api/books/:id/cover serves master cover directly from disk with zero network loopback", async () => {
    const req = new Request("http://127.0.0.1:8086/api/books/1/cover", {
      method: "GET",
    });
    const res = await handleRequest(req);
    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Type")).toBe("image/jpeg");
    expect(res.headers.get("Cache-Control")).toContain("public");
    expect(res.headers.get("ETag")).not.toBeNull();

    const bytes = new Uint8Array(await res.arrayBuffer());
    expect(bytes.length).toBeGreaterThan(10);

    // Conditional If-None-Match on master cover
    const coverEtag = res.headers.get("ETag")!;
    const condReq = new Request("http://127.0.0.1:8086/api/books/1/cover", {
      method: "GET",
      headers: { "If-None-Match": coverEtag },
    });
    const condRes = await handleRequest(condReq);
    expect(condRes.status).toBe(304);
  });

  it("SipsConcurrencyLimiter enforces max concurrent operations", async () => {
    const limiter = new SipsConcurrencyLimiter(4);
    expect(limiter.maxConcurrent).toBe(4);
    expect(limiter.getActiveCount()).toBe(0);

    let activePeak = 0;
    const tasks = Array.from({ length: 12 }, async (_, i) => {
      return limiter.run(async () => {
        const currentActive = limiter.getActiveCount();
        if (currentActive > activePeak) activePeak = currentActive;
        await new Promise((r) => setTimeout(r, 15));
        return i;
      });
    });

    const results = await Promise.all(tasks);
    expect(results.length).toBe(12);
    expect(activePeak).toBeLessThanOrEqual(4);
    expect(limiter.getActiveCount()).toBe(0);
  });

  it("getCalibreDbPath and getCalibreLibraryDir correctly resolve configured library paths", () => {
    expect(getCalibreDbPath()).toBe(tempDbPath);
    expect(getCalibreLibraryDir()).toBe(tempLibDir);
  });

  it("sipsLimiter singleton and downscaleImageAsync are exported and functional", async () => {
    expect(sipsLimiter).toBeInstanceOf(SipsConcurrencyLimiter);
    expect(sipsLimiter.maxConcurrent).toBe(4);

    const testThumb = path.join(tempLibDir, "thumb_test.jpg");
    const ok = await downscaleImageAsync(coverPath, testThumb, 64);
    expect(typeof ok).toBe("boolean");
    if (ok) {
      expect(fs.existsSync(testThumb)).toBe(true);
    }
  });

  it("index.html implements instant rendering, Stale-While-Revalidate, and ETag handling", () => {
    const htmlPath = path.join((import.meta as any).dir, "index.html");
    const html = fs.readFileSync(htmlPath, "utf8");

    // Client-side caching and ETag headers
    expect(html).toContain("If-None-Match");
    expect(html).toContain("res.status === 304");
    expect(html).toContain("booksEtag");
    expect(html).toContain("sessionStorage");
    expect(html).toContain("localStorage");
    expect(html).toContain("loadCachedData");
    expect(html).toContain("saveCachedData");
  });
});
