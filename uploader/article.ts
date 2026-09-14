import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import process from "node:process";
import { cleanString } from "./scraper";

const DROP_DIR = "/Users/ospeto/Books_Drop";
const SERVER_URL = "http://127.0.0.1:8088";
const PROXY_URL = "http://127.0.0.1:7890";
const EBOOK_CONVERT_PATH = "/opt/homebrew/bin/ebook-convert";
const CALIBREDB_PATH = "/opt/homebrew/bin/calibredb";
const FETCH_TIMEOUT_MS = 15000;

if (!fs.existsSync(DROP_DIR)) {
  fs.mkdirSync(DROP_DIR, { recursive: true });
}

export interface ExtractedArticle {
  url: string;
  title: string;
  author: string;
  siteName: string;
  publishedDate?: string;
  wordCount: number;
  readTimeMinutes: number;
  cleanedHtml: string;
  styledDocument: string;
}

export interface IngestArticleResult {
  success: boolean;
  duplicate?: boolean;
  bookId?: number | null;
  title: string;
  authors: string;
  siteName: string;
  wordCount: number;
  readTimeMinutes: number;
  epubPath?: string;
  format: string;
  message?: string;
  error?: string;
}

/**
 * Check if a URL belongs to internal Telegram domains (t.me / telegram.me)
 */
export function isInternalTelegramUrl(urlStr: string): boolean {
  try {
    const parsed = new URL(urlStr);
    const host = parsed.hostname.toLowerCase();
    return (
      host === "t.me" ||
      host === "telegram.me" ||
      host.endsWith(".t.me") ||
      host.endsWith(".telegram.me")
    );
  } catch (_err) {
    void _err;
    return /^(?:https?:\/\/)?(?:t|telegram)\.me\//i.test(urlStr);
  }
}

/**
 * Strip trailing punctuation commonly appended to URLs in conversational text.
 */
function cleanExtractedUrl(urlStr: string): string {
  return urlStr.replace(/[.,;:)>\]]+$/, "");
}

/**
 * Detect and extract a valid external HTTP/HTTPS URL from user input,
 * while ignoring internal Telegram links like t.me.
 */
export function extractUrlFromText(text: string): string | null {
  if (!text) return null;
  const trimmed = text.trim();

  // Handle explicit commands: /epub <url>, /article <url>, /read <url>
  const commandMatch = trimmed.match(/^\/(?:epub|read|article|url)\s+(https?:\/\/\S+)/i);
  if (commandMatch) {
    const candidate = cleanExtractedUrl(commandMatch[1]);
    if (!isInternalTelegramUrl(candidate)) return candidate;
  }

  // Find any http:// or https:// URL in message
  const urlMatches = trimmed.match(/https?:\/\/[^\s<>"'()]+(?:\([^\s<>"']+\)|[^\s<>"'.,:;!?(){}[\]])/gi);
  if (!urlMatches) return null;

  for (const raw of urlMatches) {
    const candidate = cleanExtractedUrl(raw);
    if (!isInternalTelegramUrl(candidate)) {
      try {
        const u = new URL(candidate);
        if (u.protocol === "http:" || u.protocol === "https:") {
          return candidate;
        }
      } catch (_err) {
        // Continue to next match
        void _err;
      }
    }
  }

  return null;
}

/**
 * Decode common HTML entities into plain characters.
 */
export function decodeHtmlEntities(str: string): string {
  if (!str) return "";
  const entities: Record<string, string> = {
    "&amp;": "&",
    "&lt;": "<",
    "&gt;": ">",
    "&quot;": '"',
    "&#39;": "'",
    "&apos;": "'",
    "&nbsp;": " ",
    "&mdash;": "—",
    "&ndash;": "–",
    "&hellip;": "…",
    "&lsquo;": "‘",
    "&rsquo;": "’",
    "&ldquo;": "“",
    "&rdquo;": "”",
    "&copy;": "©",
    "&reg;": "®",
    "&trade;": "™",
  };

  let res = str.replace(
    /&(?:amp|lt|gt|quot|#39|apos|nbsp|mdash|ndash|hellip|lsquo|rsquo|ldquo|rdquo|copy|reg|trade);/gi,
    (m) => entities[m.toLowerCase()] || m
  );
  res = res.replace(/&#([0-9]+);/g, (_, num) => {
    try {
      return String.fromCharCode(parseInt(num, 10));
    } catch (_err) {
      void _err;
      return _;
    }
  });
  res = res.replace(/&#x([0-9a-f]+);/gi, (_, hex) => {
    try {
      return String.fromCharCode(parseInt(hex, 16));
    } catch (_err) {
      void _err;
      return _;
    }
  });
  return res;
}

/**
 * Escape characters for safe embedding in HTML templates.
 */
