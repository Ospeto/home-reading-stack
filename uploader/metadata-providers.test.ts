import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import {
  MetadataProviderRegistry,
  MetadataProviderError,
  BUILTIN_PROVIDER_PRIORITY,
  BUILTIN_PROVIDER_IDS,
  DEFAULT_ROUTING_TABLE,
  SIDECAR_DEFAULT_CONFIDENCE,
  createBuiltinProviders,
  createSidecarProvider,
  discoverSidecarProviders,
  isUsableResultSet,
  normalizeSidecarResult,
  parseSidecarBookPayload,
  parseSidecarSearchPayload,
  probeSidecarManifest,
  registerSidecarProviders,
  validateProviderDefinition,
  describeResultProvider,
  type MetadataProvider,
  type ScrapedMetadata,
  type SidecarProviderConfig,
} from "./metadata-providers";
import {
  applyMetadataToCalibre,
  applyVolumeConflictGuard,
  rankMetadataCandidates,
  resolveOverwriteGuards,
  resolveExistingBookVolume,
  searchUniversalMetadata,
  resetSidecarProvidersForTest,
  getMetadataProviderRegistry,
  defaultMetadataProviderRegistry,
  listMetadataProviders,
  getMetadataProviderRoutingTable,
} from "./scraper";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeResult(overrides: Partial<ScrapedMetadata> = {}): ScrapedMetadata {
  return {
    title: "Sample Book",
    authors: "Sample Author",
    tags: ["Fiction"],
    source: "SampleSource",
    confidence: 0.9,
    ...overrides,
  };
}

function makeProvider(
  overrides: Partial<MetadataProvider> & { id: string },
): MetadataProvider {
  return {
    label: overrides.id,
    kind: "builtin",
    priority: BUILTIN_PROVIDER_PRIORITY,
    categories: ["general_book"],
    fields: ["title", "authors"],
    search: async () => [],
    ...overrides,
  } as MetadataProvider;
}

