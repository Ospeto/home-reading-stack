import { Buffer } from "node:buffer";

export interface BookMetadataForFilename {
  title?: string | null;
  authors?: string | string[] | null;
  series?: string | null;
  seriesIndex?: number | string | null;
  series_index?: number | string | null;
  format?: string | null;
  fallbackBase?: string | null;
}

const ILLEGAL_CHARS_REGEX = /[<>:"/\\|?*\x00-\x1F\x7F]/g;
const WINDOWS_RESERVED_NAMES = new Set([
  "CON", "PRN", "AUX", "NUL",
  "COM1", "COM2", "COM3", "COM4", "COM5", "COM6", "COM7", "COM8", "COM9",
  "LPT1", "LPT2", "LPT3", "LPT4", "LPT5", "LPT6", "LPT7", "LPT8", "LPT9"
]);

/**
 * Format series index to a clean padded string.
 * Examples:
 *   1 -> "01"
 *   9 -> "09"
 *   10 -> "10"
 *   1.5 -> "01.5"
 *   "02" -> "02"
 */
export function formatSeriesIndex(index: number | string | null | undefined): string {
  if (index === null || index === undefined || index === "") return "";
  const num = typeof index === "number" ? index : parseFloat(String(index).replace(/[^0-9.]/g, ""));
  if (Number.isNaN(num)) {
    return String(index).trim().replace(ILLEGAL_CHARS_REGEX, "");
  }
  if (Number.isInteger(num)) {
    return num >= 0 && num < 10 ? `0${num}` : String(num);
  }
  // Decimal volume (e.g. 1.5)
  const [intPart, decPart] = String(num).split(".");
  const paddedInt = parseInt(intPart, 10) < 10 && parseInt(intPart, 10) >= 0 ? `0${intPart}` : intPart;
  return `${paddedInt}.${decPart}`;
}

/**
 * Clean and sanitize a single metadata segment (title, author, series).
 */
export function sanitizeSegment(segment: string): string {
  if (!segment) return "";
  let s = segment.normalize("NFC");

  // Remove URL links, usernames, telegram marks
  s = s.replace(/https?:\/\/\S+/gi, " ");
  s = s.replace(/t\.me\/\S+/gi, " ");
  s = s.replace(/@\w+/gi, " ");
  s = s.replace(/www\.\S+/gi, " ");

  // Remove bracketed spam tags
  s = s.replace(/\[.*?(ebook|pdf|epub|channel|mobi|azw|scan|myanmar|tg|bookr).*?\]/gi, " ");
  s = s.replace(/\((.*?)(ebook|pdf|epub|channel|mobi|azw|scan|myanmar|tg|bookr)(.*?)\)/gi, " ");

  // Strip path traversal attempts and dangerous characters
  s = s.replace(/\.\.+/g, " ");
  s = s.replace(ILLEGAL_CHARS_REGEX, " ");

  // Collapse whitespace and separators
  s = s.replace(/[\s_]+/g, " ");
  s = s.replace(/\s*[-–—]\s*/g, " - ");
  s = s.replace(/(?: - )+/g, " - ");

  // Trim leading/trailing separators and dots
  s = s.replace(/^[\s.\-–—]+|[\s.\-–—]+$/g, "").trim();

  return s;
}

/**
 * Truncate a UTF-8 string to a maximum byte length without cutting multi-byte characters.
 */
export function truncateUtf8Bytes(str: string, maxBytes: number): string {
  if (Buffer.byteLength(str, "utf8") <= maxBytes) {
    return str;
  }

  // Iterate over Unicode code points to avoid splitting surrogate pairs or combining marks
  const chars = Array.from(str);
  let result = "";
  for (const char of chars) {
    if (Buffer.byteLength(result + char, "utf8") > maxBytes) {
      break;
    }
    result += char;
  }

  // Clean trailing spaces and separators after truncation
  return result.replace(/^[\s.\-–—]+|[\s.\-–—]+$/g, "").trim();
}

/**
 * Generate a sanitized, metadata-derived filename for user-facing downloads and deliveries.
 * Formats:
 *   With series: "Series 01 - Title - Author.epub"
 *   Without series: "Title - Author.epub"
 *   Without author: "Title.epub"
 *
 * Never touches Calibre's internal files.
 */
export function generateMetadataFilename(
  metadata: BookMetadataForFilename,
  options: { maxBytes?: number; defaultExt?: string } = {}
): string {
  const maxBytes = options.maxBytes ?? 200;
  const defaultExt = options.defaultExt ?? "epub";

  const rawExt = metadata.format || defaultExt;
  const cleanExt = rawExt.trim().replace(/^\./, "").toLowerCase() || "epub";

  let rawAuthors = "";
  if (Array.isArray(metadata.authors)) {
    rawAuthors = metadata.authors.filter(Boolean).join(", ");
  } else if (metadata.authors) {
    rawAuthors = String(metadata.authors);
  }

  // Filter out junk author names
  let author = sanitizeSegment(rawAuthors);
  if (/^(unknown|anonymous|admin)$/i.test(author)) {
    author = "";
  }

  let title = sanitizeSegment(metadata.title || "");
  const series = sanitizeSegment(metadata.series || "");
  const rawSeriesIndex =
    metadata.seriesIndex !== undefined && metadata.seriesIndex !== null
      ? metadata.seriesIndex
      : metadata.series_index;
  const seriesIdx = formatSeriesIndex(rawSeriesIndex);

  // Fallback if title is missing
  if (!title) {
    if (metadata.fallbackBase) {
      title = sanitizeSegment(metadata.fallbackBase);
    }
    if (!title) {
      title = "Book";
    }
  }

  // Build the base name parts
  let baseName = "";
  if (series) {
    const seriesPart = seriesIdx ? `${series} ${seriesIdx}` : series;
    if (author) {
      baseName = `${seriesPart} - ${title} - ${author}`;
    } else {
      baseName = `${seriesPart} - ${title}`;
    }
  } else if (author) {
    baseName = `${title} - ${author}`;
  } else {
    baseName = title;
  }

  // Check Windows reserved names (e.g. CON.epub)
  const upperBase = baseName.toUpperCase();
  if (WINDOWS_RESERVED_NAMES.has(upperBase)) {
    baseName = `Book_${baseName}`;
  }

  // Safe length truncation preserving extension
  baseName = truncateUtf8Bytes(baseName, maxBytes);
  if (!baseName) {
    baseName = "Book";
  }

  // Ensure no leading period
  baseName = baseName.replace(/^\.+/, "");

  return `${baseName}.${cleanExt}`;
}

/**
 * Construct an RFC 5987 / RFC 6266 compliant Content-Disposition header.
 * Provides an ASCII-safe fallback for older clients and percent-encoded UTF-8 for modern clients.
 */
export function buildContentDisposition(
  filename: string,
  dispositionType: "attachment" | "inline" = "attachment"
): string {
  // ASCII-safe fallback: replace any non-ASCII characters with '_'
  const asciiFallback = filename
    .replace(/[^\x20-\x7E]/g, "_")
    .replace(/["\\]/g, "_");

  const utf8Encoded = encodeURIComponent(filename)
    .replace(/['()]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`)
    .replace(/\*/g, "%2A");

  return `${dispositionType}; filename="${asciiFallback}"; filename*=UTF-8''${utf8Encoded}`;
}
