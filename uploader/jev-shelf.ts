import path from "node:path";
import fs from "node:fs";
import os from "node:os";
import { safeFetchWithSsrf, cleanString } from "./security";

function decodeEntitiesLocal(str: string): string {
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

// ============================================================================
// Types
// ============================================================================

export interface JevSystemOneChoiceResponse {
  choice: string;
  confidence: number;
}

export type JunkTriageVerdict = "real_book" | "test_artifact" | "truncated_download";
export type SeriesTriageVerdict = "series_volume" | "subtitle_same_book" | "unrelated";
export type AuthorTriageVerdict = "keep" | "mark_unknown";
export type LanguageTriageVerdict = "mya" | "eng" | "other" | "my" | "en";
export type BookSourceCategory = "light_novel" | "manga" | "general_book" | "burmese" | "other";

export const STANDARDIZED_CATEGORIES = [
  "Light Novel",
  "Manga",
  "Fiction",
  "Non-Fiction",
  "Technology",
  "Business",
  "History",
  "Philosophy",
  "Burmese Literature",
] as const;

export type StandardCategory = (typeof STANDARDIZED_CATEGORIES)[number];

export interface BookMetadataInput {
  id?: number;
  title: string;
  author?: string;
  comments?: string;
  series?: string;
  filename?: string;
  tags?: string[];
  currentLanguages?: string[];
  embeddedLanguage?: string;
}

export interface BookClassificationResult {
  language: "mya" | "eng" | "other";
  tags: string[];
  addedTags: string[];
  removedTags: string[];
  category?: StandardCategory;
  isBurmese: boolean;
  needsLanguageUpdate: boolean;
  needsTagsUpdate: boolean;
}

export interface JunkGateResult {
  quarantined: boolean;
  reason?: string;
  action?: "deterministic_quarantine" | "jev_quarantine" | "pass";
  verdict?: JunkTriageVerdict;
  confidence?: number;
}

export interface JevClientOptions {
  apiKey?: string;
  timeoutMs?: number;
}

// ============================================================================
// Jev System-1 Client Core Helper
// ============================================================================

/**
 * Common System-1 API caller for single choice questions.
 * Endpoint: https://api.typesafe.ai/v1/systemone
 * Reuses safeFetchWithSsrf, redirect: 'error', 3000ms default timeout.
 */
export async function callJevSystemOneChoice(
  stateText: string,
  questionKey: string,
  instructions: string,
  criteria: Record<string, string>,
  options: JevClientOptions = {},
): Promise<JevSystemOneChoiceResponse | null> {
  const apiKey = (
    options.apiKey ||
    process.env.JEV_API_KEY ||
    process.env.TYPESAFE_API_KEY ||
    ""
  ).trim();

  if (!apiKey) return null;

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
          [questionKey]: {
            type: "choice",
            instructions,
            criteria,
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
    const ans = json?.answers?.[questionKey];
    if (ans && ans.choice) {
      return {
        choice: ans.choice,
        confidence: typeof ans.confidence === "number" && !Number.isNaN(ans.confidence) ? ans.confidence : 0,
      };
    }
  } catch {
    clearTimeout(timer);
  }

  return null;
}

// ============================================================================
// Quarantine Directory Resolver
// ============================================================================

export function getQuarantineDir(): string {
  if (process.env.BOOKS_QUARANTINE_DIR) return process.env.BOOKS_QUARANTINE_DIR;
  const home = process.env.HOME || os.homedir();
  const dir = path.join(home, "Books_Quarantine");
  try {
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
    return dir;
  } catch {
    const fallback = path.join(os.tmpdir(), "Books_Quarantine");
    if (!fs.existsSync(fallback)) {
      fs.mkdirSync(fallback, { recursive: true });
    }
    return fallback;
  }
}

/**
 * Move a file safely to the quarantine directory outside calibre-autoimport.
 * Returns the destination quarantined path.
 */
function ensureDirExists(dir: string) {
  try {
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
  } catch (_e) {
    void _e;
  }
}

export function moveToQuarantine(srcPath: string, fileName?: string): string {
  const qDir = path.resolve(getQuarantineDir());
  ensureDirExists(qDir);
  const rawTargetName = (fileName || path.basename(srcPath)).trim();

  // Strip path traversal, slashes, nulls, dots
  let safeName = path.basename(rawTargetName).replace(/[/\\]/g, "_").trim();
  if (!safeName || safeName === "." || safeName === ".." || /^\.+$/.test(safeName)) {
    safeName = "quarantined_file.epub";
  }

  let destPath = path.resolve(qDir, safeName);
  // Guarantee destination stays strictly inside quarantine directory
  if (!destPath.startsWith(qDir + path.sep)) {
    destPath = path.join(qDir, "quarantined_file.epub");
  }

  try {
    fs.renameSync(srcPath, destPath);
  } catch {
    fs.copyFileSync(srcPath, destPath);
    try {
      fs.unlinkSync(srcPath);
    } catch (_unlinkErr) {
      void _unlinkErr;
    }
  }
  return destPath;
}

// ============================================================================
// 1. Junk Ingest Gate
// ============================================================================

/**
 * Deterministic quarantine rule:
 * Matches titles or filenames matching:
 * - 'truncated' + long number + short id (e.g. truncated_1712345678901_a1b2 or truncated 1712345678901 abcd)
 * - 'Healed Book' + timestamp (e.g. "Healed Book 1712345678901" or "Healed_Book_1712345678")
 * - 'truncated_<digits>_<id>.epub'
 */
export function isDeterministicJunk(title: string, filename: string = ""): boolean {
  const candidates = [title, filename ? path.basename(filename) : ""].filter(Boolean);

  const patterns = [
    /truncated[_\s-]+\d{8,}[_\s-]+[a-z0-9]{2,10}(?:\.epub)?$/i,
    /healed[_\s-]+book[_\s-]+\d{8,}/i,
    /^truncated_\d+_[a-z0-9]+\.epub$/i,
    /^(?:Making sure you(?:'re|’re|\s+are)\s+not\s+a\s+bot!?|Attention Required!\s*\|\s*Cloudflare|Just a moment(?:\.\.\.|…)|Anubis Challenge)$/i,
    /\banubis(?:_challenge|\s+challenge)\b/i,
  ];

  for (const str of candidates) {
    const trimmed = decodeEntitiesLocal(str).trim();
    for (const pat of patterns) {
      if (pat.test(trimmed)) {
        return true;
      }
    }
  }

  return false;
}

/**
 * Check if title or filename looks suspicious enough to invoke Jev triage:
 * - mostly digits (e.g. "198402913840" or >60% digits with length >= 6)
 * - test/sample tokens (e.g. "test book", "test_artifact", "sample_book", "sample upload")
 * - unknown author + timestamp token in title/filename (e.g. author Unknown/empty and title has 10+ digit timestamp)
 */
export function isSuspiciousTitle(
  title: string,
  filename: string = "",
  author: string = "",
): boolean {
  const combined = `${title} ${filename}`.trim();
  if (!combined) return false;

  const pureTitle = title.trim();
  const digitMatches = pureTitle.match(/\d/g);
  const digitCount = digitMatches ? digitMatches.length : 0;
  const nonSpaceLen = pureTitle.replace(/\s/g, "").length;

  // Mostly digits (>60% digits and >= 6 chars, or entirely digits >= 5 chars)
  if (nonSpaceLen >= 5 && /^\d+$/.test(pureTitle)) return true;
  if (nonSpaceLen >= 6 && digitCount / nonSpaceLen >= 0.6) return true;

  // Test / sample tokens
  if (/\b(test(?:_|\s-|\s)?(?:artifact|book|file|upload|run|dummy)|sample(?:_|\s-|\s)?(?:book|file|artifact|download|upload))\b/i.test(combined)) {
    return true;
  }

  // Unknown author + timestamp token (>= 9 digits)
  const normAuthor = (author || "").trim().toLowerCase();
  const isUnknown = !normAuthor || normAuthor === "unknown" || normAuthor === "anonymous";
  if (isUnknown && /\b\d{9,}\b/.test(combined)) {
    return true;
  }

  return false;
}

/**
 * Call Jev to triage suspicious book ingest candidate.
 * Choices: real_book, test_artifact, truncated_download.
 */
export async function triageJunkWithJev(
  title: string,
  filename: string = "",
  author: string = "",
  options: JevClientOptions = {},
): Promise<{ verdict: JunkTriageVerdict; confidence: number } | null> {
  const stateText = `Inspect the following ingested book title, filename, and author to decide if it is a real book or an invalid artifact:

- Title: ${title || "(empty)"}
- Filename: ${filename || "(empty)"}
- Author: ${author || "Unknown"}

Task: Decide whether this item is a legitimate real published book / web article, a test artifact (throwaway test run, dummy file, synthetic test), or a broken/truncated download remnant.`;

  const res = await callJevSystemOneChoice(
    stateText,
    "junk_verdict",
    "Classify whether this item is a real book, test artifact, or truncated download.",
    {
      real_book: "A legitimate published book, novel, light novel, nonfiction work, or real web reading article.",
      test_artifact: "A dummy test file, synthetic test upload, automated test runner artifact, or placeholder.",
      truncated_download: "A truncated, damaged, interrupted, or temporary downloader artifact containing timestamp tokens or incomplete hashes.",
    },
    options,
  );

  if (!res) return null;

  const validVerdicts: JunkTriageVerdict[] = ["real_book", "test_artifact", "truncated_download"];
  if (validVerdicts.includes(res.choice as JunkTriageVerdict)) {
    return {
      verdict: res.choice as JunkTriageVerdict,
      confidence: res.confidence,
    };
  }

  return null;
}

/**
 * Evaluates whether an incoming file/title should be quarantined.
 * 1. Deterministic check first (no model call).
 * 2. If deterministic misses and title looks suspicious, call Jev.
 * 3. Quarantine on test_artifact or truncated_download if confidence >= 0.7.
 * 4. Fails open on errors / missing keys / confidence < 0.7.
 */
export async function evaluateJunkGate(
  title: string,
  filename: string = "",
  author: string = "",
  options: JevClientOptions = {},
): Promise<JunkGateResult> {
  if (isDeterministicJunk(title, filename)) {
    return {
      quarantined: true,
      reason: "Matched deterministic quarantine pattern (truncated download or healed book artifact)",
      action: "deterministic_quarantine",
    };
  }

  if (isSuspiciousTitle(title, filename, author)) {
    const jevRes = await triageJunkWithJev(title, filename, author, options);
    if (jevRes) {
      if (
        (jevRes.verdict === "test_artifact" || jevRes.verdict === "truncated_download") &&
        jevRes.confidence >= 0.7
      ) {
        return {
          quarantined: true,
          reason: `Jev classified as ${jevRes.verdict} with confidence ${jevRes.confidence.toFixed(2)}`,
          action: "jev_quarantine",
          verdict: jevRes.verdict,
          confidence: jevRes.confidence,
        };
      }
      return {
        quarantined: false,
        action: "pass",
        verdict: jevRes.verdict,
        confidence: jevRes.confidence,
      };
    }
  }

  return {
    quarantined: false,
    action: "pass",
  };
}

// ============================================================================
// 2. Series & Volume Detection
// ============================================================================

const ROMAN_NUMERAL_MAP: Record<string, number> = {
  i: 1,
  ii: 2,
  iii: 3,
  iv: 4,
  v: 5,
  vi: 6,
  vii: 7,
  viii: 8,
  ix: 9,
  x: 10,
  xi: 11,
  xii: 12,
  xiii: 13,
  xiv: 14,
  xv: 15,
  xvi: 16,
  xvii: 17,
  xviii: 18,
  xix: 19,
  xx: 20,
};

const WRITTEN_NUMBER_MAP: Record<string, number> = {
  one: 1,
  two: 2,
  three: 3,
  four: 4,
  five: 5,
  six: 6,
  seven: 7,
  eight: 8,
  nine: 9,
  ten: 10,
  eleven: 11,
  twelve: 12,
};

/**
 * Deterministic detection of roman numerals (II, III, IV...) and written numbers (book two, part three).
 */
export function extractSeriesDeterministicExtended(
  title: string,
  filename: string = "",
): { series: string; volume: number } | null {
  const candidates = [
    title,
    filename ? filename.replace(/\.[^/.]+$/, "") : "",
  ].filter(Boolean);

  const writtenPattern =
    /^(.*?)[,_\s-]+(?:vol(?:ume)?|v|book|bk|part|pt)\s+(one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve)(?:[\s-–—:].*)?$/i;

  const romanPatternWithPrefix =
    /^(.*?)[,_\s-]+(?:vol(?:ume)?|book|bk|part|pt)\.?\s*([ivxlcdm]+)(?:[\s-–—:].*)?$/i;

  // Standalone Roman numerals: match longer Roman tokens first (VII, III, IV, II...)
  const standaloneRomanPattern =
    /^(.*?)[,_\s-]+(xx|xix|xviii|xvii|xvi|xv|xiv|xiii|xii|xi|x|ix|viii|vii|vi|v|iv|iii|ii)(?:[\s-–—:].*)?$/i;

  for (const rawStr of candidates) {
    const trimmed = rawStr.trim();

    // 1. Written numbers: "book two", "part three", "volume one"
    const wm = trimmed.match(writtenPattern);
    if (wm) {
      const series = wm[1].replace(/[,_–—:-]+$/, "").trim();
      const numStr = wm[2].toLowerCase();
      const vol = WRITTEN_NUMBER_MAP[numStr];
      if (series.length >= 2 && vol !== undefined) {
        return { series, volume: vol };
      }
    }

    // 2. Roman numerals with explicit prefix (vol, book, part)
    const rm = trimmed.match(romanPatternWithPrefix);
    if (rm) {
      const series = rm[1].replace(/[,_–—:-]+$/, "").trim();
      const romanStr = rm[2].toLowerCase();
      const vol = ROMAN_NUMERAL_MAP[romanStr];
      if (series.length >= 2 && vol !== undefined) {
        return { series, volume: vol };
      }
    }

    // 3. Standalone Roman numeral at end of segment
    const sm = trimmed.match(standaloneRomanPattern);
    if (sm) {
      const series = sm[1].replace(/[,_–—:-]+$/, "").trim();
      const romanStr = sm[2].toLowerCase();
      if (ROMAN_NUMERAL_MAP[romanStr] !== undefined && series.length >= 2) {
        return { series, volume: ROMAN_NUMERAL_MAP[romanStr] };
      }
    }
  }

  return null;
}

/**
 * Call Jev to classify whether a number-like token represents a series volume,
 * a subtitle of the same book, or an unrelated number.
 */
export async function triageSeriesWithJev(
  title: string,
  candidateNumber: number,
  candidateSeries: string,
  options: JevClientOptions = {},
): Promise<{ verdict: SeriesTriageVerdict; confidence: number } | null> {
  const stateText = `Analyze this book title where regex found a number-like token:

- Full Title: ${title}
- Candidate Series Base: ${candidateSeries}
- Detected Number: ${candidateNumber}

Task: Determine whether "${candidateNumber}" is a volume/installment index in a sequential series, part of a subtitle or edition detail for the same single book (e.g. "2nd edition" or chapter/section), or unrelated (e.g. a year like 2024, an address, or a random number in the title).`;

  const res = await callJevSystemOneChoice(
    stateText,
    "series_verdict",
    "Decide whether this number is a series volume, subtitle, or unrelated number.",
    {
      series_volume:
        "The number is an installment/volume number in an ongoing multi-book series (e.g. Book 2, Vol 3, Season 2).",
      subtitle_same_book:
        "The number is part of the book's subtitle, edition description (e.g. 2nd Edition), or section of a single book.",
      unrelated:
        "The number is unrelated to serialization (e.g. a calendar year 1984 or 2024, an address, or a proper noun).",
    },
    options,
  );

  if (!res) return null;

  const validVerdicts: SeriesTriageVerdict[] = ["series_volume", "subtitle_same_book", "unrelated"];
  if (validVerdicts.includes(res.choice as SeriesTriageVerdict)) {
    return {
      verdict: res.choice as SeriesTriageVerdict,
      confidence: res.confidence,
    };
  }

  return null;
}

/**
 * Detect series & volume with fallback to deterministic Roman/written numbers,
 * and then Jev arbitration when a number-like token remains and regex missed.
 */
export async function extractSeriesWithJev(
  title: string,
  filename: string = "",
  extractSeriesBaseFn: (t: string, f?: string) => { series: string; volume: number } | null,
  options: JevClientOptions = {},
): Promise<{ series: string; volume: number } | null> {
  // 1. Existing regex base patterns (vol, book, #, part, Burmese) keep winning with no Jev call
  const existing = extractSeriesBaseFn(title, filename);
  if (existing) return existing;

  // 2. Deterministic roman numerals & written numbers
  const extended = extractSeriesDeterministicExtended(title, filename);
  if (extended) return extended;

  // 3. Call Jev ONLY when a number-like token remains and regex missed
  const candidates = [title, filename ? filename.replace(/\.[^/.]+$/, "") : ""].filter(Boolean);
  for (const rawStr of candidates) {
    const trimmed = rawStr.trim();
    // Look for a number-like token preceded by separator or space
    const numMatch = trimmed.match(/^(.*?)(?:[\s,_\-–—:]+)(\d+(?:\.\d+)?)(?:[\s,_\-–—:].*)?$/);
    if (numMatch) {
      const candidateSeries = numMatch[1].replace(/[,_–—:-]+$/, "").trim();
      const candidateNumber = parseFloat(numMatch[2]);
      if (candidateSeries.length >= 2 && !Number.isNaN(candidateNumber)) {
        // Skip obvious 4-digit years like 19xx or 20xx
        if (candidateNumber >= 1900 && candidateNumber <= 2099) {
          continue;
        }

        const jevRes = await triageSeriesWithJev(
          title,
          candidateNumber,
          candidateSeries,
          options,
        );

        if (
          jevRes &&
          jevRes.verdict === "series_volume" &&
          jevRes.confidence >= 0.7
        ) {
          return { series: candidateSeries, volume: candidateNumber };
        }
        // If subtitle_same_book, unrelated, or confidence < 0.7: leave series empty
        return null;
      }
    }
  }

  return null;
}

// ============================================================================
// 3. Author Cleanup
// ============================================================================

/**
 * Extended deterministic author cleanup tokens: epub, pdf, various, n/a, etc.
 */
export function isJunkAuthorExtended(author: string): boolean {
  if (!author) return true;
  const a = author.trim().toLowerCase();
  if (a.length < 2) return true;

  // Obvious junk tokens
  if (/^(epub|pdf|various|various authors|n\/a|na|none|unknown|anonymous|admin)$/i.test(a)) {
    return true;
  }

  // Promotional/watermark patterns
  return /http|t\.me|telegram|channel|admin|unknown|anonymous|\.com|\.org|\.li|\.is|\.pub|\.net|\.xyz|thebookr|z-?lib|libgen|annas?-archive|oceanofpdf|vk\.com/i.test(
    a,
  );
}

/**
 * Check whether a non-empty, non-junk author looks suspicious:
 * - translator credited as sole author (e.g. "Translated by John Doe", "Trans. Jane", "Translator: ...")
 * - site-like token (e.g. "wavypremium", "readnovelfull", "novelupdates", "fan-translation")
 * - edited-by with no name (e.g. "Edited by", "Editor", "Compiled by", "Translator")
 */
export function isSuspiciousAuthor(author: string): boolean {
  if (!author) return false;
  const a = author.trim().toLowerCase();

  // Translator credited as sole author
  if (/^(?:translated by|trans\.?|translator[:\s]|translation by)\b/i.test(a) || /^translator\s*:/i.test(a)) {
    return true;
  }

  // Edited-by with no actual name following or generic role
  if (/^(?:edited by|editor|compiled by|compiler|curator|publisher)$/i.test(a)) {
    return true;
  }

  // Site-like or aggregator tokens without a full domain
  if (/\b(?:novelupdates|readnovel|lightnovelpub|webnovel|royalroad|scribblehub|fantranslation|wuxiaworld)\b/i.test(a)) {
    return true;
  }

  return false;
}

/**
 * Call Jev to classify suspicious author string.
 * Choices: keep, mark_unknown.
 */
export async function triageAuthorWithJev(
  author: string,
  title: string = "",
  options: JevClientOptions = {},
): Promise<{ verdict: AuthorTriageVerdict; confidence: number } | null> {
  const stateText = `Inspect this author field for a book:

- Book Title: ${title || "(unknown)"}
- Author Field: ${author}

Task: Determine whether to KEEP this as a legitimate author name, or MARK_UNKNOWN because it is not a real author (it is an uncredited role like 'Edited by' with no name, a translator credited as the sole author without the original author, or a site/aggregator watermark).`;

  const res = await callJevSystemOneChoice(
    stateText,
    "author_verdict",
    "Classify whether to keep this author or mark as unknown.",
    {
      keep: "A legitimate, real human or recognized pseudonym author name that should be kept.",
      mark_unknown: "An invalid author entry (role without name, aggregator watermark, or solely translator) that should be replaced with Unknown.",
    },
    options,
  );

  if (!res) return null;

  const validVerdicts: AuthorTriageVerdict[] = ["keep", "mark_unknown"];
  if (validVerdicts.includes(res.choice as AuthorTriageVerdict)) {
    return {
      verdict: res.choice as AuthorTriageVerdict,
      confidence: res.confidence,
    };
  }

  return null;
}

/**
 * Clean author with deterministic rules + Jev arbitration for suspicious authors.
 * Never invents an author name.
 */
export async function cleanAuthorWithJev(
  author: string,
  title: string = "",
  options: JevClientOptions = {},
): Promise<string> {
  const trimmed = cleanString(author || "");
  if (!trimmed || isJunkAuthorExtended(trimmed)) {
    return "Unknown";
  }

  // If author is ordinary, keep it without calling Jev
  if (!isSuspiciousAuthor(trimmed)) {
    return trimmed;
  }

  // If suspicious, call Jev
  const jevRes = await triageAuthorWithJev(trimmed, title, options);
  if (jevRes && jevRes.verdict === "mark_unknown" && jevRes.confidence >= 0.7) {
    return "Unknown";
  }

  // Fail open: keep existing author
  return trimmed;
}

// ============================================================================
// 4. Language Shelf Detection & Standardized Categorization
// ============================================================================

/**
 * Myanmar Unicode blocks:
 * - Basic Myanmar: \u1000-\u109F (includes consonants [က-႟] and digits [၀-၉])
 * - Myanmar Extended-A: \uA9E0-\uA9FF
 * - Myanmar Extended-B: \uAA60-\uAA7F
 */
export const MYANMAR_UNICODE_REGEX = /[\u1000-\u109F\uA9E0-\uA9FF\uAA60-\uAA7F]/;
export const LATIN_LETTER_REGEX = /[a-zA-Z]/;

/**
 * Checks whether a text contains Myanmar Unicode characters.
 */
export function containsBurmese(text?: string | null): boolean {
  if (!text) return false;
  return MYANMAR_UNICODE_REGEX.test(text);
}

export const BURMESE_TRANSLITERATED_TOKENS = new Set([
  "u", "daw", "ko", "ma", "mg", "maung", "min", "thakin", "sayadaw", "bo", "saya",
  "ashin", "lu", "win", "aung", "kyaw", "myint", "tun", "swe", "soe", "naing",
  "lwin", "moe", "oo", "zin", "htun", "aye", "san", "nu", "ni", "sein", "tin",
  "pe", "khin", "thant", "thaw", "yin", "cho", "mon", "gyi", "lay", "hla",
  "hlaing", "thein", "shwe", "nyo", "thura", "zayar", "nanda", "myanmar", "burma",
  "burmese", "pyi", "myaing", "kaba", "tha", "htar",
]);

/**
 * Checks whether Latin text matches transliterated Burmese names or terminology,
 * indicating an ambiguous candidate that requires Jev System-1 arbitration.
 */
export function isTransliteratedBurmeseCandidate(title: string, author: string = ""): boolean {
  const combined = `${title} ${author}`.toLowerCase();
  const words = combined.match(/[a-z]+/g) || [];
  if (words.length === 0) return false;

  let matchCount = 0;
  for (const w of words) {
    if (BURMESE_TRANSLITERATED_TOKENS.has(w)) {
      matchCount++;
      if (["burma", "burmese", "myanmar", "sayadaw", "thakin"].includes(w)) {
        return true;
      }
    }
  }

  if (matchCount >= 2) return true;
  if (matchCount >= 1 && words.length <= 3) return true;

  return false;
}

/**
 * Detects whether a tag is promotional junk, watermarking, or file format noise.
 */
export function isJunkTag(tag: string): boolean {
  if (!tag) return true;
  const t = tag.trim().toLowerCase();
  if (t.length < 2) return true;

  // Single file formats
  if (/^(?:epub|pdf|mobi|azw3?|cbz|cbr|txt|rtf|docx?|zip|rar)$/i.test(t)) {
    return true;
  }

  // Watermark phrases & pirate branding
  if (/^(?:z-?lib(?:rary)?|oceanofpdf|libgen|annas?-archive|vk\.com|thebookr|mmebooks)$/i.test(t)) {
    return true;
  }
  if (/^(?:do not post elsewhere|do not translate|fan translated|fan translation|unknown|various|various authors|n\/a|none|admin)$/i.test(t)) {
    return true;
  }
  if (/(?:downloaded from|uploaded by|scanned by|released by)/i.test(t)) {
    return true;
  }

  // Telegram / Social channels: t.me/..., @channel, telegram
  if (/(?:t\.me\/|@\w+|telegram\.me|telegram)/i.test(t)) {
    return true;
  }

  // URLs or website domains
  if (/^(?:https?:\/\/|www\.)/i.test(t) || /\.(?:com|org|net|xyz|li|is|pub|me|info|biz|ru|cc|to)(?:\/.*)?$/i.test(t)) {
    return true;
  }

  return false;
}

/**
 * Strips promotional watermarks, junk tags, and formats from book tags list.
 * Deduplicates case-insensitively while preserving clean casing.
 */
export function cleanBookTags(tags: string[]): string[] {
  if (!tags || !Array.isArray(tags)) return [];
  const seen = new Set<string>();
  const cleaned: string[] = [];

  for (const raw of tags) {
    if (!raw || typeof raw !== "string") continue;
    const trimmed = cleanString(raw).replace(/^[\[\(]+|[\]\)]+$/g, "").trim();
    if (!trimmed || isJunkTag(trimmed)) continue;

    const lower = trimmed.toLowerCase();
    if (seen.has(lower)) continue;
    seen.add(lower);
    cleaned.push(trimmed);
  }

  return cleaned;
}

/**
 * Checks whether a book tags list contains at least one standardized category.
 */
export function hasMeaningfulCategoryTag(tags: string[]): boolean {
  if (!tags || !Array.isArray(tags) || tags.length === 0) return false;
  const standardSet = new Set(STANDARDIZED_CATEGORIES.map((c) => c.toLowerCase()));
  return tags.some((t) => standardSet.has(t.trim().toLowerCase()));
}

/**
 * Deterministic language detection:
 * - Deterministic rule: If title, author, or comments contain Myanmar Unicode characters
 *   ([က-႟] or [၀-၉]), classify as 'mya' (Burmese).
 * - Pure Latin titles without Burmese: 'eng' (English).
 * - Returns null when ambiguous or mixed (e.g. non-Latin non-Myanmar like Japanese/Chinese,
 *   pure digits, or transliterated candidates requiring Jev).
 */
export function detectLanguageDeterministic(
  title: string,
  filename: string = "",
  author: string = "",
  comments: string = "",
): "mya" | "eng" | null {
  const combined = `${title} ${filename} ${author} ${comments}`.trim();
  if (!combined) return null;

  // 1. Myanmar script anywhere in title, author, or comments -> 'mya' (Burmese)
  if (MYANMAR_UNICODE_REGEX.test(combined)) {
    return "mya";
  }

  // 2. Ambiguous transliterated Burmese candidates -> query Jev System-1
  if (isTransliteratedBurmeseCandidate(title, author)) {
    return null;
  }

  // 3. Pure Latin titles without Burmese -> 'eng' (English)
  const textToCheck = `${title} ${filename}`.trim();
  const hasLatin = LATIN_LETTER_REGEX.test(textToCheck);
  const hasCjk = /[\u4E00-\u9FFF\u3040-\u309F\u30A0-\u30FF\uAC00-\uD7AF]/.test(textToCheck);
  const hasCyrillic = /[\u0400-\u04FF]/.test(textToCheck);
  const hasArabic = /[\u0600-\u06FF]/.test(textToCheck);

  if (hasLatin && !hasCjk && !hasCyrillic && !hasArabic) {
    return "eng";
  }

  // Ambiguous, non-Latin, or neither
  return null;
}

/**
 * Call Jev to classify language for mixed or ambiguous text.
 * Choices: 'my', 'en', 'other'.
 * Resolves to Calibre 3-letter codes: 'mya' (Burmese), 'eng' (English), or 'other'.
 */
export async function triageLanguageWithJev(
  title: string,
  filename: string = "",
  options: JevClientOptions = {},
): Promise<{ language: "mya" | "eng" | "other"; confidence: number } | null> {
  const stateText = `Determine the primary reading language of this book based on its title and filename:

- Title: ${title || "(empty)"}
- Filename: ${filename || "(empty)"}

Task: Classify whether the content is primarily Burmese ('my'), English ('en'), or Another language ('other', e.g. Japanese, Chinese, French, Spanish, Russian).`;

  const res = await callJevSystemOneChoice(
    stateText,
    "language_verdict",
    "Classify the primary language as Burmese (my), English (en), or Other (other).",
    {
      my: "Burmese (Myanmar) language book or translation.",
      en: "English language book or article.",
      other: "Any other language (e.g. Japanese, Chinese, Russian, French, German, Spanish, etc.).",
    },
    options,
  );

  if (!res) return null;

  let langCode: "mya" | "eng" | "other" | null = null;
  if (res.choice === "my" || res.choice === "mya") {
    langCode = "mya";
  } else if (res.choice === "en" || res.choice === "eng") {
    langCode = "eng";
  } else if (res.choice === "other") {
    langCode = "other";
  }

  if (langCode) {
    return {
      language: langCode,
      confidence: res.confidence,
    };
  }

  return null;
}

/**
 * Call Jev System-1 to assign one of the standardized categories:
 * 'Light Novel', 'Manga', 'Fiction', 'Non-Fiction', 'Technology', 'Business', 'History', 'Philosophy', 'Burmese Literature'.
 */
export async function triageCategoryWithJev(
  title: string,
  author: string = "",
  series: string = "",
  description: string = "",
  options: JevClientOptions = {},
): Promise<{ category: StandardCategory; confidence: number } | null> {
  const stateText = `Inspect the following book metadata to determine its primary standardized category:

- Title: ${title || "(empty)"}
- Author: ${author || "(unknown)"}
- Series: ${series || "(none)"}
- Description: ${description ? cleanString(description).slice(0, 500) : "(none)"}

Task: Assign one standardized category: Light Novel, Manga, Fiction, Non-Fiction, Technology, Business, History, Philosophy, or Burmese Literature.`;

  const criteria: Record<StandardCategory, string> = {
    "Light Novel": "Japanese or East-Asian light novel, web novel, or ranobe series.",
    "Manga": "Manga, comic, graphic novel, or manhua/manhwa.",
    "Fiction": "General fiction, novel, fantasy, sci-fi, thriller, mystery, romance, or literary fiction.",
    "Non-Fiction": "General non-fiction, biographies, memoirs, essays, self-help, or educational books.",
    "Technology": "Computer science, programming, software engineering, AI, tech guides, or computing.",
    "Business": "Business, economics, finance, entrepreneurship, investing, or leadership.",
    "History": "World history, military history, historical events, biographies of historical figures.",
    "Philosophy": "Philosophy, ethics, logic, epistemology, or existential philosophy.",
    "Burmese Literature": "Burmese (Myanmar) literature, novels, poetry, traditional writings, or Burmese translations.",
  };

  const res = await callJevSystemOneChoice(
    stateText,
    "book_category",
    "Assign the single best standardized category.",
    criteria,
    options,
  );

  if (!res) return null;

  const valid = STANDARDIZED_CATEGORIES.find(
    (c) => c.toLowerCase() === res.choice.toLowerCase(),
  );
  if (valid) {
    return {
      category: valid,
      confidence: res.confidence,
    };
  }

  return null;
}

export interface DetectLanguageOptions extends JevClientOptions {
  author?: string;
  comments?: string;
}

/**
 * High-level language resolver:
 * 1. Deterministic first: Myanmar Unicode in title, author, or comments -> 'mya'; Latin without Myanmar -> 'eng'.
 * 2. Jev triage for mixed or ambiguous text ('my', 'en', 'other') only if confidence >= 0.7.
 * 3. Fail open: returns null if Jev fails or confidence < 0.7 (do not store unconfident language).
 */
export async function detectBookLanguage(
  title: string,
  filename: string = "",
  optionsOrAuthor: DetectLanguageOptions | string = {},
  commentsArg: string = "",
  optionsArg: JevClientOptions = {},
): Promise<"mya" | "eng" | "other" | null> {
  let author = "";
  let comments = "";
  let options: JevClientOptions = {};

  if (typeof optionsOrAuthor === "string") {
    author = optionsOrAuthor;
    comments = commentsArg;
    options = optionsArg;
  } else if (optionsOrAuthor && typeof optionsOrAuthor === "object") {
    author = optionsOrAuthor.author || "";
    comments = optionsOrAuthor.comments || "";
    options = optionsOrAuthor;
  }

  const det = detectLanguageDeterministic(title, filename, author, comments);
  if (det) {
    return det;
  }

  const jevRes = await triageLanguageWithJev(title, filename, options);
  if (jevRes && jevRes.confidence >= 0.7) {
    return jevRes.language;
  }

  return null;
}

/**
 * Comprehensive book classification helper:
 * - Detects language (deterministic or Jev).
 * - Burmese script deterministically resolves to 'mya' with 'Burmese Literature' tag.
 * - English script resolves to 'eng'.
 * - Assigns standardized category via Jev System-1 for books missing meaningful tags.
 * - Strips junk tags and promotional watermarks.
 */
export async function resolveBookLanguageAndTags(
  book: BookMetadataInput,
  options: JevClientOptions = {},
): Promise<BookClassificationResult> {
  const title = book.title || "";
  const author = book.author || "";
  const comments = book.comments || "";
  const filename = book.filename || "";
  const origTags = book.tags || [];

  // 1. Clean junk tags and promotional watermarks
  const cleanedTags = cleanBookTags(origTags);
  const removedTags = origTags.filter(
    (ot) => !cleanedTags.some((ct) => ct.toLowerCase() === ot.trim().toLowerCase()),
  );

  // 2. Language Detection
  let lang: "mya" | "eng" | "other" | null = null;

  // Step 2a: Hard Myanmar script evidence anywhere in metadata -> 'mya'
  const combined = `${title} ${filename} ${author} ${comments}`;
  if (MYANMAR_UNICODE_REGEX.test(combined)) {
    lang = "mya";
  }

  // Step 2b: Explicit OPF embedded dc:language declaration
  if (!lang && book.embeddedLanguage) {
    const rawEmb = book.embeddedLanguage.trim().toLowerCase();
    if (/^(?:my|mya|bur|burmese)$/i.test(rawEmb)) {
      lang = "mya";
    } else if (/^(?:ja|jpn|japanese|zh|zho|chi|chinese|ko|kor|korean|fr|fra|fre|french|de|deu|ger|german|es|spa|spanish|ru|rus|russian)$/i.test(rawEmb)) {
      lang = "other";
    } else if (/^(?:en|eng|english)$/i.test(rawEmb) && !isTransliteratedBurmeseCandidate(title, author)) {
      lang = "eng";
    }
  }

  // Step 2c: Pure Latin script check (no transliterated Burmese tokens)
  if (!lang) {
    lang = detectLanguageDeterministic(title, filename, author, comments);
  }

  // Step 2d: Ambiguous / transliterated candidates -> query Jev System-1
  if (!lang) {
    const jevLang = await triageLanguageWithJev(title, filename, options);
    if (jevLang && jevLang.confidence >= 0.7) {
      lang = jevLang.language;
    } else {
      // Fail open: mark 'other' so callers DO NOT force 'eng' or corrupt Calibre metadata
      lang = "other";
    }
  }

  const isBurmese = lang === "mya";
  const finalTags = [...cleanedTags];

  // 3. Burmese tag rule
  if (isBurmese) {
    if (!finalTags.some((t) => t.toLowerCase() === "burmese literature")) {
      finalTags.push("Burmese Literature");
    }
  }

  // 4. Standardized Category Assignment
  let category: StandardCategory | undefined;
  const existingCategory = STANDARDIZED_CATEGORIES.find((cat) =>
    finalTags.some((t) => t.toLowerCase() === cat.toLowerCase()),
  );

  if (existingCategory) {
    category = existingCategory;
  } else {
    // Missing meaningful category: assign one
    if (isBurmese) {
      category = "Burmese Literature";
      // Burmese Literature is already added to finalTags
    } else {
      // Query Jev System-1 for standardized category
      const jevCat = await triageCategoryWithJev(
        title,
        author,
        book.series || "",
        comments,
        options,
      );
      if (jevCat && jevCat.confidence >= 0.7) {
        category = jevCat.category;
        finalTags.push(jevCat.category);
      } else {
        // Deterministic format / bracket fallback
        const lowerFile = filename.toLowerCase();
        if (lowerFile.endsWith(".cbz") || lowerFile.endsWith(".cbr") || /\[(?:manga|comic)\]/i.test(title)) {
          category = "Manga";
          finalTags.push("Manga");
        } else if (/\[(?:ln|light\s*novel|web\s*novel|wn|ranobe)\]/i.test(title)) {
          category = "Light Novel";
          finalTags.push("Light Novel");
        }
      }
    }
  }

  // 5. Compare with current book state
  const addedTags = finalTags.filter(
    (ft) => !origTags.some((ot) => ot.toLowerCase() === ft.toLowerCase()),
  );

  const currentLangs = (book.currentLanguages || []).map((l) =>
    String(l).trim().toLowerCase(),
  );
  const needsLanguageUpdate =
    lang !== "other" && !currentLangs.includes(lang.toLowerCase());
  const needsTagsUpdate = addedTags.length > 0 || removedTags.length > 0;

  return {
    language: lang,
    tags: finalTags,
    addedTags,
    removedTags,
    category,
    isBurmese,
    needsLanguageUpdate,
    needsTagsUpdate,
  };
}

// ============================================================================
// 5. Source Category Classification & Smart Routing
// ============================================================================

/**
 * Deterministic rules for classifying book source category:
 * - File extension is .cbz or .cbr -> 'manga'
 * - Explicit tags or bracketed title tokens ([LN], [Light Novel], [Web Novel], [WN]) -> 'light_novel'
 * - Explicit tags or bracketed title tokens ([Manga], [Comic]) -> 'manga'
 * - Burmese Unicode characters without English/Japanese indicators -> 'burmese'
 * - Returns null when inconclusive.
 */
export function classifyBookSourceCategoryDeterministic(
  title: string,
  author: string = "",
  filename: string = "",
  tags: string[] = [],
): BookSourceCategory | null {
  // 1. File extension is .cbz / .cbr -> manga
  const lowerFile = (filename || "").toLowerCase();
  if (lowerFile.endsWith(".cbz") || lowerFile.endsWith(".cbr")) {
    return "manga";
  }

  // 2. Explicit tags or bracketed title tokens: [LN], [Light Novel], [Web Novel], [WN]
  // Use bracket patterns or exact tag checks to prevent false matches on words like 'Tolstoy LN' or 'A Comic Novel'
  const lnBracketPattern = /[\[\(]\s*(?:ln|light\s*novel|web\s*novel|wn|ranobe|bunko)\s*[\]\)]/i;
  const explicitLnTag = tags.some((t) =>
    /^(?:light[\s_-]?novel|ln|web[\s_-]?novel|wn|ranobe|bunko)$/i.test(t.trim()),
  );
  if (explicitLnTag || lnBracketPattern.test(title) || lnBracketPattern.test(filename)) {
    return "light_novel";
  }

  // 3. Explicit tags or bracketed title tokens: [Manga], [Comic]
  const mangaBracketPattern = /[\[\(]\s*(?:manga|comic)\s*[\]\)]/i;
  const explicitMangaTag = tags.some((t) =>
    /^(?:manga|comic)$/i.test(t.trim()),
  );
  if (explicitMangaTag || mangaBracketPattern.test(title) || mangaBracketPattern.test(filename)) {
    return "manga";
  }

  // 4. Burmese Unicode characters without English/Japanese indicators
  // Ignore placeholder/generic author strings like "Unknown", "Various", "N/A"
  const cleanAuth = /^(?:unknown|various|n\/a|none|anonymous|admin)?$/i.test(author.trim())
    ? ""
    : author.trim();
  const textToCheck = `${title} ${cleanAuth}`.trim();
  const hasMyanmar = MYANMAR_UNICODE_REGEX.test(title) || MYANMAR_UNICODE_REGEX.test(textToCheck);
  if (hasMyanmar) {
    const hasEnglish = LATIN_LETTER_REGEX.test(textToCheck);
    const hasJapanese = /[\u3040-\u309F\u30A0-\u30FF]/.test(textToCheck);
    if (!hasEnglish && !hasJapanese) {
      return "burmese";
    }
  }

  return null;
}

/**
 * Call Jev System-1 to classify book source category when deterministic rules are inconclusive.
 * Choices: 'light_novel' | 'manga' | 'general_book' | 'other'
 */
export async function triageSourceCategoryWithJev(
  title: string,
  author: string = "",
  filename: string = "",
  tags: string[] = [],
  options: JevClientOptions = {},
): Promise<{ category: "light_novel" | "manga" | "general_book" | "other"; confidence: number } | null> {
  const stateText = `Inspect this book metadata and determine its source category for metadata & cover search:

- Title: ${title || "(empty)"}
- Author: ${author || "(empty)"}
- Filename: ${filename || "(empty)"}
- Tags: ${tags.length > 0 ? tags.join(", ") : "(none)"}

Task: Classify whether this book is a Japanese/Asian Light Novel ('light_novel'), a Manga or Comic ('manga'), a General/Western Book or Non-fiction/Fiction novel ('general_book'), or Other/Unsure ('other').`;

  const res = await callJevSystemOneChoice(
    stateText,
    "source_category_verdict",
    "Classify the book source category as light_novel, manga, general_book, or other.",
    {
      light_novel: "Japanese or East-Asian light novel or web novel series (e.g. Overlord, Re:Zero, Danmachi, SAO, Classroom of the Elite).",
      manga: "Manga, comic, graphic novel, or manhua/manhwa (e.g. One Piece, Berserk, Naruto).",
      general_book: "Standard Western novel, non-fiction, textbook, literature, or trade book (e.g. The Great Gatsby, Clean Code, Sapiens).",
      other: "Unrecognized, miscellaneous, or cannot be confidently placed into the other categories.",
    },
    options,
  );

  if (!res) return null;

  const validCategories = ["light_novel", "manga", "general_book", "other"] as const;
  if ((validCategories as readonly string[]).includes(res.choice)) {
    return {
      category: res.choice as "light_novel" | "manga" | "general_book" | "other",
      confidence: res.confidence,
    };
  }

  return null;
}

/**
 * High-level Book Source Category Classifier:
 * 1. Hardened Burmese check:
 *    - If title contains Myanmar Unicode characters, immediately return 'burmese' unconditionally
 *      (skips overseas APIs even when author is written in Latin characters).
 * 2. Deterministic rules:
 *    - .cbz/.cbr -> 'manga'
 *    - [LN], [Light Novel], [Web Novel], [WN] -> 'light_novel'
 *    - [Manga], [Comic] -> 'manga'
 *    - Burmese Unicode without English/Japanese indicators -> 'burmese'
 * 3. Jev System-1 arbitration when deterministic rules are inconclusive:
 *    - Query Jev choice: 'light_novel' | 'manga' | 'general_book' | 'other'
 *    - Confidence threshold >= 0.7
 * 4. Fails open to 'general_book' if Jev is unavailable, key is missing, or confidence < 0.7.
 */
export async function classifyBookSourceCategory(
  title: string,
  author: string = "",
  filename: string = "",
  tags: string[] = [],
  options: JevClientOptions = {},
): Promise<BookSourceCategory> {
  // If title contains Myanmar Unicode characters, immediately return 'burmese' unconditionally.
  // Do not let an English author name (e.g. 'Mya Than Tint', 'Min Theim Kha') cause a Burmese book to be classified as 'general_book'.
  if (containsBurmese(title)) {
    return "burmese";
  }

  const det = classifyBookSourceCategoryDeterministic(title, author, filename, tags);
  if (det) {
    return det;
  }

  const jevRes = await triageSourceCategoryWithJev(title, author, filename, tags, options);
  if (jevRes && jevRes.confidence >= 0.7) {
    return jevRes.category;
  }

  // Fail open to 'general_book'
  return "general_book";
}

