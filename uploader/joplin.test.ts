import { describe, expect, it, beforeEach, afterEach } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  handleJoplinRequest,
  isJoplinRoute,
  validateJoplinToken,
  getJoplinToken,
  sanitizeTitle,
  normalizeQuote,
  splitHighlightEntries,
  cleanIncomingHighlightBody,
  mergeJoplinHighlights,
  isQuoteInExisting,
  processJoplinNote,
  getBookNotePath,
  JOPLIN_CLIPPER_PING_RESPONSE,
  JOPLIN_FOLDER_ID,
  JOPLIN_FOLDER_TITLE,
  HIGHLIGHTS_START_MARKER,
  HIGHLIGHTS_END_MARKER,
} from "./joplin";
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
      expect(readme).toContain("opds.wavypremium.xyz");
      expect(readme).toContain("JOPLIN_TOKEN");
      expect(readme).toContain("8443");
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
      expect(html).toContain("copyToClipboard('opds.wavypremium.xyz')");
      expect(html).not.toContain("copyToClipboard('lighthouse')");
      expect(html).toContain("JOPLIN_TOKEN");
      expect(html).toContain("8443");
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
  });
});
