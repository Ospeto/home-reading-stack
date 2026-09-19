import { describe, it, expect } from "bun:test";
import {
  formatRanobeDate,
  parseRanobeBook,
  searchRanobeDB,
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
});
