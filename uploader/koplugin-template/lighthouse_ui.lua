--[[--
Shared visual primitives for the LightHouse KOReader plugin.

Every screen the plugin draws - browse, search, the currently-reading shelf and
reading statistics - is assembled from the tokens and helpers in this one file,
so a later change cannot move the type scale, the row rhythm, the left gutter,
the glyph vocabulary or the cover geometry on one screen while leaving the
others behind. `main.lua` builds the menu widgets and `lighthouse_page.lua` the
two full-page views; this file owns the numbers, the strings and the arithmetic
behind both.

Design rules this file encodes (e-ink, judged at 1 bit):

  * Nothing is carried by colour alone. Emphasis comes from weight (bold),
    position (leading text, left gutter, right column), a glyph, or a bar. An
    e-ink panel would render the web dashboard's amber accents as one grey.
  * Only glyphs KOReader's bundled fonts carry are used: block and box
    drawing, stars, middot, ellipsis, check and chevron. See `Ui.GLYPH`.
  * Rows are drawn in two shapes and no more. The menu row is one line: the
    title leads and one compact right-hand metadata column carries the secondary
    values (author, series, progress, rating). The one-page row adds a cover
    gutter, a secondary line and a right-hand value column with a pixel progress
    bar under the row, and is drawn in pixels by `lighthouse_page.lua`. Both keep
    the glanceable values readable without tapping. Section headings are marked
    with a left block bar, the e-ink equivalent of the web app's accent border.
  * Every measure below is expressed in "units" that main.lua multiplies by
    the device's pixels-per-unit factor (itself derived from a 600-unit
    `Screen:scaleBySize` probe, because the answer for one unit is rounded up
    to a whole pixel), so the same layout appears on a 600px and a
    1072px screen without a second table of magic numbers. A build that cannot
    answer that probe passes 1 - one unit is one pixel.

The module is pure Lua: no sockets, no widgets, no KOReader requires. The
repository's off-device suite exercises every helper here directly.

Row anatomy (the menu row: the currently-reading shelf, Highlights and the book
detail menu):

    | cover | Title                    | Isuna Hasekura · Spice and Wolf 01 · ███░░░ 45% |
    ^ left gutter, covers on     ^ `item.mandatory`: author, series, progress, rating

The menu row is one line, because that is the shape KOReader's `MenuItem` draws:
`item.text` is the title, `item.mandatory` is the everything-else column. The two
full-page views do not use it; their rows are laid out in pixels by
`lighthouse_page.lua`.
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
    --: Graphemes the metadata column may carry when the device cannot measure
    --: pixels at all. The 64 above is only safe behind a pixel fit: 64 wide
    --: glyphs are wider than a whole row, which is the crash this plugin now
    --: cannot reach. The unmeasurable fallback therefore takes the narrowest
    --: column that still holds the widest glance the row language builds - the
    --: bar, the percent, the finished check and the rating - plus a usable word
    --: of the secondary line.
    meta_unmeasured_chars = 28,
    --: Characters kept in the secondary metadata before it is ellipsized, so a
    --: long author list can never dominate the metadata column. It binds
    --: pathological input, not the layout: the one-page rows truncate in pixels
    --: through their own text widget, so this only has to be wide enough for an
    --: author plus a series name before the ellipsis eats real information.
    secondary_max_chars = 60,
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
    --: Rows per page a cover view is clamped to, so a cover page cannot spill.
    --: Text views follow the screen height instead.
    rows_min = 4,
    rows_max = 9,
    --: Hard ceiling on the metadata column's share of a row's text width, in
    --: pixels. A character budget cannot bound a pixel width - a wide-glyph
    --: script (Burmese, CJK) or the block glyphs in the progress bar measure
    --: two to three times more per character than Latin - so this share is what
    --: keeps the title column alive when a measurement is unavailable or the
    --: reader's own font is wider than the one measured.
    mandatory_share = 0.5,
    --: Pixels the title column keeps even on the narrowest screen, title-units.
    name_min_units = 40,
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

    -- Square-corner rule -------------------------------------------------
    --: Every corner this plugin draws is 90 degrees. The Kindle screen is
    --: square and the accepted design has no rounded box anywhere, so the
    --: number is a named token rather than a literal `0` sprinkled through the
    --: view: a later change that wants a radius has to say so here first.
    corner_radius = 0,
    --: Hairline rules come from the screen's own minimum drawable width, so a
    --: 1px line stays 1px on a 300dpi panel instead of turning into a smear.
    hairline_units = 1,

    -- Single-screen page geometry ----------------------------------------
    --: Every measure of the one-page views, in title-units. `Ui.pagePlan`
    --: scales them together and reports what actually fits, so not one screen
    --: carries hand-tuned numbers.
    page_pad_units = 14,
    page_gap_units = 8,
    page_header_units = 52,
    page_hero_label_units = 15,
    page_hero_value_units = 27,
    page_hero_units = 74,
    page_band_head_units = 20,
    page_band_row_units = 26,
    page_section_head_units = 25,
    page_reading_units = 88,
    page_reading_min_units = 58,
    --: A list row's band. Sized for the TYPE, not for the count: 95 units puts
    --: the row-title face at 10.3-12.3 pt on every shipping panel (K5 600x800 at
    --: 167 dpi, PW3 1072x1448 at 300 dpi, PW5SE 1236x1648 at 299 dpi) and lands
    --: SIX rows on all three. The count is what the band costs, so it is the
    --: number that has to be chosen deliberately: seven rows of 7.4 pt type is
    --: a page the reader cannot resolve, six rows of 10.8 pt is one they can.
    page_list_row_units = 95,
    --: The same row with the cover column given back to the text. Eight to nine
    --: rows of ~11 mm, which is what makes the covers-off setting usable.
    page_list_compact_units = 64,
    page_list_compact_min_units = 38,
    page_session_units = 56,
    page_session_min_units = 40,
    --: Footer band. The footer carries three tap targets plus the page number,
    --: so it is a target height (6.7-7.7 mm) rather than the 4.0 mm strip that
    --: held three 3.9 mm controls and read as a hairline.
    page_footer_units = 44,
    page_bar_units = 6,
    --: Grouping switch. A segment is a primary control, so it is sized as one:
    --: 7.9-9.1 mm instead of 6.0-7.0 mm.
    page_switch_units = 52,
    page_subline_units = 30,
    page_heat_legend_units = 18,
    page_action_h_units = 36,
    page_body_line_units = 20,
    page_quote_row_units = 104,
    page_quote_min_units = 74,
    page_detail_cover_ratio = 0.28,
    --: Row-title type: this fraction of the band the row sits in, floored at
    --: `page_row_title_min_units`. A row band is a layout OUTCOME, so a type
    --: size derived from it alone answers a different question than the one the
    --: reader asks - and the old fixed 120 px ceiling made a 178 px band on a
    --: 300 dpi panel draw the same 22 px glyphs a 167 dpi one does, which is why
    --: the panel with 80 % more pixels rendered type 22 % SMALLER.
    page_row_title_ratio = 0.26,
    page_row_title_min_units = 24,
    --: Detail synopsis type, in title-units, and the leading multiple that turns
    --: it into a line box. 23 units is ~10 pt on every panel; 1.2 is single
    --: spacing, so the glyphs fill 82 % of the box instead of the 39-47 % the old
    --: box-derived order produced (a 41 px box drawing 16 px type on a PW5SE).
    page_body_px_units = 23,
    page_body_lead_ratio = 1.2,
    --: How many lines of synopsis the Detail screen spends on its legible lede.
    --: The rest of the synopsis is one tap away in KOReader's own scroller; a
    --: page that tries to hold all of it is a page that renders 4 pt type.
    page_detail_lede_lines = 5,
    --: One-line batch-download band under the sub-line: a label and a progress
    --: bar. Only planned in while a batch is running.
    page_progress_units = 34,
    --: Heatmap: 52 weeks of seven days, drawn as a pixel grid rather than one
    --: text row per week (the shape that made the old screen ten pages long).
    page_heat_weeks = 52,
    page_heat_min_weeks = 26,
    page_heat_cell_units = 12,
    page_heat_cell_min_units = 7,
    page_heat_cell_max_units = 22,
    page_heat_gap_units = 2,
    --: Rows each list-like section is allowed to draw at most.
    page_reading_max = 3,
    page_session_max = 3,
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
    --: Header affordances of the one-page views: back and the overflow menu.
    --: The back mark stays in Geometric Shapes beside the existing chevron; the
    --: overflow mark is the vertical ellipsis the accepted design draws, which
    --: KOReader reaches through its CJK/FreeSans fallbacks (the reader's own
    --: reading face is not required to carry it).
    back = "◂",
    overflow = "⋮",
    --: Sort/jump selector indicator, clear filter mark, and on-device dot.
    dropdown = "▾",
    clear = "✕",
    local_dot = "●",
}

