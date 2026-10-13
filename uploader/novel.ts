import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { spawnSync } from "node:child_process";
import { Database } from "bun:sqlite";
import { validateUrlForSSRF } from "./security";
import { resolveBookLanguageAndTags } from "./jev-shelf";
import { extractCoverFromEpub } from "../scripts/heal-volume-covers";

export const DEFAULT_CALIBRE_SERVER_URL =
  process.env.CALIBRE_SERVER_URL || "http://127.0.0.1:8088";

export const DEFAULT_TAG = "webnovel";

/**
 * Locate the calibredb executable.
 */
export function getCalibredbPath(
  customBin?: string,
  runner?: typeof spawnSync,
): string {
  if (customBin && customBin.trim()) return customBin.trim();
  if (process.env.CALIBREDB_PATH && process.env.CALIBREDB_PATH.trim()) {
    return process.env.CALIBREDB_PATH.trim();
  }
  const runSync = runner || spawnSync;
  const probe = runSync("which", ["calibredb"], { encoding: "utf8" });
  if (probe.status === 0 && probe.stdout?.trim()) return probe.stdout.trim();
  const candidates = [
    "/opt/homebrew/bin/calibredb",
    "/usr/local/bin/calibredb",
    "/usr/bin/calibredb",
    "/Applications/calibre.app/Contents/MacOS/calibredb",
  ];
  for (const cand of candidates) {
    if (fs.existsSync(cand)) return cand;
  }
  return "calibredb";
}

export interface NovelDependencies {
  spawnSync?: typeof spawnSync;
  fanficfareRunner?: (
    args: string[],
    options: { cwd?: string; env?: Record<string, string>; timeout?: number },
  ) => {
    status: number | null;
    stdout?: string;
    stderr?: string;
    error?: Error;
  };
  calibredbRunner?: (
    args: string[],
    options?: { timeoutMs?: number },
  ) => {
    status: number | null;
    stdout?: string;
    stderr?: string;
    error?: Error;
  };
  fanficfareBin?: string;
  calibredbBin?: string;
  extractCover?: (epubPath: string, outputPath: string) => Promise<boolean>;
  validateUrl?: typeof validateNovelUrl;
}

export interface NovelIngestOptions {
  url: string;
  update?: boolean;
  tags?: string[] | string;
  dryRun?: boolean;
  verbose?: boolean;
  json?: boolean;
  calibreServerUrl?: string;
  calibreDbPath?: string;
  libraryDir?: string;
  fanficfareBin?: string;
  calibredbBin?: string;
  stagingDir?: string;
  keepStaging?: boolean;
  dependencies?: NovelDependencies;
}

export interface NovelMetadata {
  title?: string;
  author?: string;
  description?: string;
  storyUrl?: string;
  numChapters?: number;
  outputFilename?: string;
  tags?: string[];
  series?: string;
  seriesIndex?: number;
  raw?: Record<string, unknown>;
}

export interface NovelIngestResult {
  success: boolean;
  action: "downloaded" | "updated" | "dry-run" | "error" | "skipped";
  title?: string;
  author?: string;
  bookId?: number;
  chapterCount?: number;
  sourceUrl: string;
  epubPath?: string;
  coverExtracted?: boolean;
  tags?: string[];
  isDuplicate?: boolean;
  message?: string;
  error?: string;
  metadata?: NovelMetadata;
}

/**
 * Locate the fanficfare executable.
 * Checks custom path, FANFICFARE_PATH environment variable, PATH, and standard system paths.
 */
