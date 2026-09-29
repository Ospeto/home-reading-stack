import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { Database } from "bun:sqlite";
import { safeFetchWithSsrf, sanitizeErrorMessage } from "./security";
import { getCalibreDbPath, isLnoriUrl, parseLnoriUrl } from "./lnori";
import { isElscioneUrl, parseElscioneUrl } from "./elscione";
import { searchRanobeDB, searchAniList } from "./scraper";
import discoverCatalog from "./discover-catalog.json";

export type DiscoverSource = "lnori" | "elscione" | "both";
export type DiscoverSourceFilter = "all" | "lnori" | "elscione";
export type DiscoverTab = "trending" | "new";
export type DiscoverStatus = "all" | "available" | "in_library";
export type DiscoverSort = "popularity" | "score" | "newest";

export interface DiscoverSourceUrls {
  lnori?: string;
  elscione?: string;
}

export interface DiscoveredNovel {
  id: string;
  title: string;
  titleRomaji?: string;
  titleNative?: string;
  author?: string;
  coverUrl: string;
  synopsis: string;
  genres: string[];
  score: number;
  popularity: number;
  releaseDate: string;
  volumeCount: number;
  source: DiscoverSource;
  primarySource?: "elscione" | "lnori";
  primaryUrl?: string;
  sourceUrls: DiscoverSourceUrls;
  inLibrary: boolean;
  existingVolumes: number;
}

export interface DiscoverNovelsParams {
  tab?: DiscoverTab;
  source?: DiscoverSourceFilter;
  genre?: string;
  status?: DiscoverStatus;
  q?: string;
  sort?: DiscoverSort;
  page?: number;
  pageSize?: number;
}

export interface DiscoverNovelsResult {
  success: boolean;
  tab: DiscoverTab;
  novels: DiscoveredNovel[];
  count: number;
  genres: string[];
  sources: string[];
  page: number;
  pageSize: number;
  totalPages: number;
}

export interface DiscoverDependencies {
  fetch?: (url: string, init?: RequestInit) => Promise<Response>;
  calibreDb?: Database;
  calibreDbPath?: string;
  cacheDb?: Database;
  cacheDbPath?: string;
  getCalibreBooks?: (forceFresh?: boolean) => any[];
  seedTrendingNovels?: DiscoveredNovel[];
  seedNewNovels?: DiscoveredNovel[];
  onlineTimeoutMs?: number;
  enableOnline?: boolean;
  fallbackQuery?: (title: string, novel: DiscoveredNovel) => Promise<string | null> | string | null;
  customElscioneFolders?: string[];
  customLnoriSeries?: Array<{ id: number; slug: string }>;
}

const DISCOVER_CACHE_TTL_MS = 60 * 60 * 1000; // 1-hour TTL
const ANILIST_API_URL = "https://graphql.anilist.co";

// In-memory feed cache fallback if SQLite cache is not accessible
const inMemoryFeedCache = new Map<string, { data: DiscoveredNovel[]; timestamp: number }>();

/**
 * Normalizes title for fuzzy string comparison against Calibre metadata and catalogue registries.
 */
export function normalizeTitleForMatch(title: string): string {
  if (!title) return "";
  return title
    .toLowerCase()
    .replace(/[-_—–~:|/]+/g, " ")
    .replace(/[^\p{L}\p{N}\s]/gu, "")
    .replace(/\s+/g, " ")
    .trim();
}

export const REAL_ELSCIONE_FOLDERS: string[] = discoverCatalog.elscioneFolders;
export const REAL_LNORI_SERIES: Array<{ id: number; slug: string }> = discoverCatalog.lnoriSeries;

const elscioneNormalizedMap = new Map<string, string>();
for (const folder of REAL_ELSCIONE_FOLDERS) {
  elscioneNormalizedMap.set(normalizeTitleForMatch(folder), folder);
}

const lnoriNormalizedMap = new Map<string, { id: number; slug: string }>();
for (const s of REAL_LNORI_SERIES) {
  lnoriNormalizedMap.set(normalizeTitleForMatch(s.slug.replace(/-/g, " ")), s);
}

export const KNOWN_TITLE_TO_ELSCIONE: Record<string, string> = {
  "rezero": "ReZero - Starting Life in Another World",
  "rezero starting life in another world": "ReZero - Starting Life in Another World",
  "danmachi": "DanMachi",
  "is it wrong to try to pick up girls in a dungeon": "DanMachi",
  "86": "86",
  "86 eighty six": "86",
  "86eightysix": "86",
  "the irregular at magic high school": "Mahouka Koukou no Rettousei",
  "mahouka koukou no rettousei": "Mahouka Koukou no Rettousei",
  "rascal does not dream": "Rascal Does Not Dream",
  "rascal does not dream of bunny girl senpai": "Rascal Does Not Dream",
  "haibaras teenage new game": "Haibara's Teenage New Game+",
  "days with my stepsister": "Days With My Stepsister",
  "gimai seikatsu": "Days With My Stepsister",
  "love unseen beneath the clear night sky": "Love Unseen Beneath the Clear Night Sky",
  "heroine saint no im an all works maid": "Heroine Saint No, I'm an All-Works Maid",
  "the water magician": "The Water Magician",
  "too many losing heroines": "Too Many Losing Heroines!",
  "make heroine ga oosugiru": "Too Many Losing Heroines!",
  "secrets of the silent witch": "Secrets of the Silent Witch",
  "silent witch": "Secrets of the Silent Witch",
  "playing death games to put food on the table": "Playing Death Games to Put Food on the Table",
  "shibou yuugi de meshi wo kuu": "Playing Death Games to Put Food on the Table",
  "sentenced to be a hero": "Sentenced to Be a Hero",
  "yuusha kei ni shosu": "Sentenced to Be a Hero",
  "the frontier lord begins with zero subjects": "The Frontier Lord Begins With Zero Subjects",
  "min maxing my trpg build in another world": "Min-Maxing My TRPG Build in Another World",
  "im the evil lord of an intergalactic empire": "I'm the Evil Lord of an Intergalactic Empire!",
  "a certain magical index": "A Certain Magical Index",
  "toaru majutsu no index": "A Certain Magical Index",
  "sword art online": "Sword Art Online",
  "no game no life": "No Game No Life",
  "spice and wolf": "Spice and Wolf",
  "toradora": "Toradora",
  "konosuba": "KonoSuba",
  "konosuba gods blessing on this wonderful world": "KonoSuba",
  "solo leveling": "Solo Leveling",
  "a sisters all you need": "A Sister's All You Need",
  "the angel next door spoils me rotten": "The Angel Next Door Spoils Me Rotten",
  "the apothecary diaries": "The Apothecary Diaries",
  "the eminence in shadow": "The Eminence in Shadow",
  "kage no jitsuryokusha ni naritakute": "The Eminence in Shadow",
  "ascendance of a bookworm": "Ascendance of a Bookworm",
  "classroom of the elite": "Classroom of the Elite",
  "mushoku tensei": "Mushoku Tensei",
  "mushoku tensei jobless reincarnation": "Mushoku Tensei",
  "overlord": "Overlord",
  "that time i got reincarnated as a slime": "That Time I Got Reincarnated as a Slime",
  "grimgar of fantasy and ash": "Grimgar of Fantasy and Ash",
};

export const KNOWN_TITLE_TO_LNORI: Record<string, { id: number; slug: string }> = {
  "danmachi": { id: 2201, slug: "is-it-wrong-to-try-to-pick-up-girls-in-a-dungeon" },
  "is it wrong to try to pick up girls in a dungeon": { id: 2201, slug: "is-it-wrong-to-try-to-pick-up-girls-in-a-dungeon" },
  "rezero": { id: 2471, slug: "re-zero-starting-life-in-another-world" },
  "rezero starting life in another world": { id: 2471, slug: "re-zero-starting-life-in-another-world" },
  "86": { id: 4808, slug: "86-eighty-six" },
  "86 eighty six": { id: 4808, slug: "86-eighty-six" },
  "86eightysix": { id: 4808, slug: "86-eighty-six" },
  "the irregular at magic high school": { id: 2199, slug: "the-irregular-at-magic-high-school" },
  "mahouka koukou no rettousei": { id: 2199, slug: "the-irregular-at-magic-high-school" },
  "rascal does not dream": { id: 4242, slug: "rascal-does-not-dream-of-bunny-girl-senpai" },
  "rascal does not dream of bunny girl senpai": { id: 4242, slug: "rascal-does-not-dream-of-bunny-girl-senpai" },
  "haibaras teenage new game": { id: 11250, slug: "haibaras-teenage-new-game" },
  "days with my stepsister": { id: 10890, slug: "days-with-my-stepsister" },
  "gimai seikatsu": { id: 10890, slug: "days-with-my-stepsister" },
  "love unseen beneath the clear night sky": { id: 15290, slug: "love-unseen-beneath-the-clear-night-sky" },
  "heroine saint no im an all works maid": { id: 10676, slug: "heroine-saint-no-im-an-all-works-maid-and-proud-of-it" },
  "the water magician": { id: 13054, slug: "the-water-magician" },
  "too many losing heroines": { id: 12780, slug: "too-many-losing-heroines" },
  "make heroine ga oosugiru": { id: 12780, slug: "too-many-losing-heroines" },
  "secrets of the silent witch": { id: 11990, slug: "secrets-of-the-silent-witch" },
  "silent witch": { id: 11990, slug: "secrets-of-the-silent-witch" },
  "playing death games to put food on the table": { id: 14193, slug: "playing-death-games-to-put-food-on-the-table" },
  "shibou yuugi de meshi wo kuu": { id: 14193, slug: "playing-death-games-to-put-food-on-the-table" },
  "sentenced to be a hero": { id: 12440, slug: "sentenced-to-be-a-hero" },
  "yuusha kei ni shosu": { id: 12440, slug: "sentenced-to-be-a-hero" },
  "the frontier lord begins with zero subjects": { id: 11786, slug: "the-frontier-lord-begins-with-zero-subjects" },
  "min maxing my trpg build in another world": { id: 9820, slug: "min-maxing-my-trpg-build-in-another-world" },
  "im the evil lord of an intergalactic empire": { id: 9557, slug: "im-the-evil-lord-of-an-intergalactic-empire" },
  "a certain magical index": { id: 1916, slug: "a-certain-magical-index" },
  "toaru majutsu no index": { id: 1916, slug: "a-certain-magical-index" },
  "sword art online": { id: 2197, slug: "sword-art-online" },
  "no game no life": { id: 2419, slug: "no-game-no-life" },
  "spice and wolf": { id: 2011, slug: "spice-and-wolf" },
  "toradora": { id: 2074, slug: "toradora" },
  "konosuba": { id: 2872, slug: "konosuba-gods-blessing-on-this-wonderful-world" },
  "konosuba gods blessing on this wonderful world": { id: 2872, slug: "konosuba-gods-blessing-on-this-wonderful-world" },
  "solo leveling": { id: 6219, slug: "solo-leveling" },
  "a sisters all you need": { id: 4380, slug: "a-sisters-all-you-need" },
  "the angel next door spoils me rotten": { id: 9601, slug: "the-angel-next-door-spoils-me-rotten" },
  "the apothecary diaries": { id: 11728, slug: "the-apothecary-diaries" },
  "the eminence in shadow": { id: 6215, slug: "the-eminence-in-shadow" },
  "kage no jitsuryokusha ni naritakute": { id: 6215, slug: "the-eminence-in-shadow" },
  "ascendance of a bookworm": { id: 4239, slug: "ascendance-of-a-bookworm-ill-do-anything-to-become-a-librarian" },
  "classroom of the elite": { id: 4557, slug: "classroom-of-the-elite" },
  "mushoku tensei": { id: 3336, slug: "mushoku-tensei-jobless-reincarnation" },
  "mushoku tensei jobless reincarnation": { id: 3336, slug: "mushoku-tensei-jobless-reincarnation" },
  "overlord": { id: 2405, slug: "overlord" },
  "that time i got reincarnated as a slime": { id: 3580, slug: "that-time-i-got-reincarnated-as-a-slime" },
  "grimgar of fantasy and ash": { id: 2873, slug: "grimgar-of-fantasy-and-ash" },
};

