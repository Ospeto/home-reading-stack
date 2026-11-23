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
    search_short = "Search",
    next_page = "Next page",
    prev_page = "Prev",
    next_page_short = "Next",
    page = "Page %d of %d",
    page_compact = "Page %d / %d",
    clear_filter = "Clear",
    on_device = "On device",
    sort_newest = "Newest",
    sort_title = "A–Z",
    sort_author = "Author",
    sort_series = "Series",
    filter_unread = "Unread",
    heat_less = "Less",
    heat_more = "More",
    jump_az = "A–Z",
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
    reading_shelf = "Currently reading",
    highlights = "Highlights",
    synopsis = "SYNOPSIS",
    open_book = "Open book",
    open_short = "Open",
    download_epub = "Download EPUB",
    download_short = "Download",
    download_again = "Download again",
    full_synopsis = "Full synopsis",
    next_unread = "Next unread",
    highlights_count = "Highlights (%s)",
    highlights_plural = "%s highlights",
    highlights_singular = "1 highlight",
    no_synopsis = "No synopsis available.",
    book_missing = "Book file is missing from this device",
    file_missing_short = "Missing",
    local_progress_note = "Progress read from this device",
    device_only_notice = "This device only - the server could not be reached.",
    newest_first = "Newest first",
    offline = "Offline",
    note_prefix = "Note: %s",
    page_short = "p. %s",
    tags_label = "Tags: %s",
    last_device = "Last device: %s",
    unknown_author = "Unknown",
    in_progress_count = "%s in progress",
    no_epub = "No EPUB download",
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

