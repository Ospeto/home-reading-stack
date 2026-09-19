import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Database } from "bun:sqlite";
import {
  scoreBookKeeper,
  pickRecommendedKeeper,
  findDuplicateGroups,
  runCleanDuplicates,
  parseArgs,
  type CalibreBookRecord,
  type CleanDuplicatesOptions,
} from "./clean-duplicates";

describe("Calibre Library-Wide Duplicate Cleaner Tool", () => {
  describe("scoreBookKeeper & pickRecommendedKeeper", () => {
    it("favors books with EPUB format, cover, series, and larger file size", () => {
      const b1: CalibreBookRecord = {
        id: 10,
        title: "Test Book",
        authors: "Author A",
        series: null,
        seriesIndex: null,
        path: "Author A/Test Book (10)",
        formats: ["PDF"],
        hasCover: false,
        fileSize: 50000,
      };

      const b2: CalibreBookRecord = {
        id: 20,
        title: "Test Book",
        authors: "Author A",
        series: "Test Series",
        seriesIndex: 1,
        path: "Author A/Test Book (20)",
        formats: ["EPUB"],
        hasCover: true,
        fileSize: 250000,
      };

      expect(scoreBookKeeper(b2)).toBeGreaterThan(scoreBookKeeper(b1));

      const { keeper, duplicates } = pickRecommendedKeeper([b1, b2]);
      expect(keeper.id).toBe(20);
      expect(duplicates.length).toBe(1);
      expect(duplicates[0].id).toBe(10);
    });

    it("favors earlier book ID as tiebreaker when metadata is identical", () => {
      const b1: CalibreBookRecord = {
        id: 5,
        title: "Same Book",
        authors: "Same Author",
        series: null,
        seriesIndex: null,
        path: "Same Author/Same Book (5)",
        formats: ["EPUB"],
        hasCover: true,
      };

      const b2: CalibreBookRecord = {
        id: 15,
        title: "Same Book",
        authors: "Same Author",
        series: null,
        seriesIndex: null,
        path: "Same Author/Same Book (15)",
        formats: ["EPUB"],
        hasCover: true,
      };

      const { keeper, duplicates } = pickRecommendedKeeper([b1, b2]);
      expect(keeper.id).toBe(5);
      expect(duplicates[0].id).toBe(15);
    });
  });

  describe("findDuplicateGroups", () => {
    it("groups books with identical series and volume index", () => {
      const books: CalibreBookRecord[] = [
        {
          id: 1,
          title: "Overlord, Vol. 1",
          authors: "Kugane Maruyama",
          series: "Overlord",
          seriesIndex: 1,
          path: "path1",
          formats: ["EPUB"],
          hasCover: true,
        },
        {
          id: 2,
          title: "Overlord Volume 01 [Official]",
          authors: "Maruyama Kugane",
          series: "Overlord",
          seriesIndex: 1,
          path: "path2",
          formats: ["EPUB"],
          hasCover: false,
        },
        {
          id: 3,
          title: "Overlord, Vol. 2",
          authors: "Kugane Maruyama",
          series: "Overlord",
          seriesIndex: 2,
          path: "path3",
          formats: ["EPUB"],
          hasCover: true,
        },
      ];

      const groups = findDuplicateGroups(books, { skipContentHash: true });
      expect(groups.length).toBe(1);
      expect(groups[0].reason).toBe("series_volume");
      expect(groups[0].recommendedKeeper.id).toBe(1);
      expect(groups[0].duplicatesToRemove.length).toBe(1);
      expect(groups[0].duplicatesToRemove[0].id).toBe(2);
    });

    it("groups books by normalized title and author similarity", () => {
      const books: CalibreBookRecord[] = [
        {
          id: 101,
          title: "Clean Code: A Handbook of Agile Software Craftsmanship",
          authors: "Robert C. Martin",
          series: null,
          seriesIndex: null,
          path: "path101",
          formats: ["EPUB"],
          hasCover: true,
        },
        {
          id: 102,
          title: "Clean Code [Retail] (EPUB)",
          authors: "Robert C. Martin",
          series: null,
          seriesIndex: null,
          path: "path102",
          formats: ["EPUB"],
          hasCover: false,
        },
      ];

      const groups = findDuplicateGroups(books, { skipContentHash: true });
      expect(groups.length).toBe(1);
      expect(groups[0].reason).toBe("title_author_similarity");
      expect(groups[0].recommendedKeeper.id).toBe(101);
      expect(groups[0].duplicatesToRemove[0].id).toBe(102);
    });

    it("does not group different volumes of the same series", () => {
      const books: CalibreBookRecord[] = [
        {
          id: 11,
          title: "Sword Art Online 1: Aincrad",
          authors: "Reki Kawahara",
          series: "Sword Art Online",
          seriesIndex: 1,
          path: "path11",
          formats: ["EPUB"],
        },
        {
          id: 12,
          title: "Sword Art Online 2: Aincrad",
          authors: "Reki Kawahara",
          series: "Sword Art Online",
          seriesIndex: 2,
          path: "path12",
          formats: ["EPUB"],
        },
      ];

      const groups = findDuplicateGroups(books, { skipContentHash: true });
      expect(groups.length).toBe(0);
    });
  });

  describe("parseArgs", () => {
    it("defaults to dryRun: true", () => {
      const opts = parseArgs([]);
      expect(opts.dryRun).toBe(true);
      expect(opts.apply).toBeUndefined();
    });

    it("sets apply: true and dryRun: false on --apply or --prune", () => {
      const opts1 = parseArgs(["--apply"]);
      expect(opts1.apply).toBe(true);
      expect(opts1.dryRun).toBe(false);

      const opts2 = parseArgs(["--prune"]);
      expect(opts2.apply).toBe(true);
      expect(opts2.dryRun).toBe(false);
    });

    it("parses options like --library-dir and --audit-log", () => {
      const opts = parseArgs([
        "--library-dir",
        "/tmp/test-calibre",
        "--audit-log",
        "/tmp/audit.json",
        "--verbose",
      ]);
      expect(opts.libraryPath).toBe("/tmp/test-calibre");
      expect(opts.auditLogPath).toBe("/tmp/audit.json");
      expect(opts.verbose).toBe(true);
    });
  });

  describe("runCleanDuplicates Hermetic Unit Test", () => {
    let testDir: string;
    let mockAuditPath: string;

    beforeEach(() => {
      testDir = fs.mkdtempSync(path.join(os.tmpdir(), "clean-dups-test-"));
      mockAuditPath = path.join(testDir, "audit.json");
    });

    afterEach(() => {
      if (fs.existsSync(testDir)) {
        fs.rmSync(testDir, { recursive: true, force: true });
      }
    });

    it("runs in --dry-run mode without removing any books", async () => {
      const mockBooks: CalibreBookRecord[] = [
        {
          id: 1,
          title: "Dune",
          authors: "Frank Herbert",
          series: null,
          seriesIndex: null,
          path: "path1",
          formats: ["EPUB"],
          hasCover: true,
        },
        {
          id: 2,
          title: "Dune [Official Edition]",
          authors: "Frank Herbert",
          series: null,
          seriesIndex: null,
          path: "path2",
          formats: ["EPUB"],
          hasCover: false,
        },
      ];

      const removed: number[] = [];
      const mockRemover = async (id: number) => {
        removed.push(id);
        return { success: true };
      };

      const result = await runCleanDuplicates({
        dryRun: true,
        booksProvider: () => mockBooks,
        bookRemover: mockRemover,
        auditLogPath: mockAuditPath,
        skipContentHash: true,
      });

      expect(result.dryRun).toBe(true);
      expect(result.duplicateGroupsFound).toBe(1);
      expect(result.totalDuplicatesToRemove).toBe(1);
      expect(result.removedBookIds.length).toBe(0); // Nothing removed in dry run
      expect(removed.length).toBe(0);
      expect(fs.existsSync(mockAuditPath)).toBe(true);

      const auditData = JSON.parse(fs.readFileSync(mockAuditPath, "utf8"));
      expect(auditData.dryRun).toBe(true);
      expect(auditData.duplicateGroupsCount).toBe(1);
      expect(auditData.groups[0].keeper.id).toBe(1);
      expect(auditData.groups[0].duplicates[0].id).toBe(2);
    });

    it("runs in --apply mode and safely removes duplicate IDs via remover", async () => {
      const mockBooks: CalibreBookRecord[] = [
        {
          id: 10,
          title: "Spice and Wolf Vol. 1",
          authors: "Isuna Hasekura",
          series: "Spice and Wolf",
          seriesIndex: 1,
          path: "path10",
          formats: ["EPUB"],
          hasCover: true,
        },
        {
          id: 11,
          title: "Spice & Wolf Volume 01 [Official]",
          authors: "Isuna Hasekura",
          series: "Spice and Wolf",
          seriesIndex: 1,
          path: "path11",
          formats: ["EPUB"],
          hasCover: false,
        },
      ];

      const removed: number[] = [];
      const mockRemover = async (id: number) => {
        removed.push(id);
        return { success: true };
      };

      const result = await runCleanDuplicates({
        apply: true,
        booksProvider: () => mockBooks,
        bookRemover: mockRemover,
        auditLogPath: mockAuditPath,
        skipContentHash: true,
      });

      expect(result.dryRun).toBe(false);
      expect(result.duplicateGroupsFound).toBe(1);
      expect(result.totalDuplicatesToRemove).toBe(1);
      expect(result.removedBookIds).toEqual([11]);
      expect(removed).toEqual([11]);
      expect(fs.existsSync(mockAuditPath)).toBe(true);

      const auditData = JSON.parse(fs.readFileSync(mockAuditPath, "utf8"));
      expect(auditData.dryRun).toBe(false);
      expect(auditData.removedBookIds).toEqual([11]);
    });
  });
});
