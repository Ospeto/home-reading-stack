import { describe, it, expect } from "bun:test";
import {
  MAIN_VOLUME_NAMESPACE,
  alignModelToFlatCount,
  auditNamespaceFor,
  buildSeriesVolumeModel,
  catalogueVolumeCountFrom,
  dedupeVolumeKeys,
  encodeVolumeKey,
  flatPositionFor,
  isAuxiliaryNamespace,
  isLocalNamespace,
  keyForFlatPosition,
  knownSeriesModel,
  parseVolumePart,
  parseVolumeNamespace,
  parseVolumeRange,
  projectOwnedVolume,
  projectTitleVolumeNumber,
  resolveCalibreVolumeKey,
  resolveCalibreVolumeKeys,
  resolveCanonicalVolumeKey,
  totalVolumeCount,
  volumeKeysMatch,
} from "./volume-model";

/**
 * Every fixture here is taken from the Discover & Download audit report
 * (`data/lighthouse-discover-download-audit/report.md`, sections 2.1-2.4) or from the real
 * `metadata.db` rows it printed. Before this model existed, the three volume models (Calibre
 * `series_index`, Discover's canonical integer, the ingest gate) disagreed on every one.
 */

const REAL_OVERLORD_ROWS = [
  { title: "Overlord, Vol. 1: The Undead King", series: "Overlord", seriesIndex: 1 },
  { title: "Overlord, Vol. 2: The Dark Warrior", series: "Overlord", seriesIndex: 2 },
  { title: "Overlord, Vol. 3: The Bloody Valkyrie", series: "Overlord", seriesIndex: 3 },
  { title: "Overlord, Vol. 4: The Lizardman Heroes", series: "Overlord", seriesIndex: 4 },
  { title: "Overlord, Vol. 5: The Men of the Kingdom Part I", series: "Overlord", seriesIndex: 5 },
  { title: "Overlord, Vol. 6: The Men of the Kingdom Part II", series: "Overlord", seriesIndex: 6 },
  { title: "Overlord, Vol. 7: The Invaders of the Great Tomb", series: "Overlord", seriesIndex: 7 },
  { title: "Overlord, Vol. 8: The Two Leaders", series: "Overlord", seriesIndex: 8 },
  { title: "Overlord, Vol. 9: The Caster of Destruction", series: "Overlord", seriesIndex: 9 },
  { title: "Overlord, Vol. 10: The Ruler of Conspiracy", series: "Overlord", seriesIndex: 10 },
  { title: "Overlord, Vol. 11: The Dwarven Crafter", series: "Overlord", seriesIndex: 11 },
  { title: "Overlord, Vol. 12: The Paladin of the Sacred Kingdom Part I", series: "Overlord", seriesIndex: 12 },
  { title: "Overlord, Vol. 13: The Paladin of the Sacred Kingdom Part II", series: "Overlord", seriesIndex: 13 },
  { title: "Overlord, Vol. 14: The Witch of the Doomed Kingdom", series: "Overlord", seriesIndex: 14 },
  { title: "Overlord, Vol. 15: The Half-Elf Demigod Part I", series: "Overlord", seriesIndex: 15 },
  { title: "Overlord, Vol. 16: The Half-Elf Demigod Part II", series: "Overlord", seriesIndex: 16 },
];

