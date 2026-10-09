import { describe, it, expect } from "bun:test";
import {
  formatSeriesIndex,
  sanitizeSegment,
  truncateUtf8Bytes,
  generateMetadataFilename,
  buildContentDisposition
} from "./filename";

describe("Sanitized Metadata-Derived Filename Generation", () => {
  describe("formatSeriesIndex", () => {
    it("formats single-digit integer series with leading zero", () => {
      expect(formatSeriesIndex(1)).toBe("01");
      expect(formatSeriesIndex(9)).toBe("09");
      expect(formatSeriesIndex("3")).toBe("03");
    });

    it("formats double-digit and larger integers without extra padding", () => {
      expect(formatSeriesIndex(10)).toBe("10");
      expect(formatSeriesIndex(49)).toBe("49");
      expect(formatSeriesIndex("100")).toBe("100");
    });

    it("formats decimal volume numbers cleanly", () => {
      expect(formatSeriesIndex(1.5)).toBe("01.5");
      expect(formatSeriesIndex(0.5)).toBe("00.5");
      expect(formatSeriesIndex("12.5")).toBe("12.5");
    });

    it("returns empty string for null, undefined, or empty values", () => {
      expect(formatSeriesIndex(null)).toBe("");
      expect(formatSeriesIndex(undefined)).toBe("");
      expect(formatSeriesIndex("")).toBe("");
    });
  });

  describe("sanitizeSegment", () => {
    it("removes illegal filesystem characters and path traversal", () => {
      expect(sanitizeSegment("../../../etc/passwd")).toBe("etc passwd");
      expect(sanitizeSegment('Foo: "Bar" <Baz> *Qux*? /Slash\\ |Pipe|')).toBe("Foo Bar Baz Qux Slash Pipe");
    });

    it("strips spam tags, URLs, and telegram channel markers", () => {
      expect(sanitizeSegment("[Channel_EPUB] Clean Title @bookchannel")).toBe("Clean Title");
      expect(sanitizeSegment("Great Book https://t.me/freereads (ebook scan)")).toBe("Great Book");
    });

    it("preserves legitimate Burmese, Japanese, and accented Unicode characters", () => {
      expect(sanitizeSegment("စာဖတ်သူ")).toBe("စာဖတ်သူ");
      expect(sanitizeSegment("レーエンの風")).toBe("レーエンの風");
      expect(sanitizeSegment("Les Misérables")).toBe("Les Misérables");
    });

    it("strips ASCII and C0/DEL control characters", () => {
      expect(sanitizeSegment("Clean\x00Title\x07With\x1FControl\x7FChars")).toBe("Clean Title With Control Chars");
    });
  });

  describe("truncateUtf8Bytes", () => {
    it("preserves strings shorter than maxBytes", () => {
      expect(truncateUtf8Bytes("Short title", 50)).toBe("Short title");
    });

    it("truncates long strings cleanly without splitting multi-byte UTF-8 code points", () => {
      // Each Burmese character is 3 bytes
      const burmeseStr = "စာဖတ်သူစာဖတ်သူစာဖတ်သူ";
      const truncated = truncateUtf8Bytes(burmeseStr, 15);
      expect(Buffer.byteLength(truncated, "utf8")).toBeLessThanOrEqual(15);
      // Valid UTF-8 check
      expect(new TextDecoder("utf-8", { fatal: true }).decode(Buffer.from(truncated))).toBe(truncated);
    });

    it("never splits 4-byte surrogate pairs / astral plane characters at truncation boundary", () => {
      // 𠮷 (U+20BB7) is 4 bytes in UTF-8 and 2 code units in UTF-16
      const astralStr = "𠮷".repeat(10); // 40 bytes
      const truncated = truncateUtf8Bytes(astralStr, 15);
      // 3 characters = 12 bytes; 4 characters = 16 bytes (> 15). Must truncate to 12 bytes.
      expect(Buffer.byteLength(truncated, "utf8")).toBe(12);
      expect(truncated).toBe("𠮷𠮷𠮷");
      expect(new TextDecoder("utf-8", { fatal: true }).decode(Buffer.from(truncated))).toBe("𠮷𠮷𠮷");
    });
  });

  describe("generateMetadataFilename", () => {
    it("generates 'Title - Author.epub' for standard standalone books", () => {
      const filename = generateMetadataFilename({
        title: "Dune",
        authors: "Frank Herbert"
      });
      expect(filename).toBe("Dune - Frank Herbert.epub");
    });

    it("generates 'Series 01 - Title - Author.epub' when series is present", () => {
      const filename = generateMetadataFilename({
        title: "Dune",
        authors: "Frank Herbert",
        series: "Dune Chronicles",
        seriesIndex: 1
      });
      expect(filename).toBe("Dune Chronicles 01 - Dune - Frank Herbert.epub");
    });

    it("supports series_index property interoperably with Calibre database records", () => {
      const filename = generateMetadataFilename({
        title: "Dune",
        authors: "Frank Herbert",
        series: "Dune Chronicles",
        series_index: 2
      });
      expect(filename).toBe("Dune Chronicles 02 - Dune - Frank Herbert.epub");
    });

    it("handles fractional series indices with leading zero padding", () => {
      const filename = generateMetadataFilename({
        title: "Side Story",
        authors: "Author",
        series: "Main Series",
        seriesIndex: 1.5
      });
      expect(filename).toBe("Main Series 01.5 - Side Story - Author.epub");
    });

    it("handles series with missing series index (un-indexed series)", () => {
      const filename = generateMetadataFilename({
        title: "Standalone in Universe",
        authors: "Author",
        series: "Cosmere",
        seriesIndex: null
      });
      expect(filename).toBe("Cosmere - Standalone in Universe - Author.epub");
    });

    it("generates clean filenames for Burmese and Japanese literature with series", () => {
      const burmese = generateMetadataFilename({
        title: "စာဖတ်သူ",
        authors: "ဆရာတင်",
        series: "အတွဲ",
        series_index: 1
      });
      expect(burmese).toBe("အတွဲ 01 - စာဖတ်သူ - ဆရာတင်.epub");

      const japanese = generateMetadataFilename({
        title: "不死者の王",
        authors: "丸山くがね",
        series: "オーバーロード",
        seriesIndex: 1
      });
      expect(japanese).toBe("オーバーロード 01 - 不死者の王 - 丸山くがね.epub");
    });

    it("handles multiple authors array cleanly", () => {
      const filename = generateMetadataFilename({
        title: "Good Omens",
        authors: ["Neil Gaiman", "Terry Pratchett"]
      });
      expect(filename).toBe("Good Omens - Neil Gaiman, Terry Pratchett.epub");
    });

    it("omits author when author is missing or 'Unknown'", () => {
      const filename1 = generateMetadataFilename({
        title: "Ancient Wisdom",
        authors: "Unknown"
      });
      expect(filename1).toBe("Ancient Wisdom.epub");

      const filename2 = generateMetadataFilename({
        title: "Ancient Wisdom",
        authors: null
      });
      expect(filename2).toBe("Ancient Wisdom.epub");
    });

    it("falls back to fallbackBase when title is missing", () => {
      const filename = generateMetadataFilename({
        title: "",
        authors: "Some Author",
        fallbackBase: "original_scanned_book"
      });
      expect(filename).toBe("original scanned book - Some Author.epub");
    });

    it("safely handles Windows reserved names like CON, NUL, PRN", () => {
      const filename = generateMetadataFilename({
        title: "CON",
        authors: null
      });
      expect(filename).toBe("Book_CON.epub");
    });

    it("strips path traversal attacks in metadata", () => {
      const filename = generateMetadataFilename({
        title: "../../etc/passwd",
        authors: "../../../root"
      });
      expect(filename).toBe("etc passwd - root.epub");
      expect(filename).not.toContain("/");
      expect(filename).not.toContain("..");
    });

    it("respects maxBytes budget for exceptionally long titles", () => {
      const longTitle = "A".repeat(300);
      const filename = generateMetadataFilename({
        title: longTitle,
        authors: "Author"
      }, { maxBytes: 80 });
      expect(Buffer.byteLength(filename, "utf8")).toBeLessThanOrEqual(85); // 80 base + .epub
      expect(filename.endsWith(".epub")).toBe(true);
    });

    it("preserves custom extension if specified", () => {
      const filename = generateMetadataFilename({
        title: "Test Notes",
        authors: "Author",
        format: "md"
      });
      expect(filename).toBe("Test Notes - Author.md");
    });
  });

  describe("buildContentDisposition", () => {
    it("generates standard ASCII fallback and UTF-8 encoded filename", () => {
      const header = buildContentDisposition("စာဖတ်သူ - သူရိယဝင်.epub");
      expect(header).toContain('attachment; filename="_______ - ________.epub"');
      expect(header).toContain("filename*=UTF-8''%E1%80%85%E1%80%AC");
    });

    it("escapes quotes in ASCII fallback safely", () => {
      const header = buildContentDisposition('Book "Special" Edition.epub');
      expect(header).not.toContain('filename="Book "Special"');
      expect(header).toContain("filename*=UTF-8''Book%20%22Special%22%20Edition.epub");
    });

    it("allows modern clients to roundtrip-decode UTF-8 filename exactly", () => {
      const original = "オーバーロード 01 - 不死者の王 - 丸山くがね.epub";
      const header = buildContentDisposition(original);
      const prefix = "filename*=UTF-8''";
      const idx = header.indexOf(prefix);
      expect(idx).toBeGreaterThan(-1);
      const encoded = header.slice(idx + prefix.length);
      expect(decodeURIComponent(encoded)).toBe(original);
    });
  });
});
