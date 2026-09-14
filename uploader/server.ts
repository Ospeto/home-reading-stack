import { Database } from "bun:sqlite";
import crypto from "node:crypto";
import { Buffer } from "node:buffer";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { searchUniversalMetadata, applyMetadataToCalibre } from "./scraper";
import { isArchiveFile, unpackArchive } from "./archive";
import { ingestArticleFromUrl, generateTypographicCover } from "./article";

const DROP_DIR = "/Users/ospeto/Books_Drop";
const SERVER_URL = "http://127.0.0.1:8088";
const LIBRARY_DIR = "/Users/ospeto/Calibre Libraries/Agent Library";
const KOSYNC_DB_PATH = "/Users/ospeto/kosync-server/data/koreader-sync.db";
const CACHE_DB_PATH = "/Users/ospeto/uploader/cache.db";
const COVER_CACHE_DIR = "/Users/ospeto/uploader/cache/covers";

if (!fs.existsSync(COVER_CACHE_DIR)) {
  fs.mkdirSync(COVER_CACHE_DIR, { recursive: true });
}
function resolveHtmlPath(): string {
  try {
    const dir = path.dirname(new URL(import.meta.url).pathname);
    const localPath = path.join(dir, "index.html");
    if (fs.existsSync(localPath)) return localPath;
  } catch {
    // Fall back to default location
  }
  return "/Users/ospeto/uploader/index.html";
}

const HTML_PATH = resolveHtmlPath();

if (!fs.existsSync(DROP_DIR)) {
  fs.mkdirSync(DROP_DIR, { recursive: true });
}

// Initialize SQLite Cache Database for Fast Hash & Metadata Lookups
const cacheDb = new Database(CACHE_DB_PATH);
cacheDb.run("PRAGMA busy_timeout = 5000;");
cacheDb.run(`
  CREATE TABLE IF NOT EXISTS file_hashes (
    filepath TEXT PRIMARY KEY,
    mtime INTEGER NOT NULL,
    hash TEXT NOT NULL,
    book_id INTEGER,
    title TEXT,
    authors TEXT,
    cover INTEGER
  );
`);
cacheDb.run(`CREATE INDEX IF NOT EXISTS idx_file_hashes_hash ON file_hashes(hash);`);


function getKOReaderBinary256(filePath: string): string | null {
  try {
    const stats = fs.statSync(filePath);
    const fd = fs.openSync(filePath, "r");
    const md5 = crypto.createHash("md5");
    const size = 1024;
    for (let i = -1; i <= 10; i++) {
      const offset = i === -1 ? 256 : 1024 * 4 ** i;
      if (offset >= stats.size) break;
      const buf = Buffer.alloc(size);
      const bytesRead = fs.readSync(fd, buf, 0, size, offset);
      if (bytesRead > 0) md5.update(buf.subarray(0, bytesRead));
    }
    fs.closeSync(fd);
    return md5.digest("hex");
  } catch {
    return null;
  }
}

function getKOReaderPartial512(filePath: string): string | null {
  try {
    const stats = fs.statSync(filePath);
    const fd = fs.openSync(filePath, "r");
    const md5 = crypto.createHash("md5");
    let offset = 512;
    const buf = Buffer.alloc(1024);
    while (offset < stats.size) {
      const bytesRead = fs.readSync(fd, buf, 0, 1024, offset);
      if (bytesRead > 0) md5.update(buf.subarray(0, bytesRead));
      offset *= 4;
    }
    fs.closeSync(fd);
    return md5.digest("hex");
  } catch {
    return null;
  }
}

function getFilenameMD5(name: string): string {
  return crypto.createHash("md5").update(name).digest("hex");
}


function cleanString(str: string): string {
  if (!str) return "";
  let s = str;
  s = s.replace(/https?:\/\/\S+/gi, " ");
  s = s.replace(/t\.me\/\S+/gi, " ");
  s = s.replace(/@\w+/gi, " ");
  s = s.replace(/www\.\S+/gi, " ");
  s = s.replace(/\[.*?(ebook|pdf|epub|channel|mobi|azw|scan|myanmar|tg|bookr).*?\]/gi, " ");
  s = s.replace(/\((.*?)(ebook|pdf|epub|channel|mobi|azw|scan|myanmar|tg|bookr)(.*?)\)/gi, " ");
  s = s.replace(/_v[0-9]+/gi, " ");
  s = s.replace(/\([0-9]+\)$/g, " ");
  s = s.replace(/\b(epub|pdf|mobi|azw3)\b/gi, " ");
  s = s.replace(/[_\s]+/g, " ").trim();
  s = s.replace(/^[-–—\s]+|[-–—\s]+$/g, "").trim();
  return s;
}


function extractSeries(title: string, filename?: string): { series: string; volume: number } | null {
  const candidates = [title, filename ? path.basename(filename, path.extname(filename)) : ""].filter(Boolean);

  const patterns = [
    /^(.*?)[,_\s-]+(?:vol(?:ume)?|v)\.?\s*(\d+(?:\.\d+)?)(?:[\s-–—:].*)?$/i,
    /^(.*?)[,_\s-]+(?:book|bk)\.?\s*(\d+(?:\.\d+)?)(?:[\s-–—:].*)?$/i,
    /^(.*?)[,_\s-]+#\s*(\d+(?:\.\d+)?)(?:[\s-–—:].*)?$/i,
    /^(.*?)[,_\s-]+(?:part|pt)\.?\s*(\d+(?:\.\d+)?)(?:[\s-–—:].*)?$/i
  ];

  for (const str of candidates) {
    for (const p of patterns) {
      const m = str.match(p);
      if (m) {
        const series = cleanString(m[1]).replace(/[,_–—:-]+$/, "").trim();
        const vol = parseFloat(m[2]);
        if (series.length >= 2 && !isNaN(vol)) {
          return { series, volume: vol };
        }
      }
    }
  }
  return null;
}