export function getFanficfarePath(
  customBin?: string,
  runner?: typeof spawnSync,
): string | null {
  const runSync = runner || spawnSync;

  if (customBin && customBin.trim()) {
    const trimmed = customBin.trim();
    if (fs.existsSync(trimmed)) return trimmed;
    const probe = runSync("which", [trimmed], { encoding: "utf8" });
    if (probe.status === 0 && probe.stdout?.trim()) {
      return probe.stdout.trim();
    }
  }

  if (process.env.FANFICFARE_PATH && process.env.FANFICFARE_PATH.trim()) {
    const envPath = process.env.FANFICFARE_PATH.trim();
    if (fs.existsSync(envPath)) return envPath;
    const probe = runSync("which", [envPath], { encoding: "utf8" });
    if (probe.status === 0 && probe.stdout?.trim()) {
      return probe.stdout.trim();
    }
  }

  const probe = runSync("which", ["fanficfare"], { encoding: "utf8" });
  if (probe.status === 0 && probe.stdout?.trim()) {
    return probe.stdout.trim();
  }

  const home = process.env.HOME || "";
  const candidates = [
    "/opt/homebrew/bin/fanficfare",
    "/usr/local/bin/fanficfare",
    "/usr/bin/fanficfare",
    path.join(home, ".local/bin/fanficfare"),
    path.join(home, "Library/Python/3.13/bin/fanficfare"),
    path.join(home, "Library/Python/3.12/bin/fanficfare"),
    path.join(home, "Library/Python/3.11/bin/fanficfare"),
    path.join(home, "Library/Python/3.10/bin/fanficfare"),
    path.join(home, "Library/Python/3.9/bin/fanficfare"),
  ];

  for (const cand of candidates) {
    if (cand && fs.existsSync(cand)) {
      return cand;
    }
  }

  return null;
}

/**
 * Verify fanficfare presence and fail closed with a clear diagnostic if missing.
 */
export function assertFanficfareAvailable(
  customBin?: string,
  runner?: typeof spawnSync,
): string {
  const resolved = getFanficfarePath(customBin, runner);
  if (!resolved) {
    throw new Error(
      "fanficfare is not installed or not found on PATH. Install it via 'pip install fanficfare' or ensure it is accessible on PATH.",
    );
  }
  return resolved;
}

/**
 * Validate and normalize story URL.
 * Enforces HTTP/HTTPS protocol, checks for SSRF, and strips tracking parameters.
 */
export async function validateNovelUrl(
  inputUrl: string,
  options: { allowLoopbackForTesting?: boolean } = {},
): Promise<{ valid: boolean; normalizedUrl?: string; error?: string }> {
  if (!inputUrl || typeof inputUrl !== "string" || !inputUrl.trim()) {
    return { valid: false, error: "Story URL cannot be empty." };
  }

  const trimmed = inputUrl.trim();

  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    return { valid: false, error: `Invalid URL format: "${trimmed}"` };
  }

  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    return {
      valid: false,
      error: `Disallowed URL protocol: "${parsed.protocol}". Only http: and https: are allowed.`,
    };
  }

  if (parsed.username || parsed.password) {
    return { valid: false, error: "Embedded credentials in URL are not allowed." };
  }

  if (!parsed.hostname || parsed.hostname.length < 3) {
    return { valid: false, error: `Invalid hostname in URL: "${parsed.hostname}"` };
  }

  // SSRF guard
  if (!options.allowLoopbackForTesting) {
    const ssrfCheck = await validateUrlForSSRF(trimmed, { allowProxyBypass: true });
    if (!ssrfCheck.safe) {
      return {
        valid: false,
        error: ssrfCheck.error || "URL was rejected by security SSRF guard.",
      };
    }
  }

  return { valid: true, normalizedUrl: parsed.toString() };
}

/**
 * Parse and normalize tags list, guaranteeing DEFAULT_TAG is included.
 */
export function parseNovelTags(userTags?: string[] | string): string[] {
  const result = new Set<string>();
  result.add(DEFAULT_TAG);

  if (typeof userTags === "string") {
    for (const t of userTags.split(",")) {
      const clean = t.trim();
      if (clean) result.add(clean);
    }
  } else if (Array.isArray(userTags)) {
    for (const item of userTags) {
      if (typeof item === "string") {
        for (const t of item.split(",")) {
          const clean = t.trim();
          if (clean) result.add(clean);
        }
      }
    }
  }

  return Array.from(result);
}

/**
 * Execute calibredb while stripping proxy environment variables to prevent output pollution.
 */
export function executeCalibredb(
  args: string[],
  options?: {
    calibredbBin?: string;
    calibredbRunner?: NovelDependencies["calibredbRunner"];
    timeoutMs?: number;
    spawnSync?: typeof spawnSync;
  },
) {
  if (options?.calibredbRunner) {
    return options.calibredbRunner(args, { timeoutMs: options.timeoutMs });
  }

  const env = { ...process.env };
  delete env.HTTP_PROXY;
  delete env.http_proxy;
  delete env.HTTPS_PROXY;
  delete env.https_proxy;
  delete env.ALL_PROXY;
  delete env.all_proxy;
  env.PATH =
    "/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:" + (env.PATH || "");

  const bin = options?.calibredbBin || getCalibredbPath();
  const run = options?.spawnSync || spawnSync;
  return run(bin, args, {
    encoding: "utf8",
    env,
    timeout: options?.timeoutMs || 60000,
    maxBuffer: 32 * 1024 * 1024,
  });
}

