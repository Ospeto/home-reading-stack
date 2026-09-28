import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { Database } from "bun:sqlite";
import { safeFetchWithSsrf, isPrivateOrInternalIp, getBsdtarPath, getUnzipPath } from "./security";
import {
  isJunkAuthorExtended,
  classifyBookSourceCategory,
  classifyBookSourceCategoryDeterministic,
  triageSourceCategoryWithJev,
  containsBurmese,
  type BookSourceCategory,
} from "./jev-shelf";
export {
  classifyBookSourceCategory,
  classifyBookSourceCategoryDeterministic,
  triageSourceCategoryWithJev,
  containsBurmese,
  type BookSourceCategory,
};

export function getCalibredbPath(): string {
  if (process.env.CALIBREDB_PATH) return process.env.CALIBREDB_PATH;
  const probe = spawnSync("which", ["calibredb"], { encoding: "utf8" });
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

const LIGHTHOUSE_ROOT =
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
  return path.join(
    home,
    "Calibre Libraries",
    "Agent Library",
    "metadata.db",
  );
}

export function getBookCalibreMetadata(
  bookId: number,
  dbPath = getCalibreDbPath(),
): { title?: string; series_index?: number; has_cover?: boolean | number; series?: string } | null {
  try {
    if (!fs.existsSync(dbPath)) return null;
    const db = new Database(dbPath, { readonly: true });
    try {
      db.run("PRAGMA busy_timeout = 3000;");
      const row = db
        .prepare(
          `
        SELECT b.id, b.title, b.has_cover, b.series_index, s.name as series
        FROM books b
        LEFT JOIN books_series_link bsl ON b.id = bsl.book
        LEFT JOIN series s ON bsl.series = s.id
        WHERE b.id = ?
      `,
        )
        .get(bookId) as any;
      if (!row) return null;
      return {
        title: row.title,
        series_index:
          row.series_index !== null && row.series_index !== undefined
            ? Number(row.series_index)
            : undefined,
        has_cover: Boolean(row.has_cover),
        series: row.series,
      };
    } finally {
      db.close();
    }
  } catch (err) {
    console.debug(
      `[AutoScraper] Failed to inspect Calibre metadata for book #${bookId}:`,
      err,
    );
    return null;
  }
}

const SERVER_URL = "http://127.0.0.1:8088";
const PROXY = "http://127.0.0.1:7890";
const SCRAPER_TIMEOUT_MS = 8000;
const COVER_TIMEOUT_MS = 12000;

export interface ScrapedMetadata {
  title: string;
  authors: string;
  publisher?: string;
  publishedDate?: string;
  description?: string;
  coverUrl?: string;
  tags: string[];
  source: string;
  confidence: number; // 0.0 - 1.0
  isManga?: boolean;
}

// ---------------------------------------------------------------------------
// Shared Sanitization Regex Patterns & Helpers
// ---------------------------------------------------------------------------

// Brackets containing watermark/digital library tags, file extensions, channels, or web domains
export const WATERMARK_BRACKET_REGEX =
  /\[.*?(?:z-?lib|libgen|annas?-archive|anna[\x27\u2019`]?s?\s*archive|oceanofpdf|vk\.com|thebookr|bookr|e-?book|pdf|epub|mobi|azw\d*|cbz|cbr|scan|retail|channel|myanmar|tg|t\.me|download|share|hq|raw|rip|\.[a-z]{2,4}).*?\]|\(.*?(?:z-?lib|libgen|annas?-archive|anna[\x27\u2019`]?s?\s*archive|oceanofpdf|vk\.com|thebookr|bookr|e-?book|pdf|epub|mobi|azw\d*|cbz|cbr|scan|retail|channel|myanmar|tg|t\.me|download|share|hq|raw|rip|\.[a-z]{2,4}).*?\)/gi;

// Release metadata tags and edition markers in brackets or parentheses
export const RELEASE_METADATA_REGEX =
  /[\[\(]\s*(?:light\s*novel|manga|web\s*novel|ln|wn|novel|epub|pdf|mobi|azw\d*|cbz|cbr|official|digital|retail|scan(?:lation)?|raw|hq|hd|rip|premium|complete|uncensored|special|bonus|repack|exclusive|remaster(?:ed)?|seven\s*seas|yen\s*press|j-?novel(?:\s*club)?|kodansha|viz(?:\s*media)?|square\s*enix)\s*[\]\)]/gi;

