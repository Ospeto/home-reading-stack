import fs from "node:fs";
import crypto from "node:crypto";
import process from "node:process";
import { Database } from "bun:sqlite";
import { safeFetchWithSsrf, sanitizeErrorMessage } from "./security";
import { getCalibreDbPath, isLnoriUrl, fetchLnoriHtml, extractManifestFromHtml, parseLnoriUrl } from "./lnori";
import {
  isElscioneUrl,
  parseElscioneUrl,
  extractElscioneManifest,
  extractVolumeNumberFromFilename as extractVolumeNumberFromFilenameElscione,
  safeDecodeURIComponent,
} from "./elscione";
import { searchRanobeDB, searchAniList, extractVolumeNumber, parseMultiPartVolume } from "./scraper";
import discoverCatalog from "./discover-catalog.json";

export type DiscoverSource = "lnori" | "elscione" | "both";
export type DiscoverSourceFilter = "all" | "lnori" | "elscione";
export type DiscoverTab = "trending" | "new" | "all";
export type DiscoverStatus = "all" | "available" | "in_library" | "incomplete" | "missing_volumes";
export type DiscoverSort = "popularity" | "score" | "newest" | "title_asc";

export interface DiscoverSourceUrls {
  lnori?: string;
  elscione?: string;
}

export interface VerifiedSourceInventory {
  source: "elscione" | "lnori";
  url: string;
  status: "verified" | "unverified" | "error";
  volumeCount?: number;
  volumes?: number[];
  error?: string;
  verifiedAt?: number;
}

export interface DiscoveredNovel {
  id: string;
  title: string;
  titleRomaji?: string;
  titleNative?: string;
  author: string;
  coverUrl: string;
  synopsis: string;
  genres: string[];
  score: number;
  popularity: number;
  releaseDate: string;
  volumeCount: number;
  catalogVolumeCount?: number;
  verifiedVolumeCount?: number;
  verifiedVolumes?: number[];
  source: DiscoverSource;
  primarySource?: "elscione" | "lnori";
  primaryUrl?: string;
  sourceUrls: DiscoverSourceUrls;
  sources?: VerifiedSourceInventory[];
  sourceInventories?: Record<string, VerifiedSourceInventory>;
  inLibrary: boolean;
  existingVolumes: number;
  ownedVolumeIndices?: number[];
  missingVolumeIndices?: number[];
  missingVolumeCount?: number;
  sourceStatus?: "verified" | "unverified" | "error";
  allVerifiedOwned?: boolean;
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
  skipCrossCheck?: boolean;
  resolveSourceVolumes?: (
    url: string,
    source: "elscione" | "lnori",
  ) => Promise<VerifiedSourceInventory | null> | VerifiedSourceInventory | null;
  useHelper?: boolean;
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
    .replace(/&/g, " and ")
    .replace(/[-_—–~:|/]+/g, " ")
    .replace(/[^\p{L}\p{N}\s]/gu, "")
    .replace(/\s+/g, " ")
    .trim();
}

export const REAL_ELSCIONE_FOLDERS: string[] = discoverCatalog.elscioneFolders;
export const REAL_LNORI_SERIES: Array<{ id: number; slug: string }> = discoverCatalog.lnoriSeries;
export const CATALOG_COVERS: Record<string, string> =
  (discoverCatalog as any).catalogCovers || {};
export const CATALOG_VOLUMES: Record<string, number> =
  (discoverCatalog as any).catalogVolumes || {};

export function resolveCatalogCover(title: string, romaji?: string): string | null {
  const rawCandidates = [title, romaji].filter(Boolean) as string[];
  const candidates: string[] = [];
  for (const c of rawCandidates) {
    if (!candidates.includes(c)) candidates.push(c);
    for (const v of cleanCalibreTitleVariants(c)) {
      if (!candidates.includes(v)) candidates.push(v);
    }
  }

  for (const c of candidates) {
    const norm = normalizeTitleForMatch(c);
    if (norm && CATALOG_COVERS[norm]) return CATALOG_COVERS[norm];
    const can = canonicalTitleKey(c);
    if (can && CATALOG_COVERS[can]) return CATALOG_COVERS[can];
    const slug = c.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
    if (slug && CATALOG_COVERS[slug]) return CATALOG_COVERS[slug];
  }
  return null;
}

const elscioneNormalizedMap = new Map<string, string>();
for (const folder of REAL_ELSCIONE_FOLDERS) {
  elscioneNormalizedMap.set(normalizeTitleForMatch(folder), folder);
}

const lnoriNormalizedMap = new Map<string, { id: number; slug: string }>();
for (const s of REAL_LNORI_SERIES) {
  lnoriNormalizedMap.set(normalizeTitleForMatch(s.slug.replace(/-/g, " ")), s);
}

interface NormalizedLnoriSeries {
  id: number;
  slug: string;
  normSlug: string;
}

const precomputedRealLnoriSeries: NormalizedLnoriSeries[] = REAL_LNORI_SERIES.map((s) => ({
  id: s.id,
  slug: s.slug,
  normSlug: normalizeTitleForMatch(s.slug.replace(/-/g, " ")),
}));

interface NormalizedElscioneFolder {
  folder: string;
  normFolder: string;
}

const precomputedRealElscioneFolders: NormalizedElscioneFolder[] = REAL_ELSCIONE_FOLDERS.map((f) => ({
  folder: f,
  normFolder: normalizeTitleForMatch(f),
}));

export const KNOWN_TITLE_TO_ELSCIONE: Record<string, string> = {
  "rezero": "ReZero - Starting Life in Another World",
  "rezero starting life in another world": "ReZero - Starting Life in Another World",
  "re zero": "ReZero - Starting Life in Another World",
  "re zero starting life in another world": "ReZero - Starting Life in Another World",
  "danmachi": "DanMachi",
  "is it wrong to try to pick up girls in a dungeon": "DanMachi",
  "86": "86",
  "86 eighty six": "86",
  "86eightysix": "86",
  "the irregular at magic high school": "The Irregular at Magic High School",
  "mahouka koukou no rettousei": "The Irregular at Magic High School",
  "mahouka": "The Irregular at Magic High School",
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
  "sao": "Sword Art Online",
  "no game no life": "No Game No Life",
  "spice and wolf": "Spice and Wolf",
  "spice wolf": "Spice and Wolf",
  "worldend": "WorldEnd",
  "worldend what do you do at the end of the world are you busy will you save us": "WorldEnd",
  "suka suka": "WorldEnd",
  "shuumatsu nani shitemasu ka isogashii desu ka sukutte moratte ii desu ka": "WorldEnd",
  "goblin slayer": "Goblin Slayer",
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
  "cote": "Classroom of the Elite",
  "mushoku tensei": "Mushoku Tensei",
  "mushoku tensei jobless reincarnation": "Mushoku Tensei",
  "overlord": "Overlord",
  "that time i got reincarnated as a slime": "That Time I Got Reincarnated as a Slime",
  "slime": "That Time I Got Reincarnated as a Slime",
  "tensura": "That Time I Got Reincarnated as a Slime",
  "oregairu": "My Youth Romantic Comedy is Wrong",
  "my youth romantic comedy is wrong": "My Youth Romantic Comedy is Wrong",
  "my youth romantic comedy is wrong as i expected": "My Youth Romantic Comedy is Wrong",
  "monogatari": "Monogatari Series",
  "bakemonogatari": "Monogatari Series",
  "monogatari series": "Monogatari Series",
  "grimgar of fantasy and ash": "Grimgar of Fantasy and Ash",
  "black bullet": "Black Bullet",
  "black-bullet": "Black Bullet",
  "the rising of the shield hero": "The Rising of the Shield Hero",
  "shield hero": "The Rising of the Shield Hero",
  "tate no yuusha no nariagari": "The Rising of the Shield Hero",
  "tate no yuusha": "The Rising of the Shield Hero",
  "bunny girl senpai": "Rascal Does Not Dream Series",
  "rascal does not dream series": "Rascal Does Not Dream Series",
  "trapped in a dating sim": "Trapped in a Dating Sim",
  "trapped in a dating sim the world of otome games is tough for mobs": "Trapped in a Dating Sim",
  "mobuseka": "Trapped in a Dating Sim",
  "trapped in a dating sim otome games are tough for us too": "Trapped in a Dating Sim - Otome Games Are Tough For Us, Too!",
  "otome games are tough for us too": "Trapped in a Dating Sim - Otome Games Are Tough For Us, Too!",
  "how a realist hero rebuilt the kingdom": "How a Realist Hero Rebuilt the Kingdom",
  "realist hero": "How a Realist Hero Rebuilt the Kingdom",
  "hell mode": "Hell Mode",
  "hell mode the hardcore gamer dominates in another world with garbage balancing": "Hell Mode",
  "reincarnated as a sword": "Reincarnated as a Sword",
  "tenken": "Reincarnated as a Sword",
  "the genius princes guide to raising a nation out of debt": "The Genius Prince's Guide to Raising a Nation Out of Debt",
  "the genius princes guide to raising a nation out of debt hey how about treason": "The Genius Prince's Guide to Raising a Nation Out of Debt",
  "genius prince": "The Genius Prince's Guide to Raising a Nation Out of Debt",
  "campfire cooking in another world with my absurd skill": "Campfire Cooking in Another World With My Absurd Skill",
  "campfire cooking": "Campfire Cooking in Another World With My Absurd Skill",
  "the asterisk war": "The Asterisk War",
  "asterisk war": "The Asterisk War",
  "gakusen toshi asterisk": "The Asterisk War",
  "combatants will be dispatched": "Combatants Will Be Dispatched",
  "7th time loop": "7th Time Loop",
  "7th time loop the villainess enjoys a carefree life": "7th Time Loop",
  "7th time loop the villainess enjoys a carefree life married to her worst enemy": "7th Time Loop",
  "sound euphonium": "Hibike! Euphonium",
  "hibike euphonium": "Hibike! Euphonium",
  "kinos journey": "Kino no Tabi",
  "kino no tabi": "Kino no Tabi",
  "the beginning after the end": "The Beginning After The End",
  "tbate": "The Beginning After The End",
  "the magical revolution of the reincarnated princess": "The Magical Revolution of the Reincarnated Princess and the Genius Young Lady",
  "magical revolution": "The Magical Revolution of the Reincarnated Princess and the Genius Young Lady",
  "the worlds finest assassin gets reincarnated in another world": "The World's Finest Assassin Gets Reincarnated in Another World",
  "the worlds finest assassin gets reincarnated in another world as an aristocrat": "The World's Finest Assassin Gets Reincarnated in Another World",
  "worlds finest assassin": "The World's Finest Assassin Gets Reincarnated in Another World",
  "bloom into you": "Bloom Into You",
  "adachi and shimamura": "Adachi and Shimamura",
  "another": "Another",
  "another world survival": "Another World Survival",
  "gosick": "Gosick",
  "otherside picnic": "Otherside Picnic",
  "restaurant to another world": "Restaurant to Another World",
  "trinity blood": "Trinity Blood - Rage Against the Moons",
  "blood": "Blood+",
  "blood+": "Blood+",
  "jk haru is a sex worker in another world": "JK Haru is a Sex Worker in Another World",
  "a cave kings road to paradise": "A Cave King's Road to Paradise",
  "a cave kings road to paradise climbing to the top with my almighty mining skills": "A Cave King's Road to Paradise",
  "a late start tamers laid back life": "A Late-Start Tamer's Laid-Back Life",
  "a livid ladys guide to getting even": "A Livid Lady's Guide to Getting Even",
  "a livid ladys guide to getting even how i crushed my homeland with my mighty grimoires": "A Livid Lady's Guide to Getting Even",
  "a mysterious job called oda nobunaga": "A Mysterious Job Called Oda Nobunaga",
  "are you okay with a slightly older girlfriend": "Are You Okay With a Slightly Older Girlfriend",
  "free life fantasy online": "Free Life Fantasy Online - Immortal Princess",
  "from old country bumpkin to master swordsman": "From Old Country Bumpkin to Master Swordsman",
  "from old country bumpkin to master swordsman my hotshot disciples are all grown up now and they wont leave me alone": "From Old Country Bumpkin to Master Swordsman",
  "heroine saint no im an all works maid and proud of it": "Heroine Saint No, I'm an All-Works Maid",
  "the worlds strongest rearguard labyrinth countrys novice seeker": "The World's Strongest Rearguard",
  "victoria of many faces": "Victoria of Many Faces",
  "you like me not my daughter": "You Like Me, Not My Daughter",
  "almark": "Almark",
};

export const KNOWN_TITLE_TO_LNORI: Record<string, { id: number; slug: string }> = {
  "danmachi": { id: 2201, slug: "is-it-wrong-to-try-to-pick-up-girls-in-a-dungeon" },
  "is it wrong to try to pick up girls in a dungeon": { id: 2201, slug: "is-it-wrong-to-try-to-pick-up-girls-in-a-dungeon" },
  "rezero": { id: 3343, slug: "re-zero-starting-life-in-another-world" },
  "rezero starting life in another world": { id: 3343, slug: "re-zero-starting-life-in-another-world" },
  "re zero": { id: 3343, slug: "re-zero-starting-life-in-another-world" },
  "re zero starting life in another world": { id: 3343, slug: "re-zero-starting-life-in-another-world" },
  "86": { id: 4808, slug: "86-eighty-six" },
  "86 eighty six": { id: 4808, slug: "86-eighty-six" },
  "86eightysix": { id: 4808, slug: "86-eighty-six" },
  "the irregular at magic high school": { id: 1941, slug: "the-irregular-at-magic-high-school" },
  "mahouka koukou no rettousei": { id: 1941, slug: "the-irregular-at-magic-high-school" },
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
  "sword art online": { id: 1234, slug: "sword-art-online" },
  "no game no life": { id: 2419, slug: "no-game-no-life" },
  "spice and wolf": { id: 677, slug: "spice-and-wolf" },
  "spice wolf": { id: 677, slug: "spice-and-wolf" },
  "worldend": { id: 4031, slug: "worldend-what-do-you-do-at-the-end-of-the-world-are-you-busy-will-you-save-us" },
  "worldend what do you do at the end of the world are you busy will you save us": { id: 4031, slug: "worldend-what-do-you-do-at-the-end-of-the-world-are-you-busy-will-you-save-us" },
  "suka suka": { id: 4031, slug: "worldend-what-do-you-do-at-the-end-of-the-world-are-you-busy-will-you-save-us" },
  "goblin slayer": { id: 5304, slug: "goblin-slayer" },
  "toradora": { id: 2074, slug: "toradora" },
  "konosuba": { id: 2872, slug: "konosuba-gods-blessing-on-this-wonderful-world" },
  "konosuba gods blessing on this wonderful world": { id: 2872, slug: "konosuba-gods-blessing-on-this-wonderful-world" },
  "solo leveling": { id: 6219, slug: "solo-leveling" },
  "a sisters all you need": { id: 4380, slug: "a-sisters-all-you-need" },
  "the angel next door spoils me rotten": { id: 9601, slug: "the-angel-next-door-spoils-me-rotten" },
  "the apothecary diaries": { id: 3768, slug: "the-apothecary-diaries" },
  "apothecary diaries": { id: 3768, slug: "the-apothecary-diaries" },
  "kusuriya no hitorigoto": { id: 3768, slug: "the-apothecary-diaries" },
  "the eminence in shadow": { id: 6215, slug: "the-eminence-in-shadow" },
  "kage no jitsuryokusha ni naritakute": { id: 6215, slug: "the-eminence-in-shadow" },
  "ascendance of a bookworm": { id: 4239, slug: "ascendance-of-a-bookworm-ill-do-anything-to-become-a-librarian" },
  "classroom of the elite": { id: 4557, slug: "classroom-of-the-elite" },
  "mushoku tensei": { id: 3336, slug: "mushoku-tensei-jobless-reincarnation" },
  "mushoku tensei jobless reincarnation": { id: 3336, slug: "mushoku-tensei-jobless-reincarnation" },
  "overlord": { id: 2405, slug: "overlord" },
  "that time i got reincarnated as a slime": { id: 3580, slug: "that-time-i-got-reincarnated-as-a-slime" },
  "tensura": { id: 3580, slug: "that-time-i-got-reincarnated-as-a-slime" },
  "oregairu": { id: 1844, slug: "my-youth-romantic-comedy-is-wrong-as-i-expected" },
  "my youth romantic comedy is wrong": { id: 1844, slug: "my-youth-romantic-comedy-is-wrong-as-i-expected" },
  "my youth romantic comedy is wrong as i expected": { id: 1844, slug: "my-youth-romantic-comedy-is-wrong-as-i-expected" },
  "cote": { id: 4557, slug: "classroom-of-the-elite" },
  "sao": { id: 1234, slug: "sword-art-online" },
  "mahouka": { id: 1941, slug: "the-irregular-at-magic-high-school" },
  "monogatari": { id: 1014, slug: "monogatari" },
  "bakemonogatari": { id: 1014, slug: "monogatari" },
  "monogatari series": { id: 1014, slug: "monogatari" },
  "grimgar of fantasy and ash": { id: 2873, slug: "grimgar-of-fantasy-and-ash" },
};

export const KNOWN_TITLE_CANONICAL_MAP: Record<string, string> = {
  "spice and wolf": "spice and wolf",
  "spice wolf": "spice and wolf",
  "worldend": "worldend",
  "worldend what do you do at the end of the world are you busy will you save us": "worldend",
  "suka suka": "worldend",
  "shuumatsu nani shitemasu ka isogashii desu ka sukutte moratte ii desu ka": "worldend",
  "days with my stepsister": "days with my stepsister",
  "gimai seikatsu": "days with my stepsister",
  "goblin slayer": "goblin slayer",
  "rezero": "rezero",
  "rezero starting life in another world": "rezero",
  "re zero": "rezero",
  "re zero starting life in another world": "rezero",
  "danmachi": "danmachi",
  "is it wrong to try to pick up girls in a dungeon": "danmachi",
  "86": "86",
  "86 eighty six": "86",
  "86eightysix": "86",
  "classroom of the elite": "classroom of the elite",
  "cote": "classroom of the elite",
  "mushoku tensei": "mushoku tensei",
  "mushoku tensei jobless reincarnation": "mushoku tensei",
  "overlord": "overlord",
  "that time i got reincarnated as a slime": "that time i got reincarnated as a slime",
  "tensura": "that time i got reincarnated as a slime",
  "oregairu": "oregairu",
  "my youth romantic comedy is wrong": "oregairu",
  "my youth romantic comedy is wrong as i expected": "oregairu",
  "the irregular at magic high school": "mahouka",
  "mahouka koukou no rettousei": "mahouka",
  "mahouka": "mahouka",
  "the angel next door spoils me rotten": "the angel next door spoils me rotten",
  "the apothecary diaries": "the apothecary diaries",
  "the eminence in shadow": "the eminence in shadow",
  "kage no jitsuryokusha ni naritakute": "the eminence in shadow",
  "ascendance of a bookworm": "ascendance of a bookworm",
  "honzuki no gekokujou": "ascendance of a bookworm",
  "too many losing heroines": "too many losing heroines",
  "make heroine ga oosugiru": "too many losing heroines",
  "secrets of the silent witch": "secrets of the silent witch",
  "silent witch": "secrets of the silent witch",
  "playing death games to put food on the table": "playing death games to put food on the table",
  "shibou yuugi de meshi wo kuu": "playing death games to put food on the table",
  "sentenced to be a hero": "sentenced to be a hero",
  "yuusha kei ni shosu": "sentenced to be a hero",
  "the water magician": "the water magician",
  "haibaras teenage new game": "haibaras teenage new game",
  "haibara kun no tsuyokute seishun new game": "haibaras teenage new game",
  "the frontier lord begins with zero subjects": "the frontier lord begins with zero subjects",
  "min maxing my trpg build in another world": "min maxing my trpg build in another world",
  "im the evil lord of an intergalactic empire": "im the evil lord of an intergalactic empire",
  "a certain magical index": "a certain magical index",
  "toaru majutsu no index": "a certain magical index",
  "sword art online": "sword art online",
  "sao": "sword art online",
  "monogatari": "monogatari",
  "bakemonogatari": "monogatari",
  "monogatari series": "monogatari",
  "no game no life": "no game no life",
  "toradora": "toradora",
  "konosuba": "konosuba",
  "konosuba gods blessing on this wonderful world": "konosuba",
  "solo leveling": "solo leveling",
  "a sisters all you need": "a sisters all you need",
  "grimgar of fantasy and ash": "grimgar of fantasy and ash",
};

