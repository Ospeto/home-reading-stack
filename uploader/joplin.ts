/**
 * uploader/joplin.ts
 *
 * Native Joplin Clipper HTTP API compatibility layer for KOReader highlight & note export.
 *
 * Implements the protocol expected by KOReader's `exporter.koplugin/target/joplin.lua`:
 *   - GET  /ping       -> 200 text/plain "JoplinClipperServer"
 *   - GET  /folders    -> 200 JSON { items: [{ id: "koreader-notes", title: "KOReader Notes" }], has_more: false }
 *   - POST /folders    -> 200 JSON { id: "koreader-notes", title: "KOReader Notes" }
 *   - GET  /notes      -> 200 JSON { items: [], has_more: false }
 *   - POST /notes      -> 200 JSON { id, title } (writes/updates <vault>/Books/<SanitizedTitle>.md)
 *   - PUT  /notes/:id  -> 200 JSON { id, title } (updates <vault>/Books/<SanitizedTitle>.md)
 *
 * Formats notes with clean YAML frontmatter (tags: [reading, highlights, koreader], updated: <timestamp>, title: ...)
 * and idempotent highlight markers (<!-- lighthouse:highlights:start --> / <!-- lighthouse:highlights:end -->)
 * so re-exporting does not duplicate existing highlights while preserving user edits.
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import crypto from "node:crypto";
import { Buffer } from "node:buffer";
import { Database } from "bun:sqlite";
import { truncateUtf8Bytes } from "./filename";
import { sanitizeErrorMessage } from "./security";

// ----------------------------------------------------------------------------
// Constants & Markers
// ----------------------------------------------------------------------------

export const JOPLIN_DEFAULT_TOKEN = "lighthouse";
export const JOPLIN_CLIPPER_PING_RESPONSE = "JoplinClipperServer";
export const JOPLIN_FOLDER_ID = "koreader-notes";
export const JOPLIN_FOLDER_TITLE = "KOReader Notes";
export const MAX_JOPLIN_BODY_BYTES = 5 * 1024 * 1024; // 5MB cap

export const HIGHLIGHTS_START_MARKER = "<!-- lighthouse:highlights:start -->";
export const HIGHLIGHTS_END_MARKER = "<!-- lighthouse:highlights:end -->";

// ----------------------------------------------------------------------------
// Interfaces & Types
// ----------------------------------------------------------------------------

export interface JoplinOptions {
  booksDir?: string;
  vaultPath?: string;
  expectedToken?: string;
  corsOrigin?: string;
  calibreDbPath?: string;
}

export interface JoplinNotePayload {
  title?: string;
  body?: string;
  parent_id?: string;
  created_time?: number | string;
  id?: string;
}

export interface JoplinNoteResult {
  id: string;
  title: string;
  path: string;
  action: "created" | "updated";
  highlightCount: number;
}

export interface ParsedHighlightEntry {
  raw: string;
  normalized: string;
  chapter?: string;
}

// ----------------------------------------------------------------------------
// 1. Token Authentication & Route Recognition
// ----------------------------------------------------------------------------

export function getJoplinToken(): string {
  return process.env.JOPLIN_TOKEN || JOPLIN_DEFAULT_TOKEN;
}

export function isJoplinRoute(pathname: string): boolean {
  return (
    pathname === "/ping" ||
    pathname === "/folders" ||
    pathname.startsWith("/folders/") ||
    pathname === "/notes" ||
    pathname.startsWith("/notes/")
  );
}

function safeCompareTokens(a: string, b: string): boolean {
  if (typeof a !== "string" || typeof b !== "string") return false;
  // Hash with SHA-256 to ensure equal 32-byte buffers and prevent token length leakage
  const hashA = crypto.createHash("sha256").update(a).digest();
  const hashB = crypto.createHash("sha256").update(b).digest();
  return crypto.timingSafeEqual(hashA, hashB);
}

export function validateJoplinToken(
  req: Request,
  url: URL,
  expectedToken?: string,
): boolean {
  const token = expectedToken || getJoplinToken();
  if (!token) return true;

  // 1. Query parameter ?token=...
  const queryToken = url.searchParams.get("token");
  if (queryToken && safeCompareTokens(queryToken, token)) {
    return true;
  }

  // 2. Authorization: Bearer <token>
  const authHeader = req.headers.get("authorization");
  if (authHeader) {
    const bearerMatch = authHeader.match(/^Bearer\s+(.+)$/i);
    if (bearerMatch && safeCompareTokens(bearerMatch[1].trim(), token)) {
      return true;
    }
  }

  // 3. X-API-Key or x-api-key
  const apiKey = req.headers.get("x-api-key");
  if (apiKey && safeCompareTokens(apiKey.trim(), token)) {
    return true;
  }

  // 4. Joplin custom headers: X-Token, x-token, token
  const customToken = req.headers.get("x-token") || req.headers.get("token");
  if (customToken && safeCompareTokens(customToken.trim(), token)) {
    return true;
  }

  return false;
}

// ----------------------------------------------------------------------------
// 2. Path Sanitization & Destination Resolution
// ----------------------------------------------------------------------------

export function getObsidianBooksDir(customDir?: string): string {
  if (customDir) return customDir;
  if (process.env.OBSIDIAN_BOOKS_DIR) return process.env.OBSIDIAN_BOOKS_DIR;
  const vaultPath =
    process.env.OBSIDIAN_VAULT_PATH || path.join(os.homedir(), "Obsidian");
  return path.join(vaultPath, "Books");
}

export function sanitizeTitle(title: string): string {
  if (!title) return "Untitled";
  let s = title.normalize("NFC");

  // Remove URLs and bracketed marks
  s = s.replace(/https?:\/\/\S+/gi, " ");
  s = s.replace(/\[.*?(ebook|pdf|epub|channel|tg|myanmar).*?\]/gi, " ");
  s = s.replace(/\((.*?)(ebook|pdf|epub|channel|tg|myanmar)(.*?)\)/gi, " ");

  // Replace colons and vertical bars with clean separators
  s = s.replace(/[:|]/g, " - ");

  // Strip illegal filesystem characters: <>"/\|?*#^[]
  s = s.replace(/[<>"/\\|?*#^[\]]/g, " ");

  // Filter out any invisible ASCII control characters safely
  s = Array.from(s)
    .filter((ch) => {
      const code = ch.charCodeAt(0);
      return code >= 32 && code !== 127;
    })
    .join("");

  // Collapse spaces and dashes
  s = s.replace(/[\s_]+/g, " ");
  s = s.replace(/\s*[-–—]\s*/g, " - ");
  s = s.replace(/(?: - )+/g, " - ");

  // Trim leading/trailing separators
  s = s.replace(/^[\s.\-–—]+|[\s.\-–—]+$/g, "").trim();

  return s || "Untitled";
}

