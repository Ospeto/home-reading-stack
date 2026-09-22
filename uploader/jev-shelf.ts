import path from "node:path";
import fs from "node:fs";
import os from "node:os";
import { safeFetchWithSsrf, cleanString } from "./security";

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
export type LanguageTriageVerdict = "my" | "en" | "other";

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
        confidence: typeof ans.confidence === "number" ? ans.confidence : 0.85,
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
  const qDir = getQuarantineDir();
  ensureDirExists(qDir);
  const targetName = fileName || path.basename(srcPath);
  const destPath = path.join(qDir, targetName);
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
  ];

  for (const str of candidates) {
    const trimmed = str.trim();
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
// 4. Language Shelf Detection
// ============================================================================

/**
 * Myanmar Unicode block: \u1000-\u109F, \uA9E0-\uA9FF, \uAA60-\uAA7F
 */
const MYANMAR_UNICODE_REGEX = /[\u1000-\u109F\uA9E0-\uA9FF\uAA60-\uAA7F]/;
const LATIN_LETTER_REGEX = /[a-zA-Z]/;

/**
 * Deterministic language detection:
 * - Myanmar Unicode in title/filename -> 'my' (Burmese)
 * - Latin letters with NO Myanmar Unicode -> 'en' (English)
 * - Returns null when ambiguous or mixed (e.g. mixed Latin + Burmese, non-Latin non-Myanmar like Japanese/Chinese, or pure digits)
 */
export function detectLanguageDeterministic(
  title: string,
  filename: string = "",
): "my" | "en" | null {
  const combined = `${title} ${filename}`.trim();
  if (!combined) return null;

  const hasMyanmar = MYANMAR_UNICODE_REGEX.test(combined);
  const hasLatin = LATIN_LETTER_REGEX.test(combined);

  // Pure Myanmar (or Myanmar with only digits/punctuation)
  if (hasMyanmar && !hasLatin) {
    return "my";
  }

  // Pure Latin (English) with NO Myanmar characters
  if (hasLatin && !hasMyanmar) {
    // Check if there are other CJK scripts (Chinese/Japanese/Korean)
    const hasCjk = /[\u4E00-\u9FFF\u3040-\u309F\u30A0-\u30FF\uAC00-\uD7AF]/.test(combined);
    if (!hasCjk) {
      return "en";
    }
    // Mixed Latin + CJK is ambiguous
    return null;
  }

  // Mixed or neither
  return null;
}

/**
 * Call Jev to classify language for mixed or ambiguous text.
 * Choices: 'my', 'en', 'other'.
 */
export async function triageLanguageWithJev(
  title: string,
  filename: string = "",
  options: JevClientOptions = {},
): Promise<{ language: LanguageTriageVerdict; confidence: number } | null> {
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

  const validLangs: LanguageTriageVerdict[] = ["my", "en", "other"];
  if (validLangs.includes(res.choice as LanguageTriageVerdict)) {
    return {
      language: res.choice as LanguageTriageVerdict,
      confidence: res.confidence,
    };
  }

  return null;
}

/**
 * High-level language resolver:
 * 1. Deterministic first: Myanmar Unicode -> 'my'; Latin without Myanmar -> 'en'.
 * 2. Jev triage for mixed or ambiguous text.
 * 3. Fallback to 'en' or 'other' if Jev fails.
 */
export async function detectBookLanguage(
  title: string,
  filename: string = "",
  options: JevClientOptions = {},
): Promise<LanguageTriageVerdict> {
  const det = detectLanguageDeterministic(title, filename);
  if (det) {
    return det;
  }

  const jevRes = await triageLanguageWithJev(title, filename, options);
  if (jevRes && jevRes.confidence >= 0.7) {
    return jevRes.language;
  }

  // Deterministic fallback if Jev failed or was low confidence
  const combined = `${title} ${filename}`.trim();
  if (MYANMAR_UNICODE_REGEX.test(combined)) return "my";
  if (LATIN_LETTER_REGEX.test(combined)) return "en";
  return "other";
}