/**
 * Execute fanficfare subprocess in a clean working directory.
 */
export function executeFanficfare(
  args: string[],
  options: {
    cwd: string;
    fanficfareBin?: string;
    runner?: NovelDependencies["fanficfareRunner"];
    timeoutMs?: number;
  },
) {
  if (options.runner) {
    return options.runner(args, {
      cwd: options.cwd,
      timeout: options.timeoutMs,
      env: process.env as Record<string, string>,
    });
  }

  const bin = options.fanficfareBin || assertFanficfareAvailable();
  return spawnSync(bin, args, {
    cwd: options.cwd,
    encoding: "utf8",
    timeout: options.timeoutMs || 300000, // 5 min timeout for large serials
    maxBuffer: 64 * 1024 * 1024,
  });
}

/**
 * Look for existing novel in Calibre library matching the story URL.
 * Checks SQLite metadata.db directly if available, or falls back to calibredb list.
 */
export async function findExistingNovelInCalibre(
  url: string,
  options: {
    calibreDbPath?: string;
    calibreServerUrl?: string;
    libraryDir?: string;
    dependencies?: NovelDependencies;
  },
): Promise<{ id: number; title: string; authors: string; epubPath?: string } | null> {
  const dbPath =
    options.calibreDbPath ||
    process.env.CALIBRE_DB_PATH ||
    path.join(process.env.HOME || "", "Calibre_Library/metadata.db");

  const libraryDir =
    options.libraryDir ||
    process.env.CALIBRE_LIBRARY_DIR ||
    path.dirname(dbPath);

  // Strategy 1: Direct SQLite inspection (fastest, concurrent WAL-safe)
  if (fs.existsSync(dbPath)) {
    try {
      const db = new Database(dbPath, { readonly: true });
      try {
        const query = `
          SELECT b.id, b.title, b.author_sort as authors, b.path
          FROM books b
          LEFT JOIN comments c ON b.id = c.book
          LEFT JOIN identifiers i ON b.id = i.book
          WHERE (c.text LIKE ? OR (i.type = 'url' AND i.val = ?) OR (i.val LIKE ?))
          LIMIT 1
        `;
        const wild = `%${url}%`;
        const row = db.query(query).get(wild, url, wild) as {
          id: number;
          title: string;
          authors: string;
          path: string;
        } | null;

        if (row && row.id) {
          let epubPath: string | undefined;
          const dataRow = db
            .query("SELECT name, format FROM data WHERE book = ? AND format = 'EPUB' LIMIT 1")
            .get(row.id) as { name: string; format: string } | null;

          if (dataRow && dataRow.name && row.path) {
            const candidate = path.join(libraryDir, row.path, `${dataRow.name}.epub`);
            if (fs.existsSync(candidate)) {
              epubPath = candidate;
            }
          }

          return {
            id: row.id,
            title: row.title || "Untitled",
            authors: row.authors || "Unknown",
            epubPath,
          };
        }
      } finally {
        db.close();
      }
    } catch {
      // Fall through to calibredb list
    }
  }

  // Strategy 2: calibredb list search fallback
  const serverUrl = options.calibreServerUrl || DEFAULT_CALIBRE_SERVER_URL;
  try {
    const listRes = executeCalibredb(
      [
        "list",
        "--with-library",
        serverUrl,
        "--search",
        `comments:"${url}"`,
        "--fields",
        "id,title,authors,formats",
        "--for-machine",
      ],
      {
        calibredbBin: options.dependencies?.calibredbBin,
        calibredbRunner: options.dependencies?.calibredbRunner,
      },
    );

    if (listRes.status === 0 && listRes.stdout) {
      const parsed = JSON.parse(listRes.stdout.trim());
      if (Array.isArray(parsed) && parsed.length > 0 && parsed[0]?.id) {
        const item = parsed[0];
        const authorStr = Array.isArray(item.authors)
          ? item.authors.join(", ")
          : item.authors || "Unknown";

        let epubPath: string | undefined;
        if (Array.isArray(item.formats)) {
          const ep = item.formats.find((f: string) => f.toLowerCase().endsWith(".epub"));
          if (ep && fs.existsSync(ep)) epubPath = ep;
        }

        return {
          id: item.id,
          title: item.title || "Untitled",
          authors: authorStr,
          epubPath,
        };
      }
    }
  } catch {
    // Return null if search encounters errors
  }

  return null;
}

