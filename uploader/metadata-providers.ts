/**
 * ============================================================================
 * LightHouse Pluggable Metadata Provider Interface, Registry & Sidecar Protocol
 * ============================================================================
 *
 * Metadata enrichment used to be bespoke scraping wired directly into
 * `uploader/scraper.ts`: adding a source (RanobeDB, Douban, a private catalog)
 * meant editing that module. This file turns the search side of enrichment into
 * data:
 *
 *   1. `MetadataProvider` — the contract every source implements (search, fetch
 *      by ID/URL, declared field support, category coverage, priority).
 *   2. `MetadataProviderRegistry` — registration, validation, per-category
 *      routing tiers, priority fallback, and failure isolation.
 *   3. Sidecar providers — sources that run *beside* the server and speak a
 *      small HTTP/JSON protocol. Adding one is a config entry, not a code
 *      change. See `docs/metadata-providers.md` for the protocol reference.
 *
 * The Calibre write path (title/cover overwrite protection and the volume
 * conflict guards) is intentionally NOT part of this module: it stays in
 * `uploader/scraper.ts` (`resolveOverwriteGuards`, `applyMetadataToCalibre`,
 * `applyVolumeConflictGuard`) exactly as before, so a new provider can never
 * widen what gets written over existing library data.
 */

import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { safeFetchWithSsrf } from "./security";
import type { BookSourceCategory } from "./jev-shelf";

// ---------------------------------------------------------------------------
// Provider metadata record
// ---------------------------------------------------------------------------

/**
 * A single metadata candidate produced by a provider.
 *
 * `title`, `authors`, `tags`, `source` and `confidence` are the only fields the
 * Calibre write path relies on today. `series` and `volume` are optional
 * structured extras: when a provider supplies `volume` explicitly the volume
 * conflict guards honour it instead of re-parsing a volume marker out of the
 * title (which is what every built-in provider still does).
 */
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
  /** Optional structured series name (provider contracts list `series`). */
  series?: string;
  /** Optional structured volume/series index (provider contracts list `volume`). */
  volume?: number | null;
}

/** Fields a provider is able to supply. Declared, advertised, and testable. */
export type MetadataField =
  | "title"
  | "authors"
  | "synopsis"
  | "cover"
  | "tags"
  | "series"
  | "volume";

export const METADATA_FIELDS: readonly MetadataField[] = [
  "title",
  "authors",
  "synopsis",
  "cover",
  "tags",
  "series",
  "volume",
];

export const DEFAULT_PROVIDER_FIELDS: MetadataField[] = [
  "title",
  "authors",
  "synopsis",
  "cover",
  "tags",
];

/**
 * Built-in providers all share one priority so that today's insertion-order
 * tie-breaking (tier order, then the RanobeDB preference rules) is preserved
 * byte-for-byte. Sidecars are configured around this value: a sidecar at 60
 * outranks a built-in on an equal-confidence tie, one at 40 defers to it.
 */
export const BUILTIN_PROVIDER_PRIORITY = 50;

// ---------------------------------------------------------------------------
// Search context & runtime dependencies
// ---------------------------------------------------------------------------

/** Everything a provider needs to answer one search. */
export interface MetadataSearchContext {
  /** Raw user/ingest query (already trimmed by the caller). */
  query: string;
  /** Author hint used by some providers to disambiguate homonyms. */
  author?: string;
  /** Source filename hint (e.g. `Vol 03.epub`). */
  filename?: string;
  /** Existing Calibre tags for the book being enriched. */
  tags?: string[];
  /** Resolved source category; providers ignore categories they do not serve. */
  category?: BookSourceCategory;
  /** True when the caller is resolving one specific volume of a series. */
  preserveVolume?: boolean;
  /** Volume number of the target book, when known. */
  volume?: number | null;
}

/** Injectable runtime dependencies so providers stay mockable in tests. */
export interface ProviderRuntimeDeps {
  /** HTTP implementation for sidecar/remote calls (defaults to global fetch). */
  fetchFn?: typeof fetch;
  /** Per-request timeout override in milliseconds. */
  timeoutMs?: number;
}

/** The provider contract. Implement `search`; everything else is optional. */
export interface MetadataProvider {
  /** Stable slug, used in config, logs, and the discovery endpoint. */
  id: string;
  /** Human label that lands in `ScrapedMetadata.source`. */
  label: string;
  /** `builtin` providers ship with LightHouse; `sidecar` providers are data. */
  kind: "builtin" | "sidecar";
  /** Higher wins equal-confidence ties and sorts ahead within a tier. */
  priority: number;
  /** Categories this provider serves, or `"all"`. */
  categories: BookSourceCategory[];
  /** Fields this provider can contribute. */
  fields: MetadataField[];
  /** Series-level sources are skipped when a specific volume is resolved. */
  seriesQueryOnly?: boolean;
  /** Disabled providers stay registered (visible) but never run. */
  enabled?: boolean;
  /** Sidecar base URL, for diagnostics only. */
  endpoint?: string;
  /** Search by free-text query. Must never throw for network errors. */
  search: (
    ctx: MetadataSearchContext,
    deps?: ProviderRuntimeDeps,
  ) => Promise<ScrapedMetadata[]>;
  /** Fetch one record by the provider's own external ID. */
  fetchById?: (
    externalId: string,
    deps?: ProviderRuntimeDeps,
  ) => Promise<ScrapedMetadata | null>;
  /** Return the external ID when `url` is a detail page this provider owns. */
  matchUrl?: (url: string) => string | null;
}

export const ALL_CATEGORIES: readonly BookSourceCategory[] = [
  "light_novel",
  "manga",
  "general_book",
  "burmese",
  "other",
];

// ---------------------------------------------------------------------------
// Ranking helpers (shared with scraper.ts; behaviour-preserving moves)
// ---------------------------------------------------------------------------

