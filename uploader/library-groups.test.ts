/**
 * uploader/library-groups.test.ts
 *
 * Proof for `uploader/library-groups.ts`, the folding that gives the KOReader
 * plugin's library its Books / Authors / Series switch.
 *
 * The module is pure - Calibre rows plus a furthest-progress map go in, grouping
 * rows come out - so these tests assert the arithmetic the device shows: volume
 * counts, how many are read, how far through a series the reader is, and which
 * volume provides the row's cover. Read state is injected, which is what keeps
 * this module from growing a second definition of "finished" that could drift
 * from the OPDS feed.
 */

import { describe, expect, it } from "bun:test";

import {
  buildLibraryGroups,
  groupByAuthor,
  groupBySeries,
  splitAuthors,
  type GroupableBook,
} from "./library-groups";

/** The OPDS read rule: a book is read once its furthest progress reaches 0.99. */
const FINISHED = 0.99;

const BOOKS: GroupableBook[] = [
  // Spice and Wolf: 4 volumes, 2 read, next unread is 3.
  { id: 1, title: "Spice and Wolf, Vol. 1", authors: "Isuna Hasekura", series: "Spice and Wolf", series_index: 1, cover: true },
  { id: 2, title: "Spice and Wolf, Vol. 2", authors: "Isuna Hasekura", series: "Spice and Wolf", series_index: 2, cover: true },
  { id: 3, title: "Spice and Wolf, Vol. 3", authors: "Isuna Hasekura", series: "Spice and Wolf", series_index: 3, cover: false },
  { id: 4, title: "Spice and Wolf, Vol. 4", authors: "Isuna Hasekura", series: "Spice and Wolf", series_index: 4, cover: false },
  // The Witcher: nothing started.
  { id: 5, title: "The Last Wish", authors: "Andrzej Sapkowski", series: "The Witcher", series_index: 1, cover: true },
  { id: 6, title: "Blood of Elves", authors: "Andrzej Sapkowski", series: "The Witcher", series_index: 2, cover: true },
  // Monogatari: finished.
  { id: 7, title: "Kizumonogatari", authors: "Nisio Isin", series: "Monogatari", series_index: 1, cover: true },
  // A standalone book: no series at all.
  { id: 8, title: "Dune", authors: "Frank Herbert", cover: true },
  // A co-authored book, which counts for both authors.
  { id: 9, title: "Good Omens", authors: "Terry Pratchett & Neil Gaiman", cover: false },
];

const PROGRESS = new Map<number, number>([
  [1, 1],
  [2, 1],
  [3, 0.4],
  [7, 1],
]);

describe("library groupings: series", () => {
  it("counts volumes and read volumes, and shows the next unread volume's cover", () => {
    const groups = groupBySeries(BOOKS, PROGRESS, FINISHED);
    const spice = groups.find((group) => group.name === "Spice and Wolf");
    expect(spice).toBeDefined();
    expect(spice!.books).toBe(4);
    expect(spice!.read).toBe(2);
    expect(spice!.author).toBe("Isuna Hasekura");
    // The cover illustrates the row: the next unread volume that has one, and
    // only when nothing is unread the first volume that does.
    expect(spice!.coverId).toBe(1);
  });

  it("counts a series nobody has started", () => {
    const groups = groupBySeries(BOOKS, PROGRESS, FINISHED);
    const witcher = groups.find((group) => group.name === "The Witcher");
    expect(witcher!.books).toBe(2);
    expect(witcher!.read).toBe(0);
  });

  it("leaves standalones out of the series grouping", () => {
    const groups = groupBySeries(BOOKS, PROGRESS, FINISHED);
    expect(groups.map((group) => group.name)).not.toContain("Dune");
    expect(groups).toHaveLength(3);
  });

  it("sorts A-Z so the list reads alphabetically on the device", () => {
    const groups = groupBySeries(BOOKS, PROGRESS, FINISHED);
    expect(groups.map((group) => group.name)).toEqual([
      "Monogatari",
      "Spice and Wolf",
      "The Witcher",
    ]);
  });

  it("treats a book with no progress as unread and one at the threshold as read", () => {
    const groups = groupBySeries(
      [
        { id: 10, authors: "A", series: "S", series_index: 1 },
        { id: 11, authors: "A", series: "S", series_index: 2 },
      ],
      new Map([[11, FINISHED - 0.001], [10, FINISHED]]),
      FINISHED,
    );
    expect(groups[0].read).toBe(1);
  });

  it("keeps an unnumbered volume from hiding a numbered one", () => {
    const groups = groupBySeries(
      [
        { id: 20, authors: "A", series: "S", series_index: null, cover: true },
        { id: 21, authors: "A", series: "S", series_index: 5, cover: true },
      ],
      new Map(),
      FINISHED,
    );
    expect(groups[0].books).toBe(2);
    // The numbered volume is the one the reader would start next, so its cover
    // is the row's; the unnumbered omnibus never displaces it.
    expect(groups[0].coverId).toBe(21);
  });
});

