/**
 * uploader/koplugin-ui.test.ts
 *
 * Proof for `koplugin-template/lighthouse_ui.lua`, the plugin's single source of
 * visual primitives: the row language (title / secondary line / glance column),
 * the glyph vocabulary, the UTF-8-safe text truncation, the page layout
 * arithmetic and the cover-cache decisions.
 *
 * The module is pure Lua, so it is driven directly through a bare interpreter -
 * no KOReader stubs, no sockets. The tests assert behaviour and relationships
 * (monotonicity, clamps, invariants, non-splitting of multi-byte text) rather
 * than transcribed literals, because the point of the file is that these
 * numbers are derived from one rule rather than hand-tuned per screen.
 *
 * Skipped when no Lua interpreter is available, like the rest of the Lua tests.
 */

import { describe, expect, it } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";

import { KOPLUGIN_TEMPLATE_DIR } from "./koplugin";

const UI_PATH = path.join(KOPLUGIN_TEMPLATE_DIR, "lighthouse_ui.lua");
const STATUS_PATH = path.join(KOPLUGIN_TEMPLATE_DIR, "lighthouse_status.lua");

/**
 * Resolves a Lua interpreter the same way the sibling Lua tests do, without
 * depending on a runtime global.
 */
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

/** A Burmese title: three bytes per glyph, so it catches byte-wise truncation. */
const BURMESE = "မြန်မာစာပေ";

/** Renders a UTF-8 string as a Lua literal of decimal byte escapes. */
function luaByteEscapes(text: string): string {
  return Array.from(Buffer.from(text, "utf8"))
    .map((byte) => `\\${byte}`)
    .join("");
}

