#!/usr/bin/env bun
/**
 * scripts/refresh-lnori-series.ts
 *
 * Keeps the Lnori series ids in LightHouse honest.
 *
 * Lnori renumbers series: a slug that was `/series/12780/too-many-losing-heroines` is now
 * `/series/12417/too-many-losing-heroines`, and the old id returns HTTP 404. Three places in this
 * repo carry those ids and they all rot together:
 *
 *   1. `KNOWN_TITLE_TO_LNORI` in `uploader/discover.ts` (title → series id),
 *   2. the hardcoded `sourceUrls.lnori` URLs on the seeded catalog entries in `uploader/discover.ts`,
 *   3. `lnoriSeries` in `uploader/discover-catalog.json` (the ~880-series registry).
 *
 * Lnori's own `https://lnori.com/sitemap/sitemap-series.xml` is the authority. This script fetches
 * it, diffs every id against it, and prints what drifted. `--write` rewrites the ids it can prove;
 * without `--write` nothing is touched.
 *
 * Deliberate limits:
 *   - A slug that is absent from the live sitemap is reported, never guessed. Lnori may have
 *     dropped the title or renamed the slug, and only a human can tell which replacement is safe.
 *   - A slug that maps to more than one live id is reported as ambiguous, never rewritten.
 *   - It is not wired into any daemon. Run it by hand when the Discover modal starts reporting
 *     "Lnori does not have this id", or after a batch of catalog edits.
 *
 * Usage:
 *   bun scripts/refresh-lnori-series.ts                 # dry-run report
 *   bun scripts/refresh-lnori-series.ts --write         # rewrite drifted ids in place
 *   bun scripts/refresh-lnori-series.ts --sitemap f.xml # diff against a local snapshot
 *   bun scripts/refresh-lnori-series.ts --fixture-out uploader/fixtures/lnori-sitemap-series.xml
 */

import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import crypto from "node:crypto";

export const LNORI_SITEMAP_URL = "https://lnori.com/sitemap/sitemap-series.xml";

/**
 * Human decisions the sitemap alone cannot make, with the evidence for each.
 *
 * A slug is normally enough to map a series to its id. Two shapes defeat that, and both appear in
 * this catalog, so the decision is recorded here instead of being re-guessed on every run:
 *
 *   - Lnori lists one slug under two ids (a real series and a stub under the same name),
 *   - Lnori renamed the slug, so the old slug is gone and the series answers under a new one.
 *
 * Each entry is verified against the live site; `reason` states how. Nothing here is inferred from
 * a title: a changed `slug` means Lnori's own sitemap carries the series under that path.
 */
export const SERIES_ID_OVERRIDES: Record<string, { id: number; slug?: string; reason: string }> = {
  "the-greatest-demon-lord-is-reborn-as-a-typical-nobody": {
    id: 8084,
    reason:
      "Lnori lists this slug under 10454 and 8084. 8084 carries the ten numbered volumes " +
      "(/book/23101 … /book/35329); 10454 carries only the volume 6.5 side story (/book/28322).",
  },
  "rascal-does-not-dream-of-bunny-girl-senpai": {
    id: 3486,
    slug: "rascal-does-not-dream",
    reason:
      "4242 and the bunny-girl slug both 404; Lnori's live series is 3486/rascal-does-not-dream, " +
      "titled 'Rascal Does Not Dream' and listing volume 1 as 'Rascal Does Not Dream of Bunny Girl Senpai'.",
  },
};

export interface LiveSeries {
  id: number;
  slug: string;
}

export type LnoriHome = "known-titles" | "seed-urls" | "catalog";

export interface LnoriIdOccurrence {
  home: LnoriHome;
  /** Where the id was found: a JSON array index, a title-map key, or a seed URL. */
  where: string;
  slug: string;
  id: number;
}

export interface LnoriDrift {
  occurrence: LnoriIdOccurrence;
  /** The live id when the slug resolves to exactly one id; null when unknown or ambiguous. */
  liveId: number | null;
  kind: "current" | "drifted" | "missing-slug" | "ambiguous-slug" | "duplicate-slug";
  liveIds: number[];
}

export interface RefreshReport {
  locCount: number;
  uniqueSlugCount: number;
  drift: LnoriDrift[];
  drifted: number;
  missing: number;
  ambiguous: number;
  /** Slugs Lnori lists under more than one id where our recorded id is one of them. */
  duplicates: number;
  written: boolean;
}

/** Parses `<loc>https://lnori.com/series/<id>/<slug></loc>` entries out of a sitemap document. */
export function parseSeriesSitemap(xml: string): LiveSeries[] {
  const out: LiveSeries[] = [];
  const re = /<loc>\s*https:\/\/lnori\.com\/series\/(\d+)\/([^<\s]+)\s*<\/loc>/gi;
  for (const m of String(xml ?? "").matchAll(re)) {
    const id = Number(m[1]);
    const slug = m[2].trim();
    if (!Number.isFinite(id) || !slug) continue;
    out.push({ id, slug });
  }
  return out;
}