/**
 * Does this result set count as "usable" for tier short-circuiting?
 *
 * When a specific volume is being resolved, only a high-confidence candidate
 * carrying a real synopsis counts — otherwise the caller walks the fallback
 * tiers looking for a volume-specific description. That predicate is what the
 * original light-novel route expressed inline as `hasUsableLn`.
 */
export function isUsableResultSet(
  results: ScrapedMetadata[],
  preserveVolume?: boolean,
): boolean {
  if (preserveVolume) {
    return results.some(
      (r) =>
        r.confidence >= 0.85 &&
        Boolean(r.description) &&
        (r.description as string).trim().length > 15,
    );
  }
  return results.length > 0;
}

// ---------------------------------------------------------------------------
// Result provenance (kept off the records themselves)
// ---------------------------------------------------------------------------

interface ResultProvenance {
  providerId: string;
  priority: number;
  kind: "builtin" | "sidecar";
}

const resultProvenance = new WeakMap<object, ResultProvenance>();

/** Provenance of a result produced through a registry, when known. */
export function describeResultProvider(
  result: ScrapedMetadata,
): ResultProvenance | null {
  return resultProvenance.get(result) ?? null;
}

function tagResults(
  results: ScrapedMetadata[],
  provider: MetadataProvider,
): ScrapedMetadata[] {
  for (const r of results) {
    if (r && typeof r === "object") {
      resultProvenance.set(r, {
        providerId: provider.id,
        priority: provider.priority,
        kind: provider.kind,
      });
    }
  }
  return results;
}

// ---------------------------------------------------------------------------
// Routing table: category -> ordered tiers of provider ids
// ---------------------------------------------------------------------------

/**
 * Which providers to consult, in which order, for each source category. This
 * table is the data form of the routing that used to be hard-coded in
 * `searchUniversalMetadata`. Tiers run in order; after each tier the collected
 * results are tested with `isUsableResultSet`, and the remaining tiers are
 * skipped when the answer is already good enough.
 */
export type ProviderRoutingTable = Record<BookSourceCategory, string[][]>;

export const DEFAULT_ROUTING_TABLE: ProviderRoutingTable = {
  // Light novels: RanobeDB + Bangumi (+ AniList for series queries), then
  // Google Books, then OpenLibrary + MangaDex.
  light_novel: [
    ["ranobedb", "anilist", "bangumi"],
    ["google_books"],
    ["openlibrary", "mangadex"],
  ],
  // Manga: MangaDex + Bangumi (+ AniList for series queries), then general web.
  manga: [
    ["mangadex", "anilist", "bangumi"],
    ["google_books", "openlibrary"],
  ],
  // General/other: general web sources first, then franchise sources.
  general_book: [
    ["google_books", "openlibrary"],
    ["ranobedb", "anilist", "bangumi", "mangadex"],
  ],
  other: [
    ["google_books", "openlibrary"],
    ["ranobedb", "anilist", "bangumi", "mangadex"],
  ],
  // Burmese literature: overseas metadata sources 404, so nothing runs unless
  // an operator configures a Burmese-capable sidecar.
  burmese: [],
};

export interface ResolvedTier {
  tierIndex: number;
  providers: MetadataProvider[];
}

export interface ProviderPlan {
  category: BookSourceCategory | undefined;
  /** Routing-table tiers, evaluated in order with short-circuiting. */
  tiers: ResolvedTier[];
  /**
   * Providers that are not named in the routing table for this category and are
   * therefore always consulted, after the tiers: sidecar providers (the whole
   * point of plugging a source in as data) and any extra provider an integrator
   * registered without editing the table.
   */
  alwaysRun: MetadataProvider[];
}

// ---------------------------------------------------------------------------
// Registry
// ---------------------------------------------------------------------------

const PROVIDER_ID_REGEX = /^[a-z0-9][a-z0-9_-]*$/;

export class MetadataProviderError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "MetadataProviderError";
  }
}

/** Validate a provider definition before it can enter a registry. */
export function validateProviderDefinition(provider: MetadataProvider): void {
  if (!provider || typeof provider !== "object") {
    throw new MetadataProviderError("Provider definition must be an object");
  }
  if (typeof provider.id !== "string" || !PROVIDER_ID_REGEX.test(provider.id)) {
    throw new MetadataProviderError(
      `Provider id must match ${PROVIDER_ID_REGEX} (got ${JSON.stringify(provider.id)})`,
    );
  }
  if (typeof provider.label !== "string" || !provider.label.trim()) {
    throw new MetadataProviderError(
      `Provider "${provider.id}" requires a non-empty label`,
    );
  }
  if (provider.kind !== "builtin" && provider.kind !== "sidecar") {
    throw new MetadataProviderError(
      `Provider "${provider.id}" requires kind "builtin" or "sidecar"`,
    );
  }
  if (typeof provider.search !== "function") {
    throw new MetadataProviderError(
      `Provider "${provider.id}" requires a search() function`,
    );
  }
  if (
    provider.priority !== undefined &&
    (!Number.isFinite(provider.priority) || Number.isNaN(provider.priority))
  ) {
    throw new MetadataProviderError(
      `Provider "${provider.id}" priority must be a finite number`,
    );
  }
  if (!Array.isArray(provider.categories) || provider.categories.length === 0) {
    throw new MetadataProviderError(
      `Provider "${provider.id}" must declare at least one category`,
    );
  }
  for (const c of provider.categories) {
    if (!ALL_CATEGORIES.includes(c)) {
      throw new MetadataProviderError(
        `Provider "${provider.id}" declares unknown category "${c}"`,
      );
    }
  }
  if (!Array.isArray(provider.fields) || provider.fields.length === 0) {
    throw new MetadataProviderError(
      `Provider "${provider.id}" must declare at least one field`,
    );
  }
  for (const f of provider.fields) {
    if (!METADATA_FIELDS.includes(f)) {
      throw new MetadataProviderError(
        `Provider "${provider.id}" declares unknown field "${f}"`,
      );
    }
  }
  if (provider.fetchById !== undefined && typeof provider.fetchById !== "function") {
    throw new MetadataProviderError(
      `Provider "${provider.id}" fetchById must be a function when present`,
    );
  }
  if (provider.matchUrl !== undefined && typeof provider.matchUrl !== "function") {
    throw new MetadataProviderError(
      `Provider "${provider.id}" matchUrl must be a function when present`,
    );
  }
}