const HARNESS = String.raw`
local ui_path = assert(arg[1], "ui module path required")
local status_path = assert(arg[2], "status module path required")
local Ui = assert(loadfile(ui_path))()
local Status = assert(loadfile(status_path))()

local function flat(text)
  return (tostring(text):gsub("\n", "\\n"))
end

-- Truncation ----------------------------------------------------------------
print("ell_short=" .. Ui.ellipsize("Dune", 10))
print("ell_exact=" .. Ui.ellipsize("Dune", 4))
print("ell_long=" .. Ui.ellipsize("Children of Time", 8))
print("ell_zero=" .. Ui.ellipsize("Dune", 0))
print("ell_negative=" .. Ui.ellipsize("Dune", -3))
print("ell_nil_limit=" .. Ui.ellipsize("Dune", nil))
print("ell_nil_text=" .. Ui.ellipsize(nil, 5))
print("ell_number=" .. Ui.ellipsize(42, 5))
print("ell_multibyte=" .. Ui.ellipsize("${luaByteEscapes(BURMESE + BURMESE)}", 4))

-- Author lists --------------------------------------------------------------
print("auth_none=" .. Ui.authorLine(nil, 2, "Unknown"))
print("auth_none_nofallback=" .. "[" .. Ui.authorLine("", 2, nil) .. "]")
print("auth_one=" .. Ui.authorLine("Frank Herbert", 2, "Unknown"))
print("auth_two=" .. Ui.authorLine("Brian Herbert, Kevin J. Anderson", 2, "Unknown"))
print("auth_three=" .. Ui.authorLine("A One, B Two, C Three", 2, "Unknown"))
print("auth_newlines=" .. Ui.authorLine("Isuna Hasekura\nJyuu Ayakura", 2, "Unknown"))
print("auth_semicolons=" .. Ui.authorLine("A One; B Two", 2, "Unknown"))
print("auth_blank_chunks=" .. Ui.authorLine("A One,, ,B Two", 2, "Unknown"))
print("auth_limit_one=" .. Ui.authorLine("A One, B Two, C Three", 1, "Unknown"))
print("auth_padded=" .. Ui.authorLine("  Frank Herbert  ", 2, "Unknown"))

-- Series and the secondary line ---------------------------------------------
print("series_full=" .. "[" .. Ui.seriesLabel("Spice and Wolf", "01") .. "]")
print("series_plain=" .. "[" .. Ui.seriesLabel("Spice and Wolf", nil) .. "]")
print("series_empty=" .. "[" .. Ui.seriesLabel("", "01") .. "]")
print("series_nil=" .. "[" .. Ui.seriesLabel(nil, nil) .. "]")

print("sec_author_series=" .. Ui.secondaryLine({
  authors = "Isuna Hasekura", series = "Spice and Wolf", series_index = "01", fallback = "Unknown",
}))
print("sec_device=" .. Ui.secondaryLine({
  authors = "Isuna Hasekura", extra = "Paperwhite", fallback = "Unknown",
}))
print("sec_fallback=" .. Ui.secondaryLine({ authors = nil, fallback = "Unknown" }))
print("sec_empty=" .. "[" .. Ui.secondaryLine({}) .. "]")
print("sec_max_chars=" .. Ui.secondaryLine({
  authors = "A Very Long Author Name That Runs On", series = "A Very Long Series Name Too",
  series_index = "01", max_chars = 20,
}))

-- Row text ------------------------------------------------------------------
print("row_title=" .. flat(Ui.rowTitle("Dune")))
print("row_title_nil=" .. "[" .. Ui.rowTitle(nil) .. "]")
print("row_title_blank=" .. "[" .. Ui.rowTitle("   ") .. "]")
-- Regression: newline stripping must not eat the letters r and n (Lua 5.1
-- reads %r and %n in a pattern as the literal letters).
print("row_keeps_letters=" .. flat(Ui.rowTitle("Corner of Nowhere")))
print("row_flattens_newline=" .. flat(Ui.rowTitle("Artist\nHouse")))
print("row_trims=" .. flat(Ui.rowTitle("  Dune  ")))

-- Glyphs, headings, glance column -------------------------------------------
print("section=" .. flat(Ui.sectionText("Library health")))
print("section_empty=" .. "[" .. Ui.sectionText(nil) .. "]")
-- Glyphs are taken from the module's own vocabulary rather than typed here, so
-- this harness cannot drift from the plugin's glyph set (and no non-ASCII has
-- to survive the transpiler inside a String.raw template).
local bar_40 = Ui.GLYPH.bar_full:rep(2) .. Ui.GLYPH.bar_empty:rep(4) .. " 40%"
local stars_4 = Ui.GLYPH.star_full:rep(4) .. Ui.GLYPH.star_empty
local stars_3 = Ui.GLYPH.star_full:rep(3) .. Ui.GLYPH.star_empty:rep(2)
print("glance_two=" .. Ui.glanceLine({ bar_40, stars_4 }))
print("glance_skips=" .. Ui.glanceLine({ nil, "", stars_3, " " }))
print("glance_empty=" .. "[" .. Ui.glanceLine({}) .. "]")
print("join_sep=" .. Ui.join({ "a", "b" }))

-- The metadata column budgets the glance first, so progress and rating are
-- always drawn in full.
local meta_bar = Ui.GLYPH.bar_full:rep(6) .. " 100% " .. Ui.GLYPH.done
local meta_stars = Ui.GLYPH.star_full:rep(4) .. Ui.GLYPH.star_empty
local meta_glance = meta_bar .. Ui.GLYPH.separator .. meta_stars
local meta_short_secondary = "Isuna Hasekura" .. Ui.GLYPH.separator .. "Spice and Wolf 01"
local meta_long_secondary = "Brandon Sanderson" .. Ui.GLYPH.separator .. "The Stormlight Archive 01"
print("meta_short=" .. Ui.metaColumn(meta_short_secondary, meta_glance))
print("meta_long=" .. Ui.metaColumn(meta_long_secondary, meta_glance))
print("meta_glance_only=" .. Ui.metaColumn(nil, meta_glance))
print("meta_no_glance=" .. Ui.metaColumn(meta_long_secondary, nil))
print("meta_limit=" .. tostring(Ui.tokens.meta_max_chars))

-- The font contract: every glyph must be a code point KOReader's bundled text
-- fonts (Noto Sans, DejaVu fallback) actually carry. Anything above Dingbats is
-- an emoji or symbol with no coverage on the device and draws as a box.
local function code_points(text)
  local points = {}
  local index = 1
  while index <= #text do
    local byte = text:byte(index)
    local length, point
    if byte < 0x80 then
      length, point = 1, byte
    elseif byte < 0xE0 then
      length, point = 2, byte - 0xC0
    elseif byte < 0xF0 then
      length, point = 3, byte - 0xE0
    else
      length, point = 4, byte - 0xF0
    end
    for offset = 1, length - 1 do
      point = point * 64 + ((text:byte(index + offset) or 0x80) - 0x80)
    end
    points[#points + 1] = point
    index = index + length
  end
  return points
end

-- Latin-1, General Punctuation, Block Elements/Box Drawing/Geometric Shapes,
-- Miscellaneous Symbols, Dingbats: the blocks those fonts cover.
local font_coverage = {
  { 0x20, 0xFF },
  { 0x2000, 0x206F },
  { 0x2500, 0x25FF },
  { 0x2600, 0x26FF },
  { 0x2700, 0x27BF },
}
local uncovered = {}
for name, glyph in pairs(Ui.GLYPH) do
  if type(glyph) == "string" then
    for _, point in ipairs(code_points(glyph)) do
      local found = false
      for range_index = 1, #font_coverage do
        if point >= font_coverage[range_index][1] and point <= font_coverage[range_index][2] then
          found = true
        end
      end
      if not found then uncovered[#uncovered + 1] = name end
    end
  end
end
print("glyph_uncovered=" .. table.concat(uncovered, ","))

local bar = Ui.glanceProgress(Status, 0.45)
print("glance_bar=" .. bar)
print("glance_slots=" .. tostring(Ui.tokens.glance_bar_slots))
local full_blocks = select(2, bar:gsub(Ui.GLYPH.bar_full, ""))
local empty_blocks = select(2, bar:gsub(Ui.GLYPH.bar_empty, ""))
print("glance_bar_blocks=" .. tostring(full_blocks + empty_blocks))
print("glance_bar_nil_status=" .. "[" .. Ui.glanceProgress(nil, 0.45) .. "]")
print("glance_bar_full=" .. Ui.glanceProgress(Status, 1))

-- Layout arithmetic ---------------------------------------------------------
local phone = Ui.layout(800, 1, true)
local phone_text = Ui.layout(800, 1, false)
local large = Ui.layout(1448, 1.875, true)
local large_text = Ui.layout(1448, 1.875, false)
local short_text = Ui.layout(300, 1, false)
local tiny_text = Ui.layout(200, 1, false)
local jumbo_text = Ui.layout(8000, 4, false)
local tiny = Ui.layout(200, 1, true)
local degenerate = Ui.layout(nil, nil, true)
local jumbo = Ui.layout(8000, 4, true)

local function dump(prefix, layout)
  print(prefix .. "_rows=" .. tostring(layout.rows))
  print(prefix .. "_row_h=" .. tostring(layout.row_height))
  print(prefix .. "_cover_w=" .. tostring(layout.cover_width))
  print(prefix .. "_cover_h=" .. tostring(layout.cover_height))
  print(prefix .. "_gutter=" .. tostring(layout.gutter))
end
dump("phone", phone)
dump("phone_text", phone_text)
dump("large", large)
dump("large_text", large_text)
dump("short_text", short_text)
dump("tiny_text", tiny_text)
dump("jumbo_text", jumbo_text)
dump("tiny", tiny)
dump("degenerate", degenerate)
dump("jumbo", jumbo)
print("rows_min=" .. tostring(Ui.tokens.rows_min))
print("rows_max=" .. tostring(Ui.tokens.rows_max))

-- Invariants that must hold for every screen size ---------------------------
local screens = {
  { 600, 1 }, { 800, 1 }, { 1072, 1.5 }, { 1448, 1.875 }, { 1440, 2 }, { 2160, 3 },
}
local invariants_ok = true
for screen_index = 1, #screens do
  local height, scale = screens[screen_index][1], screens[screen_index][2]
  local with_covers = Ui.layout(height, scale, true)
  local without = Ui.layout(height, scale, false)
  if with_covers.cover_height > with_covers.row_height then invariants_ok = false end
  if with_covers.gutter < with_covers.cover_width then invariants_ok = false end
  if without.gutter ~= 0 or without.cover_width ~= 0 or without.cover_height ~= 0 then
    invariants_ok = false
  end
  if without.rows < with_covers.rows then invariants_ok = false end
  if with_covers.rows < Ui.tokens.rows_min or with_covers.rows > Ui.tokens.rows_max then
    invariants_ok = false
  end
  -- A text page follows the screen: it may carry more rows than the cover cap
  -- allows, but never fewer than the floor.
  if without.rows < Ui.tokens.rows_min then invariants_ok = false end
  if without.row_height < 1 then invariants_ok = false end
  -- The cover box must stay portrait, near the token aspect.
  local aspect = with_covers.cover_width / with_covers.cover_height
  if math.abs(aspect - Ui.tokens.cover_aspect) > 0.01 then invariants_ok = false end
end
print("invariants=" .. tostring(invariants_ok))

-- Cover cache decisions -----------------------------------------------------
print("cover_name=" .. tostring(Ui.coverCacheName(553, 360)))
print("cover_name_other_width=" .. tostring(Ui.coverCacheName(553, 200)))
print("cover_name_default=" .. tostring(Ui.coverCacheName("553")))
print("cover_name_nil=" .. tostring(Ui.coverCacheName(nil, 360)))
print("cover_name_junk=" .. tostring(Ui.coverCacheName("abc", 360)))
print("cover_miss=" .. tostring(Ui.coverMissName(553, 360)))
print("cover_miss_stem_shared=" .. tostring(
  Ui.coverMissName(553, 360):sub(1, #Ui.coverCacheName(553, 360)) == Ui.coverCacheName(553, 360)
))

local now = 1800000000
print("fresh_new=" .. tostring(Ui.isFresh(now - 10, now)))
print("fresh_old=" .. tostring(Ui.isFresh(now - 31 * 24 * 3600, now)))
print("fresh_nil=" .. tostring(Ui.isFresh(nil, now)))
print("fresh_no_now=" .. tostring(Ui.isFresh(now, nil)))
print("fresh_future=" .. tostring(Ui.isFresh(now + 3600, now)))
print("fresh_custom_ttl=" .. tostring(Ui.isFresh(now - 100, now, 50)))

print("budget_ok=" .. tostring(Ui.coverBudgetLeft(0, now, now + 1)))
print("budget_time_out=" .. tostring(Ui.coverBudgetLeft(0, now, now + 60)))
print("budget_count_out=" .. tostring(Ui.coverBudgetLeft(Ui.tokens.cover_fetch_max, now, now + 1)))
print("budget_nil_time=" .. tostring(Ui.coverBudgetLeft(1, nil, nil)))

print("OK")
`;

