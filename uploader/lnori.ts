import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { spawnSync } from "node:child_process";
import { validateEpubContent, safeFetchWithSsrf } from "./security";

const PROXY_URL = "http://127.0.0.1:7890";
const SERVER_URL = "http://127.0.0.1:8088";
const USER_AGENT = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";

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

export function getSipsPath(): string {
  if (process.env.SIPS_PATH) return process.env.SIPS_PATH;
  const probe = spawnSync("which", ["sips"], { encoding: "utf8" });
  if (probe.status === 0 && probe.stdout?.trim()) return probe.stdout.trim();
  if (fs.existsSync("/usr/bin/sips")) return "/usr/bin/sips";
  return "sips";
}

export function runCalibredb(args: string[]): { status: number | null; stdout: string; stderr: string } {
  const env: any = { ...process.env };
  delete env.HTTP_PROXY;
  delete env.http_proxy;
  delete env.HTTPS_PROXY;
  delete env.https_proxy;
  delete env.ALL_PROXY;
  delete env.all_proxy;
  env.PATH = "/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:" + (env.PATH || "");

  const res = spawnSync(getCalibredbPath(), args, {
    encoding: "utf8",
    env,
  });

  return {
    status: res.status,
    stdout: res.stdout || "",
    stderr: res.stderr || "",
  };
}

export function isLnoriUrl(url: string): boolean {
  if (!url || typeof url !== "string") return false;
  try {
    const parsed = new URL(url.trim());
    const host = parsed.hostname.toLowerCase();
    if (host !== "lnori.com" && host !== "www.lnori.com") return false;
    return /^\/(series|book)\/([0-9]+)/.test(parsed.pathname);
  } catch {
    return false;
  }
}

export interface ParsedLnoriUrl {
  type: "series" | "book";
  id: string;
  slug?: string;
}

