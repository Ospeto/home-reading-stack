--[[--
Reading-statistics parsing and formatting for the LightHouse plugin.

The LightHouse server does all of the arithmetic: it turns KOSync progress rows
into reading sessions, streaks, daily reading time, a 365-day activity heatmap,
library health and yearly-goal progress, and serves the result at
`GET /api/kosync/stats`. The device is a read-only consumer — it must never
recompute a session or invent a number, because a second implementation would
drift from the one the web app shows.

So this module only *reads* that payload and formats it for an e-ink screen.
It is pure Lua: no sockets, no widgets, no KOReader modules, so the repository's
off-device test suite can exercise every branch of it.

Field shape of `GET /api/kosync/stats` (only the parts used here):

    {
        streaks = { currentStreak = 5, longestStreak = 12 },
        dailyReadingTime = {
            todaySeconds = 2700, thisWeekSeconds = 15000, totalHours = 132.5, ...
        },
        heatmap = {
            { date = "2026-11-15", minutes = 45, seconds = 2700, level = 2,
              count = 2, bookCount = 1, books = { "Dune" } }, ...
        },
        libraryHealth = {
            unreadCount = 120, inProgressCount = 8, finishedCount = 34, ...
        },
        goal = {
            year = 2026, targetBooks = 25, targetHours = 100,
            currentBooks = 12, currentHours = 34,
            booksPercent = 48, hoursPercent = 34, isConfigured = true,
        },
        finishedCount = 55,   -- all time, not this year
    }

Every helper returns `nil` for a value the payload does not carry, so the view
can print "unavailable" instead of a confident zero.
]]

local Stats = {}

--- Days shown in the heatmap window.
-- 26 weeks is the most that stays readable without horizontal scrolling on a
-- 600px e-ink menu row (one character per day).
Stats.DEFAULT_HEATMAP_DAYS = 182

--- Distinct monochrome glyphs for heatmap levels 0..4.
-- Deliberately not a colour ramp: e-ink shows no colour, and a dup of the web
-- app's amber scale would read as five identical greys. Box-drawing/block
-- glyphs are density-ordered and render in KOReader's default fonts.
local LEVEL_GLYPHS = { [0] = "·", "░", "▒", "▓", "█" }

--- Minutes a day must reach to be drawn at each level.
-- The single definition of the ramp: `heatmapLevel` maps a day with it, and
-- the view's shade key is built from it, so the printed key can never describe
-- a different picture. Same thresholds as `computeReadingHeatmap` in
-- uploader/reading-stats.ts.
Stats.LEVEL_MIN_MINUTES = { [0] = 0, [1] = 1, [2] = 15, [3] = 30, [4] = 60 }

--- Glyph used when a day's level cannot be determined at all.
local UNKNOWN_GLYPH = "?"

--- Short month names for compact day labels (e-ink needs short rows).
local MONTH_NAMES = {
    "Jan", "Feb", "Mar", "Apr", "May", "Jun",
    "Jul", "Aug", "Sep", "Oct", "Nov", "Dec",
}

--- Returns a finite number, or nil for anything else (including NaN).
-- Zero is a real value here: it means "the server said zero", which the view
-- must show as zero instead of "unavailable".
-- @param value number|string|nil
-- @treturn number|nil
local function numberOf(value)
    local parsed = tonumber(value)
    if not parsed or parsed ~= parsed then return nil end
    if parsed == math.huge or parsed == -math.huge then return nil end
    return parsed
end

--- Rounds to the nearest whole number.
-- @number value
-- @treturn number
local function round(value)
    if value >= 0 then return math.floor(value + 0.5) end
    return -math.floor(-value + 0.5)
end

--- Formats a duration in seconds as compact reading time.
-- "45m", "4h 10m", "2h", "132h 30m". Sub-minute totals round up to 1m so a
-- real but tiny session never reads as zero, and an exact zero stays "0m".
-- @number seconds
-- @treturn string|nil
function Stats.formatDuration(seconds)
    local total = numberOf(seconds)
    if not total then return nil end
    if total <= 0 then return "0m" end

    local minutes = round(total / 60)
    if minutes < 1 then minutes = 1 end
    if minutes < 60 then return string.format("%dm", minutes) end

    local hours = math.floor(minutes / 60)
    local rest = minutes - hours * 60
    if rest == 0 then return string.format("%dh", hours) end
    return string.format("%dh %dm", hours, rest)