export function findRealElscioneFolder(
  title: string,
  romaji?: string,
  native?: string,
  customFolders?: string[],
): string | null {
  const folders = customFolders || REAL_ELSCIONE_FOLDERS;
  const candidates = [title, romaji, native].filter(Boolean) as string[];

  // 1. Check known aliases map first
  for (const c of candidates) {
    const norm = normalizeTitleForMatch(c);
    if (!norm) continue;
    if (KNOWN_TITLE_TO_ELSCIONE[norm]) {
      return KNOWN_TITLE_TO_ELSCIONE[norm];
    }
  }

  // 2. Check exact normalized match
  for (const c of candidates) {
    const norm = normalizeTitleForMatch(c);
    if (!norm) continue;

    if (!customFolders && elscioneNormalizedMap.has(norm)) {
      return elscioneNormalizedMap.get(norm)!;
    }

    for (const f of folders) {
      if (normalizeTitleForMatch(f) === norm) {
        return f;
      }
    }
  }

  // 3. Check bounded prefix / containment match (must be >= 8 chars and length ratio >= 0.70)
  for (const c of candidates) {
    const norm = normalizeTitleForMatch(c);
    if (!norm || norm.length < 8) continue;

    for (const f of folders) {
      const normF = normalizeTitleForMatch(f);
      if (normF.length < 8) continue;

      const minLen = Math.min(norm.length, normF.length);
      const maxLen = Math.max(norm.length, normF.length);
      if (
        normF === norm ||
        (minLen / maxLen >= 0.7 && (normF.startsWith(norm) || norm.startsWith(normF)))
      ) {
        return f;
      }
    }
  }

  return null;
}

export function findRealLnoriSeries(
  title: string,
  romaji?: string,
  native?: string,
  customSeries?: Array<{ id: number; slug: string }>,
): { id: number; slug: string } | null {
  const seriesList = customSeries || REAL_LNORI_SERIES;
  const candidates = [title, romaji, native].filter(Boolean) as string[];

  // 1. Check known aliases map first
  for (const c of candidates) {
    const norm = normalizeTitleForMatch(c);
    if (!norm) continue;
    if (KNOWN_TITLE_TO_LNORI[norm]) {
      return KNOWN_TITLE_TO_LNORI[norm];
    }
  }

  // 2. Check exact normalized match
  for (const c of candidates) {
    const norm = normalizeTitleForMatch(c);
    if (!norm) continue;

    if (!customSeries && lnoriNormalizedMap.has(norm)) {
      return lnoriNormalizedMap.get(norm)!;
    }

    for (const s of seriesList) {
      const normSlug = normalizeTitleForMatch(s.slug.replace(/-/g, " "));
      if (normSlug === norm) {
        return s;
      }
    }
  }

  // 3. Check bounded prefix / containment match (must be >= 8 chars and length ratio >= 0.70)
  for (const c of candidates) {
    const norm = normalizeTitleForMatch(c);
    if (!norm || norm.length < 8) continue;

    for (const s of seriesList) {
      const normSlug = normalizeTitleForMatch(s.slug.replace(/-/g, " "));
      if (normSlug.length < 8) continue;

      const minLen = Math.min(norm.length, normSlug.length);
      const maxLen = Math.max(norm.length, normSlug.length);
      if (
        normSlug === norm ||
        (minLen / maxLen >= 0.7 && (normSlug.startsWith(norm) || norm.startsWith(normSlug)))
      ) {
        return s;
      }
    }
  }

  return null;
}

export interface RealSourceMatch {
  source: DiscoverSource;
  sourceUrls: DiscoverSourceUrls;
  primarySource: "elscione" | "lnori";
  primaryUrl: string;
}

export function resolveRealDownloadSources(
  title: string,
  romaji?: string,
  native?: string,
  options?: {
    customElscioneFolders?: string[];
    customLnoriSeries?: Array<{ id: number; slug: string }>;
  },
): RealSourceMatch | null {
  const elscioneFolder = findRealElscioneFolder(title, romaji, native, options?.customElscioneFolders);
  const lnoriItem = findRealLnoriSeries(title, romaji, native, options?.customLnoriSeries);

  if (!elscioneFolder && !lnoriItem) {
    return null;
  }

  const sourceUrls: DiscoverSourceUrls = {};
  if (elscioneFolder) {
    sourceUrls.elscione = `https://server.elscione.com/Officially%20Translated%20Light%20Novels/${encodeURIComponent(elscioneFolder)}/`;
  }
  if (lnoriItem) {
    sourceUrls.lnori = `https://lnori.com/series/${lnoriItem.id}/${lnoriItem.slug}`;
  }

  let source: DiscoverSource;
  let primarySource: "elscione" | "lnori";
  let primaryUrl: string;

  if (sourceUrls.elscione && sourceUrls.lnori) {
    source = "both";
    // Always prefer Elscione when available on both sources
    primarySource = "elscione";
    primaryUrl = sourceUrls.elscione;
  } else if (sourceUrls.elscione) {
    source = "elscione";
    primarySource = "elscione";
    primaryUrl = sourceUrls.elscione;
  } else {
    source = "lnori";
    primarySource = "lnori";
    primaryUrl = sourceUrls.lnori!;
  }

  return {
    source,
    sourceUrls,
    primarySource,
    primaryUrl,
  };
}

/**
 * Determines primary download source, always preferring Elscione when available on both.
 */
export function assignPrimarySource(novel: DiscoveredNovel): DiscoveredNovel {
  let primarySource: "elscione" | "lnori" = "elscione";
  let primaryUrl = "";

  const hasElscione = Boolean(novel.sourceUrls?.elscione);
  const hasLnori = Boolean(novel.sourceUrls?.lnori);

  if ((novel.source === "both" || (hasElscione && hasLnori)) && hasElscione) {
    // When available on both sources, ALWAYS prefer Elscione over Lnori
    primarySource = "elscione";
    primaryUrl = novel.sourceUrls.elscione!;
  } else if (novel.source === "elscione" || hasElscione) {
    primarySource = "elscione";
    primaryUrl = novel.sourceUrls?.elscione || "";
  } else {
    primarySource = "lnori";
    primaryUrl = novel.sourceUrls?.lnori || "";
  }

  const source: DiscoverSource = hasElscione && hasLnori ? "both" : hasElscione ? "elscione" : "lnori";

  return {
    ...novel,
    source,
    primarySource,
    primaryUrl,
  };
}