export function parseLnoriUrl(url: string): ParsedLnoriUrl | null {
  if (!url || typeof url !== "string") return null;
  try {
    const parsed = new URL(url.trim());
    const host = parsed.hostname.toLowerCase();
    if (host !== "lnori.com" && host !== "www.lnori.com") return null;
    const match = parsed.pathname.match(/^\/(series|book)\/([0-9]+)(?:\/([^/?#]+))?/);
    if (!match) return null;
    const type = match[1] as "series" | "book";
    const id = match[2];
    const slug = match[3] || undefined;
    return { type, id, slug };
  } catch {
    return null;
  }
}

export interface LnoriVolumeMetadata {
  bookId: string;
  url: string;
  name: string;
  epubFilename: string;
  seriesId?: string;
  seriesTitle?: string;
  seriesSlug?: string;
  authors?: string[];
  coverImageUrl?: string;
  volumeNumber?: number;
}

export interface LnoriSeriesManifest {
  type: "series" | "book";
  seriesId: string;
  seriesTitle: string;
  author: string;
  tags: string[];
  volumePaths: string[];
}

export function extractManifestFromHtml(
  html: string,
  url: string,
  parsedUrl: ParsedLnoriUrl,
): LnoriSeriesManifest {
  let seriesTitle = "";
  let author = "Unknown";
  let tags: string[] = [];
  const volumePaths: string[] = [];

  // Try extracting from application/ld+json
  const ldMatches = Array.from(
    html.matchAll(/<script[^>]*type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi),
  );

  let schemaData: any = null;
  for (const m of ldMatches) {
    try {
      const parsed = JSON.parse(m[1]);
      if (parsed["@type"] === "Book" || parsed.name) {
        schemaData = parsed;
        break;
      }
    } catch {
      // ignore
    }
  }

  // Also check app-data script
  const appDataMatch = html.match(
    /<script[^>]*id=["']app-data["'][^>]*>([\s\S]*?)<\/script>/i,
  );
  let appData: any = null;
  if (appDataMatch) {
    try {
      appData = JSON.parse(appDataMatch[1]);
    } catch {
      // ignore
    }
  }

  if (parsedUrl.type === "series") {
    if (schemaData) {
      if (schemaData.name) seriesTitle = schemaData.name;
      if (schemaData.author) {
        if (typeof schemaData.author === "string") {
          author = schemaData.author;
        } else if (schemaData.author.name) {
          author = schemaData.author.name;
        } else if (Array.isArray(schemaData.author)) {
          author = schemaData.author
            .map((a: any) => (typeof a === "string" ? a : a?.name))
            .filter(Boolean)
            .join(", ");
        }
      }
      if (schemaData.genre) {
        tags = schemaData.genre
          .split(",")
          .map((g: string) => g.trim())
          .filter(Boolean);
      }
      if (Array.isArray(schemaData.hasPart)) {
        for (const part of schemaData.hasPart) {
          if (part.url && typeof part.url === "string") {
            try {
              const u = new URL(part.url, "https://lnori.com");
              if (u.pathname.startsWith("/book/")) {
                volumePaths.push(u.pathname);
              }
            } catch {
              if (part.url.startsWith("/book/")) volumePaths.push(part.url);
            }
          }
        }
      }
    }

    // Fallback: extract all /book/<id>/<slug> hrefs from html
    const bookLinks = Array.from(
      new Set(
        Array.from(
          html.matchAll(/href=["'](\/book\/[0-9]+(?:\/[^"'#?]*)?)["']/gi),
          (m) => m[1],
        ),
      ),
    );
    for (const bPath of bookLinks) {
      if (!volumePaths.includes(bPath)) {
        volumePaths.push(bPath);
      }
    }

    // Fallback series title from <title>
    if (!seriesTitle) {
      const tMatch = html.match(/<title>([^<]+)<\/title>/i);
      if (tMatch) {
        seriesTitle = tMatch[1].replace(/\s*\|\s*Lnori.*$/i, "").trim();
      }
    }
    if (!seriesTitle) {
      seriesTitle = parsedUrl.slug
        ? parsedUrl.slug.replace(/-/g, " ")
        : `Series ${parsedUrl.id}`;
    }

    return {
      type: "series",
      seriesId: parsedUrl.id,
      seriesTitle,
      author: author || "Unknown",
      tags,
      volumePaths,
    };
  } else {
    // Book URL: treat as 1-volume series
    let bookName = "";
    let epubFilename = "";
    let seriesSlug = "";

    const data = appData || schemaData;
    if (data) {
      if (data.name) bookName = data.name;
      if (data.author) {
        if (typeof data.author === "string") {
          author = data.author;
        } else if (data.author.name) {
          author = data.author.name;
        } else if (Array.isArray(data.author)) {
          author = data.author
            .map((a: any) => (typeof a === "string" ? a : a?.name))
            .filter(Boolean)
            .join(", ");
        }
      }
      if (Array.isArray(data.additionalProperty)) {
        for (const prop of data.additionalProperty) {
          if (prop.name === "series_title" && prop.value) {
            seriesTitle = prop.value;
          }
          if (prop.name === "series_slug" && prop.value) {
            seriesSlug = prop.value;
          }
          if (prop.name === "epub_filename" && prop.value) {
            epubFilename = prop.value;
          }
        }
      }
      if (data.genre) {
        tags = data.genre
          .split(",")
          .map((g: string) => g.trim())
          .filter(Boolean);
      }
    }

    if (!seriesTitle) {
      seriesTitle = bookName || (parsedUrl.slug ? parsedUrl.slug.replace(/-/g, " ") : `Book ${parsedUrl.id}`);
    }

    const currentPath = new URL(url, "https://lnori.com").pathname;
    return {
      type: "book",
      seriesId: parsedUrl.id,
      seriesTitle,
      author: author || "Unknown",
      tags,
      volumePaths: [currentPath],
    };
  }
}

export function parseVolumeAppData(html: string, fallbackBookId?: string): LnoriVolumeMetadata | null {
  const match = html.match(
    /<script[^>]*id=["']app-data["'][^>]*>([\s\S]*?)<\/script>/i,
  );
  if (!match) return null;

  try {
    const data = JSON.parse(match[1]);
    const name = data.name || "";
    let epubFilename = "";
    let bookId = data.id || fallbackBookId || "";
    let seriesId: string | undefined;
    let seriesTitle: string | undefined;
    let seriesSlug: string | undefined;
    let coverImageUrl: string | undefined = data.image;

    if (Array.isArray(data.additionalProperty)) {
      for (const prop of data.additionalProperty) {
        if (prop.name === "epub_filename") epubFilename = prop.value;
        if (prop.name === "book_id") bookId = prop.value;
        if (prop.name === "series_id") seriesId = prop.value;
        if (prop.name === "series_title") seriesTitle = prop.value;
        if (prop.name === "series_slug") seriesSlug = prop.value;
        if (prop.name === "cover_image_url" && !coverImageUrl) {
          coverImageUrl = prop.value;
        }
      }
    }

    if (!epubFilename) return null;

    let authors: string[] = [];
    if (data.author) {
      if (typeof data.author === "string") {
        authors = [data.author];
      } else if (data.author.name) {
        authors = [data.author.name];
      } else if (Array.isArray(data.author)) {
        authors = data.author
          .map((a: any) => (typeof a === "string" ? a : a?.name))
          .filter(Boolean);
      }
    }

    // Infer volume number from book name, epub filename, or part
    let volumeNumber: number | undefined;
    const volMatch = (name + " " + epubFilename).match(
      /(?:vol(?:ume)?\.?|#)\s*([0-9]+(?:\.[0-9]+)?)/i,
    );
    if (volMatch) {
      const parsedVol = parseFloat(volMatch[1]);
      if (!isNaN(parsedVol)) volumeNumber = parsedVol;
    }

    return {
      bookId: String(bookId),
      url: "",
      name,
      epubFilename,
      seriesId,
      seriesTitle,
      seriesSlug,
      authors: authors.length > 0 ? authors : undefined,
      coverImageUrl,
      volumeNumber,
    };
  } catch {
    return null;
  }
}

export async function fetchLnoriHtml(targetUrl: string): Promise<string> {
  let res: Response;
  try {
    res = await safeFetchWithSsrf(targetUrl, {
      headers: {
        "User-Agent": USER_AGENT,
        Referer: "https://lnori.com/",
      },
      proxy: PROXY_URL,
      signal: AbortSignal.timeout(30000),
    } as any);
  } catch (err: any) {
    // If proxy failed or threw, retry without proxy
    res = await safeFetchWithSsrf(targetUrl, {
      headers: {
        "User-Agent": USER_AGENT,
        Referer: "https://lnori.com/",
      },
      signal: AbortSignal.timeout(30000),
    } as any);
  }

  if (res.status === 404) {
    // Check if URL was missing slug (e.g. https://lnori.com/series/8046 or https://lnori.com/book/23021)
    const parsed = parseLnoriUrl(targetUrl);
    if (parsed && !parsed.slug) {
      const sitemapPath =
        parsed.type === "series"
          ? "https://lnori.com/sitemap/sitemap-series.xml"
          : "https://lnori.com/sitemap/sitemap-book.xml";
      try {
        let sRes: Response;
        try {
          sRes = await safeFetchWithSsrf(sitemapPath, {
            headers: { "User-Agent": USER_AGENT },
            proxy: PROXY_URL,
            signal: AbortSignal.timeout(20000),
          } as any);
        } catch {
          sRes = await safeFetchWithSsrf(sitemapPath, {
            headers: { "User-Agent": USER_AGENT },
            signal: AbortSignal.timeout(20000),
          } as any);
        }
        if (sRes.ok) {
          const xml = await sRes.text();
          const regex = new RegExp(
            `<loc>(https://lnori\\.com/${parsed.type}/${parsed.id}[^<]*)</loc>`,
            "i",
          );
          const smMatch = xml.match(regex);
          if (smMatch && smMatch[1] && smMatch[1] !== targetUrl) {
            return await fetchLnoriHtml(smMatch[1]);
          }
        }
      } catch {
        // ignore sitemap fallback failure
      }
    }
    throw new Error(`Lnori URL returned HTTP 404: ${targetUrl}`);
  }

  if (!res.ok) {
    throw new Error(`Failed to fetch Lnori URL (${res.status}): ${targetUrl}`);
  }

  return await res.text();
}

export async function downloadLnoriEpub(
  epubFilename: string,
  destPath: string,
  onProgress?: (progressPercent: number) => void,
): Promise<void> {
  const downloadUrl = `https://files.lnori.com/${encodeURIComponent(epubFilename)}`;
  let res: Response;
  try {
    res = await safeFetchWithSsrf(downloadUrl, {
      headers: {
        Referer: "https://lnori.com/",
        "User-Agent": USER_AGENT,
      },
      proxy: PROXY_URL,
      signal: AbortSignal.timeout(120000),
    } as any);
  } catch {
    res = await safeFetchWithSsrf(downloadUrl, {
      headers: {
        Referer: "https://lnori.com/",
        "User-Agent": USER_AGENT,
      },
      signal: AbortSignal.timeout(120000),
    } as any);
  }

  if (!res.ok) {
    throw new Error(
      `Failed to download EPUB from Lnori storage (${res.status}): ${downloadUrl}`,
    );
  }

  const arrayBuf = await res.arrayBuffer();
  fs.writeFileSync(destPath, Buffer.from(arrayBuf));

  // Verify ZIP integrity
  const validation = validateEpubContent(destPath);
  if (!validation.isValid) {
    // Also try unzip -tq
    const unzipProbe = spawnSync("unzip", ["-tq", destPath], { encoding: "utf8" });
    if (unzipProbe.status !== 0) {
      if (fs.existsSync(destPath)) fs.unlinkSync(destPath);
      throw new Error(
        `Downloaded EPUB failed integrity verification: ${validation.error || unzipProbe.stderr || "Corrupted ZIP"}`,
      );
    }
  }
}

export async function fetchAndConvertCover(
  lnoriBookId: string,
  fallbackCoverUrl?: string,
): Promise<string | null> {
  const tempDir = os.tmpdir();
  const rawCoverPath = path.join(tempDir, `lnori_cover_${lnoriBookId}_${Date.now()}.raw`);
  const jpegCoverPath = path.join(tempDir, `lnori_cover_${lnoriBookId}_${Date.now()}.jpg`);

  const urlsToTry = [
    `https://cdn.lnori.com/cover/${lnoriBookId}.webp`,
    fallbackCoverUrl,
  ].filter(Boolean) as string[];

  let downloaded = false;
  for (const cUrl of urlsToTry) {
    try {
      let res: Response;
      try {
        res = await safeFetchWithSsrf(cUrl, {
          headers: {
            Referer: "https://lnori.com/",
            "User-Agent": USER_AGENT,
          },
          proxy: PROXY_URL,
          signal: AbortSignal.timeout(20000),
        } as any);
      } catch {
        res = await safeFetchWithSsrf(cUrl, {
          headers: {
            Referer: "https://lnori.com/",
            "User-Agent": USER_AGENT,
          },
          signal: AbortSignal.timeout(20000),
        } as any);
      }

      if (res.ok) {
        const buf = await res.arrayBuffer();
        fs.writeFileSync(rawCoverPath, Buffer.from(buf));
        downloaded = true;
        break;
      }
    } catch {
      // try next
    }
  }

  if (!downloaded || !fs.existsSync(rawCoverPath)) {
    return null;
  }

  // Convert to JPEG via sips -s format jpeg
  const sipsBin = getSipsPath();
  const sipsRes = spawnSync(
    sipsBin,
    ["-s", "format", "jpeg", rawCoverPath, "--out", jpegCoverPath],
    { encoding: "utf8" },
  );

  if (fs.existsSync(rawCoverPath)) {
    try {
      fs.unlinkSync(rawCoverPath);
    } catch {}
  }

  if (sipsRes.status === 0 && fs.existsSync(jpegCoverPath)) {
    return jpegCoverPath;
  }

  return null;
}

export interface IngestLnoriResult {
  success: boolean;
  seriesTitle: string;
  author: string;
  tags: string;
  importedCount: number;
  totalCount: number;
  calibreBookIds: number[];
  error?: string;
}

export async function ingestLnoriSeries(
  url: string,
  onProgress?: (text: string) => Promise<void>,
): Promise<IngestLnoriResult> {
  const parsed = parseLnoriUrl(url);
  if (!parsed) {
    throw new Error(`Invalid Lnori URL: ${url}`);
  }

  if (onProgress) {
    await onProgress(`⏳ _Fetching volume manifest for Lnori ${parsed.type}..._`);
  }

  const html = await fetchLnoriHtml(url);
  const manifest = extractManifestFromHtml(html, url, parsed);

  if (manifest.volumePaths.length === 0) {
    throw new Error(`No volumes found in Lnori ${manifest.type} manifest for: ${url}`);
  }

  const totalCount = manifest.volumePaths.length;
  let importedCount = 0;
  const calibreBookIds: number[] = [];

  const tempDir = os.tmpdir();

  for (let idx = 0; idx < totalCount; idx++) {
    const volPath = manifest.volumePaths[idx];
    const fullVolUrl = volPath.startsWith("http")
      ? volPath
      : `https://lnori.com${volPath.startsWith("/") ? "" : "/"}${volPath}`;
    const volNum = idx + 1;

    if (onProgress) {
      await onProgress(
        `⏳ _[Volume ${volNum}/${totalCount}] Inspecting volume metadata..._\n\`${fullVolUrl}\``,
      );
    }

    let volMeta: LnoriVolumeMetadata | null = null;
    try {
      const volHtml = await fetchLnoriHtml(fullVolUrl);
      const volParsedUrl = parseLnoriUrl(fullVolUrl);
      volMeta = parseVolumeAppData(volHtml, volParsedUrl?.id);
    } catch (err: any) {
      console.error(`[Lnori] Failed to inspect volume ${volPath}:`, err?.message || err);
    }

    if (!volMeta || !volMeta.epubFilename) {
      console.warn(`[Lnori] Skipping volume without epub_filename: ${volPath}`);
      continue;
    }

    const assignedIndex = volMeta.volumeNumber === undefined ? volNum : volMeta.volumeNumber;

    if (onProgress) {
      await onProgress(
        `⬇️ _[Volume ${volNum}/${totalCount}] Downloading EPUB..._\n*${volMeta.epubFilename}*`,
      );
    }

    const tempEpubPath = path.join(
      tempDir,
      `lnori_${volMeta.bookId || Date.now()}_vol${volNum}.epub`,
    );

    try {
      await downloadLnoriEpub(volMeta.epubFilename, tempEpubPath);

      if (onProgress) {
        await onProgress(
          `📦 _[Volume ${volNum}/${totalCount}] Ingesting into Calibre library..._\n*Volume ${assignedIndex}*`,
        );
      }

      // Add to Calibre
      const addRes = runCalibredb([
        "add",
        "--with-library",
        SERVER_URL,
        tempEpubPath,
      ]);

      let calibreId: number | null = null;
      if (addRes.status === 0 && addRes.stdout) {
        const idMatch = addRes.stdout.match(/Added book ids?:?\s*([0-9]+)/i);
        if (idMatch) {
          calibreId = parseInt(idMatch[1], 10);
        }
      }

      if (!calibreId) {
        throw new Error(
          `Failed to add volume ${volNum} to Calibre: ${addRes.stderr || addRes.stdout}`,
        );
      }

      calibreBookIds.push(calibreId);

      // Metadata enrichment
      const title = `${manifest.seriesTitle}: Volume ${assignedIndex}`;
      const author = manifest.author || (volMeta.authors ? volMeta.authors.join(", ") : "Unknown");
      const tagList = ["Light Novel", ...manifest.tags];
      const tagsStr = Array.from(new Set(tagList)).join(",");

      const setArgs = [
        "set_metadata",
        "--with-library",
        SERVER_URL,
        String(calibreId),
        "--field",
        `title:${title}`,
        "--field",
        `authors:${author}`,
        "--field",
        `series:${manifest.seriesTitle}`,
        "--field",
        `series_index:${assignedIndex}`,
        "--field",
        `tags:${tagsStr}`,
      ];

      // Download and convert master cover art
      let coverPath: string | null = null;
      try {
        coverPath = await fetchAndConvertCover(volMeta.bookId, volMeta.coverImageUrl);
        if (coverPath && fs.existsSync(coverPath)) {
          setArgs.push("--field", `cover:${coverPath}`);
        }
      } catch (covErr: any) {
        console.warn(`[Lnori] Cover download failed for book ${volMeta.bookId}:`, covErr?.message || covErr);
      }

      const setRes = runCalibredb(setArgs);
      if (setRes.status !== 0) {
        console.warn(
          `[Lnori] Warning: set_metadata failed for Calibre #${calibreId}: ${setRes.stderr}`,
        );
      }

      if (coverPath && fs.existsSync(coverPath)) {
        try {
          fs.unlinkSync(coverPath);
        } catch {}
      }

      importedCount++;
    } finally {
      if (fs.existsSync(tempEpubPath)) {
        try {
          fs.unlinkSync(tempEpubPath);
        } catch {}
      }
    }
  }

  const tagsFormatted = ["Light Novel", ...manifest.tags].join(", ");

  return {
    success: importedCount > 0,
    seriesTitle: manifest.seriesTitle,
    author: manifest.author,
    tags: tagsFormatted,
    importedCount,
    totalCount,
    calibreBookIds,
  };
}
