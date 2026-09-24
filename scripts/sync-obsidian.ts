#!/usr/bin/env bun
/**
 * scripts/sync-obsidian.ts
 *
 * LightHouse Automated Highlight and Note Synchronization to Obsidian:
 *   - Extracts highlights, notes, page numbers, chapters, and timestamps from:
 *       * KOReader .sdr sidecar directories (metadata.epub.lua, metadata.*.lua)
 *       * Calibre library and any connected Kindle/KOReader storage or mounts
 *       * Kindle My Clippings.txt
 *   - Merges with KOSync reading progress percentage from koreader-sync.db and Calibre metadata.
 *   - Outputs structured Markdown notes with YAML frontmatter to <vault>/Books/<Sanitized_Title>.md.
 *   - Idempotent section markers (<!-- lighthouse:highlights:start --> and <!-- lighthouse:highlights:end -->)
 *     preserve user manual edits and notes across repeated syncs.
 *   - Supports CLI flags: --vault-path <path>, --dry-run, --apply, --watch.
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { Database } from "bun:sqlite";
import {
  getHighlightsCacheDb,
  batchUpsertHighlights,
  cleanQuoteText,
} from "../uploader/highlights";

// ----------------------------------------------------------------------------
// Interfaces & Types
// ----------------------------------------------------------------------------

export type LuaPrimitive = string | number | boolean | null;
export type LuaTable = { [key: string | number]: LuaValue } | LuaValue[];
export type LuaValue = LuaPrimitive | LuaTable;

export interface HighlightEntry {
  text: string;
  notes?: string;
  chapter?: string;
  page?: number | string;
  datetime?: string;
  timestamp?: number;
}

export interface BookSyncData {
  title: string;
  author: string;
  series?: string;
  seriesIndex?: number | string;
  synopsis?: string;
  progress?: number; // 0-100 percentage integer
  status?: "reading" | "finished" | "unread";
  lastReadDate?: string;
  highlights: HighlightEntry[];
  sourceFile?: string;
  bookId?: number;
}

export interface SyncObsidianOptions {
  vaultPath?: string;
  calibreDbPath?: string;
  kosyncDbPath?: string;
  libraryDir?: string;
  extraSearchPaths?: string[];
  dryRun?: boolean;
  apply?: boolean;
  watch?: boolean;
  verbose?: boolean;
  books?: BookSyncData[]; // Test injection
}

export interface SyncResultItem {
  title: string;
  author: string;
  filename: string;
  outputPath: string;
  highlightCount: number;
  progress: number;
  status: "reading" | "finished" | "unread";
  action: "created" | "updated" | "skipped";
  error?: string;
}

export interface SyncObsidianResult {
  vaultPath: string;
  dryRun: boolean;
  totalBooksScanned: number;
  totalHighlightsFound: number;
  notesCreated: number;
  notesUpdated: number;
  notesSkipped: number;
  items: SyncResultItem[];
  errors: Array<{ title: string; error: string }>;
}

export const HIGHLIGHTS_START_MARKER = "<!-- lighthouse:highlights:start -->";
export const HIGHLIGHTS_END_MARKER = "<!-- lighthouse:highlights:end -->";
export const DEFAULT_VAULT_PATH = path.join(os.homedir(), "Obsidian");

/**
 * Normalizes reading progress values:
 * - Decimals <= 1.0 (e.g. 0.653 or 1.0) are treated as ratios -> 65% or 100%.
 * - Numbers > 1 (e.g. 45 or 88.9) are treated as integer percentages clamped to 0..100.
 */
export function normalizeProgress(value: number | undefined | null): number {
  if (value === undefined || value === null || Number.isNaN(value)) return 0;
  if (value > 0 && value <= 1) {
    return Math.round(value * 100);
  }
  return Math.max(0, Math.min(100, Math.round(value)));
}

// ----------------------------------------------------------------------------
// 1. Pure TypeScript Lua Table Parser
// ----------------------------------------------------------------------------

/**
 * Robust, zero-dependency parser for Lua table literals found in KOReader metadata.*.lua files.
 */