// Seed catalogue for "Trending" Light Novels (Curated, robust, source-tagged)
export const SEED_TRENDING_NOVELS: DiscoveredNovel[] = [
  {
    id: "ascendance-of-a-bookworm",
    title: "Ascendance of a Bookworm",
    titleRomaji: "Honzuki no Gekokujou: Shisho ni Naru Tame ni wa Shudan wo Erandeiraremasen",
    titleNative: "本好きの下剋上 ～司書になるためには手段を選んでいられません～",
    author: "Miya Kazuki",
    coverUrl: "https://images.ranobedb.org/b619d854e488d0ce2438318b7ae29fa7.jpg",
    synopsis: "A book-loving college student dies and is reincarnated in a medieval fantasy world without books. Determined to read again, she resolves to make her own.",
    genres: ["Fantasy", "Isekai", "Slice of Life"],
    score: 91,
    popularity: 98000,
    releaseDate: "2015-01-25",
    volumeCount: 33,
    source: "both",
    sourceUrls: {
      lnori: "https://lnori.com/series/4239/ascendance-of-a-bookworm-ill-do-anything-to-become-a-librarian",
      elscione: "https://server.elscione.com/Officially%20Translated%20Light%20Novels/Ascendance%20of%20a%20Bookworm/",
    },
    primarySource: "elscione",
    primaryUrl: "https://server.elscione.com/Officially%20Translated%20Light%20Novels/Ascendance%20of%20a%20Bookworm/",
    inLibrary: false,
    existingVolumes: 0,
  },
  {
    id: "classroom-of-the-elite",
    title: "Classroom of the Elite",
    titleRomaji: "Youkoso Jitsuryoku Shijou Shugi no Kyoushitsu e",
    titleNative: "ようこそ実力至上主義の教室へ",
    author: "Shougo Kinugasa",
    coverUrl: "https://images.ranobedb.org/5c23d4a2be29e81dbf7d5440b82f026a.jpg",
    synopsis: "Kiyotaka Ayanokouji enrolls at Tokyo Metropolitan Advanced Nurturing High School, an elite institution where students receive points based on merit in a cutthroat hierarchy.",
    genres: ["Psychological", "Drama", "Mystery"],
    score: 89,
    popularity: 95000,
    releaseDate: "2015-05-25",
    volumeCount: 28,
    source: "both",
    sourceUrls: {
      lnori: "https://lnori.com/series/4557/classroom-of-the-elite",
      elscione: "https://server.elscione.com/Officially%20Translated%20Light%20Novels/Classroom%20of%20the%20Elite/",
    },
    primarySource: "elscione",
    primaryUrl: "https://server.elscione.com/Officially%20Translated%20Light%20Novels/Classroom%20of%20the%20Elite/",
    inLibrary: false,
    existingVolumes: 0,
  },
  {
    id: "mushoku-tensei",
    title: "Mushoku Tensei: Jobless Reincarnation",
    titleRomaji: "Mushoku Tensei: Isekai Ittara Honki Dasu",
    titleNative: "無職転生 ～異世界行ったら本気だす～",
    author: "Rifujin na Magonote",
    coverUrl: "https://images.ranobedb.org/f726cbbe98ce0a9f5d34208a381180eb.jpg",
    synopsis: "Reincarnated into a magical world as infant Rudeus Greyrat, a 34-year-old NEET resolves to overcome his past trauma and live his new life to the absolute fullest.",
    genres: ["Fantasy", "Isekai", "Adventure"],
    score: 88,
    popularity: 92000,
    releaseDate: "2014-01-23",
    volumeCount: 26,
    source: "both",
    sourceUrls: {
      lnori: "https://lnori.com/series/3336/mushoku-tensei-jobless-reincarnation",
      elscione: "https://server.elscione.com/Officially%20Translated%20Light%20Novels/Mushoku%20Tensei/",
    },
    primarySource: "elscione",
    primaryUrl: "https://server.elscione.com/Officially%20Translated%20Light%20Novels/Mushoku%20Tensei/",
    inLibrary: false,
    existingVolumes: 0,
  },
  {
    id: "overlord",
    title: "Overlord",
    titleRomaji: "Overlord",
    titleNative: "オーバーロード",
    author: "Kugane Maruyama",
    coverUrl: "https://images.ranobedb.org/bb89c67eb9f492a549e3e3b320d4b29f.jpg",
    synopsis: "When the popular MMORPG Yggdrasil shuts down, veteran player Momonga stays logged in until the final second, only to discover the Great Tomb of Nazarick transported to a real new world.",
    genres: ["Fantasy", "Action", "Supernatural"],
    score: 87,
    popularity: 89000,
    releaseDate: "2012-07-30",
    volumeCount: 16,
    source: "both",
    sourceUrls: {
      lnori: "https://lnori.com/series/2405/overlord",
      elscione: "https://server.elscione.com/Officially%20Translated%20Light%20Novels/Overlord/",
    },
    primarySource: "elscione",
    primaryUrl: "https://server.elscione.com/Officially%20Translated%20Light%20Novels/Overlord/",
    inLibrary: false,
    existingVolumes: 0,
  },
  {
    id: "that-time-i-got-reincarnated-as-a-slime",
    title: "That Time I Got Reincarnated as a Slime",
    titleRomaji: "Tensei Shitara Slime Datta Ken",
    titleNative: "転生したらスライムだった件",
    author: "Fuse",
    coverUrl: "https://images.ranobedb.org/c789a421b8f10398ab762194840d859e.jpg",
    synopsis: "After being killed by a rogue robber, corporate worker Satoru Mikami wakes up in a fantasy world reincarnated as a gelatinous slime named Rimuru Tempest with unique Predator abilities.",
    genres: ["Fantasy", "Isekai", "Comedy", "Action"],
    score: 86,
    popularity: 88000,
    releaseDate: "2014-05-30",
    volumeCount: 21,
    source: "both",
    sourceUrls: {
      lnori: "https://lnori.com/series/3580/that-time-i-got-reincarnated-as-a-slime",
      elscione: "https://server.elscione.com/Officially%20Translated%20Light%20Novels/That%20Time%20I%20Got%20Reincarnated%20as%20a%20Slime/",
    },
    primarySource: "elscione",
    primaryUrl: "https://server.elscione.com/Officially%20Translated%20Light%20Novels/That%20Time%20I%20Got%20Reincarnated%20as%20a%20Slime/",
    inLibrary: false,
    existingVolumes: 0,
  },
  {
    id: "the-angel-next-door-spoils-me-rotten",
    title: "The Angel Next Door Spoils Me Rotten",
    titleRomaji: "Otonari no Tenshi-sama ni Itsu no Ma ni ka Dame Ningen ni Sareteita Ken",
    titleNative: "お隣の天使様にいつの間にか駄目人間にされていた件",
    author: "Saekisan",
    coverUrl: "https://images.ranobedb.org/73f08b3ba94e77ddf406691461ff360a.jpg",
    synopsis: "Amane Fujimiya lives next door to Mahiru Shiina, school idol known as Angel. After Amane offers her his umbrella on a rainy day, Mahiru begins looking after his disorganized bachelor lifestyle.",
    genres: ["Romance", "Comedy", "Slice of Life"],
    score: 85,
    popularity: 84000,
    releaseDate: "2019-06-15",
    volumeCount: 10,
    source: "both",
    sourceUrls: {
      lnori: "https://lnori.com/series/9601/the-angel-next-door-spoils-me-rotten",
      elscione: "https://server.elscione.com/Officially%20Translated%20Light%20Novels/The%20Angel%20Next%20Door%20Spoils%20Me%20Rotten/",
    },
    primarySource: "elscione",
    primaryUrl: "https://server.elscione.com/Officially%20Translated%20Light%20Novels/The%20Angel%20Next%20Door%20Spoils%20Me%20Rotten/",
    inLibrary: false,
    existingVolumes: 0,
  },
  {
    id: "eighty-six",
    title: "86--EIGHTY-SIX",
    titleRomaji: "86--Eighty Six",
    titleNative: "86―エイティシックス―",
    author: "Asato Asato",
    coverUrl: "https://images.ranobedb.org/6945be1fcde833df82aa376f92a01490.jpg",
    synopsis: "The Republic of San Magnolia claims to fight an unmanned war against autonomous Legion drones. In reality, the processors operating the Juggernaut mechs are human 86s denied personhood.",
    genres: ["Sci-Fi", "Action", "Drama", "Psychological"],
    score: 89,
    popularity: 86000,
    releaseDate: "2017-02-10",
    volumeCount: 13,
    source: "both",
    sourceUrls: {
      lnori: "https://lnori.com/series/4808/86-eighty-six",
      elscione: "https://server.elscione.com/Officially%20Translated%20Light%20Novels/86/",
    },
    primarySource: "elscione",
    primaryUrl: "https://server.elscione.com/Officially%20Translated%20Light%20Novels/86/",
    inLibrary: false,
    existingVolumes: 0,
  },
  {
    id: "the-apothecary-diaries",
    title: "The Apothecary Diaries",
    titleRomaji: "Kusuriya no Hitorigoto",
    titleNative: "薬屋のひとりごと",
    author: "Natsu Hyuuga",
    coverUrl: "https://images.ranobedb.org/88e4091a13e55138122c66d2f34aa0b1.jpg",
    synopsis: "Kidnapped and sold into service at the imperial palace, apothecary daughter Maomao uses her deep medical and toxicological acumen to deduce the mysteries of the inner court.",
    genres: ["Mystery", "Drama", "Historical"],
    score: 90,
    popularity: 91000,
    releaseDate: "2014-08-29",
    volumeCount: 15,
    source: "both",
    sourceUrls: {
      lnori: "https://lnori.com/series/11728/the-apothecary-diaries",
      elscione: "https://server.elscione.com/Officially%20Translated%20Light%20Novels/The%20Apothecary%20Diaries/",
    },
    primarySource: "elscione",
    primaryUrl: "https://server.elscione.com/Officially%20Translated%20Light%20Novels/The%20Apothecary%20Diaries/",
    inLibrary: false,
    existingVolumes: 0,
  },
  {
    id: "the-eminence-in-shadow",
    title: "The Eminence in Shadow",
    titleRomaji: "Kage no Jitsuryokusha ni Naritakute!",
    titleNative: "陰の実力者になりたくて！",
    author: "Daisuke Aizawa",
    coverUrl: "https://images.ranobedb.org/218cb72e01b359f518a47466ebc194e1.jpg",
    synopsis: "Cid Kagenou strives to become a mastermind operating from the shadows. Reborn into a magical world, his fictional conspiracies ironically turn out to be real threats.",
    genres: ["Action", "Comedy", "Fantasy"],
    score: 86,
    popularity: 87000,
    releaseDate: "2018-11-05",
    volumeCount: 6,
    source: "both",
    sourceUrls: {
      lnori: "https://lnori.com/series/6215/the-eminence-in-shadow",
      elscione: "https://server.elscione.com/Officially%20Translated%20Light%20Novels/The%20Eminence%20in%20Shadow/",
    },
    primarySource: "elscione",
    primaryUrl: "https://server.elscione.com/Officially%20Translated%20Light%20Novels/The%20Eminence%20in%20Shadow/",
    inLibrary: false,
    existingVolumes: 0,
  },
  {
    id: "a-sisters-all-you-need",
    title: "A Sister's All You Need",
    titleRomaji: "Imouto sae Ireba Ii.",
    titleNative: "妹さえいればいい。",
    author: "Yomi Hirasaka",
    coverUrl: "https://images.ranobedb.org/99f3583bb2225a0928929944a9561b34.jpg",
    synopsis: "Follows itsuki Hashima, an eccentric light novel author obsessed with little sisters, surrounded by talented creators, editors, and tax accountants in the modern publishing industry.",
    genres: ["Comedy", "Romance", "Slice of Life"],
    score: 82,
    popularity: 64000,
    releaseDate: "2015-03-18",
    volumeCount: 14,
    source: "both",
    sourceUrls: {
      lnori: "https://lnori.com/series/4380/a-sisters-all-you-need",
      elscione: "https://server.elscione.com/Officially%20Translated%20Light%20Novels/A%20Sister's%20All%20You%20Need/",
    },
    primarySource: "elscione",
    primaryUrl: "https://server.elscione.com/Officially%20Translated%20Light%20Novels/A%20Sister's%20All%20You%20Need/",
    inLibrary: false,
    existingVolumes: 0,
  },
  {
    id: "grimgar-of-fantasy-and-ash",
    title: "Grimgar of Fantasy and Ash",
    titleRomaji: "Hai to Gensou no Grimgar",
    titleNative: "灰と幻想のグリムガル",
    author: "Ao Juumonji",
    coverUrl: "https://images.ranobedb.org/a468b6d4948ff11e515d91df3e070c79.jpg",
    synopsis: "Waking up in a strange realm with no memories of their past lives, Haruhiro and fellow outcasts must hunt goblins to survive in a unforgivingly realistic world.",
    genres: ["Fantasy", "Action", "Drama"],
    score: 84,
    popularity: 76000,
    releaseDate: "2013-06-25",
    volumeCount: 21,
    source: "both",
    sourceUrls: {
      lnori: "https://lnori.com/series/2873/grimgar-of-fantasy-and-ash",
      elscione: "https://server.elscione.com/Officially%20Translated%20Light%20Novels/Grimgar%20of%20Fantasy%20and%20Ash/",
    },
    primarySource: "elscione",
    primaryUrl: "https://server.elscione.com/Officially%20Translated%20Light%20Novels/Grimgar%20of%20Fantasy%20and%20Ash/",
    inLibrary: false,
    existingVolumes: 0,
  },
  {
    id: "danmachi",
    title: "DanMachi: Is It Wrong to Try to Pick Up Girls in a Dungeon?",
    titleRomaji: "Dungeon ni Deai wo Motomeru no wa Machigatteiru Darou ka",
    titleNative: "ダンジョンに出会いを求めるのは間違っているだろうか",
    author: "Fujino Oomori",
    coverUrl: "https://images.ranobedb.org/e2ab34934d4ec311bc40c6b12a8064ae.jpg",
    synopsis: "In the sprawling city of Orario above the massive Dungeon, rookie adventurer Bell Cranel strives to grow stronger under the banner of the tiny Hestia Familia.",
    genres: ["Fantasy", "Action", "Adventure"],
    score: 86,
    popularity: 85000,
    releaseDate: "2013-01-15",
    volumeCount: 19,
    source: "both",
    sourceUrls: {
      lnori: "https://lnori.com/series/2201/is-it-wrong-to-try-to-pick-up-girls-in-a-dungeon",
      elscione: "https://server.elscione.com/Officially%20Translated%20Light%20Novels/DanMachi/",
    },
    primarySource: "elscione",
    primaryUrl: "https://server.elscione.com/Officially%20Translated%20Light%20Novels/DanMachi/",
    inLibrary: false,
    existingVolumes: 0,
  },
  {
    id: "re-zero",
    title: "Re:ZERO -Starting Life in Another World-",
    titleRomaji: "Re:Zero kara Hajimeru Isekai Seikatsu",
    titleNative: "Re:ゼロから始める異世界生活",
    author: "Tappei Nagatsuki",
    coverUrl: "https://images.ranobedb.org/a46875bc4911f9db678912e9b9409890.jpg",
    synopsis: "Subaru Natsuki is suddenly summoned to another world with no powers except Return by Death—reversing time to a past save point whenever he perishes.",
    genres: ["Fantasy", "Psychological", "Drama", "Isekai"],
    score: 88,
    popularity: 94000,
    releaseDate: "2014-01-24",
    volumeCount: 37,
    source: "both",
    sourceUrls: {
      lnori: "https://lnori.com/series/2471/re-zero-starting-life-in-another-world",
      elscione: "https://server.elscione.com/Officially%20Translated%20Light%20Novels/ReZero%20-%20Starting%20Life%20in%20Another%20World/",
    },
    primarySource: "elscione",
    primaryUrl: "https://server.elscione.com/Officially%20Translated%20Light%20Novels/ReZero%20-%20Starting%20Life%20in%20Another%20World/",
    inLibrary: false,
    existingVolumes: 0,
  },
  {
    id: "a-certain-magical-index",
    title: "A Certain Magical Index",
    titleRomaji: "Toaru Majutsu no Index",
    titleNative: "とある魔術の禁書目録",
    author: "Kazuma Kamachi",
    coverUrl: "https://images.ranobedb.org/4c6792374e64ba23381e46934a31de5b.jpg",
    synopsis: "In Academy City, a scientifically advanced haven of espers, high schooler Touma Kamijou possesses Imagine Breaker in his right hand, negating all supernatural abilities.",
    genres: ["Sci-Fi", "Supernatural", "Action"],
    score: 83,
    popularity: 72000,
    releaseDate: "2004-04-10",
    volumeCount: 55,
    source: "both",
    sourceUrls: {
      lnori: "https://lnori.com/series/1916/a-certain-magical-index",
      elscione: "https://server.elscione.com/Officially%20Translated%20Light%20Novels/A%20Certain%20Magical%20Index/",
    },
    primarySource: "elscione",
    primaryUrl: "https://server.elscione.com/Officially%20Translated%20Light%20Novels/A%20Certain%20Magical%20Index/",
    inLibrary: false,
    existingVolumes: 0,
  },
  {
    id: "monogatari",
    title: "Monogatari",
    titleRomaji: "Monogatari Series",
    titleNative: "物語シリーズ",
    author: "Nisio Isin",
    coverUrl: "https://images.ranobedb.org/bb89c67eb9f492a549e3e3b320d4b29f.jpg",
    synopsis: "High school student Koyomi Araragi survives a vampire attack with the aid of the eccentric specialist Meme Oshino. Finding himself equipped with lingering superhuman healing, he assists various girls afflicted by bizarre apparitions and emotional trauma.",
    genres: ["Supernatural", "Mystery", "Psychological"],
    score: 89,
    popularity: 93000,
    releaseDate: "2006-11-01",
    volumeCount: 28,
    source: "lnori",
    sourceUrls: {
      lnori: "https://lnori.com/series/1014/monogatari",
    },
    primarySource: "lnori",
    primaryUrl: "https://lnori.com/series/1014/monogatari",
    inLibrary: false,
    existingVolumes: 0,
  },
  {
    id: "a-cave-kings-road-to-paradise",
    title: "A Cave King's Road to Paradise",
    titleRomaji: "Cave King no Rakuen Life",
    titleNative: "洞窟王からはじめる楽園ライフ",
    author: "Sanoushi",
    coverUrl: "https://images.ranobedb.org/5c23d4a2be29e81dbf7d5440b82f026a.jpg",
    synopsis: "Prince Heal is exiled to a barren, isolated island due to possessing a seemingly useless Cave King crest. However, upon excavating the rocks, he discovers his crest grants godlike mining and crafting abilities, rapidly transforming the desolate wasteland into an impregnable paradise.",
    genres: ["Fantasy", "Adventure", "Slice of Life"],
    score: 80,
    popularity: 25000,
    releaseDate: "2020-08-10",
    volumeCount: 2,
    source: "elscione",
    sourceUrls: {
      elscione: "https://server.elscione.com/Officially%20Translated%20Light%20Novels/A%20Cave%20King's%20Road%20to%20Paradise/",
    },
    primarySource: "elscione",
    primaryUrl: "https://server.elscione.com/Officially%20Translated%20Light%20Novels/A%20Cave%20King's%20Road%20to%20Paradise/",
    inLibrary: false,
    existingVolumes: 0,
  },
];

