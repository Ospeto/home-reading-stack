import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { safeFetchWithSsrf } from "./security";

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
  if (!author) return true;
  const a = author.trim();
  if (a.length < 2) return true;
  return /http|t\.me|telegram|channel|admin|unknown|anonymous|\.com|\.org|\.li|\.is|\.pub|thebookr|z-?lib|libgen|annas?-archive|oceanofpdf|vk\.com/i.test(
    a,
  );
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
    /^(.*?)[,_\s-]+(?:vol(?:ume)?|v)\.?\s*(\d+(?:\.\d+)?)(?:[\s-–—:].*)?$/i,
    /^(.*?)[,_\s-]+(?:book|bk)\.?\s*(\d+(?:\.\d+)?)(?:[\s-–—:].*)?$/i,
    /^(.*?)[,_\s-]+#\s*(\d+(?:\.\d+)?)(?:[\s-–—:].*)?$/i,
    /^(.*?)[,_\s-]+(?:part|pt)\.?\s*(\d+(?:\.\d+)?)(?:[\s-–—:].*)?$/i,
  ];

  for (const str of candidates) {
    for (const p of patterns) {
      const m = str.match(p);
      if (m) {
        const series = cleanString(m[1])
          .replace(/[,_–—:-]+$/, "")
          .trim();
        const vol = parseFloat(m[2]);
        if (series.length >= 2 && !isNaN(vol)) {
          return { series, volume: vol };
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
    series?: { series: string; volume: number } | null;
  },
): boolean {
  const bTitle = cleanString(existing.title).toLowerCase();
  const sTitle = cleanString(incoming.title).toLowerCase();
  if (!bTitle || !sTitle) return false;

  const bAuthor = cleanString(existing.authors || "");
  const sAuthor = cleanString(incoming.author || "");

  // 1. Series comparison
  const bSeries = existing.series
    ? {
        series: cleanString(existing.series),
        volume: existing.series_index || 1,
      }
    : extractSeries(existing.title);
  const sSeries = incoming.series || extractSeries(incoming.title);

  if (bSeries && sSeries) {
    const sameSeries =
      cleanString(bSeries.series).toLowerCase() ===
      cleanString(sSeries.series).toLowerCase();
    if (sameSeries) {
      return bSeries.volume === sSeries.volume;
    }
    return false;
  } else if (bSeries || sSeries) {
    // One is explicitly numbered volume/book in a series and the other is not
    return false;
  }

  // 2. Author conflict check
  const hasKnownAuthors =
    bAuthor && sAuthor && !isJunkAuthor(bAuthor) && !isJunkAuthor(sAuthor);
  const authorSim = hasKnownAuthors ? stringSimilarity(bAuthor, sAuthor) : 1.0;
  if (hasKnownAuthors && authorSim < 0.35) {
    // Both books have explicit authors, but they are clearly different people
    return false;
  }

  // 3. Title comparison
  if (bTitle === sTitle) return true;

  const titleSim = stringSimilarity(bTitle, sTitle);
  if (titleSim >= 0.85) return true;

  // Subtitle / prefix match with length guard
  const minLen = Math.min(bTitle.length, sTitle.length);
  if (minLen >= 5 && (bTitle.startsWith(sTitle) || sTitle.startsWith(bTitle))) {
    if (!hasKnownAuthors || authorSim >= 0.6) return true;
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

// Unified Search with Multi-Source Fallback
export async function searchUniversalMetadata(
  query: string,
  hintManga: boolean = false,
): Promise<ScrapedMetadata[]> {
  const results: ScrapedMetadata[] = [];
  const isMangaTarget =
    hintManga ||
    /manga|comic|chapter|ch\.|vol\.|c0|one piece|naruto|bleach|berserk/i.test(
      query,
    );

  if (isMangaTarget) {
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
      searchGoogleBooks(query),
      searchOpenLibrary(query),
    ]);
    for (const res of bookSettled) {
      if (res.status === "fulfilled") {
        results.push(...res.value);
      }
    }
  }

  // If still empty and was not initially marked manga, try manga scrapers as last resort
  if (results.length === 0 && !isMangaTarget) {
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

  // Sort by highest confidence
  results.sort((a, b) => b.confidence - a.confidence);
  return results;
}

export function isAllowedCoverUrl(rawUrl: string): boolean {
  try {
    const u = new URL(rawUrl);
    if (u.protocol !== "http:" && u.protocol !== "https:") return false;
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