export function getBookNotePath(
  title: string,
  booksDir?: string,
): { safeTitle: string; notePath: string } {
  const dir = getObsidianBooksDir(booksDir);
  let safeTitle = sanitizeTitle(title);

  // Enforce NAME_MAX filesystem budget (<= 240 bytes) to prevent ENAMETOOLONG
  safeTitle = truncateUtf8Bytes(safeTitle, 240);
  if (!safeTitle) safeTitle = "Untitled";

  const safeFilename = path.basename(safeTitle) + ".md";
  const resolvedDir = path.resolve(dir);
  const notePath = path.resolve(resolvedDir, safeFilename);

  // Strict prefix path traversal protection
  const rootPrefix = resolvedDir.endsWith(path.sep)
    ? resolvedDir
    : resolvedDir + path.sep;
  if (!notePath.startsWith(rootPrefix)) {
    throw new Error("Invalid note path: potential path traversal detected");
  }

  return { safeTitle, notePath };
}

// ----------------------------------------------------------------------------
// 3. Highlight Normalization & Parsing
// ----------------------------------------------------------------------------

/**
 * Normalizes a quote string for semantic comparison and deduplication:
 * strips headers, page stamps, timestamps, backlinks, and markdown formatting.
 */
export function normalizeQuote(text: string): string {
  if (!text) return "";
  let clean = text;

  // Remove markdown headers
  clean = clean.replace(/^#{1,6}\s+.*$/gm, "");

  // Remove attribution / timestamp lines (e.g. "— Chapter 1, Page 12 @ 2024-05-01")
  clean = clean.replace(/^[—–-]\s+.*$/gm, "");

  // Remove backlinks like "[View in book](<file://...>)"
  clean = clean.replace(/\[.*?\]\([^)]+\)/gi, "");

  // Remove horizontal rules
  clean = clean.replace(/^[-*_]{3,}\s*$/gm, "");

  // Remove markdown formatting tokens
  clean = clean.replace(/[=>*~_`#+]/g, "");

  // Collapse whitespace and lowercase
  clean = clean.replace(/\s+/g, " ").trim().toLowerCase();

  return clean;
}

/**
 * Strips leading title (# Title) and author (##### Author) lines from incoming Joplin markdown body.
 */
export function cleanIncomingHighlightBody(
  body: string,
  title?: string,
): string {
  if (!body) return "";
  let cleaned = body.trim();

  if (title) {
    const escapedTitle = title.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    cleaned = cleaned.replace(
      new RegExp(`^#\\s+${escapedTitle}\\s*\\n+`, "i"),
      "",
    );
  } else {
    cleaned = cleaned.replace(/^#\s+[^\n]+\n+/, "");
  }

  // Strip author heading (e.g. ##### Author Name or ##### N/A)
  cleaned = cleaned.replace(/^#{4,6}\s+[^\n]+\n+/, "");

  return cleaned.trim();
}

/**
 * Parses markdown into discrete highlight entries.
 * Handles KOReader ### Page entries, blockquotes (>), or paragraph blocks.
 */
export function splitHighlightEntries(
  markdown: string,
): ParsedHighlightEntry[] {
  if (!markdown || !markdown.trim()) return [];

  const lines = markdown.split("\n");
  const entries: ParsedHighlightEntry[] = [];

  let currentChapter: string | undefined;
  let currentRawLines: string[] = [];
  let isCollectingEntry = false;

  function flushCurrentEntry() {
    if (currentRawLines.length === 0) return;
    const raw = currentRawLines.join("\n").trim();
    if (raw) {
      const norm = normalizeQuote(raw);
      if (norm.length > 0) {
        entries.push({
          raw,
          normalized: norm,
          chapter: currentChapter,
        });
      }
    }
    currentRawLines = [];
  }

  const hasSubheaders = lines.some((l) => /^###\s+/.test(l.trim()));
  const hasBlockquotes = lines.some((l) => /^>\s+/.test(l.trim()));

  if (hasSubheaders) {
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      const trimmed = line.trim();

      // Chapter header: "## <Chapter>" (but not ###)
      if (/^##\s+[^#]/.test(trimmed)) {
        flushCurrentEntry();
        currentChapter = trimmed.replace(/^##\s+/, "").trim();
        continue;
      }

      // Entry start: "### Page ..."
      if (/^###\s+/.test(trimmed)) {
        flushCurrentEntry();
        isCollectingEntry = true;
        currentRawLines.push(line);
        continue;
      }

      if (isCollectingEntry) {
        currentRawLines.push(line);
      }
    }
    flushCurrentEntry();
  } else if (hasBlockquotes) {
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      const trimmed = line.trim();

      if (/^##\s+[^#]/.test(trimmed)) {
        flushCurrentEntry();
        currentChapter = trimmed.replace(/^##\s+/, "").trim();
        continue;
      }

      if (/^>\s+/.test(trimmed)) {
        const prevTrimmed = i > 0 ? lines[i - 1].trim() : "";
        if (
          isCollectingEntry &&
          (prevTrimmed === "" ||
            prevTrimmed.startsWith("—") ||
            prevTrimmed.startsWith("-"))
        ) {
          flushCurrentEntry();
        }
        isCollectingEntry = true;
        currentRawLines.push(line);
        continue;
      }

      if (isCollectingEntry) {
        currentRawLines.push(line);
      }
    }
    flushCurrentEntry();
  } else {
    // Split on horizontal rules or double newlines
    const paragraphs = markdown.split(/\n\s*[-*_]{3,}\s*\n|\n\n+/);
    for (const p of paragraphs) {
      const trimmed = p.trim();
      if (!trimmed) continue;
      const norm = normalizeQuote(trimmed);
      if (norm.length > 0) {
        entries.push({
          raw: trimmed,
          normalized: norm,
        });
      }
    }
  }

  if (entries.length === 0 && markdown.trim().length > 0) {
    entries.push({
      raw: markdown.trim(),
      normalized: normalizeQuote(markdown.trim()),
    });
  }

  return entries;
}

export function isQuoteInExisting(
  normalizedQuote: string,
  existingHighlightsText: string,
): boolean {
  if (!normalizedQuote || normalizedQuote.length < 3) return false;
  const existingNormalized = normalizeQuote(existingHighlightsText);

  if (existingNormalized.includes(normalizedQuote)) {
    return true;
  }

  // Substring match for longer quotes: verify both prefix & suffix match within the SAME existing entry
  if (normalizedQuote.length > 30) {
    const prefix = normalizedQuote.slice(0, 30);
    const suffix = normalizedQuote.slice(-30);
    const existingEntries = splitHighlightEntries(existingHighlightsText);
    for (const entry of existingEntries) {
      if (entry.normalized.includes(normalizedQuote)) return true;
      if (
        entry.normalized.includes(prefix) &&
        entry.normalized.includes(suffix)
      ) {
        return true;
      }
    }
  }

  return false;
}

// ----------------------------------------------------------------------------
// 4. Frontmatter & Note Merging Engine
// ----------------------------------------------------------------------------

export function updateFrontmatter(
  existingFrontmatter: string | null,
  meta: {
    title: string;
    author?: string;
    series?: string;
    updated?: string;
  },
): string {
  const updatedIso = meta.updated || new Date().toISOString();

  if (!existingFrontmatter) {
    const lines = ["---", `title: ${JSON.stringify(meta.title)}`];
    if (meta.author && meta.author !== "Unknown") {
      lines.push(`author: ${JSON.stringify(meta.author)}`);
    } else {
      lines.push('author: "Unknown"');
    }
    if (meta.series) {
      lines.push(`series: ${JSON.stringify(meta.series)}`);
    }
    lines.push(
      "tags: [reading, highlights, koreader]",
      `updated: ${JSON.stringify(updatedIso)}`,
      "---",
    );
    return lines.join("\n");
  }

  // Parse existing frontmatter lines
  const rawLines = existingFrontmatter
    .replace(/^---\n?/, "")
    .replace(/\n?---$/, "")
    .split("\n");

  const fmEntries: Array<{ key?: string; line: string }> = [];
  const existingTags = new Set<string>();
  let hasUpdated = false;
  let hasTitle = false;
  let hasAuthor = false;
  let inTagsList = false;

  for (const line of rawLines) {
    const trimmed = line.trim();
    if (!trimmed) continue;

    if (trimmed.startsWith("tags:")) {
      const bracketMatch = trimmed.match(/tags:\s*\[(.*?)\]/);
      if (bracketMatch) {
        bracketMatch[1]
          .split(",")
          .map((t) => t.trim().replace(/^['"]|['"]$/g, ""))
          .filter(Boolean)
          .forEach((t) => existingTags.add(t));
      } else {
        inTagsList = true;
      }
      continue;
    }

    if (inTagsList) {
      if (trimmed.startsWith("-")) {
        const tag = trimmed
          .replace(/^-\s*/, "")
          .trim()
          .replace(/^['"]|['"]$/g, "");
        if (tag) existingTags.add(tag);
        continue;
      } else {
        inTagsList = false;
      }
    }

    if (trimmed.startsWith("updated:")) {
      hasUpdated = true;
      fmEntries.push({
        key: "updated",
        line: `updated: ${JSON.stringify(updatedIso)}`,
      });
      continue;
    }

    if (trimmed.startsWith("title:")) {
      hasTitle = true;
      if (meta.title && meta.title !== "Untitled") {
        fmEntries.push({
          key: "title",
          line: `title: ${JSON.stringify(meta.title)}`,
        });
      } else {
        fmEntries.push({ key: "title", line });
      }
      continue;
    }

    if (trimmed.startsWith("author:")) {
      hasAuthor = true;
      if (meta.author && meta.author !== "Unknown") {
        fmEntries.push({
          key: "author",
          line: `author: ${JSON.stringify(meta.author)}`,
        });
      } else {
        fmEntries.push({ key: "author", line });
      }
      continue;
    }

    const colonIdx = line.indexOf(":");
    const key = colonIdx !== -1 ? line.slice(0, colonIdx).trim() : undefined;
    fmEntries.push({ key, line });
  }

  // Ensure standard Joplin highlight tags
  existingTags.add("reading");
  existingTags.add("highlights");
  existingTags.add("koreader");

  const result: string[] = ["---"];

  if (!hasTitle) {
    result.push(`title: ${JSON.stringify(meta.title)}`);
  }
  if (!hasAuthor) {
    result.push(`author: ${JSON.stringify(meta.author || "Unknown")}`);
  }

  for (const entry of fmEntries) {
    result.push(entry.line);
  }

  const tagList = Array.from(existingTags);
  result.push(`tags: [${tagList.join(", ")}]`);

  if (!hasUpdated) {
    result.push(`updated: ${JSON.stringify(updatedIso)}`);
  }

  result.push("---");
  return result.join("\n");
}

function queryCalibreMetadata(
  title: string,
  calibreDbPath?: string,
): { author?: string; comments?: string; series?: string } | null {
  try {
    const dbPath =
      calibreDbPath ||
      process.env.CALIBRE_DB_PATH ||
      path.join(os.homedir(), "Calibre Library", "metadata.db");
    if (!fs.existsSync(dbPath)) return null;

    const db = new Database(dbPath, { readonly: true });
    try {
      db.run("PRAGMA busy_timeout = 2000;");
      const normalizedTitle = title.trim();

      // Fast indexed lookup for book id first
      let bookRow = db
        .query("SELECT id FROM books WHERE title = ? COLLATE NOCASE LIMIT 1;")
        .get(normalizedTitle) as any;

      if (!bookRow) {
        bookRow = db
          .query("SELECT id FROM books WHERE lower(trim(title)) = ? LIMIT 1;")
          .get(normalizedTitle.toLowerCase()) as any;
      }

      if (!bookRow?.id) return null;

      const row = db
        .query(
          `SELECT b.id, b.title,
                  GROUP_CONCAT(DISTINCT a.name) as authors,
                  s.name as series, b.series_index,
                  c.text as comments
           FROM books b
           LEFT JOIN books_authors_link bal ON b.id = bal.book
           LEFT JOIN authors a ON bal.author = a.id
           LEFT JOIN books_series_link bsl ON b.id = bsl.book
           LEFT JOIN series s ON bsl.series = s.id
           LEFT JOIN comments c ON b.id = c.book
           WHERE b.id = ?
           GROUP BY b.id;`,
        )
        .get(bookRow.id) as any;

      if (row) {
        return {
          author: row.authors || undefined,
          comments: row.comments || undefined,
          series: row.series
            ? row.series_index
              ? `${row.series} #${row.series_index}`
              : row.series
            : undefined,
        };
      }
    } finally {
      db.close();
    }
  } catch (_calibreErr) {
    void _calibreErr;
  }
  return null;
}

export function mergeJoplinHighlights(
  existingContent: string,
  newBody: string,
  title: string,
  options?: {
    author?: string;
    updated?: string;
    booksDir?: string;
    calibreDbPath?: string;
  },
): string {
  const updatedIso = options?.updated || new Date().toISOString();

  // Extract author if not supplied
  let author = options?.author;
  if (!author) {
    const authorMatch = newBody.match(/^#####?\s+([^\n]+)/m);
    if (authorMatch) {
      author = authorMatch[1].trim();
      if (author === "N/A" || author === "(Author not found in book's metadata)") {
        author = undefined;
      }
    }
  }

  // Check Calibre DB for metadata enrichment if needed
  let series: string | undefined;
  let calibreComments: string | undefined;
  const calibreMeta = queryCalibreMetadata(title, options?.calibreDbPath);
  if (calibreMeta) {
    if (!author && calibreMeta.author) {
      author = calibreMeta.author;
    }
    series = calibreMeta.series;
    calibreComments = calibreMeta.comments;
  }

  const cleanedBody = cleanIncomingHighlightBody(newBody, title);
  const incomingEntries = splitHighlightEntries(cleanedBody);

  // 1. If no existing content: generate complete new note
  if (!existingContent || !existingContent.trim()) {
    const fm = updateFrontmatter(null, {
      title,
      author,
      series,
      updated: updatedIso,
    });

    const highlightsBlock =
      incomingEntries.length > 0
        ? incomingEntries.map((e) => e.raw).join("\n\n")
        : cleanedBody || "*No highlights recorded yet.*";

    const sections = [fm, "", `# ${title}`];

    if (calibreComments) {
      const cleanComments = calibreComments
        .replace(/<[^>]+>/g, "")
        .replace(/&amp;/g, "&")
        .trim();
      if (cleanComments) {
        sections.push("", cleanComments);
      }
    }

    sections.push(
      "",
      "## Highlights & Notes",
      HIGHLIGHTS_START_MARKER,
      highlightsBlock,
      HIGHLIGHTS_END_MARKER,
      "",
    );

    return sections.join("\n");
  }

  // 2. If existing content exists: update frontmatter and merge highlights section
  let content = existingContent;
  let existingFm: string | null = null;
  let restOfContent = content;

  if (content.startsWith("---")) {
    const endFmIdx = content.indexOf("\n---", 3);
    if (endFmIdx !== -1) {
      existingFm = content.slice(0, endFmIdx + 4);
      restOfContent = content.slice(endFmIdx + 4);
    }
  }

  const updatedFm = updateFrontmatter(existingFm, {
    title,
    author,
    series,
    updated: updatedIso,
  });

  // 2. Identify and repair highlight section markers if orphaned or inverted
  let startIdx = restOfContent.indexOf(HIGHLIGHTS_START_MARKER);
  let endIdx = restOfContent.indexOf(HIGHLIGHTS_END_MARKER);

  if (startIdx !== -1 && endIdx !== -1 && endIdx < startIdx) {
    // Inverted markers: strip both and reconstruct under "## Highlights & Notes"
    const hnIdx = restOfContent.indexOf("## Highlights & Notes");
    if (hnIdx !== -1) {
      const beforeHn = restOfContent.slice(
        0,
        hnIdx + "## Highlights & Notes".length,
      );
      const rawAfterHn = restOfContent.slice(
        hnIdx + "## Highlights & Notes".length,
      );
      const cleanAfterHn = rawAfterHn
        .replaceAll(HIGHLIGHTS_START_MARKER, "")
        .replaceAll(HIGHLIGHTS_END_MARKER, "");
      const nextSectionIdx = cleanAfterHn.search(/\n##\s+/);

      if (nextSectionIdx !== -1) {
        const recovered = cleanAfterHn.slice(0, nextSectionIdx).trim();
        const remainingDoc = cleanAfterHn.slice(nextSectionIdx);
        restOfContent = `${beforeHn}\n${HIGHLIGHTS_START_MARKER}\n${recovered}\n${HIGHLIGHTS_END_MARKER}${remainingDoc}`;
      } else {
        restOfContent = `${beforeHn}\n${HIGHLIGHTS_START_MARKER}\n${cleanAfterHn.trim()}\n${HIGHLIGHTS_END_MARKER}\n`;
      }
    } else {
      const recovered = restOfContent
        .replaceAll(HIGHLIGHTS_START_MARKER, "")
        .replaceAll(HIGHLIGHTS_END_MARKER, "")
        .trim();
      restOfContent = `${recovered}\n\n## Highlights & Notes\n${HIGHLIGHTS_START_MARKER}\n${HIGHLIGHTS_END_MARKER}\n`;
    }
    startIdx = restOfContent.indexOf(HIGHLIGHTS_START_MARKER);
    endIdx = restOfContent.indexOf(HIGHLIGHTS_END_MARKER);
  } else if (startIdx !== -1 && endIdx === -1) {
    // Missing end marker: recover existing highlights after start marker
    const afterStart = restOfContent.slice(
      startIdx + HIGHLIGHTS_START_MARKER.length,
    );
    const cleanAfterStart = afterStart.replaceAll(HIGHLIGHTS_END_MARKER, "");
    const nextSectionIdx = cleanAfterStart.search(/\n##\s+/);

    if (nextSectionIdx !== -1) {
      const recoveredHighlights = cleanAfterStart
        .slice(0, nextSectionIdx)
        .trim();
      const remainingDoc = cleanAfterStart.slice(nextSectionIdx);
      restOfContent =
        restOfContent.slice(0, startIdx + HIGHLIGHTS_START_MARKER.length) +
        "\n" +
        recoveredHighlights +
        "\n" +
        HIGHLIGHTS_END_MARKER +
        remainingDoc;
    } else {
      const recoveredHighlights = cleanAfterStart.trim();
      restOfContent =
        restOfContent.slice(0, startIdx + HIGHLIGHTS_START_MARKER.length) +
        "\n" +
        recoveredHighlights +
        "\n" +
        HIGHLIGHTS_END_MARKER +
        "\n";
    }
    endIdx = restOfContent.indexOf(HIGHLIGHTS_END_MARKER);
  } else if (startIdx === -1 && endIdx !== -1) {
    // Missing start marker: recover highlights preceding end marker
    const beforeEnd = restOfContent.slice(0, endIdx);
    const hnIdx = beforeEnd.lastIndexOf("## Highlights & Notes");
    if (hnIdx !== -1) {
      const headerEnd = hnIdx + "## Highlights & Notes".length;
      const recoveredHighlights = beforeEnd.slice(headerEnd).trim();
      restOfContent =
        beforeEnd.slice(0, headerEnd) +
        "\n" +
        HIGHLIGHTS_START_MARKER +
        "\n" +
        recoveredHighlights +
        "\n" +
        restOfContent.slice(endIdx);
    } else {
      const recoveredHighlights = beforeEnd.trim();
      restOfContent =
        "\n## Highlights & Notes\n" +
        HIGHLIGHTS_START_MARKER +
        "\n" +
        recoveredHighlights +
        "\n" +
        restOfContent.slice(endIdx);
    }
    startIdx = restOfContent.indexOf(HIGHLIGHTS_START_MARKER);
    endIdx = restOfContent.indexOf(HIGHLIGHTS_END_MARKER);
  }

  if (startIdx !== -1 && endIdx !== -1 && endIdx >= startIdx) {
    const existingHighlights = restOfContent
      .slice(startIdx + HIGHLIGHTS_START_MARKER.length, endIdx)
      .trim();

    const isExistingEmpty =
      !existingHighlights ||
      existingHighlights === "*No highlights recorded yet.*";

    let finalHighlights: string;

    if (isExistingEmpty) {
      finalHighlights =
        incomingEntries.length > 0
          ? incomingEntries.map((e) => e.raw).join("\n\n")
          : cleanedBody || "*No highlights recorded yet.*";
    } else {
      // Deduplicate incoming entries against existing text
      const newItems: string[] = [];
      for (const entry of incomingEntries) {
        if (!isQuoteInExisting(entry.normalized, existingHighlights)) {
          newItems.push(entry.raw);
        }
      }

      if (newItems.length > 0) {
        finalHighlights = existingHighlights + "\n\n" + newItems.join("\n\n");
      } else {
        finalHighlights = existingHighlights;
      }
    }

    const before = restOfContent.slice(
      0,
      startIdx + HIGHLIGHTS_START_MARKER.length,
    );
    const after = restOfContent.slice(endIdx);
    restOfContent = `${before}\n${finalHighlights}\n${after}`;
  } else {
    // Markers missing: insert under existing "## Highlights & Notes" if present, or append
    const highlightsBlock =
      incomingEntries.length > 0
        ? incomingEntries.map((e) => e.raw).join("\n\n")
        : cleanedBody || "*No highlights recorded yet.*";

    const hnIdx = restOfContent.indexOf("## Highlights & Notes");
    if (hnIdx !== -1) {
      const headerEnd = hnIdx + "## Highlights & Notes".length;
      const before = restOfContent.slice(0, headerEnd);
      const after = restOfContent.slice(headerEnd);
      restOfContent = `${before}\n${HIGHLIGHTS_START_MARKER}\n${highlightsBlock}\n${HIGHLIGHTS_END_MARKER}${after}`;
    } else {
      restOfContent =
        restOfContent.trimEnd() +
        "\n\n## Highlights & Notes\n" +
        HIGHLIGHTS_START_MARKER +
        "\n" +
        highlightsBlock +
        "\n" +
        HIGHLIGHTS_END_MARKER +
        "\n";
    }
  }

  const cleanRest = restOfContent.replace(/^\n*/, "");
  return `${updatedFm}\n\n${cleanRest}`;
}

// ----------------------------------------------------------------------------
// 5. Note Processing & File Persistence
// ----------------------------------------------------------------------------

export async function processJoplinNote(
  payload: JoplinNotePayload,
  options: JoplinOptions = {},
): Promise<JoplinNoteResult> {
  let title = payload.title?.trim();
  const rawBody = payload.body || "";

  // 1. Derive title if omitted
  if (!title && payload.id) {
    title = decodeURIComponent(payload.id).trim();
  }
  if (!title && rawBody) {
    const match = rawBody.match(/^#\s+([^\n]+)/m);
    if (match) {
      title = match[1].trim();
    }
  }
  if (!title) {
    title = "Untitled";
  }

  const { safeTitle, notePath } = getBookNotePath(title, options.booksDir);

  // 2. Ensure destination directory exists
  const booksDir = path.dirname(notePath);
  if (!fs.existsSync(booksDir)) {
    fs.mkdirSync(booksDir, { recursive: true });
  }

  const fileExisted = fs.existsSync(notePath);
  const existingContent = fileExisted
    ? fs.readFileSync(notePath, "utf8")
    : "";

  const merged = mergeJoplinHighlights(existingContent, rawBody, title, {
    booksDir: options.booksDir,
    calibreDbPath: options.calibreDbPath,
  });

  fs.writeFileSync(notePath, merged, "utf8");

  const parsedEntries = splitHighlightEntries(
    cleanIncomingHighlightBody(rawBody, title),
  );

  return {
    id: safeTitle,
    title,
    path: notePath,
    action: fileExisted ? "updated" : "created",
    highlightCount: parsedEntries.length,
  };
}

// ----------------------------------------------------------------------------
// 6. Primary HTTP Handler for Joplin Clipper
// ----------------------------------------------------------------------------

export async function readBoundedText(
  req: Request,
  maxBytes: number,
): Promise<{ text: string; oversized: boolean }> {
  const contentLength = req.headers.get("content-length");
  if (contentLength && parseInt(contentLength, 10) > maxBytes) {
    return { text: "", oversized: true };
  }

  if (req.body && typeof req.body.getReader === "function") {
    const reader = req.body.getReader();
    const chunks: Uint8Array[] = [];
    let totalBytes = 0;
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        if (value) {
          totalBytes += value.byteLength;
          if (totalBytes > maxBytes) {
            try {
              await reader.cancel();
            } catch (_cErr) {
              void _cErr;
            }
            return { text: "", oversized: true };
          }
          chunks.push(value);
        }
      }
    } finally {
      try {
        reader.releaseLock?.();
      } catch (_lErr) {
        void _lErr;
      }
    }
    const fullBuffer = Buffer.concat(chunks);
    return { text: fullBuffer.toString("utf8"), oversized: false };
  }

  const raw = await req.text();
  if (Buffer.byteLength(raw, "utf8") > maxBytes) {
    return { text: "", oversized: true };
  }
  return { text: raw, oversized: false };
}

export async function handleJoplinRequest(
  req: Request,
  url: URL,
  options: JoplinOptions = {},
): Promise<Response> {
  const pathname = url.pathname;
  const method = req.method.toUpperCase();

  const corsHeaders: Record<string, string> = {
    "X-Content-Type-Options": "nosniff",
  };
  if (options.corsOrigin) {
    corsHeaders["Access-Control-Allow-Origin"] = options.corsOrigin;
    corsHeaders["Vary"] = "Origin";
  }

  // 1. GET /ping (KOReader Joplin Exporter reachability check)
  if (pathname === "/ping") {
    if (method !== "GET" && method !== "HEAD") {
      return new Response("Method Not Allowed", {
        status: 405,
        headers: { ...corsHeaders, Allow: "GET, HEAD" },
      });
    }
    return new Response(
      method === "HEAD" ? null : JOPLIN_CLIPPER_PING_RESPONSE,
      {
        status: 200,
        headers: {
          ...corsHeaders,
          "Content-Type": "text/plain; charset=utf-8",
        },
      },
    );
  }

  // 2. Validate Joplin Token for all other endpoints
  if (!validateJoplinToken(req, url, options.expectedToken)) {
    return new Response(
      JSON.stringify({ error: "Invalid or missing Joplin token" }),
      {
        status: 401,
        headers: {
          ...corsHeaders,
          "Content-Type": "application/json; charset=utf-8",
        },
      },
    );
  }

  // 3. /folders Endpoints
  if (pathname === "/folders" || pathname.startsWith("/folders/")) {
    if (method === "GET") {
      if (pathname === "/folders") {
        return new Response(
          JSON.stringify({
            items: [
              { id: JOPLIN_FOLDER_ID, title: JOPLIN_FOLDER_TITLE },
            ],
            has_more: false,
          }),
          {
            status: 200,
            headers: {
              ...corsHeaders,
              "Content-Type": "application/json; charset=utf-8",
            },
          },
        );
      } else {
        const folderId = pathname.slice("/folders/".length);
        return new Response(
          JSON.stringify({
            id: folderId || JOPLIN_FOLDER_ID,
            title: JOPLIN_FOLDER_TITLE,
          }),
          {
            status: 200,
            headers: {
              ...corsHeaders,
              "Content-Type": "application/json; charset=utf-8",
            },
          },
        );
      }
    }

    if (method === "POST") {
      let folderTitle = JOPLIN_FOLDER_TITLE;
      const readResult = await readBoundedText(req, 64 * 1024);
      if (readResult.oversized) {
        return new Response(
          JSON.stringify({ error: "Payload too large (max 64KB)" }),
          {
            status: 413,
            headers: {
              ...corsHeaders,
              "Content-Type": "application/json; charset=utf-8",
            },
          },
        );
      }
      try {
        if (readResult.text.trim()) {
          const body = JSON.parse(readResult.text);
          if (body?.title) folderTitle = body.title;
        }
      } catch (_jsonErr) {
        void _jsonErr;
      }

      return new Response(
        JSON.stringify({ id: JOPLIN_FOLDER_ID, title: folderTitle }),
        {
          status: 200,
          headers: {
            ...corsHeaders,
            "Content-Type": "application/json; charset=utf-8",
          },
        },
      );
    }

    return new Response(JSON.stringify({ error: "Method Not Allowed" }), {
      status: 405,
      headers: { ...corsHeaders, Allow: "GET, POST" },
    });
  }

  // 4. /notes Endpoints
  if (pathname === "/notes" || pathname.startsWith("/notes/")) {
    const isSubPath =
      pathname.startsWith("/notes/") && pathname.length > "/notes/".length;
    const noteId = isSubPath ? pathname.slice("/notes/".length) : undefined;

    if (method === "GET") {
      if (!isSubPath) {
        // GET /notes -> { items: [], has_more: false }
        return new Response(
          JSON.stringify({ items: [], has_more: false }),
          {
            status: 200,
            headers: {
              ...corsHeaders,
              "Content-Type": "application/json; charset=utf-8",
            },
          },
        );
      } else {
        return new Response(
          JSON.stringify({
            id: noteId,
            title: decodeURIComponent(noteId || "Untitled"),
          }),
          {
            status: 200,
            headers: {
              ...corsHeaders,
              "Content-Type": "application/json; charset=utf-8",
            },
          },
        );
      }
    }

    if (method === "POST" || method === "PUT") {
      const readResult = await readBoundedText(req, MAX_JOPLIN_BODY_BYTES);
      if (readResult.oversized) {
        return new Response(
          JSON.stringify({ error: "Payload too large (max 5MB)" }),
          {
            status: 413,
            headers: {
              ...corsHeaders,
              "Content-Type": "application/json; charset=utf-8",
            },
          },
        );
      }

      let payload: JoplinNotePayload = {};
      try {
        if (readResult.text.trim()) {
          payload = JSON.parse(readResult.text);
        }
      } catch (_err) {
        void _err;
        return new Response(
          JSON.stringify({ error: "Invalid JSON payload" }),
          {
            status: 400,
            headers: {
              ...corsHeaders,
              "Content-Type": "application/json; charset=utf-8",
            },
          },
        );
      }

      if (noteId && !payload.id) {
        payload.id = noteId;
      }

      try {
        const result = await processJoplinNote(payload, options);
        return new Response(
          JSON.stringify({ id: result.id, title: result.title }),
          {
            status: 200,
            headers: {
              ...corsHeaders,
              "Content-Type": "application/json; charset=utf-8",
            },
          },
        );
      } catch (err: any) {
        return new Response(
          JSON.stringify({
            error:
              sanitizeErrorMessage(err) || "Failed to process Joplin note",
          }),
          {
            status: 500,
            headers: {
              ...corsHeaders,
              "Content-Type": "application/json; charset=utf-8",
            },
          },
        );
      }
    }

    return new Response(JSON.stringify({ error: "Method Not Allowed" }), {
      status: 405,
      headers: { ...corsHeaders, Allow: "GET, POST, PUT" },
    });
  }

  return new Response(JSON.stringify({ error: "Not Found" }), {
    status: 404,
    headers: {
      ...corsHeaders,
      "Content-Type": "application/json; charset=utf-8",
    },
  });
}
