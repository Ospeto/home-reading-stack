--[[--
Page models for the plugin's two full-screen views.

A page model is a plain Lua table describing what a screen shows - its title,
its bands, its rows and its footer - with no widget, no socket and no KOReader
require anywhere in it. `lighthouse_page.lua` turns one model into widgets, and
the repository's off-device suite asserts the models directly, so what a screen
*contains* is proved without a device.

Two models exist, and they are the two things the captain asked for:

  * `Views.statsModel` - the whole reading-statistics screen on ONE page:
    a four-cell headline strip, the library and year bands side by side, up to
    three currently-reading rows, one compact 52-week heatmap and up to three
    recent sessions. Every number comes from `GET /api/kosync/stats`; nothing is
    recomputed here and nothing is invented. A value the payload did not carry
    removes its row or cell instead of printing a placeholder.
  * `Views.libraryModel` - the library with its Books / Authors / Series switch,
    which is the grouping the captain chose (inside Browse, not a menu entry).

Row shape (both models):

    { kind = "reading"|"action"|"plain",
      title = "Spice and Wolf",
      secondary = "Isuna Hasekura · 21 books · 9 read",
      value = "43%",          -- right-hand column, bold
      value_sub = "9 / 21",   -- optional second line: the read fraction
      ratio = 0.43,           -- draws a pixel progress bar when non-nil
      action = { kind = "book", entry = entry },
      bold = true }

`action` is data, not a closure: the renderer decides what tapping a row does,
which keeps every model comparable in a test.
]]

local Stats = require("lighthouse_stats")
local Status = require("lighthouse_status")
local Ui = require("lighthouse_ui")

local Views = {}

--- Chrome labels, overridable by the caller so `main.lua` can translate them.
-- The model layer itself has no gettext: KOReader's `_` only exists inside the
-- reader, and a pure module that cannot be loaded off-device cannot be tested.
Views.LABELS = {
    books = "BOOKS",
    authors = "AUTHORS",
    series = "SERIES",
    library = "Library",
    reading_stats = "Reading stats",
    total = "TOTAL",
    streak = "STREAK",
    today = "TODAY",
    this_week = "THIS WEEK",
    library_band = "LIBRARY",
    year_band = "YEAR",
    unread = "Unread",
    reading = "Reading",
    finished = "Finished",
    stale = "Stale 30d+",
    books_done = "Books done",
    hours = "Hours",
    sessions = "Sessions",
    longest_streak = "Longest streak",
    currently_reading = "CURRENTLY READING",
    activity = "ACTIVITY",
    recent_sessions = "RECENT SESSIONS",
    last_52_weeks = "LAST 52 WEEKS",
    books_upper = "BOOKS",
    search = "Search library…",
    next_page = "Next page",
    page = "Page %d of %d",
    all_books = "All books",
    grouped_by_series = "Grouped by series",
    grouped_by_author = "Grouped by author",
    not_started = "not started",
    done = "done",
    unread_value = "Unread",
    books_count = "%s books",
    read_count = "%s read",
    read_of_books = "%s / %s",
    average_day = "%d min on an average day",
    detail_on_web = "detail on web",
    last_n = "LAST %d",
    untitled = "Untitled",
    az = "A–Z",
    no_series = "No series in this library yet",
    no_authors = "No authors in this library yet",
    author_count = "%s authors",
    series_count = "%s series",
}

--- Merges caller-supplied labels over the built-in English ones.
-- A list value (the month names) is passed through as the caller gave it.
-- @tparam table[opt] labels
-- @treturn table
function Views.labels(labels)
    -- The relative-time, clock and duration wording lives in exactly one place
    -- (`Ui.TIME_LABELS`) because `Ui` is what formats those lines; copying it
    -- here as well is what the review flagged as three definitions of the same
    -- words. A caller's translation still wins over both.
    local merged = {}
    for key, value in pairs(Ui.TIME_LABELS) do merged[key] = value end
    for key, value in pairs(Views.LABELS) do merged[key] = value end
    if type(labels) == "table" then
        for key, value in pairs(labels) do
            if type(value) == "string" and value ~= "" then
                merged[key] = value
            elseif type(value) == "table" then
                merged[key] = value
            end
        end
    end
    return merged
end

-- ----------------------------------------------------------------------------
-- Small shared formatters
-- ----------------------------------------------------------------------------

--- "4d" / "18 d": a streak length sized for a headline cell.
-- @param days number|nil
-- @treturn string|nil
local function streakCell(days)
    local value = Status.num(days)
    if not value then return nil end
    return string.format("%dd", math.floor(value + 0.5))
