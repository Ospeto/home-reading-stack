# Metadata Providers & Sidecar Protocol

LightHouse enrichment used to be bespoke scraping behind overwrite protection: adding a
source (RanobeDB, Douban, a private catalog) meant editing `uploader/scraper.ts`. The
provider registry turns source selection into **data**. Adding a source is now a config
entry, and the existing scrapers are simply the first registered providers.

- Interface, registry, routing table, sidecar client: `uploader/metadata-providers.ts`
- Built-in scrapers and the Calibre write path: `uploader/scraper.ts`
- Discovery endpoint: `GET /api/metadata/providers`
- Tests: `uploader/metadata-providers.test.ts`

## 1. The provider contract

```ts
export interface MetadataProvider {
  id: string;                              // stable slug: [a-z0-9][a-z0-9_-]*
  label: string;                           // lands in ScrapedMetadata.source
  kind: "builtin" | "sidecar";
  priority: number;                        // higher wins equal-confidence ties
  categories: BookSourceCategory[];        // light_novel | manga | general_book | burmese | other
  fields: MetadataField[];                 // title | authors | synopsis | cover | tags | series | volume
  seriesQueryOnly?: boolean;               // skipped when resolving one specific volume
  enabled?: boolean;
  endpoint?: string;                       // sidecar base URL (diagnostics)
  search(ctx: MetadataSearchContext, deps?: ProviderRuntimeDeps): Promise<ScrapedMetadata[]>;
  fetchById?(externalId: string, deps?: ProviderRuntimeDeps): Promise<ScrapedMetadata | null>;
  matchUrl?(url: string): string | null;   // detail-URL -> external id
}
```

`MetadataSearchContext` carries `query`, `author`, `filename`, `tags`, `category`,
`preserveVolume`, and `volume`. `ProviderRuntimeDeps` injects `fetchFn`/`timeoutMs`, which is
how tests mock network access.

A provider result is a `ScrapedMetadata`: `title` (required), `authors`, `publisher`,
`publishedDate`, `description` (the synopsis), `coverUrl`, `tags`, `source`, `confidence`,
`isManga`, plus the optional structured `series` / `volume`.

### Registration and validation

```ts
const registry = new MetadataProviderRegistry();
registry.register(myProvider);       // validates, replaces by id, returns `this`
registry.registerAll([a, b, c]);
registry.unregister("b");
registry.list();                     // enabled only, priority desc then registration order
registry.resolve("light_novel");     // providers serving a category
registry.describe();                 // serialisable descriptors for the API/docs
```

`validateProviderDefinition` rejects a malformed contract with `MetadataProviderError`:
bad id slug, empty label, missing `search`, unknown `kind`, unknown category, unknown field,
empty `categories` or `fields`, non-finite priority, non-function `fetchById`/`matchUrl`.

### Routing, priority, and fallback

`DEFAULT_ROUTING_TABLE` maps each category to ordered tiers of provider ids. The table *is*
the routing policy — no branching code:

| Category | Tier 1 | Tier 2 | Tier 3 |
| --- | --- | --- | --- |
| `light_novel` | ranobedb, anilist, bangumi | google_books | openlibrary, mangadex |
| `manga` | mangadex, anilist, bangumi | google_books, openlibrary | — |
| `general_book` / `other` | google_books, openlibrary | ranobedb, anilist, bangumi, mangadex | — |
| `burmese` | *(none — overseas lookups 404)* | | |

Execution rules:

1. Tiers run in order with `Promise.allSettled`, so one failing provider never sinks a tier.
2. After each tier the collected results are tested by `isUsableResultSet`. For a
   series-level query "usable" means *any* result; when resolving one specific volume it
   means a result at confidence ≥ 0.85 **with a real synopsis**, so a generic series blurb
   never short-circuits the search for a volume-specific description.
3. `seriesQueryOnly` providers (AniList) are skipped while resolving a volume.
4. Providers **not named in the routing table** for a category are collected into
   `plan.alwaysRun` and always consulted after the tiers. This is what lets a sidecar — or a
   new built-in an integrator registered — take part without editing the table.
5. A built-in provider's served `categories` are derived from the routing table, so a
   provider can never claim a category the table does not schedule it for.

Priority only breaks **equal-confidence** ties. Every built-in shares
`BUILTIN_PROVIDER_PRIORITY = 50`, which preserves the historical insertion-order tie-break;
a sidecar at 60 outranks a built-in on a tie, one at 40 defers to it. Confidence always wins
over priority.

## 2. The Calibre write path is not pluggable — by design

Providers only produce candidates. Ranking and writing stay in `uploader/scraper.ts`:

- `applyVolumeConflictGuard(results, targetVol)` — a candidate whose volume disagrees with
  the target is demoted to confidence 0; a volume-less candidate is capped at 0.7 when
  targeting volume > 1.
- `resolveOverwriteGuards(existing, candidate)` — the single source of truth for both
  overwrite guards:
  1. **Title:** never overwrite the title when the existing book has volume / `series_index`
     > 1 and the candidate volume mismatches *or* is missing.
  2. **Cover:** never overwrite an existing cover when the existing book's volume mismatches
     the candidate volume (including "numbered book, volume-less candidate").
