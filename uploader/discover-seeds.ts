import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import type { DiscoveredNovel } from "./discover";

/**
 * Curated "New Releases" seed store.
 *
 * The New Releases tab is deliberately curated: a card only exists there when a real download
 * source (Lnori or Elsci.one) actually carries the title, which is what stops the tab from
 * filling up with AniList rows nobody can download. What used to go wrong is that the curated
 * list was compiled into the source and froze at 2020-2023 titles, so the tab advertised books
 * that were years old as "new".
 *
 * `scripts/refresh-discover-seeds.ts` regenerates this store on a schedule (see the
 * `com.ospeto.reading-discover-seeds` LaunchAgent) by asking the live catalogue for recently
 * started novels and keeping only those that pass the real-source gate. The reader below loads
 * the refreshed file when it is present, and reports its age (stale or not) so the UI can say
 * where the list came from; the compiled list is only used when no refreshed file exists yet.
 */

export const CURATED_SEED_STORE_VERSION = 1;

/** A refreshed list older than this is reported as stale so the UI can ask the user to verify. */
export const CURATED_SEED_MAX_AGE_MS = 14 * 24 * 60 * 60 * 1000;

export interface CuratedSeedStoreFile {
  version: number;
  generatedAt: string | null;
  source: "anilist";
  /** Every entry passed the real-download-source gate at generation time. */
  novels: DiscoveredNovel[];
}

export interface CuratedSeedLoadResult {
  novels: DiscoveredNovel[];
  /** Where the list came from; `null` when the compiled fallback was used. */
  generatedAt: string | null;
  origin: "refreshed" | "compiled";
  isStale: boolean;
  /** Set when a store file existed but could not be used, so the fallback is explainable. */
  error?: string;
}

export function getDefaultSeedStorePath(rootDir?: string): string {
  const root =
    rootDir ||
    process.env.LIGHTHOUSE_ROOT ||
    path.resolve((import.meta as { dir?: string }).dir || process.cwd(), "..");
  return path.resolve(root, "data", "discover-new-releases.json");
}

/**
 * Reads the refreshed curated list. Never throws: a missing, unreadable, malformed or stale
 * store falls back to the compiled list with the reason attached.
 */
export function loadCuratedNewReleaseSeeds(
  options?: { storePath?: string; compiledSeeds?: DiscoveredNovel[]; now?: number },
): CuratedSeedLoadResult {
  const compiledSeeds = options?.compiledSeeds ?? [];
  const storePath = options?.storePath ?? getDefaultSeedStorePath();
  const now = options?.now ?? Date.now();

  const fallback = (error?: string, isStale = false): CuratedSeedLoadResult => ({
    novels: compiledSeeds,
    generatedAt: null,
    origin: "compiled",
    isStale,
    error,
  });

  let raw: string;
  try {
    raw = fs.readFileSync(storePath, "utf8");
  } catch {
    // No refreshed store yet: the compiled list is the intended first-run behaviour.
    return fallback();
  }

  let parsed: Partial<CuratedSeedStoreFile>;
  try {
    parsed = JSON.parse(raw) as Partial<CuratedSeedStoreFile>;
  } catch (err: any) {
    return fallback(`seed store is not valid JSON: ${err?.message || err}`);
  }

  if (!Array.isArray(parsed.novels) || parsed.novels.length === 0) {
    return fallback("seed store contains no novels");
  }
  if (typeof parsed.version === "number" && parsed.version !== CURATED_SEED_STORE_VERSION) {
    return fallback(`seed store version ${parsed.version} is not ${CURATED_SEED_STORE_VERSION}`);
  }

  const novels = parsed.novels.filter(isUsableSeed);
  if (novels.length === 0) {
    return fallback("seed store entries were all unusable");
  }

  const generatedAt = typeof parsed.generatedAt === "string" ? parsed.generatedAt : null;
  const generatedMs = generatedAt ? Date.parse(generatedAt) : NaN;
  if (!Number.isFinite(generatedMs)) {
    return fallback("seed store has no readable generatedAt");
  }

  const age = now - generatedMs;
  if (age > CURATED_SEED_MAX_AGE_MS) {
    // A stale refreshed list is still far newer than the compiled one, so serve it and report it
    // as stale rather than regressing the tab to older titles.
    const days = Math.round(age / (24 * 60 * 60 * 1000));
    return {
      novels,
      generatedAt,
      origin: "refreshed",
      isStale: true,
      error: `refreshed seed list is ${days} day${days === 1 ? "" : "s"} old`,
    };
  }

  return { novels, generatedAt, origin: "refreshed", isStale: false };
}

/**
 * A curated entry is only usable when it still names a downloadable source; an entry without
 * one could never be ingested and would reintroduce the dead-card problem the gate removes.
 */
function isUsableSeed(value: unknown): value is DiscoveredNovel {
  if (!value || typeof value !== "object") return false;
  const novel = value as DiscoveredNovel;
  if (typeof novel.id !== "string" || !novel.id) return false;
  if (typeof novel.title !== "string" || !novel.title) return false;
  const urls = novel.sourceUrls || {};
  return Boolean(urls.lnori || urls.elscione || novel.primaryUrl);
}

/**
 * Writes the refreshed list atomically so a crash mid-write cannot leave a half file behind.
 */
export function writeCuratedNewReleaseSeeds(
  novels: DiscoveredNovel[],
  options?: { storePath?: string; generatedAt?: string },
): string {
  const storePath = options?.storePath ?? getDefaultSeedStorePath();
  const payload: CuratedSeedStoreFile = {
    version: CURATED_SEED_STORE_VERSION,
    generatedAt: options?.generatedAt ?? new Date().toISOString(),
    source: "anilist",
    novels: novels.filter(isUsableSeed),
  };

  fs.mkdirSync(path.dirname(storePath), { recursive: true });
  const tempPath = `${storePath}.${process.pid}.tmp`;
  fs.writeFileSync(tempPath, `${JSON.stringify(payload, null, 2)}\n`, "utf8");
  fs.renameSync(tempPath, storePath);
  return storePath;
}