describe("library groupings: authors", () => {
  it("counts a co-authored book for each of its authors", () => {
    const groups = groupByAuthor(BOOKS, PROGRESS, FINISHED);
    const names = groups.map((group) => group.name);
    expect(names).toContain("Terry Pratchett");
    expect(names).toContain("Neil Gaiman");
    const terry = groups.find((group) => group.name === "Terry Pratchett")!;
    expect(terry.books).toBe(1);
    expect(terry.read).toBe(0);
  });

  it("counts read books per author", () => {
    const groups = groupByAuthor(BOOKS, PROGRESS, FINISHED);
    const isuna = groups.find((group) => group.name === "Isuna Hasekura")!;
    expect(isuna.books).toBe(4);
    expect(isuna.read).toBe(2);
  });

  it("skips a book with no usable author instead of inventing one", () => {
    const groups = groupByAuthor([{ id: 30, title: "Anonymous" }], new Map(), FINISHED);
    expect(groups).toEqual([]);
  });
});

describe("library groupings: payload and edge cases", () => {
  it("returns the requested grouping, plus the totals the switch labels need", () => {
    const series = buildLibraryGroups(BOOKS, PROGRESS, "series", FINISHED);
    expect(series.by).toBe("series");
    expect(series.books).toBe(BOOKS.length);
    expect(series.series).toBe(3);
    // Nine books, six distinct authors (the co-authored pair counts twice).
    expect(series.authors).toBe(6);
    expect(series.groups).toHaveLength(3);

    const authors = buildLibraryGroups(BOOKS, PROGRESS, "author", FINISHED);
    expect(authors.by).toBe("author");
    expect(authors.groups.length).toBe(6);
    // Only the requested grouping's rows travel: the device pages one list.
    expect(authors.groups.every((group) => typeof group.name === "string")).toBe(true);
  });

  it("accepts a plain object as the progress index, not only a Map", () => {
    const groups = groupBySeries(BOOKS, { "1": 1, "2": 1, "3": 0.4 }, FINISHED);
    const spice = groups.find((group) => group.name === "Spice and Wolf")!;
    expect(spice.read).toBe(2);
  });

  it("survives malformed input without inventing rows", () => {
    const groups = groupBySeries(
      [
        { id: Number.NaN, series: "Broken" } as GroupableBook,
        { id: 40, series: "   " } as GroupableBook,
        { id: 41, series: "Real", authors: "A" },
      ],
      new Map(),
      FINISHED,
    );
    expect(groups).toHaveLength(1);
    expect(groups[0].name).toBe("Real");
    expect(buildLibraryGroups(undefined as never, new Map(), "series").books).toBe(0);
  });

  it("splits the author spellings Calibre actually stores", () => {
    expect(splitAuthors("Ann One, Bob Two")).toEqual(["Ann One", "Bob Two"]);
    expect(splitAuthors("Terry Pratchett & Neil Gaiman")).toEqual([
      "Terry Pratchett",
      "Neil Gaiman",
    ]);
    // A repeated name in one field is one author, not two.
    expect(splitAuthors("Ann One, Ann One")).toEqual(["Ann One"]);
    expect(splitAuthors("")).toEqual([]);
    expect(splitAuthors(null)).toEqual([]);
  });
});
