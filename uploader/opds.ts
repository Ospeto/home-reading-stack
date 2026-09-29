/**
 * uploader/opds.ts
 *
 * Open Publication Distribution System (OPDS) 1.2 Catalog Engine:
 * - Generates standards-compliant Atom XML feeds directly from Calibre library metadata.
 * - Supports acquisition links, thumbnail/master cover links, search, navigation subfeeds, and series.
 * - Rewrites internal loopback URLs (127.0.0.1:8088 / localhost:8088) in Calibre Content Server
 *   OPDS responses to client-facing origins, preventing broken downloads on remote e-readers.
 * - Provides graceful zero-downtime OPDS catalog fallback when Calibre server is busy or down.
 */

export interface OpdsFeedOptions {
  title?: string;
  feedUrl?: string;
  searchUrl?: string;
  iconUrl?: string;
  publicBaseUrl?: string;
  updated?: string;
  subfeeds?: Array<{
    title: string;
    href: string;
    type?: string;
    rel?: string;
  }>;
}

export interface OpdsBookEntry {
  id: number;
  title: string;
  authors?: string;
  pubdate?: string;
  series?: string | null;
  series_index?: number | null;
  comments?: string | null;
  tags?: string[];
  cover?: number | null;
  formats?: string[];
}

/**
 * Escapes XML entity characters strictly for XML document generation.
 */
