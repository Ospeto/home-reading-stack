import { describe, it, expect } from "bun:test";
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import {
  LNORI_SITEMAP_URL,
  SERIES_ID_OVERRIDES,
  parseSeriesSitemap,
  indexLiveSeries,
  collectOccurrences,
  diffAgainstLive,
  applyLiveIds,
} from "./refresh-lnori-series";
import { KNOWN_TITLE_TO_LNORI, REAL_LNORI_SERIES } from "../uploader/discover";

const REPO_ROOT = path.resolve(import.meta.dir, "..");
const FIXTURE_PATH = path.join(REPO_ROOT, "uploader", "fixtures", "lnori-sitemap-series.xml");
const PROVENANCE_PATH = path.join(
  REPO_ROOT,
  "uploader",
  "fixtures",
  "lnori-sitemap-series.provenance.json",
);

/**
 * Lnori does not publish a page for every slug this catalog knows about, and guessing a
 * replacement id is worse than saying so. Recorded here with the evidence, so the liveness test
 * fails loudly on any *new* gap while this one stays a stated, reviewable exception.
 */
const KNOWN_UNRESOLVED: Record<string, string> = {
  "solo-leveling":
    "Lnori has no series under this slug: /series/6219 and /series/6219/solo-leveling both return " +
    "404, and the slug appears in neither sitemap-series.xml nor sitemap-book.xml. Left in place " +
    "rather than re-pointed at an unverified id; the Discover verification reports it as not-found.",
};

const FIXTURE_XML = fs.readFileSync(FIXTURE_PATH, "utf8");
const LIVE_SERIES = parseSeriesSitemap(FIXTURE_XML);
const LIVE_BY_SLUG = indexLiveSeries(LIVE_SERIES);

const DISCOVER_SOURCE = fs.readFileSync(path.join(REPO_ROOT, "uploader", "discover.ts"), "utf8");
const CATALOG_SOURCE = fs.readFileSync(
  path.join(REPO_ROOT, "uploader", "discover-catalog.json"),
  "utf8",
);

function seedUrls(source: string): Array<{ id: number; slug: string }> {
  return Array.from(
    source.matchAll(/lnori:\s*"https:\/\/lnori\.com\/series\/(\d+)\/([a-z0-9-]+)"/g),
  ).map((m) => ({ id: Number(m[1]), slug: m[2] }));
}

/** The id a slug must carry: an explicit human decision outranks the slug lookup. */
function expectedId(slug: string): number | null {
  const override = SERIES_ID_OVERRIDES[slug];
  if (override) return override.id;
  const live = LIVE_BY_SLUG.get(slug);
  return live && live.length === 1 ? live[0] : null;
}

describe("Lnori sitemap fixture provenance", () => {
  it("is a snapshot of Lnori's own series sitemap, and says so", () => {
    const provenance = JSON.parse(fs.readFileSync(PROVENANCE_PATH, "utf8"));
    expect(provenance.sourceUrl).toBe(LNORI_SITEMAP_URL);
    expect(provenance.sourceUrl).toBe("https://lnori.com/sitemap/sitemap-series.xml");
    expect(provenance.locCount).toBe(LIVE_SERIES.length);
    expect(provenance.uniqueSlugCount).toBe(LIVE_BY_SLUG.size);
    expect(provenance.note).toContain("--fixture-out");
  });

  it("has not been edited since it was fetched", () => {
    const provenance = JSON.parse(fs.readFileSync(PROVENANCE_PATH, "utf8"));
    const actual = crypto.createHash("sha256").update(FIXTURE_XML).digest("hex");
    expect(actual).toBe(provenance.sha256);
  });

  it("parses every recorded series as an id + slug pair", () => {
    expect(LIVE_SERIES.length).toBeGreaterThanOrEqual(880);
    for (const series of LIVE_SERIES) {
      expect(series.id).toBeGreaterThan(0);
      expect(series.slug.length).toBeGreaterThan(0);
      expect(series.slug).toMatch(/^[a-z0-9-]+$/);
    }
  });
});