--- Month axis labels for the activity heatmap (oldest -> newest).
-- @tparam table[opt] heatmap_days normalized heatmap entries
-- @tparam table[opt] today os.date("*t") table
-- @number[opt] weeks number of columns drawn
-- @tparam table text labels
-- @treturn table array of short month names
local function heatmapMonths(heatmap_days, today, weeks, text)
    local month_names = type(text) == "table" and type(text.months) == "table"
        and #text.months == 12 and text.months or Ui.TIME_LABELS.months
    local end_month
    if type(heatmap_days) == "table" then
        for day_index = #heatmap_days, 1, -1 do
            local day = heatmap_days[day_index]
            local date_str = type(day) == "table" and type(day.date) == "string" and day.date or nil
            local month_num = date_str and tonumber(date_str:match("^%d%d%d%d%-(%d%d)%-%d%d$")) or nil
            if month_num and month_num >= 1 and month_num <= 12 then
                end_month = month_num
                break
            end
        end
    end
    if not end_month and type(today) == "table" then
        local month_num = tonumber(today.month)
        if month_num and month_num >= 1 and month_num <= 12 then end_month = month_num end
    end
    if not end_month then return {} end

    local span_weeks = math.max(math.floor(tonumber(weeks) or Ui.tokens.page_heat_weeks), 1)
    local ticks = math.min(6, math.max(2, math.floor(span_weeks / 8)))
    local labels = {}
    for step = ticks - 1, 0, -1 do
        local index = ((end_month - 1 - step * 2) % 12) + 1
        labels[#labels + 1] = month_names[index]
    end
    return labels
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
            months = heatmapMonths(heatmap_days, today, options.weeks, text),
            legend = { less = text.heat_less, more = text.heat_more },
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

--- One book row: cover, title, author and series, progress and rating.
-- @tparam table entry OPDS entry already merged with reading progress
-- @tparam table text labels
-- @treturn table row model
function Views.bookRow(entry, text)
    local labels = text or Views.LABELS
    entry = type(entry) == "table" and entry or {}
    local title = Ui.rowTitle(entry.title)
    if title == "" then title = labels.untitled end
    local value, ratio = Views.progressValue(entry.status, labels)
    local on_device = entry.on_device == true or type(entry.local_record) == "table"
    local secondary = Views.bookSecondary(entry)
    if on_device then
        secondary = Ui.join({ secondary, Ui.GLYPH.local_dot .. " " .. labels.on_device })
    end
    local rating = Status.num(entry.rating)
    local value_sub = (rating and rating > 0) and Status.ratingStars(rating) or nil
    return {
        kind = "reading",
        title = title,
        secondary = secondary,
        value = value,
        value_sub = value_sub,
        ratio = ratio,
        on_device = on_device,
        cover_id = Status.num(entry.book_id),
        action = { kind = "book", entry = entry },
    }
end

--- Resolves the display label for an OPDS sort key.
-- @string[opt] sort_key "added" | "title" | "author" | "series"
-- @tparam table text labels
-- @treturn string
local function sortLabel(sort_key, text)
    if sort_key == "added" then return text.sort_newest end
    if sort_key == "author" then return text.sort_author end
    if sort_key == "series" then return text.sort_series end
    return text.sort_title
end

--- Builds the library page model for one grouping.
--
-- @tparam string mode "books" | "authors" | "series"
-- @tparam table context {
--     entries = catalog entries (books mode, already paged),
--     groups = grouping rows (authors/series mode, all of them),
--     query = current search text,
--     title = contextual header title when filtered,
--     sort = "added" | "title" | "author" | "series",
--     filter = "" | "unread",
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
    local query = Status.str(context.query)
    local filter_key = Status.str(context.filter)
    local sort_key = Status.str(context.sort)

    local rows = {}
    local pages = 1

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
    else
        local groups = type(context.groups) == "table" and context.groups or {}
        pages = math.max(math.ceil(#groups / page_size), 1)
        -- A refresh can leave the reader on a page that no longer exists; the
        -- last page is what there is to draw, and the footer says so.
        if page > pages then page = pages end
        local first = (page - 1) * page_size + 1
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
    end

    -- Sub-line: shelf summary (with Clear when filtered) and interactive sort/jump.
    local subline = {}
    if mode == "series" then
        subline.left = Ui.join({
            string.format(text.series_count, Ui.formatThousands(totals.series) or "0"),
            string.format(text.books_count, Ui.formatThousands(totals.books) or "0"),
        })
        subline.right = text.jump_az .. " " .. Ui.GLYPH.dropdown
        subline.right_action = { kind = "jump_letter" }
    elseif mode == "authors" then
        subline.left = Ui.join({
            string.format(text.author_count, Ui.formatThousands(totals.authors) or "0"),
            string.format(text.books_count, Ui.formatThousands(totals.books) or "0"),
        })
        subline.right = text.jump_az .. " " .. Ui.GLYPH.dropdown
        subline.right_action = { kind = "jump_letter" }
    else
        local count_text = totals.books
            and string.format(text.books_count, Ui.formatThousands(totals.books))
            or nil
        if filter_key == "unread" then
            subline.left = Ui.join({ count_text, text.filter_unread })
        elseif count_text then
            subline.left = count_text
        elseif query ~= "" then
            subline.left = query
        end
        if query ~= "" then
            subline.clear = {
                label = Ui.GLYPH.clear .. " " .. text.clear_filter,
                action = { kind = "clear_query" },
            }
        end
        local active_sort = sortLabel(sort_key, text)
        local right_label = filter_key == "unread"
            and Ui.join({ active_sort, text.filter_unread })
            or active_sort
        subline.right = right_label .. " " .. Ui.GLYPH.dropdown
        subline.right_action = { kind = "sort_filter" }
    end

    -- Filtered views hide the grouping switch and show the active filter/query
    -- as the header title so the reader always knows where they are.
    local title = text.library
    local switch = nil
    if query ~= "" then
        local context_title = Status.str(context.title)
        title = context_title ~= "" and context_title or query
    else
        switch = {}
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
    end

    local footer = {
        left = string.format(text.page, page, pages),
        right = mode == "series" and text.grouped_by_series
            or (mode == "authors" and text.grouped_by_author or text.all_books),
        prev = Ui.GLYPH.back .. " " .. text.prev_page,
        center = string.format(text.page_compact, page, pages),
        next = text.next_page_short .. " " .. Ui.GLYPH.chevron,
    }

    local header_actions = { search = true, search_label = text.search_short }
    local series_name = Status.str(context.series_name)
    if mode == "books" and series_name ~= "" then
        header_actions.search = false
        header_actions.extra = {
            label = text.next_unread,
            action = { kind = "download_next_unread", series = series_name },
        }
    end

    return {
        title = title,
        header_actions = header_actions,
        switch = switch,
        subline = subline,
        blocks = { { kind = "list", rows = rows } },
        footer = footer,
        pager = {
            page = page,
            pages = pages,
            has_prev = page > 1,
            has_next = page < pages,
        },
    }
end

-- ----------------------------------------------------------------------------
-- Book Detail Card, Currently Reading shelf, and Highlights reader
-- ----------------------------------------------------------------------------

--- Shared 3-zone pager footer for multi-page views.
-- @number page
-- @number pages
-- @string right_summary
-- @tparam table text
-- @treturn table footer, pager
local function pagerFooter(page, pages, right_summary, text)
    local footer = {
        left = string.format(text.page, page, pages),
        right = right_summary or "",
        prev = Ui.GLYPH.back .. " " .. text.prev_page,
        center = string.format(text.page_compact, page, pages),
        next = text.next_page_short .. " " .. Ui.GLYPH.chevron,
    }
    local pager = {
        page = page,
        pages = pages,
        has_prev = page > 1,
        has_next = page < pages,
    }
    return footer, pager
end

--- Builds the single-screen Book Detail Card model.
-- @tparam table entry OPDS catalog entry or normalized reading session
-- @tparam table[opt] options { labels, local_path, body_lines, body_chars }
-- @treturn table page model
function Views.bookDetailModel(entry, options)
    options = options or {}
    local text = Views.labels(options.labels)
    entry = type(entry) == "table" and entry or {}

    local title = Ui.rowTitle(entry.title)
    if title == "" then title = text.untitled end
    local authors = Status.str(entry.authors)
    local author_label = authors ~= "" and authors or text.unknown_author
    local author_action = authors ~= "" and { kind = "filter_author", name = authors } or nil

    local series = Status.str(entry.series)
    local series_label = ""
    local series_action = nil
    if series ~= "" then
        local s_idx = Status.num(entry.series_index)
        series_label = s_idx and string.format("%s #%g", series, s_idx) or series
        series_action = { kind = "filter_series", name = series }
    end

    local rating = Status.num(entry.rating)
    local rating_stars = (rating and rating > 0) and Status.ratingStars(rating) or nil
    local rating_label = Status.ratingLabel(rating)

    local progress_status = type(entry.status) == "table" and entry.status or nil
    if progress_status == nil then
        local pct = Status.num(entry.percentage)
        if pct then
            progress_status = {
                percentage = pct,
                device = entry.device,
                timestamp = entry.timestamp,
                progress_source = entry.progress_source,
            }
        end
    end
    local progress_value, progress_ratio = Views.progressValue(progress_status, text)
    local progress_detail = Status.statusLabel(progress_status and { status = progress_status } or {})
    local is_local_progress = progress_status ~= nil and Status.str(progress_status.progress_source) == "device"
    local local_note = is_local_progress and text.local_progress_note or nil

    local local_path = Status.str(options.local_path)
    local on_device = local_path ~= ""
    local local_record = type(entry.local_record) == "table" and entry.local_record or nil
    local hl_count = local_record and (Status.num(local_record.annotation_count) or 0) or 0

    local raw_synopsis = Status.str(entry.summary)
    if raw_synopsis == "" then raw_synopsis = Status.str(entry.content) end
    local clean_synopsis = Ui.plainText(raw_synopsis)
    local body_lines = math.max(math.floor(tonumber(options.body_lines) or 8), 1)
    local body_chars = math.max(math.floor(tonumber(options.body_chars) or 44), 16)
    local wrapped = clean_synopsis ~= ""
        and Ui.wrapLines(clean_synopsis, body_chars, body_lines)
        or { lines = { text.no_synopsis }, truncated = false }

    local buttons = {}
    if on_device then
        buttons[#buttons + 1] = {
            label = text.open_book,
            action = { kind = "open_book", path = local_path, entry = entry },
            primary = true,
        }
        if entry.download_href ~= nil then
            buttons[#buttons + 1] = {
                label = text.download_again,
                action = { kind = "download", entry = entry },
            }
        end
    elseif entry.download_href ~= nil then
        buttons[#buttons + 1] = {
            label = text.download_epub,
            action = { kind = "download", entry = entry },
            primary = true,
        }
    elseif Status.str(entry.book_path) ~= "" then
        buttons[#buttons + 1] = {
            label = text.book_missing,
            disabled = true,
        }
    else
        buttons[#buttons + 1] = {
            label = text.no_epub,
            disabled = true,
        }
    end
    if hl_count > 0 then
        buttons[#buttons + 1] = {
            label = string.format(text.highlights_count, Ui.formatThousands(hl_count) or tostring(hl_count)),
            action = { kind = "book_highlights", record = local_record },
        }
    end
    if clean_synopsis ~= "" then
        buttons[#buttons + 1] = {
            label = text.full_synopsis,
            action = { kind = "synopsis", entry = entry },
        }
    end

    local tags = {}
    if type(entry.tags) == "table" then
        for tag_index = 1, #entry.tags do
            local tag_name = Status.str(entry.tags[tag_index])
            if tag_name ~= "" then tags[#tags + 1] = tag_name end
        end
    end
    local tags_line = #tags > 0 and string.format(text.tags_label, table.concat(tags, ", ")) or nil
    local device = progress_status and Status.str(progress_status.device) or ""
    local device_line = device ~= "" and string.format(text.last_device, device) or nil

    local hero_block = {
        kind = "book_hero",
        cover_id = Status.num(entry.book_id),
        title = title,
        author = author_label,
        author_action = author_action,
        series = series_label,
        series_action = series_action,
        rating_stars = rating_stars,
        rating_label = rating_label,
        progress_value = progress_value,
        progress_ratio = progress_ratio,
        progress_detail = progress_detail,
        on_device = on_device,
        on_device_label = on_device and (Ui.GLYPH.local_dot .. " " .. text.on_device) or nil,
        local_note = local_note,
    }
    local action_block = {
        kind = "action_bar",
        buttons = buttons,
    }
    local body_block = {
        kind = "text_body",
        heading = {
            left = text.synopsis,
            right = wrapped.truncated and text.full_synopsis or nil,
        },
        lines = wrapped.lines,
        truncated = wrapped.truncated,
        muted = clean_synopsis == "",
        tags = tags_line,
        meta = device_line,
        action = wrapped.truncated and { kind = "synopsis", entry = entry } or nil,
    }

    local published = Status.str(entry.published)
    local footer_left = published ~= "" and published:sub(1, 10) or author_label
    local footer_right = on_device and (Ui.GLYPH.local_dot .. " " .. text.on_device) or text.library

    return {
        title = title,
        header_actions = {},
        switch = nil,
        subline = nil,
        blocks = { hero_block, action_block, body_block },
        footer = {
            left = footer_left,
            right = footer_right,
        },
    }
end

--- Builds the full-screen Currently Reading page model.
-- @tparam table sessions merged reading shelf from `mergeReadingShelf`
-- @param now current unix seconds
-- @tparam table[opt] options { labels, page, page_size, degraded, offline }
-- @treturn table page model
function Views.readingShelfModel(sessions, now, options)
    options = options or {}
    local text = Views.labels(options.labels)
    sessions = type(sessions) == "table" and sessions or {}

    local page_size = math.max(math.floor(tonumber(options.page_size) or 7), 1)
    local pages = math.max(math.ceil(#sessions / page_size), 1)
    local page = math.max(math.min(math.floor(tonumber(options.page) or 1), pages), 1)

    local rows = {}
    local first = (page - 1) * page_size + 1
    local last = math.min(page * page_size, #sessions)
    for idx = first, last do
        local session = sessions[idx]
        if type(session) == "table" then
            local title = Ui.rowTitle(session.title)
            if title == "" then title = Ui.rowTitle(session.filename) end
            if title == "" then title = text.untitled end
            local authors = Status.str(session.authors)
            if authors == "" then authors = text.unknown_author end
            local when = Ui.relativeWhen(Status.num(session.timestamp), now, text)
            local device = Status.str(session.device)
            local local_path = Status.str(session.local_path)
            if local_path == "" then local_path = Status.str(session.book_path) end
            local has_local = session.has_local_file == true and local_path ~= ""
            local book_id = Status.num(session.book_id)
            local status_tag = has_local and (Ui.GLYPH.local_dot .. " " .. text.on_device)
                or (Status.str(session.book_path) ~= "" and text.file_missing_short or device)
            local pct = Status.num(session.percentage) or 0
            local val = pct >= 0.99 and Ui.GLYPH.done or string.format("%d%%", math.floor(pct * 100 + 0.5))
            local action_hint = has_local and (text.open_short .. " " .. Ui.GLYPH.chevron)
                or (book_id and text.download_short or text.file_missing_short)
            local row_action = has_local
                and { kind = "open_book", path = local_path, entry = session }
                or { kind = "book", entry = session }

            rows[#rows + 1] = {
                kind = "reading",
                title = title,
                secondary = Ui.join({ authors, when, status_tag }),
                value = val,
                value_sub = action_hint,
                ratio = pct,
                on_device = has_local,
                cover_id = book_id,
                action = row_action,
                hold_action = { kind = "reading_actions", entry = session, local_path = has_local and local_path or nil },
            }
        end
    end

    local subline_left = options.degraded
        and text.device_only_notice
        or string.format(text.in_progress_count, Ui.formatThousands(#sessions) or tostring(#sessions))
    local subline_right = options.offline and text.offline or text.newest_first
    local footer, pager = pagerFooter(page, pages, text.reading_shelf, text)

    return {
        title = text.reading_shelf,
        header_actions = {},
        switch = nil,
        subline = { left = subline_left, right = subline_right },
        blocks = { { kind = "list", rows = rows } },
        footer = footer,
        pager = pager,
    }
end

--- Builds the full-screen Highlights index (grouped by book, newest first).
-- @tparam table groups result of `Sidecar.highlightGroups`
-- @tparam table[opt] options { labels, page, page_size }
-- @treturn table page model
function Views.highlightsIndexModel(groups, options)
    options = options or {}
    local text = Views.labels(options.labels)
    groups = type(groups) == "table" and groups or {}

    local total_hl = 0
    for idx = 1, #groups do
        local g = groups[idx]
        total_hl = total_hl + (Status.num(g and g.annotation_count) or #(g and g.annotations or {}))
    end

    local page_size = math.max(math.floor(tonumber(options.page_size) or 8), 1)
    local pages = math.max(math.ceil(#groups / page_size), 1)
    local page = math.max(math.min(math.floor(tonumber(options.page) or 1), pages), 1)

    local rows = {}
    local first = (page - 1) * page_size + 1
    local last = math.min(page * page_size, #groups)
    for idx = first, last do
        local group = groups[idx]
        if type(group) == "table" then
            local title = Ui.rowTitle(group.title)
            if title == "" then title = text.untitled end
            local authors = Status.str(group.authors)
            if authors == "" then authors = text.unknown_author end
            local first_ann = type(group.annotations) == "table" and group.annotations[1] or nil
            local raw_quote = first_ann and (Status.str(first_ann.text) ~= "" and Status.str(first_ann.text) or Status.str(first_ann.note)) or ""
            local snippet = raw_quote ~= "" and Ui.ellipsize(Ui.plainText(raw_quote), 44) or nil
            local count = Status.num(group.annotation_count) or #(group.annotations or {})
            local count_str = Ui.formatThousands(count) or tostring(count)
            rows[#rows + 1] = {
                kind = "plain",
                title = title,
                secondary = Ui.join({ authors, snippet }),
                value = count_str,
                value_sub = Ui.GLYPH.chevron,
                action = { kind = "highlight_book", group = group },
            }
        end
    end

    local hl_summary = total_hl == 1
        and text.highlights_singular
        or string.format(text.highlights_plural, Ui.formatThousands(total_hl) or tostring(total_hl))
    local subline = {
        left = Ui.join({
            string.format(text.books_count, Ui.formatThousands(#groups) or tostring(#groups)),
            hl_summary,
        }),
        right = text.newest_first,
    }
    local footer, pager = pagerFooter(page, pages, text.highlights, text)

    return {
        title = text.highlights,
        header_actions = {},
        switch = nil,
        subline = subline,
        blocks = { { kind = "list", rows = rows } },
        footer = footer,
        pager = pager,
    }
end

--- Builds the multi-line quote reader screen for a single book's highlights.
-- @tparam table group one entry from `Sidecar.highlightGroups`
-- @tparam table[opt] options { labels, page, page_size, quote_lines, quote_chars, book_exists }
-- @treturn table page model
function Views.bookHighlightsModel(group, options)
    options = options or {}
    local text = Views.labels(options.labels)
    group = type(group) == "table" and group or {}
    local annotations = type(group.annotations) == "table" and group.annotations or {}

    local title = Ui.rowTitle(group.title)
    if title == "" then title = text.untitled end
    local page_size = math.max(math.floor(tonumber(options.page_size) or 4), 1)
    local pages = math.max(math.ceil(#annotations / page_size), 1)
    local page = math.max(math.min(math.floor(tonumber(options.page) or 1), pages), 1)
    local quote_lines = math.max(math.floor(tonumber(options.quote_lines) or 3), 1)
    local quote_chars = math.max(math.floor(tonumber(options.quote_chars) or 42), 18)

    local rows = {}
    local first = (page - 1) * page_size + 1
    local last = math.min(page * page_size, #annotations)
    for idx = first, last do
        local ann = annotations[idx]
        if type(ann) == "table" then
            local raw_text = Status.str(ann.text)
            if raw_text == "" then raw_text = Status.str(ann.note) end
            local wrapped = Ui.wrapLines(raw_text, quote_chars, quote_lines)
            local lines = #wrapped.lines > 0 and wrapped.lines or { text.untitled }
            local raw_note = Status.str(ann.note)
            local note = nil
            if raw_note ~= "" and raw_note ~= Status.str(ann.text) then
                note = string.format(text.note_prefix, Ui.ellipsize(Ui.plainText(raw_note), quote_chars))
            end
            local pageno = Status.num(ann.pageno) or Status.num(ann.page)
            local meta_left = Ui.join({ Status.str(ann.chapter), Status.str(ann.datetime) })
            local meta_right = (pageno and pageno >= 1)
                and string.format(text.page_short, tostring(math.floor(pageno)))
                or ""
            rows[#rows + 1] = {
                kind = "quote",
                lines = lines,
                note = note,
                meta_left = meta_left,
                meta_right = meta_right,
                action = { kind = "highlight", group = group, annotation = ann },
            }
        end
    end

    local total_count = #annotations
    local left_label = total_count == 1
        and text.highlights_singular
        or string.format(text.highlights_plural, Ui.formatThousands(total_count) or tostring(total_count))
    local right_label = options.book_exists ~= false
        and (Ui.GLYPH.local_dot .. " " .. text.on_device)
        or text.file_missing_short
    local footer, pager = pagerFooter(page, pages, text.highlights, text)

    return {
        title = title,
        header_actions = {},
        switch = nil,
        subline = { left = left_label, right = right_label },
        blocks = { { kind = "quote_list", rows = rows } },
        footer = footer,
        pager = pager,
    }
end

return Views