--- English wording for the relative-time, clock and duration lines.
-- The page models pass their translated labels in; a word they do not override
-- falls back to this table, so the pure formatters still run off-device.
Ui.TIME_LABELS = {
    just_now = "just now",
    one_minute_ago = "1 min ago",
    minutes_ago = "%d min ago",
    one_hour_ago = "1 h ago",
    hours_ago = "%d h ago",
    relative_yesterday = "yesterday",
    days_ago = "%d days ago",
    clock_today = "Today",
    clock_yesterday = "Yesterday",
    months = {
        "Jan", "Feb", "Mar", "Apr", "May", "Jun",
        "Jul", "Aug", "Sep", "Oct", "Nov", "Dec",
    },
    seconds_short = "%d s",
    minutes_short = "%d m",
    minutes_seconds = "%d m %d s",
    hours_short = "%d h",
    hours_minutes = "%d h %d m",
}

--- One translated time word, or the English default.
-- @param text label table from the caller, may be nil
-- @string key
-- @string fallback
-- @treturn string
local function timeLabel(text, key, fallback)
    if type(text) == "table" then
        local value = text[key]
        if type(value) == "string" and value ~= "" then return value end
    end
    return fallback
end

--- The month names the caller supplied, or the English ones.
-- @param text label table from the caller, may be nil
-- @treturn table
local function monthNames(text)
    if type(text) == "table" and type(text.months) == "table" and #text.months == 12 then
        return text.months
    end
    return Ui.TIME_LABELS.months
end

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

--- The density factor a "how many pixels is one unit" answer hides.
--
-- `Screen:scaleBySize(n)` is the runtime's only density answer, and it is
-- `ceil(n * factor)`: it works in whole pixels and rounds *up*. Asking it what
-- one unit is, and multiplying by that answer, therefore is not the factor - it
-- is the factor rounded up to the next whole pixel. On a 1236x1648 panel it
-- answers 3 for a real factor of 2.06, and every band built from it comes out
-- ~46% too big, which is how a page ends up holding two rows instead of a
-- shelf. Probe with a wide reference: at 600 units one pixel of rounding is one
-- part in 600, so the factor survives the ceiling.
-- @param probe_pixels number|string result of `scaleBySize(probe_units)`
-- @number probe_units the unit count that was probed with
-- @treturn number|nil pixels per unit, nil when the answer is not usable
function Ui.scaleFactor(probe_pixels, probe_units)
    local units = tonumber(probe_units)
    if not units or units < 1 then return nil end
    local pixels = tonumber(probe_pixels)
    if not pixels or pixels <= 0 then return nil end
    local factor = pixels / units
    if factor ~= factor or factor < 0.5 or factor > 4 then return nil end
    return factor
end

--- Converts a pixel size into the size `Font.getFace` expects.
--
-- `Font.getFace(name, size)` multiplies the size it is given by the device scale
-- before it opens the face, so its argument is a unit, not a pixel. Every
-- measure this plugin derives a face from - a page header, a row band, a footer
-- - is a pixel measure, because that is what the layout functions return. Handing
-- those pixels straight to `getFace` draws them two to three times too large,
-- and the type stops fitting the band it was sized for. Divide the scale back
-- out and the size asked for is the size drawn.
-- @number size_px wanted size in pixels
-- @number[opt] scale pixels per unit for this device (nil or 1: units are pixels)
-- @treturn number size in the units the runtime scales
function Ui.faceUnits(size_px, scale)
    local pixels = tonumber(size_px)
    if not pixels or pixels ~= pixels then return size_px end
    local factor = tonumber(scale)
    if not factor or factor <= 0 or factor ~= factor then return pixels end
    return pixels / factor
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

--- Strips basic HTML markup and decodes entities into clean plain paragraphs.
-- @param text string|nil raw HTML or plain synopsis
-- @treturn string normalized plain text
function Ui.plainText(text)
    if type(text) ~= "string" or text == "" then return "" end
    local out = text:gsub("\r\n", "\n"):gsub("\r", "\n")
    out = out:gsub("<[Bb][Rr][^>]*>", "\n")
    out = out:gsub("</[Pp]%s*>", "\n\n")
    out = out:gsub("</[Dd][Ii][Vv]%s*>", "\n")
    out = out:gsub("</[Ll][Ii]%s*>", "\n")
    out = out:gsub("</[Hh][1-6]%s*>", "\n\n")
    out = out:gsub("<[^>]+>", "")
    out = out:gsub("&[Nn][Bb][Ss][Pp];", " ")
    out = out:gsub("&[Ll][Tt];", "<")
    out = out:gsub("&[Gg][Tt];", ">")
    out = out:gsub("&[Qq][Uu][Oo][Tt];", '"')
    out = out:gsub("&#39;", "'"):gsub("&[Aa][Pp][Oo][Ss];", "'")
    out = out:gsub("&[Mm][Dd][Aa][Ss][Hh];", "—")
    out = out:gsub("&[Nn][Dd][Aa][Ss][Hh];", "–")
    out = out:gsub("&[Hh][Ee][Ll][Ll][Ii][Pp];", "…")
    out = out:gsub("&#([0-9]+);", function(digits)
        local cp = tonumber(digits)
        if not cp or cp < 32 or cp > 126 then return " " end
        return string.char(cp)
    end)
    out = out:gsub("&[Aa][Mm][Pp];", "&")
    out = out:gsub("[ \t]+", " ")
    out = out:gsub(" *\n *", "\n")
    out = out:gsub("\n\n\n+", "\n\n")
    out = out:gsub("^%s+", ""):gsub("%s+$", "")
    return out
end

--- Splits a string at a UTF-8 code-point count boundary without breaking glyphs.
-- @string text
-- @number count
-- @treturn string head
-- @treturn string rest
local function takeCodepoints(text, count)
    local limit = math.max(math.floor(count), 1)
    local seen, cut = 0, 0
    for byte_index = 1, #text do
        local byte = text:byte(byte_index)
        if byte < 0x80 or byte >= 0xC0 then
            seen = seen + 1
            if seen > limit then break end
        end
        cut = byte_index
    end
    return text:sub(1, cut), text:sub(cut + 1)
end