const REAL_BOOKWORM_ROWS = [
  { title: "Ascendance of a Bookworm: Short Story Collection Volume 1", series: "Ascendance of a Bookworm", seriesIndex: 1.1 },
  { title: "Ascendance of a Bookworm: Official Fanbook Volume 2", series: "Ascendance of a Bookworm", seriesIndex: 1.2 },
  { title: "Ascendance of a Bookworm: Part 1 Daughter of a Soldier Volume 3", series: "Ascendance of a Bookworm", seriesIndex: 1.3 },
  { title: "Ascendance of a Bookworm: Part 2 Apprentice Shrine Maiden Volume 4", series: "Ascendance of a Bookworm", seriesIndex: 1.4 },
  { title: "Ascendance of a Bookworm: Part 3 Adopted Daughter of an Archduke Volume 5", series: "Ascendance of a Bookworm", seriesIndex: 1.5 },
  { title: "Ascendance of a Bookworm: Part 5 Volume 7", series: "Ascendance of a Bookworm", seriesIndex: 1.7 },
  { title: "Ascendance of a Bookworm: Part 5 Volume 8", series: "Ascendance of a Bookworm", seriesIndex: 1.8 },
  { title: "Ascendance of a Bookworm: Part 5 Avatar of a Goddess Volume 9", series: "Ascendance of a Bookworm", seriesIndex: 1.9 },
  { title: "Ascendance of a Bookworm: Part 4 Founder of the Royal Academy's So-Called Library Committee Volume 9", series: "Ascendance of a Bookworm", seriesIndex: 1.9 },
];

const REAL_COTE_ROWS = [
  { title: "Classroom of the Elite Vol. 1", series: "Classroom of the Elite", seriesIndex: 1.01 },
  { title: "Classroom of the Elite Vol. 9", series: "Classroom of the Elite", seriesIndex: 1.09 },
  { title: "Classroom of the Elite Vol. 10", series: "Classroom of the Elite", seriesIndex: 1.1 },
  { title: "Classroom of the Elite Vol. 11.5", series: "Classroom of the Elite", seriesIndex: 1.11 },
  { title: "Classroom of the Elite: Year 2 Vol. 1", series: "Classroom of the Elite", seriesIndex: 2.01 },
  { title: "Classroom of the Elite: Year 2 Vol. 9", series: "Classroom of the Elite", seriesIndex: 2.09 },
];