export function parseLuaTable(str: string): LuaValue {
  let pos = 0;

  function skipWhitespaceAndComments(): void {
    while (pos < str.length) {
      const c = str[pos];
      if (c === " " || c === "\t" || c === "\n" || c === "\r") {
        pos++;
        continue;
      }
      if (c === "-" && str[pos + 1] === "-") {
        if (str.slice(pos, pos + 4) === "--[[") {
          const end = str.indexOf("]]", pos + 4);
          pos = end === -1 ? str.length : end + 2;
        } else {
          const end = str.indexOf("\n", pos + 2);
          pos = end === -1 ? str.length : end + 1;
        }
        continue;
      }
      break;
    }
  }

  function parseString(quote: string): string {
    pos++; // skip opening quote
    let res = "";
    while (pos < str.length) {
      const c = str[pos];
      if (c === quote) {
        pos++;
        return res;
      }
      if (c === "\\") {
        pos++;
        if (pos >= str.length) {
          break;
        }
        const next = str[pos];
        if (next === "n") {
          res += "\n";
        } else if (next === "r") {
          res += "\r";
        } else if (next === "t") {
          res += "\t";
        } else if (next === "\\") {
          res += "\\";
        } else if (next === quote) {
          res += quote;
        } else if (next === "\n") {
          res += "\n";
        } else if (next === "z") {
          pos++;
          while (pos < str.length && /\s/.test(str[pos])) {
            pos++;
          }
          continue;
        } else if (/\d/.test(next)) {
          let numStr = "";
          while (pos < str.length && /\d/.test(str[pos]) && numStr.length < 3) {
            numStr += str[pos++];
          }
          res += String.fromCharCode(parseInt(numStr, 10));
          continue;
        } else {
          res += next;
        }
        pos++;
      } else {
        res += c;
        pos++;
      }
    }
    return res;
  }

  function parseLongString(): string {
    pos += 2; // skip [[
    const end = str.indexOf("]]", pos);
    if (end === -1) {
      const s = str.slice(pos);
      pos = str.length;
      return s;
    }
    const s = str.slice(pos, end);
    pos = end + 2;
    return s;
  }

  function parseValue(): LuaValue {
    skipWhitespaceAndComments();
    if (pos >= str.length) {
      return null;
    }

    const c = str[pos];
    if (c === "{") {
      return parseTable();
    }
    if (c === '"' || c === "'") {
      return parseString(c);
    }
    if (c === "[" && str[pos + 1] === "[") {
      return parseLongString();
    }
    if (c === "-" || c === "+" || (c >= "0" && c <= "9")) {
      const start = pos;
      if (c === "-" || c === "+") {
        pos++;
      }
      if (str.slice(pos, pos + 2).toLowerCase() === "0x") {
        pos += 2;
        while (pos < str.length && /[0-9a-fA-F]/.test(str[pos])) {
          pos++;
        }
        return parseInt(str.slice(start, pos), 16);
      }
      while (pos < str.length && /[0-9.eE+-]/.test(str[pos])) {
        if (
          (str[pos] === "e" || str[pos] === "E") &&
          (str[pos + 1] === "+" || str[pos + 1] === "-")
        ) {
          pos += 2;
        } else {
          pos++;
        }
      }
      const numStr = str.slice(start, pos);
      return parseFloat(numStr);
    }

    const idStart = pos;
    while (pos < str.length && /[a-zA-Z0-9_]/.test(str[pos])) {
      pos++;
    }
    const id = str.slice(idStart, pos);

    if (id === "true") return true;
    if (id === "false") return false;
    if (id === "nil") return null;
    if (id === "return") {
      return parseValue();
    }
    return id;
  }

  function parseTable(): LuaTable {
    pos++; // skip {
    const obj: Record<string | number, LuaValue> = {};
    let autoIndex = 1;

    while (pos < str.length) {
      skipWhitespaceAndComments();
      if (str[pos] === "}") {
        pos++;
        break;
      }

      let key: string | number;
      if (str[pos] === "[") {
        pos++; // skip [
        skipWhitespaceAndComments();
        key = String(parseValue());
        skipWhitespaceAndComments();
        if (str[pos] === "]") pos++;
        skipWhitespaceAndComments();
        if (str[pos] === "=") pos++;
      } else if (/[a-zA-Z_]/.test(str[pos])) {
        const idStart = pos;
        while (pos < str.length && /[a-zA-Z0-9_]/.test(str[pos])) {
          pos++;
        }
        const id = str.slice(idStart, pos);
        skipWhitespaceAndComments();
        if (str[pos] === "=") {
          pos++;
          key = id;
        } else {
          key = autoIndex++;
          pos = idStart;
        }
      } else {
        key = autoIndex++;
      }

      const val = parseValue();
      obj[key] = val;

      skipWhitespaceAndComments();
      if (str[pos] === "," || str[pos] === ";") {
        pos++;
      }
    }

    // If keys are contiguous 1..N numbers, return an Array
    const keys = Object.keys(obj);
    if (
      keys.length > 0 &&
      keys.every((k, idx) => String(k) === String(idx + 1))
    ) {
      return keys.map((k) => obj[k]);
    }

    return obj;
  }

  return parseValue();
}

/**
 * Extracts highlights, notes, and metadata from KOReader Lua table object or string.
 */
export function extractHighlightsFromLua(content: string | unknown): {
  title?: string;
  author?: string;
  description?: string;
  percentFinished?: number;
  highlights: HighlightEntry[];
} {
  const data = (typeof content === "string" ? parseLuaTable(content) : content) as any;
  if (!data || typeof data !== "object") {
    return { highlights: [] };
  }

  const docProps = data.doc_props || {};
  const stats = data.stats || {};

  const title =
    docProps.title ||
    stats.title ||
    data.title ||
    (typeof data.doc_path === "string"
      ? path.basename(data.doc_path, path.extname(data.doc_path))
      : undefined);

  let author = docProps.authors || stats.authors || data.author || data.authors;
  if (author === "N/A" || author === "Unknown") {
    author = undefined;
  }

  const description = docProps.description || data.description;
  let percentFinished: number | undefined;
  if (typeof data.percent_finished === "number") {
    percentFinished = data.percent_finished;
  } else if (typeof data.progress === "number") {
    percentFinished = data.progress;
  }

  const highlights: HighlightEntry[] = [];

  // Extract from annotations or bookmarks
  const rawList =
    data.annotations || data.bookmarks || data.entries || data.highlights;

  if (Array.isArray(rawList)) {
    for (const item of rawList) {
      const h = parseHighlightEntry(item);
      if (h) highlights.push(h);
    }
  } else if (rawList && typeof rawList === "object") {
    for (const key of Object.keys(rawList)) {
      const item = rawList[key];
      const h = parseHighlightEntry(item);
      if (h) highlights.push(h);
    }
  }

  // Sort highlights chronologically or by page number if available
  highlights.sort((a, b) => {
    if (a.page !== undefined && b.page !== undefined && a.page !== b.page) {
      const numA = typeof a.page === "number" ? a.page : parseInt(String(a.page), 10);
      const numB = typeof b.page === "number" ? b.page : parseInt(String(b.page), 10);
      if (!Number.isNaN(numA) && !Number.isNaN(numB)) {
        return numA - numB;
      }
    }
    if (a.datetime && b.datetime) {
      return a.datetime.localeCompare(b.datetime);
    }
    return 0;
  });

  return {
    title,
    author,
    description,
    percentFinished,
    highlights,
  };
}