export function escapeXml(unsafe: string | null | undefined): string {
  if (!unsafe) return "";
  return String(unsafe)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

/**
 * Strips HTML tags and normalizes whitespace for plain text XML summary.
 */
export function stripHtmlToText(html: string | null | undefined): string {
  if (!html) return "";
  return html
    .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, "")
    .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, "")
    .replace(/<[^>]+>/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * Formats a Date object or timestamp string to ISO 8601 for Atom feeds.
 */
export function formatIsoDate(dateVal?: string | Date | number): string {
  if (!dateVal) return new Date().toISOString();
  try {
    const d = new Date(dateVal);
    if (!Number.isNaN(d.getTime())) {
      return d.toISOString();
    }
  } catch (_err) {
    void _err;
  }
  return new Date().toISOString();
}

/**
 * Generates a valid OPDS 1.2 Atom XML catalog feed from Calibre book records.
 */
export function generateOpdsFeed(
  books: OpdsBookEntry[],
  options: OpdsFeedOptions = {},
): string {
  const feedTitle = options.title || "LightHouse Reading HQ";
  const feedUrl = options.feedUrl || "/opds";
  const baseUrl = (options.publicBaseUrl || "").replace(/\/+$/, "");
  const updatedIso = options.updated || formatIsoDate();
  const searchUrl = options.searchUrl || `${baseUrl}/api/books?search={searchTerms}`;
  const iconUrl = options.iconUrl || `${baseUrl}/favicon.png`;

  const lines: string[] = [
    `<?xml version="1.0" encoding="utf-8"?>`,
    `<feed xmlns="http://www.w3.org/2005/Atom" xmlns:dc="http://purl.org/dc/terms/" xmlns:opds="http://opds-spec.org/2010/catalog">`,
    `  <id>urn:lighthouse:catalog:${escapeXml(feedUrl)}</id>`,
    `  <title>${escapeXml(feedTitle)}</title>`,
    `  <updated>${updatedIso}</updated>`,
    `  <icon>${escapeXml(iconUrl)}</icon>`,
    `  <author>`,
    `    <name>LightHouse</name>`,
    `    <uri>https://github.com/Ospeto/home-reading-stack</uri>`,
    `  </author>`,
    `  <link rel="self" href="${escapeXml(baseUrl + feedUrl)}" type="application/atom+xml;profile=opds-catalog;kind=acquisition"/>`,
    `  <link rel="start" href="${escapeXml(baseUrl)}/opds" type="application/atom+xml;profile=opds-catalog;kind=navigation"/>`,
    `  <link rel="search" href="${escapeXml(searchUrl)}" type="application/atom+xml;profile=opds-catalog"/>`,
  ];

  // Optional navigation subfeeds (e.g. Recent, Series, Burmese)
  if (options.subfeeds && options.subfeeds.length > 0) {
    for (const sf of options.subfeeds) {
      lines.push(
        `  <link rel="${escapeXml(sf.rel || "subsection")}" href="${escapeXml(baseUrl + sf.href)}" type="${escapeXml(sf.type || "application/atom+xml;profile=opds-catalog;kind=acquisition")}" title="${escapeXml(sf.title)}"/>`,
      );
    }
  }

  // Book entries
  for (const book of books) {
    const bookUpdated = formatIsoDate(book.pubdate);
    const summaryText = stripHtmlToText(book.comments || "");
    const downloadHref = `${baseUrl}/api/books/${book.id}/download/epub`;
    const coverThumbHref = `${baseUrl}/api/books/${book.id}/cover?w=360`;
    const coverMasterHref = `${baseUrl}/api/books/${book.id}/cover`;

    lines.push(`  <entry>`);
    lines.push(`    <title>${escapeXml(book.title)}</title>`);
    lines.push(`    <id>urn:calibre:book:${book.id}</id>`);
    lines.push(`    <updated>${bookUpdated}</updated>`);
    if (book.pubdate) {
      lines.push(`    <published>${formatIsoDate(book.pubdate)}</published>`);
    }

    if (book.authors) {
      lines.push(`    <author><name>${escapeXml(book.authors)}</name></author>`);
    } else {
      lines.push(`    <author><name>Unknown</name></author>`);
    }

    if (summaryText) {
      lines.push(`    <summary type="text">${escapeXml(summaryText)}</summary>`);
    }
    if (book.comments) {
      lines.push(`    <content type="text/html">${escapeXml(book.comments)}</content>`);
    }

    if (book.series) {
      const idxAttr = book.series_index !== null && book.series_index !== undefined ? ` label="Volume ${book.series_index}"` : "";
      lines.push(`    <category term="${escapeXml(book.series)}"${idxAttr}/>`);
    }

    if (book.tags && Array.isArray(book.tags)) {
      for (const tag of book.tags) {
        if (tag) lines.push(`    <category term="${escapeXml(tag)}"/>`);
      }
    }

    // Cover image and thumbnail links (OPDS acquisition & image relations)
    lines.push(
      `    <link rel="http://opds-spec.org/image" href="${escapeXml(coverMasterHref)}" type="image/jpeg"/>`,
    );
    lines.push(
      `    <link rel="http://opds-spec.org/image/thumbnail" href="${escapeXml(coverThumbHref)}" type="image/webp"/>`,
    );
    // Acquisition link (EPUB download)
    lines.push(
      `    <link rel="http://opds-spec.org/acquisition" href="${escapeXml(downloadHref)}" type="application/epub+zip" title="EPUB Download"/>`,
    );

    lines.push(`  </entry>`);
  }

  lines.push(`</feed>`);
  return lines.join("\n");
}

/**
 * Rewrites internal loopback URLs (e.g. 127.0.0.1:8088 / localhost:8088) in Calibre Content Server
 * OPDS feeds to relative paths or the client's public URL, preventing connection failures on remote devices.
 */
export function rewriteOpdsXml(
  xml: string,
  clientHost: string,
  clientProto = "http",
  calibreServerBase = "http://127.0.0.1:8088",
): string {
  if (!xml || typeof xml !== "string") return xml;

  const cleanBase = calibreServerBase.replace(/\/+$/, "");
  const baseRegex = new RegExp(
    cleanBase.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"),
    "gi",
  );

  // Also catch generic localhost:8088 and 127.0.0.1:8088 variants
  const loopbackRegex = /https?:\/\/(?:127\.0\.0\.1|localhost):8088/gi;

  const targetPrefix = clientHost ? `${clientProto}://${clientHost}` : "";

  let result = xml.replace(baseRegex, targetPrefix);
  result = result.replace(loopbackRegex, targetPrefix);

  return result;
}