describe("Every recorded Lnori id resolves against the sitemap snapshot", () => {
  it("covers every entry in KNOWN_TITLE_TO_LNORI", () => {
    const titles = Object.entries(KNOWN_TITLE_TO_LNORI);
    expect(titles.length).toBeGreaterThanOrEqual(40);
    for (const [title, series] of titles) {
      const expected = expectedId(series.slug);
      if (expected === null) {
        expect(KNOWN_UNRESOLVED[series.slug]).toBeDefined();
        continue;
      }
      expect({ title, id: series.id, expected }).toEqual({ title, id: expected, expected });
    }
  });

  it("covers every entry in discover-catalog.json lnoriSeries", () => {
    expect(REAL_LNORI_SERIES.length).toBeGreaterThanOrEqual(880);
    const drifted = REAL_LNORI_SERIES.map((series) => {
      const expected = expectedId(series.slug);
      return expected === null || expected === series.id ? null : { series, expected };
    }).filter(Boolean);
    expect(drifted).toEqual([]);
  });

  it("covers every seeded sourceUrls.lnori URL in discover.ts", () => {
    const seeds = seedUrls(DISCOVER_SOURCE);
    expect(seeds.length).toBeGreaterThanOrEqual(14);
    const drifted = seeds
      .map((seed) => {
        const expected = expectedId(seed.slug);
        return expected === null || expected === seed.id ? null : { seed, expected };
      })
      .filter(Boolean);
    expect(drifted).toEqual([]);
  });

  it("names every slug the sitemap cannot resolve, instead of silently keeping a dead id", () => {
    const unresolved = new Set<string>();
    const consider = (slug: string) => {
      if (SERIES_ID_OVERRIDES[slug]) return;
      const live = LIVE_BY_SLUG.get(slug) ?? [];
      if (live.length !== 1) unresolved.add(slug);
    };
    for (const series of Object.values(KNOWN_TITLE_TO_LNORI)) consider(series.slug);
    for (const series of REAL_LNORI_SERIES) consider(series.slug);
    for (const seed of seedUrls(DISCOVER_SOURCE)) consider(seed.slug);

    expect([...unresolved].sort()).toEqual(Object.keys(KNOWN_UNRESOLVED).sort());
  });

  it("points each recorded override at a series Lnori really has", () => {
    for (const [slug, override] of Object.entries(SERIES_ID_OVERRIDES)) {
      const live = LIVE_BY_SLUG.get(override.slug ?? slug) ?? [];
      expect({ slug, live: live.includes(override.id) }).toEqual({ slug, live: true });
      expect(override.reason.length).toBeGreaterThan(20);
    }
  });
});

