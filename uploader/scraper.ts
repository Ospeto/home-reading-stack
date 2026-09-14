
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

const SERVER_URL = "http://127.0.0.1:8088";
const PROXY = "http://127.0.0.1:7890";

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

export function cleanQuery(str: string): string {
  if (!str) return "";
  let s = str;
  s = s.replace(/https?:\/\/\S+/gi, " ");
  s = s.replace(/t\.me\/\S+/gi, " ");
  s = s.replace(/@\w+/gi, " ");
  s = s.replace(/\[.*?\]/gi, " ");
  s = s.replace(/\(.*?\)/gi, " ");
  s = s.replace(/\b(c[0-9]+|ch\.?\s*[0-9]+|chapter\s*[0-9]+|vol\.?\s*[0-9]+|volume\s*[0-9]+)\b/gi, " ");
  s = s.replace(/\b(epub|pdf|mobi|azw3|cbz|cbr|raw|hq|scan|v[0-9]+)\b/gi, " ");
  s = s.replace(/[-_–—]+/g, " ");
  s = s.replace(/\s+/g, " ").trim();
  return s;
}

// Compute Dice Coefficient String Similarity (0.0 to 1.0)
export function stringSimilarity(a: string, b: string): number {
  const sa = a.toLowerCase().replace(/[^a-z0-9]/g, "");
  const sb = b.toLowerCase().replace(/[^a-z0-9]/g, "");
  if (!sa || !sb) return 0;
  if (sa === sb) return 1.0;
  if (sa.includes(sb) || sb.includes(sa)) return 0.85;

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
  return (2.0 * intersection) / (bgA.size + bgB.size);
}

// 1. MangaDex Scraper
export async function searchMangaDex(query: string): Promise<ScrapedMetadata[]> {
  const results: ScrapedMetadata[] = [];
  const cleanQ = cleanQuery(query);
  if (!cleanQ) return results;

  try {
    const url = `https://api.mangadex.org/manga?title=${encodeURIComponent(cleanQ)}&limit=3&includes[]=cover_art&includes[]=author`;
    const res = await fetch(url, { headers: { "User-Agent": "ReadingHQ/1.0" }, proxy: PROXY } as any);
    if (res.ok) {
      const json: any = await res.json();
      if (json.data) {
        for (const item of json.data) {
          const attr = item.attributes || {};
          const title = attr.title?.en || attr.title?.["ja-ro"] || Object.values(attr.title || {})[0] || "";
          if (!title) continue;

          let author = "";
          let coverFilename = "";
          for (const rel of (item.relationships || [])) {
            if (rel.type === "author" && rel.attributes?.name) author = rel.attributes.name;
            if (rel.type === "cover_art" && rel.attributes?.fileName) coverFilename = rel.attributes.fileName;
          }

          const coverUrl = coverFilename ? `https://uploads.mangadex.org/covers/${item.id}/${coverFilename}.512.jpg` : "";
          const tags: string[] = (attr.tags || []).map((t: any) => t.attributes?.name?.en).filter(Boolean);
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
            isManga: true
          });
        }
      }
    }
  } catch (e) {}
  return results;
}

// 2. Bangumi Scraper
export async function searchBangumi(query: string): Promise<ScrapedMetadata[]> {
  const results: ScrapedMetadata[] = [];
  const cleanQ = cleanQuery(query);
  if (!cleanQ) return results;

  try {
    const url = `https://api.bgm.tv/search/subject/${encodeURIComponent(cleanQ)}?type=1&responseGroup=medium`;
    const res = await fetch(url, { headers: { "User-Agent": "ReadingHQ/1.0" } });
    if (res.ok) {
      const json: any = await res.json();
      if (json.list) {
        for (const item of json.list.slice(0, 3)) {
          const title = item.name_cn || item.name || "";
          if (!title) continue;

          const sim = Math.max(stringSimilarity(cleanQ, item.name || ""), stringSimilarity(cleanQ, item.name_cn || ""));
          results.push({
            title,
            authors: "", // Bangumi search results often omit author in summary list
            description: item.summary || "",
            publishedDate: item.air_date || "",
            coverUrl: item.images?.large || item.images?.common || "",
            tags: ["Manga"],
            source: "Bangumi",
            confidence: Math.round(sim * 100) / 100,
            isManga: true
          });
        }
      }
    }
  } catch (e) {}
  return results;
}

