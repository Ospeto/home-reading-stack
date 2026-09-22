import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  decodeHtmlEntities,
  sanitizeSynopsis,
  extractDescriptionFromOpfXml,
  extractEpubDescription,
  resolveEpubFilePath,
  isCommentsEmpty,
  fetchOnlineSynopsis,
  MIN_CONFIDENCE_THRESHOLD,
  runEnrichSynopses,
  formatEnrichReport,
  type EnrichBookCandidate,
} from "./enrich-synopses";
import { getBsdtarPath } from "../uploader/security";
import { spawnSync } from "node:child_process";

describe("LightHouse Batch Synopsis Enrichment Tool", () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "enrich-test-"));
  });

  afterEach(() => {
    if (fs.existsSync(tempDir)) {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  // ==========================================================================
  // 1. HTML & Synopsis Sanitization
  // ==========================================================================
  describe("1. HTML & Synopsis Sanitization", () => {
    it("decodes HTML entities properly", () => {
      const input = "Tom &amp; Jerry &quot;Show&quot; &lt;b&gt;Special&lt;/b&gt; &#39;Edition&#39; &nbsp;";
      const decoded = decodeHtmlEntities(input);
      expect(decoded).toContain("Tom & Jerry");
      expect(decoded).toContain('"Show"');
      expect(decoded).toContain("<b>Special</b>");
      expect(decoded).toContain("'Edition'");
    });

    it("strips script, style, and dangerous tags while preserving clean paragraphs", () => {
      const raw = `
        <script>alert('xss');</script>
        <style>body { color: red; }</style>
        <p>This is a heroic tale of a great warrior.</p>
        <iframe src="https://evil.com"></iframe>
        <p>He fought bravely across the kingdoms.</p>
      `;
      const cleaned = sanitizeSynopsis(raw);
      expect(cleaned).not.toContain("<script>");
      expect(cleaned).not.toContain("alert");
      expect(cleaned).not.toContain("<style>");
      expect(cleaned).not.toContain("<iframe>");
      expect(cleaned).toContain("<p>This is a heroic tale of a great warrior.</p>");
      expect(cleaned).toContain("<p>He fought bravely across the kingdoms.</p>");
    });

    it("strips digital library watermarks, pirate domains, and telegram links", () => {
      const raw = `
        <p>[z-lib.org] Overlord volume one begins with Momonga.</p>
        <p>Downloaded from https://t.me/LightNovelsChannel for free.</p>
        <p>Join our telegram channel: https://t.me/ln_books at: https://t.me/ln_books</p>
        <p>The adventure continues beyond the Great Tomb of Nazarick.</p>
      `;
      const cleaned = sanitizeSynopsis(raw);
      expect(cleaned).not.toContain("z-lib");
      expect(cleaned).not.toContain("https://t.me");
      expect(cleaned).not.toContain("Downloaded from");
      expect(cleaned).not.toContain("Join our telegram");
      expect(cleaned).toContain("<p>Overlord volume one begins with Momonga.</p>");
      expect(cleaned).toContain("<p>The adventure continues beyond the Great Tomb of Nazarick.</p>");
    });

    it("handles entity-encoded HTML descriptions from EPUBs", () => {
      const raw = "&lt;p&gt;When Hermione finds a way to bring Sirius back from the veil, her actions change the rest of the war.&lt;/p&gt;";
      const cleaned = sanitizeSynopsis(raw);
      expect(cleaned).toBe("<p>When Hermione finds a way to bring Sirius back from the veil, her actions change the rest of the war.</p>");
    });

    it("unwraps XML CDATA blocks cleanly without stripping content", () => {
      const raw = "<![CDATA[A fantasy story about an undead skeletal ruler in a new world.]]>";
      const cleaned = sanitizeSynopsis(raw);
      expect(cleaned).toBe("<p>A fantasy story about an undead skeletal ruler in a new world.</p>");

      const rawWithHtml = "<![CDATA[<p>First paragraph.</p><p>Second paragraph.</p>]]>";
      const cleanedWithHtml = sanitizeSynopsis(rawWithHtml);
      expect(cleanedWithHtml).toContain("<p>First paragraph.</p>");
      expect(cleanedWithHtml).toContain("<p>Second paragraph.</p>");
    });

    it("returns empty string on empty, whitespace, or pure junk content", () => {
      expect(sanitizeSynopsis("")).toBe("");
      expect(sanitizeSynopsis("   \n\t  ")).toBe("");
      expect(sanitizeSynopsis("<script>alert(1);</script>")).toBe("");
      expect(sanitizeSynopsis("[z-lib.org] https://t.me/channel")).toBe("");
    });
  });

  // ==========================================================================
  // 2. OPF XML & Local EPUB Extraction
  // ==========================================================================
  describe("2. OPF XML & Local EPUB Extraction", () => {
    it("extracts dc:description from standard OPF XML", () => {
      const opfXml = `
        <?xml version="1.0" encoding="utf-8"?>
        <package xmlns="http://www.idpf.org/2007/opf" version="2.0">
          <metadata xmlns:dc="http://purl.org/dc/elements/1.1/">
            <dc:title>Overlord</dc:title>
            <dc:description>A fantasy story about an undead skeletal ruler in a new world.</dc:description>
          </metadata>
        </package>
      `;
      const desc = extractDescriptionFromOpfXml(opfXml);
      expect(desc).toBe("<p>A fantasy story about an undead skeletal ruler in a new world.</p>");
    });

    it("extracts dc:description containing CDATA sections from OPF XML", () => {
      const opfXml = `
        <package version="2.0">
          <metadata xmlns:dc="http://purl.org/dc/elements/1.1/">
            <dc:title>Overlord</dc:title>
            <dc:description><![CDATA[A fantasy story about an undead skeletal ruler in a new world.]]></dc:description>
          </metadata>
        </package>
      `;
      const desc = extractDescriptionFromOpfXml(opfXml);
      expect(desc).toBe("<p>A fantasy story about an undead skeletal ruler in a new world.</p>");
    });

    it("extracts schema:description from EPUB3 meta elements", () => {
      const opfXml = `
        <?xml version="1.0" encoding="utf-8"?>
        <package xmlns="http://www.idpf.org/2007/opf" version="3.0">
          <metadata>
            <dc:title>Mushoku Tensei</dc:title>
            <meta property="schema:description">A 34-year-old NEET is reincarnated into a magical world.</meta>
          </metadata>
        </package>
      `;
      const desc = extractDescriptionFromOpfXml(opfXml);
      expect(desc).toBe("<p>A 34-year-old NEET is reincarnated into a magical world.</p>");
    });

    it("extracts description from meta content attribute", () => {
      const opfXml = `
        <package version="3.0">
          <metadata>
            <meta name="description" content="In a hole in the ground there lived a hobbit." />
          </metadata>
        </package>
      `;
      const desc = extractDescriptionFromOpfXml(opfXml);
      expect(desc).toBe("<p>In a hole in the ground there lived a hobbit.</p>");
    });

    it("returns null if no description tag is found or text is too short", () => {
      const opfXml = `
        <package version="2.0">
          <metadata>
            <dc:title>Book Without Description</dc:title>
          </metadata>
        </package>
      `;
      expect(extractDescriptionFromOpfXml(opfXml)).toBeNull();
      expect(extractDescriptionFromOpfXml("<package><metadata><dc:description>Short</dc:description></metadata></package>")).toBeNull();
    });

    it("extracts description from a real physical EPUB file on disk", () => {
      const containerXml = `<?xml version="1.0"?>
        <container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container">
          <rootfiles>
            <rootfile full-path="OEBPS/content.opf" media-type="application/oebps-package+xml"/>
          </rootfiles>
        </container>`;

      const opfXml = `<?xml version="1.0" encoding="utf-8"?>
        <package xmlns="http://www.idpf.org/2007/opf" version="3.0">
          <metadata xmlns:dc="http://purl.org/dc/elements/1.1/">
            <dc:title>Synthetic Test Book</dc:title>
            <dc:description>This is a synthetic EPUB description extracted directly from disk.</dc:description>
          </metadata>
        </package>`;

      const staging = path.join(tempDir, "epub-staging");
      fs.mkdirSync(path.join(staging, "META-INF"), { recursive: true });
      fs.mkdirSync(path.join(staging, "OEBPS"), { recursive: true });
      fs.writeFileSync(path.join(staging, "mimetype"), "application/epub+zip");
      fs.writeFileSync(path.join(staging, "META-INF", "container.xml"), containerXml);
      fs.writeFileSync(path.join(staging, "OEBPS", "content.opf"), opfXml);

      const testEpubPath = path.join(tempDir, "test-book.epub");
      const bsdtar = spawnSync(getBsdtarPath(), ["-cf", testEpubPath, "-C", staging, "."]);
      expect(bsdtar.status).toBe(0);

      const extracted = extractEpubDescription(testEpubPath);
      expect(extracted).toBe("<p>This is a synthetic EPUB description extracted directly from disk.</p>");
    });

    it("resolves physical EPUB file path from Calibre book path and data name", () => {
      const libDir = path.join(tempDir, "calibre-lib");
      const bookRel = "Author/Book Title (10)";
      const bookDir = path.join(libDir, bookRel);
      fs.mkdirSync(bookDir, { recursive: true });

      const epubFile = path.join(bookDir, "Book Title - Author.epub");
      fs.writeFileSync(epubFile, "mock-epub-bytes");

      const resolved = resolveEpubFilePath(libDir, {
        path: bookRel,
        data_name: "Book Title - Author",
        data_format: "EPUB",
      });
      expect(resolved).toBe(epubFile);
    });

    it("rejects path traversal attempts that escape the library root", () => {
      const libDir = path.join(tempDir, "calibre-lib");
      fs.mkdirSync(libDir, { recursive: true });

      // Path attempting directory traversal
      expect(
        resolveEpubFilePath(libDir, {
          path: "../../../etc",
          data_name: "passwd",
          data_format: "EPUB",
        }),
      ).toBeNull();

      expect(
        resolveEpubFilePath(libDir, {
          path: "/etc/passwd",
          data_name: "passwd",
          data_format: "EPUB",
        }),
      ).toBeNull();
    });

    it("isCommentsEmpty detects empty and placeholder HTML comments", () => {
      expect(isCommentsEmpty(null)).toBe(true);
      expect(isCommentsEmpty(undefined)).toBe(true);
      expect(isCommentsEmpty("")).toBe(true);
      expect(isCommentsEmpty("   ")).toBe(true);
      expect(isCommentsEmpty("<p></p>")).toBe(true);
      expect(isCommentsEmpty("<p>&nbsp;</p>")).toBe(true);
      expect(isCommentsEmpty("<p><br></p>")).toBe(true);
      expect(isCommentsEmpty("<p>   <br/>   &nbsp; </p>")).toBe(true);
      expect(isCommentsEmpty("<p>A real book synopsis</p>")).toBe(false);
    });
  });

  // ==========================================================================
  // 3. Dry-Run vs Apply Mode
  // ==========================================================================
  describe("3. Dry-Run vs Apply Mode", () => {
    const sampleCandidates: EnrichBookCandidate[] = [
      {
        id: 101,
        title: "Overlord, Vol. 1",
        author: "Kugane Maruyama",
        path: "Maruyama/Overlord 1",
        has_cover: 1,
      },
      {
        id: 102,
        title: "Clean Code",
        author: "Robert C. Martin",
        path: "Martin/Clean Code",
        has_cover: 0,
        isbn: "9780132350884",
      },
      {
        id: 103,
        title: "Book Without Any Synopsis Available",
        author: "Anonymous",
        path: "Anon/Unknown",
        has_cover: 1,
      },
    ];

    it("runs in dry-run mode by default and does not mutate Calibre metadata", async () => {
      let metadataSetCount = 0;
      let cacheFlushed = false;

      const result = await runEnrichSynopses({
        dryRun: true,
        booksProvider: () => sampleCandidates,
        epubExtractor: (p) => {
          if (p.includes("Overlord")) {
            return "<p>Momonga gets trapped in Yggdrasil as his skeletal avatar.</p>";
          }
          return null;
        },
        onlineFetcher: async (b) => {
          if (b.id === 102) {
            return {
              description: "<p>A handbook of agile software craftsmanship.</p>",
              coverUrl: "https://example.com/clean-code.jpg",
              source: "GoogleBooks",
            };
          }
          return null;
        },
        metadataSetter: () => {
          metadataSetCount++;
          return { success: true };
        },
        cacheFlusher: () => {
          cacheFlushed = true;
        },
      });

      expect(result.dryRun).toBe(true);
      expect(result.totalBooksScanned).toBe(3);
      expect(result.synopsesFoundEpub).toBe(1);
      expect(result.synopsesFoundOnline).toBe(1);
      expect(result.synopsesNotFound).toBe(1);
      expect(result.totalNeedingUpdate).toBe(2);
      // In dry-run mode, setter and flusher must NOT be called
      expect(metadataSetCount).toBe(0);
      expect(result.totalUpdated).toBe(0);
      expect(cacheFlushed).toBe(false);

      // Verify items
      const item1 = result.items.find((i) => i.bookId === 101);
      expect(item1?.sourceType).toBe("epub");
      expect(item1?.foundSource).toBe("EPUB");
      expect(item1?.synopsis).toContain("Momonga gets trapped");

      const item2 = result.items.find((i) => i.bookId === 102);
      expect(item2?.sourceType).toBe("online");
      expect(item2?.foundSource).toBe("GoogleBooks");
      expect(item2?.coverUrl).toBe("https://example.com/clean-code.jpg");
    });

    it("executes updates and flushes cache in apply mode", async () => {
      const updatedIds: number[] = [];
      let coversApplied = 0;
      let cacheFlushed = false;

      const result = await runEnrichSynopses({
        dryRun: false,
        booksProvider: () => sampleCandidates,
        epubExtractor: (p) => {
          if (p.includes("Overlord")) {
            return "<p>Momonga gets trapped in Yggdrasil as his skeletal avatar.</p>";
          }
          return null;
        },
        onlineFetcher: async (b) => {
          if (b.id === 102) {
            return {
              description: "<p>A handbook of agile software craftsmanship.</p>",
              coverUrl: "https://example.com/clean-code.jpg",
              source: "GoogleBooks",
            };
          }
          return null;
        },
        metadataSetter: (bookId, _comments, coverUrl) => {
          updatedIds.push(bookId);
          const coverApplied = Boolean(coverUrl);
          if (coverApplied) coversApplied++;
          return { success: true, coverApplied };
        },
        cacheFlusher: () => {
          cacheFlushed = true;
        },
      });

      expect(result.dryRun).toBe(false);
      expect(result.totalUpdated).toBe(2);
      expect(updatedIds).toContain(101);
      expect(updatedIds).toContain(102);
      expect(coversApplied).toBe(1);
      expect(result.coversUpdated).toBe(1);
      expect(cacheFlushed).toBe(true);
      expect(result.totalErrors).toBe(0);
    });

    it("captures metadataSetter failures without aborting remaining books", async () => {
      const result = await runEnrichSynopses({
        dryRun: false,
        booksProvider: () => sampleCandidates.slice(0, 2),
        epubExtractor: () => "<p>Mock synopsis for book.</p>",
        metadataSetter: (bookId) => {
          if (bookId === 101) {
            return { success: false, error: "calibredb database is locked" };
          }
          return { success: true };
        },
        cacheFlusher: () => {},
      });

      expect(result.totalUpdated).toBe(1);
      expect(result.totalErrors).toBe(1);
      expect(result.errors.length).toBe(1);
      expect(result.errors[0].bookId).toBe(101);
      expect(result.errors[0].error).toContain("calibredb database is locked");
    });

    it("filters out candidates that already possess non-empty comments", async () => {
      const candidatesWithSomeComments: EnrichBookCandidate[] = [
        {
          id: 301,
          title: "Book Already Has Comments",
          comments: "<p>Existing curated synopsis that must not be overwritten.</p>",
        },
        {
          id: 302,
          title: "Book With Empty Comment",
          comments: "<p></p>",
        },
      ];

      const result = await runEnrichSynopses({
        dryRun: true,
        booksProvider: () => candidatesWithSomeComments,
        epubExtractor: () => "<p>Extracted synopsis.</p>",
      });

      // Only candidate 302 should be processed; candidate 301 is skipped
      expect(result.totalBooksScanned).toBe(1);
      expect(result.items.length).toBe(1);
      expect(result.items[0].bookId).toBe(302);
    });
  });

  // ==========================================================================
  // 4. Source Strategy Filter (all | epub | online)
  // ==========================================================================
  describe("4. Source Strategy Filter", () => {
    const candidate: EnrichBookCandidate = {
      id: 201,
      title: "Solo Leveling",
      author: "Chugong",
      has_cover: 0,
    };

    it("source: 'epub' ignores online provider even if EPUB has no synopsis", async () => {
      let onlineFetcherCalled = false;

      const result = await runEnrichSynopses({
        dryRun: true,
        source: "epub",
        booksProvider: () => [candidate],
        epubExtractor: () => null,
        onlineFetcher: async () => {
          onlineFetcherCalled = true;
          return { description: "<p>Shadow Monarch emerges.</p>", source: "RanobeDB" };
        },
      });

      expect(onlineFetcherCalled).toBe(false);
      expect(result.synopsesFoundEpub).toBe(0);
      expect(result.synopsesFoundOnline).toBe(0);
      expect(result.synopsesNotFound).toBe(1);
    });

    it("source: 'online' skips EPUB inspection and queries online directly", async () => {
      let epubExtractorCalled = false;

      const result = await runEnrichSynopses({
        dryRun: true,
        source: "online",
        booksProvider: () => [candidate],
        epubExtractor: () => {
          epubExtractorCalled = true;
          return "<p>Local EPUB synopsis.</p>";
        },
        onlineFetcher: async () => {
          return { description: "<p>Online shadow monarch synopsis.</p>", source: "RanobeDB" };
        },
      });

      expect(epubExtractorCalled).toBe(false);
      expect(result.synopsesFoundOnline).toBe(1);
      expect(result.items[0].sourceType).toBe("online");
      expect(result.items[0].foundSource).toBe("RanobeDB");
    });

    it("enforces MIN_CONFIDENCE_THRESHOLD of 0.85 to prevent low-similarity online synopsis pollution", async () => {
      expect(MIN_CONFIDENCE_THRESHOLD).toBe(0.85);

      const origFetch = globalThis.fetch;
      try {
        // Mock fetch returning a hit whose title differs, producing confidence < 0.85
        globalThis.fetch = (async () => {
          return new Response(
            JSON.stringify({
              items: [
                {
                  volumeInfo: {
                    title: "Completely Different Unrelated Work",
                    description:
                      "A description of a completely different book that should not match.",
                    categories: ["Fiction"],
                  },
                },
              ],
            }),
            {
              status: 200,
              headers: { "Content-Type": "application/json" },
            },
          );
        }) as any;

        const candidate: EnrichBookCandidate = {
          id: 999,
          title: "My Specific Target Title",
        };
        const res = await fetchOnlineSynopsis(candidate);
        // Low confidence hit (< 0.85) must be rejected!
        expect(res).toBeNull();
      } finally {
        globalThis.fetch = origFetch;
      }
    });

    it("immediately returns null and bypasses online fetch for Burmese books even with Latin authors", async () => {
      const origFetch = globalThis.fetch;
      let onlineFetchCalled = false;
      try {
        globalThis.fetch = (async () => {
          onlineFetchCalled = true;
          throw new Error("Online API should NOT be queried for Burmese books");
        }) as any;

        const burmeseCandidate: EnrichBookCandidate = {
          id: 1234,
          title: "ပါရီကျဆုံးခန်း",
          author: "Mya Than Tint",
        };

        const res = await fetchOnlineSynopsis(burmeseCandidate);
        expect(res).toBeNull();
        expect(onlineFetchCalled).toBe(false);
      } finally {
        globalThis.fetch = origFetch;
      }
    });
  });

  // ==========================================================================
  // 5. Report Formatting & Summary Metrics
  // ==========================================================================
  describe("5. Report Formatting & Summary Metrics", () => {
    it("formats a comprehensive summary report with required metrics", () => {
      const mockResult = {
        dryRun: true,
        sourceStrategy: "all" as const,
        libraryPath: "/Users/ospeto/Calibre Libraries/Agent Library",
        totalBooksScanned: 1180,
        synopsesFoundEpub: 45,
        synopsesFoundOnline: 820,
        synopsesNotFound: 315,
        totalNeedingUpdate: 865,
        totalUpdated: 0,
        coversUpdated: 0,
        totalErrors: 0,
        items: [
          {
            bookId: 12,
            title: "The Legendary Moonlight Sculptor, Vol. 01",
            sourceType: "online" as const,
            foundSource: "Bangumi",
            synopsis: "<p>Lee Hyun enters the virtual reality game Royal Road.</p>",
            coverUrl: "https://example.com/cover.jpg",
            appliedCover: false,
            updated: false,
          },
        ],
        errors: [],
      };

      const report = formatEnrichReport(mockResult);
      expect(report).toContain("LightHouse Synopsis Enrichment — DRY-RUN (Preview Only)");
      expect(report).toContain("Total Books Scanned:            1180");
      expect(report).toContain("Synopses Found from Local EPUB: 45");
      expect(report).toContain("Synopses Found from Online APIs:820");
      expect(report).toContain("Total Books Needing Update:     865");
      expect(report).toContain("The Legendary Moonlight Sculptor");
      expect(report).toContain("bin/lighthouse enrich-synopsis --apply");
    });
  });

  // ==========================================================================
  // 6. Series Synopsis Inheritance & AniList Fallback
  // ==========================================================================
  describe("6. Series Synopsis Inheritance & AniList Fallback", () => {
    it("isCommentsEmpty detects placeholder text like 'No synopsis available for this volume.'", () => {
      expect(isCommentsEmpty("No synopsis available for this volume.")).toBe(true);
      expect(isCommentsEmpty("<p>No synopsis available for this volume.</p>")).toBe(true);
      expect(isCommentsEmpty("No synopsis available.")).toBe(true);
      expect(isCommentsEmpty("*No synopsis available.*")).toBe(true);
      expect(isCommentsEmpty("")).toBe(true);
      expect(isCommentsEmpty(null)).toBe(true);
      expect(isCommentsEmpty("   ")).toBe(true);
      expect(isCommentsEmpty("<p>&nbsp;</p>")).toBe(true);
      expect(isCommentsEmpty("A rich, compelling story of an adventurer.")).toBe(false);
    });

    it("inherits series overview across all volumes in a series via seriesCache", async () => {
      const candidates: EnrichBookCandidate[] = [
        {
          id: 101,
          title: "The Legendary Moonlight Sculptor, Vol. 1",
          series: "The Legendary Moonlight Sculptor",
          series_index: 1,
          has_cover: 0,
        },
        {
          id: 102,
          title: "The Legendary Moonlight Sculptor, Vol. 2",
          series: "The Legendary Moonlight Sculptor",
          series_index: 2,
          has_cover: 0,
        },
        {
          id: 103,
          title: "The Legendary Moonlight Sculptor, Vol. 3",
          series: "The Legendary Moonlight Sculptor",
          series_index: 3,
          has_cover: 0,
        },
      ];

      let fetchCount = 0;
      const mockOnlineFetcher = async (_book: EnrichBookCandidate) => {
        fetchCount++;
        return {
          description: "<p>Lee Hyun enters the Royal Road virtual reality MMORPG to carve his own destiny.</p>",
          coverUrl: "https://s4.anilist.co/file/anilistcdn/media/manga/cover/medium/b85869.png",
          source: "AniList",
        };
      };

      const result = await runEnrichSynopses({
        booksProvider: () => candidates,
        epubExtractor: () => null,
        onlineFetcher: mockOnlineFetcher,
        dryRun: true,
      });

      // Volume 1 called fetcher; Volume 2 & 3 inherited from seriesCache!
      expect(fetchCount).toBe(1);
      expect(result.totalBooksScanned).toBe(3);
      expect(result.synopsesFoundOnline).toBe(3);
      expect(result.totalNeedingUpdate).toBe(3);

      for (const item of result.items) {
        expect(item.sourceType).toBe("online");
        expect(item.synopsis).toContain("Lee Hyun enters the Royal Road");
        expect(item.coverUrl).toBe("https://s4.anilist.co/file/anilistcdn/media/manga/cover/medium/b85869.png");
      }
    });

    it("falls back to AniList series lookup when individual volume query returns no description", async () => {
      const origFetch = globalThis.fetch;
      let requestedSearch = "";

      (globalThis as any).fetch = async (url: any, init: any) => {
        const urlStr = typeof url === "string" ? url : url.toString();
        if (urlStr.includes("graphql.anilist.co")) {
          const body = JSON.parse(init?.body || "{}");
          requestedSearch = body.variables?.search || "";

          return new Response(
            JSON.stringify({
              data: {
                Media: {
                  id: 999,
                  title: { english: "Trapped in a Dating Sim" },
                  description: "Leon was reincarnated into the world of an otome game.<br><br>He uses his game knowledge to survive.",
                  coverImage: { extraLarge: "https://s4.anilist.co/file/anilistcdn/cover/dating.jpg" },
                  format: "NOVEL",
                  staff: { edges: [{ role: "Original Story", node: { name: { full: "Yomu Mishima" } } }] },
                },
              },
            }),
            { status: 200, headers: { "Content-Type": "application/json" } },
          );
        }

        return new Response("{}", { status: 200, headers: { "Content-Type": "application/json" } });
      };

      try {
        const book: EnrichBookCandidate = {
          id: 50,
          title: "Trapped in a Dating Sim Volume 2",
          // series is not defined in Calibre, derived from title!
        };

        const res = await fetchOnlineSynopsis(book);
        expect(res).not.toBeNull();
        expect(res?.source).toBe("AniList");
        expect(res?.description).toContain("Leon was reincarnated into the world of an otome game.");
        expect(res?.coverUrl).toBe("https://s4.anilist.co/file/anilistcdn/cover/dating.jpg");
        expect(requestedSearch).toBe("Trapped in a Dating Sim");
      } finally {
        (globalThis as any).fetch = origFetch;
      }
    });

    it("queries AniList using Calibre series field when defined", async () => {
      const origFetch = globalThis.fetch;
      let searchedVariables: any = null;

      (globalThis as any).fetch = async (url: any, init: any) => {
        const urlStr = typeof url === "string" ? url : url.toString();
        if (urlStr.includes("graphql.anilist.co")) {
          const body = JSON.parse(init?.body || "{}");
          searchedVariables = body.variables;

          return new Response(
            JSON.stringify({
              data: {
                Media: {
                  id: 888,
                  title: { english: "I'm the Evil Lord of an Intergalactic Empire!" },
                  description: "Liam is reborn into an aristocratic family ruling an interstellar empire.",
                  coverImage: { extraLarge: "https://s4.anilist.co/file/anilistcdn/cover/evil.jpg" },
                  format: "NOVEL",
                },
              },
            }),
            { status: 200, headers: { "Content-Type": "application/json" } },
          );
        }

        return new Response("{}", { status: 200, headers: { "Content-Type": "application/json" } });
      };

      try {
        const book: EnrichBookCandidate = {
          id: 77,
          title: "Volume 01",
          series: "I'm the Evil Lord of an Intergalactic Empire!",
          series_index: 1,
        };

        const res = await fetchOnlineSynopsis(book);
        expect(res).not.toBeNull();
        expect(res?.source).toBe("AniList");
        expect(res?.description).toContain("Liam is reborn into an aristocratic family");
        expect(String(searchedVariables?.search)).toContain("Evil Lord of an Intergalactic Empire");
      } finally {
        (globalThis as any).fetch = origFetch;
      }
    });
  });
});