- `rankMetadataCandidates` — RanobeDB preference rules, then confidence, then provider
  priority.

`candidateVolume` is `candidate.volume` when a provider supplies a structured volume,
otherwise the volume marker parsed out of the title — so built-ins behave exactly as before
while a sidecar's explicit volume is honoured.

## 3. Sidecar protocol

A sidecar is a small HTTP service that runs beside LightHouse and answers three GET routes.
Nothing else is required — no shared library, no plugin API.

### Discovery (optional)

```http
GET {endpoint}/manifest
```

```json
{
  "id": "douban",
  "label": "Douban Books",
  "protocol": 1,
  "fields": ["title", "authors", "synopsis", "cover", "tags"],
  "categories": ["general_book", "other"],
  "priority": 65,
  "seriesQueryOnly": false
}
```

LightHouse does not require this route; it is available for `probeSidecarManifest()` /
operator tooling. Unreachable or malformed manifests are treated as absent.

### Search

```http
GET {endpoint}/search?q=<query>&category=<cat>&volume=<n>&author=<a>&preserveVolume=1
```

Accept any of these envelopes — `{ "results": [...] }`, a bare array, `{ "data": [...] }`,
or `{ "books": [...] }`:

```json
{
  "results": [
    {
      "title": "三体",
      "authors": ["Liu Cixin"],
      "synopsis": "First contact with Trisalam.",
      "cover": "https://img.example.com/cover.jpg",
      "tags": ["Sci-Fi"],
      "series": "Remembrance of Earth's Past",
      "volume": 1,
      "confidence": 0.88,
      "id": "douban-42"
    }
  ]
}
```

Field aliases accepted: `synopsis` / `description` / `summary`; `coverUrl` / `cover` /
`image` / `cover_url`; `authors` (string or array) / `author`; `volume` / `seriesIndex` /
`series_index`; `publishedDate` / `pubdate` / `published`. `title` is required — records
without one are dropped. `confidence` is clamped to `[0, 1]` and defaults to `0.78`.

### Detail fetch

```http
GET {endpoint}/book/{id}
```

Respond with `{ "book": {...} }`, `{ "result": {...} }`, `{ "data": {...} }`, or the record
itself. `matchUrl` claims detail URLs on the sidecar's own host, so a pasted
`http://127.0.0.1:8099/book/abc123` resolves through `fetchByUrl`.

### Failure behaviour

Timeout (default 6 s), connection refused, non-2xx, and malformed JSON all degrade to an
empty result for that provider. A sidecar can never destabilise enrichment.

## 4. Configuration

Precedence, highest first:

1. `LIGHTHOUSE_METADATA_PROVIDERS_OFF=1` — disable every sidecar (built-ins unaffected).
2. `LIGHTHOUSE_METADATA_PROVIDERS` — inline JSON, either `[...]` or `{ "providers": [...] }`.
3. `LIGHTHOUSE_METADATA_PROVIDERS_FILE` — path to a JSON manifest (default
   `<LIGHTHOUSE_ROOT>/data/metadata-providers.json`).

```json
{
  "providers": [
    {
      "id": "douban",
      "label": "Douban",
      "endpoint": "http://127.0.0.1:8099",
      "priority": 60,
      "categories": ["general_book", "other"],
      "fields": ["title", "authors", "synopsis", "cover", "tags"],
      "timeoutMs": 6000,
      "seriesQueryOnly": false
    }
  ]
}
```

Per-entry options: `id` (defaults to a slug of the endpoint host), `label`, `endpoint`
(required, http/https, no credentials), `url`/`baseUrl` aliases, `priority`, `categories`,
`fields`, `enabled`, `timeoutMs`, `authToken` (sent as `Authorization: Bearer …`), `headers`,
`searchPath`, `bookPath`, `manifestPath`, `defaultConfidence`, `seriesQueryOnly`.

A copyable starting point lives in `docs/metadata-providers.example.json`. `data/` is
gitignored, so operator config never lands in the repository.

### Security

Sidecar endpoints come from operator config, never from user input, and are passed to the
SSRF guard as an exact `host:port` allowlist (`allowedSidecarEndpoints`). Only that endpoint
may be internal, and it must still resolve exclusively to loopback/private addresses — so a
sidecar on `127.0.0.1` or the LAN works while every user-supplied URL stays blocked. All
sidecar traffic flows through `safeFetchWithSsrf`, the single outbound fetch entry point.

## 5. Adding a source

**As data (no code):** run the sidecar, add an entry to
`data/metadata-providers.json`, restart the uploader, confirm it in
`GET /api/metadata/providers`.

**As code (when the source needs bespoke parsing):** implement `MetadataProvider` in
`uploader/`, adapt the existing scraper function, register it on
`defaultMetadataProviderRegistry` in `uploader/scraper.ts`, and (for a routed built-in) name
its id in `DEFAULT_ROUTING_TABLE`. Add tests next to `uploader/metadata-providers.test.ts`.
