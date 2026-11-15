--[[--
Shared visual primitives for the LightHouse KOReader plugin.

Every screen the plugin draws - browse, search, the currently-reading shelf and
reading statistics - is assembled from the tokens and helpers in this one file,
so a later change cannot move the type scale, the row rhythm, the left gutter,
the glyph vocabulary or the cover geometry on one screen while leaving the
others behind. main.lua builds widgets; this file owns the numbers, the strings
and the arithmetic behind them.

Design rules this file encodes (e-ink, judged at 1 bit):

  * Nothing is carried by colour alone. Emphasis comes from weight (bold),
    position (leading text, left gutter, right column), a glyph, or a bar. An
    e-ink panel would render the web dashboard's amber accents as one grey.
  * Only glyphs KOReader's bundled fonts carry are used: block and box
    drawing, stars, middot, ellipsis, check and chevron. See `Ui.GLYPH`.
  * Rows share one shape everywhere: the title leads the row and one compact
    right-hand metadata column carries the secondary values (author, series,
    progress, rating) that can be read without tapping. Section headings are
    marked with a left block bar, the e-ink equivalent of the web app's accent
    border.
  * Every measure below is expressed in "units" that main.lua multiplies by
    `Screen:scaleBySize(1)`, so the same layout appears on a 600px and a
    1072px screen without a second table of magic numbers.

The module is pure Lua: no sockets, no widgets, no KOReader requires. The
repository's off-device suite exercises every helper here directly.

Row anatomy (the contract every screen follows):

    | cover | Title                    | Isuna Hasekura · Spice and Wolf 01 · ███░░░ 45% |
    ^ left gutter, covers on     ^ `item.mandatory`: author, series, progress, rating

The row is one line, because that is the shape KOReader's `MenuItem` draws:
`item.text` is the title, `item.mandatory` is the everything-else column.
]]
local Ui = {}

--- The plugin's whole visual scale, in one table.
--
-- Changing a value here changes every screen at once; that is the point. Units
-- are multiplied by the device scale, so read them as "at 160 dpi".
Ui.tokens = {
    -- Row anatomy -------------------------------------------------------
    --: Total width of the metadata column. The glance is budgeted inside it
    --: first, so a runaway author list can never push progress or rating out.
    meta_max_chars = 64,
    --: Characters kept in the secondary metadata before it is ellipsized, so a
    --: long author list can never dominate the metadata column.
    secondary_max_chars = 44,
    --: Author names shown before "and N more" takes over.
    secondary_max_authors = 2,
    --: Progress-bar slots in the right-hand value column (the detail view
    --: keeps the wider eight-slot bar).
    glance_bar_slots = 6,
    detail_bar_slots = 8,

    -- Layout ------------------------------------------------------------
    --: Title bar + page footer + window borders, title-units.
    chrome_units = 62,
    --: Height one row aims for, with and without a cover.
    row_units_covers = 122,
    row_units_plain = 46,
    --: Rows per page is clamped to this window so no screen is absurd.
    rows_min = 4,
    rows_max = 9,
    --: Cover box height is clamped to this window, title-units.
    cover_min_units = 34,
    cover_max_units = 120,
    --: Space between the cover and the text column, title-units.
    gutter_units = 10,
    --: Cover box width / height. Calibre cover art is near 2:3.
    cover_aspect = 0.6667,

    -- Cover thumbnails --------------------------------------------------
    --: Width requested from `GET /api/books/<id>/cover?w=` (the feed's own
    --: thumbnail link already points at this size).
    cover_width_px = 360,
    --: A cached cover older than this is fetched again on the next page.
    cover_ttl_seconds = 30 * 24 * 60 * 60,
    --: Wall-clock budget for fetching missing covers on one page open. A
    --: single request is issued under what is left of it, so one stalled
    --: cover cannot outlive the page.
    cover_fetch_seconds = 6,
    --: Hard cap on fetches per page open, whatever the budget says.
    cover_fetch_max = 12,
    --: Cached covers are JPEG: the server content-negotiates on Accept and
    --: this plugin's client asks for no WebP, so the bytes on disk are JPEG.
    cover_extension = "jpg",
    --: File-name stem for one cached cover / one negative-cache marker.
    cover_name_format = "cover_%s_%d",
    cover_miss_suffix = ".miss",
}

