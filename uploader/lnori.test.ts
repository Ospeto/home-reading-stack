import { describe, it, expect } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
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
  ingestLnoriSeries,
  throwOnSubprocessTimeout,
  validateDownloadedEpub,
  validateLnoriBookId,
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
    it("parseVolumeAppData extracts epub_filename, book_id, series metadata, and cover", () => {
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
