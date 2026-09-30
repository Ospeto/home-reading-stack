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
  isSynopsisInsufficient,
  synthesizeEngagingSynopsis,
  cleanSynopsisText,
  stripEmojis,
  resolveFallbackSynopsis,
  ensureAllNovelsHaveSynopses,
  findRealElscioneFolder,
  findRealLnoriSeries,
  resolveRealDownloadSources,
  assignPrimarySource,
  REAL_ELSCIONE_FOLDERS,
  REAL_LNORI_SERIES,
  SEED_TRENDING_NOVELS,
  SEED_NEW_NOVELS,
  canonicalTitleKey,
  sanitizeTitleForFolderMatch,
  deduplicateDiscoverNovels,
  KNOWN_TITLE_TO_AUTHOR,
  type DiscoveredNovel,
} from "./discover";
import {
  handleRequest,
  setServerDependenciesForTest,
  resetServerDependenciesForTest,
  resetActiveLnoriStateForTest,
  enqueueLnoriJob,
  enqueueElscioneJob,
  getDiscoverJobProgress,
  registerDiscoverJob,
} from "./server";

describe("Light Novel Discovery Engine (uploader/discover.ts)", () => {
  let tempCacheDb: Database;
  const localServer = { requestIP: () => ({ address: "127.0.0.1" }) } as any;

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
        author: "Test Author",
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

      setCachedFeed("v2:feed:trending", [testNovel], { cacheDb: tempCacheDb });
      const cached = getCachedFeed("v2:feed:trending", { cacheDb: tempCacheDb });
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

    it("POST /api/discover/ingest queues Lnori series with numeric jobId and runId", async () => {
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
      expect(data.runId).toBeDefined();
      expect(typeof data.runId).toBe("string");
      expect(data.message).toBeDefined();
      expect(typeof data.message).toBe("string");
      expect(/\p{Extended_Pictographic}/u.test(data.message)).toBe(false);
      expect(enqueuedUrl).toBe("https://lnori.com/series/4239/ascendance-of-a-bookworm");
    });

    it("POST /api/discover/ingest queues Elsci.one series with numeric jobId and runId", async () => {
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
      expect(data.runId).toBeDefined();
      expect(typeof data.runId).toBe("string");
      expect(data.message).toBeDefined();
      expect(typeof data.message).toBe("string");
      expect(/\p{Extended_Pictographic}/u.test(data.message)).toBe(false);
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

  describe("100% Synopsis Completeness & Quality Guarantee", () => {
    it("guarantees 100% of discovered light novels across trending and new feeds have synopsis length >= 30", async () => {
      const trendingRes = await getDiscoverNovels({ tab: "trending" }, { cacheDb: tempCacheDb });
      const newRes = await getDiscoverNovels({ tab: "new" }, { cacheDb: tempCacheDb });

      expect(trendingRes.novels.length).toBeGreaterThan(0);
      expect(newRes.novels.length).toBeGreaterThan(0);

      for (const novel of trendingRes.novels) {
        expect(novel.synopsis).toBeDefined();
        expect(typeof novel.synopsis).toBe("string");
        expect(novel.synopsis.trim().length).toBeGreaterThanOrEqual(30);
        expect(isSynopsisInsufficient(novel.synopsis)).toBe(false);
      }

      for (const novel of newRes.novels) {
        expect(novel.synopsis).toBeDefined();
        expect(typeof novel.synopsis).toBe("string");
        expect(novel.synopsis.trim().length).toBeGreaterThanOrEqual(30);
        expect(isSynopsisInsufficient(novel.synopsis)).toBe(false);
      }
    });

    it("ensures no discovered novel has empty, blank, or placeholder 'No synopsis available' text", async () => {
      const allRes = await getDiscoverNovels({}, { cacheDb: tempCacheDb });
      for (const novel of allRes.novels) {
        const lower = novel.synopsis.toLowerCase();
        expect(lower).not.toBe("no synopsis available");
        expect(lower).not.toBe("no synopsis available.");
        expect(lower).not.toBe("*no synopsis available.*");
        expect(lower).not.toBe("no summary provided.");
        expect(lower.startsWith("no synopsis")).toBe(false);
      }
    });

    it("enriches items with missing/blank synopses via online/curated fallback or engaging synthesis", async () => {
      const dummyNovel: DiscoveredNovel = {
        id: "test-novel-missing-synopsis",
        title: "Test Novel Reincarnated as a Hero",
        author: "Test Author",
        coverUrl: "https://example.com/cover.jpg",
        synopsis: "",
        genres: ["Fantasy", "Isekai"],
        score: 85,
        popularity: 10000,
        releaseDate: "2024-01-01",
        volumeCount: 1,
        source: "elscione",
        sourceUrls: { elscione: "https://server.elscione.com/novel" },
        inLibrary: false,
        existingVolumes: 0,
      };

      const [enriched] = await ensureAllNovelsHaveSynopses([dummyNovel]);
      expect(enriched.synopsis).toBeDefined();
      expect(enriched.synopsis.length).toBeGreaterThanOrEqual(30);
      expect(enriched.synopsis).toContain("Test Novel Reincarnated as a Hero");
      expect(isSynopsisInsufficient(enriched.synopsis)).toBe(false);
    });

    it("uses custom fallbackQuery dependency to resolve missing synopsis", async () => {
      const dummyNovel: DiscoveredNovel = {
        id: "test-custom-fallback",
        title: "Mysterious Artifact Chronicles",
        author: "Test Author",
        coverUrl: "https://example.com/cover.jpg",
        synopsis: "Short",
        genres: ["Mystery", "Adventure"],
        score: 80,
        popularity: 5000,
        releaseDate: "2024-01-01",
        volumeCount: 1,
        source: "lnori",
        sourceUrls: { lnori: "https://lnori.com/series/1/novel" },
        inLibrary: false,
        existingVolumes: 0,
      };

      const [enriched] = await ensureAllNovelsHaveSynopses([dummyNovel], {
        fallbackQuery: async (title) =>
          `A gripping chronicles of ${title} uncovering ancient artifacts and resolving forgotten secrets across continents.`,
      });

      expect(enriched.synopsis).toContain("ancient artifacts");
      expect(enriched.synopsis.length).toBeGreaterThanOrEqual(30);
    });
  });

  describe("Live Job Progress Tracking (GET /api/discover/progress/:jobId & /job/:jobId)", () => {
    it("returns detailed live progress for in-flight job querying activeLnoriState", async () => {
      // Register and start a simulated job
      const testJobId = 987654;
      const testRunId = "elscione-987654-test";
      registerDiscoverJob(
        testJobId,
        testRunId,
        "elscione",
        "https://server.elscione.com/Officially%20Translated%20Light%20Novels/DanMachi/",
      );

      // Inject server dependency mock to simulate downloading progress
      setServerDependenciesForTest({
        getDiscoverProgress: (id) => {
          if (Number(id) === testJobId) {
            return {
              success: true,
              jobId: testJobId,
              phase: "downloading",
              percent: 60,
              currentVolume: "DanMachi: Volume 6",
              volumesCompleted: 6,
              totalVolumes: 10,
            };
          }
          return null;
        },
      });

      const req = new Request(`http://127.0.0.1:8086/api/discover/progress/${testJobId}`);
      const res = await handleRequest(req, localServer);

      expect(res.status).toBe(200);
      const data = (await res.json()) as any;
      expect(data.success).toBe(true);
      expect(data.jobId).toBe(testJobId);
      expect(data.phase).toBe("downloading");
      expect(data.percent).toBe(60);
      expect(data.currentVolume).toBe("DanMachi: Volume 6");
      expect(data.volumesCompleted).toBe(6);
      expect(data.totalVolumes).toBe(10);
      expect(/\p{Extended_Pictographic}/u.test(JSON.stringify(data))).toBe(false);
    });

    it("supports GET /api/discover/job/:jobId as an exact alias for progress", async () => {
      const testJobId = 112233;
      setServerDependenciesForTest({
        getDiscoverProgress: (id) => {
          if (Number(id) === testJobId) {
            return {
              success: true,
              jobId: testJobId,
              phase: "complete",
              percent: 100,
              currentVolume: "Ascendance of a Bookworm: Volume 33",
              volumesCompleted: 33,
              totalVolumes: 33,
            };
          }
          return null;
        },
      });

      const req = new Request(`http://127.0.0.1:8086/api/discover/job/${testJobId}`);
      const res = await handleRequest(req, localServer);

      expect(res.status).toBe(200);
      const data = (await res.json()) as any;
      expect(data.success).toBe(true);
      expect(data.jobId).toBe(testJobId);
      expect(data.phase).toBe("complete");
      expect(data.percent).toBe(100);
    });

    it("returns 404 for unknown job ID", async () => {
      const req = new Request("http://127.0.0.1:8086/api/discover/progress/999999999");
      const res = await handleRequest(req, localServer);
      expect(res.status).toBe(404);
      const data = (await res.json()) as any;
      expect(data.success).toBe(false);
      expect(data.error).toBe("Job not found");
    });

    it("verifies live progress states: queued, downloading, processing, complete, error", async () => {
      const phases = ["queued", "downloading", "processing", "complete", "error"] as const;
      for (const phase of phases) {
        const jobId = 5000 + phases.indexOf(phase);
        setServerDependenciesForTest({
          getDiscoverProgress: (id) => ({
            success: true,
            jobId: Number(id),
            phase,
            percent: phase === "complete" ? 100 : phase === "queued" ? 0 : 50,
            volumesCompleted: phase === "complete" ? 5 : 2,
            totalVolumes: 5,
            error: phase === "error" ? "Simulated network failure" : undefined,
          }),
        });

        const req = new Request(`http://127.0.0.1:8086/api/discover/progress/${jobId}`);
        const res = await handleRequest(req, localServer);
        expect(res.status).toBe(200);
        const data = (await res.json()) as any;
        expect(data.phase).toBe(phase);
        if (phase === "error") {
          expect(data.error).toBeDefined();
        }
      }
    });
  });

  describe("Real Download Sources Guarantee & Elimination of Synthetic Fabrication", () => {
    it("rejects non-existent titles (such as Sayonara Lara) and returns null", () => {
      const match = resolveRealDownloadSources("Sayonara Lara");
      expect(match).toBeNull();

      const elFolder = findRealElscioneFolder("Sayonara Lara");
      expect(elFolder).toBeNull();

      const lnSeries = findRealLnoriSeries("Sayonara Lara");
      expect(lnSeries).toBeNull();
    });

    it("rejects partial fragments or mismatched spin-offs (e.g. Full Metal, Overlord of Darkness)", () => {
      // Shorter fragments or extended false spin-offs must not false-positive match
      expect(resolveRealDownloadSources("Full Metal")).toBeNull();
      expect(resolveRealDownloadSources("Overlord of Darkness")).toBeNull();
      expect(resolveRealDownloadSources("DanMachi Novel Edition Extra Special")).toBeNull();
    });

    it("anchors real titles to verified Elscione folders and Lnori series without synthetic fabrication", () => {
      // Overlord: real on both
      const overlord = resolveRealDownloadSources("Overlord");
      expect(overlord).not.toBeNull();
      expect(overlord?.source).toBe("both");
      expect(overlord?.primarySource).toBe("elscione");
      expect(overlord?.primaryUrl).toBe(
        "https://server.elscione.com/Officially%20Translated%20Light%20Novels/Overlord/",
      );
      expect(overlord?.sourceUrls.elscione).toBe(
        "https://server.elscione.com/Officially%20Translated%20Light%20Novels/Overlord/",
      );
      expect(overlord?.sourceUrls.lnori).toBe(
        "https://lnori.com/series/2405/overlord",
      );

      // The Angel Next Door Spoils Me Rotten: real on both
      const angel = resolveRealDownloadSources("The Angel Next Door Spoils Me Rotten");
      expect(angel).not.toBeNull();
      expect(angel?.source).toBe("both");
      expect(angel?.primarySource).toBe("elscione");
      expect(angel?.sourceUrls.elscione).toBe(
        "https://server.elscione.com/Officially%20Translated%20Light%20Novels/The%20Angel%20Next%20Door%20Spoils%20Me%20Rotten/",
      );
      expect(angel?.sourceUrls.lnori).toBe(
        "https://lnori.com/series/9601/the-angel-next-door-spoils-me-rotten",
      );

      // 86--EIGHTY-SIX: real on both (Elscione folder '86')
      const eightySix = resolveRealDownloadSources("86--EIGHTY-SIX");
      expect(eightySix).not.toBeNull();
      expect(eightySix?.source).toBe("both");
      expect(eightySix?.primarySource).toBe("elscione");
      expect(eightySix?.sourceUrls.elscione).toBe(
        "https://server.elscione.com/Officially%20Translated%20Light%20Novels/86/",
      );
      expect(eightySix?.sourceUrls.lnori).toBe(
        "https://lnori.com/series/4808/86-eighty-six",
      );
    });

    it("filters out unverified AniList titles and only includes novels backed by real sources", async () => {
      // Mock an online AniList response containing Sayonara Lara alongside Overlord and Monogatari
      const mockAniListMedia = [
        {
          id: 170942,
          title: { english: "Sayonara Lara", romaji: "Sayonara Lara" },
          coverImage: { large: "https://example.com/lara.jpg" },
          description: "A mermaid reincarnates in modern Tokyo.",
          genres: ["Drama", "Supernatural"],
          averageScore: 78,
          popularity: 5000,
          startDate: { year: 2024, month: 3, day: 1 },
          volumes: 2,
        },
        {
          id: 2405,
          title: { english: "Overlord", romaji: "Overlord" },
          coverImage: { large: "https://example.com/overlord.jpg" },
          description: "A veteran player stays logged into a shutdown MMORPG.",
          genres: ["Fantasy", "Action"],
          averageScore: 87,
          popularity: 89000,
          startDate: { year: 2012, month: 7, day: 30 },
          volumes: 16,
        },
      ];

      const mockFetch = async (url: string, _init?: RequestInit): Promise<Response> => {
        if (url.includes("graphql.anilist.co")) {
          return new Response(
            JSON.stringify({ data: { Page: { media: mockAniListMedia } } }),
            { status: 200, headers: { "Content-Type": "application/json" } },
          );
        }
        return new Response("{}", { status: 404 });
      };

      const feed = await fetchDiscoverFeed("trending", {
        fetch: mockFetch,
        cacheDb: tempCacheDb,
        enableOnline: true,
      });

      // Sayonara Lara must be completely excluded because it does not exist on Elscione or Lnori
      const lara = feed.find((n) => n.title.toLowerCase().includes("lara"));
      expect(lara).toBeUndefined();

      // Overlord must be included and backed by real Elscione & Lnori URLs
      const overlord = feed.find((n) => n.title === "Overlord");
      expect(overlord).toBeDefined();
      expect(overlord?.source).toBe("both");
      expect(overlord?.primarySource).toBe("elscione");
      expect(overlord?.sourceUrls.elscione).toBe(
        "https://server.elscione.com/Officially%20Translated%20Light%20Novels/Overlord/",
      );
      expect(overlord?.sourceUrls.lnori).toBe(
        "https://lnori.com/series/2405/overlord",
      );
    });

    it("indexes directly from the 880+ Lnori series and 1200+ Elscione folders", () => {
      expect(REAL_ELSCIONE_FOLDERS.length).toBeGreaterThanOrEqual(1200);
      expect(REAL_LNORI_SERIES.length).toBeGreaterThanOrEqual(880);
      expect(REAL_ELSCIONE_FOLDERS).toContain("Overlord");
      expect(REAL_ELSCIONE_FOLDERS).toContain("Classroom of the Elite");
      expect(REAL_LNORI_SERIES.some((s) => s.slug === "overlord")).toBe(true);
      expect(REAL_LNORI_SERIES.some((s) => s.slug === "classroom-of-the-elite")).toBe(true);
    });
  });

  describe("Source Preference (Elscione over Lnori when both available)", () => {
    it("prefers Elscione as primarySource and primaryUrl when novel source is both", async () => {
      const res = await getDiscoverNovels({ tab: "trending" }, { cacheDb: tempCacheDb });
      const bothNovels = res.novels.filter((n) => n.source === "both");
      expect(bothNovels.length).toBeGreaterThan(0);

      for (const novel of bothNovels) {
        expect(novel.primarySource).toBe("elscione");
        expect(novel.primaryUrl).toBe(novel.sourceUrls.elscione);
      }
    });

    it("assignPrimarySource guarantees Elscione as primary whenever both source URLs exist", () => {
      const sampleNovel: DiscoveredNovel = {
        id: "sample-novel",
        title: "Sample Novel",
        author: "Test Author",
        coverUrl: "https://example.com/cover.jpg",
        synopsis: "A complete engaging synopsis with more than 30 characters.",
        genres: ["Fantasy"],
        score: 85,
        popularity: 10000,
        releaseDate: "2024-01-01",
        volumeCount: 5,
        source: "both",
        sourceUrls: {
          lnori: "https://lnori.com/series/123/sample-novel",
          elscione: "https://server.elscione.com/Officially%20Translated%20Light%20Novels/Sample%20Novel/",
        },
        inLibrary: false,
        existingVolumes: 0,
      };

      const result = assignPrimarySource(sampleNovel);
      expect(result.source).toBe("both");
      expect(result.primarySource).toBe("elscione");
      expect(result.primaryUrl).toBe(
        "https://server.elscione.com/Officially%20Translated%20Light%20Novels/Sample%20Novel/",
      );
    });
  });

  describe("Strict Zero Emojis Compliance", () => {
    it("verifies that API responses across discover endpoints contain zero emojis", async () => {
      // 1. Check /api/discover/novels
      const reqNovels = new Request("http://127.0.0.1:8086/api/discover/novels");
      const resNovels = await handleRequest(reqNovels);
      const textNovels = await resNovels.text();
      expect(/\p{Extended_Pictographic}/u.test(textNovels)).toBe(false);

      // 2. Check /api/discover/ingest
      setServerDependenciesForTest({
        enqueueElscioneJob: () => ({ jobId: 77777, runId: "elscione-77777" }),
      });
      const reqIngest = new Request("http://127.0.0.1:8086/api/discover/ingest", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          url: "https://server.elscione.com/Officially%20Translated%20Light%20Novels/DanMachi/",
          source: "elscione",
        }),
      });
      const resIngest = await handleRequest(reqIngest, localServer);
      const textIngest = await resIngest.text();
      expect(/\p{Extended_Pictographic}/u.test(textIngest)).toBe(false);
    });

    it("verifies that stripEmojis removes all emojis and pictographs", () => {
      const input = "⏳ Ingesting volume 1... 🚀 ✨ 📚 [Volume 1/5] Done! 🎉";
      const stripped = stripEmojis(input);
      expect(/\p{Extended_Pictographic}/u.test(stripped)).toBe(false);
      expect(stripped).toBe("Ingesting volume 1... [Volume 1/5] Done!");
    });
  });


  describe("Discover UI Contract Invariants (uploader/index.html)", () => {
    const htmlPath = path.join((import.meta as any).dir, "index.html");
    const html = fs.readFileSync(htmlPath, "utf8");

    it("verifies zero emojis across the entire index.html", () => {
      const emojiRegex = /(\p{Extended_Pictographic}|\p{Emoji_Presentation})/gu;
      const matches: string[] = [];
      for (const m of html.matchAll(emojiRegex)) {
        if (!/[0-9#*]/.test(m[0])) {
          matches.push(m[0]);
        }
      }
      expect(matches).toEqual([]);
    });

    it("verifies live download progress polling and Apple-style progress track in index.html", () => {
      // Button transitions immediately
      expect(html).toContain("Downloading...");
      expect(html).toContain("Downloading Vol");
      // Polls /api/discover/progress/:jobId
      expect(html).toContain("pollDiscoverIngestProgress");
      expect(html).toContain("/api/discover/progress/");
      expect(html).toContain("1500");
      // Track with percentage
      expect(html).toContain("cardProgressContainer-");
      expect(html).toContain("cardProgressBar-");
      expect(html).toContain("cardProgressPct-");
      expect(html).toContain("discoverModalProgressContainer");
      expect(html).toContain("discoverModalProgressBar");
      expect(html).toContain("discoverModalProgressPct");
      // Badge update on completion
      expect(html).toContain("In Library (");
      expect(html).toContain("Downloaded");
    });

    it("verifies complete synopsis readability and on-the-fly fetching in discoverModal", () => {
      expect(html).toContain('id="discoverModalSynopsis"');
      expect(html).toContain("text-sm leading-relaxed text-zinc-300");
      expect(html).toContain("overflow-y-auto");
      expect(html).toContain("renderSynopsisSkeleton");
      expect(html).toContain("/api/discover/novel/");
    });

    it("verifies Elscione preference for novel source ingestion", () => {
      expect(html).toContain("getPrimaryNovelSource");
      expect(html).toContain("ALWAYS prefer Elscione over Lnori when both are available");
      expect(html).toContain("item.sourceUrls?.elscione");
    });

    it("verifies error formatting replaces [path] with human-readable error text", () => {
      expect(html).toContain("formatCleanErrorMessage");
      expect(html).toContain(".replace(/\\[path\\]/g, 'file')");
    });

    it("verifies modal sources layout uses responsive flex-wrap, proper spacing, and shrink-0 buttons", () => {
      // Clean flexbox / grid layout with flex-wrap gap-2 items-center justify-between p-3
      expect(html).toContain("flex flex-wrap gap-2 items-center justify-between p-3");
      // Action buttons have shrink-0 so they never overlap or truncate text
      expect(html).toContain('class="underline text-zinc-400 hover:text-white flex items-center gap-1 text-[11px] shrink-0"');
      expect(html).toContain("cursor-pointer active:scale-[0.96] shrink-0");
      expect(html).toContain("shrink-0 ml-auto sm:ml-0");
    });

    it("verifies author display uses real author with Author Unknown fallback, never 'Light Novel'", () => {
      // In cards
      expect(html).toContain("item.author || 'Author Unknown'");
      expect(html).not.toContain("const authorName = item.author || 'Light Novel'");
      // In modal
      expect(html).toContain("`By ${item.author || 'Author Unknown'}`");
    });

    it("verifies robust cover image onerror fallback with dark SVG placeholder", () => {
      // Functions defined
      expect(html).toContain("function getCoverPlaceholderDataUri");
      expect(html).toContain("function handleCoverError");
      expect(html).toContain("window.handleCoverError = handleCoverError;");
      expect(html).toContain("window.getCoverPlaceholderDataUri = getCoverPlaceholderDataUri;");

      // Card cover onerror
      expect(html).toContain('onerror="handleCoverError(this)"');
      expect(html).toContain('data-title="${escapeHtml(item.title)}"');

      // Modal cover onerror
      expect(html).toContain('id="discoverModalCover" src="" alt="Cover" class="w-full h-full object-cover" onerror="handleCoverError(this)"');

      // SVG placeholder styling
      expect(html).toContain("viewBox=\"0 0 200 300\"");
      expect(html).toContain("LIGHT NOVEL");
      expect(html).toContain("data:image/svg+xml;charset=utf-8,");
    });

    it("verifies clean error banner formatting without [path] or emojis in discover modal", () => {
      expect(html).toContain('id="discoverModalErrorBanner"');
      expect(html).toContain('id="discoverModalErrorText"');
      expect(html).toContain("function showDiscoverModalError");
      expect(html).toContain("function hideDiscoverModalError");
      expect(html).toContain("hideDiscoverModalError()");
    });
  });

  describe("Author Field & Real Author Names Guarantee", () => {
    it("ensures every novel in SEED_TRENDING_NOVELS and SEED_NEW_NOVELS has a real non-empty author", () => {
      const allSeeds = [...SEED_TRENDING_NOVELS, ...SEED_NEW_NOVELS];
      for (const novel of allSeeds) {
        expect(novel.author).toBeDefined();
        expect(typeof novel.author).toBe("string");
        expect(novel.author.trim().length).toBeGreaterThan(0);
        expect(novel.author).not.toBe("Light Novel");
        expect(novel.author).not.toBe("Unknown");
        expect(novel.author).not.toBe("By Light Novel");
      }
    });

    it("verifies accurate real authors for popular light novel series", () => {
      const findAuthor = (titleSub: string) => {
        const allSeeds = [...SEED_TRENDING_NOVELS, ...SEED_NEW_NOVELS];
        const hit = allSeeds.find((n) => n.title.toLowerCase().includes(titleSub.toLowerCase()));
        return hit?.author;
      };

      expect(findAuthor("Bookworm")).toBe("Miya Kazuki");
      expect(findAuthor("Classroom of the Elite")).toBe("Shogo Kinugasa");
      expect(findAuthor("Mushoku Tensei")).toBe("Rifujin na Magonote");
      expect(findAuthor("Overlord")).toBe("Kugane Maruyama");
      expect(findAuthor("Slime")).toBe("Fuse");
      expect(findAuthor("Angel Next Door")).toBe("Saekisan");
      expect(findAuthor("86")).toBe("Asato Asato");
      expect(findAuthor("Apothecary Diaries")).toBe("Natsu Hyuuga");
      expect(findAuthor("Eminence in Shadow")).toBe("Daisuke Aizawa");
      expect(findAuthor("DanMachi")).toBe("Fujino Omori");
      expect(findAuthor("Re:ZERO")).toBe("Tappei Nagatsuki");
      expect(findAuthor("Magical Index")).toBe("Kazuma Kamachi");
      expect(findAuthor("Death Games")).toBe("Yuushi Ukai");
      expect(findAuthor("Stepsister")).toBe("Ghost Mikawa");
      expect(findAuthor("Losing Heroines")).toBe("Takibi Amamori");
      expect(findAuthor("Silent Witch")).toBe("Matsuri Isora");

      // Known map entries
      expect(KNOWN_TITLE_TO_AUTHOR["spice and wolf"]).toBe("Isuna Hasekura");
      expect(KNOWN_TITLE_TO_AUTHOR["worldend"]).toBe("Akira Kareno");
      expect(KNOWN_TITLE_TO_AUTHOR["goblin slayer"]).toBe("Kumo Kagyu");
    });

    it("returns author on all novels in getDiscoverNovels for trending and new feeds", async () => {
      const trendingRes = await getDiscoverNovels({ tab: "trending" }, { cacheDb: tempCacheDb });
      for (const novel of trendingRes.novels) {
        expect(novel.author).toBeDefined();
        expect(novel.author.length).toBeGreaterThan(0);
        expect(novel.author).not.toBe("Light Novel");
        expect(novel.author).not.toBe("By Light Novel");
      }

      const newRes = await getDiscoverNovels({ tab: "new" }, { cacheDb: tempCacheDb });
      for (const novel of newRes.novels) {
        expect(novel.author).toBeDefined();
        expect(novel.author.length).toBeGreaterThan(0);
        expect(novel.author).not.toBe("Light Novel");
        expect(novel.author).not.toBe("By Light Novel");
      }
    });

    it("extracts author from AniList staff edges or nodes and falls back to author metadata", async () => {
      const mockAniListMedia = [
        {
          id: 11111,
          title: { english: "Overlord", romaji: "Overlord" },
          coverImage: { large: "https://s4.anilist.co/overlord.jpg" },
          description: "Overlord summary",
          genres: ["Action", "Fantasy"],
          averageScore: 90,
          popularity: 50000,
          startDate: { year: 2012, month: 7, day: 30 },
          volumes: 16,
          staff: {
            edges: [
              {
                role: "Original Story",
                node: { name: { full: "Kugane Maruyama" } },
              },
            ],
          },
        },
        {
          id: 22222,
          title: { english: "86--EIGHTY-SIX", romaji: "86" },
          coverImage: { large: "https://s4.anilist.co/86.jpg" },
          description: "86 summary",
          genres: ["Sci-Fi"],
          averageScore: 90,
          popularity: 50000,
          startDate: { year: 2017, month: 2, day: 10 },
          volumes: 13,
          staff: {
            nodes: [
              { name: { full: "Asato Asato" } },
            ],
          },
        },
        {
          id: 33333,
          title: { english: "Classroom of the Elite", romaji: "Youkoso Jitsuryoku" },
          coverImage: { large: "https://s4.anilist.co/cote.jpg" },
          description: "COTE summary",
          genres: ["Drama"],
          averageScore: 90,
          popularity: 50000,
          startDate: { year: 2015, month: 5, day: 25 },
          volumes: 28,
          staff: {}, // empty staff -> falls back to KNOWN_TITLE_TO_AUTHOR
        },
      ];

      const mockFetch = async (url: string): Promise<Response> => {
        if (url.includes("graphql.anilist.co")) {
          return new Response(
            JSON.stringify({ data: { Page: { media: mockAniListMedia } } }),
            { status: 200, headers: { "Content-Type": "application/json" } },
          );
        }
        return new Response("{}", { status: 404 });
      };

      const feed = await fetchDiscoverFeed("trending", {
        fetch: mockFetch,
        cacheDb: tempCacheDb,
        enableOnline: true,
      });

      const overlord = feed.find((n) => n.title === "Overlord");
      expect(overlord?.author).toBe("Kugane Maruyama");

      const eightySix = feed.find((n) => n.title.includes("86"));
      expect(eightySix?.author).toBe("Asato Asato");

      const cote = feed.find((n) => n.title.includes("Classroom of the Elite"));
      expect(cote?.author).toBe("Shogo Kinugasa");
    });
  });

  describe("Working Cover CDNs (Elimination of 404 RanobeDB URLs)", () => {
    it("ensures 100% of novels in SEED_NEW_NOVELS have working CDN cover URLs from s4.anilist.co or cdn.lnori.com", () => {
      for (const novel of SEED_NEW_NOVELS) {
        expect(novel.coverUrl).toBeDefined();
        const isAnilist = novel.coverUrl.includes("s4.anilist.co");
        const isLnori = novel.coverUrl.includes("cdn.lnori.com");
        expect(isAnilist || isLnori).toBe(true);
        expect(novel.coverUrl.includes("images.ranobedb.org")).toBe(false);
      }
    });

    it("ensures zero broken RanobeDB URLs exist across both SEED_TRENDING_NOVELS and SEED_NEW_NOVELS", () => {
      const allSeeds = [...SEED_TRENDING_NOVELS, ...SEED_NEW_NOVELS];
      for (const novel of allSeeds) {
        expect(novel.coverUrl.includes("images.ranobedb.org")).toBe(false);
        const isAnilist = novel.coverUrl.includes("s4.anilist.co");
        const isLnori = novel.coverUrl.includes("cdn.lnori.com");
        expect(isAnilist || isLnori).toBe(true);
      }
    });
  });

  describe("Strict Title Deduplication & Cross-Feed Separation", () => {
    it("normalizes ampersand (&) to 'and' so variants like 'Spice & Wolf' match 'Spice and Wolf'", () => {
      const norm1 = normalizeTitleForMatch("Spice & Wolf");
      const norm2 = normalizeTitleForMatch("Spice and Wolf");
      expect(norm1).toBe("spice and wolf");
      expect(norm2).toBe("spice and wolf");
      expect(norm1).toBe(norm2);
    });

    it("deduplicates novels within a feed using deduplicateDiscoverNovels", () => {
      const duplicateList: DiscoveredNovel[] = [
        {
          id: "spice-1",
          title: "Spice and Wolf",
          author: "Isuna Hasekura",
          coverUrl: "https://s4.anilist.co/cover1.jpg",
          synopsis: "A merchant travels with a wolf deity across trade routes.",
          genres: ["Fantasy"],
          score: 90,
          popularity: 80000,
          releaseDate: "2006-02-10",
          volumeCount: 24,
          source: "both",
          sourceUrls: { lnori: "https://lnori.com/1", elscione: "https://server.elscione.com/1" },
          inLibrary: false,
          existingVolumes: 0,
        },
        {
          id: "spice-2",
          title: "Spice & Wolf",
          author: "Isuna Hasekura",
          coverUrl: "https://s4.anilist.co/cover2.jpg",
          synopsis: "Another edition of Spice & Wolf.",
          genres: ["Fantasy"],
          score: 90,
          popularity: 80000,
          releaseDate: "2006-02-10",
          volumeCount: 24,
          source: "both",
          sourceUrls: { lnori: "https://lnori.com/1", elscione: "https://server.elscione.com/1" },
          inLibrary: false,
          existingVolumes: 0,
        },
        {
          id: "worldend-1",
          title: "WorldEnd",
          author: "Akira Kareno",
          coverUrl: "https://s4.anilist.co/cover3.jpg",
          synopsis: "What do you do at the end of the world? Are you busy?",
          genres: ["Sci-Fi", "Fantasy"],
          score: 87,
          popularity: 70000,
          releaseDate: "2014-11-01",
          volumeCount: 5,
          source: "both",
          sourceUrls: { lnori: "https://lnori.com/2", elscione: "https://server.elscione.com/2" },
          inLibrary: false,
          existingVolumes: 0,
        },
        {
          id: "worldend-2",
          title: "WorldEnd: What Do You Do at the End of the World? Are You Busy? Will You Save Us?",
          author: "Akira Kareno",
          coverUrl: "https://s4.anilist.co/cover4.jpg",
          synopsis: "Full title edition of WorldEnd.",
          genres: ["Sci-Fi", "Fantasy"],
          score: 87,
          popularity: 70000,
          releaseDate: "2014-11-01",
          volumeCount: 5,
          source: "both",
          sourceUrls: { lnori: "https://lnori.com/2", elscione: "https://server.elscione.com/2" },
          inLibrary: false,
          existingVolumes: 0,
        },
        {
          id: "gimai-1",
          title: "Days with My Stepsister",
          author: "Ghost Mikawa",
          coverUrl: "https://s4.anilist.co/cover5.jpg",
          synopsis: "Living under the same roof with calm respectful distance.",
          genres: ["Romance"],
          score: 84,
          popularity: 50000,
          releaseDate: "2021-01-25",
          volumeCount: 11,
          source: "both",
          sourceUrls: { lnori: "https://lnori.com/3", elscione: "https://server.elscione.com/3" },
          inLibrary: false,
          existingVolumes: 0,
        },
        {
          id: "gimai-2",
          title: "Gimai Seikatsu",
          author: "Ghost Mikawa",
          coverUrl: "https://s4.anilist.co/cover6.jpg",
          synopsis: "Japanese title edition of Days with My Stepsister.",
          genres: ["Romance"],
          score: 84,
          popularity: 50000,
          releaseDate: "2021-01-25",
          volumeCount: 11,
          source: "both",
          sourceUrls: { lnori: "https://lnori.com/3", elscione: "https://server.elscione.com/3" },
          inLibrary: false,
          existingVolumes: 0,
        },
      ];

      const deduped = deduplicateDiscoverNovels(duplicateList);
      expect(deduped.length).toBe(3);

      const titles = deduped.map((n) => n.title);
      expect(titles.filter((t) => t.toLowerCase().includes("spice")).length).toBe(1);
      expect(titles.filter((t) => t.toLowerCase().includes("worldend")).length).toBe(1);
      expect(titles.filter((t) => t.toLowerCase().includes("stepsister") || t.toLowerCase().includes("gimai")).length).toBe(1);
    });

    it("guarantees New Releases does not contain titles already present in Trending", async () => {
      const trendingNovels = await fetchDiscoverFeed("trending", { cacheDb: tempCacheDb });
      const newNovels = await fetchDiscoverFeed("new", { cacheDb: tempCacheDb });

      const trendingCanonical = new Set(
        trendingNovels.map((n) => canonicalTitleKey(n.title)),
      );

      for (const novel of newNovels) {
        const canKey = canonicalTitleKey(novel.title);
        expect(trendingCanonical.has(canKey)).toBe(false);
      }
    });
  });

  describe("Elscione Folder Validation, Sanitization & 403 Prevention", () => {
    it("sanitizeTitleForFolderMatch strips colons, question marks, and illegal filesystem characters", () => {
      expect(sanitizeTitleForFolderMatch("Heroine? Saint? No, I'm an All-Works Maid")).toBe(
        "Heroine Saint No, I'm an All-Works Maid",
      );
      expect(sanitizeTitleForFolderMatch("Re:ZERO -Starting Life in Another World-")).toBe(
        "Re ZERO -Starting Life in Another World-",
      );
      expect(sanitizeTitleForFolderMatch("What/If: Evil*Title?")).toBe("What If Evil Title");
    });

    it("findRealElscioneFolder resolves titles with question marks and colons to exact real folders without illegal characters", () => {
      const heroine = findRealElscioneFolder("Heroine? Saint? No, I'm an All-Works Maid");
      expect(heroine).toBe("Heroine Saint No, I'm an All-Works Maid");
      expect(heroine?.includes("?")).toBe(false);
      expect(REAL_ELSCIONE_FOLDERS).toContain(heroine!);

      const rezero = findRealElscioneFolder("Re:ZERO -Starting Life in Another World-");
      expect(rezero).toBe("ReZero - Starting Life in Another World");
      expect(rezero?.includes(":")).toBe(false);
      expect(REAL_ELSCIONE_FOLDERS).toContain(rezero!);
    });

    it("findRealElscioneFolder never returns any folder containing illegal characters or not in discover-catalog.json", () => {
      for (const folder of REAL_ELSCIONE_FOLDERS) {
        expect(/[:?*"<>|/\\]/.test(folder)).toBe(false);
      }

      // Non-existent title must return null
      expect(findRealElscioneFolder("NonExistentNovelTitle12345")).toBeNull();
      // Title with colons that doesn't exist must return null, never fabricated
      expect(findRealElscioneFolder("Fake: Novel: Series")).toBeNull();
    });

    it("resolveRealDownloadSources never generates Elscione URLs with illegal characters or non-existent folders", () => {
      const match = resolveRealDownloadSources("Re:ZERO -Starting Life in Another World-");
      expect(match).not.toBeNull();
      expect(match?.sourceUrls.elscione).toBeDefined();
      expect(match?.sourceUrls.elscione).toContain("ReZero%20-%20Starting%20Life%20in%20Another%20World");
      expect(new URL(match!.sourceUrls.elscione!).pathname.includes(":")).toBe(false);
    });

    it("enqueueDiscoverIngest and /api/discover/ingest reject Elscione URLs containing colons or non-existent folders with error", async () => {
      // 1. Direct helper rejects illegal character in folder
      await expect(
        enqueueDiscoverIngest(
          "https://server.elscione.com/Officially%20Translated%20Light%20Novels/Re:Zero/",
          "elscione",
        ),
      ).rejects.toThrow("invalid characters");

      // 2. Direct helper rejects non-existent folder
      await expect(
        enqueueDiscoverIngest(
          "https://server.elscione.com/Officially%20Translated%20Light%20Novels/CompletelyFakeFolder999/",
          "elscione",
        ),
      ).rejects.toThrow("does not exist in catalog");

      // 3. REST API rejects illegal characters with 400
      const reqColon = new Request("http://127.0.0.1:8086/api/discover/ingest", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          url: "https://server.elscione.com/Officially%20Translated%20Light%20Novels/Re:Zero/",
          source: "elscione",
        }),
      });
      const resColon = await handleRequest(reqColon, localServer);
      expect(resColon.status).toBe(400);
      const jsonColon = (await resColon.json()) as any;
      expect(jsonColon.success).toBe(false);
      expect(jsonColon.error).toContain("invalid characters");

      // 4. REST API rejects non-existent folder with 400
      const reqFake = new Request("http://127.0.0.1:8086/api/discover/ingest", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          url: "https://server.elscione.com/Officially%20Translated%20Light%20Novels/FakeFolder12345/",
          source: "elscione",
        }),
      });
      const resFake = await handleRequest(reqFake, localServer);
      expect(resFake.status).toBe(400);
      const jsonFake = (await resFake.json()) as any;
      expect(jsonFake.success).toBe(false);
      expect(jsonFake.error).toContain("does not exist in catalog");
    });
  });

  describe("Cache Versioning (v2:feed:...) & Legacy Cache Invalidation", () => {
    it("bypasses legacy stale cache keys and uses v2:feed prefix", async () => {
      // Plant stale legacy cache entry
      const legacyStaleNovel: DiscoveredNovel = {
        id: "stale-legacy-novel",
        title: "Old Stale Novel",
        author: "Old Author",
        coverUrl: "https://images.ranobedb.org/old-404.jpg",
        synopsis: "Old stale cached synopsis text here.",
        genres: ["Fantasy"],
        score: 50,
        popularity: 1000,
        releaseDate: "2010-01-01",
        volumeCount: 1,
        source: "both",
        sourceUrls: { lnori: "https://lnori.com/1", elscione: "https://server.elscione.com/1" },
        inLibrary: false,
        existingVolumes: 0,
      };

      setCachedFeed("feed:trending", [legacyStaleNovel], { cacheDb: tempCacheDb });

      // fetchDiscoverFeed must use v2:feed:trending and bypass feed:trending
      const feed = await fetchDiscoverFeed("trending", { cacheDb: tempCacheDb });
      const staleHit = feed.find((n) => n.id === "stale-legacy-novel");
      expect(staleHit).toBeUndefined();

      // Check that v2:feed:trending was created in cache
      const v2Cached = getCachedFeed("v2:feed:trending", { cacheDb: tempCacheDb });
      expect(v2Cached).not.toBeNull();
      expect(v2Cached!.length).toBeGreaterThan(0);
      expect(v2Cached!.some((n) => n.id === "stale-legacy-novel")).toBe(false);
    });
  });
});
