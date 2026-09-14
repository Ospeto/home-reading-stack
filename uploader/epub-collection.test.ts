import { describe, it, expect, beforeAll, afterAll } from "bun:test";
import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { Buffer } from "node:buffer";
import { Database } from "bun:sqlite";
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

  describe("Calibre Storage Path Preservation (Hermetic Test)", () => {
    const tempLibDir = path.join("/tmp", `test_calibre_lib_${Date.now()}`);
    const bookDir = path.join(tempLibDir, "Frank Herbert", "Dune (1)");
    const epubPath = path.join(bookDir, "Dune - Frank Herbert.epub");
    const cbzDir = path.join(tempLibDir, "Oda", "One Piece (2)");
    const cbzPath = path.join(cbzDir, "One Piece - Oda.cbz");

    let origDbPath: string | undefined;
    let origLibDir: string | undefined;

    beforeAll(() => {
      fs.mkdirSync(bookDir, { recursive: true });
      fs.mkdirSync(cbzDir, { recursive: true });
      fs.writeFileSync(epubPath, "mock epub book content");
      fs.writeFileSync(cbzPath, "mock cbz comic content");

      const tempDbPath = path.join(tempLibDir, "metadata.db");
      const db = new Database(tempDbPath);
      db.run(`
        CREATE TABLE books (id INTEGER PRIMARY KEY, title TEXT, path TEXT, series_index REAL);
        CREATE TABLE data (id INTEGER PRIMARY KEY, book INTEGER, format TEXT, name TEXT, uncompressed_size INTEGER);
        CREATE TABLE authors (id INTEGER PRIMARY KEY, name TEXT);
        CREATE TABLE books_authors_link (id INTEGER PRIMARY KEY, book INTEGER, author INTEGER);
        CREATE TABLE series (id INTEGER PRIMARY KEY, name TEXT);
        CREATE TABLE books_series_link (id INTEGER PRIMARY KEY, book INTEGER, series INTEGER);
      `);

      // Book 1: EPUB format with series
      db.run("INSERT INTO books (id, title, path, series_index) VALUES (1, 'Dune', 'Frank Herbert/Dune (1)', 1);");
      db.run("INSERT INTO data (id, book, format, name, uncompressed_size) VALUES (1, 1, 'EPUB', 'Dune - Frank Herbert', 100);");
      db.run("INSERT INTO authors (id, name) VALUES (1, 'Frank Herbert');");
      db.run("INSERT INTO books_authors_link (id, book, author) VALUES (1, 1, 1);");
      db.run("INSERT INTO series (id, name) VALUES (1, 'Dune Chronicles');");
      db.run("INSERT INTO books_series_link (id, book, series) VALUES (1, 1, 1);");

      // Book 2: CBZ format (non-EPUB)
      db.run("INSERT INTO books (id, title, path) VALUES (2, 'One Piece', 'Oda/One Piece (2)');");
      db.run("INSERT INTO data (id, book, format, name, uncompressed_size) VALUES (2, 2, 'CBZ', 'One Piece - Oda', 200);");
      db.run("INSERT INTO authors (id, name) VALUES (2, 'Oda');");
      db.run("INSERT INTO books_authors_link (id, book, author) VALUES (2, 2, 2);");

      db.close();

      origDbPath = process.env.CALIBRE_DB_PATH;
      origLibDir = process.env.CALIBRE_LIBRARY_DIR;
      process.env.CALIBRE_DB_PATH = tempDbPath;
      process.env.CALIBRE_LIBRARY_DIR = tempLibDir;
    });

    afterAll(() => {
      if (origDbPath === undefined) delete process.env.CALIBRE_DB_PATH; else process.env.CALIBRE_DB_PATH = origDbPath;

      if (origLibDir === undefined) delete process.env.CALIBRE_LIBRARY_DIR; else process.env.CALIBRE_LIBRARY_DIR = origLibDir;

      if (fs.existsSync(tempLibDir)) {
        fs.rmSync(tempLibDir, { recursive: true, force: true });
      }
    });

    it("never alters or renames physical Calibre library paths when locating files", () => {
      const details = locateBookFile(1);
      expect(details).not.toBeNull();
      expect(details!.chosenFormat).toBe("EPUB");
      expect(details!.series).toBe("Dune Chronicles");
      expect(details!.seriesIndex).toBe(1);
      expect(fs.existsSync(details!.filePath)).toBe(true);

      const initialStat = fs.statSync(details!.filePath);

      const userDownloadName = generateMetadataFilename({
        title: details!.title,
        authors: details!.authors,
        series: details!.series,
        seriesIndex: details!.seriesIndex,
        format: "epub"
      });

      expect(userDownloadName).toBe("Dune Chronicles 01 - Dune - Frank Herbert.epub");

      // CRITICAL INVARIANT: The physical file path on disk must NOT have changed
      const currentStat = fs.statSync(details!.filePath);
      expect(fs.existsSync(details!.filePath)).toBe(true);
      expect(currentStat.mtimeMs).toBe(initialStat.mtimeMs);
      expect(currentStat.size).toBe(initialStat.size);
      expect(details!.filePath).toBe(epubPath);
    });

    it("verifies locateBookFile returns only EPUB files and rejects non-EPUB books", () => {
      // Book 2 in temp library is CBZ format
      // locateBookFile must return null for non-EPUB books in EPUB-only mode
      const cbzBook = locateBookFile(2);
      expect(cbzBook).toBeNull();
    });
  });
});