// Standalone digital library / pirate domains and tokens
export const STANDALONE_WATERMARKS_REGEX =
  /\b(?:z-?lib(?:rary)?(?:\.[a-z]{2,4})?|libgen(?:\.[a-z]{2,4})?|annas?-archive(?:\.[a-z]{2,4})?|anna[\x27\u2019`]?s?\s*archive|oceanofpdf(?:\.[a-z]{2,4})?|thebookr|vk\.com)\b/gi;

export const URL_REGEX = /https?:\/\/[^\s)\]]+/gi;
export const TELEGRAM_LINK_REGEX = /(?:t|telegram)\.me\/[^\s)\]]+/gi;
export const VK_LINK_REGEX = /vk\.com\/[^\s)\]]+/gi;
export const MENTION_REGEX = /@\w+/gi;
export const WWW_REGEX = /www\.[^\s)\]]+/gi;
export const FORMAT_EXT_REGEX = /\b(epub|pdf|mobi|azw3?|cbz|cbr|azw|djvu)\b/gi;

// Markers that identify a distinct work or branch rather than the same series
export const DISTINCT_WORK_MARKER_REGEX =
  /\b(?:year\s*\d+|ex\b|manga\b|comic\b|side[\s-]*stor(?:y|ies)|spin[\s-]*off|anthology|gaiden|special|short[\s-]*stor(?:y|ies)|after[\s-]*story)\b/i;

export function hasDistinctWorkMarker(text: string): boolean {
  return DISTINCT_WORK_MARKER_REGEX.test(text);
}

export function isCompatibleSeriesName(normA: string, normB: string): boolean {
  if (normA === normB) return true;
  const shorter = normA.length <= normB.length ? normA : normB;
  const longer = normA.length <= normB.length ? normB : normA;
  if (!longer.startsWith(shorter)) return false;

  const remainder = longer.slice(shorter.length).trim();
  if (hasDistinctWorkMarker(remainder)) {
    return false;
  }
  return true;
}

/**
 * Clean strings (titles, authors, filenames) by scrubbing watermarks, digital library
 * tags, channel promos, t.me links, @mentions, bracket garbage, and file format extensions.
 */
export function cleanString(str: string): string {
  if (!str) return "";
  let s = str;
  // Replace underscores that act as word separators
  s = s.replace(/_/g, " ");
  // Strip junk brackets first
  s = s.replace(WATERMARK_BRACKET_REGEX, " ");
  // Strip leftover URLs, channel links, and mentions
  s = s.replace(URL_REGEX, " ");
  s = s.replace(TELEGRAM_LINK_REGEX, " ");
  s = s.replace(VK_LINK_REGEX, " ");
  s = s.replace(MENTION_REGEX, " ");
  s = s.replace(WWW_REGEX, " ");
  // Strip standalone watermark domains and tokens
  s = s.replace(STANDALONE_WATERMARKS_REGEX, " ");
  // Strip eBook format extensions and version tags
  s = s.replace(FORMAT_EXT_REGEX, " ");
  s = s.replace(/\bv[0-9]+(?:\.[0-9]+)?\b/gi, " ");
  s = s.replace(/\[\s*\]|\(\s*\)/g, " ");
  s = s.replace(/\([0-9]+\)$/g, " ");
  // Collapse whitespace
  s = s.replace(/\s+/g, " ").trim();
  // Strip leading and trailing punctuation / delimiters
  s = s.replace(/^[-–—:_.\s]+|[-–—:_.\s]+$/g, "").trim();
  return s;
}

export function decodeHtmlEntities(str: string): string {
  if (!str) return "";
  return str
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#39;/g, "'")
    .replace(/&#x27;/g, "'")
    .replace(/&lsquo;/g, "'")
    .replace(/&rsquo;/g, "'")
    .replace(/&ldquo;/g, '"')
    .replace(/&rdquo;/g, '"')
    .replace(/&mdash;/g, "—")
    .replace(/&ndash;/g, "–")
    .replace(/&hellip;/g, "...")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&#(\d+);/g, (_, dec) => {
      try {
        return String.fromCharCode(parseInt(dec, 10));
      } catch {
        return "";
      }
    })
    .replace(/&#x([0-9a-f]+);/gi, (_, hex) => {
      try {
        return String.fromCharCode(parseInt(hex, 16));
      } catch {
        return "";
      }
    });
}

/**
 * Strips volume indicators, subtitles, and numbering to extract clean series title.
 * e.g. "The Legendary Moonlight Sculptor, Vol. 1" -> "The Legendary Moonlight Sculptor"
 *      "Trapped in a Dating Sim: The World of Otome Games Is Tough for Mobs, Vol. 02" -> "Trapped in a Dating Sim The World of Otome Games Is Tough for Mobs"
 *      "I'm the Evil Lord of an Intergalactic Empire! Volume 1" -> "I'm the Evil Lord of an Intergalactic Empire"
 *      "Overlord 01 - The Undead King" -> "Overlord"
 */
export function cleanSeriesTitle(title: string): string {
  if (!title) return "";
  let s = title.replace(/_/g, " ");
  s = s.replace(
    /[\[\(]\s*(?:vol(?:ume)?|v|book|bk|part|pt|#)?\.?\s*0*\d+(?:\.\d+)?\s*[\]\)]/gi,
    " ",
  );
  s = s.replace(
    /[,:\-–—\s]+(?:vol(?:ume)?|v|book|bk|part|pt|#)\.?\s*0*\d+(?:\.\d+)?.*$/gi,
    " ",
  );
  s = s.replace(
    /\b(?:vol(?:ume)?|v|book|bk|part|pt)\.?\s*0*\d+(?:\.\d+)?\b.*$/gi,
    " ",
  );
  s = s.replace(/#\s*0*\d+\b.*$/gi, " ");
  s = s.replace(
    /(?<=[a-zA-Z\u00A0-\uFFFF]\s+)0*\d{1,3}(?:\s*[-–—:].*)?$/g,
    " ",
  );
  s = cleanQuery(s);
  return s.replace(/^[-–—:_.,;!\s]+|[-–—:_.,;!\s]+$/g, "").trim();
}

/**
 * Clean search query for metadata APIs:
 * Applies cleanString, then strips all remaining brackets, chapter/vol numbers, and normalizes separators.
 */
export function cleanQuery(
  str: string,
  options?: { preserveVolume?: boolean },
): string {
  if (!str) return "";
  let s = options?.preserveVolume ? cleanVolumeQuery(str) : cleanString(str);
  if (options?.preserveVolume) {
    // Unwrap volume brackets/parentheses e.g. (Vol. 1), [Volume 02], (1), （1）, ［1］ into plain text
    s = s.replace(
      /[\[\(\uFF08\uFF3B]\s*((?:vol(?:ume)?|v|book|bk|ch|chapter|part|pt|#)?\.?\s*\d+(?:\.\d+)?)\s*[\]\)\uFF09\uFF3D]/gi,
      " $1 ",
    );
  }
  // Strip any remaining brackets and parentheses
  s = s.replace(/\[.*?\]/g, " ");
  s = s.replace(/\(.*?\)/g, " ");
  // Strip chapter / volume prefixes so search hits the canonical work (unless preserveVolume is requested)
  if (!options?.preserveVolume) {
    s = s.replace(
      /\b(c[0-9]+|ch\.?\s*[0-9]+|chapter\s*[0-9]+|vol\.?\s*[0-9]+|volume\s*[0-9]+|book\s*[0-9]+|part\s*[0-9]+)\b/gi,
      " ",
    );
  }
  // Normalize punctuation separators to spaces
  s = s.replace(/[-_–—:,;]+/g, " ");
  s = s.replace(/\s+/g, " ").trim();
  return s;
}

/**
 * Check whether a tag is promotional / watermark junk.
 */
export function isJunkTag(tag: string): boolean {
  if (!tag) return true;
  const t = tag.trim();
  if (t.length < 2 || t.length > 35) return true;
  return /http|t\.me|telegram|channel|\.com|\.org|\.li|\.is|\.pub|download|share|thebookr|z-?lib|libgen|annas?-archive|oceanofpdf|vk\.com|ebook|free/i.test(
    t,
  );
}

/**
 * Check whether an author string is promotional / watermark junk.
 */
export function isJunkAuthor(author: string): boolean {
  return isJunkAuthorExtended(author);
}

/**
 * Sanitize extracted metadata and fallback to filename parsing if needed.
 */
export function sanitizeMetadata(
  rawTitle: string,
  rawAuthors: string,
  rawTags: string[],
  filename?: string,
) {
  let title = cleanString(rawTitle);
  let author = cleanString(rawAuthors);
  const tags = (rawTags || []).map(cleanString).filter((t) => !isJunkTag(t));

  const authorJunk = isJunkAuthor(author);

  if ((!title || authorJunk) && filename) {
    const base = path.basename(filename, path.extname(filename));
    const parts = base.split(/[-–—]/).map(cleanString).filter(Boolean);
    if (parts.length >= 2) {
      if (!title || title.length < 3) title = parts[0];
      if (authorJunk) author = parts[1] || "Unknown";
    } else {
      if (!title || title.length < 3) title = base;
      if (authorJunk) author = "Unknown";
    }
  }

  return {
    title: cleanString(title),
    author: cleanString(author || "Unknown"),
    tags,
  };
}

/**
 * Parse a standard ASCII or Burmese numeral string to number.
 */
export function parseBurmeseOrAsciiNumber(str: string): number | null {
  if (!str) return null;
  const burmeseDigits: Record<string, string> = {
    "၀": "0",
    "၁": "1",
    "၂": "2",
    "၃": "3",
    "၄": "4",
    "၅": "5",
    "၆": "6",
    "၇": "7",
    "၈": "8",
    "၉": "9",
  };
  let converted = "";
  for (const ch of str) {
    if (burmeseDigits[ch]) {
      converted += burmeseDigits[ch];
    } else {
      converted += ch;
    }
  }
  const num = parseFloat(converted);
  return !isNaN(num) ? num : null;
}

/**
 * Extract volume number from title or filename.
 */
export function extractVolumeNumber(title: string): number | null {
  if (!title) return null;
  const s = title.trim();

  const patterns = [
    /[\[\(]\s*(?:vol(?:ume)?|v|book|bk|part|pt)?\.?\s*0*(\d+(?:\.\d+)?)\s*[\]\)]/i,
    /\b(?:vol(?:ume)?|v|book|bk|part|pt)\.?\s*0*(\d+(?:\.\d+)?)\b/i,
    /#\s*0*(\d+(?:\.\d+)?)\b/i,
    /(?:အတွဲ|အပိုင်း|အခန်း)\s*([၀-၉]+|\d+(?:\.\d+)?)/,
    /(?<=[a-zA-Z\u00A0-\uFFFF]\s+)0*(\d{1,3})\s*[-–—:]/i,
    /(?<=[a-zA-Z\u00A0-\uFFFF]\s+)0*(\d{1,3})$/i,
  ];

  for (const p of patterns) {
    const m = s.match(p);
    if (m) {
      if (
        m[0].startsWith("(") &&
        m[1].length === 4 &&
        parseInt(m[1], 10) >= 1900 &&
        parseInt(m[1], 10) <= 2100 &&
        !/[vb#]/i.test(m[0])
      ) {
        continue;
      }
      const val = parseBurmeseOrAsciiNumber(m[1]);
      if (val !== null && !isNaN(val)) return val;
    }
  }
  return null;
}

/**
 * Normalize title for deduplication:
 * - Strips release metadata tags ([Light Novel], [Manga], (EPUB), [Official], [Digital], (Retail), [v01], etc.)
 * - Strips punctuation variance (:, -, —, –, ~, |, /, \, _, ,, ., ;, !, ?, etc.)
 * - Normalizes volume numbering (Vol 1, Volume 01, v1, #1, Book 1) to canonical "vol <N>"
 */
export function normalizeTitleForDedup(title: string): string {
  if (!title) return "";
  let s = title;

  // Replace underscores with space
  s = s.replace(/_/g, " ");

  // Strip file/revision version tags like [v1.0], [v2.1], (v1.0)
  s = s.replace(/[\[\(]\s*v\d+\.\d+(?:\.\d+)?\s*[\]\)]/gi, " ");

  // Standardize bracketed volume notations like [v01], [Vol 1], (Volume 02) into standard "vol <N>"
  s = s.replace(
    /[\[\(]\s*(?:vol(?:ume)?|v|book|bk|part|pt)?\.?\s*0*(\d+(?:\.\d+)?)\s*[\]\)]/gi,
    (match, num) => {
      if (
        num.length === 4 &&
        parseInt(num, 10) >= 1900 &&
        parseInt(num, 10) <= 2100 &&
        !/[vb#]/i.test(match)
      ) {
        return " ";
      }
      const val = parseBurmeseOrAsciiNumber(num);
      return val !== null && !isNaN(val) ? ` vol ${val} ` : " ";
    },
  );

  // Strip release metadata tags and pirate/domain watermarks
  s = s.replace(RELEASE_METADATA_REGEX, " ");
  s = s.replace(WATERMARK_BRACKET_REGEX, " ");
  s = s.replace(STANDALONE_WATERMARKS_REGEX, " ");
  s = s.replace(URL_REGEX, " ");
  s = s.replace(TELEGRAM_LINK_REGEX, " ");
  s = s.replace(VK_LINK_REGEX, " ");
  s = s.replace(MENTION_REGEX, " ");
  s = s.replace(WWW_REGEX, " ");
  s = s.replace(FORMAT_EXT_REGEX, " ");

  // Normalize standalone volume number after words before delimiter: "Sword Art Online 01 - Aincrad" -> "Sword Art Online vol 1 - Aincrad"
  s = s.replace(/(?<=[a-zA-Z\u00A0-\uFFFF]\s+)0*(\d{1,3})\s*[-–—:]/g, (_, num) => {
    const val = parseFloat(num);
    return !isNaN(val) ? ` vol ${val} - ` : ` ${num} - `;
  });

  // Normalize explicit volume notations in the text to "vol <N>"
  s = s.replace(
    /\b(?:vol(?:ume)?|v|book|bk|part|pt)\.?\s*0*(\d+(?:\.\d+)?)\b/gi,
    (_, num) => {
      const val = parseFloat(num);
      return !isNaN(val) ? ` vol ${val} ` : " ";
    },
  );
  s = s.replace(/#\s*0*(\d+(?:\.\d+)?)\b/g, (_, num) => {
    const val = parseFloat(num);
    return !isNaN(val) ? ` vol ${val} ` : " ";
  });

  // Burmese volume notations
  s = s.replace(
    /(?:အတွဲ|အပိုင်း|အခန်း)\s*([၀-၉]+|\d+(?:\.\d+)?)/g,
    (_, num) => {
      const val = parseBurmeseOrAsciiNumber(num);
      return val !== null && !isNaN(val) ? ` vol ${val} ` : " ";
    },
  );

  // Strip punctuation variance: :, -, —, –, ~, |, /, \, _, ,, ., ;, !, ?, etc.
  s = s.replace(/[:\-—–~|\/\\_.,;!?"'’“”`\(\)\[\]{}<>+*^&%$#@]+/g, " ");

  // Lowercase and collapse whitespace
  s = s.toLowerCase().replace(/\s+/g, " ").trim();

  return s;
}

/**
 * Normalize author list for deduplication:
 * - Strips role tags ((Author), (Artist), (Illustrator), etc.)
 * - Splits multi-author lists and sorts names alphabetically
 * - Cleans and standardizes whitespace
 */
export function normalizeAuthorForDedup(authors: string): string {
  if (!authors) return "";
  let s = authors;

  // Strip role tags in parentheses or brackets
  s = s.replace(
    /[\(\[]\s*(?:author|artist|illustrator|writer|story|art|translator|editor|creator|contributor)\s*[\)\]]/gi,
    " ",
  );

  // Strip watermarks/junk from authors
  s = cleanString(s);

  // Split by multi-author delimiters: &, and, ;, /, |, or commas separating distinct names
  const parts = s
    .split(/(?:\s*(?:&|\band\b|;|\/|\|)\s*|,\s*(?=[A-Z\u00A0-\uFFFFa-z]))/i)
    .map((p) =>
      p
        .replace(/[,\.:—_~|]+/g, " ")
        .replace(/\s+/g, " ")
        .trim(),
    )
    .filter((p) => p.length > 0 && !isJunkAuthor(p));

  // Lowercase, deduplicate, and sort alphabetically
  const unique = Array.from(new Set(parts.map((p) => p.toLowerCase()))).sort();

  return unique.join(", ");
}

/**
 * Extract series name and volume number from title or filename.
 */
export function extractSeries(
  title: string,
  filename: string = "",
): { series: string; volume: number } | null {
  const candidates = [
    title,
    filename ? filename.replace(/\.[^/.]+$/, "") : "",
  ].filter(Boolean);

  const patterns = [
    /^(.*?)[,_\s-]+(?:vol(?:ume)?|v)\.?\s*([၀-၉]+|\d+(?:\.\d+)?)(?:[\s-–—:].*)?$/i,
    /^(.*?)[,_\s-]+(?:book|bk)\.?\s*([၀-၉]+|\d+(?:\.\d+)?)(?:[\s-–—:].*)?$/i,
    /^(.*?)[,_\s-]+#\s*([၀-၉]+|\d+(?:\.\d+)?)(?:[\s-–—:].*)?$/i,
    /^(.*?)[,_\s-]+(?:part|pt)\.?\s*([၀-၉]+|\d+(?:\.\d+)?)(?:[\s-–—:].*)?$/i,
    /^(.*?)\s*[\[\(]\s*(?:vol(?:ume)?|v|book|bk|part|pt)?\.?\s*([၀-၉]+|\d+(?:\.\d+)?)\s*[\]\)](?:[\s-–—:].*)?$/i,
    /^(.*?)[,_\s-]+(?:အတွဲ|အပိုင်း|အခန်း)\s*([၀-၉]+|\d+(?:\.\d+)?)(?:[\s-–—:].*)?$/,
  ];

  for (const rawStr of candidates) {
    const strVariants = [
      rawStr,
      rawStr.replace(RELEASE_METADATA_REGEX, " ").replace(/\s+/g, " ").trim(),
    ];

    for (const str of strVariants) {
      for (const p of patterns) {
        const m = str.match(p);
        if (m) {
          const series = cleanString(m[1])
            .replace(/[,_–—:-]+$/, "")
            .trim();
          const vol = parseBurmeseOrAsciiNumber(m[2]);
          if (series.length >= 2 && vol !== null && !isNaN(vol)) {
            return { series, volume: vol };
          }
        }
      }
    }
  }
  return null;
}

/**
 * Normalize format string (e.g. from file path or format array item).
 */
export function normalizeFormat(formatOrPath: string): string {
  if (!formatOrPath) return "";
  const clean = formatOrPath.trim().replace(/^\./, "");
  const ext = clean.includes(".") ? clean.split(".").pop() : clean;
  return (ext || clean).toUpperCase().trim();
}

/**
 * Compute Dice Coefficient String Similarity (0.0 to 1.0).
 */
export function stringSimilarity(a: string, b: string): number {
  const sa = a.toLowerCase().replace(/[^a-z0-9]/g, "");
  const sb = b.toLowerCase().replace(/[^a-z0-9]/g, "");
  if (!sa || !sb) return 0;
  if (sa === sb) return 1.0;

  const minLen = Math.min(sa.length, sb.length);
  const maxLen = Math.max(sa.length, sb.length);
  if ((sa.includes(sb) || sb.includes(sa)) && minLen / maxLen >= 0.6) {
    return 0.85;
  }

  const getBigrams = (str: string) => {
    const bigrams = new Set<string>();
    for (let i = 0; i < str.length - 1; i++) {
      bigrams.add(str.slice(i, i + 2));
    }
    return bigrams;
  };

  const bgA = getBigrams(sa);
  const bgB = getBigrams(sb);
  let intersection = 0;
  for (const bg of bgA) {
    if (bgB.has(bg)) intersection++;
  }
  const total = bgA.size + bgB.size;
  return total > 0 ? (2.0 * intersection) / total : 0;
}

/**
 * Robust check if an incoming book is the same logical work as an existing book.
 * Checks series/volume consistency, author similarity, and title similarity.
 * Volume differences are guaranteed to NEVER match as duplicates.
 */
export function isSameBook(
  existing: {
    title: string;
    authors?: string;
    series?: string;
    series_index?: number;
  },
  incoming: {
    title: string;
    author?: string;
    authors?: string;
    series?: { series: string; volume: number } | null | string;
    series_index?: number;
  },
): boolean {
  const normExistingTitle = normalizeTitleForDedup(existing.title);
  const normIncomingTitle = normalizeTitleForDedup(incoming.title);
  if (!normExistingTitle || !normIncomingTitle) return false;

  const existingAuthor = existing.authors || "";
  const incomingAuthor = incoming.author || incoming.authors || "";
  const normExistingAuthor = normalizeAuthorForDedup(existingAuthor);
  const normIncomingAuthor = normalizeAuthorForDedup(incomingAuthor);
  const hasKnownAuthors =
    normExistingAuthor &&
    normIncomingAuthor &&
    !isJunkAuthor(normExistingAuthor) &&
    !isJunkAuthor(normIncomingAuthor);
  const authorSim = hasKnownAuthors
    ? stringSimilarity(normExistingAuthor, normIncomingAuthor)
    : 1.0;

  // 1. Series and Volume verification (deterministic gate)
  const existingSeries = existing.series
    ? {
        series: cleanString(existing.series),
        volume: existing.series_index || 1,
      }
    : extractSeries(existing.title);

  const incomingSeries =
    typeof incoming.series === "object" && incoming.series !== null
      ? incoming.series
      : typeof incoming.series === "string" && incoming.series
        ? {
            series: cleanString(incoming.series),
            volume: incoming.series_index || 1,
          }
        : extractSeries(incoming.title);

  if (existingSeries && incomingSeries) {
    const normES = normalizeTitleForDedup(existingSeries.series);
    const normIS = normalizeTitleForDedup(incomingSeries.series);
    const sameSeries =
      normES === normIS ||
      (isCompatibleSeriesName(normES, normIS) &&
        (!hasKnownAuthors || authorSim >= 0.6));
    if (sameSeries) {
      return existingSeries.volume === incomingSeries.volume;
    }
    return false;
  } else {
    // Check volume numbers extracted from titles
    const volA = extractVolumeNumber(existing.title);
    const volB = extractVolumeNumber(incoming.title);
    if (volA !== null && volB !== null && volA !== volB) {
      return false; // Different volumes are NEVER duplicates
    }
    if (existingSeries && !incomingSeries) {
      const vol = extractVolumeNumber(incoming.title);
      if (vol !== null && vol !== existingSeries.volume) return false;
    } else if (incomingSeries && !existingSeries) {
      const vol = extractVolumeNumber(existing.title);
      if (vol !== null && vol !== incomingSeries.volume) return false;
    }
  }

  // Check all numbers in normalized titles: different numbers mean distinct volumes/works
  const numsA = normExistingTitle.match(/\b\d+(?:\.\d+)?\b/g) || [];
  const numsB = normIncomingTitle.match(/\b\d+(?:\.\d+)?\b/g) || [];
  if (numsA.length > 0 && numsB.length > 0) {
    const setB = new Set(numsB);
    const hasSharedNumber = numsA.some((n) => setB.has(n));
    if (!hasSharedNumber) {
      return false; // Conflicting numbers indicate distinct volumes/entries
    }
  }

  // 2. Author conflict check
  if (hasKnownAuthors && authorSim < 0.35) {
    return false;
  }

  // 3. Title comparison
  if (normExistingTitle === normIncomingTitle) return true;

  const titleSim = stringSimilarity(normExistingTitle, normIncomingTitle);
  if (titleSim >= 0.88 && (!hasKnownAuthors || authorSim >= 0.6)) return true;

  if (titleSim < 0.65) return false;

  // Subtitle / prefix match with length guard
  const minLen = Math.min(normExistingTitle.length, normIncomingTitle.length);
  if (
    minLen >= 10 &&
    (normExistingTitle.startsWith(normIncomingTitle) ||
      normIncomingTitle.startsWith(normExistingTitle))
  ) {
    const shorter =
      normExistingTitle.length <= normIncomingTitle.length
        ? normExistingTitle
        : normIncomingTitle;
    const longer =
      normExistingTitle.length <= normIncomingTitle.length
        ? normIncomingTitle
        : normExistingTitle;
    const remainder = longer.slice(shorter.length).trim();
    if (!hasDistinctWorkMarker(remainder)) {
      if (!hasKnownAuthors || authorSim >= 0.6) {
        if (titleSim >= 0.8) return true;
      }
    }
  }

  return false;
}

/**
 * Arbitrate ambiguous duplicate candidates using Jev System-1 triage model.
 * Endpoint: https://api.typesafe.ai/v1/systemone
 */
export async function classifyDuplicateWithJev(
  bookA: {
    title: string;
    authors?: string;
    series?: string;
    series_index?: number;
  },
  bookB: {
    title: string;
    author?: string;
    authors?: string;
    series?: { series: string; volume: number } | null | string;
    series_index?: number;
  },
  options: { apiKey?: string; timeoutMs?: number } = {},
): Promise<{ isDuplicate: boolean; confidence: number } | null> {
  const apiKey = (
    options.apiKey ||
    process.env.JEV_API_KEY ||
    process.env.TYPESAFE_API_KEY ||
    ""
  ).trim();

  if (!apiKey) return null;

  const authorB = bookB.author || bookB.authors || "Unknown";
  const seriesB =
    typeof bookB.series === "object" && bookB.series !== null
      ? `${bookB.series.series} #${bookB.series.volume}`
      : bookB.series
        ? `${bookB.series} #${bookB.series_index || 1}`
        : "";
  const seriesA = bookA.series
    ? `${bookA.series} #${bookA.series_index || 1}`
    : "";

  const stateText = `Compare these two books to determine if they are the exact same logical book / duplicate edition, or distinct works / different volumes:

Book 1:
- Title: ${bookA.title}
- Author: ${bookA.authors || "Unknown"}
${seriesA ? `- Series: ${seriesA}` : ""}

Book 2:
- Title: ${bookB.title}
- Author: ${authorB}
${seriesB ? `- Series: ${seriesB}` : ""}

Task: Classify whether Book 1 and Book 2 are duplicates (same book/edition) or distinct (different books, different volumes in a series, or different works). Note: Different volumes in a series are NEVER duplicates.`;

  const timeout = options.timeoutMs || 3000;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeout);

  try {
    const res = await safeFetchWithSsrf("https://api.typesafe.ai/v1/systemone", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${apiKey}`,
      },
      redirect: "error",
      body: JSON.stringify({
        model: "jev-latest",
        state: stateText,
        questions: {
          is_duplicate: {
            type: "choice",
            instructions:
              "Decide whether Book 1 and Book 2 are the exact same logical work / duplicate edition, or distinct books / different volumes in a series.",
            criteria: {
              duplicate:
                "Identical book or identical volume of the same work, even if title subtitle punctuation or release tags vary.",
              distinct:
                "Different volumes in a series (e.g. Vol 1 vs Vol 2), different subtitles representing different entries, or entirely different works.",
            },
          },
        },
      }),
      signal: controller.signal,
    });

    if (!res.ok) {
      clearTimeout(timer);
      return null;
    }
    const json = (await res.json()) as any;
    clearTimeout(timer);
    const ans = json?.answers?.is_duplicate;
    if (ans && ans.choice) {
      return {
        isDuplicate: ans.choice === "duplicate",
        confidence: typeof ans.confidence === "number" ? ans.confidence : 0.85,
      };
    }
  } catch {
    clearTimeout(timer);
  }

  return null;
}

/**
 * Async book duplicate checker with Jev System-1 arbitration for ambiguous similarity.
 */
export async function isSameBookAsync(
  existing: {
    title: string;
    authors?: string;
    series?: string;
    series_index?: number;
  },
  incoming: {
    title: string;
    author?: string;
    authors?: string;
    series?: { series: string; volume: number } | null | string;
    series_index?: number;
  },
  options: { jevApiKey?: string; timeoutMs?: number } = {},
): Promise<boolean> {
  const normExistingTitle = normalizeTitleForDedup(existing.title);
  const normIncomingTitle = normalizeTitleForDedup(incoming.title);
  if (!normExistingTitle || !normIncomingTitle) return false;

  const existingAuthor = existing.authors || "";
  const incomingAuthor = incoming.author || incoming.authors || "";
  const normExistingAuthor = normalizeAuthorForDedup(existingAuthor);
  const normIncomingAuthor = normalizeAuthorForDedup(incomingAuthor);

  // 1. Series and Volume verification (deterministic gate)
  const existingSeries = existing.series
    ? {
        series: cleanString(existing.series),
        volume: existing.series_index || 1,
      }
    : extractSeries(existing.title);

  const incomingSeries =
    typeof incoming.series === "object" && incoming.series !== null
      ? incoming.series
      : typeof incoming.series === "string" && incoming.series
        ? {
            series: cleanString(incoming.series),
            volume: incoming.series_index || 1,
          }
        : extractSeries(incoming.title);

  if (existingSeries && incomingSeries) {
    const sameSeries =
      normalizeTitleForDedup(existingSeries.series) ===
      normalizeTitleForDedup(incomingSeries.series);
    if (sameSeries) {
      return existingSeries.volume === incomingSeries.volume;
    }
    return false;
  } else {
    // Check volume numbers extracted from titles
    const volA = extractVolumeNumber(existing.title);
    const volB = extractVolumeNumber(incoming.title);
    if (volA !== null && volB !== null && volA !== volB) {
      return false; // Different volumes are NEVER duplicates
    }
    if (existingSeries && !incomingSeries) {
      const vol = extractVolumeNumber(incoming.title);
      if (vol !== null && vol !== existingSeries.volume) return false;
    } else if (incomingSeries && !existingSeries) {
      const vol = extractVolumeNumber(existing.title);
      if (vol !== null && vol !== incomingSeries.volume) return false;
    }
  }

  // Check all numbers in normalized titles: different numbers mean distinct volumes/works
  const numsA = normExistingTitle.match(/\b\d+(?:\.\d+)?\b/g) || [];
  const numsB = normIncomingTitle.match(/\b\d+(?:\.\d+)?\b/g) || [];
  if (numsA.length > 0 && numsB.length > 0) {
    const setB = new Set(numsB);
    const hasSharedNumber = numsA.some((n) => setB.has(n));
    if (!hasSharedNumber) {
      return false; // Conflicting numbers indicate distinct volumes/entries
    }
  }

  // 2. Author conflict check (deterministic gate)
  const hasKnownAuthors =
    normExistingAuthor &&
    normIncomingAuthor &&
    !isJunkAuthor(normExistingAuthor) &&
    !isJunkAuthor(normIncomingAuthor);
  const authorSim = hasKnownAuthors
    ? stringSimilarity(normExistingAuthor, normIncomingAuthor)
    : 1.0;
  if (hasKnownAuthors && authorSim < 0.35) {
    return false;
  }

  // 3. Exact normalized title match
  if (normExistingTitle === normIncomingTitle) return true;

  // 4. Similarity calculation
  const titleSim = stringSimilarity(normExistingTitle, normIncomingTitle);

  // Definitively NOT a duplicate (< 0.65)
  if (titleSim < 0.65) return false;

  // Definitively a duplicate (>= 0.88 with compatible author)
  if (titleSim >= 0.88 && (!hasKnownAuthors || authorSim >= 0.6)) return true;

  // 5. Ambiguous Zone: 0.65 <= titleSim < 0.88 -> Query Jev System-1
  const jevVerdict = await classifyDuplicateWithJev(existing, incoming, {
    apiKey: options.jevApiKey,
    timeoutMs: options.timeoutMs,
  });
  if (jevVerdict && jevVerdict.confidence >= 0.7) {
    return jevVerdict.isDuplicate;
  }

  // Graceful fallback if Jev unavailable or inconclusive
  const minLen = Math.min(normExistingTitle.length, normIncomingTitle.length);
  if (
    minLen >= 10 &&
    (normExistingTitle.startsWith(normIncomingTitle) ||
      normIncomingTitle.startsWith(normExistingTitle))
  ) {
    if (!hasKnownAuthors || authorSim >= 0.6) {
      if (titleSim >= 0.8) return true;
    }
  }

  return false;
}

// ---------------------------------------------------------------------------
// External Metadata Scrapers
// ---------------------------------------------------------------------------

// 1. MangaDex Scraper
export async function searchMangaDex(
  query: string,
  options?: { preserveVolume?: boolean },
): Promise<ScrapedMetadata[]> {
  const results: ScrapedMetadata[] = [];
  const cleanQ = cleanQuery(query, options);
  if (!cleanQ) return results;

  try {
    const url = `https://api.mangadex.org/manga?title=${encodeURIComponent(cleanQ)}&limit=3&includes[]=cover_art&includes[]=author`;
    const res = await safeFetchWithSsrf(url, {
      headers: { "User-Agent": "ReadingHQ/1.0" },
      signal: AbortSignal.timeout(SCRAPER_TIMEOUT_MS),
      proxy: PROXY,
    } as any);

    if (res.ok) {
      const json: any = await res.json();
      if (json.data) {
        for (const item of json.data) {
          const attr = item.attributes || {};
          const title =
            attr.title?.en ||
            attr.title?.["ja-ro"] ||
            Object.values(attr.title || {})[0] ||
            "";
          if (!title) continue;

          let author = "";
          let coverFilename = "";
          for (const rel of item.relationships || []) {
            if (rel.type === "author" && rel.attributes?.name)
              author = rel.attributes.name;
            if (rel.type === "cover_art" && rel.attributes?.fileName)
              coverFilename = rel.attributes.fileName;
          }

          const coverUrl = coverFilename
            ? `https://uploads.mangadex.org/covers/${item.id}/${coverFilename}.512.jpg`
            : "";
          const tags: string[] = (attr.tags || [])
            .map((t: any) => t.attributes?.name?.en)
            .filter(Boolean);
          tags.unshift("Manga");

          const sim = stringSimilarity(cleanQ, title);
          results.push({
            title,
            authors: author || "Unknown",
            description: attr.description?.en || "",
            publishedDate: attr.year ? String(attr.year) : "",
            coverUrl,
            tags,
            source: "MangaDex",
            confidence: Math.round(sim * 100) / 100,
            isManga: true,
          });
        }
      }
    }
  } catch (err: any) {
    console.debug(
      `[Scraper:MangaDex] Query "${cleanQ}" failed:`,
      err?.message || err,
    );
  }
  return results;
}

// 2. Bangumi Scraper
export async function searchBangumi(
  query: string,
  options?: { preserveVolume?: boolean },
): Promise<ScrapedMetadata[]> {
  const results: ScrapedMetadata[] = [];
  const cleanQ = cleanQuery(query, options);
  if (!cleanQ) return results;

  try {
    const url = `https://api.bgm.tv/search/subject/${encodeURIComponent(cleanQ)}?type=1&responseGroup=medium`;
    const res = await safeFetchWithSsrf(url, {
      headers: { "User-Agent": "ReadingHQ/1.0" },
      signal: AbortSignal.timeout(SCRAPER_TIMEOUT_MS),
      proxy: PROXY,
    } as any);

    if (res.ok) {
      const json: any = await res.json();
      if (json.list) {
        for (const item of json.list.slice(0, 3)) {
          const title = item.name_cn || item.name || "";
          if (!title) continue;

          const cleanTitle = cleanQuery(title, options);
          const sim = Math.max(
            stringSimilarity(cleanQ, item.name || ""),
            stringSimilarity(cleanQ, item.name_cn || ""),
            cleanTitle ? stringSimilarity(cleanQ, cleanTitle) : 0,
          );
          results.push({
            title,
            authors: "", // Bangumi search results often omit author in summary list
            description: item.summary || "",
            publishedDate: item.air_date || "",
            coverUrl: item.images?.large || item.images?.common || "",
            tags: ["Manga"],
            source: "Bangumi",
            confidence: Math.round(sim * 100) / 100,
            isManga: true,
          });
        }
      }
    }
  } catch (err: any) {
    console.debug(
      `[Scraper:Bangumi] Query "${cleanQ}" failed:`,
      err?.message || err,
    );
  }
  return results;
}

// 3. Google Books Scraper
export async function searchGoogleBooks(
  query: string,
  options?: { preserveVolume?: boolean },
): Promise<ScrapedMetadata[]> {
  const results: ScrapedMetadata[] = [];
  const trimmed = (query || "").trim();
  const isIsbn =
    /^isbn:\s*(?:97[89][\d-]{10,14}|\d[\d-]{8,12}[\dX])$/i.test(trimmed) ||
    /^(?:97[89]\d{10}|\d{9}[\dX])$/i.test(trimmed.replace(/[\s-]/g, ""));

  let cleanQ: string;
  let url: string;

  if (isIsbn) {
    const rawIsbn = trimmed.replace(/^isbn:\s*/i, "").replace(/[^0-9Xx]/g, "");
    cleanQ = `isbn:${rawIsbn}`;
    url = `https://www.googleapis.com/books/v1/volumes?q=isbn:${encodeURIComponent(rawIsbn)}&maxResults=3`;
  } else {
    cleanQ = cleanQuery(query, options);
    if (!cleanQ) return results;
    url = `https://www.googleapis.com/books/v1/volumes?q=${encodeURIComponent(cleanQ)}&maxResults=3`;
  }

  try {
    const res = await safeFetchWithSsrf(url, {
      headers: { "User-Agent": "ReadingHQ/1.0" },
      signal: AbortSignal.timeout(SCRAPER_TIMEOUT_MS),
      proxy: PROXY,
    } as any);

    if (res.ok) {
      const json: any = await res.json();
      if (json.items && Array.isArray(json.items)) {
        for (const item of json.items.slice(0, 3)) {
          const info = item.volumeInfo || {};
          const title = info.title || "";
          if (!title) continue;

          const authors = (info.authors || []).join(", ");
          const coverUrl =
            info.imageLinks?.thumbnail || info.imageLinks?.smallThumbnail || "";
          const secureCover = coverUrl
            ? coverUrl
                .replace(/^http:\/\//i, "https://")
                .replace("&edge=curl", "")
            : "";
          const tags: string[] = (info.categories || []).slice(0, 4);

          const cleanTitle = cleanQuery(title, options);
          let sim = 1.0;
          if (!isIsbn) {
            const rawSim = stringSimilarity(cleanQ, title);
            const cleanSim = cleanTitle ? stringSimilarity(cleanQ, cleanTitle) : 0;
            sim = Math.max(rawSim, cleanSim);
          }
          results.push({
            title,
            authors: authors || "Unknown",
            publisher: info.publisher || "",
            publishedDate: info.publishedDate || "",
            description: info.description || "",
            coverUrl: secureCover,
            tags,
            source: "GoogleBooks",
            confidence: Math.round(sim * 100) / 100,
            isManga: false,
          });
        }
      }
    }
  } catch (err: any) {
    console.debug(
      `[Scraper:GoogleBooks] Query "${cleanQ}" failed:`,
      err?.message || err,
    );
  }
  return results;
}

// 4. OpenLibrary Scraper
export async function searchOpenLibrary(
  query: string,
  options?: { preserveVolume?: boolean },
): Promise<ScrapedMetadata[]> {
  const results: ScrapedMetadata[] = [];
  const trimmed = (query || "").trim();
  const isIsbn =
    /^isbn:\s*(?:97[89][\d-]{10,14}|\d[\d-]{8,12}[\dX])$/i.test(trimmed) ||
    /^(?:97[89]\d{10}|\d{9}[\dX])$/i.test(trimmed.replace(/[\s-]/g, ""));

  let cleanQ: string;
  let url: string;

  if (isIsbn) {
    const rawIsbn = trimmed.replace(/^isbn:\s*/i, "").replace(/[^0-9Xx]/g, "");
    cleanQ = `isbn:${rawIsbn}`;
    url = `https://openlibrary.org/search.json?isbn=${encodeURIComponent(rawIsbn)}&limit=3`;
  } else {
    cleanQ = cleanQuery(query, options);
    if (!cleanQ) return results;
    url = `https://openlibrary.org/search.json?q=${encodeURIComponent(cleanQ)}&limit=3`;
  }

  try {
    const res = await safeFetchWithSsrf(url, {
      signal: AbortSignal.timeout(SCRAPER_TIMEOUT_MS),
      proxy: PROXY,
    } as any);

    if (res.ok) {
      const json: any = await res.json();
      if (json.docs) {
        for (const doc of json.docs) {
          const title = doc.title || "";
          if (!title) continue;

          const authors = (doc.author_name || []).join(", ");
          const coverId = doc.cover_i;
          const coverUrl = coverId
            ? `https://covers.openlibrary.org/b/id/${coverId}-L.jpg`
            : "";
          const tags = doc.subject ? doc.subject.slice(0, 4) : [];

          const cleanTitle = cleanQuery(title, options);
          let sim = 1.0;
          if (!isIsbn) {
            const rawSim = stringSimilarity(cleanQ, title);
            const cleanSim = cleanTitle ? stringSimilarity(cleanQ, cleanTitle) : 0;
            sim = Math.max(rawSim, cleanSim);
          }
          results.push({
            title,
            authors: authors || "Unknown",
            publisher: (doc.publisher || [])[0] || "",
            publishedDate: doc.first_publish_year
              ? String(doc.first_publish_year)
              : "",
            description: Array.isArray(doc.first_sentence)
              ? doc.first_sentence[0]
              : doc.first_sentence || "",
            coverUrl,
            tags,
            source: "OpenLibrary",
            confidence: Math.round(sim * 100) / 100,
            isManga: false,
          });
        }
      }
    }
  } catch (err: any) {
    console.debug(
      `[Scraper:OpenLibrary] Query "${cleanQ}" failed:`,
      err?.message || err,
    );
  }
  return results;
}

// 5. RanobeDB Light Novel Scraper
export function formatRanobeDate(rawDate?: number | string | null): string {
  if (!rawDate) return "";
  const s = String(rawDate).trim();
  if (!/^\d+$/.test(s) || s.startsWith("9999") || s === "0") return "";
  if (s.length === 8) {
    const y = s.slice(0, 4);
    const m = s.slice(4, 6);
    const d = s.slice(6, 8);
    return `${y}-${m}-${d}`;
  }
  if (s.length === 6) {
    const y = s.slice(0, 4);
    const m = s.slice(4, 6);
    return `${y}-${m}`;
  }
  if (s.length === 4) {
    return s;
  }
  return "";
}

export function isLightNovelQuery(query: string): boolean {
  if (!query) return false;
  // Check both raw query and query with punctuation normalized/space-collapsed
  const normalized = query.replace(/[:_\-]+/g, " ");
  const pattern =
    /\b(?:light[\s_-]?novel|ln|web[\s_-]?novel|wn|ranobe|bunko|isekai|reincarnat(?:ed|ion)?|danmachi|(?:\w+)?monogatari|oregairu|tensura|konosuba|sword\s*art\s*online|overlord|mushoku\s*tensei|classroom\s*of\s*the\s*elite|re:?\s*zero|toaru|mahouka|no\s*game\s*no\s*life|spice\s*and\s*wolf|rascal\s*does\s*not\s*dream)\b/i;
  return pattern.test(query) || pattern.test(normalized);
}

export function parseRanobeBook(
  book: any,
  query: string,
  fallbackHit?: any,
): ScrapedMetadata {
  const targetVol = extractVolumeNumber(query);
  const cleanQ = cleanQuery(query, { preserveVolume: targetVol !== null });
  const title =
    book.title ||
    book.title_orig ||
    fallbackHit?.title ||
    fallbackHit?.title_orig ||
    "";

  let authors = (book.editions?.[0]?.staff || [])
    .filter((s: any) => s.role_type === "author")
    .map((s: any) => s.name)
    .filter(Boolean)
    .join(", ");

  if (!authors && Array.isArray(book.editions)) {
    for (const ed of book.editions) {
      const list = (ed.staff || [])
        .filter((s: any) => s.role_type === "author")
        .map((s: any) => s.name)
        .filter(Boolean);
      if (list.length > 0) {
        authors = Array.from(new Set(list)).join(", ");
        break;
      }
    }
  }

  const rawTags = (book.series?.tags || fallbackHit?.series?.tags || [])
    .map((t: any) => (typeof t === "string" ? t : t?.name))
    .filter(Boolean);
  const tags = Array.from(new Set(["Light Novel", ...rawTags]));

  const filename = book.image?.filename || fallbackHit?.image?.filename;
  const coverUrl = filename
    ? `https://images.ranobedb.org/${filename}`
    : undefined;

  let candidateVol: number | null = null;
  if (title) candidateVol = extractVolumeNumber(title);
  if (candidateVol === null && book.title_orig) candidateVol = extractVolumeNumber(book.title_orig);
  if (candidateVol === null && fallbackHit?.title) candidateVol = extractVolumeNumber(fallbackHit.title);
  if (candidateVol === null && book.volume !== undefined && book.volume !== null && !isNaN(Number(book.volume))) {
    candidateVol = Number(book.volume);
  }

  let sim = Math.max(
    stringSimilarity(cleanQ, title),
    stringSimilarity(cleanQ, book.title_orig || fallbackHit?.title_orig || ""),
    stringSimilarity(cleanQ, book.romaji || fallbackHit?.romaji || ""),
    targetVol === null
      ? stringSimilarity(
          cleanQ,
          book.series?.title || fallbackHit?.series?.title || "",
        )
      : 0,
  );

  // Volume conflict guard: if searching with a specific volume number V_target,
  // any candidate book with an identifiable volume number V_candidate != V_target
  // must NOT be assigned high confidence. Penalize confidence to 0 so mismatched
  // volumes never trigger the >= 0.85 auto-apply threshold.
  if (targetVol !== null && candidateVol !== null && candidateVol !== targetVol) {
    sim = 0;
  } else if (targetVol !== null && candidateVol === null && targetVol > 1) {
    // If target has volume > 1 but candidate has no volume, cap confidence < 0.85
    // so generic series entries never auto-overwrite volume books.
    sim = Math.min(sim, 0.7);
  }

  return {
    title,
    authors: authors || "Unknown",
    publisher: book.series?.title || fallbackHit?.series?.title || "",
    publishedDate: formatRanobeDate(
      book.c_release_date ?? fallbackHit?.c_release_date,
    ),
    description:
      book.description ||
      book.description_ja ||
      book.series?.description ||
      fallbackHit?.series?.description ||
      "",
    coverUrl,
    tags,
    source: "RanobeDB",
    confidence: Math.round(sim * 100) / 100,
    isManga: false,
  };
}

export async function searchRanobeDB(
  query: string,
  options?: {
    baseUrl?: string;
    timeoutMs?: number;
    fetchFn?: (url: string, init?: any) => Promise<Response>;
    preserveVolume?: boolean;
  },
): Promise<ScrapedMetadata[]> {
  const results: ScrapedMetadata[] = [];
  const cleanQ = cleanQuery(query, { preserveVolume: options?.preserveVolume });
  if (!cleanQ) return results;

  const apiBase = options?.baseUrl || "https://ranobedb.org/api/v0";
  const timeoutMs = options?.timeoutMs || SCRAPER_TIMEOUT_MS;
  const doFetch =
    options?.fetchFn ||
    ((url: string, init?: any) =>
      safeFetchWithSsrf(url, {
        headers: { "User-Agent": "ReadingHQ/1.0", Accept: "application/json" },
        signal: AbortSignal.timeout(timeoutMs),
        proxy: PROXY,
        ...init,
      } as any));

  try {
    const searchUrl = `${apiBase}/books?q=${encodeURIComponent(cleanQ)}&limit=4`;
    const res = await doFetch(searchUrl);

    let bookHits: any[] = [];
    if (res.ok) {
      const json: any = await res.json();
      if (Array.isArray(json.books)) {
        bookHits = json.books;
      } else if (Array.isArray(json.data)) {
        bookHits = json.data;
      } else if (Array.isArray(json)) {
        bookHits = json;
      }
    }

    // Series search fallback: if /books returns 0 hits, try GET /series?q=${encodeURIComponent(cleanQ)}&limit=2
    if (bookHits.length === 0) {
      const seriesUrl = `${apiBase}/series?q=${encodeURIComponent(cleanQ)}&limit=2`;
      const sRes = await doFetch(seriesUrl);

      if (sRes.ok) {
        const sJson: any = await sRes.json();
        const seriesList = Array.isArray(sJson.series)
          ? sJson.series
          : Array.isArray(sJson.data)
          ? sJson.data
          : [];

        for (const s of seriesList.slice(0, 2)) {
          if (s.book?.id) {
            bookHits.push(s.book);
          } else if (s.id) {
            try {
              const dRes = await doFetch(`${apiBase}/series/${s.id}`);
              if (dRes.ok) {
                const dJson: any = await dRes.json();
                const seriesObj = dJson.series || dJson;
                if (
                  Array.isArray(seriesObj.books) &&
                  seriesObj.books.length > 0
                ) {
                  bookHits.push(seriesObj.books[0]);
                }
              }
            } catch {
              // Ignore series detail error
            }
          }
        }
      }
    }

    // For top book hits, fetch detailed metadata via GET /book/${book.id}
    const detailSettled = await Promise.allSettled(
      bookHits.slice(0, 4).map(async (hit: any) => {
        if (!hit.id) return null;
        try {
          const bRes = await doFetch(`${apiBase}/book/${hit.id}`);
          if (bRes.ok) {
            const bJson: any = await bRes.json();
            const book = bJson.book || bJson;
            return parseRanobeBook(book, query, hit);
          }
        } catch {
          return parseRanobeBook(hit, query);
        }
        return parseRanobeBook(hit, query);
      }),
    );

    for (const d of detailSettled) {
      if (d.status === "fulfilled" && d.value) {
        results.push(d.value);
      }
    }
  } catch (err: any) {
    console.debug(
      `[Scraper:RanobeDB] Query "${cleanQ}" failed:`,
      err?.message || err,
    );
  }

  return results;
}

// ---------------------------------------------------------------------------
// 6. AniList Scraper (GraphQL API for Light Novels, Korean Web Novels & Manga)
// ---------------------------------------------------------------------------

export const ANILIST_GRAPHQL_QUERY = `
query ($search: String) {
  Media(search: $search, type: MANGA, format_in: [NOVEL, MANGA]) {
    id
    title {
      english
      romaji
      native
    }
    description
    coverImage {
      extraLarge
      large
      medium
    }
    genres
    tags {
      name
      rank
    }
    startDate {
      year
      month
      day
    }
    format
    status
    staff {
      edges {
        role
        node {
          name {
            full
          }
        }
      }
    }
  }
}
`;

export function cleanAniListDescription(raw: string): string {
  if (!raw) return "";
  let s = raw;
  // Convert line breaks and block elements to newlines
  s = s.replace(/<br\s*\/?>/gi, "\n");
  s = s.replace(/<\/(?:p|div|li|blockquote)>/gi, "\n\n");
  // Strip all remaining HTML tags
  s = s.replace(/<[^>]+>/g, "");
  // Decode HTML entities
  s = decodeHtmlEntities(s);
  // Normalize whitespace
  s = s.replace(/\r\n/g, "\n").replace(/[ \t]+/g, " ");
  s = s.replace(/\n{3,}/g, "\n\n").trim();
  return s;
}

/**
 * Builds standard POST RequestInit for AniList GraphQL searches.
 */
function buildAniListInit(cleanQ: string) {
  return {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Accept: "application/json",
      "User-Agent": "ReadingHQ/1.0",
    },
    body: JSON.stringify({
      query: ANILIST_GRAPHQL_QUERY,
      variables: { search: cleanQ },
    }),
  };
}

/**
 * AniList Rate Limiter & Request Pacing
 * Minimum interval between consecutive AniList queries (defaults to 700ms, ~85 req/min).
 * Quota maximum cap for single Retry-After backoff sleep (60s).
 */
export const ANILIST_MIN_INTERVAL_MS = 700;
export const MAX_RETRY_AFTER_MS = 60_000;

let lastAniListCallTimestamp = 0;
let aniListExecutionQueue: Promise<void> = Promise.resolve();

export function resetAniListPacing(): void {
  lastAniListCallTimestamp = 0;
  aniListExecutionQueue = Promise.resolve();
}

/**
 * Resolves the sleep function to use. If not supplied, defaults to setTimeout,
 * resolving immediately in test environments unless explicitly injected.
 */
function resolveSleepFn(
  sleepFn?: (ms: number) => Promise<void>,
): (ms: number) => Promise<void> {
  if (sleepFn) return sleepFn;
  const isTestEnv =
    process.env.NODE_ENV === "test" ||
    typeof (globalThis as any).it === "function";
  return (ms: number) =>
    new Promise((resolve) => setTimeout(resolve, isTestEnv ? 0 : ms));
}

/**
 * Parse Retry-After header from an HTTP 429 response.
 * Handles integer seconds, floats, or HTTP-date format, returning bounded milliseconds.
 */
export function parseRetryAfterMs(
  header?: string | null,
  defaultMs: number = 2000,
  maxMs: number = MAX_RETRY_AFTER_MS,
): number {
  if (!header) return defaultMs;
  const trimmed = header.trim();
  if (!trimmed) return defaultMs;

  const seconds = Number(trimmed);
  if (Number.isFinite(seconds)) {
    if (seconds < 0) return defaultMs;
    return Math.min(Math.round(seconds * 1000), maxMs);
  }

  const timestamp = Date.parse(trimmed);
  if (Number.isFinite(timestamp)) {
    const diff = timestamp - Date.now();
    if (diff < 0) return defaultMs;
    return Math.min(diff, maxMs);
  }

  return defaultMs;
}

/**
 * Enforces request pacing between consecutive AniList API calls (min 700ms).
 */
export async function paceAniListRequest(
  minIntervalMs: number = ANILIST_MIN_INTERVAL_MS,
  sleepFn?: (ms: number) => Promise<void>,
): Promise<void> {
  const doSleep = resolveSleepFn(sleepFn);
  const now = Date.now();
  const elapsed = now - lastAniListCallTimestamp;
  const waitTime = minIntervalMs - elapsed;
  if (waitTime > 0) {
    await doSleep(waitTime);
  }
  lastAniListCallTimestamp = Date.now();
}

/**
 * Internal single-request execution within the serialized process-wide queue.
 */
async function executeAniListSearch(
  cleanQ: string,
  options?: {
    baseUrl?: string;
    timeoutMs?: number;
    fetchFn?: (url: string, init?: any) => Promise<Response>;
    minIntervalMs?: number;
    sleepFn?: (ms: number) => Promise<void>;
  },
): Promise<ScrapedMetadata[]> {
  const results: ScrapedMetadata[] = [];
  const minIntervalMs = options?.minIntervalMs ?? ANILIST_MIN_INTERVAL_MS;
  const doSleep = resolveSleepFn(options?.sleepFn);

  // Enforce minimum spacing (700ms) after the previous call (or retry)
  await paceAniListRequest(minIntervalMs, options?.sleepFn);

  const apiEndpoint = options?.baseUrl || "https://graphql.anilist.co";
  const timeoutMs = options?.timeoutMs || SCRAPER_TIMEOUT_MS;
  const doFetch =
    options?.fetchFn ||
    ((url: string, init?: any) =>
      safeFetchWithSsrf(url, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Accept: "application/json",
          "User-Agent": "ReadingHQ/1.0",
        },
        signal: AbortSignal.timeout(timeoutMs),
        proxy: PROXY,
        ...init,
      } as any));

  try {
    let res = await doFetch(apiEndpoint, buildAniListInit(cleanQ));
    lastAniListCallTimestamp = Date.now();

    if (res.status === 429) {
      const retryAfterHeader =
        (typeof res.headers?.get === "function"
          ? res.headers.get("Retry-After") || res.headers.get("retry-after")
          : undefined);
      const backoffMs = parseRetryAfterMs(retryAfterHeader, 2000);

      console.warn(
        `[Scraper:AniList] Rate limit (HTTP 429) encountered for query "${cleanQ}". Backing off for ${backoffMs}ms before retry...`,
      );

      // Sleep for backoff duration while holding the process-wide queue
      await doSleep(backoffMs);

      // Enforce minIntervalMs before the retry dispatch
      await paceAniListRequest(minIntervalMs, options?.sleepFn);

      // Retry once after backoff
      res = await doFetch(apiEndpoint, buildAniListInit(cleanQ));
      lastAniListCallTimestamp = Date.now();

      if (res.status === 429) {
        console.warn(
          `[Scraper:AniList] Rate limit (HTTP 429) persisted on retry for query "${cleanQ}".`,
        );
        return results;
      }
    }

    if (!res.ok) {
      console.debug(
        `[Scraper:AniList] HTTP error ${res.status} (${res.statusText}) for query "${cleanQ}"`,
      );
      return results;
    }

    const json: any = await res.json();
    if (Array.isArray(json.errors) && json.errors.length > 0) {
      console.debug(
        `[Scraper:AniList] GraphQL error for query "${cleanQ}":`,
        json.errors[0]?.message || json.errors[0],
      );
      return results;
    }
    const mediaList: any[] = [];
    if (json.data?.Media) {
      mediaList.push(json.data.Media);
    } else if (Array.isArray(json.data?.Page?.media)) {
      mediaList.push(...json.data.Page.media);
    } else if (Array.isArray(json.data?.media)) {
      mediaList.push(...json.data.media);
    }

    for (const media of mediaList) {
        if (!media || !media.id) continue;
        const titleEn = media.title?.english?.trim() || "";
        const titleRomaji = media.title?.romaji?.trim() || "";
        const titleNative = media.title?.native?.trim() || "";
        const title = titleEn || titleRomaji || titleNative;
        if (!title) continue;

        let author = "";
        if (Array.isArray(media.staff?.edges)) {
          const storyEdge = media.staff.edges.find((e: any) =>
            /original\s*story|story|author|creator/i.test(e.role || ""),
          );
          if (storyEdge?.node?.name?.full) {
            author = storyEdge.node.name.full;
          } else if (media.staff.edges[0]?.node?.name?.full) {
            author = media.staff.edges[0].node.name.full;
          }
        }

        const rawDesc = media.description || "";
        const description = cleanAniListDescription(rawDesc);

        const rawCover =
          media.coverImage?.extraLarge ||
          media.coverImage?.large ||
          media.coverImage?.medium ||
          "";
        const coverUrl =
          rawCover && isAllowedCoverUrl(rawCover) ? rawCover : "";

        const genres: string[] = Array.isArray(media.genres) ? media.genres : [];
        const tagNames: string[] = Array.isArray(media.tags)
          ? media.tags
              .map((t: any) => (typeof t === "string" ? t : t?.name))
              .filter(Boolean)
          : [];

        const isNovel = media.format === "NOVEL";
        const isManga = media.format === "MANGA" || !isNovel;
        const allTags: string[] = isNovel ? ["Light Novel"] : ["Manga"];
        for (const g of genres) {
          if (!allTags.includes(g)) allTags.push(g);
        }
        for (const t of tagNames) {
          if (!allTags.includes(t)) allTags.push(t);
        }

        let publishedDate = "";
        if (media.startDate?.year) {
          const y = media.startDate.year;
          const m = media.startDate.month
            ? String(media.startDate.month).padStart(2, "0")
            : "";
          const d = media.startDate.day
            ? String(media.startDate.day).padStart(2, "0")
            : "";
          publishedDate =
            y && m && d ? `${y}-${m}-${d}` : y && m ? `${y}-${m}` : String(y);
        }

        const sim = Math.max(
          stringSimilarity(cleanQ, title),
          stringSimilarity(cleanQ, titleEn),
          stringSimilarity(cleanQ, titleRomaji),
          stringSimilarity(cleanQ, titleNative),
        );

        results.push({
          title,
          authors: author || "Unknown",
          description,
          publishedDate,
          coverUrl,
          tags: allTags,
          source: "AniList",
          confidence: Math.round(sim * 100) / 100,
          isManga,
        });
      }
  } catch (err: any) {
    console.debug(
      `[Scraper:AniList] Query "${cleanQ}" failed:`,
      err?.message || err,
    );
  }

  return results;
}

