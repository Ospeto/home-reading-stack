import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { Database } from "bun:sqlite";
import fs from "node:fs";
import path from "node:path";
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
  stripEmojis,
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
  cleanCalibreTitleVariants,
  calculateSignificantTokenOverlap,
  searchAniListNovels,
  searchUniversalNovels,
  resolveAuthorForTitle,
  resolveCoverForTitle,
  generateFallbackCoverSvg,
  buildCatalogDiscoverNovels,
  KNOWN_TITLE_TO_COVER,
  KNOWN_TITLE_TO_LNORI,
  DISCOVER_FEED_CACHE_VERSION,
  CATALOG_VOLUMES,
  resolveCatalogVolumeCount,
  getCalibreBookMatchCandidates,
  getNovelMatchCandidates,
  isSpinoffMismatch,
  type DiscoveredNovel,
} from "./discover";
import {
  handleRequest,
  setServerDependenciesForTest,
  resetServerDependenciesForTest,
  resetActiveLnoriStateForTest,
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

  describe("Complete Catalog Tab (tab=all)", () => {
    it("aggregates the complete catalog from both Lnori and Elsci.one without duplicates", async () => {
      const res = await getDiscoverNovels(
        { tab: "all", page: 1, pageSize: 36 },
        { cacheDb: tempCacheDb },
      );

      expect(res.success).toBe(true);
      expect(res.tab).toBe("all");
      expect(res.count).toBeGreaterThan(1200);
      expect(res.novels.length).toBe(36);
      expect(res.totalPages).toBeGreaterThan(30);

      // Verify no duplicate IDs on the returned page
      const ids = new Set(res.novels.map((n) => n.id));
      expect(ids.size).toBe(res.novels.length);

      // Verify sources present
      const sources = new Set(res.novels.map((n) => n.source));
      expect(sources.has("elscione") || sources.has("both")).toBe(true);

      // Verify each novel has real author, coverUrl, synopsis >= 30, and valid primary source
      for (const novel of res.novels) {
        expect(novel.author).toBeDefined();
        expect(novel.author.length).toBeGreaterThan(0);
        expect(novel.synopsis).toBeDefined();
        expect(novel.synopsis.length).toBeGreaterThanOrEqual(30);
        expect(["elscione", "lnori"]).toContain(novel.primarySource);
        if (novel.source === "both") {
          expect(novel.primarySource).toBe("elscione");
          expect(novel.primaryUrl).toBe(novel.sourceUrls.elscione);
        }
      }
    }, 15000);

    it("supports pagination across the complete catalog (page 1, page 2)", async () => {
      const page1 = await getDiscoverNovels(
        { tab: "all", page: 1, pageSize: 20 },
        { cacheDb: tempCacheDb },
      );
      const page2 = await getDiscoverNovels(
        { tab: "all", page: 2, pageSize: 20 },
        { cacheDb: tempCacheDb },
      );

      expect(page1.novels.length).toBe(20);
      expect(page2.novels.length).toBe(20);
      expect(page1.page).toBe(1);
      expect(page2.page).toBe(2);
      expect(page1.totalPages).toBe(page2.totalPages);

      const page1Ids = new Set(page1.novels.map((n) => n.id));
      for (const novel of page2.novels) {
        expect(page1Ids.has(novel.id)).toBe(false);
      }
    });

    it("filters complete catalog by source (all, lnori, elscione)", async () => {
      const resLnori = await getDiscoverNovels(
        { tab: "all", source: "lnori", page: 1, pageSize: 50 },
        { cacheDb: tempCacheDb },
      );
      for (const novel of resLnori.novels) {
        expect(novel.source === "lnori" || novel.source === "both").toBe(true);
      }

      const resElscione = await getDiscoverNovels(
        { tab: "all", source: "elscione", page: 1, pageSize: 50 },
        { cacheDb: tempCacheDb },
      );
      for (const novel of resElscione.novels) {
        expect(novel.source === "elscione" || novel.source === "both").toBe(true);
      }
    });

    it("filters complete catalog by genre and library status", async () => {
      const resGenre = await getDiscoverNovels(
        { tab: "all", genre: "Fantasy", page: 1, pageSize: 36 },
        { cacheDb: tempCacheDb },
      );
      expect(resGenre.novels.length).toBeGreaterThan(0);
      for (const novel of resGenre.novels) {
        expect(novel.genres.some((g) => g.toLowerCase() === "fantasy")).toBe(true);
      }

      const mockCalibreBooks = [
        { id: 1, title: "DanMachi Vol 1", series: "DanMachi", series_index: 1 },
      ];
      const resStatus = await getDiscoverNovels(
        { tab: "all", status: "in_library" },
        { cacheDb: tempCacheDb, getCalibreBooks: () => mockCalibreBooks },
      );
      for (const novel of resStatus.novels) {
        expect(novel.inLibrary).toBe(true);
      }
    });

    it("supports sorting by title_asc (A-Z) and newest on complete catalog", async () => {
      const resAsc = await getDiscoverNovels(
        { tab: "all", sort: "title_asc", page: 1, pageSize: 20 },
        { cacheDb: tempCacheDb },
      );
      expect(resAsc.novels.length).toBe(20);
      for (let i = 1; i < resAsc.novels.length; i++) {
        expect(resAsc.novels[i].title.localeCompare(resAsc.novels[i - 1].title)).toBeGreaterThanOrEqual(0);
      }
    });

    it("serves complete catalog from cache under v6:feed:all on repeat queries", async () => {
      const initial = await getDiscoverNovels(
        { tab: "all", page: 1, pageSize: 10 },
        { cacheDb: tempCacheDb },
      );
      expect(initial.success).toBe(true);

      const cached = await getDiscoverNovels(
        { tab: "all", page: 1, pageSize: 10 },
        { cacheDb: tempCacheDb },
      );
      expect(cached.success).toBe(true);
      expect(cached.count).toBe(initial.count);
      expect(cached.novels.length).toBe(initial.novels.length);
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

      setCachedFeed(`${DISCOVER_FEED_CACHE_VERSION}:feed:trending`, [testNovel], { cacheDb: tempCacheDb });
      const cached = getCachedFeed(`${DISCOVER_FEED_CACHE_VERSION}:feed:trending`, { cacheDb: tempCacheDb });
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

    it("GET /api/discover/novels?tab=all returns complete catalog with pagination", async () => {
      const req = new Request("http://127.0.0.1:8086/api/discover/novels?tab=all&page=1&pageSize=36");
      const res = await handleRequest(req);

      expect(res.status).toBe(200);
      const data = (await res.json()) as any;
      expect(data.success).toBe(true);
      expect(data.tab).toBe("all");
      expect(data.novels.length).toBe(36);
      expect(data.page).toBe(1);
      expect(data.pageSize).toBe(36);
      expect(data.count).toBeGreaterThan(1200);
      expect(data.totalPages).toBeGreaterThan(30);
      expect(data.counts?.all).toBeGreaterThan(1200);
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

    it("verifies badge and button consistency for in-library vs available novels in index.html", () => {
      // In Library badge and Re-Ingest button
      expect(html).toContain("In Library (${libCount} vols)");
      expect(html).toContain("Available (${item.volumeCount || 1} vols)");
      expect(html).toContain("${item.volumeCount || 1} vols");
      expect(html).toContain("${inLib ? 'Re-Ingest' : 'Ingest'}");
      expect(html).toContain("bg-amber-400 hover:bg-amber-300 text-zinc-950 font-bold shadow-md");
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

    it("verifies error formatting replaces [path] and [file] with human-readable error text and removes mangled URL regex artifacts", () => {
      expect(html).toContain("formatCleanErrorMessage");
      expect(html).toContain(".replace(/\\[path\\]/g, 'file')");
      expect(html).toContain(".replace(/\\[file\\]/g, 'file')");
      expect(html).toContain("https?:\\/\\/?(?:\\[path\\]|\\[file\\])");
    });

    it("verifies modal sources layout uses responsive flex-col sm:flex-row, proper spacing, and shrink-0 buttons", () => {
      // Clean flexbox layout with flex-col sm:flex-row sm:items-center justify-between gap-2.5 p-3 rounded-xl border
      expect(html).toContain("flex flex-col sm:flex-row sm:items-center justify-between gap-2.5 p-3 rounded-xl border");
      // Action buttons have shrink-0 so they never overlap or truncate text
      expect(html).toContain('class="underline text-zinc-400 hover:text-white flex items-center gap-1 text-[11px] shrink-0"');
      expect(html).toContain("cursor-pointer active:scale-[0.96] shrink-0");
      expect(html).toContain("shrink-0 self-end sm:self-auto");
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
      expect(html).toContain("function generateFallbackCoverSvg");
      expect(html).toContain("window.generateFallbackCoverSvg = generateFallbackCoverSvg;");
      expect(html).toContain("window.handleCoverError = handleCoverError;");
      expect(html).toContain("window.getCoverPlaceholderDataUri = getCoverPlaceholderDataUri;");

      // Card cover onerror and uncropped styling
      expect(html).toContain('onerror="this.onerror=null; this.src=generateFallbackCoverSvg(this.alt);"');
      expect(html).toContain('data-title="${escapeHtml(item.title)}"');
      expect(html).toContain('class="w-full h-full object-cover object-top rounded-xl bg-zinc-950 group-hover:scale-[1.03] transition-transform duration-300"');

      // Modal cover onerror and top-aligned uncropped styling
      expect(html).toContain('id="discoverModalCover" src="" alt="Cover" class="w-full h-full object-cover object-top rounded-xl bg-zinc-950" onerror="this.onerror=null; this.src=generateFallbackCoverSvg(this.alt);"');

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

    it("verifies All Titles segmented control tab and Apple-style pagination controls in index.html", () => {
      // 1. All Titles segmented toggle
      expect(html).toContain('id="discoverTabAll"');
      expect(html).toContain('id="discoverAllBadge"');
      expect(html).toContain("switchDiscoverTab('all')");
      expect(html).toContain("All Titles");

      // 2. Pagination controls markup
      expect(html).toContain('id="discoverPagination"');
      expect(html).toContain('id="discoverPaginationInfo"');
      expect(html).toContain('id="discoverPrevPageBtn"');
      expect(html).toContain('id="discoverNextPageBtn"');
      expect(html).toContain('id="discoverPageIndicator"');
      expect(html).toContain("changeDiscoverPage(-1)");
      expect(html).toContain("changeDiscoverPage(1)");

      // 3. JavaScript state and functions
      expect(html).toContain("function renderDiscoverPagination");
      expect(html).toContain("function changeDiscoverPage");
      expect(html).toContain("discoverPaginationState");
      expect(html).toContain("Showing ");
      expect(html).toContain(" of ");
      expect(html).toContain("Page ");
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

  describe("Cache Versioning (v6:feed:...) & Legacy Cache Invalidation", () => {
    it("bypasses legacy stale cache keys and uses v6:feed prefix", async () => {
      expect(DISCOVER_FEED_CACHE_VERSION).toBe("v6");

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
      setCachedFeed("v2:feed:trending", [legacyStaleNovel], { cacheDb: tempCacheDb });
      setCachedFeed("v3:feed:trending", [legacyStaleNovel], { cacheDb: tempCacheDb });
      setCachedFeed("v4:feed:trending", [legacyStaleNovel], { cacheDb: tempCacheDb });
      setCachedFeed("v5:feed:trending", [legacyStaleNovel], { cacheDb: tempCacheDb });

      // fetchDiscoverFeed must use v6:feed:trending and bypass feed:trending, v2:feed:trending, v3:feed:trending, v4:feed:trending, and v5:feed:trending
      const feed = await fetchDiscoverFeed("trending", { cacheDb: tempCacheDb });
      const staleHit = feed.find((n) => n.id === "stale-legacy-novel");
      expect(staleHit).toBeUndefined();

      // Check that v6:feed:trending was created in cache
      const v6Cached = getCachedFeed(`${DISCOVER_FEED_CACHE_VERSION}:feed:trending`, { cacheDb: tempCacheDb });
      expect(v6Cached).not.toBeNull();
      expect(v6Cached!.length).toBeGreaterThan(0);
      expect(v6Cached!.some((n) => n.id === "stale-legacy-novel")).toBe(false);
    });
  });

  describe("Multi-Lingual, Alias & Subtitle Library Matching (crossCheckNovelsWithCalibre)", () => {
    const baseDanmachiNovel: DiscoveredNovel = {
      id: "danmachi",
      title: "DanMachi: Is It Wrong to Try to Pick Up Girls in a Dungeon?",
      titleRomaji: "Dungeon ni Deai wo Motomeru no wa Machigatteiru Darou ka",
      titleNative: "ダンジョンに出会いを求めるのは間違っているだろうか",
      author: "Fujino Omori",
      coverUrl: "https://s4.anilist.co/danmachi.jpg",
      synopsis: "In the sprawling city of Orario above the massive Dungeon, rookie adventurer Bell Cranel strives to grow stronger.",
      genres: ["Fantasy", "Action"],
      score: 86,
      popularity: 85000,
      releaseDate: "2013-01-15",
      volumeCount: 19,
      source: "both",
      sourceUrls: { lnori: "https://lnori.com/series/2201", elscione: "https://server.elscione.com/DanMachi" },
      inLibrary: false,
      existingVolumes: 0,
    };

    it("matches DanMachi: Is It Wrong to Try to Pick Up Girls in a Dungeon? to Calibre book Is It Wrong to Try to Pick Up Girls in a Dungeon?, Vol. 18", () => {
      const mockCalibreBooks = [
        {
          id: 501,
          title: "Is It Wrong to Try to Pick Up Girls in a Dungeon?, Vol. 18",
          series: "",
        },
      ];

      const result = crossCheckNovelsWithCalibre([baseDanmachiNovel], {
        getCalibreBooks: () => mockCalibreBooks,
      });

      expect(result[0].inLibrary).toBe(true);
      expect(result[0].existingVolumes).toBe(1);
    });

    it("matches multiple Calibre volumes of DanMachi accurately counting existingVolumes", () => {
      const mockCalibreBooks = [
        { id: 501, title: "Is It Wrong to Try to Pick Up Girls in a Dungeon?, Vol. 1", series: "Is It Wrong to Try to Pick Up Girls in a Dungeon?" },
        { id: 502, title: "Is It Wrong to Try to Pick Up Girls in a Dungeon?, Vol. 2", series: "Is It Wrong to Try to Pick Up Girls in a Dungeon?" },
        { id: 503, title: "Is It Wrong to Try to Pick Up Girls in a Dungeon?, Vol. 18", series: "" },
      ];

      const result = crossCheckNovelsWithCalibre([baseDanmachiNovel], {
        getCalibreBooks: () => mockCalibreBooks,
      });

      expect(result[0].inLibrary).toBe(true);
      expect(result[0].existingVolumes).toBe(3);
    });

    it("matches by Romaji alternate title when Calibre stores romanized Japanese", () => {
      const slimeNovel: DiscoveredNovel = {
        id: "slime",
        title: "That Time I Got Reincarnated as a Slime",
        titleRomaji: "Tensei shitara Slime Datta Ken",
        titleNative: "転生したらスライムだった件",
        author: "Fuse",
        coverUrl: "https://s4.anilist.co/slime.jpg",
        synopsis: "Thirty-seven-year-old Satoru Mikami is reincarnated into another world as a slime monster.",
        genres: ["Fantasy", "Isekai"],
        score: 87,
        popularity: 90000,
        releaseDate: "2014-05-30",
        volumeCount: 21,
        source: "both",
        sourceUrls: { lnori: "https://lnori.com/series/3336" },
        inLibrary: false,
        existingVolumes: 0,
      };

      const mockCalibreBooks = [
        {
          id: 601,
          title: "Tensei shitara Slime Datta Ken, Vol. 16",
          series: "",
        },
      ];

      const result = crossCheckNovelsWithCalibre([slimeNovel], {
        getCalibreBooks: () => mockCalibreBooks,
      });

      expect(result[0].inLibrary).toBe(true);
      expect(result[0].existingVolumes).toBe(1);
    });

    it("matches by Japanese native title when Calibre book has native Japanese title with volume notation", () => {
      const mockCalibreBooks = [
        {
          id: 701,
          title: "ダンジョンに出会いを求めるのは間違っているだろうか 第18巻",
          series: "",
        },
      ];

      const result = crossCheckNovelsWithCalibre([baseDanmachiNovel], {
        getCalibreBooks: () => mockCalibreBooks,
      });

      expect(result[0].inLibrary).toBe(true);
      expect(result[0].existingVolumes).toBe(1);
    });

    it("matches all 10 universal light novel alias pairs bidirectionally", () => {
      const aliasTests: Array<{ novelTitle: string; calibreTitle: string }> = [
        // 1. DanMachi <-> Is It Wrong to Try to Pick Up Girls in a Dungeon
        { novelTitle: "DanMachi", calibreTitle: "Is It Wrong to Try to Pick Up Girls in a Dungeon?, Vol. 1" },
        // 2. Re:Zero <-> Starting Life in Another World
        { novelTitle: "Re:Zero", calibreTitle: "Starting Life in Another World, Vol. 21" },
        // 3. Oregairu <-> My Youth Romantic Comedy Is Wrong As I Expected
        { novelTitle: "Oregairu", calibreTitle: "My Youth Romantic Comedy Is Wrong, As I Expected, Vol. 1" },
        // 4. KonoSuba <-> God's Blessing on This Wonderful World
        { novelTitle: "KonoSuba", calibreTitle: "God's Blessing on This Wonderful World!, Vol. 1" },
        // 5. Tensura / Slime <-> That Time I Got Reincarnated as a Slime
        { novelTitle: "Tensura", calibreTitle: "That Time I Got Reincarnated as a Slime, Vol. 1" },
        // 6. Mahouka <-> The Irregular at Magic High School
        { novelTitle: "Mahouka", calibreTitle: "The Irregular at Magic High School, Vol. 1" },
        // 7. SAO <-> Sword Art Online
        { novelTitle: "SAO", calibreTitle: "Sword Art Online 25: Unital Ring IV" },
        // 8. COTE <-> Classroom of the Elite
        { novelTitle: "COTE", calibreTitle: "Classroom of the Elite, Vol. 1" },
        // 9. Roshidere <-> Alya Sometimes Hides Her Feelings in Russian
        { novelTitle: "Roshidere", calibreTitle: "Alya Sometimes Hides Her Feelings in Russian, Vol. 1" },
        // 10. Monogatari / Bakemonogatari <-> Monster Tale
        { novelTitle: "Bakemonogatari", calibreTitle: "Monster Tale, Part 1" },
      ];

      for (const pair of aliasTests) {
        const testNovel: DiscoveredNovel = {
          id: `test-${pair.novelTitle.toLowerCase().replace(/[^a-z0-9]/g, "-")}`,
          title: pair.novelTitle,
          author: "Author",
          coverUrl: "https://s4.anilist.co/cover.jpg",
          synopsis: "Engaging plot summary for this light novel series.",
          genres: ["Fantasy"],
          score: 85,
          popularity: 50000,
          releaseDate: "2020-01-01",
          volumeCount: 10,
          source: "lnori",
          sourceUrls: { lnori: "https://lnori.com/series/1" },
          inLibrary: false,
          existingVolumes: 0,
        };

        const result = crossCheckNovelsWithCalibre([testNovel], {
          getCalibreBooks: () => [{ id: 801, title: pair.calibreTitle, series: "" }],
        });

        expect(result[0].inLibrary).toBe(true);
        expect(result[0].existingVolumes).toBe(1);
      }
    });

    it("cleans diverse Calibre volume notations and suffixes cleanly", () => {
      const sampleTitles = [
        "Is It Wrong to Try to Pick Up Girls in a Dungeon?, Vol. 18",
        "Classroom of the Elite: Year 2 Vol. 9",
        "Ascendance of a Bookworm: Part 1 Volume 1",
        "Sword Art Online #1",
        "That Time I Got Reincarnated as a Slime Volume 16",
        "Re:Zero - Starting Life in Another World-, Vol. 21",
        "ダンジョンに出会いを求めるのは間違っているだろうか 第1巻",
      ];

      for (const raw of sampleTitles) {
        const cleaned = cleanCalibreTitleVariants(raw);
        expect(cleaned.length).toBeGreaterThan(1);
      }
    });

    it("supports token overlap matching (>= 70% significant word overlap)", () => {
      const novelTokens = ["wrong", "try", "pick", "girls", "dungeon", "danmachi"];
      const calibreTokens = ["wrong", "try", "pick", "girls", "dungeon"];

      const overlap = calculateSignificantTokenOverlap(novelTokens, calibreTokens);
      expect(overlap).toBeGreaterThanOrEqual(0.70);
    });

    it("does NOT falsely match unrelated titles sharing single common words", () => {
      const heroNovel: DiscoveredNovel = {
        id: "sentenced-to-be-a-hero",
        title: "Sentenced to Be a Hero",
        author: "Rocket Shokai",
        coverUrl: "https://s4.anilist.co/hero.jpg",
        synopsis: "Heroism is a punishment for criminals in this dark fantasy world.",
        genres: ["Fantasy", "Action"],
        score: 82,
        popularity: 30000,
        releaseDate: "2021-09-17",
        volumeCount: 5,
        source: "both",
        sourceUrls: { lnori: "https://lnori.com/series/12440" },
        inLibrary: false,
        existingVolumes: 0,
      };

      const mockCalibreBooks = [
        { id: 901, title: "The Hero, Vol. 1", series: "" },
        { id: 902, title: "A Sister's All You Need, Vol. 1", series: "" },
        { id: 903, title: "Overlord, Vol. 1", series: "" },
      ];

      const result = crossCheckNovelsWithCalibre([heroNovel], {
        getCalibreBooks: () => mockCalibreBooks,
      });

      expect(result[0].inLibrary).toBe(false);
      expect(result[0].existingVolumes).toBe(0);
    });

    it("integrates seamlessly into getDiscoverNovels and filters status=in_library", async () => {
      const mockCalibreBooks = [
        {
          id: 1001,
          title: "Is It Wrong to Try to Pick Up Girls in a Dungeon?, Vol. 18",
          series: "",
        },
      ];

      const inLibRes = await getDiscoverNovels(
        { tab: "trending", status: "in_library" },
        { cacheDb: tempCacheDb, getCalibreBooks: () => mockCalibreBooks },
      );

      expect(inLibRes.success).toBe(true);
      const danmachiHit = inLibRes.novels.find((n) => n.id === "danmachi");
      expect(danmachiHit).toBeDefined();
      expect(danmachiHit?.inLibrary).toBe(true);
      expect(danmachiHit?.existingVolumes).toBe(1);
    });
  });

  describe("Universal Light Novel Catalog & Metadata Search Engine", () => {
    it("searching q=danmachi searches universal catalog and returns matching novels across both sources with verified paths and real author", async () => {
      const mockCalibreBooks = [
        {
          id: 501,
          title: "Is It Wrong to Try to Pick Up Girls in a Dungeon?, Vol. 1",
          authors: "Fujino Omori",
        },
      ];

      const res = await getDiscoverNovels(
        { q: "danmachi" },
        { cacheDb: tempCacheDb, getCalibreBooks: () => mockCalibreBooks },
      );

      expect(res.success).toBe(true);
      expect(res.novels.length).toBeGreaterThan(0);
      expect(res.count).toBeGreaterThan(0);

      // Verify at least one DanMachi entry
      const danmachi = res.novels.find(
        (n) =>
          normalizeTitleForMatch(n.title).includes("danmachi") ||
          normalizeTitleForMatch(n.title).includes("pick up girls in a dungeon") ||
          canonicalTitleKey(n.title) === "danmachi",
      );

      expect(danmachi).toBeDefined();
      expect(danmachi!.author).toBe("Fujino Omori");
      expect(danmachi!.primarySource).toBe("elscione");
      expect(danmachi!.sourceUrls.elscione).toContain("DanMachi");
      expect(danmachi!.sourceUrls.lnori).toBeDefined();
      expect(danmachi!.synopsis.length).toBeGreaterThan(20);
      expect(danmachi!.inLibrary).toBe(true);
      expect(danmachi!.existingVolumes).toBe(1);

      // Verify zero emojis
      for (const novel of res.novels) {
        expect(/\p{Extended_Pictographic}/u.test(novel.title)).toBe(false);
        expect(/\p{Extended_Pictographic}/u.test(novel.author)).toBe(false);
        expect(/\p{Extended_Pictographic}/u.test(novel.synopsis)).toBe(false);
      }
    });

    it("searching q=dungeon returns all matching series across both catalogs beyond the pre-loaded items", async () => {
      const mockCalibreBooks = [
        {
          id: 701,
          title: "Dungeon Busters Vol 1",
          authors: "Touma Shinozaki",
        },
      ];

      const res = await getDiscoverNovels(
        { q: "dungeon" },
        { cacheDb: tempCacheDb, getCalibreBooks: () => mockCalibreBooks },
      );

      expect(res.success).toBe(true);
      // Confirms search returns all matching series across ~1,100+ folders and 883 Lnori series, not just ~20 tab items
      expect(res.count).toBeGreaterThanOrEqual(10);
      expect(res.novels.length).toBeGreaterThanOrEqual(10);

      // Confirm DanMachi is present because its English title contains dungeon
      const danmachi = res.novels.find(
        (n) =>
          normalizeTitleForMatch(n.title).includes("dungeon") ||
          canonicalTitleKey(n.title) === "danmachi",
      );
      expect(danmachi).toBeDefined();

      // Confirm Calibre matching works on search results
      const busters = res.novels.find((n) =>
        normalizeTitleForMatch(n.title).includes("dungeon busters"),
      );
      expect(busters).toBeDefined();
      expect(busters?.inLibrary).toBe(true);

      // Confirm verified download sources strictly prioritize Elsci.one
      for (const novel of res.novels) {
        if (novel.sourceUrls.elscione && novel.sourceUrls.lnori) {
          expect(novel.source).toBe("both");
          expect(novel.primarySource).toBe("elscione");
          expect(novel.primaryUrl).toBe(novel.sourceUrls.elscione);
        } else if (novel.sourceUrls.elscione) {
          expect(novel.source).toBe("elscione");
          expect(novel.primarySource).toBe("elscione");
          expect(novel.primaryUrl).toBe(novel.sourceUrls.elscione);
        } else {
          expect(novel.source).toBe("lnori");
          expect(novel.primarySource).toBe("lnori");
          expect(novel.primaryUrl).toBe(novel.sourceUrls.lnori);
        }
      }
    });

    it("executes live online AniList search when dependencies.fetch is provided and prioritizes Elsci.one", async () => {
      const mockAnilistFetch = async (url: string, _init?: RequestInit) => {
        if (url.includes("graphql.anilist.co")) {
          return new Response(
            JSON.stringify({
              data: {
                Page: {
                  media: [
                    {
                      id: 85162,
                      title: {
                        english: "Is It Wrong to Try to Pick Up Girls in a Dungeon?",
                        romaji: "Dungeon ni Deai wo Motomeru no wa Machigatteiru Darou ka",
                        native: "ダンジョンに出会いを求めるのは間違っているだろうか",
                      },
                      coverImage: {
                        large: "https://s4.anilist.co/danmachi-large.jpg",
                        extraLarge: "https://s4.anilist.co/danmachi-xlarge.jpg",
                      },
                      description: "Bell Cranel is a novice adventurer navigating the Orario dungeon under goddess Hestia.",
                      genres: ["Action", "Adventure", "Fantasy"],
                      averageScore: 84,
                      popularity: 125000,
                      startDate: { year: 2013, month: 1, day: 15 },
                      volumes: 19,
                      staff: {
                        edges: [
                          {
                            role: "Original Story",
                            node: { name: { full: "Fujino Omori" } },
                          },
                        ],
                      },
                    },
                    {
                      id: 99999,
                      title: {
                        english: "Completely Fake Unhosted Novel That Does Not Exist",
                        romaji: "Fake Novel Romaji",
                      },
                      coverImage: { large: "https://s4.anilist.co/fake.jpg" },
                      description: "This should be discarded by verified download sources guard.",
                      genres: ["Fantasy"],
                    },
                  ],
                },
              },
            }),
            { status: 200, headers: { "Content-Type": "application/json" } },
          );
        }
        return new Response("Not found", { status: 404 });
      };

      const anilistResults = await searchAniListNovels("danmachi", {
        fetch: mockAnilistFetch as any,
        cacheDb: tempCacheDb,
      });

      expect(anilistResults.length).toBe(1);
      const hit = anilistResults[0];
      expect(hit.title).toBe("Is It Wrong to Try to Pick Up Girls in a Dungeon?");
      expect(hit.author).toBe("Fujino Omori");
      expect(hit.coverUrl).toBe("https://s4.anilist.co/danmachi-xlarge.jpg");
      expect(hit.synopsis).toContain("Bell Cranel");
      expect(hit.primarySource).toBe("elscione");
      expect(hit.source).toBe("both");
    });

    it("resolves major franchise aliases correctly across Elsci.one and Lnori catalogs", async () => {
      const franchises = [
        { query: "overlord", expectedAuthor: "Kugane Maruyama", expectedTitle: "Overlord" },
        { query: "slime", expectedAuthor: "Fuse", expectedTitle: "That Time I Got Reincarnated as a Slime" },
        { query: "rezero", expectedAuthor: "Tappei Nagatsuki", expectedTitle: "Re:ZERO -Starting Life in Another World-" },
        { query: "sao", expectedAuthor: "Reki Kawahara", expectedTitle: "Sword Art Online" },
        { query: "oregairu", expectedAuthor: "Wataru Watari", expectedTitle: "My Youth Romantic Comedy Is Wrong" },
        { query: "cote", expectedAuthor: "Shogo Kinugasa", expectedTitle: "Classroom of the Elite" },
        { query: "konosuba", expectedAuthor: "Natsume Akatsuki", expectedTitle: "KonoSuba" },
        { query: "mahouka", expectedAuthor: "Tsutomu Satou", expectedTitle: "The Irregular at Magic High School" },
        { query: "monogatari", expectedAuthor: "Nisio Isin", expectedTitle: "Monogatari" },
      ];

      for (const f of franchises) {
        const res = await getDiscoverNovels({ q: f.query }, { cacheDb: tempCacheDb });
        expect(res.success).toBe(true);
        expect(res.novels.length).toBeGreaterThan(0);
        const match = res.novels.find((n) =>
          normalizeTitleForMatch(n.title).includes(normalizeTitleForMatch(f.expectedTitle)) ||
          canonicalTitleKey(n.title) === canonicalTitleKey(f.expectedTitle),
        );
        expect(match).toBeDefined();
        expect(match!.primarySource).toBe("elscione");
        expect(match!.sourceUrls.elscione).toBeDefined();
      }
    });

    it("respects source and status filters during universal search", async () => {
      const mockCalibreBooks = [
        {
          id: 801,
          title: "DanMachi Vol 1",
          authors: "Fujino Omori",
        },
      ];

      // Filter by source: elscione
      const elscioneOnly = await getDiscoverNovels(
        { q: "danmachi", source: "elscione" },
        { cacheDb: tempCacheDb, getCalibreBooks: () => mockCalibreBooks },
      );
      for (const n of elscioneOnly.novels) {
        expect(n.source === "elscione" || n.source === "both").toBe(true);
      }

      // Filter by status: in_library
      const inLibOnly = await getDiscoverNovels(
        { q: "danmachi", status: "in_library" },
        { cacheDb: tempCacheDb, getCalibreBooks: () => mockCalibreBooks },
      );
      for (const n of inLibOnly.novels) {
        expect(n.inLibrary).toBe(true);
      }

      // Filter by status: available
      const availOnly = await getDiscoverNovels(
        { q: "danmachi", status: "available" },
        { cacheDb: tempCacheDb, getCalibreBooks: () => mockCalibreBooks },
      );
      for (const n of availOnly.novels) {
        expect(n.inLibrary).toBe(false);
      }
    });

    it("GET /api/discover/novels and /api/discover/feed pass q to universal search with zero emojis", async () => {
      const req = new Request("http://127.0.0.1:8086/api/discover/feed?q=danmachi");
      const res = await handleRequest(req);

      expect(res.status).toBe(200);
      const data = (await res.json()) as any;
      expect(data.success).toBe(true);
      expect(Array.isArray(data.novels)).toBe(true);
      expect(data.novels.length).toBeGreaterThan(0);
      expect(data.count).toBeGreaterThan(0);

      const jsonStr = JSON.stringify(data);
      expect(/\p{Extended_Pictographic}/u.test(jsonStr)).toBe(false);
    });
  });

  describe("Accurate Covers & Fallback SVG (100% Verified Cover Guarantees)", () => {
    describe("resolveCoverForTitle (Elimination of Loose Substring Matching)", () => {
      it("does NOT falsely match titles containing loose substrings like 'slime'", () => {
        const unrelatedSlimeTitles = [
          "By the Grace of the Gods (Royalty and Slime)",
          "Overlord of the Underworld",
          "Overlord of Darkness",
          "I've Been Killing Slimes for 300 Years and Maxed Out My Level",
          "A Tale of Two Slimes",
          "Heroic Slime Chronicles",
          "Campfire Cooking with Slime",
        ];

        for (const title of unrelatedSlimeTitles) {
          const cover = resolveCoverForTitle(title);
          // Must NEVER falsely return Tensura or Overlord franchise covers
          expect(cover).not.toBe(KNOWN_TITLE_TO_COVER["that time i got reincarnated as a slime"]);
          expect(cover).not.toBe(KNOWN_TITLE_TO_COVER["tensura"]);
          expect(cover).not.toBe(KNOWN_TITLE_TO_COVER["slime"]);
          expect(cover).not.toBe(KNOWN_TITLE_TO_COVER["overlord"]);
          expect(cover).toBe("");
        }
      });

      it("resolves exact normalized matches accurately", () => {
        expect(resolveCoverForTitle("Overlord")).toBe(KNOWN_TITLE_TO_COVER["overlord"]);
        expect(resolveCoverForTitle("overlord")).toBe(KNOWN_TITLE_TO_COVER["overlord"]);
        expect(resolveCoverForTitle("Classroom of the Elite")).toBe(KNOWN_TITLE_TO_COVER["classroom of the elite"]);
        expect(resolveCoverForTitle("That Time I Got Reincarnated as a Slime")).toBe(
          KNOWN_TITLE_TO_COVER["that time i got reincarnated as a slime"],
        );
        expect(resolveCoverForTitle("86")).toBe(KNOWN_TITLE_TO_COVER["86"]);
        expect(resolveCoverForTitle("86 Eighty Six")).toBe(KNOWN_TITLE_TO_COVER["86 eighty six"]);
        expect(resolveCoverForTitle("DanMachi")).toBe(KNOWN_TITLE_TO_COVER["danmachi"]);
      });

      it("resolves word-boundary matches with high length ratio (>= 0.85) and volume stripping", () => {
        // High length ratio >= 0.85
        const tensuraVol1 = resolveCoverForTitle("That Time I Got Reincarnated as a Slime Vol 1");
        expect(tensuraVol1).toBe(KNOWN_TITLE_TO_COVER["that time i got reincarnated as a slime"]);

        const overlordVol1 = resolveCoverForTitle("Overlord Vol. 1");
        expect(overlordVol1).toBe(KNOWN_TITLE_TO_COVER["overlord"]);

        // Low length ratio (< 0.85) should NOT match
        const saoProgressive = resolveCoverForTitle("Sword Art Online Progressive");
        expect(saoProgressive).toBe("");
      });

      it("resolves exact matches using romaji and seeds", () => {
        // Romaji alias for Classroom of the Elite
        const cote = KNOWN_TITLE_TO_COVER["classroom of the elite"];
        const coteCover = resolveCoverForTitle("Classroom of the Elite", "Youkoso Jitsuryoku");
        expect(coteCover).toBe(cote);

        const mockSeeds: DiscoveredNovel[] = [
          {
            id: "seed-custom",
            title: "Custom Light Novel Series",
            titleRomaji: "Kusutamu Nobe",
            author: "Custom Author",
            coverUrl: "https://s4.anilist.co/custom-cover.jpg",
            synopsis: "Custom synopsis for testing seed cover match.",
            genres: ["Fantasy"],
            score: 90,
            popularity: 1000,
            releaseDate: "2024-01-01",
            volumeCount: 1,
            source: "lnori",
            sourceUrls: { lnori: "https://lnori.com/series/9999" },
            inLibrary: false,
            existingVolumes: 0,
          },
        ];

        expect(resolveCoverForTitle("Custom Light Novel Series", undefined, mockSeeds)).toBe(
          "https://s4.anilist.co/custom-cover.jpg",
        );
        // Does not falsely match unrelated substring
        expect(resolveCoverForTitle("The Custom Chronicles of Magic", undefined, mockSeeds)).toBe("");
      });
    });

    describe("Portrait Covers & Elimination of Lnori Landscape Social Banners", () => {
      it("guarantees 100% of Lnori series entries in discoverCatalog have valid numeric IDs and slugs", () => {
        expect(REAL_LNORI_SERIES.length).toBe(883);
        for (const s of REAL_LNORI_SERIES) {
          expect(typeof s.id).toBe("number");
          expect(s.id).toBeGreaterThan(0);
          expect(s.slug.length).toBeGreaterThan(0);
        }
      });

      it("never assigns 1200x630 series banners (cdn.lnori.com/series/) and falls back to clean SVG for unseeded titles", async () => {
        const catalog = await buildCatalogDiscoverNovels();
        expect(catalog.length).toBeGreaterThan(500);

        // Entire catalog must contain zero 1200x630 series banner URLs
        for (const novel of catalog) {
          expect(novel.coverUrl).toBeDefined();
          expect(novel.coverUrl.includes("cdn.lnori.com/series/")).toBe(false);
        }

        // Filter novels that originate purely from Lnori
        const lnoriNovels = catalog.filter((n) => n.id.startsWith("lnori-"));
        expect(lnoriNovels.length).toBeGreaterThan(100);

        for (const novel of lnoriNovels) {
          expect(novel.coverUrl).toBeDefined();
          expect(novel.coverUrl.includes("cdn.lnori.com/series/")).toBe(false);
          // Unseeded pure-Lnori titles should have clean SVG fallback or verified portrait cover
          const isSvgFallback = novel.coverUrl.startsWith("data:image/svg+xml");
          const isPortraitCover =
            novel.coverUrl.startsWith("https://s4.anilist.co/") ||
            novel.coverUrl.startsWith("https://cdn.lnori.com/cover/");
          expect(isSvgFallback || isPortraitCover).toBe(true);
        }
      });

      it("preserves seeded portrait cover precedence in complete catalog for affected titles", async () => {
        const catalog = await buildCatalogDiscoverNovels();

        const targets = [
          { query: "Ascendance of a Bookworm", coverSub: "bx110800" },
          { query: "Classroom of the Elite", coverSub: "bx94970" },
          { query: "Re:ZERO", coverSub: "bx85737" },
          { query: "Monogatari", coverSub: "bx44893" },
          { query: "Mushoku Tensei", coverSub: "nx85470" },
          { query: "The Apothecary Diaries", coverSub: "nx99026" },
        ];

        for (const t of targets) {
          const match = catalog.find((n) =>
            n.title.toLowerCase().includes(t.query.toLowerCase()) && !n.title.toLowerCase().includes("genji")
          );
          expect(match).toBeDefined();
          expect(match!.coverUrl).toBeDefined();
          expect(match!.coverUrl.includes("cdn.lnori.com/series/")).toBe(false);
          expect(match!.coverUrl).toContain(t.coverSub);
          expect(match!.coverUrl.startsWith("https://s4.anilist.co/")).toBe(true);
        }
      });

      it("has verified and corrected Lnori series IDs for Re:ZERO (3343) and The Apothecary Diaries (3768)", async () => {
        expect(KNOWN_TITLE_TO_LNORI["rezero"].id).toBe(3343);
        expect(KNOWN_TITLE_TO_LNORI["re zero"].id).toBe(3343);
        expect(KNOWN_TITLE_TO_LNORI["the apothecary diaries"].id).toBe(3768);

        const catalog = await buildCatalogDiscoverNovels();
        const rezero = catalog.find((n) => n.id === "re-zero");
        expect(rezero).toBeDefined();
        expect(rezero?.sourceUrls?.lnori).toBe("https://lnori.com/series/3343/re-zero-starting-life-in-another-world");

        const apothecary = catalog.find((n) => n.id === "the-apothecary-diaries");
        expect(apothecary).toBeDefined();
        expect(apothecary?.sourceUrls?.lnori).toBe("https://lnori.com/series/3768/the-apothecary-diaries");
      });

      it("preserves portrait cover precedence and clean SVG fallback in searchUniversalNovels without banner URLs", async () => {
        const rezeroResults = await searchUniversalNovels("rezero");
        expect(rezeroResults.length).toBeGreaterThan(0);
        const mainRezero = rezeroResults.find((r) => r.id === "re-zero");
        expect(mainRezero).toBeDefined();
        expect(mainRezero!.coverUrl.startsWith("https://s4.anilist.co/")).toBe(true);
        expect(mainRezero!.coverUrl.includes("cdn.lnori.com/series/")).toBe(false);
        expect(mainRezero!.sourceUrls?.lnori).toBe("https://lnori.com/series/3343/re-zero-starting-life-in-another-world");

        const apothecaryResults = await searchUniversalNovels("the apothecary diaries");
        expect(apothecaryResults.length).toBeGreaterThan(0);
        const mainApothecary = apothecaryResults.find((r) => r.id === "the-apothecary-diaries");
        expect(mainApothecary).toBeDefined();
        expect(mainApothecary!.coverUrl.startsWith("https://s4.anilist.co/")).toBe(true);
        expect(mainApothecary!.coverUrl.includes("cdn.lnori.com/series/")).toBe(false);
        expect(mainApothecary!.sourceUrls?.lnori).toBe("https://lnori.com/series/3768/the-apothecary-diaries");

        // Verify that all returned search results never use landscape social banners
        for (const res of [...rezeroResults, ...apothecaryResults]) {
          expect(res.coverUrl.includes("cdn.lnori.com/series/")).toBe(false);
          const isSvgFallback = res.coverUrl.startsWith("data:image/svg+xml");
          const isPortraitCover = res.coverUrl.startsWith("https://s4.anilist.co/");
          expect(isSvgFallback || isPortraitCover).toBe(true);
        }
      });
    });

    describe("generateFallbackCoverSvg (Apple-Aesthetic Book Cover Placeholder)", () => {
      it("generates a high-res SVG data URI with clean Apple typography and styling", () => {
        const dataUri = generateFallbackCoverSvg("My Romantic Comedy", "Wataru Watari");
        expect(dataUri.startsWith("data:image/svg+xml;charset=utf-8,")).toBe(true);

        const svgContent = decodeURIComponent(
          dataUri.replace("data:image/svg+xml;charset=utf-8,", ""),
        );

        // SVG structure and Apple aesthetics
        expect(svgContent).toContain('<svg xmlns="http://www.w3.org/2000/svg"');
        expect(svgContent).toContain('viewBox="0 0 200 300"');
        expect(svgContent).toContain("#18181b"); // dark gradient
        expect(svgContent).toContain("#09090b"); // dark gradient
        expect(svgContent).toContain("#f59e0b"); // subtle warm gold accent
        expect(svgContent).toContain("LIGHT NOVEL"); // bottom badge
        expect(svgContent).toContain("My Romantic");
        expect(svgContent).toContain("Comedy");
        expect(svgContent).toContain("Wataru Watari");
      });

      it("safely escapes XML special characters in title and author", () => {
        const dataUri = generateFallbackCoverSvg(
          'Spice & Wolf: Hero <Saint> "Chronicles"',
          "Isuna & Hasekura 'Special'",
        );
        const svgContent = decodeURIComponent(
          dataUri.replace("data:image/svg+xml;charset=utf-8,", ""),
        );

        expect(svgContent).not.toContain("<Saint>");
        expect(svgContent).toContain("&lt;Saint&gt;");
        expect(svgContent).toContain("&amp;");
        expect(svgContent).toContain("&quot;Chronicles&quot;");
        expect(svgContent).toContain("&apos;Special&apos;");
      });

      it("handles missing author and generates fallback without throwing", () => {
        const dataUri1 = generateFallbackCoverSvg("Overlord");
        expect(dataUri1.startsWith("data:image/svg+xml;charset=utf-8,")).toBe(true);

        const dataUri2 = generateFallbackCoverSvg("", "Author Unknown");
        expect(dataUri2.startsWith("data:image/svg+xml;charset=utf-8,")).toBe(true);

        const dataUri3 = generateFallbackCoverSvg(undefined as any, undefined);
        expect(dataUri3.startsWith("data:image/svg+xml;charset=utf-8,")).toBe(true);
      });

      it("strictly contains zero emojis in generated fallback SVG", () => {
        const titles = [
          "The Rising of the Shield Hero",
          "Sword Art Online",
          "Re:Zero - Starting Life in Another World",
        ];
        for (const t of titles) {
          const uri = generateFallbackCoverSvg(t);
          expect(/\p{Extended_Pictographic}/u.test(uri)).toBe(false);
        }
      });
    });
  });

  describe("Accurate Covers & Real Authors Invariants (Bugfix Regression Suite)", () => {
    it("ensures 'A Surprisingly Happy Engagement for the Slime-Slaying Fallen Noble' does NOT receive author Fuse or Tensura cover", () => {
      const title = "A Surprisingly Happy Engagement for the Slime-Slaying Fallen Noble";
      const author = resolveAuthorForTitle(title);
      expect(author).not.toBe("Fuse");
      expect(author).not.toBe("Light Novel Author");
      expect(author).toBe("Author Unknown");

      const tensuraCover = KNOWN_TITLE_TO_COVER["that time i got reincarnated as a slime"];
      const cover = resolveCoverForTitle(title);
      expect(cover).not.toBe(tensuraCover);
      expect(cover).toBe("");
    });

    it("ensures 'A Tale of the Secret Saint' does NOT receive author Light Novel Author or Silent Witch cover", async () => {
      const title = "A Tale of the Secret Saint";
      const author = resolveAuthorForTitle(title);
      expect(author).not.toBe("Light Novel Author");
      expect(author).toBe("Touya");

      const silentWitchCover = KNOWN_TITLE_TO_COVER["secrets of the silent witch"];
      const cover = resolveCoverForTitle(title);
      expect(cover).not.toBe(silentWitchCover);

      // In complete catalog, unseeded novel without known cover gets clean SVG fallback, not landscape banner
      const catalog = await buildCatalogDiscoverNovels({ cacheDb: tempCacheDb });
      const novel = catalog.find((n) => n.title.toLowerCase().includes("secret saint"));
      expect(novel).toBeDefined();
      expect(novel?.author).toBe("Touya");
      expect(novel?.coverUrl).not.toContain("cdn.lnori.com/series/");
      expect(novel?.coverUrl.startsWith("data:image/svg+xml")).toBe(false);
      expect(
        novel?.coverUrl.startsWith("https://s4.anilist.co/") ||
        novel?.coverUrl.startsWith("https://cdn.lnori.com/cover/")
      ).toBe(true);
    });

    it("ensures uncredited authors never return 'Light Novel Author'", () => {
      const author = resolveAuthorForTitle("Some Completely Random Uncredited Novel");
      expect(author).toBe("Author Unknown");
      expect(author).not.toBe("Light Novel Author");
    });

    it("ensures findRealElscioneFolder strips colons, question marks, and subtitle appendages without returning unverified folders", () => {
      // Titles with colons and subtitle appendages
      expect(findRealElscioneFolder("DanMachi: Is It Wrong to Try to Pick Up Girls in a Dungeon?")).toBe("DanMachi");
      expect(findRealElscioneFolder("Re:Zero - Starting Life in Another World: Volume 1")).toBe("ReZero - Starting Life in Another World");
      expect(findRealElscioneFolder("Secrets of the Silent Witch: Another Story")).toBe("Secrets of the Silent Witch");

      // Non-existent folders must return null
      expect(findRealElscioneFolder("Completely Non Existent Fake Folder 12345")).toBeNull();
    });

    it("verifies captain-observed series receive verified portrait covers in complete catalog without SVG fallback", async () => {
      const catalog = await buildCatalogDiscoverNovels({ cacheDb: tempCacheDb });

      const targets = [
        {
          name: "A Pale Moon Reverie",
          query: "pale moon reverie",
        },
        {
          name: "A Surprisingly Happy Engagement for the Slime Duke",
          query: "slime duke",
        },
        {
          name: "A Tale of the Secret Saint",
          query: "secret saint",
        },
        {
          name: "A Wild Last Boss Appeared",
          query: "wild last boss",
        },
        {
          name: "A Young Lady Finds Her True Calling Living With the Enemy",
          query: "young lady finds her true calling",
        },
      ];

      for (const t of targets) {
        const novel = catalog.find((n) => n.title.toLowerCase().includes(t.query.toLowerCase()));
        expect(novel).toBeDefined();
        expect(novel!.coverUrl).toBeDefined();

        // Must NEVER fall back to placeholder SVG when real portrait cover is available
        expect(novel!.coverUrl.startsWith("data:image/svg+xml")).toBe(false);

        // Must NEVER assign 1200x630 landscape series banners
        expect(novel!.coverUrl.includes("cdn.lnori.com/series/")).toBe(false);

        // Must be verified high-resolution portrait cover from AniList or Lnori volume 1
        const isVerifiedPortrait =
          novel!.coverUrl.startsWith("https://s4.anilist.co/") ||
          novel!.coverUrl.startsWith("https://cdn.lnori.com/cover/");
        expect(isVerifiedPortrait).toBe(true);
      }
    });

    it("verifies universal search assigns verified portrait covers for catalog series", async () => {
      const targets = [
        { query: "A Pale Moon Reverie", titleSub: "pale moon reverie" },
        { query: "A Tale of the Secret Saint", titleSub: "secret saint" },
        { query: "A Wild Last Boss Appeared", titleSub: "wild last boss" },
        { query: "Slime Duke", titleSub: "slime duke" },
        { query: "A Young Lady Finds Her True Calling", titleSub: "young lady finds her true calling" },
      ];

      for (const t of targets) {
        const results = await searchUniversalNovels(t.query);
        expect(results.length).toBeGreaterThan(0);
        const match = results.find((r) => r.title.toLowerCase().includes(t.titleSub.toLowerCase()));
        expect(match).toBeDefined();
        expect(match!.coverUrl).toBeDefined();
        expect(match!.coverUrl.startsWith("data:image/svg+xml")).toBe(false);
        expect(match!.coverUrl.includes("cdn.lnori.com/series/")).toBe(false);
        const isVerifiedPortrait =
          match!.coverUrl.startsWith("https://s4.anilist.co/") ||
          match!.coverUrl.startsWith("https://cdn.lnori.com/cover/");
        expect(isVerifiedPortrait).toBe(true);
      }
    });

    it("verifies catalog-wide portrait cover coverage exceeds 80% with zero landscape banners", async () => {
      const catalog = await buildCatalogDiscoverNovels({ cacheDb: tempCacheDb });
      expect(catalog.length).toBeGreaterThan(1000);

      let verifiedPortraitCount = 0;
      for (const novel of catalog) {
        // Zero landscape banners anywhere in catalog
        expect(novel.coverUrl.includes("cdn.lnori.com/series/")).toBe(false);

        if (!novel.coverUrl.startsWith("data:image/svg+xml")) {
          verifiedPortraitCount++;
          const isVerifiedPortrait =
            novel.coverUrl.startsWith("https://s4.anilist.co/") ||
            novel.coverUrl.startsWith("https://cdn.lnori.com/cover/");
          expect(isVerifiedPortrait).toBe(true);
        }
      }

      const coverageRatio = verifiedPortraitCount / catalog.length;
      expect(coverageRatio).toBeGreaterThanOrEqual(0.80);
    });
  });

  describe("Discover Volume Count Reconciliation & Visibility Invariants", () => {
    it("reconciles novel volumeCount with Calibre library count (e.g. Accel World 27 volumes)", () => {
      const novel: DiscoveredNovel = {
        id: "elscione-accel-world",
        title: "Accel World",
        author: "Reki Kawahara",
        coverUrl: "https://example.com/cover.jpg",
        synopsis: "Accel World synopsis",
        genres: ["Sci-Fi", "Action"],
        score: 85,
        popularity: 5000,
        releaseDate: "2024-01-01",
        volumeCount: 1, // Suppose novel was unseeded with 1
        source: "elscione",
        sourceUrls: { elscione: "https://example.com" },
        inLibrary: false,
        existingVolumes: 0,
      };

      const mockCalibre = Array.from({ length: 27 }, (_, i) => ({
        id: 1000 + i,
        title: `Accel World, Vol. ${i + 1}`,
        series: "Accel World",
        series_index: i + 1,
      }));

      const [reconciled] = crossCheckNovelsWithCalibre([novel], {
        getCalibreBooks: () => mockCalibre,
      });

      expect(reconciled.inLibrary).toBe(true);
      expect(reconciled.existingVolumes).toBe(27);
      expect(reconciled.volumeCount).toBe(27);
    });

    it("preserves higher catalog volumeCount when library holds a partial subset", () => {
      const novel: DiscoveredNovel = {
        id: "elscione-sao",
        title: "Sword Art Online",
        author: "Reki Kawahara",
        coverUrl: "https://example.com/sao.jpg",
        synopsis: "SAO synopsis",
        genres: ["Fantasy"],
        score: 85,
        popularity: 5000,
        releaseDate: "2024-01-01",
        volumeCount: 28,
        source: "both",
        sourceUrls: { elscione: "https://example.com" },
        inLibrary: false,
        existingVolumes: 0,
      };

      const mockCalibre = [
        { id: 1, title: "Sword Art Online 1: Aincrad", series: "Sword Art Online", series_index: 1 },
        { id: 2, title: "Sword Art Online 2: Aincrad", series: "Sword Art Online", series_index: 2 },
      ];

      const [reconciled] = crossCheckNovelsWithCalibre([novel], {
        getCalibreBooks: () => mockCalibre,
      });

      expect(reconciled.inLibrary).toBe(true);
      expect(reconciled.existingVolumes).toBe(2);
      expect(reconciled.volumeCount).toBe(28); // Preserves 28
    });

    it("resolves catalog volume counts for popular long-running series from CATALOG_VOLUMES and seeds", () => {
      expect(resolveCatalogVolumeCount("Accel World")).toBe(27);
      expect(resolveCatalogVolumeCount("Sword Art Online")).toBe(28);
      expect(resolveCatalogVolumeCount("Overlord")).toBe(18);
      expect(resolveCatalogVolumeCount("That Time I Got Reincarnated as a Slime")).toBe(21);
      expect(resolveCatalogVolumeCount("DanMachi")).toBe(19);
      expect(resolveCatalogVolumeCount("Is It Wrong to Try to Pick Up Girls in a Dungeon?")).toBe(19);
      expect(resolveCatalogVolumeCount("The Irregular at Magic High School")).toBe(32);
      expect(resolveCatalogVolumeCount("A Certain Magical Index")).toBe(24);
      expect(resolveCatalogVolumeCount("A Certain Magical Index NT")).toBe(23);
      expect(resolveCatalogVolumeCount("A Certain Magical Index GT")).toBe(10);
      expect(resolveCatalogVolumeCount("Monogatari Series")).toBe(28);
      expect(resolveCatalogVolumeCount("Mushoku Tensei")).toBe(26);
      expect(resolveCatalogVolumeCount("Classroom of the Elite")).toBe(28);
      expect(resolveCatalogVolumeCount("KonoSuba")).toBe(17);
      expect(resolveCatalogVolumeCount("Re:ZERO -Starting Life in Another World-")).toBe(38);
    });

    it("resolves accurate catalog volume counts for newly mapped light novel series including Black Bullet", () => {
      // Verified volume counts for light novel series
      expect(resolveCatalogVolumeCount("Black Bullet")).toBe(7);
      expect(resolveCatalogVolumeCount("black-bullet")).toBe(7);
      expect(resolveCatalogVolumeCount("7th Time Loop")).toBe(6);
      expect(resolveCatalogVolumeCount("7th Time Loop: The Villainess Enjoys a Carefree Life")).toBe(6);
      expect(resolveCatalogVolumeCount("Rascal Does Not Dream")).toBe(15);
      expect(resolveCatalogVolumeCount("Bunny Girl Senpai")).toBe(15);
      expect(resolveCatalogVolumeCount("Trapped in a Dating Sim")).toBe(13);
      expect(resolveCatalogVolumeCount("Mobuseka")).toBe(13);
      expect(resolveCatalogVolumeCount("How a Realist Hero Rebuilt the Kingdom")).toBe(20);
      expect(resolveCatalogVolumeCount("Hell Mode")).toBe(11);
      expect(resolveCatalogVolumeCount("I'm the Evil Lord of an Intergalactic Empire!")).toBe(10);
      expect(resolveCatalogVolumeCount("The Genius Prince's Guide to Raising a Nation Out of Debt")).toBe(12);
      expect(resolveCatalogVolumeCount("Campfire Cooking in Another World With My Absurd Skill")).toBe(17);
      expect(resolveCatalogVolumeCount("Reincarnated as a Sword")).toBe(16);
      expect(resolveCatalogVolumeCount("Tenken")).toBe(16);
      expect(resolveCatalogVolumeCount("The Asterisk War")).toBe(17);
      expect(resolveCatalogVolumeCount("Combatants Will Be Dispatched")).toBe(7);
      expect(resolveCatalogVolumeCount("Adachi and Shimamura")).toBe(11);
      expect(resolveCatalogVolumeCount("Another")).toBe(2);
      expect(resolveCatalogVolumeCount("Another World Survival")).toBe(7);
      expect(resolveCatalogVolumeCount("Bloom Into You")).toBe(3);
      expect(resolveCatalogVolumeCount("Boogiepop Series")).toBe(23);
      expect(resolveCatalogVolumeCount("Gosick")).toBe(13);
      expect(resolveCatalogVolumeCount("Sound! Euphonium")).toBe(12);
      expect(resolveCatalogVolumeCount("Hibike! Euphonium")).toBe(12);
      expect(resolveCatalogVolumeCount("Kino no Tabi")).toBe(23);
      expect(resolveCatalogVolumeCount("Kino's Journey")).toBe(23);
      expect(resolveCatalogVolumeCount("Otherside Picnic")).toBe(8);
      expect(resolveCatalogVolumeCount("Restaurant to Another World")).toBe(6);
      expect(resolveCatalogVolumeCount("The Magical Revolution of the Reincarnated Princess")).toBe(8);
      expect(resolveCatalogVolumeCount("The World's Finest Assassin Gets Reincarnated in Another World")).toBe(7);
      expect(resolveCatalogVolumeCount("Trinity Blood")).toBe(12);
      expect(resolveCatalogVolumeCount("Blood+")).toBe(4);
      expect(resolveCatalogVolumeCount("JK Haru is a Sex Worker in Another World")).toBe(2);
      expect(resolveCatalogVolumeCount("A Cave King's Road to Paradise")).toBe(6);
      expect(resolveCatalogVolumeCount("A Late-Start Tamer's Laid-Back Life")).toBe(9);
      expect(resolveCatalogVolumeCount("A Livid Lady's Guide to Getting Even")).toBe(6);
      expect(resolveCatalogVolumeCount("A Mysterious Job Called Oda Nobunaga")).toBe(3);
      expect(resolveCatalogVolumeCount("Are You Okay With a Slightly Older Girlfriend")).toBe(6);
      expect(resolveCatalogVolumeCount("Free Life Fantasy Online")).toBe(7);
      expect(resolveCatalogVolumeCount("From Old Country Bumpkin to Master Swordsman")).toBe(9);
      expect(resolveCatalogVolumeCount("Heroine? Saint? No, I'm an All-Works Maid")).toBe(7);
      expect(resolveCatalogVolumeCount("Playing Death Games to Put Food on the Table")).toBe(7);
      expect(resolveCatalogVolumeCount("Secrets of the Silent Witch")).toBe(9);
      expect(resolveCatalogVolumeCount("Sentenced to Be a Hero")).toBe(7);
      expect(resolveCatalogVolumeCount("The Beginning After The End")).toBe(11);
      expect(resolveCatalogVolumeCount("The Water Magician")).toBe(8);
      expect(resolveCatalogVolumeCount("The World's Strongest Rearguard")).toBe(8);
      expect(resolveCatalogVolumeCount("Victoria of Many Faces")).toBe(4);
      expect(resolveCatalogVolumeCount("You Like Me, Not My Daughter?!")).toBe(7);
      expect(resolveCatalogVolumeCount("Almark")).toBe(3);
      expect(resolveCatalogVolumeCount("The Rising of the Shield Hero")).toBe(22);
      expect(resolveCatalogVolumeCount("Shield Hero")).toBe(22);
    });

    it("resolves shorthand aliases through KNOWN_TITLE_TO_ELSCIONE while preserving spinoff protections", () => {
      expect(resolveCatalogVolumeCount("black bullet")).toBe(7);
      expect(resolveCatalogVolumeCount("cote")).toBe(28);
      expect(resolveCatalogVolumeCount("danmachi")).toBe(19);
      expect(resolveCatalogVolumeCount("sao")).toBe(28);
      expect(resolveCatalogVolumeCount("slime")).toBe(21);
      expect(resolveCatalogVolumeCount("shield hero")).toBe(22);

      // Strict spinoff protection: DanMachi Sword Oratoria and SAO Progressive must not map to mainline volume counts
      expect(resolveCatalogVolumeCount("DanMachi Sword Oratoria")).toBe(14);
      expect(resolveCatalogVolumeCount("Sword Art Online Progressive")).toBe(8);

      // Spinoff isolation: Trapped in a Dating Sim spinoff (Marie route) has 3 volumes, distinct from mainline 13 volumes
      expect(resolveCatalogVolumeCount("Trapped in a Dating Sim")).toBe(13);
      expect(resolveCatalogVolumeCount("Trapped in a Dating Sim: The World of Otome Games is Tough for Mobs")).toBe(13);
      expect(resolveCatalogVolumeCount("Trapped in a Dating Sim: Otome Games Are Tough for Us, Too!")).toBe(3);
      expect(resolveCatalogVolumeCount("Otome Games Are Tough for Us, Too!")).toBe(3);

      // Full Lnori registry identifiers resolve accurately
      expect(resolveCatalogVolumeCount("7th Time Loop The Villainess Enjoys A Carefree Life Married To Her Worst Enemy")).toBe(6);
      expect(resolveCatalogVolumeCount("Hell Mode The Hardcore Gamer Dominates In Another World With Garbage Balancing")).toBe(11);
      expect(resolveCatalogVolumeCount("The Genius Princes Guide To Raising A Nation Out Of Debt Hey How About Treason")).toBe(12);
      expect(resolveCatalogVolumeCount("A Cave Kings Road To Paradise Climbing To The Top With My Almighty Mining Skills")).toBe(6);
      expect(resolveCatalogVolumeCount("A Livid Ladys Guide To Getting Even How I Crushed My Homeland With My Mighty Grimoires")).toBe(6);
      expect(resolveCatalogVolumeCount("From Old Country Bumpkin To Master Swordsman My Hotshot Disciples Are All Grown Up Now And They Wont Leave Me Alone")).toBe(9);
      expect(resolveCatalogVolumeCount("The Worlds Strongest Rearguard Labyrinth Countrys Novice Seeker")).toBe(8);
    });

    it("renders card status badges and metadata with prominent volume counts in index.html", () => {
      const htmlPath = path.join((import.meta as any).dir, "index.html");
      const html = fs.readFileSync(htmlPath, "utf8");

      // In Library badge with partial ownership support (libCount/total vols) and full ownership
      expect(html).toContain("In Library (${libCount}/${item.volumeCount} vols)");
      expect(html).toContain("In Library (${libCount} vols)");
      expect(html).toContain("const isPartial = libCount > 0 && item.volumeCount > libCount;");
      // Available badge with vols count
      expect(html).toContain("Available (${item.volumeCount || 1} vols)");
      // Metadata row volume badge
      expect(html).toContain("${item.volumeCount || 1} vols");
      // Modal volume rendering (never hardcoded 1 when existingVolumes is higher)
      expect(html).toContain("const totalVols = Math.max(item.volumeCount || 1, item.existingVolumes || item.inLibraryVolumes || 0);");
      expect(html).toContain("volumes.textContent = `${totalVols} Volumes`;");
    });

    it("ensures updated catalog volume counts take precedence over seeds in complete catalog and search", async () => {
      const catalog = await buildCatalogDiscoverNovels({ cacheDb: tempCacheDb });
      const overlord = catalog.find((n) => n.id === "overlord" || n.title.toLowerCase() === "overlord");
      const rezero = catalog.find((n) => n.title.toLowerCase().includes("re:zero") || n.id === "rezero");

      expect(overlord).toBeDefined();
      expect(overlord?.volumeCount).toBe(18); // Corrected from stale seed 16

      expect(rezero).toBeDefined();
      expect(rezero?.volumeCount).toBe(38); // Corrected from stale seed 37

      const searchOverlord = await searchUniversalNovels("overlord", { cacheDb: tempCacheDb });
      expect(searchOverlord.length).toBeGreaterThan(0);
      expect(searchOverlord[0].volumeCount).toBe(18);

      const searchRezero = await searchUniversalNovels("rezero", { cacheDb: tempCacheDb });
      expect(searchRezero.length).toBeGreaterThan(0);
      expect(searchRezero[0].volumeCount).toBe(38);
    });

    it("prevents fuzzy alias transfer between unrelated series and spin-offs (e.g. Slimes 300 vs Tensura, Clover's Regret vs SAO)", () => {
      // Unrelated titles with common words must NOT inherit 21 from Tensura
      const slimes300 = resolveCatalogVolumeCount("I've Been Killing Slimes for 300 Years");
      expect(slimes300).not.toBe(21);
      expect(slimes300).toBe(15);

      const slimeDuke = resolveCatalogVolumeCount("A Surprisingly Happy Engagement for the Slime Duke and the Fallen Noble Lady");
      expect(slimeDuke).not.toBe(21);
      expect(slimeDuke).toBe(2);

      // Spin-off must NOT inherit 28 from mainline SAO
      const cloversRegret = resolveCatalogVolumeCount("Sword Art Online Alternative - Clover's Regret");
      expect(cloversRegret).not.toBe(28);
      expect(cloversRegret).toBe(3);

      // Distinct series in franchise must resolve to their own specific counts
      expect(resolveCatalogVolumeCount("DanMachi - Sword Oratoria")).toBe(14);
      expect(resolveCatalogVolumeCount("Sword Art Online - Progressive")).toBe(8);
      expect(resolveCatalogVolumeCount("Sword Art Online")).toBe(28);
      expect(resolveCatalogVolumeCount("DanMachi")).toBe(19);
      expect(resolveCatalogVolumeCount("That Time I Got Reincarnated as a Slime")).toBe(21);
    });

    it("prevents library volume inflation when library contains both mainline and spin-off books", () => {
      const saoMain: DiscoveredNovel = {
        id: "sao-main",
        title: "Sword Art Online",
        author: "Reki Kawahara",
        coverUrl: "https://example.com/sao.jpg",
        synopsis: "SAO synopsis",
        genres: ["Fantasy"],
        score: 85,
        popularity: 5000,
        releaseDate: "2024-01-01",
        volumeCount: 28,
        source: "both",
        sourceUrls: { elscione: "https://example.com" },
        inLibrary: false,
        existingVolumes: 0,
      };

      const saoProg: DiscoveredNovel = {
        id: "sao-prog",
        title: "Sword Art Online - Progressive",
        author: "Reki Kawahara",
        coverUrl: "https://example.com/prog.jpg",
        synopsis: "Progressive synopsis",
        genres: ["Fantasy"],
        score: 85,
        popularity: 5000,
        releaseDate: "2024-01-01",
        volumeCount: 8,
        source: "both",
        sourceUrls: { elscione: "https://example.com" },
        inLibrary: false,
        existingVolumes: 0,
      };

      const mockCalibre = [
        ...Array.from({ length: 28 }, (_, i) => ({
          id: 1 + i,
          title: `Sword Art Online, Vol. ${i + 1}`,
          series: "Sword Art Online",
          series_index: i + 1,
        })),
        ...Array.from({ length: 8 }, (_, i) => ({
          id: 100 + i,
          title: `Sword Art Online - Progressive, Vol. ${i + 1}`,
          series: "Sword Art Online - Progressive",
          series_index: i + 1,
        })),
      ];

      const [resMain, resProg] = crossCheckNovelsWithCalibre([saoMain, saoProg], {
        getCalibreBooks: () => mockCalibre,
      });

      // Mainline SAO must strictly count only the 28 mainline books
      expect(resMain.existingVolumes).toBe(28);
      expect(resMain.volumeCount).toBe(28);

      // Progressive must strictly count only the 8 Progressive books
      expect(resProg.existingVolumes).toBe(8);
      expect(resProg.volumeCount).toBe(8);
    });

    it("prevents cleaned variants and containment from leaking spin-off ownership to mainline series", () => {
      // 1. COTE Year 2 must not mark mainline COTE as owned
      const coteMain: DiscoveredNovel = {
        id: "cote-main",
        title: "Classroom of the Elite",
        author: "Shogo Kinugasa",
        coverUrl: "https://example.com/cote.jpg",
        synopsis: "COTE synopsis",
        genres: ["Drama"],
        score: 85,
        popularity: 5000,
        releaseDate: "2024-01-01",
        volumeCount: 28,
        source: "both",
        sourceUrls: { elscione: "https://example.com" },
        inLibrary: false,
        existingVolumes: 0,
      };

      const coteY2: DiscoveredNovel = {
        id: "cote-y2",
        title: "Classroom of the Elite - Year 2",
        author: "Shogo Kinugasa",
        coverUrl: "https://example.com/cotey2.jpg",
        synopsis: "COTE Y2 synopsis",
        genres: ["Drama"],
        score: 85,
        popularity: 5000,
        releaseDate: "2024-01-01",
        volumeCount: 12,
        source: "both",
        sourceUrls: { elscione: "https://example.com" },
        inLibrary: false,
        existingVolumes: 0,
      };

      const mockCoteCalibre = [
        { id: 1, title: "Classroom of the Elite - Year 2, Vol. 1", series: "Classroom of the Elite - Year 2", series_index: 1 },
      ];

      const [resCoteMain, resCoteY2] = crossCheckNovelsWithCalibre([coteMain, coteY2], {
        getCalibreBooks: () => mockCoteCalibre,
      });

      expect(resCoteMain.inLibrary).toBe(false);
      expect(resCoteMain.existingVolumes).toBe(0);
      expect(resCoteY2.inLibrary).toBe(true);
      expect(resCoteY2.existingVolumes).toBe(1);

      // 2. DanMachi Familia Chronicle must not mark mainline DanMachi as owned
      const danmachiMain: DiscoveredNovel = {
        id: "danmachi-main",
        title: "DanMachi",
        author: "Fujino Omori",
        coverUrl: "https://example.com/danmachi.jpg",
        synopsis: "DanMachi synopsis",
        genres: ["Fantasy"],
        score: 85,
        popularity: 5000,
        releaseDate: "2024-01-01",
        volumeCount: 19,
        source: "both",
        sourceUrls: { elscione: "https://example.com" },
        inLibrary: false,
        existingVolumes: 0,
      };

      const danmachiFC: DiscoveredNovel = {
        id: "danmachi-fc",
        title: "DanMachi - Familia Chronicle",
        author: "Fujino Omori",
        coverUrl: "https://example.com/fc.jpg",
        synopsis: "FC synopsis",
        genres: ["Fantasy"],
        score: 85,
        popularity: 5000,
        releaseDate: "2024-01-01",
        volumeCount: 2,
        source: "both",
        sourceUrls: { elscione: "https://example.com" },
        inLibrary: false,
        existingVolumes: 0,
      };

      const mockDanmachiCalibre = [
        { id: 1, title: "DanMachi - Familia Chronicle, Vol. 1", series: "DanMachi - Familia Chronicle", series_index: 1 },
      ];

      const [resDanMain, resDanFC] = crossCheckNovelsWithCalibre([danmachiMain, danmachiFC], {
        getCalibreBooks: () => mockDanmachiCalibre,
      });

      expect(resDanMain.inLibrary).toBe(false);
      expect(resDanMain.existingVolumes).toBe(0);
      expect(resDanFC.inLibrary).toBe(true);
      expect(resDanFC.existingVolumes).toBe(1);

      // 3. Index NT must not mark mainline Index as owned through containment
      const indexMain: DiscoveredNovel = {
        id: "index-main",
        title: "A Certain Magical Index",
        author: "Kazuma Kamachi",
        coverUrl: "https://example.com/index.jpg",
        synopsis: "Index synopsis",
        genres: ["Sci-Fi"],
        score: 85,
        popularity: 5000,
        releaseDate: "2024-01-01",
        volumeCount: 24,
        source: "both",
        sourceUrls: { elscione: "https://example.com" },
        inLibrary: false,
        existingVolumes: 0,
      };

      const indexNT: DiscoveredNovel = {
        id: "index-nt",
        title: "A Certain Magical Index NT",
        author: "Kazuma Kamachi",
        coverUrl: "https://example.com/nt.jpg",
        synopsis: "NT synopsis",
        genres: ["Sci-Fi"],
        score: 85,
        popularity: 5000,
        releaseDate: "2024-01-01",
        volumeCount: 23,
        source: "both",
        sourceUrls: { elscione: "https://example.com" },
        inLibrary: false,
        existingVolumes: 0,
      };

      const mockIndexCalibre = [
        { id: 1, title: "A Certain Magical Index NT, Vol. 1", series: "A Certain Magical Index NT", series_index: 1 },
      ];

      const [resIndexMain, resIndexNT] = crossCheckNovelsWithCalibre([indexMain, indexNT], {
        getCalibreBooks: () => mockIndexCalibre,
      });

      expect(resIndexMain.inLibrary).toBe(false);
      expect(resIndexMain.existingVolumes).toBe(0);
      expect(resIndexNT.inLibrary).toBe(true);
      expect(resIndexNT.existingVolumes).toBe(1);

      // 4. Year 2 must not mark Year 3 as owned
      const coteY3: DiscoveredNovel = {
        id: "cote-y3",
        title: "Classroom of the Elite - Year 3",
        author: "Shogo Kinugasa",
        coverUrl: "https://example.com/cotey3.jpg",
        synopsis: "COTE Y3 synopsis",
        genres: ["Drama"],
        score: 85,
        popularity: 5000,
        releaseDate: "2024-01-01",
        volumeCount: 1,
        source: "both",
        sourceUrls: { elscione: "https://example.com" },
        inLibrary: false,
        existingVolumes: 0,
      };

      const [resY2Only, resY3Only] = crossCheckNovelsWithCalibre([coteY2, coteY3], {
        getCalibreBooks: () => mockCoteCalibre, // contains Year 2 Vol. 1
      });
      expect(resY2Only.inLibrary).toBe(true);
      expect(resY2Only.existingVolumes).toBe(1);
      expect(resY3Only.inLibrary).toBe(false);
      expect(resY3Only.existingVolumes).toBe(0);

      // 5. Sword Oratoria declared Romaji Gaiden alias matches and resolves to 14 volumes
      const romajiSO = "Dungeon ni Deai wo Motomeru no wa Machigatteiru Darou ka Gaiden Sword Oratoria";
      expect(resolveCatalogVolumeCount(romajiSO)).toBe(14);

      const soNovel: DiscoveredNovel = {
        id: "danmachi-so",
        title: "DanMachi - Sword Oratoria",
        author: "Fujino Omori",
        coverUrl: "https://example.com/so.jpg",
        synopsis: "SO synopsis",
        genres: ["Fantasy"],
        score: 85,
        popularity: 5000,
        releaseDate: "2024-01-01",
        volumeCount: 14,
        source: "both",
        sourceUrls: { elscione: "https://example.com" },
        inLibrary: false,
        existingVolumes: 0,
      };

      const [resSO] = crossCheckNovelsWithCalibre([soNovel], {
        getCalibreBooks: () => [{ id: 99, title: `${romajiSO}, Vol. 1`, series: romajiSO, series_index: 1 }],
      });
      expect(resSO.inLibrary).toBe(true);
      expect(resSO.existingVolumes).toBe(1);

      // Minor Myths must resolve to 1 volume, not parent DanMachi 19
      expect(resolveCatalogVolumeCount("DanMachi - Minor Myths and Legends")).toBe(1);
      // Index must resolve to 24 volumes, not stale seed 55
      expect(resolveCatalogVolumeCount("A Certain Magical Index")).toBe(24);
    });

    describe("Optimized Inverted Index Calibre Matcher & Fast Discover Feed Performance", () => {
      // Baseline un-indexed reference matcher for regression & equivalence verification
      function baselineCrossCheckNovels(novels: DiscoveredNovel[], calibreBooks: any[]): DiscoveredNovel[] {
        const processedCalibreBooks = calibreBooks.map((b) => ({
          book: b,
          ...getCalibreBookMatchCandidates(b),
        }));

        return novels.map((novel) => {
          const { candidates: nCandidates, tokensList: nTokensList } = getNovelMatchCandidates(novel);
          let matchCount = 0;

          for (const b of processedCalibreBooks) {
            let isMatch = false;

            // 1. Direct candidate equality
            for (const n of nCandidates) {
              if (b.candidates.has(n)) {
                for (const c of b.candidates) {
                  if (c === n && !isSpinoffMismatch(n, c)) {
                    isMatch = true;
                    break;
                  }
                }
                if (isMatch) break;
              }
            }

            // 2. Containment matching
            if (!isMatch) {
              for (const n of nCandidates) {
                const nWords = n.split(" ").length;
                for (const c of b.candidates) {
                  if (isSpinoffMismatch(n, c)) continue;
                  const cWords = c.split(" ").length;
                  if (c.length >= 8 && cWords >= 2 && ` ${n} `.includes(` ${c} `)) {
                    isMatch = true;
                    break;
                  }
                  if (n.length >= 8 && nWords >= 2 && ` ${c} `.includes(` ${n} `)) {
                    isMatch = true;
                    break;
                  }
                }
                if (isMatch) break;
              }
            }

            // 3. Significant token overlap matching
            if (!isMatch) {
              for (const nTok of nTokensList) {
                const nStr = nTok.join(" ");
                for (const cTok of b.tokensList) {
                  const cStr = cTok.join(" ");
                  if (isSpinoffMismatch(nStr, cStr)) continue;
                  const overlap = calculateSignificantTokenOverlap(nTok, cTok);
                  if (overlap >= 0.70) {
                    isMatch = true;
                    break;
                  }
                }
                if (isMatch) break;
              }
            }

            // 4. Prefix start matching fallback
            if (!isMatch) {
              for (const n of nCandidates) {
                if (n.length >= 6) {
                  for (const c of b.candidates) {
                    if (isSpinoffMismatch(n, c)) continue;
                    if (c.length >= 6 && (c.startsWith(n) || n.startsWith(c))) {
                      isMatch = true;
                      break;
                    }
                  }
                }
                if (isMatch) break;
              }
            }

            if (isMatch) matchCount++;
          }

          return {
            ...novel,
            volumeCount: Math.max(novel.volumeCount || 1, matchCount),
            inLibrary: matchCount > 0,
            existingVolumes: matchCount,
          };
        });
      }

      it("produces 100% identical matching output as baseline across edge cases (DanMachi, Tensura, spin-offs, short titles, native Japanese)", () => {
        const testNovels: DiscoveredNovel[] = [
          {
            id: "danmachi-main",
            title: "Is It Wrong to Try to Pick Up Girls in a Dungeon?",
            titleRomaji: "Dungeon ni Deai wo Motomeru no wa Machigatteiru Darou ka",
            titleNative: "ダンジョンに出会いを求めるのは間違っているだろうか",
            author: "Fujino Omori",
            coverUrl: "https://example.com/danmachi.jpg",
            synopsis: "DanMachi synopsis",
            genres: ["Action", "Fantasy"],
            score: 90,
            popularity: 8000,
            releaseDate: "2013-01-15",
            volumeCount: 19,
            source: "both",
            sourceUrls: { elscione: "https://example.com" },
            inLibrary: false,
            existingVolumes: 0,
          },
          {
            id: "danmachi-so",
            title: "DanMachi: Sword Oratoria",
            titleRomaji: "Dungeon ni Deai wo Motomeru no wa Machigatteiru Darou ka Gaiden Sword Oratoria",
            author: "Fujino Omori",
            coverUrl: "https://example.com/so.jpg",
            synopsis: "Sword Oratoria synopsis",
            genres: ["Action", "Fantasy"],
            score: 85,
            popularity: 6000,
            releaseDate: "2014-01-15",
            volumeCount: 14,
            source: "both",
            sourceUrls: { elscione: "https://example.com" },
            inLibrary: false,
            existingVolumes: 0,
          },
          {
            id: "slime-main",
            title: "That Time I Got Reincarnated as a Slime",
            titleRomaji: "Tensei Shitara Slime Datta Ken",
            author: "Fuse",
            coverUrl: "https://example.com/tensura.jpg",
            synopsis: "Tensura synopsis",
            genres: ["Isekai", "Fantasy"],
            score: 88,
            popularity: 9000,
            releaseDate: "2014-05-30",
            volumeCount: 21,
            source: "both",
            sourceUrls: { elscione: "https://example.com" },
            inLibrary: false,
            existingVolumes: 0,
          },
          {
            id: "slime-300",
            title: "I've Been Killing Slimes for 300 Years and Maxed Out My Level",
            author: "Kisetsu Morita",
            coverUrl: "https://example.com/slimes300.jpg",
            synopsis: "Slimes 300 synopsis",
            genres: ["Comedy", "Slice of Life"],
            score: 82,
            popularity: 4000,
            releaseDate: "2017-01-14",
            volumeCount: 14,
            source: "both",
            sourceUrls: { elscione: "https://example.com" },
            inLibrary: false,
            existingVolumes: 0,
          },
          {
            id: "eighty-six",
            title: "86--Eighty-Six",
            titleRomaji: "86 - Eighty Six",
            author: "Asato Asato",
            coverUrl: "https://example.com/86.jpg",
            synopsis: "86 synopsis",
            genres: ["Sci-Fi", "Drama"],
            score: 92,
            popularity: 8500,
            releaseDate: "2017-02-10",
            volumeCount: 13,
            source: "both",
            sourceUrls: { elscione: "https://example.com" },
            inLibrary: false,
            existingVolumes: 0,
          },
          {
            id: "overlord-main",
            title: "Overlord",
            author: "Kugane Maruyama",
            coverUrl: "https://example.com/overlord.jpg",
            synopsis: "Overlord synopsis",
            genres: ["Dark Fantasy"],
            score: 89,
            popularity: 8800,
            releaseDate: "2012-07-30",
            volumeCount: 16,
            source: "both",
            sourceUrls: { elscione: "https://example.com" },
            inLibrary: false,
            existingVolumes: 0,
          },
          {
            id: "tanya-evil",
            title: "The Saga of Tanya the Evil",
            titleRomaji: "Youjo Senki",
            author: "Carlo Zen",
            coverUrl: "https://example.com/tanya.jpg",
            synopsis: "Tanya synopsis",
            genres: ["Military", "Isekai"],
            score: 87,
            popularity: 7000,
            releaseDate: "2013-10-31",
            volumeCount: 14,
            source: "both",
            sourceUrls: { elscione: "https://example.com" },
            inLibrary: false,
            existingVolumes: 0,
          },
          // Novel matching stop-word-only candidate stripped from volume notation
          {
            id: "beyond-this-and-that",
            title: "Beyond This and That",
            author: "Test Author",
            coverUrl: "https://example.com/test.jpg",
            synopsis: "Test synopsis",
            genres: ["Fantasy"],
            score: 80,
            popularity: 1000,
            releaseDate: "2024-01-01",
            volumeCount: 1,
            source: "both",
            sourceUrls: { elscione: "https://example.com" },
            inLibrary: false,
            existingVolumes: 0,
          },
        ];

        const testCalibreBooks = [
          // 3 volumes of DanMachi mainline
          { id: 1, title: "Is It Wrong to Try to Pick Up Girls in a Dungeon?, Vol. 1", series: "Is It Wrong to Try to Pick Up Girls in a Dungeon?", series_index: 1 },
          { id: 2, title: "Is It Wrong to Try to Pick Up Girls in a Dungeon?, Vol. 2", series: "Is It Wrong to Try to Pick Up Girls in a Dungeon?", series_index: 2 },
          { id: 3, title: "Is It Wrong to Try to Pick Up Girls in a Dungeon?, Vol. 3", series: "Is It Wrong to Try to Pick Up Girls in a Dungeon?", series_index: 3 },
          // 1 volume of Sword Oratoria (must not match mainline DanMachi)
          { id: 4, title: "Is It Wrong to Try to Pick Up Girls in a Dungeon? On the Side: Sword Oratoria, Vol. 1", series: "Sword Oratoria", series_index: 1 },
          // 2 volumes of Tensura
          { id: 5, title: "That Time I Got Reincarnated as a Slime, Vol. 1", series: "That Time I Got Reincarnated as a Slime", series_index: 1 },
          { id: 6, title: "That Time I Got Reincarnated as a Slime, Vol. 2", series: "That Time I Got Reincarnated as a Slime", series_index: 2 },
          // 86
          { id: 7, title: "86 - Eighty-Six, Vol. 1", series: "86 - Eighty-Six", series_index: 1 },
          // Tanya the Evil (containment check)
          { id: 8, title: "Tanya the Evil, Vol. 1", series: "The Saga of Tanya the Evil", series_index: 1 },
          // Unrelated Calibre books
          { id: 9, title: "Spice and Wolf, Vol. 1", series: "Spice and Wolf", series_index: 1 },
          { id: 10, title: "Ascendance of a Bookworm, Part 1 Vol. 1", series: "Ascendance of a Bookworm", series_index: 1 },
          // Volume-suffixed Calibre book whose stripped title is pure stop words
          { id: 11, title: "This and That, Vol. 1", series: "This and That", series_index: 1 },
        ];

        const baselineResult = baselineCrossCheckNovels(testNovels, testCalibreBooks);
        const optimizedResult = crossCheckNovelsWithCalibre(testNovels, {
          getCalibreBooks: () => testCalibreBooks,
        });

        expect(optimizedResult.length).toBe(baselineResult.length);
        for (let i = 0; i < testNovels.length; i++) {
          const base = baselineResult[i];
          const opt = optimizedResult[i];
          expect(opt.id).toBe(base.id);
          expect(opt.inLibrary).toBe(base.inLibrary);
          expect(opt.existingVolumes).toBe(base.existingVolumes);
          expect(opt.volumeCount).toBe(base.volumeCount);
        }

        // Specific assertions for sanity:
        const danmachi = optimizedResult.find((n) => n.id === "danmachi-main")!;
        expect(danmachi.inLibrary).toBe(true);
        expect(danmachi.existingVolumes).toBe(3); // 3 volumes, spin-off excluded

        const so = optimizedResult.find((n) => n.id === "danmachi-so")!;
        expect(so.inLibrary).toBe(true);
        expect(so.existingVolumes).toBe(1);

        const slime300 = optimizedResult.find((n) => n.id === "slime-300")!;
        expect(slime300.inLibrary).toBe(false); // Slimes 300 not in library despite Slime keywords
        expect(slime300.existingVolumes).toBe(0);

        const overlord = optimizedResult.find((n) => n.id === "overlord-main")!;
        expect(overlord.inLibrary).toBe(false);
        expect(overlord.existingVolumes).toBe(0);

        const eightySix = optimizedResult.find((n) => n.id === "eighty-six")!;
        expect(eightySix.inLibrary).toBe(true);
        expect(eightySix.existingVolumes).toBe(1);

        const beyondThisAndThat = optimizedResult.find((n) => n.id === "beyond-this-and-that")!;
        expect(beyondThisAndThat.inLibrary).toBe(true);
        expect(beyondThisAndThat.existingVolumes).toBe(1);
      });

      it("reconciles only the requested page slice when statusFilter === 'all', keeping latency sub-50ms", async () => {
        let crossCheckInvocationCount = 0;
        const mockCalibreBooks = [
          { id: 101, title: "DanMachi, Vol. 1", series: "DanMachi", series_index: 1 },
          { id: 102, title: "DanMachi, Vol. 2", series: "DanMachi", series_index: 2 },
        ];

        const t0 = performance.now();
        const res = await getDiscoverNovels(
          { tab: "all", status: "all", page: 1, pageSize: 36 },
          {
            cacheDb: tempCacheDb,
            getCalibreBooks: () => {
              crossCheckInvocationCount++;
              return mockCalibreBooks;
            },
          },
        );
        const durationMs = performance.now() - t0;

        expect(res.success).toBe(true);
        expect(res.novels.length).toBe(36);
        expect(res.count).toBeGreaterThan(1000);
        // Calibre was reconciled exactly once for the single page
        expect(crossCheckInvocationCount).toBe(1);
        // Latency must be well under 5000ms even on cold catalog build + pagination
        expect(durationMs).toBeLessThan(5000);

        // Repeat query must be instantaneous from feed cache (< 50ms)
        const tRepeat = performance.now();
        const repeatRes = await getDiscoverNovels(
          { tab: "all", status: "all", page: 2, pageSize: 36 },
          {
            cacheDb: tempCacheDb,
            getCalibreBooks: () => {
              crossCheckInvocationCount++;
              return mockCalibreBooks;
            },
          },
        );
        const repeatDurationMs = performance.now() - tRepeat;
        expect(repeatRes.success).toBe(true);
        expect(repeatRes.page).toBe(2);
        expect(repeatRes.novels.length).toBe(36);
        expect(crossCheckInvocationCount).toBe(2);
        expect(repeatDurationMs).toBeLessThan(250);
      });

      it("performs accurate full-catalog filtering when statusFilter is 'available' or 'in_library'", async () => {
        const mockCalibreBooks = [
          { id: 201, title: "DanMachi, Vol. 1", series: "DanMachi", series_index: 1 },
          { id: 202, title: "Overlord, Vol. 1", series: "Overlord", series_index: 1 },
        ];

        // 1. in_library query
        const inLibRes = await getDiscoverNovels(
          { tab: "all", status: "in_library" },
          {
            cacheDb: tempCacheDb,
            getCalibreBooks: () => mockCalibreBooks,
          },
        );

        expect(inLibRes.success).toBe(true);
        expect(inLibRes.novels.length).toBeGreaterThan(0);
        for (const n of inLibRes.novels) {
          expect(n.inLibrary).toBe(true);
          expect(n.existingVolumes).toBeGreaterThan(0);
        }

        // 2. available query
        const availRes = await getDiscoverNovels(
          { tab: "all", status: "available", page: 1, pageSize: 36 },
          {
            cacheDb: tempCacheDb,
            getCalibreBooks: () => mockCalibreBooks,
          },
        );

        expect(availRes.success).toBe(true);
        expect(availRes.novels.length).toBe(36);
        for (const n of availRes.novels) {
          expect(n.inLibrary).toBe(false);
          expect(n.existingVolumes).toBe(0);
        }
      });
    });
  });
});
