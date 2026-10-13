import { describe, it, expect } from "bun:test";
import { spawnSync } from "node:child_process";
import path from "node:path";
import process from "node:process";
import {
  parseCliArgs,
  formatNovelIngestReport,
  runCli,
} from "./ingest-novel";
import type { NovelIngestResult } from "../uploader/novel";

const LIGHTHOUSE_BIN = path.resolve(__dirname, "../bin/lighthouse");

describe("LightHouse Web Novel CLI (scripts/ingest-novel.ts & bin/lighthouse)", () => {
  describe("1. CLI Argument Parsing (parseCliArgs)", () => {
    it("parses single positional URL argument", () => {
      const parsed = parseCliArgs(["https://www.royalroad.com/fiction/12345/sample"]);
      expect(parsed.url).toBe("https://www.royalroad.com/fiction/12345/sample");
      expect(parsed.update).toBeUndefined();
      expect(parsed.dryRun).toBeUndefined();
    });

    it("parses short and long flags for update and dry-run", () => {
      const parsed1 = parseCliArgs(["https://royalroad.com/story", "--update", "--dry-run"]);
      expect(parsed1.update).toBe(true);
      expect(parsed1.dryRun).toBe(true);

      const parsed2 = parseCliArgs(["https://royalroad.com/story", "-u", "-n"]);
      expect(parsed2.update).toBe(true);
      expect(parsed2.dryRun).toBe(true);
    });

    it("parses tags with space and equals syntax", () => {
      const parsedSpace = parseCliArgs(["https://royalroad.com/story", "--tags", "LitRPG,Fantasy"]);
      expect(parsedSpace.tags).toBe("LitRPG,Fantasy");

      const parsedEquals = parseCliArgs(["https://royalroad.com/story", "--tags=Isekai,Magic"]);
      expect(parsedEquals.tags).toBe("Isekai,Magic");

      const parsedShort = parseCliArgs(["https://royalroad.com/story", "-t", "Progression"]);
      expect(parsedShort.tags).toBe("Progression");
    });

    it("parses server URL, library path, and binary overrides", () => {
      const parsed = parseCliArgs([
        "https://royalroad.com/story",
        "--calibre-server-url",
        "http://192.168.1.50:8088",
        "--library-path",
        "/custom/calibre/library",
        "--fanficfare-bin",
        "/usr/local/bin/fanficfare",
        "--calibredb-bin",
        "/opt/homebrew/bin/calibredb",
        "--verbose",
        "--json",
      ]);

      expect(parsed.calibreServerUrl).toBe("http://192.168.1.50:8088");
      expect(parsed.libraryPath).toBe("/custom/calibre/library");
      expect(parsed.fanficfareBin).toBe("/usr/local/bin/fanficfare");
      expect(parsed.calibredbBin).toBe("/opt/homebrew/bin/calibredb");
      expect(parsed.verbose).toBe(true);
      expect(parsed.json).toBe(true);
    });

    it("parses help flags", () => {
      expect(parseCliArgs(["--help"]).help).toBe(true);
      expect(parseCliArgs(["-h"]).help).toBe(true);
    });

    it("rejects missing argument values for value-bearing options", () => {
      expect(() => parseCliArgs(["https://story.com", "--tags"])).toThrow(/requires a non-empty tags argument/);
      expect(() => parseCliArgs(["https://story.com", "--tags", "--dry-run"])).toThrow(/requires a non-empty tags argument/);
      expect(() => parseCliArgs(["https://story.com", "--tags="])).toThrow(/requires a non-empty tags argument/);

      expect(() => parseCliArgs(["https://story.com", "--calibre-server-url"])).toThrow(/requires a URL argument/);
      expect(() => parseCliArgs(["https://story.com", "--library-path"])).toThrow(/requires a path argument/);
      expect(() => parseCliArgs(["https://story.com", "--fanficfare-bin"])).toThrow(/requires an executable path argument/);
      expect(() => parseCliArgs(["https://story.com", "--calibredb-bin"])).toThrow(/requires an executable path argument/);
    });

    it("rejects unknown options", () => {
      expect(() => parseCliArgs(["https://story.com", "--invalid-option"])).toThrow(/Unknown option: --invalid-option/);
    });

    it("rejects extra unexpected positional arguments", () => {
      expect(() => parseCliArgs(["https://story1.com", "https://story2.com"])).toThrow(/Unexpected extra argument/);
    });
  });

  describe("2. Report Formatting (formatNovelIngestReport)", () => {
    it("formats dry-run preview report cleanly", () => {
      const mockResult: NovelIngestResult = {
        success: true,
        action: "dry-run",
        sourceUrl: "https://www.royalroad.com/fiction/123",
        title: "Test Novel",
        author: "Novel Author",
        chapterCount: 75,
        tags: ["webnovel", "Action"],
        isDuplicate: false,
        metadata: {
          description: "An exciting web novel adventure.",
        },
      };

      const report = formatNovelIngestReport(mockResult);
      expect(report).toContain("DRY-RUN PREVIEW");
      expect(report).toContain("Test Novel");
      expect(report).toContain("Novel Author");
      expect(report).toContain("75");
      expect(report).toContain("webnovel, Action");
      expect(report).toContain("New novel");
      expect(report).toContain("An exciting web novel adventure.");
      expect(report).toContain("No files downloaded.");
    });

    it("formats duplicate dry-run note when novel already exists", () => {
      const mockResult: NovelIngestResult = {
        success: true,
        action: "dry-run",
        sourceUrl: "https://www.royalroad.com/fiction/123",
        title: "Test Novel",
        author: "Novel Author",
        chapterCount: 80,
        isDuplicate: true,
        bookId: 99,
      };

      const report = formatNovelIngestReport(mockResult);
      expect(report).toContain("Already exists in Calibre (ID: 99)");
      expect(report).toContain("Run with --update to fetch new chapters.");
    });

    it("formats successful download report", () => {
      const mockResult: NovelIngestResult = {
        success: true,
        action: "downloaded",
        sourceUrl: "https://royalroad.com/fiction/500",
        title: "Dungeon Crawler",
        author: "Matt",
        bookId: 321,
        chapterCount: 150,
        tags: ["webnovel", "LitRPG"],
        coverExtracted: true,
        message: "Successfully ingested into Calibre",
      };

      const report = formatNovelIngestReport(mockResult);
      expect(report).toContain("SUCCESS (DOWNLOADED)");
      expect(report).toContain("Dungeon Crawler");
      expect(report).toContain("Calibre Book ID: 321");
      expect(report).toContain("Cover:           Extracted and attached to Calibre");
      expect(report).toContain("Successfully ingested into Calibre");
    });

    it("formats error report with failure details", () => {
      const mockResult: NovelIngestResult = {
        success: false,
        action: "error",
        sourceUrl: "https://royalroad.com/fiction/bad",
        error: "Site returned HTTP 404 Not Found",
      };

      const report = formatNovelIngestReport(mockResult);
      expect(report).toContain("FAILED (ERROR)");
      expect(report).toContain("Site returned HTTP 404 Not Found");
    });
  });

  describe("3. CLI In-Process Execution (runCli)", () => {
    it("returns exit code 0 on --help", async () => {
      const code = await runCli(["--help"]);
      expect(code).toBe(0);
    });

    it("returns exit code 1 when story URL is omitted", async () => {
      const code = await runCli([]);
      expect(code).toBe(1);
    });

    it("returns exit code 1 on malformed arguments", async () => {
      const code = await runCli(["--tags"]);
      expect(code).toBe(1);
    });
  });

  describe("4. Integration with bin/lighthouse Dispatcher", () => {
    it("bin/lighthouse ingest-novel --help prints full command help", () => {
      const res = spawnSync(LIGHTHOUSE_BIN, ["ingest-novel", "--help"], {
        encoding: "utf8",
      });
      expect(res.status).toBe(0);
      expect(res.stdout).toContain("LightHouse Web Novel Ingestion Tool (FanFicFare)");
      expect(res.stdout).toContain("bin/lighthouse ingest-novel <url> [options]");
      expect(res.stdout).toContain("--update, -u");
      expect(res.stdout).toContain("--tags <tags>, -t <tags>");
      expect(res.stdout).toContain("--dry-run, -n");
    });

    it("bin/lighthouse webnovel --help prints alias command help", () => {
      const res = spawnSync(LIGHTHOUSE_BIN, ["webnovel", "--help"], {
        encoding: "utf8",
      });
      expect(res.status).toBe(0);
      expect(res.stdout).toContain("LightHouse Web Novel Ingestion Tool (FanFicFare)");
    });

    it("bin/lighthouse ingest-novel without URL fails closed with helpful error", () => {
      const res = spawnSync(LIGHTHOUSE_BIN, ["ingest-novel"], {
        encoding: "utf8",
      });
      expect(res.status).toBe(1);
      expect(res.stderr).toContain("Error: Story URL is required.");
      expect(res.stderr).toContain("bin/lighthouse ingest-novel --help");
    });

    it("bin/lighthouse ingest-novel fails closed with clear diagnostic when fanficfare is missing", () => {
      const bunDir = path.dirname(process.execPath);
      const res = spawnSync(
        LIGHTHOUSE_BIN,
        ["ingest-novel", "https://www.royalroad.com/fiction/12345/sample"],
        {
          encoding: "utf8",
          env: {
            ...process.env,
            PATH: `${bunDir}:/usr/bin:/bin`,
            FANFICFARE_PATH: "",
          },
        },
      );
      expect(res.status).toBe(1);
      expect(res.stdout).toContain("FAILED (ERROR)");
      expect(res.stdout).toContain("fanficfare is not installed or not found on PATH");
    });

    it("bin/lighthouse ingest-novel --dry-run also fails closed when fanficfare is missing", () => {
      const bunDir = path.dirname(process.execPath);
      const res = spawnSync(
        LIGHTHOUSE_BIN,
        ["ingest-novel", "https://www.royalroad.com/fiction/12345/sample", "--dry-run"],
        {
          encoding: "utf8",
          env: {
            ...process.env,
            PATH: `${bunDir}:/usr/bin:/bin`,
            FANFICFARE_PATH: "",
          },
        },
      );
      expect(res.status).toBe(1);
      expect(res.stdout).toContain("FAILED (ERROR)");
      expect(res.stdout).toContain("fanficfare is not installed or not found on PATH");
    });
  });
});