export async function searchAniList(
  query: string,
  options?: {
    baseUrl?: string;
    timeoutMs?: number;
    fetchFn?: (url: string, init?: any) => Promise<Response>;
    minIntervalMs?: number;
    sleepFn?: (ms: number) => Promise<void>;
  },
): Promise<ScrapedMetadata[]> {
  const cleanQ = cleanQuery(query);
  if (!cleanQ) return [];

  // Serialize all AniList calls process-wide:
  // Each call waits for any preceding call (and its possible 429 backoff + retry) to fully complete,
  // enforces at least 700ms spacing after the last request, and holds the queue during its own backoff/retry.
  const prevQueue = aniListExecutionQueue;
  let releaseQueue: () => void = () => {};
  aniListExecutionQueue = new Promise<void>((resolve) => {
    releaseQueue = resolve;
  });

  await prevQueue;
  try {
    return await executeAniListSearch(cleanQ, options);
  } finally {
    releaseQueue();
  }
}

// Unified Search with Multi-Source Fallback & Jev-Powered Smart Routing
export async function searchUniversalMetadata(
  query: string,
  hint?:
    | boolean
    | string
    | {
        isManga?: boolean;
        isLightNovel?: boolean;
        isLn?: boolean;
        author?: string;
        filename?: string;
        tags?: string[];
        category?: BookSourceCategory;
        preserveVolume?: boolean;
      },
): Promise<ScrapedMetadata[]> {
  const results: ScrapedMetadata[] = [];
  let hintPreserveVolume = false;
  if (hint && typeof hint === "object") {
    hintPreserveVolume = Boolean(hint.preserveVolume);
  }
  const targetVol =
    extractVolumeNumber(query) ??
    (hint && typeof hint === "object" && hint.filename
      ? extractVolumeNumber(hint.filename)
      : null);

  if (targetVol !== null) {
    hintPreserveVolume = true;
  }
  const cleanQ = cleanQuery(query, { preserveVolume: hintPreserveVolume });
  if (!cleanQ) return results;

  let hintManga = false;
  let hintLn = false;
  let hintAuthor = "";
  let hintFilename = "";
  let hintTags: string[] = [];
  let explicitCategory: BookSourceCategory | undefined;

  if (typeof hint === "boolean") {
    hintManga = hint;
  } else if (typeof hint === "string") {
    hintManga = /manga|comic/i.test(hint);
    hintLn = /light[\s_-]?novel|ln|ranobe|bunko/i.test(hint);
  } else if (hint && typeof hint === "object") {
    hintManga = Boolean(hint.isManga);
    hintLn = Boolean(hint.isLightNovel || hint.isLn);
    hintAuthor = hint.author || "";
    hintFilename = hint.filename || "";
    hintTags = hint.tags || [];
    explicitCategory = hint.category;
  }

  // Determine source category using classifyBookSourceCategory (deterministic + Jev arbitration)
  let category: BookSourceCategory;
  if (explicitCategory) {
    category = explicitCategory;
  } else if (hintLn) {
    category = "light_novel";
  } else if (hintManga) {
    category = "manga";
  } else {
    // Replaces brittle hardcoded isLightNovelQuery list with classifyBookSourceCategory.
    // Check raw query and cleanQ to preserve explicit bracket tokens like [LN] or [Manga]
    category = await classifyBookSourceCategory(
      query,
      hintAuthor,
      hintFilename,
      hintTags,
    );

    // If still general/unclassified, check if isLightNovelQuery matches.
    // Check known franchise titles and light novel keywords, but ONLY if category is still
    // general/unclassified (do NOT override an explicit manga/burmese classification).
    if (category === "general_book" || category === "other") {
      const isFranchiseLn =
        /\b(?:danmachi|(?:\w+)?monogatari|oregairu|tensura|konosuba|sword\s*art\s*online|overlord|mushoku\s*tensei|classroom\s*of\s*the\s*elite|re:?\s*zero|toaru|mahouka|no\s*game\s*no\s*life|spice\s*and\s*wolf|rascal\s*does\s*not\s*dream)\b/i.test(
          query,
        ) ||
        /\b(?:danmachi|(?:\w+)?monogatari|oregairu|tensura|konosuba|sword\s*art\s*online|overlord|mushoku\s*tensei|classroom\s*of\s*the\s*elite|re:?\s*zero|toaru|mahouka|no\s*game\s*no\s*life|spice\s*and\s*wolf|rascal\s*does\s*not\s*dream)\b/i.test(
          cleanQ,
        );

      if (isFranchiseLn) {
        category = "light_novel";
      }
    }
  }

  const isLnTarget = category === "light_novel";

  // Category-specific source routing:
  // 1. 'light_novel': Query RanobeDB + Bangumi (and AniList for series queries), fallback to Google Books
  if (category === "light_novel") {
    const lnSettled = await Promise.allSettled([
      searchRanobeDB(query, { preserveVolume: hintPreserveVolume }),
      ...(hintPreserveVolume ? [] : [searchAniList(query)]),
      searchBangumi(query, { preserveVolume: hintPreserveVolume }),
    ]);
    for (const res of lnSettled) {
      if (res.status === "fulfilled") {
        results.push(...res.value);
      }
    }
    // If primary light novel sources returned 0 results (or no usable description when searching volume synopsis)
    const hasUsableLn = hintPreserveVolume
      ? results.some((r) => r.confidence >= 0.85 && r.description && r.description.trim().length > 15)
      : results.length > 0;
    if (!hasUsableLn) {
      try {
        const gbResults = await searchGoogleBooks(query, { preserveVolume: hintPreserveVolume });
        results.push(...gbResults);
      } catch (err) {
        console.debug(`[Scraper] Google Books secondary search error:`, err);
      }
    }
  }
  // 2. 'manga': Query MangaDex + Bangumi (and AniList for series queries)
  else if (category === "manga") {
    const mangaSettled = await Promise.allSettled([
      searchMangaDex(query),
      ...(hintPreserveVolume ? [] : [searchAniList(query)]),
      searchBangumi(query, { preserveVolume: hintPreserveVolume }),
    ]);
    for (const res of mangaSettled) {
      if (res.status === "fulfilled") {
        results.push(...res.value);
      }
    }
  }
  // 3. 'general_book' or 'other': Query Google Books + OpenLibrary first
  else if (category === "general_book" || category === "other") {
    const generalSettled = await Promise.allSettled([
      searchGoogleBooks(query, { preserveVolume: hintPreserveVolume }),
      searchOpenLibrary(query, { preserveVolume: hintPreserveVolume }),
    ]);
    for (const res of generalSettled) {
      if (res.status === "fulfilled") {
        results.push(...res.value);
      }
    }
  }
  // 4. 'burmese': Skip overseas metadata searches that will 404
  else if (category === "burmese") {
    // Burmese literature skips overseas search to avoid unnecessary 404s/waterfalls.
    // Calibre local metadata & typographic cover are used.
    return results;
  }

  // 5. Fallback: run secondary search if primary returned 0 results (or if searching volume synopsis and no usable description found)
  const hasUsableFallback = hintPreserveVolume
    ? results.some((r) => r.confidence >= 0.85 && r.description && r.description.trim().length > 15)
    : results.length > 0;
  if (!hasUsableFallback) {
    if (category === "light_novel") {
      // Light novel secondary already tried Google Books; try OpenLibrary + MangaDex
      const fallbackSettled = await Promise.allSettled([
        searchOpenLibrary(query, { preserveVolume: hintPreserveVolume }),
        searchMangaDex(query, { preserveVolume: hintPreserveVolume }),
      ]);
      for (const res of fallbackSettled) {
        if (res.status === "fulfilled") {
          results.push(...res.value);
        }
      }
    } else if (category === "manga") {
      // Manga fallback: try Google Books + OpenLibrary
      const fallbackSettled = await Promise.allSettled([
        searchGoogleBooks(query, { preserveVolume: hintPreserveVolume }),
        searchOpenLibrary(query, { preserveVolume: hintPreserveVolume }),
      ]);
      for (const res of fallbackSettled) {
        if (res.status === "fulfilled") {
          results.push(...res.value);
        }
      }
    } else if (category === "general_book" || category === "other") {
      // General book fallback: try RanobeDB + AniList + Bangumi + MangaDex
      const fallbackSettled = await Promise.allSettled([
        searchRanobeDB(query, { preserveVolume: hintPreserveVolume }),
        ...(hintPreserveVolume ? [] : [searchAniList(query)]),
        searchBangumi(query, { preserveVolume: hintPreserveVolume }),
        searchMangaDex(query, { preserveVolume: hintPreserveVolume }),
      ]);
      for (const res of fallbackSettled) {
        if (res.status === "fulfilled") {
          results.push(...res.value);
        }
      }
    }
  }

  // Volume conflict guard across all candidate results
  if (targetVol !== null) {
    for (const r of results) {
      const candidateVol = r.title ? extractVolumeNumber(r.title) : null;
      if (candidateVol !== null && candidateVol !== targetVol) {
        r.confidence = 0;
      } else if (candidateVol === null && targetVol > 1) {
        r.confidence = Math.min(r.confidence, 0.7);
      }
    }
  }

  // Sort results: prioritize RanobeDB when query matches light novel patterns or has high title similarity
  results.sort((a, b) => {
    if (isLnTarget) {
      if (
        a.source === "RanobeDB" &&
        b.source !== "RanobeDB" &&
        a.confidence >= 0.7
      )
        return -1;
      if (
        b.source === "RanobeDB" &&
        a.source !== "RanobeDB" &&
        b.confidence >= 0.7
      )
        return 1;
    }
    // High similarity RanobeDB priority
    if (
      a.source === "RanobeDB" &&
      b.source !== "RanobeDB" &&
      a.confidence >= 0.85 &&
      b.confidence <= a.confidence + 0.05
    ) {
      return -1;
    }
    if (
      b.source === "RanobeDB" &&
      a.source !== "RanobeDB" &&
      b.confidence >= 0.85 &&
      a.confidence <= b.confidence + 0.05
    ) {
      return 1;
    }
    return b.confidence - a.confidence;
  });

  return results;
}

