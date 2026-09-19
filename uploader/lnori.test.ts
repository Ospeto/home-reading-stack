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
  streamResponseToFile,
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
        const response = new Response(new Uint8Array(5));
        await expect(
          streamResponseToFile(response, destPath, 4, "Test EPUB"),
        ).rejects.toThrow("Test EPUB exceeds maximum size of 4 bytes");
        expect(fs.existsSync(destPath)).toBe(false);
        expect(MAX_EPUB_BYTES).toBe(256 * 1024 * 1024);
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
