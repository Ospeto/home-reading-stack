/**
 * The single volume model shared by Calibre reconciliation (`series_index`), the Discover
 * matching engine and the ingest duplicate gate (`isVolumeAlreadyInCalibre`).
 *
 * Why it exists: three volume models used to disagree.
 *  1. Calibre stores a flat float `series_index` (Bookworm lives at 1.1 … 1.9, Classroom of
 *     the Elite Year 1 at 1.01 … 1.11 and Year 2 at 2.01 … 2.09).
 *  2. Discover computed a "canonical" global integer with hard-coded Bookworm part offsets.
 *  3. The ingest gate compared `ROUND(series_index, 2)` with the incoming integer, so a
 *     library volume stored at 1.09 never matched an incoming "Volume 9".
 *
 * The captain's decision is a per-part / per-season **namespace** model, never one flat
 * global volume number. A volume is therefore a key:
 *
 *   { namespace: "main"  , volume: 9 }   // plain "Vol. 9" / "Year 1 Vol. 9"
 *   { namespace: "year:2", volume: 9 }   // "Classroom of the Elite: Year 2 Vol. 9"
 *   { namespace: "part:5", volume: 8 }   // "Ascendance of a Bookworm: Part 5 Volume 8"
 *   { namespace: "fanbook", volume: 2 }  // qualifier sequences never touch the mainline
 *
 * A series turns keys into flat catalogue numbers through a `SeriesVolumeModel`: an ordered
 * list of segments, each with its own namespace and size. That is what lets a flat source
 * inventory (Bookworm publishes 1..33) and a namespaced library agree.
 */
import { extractVolumeNumber, parseMultiPartVolume } from "./scraper";

export const MAIN_VOLUME_NAMESPACE = "main";

export interface VolumeKey {
  /** "main", "year:2", "part:5", "season:3", "fanbook", "art-book", … */
  namespace: string;
  /** Volume number inside that namespace (fractional volumes such as 4.5 are preserved). */
  volume: number;
}

export interface VolumeKeySource {
  title?: string | null;
  series?: string | null;
  seriesIndex?: number | string | null;
}

export interface VolumeSegment {
  namespace: string;
  size: number;
}

export interface SeriesVolumeModel {
  segments: VolumeSegment[];
}

/** Namespaces that read as the start of the base series (an unmarked "Vol. 9" is the same book). */
const BASE_NAMESPACES = new Set<string>([
  MAIN_VOLUME_NAMESPACE,
  "year:1",
  "season:1",
  "part:1",
]);

/**
 * Auxiliary sequences: they carry volume numbers that must never be counted as mainline
 * volumes (a 1-volume art book cannot make 10 volumes look owned, and a fanbook is not
 * "Volume 2" of the story).
 */
const AUXILIARY_NAMESPACES = new Set<string>([
  "art-book",
  "fanbook",
  "guidebook",
  "short-story",
  "side-story",
  "spinoff",
  "anthology",
  "omnibus",
]);

const QUALIFIER_NAMESPACES: Array<{ pattern: RegExp; namespace: string }> = [
  { pattern: /\bshort story collections?\b/i, namespace: "short-story" },
  { pattern: /\bside stor(?:y|ies)\b/i, namespace: "side-story" },
  { pattern: /\bafter stor(?:y|ies)\b/i, namespace: "side-story" },
  { pattern: /\bfan ?book\b/i, namespace: "fanbook" },
  { pattern: /\bofficial (?:guide ?book|companion|data ?book)\b/i, namespace: "guidebook" },
  { pattern: /\bsettei ?shu\b|\bsettings? (?:book|collection)\b/i, namespace: "guidebook" },
  { pattern: /\bart ?book\b|\bartbook\b/i, namespace: "art-book" },
  { pattern: /\billustrations?\b|\billustrated (?:guide|collection)\b/i, namespace: "art-book" },
  { pattern: /\bspin-?off\b/i, namespace: "spinoff" },
  { pattern: /\bgaiden\b/i, namespace: "spinoff" },
  { pattern: /\banthology\b/i, namespace: "anthology" },
  { pattern: /\bomnibus\b|\bbox ?set\b|\bbundle\b/i, namespace: "omnibus" },
];