function escapeHtml(str: string): string {
  if (!str) return "";
  return str
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

/**
 * Clean and resolve URLs (relative to base URL).
 */
function resolveUrl(relativeUrl: string, baseUrl: string): string {
  try {
    return new URL(relativeUrl.trim(), baseUrl).href;
  } catch (_err) {
    void _err;
    return relativeUrl;
  }
}

/**
 * Validate outbound article URL against SSRF and unsupported protocols.
 */
export function validateArticleUrl(rawUrl: string): URL {
  let parsed: URL;
  try {
    parsed = new URL(rawUrl);
  } catch (_err) {
    void _err;
    throw new Error("Invalid URL format");
  }

  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new Error(`Unsupported URL protocol: ${parsed.protocol}`);
  }

  const host = parsed.hostname.toLowerCase();
  // Prevent local/internal address SSRF
  if (
    host === "localhost" ||
    host === "127.0.0.1" ||
    host === "0.0.0.0" ||
    host === "::1" ||
    host.endsWith(".local") ||
    /^10\./.test(host) ||
    /^192\.168\./.test(host) ||
    /^172\.(1[6-9]|2[0-9]|3[0-1])\./.test(host)
  ) {
    throw new Error("Internal or local network URLs cannot be ingested");
  }

  return parsed;
}

/**
 * Check if HTML content indicates a Cloudflare bot wall or challenge page.
 */
export function isCloudflareChallenge(html: string): boolean {
  if (!html) return false;
  return (
    html.includes("Just a moment...") ||
    html.includes("cf-browser-verification") ||
    html.includes("Attention Required! | Cloudflare") ||
    html.includes("challenge-running") ||
    html.includes("cf-turnstile") ||
    (html.includes("Cloudflare") && /Ray ID:/i.test(html))
  );
}

/**
 * Parse metadata header and body markdown returned by Jina Reader.
 */
