import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  isDeterministicJunk,
  isSuspiciousTitle,
  evaluateJunkGate,
  extractSeriesDeterministicExtended,
  extractSeriesWithJev,
  isJunkAuthorExtended,
  isSuspiciousAuthor,
  cleanAuthorWithJev,
  detectLanguageDeterministic,
  detectBookLanguage,
  classifyBookSourceCategoryDeterministic,
  triageSourceCategoryWithJev,
  classifyBookSourceCategory,
  getQuarantineDir,
  moveToQuarantine,
  callJevSystemOneChoice,
} from "./jev-shelf";
import { extractSeries } from "./scraper";

describe("Jev System-1 Four Use Cases & Shelf Integration", () => {
  const origFetch = globalThis.fetch;
  let tempTestDir: string;

  beforeEach(() => {
    tempTestDir = fs.mkdtempSync(path.join(os.tmpdir(), "jev-shelf-test-"));
    process.env.BOOKS_QUARANTINE_DIR = path.join(tempTestDir, "quarantine");
  });

  afterEach(() => {
    globalThis.fetch = origFetch;
    delete process.env.BOOKS_QUARANTINE_DIR;
    try {
      fs.rmSync(tempTestDir, { recursive: true, force: true });
    } catch (_err) {
      void _err;
    }
  });

  // ==========================================================================
  // 1. Junk Ingest Gate
  // ==========================================================================
  describe("1. Junk Ingest Gate", () => {
    it("deterministic quarantine matches 'truncated' + long number + short id", () => {
      expect(isDeterministicJunk("truncated_1712345678901_a1b2")).toBe(true);
      expect(isDeterministicJunk("truncated 1712345678901 abcd")).toBe(true);
      expect(isDeterministicJunk("Random Title", "truncated_1712345678901_a1b2.epub")).toBe(true);
    });

    it("deterministic quarantine matches 'Healed Book' + timestamp", () => {
      expect(isDeterministicJunk("Healed Book 1712345678901")).toBe(true);
      expect(isDeterministicJunk("Healed_Book_1712345678")).toBe(true);
      expect(isDeterministicJunk("Valid Title", "Healed Book 1712345678.epub")).toBe(true);
    });

    it("deterministic quarantine matches 'truncated_<digits>_<id>.epub'", () => {
      expect(isDeterministicJunk("truncated_12345678_x9y.epub")).toBe(true);
      expect(isDeterministicJunk("Any Title", "truncated_99999999_abc.epub")).toBe(true);
    });

    it("does not flag legitimate book titles as deterministic junk", () => {
      expect(isDeterministicJunk("Overlord Vol 1")).toBe(false);
      expect(isDeterministicJunk("The Great Gatsby")).toBe(false);
      expect(isDeterministicJunk("1984 by George Orwell")).toBe(false);
    });

    it("quarantines deterministic junk without calling Jev model", async () => {
      let fetchCalled = false;
      globalThis.fetch = async () => {
        fetchCalled = true;
        throw new Error("Jev API should not be called for deterministic junk");
      };

      const result = await evaluateJunkGate(
        "truncated_1712345678901_a1b2",
        "file.epub",
        "Unknown",
        { apiKey: "test-key" },
      );

      expect(result.quarantined).toBe(true);
      expect(result.action).toBe("deterministic_quarantine");
      expect(fetchCalled).toBe(false);
    });

    it("recognizes suspicious titles (mostly digits, test/sample, unknown author + timestamp)", () => {
      expect(isSuspiciousTitle("198402913840", "", "Unknown")).toBe(true);
      expect(isSuspiciousTitle("test artifact", "", "Tester")).toBe(true);
      expect(isSuspiciousTitle("sample upload", "", "Tester")).toBe(true);
      expect(isSuspiciousTitle("Book 1712345678901", "", "Unknown")).toBe(true);
      expect(isSuspiciousTitle("Lord of the Rings", "lotr.epub", "J.R.R. Tolkien")).toBe(false);
    });

    it("calls Jev only when deterministic misses and title looks suspicious, quarantining on test_artifact with conf >= 0.7", async () => {
      globalThis.fetch = async () => {
        return new Response(
          JSON.stringify({
            answers: {
              junk_verdict: {
                choice: "test_artifact",
                confidence: 0.88,
              },
            },
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      };

      const result = await evaluateJunkGate(
        "sample upload 12345",
        "sample_upload.epub",
        "Tester",
        { apiKey: "test-key" },
      );

      expect(result.quarantined).toBe(true);
      expect(result.action).toBe("jev_quarantine");
      expect(result.verdict).toBe("test_artifact");
      expect(result.confidence).toBe(0.88);
    });

    it("passes when Jev classifies suspicious title as real_book", async () => {
      globalThis.fetch = async () => {
        return new Response(
          JSON.stringify({
            answers: {
              junk_verdict: {
                choice: "real_book",
                confidence: 0.92,
              },
            },
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      };

      const result = await evaluateJunkGate(
        "198402913840", // Suspicious numeric title
        "198402913840.epub",
        "George Orwell",
        { apiKey: "test-key" },
      );

      expect(result.quarantined).toBe(false);
      expect(result.action).toBe("pass");
      expect(result.verdict).toBe("real_book");
    });

    it("fails open when Jev confidence is < 0.7 or API fails", async () => {
      globalThis.fetch = async () => {
        return new Response(
          JSON.stringify({
            answers: {
              junk_verdict: {
                choice: "test_artifact",
                confidence: 0.55, // Low confidence
              },
            },
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      };

      const result = await evaluateJunkGate(
        "sample test book",
        "sample.epub",
        "Unknown",
        { apiKey: "test-key" },
      );

      expect(result.quarantined).toBe(false);
      expect(result.action).toBe("pass");
    });

    it("moves quarantined files safely to quarantine directory", () => {
      const dummyFile = path.join(tempTestDir, "test.epub");
      fs.writeFileSync(dummyFile, "dummy epub bytes");

      const qPath = moveToQuarantine(dummyFile, "quarantined_book.epub");
      expect(fs.existsSync(qPath)).toBe(true);
      expect(qPath).toContain("quarantine");
      expect(fs.readFileSync(qPath, "utf8")).toBe("dummy epub bytes");
    });

    it("moveToQuarantine strictly prevents directory traversal attacks (../, absolute, dots)", () => {
      const qDir = path.resolve(getQuarantineDir());

      // 1. Path traversal with parent directory
      const dummy1 = path.join(tempTestDir, "t1.epub");
      fs.writeFileSync(dummy1, "data1");
      const p1 = moveToQuarantine(dummy1, "../../../etc/passwd");
      expect(p1.startsWith(qDir + path.sep)).toBe(true);
      expect(path.basename(p1)).not.toContain("/");

      // 2. Traversal with relative prefix
      const dummy2 = path.join(tempTestDir, "t2.epub");
      fs.writeFileSync(dummy2, "data2");
      const p2 = moveToQuarantine(dummy2, "../escape.epub");
      expect(p2.startsWith(qDir + path.sep)).toBe(true);
      expect(path.basename(p2)).toBe("escape.epub");

      // 3. Dot and double-dot names
      const dummy3 = path.join(tempTestDir, "t3.epub");
      fs.writeFileSync(dummy3, "data3");
      const p3 = moveToQuarantine(dummy3, "..");
      expect(p3.startsWith(qDir + path.sep)).toBe(true);
      expect(path.basename(p3)).toBe("quarantined_file.epub");

      const dummy4 = path.join(tempTestDir, "t4.epub");
      fs.writeFileSync(dummy4, "data4");
      const p4 = moveToQuarantine(dummy4, ".");
      expect(p4.startsWith(qDir + path.sep)).toBe(true);
      expect(path.basename(p4)).toBe("quarantined_file.epub");
    });
  });

  // ==========================================================================
  // 2. Series & Volume Detection
  // ==========================================================================
  describe("2. Series & Volume Detection", () => {
    it("existing extractSeries wins without calling Jev or extended logic", async () => {
      let fetchCalled = false;
      globalThis.fetch = async () => {
        fetchCalled = true;
        throw new Error("Jev should not be called when extractSeries succeeds");
      };

      const res = await extractSeriesWithJev(
        "Overlord, Vol. 04",
        "",
        extractSeries,
        { apiKey: "test-key" },
      );

      expect(res).toEqual({ series: "Overlord", volume: 4 });
      expect(fetchCalled).toBe(false);
    });

    it("deterministic roman numerals and written numbers resolve correctly", () => {
      expect(extractSeriesDeterministicExtended("Final Fantasy VII")).toEqual({
        series: "Final Fantasy",
        volume: 7,
      });
      expect(extractSeriesDeterministicExtended("Dune, Part Three")).toEqual({
        series: "Dune",
        volume: 3,
      });
      expect(extractSeriesDeterministicExtended("Foundation, Book Two")).toEqual({
        series: "Foundation",
        volume: 2,
      });
      expect(extractSeriesDeterministicExtended("The Witcher Vol IV")).toEqual({
        series: "The Witcher",
        volume: 4,
      });
    });

    it("calls Jev only when regex missed and a number-like token remains", async () => {
      globalThis.fetch = async () => {
        return new Response(
          JSON.stringify({
            answers: {
              series_verdict: {
                choice: "series_volume",
                confidence: 0.85,
              },
            },
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      };

      // Title has no "Vol" or "Book" prefix, just "Sword Art Online 14"
      const res = await extractSeriesWithJev(
        "Sword Art Online 14",
        "",
        extractSeries,
        { apiKey: "test-key" },
      );

      expect(res).toEqual({ series: "Sword Art Online", volume: 14 });
    });

    it("leaves series empty when Jev classifies number as subtitle_same_book or unrelated", async () => {
      globalThis.fetch = async () => {
        return new Response(
          JSON.stringify({
            answers: {
              series_verdict: {
                choice: "subtitle_same_book",
                confidence: 0.9,
              },
            },
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      };

      const res = await extractSeriesWithJev(
        "JavaScript The Definitive Guide 7",
        "",
        extractSeries,
        { apiKey: "test-key" },
      );

      expect(res).toBeNull();
    });

    it("never calls Jev on pure standalone titles without numbers", async () => {
      let fetchCalled = false;
      globalThis.fetch = async () => {
        fetchCalled = true;
        return new Response("{}", { status: 200 });
      };

      const res = await extractSeriesWithJev(
        "Pride and Prejudice",
        "",
        extractSeries,
        { apiKey: "test-key" },
      );

      expect(res).toBeNull();
      expect(fetchCalled).toBe(false);
    });
  });

  // ==========================================================================
  // 3. Author Cleanup
  // ==========================================================================
  describe("3. Author Cleanup", () => {
    it("isJunkAuthorExtended catches obvious junk tokens", () => {
      expect(isJunkAuthorExtended("epub")).toBe(true);
      expect(isJunkAuthorExtended("PDF")).toBe(true);
      expect(isJunkAuthorExtended("various")).toBe(true);
      expect(isJunkAuthorExtended("Various Authors")).toBe(true);
      expect(isJunkAuthorExtended("N/A")).toBe(true);
      expect(isJunkAuthorExtended("unknown")).toBe(true);
      expect(isJunkAuthorExtended("admin")).toBe(true);
      expect(isJunkAuthorExtended("oceanofpdf.com")).toBe(true);
    });

    it("recognizes suspicious authors (sole translator, site token, uncredited role)", () => {
      expect(isSuspiciousAuthor("Translated by John Doe")).toBe(true);
      expect(isSuspiciousAuthor("Translator: Jane Smith")).toBe(true);
      expect(isSuspiciousAuthor("Edited by")).toBe(true);
      expect(isSuspiciousAuthor("novelupdates")).toBe(true);
      expect(isSuspiciousAuthor("Stephen King")).toBe(false);
      expect(isSuspiciousAuthor("Brandon Sanderson")).toBe(false);
    });

    it("ordinary author names are kept without calling Jev", async () => {
      let fetchCalled = false;
      globalThis.fetch = async () => {
        fetchCalled = true;
        throw new Error("Jev should not be called for ordinary authors");
      };

      const cleaned = await cleanAuthorWithJev(
        "George R.R. Martin",
        "A Game of Thrones",
        { apiKey: "test-key" },
      );

      expect(cleaned).toBe("George R.R. Martin");
      expect(fetchCalled).toBe(false);
    });

    it("calls Jev for suspicious author and stores Unknown on mark_unknown", async () => {
      globalThis.fetch = async () => {
        return new Response(
          JSON.stringify({
            answers: {
              author_verdict: {
                choice: "mark_unknown",
                confidence: 0.9,
              },
            },
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      };

      const cleaned = await cleanAuthorWithJev(
        "Edited by",
        "Anthology of Stories",
        { apiKey: "test-key" },
      );

      expect(cleaned).toBe("Unknown");
    });

    it("keeps author when Jev verdict is keep", async () => {
      globalThis.fetch = async () => {
        return new Response(
          JSON.stringify({
            answers: {
              author_verdict: {
                choice: "keep",
                confidence: 0.85,
              },
            },
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      };

      const cleaned = await cleanAuthorWithJev(
        "novelupdates-staff-writer",
        "Some Article",
        { apiKey: "test-key" },
      );

      expect(cleaned).toBe("novelupdates-staff-writer");
    });

    it("never invents an author name", async () => {
      globalThis.fetch = async () => {
        return new Response(
          JSON.stringify({
            answers: {
              author_verdict: {
                choice: "mark_unknown",
                confidence: 0.95,
              },
            },
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      };

      const cleaned = await cleanAuthorWithJev(
        "Translated by Anonymous",
        "Mystery Book",
        { apiKey: "test-key" },
      );

      expect(cleaned).toBe("Unknown");
    });
  });

  // ==========================================================================
  // 4. Language Shelf Detection
  // ==========================================================================
  describe("4. Language Shelf Detection", () => {
    it("detects Burmese ('my') deterministically when Myanmar Unicode is present", () => {
      expect(detectLanguageDeterministic("လေပြည်ကလေး၏တေးဆိုသံ")).toBe("my");
      expect(detectLanguageDeterministic("စာဖတ်သူ")).toBe("my");
      expect(detectLanguageDeterministic("အတွဲ ၁ အခန်း ၂")).toBe("my");
    });

    it("detects English ('en') deterministically for pure Latin characters with no Myanmar", () => {
      expect(detectLanguageDeterministic("The Great Gatsby")).toBe("en");
      expect(detectLanguageDeterministic("Overlord Vol 1")).toBe("en");
      expect(detectLanguageDeterministic("Clean Code: A Handbook")).toBe("en");
    });

    it("returns null for ambiguous, mixed, or other scripts", () => {
      expect(detectLanguageDeterministic("Burmese Book မြန်မာစာ")).toBeNull(); // Mixed Latin + Myanmar
      expect(detectLanguageDeterministic("無職転生")).toBeNull(); // Japanese Kanji/Kana
      expect(detectLanguageDeterministic("12345678")).toBeNull(); // Pure digits
    });

    it("calls Jev for mixed/ambiguous text and classifies correctly", async () => {
      globalThis.fetch = async () => {
        return new Response(
          JSON.stringify({
            answers: {
              language_verdict: {
                choice: "my",
                confidence: 0.94,
              },
            },
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      };

      const lang = await detectBookLanguage("Burmese Novel မြန်မာဝတ္ထု", "burmese.epub", {
        apiKey: "test-key",
      });
      expect(lang).toBe("my");
    });

    it("classifies other languages via Jev", async () => {
      globalThis.fetch = async () => {
        return new Response(
          JSON.stringify({
            answers: {
              language_verdict: {
                choice: "other",
                confidence: 0.92,
              },
            },
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      };

      const lang = await detectBookLanguage("無職転生 ~異世界行ったら本気だす~", "mushoku.epub", {
        apiKey: "test-key",
      });
      expect(lang).toBe("other");
    });

    it("fails open (returns null) on mixed text if Jev fails or confidence < 0.7", async () => {
      globalThis.fetch = async () => {
        throw new Error("Network offline");
      };

      const lang = await detectBookLanguage("Mystery Novel မြန်မာ", "novel.epub", {
        apiKey: "test-key",
      });
      // Mixed text fails open when Jev fails
      expect(lang).toBeNull();
    });
  });

  // ==========================================================================
  // 5. Technical Constraints & Security
  // ==========================================================================
  describe("5. Technical Constraints & Security", () => {
    it("fails open when API key is missing (returns null / safe defaults)", async () => {
      delete process.env.JEV_API_KEY;
      delete process.env.TYPESAFE_API_KEY;

      const choice = await callJevSystemOneChoice(
        "test state",
        "q",
        "instructions",
        { a: "A", b: "B" },
      );
      expect(choice).toBeNull();
    });

    it("does not send file bytes to Jev (only metadata strings)", async () => {
      let requestBody: any = null;
      globalThis.fetch = async (_url: any, init: any) => {
        requestBody = JSON.parse(init.body);
        return new Response(
          JSON.stringify({
            answers: {
              junk_verdict: { choice: "real_book", confidence: 0.9 },
            },
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      };

      await evaluateJunkGate("Sample Title 12345", "sample_artifact.epub", "Author Name", {
        apiKey: "test-key",
      });

      expect(requestBody).not.toBeNull();
      expect(requestBody.state).toContain("Sample Title 12345");
      expect(requestBody.state).toContain("sample_artifact.epub");
      expect(requestBody.state).toContain("Author Name");
      expect(requestBody.state).not.toContain("Buffer");
      expect(requestBody.state).not.toContain("Uint8Array");
    });
  });

  // ==========================================================================
  // 6. Source Category Classification & Smart Routing
  // ==========================================================================
  describe("6. Source Category Classification & Smart Routing", () => {
    it("deterministic classification routes .cbz and .cbr to 'manga'", () => {
      expect(classifyBookSourceCategoryDeterministic("One Piece", "Oda", "vol01.cbz")).toBe("manga");
      expect(classifyBookSourceCategoryDeterministic("Berserk", "Miura", "berserk_ch1.cbr")).toBe("manga");
      expect(classifyBookSourceCategoryDeterministic("Attack on Titan", "Isayama", "AOT.CBZ")).toBe("manga");
    });

    it("deterministic classification routes explicit LN tags and tokens to 'light_novel'", () => {
      expect(classifyBookSourceCategoryDeterministic("Sword Art Online [LN]", "Reki Kawahara")).toBe("light_novel");
      expect(classifyBookSourceCategoryDeterministic("Overlord [Light Novel]", "Maruyama")).toBe("light_novel");
      expect(classifyBookSourceCategoryDeterministic("Solo Leveling [WN]", "Chugong")).toBe("light_novel");
      expect(classifyBookSourceCategoryDeterministic("Mushoku Tensei [Web Novel]", "Rifujin")).toBe("light_novel");
      expect(
        classifyBookSourceCategoryDeterministic("Title Without Marker", "Author", "book.epub", ["Light Novel"]),
      ).toBe("light_novel");
      expect(
        classifyBookSourceCategoryDeterministic("Title", "Author", "book.epub", ["LN"]),
      ).toBe("light_novel");
    });

    it("deterministic classification routes explicit Manga tags and tokens to 'manga'", () => {
      expect(classifyBookSourceCategoryDeterministic("Naruto [Manga]", "Kishimoto")).toBe("manga");
      expect(classifyBookSourceCategoryDeterministic("Spider-Man [Comic]", "Stan Lee")).toBe("manga");
      expect(
        classifyBookSourceCategoryDeterministic("Unknown Comic", "Author", "file.epub", ["Manga"]),
      ).toBe("manga");
      expect(
        classifyBookSourceCategoryDeterministic("Batman", "Author", "file.epub", ["Comic"]),
      ).toBe("manga");
    });

    it("deterministic classification routes Burmese Unicode to 'burmese' when no English/Japanese indicators", () => {
      // Pure Burmese characters
      expect(classifyBookSourceCategoryDeterministic("သခင်ကိုယ်တော်မှိုင်း", "စာရေးဆရာ", "book.epub")).toBe("burmese");
      // Burmese with numbers / punctuation
      expect(classifyBookSourceCategoryDeterministic("မြန်မာ့သမိုင်း အတွဲ ၁", "ဒေါက်တာသန်းထွန်း", "history.epub")).toBe("burmese");
      // Burmese with English letters is inconclusive -> null (requires Jev or general fallback)
      expect(classifyBookSourceCategoryDeterministic("Burmese Novel မြန်မာဝတ္ထု", "Author", "burmese.epub")).toBeNull();
    });

    it("deterministic classification returns null for inconclusive general queries", () => {
      expect(classifyBookSourceCategoryDeterministic("The Great Gatsby", "F. Scott Fitzgerald", "gatsby.epub")).toBeNull();
      expect(classifyBookSourceCategoryDeterministic("Clean Code", "Robert C. Martin", "cleancode.epub")).toBeNull();
      expect(classifyBookSourceCategoryDeterministic("Sapiens", "Yuval Noah Harari", "sapiens.epub")).toBeNull();
    });

    it("bypasses Jev when deterministic classification matches", async () => {
      let fetchCalled = false;
      globalThis.fetch = async () => {
        fetchCalled = true;
        throw new Error("Jev should not be called for deterministic classification");
      };

      const category = await classifyBookSourceCategory("Overlord [LN]", "Maruyama", "overlord.epub", [], {
        apiKey: "test-key",
      });
      expect(category).toBe("light_novel");
      expect(fetchCalled).toBe(false);
    });

    it("calls Jev when deterministic classification is inconclusive and classifies correctly with conf >= 0.7", async () => {
      globalThis.fetch = async () => {
        return new Response(
          JSON.stringify({
            answers: {
              source_category_verdict: {
                choice: "light_novel",
                confidence: 0.95,
              },
            },
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      };

      const category = await classifyBookSourceCategory("Re:Zero", "Tappei Nagatsuki", "rezero.epub", [], {
        apiKey: "test-key",
      });
      expect(category).toBe("light_novel");
    });

    it("fails open to 'general_book' when Jev returns confidence < 0.7", async () => {
      globalThis.fetch = async () => {
        return new Response(
          JSON.stringify({
            answers: {
              source_category_verdict: {
                choice: "light_novel",
                confidence: 0.55,
              },
            },
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      };

      const category = await classifyBookSourceCategory("Ambiguous Title", "Unknown", "book.epub", [], {
        apiKey: "test-key",
      });
      expect(category).toBe("general_book");
    });

    it("deterministic classification does not false-positive on unbracketed common words", () => {
      // "LN Tolstoy", "A Comic Novel", "Kadokawa Bunko Classics" should be inconclusive (null), not LN or Manga
      expect(classifyBookSourceCategoryDeterministic("LN Tolstoy: War and Peace", "Leo Tolstoy")).toBeNull();
      expect(classifyBookSourceCategoryDeterministic("A Comic Novel", "Author")).toBeNull();
      expect(classifyBookSourceCategoryDeterministic("Kadokawa Bunko Classics", "Author")).toBeNull();
    });

    it("fails open to 'general_book' when Jev API key is missing or network fails", async () => {
      const origKey = process.env.JEV_API_KEY;
      const origTypesafeKey = process.env.TYPESAFE_API_KEY;
      try {
        delete process.env.JEV_API_KEY;
        delete process.env.TYPESAFE_API_KEY;

        const categoryNoKey = await classifyBookSourceCategory("The Great Gatsby", "Fitzgerald", "gatsby.epub");
        expect(categoryNoKey).toBe("general_book");

        globalThis.fetch = async () => {
          throw new Error("Network down");
        };

        const categoryNetError = await classifyBookSourceCategory(
          "Some Book",
          "Author",
          "book.epub",
          [],
          { apiKey: "valid-key" },
        );
        expect(categoryNetError).toBe("general_book");
      } finally {
        if (origKey !== undefined) process.env.JEV_API_KEY = origKey;
        if (origTypesafeKey !== undefined) process.env.TYPESAFE_API_KEY = origTypesafeKey;
      }
    });
  });
});