const VOLUME_EPSILON = 0.001;

const ROMAN_VALUES: Record<string, number> = {
  i: 1,
  ii: 2,
  iii: 3,
  iv: 4,
  v: 5,
  vi: 6,
  vii: 7,
  viii: 8,
  ix: 9,
  x: 10,
  xi: 11,
  xii: 12,
  xiii: 13,
  xiv: 14,
  xv: 15,
  xvi: 16,
  xvii: 17,
  xviii: 18,
  xix: 19,
  xx: 20,
};

const BURMESE_DIGITS: Record<string, string> = {
  "၀": "0",
  "၁": "1",
  "၂": "2",
  "၃": "3",
  "၄": "4",
  "၅": "5",
  "၆": "6",
  "၇": "7",
  "၈": "8",
  "၉": "9",
};

function parseBurmeseDigits(raw: string): number | null {
  if (!/^[၀-၉]+$/.test(raw)) return null;
  const ascii = raw
    .split("")
    .map((c) => BURMESE_DIGITS[c] ?? "")
    .join("");
  const num = parseInt(ascii, 10);
  return Number.isNaN(num) ? null : num;
}

function toNumber(raw: string): number | null {
  const trimmed = String(raw).trim();
  if (/^[0-9]+(?:\.[0-9]+)?$/.test(trimmed)) {
    const num = parseFloat(trimmed);
    return Number.isNaN(num) ? null : num;
  }
  const roman = ROMAN_VALUES[trimmed.toLowerCase()];
  if (roman !== undefined) return roman;
  return parseBurmeseDigits(trimmed);
}

function normalizeNamespace(raw: string, value: number): string {
  return `${raw.toLowerCase().replace(/[^a-z0-9]+/g, "-")}:${value}`;
}

/**
 * Reads the part number from a title ("Part 3", "Part III", "အပိုင်း ၂"). `null` when absent.
 */
