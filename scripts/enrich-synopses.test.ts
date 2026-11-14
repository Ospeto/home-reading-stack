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
  cleanQuery,
  fetchOnlineSynopsis,
  MIN_CONFIDENCE_THRESHOLD,
  runEnrichSynopses,
  formatEnrichReport,
  type EnrichBookCandidate,
} from "./enrich-synopses";
const securityMod: typeof import("../uploader/security") =
  await import("../uploader/security").catch(
    () => import("../security" as string) as Promise<typeof import("../uploader/security")>,
  );
const { getBsdtarPath } = securityMod;
import { spawnSync } from "node:child_process";

const REPO_ROOT = path.resolve((import.meta as any).dir, "..");

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

    it("captures metadataSetter failures without aborting remaining books and marks item.updated as false", async () => {
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
      const failedItem = result.items.find((i) => i.bookId === 101);
      expect(failedItem?.updated).toBe(false);
      expect(failedItem?.error).toContain("calibredb database is locked");
      const successItem = result.items.find((i) => i.bookId === 102);
      expect(successItem?.updated).toBe(true);
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

    it("prioritizes volume-specific synopses over seriesCache overview across volumes in a series", async () => {
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
      const mockOnlineFetcher = async (book: EnrichBookCandidate) => {
        fetchCount++;
        // Volume 1 returns series fallback (from AniList)
        if (book.series_index === 1) {
          return {
            description: "<p>Lee Hyun enters the Royal Road virtual reality MMORPG to carve his own destiny.</p>",
            coverUrl: "https://s4.anilist.co/file/anilistcdn/media/manga/cover/medium/b85869.png",
            source: "AniList",
          };
        }
        // Volume 2 has an individual volume synopsis from RanobeDB!
        if (book.series_index === 2) {
          return {
            description: "<p>Weed journeys to the Plains of Despair and leads the Orcs to victory.</p>",
            coverUrl: "https://images.ranobedb.org/covers/vol2.jpg",
            source: "RanobeDB",
          };
        }
        // Volume 3 has no volume-specific synopsis online (returns null -> falls back to seriesCache!)
        return null;
      };

      const result = await runEnrichSynopses({
        booksProvider: () => candidates,
        epubExtractor: () => null,
        onlineFetcher: mockOnlineFetcher,
        dryRun: true,
      });

      // Volume-specific precedence: All 3 volumes were queried online (seriesCache did NOT short-circuit Volume 2 or 3!)
      expect(fetchCount).toBe(3);
      expect(result.totalBooksScanned).toBe(3);
      expect(result.synopsesFoundOnline).toBe(3);
      expect(result.totalNeedingUpdate).toBe(3);

      // Volume 1 received AniList series overview and cached it
      expect(result.items[0].synopsis).toContain("Lee Hyun enters the Royal Road");
      expect(result.items[0].foundSource).toBe("AniList");

      // Volume 2 received its TRUE volume synopsis from RanobeDB, taking precedence over seriesCache!
      expect(result.items[1].synopsis).toContain("Weed journeys to the Plains of Despair");
      expect(result.items[1].foundSource).toBe("RanobeDB");

      // Volume 3 had no volume synopsis online, so it fell back to seriesCache!
      expect(result.items[2].synopsis).toContain("Lee Hyun enters the Royal Road");
      expect(result.items[2].foundSource).toBe("AniList");
    });

    it("prioritizes local EPUB synopsis over online queries and seriesCache", async () => {
      const candidates: EnrichBookCandidate[] = [
        {
          id: 201,
          title: "Overlord, Vol. 1",
          series: "Overlord",
          series_index: 1,
          path: "Overlord/Vol1",
        },
      ];

      let onlineCalled = false;
      const mockOnlineFetcher = async () => {
        onlineCalled = true;
        return {
          description: "<p>Online description that should be superseded by EPUB.</p>",
          source: "Online",
        };
      };

      const result = await runEnrichSynopses({
        booksProvider: () => candidates,
        epubExtractor: () => "<p>Authentic EPUB embedded volume synopsis from content.opf.</p>",
        onlineFetcher: mockOnlineFetcher,
        dryRun: true,
      });

      expect(result.synopsesFoundEpub).toBe(1);
      expect(result.synopsesFoundOnline).toBe(0);
      expect(onlineCalled).toBe(false);
      expect(result.items[0].sourceType).toBe("epub");
      expect(result.items[0].synopsis).toContain("Authentic EPUB embedded volume synopsis");
    });

    it("reEnrichDuplicates re-enriches books holding duplicate series overviews when a true volume synopsis is available", async () => {
      const duplicateOverview = "<p>Momonga gets trapped in Yggdrasil as the guild leader of Ainz Ooal Gown.</p>";
      const candidates: EnrichBookCandidate[] = [
        {
          id: 301,
          title: "Overlord, Vol. 1",
          series: "Overlord",
          series_index: 1,
          comments: duplicateOverview,
        },
        {
          id: 302,
          title: "Overlord, Vol. 2",
          series: "Overlord",
          series_index: 2,
          comments: duplicateOverview,
        },
      ];

      // Without reEnrichDuplicates: neither book is scanned because comments is not empty
      const dryResultWithoutFlag = await runEnrichSynopses({
        booksProvider: () => candidates,
        dryRun: true,
      });
      expect(dryResultWithoutFlag.totalBooksScanned).toBe(0);

      // With reEnrichDuplicates: both duplicate-holding books are scanned
      const resultWithFlag = await runEnrichSynopses({
        booksProvider: () => candidates,
        reEnrichDuplicates: true,
        onlineFetcher: async (book) => {
          if (book.series_index === 2) {
            return {
              description: "<p>The dark warrior Momon takes on a guild quest in E-Rantel.</p>",
              source: "RanobeDB",
            };
          }
          // Volume 1 only has the same series overview
          return {
            description: duplicateOverview,
            source: "AniList",
          };
        },
        metadataSetter: () => ({ success: true }),
        dryRun: false,
      });

      expect(resultWithFlag.totalBooksScanned).toBe(2);
      // Volume 1 found the same overview, so updated is false
      expect(resultWithFlag.items[0].updated).toBe(false);
      // Volume 2 found a TRUE volume synopsis, so updated is true!
      expect(resultWithFlag.items[1].updated).toBe(true);
      expect(resultWithFlag.items[1].synopsis).toContain("The dark warrior Momon takes on a guild quest");
      expect(resultWithFlag.totalNeedingUpdate).toBe(1);
      expect(resultWithFlag.totalUpdated).toBe(1);
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

    it("cleanQuery preserves volume tokens when preserveVolume is enabled", () => {
      expect(cleanQuery("Overlord, Vol. 1", { preserveVolume: true })).toBe("Overlord Vol. 1");
      expect(cleanQuery("Overlord (Vol. 1)", { preserveVolume: true })).toBe("Overlord Vol. 1");
      expect(cleanQuery("Overlord [Vol. 1]", { preserveVolume: true })).toBe("Overlord Vol. 1");
      expect(cleanQuery("Overlord - Volume 02 [Yen Press]", { preserveVolume: true })).toBe("Overlord Volume 02");
      expect(cleanQuery("Slime v3", { preserveVolume: true })).toBe("Slime v3");
      expect(cleanQuery("タイトル (1)", { preserveVolume: true })).toBe("タイトル 1");
      expect(cleanQuery("タイトル （1）", { preserveVolume: true })).toBe("タイトル 1");
      // Default without preserveVolume strips volume tokens for canonical series matching
      expect(cleanQuery("Overlord, Vol. 1")).toBe("Overlord");
      expect(cleanQuery("Overlord (Vol. 1)")).toBe("Overlord");
      expect(cleanQuery("Overlord [Vol. 1]")).toBe("Overlord");
      expect(cleanQuery("Overlord - Volume 02 [Yen Press]")).toBe("Overlord");
    });

    it("fetchOnlineSynopsis preserves full volume title in outbound online search and reserves AniList for Step 3 fallback", async () => {
      const origFetch = globalThis.fetch;
      const interceptedUrls: string[] = [];

      (globalThis as any).fetch = async (url: any) => {
        const urlStr = typeof url === "string" ? url : url.toString();
        interceptedUrls.push(urlStr);

        // RanobeDB volume query
        if (urlStr.includes("ranobedb.org/api/v0/books")) {
          return new Response(
            JSON.stringify({
              books: [
                {
                  id: "1001",
                  title: "Overlord, Vol. 1: The Undead King",
                  description: "Momonga is an ordinary salaryman who finds himself trapped in his favorite DMMO-RPG.",
                  cover: "https://images.ranobedb.org/covers/overlord_1.jpg",
                },
              ],
            }),
            { status: 200, headers: { "Content-Type": "application/json" } },
          );
        }

        if (urlStr.includes("ranobedb.org/api/v0/book/1001")) {
          return new Response(
            JSON.stringify({
              book: {
                id: "1001",
                title: "Overlord, Vol. 1: The Undead King",
                description: "Momonga is an ordinary salaryman who finds himself trapped in his favorite DMMO-RPG.",
                cover: "https://images.ranobedb.org/covers/overlord_1.jpg",
              },
            }),
            { status: 200, headers: { "Content-Type": "application/json" } },
          );
        }

        // AniList returns series-level blurb
        if (urlStr.includes("graphql.anilist.co")) {
          return new Response(
            JSON.stringify({
              data: {
                Media: {
                  id: 8888,
                  title: { english: "Overlord" },
                  description: "Franchise series overview: Momonga is trapped in Yggdrasil.",
                  format: "NOVEL",
                },
              },
            }),
            { status: 200, headers: { "Content-Type": "application/json" } },
          );
        }

        return new Response("{}", { status: 200 });
      };

      try {
        const book: EnrichBookCandidate = {
          id: 401,
          title: "Overlord, Vol. 1: The Undead King",
          series: "Overlord",
          series_index: 1,
        };

        const res = await fetchOnlineSynopsis(book);
        expect(res).not.toBeNull();
        // True volume synopsis from RanobeDB won, NOT the AniList series overview!
        expect(res?.source).toBe("RanobeDB");
        expect(res?.description).toContain("Momonga is an ordinary salaryman");

        // Verify outbound query to RanobeDB preserved volume token
        const ranobeCall = interceptedUrls.find((u) => u.includes("ranobedb.org"));
        expect(ranobeCall).toBeDefined();
        const decodedUrl = decodeURIComponent(ranobeCall!);
        expect(decodedUrl.toLowerCase()).toMatch(/vol|volume/);
      } finally {
        (globalThis as any).fetch = origFetch;
      }
    });

    it("fetchOnlineSynopsis falls back to Google Books volume query when RanobeDB and Bangumi have no hit, without AniList blocking it in Step 2", async () => {
      const origFetch = globalThis.fetch;
      const interceptedUrls: string[] = [];

      (globalThis as any).fetch = async (url: any) => {
        const urlStr = typeof url === "string" ? url : url.toString();
        interceptedUrls.push(urlStr);

        // RanobeDB returns 0 hits for this volume
        if (urlStr.includes("ranobedb.org/api/v0/books") || urlStr.includes("ranobedb.org/api/v0/series")) {
          return new Response(JSON.stringify({ books: [] }), { status: 200, headers: { "Content-Type": "application/json" } });
        }

        // Bangumi returns a series hit with empty summary (must not block Google Books fallback!)
        if (urlStr.includes("api.bgm.tv")) {
          return new Response(
            JSON.stringify({ list: [{ name: "Overlord", summary: "" }] }),
            { status: 200, headers: { "Content-Type": "application/json" } },
          );
        }

        // Google Books returns volume-specific entry
        if (urlStr.includes("googleapis.com/books/v1/volumes")) {
          return new Response(
            JSON.stringify({
              items: [
                {
                  volumeInfo: {
                    title: "Overlord, Vol. 2 (light novel): The Dark Warrior",
                    authors: ["Kugane Maruyama"],
                    description: "It has been a week since Momonga transported to another world. Disguised as an adventurer named Momon...",
                    imageLinks: { thumbnail: "https://books.google.com/overlord_2.jpg" },
                  },
                },
              ],
            }),
            { status: 200, headers: { "Content-Type": "application/json" } },
          );
        }

        // AniList returns series-level blurb
        if (urlStr.includes("graphql.anilist.co")) {
          return new Response(
            JSON.stringify({
              data: {
                Media: {
                  id: 8888,
                  title: { english: "Overlord" },
                  description: "Franchise series overview: Momonga is trapped in Yggdrasil.",
                  format: "NOVEL",
                },
              },
            }),
            { status: 200, headers: { "Content-Type": "application/json" } },
          );
        }

        return new Response("{}", { status: 200 });
      };

      try {
        const book: EnrichBookCandidate = {
          id: 402,
          title: "Overlord, Vol. 2: The Dark Warrior",
          series: "Overlord",
          series_index: 2,
          tags: "Light Novel",
        };

        const res = await fetchOnlineSynopsis(book);
        expect(res).not.toBeNull();
        // True volume synopsis from Google Books won despite Bangumi empty hit!
        expect(res?.source).toBe("GoogleBooks");
        expect(res?.description).toContain("Disguised as an adventurer named Momon");
      } finally {
        (globalThis as any).fetch = origFetch;
      }
    });
  });

  // ==========================================================================
  // 11. Deployment Path Resilience (Flattened Layout)
  // ==========================================================================
  describe("11. Deployment Path Resilience (Flattened Layout)", () => {
    it("runs enrich-synopses --help cleanly from flattened production directory layout", () => {
      const flattenedDir = fs.mkdtempSync(path.join(os.tmpdir(), "enrich-flattened-"));
      try {
        fs.mkdirSync(path.join(flattenedDir, "scripts"), { recursive: true });
        // Copy deployment modules to flattenedDir root (production layout)
        fs.copyFileSync(
          path.join(REPO_ROOT, "uploader", "scraper.ts"),
          path.join(flattenedDir, "scraper.ts"),
        );
        // scraper.ts delegates provider routing to this module, so the flattened
        // production layout must ship it alongside the scrapers.
        fs.copyFileSync(
          path.join(REPO_ROOT, "uploader", "metadata-providers.ts"),
          path.join(flattenedDir, "metadata-providers.ts"),
        );
        fs.copyFileSync(
          path.join(REPO_ROOT, "uploader", "security.ts"),
          path.join(flattenedDir, "security.ts"),
        );
        fs.copyFileSync(
          path.join(REPO_ROOT, "uploader", "jev-shelf.ts"),
          path.join(flattenedDir, "jev-shelf.ts"),
        );
        fs.copyFileSync(
          path.join(REPO_ROOT, "scripts", "enrich-synopses.ts"),
          path.join(flattenedDir, "scripts", "enrich-synopses.ts"),
        );

        const res = spawnSync("bun", ["run", path.join(flattenedDir, "scripts", "enrich-synopses.ts"), "--help"], {
          encoding: "utf8",
          cwd: flattenedDir,
        });
        expect(res.status).toBe(0);
        expect(res.stdout).toContain("LightHouse Synopsis Enrichment Tool");
        expect(res.stdout).toContain("--re-enrich-duplicates");
      } finally {
        fs.rmSync(flattenedDir, { recursive: true, force: true });
      }
    });

    it("runs clean-duplicates --help cleanly from flattened production directory layout", () => {
      const flattenedDir = fs.mkdtempSync(path.join(os.tmpdir(), "dedup-flattened-"));
      try {
        fs.mkdirSync(path.join(flattenedDir, "scripts"), { recursive: true });
        fs.copyFileSync(
          path.join(REPO_ROOT, "uploader", "scraper.ts"),
          path.join(flattenedDir, "scraper.ts"),
        );
        // scraper.ts delegates provider routing to this module, so the flattened
        // production layout must ship it alongside the scrapers.
        fs.copyFileSync(
          path.join(REPO_ROOT, "uploader", "metadata-providers.ts"),
          path.join(flattenedDir, "metadata-providers.ts"),
        );
        fs.copyFileSync(
          path.join(REPO_ROOT, "uploader", "security.ts"),
          path.join(flattenedDir, "security.ts"),
        );
        fs.copyFileSync(
          path.join(REPO_ROOT, "uploader", "jev-shelf.ts"),
          path.join(flattenedDir, "jev-shelf.ts"),
        );
        fs.copyFileSync(
          path.join(REPO_ROOT, "scripts", "clean-duplicates.ts"),
          path.join(flattenedDir, "scripts", "clean-duplicates.ts"),
        );

        const res = spawnSync("bun", ["run", path.join(flattenedDir, "scripts", "clean-duplicates.ts"), "--help"], {
          encoding: "utf8",
          cwd: flattenedDir,
        });
        expect(res.status).toBe(0);
        expect(res.stdout).toContain("clean-duplicates.ts");
        expect(res.stdout).toContain("--dry-run");
      } finally {
        fs.rmSync(flattenedDir, { recursive: true, force: true });
      }
    });

    it("runs categorize-library --help cleanly from flattened production directory layout", () => {
      const flattenedDir = fs.mkdtempSync(path.join(os.tmpdir(), "cat-flattened-"));
      try {
        fs.mkdirSync(path.join(flattenedDir, "scripts"), { recursive: true });
        fs.copyFileSync(
          path.join(REPO_ROOT, "uploader", "security.ts"),
          path.join(flattenedDir, "security.ts"),
        );
        fs.copyFileSync(
          path.join(REPO_ROOT, "uploader", "jev-shelf.ts"),
          path.join(flattenedDir, "jev-shelf.ts"),
        );
        fs.copyFileSync(
          path.join(REPO_ROOT, "scripts", "categorize-library.ts"),
          path.join(flattenedDir, "scripts", "categorize-library.ts"),
        );

        const res = spawnSync("bun", ["run", path.join(flattenedDir, "scripts", "categorize-library.ts"), "--help"], {
          encoding: "utf8",
          cwd: flattenedDir,
        });
        expect(res.status).toBe(0);
        expect(res.stdout).toContain("LightHouse Library Categorization & Language Fix Tool");
      } finally {
        fs.rmSync(flattenedDir, { recursive: true, force: true });
      }
    });
  });
});