/** Groups the sitemap by slug, preserving every id that claims the slug. */
export function indexLiveSeries(series: LiveSeries[]): Map<string, number[]> {
  const map = new Map<string, number[]>();
  for (const s of series) {
    const ids = map.get(s.slug) ?? [];
    if (!ids.includes(s.id)) ids.push(s.id);
    map.set(s.slug, ids);
  }
  return map;
}

/** Every id currently written into the three homes this script is allowed to touch. */
export function collectOccurrences(
  discoverTs: string,
  catalogJson: string,
): LnoriIdOccurrence[] {
  const occurrences: LnoriIdOccurrence[] = [];

  // 1. KNOWN_TITLE_TO_LNORI entries: `{ id: 2201, slug: "is-it-wrong-..." }`
  for (const m of discoverTs.matchAll(/\{ id:\s*(\d+),\s*slug:\s*"([^"]+)"\s*\}/g)) {
    occurrences.push({
      home: "known-titles",
      where: `discover.ts:{ id: ${m[1]}, slug: "${m[2]}" }`,
      slug: m[2],
      id: Number(m[1]),
    });
  }

  // 2. Hardcoded seeded catalog URLs: `https://lnori.com/series/<id>/<slug>`
  for (const m of discoverTs.matchAll(/https:\/\/lnori\.com\/series\/(\d+)\/([a-z0-9-]+)/g)) {
    occurrences.push({
      home: "seed-urls",
      where: `discover.ts:https://lnori.com/series/${m[1]}/${m[2]}`,
      slug: m[2],
      id: Number(m[1]),
    });
  }

  // 3. discover-catalog.json `lnoriSeries`
  let catalog: any = null;
  try {
    catalog = JSON.parse(catalogJson);
  } catch (err: any) {
    throw new Error(`discover-catalog.json is not valid JSON: ${err?.message || err}`);
  }
  const series = Array.isArray(catalog?.lnoriSeries) ? catalog.lnoriSeries : [];
  series.forEach((entry: any, index: number) => {
    if (!entry || typeof entry.slug !== "string") return;
    occurrences.push({
      home: "catalog",
      where: `discover-catalog.json:lnoriSeries[${index}]`,
      slug: entry.slug,
      id: Number(entry.id),
    });
  });

  return occurrences;
}

/** Diffs a set of recorded ids against the live sitemap. Nothing here writes anything. */
export function diffAgainstLive(
  occurrences: LnoriIdOccurrence[],
  liveBySlug: Map<string, number[]>,
  seriesCount: number,
): RefreshReport {
  const drift: LnoriDrift[] = [];
  for (const occurrence of occurrences) {
    const liveIds = liveBySlug.get(occurrence.slug) ?? [];
    const override = SERIES_ID_OVERRIDES[occurrence.slug];
    let kind: LnoriDrift["kind"];
    let liveId: number | null = null;
    if (override) {
      // A recorded human decision outranks the slug lookup, including a slug Lnori has renamed.
      const targetSlug = override.slug ?? occurrence.slug;
      liveId = override.id;
      kind =
        occurrence.id === override.id && occurrence.slug === targetSlug ? "current" : "drifted";
    } else if (liveIds.length === 0) {
      kind = "missing-slug";
    } else if (liveIds.length > 1) {
      // Lnori sometimes lists one slug under two ids (a real series and a stub for the same name).
      // Which of the two is the series is a human judgement, so a recorded id that is one of them is
      // reported as an informational duplicate; an id that is neither is ambiguous and left alone.
      if (liveIds.includes(occurrence.id)) {
        kind = "duplicate-slug";
        liveId = occurrence.id;
      } else {
        kind = "ambiguous-slug";
      }
    } else {
      liveId = liveIds[0];
      kind = liveId === occurrence.id ? "current" : "drifted";
    }
    drift.push({ occurrence, liveId, kind, liveIds });
  }

  const count = (k: LnoriDrift["kind"]) => drift.filter((d) => d.kind === k).length;
  return {
    locCount: seriesCount,
    uniqueSlugCount: liveBySlug.size,
    drift,
    drifted: count("drifted"),
    missing: count("missing-slug"),
    ambiguous: count("ambiguous-slug"),
    duplicates: count("duplicate-slug"),
    written: false,
  };
}

export interface RewriteResult {
  discoverTs: string;
  catalogJson: string;
  knownTitlesChanged: number;
  seedUrlsChanged: number;
  catalogChanged: number;
}

/**
 * Rewrites only the ids the sitemap proves: a slug with exactly one live id replaces every recorded
 * id for that slug. Missing and ambiguous slugs are left byte-identical for a human to decide.
 */