describe("refresh-lnori-series diff and rewrite", () => {
  const DISCOVER_SNIPPET = [
    "export const KNOWN_TITLE_TO_LNORI: Record<string, { id: number; slug: string }> = {",
    '  "drifted title": { id: 12780, slug: "too-many-losing-heroines" },',
    '  "unknown title": { id: 6219, slug: "solo-leveling" },',
    "};",
    "const seeds = [",
    '  { lnori: "https://lnori.com/series/12780/too-many-losing-heroines" },',
    '  { lnori: "https://lnori.com/series/6219/solo-leveling" },',
    "];",
  ].join("\n");
  const CATALOG_SNIPPET = JSON.stringify(
    {
      lnoriSeries: [
        { id: 12780, slug: "too-many-losing-heroines" },
        { id: 6219, slug: "solo-leveling" },
        { id: 6219, slug: "unheard-of-series" },
      ],
    },
    null,
    2,
  );

  it("collects ids from all three homes", () => {
    const occurrences = collectOccurrences(DISCOVER_SNIPPET, CATALOG_SNIPPET);
    expect(occurrences.filter((o) => o.home === "known-titles")).toHaveLength(2);
    expect(occurrences.filter((o) => o.home === "seed-urls")).toHaveLength(2);
    expect(occurrences.filter((o) => o.home === "catalog")).toHaveLength(3);
  });

  it("separates drift it can prove from drift only a human can settle", () => {
    const occurrences = collectOccurrences(DISCOVER_SNIPPET, CATALOG_SNIPPET);
    const report = diffAgainstLive(occurrences, LIVE_BY_SLUG, LIVE_SERIES.length);

    expect(report.locCount).toBe(LIVE_SERIES.length);
    expect(report.drifted).toBeGreaterThan(0);
    // solo-leveling and unheard-of-series are absent from the sitemap: reported, never rewritten.
    expect(report.missing).toBeGreaterThanOrEqual(2);

    const drifted = report.drift.filter((d) => d.kind === "drifted");
    for (const d of drifted) {
      expect(d.liveId).not.toBe(d.occurrence.id);
      expect(LIVE_BY_SLUG.get(d.occurrence.slug)).toContain(d.liveId as number);
    }
    for (const d of report.drift.filter((x) => x.kind === "missing-slug")) {
      expect(d.liveId).toBeNull();
    }
  });

  it("rewrites only the ids the sitemap proves, in every home, and leaves the rest byte-identical", () => {
    const occurrences = collectOccurrences(DISCOVER_SNIPPET, CATALOG_SNIPPET);
    const report = diffAgainstLive(occurrences, LIVE_BY_SLUG, LIVE_SERIES.length);
    const result = applyLiveIds(DISCOVER_SNIPPET, CATALOG_SNIPPET, report.drift);

    const liveId = LIVE_BY_SLUG.get("too-many-losing-heroines")?.[0] as number;
    expect(liveId).toBe(12417);

    expect(result.knownTitlesChanged).toBe(1);
    expect(result.seedUrlsChanged).toBe(1);
    expect(result.catalogChanged).toBe(1);

    expect(result.discoverTs).toContain(`{ id: ${liveId}, slug: "too-many-losing-heroines" }`);
    expect(result.discoverTs).toContain(
      `https://lnori.com/series/${liveId}/too-many-losing-heroines`,
    );
    // Unresolved entries survive untouched: no invented ids.
    expect(result.discoverTs).toContain('{ id: 6219, slug: "solo-leveling" }');
    expect(result.discoverTs).toContain("https://lnori.com/series/6219/solo-leveling");

    const catalog = JSON.parse(result.catalogJson);
    expect(catalog.lnoriSeries[0]).toEqual({ id: liveId, slug: "too-many-losing-heroines" });
    expect(catalog.lnoriSeries[1]).toEqual({ id: 6219, slug: "solo-leveling" });
    expect(catalog.lnoriSeries[2]).toEqual({ id: 6219, slug: "unheard-of-series" });
    // Same shape as the committed file, so a refresh diff shows ids and nothing else.
    expect(result.catalogJson.endsWith("}\n")).toBe(true);
    expect(result.catalogJson).toContain('\n  "lnoriSeries"');
  });

  it("keeps a renamed slug alongside the new id when the override says Lnori moved it", () => {
    const source = [
      '  "rascal": { id: 4242, slug: "rascal-does-not-dream-of-bunny-girl-senpai" },',
    ].join("\n");
    const occurrences = collectOccurrences(source, '{"lnoriSeries":[]}');
    const report = diffAgainstLive(occurrences, LIVE_BY_SLUG, LIVE_SERIES.length);
    const result = applyLiveIds(source, '{"lnoriSeries":[]}', report.drift);

    expect(result.discoverTs).toBe(
      '  "rascal": { id: 3486, slug: "rascal-does-not-dream" },',
    );
  });

  it("reports the committed catalog as fully resolved", () => {
    const occurrences = collectOccurrences(DISCOVER_SOURCE, CATALOG_SOURCE);
    const report = diffAgainstLive(occurrences, LIVE_BY_SLUG, LIVE_SERIES.length);
    const unresolved = report.drift.filter((d) => d.kind !== "current");
    expect(unresolved.map((d) => `${d.kind}:${d.occurrence.slug}`).sort()).toEqual(
      Object.keys(KNOWN_UNRESOLVED)
        .map((slug) => `missing-slug:${slug}`)
        .sort(),
    );
    expect(report.drifted).toBe(0);
    expect(report.ambiguous).toBe(0);
  });
});
