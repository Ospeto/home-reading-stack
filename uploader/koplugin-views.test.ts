/**
 * uploader/koplugin-views.test.ts
 *
 * Proof for `koplugin-template/lighthouse_views.lua`, the page models behind the
 * plugin's two full-screen views: the single-page reading-statistics screen and
 * the library's Books / Authors / Series switch.
 *
 * The module is pure Lua - no widgets, no sockets, no KOReader - so the tests
 * drive it through a bare interpreter and assert the *content* of each screen:
 * which bands exist, which rows they carry, what values they show, and what is
 * left out when the payload did not carry it. That is the half of the change an
 * off-device test can actually prove; the pixels are checked on the device.
 *
 * Skipped when no Lua interpreter is available, like the rest of the Lua tests.
 */

import { describe, expect, it } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";

import { KOPLUGIN_TEMPLATE_DIR } from "./koplugin";

/** Resolves a Lua interpreter the same way the sibling Lua tests do. */
function findLua(): string | null {
  for (const candidate of ["luajit", "lua5.1", "lua"]) {
    const found = spawnSync("which", [candidate], { encoding: "utf8" });
    if (found.status === 0) {
      const binary = found.stdout.trim();
      if (binary) return binary;
    }
  }
  return null;
}

const LUA_BINARY = findLua();