end

--- Formats a minute count as compact reading time.
-- @number minutes
-- @treturn string|nil
function Stats.formatMinutes(minutes)
    local value = numberOf(minutes)
    if not value then return nil end
    return Stats.formatDuration(value * 60)
end

--- Formats an hour count for a goal target, e.g. "34h" or "34.5h".
-- @number hours
-- @treturn string|nil
function Stats.formatHours(hours)
    local value = numberOf(hours)
    if not value then return nil end
    if value == math.floor(value) then
        return string.format("%dh", value)
    end
    return string.format("%.1fh", value)
end

--- Formats a day count as "1 day" / "5 days".
-- @number count
-- @treturn string|nil
function Stats.formatDays(count)
    local value = numberOf(count)
    if not value then return nil end
    local whole = round(value)
    if whole == 1 then return "1 day" end
    return string.format("%d days", whole)
end

--- Formats a whole count, e.g. "12" or "0".
-- Kept here so the view never formats a number itself: a float from JSON
-- (12.0) must not print as "12.0" on a stats row.
-- @number count
-- @treturn string|nil
function Stats.formatCount(count)
    local value = numberOf(count)
    if not value then return nil end
    return string.format("%d", round(value))
end

--- Turns a YYYY-MM-DD string into "Nov 15"; returns the input when it is not
-- in that shape, so an unexpected date never disappears from the view.
-- @string date
-- @treturn string|nil
function Stats.shortDate(date)
    if type(date) ~= "string" or date == "" then return nil end
    local year, month, day = date:match("^(%d%d%d%d)%-(%d%d)%-(%d%d)$")
    if not year then return date end
    local name = MONTH_NAMES[tonumber(month) or 0]
    if not name then return date end
    return string.format("%s %d", name, tonumber(day) or 0)
end

--- Reads the monochrome level 0..4 the server shipped for one heatmap day.
--
-- The device never derives a level from minutes: the server owns that ramp, and
-- a second definition here would drift from the picture the web app draws. A
-- day without a usable level is simply not shaded.
-- @tparam table day heatmap entry
-- @treturn number|nil 0..4, or nil when the entry carries no usable level
function Stats.heatmapLevel(day)
    if type(day) ~= "table" then return nil end

    local level = numberOf(day.level)
    if not level then return nil end
    if level < 0 or level > 4 or level ~= math.floor(level) then return nil end
    return level
end

--- Glyph for one heatmap level.
-- @number level 0..4
-- @treturn string
function Stats.heatmapGlyph(level)
    if level == nil then return UNKNOWN_GLYPH end
    return LEVEL_GLYPHS[level] or UNKNOWN_GLYPH
end