--- Wraps text into at most `max_lines` lines of at most `max_chars` glyphs.
-- Safe on UTF-8 multi-byte scripts (Burmese, CJK): never splits a code point.
-- @param text string|nil
-- @number max_chars
-- @number[opt] max_lines
-- @treturn table { lines = { string... }, truncated = boolean }
function Ui.wrapLines(text, max_chars, max_lines)
    if type(text) ~= "string" or text == "" then
        return { lines = {}, truncated = false }
    end
    local clean = Ui.plainText(text)
    if clean == "" then
        return { lines = {}, truncated = false }
    end
    local width = math.floor(numberIn(max_chars, 40, 4))
    local cap = max_lines ~= nil and math.floor(numberIn(max_lines, 0, 0)) or nil
    if cap == 0 then
        return { lines = {}, truncated = true }
    end

    local lines = {}
    local truncated = false
    local function pushLine(line)
        if cap and #lines >= cap then
            truncated = true
            return false
        end
        lines[#lines + 1] = line
        return true
    end

    local para_start = 1
    local para_len = #clean
    local last_was_blank = false
    while para_start <= para_len and not truncated do
        local nl = clean:find("\n", para_start, true)
        local para = nl and clean:sub(para_start, nl - 1) or clean:sub(para_start)
        para_start = nl and (nl + 1) or (para_len + 1)
        para = para:gsub("^%s+", ""):gsub("%s+$", "")

        if para == "" then
            if #lines > 0 and not last_was_blank then
                if not pushLine("") then break end
                last_was_blank = true
            end
        else
            last_was_blank = false
            local current = ""
            for word in para:gmatch("%S+") do
                local word_len = graphemeCount(word)
                if current == "" then
                    if word_len <= width then
                        current = word
                    else
                        local chunk = word
                        while graphemeCount(chunk) > width and not truncated do
                            local head, rest = takeCodepoints(chunk, width)
                            if not pushLine(head) then break end
                            chunk = rest
                        end
                        current = truncated and "" or chunk
                    end
                else
                    local cur_len = graphemeCount(current)
                    if cur_len + 1 + word_len <= width then
                        current = current .. " " .. word
                    else
                        if not pushLine(current) then
                            current = ""
                            break
                        end
                        if word_len <= width then
                            current = word
                        else
                            local chunk = word
                            while graphemeCount(chunk) > width and not truncated do
                                local head, rest = takeCodepoints(chunk, width)
                                if not pushLine(head) then break end
                                chunk = rest
                            end
                            current = truncated and "" or chunk
                        end
                    end
                end
                if truncated then break end
            end
            if not truncated and current ~= "" then
                pushLine(current)
            end
        end
    end

    while #lines > 0 and lines[#lines] == "" do
        table.remove(lines)
    end
    if truncated and #lines > 0 then
        local tail = lines[#lines]
        if tail == "" then
            lines[#lines] = Ui.GLYPH.ellipsis
        elseif graphemeCount(tail) >= width then
            lines[#lines] = Ui.ellipsize(tail, width)
        else
            lines[#lines] = tail .. Ui.GLYPH.ellipsis
        end
    end
    return { lines = lines, truncated = truncated }
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

--- Measures text with a caller-supplied measurer, or nil when it cannot.
--
-- The measurer is a `function(text) -> pixels`; `main.lua` builds one from the
-- face the device really draws with. Returning nil rather than 0 is deliberate:
-- it lets a caller fall back to the character budget instead of pretending an
-- unmeasurable string costs nothing.
-- @string text
-- @function[opt] measure
-- @treturn number|nil
function Ui.textWidth(text, measure)
    if type(text) ~= "string" or text == "" then return 0 end
    if type(measure) ~= "function" then return nil end
    local ok, width = pcall(measure, text)
    if not ok then return nil end
    width = tonumber(width)
    if not width or width ~= width or width < 0 then return nil end
    return width
end

--- Shortens text with the ellipsis until its measured width fits `budget`.
--
-- This is the pixel-level counterpart of `Ui.ellipsize`, and it exists because
-- a code-point budget cannot bound a pixel width: 64 Burmese letters and 64
-- Latin letters are not the same column. KOReader's `TextBoxWidget:makeLine`
-- raises on a width that is not strictly positive, that raise escapes
-- `MenuItem:init`, and the process dies - so the column that overflows has to
-- give up characters until the face the device draws with fits the pixels
-- available.
-- @string text
-- @function[opt] measure
-- @number budget pixels available to this string
-- @treturn string the longest prefix + ellipsis that fits, or ""
function Ui.fitToWidth(text, measure, budget)
    if type(text) ~= "string" or text == "" then return "" end
    budget = tonumber(budget)
    if not budget or budget ~= budget then return "" end
    local width = Ui.textWidth(text, measure)
    -- Unmeasurable: fall back to the pixel-free cap rather than the raw string.
    -- Returning `text` here is what handed the device a column wider than the
    -- row it had to be drawn in.
    if width == nil then return Ui.ellipsize(text, Ui.tokens.meta_unmeasured_chars) end
    if width <= budget then return text end
    local ellipsis = Ui.GLYPH.ellipsis
    local ellipsis_width = Ui.textWidth(ellipsis, measure) or 0
    if budget < ellipsis_width then return "" end
    -- Widest prefix that still fits. `ellipsize` cuts on code-point
    -- boundaries, so a Burmese or CJK letter is never split in half, and the
    -- measured width grows with the prefix - a binary search is therefore
    -- exact, not an approximation.
    local total = graphemeCount(text)
    local low, high, best = 1, total, 0
    local rounds = 0
    while low <= high and rounds < 12 do
        rounds = rounds + 1
        local middle = math.floor((low + high) / 2)
        local candidate = Ui.ellipsize(text, middle)
        local candidate_width = Ui.textWidth(candidate, measure)
        if candidate_width and candidate_width <= budget then
            best = middle
            low = middle + 1
        else
            high = middle - 1
        end
    end
    if best < 1 then return "" end
    return Ui.ellipsize(text, best)
end

--- Builds a row's metadata column to a measured pixel budget.
--
-- The glance survives: progress and rating are what a catalog row is for, so
-- the secondary text (author, series) is shortened first. Only when the glance
-- alone cannot fit is it shortened too - a partial bar is a far better outcome
-- than a row that takes KOReader down with it. A device that cannot measure
-- pixels at all gets the small fixed `meta_unmeasured_chars` column instead, so
-- an unmeasurable row is still bounded.
-- @tparam table options { secondary, glance, max_chars, budget, measure }
-- @treturn string never wider than `budget` when the runtime can measure
function Ui.fitMetaColumn(options)
    options = options or {}
    local secondary = oneLine(options.secondary)
    local glance = oneLine(options.glance)
    local measure = options.measure
    local budget = tonumber(options.budget)
    local cap = Ui.tokens.meta_unmeasured_chars
    -- The character pre-pass keeps a short row looking exactly as it did; the
    -- pixel fit below is what actually guarantees the row can be drawn. When
    -- no pixel can be measured, the small fixed cap is the only bound there
    -- is - and returning the 64-character column instead is what killed both
    -- devices.
    local text = Ui.metaColumn(secondary, glance, options.max_chars)
    if not budget or budget ~= budget or type(measure) ~= "function" then
        return Ui.metaColumn(secondary, glance, cap)
    end
    local width = Ui.textWidth(text, measure)
    if width == nil then return Ui.metaColumn(secondary, glance, cap) end
    if width <= budget then return text end

    local separator = glance ~= "" and secondary ~= "" and SEPARATOR or ""
    local glance_width = Ui.textWidth(glance, measure) or 0
    local separator_width = separator ~= "" and (Ui.textWidth(separator, measure) or 0) or 0
    local room = budget - glance_width - separator_width
    local trimmed = room > 0 and Ui.fitToWidth(secondary, measure, room) or ""
    local result = Ui.join({ trimmed, glance })
    local result_width = Ui.textWidth(result, measure)
    if result_width == nil then return Ui.metaColumn(secondary, glance, cap) end
    if result_width <= budget then return result end

    -- Even the glance overflows on its own: it gives up characters last, and a
    -- row with no metadata at all is still a row that draws.
    return Ui.fitToWidth(glance, measure, budget)
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
-- a coherent page instead of a fixed guess. Only a cover page is clamped: a
-- cover cell is genuinely tall, while a text page follows the screen.
-- @number screen_h screen height in pixels
-- @number scale pixels per unit for this device (the factor main.lua derives; 1 = one unit is one pixel)
-- @boolean with_covers whether this view draws cover thumbnails
-- @treturn table { rows, row_height, cover_width, cover_height, gutter }
function Ui.layout(screen_h, scale, with_covers)
    local tokens = Ui.tokens
    local screen_scale = numberIn(scale, 1, 0.5, 4)
    local height = numberIn(screen_h, 800, 200, 8000)

    local target_units = with_covers and tokens.row_units_covers or tokens.row_units_plain
    local target = math.max(math.floor(target_units * screen_scale), 1)

    local chrome = math.floor(tokens.chrome_units * screen_scale)
    local available = height - chrome
    -- Pixels against pixels: the page must keep room for the smallest row
    -- count the token allows, however short the screen reports itself.
    local smallest_page = tokens.rows_min * target
    if available < smallest_page then available = smallest_page end

    local rows = math.floor(available / target)
    if rows < tokens.rows_min then rows = tokens.rows_min end
    if with_covers and rows > tokens.rows_max then rows = tokens.rows_max end

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

--- Keeps a cover gutter from eating the title column.
--
-- The cover is a feature of this list, so the *slot* gives up pixels first: it
-- shrinks to the widest cover that still leaves `name_min` pixels for the
-- title, and only when even that slot would leave no room does the gutter go
-- to zero - a text row, never a row that cannot be drawn.
-- @tparam table layout result of `Ui.layout`
-- @tparam table geometry { content_width, padding, scale, name_min }
-- @treturn table the layout, clamped in place
function Ui.clampLayout(layout, geometry)
    if type(layout) ~= "table" then return layout end
    geometry = geometry or {}
    local gutter = numberIn(layout.gutter, 0, 0)
    if gutter <= 0 then return layout end
    local content = numberIn(geometry.content_width, 0, 0)
    if content <= 0 then return layout end
    local padding = numberIn(geometry.padding, 0, 0)
    local scale = numberIn(geometry.scale, 1, 0.5, 4)
    local share = numberIn(Ui.tokens.mandatory_share, 0.5, 0.1, 0.9)
    local name_min = numberIn(
        geometry.name_min,
        math.floor(Ui.tokens.name_min_units * scale),
        1
    )
    -- The narrowest text column that still leaves `name_min` for the title.
    local usable_min = math.ceil(name_min / (1 - share))
    local gutter_max = content - padding - usable_min
    if gutter <= gutter_max then return layout end
    local slot_padding = math.floor(Ui.tokens.gutter_units * scale)
    if gutter_max < slot_padding + 1 then
        -- Not even a 1px cover leaves a usable title column: this page draws
        -- text rows instead of covers.
        layout.gutter = 0
        layout.cover_width = 0
        layout.cover_height = 0
        layout.gutter_reduced = true
        return layout
    end
    layout.cover_width = gutter_max - slot_padding
    layout.cover_height = math.max(
        math.floor(layout.cover_width / Ui.tokens.cover_aspect + 0.5),
        1
    )
    layout.gutter = layout.cover_width + slot_padding
    layout.gutter_reduced = true
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

-- ----------------------------------------------------------------------------
-- Square corners
-- ----------------------------------------------------------------------------

--- Runs a widget construction with every KOReader corner radius at zero.
--
-- The Kindle screen is square and the accepted design has no rounded box on it,
-- but the radii KOReader draws with are read from `Size.radius` at construction
-- time and are shared by every widget in the reader. This helper therefore
-- zeroes them for the duration of ONE widget build and restores them before
-- returning, so the plugin's own dialogs, notices, buttons and progress bars
-- come out square while the rest of KOReader keeps its own design. A build
-- without `ui/size` (or a raised constructor) costs the styling, never the
-- screen.
-- @function build constructs and returns the widget
-- @treturn table the widget `build` returned
function Ui.square(build)
    if type(build) ~= "function" then return nil end
    local ok_size, Size = pcall(require, "ui/size")
    local saved = nil
    if ok_size and type(Size) == "table" and type(Size.radius) == "table" then
        saved = {}
        for corner, radius in pairs(Size.radius) do
            saved[corner] = radius
            Size.radius[corner] = 0
        end
    end
    local ok, widget = pcall(build)
    if saved then
        for corner, radius in pairs(saved) do
            Size.radius[corner] = radius
        end
    end
    if not ok then error(widget, 0) end
    return widget
end

-- ----------------------------------------------------------------------------
-- Number and date formatting for the one-page views
-- ----------------------------------------------------------------------------

--- Formats a whole count with thousands separators, e.g. "1,802".
-- @param count number|nil
-- @treturn string|nil nil when the value is not a number
function Ui.formatThousands(count)
    local value = numberIn(count, nil)
    if value == nil then return nil end
    local whole = math.floor(value + 0.5)
    local negative = whole < 0
    local digits = tostring(negative and -whole or whole)
    local grouped = digits:reverse():gsub("(%d%d%d)", "%1,"):reverse()
    if grouped:sub(1, 1) == "," then grouped = grouped:sub(2) end
    if negative then return "-" .. grouped end
    return grouped
end

--- "1 book" / "21 books"; nil when the count is unknown.
-- @param count number|nil
-- @treturn string|nil
function Ui.bookCountLabel(count)
    local label = Ui.formatThousands(count)
    if not label then return nil end
    if math.floor(numberIn(count, 0, 0) + 0.5) == 1 then return label .. " book" end
    return label .. " books"
end

--- Filled pixels for a proportional bar of `width` pixels.
-- A ratio outside 0..1 is clamped rather than drawn past the bar, and a ratio
-- that is not a number fills nothing: a bar is a picture of a number the server
-- sent, never a guess. Any non-zero ratio keeps at least one pixel, so "started"
-- and "not started" stay distinguishable on a narrow bar.
-- @param ratio number|nil 0..1
-- @number width bar width in pixels
-- @treturn number filled pixels, 0..width
function Ui.barFill(ratio, width)
    local total = math.floor(numberIn(width, 0, 0))
    if total < 1 then return 0 end
    local value = numberIn(ratio, nil, 0, 1)
    if value == nil or value <= 0 then return 0 end
    local filled = math.floor(value * total + 0.5)
    if filled < 1 then filled = 1 end
    if filled > total then filled = total end
    return filled
end

--- Weekday of a YYYY-MM-DD date, Monday = 1 .. Sunday = 7.
-- Sakamoto's algorithm, so the answer never depends on the device's own
-- calendar settings: the heatmap's columns have to line up on every device.
-- @string date
-- @treturn number|nil
function Ui.weekdayIndex(date)
    if type(date) ~= "string" then return nil end
    local year_text, month_text, day_text = date:match("^(%d%d%d%d)%-(%d%d)%-(%d%d)$")
    if not year_text then return nil end
    local year = tonumber(year_text)
    local month = tonumber(month_text)
    local day = tonumber(day_text)
    if not year or not month or not day then return nil end
    if month < 1 or month > 12 or day < 1 or day > 31 then return nil end
    -- Sakamoto: month offsets, then the leap-year correction applied to January
    -- and February by shifting them into the previous year.
    local offsets = { 0, 3, 2, 5, 0, 3, 5, 1, 4, 6, 2, 4 }
    local shifted = year
    if month < 3 then shifted = shifted - 1 end
    local sunday_zero = (shifted + math.floor(shifted / 4) - math.floor(shifted / 100)
        + math.floor(shifted / 400) + offsets[month] + day) % 7
    if sunday_zero == 0 then return 7 end
    return sunday_zero
end

--- Packs normalized heatmap days into calendar-week columns.
--
-- One column is one week, one cell is one day: the newest day ends the last
-- column, and a day later in that same week (a day in the future, or one the
-- server did not send) stays empty rather than borrowing a neighbour's shade.
-- Returning columns of levels instead of a text row per week is the whole
-- difference between a compact 52-week picture and ten pages of rows.
-- @tparam table days normalized heatmap days, oldest first
-- @number[opt] weeks columns to draw, defaults to the token
-- @treturn table array of columns, each an array of seven level-or-nil cells
function Ui.heatmapColumns(days, weeks)
    local columns = {}
    local wanted = math.floor(numberIn(weeks, Ui.tokens.page_heat_weeks, 1))
    for column_index = 1, wanted do columns[column_index] = {} end
    if type(days) ~= "table" or #days == 0 then return columns end

    local column = wanted
    for day_index = #days, 1, -1 do
        if column < 1 then break end
        local day = days[day_index]
        if type(day) == "table" then
            local weekday = Ui.weekdayIndex(day.date)
            if weekday then
                local level = numberIn(day.level, 0, 0, 4)
                -- The newest day wins: walking backwards, a cell already filled
                -- belongs to a later day than the one being placed.
                if columns[column][weekday] == nil then
                    columns[column][weekday] = math.floor(level + 0.5)
                end
                -- Monday starts a week: every earlier day belongs one column
                -- to the left.
                if weekday == 1 then column = column - 1 end
            end
        end
    end
    return columns
end

--- "just now" / "2 h ago" / "yesterday" / "4 days ago" / "12 Nov".
--
-- Relative wording is what the accepted design shows under a reading row, and
-- it is computed here rather than with `os.date`, so the same function can be
-- tested off-device. A timestamp in the future (a device clock running fast)
-- reads "just now" instead of a negative age.
-- @number timestamp unix seconds
-- @number now unix seconds
-- @treturn string|nil
--- @number timestamp
-- @number now
-- @tparam table[opt] text time labels (see `Ui.TIME_LABELS`)
-- @treturn string|nil
function Ui.relativeWhen(timestamp, now, text)
    local stamp = tonumber(timestamp)
    local current = tonumber(now)
    if not stamp or not current or stamp <= 0 then return nil end
    local defaults = Ui.TIME_LABELS
    local age = current - stamp
    if age < 0 then age = 0 end
    if age < 60 then return timeLabel(text, "just_now", defaults.just_now) end
    if age < 3600 then
        local minutes = math.floor(age / 60)
        if minutes < 2 then return timeLabel(text, "one_minute_ago", defaults.one_minute_ago) end
        return string.format(timeLabel(text, "minutes_ago", defaults.minutes_ago), minutes)
    end
    if age < 86400 then
        local hours = math.floor(age / 3600)
        if hours < 2 then return timeLabel(text, "one_hour_ago", defaults.one_hour_ago) end
        return string.format(timeLabel(text, "hours_ago", defaults.hours_ago), hours)
    end
    local days = math.floor(age / 86400)
    if days < 2 then return timeLabel(text, "relative_yesterday", defaults.relative_yesterday) end
    if days < 7 then
        return string.format(timeLabel(text, "days_ago", defaults.days_ago), days)
    end
    -- Older than a week: a date reads better than "23 days ago", and it is
    -- derived from the timestamp alone so no locale table is needed.
    local ok, parts = pcall(os.date, "*t", stamp)
    if not ok or type(parts) ~= "table" then return nil end
    local name = monthNames(text)[tonumber(parts.month) or 0]
    if not name then return nil end
    return string.format("%d %s", tonumber(parts.day) or 0, name)
end

--- "Today 13:19" / "Yesterday 22:04" / "14 Nov 21:12" for one session.
--
-- Takes broken-down local times (`os.date("*t")` tables) instead of raw epochs,
-- so the day boundary that matters is the reader's own day and the formatter
-- stays testable without the device clock.
-- @tparam table when broken-down local time of the session
-- @tparam table today broken-down local time of "now"
-- @tparam table[opt] text time labels (see `Ui.TIME_LABELS`)
-- @treturn string|nil
function Ui.clockLine(when, today, text)
    if type(when) ~= "table" or type(today) ~= "table" then return nil end
    local defaults = Ui.TIME_LABELS
    local hour = tonumber(when.hour)
    local minute = tonumber(when.min)
    if not hour or not minute then return nil end
    local clock = string.format("%02d:%02d", hour, minute)
    local function dayNumber(parts)
        local year = tonumber(parts.year)
        local month = tonumber(parts.month)
        local day = tonumber(parts.day)
        if not year or not month or not day then return nil end
        -- A proleptic day number: consecutive calendar days differ by one, so
        -- "today" and "yesterday" need no month-length table.
        local shifted_year = month <= 2 and (year - 1) or year
        local shifted_month = month <= 2 and (month + 12) or month
        return 365 * shifted_year + math.floor(shifted_year / 4)
            - math.floor(shifted_year / 100) + math.floor(shifted_year / 400)
            + math.floor((153 * (shifted_month - 3) + 2) / 5) + day
    end
    local when_day = dayNumber(when)
    local today_day = dayNumber(today)
    if when_day and today_day then
        local difference = today_day - when_day
        if difference == 0 then
            return timeLabel(text, "clock_today", defaults.clock_today) .. " " .. clock
        end
        if difference == 1 then
            return timeLabel(text, "clock_yesterday", defaults.clock_yesterday) .. " " .. clock
        end
    end
    local name = monthNames(text)[tonumber(when.month) or 0]
    if not name then return clock end
    return string.format("%d %s %s", tonumber(when.day) or 0, name, clock)
end

--- "5 m 37 s" / "38 m" / "1 h 12 m": the long duration of one session.
-- The short form on the row's right edge comes from `Stats.formatDuration`;
-- this is the spelled-out half the session line carries.
-- @number seconds
-- @tparam table[opt] text time labels (see `Ui.TIME_LABELS`)
-- @treturn string|nil
function Ui.durationLong(seconds, text)
    local defaults = Ui.TIME_LABELS
    local total = numberIn(seconds, nil, 0)
    if total == nil then return nil end
    local rounded = math.floor(total + 0.5)
    if rounded < 60 then
        return string.format(timeLabel(text, "seconds_short", defaults.seconds_short), rounded)
    end
    local minutes = math.floor(rounded / 60)
    local rest = rounded - minutes * 60
    if minutes < 60 then
        if rest == 0 then
            return string.format(timeLabel(text, "minutes_short", defaults.minutes_short), minutes)
        end
        return string.format(timeLabel(text, "minutes_seconds", defaults.minutes_seconds),
            minutes, rest)
    end
    local hours = math.floor(minutes / 60)
    local leftover = minutes - hours * 60
    if leftover == 0 then
        return string.format(timeLabel(text, "hours_short", defaults.hours_short), hours)
    end
    return string.format(timeLabel(text, "hours_minutes", defaults.hours_minutes), hours, leftover)
end

--- The three segments of the library's grouping switch.
-- Order and labels are the accepted design's; `mode` selects the active one and
-- an unknown mode falls back to the first, so the switch can never render with
-- no segment selected.
-- @string[opt] mode "books" | "authors" | "series"
-- @treturn table array of { key, label, active }
function Ui.switchSegments(mode)
    local labels = {
        { key = "books", label = "BOOKS" },
        { key = "authors", label = "AUTHORS" },
        { key = "series", label = "SERIES" },
    }
    local active = "books"
    for index = 1, #labels do
        if labels[index].key == mode then active = mode end
    end
    for index = 1, #labels do
        labels[index].active = labels[index].key == active
    end
    return labels
end

-- ----------------------------------------------------------------------------
-- Single-screen page geometry
-- ----------------------------------------------------------------------------

--- Lays out the one-page views inside the height the device actually has.
--
-- One page, no scrolling and no paging: the plan is computed top-down from the
-- height the screen reports, so the same rule serves a 600x800 Basic and a
-- 1072x1448 Paperwhite. Every band shrinks together until the whole page fits;
-- only when even the smallest sizes cannot hold three reading rows and three
-- session rows does a list drop a row. Nothing is ever laid out past the screen
-- edge, because the sum of the parts is what is returned.
-- @number screen_w screen width in pixels
-- @number screen_h screen height in pixels
-- @number scale pixels per unit for this device (the factor main.lua derives; 1 = one unit is one pixel)
-- @treturn table plan { scale, height, pad, content_w, header, hero,
--                       band_head, band_row, section_head, footer, hairline,
--                       bar, reading_rows, reading_h, reading_cover_w,
--                       reading_cover_h, session_rows, session_h, heat_weeks,
--                       heat_gap, heat_cell_w, heat_cell_h, total, slack }
function Ui.pagePlan(screen_w, screen_h, scale)
    local tokens = Ui.tokens
    local s = numberIn(scale, 1, 0.5, 4)
    local height = numberIn(screen_h, 800, 200, 8000)
    local width = numberIn(screen_w, 600, 200, 8000)

    local function scaled(units)
        local value = math.floor(units * s + 0.5)
        if value < 1 then value = 1 end
        return value
    end

    local pad = scaled(tokens.page_pad_units)
    local gap = scaled(tokens.page_gap_units)
    local section_gap = math.max(math.floor(gap / 2), 2)
    local hairline = math.max(math.floor(tokens.hairline_units * s + 0.5), 1)
    local header = scaled(tokens.page_header_units)
    local hero = scaled(tokens.page_hero_units)
    local band_head = scaled(tokens.page_band_head_units)
    local band_row = scaled(tokens.page_band_row_units)
    local section_head = scaled(tokens.page_section_head_units)
    local heat_legend = scaled(tokens.page_heat_legend_units)
    local footer = scaled(tokens.page_footer_units)
    local bar = math.max(scaled(tokens.page_bar_units), 2)
    local reading_min = math.max(math.floor(tokens.page_reading_min_units * s + 0.5), 24)
    local reading_max_h = math.max(math.floor(tokens.page_reading_units * s * 1.15 + 0.5), reading_min)
    local session_min = math.max(math.floor(tokens.page_session_min_units * s + 0.5), 18)
    local session_max_h = math.max(math.floor(tokens.page_session_units * s * 1.15 + 0.5), session_min)
    local cell_min = math.max(math.floor(tokens.page_heat_cell_min_units * s + 0.5), 3)
    local cell_max = math.max(math.floor(tokens.page_heat_cell_max_units * s + 0.5), cell_min)
    local gap_x = math.max(scaled(tokens.page_heat_gap_units), 1)

    -- The full-screen page uses borderless padding (no outer frame box), so
    -- content width is simply screen width minus horizontal padding.
    local content_w = width - 2 * pad
    if content_w < 1 then content_w = 1 end

    -- The heatmap's week count and cell width follow the content width:
    -- 52 columns while a cell and a gap still fit, fewer only when narrow.
    -- Computed upfront so cell height never stretches taller than cell width.
    local weeks = math.floor(tokens.page_heat_weeks)
    local min_weeks = math.floor(tokens.page_heat_min_weeks)
    if weeks < 1 then weeks = 1 end
    if min_weeks < 1 then min_weeks = 1 end
    while weeks > min_weeks and math.floor((content_w - (weeks - 1) * gap_x) / weeks) < cell_min do
        weeks = weeks - 7
    end
    local cell_w = math.floor((content_w - (weeks - 1) * gap_x) / weeks)
    if cell_w < cell_min then cell_w = cell_min end
    local square_cell_max = math.min(cell_max, cell_w)

    -- The band always budgets four rows: its row count follows the data, and a
    -- payload missing one of them must not move the whole page up and down
    -- between refreshes.
    local band_rows = 4
    local band_h = band_head + band_rows * band_row

    -- Padding + header + hero + band + three section headings + section gaps +
    -- heatmap legend + footer, with interior hairlines.
    local fixed = pad + header + hairline + hero + hairline + band_h + hairline
        + 3 * section_head + 3 * section_gap + heat_legend
        + footer + hairline + pad + gap * 2
    local available = height - fixed
    if available < 0 then available = 0 end

    local reading_rows = math.floor(tokens.page_reading_max)
    local session_rows = math.floor(tokens.page_session_max)
    if reading_rows < 1 then reading_rows = 1 end
    if session_rows < 1 then session_rows = 1 end
    local reading_h = math.max(math.floor(tokens.page_reading_units * s + 0.5), reading_min)
    local session_h = math.max(math.floor(tokens.page_session_units * s + 0.5), session_min)
    local cell_h = math.min(
        math.max(math.floor(tokens.page_heat_cell_units * s + 0.5), cell_min),
        square_cell_max
    )

    -- Shrink the three list bands together, 5% at a time, and drop a row only
    -- after the smallest scale still does not fit. The reading rows go first:
    -- the picture and the session list carry more of the answer than a fourth
    -- book does.
    --
    -- A drawn row is taller than its own band: the renderer puts a focus line
    -- under every row, and the heatmap draws a gap between its seven day rows,
    -- so both are budgeted here. A plan that counted only the bands would report
    -- a page that fits while the footer is off the bottom of the screen.
    local function bandHeight(count, cell) return count * (cell + hairline) end
    local function heatHeight(cell) return 7 * cell + 6 * gap_x end
    local function fits(reading_count, session_count, reading_px, session_px, cell_px)
        local needed = bandHeight(reading_count, reading_px)
            + heatHeight(cell_px)
            + bandHeight(session_count, session_px)
        return needed <= available
    end

    local chosen = false
    while not chosen do
        for percent = 100, 50, -5 do
            local factor = percent / 100
            local step_reading = math.max(math.floor(tokens.page_reading_units * s * factor + 0.5), reading_min)
            local step_session = math.max(math.floor(tokens.page_session_units * s * factor + 0.5), session_min)
            local step_cell = math.min(
                math.max(math.floor(tokens.page_heat_cell_units * s * factor + 0.5), cell_min),
                square_cell_max
            )
            if fits(reading_rows, session_rows, step_reading, step_session, step_cell) then
                reading_h, session_h, cell_h = step_reading, step_session, step_cell
                chosen = true
                break
            end
        end
        if chosen then break end
        -- Nothing fit: give up a reading row, then a session row, then both.
        if reading_rows > 1 then
            reading_rows = reading_rows - 1
        elseif session_rows > 1 then
            session_rows = session_rows - 1
        else
            -- A screen with room for neither list: the heatmap is the only
            -- flexible band left, so it takes what is there.
            cell_h = math.min(cell_min, square_cell_max)
            reading_rows = 0
            session_rows = 0
            chosen = true
        end
    end

    if cell_h > square_cell_max then cell_h = square_cell_max end

    -- Grow heatmap cells only up to square (cell_h <= cell_w), then put
    -- remaining vertical room into currently-reading and recent-session rows.
    local used = fixed
        + bandHeight(reading_rows, reading_h)
        + heatHeight(cell_h)
        + bandHeight(session_rows, session_h)
    while cell_h < square_cell_max and (height - used) >= 7 do
        cell_h = cell_h + 1
        used = used + 7
    end
    local grew = true
    while grew and (height - used) > 0 do
        grew = false
        if reading_rows > 0 and reading_h < reading_max_h and (height - used) >= reading_rows then
            reading_h = reading_h + 1
            used = used + reading_rows
            grew = true
        end
        if session_rows > 0 and session_h < session_max_h and (height - used) >= session_rows then
            session_h = session_h + 1
            used = used + session_rows
            grew = true
        end
    end

    local total = fixed
        + bandHeight(reading_rows, reading_h)
        + heatHeight(cell_h)
        + bandHeight(session_rows, session_h)
    local slack = height - total
    if slack < 0 then slack = 0 end

    -- A reading row carries a cover on its left: the box is derived from the row
    -- height so it can never be taller than the row it sits in.
    local cover_h = reading_h - gap
    if cover_h < 1 then cover_h = 1 end
    local cover_w = math.max(math.floor(cover_h * tokens.cover_aspect + 0.5), 1)
    local max_cover_w = math.floor(content_w / 4)
    if cover_w > max_cover_w then
        cover_w = max_cover_w
        cover_h = math.max(math.floor(cover_w / tokens.cover_aspect + 0.5), 1)
    end

    return {
        scale = s,
        width = width,
        height = height,
        pad = pad,
        gap = gap,
        section_gap = section_gap,
        content_w = content_w,
        header = header,
        hero = hero,
        hero_label = scaled(tokens.page_hero_label_units),
        hero_value = scaled(tokens.page_hero_value_units),
        band_head = band_head,
        band_row = band_row,
        section_head = section_head,
        heat_legend = heat_legend,
        footer = footer,
        hairline = hairline,
        bar = bar,
        reading_rows = reading_rows,
        reading_h = reading_h,
        reading_cover_w = cover_w,
        reading_cover_h = cover_h,
        session_rows = session_rows,
        session_h = session_h,
        heat_weeks = weeks,
        heat_gap = gap_x,
        heat_cell_w = cell_w,
        heat_cell_h = cell_h,
        total = total,
        slack = slack,
        -- Honest report of the edge case: a screen shorter than the header,
        -- the bands and the footer cannot hold even the chrome, and the plan
        -- says so instead of pretending a page fits. Every real e-ink screen
        -- (600x800 and up) fits with three reading rows and three sessions.
        fits = total <= height,
    }
end


--- Lays out a paged list view (the library's three groupings) inside the screen.
--
-- Same idea as `Ui.pagePlan`, for a page whose body is uniform rows: the header,
-- the grouping switch, the sub-line and the footer are fixed, and what is left
-- is divided into rows of one height. The row height shrinks before the row
-- count does, so a short screen still shows a usable list instead of two giant
-- rows.
-- @number screen_w screen width in pixels
-- @number screen_h screen height in pixels
-- @number scale pixels per unit for this device (the factor main.lua derives; 1 = one unit is one pixel)
-- @tparam table[opt] options { with_switch = boolean, with_covers = boolean, min_rows = number, with_progress = boolean }
-- @treturn table plan { scale, height, pad, content_w, header, hairline,
--                       switch_h, subline_h, progress_h, footer, row_h, rows,
--                       row_title_px, bar, cover_w, cover_h, with_covers,
--                       total, slack }
function Ui.listPlan(screen_w, screen_h, scale, options)
    options = options or {}
    local tokens = Ui.tokens
    local s = numberIn(scale, 1, 0.5, 4)
    local height = numberIn(screen_h, 800, 200, 8000)
    local width = numberIn(screen_w, 600, 200, 8000)

    local function scaled(units)
        local value = math.floor(units * s + 0.5)
        if value < 1 then value = 1 end
        return value
    end

    local with_covers = options.with_covers ~= false
    local pad = scaled(tokens.page_pad_units)
    local gap = scaled(tokens.page_gap_units)
    local hairline = math.max(math.floor(tokens.hairline_units * s + 0.5), 1)
    local header = scaled(tokens.page_header_units)
    local footer = scaled(tokens.page_footer_units)
    local bar = math.max(scaled(tokens.page_bar_units), 2)
    local switch_h = options.with_switch and scaled(tokens.page_switch_units) or 0
    local subline_h = scaled(tokens.page_subline_units)
    --: A running batch adds one band under the sub-line. It is planned in only
    --: while it is running, so a reader who is not downloading anything pays
    --: nothing for it - and the list shrinks by a row for the duration instead
    --: of the bar being drawn over a row.
    local progress_h = options.with_progress and (scaled(tokens.page_progress_units) + hairline) or 0
    --: Height held back for something the caller draws above the rows - the
    --: overflow screen's section headings, one band each. Given in the same
    --: unscaled units as the tokens, so it follows the screen like they do.
    local extra_h = options.extra_units and scaled(options.extra_units) or 0
    local target_units = with_covers and tokens.page_list_row_units or tokens.page_list_compact_units
    local row_min_units = with_covers and tokens.page_reading_min_units or tokens.page_list_compact_min_units
    local row_min = math.max(math.floor(row_min_units * s + 0.5), 24)
    local max_mult = with_covers and 1.15 or 1.2
    local row_max = math.max(math.floor(target_units * s * max_mult + 0.5), row_min)
    local min_rows = math.max(math.floor(tonumber(options.min_rows) or 3), 1)

    local content_w = width - 2 * pad
    if content_w < 1 then content_w = 1 end

    -- Header, the switch's own two rules, the sub-line, the footer rule and
    -- page padding are all fixed; only the row band flexes.
    local fixed = pad + header + hairline + subline_h + progress_h + extra_h + footer + hairline + pad + gap
    if switch_h > 0 then fixed = fixed + switch_h + 2 * hairline end
    local available = height - fixed
    if available < 1 then available = 1 end

    local row_h = scaled(target_units)
    -- Every drawn row also carries its own focus line, so the band a row needs
    -- is the row plus one hairline.
    local step_h = row_h + hairline
    local rows = math.floor(available / step_h)
    if rows < min_rows then
        -- Too few rows: shrink the rows instead of the list, down to the token's
        -- floor, and take the count that fits at that size.
        row_h = math.max(math.floor(available / min_rows) - hairline, row_min)
        step_h = row_h + hairline
        rows = math.floor(available / step_h)
        if rows < 1 then rows = 1 end
    elseif row_h < row_max and rows * step_h < available then
        -- A screen with room to spare gets slightly taller rows rather than a
        -- gap under the last row.
        local taller = math.floor(available / rows) - hairline
        if taller > row_h and taller <= row_max then
            row_h = taller
            step_h = row_h + hairline
        end
    end

    local cover_w, cover_h = 0, 0
    if with_covers then
        cover_h = row_h - gap
        if cover_h < 1 then cover_h = 1 end
        cover_w = math.max(math.floor(cover_h * tokens.cover_aspect + 0.5), 1)
        local max_cover_w = math.floor(content_w / 4)
        if cover_w > max_cover_w then
            cover_w = max_cover_w
            cover_h = math.max(math.floor(cover_w / tokens.cover_aspect + 0.5), 1)
        end
    end

    local row_title_px = Ui.rowTitlePx(row_h, s)

    local total = fixed + rows * step_h
    local slack = height - total
    if slack < 0 then slack = 0 end

    return {
        scale = s,
        width = width,
        height = height,
        pad = pad,
        gap = gap,
        content_w = content_w,
        header = header,
        hairline = hairline,
        switch_h = switch_h,
        subline_h = subline_h,
        progress_h = progress_h,
        extra_h = extra_h,
        section_head = scaled(tokens.page_section_head_units),
        footer = footer,
        bar = bar,
        row_h = row_h,
        rows = rows,
        row_title_px = row_title_px,
        with_covers = with_covers,
        reading_cover_w = cover_w,
        reading_cover_h = cover_h,
        total = total,
        slack = slack,
    }
end

--- The pixel size of the row-title face for a band this tall on this device.
--
-- One definition, used by every plan that carries a row band, so the list, the
-- Detail hero and the quote cards cannot drift apart again. There is no upper
-- ceiling: the old fixed 120 px cap made a 178 px band on a 300 dpi panel draw
-- the same 22 px glyphs a 167 dpi one did, which is why the device with 80 %
-- more pixels rendered type 22 % SMALLER. What is bounded is the floor, because
-- a row the reader cannot resolve is not a row.
-- @number band_px the drawn band the type sits in
-- @number scale pixels per unit for this device
-- @treturn number pixel size of the row-title face
function Ui.rowTitlePx(band_px, scale)
    local tokens = Ui.tokens
    local s = numberIn(scale, 1, 0.5, 4)
    local band = tonumber(band_px) or 0
    local floor_px = math.floor(tokens.page_row_title_min_units * s + 0.5)
    local value = math.floor(band * tokens.page_row_title_ratio)
    if value < floor_px then value = floor_px end
    return value
end

--- The paragraph type sizes for a device, derived from the face and not the box.
--
-- `body_px` is the target face; `line_h` is the box that face sits in, and the
-- fill fraction is therefore a property of this function rather than of
-- whatever band happened to be left over. The old order - box first, then
-- `max(floor(line_h * 0.58), 10)` - is what made a PW5SE draw 16 px type in a
-- 41 px box: 39 % fill, a lede the reader could not read.
-- @number scale pixels per unit for this device
-- @treturn number body_px, number line_h
function Ui.bodyType(scale)
    local tokens = Ui.tokens
    local s = numberIn(scale, 1, 0.5, 4)
    local function scaled(units)
        local value = math.floor(units * s + 0.5)
        if value < 1 then value = 1 end
        return value
    end
    local body_px = math.max(scaled(tokens.page_body_px_units), 10)
    local lead = tonumber(tokens.page_body_lead_ratio) or 1.2
    local line_h = math.max(math.ceil(body_px * lead), scaled(tokens.page_body_line_units))
    return body_px, line_h
end

--- Lays out the single-screen Book Detail Card.
-- Holds the header, hero (cover + title + author/series + rating/progress),
-- action button bar (1 or 2 rows), synopsis body lines, and footer inside `height`.
-- @number screen_w screen width in pixels
-- @number screen_h screen height in pixels
-- @number scale pixels per unit for this device
-- @tparam table[opt] options { with_covers = boolean, action_rows = number }
-- @treturn table detail layout plan
function Ui.detailPlan(screen_w, screen_h, scale, options)
    options = options or {}
    local tokens = Ui.tokens
    local s = numberIn(scale, 1, 0.5, 4)
    local height = numberIn(screen_h, 800, 200, 8000)
    local width = numberIn(screen_w, 600, 200, 8000)

    local function scaled(units)
        local value = math.floor(units * s + 0.5)
        if value < 1 then value = 1 end
        return value
    end

    local with_covers = options.with_covers ~= false
    local pad = scaled(tokens.page_pad_units)
    local gap = scaled(tokens.page_gap_units)
    local section_gap = math.max(math.floor(gap / 2), 2)
    local hairline = math.max(math.floor(tokens.hairline_units * s + 0.5), 1)
    local header = scaled(tokens.page_header_units)
    local footer = scaled(tokens.page_footer_units)
    local bar = math.max(scaled(tokens.page_bar_units), 2)
    local section_head = scaled(tokens.page_section_head_units)
    local action_h = scaled(tokens.page_action_h_units)
    local action_rows = math.max(math.min(math.floor(tonumber(options.action_rows) or 1), 2), 1)
    -- Type first, box second: the synopsis face is a legibility target and the
    -- line box is derived from it, so the fill fraction is a property of the
    -- design instead of whatever band was left over.
    local body_px, line_h = Ui.bodyType(s)
    -- The row-title face for this screen. Detail's own title is drawn with the
    -- row-title face, and a detail card whose title renders smaller than the list
    -- row the reader tapped is a step down in legibility at the exact moment the
    -- reader wants the title most. So the band is a type target - 1.75 lead of the
    -- synopsis face, floored at the list's own band including its 1.15x grow
    -- ceiling - and the type comes from that band, never from a leftover.
    local row_h = math.ceil(body_px * 1.75)
    local list_band = math.ceil(scaled(tokens.page_list_row_units) * 1.15)
    if row_h < list_band then row_h = list_band end

    local content_w = width - 2 * pad
    if content_w < 1 then content_w = 1 end

    local fixed = pad + header + hairline + footer + hairline + pad + gap
    local available = math.max(height - fixed, 1)

    local action_gap = math.max(math.floor(gap / 2), 2)
    local action_block_h = action_rows * action_h + (action_rows - 1) * action_gap + section_gap

    local cover_w, cover_h = 0, 0
    if with_covers then
        cover_w = math.max(math.floor(content_w * tokens.page_detail_cover_ratio), 1)
        cover_h = math.max(math.floor(cover_w / tokens.cover_aspect + 0.5), 1)
        local max_cover_h = math.max(math.floor(available * 0.42), line_h * 4)
        if cover_h > max_cover_h then
            cover_h = max_cover_h
            cover_w = math.max(math.floor(cover_h * tokens.cover_aspect + 0.5), 1)
        end
    end

    local min_hero_h = 6 * line_h + gap
    local hero_h = math.max(cover_h + gap, min_hero_h)
    local max_hero_h = math.max(available - action_block_h - section_head - 2 * line_h, math.floor(available * 0.45))
    if hero_h > max_hero_h then
        hero_h = math.max(max_hero_h, math.min(min_hero_h, available))
        if with_covers and cover_h > hero_h - gap then
            cover_h = math.max(hero_h - gap, 1)
            cover_w = math.max(math.floor(cover_h * tokens.cover_aspect + 0.5), 1)
        end
    end

    local body_overhead = section_gap + section_head + 2 * line_h
    local body_budget = available - hero_h - action_block_h - body_overhead
    local body_lines = body_budget > 0 and math.floor(body_budget / line_h) or 0
    -- A lede, not the whole synopsis: five legible lines and one tap to
    -- KOReader's own scroller beats fourteen lines at 4 pt. When there is room
    -- for more than the lede the page still gives it to the lede, because the
    -- rest of the text is what the button is for.
    local lede_lines = math.max(math.floor(tonumber(tokens.page_detail_lede_lines) or 5), 2)
    if body_lines > lede_lines then body_lines = lede_lines end

    local body_chars = math.max(math.floor(content_w / math.max(body_px * 0.55, 6)), 20)
    local row_title_px = Ui.rowTitlePx(row_h, s)

    local total = fixed + hero_h + action_block_h + section_gap + section_head + body_lines * line_h
    local slack = math.max(height - total, 0)

    return {
        scale = s,
        width = width,
        height = height,
        pad = pad,
        gap = gap,
        section_gap = section_gap,
        content_w = content_w,
        header = header,
        footer = footer,
        hairline = hairline,
        bar = bar,
        section_head = section_head,
        action_h = action_h,
        action_rows = action_rows,
        line_h = line_h,
        body_px = body_px,
        row_h = row_h,
        row_title_px = row_title_px,
        cover_w = cover_w,
        cover_h = cover_h,
        hero_h = hero_h,
        body_lines = body_lines,
        body_chars = body_chars,
        with_covers = with_covers,
        total = total,
        slack = slack,
        fits = total <= height,
    }
end

--- Lays out a multi-line quote card list (for a book's Highlights reader).
-- @number screen_w screen width in pixels
-- @number screen_h screen height in pixels
-- @number scale pixels per unit for this device
-- @tparam table[opt] options { min_rows = number }
-- @treturn table quote list layout plan
function Ui.quoteListPlan(screen_w, screen_h, scale, options)
    options = options or {}
    local tokens = Ui.tokens
    local s = numberIn(scale, 1, 0.5, 4)
    local height = numberIn(screen_h, 800, 200, 8000)
    local width = numberIn(screen_w, 600, 200, 8000)

    local function scaled(units)
        local value = math.floor(units * s + 0.5)
        if value < 1 then value = 1 end
        return value
    end

    local pad = scaled(tokens.page_pad_units)
    local gap = scaled(tokens.page_gap_units)
    local hairline = math.max(math.floor(tokens.hairline_units * s + 0.5), 1)
    local header = scaled(tokens.page_header_units)
    local subline_h = scaled(tokens.page_subline_units)
    local footer = scaled(tokens.page_footer_units)
    local line_h = scaled(tokens.page_body_line_units)

    local content_w = width - 2 * pad
    if content_w < 1 then content_w = 1 end

    local fixed = pad + header + hairline + subline_h + footer + hairline + pad + gap
    local available = math.max(height - fixed, 1)

    local row_min = math.max(scaled(tokens.page_quote_min_units), 48)
    local row_h = scaled(tokens.page_quote_row_units)
    local min_rows = math.max(math.floor(tonumber(options.min_rows) or 2), 1)
    local step_h = row_h + hairline
    local rows = math.floor(available / step_h)
    if rows < min_rows then
        row_h = math.max(math.floor(available / min_rows) - hairline, row_min)
        step_h = row_h + hairline
        rows = math.max(math.floor(available / step_h), 1)
    elseif rows * step_h < available then
        local row_max = math.floor(row_h * 1.25)
        local taller = math.floor(available / rows) - hairline
        if taller > row_h and taller <= row_max then
            row_h = taller
            step_h = row_h + hairline
        end
    end

    local quote_lines = row_h >= (4 * line_h + gap) and 3 or 2
    local quote_px = math.max(math.floor(math.min(row_h, 120) * 0.22), 11)
    local quote_chars = math.max(math.floor(content_w / math.max(quote_px * 0.56, 6)), 22)

    local total = fixed + rows * step_h
    local slack = math.max(height - total, 0)

    return {
        scale = s,
        width = width,
        height = height,
        pad = pad,
        gap = gap,
        content_w = content_w,
        header = header,
        hairline = hairline,
        subline_h = subline_h,
        section_head = scaled(tokens.page_section_head_units),
        footer = footer,
        line_h = line_h,
        row_h = row_h,
        rows = rows,
        quote_lines = quote_lines,
        quote_chars = quote_chars,
        total = total,
        slack = slack,
        fits = total <= height,
    }
end

return Ui
