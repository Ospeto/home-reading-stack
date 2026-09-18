import { describe, it, expect } from "bun:test";
import fs from "node:fs";
import path from "node:path";
import { Database } from "bun:sqlite";
import {
  stripBookIdFromPath,
  cleanExtractedSeriesName,
  parseBurmeseNumber,
  extractSeriesFromTitle,
  syncSeriesMetadata,
} from "./sync-series-metadata";

describe("Series Metadata Synchronization Engine", () => {
  describe("stripBookIdFromPath & cleanExtractedSeriesName", () => {
    it("strips Calibre book ID parenthetical from folder paths", () => {
      expect(
        stripBookIdFromPath("Kota Nozomi/You Like Me, Not My Daughter_! Volume 5 (798)"),
      ).toBe("Kota Nozomi/You Like Me, Not My Daughter_! Volume 5");
      expect(
        stripBookIdFromPath("mng[_]_sing[_]kh/chaa_pulng[_] (1840)"),
      ).toBe("mng[_]_sing[_]kh/chaa_pulng[_]");
      expect(stripBookIdFromPath("Author/Book Without Id")).toBe("Author/Book Without Id");
      expect(stripBookIdFromPath("")).toBe("");
    });

    it("cleans and trims extracted series names", () => {
      expect(cleanExtractedSeriesName("Overlord,")).toBe("Overlord");
      expect(cleanExtractedSeriesName("  A Late-Start Tamer’s Laid-Back Life:  ")).toBe(
        "A Late-Start Tamer’s Laid-Back Life",
      );
      expect(cleanExtractedSeriesName("CubexCursedxCurious - ")).toBe("CubexCursedxCurious");
      expect(cleanExtractedSeriesName("")).toBe("");
    });

    it("parses Burmese numerals and standard digits accurately", () => {
      expect(parseBurmeseNumber("၁")).toBe(1);
      expect(parseBurmeseNumber("၂")).toBe(2);
      expect(parseBurmeseNumber("၁၂")).toBe(12);
      expect(parseBurmeseNumber("5")).toBe(5);
      expect(parseBurmeseNumber("25.5")).toBe(25.5);
      expect(parseBurmeseNumber("")).toBe(1);
    });
  });

  describe("extractSeriesFromTitle regex heuristics", () => {
    it("extracts series and volume from standard Vol/Volume patterns", () => {
      const ex1 = extractSeriesFromTitle("Overlord, Vol. 14: The Witch of the Doomed Kingdom");
      expect(ex1).not.toBeNull();
      expect(ex1?.series).toBe("Overlord");
      expect(ex1?.volume).toBe(14);
      expect(ex1?.pattern).toBe("volume");

      const ex2 = extractSeriesFromTitle(
        "CubexCursedxCurious - Volume 17 - Closing Episode, Last Part",
      );
      expect(ex2?.series).toBe("CubexCursedxCurious");
      expect(ex2?.volume).toBe(17);

      const ex3 = extractSeriesFromTitle("CubexCursedxCurious - Volume 01");
      expect(ex3?.series).toBe("CubexCursedxCurious");
      expect(ex3?.volume).toBe(1);

      const ex4 = extractSeriesFromTitle(
        "Peddler in Another World: I Can Go Back to My World Whenever I Want! Volume 7",
      );
      expect(ex4?.series).toBe(
        "Peddler in Another World: I Can Go Back to My World Whenever I Want!",
      );
      expect(ex4?.volume).toBe(7);

      const ex5 = extractSeriesFromTitle("Classroom of the Elite: Year 2 Vol. 4.5");
      expect(ex5?.series).toBe("Classroom of the Elite: Year 2");
      expect(ex5?.volume).toBe(4.5);

      const ex6 = extractSeriesFromTitle("Free Life Fantasy Online: Immortal Princess Vol. 1");
      expect(ex6?.series).toBe("Free Life Fantasy Online: Immortal Princess");
      expect(ex6?.volume).toBe(1);

      const ex7 = extractSeriesFromTitle("A Late-Start Tamer’s Laid-Back Life: Volume 12");
      expect(ex7?.series).toBe("A Late-Start Tamer’s Laid-Back Life");
      expect(ex7?.volume).toBe(12);
    });

    it("extracts series and volume from #N patterns", () => {
      const ex1 = extractSeriesFromTitle("My Hero Academia #05");
      expect(ex1?.series).toBe("My Hero Academia");
      expect(ex1?.volume).toBe(5);
      expect(ex1?.pattern).toBe("hash");

      const ex2 = extractSeriesFromTitle("The Wandering Inn #2: Subtitle Here");
      expect(ex2?.series).toBe("The Wandering Inn");
      expect(ex2?.volume).toBe(2);
    });

    it("extracts series and volume from Book N patterns", () => {
      const ex1 = extractSeriesFromTitle("The Beginning After the End: Book 10: Retribution");
      expect(ex1?.series).toBe("The Beginning After the End");
      expect(ex1?.volume).toBe(10);
      expect(ex1?.pattern).toBe("book");

      const ex2 = extractSeriesFromTitle("The Beginning After The End: Providence, Book 11");
      expect(ex2?.series).toBe("The Beginning After The End: Providence");
      expect(ex2?.volume).toBe(11);
    });

    it("extracts series and volume from Burmese volume patterns", () => {
      const ex1 = extractSeriesFromTitle("စစ်နှင့်ငြိမ်းချမ်းရေး (အတွဲ ၂)");
      expect(ex1?.series).toBe("စစ်နှင့်ငြိမ်းချမ်းရေး");
      expect(ex1?.volume).toBe(2);
      expect(ex1?.pattern).toBe("burmese_volume");

      const ex2 = extractSeriesFromTitle("မှော်ဝင်္ကပါ အတွဲ ၄");
      expect(ex2?.series).toBe("မှော်ဝင်္ကပါ");
      expect(ex2?.volume).toBe(4);
    });

    it("returns null for standalone non-series titles and noise", () => {
      expect(extractSeriesFromTitle("Dune")).toBeNull();
      expect(extractSeriesFromTitle("1984")).toBeNull();
      expect(extractSeriesFromTitle("Clean Code: A Handbook of Agile Software Craftsmanship")).toBeNull();
      expect(extractSeriesFromTitle("Finished book")).toBeNull();
      expect(
        extractSeriesFromTitle(
          "Twilight Over Burma: My Life as a Shan Princess (Kolowalu Books (Paperback))",
        ),
      ).toBeNull();
      expect(extractSeriesFromTitle("")).toBeNull();
    });
  });

  describe("syncSeriesMetadata with mock SQLite libraries", () => {
    const testDir = path.join("/tmp", `sync_series_test_${Date.now()}`);
    const srcLibDir = path.join(testDir, "SourceLibrary");
    const tgtLibDir = path.join(testDir, "TargetLibrary");

    it("maps Part A source series, extracts Part B title heuristics, and skips already registered series", async () => {
      fs.mkdirSync(srcLibDir, { recursive: true });
      fs.mkdirSync(tgtLibDir, { recursive: true });

      const srcDbPath = path.join(srcLibDir, "metadata.db");
      const tgtDbPath = path.join(tgtLibDir, "metadata.db");

      // Setup Source Calibre DB
      const srcDb = new Database(srcDbPath);
      srcDb.run(`
        CREATE TABLE books (id INTEGER PRIMARY KEY, title TEXT, path TEXT, series_index REAL);
        CREATE TABLE data (id INTEGER PRIMARY KEY, book INTEGER, format TEXT, name TEXT, uncompressed_size INTEGER);
        CREATE TABLE series (id INTEGER PRIMARY KEY, name TEXT);
        CREATE TABLE books_series_link (id INTEGER PRIMARY KEY, book INTEGER, series INTEGER);
      `);

      // Add Series in Source
      srcDb.run("INSERT INTO series (id, name) VALUES (1, 'Re:ZERO -Starting Life in Another World-');");
      srcDb.run("INSERT INTO series (id, name) VALUES (2, 'Mushoku Tensei: Jobless Reincarnation');");

      // Book 1 in Source: Re:ZERO Vol 1
      srcDb.run(
        "INSERT INTO books (id, title, path, series_index) VALUES (101, 'Re:ZERO Vol. 01', 'Tappei/Re_ZERO (101)', 1.0);",
      );
      srcDb.run(
        "INSERT INTO data (id, book, format, name, uncompressed_size) VALUES (1, 101, 'EPUB', 'book1', 123456);",
      );
      srcDb.run("INSERT INTO books_series_link (id, book, series) VALUES (1, 101, 1);");

      // Book 2 in Source: Mushoku Tensei Vol 25
      srcDb.run(
        "INSERT INTO books (id, title, path, series_index) VALUES (102, 'Mushoku Tensei Vol. 25', 'Rifujin/Mushoku Tensei (102)', 25.0);",
      );
      srcDb.run(
        "INSERT INTO data (id, book, format, name, uncompressed_size) VALUES (2, 102, 'EPUB', 'book2', 654321);",
      );
      srcDb.run("INSERT INTO books_series_link (id, book, series) VALUES (2, 102, 2);");
      srcDb.close();

      // Setup Target Calibre DB
      const tgtDb = new Database(tgtDbPath);
      tgtDb.run(`
        CREATE TABLE books (id INTEGER PRIMARY KEY, title TEXT, path TEXT, series_index REAL);
        CREATE TABLE data (id INTEGER PRIMARY KEY, book INTEGER, format TEXT, name TEXT, uncompressed_size INTEGER);
        CREATE TABLE series (id INTEGER PRIMARY KEY, name TEXT);
        CREATE TABLE books_series_link (id INTEGER PRIMARY KEY, book INTEGER, series INTEGER);
      `);

      // Target Book 1: Matches Source Book 1 by relative path & size (Needs Part A sync)
      tgtDb.run(
        "INSERT INTO books (id, title, path, series_index) VALUES (1, 'Re:ZERO Vol. 01', 'Tappei/Re_ZERO (1)', 1.0);",
      );
      tgtDb.run(
        "INSERT INTO data (id, book, format, name, uncompressed_size) VALUES (10, 1, 'EPUB', 'book1', 123456);",
      );

      // Target Book 2: Already registered series (Overlord #1) -> Should be skipped
      tgtDb.run("INSERT INTO series (id, name) VALUES (1, 'Overlord');");
      tgtDb.run(
        "INSERT INTO books (id, title, path, series_index) VALUES (2, 'Overlord, Vol. 1: The Undead King', 'Maruyama/Overlord (2)', 1.0);",
      );
      tgtDb.run(
        "INSERT INTO data (id, book, format, name, uncompressed_size) VALUES (20, 2, 'EPUB', 'overlord1', 999999);",
      );
      tgtDb.run("INSERT INTO books_series_link (id, book, series) VALUES (1, 2, 1);");

      // Target Book 3: Not in source DB, has title heuristic -> Needs Part B extraction
      tgtDb.run(
        "INSERT INTO books (id, title, path, series_index) VALUES (3, 'CubexCursedxCurious - Volume 17 - Closing Episode, Last Part', 'Mizase/CubexCursedxCurious (3)', 1.0);",
      );
      tgtDb.run(
        "INSERT INTO data (id, book, format, name, uncompressed_size) VALUES (30, 3, 'EPUB', 'cube17', 777777);",
      );

      // Target Book 4: Standalone book, no series pattern -> Untouched
      tgtDb.run(
        "INSERT INTO books (id, title, path, series_index) VALUES (4, 'Dune', 'Herbert/Dune (4)', 1.0);",
      );
      tgtDb.run(
        "INSERT INTO data (id, book, format, name, uncompressed_size) VALUES (40, 4, 'EPUB', 'dune', 888888);",
      );
      tgtDb.close();

      // Track metadata setter calls
      const setterCalls: Array<{ bookId: number; series: string; seriesIndex: number }> = [];
      let cacheFlushed = false;

      const mockSetter = (bookId: number, series: string, seriesIndex: number) => {
        setterCalls.push({ bookId, series, seriesIndex });
        return { success: true };
      };

      const mockFlusher = () => {
        cacheFlushed = true;
      };

      // Run dry-run first
      const dryResult = await syncSeriesMetadata({
        sourceLibraryPath: srcLibDir,
        targetLibraryPath: tgtLibDir,
        dryRun: true,
        metadataSetter: mockSetter,
        cacheFlusher: mockFlusher,
      });

      expect(dryResult.dryRun).toBe(true);
      expect(dryResult.partAMatches.length).toBe(1);
      expect(dryResult.partAMatches[0].targetBookId).toBe(1);
      expect(dryResult.partAMatches[0].series).toBe("Re:ZERO -Starting Life in Another World-");
      expect(dryResult.partAMatches[0].seriesIndex).toBe(1.0);

      expect(dryResult.partBMatches.length).toBe(1);
      expect(dryResult.partBMatches[0].targetBookId).toBe(3);
      expect(dryResult.partBMatches[0].series).toBe("CubexCursedxCurious");
      expect(dryResult.partBMatches[0].seriesIndex).toBe(17);

      expect(dryResult.skippedAlreadyHasSeries).toBe(1);
      expect(dryResult.totalUpdated).toBe(0); // Dry-run performs zero writes
      expect(setterCalls.length).toBe(0);
      expect(cacheFlushed).toBe(false);

      // Run live update
      const liveResult = await syncSeriesMetadata({
        sourceLibraryPath: srcLibDir,
        targetLibraryPath: tgtLibDir,
        dryRun: false,
        metadataSetter: mockSetter,
        cacheFlusher: mockFlusher,
      });

      expect(liveResult.dryRun).toBe(false);
      expect(liveResult.totalUpdated).toBe(2);
      expect(setterCalls.length).toBe(2);
      expect(cacheFlushed).toBe(true);

      // Verify Part A call
      const partACall = setterCalls.find((c) => c.bookId === 1);
      expect(partACall?.series).toBe("Re:ZERO -Starting Life in Another World-");
      expect(partACall?.seriesIndex).toBe(1.0);

      // Verify Part B call
      const partBCall = setterCalls.find((c) => c.bookId === 3);
      expect(partBCall?.series).toBe("CubexCursedxCurious");
      expect(partBCall?.seriesIndex).toBe(17);

      // Clean up test directory
      fs.rmSync(testDir, { recursive: true, force: true });
    });
  });
});