function parseHighlightEntry(item: any): HighlightEntry | null {
  if (!item || typeof item !== "object") return null;

  const text = item.text || item.highlight || item.quote;
  const notes = item.notes || item.note || item.comment || "";
  const chapter = item.chapter || item.chapter_name;
  const rawPage = item.pageno !== undefined ? item.pageno : item.page;
  const page = rawPage === undefined ? undefined : rawPage;
  const datetime =
    item.datetime || item.date || item.created_at || item.time || "";

  if (!text && !notes) return null;

  return {
    text: (text || "").trim(),
    notes: (notes || "").trim() || undefined,
    chapter: (chapter || "").trim() || undefined,
    page,
    datetime: datetime ? String(datetime).trim() : undefined,
  };
}

// ----------------------------------------------------------------------------
// 2. Kindle My Clippings Parser
// ----------------------------------------------------------------------------

/**
 * Parses Kindle "My Clippings.txt" format into structured book highlights.
 */
export function extractKindleClippings(
  content: string,
): Map<string, { title: string; author: string; highlights: HighlightEntry[] }> {
  const books = new Map<
    string,
    { title: string; author: string; highlights: HighlightEntry[] }
  >();

  if (!content) return books;

  const sections = content.split(/={5,}/);

  for (const section of sections) {
    const lines = section
      .split("\n")
      .map((l) => l.trim())
      .filter(Boolean);
    if (lines.length < 2) continue;

    // Line 1: Title (Author)
    const header = lines[0];
    let title = header;
    let author = "Unknown";

    const authorMatch = header.match(/\(([^()]+)\)$/);
    if (authorMatch) {
      author = authorMatch[1].trim();
      title = header.slice(0, header.lastIndexOf("(")).trim();
    }

    // Line 2: - Your Highlight on page 45 | Location 680-682 | Added on Thursday, May 18, 2023...
    const metaLine = lines[1];
    let page: number | undefined;
    let datetime: string | undefined;

    const pageMatch = metaLine.match(/page\s+([0-9]+)/i);
    if (pageMatch) {
      page = parseInt(pageMatch[1], 10);
    } else {
      const locMatch = metaLine.match(/location\s+([0-9]+)/i);
      if (locMatch) page = parseInt(locMatch[1], 10);
    }

    const dateMatch = metaLine.match(/Added on\s+(.+)$/i);
    if (dateMatch) {
      datetime = dateMatch[1].trim();
    }

    const isNote = /note/i.test(metaLine);
    const bodyLines = lines.slice(2).join("\n").trim();
    if (!bodyLines) continue;

    const key = `${title.toLowerCase()}___${author.toLowerCase()}`;
    let bookEntry = books.get(key);
    if (!bookEntry) {
      bookEntry = { title, author, highlights: [] };
      books.set(key, bookEntry);
    }

    if (isNote) {
      const prev = bookEntry.highlights.at(-1);
      if (prev && prev.page === page && !prev.notes) {
        prev.notes = bodyLines;
      } else {
        bookEntry.highlights.push({
          text: "",
          notes: bodyLines,
          page,
          datetime,
        });
      }
    } else {
      bookEntry.highlights.push({
        text: bodyLines,
        page,
        datetime,
      });
    }
  }

  return books;
}

// ----------------------------------------------------------------------------
// 3. Synopsis & Text Formatting Helpers
// ----------------------------------------------------------------------------

/**
 * Strips HTML formatting, normalizes entities, and formats synopsis paragraphs for Markdown.
 */
export function formatSynopsis(comments: string | null | undefined): string {
  if (!comments || typeof comments !== "string") {
    return "*No synopsis available.*";
  }

  let text = comments.normalize("NFC");

  // Replace block tags with newlines
  text = text.replace(/<\/(p|div|h[1-6]|li|blockquote)>/gi, "\n\n");
  text = text.replace(/<br\s*\/?>/gi, "\n");

  // Strip all other HTML tags
  text = text.replace(/<[^>]+>/g, "");

  // Unescape standard HTML entities
  text = text
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&apos;/g, "'")
    .replace(/&nbsp;/g, " ")
    .replace(/&#(\d+);/g, (_, dec) => String.fromCharCode(parseInt(dec, 10)))
    .replace(/&#x([0-9a-fA-F]+);/g, (_, hex) =>
      String.fromCharCode(parseInt(hex, 16)),
    );

  // Collapse 3+ newlines to 2 and trim
  text = text
    .split("\n")
    .map((l) => l.trim())
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();

  return text || "*No synopsis available.*";
}

/**
 * Computes a visual reading progress bar (e.g. 45% -> [████░░░░]).
 */
export function renderProgressBar(percentage: number, length = 8): string {
  const normPct = normalizeProgress(percentage);
  const ratio = normPct / 100;
  const clamped = Math.max(0, Math.min(1, ratio));
  const filled = Math.round(clamped * length);
  const empty = length - filled;
  return "█".repeat(filled) + "░".repeat(empty);
}

/**
 * Sanitizes book titles for filesystem and Obsidian note paths.
 */
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

// ----------------------------------------------------------------------------
// 4. Markdown Generation & Idempotent Preservation
// ----------------------------------------------------------------------------

/**
 * Generates the highlights section bounded by idempotent markers.
 */
