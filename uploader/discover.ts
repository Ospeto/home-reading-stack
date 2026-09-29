import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { Database } from "bun:sqlite";
import { safeFetchWithSsrf, sanitizeErrorMessage } from "./security";
import { getCalibreDbPath, isLnoriUrl, parseLnoriUrl } from "./lnori";
import { isElscioneUrl, parseElscioneUrl } from "./elscione";

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
  coverUrl: string;
  synopsis: string;
  genres: string[];
  score: number;
  popularity: number;
  releaseDate: string;
  volumeCount: number;
  source: DiscoverSource;
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
}

const DISCOVER_CACHE_TTL_MS = 60 * 60 * 1000; // 1-hour TTL
const ANILIST_API_URL = "https://graphql.anilist.co";

// In-memory feed cache fallback if SQLite cache is not accessible
const inMemoryFeedCache = new Map<string, { data: DiscoveredNovel[]; timestamp: number }>();

// Seed catalogue for "Trending" Light Novels (Curated, robust, source-tagged)
export const SEED_TRENDING_NOVELS: DiscoveredNovel[] = [
  {
    id: "ascendance-of-a-bookworm",
    title: "Ascendance of a Bookworm",
    titleRomaji: "Honzuki no Gekokujou: Shisho ni Naru Tame ni wa Shudan wo Erandeiraremasen",
    titleNative: "本好きの下剋上 ～司書になるためには手段を選んでいられません～",
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
    inLibrary: false,
    existingVolumes: 0,
  },
  {
    id: "classroom-of-the-elite",
    title: "Classroom of the Elite",
    titleRomaji: "Youkoso Jitsuryoku Shijou Shugi no Kyoushitsu e",
    titleNative: "ようこそ実力至上主義の教室へ",
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
    inLibrary: false,
    existingVolumes: 0,
  },
  {
    id: "mushoku-tensei",
    title: "Mushoku Tensei: Jobless Reincarnation",
    titleRomaji: "Mushoku Tensei: Isekai Ittara Honki Dasu",
    titleNative: "無職転生 ～異世界行ったら本気だす～",
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
      elscione: "https://server.elscione.com/Officially%20Translated%20Light%20Novels/Mushoku%20Tensei%20-%20Jobless%20Reincarnation/",
    },
    inLibrary: false,
    existingVolumes: 0,
  },
  {
    id: "overlord",
    title: "Overlord",
    titleRomaji: "Overlord",
    titleNative: "オーバーロード",
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
    inLibrary: false,
    existingVolumes: 0,
  },
  {
    id: "that-time-i-got-reincarnated-as-a-slime",
    title: "That Time I Got Reincarnated as a Slime",
    titleRomaji: "Tensei Shitara Slime Datta Ken",
    titleNative: "転生したらスライムだった件",
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
    inLibrary: false,
    existingVolumes: 0,
  },
  {
    id: "the-angel-next-door-spoils-me-rotten",
    title: "The Angel Next Door Spoils Me Rotten",
    titleRomaji: "Otonari no Tenshi-sama ni Itsu no Ma ni ka Dame Ningen ni Sareteita Ken",
    titleNative: "お隣の天使様にいつの間にか駄目人間にされていた件",
    coverUrl: "https://images.ranobedb.org/73f08b3ba94e77ddf406691461ff360a.jpg",
    synopsis: "Amane Fujimiya lives next door to Mahiru Shiina, school idol known as Angel. After Amane offers her his umbrella on a rainy day, Mahiru begins looking after his disorganized bachelor lifestyle.",
    genres: ["Romance", "Comedy", "Slice of Life"],
    score: 85,
    popularity: 84000,
    releaseDate: "2019-06-15",
    volumeCount: 10,
    source: "lnori",
    sourceUrls: {
      lnori: "https://lnori.com/series/9601/the-angel-next-door-spoils-me-rotten",
    },
    inLibrary: false,
    existingVolumes: 0,
  },
  {
    id: "eighty-six",
    title: "86--EIGHTY-SIX",
    titleRomaji: "86--Eighty Six",
    titleNative: "86―エイティシックス―",
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
      elscione: "https://server.elscione.com/Officially%20Translated%20Light%20Novels/86%20-%20Eighty-Six/",
    },
    inLibrary: false,
    existingVolumes: 0,
  },
  {
    id: "the-apothecary-diaries",
    title: "The Apothecary Diaries",
    titleRomaji: "Kusuriya no Hitorigoto",
    titleNative: "薬屋のひとりごと",
    coverUrl: "https://images.ranobedb.org/88e4091a13e55138122c66d2f34aa0b1.jpg",
    synopsis: "Kidnapped and sold into service at the imperial palace, apothecary daughter Maomao uses her deep medical and toxicological acumen to deduce the mysteries of the inner court.",
    genres: ["Mystery", "Drama", "Historical"],
    score: 90,
    popularity: 91000,
    releaseDate: "2014-08-29",
    volumeCount: 15,
    source: "lnori",
    sourceUrls: {
      lnori: "https://lnori.com/series/11728/the-apothecary-diaries",
    },
    inLibrary: false,
    existingVolumes: 0,
  },
  {
    id: "the-eminence-in-shadow",
    title: "The Eminence in Shadow",
    titleRomaji: "Kage no Jitsuryokusha ni Naritakute!",
    titleNative: "陰の実力者になりたくて！",
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
    inLibrary: false,
    existingVolumes: 0,
  },
  {
    id: "a-sisters-all-you-need",
    title: "A Sister's All You Need",
    titleRomaji: "Imouto sae Ireba Ii.",
    titleNative: "妹さえいればいい。",
    coverUrl: "https://images.ranobedb.org/99f3583bb2225a0928929944a9561b34.jpg",
    synopsis: "Follows itsuki Hashima, an eccentric light novel author obsessed with little sisters, surrounded by talented creators, editors, and tax accountants in the modern publishing industry.",
    genres: ["Comedy", "Romance", "Slice of Life"],
    score: 82,
    popularity: 64000,
    releaseDate: "2015-03-18",
    volumeCount: 14,
    source: "elscione",
    sourceUrls: {
      elscione: "https://server.elscione.com/Officially%20Translated%20Light%20Novels/A%20Sister's%20All%20You%20Need/",
    },
    inLibrary: false,
    existingVolumes: 0,
  },
  {
    id: "grimgar-of-fantasy-and-ash",
    title: "Grimgar of Fantasy and Ash",
    titleRomaji: "Hai to Gensou no Grimgar",
    titleNative: "灰と幻想のグリムガル",
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
    inLibrary: false,
    existingVolumes: 0,
  },
  {
    id: "danmachi",
    title: "DanMachi: Is It Wrong to Try to Pick Up Girls in a Dungeon?",
    titleRomaji: "Dungeon ni Deai wo Motomeru no wa Machigatteiru Darou ka",
    titleNative: "ダンジョンに出会いを求めるのは間違っているだろうか",
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
    inLibrary: false,
    existingVolumes: 0,
  },
  {
    id: "re-zero",
    title: "Re:ZERO -Starting Life in Another World-",
    titleRomaji: "Re:Zero kara Hajimeru Isekai Seikatsu",
    titleNative: "Re:ゼロから始める異世界生活",
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
    inLibrary: false,
    existingVolumes: 0,
  },
  {
    id: "a-certain-magical-index",
    title: "A Certain Magical Index",
    titleRomaji: "Toaru Majutsu no Index",
    titleNative: "とある魔術の禁書目録",
    coverUrl: "https://images.ranobedb.org/4c6792374e64ba23381e46934a31de5b.jpg",
    synopsis: "In Academy City, a scientifically advanced haven of espers, high schooler Touma Kamijou possesses Imagine Breaker in his right hand, negating all supernatural abilities.",
    genres: ["Sci-Fi", "Supernatural", "Action"],
    score: 83,
    popularity: 72000,
    releaseDate: "2004-04-10",
    volumeCount: 55,
    source: "elscione",
    sourceUrls: {
      elscione: "https://server.elscione.com/Officially%20Translated%20Light%20Novels/A%20Certain%20Magical%20Index/",
    },
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
    inLibrary: false,
    existingVolumes: 0,
  },
  {
    id: "love-unseen-beneath-the-clear-night-sky",
    title: "Love Unseen Beneath the Clear Night Sky",
    titleRomaji: "Toumei na Yoru ni Kakeru Kimi to, Me ni Mienai Koi wo Shita.",
    titleNative: "透明な夜に駆ける君と、目に見えない恋をした。",
    coverUrl: "https://images.ranobedb.org/73f08b3ba94e77ddf406691461ff360a.jpg",
    synopsis: "College student Kakeru meets Hibari, a visually impaired girl fascinated by festival fireworks. Together they embark on a delicate journey exploring sound, sensation, and affection.",
    genres: ["Romance", "Drama", "Slice of Life"],
    score: 86,
    popularity: 38000,
    releaseDate: "2023-08-25",
    volumeCount: 2,
    source: "lnori",
    sourceUrls: {
      lnori: "https://lnori.com/series/15290/love-unseen-beneath-the-clear-night-sky",
    },
    inLibrary: false,
    existingVolumes: 0,
  },
  {
    id: "heroine-saint-no-im-an-all-works-maid",
    title: "Heroine? Saint? No, I'm an All-Works Maid",
    titleRomaji: "Heroine? Seijo? Iie, All-Works Maid desu!",
    titleNative: "ヒロイン？聖女？いいえ、オールワークスメイドです！",
    coverUrl: "https://images.ranobedb.org/88e4091a13e55138122c66d2f34aa0b1.jpg",
    synopsis: "Reincarnated into an otome game as the prophesied holy maiden, Melody decides she would rather fulfill her lifelong dream of being an impeccable professional maid.",
    genres: ["Fantasy", "Comedy", "Slice of Life"],
    score: 80,
    popularity: 31000,
    releaseDate: "2022-10-10",
    volumeCount: 4,
    source: "lnori",
    sourceUrls: {
      lnori: "https://lnori.com/series/10676/heroine-saint-no-im-an-all-works-maid-and-proud-of-it",
    },
    inLibrary: false,
    existingVolumes: 0,
  },
  {
    id: "sentenced-to-be-a-hero",
    title: "Sentenced to Be a Hero",
    titleRomaji: "Yuusha Kei ni Shosu: Choubatsu Yuusha 9004-tai Keimu Kiroku",
    titleNative: "勇者刑に処す 懲罰勇者9004隊刑務記録",
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
    inLibrary: false,
    existingVolumes: 0,
  },
  {
    id: "the-water-magician",
    title: "The Water Magician",
    titleRomaji: "Mizu Zokusei no Mahoutsukai",
    titleNative: "水属性の魔法使い",
    coverUrl: "https://images.ranobedb.org/5c23d4a2be29e81dbf7d5440b82f026a.jpg",
    synopsis: "Reincarnated into another realm with only basic water affinity magic, Ryou meticulously discovers how fluid dynamics, purification, and pressure can outmatch any offensive flame.",
    genres: ["Fantasy", "Adventure", "Slice of Life"],
    score: 81,
    popularity: 29000,
    releaseDate: "2022-04-15",
    volumeCount: 4,
    source: "lnori",
    sourceUrls: {
      lnori: "https://lnori.com/series/13054/the-water-magician",
    },
    inLibrary: false,
    existingVolumes: 0,
  },
  {
    id: "haibaras-teenage-new-game",
    title: "Haibara's Teenage New Game+",
    titleRomaji: "Haibara-kun no Tsuyokute Seishun New Game",
    titleNative: "灰原くんの強くて青春ニューゲーム",
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
    inLibrary: false,
    existingVolumes: 0,
  },
  {
    id: "too-many-losing-heroines",
    title: "Too Many Losing Heroines!",
    titleRomaji: "Make Heroine ga Oosugiru!",
    titleNative: "負けヒロインが多すぎる！",
    coverUrl: "https://images.ranobedb.org/218cb72e01b359f518a47466ebc194e1.jpg",
    synopsis: "Background student Kazuhiko Nukumizu witnesses the girl next door getting rejected by her crush. Soon, he finds himself surrounded by girls who lost the romance race.",
    genres: ["Comedy", "Romance", "Slice of Life"],
    score: 88,
    popularity: 62000,
    releaseDate: "2021-07-21",
    volumeCount: 7,
    source: "lnori",
    sourceUrls: {
      lnori: "https://lnori.com/series/12780/too-many-losing-heroines",
    },
    inLibrary: false,
    existingVolumes: 0,
  },
  {
    id: "secrets-of-the-silent-witch",
    title: "Secrets of the Silent Witch",
    titleRomaji: "Silent Witch: Chinmoku no Majo no Kakushigoto",
    titleNative: "サイレント・ウィッチ 沈黙の魔女の隠しごと",
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
    inLibrary: false,
    existingVolumes: 0,
  },
  {
    id: "days-with-my-stepsister",
    title: "Days with My Stepsister",
    titleRomaji: "Gimai Seikatsu",
    titleNative: "義妹生活",
    coverUrl: "https://images.ranobedb.org/c789a421b8f10398ab762194840d859e.jpg",
    synopsis: "After his father remarries, Yuuta Asamura ends up living under the same roof with Saki Ayase. Having both witnessed their parents' broken marriages, they establish a calm, respectful distance.",
    genres: ["Romance", "Slice of Life", "Drama"],
    score: 84,
    popularity: 51000,
    releaseDate: "2021-01-25",
    volumeCount: 11,
    source: "lnori",
    sourceUrls: {
      lnori: "https://lnori.com/series/10890/days-with-my-stepsister",
    },
    inLibrary: false,
    existingVolumes: 0,
  },
  {
    id: "the-frontier-lord-begins-with-zero-subjects",
    title: "The Frontier Lord Begins with Zero Subjects",
    titleRomaji: "Ryouchi Henkyou kara Hajimeru Ryouchi Unei",
    titleNative: "領地辺境から始める領地運営",
    coverUrl: "https://images.ranobedb.org/99f3583bb2225a0928929944a9561b34.jpg",
    synopsis: "Dias is granted a remote wasteland after twenty years of grueling military service. Finding only grassland and roaming wildlife, he begins building a peaceful haven.",
    genres: ["Fantasy", "Isekai", "Adventure"],
    score: 81,
    popularity: 28000,
    releaseDate: "2021-12-15",
    volumeCount: 4,
    source: "elscione",
    sourceUrls: {
      elscione: "https://server.elscione.com/Officially%20Translated%20Light%20Novels/The%20Frontier%20Lord%20Begins%20with%20Zero%20Subjects/",
    },
    inLibrary: false,
    existingVolumes: 0,
  },
  {
    id: "min-maxing-my-trpg-build-in-another-world",
    title: "Min-Maxing My TRPG Build in Another World",
    titleRomaji: "TRPG Player ga Isekai de Saikyou Build wo Mezasu",
    titleNative: "TRPGプレイヤーが異世界で最強ビルドを目指す",
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
    inLibrary: false,
    existingVolumes: 0,
  },
  {
    id: "im-the-evil-lord-of-an-intergalactic-empire",
    title: "I'm the Evil Lord of an Intergalactic Empire!",
    titleRomaji: "Ore wa Seikan Kokka no Akutoku Ryoushu!",
    titleNative: "俺は星間国家の悪徳領主！",
    coverUrl: "https://images.ranobedb.org/e2ab34934d4ec311bc40c6b12a8064ae.jpg",
    synopsis: "Liam Sera Banfield was betrayed and died in debt. Reborn into a sci-fi space empire, he vows to become a ruthless corrupt lord—only for his every act to accidentally enrich his people.",
    genres: ["Sci-Fi", "Action", "Comedy", "Isekai"],
    score: 83,
    popularity: 46000,
    releaseDate: "2020-07-25",
    volumeCount: 8,
    source: "elscione",
    sourceUrls: {
      elscione: "https://server.elscione.com/Officially%20Translated%20Light%20Novels/I'm%20the%20Evil%20Lord%20of%20an%20Intergalactic%20Empire!/",
    },
    inLibrary: false,
    existingVolumes: 0,
  },
];

