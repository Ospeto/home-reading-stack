import { describe, it, expect } from "bun:test";
import fs from "node:fs";
import path from "node:path";
import { Database } from "bun:sqlite";
import { cleanTitle, runMigrationPreflight } from "./migration-preflight";

describe("Migration Preflight & Inventory Engine", () => {
  describe("cleanTitle", () => {
    it("cleans and normalizes book titles for matching", () => {
      expect(cleanTitle("[Channel_EPUB] Dune (epub scan)")).toBe("dune");
      expect(cleanTitle("The Way of Kings - Brandon Sanderson")).toBe("the way of kings brandon sanderson");
      expect(cleanTitle("စာဖတ်သူ")).toBe("စာဖတ်သူ");
    });
  });

  describe("runMigrationPreflight with Mock Libraries", () => {
    const testDir = path.join("/tmp", `preflight_test_${Date.now()}`);
    const srcLibDir = path.join(testDir, "SourceLibrary");
    const tgtLibDir = path.join(testDir, "TargetLibrary");

    it("correctly identifies EPUBs, ignores non-EPUBs, and detects duplicates without mutating files", () => {
      fs.mkdirSync(srcLibDir, { recursive: true });
      fs.mkdirSync(tgtLibDir, { recursive: true });

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
      // Book 1: EPUB (existing in target)
      srcDb.run("INSERT INTO books (id, title, path) VALUES (1, 'Existing Classic', 'Author/Book1');");
      srcDb.run("INSERT INTO data (id, book, format, name) VALUES (1, 1, 'EPUB', 'Book1');");
      srcDb.run("INSERT INTO authors (id, name) VALUES (1, 'Famous Author');");
      srcDb.run("INSERT INTO books_authors_link (id, book, author) VALUES (1, 1, 1);");

      // Book 2: EPUB (unique, ready to migrate)
      srcDb.run("INSERT INTO books (id, title, path) VALUES (2, 'New SciFi Masterpiece', 'SciFi/Book2');");
      srcDb.run("INSERT INTO data (id, book, format, name) VALUES (2, 2, 'EPUB', 'Book2');");
      srcDb.run("INSERT INTO authors (id, name) VALUES (2, 'SciFi Author');");
      srcDb.run("INSERT INTO books_authors_link (id, book, author) VALUES (2, 2, 2);");

      // Book 3: Non-EPUB (KFX comic - must be excluded)
      srcDb.run("INSERT INTO books (id, title, path) VALUES (3, 'Comic Issue 1', 'Comics/Book3');");
      srcDb.run("INSERT INTO data (id, book, format, name) VALUES (3, 3, 'KFX', 'Book3');");

      srcDb.close();

      // Setup Target Database
      const tgtDb = new Database(tgtDbPath);
      tgtDb.run(`
        CREATE TABLE books (id INTEGER PRIMARY KEY, title TEXT, path TEXT);
        CREATE TABLE data (id INTEGER PRIMARY KEY, book INTEGER, format TEXT, name TEXT);
        CREATE TABLE authors (id INTEGER PRIMARY KEY, name TEXT);
        CREATE TABLE books_authors_link (id INTEGER PRIMARY KEY, book INTEGER, author INTEGER);
      `);

      // Target already has Book 1
      tgtDb.run("INSERT INTO books (id, title, path) VALUES (10, 'Existing Classic', 'Author/Book10');");
      tgtDb.run("INSERT INTO data (id, book, format, name) VALUES (10, 10, 'EPUB', 'Book10');");
      tgtDb.run("INSERT INTO authors (id, name) VALUES (10, 'Famous Author');");
      tgtDb.run("INSERT INTO books_authors_link (id, book, author) VALUES (10, 10, 10);");

      tgtDb.close();

      // Record file stats to verify READ-ONLY guarantee
      const srcStatBefore = fs.statSync(srcDbPath);
      const tgtStatBefore = fs.statSync(tgtDbPath);

      // Run preflight
      const inventory = runMigrationPreflight({
        sourceLibraryPath: srcLibDir,
        targetLibraryPath: tgtLibDir
      });

      // Verify inventory counts
      expect(inventory.sourceTotalBooks).toBe(3);
      expect(inventory.sourceTotalEpubs).toBe(2);
      expect(inventory.sourceNonEpubsExcluded.length).toBe(1);
      expect(inventory.sourceNonEpubsExcluded[0].format).toBe("KFX");

      expect(inventory.targetTotalEpubs).toBe(1);
      expect(inventory.exactDuplicates.length).toBe(1);
      expect(inventory.exactDuplicates[0].title).toBe("Existing Classic");

      expect(inventory.newEpubCandidates.length).toBe(1);
      expect(inventory.newEpubCandidates[0].title).toBe("New SciFi Masterpiece");

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