export function parseJinaMarkdown(rawText: string, originalUrl: string): {
  title: string;
  url: string;
  publishedTime?: string;
  author?: string;
  bodyMarkdown: string;
} {
  let title = "";
  let url = originalUrl;
  let publishedTime = "";
  let author = "";
  let bodyMarkdown = rawText;

  const mdMarker = "Markdown Content:";
  const mdIndex = rawText.indexOf(mdMarker);

  if (mdIndex !== -1) {
    const header = rawText.substring(0, mdIndex);
    bodyMarkdown = rawText.substring(mdIndex + mdMarker.length).trim();

    const titleMatch = header.match(/^Title:\s*(.+)$/m);
    if (titleMatch) title = titleMatch[1].trim();

    const urlMatch = header.match(/^URL Source:\s*(.+)$/m);
    if (urlMatch) url = urlMatch[1].trim();

    const timeMatch = header.match(/^Published Time:\s*(.+)$/m);
    if (timeMatch) publishedTime = timeMatch[1].trim();

    const authorMatch = header.match(/^Author:\s*(.+)$/m);
    if (authorMatch) author = authorMatch[1].trim();
  }

  // If no title from header, check if first line of markdown is # Title
  if (!title) {
    const h1Match = bodyMarkdown.match(/^#\s+(.+)$/m);
    if (h1Match) {
      title = h1Match[1].trim();
    }
  }

  return { title, url, publishedTime, author, bodyMarkdown };
}

/**
 * Convert markdown to structured semantic HTML with Kindle-friendly formatting.
 */
export function markdownToHtml(md: string): string {
  if (!md) return "";
  let html = md.replace(/\r\n/g, "\n");

  // Code blocks: ```lang ... ```
  const codeBlocks: string[] = [];
  html = html.replace(/```([a-zA-Z0-9_-]*)\n([\s\S]*?)```/g, (_, _lang, code) => {
    const idx = codeBlocks.length;
    const escaped = code
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;");
    codeBlocks.push(`<pre><code>${escaped}</code></pre>`);
    return `\x01CODEBLOCK${idx}\x02`;
  });

  // Inline code: `...`
  const inlineCodes: string[] = [];
  html = html.replace(/`([^`\n]+)`/g, (_, code) => {
    const idx = inlineCodes.length;
    const escaped = code
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;");
    inlineCodes.push(`<code>${escaped}</code>`);
    return `\x01INLINECODE${idx}\x02`;
  });

  // Markdown tables
  const tableRegex = /^\|(.+)\|\r?\n\|[-:\s|]+\|\r?\n((?:\|.*\|\r?\n?)*)/gm;
  html = html.replace(tableRegex, (_, headerLine, rowsBlock) => {
    const headers = headerLine.split("|").map((h: string) => h.trim()).filter(Boolean);
    const ths = headers.map((h: string) => `<th>${h}</th>`).join("");
    const rows = rowsBlock.trim().split("\n").filter(Boolean);
    const trs = rows.map((row: string) => {
      const cells = row.split("|").map((c: string) => c.trim()).filter(Boolean);
      return `<tr>${cells.map((c: string) => `<td>${c}</td>`).join("")}</tr>`;
    }).join("");
    return `<table><thead><tr>${ths}</tr></thead><tbody>${trs}</tbody></table>\n\n`;
  });

  // Images: ![alt](url)
  html = html.replace(/!\[([^\]]*)\]\(([^)]+)\)/g, (_, alt, url) => {
    const safeAlt = alt ? alt.trim() : "";
    const safeUrl = url ? url.trim() : "";
    return `<figure><img src="${safeUrl}" alt="${safeAlt}" /><figcaption>${safeAlt}</figcaption></figure>`;
  });

  // Links: [text](url)
  html = html.replace(/\[([^\]]+)\]\(([^)]+)\)/g, `<a href="$2">$1</a>`);

  // Horizontal rules
  html = html.replace(/^(?:---|\*\*\*|___)\s*$/gm, "<hr />");

  // Headings
  html = html.replace(/^######\s+(.+)$/gm, "<h6>$1</h6>");
  html = html.replace(/^#####\s+(.+)$/gm, "<h5>$1</h5>");
  html = html.replace(/^####\s+(.+)$/gm, "<h4>$1</h4>");
  html = html.replace(/^###\s+(.+)$/gm, "<h3>$1</h3>");
  html = html.replace(/^##\s+(.+)$/gm, "<h2>$1</h2>");
  html = html.replace(/^#\s+(.+)$/gm, "<h1>$1</h1>");

  // Blockquotes
  html = html.replace(/^>\s*(.+)$/gm, "<blockquote><p>$1</p></blockquote>");
  html = html.replace(/<\/blockquote>\s*<blockquote>/g, "\n");

  // Bold & Italics
  html = html.replace(/\*\*\*([^*]+)\*\*\*/g, "<strong><em>$1</em></strong>");
  html = html.replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>");
  html = html.replace(/__([^_]+)__/g, "<strong>$1</strong>");
  html = html.replace(/\*([^*]+)\*/g, "<em>$1</em>");
  html = html.replace(/\b_([^_]+)_\b/g, "<em>$1</em>");

  // Lists
  html = html.replace(/^(\s*)[-*+]\s+(.+)$/gm, "<li>$2</li>");
  html = html.replace(/^(\s*)\d+\.\s+(.+)$/gm, "<li>$2</li>");
  html = html.replace(/((?:<li>.*<\/li>\n?)+)/g, "<ul>$1</ul>");

  // Normalize newlines around block tags for clean paragraph splitting
  html = html.replace(/(<(?:h[1-6]|ul|ol|blockquote|table|figure|hr)[^>]*>)/g, "\n\n$1");
  html = html.replace(/(<\/(?:h[1-6]|ul|ol|blockquote|table|figure)>|<hr\s*\/?>)/g, "$1\n\n");

  // Paragraphs
  const blocks = html.split(/\n\n+/);
  html = blocks.map((block) => {
    const trimmed = block.trim();
    if (!trimmed) return "";
    if (/^(<h[1-6]|<ul|<ol|<li|<blockquote|<pre|<figure|<hr|<table)/i.test(trimmed)) {
      return trimmed;
    }
    if (trimmed.startsWith("\x01CODEBLOCK")) return trimmed;
    return `<p>${trimmed.replace(/\n/g, "<br />")}</p>`;
  }).filter(Boolean).join("\n\n");

  // Restore code blocks and inline code
  html = html.replace(/\x01CODEBLOCK(\d+)\x02/g, (_, idx) => codeBlocks[Number(idx)]);
  html = html.replace(/\x01INLINECODE(\d+)\x02/g, (_, idx) => inlineCodes[Number(idx)]);

  return html;
}

export interface StyledDocumentOptions {
  title: string;
  author: string;
  siteName: string;
  url: string;
  publishedDate?: string;
  readTimeMinutes: number;
  wordCount: number;
  contentHtml: string;
}

/**
 * Build a complete Kindle-optimized serif HTML document.
 */
export function buildStyledHtmlDocument(opts: StyledDocumentOptions): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <title>${escapeHtml(opts.title)}</title>
  <meta name="author" content="${escapeHtml(opts.author)}">
  <meta name="description" content="Saved from ${escapeHtml(opts.url)}">
  <style>
    body {
      font-family: "Charter", "Georgia", "Iowan Old Style", "Palatino", serif;
      line-height: 1.6;
      margin: 4% 6%;
      color: #111;
    }
    h1.article-title {
      font-size: 1.8em;
      line-height: 1.25;
      margin-bottom: 0.3em;
      color: #000;
    }
    h2 { font-size: 1.35em; margin-top: 1.4em; margin-bottom: 0.4em; }
    h3 { font-size: 1.15em; margin-top: 1.2em; margin-bottom: 0.3em; }
    .article-meta {
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
      font-size: 0.85em;
      color: #555;
      padding-bottom: 0.8em;
      margin-bottom: 1.5em;
      border-bottom: 1px solid #ccc;
    }
    .article-meta p { margin: 0.25em 0; }
    .article-meta a { color: #0066cc; text-decoration: underline; }
    .article-content p {
      margin: 0 0 1.2em 0;
      text-align: justify;
      text-justify: inter-word;
    }
    .article-content img {
      max-width: 100%;
      height: auto;
      display: block;
      margin: 1.5em auto;
    }
    blockquote {
      margin: 1.5em 1em;
      padding-left: 1em;
      border-left: 3px solid #666;
      color: #444;
      font-style: italic;
    }
    pre, code {
      font-family: "Courier New", Courier, monospace;
      font-size: 0.9em;
      background: #f4f4f4;
    }
    pre {
      padding: 0.8em;
      overflow-x: auto;
      white-space: pre-wrap;
      word-break: break-all;
    }
    figure { margin: 1.5em 0; text-align: center; }
    figcaption { font-size: 0.85em; color: #666; margin-top: 0.4em; }
    table { border-collapse: collapse; width: 100%; margin: 1.5em 0; }
    th, td { border: 1px solid #ddd; padding: 0.4em 0.6em; text-align: left; }
    hr { border: none; border-top: 1px solid #ddd; margin: 1.5em 0; }
  </style>
</head>
<body>
  <header>
    <h1 class="article-title">${escapeHtml(opts.title)}</h1>
    <div class="article-meta">
      <p><strong>Author:</strong> ${escapeHtml(opts.author)} | <strong>Source:</strong> ${escapeHtml(opts.siteName)}</p>
      ${opts.publishedDate ? `<p><strong>Published:</strong> ${escapeHtml(opts.publishedDate)}</p>` : ""}
      <p><strong>Reading Time:</strong> ~${opts.readTimeMinutes} min (${opts.wordCount} words)</p>
      <p><a href="${escapeHtml(opts.url)}">Original Web Article</a></p>
    </div>
  </header>
  <div class="article-content">
    ${opts.contentHtml}
  </div>
</body>
</html>`;
}