function sanitizeMetadata(rawTitle: string, rawAuthors: string, rawTags: string[], filename?: string) {
  let title = cleanString(rawTitle);
  let author = cleanString(rawAuthors);
  const tags = (rawTags || []).map(cleanString).filter(t => t && !/http|t\.me|channel|\.com|\.org|download|share|thebookr/i.test(t) && t.length < 30);

  const isAuthorJunk = !author || /http|t\.me|channel|admin|unknown|\.com|\.org|thebookr/i.test(author);

  if ((!title || isAuthorJunk) && filename) {
    const base = path.basename(filename, path.extname(filename));
    const parts = base.split(/[-–—]/).map(cleanString).filter(Boolean);
    if (parts.length >= 2) {
      if (!title || title.length < 3) title = parts[1] || parts[0];
      if (isAuthorJunk) author = parts[0] || "Unknown";
    } else {
      if (!title || title.length < 3) title = base;
      if (isAuthorJunk) author = "Unknown";
    }
  }

  return { title: cleanString(title), author: cleanString(author), tags };
}


function safeParseJson(str: string): any {
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
  } catch (_err) {
    void _err;
    return null;
  }
}

let calibreBooksCache: { books: any[]; timestamp: number } = { books: [], timestamp: 0 };

function runCalibredb(args: string[]) {
  const env = { ...process.env };
  delete env.HTTP_PROXY;
  delete env.http_proxy;
  delete env.HTTPS_PROXY;
  delete env.https_proxy;
  delete env.ALL_PROXY;
  delete env.all_proxy;
  env.PATH = "/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:" + (env.PATH || "");

  return spawnSync("/opt/homebrew/bin/calibredb", args, {
    encoding: "utf8",
    env,
    timeout: 30000,
  });
}

function getCalibreBooks(forceFresh = false) {
  const now = Date.now();
  if (!forceFresh && calibreBooksCache.books.length > 0 && (now - calibreBooksCache.timestamp < 10000)) {
    return calibreBooksCache.books;
  }

  try {
    const res = runCalibredb([
      "list",
      "--with-library",
      SERVER_URL,
      "--fields",
      "id,title,authors,formats,cover,tags,series,series_index,publisher,pubdate,comments,rating",
      "--for-machine"
    ]);
    if (res.status === 0 && res.stdout) {
      const parsed = safeParseJson(res.stdout);
      calibreBooksCache = { books: parsed, timestamp: now };
      return parsed;
    }
  } catch (e) {
    console.error("Error listing calibre books:", e);
  }
  return calibreBooksCache.books || [];
}

function getCalibreHashMap() {
  const map: Record<string, { id: number; title: string; authors: string; cover: boolean }> = {};
  const books = getCalibreBooks();

  // Load all pre-cached hashes from cacheDb into map for instant O(1) lookup
  try {
    const allCached = cacheDb.query("SELECT hash, book_id, title, authors, cover FROM file_hashes").all() as any[];
    for (const row of allCached) {
      if (row.hash) {
        map[row.hash] = {
          id: row.book_id,
          title: row.title,
          authors: row.authors || "Unknown",
          cover: !!row.cover
        };
      }
    }
  } catch (e) {
    void e;
  }

  const selectStmt = cacheDb.prepare("SELECT hash FROM file_hashes WHERE filepath = ? AND mtime = ?");
  const insertStmt = cacheDb.prepare("INSERT OR REPLACE INTO file_hashes (filepath, mtime, hash, book_id, title, authors, cover) VALUES (?, ?, ?, ?, ?, ?, ?)");

  function scanDir(dir: string) {
    try {
      const entries = fs.readdirSync(dir, { withFileTypes: true });
      for (const e of entries) {
        const full = path.join(dir, e.name);
        if (e.isDirectory()) {
          scanDir(full);
        } else if (e.name.endsWith(".epub") || e.name.endsWith(".pdf") || e.name.endsWith(".mobi") || e.name.endsWith(".azw3") || e.name.endsWith(".cbz")) {
          const stat = fs.statSync(full);
          const mtime = Math.floor(stat.mtimeMs);

          const cached = selectStmt.get(full + "#bin256", mtime) as any;
          if (!cached) {
            // New or modified file: compute all 4 hash variants
            const parentDir = path.basename(path.dirname(full));
            const bookMatch = books.find((b: any) =>
              parentDir.includes(`(${b.id})`) ||
              b.title.toLowerCase().includes(path.basename(e.name, path.extname(e.name)).toLowerCase()) ||
              e.name.toLowerCase().includes(b.title.toLowerCase())
            );
            const bId = bookMatch ? bookMatch.id : null;
            const bTitle = bookMatch ? bookMatch.title : path.basename(e.name, path.extname(e.name));
            const bAuthors = bookMatch ? (bookMatch.authors || "Unknown") : "Unknown";
            const bCover = bookMatch ? (bookMatch.cover ? 1 : 0) : 0;

            const h1 = getKOReaderBinary256(full);
            const h2 = getKOReaderPartial512(full);
            const h3 = getFilenameMD5(e.name);
            const h4 = getFilenameMD5(bTitle + ".epub");

            const hashSet = new Set([h1, h2, h3, h4].filter(Boolean) as string[]);
            for (const h of hashSet) {
              insertStmt.run(full + "#" + h, mtime, h, bId, bTitle, bAuthors, bCover);
              map[h] = { id: bId, title: bTitle, authors: bAuthors, cover: !!bCover };
            }
          }
        }
      }
    } catch (e) {
      void e;
    }
  }

  scanDir(LIBRARY_DIR);
  return { map, books };
}