const HARNESS = String.raw`
package.path = assert(arg[1], "template dir required") .. "/?.lua;" .. package.path
local Views = assert(loadfile(arg[1] .. "/lighthouse_views.lua"))()
local Ui = assert(loadfile(arg[1] .. "/lighthouse_ui.lua"))()
local Stats = assert(loadfile(arg[1] .. "/lighthouse_stats.lua"))()
local Status = assert(loadfile(arg[1] .. "/lighthouse_status.lua"))()

local function flat(value)
  if value == nil then return "nil" end
  return (tostring(value):gsub("\n", " "))
end

-- A payload shaped exactly like GET /api/kosync/stats.
local payload = {
  streaks = { currentStreak = 4, longestStreak = 18 },
  dailyReadingTime = { todaySeconds = 360, thisWeekSeconds = 3840, totalHours = 76.4 },
  libraryHealth = {
    unreadCount = 1782, inProgressCount = 16, finishedCount = 4,
    totalBooks = 1802, staleCount = 9, staleThresholdDays = 30,
  },
  goal = { year = 2026, currentBooks = 6 },
  summary = { totalSessionsCount = 220, averageDailyMinutes = 68 },
  recentSessions = {
    { title = "Ballad of a Shinigami vol. 2", startTime = 1763300000, durationSeconds = 337, device = "Kindle" },
    { title = "Spice and Wolf, Vol. 9", startTime = 1763200000, durationSeconds = 2280, device = "Kindle" },
    { title = "Ascendance of a Bookworm", startTime = 1763100000, durationSeconds = 4320, device = "" },
    { title = "Fourth session", startTime = 1763000000, durationSeconds = 100, device = "KOReader" },
    { title = "No duration", startTime = 1763000000, device = "KOReader" },
  },
  heatmap = {
    { date = "2026-11-09", level = 1, minutes = 5, seconds = 300, count = 1, bookCount = 1 },
    { date = "2026-11-10", level = 0, minutes = 0, seconds = 0, count = 0, bookCount = 0 },
    { date = "2026-11-11", level = 3, minutes = 40, seconds = 2400, count = 2, bookCount = 1 },
  },
  activeBooks = {
    { bookId = 11, displayTitle = "Ballad of a Shinigami vol. 2", displayAuthors = "K-Ske Hasegawa",
      percentage = 0.62, timestamp = 1763300000, device = "Kindle" },
    { bookId = 12, displayTitle = "Spice and Wolf, Vol. 9", displayAuthors = "Isuna Hasekura",
      percentage = 0.41, timestamp = 1763200000, device = "Kindle" },
  },
}

local numbers = Stats.normalize(payload)
local sessions = Status.normalizeSessions(payload.activeBooks)
local now = 1763300000 + 3600
local model = Views.statsModel(numbers, sessions, now, {
  weeks = 52,
  year = 2026,
  today = { year = 2026, month = 11, day = 16, hour = 20, min = 0 },
  average_daily_minutes = 68,
  reading_max = 3,
  session_max = 3,
})

print("stats_title=" .. flat(model.title))
print("stats_blocks=" .. #model.blocks)
for block_index = 1, #model.blocks do
  print("stats_block_" .. block_index .. "=" .. flat(model.blocks[block_index].kind))
end

local hero = model.blocks[1].cells
print("hero_count=" .. #hero)
local hero_text = {}
for cell_index = 1, #hero do
  hero_text[#hero_text + 1] = hero[cell_index].label .. "=" .. hero[cell_index].value
end
print("hero=" .. table.concat(hero_text, "|"))

local band = model.blocks[2].columns
print("band_columns=" .. #band)
print("band_library_heading=" .. flat(band[1].heading))
print("band_year_heading=" .. flat(band[2].heading))
local library_rows = {}
for row_index = 1, #band[1].rows do
  library_rows[#library_rows + 1] = band[1].rows[row_index].label .. "=" .. band[1].rows[row_index].value
end
print("band_library_rows=" .. table.concat(library_rows, "|"))
local year_rows = {}
for row_index = 1, #band[2].rows do
  year_rows[#year_rows + 1] = band[2].rows[row_index].label .. "=" .. band[2].rows[row_index].value
end
print("band_year_rows=" .. table.concat(year_rows, "|"))

local reading = model.blocks[3]
print("reading_heading=" .. flat(reading.heading.left) .. "/" .. flat(reading.heading.right))
print("reading_rows=" .. #reading.rows)
print("reading_first=" .. flat(reading.rows[1].title) .. "//" .. flat(reading.rows[1].secondary)
  .. "//" .. flat(reading.rows[1].value) .. "//" .. flat(reading.rows[1].ratio))
print("reading_cover_id=" .. flat(reading.rows[1].cover_id))

local heat = model.blocks[4]
print("heat_kind=" .. flat(heat.kind))
print("heat_columns=" .. #heat.columns)
print("heat_heading=" .. flat(heat.heading.left) .. "/" .. flat(heat.heading.right))

local recent = model.blocks[5]
print("recent_heading=" .. flat(recent.heading.left) .. "/" .. flat(recent.heading.right))
print("recent_rows=" .. #recent.rows)
print("recent_first=" .. flat(recent.rows[1].title) .. "//" .. flat(recent.rows[1].value))
print("recent_second_line=" .. flat(recent.rows[1].secondary))
print("reading_action=" .. flat(reading.rows[1].action and reading.rows[1].action.kind))
print("recent_action=" .. flat(recent.rows[1].action and recent.rows[1].action.kind))

-- The time words a row prints come from the label table, so a translated
-- reader gets a translated screen.
local translated = Views.statsModel(
  {
    recentSessions = {
      { title = "Spice and Wolf, Vol. 9", startTime = os.time{
          year = 2026, month = 11, day = 16, hour = 13, min = 19 },
        durationSeconds = 337, device = "Kindle" },
    },
    averageDailyMinutes = 68,
  },
  {
    { title = "Ballad of a Shinigami vol. 2", authors = "K-Ske Hasegawa", percentage = 0.62,
      timestamp = now - 30 },
    { title = "Spice and Wolf, Vol. 9", authors = "Isuna Hasekura", percentage = 0.41,
      timestamp = now - 10 * 86400 },
  },
  now,
  {
    labels = {
      just_now = "a l'instant",
      clock_today = "Aujourd'hui",
      minutes_seconds = "%d mn %d s",
      months = { "janv.", "fevr.", "mars", "avr.", "mai", "juin",
        "juil.", "aout.", "sept.", "oct.", "nov.", "dec." },
    },
    today = { year = 2026, month = 11, day = 16, hour = 20, min = 0 },
  }
)
local function section_rows(page_model, nth)
  local seen = 0
  for block_index = 1, #page_model.blocks do
    local block = page_model.blocks[block_index]
    if block.kind == "section" then
      seen = seen + 1
      if seen == nth then return block.rows end
    end
  end
  return nil
end
local translated_reading = section_rows(translated, 1)
local translated_recent = section_rows(translated, 2)
print("translated_reading_line=" .. flat(translated_reading and translated_reading[1].secondary))
print("translated_old_line=" .. flat(translated_reading and translated_reading[2].secondary))
print("translated_recent_line=" .. flat(translated_recent and translated_recent[1].secondary))

print("footer_left=" .. flat(model.footer.left))
print("footer_right=" .. flat(model.footer.right))
print("stats_has_no_switch=" .. tostring(model.switch == nil))

-- One page: no per-day rows anywhere, and a fixed handful of rows.
local row_total = 0
for block_index = 1, #model.blocks do
  local block = model.blocks[block_index]
  if block.rows then row_total = row_total + #block.rows end
end
print("stats_row_total=" .. row_total)

-- An empty payload must produce a page with whatever sections exist, not a
-- page of placeholders.
local empty_model = Views.statsModel({}, {}, now, { weeks = 52 })
print("empty_blocks=" .. #empty_model.blocks)

-- The reading rows are capped by the plan, not by the payload.
local capped = Views.statsModel(numbers, sessions, now, { weeks = 52, reading_max = 1, session_max = 1 })
print("capped_reading=" .. #capped.blocks[3].rows)
print("capped_recent=" .. #capped.blocks[5].rows)

-- Library: books -----------------------------------------------------------
local entries = {
  { title = "Ballad of a Shinigami vol. 2", authors = "K-Ske Hasegawa", series = "Ballad of a Shinigami",
    series_index = 2, book_id = 11, status = { percentage = 0.62 } },
  { title = "Untouched", authors = "", book_id = 12 },
}
local books_model = Views.libraryModel("books", {
  entries = entries, page = 1, page_size = 4, has_next = true,
  query = "", totals = { books = 1802 },
})
print("books_title=" .. flat(books_model.title))
print("books_switch=" .. flat(books_model.switch[1].label) .. ":" .. flat(books_model.switch[1].active)
  .. "," .. flat(books_model.switch[2].label) .. ":" .. flat(books_model.switch[2].active)
  .. "," .. flat(books_model.switch[3].label) .. ":" .. flat(books_model.switch[3].active))
print("books_subline=" .. flat(books_model.subline.left) .. "/" .. flat(books_model.subline.right))
print("books_rows=" .. #books_model.blocks[1].rows)
print("books_row_kinds=" .. flat(books_model.blocks[1].rows[1].kind) .. "," .. flat(books_model.blocks[1].rows[2].kind))
print("books_first_row=" .. flat(books_model.blocks[1].rows[2].title) .. "//" .. flat(books_model.blocks[1].rows[2].secondary))
print("books_first_value=" .. flat(books_model.blocks[1].rows[2].value) .. "//" .. flat(books_model.blocks[1].rows[2].ratio))
print("books_last_action=" .. flat(books_model.blocks[1].rows[#books_model.blocks[1].rows].action.kind))
print("books_footer=" .. flat(books_model.footer.left) .. "/" .. flat(books_model.footer.right))

local books_last_page = Views.libraryModel("books", {
  entries = entries, page = 2, page_size = 4, has_next = false, totals = { books = 1802 },
})
print("books_last_rows=" .. #books_last_page.blocks[1].rows)
print("books_last_footer=" .. flat(books_last_page.footer.left) .. "/" .. flat(books_last_page.footer.right))

-- A feed that reports no total (a server that only sends the next link) still
-- has to name a page, and the next link is all the count there is.
local books_untotaled = Views.libraryModel("books", {
  entries = entries, page = 3, page_size = 4, has_next = true,
})
print("books_untotaled_footer=" .. flat(books_untotaled.footer.left))

-- Library: series ----------------------------------------------------------
local series_groups = {
  { name = "Ballad of a Shinigami", author = "K-Ske Hasegawa", books = 3, read = 2, coverId = 11 },
  { name = "Spice and Wolf", author = "Isuna Hasekura", books = 21, read = 9, coverId = 12 },
  { name = "The Witcher", author = "Andrzej Sapkowski", books = 8, read = 0, coverId = 13 },
  { name = "Monogatari", author = "Nisio Isin", books = 14, read = 14, coverId = 14 },
}
local series_model = Views.libraryModel("series", {
  groups = series_groups, page = 1, page_size = 4,
  totals = { books = 1802, series = 418, authors = 512 },
})
print("series_switch_active=" .. flat(series_model.switch[3].active))
print("series_subline=" .. flat(series_model.subline.left) .. "/" .. flat(series_model.subline.right))
print("series_footer=" .. flat(series_model.footer.left) .. "/" .. flat(series_model.footer.right))
local series_rows = series_model.blocks[1].rows
print("series_row_count=" .. #series_rows)
for row_index = 1, #series_rows do
  local row = series_rows[row_index]
  print("series_row_" .. row_index .. "=" .. flat(row.title) .. "//" .. flat(row.secondary)
    .. "//" .. flat(row.value) .. "//" .. flat(row.value_sub) .. "//" .. flat(row.ratio)
    .. "//" .. flat(row.cover_id))
end

-- Library: authors ---------------------------------------------------------
local author_model = Views.libraryModel("authors", {
  groups = {
    { name = "Isuna Hasekura", books = 21, read = 9, coverId = 12 },
    { name = "Andrzej Sapkowski", books = 8, read = 0, coverId = 13 },
  },
  page = 1, page_size = 4, totals = { books = 1802, authors = 512, series = 418 },
})
print("author_switch_active=" .. flat(author_model.switch[2].active))
print("author_subline=" .. flat(author_model.subline.left))
print("author_footer=" .. flat(author_model.footer.right))
print("author_first=" .. flat(author_model.blocks[1].rows[1].title) .. "//"
  .. flat(author_model.blocks[1].rows[1].secondary) .. "//" .. flat(author_model.blocks[1].rows[1].value))

-- A grouping with no rows says so instead of drawing a blank body.
local empty_series = Views.libraryModel("series", {
  groups = {}, page = 1, page_size = 4,
  totals = { books = 1802, series = 0, authors = 512 },
})
print("empty_series_rows=" .. #empty_series.blocks[1].rows)
print("empty_series_kind=" .. flat(empty_series.blocks[1].rows[1].kind))
print("empty_series_title=" .. flat(empty_series.blocks[1].rows[1].title))
print("empty_series_action=" .. flat(empty_series.blocks[1].rows[1].action))
local empty_authors = Views.libraryModel("authors", {
  groups = {}, page = 1, page_size = 4, totals = { books = 0, authors = 0 },
})
print("empty_authors_title=" .. flat(empty_authors.blocks[1].rows[1].title))

-- A page past the end draws the last page there is, and says so.
local clamped = Views.libraryModel("series", {
  groups = series_groups, page = 9, page_size = 2,
  totals = { books = 1802, series = 418, authors = 512 },
})
print("clamped_pager=" .. flat(clamped.pager.page) .. "/" .. flat(clamped.pager.pages))
print("clamped_rows=" .. #clamped.blocks[1].rows)
print("clamped_footer=" .. flat(clamped.footer.left))

-- Paging a grouping: the last page holds the remainder and still offers no
-- next page.
local paged = Views.libraryModel("series", {
  groups = series_groups, page = 2, page_size = 3, totals = { books = 1802, series = 418 },
})
print("paged_rows=" .. #paged.blocks[1].rows)
print("paged_footer=" .. flat(paged.footer.left) .. "/" .. flat(paged.footer.right))
print("paged_last_action=" .. flat(paged.blocks[1].rows[#paged.blocks[1].rows].action.kind))

-- Malformed input must not raise and must not invent rows.
local junk = Views.libraryModel("series", { groups = { { name = "" }, 5, nil }, page = 1, page_size = 3 })
print("junk_rows=" .. #junk.blocks[1].rows)
local unknown_mode = Views.libraryModel("nonsense", { entries = entries, page = 1, page_size = 4 })
print("unknown_mode_active=" .. flat(unknown_mode.switch[1].active))

print("OK")
`;

