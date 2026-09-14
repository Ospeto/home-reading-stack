import { describe, it, expect } from "bun:test";
import fs from "node:fs";
import path from "node:path";
import { Database } from "bun:sqlite";
import {
  cleanTitle,
  normalizeTitleAndAuthor,
  runMigrationPreflight,
} from "./migration-preflight";

describe("Migration Preflight & Inventory Engine", () => {
  describe("cleanTitle & normalizeTitleAndAuthor", () => {
    it("cleans and normalizes book titles for matching", () => {
      expect(cleanTitle("[Channel_EPUB] Dune (epub scan)")).toBe("dune");
      expect(cleanTitle("The Way of Kings - Brandon Sanderson")).toBe(
        "the way of kings brandon sanderson",
      );
      expect(cleanTitle("စာဖတ်သူ")).toBe("စာဖတ်သူ");
    });

    it("normalizes title and author together as a compound key", () => {
      expect(normalizeTitleAndAuthor("Dune", "Frank Herbert")).toBe(
        "dune:::frank herbert",
      );
      expect(normalizeTitleAndAuthor("1984", "Unknown")).toBe("1984:::unknown");
    });
  });

  describe("runMigrationPreflight with Mock Libraries", () => {
    const testDir = path.join("/tmp", `preflight_test_${Date.now()}`);
    const srcLibDir = path.join(testDir, "SourceLibrary");
    const tgtLibDir = path.join(testDir, "TargetLibrary");

    it("correctly identifies EPUBs, ignores non-EPUBs, and detects duplicates matching title PLUS author", () => {
      fs.mkdirSync(srcLibDir, { recursive: true });
      fs.mkdirSync(tgtLibDir, { recursive: true });

      // Create physical mock files for source books
      fs.mkdirSync(path.join(srcLibDir, "Frost"), { recursive: true });
      fs.writeFileSync(path.join(srcLibDir, "Frost", "Book1.epub"), "content");
      fs.mkdirSync(path.join(srcLibDir, "Dickinson"), { recursive: true });
      fs.writeFileSync(path.join(srcLibDir, "Dickinson", "Book2.epub"), "content");

      const srcDbPath = path.join(srcLibDir, "metadata.db");
      const tgtDbPath = path.join(tgtLibDir, "metadata.db");

      // Setup Source Database
      const srcDb = new Database(srcDbPath);
      srcDb.run(`
        CREATE TABLE books (id INTEGER PRIMARY KEY, title TEXT, path TEXT, series_index REAL);
        CREATE TABLE data (id INTEGER PRIMARY KEY, book INTEGER, format TEXT, name TEXT);
        CREATE TABLE authors (id INTEGER PRIMARY KEY, name TEXT);
        CREATE TABLE books_authors_link (id INTEGER PRIMARY KEY, book INTEGER, author INTEGER);
        CREATE TABLE series (id INTEGER PRIMARY KEY, name TEXT);
        CREATE TABLE books_series_link (id INTEGER PRIMARY KEY, book INTEGER, series INTEGER);
      `);

      // Add Books to Source
      // Book 1: EPUB (existing in target: matching title AND author)
      srcDb.run(
        "INSERT INTO books (id, title, path) VALUES (1, 'Selected Works', 'Frost');",
      );
      srcDb.run(
        "INSERT INTO data (id, book, format, name) VALUES (1, 1, 'EPUB', 'Book1');",
      );
      srcDb.run("INSERT INTO authors (id, name) VALUES (1, 'Robert Frost');");
      srcDb.run(
        "INSERT INTO books_authors_link (id, book, author) VALUES (1, 1, 1);",
      );

      // Book 2: EPUB (same title 'Selected Works', but DIFFERENT author 'Emily Dickinson' - NOT a duplicate!)
      srcDb.run(
        "INSERT INTO books (id, title, path) VALUES (2, 'Selected Works', 'Dickinson');",
      );
      srcDb.run(
        "INSERT INTO data (id, book, format, name) VALUES (2, 2, 'EPUB', 'Book2');",
      );
      srcDb.run(
        "INSERT INTO authors (id, name) VALUES (2, 'Emily Dickinson');",
      );
      srcDb.run(
        "INSERT INTO books_authors_link (id, book, author) VALUES (2, 2, 2);",
      );

      // Book 3: Non-EPUB (KFX format - must be excluded)
      srcDb.run(
        "INSERT INTO books (id, title, path) VALUES (3, 'Comic Issue 1', 'Comics');",
      );
      srcDb.run(
        "INSERT INTO data (id, book, format, name) VALUES (3, 3, 'KFX', 'Book3');",
      );

      // Book 4: Missing on disk (ghost database entry)
      srcDb.run(
        "INSERT INTO books (id, title, path) VALUES (4, 'Ghost Book', 'Ghost');",
      );
      srcDb.run(
        "INSERT INTO data (id, book, format, name) VALUES (4, 4, 'EPUB', 'Missing');",
      );
      srcDb.run("INSERT INTO authors (id, name) VALUES (4, 'Ghost Author');");
      srcDb.run(
        "INSERT INTO books_authors_link (id, book, author) VALUES (4, 4, 4);",
      );

      srcDb.close();

      // Setup Target Database
      const tgtDb = new Database(tgtDbPath);
      tgtDb.run(`
        CREATE TABLE books (id INTEGER PRIMARY KEY, title TEXT, path TEXT);
        CREATE TABLE data (id INTEGER PRIMARY KEY, book INTEGER, format TEXT, name TEXT);
        CREATE TABLE authors (id INTEGER PRIMARY KEY, name TEXT);
        CREATE TABLE books_authors_link (id INTEGER PRIMARY KEY, book INTEGER, author INTEGER);
      `);

      // Target has 'Selected Works' by 'Robert Frost'
      tgtDb.run(
        "INSERT INTO books (id, title, path) VALUES (10, 'Selected Works', 'Frost');",
      );
      tgtDb.run(
        "INSERT INTO data (id, book, format, name) VALUES (10, 10, 'EPUB', 'Book10');",
      );
      tgtDb.run("INSERT INTO authors (id, name) VALUES (10, 'Robert Frost');");
      tgtDb.run(
        "INSERT INTO books_authors_link (id, book, author) VALUES (10, 10, 10);",
      );

      tgtDb.close();

      // Record file stats to verify READ-ONLY guarantee
      const srcStatBefore = fs.statSync(srcDbPath);
      const tgtStatBefore = fs.statSync(tgtDbPath);

      // Run preflight
      const inventory = runMigrationPreflight({
        sourceLibraryPath: srcLibDir,
        targetLibraryPath: tgtLibDir,
      });

      // Verify inventory counts
      expect(inventory.sourceTotalBooks).toBe(4);
      expect(inventory.sourceTotalEpubs).toBe(3);
      expect(inventory.sourceNonEpubsExcluded.length).toBe(1);
      expect(inventory.sourceNonEpubsExcluded[0].format).toBe("KFX");

      expect(inventory.targetTotalEpubs).toBe(1);

      // Duplicate match: Robert Frost matches Robert Frost
      expect(inventory.exactDuplicates.length).toBe(1);
      expect(inventory.exactDuplicates[0].authors).toBe("Robert Frost");

      // Unique candidate: Emily Dickinson book is NOT marked as duplicate despite same title!
      expect(inventory.newEpubCandidates.length).toBe(1);
      expect(inventory.newEpubCandidates[0].authors).toBe("Emily Dickinson");

      // Missing on disk check: Ghost book detected and skipped from candidates
      expect(inventory.missingFilesOnDisk.length).toBe(1);
      expect(inventory.missingFilesOnDisk[0].title).toBe("Ghost Book");

      // Verify ZERO MUTATION on files
      const srcStatAfter = fs.statSync(srcDbPath);
      const tgtStatAfter = fs.statSync(tgtDbPath);
      expect(srcStatAfter.size).toBe(srcStatBefore.size);
      expect(tgtStatAfter.size).toBe(tgtStatBefore.size);
      expect(srcStatAfter.mtimeMs).toBe(srcStatBefore.mtimeMs);
      expect(tgtStatAfter.mtimeMs).toBe(tgtStatBefore.mtimeMs);

      // Cleanup test dir
      if (fs.existsSync(testDir)) {
        fs.rmSync(testDir, { recursive: true, force: true });
      }
    });
  });
});
