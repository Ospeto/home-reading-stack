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
  type ParsedLnoriUrl,
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

    it("retries Lnori HTML fetch directly after a proxy network error", async () => {
      let calls = 0;
      const html = await fetchLnoriHtml("https://lnori.com/series/8046/test-series", {
        fetch: async () => {
          calls++;
          if (calls === 1) throw new Error("proxy unavailable");
          return new Response("<html>direct response</html>");
        },
      });
      expect(html).toBe("<html>direct response</html>");
      expect(calls).toBe(2);
    });

    it("retries EPUB download over proxy with backoff and fails after exhausting retries", async () => {
      const workDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "lnori-test-"));
      let calls = 0;
      const proxyUsed: (string | undefined)[] = [];
      try {
        await expect(
          downloadLnoriEpub("volume.epub", path.join(workDir, "volume.epub"), undefined, {
            fetch: async (_url: string, init: any) => {
              calls++;
              proxyUsed.push(init?.proxy);
              if (calls === 1) throw new Error("proxy unavailable");
              return new Response("unavailable", { status: 503 });
            },
          }),
        ).rejects.toThrow("Failed to download EPUB from Lnori storage (503)");
        expect(calls).toBe(4); // 1 initial attempt + 3 retries
        expect(proxyUsed.every((p) => p === "http://127.0.0.1:7890")).toBe(true);
      } finally {
        await fs.promises.rm(workDir, { recursive: true, force: true });
      }
    });

    it("retries cover fetch directly after a proxy network error", async () => {
      const workDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "lnori-test-"));
      let calls = 0;
      const jpegPath = path.join(workDir, "cover.jpg");
      try {
        const converted = await fetchAndConvertCover("23021", undefined, workDir, {
          fetch: async () => {
            calls++;
            if (calls === 1) throw new Error("proxy unavailable");
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
      await expect(
        ingestLnoriSeries("https://lnori.com/series/8046/test-series", undefined, {
          fetch: async (url: string) => {
            requestCount++;
            if (requestCount === 1) {
              return new Response('<title>Test Series</title><a href="/book/23021/volume-1">Volume 1</a>');
            }
            if (requestCount === 2) return new Response(volumeHtml);
            expect(url).toContain("files.lnori.com");
            return new Response("unavailable", { status: 503 });
          },
        }),
      ).rejects.toThrow("Failed to download EPUB from Lnori storage (503)");
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
  });

  describe("Telegram Bot Flow Integration", () => {
    it("recognizes Lnori light novel URL before generic article ingestion", () => {
      const text = "Check out this series: https://lnori.com/series/8046/the-genius-princes-guide";
      const match = text.match(/https?:\/\/[^\s]+/);
      expect(match).not.toBeNull();
      expect(isLnoriUrl(match![0])).toBe(true);
    });
  });
});