function runHarness(): Record<string, string> {
  const workdir = fs.mkdtempSync(path.join(os.tmpdir(), "koplugin-views-"));
  const harnessPath = path.join(workdir, "views_harness.lua");
  fs.writeFileSync(harnessPath, HARNESS);
  const res = spawnSync(LUA_BINARY as string, [harnessPath, KOPLUGIN_TEMPLATE_DIR], {
    encoding: "utf8",
  });
  if (res.status !== 0) {
    throw new Error(`views harness failed: ${res.stderr || res.stdout}`);
  }
  const out: Record<string, string> = {};
  for (const line of res.stdout.split("\n")) {
    const index = line.indexOf("=");
    if (index > 0) out[line.slice(0, index)] = line.slice(index + 1);
  }
  return out;
}

describe("plugin reading-stats page model", () => {
  it("is one page of bands, in the accepted order", () => {
    if (!LUA_BINARY) return;
    const out = runHarness();
    expect(out.stats_title).toBe("Reading stats");
    expect(out.stats_blocks).toBe("5");
    expect([
      out.stats_block_1,
      out.stats_block_2,
      out.stats_block_3,
      out.stats_block_4,
      out.stats_block_5,
    ]).toEqual(["hero", "band", "section", "heatmap", "section"]);
  });

  it("puts the four headline numbers in the strip", () => {
    if (!LUA_BINARY) return;
    const out = runHarness();
    expect(out.hero_count).toBe("4");
    expect(out.hero).toBe("TOTAL=76.4h|STREAK=4d|TODAY=6m|THIS WEEK=1h 4m");
  });

  it("names the shelf size in the library band and the year in the year band", () => {
    if (!LUA_BINARY) return;
    const out = runHarness();
    expect(out.band_columns).toBe("2");
    expect(out.band_library_heading).toBe("LIBRARY · 1,802");
    expect(out.band_year_heading).toBe("YEAR 2026");
    expect(out.band_library_rows).toBe("Unread=1,782|Reading=16|Finished=4|Stale 30d+=9");
    expect(out.band_year_rows).toBe("Books done=6|Hours=76.4h|Sessions=220|Longest streak=18d");
  });

  it("shows currently reading rows with cover, last read, bar and percent", () => {
    if (!LUA_BINARY) return;
    const out = runHarness();
    expect(out.reading_heading).toBe("CURRENTLY READING/2 BOOKS");
    expect(out.reading_rows).toBe("2");
    expect(out.reading_first).toBe(
      "Ballad of a Shinigami vol. 2//K-Ske Hasegawa · 1 h ago//62%//0.62",
    );
    // The cover is fetched by Calibre id, which the session carries.
    expect(out.reading_cover_id).toBe("11");
  });

  it("draws the 52-week heatmap as columns, not as one row per week", () => {
    if (!LUA_BINARY) return;
    const out = runHarness();
    expect(out.heat_kind).toBe("heatmap");
    expect(out.heat_columns).toBe("52");
    expect(out.heat_heading).toBe("ACTIVITY/LAST 52 WEEKS");
  });

  it("lists the last three sessions with when, duration and device", () => {
    if (!LUA_BINARY) return;
    const out = runHarness();
    expect(out.recent_heading).toBe("RECENT SESSIONS/LAST 3");
    expect(out.recent_rows).toBe("3");
    expect(out.recent_first).toBe("Ballad of a Shinigami vol. 2//6m");
    // Local time of the fixture is what `os.date` reports for the epoch, so the
    // line is asserted by shape: a day name, a clock and the device.
    expect(out.recent_second_line).toMatch(/^(Today|Yesterday|\d+ \w+ \d{2}:\d{2}) · /);
    expect(out.recent_second_line).toContain("5 m 37 s");
    expect(out.recent_second_line).toContain("Kindle");
    // The row with no duration is dropped rather than drawn as a blank.
    expect(out.stats_row_total).toBe("5");
  });

  it("keeps recent sessions informational and currently-reading rows tappable", () => {
    if (!LUA_BINARY) return;
    const out = runHarness();
    // A currently-reading row opens its book; a session row is a record of
    // something that already happened and must not open a book detail screen.
    expect(out.reading_action).toBe("book");
    expect(out.recent_action).toBe("nil");
  });

  it("takes the time words on every row from the label table", () => {
    if (!LUA_BINARY) return;
    const out = runHarness();
    // Same models, French labels: the relative line, the month name, the clock
    // and the duration are all the caller's words, not hardcoded English.
    expect(out.translated_reading_line).toBe("K-Ske Hasegawa · a l'instant");
    expect(out.translated_old_line).toBe("Isuna Hasekura · 6 nov.");
    expect(out.translated_recent_line).toBe("Aujourd'hui 13:19 · 5 mn 37 s · Kindle");
  });

  it("keeps a one-line footer and no grouping switch", () => {
    if (!LUA_BINARY) return;
    const out = runHarness();
    expect(out.footer_left).toBe("LightHouse");
    expect(out.footer_right).toBe("68 min on an average day · detail on web");
    expect(out.stats_has_no_switch).toBe("true");
  });

  it("renders whatever sections the payload carries instead of placeholders", () => {
    if (!LUA_BINARY) return;
    const out = runHarness();
    expect(out.empty_blocks).toBe("0");
  });

  it("caps the row lists at what the page plan allows", () => {
    if (!LUA_BINARY) return;
    const out = runHarness();
    expect(out.capped_reading).toBe("1");
    expect(out.capped_recent).toBe("1");
  });
});