export function generateHighlightsSection(
  highlights: HighlightEntry[],
): string {
  const lines: string[] = [HIGHLIGHTS_START_MARKER];

  if (!highlights || highlights.length === 0) {
    lines.push("*No highlights recorded yet.*");
  } else {
    highlights.forEach((h, idx) => {
      if (idx > 0) lines.push("");

      if (h.text) {
        const quoteLines = h.text
          .split("\n")
          .map((l) => `> ${l.trim()}`)
          .join("\n");
        lines.push(quoteLines);
      }

      const metaParts: string[] = [];
      if (h.chapter) metaParts.push(`*${h.chapter}*`);
      if (h.page !== undefined && h.page !== null && h.page !== "") {
        metaParts.push(`Page ${h.page}`);
      }
      if (h.datetime) metaParts.push(h.datetime);

      if (metaParts.length > 0) {
        lines.push(`— ${metaParts.join(", ")}`);
      }

      if (h.notes) {
        lines.push(`**Note:** ${h.notes}`);
      }
    });
  }

  lines.push(HIGHLIGHTS_END_MARKER);
  return lines.join("\n");
}

/**
 * Generates complete new book note with YAML frontmatter, synopsis, progress, and highlights.
 */
export function generateBookMarkdown(data: BookSyncData): string {
  const title = data.title || "Untitled";
  const author = data.author || "Unknown";
  const progressPct = normalizeProgress(data.progress);

  let status = data.status;
  if (!status) {
    if (progressPct >= 99) {
      status = "finished";
    } else if (progressPct > 0) {
      status = "reading";
    } else {
      status = "unread";
    }
  }

  const dateSynced = new Date().toISOString();
  const progressBar = renderProgressBar(progressPct, 8);
  const synopsis = formatSynopsis(data.synopsis);

  const frontmatter = [
    "---",
    `title: ${JSON.stringify(title)}`,
    `author: ${JSON.stringify(author)}`,
  ];
  if (data.series) {
    const seriesStr = data.seriesIndex
      ? `${data.series} #${data.seriesIndex}`
      : data.series;
    frontmatter.push(`series: ${JSON.stringify(seriesStr)}`);
  }
  frontmatter.push(
    `progress: ${progressPct}`,
    `status: ${status}`,
    "tags:",
    "  - book-notes",
    "  - lighthouse",
    "  - reading",
    `date_synced: ${dateSynced}`,
    "---",
  );

  const highlightsBlock = generateHighlightsSection(data.highlights);

  const sections = [
    frontmatter.join("\n"),
    "",
    `# ${title}`,
    "",
    synopsis,
    "",
    `**Progress:** ${progressPct}% [${progressBar}]`,
  ];

  if (data.lastReadDate) {
    sections.push(`**Last Read:** ${data.lastReadDate}`);
  }

  sections.push("", "## Highlights & Notes", highlightsBlock, "");

  return sections.join("\n");
}

/**
 * Idempotently merges new highlights and updated frontmatter into an existing Obsidian note.
 * Preserves user edits, custom notes outside the markers, and any custom frontmatter fields.
 * Refreshes live reading progress bar and last-read timestamp.
 */
export function mergeNoteContent(
  existingContent: string,
  data: BookSyncData,
): string {
  if (!existingContent || !existingContent.trim()) {
    return generateBookMarkdown(data);
  }

  const newHighlightsBlock = generateHighlightsSection(data.highlights);
  const progressPct = normalizeProgress(data.progress);

  let status = data.status;
  if (!status) {
    if (progressPct >= 99) {
      status = "finished";
    } else if (progressPct > 0) {
      status = "reading";
    } else {
      status = "unread";
    }
  }

  const dateSynced = new Date().toISOString();
  const progressBar = renderProgressBar(progressPct, 8);
  let content = existingContent;

  // 1. Update YAML Frontmatter if present
  if (content.startsWith("---")) {
    const secondDelim = content.indexOf("\n---", 3);
    if (secondDelim !== -1) {
      const rawFm = content.slice(4, secondDelim);
      const restOfDoc = content.slice(secondDelim + 4);

      const fmMap = new Map<string, string>();
      const tagLines: string[] = [];
      let inTags = false;

      for (const line of rawFm.split("\n")) {
        const trimmed = line.trim();
        if (trimmed.startsWith("tags:")) {
          inTags = true;
          continue;
        }
        if (inTags) {
          if (trimmed.startsWith("-")) {
            tagLines.push(trimmed);
            continue;
          }
          inTags = false;
        }
        const eqIdx = line.indexOf(":");
        if (eqIdx !== -1) {
          const k = line.slice(0, eqIdx).trim();
          const v = line.slice(eqIdx + 1).trim();
          fmMap.set(k, v);
        }
      }

      // Update standard keys
      fmMap.set("progress", String(progressPct));
      fmMap.set("status", status);
      fmMap.set("date_synced", dateSynced);
      if (data.title && !fmMap.has("title")) {
        fmMap.set("title", JSON.stringify(data.title));
      }
      if (data.author && !fmMap.has("author")) {
        fmMap.set("author", JSON.stringify(data.author));
      }
      if (data.series && !fmMap.has("series")) {
        const sStr = data.seriesIndex
          ? `${data.series} #${data.seriesIndex}`
          : data.series;
        fmMap.set("series", JSON.stringify(sStr));
      }

      // Ensure standard tags
      const defaultTags = ["- book-notes", "- lighthouse", "- reading"];
      for (const dt of defaultTags) {
        if (!tagLines.includes(dt)) {
          tagLines.push(dt);
        }
      }

      const rebuiltFm = ["---"];
      for (const [k, v] of fmMap.entries()) {
        rebuiltFm.push(`${k}: ${v}`);
      }
      rebuiltFm.push("tags:");
      for (const tl of tagLines) {
        rebuiltFm.push(`  ${tl.replace(/^[-\s]+/, "- ")}`);
      }
      rebuiltFm.push("---");

      content = rebuiltFm.join("\n") + restOfDoc;
    }
  }

  // 2. Refresh live Progress Bar & Last Read in note body
  const progressLineRegex = /^\*\*Progress:\*\*.*$/m;
  const newProgressLine = `**Progress:** ${progressPct}% [${progressBar}]`;
  if (progressLineRegex.test(content)) {
    content = content.replace(progressLineRegex, newProgressLine);
  }

  if (data.lastReadDate) {
    const lastReadLineRegex = /^\*\*Last Read:\*\*.*$/m;
    const newLastReadLine = `**Last Read:** ${data.lastReadDate}`;
    if (lastReadLineRegex.test(content)) {
      content = content.replace(lastReadLineRegex, newLastReadLine);
    } else if (progressLineRegex.test(content)) {
      content = content.replace(newProgressLine, `${newProgressLine}\n${newLastReadLine}`);
    }
  }

  // 3. Update Highlights Section bounded by markers
  const startIdx = content.indexOf(HIGHLIGHTS_START_MARKER);
  const endIdx = content.indexOf(HIGHLIGHTS_END_MARKER);

  if (startIdx !== -1 && endIdx !== -1 && endIdx >= startIdx) {
    const existingBlock = content.slice(
      startIdx + HIGHLIGHTS_START_MARKER.length,
      endIdx,
    );
    const existingHasHighlights =
      existingBlock.includes("> ") ||
      (existingBlock.trim() !== "" &&
        !existingBlock.includes("*No highlights recorded yet.*"));

    // If incoming highlights are empty and existing note already has highlights, preserve them!
    if (data.highlights.length === 0 && existingHasHighlights) {
      // Keep existing highlights block untouched, only frontmatter and progress were refreshed
    } else {
      const before = content.slice(0, startIdx);
      const after = content.slice(endIdx + HIGHLIGHTS_END_MARKER.length);
      content = before + newHighlightsBlock + after;
    }
  } else {
    content =
      content.trimEnd() +
      "\n\n## Highlights & Notes\n" +
      newHighlightsBlock +
      "\n";
  }

  return content;
}