export const KNOWN_TITLE_TO_AUTHOR: Record<string, string> = {
  "ascendance of a bookworm": "Miya Kazuki",
  "classroom of the elite": "Shogo Kinugasa",
  "classroom of the elite year 2": "Shogo Kinugasa",
  "mushoku tensei": "Rifujin na Magonote",
  "mushoku tensei jobless reincarnation": "Rifujin na Magonote",
  "overlord": "Kugane Maruyama",
  "that time i got reincarnated as a slime": "Fuse",
  "the angel next door spoils me rotten": "Saekisan",
  "86": "Asato Asato",
  "86 eighty six": "Asato Asato",
  "the apothecary diaries": "Natsu Hyuuga",
  "the eminence in shadow": "Daisuke Aizawa",
  "a sisters all you need": "Yomi Hirasaka",
  "grimgar of fantasy and ash": "Ao Jyumonji",
  "danmachi": "Fujino Omori",
  "is it wrong to try to pick up girls in a dungeon": "Fujino Omori",
  "rezero": "Tappei Nagatsuki",
  "rezero starting life in another world": "Tappei Nagatsuki",
  "a certain magical index": "Kazuma Kamachi",
  "monogatari": "Nisio Isin",
  "bakemonogatari": "Nisio Isin",
  "spice and wolf": "Isuna Hasekura",
  "spice wolf": "Isuna Hasekura",
  "worldend": "Akira Kareno",
  "worldend what do you do at the end of the world are you busy will you save us": "Akira Kareno",
  "suka suka": "Akira Kareno",
  "goblin slayer": "Kumo Kagyu",
  "sword art online": "Reki Kawahara",
  "sword art online progressive": "Reki Kawahara",
  "no game no life": "Yuu Kamiya",
  "toradora": "Yuyuko Takemiya",
  "konosuba": "Natsume Akatsuki",
  "konosuba gods blessing on this wonderful world": "Natsume Akatsuki",
  "solo leveling": "Chugong",
  "playing death games to put food on the table": "Yuushi Ukai",
  "love unseen beneath the clear night sky": "Misaki Sano",
  "heroine saint no im an all works maid": "Kyouka",
  "sentenced to be a hero": "Rocket Shokai",
  "the water magician": "Tadashi Kubou",
  "haibaras teenage new game": "Kazuki Amamiya",
  "too many losing heroines": "Takibi Amamori",
  "secrets of the silent witch": "Matsuri Isora",
  "days with my stepsister": "Ghost Mikawa",
  "gimai seikatsu": "Ghost Mikawa",
  "the frontier lord begins with zero subjects": "Fuurou",
  "min maxing my trpg build in another world": "Schuld",
  "im the evil lord of an intergalactic empire": "Yomu Mishima",
  "the vexations of a shut in vampire princess": "Kotei Kobayashi",
  "a contract marriage with the maid": "Dalsaeowl",
  "a cave kings road to paradise": "Hajime Naehara",
  "amagi brilliant park": "Shoji Gatoh",
  "the empty box and zeroth maria": "Eiji Mikage",
  "chivalry of a failed knight": "Riku Misora",
  "the tunnel to summer the exit of goodbyes": "Mei Hachimoku",
  "kagerou daze": "Jin",
  "the irregular at magic high school": "Tsutomu Sato",
  "mahouka koukou no rettousei": "Tsutomu Sato",
  "mahouka": "Tsutomu Sato",
  "rascal does not dream": "Hajime Kamoshida",
  "rascal does not dream of bunny girl senpai": "Hajime Kamoshida",
  "oregairu": "Wataru Watari",
  "my youth romantic comedy is wrong": "Wataru Watari",
  "a tale of the secret saint": "Touya",
  "a tale of the secret saint zero": "Touya",
  "a surprisingly happy engagement for the slime duke and the fallen noble lady": "Maya Yoshioka",
  "my youth romantic comedy is wrong as i expected": "Wataru Watari",
  "tensura": "Fuse",
  "sao": "Reki Kawahara",
  "cote": "Shogo Kinugasa",
  "monogatari series": "Nisio Isin",
  "re zero": "Tappei Nagatsuki",
  "re zero starting life in another world": "Tappei Nagatsuki",
};

export const KNOWN_TITLE_TO_COVER: Record<string, string> = {
  "ascendance of a bookworm": "https://s4.anilist.co/file/anilistcdn/media/manga/cover/large/bx110800-buaDMQpwzfds.jpg",
  "classroom of the elite": "https://s4.anilist.co/file/anilistcdn/media/manga/cover/large/bx94970-q77X5sfRIKvU.jpg",
  "cote": "https://s4.anilist.co/file/anilistcdn/media/manga/cover/large/bx94970-q77X5sfRIKvU.jpg",
  "mushoku tensei": "https://s4.anilist.co/file/anilistcdn/media/manga/cover/large/nx85470-jt6BF9tDWB2X.jpg",
  "mushoku tensei jobless reincarnation": "https://s4.anilist.co/file/anilistcdn/media/manga/cover/large/nx85470-jt6BF9tDWB2X.jpg",
  "overlord": "https://s4.anilist.co/file/anilistcdn/media/manga/cover/large/bx85976-hVr99G1kD1M5.png",
  "that time i got reincarnated as a slime": "https://s4.anilist.co/file/anilistcdn/media/manga/cover/large/bx86355-pGwmLqVTwwE4.jpg",
  "tensura": "https://s4.anilist.co/file/anilistcdn/media/manga/cover/large/bx86355-pGwmLqVTwwE4.jpg",
  "the angel next door spoils me rotten": "https://s4.anilist.co/file/anilistcdn/media/manga/cover/large/bx113533-u3D4i0jHzt2z.jpg",
  "86": "https://s4.anilist.co/file/anilistcdn/media/manga/cover/large/bx98610-TIf7R1gkU0vc.jpg",
  "86 eighty six": "https://s4.anilist.co/file/anilistcdn/media/manga/cover/large/bx98610-TIf7R1gkU0vc.jpg",
  "the apothecary diaries": "https://s4.anilist.co/file/anilistcdn/media/manga/cover/large/nx99026-5Eg650WAd9Rj.jpg",
  "the eminence in shadow": "https://s4.anilist.co/file/anilistcdn/media/manga/cover/large/bx108428-wTg20rSpvkU9.jpg",
  "a sisters all you need": "https://s4.anilist.co/file/anilistcdn/media/manga/cover/large/nx97894-ZQmIZQsc5Wea.jpg",
  "a pale moon reverie": "https://s4.anilist.co/file/anilistcdn/media/manga/cover/large/bx183547-5JAYNtUzwUPw.jpg",
  "a-pale-moon-reverie": "https://s4.anilist.co/file/anilistcdn/media/manga/cover/large/bx183547-5JAYNtUzwUPw.jpg",
  "a surprisingly happy engagement for the slime duke": "https://s4.anilist.co/file/anilistcdn/media/manga/cover/large/bx177505-fJxf7Qfrnl3u.jpg",
  "a surprisingly happy engagement for the slime duke and the fallen noble lady": "https://s4.anilist.co/file/anilistcdn/media/manga/cover/large/bx177505-fJxf7Qfrnl3u.jpg",
  "a-surprisingly-happy-engagement-for-the-slime-duke-and-the-fallen-noble-lady": "https://s4.anilist.co/file/anilistcdn/media/manga/cover/large/bx177505-fJxf7Qfrnl3u.jpg",
  "slime duke": "https://s4.anilist.co/file/anilistcdn/media/manga/cover/large/bx177505-fJxf7Qfrnl3u.jpg",
  "a tale of the secret saint": "https://s4.anilist.co/file/anilistcdn/media/manga/cover/large/bx114203-fIdB2UHuf3Ut.jpg",
  "a-tale-of-the-secret-saint": "https://s4.anilist.co/file/anilistcdn/media/manga/cover/large/bx114203-fIdB2UHuf3Ut.jpg",
  "a wild last boss appeared": "https://s4.anilist.co/file/anilistcdn/media/manga/cover/large/bx99776-P4wYNhmbvyKo.jpg",
  "a-wild-last-boss-appeared": "https://s4.anilist.co/file/anilistcdn/media/manga/cover/large/bx99776-P4wYNhmbvyKo.jpg",
  "a young lady finds her true calling living with the enemy": "https://s4.anilist.co/file/anilistcdn/media/manga/cover/large/bx204803-Q127XMSQOrQ0.jpg",
  "a-young-lady-finds-her-true-calling-living-with-the-enemy": "https://s4.anilist.co/file/anilistcdn/media/manga/cover/large/bx204803-Q127XMSQOrQ0.jpg",
  "grimgar of fantasy and ash": "https://s4.anilist.co/file/anilistcdn/media/manga/cover/large/bx86365-1H3Lp87JUnxr.jpg",
  "danmachi": "https://s4.anilist.co/file/anilistcdn/media/manga/cover/large/bx85162-Fpd3ejAlFWP8.jpg",
  "is it wrong to try to pick up girls in a dungeon": "https://s4.anilist.co/file/anilistcdn/media/manga/cover/large/bx85162-Fpd3ejAlFWP8.jpg",
  "rezero": "https://s4.anilist.co/file/anilistcdn/media/manga/cover/large/bx85737-WkWOr5EgwPyo.jpg",
  "rezero starting life in another world": "https://s4.anilist.co/file/anilistcdn/media/manga/cover/large/bx85737-WkWOr5EgwPyo.jpg",
  "a certain magical index": "https://s4.anilist.co/file/anilistcdn/media/manga/cover/large/bx42854-IOa3uoHblsCB.png",
  "monogatari": "https://s4.anilist.co/file/anilistcdn/media/manga/cover/medium/bx44893-aV0XRP0OfWf7.jpg",
  "monogatari series": "https://s4.anilist.co/file/anilistcdn/media/manga/cover/medium/bx44893-aV0XRP0OfWf7.jpg",
  "bakemonogatari": "https://s4.anilist.co/file/anilistcdn/media/manga/cover/medium/bx44893-aV0XRP0OfWf7.jpg",
  "a cave kings road to paradise": "https://s4.anilist.co/file/anilistcdn/media/manga/cover/medium/bx119518-W0uUHej9hS3h.jpg",
  "spice and wolf": "https://s4.anilist.co/file/anilistcdn/media/manga/cover/medium/bx39115-2uLgBuM30i1b.jpg",
  "spice wolf": "https://s4.anilist.co/file/anilistcdn/media/manga/cover/medium/bx39115-2uLgBuM30i1b.jpg",
  "worldend": "https://s4.anilist.co/file/anilistcdn/media/manga/cover/medium/bx87284-Drq2dMfE67cf.jpg",
  "worldend what do you do at the end of the world are you busy will you save us": "https://s4.anilist.co/file/anilistcdn/media/manga/cover/medium/bx87284-Drq2dMfE67cf.jpg",
  "suka suka": "https://s4.anilist.co/file/anilistcdn/media/manga/cover/medium/bx87284-Drq2dMfE67cf.jpg",
  "goblin slayer": "https://s4.anilist.co/file/anilistcdn/media/manga/cover/medium/bx87320-Q7A3KfMPykcm.jpg",
  "playing death games to put food on the table": "https://s4.anilist.co/file/anilistcdn/media/manga/cover/large/bx154060-vFViZxxlVH9F.png",
  "love unseen beneath the clear night sky": "https://s4.anilist.co/file/anilistcdn/media/manga/cover/large/bx175916-UH4p840mvvLk.png",
  "heroine saint no im an all works maid": "https://s4.anilist.co/file/anilistcdn/media/manga/cover/medium/b128801-t8xoJTwtiBmb.jpg",
  "sentenced to be a hero": "https://s4.anilist.co/file/anilistcdn/media/manga/cover/large/bx142687-BFy2lofGgPKx.jpg",
  "the water magician": "https://s4.anilist.co/file/anilistcdn/media/manga/cover/large/bx142688-ShdIyM8TGqO8.jpg",
  "haibaras teenage new game": "https://s4.anilist.co/file/anilistcdn/media/manga/cover/large/bx143071-1FRtRk64oI5L.jpg",
  "too many losing heroines": "https://s4.anilist.co/file/anilistcdn/media/manga/cover/large/bx135276-BGRuVuGlHIQY.jpg",
  "secrets of the silent witch": "https://s4.anilist.co/file/anilistcdn/media/manga/cover/large/bx136833-gbVDB7CgEUYT.jpg",
  "days with my stepsister": "https://s4.anilist.co/file/anilistcdn/media/manga/cover/large/bx126268-c3BmsZ0LlJWr.png",
  "the frontier lord begins with zero subjects": "https://s4.anilist.co/file/anilistcdn/media/manga/cover/large/nx106767-3SvzEtMGx5dX.jpg",
  "min maxing my trpg build in another world": "https://s4.anilist.co/file/anilistcdn/media/manga/cover/large/bx136341-etgs2NuVx5qN.jpg",
  "im the evil lord of an intergalactic empire": "https://s4.anilist.co/file/anilistcdn/media/manga/cover/large/bx133484-bWRiNkdBrnuv.jpg",
  "the vexations of a shut in vampire princess": "https://s4.anilist.co/file/anilistcdn/media/manga/cover/large/bx119283-iuhI6oQSEuSS.jpg",
  "a contract marriage with the maid": "https://s4.anilist.co/file/anilistcdn/media/manga/cover/medium/bx124522-yceI38rJDLl9.jpg",
  "oregairu": "https://s4.anilist.co/file/anilistcdn/media/manga/cover/large/bx67015-ZqYjE19XkL8L.jpg",
  "my youth romantic comedy is wrong": "https://s4.anilist.co/file/anilistcdn/media/manga/cover/large/bx67015-ZqYjE19XkL8L.jpg",
  "my youth romantic comedy is wrong as i expected": "https://s4.anilist.co/file/anilistcdn/media/manga/cover/large/bx67015-ZqYjE19XkL8L.jpg",
  "mahouka": "https://s4.anilist.co/file/anilistcdn/media/manga/cover/large/bx41490-v85t5sFpX7F3.jpg",
  "mahouka koukou no rettousei": "https://s4.anilist.co/file/anilistcdn/media/manga/cover/large/bx41490-v85t5sFpX7F3.jpg",
  "the irregular at magic high school": "https://s4.anilist.co/file/anilistcdn/media/manga/cover/large/bx41490-v85t5sFpX7F3.jpg",
  "sao": "https://s4.anilist.co/file/anilistcdn/media/manga/cover/large/bx32143-oWmsvO0P8kS2.jpg",
  "sword art online": "https://s4.anilist.co/file/anilistcdn/media/manga/cover/large/bx32143-oWmsvO0P8kS2.jpg",
  "konosuba": "https://s4.anilist.co/file/anilistcdn/media/manga/cover/large/bx86238-XbE1r2x0tF11.jpg",
  "konosuba gods blessing on this wonderful world": "https://s4.anilist.co/file/anilistcdn/media/manga/cover/large/bx86238-XbE1r2x0tF11.jpg",
};

export function canonicalTitleKey(title: string): string {
  if (!title) return "";
  const norm = normalizeTitleForMatch(title);
  if (KNOWN_TITLE_CANONICAL_MAP[norm]) {
    return KNOWN_TITLE_CANONICAL_MAP[norm];
  }
  for (const [alias, canonical] of Object.entries(KNOWN_TITLE_CANONICAL_MAP)) {
    if (alias.length >= 6 && norm.length >= 6) {
      const minLen = Math.min(norm.length, alias.length);
      const maxLen = Math.max(norm.length, alias.length);
      if (minLen / maxLen >= 0.7 && (norm.startsWith(alias) || alias.startsWith(norm))) {
        return canonical;
      }
    }
  }
  return norm;
}