--- Normalizes the `/api/kosync/stats` payload into what the view renders.
--
-- Sections the server did not send stay `nil` — the view prints "unavailable"
-- for those instead of zero. A field that is present but zero stays zero.
-- @tparam table payload decoded JSON body
-- @treturn table|nil normalized stats, nil when the payload is not a table
function Stats.normalize(payload)
    if type(payload) ~= "table" then return nil end

    local stats = {}

    local streaks = payload.streaks
    if type(streaks) == "table" then
        stats.streaks = {
            current = numberOf(streaks.currentStreak),
            best = numberOf(streaks.longestStreak),
        }
    end

    local daily = type(payload.dailyReadingTime) == "table" and payload.dailyReadingTime or nil
    local time = {
        todaySeconds = numberOf(daily and daily.todaySeconds),
        thisWeekSeconds = numberOf(daily and daily.thisWeekSeconds),
        totalHours = numberOf(daily and daily.totalHours),
    }
    if time.todaySeconds or time.thisWeekSeconds or time.totalHours then
        stats.time = time
    end

    local goal = type(payload.goal) == "table" and payload.goal or nil
    if goal then
        -- `currentBooks` is the server's count of books *finished this year*
        -- (it walks finished timestamps), unlike `finishedCount` which is
        -- all-time. It is valid whether or not a goal target is configured.
        stats.finishedThisYear = numberOf(goal.currentBooks)
    end

    local health = payload.libraryHealth
    if type(health) == "table" then
        local counts = {
            unread = numberOf(health.unreadCount),
            reading = numberOf(health.inProgressCount),
            finished = numberOf(health.finishedCount),
            -- The one-page view names the shelf size in its heading and shows
            -- how much of it has gone stale, so both are carried here instead
            -- of being guessed from the three counts above.
            total = numberOf(health.totalBooks),
            stale = numberOf(health.staleCount),
        }
        if counts.unread or counts.reading or counts.finished then
            stats.health = counts
        end
    end

    -- How many books are in progress right now. The currently-reading rows
    -- themselves are normalized from the same payload's `activeBooks` by the
    -- caller (`Status.normalizeSessions`), the one place a KOSync row is
    -- normalized for this plugin; this is only the count its heading shows.
    if type(payload.activeBooks) == "table" then
        stats.activeCount = #payload.activeBooks
    end

    -- Session totals come from `summary`, with the older top-level field as a
    -- fallback, so either shape of the payload fills the same row.
    local summary = payload.summary
    if type(summary) == "table" then
        stats.sessionCount = numberOf(summary.totalSessionsCount)
        stats.averageDailyMinutes = numberOf(summary.averageDailyMinutes)
    end
    if not stats.sessionCount then
        stats.sessionCount = numberOf(payload.totalSessions)
    end

    -- Recent sessions: the last few things read, with when, how long and on
    -- what. An entry without a title or a duration is dropped rather than drawn
    -- as a row of blanks.
    if type(payload.recentSessions) == "table" then
        local sessions = {}
        for session_index = 1, #payload.recentSessions do
            local session = payload.recentSessions[session_index]
            if type(session) == "table" and type(session.title) == "string" then
                local duration = numberOf(session.durationSeconds)
                local started = numberOf(session.startTime)
                if duration and duration > 0 and started then
                    sessions[#sessions + 1] = {
                        title = session.title,
                        authors = type(session.authors) == "string" and session.authors or nil,
                        device = type(session.device) == "string" and session.device or nil,
                        startTime = started,
                        durationSeconds = duration,
                    }
                end
            end
        end
        if #sessions > 0 then stats.recentSessions = sessions end
    end

    if goal then
        local targetBooks = numberOf(goal.targetBooks)
        local targetHours = numberOf(goal.targetHours)
        if (targetBooks and targetBooks > 0) or (targetHours and targetHours > 0) then
            local currentBooks = numberOf(goal.currentBooks)
            local currentHours = numberOf(goal.currentHours)
            local booksPercent = numberOf(goal.booksPercent)
            local hoursPercent = numberOf(goal.hoursPercent)
            stats.goal = {
                year = numberOf(goal.year),
                targetBooks = targetBooks,
                targetHours = targetHours,
                currentBooks = currentBooks,
                currentHours = currentHours,
                -- Ratios feed Status.progressBar, the plugin's existing bar
                -- renderer, so the goal looks like every other progress row.
                booksRatio = Stats.goalRatio(booksPercent),
                hoursRatio = Stats.goalRatio(hoursPercent),
            }
        end
    end

    if type(payload.heatmap) == "table" then
        local days = {}
        for day_index = 1, #payload.heatmap do
            local day = payload.heatmap[day_index]
            -- The heatmap is a fixed grid of YYYY-MM-DD days; anything else is
            -- a payload this plugin cannot place, so it is dropped rather than
            -- drawn in the wrong column.
            if type(day) == "table" and type(day.date) == "string"
                and day.date:match("^%d%d%d%d%-%d%d%-%d%d$")
            then
                days[#days + 1] = {
                    date = day.date,
                    minutes = numberOf(day.minutes),
                    seconds = numberOf(day.seconds),
                    level = Stats.heatmapLevel(day),
                    count = numberOf(day.count),
                    bookCount = numberOf(day.bookCount),
                }
            end
        end
        if #days > 0 then stats.heatmap = days end
    end

    return stats
