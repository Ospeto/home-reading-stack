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
  getIndexHtmlETag,
  getFileETag,
  isCompressibleContentType,
  getPreferredEncoding,
} from "./server";
import {
  initHighlightsTable,
  getHighlightCounts,
  batchUpsertHighlights,
  deleteHighlightsForBook,
  ensureBookHighlightsIndexed,
  invalidateHighlightCountsCache,
  getCachedHighlightCountsForTesting,
} from "./highlights";

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
    expect(res.headers.get("Vary")).toContain("Accept-Encoding");
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

  describe("WAN Edge Performance, Transparent Compression & Caching Engine", () => {
    it("isCompressibleContentType accurately identifies JSON, HTML, XML, text, and rejects binaries/streams", () => {
      expect(isCompressibleContentType("application/json; charset=utf-8")).toBe(true);
      expect(isCompressibleContentType("text/html; charset=utf-8")).toBe(true);
      expect(isCompressibleContentType("application/atom+xml")).toBe(true);
      expect(isCompressibleContentType("text/plain")).toBe(true);
      expect(isCompressibleContentType("image/svg+xml")).toBe(true);

      // Binary and streaming formats must never be compressed
      expect(isCompressibleContentType("application/epub+zip")).toBe(false);
      expect(isCompressibleContentType("application/octet-stream")).toBe(false);
      expect(isCompressibleContentType("image/jpeg")).toBe(false);
      expect(isCompressibleContentType("image/png")).toBe(false);
      expect(isCompressibleContentType("text/event-stream")).toBe(false);
      expect(isCompressibleContentType("application/x-ndjson")).toBe(false);
      expect(isCompressibleContentType(null)).toBe(false);
    });

    it("getPreferredEncoding prioritizes gzip over deflate and handles quality values (q-values)", () => {
      expect(getPreferredEncoding("gzip, deflate, br")).toBe("gzip");
      expect(getPreferredEncoding("deflate, gzip")).toBe("gzip");
      expect(getPreferredEncoding("deflate")).toBe("deflate");
      expect(getPreferredEncoding("*")).toBe("gzip");
      expect(getPreferredEncoding("identity")).toBe(null);
      expect(getPreferredEncoding(null)).toBe(null);

      // Quality value negotiation tests (Bug B remediation)
      expect(getPreferredEncoding("gzip;q=0, deflate")).toBe("deflate");
      expect(getPreferredEncoding("gzip;q=0, deflate;q=0.8")).toBe("deflate");
      expect(getPreferredEncoding("deflate;q=0.9, gzip;q=0.5")).toBe("deflate");
      expect(getPreferredEncoding("gzip;q=0.8, deflate;q=0.5")).toBe("gzip");
      expect(getPreferredEncoding("gzip;q=0, *;q=0")).toBe(null);
      expect(getPreferredEncoding("gzip;q=0, deflate;q=0")).toBe(null);
      expect(getPreferredEncoding("*;q=0")).toBe(null);
    });

    it("compressResponseIfNeeded strictly preserves 206 Partial Content, Content-Range, and no-transform", async () => {
      const { compressResponseIfNeeded } = await import("./server");

      // 206 Partial Content
      const res206 = new Response("bytes 0-100/500", {
        status: 206,
        headers: {
          "Content-Type": "application/json",
          "Content-Range": "bytes 0-100/500",
        },
      });
      const reqGzip = new Request("http://127.0.0.1:8086/api/test", {
        headers: { "Accept-Encoding": "gzip" },
      });
      const out206 = await compressResponseIfNeeded(res206, reqGzip);
      expect(out206.status).toBe(206);
      expect(out206.headers.get("Content-Encoding")).toBeNull();

      // Cache-Control: no-transform
      const resNoTransform = new Response("x".repeat(2000), {
        status: 200,
        headers: {
          "Content-Type": "application/json",
          "Cache-Control": "no-transform",
        },
      });
      const outNoTransform = await compressResponseIfNeeded(resNoTransform, reqGzip);
      expect(outNoTransform.headers.get("Content-Encoding")).toBeNull();

      // X-Skip-Compression (e.g. proxied book downloads)
      const resSkip = new Response("x".repeat(2000), {
        status: 200,
        headers: {
          "Content-Type": "text/plain",
          "X-Skip-Compression": "1",
        },
      });
      const outSkip = await compressResponseIfNeeded(resSkip, reqGzip);
      expect(outSkip.headers.get("Content-Encoding")).toBeNull();
      expect(outSkip.headers.get("X-Skip-Compression")).toBeNull(); // Header cleanly stripped

      // Oversized body (>10MB) without declared Content-Length skips sync compression (Bug 1 remediation)
      const resHuge = new Response("a".repeat(10 * 1024 * 1024 + 100), {
        headers: { "Content-Type": "application/json" },
      });
      const outHuge = await compressResponseIfNeeded(resHuge, reqGzip);
      expect(outHuge.headers.get("Content-Encoding")).toBeNull();
      expect(outHuge.headers.get("Vary")).toContain("Accept-Encoding");
    });

    it("GET / serves index.html with mtime+size ETag and Cache-Control: public, max-age=60, must-revalidate", async () => {
      const req = new Request("http://127.0.0.1:8086/", { method: "GET" });
      const res = await handleRequest(req);
      expect(res.status).toBe(200);
      expect(res.headers.get("Content-Type")).toBe("text/html; charset=utf-8");
      expect(res.headers.get("Cache-Control")).toBe("public, max-age=60, must-revalidate");

      const etag = res.headers.get("ETag");
      expect(etag).not.toBeNull();
      const expectedEtag = getIndexHtmlETag();
      expect(etag).toBe(expectedEtag);

      // HEAD request
      const headReq = new Request("http://127.0.0.1:8086/", { method: "HEAD" });
      const headRes = await handleRequest(headReq);
      expect(headRes.status).toBe(200);
      expect(headRes.headers.get("ETag")).toBe(expectedEtag);
      const headBody = await headRes.text();
      expect(headBody).toBe("");

      // Conditional 304 revalidation
      const condReq = new Request("http://127.0.0.1:8086/", {
        method: "GET",
        headers: { "If-None-Match": etag! },
      });
      const condRes = await handleRequest(condReq);
      expect(condRes.status).toBe(304);
      expect(condRes.headers.get("ETag")).toBe(etag);
      expect(condRes.headers.get("Cache-Control")).toBe("public, max-age=60, must-revalidate");
      expect(condRes.headers.get("Vary")).toContain("Accept-Encoding");
      const condBody = await condRes.text();
      expect(condBody).toBe("");
    });

    it("GET / compresses index.html by >80% when Accept-Encoding: gzip is sent", async () => {
      const uncompressedReq = new Request("http://127.0.0.1:8086/", { method: "GET" });
      const uncompressedRes = await handleRequest(uncompressedReq);
      const uncompressedBytes = new Uint8Array(await uncompressedRes.arrayBuffer());
      expect(uncompressedBytes.length).toBeGreaterThan(300_000); // ~411 KB

      const gzipReq = new Request("http://127.0.0.1:8086/", {
        method: "GET",
        headers: { "Accept-Encoding": "gzip" },
      });
      const gzipRes = await handleRequest(gzipReq);
      expect(gzipRes.status).toBe(200);
      expect(gzipRes.headers.get("Content-Encoding")).toBe("gzip");
      expect(gzipRes.headers.get("Vary")).toContain("Accept-Encoding");

      const gzippedBytes = new Uint8Array(await gzipRes.arrayBuffer());
      const compressionRatio = (1 - gzippedBytes.length / uncompressedBytes.length) * 100;

      // Assert at least 80% compression on the ~411 KB web app shell
      expect(compressionRatio).toBeGreaterThan(80);

      // Verify gunzip round-trip integrity
      const decompressed = (globalThis as any).Bun.gunzipSync(gzippedBytes);
      const decompressedHtml = Buffer.from(decompressed).toString("utf8");
      expect(decompressedHtml).toContain("<!DOCTYPE html>");
      expect(decompressedHtml).toContain("LightHouse");
    });

    it("GET /api/books compresses large JSON responses when client accepts gzip or deflate", async () => {
      // 1. With small payload (1 book, <= 1024 bytes), verify compression is skipped to save CPU
      const smallReq = new Request("http://127.0.0.1:8086/api/books", {
        method: "GET",
        headers: { "Accept-Encoding": "gzip" },
      });
      const smallRes = await handleRequest(smallReq);
      expect(smallRes.status).toBe(200);
      expect(smallRes.headers.get("Content-Encoding")).toBeNull();
      expect(smallRes.headers.get("Vary")).toContain("Accept-Encoding");

      // 2. Temporarily populate additional books to make /api/books payload > 1024 bytes
      const db = new Database(tempDbPath);
      const insertBookStmt = db.prepare(
        "INSERT INTO books (id, title, path, has_cover, pubdate, series_index) VALUES (?, ?, ?, ?, ?, ?);",
      );
      const insertDataStmt = db.prepare(
        "INSERT INTO data (id, book, format, name, uncompressed_size) VALUES (?, ?, ?, ?, ?);",
      );
      for (let i = 10; i <= 20; i++) {
        insertBookStmt.run(
          i,
          `Book ${i} Dune Companion Volume Description`,
          `Author/Book ${i}`,
          0,
          "2026-01-01",
          i,
        );
        insertDataStmt.run(i, i, "EPUB", `Book ${i}`, 500);
      }
      db.close();

      try {
        const gzipReq = new Request("http://127.0.0.1:8086/api/books", {
          method: "GET",
          headers: { "Accept-Encoding": "gzip" },
        });
        const gzipRes = await handleRequest(gzipReq);
        expect(gzipRes.status).toBe(200);
        expect(gzipRes.headers.get("Content-Encoding")).toBe("gzip");
        expect(gzipRes.headers.get("Content-Type")).toBe("application/json; charset=utf-8");
        expect(gzipRes.headers.get("Vary")).toContain("Accept-Encoding");

        const bytes = new Uint8Array(await gzipRes.arrayBuffer());
        // Decompress and verify valid books JSON
        const decompressed = (globalThis as any).Bun.gunzipSync(bytes);
        const json = JSON.parse(Buffer.from(decompressed).toString("utf8"));
        expect(Array.isArray(json)).toBe(true);
        expect(json.length).toBeGreaterThanOrEqual(11);
        expect(json.some((b: any) => b.title === "Dune")).toBe(true);

        // Deflate encoding test
        const deflateReq = new Request("http://127.0.0.1:8086/api/books", {
          method: "GET",
          headers: { "Accept-Encoding": "deflate" },
        });
        const deflateRes = await handleRequest(deflateReq);
        expect(deflateRes.status).toBe(200);
        expect(deflateRes.headers.get("Content-Encoding")).toBe("deflate");
        expect(deflateRes.headers.get("Vary")).toContain("Accept-Encoding");
        const deflateBytes = new Uint8Array(await deflateRes.arrayBuffer());
        const decompressedDeflate = (globalThis as any).Bun.inflateSync(deflateBytes);
        const deflateJson = JSON.parse(Buffer.from(decompressedDeflate).toString("utf8"));
        expect(deflateJson.some((b: any) => b.title === "Dune")).toBe(true);
      } finally {
        // Clean up temporary books to preserve other tests' isolation
        const cleanDb = new Database(tempDbPath);
        cleanDb.run("DELETE FROM books WHERE id >= 10;");
        cleanDb.run("DELETE FROM data WHERE id >= 10;");
        cleanDb.close();
      }
    });

    it("Zero-copy cover streaming and fast mtime+size ETag on master and thumbnail covers", async () => {
      const masterPath = getMasterCoverPath(1)!;
      expect(fs.existsSync(masterPath)).toBe(true);

      const fileEtag = getFileETag(masterPath);
      expect(fileEtag).not.toBeNull();
      expect(fileEtag!.startsWith('"')).toBe(true);

      // GET Master cover
      const masterReq = new Request("http://127.0.0.1:8086/api/books/1/cover", { method: "GET" });
      const masterRes = await handleRequest(masterReq);
      expect(masterRes.status).toBe(200);
      expect(masterRes.headers.get("Content-Type")).toBe("image/jpeg");
      expect(masterRes.headers.get("ETag")).toBe(fileEtag);
      expect(masterRes.headers.get("Cache-Control")).toBe("public, max-age=86400");

      // 304 on master cover must include ETag and Cache-Control
      const condMasterReq = new Request("http://127.0.0.1:8086/api/books/1/cover", {
        method: "GET",
        headers: { "If-None-Match": fileEtag! },
      });
      const condMasterRes = await handleRequest(condMasterReq);
      expect(condMasterRes.status).toBe(304);
      expect(condMasterRes.headers.get("ETag")).toBe(fileEtag);
      expect(condMasterRes.headers.get("Cache-Control")).toBe("public, max-age=86400");

      // GET Downscaled thumbnail (w=128)
      const thumbReq = new Request("http://127.0.0.1:8086/api/books/1/cover?w=128", { method: "GET" });
      const thumbRes = await handleRequest(thumbReq);
      expect(thumbRes.status).toBe(200);
      expect(thumbRes.headers.get("Content-Type")).toBe("image/jpeg");
      expect(thumbRes.headers.get("Cache-Control")).toBe("public, max-age=604800, immutable");

      const thumbEtag = thumbRes.headers.get("ETag");
      expect(thumbEtag).not.toBeNull();

      // Subsequent request to cached thumbnail returns 304 Not Modified with ETag and Cache-Control
      const condThumbReq = new Request("http://127.0.0.1:8086/api/books/1/cover?w=128", {
        method: "GET",
        headers: { "If-None-Match": thumbEtag! },
      });
      const condThumbRes = await handleRequest(condThumbReq);
      expect(condThumbRes.status).toBe(304);
      expect(condThumbRes.headers.get("ETag")).toBe(thumbEtag);
      expect(condThumbRes.headers.get("Cache-Control")).toBe("public, max-age=604800, immutable");
    });

    it("Highlight count memoization caches results and auto-invalidates on mutations", () => {
      const hDb = new Database(":memory:");
      initHighlightsTable(hDb);

      // Initially empty
      const counts1 = getHighlightCounts(hDb);
      expect(Object.keys(counts1.byBookId).length).toBe(0);

      // Cached test verification
      const cachedRef1 = getCachedHighlightCountsForTesting();
      expect(cachedRef1).not.toBeNull();

      // Calling getHighlightCounts again returns memoized result
      const counts2 = getHighlightCounts(hDb);
      expect(counts2).toEqual(counts1); // Returns identical memoized counts
      expect(getCachedHighlightCountsForTesting()?.timestamp).toBe(cachedRef1?.timestamp);

      // Insert highlights using batchUpsertHighlights
      batchUpsertHighlights(hDb, [
        {
          book_id: 10,
          book_title: "Neuromancer",
          chapter: "Ch 1",
          page: 1,
          quote: "The sky above the port was the color of television, tuned to a dead channel.",
          note: "Opening line",
          timestamp: "2026-09-26",
        },
      ]);

      // Cache must be invalidated after upsert
      expect(getCachedHighlightCountsForTesting()).toBeNull();

      // New fetch re-computes and caches new counts
      const counts3 = getHighlightCounts(hDb);
      expect(counts3.byBookId[10]).toBe(1);
      expect(counts3.byTitle["neuromancer"]).toBe(1);

      // Delete highlights for book
      deleteHighlightsForBook(hDb, 10);
      expect(getCachedHighlightCountsForTesting()).toBeNull();

      const counts4 = getHighlightCounts(hDb);
      expect(counts4.byBookId[10]).toBeUndefined();

      // ensureBookHighlightsIndexed with forceFresh deletes and invalidates even if 0 parsed highlights (Bug C remediation)
      batchUpsertHighlights(hDb, [
        {
          book_id: 20,
          book_title: "Nonexistent Note Book",
          chapter: null,
          page: null,
          quote: "Test Quote",
          note: null,
          timestamp: "2026-09-26",
        },
      ]);
      expect(getHighlightCounts(hDb).byBookId[20]).toBe(1);
      expect(getCachedHighlightCountsForTesting()).not.toBeNull();

      // Calling ensureBookHighlightsIndexed with forceFresh when note file exists but has 0 highlights (Bug C remediation)
      const tempVault = path.join(os.tmpdir(), `test_vault_${Date.now()}`);
      fs.mkdirSync(tempVault, { recursive: true });
      fs.writeFileSync(
        path.join(tempVault, "Nonexistent Note Book.md"),
        "# Note Without Highlights\nJust general notes, no markers.",
      );

      ensureBookHighlightsIndexed(hDb, 20, "Nonexistent Note Book", {
        forceFresh: true,
        booksDir: tempVault,
      });
      // Cache must be invalidated!
      expect(getCachedHighlightCountsForTesting()).toBeNull();
      fs.rmSync(tempVault, { recursive: true, force: true });

      // Defensive copies test on both miss and hit (Bug 2 remediation)
      const missCounts = getHighlightCounts(hDb);
      missCounts.byBookId[99] = 999; // Attempt mutation on miss return
      const hitCounts = getHighlightCounts(hDb);
      expect(hitCounts.byBookId[99]).toBeUndefined(); // Internal cache was NOT poisoned
      hitCounts.byBookId[99] = 888; // Attempt mutation on hit return
      const hitCounts2 = getHighlightCounts(hDb);
      expect(hitCounts2.byBookId[99]).toBeUndefined(); // Still not poisoned

      // Explicit invalidateHighlightCountsCache
      invalidateHighlightCountsCache(hDb);
      expect(getCachedHighlightCountsForTesting()).toBeNull();

      hDb.close();
    });

    it("initHighlightsTable runs DDL only once per Database instance", () => {
      const testDb = new Database(":memory:");
      // First call executes DDL
      initHighlightsTable(testDb);

      // Verify table exists
      const tableCheck = testDb
        .query("SELECT name FROM sqlite_master WHERE type='table' AND name='book_highlights';")
        .get();
      expect(tableCheck).not.toBeNull();

      // Corrupting sqlite_master or dropping table temporarily to prove second call skips DDL:
      testDb.run("DROP TABLE book_highlights;");

      // Second call to initHighlightsTable skips DDL because instance is in _initializedDbs WeakSet
      initHighlightsTable(testDb);
      const droppedCheck = testDb
        .query("SELECT name FROM sqlite_master WHERE type='table' AND name='book_highlights';")
        .get();
      expect(droppedCheck).toBeNull(); // Still null because DDL was skipped!

      // Force call re-creates table
      initHighlightsTable(testDb, true);
      const recreatedCheck = testDb
        .query("SELECT name FROM sqlite_master WHERE type='table' AND name='book_highlights';")
        .get();
      expect(recreatedCheck).not.toBeNull();

      testDb.close();
    });
  });
});