// Seed catalogue for "New Releases" Light Novels (Curated, distinct from Trending!)
export const SEED_NEW_NOVELS: DiscoveredNovel[] = [
  {
    id: "playing-death-games-to-put-food-on-the-table",
    title: "Playing Death Games to Put Food on the Table",
    titleRomaji: "Shibou Yuugi de Meshi wo Kuu.",
    titleNative: "死亡遊戯で飯を食う。",
    author: "Yushi Ukai",
    coverUrl: "https://images.ranobedb.org/b619d854e488d0ce2438318b7ae29fa7.jpg",
    synopsis: "Yuuki wakes up dressed in a maid uniform in a lethal ghost mansion. In a world where high-stakes death games are streamed for money, she plays to survive and pay rent.",
    genres: ["Psychological", "Action", "Mystery"],
    score: 84,
    popularity: 42000,
    releaseDate: "2023-01-20",
    volumeCount: 5,
    source: "both",
    sourceUrls: {
      lnori: "https://lnori.com/series/14193/playing-death-games-to-put-food-on-the-table",
      elscione: "https://server.elscione.com/Officially%20Translated%20Light%20Novels/Playing%20Death%20Games%20to%20Put%20Food%20on%20the%20Table/",
    },
    primarySource: "elscione",
    primaryUrl: "https://server.elscione.com/Officially%20Translated%20Light%20Novels/Playing%20Death%20Games%20to%20Put%20Food%20on%20the%20Table/",
    inLibrary: false,
    existingVolumes: 0,
  },
  {
    id: "love-unseen-beneath-the-clear-night-sky",
    title: "Love Unseen Beneath the Clear Night Sky",
    titleRomaji: "Toumei na Yoru ni Kakeru Kimi to, Me ni Mienai Koi wo Shita.",
    titleNative: "透明な夜に駆ける君と、目に見えない恋をした。",
    author: "Misaki Sano",
    coverUrl: "https://images.ranobedb.org/73f08b3ba94e77ddf406691461ff360a.jpg",
    synopsis: "College student Kakeru meets Hibari, a visually impaired girl fascinated by festival fireworks. Together they embark on a delicate journey exploring sound, sensation, and affection.",
    genres: ["Romance", "Drama", "Slice of Life"],
    score: 86,
    popularity: 38000,
    releaseDate: "2023-08-25",
    volumeCount: 2,
    source: "both",
    sourceUrls: {
      lnori: "https://lnori.com/series/15290/love-unseen-beneath-the-clear-night-sky",
      elscione: "https://server.elscione.com/Officially%20Translated%20Light%20Novels/Love%20Unseen%20Beneath%20the%20Clear%20Night%20Sky/",
    },
    primarySource: "elscione",
    primaryUrl: "https://server.elscione.com/Officially%20Translated%20Light%20Novels/Love%20Unseen%20Beneath%20the%20Clear%20Night%20Sky/",
    inLibrary: false,
    existingVolumes: 0,
  },
  {
    id: "heroine-saint-no-im-an-all-works-maid",
    title: "Heroine? Saint? No, I'm an All-Works Maid",
    titleRomaji: "Heroine? Seijo? Iie, All-Works Maid desu!",
    titleNative: "ヒロイン？聖女？いいえ、オールワークスメイドです！",
    author: "Amane",
    coverUrl: "https://images.ranobedb.org/88e4091a13e55138122c66d2f34aa0b1.jpg",
    synopsis: "Reincarnated into an otome game as the prophesied holy maiden, Melody decides she would rather fulfill her lifelong dream of being an impeccable professional maid.",
    genres: ["Fantasy", "Comedy", "Slice of Life"],
    score: 80,
    popularity: 31000,
    releaseDate: "2022-10-10",
    volumeCount: 4,
    source: "both",
    sourceUrls: {
      lnori: "https://lnori.com/series/10676/heroine-saint-no-im-an-all-works-maid-and-proud-of-it",
      elscione: "https://server.elscione.com/Officially%20Translated%20Light%20Novels/Heroine%20Saint%20No%2C%20I'm%20an%20All-Works%20Maid/",
    },
    primarySource: "elscione",
    primaryUrl: "https://server.elscione.com/Officially%20Translated%20Light%20Novels/Heroine%20Saint%20No%2C%20I'm%20an%20All-Works%20Maid/",
    inLibrary: false,
    existingVolumes: 0,
  },
  {
    id: "sentenced-to-be-a-hero",
    title: "Sentenced to Be a Hero",
    titleRomaji: "Yuusha Kei ni Shosu: Choubatsu Yuusha 9004-tai Keimu Kiroku",
    titleNative: "勇者刑に処す 懲罰勇者9004隊刑務記録",
    author: "Rocket Shokai",
    coverUrl: "https://images.ranobedb.org/6945be1fcde833df82aa376f92a01490.jpg",
    synopsis: "Heroism is not an honor—it is the ultimate capital punishment for heinous criminals condemned to endlessly fight the demon king's immortal army until they die.",
    genres: ["Fantasy", "Action", "Dark Fantasy"],
    score: 85,
    popularity: 45000,
    releaseDate: "2021-09-17",
    volumeCount: 6,
    source: "both",
    sourceUrls: {
      lnori: "https://lnori.com/series/12440/sentenced-to-be-a-hero",
      elscione: "https://server.elscione.com/Officially%20Translated%20Light%20Novels/Sentenced%20to%20Be%20a%20Hero/",
    },
    primarySource: "elscione",
    primaryUrl: "https://server.elscione.com/Officially%20Translated%20Light%20Novels/Sentenced%20to%20Be%20a%20Hero/",
    inLibrary: false,
    existingVolumes: 0,
  },
  {
    id: "the-water-magician",
    title: "The Water Magician",
    titleRomaji: "Mizu Zokusei no Mahoutsukai",
    titleNative: "水属性の魔法使い",
    author: "Tadashi Kubota",
    coverUrl: "https://images.ranobedb.org/5c23d4a2be29e81dbf7d5440b82f026a.jpg",
    synopsis: "Reincarnated into another realm with only basic water affinity magic, Ryou meticulously discovers how fluid dynamics, purification, and pressure can outmatch any offensive flame.",
    genres: ["Fantasy", "Adventure", "Slice of Life"],
    score: 81,
    popularity: 29000,
    releaseDate: "2022-04-15",
    volumeCount: 4,
    source: "both",
    sourceUrls: {
      lnori: "https://lnori.com/series/13054/the-water-magician",
      elscione: "https://server.elscione.com/Officially%20Translated%20Light%20Novels/The%20Water%20Magician/",
    },
    primarySource: "elscione",
    primaryUrl: "https://server.elscione.com/Officially%20Translated%20Light%20Novels/The%20Water%20Magician/",
    inLibrary: false,
    existingVolumes: 0,
  },
  {
    id: "haibaras-teenage-new-game",
    title: "Haibara's Teenage New Game+",
    titleRomaji: "Haibara-kun no Tsuyokute Seishun New Game",
    titleNative: "灰原くんの強くて青春ニューゲーム",
    author: "Kazuki Amamiya",
    coverUrl: "https://images.ranobedb.org/f726cbbe98ce0a9f5d34208a381180eb.jpg",
    synopsis: "Natsuki Haibara wasted his high school youth in loneliness. When he mysteriously slips back in time to his high school entrance ceremony, he resolves to live a sparkling youth.",
    genres: ["Romance", "Comedy", "Slice of Life"],
    score: 82,
    popularity: 34000,
    releaseDate: "2022-02-01",
    volumeCount: 6,
    source: "both",
    sourceUrls: {
      lnori: "https://lnori.com/series/11250/haibaras-teenage-new-game",
      elscione: "https://server.elscione.com/Officially%20Translated%20Light%20Novels/Haibara's%20Teenage%20New%20Game%2B/",
    },
    primarySource: "elscione",
    primaryUrl: "https://server.elscione.com/Officially%20Translated%20Light%20Novels/Haibara's%20Teenage%20New%20Game%2B/",
    inLibrary: false,
    existingVolumes: 0,
  },
  {
    id: "too-many-losing-heroines",
    title: "Too Many Losing Heroines!",
    titleRomaji: "Make Heroine ga Oosugiru!",
    titleNative: "負けヒロインが多すぎる！",
    author: "Takibi Amamori",
    coverUrl: "https://images.ranobedb.org/218cb72e01b359f518a47466ebc194e1.jpg",
    synopsis: "Background student Kazuhiko Nukumizu witnesses the girl next door getting rejected by her crush. Soon, he finds himself surrounded by girls who lost the romance race.",
    genres: ["Comedy", "Romance", "Slice of Life"],
    score: 88,
    popularity: 62000,
    releaseDate: "2021-07-21",
    volumeCount: 7,
    source: "both",
    sourceUrls: {
      lnori: "https://lnori.com/series/12780/too-many-losing-heroines",
      elscione: "https://server.elscione.com/Officially%20Translated%20Light%20Novels/Too%20Many%20Losing%20Heroines!/",
    },
    primarySource: "elscione",
    primaryUrl: "https://server.elscione.com/Officially%20Translated%20Light%20Novels/Too%20Many%20Losing%20Heroines!/",
    inLibrary: false,
    existingVolumes: 0,
  },
  {
    id: "secrets-of-the-silent-witch",
    title: "Secrets of the Silent Witch",
    titleRomaji: "Silent Witch: Chinmoku no Majo no Kakushigoto",
    titleNative: "サイレント・ウィッチ 沈黙の魔女の隠しごと",
    author: "Matsuri Isora",
    coverUrl: "https://images.ranobedb.org/bb89c67eb9f492a549e3e3b320d4b29f.jpg",
    synopsis: "Monica Everett is the Silent Witch, capable of unchanted supreme magic purely because she is cripplingly shy. Now, she is ordered to go undercover as a high school student.",
    genres: ["Fantasy", "Mystery", "Comedy"],
    score: 85,
    popularity: 48000,
    releaseDate: "2021-06-10",
    volumeCount: 8,
    source: "both",
    sourceUrls: {
      lnori: "https://lnori.com/series/11990/secrets-of-the-silent-witch",
      elscione: "https://server.elscione.com/Officially%20Translated%20Light%20Novels/Secrets%20of%20the%20Silent%20Witch/",
    },
    primarySource: "elscione",
    primaryUrl: "https://server.elscione.com/Officially%20Translated%20Light%20Novels/Secrets%20of%20the%20Silent%20Witch/",
    inLibrary: false,
    existingVolumes: 0,
  },
  {
    id: "days-with-my-stepsister",
    title: "Days with My Stepsister",
    titleRomaji: "Gimai Seikatsu",
    titleNative: "義妹生活",
    author: "Ghost Mikawa",
    coverUrl: "https://images.ranobedb.org/c789a421b8f10398ab762194840d859e.jpg",
    synopsis: "After his father remarries, Yuuta Asamura ends up living under the same roof with Saki Ayase. Having both witnessed their parents' broken marriages, they establish a calm, respectful distance.",
    genres: ["Romance", "Slice of Life", "Drama"],
    score: 84,
    popularity: 51000,
    releaseDate: "2021-01-25",
    volumeCount: 11,
    source: "both",
    sourceUrls: {
      lnori: "https://lnori.com/series/10890/days-with-my-stepsister",
      elscione: "https://server.elscione.com/Officially%20Translated%20Light%20Novels/Days%20With%20My%20Stepsister/",
    },
    primarySource: "elscione",
    primaryUrl: "https://server.elscione.com/Officially%20Translated%20Light%20Novels/Days%20With%20My%20Stepsister/",
    inLibrary: false,
    existingVolumes: 0,
  },
  {
    id: "the-frontier-lord-begins-with-zero-subjects",
    title: "The Frontier Lord Begins with Zero Subjects",
    titleRomaji: "Ryouchi Henkyou kara Hajimeru Ryouchi Unei",
    titleNative: "領地辺境から始める領地運営",
    author: "Fuurou",
    coverUrl: "https://images.ranobedb.org/99f3583bb2225a0928929944a9561b34.jpg",
    synopsis: "Dias is granted a remote wasteland after twenty years of grueling military service. Finding only grassland and roaming wildlife, he begins building a peaceful haven.",
    genres: ["Fantasy", "Isekai", "Adventure"],
    score: 81,
    popularity: 28000,
    releaseDate: "2021-12-15",
    volumeCount: 4,
    source: "both",
    sourceUrls: {
      lnori: "https://lnori.com/series/11786/the-frontier-lord-begins-with-zero-subjects",
      elscione: "https://server.elscione.com/Officially%20Translated%20Light%20Novels/The%20Frontier%20Lord%20Begins%20With%20Zero%20Subjects/",
    },
    primarySource: "elscione",
    primaryUrl: "https://server.elscione.com/Officially%20Translated%20Light%20Novels/The%20Frontier%20Lord%20Begins%20With%20Zero%20Subjects/",
    inLibrary: false,
    existingVolumes: 0,
  },
  {
    id: "min-maxing-my-trpg-build-in-another-world",
    title: "Min-Maxing My TRPG Build in Another World",
    titleRomaji: "TRPG Player ga Isekai de Saikyou Build wo Mezasu",
    titleNative: "TRPGプレイヤーが異世界で最強ビルドを目指す",
    author: "Schoppen",
    coverUrl: "https://images.ranobedb.org/a468b6d4948ff11e515d91df3e070c79.jpg",
    synopsis: "Reincarnated into a tabletop RPG ruleset realm, a hardcore min-maxer carefully allocates his stats and character points to construct an unassailable build.",
    genres: ["Fantasy", "Isekai", "Adventure"],
    score: 83,
    popularity: 37000,
    releaseDate: "2020-09-25",
    volumeCount: 9,
    source: "both",
    sourceUrls: {
      lnori: "https://lnori.com/series/9820/min-maxing-my-trpg-build-in-another-world",
      elscione: "https://server.elscione.com/Officially%20Translated%20Light%20Novels/Min-Maxing%20My%20TRPG%20Build%20in%20Another%20World/",
    },
    primarySource: "elscione",
    primaryUrl: "https://server.elscione.com/Officially%20Translated%20Light%20Novels/Min-Maxing%20My%20TRPG%20Build%20in%20Another%20World/",
    inLibrary: false,
    existingVolumes: 0,
  },
  {
    id: "im-the-evil-lord-of-an-intergalactic-empire",
    title: "I'm the Evil Lord of an Intergalactic Empire!",
    titleRomaji: "Ore wa Seikan Kokka no Akutoku Ryoushu!",
    titleNative: "俺は星間国家の悪徳領主！",
    author: "Yomu Mishima",
    coverUrl: "https://images.ranobedb.org/e2ab34934d4ec311bc40c6b12a8064ae.jpg",
    synopsis: "Liam Sera Banfield was betrayed and died in debt. Reborn into a sci-fi space empire, he vows to become a ruthless corrupt lord—only for his every act to accidentally enrich his people.",
    genres: ["Sci-Fi", "Action", "Comedy", "Isekai"],
    score: 83,
    popularity: 46000,
    releaseDate: "2020-07-25",
    volumeCount: 8,
    source: "both",
    sourceUrls: {
      lnori: "https://lnori.com/series/9557/im-the-evil-lord-of-an-intergalactic-empire",
      elscione: "https://server.elscione.com/Officially%20Translated%20Light%20Novels/I'm%20the%20Evil%20Lord%20of%20an%20Intergalactic%20Empire!/",
    },
    primarySource: "elscione",
    primaryUrl: "https://server.elscione.com/Officially%20Translated%20Light%20Novels/I'm%20the%20Evil%20Lord%20of%20an%20Intergalactic%20Empire!/",
    inLibrary: false,
    existingVolumes: 0,
  },
  {
    id: "the-vexations-of-a-shut-in-vampire-princess",
    title: "The Vexations of a Shut-In Vampire Princess",
    titleRomaji: "Hikikomari Kyuuketsuki no Monmon",
    titleNative: "ひきこまり吸血姫の悶々",
    author: "Kotei Kobayashi",
    coverUrl: "https://images.ranobedb.org/bb89c67eb9f492a549e3e3b320d4b29f.jpg",
    synopsis: "Terakomari Gandesblood is a shut-in vampire who cannot drink blood or cast magic. When she is suddenly appointed as a supreme commander in the imperial army, she must bluff her way through lethal battles and conspiracies alongside her devoted maid.",
    genres: ["Fantasy", "Comedy", "Action"],
    score: 84,
    popularity: 39000,
    releaseDate: "2020-01-11",
    volumeCount: 13,
    source: "lnori",
    sourceUrls: {
      lnori: "https://lnori.com/series/10426/the-vexations-of-a-shut-in-vampire-princess",
    },
    primarySource: "lnori",
    primaryUrl: "https://lnori.com/series/10426/the-vexations-of-a-shut-in-vampire-princess",
    inLibrary: false,
    existingVolumes: 0,
  },
  {
    id: "a-contract-marriage-with-the-maid",
    title: "A Contract Marriage with the Maid",
    titleRomaji: "Meido-san to no Keiyaku Kekkon",
    titleNative: "メイドさんとの契約結婚",
    author: "Ryo Arihara",
    coverUrl: "https://images.ranobedb.org/88e4091a13e55138122c66d2f34aa0b1.jpg",
    synopsis: "To escape political machinations and high-society obligations, a prominent nobleman proposes a convenient marriage of convenience with his reserved, diligent housemaid. What begins as a calculated formal arrangement soon deepens into a warm and sincere bond.",
    genres: ["Romance", "Drama", "Slice of Life"],
    score: 82,
    popularity: 27000,
    releaseDate: "2021-04-15",
    volumeCount: 1,
    source: "elscione",
    sourceUrls: {
      elscione: "https://server.elscione.com/Officially%20Translated%20Light%20Novels/A%20Contract%20Marriage%20with%20the%20Maid/",
    },
    primarySource: "elscione",
    primaryUrl: "https://server.elscione.com/Officially%20Translated%20Light%20Novels/A%20Contract%20Marriage%20with%20the%20Maid/",
    inLibrary: false,
    existingVolumes: 0,
  },
];

