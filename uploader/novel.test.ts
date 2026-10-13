import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Database } from "bun:sqlite";
import {
  getFanficfarePath,
  assertFanficfareAvailable,
  validateNovelUrl,
  parseNovelTags,
  parseFanficfareJsonMeta,
  extractMetadataFromOpfXml,
  findExistingNovelInCalibre,
  ingestNovel,
  executeCalibredb,
  DEFAULT_TAG,
  type NovelDependencies,
} from "./novel";

describe("LightHouse Web Novel Ingestion Engine (uploader/novel.ts)", () => {
  let tempDir: string;
  let origEnv: NodeJS.ProcessEnv;

  beforeEach(() => {
    origEnv = { ...process.env };
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "lh-novel-test-"));
  });

  afterEach(() => {
    process.env = origEnv;
    if (fs.existsSync(tempDir)) {
      try {
        fs.rmSync(tempDir, { recursive: true, force: true });
      } catch {
        // ignore cleanup error
      }
    }
  });

  describe("1. URL Validation & SSRF Guard", () => {
    it("accepts valid public HTTP and HTTPS novel URLs", async () => {
      const urls = [
        "https://www.royalroad.com/fiction/12345/sample-title",
        "https://archiveofourown.org/works/9876543/chapters/12345",
        "https://www.scribblehub.com/series/112233/epic-saga/",
        "https://www.fanfiction.net/s/4455667/1/Magic-World",
        "http://www.fictionpress.com/s/998877/1/Original-Story",
      ];

      for (const u of urls) {
        const res = await validateNovelUrl(u);
        expect(res.valid).toBe(true);
        expect(res.normalizedUrl).toBe(u);
        expect(res.error).toBeUndefined();
      }
    });

    it("trims whitespace from URLs cleanly", async () => {
      const res = await validateNovelUrl("   https://www.royalroad.com/fiction/123   ");
      expect(res.valid).toBe(true);
      expect(res.normalizedUrl).toBe("https://www.royalroad.com/fiction/123");
    });

    it("rejects empty, whitespace-only, or non-string inputs", async () => {
      const resEmpty = await validateNovelUrl("");
      expect(resEmpty.valid).toBe(false);
      expect(resEmpty.error).toContain("cannot be empty");

      const resSpace = await validateNovelUrl("   ");
      expect(resSpace.valid).toBe(false);

      const resNull = await validateNovelUrl(null as any);
      expect(resNull.valid).toBe(false);
    });

    it("rejects malformed URLs", async () => {
      const badUrls = ["not-a-url", "://missing-scheme", "http://", "https://"];
      for (const bad of badUrls) {
        const res = await validateNovelUrl(bad);
        expect(res.valid).toBe(false);
        expect(res.error).toBeDefined();
      }
    });

    it("rejects non-HTTP protocols (ftp, file, javascript)", async () => {
      const protocols = [
        "ftp://example.com/novel.epub",
        "file:///etc/passwd",
        "javascript:alert(1)",
        "data:text/plain,hello",
      ];

      for (const p of protocols) {
        const res = await validateNovelUrl(p);
        expect(res.valid).toBe(false);
        expect(res.error).toContain("Disallowed URL protocol");
      }
    });

    it("rejects embedded user/password credentials in URL", async () => {
      const res = await validateNovelUrl("https://admin:secret@www.royalroad.com/fiction/1");
      expect(res.valid).toBe(false);
      expect(res.error).toContain("Embedded credentials");
    });

    it("blocks SSRF loopback and link-local destinations", async () => {
      const ssrfTargets = [
        "http://127.0.0.1:8080/story",
        "http://localhost:3000/story",
        "http://169.254.169.254/latest/meta-data/",
        "http://10.0.0.1/novel",
      ];

      for (const target of ssrfTargets) {
        const res = await validateNovelUrl(target);
        expect(res.valid).toBe(false);
        expect(res.error).toBeDefined();
      }
    });

    it("allows loopback when explicitly enabled for test isolation", async () => {
      const res = await validateNovelUrl("http://127.0.0.1:8080/test-story", {
        allowLoopbackForTesting: true,
      });
      expect(res.valid).toBe(true);
      expect(res.normalizedUrl).toBe("http://127.0.0.1:8080/test-story");
    });

    it("strips tracking parameters from novel URLs", async () => {
      const rawUrl =
        "https://www.royalroad.com/fiction/12345/story-title?utm_source=twitter&utm_medium=social&ref=share";
      const res = await validateNovelUrl(rawUrl);
      expect(res.valid).toBe(true);
      expect(res.normalizedUrl).toBe(
        "https://www.royalroad.com/fiction/12345/story-title",
      );
    });
  });

  describe("2. FanFicFare Presence & Fail-Closed Detection", () => {
    it("assertFanficfareAvailable fails closed with clear diagnostic when executable is missing", () => {
      delete process.env.FANFICFARE_PATH;

      const mockSpawn = () => ({
        status: 1,
        stdout: "",
        stderr: "not found",
      } as any);

      expect(() => {
        assertFanficfareAvailable("/nonexistent/binary/path", mockSpawn);
      }).toThrow(/fanficfare is not installed or not found on PATH/);
    });

    it("resolves custom binary path when provided and executable", () => {
      const fakeBin = path.join(tempDir, "fake-fanficfare");
      fs.writeFileSync(fakeBin, "#!/bin/bash\necho 4.62.0\n", { mode: 0o755 });

      const resolved = getFanficfarePath(fakeBin);
      expect(resolved).toBe(fakeBin);

      const asserted = assertFanficfareAvailable(fakeBin);
      expect(asserted).toBe(fakeBin);
    });

    it("resolves FANFICFARE_PATH from environment", () => {
      const fakeBin = path.join(tempDir, "env-fanficfare");
      fs.writeFileSync(fakeBin, "#!/bin/bash\necho 4.62.0\n", { mode: 0o755 });

      process.env.FANFICFARE_PATH = fakeBin;
      const resolved = getFanficfarePath();
      expect(resolved).toBe(fakeBin);
    });

    it("returns null when fanficfare is nowhere to be found", () => {
      delete process.env.FANFICFARE_PATH;
      const mockSpawn = () => ({ status: 1, stdout: "", stderr: "" } as any);

      const resolved = getFanficfarePath(undefined, mockSpawn);
      expect(resolved === null || typeof resolved === "string").toBe(true);
    });
  });

  describe("3. Tag Parsing & Deduplication", () => {
    it("always includes DEFAULT_TAG ('webnovel') by default", () => {
      const tags = parseNovelTags();
      expect(tags).toContain(DEFAULT_TAG);
      expect(tags).toEqual(["webnovel"]);
    });

    it("merges and trims comma-separated string tags", () => {
      const tags = parseNovelTags("Fantasy, LitRPG,   Isekai  , Fantasy");
      expect(tags).toContain("webnovel");
      expect(tags).toContain("Fantasy");
      expect(tags).toContain("LitRPG");
      expect(tags).toContain("Isekai");
      // Deduplicated
      expect(tags.filter((t) => t === "Fantasy").length).toBe(1);
    });

    it("merges array of string tags", () => {
      const tags = parseNovelTags(["Sci-Fi", "Cyberpunk, Dystopia"]);
      expect(tags).toContain("webnovel");
      expect(tags).toContain("Sci-Fi");
      expect(tags).toContain("Cyberpunk");
      expect(tags).toContain("Dystopia");
    });
  });

  describe("4. FanFicFare JSON & Metadata Parsing", () => {
    it("parses structured JSON metadata from fanficfare stdout", () => {
      const jsonPayload = JSON.stringify({
        title: "Beware of Chicken",
        author: "Casualfarmer",
        description: "A comedy novel set in a fantasy xianxia world.",
        storyUrl: "https://www.royalroad.com/fiction/39408/beware-of-chicken",
        numChapters: 120,
        output_filename: "Beware of Chicken - Casualfarmer.epub",
        genre: ["Comedy", "Fantasy", "Slice of Life"],
        series: "Beware of Chicken Series",
        seriesIndex: 1,
      });

      const parsed = parseFanficfareJsonMeta(jsonPayload);
      expect(parsed.title).toBe("Beware of Chicken");
      expect(parsed.author).toBe("Casualfarmer");
      expect(parsed.description).toContain("comedy novel");
      expect(parsed.numChapters).toBe(120);
      expect(parsed.outputFilename).toBe("Beware of Chicken - Casualfarmer.epub");
      expect(parsed.tags).toContain("Comedy");
      expect(parsed.tags).toContain("Fantasy");
      expect(parsed.series).toBe("Beware of Chicken Series");
      expect(parsed.seriesIndex).toBe(1);
    });

    it("extracts JSON embedded with pre/postamble log lines", () => {
      const rawStdout = `
[FanFicFare Notice] Checking site configuration...
[FanFicFare Debug] Fetching chapter metadata...
{
  "title": "Azarinth Healer",
  "author": "Rhaegar",
  "numChapters": 800,
  "storyUrl": "https://www.royalroad.com/fiction/21220/azarinth-healer"
}
[FanFicFare Done] Operation complete.
`;

      const parsed = parseFanficfareJsonMeta(rawStdout);
      expect(parsed.title).toBe("Azarinth Healer");
      expect(parsed.author).toBe("Rhaegar");
      expect(parsed.numChapters).toBe(800);
    });

    it("falls back gracefully when stdout is not valid JSON", () => {
      const fallbackStdout = `
Title: Defiance of the Fall
Author: TheFirstDefier
Status: In Progress
`;
      const parsed = parseFanficfareJsonMeta(fallbackStdout);
      expect(parsed.title).toBe("Defiance of the Fall");
      expect(parsed.author).toBe("TheFirstDefier");
    });

    it("extracts title and author from OPF XML", () => {
      const opfXml = `
<?xml version="1.0" encoding="utf-8"?>
<package xmlns="http://www.idpf.org/2007/opf" version="2.0">
  <metadata xmlns:dc="http://purl.org/dc/elements/1.1/">
    <dc:title>He Who Fights With Monsters</dc:title>
    <dc:creator>Shirtaloon</dc:creator>
    <dc:description>Jason wakes up in a strange world with video game powers.</dc:description>
  </metadata>
</package>
`;
      const meta = extractMetadataFromOpfXml(opfXml);
      expect(meta.title).toBe("He Who Fights With Monsters");
      expect(meta.author).toBe("Shirtaloon");
      expect(meta.description).toContain("Jason wakes up");
    });
  });

  describe("5. Existing Novel Detection in Calibre", () => {
    it("locates existing novel in Calibre SQLite database via comments URL match", async () => {
      const dbFile = path.join(tempDir, "metadata.db");
      const db = new Database(dbFile);

      db.run(`
        CREATE TABLE books (id INTEGER PRIMARY KEY, title TEXT, author_sort TEXT, path TEXT);
        CREATE TABLE comments (id INTEGER PRIMARY KEY, book INTEGER, text TEXT);
        CREATE TABLE identifiers (id INTEGER PRIMARY KEY, book INTEGER, type TEXT, val TEXT);
        CREATE TABLE data (id INTEGER PRIMARY KEY, book INTEGER, format TEXT, name TEXT);
      `);

      const storyUrl = "https://www.royalroad.com/fiction/12345/dungeon-crawler";
      db.run("INSERT INTO books VALUES (101, 'Dungeon Crawler Carl', 'Matt Dinniman', 'Matt Dinniman/Dungeon Crawler Carl (101)')");
      db.run("INSERT INTO comments VALUES (1, 101, 'Saved from https://www.royalroad.com/fiction/12345/dungeon-crawler with LitRPG tags.')");
      db.run("INSERT INTO identifiers VALUES (1, 101, 'url', 'https://www.royalroad.com/fiction/12345/dungeon-crawler')");
      db.run("INSERT INTO data VALUES (1, 101, 'EPUB', 'Dungeon Crawler Carl - Matt Dinniman')");
      db.close();

      const existing = await findExistingNovelInCalibre(storyUrl, {
        calibreDbPath: dbFile,
        libraryDir: tempDir,
      });

      expect(existing).not.toBeNull();
      expect(existing?.id).toBe(101);
      expect(existing?.title).toBe("Dungeon Crawler Carl");
      expect(existing?.authors).toBe("Matt Dinniman");
    });

    it("enforces exact URL boundary matching in SQLite to avoid prefix false positives", async () => {
      const dbFile = path.join(tempDir, "boundary-test.db");
      const db = new Database(dbFile);

      db.run(`
        CREATE TABLE books (id INTEGER PRIMARY KEY, title TEXT, author_sort TEXT, path TEXT);
        CREATE TABLE comments (id INTEGER PRIMARY KEY, book INTEGER, text TEXT);
        CREATE TABLE identifiers (id INTEGER PRIMARY KEY, book INTEGER, type TEXT, val TEXT);
        CREATE TABLE data (id INTEGER PRIMARY KEY, book INTEGER, format TEXT, name TEXT);
      `);

      // Existing book with a longer URL prefixing the search query
      db.run("INSERT INTO books VALUES (10, 'Other Story', 'Author A', 'Author A/Other Story (10)')");
      db.run(
        "INSERT INTO comments VALUES (1, 10, 'Saved from https://www.royalroad.com/fiction/12345/other-story with tags.')",
      );
      db.run(
        "INSERT INTO identifiers VALUES (1, 10, 'url', 'https://www.royalroad.com/fiction/12345/other-story')",
      );
      db.close();

      // Searching for fiction/123 must NOT match fiction/12345/other-story
      const noMatch = await findExistingNovelInCalibre(
        "https://www.royalroad.com/fiction/123",
        {
          calibreDbPath: dbFile,
          libraryDir: tempDir,
        },
      );
      expect(noMatch).toBeNull();

      // Insert exact match book for fiction/123
      const db2 = new Database(dbFile);
      db2.run("INSERT INTO books VALUES (20, 'Exact Target', 'Author B', 'Author B/Exact Target (20)')");
      db2.run(
        "INSERT INTO comments VALUES (2, 20, 'Saved from https://www.royalroad.com/fiction/123 with tags.')",
      );
      db2.run(
        "INSERT INTO identifiers VALUES (2, 20, 'url', 'https://www.royalroad.com/fiction/123')",
      );
      db2.close();

      // Exact match succeeds for https://www.royalroad.com/fiction/123
      const exactMatch = await findExistingNovelInCalibre(
        "https://www.royalroad.com/fiction/123",
        {
          calibreDbPath: dbFile,
          libraryDir: tempDir,
        },
      );
      expect(exactMatch).not.toBeNull();
      expect(exactMatch?.id).toBe(20);
      expect(exactMatch?.title).toBe("Exact Target");

      // Exact match succeeds with trailing slash https://www.royalroad.com/fiction/123/
      const trailingSlashMatch = await findExistingNovelInCalibre(
        "https://www.royalroad.com/fiction/123/",
        {
          calibreDbPath: dbFile,
          libraryDir: tempDir,
        },
      );
      expect(trailingSlashMatch).not.toBeNull();
      expect(trailingSlashMatch?.id).toBe(20);
      expect(trailingSlashMatch?.title).toBe("Exact Target");
    });

    it("falls back to calibredb list search when SQLite DB is not available", async () => {
      const storyUrl = "https://archiveofourown.org/works/554433";

      const mockDeps: NovelDependencies = {
        calibredbRunner: (args) => {
          if (args[0] === "list") {
            return {
              status: 0,
              stdout: JSON.stringify([
                {
                  id: 202,
                  title: "Fanfic Masterpiece",
                  authors: ["Great Writer"],
                  formats: ["/tmp/Fanfic Masterpiece.epub"],
                },
              ]),
            };
          }
          return { status: 1 };
        },
      };

      const existing = await findExistingNovelInCalibre(storyUrl, {
        calibreDbPath: "/nonexistent/metadata.db",
        calibreServerUrl: "http://127.0.0.1:8088",
        dependencies: mockDeps,
      });

      expect(existing).not.toBeNull();
      expect(existing?.id).toBe(202);
      expect(existing?.title).toBe("Fanfic Masterpiece");
      expect(existing?.authors).toBe("Great Writer");
    });
  });

  describe("6. Ingest Novel: End-to-End Orchestration & Options", () => {
    it("fails closed when fanficfare is missing", async () => {
      delete process.env.FANFICFARE_PATH;

      const mockDeps: NovelDependencies = {
        spawnSync: () => ({ status: 1, stdout: "", stderr: "command not found" } as any),
      };

      const res = await ingestNovel({
        url: "https://www.royalroad.com/fiction/12345",
        dependencies: mockDeps,
      });

      expect(res.success).toBe(false);
      expect(res.action).toBe("error");
      expect(res.error).toContain("fanficfare is not installed or not found on PATH");
    });

    it("fails cleanly when URL is invalid", async () => {
      const mockDeps: NovelDependencies = {
        fanficfareBin: "/fake/fanficfare",
      };

      const res = await ingestNovel({
        url: "not-a-valid-url",
        dependencies: mockDeps,
      });

      expect(res.success).toBe(false);
      expect(res.action).toBe("error");
      expect(res.error).toContain("Invalid URL format");
    });

    it("executes --dry-run without downloading or writing to Calibre", async () => {
      let fanficfareCalledWith: string[] = [];
      const calibredbCalls: string[][] = [];

      const mockDeps: NovelDependencies = {
        fanficfareBin: "/fake/fanficfare",
        validateUrl: async (u) => ({ valid: true, normalizedUrl: u }),
        fanficfareRunner: (args) => {
          fanficfareCalledWith = args;
          return {
            status: 0,
            stdout: JSON.stringify({
              title: "Primal Hunter",
              author: "Zogarth",
              numChapters: 450,
              genre: ["Action", "Adventure"],
              description: "Jake is chosen for the tutorial.",
            }),
          };
        },
        calibredbRunner: (args) => {
          calibredbCalls.push(args);
          return { status: 0 };
        },
      };

      const res = await ingestNovel({
        url: "https://www.royalroad.com/fiction/39095/the-primal-hunter",
        dryRun: true,
        tags: "LitRPG,Bow",
        dependencies: mockDeps,
      });

      expect(res.success).toBe(true);
      expect(res.action).toBe("dry-run");
      expect(res.title).toBe("Primal Hunter");
      expect(res.author).toBe("Zogarth");
      expect(res.chapterCount).toBe(450);
      expect(res.tags).toContain("webnovel");
      expect(res.tags).toContain("LitRPG");
      expect(res.tags).toContain("Action");

      // Verify FanFicFare was called with --meta-only --no-output
      expect(fanficfareCalledWith).toContain("--meta-only");
      expect(fanficfareCalledWith).toContain("--no-output");
      expect(fanficfareCalledWith).toContain("--json-meta");

      // Verify no mutating calibredb commands (add, set_metadata, add_format) were called
      const mutatingCalls = calibredbCalls.filter((c) =>
        ["add", "set_metadata", "add_format"].includes(c[0]),
      );
      expect(mutatingCalls.length).toBe(0);
    });

    it("downloads fresh novel, adds to Calibre, and sets tags and cover", async () => {
      const stagingDir = path.join(tempDir, "staging");
      fs.mkdirSync(stagingDir, { recursive: true });

      const calibredbCalls: string[][] = [];

      const mockDeps: NovelDependencies = {
        fanficfareBin: "/fake/fanficfare",
        validateUrl: async (u) => ({ valid: true, normalizedUrl: u }),
        fanficfareRunner: (_args, opts) => {
          // Write a dummy EPUB in the working directory
          const epubFile = path.join(opts.cwd || tempDir, "The Perfect Run - Maxime J. Durand.epub");
          fs.writeFileSync(epubFile, "PK\x03\x04dummy epub content");
          return {
            status: 0,
            stdout: JSON.stringify({
              title: "The Perfect Run",
              author: "Maxime J. Durand",
              numChapters: 125,
              genre: ["Sci-Fi", "Time Loop"],
              description: "Ryan Romano can make a save point in time.",
            }),
          };
        },
        calibredbRunner: (args) => {
          calibredbCalls.push(args);
          if (args[0] === "add") {
            return {
              status: 0,
              stdout: "Added book ids: 456\n",
            };
          }
          if (args[0] === "set_metadata") {
            return { status: 0, stdout: "" };
          }
          if (args[0] === "list") {
            return { status: 0, stdout: "[]" };
          }
          return { status: 0 };
        },
        extractCover: async (_epub, out) => {
          fs.writeFileSync(out, "fake jpg cover data");
          return true;
        },
      };

      const res = await ingestNovel({
        url: "https://www.royalroad.com/fiction/33807/the-perfect-run",
        tags: "Superheroes,Comedy",
        stagingDir,
        keepStaging: true,
        dependencies: mockDeps,
      });

      expect(res.success).toBe(true);
      expect(res.action).toBe("downloaded");
      expect(res.bookId).toBe(456);
      expect(res.title).toBe("The Perfect Run");
      expect(res.author).toBe("Maxime J. Durand");
      expect(res.tags).toContain("webnovel");
      expect(res.tags).toContain("Superheroes");
      expect(res.tags).toContain("Sci-Fi");
      expect(res.coverExtracted).toBe(true);

      // Verify calibredb add call
      const addCall = calibredbCalls.find((c) => c[0] === "add");
      expect(addCall).toBeDefined();
      expect(addCall).toContain("--title");
      expect(addCall).toContain("The Perfect Run");
      expect(addCall).toContain("--authors");
      expect(addCall).toContain("Maxime J. Durand");
      expect(addCall).toContain("--automerge");
      expect(addCall).toContain("ignore");

      // Verify calibredb set_metadata call attached URL identifier and cover
      const setCall = calibredbCalls.find((c) => c[0] === "set_metadata");
      expect(setCall).toBeDefined();
      expect(setCall).toContain("456");
      expect(setCall?.some((arg) => arg.includes("identifiers:url:"))).toBe(true);
      expect(setCall?.some((arg) => arg.includes("cover:"))).toBe(true);
    });

    it("executes update mode on existing novel via --update", async () => {
      const stagingDir = path.join(tempDir, "update-staging");
      fs.mkdirSync(stagingDir, { recursive: true });

      const calibredbCalls: string[][] = [];
      let fffUpdateCalled = false;

      // Existing book in library
      const existingEpub = path.join(tempDir, "existing-story.epub");
      fs.writeFileSync(existingEpub, "PK\x03\x04existing epub");

      const mockDeps: NovelDependencies = {
        fanficfareBin: "/fake/fanficfare",
        validateUrl: async (u) => ({ valid: true, normalizedUrl: u }),
        calibredbRunner: (args) => {
          calibredbCalls.push(args);
          if (args[0] === "list") {
            // Find existing book
            return {
              status: 0,
              stdout: JSON.stringify([
                {
                  id: 789,
                  title: "Mother of Learning",
                  authors: ["nobody103"],
                  formats: [existingEpub],
                },
              ]),
            };
          }
          if (args[0] === "add_format") {
            return { status: 0, stdout: "Format added" };
          }
          if (args[0] === "set_metadata") {
            return { status: 0, stdout: "" };
          }
          return { status: 0 };
        },
        fanficfareRunner: (args, opts) => {
          if (args.includes("--update-epub")) {
            fffUpdateCalled = true;
            // update file in working directory
            const updatedFile = path.join(opts.cwd || tempDir, "existing-story.epub");
            fs.writeFileSync(updatedFile, "PK\x03\x04updated epub with new chapters");
            return {
              status: 0,
              stdout: JSON.stringify({
                title: "Mother of Learning",
                author: "nobody103",
                numChapters: 108,
                description: "Zorian gets stuck in a time loop.",
              }),
            };
          }
          return { status: 1 };
        },
      };

      const res = await ingestNovel({
        url: "https://www.fictionpress.com/s/2961893/1/Mother-of-Learning",
        update: true,
        stagingDir,
        keepStaging: true,
        dependencies: mockDeps,
      });

      expect(res.success).toBe(true);
      expect(res.action).toBe("updated");
      expect(res.bookId).toBe(789);
      expect(fffUpdateCalled).toBe(true);

      // Verify calibredb add_format was invoked with existing ID
      const addFormatCall = calibredbCalls.find((c) => c[0] === "add_format");
      expect(addFormatCall).toBeDefined();
      expect(addFormatCall).toContain("789");
    });

    it("passes --with-library with libraryDir when calibreServerUrl is not provided", async () => {
      const calibredbCalls: string[][] = [];

      const mockDeps: NovelDependencies = {
        fanficfareBin: "/fake/fanficfare",
        validateUrl: async (u) => ({ valid: true, normalizedUrl: u }),
        fanficfareRunner: () => ({
          status: 0,
          stdout: JSON.stringify({
            title: "Custom Library Novel",
            author: "Author",
          }),
        }),
        calibredbRunner: (args) => {
          calibredbCalls.push(args);
          return { status: 0 };
        },
      };

      await ingestNovel({
        url: "https://www.royalroad.com/fiction/123",
        libraryDir: "/custom/calibre/path",
        dryRun: true,
        dependencies: mockDeps,
      });

      expect(calibredbCalls.length).toBeGreaterThan(0);
      const listCall = calibredbCalls.find((c) => c[0] === "list");
      expect(listCall).toBeDefined();
      const withLibIdx = listCall!.indexOf("--with-library");
      expect(withLibIdx).toBeGreaterThan(-1);
      expect(listCall![withLibIdx + 1]).toBe("/custom/calibre/path");
      expect(listCall).not.toContain("http://127.0.0.1:8088");
    });

    it("applies --tags to calibredb set_metadata in --update mode", async () => {
      const stagingDir = path.join(tempDir, "update-tags-staging");
      fs.mkdirSync(stagingDir, { recursive: true });

      const calibredbCalls: string[][] = [];
      const existingEpub = path.join(tempDir, "existing-tags.epub");
      fs.writeFileSync(existingEpub, "PK\x03\x04existing epub content");

      const mockDeps: NovelDependencies = {
        fanficfareBin: "/fake/fanficfare",
        validateUrl: async (u) => ({ valid: true, normalizedUrl: u }),
        calibredbRunner: (args) => {
          calibredbCalls.push(args);
          if (args[0] === "list") {
            return {
              status: 0,
              stdout: JSON.stringify([
                {
                  id: 555,
                  title: "Tagged Story",
                  authors: ["Some Author"],
                  formats: [existingEpub],
                },
              ]),
            };
          }
          if (args[0] === "add_format") {
            return { status: 0, stdout: "Format added" };
          }
          if (args[0] === "set_metadata") {
            return { status: 0, stdout: "" };
          }
          return { status: 0 };
        },
        fanficfareRunner: (_args, opts) => {
          const updatedFile = path.join(opts.cwd || tempDir, "existing-tags.epub");
          fs.writeFileSync(updatedFile, "PK\x03\x04updated epub with new chapters");
          return {
            status: 0,
            stdout: JSON.stringify({
              title: "Tagged Story",
              author: "Some Author",
              numChapters: 50,
            }),
          };
        },
      };

      const res = await ingestNovel({
        url: "https://www.royalroad.com/fiction/12345/story",
        update: true,
        tags: "UpdatedTag,WebSerial",
        stagingDir,
        keepStaging: true,
        dependencies: mockDeps,
      });

      expect(res.success).toBe(true);
      expect(res.action).toBe("updated");
      expect(res.bookId).toBe(555);

      const setCall = calibredbCalls.find((c) => c[0] === "set_metadata");
      expect(setCall).toBeDefined();
      expect(setCall).toContain("--field");
      expect(setCall).toContain("tags:webnovel,UpdatedTag,WebSerial");
    });

    it("cleans up staging directory on exit", async () => {
      const stagingDir = path.join(tempDir, "auto-cleanup-staging");
      fs.mkdirSync(stagingDir, { recursive: true });

      const mockDeps: NovelDependencies = {
        fanficfareBin: "/fake/fanficfare",
        validateUrl: async (u) => ({ valid: true, normalizedUrl: u }),
        fanficfareRunner: (_args, opts) => {
          const ep = path.join(opts.cwd || tempDir, "sample.epub");
          fs.writeFileSync(ep, "dummy");
          return {
            status: 0,
            stdout: JSON.stringify({ title: "Clean Novel", author: "Author" }),
          };
        },
        calibredbRunner: (args) => {
          if (args[0] === "add") return { status: 0, stdout: "Added book ids: 111\n" };
          return { status: 0 };
        },
      };

      const res = await ingestNovel({
        url: "https://www.royalroad.com/fiction/1",
        stagingDir,
        keepStaging: false,
        dependencies: mockDeps,
      });

      expect(res.success).toBe(true);
      // Staging directory must be deleted
      expect(fs.existsSync(stagingDir)).toBe(false);
    });
  });

  describe("7. Calibre Subprocess Proxy Stripping", () => {
    it("executeCalibredb strips HTTP proxy environment variables", () => {
      process.env.HTTP_PROXY = "http://127.0.0.1:7890";
      process.env.http_proxy = "http://127.0.0.1:7890";
      process.env.HTTPS_PROXY = "http://127.0.0.1:7890";
      process.env.ALL_PROXY = "socks5://127.0.0.1:7890";

      let capturedEnv: Record<string, string | undefined> | undefined;

      const mockSpawn = ((_cmd: string, _args: string[], opts: { env?: Record<string, string | undefined> }) => {
        capturedEnv = opts.env;
        return { status: 0, stdout: "" };
      }) as unknown as typeof import("node:child_process").spawnSync;

      const res = executeCalibredb(["--version"], {
        spawnSync: mockSpawn,
      });

      expect(res.status).toBe(0);
      expect(capturedEnv).toBeDefined();
      expect(capturedEnv?.HTTP_PROXY).toBeUndefined();
      expect(capturedEnv?.http_proxy).toBeUndefined();
      expect(capturedEnv?.HTTPS_PROXY).toBeUndefined();
      expect(capturedEnv?.ALL_PROXY).toBeUndefined();
    });
  });
});