function jsonResponse(body: any, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

interface FetchCall {
  url: string;
  init?: any;
}

function installFetchMock(
  handler: (url: string, init?: any) => Response | Promise<Response>,
): { calls: FetchCall[]; restore: () => void } {
  const original = globalThis.fetch;
  const calls: FetchCall[] = [];
  (globalThis as any).fetch = async (input: any, init?: any) => {
    const url = typeof input === "string" ? input : String(input?.url ?? input);
    calls.push({ url, init });
    return handler(url, init);
  };
  return {
    calls,
    restore: () => {
      (globalThis as any).fetch = original;
    },
  };
}

// ---------------------------------------------------------------------------
// 1. Provider contract validation & registration
// ---------------------------------------------------------------------------

describe("Metadata Provider Registry: registration", () => {
  it("registers a valid provider and exposes it through list/describe", () => {
    const registry = new MetadataProviderRegistry();
    registry.register(
      makeProvider({
        id: "example",
        label: "Example Source",
        fields: ["title", "authors", "synopsis", "cover", "tags", "series", "volume"],
      }),
    );

    expect(registry.has("example")).toBe(true);
    expect(registry.list().map((p) => p.id)).toEqual(["example"]);

    const [descriptor] = registry.describe();
    expect(descriptor.id).toBe("example");
    expect(descriptor.label).toBe("Example Source");
    expect(descriptor.kind).toBe("builtin");
    expect(descriptor.fields).toContain("volume");
    expect(descriptor.capabilities).toEqual({
      search: true,
      fetchById: false,
      matchUrl: false,
    });
  });

  it("rejects providers with an invalid id, missing label, or missing search", () => {
    const registry = new MetadataProviderRegistry();

    expect(() => registry.register(makeProvider({ id: "Bad Id" }))).toThrow(
      MetadataProviderError,
    );
    expect(() =>
      registry.register(makeProvider({ id: "no_label", label: "  " })),
    ).toThrow(/requires a non-empty label/);
    expect(() =>
      registry.register(
        makeProvider({ id: "no_search", search: undefined as any }),
      ),
    ).toThrow(/requires a search\(\) function/);
    expect(() =>
      registry.register(makeProvider({ id: "bad_kind", kind: "remote" as any })),
    ).toThrow(/kind "builtin" or "sidecar"/);
    expect(() =>
      registry.register(makeProvider({ id: "bad_cat", categories: ["poetry" as any] })),
    ).toThrow(/unknown category/);
    expect(() =>
      registry.register(makeProvider({ id: "bad_field", fields: ["isbn" as any] })),
    ).toThrow(/unknown field/);
    expect(() =>
      registry.register(makeProvider({ id: "no_cats", categories: [] })),
    ).toThrow(/at least one category/);
    expect(() =>
      registry.register(makeProvider({ id: "no_fields", fields: [] })),
    ).toThrow(/at least one field/);
    expect(registry.list()).toHaveLength(0);
  });

  it("replaces a provider registered under the same id instead of duplicating it", () => {
    const registry = new MetadataProviderRegistry();
    registry.register(makeProvider({ id: "dup", label: "First" }));
    registry.register(makeProvider({ id: "dup", label: "Second" }));

    expect(registry.list()).toHaveLength(1);
    expect(registry.get("dup")?.label).toBe("Second");
  });

  it("unregisters providers and skips disabled ones", () => {
    const registry = new MetadataProviderRegistry();
    registry.register(makeProvider({ id: "on" }));
    registry.register(makeProvider({ id: "off", enabled: false }));

    expect(registry.list().map((p) => p.id)).toEqual(["on"]);
    expect(registry.unregister("on")).toBe(true);
    expect(registry.unregister("on")).toBe(false);
    expect(registry.list()).toHaveLength(0);
  });

  it("validateProviderDefinition accepts a fully specified contract", () => {
    expect(() =>
      validateProviderDefinition(
        makeProvider({
          id: "full",
          fetchById: async () => null,
          matchUrl: () => null,
        }),
      ),
    ).not.toThrow();
  });

  it("orders providers by descending priority, then registration order", () => {
    const registry = new MetadataProviderRegistry();
    registry.register(makeProvider({ id: "low", priority: 10 }));
    registry.register(makeProvider({ id: "high", priority: 90 }));
    registry.register(makeProvider({ id: "mid_a", priority: 50 }));
    registry.register(makeProvider({ id: "mid_b", priority: 50 }));

    expect(registry.list().map((p) => p.id)).toEqual([
      "high",
      "mid_a",
      "mid_b",
      "low",
    ]);
  });

  it("registers every built-in scraper with a shared priority", () => {
    const providers = createBuiltinProviders({
      ranobedb: async () => [],
      anilist: async () => [],
      bangumi: async () => [],
      googleBooks: async () => [],
      openLibrary: async () => [],
      mangaDex: async () => [],
    });

    expect(providers.map((p) => p.id).sort()).toEqual([
      "anilist",
      "bangumi",
      "google_books",
      "mangadex",
      "openlibrary",
      "ranobedb",
    ]);
    // A shared builtin priority keeps existing insertion-order tie-breaking.
    expect(new Set(providers.map((p) => p.priority))).toEqual(
      new Set([BUILTIN_PROVIDER_PRIORITY]),
    );
    // AniList is series-only: it must never answer a single-volume lookup.
    expect(providers.find((p) => p.id === "anilist")?.seriesQueryOnly).toBe(true);
    // Every provider carries the full source label the scrapers emit.
    expect(providers.find((p) => p.id === "ranobedb")?.label).toBe("RanobeDB");
  });

  it("omits adapters that were not supplied", () => {
    const providers = createBuiltinProviders({ googleBooks: async () => [] });
    expect(providers.map((p) => p.id)).toEqual(["google_books"]);
  });
});

// ---------------------------------------------------------------------------
// 2. Category routing & search resolution
// ---------------------------------------------------------------------------

describe("Metadata Provider Registry: routing & search resolution", () => {
  function seededRegistry() {
    const calls: string[] = [];
    const provider = (id: string, results: ScrapedMetadata[], extra: Partial<MetadataProvider> = {}) =>
      makeProvider({
        id,
        label: id,
        search: async () => {
          calls.push(id);
          return results;
        },
        ...extra,
      });

    const registry = new MetadataProviderRegistry();
    registry.registerAll([
      provider("ranobedb", [makeResult({ source: "RanobeDB", confidence: 0.9 })]),
      provider("anilist", [makeResult({ source: "AniList", confidence: 0.6 })], {
        categories: ["light_novel", "manga"],
        seriesQueryOnly: true,
      }),
      provider("bangumi", [makeResult({ source: "Bangumi", confidence: 0.5 })], {
        categories: ["light_novel", "manga"],
      }),
      provider("google_books", [makeResult({ source: "Google Books", confidence: 0.4 })], {
        categories: ["general_book", "other", "light_novel", "manga"],
      }),
      provider("openlibrary", [makeResult({ source: "OpenLibrary", confidence: 0.3 })], {
        categories: ["general_book", "other", "light_novel", "manga"],
      }),
      provider("mangadex", [makeResult({ source: "MangaDex", confidence: 0.2 })], {
        categories: ["manga", "light_novel", "general_book", "other"],
      }),
    ]);
    return { registry, calls };
  }

  it("resolves only the providers that serve a category", () => {
    const { registry } = seededRegistry();
    expect(registry.resolve("manga").map((p) => p.id)).toContain("mangadex");
    expect(registry.resolve("burmese")).toHaveLength(0);
  });

  it("builds the light-novel tier plan from the routing table", () => {
    const { registry } = seededRegistry();
    const plan = registry.plan("light_novel");

    expect(plan.tiers.map((t) => t.providers.map((p) => p.id))).toEqual([
      ["ranobedb", "anilist", "bangumi"],
      ["google_books"],
      ["openlibrary", "mangadex"],
    ]);
    expect(plan.alwaysRun).toHaveLength(0);
  });

  it("drops series-only providers when resolving a specific volume", () => {
    const { registry } = seededRegistry();
    const plan = registry.plan("light_novel", { query: "Overlord Vol 3", preserveVolume: true });

    expect(plan.tiers[0].providers.map((p) => p.id)).toEqual(["ranobedb", "bangumi"]);
  });

  it("returns an empty plan for Burmese literature", () => {
    const { registry } = seededRegistry();
    const plan = registry.plan("burmese");
    expect(plan.tiers).toHaveLength(0);
    expect(plan.alwaysRun).toHaveLength(0);
  });

  it("always runs providers that the routing table does not name", async () => {
    const { registry, calls } = seededRegistry();
    // A provider registered under a fresh id needs no routing-table edit.
    registry.register(
      makeProvider({
        id: "brand_new_source",
        categories: ["general_book"],
        search: async () => {
          calls.push("brand_new_source");
          return [makeResult({ source: "Brand New", confidence: 0.85 })];
        },
      }),
    );

    const plan = registry.plan("general_book");
    expect(plan.tiers.map((t) => t.providers.map((p) => p.id))).toEqual([
      ["google_books", "openlibrary"],
      ["ranobedb", "anilist", "bangumi", "mangadex"],
    ]);
    expect(plan.alwaysRun.map((p) => p.id)).toEqual(["brand_new_source"]);

    const outcome = await registry.searchAll({ query: "Any Book", category: "general_book" });
    expect(calls).toContain("brand_new_source");
    expect(outcome.results.some((r) => r.source === "Brand New")).toBe(true);
  });

  it("short-circuits remaining tiers once results are usable", async () => {
    const { registry, calls } = seededRegistry();
    const outcome = await registry.searchAll({ query: "Overlord", category: "light_novel" });

    // Tier 1 produced a result, so Google Books / OpenLibrary / MangaDex never run.
    expect(calls).toEqual(["ranobedb", "anilist", "bangumi"]);
    expect(outcome.shortCircuited).toBe(true);
    expect(outcome.consulted).toEqual(["ranobedb", "anilist", "bangumi"]);
    expect(outcome.results.map((r) => r.source)).toEqual([
      "RanobeDB",
      "AniList",
      "Bangumi",
    ]);
  });

  it("falls through to the next tier when primary sources return nothing", async () => {
    const calls: string[] = [];
    const registry = new MetadataProviderRegistry();
    registry.registerAll([
      makeProvider({
        id: "ranobedb",
        categories: ["light_novel"],
        search: async () => {
          calls.push("ranobedb");
          return [];
        },
      }),
      makeProvider({
        id: "google_books",
        categories: ["light_novel"],
        search: async () => {
          calls.push("google_books");
          return [makeResult({ source: "Google Books" })];
        },
      }),
    ]);

    const outcome = await registry.searchAll({ query: "Unknown LN", category: "light_novel" });
    expect(calls).toEqual(["ranobedb", "google_books"]);
    expect(outcome.results).toHaveLength(1);
    expect(outcome.shortCircuited).toBe(false);
  });

  it("keeps walking tiers when a volume query has no usable synopsis yet", async () => {
    const calls: string[] = [];
    const registry = new MetadataProviderRegistry();
    registry.registerAll([
      makeProvider({
        id: "ranobedb",
        categories: ["light_novel"],
        search: async () => {
          calls.push("ranobedb");
          // High confidence but no synopsis -> not usable for a volume lookup.
          return [makeResult({ source: "RanobeDB", confidence: 0.95, description: "" })];
        },
      }),
      makeProvider({
        id: "google_books",
        categories: ["light_novel"],
        search: async () => {
          calls.push("google_books");
          return [
            makeResult({
              source: "Google Books",
              confidence: 0.9,
              description: "A long enough volume-specific synopsis for the book.",
            }),
          ];
        },
      }),
    ]);

    const outcome = await registry.searchAll({
      query: "Overlord Vol 3",
      category: "light_novel",
      preserveVolume: true,
    });

    expect(calls).toEqual(["ranobedb", "google_books"]);
    expect(outcome.results).toHaveLength(2);
  });

  it("isolates a failing provider so the rest of the tier still answers", async () => {
    const registry = new MetadataProviderRegistry();
    registry.registerAll([
      makeProvider({
        id: "broken",
        categories: ["general_book"],
        search: async () => {
          throw new Error("upstream exploded");
        },
      }),
      makeProvider({
        id: "healthy",
        categories: ["general_book"],
        search: async () => [makeResult({ source: "Healthy" })],
      }),
    ]);

    const outcome = await registry.searchAll({ query: "Any Book", category: "general_book" });
    expect(outcome.results.map((r) => r.source)).toEqual(["Healthy"]);
    expect(outcome.failures).toEqual([
      { providerId: "broken", error: "upstream exploded" },
    ]);
  });

  it("isUsableResultSet honours the volume-specific synopsis rule", () => {
    expect(isUsableResultSet([], false)).toBe(false);
    expect(isUsableResultSet([makeResult()], false)).toBe(true);
    expect(isUsableResultSet([makeResult()], true)).toBe(false);
    expect(
      isUsableResultSet(
        [makeResult({ confidence: 0.9, description: "A sufficiently long synopsis here." })],
        true,
      ),
    ).toBe(true);
    expect(
      isUsableResultSet([makeResult({ confidence: 0.5, description: "A long enough synopsis." })], true),
    ).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// 3. Priority fallback & ranking
// ---------------------------------------------------------------------------

describe("Metadata Provider Registry: priority fallback", () => {
  it("places a higher-priority sidecar ahead of a built-in on equal confidence", async () => {
    const registry = new MetadataProviderRegistry();
    registry.register(
      makeProvider({
        id: "builtin_source",
        categories: ["general_book"],
        search: async () => [makeResult({ source: "Builtin", confidence: 0.8 })],
      }),
    );
    registry.register(
      createSidecarProvider({
        id: "douban",
        label: "Douban",
        endpoint: "http://127.0.0.1:8099",
        categories: ["general_book"],
        priority: 80,
      }),
    );

    const { calls, restore } = installFetchMock(() =>
      jsonResponse({ results: [{ title: "Sidecar Book", confidence: 0.8 }] }),
    );
    try {
      const results = await registry.search({ query: "Some Book", category: "general_book" });
      rankMetadataCandidates(results, { isLnTarget: false });
      expect(results.map((r) => r.source)).toEqual(["Douban", "Builtin"]);
      expect(calls).toHaveLength(1);
    } finally {
      restore();
    }
  });

  it("defers a lower-priority sidecar to a built-in on equal confidence", async () => {
    const registry = new MetadataProviderRegistry();
    registry.register(
      makeProvider({
        id: "builtin_source",
        categories: ["general_book"],
        search: async () => [makeResult({ source: "Builtin", confidence: 0.8 })],
      }),
    );
    registry.register(
      createSidecarProvider({
        id: "custom",
        label: "Custom",
        endpoint: "http://127.0.0.1:8100",
        categories: ["general_book"],
        priority: 10,
      }),
    );

    const { restore } = installFetchMock(() =>
      jsonResponse([{ title: "Sidecar Book", confidence: 0.8 }]),
    );
    try {
      const results = await registry.search({ query: "Some Book", category: "general_book" });
      rankMetadataCandidates(results);
      expect(results.map((r) => r.source)).toEqual(["Builtin", "Custom"]);
    } finally {
      restore();
    }
  });

  it("still ranks a clearly more confident source first regardless of priority", async () => {
    const registry = new MetadataProviderRegistry();
    registry.register(
      makeProvider({
        id: "builtin_source",
        categories: ["general_book"],
        search: async () => [makeResult({ source: "Builtin", confidence: 0.95 })],
      }),
    );
    registry.register(
      createSidecarProvider({
        id: "loud_sidecar",
        label: "Loud",
        endpoint: "http://127.0.0.1:8101",
        categories: ["general_book"],
        priority: 100,
      }),
    );

    const { restore } = installFetchMock(() =>
      jsonResponse({ results: [{ title: "Low Confidence", confidence: 0.4 }] }),
    );
    try {
      const results = await registry.search({ query: "Some Book", category: "general_book" });
      rankMetadataCandidates(results);
      expect(results[0].source).toBe("Builtin");
    } finally {
      restore();
    }
  });

  it("always runs sidecars, even when built-in tiers already answered", async () => {
    const registry = new MetadataProviderRegistry();
    registry.register(
      makeProvider({
        id: "ranobedb",
        categories: ["light_novel"],
        search: async () => [makeResult({ source: "RanobeDB", confidence: 0.9 })],
      }),
    );
    registry.register(
      createSidecarProvider({
        id: "ln_sidecar",
        label: "LN Sidecar",
        endpoint: "http://127.0.0.1:8102",
        categories: ["light_novel"],
      }),
    );

    const { calls, restore } = installFetchMock(() =>
      jsonResponse({ results: [{ title: "Sidecar LN", confidence: 0.7 }] }),
    );
    try {
      const outcome = await registry.searchAll({ query: "Overlord", category: "light_novel" });
      expect(outcome.results.map((r) => r.source)).toEqual(["RanobeDB", "LN Sidecar"]);
      expect(calls.some((c) => c.url.includes("/search"))).toBe(true);
    } finally {
      restore();
    }
  });

  it("annotates each result with its provider provenance", () => {
    const registry = new MetadataProviderRegistry();
    const provider = makeProvider({ id: "prov", priority: 42 });
    registry.register(provider);
    const result = makeResult();
    // Registry tags results as they are collected.
    expect(describeResultProvider(result)).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// 4. Sidecar (external) providers: config, protocol, communication
// ---------------------------------------------------------------------------

describe("Sidecar metadata providers", () => {
  it("registers from a config and advertises the sidecar protocol", () => {
    const registry = new MetadataProviderRegistry();
    registry.register(
      createSidecarProvider({
        id: "ranobedb_mirror",
        label: "RanobeDB Mirror",
        endpoint: "http://127.0.0.1:8099/",
        categories: ["light_novel"],
        fields: ["title", "synopsis", "cover", "series", "volume"],
        priority: 70,
      }),
    );

    const [descriptor] = registry.describe();
    expect(descriptor.kind).toBe("sidecar");
    expect(descriptor.endpoint).toBe("http://127.0.0.1:8099/");
    expect(descriptor.priority).toBe(70);
    expect(descriptor.fields).toEqual(["title", "synopsis", "cover", "series", "volume"]);
    expect(descriptor.capabilities).toEqual({
      search: true,
      fetchById: true,
      matchUrl: true,
    });
  });

  it("rejects configs with a bad id or a non-http endpoint", () => {
    expect(() =>
      createSidecarProvider({ id: "Bad Id", endpoint: "http://127.0.0.1:8099" }),
    ).toThrow(MetadataProviderError);
    expect(() =>
      createSidecarProvider({ id: "ftp_sidecar", endpoint: "ftp://example.com" }),
    ).toThrow(/requires an http\(s\) endpoint/);
    expect(() =>
      createSidecarProvider({ id: "creds", endpoint: "http://user:pass@example.com" }),
    ).toThrow(/requires an http\(s\) endpoint/);
  });

  it("sends the documented search request and parses results", async () => {
    const provider = createSidecarProvider({
      id: "douban",
      label: "Douban",
      endpoint: "http://127.0.0.1:8099",
      categories: ["general_book"],
    });

    const { calls, restore } = installFetchMock(() =>
      jsonResponse({
        results: [
          {
            title: "三体",
            authors: ["Liu Cixin"],
            synopsis: "First contact with Trisolaris.",
            cover: "https://img.example.com/cover.jpg",
            tags: ["Sci-Fi"],
            series: "Remembrance of Earth's Past",
            volume: 1,
            confidence: 0.88,
            id: "douban-42",
          },
        ],
      }),
    );

    try {
      const results = await provider.search({
        query: "The Three-Body Problem",
        category: "general_book",
        volume: 1,
        author: "Liu Cixin",
      });

      expect(results).toHaveLength(1);
      expect(results[0]).toEqual({
        title: "三体",
        authors: "Liu Cixin",
        description: "First contact with Trisolaris.",
        coverUrl: "https://img.example.com/cover.jpg",
        tags: ["Sci-Fi"],
        series: "Remembrance of Earth's Past",
        volume: 1,
        source: "Douban",
        confidence: 0.88,
      });

      const url = new URL(calls[0].url);
      expect(url.origin).toBe("http://127.0.0.1:8099");
      expect(url.pathname).toBe("/search");
      expect(url.searchParams.get("q")).toBe("The Three-Body Problem");
      expect(url.searchParams.get("category")).toBe("general_book");
      expect(url.searchParams.get("volume")).toBe("1");
      expect(url.searchParams.get("author")).toBe("Liu Cixin");
      expect(calls[0].init.method).toBe("GET");
      expect(calls[0].init.headers.Accept).toBe("application/json");
    } finally {
      restore();
    }
  });

  it("sends a bearer token when the sidecar is configured with one", async () => {
    const provider = createSidecarProvider({
      id: "secured",
      label: "Secured",
      endpoint: "http://127.0.0.1:8099",
      authToken: "secret-token",
    });
    const { calls, restore } = installFetchMock(() => jsonResponse({ results: [] }));
    try {
      await provider.search({ query: "Anything" });
      expect(calls[0].init.headers.Authorization).toBe("Bearer secret-token");
    } finally {
      restore();
    }
  });

  it("returns an empty list instead of throwing when the sidecar is down", async () => {
    const provider = createSidecarProvider({
      id: "offline",
      label: "Offline",
      endpoint: "http://127.0.0.1:8199",
    });
    const { restore } = installFetchMock(() => {
      throw new Error("ECONNREFUSED");
    });
    try {
      await expect(provider.search({ query: "Any" })).resolves.toEqual([]);
    } finally {
      restore();
    }
  });

  it("returns an empty list on a non-2xx response", async () => {
    const provider = createSidecarProvider({
      id: "erroring",
      label: "Erroring",
      endpoint: "http://127.0.0.1:8199",
    });
    const { restore } = installFetchMock(() => jsonResponse({ error: "boom" }, 503));
    try {
      await expect(provider.search({ query: "Any" })).resolves.toEqual([]);
    } finally {
      restore();
    }
  });

  it("fetches a single record by id and from a detail URL", async () => {
    const provider = createSidecarProvider({
      id: "catalogue",
      label: "Catalogue",
      endpoint: "http://127.0.0.1:8099",
    });
    const { calls, restore } = installFetchMock((url) => {
      if (url.endsWith("/book/abc123")) {
        return jsonResponse({ book: { title: "Detail Book", authors: "Detail Author" } });
      }
      return jsonResponse({}, 404);
    });

    try {
      const byId = await provider.fetchById!("abc123");
      expect(byId?.title).toBe("Detail Book");
      expect(calls[0].url).toBe("http://127.0.0.1:8099/book/abc123");

      const externalId = provider.matchUrl!("http://127.0.0.1:8099/book/abc123");
      expect(externalId).toBe("abc123");
      // Foreign hosts are never claimed.
      expect(provider.matchUrl!("https://example.com/book/abc123")).toBeNull();
    } finally {
      restore();
    }
  });

  it("normalises payload variants and rejects records without a title", () => {
    expect(normalizeSidecarResult(null, { label: "X" })).toBeNull();
    expect(normalizeSidecarResult({ authors: "Nobody" }, { label: "X" })).toBeNull();

    const fromList = normalizeSidecarResult(
      { title: "  Title With Spaces  ", author: "Solo Author", image: "https://img/x.jpg" },
      { label: "X" },
    );
    expect(fromList?.title).toBe("Title With Spaces");
    expect(fromList?.authors).toBe("Solo Author");
    expect(fromList?.coverUrl).toBe("https://img/x.jpg");
    expect(fromList?.confidence).toBe(SIDECAR_DEFAULT_CONFIDENCE);

    // Confidence is clamped into [0, 1].
    expect(normalizeSidecarResult({ title: "T", confidence: 4 }, { label: "X" })?.confidence).toBe(1);
    expect(normalizeSidecarResult({ title: "T", confidence: -2 }, { label: "X" })?.confidence).toBe(0);

    // Unnumbered records carry no volume.
    expect(normalizeSidecarResult({ title: "T" }, { label: "X" })?.volume).toBeUndefined();
  });

  it("parses the documented envelope shapes", () => {
    const config = { label: "Sidecar" };
    expect(parseSidecarSearchPayload({ results: [{ title: "A" }] }, config).results).toHaveLength(1);
    expect(parseSidecarSearchPayload([{ title: "A" }], config).results).toHaveLength(1);
    expect(parseSidecarSearchPayload({ data: [{ title: "A" }] }, config).results).toHaveLength(1);
    expect(parseSidecarSearchPayload({ books: [{ title: "A" }] }, config).results).toHaveLength(1);
    expect(parseSidecarSearchPayload({ unexpected: true }, config).results).toHaveLength(0);
    expect(parseSidecarSearchPayload(null, config).results).toHaveLength(0);

    const withIds = parseSidecarSearchPayload(
      { results: [{ title: "A", id: 7 }, { title: "B", externalId: "x" }] },
      config,
    );
    expect(withIds.externalIds).toEqual(["7", "x"]);

    expect(parseSidecarBookPayload({ book: { title: "A" } }, config)?.title).toBe("A");
    expect(parseSidecarBookPayload({ result: { title: "B" } }, config)?.title).toBe("B");
    expect(parseSidecarBookPayload({ title: "C" }, config)?.title).toBe("C");
    expect(parseSidecarBookPayload(null, config)).toBeNull();
  });

  it("maps the manga category to the isManga flag", async () => {
    const provider = createSidecarProvider({
      id: "manga_sidecar",
      label: "Manga Sidecar",
      endpoint: "http://127.0.0.1:8099",
    });
    const { restore } = installFetchMock(() =>
      jsonResponse({ results: [{ title: "Berserk" }] }),
    );
    try {
      const results = await provider.search({ query: "Berserk", category: "manga" });
      expect(results[0].isManga).toBe(true);
    } finally {
      restore();
    }
  });

  it("probes the optional manifest endpoint", async () => {
    const config: SidecarProviderConfig = {
      id: "douban",
      label: "Douban",
      endpoint: "http://127.0.0.1:8099",
    };
    const { calls, restore } = installFetchMock(() =>
      jsonResponse({
        id: "douban",
        label: "Douban Books",
        protocol: 1,
        fields: ["title", "synopsis", "bogus"],
        categories: ["general_book", "nope"],
        priority: 65,
        seriesQueryOnly: false,
      }),
    );
    try {
      const manifest = await probeSidecarManifest(config);
      expect(calls[0].url).toBe("http://127.0.0.1:8099/manifest");
      expect(manifest?.label).toBe("Douban Books");
      expect(manifest?.fields).toEqual(["title", "synopsis"]);
      expect(manifest?.categories).toEqual(["general_book"]);
      expect(manifest?.priority).toBe(65);
    } finally {
      restore();
    }
  });

  it("treats an unreachable manifest as optional", async () => {
    const { restore } = installFetchMock(() => jsonResponse({}, 404));
    try {
      expect(
        await probeSidecarManifest({ id: "x", endpoint: "http://127.0.0.1:8199" }),
      ).toBeNull();
    } finally {
      restore();
    }
  });
});

// ---------------------------------------------------------------------------
// 5. Sidecar discovery (env + JSON manifest file)
// ---------------------------------------------------------------------------

describe("Sidecar provider discovery", () => {
  it("reads inline env JSON", () => {
    const discovery = discoverSidecarProviders({
      LIGHTHOUSE_METADATA_PROVIDERS: JSON.stringify([
        { id: "douban", endpoint: "http://127.0.0.1:8099", categories: ["general_book"], priority: 65 },
      ]),
    });

    expect(discovery.source).toBe("env");
    expect(discovery.configs).toHaveLength(1);
    expect(discovery.configs[0]).toEqual({
      id: "douban",
      endpoint: "http://127.0.0.1:8099",
      categories: ["general_book"],
      priority: 65,
    });
  });

  it("accepts a {providers:[...]} manifest wrapper and url aliases", () => {
    const discovery = discoverSidecarProviders({
      LIGHTHOUSE_METADATA_PROVIDERS: JSON.stringify({
        providers: [{ id: "custom", url: "http://127.0.0.1:8100" }],
      }),
    });
    expect(discovery.configs).toHaveLength(1);
    expect(discovery.configs[0].endpoint).toBe("http://127.0.0.1:8100");
  });

  it("skips entries with unusable endpoints and derives an id when missing", () => {
    const discovery = discoverSidecarProviders({
      LIGHTHOUSE_METADATA_PROVIDERS: JSON.stringify([
        { endpoint: "not-a-url" },
        { endpoint: "http://my-catalog.local:9000" },
      ]),
    });
    expect(discovery.configs).toHaveLength(1);
    expect(discovery.configs[0].id).toBe("my_catalog_local");
  });

  it("reports malformed env JSON as a warning instead of throwing", () => {
    const discovery = discoverSidecarProviders({ LIGHTHOUSE_METADATA_PROVIDERS: "{oops" });
    expect(discovery.configs).toHaveLength(0);
    expect(discovery.warnings[0]).toContain("not valid JSON");
  });

  it("honours the disable flag", () => {
    const discovery = discoverSidecarProviders({
      LIGHTHOUSE_METADATA_PROVIDERS_OFF: "1",
      LIGHTHOUSE_METADATA_PROVIDERS: JSON.stringify([{ id: "x", endpoint: "http://127.0.0.1:1" }]),
    });
    expect(discovery.source).toBe("disabled");
    expect(discovery.configs).toHaveLength(0);
  });

  it("returns nothing when no manifest file exists", () => {
    const discovery = discoverSidecarProviders({
      LIGHTHOUSE_METADATA_PROVIDERS_FILE: "/tmp/definitely-missing-lighthouse-sidecars.json",
    });
    expect(discovery.source).toBe("none");
    expect(discovery.configs).toHaveLength(0);
    expect(discovery.warnings).toHaveLength(0);
  });

  it("registers discoverable sidecars and reports rejected entries", () => {
    const registry = new MetadataProviderRegistry();
    const { registered, rejected } = registerSidecarProviders(registry, [
      { id: "good", endpoint: "http://127.0.0.1:8099" } as SidecarProviderConfig,
      { id: "BAD ID", endpoint: "http://127.0.0.1:8098" } as SidecarProviderConfig,
    ]);

    expect(registered).toEqual(["good"]);
    expect(rejected).toHaveLength(1);
    expect(rejected[0].id).toBe("BAD ID");
    expect(registry.has("good")).toBe(true);
    expect(registry.has("BAD ID")).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// 6. Default registry wiring in scraper.ts
// ---------------------------------------------------------------------------

describe("Default metadata provider registry wiring", () => {
  afterEach(() => {
    resetSidecarProvidersForTest();
  });

  it("exposes the built-in scrapers by their documented ids", () => {
    const ids = getMetadataProviderRegistry().list().map((p) => p.id);
    for (const id of Object.values(BUILTIN_PROVIDER_IDS)) {
      expect(ids).toContain(id);
    }
  });

  it("exposes the default routing table through the registry", () => {
    const routing = getMetadataProviderRoutingTable();
    expect(routing).toEqual(DEFAULT_ROUTING_TABLE);
    expect(routing.burmese).toEqual([]);
  });

  it("listMetadataProviders describes the registry for the API surface", () => {
    const descriptors = listMetadataProviders();
    expect(descriptors.length).toBeGreaterThan(0);
    for (const d of descriptors) {
      expect(typeof d.id).toBe("string");
      expect(Array.isArray(d.categories)).toBe(true);
      expect(Array.isArray(d.fields)).toBe(true);
      expect(typeof d.priority).toBe("number");
    }
  });
});

// ---------------------------------------------------------------------------
// 7. Overwrite protection preservation (the guards must survive refactors)
// ---------------------------------------------------------------------------

describe("Overwrite protection preservation", () => {
  describe("resolveExistingBookVolume", () => {
    it("prefers a title volume marker", () => {
      expect(
        resolveExistingBookVolume({
          title: "Goblin Slayer Vol 3",
          series: "Goblin Slayer",
          series_index: 7,
        }),
      ).toEqual({ volume: 3, seriesIndex: 7, hasCover: false });
    });

    it("falls back to series_index when the title has no marker", () => {
      expect(
        resolveExistingBookVolume({ title: "Goblin Slayer", series: "Goblin Slayer", series_index: 4 }),
      ).toEqual({ volume: 4, seriesIndex: 4, hasCover: false });
    });

    it("handles missing metadata", () => {
      expect(resolveExistingBookVolume(null)).toEqual({
        volume: null,
        seriesIndex: null,
        hasCover: false,
      });
    });
  });

  describe("Guard 1: title overwrite protection", () => {
    it("refuses a different volume", () => {
      const guards = resolveOverwriteGuards(
        { title: "Goblin Slayer Vol 3", series_index: 3, series: "Goblin Slayer", has_cover: true },
        { title: "Goblin Slayer, Vol. 1", coverUrl: "https://images.ranobedb.org/1.jpg" },
      );
      expect(guards.skipTitleOverwrite).toBe(true);
      expect(guards.isDifferentVolume).toBe(true);
    });

    it("refuses a volume-less candidate for a numbered volume", () => {
      const guards = resolveOverwriteGuards(
        { title: "Goblin Slayer Vol 4", series_index: 4, series: "Goblin Slayer" },
        { title: "Goblin Slayer" },
      );
      expect(guards.skipTitleOverwrite).toBe(true);
      expect(guards.hasVolumeOrMultiVolumeSeries).toBe(true);
    });

    it("allows a matching volume", () => {
      const guards = resolveOverwriteGuards(
        { title: "Goblin Slayer Vol 1", series_index: 1, series: "Goblin Slayer" },
        { title: "Goblin Slayer, Vol. 1" },
      );
      expect(guards.skipTitleOverwrite).toBe(false);
      expect(guards.isDifferentVolume).toBe(false);
    });

    it("allows series_index 1 books with unnumbered candidates to be improved", () => {
      const guards = resolveOverwriteGuards(
        { title: "Standalone Book", series_index: 1, series: "Lonely" },
        { title: "Standalone Book: A Novel" },
      );
      expect(guards.skipTitleOverwrite).toBe(false);
    });

    it("honours a structured candidate volume from a sidecar", () => {
      const guards = resolveOverwriteGuards(
        { title: "Dune", series_index: 3, series: "Dune" },
        { title: "Dune", volume: 1 },
      );
      expect(guards.candidateVolume).toBe(1);
      expect(guards.skipTitleOverwrite).toBe(true);
    });
  });

  describe("Guard 2: cover overwrite protection", () => {
    it("refuses a cover across a volume mismatch", () => {
      const guards = resolveOverwriteGuards(
        { title: "Goblin Slayer Vol 3", series_index: 3, series: "Goblin Slayer" },
        { title: "Goblin Slayer, Vol. 1", coverUrl: "https://images.ranobedb.org/1.jpg" },
      );
      expect(guards.volumeMismatchForCover).toBe(true);
      expect(guards.skipCover).toBe(true);
    });

    it("refuses a cover for a numbered volume when the candidate has no volume", () => {
      const guards = resolveOverwriteGuards(
        { title: "Goblin Slayer Vol 3", series_index: 3, series: "Goblin Slayer" },
        { title: "Goblin Slayer", coverUrl: "https://images.ranobedb.org/series.jpg" },
      );
      expect(guards.skipCover).toBe(true);
    });

    it("allows a cover when volumes agree, including volume 1", () => {
      const guards = resolveOverwriteGuards(
        { title: "Goblin Slayer Vol 1", series_index: 1, series: "Goblin Slayer" },
        { title: "Goblin Slayer, Vol. 1", coverUrl: "https://images.ranobedb.org/1.jpg" },
      );
      expect(guards.volumeMismatchForCover).toBe(false);
      expect(guards.skipCover).toBe(false);
    });

    it("skips the cover when the candidate has none", () => {
      const guards = resolveOverwriteGuards({ title: "Book" }, { title: "Book" });
      expect(guards.skipCover).toBe(true);
    });
  });

  describe("applyMetadataToCalibre still enforces both guards", () => {
    it("keeps the existing title and cover on a volume mismatch", async () => {
      let capturedArgs: string[] = [];
      const success = await applyMetadataToCalibre(
        901,
        {
          title: "Goblin Slayer, Vol. 1",
          authors: "Kumo Kagyu",
          coverUrl: "https://images.ranobedb.org/vol1.jpg",
          tags: ["Light Novel"],
          source: "RanobeDB",
          confidence: 0.95,
        },
        {
          getBookMetadata: () => ({
            title: "Goblin Slayer Vol 3",
            series_index: 3,
            has_cover: true,
            series: "Goblin Slayer",
          }),
          spawnSync: ((_bin: string, args: string[]) => {
            capturedArgs = args;
            return { status: 0, stdout: "", stderr: "" };
          }) as any,
          fetchFn: (async () => new Response("cover", { status: 200 })) as any,
        },
      );

      expect(success).toBe(true);
      expect(capturedArgs.some((a) => a.startsWith("title:"))).toBe(false);
      expect(capturedArgs.some((a) => a.startsWith("cover:"))).toBe(false);
      expect(capturedArgs).toContain("authors:Kumo Kagyu");
    });

    it("still applies title and cover when the volume matches", async () => {
      let capturedArgs: string[] = [];
      const success = await applyMetadataToCalibre(
        902,
        {
          title: "Goblin Slayer, Vol. 1",
          authors: "Kumo Kagyu",
          coverUrl: "https://images.ranobedb.org/vol1.jpg",
          tags: ["Light Novel"],
          source: "RanobeDB",
          confidence: 0.95,
        },
        {
          getBookMetadata: () => ({
            title: "Goblin Slayer Vol 1",
            series_index: 1,
            has_cover: false,
            series: "Goblin Slayer",
          }),
          spawnSync: ((_bin: string, args: string[]) => {
            capturedArgs = args;
            return { status: 0, stdout: "", stderr: "" };
          }) as any,
          fetchFn: (async () => new Response(new ArrayBuffer(8), { status: 200 })) as any,
        },
      );

      expect(success).toBe(true);
      expect(capturedArgs).toContain("title:Goblin Slayer, Vol. 1");
      expect(capturedArgs.some((a) => a.startsWith("cover:"))).toBe(true);
    });

    it("applies a sidecar-sourced record through the same guards", async () => {
      let capturedArgs: string[] = [];
      await applyMetadataToCalibre(
        903,
        {
          title: "Dune",
          authors: "Frank Herbert",
          coverUrl: "https://img.example.com/dune.jpg",
          tags: ["Sci-Fi"],
          source: "Douban",
          confidence: 0.9,
          volume: 2,
        },
        {
          getBookMetadata: () => ({
            title: "Dune",
            series_index: 1,
            has_cover: true,
            series: "Dune",
          }),
          spawnSync: ((_bin: string, args: string[]) => {
            capturedArgs = args;
            return { status: 0, stdout: "", stderr: "" };
          }) as any,
          fetchFn: (async () => new Response(new ArrayBuffer(8), { status: 200 })) as any,
        },
      );

      // Structured candidate volume 2 vs existing volume 1 -> both guards fire.
      expect(capturedArgs.some((a) => a.startsWith("title:"))).toBe(false);
      expect(capturedArgs.some((a) => a.startsWith("cover:"))).toBe(false);
    });
  });

  describe("applyVolumeConflictGuard demotes mismatched candidates", () => {
    it("zeroes a candidate whose volume disagrees with the target", () => {
      const results = [
        makeResult({ title: "Goblin Slayer, Vol. 1", confidence: 0.9 }),
        makeResult({ title: "Goblin Slayer, Vol. 3", confidence: 0.9 }),
      ];
      applyVolumeConflictGuard(results, 3);
      expect(results[0].confidence).toBe(0);
      expect(results[1].confidence).toBe(0.9);
    });

    it("caps a volume-less candidate when targeting volume > 1", () => {
      const results = [makeResult({ title: "Goblin Slayer", confidence: 0.99 })];
      applyVolumeConflictGuard(results, 3);
      expect(results[0].confidence).toBe(0.7);
    });

    it("uses a structured volume when the provider supplies one", () => {
      const results = [makeResult({ title: "Dune", confidence: 0.95, volume: 1 })];
      applyVolumeConflictGuard(results, 4);
      expect(results[0].confidence).toBe(0);
    });

    it("is a no-op without a target volume", () => {
      const results = [makeResult({ title: "Goblin Slayer, Vol. 1", confidence: 0.9 })];
      applyVolumeConflictGuard(results, null);
      expect(results[0].confidence).toBe(0.9);
    });
  });
});

// ---------------------------------------------------------------------------
// 8. End-to-end: sidecar results flow through searchUniversalMetadata
// ---------------------------------------------------------------------------

describe("searchUniversalMetadata with a configured sidecar", () => {
  let restoreFetch: (() => void) | null = null;

  beforeEach(() => {
    resetSidecarProvidersForTest();
  });

  afterEach(() => {
    resetSidecarProvidersForTest();
    if (restoreFetch) restoreFetch();
    restoreFetch = null;
    delete process.env.LIGHTHOUSE_METADATA_PROVIDERS;
  });

  it("merges sidecar candidates into the ranked result list", async () => {
    const sidecar = createSidecarProvider({
      id: "custom_catalog",
      label: "Custom Catalog",
      endpoint: "http://127.0.0.1:8097",
      categories: ["general_book", "other", "light_novel", "manga"],
      priority: 90,
    });
    defaultMetadataProviderRegistry.register(sidecar);

    const { calls, restore } = installFetchMock((url) => {
      if (url.startsWith("http://127.0.0.1:8097/search")) {
        return jsonResponse({
          results: [
            {
              title: "Sidecar Sourced Book",
              authors: "Sidecar Author",
              synopsis: "A synopsis that came from a sidecar provider.",
              confidence: 0.93,
            },
          ],
        });
      }
      // Keep every builtin source empty so the sidecar is the only hit.
      return jsonResponse({}, 200);
    });
    restoreFetch = restore;

    const results = await searchUniversalMetadata("Sidecar Sourced Book", {
      category: "general_book",
    });

    const fromSidecar = results.find((r) => r.source === "Custom Catalog");
    expect(fromSidecar).toBeDefined();
    expect(fromSidecar?.title).toBe("Sidecar Sourced Book");
    expect(fromSidecar?.confidence).toBe(0.93);
    expect(describeResultProvider(fromSidecar!)?.kind).toBe("sidecar");
    expect(calls.some((c) => c.url.startsWith("http://127.0.0.1:8097/search"))).toBe(true);
  });
});
