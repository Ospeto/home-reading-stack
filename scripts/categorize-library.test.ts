import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import {
  runCategorizeLibrary,
  formatCategorizeReport,
  type CategorizeLibraryOptions,
  type RawBookRow,
} from "./categorize-library";

describe("LightHouse Library Categorization Engine", () => {
  const origFetch = globalThis.fetch;
  const sampleBooks: RawBookRow[] = [
    {
      id: 1,
      title: "စာဖတ်သူ",
      author: "သူရိန်ဝင်း",
      comments: "<p>မြန်မာဘာသာပြန် စာအုပ်</p>",
      tags: "ဘာသာပြန်, zlib, epub",
      languages: "eng", // Mislabeled as eng!
    },
    {
      id: 2,
      title: "The Great Gatsby",
      author: "F. Scott Fitzgerald",
      comments: "A classic novel set in the Jazz Age.",
      tags: "Classic",
      languages: "eng",
    },
    {
      id: 3,
      title: "Designing Data-Intensive Applications",
      author: "Martin Kleppmann",
      comments: "Reliable, scalable, and maintainable systems.",
      tags: "https://t.me/techbooks, epub",
      languages: "eng",
    },
    {
      id: 4,
      title: "Overlord, Vol. 1",
      author: "Kugane Maruyama",
      comments: "Light novel series",
      tags: "Light Novel, Fan Translated",
      languages: "eng",
    },
    {
      id: 5,
      title: "English Book with Burmese Note",
      author: "John Doe",
      comments: "<p>မှတ်ချက်: မြန်မာစာဖတ်သူများအတွက်</p>",
      tags: "",
      languages: "eng",
    },
  ];

  beforeEach(() => {
    // Hermetic test setup
  });

  afterEach(() => {
    globalThis.fetch = origFetch;
  });

  describe("1. Language Classification & Burmese Correction", () => {
    it("fixes Burmese books mislabeled as 'eng' to 'mya' and adds 'Burmese Literature' tag", async () => {
      const result = await runCategorizeLibrary({
        dryRun: true,
        booksProvider: () => [sampleBooks[0]],
      });

      expect(result.totalBooksScanned).toBe(1);
      expect(result.burmeseBooksCount).toBe(1);
      expect(result.burmeseLanguageFixedCount).toBe(1);

      const item = result.items[0];
      expect(item.newLanguage).toBe("mya");
      expect(item.isBurmese).toBe(true);
      expect(item.needsLanguageUpdate).toBe(true);
      expect(item.newTags).toContain("Burmese Literature");
      expect(item.newTags).toContain("ဘာသာပြန်");
      expect(item.newTags).not.toContain("zlib");
      expect(item.newTags).not.toContain("epub");
    });

    it("identifies Burmese when Myanmar Unicode is in comments", async () => {
      const result = await runCategorizeLibrary({
        dryRun: true,
        booksProvider: () => [sampleBooks[4]],
      });

      const item = result.items[0];
      expect(item.newLanguage).toBe("mya");
      expect(item.isBurmese).toBe(true);
      expect(item.newTags).toContain("Burmese Literature");
    });

    it("confirms pure Latin books as 'eng' without adding 'Burmese Literature'", async () => {
      const result = await runCategorizeLibrary({
        dryRun: true,
        booksProvider: () => [sampleBooks[1]],
      });

      expect(result.englishBooksCount).toBe(1);
      const item = result.items[0];
      expect(item.newLanguage).toBe("eng");
      expect(item.isBurmese).toBe(false);
      expect(item.newTags).not.toContain("Burmese Literature");
      expect(item.needsLanguageUpdate).toBe(false);
    });
  });

  describe("2. Standardized Category Tagging & Junk Stripping", () => {
    it("strips junk tags (zlib, epub, t.me, fan translated)", async () => {
      const result = await runCategorizeLibrary({
        dryRun: true,
        booksProvider: () => [sampleBooks[0], sampleBooks[2], sampleBooks[3]],
      });

      const book1 = result.items[0];
      expect(book1.removedTags).toContain("zlib");
      expect(book1.removedTags).toContain("epub");

      const book3 = result.items[1];
      expect(book3.removedTags).toContain("https://t.me/techbooks");
      expect(book3.removedTags).toContain("epub");

      const book4 = result.items[2];
      expect(book4.removedTags).toContain("Fan Translated");
      expect(book4.newTags).toContain("Light Novel");
    });

    it("assigns standardized category via Jev System-1 mock for books missing categories", async () => {
      globalThis.fetch = async () => {
        return new Response(
          JSON.stringify({
            answers: {
              book_category: {
                choice: "Technology",
                confidence: 0.98,
              },
            },
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      };

      const result = await runCategorizeLibrary({
        dryRun: true,
        booksProvider: () => [sampleBooks[2]],
        jevOptions: { apiKey: "mock-key" },
      });

      const item = result.items[0];
      expect(item.category).toBe("Technology");
      expect(item.newTags).toContain("Technology");
    });

    it("preserves existing standardized category tags without overriding", async () => {
      const result = await runCategorizeLibrary({
        dryRun: true,
        booksProvider: () => [sampleBooks[3]], // Has "Light Novel"
      });

      const item = result.items[0];
      expect(item.newTags).toContain("Light Novel");
      expect(item.category).toBe("Light Novel");
    });
  });

  describe("3. Execution Modes & Lifecycle", () => {
    it("runs in safe preview under default --dry-run without calling metadataSetter", async () => {
      let setterCalled = false;
      const result = await runCategorizeLibrary({
        dryRun: true,
        booksProvider: () => sampleBooks,
        metadataSetter: () => {
          setterCalled = true;
          return { success: true };
        },
      });

      expect(result.dryRun).toBe(true);
      expect(setterCalled).toBe(false);
      expect(result.totalNeedingUpdate).toBeGreaterThan(0);
      expect(result.totalUpdated).toBe(0);
    });

    it("actively executes metadataSetter and flushes cache under --apply", async () => {
      const updatedBooks: Array<{ id: number; lang: string; tags: string[] }> = [];
      let cacheFlushed = false;

      const result = await runCategorizeLibrary({
        dryRun: false,
        booksProvider: () => [sampleBooks[0]],
        metadataSetter: (id, lang, tags) => {
          updatedBooks.push({ id, lang, tags });
          return { success: true };
        },
        cacheFlusher: () => {
          cacheFlushed = true;
        },
      });

      expect(result.dryRun).toBe(false);
      expect(updatedBooks.length).toBe(1);
      expect(updatedBooks[0].id).toBe(1);
      expect(updatedBooks[0].lang).toBe("mya");
      expect(updatedBooks[0].tags).toContain("Burmese Literature");
      expect(cacheFlushed).toBe(true);
      expect(result.totalUpdated).toBe(1);
      expect(result.totalErrors).toBe(0);
    });

    it("respects --limit option to bounded processing", async () => {
      const result = await runCategorizeLibrary({
        dryRun: true,
        limit: 2,
        booksProvider: () => sampleBooks,
      });

      expect(result.totalBooksScanned).toBe(2);
      expect(result.items.length).toBe(2);
    });

    it("records metadataSetter errors without crashing", async () => {
      const result = await runCategorizeLibrary({
        dryRun: false,
        booksProvider: () => [sampleBooks[0]],
        metadataSetter: () => {
          return { success: false, error: "calibredb connection refused" };
        },
        cacheFlusher: () => {},
      });

      expect(result.totalErrors).toBe(1);
      expect(result.errors.length).toBe(1);
      expect(result.errors[0].error).toContain("calibredb connection refused");
    });

    it("formats human-readable report card cleanly", async () => {
      const result = await runCategorizeLibrary({
        dryRun: true,
        booksProvider: () => [sampleBooks[0], sampleBooks[1]],
      });

      const report = formatCategorizeReport(result);
      expect(report).toContain("LightHouse Library Categorization & Language Fix");
      expect(report).toContain("DRY-RUN");
      expect(report).toContain("Burmese Language Fixes (mya)");
      expect(report).toContain("To apply these changes, re-run with --apply");
    });
  });
});