/** Runs the harness and splits stdout into a key/value map. */
function runHarness(): Record<string, string> {
  const workdir = fs.mkdtempSync(path.join(os.tmpdir(), "koplugin-ui-"));
  const harnessPath = path.join(workdir, "ui_harness.lua");
  fs.writeFileSync(harnessPath, HARNESS);
  const res = spawnSync(LUA_BINARY as string, [harnessPath, UI_PATH, STATUS_PATH], {
    encoding: "utf8",
  });
  expect(res.stderr).toBe("");
  expect(res.status).toBe(0);
  return Object.fromEntries(
    res.stdout
      .split("\n")
      .filter((line: string) => line.includes("="))
      .map((line: string) => {
        const index = line.indexOf("=");
        return [line.slice(0, index), line.slice(index + 1)];
      }),
  );
}

/** Counts UTF-8 code points, the unit the plugin measures text in. */
function codePoints(text: string): number {
  return Array.from(text).length;
}

describe("plugin UI primitives: text truncation", () => {
  it("keeps text that fits and ellipsizes the rest to the limit", () => {
    if (!LUA_BINARY) return;
    const out = runHarness();
    expect(out.ell_short).toBe("Dune");
    expect(out.ell_exact).toBe("Dune");
    expect(codePoints(out.ell_long)).toBe(8);
    expect(out.ell_long.endsWith("…")).toBe(true);
    expect(out.ell_long.startsWith("Childr")).toBe(true);
  });

  it("degrades to an empty string instead of raising on junk limits", () => {
    if (!LUA_BINARY) return;
    const out = runHarness();
    expect(out.ell_zero).toBe("");
    expect(out.ell_negative).toBe("");
    expect(out.ell_nil_limit).toBe("");
    expect(out.ell_nil_text).toBe("");
    expect(out.ell_number).toBe("");
  });

  it("never splits a multi-byte glyph when cutting Burmese text", () => {
    if (!LUA_BINARY) return;
    const out = runHarness();
    // Four code points means three kept glyphs plus the ellipsis, and the byte
    // length must be a whole number of 3-byte Burmese glyphs plus the ellipsis:
    // a byte-wise cut would leave a partial sequence behind.
    expect(Array.from(out.ell_multibyte).length).toBe(4);
    expect(Buffer.byteLength(out.ell_multibyte, "utf8")).toBe(3 * 3 + 3);
    expect(out.ell_multibyte.endsWith("…")).toBe(true);
  });
});

