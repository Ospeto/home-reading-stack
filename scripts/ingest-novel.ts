#!/usr/bin/env bun
/**
 * scripts/ingest-novel.ts
 *
 * LightHouse FanFicFare Web Novel Ingestion CLI:
 *   - Downloads web novels/fanfics from supported sites (RoyalRoad, AO3, ScribbleHub, etc.)
 *     into clean staging location using FanFicFare.
 *   - Verifies fanficfare presence and fails closed with clear diagnostic if missing.
 *   - Adds/updates novel in Calibre library via calibredb with cover, author, chapter,
 *     and tag metadata (default includes 'webnovel').
 *   - Supports --dry-run (metadata preview without downloading) and --update (new chapters).
 */

import fs from "node:fs";
import path from "node:path";
import process from "node:process";

const novelMod: typeof import("../uploader/novel") =
  await import("../uploader/novel").catch(
    () => import("../novel" as string) as Promise<typeof import("../uploader/novel")>,
  );

const {
  ingestNovel,
  DEFAULT_CALIBRE_SERVER_URL,
  DEFAULT_TAG,
} = novelMod;

export type {
  NovelIngestOptions,
  NovelIngestResult,
  NovelMetadata,
} from "../uploader/novel";

export interface CliParsedArgs {
  url?: string;
  update?: boolean;
  tags?: string;
  dryRun?: boolean;
  verbose?: boolean;
  json?: boolean;
  calibreServerUrl?: string;
  libraryPath?: string;
  fanficfareBin?: string;
  calibredbBin?: string;
  help?: boolean;
}

export function parseCliArgs(args: string[]): CliParsedArgs {
  const result: CliParsedArgs = {};

  for (let i = 0; i < args.length; i++) {
    const a = args[i];

    if (a === "--help" || a === "-h") {
      result.help = true;
    } else if (a === "--update" || a === "-u") {
      result.update = true;
    } else if (a === "--dry-run" || a === "-n") {
      result.dryRun = true;
    } else if (a === "--verbose" || a === "-v") {
      result.verbose = true;
    } else if (a === "--json") {
      result.json = true;
    } else if (a === "--tags" || a === "-t") {
      if (i + 1 >= args.length || args[i + 1].startsWith("-")) {
        throw new Error("Error: --tags requires a non-empty tags argument.");
      }
      result.tags = args[++i];
    } else if (a.startsWith("--tags=")) {
      const val = a.slice("--tags=".length).trim();
      if (!val) throw new Error("Error: --tags requires a non-empty tags argument.");
      result.tags = val;
    } else if (a === "--calibre-server-url") {
      if (i + 1 >= args.length || args[i + 1].startsWith("-")) {
        throw new Error("Error: --calibre-server-url requires a URL argument.");
      }
      result.calibreServerUrl = args[++i];
    } else if (a.startsWith("--calibre-server-url=")) {
      const val = a.slice("--calibre-server-url=".length).trim();
      if (!val) throw new Error("Error: --calibre-server-url requires a URL argument.");
      result.calibreServerUrl = val;
    } else if (a === "--library-path") {
      if (i + 1 >= args.length || args[i + 1].startsWith("-")) {
        throw new Error("Error: --library-path requires a path argument.");
      }
      result.libraryPath = args[++i];
    } else if (a.startsWith("--library-path=")) {
      const val = a.slice("--library-path=".length).trim();
      if (!val) throw new Error("Error: --library-path requires a path argument.");
      result.libraryPath = val;
    } else if (a === "--fanficfare-bin") {
      if (i + 1 >= args.length || args[i + 1].startsWith("-")) {
        throw new Error("Error: --fanficfare-bin requires an executable path argument.");
      }
      result.fanficfareBin = args[++i];
    } else if (a.startsWith("--fanficfare-bin=")) {
      const val = a.slice("--fanficfare-bin=".length).trim();
      if (!val) throw new Error("Error: --fanficfare-bin requires an executable path argument.");
      result.fanficfareBin = val;
    } else if (a === "--calibredb-bin") {
      if (i + 1 >= args.length || args[i + 1].startsWith("-")) {
        throw new Error("Error: --calibredb-bin requires an executable path argument.");
      }
      result.calibredbBin = args[++i];
    } else if (a.startsWith("--calibredb-bin=")) {
      const val = a.slice("--calibredb-bin=".length).trim();
      if (!val) throw new Error("Error: --calibredb-bin requires an executable path argument.");
      result.calibredbBin = val;
    } else if (a.startsWith("-")) {
      throw new Error(`Unknown option: ${a}. Run with --help for usage.`);
    } else {
      // Positional argument: novel URL
      if (!result.url) {
        result.url = a;
      } else {
        throw new Error(`Unexpected extra argument: "${a}". Only one URL is supported.`);
      }
    }
  }

  return result;
}

