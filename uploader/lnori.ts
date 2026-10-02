import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { Buffer } from "node:buffer";
import { spawnSync } from "node:child_process";
import { Database } from "bun:sqlite";
import { validateEpubContent, repairTruncatedEpub, safeFetchWithSsrf } from "./security";
import {
  isCommentsEmpty,
  sanitizeSynopsis,
  extractEpubDescription,
  fetchOnlineSynopsis,
  extractVolumeNumber,
} from "./scraper";

const PROXY_URL = "http://127.0.0.1:7890";
export const MAX_EPUB_BYTES = 256 * 1024 * 1024;
export const MAX_COVER_BYTES = 16 * 1024 * 1024;
export const MAX_HTML_BYTES = 8 * 1024 * 1024;
export const MAX_VOLUMES_PER_REQUEST = 50;
const SUBPROCESS_TIMEOUT_MS = 60_000;
const SUBPROCESS_MAX_BUFFER = 16 * 1024 * 1024;

export interface LnoriDependencies {
  fetch?: (url: string, init?: RequestInit) => Promise<Response>;
  spawnSync?: (...args: any[]) => any;
  sipsPath?: string;
  calibreDbPath?: string;
  isVolumeInLibrary?: (seriesTitle: string, volumeIndex: number, title: string) => boolean;
  sleep?: (ms: number) => Promise<void>;
  signal?: AbortSignal;
  fetchOnlineSynopsis?: typeof fetchOnlineSynopsis;
  force?: boolean;
}

export function composeSignal(timeoutMs: number, userSignal?: AbortSignal): AbortSignal {
  const timeoutSignal = AbortSignal.timeout(timeoutMs);
  if (!userSignal) return timeoutSignal;
  if (userSignal.aborted) return userSignal;
  if (typeof (AbortSignal as any).any === "function") {
    return (AbortSignal as any).any([timeoutSignal, userSignal]);
  }
  const controller = new AbortController();
  const onAbort = () => controller.abort(userSignal.reason || timeoutSignal.reason);
  userSignal.addEventListener("abort", onAbort, { once: true });
  timeoutSignal.addEventListener("abort", onAbort, { once: true });
  return controller.signal;
}