/**
 * Parse metadata output from fanficfare --json-meta.
 */
export function parseFanficfareJsonMeta(rawStdout: string): NovelMetadata {
  let parsed: Record<string, unknown> | null = null;
  try {
    // Locate the first { and last } to account for any preamble notices
    const startIdx = rawStdout.indexOf("{");
    const endIdx = rawStdout.lastIndexOf("}");
    if (startIdx !== -1 && endIdx !== -1 && endIdx > startIdx) {
      const jsonStr = rawStdout.substring(startIdx, endIdx + 1);
      parsed = JSON.parse(jsonStr) as Record<string, unknown>;
    } else {
      parsed = JSON.parse(rawStdout.trim()) as Record<string, unknown>;
    }
  } catch {
    // If JSON parsing fails, fallback to regex extraction
    const titleMatch = rawStdout.match(/Title:\s*(.+)/i);
    const authorMatch = rawStdout.match(/Author:\s*(.+)/i);
    return {
      title: titleMatch ? titleMatch[1].trim() : undefined,
      author: authorMatch ? authorMatch[1].trim() : undefined,
      raw: {},
    };
  }

  const title = parsed.title || parsed.storyTitle || undefined;
  const author = parsed.author || parsed.authorName || (Array.isArray(parsed.author) ? parsed.author.join(", ") : undefined);
  const description = parsed.description || parsed.summary || undefined;
  const storyUrl = parsed.storyUrl || parsed.url || undefined;
  const numChapters = parsed.numChapters !== undefined
    ? Number(parsed.numChapters)
    : Array.isArray(parsed.zchapters)
      ? parsed.zchapters.length
      : undefined;

  const outputFilename = parsed.output_filename || undefined;
  const series = parsed.series || undefined;
  const seriesIndex = parsed.seriesIndex ? Number(parsed.seriesIndex) : undefined;

  let tags: string[] = [];
  if (Array.isArray(parsed.genre)) tags.push(...parsed.genre);
  if (Array.isArray(parsed.category)) tags.push(...parsed.category);
  if (Array.isArray(parsed.subject_tags)) tags.push(...parsed.subject_tags);

  return {
    title,
    author,
    description,
    storyUrl,
    numChapters,
    outputFilename,
    tags: tags.map((t) => String(t).trim()).filter(Boolean),
    series,
    seriesIndex,
    raw: parsed,
  };
}

/**
 * Extract basic metadata (title, author, description) from an EPUB's content.opf XML.
 */
export function extractMetadataFromOpfXml(opfXml: string): Partial<NovelMetadata> {
  const result: Partial<NovelMetadata> = {};

  const titleMatch = opfXml.match(/<dc:title[^>]*>([\s\S]*?)<\/dc:title>/i);
  if (titleMatch && titleMatch[1]) {
    result.title = titleMatch[1].replace(/<[^>]+>/g, "").trim();
  }

  const authorMatch = opfXml.match(/<dc:creator[^>]*>([\s\S]*?)<\/dc:creator>/i);
  if (authorMatch && authorMatch[1]) {
    result.author = authorMatch[1].replace(/<[^>]+>/g, "").trim();
  }

  const descMatch = opfXml.match(/<dc:description[^>]*>([\s\S]*?)<\/dc:description>/i);
  if (descMatch && descMatch[1]) {
    result.description = descMatch[1].trim();
  }

  return result;
}

/**
 * Ingest web novel into Calibre library using FanFicFare.
 */