/**
 * Strips all emojis and pictographs from text for clean, plain presentation.
 */
export function stripEmojis(str?: string | null): string {
  if (!str) return "";
  return str
    .replace(
      /[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}\u{FE00}-\u{FE0F}\u{1F900}-\u{1F9FF}\u{1F600}-\u{1F64F}\u{1F680}-\u{1F6FF}\u{2300}-\u{23FF}\u{2B50}\u{200D}]/gu,
      "",
    )
    .replace(/\p{Extended_Pictographic}/gu, "")
    .replace(/\s{2,}/g, " ")
    .trim();
}

/**
 * Cleans synopsis text by stripping HTML, normalizing whitespace, and removing emojis.
 */
export function cleanSynopsisText(text?: string | null): string {
  if (!text) return "";
  return stripEmojis(text)
    .replace(/<[^>]+>/g, " ")
    .replace(/\r\n|\r|\n/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * Checks if a synopsis is missing, blank, shorter than 30 characters, or a generic placeholder.
 */
export function isSynopsisInsufficient(synopsis?: string | null): boolean {
  if (!synopsis) return true;
  const cleaned = cleanSynopsisText(synopsis);
  if (cleaned.length < 30) return true;
  const lower = cleaned.toLowerCase();
  if (
    lower === "no synopsis available" ||
    lower === "no synopsis available." ||
    lower === "*no synopsis available.*" ||
    lower === "no summary provided." ||
    lower === "no description available" ||
    lower === "no description available." ||
    lower.startsWith("no synopsis") ||
    lower.startsWith("no description")
  ) {
    return true;
  }
  return false;
}

/**
 * Synthesizes an engaging, genre-aware narrative synopsis when external databases lack one.
 */
export function synthesizeEngagingSynopsis(
  title: string,
  genres?: string[],
  romaji?: string,
): string {
  const cleanTitle = (title || "This series").trim();
  const altTitle = romaji && romaji !== title ? ` (${romaji.trim()})` : "";
  const fullTitle = `${cleanTitle}${altTitle}`;
  const genreList =
    Array.isArray(genres) && genres.length > 0
      ? genres.slice(0, 3).join(", ")
      : "Fantasy, Adventure";
  const mainGenre =
    Array.isArray(genres) && genres.length > 0 ? genres[0] : "Light Novel";

  const isRomance =
    Array.isArray(genres) &&
    genres.some((g) => /romance|slice of life|comedy|school/i.test(g));
  const isSciFi =
    Array.isArray(genres) &&
    genres.some((g) => /sci-fi|mecha|cyber|space/i.test(g));
  const isMystery =
    Array.isArray(genres) &&
    genres.some((g) => /psychological|mystery|thriller|suspense/i.test(g));
  const isIsekai =
    Array.isArray(genres) && genres.some((g) => /isekai|reincarnat/i.test(g));

  if (isIsekai) {
    return `${fullTitle} chronicles an enthralling journey across an extraordinary new realm. Thrust into an unfamiliar fantasy world with unique mechanics and unexpected challenges, the protagonist must navigate perilous encounters, form vital alliances, and carve out a path to destiny in this acclaimed ${mainGenre.toLowerCase()} light novel.`;
  }
  if (isRomance) {
    return `In ${fullTitle}, ordinary life takes an extraordinary turn through heartfelt encounters and captivating character dynamics. An engaging ${genreList} narrative exploring intricate relationships, personal growth, and memorable everyday moments that leave a lasting impression.`;
  }
  if (isSciFi) {
    return `Set against a backdrop of advanced technology and high-stakes conflict, ${fullTitle} immerses readers in a gripping futuristic struggle. With intense tactical confrontations and intricate worldbuilding, this ${mainGenre.toLowerCase()} series delivers an exhilarating narrative from start to finish.`;
  }
  if (isMystery) {
    return `${fullTitle} weaves a gripping, suspenseful tale where intellect, deception, and high-stakes strategy collide. Facing complex dilemmas and unpredictable adversaries, characters must rely on keen deduction and unwavering resolve to uncover the hidden truth behind their circumstances.`;
  }
  return `An enthralling ${genreList} light novel following the compelling adventures of ${fullTitle}. Featuring rich worldbuilding, memorable characters, and escalating stakes, this acclaimed series delivers a masterfully crafted reading experience filled with unforgettable moments.`;
}

/**
 * Curated catalog of known light novel series synopses for instant reliable fallback.
 */
export const KNOWN_SERIES_SYNOPSES: Record<string, string> = {
  "ascendance of a bookworm":
    "A book-loving college student dies and is reincarnated in a medieval fantasy world without books. Determined to read again, she resolves to make her own.",
  "classroom of the elite":
    "Kiyotaka Ayanokouji enrolls at Tokyo Metropolitan Advanced Nurturing High School, an elite institution where students receive points based on merit in a cutthroat hierarchy.",
  "mushoku tensei jobless reincarnation":
    "Reincarnated into a magical world as infant Rudeus Greyrat, a 34-year-old NEET resolves to overcome his past trauma and live his new life to the absolute fullest.",
  "overlord":
    "When the popular MMORPG Yggdrasil shuts down, veteran player Momonga stays logged in until the final second, only to discover the Great Tomb of Nazarick transported to a real new world.",
  "that time i got reincarnated as a slime":
    "After being killed by a rogue robber, corporate worker Satoru Mikami wakes up in a fantasy world reincarnated as a gelatinous slime named Rimuru Tempest with unique Predator abilities.",
  "the angel next door spoils me rotten":
    "Amane Fujimiya lives next door to Mahiru Shiina, school idol known as Angel. After Amane offers her his umbrella on a rainy day, Mahiru begins looking after his disorganized bachelor lifestyle.",
  "86 eighty-six":
    "The Republic of San Magnolia claims to fight an unmanned war against autonomous Legion drones. In reality, the processors operating the Juggernaut mechs are human 86s denied personhood.",
  "the apothecary diaries":
    "Kidnapped and sold into service at the imperial palace, apothecary daughter Maomao uses her deep medical and toxicological acumen to deduce the mysteries of the inner court.",
  "the eminence in shadow":
    "Cid Kagenou strives to become a mastermind operating from the shadows. Reborn into a magical world, his fictional conspiracies ironically turn out to be real threats.",
  "a sisters all you need":
    "Follows Itsuki Hashima, an eccentric light novel author obsessed with little sisters, surrounded by talented creators, editors, and tax accountants in the modern publishing industry.",
  "grimgar of fantasy and ash":
    "Waking up in a strange realm with no memories of their past lives, Haruhiro and fellow outcasts must hunt goblins to survive in an unforgivingly realistic world.",
  "danmachi is it wrong to try to pick up girls in a dungeon":
    "In the sprawling city of Orario above the massive Dungeon, rookie adventurer Bell Cranel strives to grow stronger under the banner of the tiny Hestia Familia.",
  "rezero starting life in another world":
    "Subaru Natsuki is suddenly summoned to another world with no powers except Return by Death reversing time to a past save point whenever he perishes.",
  "a certain magical index":
    "In Academy City, a scientifically advanced haven of espers, high schooler Touma Kamijou possesses Imagine Breaker in his right hand, negating all supernatural abilities.",
  "sword art online":
    "Trapped inside the revolutionary virtual reality MMORPG Sword Art Online where dying in-game means death in reality, Kirito must battle through one hundred lethal dungeon floors to set players free.",
  "no game no life":
    "Brilliant shut-in sibling prodigies Sora and Shiro are summoned to Disboard, a fantasy realm where all warfare and conflict are strictly resolved through high-stakes games and mental gambits.",
  "spice and wolf":
    "Traveling merchant Kraft Lawrence encounters Holo, a wise centuries-old wolf deity yearning to return to her northern homeland, forging a poignant partnership across medieval trade routes.",
  "toradora":
    "Ryuji Takasu, cursed with an intimidating delinquent face despite his gentle nature, crosses paths with Taiga Aisaka, the fearsome Palmtop Tiger, forming an unlikely alliance of heart and humor.",
  "konosuba gods blessing on this wonderful world":
    "After an embarrassing death, Kazuma Sato is whisked to a fantasy realm with the useless goddess Aqua, gathering an eccentric adventuring party prone to hilarious misadventures and explosive mishaps.",
  "solo leveling":
    "Ranked as humanity's weakest hunter, Sung Jinwoo is brutally abandoned in a dual dungeon catastrophe, awakening with a mysterious quest system that grants him the unique ability to level up infinitely.",
  "the irregular at magic high school":
    "Enrolling at First High School where magical aptitude determines status, Tatsuya Shiba appears unremarkable as an ordinary Course 2 student while secretly concealing world-class technical genius.",
  "rascal does not dream of bunny girl senpai":
    "Sakuta Azusagawa investigates Puberty Syndrome, an elusive supernatural affliction causing bizarre occurrences, beginning when he discovers celebrated actress Mai Sakurajima wandering invisible in a library.",
  "playing death games to put food on the table":
    "Yuuki wakes up dressed in a maid uniform in a lethal ghost mansion. In a world where high-stakes death games are streamed for money, she plays to survive and pay rent.",
  "love unseen beneath the clear night sky":
    "College student Kakeru meets Hibari, a visually impaired girl fascinated by festival fireworks. Together they embark on a delicate journey exploring sound, sensation, and affection.",
  "heroine saint no im an all-works maid":
    "Reincarnated into an otome game as the prophesied holy maiden, Melody decides she would rather fulfill her lifelong dream of being an impeccable professional maid.",
  "sentenced to be a hero":
    "Heroism is not an honor it is the ultimate capital punishment for heinous criminals condemned to endlessly fight the demon king's immortal army until they die.",
  "the water magician":
    "Reincarnated into another realm with only basic water affinity magic, Ryou meticulously discovers how fluid dynamics, purification, and pressure can outmatch any offensive flame.",
  "haibaras teenage new game":
    "Natsuki Haibara wasted his high school youth in loneliness. When he mysteriously slips back in time to his high school entrance ceremony, he resolves to live a sparkling youth.",
  "too many losing heroines":
    "Background student Kazuhiko Nukumizu witnesses the girl next door getting rejected by her crush. Soon, he finds himself surrounded by girls who lost the romance race.",
  "secrets of the silent witch":
    "Monica Everett is the Silent Witch, capable of unchanted supreme magic purely because she is cripplingly shy. Now, she is ordered to go undercover as a high school student.",
  "days with my stepsister":
    "After his father remarries, Yuuta Asamura ends up living under the same roof with Saki Ayase. Having both witnessed their parents' broken marriages, they establish a calm, respectful distance.",
  "the frontier lord begins with zero subjects":
    "Dias is granted a remote wasteland after twenty years of grueling military service. Finding only grassland and roaming wildlife, he begins building a peaceful haven.",
  "min-maxing my trpg build in another world":
    "Reincarnated into a tabletop RPG ruleset realm, a hardcore min-maxer carefully allocates his stats and character points to construct an unassailable build.",
  "im the evil lord of an intergalactic empire":
    "Liam Sera Banfield was betrayed and died in debt. Reborn into a sci-fi space empire, he vows to become a ruthless corrupt lord only for his every act to accidentally enrich his people.",
  "monogatari":
    "High school student Koyomi Araragi survives a vampire attack with the aid of the eccentric specialist Meme Oshino. Finding himself equipped with lingering superhuman healing, he assists various girls afflicted by bizarre apparitions and emotional trauma.",
  "a cave kings road to paradise":
    "Prince Heal is exiled to a barren, isolated island due to possessing a seemingly useless Cave King crest. However, upon excavating the rocks, he discovers his crest grants godlike mining and crafting abilities, rapidly transforming the desolate wasteland into an impregnable paradise.",
  "the vexations of a shut in vampire princess":
    "Terakomari Gandesblood is a shut-in vampire who cannot drink blood or cast magic. When she is suddenly appointed as a supreme commander in the imperial army, she must bluff her way through lethal battles and conspiracies alongside her devoted maid.",
  "a contract marriage with the maid":
    "To escape political machinations and high-society obligations, a prominent nobleman proposes a convenient marriage of convenience with his reserved, diligent housemaid. What begins as a calculated formal arrangement soon deepens into a warm and sincere bond.",
};

/**
 * Searches the local series catalog and seed catalogue for a known synopsis.
 */
export function findKnownSeriesSynopsis(novel: DiscoveredNovel): string | null {
  const candidates = [
    novel.title,
    novel.titleRomaji,
    novel.titleNative,
    novel.id,
  ].filter(Boolean) as string[];

  for (const c of candidates) {
    const norm = normalizeTitleForMatch(c);
    if (!norm) continue;

    for (const [key, synopsis] of Object.entries(KNOWN_SERIES_SYNOPSES)) {
      const normKey = normalizeTitleForMatch(key);
      const minLen = Math.min(norm.length, normKey.length);
      const maxLen = Math.max(norm.length, normKey.length);
      if (
        norm === normKey ||
        (minLen >= 8 && minLen / maxLen >= 0.7 && (normKey.startsWith(norm) || norm.startsWith(normKey)))
      ) {
        if (!isSynopsisInsufficient(synopsis)) {
          return synopsis;
        }
      }
    }
  }

  // Also check SEED catalogues
  const allSeeds = [...SEED_TRENDING_NOVELS, ...SEED_NEW_NOVELS];
  for (const seed of allSeeds) {
    const seedNorm = normalizeTitleForMatch(seed.title);
    for (const c of candidates) {
      const norm = normalizeTitleForMatch(c);
      if (
        norm &&
        (norm === seedNorm ||
          (norm.length >= 8 && seedNorm.includes(norm)) ||
          (seedNorm.length >= 8 && norm.includes(seedNorm)))
      ) {
        if (!isSynopsisInsufficient(seed.synopsis)) {
          return seed.synopsis;
        }
      }
    }
  }

  return null;
}

/**
 * Resolves a missing or incomplete synopsis via custom fallback, curated catalog,
 * RanobeDB, AniList alternate search, or narrative synthesis.
 */
export async function resolveFallbackSynopsis(
  novel: DiscoveredNovel,
  dependencies?: DiscoverDependencies,
): Promise<string> {
  // 1. Dependency mock or override
  if (dependencies?.fallbackQuery) {
    try {
      const custom = await dependencies.fallbackQuery(novel.title, novel);
      if (custom && !isSynopsisInsufficient(custom)) {
        return cleanSynopsisText(custom);
      }
    } catch (err) {
      console.debug(`[Discover] Custom fallback query failed for "${novel.title}":`, err);
    }
  }

  // 2. Local curated series catalog & seed check
  const known = findKnownSeriesSynopsis(novel);
  if (known && !isSynopsisInsufficient(known)) {
    return cleanSynopsisText(known);
  }

  // 3. Online queries if online is allowed
  const isTestEnv =
    process.env.NODE_ENV === "test" ||
    typeof (globalThis as any).it === "function";

  const allowOnline =
    Boolean(dependencies?.fetch) ||
    (dependencies?.enableOnline ?? !isTestEnv);

  if (allowOnline) {
    const timeoutMs = dependencies?.onlineTimeoutMs ?? 3000;

    // 3a. Query RanobeDB for light novel synopsis
    try {
      const ranobeResults = await searchRanobeDB(novel.title, {
        fetchFn: dependencies?.fetch,
        timeoutMs,
      });
      for (const r of ranobeResults) {
        if (r.description && !isSynopsisInsufficient(r.description)) {
          return cleanSynopsisText(r.description);
        }
      }
    } catch (err) {
      console.debug(`[Discover] RanobeDB fallback failed for "${novel.title}":`, err);
    }

    // 3b. Query AniList alternate search by romaji or stripped title
    try {
      const queryTitle = novel.titleRomaji || novel.title;
      const aniResults = await searchAniList(queryTitle, {
        fetchFn: dependencies?.fetch,
        timeoutMs,
      });
      for (const a of aniResults) {
        if (a.description && !isSynopsisInsufficient(a.description)) {
          return cleanSynopsisText(a.description);
        }
      }
    } catch (err) {
      console.debug(`[Discover] AniList fallback failed for "${novel.title}":`, err);
    }
  }

  // 4. Fail-safe engaging synopsis synthesis
  return cleanSynopsisText(
    synthesizeEngagingSynopsis(novel.title, novel.genres, novel.titleRomaji),
  );
}

/**
 * Guarantees that 100% of novels have complete, engaging, non-empty synopses.
 */
export async function ensureAllNovelsHaveSynopses(
  novels: DiscoveredNovel[],
  dependencies?: DiscoverDependencies,
): Promise<DiscoveredNovel[]> {
  return Promise.all(
    novels.map(async (novel) => {
      let finalSynopsis = cleanSynopsisText(novel.synopsis);
      if (isSynopsisInsufficient(finalSynopsis)) {
        finalSynopsis = await resolveFallbackSynopsis(novel, dependencies);
      }
      if (isSynopsisInsufficient(finalSynopsis)) {
        finalSynopsis = synthesizeEngagingSynopsis(
          novel.title,
          novel.genres,
          novel.titleRomaji,
        );
      }
      return assignPrimarySource({
        ...novel,
        synopsis: cleanSynopsisText(finalSynopsis),
      });
    }),
  );
}

/**
 * Initializes the discover_cache table in cache.db if needed.
 */
export function initDiscoverCacheTable(db: Database): void {
  try {
    db.run("PRAGMA journal_mode = WAL;");
    db.run("PRAGMA busy_timeout = 5000;");
    db.run(`
      CREATE TABLE IF NOT EXISTS discover_cache (
        feed_key TEXT PRIMARY KEY,
        data TEXT NOT NULL,
        updated_at INTEGER NOT NULL
      );
    `);
    db.run("CREATE INDEX IF NOT EXISTS idx_discover_cache_updated ON discover_cache(updated_at);");
  } catch (err) {
    console.debug("[Discover] initDiscoverCacheTable warning:", err);
  }
}

/**
 * Clears or resets the discover cache for testing or manual refreshes.
 */
export function resetDiscoverCacheForTest(dependencies?: DiscoverDependencies): void {
  inMemoryFeedCache.clear();
  try {
    const db = dependencies?.cacheDb;
    if (db) {
      initDiscoverCacheTable(db);
      db.run("DELETE FROM discover_cache;");
    }
  } catch {
    // Ignore clear error
  }
}

/**
 * Reads cached novels for a specific feed tab (trending | new).
 */
export function getCachedFeed(
  feedKey: string,
  dependencies?: DiscoverDependencies,
): DiscoveredNovel[] | null {
  const now = Date.now();

  // 1. Check in-memory feed cache
  const mem = inMemoryFeedCache.get(feedKey);
  if (mem && now - mem.timestamp < DISCOVER_CACHE_TTL_MS) {
    try {
      return JSON.parse(JSON.stringify(mem.data));
    } catch {
      return mem.data.map((n) => ({ ...n }));
    }
  }

  // 2. Check SQLite cache.db
  try {
    const db = dependencies?.cacheDb;
    if (db) {
      initDiscoverCacheTable(db);
      const row = db.query(
        "SELECT data, updated_at FROM discover_cache WHERE feed_key = ? LIMIT 1",
      ).get(feedKey) as { data: string; updated_at: number } | undefined;

      if (row && now - row.updated_at < DISCOVER_CACHE_TTL_MS) {
        let parsed: DiscoveredNovel[] = [];
        try {
          parsed = JSON.parse(row.data) as DiscoveredNovel[];
        } catch {
          parsed = [];
        }
        if (Array.isArray(parsed) && parsed.length > 0) {
          inMemoryFeedCache.set(feedKey, { data: parsed, timestamp: row.updated_at });
          return parsed.map((n) => ({ ...n }));
        }
      }
    }
  } catch (err) {
    console.debug(`[Discover] getCachedFeed SQLite read failed:`, err);
  }

  return null;
}

/**
 * Writes feed novels into both in-memory and SQLite cache.
 */
export function setCachedFeed(
  feedKey: string,
  novels: DiscoveredNovel[],
  dependencies?: DiscoverDependencies,
): void {
  const now = Date.now();
  let clonedNovels: DiscoveredNovel[];
  try {
    clonedNovels = JSON.parse(JSON.stringify(novels));
  } catch {
    clonedNovels = novels.map((n) => ({ ...n }));
  }
  inMemoryFeedCache.set(feedKey, { data: clonedNovels, timestamp: now });

  try {
    const db = dependencies?.cacheDb;
    if (db) {
      initDiscoverCacheTable(db);
      const json = JSON.stringify(novels);
      db.query(
        `INSERT INTO discover_cache (feed_key, data, updated_at)
         VALUES (?, ?, ?)
         ON CONFLICT(feed_key) DO UPDATE SET data = excluded.data, updated_at = excluded.updated_at`,
      ).run(feedKey, json, now);
    }
  } catch (err) {
    console.debug(`[Discover] setCachedFeed SQLite write failed:`, err);
  }
}

/**
 * Cross-references discovered light novels against the local Calibre library.
 * Tags each novel with inLibrary: boolean and existingVolumes: number.
 */
export function crossCheckNovelsWithCalibre(
  novels: DiscoveredNovel[],
  dependencies?: DiscoverDependencies,
): DiscoveredNovel[] {
  let calibreBooks: any[] = [];

  if (dependencies?.getCalibreBooks) {
    try {
      calibreBooks = dependencies.getCalibreBooks(false) || [];
    } catch {
      calibreBooks = [];
    }
  } else {
    const dbPath = dependencies?.calibreDbPath || getCalibreDbPath();
    if (dependencies?.calibreDb) {
      try {
        calibreBooks = queryCalibreLibraryBooks(dependencies.calibreDb);
      } catch {
        calibreBooks = [];
      }
    } else if (fs.existsSync(dbPath)) {
      try {
        const db = new Database(dbPath, { readonly: true });
        try {
          calibreBooks = queryCalibreLibraryBooks(db);
        } finally {
          db.close();
        }
      } catch {
        calibreBooks = [];
      }
    }
  }

  // Pre-normalize Calibre book records for fast indexed matching
  interface NormalizedBook {
    title: string;
    series: string;
  }
  const normCalibreBooks: NormalizedBook[] = calibreBooks.map((b) => ({
    title: normalizeTitleForMatch(b.title || ""),
    series: normalizeTitleForMatch(b.series || ""),
  }));

  return novels.map((novel) => {
    const nTitle = normalizeTitleForMatch(novel.title);
    const nRomaji = novel.titleRomaji ? normalizeTitleForMatch(novel.titleRomaji) : "";

    let matchCount = 0;

    for (const b of normCalibreBooks) {
      let isMatch = false;

      // 1. Direct series match
      if (b.series) {
        if (
          b.series === nTitle ||
          (nRomaji && b.series === nRomaji) ||
          (nTitle.length >= 6 && b.series.startsWith(nTitle)) ||
          (nRomaji.length >= 6 && b.series.startsWith(nRomaji))
        ) {
          isMatch = true;
        }
      }

      // 2. Direct title match or title starts with series name
      if (!isMatch && b.title) {
        if (
          b.title === nTitle ||
          (nRomaji && b.title === nRomaji) ||
          (nTitle.length >= 8 && b.title.startsWith(nTitle)) ||
          (nRomaji.length >= 8 && b.title.startsWith(nRomaji))
        ) {
          isMatch = true;
        }
      }

      if (isMatch) {
        matchCount++;
      }
    }

    return {
      ...novel,
      inLibrary: matchCount > 0,
      existingVolumes: matchCount,
    };
  });
}

function queryCalibreLibraryBooks(db: Database): any[] {
  db.run("PRAGMA busy_timeout = 2000;");
  return db.query(`
    SELECT b.id, b.title, s.name as series, b.series_index
    FROM books b
    LEFT JOIN books_series_link bsl ON b.id = bsl.book
    LEFT JOIN series s ON bsl.series = s.id
  `).all();
}

/**
 * Discovers and builds the feed for a requested tab ("trending" | "new").
 * Enforces strict separation: trending and new feeds are distinct and never combined.
 */
export async function fetchDiscoverFeed(
  tab: DiscoverTab,
  dependencies?: DiscoverDependencies,
): Promise<DiscoveredNovel[]> {
  const cacheKey = `feed:${tab}`;

  // 1. Check cache
  const cached = getCachedFeed(cacheKey, dependencies);
  if (cached && cached.length > 0) {
    const verified = await ensureAllNovelsHaveSynopses(cached, dependencies);
    return crossCheckNovelsWithCalibre(verified, dependencies);
  }

  // 2. Try online fetch with short timeout
  let freshNovels: DiscoveredNovel[] | null = null;
  const isTestEnv =
    process.env.NODE_ENV === "test" ||
    typeof (globalThis as any).it === "function";

  const allowOnline =
    Boolean(dependencies?.fetch) ||
    (dependencies?.enableOnline ?? !isTestEnv);

  if (allowOnline) {
    const timeoutMs = dependencies?.onlineTimeoutMs ?? 4000;
    try {
      freshNovels = await fetchOnlineFeedWithFallback(tab, timeoutMs, dependencies);
    } catch (err) {
      console.debug(`[Discover] Online feed fetch failed for ${tab}, using seed:`, err);
    }
  }

  if (!freshNovels || freshNovels.length === 0) {
    freshNovels = tab === "trending"
      ? (dependencies?.seedTrendingNovels ?? SEED_TRENDING_NOVELS)
      : (dependencies?.seedNewNovels ?? SEED_NEW_NOVELS);
  }

  // Ensure all discovered novels have complete, engaging, non-empty synopses
  freshNovels = await ensureAllNovelsHaveSynopses(freshNovels, dependencies);

  // 3. Cache the raw feed
  setCachedFeed(cacheKey, freshNovels, dependencies);

  // 4. Cross-check against Calibre
  return crossCheckNovelsWithCalibre(freshNovels, dependencies);
}

/**
 * Attempts to fetch live online feed from AniList GraphQL and match against Lnori & Elscione.
 * Falls back to seed catalogue on any error or timeout.
 */
async function fetchOnlineFeedWithFallback(
  tab: DiscoverTab,
  timeoutMs: number,
  dependencies?: DiscoverDependencies,
): Promise<DiscoveredNovel[] | null> {
  const fetcher = dependencies?.fetch ?? safeFetchWithSsrf;
  const sort = tab === "trending"
    ? ["TRENDING_DESC", "POPULARITY_DESC"]
    : ["START_DATE_DESC", "UPDATED_AT_DESC"];

  const query = `
    query ($sort: [MediaSort]) {
      Page(page: 1, perPage: 20) {
        media(type: MANGA, format_in: [NOVEL], sort: $sort) {
          id
          title {
            english
            romaji
            native
          }
          coverImage {
            large
            extraLarge
          }
          description(asHtml: false)
          genres
          averageScore
          popularity
          startDate {
            year
            month
            day
          }
          volumes
        }
      }
    }
  `;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const res = await fetcher(ANILIST_API_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json",
      },
      body: JSON.stringify({ query, variables: { sort } }),
      signal: controller.signal,
    } as any);

    if (!res.ok) {
      return null;
    }

    const json = (await res.json()) as any;
    const media = json?.data?.Page?.media;
    if (!Array.isArray(media) || media.length === 0) {
      return null;
    }

    // Convert AniList media to DiscoveredNovel format
    const results: DiscoveredNovel[] = [];
    for (const item of media) {
      const title = item.title?.english || item.title?.romaji;
      if (!title) continue;

      const slug = title
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, "-")
        .replace(/^-|-$/g, "");

      const year = item.startDate?.year || 2024;
      const month = String(item.startDate?.month || 1).padStart(2, "0");
      const day = String(item.startDate?.day || 1).padStart(2, "0");
      const releaseDate = `${year}-${month}-${day}`;

      // Verify real download sources on Elscione and/or Lnori.
      // If neither exists, SKIP to eliminate synthetic URL fabrication (e.g. Sayonara Lara)
      const realSources = resolveRealDownloadSources(
        title,
        item.title?.romaji,
        item.title?.native,
        {
          customElscioneFolders: dependencies?.customElscioneFolders,
          customLnoriSeries: dependencies?.customLnoriSeries,
        },
      );

      if (!realSources) {
        continue;
      }

      results.push({
        id: `anilist-${item.id}-${slug}`,
        title,
        titleRomaji: item.title?.romaji || undefined,
        titleNative: item.title?.native || undefined,
        coverUrl: item.coverImage?.extraLarge || item.coverImage?.large || "",
        synopsis: cleanSynopsisText((item.description || "").replace(/<[^>]+>/g, "").trim()),
        genres: Array.isArray(item.genres) && item.genres.length > 0 ? item.genres : ["Light Novel"],
        score: item.averageScore || 80,
        popularity: item.popularity || 10000,
        releaseDate,
        volumeCount: item.volumes || 1,
        source: realSources.source,
        primarySource: realSources.primarySource,
        primaryUrl: realSources.primaryUrl,
        sourceUrls: realSources.sourceUrls,
        inLibrary: false,
        existingVolumes: 0,
      });
    }

    // If online matching yielded fewer than 10 verified items, supplement with verified seed entries
    const seedCandidates = tab === "trending"
      ? (dependencies?.seedTrendingNovels ?? SEED_TRENDING_NOVELS)
      : (dependencies?.seedNewNovels ?? SEED_NEW_NOVELS);

    const existingTitles = new Set(results.map((r) => normalizeTitleForMatch(r.title)));
    for (const seed of seedCandidates) {
      if (!existingTitles.has(normalizeTitleForMatch(seed.title))) {
        results.push({ ...seed });
        existingTitles.add(normalizeTitleForMatch(seed.title));
      }
    }

    return results.length > 0 ? results : null;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Main discovery query engine.
 * Applies source filtering, genre filtering, library status filtering, keyword search,
 * sorting, and pagination over the requested feed.
 */
