import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { safeFetchWithSsrf, isPrivateOrInternalIp } from "./security";
import { isJunkAuthorExtended } from "./jev-shelf";

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

/**
 * Clean search query for metadata APIs:
 * Applies cleanString, then strips all remaining brackets, chapter/vol numbers, and normalizes separators.
 */
export function cleanQuery(str: string): string {
  if (!str) return "";
  let s = cleanString(str);
  // Strip any remaining brackets and parentheses
  s = s.replace(/\[.*?\]/g, " ");
  s = s.replace(/\(.*?\)/g, " ");
  // Strip chapter / volume prefixes so search hits the canonical work
  s = s.replace(
    /\b(c[0-9]+|ch\.?\s*[0-9]+|chapter\s*[0-9]+|vol\.?\s*[0-9]+|volume\s*[0-9]+|book\s*[0-9]+|part\s*[0-9]+)\b/gi,
    " ",
  );
  // Normalize punctuation separators to spaces
  s = s.replace(/[-_–—:]+/g, " ");
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
      ((normES.startsWith(normIS) || normIS.startsWith(normES)) &&
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
    if (!hasKnownAuthors || authorSim >= 0.6) {
      if (titleSim >= 0.8) return true;
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
): Promise<ScrapedMetadata[]> {
  const results: ScrapedMetadata[] = [];
  const cleanQ = cleanQuery(query);
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
export async function searchBangumi(query: string): Promise<ScrapedMetadata[]> {
  const results: ScrapedMetadata[] = [];
  const cleanQ = cleanQuery(query);
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

          const sim = Math.max(
            stringSimilarity(cleanQ, item.name || ""),
            stringSimilarity(cleanQ, item.name_cn || ""),
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
): Promise<ScrapedMetadata[]> {
  const results: ScrapedMetadata[] = [];
  const cleanQ = cleanQuery(query);
  if (!cleanQ) return results;

  try {
    const url = `https://www.googleapis.com/books/v1/volumes?q=${encodeURIComponent(cleanQ)}&maxResults=3`;
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

          const sim = stringSimilarity(cleanQ, title);
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
): Promise<ScrapedMetadata[]> {
  const results: ScrapedMetadata[] = [];
  const cleanQ = cleanQuery(query);
  if (!cleanQ) return results;

  try {
    const url = `https://openlibrary.org/search.json?q=${encodeURIComponent(cleanQ)}&limit=3`;
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

          const sim = stringSimilarity(cleanQ, title);
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
  return /\b(?:light[\s_-]?novel|ln|web[\s_-]?novel|wn|ranobe|bunko|isekai|reincarnat(?:ed|ion)?|danmachi|(?:\w+)?monogatari|oregairu|tensura|konosuba|sword\s*art\s*online|overlord|mushoku\s*tensei|classroom\s*of\s*the\s*elite|re:?zero|toaru|mahouka|no\s*game\s*no\s*life|spice\s*and\s*wolf|rascal\s*does\s*not\s*dream)\b/i.test(
    query,
  );
}

export function parseRanobeBook(
  book: any,
  query: string,
  fallbackHit?: any,
): ScrapedMetadata {
  const cleanQ = cleanQuery(query);
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

  const sim = Math.max(
    stringSimilarity(cleanQ, title),
    stringSimilarity(cleanQ, book.title_orig || fallbackHit?.title_orig || ""),
    stringSimilarity(cleanQ, book.romaji || fallbackHit?.romaji || ""),
    stringSimilarity(
      cleanQ,
      book.series?.title || fallbackHit?.series?.title || "",
    ),
  );

  return {
    title,
    authors: authors || "Unknown",
    publisher: book.series?.title || fallbackHit?.series?.title || "",
    publishedDate: formatRanobeDate(
      book.c_release_date ?? fallbackHit?.c_release_date,
    ),
    description: book.description || book.description_ja || "",
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
  },
): Promise<ScrapedMetadata[]> {
  const results: ScrapedMetadata[] = [];
  const cleanQ = cleanQuery(query);
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
            return parseRanobeBook(book, cleanQ, hit);
          }
        } catch {
          return parseRanobeBook(hit, cleanQ);
        }
        return parseRanobeBook(hit, cleanQ);
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

// Unified Search with Multi-Source Fallback
export async function searchUniversalMetadata(
  query: string,
  hint?:
    | boolean
    | string
    | { isManga?: boolean; isLightNovel?: boolean; isLn?: boolean },
): Promise<ScrapedMetadata[]> {
  const results: ScrapedMetadata[] = [];
  const cleanQ = cleanQuery(query);
  if (!cleanQ) return results;

  let hintManga = false;
  let hintLn = false;

  if (typeof hint === "boolean") {
    hintManga = hint;
  } else if (typeof hint === "string") {
    hintManga = /manga|comic/i.test(hint);
    hintLn = /light[\s_-]?novel|ln|ranobe|bunko/i.test(hint);
  } else if (hint && typeof hint === "object") {
    hintManga = !!hint.isManga;
    hintLn = !!(hint.isLightNovel || hint.isLn);
  }

  const isLnTarget = hintLn || isLightNovelQuery(cleanQ);
  const isMangaTarget =
    !isLnTarget &&
    (hintManga ||
      /manga|comic|chapter|ch\.|c0|one piece|naruto|bleach|berserk/i.test(
        cleanQ,
      ));

  if (isLnTarget) {
    const lnSettled = await Promise.allSettled([
      searchRanobeDB(query),
      searchBangumi(query),
      searchGoogleBooks(query),
    ]);
    for (const res of lnSettled) {
      if (res.status === "fulfilled") {
        results.push(...res.value);
      }
    }
  } else if (isMangaTarget) {
    const mangaSettled = await Promise.allSettled([
      searchMangaDex(query),
      searchBangumi(query),
    ]);
    for (const res of mangaSettled) {
      if (res.status === "fulfilled") {
        results.push(...res.value);
      }
    }
  }

  if (results.length === 0) {
    const bookSettled = await Promise.allSettled([
      searchRanobeDB(query),
      searchGoogleBooks(query),
      searchOpenLibrary(query),
    ]);
    for (const res of bookSettled) {
      if (res.status === "fulfilled") {
        results.push(...res.value);
      }
    }
  }

  // If still empty and was not initially marked manga or LN, try manga scrapers as last resort
  if (results.length === 0 && !isMangaTarget && !isLnTarget) {
    const fallbackSettled = await Promise.allSettled([
      searchMangaDex(query),
      searchBangumi(query),
    ]);
    for (const res of fallbackSettled) {
      if (res.status === "fulfilled") {
        results.push(...res.value);
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

export const KNOWN_COVER_DOMAINS = new Set([
  "images.ranobedb.org",
  "uploads.mangadex.org",
  "covers.openlibrary.org",
  "books.google.com",
  "books.googleusercontent.com",
  "api.bgm.tv",
  "lain.bgm.tv",
]);

export function isAllowedCoverUrl(rawUrl: string): boolean {
  try {
    const u = new URL(rawUrl);
    if (u.protocol !== "http:" && u.protocol !== "https:") return false;
    if (u.username || u.password) return false;
    const h = u.hostname.toLowerCase();
    if (KNOWN_COVER_DOMAINS.has(h)) return true;
    if (
      h === "localhost" ||
      h === "127.0.0.1" ||
      h === "0.0.0.0" ||
      h.endsWith(".local") ||
      h.endsWith(".internal")
    )
      return false;
    if (isPrivateOrInternalIp(h)) return false;
    if (
      h.startsWith("10.") ||
      h.startsWith("192.168.") ||
      /^172\.(1[6-9]|2[0-9]|3[0-1])\./.test(h)
    )
      return false;
    return true;
  } catch {
    return false;
  }
}

// Auto-Enrich Calibre Book Metadata & Cover
export async function applyMetadataToCalibre(
  bookId: number,
  meta: ScrapedMetadata,
): Promise<boolean> {
  try {
    const args = ["set_metadata", String(bookId), "--with-library", SERVER_URL];
    if (meta.title) args.push("--field", `title:${meta.title}`);
    if (meta.authors && meta.authors !== "Unknown")
      args.push("--field", `authors:${meta.authors}`);
    if (meta.publisher) args.push("--field", `publisher:${meta.publisher}`);
    if (meta.publishedDate)
      args.push("--field", `pubdate:${meta.publishedDate}`);
    if (meta.tags && meta.tags.length > 0)
      args.push("--field", `tags:${meta.tags.join(",")}`);
    if (meta.description) args.push("--field", `comments:${meta.description}`);

    // Download cover to temporary file if coverUrl exists and passes URL validation
    let tempCoverPath = "";
    if (meta.coverUrl && isAllowedCoverUrl(meta.coverUrl)) {
      tempCoverPath = `/tmp/cover_${bookId}_${Date.now()}.jpg`;
      const coverUrl = meta.coverUrl;
      const imgRes = await safeFetchWithSsrf(coverUrl, {
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

    const res = spawnSync(getCalibredbPath(), args, {
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