/** Public, serialisable view of a registered provider. */
export interface ProviderDescriptor {
  id: string;
  label: string;
  kind: "builtin" | "sidecar";
  priority: number;
  categories: BookSourceCategory[];
  fields: MetadataField[];
  seriesQueryOnly: boolean;
  enabled: boolean;
  endpoint?: string;
  capabilities: { search: boolean; fetchById: boolean; matchUrl: boolean };
}

export interface RegistrySearchResult {
  results: ScrapedMetadata[];
  /** Providers that were consulted, in execution order. */
  consulted: string[];
  /** Providers that threw or timed out (search continues without them). */
  failures: { providerId: string; error: string }[];
  /** True when a tier short-circuited the remaining tiers. */
  shortCircuited: boolean;
}

export interface RegistryOptions {
  routingTable?: ProviderRoutingTable;
  /**
   * Categories for which no provider should ever run (Burmese literature
   * skips overseas lookups). Sidecars that explicitly declare the category
   * still run, so a local Burmese source can be plugged in as data.
   */
  onSearch?: (
    provider: MetadataProvider,
    ctx: MetadataSearchContext,
    results: ScrapedMetadata[],
  ) => void;
}

export class MetadataProviderRegistry {
  private providers = new Map<string, MetadataProvider>();
  private routingTable: ProviderRoutingTable;

  constructor(options: RegistryOptions = {}) {
    this.routingTable = options.routingTable
      ? cloneRoutingTable(options.routingTable)
      : cloneRoutingTable(DEFAULT_ROUTING_TABLE);
  }

  /** Register (or replace by id) a provider. Returns the registry for chaining. */
  register(provider: MetadataProvider): this {
    const normalized: MetadataProvider = {
      ...provider,
      priority:
        provider.priority === undefined
          ? BUILTIN_PROVIDER_PRIORITY
          : provider.priority,
      categories: [...provider.categories],
      fields: [...provider.fields],
      enabled: provider.enabled !== false,
      seriesQueryOnly: Boolean(provider.seriesQueryOnly),
    };
    validateProviderDefinition(normalized);
    this.providers.set(normalized.id, normalized);
    return this;
  }

  registerAll(providers: MetadataProvider[]): this {
    for (const p of providers) this.register(p);
    return this;
  }

  unregister(id: string): boolean {
    return this.providers.delete(id);
  }

  has(id: string): boolean {
    return this.providers.has(id);
  }

  get(id: string): MetadataProvider | undefined {
    return this.providers.get(id);
  }

  /** All enabled providers, highest priority first then registration order. */
  list(): MetadataProvider[] {
    const order = [...this.providers.keys()];
    return [...this.providers.values()]
      .filter((p) => p.enabled !== false)
      .sort((a, b) => {
        if (b.priority !== a.priority) return b.priority - a.priority;
        return order.indexOf(a.id) - order.indexOf(b.id);
      });
  }

  /** Enabled providers serving `category` (or "all"). */
  resolve(category?: BookSourceCategory): MetadataProvider[] {
    if (!category) return this.list();
    return this.list().filter((p) => p.categories.includes(category));
  }

  setRoutingTable(table: ProviderRoutingTable): void {
    this.routingTable = cloneRoutingTable(table);
  }

  getRoutingTable(): ProviderRoutingTable {
    return cloneRoutingTable(this.routingTable);
  }

  /**
   * Resolve the ordered tier plan for a category. Unknown/unregistered ids in
   * the routing table are skipped (so a table can name an optional provider),
   * sidecars never occupy a built-in tier, and providers absent from the table
   * are returned in `alwaysRun` so registration alone is enough to plug one in.
   *
   * A provider not scoped to a category is consulted for every category it
   * declares; a category-less plan therefore keeps only the table tiers apart.
   */
  plan(
    category: BookSourceCategory | undefined,
    ctx?: MetadataSearchContext,
  ): ProviderPlan {
    const tiers: ResolvedTier[] = [];
    const scheduled = new Set<string>();
    const rawTiers = category ? (this.routingTable[category] ?? []) : [];
    rawTiers.forEach((ids, tierIndex) => {
      const providers: MetadataProvider[] = [];
      for (const id of ids) {
        const p = this.providers.get(id);
        if (!p || p.enabled === false) continue;
        if (p.kind === "sidecar") continue; // sidecars never occupy builtin tiers
        if (p.seriesQueryOnly && ctx?.preserveVolume) continue;
        providers.push(p);
        scheduled.add(p.id);
      }
      if (providers.length > 0) tiers.push({ tierIndex, providers });
    });

    const alwaysRun = this.resolve(category).filter(
      (p) =>
        !scheduled.has(p.id) && !(p.seriesQueryOnly && ctx?.preserveVolume),
    );

    return { category, tiers, alwaysRun };
  }