end

--- Clamps the server's goal percentage into a 0..1 ratio for the progress bar.
-- @number percent server percentage, 0..100
-- @treturn number|nil nil when the server sent no percentage
function Stats.goalRatio(percent)
    local value = numberOf(percent)
    if not value then return nil end
    local ratio = value / 100
    if ratio < 0 then return 0 end
    if ratio > 1 then return 1 end
    return ratio
end

--- Compact "5 days · best 12 days" streak summary.
-- The row's own label already says "Current streak", so this string is only
-- the value half of that row.
-- @tparam table streaks normalized streaks section
-- @treturn string|nil
function Stats.streakLabel(streaks)
    if type(streaks) ~= "table" then return nil end
    local current = streaks.current
    local best = streaks.best
    if not current and not best then return nil end

    local label
    if current then
        if current <= 0 then
            label = "No streak yet"
        else
            label = Stats.formatDays(current)
        end
    end
    if best and best > 0 then
        local best_label = string.format("best %s", Stats.formatDays(best))
        label = label and (label .. " · " .. best_label) or best_label
    end
    return label
end

--- "12/25" against a book target, or the bare "12 read" when the goal has
-- only an hours target. The view's row already carries the "Books" label, so
-- the value does not repeat it.
-- @tparam table goal normalized goal section
-- @treturn string|nil nil when the server did not send the count
function Stats.goalBooksLabel(goal)
    if type(goal) ~= "table" then return nil end
    local current = goal.currentBooks
    if not current then return nil end
    if goal.targetBooks then
        return string.format("%d/%d", round(current), round(goal.targetBooks))
    end
    return string.format("%d read", round(current))
end

--- "34h/100h" against an hours target, or "34h read" when the goal has only
-- a book target.
-- @tparam table goal normalized goal section
-- @treturn string|nil nil when the server did not send the count
function Stats.goalHoursLabel(goal)
    if type(goal) ~= "table" then return nil end
    local current_text = Stats.formatHours(goal.currentHours)
    if not current_text then return nil end
    if goal.targetHours then
        return string.format("%s/%s", current_text, Stats.formatHours(goal.targetHours))
    end
    return string.format("%s read", current_text)
end

--- Reading time for one heatmap day, e.g. "45m"; nil when unknown.
-- @tparam table day normalized heatmap day
-- @treturn string|nil
function Stats.dayDurationLabel(day)
    if type(day) ~= "table" then return nil end
    if day.minutes then return Stats.formatMinutes(day.minutes) end
    if day.seconds then return Stats.formatDuration(day.seconds) end
    return nil
end

--- Packs heatmap days into rows of at most seven, newest row last.
--
-- The picture is a fixed 26-week window: the newest day always ends the final
-- row, so "today" sits at the right edge instead of drifting with the calendar,
-- and older days beyond the window (and beyond the row boundary) are dropped
-- rather than shrunk.
-- @tparam table days normalized heatmap days, oldest first
-- @treturn table array of rows, each an array of days
function Stats.heatmapRows(days)
    local rows = {}
    if type(days) ~= "table" or #days == 0 then return rows end

    local first = #days - Stats.DEFAULT_HEATMAP_DAYS + 1
    if first < 1 then first = 1 end

    local last = #days
    while last >= first do
        local start = last - 6
        if start < first then start = first end
        local row = {}
        for day_index = start, last do
            row[#row + 1] = days[day_index]
        end
        table.insert(rows, 1, row)
        last = start - 1
    end
    return rows
end

--- Glyph string for one heatmap row, e.g. "·░▒▓█░░".
-- @tparam table row array of normalized days
-- @treturn string
function Stats.heatmapRowText(row)
    if type(row) ~= "table" then return "" end
    local cells = {}
    for day_index = 1, #row do
        cells[#cells + 1] = Stats.heatmapGlyph(row[day_index].level)
    end
    return table.concat(cells)
end

return Stats