function ingestBookFile(filePath: string, originalFileName: string) {
  const books = getCalibreBooks(true);
  const format = path.extname(originalFileName).replace(".", "").toUpperCase();
  const fileHash = getKOReaderBinary256(filePath);

  // 1. Check if exact hash exists in Calibre Library
  const { map } = getCalibreHashMap();
  if (fileHash && map[fileHash]) {
    const existing = map[fileHash];
    return {
      success: true,
      duplicate: true,
      bookId: existing.id,
      message: `Book "${existing.title}" is already in your library.`
    };
  }

  // 2. Check if normalized title already exists
  const sanitized = sanitizeMetadata("", "", [], originalFileName);
  const incomingSeries = extractSeries(sanitized.title, originalFileName);

  const existingBook = books.find((b: any) => {
    const bTitle = cleanString(b.title).toLowerCase();
    const sTitle = sanitized.title.toLowerCase();

    const bSeries = extractSeries(b.title, "");
    const bActualSeries = b.series ? { series: cleanString(b.series), volume: b.series_index || 1 } : bSeries;

    if (incomingSeries && bActualSeries) {
      if (cleanString(incomingSeries.series).toLowerCase() === cleanString(bActualSeries.series).toLowerCase()) {
        return incomingSeries.volume === bActualSeries.volume;
      }
    } else if (incomingSeries || bActualSeries) {
      return false;
    }

    return bTitle === sTitle || (sTitle.length > 5 && (bTitle === sTitle || bTitle.startsWith(sTitle) || sTitle.startsWith(bTitle)));
  });

  if (existingBook) {
    const existingFormats = (existingBook.formats || []).map((f: string) => f.toUpperCase());
    if (existingFormats.includes(format)) {
      return {
        success: true,
        duplicate: true,
        bookId: existingBook.id,
        message: `Book "${existingBook.title}" already exists in format ${format}.`
      };
    } else {
      runCalibredb([
        "add_format",
        String(existingBook.id),
        filePath,
        "--with-library",
        SERVER_URL
      ]);

      getCalibreBooks(true);
      return {
        success: true,
        duplicate: false,
        attachedFormat: true,
        bookId: existingBook.id,
        message: `Attached ${format} format to existing book "${existingBook.title}".`
      };
    }
  }

  // 3. Brand new book: Add to Calibre
  const addRes = runCalibredb([
    "add",
    filePath,
    "--with-library",
    SERVER_URL
  ]);

  if (addRes.status === 0) {
    const match = addRes.stdout?.match(/Added book ids?:?\s*([0-9]+)/i);
    const newId = match ? parseInt(match[1]) : null;

    if (newId) {
      const freshBooks = getCalibreBooks(true);
      const newBook = freshBooks.find((b: any) => b.id === newId);
      if (newBook) {
        const clean = sanitizeMetadata(newBook.title, newBook.authors, newBook.tags, originalFileName);
        const setArgs = ["set_metadata", String(newId), "--with-library", SERVER_URL];
        if (clean.title && clean.title !== newBook.title) setArgs.push("--field", `title:${clean.title}`);
        if (clean.author && clean.author !== newBook.authors) setArgs.push("--field", `authors:${clean.author}`);
        if (clean.tags) setArgs.push("--field", `tags:${clean.tags.join(",")}`);
        if (!newBook.series && incomingSeries) {
          setArgs.push("--field", `series:${incomingSeries.series}`);
          setArgs.push("--field", `series_index:${incomingSeries.volume}`);
        }
        if (setArgs.length > 4) {
          runCalibredb(setArgs);
        }

        // Auto-Scraper Background Enrichment
        setTimeout(async () => {
          try {
            const isManga = format === "CBZ" || format === "CBR" || (clean.tags || []).some(t => /manga|comic/i.test(t));
            console.log(`[AutoScraper] Background enrichment for book ID ${newId} ("${clean.title}")...`);
            const matches = await searchUniversalMetadata(clean.title, isManga);
            if (matches.length > 0) {
              const top = matches[0];
              console.log(`[AutoScraper] Top match: "${top.title}" by "${top.authors}" (Confidence: ${top.confidence}, Source: ${top.source})`);
              if (top.confidence >= 0.85) {
                await applyMetadataToCalibre(newId, top);
                console.log(`[AutoScraper] Auto-applied metadata & cover to book ID ${newId}`);
                getCalibreBooks(true);
              } else {
                console.log(`[AutoScraper] Match confidence ${top.confidence} < 0.85. Kept local title.`);
              }
            }
          } catch (err) {
            console.error(`[AutoScraper] Failed for ID ${newId}:`, err);
          }
        }, 200);
      }
    }

    return {
      success: true,
      duplicate: false,
      bookId: newId,
      message: `Added "${sanitized.title}" to library`
    };
  } else {
    return {
      success: false,
      error: addRes.stderr || "Failed to add book"
    };
  }
}

function getKosyncProgress() {
  try {
    if (fs.existsSync(KOSYNC_DB_PATH)) {
      const db = new Database(KOSYNC_DB_PATH);
      const rows = db.query(
        "SELECT id, document, progress, percentage, device, device_id, filename, title, authors, timestamp FROM progress ORDER BY timestamp DESC LIMIT 50;"
      ).all() as any[];

      const { map, books } = getCalibreHashMap();

      const norm = (s: string) => (s || "").toLowerCase().replace(/[\p{P}\p{S}\s]+/gu, "");

      return rows.map((r) => {
        let displayTitle = r.title || r.filename;
        let displayAuthors = r.authors;
        let bookId: number | null = null;
        let cover: boolean = false;

        if (map[r.document]) {
          displayTitle = map[r.document].title;
          displayAuthors = map[r.document].authors;
          bookId = map[r.document].id;
          cover = map[r.document].cover;
        }

        if (!bookId && (r.title || r.filename)) {
          const searchNorm = norm(r.title || r.filename);
          const bookMatch = books.find((b: any) => {
            const bNorm = norm(b.title);
            return bNorm === searchNorm || (searchNorm.length > 5 && (bNorm.includes(searchNorm) || searchNorm.includes(bNorm)));
          });
          if (bookMatch) {
            bookId = bookMatch.id;
            cover = !!bookMatch.cover;
            displayTitle = bookMatch.title;
            displayAuthors = bookMatch.authors || displayAuthors;
          }
        }

        if (!bookId) {
          try {
            const alias = db.query(
              "SELECT canonical_id, normalized_title, normalized_authors FROM document_aliases WHERE document_hash = ?"
            ).get(r.document) as any;

            if (alias) {
              const aliasNorm = norm(alias.normalized_title);
              const bookMatch = books.find((b: any) => norm(b.title) === aliasNorm);
              if (bookMatch) {
                bookId = bookMatch.id;
                cover = !!bookMatch.cover;
                displayTitle = bookMatch.title;
                displayAuthors = bookMatch.authors || displayAuthors;
              } else {
                displayTitle = alias.normalized_title;
                displayAuthors = alias.normalized_authors || "Unknown Author";
              }
            }
          } catch (e) {
            void e;
          }
        }

        if (!displayTitle) {
          const match = books.find((b: any) => cleanString(b.title).toLowerCase() === cleanString(r.filename || "").toLowerCase());
          if (match) {
            displayTitle = match.title;
            displayAuthors = match.authors;
            bookId = match.id;
            cover = !!match.cover;
          } else {
            displayTitle = "Active Reading Session";
            displayAuthors = "KOReader Document";
          }
        }

        if (displayTitle) {
          displayTitle = cleanString(displayTitle);
          if (displayTitle.endsWith(".epub")) {
            displayTitle = displayTitle.replace(/\.epub$/i, "");
          }
        }

        return {
          ...r,
          displayTitle,
          displayAuthors: cleanString(displayAuthors) || "Unknown Author",
          bookId,
          cover
        };
      });
    }
  } catch (e) {
    console.error("Error reading kosync db:", e);
  }
  return [];
}

