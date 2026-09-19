import { describe, it, expect } from "bun:test";
import {
  CalibreBook,
  DuplicateGroup,
  scoreBookForKeeper,
  checkDuplicatePair,
  clusterDuplicateGroups,
  runDuplicateCleaner,
  formatCleanerReport,
  safeJsonParse,
  getCanonicalVolume,
  removeCalibreBooks,
} from "./clean-duplicates";

describe("Calibre Library Duplicate Scanner & Pruning Tool", () => {
  describe("scoreBookForKeeper", () => {
    it("heavily prioritizes active reading progress from KOSync", () => {
      const bookReading: CalibreBook = {
        id: 10,
        title: "Dune",
        authors: "Frank Herbert",
        formats: ["EPUB"],
        reading_progress: 0.45,
      };

      const bookUnread: CalibreBook = {
        id: 20,
        title: "Dune",
        authors: "Frank Herbert",
        formats: ["EPUB"],
        has_cover: true,
        series: "Dune",
        series_index: 1,
      };

      const scoreReading = scoreBookForKeeper(bookReading);
      const scoreUnread = scoreBookForKeeper(bookUnread);

      expect(scoreReading.score).toBeGreaterThan(scoreUnread.score);
      expect(scoreReading.reasons).toContain("Active reading progress (45%)");
    });

    it("evaluates EPUB format and metadata richness (series, cover, tags, publisher)", () => {
      const richBook: CalibreBook = {
        id: 1,
        title: "Overlord, Vol. 14",
        authors: "Kugane Maruyama",
        series: "Overlord",
        series_index: 14,
        formats: ["EPUB"],
        has_cover: true,
        publisher: "Yen Press",
        tags: ["Light Novel", "Fantasy", "Isekai"],
        file_size: 5 * 1024 * 1024,
      };

      const bareBook: CalibreBook = {
        id: 2,
        title: "Overlord 14",
        authors: "Unknown",
        formats: ["PDF"],
      };

      const scoreRich = scoreBookForKeeper(richBook);
      const scoreBare = scoreBookForKeeper(bareBook);

      expect(scoreRich.score).toBeGreaterThan(scoreBare.score);
      expect(scoreRich.reasons).toContain("EPUB format");
      expect(scoreRich.reasons).toContain("Explicit series metadata");
      expect(scoreRich.reasons).toContain("Has cover");
      expect(scoreRich.reasons).toContain("Publisher info");
      expect(scoreRich.reasons).toContain("3 tag(s)");
    });

    it("uses earlier book ID as stability tiebreaker when metadata is identical", () => {
      const bookOlder: CalibreBook = {
        id: 5,
        title: "Clean Code",
        authors: "Robert C. Martin",
        formats: ["EPUB"],
      };

      const bookNewer: CalibreBook = {
        id: 950,
        title: "Clean Code",
        authors: "Robert C. Martin",
        formats: ["EPUB"],
      };

      const scoreOlder = scoreBookForKeeper(bookOlder);
      const scoreNewer = scoreBookForKeeper(bookNewer);

      expect(scoreOlder.score).toBeGreaterThan(scoreNewer.score);
    });
  });

  describe("checkDuplicatePair", () => {
    describe("Volume Isolation Hard Gate", () => {
      it("NEVER flags different volumes in the same series as duplicates", () => {
        const vol1: CalibreBook = {
          id: 101,
          title: "Overlord, Vol. 1: The Undead King",
          authors: "Kugane Maruyama",
          series: "Overlord",
          series_index: 1,
        };

        const vol2: CalibreBook = {
          id: 102,
          title: "Overlord, Vol. 2: The Dark Warrior",
          authors: "Kugane Maruyama",
          series: "Overlord",
          series_index: 2,
        };

        const vol14: CalibreBook = {
          id: 114,
          title: "Overlord, Vol. 14: The Witch of the Ruined Kingdom",
          authors: "Kugane Maruyama",
          series: "Overlord",
          series_index: 14,
        };

        expect(checkDuplicatePair(vol1, vol2).isDuplicate).toBe(false);
        expect(checkDuplicatePair(vol1, vol14).isDuplicate).toBe(false);
        expect(checkDuplicatePair(vol2, vol14).isDuplicate).toBe(false);
      });

      it("NEVER flags different volume numbers in titles without explicit series", () => {
        const bookV1: CalibreBook = {
          id: 201,
          title: "Sword Art Online 01 Aincrad",
          authors: "Reki Kawahara",
        };

        const bookV2: CalibreBook = {
          id: 202,
          title: "Sword Art Online 02 Aincrad",
          authors: "Reki Kawahara",
        };

        expect(checkDuplicatePair(bookV1, bookV2).isDuplicate).toBe(false);
      });

      it("NEVER flags different volumes as duplicates even if content hash or binary hash matches", () => {
        const vol1: CalibreBook = {
          id: 401,
          title: "Overlord, Vol. 1",
          authors: "Kugane Maruyama",
          series: "Overlord",
          series_index: 1,
          content_hash: "urn:uuid:same-template-uuid",
          binary_hash: "same-binary-checksum-sample",
        };

        const vol2: CalibreBook = {
          id: 402,
          title: "Overlord, Vol. 2",
          authors: "Kugane Maruyama",
          series: "Overlord",
          series_index: 2,
          content_hash: "urn:uuid:same-template-uuid",
          binary_hash: "same-binary-checksum-sample",
        };

        const res = checkDuplicatePair(vol1, vol2);
        expect(res.isDuplicate).toBe(false);
      });

      it("derives canonical volume accurately across title, series_index, and extractSeries heuristics", () => {
        expect(getCanonicalVolume({ id: 1, title: "Overlord, Vol. 14" })).toBe(14);
        expect(getCanonicalVolume({ id: 2, title: "Classroom of the Elite: Year 2 Vol. 4.5" })).toBe(4.5);
        expect(getCanonicalVolume({ id: 3, title: "Book Title", series: "Series Name", series_index: 3 })).toBe(3);
        expect(getCanonicalVolume({ id: 4, title: "The Beginning After the End: Book 10" })).toBe(10);
        expect(getCanonicalVolume({ id: 5, title: "စစ်နှင့်ငြိမ်းချမ်းရေး (အတွဲ ၂)" })).toBe(2);
        expect(getCanonicalVolume({ id: 6, title: "Standalone Novel Without Volume" })).toBeNull();
      });
    });

    describe("Duplicate Detection Rules", () => {
      it("detects duplicates matching content hash or EPUB content signature", () => {
        const a: CalibreBook = {
          id: 1,
          title: "Book with altered title",
          authors: "Some Author",
          content_hash: "urn:uuid:550e8400-e29b-41d4-a716-446655440000",
        };

        const b: CalibreBook = {
          id: 2,
          title: "Original Title",
          authors: "Different Author Tag",
          content_hash: "urn:uuid:550e8400-e29b-41d4-a716-446655440000",
        };

        const res = checkDuplicatePair(a, b);
        expect(res.isDuplicate).toBe(true);
        expect(res.matchType).toBe("content_hash");
      });

      it("detects duplicates matching identical KOReader binary checksum", () => {
        const a: CalibreBook = {
          id: 3,
          title: "Book Alpha",
          binary_hash: "abc123def4567890",
        };

        const b: CalibreBook = {
          id: 4,
          title: "Book Beta",
          binary_hash: "abc123def4567890",
        };

        const res = checkDuplicatePair(a, b);
        expect(res.isDuplicate).toBe(true);
        expect(res.matchType).toBe("content_hash");
      });

      it("detects duplicates matching explicit series AND same volume index", () => {
        const a: CalibreBook = {
          id: 5,
          title: "Re:Zero Vol. 1",
          authors: "Tappei Nagatsuki",
          series: "Re:ZERO -Starting Life in Another World-",
          series_index: 1,
        };

        const b: CalibreBook = {
          id: 6,
          title: "Re:ZERO: Volume 01 [Digital]",
          authors: "Tappei Nagatsuki",
          series: "Re:ZERO -Starting Life in Another World-",
          series_index: 1,
        };

        const res = checkDuplicatePair(a, b);
        expect(res.isDuplicate).toBe(true);
        expect(res.matchType).toBe("series_volume");
      });

      it("detects duplicates with watermark brackets, release tags, and punctuation variations", () => {
        const a: CalibreBook = {
          id: 7,
          title: "Dune [Z-Library] [v1.0]",
          authors: "Frank Herbert",
        };

        const b: CalibreBook = {
          id: 8,
          title: "Dune",
          authors: "Frank Herbert",
        };

        const res = checkDuplicatePair(a, b);
        expect(res.isDuplicate).toBe(true);
        expect(res.matchType).toBe("title_author_similarity");
      });

      it("rejects books with conflicting known authors even with matching titles", () => {
        const a: CalibreBook = {
          id: 9,
          title: "The Odyssey",
          authors: "Homer",
        };

        const b: CalibreBook = {
          id: 10,
          title: "The Odyssey",
          authors: "Stephen Fry",
        };

        const res = checkDuplicatePair(a, b);
        expect(res.isDuplicate).toBe(false);
      });

      it("rejects distinct books by the same author", () => {
        const a: CalibreBook = {
          id: 11,
          title: "Clean Code",
          authors: "Robert C. Martin",
        };

        const b: CalibreBook = {
          id: 12,
          title: "Clean Architecture",
          authors: "Robert C. Martin",
        };

        expect(checkDuplicatePair(a, b).isDuplicate).toBe(false);
      });
    });
  });

  describe("clusterDuplicateGroups", () => {
    it("returns empty array for empty or single-book list", () => {
      expect(clusterDuplicateGroups([])).toEqual([]);
      expect(
        clusterDuplicateGroups([
          { id: 1, title: "Solo Book", authors: "Author" },
        ]),
      ).toEqual([]);
    });

    it("clusters 2 duplicate books into 1 group, picks optimal keeper, and lists duplicates", () => {
      const books: CalibreBook[] = [
        {
          id: 10,
          title: "Mushoku Tensei Vol. 1",
          authors: "Rifujin na Magonote",
          series: "Mushoku Tensei",
          series_index: 1,
          formats: ["EPUB"],
          has_cover: true,
          publisher: "Seven Seas",
        },
        {
          id: 11,
          title: "Mushoku Tensei: Jobless Reincarnation Volume 01 [EPUB]",
          authors: "Rifujin na Magonote",
          formats: ["EPUB"],
        },
      ];

      const groups = clusterDuplicateGroups(books);
      expect(groups.length).toBe(1);
      expect(groups[0].keeperId).toBe(10);
      expect(groups[0].duplicateIds).toEqual([11]);
      expect(groups[0].books.length).toBe(2);
      expect(groups[0].keeperReason).toContain("Explicit series metadata");
    });

    it("clusters 3 duplicate books into a single group with 1 keeper and 2 duplicates", () => {
      const books: CalibreBook[] = [
        {
          id: 1,
          title: "Dune",
          authors: "Frank Herbert",
          formats: ["EPUB"],
          has_cover: true,
        },
        {
          id: 2,
          title: "Dune [z-lib.org]",
          authors: "Frank Herbert",
          formats: ["EPUB"],
        },
        {
          id: 3,
          title: "Dune (Retail)",
          authors: "Frank Herbert",
          formats: ["EPUB"],
        },
      ];

      const groups = clusterDuplicateGroups(books);
      expect(groups.length).toBe(1);
      expect(groups[0].keeperId).toBe(1);
      expect(groups[0].duplicateIds.sort()).toEqual([2, 3]);
      expect(groups[0].books.length).toBe(3);
    });

    it("maintains strict volume isolation in multi-book collections", () => {
      const books: CalibreBook[] = [
        // Volume 1 and its duplicate
        {
          id: 101,
          title: "Overlord, Vol. 1",
          authors: "Kugane Maruyama",
          series: "Overlord",
          series_index: 1,
          formats: ["EPUB"],
          has_cover: true,
        },
        {
          id: 102,
          title: "Overlord Volume 01 [v1.0]",
          authors: "Kugane Maruyama",
          formats: ["EPUB"],
        },
        // Volume 2 (standalone, distinct)
        {
          id: 201,
          title: "Overlord, Vol. 2",
          authors: "Kugane Maruyama",
          series: "Overlord",
          series_index: 2,
          formats: ["EPUB"],
        },
      ];

      const groups = clusterDuplicateGroups(books);
      expect(groups.length).toBe(1);
      expect(groups[0].keeperId).toBe(101);
      expect(groups[0].duplicateIds).toEqual([102]);
      // Volume 2 (201) is NEVER touched or merged into the duplicate group
      const allGroupBookIds = groups[0].books.map((b) => b.id);
      expect(allGroupBookIds).not.toContain(201);
    });
  });

  describe("runDuplicateCleaner execution modes", () => {
    const mockBooks: CalibreBook[] = [
      {
        id: 50,
        title: "Clean Code",
        authors: "Robert C. Martin",
        formats: ["EPUB"],
        has_cover: true,
      },
      {
        id: 51,
        title: "Clean Code [v1.0] [EPUB]",
        authors: "Robert C. Martin",
        formats: ["EPUB"],
      },
    ];

    it("operates in safe read-only preview under default --dry-run", async () => {
      let removerCalled = false;
      let cleanerCalled = false;
      let auditLogWritten = false;

      const report = await runDuplicateCleaner({
        dryRun: true,
        booksProvider: () => mockBooks,
        bookRemover: async () => {
          removerCalled = true;
          return { success: true };
        },
        cacheCleaner: () => {
          cleanerCalled = true;
        },
        auditLogger: () => {
          auditLogWritten = true;
        },
      });

      expect(report.dryRun).toBe(true);
      expect(report.totalBooksScanned).toBe(2);
      expect(report.duplicateGroupsCount).toBe(1);
      expect(report.totalDuplicatesFound).toBe(1);
      expect(report.totalPruned).toBe(0);
      expect(removerCalled).toBe(false);
      expect(cleanerCalled).toBe(false);
      expect(auditLogWritten).toBe(false);
      expect(report.groups[0].keeperId).toBe(50);
      expect(report.groups[0].duplicateIds).toEqual([51]);
    });

    it("actively executes duplicate removals and cache cleanup under --apply", async () => {
      const removedIds: number[] = [];
      const cleanedIds: number[] = [];
      const auditEntries: string[] = [];

      const report = await runDuplicateCleaner({
        apply: true,
        booksProvider: () => mockBooks,
        bookRemover: async (ids) => {
          removedIds.push(...ids);
          return { success: true };
        },
        cacheCleaner: (ids) => {
          cleanedIds.push(...ids);
        },
        auditLogger: (entry) => {
          auditEntries.push(entry);
        },
      });

      expect(report.dryRun).toBe(false);
      expect(report.totalBooksScanned).toBe(2);
      expect(report.duplicateGroupsCount).toBe(1);
      expect(report.totalDuplicatesFound).toBe(1);
      expect(report.totalPruned).toBe(1);
      expect(report.errors.length).toBe(0);

      // Verifies ONLY the duplicate was removed, NOT the keeper
      expect(removedIds).toEqual([51]);
      expect(cleanedIds).toEqual([51]);
      expect(auditEntries.length).toBe(1);
      expect(auditEntries[0]).toContain("PRUNE book_id=51");
      expect(auditEntries[0]).toContain("KEEPER book_id=50");
    });

    it("records removal errors without crashing the cleaner", async () => {
      const report = await runDuplicateCleaner({
        apply: true,
        booksProvider: () => mockBooks,
        bookRemover: async () => {
          return { success: false, error: "calibredb lock timeout" };
        },
        cacheCleaner: () => {},
        auditLogger: () => {},
      });

      expect(report.dryRun).toBe(false);
      expect(report.totalPruned).toBe(0);
      expect(report.errors.length).toBe(1);
      expect(report.errors[0].message).toContain("calibredb lock timeout");
    });
  });

  describe("removeCalibreBooks book ID validation", () => {
    it("fails closed on invalid book IDs without invoking calibredb", async () => {
      const invalidCases = [
        [0],
        [-1],
        [NaN],
        [1.5],
        [Infinity],
        [1, -2, 3],
      ];

      for (const badIds of invalidCases) {
        const res = await removeCalibreBooks(badIds as number[], {});
        expect(res.success).toBe(false);
        expect(res.error).toContain("Must be a positive safe integer");
      }
    });
  });

  describe("formatCleanerReport & safeJsonParse helpers", () => {
    it("formats clean report when no duplicates exist", () => {
      const output = formatCleanerReport({
        timestamp: "2026-09-20T00:00:00.000Z",
        dryRun: true,
        totalBooksScanned: 100,
        duplicateGroupsCount: 0,
        totalDuplicatesFound: 0,
        totalPruned: 0,
        groups: [],
        errors: [],
      });

      expect(output).toContain("No duplicate books detected");
      expect(output).toContain("DRY RUN");
    });

    it("formats duplicate groups with keeper and prune badges", () => {
      const group: DuplicateGroup = {
        id: "group_1",
        matchType: "series_volume",
        reason: "Series Overlord Volume 1",
        keeperId: 10,
        keeperReason: "Explicit series metadata, Has cover",
        books: [
          { id: 10, title: "Overlord Vol. 1", authors: "Kugane Maruyama" },
          { id: 11, title: "Overlord 01", authors: "Kugane Maruyama" },
        ],
        duplicateIds: [11],
      };

      const output = formatCleanerReport({
        timestamp: "2026-09-20T00:00:00.000Z",
        dryRun: true,
        totalBooksScanned: 2,
        duplicateGroupsCount: 1,
        totalDuplicatesFound: 1,
        totalPruned: 0,
        groups: [group],
        errors: [],
      });

      expect(output).toContain("Recommended Keeper: #10");
      expect(output).toContain("Duplicates to Prune:");
      expect(output).toContain("#11");
      expect(output).toContain("bun run scripts/clean-duplicates.ts --apply");
    });

    it("parses JSON arrays embedded within noisy command output", () => {
      expect(safeJsonParse("")).toBeNull();
      expect(safeJsonParse("Some prefix text [1, 2, 3] trailing logs")).toEqual([1, 2, 3]);
      expect(safeJsonParse("[{\"id\": 1, \"title\": \"Book\"}]")).toEqual([{ id: 1, title: "Book" }]);
      expect(safeJsonParse("No brackets here")).toBeNull();
    });
  });
});
