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

--- Minutes a day must reach to be drawn at each level.
-- The single definition of the ramp: `heatmapLevel` maps a day with it, so the
-- shades on the device can never describe a different picture from the web
-- app's. Same thresholds as `computeReadingHeatmap` in
-- uploader/reading-stats.ts.
Stats.LEVEL_MIN_MINUTES = { [0] = 0, [1] = 1, [2] = 15, [3] = 30, [4] = 60 }

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

--- Formats an hour count for reading time, e.g. "34h" or "34.5h".
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
        -- Only the year is drawn: the page has no goal section, and the year
        -- names the YEAR band.
        local year = numberOf(goal.year)
        if year then stats.goal = { year = year } end
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

return Stats
