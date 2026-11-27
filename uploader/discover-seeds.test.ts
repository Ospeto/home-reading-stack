import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  CURATED_SEED_MAX_AGE_MS,
  CURATED_SEED_STORE_VERSION,
  getDefaultSeedStorePath,
  loadCuratedNewReleaseSeeds,
  writeCuratedNewReleaseSeeds,
} from "./discover-seeds";
import type { DiscoveredNovel } from "./discover";

/**
 * Regression fixtures for report finding B5 (New Releases was a frozen 2020-2023 list) and
 * G3 (the UI must be able to say it is showing the curated fallback).
 */

const COMPILED: DiscoveredNovel[] = [
  {
    id: "compiled-1",
    title: "Compiled Only Novel",
    author: "Some Author",
    synopsis: "A compiled seed.",
    coverUrl: "https://example.test/c.jpg",
    source: "lnori",
    sourceUrls: { lnori: "https://lnori.com/series/1/x/book/2" },
    releaseDate: "2021-05-01",
  } as DiscoveredNovel,
];

function usableNovel(overrides: Partial<DiscoveredNovel> = {}): DiscoveredNovel {
  return {
    id: `novel-${Math.random().toString(36).slice(2, 8)}`,
    title: "Refreshed Novel",
    author: "Author",
    synopsis: "Fresh.",
    coverUrl: "https://example.test/f.jpg",
    source: "elscione",
    sourceUrls: { elscione: "https://elsci.one/series/x/book/y" },
    releaseDate: "2025-03-04",
    ...overrides,
  } as DiscoveredNovel;
}

let tmpDir: string;
let storePath: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "seed-store-"));
  storePath = path.join(tmpDir, "discover-new-releases.json");
});

afterEach(() => {
  try {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  } catch {
    /* best effort */
  }
});

describe("Curated New Releases Store (B5: the tab is curated, not frozen)", () => {
  it("falls back to the compiled list when no refreshed store exists", () => {
    const result = loadCuratedNewReleaseSeeds({ storePath, compiledSeeds: COMPILED });
    expect(result.origin).toBe("compiled");
    expect(result.novels).toEqual(COMPILED);
    expect(result.generatedAt).toBeNull();
    expect(result.isStale).toBe(false);
    // A first run before the scheduled refresh has nothing to report as wrong.
    expect(result.error).toBeUndefined();
  });

  it("serves a refreshed store and reports it as the origin", () => {
    const generatedAt = new Date("2025-06-01T00:00:00Z").toISOString();
    const written = writeCuratedNewReleaseSeeds([usableNovel({ title: "Fresh A" })], {
      storePath,
      generatedAt,
    });
    expect(written).toBe(storePath);

    const result = loadCuratedNewReleaseSeeds({
      storePath,
      compiledSeeds: COMPILED,
      now: new Date("2025-06-02T00:00:00Z").getTime(),
    });
    expect(result.origin).toBe("refreshed");
    expect(result.generatedAt).toBe(generatedAt);
    expect(result.isStale).toBe(false);
    expect(result.novels.map((n) => n.title)).toEqual(["Fresh A"]);
  });

  it("still serves a refreshed store past the max age but marks it stale so the UI can say so", () => {
    const generatedAt = new Date("2025-01-01T00:00:00Z").toISOString();
    writeCuratedNewReleaseSeeds([usableNovel({ title: "Old Fresh" })], { storePath, generatedAt });

    const result = loadCuratedNewReleaseSeeds({
      storePath,
      compiledSeeds: COMPILED,
      now: new Date("2025-01-01T00:00:00Z").getTime() + CURATED_SEED_MAX_AGE_MS + 1000,
    });
    expect(result.origin).toBe("refreshed");
    expect(result.isStale).toBe(true);
    expect(result.novels.map((n) => n.title)).toEqual(["Old Fresh"]);
  });

  it("never serves a candidate that has no downloadable source", () => {
    writeCuratedNewReleaseSeeds(
      [
        usableNovel({ title: "Downloadable" }),
        usableNovel({ title: "Source-less", sourceUrls: {} as any }),
      ],
      { storePath, generatedAt: new Date().toISOString() },
    );

    const result = loadCuratedNewReleaseSeeds({ storePath, compiledSeeds: COMPILED });
    expect(result.novels.map((n) => n.title)).toEqual(["Downloadable"]);
  });

  it("falls back to the compiled list on unreadable JSON, wrong version, or an empty list", () => {
    fs.writeFileSync(storePath, "{ not json", "utf8");
    expect(loadCuratedNewReleaseSeeds({ storePath, compiledSeeds: COMPILED }).origin).toBe(
      "compiled",
    );

    fs.writeFileSync(storePath, JSON.stringify({ version: 99, novels: [usableNovel()] }), "utf8");
    expect(loadCuratedNewReleaseSeeds({ storePath, compiledSeeds: COMPILED }).origin).toBe(
      "compiled",
    );

    fs.writeFileSync(
      storePath,
      JSON.stringify({ version: CURATED_SEED_STORE_VERSION, generatedAt: null, novels: [] }),
      "utf8",
    );
    expect(loadCuratedNewReleaseSeeds({ storePath, compiledSeeds: COMPILED }).origin).toBe(
      "compiled",
    );
  });

  it("writes atomically and leaves no temporary file behind", () => {
    writeCuratedNewReleaseSeeds([usableNovel()], { storePath });
    const leftovers = fs.readdirSync(tmpDir).filter((f) => f.endsWith(".tmp"));
    expect(leftovers).toEqual([]);

    const parsed = JSON.parse(fs.readFileSync(storePath, "utf8"));
    expect(parsed.version).toBe(CURATED_SEED_STORE_VERSION);
    expect(parsed.source).toBe("anilist");
    expect(parsed.novels.length).toBe(1);
  });

  it("resolves its default path under the repository data directory", () => {
    const resolved = getDefaultSeedStorePath("/tmp/lighthouse-root");
    expect(resolved).toBe(path.join("/tmp/lighthouse-root", "data", "discover-new-releases.json"));
  });
});