// Helper: Parse KOReader Lua .sdr metadata files for real bookmarks & highlights
function extractHighlightsFromSdr(bookId: number): Array<{ text: string; notes: string; datetime: string; page?: number }> {
  const highlights: Array<{ text: string; notes: string; datetime: string; page?: number }> = [];
  try {
    const books = getCalibreBooks();
    const book = books.find((b: any) => b.id === bookId);
    if (!book) return highlights;

    // Search inside Library Directory for matching .sdr folder
    function searchSdr(dir: string) {
      const entries = fs.readdirSync(dir, { withFileTypes: true });
      for (const e of entries) {
        const full = path.join(dir, e.name);
        if (e.isDirectory()) {
          if (e.name.endsWith(".sdr")) {
            // Found an SDR directory!
            const files = fs.readdirSync(full);
            for (const f of files) {
              if (f.endsWith(".lua")) {
                const luaContent = fs.readFileSync(path.join(full, f), "utf8");
                // Extract bookmark tables using regex
                const bookmarkMatches = luaContent.matchAll(/\{[^}]*\["text"\]\s*=\s*"([^"]*)"[^}]*\}/gs);
                for (const bm of bookmarkMatches) {
                  const chunk = bm[0];
                  const textMatch = chunk.match(/\["text"\]\s*=\s*"([^"]*)"/);
                  const notesMatch = chunk.match(/\["notes"\]\s*=\s*"([^"]*)"/);
                  const dtMatch = chunk.match(/\["datetime"\]\s*=\s*"([^"]*)"/);
                  const pageMatch = chunk.match(/\["page"\]\s*=\s*([0-9]+)/);

                  if (textMatch && textMatch[1]) {
                    highlights.push({
                      text: textMatch[1].replace(/\\"/g, '"').replace(/\\n/g, ' '),
                      notes: notesMatch ? notesMatch[1] : "",
                      datetime: dtMatch ? dtMatch[1] : new Date().toISOString(),
                      page: pageMatch ? parseInt(pageMatch[1]) : undefined
                    });
                  }
                }
              }
            }
          } else {
            searchSdr(full);
          }
        }
      }
    }

    searchSdr(LIBRARY_DIR);
  } catch (e) {
    console.error("Error extracting SDR highlights:", e);
  }
  return highlights;
}

// Helper: Extra Metadata Scrapers (Google Books, OpenLibrary, Douban/Search)
export async function searchAllBookSources(query: string) {
  const results: any[] = [];
  const cleanQ = cleanString(query);

  // 1. Google Books
  try {
    const gRes = await fetch(`https://www.googleapis.com/books/v1/volumes?q=${encodeURIComponent(cleanQ)}&maxResults=5`);
    if (gRes.ok) {
      const data = await gRes.json();
      if (data.items) {
        for (const item of data.items) {
          const info = item.volumeInfo || {};
          let cover = info.imageLinks?.extraLarge || info.imageLinks?.large || info.imageLinks?.medium || info.imageLinks?.thumbnail || "";
          if (cover) cover = cover.replace("http://", "https://").replace("&edge=curl", "");

          results.push({
            title: cleanString(info.title || ""),
            authors: (info.authors || []).map(cleanString).join(", "),
            publisher: cleanString(info.publisher || ""),
            publishedDate: info.publishedDate || "",
            description: info.description || "",
            coverUrl: cover,
            tags: (info.categories || []).map(cleanString).filter(Boolean),
            pageCount: info.pageCount || null,
            source: "Google Books"
          });
        }
      }
    }
  } catch (e) {
    void e;
  }

  // 2. OpenLibrary
  try {
    const olRes = await fetch(`https://openlibrary.org/search.json?q=${encodeURIComponent(cleanQ)}&limit=5`);
    if (olRes.ok) {
      const data = await olRes.json();
      if (data.docs) {
        for (const doc of data.docs) {
          const coverId = doc.cover_i;
          results.push({
            title: cleanString(doc.title || ""),
            authors: (doc.author_name || []).map(cleanString).join(", "),
            publisher: cleanString((doc.publisher || [])[0] || ""),
            publishedDate: doc.first_publish_year ? String(doc.first_publish_year) : "",
            description: Array.isArray(doc.first_sentence) ? doc.first_sentence[0] : (doc.first_sentence || ""),
            coverUrl: coverId ? `https://covers.openlibrary.org/b/id/${coverId}-L.jpg` : "",
            tags: (doc.subject ? doc.subject.slice(0, 4) : []).map(cleanString).filter(Boolean),
            pageCount: doc.number_of_pages_median || null,
            source: "OpenLibrary"
          });
        }
      }
    }
  } catch (e) {
    void e;
  }

  return results;
}

function jsonResponse(data: any, status = 200, origin = "*") {
  const corsOrigin = origin === "*" ? "*" : origin;
  return Response.json(data, {
    status,
    headers: {
      "Access-Control-Allow-Origin": corsOrigin,
      "Access-Control-Allow-Methods": "GET, POST, PUT, DELETE, OPTIONS",
      "Access-Control-Allow-Headers": "*",
      "Cache-Control": "no-store, no-cache, must-revalidate, proxy-revalidate",
      "Pragma": "no-cache",
      "Expires": "0"
    }
  });
}