// Alias for searchUniversalMetadata matching spec naming
export const searchAllSources = searchUniversalMetadata;

export const KNOWN_COVER_DOMAINS = new Set([
  "images.ranobedb.org",
  "uploads.mangadex.org",
  "covers.openlibrary.org",
  "books.google.com",
  "books.googleusercontent.com",
  "api.bgm.tv",
  "lain.bgm.tv",
  "anilist.co",
  "s4.anilist.co",
  "media.anilist.co",
  "anilistcdn.com",
]);

export function isAllowedCoverUrl(rawUrl: string): boolean {
  try {
    const u = new URL(rawUrl);
    if (u.protocol !== "http:" && u.protocol !== "https:") return false;
    if (u.username || u.password) return false;
    const h = u.hostname.toLowerCase();
    if (
      h === "localhost" ||
      h === "127.0.0.1" ||
      h === "0.0.0.0" ||
      h.endsWith(".local") ||
      h.endsWith(".internal")
    )
      return false;
    if (
      h.startsWith("10.") ||
      h.startsWith("192.168.") ||
      /^172\.(1[6-9]|2[0-9]|3[0-1])\./.test(h)
    )
      return false;
    if (
      KNOWN_COVER_DOMAINS.has(h) ||
      h === "anilist.co" ||
      h.endsWith(".anilist.co") ||
      h === "anilistcdn.com" ||
      h.endsWith(".anilistcdn.com")
    ) {
      return true;
    }
    if (isPrivateOrInternalIp(h)) return false;
    return true;
  } catch {
    return false;
  }
}