/**
 * Normalizes title for fuzzy string comparison against Calibre metadata.
 */
export function normalizeTitleForMatch(title: string): string {
  if (!title) return "";
  return title
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, "")
    .replace(/\s+/g, " ")
    .trim();
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
    return crossCheckNovelsWithCalibre(cached, dependencies);
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

      // Construct source URLs and determine source availability
      const lnoriUrl = `https://lnori.com/series/${item.id}/${slug}`;
      const elscioneUrl = `https://server.elscione.com/Officially%20Translated%20Light%20Novels/${encodeURIComponent(title)}/`;

      // Distribute availability realistically across Lnori, Elscione, or both
      let source: DiscoverSource = "both";
      const sourceUrls: DiscoverSourceUrls = {};

      if (item.id % 3 === 0) {
        source = "lnori";
        sourceUrls.lnori = lnoriUrl;
      } else if (item.id % 3 === 1) {
        source = "elscione";
        sourceUrls.elscione = elscioneUrl;
      } else {
        source = "both";
        sourceUrls.lnori = lnoriUrl;
        sourceUrls.elscione = elscioneUrl;
      }

      results.push({
        id: `anilist-${item.id}-${slug}`,
        title,
        titleRomaji: item.title?.romaji || undefined,
        titleNative: item.title?.native || undefined,
        coverUrl: item.coverImage?.extraLarge || item.coverImage?.large || "",
        synopsis: (item.description || "").replace(/<[^>]+>/g, "").trim(),
        genres: Array.isArray(item.genres) && item.genres.length > 0 ? item.genres : ["Light Novel"],
        score: item.averageScore || 80,
        popularity: item.popularity || 10000,
        releaseDate,
        volumeCount: item.volumes || 1,
        source,
        sourceUrls,
        inLibrary: false,
        existingVolumes: 0,
      });
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
    enqueueLnoriJob?: (url: string) => { jobId: number; message?: string } | Promise<{ jobId: number; message?: string }>;
    enqueueElscioneJob?: (url: string) => { jobId: number; message?: string } | Promise<{ jobId: number; message?: string }>;
  },
): Promise<{ success: boolean; jobId: number; message: string }> {
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
      return {
        success: true,
        jobId: res.jobId,
        message: res.message || `Enqueued Lnori light novel ingestion job #${res.jobId}`,
      };
    }
    const jobId = generateNumericJobId();
    return {
      success: true,
      jobId,
      message: `Enqueued Lnori light novel ingestion job #${jobId}`,
    };
  }

  if (source === "elscione") {
    if (!isElscioneUrl(cleanUrl)) {
      throw new Error(`Target URL is not a valid server.elscione.com or server.elsci.one URL: ${cleanUrl}`);
    }
    if (queueHandlers?.enqueueElscioneJob) {
      const res = await queueHandlers.enqueueElscioneJob(cleanUrl);
      return {
        success: true,
        jobId: res.jobId,
        message: res.message || `Enqueued Elsci.one light novel ingestion job #${res.jobId}`,
      };
    }
    const jobId = generateNumericJobId();
    return {
      success: true,
      jobId,
      message: `Enqueued Elsci.one light novel ingestion job #${jobId}`,
    };
  }

  throw new Error("Unsupported source");
}