export function sanitizeTitleForFolderMatch(raw: string): string {
  if (!raw) return "";
  return raw
    .replace(/[:?*"<>|/\\]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

export function deduplicateDiscoverNovels(novels: DiscoveredNovel[]): DiscoveredNovel[] {
  const seenKeys = new Set<string>();
  const result: DiscoveredNovel[] = [];

  for (const novel of novels) {
    const normTitle = normalizeTitleForMatch(novel.title);
    const canTitle = canonicalTitleKey(novel.title);
    const normRomaji = novel.titleRomaji ? normalizeTitleForMatch(novel.titleRomaji) : "";
    const canRomaji = novel.titleRomaji ? canonicalTitleKey(novel.titleRomaji) : "";

    if (
      seenKeys.has(normTitle) ||
      seenKeys.has(canTitle) ||
      (normRomaji && seenKeys.has(normRomaji)) ||
      (canRomaji && seenKeys.has(canRomaji))
    ) {
      continue;
    }

    seenKeys.add(normTitle);
    seenKeys.add(canTitle);
    if (normRomaji) seenKeys.add(normRomaji);
    if (canRomaji) seenKeys.add(canRomaji);

    result.push(novel);
  }

  return result;
}

export function findRealElscioneFolder(
  title: string,
  romaji?: string,
  native?: string,
  customFolders?: string[],
): string | null {
  const folders = customFolders || REAL_ELSCIONE_FOLDERS;
  const rawCandidates = [title, romaji, native].filter(Boolean) as string[];

  // Expand candidates with sanitized versions (stripping colons, question marks, illegal characters, and subtitle appendages)
  const candidates: string[] = [];
  for (const c of rawCandidates) {
    if (!candidates.includes(c)) candidates.push(c);
    const sanitized = sanitizeTitleForFolderMatch(c);
    if (sanitized && !candidates.includes(sanitized)) {
      candidates.push(sanitized);
    }
    // Subtitle parts before colons, dashes, question marks
    const subParts = c.split(/[:\-–—?]+/);
    if (subParts.length > 1) {
      for (const p of subParts) {
        const trimmed = p.trim();
        if (trimmed.length >= 3 && !candidates.includes(trimmed)) {
          candidates.push(trimmed);
        }
      }
      const beforeSeparator = subParts[0].trim();
      if (beforeSeparator.length >= 3 && !candidates.includes(beforeSeparator)) {
        candidates.push(beforeSeparator);
      }
    }
    for (const v of cleanCalibreTitleVariants(c)) {
      if (!candidates.includes(v)) candidates.push(v);
      const vSanitized = sanitizeTitleForFolderMatch(v);
      if (vSanitized && !candidates.includes(vSanitized)) candidates.push(vSanitized);
    }
  }

  const validateFolder = (folderName: string | null | undefined): string | null => {
    if (!folderName) return null;
    if (/[:?*"<>|/\\]/.test(folderName)) return null;
    if (!folders.includes(folderName)) return null;
    return folderName;
  };

  // 1. Check known aliases map first
  for (const c of candidates) {
    const norm = normalizeTitleForMatch(c);
    if (!norm) continue;
    if (KNOWN_TITLE_TO_ELSCIONE[norm]) {
      const match = validateFolder(KNOWN_TITLE_TO_ELSCIONE[norm]);
      if (match) return match;
    }
  }

  // 2. Check exact normalized match
  for (const c of candidates) {
    const norm = normalizeTitleForMatch(c);
    if (!norm) continue;

    if (!customFolders && elscioneNormalizedMap.has(norm)) {
      const match = validateFolder(elscioneNormalizedMap.get(norm));
      if (match) return match;
    }

    if (customFolders) {
      for (const f of folders) {
        if (normalizeTitleForMatch(f) === norm) {
          const match = validateFolder(f);
          if (match) return match;
        }
      }
    }
  }

  // 3. Check bounded prefix / containment match (must be >= 8 chars and length ratio >= 0.70)
  const folderEntries = customFolders
    ? folders.map((f) => ({ folder: f, normFolder: normalizeTitleForMatch(f) }))
    : precomputedRealElscioneFolders;

  for (const c of candidates) {
    const norm = normalizeTitleForMatch(c);
    if (!norm || norm.length < 8) continue;

    for (const entry of folderEntries) {
      const normF = entry.normFolder;
      if (normF.length < 8) continue;

      const minLen = Math.min(norm.length, normF.length);
      const maxLen = Math.max(norm.length, normF.length);
      if (
        normF === norm ||
        (minLen / maxLen >= 0.7 && (normF.startsWith(norm) || norm.startsWith(normF)))
      ) {
        const match = validateFolder(entry.folder);
        if (match) return match;
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
  const rawCandidates = [title, romaji, native].filter(Boolean) as string[];
  const candidates: string[] = [];
  for (const c of rawCandidates) {
    if (!candidates.includes(c)) candidates.push(c);
    const sanitized = sanitizeTitleForFolderMatch(c);
    if (sanitized && !candidates.includes(sanitized)) candidates.push(sanitized);
    const subParts = c.split(/[:\-–—?]+/);
    if (subParts.length > 1) {
      for (const p of subParts) {
        const trimmed = p.trim();
        if (trimmed.length >= 3 && !candidates.includes(trimmed)) {
          candidates.push(trimmed);
        }
      }
      const beforeSeparator = subParts[0].trim();
      if (beforeSeparator.length >= 3 && !candidates.includes(beforeSeparator)) {
        candidates.push(beforeSeparator);
      }
    }
    for (const v of cleanCalibreTitleVariants(c)) {
      if (!candidates.includes(v)) candidates.push(v);
    }
  }

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

    if (customSeries) {
      for (const s of seriesList) {
        const normSlug = normalizeTitleForMatch(s.slug.replace(/-/g, " "));
        if (normSlug === norm) {
          return s;
        }
      }
    }
  }

  // 3. Check bounded prefix / containment match (must be >= 8 chars and length ratio >= 0.70)
  const seriesEntries = customSeries
    ? seriesList.map((s) => ({ id: s.id, slug: s.slug, normSlug: normalizeTitleForMatch(s.slug.replace(/-/g, " ")) }))
    : precomputedRealLnoriSeries;

  for (const c of candidates) {
    const norm = normalizeTitleForMatch(c);
    if (!norm || norm.length < 8) continue;

    for (const s of seriesEntries) {
      const normSlug = s.normSlug;
      if (normSlug.length < 8) continue;

      const minLen = Math.min(norm.length, normSlug.length);
      const maxLen = Math.max(norm.length, normSlug.length);
      if (
        normSlug === norm ||
        (minLen / maxLen >= 0.7 && (normSlug.startsWith(norm) || norm.startsWith(normSlug)))
      ) {
        return { id: s.id, slug: s.slug };
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

  const realFolders = options?.customElscioneFolders || REAL_ELSCIONE_FOLDERS;
  const validElscioneFolder =
    elscioneFolder &&
    realFolders.includes(elscioneFolder) &&
    !/[:?*"<>|/\\]/.test(elscioneFolder)
      ? elscioneFolder
      : null;

  if (!validElscioneFolder && !lnoriItem) {
    return null;
  }

  const sourceUrls: DiscoverSourceUrls = {};
  if (validElscioneFolder) {
    sourceUrls.elscione = `https://server.elscione.com/Officially%20Translated%20Light%20Novels/${encodeURIComponent(validElscioneFolder)}/`;
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

  // If verified missing volumes are known, prefer the source providing max coverage of missing volumes
  if (
    hasElscione &&
    hasLnori &&
    Array.isArray(novel.missingVolumeIndices) &&
    novel.missingVolumeIndices.length > 0 &&
    Array.isArray(novel.sources)
  ) {
    const elsciSrc = novel.sources.find((s) => s.source === "elscione" && s.status === "verified");
    const lnoriSrc = novel.sources.find((s) => s.source === "lnori" && s.status === "verified");

    const elsciCovered = elsciSrc?.volumes
      ? novel.missingVolumeIndices.filter((v) => elsciSrc.volumes!.includes(v)).length
      : 0;
    const lnoriCovered = lnoriSrc?.volumes
      ? novel.missingVolumeIndices.filter((v) => lnoriSrc.volumes!.includes(v)).length
      : 0;

    // Max-coverage source selection: choose source covering the highest number of missing volumes
    if (lnoriCovered > elsciCovered) {
      primarySource = "lnori";
      primaryUrl = novel.sourceUrls.lnori!;
    } else if (elsciCovered > 0) {
      primarySource = "elscione";
      primaryUrl = novel.sourceUrls.elscione!;
    } else if (lnoriCovered > 0) {
      primarySource = "lnori";
      primaryUrl = novel.sourceUrls.lnori!;
    } else {
      primarySource = "elscione";
      primaryUrl = novel.sourceUrls.elscione!;
    }
  } else if ((novel.source === "both" || (hasElscione && hasLnori)) && hasElscione) {
    // When available on both sources and no missing-volume skew, ALWAYS prefer Elscione over Lnori
    primarySource = "elscione";
    primaryUrl = novel.sourceUrls.elscione!;
  } else if (novel.source === "elscione" || hasElscione) {
    primarySource = "elscione";
    primaryUrl = novel.sourceUrls?.elscione || "";
  } else {
    primarySource = "lnori";
    primaryUrl = novel.sourceUrls?.lnori || "";
  }

  let source: DiscoverSource = "lnori";
  if (hasElscione && hasLnori) {
    source = "both";
  } else if (hasElscione) {
    source = "elscione";
  }

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
    coverUrl: "https://s4.anilist.co/file/anilistcdn/media/manga/cover/large/bx110800-buaDMQpwzfds.jpg",
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
    author: "Shogo Kinugasa",
    coverUrl: "https://s4.anilist.co/file/anilistcdn/media/manga/cover/large/bx94970-q77X5sfRIKvU.jpg",
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
    coverUrl: "https://s4.anilist.co/file/anilistcdn/media/manga/cover/large/nx85470-jt6BF9tDWB2X.jpg",
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
    coverUrl: "https://s4.anilist.co/file/anilistcdn/media/manga/cover/large/bx85976-hVr99G1kD1M5.png",
    synopsis: "When the popular MMORPG Yggdrasil shuts down, veteran player Momonga stays logged in until the final second, only to discover the Great Tomb of Nazarick transported to a real new world.",
    genres: ["Fantasy", "Action", "Supernatural"],
    score: 87,
    popularity: 89000,
    releaseDate: "2012-07-30",
    volumeCount: 18,
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
    coverUrl: "https://s4.anilist.co/file/anilistcdn/media/manga/cover/large/bx86355-pGwmLqVTwwE4.jpg",
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
    coverUrl: "https://s4.anilist.co/file/anilistcdn/media/manga/cover/large/bx113533-u3D4i0jHzt2z.jpg",
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
    coverUrl: "https://s4.anilist.co/file/anilistcdn/media/manga/cover/large/bx98610-TIf7R1gkU0vc.jpg",
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
    coverUrl: "https://s4.anilist.co/file/anilistcdn/media/manga/cover/large/nx99026-5Eg650WAd9Rj.jpg",
    synopsis: "Kidnapped and sold into service at the imperial palace, apothecary daughter Maomao uses her deep medical and toxicological acumen to deduce the mysteries of the inner court.",
    genres: ["Mystery", "Drama", "Historical"],
    score: 90,
    popularity: 91000,
    releaseDate: "2014-08-29",
    volumeCount: 15,
    source: "both",
    sourceUrls: {
      lnori: "https://lnori.com/series/3768/the-apothecary-diaries",
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
    coverUrl: "https://s4.anilist.co/file/anilistcdn/media/manga/cover/large/bx108428-wTg20rSpvkU9.jpg",
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
    coverUrl: "https://s4.anilist.co/file/anilistcdn/media/manga/cover/large/nx97894-ZQmIZQsc5Wea.jpg",
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
    author: "Ao Jyumonji",
    coverUrl: "https://s4.anilist.co/file/anilistcdn/media/manga/cover/large/bx86365-1H3Lp87JUnxr.jpg",
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
    author: "Fujino Omori",
    coverUrl: "https://s4.anilist.co/file/anilistcdn/media/manga/cover/large/bx85162-Fpd3ejAlFWP8.jpg",
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
    coverUrl: "https://s4.anilist.co/file/anilistcdn/media/manga/cover/large/bx85737-WkWOr5EgwPyo.jpg",
    synopsis: "Subaru Natsuki is suddenly summoned to another world with no powers except Return by Death—reversing time to a past save point whenever he perishes.",
    genres: ["Fantasy", "Psychological", "Drama", "Isekai"],
    score: 88,
    popularity: 94000,
    releaseDate: "2014-01-24",
    volumeCount: 38,
    source: "both",
    sourceUrls: {
      lnori: "https://lnori.com/series/3343/re-zero-starting-life-in-another-world",
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
    coverUrl: "https://s4.anilist.co/file/anilistcdn/media/manga/cover/large/bx42854-IOa3uoHblsCB.png",
    synopsis: "In Academy City, a scientifically advanced haven of espers, high schooler Touma Kamijou possesses Imagine Breaker in his right hand, negating all supernatural abilities.",
    genres: ["Sci-Fi", "Supernatural", "Action"],
    score: 83,
    popularity: 72000,
    releaseDate: "2004-04-10",
    volumeCount: 24,
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
    coverUrl: "https://s4.anilist.co/file/anilistcdn/media/manga/cover/medium/bx44893-aV0XRP0OfWf7.jpg",
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
    author: "Hajime Naehara",
    coverUrl: "https://s4.anilist.co/file/anilistcdn/media/manga/cover/medium/bx119518-W0uUHej9hS3h.jpg",
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
    author: "Yuushi Ukai",
    coverUrl: "https://s4.anilist.co/file/anilistcdn/media/manga/cover/large/bx154060-vFViZxxlVH9F.png",
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
    coverUrl: "https://s4.anilist.co/file/anilistcdn/media/manga/cover/large/bx175916-UH4p840mvvLk.png",
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
    author: "Kyouka",
    coverUrl: "https://s4.anilist.co/file/anilistcdn/media/manga/cover/medium/b128801-t8xoJTwtiBmb.jpg",
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
    coverUrl: "https://s4.anilist.co/file/anilistcdn/media/manga/cover/large/bx142687-BFy2lofGgPKx.jpg",
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
    author: "Tadashi Kubou",
    coverUrl: "https://s4.anilist.co/file/anilistcdn/media/manga/cover/large/bx142688-ShdIyM8TGqO8.jpg",
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
    coverUrl: "https://s4.anilist.co/file/anilistcdn/media/manga/cover/large/bx143071-1FRtRk64oI5L.jpg",
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
    coverUrl: "https://s4.anilist.co/file/anilistcdn/media/manga/cover/large/bx135276-BGRuVuGlHIQY.jpg",
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
    coverUrl: "https://s4.anilist.co/file/anilistcdn/media/manga/cover/large/bx136833-gbVDB7CgEUYT.jpg",
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
    coverUrl: "https://s4.anilist.co/file/anilistcdn/media/manga/cover/large/bx126268-c3BmsZ0LlJWr.png",
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
    coverUrl: "https://s4.anilist.co/file/anilistcdn/media/manga/cover/large/nx106767-3SvzEtMGx5dX.jpg",
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
    author: "Schuld",
    coverUrl: "https://s4.anilist.co/file/anilistcdn/media/manga/cover/large/bx136341-etgs2NuVx5qN.jpg",
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
    coverUrl: "https://s4.anilist.co/file/anilistcdn/media/manga/cover/large/bx133484-bWRiNkdBrnuv.jpg",
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
    coverUrl: "https://s4.anilist.co/file/anilistcdn/media/manga/cover/large/bx119283-iuhI6oQSEuSS.jpg",
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
    author: "Dalsaeowl",
    coverUrl: "https://s4.anilist.co/file/anilistcdn/media/manga/cover/medium/bx124522-yceI38rJDLl9.jpg",
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
      /[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}\u{1F900}-\u{1F9FF}\u{1F600}-\u{1F64F}\u{1F680}-\u{1F6FF}\u{2300}-\u{23FF}\u{2B50}]/gu,
      "",
    )
    .replace(/[\uFE00-\uFE0F\u200D]/g, "")
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
export function findKnownSeriesSynopsis(
  novel: { title: string; titleRomaji?: string; titleNative?: string; id?: string; author?: string },
): string | null {
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
  clearSourceInventoryCache();
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

// In-memory cache for verified source inventories
const _sourceInventoryMemoryCache = new Map<string, { data: VerifiedSourceInventory; timestamp: number }>();
const _inFlightSourceResolutions = new Map<string, Promise<VerifiedSourceInventory>>();
export const SOURCE_INVENTORY_TTL_MS = 24 * 60 * 60 * 1000; // 24-hour TTL for verified/unverified
export const SOURCE_INVENTORY_ERROR_TTL_MS = 60 * 1000; // 1-minute TTL for transient network errors

export function clearSourceInventoryCache(): void {
  _sourceInventoryMemoryCache.clear();
  _inFlightSourceResolutions.clear();
}

/**
 * Retrieves a cached source inventory from memory or SQLite cache.db.
 */
export function getCachedSourceInventory(
  url: string,
  dependencies?: DiscoverDependencies,
): VerifiedSourceInventory | null {
  const now = Date.now();
  const cleanUrl = url.trim();

  // 1. In-memory check
  const mem = _sourceInventoryMemoryCache.get(cleanUrl);
  if (mem) {
    const ttl = mem.data.status === "error" ? SOURCE_INVENTORY_ERROR_TTL_MS : SOURCE_INVENTORY_TTL_MS;
    if (now - mem.timestamp < ttl) {
      return JSON.parse(JSON.stringify(mem.data));
    }
  }

  // 2. SQLite cache.db check
  try {
    const db = dependencies?.cacheDb;
    if (db) {
      initDiscoverCacheTable(db);
      const row = db
        .query("SELECT data, updated_at FROM discover_cache WHERE feed_key = ? LIMIT 1")
        .get(`v1:src_inv:${cleanUrl}`) as { data: string; updated_at: number } | undefined;

      if (row) {
        let parsed: VerifiedSourceInventory | null = null;
        try {
          parsed = JSON.parse(row.data) as VerifiedSourceInventory;
        } catch {
          parsed = null;
        }
        if (parsed && typeof parsed === "object") {
          const ttl = parsed.status === "error" ? SOURCE_INVENTORY_ERROR_TTL_MS : SOURCE_INVENTORY_TTL_MS;
          if (now - row.updated_at < ttl) {
            _sourceInventoryMemoryCache.set(cleanUrl, { data: parsed, timestamp: row.updated_at });
            return parsed;
          }
        }
      }
    }
  } catch (err) {
    console.debug("[Discover] getCachedSourceInventory SQLite read failed:", err);
  }

  return null;
}

/**
 * Stores a source inventory into memory and SQLite cache.db.
 */
export function setCachedSourceInventory(
  url: string,
  inventory: VerifiedSourceInventory,
  dependencies?: DiscoverDependencies,
): void {
  const now = Date.now();
  const cleanUrl = url.trim();
  _sourceInventoryMemoryCache.set(cleanUrl, {
    data: JSON.parse(JSON.stringify(inventory)),
    timestamp: now,
  });

  try {
    const db = dependencies?.cacheDb;
    if (db) {
      initDiscoverCacheTable(db);
      db.query(
        `INSERT INTO discover_cache (feed_key, data, updated_at)
         VALUES (?, ?, ?)
         ON CONFLICT(feed_key) DO UPDATE SET
           data = excluded.data,
           updated_at = excluded.updated_at;`,
      ).run(`v1:src_inv:${cleanUrl}`, JSON.stringify(inventory), now);
    }
  } catch (err) {
    console.debug("[Discover] setCachedSourceInventory SQLite write failed:", err);
  }
}

async function resolveElscioneInventory(
  url: string,
  dependencies?: DiscoverDependencies,
): Promise<VerifiedSourceInventory> {
  const parsed = parseElscioneUrl(url);
  if (!parsed) {
    return {
      source: "elscione",
      url,
      status: "error",
      error: "Invalid Elsci.one URL",
      verifiedAt: Date.now(),
    };
  }

  const manifest = await extractElscioneManifest(url, dependencies);
  if (!manifest || !Array.isArray(manifest.volumes) || manifest.volumes.length === 0) {
    return {
      source: "elscione",
      url,
      status: "unverified",
      volumeCount: 0,
      volumes: [],
      verifiedAt: Date.now(),
    };
  }

  const validVolumes: number[] = [];

  for (const v of manifest.volumes) {
    if (!v.filename) {
      continue;
    }
    // Resolve canonical volume from original filename, preserving multipart Bookworm info
    // Never parse generated v.title or synthetic v.volumeNumber for unnumbered files
    const num = resolveCanonicalVolumeNumber(v.filename, manifest.seriesTitle);
    if (typeof num === "number" && !isNaN(num) && num >= 0) {
      validVolumes.push(num);
    }
  }

  const sorted = Array.from(new Set(validVolumes)).sort((a, b) => a - b);

  if (sorted.length === 0) {
    return {
      source: "elscione",
      url,
      status: "unverified",
      volumeCount: manifest.volumes.length,
      volumes: [],
      verifiedAt: Date.now(),
    };
  }

  return {
    source: "elscione",
    url,
    status: "verified",
    volumeCount: sorted.length,
    volumes: sorted,
    verifiedAt: Date.now(),
  };
}

async function resolveLnoriInventory(
  url: string,
  dependencies?: DiscoverDependencies,
): Promise<VerifiedSourceInventory> {
  const parsedUrl = parseLnoriUrl(url);
  if (!parsedUrl) {
    return {
      source: "lnori",
      url,
      status: "error",
      error: "Invalid Lnori URL",
      verifiedAt: Date.now(),
    };
  }

  const html = await fetchLnoriHtml(url, dependencies);
  const manifest = extractManifestFromHtml(html, url, parsedUrl);
  if (!manifest || !Array.isArray(manifest.volumePaths) || manifest.volumePaths.length === 0) {
    return {
      source: "lnori",
      url,
      status: "unverified",
      volumeCount: 0,
      volumes: [],
      verifiedAt: Date.now(),
    };
  }

  const validVolumes: number[] = [];

  for (const p of manifest.volumePaths) {
    if (!p || typeof p !== "string") {
      continue;
    }

    const decoded = safeDecodeURIComponent(p);
    let clean = decoded.split(/[?#]/)[0].trim();
    if (/^https?:\/\//i.test(clean)) {
      try {
        clean = new URL(clean).pathname;
      } catch {
        clean = clean.replace(/^https?:\/\/[^/]+/i, "");
      }
    }

    // Match /book/<id> or /book/<id>/<slug>
    const bookMatch = clean.match(/(?:^|\/)book\/\d+(?:\/(.*))?$/i);
    let slug = "";
    if (bookMatch) {
      // The numeric book ID segment (/book/<id>) must NEVER be parsed as a volume number!
      // If there is no slug after the book ID (e.g. /book/23021), do NOT treat the ID as volume number.
      if (!bookMatch[1] || !bookMatch[1].trim()) {
        continue;
      }
      slug = bookMatch[1].trim();
    } else {
      slug = clean.replace(/^\/+/, "").trim();
    }

    if (!slug) {
      continue;
    }

    // Only extract volume if there is an explicit volume pattern/indicator in the slug
    // (e.g. vol, volume, v, book, bk, part, pt, #)
    const hasExplicitPattern =
      /(?:^|[-_.\s])(?:vol(?:ume)?|book|bk|part|pt|v)\.?[-_.\s]*([0-9]+(?:\.[0-9]+)?|[ivx]+)(?:$|[-_.\s])/i.test(slug) ||
      /#\s*[0-9]+(?:\.[0-9]+)?/i.test(slug) ||
      /(?:^|[-_.\s])part[-_.\s]*\d+.*?(?:volume|vol|v)[-_.\s]*\d+/i.test(slug) ||
      /(?:အတွဲ|အပိုင်း|အခန်း)\s*([၀-၉]+|\d+(?:\.\d+)?)/.test(slug);

    if (!hasExplicitPattern) {
      continue;
    }

    // Resolve canonical volume from slug, preserving multipart Bookworm info
    const normalizedSlug = slug.replace(/[-_]+/g, " ");
    const num =
      resolveCanonicalVolumeNumber(normalizedSlug, manifest.seriesTitle) ??
      resolveCanonicalVolumeNumber(slug, manifest.seriesTitle);

    if (typeof num === "number" && !isNaN(num) && num >= 0) {
      validVolumes.push(num);
    }
  }

  const sorted = Array.from(new Set(validVolumes)).sort((a, b) => a - b);

  if (sorted.length === 0) {
    return {
      source: "lnori",
      url,
      status: "unverified",
      volumeCount: manifest.volumePaths.length,
      volumes: [],
      verifiedAt: Date.now(),
    };
  }

  return {
    source: "lnori",
    url,
    status: "verified",
    volumeCount: sorted.length,
    volumes: sorted,
    verifiedAt: Date.now(),
  };
}

/**
 * Resolves verified volume inventory for a single source URL with caching and in-flight deduplication.
 */
export async function resolveSourceInventory(
  url: string,
  source: "elscione" | "lnori",
  dependencies?: DiscoverDependencies,
): Promise<VerifiedSourceInventory> {
  if (!url || typeof url !== "string" || !url.trim()) {
    return {
      source,
      url: "",
      status: "error",
      error: "Missing or invalid URL",
      verifiedAt: Date.now(),
    };
  }

  const cleanUrl = url.trim();

  // Injectable resolver for unit tests and custom overrides
  if (dependencies?.resolveSourceVolumes) {
    try {
      const custom = await dependencies.resolveSourceVolumes(cleanUrl, source);
      if (custom) {
        setCachedSourceInventory(cleanUrl, custom, dependencies);
        return custom;
      }
    } catch (err: any) {
      return {
        source,
        url: cleanUrl,
        status: "error",
        error: stripEmojis(sanitizeErrorMessage(err?.message || err)),
        verifiedAt: Date.now(),
      };
    }
  }

  // Check cache
  const cached = getCachedSourceInventory(cleanUrl, dependencies);
  if (cached) {
    return cached;
  }

  const isTestEnv = process.env.NODE_ENV === "test" || Boolean(process.env.BUN_TEST);
  const shouldOnline = Boolean(dependencies?.enableOnline ?? !isTestEnv);

  if (!shouldOnline && !dependencies?.fetch && !dependencies?.resolveSourceVolumes) {
    return {
      source,
      url: cleanUrl,
      status: "unverified",
      error: "Online source verification disabled in test environment",
      verifiedAt: Date.now(),
    };
  }

  // Deduplicate concurrent in-flight requests for the same URL
  const inFlight = _inFlightSourceResolutions.get(cleanUrl);
  if (inFlight) {
    return await inFlight;
  }

  const promise = (async () => {
    try {
      let result: VerifiedSourceInventory;
      if (source === "elscione") {
        result = await resolveElscioneInventory(cleanUrl, dependencies);
      } else if (source === "lnori") {
        result = await resolveLnoriInventory(cleanUrl, dependencies);
      } else {
        result = {
          source,
          url: cleanUrl,
          status: "error",
          error: "Unsupported source type",
          verifiedAt: Date.now(),
        };
      }
      setCachedSourceInventory(cleanUrl, result, dependencies);
      return result;
    } catch (err: any) {
      const errorResult: VerifiedSourceInventory = {
        source,
        url: cleanUrl,
        status: "error",
        error: stripEmojis(sanitizeErrorMessage(err?.message || err)),
        verifiedAt: Date.now(),
      };
      setCachedSourceInventory(cleanUrl, errorResult, dependencies);
      return errorResult;
    } finally {
      _inFlightSourceResolutions.delete(cleanUrl);
    }
  })();

  _inFlightSourceResolutions.set(cleanUrl, promise);
  return await promise;
}

/**
 * Resolves verified inventories across all sources associated with a discovered novel.
 */
export async function resolveNovelSourceInventories(
  novel: DiscoveredNovel,
  dependencies?: DiscoverDependencies,
): Promise<{
  inventories: VerifiedSourceInventory[];
  verifiedVolumes: number[];
  verifiedVolumeCount?: number;
  sourceStatus: "verified" | "unverified" | "error";
}> {
  const sourcesToResolve: Array<{ source: "elscione" | "lnori"; url: string }> = [];

  if (novel.sourceUrls?.elscione) {
    sourcesToResolve.push({ source: "elscione", url: novel.sourceUrls.elscione });
  }
  if (novel.sourceUrls?.lnori) {
    sourcesToResolve.push({ source: "lnori", url: novel.sourceUrls.lnori });
  }
  if (Array.isArray(novel.sources)) {
    for (const s of novel.sources) {
      if (s?.url && (s.source === "elscione" || s.source === "lnori")) {
        if (!sourcesToResolve.some((item) => item.url === s.url)) {
          sourcesToResolve.push({ source: s.source, url: s.url });
        }
      }
    }
  }

  if (sourcesToResolve.length === 0) {
    return {
      inventories: [],
      verifiedVolumes: [],
      verifiedVolumeCount: undefined,
      sourceStatus: "unverified",
    };
  }

  const inventories = await Promise.all(
    sourcesToResolve.map((item) => resolveSourceInventory(item.url, item.source, dependencies)),
  );

  const verifiedList = inventories.filter((inv) => inv.status === "verified");
  const errorList = inventories.filter((inv) => inv.status === "error");

  let sourceStatus: "verified" | "unverified" | "error" = "unverified";
  if (verifiedList.length > 0) {
    sourceStatus = "verified";
  } else if (errorList.length === inventories.length) {
    sourceStatus = "error";
  } else {
    sourceStatus = "unverified";
  }

  // Union of verified volumes across all verified sources
  const volumeSet = new Set<number>();
  for (const inv of verifiedList) {
    if (Array.isArray(inv.volumes)) {
      for (const v of inv.volumes) {
        if (typeof v === "number" && !isNaN(v) && v > 0) {
          volumeSet.add(v);
        }
      }
    }
  }

  const verifiedVolumes = Array.from(volumeSet).sort((a, b) => a - b);
  const verifiedVolumeCount = sourceStatus === "verified" ? verifiedVolumes.length : undefined;

  return {
    inventories,
    verifiedVolumes,
    verifiedVolumeCount,
    sourceStatus,
  };
}

/**
 * Attaches cached inventories to a novel during catalog/feed cross-checks if already cached.
 */
export function attachCachedInventoriesIfAvailable(
  novel: DiscoveredNovel,
  dependencies?: DiscoverDependencies,
): DiscoveredNovel {
  if (
    novel.verifiedVolumes &&
    novel.sourceStatus === "verified" &&
    Array.isArray(novel.sources) &&
    novel.sources.length > 0
  ) {
    return novel;
  }

  const cachedSources: VerifiedSourceInventory[] = [];
  if (novel.sourceUrls?.elscione) {
    let cached = getCachedSourceInventory(novel.sourceUrls.elscione, dependencies);
    if (!cached && dependencies?.resolveSourceVolumes) {
      try {
        const custom = dependencies.resolveSourceVolumes(novel.sourceUrls.elscione, "elscione");
        if (custom && typeof (custom as any).then !== "function") {
          cached = custom as VerifiedSourceInventory;
        }
      } catch (_err) {
        void _err;
      }
    }
    if (cached) cachedSources.push(cached);
  }
  if (novel.sourceUrls?.lnori) {
    let cached = getCachedSourceInventory(novel.sourceUrls.lnori, dependencies);
    if (!cached && dependencies?.resolveSourceVolumes) {
      try {
        const custom = dependencies.resolveSourceVolumes(novel.sourceUrls.lnori, "lnori");
        if (custom && typeof (custom as any).then !== "function") {
          cached = custom as VerifiedSourceInventory;
        }
      } catch (_err) {
        void _err;
      }
    }
    if (cached) cachedSources.push(cached);
  }

  if (cachedSources.length > 0) {
    const verifiedList = cachedSources.filter((s) => s.status === "verified");
    if (verifiedList.length > 0) {
      const volumeSet = new Set<number>();
      for (const s of verifiedList) {
        if (Array.isArray(s.volumes)) {
          for (const v of s.volumes) {
            if (typeof v === "number" && !isNaN(v) && v > 0) volumeSet.add(v);
          }
        }
      }
      const verifiedVolumes = Array.from(volumeSet).sort((a, b) => a - b);
      return {
        ...novel,
        catalogVolumeCount: novel.catalogVolumeCount ?? novel.volumeCount,
        sources: cachedSources,
        sourceInventories: Object.fromEntries(cachedSources.map((s) => [s.source, s])),
        sourceStatus: "verified",
        verifiedVolumes,
        verifiedVolumeCount: verifiedVolumes.length,
        volumeCount: verifiedVolumes.length,
      };
    }
  }

  return novel;
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

export const STOP_WORDS = new Set([
  "a", "an", "the",
  "in", "on", "at", "to", "for", "of", "with", "by", "from", "into", "through",
  "and", "or", "but", "nor", "so", "yet",
  "is", "are", "was", "were", "be", "been", "being",
  "it", "its", "as", "if", "that", "this", "my", "your", "his", "her", "their",
  // Japanese particles in romaji
  "no", "ni", "wa", "ga", "de", "wo", "o", "ka", "mo", "e",
]);

export const KNOWN_LIGHT_NOVEL_ALIAS_CLUSTERS: string[][] = [
  // DanMachi (Mainline)
  [
    "danmachi",
    "is it wrong to try to pick up girls in a dungeon",
    "dungeon ni deai wo motomeru no wa machigatteiru darou ka",
  ],
  // DanMachi - Sword Oratoria
  [
    "danmachi sword oratoria",
    "sword oratoria",
    "is it wrong to try to pick up girls in a dungeon on the side sword oratoria",
    "dungeon ni deai wo motomeru no wa machigatteiru darou ka gaiden sword oratoria",
  ],
  // DanMachi - Familia Chronicle
  [
    "danmachi familia chronicle",
    "familia chronicle",
  ],
  // DanMachi - Minor Myths and Legends
  [
    "danmachi minor myths and legends",
    "minor myths and legends",
  ],
  // Re:Zero
  [
    "rezero",
    "re zero",
    "re zero starting life in another world",
    "re zero kara hajimeru isekai seikatsu",
  ],
  // Oregairu
  [
    "oregairu",
    "my youth romantic comedy is wrong",
    "my youth romantic comedy is wrong as i expected",
    "my teen romantic comedy is in reverse as i expected",
    "my teen romantic comedy is wrong as i expected",
    "yahari ore no seishun love come wa machigatteiru",
  ],
  // KonoSuba
  [
    "konosuba",
    "gods blessing on this wonderful world",
    "kono subarashii sekai ni shukufuku wo",
    "konosuba gods blessing on this wonderful world",
  ],
  // Tensura / Slime
  [
    "slime",
    "tensura",
    "that time i got reincarnated as a slime",
    "tensei shitara slime datta ken",
  ],
  // Mahouka
  [
    "mahouka",
    "the irregular at magic high school",
    "mahouka koukou no rettousei",
  ],
  // SAO
  [
    "sao",
    "sword art online",
  ],
  // COTE
  [
    "cote",
    "classroom of the elite",
    "youkoso jitsuryoku shijou shugi no kyoushitsu e",
  ],
  // Roshidere
  [
    "roshidere",
    "alya sometimes hides her feelings in russian",
    "tokidoki bosotto roshia go de dereru tonari no alya san",
  ],
  // Monogatari
  [
    "monogatari",
    "bakemonogatari",
    "monogatari series",
    "monster tale",
  ],
  // Black Bullet
  [
    "black bullet",
    "burakku buretto",
  ],
  // The Rising of the Shield Hero
  [
    "the rising of the shield hero",
    "shield hero",
    "tate no yuusha no nariagari",
    "tate no yuusha",
  ],
  // Rascal Does Not Dream / Bunny Girl Senpai
  [
    "rascal does not dream",
    "rascal does not dream series",
    "rascal does not dream of bunny girl senpai",
    "bunny girl senpai",
    "seishun buta yarou",
  ],
  // Trapped in a Dating Sim / Mobuseka (Mainline)
  [
    "trapped in a dating sim",
    "trapped in a dating sim the world of otome games is tough for mobs",
    "mobuseka",
    "otome game sekai wa mob ni kibishii sekai desu",
  ],
  // Trapped in a Dating Sim - Otome Games Are Tough For Us, Too! (Spinoff)
  [
    "trapped in a dating sim otome games are tough for us too",
    "otome games are tough for us too",
    "ano sekai wa mob ni kibishii sekai desu marie route",
  ],
  // How a Realist Hero Rebuilt the Kingdom
  [
    "how a realist hero rebuilt the kingdom",
    "realist hero",
    "genjitsu shugi yuusha no oukoku saikenki",
  ],
  // Reincarnated as a Sword / Tenken
  [
    "reincarnated as a sword",
    "tenken",
    "tensei shitara ken deshita",
  ],
  // The Asterisk War
  [
    "the asterisk war",
    "asterisk war",
    "gakusen toshi asterisk",
  ],
  // Combatants Will Be Dispatched
  [
    "combatants will be dispatched",
    "sentoin hakenshimasu",
  ],
  // 7th Time Loop
  [
    "7th time loop",
    "7th time loop the villainess enjoys a carefree life",
    "loop 7 kaime no akuyaku reijou wa",
  ],
  // Sound! Euphonium / Hibike! Euphonium
  [
    "sound euphonium",
    "hibike euphonium",
  ],
  // Kino no Tabi / Kino's Journey
  [
    "kinos journey",
    "kino no tabi",
  ],
  // The Beginning After The End
  [
    "the beginning after the end",
    "tbate",
  ],
  // Secrets of the Silent Witch
  [
    "secrets of the silent witch",
    "silent witch",
  ],
  // Sentenced to Be a Hero
  [
    "sentenced to be a hero",
    "yuusha kei ni shosu",
  ],
];

const aliasLookupMap = new Map<string, string[]>();
for (const cluster of KNOWN_LIGHT_NOVEL_ALIAS_CLUSTERS) {
  const normCluster = cluster.map((s) => normalizeTitleForMatch(s)).filter(Boolean);
  for (const item of normCluster) {
    const existing = aliasLookupMap.get(item) || [];
    const others = normCluster.filter((x) => x !== item);
    aliasLookupMap.set(item, Array.from(new Set([...existing, ...others])));
  }
}

export const DISTINCT_SPINOFF_MARKERS: RegExp[] = [
  /\bprogressive\b/i,
  /\balternative\b/i,
  /\bgun gale online\b/i,
  /\bsword oratoria\b/i,
  /\bmagian company\b/i,
  /\bex\b/i,
  /\bclovers? regret\b/i,
  /\bgaiden\b/i,
  /\bside stor(?:y|ies)\b/i,
  /\bshort stor(?:y|ies)\b/i,
  /\bafter stor(?:y|ies)\b/i,
  /\ban explosion on this wonderful world\b/i,
  /\bparchment and wolf\b/i,
  /\bnt\b/i,
  /\bgt\b/i,
  /\bss\b/i,
  /\bfamilia chronicle\b/i,
  /\bminor myths and legends\b/i,
  /\b(?:otome games are tough (?:for )?us|tough (?:for )?us too|for us\s*too|us too|marie route)\b/i,
];

function extractYearMarker(str: string): string | null {
  const match = str.toLowerCase().match(/\byear\s*([1-9])\b/);
  return match ? match[1] : null;
}

export function isSpinoffMismatch(candA: string, candB: string): boolean {
  const normA = normalizeTitleForMatch(candA);
  const normB = normalizeTitleForMatch(candB);

  if (!normA || !normB || normA === normB) return false;

  // If explicitly declared same-cluster aliases, not a mismatch
  if (aliasLookupMap.get(normA)?.includes(normB)) return false;

  // Year marker check (e.g. Year 2 vs Year 3 vs mainline without year)
  const yearA = extractYearMarker(normA);
  const yearB = extractYearMarker(normB);
  if (yearA !== yearB) {
    if (yearA !== null || yearB !== null) return true;
  }

  for (const regex of DISTINCT_SPINOFF_MARKERS) {
    // If both titles share sword oratoria, gaiden is an equivalent subtitle, not a conflict
    if (regex.source.includes("gaiden") && normA.includes("sword oratoria") && normB.includes("sword oratoria")) {
      continue;
    }
    const hasA = regex.test(normA);
    const hasB = regex.test(normB);
    if (hasA !== hasB) return true;
  }

  return false;
}

export function getSignificantTokens(str: string): string[] {
  return normalizeTitleForMatch(str)
    .split(/\s+/)
    .filter((w) => w.length > 0 && !STOP_WORDS.has(w));
}

export function calculateSignificantTokenOverlap(tokensA: string[], tokensB: string[]): number {
  if (tokensA.length === 0 || tokensB.length === 0) return 0;
  const setA = new Set(tokensA);
  const setB = new Set(tokensB);
  let common = 0;
  for (const t of setA) {
    if (setB.has(t)) common++;
  }
  const maxLen = Math.max(setA.size, setB.size);
  return common / maxLen;
}

/**
 * Strips volume suffixes and brackets from Calibre book and series titles.
 * Returns array of cleaned variants.
 */
export function cleanCalibreTitleVariants(raw: string): string[] {
  if (!raw) return [];
  const results = new Set<string>();
  const trimmed = raw.trim();
  results.add(trimmed);

  // Strip brackets with volume info: (Vol. 1), [Volume 02], etc.
  const s = trimmed.replace(
    /[\[\(（【]\s*(?:year\s*\d+\s*)?(?:vol(?:ume)?|v|book|bk|part|pt|#|第)?\.?\s*0*\d+(?:\.\d+)?\s*(?:巻)?\s*[\]\)）】]/gi,
    " ",
  );
  if (s.trim().length >= 2 && !isSpinoffMismatch(raw, s.trim())) {
    results.add(s.trim());
  }

  const volumeSuffixPatterns = [
    /[,:\-–—\s]+(?:year\s*\d+\s*)?(?:vol(?:ume)?|v|book|bk|part|pt|#)\.?\s*0*\d+.*$/i,
    /[,:\-–—\s]+year\s*\d+\b.*$/i,
    /[,:\-–—\s]+part\s*\d+\b.*$/i,
    /\b(?:vol(?:ume)?|v|book|bk|part|pt)\.?\s*0*\d+\b.*$/i,
    /[,:\-–—\s]+#\s*0*\d+.*$/i,
    /[,:\-–—\s]+第?\s*0*\d+\s*巻.*$/i,
    /[,:\-–—\s]+(?:အတွဲ|အခန်း)\s*0*[\d၀-၉]+.*$/i,
    /(?<=[a-zA-Z\u00A0-\uFFFF]\s+)0*\d{1,3}(?:\s*[-–—:].*)?$/i,
  ];

  for (const pat of volumeSuffixPatterns) {
    const stripped = s.replace(pat, "").trim();
    if (stripped.length >= 2) {
      if (isSpinoffMismatch(raw, stripped)) continue;
      results.add(stripped);
    }
  }

  return Array.from(results);
}

/**
 * Expands candidate matching strings and token lists for a discovered novel.
 */
export function getNovelMatchCandidates(novel: DiscoveredNovel): {
  candidates: Set<string>;
  tokensList: string[][];
} {
  const candidates = new Set<string>();

  function addRaw(raw?: string) {
    if (!raw) return;
    const norm = normalizeTitleForMatch(raw);
    if (norm) candidates.add(norm);

    // Subtitle and prefix components when splitting by : or - or — or – or | or /
    const parts = raw.split(/[:\-–—|/]+/);
    if (parts.length > 1) {
      for (const p of parts) {
        const pNorm = normalizeTitleForMatch(p);
        if (pNorm && pNorm.length >= 2) {
          if (isSpinoffMismatch(raw, p)) continue;
          candidates.add(pNorm);
        }
      }
    }
  }

  addRaw(novel.title);
  addRaw(novel.titleRomaji);
  addRaw(novel.titleNative);

  // Expand known aliases
  const current = Array.from(candidates);
  for (const c of current) {
    const aliases = aliasLookupMap.get(c);
    if (aliases) {
      for (const a of aliases) {
        if (isSpinoffMismatch(c, a)) continue;
        candidates.add(a);
      }
    }
  }

  const tokensList: string[][] = [];
  for (const c of candidates) {
    const tokens = getSignificantTokens(c);
    if (tokens.length >= 2) {
      tokensList.push(tokens);
    }
  }

  return { candidates, tokensList };
}

/**
 * Expands candidate matching strings and token lists for a Calibre book record.
 */
export function getCalibreBookMatchCandidates(book: { title?: string; series?: string }): {
  candidates: Set<string>;
  tokensList: string[][];
} {
  const candidates = new Set<string>();

  function addString(raw?: string) {
    if (!raw) return;
    const variants = cleanCalibreTitleVariants(raw);
    for (const v of variants) {
      const norm = normalizeTitleForMatch(v);
      if (norm) candidates.add(norm);

      const parts = v.split(/[:\-–—|/]+/);
      if (parts.length > 1) {
        for (const p of parts) {
          const pNorm = normalizeTitleForMatch(p);
          if (pNorm && pNorm.length >= 2) {
            if (isSpinoffMismatch(v, p)) continue;
            candidates.add(pNorm);
          }
        }
      }
    }
  }

  addString(book.series);
  addString(book.title);

  // Expand known aliases for Calibre book variants as well
  const current = Array.from(candidates);
  for (const c of current) {
    const aliases = aliasLookupMap.get(c);
    if (aliases) {
      for (const a of aliases) {
        if (isSpinoffMismatch(c, a)) continue;
        candidates.add(a);
      }
    }
  }

  const tokensList: string[][] = [];
  for (const c of candidates) {
    const tokens = getSignificantTokens(c);
    if (tokens.length >= 2) {
      tokensList.push(tokens);
    }
  }

  return { candidates, tokensList };
}

/**
 * Resolves the real volume count for a catalog light novel series.
 * Checks seed metadata, the pre-indexed CATALOG_VOLUMES mapping,
 * title variants, and known alias clusters before falling back to 1.
 */
export function resolveCatalogVolumeCount(
  title: string,
  romaji?: string,
  seed?: DiscoveredNovel,
): number {
  let mappedCount: number | null = null;

  const rawCandidates = [title, romaji].filter(Boolean) as string[];
  const candidates: string[] = [];
  for (const c of rawCandidates) {
    if (!candidates.includes(c)) candidates.push(c);
    for (const v of cleanCalibreTitleVariants(c)) {
      if (!candidates.includes(v)) candidates.push(v);
    }
  }

  // Check KNOWN_TITLE_TO_ELSCIONE mapping so shorthand aliases (e.g. black bullet, cote, danmachi, sao, slime, shield hero)
  // cleanly map to their parent Elscione folder and resolve volume counts, guarded against spin-off mismatch.
  const elscioneTargets: string[] = [];
  for (const c of candidates) {
    const norm = normalizeTitleForMatch(c);
    const slug = c.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
    const can = canonicalTitleKey(c);
    const target =
      (norm && KNOWN_TITLE_TO_ELSCIONE[norm]) ||
      (slug && KNOWN_TITLE_TO_ELSCIONE[slug]) ||
      (can && KNOWN_TITLE_TO_ELSCIONE[can]);
    if (target && !isSpinoffMismatch(c, target) && !elscioneTargets.includes(target)) {
      elscioneTargets.push(target);
    }
  }
  for (const target of elscioneTargets) {
    if (!candidates.includes(target)) candidates.push(target);
    for (const v of cleanCalibreTitleVariants(target)) {
      if (!candidates.includes(v)) candidates.push(v);
    }
  }

  // 1. Direct exact normalized match
  for (const c of candidates) {
    const norm = normalizeTitleForMatch(c);
    if (norm && CATALOG_VOLUMES[norm] && !isSpinoffMismatch(c, norm)) {
      mappedCount = CATALOG_VOLUMES[norm];
      break;
    }
  }

  // 2. Direct exact slug match
  if (!mappedCount) {
    for (const c of candidates) {
      const slug = c.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
      if (slug && CATALOG_VOLUMES[slug] && !isSpinoffMismatch(c, slug)) {
        mappedCount = CATALOG_VOLUMES[slug];
        break;
      }
    }
  }

  // 3. Exact canonical match (guarding against spin-off mismatch)
  if (!mappedCount) {
    for (const c of candidates) {
      const can = canonicalTitleKey(c);
      if (can && CATALOG_VOLUMES[can] && !isSpinoffMismatch(c, can)) {
        mappedCount = CATALOG_VOLUMES[can];
        break;
      }
    }
  }

  // 4. Exact alias cluster match (EXACT match on candidate === normItem, NEVER loose includes!)
  if (!mappedCount) {
    const normCandidates = candidates.map(normalizeTitleForMatch);
    for (const cluster of KNOWN_LIGHT_NOVEL_ALIAS_CLUSTERS) {
      const normCluster = cluster.map(normalizeTitleForMatch);
      const exactMatch = normCandidates.find((cand) =>
        normCluster.includes(cand),
      );
      if (exactMatch) {
        for (const item of normCluster) {
          if (CATALOG_VOLUMES[item] && !isSpinoffMismatch(exactMatch, item)) {
            mappedCount = CATALOG_VOLUMES[item];
            break;
          }
        }
      }
      if (mappedCount) break;
    }
  }

  // 5. Direct lookup of mapped Elscione target folder in CATALOG_VOLUMES
  if (!mappedCount) {
    for (const target of elscioneTargets) {
      const normT = normalizeTitleForMatch(target);
      const slugT = target.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
      const canT = canonicalTitleKey(target);
      if (normT && CATALOG_VOLUMES[normT] && !isSpinoffMismatch(title, target)) {
        mappedCount = CATALOG_VOLUMES[normT];
        break;
      }
      if (slugT && CATALOG_VOLUMES[slugT] && !isSpinoffMismatch(title, target)) {
        mappedCount = CATALOG_VOLUMES[slugT];
        break;
      }
      if (canT && CATALOG_VOLUMES[canT] && !isSpinoffMismatch(title, target)) {
        mappedCount = CATALOG_VOLUMES[canT];
        break;
      }
    }
  }

  // Authoritative verified catalog volume count ALWAYS takes precedence when present
  if (mappedCount !== null && mappedCount !== undefined) {
    return mappedCount;
  }

  // Fallback to seed ONLY if seed is a compatible series (not a parent seed for a spin-off)
  if (seed?.volumeCount && seed.volumeCount > 1) {
    if (!isSpinoffMismatch(title, seed.title)) {
      return seed.volumeCount;
    }
  }

  return 1;
}

export interface ProcessedCalibreBook {
  book: any;
  candidates: Set<string>;
  tokensList: string[][];
}

export interface CalibreInvertedIndex {
  processedCalibreBooks: ProcessedCalibreBook[];
  exactCandidateMap: Map<string, ProcessedCalibreBook[]>;
  prefixMap: Map<string, ProcessedCalibreBook[]>;
  tokenMap: Map<string, ProcessedCalibreBook[]>;
  stopWordOnlyBooks: ProcessedCalibreBook[];
  signature: string;
}

let _cachedCalibreInvertedIndex: CalibreInvertedIndex | null = null;

/**
 * Computes a content-based signature over Calibre books for index invalidation.
 * Serializes [id, title, series, series_index] via JSON to avoid delimiter collisions.
 */
export function computeCalibreBooksSignature(books: any[]): string {
  if (!books || books.length === 0) return "empty:0";
  const hash = crypto.createHash("sha256");
  hash.update(String(books.length));
  for (const b of books) {
    hash.update(JSON.stringify([
      b.id ?? null,
      b.title ?? null,
      b.series ?? null,
      b.series_index ?? null,
    ]));
  }
  return hash.digest("hex");
}

/**
 * Builds multi-tier inverted indices over Calibre books:
 * 1. exactCandidateMap: instant O(1) lookup for direct candidate equality
 * 2. prefixMap: prefix buckets (length >= 6) for prefix matching
 * 3. tokenMap: significant token buckets for token overlap & containment
 * 4. stopWordOnlyBooks: books whose candidates contain zero significant tokens
 */
export function buildCalibreInvertedIndex(calibreBooks: any[], signature?: string): CalibreInvertedIndex {
  const sig = signature ?? computeCalibreBooksSignature(calibreBooks);
  const processedCalibreBooks: ProcessedCalibreBook[] = calibreBooks.map((b) => ({
    book: b,
    ...getCalibreBookMatchCandidates(b),
  }));

  const exactCandidateMap = new Map<string, ProcessedCalibreBook[]>();
  const prefixMap = new Map<string, ProcessedCalibreBook[]>();
  const tokenMap = new Map<string, ProcessedCalibreBook[]>();
  const stopWordOnlyBooks: ProcessedCalibreBook[] = [];

  for (const b of processedCalibreBooks) {
    let hasContainmentStopWordCandidate = false;
    for (const c of b.candidates) {
      // 1. Direct candidate equality map
      let exactList = exactCandidateMap.get(c);
      if (!exactList) {
        exactList = [];
        exactCandidateMap.set(c, exactList);
      }
      exactList.push(b);

      // 2. Prefix map (c.length >= 6)
      if (c.length >= 6) {
        const p = c.slice(0, 6);
        let pList = prefixMap.get(p);
        if (!pList) {
          pList = [];
          prefixMap.set(p, pList);
        }
        pList.push(b);
      }

      // 3. Significant tokens map
      const tokens = getSignificantTokens(c);
      if (tokens.length > 0) {
        for (const t of tokens) {
          let tList = tokenMap.get(t);
          if (!tList) {
            tList = [];
            tokenMap.set(t, tList);
          }
          tList.push(b);
        }
      } else if (c.length >= 8 && c.split(" ").length >= 2) {
        hasContainmentStopWordCandidate = true;
      }
    }

    if (hasContainmentStopWordCandidate) {
      stopWordOnlyBooks.push(b);
    }
  }

  return {
    processedCalibreBooks,
    exactCandidateMap,
    prefixMap,
    tokenMap,
    stopWordOnlyBooks,
    signature: sig,
  };
}

/**
 * Gets or builds the cached Calibre inverted index, invalidating when library signature changes.
 */
export function getOrCreateCalibreInvertedIndex(calibreBooks: any[]): CalibreInvertedIndex {
  const currentSig = computeCalibreBooksSignature(calibreBooks);
  if (_cachedCalibreInvertedIndex && _cachedCalibreInvertedIndex.signature === currentSig) {
    return _cachedCalibreInvertedIndex;
  }
  const index = buildCalibreInvertedIndex(calibreBooks, currentSig);
  _cachedCalibreInvertedIndex = index;
  return index;
}

export const BOOKWORM_PART_OFFSETS = [0, 3, 7, 12, 21];
export const BOOKWORM_PART_VOLUMES = [3, 4, 5, 9, 12];

/**
 * Resolves canonical volume numbers for discovered series, supporting
 * multi-part light novel calculations (such as Ascendance of a Bookworm Part X Volume Y -> global volume index).
 * For non-Bookworm titles, returns the extracted volume number.
 */
export function resolveCanonicalVolumeNumber(
  title: string,
  seriesName?: string,
): number | null {
  if (!title) return null;

  // Normalize hyphens and underscores to spaces to support URL slugs and filenames
  const normalizedTitle = title.replace(/[-_]+/g, " ");

  // 1. Check for multi-part series pattern (Part X ... Volume Y)
  const multiPart = parseMultiPartVolume(title) || parseMultiPartVolume(normalizedTitle);
  if (multiPart) {
    const { part, volume } = multiPart;
    const combined = `${title} ${normalizedTitle} ${seriesName || ""}`.toLowerCase();
    const isBookworm = /ascendance[\s_\-]*of[\s_\-]*a[\s_\-]*bookworm|honzuki/i.test(combined);

    if (isBookworm && part >= 1 && part <= BOOKWORM_PART_OFFSETS.length) {
      return BOOKWORM_PART_OFFSETS[part - 1] + volume;
    }

    return volume;
  }

  // 2. Standard volume extraction (supporting titles, slugs, and filenames)
  return (
    extractVolumeNumber(title) ??
    extractVolumeNumber(normalizedTitle) ??
    extractVolumeNumberFromFilenameElscione(title) ??
    extractVolumeNumberFromFilenameElscione(normalizedTitle) ??
    null
  );
}

/**
 * Invalidates the cached Calibre inverted index immediately.
 */
export function invalidateCalibreInvertedIndex(): void {
  _cachedCalibreInvertedIndex = null;
}

/**
 * Matches a single discovered novel against the prebuilt Calibre inverted index.
 */
export function matchNovelWithCalibreIndex(
  novel: DiscoveredNovel,
  index: CalibreInvertedIndex,
): DiscoveredNovel {
  const { candidates: nCandidates, tokensList: nTokensList } = getNovelMatchCandidates(novel);

  // Collect plausible matching candidate books via inverted indices
  const candidateSet = new Set<ProcessedCalibreBook>();
  let checkAllBooks = false;

  for (const b of index.stopWordOnlyBooks) {
    candidateSet.add(b);
  }

  for (const n of nCandidates) {
    // 1. Direct candidate equality candidates
    const exactList = index.exactCandidateMap.get(n);
    if (exactList) {
      for (const b of exactList) candidateSet.add(b);
    }

    // 2. Prefix candidates (length >= 6)
    if (n.length >= 6) {
      const p = n.slice(0, 6);
      const pList = index.prefixMap.get(p);
      if (pList) {
        for (const b of pList) candidateSet.add(b);
      }
    }

    // 3. Significant token candidates
    const nSigTokens = getSignificantTokens(n);
    if (nSigTokens.length === 0 && n.length >= 8 && n.split(" ").length >= 2) {
      // Safe fail-open for novel candidate composed entirely of stop words
      checkAllBooks = true;
    }
    for (const t of nSigTokens) {
      const tList = index.tokenMap.get(t);
      if (tList) {
        for (const b of tList) candidateSet.add(b);
      }
    }
  }

  const booksToEvaluate = checkAllBooks ? index.processedCalibreBooks : Array.from(candidateSet);
  let matchCount = 0;
  const ownedVolumeSet = new Set<number>();

  for (const b of booksToEvaluate) {
    let isMatch = false;

    // 1. Direct candidate equality (O(1) Set lookup with spinoff mismatch protection)
    for (const n of nCandidates) {
      if (b.candidates.has(n)) {
        for (const c of b.candidates) {
          if (c === n && !isSpinoffMismatch(n, c)) {
            isMatch = true;
            break;
          }
        }
        if (isMatch) break;
      }
    }

    // 2. Containment matching (where either contains the other, bounded, length >= 8 and >= 2 words)
    if (!isMatch) {
      for (const n of nCandidates) {
        const nWords = n.split(" ").length;
        for (const c of b.candidates) {
          if (isSpinoffMismatch(n, c)) continue;
          const cWords = c.split(" ").length;
          // c inside n
          if (c.length >= 8 && cWords >= 2 && ` ${n} `.includes(` ${c} `)) {
            isMatch = true;
            break;
          }
          // n inside c
          if (n.length >= 8 && nWords >= 2 && ` ${c} `.includes(` ${n} `)) {
            isMatch = true;
            break;
          }
        }
        if (isMatch) break;
      }
    }

    // 3. Significant token overlap matching (>= 70% significant word overlap)
    if (!isMatch) {
      const hasSpinoffConflict = Array.from(nCandidates).some((n) =>
        Array.from(b.candidates).some((c) => isSpinoffMismatch(n, c)),
      );
      if (!hasSpinoffConflict) {
        for (const nTok of nTokensList) {
          const nStr = nTok.join(" ");
          for (const cTok of b.tokensList) {
            const cStr = cTok.join(" ");
            if (isSpinoffMismatch(nStr, cStr)) continue;
            const overlap = calculateSignificantTokenOverlap(nTok, cTok);
            if (overlap >= 0.70) {
              isMatch = true;
              break;
            }
          }
          if (isMatch) break;
        }
      }
    }

    // 4. Prefix start matching fallback
    if (!isMatch) {
      const hasSpinoffConflict = Array.from(nCandidates).some((n) =>
        Array.from(b.candidates).some((c) => isSpinoffMismatch(n, c)),
      );
      if (!hasSpinoffConflict) {
        for (const n of nCandidates) {
          if (n.length >= 6) {
            for (const c of b.candidates) {
              if (isSpinoffMismatch(n, c)) continue;
              if (c.length >= 6 && (c.startsWith(n) || n.startsWith(c))) {
                isMatch = true;
                break;
              }
            }
          }
          if (isMatch) break;
        }
      }
    }

    if (isMatch) {
      matchCount++;
      let volNum: number | null = null;
      if (b.book.title) {
        volNum = resolveCanonicalVolumeNumber(b.book.title, b.book.series || novel.title);
      }
      if (
        (volNum === null || volNum < 0) &&
        b.book.series_index !== undefined &&
        b.book.series_index !== null &&
        !isNaN(Number(b.book.series_index)) &&
        Number(b.book.series_index) >= 0
      ) {
        // Preserve fractional series_index values without rounding
        volNum = Number(b.book.series_index);
      }
      if (volNum !== null && volNum >= 0) {
        ownedVolumeSet.add(volNum);
      }
    }
  }

  const ownedVolumeIndices = Array.from(ownedVolumeSet).sort((a, b) => a - b);
  const existingVolumes = ownedVolumeIndices.length > 0 ? ownedVolumeIndices.length : matchCount;
  const maxOwned = ownedVolumeIndices.length > 0 ? Math.max(...ownedVolumeIndices) : 0;
  const catalogVolumeCount = novel.catalogVolumeCount ??
    (novel.volumeCount && novel.volumeCount > 1
      ? novel.volumeCount
      : resolveCatalogVolumeCount(novel.title, novel.titleRomaji, novel));

  // Determine verified volumes from novel.verifiedVolumes or verified sources
  let verifiedVolumes = novel.verifiedVolumes;
  if (!verifiedVolumes && Array.isArray(novel.sources)) {
    const verifiedSources = novel.sources.filter((s) => s.status === "verified");
    if (verifiedSources.length > 0) {
      const uSet = new Set<number>();
      for (const s of verifiedSources) {
        if (Array.isArray(s.volumes)) {
          for (const v of s.volumes) {
            if (typeof v === "number" && !isNaN(v) && v >= 0) uSet.add(v);
          }
        }
      }
      if (uSet.size > 0) {
        verifiedVolumes = Array.from(uSet).sort((a, b) => a - b);
      }
    }
  }

  const hasVerified = Array.isArray(verifiedVolumes) && verifiedVolumes.length > 0;
  let missingVolumeIndices: number[] | undefined = undefined;
  let missingVolumeCount: number | undefined = undefined;
  let totalVolumeCount = hasVerified ? verifiedVolumes!.length : Math.max(catalogVolumeCount, existingVolumes, Math.ceil(maxOwned));
  let sourceStatus: "verified" | "unverified" | "error" =
    novel.sourceStatus || (hasVerified ? "verified" : "unverified");
  let allVerifiedOwned = false;

  if (hasVerified && verifiedVolumes) {
    missingVolumeIndices = verifiedVolumes.filter((v) => !ownedVolumeSet.has(v));
    missingVolumeCount = missingVolumeIndices.length;
    totalVolumeCount = verifiedVolumes.length;
    sourceStatus = "verified";
    allVerifiedOwned = missingVolumeCount === 0 && (existingVolumes > 0 || ownedVolumeSet.size > 0);
  } else {
    // Unverified or failed: unknown availability means unknown missing count
    // Do NOT generate 1..totalVolumeCount downloadable missing volumes!
    missingVolumeIndices = undefined;
    missingVolumeCount = undefined;
    allVerifiedOwned = false;
  }

  return {
    ...novel,
    volumeCount: totalVolumeCount,
    catalogVolumeCount,
    verifiedVolumeCount: hasVerified ? verifiedVolumes!.length : undefined,
    verifiedVolumes: hasVerified ? verifiedVolumes : undefined,
    sourceStatus,
    allVerifiedOwned,
    inLibrary: matchCount > 0,
    existingVolumes,
    ownedVolumeIndices,
    missingVolumeIndices,
    missingVolumeCount,
  };
}

/**
 * Computes an unowned novel audit without Calibre books, respecting verified inventories.
 */
function computeUnownedNovelAudit(
  novel: DiscoveredNovel,
  dependencies?: DiscoverDependencies,
): DiscoveredNovel {
  const enriched = attachCachedInventoriesIfAvailable(novel, dependencies);
  const catalogVolumeCount = enriched.catalogVolumeCount ?? enriched.volumeCount ?? 1;
  const verifiedVolumes =
    enriched.verifiedVolumes ??
    (Array.isArray(enriched.sources)
      ? Array.from(
          new Set(
            enriched.sources
              .filter((s) => s.status === "verified")
              .flatMap((s) => s.volumes || []),
          ),
        ).sort((a, b) => a - b)
      : undefined);
  const hasVerified = Array.isArray(verifiedVolumes) && verifiedVolumes.length > 0;

  if (hasVerified && verifiedVolumes) {
    return {
      ...enriched,
      volumeCount: verifiedVolumes.length,
      catalogVolumeCount,
      verifiedVolumeCount: verifiedVolumes.length,
      verifiedVolumes,
      sourceStatus: "verified",
      allVerifiedOwned: false,
      inLibrary: false,
      existingVolumes: 0,
      ownedVolumeIndices: [],
      missingVolumeIndices: [...verifiedVolumes],
      missingVolumeCount: verifiedVolumes.length,
    };
  }

  return {
    ...enriched,
    volumeCount: catalogVolumeCount,
    catalogVolumeCount,
    sourceStatus: enriched.sourceStatus || "unverified",
    allVerifiedOwned: false,
    inLibrary: false,
    existingVolumes: 0,
    ownedVolumeIndices: [],
    missingVolumeIndices: undefined,
    missingVolumeCount: undefined,
  };
}

/**
 * Resolves Calibre books using dependencies or local SQLite database.
 */
export function resolveCalibreBooks(dependencies?: DiscoverDependencies): any[] {
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
  return calibreBooks;
}

/**
 * Yields control to the Node/Bun event loop.
 */
export function yieldEventLoop(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

/**
 * Asynchronously cross-references discovered light novels against the local Calibre library,
 * cooperatively yielding the event loop every `yieldEvery` items (default 200).
 * Acquires a single prebuilt inverted index up front for the entire scan.
 */
export async function crossCheckNovelsWithCalibreAsync(
  novels: DiscoveredNovel[],
  dependencies?: DiscoverDependencies,
  yieldEvery = 200,
): Promise<DiscoveredNovel[]> {
  const calibreBooks = resolveCalibreBooks(dependencies);

  if (calibreBooks.length === 0) {
    return novels.map((novel) => computeUnownedNovelAudit(novel, dependencies));
  }

  const index = getOrCreateCalibreInvertedIndex(calibreBooks);
  const results: DiscoveredNovel[] = [];

  for (let i = 0; i < novels.length; i++) {
    if (i > 0 && i % yieldEvery === 0) {
      await yieldEventLoop();
    }
    const enriched = attachCachedInventoriesIfAvailable(novels[i], dependencies);
    results.push(matchNovelWithCalibreIndex(enriched, index));
  }

  return results;
}

/**
 * Cross-references discovered light novels against the local Calibre library.
 * Tags each novel with inLibrary: boolean and existingVolumes: number.
 */
export function crossCheckNovelsWithCalibre(
  novels: DiscoveredNovel[],
  dependencies?: DiscoverDependencies,
): DiscoveredNovel[] {
  const calibreBooks = resolveCalibreBooks(dependencies);

  if (calibreBooks.length === 0) {
    return novels.map((novel) => computeUnownedNovelAudit(novel, dependencies));
  }

  const index = getOrCreateCalibreInvertedIndex(calibreBooks);
  return novels.map((novel) => {
    const enriched = attachCachedInventoriesIfAvailable(novel, dependencies);
    return matchNovelWithCalibreIndex(enriched, index);
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
 * Aggregates and enriches the complete catalog of light novels across both sources
 * (Lnori and Elsci.one), deduplicating by normalized title, enriching with real authors,
 * high-res covers, genres, and full synopses, and prioritizing Elsci.one as primary.
 */
export async function buildCompleteCatalogNovels(
  dependencies?: DiscoverDependencies,
): Promise<DiscoveredNovel[]> {
  const elscioneFolders = dependencies?.customElscioneFolders || REAL_ELSCIONE_FOLDERS;
  const lnoriSeries = dependencies?.customLnoriSeries || REAL_LNORI_SERIES;

  const allSeeds = [
    ...(dependencies?.seedTrendingNovels ?? SEED_TRENDING_NOVELS),
    ...(dependencies?.seedNewNovels ?? SEED_NEW_NOVELS),
  ];

  const seedMap = new Map<string, DiscoveredNovel>();
  for (const s of allSeeds) {
    seedMap.set(canonicalTitleKey(s.title), s);
    seedMap.set(normalizeTitleForMatch(s.title), s);
    if (s.titleRomaji) {
      seedMap.set(canonicalTitleKey(s.titleRomaji), s);
      seedMap.set(normalizeTitleForMatch(s.titleRomaji), s);
    }
  }

  const seenKeys = new Set<string>();
  const novels: DiscoveredNovel[] = [];

  // 1. Ingest all Elsci.one folders (~1,200+ series)
  for (const folder of elscioneFolders) {
    const norm = normalizeTitleForMatch(folder);
    const can = canonicalTitleKey(folder);
    if (seenKeys.has(norm) || seenKeys.has(can)) continue;

    const real = resolveRealDownloadSources(folder, undefined, undefined, {
      customElscioneFolders: dependencies?.customElscioneFolders,
      customLnoriSeries: dependencies?.customLnoriSeries,
    });
    if (!real) continue;

    const seed = seedMap.get(can) || seedMap.get(norm);
    const author = seed?.author || resolveAuthorForTitle(folder, undefined, allSeeds);
    const coverUrl =
      seed?.coverUrl ||
      resolveCoverForTitle(folder, undefined, allSeeds) ||
      resolveCatalogCover(folder) ||
      generateFallbackCoverSvg(folder, author);
    const knownSyn = findKnownSeriesSynopsis({ title: folder, author });
    const rawSynopsis = seed?.synopsis || knownSyn || synthesizeEngagingSynopsis(folder, ["Light Novel", "Fantasy"]);
    const synopsis = cleanSynopsisText(rawSynopsis);
    const genres = seed?.genres && seed.genres.length > 0 ? seed.genres : ["Light Novel", "Fantasy"];
    const score = seed?.score ?? 85;
    const popularity = seed?.popularity ?? (real.source === "both" ? 7500 : 5000);
    const releaseDate = seed?.releaseDate ?? "2024-01-01";
    const volumeCount = resolveCatalogVolumeCount(folder, seed?.titleRomaji, seed);

    const slug = folder
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-|-$/g, "");

    const novel = assignPrimarySource({
      id: seed?.id || `elscione-${slug}`,
      title: seed?.title || folder,
      titleRomaji: seed?.titleRomaji,
      titleNative: seed?.titleNative,
      author,
      coverUrl,
      synopsis,
      genres,
      score,
      popularity,
      releaseDate,
      volumeCount,
      source: real.source,
      primarySource: real.primarySource,
      primaryUrl: real.primaryUrl,
      sourceUrls: real.sourceUrls,
      inLibrary: false,
      existingVolumes: 0,
    });

    seenKeys.add(norm);
    seenKeys.add(can);
    if (seed?.titleRomaji) {
      seenKeys.add(normalizeTitleForMatch(seed.titleRomaji));
      seenKeys.add(canonicalTitleKey(seed.titleRomaji));
    }

    novels.push(novel);
  }

  // 2. Ingest all Lnori series (~880+ series)
  for (const s of lnoriSeries) {
    const slugTitle = s.slug.replace(/-/g, " ");
    const norm = normalizeTitleForMatch(slugTitle);
    const can = canonicalTitleKey(slugTitle);
    if (seenKeys.has(norm) || seenKeys.has(can)) continue;

    const real = resolveRealDownloadSources(slugTitle, undefined, undefined, {
      customElscioneFolders: dependencies?.customElscioneFolders,
      customLnoriSeries: dependencies?.customLnoriSeries,
    });
    if (!real) continue;

    const displayTitle = slugTitle
      .split(" ")
      .map((w) => (w.length > 0 ? w[0].toUpperCase() + w.slice(1) : ""))
      .join(" ");

    const seed = seedMap.get(can) || seedMap.get(norm);
    const author = seed?.author || resolveAuthorForTitle(displayTitle, undefined, allSeeds);
    const coverUrl =
      seed?.coverUrl ||
      resolveCoverForTitle(displayTitle, undefined, allSeeds) ||
      resolveCatalogCover(displayTitle) ||
      resolveCatalogCover(s.slug) ||
      generateFallbackCoverSvg(displayTitle, author);
    const knownSyn = findKnownSeriesSynopsis({ title: displayTitle, author });
    const rawSynopsis = seed?.synopsis || knownSyn || synthesizeEngagingSynopsis(displayTitle, ["Light Novel", "Fantasy"]);
    const synopsis = cleanSynopsisText(rawSynopsis);
    const genres = seed?.genres && seed.genres.length > 0 ? seed.genres : ["Light Novel", "Fantasy"];
    const score = seed?.score ?? 85;
    const popularity = seed?.popularity ?? (real.source === "both" ? 7500 : 5000);
    const releaseDate = seed?.releaseDate ?? "2024-01-01";
    const volumeCount = resolveCatalogVolumeCount(displayTitle, seed?.titleRomaji, seed);

    const novel = assignPrimarySource({
      id: seed?.id || `lnori-${s.id}-${s.slug}`,
      title: seed?.title || displayTitle,
      titleRomaji: seed?.titleRomaji,
      titleNative: seed?.titleNative,
      author,
      coverUrl,
      synopsis,
      genres,
      score,
      popularity,
      releaseDate,
      volumeCount,
      source: real.source,
      primarySource: real.primarySource,
      primaryUrl: real.primaryUrl,
      sourceUrls: real.sourceUrls,
      inLibrary: false,
      existingVolumes: 0,
    });

    seenKeys.add(norm);
    seenKeys.add(can);
    if (seed?.titleRomaji) {
      seenKeys.add(normalizeTitleForMatch(seed.titleRomaji));
      seenKeys.add(canonicalTitleKey(seed.titleRomaji));
    }

    novels.push(novel);
  }

  return novels;
}

// Alias matching specification naming
export const buildCatalogDiscoverNovels = buildCompleteCatalogNovels;

export const DISCOVER_FEED_CACHE_VERSION = "v6";

/**
 * Discovers and builds the feed for a requested tab ("trending" | "new" | "all").
 * Enforces strict separation: trending and new feeds are distinct and never combined,
 * while "all" represents the unified complete library of light novels across sources.
 */
export async function fetchDiscoverFeed(
  tab: DiscoverTab,
  dependencies?: DiscoverDependencies,
): Promise<DiscoveredNovel[]> {
  const cacheKey = `${DISCOVER_FEED_CACHE_VERSION}:feed:${tab}`;

  // 1. Check cache
  const cached = getCachedFeed(cacheKey, dependencies);
  if (cached && cached.length > 0) {
    const verified = await ensureAllNovelsHaveSynopses(cached, dependencies);
    if (dependencies?.skipCrossCheck) return verified;
    return crossCheckNovelsWithCalibre(verified, dependencies);
  }

  // 2. Tab "all": Build complete catalogue from Elscione & Lnori
  if (tab === "all") {
    let allNovels = await buildCompleteCatalogNovels(dependencies);
    allNovels = await ensureAllNovelsHaveSynopses(allNovels, dependencies);
    setCachedFeed(cacheKey, allNovels, dependencies);
    if (dependencies?.skipCrossCheck) return allNovels;
    return crossCheckNovelsWithCalibreAsync(allNovels, dependencies, 200);
  }

  // 3. Try online fetch with short timeout for trending/new
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

  // Strict Deduplication:
  // - Deduplicate within feed
  // - Ensure New Releases does not contain titles already present in Trending
  if (tab === "new") {
    const trendingNovels = await fetchDiscoverFeed("trending", {
      ...dependencies,
      skipCrossCheck: true,
    });
    const trendingTitleKeys = new Set<string>();
    for (const t of trendingNovels) {
      trendingTitleKeys.add(normalizeTitleForMatch(t.title));
      trendingTitleKeys.add(canonicalTitleKey(t.title));
      if (t.titleRomaji) {
        trendingTitleKeys.add(normalizeTitleForMatch(t.titleRomaji));
        trendingTitleKeys.add(canonicalTitleKey(t.titleRomaji));
      }
    }

    freshNovels = freshNovels.filter((n) => {
      const norm = normalizeTitleForMatch(n.title);
      const can = canonicalTitleKey(n.title);
      const normRom = n.titleRomaji ? normalizeTitleForMatch(n.titleRomaji) : "";
      const canRom = n.titleRomaji ? canonicalTitleKey(n.titleRomaji) : "";

      const inTrending =
        trendingTitleKeys.has(norm) ||
        trendingTitleKeys.has(can) ||
        (normRom && trendingTitleKeys.has(normRom)) ||
        (canRom && trendingTitleKeys.has(canRom));

      return !inTrending;
    });

    freshNovels = deduplicateDiscoverNovels(freshNovels);

    const seedCandidates = dependencies?.seedNewNovels ?? SEED_NEW_NOVELS;
    for (const seed of seedCandidates) {
      const norm = normalizeTitleForMatch(seed.title);
      const can = canonicalTitleKey(seed.title);
      const normRom = seed.titleRomaji ? normalizeTitleForMatch(seed.titleRomaji) : "";
      const canRom = seed.titleRomaji ? canonicalTitleKey(seed.titleRomaji) : "";

      const inTrending =
        trendingTitleKeys.has(norm) ||
        trendingTitleKeys.has(can) ||
        (normRom && trendingTitleKeys.has(normRom)) ||
        (canRom && trendingTitleKeys.has(canRom));

      if (!inTrending) {
        freshNovels.push({ ...seed });
      }
    }

    freshNovels = deduplicateDiscoverNovels(freshNovels);
  } else {
    freshNovels = deduplicateDiscoverNovels(freshNovels);
  }

  // Ensure all discovered novels have complete, engaging, non-empty synopses
  freshNovels = await ensureAllNovelsHaveSynopses(freshNovels, dependencies);

  // 3. Cache the raw feed
  setCachedFeed(cacheKey, freshNovels, dependencies);

  // 4. Cross-check against Calibre
  if (dependencies?.skipCrossCheck) return freshNovels;
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
          staff {
            edges {
              role
              node {
                name {
                  full
                }
              }
            }
            nodes {
              name {
                full
              }
            }
          }
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

      let author = "";
      if (Array.isArray(item.staff?.edges) && item.staff.edges.length > 0) {
        const storyEdge = item.staff.edges.find((e: any) =>
          /original\s*story|story|author|creator|writer/i.test(e?.role || ""),
        );
        if (storyEdge?.node?.name?.full) {
          author = storyEdge.node.name.full.trim();
        } else if (item.staff.edges[0]?.node?.name?.full) {
          author = item.staff.edges[0].node.name.full.trim();
        }
      }
      if (!author && Array.isArray(item.staff?.nodes) && item.staff.nodes.length > 0) {
        for (const n of item.staff.nodes) {
          if (n?.name?.full) {
            author = n.name.full.trim();
            break;
          }
        }
      }
      if (!author) {
        const norm = normalizeTitleForMatch(title);
        const normRomaji = item.title?.romaji ? normalizeTitleForMatch(item.title.romaji) : "";
        author = KNOWN_TITLE_TO_AUTHOR[norm] || (normRomaji ? KNOWN_TITLE_TO_AUTHOR[normRomaji] : "") || "Author Unknown";
      }

      let coverUrl = item.coverImage?.extraLarge || item.coverImage?.large || "";
      if (!coverUrl || coverUrl.includes("images.ranobedb.org")) {
        const norm = normalizeTitleForMatch(title);
        coverUrl = KNOWN_TITLE_TO_COVER[norm] || "";
      }

      const resolvedVolCount =
        item.volumes && item.volumes > 0
          ? item.volumes
          : resolveCatalogVolumeCount(title, item.title?.romaji);
      const volumeCount = resolvedVolCount > 0 ? resolvedVolCount : 1;

      results.push({
        id: `anilist-${item.id}-${slug}`,
        title,
        titleRomaji: item.title?.romaji || undefined,
        titleNative: item.title?.native || undefined,
        author,
        coverUrl,
        synopsis: cleanSynopsisText((item.description || "").replace(/<[^>]+>/g, "").trim()),
        genres: Array.isArray(item.genres) && item.genres.length > 0 ? item.genres : ["Light Novel"],
        score: item.averageScore || 80,
        popularity: item.popularity || 10000,
        releaseDate,
        volumeCount,
        catalogVolumeCount: volumeCount,
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
    for (const r of results) {
      existingTitles.add(canonicalTitleKey(r.title));
      if (r.titleRomaji) {
        existingTitles.add(normalizeTitleForMatch(r.titleRomaji));
        existingTitles.add(canonicalTitleKey(r.titleRomaji));
      }
    }

    for (const seed of seedCandidates) {
      const norm = normalizeTitleForMatch(seed.title);
      const can = canonicalTitleKey(seed.title);
      if (!existingTitles.has(norm) && !existingTitles.has(can)) {
        results.push({ ...seed });
        existingTitles.add(norm);
        existingTitles.add(can);
      }
    }

    return results.length > 0 ? results : null;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Resolves real author for title using exact match, canonical match, or seeds.
 * Loose substring matching (norm.includes(k) or norm.startsWith(k)) is strictly prohibited
 * to prevent unrelated novels from receiving incorrect authors.
 * Uncredited authors return "Author Unknown", never "Light Novel Author".
 */
export function resolveAuthorForTitle(
  title: string,
  romaji?: string,
  seeds?: DiscoveredNovel[],
): string {
  const rawCandidates = [title, romaji].filter(Boolean) as string[];
  const candidates: string[] = [];
  for (const c of rawCandidates) {
    if (!candidates.includes(c)) candidates.push(c);
    for (const v of cleanCalibreTitleVariants(c)) {
      if (!candidates.includes(v)) candidates.push(v);
    }
  }

  // 1. Direct exact match against known author registry (normalized or canonical)
  for (const c of candidates) {
    const norm = normalizeTitleForMatch(c);
    if (!norm) continue;
    if (KNOWN_TITLE_TO_AUTHOR[norm]) return KNOWN_TITLE_TO_AUTHOR[norm];
    const can = canonicalTitleKey(c);
    if (can && KNOWN_TITLE_TO_AUTHOR[can]) return KNOWN_TITLE_TO_AUTHOR[can];
  }

  // 2. Strict word-boundary match with high length ratio (>= 0.85)
  // Replaces loose norm.includes(k) and norm.startsWith(k) to prevent incorrect authors
  for (const c of candidates) {
    const norm = normalizeTitleForMatch(c);
    if (!norm || norm.length < 4) continue;

    for (const [k, author] of Object.entries(KNOWN_TITLE_TO_AUTHOR)) {
      if (norm === k) return author;
      const minLen = Math.min(norm.length, k.length);
      const maxLen = Math.max(norm.length, k.length);
      if (minLen >= 4 && minLen / maxLen >= 0.85) {
        const isWordBoundaryMatch =
          (norm.startsWith(k) && (norm.length === k.length || norm[k.length] === " ")) ||
          (k.startsWith(norm) && (k.length === norm.length || k[norm.length] === " "));
        if (isWordBoundaryMatch) {
          return author;
        }
      }
    }
  }

  // 3. Match against seed novels with exact or high-ratio (>= 0.85) word-boundary match
  if (seeds && seeds.length > 0) {
    for (const c of candidates) {
      const norm = normalizeTitleForMatch(c);
      if (!norm || norm.length < 4) continue;
      const can = canonicalTitleKey(c);

      const seedMatch = seeds.find((s) => {
        const sNorm = normalizeTitleForMatch(s.title);
        const sRom = s.titleRomaji ? normalizeTitleForMatch(s.titleRomaji) : "";
        const sCan = canonicalTitleKey(s.title);
        if (sNorm === norm || (sRom && sRom === norm) || (sCan && sCan === can)) {
          return true;
        }
        for (const target of [sNorm, sRom].filter(Boolean)) {
          const minLen = Math.min(norm.length, target.length);
          const maxLen = Math.max(norm.length, target.length);
          if (minLen >= 4 && minLen / maxLen >= 0.85) {
            const isWordBoundaryMatch =
              (norm.startsWith(target) && (norm.length === target.length || norm[target.length] === " ")) ||
              (target.startsWith(norm) && (target.length === norm.length || target[norm.length] === " "));
            if (isWordBoundaryMatch) {
              return true;
            }
          }
        }
        return false;
      });
      if (seedMatch && seedMatch.author && seedMatch.author !== "Light Novel Author" && seedMatch.author !== "Author Unknown") {
        return seedMatch.author;
      }
    }
  }

  return "Author Unknown";
}

/**
 * Escapes XML/HTML entities for SVG text injection.
 */
export function escapeXml(str: string): string {
  return String(str || "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

/**
 * Generates a high-res, Apple-aesthetic SVG book cover as a data URI.
 * Provides a refined dark-gradient cover with typography and 3D spine for titles without external covers.
 */
export function generateFallbackCoverSvg(title: string, author?: string): string {
  const safeTitle = (title || "Light Novel").trim();
  const safeAuthor =
    author && author !== "Light Novel Author" && author !== "Author Unknown"
      ? author.trim()
      : "";

  const words = safeTitle.split(/\s+/);
  const lines: string[] = [];
  let currentLine = "";
  for (const word of words) {
    const candidateLine = currentLine ? `${currentLine} ${word}` : word;
    if (candidateLine.length <= 16) {
      currentLine = candidateLine;
    } else {
      if (currentLine) lines.push(currentLine);
      currentLine = word.slice(0, 16);
    }
    if (lines.length >= 4) break;
  }
  if (currentLine && lines.length < 4) lines.push(currentLine);
  if (lines.length === 0) lines.push(safeTitle.slice(0, 16));

  const textTspans = lines
    .map((line, idx) => {
      const y = 145 + idx * 16 - ((lines.length - 1) * 8);
      return `<text x="105" y="${y}" fill="#f4f4f5" font-family="-apple-system, BlinkMacSystemFont, 'SF Pro Display', 'Segoe UI', Roboto, sans-serif" font-size="11" font-weight="700" text-anchor="middle">${escapeXml(line)}</text>`;
    })
    .join("");

  const authorSvg = safeAuthor
    ? `<text x="105" y="${165 + lines.length * 8}" fill="#a1a1aa" font-family="-apple-system, BlinkMacSystemFont, 'SF Pro Text', 'Segoe UI', Roboto, sans-serif" font-size="8.5" font-weight="500" text-anchor="middle">${escapeXml(safeAuthor)}</text>`
    : "";

  const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 200 300" width="200" height="300"><defs><linearGradient id="appleDarkBg" x1="0%" y1="0%" x2="100%" y2="100%"><stop offset="0%" stop-color="#18181b"/><stop offset="50%" stop-color="#121214"/><stop offset="100%" stop-color="#09090b"/></linearGradient><linearGradient id="appleSpine" x1="0%" y1="0%" x2="100%" y2="0%"><stop offset="0%" stop-color="#27272a"/><stop offset="80%" stop-color="#18181b"/><stop offset="100%" stop-color="#09090b"/></linearGradient><linearGradient id="accentGlow" x1="0%" y1="0%" x2="0%" y2="100%"><stop offset="0%" stop-color="#f59e0b" stop-opacity="0.12"/><stop offset="100%" stop-color="#f59e0b" stop-opacity="0"/></linearGradient></defs><rect width="200" height="300" fill="url(#appleDarkBg)"/><rect x="0" y="0" width="200" height="120" fill="url(#accentGlow)"/><rect x="0" y="0" width="12" height="300" fill="url(#appleSpine)"/><line x1="12" y1="0" x2="12" y2="300" stroke="#3f3f46" stroke-width="0.75" stroke-opacity="0.4"/><rect x="20" y="18" width="164" height="264" rx="4" fill="none" stroke="#27272a" stroke-width="0.75" stroke-opacity="0.5"/><g transform="translate(93, 72)"><path d="M12 6.253v13m0-13C10.832 5.477 9.246 5 7.5 5S4.168 5.477 3 6.253v13C4.168 18.477 5.754 18 7.5 18s3.332.477 4.5 1.253m0-13C13.168 5.477 14.754 5 16.5 5c1.747 0 3.332.477 4.5 1.253v13C19.832 18.477 18.247 18 16.5 18c-1.746 0-3.332.477-4.5 1.253" stroke="#f59e0b" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" fill="none"/></g>${textTspans}${authorSvg}<text x="105" y="255" fill="#71717a" font-family="-apple-system, BlinkMacSystemFont, 'SF Pro Text', 'Segoe UI', Roboto, sans-serif" font-size="8" font-weight="600" letter-spacing="2" text-anchor="middle">LIGHT NOVEL</text></svg>`;

  return `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`;
}

/**
 * Resolves cover art for title using exact match, canonical match, or word-boundary match with high length ratio (>= 0.85).
 * Loose substring containment (e.g. norm.includes(k)) is strictly prohibited to prevent unrelated novels
 * (e.g. novels mentioning "slime" or "overlord") from receiving wrong franchise covers.
 */
export function resolveCoverForTitle(
  title: string,
  romaji?: string,
  seeds?: DiscoveredNovel[],
): string {
  const rawCandidates = [title, romaji].filter(Boolean) as string[];
  const candidates: string[] = [];
  for (const c of rawCandidates) {
    if (!candidates.includes(c)) candidates.push(c);
    for (const v of cleanCalibreTitleVariants(c)) {
      if (!candidates.includes(v)) candidates.push(v);
    }
  }

  // 1. Direct exact match against known cover registry (normalized or canonical)
  for (const c of candidates) {
    const norm = normalizeTitleForMatch(c);
    if (!norm) continue;
    if (KNOWN_TITLE_TO_COVER[norm]) return KNOWN_TITLE_TO_COVER[norm];
    const can = canonicalTitleKey(c);
    if (can && KNOWN_TITLE_TO_COVER[can]) return KNOWN_TITLE_TO_COVER[can];
  }

  // 2. Strict word-boundary match with high length ratio (>= 0.85)
  // Replaces loose norm.includes(k) to prevent incorrect covers on unrelated novels.
  for (const c of candidates) {
    const norm = normalizeTitleForMatch(c);
    if (!norm || norm.length < 4) continue;

    for (const [k, cover] of Object.entries(KNOWN_TITLE_TO_COVER)) {
      if (norm === k) return cover;
      const minLen = Math.min(norm.length, k.length);
      const maxLen = Math.max(norm.length, k.length);
      if (minLen >= 4 && minLen / maxLen >= 0.85) {
        const isWordBoundaryMatch =
          (norm.startsWith(k) && (norm.length === k.length || norm[k.length] === " ")) ||
          (k.startsWith(norm) && (k.length === norm.length || k[norm.length] === " "));
        if (isWordBoundaryMatch) {
          return cover;
        }
      }
    }
  }

  // 3. Match against seed novels with exact or high-ratio (>= 0.85) word-boundary match
  if (seeds && seeds.length > 0) {
    for (const c of candidates) {
      const norm = normalizeTitleForMatch(c);
      if (!norm || norm.length < 4) continue;
      const can = canonicalTitleKey(c);

      const seedMatch = seeds.find((s) => {
        const sNorm = normalizeTitleForMatch(s.title);
        const sRom = s.titleRomaji ? normalizeTitleForMatch(s.titleRomaji) : "";
        const sCan = canonicalTitleKey(s.title);
        if (sNorm === norm || (sRom && sRom === norm) || (sCan && sCan === can)) {
          return true;
        }
        for (const target of [sNorm, sRom].filter(Boolean)) {
          const minLen = Math.min(norm.length, target.length);
          const maxLen = Math.max(norm.length, target.length);
          if (minLen >= 4 && minLen / maxLen >= 0.85) {
            const isWordBoundaryMatch =
              (norm.startsWith(target) && (norm.length === target.length || norm[target.length] === " ")) ||
              (target.startsWith(norm) && (target.length === norm.length || target[norm.length] === " "));
            if (isWordBoundaryMatch) {
              return true;
            }
          }
        }
        return false;
      });
      if (seedMatch && seedMatch.coverUrl) {
        return seedMatch.coverUrl;
      }
    }
  }

  return "";
}

/**
 * Executes live online AniList search across light novels.
 */
export async function searchAniListNovels(
  searchQuery: string,
  dependencies?: DiscoverDependencies,
): Promise<DiscoveredNovel[]> {
  const isTestEnv =
    process.env.NODE_ENV === "test" ||
    typeof (globalThis as any).it === "function";

  const allowOnline =
    Boolean(dependencies?.fetch) ||
    (dependencies?.enableOnline ?? !isTestEnv);

  if (!allowOnline) {
    return [];
  }

  const fetcher = dependencies?.fetch ?? safeFetchWithSsrf;
  const timeoutMs = dependencies?.onlineTimeoutMs ?? 5000;

  const query = `
    query ($search: String) {
      Page(page: 1, perPage: 25) {
        media(type: MANGA, format_in: [NOVEL], search: $search) {
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
          staff {
            edges {
              role
              node {
                name {
                  full
                }
              }
            }
            nodes {
              name {
                full
              }
            }
          }
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
      body: JSON.stringify({ query, variables: { search: searchQuery } }),
      signal: controller.signal,
    } as any);

    if (!res.ok) {
      return [];
    }

    const json = (await res.json()) as any;
    const media = json?.data?.Page?.media;
    if (!Array.isArray(media) || media.length === 0) {
      return [];
    }

    const results: DiscoveredNovel[] = [];
    for (const item of media) {
      const title = item.title?.english || item.title?.romaji;
      if (!title) continue;

      const realSources = resolveRealDownloadSources(
        title,
        item.title?.romaji,
        item.title?.native,
        {
          customElscioneFolders: dependencies?.customElscioneFolders,
          customLnoriSeries: dependencies?.customLnoriSeries,
        },
      );

      // Only surface titles that have verified download paths on Elscione and/or Lnori.
      if (!realSources) {
        continue;
      }

      const slug = title
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, "-")
        .replace(/^-|-$/g, "");

      const year = item.startDate?.year || 2024;
      const month = String(item.startDate?.month || 1).padStart(2, "0");
      const day = String(item.startDate?.day || 1).padStart(2, "0");
      const releaseDate = `${year}-${month}-${day}`;

      let author = "";
      if (Array.isArray(item.staff?.edges) && item.staff.edges.length > 0) {
        const storyEdge = item.staff.edges.find((e: any) =>
          /original\s*story|story|author|creator|writer/i.test(e?.role || ""),
        );
        if (storyEdge?.node?.name?.full) {
          author = storyEdge.node.name.full.trim();
        } else if (item.staff.edges[0]?.node?.name?.full) {
          author = item.staff.edges[0].node.name.full.trim();
        }
      }
      if (!author && Array.isArray(item.staff?.nodes) && item.staff.nodes.length > 0) {
        for (const n of item.staff.nodes) {
          if (n?.name?.full) {
            author = n.name.full.trim();
            break;
          }
        }
      }
      if (!author) {
        author = resolveAuthorForTitle(title, item.title?.romaji);
      }

      let coverUrl = item.coverImage?.extraLarge || item.coverImage?.large || "";
      if (!coverUrl || coverUrl.includes("images.ranobedb.org")) {
        coverUrl = resolveCoverForTitle(title, item.title?.romaji);
      }

      const rawSynopsis = (item.description || "").replace(/<[^>]+>/g, "").trim();
      const synopsis =
        cleanSynopsisText(rawSynopsis) ||
        synthesizeEngagingSynopsis(title, item.genres || ["Light Novel"], item.title?.romaji);

      const resolvedVolCount =
        item.volumes && item.volumes > 0
          ? item.volumes
          : resolveCatalogVolumeCount(title, item.title?.romaji);
      const volumeCount = resolvedVolCount > 0 ? resolvedVolCount : 1;

      results.push({
        id: `anilist-${item.id}-${slug}`,
        title,
        titleRomaji: item.title?.romaji || undefined,
        titleNative: item.title?.native || undefined,
        author,
        coverUrl,
        synopsis,
        genres: Array.isArray(item.genres) && item.genres.length > 0 ? item.genres : ["Light Novel"],
        score: item.averageScore || 80,
        popularity: item.popularity || 10000,
        releaseDate,
        volumeCount,
        catalogVolumeCount: volumeCount,
        source: realSources.source,
        primarySource: realSources.primarySource,
        primaryUrl: realSources.primaryUrl,
        sourceUrls: realSources.sourceUrls,
        inLibrary: false,
        existingVolumes: 0,
      });
    }

    return results;
  } catch (err) {
    console.debug("[Discover] Live AniList search failed:", err);
    return [];
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Universal Catalog & Metadata Search Engine.
 * Searches across:
 * 1. Live AniList search (high-res cover art, full synopses, real author names, genre tags, scores)
 * 2. Seeds & feed cache
 * 3. All ~1,100+ officially translated series folders in discoverCatalog.elscioneFolders (and known alias mappings)
 * 4. All 883 series in discoverCatalog.lnoriSeries
 * Strictly resolves verified download sources, prioritizing Elsci.one as primarySource.
 * Cross-checks against Calibre for library ownership.
 */
export async function searchUniversalNovels(
  searchQuery: string,
  dependencies?: DiscoverDependencies,
): Promise<DiscoveredNovel[]> {
  const normQuery = normalizeTitleForMatch(searchQuery);
  if (!normQuery) return [];

  const queryTokens = getSignificantTokens(searchQuery);

  // 1. Gather all alias variations
  const queryAliases: string[] = [normQuery];
  for (const cluster of KNOWN_LIGHT_NOVEL_ALIAS_CLUSTERS) {
    const normC = cluster.map((s) => normalizeTitleForMatch(s)).filter(Boolean);
    const matchesCluster = normC.some(
      (alias) =>
        alias === normQuery ||
        (alias.length >= 4 && normQuery.includes(alias)) ||
        (normQuery.length >= 4 && alias.includes(normQuery)),
    );
    if (matchesCluster) {
      for (const a of normC) {
        if (!queryAliases.includes(a)) {
          queryAliases.push(a);
        }
      }
    }
  }

  // Also check KNOWN_TITLE_TO_ELSCIONE
  for (const [k, folder] of Object.entries(KNOWN_TITLE_TO_ELSCIONE)) {
    if (k === normQuery || (normQuery.length >= 4 && k.includes(normQuery))) {
      const normF = normalizeTitleForMatch(folder);
      if (!queryAliases.includes(normF)) queryAliases.push(normF);
    }
  }

  const results: DiscoveredNovel[] = [];

  const allSeeds = [
    ...(dependencies?.seedTrendingNovels ?? SEED_TRENDING_NOVELS),
    ...(dependencies?.seedNewNovels ?? SEED_NEW_NOVELS),
  ];

  const matchesNovel = (existing: DiscoveredNovel, novel: DiscoveredNovel): boolean => {
    const normA = normalizeTitleForMatch(existing.title);
    const normB = normalizeTitleForMatch(novel.title);
    if (normA === normB) return true;
    const canA = canonicalTitleKey(existing.title);
    const canB = canonicalTitleKey(novel.title);
    if (canA && canB && canA === canB) return true;
    if (existing.primaryUrl && novel.primaryUrl && existing.primaryUrl === novel.primaryUrl) return true;
    if (
      existing.sourceUrls?.elscione &&
      novel.sourceUrls?.elscione &&
      existing.sourceUrls.elscione === novel.sourceUrls.elscione
    ) {
      return true;
    }
    if (
      existing.sourceUrls?.lnori &&
      novel.sourceUrls?.lnori &&
      existing.sourceUrls.lnori === novel.sourceUrls.lnori
    ) {
      return true;
    }
    return false;
  };

  const addNovel = (novel: DiscoveredNovel) => {
    const existing = results.find((r) => matchesNovel(r, novel));
    if (existing) {
      // Upgrade metadata if new candidate is richer
      if (
        (!existing.author || existing.author === "Light Novel Author" || existing.author === "Author Unknown") &&
        novel.author &&
        novel.author !== "Light Novel Author" &&
        novel.author !== "Author Unknown"
      ) {
        existing.author = novel.author;
      }
      if (
        (!existing.coverUrl || existing.coverUrl.startsWith("data:image/svg+xml")) &&
        novel.coverUrl &&
        !novel.coverUrl.startsWith("data:image/svg+xml")
      ) {
        existing.coverUrl = novel.coverUrl;
      }
      if (isSynopsisInsufficient(existing.synopsis) && !isSynopsisInsufficient(novel.synopsis)) {
        existing.synopsis = novel.synopsis;
      }
      if (novel.sourceUrls?.elscione && !existing.sourceUrls?.elscione) {
        existing.sourceUrls.elscione = novel.sourceUrls.elscione;
      }
      if (novel.sourceUrls?.lnori && !existing.sourceUrls?.lnori) {
        existing.sourceUrls.lnori = novel.sourceUrls.lnori;
      }
      if (novel.volumeCount && novel.volumeCount > (existing.volumeCount || 1)) {
        existing.volumeCount = novel.volumeCount;
      }
      if (existing.sourceUrls?.elscione && existing.sourceUrls?.lnori) {
        existing.source = "both";
        existing.primarySource = "elscione";
        existing.primaryUrl = existing.sourceUrls.elscione;
      }
      return;
    }

    results.push(novel);
  };

  // 1. Live online AniList search
  const anilistNovels = await searchAniListNovels(searchQuery, dependencies);
  for (const novel of anilistNovels) {
    addNovel(novel);
  }

  // 2. Search seeds & cached feed items
  for (const seed of allSeeds) {
    const normS = normalizeTitleForMatch(seed.title);
    const normRom = seed.titleRomaji ? normalizeTitleForMatch(seed.titleRomaji) : "";
    const matchesSeed =
      normS.includes(normQuery) ||
      (normRom && normRom.includes(normQuery)) ||
      queryAliases.some((a) => normS.includes(a) || (normRom && normRom.includes(a))) ||
      (queryTokens.length > 1 && queryTokens.every((t) => normS.includes(t) || (normRom && normRom.includes(t)))) ||
      seed.synopsis.toLowerCase().includes(searchQuery.toLowerCase());

    if (matchesSeed) {
      const real = resolveRealDownloadSources(
        seed.title,
        seed.titleRomaji,
        seed.titleNative,
        {
          customElscioneFolders: dependencies?.customElscioneFolders,
          customLnoriSeries: dependencies?.customLnoriSeries,
        },
      );
      if (real) {
        addNovel({
          ...seed,
          source: real.source,
          primarySource: real.primarySource,
          primaryUrl: real.primaryUrl,
          sourceUrls: real.sourceUrls,
        });
      }
    }
  }

  // 3. Search ALL Elsci.one folders (~1,100+ folders)
  const elscioneFolders = dependencies?.customElscioneFolders || REAL_ELSCIONE_FOLDERS;
  for (const folder of elscioneFolders) {
    const normF = normalizeTitleForMatch(folder);
    const folderTokens = getSignificantTokens(folder);

    const matchesFolder =
      normF.includes(normQuery) ||
      queryAliases.some((a) => normF.includes(a) || (a.length >= 8 && normF.startsWith(a))) ||
      (queryTokens.length > 1 && queryTokens.every((t) => normF.includes(t))) ||
      (queryTokens.length >= 2 && folderTokens.length >= 2 && calculateSignificantTokenOverlap(queryTokens, folderTokens) >= 0.7);

    if (matchesFolder) {
      const real = resolveRealDownloadSources(folder, undefined, undefined, {
        customElscioneFolders: dependencies?.customElscioneFolders,
        customLnoriSeries: dependencies?.customLnoriSeries,
      });
      if (real) {
        const author = resolveAuthorForTitle(folder, undefined, allSeeds);
        const coverUrl =
          resolveCoverForTitle(folder, undefined, allSeeds) ||
          resolveCatalogCover(folder) ||
          generateFallbackCoverSvg(folder, author);
        const knownSyn = findKnownSeriesSynopsis({ title: folder, author });
        const synopsis =
          knownSyn ||
          synthesizeEngagingSynopsis(folder, ["Light Novel", "Fantasy"]);

        const seed = allSeeds.find(
          (s) =>
            normalizeTitleForMatch(s.title) === normF ||
            canonicalTitleKey(s.title) === canonicalTitleKey(folder),
        );
        const volumeCount = resolveCatalogVolumeCount(folder, seed?.titleRomaji, seed);

        const slug = folder
          .toLowerCase()
          .replace(/[^a-z0-9]+/g, "-")
          .replace(/^-|-$/g, "");

        addNovel({
          id: `elscione-${slug}`,
          title: folder,
          author,
          coverUrl,
          synopsis,
          genres: ["Light Novel", "Fantasy"],
          score: 85,
          popularity: 5000,
          releaseDate: "2024-01-01",
          volumeCount,
          source: real.source,
          primarySource: real.primarySource,
          primaryUrl: real.primaryUrl,
          sourceUrls: real.sourceUrls,
          inLibrary: false,
          existingVolumes: 0,
        });
      }
    }
  }

  // 4. Search ALL Lnori series (883 series)
  const lnoriSeries = dependencies?.customLnoriSeries || REAL_LNORI_SERIES;
  for (const s of lnoriSeries) {
    const slugTitle = s.slug.replace(/-/g, " ");
    const normS = normalizeTitleForMatch(slugTitle);
    const seriesTokens = getSignificantTokens(slugTitle);

    const matchesSeries =
      normS.includes(normQuery) ||
      queryAliases.some((a) => normS.includes(a) || (a.length >= 8 && normS.startsWith(a))) ||
      (queryTokens.length > 1 && queryTokens.every((t) => normS.includes(t))) ||
      (queryTokens.length >= 2 && seriesTokens.length >= 2 && calculateSignificantTokenOverlap(queryTokens, seriesTokens) >= 0.7);

    if (matchesSeries) {
      const real = resolveRealDownloadSources(slugTitle, undefined, undefined, {
        customElscioneFolders: dependencies?.customElscioneFolders,
        customLnoriSeries: dependencies?.customLnoriSeries,
      });
      if (real) {
        const displayTitle = slugTitle
          .split(" ")
          .map((w) => (w.length > 0 ? w[0].toUpperCase() + w.slice(1) : ""))
          .join(" ");

        const author = resolveAuthorForTitle(displayTitle, undefined, allSeeds);
        const coverUrl =
          resolveCoverForTitle(displayTitle, undefined, allSeeds) ||
          resolveCatalogCover(displayTitle) ||
          resolveCatalogCover(s.slug) ||
          generateFallbackCoverSvg(displayTitle, author);
        const knownSyn = findKnownSeriesSynopsis({ title: displayTitle, author });
        const synopsis =
          knownSyn ||
          synthesizeEngagingSynopsis(displayTitle, ["Light Novel", "Fantasy"]);

        const can = canonicalTitleKey(displayTitle);
        const seed = allSeeds.find(
          (s) =>
            normalizeTitleForMatch(s.title) === normS ||
            canonicalTitleKey(s.title) === can,
        );
        const volumeCount = resolveCatalogVolumeCount(displayTitle, seed?.titleRomaji, seed);

        addNovel({
          id: `lnori-${s.id}-${s.slug}`,
          title: displayTitle,
          author,
          coverUrl,
          synopsis,
          genres: ["Light Novel", "Fantasy"],
          score: 85,
          popularity: 5000,
          releaseDate: "2024-01-01",
          volumeCount,
          source: real.source,
          primarySource: real.primarySource,
          primaryUrl: real.primaryUrl,
          sourceUrls: real.sourceUrls,
          inLibrary: false,
          existingVolumes: 0,
        });
      }
    }
  }

  // 5. Ensure all novels have non-empty synopses and assign primary source
  const novelsWithSynopses = await ensureAllNovelsHaveSynopses(results, dependencies);

  // 6. Cross-check against Calibre
  if (dependencies?.skipCrossCheck) return novelsWithSynopses;
  return crossCheckNovelsWithCalibre(novelsWithSynopses, dependencies);
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
  let tab: DiscoverTab = "trending";
  if (params.tab === "new") {
    tab = "new";
  } else if (params.tab === "all") {
    tab = "all";
  }
  const sourceFilter: DiscoverSourceFilter = params.source || "all";
  const genreFilter = (params.genre || "").trim().toLowerCase();
  const statusFilter: DiscoverStatus = params.status || "all";
  const searchQuery = (params.q || "").trim().toLowerCase();
  const sortBy: DiscoverSort = params.sort || "popularity";
  const page = Math.max(1, params.page || 1);
  const pageSize = Math.max(1, Math.min(100, params.pageSize || 36));

  const needsFullCrossCheck =
    statusFilter === "available" ||
    statusFilter === "in_library" ||
    statusFilter === "incomplete" ||
    statusFilter === "missing_volumes";

  // 1. Fetch novels: Universal search across all catalogs if q is provided, otherwise active tab feed.
  // Always skip full-catalog cross-checking during initial fetch to eliminate redundant double-reconciliation
  // and ensure instant feed retrieval across all status filter modes.
  const fetchDeps: DiscoverDependencies = {
    ...dependencies,
    skipCrossCheck: true,
  };

  let allNovels: DiscoveredNovel[];
  if (searchQuery) {
    allNovels = await searchUniversalNovels(searchQuery, fetchDeps);
  } else {
    allNovels = await fetchDiscoverFeed(tab, fetchDeps);
  }

  // 2. Extract unique available genres from this feed
  const genreSet = new Set<string>();
  for (const n of allNovels) {
    for (const g of n.genres) {
      if (g) genreSet.add(g);
    }
  }
  const availableGenres =
    genreSet.size > 0
      ? Array.from(genreSet).sort()
      : [
          "Action",
          "Adventure",
          "Comedy",
          "Drama",
          "Fantasy",
          "Isekai",
          "Psychological",
          "Romance",
          "Sci-Fi",
          "Slice of Life",
        ];

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
  if (needsFullCrossCheck) {
    // If not already cross-checked, run cooperative inverted-index cross-check over the filtered candidate set
    filtered = await crossCheckNovelsWithCalibreAsync(filtered, dependencies, 200);
    if (statusFilter === "available") {
      filtered = filtered.filter((n) => !n.inLibrary);
    } else if (statusFilter === "in_library") {
      filtered = filtered.filter((n) => n.inLibrary);
    } else if (statusFilter === "incomplete" || statusFilter === "missing_volumes") {
      filtered = filtered.filter(
        (n) =>
          n.inLibrary &&
          n.existingVolumes > 0 &&
          n.sourceStatus === "verified" &&
          n.missingVolumeCount !== undefined &&
          n.missingVolumeCount > 0,
      );
    }
  }

  // 6. Sort
  if (searchQuery) {
    const normQ = normalizeTitleForMatch(searchQuery);
    const qTokens = normQ.split(/\s+/).filter(Boolean);

    const getRelevance = (n: DiscoveredNovel): number => {
      const normT = normalizeTitleForMatch(n.title);
      const normR = n.titleRomaji ? normalizeTitleForMatch(n.titleRomaji) : "";
      if (normT === normQ || normR === normQ) return 5000;
      if (normT.startsWith(normQ) || (normR && normR.startsWith(normQ))) return 2000;
      if (normT.includes(normQ) || (normR && normR.includes(normQ))) return 1000;
      if (qTokens.length > 1 && qTokens.every((t) => normT.includes(t) || (normR && normR.includes(t)))) return 800;
      if (n.synopsis.toLowerCase().includes(searchQuery)) return 200;
      return 50;
    };

    filtered.sort((a, b) => {
      if (sortBy === "score") {
        return b.score - a.score;
      }
      if (sortBy === "newest") {
        return b.releaseDate.localeCompare(a.releaseDate);
      }
      if (sortBy === "title_asc") {
        return a.title.localeCompare(b.title);
      }
      const relDiff = getRelevance(b) - getRelevance(a);
      if (relDiff !== 0) return relDiff;
      if (b.popularity !== a.popularity) return b.popularity - a.popularity;
      return b.score - a.score;
    });
  } else {
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
      if (sortBy === "title_asc") {
        return a.title.localeCompare(b.title);
      }
      return 0;
    });
  }

  // 7. Pagination
  const totalCount = filtered.length;
  const totalPages = Math.ceil(totalCount / pageSize) || 1;
  const clampedPage = totalCount > 0 ? Math.min(page, totalPages) : 1;
  const startIndex = (clampedPage - 1) * pageSize;
  const paginatedNovels = filtered.slice(startIndex, startIndex + pageSize);

  // 8. Reconcile with Calibre for page if unconstrained view (statusFilter === "all")
  const finalNovels = needsFullCrossCheck
    ? paginatedNovels
    : crossCheckNovelsWithCalibre(paginatedNovels, dependencies);

  return {
    success: true,
    tab,
    novels: finalNovels,
    count: totalCount,
    genres: availableGenres,
    sources: ["all", "lnori", "elscione"],
    page: clampedPage,
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
    const parsed = parseElscioneUrl(cleanUrl);
    if (parsed?.seriesTitle) {
      if (/[:?*"<>|/\\]/.test(parsed.seriesTitle)) {
        throw new Error(`Target Elscione folder contains invalid characters: ${parsed.seriesTitle}`);
      }
      if (!REAL_ELSCIONE_FOLDERS.includes(parsed.seriesTitle)) {
        throw new Error(`Target Elscione folder does not exist in catalog: ${parsed.seriesTitle}`);
      }
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

/**
 * Retrieves a single discovered novel by ID or title, cross-checked with Calibre
 * and returning complete volume audit data (ownedVolumeIndices, missingVolumeIndices, missingVolumeCount).
 */
export async function getDiscoverNovelById(
  novelId: string,
  dependencies?: DiscoverDependencies,
): Promise<DiscoveredNovel | null> {
  if (!novelId || typeof novelId !== "string" || !novelId.trim()) {
    return null;
  }
  const cleanId = novelId.trim();
  const normId = normalizeTitleForMatch(cleanId);
  const canId = canonicalTitleKey(cleanId);

  // 1. Search in trending/new seeds first
  const allSeeds = [
    ...(dependencies?.seedTrendingNovels ?? SEED_TRENDING_NOVELS),
    ...(dependencies?.seedNewNovels ?? SEED_NEW_NOVELS),
  ];

  let candidate: DiscoveredNovel | null = null;
  for (const s of allSeeds) {
    if (
      s.id === cleanId ||
      normalizeTitleForMatch(s.id) === normId ||
      canonicalTitleKey(s.id) === canId ||
      normalizeTitleForMatch(s.title) === normId ||
      canonicalTitleKey(s.title) === canId ||
      (s.titleRomaji &&
        (normalizeTitleForMatch(s.titleRomaji) === normId ||
          canonicalTitleKey(s.titleRomaji) === canId))
    ) {
      candidate = { ...s };
      break;
    }
  }

  // 2. If not found in seeds, check complete catalog
  if (!candidate) {
    const catalog = await buildCompleteCatalogNovels(dependencies);
    for (const n of catalog) {
      if (
        n.id === cleanId ||
        normalizeTitleForMatch(n.id) === normId ||
        canonicalTitleKey(n.id) === canId ||
        normalizeTitleForMatch(n.title) === normId ||
        canonicalTitleKey(n.title) === canId ||
        (n.titleRomaji &&
          (normalizeTitleForMatch(n.titleRomaji) === normId ||
            canonicalTitleKey(n.titleRomaji) === canId))
      ) {
        candidate = { ...n };
        break;
      }
    }
  }

  // 3. Fallback: universal search
  if (!candidate) {
    const searchResults = await searchUniversalNovels(cleanId, dependencies);
    if (searchResults.length > 0) {
      candidate = { ...searchResults[0] };
    }
  }

  if (!candidate) {
    return null;
  }

  // Ensure synopsis
  if (!candidate.synopsis || candidate.synopsis.length < 30) {
    const fallbackSyn = await resolveFallbackSynopsis(candidate, dependencies);
    if (fallbackSyn) {
      candidate.synopsis = fallbackSyn;
    }
  }

  // Preserve global catalog publication total
  candidate.catalogVolumeCount = candidate.catalogVolumeCount ?? candidate.volumeCount;

  // Resolve verified source inventories
  const { inventories, verifiedVolumes, verifiedVolumeCount, sourceStatus } =
    await resolveNovelSourceInventories(candidate, dependencies);

  candidate.sources = inventories;
  candidate.sourceInventories = Object.fromEntries(inventories.map((i) => [i.source, i]));
  candidate.sourceStatus = sourceStatus;

  if (sourceStatus === "verified" && verifiedVolumes.length > 0) {
    candidate.verifiedVolumes = verifiedVolumes;
    candidate.verifiedVolumeCount = verifiedVolumeCount;
    candidate.volumeCount = verifiedVolumeCount!;
  } else {
    candidate.verifiedVolumes = undefined;
    candidate.verifiedVolumeCount = undefined;
  }

  // Cross check with Calibre to guarantee exact volume audit
  const reconciled = crossCheckNovelsWithCalibre([candidate], dependencies);
  const result = reconciled[0] || candidate;
  return assignPrimarySource(result);
}