describe("plugin UI primitives: author and series metadata", () => {
  it("falls back when there is no author, and says so when there is no fallback", () => {
    if (!LUA_BINARY) return;
    const out = runHarness();
    expect(out.auth_none).toBe("Unknown");
    expect(out.auth_none_nofallback).toBe("[]");
    expect(out.auth_one).toBe("Frank Herbert");
    expect(out.auth_padded).toBe("Frank Herbert");
  });

  it("caps the author list and keeps the tail as a count", () => {
    if (!LUA_BINARY) return;
    const out = runHarness();
    expect(out.auth_two).toBe("Brian Herbert, Kevin J. Anderson");
    expect(out.auth_three).toBe("A One, B Two +1 more");
    expect(out.auth_limit_one).toBe("A One +2 more");
  });

  it("splits authors on the separators Calibre and KOSync actually use", () => {
    if (!LUA_BINARY) return;
    const out = runHarness();
    expect(out.auth_newlines).toBe("Isuna Hasekura, Jyuu Ayakura");
    expect(out.auth_semicolons).toBe("A One, B Two");
    expect(out.auth_blank_chunks).toBe("A One, B Two");
  });

  it("lays out a series label only when there is a series", () => {
    if (!LUA_BINARY) return;
    const out = runHarness();
    expect(out.series_full).toBe("[Spice and Wolf 01]");
    expect(out.series_plain).toBe("[Spice and Wolf]");
    expect(out.series_empty).toBe("[]");
    expect(out.series_nil).toBe("[]");
  });

  it("composes the secondary line from author, series and extra context", () => {
    if (!LUA_BINARY) return;
    const out = runHarness();
    expect(out.sec_author_series).toBe("Isuna Hasekura · Spice and Wolf 01");
    expect(out.sec_device).toBe("Isuna Hasekura · Paperwhite");
    expect(out.sec_fallback).toBe("Unknown");
    expect(out.sec_empty).toBe("[]");
    // The secondary line is capped so a row can never wrap into a third line.
    expect(Array.from(out.sec_max_chars).length).toBeLessThanOrEqual(20);
    expect(out.sec_max_chars.endsWith("…")).toBe(true);
  });
});