export async function ingestNovel(
  options: NovelIngestOptions,
): Promise<NovelIngestResult> {
  const deps = options.dependencies || {};

  // 1. Validate URL
  const urlValidator = deps.validateUrl || validateNovelUrl;
  const urlCheck = await urlValidator(options.url);
  if (!urlCheck.valid || !urlCheck.normalizedUrl) {
    return {
      success: false,
      action: "error",
      sourceUrl: options.url,
      error: urlCheck.error || "Invalid novel URL provided.",
    };
  }
  const cleanUrl = urlCheck.normalizedUrl;

  // 2. Verify fanficfare presence (fail closed)
  let fanficfareBin: string;
  try {
    if (deps.fanficfareRunner) {
      fanficfareBin = options.fanficfareBin || deps.fanficfareBin || "fanficfare";
    } else {
      fanficfareBin = assertFanficfareAvailable(
        options.fanficfareBin || deps.fanficfareBin,
        deps.spawnSync,
      );
    }
  } catch (err: unknown) {
    const errorMsg = err instanceof Error ? err.message : String(err);
    return {
      success: false,
      action: "error",
      sourceUrl: cleanUrl,
      error: errorMsg || "fanficfare executable missing",
    };
  }

  const serverUrl = options.calibreServerUrl || DEFAULT_CALIBRE_SERVER_URL;
  const tags = parseNovelTags(options.tags);

  // 3. Dry-run Preview Mode
  if (options.dryRun) {
    let metadata: NovelMetadata = { storyUrl: cleanUrl };

    // Run FanFicFare with --meta-only --json-meta --no-output --non-interactive
    const dryRunArgs = [
      "--non-interactive",
      "--meta-only",
      "--json-meta",
      "--no-output",
      cleanUrl,
    ];

    const probe = executeFanficfare(dryRunArgs, {
      cwd: os.tmpdir(),
      fanficfareBin,
      runner: deps.fanficfareRunner,
      timeoutMs: 30000,
    });

    if (probe.status === 0 && probe.stdout) {
      metadata = parseFanficfareJsonMeta(probe.stdout);
    } else {
      // If meta-only failed with non-zero exit code
      const stderr = probe.stderr || probe.stdout || "Failed to fetch metadata from story URL";
      return {
        success: false,
        action: "error",
        sourceUrl: cleanUrl,
        error: `FanFicFare metadata probe failed: ${stderr.trim()}`,
      };
    }

    // Check if story already exists in Calibre
    const existing = await findExistingNovelInCalibre(cleanUrl, {
      calibreDbPath: options.calibreDbPath,
      calibreServerUrl: serverUrl,
      libraryDir: options.libraryDir,
      dependencies: deps,
    });

    const plannedTags = Array.from(new Set([...tags, ...(metadata.tags || [])]));

    return {
      success: true,
      action: "dry-run",
      sourceUrl: cleanUrl,
      title: metadata.title || "Unknown Title",
      author: metadata.author || "Unknown Author",
      chapterCount: metadata.numChapters || 0,
      tags: plannedTags,
      isDuplicate: Boolean(existing),
      bookId: existing ? existing.id : undefined,
      metadata,
      message: existing
        ? `Dry-run preview: Novel already exists in Calibre (ID: ${existing.id}). Would update with --update.`
        : "Dry-run preview: Novel is valid and ready for download.",
    };
  }

  // 4. Staging Directory Lifecycle
  const stagingDir =
    options.stagingDir ||
    fs.mkdtempSync(path.join(os.tmpdir(), "lighthouse-fanficfare-"));

  try {
    // 5. Check if story already exists in Calibre (for update mode or duplicate detection)
    const existing = await findExistingNovelInCalibre(cleanUrl, {
      calibreDbPath: options.calibreDbPath,
      calibreServerUrl: serverUrl,
      libraryDir: options.libraryDir,
      dependencies: deps,
    });

    const isUpdateMode = Boolean(options.update);

    // ------------------------------------------------------------------------
    // CASE A: Updating an existing book
    // ------------------------------------------------------------------------
    if (isUpdateMode && existing) {
      let targetEpubPath: string | null = null;

      // If existing physical EPUB path is found, copy it into staging
      if (existing.epubPath && fs.existsSync(existing.epubPath)) {
        targetEpubPath = path.join(stagingDir, path.basename(existing.epubPath));
        fs.copyFileSync(existing.epubPath, targetEpubPath);
      }

      const fffArgs = ["--non-interactive", "--format=epub", "--json-meta", "--update-epub"];
      if (targetEpubPath) {
        fffArgs.push(targetEpubPath);
      } else {
        fffArgs.push(cleanUrl);
      }

      const fffRun = executeFanficfare(fffArgs, {
        cwd: stagingDir,
        fanficfareBin,
        runner: deps.fanficfareRunner,
      });

      if (fffRun.status !== 0) {
        return {
          success: false,
          action: "error",
          sourceUrl: cleanUrl,
          bookId: existing.id,
          title: existing.title,
          author: existing.authors,
          error: fffRun.stderr || fffRun.stdout || "Failed to update novel via FanFicFare",
        };
      }

      // Locate updated EPUB in staging
      let updatedEpub: string | null = targetEpubPath && fs.existsSync(targetEpubPath) ? targetEpubPath : null;
      if (!updatedEpub || !fs.existsSync(updatedEpub)) {
        const files = fs.readdirSync(stagingDir);
        const ep = files.find((f) => f.toLowerCase().endsWith(".epub"));
        if (ep) updatedEpub = path.join(stagingDir, ep);
      }

      if (!updatedEpub || !fs.existsSync(updatedEpub)) {
        return {
          success: false,
          action: "error",
          sourceUrl: cleanUrl,
          bookId: existing.id,
          error: "FanFicFare reported success but no updated EPUB file was found in staging directory.",
        };
      }

      // Update Calibre format
      const addFormatRes = executeCalibredb(
        ["add_format", String(existing.id), updatedEpub, "--with-library", serverUrl],
        {
          calibredbBin: options.calibredbBin || deps.calibredbBin,
          calibredbRunner: deps.calibredbRunner,
        },
      );

      if (addFormatRes.status !== 0) {
        return {
          success: false,
          action: "error",
          sourceUrl: cleanUrl,
          bookId: existing.id,
          error: addFormatRes.stderr || "Failed to update EPUB format in Calibre.",
        };
      }

      // Metadata extraction
      const parsedMeta = parseFanficfareJsonMeta(fffRun.stdout || "");
      const finalTitle = parsedMeta.title || existing.title;
      const finalAuthor = parsedMeta.author || existing.authors;

      // Extract and update cover if available
      const coverJpg = path.join(stagingDir, "cover.jpg");
      const coverExtractor = deps.extractCover || extractCoverFromEpub;
      let hasCover = false;
      try {
        hasCover = await coverExtractor(updatedEpub, coverJpg);
      } catch {
        hasCover = false;
      }

      const setArgs = [
        "set_metadata",
        String(existing.id),
        "--with-library",
        serverUrl,
        "--field",
        `identifiers:url:${cleanUrl}`,
      ];

      if (parsedMeta.description) {
        setArgs.push("--field", `comments:${parsedMeta.description}\n\nSaved from ${cleanUrl}`);
      }

      if (hasCover && fs.existsSync(coverJpg)) {
        setArgs.push("--field", `cover:${coverJpg}`);
      }

      executeCalibredb(setArgs, {
        calibredbBin: options.calibredbBin || deps.calibredbBin,
        calibredbRunner: deps.calibredbRunner,
      });

      if (hasCover) {
        try {
          const { purgeCoverCache } = await import("./server");
          purgeCoverCache(existing.id);
        } catch {
          // ignore cache purge error in standalone mode
        }
      }

      return {
        success: true,
        action: "updated",
        bookId: existing.id,
        title: finalTitle,
        author: finalAuthor,
        chapterCount: parsedMeta.numChapters,
        sourceUrl: cleanUrl,
        epubPath: updatedEpub,
        coverExtracted: hasCover,
        tags,
        message: `Successfully updated "${finalTitle}" with new chapters (Calibre ID: ${existing.id})`,
      };
    }

    // ------------------------------------------------------------------------
    // CASE B: Fresh Novel Download (or update requested on non-existent book)
    // ------------------------------------------------------------------------
    const fffArgs = ["--non-interactive", "--format=epub", "--json-meta", cleanUrl];

    const fffRun = executeFanficfare(fffArgs, {
      cwd: stagingDir,
      fanficfareBin,
      runner: deps.fanficfareRunner,
    });

    if (fffRun.status !== 0) {
      return {
        success: false,
        action: "error",
        sourceUrl: cleanUrl,
        error: fffRun.stderr || fffRun.stdout || "Failed to download novel via FanFicFare",
      };
    }

    // Locate the downloaded EPUB
    let downloadedEpub: string | null = null;
    const files = fs.readdirSync(stagingDir);
    const ep = files.find((f) => f.toLowerCase().endsWith(".epub"));
    if (ep) downloadedEpub = path.join(stagingDir, ep);

    if (!downloadedEpub || !fs.existsSync(downloadedEpub)) {
      return {
        success: false,
        action: "error",
        sourceUrl: cleanUrl,
        error: "FanFicFare reported success but no EPUB file was found in staging directory.",
      };
    }

    // Parse metadata
    const parsedMeta = parseFanficfareJsonMeta(fffRun.stdout || "");
    const title = parsedMeta.title || path.basename(downloadedEpub, ".epub");
    const author = parsedMeta.author || "Unknown";
    const description = parsedMeta.description || `Downloaded from ${cleanUrl}`;
    const allTags = Array.from(new Set([...tags, ...(parsedMeta.tags || [])]));

    // Language resolution
    const classification = await resolveBookLanguageAndTags({
      title,
      author,
      comments: description,
      tags: allTags,
    });

    const tagsStr = classification.tags.join(",");

    // Add to Calibre via calibredb add
    const addArgs = [
      "add",
      downloadedEpub,
      "--with-library",
      serverUrl,
      "--title",
      title,
      "--authors",
      author,
      "--tags",
      tagsStr,
      "--automerge",
      "ignore",
    ];

    if (classification.language && classification.language !== "other") {
      addArgs.push("--languages", classification.language);
    }

    const addRes = executeCalibredb(addArgs, {
      calibredbBin: options.calibredbBin || deps.calibredbBin,
      calibredbRunner: deps.calibredbRunner,
    });

    if (addRes.status !== 0) {
      return {
        success: false,
        action: "error",
        sourceUrl: cleanUrl,
        title,
        author,
        error: addRes.stderr || addRes.stdout || "Failed to add downloaded novel to Calibre",
      };
    }

    let bookId: number | undefined;
    const match = addRes.stdout?.match(/Added book ids?:?\s*([0-9]+)/i);
    if (match) {
      bookId = parseInt(match[1], 10);
    }

    // If ID not parsed directly, search by title
    if (!bookId) {
      const listRes = executeCalibredb(
        [
          "list",
          "--with-library",
          serverUrl,
          "--search",
          `title:"=${title}"`,
          "--fields",
          "id",
          "--for-machine",
        ],
        {
          calibredbBin: options.calibredbBin || deps.calibredbBin,
          calibredbRunner: deps.calibredbRunner,
        },
      );

      if (listRes.status === 0 && listRes.stdout) {
        try {
          const parsed = JSON.parse(listRes.stdout.trim());
          if (Array.isArray(parsed) && parsed.length > 0 && parsed[0]?.id) {
            bookId = parsed[0].id;
          }
        } catch {
          // ignore
        }
      }
    }

    // Extract cover and set additional metadata
    let hasCover = false;
    if (bookId) {
      const coverJpg = path.join(stagingDir, "cover.jpg");
      const coverExtractor = deps.extractCover || extractCoverFromEpub;
      try {
        hasCover = await coverExtractor(downloadedEpub, coverJpg);
      } catch {
        hasCover = false;
      }

      const setArgs = [
        "set_metadata",
        String(bookId),
        "--with-library",
        serverUrl,
        "--field",
        `identifiers:url:${cleanUrl}`,
        "--field",
        `comments:${description}\n\nSaved from ${cleanUrl}`,
      ];

      if (hasCover && fs.existsSync(coverJpg)) {
        setArgs.push("--field", `cover:${coverJpg}`);
      }

      if (parsedMeta.series) {
        setArgs.push("--field", `series:${parsedMeta.series}`);
        if (parsedMeta.seriesIndex) {
          setArgs.push("--field", `series_index:${parsedMeta.seriesIndex}`);
        }
      }

      executeCalibredb(setArgs, {
        calibredbBin: options.calibredbBin || deps.calibredbBin,
        calibredbRunner: deps.calibredbRunner,
      });

      if (hasCover) {
        try {
          const { purgeCoverCache } = await import("./server");
          purgeCoverCache(bookId);
        } catch {
          // ignore
        }
      }
    }

    return {
      success: true,
      action: "downloaded",
      bookId,
      title,
      author,
      chapterCount: parsedMeta.numChapters,
      sourceUrl: cleanUrl,
      epubPath: downloadedEpub,
      coverExtracted: hasCover,
      tags: classification.tags,
      metadata: parsedMeta,
      message: `Successfully ingested "${title}" by ${author} into Calibre (ID: ${bookId || "unknown"})`,
    };
  } finally {
    if (!options.keepStaging && stagingDir && fs.existsSync(stagingDir)) {
      try {
        fs.rmSync(stagingDir, { recursive: true, force: true });
      } catch {
        // ignore staging directory cleanup error
      }
    }
  }
}