export function applyLiveIds(
  discoverTs: string,
  catalogJson: string,
  drift: LnoriDrift[],
): RewriteResult {
  // slug -> the id (and, when Lnori renamed it, the slug) that must replace every recorded value.
  const replacements = new Map<string, { id: number; slug: string }>();
  for (const d of drift) {
    if (d.kind !== "drifted" || d.liveId === null) continue;
    replacements.set(d.occurrence.slug, {
      id: d.liveId,
      slug: SERIES_ID_OVERRIDES[d.occurrence.slug]?.slug ?? d.occurrence.slug,
    });
  }

  const targetFor = (slug: string, current: number) =>
    replacements.get(slug) ?? { id: current, slug };

  let knownTitlesChanged = 0;
  let seedUrlsChanged = 0;

  let nextDiscover = discoverTs.replace(
    /\{ id:\s*(\d+),\s*slug:\s*"([^"]+)"\s*\}/g,
    (match, idText: string, slug: string) => {
      const target = targetFor(slug, Number(idText));
      if (target.id === Number(idText) && target.slug === slug) return match;
      knownTitlesChanged += 1;
      return `{ id: ${target.id}, slug: "${target.slug}" }`;
    },
  );

  nextDiscover = nextDiscover.replace(
    /https:\/\/lnori\.com\/series\/(\d+)\/([a-z0-9-]+)/g,
    (match, idText: string, slug: string) => {
      const target = targetFor(slug, Number(idText));
      if (target.id === Number(idText) && target.slug === slug) return match;
      seedUrlsChanged += 1;
      return `https://lnori.com/series/${target.id}/${target.slug}`;
    },
  );

  let catalogChanged = 0;
  let catalog: any;
  try {
    catalog = JSON.parse(catalogJson);
  } catch (err: any) {
    throw new Error(`discover-catalog.json is not valid JSON: ${err?.message || err}`);
  }
  if (Array.isArray(catalog?.lnoriSeries)) {
    for (const entry of catalog.lnoriSeries) {
      if (!entry || typeof entry.slug !== "string") continue;
      const target = targetFor(entry.slug, Number(entry.id));
      if (target.id !== Number(entry.id) || target.slug !== entry.slug) {
        catalogChanged += 1;
        entry.id = target.id;
        entry.slug = target.slug;
      }
    }
  }

  // discover-catalog.json is committed as two-space JSON with a trailing newline; preserve that
  // shape so a refresh diff shows only the ids that actually changed.
  const nextCatalog = JSON.stringify(catalog, null, 2) + "\n";

  return {
    discoverTs: nextDiscover,
    catalogJson: nextCatalog,
    knownTitlesChanged,
    seedUrlsChanged,
    catalogChanged,
  };
}

export interface RefreshOptions {
  repoRoot?: string;
  /** Where to read the sitemap from; omitted means "fetch it live". */
  sitemapPath?: string;
  /** Where to write the live sitemap as a checked-in fixture (test hermeticity). */
  fixtureOut?: string;
  write?: boolean;
  fetchImpl?: typeof fetch;
  log?: (message: string) => void;
  now?: Date;
}