Bun.serve({
  port: 8086,
  hostname: "0.0.0.0",
  async fetch(req: Request) {
    const origin = req.headers.get("origin") || "*";
    if (req.method === "OPTIONS") {
      return new Response(null, {
        headers: {
          "Access-Control-Allow-Origin": origin,
          "Access-Control-Allow-Methods": "GET, POST, PUT, DELETE, OPTIONS",
          "Access-Control-Allow-Headers": "*",
        }
      });
    }

    let url: URL;
    try {
      url = new URL(req.url);
    } catch (_err) {
      void _err;
      return new Response("Bad Request", { status: 400 });
    }

    // API: List books
    if (url.pathname === "/api/books" && req.method === "GET") {
      const books = getCalibreBooks();
      return jsonResponse(books);
    }

    // API: Library Facets
    if (url.pathname === "/api/library/facets" && req.method === "GET") {
      const books = getCalibreBooks();
      const authorMap: Record<string, number> = {};
      const seriesMap: Record<string, number> = {};
      const tagMap: Record<string, number> = {};
      const formatMap: Record<string, number> = {};

      for (const b of books) {
        if (b.authors) {
          const auths = b.authors.split("&").map((a: string) => cleanString(a)).filter(Boolean);
          for (const a of auths) authorMap[a] = (authorMap[a] || 0) + 1;
        }
        if (b.series) {
          const s = cleanString(b.series);
          seriesMap[s] = (seriesMap[s] || 0) + 1;
        }
        if (b.tags && Array.isArray(b.tags)) {
          for (const t of b.tags) {
            const cleanT = cleanString(t);
            if (cleanT && !/http|t\.me|thebookr/i.test(cleanT)) tagMap[cleanT] = (tagMap[cleanT] || 0) + 1;
          }
        }
        if (b.formats && Array.isArray(b.formats)) {
          for (const f of b.formats) {
            if (f) formatMap[f] = (formatMap[f] || 0) + 1;
          }
        }
      }

      return jsonResponse({
        totalBooks: books.length,
        authors: Object.entries(authorMap).map(([name, count]) => ({ name, count })).sort((a, b) => b.count - a.count),
        series: Object.entries(seriesMap).map(([name, count]) => ({ name, count })).sort((a, b) => b.count - a.count),
        tags: Object.entries(tagMap).map(([name, count]) => ({ name, count })).sort((a, b) => b.count - a.count),
        formats: Object.entries(formatMap).map(([name, count]) => ({ name, count })).sort((a, b) => b.count - a.count)
      });
    }

    // API: Book Cover Proxy & Native Downscaled Thumbnail Cache
    if (url.pathname.startsWith("/api/books/") && url.pathname.endsWith("/cover")) {
      const parts = url.pathname.split("/");
      const bookId = parts[3];
      const widthParam = url.searchParams.get("w");

      // Handle thumbnail downscaling and caching if width requested (e.g. ?w=360)
      if (widthParam) {
        const targetWidth = parseInt(widthParam, 10) || 360;
        const cacheFilePath = path.join(COVER_CACHE_DIR, `${bookId}_${targetWidth}.jpg`);

        if (fs.existsSync(cacheFilePath)) {
          const cachedBuffer = fs.readFileSync(cacheFilePath);
          const etag = `"${crypto.createHash("sha256").update(cachedBuffer).digest("hex").slice(0, 16)}"`;

          if (req.headers.get("if-none-match") === etag) {
            return new Response(null, { status: 304 });
          }

          return new Response(cachedBuffer, {
            headers: {
              "Content-Type": "image/jpeg",
              "Cache-Control": "public, max-age=604800, immutable",
              "ETag": etag,
            },
          });
        }

        // Fetch master cover from Calibre
        const masterRes = await fetch(`${SERVER_URL}/get/cover/${bookId}/Agent_Library`);
        if (!masterRes.ok) {
          return new Response("Cover not found", { status: 404 });
        }

        const masterBuffer = Buffer.from(await masterRes.arrayBuffer());
        const tempMaster = `/tmp/master_cover_${bookId}_${Date.now()}.jpg`;
        fs.writeFileSync(tempMaster, masterBuffer);

        try {
          const sipsRes = spawnSync("/usr/bin/sips", [
            "-Z",
            String(targetWidth),
            tempMaster,
            "--out",
            cacheFilePath,
          ], { encoding: "utf8", timeout: 15000 });

          if (sipsRes.status === 0 && fs.existsSync(cacheFilePath)) {
            const thumbBuffer = fs.readFileSync(cacheFilePath);
            const etag = `"${crypto.createHash("sha256").update(thumbBuffer).digest("hex").slice(0, 16)}"`;

            return new Response(thumbBuffer, {
              headers: {
                "Content-Type": "image/jpeg",
                "Cache-Control": "public, max-age=604800, immutable",
                "ETag": etag,
              },
            });
          }
        } finally {
          if (fs.existsSync(tempMaster)) {
            try { fs.unlinkSync(tempMaster); } catch (_cleanErr) { void _cleanErr; }
          }
        }

        // Fallback to original master if downscaling fails
        const etag = `"${crypto.createHash("sha256").update(masterBuffer).digest("hex").slice(0, 16)}"`;
        return new Response(masterBuffer, {
          headers: {
            "Content-Type": masterRes.headers.get("Content-Type") || "image/jpeg",
            "Cache-Control": "public, max-age=604800, immutable",
            "ETag": etag,
          },
        });
      }

      // Master cover request (full resolution)
      const coverRes = await fetch(`${SERVER_URL}/get/cover/${bookId}/Agent_Library`);
      if (coverRes.ok) {
        const coverBuf = Buffer.from(await coverRes.arrayBuffer());
        const etag = `"${crypto.createHash("sha256").update(coverBuf).digest("hex").slice(0, 16)}"`;

        if (req.headers.get("if-none-match") === etag) {
          return new Response(null, { status: 304 });
        }

        return new Response(coverBuf, {
          headers: {
            "Content-Type": coverRes.headers.get("Content-Type") || "image/jpeg",
            "Cache-Control": "public, max-age=86400",
            "ETag": etag,
          },
        });
      }
      return new Response("Cover not found", { status: 404 });
    }

    // API: Book Download Proxy
    if (url.pathname.startsWith("/api/books/") && url.pathname.includes("/download/")) {
      const parts = url.pathname.split("/");
      const bookId = parts[3];
      const format = parts[5].toLowerCase();
      const fileRes = await fetch(`${SERVER_URL}/get/${format}/${bookId}/Agent_Library`);
      if (fileRes.ok) {
        return new Response(await fileRes.arrayBuffer(), {
          headers: {
            "Content-Type": fileRes.headers.get("Content-Type") || "application/octet-stream",
            "Content-Disposition": `attachment; filename="book-${bookId}.${format}"`
          }
        });
      }
      return new Response("File not found", { status: 404 });
    }

    // API: KOSync Live Telemetry
    if (url.pathname === "/api/kosync/active" && req.method === "GET") {
      const progress = getKosyncProgress();
      return jsonResponse(progress);
    }

    // API: Reading Stats
    if (url.pathname === "/api/kosync/stats" && req.method === "GET") {
      const progress = getKosyncProgress();
      const finishedBooks = progress.filter((p) => p.percentage >= 0.99);
      const activeBooks = progress.filter((p) => p.percentage < 0.99 && p.percentage > 0);

      const days = new Set<string>();
      for (const p of progress) {
        if (p.timestamp) {
          const dateStr = new Date(p.timestamp * 1000).toISOString().split("T")[0];
          days.add(dateStr);
        }
      }

      return Response.json({
        totalSessions: progress.length,
        readingDaysCount: days.size,
        finishedCount: finishedBooks.length,
        finishedBooks,
        activeBooks
      });
    }

    // API: Bulk Clean Metadata
    if (url.pathname === "/api/library/clean-metadata" && req.method === "POST") {
      const books = getCalibreBooks(true);
      let cleanedCount = 0;

      for (const b of books) {
        const clean = sanitizeMetadata(b.title, b.authors, b.tags);
        const setArgs = ["set_metadata", String(b.id), "--with-library", SERVER_URL];
        let hasChanges = false;

        if (clean.title && clean.title !== b.title) {
          setArgs.push("--field", `title:${clean.title}`);
          hasChanges = true;
        }
        if (clean.author && clean.author !== b.authors) {
          setArgs.push("--field", `authors:${clean.author}`);
          hasChanges = true;
        }
        if (clean.tags) {
          setArgs.push("--field", `tags:${clean.tags.join(",")}`);
          hasChanges = true;
        }

        if (hasChanges) {
          runCalibredb(setArgs);
          cleanedCount++;
        }
      }

      getCalibreBooks(true);
      return Response.json({ success: true, message: `Sanitized metadata for ${cleanedCount} books` });
    }

    // API: Backfill Covers for Web Articles without a Cover
    if (url.pathname === "/api/library/backfill-covers" && req.method === "POST") {
      try {
        const books = getCalibreBooks(true);
        const candidates = books.filter((b: any) => {
          const tags = Array.isArray(b.tags) ? b.tags : (b.tags ? [b.tags] : []);
          const isWeb = tags.some((t: string) => t === "Web Article" || t === "Read Later");
          const hasCover = b.cover && b.cover !== 0 && b.cover !== false;
          return isWeb && !hasCover;
        });

        const updated: Array<{ id: number; title: string }> = [];
        for (const book of candidates) {
          try {
            const tags: string[] = Array.isArray(book.tags) ? book.tags : (book.tags ? [book.tags] : []);
            const siteTag = tags.find((t: string) => t !== "Web Article" && t !== "Read Later");
            const siteName = siteTag || book.publisher || "Web Article";
            const coverPath = generateTypographicCover(book.title, book.authors || "Unknown", siteName);

            const setRes = runCalibredb([
              "set_metadata",
              String(book.id),
              "--with-library",
              SERVER_URL,
              "--field",
              `cover:${coverPath}`,
            ]);

            if (fs.existsSync(coverPath)) {
              try { fs.unlinkSync(coverPath); } catch (_unlinkErr) { void _unlinkErr; }
            }

            if (setRes.status === 0) {
              updated.push({ id: book.id, title: book.title });
              try {
                cacheDb.run("UPDATE file_hashes SET cover = 1 WHERE book_id = ?", [book.id]);
              } catch (_dbErr) { void _dbErr; }
            }
          } catch (itemErr) {
            console.error(`[Backfill] Failed for book ${book.id}:`, itemErr);
          }
        }

        getCalibreBooks(true);
        return jsonResponse({
          success: true,
          count: updated.length,
          updated,
          message: `Generated and attached covers for ${updated.length} web articles.`,
        });
      } catch (err: any) {
        return jsonResponse({ success: false, error: err.message }, 500);
      }
    }

    // API: Export Obsidian Markdown with Real Highlights
    if (url.pathname.startsWith("/api/books/") && url.pathname.endsWith("/obsidian.md")) {
      const parts = url.pathname.split("/");
      const bookId = parseInt(parts[3]);
      const books = getCalibreBooks();
      const book = books.find((b: any) => b.id === bookId);
      const progress = getKosyncProgress().find((p) => p.bookId === bookId || (book && p.displayTitle === book.title));

      const title = book?.title || progress?.displayTitle || "Book Notes";
      const author = book?.authors || progress?.displayAuthors || "Unknown";
      const pct = progress ? Math.round(progress.percentage * 100) : 0;
      const dateStr = new Date().toISOString().split("T")[0];

      const highlights = extractHighlightsFromSdr(bookId);

      const highlightLines: string[] = [];
      if (highlights.length > 0) {
        highlights.forEach((h, i) => {
          highlightLines.push(`### Highlight ${i + 1}`);
          highlightLines.push(`> ${h.text}`);
          if (h.notes) highlightLines.push(`**Note:** ${h.notes}`);
          highlightLines.push(`*Captured: ${h.datetime}${h.page ? ' | Page: ' + h.page : ''}*`);
          highlightLines.push("");
        });
      } else {
        highlightLines.push("*(No highlights found in .sdr sidecar for this document)*");
        highlightLines.push("");
        highlightLines.push(`- Current Progress: ${pct}%`);
      }

      const md = [
        "---",
        `title: "${title}"`,
        `author: "${author}"`,
        `series: "${book?.series || ""}"`,
        `date_created: ${dateStr}`,
        `progress_percent: ${pct}%`,
        "tags:",
        "  - book-notes",
        "  - reading-hq",
        "---",
        "",
        `# 📖 ${title}`,
        `> **Author:** ${author}  `,
        `> **Series:** ${book?.series ? book.series + ' #' + (book.series_index || 1) : 'Standalone'}  `,
        `> **Reading Progress:** ${pct}% (Synced from KOReader)  `,
        `> **Last Read:** ${progress?.timestamp ? new Date(progress.timestamp * 1000).toLocaleString() : dateStr}  `,
        "",
        "---",
        "",
        "## 📝 Book Summary",
        book?.comments ? book.comments.replace(/<[^>]*>?/gm, "") : "No summary provided.",
        "",
        "---",
        "",
        "## 💡 Highlights & Annotations",
        ...highlightLines
      ].join("\n");

      return new Response(md, {
        headers: {
          "Content-Type": "text/markdown; charset=utf-8",
          "Content-Disposition": `attachment; filename="${encodeURIComponent(title)}_notes.md"`
        }
      });
    }

    
    // API: Link Unmapped KOSync Document to Calibre Book
    if (url.pathname === "/api/kosync/link-document" && req.method === "POST") {
      try {
        const body = await req.json() as { document: string; bookId: number };
        if (!body.document || !body.bookId) {
          return Response.json({ success: false, error: "document and bookId required" }, { status: 400 });
        }

        const books = getCalibreBooks();
        const book = books.find((b: any) => b.id === body.bookId);
        if (!book) {
          return Response.json({ success: false, error: "Book not found in Calibre" }, { status: 404 });
        }

        const canonicalId = cleanString(book.title).toLowerCase() + "__" + cleanString(book.authors || "").toLowerCase();
        const now = Math.floor(Date.now() / 1000);

        if (fs.existsSync(KOSYNC_DB_PATH)) {
          const db = new Database(KOSYNC_DB_PATH);
          db.prepare(`
            INSERT INTO document_aliases (document_hash, canonical_id, normalized_title, normalized_authors, created_at)
            VALUES (?, ?, ?, ?, ?)
            ON CONFLICT(document_hash) DO UPDATE SET
              canonical_id = excluded.canonical_id,
              normalized_title = excluded.normalized_title,
              normalized_authors = excluded.normalized_authors
          `).run(body.document, canonicalId, book.title, book.authors || "Unknown", now);

          db.prepare(`
            UPDATE progress
            SET title = ?, authors = ?
            WHERE document = ?
          `).run(book.title, book.authors || "Unknown", body.document);

          return Response.json({ success: true, message: `Linked hash ${body.document.substring(0, 8)}... to "${book.title}"` });
        }

        return Response.json({ success: false, error: "KOSync database missing" }, { status: 500 });
      } catch (err: any) {
        return Response.json({ success: false, error: err.message }, { status: 500 });
      }
    }

    // API: Delete Single KOSync Progress Entry
    if (url.pathname.startsWith("/api/kosync/progress/") && req.method === "DELETE") {
      try {
        const parts = url.pathname.split("/");
        const progressId = parts[4];
        if (fs.existsSync(KOSYNC_DB_PATH)) {
          const db = new Database(KOSYNC_DB_PATH);
          db.run("DELETE FROM progress WHERE id = ?;", [progressId]);
          return Response.json({ success: true, message: `Removed progress entry ${progressId}` });
        }
        return Response.json({ success: false, error: "KOSync database not found" }, { status: 404 });
      } catch (err: any) {
        return Response.json({ success: false, error: err.message }, { status: 500 });
      }
    }

    // API: Clear All KOSync Progress Entries
    if (url.pathname === "/api/kosync/progress/clear" && req.method === "POST") {
      try {
        if (fs.existsSync(KOSYNC_DB_PATH)) {
          const db = new Database(KOSYNC_DB_PATH);
          db.run("DELETE FROM progress;");
          return Response.json({ success: true, message: "Cleared all sync sessions" });
        }
        return Response.json({ success: false, error: "KOSync database not found" }, { status: 404 });
      } catch (err: any) {
        return Response.json({ success: false, error: err.message }, { status: 500 });
      }
    }

    // API: Ingest Web Article from URL (Read Later EPUB)
    if (url.pathname === "/api/ingest-url" && req.method === "POST") {
      try {
        const body = (await req.json()) as { url?: string };
        if (!body.url || typeof body.url !== "string") {
          return Response.json({ success: false, error: "Missing or invalid 'url' parameter" }, { status: 400 });
        }
        const targetUrl = body.url.trim();
        if (!/^https?:\/\/\S+/i.test(targetUrl)) {
          return Response.json({ success: false, error: "Please provide a valid http:// or https:// URL" }, { status: 400 });
        }

        const result = await ingestArticleFromUrl(targetUrl);
        if (!result.success) {
          return Response.json(result, { status: 500 });
        }

        getCalibreBooks(true);
        return Response.json(result);
      } catch (err: any) {
        return Response.json(
          {
            success: false,
            error: err.message || "Failed to ingest article from URL"
          },
          { status: 500 }
        );
      }
    }

    // API: Upload Book
    if (url.pathname === "/api/upload" && req.method === "POST") {
      try {
        const formData = await req.formData();
        const file = formData.get("file") as File;
        if (!file || typeof file === "string") {
          return Response.json({ success: false, error: "No file provided" }, { status: 400 });
        }

        const fileName = file.name;
        const ext = path.extname(fileName);
        const safeBase = path.basename(fileName, ext);
        const tempName = `${safeBase}_${Date.now()}_${Math.random().toString(36).substring(2, 6)}${ext}`;
        const destPath = path.join(DROP_DIR, tempName);
        const arrayBuffer = await file.arrayBuffer();
        fs.writeFileSync(destPath, Buffer.from(arrayBuffer));

        if (isArchiveFile(fileName)) {
          console.log(`[Upload] Detected archive: ${fileName}. Unpacking...`);
          const unp = unpackArchive(destPath);
          try { fs.unlinkSync(destPath); } catch {}

          if (!unp.success) {
            return Response.json({ success: false, error: unp.error || "Archive extraction failed" }, { status: 400 });
          }

          if (unp.books.length === 0) {
            unp.cleanup();
            return Response.json({ success: false, error: "No supported eBook files (.epub, .pdf, .mobi, .azw3, .cbz) found inside archive." }, { status: 400 });
          }

          console.log(`[Upload] Archive ${fileName} contains ${unp.books.length} book(s). Processing...`);
          const results: any[] = [];
          for (const book of unp.books) {
            const r = ingestBookFile(book.tempPath, book.originalName);
            results.push({ name: book.originalName, ...r });
          }
          unp.cleanup();

          const importedCount = results.filter((r: any) => r.success && !r.duplicate).length;
          return Response.json({
            success: true,
            isArchive: true,
            archiveName: fileName,
            total: unp.books.length,
            imported: importedCount,
            results
          });
        }

        const result = ingestBookFile(destPath, fileName);
        try { fs.unlinkSync(destPath); } catch {}

        return Response.json(result, { status: result.success ? 200 : 500 });
      } catch (err: any) {
        return Response.json({ success: false, error: err.message }, { status: 500 });
      }
    }

    // API: Delete Book
    if (url.pathname.startsWith("/api/books/") && req.method === "DELETE") {
      const parts = url.pathname.split("/");
      const bookId = parts[3];
      const delRes = runCalibredb([
        "remove",
        bookId,
        "--with-library",
        SERVER_URL
      ]);

      getCalibreBooks(true);
      if (delRes.status === 0) {
        return Response.json({ success: true, message: `Removed book ${bookId}` });
      } else {
        return Response.json({ success: false, error: delRes.stderr || "Delete failed" }, { status: 500 });
      }
    }

    // API: Bulk Delete Books
    if (url.pathname === "/api/books/bulk-delete" && req.method === "POST") {
      try {
        const body = await req.json() as { bookIds: (string | number)[] };
        if (!body.bookIds || !body.bookIds.length) {
          return Response.json({ success: false, error: "No book IDs provided" }, { status: 400 });
        }

        const ids = body.bookIds.map(String).join(",");
        const delRes = runCalibredb([
          "remove",
          ids,
          "--with-library",
          SERVER_URL
        ]);

        getCalibreBooks(true);
        if (delRes.status === 0) {
          return Response.json({ success: true, message: `Removed ${body.bookIds.length} books` });
        } else {
          return Response.json({ success: false, error: delRes.stderr || "Bulk delete failed" }, { status: 500 });
        }
      } catch (err: any) {
        return Response.json({ success: false, error: err.message }, { status: 500 });
      }
    }

    // API: Multi-Source Metadata Lookup
    if (url.pathname === "/api/metadata/lookup" && req.method === "POST") {
      try {
        const body = await req.json() as { query: string };
        const query = body.query;
        if (!query) return Response.json({ results: [] });

        const isManga = req.url.includes("manga=true") || /manga|comic|chapter|one piece|naruto|bleach/i.test(query);
        const results = await searchUniversalMetadata(query, isManga);
        return Response.json({ results });
      } catch (err: any) {
        return Response.json({ results: [], error: err.message });
      }
    }

    // API: Update Metadata & Cover
    if (url.pathname.startsWith("/api/books/") && url.pathname.endsWith("/metadata") && req.method === "POST") {
      try {
        const parts = url.pathname.split("/");
        const bookId = parts[3];
        const body = await req.json() as {
          title?: string;
          authors?: string;
          tags?: string;
          series?: string;
          seriesIndex?: string | number;
          comments?: string;
          rating?: number;
          coverUrl?: string;
        };

        const cleanTitle = cleanString(body.title || "");
        const cleanAuth = cleanString(body.authors || "");
        const cleanTags = (body.tags || "").split(",").map(cleanString).filter(t => t && !/http|t\.me|thebookr/i.test(t)).join(",");

        const args = ["set_metadata", bookId, "--with-library", SERVER_URL];
        if (cleanTitle) args.push("--field", `title:${cleanTitle}`);
        if (cleanAuth) args.push("--field", `authors:${cleanAuth}`);
        if (cleanTags !== undefined) args.push("--field", `tags:${cleanTags}`);
        if (body.series !== undefined) args.push("--field", `series:${cleanString(body.series)}`);
        if (body.seriesIndex !== undefined) args.push("--field", `series_index:${body.seriesIndex}`);
        if (body.comments !== undefined) args.push("--field", `comments:${body.comments}`);
        if (body.rating !== undefined) args.push("--field", `rating:${body.rating}`);

        let tempCover = "";
        if (body.coverUrl) {
          try {
            const cRes = await fetch(body.coverUrl);
            if (cRes.ok) {
              tempCover = `/tmp/cover_${bookId}_${Date.now()}.jpg`;
              fs.writeFileSync(tempCover, Buffer.from(await cRes.arrayBuffer()));
              args.push("--field", `cover:${tempCover}`);
            }
          } catch (e) {
            console.error("Cover download error:", e);
          }
        }

        const setRes = runCalibredb(args);
        if (tempCover && fs.existsSync(tempCover)) {
          try { fs.unlinkSync(tempCover); } catch {}
        }

        getCalibreBooks(true);
        if (setRes.status === 0) {
          return Response.json({ success: true, message: "Metadata sanitized & updated" });
        } else {
          return Response.json({ success: false, error: setRes.stderr || "Update failed" }, { status: 500 });
        }
      } catch (err: any) {
        return Response.json({ success: false, error: err.message }, { status: 500 });
      }
    }

    // Serve SPA HTML
    const html = fs.readFileSync(HTML_PATH, "utf8");
    return new Response(html, {
      headers: {
        "Content-Type": "text/html; charset=utf-8",
        "Cache-Control": "no-cache"
      }
    });
  }
});