export function printHelp(): void {
  console.log(`
LightHouse Web Novel Ingestion Tool (FanFicFare)

Downloads web serials and fanfiction from supported sites (RoyalRoad, AO3,
ScribbleHub, FanFiction.net, etc.) and ingests them into the Calibre library,
preserving covers, chapter counts, and metadata.

Usage:
  bin/lighthouse ingest-novel <url> [options]
  bin/lighthouse webnovel <url> [options]
  bun run scripts/ingest-novel.ts <url> [options]

Arguments:
  <url>                     Story URL on supported platform

Options:
  --update, -u              Update an existing downloaded EPUB with new chapters
  --tags <tags>, -t <tags>  Comma-separated tags to attach in Calibre (default includes 'webnovel')
  --dry-run, -n             Preview metadata and URL validity without downloading
  --calibre-server-url <url> Calibre server URL (default: http://127.0.0.1:8088)
  --library-path <path>     Explicit path to Calibre library folder
  --fanficfare-bin <path>   Explicit path to fanficfare executable
  --calibredb-bin <path>    Explicit path to calibredb executable
  --verbose, -v             Verbose diagnostic output
  --json                    Output report in JSON format
  --help, -h                Show this help message

Examples:
  # Preview novel metadata without downloading
  bin/lighthouse ingest-novel https://www.royalroad.com/fiction/12345/sample --dry-run

  # Download and add novel with custom tags
  bin/lighthouse ingest-novel https://archiveofourown.org/works/123456 --tags "LitRPG,Fantasy"

  # Update existing novel with newly released chapters
  bin/lighthouse ingest-novel https://www.royalroad.com/fiction/12345/sample --update
`);
}

export function formatNovelIngestReport(
  result: import("../uploader/novel").NovelIngestResult,
): string {
  const lines: string[] = [];

  if (result.action === "dry-run") {
    lines.push("========================================================================");
    lines.push("  LightHouse Web Novel Ingestion — DRY-RUN PREVIEW");
    lines.push("========================================================================");
    lines.push(`  Source URL:      ${result.sourceUrl}`);
    lines.push(`  Title:           ${result.title || "Unknown"}`);
    lines.push(`  Author:          ${result.author || "Unknown"}`);
    lines.push(`  Chapters:        ${result.chapterCount !== undefined ? result.chapterCount : "Unknown"}`);
    lines.push(`  Planned Tags:    ${result.tags?.join(", ") || DEFAULT_TAG}`);
    if (result.isDuplicate) {
      lines.push(`  Library Status:  Already exists in Calibre (ID: ${result.bookId})`);
      lines.push("  Note:            Run with --update to fetch new chapters.");
    } else {
      lines.push("  Library Status:  New novel (not currently in library)");
    }
    if (result.metadata?.description) {
      const descSnippet = result.metadata.description
        .replace(/<[^>]+>/g, " ")
        .replace(/\s+/g, " ")
        .trim()
        .slice(0, 160);
      lines.push(`  Summary:         ${descSnippet}...`);
    }
    lines.push("");
    lines.push("  [DRY-RUN] No files downloaded. Calibre library was not modified.");
    lines.push("  Run without --dry-run to execute download and library ingestion.");
    lines.push("========================================================================");
    return lines.join("\n");
  }

  lines.push("========================================================================");
  lines.push(
    `  LightHouse Web Novel Ingestion — ${result.success ? "SUCCESS" : "FAILED"} (${result.action.toUpperCase()})`,
  );
  lines.push("========================================================================");
  lines.push(`  Source URL:      ${result.sourceUrl}`);
  if (result.title) lines.push(`  Title:           ${result.title}`);
  if (result.author) lines.push(`  Author:          ${result.author}`);
  if (result.chapterCount !== undefined) {
    lines.push(`  Chapters:        ${result.chapterCount}`);
  }
  if (result.bookId) lines.push(`  Calibre Book ID: ${result.bookId}`);
  if (result.tags && result.tags.length > 0) {
    lines.push(`  Tags:            ${result.tags.join(", ")}`);
  }
  if (result.coverExtracted) {
    lines.push("  Cover:           Extracted and attached to Calibre");
  }
  if (result.message) {
    lines.push(`  Message:         ${result.message}`);
  }
  if (result.error) {
    lines.push(`  Error:           ${result.error}`);
  }
  lines.push("========================================================================");

  return lines.join("\n");
}

export async function runCli(argv: string[]): Promise<number> {
  let parsed: CliParsedArgs;
  try {
    parsed = parseCliArgs(argv);
  } catch (err: any) {
    console.error(`Error: ${err.message || err}`);
    return 1;
  }

  if (parsed.help) {
    printHelp();
    return 0;
  }

  if (!parsed.url) {
    console.error("Error: Story URL is required.");
    console.error("Run 'bin/lighthouse ingest-novel --help' for usage.");
    return 1;
  }

  try {
    const res = await ingestNovel({
      url: parsed.url,
      update: parsed.update,
      tags: parsed.tags,
      dryRun: parsed.dryRun,
      verbose: parsed.verbose,
      json: parsed.json,
      calibreServerUrl: parsed.calibreServerUrl,
      libraryDir: parsed.libraryPath,
      fanficfareBin: parsed.fanficfareBin,
      calibredbBin: parsed.calibredbBin,
    });

    if (parsed.json) {
      console.log(JSON.stringify(res, null, 2));
    } else {
      console.log(formatNovelIngestReport(res));
    }

    return res.success ? 0 : 1;
  } catch (err: any) {
    console.error(`Fatal error: ${err.message || err}`);
    return 1;
  }
}

if ((import.meta as any).main) {
  runCli(process.argv.slice(2)).then((code) => {
    process.exit(code);
  });
}