export async function refreshLnoriSeries(options?: RefreshOptions): Promise<RefreshReport> {
  const log = options?.log ?? ((message: string) => console.log(message));
  const repoRoot = options?.repoRoot ?? path.resolve((import.meta as any).dir, "..");
  const discoverPath = path.join(repoRoot, "uploader", "discover.ts");
  const catalogPath = path.join(repoRoot, "uploader", "discover-catalog.json");

  let xml: string;
  if (options?.sitemapPath) {
    xml = fs.readFileSync(options.sitemapPath, "utf8");
    log(`[LnoriRefresh] Reading sitemap snapshot ${options.sitemapPath}`);
  } else {
    const fetchImpl = options?.fetchImpl ?? fetch;
    log(`[LnoriRefresh] Fetching ${LNORI_SITEMAP_URL}`);
    const res = await fetchImpl(LNORI_SITEMAP_URL, {
      headers: { "User-Agent": "LightHouse/1.0 (+refresh-lnori-series)" },
      signal: AbortSignal.timeout(60_000),
    } as any);
    if (!res.ok) {
      throw new Error(`Lnori sitemap returned HTTP ${res.status}`);
    }
    xml = await res.text();
  }

  if (options?.fixtureOut) {
    const series = parseSeriesSitemap(xml);
    fs.mkdirSync(path.dirname(options.fixtureOut), { recursive: true });
    fs.writeFileSync(options.fixtureOut, xml);
    const provenance = {
      sourceUrl: LNORI_SITEMAP_URL,
      fetchedAt: (options.now ?? new Date()).toISOString(),
      locCount: series.length,
      uniqueSlugCount: new Set(series.map((s) => s.slug)).size,
      sha256: crypto.createHash("sha256").update(xml).digest("hex"),
      note: "Checked-in snapshot used by uploader/discover.test.ts so the id-liveness test is hermetic. Regenerate with: bun scripts/refresh-lnori-series.ts --fixture-out uploader/fixtures/lnori-sitemap-series.xml",
    };
    fs.writeFileSync(
      options.fixtureOut.replace(/\.xml$/, "") + ".provenance.json",
      JSON.stringify(provenance, null, 2) + "\n",
    );
    log(`[LnoriRefresh] Wrote fixture ${options.fixtureOut} (${series.length} entries)`);
  }

  const series = parseSeriesSitemap(xml);
  if (series.length === 0) {
    throw new Error("Lnori sitemap contained no series entries; refusing to diff against it");
  }
  const liveBySlug = indexLiveSeries(series);

  const discoverTs = fs.readFileSync(discoverPath, "utf8");
  const catalogJson = fs.readFileSync(catalogPath, "utf8");
  const occurrences = collectOccurrences(discoverTs, catalogJson);
  const report = diffAgainstLive(occurrences, liveBySlug, series.length);

  log(
    `[LnoriRefresh] Live sitemap: ${report.locCount} entries, ${report.uniqueSlugCount} unique slugs.`,
  );
  log(
    `[LnoriRefresh] Checked ${occurrences.length} recorded ids: ` +
      `${report.drifted} drifted, ${report.missing} missing slug, ${report.ambiguous} ambiguous slug, ` +
      `${report.duplicates} duplicate slug.`,
  );

  for (const d of report.drift) {
    if (d.kind === "current") continue;
    if (d.kind === "ambiguous-slug") {
      log(
        `  ambiguous  ${d.occurrence.where} — live ids ${d.liveIds.join(", ")}; left untouched`,
      );
    } else if (d.kind === "missing-slug") {
      log(`  missing    ${d.occurrence.where} — slug absent from the live sitemap; left untouched`);
    } else if (d.kind === "duplicate-slug") {
      log(
        `  duplicate  ${d.occurrence.where} — Lnori lists this slug under ${d.liveIds.join(" and ")}; ` +
          `kept ${d.occurrence.id} (add a SERIES_ID_OVERRIDES entry once you know which is the series)`,
      );
    }
  }
  for (const d of report.drift) {
    if (d.kind !== "drifted") continue;
    const renamed = SERIES_ID_OVERRIDES[d.occurrence.slug]?.slug;
    log(
      `  drifted    ${d.occurrence.where} — ${d.occurrence.id} → ${d.liveId}` +
        (renamed ? ` (slug → ${renamed})` : ""),
    );
  }

  if (!options?.write) return report;

  const result = applyLiveIds(discoverTs, catalogJson, report.drift);
  const totalChanges =
    result.knownTitlesChanged + result.seedUrlsChanged + result.catalogChanged;
  if (totalChanges === 0) {
    log("[LnoriRefresh] Nothing to rewrite.");
    return { ...report, written: false };
  }

  fs.writeFileSync(discoverPath, result.discoverTs);
  fs.writeFileSync(catalogPath, result.catalogJson);
  log(
    `[LnoriRefresh] Rewrote ${totalChanges} ids ` +
      `(${result.knownTitlesChanged} title-map entries, ${result.seedUrlsChanged} seed URLs, ` +
      `${result.catalogChanged} catalog entries).`,
  );
  return { ...report, written: true };
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const valueOf = (flag: string): string | undefined => {
    const index = args.indexOf(flag);
    return index >= 0 && args[index + 1] ? path.resolve(args[index + 1]) : undefined;
  };

  try {
    const report = await refreshLnoriSeries({
      repoRoot: valueOf("--repo-root"),
      sitemapPath: valueOf("--sitemap"),
      fixtureOut: valueOf("--fixture-out"),
      write: args.includes("--write"),
    });

    if (report.drifted > 0) {
      console.log(
        args.includes("--write")
          ? "[LnoriRefresh] Drift remains for ids that could not be proven; see the lines above."
          : "[LnoriRefresh] Re-run with --write to rewrite the drifted ids listed above.",
      );
      process.exit(args.includes("--write") ? 0 : 1);
    }
    if (report.missing > 0 || report.ambiguous > 0) {
      console.log(
        "[LnoriRefresh] Some recorded ids could not be checked against the sitemap by slug alone; " +
          "decide those by hand (nothing was rewritten for them).",
      );
      process.exit(args.includes("--write") ? 0 : 1);
    }
    console.log("[LnoriRefresh] Every recorded Lnori id matches the live sitemap.");
  } catch (err: any) {
    console.error(`[LnoriRefresh] Refresh failed: ${err?.message || err}`);
    process.exit(1);
  }
}

if ((import.meta as any).main) {
  await main();
}