describe("plugin library page model: Books", () => {
  it("leads with the switch and the search row", () => {
    if (!LUA_BINARY) return;
    const out = runHarness();
    expect(out.books_title).toBe("Library");
    expect(out.books_switch).toBe("BOOKS:true,AUTHORS:false,SERIES:false");
    expect(out.books_subline).toBe("1,802 books/A–Z");
    expect(out.books_row_kinds).toBe("action,reading");
  });

  it("shows a book's series and its progress, and offers the next page", () => {
    if (!LUA_BINARY) return;
    const out = runHarness();
    expect(out.books_first_row).toBe(
      "Ballad of a Shinigami vol. 2//K-Ske Hasegawa · Ballad of a Shinigami 02",
    );
    expect(out.books_first_value).toBe("62%//0.62");
    expect(out.books_last_action).toBe("page");
    expect(out.books_footer).toBe("Page 1 of 2/All books");
  });

  it("shows no search or next-page row when neither applies", () => {
    if (!LUA_BINARY) return;
    const out = runHarness();
    expect(out.books_last_rows).toBe("2");
    expect(out.books_last_footer).toBe("Page 2 of 2/All books");
  });

  it("pages by the feed's next link when it reports no total", () => {
    if (!LUA_BINARY) return;
    const out = runHarness();
    expect(out.books_untotaled_footer).toBe("Page 3 of 4");
  });
});