export function escapeTelegramMarkdown(text: string): string {
  if (!text) return "";
  return text.replace(/([_*`[\]\\])/g, "\\$1");
}

export function throwOnSubprocessTimeout(
  result: { error?: { code?: string; message?: string } },
  command: string,
): void {
  if (result.error?.code === "ETIMEDOUT") {
    throw new Error(`${command} timed out after ${SUBPROCESS_TIMEOUT_MS}ms`);
  }
}

async function cancelResponseBody(response: Response): Promise<void> {
  try {
    await response.body?.cancel();
  } catch {
    // The response is already being discarded.
  }
}

export async function streamResponseToFile(
  response: Response,
  destPath: string,
  maxBytes: number,
  label: string,
  onProgress?: (progressPercent: number) => void,
  options?: { activityTimeoutMs?: number; signal?: AbortSignal },
): Promise<void> {
  const contentLength = response.headers.get("content-length");
  const declaredLength = contentLength ? Number.parseInt(contentLength, 10) : NaN;
  if (Number.isFinite(declaredLength) && declaredLength > maxBytes) {
    await cancelResponseBody(response);
    await fs.promises.rm(destPath, { force: true });
    throw new Error(`${label} exceeds maximum size of ${maxBytes} bytes`);
  }

  if (!response.body) {
    await fs.promises.rm(destPath, { force: true });
    throw new Error(`${label} response contained no body`);
  }

  let receivedBytes = 0;
  let file: fs.promises.FileHandle | undefined;
  let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
  const activityTimeoutMs = options?.activityTimeoutMs;
  let activityTimer: ReturnType<typeof setTimeout> | undefined;

  try {
    file = await fs.promises.open(destPath, "w");
    reader = response.body.getReader();

    const activeReader = reader;
    const resetActivityTimer = (reject: (reason?: Error) => void) => {
      if (activityTimer) clearTimeout(activityTimer);
      if (activityTimeoutMs && activityTimeoutMs > 0) {
        activityTimer = setTimeout(() => {
          reject(new Error(`${label} stream stalled (no data received for ${activityTimeoutMs}ms)`));
        }, activityTimeoutMs);
      }
    };

    while (true) {
      if (options?.signal?.aborted) {
        throw new Error("Lnori ingestion aborted by client");
      }

      let readResult: ReadableStreamReadResult<Uint8Array>;
      if (activityTimeoutMs && activityTimeoutMs > 0) {
        readResult = await new Promise<ReadableStreamReadResult<Uint8Array>>((resolve, reject) => {
          let settled = false;
          let abortListener: (() => void) | undefined;

          if (options?.signal) {
            abortListener = () => {
              if (!settled) {
                settled = true;
                if (activityTimer) clearTimeout(activityTimer);
                activeReader.cancel().catch(() => {});
                reject(new Error("Lnori ingestion aborted by client"));
              }
            };
            options.signal.addEventListener("abort", abortListener, { once: true });
          }

          resetActivityTimer((stallErr) => {
            if (!settled) {
              settled = true;
              if (options?.signal && abortListener) {
                options.signal.removeEventListener("abort", abortListener);
              }
              activeReader.cancel().catch(() => {});
              reject(stallErr);
            }
          });

          activeReader.read().then(
            (val) => {
              if (!settled) {
                settled = true;
                if (activityTimer) clearTimeout(activityTimer);
                if (options?.signal && abortListener) {
                  options.signal.removeEventListener("abort", abortListener);
                }
                resolve(val);
              }
            },
            (err) => {
              if (!settled) {
                settled = true;
                if (activityTimer) clearTimeout(activityTimer);
                if (options?.signal && abortListener) {
                  options.signal.removeEventListener("abort", abortListener);
                }
                activeReader.cancel().catch(() => {});
                reject(err);
              }
            },
          );
        });
      } else {
        readResult = await activeReader.read();
      }

      const { done, value: chunk } = readResult;
      if (done) break;
      if (!chunk) continue;

      const bytes = chunk instanceof Uint8Array ? chunk : new Uint8Array(chunk);
      receivedBytes += bytes.byteLength;
      if (receivedBytes > maxBytes) {
        try {
          await reader.cancel();
        } catch {
          // ignore
        }
        throw new Error(`${label} exceeds maximum size of ${maxBytes} bytes`);
      }
      await file.write(bytes);
      if (onProgress && declaredLength > 0) {
        onProgress(Math.min(100, Math.round((receivedBytes / declaredLength) * 100)));
      }
    }
  } catch (err) {
    try {
      await reader?.cancel();
    } catch {
      // ignore
    }
    await fs.promises.rm(destPath, { force: true });
    throw err;
  } finally {
    if (activityTimer) clearTimeout(activityTimer);
    try {
      await reader?.cancel();
    } catch {
      // stream might already be closed/cancelled
    }
    await file?.close();
  }
}

export async function readResponseTextWithLimit(
  response: Response,
  maxBytes: number,
  label: string,
): Promise<string> {
  const contentLength = response.headers.get("content-length");
  const declaredLength = contentLength ? Number.parseInt(contentLength, 10) : NaN;
  if (Number.isFinite(declaredLength) && declaredLength > maxBytes) {
    await cancelResponseBody(response);
    throw new Error(`${label} exceeds maximum size of ${maxBytes} bytes`);
  }
  if (!response.body) throw new Error(`${label} response contained no body`);

  const chunks: Uint8Array[] = [];
  let receivedBytes = 0;
  try {
    for await (const chunk of response.body as AsyncIterable<Uint8Array>) {
      const bytes = chunk instanceof Uint8Array ? chunk : new Uint8Array(chunk);
      receivedBytes += bytes.byteLength;
      if (receivedBytes > maxBytes) {
        await cancelResponseBody(response);
        throw new Error(`${label} exceeds maximum size of ${maxBytes} bytes`);
      }
      chunks.push(bytes);
    }
  } catch (err) {
    await cancelResponseBody(response);
    throw err;
  }
  return Buffer.concat(chunks.map((chunk) => Buffer.from(chunk))).toString("utf8");
}

export function validateLnoriBookId(bookId: unknown): string {
  if (!/^[0-9]+$/.test(String(bookId))) throw new Error("Invalid non-numeric book ID");
  return String(bookId);
}

export function isMissingCentralDirectoryOrUnreadable(error?: string): boolean {
  if (!error) return false;
  const lower = error.toLowerCase();
  return (
    lower.includes("failed to read epub zip entries") ||
    lower.includes("central directory") ||
    lower.includes("end-of-central-directory") ||
    lower.includes("unreadable") ||
    lower.includes("truncated") ||
    lower.includes("damaged") ||
    lower.includes("cannot find zipfile directory")
  );
}

export function validateDownloadedEpub(destPath: string): void {
  const validation = validateEpubContent(destPath) as { valid?: boolean; isValid?: boolean; error?: string };
  const isValid = validation.valid ?? validation.isValid ?? false;
  if (!isValid) {
    if (isMissingCentralDirectoryOrUnreadable(validation.error)) {
      const repaired = repairTruncatedEpub(destPath);
      if (repaired) {
        console.log(`[Lnori] Successfully auto-healed truncated EPUB with missing central directory: ${destPath}`);
        return;
      }
    }

    try {
      fs.unlinkSync(destPath);
    } catch {
      // Preserve the validation error if the file was already removed.
    }
    throw new Error(`Downloaded EPUB failed validation: ${validation.error || "invalid EPUB"}`);
  }
}
const SERVER_URL = "http://127.0.0.1:8088";
const USER_AGENT = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";

export function getCalibreDbPath(): string {
  if (process.env.CALIBRE_DB_PATH) return process.env.CALIBRE_DB_PATH;
  if (process.env.CALIBRE_LIBRARY_DIR) {
    return path.join(process.env.CALIBRE_LIBRARY_DIR, "metadata.db");
  }
  const home = process.env.HOME || os.homedir();
  return path.join(
    home,
    "Calibre Libraries",
    "Agent Library",
    "metadata.db",
  );
}

export function isVolumeAlreadyInCalibre(
  seriesTitle: string,
  assignedIndex: number,
  title: string,
  dependencies?: LnoriDependencies,
): boolean {
  if (dependencies?.force) {
    return false;
  }
  if (dependencies?.isVolumeInLibrary) {
    return dependencies.isVolumeInLibrary(seriesTitle, assignedIndex, title);
  }

  const dbPath = dependencies?.calibreDbPath || getCalibreDbPath();
  if (fs.existsSync(dbPath)) {
    try {
      const db = new Database(dbPath, { readonly: true });
      db.run("PRAGMA busy_timeout = 2000;");

      const seriesMatch = db.query(`
        SELECT b.id FROM books b
        JOIN books_series_link bsl ON b.id = bsl.book
        JOIN series s ON bsl.series = s.id
        WHERE LOWER(TRIM(s.name)) = LOWER(TRIM(?))
          AND ROUND(b.series_index, 2) = ROUND(?, 2)
        LIMIT 1
      `).get(seriesTitle, assignedIndex);

      if (seriesMatch) {
        db.close();
        return true;
      }

      const titleMatch = db.query(`
        SELECT b.id FROM books b
        WHERE LOWER(TRIM(b.title)) = LOWER(TRIM(?))
        LIMIT 1
      `).get(title);

      if (titleMatch) {
        db.close();
        return true;
      }

      // Additional resilient check: check if any book has title matching series and exact volume number
      const normSeries = seriesTitle.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
      if (normSeries && normSeries.length >= 3) {
        const titleSearchPrefix = seriesTitle.slice(0, 20).toLowerCase();
        const candidateRows = db.query(`
          SELECT b.id, b.title, b.series_index FROM books b
          WHERE LOWER(b.title) LIKE ?
          LIMIT 100
        `).all(`%${titleSearchPrefix}%`);

        for (const row of candidateRows as any[]) {
          const rowTitle = (row.title || "").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
          if (rowTitle && (rowTitle.includes(normSeries) || normSeries.includes(rowTitle))) {
            let rowVol: number | null = null;
            if (
              row.series_index !== undefined &&
              row.series_index !== null &&
              !isNaN(Number(row.series_index)) &&
              Number(row.series_index) > 0
            ) {
              rowVol = Number(row.series_index);
            } else if (row.title) {
              rowVol = extractVolumeNumber(row.title);
            }
            if (rowVol !== null && Math.abs(rowVol - assignedIndex) < 0.01) {
              db.close();
              return true;
            }
          }
        }
      }

      db.close();
    } catch (err: any) {
      console.warn(`[Lnori] SQLite duplicate check failed, trying calibredb: ${err?.message || err}`);
    }
  }

  // Fallback: calibredb list
  try {
    const safeSeries = seriesTitle.replace(/"/g, '\\"');
    const listRes = runCalibredb([
      "list",
      "--with-library",
      SERVER_URL,
      "--search",
      `series:"="${safeSeries}"" and series_index:=${assignedIndex}`,
      "--for-machine",
    ], dependencies);
    if (listRes.status === 0 && listRes.stdout) {
      try {
        const parsed = JSON.parse(listRes.stdout);
        if (Array.isArray(parsed) && parsed.length > 0) {
          return true;
        }
      } catch {
        // ignore parse error on invalid JSON
      }
    }

    const safeTitle = title.replace(/"/g, '\\"');
    const titleRes = runCalibredb([
      "list",
      "--with-library",
      SERVER_URL,
      "--search",
      `title:"="${safeTitle}""`,
      "--for-machine",
    ], dependencies);
    if (titleRes.status === 0 && titleRes.stdout) {
      try {
        const parsed = JSON.parse(titleRes.stdout);
        if (Array.isArray(parsed) && parsed.length > 0) {
          return true;
        }
      } catch {
        // ignore parse error on invalid JSON
      }
    }
  } catch {
    // Ignore fallback failure
  }

  return false;
}

export function getCalibredbPath(dependencies?: LnoriDependencies): string {
  if (process.env.CALIBREDB_PATH) return process.env.CALIBREDB_PATH;
  const runSpawnSync = dependencies?.spawnSync ?? spawnSync;
  const probe = runSpawnSync("which", ["calibredb"], {
    encoding: "utf8",
    timeout: SUBPROCESS_TIMEOUT_MS,
    maxBuffer: SUBPROCESS_MAX_BUFFER,
  });
  throwOnSubprocessTimeout(probe, "which calibredb");
  if (probe?.status === 0 && probe.stdout?.trim()) return probe.stdout.trim();
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
  const probe = spawnSync("which", ["sips"], {
    encoding: "utf8",
    timeout: SUBPROCESS_TIMEOUT_MS,
    maxBuffer: SUBPROCESS_MAX_BUFFER,
  });
  throwOnSubprocessTimeout(probe, "which sips");
  if (probe.status === 0 && probe.stdout?.trim()) return probe.stdout.trim();
  if (fs.existsSync("/usr/bin/sips")) return "/usr/bin/sips";
  return "sips";
}

export function runCalibredb(
  args: string[],
  dependencies?: LnoriDependencies,
): { status: number | null; stdout: string; stderr: string } {
  const env: any = { ...process.env };
  delete env.HTTP_PROXY;
  delete env.http_proxy;
  delete env.HTTPS_PROXY;
  delete env.https_proxy;
  delete env.ALL_PROXY;
  delete env.all_proxy;
  env.PATH = `/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:${env.PATH || ""}`;

  const runSpawnSync = dependencies?.spawnSync ?? spawnSync;
  const calibredbBin = getCalibredbPath(dependencies);
  const res = runSpawnSync(calibredbBin, args, {
    encoding: "utf8",
    env,
    timeout: SUBPROCESS_TIMEOUT_MS,
    maxBuffer: SUBPROCESS_MAX_BUFFER,
  });
  throwOnSubprocessTimeout(res, "calibredb");
  if (res.error) {
    throw new Error(`Failed to run calibredb: ${res.error.message}`);
  }

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
  description?: string;
}

export interface LnoriSeriesManifest {
  type: "series" | "book";
  seriesId: string;
  seriesTitle: string;
  author: string;
  tags: string[];
  volumePaths: string[];
  description?: string;
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

    let description: string | undefined;
    if (schemaData?.description) {
      description = sanitizeSynopsis(schemaData.description);
    } else if (appData?.description) {
      description = sanitizeSynopsis(appData.description);
    }
    if (description && isCommentsEmpty(description)) {
      description = undefined;
    }

    return {
      type: "series",
      seriesId: parsedUrl.id,
      seriesTitle,
      author: author || "Unknown",
      tags,
      volumePaths,
      description,
    };
  } else {
    // Book URL: treat as 1-volume series
    let bookName = "";
    let description: string | undefined;

    const data = appData || schemaData;
    if (data) {
      if (data.name) bookName = data.name;
      if (data.description) {
        description = sanitizeSynopsis(data.description);
        if (isCommentsEmpty(description)) description = undefined;
      }
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
      description,
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
    let description: string | undefined = data.description
      ? sanitizeSynopsis(data.description)
      : undefined;

    if (!description) {
      const ldMatches = Array.from(
        html.matchAll(
          /<script[^>]*type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi,
        ),
      );
      for (const m of ldMatches) {
        try {
          const parsed = JSON.parse(m[1]);
          if (parsed.description) {
            description = sanitizeSynopsis(parsed.description);
            break;
          }
        } catch (_err) {
          void _err;
        }
      }
    }
    if (description && isCommentsEmpty(description)) {
      description = undefined;
    }

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
    const volNumCandidate =
      extractVolumeNumber(name) ??
      (epubFilename ? extractVolumeNumber(epubFilename) : null);
    if (volNumCandidate !== null && !Number.isNaN(volNumCandidate)) {
      volumeNumber = volNumCandidate;
    } else {
      const volMatch = `${name} ${epubFilename}`.match(
        /(?:vol(?:ume)?\.?|#)\s*([0-9]+(?:\.[0-9]+)?)/i,
      );
      if (volMatch) {
        const parsedVol = parseFloat(volMatch[1]);
        if (!Number.isNaN(parsedVol)) volumeNumber = parsedVol;
      }
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
      description,
    };
  } catch {
    return null;
  }
}

export async function fetchLnoriHtml(
  targetUrl: string,
  dependencies?: LnoriDependencies,
): Promise<string> {
  const fetcher = dependencies?.fetch ?? safeFetchWithSsrf;
  let res: Response;
  let directUsed = true;
  try {
    // Attempt direct connection first for maximum speed
    res = await fetcher(targetUrl, {
      headers: {
        "User-Agent": USER_AGENT,
        Referer: "https://lnori.com/",
      },
      signal: composeSignal(30000, dependencies?.signal),
    } as any);
  } catch (err: any) {
    if (
      dependencies?.signal?.aborted ||
      err?.name === "AbortError" ||
      err?.message?.includes("aborted")
    ) {
      throw new Error("Lnori ingestion aborted by client");
    }
    // If direct connection failed or threw, fall back to proxy
    res = await fetcher(targetUrl, {
      headers: {
        "User-Agent": USER_AGENT,
        Referer: "https://lnori.com/",
      },
      proxy: PROXY_URL,
      signal: composeSignal(30000, dependencies?.signal),
    } as any);
    directUsed = false;
  }

  if (directUsed && !res.ok) {
    await cancelResponseBody(res);
    if (dependencies?.signal?.aborted) {
      throw new Error("Lnori ingestion aborted by client");
    }
    res = await fetcher(targetUrl, {
      headers: {
        "User-Agent": USER_AGENT,
        Referer: "https://lnori.com/",
      },
      proxy: PROXY_URL,
      signal: composeSignal(30000, dependencies?.signal),
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
        let sDirectUsed = true;
        try {
          // Direct first for sitemap
          sRes = await fetcher(sitemapPath, {
            headers: { "User-Agent": USER_AGENT },
            signal: composeSignal(20000, dependencies?.signal),
          } as any);
        } catch {
          if (dependencies?.signal?.aborted) {
            throw new Error("Lnori ingestion aborted by client");
          }
          // Fallback to proxy
          sRes = await fetcher(sitemapPath, {
            headers: { "User-Agent": USER_AGENT },
            proxy: PROXY_URL,
            signal: composeSignal(20000, dependencies?.signal),
          } as any);
          sDirectUsed = false;
        }
        if (sDirectUsed && !sRes.ok) {
          await cancelResponseBody(sRes);
          if (dependencies?.signal?.aborted) {
            throw new Error("Lnori ingestion aborted by client");
          }
          sRes = await fetcher(sitemapPath, {
            headers: { "User-Agent": USER_AGENT },
            proxy: PROXY_URL,
            signal: composeSignal(20000, dependencies?.signal),
          } as any);
        }
        if (sRes.ok) {
          const xml = await readResponseTextWithLimit(sRes, MAX_HTML_BYTES, "Lnori sitemap");
          const regex = new RegExp(
            `<loc>(https://lnori\\.com/${parsed.type}/${parsed.id}[^<]*)</loc>`,
            "i",
          );
          const smMatch = xml.match(regex);
          if (smMatch && smMatch[1] && smMatch[1] !== targetUrl) {
            return await fetchLnoriHtml(smMatch[1], dependencies);
          }
        }
      } catch (smErr: any) {
        if (
          dependencies?.signal?.aborted ||
          smErr?.name === "AbortError" ||
          smErr?.message?.includes("aborted")
        ) {
          throw smErr;
        }
        // ignore sitemap fallback failure
      }
    }
    throw new Error(`Lnori URL returned HTTP 404: ${targetUrl}`);
  }

  if (!res.ok) {
    throw new Error(`Failed to fetch Lnori URL (${res.status}): ${targetUrl}`);
  }

  return await readResponseTextWithLimit(res, MAX_HTML_BYTES, "Lnori HTML");
}