/**
 * Fetch and extract article content using Jina Reader (r.jina.ai) as a fallback
 * for paywalls, Cloudflare bot-walls, or restricted content.
 */
export async function extractArticleViaJina(
  url: string,
  fallbackHostname?: string
): Promise<ExtractedArticle> {
  const jinaUrl = `https://r.jina.ai/${encodeURI(url)}`;
  console.log(`[Article] Fetching via Jina Reader: ${jinaUrl}`);

  let res: Response;
  try {
    res = await fetch(jinaUrl, {
      headers: {
        "X-Return-Format": "markdown",
        Accept: "text/markdown, text/plain, */*"
      },
      proxy: PROXY_URL,
      signal: AbortSignal.timeout(30000)
    } as any);
  } catch (err: any) {
    throw new Error(`Jina Reader connection failed: ${err.message}`);
  }

  if (!res.ok) {
    throw new Error(`Jina Reader fallback failed (HTTP ${res.status} ${res.statusText})`);
  }

  const rawMd = await res.text();
  if (!rawMd || rawMd.trim().length === 0) {
    throw new Error("Jina Reader returned empty response");
  }

  const parsed = parseJinaMarkdown(rawMd, url);
  const hostname =
    fallbackHostname ||
    (() => {
      try {
        return new URL(url).hostname.replace(/^www\./i, "");
      } catch (_err) {
        void _err;
        return "Web";
      }
    })();

  let title = cleanString(parsed.title);
  if (!title || title.length < 2) {
    title = `Article from ${hostname}`;
  }

  let author = cleanString(parsed.author);
  if (!author || author.toLowerCase() === "unknown" || author.length < 2) {
    author = hostname;
  }

  const siteName = hostname;
  let publishedDate = "";
  if (parsed.publishedTime) {
    try {
      const p = new Date(parsed.publishedTime);
      if (!isNaN(p.getTime())) {
        publishedDate = p.toLocaleDateString("en-US", { year: "numeric", month: "short", day: "numeric" });
      } else {
        publishedDate = parsed.publishedTime.split("T")[0];
      }
    } catch (_err) {
      void _err;
      publishedDate = parsed.publishedTime.split("T")[0];
    }
  }

  const cleanedHtml = markdownToHtml(parsed.bodyMarkdown);

  const textOnly = decodeHtmlEntities(cleanedHtml.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim());
  const wordCount = Math.max(1, textOnly.split(/\s+/).filter(Boolean).length);
  const readTimeMinutes = Math.max(1, Math.ceil(wordCount / 200));

  const styledDocument = buildStyledHtmlDocument({
    title,
    author,
    siteName,
    url,
    publishedDate,
    readTimeMinutes,
    wordCount,
    contentHtml: cleanedHtml
  });

  return {
    url,
    title,
    author,
    siteName,
    publishedDate,
    wordCount,
    readTimeMinutes,
    cleanedHtml,
    styledDocument
  };
}

/**
 * Execute HTTP request to fetch article web page with proxy routing.
 */