  /**
   * Run the routing plan for a category with tier short-circuiting and full
   * failure isolation. Sidecars always run last and are merged in.
   */
  async searchAll(
    ctx: MetadataSearchContext,
    deps?: ProviderRuntimeDeps,
  ): Promise<RegistrySearchResult> {
    const plan = this.plan(ctx.category, ctx);
    const results: ScrapedMetadata[] = [];
    const consulted: string[] = [];
    const failures: { providerId: string; error: string }[] = [];
    let shortCircuited = false;

    const runTier = async (providers: MetadataProvider[]) => {
      if (providers.length === 0) return;
      consulted.push(...providers.map((p) => p.id));
      const settled = await Promise.allSettled(
        providers.map((p) => p.search(ctx, deps)),
      );
      settled.forEach((res, index) => {
        const provider = providers[index];
        if (res.status === "fulfilled") {
          if (Array.isArray(res.value) && res.value.length > 0) {
            results.push(...tagResults(res.value, provider));
          }
        } else {
          failures.push({
            providerId: provider.id,
            error:
              res.reason instanceof Error
                ? res.reason.message
                : String(res.reason),
          });
        }
      });
    };

    for (const tier of plan.tiers) {
      await runTier(tier.providers);
      if (isUsableResultSet(results, ctx.preserveVolume)) {
        shortCircuited = tier.tierIndex < (plan.tiers.at(-1)?.tierIndex ?? tier.tierIndex);
        break;
      }
    }

    // Sidecars and other un-table-d providers always run: they are operator
    // opt-ins, not fallbacks.
    await runTier(plan.alwaysRun);

    return { results, consulted, failures, shortCircuited };
  }

  /**
   * Convenience wrapper returning just the candidate list, ranked by the same
   * rules the Calibre write path expects (callers apply the volume conflict
   * guard and the RanobeDB preference sort afterwards).
   */
  async search(
    ctx: MetadataSearchContext,
    deps?: ProviderRuntimeDeps,
  ): Promise<ScrapedMetadata[]> {
    const { results, failures } = await this.searchAll(ctx, deps);
    for (const failure of failures) {
      console.debug(
        `[MetadataProviders] Provider "${failure.providerId}" failed: ${failure.error}`,
      );
    }
    return results;
  }

  /**
   * Fetch a single record by external id. Accepts either a bare id (tries every
   * provider exposing `fetchById`, highest priority first) or a `provider:id`
   * pair, which is unambiguous and preferred.
   */
  async fetchById(
    ref: string,
    deps?: ProviderRuntimeDeps,
  ): Promise<{ providerId: string; result: ScrapedMetadata } | null> {
    const trimmed = (ref || "").trim();
    if (!trimmed) return null;

    const explicit = trimmed.match(/^([a-z0-9][a-z0-9_-]*)[:/](.+)$/);
    if (explicit && this.providers.has(explicit[1])) {
      const provider = this.providers.get(explicit[1]) as MetadataProvider;
      if (!provider.fetchById) return null;
      const result = await provider.fetchById(explicit[2], deps);
      if (!result) return null;
      tagResults([result], provider);
      return { providerId: provider.id, result };
    }

    for (const provider of this.list()) {
      if (!provider.fetchById) continue;
      try {
        const result = await provider.fetchById(trimmed, deps);
        if (result) {
          tagResults([result], provider);
          return { providerId: provider.id, result };
        }
      } catch (err) {
        console.debug(
          `[MetadataProviders] fetchById failed for "${provider.id}":`,
          err,
        );
      }
    }
    return null;
  }

  /** Fetch one record from a provider detail URL (`matchUrl` dispatch). */
  async fetchByUrl(
    url: string,
    deps?: ProviderRuntimeDeps,
  ): Promise<{ providerId: string; externalId: string; result: ScrapedMetadata } | null> {
    const resolved = this.matchUrl(url);
    if (!resolved) return null;
    const provider = this.providers.get(resolved.providerId);
    if (!provider || !provider.fetchById) return null;
    const result = await provider.fetchById(resolved.externalId, deps);
    if (!result) return null;
    tagResults([result], provider);
    return { providerId: provider.id, externalId: resolved.externalId, result };
  }

  /** Which provider owns a detail URL, and the external id it carries. */
  matchUrl(url: string): { providerId: string; externalId: string } | null {
    if (!url || typeof url !== "string") return null;
    for (const provider of this.list()) {
      if (!provider.matchUrl) continue;
      try {
        const externalId = provider.matchUrl(url);
        if (externalId) return { providerId: provider.id, externalId };
      } catch (err) {
        console.debug(
          `[MetadataProviders] matchUrl failed for "${provider.id}":`,
          err,
        );
      }
    }
    return null;
  }

  describe(): ProviderDescriptor[] {
    return this.list().map((p) => ({
      id: p.id,
      label: p.label,
      kind: p.kind,
      priority: p.priority,
      categories: [...p.categories],
      fields: [...p.fields],
      seriesQueryOnly: Boolean(p.seriesQueryOnly),
      enabled: p.enabled !== false,
      endpoint: p.endpoint,
      capabilities: {
        search: typeof p.search === "function",
        fetchById: typeof p.fetchById === "function",
        matchUrl: typeof p.matchUrl === "function",
      },
    }));
  }

  clear(): void {
    this.providers.clear();
  }
}

function cloneRoutingTable(table: ProviderRoutingTable): ProviderRoutingTable {
  const clone = {} as ProviderRoutingTable;
  for (const key of ALL_CATEGORIES) {
    clone[key] = (table[key] ?? []).map((tier) => [...tier]);
  }
  return clone;
}

// ---------------------------------------------------------------------------
// Built-in provider adapters
// ---------------------------------------------------------------------------

/**
 * The search implementations that already live in `uploader/scraper.ts`. They
 * are injected rather than imported so this module stays free of scraping code
 * (and of an import cycle with `scraper.ts`).
 */
export interface BuiltinSearchAdapters {
  ranobedb?: (query: string, options?: { preserveVolume?: boolean }) => Promise<ScrapedMetadata[]>;
  anilist?: (query: string) => Promise<ScrapedMetadata[]>;
  bangumi?: (query: string, options?: { preserveVolume?: boolean }) => Promise<ScrapedMetadata[]>;
  googleBooks?: (query: string, options?: { preserveVolume?: boolean }) => Promise<ScrapedMetadata[]>;
  openLibrary?: (query: string, options?: { preserveVolume?: boolean }) => Promise<ScrapedMetadata[]>;
  mangaDex?: (query: string, options?: { preserveVolume?: boolean }) => Promise<ScrapedMetadata[]>;
}