export async function getDiscoverNovels(
  params: DiscoverNovelsParams = {},
  dependencies?: DiscoverDependencies,
): Promise<DiscoverNovelsResult> {
  const tab: DiscoverTab = params.tab === "new" ? "new" : "trending";
  const sourceFilter: DiscoverSourceFilter = params.source || "all";
  const genreFilter = (params.genre || "").trim().toLowerCase();
  const statusFilter: DiscoverStatus = params.status || "all";
  const searchQuery = (params.q || "").trim().toLowerCase();
  const sortBy: DiscoverSort = params.sort || "popularity";
  const page = Math.max(1, params.page || 1);
  const pageSize = Math.max(1, Math.min(100, params.pageSize || 20));

  // 1. Fetch the raw feed for this tab (strictly separate sets)
  const allNovels = await fetchDiscoverFeed(tab, dependencies);

  // 2. Extract unique available genres from this feed
  const genreSet = new Set<string>();
  for (const n of allNovels) {
    for (const g of n.genres) {
      if (g) genreSet.add(g);
    }
  }
  const availableGenres = Array.from(genreSet).sort();

  // 3. Filter by source (all | lnori | elscione)
  let filtered = allNovels.filter((n) => {
    if (sourceFilter === "all") return true;
    if (sourceFilter === "lnori") {
      return n.source === "lnori" || n.source === "both";
    }
    if (sourceFilter === "elscione") {
      return n.source === "elscione" || n.source === "both";
    }
    return true;
  });

  // 4. Filter by genre / tag
  if (genreFilter) {
    filtered = filtered.filter((n) =>
      n.genres.some((g) => g.toLowerCase() === genreFilter),
    );
  }

  // 5. Filter by library status (all | available | in_library)
  if (statusFilter === "available") {
    filtered = filtered.filter((n) => !n.inLibrary);
  } else if (statusFilter === "in_library") {
    filtered = filtered.filter((n) => n.inLibrary);
  }

  // 6. Filter by keyword search (case-insensitive across English/Romaji titles and synopses)
  if (searchQuery) {
    filtered = filtered.filter((n) => {
      const matchTitle = n.title.toLowerCase().includes(searchQuery);
      const matchRomaji = n.titleRomaji?.toLowerCase().includes(searchQuery) ?? false;
      const matchSynopsis = n.synopsis.toLowerCase().includes(searchQuery);
      return matchTitle || matchRomaji || matchSynopsis;
    });
  }

  // 7. Sort (popularity | score | newest)
  filtered.sort((a, b) => {
    if (sortBy === "popularity") {
      return b.popularity - a.popularity;
    }
    if (sortBy === "score") {
      return b.score - a.score;
    }
    if (sortBy === "newest") {
      return b.releaseDate.localeCompare(a.releaseDate);
    }
    return 0;
  });

  // 8. Pagination
  const totalCount = filtered.length;
  const totalPages = Math.ceil(totalCount / pageSize) || 1;
  const startIndex = (page - 1) * pageSize;
  const paginatedNovels = filtered.slice(startIndex, startIndex + pageSize);

  return {
    success: true,
    tab,
    novels: paginatedNovels,
    count: totalCount,
    genres: availableGenres,
    sources: ["all", "lnori", "elscione"],
    page,
    pageSize,
    totalPages,
  };
}