// Auto-Enrich Calibre Book Metadata & Cover
export async function applyMetadataToCalibre(
  bookId: number,
  meta: ScrapedMetadata,
  dependencies?: {
    getBookMetadata?: (
      id: number,
    ) => {
      title?: string;
      series_index?: number;
      has_cover?: boolean | number;
      series?: string;
    } | null;
    spawnSync?: typeof spawnSync;
    fetchFn?: typeof safeFetchWithSsrf;
  },
): Promise<boolean> {
  try {
    const getMeta = dependencies?.getBookMetadata ?? getBookCalibreMetadata;
    const runSpawn = dependencies?.spawnSync ?? spawnSync;
    const doFetch = dependencies?.fetchFn ?? safeFetchWithSsrf;

    // Check the book's existing metadata (title, series_index, has_cover) in Calibre
    const existing = getMeta(bookId);
    let existingVol: number | null = null;
    let existingSeriesIndex: number | null = null;
    let existingHasCover = false;

    if (existing) {
      if (existing.title) existingVol = extractVolumeNumber(existing.title);
      if (
        existing.series &&
        existing.series_index !== undefined &&
        existing.series_index !== null &&
        !isNaN(Number(existing.series_index))
      ) {
        existingSeriesIndex = Number(existing.series_index);
        if (existingVol === null && existingSeriesIndex > 0) {
          existingVol = existingSeriesIndex;
        }
      }
      existingHasCover = Boolean(existing.has_cover);
    }

    const candidateVol = meta.title ? extractVolumeNumber(meta.title) : null;

    // Volume guards:
    // 1. Never overwrite title if the book already has a volume number or series index > 1
    //    and meta.title has a different volume or no volume.
    const hasVolumeOrMultiVolSeries =
      (existingVol !== null && existingVol > 1) ||
      (Boolean(existing?.series) && existingSeriesIndex !== null && existingSeriesIndex > 1);

    const isDifferentVolume =
      existingVol !== null &&
      candidateVol !== null &&
      candidateVol !== existingVol;

    const isMissingVolumeWhenBookHasVolume =
      hasVolumeOrMultiVolSeries && candidateVol === null;

    const skipTitleOverwrite = Boolean(
      meta.title && (isDifferentVolume || isMissingVolumeWhenBookHasVolume),
    );

    if (skipTitleOverwrite) {
      console.warn(
        `[AutoScraper] Refusing to overwrite title for book #${bookId}: ` +
          `existing has volume ${existingVol ?? existingSeriesIndex} ("${existing?.title}"), ` +
          `candidate has volume ${candidateVol ?? "none"} ("${meta.title}").`,
      );
    }

    // 2. Never overwrite an existing cover if the candidate metadata volume mismatches the book's volume.
    const volumeMismatchForCover =
      existingVol !== null &&
      ((candidateVol !== null && candidateVol !== existingVol) ||
        (existingVol > 1 && candidateVol === null));

    const skipCover = !meta.coverUrl || volumeMismatchForCover;

    if (meta.coverUrl && volumeMismatchForCover) {
      console.warn(
        `[AutoScraper] Refusing to overwrite cover for book #${bookId}: ` +
          `volume mismatch (target is Vol ${existingVol}, candidate is Vol ${candidateVol ?? "none"}${existingHasCover ? ", existing cover preserved" : ""}).`,
      );
    }

    const args = ["set_metadata", String(bookId), "--with-library", SERVER_URL];
    if (meta.title && !skipTitleOverwrite)
      args.push("--field", `title:${meta.title}`);
    if (meta.authors && meta.authors !== "Unknown")
      args.push("--field", `authors:${meta.authors}`);
    if (meta.publisher) args.push("--field", `publisher:${meta.publisher}`);
    if (meta.publishedDate)
      args.push("--field", `pubdate:${meta.publishedDate}`);
    if (meta.tags && meta.tags.length > 0)
      args.push("--field", `tags:${meta.tags.join(",")}`);
    if (meta.description && !isDifferentVolume)
      args.push("--field", `comments:${meta.description}`);

    // Download cover to temporary file if coverUrl exists, passes validation, and cover overwrite is not skipped
    let tempCoverPath = "";
    if (meta.coverUrl && !skipCover && isAllowedCoverUrl(meta.coverUrl)) {
      tempCoverPath = `/tmp/cover_${bookId}_${Date.now()}.jpg`;
      const coverUrl = meta.coverUrl;
      const imgRes = await doFetch(coverUrl, {
        signal: AbortSignal.timeout(COVER_TIMEOUT_MS),
        proxy: PROXY,
      } as any);
      if (imgRes.ok) {
        const buf = await imgRes.arrayBuffer();
        fs.writeFileSync(tempCoverPath, new Uint8Array(buf));
        args.push("--field", `cover:${tempCoverPath}`);
      }
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

    const res = runSpawn(getCalibredbPath(), args, {
      encoding: "utf8",
      env,
      timeout: 30000,
    });
    if (tempCoverPath && fs.existsSync(tempCoverPath)) {
      fs.unlinkSync(tempCoverPath);
    }

    return res.status === 0;
  } catch (e) {
    console.error(
      `[AutoScraper] Failed to apply metadata to book ${bookId}:`,
      e,
    );
    return false;
  }
}

export function safeParseJson(str: string): any {
  if (!str) return null;
  const trimmed = str.trim();
  const startBracket = trimmed.indexOf("[");
  const endBracket = trimmed.lastIndexOf("]");
  if (startBracket !== -1 && endBracket !== -1 && endBracket > startBracket) {
    try {
      return JSON.parse(trimmed.substring(startBracket, endBracket + 1));
    } catch (_err) {
      void _err;
    }
  }
  const startBrace = trimmed.indexOf("{");
  const endBrace = trimmed.lastIndexOf("}");
  if (startBrace !== -1 && endBrace !== -1 && endBrace > startBrace) {
    try {
      return JSON.parse(trimmed.substring(startBrace, endBrace + 1));
    } catch (_err) {
      void _err;
    }
  }
  try {
    return JSON.parse(trimmed);
  } catch {
    return null;
  }
}

export const MIN_CONFIDENCE_THRESHOLD = 0.85;
export const SERIES_FALLBACK_MIN_CONFIDENCE = 0.7;

export function isCommentsEmpty(text?: string | null): boolean {
  if (!text) return true;
  const stripped = text
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/gi, " ")
    .replace(/\s+/g, "")
    .trim();
  if (stripped.length === 0) return true;
  const clean = text
    .replace(/<[^>]+>/g, " ")
    .replace(/[*_#]/g, "")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
  if (
    clean === "no synopsis available for this volume." ||
    clean === "no synopsis available for this volume" ||
    clean === "no synopsis available." ||
    clean === "no synopsis available"
  ) {
    return true;
  }
  return false;
}

function escapeHtml(str: string): string {
  return str
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

export function sanitizeSynopsis(rawHtmlOrText: string): string {
  if (!rawHtmlOrText) return "";

  let s = rawHtmlOrText;

  // 1. Unwrap CDATA blocks before tag or entity stripping
  s = s.replace(/<!\[CDATA\[([\s\S]*?)\]\]>/gi, "$1");

  // 2. Strip script and style blocks
  s = s.replace(/<script\b[^<]*(?:(?!<\/script>)<[^<]*)*<\/script>/gi, "");
  s = s.replace(/<style\b[^<]*(?:(?!<\/style>)<[^<]*)*<\/style>/gi, "");
  s = s.replace(/<!--[\s\S]*?-->/g, "");

  // 3. Decode entities to reveal any encoded tags or characters
  s = decodeHtmlEntities(s);

  // Repeat CDATA and script/style stripping in case encoded blocks were revealed
  s = s.replace(/<!\[CDATA\[([\s\S]*?)\]\]>/gi, "$1");
  s = s.replace(/<script\b[^<]*(?:(?!<\/script>)<[^<]*)*<\/script>/gi, "");
  s = s.replace(/<style\b[^<]*(?:(?!<\/style>)<[^<]*)*<\/style>/gi, "");

  // 4. Strip watermarks in brackets and standalone domain watermarks
  s = s.replace(WATERMARK_BRACKET_REGEX, " ");
  s = s.replace(STANDALONE_WATERMARKS_REGEX, " ");

  // 5. Strip telegram channels, pirate URLs, and promotional links
  s = s.replace(
    /https?:\/\/(?:[a-zA-Z0-9-]+\.)*(?:t\.me|telegram\.me|z-?lib[a-z0-9.]*|libgen[a-z0-9.]*|annas?-archive[a-z0-9.]*|oceanofpdf[a-z0-9.]*|vk\.com)[^\s<>"')\]]*/gi,
    " ",
  );

  // 6. Convert line breaks and block elements to linebreaks
  s = s.replace(/<br\s*\/?>/gi, "\n");
  s = s.replace(/<\/(?:p|div|li|h[1-6]|tr|blockquote|section|article)>/gi, "\n\n");

  // 7. Strip all remaining HTML tags
  s = s.replace(/<[^>]+>/g, "");

  // 8. Split into paragraphs, clean whitespace and promotional trailing phrases
  const rawParagraphs = s.split(/\n\s*\n/);
  const cleanParas: string[] = [];

  for (const rawP of rawParagraphs) {
    let p = rawP.replace(/\s+/g, " ").trim();
    if (!p) continue;

    // Filter out lines that are purely promotional or scanlation credits
    if (
      /^(?:downloaded from|uploaded by|scanned by|converted by|visit (?:our )?telegram|join (?:our )?(?:telegram|channel)|channel:?|t\.me\/|https?:\/\/)\b/i.test(
        p,
      ) ||
      /(?:join|visit|follow|subscribe to)\s+(?:our\s+)?(?:telegram|discord|channel|group|website)\b/i.test(
        p,
      ) ||
      /^(?:more books on|free books at|provided by)\b/i.test(p) ||
      /^[-*_=\s]{3,}$/.test(p) ||
      /^(?:\*\*Note:\*\*|Note:?)\s*(?:because a takedown|due to a takedown|this title has been licensed|because of a dmca)\b/i.test(
        p,
      )
    ) {
      continue;
    }

    // Strip trailing prepositions/colons left over from stripped URLs (e.g. "Visit: ")
    p = p
      .replace(
        /\s*(?:at|with|from|visit|join|link:?|channel:?)\s*[:.]?\s*$/i,
        "",
      )
      .trim();

    if (p.length > 0) {
      cleanParas.push(escapeHtml(p));
    }
  }

  if (cleanParas.length === 0) return "";
  return cleanParas.map((p) => `<p>${p}</p>`).join("\n");
}

export function cleanVolumeQuery(title: string): string {
  if (!title) return "";
  let s = title;
  s = s.replace(/_/g, " ");
  s = s.replace(WATERMARK_BRACKET_REGEX, " ");
  s = s.replace(URL_REGEX, " ");
  s = s.replace(TELEGRAM_LINK_REGEX, " ");
  s = s.replace(VK_LINK_REGEX, " ");
  s = s.replace(MENTION_REGEX, " ");
  s = s.replace(WWW_REGEX, " ");
  s = s.replace(STANDALONE_WATERMARKS_REGEX, " ");
  s = s.replace(FORMAT_EXT_REGEX, " ");
  s = s.replace(/\[\s*\]|\(\s*\)/g, " ");
  // Collapse whitespace
  s = s.replace(/\s+/g, " ").trim();
  s = s.replace(/^[-–—:_.\s]+|[-–—:_.\s]+$/g, "").trim();
  return s;
}

export function extractDescriptionFromOpfXml(opfXml: string): string | null {
  if (!opfXml) return null;

  const plainLen = (s: string) => s.replace(/<[^>]+>/g, "").trim().length;

  // 1. Check <dc:description>...</dc:description>
  const dcMatch = opfXml.match(/<dc:description[^>]*>([\s\S]*?)<\/dc:description>/i);
  if (dcMatch && dcMatch[1]) {
    const s = sanitizeSynopsis(dcMatch[1]);
    if (s && plainLen(s) >= 15) return s;
  }

  // 2. Check <meta property="schema:description">...</meta>
  const metaElemMatch = opfXml.match(
    /<meta[^>]+property=["'](?:schema:)?description["'][^>]*>([\s\S]*?)<\/meta>/i,
  );
  if (metaElemMatch && metaElemMatch[1]) {
    const s = sanitizeSynopsis(metaElemMatch[1]);
    if (s && plainLen(s) >= 15) return s;
  }

  // 3. Check <meta ... content="..." ...> with property or name description
  const metaContentMatch = opfXml.match(
    /<meta\s+[^>]*?(?:property|name)=["'](?:schema:)?description["'][^>]*?content=["']([^"']+)["'][^>]*>/i,
  );
  if (metaContentMatch && metaContentMatch[1]) {
    const s = sanitizeSynopsis(metaContentMatch[1]);
    if (s && plainLen(s) >= 15) return s;
  }

  // 4. Reverse attribute ordering: <meta content="..." property="schema:description">
  const metaContentReverseMatch = opfXml.match(
    /<meta\s+[^>]*?content=["']([^"']+)["'][^>]*?(?:property|name)=["'](?:schema:)?description["'][^>]*>/i,
  );
  if (metaContentReverseMatch && metaContentReverseMatch[1]) {
    const s = sanitizeSynopsis(metaContentReverseMatch[1]);
    if (s && plainLen(s) >= 15) return s;
  }

  return null;
}

export function extractEpubDescription(filePath: string): string | null {
  try {
    if (!fs.existsSync(filePath)) return null;
    const stat = fs.statSync(filePath);
    if (stat.size <= 0 || stat.size >= 256 * 1024 * 1024) return null;

    const execOpts = {
      encoding: "utf8" as const,
      timeout: 15000,
      maxBuffer: 16 * 1024 * 1024,
    };

    // 1. Locate OPF path via META-INF/container.xml
    let containerXml = "";
    const bsdtar = spawnSync(
      getBsdtarPath(),
      ["-xOf", filePath, "META-INF/container.xml"],
      execOpts,
    );
    if (bsdtar.status === 0 && bsdtar.stdout) {
      containerXml = bsdtar.stdout;
    } else {
      const unzip = spawnSync(
        getUnzipPath(),
        ["-p", filePath, "META-INF/container.xml"],
        execOpts,
      );
      if ((unzip.status === 0 || unzip.status === 1) && unzip.stdout) {
        containerXml = unzip.stdout;
      }
    }

    let opfPath = "content.opf";
    if (containerXml) {
      const match = containerXml.match(/full-path=["']([^"']+)["']/i);
      if (match && match[1]) {
        opfPath = match[1].trim();
      }
    }

    // 2. Read OPF XML content
    let opfXml = "";
    const bsdtarOpf = spawnSync(
      getBsdtarPath(),
      ["-xOf", filePath, opfPath],
      execOpts,
    );
    if (bsdtarOpf.status === 0 && bsdtarOpf.stdout) {
      opfXml = bsdtarOpf.stdout;
    } else {
      const unzipOpf = spawnSync(
        getUnzipPath(),
        ["-p", filePath, opfPath],
        execOpts,
      );
      if ((unzipOpf.status === 0 || unzipOpf.status === 1) && unzipOpf.stdout) {
        opfXml = unzipOpf.stdout;
      }
    }

    if (!opfXml && opfPath !== "content.opf") {
      const alt = spawnSync(
        getBsdtarPath(),
        ["-xOf", filePath, "content.opf"],
        execOpts,
      );
      if (alt.status === 0 && alt.stdout) {
        opfXml = alt.stdout;
      } else {
        const altUnzip = spawnSync(
          getUnzipPath(),
          ["-p", filePath, "content.opf"],
          execOpts,
        );
        if (
          (altUnzip.status === 0 || altUnzip.status === 1) &&
          altUnzip.stdout
        ) {
          opfXml = altUnzip.stdout;
        }
      }
    }
    if (!opfXml && opfPath !== "OEBPS/content.opf") {
      const alt2 = spawnSync(
        getBsdtarPath(),
        ["-xOf", filePath, "OEBPS/content.opf"],
        execOpts,
      );
      if (alt2.status === 0 && alt2.stdout) {
        opfXml = alt2.stdout;
      } else {
        const alt2Unzip = spawnSync(
          getUnzipPath(),
          ["-p", filePath, "OEBPS/content.opf"],
          execOpts,
        );
        if (
          (alt2Unzip.status === 0 || alt2Unzip.status === 1) &&
          alt2Unzip.stdout
        ) {
          opfXml = alt2Unzip.stdout;
        }
      }
    }

    if (!opfXml) return null;

    return extractDescriptionFromOpfXml(opfXml);
  } catch {
    return null;
  }
}

export async function fetchOnlineSynopsis(
  book: {
    id?: number;
    title: string;
    author?: string;
    series?: string;
    series_index?: number;
    tags?: string;
    data_name?: string;
    isbn?: string;
    has_cover?: number;
  },
  options: {
    seriesCache?: Map<string, { description: string; coverUrl?: string; source?: string }>;
  } = {},
): Promise<{ description?: string; coverUrl?: string; source?: string } | null> {
  // Fast path: Burmese literature skips overseas search to avoid unnecessary 404s and rate-limit burn
  if (containsBurmese(book.title)) {
    return null;
  }

  const filename = book.data_name ? `${book.data_name}.epub` : "";
  const tags = book.tags ? book.tags.split(",").map((t) => t.trim()) : [];

  // Determine source category
  const category: BookSourceCategory = await classifyBookSourceCategory(
    book.title,
    book.author,
    filename,
    tags,
  );

  if (category === "burmese") {
    return null;
  }

  // 1. ISBN Exact Match path for general books / other
  if (book.isbn) {
    const isbnQ = `isbn:${book.isbn.trim()}`;
    const isbnSettled = await Promise.allSettled([
      searchGoogleBooks(isbnQ),
      searchOpenLibrary(isbnQ),
    ]);
    for (const res of isbnSettled) {
      if (res.status === "fulfilled") {
        for (const hit of res.value) {
          if (hit.description && hit.confidence >= MIN_CONFIDENCE_THRESHOLD) {
            const clean = sanitizeSynopsis(hit.description);
            const plainLen = clean.replace(/<[^>]+>/g, "").trim().length;
            if (plainLen >= 15) {
              return {
                description: clean,
                coverUrl: hit.coverUrl,
                source: hit.source,
              };
            }
          }
        }
      }
    }
  }

  // 2. Volume-Specific Online Discovery (Step 2: Prioritize volume-specific lookups)
  const volTitle = cleanVolumeQuery(book.title);
  const cleanAuthor =
    book.author && book.author !== "Unknown" ? cleanQuery(book.author) : "";
  const queriesToSearch: string[] = [];

  if (category === "general_book" && cleanAuthor && volTitle) {
    queriesToSearch.push(`${volTitle} ${cleanAuthor}`);
  }
  if (volTitle) {
    queriesToSearch.push(volTitle);
  }
  if (book.series && book.series_index !== undefined) {
    const seriesVol = `${cleanString(book.series)}, Vol. ${book.series_index}`;
    if (seriesVol !== volTitle && !queriesToSearch.includes(seriesVol)) {
      queriesToSearch.push(seriesVol);
    }
  }

  const searchResults: Array<{
    title: string;
    description?: string;
    coverUrl?: string;
    source: string;
    confidence: number;
  }> = [];

  for (const q of queriesToSearch) {
    try {
      const hits = await searchUniversalMetadata(q, {
        author: book.author,
        filename,
        tags,
        category,
        isLightNovel: category === "light_novel",
        isManga: category === "manga",
        preserveVolume: true,
      });
      searchResults.push(...hits);
      if (
        searchResults.some(
          (h) => h.confidence >= MIN_CONFIDENCE_THRESHOLD && h.description && h.source !== "AniList",
        )
      ) {
        break;
      }
    } catch {
      // Continue to next query candidate
    }
  }

  // Filter hits that meet the confidence floor (>= 0.85) and have a valid description.
  // In Step 2, hits must NOT be AniList series blurbs (AniList is strictly reserved for Step 3 series fallback).
  const validHits = searchResults
    .filter(
      (r) =>
        r.confidence >= MIN_CONFIDENCE_THRESHOLD &&
        r.description &&
        r.description.trim().length > 15 &&
        r.source !== "AniList",
    )
    .sort((a, b) => b.confidence - a.confidence);

  for (const hit of validHits) {
    const clean = sanitizeSynopsis(hit.description || "");
    const plainLen = clean.replace(/<[^>]+>/g, "").trim().length;
    if (plainLen >= 15) {
      // Note: Do NOT cache volume-specific synopses in seriesCache!
      // Volume synopses belong strictly to this volume.
      return {
        description: clean,
        coverUrl: hit.coverUrl,
        source: hit.source,
      };
    }
  }

  // 3. Series Synopsis Fallback via AniList (Step 3: Only as a last resort if steps 1 and 2 return no description)
  const seriesLookupTarget = book.series?.trim() || cleanSeriesTitle(book.title);
  const derivedSeries = cleanSeriesTitle(seriesLookupTarget);
  const seriesKey = derivedSeries ? derivedSeries.toLowerCase() : "";

  // Check series cache as fallback only (never bypasses volume search above)
  if (seriesKey && options.seriesCache?.has(seriesKey)) {
    const cached = options.seriesCache.get(seriesKey)!;
    return {
      description: cached.description,
      coverUrl: cached.coverUrl,
      source: cached.source || "AniList",
    };
  }

  if (seriesLookupTarget) {
    try {
      const aniQuery = cleanSeriesTitle(seriesLookupTarget);
      if (aniQuery) {
        const aniHits = await searchAniList(aniQuery);
        for (const hit of aniHits) {
          if (hit.description && hit.confidence >= SERIES_FALLBACK_MIN_CONFIDENCE) {
            const clean = sanitizeSynopsis(hit.description);
            const plainLen = clean.replace(/<[^>]+>/g, "").trim().length;
            if (plainLen >= 15) {
              const res = {
                description: clean,
                coverUrl: hit.coverUrl,
                source: hit.source || "AniList",
              };
              if (seriesKey && options.seriesCache) {
                options.seriesCache.set(seriesKey, res);
              }
              return res;
            }
          }
        }
      }
    } catch (err: any) {
      console.debug(
        `[EnrichSynopsis:AniList] Series query "${seriesLookupTarget}" failed:`,
        err?.message || err,
      );
    }
  }

  return null;
}

export async function autoEnrichBookSynopsis(
  bookId: number,
  options?: {
    filePath?: string;
    title?: string;
    author?: string;
    series?: string;
    series_index?: number;
    tags?: string[];
    filename?: string;
    withLibrary?: string;
    calibredbRunner?: (args: string[]) => { status: number | null; stdout?: string; stderr?: string };
  },
): Promise<{ enriched: boolean; source?: string; synopsis?: string }> {
  const withLibrary = options?.withLibrary || SERVER_URL;
  const runner = options?.calibredbRunner || ((args: string[]) => {
    const env = { ...process.env };
    delete env.HTTP_PROXY;
    delete env.http_proxy;
    delete env.HTTPS_PROXY;
    delete env.https_proxy;
    delete env.ALL_PROXY;
    delete env.all_proxy;
    env.PATH = "/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:" + (env.PATH || "");
    return spawnSync(getCalibredbPath(), args, { encoding: "utf8", env, timeout: 30000 });
  });

  // 1. Check if comments in Calibre is already non-empty
  let currentTitle = options?.title;
  let currentAuthor = options?.author;
  let currentSeries = options?.series;
  let currentSeriesIndex = options?.series_index;

  try {
    const listRes = runner([
      "list",
      "--with-library",
      withLibrary,
      "--search",
      `id:${bookId}`,
      "--fields",
      "id,title,authors,comments,series,series_index",
      "--for-machine",
    ]);

    // A runner whose list exits non-zero must return without writing
    if (listRes.status !== 0) {
      return { enriched: false };
    }

    const stdout = listRes.stdout || "";
    const parsed = safeParseJson(stdout);

    if (Array.isArray(parsed)) {
      if (parsed[0]) {
        const book = parsed[0];
        if (!isCommentsEmpty(book.comments)) {
          return { enriched: false, synopsis: book.comments };
        }
        if (!currentTitle && book.title) currentTitle = book.title;
        if (!currentAuthor && book.authors) currentAuthor = book.authors;
        if (!currentSeries && book.series) currentSeries = book.series;
        if (currentSeriesIndex === undefined && book.series_index !== undefined) {
          currentSeriesIndex = book.series_index;
        }
      }
    } else {
      // Non-JSON stdout: e.g. human table output or unexpected formatting.
      // A runner whose list stdout is a non-JSON table containing a real synopsis must not call set_metadata.
      // If parsing fails, we cannot safely know if comments were empty, so return without writing.
      return { enriched: false };
    }
  } catch (err) {
    // If list invocation throws an error, return without writing to prevent overwriting
    console.debug(`[autoEnrichBookSynopsis] Failed to inspect existing metadata for book ${bookId}:`, err);
    return { enriched: false };
  }

  // Tier 1: Local EPUB Inspection
  if (options?.filePath && fs.existsSync(options.filePath)) {
    const epubSynopsis = extractEpubDescription(options.filePath);
    if (epubSynopsis && !isCommentsEmpty(epubSynopsis)) {
      const setRes = runner([
        "set_metadata",
        String(bookId),
        "--with-library",
        withLibrary,
        "--field",
        `comments:${epubSynopsis}`,
      ]);
      if (setRes.status === 0) {
        return { enriched: true, source: "EPUB", synopsis: epubSynopsis };
      }
    }
  }

  // Tier 2 & 3: Online lookup (volume-specific query with AniList series fallback)
  if (currentTitle) {
    const onlineRes = await fetchOnlineSynopsis({
      id: bookId,
      title: currentTitle,
      author: currentAuthor,
      series: currentSeries,
      series_index: currentSeriesIndex,
      tags: (options?.tags || []).join(","),
      data_name: options?.filename ? path.basename(options.filename, path.extname(options.filename)) : undefined,
    });

    if (onlineRes?.description && !isCommentsEmpty(onlineRes.description)) {
      const setRes = runner([
        "set_metadata",
        String(bookId),
        "--with-library",
        withLibrary,
        "--field",
        `comments:${onlineRes.description}`,
      ]);
      if (setRes.status === 0) {
        return {
          enriched: true,
          source: onlineRes.source || "Online",
          synopsis: onlineRes.description,
        };
      }
    }
  }

  return { enriched: false };
}