export const BUILTIN_PROVIDER_IDS = {
  ranobeDb: "ranobedb",
  aniList: "anilist",
  bangumi: "bangumi",
  googleBooks: "google_books",
  openLibrary: "openlibrary",
  mangaDex: "mangadex",
} as const;

/**
 * Wrap the existing scrapers in the provider contract. Each entry keeps the
 * source label the scrapers already emit (`RanobeDB`, `Google Books`, …) since
 * the ranking rules and the Telegram/UI surfaces key off those labels.
 *
 * A provider's served categories are derived from the routing table rather than
 * hand-listed: a provider that the table never schedules for a category must not
 * claim it, otherwise it would be consulted for that category as an always-run
 * "extra" source. Deriving them keeps the two in lockstep by construction.
 */
export function createBuiltinProviders(
  adapters: BuiltinSearchAdapters,
): MetadataProvider[] {
  const providers: MetadataProvider[] = [];
  const categoriesFor = (id: string): BookSourceCategory[] =>
    ALL_CATEGORIES.filter((category) =>
      (DEFAULT_ROUTING_TABLE[category] ?? []).some((tier) => tier.includes(id)),
    );

  const add = (
    id: string,
    label: string,
    adapter: BuiltinSearchAdapters[keyof BuiltinSearchAdapters] | undefined,
    options: {
      fields?: MetadataField[];
      seriesQueryOnly?: boolean;
      volumeAware?: boolean;
    } = {},
  ) => {
    if (!adapter) return;
    const volumeAware = options.volumeAware !== false;
    providers.push({
      id,
      label,
      kind: "builtin",
      priority: BUILTIN_PROVIDER_PRIORITY,
      categories: categoriesFor(id),
      fields: options.fields ?? DEFAULT_PROVIDER_FIELDS,
      seriesQueryOnly: options.seriesQueryOnly ?? false,
      search: (ctx) =>
        volumeAware
          ? adapter(ctx.query, { preserveVolume: ctx.preserveVolume })
          : adapter(ctx.query),
    });
  };

  add(BUILTIN_PROVIDER_IDS.ranobeDb, "RanobeDB", adapters.ranobedb, {
    fields: ["title", "authors", "synopsis", "cover", "tags", "series"],
  });
  add(BUILTIN_PROVIDER_IDS.aniList, "AniList", adapters.anilist, {
    fields: ["title", "authors", "synopsis", "cover", "tags"],
    // AniList keys on series entries, so it only runs for series-level queries.
    seriesQueryOnly: true,
    volumeAware: false,
  });
  add(BUILTIN_PROVIDER_IDS.bangumi, "Bangumi", adapters.bangumi);
  add(BUILTIN_PROVIDER_IDS.googleBooks, "Google Books", adapters.googleBooks);
  add(BUILTIN_PROVIDER_IDS.openLibrary, "OpenLibrary", adapters.openLibrary);
  add(BUILTIN_PROVIDER_IDS.mangaDex, "MangaDex", adapters.mangaDex);

  return providers;
}

// ---------------------------------------------------------------------------
// Sidecar providers: HTTP/JSON sources that run beside the server
// ---------------------------------------------------------------------------

/**
 * Sidecar protocol (see `docs/metadata-providers.md` for the full reference):
 *
 *   GET {endpoint}/search?q=<query>&category=<cat>&volume=<n>&author=<a>
 *     -> { "results": [ ProviderResult, ... ] } | [ ProviderResult, ... ]
 *
 *   GET {endpoint}/book/<externalId>
 *     -> { "book": ProviderResult } | ProviderResult
 *
 *   GET {endpoint}/manifest            (optional discovery)
 *     -> { "id", "label", "fields", "categories", "priority", "protocol" }
 *
 * ProviderResult fields: title (required), authors, synopsis|description,
 * coverUrl|cover|image, tags, series, volume|seriesIndex, confidence,
 * externalId|id, isManga.
 */
export interface SidecarProviderConfig {
  id: string;
  label?: string;
  /** Base URL, e.g. `http://127.0.0.1:8099` (Douban adapter, custom catalog). */
  endpoint: string;
  priority?: number;
  categories?: BookSourceCategory[];
  fields?: MetadataField[];
  enabled?: boolean;
  timeoutMs?: number;
  /** Optional bearer token for sidecars exposed beyond loopback. */
  authToken?: string;
  headers?: Record<string, string>;
  /** Override path templates (`/search`, `/book/{id}`, `/manifest`). */
  searchPath?: string;
  bookPath?: string;
  manifestPath?: string;
  /** Assumed confidence when the sidecar omits one. */
  defaultConfidence?: number;
  /** Declared true when the sidecar only carries series-level records. */
  seriesQueryOnly?: boolean;
}

export interface SidecarManifest {
  id?: string;
  label?: string;
  fields?: MetadataField[];
  categories?: BookSourceCategory[];
  priority?: number;
  protocol?: number;
  seriesQueryOnly?: boolean;
}

export const SIDECAR_DEFAULT_TIMEOUT_MS = 6000;
export const SIDECAR_DEFAULT_CONFIDENCE = 0.78;
export const SIDECAR_PROTOCOL_VERSION = 1;

function isValidHttpUrl(raw: string): boolean {
  try {
    const u = new URL(raw);
    if (u.protocol !== "http:" && u.protocol !== "https:") return false;
    if (u.username || u.password) return false;
    return true;
  } catch {
    return false;
  }
}

/**
 * Coerce a sidecar payload into `ScrapedMetadata`. Unknown/invalid entries are
 * dropped rather than throwing, so one bad record cannot sink a whole search.
 */
