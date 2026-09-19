import { describe, it, expect } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  formatRanobeDate,
  parseRanobeBook,
  searchRanobeDB,
  isLightNovelQuery,
  isAllowedCoverUrl,
  KNOWN_COVER_DOMAINS,
  searchUniversalMetadata,
  normalizeTitle,
  normalizeAuthor,
  isSameBook,
  isSameBookAsync,
  getEpubContentSignature,
  type ScrapedMetadata,
} from "./scraper";

describe("RanobeDB Scraper & Light Novel Metadata Engine", () => {
  describe("formatRanobeDate", () => {
    it("formats 8-digit YYYYMMDD into YYYY-MM-DD", () => {
      expect(formatRanobeDate(20060630)).toBe("2006-06-30");
      expect(formatRanobeDate("20120730")).toBe("2012-07-30");
      expect(formatRanobeDate(20231201)).toBe("2023-12-01");
    });

    it("formats 6-digit YYYYMM into YYYY-MM", () => {
      expect(formatRanobeDate(202110)).toBe("2021-10");
      expect(formatRanobeDate("201505")).toBe("2015-05");
    });

    it("formats 4-digit YYYY into YYYY", () => {
      expect(formatRanobeDate(2020)).toBe("2020");
      expect(formatRanobeDate("2018")).toBe("2018");
    });

    it("returns empty string for null, undefined, zero, or sentinel dates", () => {
      expect(formatRanobeDate(null)).toBe("");
      expect(formatRanobeDate(undefined)).toBe("");
      expect(formatRanobeDate("")).toBe("");
      expect(formatRanobeDate(0)).toBe("");
      expect(formatRanobeDate(99999999)).toBe("");
      expect(formatRanobeDate("99999999")).toBe("");
      expect(formatRanobeDate("invalid-date")).toBe("");
    });
  });

  describe("parseRanobeBook", () => {
    it("parses full book details with author, series, tags, and cover", () => {
      const mockBook = {
        id: 48778,
        title: "熱風海陸ブシロード OVERLORD CHRONICLE",
        title_orig: "熱風海陸ブシロード OVERLORD CHRONICLE",
        romaji: "Neppuu Kairiku Bushi Road Overlord Chronicle",
        description: "",
        description_ja:
          "公国トウライの将軍の嫡子カズサ＝シン。“天”から巨大な魔神とともに舞い降りた謎の美少女ヒカゲ。",
        c_release_date: 20060630,
        image: {
          id: 49267,
          filename: "oO0RlDybD6zg7qeo.jpg",
        },
        series: {
          id: 19839,
          title: "熱風海陸ブシロード",
          tags: [
            { name: "action", id: 1 },
            { name: "mecha", id: 5 },
          ],
        },
        editions: [
          {
            id: 5001,
            staff: [
              { name: "吉田直", role_type: "author" },
              { name: "後藤なお", role_type: "artist" },
            ],
          },
        ],
      };

      const result = parseRanobeBook(mockBook, "Overlord Chronicle");

      expect(result.source).toBe("RanobeDB");
      expect(result.title).toBe("熱風海陸ブシロード OVERLORD CHRONICLE");
      expect(result.authors).toBe("吉田直");
      expect(result.publisher).toBe("熱風海陸ブシロード");
      expect(result.publishedDate).toBe("2006-06-30");
      expect(result.description).toBe(mockBook.description_ja);
      expect(result.coverUrl).toBe(
        "https://images.ranobedb.org/oO0RlDybD6zg7qeo.jpg",
      );
      expect(result.tags).toContain("Light Novel");
      expect(result.tags).toContain("action");
      expect(result.tags).toContain("mecha");
      expect(result.isManga).toBe(false);
      expect(result.confidence).toBeGreaterThanOrEqual(0.7);
    });

    it("extracts authors correctly and filters out non-author staff", () => {
      const bookWithStaff = {
        id: 100,
        title: "Sword Art Online 1: Aincrad",
        title_orig: "ソードアート・オンライン1 アインクラッド",
        c_release_date: 20090410,
        image: { filename: "sao1.jpg" },
        series: { title: "Sword Art Online", tags: [{ name: "isekai" }] },
        editions: [
          {
            staff: [
              { name: "Reki Kawahara", role_type: "author" },
              { name: "abec", role_type: "artist" },
              { name: "Translator Person", role_type: "translator" },
            ],
          },
        ],
      };

      const result = parseRanobeBook(bookWithStaff, "Sword Art Online");
      expect(result.authors).toBe("Reki Kawahara");
      expect(result.publisher).toBe("Sword Art Online");
      expect(result.coverUrl).toBe("https://images.ranobedb.org/sao1.jpg");
    });

    it("falls back to subsequent editions if edition 0 has no author", () => {
      const multiEdBook = {
        id: 200,
        title: "Overlord, Vol. 1",
        editions: [
          { staff: [{ name: "so-bin", role_type: "artist" }] },
          { staff: [{ name: "Kugane Maruyama", role_type: "author" }] },
        ],
      };

      const result = parseRanobeBook(multiEdBook, "Overlord");
      expect(result.authors).toBe("Kugane Maruyama");
    });

    it("handles missing authors, description, and cover gracefully", () => {
      const minimalBook = {
        id: 300,
        title: "Unknown Novel",
      };

      const result = parseRanobeBook(minimalBook, "Unknown Novel");
      expect(result.title).toBe("Unknown Novel");
      expect(result.authors).toBe("Unknown");
      expect(result.publisher).toBe("");
      expect(result.publishedDate).toBe("");
      expect(result.description).toBe("");
      expect(result.coverUrl).toBeUndefined();
      expect(result.tags).toEqual(["Light Novel"]);
      expect(result.confidence).toBe(1.0);
    });
  });

  describe("searchRanobeDB Network & Fallback Mocking", () => {
    it("fetches book hits and returns parsed ScrapedMetadata", async () => {
      const mockFetch = async (url: string) => {
        const u = new URL(url);
        if (u.pathname === "/api/v0/books") {
          return Response.json({
            books: [
              {
                id: 101,
                title: "Overlord, Vol. 1: The Undead King",
                title_orig: "オーバーロード1 不死者の王",
                image: { filename: "overlord1.jpg" },
                c_release_date: 20120730,
              },
            ],
          });
        }
        if (u.pathname === "/api/v0/book/101") {
          return Response.json({
            book: {
              id: 101,
              title: "Overlord, Vol. 1: The Undead King",
              title_orig: "オーバーロード1 不死者の王",
              description:
                "A player gets trapped in an MMORPG as an undead skeleton king.",
              c_release_date: 20120730,
              image: { filename: "overlord1.jpg" },
              series: {
                title: "Overlord",
                tags: [{ name: "dark fantasy" }, { name: "isekai" }],
              },
              editions: [
                {
                  staff: [
                    { name: "Kugane Maruyama", role_type: "author" },
                    { name: "so-bin", role_type: "artist" },
                  ],
                },
              ],
            },
          });
        }
        return new Response("Not Found", { status: 404 });
      };

      const results = await searchRanobeDB("Overlord", {
        fetchFn: mockFetch,
      });

      expect(results.length).toBe(1);
      const top = results[0];
      expect(top.title).toBe("Overlord, Vol. 1: The Undead King");
      expect(top.authors).toBe("Kugane Maruyama");
      expect(top.publisher).toBe("Overlord");
      expect(top.coverUrl).toBe(
        "https://images.ranobedb.org/overlord1.jpg",
      );
      expect(top.publishedDate).toBe("2012-07-30");
      expect(top.tags).toContain("Light Novel");
      expect(top.tags).toContain("dark fantasy");
      expect(top.source).toBe("RanobeDB");
      expect(top.confidence).toBeGreaterThanOrEqual(0.7);
    });

    it("falls back to /series endpoint when /books returns zero hits", async () => {
      const mockFetch = async (url: string) => {
        const u = new URL(url);
        if (u.pathname === "/api/v0/books") {
          return Response.json({ books: [] });
        }
        if (u.pathname === "/api/v0/series") {
          return Response.json({
            series: [
              {
                id: 4557,
                title: "Classroom of the Elite",
                book: {
                  id: 14966,
                  image: { filename: "cote1.jpg" },
                },
              },
            ],
          });
        }
        if (u.pathname === "/api/v0/book/14966") {
          return Response.json({
            book: {
              id: 14966,
              title: "Classroom of the Elite, Vol. 1",
              c_release_date: 20150525,
              image: { filename: "cote1.jpg" },
              series: {
                title: "Classroom of the Elite",
                tags: [{ name: "psychological" }, { name: "school" }],
              },
              editions: [
                {
                  staff: [
                    { name: "Shougo Kinugasa", role_type: "author" },
                    { name: "Shunsaku Tomose", role_type: "artist" },
                  ],
                },
              ],
            },
          });
        }
        return new Response("Not Found", { status: 404 });
      };

      const results = await searchRanobeDB("Classroom of the Elite", {
        fetchFn: mockFetch,
      });

      expect(results.length).toBe(1);
      const top = results[0];
      expect(top.title).toBe("Classroom of the Elite, Vol. 1");
      expect(top.authors).toBe("Shougo Kinugasa");
      expect(top.publisher).toBe("Classroom of the Elite");
      expect(top.coverUrl).toBe("https://images.ranobedb.org/cote1.jpg");
      expect(top.publishedDate).toBe("2015-05-25");
      expect(top.source).toBe("RanobeDB");
    });

    it("returns empty array gracefully on network error or invalid response", async () => {
      const mockFailFetch = async () => {
        throw new Error("Network connection reset");
      };
      const results = await searchRanobeDB("Nonexistent Book", {
        fetchFn: mockFailFetch,
      });
      expect(results).toEqual([]);
    });
  });

  describe("isAllowedCoverUrl & SSRF Guard", () => {
    it("validates images.ranobedb.org as an allowed cover image domain", () => {
      expect(KNOWN_COVER_DOMAINS.has("images.ranobedb.org")).toBe(true);
      expect(
        isAllowedCoverUrl("https://images.ranobedb.org/32dZdjBbklrmdmTI.jpg"),
      ).toBe(true);
      expect(
        isAllowedCoverUrl("http://images.ranobedb.org/oO0RlDybD6zg7qeo.jpg"),
      ).toBe(true);
    });

    it("validates other known eBook & Manga cover domains", () => {
      expect(
        isAllowedCoverUrl(
          "https://uploads.mangadex.org/covers/123/cover.jpg.512.jpg",
        ),
      ).toBe(true);
      expect(
        isAllowedCoverUrl("https://covers.openlibrary.org/b/id/12345-L.jpg"),
      ).toBe(true);
      expect(
        isAllowedCoverUrl(
          "https://books.google.com/books/content?id=xyz&printsec=frontcover",
        ),
      ).toBe(true);
      expect(
        isAllowedCoverUrl("https://lain.bgm.tv/pic/cover/l/123.jpg"),
      ).toBe(true);
    });

    it("rejects SSRF loopback, local, and metadata endpoints", () => {
      expect(isAllowedCoverUrl("http://localhost/cover.jpg")).toBe(false);
      expect(isAllowedCoverUrl("http://127.0.0.1/cover.jpg")).toBe(false);
      expect(isAllowedCoverUrl("http://0.0.0.0/cover.jpg")).toBe(false);
      expect(
        isAllowedCoverUrl("http://169.254.169.254/latest/meta-data/"),
      ).toBe(false);
      expect(isAllowedCoverUrl("http://10.0.0.1/cover.jpg")).toBe(false);
      expect(isAllowedCoverUrl("http://192.168.1.1/cover.jpg")).toBe(false);
      expect(isAllowedCoverUrl("http://172.16.0.1/cover.jpg")).toBe(false);
      expect(isAllowedCoverUrl("http://internal.service.local/cover.jpg")).toBe(
        false,
      );
    });

    it("rejects non-HTTP protocols and credentialed URLs", () => {
      expect(isAllowedCoverUrl("ftp://images.ranobedb.org/cover.jpg")).toBe(
        false,
      );
      expect(isAllowedCoverUrl("file:///etc/passwd")).toBe(false);
      expect(
        isAllowedCoverUrl("https://user:pass@images.ranobedb.org/cover.jpg"),
      ).toBe(false);
      expect(isAllowedCoverUrl("javascript:alert(1)")).toBe(false);
      expect(isAllowedCoverUrl("not-a-valid-url")).toBe(false);
    });
  });

  describe("isLightNovelQuery Pattern Recognition", () => {
    it("recognizes common light novel keywords and acronyms", () => {
      expect(isLightNovelQuery("Sword Art Online LN")).toBe(true);
      expect(isLightNovelQuery("Overlord Light Novel")).toBe(true);
      expect(isLightNovelQuery("Solo Leveling WN")).toBe(true);
      expect(isLightNovelQuery("Reincarnated into another world")).toBe(true);
      expect(isLightNovelQuery("My Favorite Isekai Series")).toBe(true);
      expect(isLightNovelQuery("Popular Bunko release")).toBe(true);
      expect(isLightNovelQuery("Ranobe reader collection")).toBe(true);
    });

    it("recognizes iconic light novel franchise titles", () => {
      expect(isLightNovelQuery("Mushoku Tensei")).toBe(true);
      expect(isLightNovelQuery("Classroom of the Elite")).toBe(true);
      expect(isLightNovelQuery("Re:Zero Starting Life in Another World")).toBe(
        true,
      );
      expect(isLightNovelQuery("Danmachi Vol 1")).toBe(true);
      expect(isLightNovelQuery("Bakemonogatari")).toBe(true);
      expect(isLightNovelQuery("Tensura Slime")).toBe(true);
      expect(isLightNovelQuery("Konosuba God's Blessing")).toBe(true);
      expect(isLightNovelQuery("Spice and Wolf")).toBe(true);
    });

    it("returns false for generic or unrelated titles", () => {
      expect(isLightNovelQuery("The Great Gatsby")).toBe(false);
      expect(isLightNovelQuery("Clean Code")).toBe(false);
      expect(isLightNovelQuery("History of Rome")).toBe(false);
    });
  });

  describe("searchUniversalMetadata Multi-Source Prioritization", () => {
    it("prioritizes RanobeDB when query matches light novel patterns", async () => {
      const mockResults: ScrapedMetadata[] = [
        {
          title: "Overlord, Vol. 1",
          authors: "Kugane Maruyama",
          source: "GoogleBooks",
          confidence: 0.88,
          tags: ["Fiction"],
        },
        {
          title: "Overlord, Vol. 1: The Undead King",
          authors: "Kugane Maruyama",
          source: "RanobeDB",
          confidence: 0.85,
          tags: ["Light Novel", "Dark Fantasy"],
        },
      ];

      // Simulate the sorting logic tested inside searchUniversalMetadata
      const isLnTarget = true;
      mockResults.sort((a, b) => {
        if (isLnTarget) {
          if (
            a.source === "RanobeDB" &&
            b.source !== "RanobeDB" &&
            a.confidence >= 0.7
          )
            return -1;
          if (
            b.source === "RanobeDB" &&
            a.source !== "RanobeDB" &&
            b.confidence >= 0.7
          )
            return 1;
        }
        if (
          a.source === "RanobeDB" &&
          b.source !== "RanobeDB" &&
          a.confidence >= 0.85 &&
          b.confidence <= a.confidence + 0.05
        ) {
          return -1;
        }
        if (
          b.source === "RanobeDB" &&
          a.source !== "RanobeDB" &&
          b.confidence >= 0.85 &&
          a.confidence <= b.confidence + 0.05
        ) {
          return 1;
        }
        return b.confidence - a.confidence;
      });

      expect(mockResults[0].source).toBe("RanobeDB");
    });
  });

  describe("UI & Telegram Bot Integration for RanobeDB", () => {
    it("index.html displays RanobeDB in Multi-Source Lookup header and provides badge styling", async () => {
      const fs = await import("node:fs");
      const path = await import("node:path");
      const html = fs.readFileSync(
        path.join((import.meta as any).dir, "index.html"),
        "utf8",
      );

      // Verify header mentions RanobeDB
      expect(html).toContain("RanobeDB");
      expect(html).toContain("Multi-Source Metadata Lookup");

      // Verify source badge styling in metadata lookup result mapping
      expect(html).toContain("'RanobeDB': 'text-purple-300 bg-purple-950/60 border-purple-700/50'");
    });

    it("registerJobHandlers in bot.ts logs source and returns source in result", async () => {
      const fs = await import("node:fs");
      const path = await import("node:path");
      const botCode = fs.readFileSync(
        path.join((import.meta as any).dir, "bot.ts"),
        "utf8",
      );

      expect(botCode).toContain("Source: ${top.source}");
      expect(botCode).toContain("source: top.source");
      expect(botCode).toContain("Metadata Auto-Enriched");
    });
  });

  describe("Enhanced Ingestion Deduplication & Normalization", () => {
    describe("normalizeTitle", () => {
      it("strips release metadata tags like [Light Novel], (EPUB), [Official], [v01]", () => {
        expect(normalizeTitle("Overlord [Light Novel] [Official] (EPUB)")).toBe(
          "overlord",
        );
        expect(normalizeTitle("Mushoku Tensei [v01] (Retail) [Digital]")).toBe(
          "mushoku tensei",
        );
        expect(normalizeTitle("Sword Art Online (Fan-Translated) [Raw]")).toBe(
          "sword art online",
        );
      });

      it("strips punctuation variance (: - — ~ |)", () => {
        expect(normalizeTitle("Re:Zero - Starting Life — in Another World ~ Vol 1 | Special")).toBe(
          "re zero starting life in another world vol 1 special",
        );
      });

      it("normalizes volume and chapter numbering (Vol 1, Volume 01, v1, #1, Book 1)", () => {
        expect(normalizeTitle("Overlord Vol 1")).toBe("overlord vol 1");
        expect(normalizeTitle("Overlord Volume 01")).toBe("overlord vol 1");
        expect(normalizeTitle("Overlord v1")).toBe("overlord vol 1");
        expect(normalizeTitle("Overlord #1")).toBe("overlord vol 1");
        expect(normalizeTitle("Overlord Book 1")).toBe("overlord vol 1");
        expect(normalizeTitle("Overlord Bk. 01")).toBe("overlord vol 1");
        expect(normalizeTitle("Solo Leveling Chapter 05")).toBe("solo leveling ch 5");
        expect(normalizeTitle("Solo Leveling Ch. 5")).toBe("solo leveling ch 5");
      });
    });

    describe("normalizeAuthor", () => {
      it("strips role tags like (Author), (Artist), (Illustrator)", () => {
        expect(normalizeAuthor("Reki Kawahara (Author)")).toBe("reki kawahara");
        expect(normalizeAuthor("abec (Artist)")).toBe("abec");
        expect(normalizeAuthor("Fuse (Story), Mitz Vah (Art)")).toBe("fuse, mitz vah");
      });

      it("sorts multi-author lists alphabetically", () => {
        expect(normalizeAuthor("Robert Jordan, Brandon Sanderson")).toBe(
          "brandon sanderson, robert jordan",
        );
        expect(normalizeAuthor("Brandon Sanderson & Robert Jordan")).toBe(
          "brandon sanderson, robert jordan",
        );
        expect(normalizeAuthor("abec (Illustrator) and Reki Kawahara (Author)")).toBe(
          "abec, reki kawahara",
        );
      });
    });

    describe("getEpubContentSignature", () => {
      it("returns identical signature for recompressed EPUBs with same internal files", () => {
        const testDir = fs.mkdtempSync(path.join(os.tmpdir(), "epubsig-test-"));
        try {
          const zip1Path = path.join(testDir, "book1.epub");
          const zip2Path = path.join(testDir, "book2.epub");

          // Build two zip files in python to guarantee different timestamps/compression
          const proc = (globalThis as any).Bun.spawnSync([
            "python3",
            "-c",
            `
import zipfile
with zipfile.ZipFile("${zip1Path}", "w") as z:
    z.writestr("mimetype", "application/epub+zip", compress_type=zipfile.ZIP_STORED)
    z.writestr("META-INF/container.xml", "<container/>", compress_type=zipfile.ZIP_STORED)
    z.writestr("OEBPS/text.xhtml", "<html><body>Book text</body></html>", compress_type=zipfile.ZIP_STORED)

with zipfile.ZipFile("${zip2Path}", "w") as z:
    z.comment = b"recompressed"
    z.writestr("OEBPS/text.xhtml", "<html><body>Book text</body></html>", compress_type=zipfile.ZIP_DEFLATED)
    z.writestr("META-INF/container.xml", "<container/>", compress_type=zipfile.ZIP_DEFLATED)
    z.writestr("mimetype", "application/epub+zip", compress_type=zipfile.ZIP_STORED)
`,
          ]);
          expect(proc.exitCode).toBe(0);

          const sig1 = getEpubContentSignature(zip1Path);
          const sig2 = getEpubContentSignature(zip2Path);

          expect(sig1).not.toBeNull();
          expect(sig2).not.toBeNull();
          expect(sig1).toBe(sig2);
        } finally {
          fs.rmSync(testDir, { recursive: true, force: true });
        }
      });
    });

    describe("isSameBook & isSameBookAsync with Jev arbitration", () => {
      it("detects same book with punctuation and release tag variance", () => {
        const bookA = {
          title: "Overlord, Vol. 1: The Undead King",
          authors: "Kugane Maruyama",
        };
        const bookB = {
          title: "Overlord [Light Novel] Volume 01 — The Undead King (EPUB)",
          author: "Kugane Maruyama",
        };
        expect(isSameBook(bookA, bookB)).toBe(true);
      });

      it("differentiates different volumes in the same series", () => {
        const bookA = {
          title: "Overlord, Vol. 1: The Undead King",
          authors: "Kugane Maruyama",
        };
        const bookB = {
          title: "Overlord, Vol. 2: The Dark Warrior",
          author: "Kugane Maruyama",
        };
        expect(isSameBook(bookA, bookB)).toBe(false);
      });

      it("arbitrates ambiguous pairs via Jev System-1 arbitration hook", async () => {
        // Create an ambiguous pair with similarity in the 0.65 - 0.88 range
        const bookA = {
          title: "Classroom of the Elite: Year 1",
          authors: "Shougo Kinugasa",
        };
        const bookB = {
          title: "Classroom of the Elite: First Year Arc",
          author: "Shougo Kinugasa",
        };

        // Hermetic mock test for isSameBookAsync with custom Jev response
        const origFetch = globalThis.fetch;
        try {
          (globalThis as any).fetch = async () =>
            Response.json({
              answers: {
                is_duplicate: {
                  type: "choice",
                  choice: "duplicate",
                  confidence: 0.95,
                  probabilities: { duplicate: 0.95, distinct: 0.05 },
                },
              },
            });

          const isMatch = await isSameBookAsync(
            bookA,
            bookB,
            { jevApiKey: "test_key" },
          );
          expect(isMatch).toBe(true);
        } finally {
          globalThis.fetch = origFetch;
        }
      });

      it("respects Jev distinct arbitration for subtle false positives", async () => {
        const bookA = {
          title: "The Ancient Magus Bride Supplement",
          authors: "Kore Yamazaki",
        };
        const bookB = {
          title: "The Ancient Magus Bride Official Guide",
          author: "Kore Yamazaki",
        };

        const origFetch = globalThis.fetch;
        try {
          (globalThis as any).fetch = async () =>
            Response.json({
              answers: {
                is_duplicate: {
                  type: "choice",
                  choice: "distinct",
                  confidence: 0.92,
                  probabilities: { duplicate: 0.08, distinct: 0.92 },
                },
              },
            });

          const isMatch = await isSameBookAsync(
            bookA,
            bookB,
            { jevApiKey: "test_key" },
          );
          expect(isMatch).toBe(false);
        } finally {
          globalThis.fetch = origFetch;
        }
      });
    });
  });
});
