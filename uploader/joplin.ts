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
 * Formats notes with clean YAML frontmatter (block-style tags, updated: <timestamp>, title: ...)
 * and idempotent highlight markers (<!-- lighthouse:highlights:start --> / <!-- lighthouse:highlights:end -->)
 * so re-exporting does not duplicate existing highlights while preserving user edits.
 *
 * Authentication fails closed: JOPLIN_TOKEN must be set in the environment. There is no
 * published default. Unset or empty tokens reject every non-ping route before any note write.
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
  const raw = process.env.JOPLIN_TOKEN;
  if (typeof raw !== "string") return "";
  return raw.trim();
}

/** Resolves the server token. An explicit empty override does not fall through to env. */
export function configuredJoplinToken(expectedToken?: string): string {
  if (expectedToken !== undefined) return expectedToken.trim();
  return getJoplinToken();
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
  const token = configuredJoplinToken(expectedToken);
  // Fail closed. An unset or empty token must never authenticate a request.
  if (!token) return false;

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

export class JoplinPathError extends Error {
  readonly statusCode = 400;
  constructor(message: string) {
    super(message);
    this.name = "JoplinPathError";
  }
}

/** Real path of the books directory. Creates it when missing so realpath can succeed. */
export function resolveRealBooksDir(booksDir?: string): string {
  const raw = path.resolve(getObsidianBooksDir(booksDir));
  if (!fs.existsSync(raw)) {
    fs.mkdirSync(raw, { recursive: true });
  }
  return fs.realpathSync(raw);
}

export function isInsideDir(realDir: string, candidate: string): boolean {
  const rootPrefix = realDir.endsWith(path.sep) ? realDir : realDir + path.sep;
  const resolved = path.resolve(candidate);
  return resolved === realDir || resolved.startsWith(rootPrefix);
}

export function assertNotSymlink(notePath: string): void {
  let st: fs.Stats;
  try {
    st = fs.lstatSync(notePath);
  } catch (err: any) {
    if (err?.code === "ENOENT") return;
    throw err;
  }
  if (st.isSymbolicLink()) {
    throw new JoplinPathError("Refusing to write through a symlink");
  }
}

/**
 * Single-line title safe to interpolate into a Markdown heading.
 * Strips newlines and highlight marker strings so a title cannot break out of `# title`.
 */
export function sanitizeNoteHeading(title: string): string {
  let s = title || "";
  s = s.replace(/\r\n|\r|\n|\u2028|\u2029/g, " ");
  s = s.replace(/<!--\s*lighthouse:highlights:[^>]*-->/gi, " ");
  s = s.replace(/\s+/g, " ").trim();
  return s || "Untitled";
}

export function getBookNotePath(
  title: string,
  booksDir?: string,
): { safeTitle: string; notePath: string; booksDir: string } {
  const configured = path.resolve(getObsidianBooksDir(booksDir));
  const realDir = fs.existsSync(configured)
    ? fs.realpathSync(configured)
    : configured;
  let safeTitle = sanitizeTitle(title);

  // Enforce NAME_MAX filesystem budget (<= 240 bytes) to prevent ENAMETOOLONG
  safeTitle = truncateUtf8Bytes(safeTitle, 240);
  if (!safeTitle || safeTitle === "." || safeTitle === "..") {
    safeTitle = "Untitled";
  }

  const safeFilename = path.basename(safeTitle) + ".md";
  const notePath = path.resolve(realDir, safeFilename);

  if (!isInsideDir(realDir, notePath)) {
    throw new JoplinPathError(
      "Invalid note path: potential path traversal detected",
    );
  }

  return { safeTitle, notePath, booksDir: realDir };
}

function writeNoteAtomically(
  realDir: string,
  notePath: string,
  content: string,
): void {
  if (!isInsideDir(realDir, notePath)) {
    throw new JoplinPathError(
      "Invalid note path: potential path traversal detected",
    );
  }
  assertNotSymlink(notePath);
  const tmpPath = path.join(
    realDir,
    `.joplin-${crypto.randomBytes(8).toString("hex")}.tmp`,
  );
  if (!isInsideDir(realDir, tmpPath)) {
    throw new JoplinPathError(
      "Invalid note path: potential path traversal detected",
    );
  }
  fs.writeFileSync(tmpPath, content, { encoding: "utf8", flag: "wx" });
  try {
    assertNotSymlink(notePath);
    fs.renameSync(tmpPath, notePath);
  } catch (err) {
    try {
      fs.unlinkSync(tmpPath);
    } catch (_unlinkErr) {
      void _unlinkErr;
    }
    throw err;
  }
  const finalStat = fs.lstatSync(notePath);
  if (finalStat.isSymbolicLink()) {
    throw new JoplinPathError("Refusing to write through a symlink");
  }
  const realWritten = fs.realpathSync(notePath);
  if (!isInsideDir(realDir, realWritten)) {
    throw new JoplinPathError("Refusing to write outside the books directory");
  }
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

/** Exact normalized quote used for idempotent dedup, including 1–2 character quotes. */
export function extractQuoteKey(raw: string): string {
  if (!raw) return "";
  const marked = raw.match(/==([\s\S]*?)==/);
  if (marked) {
    const key = normalizeQuote(marked[1]);
    if (key) return key;
  }
  const quoteLines: string[] = [];
  let inAnnotation = false;
  for (const line of raw.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    if (/^#{1,6}\s+/.test(trimmed)) continue;
    if (/^---\s*$/.test(trimmed) || /^[-*_]{3,}\s*$/.test(trimmed)) {
      inAnnotation = true;
      continue;
    }
    if (inAnnotation) continue;
    quoteLines.push(trimmed.replace(/^>\s?/, ""));
  }
  return normalizeQuote(quoteLines.join(" "));
}

export function extractAnnotation(raw: string): string {
  if (!raw) return "";
  const lines: string[] = [];
  let seen = false;
  for (const line of raw.split("\n")) {
    if (/^---\s*$/.test(line.trim()) || /^[-*_]{3,}\s*$/.test(line.trim())) {
      seen = true;
      continue;
    }
    if (seen) lines.push(line);
  }
  return lines.join("\n").trim();
}

function incomingDeclaresAnnotation(raw: string): boolean {
  return raw.split("\n").some(
    (line) => /^---\s*$/.test(line.trim()) || /^[-*_]{3,}\s*$/.test(line.trim()),
  );
}

function replaceAnnotation(raw: string, annotation: string): string {
  const head: string[] = [];
  for (const line of raw.split("\n")) {
    if (/^---\s*$/.test(line.trim()) || /^[-*_]{3,}\s*$/.test(line.trim())) break;
    head.push(line);
  }
  const base = head.join("\n").trimEnd();
  if (!annotation) return base;
  return `${base}\n---\n${annotation}`;
}

function isPageHeading(trimmed: string): boolean {
  return /^###\s+Page\b/i.test(trimmed);
}

function isUserH3(trimmed: string): boolean {
  // Any ### heading that is not an explicit "### Page" heading, including
  // "### 1. First point" and "### 2024 notes".
  return /^###\s+/.test(trimmed) && !isPageHeading(trimmed);
}

function isChapterHeading(trimmed: string): boolean {
  return /^##\s+[^#]/.test(trimmed);
}

function isHighlightStructure(trimmed: string): boolean {
  if (!trimmed) return false;
  return (
    isChapterHeading(trimmed) ||
    isPageHeading(trimmed) ||
    trimmed.startsWith("==") ||
    /^---\s*$/.test(trimmed) ||
    /^[-*_]{3,}\s*$/.test(trimmed)
  );
}

/**
 * A `##` heading continues highlights only when the next non-empty line is an
 * explicit `### Page` heading. That is the only shape KOReader's
 * `template/md.lua` emits. Do not treat `>`, `==`, another `##`, EOF, or a
 * numeric heading (`### 1.`, `### 2024`) as continuation, and do not scan past
 * a blockquote. `### Page` text inside a blockquote is not a chapter signal.
 */
function chapterContinuesHighlights(lines: string[], index: number): boolean {
  let j = index + 1;
  while (j < lines.length && !lines[j].trim()) j++;
  if (j >= lines.length) return false;
  return /^###\s+Page\b/i.test(lines[j].trim());
}

function stripHighlightMarkerComments(text: string): string {
  return text.replace(/<!--\s*lighthouse:highlights:[^>]*-->/gi, "");
}

function joinOutsideRegions(parts: string[]): string {
  return parts
    .map((part) => part.replace(/^\n+/, "").replace(/\n+$/, ""))
    .filter((part) => part.trim().length > 0)
    .join("\n\n");
}

/**
 * Keep only highlight entries in an unclosed marker region.
 * User `###` headings and loose reflections stay in `remainder`.
 */
export function splitUnclosedHighlightRegion(afterStart: string): {
  managed: string;
  remainder: string;
} {
  const lines = (afterStart || "").replace(/\r\n/g, "\n").split("\n");
  const managed: string[] = [];
  let i = 0;
  let inEntry = false;

  while (i < lines.length) {
    const line = lines[i];
    const trimmed = line.trim();

    if (!trimmed) {
      let j = i + 1;
      while (j < lines.length && !lines[j].trim()) j++;
      if (j >= lines.length) break;
      const next = lines[j].trim();
      if (isUserH3(next)) break;
      if (isChapterHeading(next) && !chapterContinuesHighlights(lines, j)) break;
      if (inEntry || isHighlightStructure(next)) {
        if (!isHighlightStructure(next)) break;
        managed.push(line);
        inEntry = false;
        i++;
        continue;
      }
      break;
    }

    if (isUserH3(trimmed)) break;

    if (isChapterHeading(trimmed)) {
      if (!chapterContinuesHighlights(lines, i)) break;
      inEntry = false;
      managed.push(line);
      i++;
      continue;
    }

    // A bare `>` must not open a managed region. Keep it only when `inEntry`
    // is already true from an open `### Page` entry.
    if (isPageHeading(trimmed) || trimmed.startsWith("==")) {
      inEntry = true;
      managed.push(line);
      i++;
      continue;
    }

    if (/^---\s*$/.test(trimmed) || /^[-*_]{3,}\s*$/.test(trimmed)) {
      if (!inEntry && managed.length === 0) break;
      inEntry = true;
      managed.push(line);
      i++;
      continue;
    }

    if (inEntry) {
      managed.push(line);
      i++;
      continue;
    }

    break;
  }

  return {
    managed: managed.join("\n").trim(),
    remainder: lines.slice(i).join("\n"),
  };
}

/**
 * Rebuild one start/end pair after stripping every highlight marker comment
 * from both sides of `## Highlights & Notes`. An old end marker above the
 * header must not survive into the rebuilt note.
 */
function rebuildInvertedHighlightSection(restOfContent: string): string {
  const header = "## Highlights & Notes";
  const stripped = stripHighlightMarkerComments(restOfContent);
  const hnIdx = stripped.indexOf(header);
  if (hnIdx === -1) {
    const recovered = stripped.trim();
    return `${recovered}\n\n${header}\n${HIGHLIGHTS_START_MARKER}\n${HIGHLIGHTS_END_MARKER}\n`;
  }
  const beforeHn = stripped.slice(0, hnIdx + header.length);
  const cleanAfterHn = stripped.slice(hnIdx + header.length);
  const { managed, remainder } = splitUnclosedHighlightRegion(cleanAfterHn);
  const tail = remainder.replace(/^\n*/, "");
  return `${beforeHn}\n${HIGHLIGHTS_START_MARKER}\n${managed}\n${HIGHLIGHTS_END_MARKER}\n${tail}`;
}

export function renderHighlightEntries(entries: ParsedHighlightEntry[]): string {
  const parts: string[] = [];
  let lastChapter: string | undefined;
  for (const entry of entries) {
    const chapter = entry.chapter ? sanitizeNoteHeading(entry.chapter) : "";
    if (chapter && chapter !== "Untitled" && chapter !== lastChapter) {
      parts.push(`## ${chapter}`);
      lastChapter = chapter;
    } else if (!chapter) {
      lastChapter = undefined;
    }
    const raw = entry.raw.trim();
    if (raw) parts.push(raw);
  }
  return parts.join("\n\n");
}

export function mergeHighlightEntries(
  existingText: string,
  incoming: ParsedHighlightEntry[],
): ParsedHighlightEntry[] {
  const result = splitHighlightEntries(existingText).map((entry) => ({ ...entry }));
  const indexByKey = new Map<string, number>();
  result.forEach((entry, index) => {
    const key = extractQuoteKey(entry.raw);
    if (key && !indexByKey.has(key)) indexByKey.set(key, index);
  });

  for (const inc of incoming) {
    const key = extractQuoteKey(inc.raw);
    if (!key) {
      if (!result.some((entry) => entry.raw.trim() === inc.raw.trim())) {
        result.push(inc);
      }
      continue;
    }
    const idx = indexByKey.get(key);
    if (idx === undefined) {
      indexByKey.set(key, result.length);
      result.push(inc);
      continue;
    }
    const prev = result[idx];
    const prevAnn = extractAnnotation(prev.raw);
    const nextAnn = extractAnnotation(inc.raw);
    if (incomingDeclaresAnnotation(inc.raw) && prevAnn !== nextAnn) {
      const updatedRaw = replaceAnnotation(prev.raw, nextAnn);
      result[idx] = {
        ...prev,
        raw: updatedRaw,
        normalized: normalizeQuote(updatedRaw),
        chapter: inc.chapter || prev.chapter,
      };
    } else if (inc.chapter && !prev.chapter) {
      result[idx] = { ...prev, chapter: inc.chapter };
    }
  }
  return result;
}

export function isQuoteInExisting(
  normalizedQuote: string,
  existingHighlightsText: string,
): boolean {
  if (!normalizedQuote) return false;
  const entries = splitHighlightEntries(existingHighlightsText);
  for (const entry of entries) {
    const key = extractQuoteKey(entry.raw);
    if (key && key === normalizedQuote) return true;
  }
  return false;
}

// ----------------------------------------------------------------------------
// 4. Frontmatter & Note Merging Engine
// ----------------------------------------------------------------------------

function yamlScalar(raw: string): string {
  const trimmed = raw.trim();
  if (
    (trimmed.startsWith('"') && trimmed.endsWith('"')) ||
    (trimmed.startsWith("'") && trimmed.endsWith("'"))
  ) {
    try {
      return JSON.parse(
        trimmed.startsWith("'")
          ? `"${trimmed.slice(1, -1).replace(/"/g, '\\"')}"`
          : trimmed,
      );
    } catch {
      return trimmed.slice(1, -1);
    }
  }
  return trimmed;
}

function isBlankAuthor(value: string | undefined): boolean {
  if (!value) return true;
  const author = value.trim();
  return (
    !author ||
    author === "Unknown" ||
    author === "N/A" ||
    author === "(Author not found in book's metadata)"
  );
}

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
      "tags:",
      "  - reading",
      "  - highlights",
      "  - koreader",
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
      const existingAuthor = yamlScalar(line.slice(line.indexOf(":") + 1));
      if (!isBlankAuthor(existingAuthor)) {
        fmEntries.push({ key: "author", line });
      } else if (meta.author && !isBlankAuthor(meta.author)) {
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

  result.push("tags:");
  for (const tag of existingTags) {
    result.push(`  - ${tag}`);
  }

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

  const headingTitle = sanitizeNoteHeading(title);
  const cleanedBody = cleanIncomingHighlightBody(newBody, title);
  const incomingEntries = splitHighlightEntries(cleanedBody);
  const renderedIncoming =
    incomingEntries.length > 0
      ? renderHighlightEntries(incomingEntries)
      : cleanedBody || "*No highlights recorded yet.*";

  // 1. If no existing content: generate complete new note
  if (!existingContent || !existingContent.trim()) {
    const fm = updateFrontmatter(null, {
      title: headingTitle,
      author,
      series,
      updated: updatedIso,
    });

    const sections = [fm, "", `# ${headingTitle}`];

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
      renderedIncoming,
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
    title: headingTitle,
    author,
    series,
    updated: updatedIso,
  });

  // 2. Identify and repair highlight section markers if orphaned or inverted
  let startIdx = restOfContent.indexOf(HIGHLIGHTS_START_MARKER);
  let endIdx = restOfContent.indexOf(HIGHLIGHTS_END_MARKER);

  if (startIdx !== -1 && endIdx !== -1 && endIdx < startIdx) {
    // Inverted markers: strip every marker comment before and after the
    // highlights header, then rebuild exactly one ordered pair. Do not leave
    // an old end marker above the new start marker.
    restOfContent = rebuildInvertedHighlightSection(restOfContent);
    startIdx = restOfContent.indexOf(HIGHLIGHTS_START_MARKER);
    endIdx = restOfContent.indexOf(HIGHLIGHTS_END_MARKER);
  } else if (startIdx !== -1 && endIdx === -1) {
    // Missing end marker: keep highlight entries only. User ### headings and
    // loose reflections stay outside the repaired marker region.
    const afterStart = restOfContent.slice(
      startIdx + HIGHLIGHTS_START_MARKER.length,
    );
    const cleanAfterStart = afterStart.replaceAll(HIGHLIGHTS_END_MARKER, "");
    const { managed, remainder } = splitUnclosedHighlightRegion(cleanAfterStart);
    const tail = remainder.replace(/^\n*/, "");
    restOfContent =
      restOfContent.slice(0, startIdx + HIGHLIGHTS_START_MARKER.length) +
      "\n" +
      managed +
      "\n" +
      HIGHLIGHTS_END_MARKER +
      (tail ? `\n${tail}` : "\n");
    endIdx = restOfContent.indexOf(HIGHLIGHTS_END_MARKER);
  } else if (startIdx === -1 && endIdx !== -1) {
    // Missing start marker: keep only highlight entries between the header
    // and the end marker. User `###` headings and loose reflections stay out.
    const beforeEnd = restOfContent.slice(0, endIdx);
    const afterOldEnd = restOfContent.slice(endIdx + HIGHLIGHTS_END_MARKER.length);
    const hnIdx = beforeEnd.lastIndexOf("## Highlights & Notes");
    if (hnIdx !== -1) {
      const headerEnd = hnIdx + "## Highlights & Notes".length;
      const recoveredRaw = beforeEnd
        .slice(headerEnd)
        .replaceAll(HIGHLIGHTS_START_MARKER, "");
      const { managed, remainder } = splitUnclosedHighlightRegion(recoveredRaw);
      const outside = joinOutsideRegions([remainder, afterOldEnd]);
      restOfContent =
        beforeEnd.slice(0, headerEnd) +
        "\n" +
        HIGHLIGHTS_START_MARKER +
        "\n" +
        managed +
        "\n" +
        HIGHLIGHTS_END_MARKER +
        (outside ? `\n${outside}\n` : "\n");
    } else {
      const recoveredRaw = beforeEnd.replaceAll(HIGHLIGHTS_START_MARKER, "");
      const { managed, remainder } = splitUnclosedHighlightRegion(recoveredRaw);
      const outside = joinOutsideRegions([remainder, afterOldEnd]);
      restOfContent =
        "\n## Highlights & Notes\n" +
        HIGHLIGHTS_START_MARKER +
        "\n" +
        managed +
        "\n" +
        HIGHLIGHTS_END_MARKER +
        (outside ? `\n${outside}\n` : "\n");
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
      finalHighlights = renderedIncoming;
    } else {
      finalHighlights =
        renderHighlightEntries(
          mergeHighlightEntries(existingHighlights, incomingEntries),
        ) || existingHighlights;
    }

    const before = restOfContent.slice(
      0,
      startIdx + HIGHLIGHTS_START_MARKER.length,
    );
    const after = restOfContent.slice(endIdx);
    restOfContent = `${before}\n${finalHighlights}\n${after}`;
  } else if (startIdx !== -1 && endIdx !== -1 && endIdx < startIdx) {
    // Still inverted. Rebuild once more and do not fall through into a second
    // wrap while an old end marker sits above the new start marker.
    restOfContent = rebuildInvertedHighlightSection(restOfContent);
  } else {
    // Markers missing: merge into the existing section instead of leaving the
    // original quotes outside the new end marker.
    const hnIdx = restOfContent.indexOf("## Highlights & Notes");
    if (hnIdx !== -1) {
      const headerEnd = hnIdx + "## Highlights & Notes".length;
      const before = restOfContent.slice(0, headerEnd);
      const after = restOfContent.slice(headerEnd);
      const { managed, remainder } = splitUnclosedHighlightRegion(after);
      const mergedBlock =
        renderHighlightEntries(
          mergeHighlightEntries(managed, incomingEntries),
        ) || renderedIncoming;
      const tail = remainder.replace(/^\n*/, "");
      restOfContent = `${before}\n${HIGHLIGHTS_START_MARKER}\n${mergedBlock}\n${HIGHLIGHTS_END_MARKER}\n${tail}`;
    } else {
      restOfContent =
        restOfContent.trimEnd() +
        "\n\n## Highlights & Notes\n" +
        HIGHLIGHTS_START_MARKER +
        "\n" +
        renderedIncoming +
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
    try {
      title = decodeURIComponent(payload.id).trim();
    } catch (err) {
      if (err instanceof URIError) {
        throw Object.assign(new Error("Malformed note id"), { statusCode: 400 });
      }
      throw err;
    }
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

  const realDir = resolveRealBooksDir(options.booksDir);
  const { safeTitle, notePath } = getBookNotePath(title, realDir);

  let fileExisted = false;
  let existingContent = "";
  try {
    const st = fs.lstatSync(notePath);
    if (st.isSymbolicLink()) {
      throw new JoplinPathError("Refusing to write through a symlink");
    }
    if (st.isDirectory()) {
      throw new JoplinPathError("Refusing to overwrite a directory");
    }
    if (st.isFile()) {
      fileExisted = true;
      existingContent = fs.readFileSync(notePath, "utf8");
    }
  } catch (err: any) {
    if (err?.code !== "ENOENT") throw err;
  }

  const merged = mergeJoplinHighlights(existingContent, rawBody, title, {
    booksDir: realDir,
    calibreDbPath: options.calibreDbPath,
  });

  writeNoteAtomically(realDir, notePath, merged);

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

  // 2. Validate Joplin Token for all other endpoints before any note write.
  // Unset JOPLIN_TOKEN fails closed (503). A wrong or missing request token is 401.
  const configuredToken = configuredJoplinToken(options.expectedToken);
  if (!configuredToken) {
    return new Response(
      JSON.stringify({ error: "Joplin token is not configured" }),
      {
        status: 503,
        headers: {
          ...corsHeaders,
          "Content-Type": "application/json; charset=utf-8",
        },
      },
    );
  }
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
        let decodedId = "Untitled";
        try {
          decodedId = decodeURIComponent(noteId || "Untitled");
        } catch (err) {
          if (err instanceof URIError) {
            return new Response(
              JSON.stringify({ error: "Malformed note id" }),
              {
                status: 400,
                headers: {
                  ...corsHeaders,
                  "Content-Type": "application/json; charset=utf-8",
                },
              },
            );
          }
          throw err;
        }
        return new Response(
          JSON.stringify({
            id: noteId,
            title: decodedId,
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
        try {
          payload.id = decodeURIComponent(noteId);
        } catch (err) {
          if (err instanceof URIError) {
            return new Response(
              JSON.stringify({ error: "Malformed note id" }),
              {
                status: 400,
                headers: {
                  ...corsHeaders,
                  "Content-Type": "application/json; charset=utf-8",
                },
              },
            );
          }
          throw err;
        }
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
        const status =
          err instanceof JoplinPathError || err?.statusCode === 400 ? 400 : 500;
        return new Response(
          JSON.stringify({
            error:
              sanitizeErrorMessage(err) || "Failed to process Joplin note",
          }),
          {
            status,
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