export function normalizeSidecarResult(
  raw: any,
  config: { label: string; defaultConfidence?: number; isManga?: boolean },
): ScrapedMetadata | null {
  if (!raw || typeof raw !== "object") return null;
  const title = typeof raw.title === "string" ? raw.title.trim() : "";
  if (!title) return null;

  const pickString = (...candidates: any[]): string | undefined => {
    for (const c of candidates) {
      if (typeof c === "string" && c.trim()) return c.trim();
    }
    return undefined;
  };

  let authors: string;
  if (Array.isArray(raw.authors)) {
    authors = raw.authors
      .filter((a: any) => typeof a === "string" && a.trim())
      .map((a: string) => a.trim())
      .join(", ");
  } else {
    authors = pickString(raw.authors, raw.author) || "Unknown";
  }

  const tags: string[] = Array.isArray(raw.tags)
    ? raw.tags
        .filter((t: any) => typeof t === "string" && t.trim())
        .map((t: string) => t.trim())
    : [];

  const confidenceRaw = Number(raw.confidence);
  const confidence = Number.isFinite(confidenceRaw)
    ? Math.min(1, Math.max(0, confidenceRaw))
    : (config.defaultConfidence ?? SIDECAR_DEFAULT_CONFIDENCE);

  const volumeRaw = raw.volume ?? raw.seriesIndex ?? raw.series_index;
  const volumeNum = Number(volumeRaw);

  const result: ScrapedMetadata = {
    title,
    authors,
    tags,
    source: config.label,
    confidence,
  };

  const description = pickString(raw.synopsis, raw.description, raw.summary);
  if (description) result.description = description;
  const coverUrl = pickString(raw.coverUrl, raw.cover, raw.image, raw.cover_url);
  if (coverUrl) result.coverUrl = coverUrl;
  const publisher = pickString(raw.publisher);
  if (publisher) result.publisher = publisher;
  const publishedDate = pickString(raw.publishedDate, raw.pubdate, raw.published);
  if (publishedDate) result.publishedDate = publishedDate;
  const series = pickString(raw.series);
  if (series) result.series = series;
  if (Number.isFinite(volumeNum)) result.volume = volumeNum;
  if (typeof raw.isManga === "boolean") result.isManga = raw.isManga;
  else if (config.isManga) result.isManga = true;

  return result;
}

export interface SidecarResponse {
  results: ScrapedMetadata[];
  /** Trailing hint from the sidecar, surfaced for diagnostics. */
  externalIds: string[];
}

/** Parse `{results:[...]}` | `[...]` payloads from a sidecar search. */
export function parseSidecarSearchPayload(
  payload: any,
  config: { label: string; defaultConfidence?: number; isManga?: boolean },
): SidecarResponse {
  const list = Array.isArray(payload)
    ? payload
    : Array.isArray(payload?.results)
      ? payload.results
      : Array.isArray(payload?.data)
        ? payload.data
        : Array.isArray(payload?.books)
          ? payload.books
          : [];

  const results: ScrapedMetadata[] = [];
  const externalIds: string[] = [];
  for (const entry of list) {
    const normalized = normalizeSidecarResult(entry, config);
    if (!normalized) continue;
    results.push(normalized);
    const externalId = entry?.externalId ?? entry?.id;
    if (externalId !== undefined && externalId !== null) {
      externalIds.push(String(externalId));
    }
  }
  return { results, externalIds };
}

/** Parse `{book:{...}}` | `{...}` payloads from a sidecar detail fetch. */
export function parseSidecarBookPayload(
  payload: any,
  config: { label: string; defaultConfidence?: number; isManga?: boolean },
): ScrapedMetadata | null {
  if (!payload || typeof payload !== "object") return null;
  const candidate = payload.book ?? payload.result ?? payload.data ?? payload;
  return normalizeSidecarResult(candidate, config);
}

function buildSidecarUrl(base: string, pathTemplate: string, query?: URLSearchParams): string {
  const trimmedBase = base.replace(/\/+$/, "");
  const template = pathTemplate.startsWith("/") ? pathTemplate : `/${pathTemplate}`;
  const url = new URL(`${trimmedBase}${template}`);
  if (query) {
    for (const [key, value] of query.entries()) url.searchParams.set(key, value);
  }
  return url.toString();
}

/** Exact `host:port` key used to allowlist one configured sidecar endpoint. */
export function sidecarEndpointKey(endpoint: string): string {
  const url = new URL(endpoint);
  const port = url.port || (url.protocol === "https:" ? "443" : "80");
  return `${url.hostname.toLowerCase()}:${port}`;
}

/**
 * Sidecar requests still flow through the SSRF guard: the endpoint comes from
 * operator config, so it is passed as an exact host:port allowlist entry —
 * nothing else about the request can widen what the guard permits.
 */
async function requestSidecarJson(
  config: SidecarProviderConfig,
  url: string,
  headers: Record<string, string>,
  timeoutMs: number,
  deps?: ProviderRuntimeDeps,
): Promise<any> {
  const init: any = {
    method: "GET",
    headers,
    signal: AbortSignal.timeout(timeoutMs),
  };
  const res = deps?.fetchFn
    ? await deps.fetchFn(url, init)
    : await safeFetchWithSsrf(url, init, 5, {
        allowedSidecarEndpoints: [sidecarEndpointKey(config.endpoint)],
      });
  if (!res.ok) {
    throw new Error(`sidecar ${config.label || config.id} responded HTTP ${res.status}`);
  }
  return await res.json();
}

/**
 * Build a provider from a sidecar config. The endpoint comes from operator
 * config (never from user input), which is why loopback sidecars are reachable
 * here even though the SSRF guard blocks private targets for scraped URLs.
 */