async function fetchArticlePage(validatedUrl: string): Promise<Response> {
  return await fetch(validatedUrl, {
    headers: {
      "User-Agent":
        "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36",
      Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8",
      "Accept-Language": "en-US,en;q=0.9",
      "Sec-Fetch-Dest": "document",
      "Sec-Fetch-Mode": "navigate",
      "Sec-Fetch-Site": "none",
      "Sec-Fetch-User": "?1",
      "Upgrade-Insecure-Requests": "1",
    },
    proxy: PROXY_URL,
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    redirect: "follow",
  } as any);
}

/**
 * Extract author or date from Schema.org JSON-LD scripts.
 */
function extractFromJsonLd(html: string): { author?: string; publishedDate?: string; title?: string } {
  const result: { author?: string; publishedDate?: string; title?: string } = {};
  const regex = /<script[^>]+type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi;
  let match: RegExpExecArray | null;

  while ((match = regex.exec(html)) !== null) {
    try {
      const data = JSON.parse(match[1].trim());
      const items = Array.isArray(data) ? data : data["@graph"] ? data["@graph"] : [data];

      for (const item of items) {
        if (!item || typeof item !== "object") continue;

        if (!result.title && item.headline && typeof item.headline === "string") {
          result.title = item.headline;
        }

        if (!result.publishedDate && item.datePublished && typeof item.datePublished === "string") {
          result.publishedDate = item.datePublished;
        }

        if (!result.author && item.author) {
          if (typeof item.author === "string") {
            result.author = item.author;
          } else if (Array.isArray(item.author) && item.author[0]) {
            result.author = typeof item.author[0] === "string" ? item.author[0] : item.author[0].name;
          } else if (typeof item.author === "object" && item.author.name) {
            result.author = item.author.name;
          }
        }
      }
    } catch (_err) {
      // Ignore unparseable or non-standard JSON-LD blocks
      void _err;
    }
  }

  return result;
}

/**
 * Fetch and extract article metadata and clean readable content from a URL.
 */
