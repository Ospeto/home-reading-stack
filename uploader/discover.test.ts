import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { Database } from "bun:sqlite";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import {
  getDiscoverNovels,
  fetchDiscoverFeed,
  crossCheckNovelsWithCalibre,
  normalizeTitleForMatch,
  resetDiscoverCacheForTest,
  getCachedFeed,
  setCachedFeed,
  enqueueDiscoverIngest,
  type DiscoveredNovel,
} from "./discover";
import {
  handleRequest,
  setServerDependenciesForTest,
  resetServerDependenciesForTest,
  resetActiveLnoriStateForTest,
  enqueueLnoriJob,
  enqueueElscioneJob,
} from "./server";

describe("Light Novel Discovery Engine (uploader/discover.ts)", () => {
  let tempCacheDb: Database;

  beforeEach(() => {
    tempCacheDb = new Database(":memory:");
    resetDiscoverCacheForTest({ cacheDb: tempCacheDb });
    resetServerDependenciesForTest();
    resetActiveLnoriStateForTest();
  });

  afterEach(() => {
    try {
      tempCacheDb.close();
    } catch {
      // Ignore in-memory db close error
    }
  });

  describe("Distinct Feeds (Trending vs New Releases)", () => {
    it("returns completely distinct novel sets for trending and new tabs", async () => {
      const trendingRes = await getDiscoverNovels(
        { tab: "trending" },
        { cacheDb: tempCacheDb },
      );
      const newRes = await getDiscoverNovels(
        { tab: "new" },
        { cacheDb: tempCacheDb },
      );

      expect(trendingRes.success).toBe(true);
      expect(trendingRes.tab).toBe("trending");
      expect(trendingRes.novels.length).toBeGreaterThan(0);

      expect(newRes.success).toBe(true);
      expect(newRes.tab).toBe("new");
      expect(newRes.novels.length).toBeGreaterThan(0);

      const trendingIds = new Set(trendingRes.novels.map((n) => n.id));
      const newIds = new Set(newRes.novels.map((n) => n.id));

      // Assert zero overlap between trending and new feeds
      for (const id of trendingIds) {
        expect(newIds.has(id)).toBe(false);
      }

      // Assert zero overlap between titles
      const trendingTitles = new Set(
        trendingRes.novels.map((n) => n.title.toLowerCase()),
      );
      for (const novel of newRes.novels) {
        expect(trendingTitles.has(novel.title.toLowerCase())).toBe(false);
      }
    });

    it("defaults to trending when tab parameter is omitted or invalid", async () => {
      const resDefault = await getDiscoverNovels({}, { cacheDb: tempCacheDb });
      expect(resDefault.tab).toBe("trending");

      const resInvalid = await getDiscoverNovels(
        { tab: "unknown" as any },
        { cacheDb: tempCacheDb },
      );
      expect(resInvalid.tab).toBe("trending");
    });
  });

  describe("Download Source Support (Lnori, Elsci.one, Both)", () => {
    it("tags each discovered title with its available source and direct source URLs", async () => {
      const res = await getDiscoverNovels(
        { tab: "trending" },
        { cacheDb: tempCacheDb },
      );
      expect(res.novels.length).toBeGreaterThan(0);

      let foundLnoriOnly = false;
      let foundElscioneOnly = false;
      let foundBoth = false;

      for (const n of res.novels) {
        expect(["lnori", "elscione", "both"]).toContain(n.source);
        if (n.source === "lnori") {
          foundLnoriOnly = true;
          expect(n.sourceUrls.lnori).toBeDefined();
          expect(n.sourceUrls.lnori).toContain("lnori.com");
          expect(n.sourceUrls.elscione).toBeUndefined();
        } else if (n.source === "elscione") {
          foundElscioneOnly = true;
          expect(n.sourceUrls.elscione).toBeDefined();
          expect(
            n.sourceUrls.elscione?.includes("server.elscione.com") ||
              n.sourceUrls.elscione?.includes("server.elsci.one"),
          ).toBe(true);
          expect(n.sourceUrls.lnori).toBeUndefined();
        } else if (n.source === "both") {
          foundBoth = true;
          expect(n.sourceUrls.lnori).toBeDefined();
          expect(n.sourceUrls.elscione).toBeDefined();
          expect(n.sourceUrls.lnori).toContain("lnori.com");
          expect(
            n.sourceUrls.elscione?.includes("server.elscione.com") ||
              n.sourceUrls.elscione?.includes("server.elsci.one"),
          ).toBe(true);
        }
      }

      expect(foundLnoriOnly).toBe(true);
      expect(foundElscioneOnly).toBe(true);
      expect(foundBoth).toBe(true);
    });

    it("filters results by source (all, lnori, elscione)", async () => {
      const allRes = await getDiscoverNovels(
        { source: "all" },
        { cacheDb: tempCacheDb },
      );
      const lnoriRes = await getDiscoverNovels(
        { source: "lnori" },
        { cacheDb: tempCacheDb },
      );
      const elscioneRes = await getDiscoverNovels(
        { source: "elscione" },
        { cacheDb: tempCacheDb },
      );

      expect(allRes.novels.length).toBeGreaterThanOrEqual(lnoriRes.novels.length);
      expect(allRes.novels.length).toBeGreaterThanOrEqual(elscioneRes.novels.length);

      // All novels in lnoriRes must have lnori download url (source === 'lnori' || source === 'both')
      for (const n of lnoriRes.novels) {
        expect(n.source === "lnori" || n.source === "both").toBe(true);
        expect(n.sourceUrls.lnori).toBeDefined();
      }

      // All novels in elscioneRes must have elscione download url (source === 'elscione' || source === 'both')
      for (const n of elscioneRes.novels) {
        expect(n.source === "elscione" || n.source === "both").toBe(true);
        expect(n.sourceUrls.elscione).toBeDefined();
      }
    });
  });

  describe("Genre / Tag Filtering", () => {
    it("filters novels by genre case-insensitively", async () => {
      const fantasyRes = await getDiscoverNovels(
        { genre: "Fantasy" },
        { cacheDb: tempCacheDb },
      );
      expect(fantasyRes.novels.length).toBeGreaterThan(0);
      for (const n of fantasyRes.novels) {
        expect(
          n.genres.some((g) => g.toLowerCase() === "fantasy"),
        ).toBe(true);
      }

      const romanceLowerRes = await getDiscoverNovels(
        { genre: "romance" },
        { cacheDb: tempCacheDb },
      );
      expect(romanceLowerRes.novels.length).toBeGreaterThan(0);
      for (const n of romanceLowerRes.novels) {
        expect(
          n.genres.some((g) => g.toLowerCase() === "romance"),
        ).toBe(true);
      }
    });

    it("returns available genres list covering all genres in the feed", async () => {
      const res = await getDiscoverNovels({}, { cacheDb: tempCacheDb });
      expect(Array.isArray(res.genres)).toBe(true);
      expect(res.genres.length).toBeGreaterThan(0);
      expect(res.genres).toContain("Fantasy");
    });
  });

  describe("Calibre Library Cross-Referencing", () => {
    it("accurately detects owned books and volume counts from Calibre books mock", async () => {
      const mockCalibreBooks = [
        {
          id: 101,
          title: "Ascendance of a Bookworm: Part 1 Volume 1",
          series: "Ascendance of a Bookworm",
          series_index: 1,
        },
        {
          id: 102,
          title: "Ascendance of a Bookworm: Part 1 Volume 2",
          series: "Ascendance of a Bookworm",
          series_index: 2,
        },
        {
          id: 103,
          title: "Classroom of the Elite: Volume 1",
          series: "Classroom of the Elite",
          series_index: 1,
        },
      ];

      const res = await getDiscoverNovels(
        { tab: "trending" },
        { cacheDb: tempCacheDb, getCalibreBooks: () => mockCalibreBooks },
      );

      const bookworm = res.novels.find((n) => n.id === "ascendance-of-a-bookworm");
      expect(bookworm).toBeDefined();
      expect(bookworm?.inLibrary).toBe(true);
      expect(bookworm?.existingVolumes).toBe(2);

      const cote = res.novels.find((n) => n.id === "classroom-of-the-elite");
      expect(cote).toBeDefined();
      expect(cote?.inLibrary).toBe(true);
      expect(cote?.existingVolumes).toBe(1);

      const overlord = res.novels.find((n) => n.id === "overlord");
      expect(overlord).toBeDefined();
      expect(overlord?.inLibrary).toBe(false);
      expect(overlord?.existingVolumes).toBe(0);
    });

    it("filters by status=available and status=in_library correctly", async () => {
      const mockCalibreBooks = [
        {
          id: 101,
          title: "Ascendance of a Bookworm: Part 1 Volume 1",
          series: "Ascendance of a Bookworm",
          series_index: 1,
        },
      ];

      const inLibraryRes = await getDiscoverNovels(
        { status: "in_library" },
        { cacheDb: tempCacheDb, getCalibreBooks: () => mockCalibreBooks },
      );
      expect(inLibraryRes.novels.length).toBeGreaterThan(0);
      for (const n of inLibraryRes.novels) {
        expect(n.inLibrary).toBe(true);
        expect(n.existingVolumes).toBeGreaterThan(0);
      }

      const availableRes = await getDiscoverNovels(
        { status: "available" },
        { cacheDb: tempCacheDb, getCalibreBooks: () => mockCalibreBooks },
      );
      expect(availableRes.novels.length).toBeGreaterThan(0);
      for (const n of availableRes.novels) {
        expect(n.inLibrary).toBe(false);
        expect(n.existingVolumes).toBe(0);
      }
    });
  });

  describe("Keyword Search & Sorting", () => {
    it("searches across English title, Romaji title, and synopsis", async () => {
      // English title search
      const resEnglish = await getDiscoverNovels(
        { q: "Slime" },
        { cacheDb: tempCacheDb },
      );
      expect(resEnglish.novels.length).toBeGreaterThan(0);
      expect(
        resEnglish.novels.some((n) => n.title.includes("Slime")),
      ).toBe(true);

      // Romaji title search
      const resRomaji = await getDiscoverNovels(
        { q: "Honzuki" },
        { cacheDb: tempCacheDb },
      );
      expect(resRomaji.novels.length).toBeGreaterThan(0);
      expect(
        resRomaji.novels.some((n) =>
          n.titleRomaji?.toLowerCase().includes("honzuki"),
        ),
      ).toBe(true);

      // Synopsis search
      const resSynopsis = await getDiscoverNovels(
        { q: "Yggdrasil" },
        { cacheDb: tempCacheDb },
      );
      expect(resSynopsis.novels.length).toBeGreaterThan(0);
      expect(
        resSynopsis.novels.some((n) =>
          n.synopsis.toLowerCase().includes("yggdrasil"),
        ),
      ).toBe(true);
    });

    it("sorts by popularity, score, and newest", async () => {
      // By popularity (descending)
      const resPop = await getDiscoverNovels(
        { sort: "popularity" },
        { cacheDb: tempCacheDb },
      );
      for (let i = 1; i < resPop.novels.length; i++) {
        expect(resPop.novels[i - 1].popularity).toBeGreaterThanOrEqual(
          resPop.novels[i].popularity,
        );
      }

      // By score (descending)
      const resScore = await getDiscoverNovels(
        { sort: "score" },
        { cacheDb: tempCacheDb },
      );
      for (let i = 1; i < resScore.novels.length; i++) {
        expect(resScore.novels[i - 1].score).toBeGreaterThanOrEqual(
          resScore.novels[i].score,
        );
      }

      // By newest (releaseDate descending)
      const resNewest = await getDiscoverNovels(
        { sort: "newest" },
        { cacheDb: tempCacheDb },
      );
      for (let i = 1; i < resNewest.novels.length; i++) {
        expect(
          resNewest.novels[i - 1].releaseDate >= resNewest.novels[i].releaseDate,
        ).toBe(true);
      }
    });

    it("supports pagination with correct page, pageSize, and totalPages", async () => {
      const page1 = await getDiscoverNovels(
        { page: 1, pageSize: 5 },
        { cacheDb: tempCacheDb },
      );
      expect(page1.novels.length).toBe(5);
      expect(page1.page).toBe(1);
      expect(page1.pageSize).toBe(5);
      expect(page1.totalPages).toBeGreaterThan(1);

      const page2 = await getDiscoverNovels(
        { page: 2, pageSize: 5 },
        { cacheDb: tempCacheDb },
      );
      expect(page2.novels.length).toBe(5);
      expect(page2.page).toBe(2);

      // Verify no duplicate novel IDs between page 1 and page 2
      const page1Ids = new Set(page1.novels.map((n) => n.id));
      for (const novel of page2.novels) {
        expect(page1Ids.has(novel.id)).toBe(false);
      }
    });
  });

  describe("Caching (1-Hour TTL in SQLite cache.db & Memory)", () => {
    it("persists feed in cache and serves cached items", async () => {
      const testNovel: DiscoveredNovel = {
        id: "test-novel-1",
        title: "Test Cached Novel",
        coverUrl: "https://example.com/cover.jpg",
        synopsis: "Test synopsis",
        genres: ["Fantasy"],
        score: 95,
        popularity: 100000,
        releaseDate: "2024-01-01",
        volumeCount: 5,
        source: "both",
        sourceUrls: {
          lnori: "https://lnori.com/series/999/test",
          elscione: "https://server.elscione.com/Test/",
        },
        inLibrary: false,
        existingVolumes: 0,
      };

      setCachedFeed("feed:trending", [testNovel], { cacheDb: tempCacheDb });
      const cached = getCachedFeed("feed:trending", { cacheDb: tempCacheDb });
      expect(cached).not.toBeNull();
      expect(cached?.length).toBe(1);
      expect(cached?.[0].id).toBe("test-novel-1");
    });
  });

  describe("Direct Queue Ingestion (enqueueDiscoverIngest)", () => {
    it("enqueues Lnori URL and returns numeric jobId", async () => {
      const res = await enqueueDiscoverIngest(
        "https://lnori.com/series/4239/ascendance-of-a-bookworm",
        "lnori",
      );
      expect(res.success).toBe(true);
      expect(typeof res.jobId).toBe("number");
      expect(res.jobId).toBeGreaterThan(0);
      expect(res.message).toContain("Lnori");
    });

    it("enqueues Elsci.one URL and returns numeric jobId", async () => {
      const res = await enqueueDiscoverIngest(
        "https://server.elscione.com/Officially%20Translated%20Light%20Novels/DanMachi/",
        "elscione",
      );
      expect(res.success).toBe(true);
      expect(typeof res.jobId).toBe("number");
      expect(res.jobId).toBeGreaterThan(0);
      expect(res.message).toContain("Elsci.one");
    });

    it("rejects invalid or off-domain URLs", async () => {
      await expect(
        enqueueDiscoverIngest("https://evil.com/book.epub", "lnori"),
      ).rejects.toThrow("Target URL is not a valid lnori.com URL");

      await expect(
        enqueueDiscoverIngest("https://evil.com/book.epub", "elscione"),
      ).rejects.toThrow("Target URL is not a valid server.elscione.com");
    });
  });

  describe("REST API Endpoints Integration (uploader/server.ts)", () => {
    const localServer = { requestIP: () => ({ address: "127.0.0.1" }) } as any;

    it("GET /api/discover/novels returns trending novels by default", async () => {
      const req = new Request("http://127.0.0.1:8086/api/discover/novels");
      const res = await handleRequest(req);

      expect(res.status).toBe(200);
      const data = (await res.json()) as any;
      expect(data.success).toBe(true);
      expect(data.tab).toBe("trending");
      expect(Array.isArray(data.novels)).toBe(true);
      expect(data.novels.length).toBeGreaterThan(0);
      expect(Array.isArray(data.genres)).toBe(true);
      expect(Array.isArray(data.sources)).toBe(true);
      expect(data.sources).toEqual(["all", "lnori", "elscione"]);
    });

    it("GET /api/discover/novels?tab=new returns new releases", async () => {
      const req = new Request("http://127.0.0.1:8086/api/discover/novels?tab=new");
      const res = await handleRequest(req);

      expect(res.status).toBe(200);
      const data = (await res.json()) as any;
      expect(data.success).toBe(true);
      expect(data.tab).toBe("new");
      expect(data.novels.length).toBeGreaterThan(0);
    });

    it("GET /api/discover/novels supports source, genre, q, and sort query parameters", async () => {
      const req = new Request(
        "http://127.0.0.1:8086/api/discover/novels?tab=trending&source=lnori&genre=Fantasy&sort=popularity&page=1&pageSize=10",
      );
      const res = await handleRequest(req);

      expect(res.status).toBe(200);
      const data = (await res.json()) as any;
      expect(data.success).toBe(true);
      expect(data.tab).toBe("trending");
      for (const novel of data.novels) {
        expect(novel.source === "lnori" || novel.source === "both").toBe(true);
        expect(
          novel.genres.some((g: string) => g.toLowerCase() === "fantasy"),
        ).toBe(true);
      }
    });

    it("POST /api/discover/ingest queues Lnori series with numeric jobId", async () => {
      let enqueuedUrl: string | null = null;
      setServerDependenciesForTest({
        enqueueLnoriJob: (url: string) => {
          enqueuedUrl = url;
          return { jobId: 12345, runId: "test-run-12345" };
        },
      });

      const req = new Request("http://127.0.0.1:8086/api/discover/ingest", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          url: "https://lnori.com/series/4239/ascendance-of-a-bookworm",
          source: "lnori",
        }),
      });

      const res = await handleRequest(req, localServer);
      expect(res.status).toBe(200);
      const data = (await res.json()) as any;
      expect(data.success).toBe(true);
      expect(data.jobId).toBe(12345);
      expect(typeof data.jobId).toBe("number");
      expect(enqueuedUrl).toBe("https://lnori.com/series/4239/ascendance-of-a-bookworm");
    });

    it("POST /api/discover/ingest queues Elsci.one series with numeric jobId", async () => {
      let enqueuedUrl: string | null = null;
      setServerDependenciesForTest({
        enqueueElscioneJob: (url: string) => {
          enqueuedUrl = url;
          return { jobId: 67890, runId: "test-run-67890" };
        },
      });

      const req = new Request("http://127.0.0.1:8086/api/discover/ingest", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          url: "https://server.elscione.com/Officially%20Translated%20Light%20Novels/DanMachi/",
          source: "elscione",
        }),
      });

      const res = await handleRequest(req, localServer);
      expect(res.status).toBe(200);
      const data = (await res.json()) as any;
      expect(data.success).toBe(true);
      expect(data.jobId).toBe(67890);
      expect(typeof data.jobId).toBe("number");
      expect(enqueuedUrl).toBe(
        "https://server.elscione.com/Officially%20Translated%20Light%20Novels/DanMachi/",
      );
    });

    it("POST /api/discover/ingest rejects invalid payload or URL with 400", async () => {
      // Missing body
      const reqEmpty = new Request("http://127.0.0.1:8086/api/discover/ingest", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({}),
      });
      const resEmpty = await handleRequest(reqEmpty, localServer);
      expect(resEmpty.status).toBe(400);

      // Invalid source
      const reqBadSource = new Request("http://127.0.0.1:8086/api/discover/ingest", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          url: "https://lnori.com/series/123/test",
          source: "invalid_source",
        }),
      });
      const resBadSource = await handleRequest(reqBadSource, localServer);
      expect(resBadSource.status).toBe(400);

      // Off-domain URL
      const reqOffDomain = new Request("http://127.0.0.1:8086/api/discover/ingest", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          url: "https://malicious-site.com/novel",
          source: "lnori",
        }),
      });
      const resOffDomain = await handleRequest(reqOffDomain, localServer);
      expect(resOffDomain.status).toBe(400);
    });
  });
});