export function createSidecarProvider(config: SidecarProviderConfig): MetadataProvider {
  if (!config || typeof config !== "object") {
    throw new MetadataProviderError("Sidecar provider config must be an object");
  }
  if (typeof config.id !== "string" || !PROVIDER_ID_REGEX.test(config.id)) {
    throw new MetadataProviderError(
      `Sidecar provider id must match ${PROVIDER_ID_REGEX} (got ${JSON.stringify(config.id)})`,
    );
  }
  if (typeof config.endpoint !== "string" || !isValidHttpUrl(config.endpoint)) {
    throw new MetadataProviderError(
      `Sidecar provider "${config.id}" requires an http(s) endpoint`,
    );
  }

  const label = config.label?.trim() || config.id;
  const timeoutMs = config.timeoutMs ?? SIDECAR_DEFAULT_TIMEOUT_MS;
  const defaultConfidence = config.defaultConfidence ?? SIDECAR_DEFAULT_CONFIDENCE;

  const headers: Record<string, string> = {
    Accept: "application/json",
    ...(config.headers ?? {}),
  };
  if (config.authToken) headers.Authorization = `Bearer ${config.authToken}`;

  const requestJson = (url: string, deps?: ProviderRuntimeDeps): Promise<any> =>
    requestSidecarJson(
      config,
      url,
      headers,
      deps?.timeoutMs ?? timeoutMs,
      deps,
    );

  return {
    id: config.id,
    label,
    kind: "sidecar",
    priority: config.priority ?? BUILTIN_PROVIDER_PRIORITY,
    categories: config.categories?.length
      ? [...config.categories]
      : ([...ALL_CATEGORIES] as BookSourceCategory[]),
    fields: config.fields?.length ? [...config.fields] : [...DEFAULT_PROVIDER_FIELDS],
    seriesQueryOnly: Boolean(config.seriesQueryOnly),
    enabled: config.enabled !== false,
    endpoint: config.endpoint,
    search: async (ctx, deps) => {
      const query = new URLSearchParams();
      query.set("q", ctx.query);
      if (ctx.category) query.set("category", ctx.category);
      if (ctx.volume !== undefined && ctx.volume !== null) {
        query.set("volume", String(ctx.volume));
      }
      if (ctx.author) query.set("author", ctx.author);
      if (ctx.preserveVolume) query.set("preserveVolume", "1");
      const url = buildSidecarUrl(
        config.endpoint,
        config.searchPath ?? "/search",
        query,
      );
      try {
        const payload = await requestJson(url, deps);
        return parseSidecarSearchPayload(payload, {
          label,
          defaultConfidence,
          isManga: ctx.category === "manga",
        }).results;
      } catch (err) {
        console.debug(`[MetadataProviders] sidecar "${config.id}" search failed:`, err);
        return [];
      }
    },
    fetchById: async (externalId, deps) => {
      const template = (config.bookPath ?? "/book/{id}").replace(
        "{id}",
        encodeURIComponent(externalId),
      );
      try {
        const payload = await requestJson(
          buildSidecarUrl(config.endpoint, template),
          deps,
        );
        return parseSidecarBookPayload(payload, {
          label,
          defaultConfidence,
          isManga: false,
        });
      } catch (err) {
        console.debug(
          `[MetadataProviders] sidecar "${config.id}" fetchById failed:`,
          err,
        );
        return null;
      }
    },
    matchUrl: (url) => {
      if (!url || typeof url !== "string") return null;
      let target: URL;
      let base: URL;
      try {
        target = new URL(url);
        base = new URL(config.endpoint);
      } catch {
        return null;
      }
      if (target.host !== base.host) return null;
      const pathname = target.pathname.replace(/\/+$/, "");
      const rawTemplate = (config.bookPath ?? "/book/{id}").replace(/\/+$/, "");
      const suffixIndex = rawTemplate.indexOf("{id}");
      const prefix = suffixIndex >= 0 ? rawTemplate.slice(0, suffixIndex) : rawTemplate;
      if (!pathname.startsWith(prefix)) return null;
      const externalId = pathname.slice(prefix.length).replace(/^\/+/, "");
      return externalId || null;
    },
  };
}

/**
 * Probe `GET {endpoint}/manifest` and merge the advertised metadata into the
 * config. Returns `null` when the sidecar is unreachable or malformed, so a
 * caller can fall back to the statically configured values.
 */
export async function probeSidecarManifest(
  config: SidecarProviderConfig,
  deps?: ProviderRuntimeDeps,
): Promise<SidecarManifest | null> {
  if (!isValidHttpUrl(config.endpoint)) return null;
  const url = buildSidecarUrl(
    config.endpoint,
    config.manifestPath ?? "/manifest",
  );
  const headers: Record<string, string> = {
    Accept: "application/json",
    ...(config.headers ?? {}),
  };
  if (config.authToken) headers.Authorization = `Bearer ${config.authToken}`;
  try {
    const res = deps?.fetchFn
      ? await deps.fetchFn(url, {
          method: "GET",
          headers,
          signal: AbortSignal.timeout(
            deps?.timeoutMs ?? config.timeoutMs ?? SIDECAR_DEFAULT_TIMEOUT_MS,
          ),
        })
      : await safeFetchWithSsrf(
          url,
          {
            method: "GET",
            headers,
            signal: AbortSignal.timeout(
              deps?.timeoutMs ?? config.timeoutMs ?? SIDECAR_DEFAULT_TIMEOUT_MS,
            ),
          },
          5,
          { allowedSidecarEndpoints: [sidecarEndpointKey(config.endpoint)] },
        );
    if (!res.ok) return null;
    const payload = await res.json();
    if (!payload || typeof payload !== "object") return null;
    const manifest: SidecarManifest = {};
    if (typeof payload.id === "string") manifest.id = payload.id;
    if (typeof payload.label === "string") manifest.label = payload.label;
    if (typeof payload.protocol === "number") manifest.protocol = payload.protocol;
    if (typeof payload.priority === "number") manifest.priority = payload.priority;
    if (typeof payload.seriesQueryOnly === "boolean") {
      manifest.seriesQueryOnly = payload.seriesQueryOnly;
    }
    if (Array.isArray(payload.fields)) {
      manifest.fields = payload.fields.filter((f: any) =>
        METADATA_FIELDS.includes(f),
      );
    }
    if (Array.isArray(payload.categories)) {
      manifest.categories = payload.categories.filter((c: any) =>
        ALL_CATEGORIES.includes(c),
      );
    }
    return manifest;
  } catch (err) {
    console.debug(`[MetadataProviders] manifest probe failed for "${config.id}":`, err);
    return null;
  }
}