describe("plugin UI primitives: row language", () => {
  it("flattens a title into the one line a MenuItem can draw", () => {
    if (!LUA_BINARY) return;
    const out = runHarness();
    expect(out.row_title).toBe("Dune");
    expect(out.row_title_nil).toBe("[]");
    expect(out.row_title_blank).toBe("[]");
    expect(out.row_trims).toBe("Dune");
  });

  it("strips newlines without eating the letters r and n", () => {
    if (!LUA_BINARY) return;
    const out = runHarness();
    // A Lua 5.1 pattern of [%r%n] means "the letters r and n", not CR/LF, and
    // silently mangles titles like "Corner of Nowhere".
    expect(out.row_keeps_letters).toBe("Corner of Nowhere");
    expect(out.row_flattens_newline).toBe("Artist House");
  });

  it("marks section headings with the left bar glyph and nothing else", () => {
    if (!LUA_BINARY) return;
    const out = runHarness();
    expect(out.section).toContain("Library health");
    expect(out.section.startsWith("▍")).toBe(true);
    expect(out.section_empty).toBe("[]");
  });

  it("joins only the glance values that exist", () => {
    if (!LUA_BINARY) return;
    const out = runHarness();
    expect(out.glance_two).toBe("██░░░░ 40% · ★★★★☆");
    expect(out.glance_skips).toBe("★★★☆☆");
    expect(out.glance_empty).toBe("[]");
    expect(out.join_sep).toBe("a · b");
  });

  it("reserves the glance width so progress and rating are never cut", () => {
    if (!LUA_BINARY) return;
    const out = runHarness();
    const glance = `██████ 100% ✓ · ★★★★☆`;
    // Oracle: the row contract in lighthouse_ui.lua - the metadata column ends
    // with the complete glance and stays inside meta_max_chars. Capping the
    // composed string instead of the secondary text would leave the long row
    // showing three of five stars.
    expect(out.meta_long.endsWith(glance)).toBe(true);
    expect(out.meta_long).toContain("Brandon Sanderson");
    expect(codePoints(out.meta_long)).toBeLessThanOrEqual(Number(out.meta_limit));
    // The short row is unaffected: nothing is dropped when it already fits.
    expect(out.meta_short).toBe(`Isuna Hasekura · Spice and Wolf 01 · ${glance}`);
    // With no secondary text the glance still leads the column.
    expect(out.meta_glance_only).toBe(glance);
    // With no glance it is the plain secondary line, kept whole while it fits.
    expect(out.meta_no_glance).toBe("Brandon Sanderson · The Stormlight Archive 01");
    expect(codePoints(out.meta_no_glance)).toBeLessThanOrEqual(Number(out.meta_limit));
  });

  it("draws only code points the device's bundled fonts carry", () => {
    if (!LUA_BINARY) return;
    const out = runHarness();
    // Oracle: the coverage of KOReader's bundled text fonts (Noto Sans with a
    // DejaVu fallback), read off the Unicode blocks those fonts contain. An
    // emoji such as a magnifier sits outside every one of them and would render
    // as a missing-glyph box in the Browse screen's left gutter.
    expect(out.glyph_uncovered).toBe("");
  });

  it("draws the glance bar with the token slot count, clamped", () => {
    if (!LUA_BINARY) return;
    const out = runHarness();
    expect(out.glance_bar_blocks).toBe(out.glance_slots);
    expect(out.glance_bar).toContain("45%");
    expect(out.glance_bar).toContain("█");
    expect(out.glance_bar).toContain("░");
    // A finished book fills every slot; nothing over-fills the bar.
    expect(out.glance_bar_full).toContain("100%");
    expect(out.glance_bar_full.startsWith("█".repeat(Number(out.glance_slots)))).toBe(true);
    expect(out.glance_bar_nil_status).toBe("[]");
  });
});