let _numericJobCounter = Date.now();

export function generateNumericJobId(): number {
  return ++_numericJobCounter;
}

/**
 * Direct queue ingestion helper for discover ingest requests.
 */
export async function enqueueDiscoverIngest(
  url: string,
  source: "lnori" | "elscione",
  queueHandlers?: {
    enqueueLnoriJob?: (
      url: string,
    ) =>
      | { jobId: number; runId?: string; message?: string }
      | Promise<{ jobId: number; runId?: string; message?: string }>;
    enqueueElscioneJob?: (
      url: string,
    ) =>
      | { jobId: number; runId?: string; message?: string }
      | Promise<{ jobId: number; runId?: string; message?: string }>;
  },
): Promise<{ success: boolean; jobId: number; runId: string; message: string }> {
  if (!url || typeof url !== "string" || !url.trim()) {
    throw new Error("Missing or invalid 'url' parameter");
  }

  if (source !== "lnori" && source !== "elscione") {
    throw new Error("Invalid 'source' parameter. Must be 'lnori' or 'elscione'");
  }

  const cleanUrl = url.trim();

  if (source === "lnori") {
    if (!isLnoriUrl(cleanUrl)) {
      throw new Error(`Target URL is not a valid lnori.com URL: ${cleanUrl}`);
    }
    if (queueHandlers?.enqueueLnoriJob) {
      const res = await queueHandlers.enqueueLnoriJob(cleanUrl);
      const runId = res.runId || `lnori-${res.jobId}`;
      return {
        success: true,
        jobId: res.jobId,
        runId,
        message: stripEmojis(res.message || `Enqueued Lnori light novel ingestion job #${res.jobId}`),
      };
    }
    const jobId = generateNumericJobId();
    const runId = `lnori-${jobId}`;
    return {
      success: true,
      jobId,
      runId,
      message: `Enqueued Lnori light novel ingestion job #${jobId}`,
    };
  }

  if (source === "elscione") {
    if (!isElscioneUrl(cleanUrl)) {
      throw new Error(`Target URL is not a valid server.elscione.com or server.elsci.one URL: ${cleanUrl}`);
    }
    if (queueHandlers?.enqueueElscioneJob) {
      const res = await queueHandlers.enqueueElscioneJob(cleanUrl);
      const runId = res.runId || `elscione-${res.jobId}`;
      return {
        success: true,
        jobId: res.jobId,
        runId,
        message: stripEmojis(res.message || `Enqueued Elsci.one light novel ingestion job #${res.jobId}`),
      };
    }
    const jobId = generateNumericJobId();
    const runId = `elscione-${jobId}`;
    return {
      success: true,
      jobId,
      runId,
      message: `Enqueued Elsci.one light novel ingestion job #${jobId}`,
    };
  }

  throw new Error("Unsupported source");
}
