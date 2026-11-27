import { describe, it, expect } from "bun:test";
import { Database } from "bun:sqlite";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import zlib from "node:zlib";
import {
  isLnoriUrl,
  parseLnoriUrl,
  extractManifestFromHtml,
  parseVolumeAppData,
  MAX_EPUB_BYTES,
  MAX_COVER_BYTES,
  MAX_HTML_BYTES,
  fetchAndConvertCover,
  readResponseTextWithLimit,
  streamResponseToFile,
  downloadLnoriEpub,
  fetchLnoriHtml,
  ingestLnoriSeries,
  throwOnSubprocessTimeout,
  validateDownloadedEpub,
  validateLnoriBookId,
  isVolumeAlreadyInCalibre,
  resolveIngestVolumeAssignment,
  type ParsedLnoriUrl,
  type LnoriProgressEvent,
  formatLnoriProgress,
  classifyLnoriStorageResponse,
} from "./lnori";

describe("Lnori Light Novel Ingestion Module", () => {
  describe("URL Recognition & Parsing", () => {
    it("isLnoriUrl correctly identifies valid Lnori series and book URLs", () => {
      expect(isLnoriUrl("https://lnori.com/series/8046/the-genius-princes-guide")).toBe(true);
      expect(isLnoriUrl("https://lnori.com/series/8046")).toBe(true);
      expect(isLnoriUrl("https://lnori.com/book/23021/the-genius-prince-vol-1")).toBe(true);
      expect(isLnoriUrl("https://lnori.com/book/23021")).toBe(true);
      expect(isLnoriUrl("http://www.lnori.com/series/1234/test")).toBe(true);
      expect(isLnoriUrl("https://lnori.com/series/4239/ascendance-of-a-bookworm?ref=search#section")).toBe(true);
    });

    it("isLnoriUrl rejects non-Lnori and non-book/series URLs", () => {
      expect(isLnoriUrl("https://example.com/series/8046")).toBe(false);
      expect(isLnoriUrl("https://lnori.com/")).toBe(false);
      expect(isLnoriUrl("https://lnori.com/genre/fantasy")).toBe(false);
      expect(isLnoriUrl("https://lnori.com/me/dashboard")).toBe(false);
      expect(isLnoriUrl("not a url")).toBe(false);
      expect(isLnoriUrl("")).toBe(false);
    });

    it("parseLnoriUrl parses series URLs with and without slugs", () => {
      const parsedWithSlug = parseLnoriUrl(
        "https://lnori.com/series/8046/the-genius-princes-guide-to-raising-a-nation-out-of-debt-hey-how-about-treason",
      );
      expect(parsedWithSlug).toEqual({
        type: "series",
        id: "8046",
        slug: "the-genius-princes-guide-to-raising-a-nation-out-of-debt-hey-how-about-treason",
      });

      const parsedWithoutSlug = parseLnoriUrl("https://lnori.com/series/8046");
      expect(parsedWithoutSlug).toEqual({
        type: "series",
        id: "8046",
        slug: undefined,
      });
    });

    it("parseLnoriUrl parses book URLs with and without slugs", () => {
      const parsedBook = parseLnoriUrl(
        "https://lnori.com/book/23021/the-genius-princes-guide-to-raising-a-nation-out-of-debt-vol-1",
      );
      expect(parsedBook).toEqual({
        type: "book",
        id: "23021",
        slug: "the-genius-princes-guide-to-raising-a-nation-out-of-debt-vol-1",
      });

      const parsedBookNoSlug = parseLnoriUrl("https://lnori.com/book/23021");
      expect(parsedBookNoSlug).toEqual({
        type: "book",
        id: "23021",
        slug: undefined,
      });
    });

    it("parseLnoriUrl returns null for invalid URLs", () => {
      expect(parseLnoriUrl("https://lnori.com/genre/comedy")).toBeNull();
      expect(parseLnoriUrl("https://othersite.com/series/1234")).toBeNull();
      expect(parseLnoriUrl("not-a-url")).toBeNull();
    });
  });

  describe("Manifest Extraction", () => {
    it("extractManifestFromHtml extracts series title, author, tags, and volumes from LD+JSON", () => {
      const mockHtml = `
        <!DOCTYPE html>
        <html>
        <head>
          <title>Ascendance of a Bookworm | Lnori</title>
          <script type="application/ld+json">
          {
            "@context": "https://schema.org",
            "@type": "Book",
            "name": "Ascendance of a Bookworm: I’ll Do Anything to Become a Librarian!",
            "author": {
              "@type": "Person",
              "name": "Kazuki Miya"
            },
            "genre": "comedy, fantasy, isekai",
            "hasPart": [
              {
                "@type": "Book",
                "name": "Volume 1",
                "position": "1",
                "url": "https://lnori.com/book/14185/ascendance-of-a-bookworm-volume-1"
              },
              {
                "@type": "Book",
                "name": "Volume 2",
                "position": "2",
                "url": "https://lnori.com/book/14359/ascendance-of-a-bookworm-volume-2"
              }
            ]
          }
          </script>
        </head>
        <body>
          <a href="/book/14185/ascendance-of-a-bookworm-volume-1">Vol 1</a>
          <a href="/book/14359/ascendance-of-a-bookworm-volume-2">Vol 2</a>
        </body>
        </html>
      `;

      const parsedUrl: ParsedLnoriUrl = {
        type: "series",
        id: "4239",
        slug: "ascendance-of-a-bookworm",
      };

      const manifest = extractManifestFromHtml(
        mockHtml,
        "https://lnori.com/series/4239/ascendance-of-a-bookworm",
        parsedUrl,
      );

      expect(manifest.type).toBe("series");
      expect(manifest.seriesId).toBe("4239");
      expect(manifest.seriesTitle).toBe(
        "Ascendance of a Bookworm: I’ll Do Anything to Become a Librarian!",
      );
      expect(manifest.author).toBe("Kazuki Miya");
      expect(manifest.tags).toEqual(["comedy", "fantasy", "isekai"]);
      expect(manifest.volumePaths).toEqual([
        "/book/14185/ascendance-of-a-bookworm-volume-1",
        "/book/14359/ascendance-of-a-bookworm-volume-2",
      ]);
    });

    it("extractManifestFromHtml falls back to HTML href links and title when LD+JSON hasPart is missing", () => {
      const mockHtml = `
        <!DOCTYPE html>
        <html>
        <head>
          <title>The Genius Prince's Guide | Lnori</title>
        </head>
        <body>
          <h1>The Genius Prince's Guide</h1>
          <div class="volumes">
            <a href="/book/23021/genius-prince-vol-1">Volume 1</a>
            <a href="/book/24017/genius-prince-vol-2">Volume 2</a>
            <a href="/book/25118/genius-prince-vol-3">Volume 3</a>
          </div>
        </body>
        </html>
      `;

      const parsedUrl: ParsedLnoriUrl = {
        type: "series",
        id: "8046",
        slug: "the-genius-prince-guide",
      };

      const manifest = extractManifestFromHtml(
        mockHtml,
        "https://lnori.com/series/8046/the-genius-prince-guide",
        parsedUrl,
      );

      expect(manifest.type).toBe("series");
      expect(manifest.seriesTitle).toBe("The Genius Prince's Guide");
      expect(manifest.volumePaths).toEqual([
        "/book/23021/genius-prince-vol-1",
        "/book/24017/genius-prince-vol-2",
        "/book/25118/genius-prince-vol-3",
      ]);
    });

    it("extractManifestFromHtml handles single book URL as a 1-volume manifest", () => {
      const mockHtml = `
        <!DOCTYPE html>
        <html>
        <head>
          <script id="app-data" type="application/ld+json">
          {
            "@context": "https://schema.org",
            "@type": "Book",
            "name": "The Genius Prince Vol. 1",
            "author": [{"@type": "Person", "name": "Toru Toba"}],
            "additionalProperty": [
              {
                "@type": "PropertyValue",
                "name": "epub_filename",
                "value": "Genius_Prince_Vol_01.epub"
              },
              {
                "@type": "PropertyValue",
                "name": "series_title",
                "value": "The Genius Prince's Guide"
              },
              {
                "@type": "PropertyValue",
                "name": "book_id",
                "value": "23021"
              }
            ]
          }
          </script>
        </head>
        </html>
      `;

      const parsedUrl: ParsedLnoriUrl = {
        type: "book",
        id: "23021",
        slug: "the-genius-prince-vol-1",
      };

      const manifest = extractManifestFromHtml(
        mockHtml,
        "https://lnori.com/book/23021/the-genius-prince-vol-1",
        parsedUrl,
      );

      expect(manifest.type).toBe("book");
      expect(manifest.seriesTitle).toBe("The Genius Prince's Guide");
      expect(manifest.author).toBe("Toru Toba");
      expect(manifest.volumePaths).toEqual([
        "/book/23021/the-genius-prince-vol-1",
      ]);
    });
  });

  describe("Volume App-Data Parsing", () => {
    it("parseVolumeAppData extracts epub_filename, book_id, series metadata, cover, and description", () => {
      const mockVolumeHtml = `
        <!DOCTYPE html>
        <html>
        <body>
          <script id="app-data" type="application/ld+json">
          {
            "@context": "https://schema.org",
            "@type": "Book",
            "name": "The Genius Prince’s Guide Vol. 1",
            "id": "23021",
            "description": "It ain't easy being a genius prince! Wein is ready to commit treason and sell off his kingdom.",
            "image": "https://img.lnori.com/23021-01.jpg",
            "author": [
              { "@type": "Person", "name": "Toru Toba" },
              { "@type": "Person", "name": "Falmaro" }
            ],
            "additionalProperty": [
              {
                "@type": "PropertyValue",
                "name": "cover_image_url",
                "value": "https://img.lnori.com/23021-01.jpg"
              },
              {
                "@type": "PropertyValue",
                "name": "epub_filename",
                "value": "The Genius Prince's Guide - Volume 01 [Yen Press][Kobo].epub"
              },
              {
                "@type": "PropertyValue",
                "name": "book_id",
                "value": "23021"
              },
              {
                "@type": "PropertyValue",
                "name": "series_id",
                "value": "8046"
              },
              {
                "@type": "PropertyValue",
                "name": "series_title",
                "value": "The Genius Prince's Guide to Raising a Nation Out of Debt"
              }
            ]
          }
          </script>
        </body>
        </html>
      `;

      const meta = parseVolumeAppData(mockVolumeHtml, "23021");
      expect(meta).not.toBeNull();
      expect(meta?.bookId).toBe("23021");
      expect(meta?.name).toBe("The Genius Prince’s Guide Vol. 1");
      expect(meta?.epubFilename).toBe(
        "The Genius Prince's Guide - Volume 01 [Yen Press][Kobo].epub",
      );
      expect(meta?.seriesId).toBe("8046");
      expect(meta?.seriesTitle).toBe(
        "The Genius Prince's Guide to Raising a Nation Out of Debt",
      );
      expect(meta?.authors).toEqual(["Toru Toba", "Falmaro"]);
      expect(meta?.coverImageUrl).toBe("https://img.lnori.com/23021-01.jpg");
      expect(meta?.volumeNumber).toBe(1);
      expect(meta?.description).toContain("It ain't easy being a genius prince");
    });

    it("parseVolumeAppData returns null when epub_filename is absent", () => {
      const mockHtmlWithoutEpub = `
        <script id="app-data" type="application/ld+json">
        {
          "name": "Sample Book",
          "additionalProperty": [
            { "name": "other_field", "value": "123" }
          ]
        }
        </script>
      `;
      expect(parseVolumeAppData(mockHtmlWithoutEpub)).toBeNull();
    });
  });

  describe("Security and resource bounds", () => {
    it("rejects non-numeric Lnori book IDs", () => {
      expect(() => validateLnoriBookId("23021")).not.toThrow();
      expect(() => validateLnoriBookId("23021/../../escape")).toThrow(
        "Invalid non-numeric book ID",
      );
    });

    it("aborts and removes files that exceed the configured byte cap", async () => {
      const workDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "lnori-test-"));
      const destPath = path.join(workDir, "oversized.epub");
      try {
        const response = new Response(
          new ReadableStream<Uint8Array>({
            start(controller) {
              controller.enqueue(new Uint8Array([1, 2, 3]));
              controller.enqueue(new Uint8Array([4, 5]));
              controller.close();
            },
          }),
        );
        await expect(
          streamResponseToFile(response, destPath, 4, "Test EPUB"),
        ).rejects.toThrow("Test EPUB exceeds maximum size of 4 bytes");
        expect(fs.existsSync(destPath)).toBe(false);
        expect(MAX_EPUB_BYTES).toBe(256 * 1024 * 1024);
      } finally {
        await fs.promises.rm(workDir, { recursive: true, force: true });
      }
    });

    it("rejects declared lengths before reading the response body", async () => {
      const workDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "lnori-test-"));
      const destPath = path.join(workDir, "declared-large.epub");
      await fs.promises.writeFile(destPath, "stale file");
      try {
        const response = new Response(new Uint8Array([1]), {
          headers: { "content-length": "5" },
        });
        await expect(
          streamResponseToFile(response, destPath, 4, "Declared EPUB"),
        ).rejects.toThrow("Declared EPUB exceeds maximum size of 4 bytes");
        expect(fs.existsSync(destPath)).toBe(false);
      } finally {
        await fs.promises.rm(workDir, { recursive: true, force: true });
      }
    });

    it("enforces chunked HTML and cover byte caps", async () => {
      const chunkedResponse = (chunks: number[]) =>
        new Response(
          new ReadableStream<Uint8Array>({
            start(controller) {
              for (const size of chunks) controller.enqueue(new Uint8Array(size));
              controller.close();
            },
          }),
        );

      await expect(
        readResponseTextWithLimit(
          chunkedResponse([3, 3]),
          4,
          "Chunked HTML",
        ),
      ).rejects.toThrow("Chunked HTML exceeds maximum size of 4 bytes");

      const workDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "lnori-test-"));
      const destPath = path.join(workDir, "cover.raw");
      try {
        await expect(
          streamResponseToFile(
            chunkedResponse([3, 3]),
            destPath,
            4,
            "Chunked cover",
          ),
        ).rejects.toThrow("Chunked cover exceeds maximum size of 4 bytes");
        expect(fs.existsSync(destPath)).toBe(false);
        expect(MAX_COVER_BYTES).toBe(16 * 1024 * 1024);
        expect(MAX_HTML_BYTES).toBe(8 * 1024 * 1024);
      } finally {
        await fs.promises.rm(workDir, { recursive: true, force: true });
      }
    });

    it("requires a caller-owned work directory for cover conversion", async () => {
      const coverPrefixes = ["lnori_cover_", "lnori-"];
      const before = new Set(
        fs.readdirSync(os.tmpdir()).filter((entry: string) =>
          coverPrefixes.some((prefix) => entry.startsWith(prefix)),
        ),
      );
      await expect(
        fetchAndConvertCover("23021", undefined, undefined),
      ).rejects.toThrow("Lnori cover work directory is required");
      const after = fs
        .readdirSync(os.tmpdir())
        .filter((entry: string) => coverPrefixes.some((prefix) => entry.startsWith(prefix)));
      expect(after.filter((entry) => !before.has(entry))).toEqual([]);
    });

    it("cleans cover.raw after successful conversion and sips failure", async () => {
      const workDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "lnori-test-"));
      const rawPath = path.join(workDir, "cover.raw");
      const jpegPath = path.join(workDir, "cover.jpg");
      const coverResponse = () => new Response(new Uint8Array([1, 2, 3]));
      try {
        const success = await fetchAndConvertCover("23021", undefined, workDir, {
          fetch: async () => coverResponse(),
          sipsPath: "fake-sips",
          spawnSync: (_command: string, args: string[]) => {
            fs.writeFileSync(args[args.length - 1], "jpeg");
            return { status: 0, stdout: "", stderr: "" };
          },
        });
        expect(success).toBe(jpegPath);
        expect(fs.existsSync(rawPath)).toBe(false);
        expect(fs.existsSync(jpegPath)).toBe(true);
        await fs.promises.rm(jpegPath, { force: true });

        const failed = await fetchAndConvertCover("23021", undefined, workDir, {
          fetch: async () => coverResponse(),
          sipsPath: "fake-sips",
          spawnSync: () => ({ status: 1, stdout: "", stderr: "conversion failed" }),
        });
        expect(failed).toBeNull();
        expect(fs.existsSync(rawPath)).toBe(false);
      } finally {
        await fs.promises.rm(workDir, { recursive: true, force: true });
      }
    });

    it("cleans cover.raw when sips times out", async () => {
      const workDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "lnori-test-"));
      const rawPath = path.join(workDir, "cover.raw");
      try {
        await expect(
          fetchAndConvertCover("23021", undefined, workDir, {
            fetch: async () => new Response(new Uint8Array([1, 2, 3])),
            sipsPath: "fake-sips",
            spawnSync: () => ({ error: { code: "ETIMEDOUT" } }),
          }),
        ).rejects.toThrow("sips timed out after 60000ms");
        expect(fs.existsSync(rawPath)).toBe(false);
      } finally {
        await fs.promises.rm(workDir, { recursive: true, force: true });
      }
    });

    it("rejects responses without bodies and declared oversized HTML", async () => {
      const workDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "lnori-test-"));
      const destPath = path.join(workDir, "empty.epub");
      try {
        await expect(
          streamResponseToFile(new Response(null), destPath, 4, "Empty EPUB"),
        ).rejects.toThrow("Empty EPUB response contained no body");
        expect(fs.existsSync(destPath)).toBe(false);
        await expect(
          readResponseTextWithLimit(
            new Response(new Uint8Array([1]), { headers: { "content-length": "5" } }),
            4,
            "Declared HTML",
          ),
        ).rejects.toThrow("Declared HTML exceeds maximum size of 4 bytes");
      } finally {
        await fs.promises.rm(workDir, { recursive: true, force: true });
      }
    });

    it("rejects non-OK EPUB downloads", async () => {
      const workDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "lnori-test-"));
      try {
        await expect(
          downloadLnoriEpub("volume.epub", path.join(workDir, "volume.epub"), undefined, {
            fetch: async () => new Response("unavailable", { status: 503 }),
          }),
        ).rejects.toThrow("Failed to download EPUB from Lnori storage (503)");
      } finally {
        await fs.promises.rm(workDir, { recursive: true, force: true });
      }
    });

    it("falls back to proxy for Lnori HTML fetch after direct network error", async () => {
      let calls = 0;
      const proxyUsed: (string | undefined)[] = [];
      const html = await fetchLnoriHtml("https://lnori.com/series/8046/test-series", {
        fetch: async (_url: string, init: any) => {
          calls++;
          proxyUsed.push(init?.proxy);
          if (calls === 1) throw new Error("direct connection failed");
          return new Response("<html>proxy response</html>");
        },
      });
      expect(html).toBe("<html>proxy response</html>");
      expect(calls).toBe(2);
      expect(proxyUsed[0]).toBeUndefined();
      expect(proxyUsed[1]).toBe("http://127.0.0.1:7890");
    });

    it("retries EPUB download with direct-first priority and sticky proxy fallback on subsequent attempts after non-OK response", async () => {
      const workDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "lnori-test-"));
      let calls = 0;
      const proxyUsed: (string | undefined)[] = [];
      try {
        await expect(
          downloadLnoriEpub("volume.epub", path.join(workDir, "volume.epub"), undefined, {
            fetch: async (_url: string, init: any) => {
              calls++;
              proxyUsed.push(init?.proxy);
              if (calls === 1) throw new Error("direct connection failed");
              return new Response("unavailable", { status: 503 });
            },
          }),
        ).rejects.toThrow("Failed to download EPUB from Lnori storage (503)");
        // Attempt 0: direct (calls=1, throws) -> fallback to proxy (calls=2, returns 503)
        // Attempt 1: direct (calls=3, returns 503) -> fallback to proxy (calls=4, returns 503, sets forceProxy)
        // Attempt 2: proxy directly (calls=5, returns 503)
        // Attempt 3: proxy directly (calls=6, returns 503)
        expect(calls).toBe(6);
        expect(proxyUsed[0]).toBeUndefined();
        expect(proxyUsed[1]).toBe("http://127.0.0.1:7890");
        expect(proxyUsed[2]).toBeUndefined();
        expect(proxyUsed[3]).toBe("http://127.0.0.1:7890");
        expect(proxyUsed[4]).toBe("http://127.0.0.1:7890");
        expect(proxyUsed[5]).toBe("http://127.0.0.1:7890");
      } finally {
        await fs.promises.rm(workDir, { recursive: true, force: true });
      }
    });

    it("falls back to proxy for Lnori HTML fetch after direct HTTP 403", async () => {
      let calls = 0;
      const proxyUsed: (string | undefined)[] = [];
      const html = await fetchLnoriHtml("https://lnori.com/series/8046/test-series", {
        fetch: async (_url: string, init: any) => {
          calls++;
          proxyUsed.push(init?.proxy);
          if (calls === 1) return new Response("forbidden", { status: 403 });
          return new Response("<html>proxy response</html>", { status: 200 });
        },
      });
      expect(html).toBe("<html>proxy response</html>");
      expect(calls).toBe(2);
      expect(proxyUsed[0]).toBeUndefined();
      expect(proxyUsed[1]).toBe("http://127.0.0.1:7890");
    });

    it("falls back to proxy for EPUB download when direct response is HTTP 403", async () => {
      const workDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "lnori-test-"));
      const destPath = path.join(workDir, "fallback-403.epub");
      let calls = 0;
      const proxyUsed: (string | undefined)[] = [];

      function makeEntry(name: string, data: Buffer, compMethod = 0, compData: Buffer | null = null): Buffer {
        const nameBuf = Buffer.from(name);
        const payload = compData || data;
        const crc = zlib.crc32(data);
        const h = Buffer.alloc(30 + nameBuf.length);
        h.writeUInt32LE(0x04034b50, 0);
        h.writeUInt16LE(20, 4);
        h.writeUInt16LE(0, 6);
        h.writeUInt16LE(compMethod, 8);
        h.writeUInt16LE(0, 10);
        h.writeUInt16LE(0, 12);
        h.writeUInt32LE(crc, 14);
        h.writeUInt32LE(payload.length, 18);
        h.writeUInt32LE(data.length, 22);
        h.writeUInt16LE(nameBuf.length, 26);
        h.writeUInt16LE(0, 28);
        nameBuf.copy(h, 30);
        return Buffer.concat([h, payload]);
      }

      const mimeData = Buffer.from("application/epub+zip");
      const mimePart = makeEntry("mimetype", mimeData, 0);
      const containerXml = Buffer.from(
        '<?xml version="1.0"?><container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container"><rootfiles><rootfile full-path="content.opf" media-type="application/oebps-package+xml"/></rootfiles></container>',
      );
      const containerPart = makeEntry("META-INF/container.xml", containerXml, 8, zlib.deflateRawSync(containerXml));
      const opfXml = Buffer.from(
        '<?xml version="1.0"?><package xmlns="http://www.idpf.org/2007/opf" version="3.0"><metadata><dc:title>Test</dc:title></metadata><manifest/><spine/></package>',
      );
      const opfPart = makeEntry("content.opf", opfXml, 8, zlib.deflateRawSync(opfXml));
      const validEpubContent = Buffer.concat([mimePart, containerPart, opfPart, Buffer.alloc(512, 0)]);

      try {
        await downloadLnoriEpub("fallback-403.epub", destPath, undefined, {
          fetch: async (_url: string, init: any) => {
            calls++;
            proxyUsed.push(init?.proxy);
            if (calls === 1) {
              return new Response("Cloudflare 403 Forbidden", { status: 403 });
            }
            return new Response(validEpubContent, { status: 200 });
          },
        });

        expect(calls).toBe(2);
        expect(proxyUsed[0]).toBeUndefined();
        expect(proxyUsed[1]).toBe("http://127.0.0.1:7890");
        expect(fs.existsSync(destPath)).toBe(true);
      } finally {
        await fs.promises.rm(workDir, { recursive: true, force: true });
      }
    });

    it("does not stay direct on subsequent attempts after direct response is HTTP 503", async () => {
      const workDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "lnori-test-"));
      const destPath = path.join(workDir, "subsequent-proxy.epub");
      let calls = 0;
      const proxyUsed: (string | undefined)[] = [];

      function makeEntry(name: string, data: Buffer, compMethod = 0, compData: Buffer | null = null): Buffer {
        const nameBuf = Buffer.from(name);
        const payload = compData || data;
        const crc = zlib.crc32(data);
        const h = Buffer.alloc(30 + nameBuf.length);
        h.writeUInt32LE(0x04034b50, 0);
        h.writeUInt16LE(20, 4);
        h.writeUInt16LE(0, 6);
        h.writeUInt16LE(compMethod, 8);
        h.writeUInt16LE(0, 10);
        h.writeUInt16LE(0, 12);
        h.writeUInt32LE(crc, 14);
        h.writeUInt32LE(payload.length, 18);
        h.writeUInt32LE(data.length, 22);
        h.writeUInt16LE(nameBuf.length, 26);
        h.writeUInt16LE(0, 28);
        nameBuf.copy(h, 30);
        return Buffer.concat([h, payload]);
      }

      const mimeData = Buffer.from("application/epub+zip");
      const mimePart = makeEntry("mimetype", mimeData, 0);
      const containerXml = Buffer.from(
        '<?xml version="1.0"?><container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container"><rootfiles><rootfile full-path="content.opf" media-type="application/oebps-package+xml"/></rootfiles></container>',
      );
      const containerPart = makeEntry("META-INF/container.xml", containerXml, 8, zlib.deflateRawSync(containerXml));
      const opfXml = Buffer.from(
        '<?xml version="1.0"?><package xmlns="http://www.idpf.org/2007/opf" version="3.0"><metadata><dc:title>Test</dc:title></metadata><manifest/><spine/></package>',
      );
      const opfPart = makeEntry("content.opf", opfXml, 8, zlib.deflateRawSync(opfXml));
      const validEpubContent = Buffer.concat([mimePart, containerPart, opfPart, Buffer.alloc(512, 0)]);

      try {
        await downloadLnoriEpub("subsequent-proxy.epub", destPath, undefined, {
          fetch: async (_url: string, init: any) => {
            calls++;
            proxyUsed.push(init?.proxy);
            if (calls === 1) {
              // Attempt 0: direct returns 503
              return new Response("Service Unavailable", { status: 503 });
            }
            if (calls === 2) {
              // Attempt 0 fallback: proxy also returns 503 (transient)
              return new Response("Proxy 503", { status: 503 });
            }
            // Attempt 1: must use proxy directly, NOT direct!
            return new Response(validEpubContent, { status: 200 });
          },
        });

        expect(calls).toBe(3);
        expect(proxyUsed[0]).toBeUndefined();
        expect(proxyUsed[1]).toBe("http://127.0.0.1:7890");
        expect(proxyUsed[2]).toBe("http://127.0.0.1:7890");
        expect(fs.existsSync(destPath)).toBe(true);
      } finally {
        await fs.promises.rm(workDir, { recursive: true, force: true });
      }
    });

    it("succeeds when transient direct failure on attempt 0 clears on retry even if proxy fails", async () => {
      const workDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "lnori-test-"));
      const destPath = path.join(workDir, "retry-direct-success.epub");
      let calls = 0;
      const proxyUsed: (string | undefined)[] = [];

      function makeEntry(name: string, data: Buffer, compMethod = 0, compData: Buffer | null = null): Buffer {
        const nameBuf = Buffer.from(name);
        const payload = compData || data;
        const crc = zlib.crc32(data);
        const h = Buffer.alloc(30 + nameBuf.length);
        h.writeUInt32LE(0x04034b50, 0);
        h.writeUInt16LE(20, 4);
        h.writeUInt16LE(0, 6);
        h.writeUInt16LE(compMethod, 8);
        h.writeUInt16LE(0, 10);
        h.writeUInt16LE(0, 12);
        h.writeUInt32LE(crc, 14);
        h.writeUInt32LE(payload.length, 18);
        h.writeUInt32LE(data.length, 22);
        h.writeUInt16LE(nameBuf.length, 26);
        h.writeUInt16LE(0, 28);
        nameBuf.copy(h, 30);
        return Buffer.concat([h, payload]);
      }

      const mimeData = Buffer.from("application/epub+zip");
      const mimePart = makeEntry("mimetype", mimeData, 0);
      const containerXml = Buffer.from(
        '<?xml version="1.0"?><container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container"><rootfiles><rootfile full-path="content.opf" media-type="application/oebps-package+xml"/></rootfiles></container>',
      );
      const containerPart = makeEntry("META-INF/container.xml", containerXml, 8, zlib.deflateRawSync(containerXml));
      const opfXml = Buffer.from(
        '<?xml version="1.0"?><package xmlns="http://www.idpf.org/2007/opf" version="3.0"><metadata><dc:title>Test</dc:title></metadata><manifest/><spine/></package>',
      );
      const opfPart = makeEntry("content.opf", opfXml, 8, zlib.deflateRawSync(opfXml));
      const validEpubContent = Buffer.concat([mimePart, containerPart, opfPart, Buffer.alloc(512, 0)]);

      try {
        await downloadLnoriEpub("retry-direct-success.epub", destPath, undefined, {
          fetch: async (_url: string, init: any) => {
            calls++;
            proxyUsed.push(init?.proxy);
            if (calls === 1) {
              // Attempt 0: direct throws
              throw new Error("transient direct network error");
            }
            if (calls === 2) {
              // Attempt 0 fallback: proxy also throws/fails (500)
              return new Response("proxy internal error", { status: 500 });
            }
            // Attempt 1: direct succeeds at full speed
            return new Response(validEpubContent, { status: 200 });
          },
        });

        expect(calls).toBe(3);
        expect(proxyUsed[0]).toBeUndefined();
        expect(proxyUsed[1]).toBe("http://127.0.0.1:7890");
        expect(proxyUsed[2]).toBeUndefined();
        expect(fs.existsSync(destPath)).toBe(true);
      } finally {
        await fs.promises.rm(workDir, { recursive: true, force: true });
      }
    });

    it("pure direct success never uses proxy across download", async () => {
      const workDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "lnori-test-"));
      const destPath = path.join(workDir, "pure-direct.epub");
      let calls = 0;
      const proxyUsed: (string | undefined)[] = [];

      function makeEntry(name: string, data: Buffer, compMethod = 0, compData: Buffer | null = null): Buffer {
        const nameBuf = Buffer.from(name);
        const payload = compData || data;
        const crc = zlib.crc32(data);
        const h = Buffer.alloc(30 + nameBuf.length);
        h.writeUInt32LE(0x04034b50, 0);
        h.writeUInt16LE(20, 4);
        h.writeUInt16LE(0, 6);
        h.writeUInt16LE(compMethod, 8);
        h.writeUInt16LE(0, 10);
        h.writeUInt16LE(0, 12);
        h.writeUInt32LE(crc, 14);
        h.writeUInt32LE(payload.length, 18);
        h.writeUInt32LE(data.length, 22);
        h.writeUInt16LE(nameBuf.length, 26);
        h.writeUInt16LE(0, 28);
        nameBuf.copy(h, 30);
        return Buffer.concat([h, payload]);
      }

      const mimeData = Buffer.from("application/epub+zip");
      const mimePart = makeEntry("mimetype", mimeData, 0);
      const containerXml = Buffer.from(
        '<?xml version="1.0"?><container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container"><rootfiles><rootfile full-path="content.opf" media-type="application/oebps-package+xml"/></rootfiles></container>',
      );
      const containerPart = makeEntry("META-INF/container.xml", containerXml, 8, zlib.deflateRawSync(containerXml));
      const opfXml = Buffer.from(
        '<?xml version="1.0"?><package xmlns="http://www.idpf.org/2007/opf" version="3.0"><metadata><dc:title>Test</dc:title></metadata><manifest/><spine/></package>',
      );
      const opfPart = makeEntry("content.opf", opfXml, 8, zlib.deflateRawSync(opfXml));
      const validEpubContent = Buffer.concat([mimePart, containerPart, opfPart, Buffer.alloc(512, 0)]);

      try {
        await downloadLnoriEpub("pure-direct.epub", destPath, undefined, {
          fetch: async (_url: string, init: any) => {
            calls++;
            proxyUsed.push(init?.proxy);
            return new Response(validEpubContent, { status: 200 });
          },
        });

        expect(calls).toBe(1);
        expect(proxyUsed[0]).toBeUndefined();
        expect(fs.existsSync(destPath)).toBe(true);
      } finally {
        await fs.promises.rm(workDir, { recursive: true, force: true });
      }
    });

    it("client abort during direct attempt does not trigger proxy fallback", async () => {
      const workDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "lnori-test-"));
      const destPath = path.join(workDir, "aborted.epub");
      let calls = 0;
      const proxyUsed: (string | undefined)[] = [];
      const controller = new AbortController();

      try {
        await expect(
          downloadLnoriEpub("aborted.epub", destPath, undefined, {
            fetch: async (_url: string, init: any) => {
              calls++;
              proxyUsed.push(init?.proxy);
              controller.abort(new Error("user aborted"));
              throw controller.signal.reason;
            },
            signal: controller.signal,
          }),
        ).rejects.toThrow();

        expect(calls).toBe(1);
        expect(proxyUsed[0]).toBeUndefined();
        expect(fs.existsSync(destPath)).toBe(false);
      } finally {
        await fs.promises.rm(workDir, { recursive: true, force: true });
      }
    });

    it("succeeds via proxy fallback when direct connection throws or times out on initial attempt", async () => {
      const workDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "lnori-test-"));
      const destPath = path.join(workDir, "direct-success.epub");
      let calls = 0;
      const proxyUsed: (string | undefined)[] = [];

      function makeEntry(name: string, data: Buffer, compMethod = 0, compData: Buffer | null = null): Buffer {
        const nameBuf = Buffer.from(name);
        const payload = compData || data;
        const crc = zlib.crc32(data);
        const h = Buffer.alloc(30 + nameBuf.length);
        h.writeUInt32LE(0x04034b50, 0);
        h.writeUInt16LE(20, 4);
        h.writeUInt16LE(0, 6);
        h.writeUInt16LE(compMethod, 8);
        h.writeUInt16LE(0, 10);
        h.writeUInt16LE(0, 12);
        h.writeUInt32LE(crc, 14);
        h.writeUInt32LE(payload.length, 18);
        h.writeUInt32LE(data.length, 22);
        h.writeUInt16LE(nameBuf.length, 26);
        h.writeUInt16LE(0, 28);
        nameBuf.copy(h, 30);
        return Buffer.concat([h, payload]);
      }

      const mimeData = Buffer.from("application/epub+zip");
      const mimePart = makeEntry("mimetype", mimeData, 0);
      const containerXml = Buffer.from(
        '<?xml version="1.0"?><container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container"><rootfiles><rootfile full-path="content.opf" media-type="application/oebps-package+xml"/></rootfiles></container>',
      );
      const containerPart = makeEntry("META-INF/container.xml", containerXml, 8, zlib.deflateRawSync(containerXml));
      const opfXml = Buffer.from(
        '<?xml version="1.0"?><package xmlns="http://www.idpf.org/2007/opf" version="3.0"><metadata><dc:title>Test</dc:title></metadata><manifest/><spine/></package>',
      );
      const opfPart = makeEntry("content.opf", opfXml, 8, zlib.deflateRawSync(opfXml));
      const validEpubContent = Buffer.concat([mimePart, containerPart, opfPart, Buffer.alloc(512, 0)]);

      try {
        await downloadLnoriEpub("direct-success.epub", destPath, undefined, {
          fetch: async (_url: string, init: any) => {
            calls++;
            proxyUsed.push(init?.proxy);
            if (calls === 1) {
              const err: any = new Error("The operation timed out.");
              err.name = "TimeoutError";
              throw err;
            }
            return new Response(validEpubContent, { status: 200 });
          },
        });

        expect(calls).toBe(2);
        expect(proxyUsed[0]).toBeUndefined();
        expect(proxyUsed[1]).toBe("http://127.0.0.1:7890");
        expect(fs.existsSync(destPath)).toBe(true);
      } finally {
        await fs.promises.rm(workDir, { recursive: true, force: true });
      }
    });

    it("succeeds for large book downloads when stream is continuously active across multiple chunks", async () => {
      const workDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "lnori-test-"));
      const destPath = path.join(workDir, "slow-active.epub");

      function makeEntry(name: string, data: Buffer, compMethod = 0, compData: Buffer | null = null): Buffer {
        const nameBuf = Buffer.from(name);
        const payload = compData || data;
        const crc = zlib.crc32(data);
        const h = Buffer.alloc(30 + nameBuf.length);
        h.writeUInt32LE(0x04034b50, 0);
        h.writeUInt16LE(20, 4);
        h.writeUInt16LE(0, 6);
        h.writeUInt16LE(compMethod, 8);
        h.writeUInt16LE(0, 10);
        h.writeUInt16LE(0, 12);
        h.writeUInt32LE(crc, 14);
        h.writeUInt32LE(payload.length, 18);
        h.writeUInt32LE(data.length, 22);
        h.writeUInt16LE(nameBuf.length, 26);
        h.writeUInt16LE(0, 28);
        nameBuf.copy(h, 30);
        return Buffer.concat([h, payload]);
      }

      const mimeData = Buffer.from("application/epub+zip");
      const mimePart = makeEntry("mimetype", mimeData, 0);
      const containerXml = Buffer.from(
        '<?xml version="1.0"?><container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container"><rootfiles><rootfile full-path="content.opf" media-type="application/oebps-package+xml"/></rootfiles></container>',
      );
      const containerPart = makeEntry("META-INF/container.xml", containerXml, 8, zlib.deflateRawSync(containerXml));
      const opfXml = Buffer.from(
        '<?xml version="1.0"?><package xmlns="http://www.idpf.org/2007/opf" version="3.0"><metadata><dc:title>Test</dc:title></metadata><manifest/><spine/></package>',
      );
      const opfPart = makeEntry("content.opf", opfXml, 8, zlib.deflateRawSync(opfXml));
      const fullBuffer = Buffer.concat([mimePart, containerPart, opfPart, Buffer.alloc(512, 0)]);

      // Split into 4 chunks with short pauses between them
      const chunkSize = Math.ceil(fullBuffer.length / 4);
      const chunks: Uint8Array[] = [];
      for (let i = 0; i < fullBuffer.length; i += chunkSize) {
        chunks.push(new Uint8Array(fullBuffer.subarray(i, i + chunkSize)));
      }

      const activeSlowStream = new ReadableStream<Uint8Array>({
        async start(controller) {
          for (const c of chunks) {
            controller.enqueue(c);
            await new Promise((r) => setTimeout(r, 20));
          }
          controller.close();
        },
      });

      try {
        await streamResponseToFile(
          new Response(activeSlowStream, { status: 200 }),
          destPath,
          MAX_EPUB_BYTES,
          "Slow active EPUB",
          undefined,
          { activityTimeoutMs: 100 },
        );
        expect(fs.existsSync(destPath)).toBe(true);
        expect(fs.statSync(destPath).size).toBe(fullBuffer.length);
      } finally {
        await fs.promises.rm(workDir, { recursive: true, force: true });
      }
    });

    it("downloadLnoriEpub succeeds for active streams longer than TTFB timeout without being aborted", async () => {
      const workDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "lnori-test-"));
      const destPath = path.join(workDir, "long-stream.epub");

      function makeEntry(name: string, data: Buffer, compMethod = 0, compData: Buffer | null = null): Buffer {
        const nameBuf = Buffer.from(name);
        const payload = compData || data;
        const crc = zlib.crc32(data);
        const h = Buffer.alloc(30 + nameBuf.length);
        h.writeUInt32LE(0x04034b50, 0);
        h.writeUInt16LE(20, 4);
        h.writeUInt16LE(0, 6);
        h.writeUInt16LE(compMethod, 8);
        h.writeUInt16LE(0, 10);
        h.writeUInt16LE(0, 12);
        h.writeUInt32LE(crc, 14);
        h.writeUInt32LE(payload.length, 18);
        h.writeUInt32LE(data.length, 22);
        h.writeUInt16LE(nameBuf.length, 26);
        h.writeUInt16LE(0, 28);
        nameBuf.copy(h, 30);
        return Buffer.concat([h, payload]);
      }

      const mimeData = Buffer.from("application/epub+zip");
      const mimePart = makeEntry("mimetype", mimeData, 0);
      const containerXml = Buffer.from(
        '<?xml version="1.0"?><container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container"><rootfiles><rootfile full-path="content.opf" media-type="application/oebps-package+xml"/></rootfiles></container>',
      );
      const containerPart = makeEntry("META-INF/container.xml", containerXml, 8, zlib.deflateRawSync(containerXml));
      const opfXml = Buffer.from(
        '<?xml version="1.0"?><package xmlns="http://www.idpf.org/2007/opf" version="3.0"><metadata><dc:title>Test</dc:title></metadata><manifest/><spine/></package>',
      );
      const opfPart = makeEntry("content.opf", opfXml, 8, zlib.deflateRawSync(opfXml));
      const fullBuffer = Buffer.concat([mimePart, containerPart, opfPart, Buffer.alloc(512, 0)]);

      // Create stream with multiple chunks simulating a transfer that continues after fetch headers return
      const chunks = [
        new Uint8Array(fullBuffer.subarray(0, Math.floor(fullBuffer.length / 2))),
        new Uint8Array(fullBuffer.subarray(Math.floor(fullBuffer.length / 2))),
      ];

      const streamingBody = new ReadableStream<Uint8Array>({
        async start(controller) {
          for (const c of chunks) {
            controller.enqueue(c);
            await new Promise((r) => setTimeout(r, 25));
          }
          controller.close();
        },
      });

      try {
        await downloadLnoriEpub("long-stream.epub", destPath, undefined, {
          fetch: async () => new Response(streamingBody, { status: 200 }),
        });
        expect(fs.existsSync(destPath)).toBe(true);
        expect(fs.statSync(destPath).size).toBeGreaterThan(0);
      } finally {
        await fs.promises.rm(workDir, { recursive: true, force: true });
      }
    });

    it("aborts and cleans up when download stream stalls exceeding activity timeout", async () => {
      const workDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "lnori-test-"));
      const destPath = path.join(workDir, "stalled.epub");

      try {
        const stalledResponse = new Response(
          new ReadableStream<Uint8Array>({
            start(controller) {
              controller.enqueue(new Uint8Array([1, 2, 3]));
              // Stalls indefinitely without closing or enqueueing further
            },
          }),
          { status: 200 },
        );

        await expect(
          streamResponseToFile(
            stalledResponse,
            destPath,
            MAX_EPUB_BYTES,
            "Stalled EPUB",
            undefined,
            { activityTimeoutMs: 50 },
          ),
        ).rejects.toThrow("stream stalled (no data received for 50ms)");

        expect(fs.existsSync(destPath)).toBe(false);
      } finally {
        await fs.promises.rm(workDir, { recursive: true, force: true });
      }
    });

    it("falls back to proxy for cover fetch after direct network error", async () => {
      const workDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "lnori-test-"));
      let calls = 0;
      const proxyUsed: (string | undefined)[] = [];
      const jpegPath = path.join(workDir, "cover.jpg");
      try {
        const converted = await fetchAndConvertCover("23021", undefined, workDir, {
          fetch: async (_url: string, init: any) => {
            calls++;
            proxyUsed.push(init?.proxy);
            if (calls === 1) throw new Error("direct connection failed");
            return new Response(new Uint8Array([1, 2, 3]));
          },
          sipsPath: "fake-sips",
          spawnSync: (_command: string, args: string[]) => {
            fs.writeFileSync(args[args.length - 1], "jpeg");
            return { status: 0, stdout: "", stderr: "" };
          },
        });
        expect(converted).toBe(jpegPath);
        expect(calls).toBe(2);
        expect(proxyUsed[0]).toBeUndefined();
        expect(proxyUsed[1]).toBe("http://127.0.0.1:7890");
      } finally {
        await fs.promises.rm(workDir, { recursive: true, force: true });
      }
    });

    it("falls back to proxy for cover fetch on direct HTTP 403 before trying next candidate", async () => {
      const workDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "lnori-test-"));
      let calls = 0;
      const urlsCalled: string[] = [];
      const proxyUsed: (string | undefined)[] = [];
      const jpegPath = path.join(workDir, "cover.jpg");
      try {
        const converted = await fetchAndConvertCover(
          "23021",
          "https://fallback.com/cover.jpg",
          workDir,
          {
            fetch: async (url: string, init: any) => {
              calls++;
              urlsCalled.push(url);
              proxyUsed.push(init?.proxy);
              if (calls === 1) {
                // Direct WebP returns 403
                return new Response("Forbidden", { status: 403 });
              }
              // Proxy WebP returns 200 OK
              return new Response(new Uint8Array([1, 2, 3]), { status: 200 });
            },
            sipsPath: "fake-sips",
            spawnSync: (_command: string, args: string[]) => {
              fs.writeFileSync(args[args.length - 1], "jpeg");
              return { status: 0, stdout: "", stderr: "" };
            },
          },
        );
        expect(converted).toBe(jpegPath);
        expect(calls).toBe(2);
        // Both calls must be for the first candidate (cdn.lnori.com) before trying fallback
        expect(urlsCalled[0]).toContain("cdn.lnori.com");
        expect(urlsCalled[1]).toContain("cdn.lnori.com");
        expect(proxyUsed[0]).toBeUndefined();
        expect(proxyUsed[1]).toBe("http://127.0.0.1:7890");
      } finally {
        await fs.promises.rm(workDir, { recursive: true, force: true });
      }
    });

    it("throws on subprocess timeouts", () => {
      expect(() =>
        throwOnSubprocessTimeout({ error: { code: "ETIMEDOUT" } }, "test-command"),
      ).toThrow("test-command timed out after 60000ms");
      expect(() => throwOnSubprocessTimeout({}, "test-command")).not.toThrow();
    });

    it("rejects manifests over the per-request volume limit", async () => {
      const links = Array.from(
        { length: 51 },
        (_, index) => `<a href="/book/${index + 1}/volume-${index + 1}">Volume ${index + 1}</a>`,
      ).join("\n");
      await expect(
        ingestLnoriSeries("https://lnori.com/series/8046/test-series", undefined, {
          fetch: async () => new Response(`<title>Test Series</title>${links}`),
        }),
      ).rejects.toThrow("maximum allowed is 50 per request");
    });

    it("cleans the ingestion work directory when a volume download fails", async () => {
      const before = new Set(
        fs.readdirSync(os.tmpdir()).filter((entry: string) => entry.startsWith("lnori-")),
      );
      let requestCount = 0;
      const volumeHtml = `<script id="app-data" type="application/ld+json">${JSON.stringify({
        name: "Volume 1",
        additionalProperty: [
          { name: "epub_filename", value: "volume-1.epub" },
          { name: "book_id", value: "23021" },
        ],
      })}</script>`;
      const result = await ingestLnoriSeries("https://lnori.com/series/8046/test-series", undefined, {
        fetch: async (url: string) => {
          requestCount++;
          if (requestCount === 1) {
            return new Response('<title>Test Series</title><a href="/book/23021/volume-1">Volume 1</a>');
          }
          if (requestCount === 2) return new Response(volumeHtml);
          expect(url).toContain("files.lnori.com");
          return new Response("unavailable", { status: 503 });
        },
      });
      expect(result.success).toBe(false);
      expect(result.importedCount).toBe(0);
      expect(result.skippedCount).toBe(1);
      const after = fs
        .readdirSync(os.tmpdir())
        .filter((entry: string) => entry.startsWith("lnori-"));
      expect(after.filter((entry) => !before.has(entry))).toEqual([]);
    });

    it("rejects path-traversal ZIP entries and unlinks the EPUB", async () => {
      const workDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "lnori-test-"));
      const destPath = path.join(workDir, "traversal.epub");
      const pythonScript = `
import sys, zipfile
with zipfile.ZipFile(sys.argv[1], "w") as z:
    z.writestr("mimetype", "application/epub+zip", compress_type=zipfile.ZIP_STORED)
    z.writestr("META-INF/container.xml", "<container/>")
    z.writestr("../../escape.txt", "payload")
`;
      try {
        const result = Bun.spawnSync(["python3", "-c", pythonScript, destPath]);
        expect(result.exitCode).toBe(0);
        expect(() => validateDownloadedEpub(destPath)).toThrow(
          "Downloaded EPUB failed validation",
        );
        expect(fs.existsSync(destPath)).toBe(false);
      } finally {
        await fs.promises.rm(workDir, { recursive: true, force: true });
      }
    });

    it("throws validation errors and unlinks invalid EPUB files", async () => {
      const workDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "lnori-test-"));
      const destPath = path.join(workDir, "invalid.epub");
      await fs.promises.writeFile(destPath, "not an epub");
      try {
        expect(() => validateDownloadedEpub(destPath)).toThrow(
          "Downloaded EPUB failed validation: File size too small for a valid EPUB",
        );
        expect(fs.existsSync(destPath)).toBe(false);
      } finally {
        await fs.promises.rm(workDir, { recursive: true, force: true });
      }
    });

    it("validateDownloadedEpub heals truncated files missing central directory and preserves the file", async () => {
      const workDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "lnori-test-"));
      const destPath = path.join(workDir, "truncated.epub");

      function makeEntry(name: string, data: Buffer, compMethod = 0, compData: Buffer | null = null): Buffer {
        const nameBuf = Buffer.from(name);
        const payload = compData || data;
        const crc = zlib.crc32(data);
        const h = Buffer.alloc(30 + nameBuf.length);
        h.writeUInt32LE(0x04034b50, 0);
        h.writeUInt16LE(20, 4);
        h.writeUInt16LE(0, 6);
        h.writeUInt16LE(compMethod, 8);
        h.writeUInt16LE(0, 10);
        h.writeUInt16LE(0, 12);
        h.writeUInt32LE(crc, 14);
        h.writeUInt32LE(payload.length, 18);
        h.writeUInt32LE(data.length, 22);
        h.writeUInt16LE(nameBuf.length, 26);
        h.writeUInt16LE(0, 28);
        nameBuf.copy(h, 30);
        return Buffer.concat([h, payload]);
      }

      const mimeData = Buffer.from("application/epub+zip");
      const mimePart = makeEntry("mimetype", mimeData, 0);
      const containerXml = Buffer.from(
        '<?xml version="1.0"?><container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container"><rootfiles><rootfile full-path="content.opf" media-type="application/oebps-package+xml"/></rootfiles></container>',
      );
      const containerPart = makeEntry("META-INF/container.xml", containerXml, 8, zlib.deflateRawSync(containerXml));
      const opfXml = Buffer.from(
        '<?xml version="1.0"?><package xmlns="http://www.idpf.org/2007/opf" version="3.0"><metadata><dc:title>Test</dc:title></metadata><manifest/><spine/></package>',
      );
      const opfPart = makeEntry("content.opf", opfXml, 8, zlib.deflateRawSync(opfXml));

      // File without central directory and trailing zero padding
      fs.writeFileSync(destPath, Buffer.concat([mimePart, containerPart, opfPart, Buffer.alloc(512, 0)]));

      try {
        expect(() => validateDownloadedEpub(destPath)).not.toThrow();
        expect(fs.existsSync(destPath)).toBe(true);
      } finally {
        await fs.promises.rm(workDir, { recursive: true, force: true });
      }
    });
  });

  describe("Pre-Download Duplicate Detection", () => {
    it("isVolumeAlreadyInCalibre returns true when matching series and volume index in SQLite", async () => {
      const workDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "calibre-test-"));
      const dbPath = path.join(workDir, "metadata.db");
      const db = new Database(dbPath);
      db.run(`
        CREATE TABLE books (id INTEGER PRIMARY KEY, title TEXT, series_index REAL);
        CREATE TABLE series (id INTEGER PRIMARY KEY, name TEXT);
        CREATE TABLE books_series_link (id INTEGER PRIMARY KEY, book INTEGER, series INTEGER);
        INSERT INTO books VALUES (1, "Test Series: Volume 1", 1);
        INSERT INTO series VALUES (1, "Test Series");
        INSERT INTO books_series_link VALUES (1, 1, 1);
      `);
      db.close();

      try {
        expect(
          isVolumeAlreadyInCalibre("Test Series", 1, "Test Series: Volume 1", { calibreDbPath: dbPath }),
        ).toBe(true);
        expect(
          isVolumeAlreadyInCalibre("Test Series", 2, "Test Series: Volume 2", { calibreDbPath: dbPath }),
        ).toBe(false);
      } finally {
        await fs.promises.rm(workDir, { recursive: true, force: true });
      }
    });

    it("isVolumeAlreadyInCalibre matches rounded index only and does not treat fractional 1.5 as volume 1", async () => {
      const workDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "calibre-fractional-test-"));
      const dbPath = path.join(workDir, "metadata.db");
      const db = new Database(dbPath);
      db.run(`
        CREATE TABLE books (id INTEGER PRIMARY KEY, title TEXT, series_index REAL);
        CREATE TABLE series (id INTEGER PRIMARY KEY, name TEXT);
        CREATE TABLE books_series_link (id INTEGER PRIMARY KEY, book INTEGER, series INTEGER);
        INSERT INTO books VALUES (1, "Spice and Wolf: Volume 1.5", 1.5);
        INSERT INTO series VALUES (1, "Spice and Wolf");
        INSERT INTO books_series_link VALUES (1, 1, 1);
      `);
      db.close();

      try {
        // Checking for Volume 1 must be FALSE (not shadowed by 1.5)
        expect(
          isVolumeAlreadyInCalibre("Spice and Wolf", 1, "Spice and Wolf: Volume 1", { calibreDbPath: dbPath }),
        ).toBe(false);

        // Checking for Volume 1.5 must be TRUE
        expect(
          isVolumeAlreadyInCalibre("Spice and Wolf", 1.5, "Spice and Wolf: Volume 1.5", { calibreDbPath: dbPath }),
        ).toBe(true);
      } finally {
        await fs.promises.rm(workDir, { recursive: true, force: true });
      }
    });

    it("isVolumeAlreadyInCalibre returns true when matching title in SQLite", async () => {
      const workDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "calibre-test-"));
      const dbPath = path.join(workDir, "metadata.db");
      const db = new Database(dbPath);
      db.run(`
        CREATE TABLE books (id INTEGER PRIMARY KEY, title TEXT, series_index REAL);
        CREATE TABLE series (id INTEGER PRIMARY KEY, name TEXT);
        CREATE TABLE books_series_link (id INTEGER PRIMARY KEY, book INTEGER, series INTEGER);
        INSERT INTO books VALUES (1, "Some Light Novel: Volume 3", 3);
      `);
      db.close();

      try {
        expect(
          isVolumeAlreadyInCalibre("Different Series", 3, "Some Light Novel: Volume 3", { calibreDbPath: dbPath }),
        ).toBe(true);
      } finally {
        await fs.promises.rm(workDir, { recursive: true, force: true });
      }
    });

    it("isVolumeAlreadyInCalibre respects isVolumeInLibrary dependency hook", () => {
      const isVolumeInLibrary = (seriesTitle: string, volIdx: number) => {
        return seriesTitle === "Mock Series" && volIdx === 1;
      };
      expect(isVolumeAlreadyInCalibre("Mock Series", 1, "Mock Series: Volume 1", { isVolumeInLibrary })).toBe(true);
      expect(isVolumeAlreadyInCalibre("Mock Series", 2, "Mock Series: Volume 2", { isVolumeInLibrary })).toBe(false);
    });

    it("isVolumeAlreadyInCalibre finds a Year 1 volume stored at a fractional series_index (regression: Classroom of the Elite #9 / #10 were reported missing)", async () => {
      const workDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "calibre-cote-test-"));
      const dbPath = path.join(workDir, "metadata.db");
      const db = new Database(dbPath);
      db.run(`
        CREATE TABLE books (id INTEGER PRIMARY KEY, title TEXT, series_index REAL);
        CREATE TABLE series (id INTEGER PRIMARY KEY, name TEXT);
        CREATE TABLE books_series_link (id INTEGER PRIMARY KEY, book INTEGER, series INTEGER);
        INSERT INTO series VALUES (1, "Classroom of the Elite");
        INSERT INTO books VALUES (1, "Classroom of the Elite Vol. 9", 1.09);
        INSERT INTO books VALUES (2, "Classroom of the Elite Vol. 10", 1.1);
        INSERT INTO books VALUES (3, "Classroom of the Elite: Year 2 Vol. 9", 2.09);
        INSERT INTO books_series_link VALUES (1, 1, 1);
        INSERT INTO books_series_link VALUES (2, 2, 1);
        INSERT INTO books_series_link VALUES (3, 3, 1);
      `);
      db.close();

      try {
        // The library stores Year 1 at 1.0x, so a plain series_index comparison missed both.
        expect(
          isVolumeAlreadyInCalibre("Classroom of the Elite", 9, "Classroom of the Elite: Volume 9", { calibreDbPath: dbPath }),
        ).toBe(true);
        expect(
          isVolumeAlreadyInCalibre("Classroom of the Elite", 10, "Classroom of the Elite: Volume 10", { calibreDbPath: dbPath }),
        ).toBe(true);
        // A genuinely missing volume is still missing.
        expect(
          isVolumeAlreadyInCalibre("Classroom of the Elite", 12, "Classroom of the Elite: Volume 12", { calibreDbPath: dbPath }),
        ).toBe(false);
        // Year 2 volume 9 is its own namespace: it neither satisfies Year 1 volume 9 nor hides it.
        expect(
          isVolumeAlreadyInCalibre("Classroom of the Elite", 9, "Classroom of the Elite: Year 2 Volume 9", { calibreDbPath: dbPath }, "year:2"),
        ).toBe(true);
        expect(
          isVolumeAlreadyInCalibre("Classroom of the Elite", 5, "Classroom of the Elite: Year 2 Volume 5", { calibreDbPath: dbPath }, "year:2"),
        ).toBe(false);
      } finally {
        await fs.promises.rm(workDir, { recursive: true, force: true });
      }
    });

    it("isVolumeAlreadyInCalibre compares Bookworm parts inside their part namespace (regression: all parts sit at series_index 1.x)", async () => {
      const workDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "calibre-bookworm-test-"));
      const dbPath = path.join(workDir, "metadata.db");
      const db = new Database(dbPath);
      db.run(`
        CREATE TABLE books (id INTEGER PRIMARY KEY, title TEXT, series_index REAL);
        CREATE TABLE series (id INTEGER PRIMARY KEY, name TEXT);
        CREATE TABLE books_series_link (id INTEGER PRIMARY KEY, book INTEGER, series INTEGER);
        INSERT INTO series VALUES (1, "Ascendance of a Bookworm");
        INSERT INTO books VALUES (1, "Ascendance of a Bookworm: Short Story Collection Volume 1", 1.1);
        INSERT INTO books VALUES (2, "Ascendance of a Bookworm: Part 1 Daughter of a Soldier Volume 3", 1.3);
        INSERT INTO books VALUES (3, "Ascendance of a Bookworm: Part 2 Apprentice Shrine Maiden Volume 4", 1.4);
        INSERT INTO books_series_link VALUES (1, 1, 1);
        INSERT INTO books_series_link VALUES (2, 2, 1);
        INSERT INTO books_series_link VALUES (3, 3, 1);
      `);
      db.close();

      try {
        // Part 1 volume 3 is on disk at 1.3; asking for it must find it.
        expect(
          isVolumeAlreadyInCalibre("Ascendance of a Bookworm", 3, "Ascendance of a Bookworm: Part 1 Volume 3", { calibreDbPath: dbPath }, "part:1"),
        ).toBe(true);
        // Part 2 volume 4 is on disk at 1.4.
        expect(
          isVolumeAlreadyInCalibre("Ascendance of a Bookworm", 4, "Ascendance of a Bookworm: Part 2 Volume 4", { calibreDbPath: dbPath }, "part:2"),
        ).toBe(true);
        // Part 1 volume 1 is NOT on disk (the 1.1 row is a Short Story Collection, a different book).
        expect(
          isVolumeAlreadyInCalibre("Ascendance of a Bookworm", 1, "Ascendance of a Bookworm: Part 1 Volume 1", { calibreDbPath: dbPath }, "part:1"),
        ).toBe(false);
        // Part 2 volume 4 must not be answered by Part 1 volume 4's absence/presence.
        expect(
          isVolumeAlreadyInCalibre("Ascendance of a Bookworm", 3, "Ascendance of a Bookworm: Part 2 Volume 3", { calibreDbPath: dbPath }, "part:2"),
        ).toBe(false);
      } finally {
        await fs.promises.rm(workDir, { recursive: true, force: true });
      }
    });

    it("resolveIngestVolumeAssignment encodes the namespace into the one flat series_index Calibre stores", () => {
      // mainline volume
      expect(resolveIngestVolumeAssignment("Overlord", { volumeNumber: 15 }).seriesIndex).toBe(15);
      // a Year-N volume uses the library's own sub-series convention (Year 2 vol 9 -> 2.09)
      const yearTwo = resolveIngestVolumeAssignment("Classroom of the Elite", {
        volumeNumber: 9,
        title: "Classroom of the Elite: Year 2 Vol. 9",
      });
      expect(yearTwo.key).toEqual({ namespace: "year:2", volume: 9 });
      expect(yearTwo.seriesIndex).toBe(2.09);
      // a source-declared part keeps the historical part*100+volume encoding
      const partTwo = resolveIngestVolumeAssignment("Ascendance of a Bookworm", {
        volumeNumber: 4,
        partNumber: 2,
        title: "Ascendance of a Bookworm: Part 2 Volume 4",
      });
      expect(partTwo.key).toEqual({ namespace: "part:2", volume: 4 });
      expect(partTwo.seriesIndex).toBe(204);
    });

    it("ingestLnoriSeries continues to volume 2 when volume 1 download throws and reports one skipped error and one import", async () => {
      const manifestHtml = `<title>Resilience Test Series</title>
        <a href="/book/201/vol-1">Volume 1</a>
        <a href="/book/202/vol-2">Volume 2</a>`;
      const vol1Html = `<script id="app-data" type="application/ld+json">${JSON.stringify({
        name: "Volume 1",
        additionalProperty: [
          { name: "epub_filename", value: "vol1.epub" },
          { name: "book_id", value: "201" },
          { name: "series_title", value: "Resilience Test Series" },
        ],
      })}</script>`;
      const vol2Html = `<script id="app-data" type="application/ld+json">${JSON.stringify({
        name: "Volume 2",
        additionalProperty: [
          { name: "epub_filename", value: "vol2.epub" },
          { name: "book_id", value: "202" },
          { name: "series_title", value: "Resilience Test Series" },
        ],
      })}</script>`;

      function makeEntry(name: string, data: Buffer, compMethod = 0, compData: Buffer | null = null): Buffer {
        const nameBuf = Buffer.from(name);
        const payload = compData || data;
        const crc = zlib.crc32(data);
        const h = Buffer.alloc(30 + nameBuf.length);
        h.writeUInt32LE(0x04034b50, 0);
        h.writeUInt16LE(20, 4);
        h.writeUInt16LE(0, 6);
        h.writeUInt16LE(compMethod, 8);
        h.writeUInt16LE(0, 10);
        h.writeUInt16LE(0, 12);
        h.writeUInt32LE(crc, 14);
        h.writeUInt32LE(payload.length, 18);
        h.writeUInt32LE(data.length, 22);
        h.writeUInt16LE(nameBuf.length, 26);
        h.writeUInt16LE(0, 28);
        nameBuf.copy(h, 30);
        return Buffer.concat([h, payload]);
      }

      const mimeData = Buffer.from("application/epub+zip");
      const mimePart = makeEntry("mimetype", mimeData, 0);
      const containerXml = Buffer.from(
        '<?xml version="1.0"?><container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container"><rootfiles><rootfile full-path="content.opf" media-type="application/oebps-package+xml"/></rootfiles></container>',
      );
      const containerPart = makeEntry("META-INF/container.xml", containerXml, 8, zlib.deflateRawSync(containerXml));
      const opfXml = Buffer.from(
        '<?xml version="1.0"?><package xmlns="http://www.idpf.org/2007/opf" version="3.0"><metadata><dc:title>Test</dc:title></metadata><manifest/><spine/></package>',
      );
      const opfPart = makeEntry("content.opf", opfXml, 8, zlib.deflateRawSync(opfXml));
      const syntheticEpub = Buffer.concat([mimePart, containerPart, opfPart, Buffer.alloc(512, 0)]);

      let vol1Attempted = false;
      let vol2Downloaded = false;
      const progressEvents: LnoriProgressEvent[] = [];

      const result = await ingestLnoriSeries(
        "https://lnori.com/series/8888/resilience-test-series",
        (event) => {
          progressEvents.push(event);
        },
        {
          fetch: async (url: string) => {
            if (url.includes("/series/8888")) return new Response(manifestHtml);
            if (url.includes("/book/201")) return new Response(vol1Html);
            if (url.includes("/book/202")) return new Response(vol2Html);
            if (url.includes("vol1.epub")) {
              vol1Attempted = true;
              throw new Error("Disk read failure or network timeout on vol 1");
            }
            if (url.includes("vol2.epub")) {
              vol2Downloaded = true;
              return new Response(syntheticEpub, { status: 200 });
            }
            if (url.includes("cdn.lnori.com")) {
              return new Response(new Uint8Array([1, 2, 3]), { status: 200 });
            }
            return new Response("Not found", { status: 404 });
          },
          isVolumeInLibrary: () => false,
          spawnSync: (_cmd: string, args: string[]) => {
            if (args[0] === "add") {
              return { status: 0, stdout: "Added book ids: 888", stderr: "" };
            }
            return { status: 0, stdout: "", stderr: "" };
          },
        },
      );

      expect(vol1Attempted).toBe(true);
      expect(vol2Downloaded).toBe(true);
      expect(result.totalCount).toBe(2);
      expect(result.importedCount).toBe(1);
      expect(result.skippedCount).toBe(1);
      expect(result.skippedErrors).toBe(1);
      expect(result.duplicateCount).toBe(0);
      expect(result.success).toBe(true);
      expect(result.calibreBookIds).toEqual([888]);

      // Verify progress emitted import_error skip for vol 1
      const skippedEvent = progressEvents.find(
        (e) => e.phase === "volume" && e.data?.action === "skipped" && e.data?.reason === "import_error",
      );
      expect(skippedEvent).toBeDefined();
      expect(skippedEvent?.data?.volumeIndex).toBe(1);
    });

    it("ingestLnoriSeries downloads volume 1 when volume 1.5 is in SQLite library", async () => {
      const workDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "calibre-vol1-test-"));
      const dbPath = path.join(workDir, "metadata.db");
      const db = new Database(dbPath);
      db.run(`
        CREATE TABLE books (id INTEGER PRIMARY KEY, title TEXT, series_index REAL);
        CREATE TABLE series (id INTEGER PRIMARY KEY, name TEXT);
        CREATE TABLE books_series_link (id INTEGER PRIMARY KEY, book INTEGER, series INTEGER);
        INSERT INTO books VALUES (1, "Fractional Series: Volume 1.5", 1.5);
        INSERT INTO series VALUES (1, "Fractional Series");
        INSERT INTO books_series_link VALUES (1, 1, 1);
      `);
      db.close();

      const manifestHtml = `<title>Fractional Series</title>
        <a href="/book/301/vol-1">Volume 1</a>`;
      const vol1Html = `<script id="app-data" type="application/ld+json">${JSON.stringify({
        name: "Volume 1",
        additionalProperty: [
          { name: "epub_filename", value: "vol1.epub" },
          { name: "book_id", value: "301" },
          { name: "series_title", value: "Fractional Series" },
          { name: "volume_number", value: "1" },
        ],
      })}</script>`;

      function makeEntry(name: string, data: Buffer, compMethod = 0, compData: Buffer | null = null): Buffer {
        const nameBuf = Buffer.from(name);
        const payload = compData || data;
        const crc = zlib.crc32(data);
        const h = Buffer.alloc(30 + nameBuf.length);
        h.writeUInt32LE(0x04034b50, 0);
        h.writeUInt16LE(20, 4);
        h.writeUInt16LE(0, 6);
        h.writeUInt16LE(compMethod, 8);
        h.writeUInt16LE(0, 10);
        h.writeUInt16LE(0, 12);
        h.writeUInt32LE(crc, 14);
        h.writeUInt32LE(payload.length, 18);
        h.writeUInt32LE(data.length, 22);
        h.writeUInt16LE(nameBuf.length, 26);
        h.writeUInt16LE(0, 28);
        nameBuf.copy(h, 30);
        return Buffer.concat([h, payload]);
      }

      const mimeData = Buffer.from("application/epub+zip");
      const mimePart = makeEntry("mimetype", mimeData, 0);
      const containerXml = Buffer.from(
        '<?xml version="1.0"?><container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container"><rootfiles><rootfile full-path="content.opf" media-type="application/oebps-package+xml"/></rootfiles></container>',
      );
      const containerPart = makeEntry("META-INF/container.xml", containerXml, 8, zlib.deflateRawSync(containerXml));
      const opfXml = Buffer.from(
        '<?xml version="1.0"?><package xmlns="http://www.idpf.org/2007/opf" version="3.0"><metadata><dc:title>Test</dc:title></metadata><manifest/><spine/></package>',
      );
      const opfPart = makeEntry("content.opf", opfXml, 8, zlib.deflateRawSync(opfXml));
      const syntheticEpub = Buffer.concat([mimePart, containerPart, opfPart, Buffer.alloc(512, 0)]);

      let vol1Downloaded = false;

      try {
        const result = await ingestLnoriSeries(
          "https://lnori.com/series/7777/fractional-series",
          undefined,
          {
            calibreDbPath: dbPath,
            fetch: async (url: string) => {
              if (url.includes("/series/7777")) return new Response(manifestHtml);
              if (url.includes("/book/301")) return new Response(vol1Html);
              if (url.includes("vol1.epub")) {
                vol1Downloaded = true;
                return new Response(syntheticEpub, { status: 200 });
              }
              if (url.includes("cdn.lnori.com")) {
                return new Response(new Uint8Array([1, 2, 3]), { status: 200 });
              }
              return new Response("Not found", { status: 404 });
            },
            spawnSync: (_cmd: string, args: string[]) => {
              if (args[0] === "add") {
                return { status: 0, stdout: "Added book ids: 701", stderr: "" };
              }
              return { status: 0, stdout: "", stderr: "" };
            },
          },
        );

        // Volume 1 must have been downloaded and imported, not skipped
        expect(vol1Downloaded).toBe(true);
        expect(result.importedCount).toBe(1);
        expect(result.skippedCount).toBe(0);
        expect(result.duplicateCount).toBe(0);
      } finally {
        await fs.promises.rm(workDir, { recursive: true, force: true });
      }
    });

    it("ingestLnoriSeries skips downloading existing volumes and reports counts", async () => {
      const manifestHtml = `<title>Ingest Test Series</title>
        <a href="/book/101/vol-1">Volume 1</a>
        <a href="/book/102/vol-2">Volume 2</a>`;
      const vol1Html = `<script id="app-data" type="application/ld+json">${JSON.stringify({
        name: "Volume 1",
        additionalProperty: [
          { name: "epub_filename", value: "vol1.epub" },
          { name: "book_id", value: "101" },
          { name: "series_title", value: "Ingest Test Series" },
        ],
      })}</script>`;
      const vol2Html = `<script id="app-data" type="application/ld+json">${JSON.stringify({
        name: "Volume 2",
        additionalProperty: [
          { name: "epub_filename", value: "vol2.epub" },
          { name: "book_id", value: "102" },
          { name: "series_title", value: "Ingest Test Series" },
        ],
      })}</script>`;

      function makeEntry(name: string, data: Buffer, compMethod = 0, compData: Buffer | null = null): Buffer {
        const nameBuf = Buffer.from(name);
        const payload = compData || data;
        const crc = zlib.crc32(data);
        const h = Buffer.alloc(30 + nameBuf.length);
        h.writeUInt32LE(0x04034b50, 0);
        h.writeUInt16LE(20, 4);
        h.writeUInt16LE(0, 6);
        h.writeUInt16LE(compMethod, 8);
        h.writeUInt16LE(0, 10);
        h.writeUInt16LE(0, 12);
        h.writeUInt32LE(crc, 14);
        h.writeUInt32LE(payload.length, 18);
        h.writeUInt32LE(data.length, 22);
        h.writeUInt16LE(nameBuf.length, 26);
        h.writeUInt16LE(0, 28);
        nameBuf.copy(h, 30);
        return Buffer.concat([h, payload]);
      }

      const mimeData = Buffer.from("application/epub+zip");
      const mimePart = makeEntry("mimetype", mimeData, 0);
      const containerXml = Buffer.from(
        '<?xml version="1.0"?><container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container"><rootfiles><rootfile full-path="content.opf" media-type="application/oebps-package+xml"/></rootfiles></container>',
      );
      const containerPart = makeEntry("META-INF/container.xml", containerXml, 8, zlib.deflateRawSync(containerXml));
      const opfXml = Buffer.from(
        '<?xml version="1.0"?><package xmlns="http://www.idpf.org/2007/opf" version="3.0"><metadata><dc:title>Test</dc:title></metadata><manifest/><spine/></package>',
      );
      const opfPart = makeEntry("content.opf", opfXml, 8, zlib.deflateRawSync(opfXml));
      const syntheticEpub = Buffer.concat([mimePart, containerPart, opfPart, Buffer.alloc(512, 0)]);

      let vol2Downloaded = false;
      const result = await ingestLnoriSeries(
        "https://lnori.com/series/9999/ingest-test-series",
        undefined,
        {
          fetch: async (url: string) => {
            if (url.includes("/series/9999")) return new Response(manifestHtml);
            if (url.includes("/book/101")) return new Response(vol1Html);
            if (url.includes("/book/102")) return new Response(vol2Html);
            if (url.includes("files.lnori.com")) {
              vol2Downloaded = true;
              return new Response(syntheticEpub, { status: 200 });
            }
            if (url.includes("cdn.lnori.com")) {
              return new Response(new Uint8Array([1, 2, 3]), { status: 200 });
            }
            return new Response("Not found", { status: 404 });
          },
          // Mock isVolumeInLibrary: Volume 1 already exists, Volume 2 does NOT
          isVolumeInLibrary: (_series: string, index: number) => {
            return index === 1;
          },
          spawnSync: (_cmd: string, args: string[]) => {
            if (args[0] === "add") {
              return { status: 0, stdout: "Added book ids: 123", stderr: "" };
            }
            return { status: 0, stdout: "", stderr: "" };
          },
        },
      );

      expect(result.totalCount).toBe(2);
      expect(result.skippedCount).toBe(1);
      expect(result.duplicateCount).toBe(1);
      expect(result.importedCount).toBe(1);
      expect(result.success).toBe(true);
      expect(vol2Downloaded).toBe(true);
    });

    it("ingestLnoriSeries sets volume synopsis in calibredb set_metadata from volMeta.description", async () => {
      function makeEntry(name: string, data: Buffer, compMethod = 0, compData: Buffer | null = null): Buffer {
        const nameBuf = Buffer.from(name);
        const payload = compData || data;
        const crc = zlib.crc32(data);
        const h = Buffer.alloc(30 + nameBuf.length);
        h.writeUInt32LE(0x04034b50, 0);
        h.writeUInt16LE(20, 4);
        h.writeUInt16LE(0, 6);
        h.writeUInt16LE(compMethod, 8);
        h.writeUInt16LE(0, 10);
        h.writeUInt16LE(0, 12);
        h.writeUInt32LE(crc, 14);
        h.writeUInt32LE(payload.length, 18);
        h.writeUInt32LE(data.length, 22);
        h.writeUInt16LE(nameBuf.length, 26);
        h.writeUInt16LE(0, 28);
        nameBuf.copy(h, 30);
        return Buffer.concat([h, payload]);
      }

      const mimeData = Buffer.from("application/epub+zip");
      const mimePart = makeEntry("mimetype", mimeData, 0);
      const containerXml = Buffer.from(
        '<?xml version="1.0"?><container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container"><rootfiles><rootfile full-path="content.opf" media-type="application/oebps-package+xml"/></rootfiles></container>',
      );
      const containerPart = makeEntry("META-INF/container.xml", containerXml, 8, zlib.deflateRawSync(containerXml));
      const opfXml = Buffer.from(
        '<?xml version="1.0"?><package xmlns="http://www.idpf.org/2007/opf" version="3.0"><metadata><dc:title>Test</dc:title></metadata><manifest/><spine/></package>',
      );
      const opfPart = makeEntry("content.opf", opfXml, 8, zlib.deflateRawSync(opfXml));
      const syntheticEpub = Buffer.concat([mimePart, containerPart, opfPart, Buffer.alloc(512, 0)]);

      const manifestHtml = `
        <html>
        <script id="app-data" type="application/ld+json">
        {
          "@type": "Book",
          "name": "Overlord",
          "hasPart": [
            { "@type": "Book", "url": "https://lnori.com/book/501/overlord-vol-1" }
          ]
        }
        </script>
        </html>
      `;

      const vol1Html = `
        <html>
        <script id="app-data" type="application/ld+json">
        {
          "@type": "Book",
          "name": "Overlord Vol. 1",
          "id": "501",
          "description": "Momonga is trapped in Yggdrasil as the undead sorcerer king.",
          "additionalProperty": [
            { "name": "epub_filename", "value": "Overlord_01.epub" },
            { "name": "book_id", "value": "501" },
            { "name": "series_title", "value": "Overlord" }
          ]
        }
        </script>
        </html>
      `;

      let capturedSetMetadataArgs: string[] = [];

      await ingestLnoriSeries(
        "https://lnori.com/series/500/overlord",
        undefined,
        {
          fetch: async (url: string) => {
            if (url.includes("/series/500")) return new Response(manifestHtml);
            if (url.includes("/book/501")) return new Response(vol1Html);
            if (url.includes("files.lnori.com")) {
              return new Response(syntheticEpub, { status: 200 });
            }
            return new Response("Not found", { status: 404 });
          },
          isVolumeInLibrary: () => false,
          spawnSync: (_cmd: string, args: string[]) => {
            if (args[0] === "add") {
              return { status: 0, stdout: "Added book ids: 501", stderr: "" };
            }
            if (args[0] === "set_metadata") {
              capturedSetMetadataArgs = args;
              return { status: 0, stdout: "", stderr: "" };
            }
            return { status: 0, stdout: "", stderr: "" };
          },
        },
      );

      const commentsArg = capturedSetMetadataArgs.find((a) => a.startsWith("comments:"));
      expect(commentsArg).toBeDefined();
      expect(commentsArg).toContain("Momonga is trapped in Yggdrasil");
    });

    it("falls back to fetchOnlineSynopsis when volMeta, EPUB, and manifest lack synopsis", async () => {
      function makeEntry(name: string, data: Buffer, compMethod = 0, compData: Buffer | null = null): Buffer {
        const nameBuf = Buffer.from(name);
        const payload = compData || data;
        const crc = zlib.crc32(data);
        const h = Buffer.alloc(30 + nameBuf.length);
        h.writeUInt32LE(0x04034b50, 0);
        h.writeUInt16LE(20, 4);
        h.writeUInt16LE(0, 6);
        h.writeUInt16LE(compMethod, 8);
        h.writeUInt16LE(0, 10);
        h.writeUInt16LE(0, 12);
        h.writeUInt32LE(crc, 14);
        h.writeUInt32LE(payload.length, 18);
        h.writeUInt32LE(data.length, 22);
        h.writeUInt16LE(nameBuf.length, 26);
        h.writeUInt16LE(0, 28);
        nameBuf.copy(h, 30);
        return Buffer.concat([h, payload]);
      }

      const mimeData = Buffer.from("application/epub+zip");
      const mimePart = makeEntry("mimetype", mimeData, 0);
      const containerXml = Buffer.from(
        '<?xml version="1.0"?><container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container"><rootfiles><rootfile full-path="content.opf" media-type="application/oebps-package+xml"/></rootfiles></container>',
      );
      const containerPart = makeEntry("META-INF/container.xml", containerXml, 8, zlib.deflateRawSync(containerXml));
      // EPUB has no description
      const opfXml = Buffer.from(
        '<?xml version="1.0"?><package xmlns="http://www.idpf.org/2007/opf" version="3.0"><metadata><dc:title>Test</dc:title></metadata><manifest/><spine/></package>',
      );
      const opfPart = makeEntry("content.opf", opfXml, 8, zlib.deflateRawSync(opfXml));
      const syntheticEpub = Buffer.concat([mimePart, containerPart, opfPart, Buffer.alloc(512, 0)]);

      // Manifest has no description
      const manifestHtml = `
        <html>
        <script id="app-data" type="application/ld+json">
        {
          "@type": "Book",
          "name": "No Description Series",
          "author": { "@type": "Person", "name": "Kugane Maruyama" },
          "hasPart": [
            { "@type": "Book", "url": "https://lnori.com/book/601/vol-1" }
          ]
        }
        </script>
        </html>
      `;

      // Volume metadata has no description
      const volHtml = `
        <html>
        <script id="app-data" type="application/ld+json">
        {
          "@type": "Book",
          "name": "No Description Vol 1",
          "id": "601",
          "additionalProperty": [
            { "name": "epub_filename", "value": "vol1.epub" },
            { "name": "book_id", "value": "601" }
          ]
        }
        </script>
        </html>
      `;

      const capturedCalibreArgs: string[][] = [];
      const onlineCalls: any[] = [];
      const mockFetchOnlineSynopsis = async (book: any, options?: any) => {
        onlineCalls.push({ book, options });
        return {
          description: "Online synopsis for No Description Series Volume 1",
          source: "RanobeDB",
        };
      };

      const result = await ingestLnoriSeries(
        "https://lnori.com/series/600/no-desc",
        undefined,
        {
          fetch: async (url: string) => {
            if (url.includes("/series/600")) return new Response(manifestHtml);
            if (url.includes("/book/601")) return new Response(volHtml);
            if (url.includes("files.lnori.com")) {
              return new Response(syntheticEpub, { status: 200 });
            }
            return new Response("Not found", { status: 404 });
          },
          spawnSync: (_cmd: string, args: string[]) => {
            capturedCalibreArgs.push(args);
            if (args[0] === "add") {
              return { status: 0, stdout: "Added book ids: 601", stderr: "" };
            }
            return { status: 0, stdout: "", stderr: "" };
          },
          fetchOnlineSynopsis: mockFetchOnlineSynopsis as any,
        },
      );

      expect(result.success).toBe(true);
      expect(result.importedCount).toBe(1);
      expect(onlineCalls.length).toBe(1);
      expect(onlineCalls[0].book.title).toContain("No Description Series");
      expect(onlineCalls[0].options?.seriesCache).toBeDefined();

      const commentsCommands = capturedCalibreArgs.filter(
        (c) => c[0] === "set_metadata" && c.some((arg) => arg.startsWith("comments:")),
      );
      expect(commentsCommands.length).toBe(1);
      expect(commentsCommands[0].find((arg) => arg.startsWith("comments:"))).toContain(
        "Online synopsis for No Description Series Volume 1",
      );
    });

    it("emits structured LnoriProgressEvent objects for manifest, volume, and complete phases", async () => {
      function makeEntry(name: string, data: Buffer, compMethod = 0, compData: Buffer | null = null): Buffer {
        const nameBuf = Buffer.from(name);
        const payload = compData || data;
        const crc = zlib.crc32(data);
        const h = Buffer.alloc(30 + nameBuf.length);
        h.writeUInt32LE(0x04034b50, 0);
        h.writeUInt16LE(20, 4);
        h.writeUInt16LE(0, 6);
        h.writeUInt16LE(compMethod, 8);
        h.writeUInt16LE(0, 10);
        h.writeUInt16LE(0, 12);
        h.writeUInt32LE(crc, 14);
        h.writeUInt32LE(payload.length, 18);
        h.writeUInt32LE(data.length, 22);
        h.writeUInt16LE(nameBuf.length, 26);
        h.writeUInt16LE(0, 28);
        nameBuf.copy(h, 30);
        return Buffer.concat([h, payload]);
      }

      const mimeData = Buffer.from("application/epub+zip");
      const mimePart = makeEntry("mimetype", mimeData, 0);
      const containerXml = Buffer.from(
        '<?xml version="1.0"?><container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container"><rootfiles><rootfile full-path="content.opf" media-type="application/oebps-package+xml"/></rootfiles></container>',
      );
      const containerPart = makeEntry("META-INF/container.xml", containerXml, 8, zlib.deflateRawSync(containerXml));
      const opfXml = Buffer.from(
        '<?xml version="1.0"?><package xmlns="http://www.idpf.org/2007/opf" version="3.0"><metadata><dc:title>Test</dc:title></metadata><manifest/><spine/></package>',
      );
      const opfPart = makeEntry("content.opf", opfXml, 8, zlib.deflateRawSync(opfXml));
      const syntheticEpub = Buffer.concat([mimePart, containerPart, opfPart, Buffer.alloc(512, 0)]);

      const manifestHtml = `
        <html>
        <script id="app-data" type="application/ld+json">
        {
          "@type": "Book",
          "name": "Progress Test Series",
          "author": { "@type": "Person", "name": "Author Name" },
          "hasPart": [
            { "@type": "Book", "url": "https://lnori.com/book/701/vol-1" },
            { "@type": "Book", "url": "https://lnori.com/book/702/vol-2" }
          ]
        }
        </script>
        </html>
      `;

      const vol1Html = `
        <html>
        <script id="app-data" type="application/ld+json">
        {
          "@type": "Book",
          "name": "Progress Test Vol 1",
          "id": "701",
          "additionalProperty": [
            { "name": "epub_filename", "value": "vol1.epub" },
            { "name": "book_id", "value": "701" }
          ]
        }
        </script>
        </html>
      `;

      const vol2Html = `
        <html>
        <script id="app-data" type="application/ld+json">
        {
          "@type": "Book",
          "name": "Progress Test Vol 2",
          "id": "702",
          "additionalProperty": [
            { "name": "epub_filename", "value": "vol2.epub" },
            { "name": "book_id", "value": "702" }
          ]
        }
        </script>
        </html>
      `;

      const events: LnoriProgressEvent[] = [];
      const result = await ingestLnoriSeries(
        "https://lnori.com/series/700/progress-test",
        async (event: LnoriProgressEvent) => {
          events.push(event);
        },
        {
          fetch: async (url: string) => {
            if (url.includes("/series/700")) return new Response(manifestHtml);
            if (url.includes("/book/701")) return new Response(vol1Html);
            if (url.includes("/book/702")) return new Response(vol2Html);
            if (url.includes("files.lnori.com")) {
              return new Response(syntheticEpub, { status: 200 });
            }
            return new Response("Not found", { status: 404 });
          },
          // Volume 1 is skipped (duplicate), Volume 2 is imported
          isVolumeInLibrary: (_series: string, index: number) => index === 1,
          spawnSync: (_cmd: string, args: string[]) => {
            if (args[0] === "add") return { status: 0, stdout: "Added book ids: 702", stderr: "" };
            return { status: 0, stdout: "", stderr: "" };
          },
        },
      );

      expect(result.success).toBe(true);
      expect(result.importedCount).toBe(1);
      expect(result.skippedCount).toBe(1);
      expect(result.totalCount).toBe(2);

      // Verify progress events were emitted
      expect(events.length).toBeGreaterThan(0);

      // Check manifest phases
      const manifestEvents = events.filter((e) => e.phase === "manifest");
      expect(manifestEvents.length).toBeGreaterThanOrEqual(2);
      expect(manifestEvents[0].data?.action).toBe("fetching_manifest");
      expect(manifestEvents[1].data?.action).toBe("manifest_ready");
      expect(manifestEvents[1].total).toBe(2);
      expect(manifestEvents[1].volumeTitle).toBe("Progress Test Series");

      // Check volume phases
      const volumeEvents = events.filter((e) => e.phase === "volume");
      expect(volumeEvents.length).toBeGreaterThan(0);

      // Check skipped volume 1
      const skippedEvent = volumeEvents.find((e) => e.index === 1 && e.data?.action === "skipped");
      expect(skippedEvent).toBeDefined();
      expect(skippedEvent?.data?.reason).toBe("already_exists");

      // Check imported volume 2
      const downloadingEvent = volumeEvents.find((e) => e.index === 2 && e.data?.action === "downloading");
      expect(downloadingEvent).toBeDefined();

      const addingEvent = volumeEvents.find((e) => e.index === 2 && e.data?.action === "adding_calibre");
      expect(addingEvent).toBeDefined();

      const importedEvent = volumeEvents.find((e) => e.index === 2 && e.data?.action === "imported");
      expect(importedEvent).toBeDefined();
      expect(importedEvent?.data?.calibreId).toBe(702);

      // Check complete phase
      const completeEvents = events.filter((e) => e.phase === "complete");
      expect(completeEvents.length).toBe(1);
      expect(completeEvents[0].data.importedCount).toBe(1);
      expect(completeEvents[0].data.skippedCount).toBe(1);
      expect(completeEvents[0].data.totalCount).toBe(2);
    });

    it("formats progress events cleanly for string consumers via formatLnoriProgress", async () => {
      const manifestHtml = `
        <html>
        <script id="app-data" type="application/ld+json">
        {
          "@type": "Book",
          "name": "String Callback Test",
          "hasPart": [
            { "@type": "Book", "url": "https://lnori.com/book/801/vol-1" }
          ]
        }
        </script>
        </html>
      `;

      const vol1Html = `
        <html>
        <script id="app-data" type="application/ld+json">
        {
          "@type": "Book",
          "name": "String Callback Vol 1",
          "id": "801",
          "additionalProperty": [
            { "name": "epub_filename", "value": "vol1.epub" },
            { "name": "book_id", "value": "801" }
          ]
        }
        </script>
        </html>
      `;

      const receivedStrings: string[] = [];
      const stringCallback = (event: LnoriProgressEvent | string) => {
        const text = typeof event === "string" ? event : formatLnoriProgress(event);
        receivedStrings.push(text);
        return Promise.resolve();
      };

      await ingestLnoriSeries(
        "https://lnori.com/series/800/string-test",
        stringCallback,
        {
          fetch: async (url: string) => {
            if (url.includes("/series/800")) return new Response(manifestHtml);
            if (url.includes("/book/801")) return new Response(vol1Html);
            return new Response("Not found", { status: 404 });
          },
          isVolumeInLibrary: () => true, // skip volume
        },
      );

      expect(receivedStrings.length).toBeGreaterThan(0);
      for (const s of receivedStrings) {
        expect(typeof s).toBe("string");
        expect(s).not.toBe("[object Object]");
        expect(s.length).toBeGreaterThan(0);
      }
    });

    it("aborts when dependencies.signal is aborted before or during volume loop", async () => {
      const manifestHtml = `
        <html>
        <script id="app-data" type="application/ld+json">
        {
          "@type": "Book",
          "name": "Abort Lnori Series",
          "hasPart": [
            { "@type": "Book", "url": "https://lnori.com/book/901/vol-1" },
            { "@type": "Book", "url": "https://lnori.com/book/902/vol-2" }
          ]
        }
        </script>
        </html>
      `;

      const abortController = new AbortController();
      // Abort immediately
      abortController.abort();

      let threw = false;
      try {
        await ingestLnoriSeries(
          "https://lnori.com/series/900/abort-series",
          undefined,
          {
            fetch: async () => new Response(manifestHtml),
            signal: abortController.signal,
          },
        );
      } catch (err: any) {
        threw = true;
        expect(err.message).toContain("aborted by client");
      }
      expect(threw).toBe(true);
    });

    it("counts volumes with missing epub_filename in skippedCount", async () => {
      const manifestHtml = `
        <html>
        <script id="app-data" type="application/ld+json">
        {
          "@type": "Book",
          "name": "Missing EPUB Series",
          "hasPart": [
            { "@type": "Book", "url": "https://lnori.com/book/951/vol-1" }
          ]
        }
        </script>
        </html>
      `;

      // Volume without epub_filename
      const volHtml = `
        <html>
        <script id="app-data" type="application/ld+json">
        {
          "@type": "Book",
          "name": "Missing EPUB Vol 1",
          "id": "951",
          "additionalProperty": [
            { "name": "book_id", "value": "951" }
          ]
        }
        </script>
        </html>
      `;

      const result = await ingestLnoriSeries(
        "https://lnori.com/series/950/missing-epub-series",
        undefined,
        {
          fetch: async (url: string) => {
            if (url.includes("/series/950")) return new Response(manifestHtml);
            if (url.includes("/book/951")) return new Response(volHtml);
            return new Response("Not found", { status: 404 });
          },
        },
      );

      expect(result.totalCount).toBe(1);
      expect(result.skippedCount).toBe(1);
      expect(result.importedCount).toBe(0);
      expect(result.success).toBe(true);
    });

    it("aborts in-flight download when dependencies.signal is aborted", async () => {
      const abortController = new AbortController();
      let abortedSignalSeen = false;

      let threw = false;
      try {
        await downloadLnoriEpub(
          "test.epub",
          "/tmp/test_abort.epub",
          undefined,
          {
            fetch: async (_url: string, init?: any) => {
              abortController.abort();
              if (init?.signal?.aborted) {
                abortedSignalSeen = true;
                const err = new Error("The operation was aborted");
                err.name = "AbortError";
                throw err;
              }
              return new Response("not aborted");
            },
            signal: abortController.signal,
          },
        );
      } catch (err: any) {
        threw = true;
        expect(err.name === "AbortError" || err.message.includes("aborted")).toBe(true);
      }
      expect(threw).toBe(true);
      expect(abortedSignalSeen).toBe(true);
    });

    it("aborts when dependencies.signal is aborted during cover conversion and does not import volume", async () => {
      function makeEntry(name: string, data: Buffer, compMethod = 0, compData: Buffer | null = null): Buffer {
        const nameBuf = Buffer.from(name);
        const payload = compData || data;
        const crc = zlib.crc32(data);
        const h = Buffer.alloc(30 + nameBuf.length);
        h.writeUInt32LE(0x04034b50, 0);
        h.writeUInt16LE(20, 4);
        h.writeUInt16LE(0, 6);
        h.writeUInt16LE(compMethod, 8);
        h.writeUInt16LE(0, 10);
        h.writeUInt16LE(0, 12);
        h.writeUInt32LE(crc, 14);
        h.writeUInt32LE(payload.length, 18);
        h.writeUInt32LE(data.length, 22);
        h.writeUInt16LE(nameBuf.length, 26);
        h.writeUInt16LE(0, 28);
        nameBuf.copy(h, 30);
        return Buffer.concat([h, payload]);
      }

      const mimeData = Buffer.from("application/epub+zip");
      const mimePart = makeEntry("mimetype", mimeData, 0);
      const containerXml = Buffer.from(
        '<?xml version="1.0"?><container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container"><rootfiles><rootfile full-path="content.opf" media-type="application/oebps-package+xml"/></rootfiles></container>',
      );
      const containerPart = makeEntry("META-INF/container.xml", containerXml, 8, zlib.deflateRawSync(containerXml));
      const opfXml = Buffer.from(
        '<?xml version="1.0"?><package xmlns="http://www.idpf.org/2007/opf" version="3.0"><metadata><dc:title>Test</dc:title></metadata><manifest/><spine/></package>',
      );
      const opfPart = makeEntry("content.opf", opfXml, 8, zlib.deflateRawSync(opfXml));
      const syntheticEpub = Buffer.concat([mimePart, containerPart, opfPart, Buffer.alloc(512, 0)]);

      const manifestHtml = `
        <html>
        <script id="app-data" type="application/ld+json">
        {
          "@type": "Book",
          "name": "Cover Abort Series",
          "hasPart": [
            { "@type": "Book", "url": "https://lnori.com/book/991/vol-1" }
          ]
        }
        </script>
        </html>
      `;

      const vol1Html = `
        <html>
        <script id="app-data" type="application/ld+json">
        {
          "@type": "Book",
          "name": "Cover Abort Vol 1",
          "id": "991",
          "image": "https://cdn.lnori.com/cover/991.webp",
          "additionalProperty": [
            { "name": "epub_filename", "value": "vol1.epub" },
            { "name": "book_id", "value": "991" },
            { "name": "cover_image_url", "value": "https://cdn.lnori.com/cover/991.webp" }
          ]
        }
        </script>
        </html>
      `;

      const abortController = new AbortController();
      let calibreAddCalled = false;
      let setMetadataCalled = false;

      let threw = false;
      try {
        await ingestLnoriSeries(
          "https://lnori.com/series/990/cover-abort",
          undefined,
          {
            fetch: async (url: string) => {
              if (url.includes("/series/990")) return new Response(manifestHtml);
              if (url.includes("/book/991")) return new Response(vol1Html);
              if (url.includes("files.lnori.com")) return new Response(syntheticEpub, { status: 200 });
              if (url.includes("cdn.lnori.com")) {
                // Abort during cover fetch!
                abortController.abort();
                const err = new Error("The operation was aborted");
                err.name = "AbortError";
                throw err;
              }
              return new Response("Not found", { status: 404 });
            },
            isVolumeInLibrary: () => false,
            spawnSync: (_cmd: string, args: string[]) => {
              if (args[0] === "add") {
                calibreAddCalled = true;
                return { status: 0, stdout: "Added book ids: 991", stderr: "" };
              }
              if (args[0] === "set_metadata") {
                setMetadataCalled = true;
                return { status: 0, stdout: "", stderr: "" };
              }
              return { status: 0, stdout: "", stderr: "" };
            },
            signal: abortController.signal,
          },
        );
      } catch (err: any) {
        threw = true;
        expect(err.name === "AbortError" || err.message.includes("aborted")).toBe(true);
      }

      expect(threw).toBe(true);
      expect(calibreAddCalled).toBe(true);
      // Volume must not finish metadata enrichment / import cycle after abort
      expect(setMetadataCalled).toBe(false);
    });

    it("aborts during volume HTML inspect on multi-volume series without continuing subsequent volumes", async () => {
      const manifestHtml = `
        <html>
        <script id="app-data" type="application/ld+json">
        {
          "@type": "Book",
          "name": "Volume Inspect Abort Series",
          "hasPart": [
            { "@type": "Book", "url": "https://lnori.com/book/1001/vol-1" },
            { "@type": "Book", "url": "https://lnori.com/book/1002/vol-2" },
            { "@type": "Book", "url": "https://lnori.com/book/1003/vol-3" }
          ]
        }
        </script>
        </html>
      `;

      const vol1Html = `
        <html>
        <script id="app-data" type="application/ld+json">
        {
          "@type": "Book",
          "name": "Inspect Vol 1",
          "id": "1001",
          "additionalProperty": [
            { "name": "epub_filename", "value": "vol1.epub" },
            { "name": "book_id", "value": "1001" }
          ]
        }
        </script>
        </html>
      `;

      const abortController = new AbortController();
      let vol2InspectCalled = false;
      let vol3InspectCalled = false;

      let threw = false;
      try {
        await ingestLnoriSeries(
          "https://lnori.com/series/1000/inspect-abort",
          undefined,
          {
            fetch: async (url: string) => {
              if (url.includes("/series/1000")) return new Response(manifestHtml);
              if (url.includes("/book/1001")) {
                // Vol 1: skipped (duplicate in library)
                return new Response(vol1Html);
              }
              if (url.includes("/book/1002")) {
                // Vol 2: abort during inspect!
                vol2InspectCalled = true;
                abortController.abort();
                const err = new Error("The operation was aborted");
                err.name = "AbortError";
                throw err;
              }
              if (url.includes("/book/1003")) {
                vol3InspectCalled = true;
                return new Response(vol1Html);
              }
              return new Response("Not found", { status: 404 });
            },
            isVolumeInLibrary: () => true, // vol 1 skipped
            signal: abortController.signal,
          },
        );
      } catch (err: any) {
        threw = true;
        expect(err.name === "AbortError" || err.message.includes("aborted")).toBe(true);
      }

      expect(threw).toBe(true);
      expect(vol2InspectCalled).toBe(true);
      // Volume 3 must NEVER have been inspected or downloaded
      expect(vol3InspectCalled).toBe(false);
    });

    it("formatLnoriProgress formats all phases cleanly", () => {
      expect(
        formatLnoriProgress({
          phase: "manifest",
          volumeTitle: "My Series",
          total: 10,
        }),
      ).toContain("Found 10 volumes in series \"My Series\"");

      expect(
        formatLnoriProgress({
          phase: "volume",
          index: 3,
          total: 10,
          volumeTitle: "My Series: Volume 3",
        }),
      ).toBe("[Volume 3/10] My Series: Volume 3");

      expect(
        formatLnoriProgress({
          phase: "complete",
          data: { importedCount: 8, skippedCount: 2 },
        }),
      ).toContain("Completed: 8 imported, 2 skipped");

      expect(
        formatLnoriProgress({
          phase: "volume",
          status: "Custom explicit status",
        }),
      ).toBe("Custom explicit status");
    });
  });

  describe("Lnori Storage Error Classification & Presentation", () => {
    it("classifyLnoriStorageResponse identifies Cloudflare Error 1016 on HTTP 530 with plain text body", () => {
      const result = classifyLnoriStorageResponse(530, "error code: 1016");
      expect(result.status).toBe(530);
      expect(result.code).toBe("CLOUDFLARE_DNS_1016");
      expect(result.isOriginDnsError).toBe(true);
      expect(result.userMessage).toContain("origin DNS error");
      expect(result.technicalDetail).toContain("Cloudflare Error 1016");
      expect(result.suggestion).toContain("Wait for Lnori storage to recover");
      expect(result.suggestion).toContain("upload EPUB files directly");
      expect(result.suggestion).not.toContain("restart");
      expect(result.suggestion).not.toContain("VPN");
    });

    it("classifyLnoriStorageResponse identifies Cloudflare Error 1016 on HTTP 530 with HTML body", () => {
      const htmlBody = `<!DOCTYPE html><html><head><title>files.lnori.com | 530: Origin DNS error</title></head>
        <body><h1>Error 1016</h1><p>Origin DNS error</p></body></html>`;
      const result = classifyLnoriStorageResponse(530, htmlBody, { server: "cloudflare" });
      expect(result.isOriginDnsError).toBe(true);
      expect(result.code).toBe("CLOUDFLARE_DNS_1016");
      expect(result.technicalDetail).toContain("Cloudflare Error 1016");
    });

    it("classifyLnoriStorageResponse does NOT falsely classify generic HTTP 530 as DNS 1016 without evidence", () => {
      const result = classifyLnoriStorageResponse(530, "Site temporarily down for maintenance");
      expect(result.isOriginDnsError).toBe(false);
      expect(result.code).toBe("HTTP_530_UNAVAILABLE");
      expect(result.userMessage).toContain("HTTP 530");
      expect(result.userMessage).not.toContain("1016");
      expect(result.technicalDetail).toBe("HTTP 530 (Storage service unavailable)");
    });

    it("classifyLnoriStorageResponse classifies HTTP 404, 403, and 500 accurately", () => {
      const res404 = classifyLnoriStorageResponse(404, "Not Found");
      expect(res404.code).toBe("NOT_FOUND");
      expect(res404.isOriginDnsError).toBe(false);
      expect(res404.userMessage).toContain("HTTP 404");

      const res403 = classifyLnoriStorageResponse(403, "Forbidden");
      expect(res403.code).toBe("FORBIDDEN");
      expect(res403.isOriginDnsError).toBe(false);
      expect(res403.userMessage).toContain("HTTP 403");

      const res500 = classifyLnoriStorageResponse(500, "Internal Server Error");
      expect(res500.code).toBe("HTTP_500");
      expect(res500.isOriginDnsError).toBe(false);
      expect(res500.userMessage).toContain("HTTP 500");
    });

    it("downloadLnoriEpub attaches classified storageError and does not leak raw signed URL on HTTP 530 1016", async () => {
      const workDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "lnori-test-530-"));
      try {
        let caughtErr: any = null;
        try {
          await downloadLnoriEpub("volume-01.epub", path.join(workDir, "vol.epub"), undefined, {
            fetch: async () =>
              new Response("error code: 1016", {
                status: 530,
                headers: { server: "cloudflare", "content-type": "text/plain" },
              }),
          });
        } catch (err: any) {
          caughtErr = err;
        }
        expect(caughtErr).not.toBeNull();
        expect(caughtErr.message).toContain("Failed to download EPUB from Lnori storage (530)");
        expect(caughtErr.message).toContain("Origin DNS error (Cloudflare Error 1016)");
        expect(caughtErr.message).not.toContain("https://files.lnori.com/");
        expect(caughtErr.storageError).toBeDefined();
        expect(caughtErr.storageError.isOriginDnsError).toBe(true);
        expect(caughtErr.storageError.code).toBe("CLOUDFLARE_DNS_1016");
      } finally {
        await fs.promises.rm(workDir, { recursive: true, force: true });
      }
    });

    it("ingestLnoriSeries accurately accounts all-failed series with Cloudflare 1016 and populates structured errorDetails", async () => {
      const manifestHtml = `<title>Bloom Into You: Regarding Saeki Sayaka</title>
        <a href="/book/8782/vol-1">Volume 1</a>
        <a href="/book/8783/vol-2">Volume 2</a>
        <a href="/book/8784/vol-3">Volume 3</a>`;

      const volHtml = (id: number, name: string, epub: string) => `<script id="app-data" type="application/ld+json">${JSON.stringify({
        name,
        additionalProperty: [
          { name: "epub_filename", value: epub },
          { name: "book_id", value: String(id) },
          { name: "series_title", value: "Bloom Into You: Regarding Saeki Sayaka" },
        ],
      })}</script>`;

      const progressEvents: LnoriProgressEvent[] = [];

      const result = await ingestLnoriSeries(
        "https://lnori.com/series/8782/bloom-into-you",
        (ev) => {
          progressEvents.push(ev);
        },
        {
          fetch: async (url: string) => {
            if (url.includes("/series/8782")) return new Response(manifestHtml);
            if (url.includes("/book/8782")) return new Response(volHtml(8782, "Volume 1", "vol1.epub"));
            if (url.includes("/book/8783")) return new Response(volHtml(8783, "Volume 2", "vol2.epub"));
            if (url.includes("/book/8784")) return new Response(volHtml(8784, "Volume 3", "vol3.epub"));
            if (url.includes("files.lnori.com")) {
              return new Response("error code: 1016", {
                status: 530,
                headers: { server: "cloudflare", "content-type": "text/plain" },
              });
            }
            return new Response("not found", { status: 404 });
          },
          sleep: async () => {},
        },
      );

      // Verify all-failed accounting
      expect(result.success).toBe(false);
      expect(result.importedCount).toBe(0);
      expect(result.skippedErrors).toBe(3);
      expect(result.error).toContain("origin DNS error (Cloudflare Error 1016)");
      expect(result.error).toContain("Wait for Lnori storage recovery or upload EPUB files directly");
      expect(result.errorDetails).toBeDefined();
      expect(result.errorDetails!.isOriginDnsError).toBe(true);
      expect(result.errorDetails!.code).toBe("CLOUDFLARE_DNS_1016");
      expect(result.errorDetails!.suggestion).toContain("upload EPUB files directly");
      expect(result.errorDetails!.failedVolumes).toHaveLength(3);

      // Verify progress emitted error phase with clear status
      const terminalEvent = progressEvents[progressEvents.length - 1];
      expect(terminalEvent.phase).toBe("error");
      expect(terminalEvent.status).toContain("origin DNS error (Cloudflare Error 1016)");
      expect(terminalEvent.data?.errorDetails?.isOriginDnsError).toBe(true);
    });

    it("ingestLnoriSeries accurately accounts partial import: 1 imported, 1 failed with 1016", async () => {
      const manifestHtml = `<title>Partial Test Series</title>
        <a href="/book/901/vol-1">Volume 1</a>
        <a href="/book/902/vol-2">Volume 2</a>`;

      const vol1Html = `<script id="app-data" type="application/ld+json">${JSON.stringify({
        name: "Volume 1",
        additionalProperty: [
          { name: "epub_filename", value: "vol1.epub" },
          { name: "book_id", value: "901" },
          { name: "series_title", value: "Partial Test Series" },
        ],
      })}</script>`;

      const vol2Html = `<script id="app-data" type="application/ld+json">${JSON.stringify({
        name: "Volume 2",
        additionalProperty: [
          { name: "epub_filename", value: "vol2.epub" },
          { name: "book_id", value: "902" },
          { name: "series_title", value: "Partial Test Series" },
        ],
      })}</script>`;

      function makeEntry(name: string, data: Buffer): Buffer {
        const nameBuf = Buffer.from(name);
        const crc = zlib.crc32(data);
        const h = Buffer.alloc(30 + nameBuf.length);
        h.writeUInt32LE(0x04034b50, 0);
        h.writeUInt16LE(20, 4);
        h.writeUInt16LE(0, 6);
        h.writeUInt16LE(0, 8);
        h.writeUInt16LE(0, 10);
        h.writeUInt16LE(0, 12);
        h.writeUInt32LE(crc, 14);
        h.writeUInt32LE(data.length, 18);
        h.writeUInt32LE(data.length, 22);
        h.writeUInt16LE(nameBuf.length, 26);
        h.writeUInt16LE(0, 28);
        nameBuf.copy(h, 30);
        return Buffer.concat([h, data]);
      }

      const mimeData = Buffer.from("application/epub+zip");
      const mimePart = makeEntry("mimetype", mimeData);
      const containerXml = Buffer.from('<?xml version="1.0"?><container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container"><rootfiles><rootfile full-path="content.opf" media-type="application/oebps-package+xml"/></rootfiles></container>');
      const containerPart = makeEntry("META-INF/container.xml", containerXml);
      const opfXml = Buffer.from('<?xml version="1.0"?><package xmlns="http://www.idpf.org/2007/opf" version="3.0"><metadata><dc:title>Test</dc:title></metadata><manifest/><spine/></package>');
      const opfPart = makeEntry("content.opf", opfXml);
      const syntheticEpub = Buffer.concat([mimePart, containerPart, opfPart, Buffer.alloc(256, 0)]);

      const progressEvents: LnoriProgressEvent[] = [];

      const result = await ingestLnoriSeries(
        "https://lnori.com/series/9000/partial-test",
        (ev) => {
          progressEvents.push(ev);
        },
        {
          fetch: async (url: string) => {
            if (url.includes("/series/9000")) return new Response(manifestHtml);
            if (url.includes("/book/901")) return new Response(vol1Html);
            if (url.includes("/book/902")) return new Response(vol2Html);
            if (url.includes("vol1.epub")) return new Response(syntheticEpub, { status: 200 });
            if (url.includes("vol2.epub")) {
              return new Response("error code: 1016", {
                status: 530,
                headers: { server: "cloudflare", "content-type": "text/plain" },
              });
            }
            return new Response("not found", { status: 404 });
          },
          spawnSync: (...args: any[]) => {
            const cmd = args[0];
            const cmdArgs = args[1];
            if (cmd.includes("calibredb") && cmdArgs?.includes("add")) {
              return { status: 0, stdout: "Added book ids: 4567\n", stderr: "" };
            }
            if (cmd.includes("calibredb") && cmdArgs?.includes("set_metadata")) {
              return { status: 0, stdout: "", stderr: "" };
            }
            return { status: 0, stdout: "", stderr: "" };
          },
          fetchOnlineSynopsis: async () => null,
          sleep: async () => {},
        },
      );

      // Verify partial import accounting: success is true because 1 was imported
      expect(result.success).toBe(true);
      expect(result.importedCount).toBe(1);
      expect(result.skippedErrors).toBe(1);
      expect(result.failedVolumes).toBeDefined();
      expect(result.failedVolumes).toHaveLength(1);
      expect(result.failedVolumes![0].volumeIndex).toBe(2);
      expect(result.errorDetails?.isOriginDnsError).toBe(true);

      const terminalEvent = progressEvents[progressEvents.length - 1];
      expect(terminalEvent.phase).toBe("complete");
      expect(terminalEvent.status).toContain("1 new volumes added");
      expect(terminalEvent.status).toContain("1 volumes failed");
    });
  });

  describe("Telegram Bot Flow Integration", () => {
    it("recognizes Lnori light novel URL before generic article ingestion", () => {
      const text = "Check out this series: https://lnori.com/series/8046/the-genius-princes-guide";
      const match = text.match(/https?:\/\/[^\s]+/);
      expect(match).not.toBeNull();
      expect(isLnoriUrl(match![0])).toBe(true);
    });
  });

  describe("Download resilience (B17 Retry-After, B18 short reads, in-loop validation)", () => {
    it("fails a short read against the declared content-length instead of accepting a truncated file", async () => {
      const workDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "lnori-short-"));
      const destPath = path.join(workDir, "short.epub");
      try {
        const response = new Response(new Uint8Array([1, 2, 3]), {
          headers: { "content-length": "10" },
        });
        await expect(
          streamResponseToFile(response, destPath, 1024, "Short EPUB"),
        ).rejects.toThrow("Short EPUB truncated transfer: received 3 of 10 bytes");
      } finally {
        await fs.promises.rm(workDir, { recursive: true, force: true });
      }
    });

    it("honours Retry-After on HTTP 429 instead of the guessed exponential backoff", async () => {
      const workDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "lnori-429-"));
      const destPath = path.join(workDir, "throttled.epub");
      const sleeps: number[] = [];
      let calls = 0;
      try {
        await expect(
          downloadLnoriEpub("throttled.epub", destPath, undefined, {
            sleep: async (ms: number) => {
              sleeps.push(ms);
            },
            fetch: async () => {
              calls++;
              return new Response("slow down", {
                status: 429,
                headers: { "retry-after": "7" },
              });
            },
          }),
        ).rejects.toThrow("Failed to download EPUB from Lnori storage (429)");

        // The host asked for 7 seconds; the guessed backoff would have been 1s then 2s.
        expect(sleeps.length).toBeGreaterThan(0);
        expect(sleeps.every((ms) => ms === 7000)).toBe(true);
        expect(sleeps).not.toContain(1000);
        expect(calls).toBeGreaterThan(1);
      } finally {
        await fs.promises.rm(workDir, { recursive: true, force: true });
      }
    });
  });
});
