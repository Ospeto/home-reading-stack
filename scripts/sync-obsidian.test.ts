import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { spawnSync } from "node:child_process";
import {
  parseLuaTable,
  extractHighlightsFromLua,
  extractKindleClippings,
  formatSynopsis,
  renderProgressBar,
  normalizeProgress,
  sanitizeTitle,
  generateBookMarkdown,
  mergeNoteContent,
  syncObsidian,
  resolveVaultPath,
  DEFAULT_VAULT_PATH,
  HIGHLIGHTS_START_MARKER,
  HIGHLIGHTS_END_MARKER,
  type BookSyncData,
} from "./sync-obsidian";

const REPO_ROOT = path.resolve(import.meta.dir, "..");
const LIGHTHOUSE_BIN = path.join(REPO_ROOT, "bin", "lighthouse");

describe("LightHouse Obsidian Highlight & Note Sync Engine", () => {
  let tempDir: string;
  let mockVault: string;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "lh-obsidian-test-"));
    mockVault = path.join(tempDir, "ObsidianVault");
    fs.mkdirSync(mockVault, { recursive: true });
  });

  afterEach(() => {
    if (fs.existsSync(tempDir)) {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  describe("1. Lua .sdr Highlight Extraction", () => {
    it("parses primitive Lua types and nested tables accurately", () => {
      const lua = `
        return {
          ["num"] = 42,
          ["neg"] = -15.5,
          ["str"] = "Hello \\"world\\"\\nNew line",
          ["bool_true"] = true,
          ["bool_false"] = false,
          ["nil_val"] = nil,
          ["nested"] = {
            [1] = "first",
            [2] = "second",
          }
        }
      `;
      const parsed = parseLuaTable(lua) as any;
      expect(parsed.num).toBe(42);
      expect(parsed.neg).toBe(-15.5);
      expect(parsed.str).toBe('Hello "world"\nNew line');
      expect(parsed.bool_true).toBe(true);
      expect(parsed.bool_false).toBe(false);
      expect(parsed.nil_val).toBeNull();
      expect(Array.isArray(parsed.nested)).toBe(true);
      expect(parsed.nested[0]).toBe("first");
      expect(parsed.nested[1]).toBe("second");
    });

    it("extracts annotations, chapters, page numbers, notes, and progress from real KOReader lua structure", () => {
      const luaContent = `
        return {
          ["annotations"] = {
            [1] = {
              ["chapter"] = "Chapter 10: Underlying Motives",
              ["color"] = "gray",
              ["datetime"] = "2025-01-30 16:52:58",
              ["page"] = "/body/DocFragment[19]/body/div[1]/p[27]/text()[1].0",
              ["pageno"] = 189,
              ["text"] = "Desire is the difference between where you are now and where you want to be in the future.",
              ["notes"] = "Crucial insight on habit formation.",
            },
            [2] = {
              ["chapter"] = "Chapter 11: Action vs Motion",
              ["datetime"] = "2025-09-11 14:19:18",
              ["pageno"] = 201,
              ["text"] = "When you’re in motion, you’re planning and strategizing. Action delivers an outcome.",
            },
          },
          ["percent_finished"] = 0.653,
          ["doc_props"] = {
            ["title"] = "Atomic Habits",
            ["authors"] = "James Clear",
            ["description"] = "<div><p>A proven system to master habits.</p></div>",
          },
        }
      `;

      const result = extractHighlightsFromLua(luaContent);
      expect(result.title).toBe("Atomic Habits");
      expect(result.author).toBe("James Clear");
      expect(result.percentFinished).toBe(0.653);
      expect(result.highlights.length).toBe(2);

      const h1 = result.highlights[0];
      expect(h1.text).toBe(
        "Desire is the difference between where you are now and where you want to be in the future.",
      );
      expect(h1.notes).toBe("Crucial insight on habit formation.");
      expect(h1.chapter).toBe("Chapter 10: Underlying Motives");
      expect(h1.page).toBe(189);
      expect(h1.datetime).toBe("2025-01-30 16:52:58");

      const h2 = result.highlights[1];
      expect(h2.text).toContain("planning and strategizing");
      expect(h2.notes).toBeUndefined();
      expect(h2.page).toBe(201);
    });

    it("extracts highlights from legacy bookmarks structure", () => {
      const legacyLua = `
        return {
          ["title"] = "Legacy Reader Book",
          ["author"] = "Classic Author",
          ["bookmarks"] = {
            [1] = {
              ["text"] = "Classic quote from older KOReader build",
              ["notes"] = "User bookmark note",
              ["page"] = 45,
              ["datetime"] = "2024-05-12 10:00:00",
            }
          }
        }
      `;
      const result = extractHighlightsFromLua(legacyLua);
      expect(result.title).toBe("Legacy Reader Book");
      expect(result.author).toBe("Classic Author");
      expect(result.highlights.length).toBe(1);
      expect(result.highlights[0].text).toBe("Classic quote from older KOReader build");
      expect(result.highlights[0].notes).toBe("User bookmark note");
      expect(result.highlights[0].page).toBe(45);
    });

    it("extracts Kindle My Clippings.txt format cleanly", () => {
      const clippings = `
Atomic Habits (James Clear)
- Your Highlight on page 189 | Location 1200-1205 | Added on Thursday, January 30, 2025 4:52:58 PM

Desire is the difference between where you are now and where you want to be.
==========
Atomic Habits (James Clear)
- Your Note on page 189 | Location 1206 | Added on Thursday, January 30, 2025 4:55:10 PM

My personal reflection on habits.
==========
`;
      const parsed = extractKindleClippings(clippings);
      const keys = Array.from(parsed.keys());
      expect(keys.length).toBe(1);

      const book = parsed.get(keys[0])!;
      expect(book.title).toBe("Atomic Habits");
      expect(book.author).toBe("James Clear");
      expect(book.highlights.length).toBe(1);
      expect(book.highlights[0].text).toBe(
        "Desire is the difference between where you are now and where you want to be.",
      );
      expect(book.highlights[0].notes).toBe("My personal reflection on habits.");
      expect(book.highlights[0].page).toBe(189);
    });
  });

  describe("2. Formatting & Text Utilities", () => {
    it("formatSynopsis cleans HTML tags, unescapes entities, and collapses newlines", () => {
      const htmlComments = `
        <div>
          <p><strong>*Instant Bestseller*</strong></p>
          <p>Over 10 million copies sold &amp; praised by critics.</p>
          <p>Learn how to:<br>• Make time for new habits<br>• Overcome lack of motivation</p>
        </div>
      `;
      const clean = formatSynopsis(htmlComments);
      expect(clean).not.toContain("<div>");
      expect(clean).not.toContain("<p>");
      expect(clean).not.toContain("<strong>");
      expect(clean).toContain("*Instant Bestseller*");
      expect(clean).toContain("sold & praised by critics.");
      expect(clean).toContain("Make time for new habits");
    });

    it("formatSynopsis returns placeholder for missing or empty comments", () => {
      expect(formatSynopsis(null)).toBe("*No synopsis available.*");
      expect(formatSynopsis("")).toBe("*No synopsis available.*");
      expect(formatSynopsis("   ")).toBe("*No synopsis available.*");
    });

    it("renderProgressBar renders accurate 8-block bar for various percentages", () => {
      expect(renderProgressBar(0)).toBe("░░░░░░░░");
      expect(renderProgressBar(25)).toBe("██░░░░░░");
      expect(renderProgressBar(50)).toBe("████░░░░");
      expect(renderProgressBar(0.75)).toBe("██████░░");
      expect(renderProgressBar(100)).toBe("████████");
    });

    it("normalizeProgress normalizes decimals, percentages, and clamped boundaries", () => {
      expect(normalizeProgress(0.653)).toBe(65);
      expect(normalizeProgress(1.0)).toBe(100);
      expect(normalizeProgress(0)).toBe(0);
      expect(normalizeProgress(75)).toBe(75);
      expect(normalizeProgress(150)).toBe(100);
      expect(normalizeProgress(-10)).toBe(0);
      expect(normalizeProgress(null)).toBe(0);
      expect(normalizeProgress(undefined)).toBe(0);
    });

    it("sanitizeTitle cleans illegal characters and reserved symbols", () => {
      expect(
        sanitizeTitle("Atomic Habits: An Easy & Proven Way to Build Good Habits"),
      ).toBe("Atomic Habits - An Easy & Proven Way to Build Good Habits");
      expect(sanitizeTitle("Book / Title with \\ Slashes & <Tags>?*|")).toBe(
        "Book Title with Slashes & Tags",
      );
      expect(sanitizeTitle("")).toBe("Untitled");
    });
  });

  describe("3. Markdown Note Generation & Frontmatter", () => {
    it("generates structured Markdown with YAML frontmatter, progress, synopsis, and markers", () => {
      const bookData: BookSyncData = {
        title: "Deep Work: Rules for Focused Success",
        author: "Cal Newport",
        series: "Productivity",
        seriesIndex: 1,
        synopsis: "<p>Deep work is the ability to focus without distraction on a cognitively demanding task.</p>",
        progress: 45,
        status: "reading",
        lastReadDate: "2026-09-22 21:30",
        highlights: [
          {
            text: "To produce at your peak level you need to work for extended periods with full concentration.",
            chapter: "Chapter 1: Deep Work is Valuable",
            page: 28,
            datetime: "2025-02-15 14:00:00",
            notes: "Crucial productivity law.",
          },
        ],
      };

      const md = generateBookMarkdown(bookData);

      // Verify Frontmatter
      expect(md).toContain("---");
      expect(md).toContain('title: "Deep Work: Rules for Focused Success"');
      expect(md).toContain('author: "Cal Newport"');
      expect(md).toContain('series: "Productivity #1"');
      expect(md).toContain("progress: 45");
      expect(md).toContain("status: reading");
      expect(md).toContain("- book-notes");
      expect(md).toContain("- lighthouse");
      expect(md).toContain("- reading");
      expect(md).toContain("date_synced:");

      // Verify Header & Synopsis
      expect(md).toContain("# Deep Work: Rules for Focused Success");
      expect(md).toContain("Deep work is the ability to focus without distraction");

      // Verify Reading Progress
      expect(md).toContain("**Progress:** 45% [████░░░░]");
      expect(md).toContain("**Last Read:** 2026-09-22 21:30");

      // Verify Highlights Section bounded by markers
      expect(md).toContain(HIGHLIGHTS_START_MARKER);
      expect(md).toContain(HIGHLIGHTS_END_MARKER);
      expect(md).toContain(
        "> To produce at your peak level you need to work for extended periods with full concentration.",
      );
      expect(md).toContain("— *Chapter 1: Deep Work is Valuable*, Page 28, 2025-02-15 14:00:00");
      expect(md).toContain("**Note:** Crucial productivity law.");
    });
  });

  describe("4. Idempotent Section Marker Preservation", () => {
    it("preserves user edits and manual notes outside markers on repeated syncs", () => {
      const initialBook: BookSyncData = {
        title: "Thinking, Fast and Slow",
        author: "Daniel Kahneman",
        progress: 20,
        status: "reading",
        highlights: [
          {
            text: "Initial highlight captured on day 1.",
            page: 15,
          },
        ],
      };

      // Generate initial note
      const initialMd = generateBookMarkdown(initialBook);

      // User adds custom thoughts before and after the highlights section
      const userEditedMd = initialMd
        .replace(
          "# Thinking, Fast and Slow",
          "# Thinking, Fast and Slow\n\n> *My personal goal: Read one chapter every morning before breakfast.*",
        )
        .concat(
          "\n## 🧠 Personal Reflections & Takeaways\n- System 1 operates automatically and quickly.\n- System 2 allocates attention to effortful mental operations.\n",
        );

      expect(userEditedMd).toContain("My personal goal: Read one chapter every morning");
      expect(userEditedMd).toContain("Personal Reflections & Takeaways");

      // Later, reader captures a new highlight and progresses to 50%
      const updatedBook: BookSyncData = {
        title: "Thinking, Fast and Slow",
        author: "Daniel Kahneman",
        progress: 50,
        status: "reading",
        highlights: [
          {
            text: "Initial highlight captured on day 1.",
            page: 15,
          },
          {
            text: "A reliable way to make people believe in falsehoods is frequent repetition.",
            chapter: "Chapter 5: Cognitive Ease",
            page: 62,
            notes: "Illusory truth effect.",
          },
        ],
      };

      const mergedMd = mergeNoteContent(userEditedMd, updatedBook);

      // 1. User manual notes MUST be completely preserved
      expect(mergedMd).toContain(
        "> *My personal goal: Read one chapter every morning before breakfast.*",
      );
      expect(mergedMd).toContain("## 🧠 Personal Reflections & Takeaways");
      expect(mergedMd).toContain("System 1 operates automatically and quickly.");
      expect(mergedMd).toContain("System 2 allocates attention to effortful mental operations.");

      // 2. Highlights block must be updated with new highlight
      expect(mergedMd).toContain("A reliable way to make people believe in falsehoods");
      expect(mergedMd).toContain("Illusory truth effect.");

      // 3. Frontmatter progress and body progress bar must be updated
      expect(mergedMd).toContain("progress: 50");
      expect(mergedMd).toContain("**Progress:** 50% [████░░░░]");

      // 4. Markers must remain intact and well-formed
      expect(mergedMd.indexOf(HIGHLIGHTS_START_MARKER)).not.toBe(-1);
      expect(mergedMd.indexOf(HIGHLIGHTS_END_MARKER)).not.toBe(-1);
      expect(
        mergedMd.indexOf(HIGHLIGHTS_END_MARKER),
      ).toBeGreaterThan(mergedMd.indexOf(HIGHLIGHTS_START_MARKER));
    });

    it("preserves existing highlights on progress-only sync when incoming highlights are empty", () => {
      const initialBook: BookSyncData = {
        title: "Clean Architecture",
        author: "Robert C. Martin",
        progress: 10,
        status: "reading",
        highlights: [
          {
            text: "The only way to go fast is to go well.",
            page: 4,
          },
        ],
      };

      const initialMd = generateBookMarkdown(initialBook);

      // Reader triggers progress-only sync (e.g. from Web UI bookId sync without local SDR)
      const progressOnlyBook: BookSyncData = {
        title: "Clean Architecture",
        author: "Robert C. Martin",
        progress: 85,
        status: "reading",
        highlights: [], // No new highlights
        lastReadDate: "2026-09-23 12:00",
      };

      const mergedMd = mergeNoteContent(initialMd, progressOnlyBook);

      // Existing highlight MUST be preserved
      expect(mergedMd).toContain("The only way to go fast is to go well.");
      expect(mergedMd).not.toContain("*No highlights recorded yet.*");

      // Progress bar and frontmatter must be updated
      expect(mergedMd).toContain("progress: 85");
      expect(mergedMd).toContain("**Progress:** 85% [███████░]");
      expect(mergedMd).toContain("**Last Read:** 2026-09-23 12:00");
    });
  });

  describe("5. End-to-End Vault Synchronization Engine", () => {
    it("syncObsidian writes notes to <vault>/Books/<Sanitized_Title>.md in apply mode", async () => {
      const book: BookSyncData = {
        title: "Clean Code",
        author: "Robert C. Martin",
        progress: 80,
        highlights: [
          {
            text: "Any fool can write code that a computer can understand. Good programmers write code that humans can understand.",
            page: 14,
          },
        ],
      };

      const result = await syncObsidian({
        vaultPath: mockVault,
        apply: true,
        dryRun: false,
        books: [book],
      });

      expect(result.notesCreated).toBe(1);
      expect(result.notesUpdated).toBe(0);

      const targetPath = path.join(mockVault, "Books", "Clean Code.md");
      expect(fs.existsSync(targetPath)).toBe(true);

      const content = fs.readFileSync(targetPath, "utf8");
      expect(content).toContain('title: "Clean Code"');
      expect(content).toContain("Good programmers write code that humans can understand.");

      // Run sync again: should update, not re-create
      const secondResult = await syncObsidian({
        vaultPath: mockVault,
        apply: true,
        dryRun: false,
        books: [book],
      });

      expect(secondResult.notesCreated).toBe(0);
      expect(secondResult.notesUpdated).toBe(1);
    });

    it("syncObsidian respects --dry-run and does not write files", async () => {
      const book: BookSyncData = {
        title: "Refactoring",
        author: "Martin Fowler",
        progress: 30,
        highlights: [{ text: "When you feel the need to write a comment, first try to refactor the code." }],
      };

      const result = await syncObsidian({
        vaultPath: mockVault,
        apply: false,
        dryRun: true,
        books: [book],
      });

      expect(result.dryRun).toBe(true);
      expect(result.notesCreated).toBe(1);

      const targetPath = path.join(mockVault, "Books", "Refactoring.md");
      expect(fs.existsSync(targetPath)).toBe(false);
    });

    it("syncObsidian unions and deduplicates highlights from multiple discovery sources for same book", async () => {
      const source1: BookSyncData = {
        title: "Pragmatic Programmer",
        author: "Andy Hunt",
        progress: 40,
        highlights: [
          { text: "Care about your craft.", page: 12 },
          { text: "Provide options, don't make lame excuses.", page: 18 },
        ],
      };

      const source2: BookSyncData = {
        title: "Pragmatic Programmer",
        author: "Andy Hunt",
        progress: 65,
        highlights: [
          { text: "Care about your craft.", page: 12 }, // duplicate
          { text: "Don't live with broken windows.", page: 24 }, // new
        ],
      };

      const result = await syncObsidian({
        vaultPath: mockVault,
        apply: true,
        dryRun: false,
        books: [source1, source2],
      });

      expect(result.totalBooksScanned).toBe(1); // merged into 1 book
      expect(result.totalHighlightsFound).toBe(3); // 2 + 1 distinct

      const targetPath = path.join(mockVault, "Books", "Pragmatic Programmer.md");
      expect(fs.existsSync(targetPath)).toBe(true);
      const content = fs.readFileSync(targetPath, "utf8");
      expect(content).toContain("Care about your craft.");
      expect(content).toContain("Provide options, don't make lame excuses.");
      expect(content).toContain("Don't live with broken windows.");
      expect(content).toContain("progress: 65");
      expect(content).toContain("**Progress:** 65% [█████░░░]");
    });

    it("resolveVaultPath respects precedence: CLI flag > env variable > default path", () => {
      const origEnv = process.env.OBSIDIAN_VAULT_PATH;
      try {
        delete process.env.OBSIDIAN_VAULT_PATH;
        expect(resolveVaultPath()).toBe(DEFAULT_VAULT_PATH);

        process.env.OBSIDIAN_VAULT_PATH = "/custom/env/vault";
        expect(resolveVaultPath()).toBe(path.resolve("/custom/env/vault"));

        expect(resolveVaultPath("/cli/flag/vault")).toBe(path.resolve("/cli/flag/vault"));
      } finally {
        if (origEnv) {
          process.env.OBSIDIAN_VAULT_PATH = origEnv;
        } else {
          delete process.env.OBSIDIAN_VAULT_PATH;
        }
      }
    });
  });

  describe("6. POST /api/highlights/sync Wireless Endpoint Integration", () => {
    const localServer = { requestIP: () => ({ address: "127.0.0.1" }) } as any;

    it("POST /api/highlights/sync accepts KOReader JSON export and writes to Obsidian vault", async () => {
      const { handleRequest } = await import("../uploader/server");

      const payload = {
        title: "Test KOReader Sync Book",
        author: "Test Author",
        progress: 75,
        entries: [
          {
            text: "OTA synced highlight from KOReader device over Wi-Fi.",
            notes: "Verified via automated test.",
            chapter: "Chapter 3",
            pageno: 42,
            datetime: "2026-09-23 00:00:00",
          },
        ],
      };

      const req = new Request("http://127.0.0.1:8086/api/highlights/sync", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          host: "127.0.0.1:8086",
        },
        body: JSON.stringify(payload),
      });

      // Point vault to our mockVault via environment
      const origVault = process.env.OBSIDIAN_VAULT_PATH;
      process.env.OBSIDIAN_VAULT_PATH = mockVault;

      try {
        const res = await handleRequest(req, localServer);
        expect(res.status).toBe(200);

        const data = (await res.json()) as any;
        expect(data.success).toBe(true);
        expect(data.count).toBe(1);
        expect(data.bookTitle).toBe("Test KOReader Sync Book");
        expect(data.path).toBe("Books/Test KOReader Sync Book.md");
        expect(data.path).not.toContain("/Users/");

        const targetFile = path.join(mockVault, "Books", "Test KOReader Sync Book.md");
        expect(fs.existsSync(targetFile)).toBe(true);

        const savedNote = fs.readFileSync(targetFile, "utf8");
        expect(savedNote).toContain("OTA synced highlight from KOReader device over Wi-Fi.");
        expect(savedNote).toContain("Verified via automated test.");
      } finally {
        if (origVault) {
          process.env.OBSIDIAN_VAULT_PATH = origVault;
        } else {
          delete process.env.OBSIDIAN_VAULT_PATH;
        }
      }
    });

    it("POST /api/highlights/sync rejects empty payload or missing title with 400", async () => {
      const { handleRequest } = await import("../uploader/server");

      const req = new Request("http://127.0.0.1:8086/api/highlights/sync", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          host: "127.0.0.1:8086",
        },
        body: JSON.stringify({}),
      });

      const res = await handleRequest(req, localServer);
      expect(res.status).toBe(400);
      const data = (await res.json()) as any;
      expect(data.success).toBe(false);
      expect(data.error).toContain("Payload must contain book title");
    });

    it("POST /api/highlights/sync rejects payloads exceeding 5MB with 413", async () => {
      const { handleRequest } = await import("../uploader/server");

      const req = new Request("http://127.0.0.1:8086/api/highlights/sync", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Content-Length": String(6 * 1024 * 1024),
          host: "127.0.0.1:8086",
        },
        body: JSON.stringify({ title: "Oversized" }),
      });

      const res = await handleRequest(req, localServer);
      expect(res.status).toBe(413);
      const data = (await res.json()) as any;
      expect(data.success).toBe(false);
      expect(data.error).toContain("Payload too large");
    });
  });

  describe("7. CLI bin/lighthouse sync-obsidian Integration", () => {
    it("bin/lighthouse sync-obsidian --help prints command options", () => {
      const res = spawnSync(LIGHTHOUSE_BIN, ["sync-obsidian", "--help"], {
        encoding: "utf8",
        cwd: tempDir,
      });

      expect(res.status).toBe(0);
      expect(res.stdout).toContain("LightHouse Obsidian Highlight & Note Sync CLI");
      expect(res.stdout).toContain("--vault-path");
      expect(res.stdout).toContain("--dry-run");
      expect(res.stdout).toContain("--apply");
      expect(res.stdout).toContain("--watch");
    });

    it("bin/lighthouse --help includes sync-obsidian command in listing", () => {
      const res = spawnSync(LIGHTHOUSE_BIN, ["--help"], {
        encoding: "utf8",
        cwd: tempDir,
      });

      expect(res.status).toBe(0);
      expect(res.stdout).toContain("sync-obsidian");
    });
  });
});