// 3. OpenLibrary Scraper
export async function searchOpenLibrary(query: string): Promise<ScrapedMetadata[]> {
  const results: ScrapedMetadata[] = [];
  const cleanQ = cleanQuery(query);
  if (!cleanQ) return results;

  try {
    const url = `https://openlibrary.org/search.json?q=${encodeURIComponent(cleanQ)}&limit=3`;
    const res = await fetch(url, { proxy: PROXY } as any);
    if (res.ok) {
      const json: any = await res.json();
      if (json.docs) {
        for (const doc of json.docs) {
          const title = doc.title || "";
          if (!title) continue;

          const authors = (doc.author_name || []).join(", ");
          const coverId = doc.cover_i;
          const coverUrl = coverId ? `https://covers.openlibrary.org/b/id/${coverId}-L.jpg` : "";
          const tags = (doc.subject ? doc.subject.slice(0, 4) : []);

          const sim = stringSimilarity(cleanQ, title);
          results.push({
            title,
            authors: authors || "Unknown",
            publisher: (doc.publisher || [])[0] || "",
            publishedDate: doc.first_publish_year ? String(doc.first_publish_year) : "",
            description: Array.isArray(doc.first_sentence) ? doc.first_sentence[0] : (doc.first_sentence || ""),
            coverUrl,
            tags,
            source: "OpenLibrary",
            confidence: Math.round(sim * 100) / 100,
            isManga: false
          });
        }
      }
    }
  } catch (e) {}
  return results;
}

// Unified Search with Multi-Source Fallback
export async function searchUniversalMetadata(query: string, hintManga: boolean = false): Promise<ScrapedMetadata[]> {
  let results: ScrapedMetadata[] = [];

  if (hintManga || /manga|comic|chapter|ch\.|vol\.|c0|one piece|naruto|bleach|berserk/i.test(query)) {
    const [md, bg] = await Promise.all([
      searchMangaDex(query),
      searchBangumi(query)
    ]);
    results = [...md, ...bg];
  }

  if (results.length === 0) {
    const ol = await searchOpenLibrary(query);
    results = [...ol];
  }

  // Sort by highest confidence
  results.sort((a, b) => b.confidence - a.confidence);
  return results;
}

// Auto-Enrich Calibre Book Metadata & Cover
export async function applyMetadataToCalibre(bookId: number, meta: ScrapedMetadata): Promise<boolean> {
  try {
    const args = ["set_metadata", String(bookId), "--with-library", SERVER_URL];
    if (meta.title) args.push("--field", `title:${meta.title}`);
    if (meta.authors && meta.authors !== "Unknown") args.push("--field", `authors:${meta.authors}`);
    if (meta.tags && meta.tags.length > 0) args.push("--field", `tags:${meta.tags.join(",")}`);
    if (meta.description) args.push("--field", `comments:${meta.description}`);

    // Download cover to temporary file if coverUrl exists
    let tempCoverPath = "";
    if (meta.coverUrl) {
      tempCoverPath = `/tmp/cover_${bookId}_${Date.now()}.jpg`;
      const imgRes = await fetch(meta.coverUrl, { proxy: PROXY } as any);
      if (imgRes.ok) {
        const buf = await imgRes.arrayBuffer();
        fs.writeFileSync(tempCoverPath, Buffer.from(buf));
        args.push("--cover", tempCoverPath);
      }
    }

    const res = spawnSync("/opt/homebrew/bin/calibredb", args, { encoding: "utf8" });
    if (tempCoverPath && fs.existsSync(tempCoverPath)) {
      fs.unlinkSync(tempCoverPath);
    }

    return res.status === 0;
  } catch (e) {
    console.error(`[AutoScraper] Failed to apply metadata to book ${bookId}:`, e);
    return false;
  }
}