describe("plugin UI primitives: page layout", () => {
  it("derives rows, row height and cover box from the screen, not a fixed guess", () => {
    if (!LUA_BINARY) return;
    const out = runHarness();
    // A 600x800 e-ink screen and a 1072x1448 one both get a coherent page.
    expect(Number(out.phone_text_rows)).toBeGreaterThanOrEqual(Number(out.phone_rows));
    // A bigger screen gets taller rows and a bigger cover, not more tiny rows.
    expect(Number(out.large_row_h)).toBeGreaterThan(Number(out.phone_row_h));
    expect(Number(out.large_cover_h)).toBeGreaterThan(Number(out.phone_cover_h));
    // Covers occupy a left gutter; the text-only layout reserves none.
    expect(Number(out.phone_gutter)).toBeGreaterThan(Number(out.phone_cover_w));
    expect(out.phone_text_gutter).toBe("0");
    expect(out.phone_text_cover_w).toBe("0");
  });

  it("holds its invariants at every screen size", () => {
    if (!LUA_BINARY) return;
    const out = runHarness();
    expect(out.invariants).toBe("true");
  });

  it("clamps a degenerate screen instead of producing a broken page", () => {
    if (!LUA_BINARY) return;
    const out = runHarness();
    for (const key of [
      "tiny_rows",
      "tiny_row_h",
      "tiny_cover_h",
      "degenerate_rows",
      "degenerate_cover_h",
      "jumbo_rows",
    ]) {
      expect(Number(out[key])).toBeGreaterThan(0);
    }
  });

  it("fits a text page to the screen and caps only a cover page", () => {
    if (!LUA_BINARY) return;
    const out = runHarness();
    const rowsMax = Number(out.rows_max);
    const rowsMin = Number(out.rows_min);

    // Oracle: the module contract - the row count follows from the height left
    // after the title bar. Clamping text views to the cover cap pins every text
    // screen to nine rows and makes the derivation above it dead code.
    expect(Number(out.large_text_rows)).toBeGreaterThan(rowsMax);
    expect(Number(out.phone_text_rows)).toBeGreaterThan(rowsMax);
    expect(Number(out.jumbo_text_rows)).toBeGreaterThan(rowsMax);

    // The cover cap still holds, on the same screens.
    expect(Number(out.large_rows)).toBeLessThanOrEqual(rowsMax);
    expect(Number(out.phone_rows)).toBeLessThanOrEqual(rowsMax);
    expect(Number(out.jumbo_rows)).toBe(rowsMax);

    // A screen too short for the floor still gets the floor, not a divided-by-
    // zero page or a single clipped row.
    expect(Number(out.tiny_text_rows)).toBe(rowsMin);
    expect(Number(out.short_text_rows)).toBeGreaterThanOrEqual(rowsMin);
    expect(Number(out.tiny_text_row_h)).toBeGreaterThan(0);
  });
});

