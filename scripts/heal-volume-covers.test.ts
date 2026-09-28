import { describe, expect, it, beforeEach, afterEach } from "bun:test";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { Database } from "bun:sqlite";
import { healVolumeCovers } from "./heal-volume-covers";

describe("scripts/heal-volume-covers.ts", () => {
  const tempDir = path.join(os.tmpdir(), `test_heal_covers_${Date.now()}`);
  const tempDb = path.join(tempDir, "metadata.db");
  const tempCache = path.join(tempDir, "cache", "covers");

  beforeEach(() => {
    fs.mkdirSync(tempDir, { recursive: true });
    fs.mkdirSync(tempCache, { recursive: true });

    const db = new Database(tempDb);
    db.run(`
      CREATE TABLE books (id INTEGER PRIMARY KEY, title TEXT, path TEXT, has_cover INTEGER, series_index REAL);
      CREATE TABLE series (id INTEGER PRIMARY KEY, name TEXT);
      CREATE TABLE books_series_link (id INTEGER PRIMARY KEY, book INTEGER, series INTEGER);
    `);

    // Insert 2 series books: Goblin Slayer Vol 1 and Vol 2
    db.run("INSERT INTO series (id, name) VALUES (1, 'Goblin Slayer');");

    db.run("INSERT INTO books (id, title, path, has_cover, series_index) VALUES (1432, 'Goblin Slayer, Vol. 1', 'Kumo/Vol 1 (1432)', 1, 1);");
    db.run("INSERT INTO books_series_link (id, book, series) VALUES (1, 1432, 1);");

    db.run("INSERT INTO books (id, title, path, has_cover, series_index) VALUES (1433, 'Goblin Slayer, Vol. 2', 'Kumo/Vol 2 (1433)', 1, 2);");
    db.run("INSERT INTO books_series_link (id, book, series) VALUES (2, 1433, 1);");

    db.close();

    // Create disk folders & covers
    const vol1Dir = path.join(tempDir, "Kumo", "Vol 1 (1432)");
    const vol2Dir = path.join(tempDir, "Kumo", "Vol 2 (1433)");
    fs.mkdirSync(vol1Dir, { recursive: true });
    fs.mkdirSync(vol2Dir, { recursive: true });

    fs.writeFileSync(path.join(vol1Dir, "cover.jpg"), "vol1-distinct-cover-data");
    fs.writeFileSync(path.join(vol2Dir, "cover.jpg"), "vol2-distinct-cover-data");
  });

  afterEach(() => {
    try {
      fs.rmSync(tempDir, { recursive: true, force: true });
    } catch (_cleanupErr) {
      void _cleanupErr;
    }
  });

  it("detects and purges duplicate thumbnails when disk covers are distinct", async () => {
    // Both 1432 and 1433 have the exact same cached thumbnail (simulating the bug)
    const thumb1 = path.join(tempCache, "1432_360.webp");
    const thumb2 = path.join(tempCache, "1433_360.webp");
    fs.writeFileSync(thumb1, "identical-vol1-thumbnail-bytes");
    fs.writeFileSync(thumb2, "identical-vol1-thumbnail-bytes");

    // Dry run
    const preview = await healVolumeCovers({
      libraryDir: tempDir,
      calibreDbPath: tempDb,
      cacheDir: tempCache,
      dryRun: true,
    });

    expect(preview.totalBooksScanned).toBe(2);
    expect(preview.seriesWithDuplicateThumbs).toBe(1);
    expect(preview.staleThumbnailCount).toBe(2);
    expect(preview.thumbnailsPurged).toBe(0); // dry run leaves files
    expect(fs.existsSync(thumb1)).toBe(true);
    expect(fs.existsSync(thumb2)).toBe(true);

    // Apply run
    const applied = await healVolumeCovers({
      libraryDir: tempDir,
      calibreDbPath: tempDb,
      cacheDir: tempCache,
      dryRun: false,
    });

    expect(applied.thumbnailsPurged).toBe(2);
    expect(fs.existsSync(thumb1)).toBe(false);
    expect(fs.existsSync(thumb2)).toBe(false);
  });

  it("detects and purges stale thumbnails when disk cover.jpg mtime is newer", async () => {
    const thumb1 = path.join(tempCache, "1432_360.webp");
    fs.writeFileSync(thumb1, "thumb-vol1-bytes");

    // Artificially back-date thumb1
    const pastTime = new Date(Date.now() - 60000);
    fs.utimesSync(thumb1, pastTime, pastTime);

    // Update cover.jpg to now
    const cover1 = path.join(tempDir, "Kumo", "Vol 1 (1432)", "cover.jpg");
    fs.utimesSync(cover1, new Date(), new Date());

    const summary = await healVolumeCovers({
      libraryDir: tempDir,
      calibreDbPath: tempDb,
      cacheDir: tempCache,
      dryRun: false,
    });

    expect(summary.thumbnailsPurged).toBeGreaterThanOrEqual(1);
    expect(fs.existsSync(thumb1)).toBe(false);
  });
});
