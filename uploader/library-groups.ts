/**
 * uploader/library-groups.ts
 *
 * Author and series groupings for the KOReader plugin's library switch.
 *
 * The plugin used to show one flat list. The captain's accepted design groups
 * the same library by Books, Authors or Series, and a series row has to say how
 * many volumes there are, how many are read, how far through the series the
 * reader is, and which volume comes next. None of that is in the OPDS feed: the
 * feed is paged and carries one book at a time, so counting a 400-volume series
 * from the device would mean walking the whole catalogue over the network.
 *
 * This module is therefore the one place that folds Calibre's book rows
 * together with KOSync's furthest-progress-per-book index. It is pure: books and
 * a progress map go in, grouping rows come out, and the server module only has
 * to load the two inputs and serialize the result.
 *
 * Read state comes from the caller rather than from this module: a book counts
 * as read once its furthest KOSync percentage reaches the caller's threshold
 * (`OPDS_FINISHED_THRESHOLD`, 0.99), which is the same rule the OPDS feed and the
 * reading shelf already use. A second definition here would drift from them.
 */

/** One cause the grouping functions read off a Calibre book row. */
export interface GroupableBook {
  id: number;
  title?: string | null;
  authors?: string | null;
  series?: string | null;
  series_index?: number | string | null;
  cover?: boolean | number | null;
}

/** Furthest reading percentage per Calibre book id, 0..1. */
export type ProgressMap = Map<number, number> | Record<string, number>;

/** One row of the Authors or Series grouping. */
export interface LibraryGroup {
  name: string;
  /** Series rows carry the series author; author rows leave it undefined. */
  author?: string;
  /** Volumes (series) or books (author) in this group. */
  books: number;
  /** How many of them reached the finished threshold. */
  read: number;
  /** Book id whose cover illustrates the row. */
  coverId?: number;
}

export interface LibraryGroupsResult {
  by: "series" | "author";
  books: number;
  series: number;
  authors: number;
  groups: LibraryGroup[];
}

/** Coerces untrusted catalogue text into a comparable string. */
function text(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

/**
 * Splits a Calibre author string into individual names.
 * Calibre stores co-authors in one field, comma- or ampersand-separated.
 */
export function splitAuthors(value: unknown): string[] {
  const raw = text(value);
  if (!raw) return [];
  const names: string[] = [];
  for (const part of raw.split(/[&,;]/)) {
    const name = part.trim();
    if (name && !names.includes(name)) names.push(name);
  }
  return names;
}

/** Reads the furthest percentage recorded for one book. */
function progressFor(progress: ProgressMap, bookId: number): number | undefined {
  if (progress instanceof Map) return progress.get(bookId);
  const raw = (progress as Record<string, number>)[String(bookId)];
  return typeof raw === "number" ? raw : undefined;
}

/** "A–Z" ordering that is stable across requests and locale-insensitive. */
function compareNames(a: string, b: string): number {
  return a.localeCompare(b, undefined, { sensitivity: "base", numeric: true });
}

/**
 * Groups books by series and computes each series' progress.
 *
 * A series with no readable index still groups (books) - it simply has no
 * numbered unread volume to illustrate the row with, which is better than
 * dropping real volumes from the count.
 */
export function groupBySeries(
  books: GroupableBook[],
  progress: ProgressMap,
  finishedThreshold = 0.99,
): LibraryGroup[] {
  const groups = new Map<
    string,
    {
      name: string;
      author: string;
      books: number;
      read: number;
      /** Cover of the next unread volume: what the row is about. */
      nextCoverId?: number;
      nextCoverValue: number;
      /** Cover of any volume, used when nothing is unread. */
      anyCoverId?: number;
    }
  >();

  for (const book of books) {
    const series = text(book?.series);
    if (!series) continue;
    const id = Number(book?.id);
    if (!Number.isFinite(id)) continue;

    let group = groups.get(series);
    if (!group) {
      group = {
        name: series,
        author: "",
        books: 0,
        read: 0,
        nextCoverValue: Infinity,
      };
      groups.set(series, group);
    }
    group.books += 1;
    if (!group.author) group.author = text(book.authors);

    if (book.cover && group.anyCoverId === undefined) group.anyCoverId = id;

    const percentage = progressFor(progress, id) ?? 0;
    const isRead = percentage >= finishedThreshold;
    if (isRead) {
      group.read += 1;
      continue;
    }
    // The next unread volume is the lowest-index unread one. Volumes without an
    // index never displace a numbered one, so a grouped omnibus cannot hide
    // volume 3. Its cover illustrates the row, because that is the volume the
    // reader would start next.
    const index = Number(book.series_index);
    const value = Number.isFinite(index) && index > 0 ? index : Infinity;
    if (book.cover && value < group.nextCoverValue) {
      group.nextCoverValue = value;
      group.nextCoverId = id;
    }
  }

  const result: LibraryGroup[] = [];
  for (const group of groups.values()) {
    result.push({
      name: group.name,
      author: group.author || undefined,
      books: group.books,
      read: group.read,
      coverId: group.nextCoverId ?? group.anyCoverId,
    });
  }
  result.sort((a, b) => compareNames(a.name, b.name));
  return result;
}

/**
 * Groups books by author.
 *
 * A co-authored book counts once for each of its authors, which is how Calibre's
 * own author browser behaves.
 */
export function groupByAuthor(
  books: GroupableBook[],
  progress: ProgressMap,
  finishedThreshold = 0.99,
): LibraryGroup[] {
  const groups = new Map<
    string,
    { name: string; books: number; read: number; coverId?: number }
  >();

  for (const book of books) {
    const id = Number(book?.id);
    if (!Number.isFinite(id)) continue;
    const authors = splitAuthors(book.authors);
    if (authors.length === 0) continue;
    const percentage = progressFor(progress, id) ?? 0;
    const isRead = percentage >= finishedThreshold;

    for (const name of authors) {
      let group = groups.get(name);
      if (!group) {
        group = { name, books: 0, read: 0 };
        groups.set(name, group);
      }
      group.books += 1;
      if (isRead) group.read += 1;
      if (group.coverId === undefined && book.cover) group.coverId = id;
    }
  }

  const result: LibraryGroup[] = [];
  for (const group of groups.values()) {
    result.push({
      name: group.name,
      books: group.books,
      read: group.read,
      coverId: group.coverId,
    });
  }
  result.sort((a, b) => compareNames(a.name, b.name));
  return result;
}

/**
 * Builds the whole payload for `GET /api/library/groups`.
 *
 * Both groupings are always summarized (books, series and author counts) so the
 * plugin can label its switch without a second request, but only the requested
 * grouping's rows are returned: the response stays one small document.
 */
export function buildLibraryGroups(
  books: GroupableBook[],
  progress: ProgressMap,
  by: "series" | "author",
  finishedThreshold = 0.99,
): LibraryGroupsResult {
  const safeBooks = Array.isArray(books) ? books : [];
  const seriesRows = groupBySeries(safeBooks, progress, finishedThreshold);
  const authorRows =
    by === "author" ? groupByAuthor(safeBooks, progress, finishedThreshold) : [];

  const authorNames = new Set<string>();
  for (const book of safeBooks) {
    for (const name of splitAuthors(book?.authors)) authorNames.add(name);
  }

  return {
    by,
    books: safeBooks.length,
    series: seriesRows.length,
    authors: authorNames.size,
    groups: by === "author" ? authorRows : seriesRows,
  };
}