export async function downloadLnoriEpub(
  epubFilename: string,
  destPath: string,
  onProgress?: (progressPercent: number) => void,
  dependencies?: LnoriDependencies,
): Promise<void> {
  const fetcher = dependencies?.fetch ?? safeFetchWithSsrf;
  const downloadUrl = `https://files.lnori.com/${encodeURIComponent(epubFilename)}`;
  const isTestEnv =
    process.argv.some((a: string) => a.includes(".test.") || a.includes("test")) ||
    process.env.NODE_ENV === "test";
  const sleep =
    dependencies?.sleep ??
    ((ms: number) => new Promise((resolve) => setTimeout(resolve, isTestEnv ? 0 : ms)));

  const MAX_RETRIES = 3;
  let lastError: any = null;
  let forceProxy = false;

  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    if (dependencies?.signal?.aborted) {
      throw new Error("Lnori ingestion aborted by client");
    }

    if (attempt > 0) {
      const backoffMs = Math.min(10000, 1000 * 2 ** (attempt - 1));
      await sleep(backoffMs);
    }

    if (dependencies?.signal?.aborted) {
      throw new Error("Lnori ingestion aborted by client");
    }

    try {
      const runFetch = async (useProxy: boolean): Promise<Response> => {
        // Disarmable TTFB controller: only bounds the time until response headers arrive.
        // Once fetcher resolves, ttfbTimer is cleared so active body streaming is not aborted.
        const ttfbController = new AbortController();
        const ttfbTimeoutMs = useProxy ? 30000 : 60000;
        let ttfbTimer: ReturnType<typeof setTimeout> | undefined = setTimeout(() => {
          const timeoutErr = new Error(`Connection timed out waiting for headers (${ttfbTimeoutMs}ms)`);
          timeoutErr.name = "TimeoutError";
          ttfbController.abort(timeoutErr);
        }, ttfbTimeoutMs);

        let abortListener: (() => void) | undefined;
        if (dependencies?.signal) {
          if (dependencies.signal.aborted) {
            clearTimeout(ttfbTimer);
            ttfbController.abort(dependencies.signal.reason);
          } else {
            abortListener = () => {
              if (ttfbTimer) clearTimeout(ttfbTimer);
              ttfbController.abort(dependencies?.signal?.reason);
            };
            dependencies.signal.addEventListener("abort", abortListener, { once: true });
          }
        }

        const headers = {
          Referer: "https://lnori.com/",
          "User-Agent": USER_AGENT,
        };
        const fetchOptions: RequestInit & { proxy?: string } = {
          headers,
          signal: ttfbController.signal,
        };
        if (useProxy) {
          fetchOptions.proxy = PROXY_URL;
        }

        try {
          const response = await fetcher(downloadUrl, fetchOptions);
          // Headers received: clear the TTFB timer immediately so body reads are not killed
          if (ttfbTimer) {
            clearTimeout(ttfbTimer);
            ttfbTimer = undefined;
          }
          return response;
        } catch (fetchErr) {
          if (ttfbTimer) {
            clearTimeout(ttfbTimer);
            ttfbTimer = undefined;
          }
          throw fetchErr;
        } finally {
          if (dependencies?.signal && abortListener) {
            dependencies.signal.removeEventListener("abort", abortListener);
          }
        }
      };

      let res: Response;
      if (forceProxy) {
        res = await runFetch(true);
      } else {
        let directUsed = true;
        try {
          res = await runFetch(false);
        } catch (directErr: any) {
          if (
            dependencies?.signal?.aborted ||
            directErr?.name === "AbortError" ||
            directErr?.message?.includes("aborted")
          ) {
            throw directErr;
          }
          // Direct fetch threw, timed out, or connection failed: fall back to proxy
          res = await runFetch(true);
          directUsed = false;
        }

        if (directUsed && !res.ok) {
          await cancelResponseBody(res);
          if (dependencies?.signal?.aborted) {
            throw new Error("Lnori ingestion aborted by client");
          }
          forceProxy = true;
          res = await runFetch(true);
        }
      }

      if (!res.ok) {
        lastError = new Error(
          `Failed to download EPUB from Lnori storage (${res.status}): ${downloadUrl}`,
        );
        if ((res.status >= 500 || res.status === 429) && attempt < MAX_RETRIES) {
          await cancelResponseBody(res);
          continue;
        }
        throw lastError;
      }

      await streamResponseToFile(
        res,
        destPath,
        MAX_EPUB_BYTES,
        "Downloaded EPUB",
        onProgress,
        {
          activityTimeoutMs: 60000,
          signal: dependencies?.signal,
        },
      );
      lastError = null;
      break;
    } catch (err: any) {
      lastError = err;
      try {
        await fs.promises.rm(destPath, { force: true });
      } catch {
        // ignore cleanup error if file was already removed
      }

      if (dependencies?.signal?.aborted) {
        throw err;
      }

      if (
        err?.message?.includes("exceeds maximum size") ||
        err?.message?.includes("contained no body") ||
        err?.message?.includes("Failed to download EPUB from Lnori storage (4")
      ) {
        throw err;
      }

      if (attempt < MAX_RETRIES) {
        continue;
      }
      throw err;
    }
  }

  if (lastError) {
    throw lastError;
  }

  validateDownloadedEpub(destPath);
}