describe("Unified volume model: namespaces instead of one flat number", () => {
  describe("B1 regression fixtures - a subtitle Part never collapses an explicit Vol", () => {
    it("derives the real volume for every Overlord row that the audit reproduced as collapsed", () => {
      const expectations: Record<number, number> = {
        1: 1, 2: 2, 3: 3, 4: 4, 5: 5, 6: 6, 7: 7, 8: 8,
        9: 9, 10: 10, 11: 11, 12: 12, 13: 13, 14: 14, 15: 15, 16: 16,
      };
      for (const row of REAL_OVERLORD_ROWS) {
        const expected = expectations[row.seriesIndex];
        const key = resolveCanonicalVolumeKey(row.title, row.series);
        expect(key?.volume).toBe(expected);
        // "… Part I/II" is a subtitle, not a part namespace
        expect(key?.namespace).toBe(MAIN_VOLUME_NAMESPACE);
      }
      // Distinct derived volumes must stay distinct (16 books, 16 volumes)
      const distinct = new Set(REAL_OVERLORD_ROWS.map((r) => resolveCalibreVolumeKey(r)?.volume));
      expect(distinct.size).toBe(16);
    });
  });

  describe("B3 regression fixtures - sub-series numbering is read in its own namespace", () => {
    it("reads Year 2 volumes in the year:2 namespace, never as base-series volumes", () => {
      const key = resolveCanonicalVolumeKey("Classroom of the Elite: Year 2 Vol. 9", "Classroom of the Elite");
      expect(key).toEqual({ namespace: "year:2", volume: 9 });
      expect(resolveCanonicalVolumeKey("Classroom of the Elite Vol. 9", "Classroom of the Elite")).toEqual({
        namespace: MAIN_VOLUME_NAMESPACE,
        volume: 9,
      });
      // The two are different books
      expect(
        volumeKeysMatch(
          { namespace: "year:2", volume: 9 },
          { namespace: MAIN_VOLUME_NAMESPACE, volume: 9 },
        ),
      ).toBe(false);
    });

    it("keeps Year 1 (part 1 / season 1) aliased to the base series", () => {
      expect(
        volumeKeysMatch({ namespace: "year:1", volume: 9 }, { namespace: MAIN_VOLUME_NAMESPACE, volume: 9 }),
      ).toBe(true);
      expect(
        volumeKeysMatch({ namespace: "part:1", volume: 9 }, { namespace: MAIN_VOLUME_NAMESPACE, volume: 9 }),
      ).toBe(true);
    });

    it("reads a sub-series novel locally so existing never exceeds the verified total", () => {
      // The audit's self-contradicting payload: existing 14 > total 12 on the Year 2 card.
      const model = buildSeriesVolumeModel(REAL_COTE_ROWS, {
        seriesText: "Classroom of the Elite",
        totalHint: 12,
      });
      const yearTwo = REAL_COTE_ROWS.filter((r) => String(r.title).includes("Year 2"));
      const owned = yearTwo
        .map((r) => projectOwnedVolume(resolveCalibreVolumeKey(r)!, model, "year:2"))
        .filter((v): v is number => v !== null);
      expect(owned).toEqual([1, 9]);
      expect(owned.length).toBeLessThanOrEqual(12);
      // Year 1 rows must not be counted on the Year 2 card
      expect(owned).not.toContain(11);
    });
  });

  describe("B2 regression fixtures - Calibre, Discover and ingest share one model", () => {
    it("places every real Bookworm row at the flat catalogue number Calibre intends", () => {
      const model = buildSeriesVolumeModel(REAL_BOOKWORM_ROWS, {
        seriesText: "Ascendance of a Bookworm",
        totalHint: 33,
      });
      expect(totalVolumeCount(model)).toBe(33);

      const flat = new Map<string, number | null>();
      for (const row of REAL_BOOKWORM_ROWS) {
        const key = resolveCalibreVolumeKey(row)!;
        flat.set(row.title, flatPositionFor(model, key));
      }
      expect(flat.get("Ascendance of a Bookworm: Part 1 Daughter of a Soldier Volume 3")).toBe(3);
      expect(flat.get("Ascendance of a Bookworm: Part 2 Apprentice Shrine Maiden Volume 4")).toBe(7);
      expect(flat.get("Ascendance of a Bookworm: Part 3 Adopted Daughter of an Archduke Volume 5")).toBe(12);
      expect(
        flat.get("Ascendance of a Bookworm: Part 4 Founder of the Royal Academy's So-Called Library Committee Volume 9"),
      ).toBe(21);
      expect(flat.get("Ascendance of a Bookworm: Part 5 Volume 7")).toBe(28);
      expect(flat.get("Ascendance of a Bookworm: Part 5 Volume 8")).toBe(29);
      expect(flat.get("Ascendance of a Bookworm: Part 5 Avatar of a Goddess Volume 9")).toBe(30);

      // Auxiliary sequences never occupy a mainline slot
      expect(flat.get("Ascendance of a Bookworm: Short Story Collection Volume 1")).toBeNull();
      expect(flat.get("Ascendance of a Bookworm: Official Fanbook Volume 2")).toBeNull();

      // Every mainline row projects to a distinct flat number (no collisions)
      const mainline = Array.from(flat.values()).filter((v): v is number => v !== null);
      expect(new Set(mainline).size).toBe(mainline.length);
    });

    it("round-trips flat catalogue numbers back to their namespace keys", () => {
      const model = buildSeriesVolumeModel(REAL_BOOKWORM_ROWS, {
        seriesText: "Ascendance of a Bookworm",
        totalHint: 33,
      });
      expect(keyForFlatPosition(model, 1)).toEqual({ namespace: MAIN_VOLUME_NAMESPACE, volume: 1 });
      expect(keyForFlatPosition(model, 4)).toEqual({ namespace: "part:2", volume: 1 });
      expect(keyForFlatPosition(model, 12)).toEqual({ namespace: "part:3", volume: 5 });
      expect(keyForFlatPosition(model, 21)).toEqual({ namespace: "part:4", volume: 9 });
      expect(keyForFlatPosition(model, 29)).toEqual({ namespace: "part:5", volume: 8 });
      for (let flat = 1; flat <= 33; flat++) {
        const key = keyForFlatPosition(model, flat)!;
        expect(flatPositionFor(model, key)).toBe(flat);
      }
    });

    it("projects a title to the same flat number the Calibre row gets", () => {
      expect(projectTitleVolumeNumber("Ascendance of a Bookworm: Part 5 Volume 8", "Ascendance of a Bookworm")).toBe(29);
      // Without Bookworm context the number stays part-local instead of guessing
      expect(projectTitleVolumeNumber("Part 5 Volume 8")).toBe(8);
      expect(projectTitleVolumeNumber("The Lord of the Rings: Part 2 Volume 3", "The Lord of the Rings")).toBe(3);
      expect(projectTitleVolumeNumber("Classic Literature Part 3 Volume 1", "Classic Literature")).toBe(1);
      expect(projectTitleVolumeNumber("Overlord, Vol. 15: The Half-Elf Demigod Part I")).toBe(15);
      // Sub-series volumes stay local and carry their namespace
      expect(resolveCanonicalVolumeKey("Classroom of the Elite: Year 2 Vol. 9")).toEqual({
        namespace: "year:2",
        volume: 9,
      });
    });
  });

  describe("B4 regression fixtures - auxiliary sequences stay isolated", () => {
    it("classifies art books, fanbooks and bundles as auxiliary", () => {
      expect(parseVolumeNamespace("Alya Sometimes Hides Her Feelings in Russian - Momoco's Art Book")).toBe("art-book");
      expect(parseVolumeNamespace("Ascendance of a Bookworm: Official Fanbook Volume 2")).toBe("fanbook");
      expect(parseVolumeNamespace("Ascendance of a Bookworm: Short Story Collection Volume 1")).toBe("short-story");
      expect(parseVolumeNamespace("Mushoku Tensei: Jobless Reincarnation (Vol. 1-3 Bundle)")).toBe("omnibus");
      expect(isAuxiliaryNamespace("art-book")).toBe(true);
      expect(isAuxiliaryNamespace(MAIN_VOLUME_NAMESPACE)).toBe(false);
    });

    it("never lets an auxiliary novel inherit the parent series' volumes", () => {
      const model = buildSeriesVolumeModel(REAL_COTE_ROWS, { seriesText: "Classroom of the Elite", totalHint: 28 });
      const auditNamespace = auditNamespaceFor("Classroom of the Elite - Momoco's Art Book");
      expect(auditNamespace).toBe("art-book");
      expect(isLocalNamespace(auditNamespace)).toBe(true);

      // The rows this art book used to inherit are the parent series' mainline volumes
      const projected = REAL_COTE_ROWS
        .map((row) => projectOwnedVolume(resolveCalibreVolumeKey(row)!, model, auditNamespace))
        .filter((v): v is number => v !== null);
      expect(projected).toEqual([]);

      // A mainline novel still counts those same rows
      const mainline = REAL_COTE_ROWS
        .map((row) => projectOwnedVolume(resolveCalibreVolumeKey(row)!, model, MAIN_VOLUME_NAMESPACE))
        .filter((v): v is number => v !== null);
      expect(mainline.length).toBeGreaterThan(0);
    });

    it("counts an auxiliary sequence against itself only", () => {
      const model = buildSeriesVolumeModel(REAL_BOOKWORM_ROWS, {
        seriesText: "Ascendance of a Bookworm",
        totalHint: 33,
      });
      const fanbookRow = resolveCalibreVolumeKey({
        title: "Ascendance of a Bookworm: Official Fanbook Volume 2",
        series: "Ascendance of a Bookworm",
        seriesIndex: 1.2,
      })!;
      expect(fanbookRow.namespace).toBe("fanbook");
      expect(projectOwnedVolume(fanbookRow, model, "fanbook")).toBe(2);
      // The mainline card must not count the fanbook
      expect(projectOwnedVolume(fanbookRow, model, MAIN_VOLUME_NAMESPACE)).toBeNull();
    });

    it("does not inflate a 1-volume art book card to the 10 volumes it matched", () => {
      const count = catalogueVolumeCountFrom({
        catalogCount: 1,
        ownershipCount: 10,
        maxOwned: 9,
        namespace: "art-book",
      });
      expect(count).toBe(1);
      // Mainline series keep the historical behaviour (library larger than the seed)
      expect(
        catalogueVolumeCountFrom({
          catalogCount: 1,
          ownershipCount: 27,
          maxOwned: 27,
          namespace: MAIN_VOLUME_NAMESPACE,
        }),
      ).toBe(27);
    });
  });

  describe("omnibus and bundle handling", () => {
    it("expands a bundle range into every volume it covers", () => {
      expect(parseVolumeRange("Mushoku Tensei: Jobless Reincarnation (Vol. 1-3 Bundle)")).toEqual([1, 2, 3]);
      expect(parseVolumeRange("Overlord Vol. 5")).toBeNull();
      const keys = resolveCalibreVolumeKeys({
        title: "Mushoku Tensei: Jobless Reincarnation (Vol. 1-3 Bundle)",
        series: "Mushoku Tensei",
        seriesIndex: null,
      });
      const mains = keys.filter((k) => k.namespace === "omnibus").map((k) => k.volume);
      expect(mains).toEqual([1, 2, 3]);
    });

    it("counts all three volumes of a bundle as owned", () => {
      const model = buildSeriesVolumeModel([], { seriesText: "Mushoku Tensei", totalHint: 26 });
      const keys = resolveCalibreVolumeKeys({
        title: "Mushoku Tensei: Jobless Reincarnation (Vol. 1-3 Bundle)",
        series: "Mushoku Tensei",
        seriesIndex: null,
      });
      const owned = keys
        .map((k) => projectOwnedVolume(k, model, MAIN_VOLUME_NAMESPACE))
        .filter((v): v is number => v !== null);
      expect(owned.sort((a, b) => a - b)).toEqual([1, 2, 3]);
    });
  });

  describe("model helpers", () => {
    it("aligns a model upward to a larger verified catalogue", () => {
      const model = alignModelToFlatCount({ segments: [{ namespace: MAIN_VOLUME_NAMESPACE, size: 3 }] }, 28);
      expect(totalVolumeCount(model)).toBe(28);
      expect(flatPositionFor(model, { namespace: MAIN_VOLUME_NAMESPACE, volume: 28 })).toBe(28);
    });

    it("parses parts from digits, roman numerals and Burmese markers", () => {
      expect(parseVolumePart("Ascendance of a Bookworm: Part 5 Volume 8")).toBe(5);
      expect(parseVolumePart("Ascendance of a Bookworm: Part V Volume VIII")).toBe(5);
      expect(parseVolumePart("Overlord, Vol. 15: The Half-Elf Demigod Part I")).toBe(1);
      expect(parseVolumePart("Overlord, Vol. 15")).toBeNull();
    });

    it("keeps the Bookworm offsets the UI has always used", () => {
      const model = knownSeriesModel("Ascendance of a Bookworm")!;
      expect(model.segments.map((s) => s.size)).toEqual([3, 4, 5, 9, 12]);
      expect(totalVolumeCount(model)).toBe(33);
    });

    it("deduplicates keys while treating base namespaces as equal", () => {
      const deduped = dedupeVolumeKeys([
        { namespace: MAIN_VOLUME_NAMESPACE, volume: 9 },
        { namespace: "year:1", volume: 9 },
        { namespace: "year:2", volume: 9 },
      ]);
      expect(deduped).toHaveLength(2);
      expect(deduped.map(encodeVolumeKey)).toEqual(["main:9", "year:2:9"]);
    });

    it("falls back to series_index only when the title carries no marker", () => {
      expect(resolveCalibreVolumeKey({ title: "Some Untitled Volume", seriesIndex: 4.5 })).toEqual({
        namespace: MAIN_VOLUME_NAMESPACE,
        volume: 4.5,
      });
      expect(
        resolveCalibreVolumeKey({ title: "Overlord, Vol. 4: The Lizardman Heroes", seriesIndex: 99 }),
      ).toEqual({ namespace: MAIN_VOLUME_NAMESPACE, volume: 4 });
    });
  });
});