// ----------------------------------------------------------------------------
// 5. Vault Path & Database Resolution
// ----------------------------------------------------------------------------

export function resolveVaultPath(cliVaultPath?: string): string {
  if (cliVaultPath && cliVaultPath.trim()) {
    return path.resolve(cliVaultPath.trim());
  }
  if (process.env.OBSIDIAN_VAULT_PATH && process.env.OBSIDIAN_VAULT_PATH.trim()) {
    return path.resolve(process.env.OBSIDIAN_VAULT_PATH.trim());
  }
  return DEFAULT_VAULT_PATH;
}

export const LIGHTHOUSE_ROOT =
  process.env.LIGHTHOUSE_ROOT ||
  path.resolve((import.meta as { dir?: string }).dir || process.cwd(), "..");

export function getCalibreDbPath(): string {
  if (process.env.CALIBRE_DB_PATH) {
    return path.isAbsolute(process.env.CALIBRE_DB_PATH)
      ? process.env.CALIBRE_DB_PATH
      : path.resolve(LIGHTHOUSE_ROOT, process.env.CALIBRE_DB_PATH);
  }
  if (process.env.CALIBRE_LIBRARY_DIR) {
    const libDir = path.isAbsolute(process.env.CALIBRE_LIBRARY_DIR)
      ? process.env.CALIBRE_LIBRARY_DIR
      : path.resolve(LIGHTHOUSE_ROOT, process.env.CALIBRE_LIBRARY_DIR);
    return path.join(libDir, "metadata.db");
  }
  const home = process.env.HOME || os.homedir();
  return path.join(home, "Calibre Libraries", "Agent Library", "metadata.db");
}

export function getKosyncDbPath(): string {
  if (process.env.KOSYNC_DB_PATH) {
    return path.resolve(process.env.KOSYNC_DB_PATH);
  }
  const home = process.env.HOME || os.homedir();
  return path.join(home, "kosync-server", "data", "koreader-sync.db");
}

// ----------------------------------------------------------------------------
// 6. Source Discovery & Calibre / KOSync Merging
// ----------------------------------------------------------------------------

export function findSdrDirectories(
  rootDirs: string[],
  maxDepth = 5,
): string[] {
  const sdrDirs: string[] = [];
  const visited = new Set<string>();

  function walk(currentDir: string, depth: number) {
    if (depth > maxDepth || visited.has(currentDir)) return;
    visited.add(currentDir);

    try {
      if (!fs.existsSync(currentDir)) return;
      const entries = fs.readdirSync(currentDir, { withFileTypes: true });

      for (const entry of entries) {
        const fullPath = path.join(currentDir, entry.name);
        if (entry.isDirectory()) {
          if (entry.name.endsWith(".sdr")) {
            try {
              const subFiles = fs.readdirSync(fullPath);
              if (subFiles.some((f: string) => f.endsWith(".lua"))) {
                sdrDirs.push(fullPath);
              }
            } catch (_readErr) {
              void _readErr;
            }
          } else if (!entry.name.startsWith(".")) {
            walk(fullPath, depth + 1);
          }
        }
      }
    } catch (_dirErr) {
      void _dirErr;
    }
  }

  for (const dir of rootDirs) {
    if (dir && fs.existsSync(dir)) {
      walk(dir, 0);
    }
  }

  return sdrDirs;
}

export function findKindleClippingsFiles(searchPaths: string[]): string[] {
  const clippingFiles: string[] = [];
  for (const sp of searchPaths) {
    try {
      if (!fs.existsSync(sp)) continue;
      const direct = path.join(sp, "My Clippings.txt");
      if (fs.existsSync(direct)) clippingFiles.push(direct);

      const docs = path.join(sp, "documents", "My Clippings.txt");
      if (fs.existsSync(docs)) clippingFiles.push(docs);
    } catch (_spErr) {
      void _spErr;
    }
  }
  return clippingFiles;
}