describe("plugin library page model: Series", () => {
  it("marks the series segment and names the grouping in the footer", () => {
    if (!LUA_BINARY) return;
    const out = runHarness();
    expect(out.series_switch_active).toBe("true");
    expect(out.series_subline).toBe("418 series · 1,802 books/A–Z");
    expect(out.series_footer).toBe("Page 1 of 1/Grouped by series");
    expect(out.series_row_count).toBe("4");
  });

  it("shows volumes, read count and progress over the read fraction", () => {
    if (!LUA_BINARY) return;
    const out = runHarness();
    // name // author · books · read // percent // read / books // bar // cover
    expect(out.series_row_1).toBe(
      "Ballad of a Shinigami//K-Ske Hasegawa · 3 books · 2 read//67%//2 / 3//0.66666666666667//11",
    );
    expect(out.series_row_2).toBe(
      "Spice and Wolf//Isuna Hasekura · 21 books · 9 read//43%//9 / 21//0.42857142857143//12",
    );
    // Not started: a dash over the words, and no bar.
    expect(out.series_row_3).toBe(
      "The Witcher//Andrzej Sapkowski · 8 books · 0 read//—//not started//nil//13",
    );
  });

  it("reads a finished series as done, with its read count and a full bar", () => {    if (!LUA_BINARY) return;
    const out = runHarness();
    expect(out.series_row_4).toBe(
      "Monogatari//Nisio Isin · 14 books · 14 read//done//14 / 14//1//14",
    );
  });

  it("says a grouping is empty instead of drawing a blank body", () => {
    if (!LUA_BINARY) return;
    const out = runHarness();
    // A library whose books carry no series (or no author) still shows one row
    // of the page's own language, so the screen is not an unexplained blank.
    expect(out.empty_series_rows).toBe("1");
    expect(out.empty_series_kind).toBe("plain");
    expect(out.empty_series_title).toBe("No series in this library yet");
    // Informational, like the sessions: there is nothing to open.
    expect(out.empty_series_action).toBe("nil");
    expect(out.empty_authors_title).toBe("No authors in this library yet");
  });

  it("clamps a page past the end onto the last page there is", () => {
    if (!LUA_BINARY) return;
    const out = runHarness();
    // A refresh after books were deleted must not print "Page 9 of 2" over an
    // empty body: the footer, the pager and the rows all describe page 2.
    expect(out.clamped_pager).toBe("2/2");
    expect(out.clamped_rows).toBe("2");
    expect(out.clamped_footer).toBe("Page 2 of 2");
  });

  it("pages a grouping on the device", () => {
    if (!LUA_BINARY) return;
    const out = runHarness();
    expect(out.paged_rows).toBe("1");
    expect(out.paged_footer).toBe("Page 2 of 2/Grouped by series");
    expect(out.paged_last_action).toBe("series");
  });
});

describe("plugin library page model: Authors and edge cases", () => {
  it("labels the author grouping", () => {
    if (!LUA_BINARY) return;
    const out = runHarness();
    expect(out.author_switch_active).toBe("true");
    expect(out.author_subline).toBe("512 authors · 1,802 books");
    expect(out.author_footer).toBe("Grouped by author");
    expect(out.author_first).toBe("Isuna Hasekura//21 books · 9 read//43%");
  });

  it("drops a grouping row without a name instead of drawing a blank row", () => {
    if (!LUA_BINARY) return;
    const out = runHarness();
    expect(out.junk_rows).toBe("0");
  });

  it("falls back to the books segment for an unknown mode", () => {
    if (!LUA_BINARY) return;
    const out = runHarness();
    expect(out.unknown_mode_active).toBe("true");
  });
});