// ---------------------------------------------------------------------------
// Sidecar config discovery (env + JSON manifest file)
// ---------------------------------------------------------------------------

export const SIDECAR_CONFIG_ENV = "LIGHTHOUSE_METADATA_PROVIDERS";
export const SIDECAR_CONFIG_FILE_ENV = "LIGHTHOUSE_METADATA_PROVIDERS_FILE";
export const SIDECAR_DISABLE_ENV = "LIGHTHOUSE_METADATA_PROVIDERS_OFF";

export function defaultSidecarConfigPath(): string {
  const root =
    process.env.LIGHTHOUSE_ROOT ||
    path.resolve((import.meta as { dir?: string }).dir || process.cwd(), "..");
  return path.join(root, "data", "metadata-providers.json");
}

function coerceSidecarConfigs(raw: any): SidecarProviderConfig[] {
  const list = Array.isArray(raw)
    ? raw
    : Array.isArray(raw?.providers)
      ? raw.providers
      : [];
  const configs: SidecarProviderConfig[] = [];
  for (const entry of list) {
    if (!entry || typeof entry !== "object") continue;
    const endpoint = entry.endpoint ?? entry.url ?? entry.baseUrl;
    if (typeof endpoint !== "string" || !isValidHttpUrl(endpoint)) continue;
    const id =
      typeof entry.id === "string" && entry.id
        ? entry.id
        : (() => {
            try {
              return new URL(endpoint).hostname.replace(/[^a-z0-9]+/gi, "_").toLowerCase();
            } catch {
              return "";
            }
          })();
    if (!id) continue;
    const config: SidecarProviderConfig = { id, endpoint };
    if (typeof entry.label === "string") config.label = entry.label;
    if (typeof entry.priority === "number") config.priority = entry.priority;
    if (typeof entry.enabled === "boolean") config.enabled = entry.enabled;
    if (typeof entry.timeoutMs === "number") config.timeoutMs = entry.timeoutMs;
    if (typeof entry.authToken === "string") config.authToken = entry.authToken;
    if (typeof entry.searchPath === "string") config.searchPath = entry.searchPath;
    if (typeof entry.bookPath === "string") config.bookPath = entry.bookPath;
    if (typeof entry.manifestPath === "string") config.manifestPath = entry.manifestPath;
    if (typeof entry.defaultConfidence === "number") {
      config.defaultConfidence = entry.defaultConfidence;
    }
    if (typeof entry.seriesQueryOnly === "boolean") {
      config.seriesQueryOnly = entry.seriesQueryOnly;
    }
    if (entry.headers && typeof entry.headers === "object") {
      config.headers = entry.headers;
    }
    if (Array.isArray(entry.categories)) {
      const cats = entry.categories.filter((c: any) => ALL_CATEGORIES.includes(c));
      if (cats.length) config.categories = cats;
    }
    if (Array.isArray(entry.fields)) {
      const fields = entry.fields.filter((f: any) => METADATA_FIELDS.includes(f));
      if (fields.length) config.fields = fields;
    }
    configs.push(config);
  }
  return configs;
}

export interface SidecarDiscovery {
  configs: SidecarProviderConfig[];
  source: "disabled" | "env" | "file" | "none";
  path?: string;
  /** Non-fatal problems (unreadable file, malformed JSON) for diagnostics. */
  warnings: string[];
}

/**
 * Discover sidecar provider configs. Precedence: explicit disable flag, then
 * inline env JSON, then the JSON manifest file (default
 * `<root>/data/metadata-providers.json`). Never throws.
 */
export function discoverSidecarProviders(
  env: Record<string, string | undefined> = process.env,
): SidecarDiscovery {
  const warnings: string[] = [];
  if (env[SIDECAR_DISABLE_ENV] === "1" || env[SIDECAR_DISABLE_ENV] === "true") {
    return { configs: [], source: "disabled", warnings };
  }

  const inline = env[SIDECAR_CONFIG_ENV];
  if (inline && inline.trim()) {
    try {
      const configs = coerceSidecarConfigs(JSON.parse(inline));
      return { configs, source: "env", warnings };
    } catch (err) {
      warnings.push(
        `${SIDECAR_CONFIG_ENV} is not valid JSON: ${err instanceof Error ? err.message : String(err)}`,
      );
      return { configs: [], source: "env", warnings };
    }
  }

  const filePath = env[SIDECAR_CONFIG_FILE_ENV]?.trim() || defaultSidecarConfigPath();
  try {
    if (!fs.existsSync(filePath)) {
      return { configs: [], source: "none", path: filePath, warnings };
    }
    const parsed = JSON.parse(fs.readFileSync(filePath, "utf8"));
    const configs = coerceSidecarConfigs(parsed);
    return { configs, source: "file", path: filePath, warnings };
  } catch (err) {
    warnings.push(
      `Could not read sidecar provider manifest ${filePath}: ${err instanceof Error ? err.message : String(err)}`,
    );
    return { configs: [], source: "file", path: filePath, warnings };
  }
}

/** Register sidecar providers from a discovery result, skipping bad entries. */
export function registerSidecarProviders(
  registry: MetadataProviderRegistry,
  configs: SidecarProviderConfig[],
): { registered: string[]; rejected: { id: string; error: string }[] } {
  const registered: string[] = [];
  const rejected: { id: string; error: string }[] = [];
  for (const config of configs) {
    try {
      registry.register(createSidecarProvider(config));
      registered.push(config.id);
    } catch (err) {
      rejected.push({
        id: config.id ?? "(unknown)",
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }
  return { registered, rejected };
}
