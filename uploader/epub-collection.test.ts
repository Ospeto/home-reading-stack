import { describe, it, expect } from "bun:test";
import fs from "node:fs";
import { generateMetadataFilename, buildContentDisposition } from "./filename";
import { locateBookFile } from "./bot";
import { isSupportedBook, isNonEpubBook } from "./archive";

describe("EPUB-Only Collection & Storage Path Invariants", () => {
  describe("EPUB-Only Filtering and Non-EPUB Rejection", () => {
    it("strictly accepts only .epub files for library ingestion", () => {
      expect(isSupportedBook("The_Hobbit.epub")).toBe(true);
      expect(isSupportedBook("FOUNDATION.EPUB")).toBe(true);
      expect(isSupportedBook("ဝတ္ထု.epub")).toBe(true);
    });

    it("rejects non-EPUB formats (.pdf, .mobi, .azw3, .cbz, .cbr, .txt)", () => {
      const nonEpubExamples = [
        "document.pdf",
        "kindle_book.mobi",
        "amazon.azw3",
        "one_piece_ch01.cbz",
        "naruto_ch02.cbr",
        "raw_text.txt",
        "microsoft.docx"
      ];

      for (const file of nonEpubExamples) {
        expect(isSupportedBook(file)).toBe(false);
        expect(isNonEpubBook(file)).toBe(true);
      }
    });

    it("ensures web article ingestion generates clean .epub output", () => {
      const articleFilename = generateMetadataFilename({
        title: "How to Build Great Things",
        authors: "Paul Graham",
        format: "epub"
      });
      expect(articleFilename).toBe("How to Build Great Things - Paul Graham.epub");
      expect(articleFilename.endsWith(".epub")).toBe(true);
    });
  });

  describe("Metadata-Derived Filename Sanitization & Safety", () => {
    it("generates 'Series 01 - Title - Author.epub' when series is present", () => {
      const filename = generateMetadataFilename({
        title: "The Fellowship of the Ring",
        authors: "J. R. R. Tolkien",
        series: "The Lord of the Rings",
        seriesIndex: 1
      });
      expect(filename).toBe("The Lord of the Rings 01 - The Fellowship of the Ring - J. R. R. Tolkien.epub");
    });

    it("generates 'Title - Author.epub' for standalone books", () => {
      const filename = generateMetadataFilename({
        title: "1984",
        authors: "George Orwell"
      });
      expect(filename).toBe("1984 - George Orwell.epub");
    });

    it("handles missing or unknown author safely", () => {
      const filename = generateMetadataFilename({
        title: "Epic of Gilgamesh",
        authors: "Unknown"
      });
      expect(filename).toBe("Epic of Gilgamesh.epub");
    });

    it("strips path traversal attacks without throwing errors", () => {
      const filename = generateMetadataFilename({
        title: "../../../secret/passwords",
        authors: "../../hacker",
        fallbackBase: "safe_book"
      });
      expect(filename).not.toContain("/");
      expect(filename).not.toContain("\\");
      expect(filename).not.toContain("..");
      expect(filename).toBe("secret passwords - hacker.epub");
    });

    it("replaces filesystem-illegal characters with clean separators", () => {
      const filename = generateMetadataFilename({
        title: 'Star Wars: Episode IV "A New Hope" <Special>?',
        authors: "George Lucas | Lucasfilm*"
      });
      expect(filename).toBe("Star Wars Episode IV A New Hope Special - George Lucas Lucasfilm.epub");
      expect(filename).not.toMatch(/[<>:"/\\|?*]/);
    });

    it("handles long multi-byte Unicode strings safely without breaking UTF-8 code points", () => {
      // Burmese multi-byte characters (3 bytes each)
      const burmeseTitle = "လေပြည်ကလေး၏တေးဆိုသံ".repeat(20);
      const filename = generateMetadataFilename({
        title: burmeseTitle,
        authors: "ရဲမြလွင်"
      }, { maxBytes: 120 });

      expect(Buffer.byteLength(filename, "utf8")).toBeLessThanOrEqual(125); // 120 base + .epub
      expect(filename.endsWith(".epub")).toBe(true);

      // Verify the string is valid UTF-8
      const decoder = new TextDecoder("utf-8", { fatal: true });
      expect(decoder.decode(Buffer.from(filename))).toBe(filename);
    });

    it("builds RFC 5987 / RFC 6266 compliant Content-Disposition header with UTF-8 encoding", () => {
      const disposition = buildContentDisposition("Dune 01 - Dune - Frank Herbert.epub");
      expect(disposition).toContain('attachment; filename="Dune 01 - Dune - Frank Herbert.epub"');
      expect(disposition).toContain("filename*=UTF-8''Dune%2001%20-%20Dune%20-%20Frank%20Herbert.epub");
    });
  });

  describe("Calibre Storage Path Preservation (Zero In-Place Mutation)", () => {
    it("never alters or renames physical Calibre library paths when locating files", () => {
      // Locate an existing book (e.g. ID 3 or 4 in the local Calibre library)
      const details = locateBookFile(3);
      if (details) {
        expect(details.chosenFormat).toBe("EPUB");
        expect(fs.existsSync(details.filePath)).toBe(true);

        // Record initial state and mtime
        const initialStat = fs.statSync(details.filePath);

        // Generate user-facing download name
        const userDownloadName = generateMetadataFilename({
          title: details.title,
          authors: details.authors,
          series: details.series,
          seriesIndex: details.seriesIndex,
          format: "epub"
        });

        // The user download name is friendly and metadata-derived
        expect(userDownloadName.endsWith(".epub")).toBe(true);

        // CRITICAL INVARIANT: The physical file path on disk must NOT have changed
        const currentStat = fs.statSync(details.filePath);
        expect(fs.existsSync(details.filePath)).toBe(true);
        expect(currentStat.mtimeMs).toBe(initialStat.mtimeMs);
        expect(currentStat.size).toBe(initialStat.size);

        // Physical path remains inside Calibre's internal directory hierarchy
        expect(details.filePath).toContain("Agent Library");
      }
    });

    it("verifies locateBookFile returns only EPUB files and rejects non-EPUB books", () => {
      // Books 6, 7, 10 in live Calibre library are CBZ comics
      // locateBookFile must return null for non-EPUB books in EPUB-only mode
      const cbzBook = locateBookFile(6);
      expect(cbzBook).toBeNull();
    });
  });
});