export async function fetchAndConvertCover(
  lnoriBookId: string,
  fallbackCoverUrl: string | undefined,
  workDir: string | undefined,
  dependencies?: LnoriDependencies,
): Promise<string | null> {
  const fetcher = dependencies?.fetch ?? safeFetchWithSsrf;
  const runSpawnSync = dependencies?.spawnSync ?? spawnSync;
  const bookId = validateLnoriBookId(lnoriBookId);
  if (!workDir) throw new Error("Lnori cover work directory is required");
  const rawCoverPath = path.join(workDir, "cover.raw");
  const jpegCoverPath = path.join(workDir, "cover.jpg");

  const urlsToTry = [
    `https://cdn.lnori.com/cover/${bookId}.webp`,
    fallbackCoverUrl,
  ].filter(Boolean) as string[];

  let downloaded = false;
  for (const cUrl of urlsToTry) {
    try {
      let res: Response;
      let directUsed = true;
      try {
        // Direct first for cover download
        res = await fetcher(cUrl, {
          headers: {
            Referer: "https://lnori.com/",
            "User-Agent": USER_AGENT,
          },
          signal: composeSignal(20000, dependencies?.signal),
        } as any);
      } catch (directErr: any) {
        if (
          dependencies?.signal?.aborted ||
          directErr?.name === "AbortError" ||
          directErr?.message?.includes("aborted")
        ) {
          throw new Error("Lnori ingestion aborted by client");
        }
        // Fall back to proxy
        res = await fetcher(cUrl, {
          headers: {
            Referer: "https://lnori.com/",
            "User-Agent": USER_AGENT,
          },
          proxy: PROXY_URL,
          signal: composeSignal(20000, dependencies?.signal),
        } as any);
        directUsed = false;
      }

      if (directUsed && !res.ok) {
        await cancelResponseBody(res);
        if (dependencies?.signal?.aborted) {
          throw new Error("Lnori ingestion aborted by client");
        }
        // Direct returned non-OK: fall back to proxy for the same candidate before trying next
        res = await fetcher(cUrl, {
          headers: {
            Referer: "https://lnori.com/",
            "User-Agent": USER_AGENT,
          },
          proxy: PROXY_URL,
          signal: composeSignal(20000, dependencies?.signal),
        } as any);
      }

      if (res.ok) {
        await streamResponseToFile(res, rawCoverPath, MAX_COVER_BYTES, "Lnori cover");
        downloaded = true;
        break;
      } else {
        await cancelResponseBody(res);
      }
    } catch (err: any) {
      if (
        dependencies?.signal?.aborted ||
        err?.name === "AbortError" ||
        err?.message?.includes("aborted")
      ) {
        throw new Error("Lnori ingestion aborted by client");
      }
      // try next
    }
  }

  if (!downloaded || !fs.existsSync(rawCoverPath)) {
    return null;
  }

  try {
    const sipsBin = dependencies?.sipsPath ?? getSipsPath();
    const sipsRes = runSpawnSync(
      sipsBin,
      ["-s", "format", "jpeg", rawCoverPath, "--out", jpegCoverPath],
      {
        encoding: "utf8",
        timeout: SUBPROCESS_TIMEOUT_MS,
        maxBuffer: SUBPROCESS_MAX_BUFFER,
      },
    );
    throwOnSubprocessTimeout(sipsRes, "sips");
    if (sipsRes.error) {
      throw new Error(`Failed to run sips: ${sipsRes.error.message}`);
    }

    if (sipsRes.status === 0 && fs.existsSync(jpegCoverPath)) {
      return jpegCoverPath;
    }
    return null;
  } finally {
    await fs.promises.rm(rawCoverPath, { force: true });
  }
}