end

--- The right-hand value column for a book's progress.
-- Shape carries the state on e-ink: a percentage while reading, a check when
-- finished, the word itself when the book has never been opened. The ratio comes
-- back alongside so the row can draw a bar without re-deriving it.
-- @tparam table session normalized KOSync session, or nil
-- @treturn string value
-- @treturn number|nil ratio
function Views.progressValue(session, labels)
    local text = labels or Views.LABELS
    if type(session) ~= "table" then return text.unread_value, nil end
    local percentage = Status.num(session.percentage) or 0
    if percentage >= 0.99 then return Ui.GLYPH.done, 1 end
    if percentage <= 0 then return "0%", 0 end
    return string.format("%d%%", math.floor(percentage * 100 + 0.5)), percentage
end

--- Secondary line for a catalog book row: author, then series.
-- @tparam table entry OPDS entry
-- @treturn string
function Views.bookSecondary(entry)
    if type(entry) ~= "table" then return "" end
    local series_index = Status.num(entry.series_index)
    return Ui.secondaryLine{
        authors = Status.str(entry.authors),
        series = Status.str(entry.series),
        series_index = series_index
            and string.format("%02d", math.floor(series_index + 0.5))
            or nil,
    }
end

-- ----------------------------------------------------------------------------
-- Reading stats - one page
-- ----------------------------------------------------------------------------

