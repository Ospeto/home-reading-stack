import { describe, expect, it } from "bun:test";
import {
  DiscoveredNovel,
  getDiscoverNovelById,
  matchNovelWithCalibreIndex,
  buildCalibreInvertedIndex,
  getOrCreateCalibreInvertedIndex,
  VerifiedSourceInventory,
} from "./discover";
import { handleRequest } from "./server";

describe("Series Availability & Download All Shared Behavior (Date A Live & Multi-Series)", () => {
  describe("Defect 1: Novel ID Resolution in getDiscoverNovelById across Feed Prefixes", () => {
    it("resolves AniList-prefixed novel ID (anilist-67523-date-a-live) to audited novel instead of 404", async () => {
      const mockCalibre = Array.from({ length: 16 }, (_, i) => ({
        id: 1694 + i,
        title: `Date A Live: Volume ${i + 1}`,
        series: "Date A Live",
        series_index: i + 1,
      }));

      const novel = await getDiscoverNovelById("anilist-67523-date-a-live", {
        getCalibreBooks: () => mockCalibre,
        resolveSourceVolumes: (url, source) => {
          if (source === "elscione") {
            return {
              source: "elscione",
              url,
              status: "verified",
              volumeCount: 16,
              volumes: Array.from({ length: 16 }, (_, i) => i + 1),
            };
          }
          return {
            source: "lnori",
            url,
            status: "verified",
            volumeCount: 15,
            volumes: Array.from({ length: 15 }, (_, i) => i + 1),
          };
        },
      });

      expect(novel).toBeDefined();
      expect(novel).not.toBeNull();
      // Caller requested anilist-67523-date-a-live: returned novel must preserve this ID
      expect(novel?.id).toBe("anilist-67523-date-a-live");
      expect(novel?.title).toBe("Date A Live");
      expect(novel?.catalogVolumeCount).toBe(22);
      expect(novel?.verifiedVolumeCount).toBe(16);
      expect(novel?.volumeCount).toBe(16);
      expect(novel?.inLibrary).toBe(true);
      expect(novel?.existingVolumes).toBe(16);
      expect(novel?.missingVolumeCount).toBe(0);
      expect(novel?.missingVolumeIndices).toEqual([]);
      expect(novel?.allVerifiedOwned).toBe(true);
    });

    it("resolves Lnori-prefixed novel ID (lnori-1821-date-a-live) preserving requested ID", async () => {
      const novel = await getDiscoverNovelById("lnori-1821-date-a-live", {
        getCalibreBooks: () => [],
        resolveSourceVolumes: (url, source) => ({
          source,
          url,
          status: "verified",
          volumeCount: 16,
          volumes: Array.from({ length: 16 }, (_, i) => i + 1),
        }),
      });

      expect(novel).toBeDefined();
      expect(novel?.id).toBe("lnori-1821-date-a-live");
      expect(novel?.title).toBe("Date A Live");
    });

    it("resolves Elscione-prefixed novel ID (elscione-date-a-live) preserving requested ID", async () => {
      const novel = await getDiscoverNovelById("elscione-date-a-live", {
        getCalibreBooks: () => [],
        resolveSourceVolumes: (url, source) => ({
          source,
          url,
          status: "verified",
          volumeCount: 16,
          volumes: Array.from({ length: 16 }, (_, i) => i + 1),
        }),
      });

      expect(novel).toBeDefined();
      expect(novel?.id).toBe("elscione-date-a-live");
      expect(novel?.title).toBe("Date A Live");
    });

    it("GET /api/discover/novel/anilist-67523-date-a-live serves audited novel over HTTP", async () => {
      const req = new Request("http://127.0.0.1:8086/api/discover/novel/anilist-67523-date-a-live");
      const res = await handleRequest(req, {
        getCalibreBooks: () => [
          { id: 101, title: "Date A Live: Volume 1", series: "Date A Live", series_index: 1 },
        ],
        resolveSourceVolumes: (url, source) => ({
          source,
          url,
          status: "verified",
          volumeCount: 16,
          volumes: Array.from({ length: 16 }, (_, i) => i + 1),
        }),
      });

      expect(res.status).toBe(200);
      const data = await res.json();
      expect(data.success).toBe(true);
      expect(data.novel).toBeDefined();
      expect(data.novel.id).toBe("anilist-67523-date-a-live");
      expect(data.novel.title).toBe("Date A Live");
    });
  });

  describe("Defect 2: 22 Catalog Total vs 16 Available vs Library Truthfulness", () => {
    it("scenario 1: user owns 16 of 16 available (catalog 22) -> missing is 0, zero phantom downloads", async () => {
      const mockCalibre = Array.from({ length: 16 }, (_, i) => ({
        id: 1000 + i,
        title: `Date A Live, Vol. ${i + 1}`,
        series: "Date A Live",
        series_index: i + 1,
      }));

      const novel = await getDiscoverNovelById("date-a-live", {
        getCalibreBooks: () => mockCalibre,
        resolveSourceVolumes: (url, source) => ({
          source,
          url,
          status: "verified",
          volumeCount: 16,
          volumes: Array.from({ length: 16 }, (_, i) => i + 1),
        }),
      });

      expect(novel?.catalogVolumeCount).toBe(22);
      expect(novel?.volumeCount).toBe(16);
      expect(novel?.verifiedVolumeCount).toBe(16);
      expect(novel?.existingVolumes).toBe(16);
      expect(novel?.missingVolumeCount).toBe(0);
      expect(novel?.missingVolumeIndices).toEqual([]);
      expect(novel?.allVerifiedOwned).toBe(true);
    });

    it("scenario 2: user owns 10 of 16 available (catalog 22) -> missing is exactly 6 (11-16), not 12", async () => {
      const mockCalibre = Array.from({ length: 10 }, (_, i) => ({
        id: 1000 + i,
        title: `Date A Live, Vol. ${i + 1}`,
        series: "Date A Live",
        series_index: i + 1,
      }));

      const novel = await getDiscoverNovelById("date-a-live", {
        getCalibreBooks: () => mockCalibre,
        resolveSourceVolumes: (url, source) => ({
          source,
          url,
          status: "verified",
          volumeCount: 16,
          volumes: Array.from({ length: 16 }, (_, i) => i + 1),
        }),
      });

      expect(novel?.catalogVolumeCount).toBe(22);
      expect(novel?.volumeCount).toBe(16);
      expect(novel?.verifiedVolumeCount).toBe(16);
      expect(novel?.existingVolumes).toBe(10);
      expect(novel?.missingVolumeCount).toBe(6);
      expect(novel?.missingVolumeIndices).toEqual([11, 12, 13, 14, 15, 16]);
      expect(novel?.allVerifiedOwned).toBe(false);
    });

    it("scenario 3: 22 actually available on source and user owns 16 -> missing is 6 (17-22)", async () => {
      const mockCalibre = Array.from({ length: 16 }, (_, i) => ({
        id: 1000 + i,
        title: `Date A Live, Vol. ${i + 1}`,
        series: "Date A Live",
        series_index: i + 1,
      }));

      const novel = await getDiscoverNovelById("date-a-live", {
        getCalibreBooks: () => mockCalibre,
        resolveSourceVolumes: (url, source) => ({
          source,
          url,
          status: "verified",
          volumeCount: 22,
          volumes: Array.from({ length: 22 }, (_, i) => i + 1),
        }),
      });

      expect(novel?.catalogVolumeCount).toBe(22);
      expect(novel?.volumeCount).toBe(22);
      expect(novel?.verifiedVolumeCount).toBe(22);
      expect(novel?.existingVolumes).toBe(16);
      expect(novel?.missingVolumeCount).toBe(6);
      expect(novel?.missingVolumeIndices).toEqual([17, 18, 19, 20, 21, 22]);
      expect(novel?.allVerifiedOwned).toBe(false);
    });
  });

  describe("Defect 3: Variable Series & Sparse Numbering (Prequel 0 and Fractional Volumes)", () => {
    it("handles Volume 0 prequel and fractional volume 4.5 without corruption", () => {
      const novel: DiscoveredNovel = {
        id: "variable-series-test",
        title: "Variable Series Test",
        author: "Author",
        coverUrl: "https://example.com/cover.jpg",
        synopsis: "Test synopsis for variable series.",
        genres: ["Fantasy"],
        volumeCount: 7,
        catalogVolumeCount: 7,
        source: "elscione",
        sourceUrls: { elscione: "https://server.elscione.com/Variable%20Series%20Test/" },
        inLibrary: false,
        existingVolumes: 0,
        verifiedVolumes: [0, 1, 2, 3, 4, 4.5, 5],
        verifiedVolumeCount: 7,
        sourceStatus: "verified",
      };

      const mockCalibre = [
        { id: 901, title: "Variable Series Test Volume 0", series: "Variable Series Test", series_index: 0 },
        { id: 902, title: "Variable Series Test Volume 1", series: "Variable Series Test", series_index: 1 },
        { id: 903, title: "Variable Series Test Volume 2", series: "Variable Series Test", series_index: 2 },
        { id: 904, title: "Variable Series Test Volume 4.5", series: "Variable Series Test", series_index: 4.5 },
      ];

      const index = getOrCreateCalibreInvertedIndex(mockCalibre);
      const audited = matchNovelWithCalibreIndex(novel, index);

      expect(audited.inLibrary).toBe(true);
      expect(audited.existingVolumes).toBe(4);
      expect(audited.ownedVolumeIndices).toContain(0);
      expect(audited.ownedVolumeIndices).toContain(1);
      expect(audited.ownedVolumeIndices).toContain(2);
      expect(audited.ownedVolumeIndices).toContain(4.5);
      // Missing volumes are [3, 4, 5]
      expect(audited.missingVolumeCount).toBe(3);
      expect(audited.missingVolumeIndices).toEqual([3, 4, 5]);
      expect(audited.allVerifiedOwned).toBe(false);
    });

    it("sparse library ownership [1, 2, 7] with source [1..7] yields missing [3, 4, 5, 6]", () => {
      const novel: DiscoveredNovel = {
        id: "sparse-series",
        title: "Sparse Series",
        author: "Author",
        coverUrl: "https://example.com/cover.jpg",
        synopsis: "Test synopsis for sparse series.",
        genres: ["Action"],
        volumeCount: 7,
        catalogVolumeCount: 7,
        source: "elscione",
        sourceUrls: { elscione: "https://server.elscione.com/Sparse%20Series/" },
        inLibrary: false,
        existingVolumes: 0,
        verifiedVolumes: [1, 2, 3, 4, 5, 6, 7],
        verifiedVolumeCount: 7,
        sourceStatus: "verified",
      };

      const mockCalibre = [
        { id: 801, title: "Sparse Series Vol 1", series: "Sparse Series", series_index: 1 },
        { id: 802, title: "Sparse Series Vol 2", series: "Sparse Series", series_index: 2 },
        { id: 807, title: "Sparse Series Vol 7", series: "Sparse Series", series_index: 7 },
      ];

      const index = getOrCreateCalibreInvertedIndex(mockCalibre);
      const audited = matchNovelWithCalibreIndex(novel, index);

      expect(audited.existingVolumes).toBe(3);
      expect(audited.ownedVolumeIndices).toEqual([1, 2, 7]);
      expect(audited.missingVolumeCount).toBe(4);
      expect(audited.missingVolumeIndices).toEqual([3, 4, 5, 6]);
    });

    it("resolveNovelSourceInventories includes Volume 0 prequel in verified volumes union", async () => {
      const { resolveNovelSourceInventories } = await import("./discover");
      const novel: DiscoveredNovel = {
        id: "prequel-inv-test",
        title: "Prequel Test",
        author: "Author",
        coverUrl: "https://example.com/cover.jpg",
        synopsis: "Prequel inventory test synopsis.",
        genres: ["Fantasy"],
        volumeCount: 3,
        source: "elscione",
        sourceUrls: { elscione: "https://server.elscione.com/Prequel%20Test/" },
        inLibrary: false,
        existingVolumes: 0,
      };

      const res = await resolveNovelSourceInventories(novel, {
        resolveSourceVolumes: () => ({
          source: "elscione",
          url: "https://server.elscione.com/Prequel%20Test/",
          status: "verified",
          volumeCount: 3,
          volumes: [0, 1, 2],
        }),
      });

      expect(res.sourceStatus).toBe("verified");
      expect(res.verifiedVolumes).toEqual([0, 1, 2]);
      expect(res.verifiedVolumeCount).toBe(3);
    });
  });

  describe("Defect 4: Unverified & Offline Source Handling and Status Segregation", () => {
    it("unverified novel with 16 in library preserves catalog count 22 but does NOT manufacture missing volumes", () => {
      const novel: DiscoveredNovel = {
        id: "unverified-date-a-live",
        title: "Date A Live",
        author: "Koushi Tachibana",
        coverUrl: "https://example.com/dal.jpg",
        synopsis: "Thirty years ago, a strange phenomenon devastated Eurasia...",
        genres: ["Sci-Fi"],
        volumeCount: 22,
        catalogVolumeCount: 22,
        source: "both",
        sourceUrls: {
          elscione: "https://server.elscione.com/Officially%20Translated%20Light%20Novels/Date%20A%20Live/",
          lnori: "https://lnori.com/series/1821/date-a-live",
        },
        inLibrary: false,
        existingVolumes: 0,
        sourceStatus: "unverified",
      };

      const mockCalibre = Array.from({ length: 16 }, (_, i) => ({
        id: 700 + i,
        title: `Date A Live, Vol. ${i + 1}`,
        series: "Date A Live",
        series_index: i + 1,
      }));

      const index = getOrCreateCalibreInvertedIndex(mockCalibre);
      const audited = matchNovelWithCalibreIndex(novel, index);

      expect(audited.inLibrary).toBe(true);
      expect(audited.existingVolumes).toBe(16);
      expect(audited.sourceStatus).toBe("unverified");
      // Total volumeCount reflects catalog 22
      expect(audited.volumeCount).toBe(22);
      expect(audited.catalogVolumeCount).toBe(22);
      // Unverified availability: unknown missing count
      expect(audited.missingVolumeCount).toBeUndefined();
      expect(audited.missingVolumeIndices).toBeUndefined();
      expect(audited.allVerifiedOwned).toBe(false);
    });

    it("all sources offline sets sourceStatus to error and does not manufacture missing volumes", async () => {
      const novel = await getDiscoverNovelById("date-a-live", {
        getCalibreBooks: () => [
          { id: 601, title: "Date A Live, Vol. 1", series: "Date A Live", series_index: 1 },
        ],
        resolveSourceVolumes: () => {
          throw new Error("Connection refused (source offline)");
        },
      });

      expect(novel?.sourceStatus).toBe("error");
      expect(novel?.missingVolumeCount).toBeUndefined();
      expect(novel?.missingVolumeIndices).toBeUndefined();
      expect(novel?.allVerifiedOwned).toBe(false);
      expect(novel?.sources?.every((s) => s.status === "error")).toBe(true);
    });
  });

  describe("Defect 5: UI Modal HTML Truthfulness (Index.html inspection)", () => {
    it("index.html truthful completion summary distinguishes 0 new volumes preserved vs new downloads", async () => {
      const html = await Bun.file("uploader/index.html").text();
      expect(html).toContain("All ${duplicate} available volumes already in library");
      expect(html).toContain("Downloaded ${imported} new volume");
    });

    it("index.html preserves clean card download button and verified modal contracts", async () => {
      const html = await Bun.file("uploader/index.html").text();
      // DC2: completion is stated once, in the chip vocabulary, plus the one dead primary button
      expect(html).toContain("All ${totalVols} volumes are in your Calibre library.");
      expect(html).toContain("All Volumes in Library (${totalVols}/${totalVols})");
      expect(html).toContain("Download All (${totalVols} vols)");
    });
  });

  describe("Defect 6: Ingestion Partial and All-Fail Semantics (Server & Progress)", () => {
    it("executeLnoriIngestTask records partial success when last 6 volumes fail", async () => {
      const {
        executeLnoriIngestTask,
        getDiscoverJobProgress,
        registerDiscoverJob,
        resetActiveLnoriStateForTest,
        setServerDependenciesForTest,
        resetServerDependenciesForTest,
      } = await import("./server");

      resetActiveLnoriStateForTest();
      const runId = "test-partial-fail-1";
      const jobId = 9991;
      registerDiscoverJob(
        jobId,
        runId,
        "elscione",
        "https://server.elscione.com/Officially%20Translated%20Light%20Novels/Date%20A%20Live/",
        "date-a-live",
        "Date A Live",
      );

      // Mock ingest function where 10 succeed and 6 fail
      setServerDependenciesForTest({
        ingestElscioneSeries: async () => ({
          success: true,
          seriesTitle: "Date A Live",
          author: "Koushi Tachibana",
          importedCount: 10,
          skippedCount: 6,
          duplicateCount: 0,
          skippedErrors: 6,
          totalCount: 16,
          volumes: Array.from({ length: 16 }, (_, i) => i + 1),
          tags: ["Light Novel", "Elscione"],
          calibreBookIds: [1, 2, 3, 4, 5, 6, 7, 8, 9, 10],
          failedVolumes: ["Volume 11", "Volume 12", "Volume 13", "Volume 14", "Volume 15", "Volume 16"],
        }),
      });

      await executeLnoriIngestTask(
        runId,
        "https://server.elscione.com/Officially%20Translated%20Light%20Novels/Date%20A%20Live/",
        false,
      );

      // Verify progress reporting endpoint exposes truthful numbers
      const progress = getDiscoverJobProgress(jobId);
      expect(progress).toBeDefined();
      expect(progress?.phase).toBe("complete");
      expect(progress?.statusText).toContain("10 new volumes added");
      expect(progress?.statusText).toContain("6 volumes failed");
      expect(progress?.importedCount).toBe(10);
      expect(progress?.skippedErrors).toBe(6);

      resetServerDependenciesForTest();
      resetActiveLnoriStateForTest();
    });

    it("executeLnoriIngestTask records failure when all volumes fail", async () => {
      const {
        executeLnoriIngestTask,
        getDiscoverJobProgress,
        registerDiscoverJob,
        resetActiveLnoriStateForTest,
        setServerDependenciesForTest,
        resetServerDependenciesForTest,
      } = await import("./server");

      resetActiveLnoriStateForTest();
      const runId = "test-all-fail-1";
      const jobId = 9992;
      registerDiscoverJob(
        jobId,
        runId,
        "elscione",
        "https://server.elscione.com/Officially%20Translated%20Light%20Novels/Date%20A%20Live/",
        "date-a-live",
        "Date A Live",
      );

      setServerDependenciesForTest({
        ingestElscioneSeries: async () => ({
          success: false,
          error: "All 16 volumes failed to download",
          seriesTitle: "Date A Live",
          author: "Koushi Tachibana",
          importedCount: 0,
          skippedCount: 16,
          duplicateCount: 0,
          skippedErrors: 16,
          totalCount: 16,
          calibreBookIds: [],
        }),
      });

      await executeLnoriIngestTask(
        runId,
        "https://server.elscione.com/Officially%20Translated%20Light%20Novels/Date%20A%20Live/",
        false,
      );

      const progress = getDiscoverJobProgress(jobId);
      expect(progress).toBeDefined();
      expect(progress?.phase).toBe("error");
      expect(progress?.error).toContain("All 16 volumes failed to download");

      resetServerDependenciesForTest();
      resetActiveLnoriStateForTest();
    });
  });
});