export async function extractArticle(rawUrlInput: string): Promise<ExtractedArticle> {
  const validated = validateArticleUrl(rawUrlInput);
  const validatedHref = validated.href;
  const hostname = validated.hostname.replace(/^www\./i, "");

  // 1. Fetch the page with standard browser headers and local proxy
  let res: Response;
  try {
    res = await fetchArticlePage(validatedHref);
  } catch (err: any) {
    if (err.name === "AbortError" || err.name === "TimeoutError") {
      console.log(`[Article] Direct fetch timed out, attempting Jina Reader fallback...`);
      return await extractArticleViaJina(validatedHref, hostname);
    }
    console.log(`[Article] Direct fetch error (${err.message}), attempting Jina Reader fallback...`);
    return await extractArticleViaJina(validatedHref, hostname);
  }

  if (res.status === 401 || res.status === 403) {
    console.log(`[Article] Direct fetch blocked (HTTP ${res.status}), attempting Jina Reader fallback...`);
    return await extractArticleViaJina(validatedHref, hostname);
  }
  if (res.status === 404) {
    throw new Error(`Article page not found (HTTP 404)`);
  }
  if (!res.ok) {
    console.log(`[Article] Direct fetch blocked (HTTP ${res.status}), attempting Jina Reader fallback...`);
    return await extractArticleViaJina(validatedHref, hostname);
  }

  const rawHtml = await res.text();
  if (!rawHtml || rawHtml.trim().length === 0) {
    console.log(`[Article] Direct fetch blocked (HTTP ${res.status} empty response), attempting Jina Reader fallback...`);
    return await extractArticleViaJina(validatedHref, hostname);
  }

  if (isCloudflareChallenge(rawHtml)) {
    console.log(`[Article] Direct fetch blocked (HTTP ${res.status} Cloudflare challenge), attempting Jina Reader fallback...`);
    return await extractArticleViaJina(validatedHref, hostname);
  }

  // 2. Extract Metadata (Title, Site Name, Author, Published Date)
  const jsonLd = extractFromJsonLd(rawHtml);

  // Site Name
  const ogSiteMatch = rawHtml.match(/<meta[^>]+property=["']og:site_name["'][^>]+content=["']([^"']+)["']/i);
  let siteName = cleanString(ogSiteMatch ? ogSiteMatch[1] : "");
  if (!siteName) {
    siteName = hostname;
  }

  // Title
  const ogTitleMatch = rawHtml.match(/<meta[^>]+property=["']og:title["'][^>]+content=["']([^"']+)["']/i);
  const twitterTitleMatch = rawHtml.match(/<meta[^>]+name=["']twitter:title["'][^>]+content=["']([^"']+)["']/i);
  const titleTagMatch = rawHtml.match(/<title[^>]*>([^<]+)<\/title>/i);
  const h1Match = rawHtml.match(/<h1[^>]*>([^<]+)<\/h1>/i);

  let rawTitle =
    jsonLd.title ||
    (ogTitleMatch ? ogTitleMatch[1] : "") ||
    (twitterTitleMatch ? twitterTitleMatch[1] : "") ||
    (titleTagMatch ? titleTagMatch[1] : "") ||
    (h1Match ? h1Match[1] : "");

  rawTitle = decodeHtmlEntities(rawTitle).trim();
  // Strip redundant site suffix if present (e.g. "My Title - Sam Altman" or "My Title | The Verge")
  if (siteName && rawTitle.toLowerCase().endsWith(siteName.toLowerCase())) {
    rawTitle = rawTitle.replace(new RegExp(`[-–—|:]\\s*${siteName}$`, "i"), "").trim();
  }
  let title = cleanString(rawTitle);
  if (!title || title.length < 2) {
    title = `Article from ${siteName}`;
  }

  // Author
  const metaAuthor = rawHtml.match(/<meta[^>]+name=["']author["'][^>]+content=["']([^"']+)["']/i);
  const articleAuthor = rawHtml.match(/<meta[^>]+property=["']article:author["'][^>]+content=["']([^"']+)["']/i);
  const twitterCreator = rawHtml.match(/<meta[^>]+name=["']twitter:creator["'][^>]+content=["']([^"']+)["']/i);
  const bylineMatch = rawHtml.match(/<(?:span|div|p|a)[^>]+class=["'][^"']*(?:author|byline)[^"']*["'][^>]*>([^<]+)<\//i);

  let rawAuthor =
    jsonLd.author ||
    (metaAuthor ? metaAuthor[1] : "") ||
    (articleAuthor ? articleAuthor[1] : "") ||
    (twitterCreator ? twitterCreator[1] : "") ||
    (bylineMatch ? bylineMatch[1] : "");

  rawAuthor = decodeHtmlEntities(rawAuthor).trim();
  let author = cleanString(rawAuthor);
  if (!author || author.toLowerCase() === "unknown" || author.length < 2) {
    author = siteName;
  }

  // Published Date
  const ogPubDate = rawHtml.match(/<meta[^>]+property=["']article:published_time["'][^>]+content=["']([^"']+)["']/i);
  const metaDate = rawHtml.match(/<meta[^>]+name=["'](?:date|pubdate)["'][^>]+content=["']([^"']+)["']/i);
  const timeMatch = rawHtml.match(/<time[^>]+datetime=["']([^"']+)["']/i);

  const rawDate = jsonLd.publishedDate || (ogPubDate ? ogPubDate[1] : "") || (metaDate ? metaDate[1] : "") || (timeMatch ? timeMatch[1] : "");
  let publishedDate = "";
  if (rawDate) {
    try {
      const parsed = new Date(rawDate);
      if (isNaN(parsed.getTime())) {
        publishedDate = rawDate.split("T")[0];
      } else {
        publishedDate = parsed.toLocaleDateString("en-US", { year: "numeric", month: "short", day: "numeric" });
      }
    } catch (_err) {
      void _err;
      publishedDate = rawDate.split("T")[0];
    }
  }

  // 3. Clean Article Body HTML
  // Remove intrusive clutter tags
  let workHtml = rawHtml;
  workHtml = workHtml.replace(/<!--[\s\S]*?-->/g, "");
  workHtml = workHtml.replace(/<script\b[^<]*(?:(?!<\/script>)<[^<]*)*<\/script>/gi, "");
  workHtml = workHtml.replace(/<style\b[^<]*(?:(?!<\/style>)<[^<]*)*<\/style>/gi, "");
  workHtml = workHtml.replace(/<noscript\b[^<]*(?:(?!<\/noscript>)<[^<]*)*<\/noscript>/gi, "");
  workHtml = workHtml.replace(/<iframe\b[^<]*(?:(?!<\/iframe>)<[^<]*)*<\/iframe>/gi, "");
  workHtml = workHtml.replace(/<svg\b[^<]*(?:(?!<\/svg>)<[^<]*)*<\/svg>/gi, "");
  workHtml = workHtml.replace(/<nav\b[^<]*(?:(?!<\/nav>)<[^<]*)*<\/nav>/gi, "");
  workHtml = workHtml.replace(/<header\b[^<]*(?:(?!<\/header>)<[^<]*)*<\/header>/gi, "");
  workHtml = workHtml.replace(/<footer\b[^<]*(?:(?!<\/footer>)<[^<]*)*<\/footer>/gi, "");
  workHtml = workHtml.replace(/<aside\b[^<]*(?:(?!<\/aside>)<[^<]*)*<\/aside>/gi, "");
  workHtml = workHtml.replace(/<form\b[^<]*(?:(?!<\/form>)<[^<]*)*<\/form>/gi, "");

  // Strip ad containers, social bars, comment sections, popups
  workHtml = workHtml.replace(
    /<(div|section|aside|ul|p)\b[^>]*(?:class|id)=["'][^"']*(?:ad-container|advertisement|banner|social-share|share-buttons|comments|sidebar|related-posts|cookie|popup|newsletter|subscribe)[^"']*["'][^>]*>[\s\S]*?<\/\1>/gi,
    ""
  );

  // Identify Best Article Container
  let candidateHtml = "";
  const articleMatches = workHtml.match(/<article\b[^>]*>([\s\S]*?)<\/article>/gi);
  if (articleMatches && articleMatches.length > 0) {
    // Pick longest article block
    candidateHtml = articleMatches.sort((a, b) => b.length - a.length)[0];
  }

  if (!candidateHtml || candidateHtml.replace(/<[^>]+>/g, "").trim().length < 150) {
    const mainMatch = workHtml.match(/<main\b[^>]*>([\s\S]*?)<\/main>/i);
    if (mainMatch && mainMatch[1].replace(/<[^>]+>/g, "").trim().length >= 150) {
      candidateHtml = mainMatch[1];
    }
  }

  if (!candidateHtml || candidateHtml.replace(/<[^>]+>/g, "").trim().length < 150) {
    const contentClassMatch = workHtml.match(
      /<div\b[^>]*class=["'][^"']*(?:article[-_]content|post[-_]content|entry[-_]content|story[-_]body|article[-_]body|post[-_]body|main[-_]content)[^"']*["'][^>]*>([\s\S]*?)<\/div>/i
    );
    if (contentClassMatch && contentClassMatch[1].replace(/<[^>]+>/g, "").trim().length >= 150) {
      candidateHtml = contentClassMatch[1];
    }
  }

  if (!candidateHtml || candidateHtml.replace(/<[^>]+>/g, "").trim().length < 100) {
    const bodyMatch = workHtml.match(/<body\b[^>]*>([\s\S]*?)<\/body>/i);
    candidateHtml = bodyMatch ? bodyMatch[1] : workHtml;
  }

  // Sanitize candidate tags & resolve URLs
  // Resolve relative URLs on images and links, support lazy-load data-src
  let cleaned = candidateHtml.replace(/<img\b([^>]*)>/gi, (_, attrs) => {
    let src = "";
    const srcMatch = attrs.match(/\bsrc=["']([^"']+)["']/i);
    const dataSrcMatch = attrs.match(/\b(?:data-src|data-original|data-lazy-src)=["']([^"']+)["']/i);
    const altMatch = attrs.match(/\balt=["']([^"']*)["']/i);

    if (dataSrcMatch && dataSrcMatch[1] && (!srcMatch || srcMatch[1].startsWith("data:") || srcMatch[1].length < 10)) {
      src = dataSrcMatch[1];
    } else if (srcMatch) {
      src = srcMatch[1];
    }

    if (!src || src.startsWith("data:")) return "";
    const fullSrc = resolveUrl(src, validatedHref);
    const alt = altMatch ? altMatch[1] : "";
    return `<img src="${escapeHtml(fullSrc)}" alt="${escapeHtml(alt)}" />`;
  });

  cleaned = cleaned.replace(/<a\b([^>]*)>/gi, (_, attrs) => {
    const hrefMatch = attrs.match(/\bhref=["']([^"']+)["']/i);
    if (!hrefMatch) return "<a>";
    const fullHref = resolveUrl(hrefMatch[1], validatedHref);
    return `<a href="${escapeHtml(fullHref)}">`;
  });

  // Strip inline styling and events
  cleaned = cleaned.replace(/\s+(?:style|class|onclick|onload|onerror|data-[a-z0-9_-]+)=["'][^"']*["']/gi, "");

  // Remove empty paragraphs and empty div tags
  cleaned = cleaned.replace(/<p\s*>\s*(&nbsp;|\s)*<\/p>/gi, "");
  cleaned = cleaned.replace(/<div\s*>\s*<\/div>/gi, "");

  // Calculate word count & reading time
  const textOnly = decodeHtmlEntities(cleaned.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim());
  const wordCount = Math.max(1, textOnly.split(/\s+/).filter(Boolean).length);
  const readTimeMinutes = Math.max(1, Math.ceil(wordCount / 200));

  // 4. Assemble clean styled HTML document (Kindle-optimized serif layout)
  const styledDocument = buildStyledHtmlDocument({
    title,
    author,
    siteName,
    url: validatedHref,
    publishedDate,
    readTimeMinutes,
    wordCount,
    contentHtml: cleaned,
  });

  return {
    url: validatedHref,
    title,
    author,
    siteName,
    publishedDate,
    wordCount,
    readTimeMinutes,
    cleanedHtml: cleaned,
    styledDocument,
  };
}

/**
 * Execute ebook-convert without inheriting proxy environment variables.
 */
function runEbookConvert(args: string[]) {
  const env = { ...process.env };
  delete env.HTTP_PROXY;
  delete env.http_proxy;
  delete env.HTTPS_PROXY;
  delete env.https_proxy;
  delete env.ALL_PROXY;
  delete env.all_proxy;
  env.PATH = "/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:" + (env.PATH || "");

  return spawnSync(EBOOK_CONVERT_PATH, args, {
    encoding: "utf8",
    env,
    maxBuffer: 20 * 1024 * 1024,
    timeout: 60000,
  });
}

/**
 * Execute calibredb without inheriting proxy environment variables.
 */
function runCalibredb(args: string[]) {
  const env = { ...process.env };
  delete env.HTTP_PROXY;
  delete env.http_proxy;
  delete env.HTTPS_PROXY;
  delete env.https_proxy;
  delete env.ALL_PROXY;
  delete env.all_proxy;
  env.PATH = "/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:" + (env.PATH || "");

  return spawnSync(CALIBREDB_PATH, args, {
    encoding: "utf8",
    env,
    timeout: 30000,
  });
}

/**
 * Convert an HTML document string to EPUB format using ebook-convert.
 */
export function convertHtmlToEpub(
  htmlContent: string,
  title: string,
  author: string,
  siteName: string,
  sourceUrl?: string
): string {
  const randomSuffix = `${Date.now()}_${crypto.randomBytes(4).toString("hex")}`;
  const tempHtml = `/tmp/article_${randomSuffix}.html`;
  const tempEpub = `/tmp/article_${randomSuffix}.epub`;

  try {
    fs.writeFileSync(tempHtml, htmlContent, "utf8");

    const tags = ["Web Article", "Read Later", siteName].filter(Boolean).join(",");
    const comments = sourceUrl ? `Saved from ${sourceUrl}` : `Web article from ${siteName}`;

    const convertRes = runEbookConvert([
      tempHtml,
      tempEpub,
      "--output-profile",
      "kindle",
      "--title",
      title,
      "--authors",
      author,
      "--tags",
      tags,
      "--comments",
      comments,
      "--dont-split-on-page-breaks",
      "--no-default-epub-cover",
    ]);

    if (convertRes.status !== 0 || !fs.existsSync(tempEpub)) {
      const err = convertRes.stderr || convertRes.stdout || "ebook-convert returned non-zero exit code";
      throw new Error(`EPUB conversion failed: ${err}`);
    }

    return tempEpub;
  } finally {
    if (fs.existsSync(tempHtml)) {
      try {
        fs.unlinkSync(tempHtml);
      } catch (_err) {
        void _err;
      }
    }
  }
}

/**
 * Ingest an article URL end-to-end:
 * 1. Fetch & extract article content
 * 2. Generate clean styled EPUB via ebook-convert
 * 3. Save EPUB to Books_Drop directory
 * 4. Ingest into Calibre database with proper metadata and tags
 */
export async function ingestArticleFromUrl(targetUrl: string): Promise<IngestArticleResult> {
  // 1. Extraction
  const article = await extractArticle(targetUrl);

  // 2. EPUB Conversion
  const tempEpub = convertHtmlToEpub(
    article.styledDocument,
    article.title,
    article.author,
    article.siteName,
    article.url
  );

  // 3. Save to Books_Drop with sanitized filename
  const safeFilenameBase = cleanString(article.title)
    .replace(/[^a-zA-Z0-9_\u00A0-\uFFFF -]/g, "")
    .replace(/\s+/g, "_")
    .substring(0, 60)
    .trim() || "Web_Article";
  const dropFileName = `${safeFilenameBase}_${Date.now()}.epub`;
  const dropFilePath = path.join(DROP_DIR, dropFileName);

  fs.copyFileSync(tempEpub, dropFilePath);
  try {
    fs.unlinkSync(tempEpub);
  } catch (_err) {
    void _err;
  }

  // 4. Ingest into Calibre via calibredb
  const tagsStr = ["Web Article", "Read Later", article.siteName].filter(Boolean).join(",");
  const addRes = runCalibredb([
    "add",
    dropFilePath,
    "--with-library",
    SERVER_URL,
    "--title",
    article.title,
    "--authors",
    article.author,
    "--tags",
    tagsStr,
    "--automerge",
    "ignore",
  ]);

  let bookId: number | null = null;
  let isDuplicate = false;

  if (addRes.status === 0) {
    const match = addRes.stdout?.match(/Added book ids?:?\s*([0-9]+)/i);
    if (match) {
      bookId = parseInt(match[1], 10);
    }
  }

  // If bookId not returned directly, search by title to link book record
  if (!bookId) {
    const listRes = runCalibredb([
      "list",
      "--with-library",
      SERVER_URL,
      "--search",
      `title:"=${article.title}"`,
      "--fields",
      "id,title,authors",
      "--for-machine",
    ]);

    if (listRes.status === 0 && listRes.stdout) {
      try {
        const parsed = JSON.parse(listRes.stdout.trim());
        if (Array.isArray(parsed) && parsed.length > 0) {
          bookId = parsed[0].id;
          isDuplicate = true;
        }
      } catch (_err) {
        void _err;
      }
    }
  }

  return {
    success: true,
    duplicate: isDuplicate,
    bookId,
    title: article.title,
    authors: article.author,
    siteName: article.siteName,
    wordCount: article.wordCount,
    readTimeMinutes: article.readTimeMinutes,
    epubPath: dropFilePath,
    format: "EPUB",
    message: isDuplicate
      ? `Article already exists in Calibre (ID: ${bookId})`
      : `Successfully ingested "${article.title}" into library`,
  };
}
