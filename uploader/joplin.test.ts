import { describe, expect, it, beforeEach, afterEach } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Database } from "bun:sqlite";
import {
  handleJoplinRequest,
  isJoplinRoute,
  validateJoplinToken,
  getJoplinToken,
  sanitizeTitle,
  normalizeQuote,
  splitHighlightEntries,
  mergeJoplinHighlights,
  isQuoteInExisting,
  processJoplinNote,
  getBookNotePath,
  JOPLIN_CLIPPER_PING_RESPONSE,
  JOPLIN_FOLDER_ID,
  JOPLIN_FOLDER_TITLE,
  HIGHLIGHTS_START_MARKER,
  HIGHLIGHTS_END_MARKER,
  extractQuoteKey,
  extractAnnotation,
  isGeneratedAttributionLine,
} from "./joplin";
import { getHighlightsForBook, initHighlightsTable } from "./highlights";
import { handleRequest } from "./server";
import { mergeNoteContent } from "../scripts/sync-obsidian";

const TEST_JOPLIN_TOKEN = "test-joplin-secret";

describe("Joplin Clipper HTTP Compatibility (uploader/joplin.ts)", () => {
  let tempDir: string;
  let booksDir: string;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "joplin-test-"));
    booksDir = path.join(tempDir, "Books");
    fs.mkdirSync(booksDir, { recursive: true });
    process.env.OBSIDIAN_BOOKS_DIR = booksDir;
    process.env.JOPLIN_TOKEN = TEST_JOPLIN_TOKEN;
    process.env.CALIBRE_DB_PATH = path.join(tempDir, "missing-calibre.db");
  });

  afterEach(() => {
    delete process.env.OBSIDIAN_BOOKS_DIR;
    delete process.env.JOPLIN_TOKEN;
    delete process.env.CALIBRE_DB_PATH;
    if (fs.existsSync(tempDir)) {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  describe("Route Recognition (isJoplinRoute)", () => {
    it("recognizes all standard Joplin Clipper routes", () => {
      expect(isJoplinRoute("/ping")).toBe(true);
      expect(isJoplinRoute("/folders")).toBe(true);
      expect(isJoplinRoute("/folders/koreader-notes")).toBe(true);
      expect(isJoplinRoute("/notes")).toBe(true);
      expect(isJoplinRoute("/notes/some-note-id")).toBe(true);
      expect(isJoplinRoute("/notes/Overlord%2C%20Vol.%2001")).toBe(true);
    });

    it("rejects non-Joplin routes", () => {
      expect(isJoplinRoute("/api/books")).toBe(false);
      expect(isJoplinRoute("/opds")).toBe(false);
      expect(isJoplinRoute("/")).toBe(false);
      expect(isJoplinRoute("/ping-pong")).toBe(false);
      expect(isJoplinRoute("/notesapp")).toBe(false);
    });
  });

  describe("Token Authentication (validateJoplinToken)", () => {
    it("accepts token in query parameter ?token=...", () => {
      const req = new Request("http://localhost/folders?token=test-joplin-secret");
      const url = new URL(req.url);
      expect(validateJoplinToken(req, url)).toBe(true);
    });

    it("accepts token in Authorization: Bearer header", () => {
      const req = new Request("http://localhost/folders", {
        headers: { Authorization: `Bearer ${TEST_JOPLIN_TOKEN}` },
      });
      const url = new URL(req.url);
      expect(validateJoplinToken(req, url)).toBe(true);
    });

    it("accepts token in X-API-Key header", () => {
      const req = new Request("http://localhost/folders", {
        headers: { "X-API-Key": TEST_JOPLIN_TOKEN },
      });
      const url = new URL(req.url);
      expect(validateJoplinToken(req, url)).toBe(true);
    });

    it("accepts token in X-Token and token headers", () => {
      const req1 = new Request("http://localhost/folders", {
        headers: { "X-Token": TEST_JOPLIN_TOKEN },
      });
      expect(validateJoplinToken(req1, new URL(req1.url))).toBe(true);

      const req2 = new Request("http://localhost/folders", {
        headers: { token: TEST_JOPLIN_TOKEN },
      });
      expect(validateJoplinToken(req2, new URL(req2.url))).toBe(true);
    });

    it("rejects missing token with 401", () => {
      const req = new Request("http://localhost/folders");
      const url = new URL(req.url);
      expect(validateJoplinToken(req, url)).toBe(false);
    });

    it("rejects incorrect token with 401", () => {
      const req = new Request("http://localhost/folders?token=wrong_token");
      const url = new URL(req.url);
      expect(validateJoplinToken(req, url)).toBe(false);
    });

    it("respects expectedToken option or JOPLIN_TOKEN environment variable", () => {
      process.env.JOPLIN_TOKEN = "custom_secret_123";
      try {
        const req = new Request("http://localhost/folders?token=custom_secret_123");
        expect(validateJoplinToken(req, new URL(req.url))).toBe(true);

        const oldReq = new Request("http://localhost/folders?token=not-the-configured-token");
        expect(validateJoplinToken(oldReq, new URL(oldReq.url))).toBe(false);

        expect(
          validateJoplinToken(oldReq, new URL(oldReq.url), "not-the-configured-token"),
        ).toBe(true);
      } finally {
        process.env.JOPLIN_TOKEN = TEST_JOPLIN_TOKEN;
      }
    });

    it("fails closed when JOPLIN_TOKEN is unset or empty", async () => {
      delete process.env.JOPLIN_TOKEN;
      expect(getJoplinToken()).toBe("");
      const missing = new Request("http://localhost/folders?token=anything");
      expect(validateJoplinToken(missing, new URL(missing.url))).toBe(false);
      expect(validateJoplinToken(missing, new URL(missing.url), "")).toBe(false);

      const res = await handleJoplinRequest(missing, new URL(missing.url), {
        booksDir,
      });
      expect(res.status).toBe(503);

      process.env.JOPLIN_TOKEN = "   ";
      expect(getJoplinToken()).toBe("");
      expect(validateJoplinToken(missing, new URL(missing.url))).toBe(false);
      process.env.JOPLIN_TOKEN = TEST_JOPLIN_TOKEN;
    });
  });

  describe("GET /ping Endpoint", () => {
    it("returns HTTP 200, Content-Type: text/plain, and body 'JoplinClipperServer'", async () => {
      const req = new Request("http://localhost/ping");
      const url = new URL(req.url);
      const res = await handleJoplinRequest(req, url, { booksDir });

      expect(res.status).toBe(200);
      expect(res.headers.get("content-type")).toContain("text/plain");
      const text = await res.text();
      expect(text).toBe(JOPLIN_CLIPPER_PING_RESPONSE);
    });

    it("does not require authentication token for /ping", async () => {
      // KOReader ping(ip, port) does not attach token query
      const req = new Request("http://localhost/ping");
      const url = new URL(req.url);
      const res = await handleJoplinRequest(req, url, { booksDir });

      expect(res.status).toBe(200);
      const text = await res.text();
      expect(text).toBe("JoplinClipperServer");
    });

    it("supports HEAD /ping without body", async () => {
      const req = new Request("http://localhost/ping", { method: "HEAD" });
      const url = new URL(req.url);
      const res = await handleJoplinRequest(req, url, { booksDir });

      expect(res.status).toBe(200);
      expect(res.body).toBeNull();
    });

    it("rejects unsupported methods on /ping with 405", async () => {
      const req = new Request("http://localhost/ping", { method: "POST" });
      const url = new URL(req.url);
      const res = await handleJoplinRequest(req, url, { booksDir });

      expect(res.status).toBe(405);
    });
  });

  describe("Folders Endpoints (/folders)", () => {
    it("returns 401 Unauthorized when token is missing", async () => {
      const req = new Request("http://localhost/folders");
      const url = new URL(req.url);
      const res = await handleJoplinRequest(req, url, { booksDir });

      expect(res.status).toBe(401);
      const json = await res.json();
      expect(json.error).toContain("Invalid or missing Joplin token");
    });

    it("GET /folders returns JSON with koreader-notes folder and has_more: false", async () => {
      const req = new Request("http://localhost/folders?token=test-joplin-secret");
      const url = new URL(req.url);
      const res = await handleJoplinRequest(req, url, { booksDir });

      expect(res.status).toBe(200);
      expect(res.headers.get("content-type")).toContain("application/json");
      const json = await res.json();
      expect(json).toEqual({
        items: [{ id: JOPLIN_FOLDER_ID, title: JOPLIN_FOLDER_TITLE }],
        has_more: false,
      });
    });

    it("POST /folders returns folder details with id and title", async () => {
      const req = new Request("http://localhost/folders?token=test-joplin-secret", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ title: "KOReader Notes", created_time: 1714000000 }),
      });
      const url = new URL(req.url);
      const res = await handleJoplinRequest(req, url, { booksDir });

      expect(res.status).toBe(200);
      const json = await res.json();
      expect(json).toEqual({
        id: "koreader-notes",
        title: "KOReader Notes",
      });
    });

    it("GET /folders/:id returns folder details", async () => {
      const req = new Request("http://localhost/folders/koreader-notes?token=test-joplin-secret");
      const url = new URL(req.url);
      const res = await handleJoplinRequest(req, url, { booksDir });

      expect(res.status).toBe(200);
      const json = await res.json();
      expect(json.id).toBe("koreader-notes");
      expect(json.title).toBe("KOReader Notes");
    });
  });

  describe("Notes Listing Endpoints (GET /notes)", () => {
    it("returns 401 Unauthorized when token is missing", async () => {
      const req = new Request("http://localhost/notes");
      const url = new URL(req.url);
      const res = await handleJoplinRequest(req, url, { booksDir });

      expect(res.status).toBe(401);
    });

    it("GET /notes returns empty items array and has_more: false", async () => {
      const req = new Request("http://localhost/notes?token=test-joplin-secret&fields=id,title,parent_id&page=1");
      const url = new URL(req.url);
      const res = await handleJoplinRequest(req, url, { booksDir });

      expect(res.status).toBe(200);
      const json = await res.json();
      expect(json).toEqual({
        items: [],
        has_more: false,
      });
    });

    it("GET /notes/:id returns note id and title", async () => {
      const req = new Request("http://localhost/notes/Dune?token=test-joplin-secret");
      const url = new URL(req.url);
      const res = await handleJoplinRequest(req, url, { booksDir });

      expect(res.status).toBe(200);
      const json = await res.json();
      expect(json.id).toBe("Dune");
      expect(json.title).toBe("Dune");
    });
  });

  describe("Note Creation & Update (POST /notes & PUT /notes/:id)", () => {
    it("creates a new book note with YAML frontmatter, title, and highlight markers", async () => {
      const payload = {
        title: "Dune",
        body: [
          "# Dune",
          "##### Frank Herbert",
          "",
          "## Chapter 1",
          "### Page 15 @ 25 April 2024 10:30:00 AM",
          "A beginning is the time for taking the most delicate care that the balances are correct.",
          "---",
          "Princess Irulan commentary",
        ].join("\n"),
        parent_id: "koreader-notes",
      };

      const req = new Request("http://localhost/notes?token=test-joplin-secret", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
      const url = new URL(req.url);
      const res = await handleJoplinRequest(req, url, { booksDir });

      expect(res.status).toBe(200);
      const json = await res.json();
      expect(json.id).toBe("Dune");
      expect(json.title).toBe("Dune");

      const noteFilePath = path.join(booksDir, "Dune.md");
      expect(fs.existsSync(noteFilePath)).toBe(true);

      const content = fs.readFileSync(noteFilePath, "utf8");
      // YAML frontmatter checks
      expect(content).toContain('title: "Dune"');
      expect(content).toContain('author: "Frank Herbert"');
      expect(content).toContain("tags:\n  - reading\n  - highlights\n  - koreader");
      expect(content).not.toMatch(/^tags:\s*\[/m);
      expect(content).toContain("## Chapter 1");
      expect(content).toMatch(/updated:\s*"\d{4}-\d{2}-\d{2}T/);

      // Section markers checks
      expect(content).toContain("# Dune");
      expect(content).toContain("## Highlights & Notes");
      expect(content).toContain(HIGHLIGHTS_START_MARKER);
      expect(content).toContain(HIGHLIGHTS_END_MARKER);
      expect(content).toContain("A beginning is the time for taking the most delicate care");
      expect(content).toContain("Princess Irulan commentary");
    });

    it("PUT /notes/:id updates an existing note and refreshes frontmatter", async () => {
      // 1. Initial note
      await processJoplinNote(
        {
          title: "Atomic Habits",
          body: "### Page 10 @ 2024-01-01\nSmall habits make a big difference.",
        },
        { booksDir },
      );

      const noteFilePath = path.join(booksDir, "Atomic Habits.md");
      const initialContent = fs.readFileSync(noteFilePath, "utf8");
      expect(initialContent).toContain("Small habits make a big difference.");

      // 2. PUT update with new highlight
      const req = new Request("http://localhost/notes/Atomic%20Habits?token=test-joplin-secret", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          body: [
            "### Page 10 @ 2024-01-01",
            "Small habits make a big difference.",
            "",
            "### Page 25 @ 2024-01-02",
            "You do not rise to the level of your goals. You fall to the level of your systems.",
          ].join("\n"),
        }),
      });
      const url = new URL(req.url);
      const res = await handleJoplinRequest(req, url, { booksDir });

      expect(res.status).toBe(200);
      const json = await res.json();
      expect(json.title).toBe("Atomic Habits");

      const updatedContent = fs.readFileSync(noteFilePath, "utf8");
      expect(updatedContent).toContain("Small habits make a big difference.");
      expect(updatedContent).toContain("You fall to the level of your systems.");
    });

    it("handles invalid JSON payload with 400 Bad Request", async () => {
      const req = new Request("http://localhost/notes?token=test-joplin-secret", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: "not-json-content",
      });
      const url = new URL(req.url);
      const res = await handleJoplinRequest(req, url, { booksDir });

      expect(res.status).toBe(400);
      const json = await res.json();
      expect(json.error).toContain("Invalid JSON");
    });
  });

  describe("Idempotent Merging & Preservation Guarantees", () => {
    it("re-exporting identical highlights does not duplicate them", async () => {
      const payload = {
        title: "Deduplication Test",
        body: [
          "# Deduplication Test",
          "##### Author A",
          "",
          "### Page 12 @ 2024-05-01",
          "==First immutable quote to test.==",
          "",
          "### Page 45 @ 2024-05-01",
          "==Second immutable quote to test.==",
        ].join("\n"),
      };

      // Export Round 1
      await processJoplinNote(payload, { booksDir });
      const notePath = path.join(booksDir, "Deduplication Test.md");
      const content1 = fs.readFileSync(notePath, "utf8");

      // Verify occurrences
      const occurrences1 = (
        content1.match(/First immutable quote to test/g) || []
      ).length;
      expect(occurrences1).toBe(1);

      // Export Round 2 with exact same payload
      await processJoplinNote(payload, { booksDir });
      const content2 = fs.readFileSync(notePath, "utf8");

      const occurrences2 = (
        content2.match(/First immutable quote to test/g) || []
      ).length;
      expect(occurrences2).toBe(1);

      const secondOccurrences = (
        content2.match(/Second immutable quote to test/g) || []
      ).length;
      expect(secondOccurrences).toBe(1);
    });

    it("appends only new highlights when subsequent exports include additional entries", async () => {
      const notePath = path.join(booksDir, "Incremental Test.md");

      // Round 1: Highlight 1
      await processJoplinNote(
        {
          title: "Incremental Test",
          body: "### Page 1\nQuote One",
        },
        { booksDir },
      );

      let content = fs.readFileSync(notePath, "utf8");
      expect(content).toContain("Quote One");
      expect(content).not.toContain("Quote Two");

      // Round 2: Highlight 1 + Highlight 2
      await processJoplinNote(
        {
          title: "Incremental Test",
          body: "### Page 1\nQuote One\n\n### Page 2\nQuote Two",
        },
        { booksDir },
      );

      content = fs.readFileSync(notePath, "utf8");
      expect((content.match(/Quote One/g) || []).length).toBe(1);
      expect((content.match(/Quote Two/g) || []).length).toBe(1);
    });

    it("preserves manual user edits and custom sections outside highlight markers", async () => {
      const notePath = path.join(booksDir, "User Edits.md");
      const customInitialNote = [
        "---",
        'title: "User Edits"',
        'author: "Custom Author"',
        "tags: [reading, highlights, koreader, favorite]",
        "custom_rating: 5",
        'updated: "2024-01-01T00:00:00.000Z"',
        "---",
        "",
        "# User Edits",
        "",
        "My custom personal reflection written before highlights.",
        "",
        "## Highlights & Notes",
        HIGHLIGHTS_START_MARKER,
        "### Page 5\nOriginal highlight.",
        HIGHLIGHTS_END_MARKER,
        "",
        "## My Action Items & Takeaways",
        "- [ ] Read author's next book",
        "- [x] Apply lesson 1 to daily routine",
      ].join("\n");

      fs.writeFileSync(notePath, customInitialNote, "utf8");

      // Trigger Joplin update with a new highlight
      await processJoplinNote(
        {
          title: "User Edits",
          body: [
            "### Page 5\nOriginal highlight.",
            "### Page 20\nNew secondary highlight.",
          ].join("\n"),
        },
        { booksDir },
      );

      const updated = fs.readFileSync(notePath, "utf8");

      // Verify custom sections outside markers were 100% preserved
      expect(updated).toContain("My custom personal reflection written before highlights.");
      expect(updated).toContain("## My Action Items & Takeaways");
      expect(updated).toContain("- [ ] Read author's next book");
      expect(updated).toContain("custom_rating: 5");
      expect(updated).toContain("favorite");

      // Verify highlights inside markers were cleanly merged
      expect((updated.match(/Original highlight/g) || []).length).toBe(1);
      expect((updated.match(/New secondary highlight/g) || []).length).toBe(1);
    });

    it("replaces *No highlights recorded yet.* placeholder on first real highlight import", async () => {
      const notePath = path.join(booksDir, "Placeholder Test.md");
      const placeholderNote = [
        "---",
        'title: "Placeholder Test"',
        'author: "Unknown"',
        "tags: [reading, highlights, koreader]",
        'updated: "2024-01-01T00:00:00.000Z"',
        "---",
        "",
        "# Placeholder Test",
        "",
        "## Highlights & Notes",
        HIGHLIGHTS_START_MARKER,
        "*No highlights recorded yet.*",
        HIGHLIGHTS_END_MARKER,
      ].join("\n");

      fs.writeFileSync(notePath, placeholderNote, "utf8");

      await processJoplinNote(
        {
          title: "Placeholder Test",
          body: "### Page 100\nFirst real highlight replacing placeholder.",
        },
        { booksDir },
      );

      const content = fs.readFileSync(notePath, "utf8");
      expect(content).not.toContain("*No highlights recorded yet.*");
      expect(content).toContain("First real highlight replacing placeholder.");
    });
  });

  describe("Title Sanitization & Path Traversal Security", () => {
    it("sanitizes illegal filesystem characters into clean separators", () => {
      expect(sanitizeTitle("Re:Zero - Starting Life in Another World")).toBe(
        "Re - Zero - Starting Life in Another World",
      );
      expect(sanitizeTitle("Title <with> /illegal\\ characters*?")).toBe(
        "Title with illegal characters",
      );
      expect(sanitizeTitle("Book | Subtitle [Ebook] (Channel)")).toBe(
        "Book - Subtitle",
      );
    });

    it("preserves non-Latin Unicode titles (Burmese, Japanese, Accents)", () => {
      expect(sanitizeTitle("သခင်စောသူ - ဝတ္ထုတိုများ")).toBe("သခင်စောသူ - ဝတ္ထုတိုများ");
      expect(sanitizeTitle("オーバーロード 1 不死者の王")).toBe("オーバーロード 1 不死者の王");
      expect(sanitizeTitle("Crème Brûlée & Café")).toBe("Crème Brûlée & Café");
    });

    it("prevents directory traversal attempts and keeps files within booksDir", () => {
      const realBooks = fs.realpathSync(booksDir);
      const { safeTitle, notePath } = getBookNotePath("../../etc/passwd", booksDir);
      expect(safeTitle).not.toContain("..");
      expect(notePath.startsWith(realBooks)).toBe(true);
      expect(notePath).toBe(path.join(realBooks, "etc passwd.md"));
    });

    it("truncates excessively long titles to avoid ENAMETOOLONG on filesystem", async () => {
      const veryLongTitle = "A".repeat(300) + " - Subtitle " + "B".repeat(50);
      const { safeTitle, notePath } = getBookNotePath(veryLongTitle, booksDir);

      expect(Buffer.byteLength(path.basename(notePath), "utf8")).toBeLessThanOrEqual(255);

      const result = await processJoplinNote(
        {
          title: veryLongTitle,
          body: "### Page 1\nHighlight for very long title.",
        },
        { booksDir },
      );

      expect(result.id).toBe(safeTitle);
      expect(fs.existsSync(notePath)).toBe(true);
    });

    it("repairs broken or orphaned highlight markers without runaway duplication or frontmatter corruption", () => {
      // Missing end marker
      const brokenDoc1 = [
        "---",
        'title: "Broken Doc 1"',
        "tags: [reading, highlights, koreader]",
        'updated: "2024-01-01T00:00:00.000Z"',
        "---",
        "# Broken Doc 1",
        "## Highlights & Notes",
        HIGHLIGHTS_START_MARKER,
        "### Page 1\nQuote 1",
      ].join("\n");

      const fixed1 = mergeJoplinHighlights(
        brokenDoc1,
        "### Page 1\nQuote 1\n\n### Page 2\nQuote 2",
        "Broken Doc 1",
      );

      // 1. Valid frontmatter with clean newline separation
      expect(fixed1).toMatch(/---\n\n# Broken Doc 1/);
      expect(fixed1).not.toMatch(/---# Broken Doc 1/);

      // 2. Exact marker counts
      expect((fixed1.match(/<!-- lighthouse:highlights:start -->/g) || []).length).toBe(1);
      expect((fixed1.match(/<!-- lighthouse:highlights:end -->/g) || []).length).toBe(1);

      // 3. Exact quote cardinality (no duplicate quotes from repair)
      expect((fixed1.match(/Quote 1/g) || []).length).toBe(1);
      expect((fixed1.match(/Quote 2/g) || []).length).toBe(1);

      // Inverted markers
      const brokenDoc2 = [
        "---",
        'title: "Broken Doc 2"',
        "tags: [reading, highlights, koreader]",
        'updated: "2024-01-01T00:00:00.000Z"',
        "---",
        "# Broken Doc 2",
        "## Highlights & Notes",
        HIGHLIGHTS_END_MARKER,
        "### Page 1\nQuote 1",
        HIGHLIGHTS_START_MARKER,
      ].join("\n");

      const fixed2 = mergeJoplinHighlights(
        brokenDoc2,
        "### Page 1\nQuote 1\n\n### Page 2\nQuote 2",
        "Broken Doc 2",
      );

      expect(fixed2).toMatch(/---\n\n# Broken Doc 2/);
      expect((fixed2.match(/<!-- lighthouse:highlights:start -->/g) || []).length).toBe(1);
      expect((fixed2.match(/<!-- lighthouse:highlights:end -->/g) || []).length).toBe(1);
      expect((fixed2.match(/Quote 1/g) || []).length).toBe(1);
      expect((fixed2.match(/Quote 2/g) || []).length).toBe(1);

      // Inverted markers with subsequent manual section: subsequent section is preserved outside markers
      const brokenDoc3 = [
        "# Broken Doc 3",
        "## Highlights & Notes",
        HIGHLIGHTS_END_MARKER,
        "### Page 1\nQuote 1",
        HIGHLIGHTS_START_MARKER,
        "",
        "## Takeaways & Actions",
        "- [x] Apply lesson",
      ].join("\n");

      const fixed3 = mergeJoplinHighlights(
        brokenDoc3,
        "### Page 1\nQuote 1\n\n### Page 2\nQuote 2",
        "Broken Doc 3",
      );

      expect((fixed3.match(/## Takeaways & Actions/g) || []).length).toBe(1);
      const endMarkerPos = fixed3.indexOf(HIGHLIGHTS_END_MARKER);
      const takeawaysPos = fixed3.indexOf("## Takeaways & Actions");
      expect(takeawaysPos).toBeGreaterThan(endMarkerPos);

      // Existing ## Highlights & Notes without markers: does not duplicate section header
      const brokenDoc4 = [
        "# Broken Doc 4",
        "",
        "## Highlights & Notes",
        "Some preexisting text without markers.",
      ].join("\n");

      const fixed4 = mergeJoplinHighlights(
        brokenDoc4,
        "### Page 1\nNew Quote 1",
        "Broken Doc 4",
      );
      expect((fixed4.match(/## Highlights & Notes/g) || []).length).toBe(1);
    });

    it("prevents false-positive deduplication from cross-entry prefix/suffix collisions", () => {
      // Existing notes with two distinct entries
      const existingText = [
        "### Page 1 @ 2024-01-01",
        "It was the best of times, it was the worst of times, it was the age of wisdom and foolishness.",
        "",
        "### Page 50 @ 2024-01-02",
        "A revolutionary event occurred in the year of our Lord seventeen seventy six.",
      ].join("\n");

      // New entry that shares prefix with Entry 1 and suffix with Entry 2
      const candidateQuote = normalizeQuote(
        "It was the best of times, it was the worst of times, but a completely new movement arose in the year of our Lord seventeen seventy six.",
      );

      // Must NOT be treated as already existing
      expect(isQuoteInExisting(candidateQuote, existingText)).toBe(false);
    });
  });

  describe("Payload Limits & Error Sanitization", () => {
    it("rejects payloads exceeding MAX_JOPLIN_BODY_BYTES (5MB) with 413", async () => {
      const largeContent = "X".repeat(6 * 1024 * 1024);
      const req = new Request("http://localhost:8086/notes?token=test-joplin-secret", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Content-Length": String(largeContent.length),
        },
        body: JSON.stringify({ title: "Oversized", body: largeContent }),
      });
      const url = new URL(req.url);
      const res = await handleJoplinRequest(req, url, { booksDir });

      expect(res.status).toBe(413);
      const json = await res.json();
      expect(json.error).toContain("Payload too large");
    });

    it("sanitizes 500 error responses and never leaks absolute filesystem paths", async () => {
      // Pass an invalid unwritable path to force an internal error
      const unwritableDir = "/dev/null/impossible_books_dir";
      const req = new Request("http://localhost:8086/notes?token=test-joplin-secret", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ title: "Crash Test", body: "quote" }),
      });
      const url = new URL(req.url);
      const res = await handleJoplinRequest(req, url, { booksDir: unwritableDir });

      expect(res.status).toBe(500);
      const json = await res.json();
      expect(json.error).toBeDefined();
      expect(json.error).not.toContain("/dev/null/impossible_books_dir");
      expect(json.error).not.toContain("/Users/");
    });
  });

  describe("Full Server Integration (uploader/server.ts)", () => {
    it("handles /ping through primary server handleRequest", async () => {
      const req = new Request("http://localhost:8086/ping");
      const res = await handleRequest(req);

      expect(res.status).toBe(200);
      const text = await res.text();
      expect(text).toBe("JoplinClipperServer");
    });

    it("handles /folders and /notes through primary server handleRequest", async () => {
      // 1. Folders
      const foldersReq = new Request("http://localhost:8086/folders?token=test-joplin-secret");
      const foldersRes = await handleRequest(foldersReq);
      expect(foldersRes.status).toBe(200);
      const foldersJson = await foldersRes.json();
      expect(foldersJson.items[0].id).toBe("koreader-notes");

      // 2. Notes export
      const notesReq = new Request("http://localhost:8086/notes?token=test-joplin-secret", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          title: "Server Integration Test",
          body: "### Page 1\nServer integration works seamlessly!",
        }),
      });
      const notesRes = await handleRequest(notesReq);
      expect(notesRes.status).toBe(200);
      const notesJson = await notesRes.json();
      expect(notesJson.title).toBe("Server Integration Test");

      const savedNote = path.join(booksDir, "Server Integration Test.md");
      expect(fs.existsSync(savedNote)).toBe(true);
    });

    it("allows WAN reverse-tunnel requests with Joplin token without requiring READING_API_KEY", async () => {
      // Simulate WAN request from opds.wavypremium.xyz
      const wanReq = new Request("http://opds.wavypremium.xyz/notes?token=test-joplin-secret", {
        method: "POST",
        headers: {
          Host: "opds.wavypremium.xyz",
          "X-Forwarded-Host": "opds.wavypremium.xyz",
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          title: "WAN Sync Test",
          body: "### Page 99\nSyncing over public WAN via reverse tunnel.",
        }),
      });

      const wanRes = await handleRequest(wanReq);
      expect(wanRes.status).toBe(200);
      const json = await wanRes.json();
      expect(json.title).toBe("WAN Sync Test");

      const savedNote = path.join(booksDir, "WAN Sync Test.md");
      expect(fs.existsSync(savedNote)).toBe(true);
    });
  });

  describe("Documentation & User Manual Sync", () => {
    it("README.md documents KOReader Joplin Highlight Export with host, port, token, and sync target", () => {
      const readmePath = path.join((import.meta as any).dir, "../README.md");
      expect(fs.existsSync(readmePath)).toBe(true);
      const readme = fs.readFileSync(readmePath, "utf8");

      expect(readme).toContain("KOReader Joplin Highlight Sync");
      expect(readme).toContain("http://192.168.31.15:8086");
      expect(readme).toContain("plain HTTP-only");
      expect(readme).not.toContain("opds.wavypremium.xyz");
      expect(readme).toContain("JOPLIN_TOKEN");
      const joplinLines = readme.split("\n").filter((line) => /Joplin/i.test(line));
      expect(joplinLines.length).toBeGreaterThan(0);
      for (const line of joplinLines) {
        expect(line).not.toContain("8443");
      }
      expect(readme).not.toContain("Token: `lighthouse`");
      expect(readme).not.toContain("Token `lighthouse`");
      expect(readme).toContain("Joplin Highlight & Note Export");
      expect(readme).toContain("Native KOReader Joplin Clipper Exporter");
    });

    it("uploader/index.html guide modal documents KOReader Joplin Highlight Export with copyable endpoints", () => {
      const htmlPath = path.join((import.meta as any).dir, "index.html");
      expect(fs.existsSync(htmlPath)).toBe(true);
      const html = fs.readFileSync(htmlPath, "utf8");

      expect(html).toContain("Native Joplin Clipper Exporter");
      expect(html).toContain("copyToClipboard('192.168.31.15')");
      expect(html).not.toContain("copyToClipboard('opds.wavypremium.xyz')");
      expect(html).not.toContain("opds.wavypremium.xyz");
      expect(html).not.toContain("copyToClipboard('lighthouse')");
      expect(html).toContain("JOPLIN_TOKEN");
      expect(html).toContain("plain HTTP-only");
      expect(html).toContain("8086");
      const guideStart = html.indexOf("Native Joplin Clipper Exporter");
      const guideEnd = html.indexOf("Wireless Over-The-Air Export", guideStart);
      const cardStart = html.indexOf("KOReader Joplin Exporter (Native Wi-Fi Sync)");
      const cardEnd = html.indexOf("Obsidian Highlights Sync", cardStart);
      expect(guideStart).toBeGreaterThan(-1);
      expect(guideEnd).toBeGreaterThan(guideStart);
      expect(cardStart).toBeGreaterThan(-1);
      expect(cardEnd).toBeGreaterThan(cardStart);
      expect(html.slice(guideStart, guideEnd)).not.toContain("8443");
      expect(html.slice(cardStart, cardEnd)).not.toContain("8443");
      expect(html).toContain("KOReader Joplin Exporter (Native Wi-Fi Sync)");
    });
  });

  describe("Oracle remediation regressions", () => {
    const missingCalibre = () => path.join(tempDir, "missing-calibre.db");

    it("rejects WAN writes that lack a valid Joplin token before creating a note", async () => {
      const wanReq = new Request("http://opds.wavypremium.xyz/notes?token=wrong", {
        method: "POST",
        headers: {
          Host: "opds.wavypremium.xyz",
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          title: "Should Not Land",
          body: "### Page 1\n==secret==",
        }),
      });
      const wanRes = await handleRequest(wanReq);
      expect(wanRes.status).toBe(401);
      expect(fs.existsSync(path.join(booksDir, "Should Not Land.md"))).toBe(false);

      delete process.env.JOPLIN_TOKEN;
      const unset = new Request("http://opds.wavypremium.xyz/notes", {
        method: "POST",
        headers: { Host: "opds.wavypremium.xyz", "Content-Type": "application/json" },
        body: JSON.stringify({ title: "Unset Token", body: "### Page 1\n==nope==" }),
      });
      const unsetRes = await handleRequest(unset);
      expect(unsetRes.status).toBe(503);
      expect(fs.existsSync(path.join(booksDir, "Unset Token.md"))).toBe(false);
      process.env.JOPLIN_TOKEN = TEST_JOPLIN_TOKEN;
    });

    it("preserves chapter headings and dedups short quotes without dropping distinct ones", async () => {
      const body = [
        "# Dune",
        "##### Frank Herbert",
        "## Chapter 1: The Beginning",
        "### Page 1 @ 2024-01-01",
        "==OK==",
        "",
        "### Page 2 @ 2024-01-01",
        "==Fear is the mind-killer.==",
        "",
        "### Page 3 @ 2024-01-02",
        "==time==",
      ].join("\n");
      await processJoplinNote(
        { title: "Dune", body },
        { booksDir, calibreDbPath: missingCalibre() },
      );
      await processJoplinNote(
        { title: "Dune", body },
        { booksDir, calibreDbPath: missingCalibre() },
      );
      const content = fs.readFileSync(path.join(booksDir, "Dune.md"), "utf8");
      expect(content).toContain("## Chapter 1: The Beginning");
      expect((content.match(/==OK==/g) || []).length).toBe(1);
      expect((content.match(/==time==/g) || []).length).toBe(1);
      expect((content.match(/Fear is the mind-killer/g) || []).length).toBe(1);
    });

    it("updates an annotation in place when the exact quote already exists", async () => {
      await processJoplinNote(
        {
          title: "Annotation Edit",
          body: "### Page 1\n==delicate care==\n---\noriginal",
        },
        { booksDir, calibreDbPath: missingCalibre() },
      );
      await processJoplinNote(
        {
          title: "Annotation Edit",
          body: "### Page 1\n==delicate care==\n---\nEDITED",
        },
        { booksDir, calibreDbPath: missingCalibre() },
      );
      const content = fs.readFileSync(path.join(booksDir, "Annotation Edit.md"), "utf8");
      expect((content.match(/delicate care/g) || []).length).toBe(1);
      expect(content).toContain("EDITED");
      expect(content).not.toContain("original");
    });

    it("does not swallow user headings or loose reflections when the end marker is missing", () => {
      const doc = [
        "---",
        'title: "Open"',
        "tags:",
        "  - reading",
        'updated: "2024-01-01T00:00:00.000Z"',
        "---",
        "# Open",
        "## Highlights & Notes",
        HIGHLIGHTS_START_MARKER,
        "### Page 1",
        "==kept quote==",
        "",
        "### My private subsection",
        "private text",
        "",
        "A loose reflection that must stay outside.",
      ].join("\n");
      const fixed = mergeJoplinHighlights(
        doc,
        "### Page 1\n==kept quote==\n\n### Page 2\n==new quote==",
        "Open",
        { calibreDbPath: missingCalibre() },
      );
      const endPos = fixed.indexOf(HIGHLIGHTS_END_MARKER);
      expect(endPos).toBeGreaterThan(-1);
      expect(fixed.indexOf("### My private subsection")).toBeGreaterThan(endPos);
      expect(fixed.indexOf("A loose reflection that must stay outside.")).toBeGreaterThan(endPos);
      expect((fixed.match(/kept quote/g) || []).length).toBe(1);
      expect(fixed).toContain("==new quote==");
    });

    function betweenMarkers(note: string): string {
      const start = note.indexOf(HIGHLIGHTS_START_MARKER);
      const end = note.indexOf(HIGHLIGHTS_END_MARKER);
      if (start === -1 || end === -1 || end < start) return "";
      return note.slice(start + HIGHLIGHTS_START_MARKER.length, end);
    }

    function expectPrivateSurvivesSync(note: string, snippets: string[]) {
      const startPos = note.indexOf(HIGHLIGHTS_START_MARKER);
      const endPos = note.indexOf(HIGHLIGHTS_END_MARKER);
      expect(startPos).toBeGreaterThan(-1);
      expect(endPos).toBeGreaterThan(startPos);
      const managed = betweenMarkers(note);
      for (const snippet of snippets) {
        expect(note).toContain(snippet);
        expect(managed).not.toContain(snippet);
        expect(note.indexOf(snippet)).toBeGreaterThan(endPos);
      }
      const synced = mergeNoteContent(note, {
        title: "Sync Check",
        author: "Ada",
        highlights: [{ text: "sidecar only" }],
        progress: 12,
      });
      const syncedStart = synced.indexOf(HIGHLIGHTS_START_MARKER);
      const syncedEnd = synced.indexOf(HIGHLIGHTS_END_MARKER);
      const syncedManaged = betweenMarkers(synced);
      expect(syncedEnd).toBeGreaterThan(syncedStart);
      for (const snippet of snippets) {
        expect(synced).toContain(snippet);
        expect(syncedManaged).not.toContain(snippet);
        expect(synced.indexOf(snippet)).toBeGreaterThan(syncedEnd);
      }
      expect(synced).toContain("sidecar only");
    }

    it("does not pull a private subsection into markers when the start marker is missing", () => {
      const doc = [
        "---",
        'title: "Startless"',
        "tags:",
        "  - reading",
        "---",
        "# Startless",
        "## Highlights & Notes",
        "### Page 1",
        "==kept quote==",
        "",
        "### My private subsection",
        "private text",
        "",
        "A loose reflection that must stay outside.",
        HIGHLIGHTS_END_MARKER,
        "",
        "## Takeaways",
        "- keep me",
      ].join("\n");
      const fixed = mergeJoplinHighlights(
        doc,
        "### Page 2\n==new quote==",
        "Startless",
        { calibreDbPath: missingCalibre() },
      );
      expectPrivateSurvivesSync(fixed, [
        "### My private subsection",
        "private text",
        "A loose reflection that must stay outside.",
      ]);
      expect(fixed).toContain("==kept quote==");
      expect(fixed).toContain("==new quote==");
      expect(fixed.indexOf("## Takeaways")).toBeGreaterThan(fixed.indexOf(HIGHLIGHTS_END_MARKER));
    });

    it("does not swallow a user ### section when markers are inverted", () => {
      const doc = [
        "---",
        'title: "Inv"',
        "tags:",
        "  - reading",
        "---",
        "# Inv",
        "## Highlights & Notes",
        HIGHLIGHTS_END_MARKER,
        "### Page 1",
        "==kept quote==",
        "",
        "### My private subsection",
        "private text",
        "",
        "## Takeaways",
        "- keep me",
        HIGHLIGHTS_START_MARKER,
      ].join("\n");
      const fixed = mergeJoplinHighlights(
        doc,
        "### Page 2\n==new quote==",
        "Inv",
        { calibreDbPath: missingCalibre() },
      );
      expectPrivateSurvivesSync(fixed, ["### My private subsection", "private text"]);
      expect(fixed.indexOf("## Takeaways")).toBeGreaterThan(fixed.indexOf(HIGHLIGHTS_END_MARKER));
      expect((fixed.match(new RegExp(HIGHLIGHTS_START_MARKER, "g")) || []).length).toBe(1);
      expect((fixed.match(new RegExp(HIGHLIGHTS_END_MARKER, "g")) || []).length).toBe(1);
    });

    it("does not treat a blockquote under a user heading as a KOReader chapter", () => {
      const doc = [
        "# BQ",
        "## Highlights & Notes",
        HIGHLIGHTS_START_MARKER,
        "### Page 1",
        "==kept quote==",
        "",
        "## Takeaways",
        "> my private thought",
      ].join("\n");
      const fixed = mergeJoplinHighlights(
        doc,
        "### Page 2\n==new quote==",
        "BQ",
        { calibreDbPath: missingCalibre() },
      );
      expectPrivateSurvivesSync(fixed, ["## Takeaways", "> my private thought"]);
      expect(betweenMarkers(fixed)).not.toContain("my private thought");
      expect(fixed).toContain("==kept quote==");
    });

    it("does not pull a reflection between quotes when a later page heading follows", () => {
      const doc = [
        "# Between",
        "## Highlights & Notes",
        HIGHLIGHTS_START_MARKER,
        "### Page 1",
        "==kept quote==",
        "",
        "## Takeaways",
        "> my private thought",
        "",
        "### Page 2",
        "==later quote==",
      ].join("\n");
      const fixed = mergeJoplinHighlights(
        doc,
        "### Page 3\n==incoming quote==",
        "Between",
        { calibreDbPath: missingCalibre() },
      );
      expectPrivateSurvivesSync(fixed, ["## Takeaways", "> my private thought"]);
      expect(betweenMarkers(fixed)).not.toContain("my private thought");
      expect(fixed).toContain("==kept quote==");
    });

    it("does not treat a page heading inside a blockquote as a chapter signal", () => {
      const doc = [
        "# QuotedPage",
        "## Highlights & Notes",
        HIGHLIGHTS_START_MARKER,
        "### Page 1",
        "==kept quote==",
        "",
        "## Takeaways",
        "> I liked ### Page 4 of this chapter",
      ].join("\n");
      const fixed = mergeJoplinHighlights(
        doc,
        "### Page 3\n==incoming quote==",
        "QuotedPage",
        { calibreDbPath: missingCalibre() },
      );
      expectPrivateSurvivesSync(fixed, [
        "## Takeaways",
        "> I liked ### Page 4 of this chapter",
      ]);
    });

    it("does not treat Obsidian emphasis under a user heading as a KOReader chapter", () => {
      const doc = [
        "# Emphasis",
        "## Highlights & Notes",
        HIGHLIGHTS_START_MARKER,
        "### Page 1",
        "==kept quote==",
        "",
        "## Takeaways",
        "==this is my emphasis not a koreader quote==",
        "",
        "more reflection after a blank line",
      ].join("\n");
      const fixed = mergeJoplinHighlights(
        doc,
        "### Page 3\n==incoming quote==",
        "Emphasis",
        { calibreDbPath: missingCalibre() },
      );
      expectPrivateSurvivesSync(fixed, [
        "## Takeaways",
        "==this is my emphasis not a koreader quote==",
        "more reflection after a blank line",
      ]);
    });

    it("does not open a managed region for a bare blockquote reflection", () => {
      const doc = [
        "# Loose",
        "## Highlights & Notes",
        HIGHLIGHTS_START_MARKER,
        "### Page 1",
        "==kept quote==",
        "",
        "> a loose blockquote reflection with no heading",
      ].join("\n");
      const fixed = mergeJoplinHighlights(
        doc,
        "### Page 3\n==incoming quote==",
        "Loose",
        { calibreDbPath: missingCalibre() },
      );
      expectPrivateSurvivesSync(fixed, [
        "> a loose blockquote reflection with no heading",
      ]);
      expect(betweenMarkers(fixed)).toContain("==kept quote==");
    });

    it("keeps a blockquote that is already inside an open page entry", () => {
      const doc = [
        "# InEntry",
        "## Highlights & Notes",
        HIGHLIGHTS_START_MARKER,
        "### Page 1",
        "==kept quote==",
        "> still inside the page entry",
      ].join("\n");
      const fixed = mergeJoplinHighlights(
        doc,
        "### Page 1\n==kept quote==",
        "InEntry",
        { calibreDbPath: missingCalibre() },
      );
      expect(betweenMarkers(fixed)).toContain("> still inside the page entry");
      expect(betweenMarkers(fixed)).toContain("==kept quote==");
    });

    it("does not consume an empty trailing user heading", () => {
      const doc = [
        "# EmptyHead",
        "## Highlights & Notes",
        HIGHLIGHTS_START_MARKER,
        "### Page 1",
        "==kept quote==",
        "",
        "## Takeaways",
      ].join("\n");
      const fixed = mergeJoplinHighlights(
        doc,
        "### Page 3\n==incoming quote==",
        "EmptyHead",
        { calibreDbPath: missingCalibre() },
      );
      expectPrivateSurvivesSync(fixed, ["## Takeaways"]);
      expect(betweenMarkers(fixed)).toContain("==kept quote==");
    });

    it("repairs inverted markers when the end marker sits before the highlights header", () => {
      const doc = [
        "# InvBefore",
        HIGHLIGHTS_END_MARKER,
        "preface that must stay",
        "## Highlights & Notes",
        "### Page 1",
        "==kept quote==",
        "",
        "### My private subsection",
        "private text",
        HIGHLIGHTS_START_MARKER,
      ].join("\n");
      const fixed = mergeJoplinHighlights(
        doc,
        "### Page 2\n==new quote==",
        "InvBefore",
        { calibreDbPath: missingCalibre() },
      );
      expect((fixed.match(/<!-- lighthouse:highlights:start -->/g) || []).length).toBe(1);
      expect((fixed.match(/<!-- lighthouse:highlights:end -->/g) || []).length).toBe(1);
      const startPos = fixed.indexOf(HIGHLIGHTS_START_MARKER);
      const endPos = fixed.indexOf(HIGHLIGHTS_END_MARKER);
      expect(endPos).toBeGreaterThan(startPos);
      expect(fixed.indexOf("preface that must stay")).toBeGreaterThan(-1);
      expect(fixed.indexOf("preface that must stay")).toBeLessThan(startPos);
      expectPrivateSurvivesSync(fixed, ["### My private subsection", "private text"]);
      const synced = mergeNoteContent(fixed, {
        title: "InvBefore",
        author: "Ada",
        highlights: [{ text: "sidecar only" }],
        progress: 12,
      });
      expect(synced).toContain("preface that must stay");
      expect(synced.indexOf("preface that must stay")).toBeLessThan(
        synced.indexOf(HIGHLIGHTS_START_MARKER),
      );
      const again = mergeJoplinHighlights(
        fixed,
        "### Page 2\n==new quote==",
        "InvBefore",
        { calibreDbPath: missingCalibre() },
      );
      expect((again.match(/<!-- lighthouse:highlights:start -->/g) || []).length).toBe(1);
      expect((again.match(/<!-- lighthouse:highlights:end -->/g) || []).length).toBe(1);
      expect(again.indexOf(HIGHLIGHTS_END_MARKER)).toBeGreaterThan(
        again.indexOf(HIGHLIGHTS_START_MARKER),
      );
      expect(again).toContain("preface that must stay");
      expect(again.indexOf("preface that must stay")).toBeLessThan(
        again.indexOf(HIGHLIGHTS_START_MARKER),
      );
    });

    it("still continues a chapter only for an explicit ### Page heading", () => {
      const doc = [
        "# Real",
        "## Highlights & Notes",
        HIGHLIGHTS_START_MARKER,
        "## Real Chapter",
        "### Page 2 @ 2024-01-01",
        "==later quote==",
      ].join("\n");
      const fixed = mergeJoplinHighlights(
        doc,
        "### Page 3\n==incoming quote==",
        "Real",
        { calibreDbPath: missingCalibre() },
      );
      const managed = betweenMarkers(fixed);
      expect(managed).toContain("## Real Chapter");
      expect(managed).toContain("### Page 2 @ 2024-01-01");
      expect(managed).toContain("==later quote==");
    });

    function buildNumericHeadingNote(
      markerPath:
        | "missing-end"
        | "missing-start"
        | "inverted-after-header"
        | "inverted-before-header",
      userLines: string[],
    ): string {
      const kept = ["### Page 1", "==kept quote==", ""];
      if (markerPath === "missing-end") {
        return [
          "# Numeric Probe",
          "## Highlights & Notes",
          HIGHLIGHTS_START_MARKER,
          ...kept,
          ...userLines,
        ].join("\n");
      }
      if (markerPath === "missing-start") {
        return [
          "# Numeric Probe",
          "## Highlights & Notes",
          ...kept,
          ...userLines,
          HIGHLIGHTS_END_MARKER,
        ].join("\n");
      }
      if (markerPath === "inverted-after-header") {
        return [
          "# Numeric Probe",
          "## Highlights & Notes",
          HIGHLIGHTS_END_MARKER,
          ...kept,
          ...userLines,
          HIGHLIGHTS_START_MARKER,
        ].join("\n");
      }
      return [
        "# Numeric Probe",
        HIGHLIGHTS_END_MARKER,
        "preface that must stay",
        "## Highlights & Notes",
        ...kept,
        ...userLines,
        HIGHLIGHTS_START_MARKER,
      ].join("\n");
    }

    const numericHeadingCases = [
      {
        name: "numbered takeaway under a user heading",
        lines: ["## Takeaways", "### 1. First point", "PRIVATE_SENTINEL"],
      },
      {
        name: "year heading under a user heading",
        lines: ["## Journal", "### 2024 notes", "PRIVATE_SENTINEL"],
      },
      {
        name: "bare numbered heading",
        lines: ["### 1. First point", "PRIVATE_SENTINEL"],
      },
      {
        name: "bare year heading",
        lines: ["### 2024 notes", "PRIVATE_SENTINEL"],
      },
    ] as const;
    const numericMarkerPaths = [
      "missing-end",
      "missing-start",
      "inverted-after-header",
      "inverted-before-header",
    ] as const;

    for (const fixture of numericHeadingCases) {
      for (const markerPath of numericMarkerPaths) {
        it(`keeps ${fixture.name} outside markers on ${markerPath}`, () => {
          const doc = buildNumericHeadingNote(markerPath, [...fixture.lines]);
          const fixed = mergeJoplinHighlights(
            doc,
            "### Page 2\n==new quote==",
            "Numeric Probe",
            { calibreDbPath: missingCalibre() },
          );
          expect((fixed.match(/<!-- lighthouse:highlights:start -->/g) || []).length).toBe(1);
          expect((fixed.match(/<!-- lighthouse:highlights:end -->/g) || []).length).toBe(1);
          expect(betweenMarkers(fixed)).toContain("==kept quote==");
          expect(betweenMarkers(fixed)).not.toContain("PRIVATE_SENTINEL");
          expect(betweenMarkers(fixed)).not.toContain("### 1. First point");
          expect(betweenMarkers(fixed)).not.toContain("### 2024 notes");
          if (markerPath === "inverted-before-header") {
            expect(fixed.indexOf("preface that must stay")).toBeLessThan(
              fixed.indexOf(HIGHLIGHTS_START_MARKER),
            );
          }
          expectPrivateSurvivesSync(fixed, [...fixture.lines]);
        });
      }
    }

    it("strips newlines and highlight markers from note headings", async () => {
      const evil = "Evil\r\n<!-- lighthouse:highlights:end -->\n## Highlights & Notes";
      await processJoplinNote(
        { title: evil, body: "### Page 1\n==only once==" },
        { booksDir, calibreDbPath: missingCalibre() },
      );
      const notePath = getBookNotePath(evil, booksDir).notePath;
      const content = fs.readFileSync(notePath, "utf8");
      const h1 = content.split("\n").find((line) => line.startsWith("# "));
      expect(h1).toBeDefined();
      expect(h1).not.toContain("lighthouse:highlights");
      expect((content.match(/<!-- lighthouse:highlights:start -->/g) || []).length).toBe(1);
      expect((content.match(/<!-- lighthouse:highlights:end -->/g) || []).length).toBe(1);
      expect((content.match(/only once/g) || []).length).toBe(1);
    });

    it("does not clobber a custom frontmatter author with the KOReader body author", async () => {
      const notePath = path.join(booksDir, "Kept.md");
      fs.writeFileSync(
        notePath,
        [
          "---",
          'title: "Kept"',
          'author: "User Chosen Author"',
          "tags:",
          "  - favorite",
          'updated: "2024-01-01T00:00:00.000Z"',
          "---",
          "",
          "# Kept",
          "",
          "## Highlights & Notes",
          HIGHLIGHTS_START_MARKER,
          "### Page 1",
          "==quote==",
          HIGHLIGHTS_END_MARKER,
          "",
        ].join("\n"),
        "utf8",
      );
      await processJoplinNote(
        {
          title: "Kept",
          body: "##### KOReader Author\n### Page 1\n==quote==",
        },
        { booksDir, calibreDbPath: missingCalibre() },
      );
      const content = fs.readFileSync(notePath, "utf8");
      expect(content).toContain('author: "User Chosen Author"');
      expect(content).not.toContain("KOReader Author");
    });

    it("refuses to write through a symlink inside the books directory", async () => {
      const outside = path.join(tempDir, "outside.md");
      fs.writeFileSync(outside, "SECRET", "utf8");
      const link = path.join(booksDir, "Linked.md");
      fs.symlinkSync(outside, link);
      await expect(
        processJoplinNote(
          { title: "Linked", body: "### Page 1\n==pwned==" },
          { booksDir, calibreDbPath: missingCalibre() },
        ),
      ).rejects.toThrow(/symlink/i);
      expect(fs.readFileSync(outside, "utf8")).toBe("SECRET");
      expect(fs.lstatSync(link).isSymbolicLink()).toBe(true);
    });

    it("returns 400 for a malformed percent-encoded note id", async () => {
      const req = new Request(
        `http://localhost/notes/%E0%A4%A?token=${TEST_JOPLIN_TOKEN}`,
      );
      const res = await handleJoplinRequest(req, new URL(req.url), { booksDir });
      expect(res.status).toBe(400);
      const json = await res.json();
      expect(json.error).toContain("Malformed note id");
    });

    it("does not duplicate a quote that already sits under Highlights without markers", () => {
      const existing = [
        "# Bare",
        "",
        "## Highlights & Notes",
        "### Page 1",
        "==Fear is the mind-killer.==",
        "",
        "## Takeaways",
        "- keep me",
      ].join("\n");
      const fixed = mergeJoplinHighlights(
        existing,
        "### Page 1\n==Fear is the mind-killer.==",
        "Bare",
        { calibreDbPath: missingCalibre() },
      );
      expect((fixed.match(/Fear is the mind-killer/g) || []).length).toBe(1);
      expect((fixed.match(/## Highlights & Notes/g) || []).length).toBe(1);
      const endPos = fixed.indexOf(HIGHLIGHTS_END_MARKER);
      expect(fixed.indexOf("## Takeaways")).toBeGreaterThan(endPos);
    });

    it("emits block-style tags that sync-obsidian mergeNoteContent preserves", () => {
      const note = mergeJoplinHighlights(
        "",
        "### Page 1\n==Hello there==",
        "Tag Compat",
        { calibreDbPath: missingCalibre() },
      );
      expect(note).toContain("tags:\n  - reading\n  - highlights\n  - koreader");
      expect(note).not.toMatch(/^tags:\s*\[/m);
      const withUser = note.replace("  - koreader", "  - koreader\n  - favorite");
      const synced = mergeNoteContent(withUser, {
        title: "Tag Compat",
        author: "Ada",
        highlights: [{ text: "Hello there" }],
        progress: 12,
      });
      expect(synced).toContain("- favorite");
      expect(synced).toContain("- koreader");
      expect(synced).toContain("- reading");
      expect(synced).toContain("- book-notes");
    });

    it("does not merge notes when sanitized titles differ only by case on case-insensitive filesystems", async () => {
      const res1 = await processJoplinNote(
        { title: "alpha notes", body: "### Page 1\n==quote from lower==" },
        { booksDir, calibreDbPath: missingCalibre() },
      );
      const res2 = await processJoplinNote(
        { title: "Alpha Notes", body: "### Page 2\n==quote from upper==" },
        { booksDir, calibreDbPath: missingCalibre() },
      );

      expect(res1.action).toBe("created");
      expect(res2.action).toBe("created");
      expect(res1.path).not.toBe(res2.path);

      const files = fs.readdirSync(booksDir).filter((f) => !f.startsWith("."));
      expect(files.length).toBe(2);

      const content1 = fs.readFileSync(res1.path, "utf8");
      const content2 = fs.readFileSync(res2.path, "utf8");

      expect(content1).toContain("quote from lower");
      expect(content1).not.toContain("quote from upper");

      expect(content2).toContain("quote from upper");
      expect(content2).not.toContain("quote from lower");

      // Verify re-exporting to each note updates the correct file without cross-talk
      const res1Update = await processJoplinNote(
        { title: "alpha notes", body: "### Page 1\n==quote from lower==\n\n### Page 3\n==second lower quote==" },
        { booksDir, calibreDbPath: missingCalibre() },
      );
      expect(res1Update.action).toBe("updated");
      expect(res1Update.path).toBe(res1.path);

      const updatedContent1 = fs.readFileSync(res1.path, "utf8");
      expect(updatedContent1).toContain("second lower quote");
      expect(updatedContent1).not.toContain("quote from upper");

      const res2Update = await processJoplinNote(
        { title: "Alpha Notes", body: "### Page 2\n==quote from upper==\n\n### Page 4\n==second upper quote==" },
        { booksDir, calibreDbPath: missingCalibre() },
      );
      expect(res2Update.action).toBe("updated");
      expect(res2Update.path).toBe(res2.path);

      const updatedContent2 = fs.readFileSync(res2.path, "utf8");
      expect(updatedContent2).toContain("second upper quote");
      expect(updatedContent2).not.toContain("second lower quote");
    });

    it("preserves specified colon-versus-dash collapse into the same note", async () => {
      const res1 = await processJoplinNote(
        { title: "Dune: Part One", body: "### Page 1\n==quote from colon==" },
        { booksDir, calibreDbPath: missingCalibre() },
      );
      const res2 = await processJoplinNote(
        { title: "Dune - Part One", body: "### Page 2\n==quote from dash==" },
        { booksDir, calibreDbPath: missingCalibre() },
      );

      expect(res1.action).toBe("created");
      expect(res2.action).toBe("updated");
      expect(res1.path).toBe(res2.path);

      const content = fs.readFileSync(res1.path, "utf8");
      expect(content).toContain("quote from colon");
      expect(content).toContain("quote from dash");
    });

    it("prevents Unicode case-fold collisions from clobbering or merging notes (e.g. weiss vs weiß)", async () => {
      const res1 = await processJoplinNote(
        { title: "weiss", body: "### Page 1\n==quote from weiss==" },
        { booksDir, calibreDbPath: missingCalibre() },
      );
      const res2 = await processJoplinNote(
        { title: "weiß", body: "### Page 2\n==quote from weiß==" },
        { booksDir, calibreDbPath: missingCalibre() },
      );

      expect(res1.action).toBe("created");
      expect(res2.action).toBe("created");
      expect(res1.path).not.toBe(res2.path);

      const content1 = fs.readFileSync(res1.path, "utf8");
      const content2 = fs.readFileSync(res2.path, "utf8");

      expect(content1).toContain("quote from weiss");
      expect(content1).not.toContain("quote from weiß");

      expect(content2).toContain("quote from weiß");
      expect(content2).not.toContain("quote from weiss");
    });

    it("does not steal an existing pre-numbered note when disambiguating case collisions", async () => {
      // Suppose a real book "Title (1)" already exists in the library
      const resExisting = await processJoplinNote(
        { title: "Title (1)", body: "### Page 1\n==real book one quote==" },
        { booksDir, calibreDbPath: missingCalibre() },
      );

      // And a book "title" exists
      const resLower = await processJoplinNote(
        { title: "title", body: "### Page 1\n==lower title quote==" },
        { booksDir, calibreDbPath: missingCalibre() },
      );

      // Now a new book "Title" arrives, which collides in case with "title.md".
      // It must not overwrite or merge into "Title (1).md"!
      const resUpper = await processJoplinNote(
        { title: "Title", body: "### Page 1\n==upper title quote==" },
        { booksDir, calibreDbPath: missingCalibre() },
      );

      expect(resUpper.path).not.toBe(resExisting.path);
      expect(resUpper.path).not.toBe(resLower.path);

      const existingContent = fs.readFileSync(resExisting.path, "utf8");
      expect(existingContent).toContain("real book one quote");
      expect(existingContent).not.toContain("upper title quote");

      const upperContent = fs.readFileSync(resUpper.path, "utf8");
      expect(upperContent).toContain("upper title quote");
      expect(upperContent).not.toContain("real book one quote");
    });

    it("reclaims disambiguated note on re-export with quotes and formatting variations in title", async () => {
      // 1. Lowercase note exists
      await processJoplinNote(
        { title: "something quoted", body: "### Page 1\n==lower quote==" },
        { booksDir, calibreDbPath: missingCalibre() },
      );

      // 2. Title with double quotes and extra internal whitespace arrives
      const titleWithQuotes = 'Something  "quoted"';
      const res1 = await processJoplinNote(
        { title: titleWithQuotes, body: "### Page 1\n==first quote==" },
        { booksDir, calibreDbPath: missingCalibre() },
      );
      expect(res1.action).toBe("created");
      expect(res1.path).toMatch(/Something quoted \(1\)\.md$/);

      // 3. Re-exporting the same title must update the existing (1) file, not create (2)
      const res2 = await processJoplinNote(
        { title: titleWithQuotes, body: "### Page 1\n==first quote==\n\n### Page 2\n==second quote==" },
        { booksDir, calibreDbPath: missingCalibre() },
      );
      expect(res2.action).toBe("updated");
      expect(res2.path).toBe(res1.path);

      const files = fs.readdirSync(booksDir).filter((f: string) => f.includes("Something quoted"));
      expect(files.length).toBe(1);
      expect(files[0]).toBe("Something quoted (1).md");

      const content = fs.readFileSync(res2.path, "utf8");
      expect(content).toContain("second quote");
    });

    it("does not treat body text matching title: as frontmatter ownership", async () => {
      // Plant a note with no frontmatter title, but a body mentioning title: "Target"
      const plantedPath = path.join(booksDir, "Target (1).md");
      fs.writeFileSync(
        plantedPath,
        `# Notes on something\nHere is a code snippet:\ntitle: "Target"\n\n==planted quote==\n`,
        "utf8",
      );

      // And "target" exists
      await processJoplinNote(
        { title: "target", body: "### Page 1\n==lower target==" },
        { booksDir, calibreDbPath: missingCalibre() },
      );

      // Incoming "Target" must NOT match the planted file as its own frontmatter title!
      const res = await processJoplinNote(
        { title: "Target", body: "### Page 1\n==upper target==" },
        { booksDir, calibreDbPath: missingCalibre() },
      );

      expect(res.path).not.toBe(plantedPath);
      expect(res.path).toMatch(/Target \(2\)\.md$/);

      const plantedContent = fs.readFileSync(plantedPath, "utf8");
      expect(plantedContent).toContain("planted quote");
      expect(plantedContent).not.toContain("upper target");
    });

    it("preserves canonical frontmatter title and reclaims note when updating via note id", async () => {
      // 1. Lowercase note exists
      await processJoplinNote(
        { title: "gamma notes", body: "### Page 1\n==lower gamma==" },
        { booksDir, calibreDbPath: missingCalibre() },
      );

      // 2. Disambiguated note created
      const resCreated = await processJoplinNote(
        { title: "Gamma Notes", body: "### Page 1\n==upper gamma 1==" },
        { booksDir, calibreDbPath: missingCalibre() },
      );
      expect(resCreated.id).toBe("Gamma Notes (1)");
      expect(resCreated.path).toMatch(/Gamma Notes \(1\)\.md$/);

      // 3. Client updates note using id without supplying title (PUT /notes/:id)
      const resUpdatedById = await processJoplinNote(
        { id: resCreated.id, body: "### Page 1\n==upper gamma 1==\n\n### Page 2\n==upper gamma 2==" },
        { booksDir, calibreDbPath: missingCalibre() },
      );
      expect(resUpdatedById.path).toBe(resCreated.path);

      // Frontmatter title must remain canonical "Gamma Notes", NOT "Gamma Notes (1)"
      const contentAfterIdUpdate = fs.readFileSync(resCreated.path, "utf8");
      expect(contentAfterIdUpdate).toMatch(/^title:\s*"Gamma Notes"/m);
      expect(contentAfterIdUpdate).not.toMatch(/^title:\s*"Gamma Notes \(1\)"/m);

      // 4. Later export with logical title "Gamma Notes" must still reclaim "Gamma Notes (1).md"
      const resLater = await processJoplinNote(
        { title: "Gamma Notes", body: "### Page 1\n==upper gamma 1==\n\n### Page 3\n==upper gamma 3==" },
        { booksDir, calibreDbPath: missingCalibre() },
      );
      expect(resLater.path).toBe(resCreated.path);
      expect(resLater.action).toBe("updated");

      const files = fs.readdirSync(booksDir).filter((f: string) => f.includes("Gamma Notes"));
      expect(files.length).toBe(1);
      expect(files[0]).toBe("Gamma Notes (1).md");
    });

    it("reclaims disambiguated note across NFC and NFD Unicode normalization variants", async () => {
      // 1. Lowercase note exists
      await processJoplinNote(
        { title: "café notes", body: "### Page 1\n==lower cafe==" },
        { booksDir, calibreDbPath: missingCalibre() },
      );

      // 2. Export with NFD title creates disambiguated (1) note
      const nfdTitle = "Cafe\u0301 Notes";
      const resNFD = await processJoplinNote(
        { title: nfdTitle, body: "### Page 1\n==nfd quote==" },
        { booksDir, calibreDbPath: missingCalibre() },
      );
      expect(resNFD.path).toMatch(/Café Notes \(1\)\.md$/);

      // 3. Re-export with NFC title must reclaim the same (1) note
      const nfcTitle = "Café Notes";
      const resNFC = await processJoplinNote(
        { title: nfcTitle, body: "### Page 1\n==nfd quote==\n\n### Page 2\n==nfc quote==" },
        { booksDir, calibreDbPath: missingCalibre() },
      );
      expect(resNFC.path).toBe(resNFD.path);
      expect(resNFC.action).toBe("updated");

      const files = fs.readdirSync(booksDir).filter((f: string) => f.toLowerCase().includes("notes ("));
      expect(files.length).toBe(1);
    });

    it("pins write target to existing note when updating by id even if colliding base note is deleted", async () => {
      // 1. Create base note and disambiguated note
      await processJoplinNote(
        { title: "delta notes", body: "### Page 1\n==lower delta==" },
        { booksDir, calibreDbPath: missingCalibre() },
      );
      const resUpper = await processJoplinNote(
        { title: "Delta Notes", body: "### Page 1\n==upper delta 1==" },
        { booksDir, calibreDbPath: missingCalibre() },
      );
      expect(resUpper.id).toBe("Delta Notes (1)");

      // 2. Base note "delta notes.md" is removed from disk
      fs.unlinkSync(path.join(booksDir, "delta notes.md"));

      // 3. Client updates via id "Delta Notes (1)"
      const resUpdateById = await processJoplinNote(
        { id: resUpper.id, body: "### Page 1\n==upper delta 1==\n\n### Page 2\n==upper delta 2==" },
        { booksDir, calibreDbPath: missingCalibre() },
      );
      expect(resUpdateById.path).toBe(resUpper.path);
      expect(resUpdateById.action).toBe("updated");

      // Verify the content in "Delta Notes (1).md" has both quotes and wasn't orphaned into a new "Delta Notes.md"
      const content = fs.readFileSync(resUpper.path, "utf8");
      expect(content).toContain("upper delta 1");
      expect(content).toContain("upper delta 2");
      expect(fs.existsSync(path.join(booksDir, "Delta Notes.md"))).toBe(false);
    });

    it("does not steal hand-named annotated notes like Dune (annotated) when base note is free", async () => {
      // 1. Hand-named note exists
      const annotatedPath = path.join(booksDir, "Dune (annotated).md");
      fs.writeFileSync(annotatedPath, `---\ntitle: "Dune"\n---\n# Dune (annotated)\n==manual note==\n`, "utf8");

      // 2. Incoming export for "Dune"
      const res = await processJoplinNote(
        { title: "Dune", body: "### Page 1\n==koreader quote==" },
        { booksDir, calibreDbPath: missingCalibre() },
      );

      // Must create "Dune.md", NOT overwrite or merge into "Dune (annotated).md"
      expect(res.path).toBe(path.join(fs.realpathSync(booksDir), "Dune.md"));
      expect(res.action).toBe("created");

      const annotatedContent = fs.readFileSync(annotatedPath, "utf8");
      expect(annotatedContent).not.toContain("koreader quote");
      expect(annotatedContent).toContain("manual note");
    });

    it("reclaims disambiguated note for near-NAME_MAX titles when colliding base note is deleted", async () => {
      const longTitle = "B".repeat(240);
      const resLower = await processJoplinNote(
        { title: longTitle.toLowerCase(), body: "### Page 1\n==lower long==" },
        { booksDir, calibreDbPath: missingCalibre() },
      );
      const resUpper = await processJoplinNote(
        { title: longTitle, body: "### Page 1\n==upper long 1==" },
        { booksDir, calibreDbPath: missingCalibre() },
      );
      expect(resUpper.action).toBe("created");
      expect(resUpper.path).not.toBe(resLower.path);

      // Remove colliding base note
      fs.unlinkSync(resLower.path);

      // Re-exporting upper longTitle must reclaim the existing disambiguated file rather than creating a new one
      const resReclaim = await processJoplinNote(
        { title: longTitle, body: "### Page 1\n==upper long 1==\n\n### Page 2\n==upper long 2==" },
        { booksDir, calibreDbPath: missingCalibre() },
      );
      expect(resReclaim.path).toBe(resUpper.path);
      expect(resReclaim.action).toBe("updated");
      const content = fs.readFileSync(resUpper.path, "utf8");
      expect(content).toContain("upper long 2");
    });

    it("prevents ownership poisoning when updating by id with missing FM or title echoed as id", async () => {
      // 1. Lowercase note
      await processJoplinNote(
        { title: "echo notes", body: "### Page 1\n==lower echo==" },
        { booksDir, calibreDbPath: missingCalibre() },
      );
      // 2. Disambiguated note
      const resUpper = await processJoplinNote(
        { title: "Echo Notes", body: "### Page 1\n==upper echo 1==" },
        { booksDir, calibreDbPath: missingCalibre() },
      );
      expect(resUpper.id).toBe("Echo Notes (1)");

      // Strip frontmatter from "Echo Notes (1).md" simulating manual edit or external tool
      const strippedBody = "# Echo Notes\n\n## Highlights & Notes\n<!-- lighthouse:highlights:start -->\n==upper echo 1==\n<!-- lighthouse:highlights:end -->\n";
      fs.writeFileSync(resUpper.path, strippedBody, "utf8");

      // 3. Update by id where title is omitted (PUT /notes/:id)
      const resEchoUpdate = await processJoplinNote(
        { id: resUpper.id, body: "### Page 1\n==upper echo 1==\n\n### Page 2\n==upper echo 2==" },
        { booksDir, calibreDbPath: missingCalibre() },
      );
      expect(resEchoUpdate.path).toBe(resUpper.path);

      // 4. Later export of "Echo Notes" must still reclaim "Echo Notes (1).md"
      const resLater = await processJoplinNote(
        { title: "Echo Notes", body: "### Page 1\n==upper echo 1==\n\n### Page 3\n==upper echo 3==" },
        { booksDir, calibreDbPath: missingCalibre() },
      );
      expect(resLater.path).toBe(resUpper.path);
      expect(resLater.action).toBe("updated");
    });

    it("reclaims owned disambiguated note across gaps in slot numbering", async () => {
      // 1. Lowercase note
      await processJoplinNote(
        { title: "gap title", body: "### Page 1\n==lower gap==" },
        { booksDir, calibreDbPath: missingCalibre() },
      );
      // 2. Owned note sitting at slot (7) with a gap (slots 1..6 empty or deleted)
      const ownedPath = path.join(fs.realpathSync(booksDir), "Gap Title (7).md");
      fs.writeFileSync(
        ownedPath,
        `---\ntitle: "Gap Title"\n---\n# Gap Title\n==quote 1 in slot 7==\n`,
        "utf8",
      );

      // 3. Export of "Gap Title" must reclaim "Gap Title (7).md" across the gap!
      const res = await processJoplinNote(
        { title: "Gap Title", body: "### Page 1\n==quote 1 in slot 7==\n\n### Page 2\n==quote 2==" },
        { booksDir, calibreDbPath: missingCalibre() },
      );
      expect(res.path).toBe(ownedPath);
      expect(res.action).toBe("updated");

      const content = fs.readFileSync(ownedPath, "utf8");
      expect(content).toContain("quote 2");
    });

    it("does not allow a logical title 'Title (1)' to steal an existing disambiguated note", async () => {
      // 1. Lowercase "title"
      await processJoplinNote(
        { title: "title", body: "### Page 1\n==quote lower==" },
        { booksDir, calibreDbPath: missingCalibre() },
      );

      // 2. "Title" creates "Title (1).md" with FM title: "Title"
      const resTitle = await processJoplinNote(
        { title: "Title", body: "### Page 1\n==quote Title==" },
        { booksDir, calibreDbPath: missingCalibre() },
      );
      expect(resTitle.path).toMatch(/Title \(1\)\.md$/);

      // 3. New separate book arrives whose logical title is literally "Title (1)"
      const resLiteralTitle1 = await processJoplinNote(
        { title: "Title (1)", body: "### Page 1\n==quote literal Title (1)==" },
        { booksDir, calibreDbPath: missingCalibre() },
      );

      // It must NOT overwrite or merge into "Title (1).md", but disambiguate to a separate file!
      expect(resLiteralTitle1.path).not.toBe(resTitle.path);

      const titleContent = fs.readFileSync(resTitle.path, "utf8");
      expect(titleContent).toContain("quote Title");
      expect(titleContent).not.toContain("quote literal Title (1)");

      const literalContent = fs.readFileSync(resLiteralTitle1.path, "utf8");
      expect(literalContent).toContain("quote literal Title (1)");
      expect(literalContent).not.toContain("quote Title");
    });

    it("prevents path traversal or absolute file reads via payload.id", async () => {
      // Create a secret file outside booksDir
      const tmpDir = path.dirname(booksDir);
      const secretFile = path.join(tmpDir, "secret_note.md");
      fs.writeFileSync(secretFile, `---\ntitle: "Leaked Secret"\n---\n# Secret\n`, "utf8");

      try {
        const realBooks = fs.realpathSync(booksDir);
        // Attempt relative path escape via payload.id
        const res1 = await processJoplinNote(
          { id: `../${path.basename(tmpDir)}/secret_note`, body: "### Page 1\n==test==" },
          { booksDir, calibreDbPath: missingCalibre() },
        );
        // Must not adopt the secret title or write outside booksDir
        expect(res1.title).not.toBe("Leaked Secret");
        expect(res1.path.startsWith(realBooks)).toBe(true);

        // Attempt absolute path escape via payload.id
        const res2 = await processJoplinNote(
          { id: secretFile, body: "### Page 1\n==test==" },
          { booksDir, calibreDbPath: missingCalibre() },
        );
        expect(res2.title).not.toBe("Leaked Secret");
        expect(res2.path.startsWith(realBooks)).toBe(true);
      } finally {
        try { fs.unlinkSync(secretFile); } catch (_e) { void _e; }
      }
    });

    it("collapses fullwidth colons and vertical bars to match ASCII equivalents in sanitizeTitle", () => {
      const ascii = sanitizeTitle("Re:Zero - Starting Life in Another World");
      const fullwidth = sanitizeTitle("Re：Zero - Starting Life in Another World");
      const vbar = sanitizeTitle("Re｜Zero - Starting Life in Another World");

      expect(ascii).toBe("Re - Zero - Starting Life in Another World");
      expect(fullwidth).toBe(ascii);
      expect(vbar).toBe(ascii);
    });

    it("preserves spaces between words separated by newlines and strips zero-width chars in sanitizeTitle", () => {
      const withNewlines = sanitizeTitle("Hello\nWorld\r\nAgain\tTest");
      expect(withNewlines).toBe("Hello World Again Test");

      const withZeroWidth = sanitizeTitle("Dune\u200B\uFEFF");
      expect(withZeroWidth).toBe("Dune");
    });

    it("normalizes typographic quotes and Unicode variants to prevent duplicate highlights", async () => {
      // First export with typographic/smart quotes and apostrophes
      const res1 = await processJoplinNote(
        { title: "Typographic Book", body: "### Page 1\n==It’s a “wonderful” world==\n" },
        { booksDir, calibreDbPath: missingCalibre() },
      );
      expect(res1.action).toBe("created");

      // Second export with straight quotes and apostrophes for the same quote
      const res2 = await processJoplinNote(
        { title: "Typographic Book", body: "### Page 1\n==It's a \"wonderful\" world==\n" },
        { booksDir, calibreDbPath: missingCalibre() },
      );
      expect(res2.action).toBe("updated");

      const content = fs.readFileSync(res1.path, "utf8");
      // Must not duplicate the highlight
      const matches = content.match(/wonderful/gi) || [];
      expect(matches.length).toBe(1);
    });

    it("extracts and updates annotations formatted with **Note:** without duplicating quote or stacking notes", async () => {
      const bodyWithNote = "> ==Truth is rarely pure.==\n**Note:** Initial thought";
      const key = extractQuoteKey(bodyWithNote);
      expect(key).not.toContain("initial thought");
      expect(extractAnnotation(bodyWithNote)).toBe("Initial thought");

      const res1 = await processJoplinNote(
        { title: "Wilde Notes", body: bodyWithNote },
        { booksDir, calibreDbPath: missingCalibre() },
      );
      expect(res1.action).toBe("created");

      // Re-export with updated note
      const updatedBody = "> ==Truth is rarely pure.==\n**Note:** Updated reflection";
      const res2 = await processJoplinNote(
        { title: "Wilde Notes", body: updatedBody },
        { booksDir, calibreDbPath: missingCalibre() },
      );
      expect(res2.action).toBe("updated");

      const content = fs.readFileSync(res1.path, "utf8");
      expect(content).toContain("Updated reflection");
      expect(content).not.toContain("Initial thought");
    });

    it("handles CORS OPTIONS preflight cleanly with 204 on Joplin routes", async () => {
      const req = new Request("http://localhost:8086/notes", { method: "OPTIONS" });
      const url = new URL(req.url);
      const res = await handleJoplinRequest(req, url, { expectedToken: "valid-token" });

      expect(res.status).toBe(204);
      expect(res.headers.get("Access-Control-Allow-Methods")).toContain("GET");
      expect(res.headers.get("Access-Control-Allow-Methods")).toContain("POST");
      expect(res.headers.get("Access-Control-Allow-Methods")).toContain("OPTIONS");
    });

    it("returns note body and details when GET /notes/:id is requested", async () => {
      await processJoplinNote(
        { title: "Retrievable Note", body: "### Page 1\n==some memorable quote==\n" },
        { booksDir, calibreDbPath: missingCalibre() },
      );

      const req = new Request("http://localhost:8086/notes/Retrievable%20Note?token=valid-token", {
        method: "GET",
      });
      const url = new URL(req.url);
      const res = await handleJoplinRequest(req, url, { expectedToken: "valid-token", booksDir });

      expect(res.status).toBe(200);
      const data = (await res.json()) as any;
      expect(data.id).toBe("Retrievable Note");
      expect(data.title).toBe("Retrievable Note");
      expect(data.body).toContain("some memorable quote");
    });

    it("serializes concurrent note writes to the same book path without dropping highlights", async () => {
      const p1 = processJoplinNote(
        { title: "Concurrent Book", body: "### Page 1\n==Highlight One==" },
        { booksDir, calibreDbPath: missingCalibre() },
      );
      const p2 = processJoplinNote(
        { title: "Concurrent Book", body: "### Page 2\n==Highlight Two==" },
        { booksDir, calibreDbPath: missingCalibre() },
      );

      const [r1, r2] = await Promise.all([p1, p2]);
      expect(r1.path).toBe(r2.path);

      const content = fs.readFileSync(r1.path, "utf8");
      expect(content).toContain("Highlight One");
      expect(content).toContain("Highlight Two");
    });

    it("isolates highlights in SQLite cache when two books share a title during Joplin export", async () => {
      const hCache = new Database(":memory:");
      initHighlightsTable(hCache);

      // Create a Calibre database with two distinct books sharing the title "Mythos"
      const cPath = path.join(path.dirname(booksDir), "shared-joplin-calibre.db");
      const cDb = new Database(cPath);
      cDb.run(`
        CREATE TABLE books (id INTEGER PRIMARY KEY, title TEXT);
        CREATE TABLE authors (id INTEGER PRIMARY KEY, name TEXT);
        CREATE TABLE books_authors_link (id INTEGER PRIMARY KEY, book INTEGER, author INTEGER);
      `);
      cDb.run("INSERT INTO books (id, title) VALUES (10, 'Mythos'), (20, 'Mythos');");
      cDb.run("INSERT INTO authors (id, name) VALUES (1, 'Stephen Fry'), (2, 'Homer');");
      cDb.run("INSERT INTO books_authors_link (book, author) VALUES (10, 1), (20, 2);");
      cDb.close();

      try {
        // Export Stephen Fry's book
        await processJoplinNote(
          {
            title: "Mythos",
            body: "##### Stephen Fry\n### Page 10\n==Fry quote about Zeus==",
          },
          { booksDir, calibreDbPath: cPath, cacheDb: hCache },
        );

        // Export Homer's book
        await processJoplinNote(
          {
            title: "Mythos",
            body: "##### Homer\n### Page 20\n==Homer quote about Achilles==",
          },
          { booksDir, calibreDbPath: cPath, cacheDb: hCache },
        );

        const fryHighlights = getHighlightsForBook(hCache, 10, "Mythos", 100, cPath);
        const homerHighlights = getHighlightsForBook(hCache, 20, "Mythos", 100, cPath);

        expect(fryHighlights.length).toBe(1);
        expect(fryHighlights[0].quote).toBe("Fry quote about Zeus");

        expect(homerHighlights.length).toBe(1);
        expect(homerHighlights[0].quote).toBe("Homer quote about Achilles");
      } finally {
        try { fs.unlinkSync(cPath); } catch (_e) { void _e; }
        hCache.close();
      }
    });
  });

  describe("Unit U08: Generated attribution deduplication and quote preservation", () => {
    it("reproduces and resolves E05: re-exporting with generated attribution produces exactly one highlight with correct file and indexed readback", async () => {
      const hCache = new Database(":memory:");
      initHighlightsTable(hCache);
      const notePath = path.join(booksDir, "Test.md");
      fs.writeFileSync(
        notePath,
        `# Test\n\nManual notes remain.\n\n## Highlights & Notes\n${HIGHLIGHTS_START_MARKER}\n> Gold.\n— *Chapter 1*, Page 42, 2026-09-24\n**Note:** Reflection\n${HIGHLIGHTS_END_MARKER}\n`,
      );

      const url = new URL("http://localhost:8086/notes?token=" + TEST_JOPLIN_TOKEN);
      const res = await handleJoplinRequest(
        new Request(url, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            title: "Test",
            body: "### Page 42 @ 2026-09-24\n> Gold.\n\n— *Chapter 1*\n**Note:** Reflection",
          }),
        }),
        url,
        { expectedToken: TEST_JOPLIN_TOKEN, booksDir, cacheDb: hCache },
      );
      expect(res.status).toBe(200);

      const content = fs.readFileSync(notePath, "utf8");
      expect((content.match(/> Gold\./g) || []).length).toBe(1);
      expect(content).toContain("Manual notes remain.");
      expect(content).toContain("— *Chapter 1*, Page 42, 2026-09-24");
      expect(content).toContain("**Note:** Reflection");

      const indexed = hCache
        .query("SELECT quote, note, chapter, page FROM book_highlights WHERE book_title = 'Test'")
        .all() as any[];
      expect(indexed.length).toBe(1);
      expect(indexed[0].quote).toBe("Gold.");
      expect(indexed[0].note).toBe("Reflection");
      expect(indexed[0].chapter).toBe("Chapter 1");
      expect(indexed[0].page).toBe(42);
      hCache.close();
    });

    it("preserves dash-prefixed dialogue inside quotes while deduplicating outside attribution", async () => {
      const hCache = new Database(":memory:");
      initHighlightsTable(hCache);
      const notePath = path.join(booksDir, "Dialogue Book.md");
      fs.writeFileSync(
        notePath,
        `# Dialogue Book\n\n## Highlights & Notes\n${HIGHLIGHTS_START_MARKER}\n> "Wait," he said.\n> — I don't know who you are.\n— *Chapter 1*, Page 42, 2026-09-24\n**Note:** Important revelation\n${HIGHLIGHTS_END_MARKER}\n`,
      );

      const url = new URL("http://localhost:8086/notes?token=" + TEST_JOPLIN_TOKEN);
      const res = await handleJoplinRequest(
        new Request(url, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            title: "Dialogue Book",
            body: "### Page 42 @ 2026-09-24\n> \"Wait,\" he said.\n> — I don't know who you are.\n\n— *Chapter 1*\n**Note:** Important revelation",
          }),
        }),
        url,
        { expectedToken: TEST_JOPLIN_TOKEN, booksDir, cacheDb: hCache },
      );
      expect(res.status).toBe(200);

      const content = fs.readFileSync(notePath, "utf8");
      expect((content.match(/Wait/g) || []).length).toBe(1);
      expect(content).toContain("> — I don't know who you are.");
      expect(content).toContain("— *Chapter 1*, Page 42, 2026-09-24");

      const key = extractQuoteKey('> "Wait," he said.\n> — I don\'t know who you are.\n— *Chapter 1*, Page 42');
      expect(key).toContain("i don't know who you are");
      expect(key).not.toContain("chapter 1");
      hCache.close();
    });

    it("does not blanket-skip real dash lines when quotes begin with dialogue dash without blockquotes", () => {
      const dialogueQuote = "— I don't know who you are.";
      expect(extractQuoteKey(`### Page 42\n${dialogueQuote}`)).toBe("— i don't know who you are.");
      expect(normalizeQuote(dialogueQuote)).toBe("— i don't know who you are.");
      expect(isGeneratedAttributionLine(dialogueQuote)).toBe(false);
      expect(isGeneratedAttributionLine("— *Wait*, he whispered.")).toBe(false);
      expect(isGeneratedAttributionLine("- How are you doing?")).toBe(false);
    });

    it("deduplicates multiline, short, and marked quotes across PUT and POST with attribution variations", async () => {
      const hCache = new Database(":memory:");
      initHighlightsTable(hCache);
      const opts = { expectedToken: TEST_JOPLIN_TOKEN, booksDir, cacheDb: hCache };
      const postUrl = new URL("http://localhost:8086/notes?token=" + TEST_JOPLIN_TOKEN);

      // Multiline quote
      await handleJoplinRequest(new Request(postUrl, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ title: "Multi Book", body: "> Line 1.\n> Line 2.\n— *Ch 3*, Page 77" }) }), postUrl, opts);
      const putUrl = new URL("http://localhost:8086/notes/Multi%20Book?token=" + TEST_JOPLIN_TOKEN);
      await handleJoplinRequest(new Request(putUrl, { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ title: "Multi Book", body: "### Page 77\n> Line 1.\n> Line 2.\n— *Ch 3*" }) }), putUrl, opts);
      const multi = fs.readFileSync(path.join(booksDir, "Multi Book.md"), "utf8");
      expect((multi.match(/Line 1/g) || []).length).toBe(1);

      // Short quote
      await handleJoplinRequest(new Request(postUrl, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ title: "Short Book", body: "> OK\n— Page 1" }) }), postUrl, opts);
      await handleJoplinRequest(new Request(postUrl, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ title: "Short Book", body: "### Page 1\n> OK\n— *Intro*" }) }), postUrl, opts);
      const short = fs.readFileSync(path.join(booksDir, "Short Book.md"), "utf8");
      expect((short.match(/> OK/g) || []).length).toBe(1);

      // Marked quote
      await handleJoplinRequest(new Request(postUrl, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ title: "Marked Book", body: "==Excerpt==\n— *Ch 1*, Page 5" }) }), postUrl, opts);
      await handleJoplinRequest(new Request(postUrl, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ title: "Marked Book", body: "### Page 5\n> ==Excerpt==\n— *Ch 1*" }) }), postUrl, opts);
      const marked = fs.readFileSync(path.join(booksDir, "Marked Book.md"), "utf8");
      expect((marked.match(/Excerpt/g) || []).length).toBe(1);
      hCache.close();
    });

    it("preserves existing notes when incoming export lacks annotation, and stays idempotent across repeated exports", async () => {
      const hCache = new Database(":memory:");
      initHighlightsTable(hCache);
      const opts = { expectedToken: TEST_JOPLIN_TOKEN, booksDir, cacheDb: hCache };
      const postUrl = new URL("http://localhost:8086/notes?token=" + TEST_JOPLIN_TOKEN);

      await handleJoplinRequest(new Request(postUrl, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ title: "Idempotent Book", body: "> Life quote.\n— *Apology*, Page 38\n**Note:** Deep reflection" }) }), postUrl, opts);
      await handleJoplinRequest(new Request(postUrl, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ title: "Idempotent Book", body: "### Page 38\n> Life quote.\n— *Apology*" }) }), postUrl, opts);
      await handleJoplinRequest(new Request(postUrl, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ title: "Idempotent Book", body: "### Page 38 @ 2026-03-01\n> Life quote." }) }), postUrl, opts);

      const content = fs.readFileSync(path.join(booksDir, "Idempotent Book.md"), "utf8");
      expect((content.match(/Life quote/g) || []).length).toBe(1);
      expect(content).toContain("Deep reflection");
      expect(content).toContain("— *Apology*, Page 38");
      hCache.close();
    });

    it("preserves manual headings, leading thoughts, and trailing sections outside managed markers verbatim", async () => {
      const notePath = path.join(booksDir, "Annotated Guide.md");
      fs.writeFileSync(
        notePath,
        `---\ntitle: "Annotated Guide"\nauthor: "Curator"\n---\n\n# Annotated Guide\n\n## Reader's Foreword\nPersonal thoughts before reading.\n\n## Highlights & Notes\n${HIGHLIGHTS_START_MARKER}\n> Core insight.\n— *Chapter 1*, Page 10\n${HIGHLIGHTS_END_MARKER}\n\n## Postscript & Action Items\n1. Review chapter 1 again.\n2. Discuss with colleagues.\n`,
      );

      const postUrl = new URL("http://localhost:8086/notes?token=" + TEST_JOPLIN_TOKEN);
      await handleJoplinRequest(new Request(postUrl, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ title: "Annotated Guide", body: "### Page 10\n> Core insight.\n— *Chapter 1*" }) }), postUrl, { expectedToken: TEST_JOPLIN_TOKEN, booksDir });

      const content = fs.readFileSync(notePath, "utf8");
      expect((content.match(/Core insight/g) || []).length).toBe(1);
      expect(content).toContain("## Reader's Foreword");
      expect(content).toContain("Personal thoughts before reading.");
      expect(content).toContain("## Postscript & Action Items");
      expect(content).toContain("1. Review chapter 1 again.");
    });

    it("safely serializes same-process concurrent exports to the same book note so both survive", async () => {
      const postUrl = new URL("http://localhost:8086/notes?token=" + TEST_JOPLIN_TOKEN);
      const [r1, r2] = await Promise.all([
        handleJoplinRequest(new Request(postUrl, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ title: "Concurrent Book", body: "> Quote Alpha.\n— *Ch 1*, Page 10" }) }), postUrl, { expectedToken: TEST_JOPLIN_TOKEN, booksDir }),
        handleJoplinRequest(new Request(postUrl, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ title: "Concurrent Book", body: "> Quote Beta.\n— *Ch 2*, Page 20" }) }), postUrl, { expectedToken: TEST_JOPLIN_TOKEN, booksDir }),
      ]);
      expect(r1.status).toBe(200);
      expect(r2.status).toBe(200);

      const content = fs.readFileSync(path.join(booksDir, "Concurrent Book.md"), "utf8");
      expect(content).toContain("Quote Alpha");
      expect(content).toContain("Quote Beta");
      expect((content.match(new RegExp(HIGHLIGHTS_START_MARKER, "g")) || []).length).toBe(1);
      expect((content.match(new RegExp(HIGHLIGHTS_END_MARKER, "g")) || []).length).toBe(1);
    });

    it("preserves old note on disk when atomic write or rename fails", async () => {
      const notePath = path.join(booksDir, "Resilient Book.md");
      const initialContent = `# Resilient Book\n\n## Highlights & Notes\n${HIGHLIGHTS_START_MARKER}\n> Original pristine quote.\n— *Chapter 1*, Page 1\n${HIGHLIGHTS_END_MARKER}\n`;
      fs.writeFileSync(notePath, initialContent, "utf8");

      const originalRename = fs.renameSync;
      let renameErrorThrown = false;
      fs.renameSync = ((oldP: fs.PathLike, newP: fs.PathLike) => {
        if (String(newP).includes("Resilient Book.md")) {
          renameErrorThrown = true;
          throw new Error("EACCES: permission denied during atomic swap");
        }
        return originalRename(oldP, newP);
      }) as any;

      try {
        const postUrl = new URL("http://localhost:8086/notes?token=" + TEST_JOPLIN_TOKEN);
        const res = await handleJoplinRequest(new Request(postUrl, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ title: "Resilient Book", body: "> Corrupting quote." }) }), postUrl, { expectedToken: TEST_JOPLIN_TOKEN, booksDir });
        expect(res.status).toBe(500);
      } finally {
        fs.renameSync = originalRename;
      }

      expect(renameErrorThrown).toBe(true);
      expect(fs.readFileSync(notePath, "utf8")).toBe(initialContent);
    });
  });
});
