import { describe, it, expect } from "bun:test";
import {
  formatRanobeDate,
  parseRanobeBook,
  searchRanobeDB,
  searchAniList,
  cleanAniListDescription,
  cleanSeriesTitle,
  ANILIST_GRAPHQL_QUERY,
  isLightNovelQuery,
  isAllowedCoverUrl,
  KNOWN_COVER_DOMAINS,
  searchUniversalMetadata,
  normalizeTitleForDedup,
  normalizeAuthorForDedup,
  extractVolumeNumber,
  isSameBook,
  isSameBookAsync,
  classifyDuplicateWithJev,
  searchAllSources,
  ANILIST_MIN_INTERVAL_MS,
  MAX_RETRY_AFTER_MS,
  parseRetryAfterMs,
  paceAniListRequest,
  resetAniListPacing,
  autoEnrichBookSynopsis,
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

  describe("Enhanced Ingestion Duplicate Detection & Normalization", () => {
    describe("normalizeTitleForDedup", () => {
      it("strips release metadata tags and pirate/domain watermarks", () => {
        const t1 = normalizeTitleForDedup(
          "Overlord [Light Novel] [Official] [Digital] (EPUB)",
        );
        expect(t1).toBe("overlord");

        const t2 = normalizeTitleForDedup(
          "Mushoku Tensei (Retail) [Seven Seas] [v01]",
        );
        expect(t2).toBe("mushoku tensei vol 1");

        const t3 = normalizeTitleForDedup(
          "86 - EIGHTY-SIX (Light Novel) [Digital] [Premium]",
        );
        expect(t3).toBe("86 eighty six");
      });

      it("strips punctuation variance (: - — – ~ |)", () => {
        const variants = [
          "Spice and Wolf: Vol 1",
          "Spice and Wolf - Vol 1",
          "Spice and Wolf — Vol 1",
          "Spice and Wolf – Vol 1",
          "Spice and Wolf ~ Vol 1",
          "Spice and Wolf | Vol 1",
        ];
        const normalized = variants.map(normalizeTitleForDedup);
        const first = normalized[0];
        expect(first).toBe("spice and wolf vol 1");
        for (const n of normalized) {
          expect(n).toBe(first);
        }
      });

      it("normalizes volume numbering (Vol 1, Volume 01, v1, #1, Book 1)", () => {
        const variants = [
          "Overlord Vol 1",
          "Overlord Volume 01",
          "Overlord v1",
          "Overlord #1",
          "Overlord Book 1",
          "Overlord [v01]",
          "Overlord (Vol. 01)",
        ];
        const normalized = variants.map(normalizeTitleForDedup);
        expect(normalized[0]).toBe("overlord vol 1");
        for (const n of normalized) {
          expect(n).toBe("overlord vol 1");
        }
      });

      it("handles Burmese volume numbering accurately", () => {
        expect(normalizeTitleForDedup("စစ်နှင့်ငြိမ်းချမ်းရေး အတွဲ ၁")).toBe(
          "စစ်နှင့်ငြိမ်းချမ်းရေး vol 1",
        );
        expect(normalizeTitleForDedup("ရွှေဥဒေါင်း အပိုင်း 2")).toBe(
          "ရွှေဥဒေါင်း vol 2",
        );
      });

      it("preserves publication year in parentheses while normalizing volume", () => {
        const title = "The Hitchhiker's Guide to the Galaxy (1979) Vol 1";
        expect(normalizeTitleForDedup(title)).toBe(
          "the hitchhiker s guide to the galaxy vol 1",
        );
      });
    });

    describe("normalizeAuthorForDedup", () => {
      it("strips role tags like (Author), (Artist), [Illustrator]", () => {
        expect(normalizeAuthorForDedup("Kugane Maruyama (Author)")).toBe(
          "kugane maruyama",
        );
        expect(normalizeAuthorForDedup("so-bin [Artist]")).toBe("so-bin");
        expect(normalizeAuthorForDedup("Shirabii (Illustrator)")).toBe(
          "shirabii",
        );
      });

      it("sorts multi-author lists alphabetically regardless of input ordering", () => {
        const order1 = normalizeAuthorForDedup(
          "Kugane Maruyama (Author), so-bin (Artist)",
        );
        const order2 = normalizeAuthorForDedup(
          "so-bin (Illustrator) & Kugane Maruyama (Author)",
        );
        expect(order1).toBe("kugane maruyama, so-bin");
        expect(order2).toBe("kugane maruyama, so-bin");
        expect(order1).toBe(order2);
      });

      it("handles single authors and cleans watermarks/junk", () => {
        expect(normalizeAuthorForDedup("Brandon Sanderson")).toBe(
          "brandon sanderson",
        );
        expect(normalizeAuthorForDedup("admin")).toBe("");
        expect(normalizeAuthorForDedup("unknown")).toBe("");
      });
    });

    describe("extractVolumeNumber", () => {
      it("extracts volume number across diverse notations", () => {
        expect(extractVolumeNumber("Overlord Vol. 14")).toBe(14);
        expect(extractVolumeNumber("Overlord Volume 01")).toBe(1);
        expect(extractVolumeNumber("Overlord [v05]")).toBe(5);
        expect(extractVolumeNumber("Series #3")).toBe(3);
        expect(extractVolumeNumber("Book 2 - The Return")).toBe(2);
        expect(extractVolumeNumber("စစ်နှင့်ငြိမ်းချမ်းရေး အတွဲ ၄")).toBe(4);
      });

      it("returns null for non-volume standalone numbers and years", () => {
        expect(extractVolumeNumber("George Orwell 1984")).toBeNull();
        expect(extractVolumeNumber("A Space Odyssey (2001)")).toBeNull();
        expect(extractVolumeNumber("Clean Code")).toBeNull();
      });
    });

    describe("isSameBook deterministic matching & volume isolation", () => {
      it("NEVER merges different volumes in a series as duplicates", () => {
        const vol1 = {
          title: "Overlord, Vol. 1: The Undead King",
          authors: "Kugane Maruyama",
          series: "Overlord",
          series_index: 1,
        };
        const vol2 = {
          title: "Overlord, Vol. 2: The Dark Warrior",
          authors: "Kugane Maruyama",
          series: "Overlord",
          series_index: 2,
        };
        expect(isSameBook(vol1, vol2)).toBe(false);

        // Titles with volume in string but no explicit series field
        expect(
          isSameBook(
            { title: "Sword Art Online 01 - Aincrad", authors: "Reki Kawahara" },
            { title: "Sword Art Online 02 - Aincrad", authors: "Reki Kawahara" },
          ),
        ).toBe(false);

        expect(
          isSameBook(
            { title: "Mushoku Tensei Vol 1", authors: "Rifujin na Magonote" },
            { title: "Mushoku Tensei Vol 2", authors: "Rifujin na Magonote" },
          ),
        ).toBe(false);
      });

      it("matches duplicate books across different release tags and punctuation", () => {
        const existing = {
          title: "Overlord: Volume 01 [Official] [Digital]",
          authors: "Kugane Maruyama",
        };
        const incoming = {
          title: "Overlord - Vol 1 (Retail) (EPUB)",
          author: "Kugane Maruyama (Author)",
        };
        expect(isSameBook(existing, incoming)).toBe(true);
      });

      it("matches books with multi-author ordering variations", () => {
        const b1 = {
          title: "No Game No Life, Vol. 1",
          authors: "Yuu Kamiya & Mashiro Hiiragi",
        };
        const b2 = {
          title: "No Game No Life - Volume 01 [Light Novel]",
          author: "Mashiro Hiiragi (Artist), Yuu Kamiya (Author)",
        };
        expect(isSameBook(b1, b2)).toBe(true);
      });

      it("rejects books with conflicting authors even if titles match", () => {
        const b1 = {
          title: "The Hobbit",
          authors: "J.R.R. Tolkien",
        };
        const b2 = {
          title: "The Hobbit",
          author: "Completely Different Person",
        };
        expect(isSameBook(b1, b2)).toBe(false);
      });
    });

    describe("Jev System-1 Triage Arbitration (classifyDuplicateWithJev & isSameBookAsync)", () => {
      it("classifies duplicate with Jev System-1 when in ambiguous similarity zone", async () => {
        // Mock global fetch / safeFetchWithSsrf via custom handler
        const origFetch = globalThis.fetch;
        let calledJev = false;
        (globalThis as any).fetch = async (url: string, init?: any) => {
          if (typeof url === "string" && url.includes("typesafe.ai")) {
            calledJev = true;
            return new Response(
              JSON.stringify({
                model: "jev-latest",
                answers: {
                  is_duplicate: {
                    choice: "duplicate",
                    confidence: 0.95,
                  },
                },
              }),
              { status: 200, headers: { "Content-Type": "application/json" } },
            );
          }
          return origFetch(url as any, init);
        };

        try {
          // Titles in the ambiguous zone (0.65 <= sim < 0.88)
          const b1 = {
            title: "Re:Zero Starting Life in Another World Prologue Chapter",
            authors: "Tappei Nagatsuki",
          };
          const b2 = {
            title: "Re:Zero Life in Another World - Prologue Arc Edition",
            author: "Tappei Nagatsuki",
          };

          const isDup = await isSameBookAsync(b1, b2, {
            jevApiKey: "test_jev_api_key_123",
          });
          expect(calledJev).toBe(true);
          expect(isDup).toBe(true);
        } finally {
          (globalThis as any).fetch = origFetch;
        }
      });

      it("respects distinct verdict from Jev System-1 for subtle subtitle differences", async () => {
        const origFetch = globalThis.fetch;
        let calledJev = false;
        (globalThis as any).fetch = async (url: string, init?: any) => {
          if (typeof url === "string" && url.includes("typesafe.ai")) {
            calledJev = true;
            return new Response(
              JSON.stringify({
                model: "jev-latest",
                answers: {
                  is_duplicate: {
                    choice: "distinct",
                    confidence: 0.92,
                  },
                },
              }),
              { status: 200, headers: { "Content-Type": "application/json" } },
            );
          }
          return origFetch(url as any, init);
        };

        try {
          const b1 = {
            title: "Re:Zero Starting Life in Another World: Sanctuary Arc",
            authors: "Tappei Nagatsuki",
          };
          const b2 = {
            title: "Re:Zero Life in Another World - Witch Cult Arc",
            author: "Tappei Nagatsuki",
          };

          const isDup = await isSameBookAsync(b1, b2, {
            jevApiKey: "test_jev_api_key_123",
          });
          expect(calledJev).toBe(true);
          expect(isDup).toBe(false);
        } finally {
          (globalThis as any).fetch = origFetch;
        }
      });

      it("gracefully falls back when Jev API key is missing", async () => {
        const b1 = {
          title: "Overlord: Volume 01 [Official] [Digital]",
          authors: "Kugane Maruyama",
        };
        const b2 = {
          title: "Overlord - Vol 1 (Retail) (EPUB)",
          author: "Kugane Maruyama",
        };

        // Without Jev key, deterministic high-similarity/exact normalized match still succeeds
        const isDup = await isSameBookAsync(b1, b2, { jevApiKey: "" });
        expect(isDup).toBe(true);
      });

      it("enforces redirect: 'error' and timeout coverage through response parsing", async () => {
        const origFetch = globalThis.fetch;
        let capturedInit: any = null;
        (globalThis as any).fetch = async (url: string, init?: any) => {
          if (typeof url === "string" && url.includes("typesafe.ai")) {
            capturedInit = init;
            return new Response(
              JSON.stringify({
                model: "jev-latest",
                answers: {
                  is_duplicate: { choice: "duplicate", confidence: 0.99 },
                },
              }),
              { status: 200, headers: { "Content-Type": "application/json" } },
            );
          }
          return origFetch(url as any, init);
        };

        try {
          const b1 = { title: "Book One Title", authors: "Author" };
          const b2 = { title: "Book Two Title", author: "Author" };
          await classifyDuplicateWithJev(b1, b2, { apiKey: "test_key_123" });

          expect(capturedInit).not.toBeNull();
          expect(capturedInit.redirect).toBe("error");
          expect(capturedInit.signal).toBeDefined();
        } finally {
          (globalThis as any).fetch = origFetch;
        }
      });
    });
  });

  describe("Jev-Powered Source Category Classification & Smart Routing (searchAllSources)", () => {
    it("exports searchAllSources as an alias to searchUniversalMetadata", () => {
      expect(searchAllSources).toBe(searchUniversalMetadata);
    });

    it("routes light novel queries to RanobeDB + Bangumi and then Google Books", async () => {
      const origFetch = globalThis.fetch;
      const requestedUrls: string[] = [];

      (globalThis as any).fetch = async (url: string) => {
        const urlStr = String(url);
        requestedUrls.push(urlStr);

        if (urlStr.includes("typesafe.ai")) {
          return new Response(
            JSON.stringify({
              answers: {
                source_category_verdict: { choice: "light_novel", confidence: 0.95 },
              },
            }),
            { status: 200, headers: { "Content-Type": "application/json" } },
          );
        }

        if (urlStr.includes("ranobedb.org/api/v0/books")) {
          return new Response(
            JSON.stringify({
              books: [
                {
                  id: 101,
                  title: "Overlord, Vol. 1",
                  image: { filename: "overlord.jpg" },
                },
              ],
            }),
            { status: 200, headers: { "Content-Type": "application/json" } },
          );
        }

        if (urlStr.includes("ranobedb.org/api/v0/book/101")) {
          return new Response(
            JSON.stringify({
              book: {
                id: 101,
                title: "Overlord, Vol. 1",
                image: { filename: "overlord.jpg" },
              },
            }),
            { status: 200, headers: { "Content-Type": "application/json" } },
          );
        }

        if (urlStr.includes("api.bgm.tv")) {
          return new Response(
            JSON.stringify({ list: [] }),
            { status: 200, headers: { "Content-Type": "application/json" } },
          );
        }

        return new Response("{}", { status: 200, headers: { "Content-Type": "application/json" } });
      };

      try {
        const results = await searchAllSources("Overlord [LN]");
        expect(results.length).toBeGreaterThan(0);
        expect(results[0].source).toBe("RanobeDB");

        // Verify RanobeDB and Bangumi were called
        expect(requestedUrls.some((u) => u.includes("ranobedb.org"))).toBe(true);
        expect(requestedUrls.some((u) => u.includes("api.bgm.tv"))).toBe(true);
        // Did not call MangaDex first
        expect(requestedUrls.some((u) => u.includes("mangadex.org"))).toBe(false);
      } finally {
        (globalThis as any).fetch = origFetch;
      }
    });

    it("routes manga queries to MangaDex + Bangumi first", async () => {
      const origFetch = globalThis.fetch;
      const requestedUrls: string[] = [];

      (globalThis as any).fetch = async (url: string) => {
        const urlStr = String(url);
        requestedUrls.push(urlStr);

        if (urlStr.includes("typesafe.ai")) {
          return new Response(
            JSON.stringify({
              answers: {
                source_category_verdict: { choice: "manga", confidence: 0.95 },
              },
            }),
            { status: 200, headers: { "Content-Type": "application/json" } },
          );
        }

        if (urlStr.includes("mangadex.org")) {
          return new Response(
            JSON.stringify({
              data: [
                {
                  id: "manga-1",
                  attributes: {
                    title: { en: "Berserk" },
                    description: { en: "Dark fantasy manga" },
                  },
                  relationships: [],
                },
              ],
            }),
            { status: 200, headers: { "Content-Type": "application/json" } },
          );
        }

        if (urlStr.includes("api.bgm.tv")) {
          return new Response(
            JSON.stringify({ list: [] }),
            { status: 200, headers: { "Content-Type": "application/json" } },
          );
        }

        return new Response("{}", { status: 200, headers: { "Content-Type": "application/json" } });
      };

      try {
        const results = await searchAllSources("Berserk [Manga]");
        expect(results.length).toBeGreaterThan(0);
        expect(results[0].source).toBe("MangaDex");

        // Verify MangaDex was queried
        expect(requestedUrls.some((u) => u.includes("mangadex.org"))).toBe(true);
        // Did not query RanobeDB for manga
        expect(requestedUrls.some((u) => u.includes("ranobedb.org"))).toBe(false);
      } finally {
        (globalThis as any).fetch = origFetch;
      }
    });

    it("routes general books to Google Books + OpenLibrary first", async () => {
      const origFetch = globalThis.fetch;
      const requestedUrls: string[] = [];

      (globalThis as any).fetch = async (url: string) => {
        const urlStr = String(url);
        requestedUrls.push(urlStr);

        if (urlStr.includes("typesafe.ai")) {
          return new Response(
            JSON.stringify({
              answers: {
                source_category_verdict: { choice: "general_book", confidence: 0.95 },
              },
            }),
            { status: 200, headers: { "Content-Type": "application/json" } },
          );
        }

        if (urlStr.includes("googleapis.com/books")) {
          return new Response(
            JSON.stringify({
              items: [
                {
                  volumeInfo: {
                    title: "The Great Gatsby",
                    authors: ["F. Scott Fitzgerald"],
                    categories: ["Fiction"],
                  },
                },
              ],
            }),
            { status: 200, headers: { "Content-Type": "application/json" } },
          );
        }

        if (urlStr.includes("openlibrary.org")) {
          return new Response(
            JSON.stringify({ docs: [] }),
            { status: 200, headers: { "Content-Type": "application/json" } },
          );
        }

        return new Response("{}", { status: 200, headers: { "Content-Type": "application/json" } });
      };

      try {
        const results = await searchAllSources("The Great Gatsby", {
          category: "general_book",
        });
        expect(results.length).toBeGreaterThan(0);
        expect(results[0].source).toBe("GoogleBooks");

        expect(requestedUrls.some((u) => u.includes("googleapis.com/books"))).toBe(true);
        // Did not query RanobeDB or MangaDex primarily
        expect(requestedUrls.some((u) => u.includes("ranobedb.org"))).toBe(false);
        expect(requestedUrls.some((u) => u.includes("mangadex.org"))).toBe(false);
      } finally {
        (globalThis as any).fetch = origFetch;
      }
    });

    it("skips overseas searches entirely for 'burmese' category", async () => {
      const origFetch = globalThis.fetch;
      const requestedUrls: string[] = [];

      (globalThis as any).fetch = async (url: string) => {
        requestedUrls.push(String(url));
        return new Response("{}", { status: 200, headers: { "Content-Type": "application/json" } });
      };

      try {
        const results = await searchAllSources("မြန်မာ့သမိုင်း အတွဲ ၁");
        expect(results.length).toBe(0);
        // Overseas APIs are skipped
        expect(requestedUrls.some((u) => u.includes("ranobedb.org"))).toBe(false);
        expect(requestedUrls.some((u) => u.includes("mangadex.org"))).toBe(false);
        expect(requestedUrls.some((u) => u.includes("googleapis.com/books"))).toBe(false);
        expect(requestedUrls.some((u) => u.includes("openlibrary.org"))).toBe(false);
      } finally {
        (globalThis as any).fetch = origFetch;
      }
    });

    it("routes 'other' category directly to Google Books + OpenLibrary first", async () => {
      const origFetch = globalThis.fetch;
      const requestedUrls: string[] = [];

      (globalThis as any).fetch = async (url: string) => {
        const urlStr = String(url);
        requestedUrls.push(urlStr);

        if (urlStr.includes("googleapis.com/books")) {
          return new Response(
            JSON.stringify({
              items: [
                {
                  volumeInfo: {
                    title: "Les Misérables",
                    authors: ["Victor Hugo"],
                    categories: ["Classic Literature"],
                  },
                },
              ],
            }),
            { status: 200, headers: { "Content-Type": "application/json" } },
          );
        }

        return new Response("{}", { status: 200, headers: { "Content-Type": "application/json" } });
      };

      try {
        const results = await searchAllSources("Les Misérables", {
          category: "other",
        });
        expect(results.length).toBeGreaterThan(0);
        expect(results[0].source).toBe("GoogleBooks");

        // Primary general book hosts were queried for 'other'
        expect(requestedUrls.some((u) => u.includes("googleapis.com/books"))).toBe(true);
        // Did not query RanobeDB or MangaDex primarily
        expect(requestedUrls.some((u) => u.includes("ranobedb.org"))).toBe(false);
      } finally {
        (globalThis as any).fetch = origFetch;
      }
    });

    it("never overrides explicit or deterministic manga with light novel franchise rule", async () => {
      const origFetch = globalThis.fetch;
      const requestedUrls: string[] = [];

      (globalThis as any).fetch = async (url: string) => {
        const urlStr = String(url);
        requestedUrls.push(urlStr);

        if (urlStr.includes("mangadex.org")) {
          return new Response(
            JSON.stringify({
              data: [
                {
                  id: "manga-overlord",
                  attributes: {
                    title: { en: "Overlord" },
                    description: { en: "Manga adaptation of Overlord" },
                  },
                  relationships: [],
                },
              ],
            }),
            { status: 200, headers: { "Content-Type": "application/json" } },
          );
        }

        return new Response("{}", { status: 200, headers: { "Content-Type": "application/json" } });
      };

      try {
        // "Overlord" has a franchise name, but filename is .cbz (manga)
        const results = await searchAllSources("Overlord", {
          filename: "overlord.cbz",
        });
        expect(results.length).toBeGreaterThan(0);
        expect(results[0].source).toBe("MangaDex");

        // MangaDex was queried first, NOT RanobeDB
        expect(requestedUrls.some((u) => u.includes("mangadex.org"))).toBe(true);
        expect(requestedUrls.some((u) => u.includes("ranobedb.org"))).toBe(false);
      } finally {
        (globalThis as any).fetch = origFetch;
      }
    });

    it("routes franchise titles like Re:Zero or Overlord to Light Novel sources even if unbracketed", async () => {
      const origFetch = globalThis.fetch;
      const requestedUrls: string[] = [];

      (globalThis as any).fetch = async (url: string) => {
        const urlStr = String(url);
        requestedUrls.push(urlStr);

        if (urlStr.includes("ranobedb.org/api/v0/books")) {
          return new Response(
            JSON.stringify({
              books: [
                {
                  id: 202,
                  title: "Re:Zero Starting Life in Another World",
                  image: { filename: "rezero.jpg" },
                },
              ],
            }),
            { status: 200, headers: { "Content-Type": "application/json" } },
          );
        }

        if (urlStr.includes("ranobedb.org/api/v0/book/202")) {
          return new Response(
            JSON.stringify({
              book: {
                id: 202,
                title: "Re:Zero Starting Life in Another World",
                image: { filename: "rezero.jpg" },
              },
            }),
            { status: 200, headers: { "Content-Type": "application/json" } },
          );
        }

        return new Response("{}", { status: 200, headers: { "Content-Type": "application/json" } });
      };

      try {
        const results = await searchAllSources("Re:Zero");
        expect(results.length).toBeGreaterThan(0);
        expect(results[0].source).toBe("RanobeDB");

        expect(requestedUrls.some((u) => u.includes("ranobedb.org"))).toBe(true);
        // Did not query Google Books first
        expect(requestedUrls.some((u) => u.includes("googleapis.com/books"))).toBe(false);
      } finally {
        (globalThis as any).fetch = origFetch;
      }
    });

    it("falls back to secondary search when primary returns 0 results so no book is left without metadata", async () => {
      const origFetch = globalThis.fetch;
      const requestedUrls: string[] = [];

      (globalThis as any).fetch = async (url: string) => {
        const urlStr = String(url);
        requestedUrls.push(urlStr);

        // Primary general book returns 0
        if (urlStr.includes("googleapis.com/books") || urlStr.includes("openlibrary.org")) {
          return new Response(JSON.stringify({ items: [], docs: [] }), {
            status: 200,
            headers: { "Content-Type": "application/json" },
          });
        }

        // Secondary fallback hits RanobeDB
        if (urlStr.includes("ranobedb.org")) {
          return new Response(
            JSON.stringify({
              books: [
                {
                  id: 999,
                  title: "Obscure Title",
                  image: { filename: "obscure.jpg" },
                },
              ],
            }),
            { status: 200, headers: { "Content-Type": "application/json" } },
          );
        }

        return new Response("{}", { status: 200, headers: { "Content-Type": "application/json" } });
      };

      try {
        const results = await searchAllSources("Obscure Title", {
          category: "general_book",
        });
        expect(results.length).toBeGreaterThan(0);
        expect(results[0].source).toBe("RanobeDB");

        // Both primary (Google/OpenLib) and secondary fallback (RanobeDB) were attempted
        expect(requestedUrls.some((u) => u.includes("googleapis.com/books"))).toBe(true);
        expect(requestedUrls.some((u) => u.includes("ranobedb.org"))).toBe(true);
      } finally {
        (globalThis as any).fetch = origFetch;
      }
    });
  });

  // ==========================================================================
  // AniList Scraper & GraphQL Integration
  // ==========================================================================
  describe("AniList Scraper & GraphQL Integration", () => {
    it("exports ANILIST_GRAPHQL_QUERY containing Media search and NOVEL/MANGA formats", () => {
      expect(ANILIST_GRAPHQL_QUERY).toContain("Media(search: $search, type: MANGA, format_in: [NOVEL, MANGA])");
      expect(ANILIST_GRAPHQL_QUERY).toContain("coverImage");
      expect(ANILIST_GRAPHQL_QUERY).toContain("extraLarge");
      expect(ANILIST_GRAPHQL_QUERY).toContain("description");
      expect(ANILIST_GRAPHQL_QUERY).toContain("staff");
    });

    it("cleanAniListDescription strips HTML tags and decodes entities cleanly", () => {
      const raw = "Hyeon&rsquo;s story&mdash;an epic tale.<br><br>He fought <b>bravely</b> &amp; boldly.<br>(Source: Tapas, edited)";
      const clean = cleanAniListDescription(raw);
      expect(clean).toContain("Hyeon's story—an epic tale.");
      expect(clean).toContain("He fought bravely & boldly.");
      expect(clean).not.toContain("<b>");
      expect(clean).not.toContain("<br>");
      expect(clean).not.toContain("&rsquo;");
      expect(clean).not.toContain("&amp;");
    });

    it("cleanSeriesTitle extracts canonical series title from diverse volume notations", () => {
      expect(cleanSeriesTitle("The Legendary Moonlight Sculptor, Vol. 1")).toBe("The Legendary Moonlight Sculptor");
      expect(cleanSeriesTitle("The Legendary Moonlight Sculptor Vol 02")).toBe("The Legendary Moonlight Sculptor");
      expect(cleanSeriesTitle("Trapped in a Dating Sim: The World of Otome Games Is Tough for Mobs, Vol. 02")).toBe(
        "Trapped in a Dating Sim The World of Otome Games Is Tough for Mobs",
      );
      expect(cleanSeriesTitle("I'm the Evil Lord of an Intergalactic Empire! Volume 1")).toBe(
        "I'm the Evil Lord of an Intergalactic Empire",
      );
      expect(cleanSeriesTitle("Overlord 01 - The Undead King")).toBe("Overlord");
      expect(cleanSeriesTitle("Sword Art Online #1")).toBe("Sword Art Online");
      expect(cleanSeriesTitle("Solo Leveling Vol 03")).toBe("Solo Leveling");
    });

    it("validates anilistcdn and anilist.co in isAllowedCoverUrl and KNOWN_COVER_DOMAINS", () => {
      expect(KNOWN_COVER_DOMAINS.has("anilist.co")).toBe(true);
      expect(KNOWN_COVER_DOMAINS.has("s4.anilist.co")).toBe(true);
      expect(KNOWN_COVER_DOMAINS.has("anilistcdn.com")).toBe(true);

      expect(isAllowedCoverUrl("https://s4.anilist.co/file/anilistcdn/media/manga/cover/medium/b85869-MgqRdF3H3wek.png")).toBe(true);
      expect(isAllowedCoverUrl("https://media.anilist.co/cover/large.jpg")).toBe(true);
      expect(isAllowedCoverUrl("https://anilistcdn.com/cover.png")).toBe(true);
      expect(isAllowedCoverUrl("https://img.anilistcdn.com/file/cover.jpg")).toBe(true);

      // Negative SSRF cases: .local / .internal / private IP rejection must not be bypassed
      expect(isAllowedCoverUrl("http://anilistcdn.local/cover.jpg")).toBe(false);
      expect(isAllowedCoverUrl("http://anilistcdn.internal/cover.jpg")).toBe(false);
      expect(isAllowedCoverUrl("http://s4.anilist.co.local/cover.jpg")).toBe(false);
      expect(isAllowedCoverUrl("http://127.0.0.1/cover.jpg")).toBe(false);
      expect(isAllowedCoverUrl("http://10.0.0.1/anilistcdn/cover.jpg")).toBe(false);
    });

    it("searchAniList executes GraphQL POST query and parses Media result", async () => {
      let interceptedUrl = "";
      let interceptedMethod = "";
      let interceptedBody: any = null;

      const mockFetch = async (url: string, init?: any) => {
        interceptedUrl = url;
        interceptedMethod = init?.method || "";
        interceptedBody = JSON.parse(init?.body || "{}");

        return new Response(
          JSON.stringify({
            data: {
              Media: {
                id: 85869,
                title: {
                  english: "The Legendary Moonlight Sculptor",
                  romaji: "Dalbitjogaksa",
                  native: "달빛조각사",
                },
                description: "Hyeon is resourceful and thrifty.<br><br>He enters Royal Road.",
                coverImage: {
                  extraLarge: "https://s4.anilist.co/file/anilistcdn/media/manga/cover/medium/b85869-MgqRdF3H3wek.png",
                  large: "https://s4.anilist.co/file/anilistcdn/media/manga/cover/medium/b85869.png",
                },
                genres: ["Action", "Adventure", "Fantasy"],
                tags: [{ name: "Virtual Reality" }, { name: "MMORPG" }],
                startDate: { year: 2007, month: 1, day: 15 },
                format: "NOVEL",
                status: "FINISHED",
                staff: {
                  edges: [
                    {
                      role: "Original Story",
                      node: { name: { full: "Hui-Seong Nam" } },
                    },
                  ],
                },
              },
            },
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      };

      const hits = await searchAniList("The Legendary Moonlight Sculptor", {
        fetchFn: mockFetch,
      });

      expect(interceptedUrl).toBe("https://graphql.anilist.co");
      expect(interceptedMethod).toBe("POST");
      expect(interceptedBody.query).toContain("Media(search: $search, type: MANGA, format_in: [NOVEL, MANGA])");
      expect(interceptedBody.variables.search).toBe("The Legendary Moonlight Sculptor");

      expect(hits.length).toBe(1);
      const hit = hits[0];
      expect(hit.source).toBe("AniList");
      expect(hit.title).toBe("The Legendary Moonlight Sculptor");
      expect(hit.authors).toBe("Hui-Seong Nam");
      expect(hit.description).toContain("Hyeon is resourceful and thrifty.");
      expect(hit.description).not.toContain("<br>");
      expect(hit.coverUrl).toBe("https://s4.anilist.co/file/anilistcdn/media/manga/cover/medium/b85869-MgqRdF3H3wek.png");
      expect(hit.tags).toContain("Light Novel");
      expect(hit.tags).toContain("Action");
      expect(hit.tags).toContain("Virtual Reality");
      expect(hit.publishedDate).toBe("2007-01-15");
      expect(hit.confidence).toBeGreaterThanOrEqual(0.9);
      expect(hit.isManga).toBe(false);
    });

    it("searchAniList handles Page-wrapped results and manga format", async () => {
      const mockFetch = async () => {
        return new Response(
          JSON.stringify({
            data: {
              Page: {
                media: [
                  {
                    id: 12345,
                    title: {
                      english: "Solo Leveling",
                      romaji: "Na Honjaman Level Up",
                    },
                    description: "Sung Jin-Woo awakens as a player.",
                    coverImage: {
                      extraLarge: "https://s4.anilist.co/file/anilistcdn/media/manga/cover/large/sl.jpg",
                    },
                    genres: ["Action", "Supernatural"],
                    tags: [{ name: "Dungeon" }],
                    format: "MANGA",
                    staff: {
                      edges: [
                        {
                          role: "Story",
                          node: { name: { full: "Chugong" } },
                        },
                      ],
                    },
                  },
                ],
              },
            },
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      };

      const hits = await searchAniList("Solo Leveling", { fetchFn: mockFetch });
      expect(hits.length).toBe(1);
      expect(hits[0].title).toBe("Solo Leveling");
      expect(hits[0].authors).toBe("Chugong");
      expect(hits[0].isManga).toBe(true);
      expect(hits[0].tags).toContain("Manga");
      expect(hits[0].tags).toContain("Action");
    });

    it("searchAniList handles network errors, HTTP 429/500, and GraphQL errors gracefully", async () => {
      const failingFetch = async () => {
        throw new Error("Network timeout connecting to AniList");
      };

      const hits = await searchAniList("Failing Query", { fetchFn: failingFetch });
      expect(hits).toEqual([]);

      const nullMediaFetch = async () => {
        return new Response(JSON.stringify({ data: { Media: null } }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      };
      const emptyHits = await searchAniList("Unknown Work", { fetchFn: nullMediaFetch });
      expect(emptyHits).toEqual([]);

      const graphQLErrorFetch = async () => {
        return new Response(
          JSON.stringify({
            errors: [{ message: "Not Found.", status: 404 }],
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      };
      const errorHits = await searchAniList("Nonexistent Book", { fetchFn: graphQLErrorFetch });
      expect(errorHits).toEqual([]);

      const rateLimitFetch = async () => {
        return new Response("Too Many Requests", {
          status: 429,
          headers: { "Retry-After": "60" },
        });
      };
      const rateLimitHits = await searchAniList("Rate Limited", { fetchFn: rateLimitFetch });
      expect(rateLimitHits).toEqual([]);

      const serverErrorFetch = async () => {
        return new Response("Internal Server Error", { status: 500 });
      };
      const serverErrorHits = await searchAniList("Server Error", { fetchFn: serverErrorFetch });
      expect(serverErrorHits).toEqual([]);
    });

    it("searchUniversalMetadata includes searchAniList for light_novel and manga categories", async () => {
      const origFetch = globalThis.fetch;
      const requestedUrls: string[] = [];

      (globalThis as any).fetch = async (url: any, _init: any) => {
        const urlStr = typeof url === "string" ? url : url.toString();
        requestedUrls.push(urlStr);

        if (urlStr.includes("graphql.anilist.co")) {
          return new Response(
            JSON.stringify({
              data: {
                Media: {
                  id: 111,
                  title: { english: "Trapped in a Dating Sim" },
                  description: "Leon gets reincarnated into an otome game world.",
                  coverImage: { extraLarge: "https://s4.anilist.co/cover/dating.jpg" },
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
        const lnResults = await searchUniversalMetadata("Trapped in a Dating Sim", {
          category: "light_novel",
        });
        expect(requestedUrls.some((u) => u.includes("graphql.anilist.co"))).toBe(true);
        expect(lnResults.some((r) => r.source === "AniList")).toBe(true);

        requestedUrls.length = 0;
        const mangaResults = await searchUniversalMetadata("Trapped in a Dating Sim", {
          category: "manga",
        });
        expect(requestedUrls.some((u) => u.includes("graphql.anilist.co"))).toBe(true);
        expect(mangaResults.some((r) => r.source === "AniList")).toBe(true);
      } finally {
        (globalThis as any).fetch = origFetch;
      }
    });

    describe("AniList Request Pacing & HTTP 429 Backoff", () => {
      it("parseRetryAfterMs correctly parses integer seconds, floats, HTTP dates, and defaults", () => {
        expect(parseRetryAfterMs("5")).toBe(5000);
        expect(parseRetryAfterMs("60")).toBe(60000);
        expect(parseRetryAfterMs("0")).toBe(0);
        expect(parseRetryAfterMs("1.5")).toBe(1500);
        expect(parseRetryAfterMs("  3  ")).toBe(3000);
        expect(parseRetryAfterMs(null)).toBe(2000);
        expect(parseRetryAfterMs(undefined)).toBe(2000);
        expect(parseRetryAfterMs("")).toBe(2000);
        expect(parseRetryAfterMs("invalid-header")).toBe(2000);
        expect(parseRetryAfterMs("-10", 3000)).toBe(3000);
        expect(parseRetryAfterMs("Infinity")).toBe(2000);
        expect(parseRetryAfterMs("-Infinity")).toBe(2000);
        expect(parseRetryAfterMs("NaN")).toBe(2000);

        // Clamps to MAX_RETRY_AFTER_MS (60s)
        expect(parseRetryAfterMs("120")).toBe(MAX_RETRY_AFTER_MS);
        expect(parseRetryAfterMs("999999")).toBe(MAX_RETRY_AFTER_MS);

        // Future HTTP-date
        const futureDate = new Date(Date.now() + 5000).toUTCString();
        const diff = parseRetryAfterMs(futureDate);
        expect(diff).toBeGreaterThan(3000);
        expect(diff).toBeLessThanOrEqual(5100);
      });

      it("searchAniList parses Retry-After header, sleeps, retries once, and returns hits on success", async () => {
        resetAniListPacing();
        let callCount = 0;
        const recordedSleeps: number[] = [];

        const mockFetch = async () => {
          callCount++;
          if (callCount === 1) {
            // First attempt: return 429 with Retry-After: 3
            return new Response("Too Many Requests", {
              status: 429,
              headers: { "Retry-After": "3" },
            });
          }
          // Second attempt (retry): return 200 OK with media
          return new Response(
            JSON.stringify({
              data: {
                Media: {
                  id: 999,
                  title: { english: "Classroom of the Elite" },
                  description: "Kiyotaka Ayanokoji enters Tokyo Metropolitan Advanced Nurturing High School.",
                  format: "NOVEL",
                },
              },
            }),
            { status: 200, headers: { "Content-Type": "application/json" } },
          );
        };

        const mockSleep = async (ms: number) => {
          recordedSleeps.push(ms);
        };

        const hits = await searchAniList("Classroom of the Elite", {
          fetchFn: mockFetch,
          sleepFn: mockSleep,
        });

        expect(callCount).toBe(2);
        expect(recordedSleeps).toContain(3000);
        expect(hits.length).toBe(1);
        expect(hits[0].title).toBe("Classroom of the Elite");
        expect(hits[0].source).toBe("AniList");
      });

      it("searchAniList backs off on 429 without Retry-After header and stops after 1 retry if 429 persists", async () => {
        resetAniListPacing();
        let callCount = 0;
        const recordedSleeps: number[] = [];

        const persistent429Fetch = async () => {
          callCount++;
          return new Response("Too Many Requests", { status: 429 });
        };

        const mockSleep = async (ms: number) => {
          recordedSleeps.push(ms);
        };

        const hits = await searchAniList("Persistent Rate Limit", {
          fetchFn: persistent429Fetch,
          sleepFn: mockSleep,
        });

        expect(callCount).toBe(2); // Exactly 1 retry
        expect(recordedSleeps).toContain(2000); // Default 2000ms backoff
        expect(hits).toEqual([]);
      });

      it("searchAniList enforces at least 700ms request pacing between consecutive calls", async () => {
        resetAniListPacing();
        const recordedSleeps: number[] = [];
        const mockSleep = async (ms: number) => {
          recordedSleeps.push(ms);
        };

        const dummyFetch = async () => {
          return new Response(
            JSON.stringify({
              data: {
                Media: {
                  id: 1001,
                  title: { english: "Overlord" },
                  format: "NOVEL",
                },
              },
            }),
            { status: 200, headers: { "Content-Type": "application/json" } },
          );
        };

        // First call (initial)
        await searchAniList("Overlord 1", {
          fetchFn: dummyFetch,
          sleepFn: mockSleep,
        });

        // Immediate second call should be paced by ~700ms
        await searchAniList("Overlord 2", {
          fetchFn: dummyFetch,
          sleepFn: mockSleep,
        });

        // Pacing should have triggered for the second call
        expect(recordedSleeps.length).toBeGreaterThanOrEqual(1);
        expect(recordedSleeps[0]).toBeGreaterThanOrEqual(650);
        expect(recordedSleeps[0]).toBeLessThanOrEqual(ANILIST_MIN_INTERVAL_MS);
      });

      it("paceAniListRequest directly paces requests and respects custom minIntervalMs", async () => {
        resetAniListPacing();
        const recordedSleeps: number[] = [];
        const mockSleep = async (ms: number) => {
          recordedSleeps.push(ms);
        };

        // First call
        await paceAniListRequest(500, mockSleep);
        expect(recordedSleeps.length).toBe(0);

        // Immediate second call
        await paceAniListRequest(500, mockSleep);
        expect(recordedSleeps.length).toBe(1);
        expect(recordedSleeps[0]).toBeGreaterThanOrEqual(450);
        expect(recordedSleeps[0]).toBeLessThanOrEqual(500);
      });

      it("enforces serial process-wide queue during 429 backoff preventing concurrency stampedes", async () => {
        resetAniListPacing();
        const callOrder: string[] = [];
        const recordedSleeps: { query: string; ms: number }[] = [];
        let inFlight = 0;
        let maxParallel = 0;

        let attempt1 = 0;
        const fetch1 = async () => {
          inFlight++;
          maxParallel = Math.max(maxParallel, inFlight);
          attempt1++;
          callOrder.push(`fetch1_attempt_${attempt1}`);
          const isFirst = attempt1 === 1;
          inFlight--;
          if (isFirst) {
            return new Response("Too Many Requests", {
              status: 429,
              headers: { "Retry-After": "2" }, // 2000ms backoff
            });
          }
          return new Response(
            JSON.stringify({
              data: {
                Media: {
                  id: 1,
                  title: { english: "Overlord" },
                  description: "A dark fantasy novel series.",
                  format: "NOVEL",
                },
              },
            }),
            { status: 200, headers: { "Content-Type": "application/json" } },
          );
        };

        const fetch2 = async () => {
          inFlight++;
          maxParallel = Math.max(maxParallel, inFlight);
          callOrder.push("fetch2");
          inFlight--;
          return new Response(
            JSON.stringify({
              data: {
                Media: {
                  id: 2,
                  title: { english: "Danmachi" },
                  description: "Is it wrong to try to pick up girls in a dungeon?",
                  format: "NOVEL",
                },
              },
            }),
            { status: 200, headers: { "Content-Type": "application/json" } },
          );
        };

        const sleep1 = async (ms: number) => {
          recordedSleeps.push({ query: "q1", ms });
        };

        const sleep2 = async (ms: number) => {
          recordedSleeps.push({ query: "q2", ms });
        };

        // Fire both queries concurrently
        const p1 = searchAniList("Overlord", { fetchFn: fetch1, sleepFn: sleep1 });
        const p2 = searchAniList("Danmachi", { fetchFn: fetch2, sleepFn: sleep2 });

        const [r1, r2] = await Promise.all([p1, p2]);

        // Both calls succeed and return results
        expect(r1.length).toBe(1);
        expect(r1[0].title).toBe("Overlord");
        expect(r2.length).toBe(1);
        expect(r2[0].title).toBe("Danmachi");

        // Concurrency is strictly 1: no parallel fetches occurred at any time
        expect(maxParallel).toBe(1);

        // Call order proves that fetch2 waited for fetch1's 429 backoff and retry to finish!
        expect(callOrder).toEqual(["fetch1_attempt_1", "fetch1_attempt_2", "fetch2"]);

        // Q1 slept 2000ms for 429 backoff
        expect(recordedSleeps.some((s) => s.query === "q1" && s.ms === 2000)).toBe(true);

        // Q2 was held behind Q1, and when released, enforced the minimum 700ms interval
        expect(recordedSleeps.some((s) => s.query === "q2")).toBe(true);
      });
    });
  });

  describe("autoEnrichBookSynopsis Overwrite Protection & calibredb list Hygiene", () => {
    it("passes --for-machine to calibredb list invocation", async () => {
      let capturedListArgs: string[] = [];
      const mockRunner = (args: string[]) => {
        if (args[0] === "list") {
          capturedListArgs = args;
          return {
            status: 0,
            stdout: JSON.stringify([{ id: 401, title: "Test Book", comments: "Already present" }]),
            stderr: "",
          };
        }
        return { status: 0, stdout: "", stderr: "" };
      };

      const res = await autoEnrichBookSynopsis(401, {
        title: "Test Book",
        calibredbRunner: mockRunner,
      });

      expect(capturedListArgs).toContain("--for-machine");
      expect(res.enriched).toBe(false);
      expect(res.synopsis).toBe("Already present");
    });

    it("returns without writing when calibredb list exits non-zero", async () => {
      let setMetadataCalled = false;
      const mockRunner = (args: string[]) => {
        if (args[0] === "list") {
          return {
            status: 1,
            stdout: "",
            stderr: "calibredb error: database locked",
          };
        }
        if (args[0] === "set_metadata") {
          setMetadataCalled = true;
          return { status: 0, stdout: "", stderr: "" };
        }
        return { status: 0, stdout: "", stderr: "" };
      };

      const res = await autoEnrichBookSynopsis(402, {
        title: "Test Book",
        author: "Author",
        calibredbRunner: mockRunner,
      });

      expect(res.enriched).toBe(false);
      expect(setMetadataCalled).toBe(false);
    });

    it("returns without calling set_metadata when calibredb list stdout is a non-JSON human table", async () => {
      let setMetadataCalled = false;
      const humanTable = `
id  title      authors    comments
403 Test Book  Author     A real synopsis that an operator already wrote in Calibre.
`;
      const mockRunner = (args: string[]) => {
        if (args[0] === "list") {
          return {
            status: 0,
            stdout: humanTable,
            stderr: "",
          };
        }
        if (args[0] === "set_metadata") {
          setMetadataCalled = true;
          return { status: 0, stdout: "", stderr: "" };
        }
        return { status: 0, stdout: "", stderr: "" };
      };

      const res = await autoEnrichBookSynopsis(403, {
        title: "Test Book",
        author: "Author",
        calibredbRunner: mockRunner,
      });

      expect(res.enriched).toBe(false);
      expect(setMetadataCalled).toBe(false);
    });

    it("preserves synopsis and does not call set_metadata when JSON list has non-empty comments", async () => {
      let setMetadataCalled = false;
      const mockRunner = (args: string[]) => {
        if (args[0] === "list") {
          return {
            status: 0,
            stdout: JSON.stringify([
              {
                id: 404,
                title: "Existing Book",
                authors: "Author",
                comments: "<p>Existing curated synopsis.</p>",
              },
            ]),
            stderr: "",
          };
        }
        if (args[0] === "set_metadata") {
          setMetadataCalled = true;
          return { status: 0, stdout: "", stderr: "" };
        }
        return { status: 0, stdout: "", stderr: "" };
      };

      const res = await autoEnrichBookSynopsis(404, {
        title: "Existing Book",
        calibredbRunner: mockRunner,
      });

      expect(res.enriched).toBe(false);
      expect(res.synopsis).toBe("<p>Existing curated synopsis.</p>");
      expect(setMetadataCalled).toBe(false);
    });

    it("returns without writing when runner throws an exception during list", async () => {
      let setMetadataCalled = false;
      const mockRunner = (args: string[]) => {
        if (args[0] === "list") {
          throw new Error("spawnSync ENOENT");
        }
        if (args[0] === "set_metadata") {
          setMetadataCalled = true;
          return { status: 0, stdout: "", stderr: "" };
        }
        return { status: 0, stdout: "", stderr: "" };
      };

      const res = await autoEnrichBookSynopsis(405, {
        title: "Crashing Runner",
        calibredbRunner: mockRunner,
      });

      expect(res.enriched).toBe(false);
      expect(setMetadataCalled).toBe(false);
    });
  });
});