export interface LnoriProgressEvent {
  phase: "manifest" | "volume" | "complete" | "error";
  index?: number;
  total?: number;
  volumeTitle?: string;
  status?: string;
  data?: any;
}

export type LnoriProgressCallback = (
  event: LnoriProgressEvent,
) => Promise<void> | void;

export function formatLnoriProgress(event: LnoriProgressEvent): string {
  if (event.status) return event.status;
  if (event.phase === "manifest") {
    return event.volumeTitle
      ? `Found ${event.total || 0} volumes in series "${event.volumeTitle}"`
      : "Inspecting Lnori manifest...";
  }
  if (event.phase === "volume") {
    return `[Volume ${event.index || 1}/${event.total || 1}] ${event.volumeTitle || ""}`;
  }
  if (event.phase === "complete") {
    return `Completed: ${event.data?.importedCount || 0} imported, ${event.data?.skippedCount || 0} skipped`;
  }
  return `[Lnori ${event.phase}]`;
}

async function reportProgress(
  onProgress: LnoriProgressCallback | ((event: any) => any) | undefined,
  event: LnoriProgressEvent,
): Promise<void> {
  if (!onProgress) return;
  try {
    await onProgress(event);
  } catch (err) {
    console.warn("[Lnori] onProgress callback threw error:", err);
  }
}