export function getKosyncProgressMap(
  kosyncDbPath: string,
): Map<string, { progress: number; timestamp?: number }> {
  const map = new Map<string, { progress: number; timestamp?: number }>();
  if (!fs.existsSync(kosyncDbPath)) return map;

  let db: Database | null = null;
  try {
    db = new Database(kosyncDbPath, { readonly: true });
    const rows = db
      .query(
        "SELECT title, filename, percentage, timestamp FROM progress ORDER BY timestamp DESC;",
      )
      .all() as any[];

    for (const r of rows) {
      const pct = normalizeProgress(r.percentage);
      if (r.title) {
        const normTitle = r.title.toLowerCase().trim();
        if (!map.has(normTitle)) {
          map.set(normTitle, { progress: pct, timestamp: r.timestamp });
        }
      }
      if (r.filename) {
        const normFile = r.filename
          .replace(/\.epub$/i, "")
          .toLowerCase()
          .trim();
        if (!map.has(normFile)) {
          map.set(normFile, { progress: pct, timestamp: r.timestamp });
        }
      }
    }
  } catch (_dbErr) {
    void _dbErr;
  } finally {
    try {
      db?.close();
    } catch (_closeErr) {
      void _closeErr;
    }
  }

  return map;
}

export function getCalibreBooksMap(calibreDbPath: string): Map<
  string,
  {
    id: number;
    title: string;
    authors: string;
    series?: string;
    seriesIndex?: number;
    comments?: string;
  }