--- The plugin's complete glyph vocabulary.
-- Each of these is present in KOReader's bundled fonts (Noto Sans / DejaVu
-- fallback). Nothing outside this table is drawn, so adding an emoji is a
-- visible decision rather than an accident.
Ui.GLYPH = {
    --: Marks an actionable row that opens a detail view.
    chevron = "▸",
    --: Left bar that marks a section heading (the web app's accent border).
    section = "▍",
    --: Filled / empty progress slots.
    bar_full = "█",
    bar_empty = "░",
    --: Rating: filled / empty star.
    star_full = "★",
    star_empty = "☆",
    --: Reading a book to the end.
    done = "✓",
    --: Placeholder glyph inside a cover slot with no image yet.
    cover = "▤",
    --: Separator between metadata parts and between glanceable values.
    separator = " · ",
    ellipsis = "…",
}

--- The value a row shows when a number is genuinely unknown.
-- Deliberately a word, not a dash: a dash reads as zero on a statistics screen.
Ui.UNAVAILABLE = "unavailable"

local SEPARATOR = Ui.GLYPH.separator

--- Trims leading and trailing whitespace and flattens newlines.
-- The newline class is written with escapes rather than `[%r%n]`: in Lua 5.1
-- patterns `%r` and `%n` are not CR/LF, they are the literal letters, which
-- would strip every "r" and "n" out of a title.
-- @string text
-- @treturn string
local function oneLine(text)
    if type(text) ~= "string" then return "" end
    text = text:gsub("[\r\n]+", " ")
    text = text:gsub("^%s+", "")
    return (text:gsub("%s+$", ""))
end

--- Counts UTF-8 code points (a Burmese letter is three bytes, one glyph).
-- @string text
-- @treturn number
local function graphemeCount(text)
    local count = 0
    for byte_index = 1, #text do
        local byte = text:byte(byte_index)
        if byte < 0x80 or byte >= 0xC0 then count = count + 1 end
    end
    return count
end

--- Coerces a value into a number inside a range, or returns the fallback.
-- @param value number|string|nil
-- @number fallback
-- @number[opt] minimum
-- @number[opt] maximum
-- @treturn number
local function numberIn(value, fallback, minimum, maximum)
    local parsed = tonumber(value)
    if not parsed or parsed ~= parsed then return fallback end -- nil or NaN
    if minimum and parsed < minimum then parsed = minimum end
    if maximum and parsed > maximum then parsed = maximum end
    return parsed
end

--- Shortens a string to at most `max_chars` code points, ending in an ellipsis.
--
-- Byte-wise truncation would split a Burmese or CJK letter in half and the
-- result would render as garbage on the device, so the cut is made on a
-- code-point boundary.
-- @string text
-- @number max_chars
-- @treturn string
function Ui.ellipsize(text, max_chars)
    if type(text) ~= "string" or text == "" then return "" end
    local limit = math.floor(numberIn(max_chars, 0, 0))
    if limit < 1 then return "" end
    if graphemeCount(text) <= limit then return text end
    local keep = limit - 1
    local seen, cut = 0, 0
    for byte_index = 1, #text do
        local byte = text:byte(byte_index)
        if byte < 0x80 or byte >= 0xC0 then
            seen = seen + 1
            if seen > keep then break end
        end
        cut = byte_index
    end
    if cut < 1 then return Ui.GLYPH.ellipsis end
    return text:sub(1, cut) .. Ui.GLYPH.ellipsis
end

--- Joins the non-empty parts of a list with the plugin's separator.
-- A whitespace-only part counts as empty: a caller passing " " must not get a
-- dangling separator in the value column.
-- @tparam table parts
-- @treturn string
function Ui.join(parts)
    local kept = {}
    for part_index = 1, #(parts or {}) do
        local part = parts[part_index]
        if type(part) == "string" and oneLine(part) ~= "" then
            kept[#kept + 1] = oneLine(part)
        end
    end
    return table.concat(kept, SEPARATOR)
end

--- Shortens an author list to the first `max_authors` names.
--
-- Calibre stores co-authors in one string, sometimes appended inline and
-- sometimes newline-separated; showing all of them pushes the title out of the
-- row, so the tail becomes "+N more".
-- @string authors
-- @number[opt] max_authors defaults to the token above
-- @string[opt] fallback shown when there is no usable author
-- @treturn string
function Ui.authorLine(authors, max_authors, fallback)
    local limit = math.floor(numberIn(max_authors, Ui.tokens.secondary_max_authors, 1))
    local names = {}
    if type(authors) == "string" then
        for chunk in authors:gmatch("[^\r\n,;]+") do
            local name = oneLine(chunk)
            if name ~= "" then names[#names + 1] = name end
        end
    end
    if #names == 0 then return type(fallback) == "string" and fallback or "" end
    if #names <= limit then return table.concat(names, ", ") end
    local shown = {}
    for name_index = 1, limit do shown[#shown + 1] = names[name_index] end
    return string.format("%s +%d more", table.concat(shown, ", "), #names - limit)
end

--- Formats "Series 03" from a series name and an already-formatted index.
-- The index is passed in as text because `formatSeriesIndex` (main.lua) owns
-- the Calibre fractional-index rules; this helper only lays out the label.
-- @string series
-- @string[opt] index_text
-- @treturn string
function Ui.seriesLabel(series, index_text)
    local name = oneLine(series)
    if name == "" then return "" end
    local index = oneLine(index_text)
    if index == "" then return name end
    return name .. " " .. index
end

--- Builds the row's secondary line: author, then series, then extra context.
-- @tparam table options { authors, series, series_index, extra, fallback,
--                         max_authors, max_chars }
-- @treturn string
function Ui.secondaryLine(options)
    options = options or {}
    local parts = {}
    local authors = Ui.authorLine(options.authors, options.max_authors, options.fallback)
    if authors ~= "" then parts[#parts + 1] = authors end
    local series = Ui.seriesLabel(options.series, options.series_index)
    if series ~= "" then parts[#parts + 1] = series end
    if type(options.extra) == "string" and oneLine(options.extra) ~= "" then
        parts[#parts + 1] = oneLine(options.extra)
    end
    return Ui.ellipsize(
        table.concat(parts, SEPARATOR),
        options.max_chars or Ui.tokens.secondary_max_chars
    )
end

--- Builds the text a row shows: the title, flattened to one line.
--
-- KOReader's `MenuItem` replaces every newline in `text` with a space before
-- layout, so a stacked title/metadata block is not expressible; the metadata
-- lives in `item.mandatory` instead (see `buildRow` in main.lua).
-- @string title
-- @treturn string
function Ui.rowTitle(title)
    return oneLine(title)
end

--- Builds a section heading: a left block bar plus the label.
-- @string label
-- @treturn string
function Ui.sectionText(label)
    local name = oneLine(label)
    if name == "" then return "" end
    return Ui.GLYPH.section .. " " .. name
end

--- Builds the compact right-hand value column ("glance line").
-- Everything the reader should be able to judge without tapping a row lives
-- here: progress and rating on a catalog row, the number on a statistics row.
-- @tparam table values
-- @treturn string
function Ui.glanceLine(values)
    return Ui.join(values)
end

--- Builds a row's metadata column: the secondary text, then the glance values.
--
-- The glance is budgeted first. Progress and rating are the whole point of the
-- column, so the secondary text is capped to whatever the glance leaves room
-- for and the complete glance is always drawn last - a long author list may be
-- ellipsized, a half-drawn star row may not.
-- @string[opt] secondary
-- @string[opt] glance
-- @number[opt] max_chars total width, defaults to the token
-- @treturn string
function Ui.metaColumn(secondary, glance, max_chars)
    local limit = math.floor(numberIn(max_chars, Ui.tokens.meta_max_chars, 0))
    local tail = oneLine(glance)
    if tail == "" then return Ui.ellipsize(oneLine(secondary), limit) end
    local reserved = graphemeCount(tail) + graphemeCount(SEPARATOR)
    return Ui.join({ Ui.ellipsize(oneLine(secondary), limit - reserved), tail })
end

--- Renders a progress bar sized for the glance column.
-- Delegates to the reading-status module so the plugin has exactly one bar
-- renderer, and only chooses how many slots the narrow column can carry.
-- @tparam table status require("lighthouse_status")
-- @number ratio 0..1
-- @treturn string e.g. "██░░░ 40%"
function Ui.glanceProgress(status, ratio)
    if type(status) ~= "table" or type(status.progressBar) ~= "function" then
        return ""
    end
    return status.progressBar(ratio, Ui.tokens.glance_bar_slots)
end

--- Returns the geometry for one menu page.
--
-- The layout is derived, never hand-tuned per screen: the row count follows
-- from the height left after the title bar, and the cover box follows from the
-- row height, so a Kindle, a Kobo and a desktop-sized KOReader window all get
-- a coherent page instead of a fixed guess.
-- @number screen_h screen height in pixels
-- @number scale Screen:scaleBySize(1) for the current device
-- @boolean with_covers whether this view draws cover thumbnails
-- @treturn table { rows, row_height, cover_width, cover_height, gutter }
function Ui.layout(screen_h, scale, with_covers)
    local tokens = Ui.tokens
    local screen_scale = numberIn(scale, 1, 0.5, 4)
    local height = numberIn(screen_h, 800, 200, 8000)

    local chrome = math.floor(tokens.chrome_units * screen_scale)
    local available = height - chrome
    if available < tokens.rows_min then available = tokens.rows_min end

    local target_units = with_covers and tokens.row_units_covers or tokens.row_units_plain
    local target = math.max(math.floor(target_units * screen_scale), 1)
    local rows = math.floor(available / target)
    if rows < tokens.rows_min then rows = tokens.rows_min end
    if rows > tokens.rows_max then rows = tokens.rows_max end

    local layout = {
        rows = rows,
        row_height = math.floor(available / rows),
        cover_width = 0,
        cover_height = 0,
        gutter = 0,
    }

    if with_covers then
        -- Leave a sliver of air above and below the cover so the row does not
        -- look like four stacked images with no breathing room.
        local cover_height = layout.row_height - math.floor(4 * screen_scale)
        local tallest = math.floor(tokens.cover_max_units * screen_scale)
        local shortest = math.floor(tokens.cover_min_units * screen_scale)
        if cover_height > tallest then cover_height = tallest end
        if cover_height < shortest then cover_height = shortest end
        if cover_height < 1 then cover_height = 1 end

        layout.cover_height = cover_height
        layout.cover_width = math.max(
            math.floor(cover_height * tokens.cover_aspect + 0.5),
            1
        )
        layout.gutter = layout.cover_width + math.floor(tokens.gutter_units * screen_scale)
    end

    return layout
end

--- File name of one cached cover (relative to the plugin's cover directory).
-- @param book_id number|string
-- @number[opt] width cached thumbnail width
-- @treturn string|nil nil when the book has no usable id
function Ui.coverCacheName(book_id, width)
    local id = math.floor(numberIn(book_id, -1, 0))
    if id < 0 then return nil end
    local pixels = math.floor(numberIn(width, Ui.tokens.cover_width_px, 1))
    return string.format(Ui.tokens.cover_name_format, tostring(id), pixels)
        .. "." .. Ui.tokens.cover_extension
end

--- File name of the negative-cache marker for a book with no cover.
-- Storing a miss keeps a coverless book from costing a request on every page.
-- @param book_id number|string
-- @number[opt] width
-- @treturn string|nil
function Ui.coverMissName(book_id, width)
    local name = Ui.coverCacheName(book_id, width)
    if not name then return nil end
    return name .. Ui.tokens.cover_miss_suffix
end

--- Decides whether a cached file is still usable.
--
-- A file stamped in the future means the clock moved backwards (common on
-- e-readers with no RTC after a battery pull); that is treated as fresh rather
-- than refetching the whole library.
-- @number mtime file modification time, unix seconds
-- @number now current unix seconds
-- @number[opt] ttl seconds
-- @treturn boolean
function Ui.isFresh(mtime, now, ttl)
    local stamp = tonumber(mtime)
    local current = tonumber(now)
    if not stamp or not current then return false end
    local max_age = numberIn(ttl, Ui.tokens.cover_ttl_seconds, 0)
    local age = current - stamp
    if age < 0 then return true end
    return age <= max_age
end

--- Decides whether another cover may be fetched inside the page budget.
-- The catalog must never hang on a slow link: covers are an enhancement, so
-- both a count cap and a wall-clock budget apply, and the row falls back to the
-- neutral placeholder when either is exhausted.
-- @number fetched covers already fetched on this page
-- @number started server-time when the page's fetch loop began
-- @number now server-time now
-- @treturn boolean
function Ui.coverBudgetLeft(fetched, started, now)
    local count = numberIn(fetched, 0, 0)
    if count >= Ui.tokens.cover_fetch_max then return false end
    local begin_at = tonumber(started)
    local current = tonumber(now)
    if not begin_at or not current then return true end
    return (current - begin_at) < Ui.tokens.cover_fetch_seconds
end

return Ui