describe("plugin UI primitives: cover cache decisions", () => {
  it("names a cache entry from the book id and the requested width", () => {
    if (!LUA_BINARY) return;
    const out = runHarness();
    expect(out.cover_name).toBe("cover_553_360.jpg");
    expect(out.cover_name_other_width).toBe("cover_553_200.jpg");
    expect(out.cover_name_default).toBe("cover_553_360.jpg");
    expect(out.cover_name_nil).toBe("nil");
    expect(out.cover_name_junk).toBe("nil");
  });

  it("shares the cache stem between a hit and a negative marker", () => {
    if (!LUA_BINARY) return;
    const out = runHarness();
    expect(out.cover_miss.startsWith(out.cover_name)).toBe(true);
    expect(out.cover_miss.endsWith(".miss")).toBe(true);
    expect(out.cover_miss_stem_shared).toBe("true");
  });

  it("refreshes a cover after the TTL but trusts a future timestamp", () => {
    if (!LUA_BINARY) return;
    const out = runHarness();
    expect(out.fresh_new).toBe("true");
    expect(out.fresh_old).toBe("false");
    expect(out.fresh_nil).toBe("false");
    expect(out.fresh_no_now).toBe("false");
    // Clock skew after a battery pull must not refetch the whole library.
    expect(out.fresh_future).toBe("true");
    expect(out.fresh_custom_ttl).toBe("false");
  });

  it("stops fetching when either the count cap or the time budget is spent", () => {
    if (!LUA_BINARY) return;
    const out = runHarness();
    expect(out.budget_ok).toBe("true");
    expect(out.budget_time_out).toBe("false");
    expect(out.budget_count_out).toBe("false");
    // A missing clock must never block the first cover.
    expect(out.budget_nil_time).toBe("true");
  });
});