> {
  const map = new Map<
    string,
    {
      id: number;
      title: string;
      authors: string;
      series?: string;
      seriesIndex?: number;
      comments?: string;
    }
  >();

  if (!fs.existsSync(calibreDbPath)) return map;

  let db: Database | null = null;
  try {
    db = new Database(calibreDbPath, { readonly: true });
    db.run("PRAGMA busy_timeout = 3000;");

    const hasCommentsTable = Boolean(
      db
        .query(
          "SELECT 1 FROM sqlite_master WHERE type='table' AND name='comments' LIMIT 1;",
        )
        .get(),
    );

    const rows = hasCommentsTable
      ? (db
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
             GROUP BY b.id;`,
          )
          .all() as any[])
      : (db
          .query(
            `SELECT b.id, b.title,
                    GROUP_CONCAT(DISTINCT a.name) as authors,
                    s.name as series, b.series_index,
                    NULL as comments
             FROM books b
             LEFT JOIN books_authors_link bal ON b.id = bal.book
             LEFT JOIN authors a ON bal.author = a.id
             LEFT JOIN books_series_link bsl ON b.id = bsl.book
             LEFT JOIN series s ON bsl.series = s.id
             GROUP BY b.id;`,
          )
          .all() as any[]);

    for (const r of rows) {
      if (r.title) {
        const entry = {
          id: r.id,
          title: r.title,
          authors: r.authors || "Unknown",
          series: r.series || undefined,
          seriesIndex: r.series_index || undefined,
          comments: r.comments || undefined,
        };
        map.set(r.title.toLowerCase().trim(), entry);
        map.set(String(r.id), entry);
      }
    }
  } catch (_dbErr) {
    void _dbErr;
  } finally {
    try {
      db?.close();
    } catch (_closeErr) {
      void _closeErr;
    }
  }

  return map;
}

// ----------------------------------------------------------------------------
// 7. Main Sync Engine Function
// ----------------------------------------------------------------------------

export async function syncObsidian(
  options: SyncObsidianOptions = {},
): Promise<SyncObsidianResult> {
  const vaultPath = resolveVaultPath(options.vaultPath);
  const booksDir = path.join(vaultPath, "Books");
  const dryRun = options.dryRun ?? !options.apply;

  const calibreDbPath = options.calibreDbPath || getCalibreDbPath();
  const kosyncDbPath = options.kosyncDbPath || getKosyncDbPath();
  const libraryDir = options.libraryDir || path.dirname(calibreDbPath);

  const calibreMap = getCalibreBooksMap(calibreDbPath);
  const kosyncMap = getKosyncProgressMap(kosyncDbPath);

  const booksMap = new Map<string, BookSyncData>();

  function addOrMergeBook(incoming: BookSyncData) {
    const key = `${incoming.title.toLowerCase().trim()}___${(incoming.author || "unknown").toLowerCase().trim()}`;
    const existing = booksMap.get(key);
    if (!existing) {
      booksMap.set(key, { ...incoming, highlights: [...incoming.highlights] });
      return;
    }

    // Merge highlights with deduplication
    const seen = new Set<string>();
    const mergedHighlights: HighlightEntry[] = [];
    for (const h of existing.highlights) {
      const hKey = `${(h.text || "").trim()}___${h.page ?? ""}___${h.datetime ?? ""}`;
      seen.add(hKey);
      mergedHighlights.push(h);
    }
    for (const h of incoming.highlights) {
      const hKey = `${(h.text || "").trim()}___${h.page ?? ""}___${h.datetime ?? ""}`;
      if (!seen.has(hKey)) {
        seen.add(hKey);
        mergedHighlights.push(h);
      }
    }
    existing.highlights = mergedHighlights;

    // Maximize progress and preserve non-empty metadata
    const exProg = normalizeProgress(existing.progress);
    const inProg = normalizeProgress(incoming.progress);
    existing.progress = Math.max(exProg, inProg);
    if (!existing.synopsis && incoming.synopsis) existing.synopsis = incoming.synopsis;
    if (!existing.series && incoming.series) existing.series = incoming.series;
    if (!existing.lastReadDate && incoming.lastReadDate) existing.lastReadDate = incoming.lastReadDate;
    if (!existing.bookId && incoming.bookId) existing.bookId = incoming.bookId;
  }

  // 1. If books are explicitly provided, use them
  if (options.books && options.books.length > 0) {
    for (const b of options.books) {
      addOrMergeBook(b);
    }
  } else {
    // 2. Discover .sdr directories
    const searchRoots = [libraryDir, ...(options.extraSearchPaths || [])];

    try {
      if (fs.existsSync("/Volumes")) {
        const vEntries = fs.readdirSync("/Volumes", { withFileTypes: true });
        for (const ve of vEntries) {
          if (ve.isDirectory() && !ve.name.startsWith(".")) {
            searchRoots.push(path.join("/Volumes", ve.name));
          }
        }
      }
    } catch (_volErr) {
      void _volErr;
    }

    const sdrDirs = findSdrDirectories(searchRoots);

    for (const sdrDir of sdrDirs) {
      try {
        const files = fs.readdirSync(sdrDir);
        for (const f of files) {
          if (f.endsWith(".lua")) {
            const luaPath = path.join(sdrDir, f);
            const luaContent = fs.readFileSync(luaPath, "utf8");
            const parsed = extractHighlightsFromLua(luaContent);

            if (parsed.title || parsed.highlights.length > 0) {
              const title =
                parsed.title ||
                path.basename(sdrDir, ".sdr").replace(/\.epub$/i, "");
              const author = parsed.author || "Unknown";
              const progress = normalizeProgress(parsed.percentFinished);

              addOrMergeBook({
                title,
                author,
                synopsis: parsed.description,
                progress,
                highlights: parsed.highlights,
                sourceFile: luaPath,
              });
            }
          }
        }
      } catch (_sdrErr) {
        void _sdrErr;
      }
    }

    // 3. Discover Kindle My Clippings.txt files
    const clippingFiles = findKindleClippingsFiles(searchRoots);
    for (const clipFile of clippingFiles) {
      try {
        const clipContent = fs.readFileSync(clipFile, "utf8");
        const parsedBooks = extractKindleClippings(clipContent);
        for (const [_, bData] of parsedBooks) {
          if (bData.highlights.length > 0) {
            addOrMergeBook({
              title: bData.title,
              author: bData.author,
              highlights: bData.highlights,
              sourceFile: clipFile,
            });
          }
        }
      } catch (_clipErr) {
        void _clipErr;
      }
    }
  }

  const booksToSync = Array.from(booksMap.values());

  // Ensure books directory exists if applying
  if (!dryRun && !fs.existsSync(booksDir)) {
    fs.mkdirSync(booksDir, { recursive: true });
  }

  const result: SyncObsidianResult = {
    vaultPath,
    dryRun,
    totalBooksScanned: booksToSync.length,
    totalHighlightsFound: 0,
    notesCreated: 0,
    notesUpdated: 0,
    notesSkipped: 0,
    items: [],
    errors: [],
  };

  // Process and merge each book
  for (const book of booksToSync) {
    try {
      const normTitle = book.title.toLowerCase().trim();
      const calibreMatch =
        calibreMap.get(normTitle) ||
        (book.bookId ? calibreMap.get(String(book.bookId)) : undefined);

      const finalTitle = calibreMatch?.title || book.title;
      let finalAuthor = book.author;
      if (calibreMatch?.authors) {
        finalAuthor = calibreMatch.authors;
      } else if (book.author === "Unknown") {
        finalAuthor = "Unknown";
      }

      const finalSeries = calibreMatch?.series || book.series;
      const finalSeriesIndex = calibreMatch?.seriesIndex || book.seriesIndex;
      const finalSynopsis =
        calibreMatch?.comments || book.synopsis || undefined;

      const kosyncMatch =
        kosyncMap.get(normTitle) ||
        (calibreMatch ? kosyncMap.get(calibreMatch.title.toLowerCase().trim()) : undefined);

      let finalProgress = book.progress ?? 0;
      let lastReadDate = book.lastReadDate;

      if (kosyncMatch) {
        finalProgress = Math.max(finalProgress, kosyncMatch.progress);
        if (kosyncMatch.timestamp) {
          const d = new Date(kosyncMatch.timestamp * 1000);
          lastReadDate = d.toISOString().replace("T", " ").slice(0, 16);
        }
      }

      let finalStatus: "reading" | "finished" | "unread" = "unread";
      if (finalProgress >= 99) {
        finalStatus = "finished";
      } else if (finalProgress > 0) {
        finalStatus = "reading";
      }

      const mergedData: BookSyncData = {
        title: finalTitle,
        author: finalAuthor,
        series: finalSeries,
        seriesIndex: finalSeriesIndex,
        synopsis: finalSynopsis,
        progress: finalProgress,
        status: finalStatus,
        lastReadDate,
        highlights: book.highlights,
        bookId: calibreMatch?.id || book.bookId,
        sourceFile: book.sourceFile,
      };

      result.totalHighlightsFound += book.highlights.length;

      const sanitized = sanitizeTitle(finalTitle);
      const noteFilename = `${sanitized}.md`;
      const notePath = path.join(booksDir, noteFilename);

      // Defense-in-depth: assert path containment inside booksDir
      const resolvedNotePath = path.resolve(notePath);
      const resolvedBooksDir = path.resolve(booksDir);
      if (!resolvedNotePath.startsWith(resolvedBooksDir + path.sep)) {
        throw new Error(`Security: note path escapes books directory: ${noteFilename}`);
      }

      let action: "created" | "updated" | "skipped" = "created";

      if (fs.existsSync(notePath)) {
        action = "updated";
        const existingContent = fs.readFileSync(notePath, "utf8");
        const mergedContent = mergeNoteContent(existingContent, mergedData);

        if (!dryRun) {
          fs.writeFileSync(notePath, mergedContent, "utf8");
        }
        result.notesUpdated++;
      } else {
        const newContent = generateBookMarkdown(mergedData);
        if (!dryRun) {
          fs.writeFileSync(notePath, newContent, "utf8");
        }
        result.notesCreated++;
      }

      // Index highlights into cache.db for LightHouse Web Highlights Viewer
      if (!dryRun && mergedData.highlights && mergedData.highlights.length > 0) {
        try {
          const records = mergedData.highlights
            .map((h) => {
              let pageNum: number | null = null;
              if (typeof h.page === "number") pageNum = h.page;
              else if (h.page) {
                const parsed = parseInt(String(h.page), 10);
                if (!Number.isNaN(parsed)) pageNum = parsed;
              }
              const quote = cleanQuoteText(h.text);
              if (!quote) return null;
              return {
                book_id: mergedData.bookId ?? null,
                book_title: finalTitle.trim(),
                chapter: h.chapter || null,
                page: pageNum,
                quote,
                note: h.notes || null,
                timestamp: h.datetime || null,
              };
            })
            .filter((r): r is NonNullable<typeof r> => r !== null);

          if (records.length > 0) {
            const hDb = getHighlightsCacheDb();
            batchUpsertHighlights(hDb, records);
          }
        } catch (_indexErr) {
          void _indexErr;
          // Fail-open
        }
      }

      result.items.push({
        title: finalTitle,
        author: finalAuthor,
        filename: noteFilename,
        outputPath: notePath,
        highlightCount: book.highlights.length,
        progress: finalProgress,
        status: finalStatus,
        action,
      });
    } catch (err: any) {
      result.errors.push({
        title: book.title,
        error: String(err?.message || err),
      });
    }
  }

  return result;
}

// ----------------------------------------------------------------------------
// 8. CLI Handler
// ----------------------------------------------------------------------------

function printHelp(): void {
  console.log(`
LightHouse Obsidian Highlight & Note Sync CLI

Synchronizes highlights, notes, and reading progress from KOReader / Kindle to Obsidian.

Usage:
  bin/lighthouse sync-obsidian [options]

Options:
  --vault-path <path>   Obsidian vault directory (default: $OBSIDIAN_VAULT_PATH or ~/Obsidian)
  --dry-run             Preview changes without writing to disk (default)
  --apply               Write/update markdown notes in <vault>/Books/
  --watch               Watch Calibre library and KOSync DB for changes and auto-sync
  --verbose, -v         Display detailed progress output
  --help, -h            Show this help message

Output:
  <vault>/Books/<Sanitized_Title>.md

Features:
  - Extracts quotes, page numbers, chapters, and timestamps from KOReader .sdr metadata.*.lua.
  - Idempotent preservation: user edits outside <!-- lighthouse:highlights:... --> markers are retained.
  - Merges KOSync live percentage and Calibre book synopsis into frontmatter and note header.
`);
}

export async function runCli(args: string[] = process.argv.slice(2)): Promise<void> {
  let vaultPath: string | undefined;
  let apply = false;
  let dryRun = false;
  let watch = false;
  let verbose = false;

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === "--help" || arg === "-h") {
      printHelp();
      process.exit(0);
    } else if (arg === "--vault-path") {
      vaultPath = args[++i];
    } else if (arg === "--apply") {
      apply = true;
    } else if (arg === "--dry-run") {
      dryRun = true;
    } else if (arg === "--watch") {
      watch = true;
    } else if (arg === "--verbose" || arg === "-v") {
      verbose = true;
    }
  }

  const isDryRun = dryRun || (!apply && !watch);

  console.log(`[LightHouse] Obsidian Sync Engine`);
  console.log(`  Vault Path: ${resolveVaultPath(vaultPath)}`);
  console.log(`  Mode: ${isDryRun ? "DRY-RUN (Pass --apply to write notes)" : "APPLY"}`);

  const runOnce = async () => {
    const res = await syncObsidian({
      vaultPath,
      apply: !isDryRun,
      dryRun: isDryRun,
      verbose,
    });

    console.log(`\n[LightHouse] Sync Summary:`);
    console.log(`  Books processed: ${res.totalBooksScanned}`);
    console.log(`  Highlights found: ${res.totalHighlightsFound}`);
    console.log(`  Notes created: ${res.notesCreated}`);
    console.log(`  Notes updated: ${res.notesUpdated}`);

    if (res.items.length > 0) {
      console.log(`\n  Items:`);
      for (const it of res.items) {
        console.log(
          `  • [${it.action.toUpperCase()}] "${it.title}" by ${it.author} (${it.highlightCount} highlights, ${it.progress}%) -> ${it.filename}`,
        );
      }
    }

    if (res.errors.length > 0) {
      console.error(`\n  Errors (${res.errors.length}):`);
      for (const e of res.errors) {
        console.error(`  ✖ "${e.title}": ${e.error}`);
      }
    }
  };

  await runOnce();

  if (watch) {
    console.log(`\n[LightHouse] Watching for reading stack updates... (Press Ctrl+C to stop)`);
    const watchPaths = [getCalibreDbPath(), getKosyncDbPath()].filter((p) =>
      fs.existsSync(p),
    );

    let debounceTimer: ReturnType<typeof setTimeout> | null = null;
    for (const wp of watchPaths) {
      try {
        fs.watch(wp, (_event: fs.WatchEventType) => {
          if (debounceTimer) clearTimeout(debounceTimer);
          debounceTimer = setTimeout(async () => {
            console.log(`\n[LightHouse] Detected update in ${path.basename(wp)}, re-syncing...`);
            await runOnce();
          }, 2000);
        });
      } catch (_watchErr) {
        void _watchErr;
      }
    }
  }
}

if ((import.meta as any).main) {
  runCli().catch((err) => {
    console.error("Sync error:", err);
    process.exit(1);
  });
}