export interface IngestLnoriResult {
  success: boolean;
  seriesTitle: string;
  author: string;
  tags: string;
  importedCount: number;
  skippedCount: number;
  duplicateCount: number;
  skippedErrors?: number;
  totalCount: number;
  calibreBookIds: number[];
  error?: string;
}

export async function ingestLnoriSeries(
  url: string,
  onProgress?: LnoriProgressCallback | ((text: string) => Promise<void>),
  dependencies?: LnoriDependencies,
): Promise<IngestLnoriResult> {
  const parsed = parseLnoriUrl(url);
  if (!parsed) {
    throw new Error(`Invalid Lnori URL: ${url}`);
  }

  await reportProgress(onProgress, {
    phase: "manifest",
    status: `_Fetching volume manifest for Lnori ${parsed.type}..._`,
    data: { action: "fetching_manifest", type: parsed.type, url },
  });

  const html = await fetchLnoriHtml(url, dependencies);
  const manifest = extractManifestFromHtml(html, url, parsed);

  if (manifest.volumePaths.length === 0) {
    throw new Error(`No volumes found in Lnori ${manifest.type} manifest for: ${url}`);
  }
  if (manifest.volumePaths.length > MAX_VOLUMES_PER_REQUEST) {
    throw new Error(
      `Lnori manifest contains ${manifest.volumePaths.length} volumes; maximum allowed is ${MAX_VOLUMES_PER_REQUEST} per request`,
    );
  }

  if (dependencies?.signal?.aborted) {
    throw new Error("Lnori ingestion aborted by client");
  }

  const totalCount = manifest.volumePaths.length;
  let importedCount = 0;
  let duplicateCount = 0;
  let skippedMissing = 0;
  let skippedErrors = 0;
  const calibreBookIds: number[] = [];
  const seriesCache = new Map<string, { description: string; coverUrl?: string; source?: string }>();

  await reportProgress(onProgress, {
    phase: "manifest",
    total: totalCount,
    volumeTitle: manifest.seriesTitle,
    status: `Found ${totalCount} volume${totalCount === 1 ? "" : "s"} in series "${manifest.seriesTitle}"`,
    data: {
      action: "manifest_ready",
      seriesTitle: manifest.seriesTitle,
      author: manifest.author,
      totalCount,
      tags: manifest.tags,
    },
  });

  const workDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "lnori-"));

  try {
    for (let idx = 0; idx < totalCount; idx++) {
      if (dependencies?.signal?.aborted) {
        throw new Error("Lnori ingestion aborted by client");
      }

      const volPath = manifest.volumePaths[idx];
      const fullVolUrl = volPath.startsWith("http")
        ? volPath
        : `https://lnori.com${volPath.startsWith("/") ? "" : "/"}${volPath}`;
      const volNum = idx + 1;

      await reportProgress(onProgress, {
        phase: "volume",
        index: volNum,
        total: totalCount,
        volumeTitle: `${manifest.seriesTitle} (Vol ${volNum})`,
        status: `_[Volume ${escapeTelegramMarkdown(String(volNum))}/${escapeTelegramMarkdown(String(totalCount))}] Inspecting volume metadata..._\n\`${escapeTelegramMarkdown(fullVolUrl)}\``,
        data: {
          action: "inspecting",
          volumeIndex: volNum,
          volumeUrl: fullVolUrl,
        },
      });

      let volMeta: LnoriVolumeMetadata | null = null;
      try {
        const volHtml = await fetchLnoriHtml(fullVolUrl, dependencies);
        const volParsedUrl = parseLnoriUrl(fullVolUrl);
        volMeta = parseVolumeAppData(volHtml, volParsedUrl?.id);
      } catch (err: any) {
        if (
          dependencies?.signal?.aborted ||
          err?.name === "AbortError" ||
          err?.message?.includes("aborted")
        ) {
          throw err;
        }
        console.error(`[Lnori] Failed to inspect volume ${volPath}:`, err?.message || err);
      }

      if (!volMeta || !volMeta.epubFilename) {
        console.warn(`[Lnori] Skipping volume without epub_filename: ${volPath}`);
        await reportProgress(onProgress, {
          phase: "volume",
          index: volNum,
          total: totalCount,
          volumeTitle: `${manifest.seriesTitle} (Vol ${volNum})`,
          status: `[Volume ${volNum}/${totalCount}] Skipping volume without EPUB filename`,
          data: {
            action: "skipped",
            reason: "missing_epub",
            volumeIndex: volNum,
          },
        });
        skippedMissing++;
        continue;
      }

      const assignedIndex = volMeta.volumeNumber === undefined ? volNum : volMeta.volumeNumber;
      const title = `${manifest.seriesTitle}: Volume ${assignedIndex}`;

      // Pre-download duplicate detection: check if volume already exists in Calibre
      if (isVolumeAlreadyInCalibre(manifest.seriesTitle, assignedIndex, title, dependencies)) {
        console.log(
          `[Lnori] Volume ${assignedIndex} of "${manifest.seriesTitle}" already in library, skipping`,
        );
        await reportProgress(onProgress, {
          phase: "volume",
          index: volNum,
          total: totalCount,
          volumeTitle: title,
          status: `_[Volume ${escapeTelegramMarkdown(String(volNum))}/${escapeTelegramMarkdown(String(totalCount))}] Volume ${escapeTelegramMarkdown(String(assignedIndex))} already in library, skipping..._`,
          data: {
            action: "skipped",
            reason: "already_exists",
            volumeIndex: assignedIndex,
            title,
          },
        });
        duplicateCount++;
        continue;
      }

      await reportProgress(onProgress, {
        phase: "volume",
        index: volNum,
        total: totalCount,
        volumeTitle: title,
        status: `_[Volume ${escapeTelegramMarkdown(String(volNum))}/${escapeTelegramMarkdown(String(totalCount))}] Downloading EPUB..._\n*${escapeTelegramMarkdown(volMeta.epubFilename)}*`,
        data: {
          action: "downloading",
          volumeIndex: assignedIndex,
          title,
          epubFilename: volMeta.epubFilename,
        },
      });

      const tempEpubPath = path.join(workDir, `volume-${volNum}.epub`);
      let coverPath: string | null = null;

      try {
        const bookId = validateLnoriBookId(volMeta.bookId);
        await downloadLnoriEpub(volMeta.epubFilename, tempEpubPath, undefined, dependencies);

        await reportProgress(onProgress, {
          phase: "volume",
          index: volNum,
          total: totalCount,
          volumeTitle: title,
          status: `_[Volume ${escapeTelegramMarkdown(String(volNum))}/${escapeTelegramMarkdown(String(totalCount))}] Ingesting into Calibre library..._\n*Volume ${escapeTelegramMarkdown(String(assignedIndex))}*`,
          data: {
            action: "adding_calibre",
            volumeIndex: assignedIndex,
            title,
          },
        });

        // Add to Calibre
        const addRes = runCalibredb([
          "add",
          "--with-library",
          SERVER_URL,
          tempEpubPath,
        ], dependencies);

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

        // Extract synopsis from volMeta.description, or fallback to EPUB content.opf <dc:description>
        let synopsis: string | null = null;
        if (volMeta.description && !isCommentsEmpty(volMeta.description)) {
          synopsis = volMeta.description;
        }
        if (!synopsis && fs.existsSync(tempEpubPath)) {
          synopsis = extractEpubDescription(tempEpubPath);
        }
        if (!synopsis && manifest.description && !isCommentsEmpty(manifest.description)) {
          synopsis = manifest.description;
        }

        if (synopsis && !isCommentsEmpty(synopsis)) {
          setArgs.push("--field", `comments:${synopsis}`);
        }

        // Download and convert master cover art
        try {
          if (volMeta.coverImageUrl) {
            await reportProgress(onProgress, {
              phase: "volume",
              index: volNum,
              total: totalCount,
              volumeTitle: title,
              status: `Converting WebP cover for Volume ${assignedIndex}...`,
              data: {
                action: "converting_cover",
                volumeIndex: assignedIndex,
                title,
              },
            });
          }
          coverPath = await fetchAndConvertCover(bookId, volMeta.coverImageUrl, workDir, dependencies);
          if (coverPath && fs.existsSync(coverPath)) {
            setArgs.push("--field", `cover:${coverPath}`);
          }
        } catch (covErr: any) {
          if (
            dependencies?.signal?.aborted ||
            covErr?.name === "AbortError" ||
            covErr?.message?.includes("aborted")
          ) {
            throw covErr;
          }
          console.warn(`[Lnori] Cover download failed for book ${volMeta.bookId}:`, covErr?.message || covErr);
        }

        if (dependencies?.signal?.aborted) {
          throw new Error("Lnori ingestion aborted by client");
        }

        const setRes = runCalibredb(setArgs, dependencies);
        if (setRes.status !== 0) {
          console.warn(
            `[Lnori] Warning: set_metadata failed for Calibre #${calibreId}: ${setRes.stderr}`,
          );
        }

        // Online synopsis fallback: if synopsis is missing or empty, fetch online
        if (!synopsis || isCommentsEmpty(synopsis)) {
          if (dependencies?.signal?.aborted) {
            throw new Error("Lnori ingestion aborted by client");
          }
          try {
            const fetchOnline = dependencies?.fetchOnlineSynopsis ?? fetchOnlineSynopsis;
            const onlineRes = await fetchOnline(
              {
                id: calibreId,
                title,
                author,
                series: manifest.seriesTitle,
                series_index: assignedIndex,
                tags: tagsStr,
              },
              { seriesCache },
            );
            if (dependencies?.signal?.aborted) {
              throw new Error("Lnori ingestion aborted by client");
            }
            if (onlineRes?.description && !isCommentsEmpty(onlineRes.description)) {
              synopsis = onlineRes.description;
              const onlineSetRes = runCalibredb(
                [
                  "set_metadata",
                  String(calibreId),
                  "--with-library",
                  SERVER_URL,
                  "--field",
                  `comments:${synopsis}`,
                ],
                dependencies,
              );
              if (onlineSetRes.status !== 0) {
                console.warn(
                  `[Lnori] Warning: set_metadata (online synopsis) failed for Calibre #${calibreId}: ${onlineSetRes.stderr}`,
                );
              }
            }
          } catch (onlineErr: any) {
            if (
              dependencies?.signal?.aborted ||
              onlineErr?.name === "AbortError" ||
              String(onlineErr?.message || "").includes("aborted")
            ) {
              throw onlineErr;
            }
            console.debug(
              `[Lnori] Online synopsis lookup failed for volume ${assignedIndex} ("${title}"):`,
              onlineErr?.message || onlineErr,
            );
          }
        }

        if (coverPath && fs.existsSync(coverPath)) {
          try {
            fs.unlinkSync(coverPath);
          } catch {}
          coverPath = null;
        }

        importedCount++;

        await reportProgress(onProgress, {
          phase: "volume",
          index: volNum,
          total: totalCount,
          volumeTitle: title,
          status: `✓ Volume ${assignedIndex} imported successfully`,
          data: {
            action: "imported",
            volumeIndex: assignedIndex,
            title,
            calibreId,
          },
        });
      } catch (volErr: any) {
        if (
          dependencies?.signal?.aborted ||
          volErr?.name === "AbortError" ||
          volErr?.message?.includes("aborted")
        ) {
          throw volErr;
        }
        console.warn(
          `[Lnori] Volume ${assignedIndex} ("${title}") failed during ingestion:`,
          volErr?.message || volErr,
        );
        await reportProgress(onProgress, {
          phase: "volume",
          index: volNum,
          total: totalCount,
          volumeTitle: title,
          status: `_[Volume ${escapeTelegramMarkdown(String(volNum))}/${escapeTelegramMarkdown(String(totalCount))}] Skipped volume due to error, continuing with next volume..._\n*${escapeTelegramMarkdown(volMeta.epubFilename)}*`,
          data: {
            action: "skipped",
            reason: "import_error",
            volumeIndex: assignedIndex,
            title,
            error: volErr?.message || String(volErr),
          },
        });
        skippedErrors++;
      } finally {
        if (coverPath && fs.existsSync(coverPath)) {
          try {
            fs.unlinkSync(coverPath);
          } catch {}
        }
        if (fs.existsSync(tempEpubPath)) {
          try {
            fs.unlinkSync(tempEpubPath);
          } catch {}
        }
      }
    }
  } finally {
    await fs.promises.rm(workDir, { recursive: true, force: true });
  }

  const tagsFormatted = ["Light Novel", ...manifest.tags].join(", ");
  const totalSkipped = duplicateCount + skippedMissing + skippedErrors;

  const result: IngestLnoriResult = {
    success: importedCount > 0 || (duplicateCount > 0 && skippedErrors === 0) || (skippedMissing > 0 && skippedErrors === 0),
    seriesTitle: manifest.seriesTitle,
    author: manifest.author,
    tags: tagsFormatted,
    importedCount,
    skippedCount: totalSkipped,
    duplicateCount,
    skippedErrors,
    totalCount,
    calibreBookIds,
  };

  const summaryStatus = `Finished: ${importedCount} new volumes added, ${duplicateCount} existing volumes preserved.`;

  await reportProgress(onProgress, {
    phase: "complete",
    index: totalCount,
    total: totalCount,
    volumeTitle: manifest.seriesTitle,
    status: summaryStatus,
    data: {
      ...result,
      summary: summaryStatus,
    },
  });

  return result;
}