export function parseVolumePart(title?: string | null): number | null {
  if (!title) return null;
  const s = String(title);
  const match =
    s.match(/(?:^|[\s_\-\[(（［{,:])(?:part|pt|အပိုင်း)\.?[\s_\-]*(\d{1,2})\b/i) ||
    s.match(/(?:^|[\s_\-\[(（［{,:\[])(?:part|pt|အပိုင်း)\.?[\s_\-]*([ivx]{1,4})\b/i);
  if (!match || !match[1]) return null;
  const num = toNumber(match[1]);
  return num !== null && num > 0 ? num : null;
}

/**
 * Resolves the namespace a title belongs to. Returns `main` when the title carries no
 * sub-series marker at all.
 *
 * A bare "Part I/II" subtitle does NOT open a part namespace: "Overlord, Vol. 15: The Half-Elf
 * Demigod Part I" is mainline volume 15. A part only names a segment when it precedes the
 * volume marker ("Part 5 Volume 8") or when the series is a known multi-part catalogue.
 */
export function parseVolumeNamespace(title?: string | null, seriesName?: string | null): string {
  if (!title) return MAIN_VOLUME_NAMESPACE;
  const s = String(title);

  const seasonal =
    s.match(/\b(?:year|season)\s*(\d{1,2})\b/i) || s.match(/\b(?:year|season)\s*([ivx]{1,4})\b/i);
  if (seasonal && seasonal[1]) {
    const label = /year/i.test(seasonal[0]) ? "year" : "season";
    const num = toNumber(seasonal[1]);
    if (num !== null && num > 0) return normalizeNamespace(label, num);
  }

  const multipart = parseMultiPartVolume(s);
  if (multipart && multipart.part > 0) {
    return normalizeNamespace("part", multipart.part);
  }
  const part = parseVolumePart(s);
  if (part !== null && part > 0) {
    // Part-after-volume subtitles (Overlord "... Part I") stay mainline; known multi-part
    // catalogues (Bookworm) keep their part namespace even when the shape is unusual.
    if (knownSeriesModel([s, seriesName || ""].join(" ")) || partPrecedesVolume(s)) {
      return normalizeNamespace("part", part);
    }
  }

  for (const q of QUALIFIER_NAMESPACES) {
    if (q.pattern.test(s)) return q.namespace;
  }

  return MAIN_VOLUME_NAMESPACE;
}

/** True when a "Part N" marker appears before the first volume marker in the title. */
function partPrecedesVolume(title: string): boolean {
  const partMatch = title.match(/\b(?:part|pt|အပိုင်း)\.?[\s_\-]*([0-9]+|[ivx]+|[၀-၉]+)\b/i);
  const volMatch = title.match(/\b(?:vol(?:ume)?|book|bk)\.?[\s_\-]*([0-9]+(?:\.[0-9]+)?|[ivx]+|[၀-၉]+)\b/i);
  if (!partMatch || !volMatch) return false;
  return (partMatch.index ?? 0) < (volMatch.index ?? 0);
}

export function isBaseNamespace(namespace: string): boolean {
  return BASE_NAMESPACES.has(namespace);
}

export function isAuxiliaryNamespace(namespace: string): boolean {
  return AUXILIARY_NAMESPACES.has(namespace);
}

function namespaceOrder(namespace: string): [number, number, string] {
  // base catalogue first, then its own part sequences (they extend the base line), then
  // year/season catalogues that restart their numbering, then auxiliary sequences
  if (isBaseNamespace(namespace)) return [0, 0, namespace];
  if (isAuxiliaryNamespace(namespace)) return [3, 0, namespace];
  const match = namespace.match(/^(year|season|part):(\d+(?:\.\d+)?)$/);
  if (match) {
    const group = match[1] === "part" ? 1 : 2;
    return [group, parseFloat(match[2]), namespace];
  }
  return [4, 0, namespace];
}

function compareNamespaces(a: string, b: string): number {
  const [ga, oa, na] = namespaceOrder(a);
  const [gb, ob, nb] = namespaceOrder(b);
  if (ga !== gb) return ga - gb;
  if (oa !== ob) return oa - ob;
  return na.localeCompare(nb);
}

export function formatVolumeNumber(volume: number): string {
  return Number.isInteger(volume) ? String(volume) : String(Number(volume.toFixed(2)));
}

export function encodeVolumeKey(key: VolumeKey): string {
  return `${key.namespace}:${formatVolumeNumber(key.volume)}`;
}

/**
 * Resolves the volume key for a title. The volume number is taken *within* the namespace:
 * "Part 5 Volume 8" is `{part:5, 8}`, never global 29 — the model projects it later.
 */
export function resolveCanonicalVolumeKey(
  title: string,
  seriesName?: string,
): VolumeKey | null {
  if (!title) return null;
  const raw = String(title);
  const normalized = raw.replace(/[-_]+/g, " ");

  const namespace = parseVolumeNamespace(raw, seriesName);

  const volume = extractVolumeNumber(raw) ?? extractVolumeNumber(normalized) ?? null;
  if (volume === null || Number.isNaN(volume)) return null;
  void seriesName;
  return { namespace, volume };
}

/**
 * Resolves the volume key for a Calibre row: the title wins, `series_index` is the fallback
 * for rows whose title carries no volume marker (preserving fractional indices such as 4.5
 * instead of rounding them away).
 */
export function resolveCalibreVolumeKey(row: VolumeKeySource): VolumeKey | null {
  const titleKey = row.title ? resolveCanonicalVolumeKey(String(row.title), row.series ?? undefined) : null;
  if (titleKey) return titleKey;

  const rawIndex = row.seriesIndex;
  if (rawIndex === undefined || rawIndex === null || rawIndex === "") return null;
  const index = Number(rawIndex);
  if (Number.isNaN(index) || index < 0) return null;
  return { namespace: MAIN_VOLUME_NAMESPACE, volume: index };
}

/**
 * Expands an omnibus/bundle range ("Vol. 1-3") into the volumes it covers.
 */
export function parseVolumeRange(title?: string | null): number[] | null {
  if (!title) return null;
  const match = String(title).match(
    /\bvol(?:ume)?s?\.?\s*0*(\d+(?:\.\d+)?)\s*(?:-|–|—|~|to)\s*0*(\d+(?:\.\d+)?)\b/i,
  );
  if (!match) return null;
  const start = parseFloat(match[1]);
  const end = parseFloat(match[2]);
  if (Number.isNaN(start) || Number.isNaN(end) || end < start) return null;
  if (!Number.isInteger(start) || !Number.isInteger(end) || end - start > 40) return null;
  const volumes: number[] = [];
  for (let v = start; v <= end; v++) volumes.push(v);
  return volumes;
}

/**
 * All volume keys a Calibre row represents. An omnibus/bundle covers every volume in its
 * range ("Vol. 1-3 Bundle" -> 1, 2, 3) instead of collapsing onto volume 1.
 */
export function resolveCalibreVolumeKeys(row: VolumeKeySource): VolumeKey[] {
  const base = resolveCalibreVolumeKey(row);
  const range = parseVolumeRange(row.title);
  if (!base) {
    // A bundle with no parseable volume still owns its range, in the omnibus namespace.
    return range ? range.map((volume) => ({ namespace: "omnibus", volume })) : [];
  }
  if (!range || base.namespace === "omnibus") {
    return range ? range.map((volume) => ({ namespace: "omnibus", volume })) : [base];
  }
  return [base, ...range.map((volume) => ({ namespace: "omnibus", volume }))];
}

/**
 * Known catalogue shapes for series whose parts are published as flat numbering.
 * Bookworm: Part 1 (3), Part 2 (4), Part 3 (5), Part 4 (9), Part 5 (12) = 33 volumes.
 */
const KNOWN_SERIES_MODELS: Array<{ pattern: RegExp; segments: VolumeSegment[] }> = [
  {
    pattern: /ascendance[\s_\-]*of[\s_\-]*a[\s_\-]*bookworm|honzuki/i,
    segments: [
      { namespace: "part:1", size: 3 },
      { namespace: "part:2", size: 4 },
      { namespace: "part:3", size: 5 },
      { namespace: "part:4", size: 9 },
      { namespace: "part:5", size: 12 },
    ],
  },
];

/** Backwards-compatible constants (kept for callers and tests that reason in offsets). */
export const BOOKWORM_PART_OFFSETS = [0, 3, 7, 12, 21];
export const BOOKWORM_PART_VOLUMES = [3, 4, 5, 9, 12];

export function knownSeriesModel(text?: string | null): SeriesVolumeModel | null {
  if (!text) return null;
  for (const entry of KNOWN_SERIES_MODELS) {
    if (entry.pattern.test(text)) {
      return { segments: entry.segments.map((s) => ({ ...s })) };
    }
  }
  return null;
}

export function totalVolumeCount(model: SeriesVolumeModel): number {
  return model.segments
    .filter((s) => !isAuxiliaryNamespace(s.namespace))
    .reduce((sum, s) => sum + s.size, 0);
}

/**
 * Orders, merges and sizes the segments of a derived model.
 * Base namespaces (main / year:1 / season:1 / part:1) always collapse into ONE leading
 * segment so a Part-1 volume and a plain volume share the same slot.
 */
function normalizeSegments(raw: Array<{ namespace: string; size: number }>): VolumeSegment[] {
  const baseSize = raw
    .filter((s) => isBaseNamespace(s.namespace))
    .reduce((max, s) => Math.max(max, s.size), 0);
  const others = raw.filter((s) => !isBaseNamespace(s.namespace));
  others.sort((a, b) => compareNamespaces(a.namespace, b.namespace));
  const segments: VolumeSegment[] = [];
  if (baseSize > 0) segments.push({ namespace: MAIN_VOLUME_NAMESPACE, size: baseSize });
  for (const s of others) segments.push({ namespace: s.namespace, size: s.size });
  return segments;
}

/**
 * Builds the model for a series from its Calibre rows (and/or a known catalogue override).
 * `sizeHints` lets a caller (a verified inventory) declare the real size of a namespace.
 */
export function buildSeriesVolumeModel(
  rows: VolumeKeySource[],
  options?: {
    seriesText?: string | null;
    sizeHints?: Record<string, number>;
    totalHint?: number;
  },
): SeriesVolumeModel {
  const known = knownSeriesModel(
    [options?.seriesText || "", ...rows.map((r) => `${r.series || ""} ${r.title || ""}`)].join(" "),
  );

  const sizes = new Map<string, number>();
  const addSize = (namespace: string, size: number) => {
    const key = isBaseNamespace(namespace) ? MAIN_VOLUME_NAMESPACE : namespace;
    sizes.set(key, Math.max(sizes.get(key) ?? 0, size));
  };

  if (known) {
    for (const seg of known.segments) addSize(seg.namespace, seg.size);
  }

  for (const row of rows) {
    const key = resolveCalibreVolumeKey(row);
    if (key) addSize(key.namespace, Math.ceil(key.volume));
  }

  if (options?.sizeHints) {
    for (const [namespace, size] of Object.entries(options.sizeHints)) {
      if (size > 0) addSize(namespace, size);
    }
  }

  let model: SeriesVolumeModel = { segments: normalizeSegments(Array.from(sizes, ([namespace, size]) => ({ namespace, size }))) };

  if (options?.totalHint && options.totalHint > 0) {
    model = alignModelToFlatCount(model, options.totalHint);
  }

  return model;
}

/**
 * Grows the last non-auxiliary segment so the model covers `total` flat numbers. Used when a
 * source inventory is longer than the library we know about.
 */
export function alignModelToFlatCount(
  model: SeriesVolumeModel,
  total: number,
): SeriesVolumeModel {
  const current = totalVolumeCount(model);
  if (current >= total) return model;
  const segments = model.segments.map((s) => ({ ...s }));
  let lastIndex = -1;
  for (let i = segments.length - 1; i >= 0; i--) {
    if (!isAuxiliaryNamespace(segments[i].namespace)) {
      lastIndex = i;
      break;
    }
  }
  if (lastIndex === -1) {
    segments.unshift({ namespace: MAIN_VOLUME_NAMESPACE, size: total });
  } else {
    segments[lastIndex].size += total - current;
  }
  return { segments };
}

/**
 * Flat catalogue position (1-based) for a key, honouring the model's segment offsets.
 * Auxiliary namespaces have no flat position: they are not part of the mainline count.
 */
export function flatPositionFor(model: SeriesVolumeModel, key: VolumeKey): number | null {
  if (isAuxiliaryNamespace(key.namespace)) return null;
  let offset = 0;
  for (const segment of model.segments) {
    if (isAuxiliaryNamespace(segment.namespace)) continue;
    const isBase = segment.namespace === MAIN_VOLUME_NAMESPACE;
    const matches =
      segment.namespace === key.namespace ||
      (isBase && isBaseNamespace(key.namespace));
    if (matches) {
      if (key.volume <= 0) return offset + key.volume;
      if (key.volume > segment.size + VOLUME_EPSILON) return null;
      return offset + key.volume;
    }
    offset += segment.size;
  }
  return null;
}

/** Inverse of `flatPositionFor`: the key that occupies a flat catalogue number. */
export function keyForFlatPosition(model: SeriesVolumeModel, flat: number): VolumeKey | null {
  if (!Number.isFinite(flat) || flat < 0) return null;
  let offset = 0;
  for (const segment of model.segments) {
    if (isAuxiliaryNamespace(segment.namespace)) continue;
    if (flat <= offset + segment.size) {
      return { namespace: segment.namespace, volume: flat - offset };
    }
    offset += segment.size;
  }
  // Beyond the modelled catalogue: keep the number in the last non-auxiliary namespace.
  for (let i = model.segments.length - 1; i >= 0; i--) {
    if (!isAuxiliaryNamespace(model.segments[i].namespace)) {
      return { namespace: model.segments[i].namespace, volume: flat - offset };
    }
  }
  return { namespace: MAIN_VOLUME_NAMESPACE, volume: flat };
}

/**
 * The namespace an audited novel is measured in.
 *  - auxiliary novel (art book, fanbook …) -> its own namespace, counted locally
 *  - explicit sub-series novel (Year 2, Part 3) -> that namespace, counted locally
 *  - base series novel -> the whole flat model (all parts/seasons projected)
 */
export function auditNamespaceFor(novelTitle?: string | null): string {
  return parseVolumeNamespace(novelTitle);
}

/**
 * Converts a matched Calibre row into the numbers the audited novel should count.
 * Returns `null` when the row does not belong to the novel's reading sequence.
 */
export function projectOwnedVolume(
  rowKey: VolumeKey,
  model: SeriesVolumeModel,
  novelNamespace: string,
): number | null {
  const ns = novelNamespace || MAIN_VOLUME_NAMESPACE;

  // An auxiliary novel only owns rows from the same auxiliary sequence.
  if (isAuxiliaryNamespace(ns)) {
    return rowKey.namespace === ns ? rowKey.volume : null;
  }
  // A bundle range covers mainline volumes: "Vol. 1-3 Bundle" owns 1, 2 and 3.
  if (rowKey.namespace === "omnibus") {
    return flatPositionFor(model, { namespace: MAIN_VOLUME_NAMESPACE, volume: rowKey.volume });
  }
  // A mainline novel never counts other auxiliary sequences (art books, fanbooks).
  if (isAuxiliaryNamespace(rowKey.namespace)) return null;

  // An explicit sub-series novel (Year 2 / Part 3) only counts its own namespace.
  if (!isBaseNamespace(ns)) {
    return rowKey.namespace === ns ? rowKey.volume : null;
  }

  // A base novel never counts a later year/season catalogue (those restart at volume 1 and
  // belong to their own card), but it does count part sequences, which extend the base line.
  if (/^(?:year|season):/.test(rowKey.namespace)) return null;

  // Base novel: project every mainline row onto the flat catalogue.
  return flatPositionFor(model, rowKey);
}

/** True when the novel's namespace is a sub-series which is measured locally. */
export function isLocalNamespace(novelNamespace: string): boolean {
  const ns = novelNamespace || MAIN_VOLUME_NAMESPACE;
  return isAuxiliaryNamespace(ns) || !isBaseNamespace(ns);
}

/**
 * Projected catalogue number for a title, used wherever a single flat number is required
 * (search results, seeds, ingest titles). Bookworm's parts are published as one flat line, so
 * they project through the known series model; every other title keeps its local number and
 * carries its namespace alongside instead of silently colliding with the base series.
 */
export function projectTitleVolumeNumber(
  title: string,
  seriesName?: string,
): number | null {
  const key = resolveCanonicalVolumeKey(title, seriesName);
  if (!key) return null;
  const model = knownSeriesModel([title, seriesName || ""].join(" "));
  if (!model) return key.volume;
  const flat = flatPositionFor(model, key);
  return flat === null ? key.volume : flat;
}

/**
 * Catalogue size for a book, never derived from an ownership scan for auxiliary sequences
 * (an art book cannot inherit its parent series' volume count).
 */
export function catalogueVolumeCountFrom(options: {
  catalogCount: number;
  ownershipCount: number;
  maxOwned: number;
  namespace: string;
  knownTotal?: number;
}): number {
  const { catalogCount, ownershipCount, maxOwned, namespace, knownTotal } = options;
  const catalog = Math.max(catalogCount || 0, knownTotal || 0);
  if (isAuxiliaryNamespace(namespace)) return Math.max(catalog, 1);
  return Math.max(catalog, ownershipCount || 0, Math.ceil(maxOwned || 0));
}

/**
 * Converts a volume key into the single number Calibre stores in `series_index`.
 *
 * Calibre has one flat numeric field per series, so a namespaced key has to be encoded into it:
 *  - mainline volumes keep their own number (`5`),
 *  - `year:2` / `season:2` volumes use the library's existing sub-series convention
 *    (`2.01`, `2.09` — year 2 volume 9), which is exactly how the library already stores
 *    Classroom of the Elite's Year 2 line,
 *  - `part:N` volumes keep the historical ingest encoding `N*100 + volume` (the shape Elscione
 *    ingestion already wrote), so existing parts stay addressable,
 *  - auxiliary sequences keep their local number; they are separate series anyway.
 */
export function calibreSeriesIndexForKey(key: VolumeKey): number {
  const ns = key.namespace || MAIN_VOLUME_NAMESPACE;
  if (isBaseNamespace(ns)) return key.volume;
  if (isAuxiliaryNamespace(ns)) return key.volume;
  const match = ns.match(/^(year|season|part):(\d+(?:\.\d+)?)$/);
  if (!match) return key.volume;
  const namespaceNumber = parseFloat(match[2]);
  if (match[1] === "part") return namespaceNumber * 100 + key.volume;
  return Number((namespaceNumber + key.volume / 100).toFixed(2));
}

/** Human-readable volume label within its namespace ("Volume 4", "Part 2 Volume 4"). */
export function volumeDisplayLabel(namespace: string, volume: number): string {
  const ns = namespace || MAIN_VOLUME_NAMESPACE;
  const number = formatVolumeNumber(volume);
  if (isBaseNamespace(ns)) return `Volume ${number}`;
  const match = ns.match(/^(year|season|part):(\d+(?:\.\d+)?)$/);
  if (match) {
    const label = match[1][0].toUpperCase() + match[1].slice(1);
    return `${label} ${match[2]} Volume ${number}`;
  }
  return `${ns} Volume ${number}`;
}

export function volumeKeysMatch(a: VolumeKey, b: VolumeKey): boolean {
  if (Math.abs(a.volume - b.volume) > VOLUME_EPSILON) return false;
  if (a.namespace === b.namespace) return true;
  return isBaseNamespace(a.namespace) && isBaseNamespace(b.namespace);
}

export function volumeKeyInSet(key: VolumeKey, keys: Iterable<VolumeKey>): boolean {
  for (const other of keys) {
    if (volumeKeysMatch(key, other)) return true;
  }
  return false;
}

export function dedupeVolumeKeys(keys: VolumeKey[]): VolumeKey[] {
  const seen = new Set<string>();
  const out: VolumeKey[] = [];
  for (const key of keys) {
    const normalized: VolumeKey = isBaseNamespace(key.namespace)
      ? { namespace: MAIN_VOLUME_NAMESPACE, volume: key.volume }
      : key;
    const enc = encodeVolumeKey(normalized);
    if (seen.has(enc)) continue;
    seen.add(enc);
    out.push(normalized);
  }
  return out;
}

export function volumeNumbersToKeys(
  volumes: number[],
  namespace: string = MAIN_VOLUME_NAMESPACE,
): VolumeKey[] {
  return volumes
    .filter((v) => typeof v === "number" && !Number.isNaN(v) && v >= 0)
    .map((volume) => ({ namespace, volume }));
}

export function describeVolumeKey(key: VolumeKey): string {
  return `${key.namespace} ${formatVolumeNumber(key.volume)}`;
}

/** True when a title's only volume marker is a bare "Part N"/"Part I" subtitle. */
export function isPartOnlyTitle(title: string): boolean {
  return parseMultiPartVolume(title) === null && parseVolumePart(title) !== null;
}

export { extractVolumeNumber, parseMultiPartVolume };