--- The four headline cells: total time, streak, today, this week.
-- A cell whose number the payload did not carry is dropped rather than shown as
-- a placeholder, so an older server produces a three-cell strip instead of a
-- row of dashes.
-- @tparam table stats normalized stats from `lighthouse_stats`
-- @tparam table text labels
-- @treturn table array of { label, value }
function Views.heroCells(stats, text)
    local labels = text or Views.LABELS
    local time = type(stats) == "table" and stats.time or nil
    local streaks = type(stats) == "table" and stats.streaks or nil
    local cells = {}

    local total = time and Stats.formatHours(time.totalHours)
    if total then cells[#cells + 1] = { label = labels.total, value = total } end

    local streak = streaks and streakCell(streaks.current)
    if streak then cells[#cells + 1] = { label = labels.streak, value = streak } end

    local today = time and Stats.formatDuration(time.todaySeconds)
    if today then cells[#cells + 1] = { label = labels.today, value = today } end

    local week = time and Stats.formatDuration(time.thisWeekSeconds)
    if week then cells[#cells + 1] = { label = labels.this_week, value = week } end

    return cells
end

--- The LIBRARY column of the two-column band.
-- @tparam table stats normalized stats
-- @tparam table text labels
-- @treturn table|nil { heading, rows = { { label, value } } }
function Views.libraryBand(stats, text)
    local labels = text or Views.LABELS
    local health = type(stats) == "table" and stats.health or nil
    if type(health) ~= "table" then return nil end

    local rows = {}
    local function addRow(label, value)
        if value == nil then return end
        rows[#rows + 1] = { label = label, value = value }
    end
    addRow(labels.unread, Ui.formatThousands(health.unread))
    addRow(labels.reading, Ui.formatThousands(health.reading))
    addRow(labels.finished, Ui.formatThousands(health.finished))
    addRow(labels.stale, Ui.formatThousands(health.stale))
    if #rows == 0 then return nil end

    local heading = labels.library_band
    local total = Ui.formatThousands(health.total)
    if total then heading = heading .. Ui.GLYPH.separator .. total end
    return { heading = heading, rows = rows }
end

--- The YEAR column of the two-column band.
-- @tparam table stats normalized stats
-- @tparam table text labels
-- @tparam number[opt] year the year to name in the heading
-- @treturn table|nil { heading, rows }
function Views.yearBand(stats, text, year)
    local labels = text or Views.LABELS
    if type(stats) ~= "table" then return nil end

    local rows = {}
    local function addRow(label, value)
        if value == nil then return end
        rows[#rows + 1] = { label = label, value = value }
    end
    addRow(labels.books_done, Stats.formatCount(stats.finishedThisYear))
    addRow(labels.hours, stats.time and Stats.formatHours(stats.time.totalHours))
    addRow(labels.sessions, Ui.formatThousands(stats.sessionCount))
    addRow(labels.longest_streak, stats.streaks and streakCell(stats.streaks.best))
    if #rows == 0 then return nil end

    local heading = labels.year_band
    local named = tonumber(year) or (stats.goal and tonumber(stats.goal.year))
    if named then heading = heading .. " " .. string.format("%d", math.floor(named)) end
    return { heading = heading, rows = rows }
end

--- One "currently reading" row: cover, title, author + last read, percent.
-- @tparam table session normalized KOSync session
-- @param now current unix seconds
-- @tparam table[opt] text labels
-- @treturn table|nil row model
function Views.readingRow(session, now, text)
    local labels = text or Views.LABELS
    if type(session) ~= "table" then return nil end
    local title = Status.str(session.title)
    if title == "" then title = Status.str(session.filename) end
    if title == "" then return nil end
    local authors = Status.str(session.authors)
    local when = Ui.relativeWhen(Status.num(session.timestamp), now, labels)
    local percentage = Status.num(session.percentage) or 0
    return {
        kind = "reading",
        title = title,
        secondary = Ui.join({ authors, when }),
        value = string.format("%d%%", math.floor(percentage * 100 + 0.5)),
        ratio = percentage,
        cover_id = Status.num(session.book_id),
        action = { kind = "book", entry = session },
    }
end

--- One recent-session row: title, when / duration / device, duration again.
-- Informational only: a session is not a catalog row, so the row carries no
-- action and tapping it opens nothing.
-- @tparam table session a `recentSessions` entry from `/api/kosync/stats`
-- @tparam table today broken-down local time of "now"
-- @tparam table[opt] text labels
-- @treturn table|nil row model
function Views.sessionRow(session, today, text)
    local labels = text or Views.LABELS
    if type(session) ~= "table" then return nil end
    local title = Status.str(session.title)
    if title == "" then return nil end
    local duration = Status.num(session.durationSeconds)
    local when = nil
    local start_time = Status.num(session.startTime)
    if start_time then
        local ok, parts = pcall(os.date, "*t", start_time)
        if ok and type(parts) == "table" then when = Ui.clockLine(parts, today, labels) end
    end
    local secondary = Ui.join({
        when,
        Ui.durationLong(duration, labels),
        Status.str(session.device),
    })
    return {
        kind = "plain",
        title = title,
        secondary = secondary,
        value = duration and Stats.formatDuration(duration) or nil,
        bold = false,
    }
end

--- Builds the single-page reading-statistics model.
-- @tparam table stats normalized stats from `lighthouse_stats`
-- @tparam table sessions normalized sessions (the currently-reading shelf)
-- @param now current unix seconds
-- @tparam table[opt] options { labels, weeks, year, today, average_daily_minutes }
-- @treturn table page model
function Views.statsModel(stats, sessions, now, options)
    options = options or {}
    local text = Views.labels(options.labels)
    stats = type(stats) == "table" and stats or {}
    local today = type(options.today) == "table" and options.today or nil

    local blocks = {}

    local hero = Views.heroCells(stats, text)
    if #hero > 0 then blocks[#blocks + 1] = { kind = "hero", cells = hero } end

    local bands = {}
    local library = Views.libraryBand(stats, text)
    if library then bands[#bands + 1] = library end
    local year = Views.yearBand(stats, text, options.year)
    if year then bands[#bands + 1] = year end
    if #bands > 0 then blocks[#blocks + 1] = { kind = "band", columns = bands } end

    local reading_rows = {}
    local active = type(sessions) == "table" and sessions or {}
    local limit = math.max(math.floor(tonumber(options.reading_max) or 3), 0)
    for session_index = 1, #active do
        if #reading_rows >= limit then break end
        local row = Views.readingRow(active[session_index], now, text)
        if row then reading_rows[#reading_rows + 1] = row end
    end
    if #reading_rows > 0 then
        local heading = { left = text.currently_reading }
        local count = Ui.formatThousands(stats.activeCount or #active)
        if count then
            heading.right = count .. " " .. text.books_upper
        end
        blocks[#blocks + 1] = { kind = "section", heading = heading, rows = reading_rows }
    end

    local heatmap_days = type(stats.heatmap) == "table" and stats.heatmap or nil
    if heatmap_days and #heatmap_days > 0 then
        blocks[#blocks + 1] = {
            kind = "heatmap",
            heading = { left = text.activity, right = text.last_52_weeks },
            columns = Ui.heatmapColumns(heatmap_days, options.weeks),
        }
    end

    local session_rows = {}
    local recent = type(stats.recentSessions) == "table" and stats.recentSessions or {}
    local session_limit = math.max(math.floor(tonumber(options.session_max) or 3), 0)
    for session_index = 1, #recent do
        if #session_rows >= session_limit then break end
        local row = Views.sessionRow(recent[session_index], today, text)
        if row then session_rows[#session_rows + 1] = row end
    end
    if #session_rows > 0 then
        blocks[#blocks + 1] = {
            kind = "section",
            row_kind = "session",
            heading = { left = text.recent_sessions, right = string.format(text.last_n, #session_rows) },
            rows = session_rows,
        }
    end

    local footer = { left = "LightHouse", right = text.detail_on_web }
    local average = Status.num(options.average_daily_minutes)
    if average and average > 0 then
        -- Minutes, not "1h 8m": an average day is read as a minute figure, and
        -- that is how the accepted design prints it.
        footer.right = string.format(text.average_day, math.floor(average + 0.5))
            .. Ui.GLYPH.separator
            .. text.detail_on_web
    end

    return {
        title = text.reading_stats,
        switch = nil,
        subline = nil,
        blocks = blocks,
        footer = footer,
    }
end

-- ----------------------------------------------------------------------------
-- Library - Books / Authors / Series
-- ----------------------------------------------------------------------------

--- One series row: name, author and counts, progress over the read fraction.
-- @tparam table group { name, author, books, read, coverId }
-- @tparam table text labels
-- @treturn table row model
function Views.seriesRow(group, text)
    local labels = text or Views.LABELS
    group = type(group) == "table" and group or {}
    local books = Status.num(group.books) or 0
    local read = Status.num(group.read) or 0
    local title = Status.str(group.name)
    if title == "" then title = Status.str(group.author) end
    if title == "" then title = "—" end

    local value, ratio, value_sub
    if books > 0 and read >= books then
        value = labels.done
        ratio = 1
    elseif read <= 0 then
        value = "—"
        value_sub = labels.not_started
    else
        value = string.format("%d%%", math.floor(read / books * 100 + 0.5))
        ratio = read / books
    end
    if value_sub == nil then
        value_sub = string.format(labels.read_of_books,
            Ui.formatThousands(read) or "0", Ui.formatThousands(books) or "0")
    end

    return {
        kind = "reading",
        title = title,
        secondary = Ui.join({
            Status.str(group.author),
            string.format(labels.books_count, Ui.formatThousands(books) or "0"),
            string.format(labels.read_count, Ui.formatThousands(read) or "0"),
        }),
        value = value,
        value_sub = value_sub,
        ratio = ratio,
        cover_id = Status.num(group.coverId),
        action = { kind = "series", name = Status.str(group.name) },
    }
end

--- One author row: name, how many books and how many read, progress.
-- @tparam table group { name, books, read }
-- @tparam table text labels
-- @treturn table row model
function Views.authorRow(group, text)
    local labels = text or Views.LABELS
    group = type(group) == "table" and group or {}
    local books = Status.num(group.books) or 0
    local read = Status.num(group.read) or 0
    local title = Status.str(group.name)
    if title == "" then title = "—" end

    local value, ratio, value_sub
    if books > 0 and read >= books then
        value = labels.done
        ratio = 1
    elseif read <= 0 then
        value = "—"
        value_sub = labels.not_started
    else
        value = string.format("%d%%", math.floor(read / books * 100 + 0.5))
        ratio = read / books
    end
    if value_sub == nil then
        value_sub = string.format(labels.read_of_books,
            Ui.formatThousands(read) or "0", Ui.formatThousands(books) or "0")
    end

    return {
        kind = "reading",
        title = title,
        secondary = Ui.join({
            string.format(labels.books_count, Ui.formatThousands(books) or "0"),
            string.format(labels.read_count, Ui.formatThousands(read) or "0"),
        }),
        value = value,
        value_sub = value_sub,
        ratio = ratio,
        cover_id = Status.num(group.coverId),
        action = { kind = "author", name = Status.str(group.name) },
    }
end

--- One book row: cover, title, author and series, progress.
-- @tparam table entry OPDS entry already merged with reading progress
-- @tparam table text labels
-- @treturn table row model
function Views.bookRow(entry, text)
    local labels = text or Views.LABELS
    entry = type(entry) == "table" and entry or {}
    local title = Ui.rowTitle(entry.title)
    if title == "" then title = labels.untitled end
    local value, ratio = Views.progressValue(entry.status, labels)
    return {
        kind = "reading",
        title = title,
        secondary = Views.bookSecondary(entry),
        value = value,
        ratio = ratio,
        cover_id = Status.num(entry.book_id),
        action = { kind = "book", entry = entry },
    }
end

--- Builds the library page model for one grouping.
--
-- @tparam string mode "books" | "authors" | "series"
-- @tparam table context {
--     entries = catalog entries (books mode, already paged),
--     groups = grouping rows (authors/series mode, all of them),
--     query = current search text,
--     totals = { books, authors, series },
--     page = 1-based page number,
--     page_size = rows per page,
--     has_next = whether the catalog has another page (books mode),
--   }
-- @tparam table[opt] options { labels }
-- @treturn table page model
function Views.libraryModel(mode, context, options)
    options = options or {}
    local text = Views.labels(options.labels)
    context = type(context) == "table" and context or {}
    if mode ~= "authors" and mode ~= "series" then mode = "books" end

    local page = math.max(math.floor(tonumber(context.page) or 1), 1)
    local page_size = math.max(math.floor(tonumber(context.page_size) or 1), 1)
    local totals = type(context.totals) == "table" and context.totals or {}

    local rows = {}
    local pages = 1

    -- Every page of every grouping leads with the search row: a reader who has
    -- paged forward must still be able to search without paging back, and the
    -- row is the same row (same label, same `search` action) on every page.
    -- The page budget in `main.lua` reserves it on every page too, so reserving
    -- it here is what keeps the drawn rows inside the plan.
    rows[#rows + 1] = {
        kind = "action",
        title = text.search,
        value = Ui.GLYPH.chevron,
        action = { kind = "search" },
    }

    if mode == "books" then
        local entries = type(context.entries) == "table" and context.entries or {}
        for entry_index = 1, #entries do
            rows[#rows + 1] = Views.bookRow(entries[entry_index], text)
        end
        -- The catalog pages itself: one more page exists exactly when the feed
        -- said so. When the feed also reports how many books matched, the footer
        -- can name the real page count instead of a rolling window that always
        -- claims the reader is on the last page.
        local total = Status.num(totals.books)
        if total and total > 0 then
            pages = math.max(math.ceil(total / page_size), page)
        else
            pages = context.has_next and (page + 1) or page
        end
        if context.has_next then
            rows[#rows + 1] = {
                kind = "action",
                title = text.next_page,
                value = Ui.GLYPH.chevron,
                action = { kind = "page", page = page + 1 },
            }
        end
    else
        local groups = type(context.groups) == "table" and context.groups or {}
        pages = math.max(math.ceil(#groups / page_size), 1)
        -- A refresh can leave the reader on a page that no longer exists; the
        -- last page is what there is to draw, and the footer says so.
        if page > pages then page = pages end
        local first = (page - 1) * page_size + 1
        -- Counted separately from `#rows`: the search row is navigation, not one
        -- of this page's `page_size` group rows.
        local drawn = 0
        for group_index = first, #groups do
            if drawn >= page_size then break end
            local group = groups[group_index]
            if type(group) == "table" and Status.str(group.name) ~= "" then
                rows[#rows + 1] = mode == "series"
                    and Views.seriesRow(group, text)
                    or Views.authorRow(group, text)
                drawn = drawn + 1
            end
        end
        if #groups == 0 then
            rows[#rows + 1] = {
                kind = "plain",
                title = mode == "series" and text.no_series or text.no_authors,
                bold = false,
            }
        end
        if page < pages then
            rows[#rows + 1] = {
                kind = "action",
                title = text.next_page,
                value = Ui.GLYPH.chevron,
                action = { kind = "page", page = page + 1 },
            }
        end
    end

    -- Sub-line: how big this grouping is, and the order it is in.
    local subline = { right = text.az }
    if mode == "series" then
        subline.left = Ui.join({
            string.format(text.series_count, Ui.formatThousands(totals.series) or "0"),
            string.format(text.books_count, Ui.formatThousands(totals.books) or "0"),
        })
    elseif mode == "authors" then
        subline.left = Ui.join({
            string.format(text.author_count, Ui.formatThousands(totals.authors) or "0"),
            string.format(text.books_count, Ui.formatThousands(totals.books) or "0"),
        })
    else
        local query = Status.str(context.query)
        if query ~= "" then
            subline.left = query
        elseif totals.books then
            subline.left = string.format(text.books_count, Ui.formatThousands(totals.books))
        end
    end

    local switch = {}
    local segments = Ui.switchSegments(mode)
    local label_for = { books = text.books, authors = text.authors, series = text.series }
    for segment_index = 1, #segments do
        local segment = segments[segment_index]
        switch[#switch + 1] = {
            key = segment.key,
            label = label_for[segment.key] or segment.label,
            active = segment.active,
        }
    end

    local footer = {
        left = string.format(text.page, page, pages),
        right = mode == "series" and text.grouped_by_series
            or (mode == "authors" and text.grouped_by_author or text.all_books),
    }

    return {
        title = text.library,
        switch = switch,
        subline = subline,
        blocks = { { kind = "list", rows = rows } },
        footer = footer,
        pager = { page = page, pages = pages },
    }
end

return Views
