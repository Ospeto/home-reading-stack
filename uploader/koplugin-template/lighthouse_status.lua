--[[--
Reading-status merge logic for the LightHouse plugin.

Progress is produced by KOReader's own progress sync (KOSync) and stored
server-side in `koreader-sync.db`. The LightHouse server already resolves each
session against the Calibre library and exposes it at `GET /api/kosync/active`,
so the device only has to match those sessions back to catalog entries. Doing
that merge here (pure Lua, no sockets, no UI) keeps it testable off-device.

A session record as emitted by /api/kosync/active (fields used here):

    {
        document   = "d6df0b1e0c6dec84dd52e6616fa669d8",  -- KOReader partial md5
        percentage = 0.0284,                              -- 0..1 ratio
        timestamp  = 1794633720,                          -- unix seconds
        title      = "Spice and Wolf, Vol. 1",
        authors    = "Isuna Hasekura\nJyuu Ayakura",
        bookId     = 3548 | null,                         -- resolved Calibre id
        device     = "Paperwhite",
        filename   = "01 - Spice and Wolf, Vol. 1.epub",
    }
]]

local Status = {}

--- THE string guard: the only way an untrusted value becomes text.
--
-- Everything the plugin did not build itself - a field of
-- `GET /api/kosync/active`, an OPDS entry, a sidecar value - is untrusted until
-- it has passed through here. Two facts make this mandatory rather than tidy:
--
--   1. KOReader's `T()` (ffi/util `template`) substitutes a placeholder by
--      yielding the argument to `string.gsub`, and a value that is not a
--      string/number makes gsub itself raise - on the device,
--      `./luajit: ./ffi/util.lua:779: invalid replacement value (a function)` -
--      which kills the process; there is no pcall between a menu callback and
--      the top level. (The exact body of `template` is inferred from that
--      traceback: KOReader's frontend source is not available to this repo.)
--   2. A missing JSON field is NOT nil in this plugin's hands: the decoder maps
--      `null` to a truthy callable sentinel, so the familiar guards
--      `if value and value ~= ""` are TRUE for a null field and let it through.
--
-- Contract (assert these, and no screen can be reached with a non-string):
--
--   * string                        -> returned unchanged (empty stays empty)
--   * number                        -> formatted with `tostring`
--   * NaN / infinity                -> the fallback
--   * nil, boolean, table, function, userdata, thread, sentinel -> fallback
--   * the return value is ALWAYS a string; it is never nil
--
-- Numbers are formatted rather than dropped because several call sites
-- interpolate a real number (a Calibre series index, a page number); the
-- fallback exists so a caller can name the reader-facing substitute
-- (`_("Unknown")`) instead of an empty string in one step.
-- @param value untrusted value of any type
-- @string[opt] fallback text for anything unusable (default "")
-- @treturn string never nil
function Status.str(value, fallback)
    if type(value) == "string" then return value end
    if type(value) == "number" then
        -- NaN and the infinities have no reader-facing spelling, so they take
        -- the fallback.
        if value ~= value or value == math.huge or value == -math.huge then
            return fallback or ""
        end
        return tostring(value)
    end
    return fallback or ""
end

--- THE number guard, the `Status.str` counterpart for counts and ratios.
-- Untrusted values become a finite number or nil - never a boolean, a table, a
-- callable sentinel or NaN - so arithmetic and `%d` formatting downstream stay
-- safe.
-- @param value untrusted value of any type
-- @treturn number|nil finite number, or nil for anything unusable
function Status.num(value)
    local parsed
    if type(value) == "number" then
        parsed = value
    elseif type(value) == "string" then
        parsed = tonumber(value)
    else
        return nil
    end
    if not parsed or parsed ~= parsed then return nil end -- nil or NaN
    if parsed == math.huge or parsed == -math.huge then return nil end
    return parsed
end

--- Normalizes free text for tolerant comparison.
-- Lowercases, turns punctuation into spaces, and collapses whitespace so that
-- "Spice and Wolf, Vol. 1" matches "spice and wolf vol 1".
-- @string str
-- @treturn string
function Status.normalize(str)
    if type(str) ~= "string" then return "" end
    str = str:lower()
    str = str:gsub("&amp;", "and")
    str = str:gsub("&", "and")
    str = str:gsub("&apos;", "'")
    str = str:gsub("[%p%c]", " ")
    str = str:gsub("^%s+", "")
    return (str:gsub("%s+", " "))
end

--- Splits a KOSync authors string into a normalized list.
-- @string authors newline or comma separated authors
-- @treturn table array of normalized author names
function Status.authorList(authors)
    local list = {}
    if type(authors) ~= "string" then return list end
    for chunk in authors:gmatch("[^\n,;]+") do
        local normalized = Status.normalize(chunk)
        if normalized ~= "" then
            list[#list + 1] = normalized
        end
    end
    return list
end

--- Returns true when at least one author name is shared between the two lists.
-- @tparam table left normalized author list
-- @tparam table right normalized author list
-- @treturn boolean
local function sharesAuthor(left, right)
    for left_index = 1, #left do
        for right_index = 1, #right do
            if left[left_index] == right[right_index] then return true end
        end
    end
    return false
end

--- Clamps a raw KOSync percentage (ratio or percentage) into a 0..1 ratio.
-- @param value number
-- @treturn number
function Status.clampPercentage(value)
    local pct = tonumber(value) or 0
    if pct > 1 then pct = pct / 100 end
    if pct < 0 then pct = 0 end
    if pct > 1 then pct = 1 end
    return pct
end

--- Normalizes one /api/kosync/active record.
-- @tparam table session raw record
-- @treturn table|nil normalized session
function Status.normalizeSession(session)
    if type(session) ~= "table" then return nil end

    -- Every field is coerced HERE, once, at the boundary where the untrusted
    -- payload becomes a session. A sentinel or a table can therefore never
    -- reach the shelf, the row builder or `T()`: by the time this returns, the
    -- text fields are strings and the numeric ones are finite numbers or nil.
    local title = Status.str(session.displayTitle)
    if title == "" then title = Status.str(session.title) end
    local authors = Status.str(session.displayAuthors)
    if authors == "" then authors = Status.str(session.authors) end
    local filename = Status.str(session.filename)

    local book_id = Status.num(session.bookId)
    if not book_id then book_id = Status.num(session.book_id) end
    if book_id then book_id = math.floor(book_id) end

    local normalized = {
        document = Status.str(session.document),
        filename = filename,
        device = Status.str(session.device),
        timestamp = Status.num(session.timestamp) or 0,
        percentage = Status.clampPercentage(Status.num(session.percentage)),
        book_id = book_id,
        title = title,
        authors = authors,
        normalized_title = Status.normalize(title),
        normalized_authors = Status.authorList(authors),
        normalized_filename = Status.normalize(filename),
    }
    return normalized
end

--- Normalizes a whole /api/kosync/active payload.
-- @tparam table sessions array of raw records
-- @treturn table array of normalized sessions, newest first
function Status.normalizeSessions(sessions)
    local list = {}
    if type(sessions) ~= "table" then return list end
    for session_index = 1, #sessions do
        local normalized = Status.normalizeSession(sessions[session_index])
        if normalized then list[#list + 1] = normalized end
    end
    table.sort(list, function(a, b) return a.timestamp > b.timestamp end)
    return list
end

--- Builds a lookup index keyed by Calibre book id.
-- When several devices have synced the same book, the newest session wins.
-- This is the only place the book-id index is built. Scanning the session list
-- costs O(sessions), so `Status.merge` builds it once for the whole page and
-- passes it to `Status.findSession` instead of letting every entry rebuild it.
-- @tparam table sessions normalized sessions
-- @treturn table map book_id -> session
function Status.indexByBookId(sessions)
    local index = {}
    for session_index = 1, #(sessions or {}) do
        local session = sessions[session_index]
        -- Coerced, because an index key must be a number and the comparison
        -- must never see a sentinel: `session.timestamp > current` on a
        -- callable would raise and take the page with it.
        local book_id = Status.num(session.book_id)
        local timestamp = Status.num(session.timestamp) or 0
        if book_id then
            local current = index[book_id]
            if not current or timestamp > (Status.num(current.timestamp) or 0) then
                index[book_id] = session
            end
        end
    end
    return index
end

--- Finds the best matching session for a catalog entry.
-- Match precedence: resolved Calibre id, then filename, then title (+ author
-- overlap when both sides expose authors).
-- The book-id index is required for that first precedence rule only; pass a
-- prebuilt one (from `Status.indexByBookId`) when matching several entries
-- against the same session list, otherwise it is rebuilt for this call.
-- @tparam table entry OPDS entry (needs title, authors, book_id, download_href)
-- @tparam table sessions normalized sessions
-- @tparam[opt] table index result of `Status.indexByBookId(sessions)`
-- @treturn table|nil best session
function Status.findSession(entry, sessions, index)
    if type(entry) ~= "table" or type(sessions) ~= "table" then return nil end

    local entry_book_id = Status.num(entry.book_id)
    if entry_book_id then
        local by_id = (index or Status.indexByBookId(sessions))[entry_book_id]
        if by_id then return by_id end
    end

    local entry_title = Status.normalize(entry.title)
    local entry_authors = Status.authorList(entry.authors)
    local best
    for session_index = 1, #sessions do
        local session = sessions[session_index]
        -- A caller may hand in sessions it did not normalize, so every field
        -- read here is coerced rather than trusted.
        local session_title = Status.str(session.normalized_title)
        local session_filename = Status.str(session.normalized_filename)
        local session_timestamp = Status.num(session.timestamp) or 0
        local session_authors = type(session.normalized_authors) == "table"
            and session.normalized_authors or {}
        local matched = false
        if entry_title ~= "" then
            if session_filename == entry_title
                or session_filename == entry_title .. " epub"
                or session_title == entry_title then
                matched = true
            end
        end
        if not matched and entry_title ~= "" and session_title ~= "" then
            -- Tolerate "01 - Title" / "Title (Author)" style filename prefixes.
            if session_title:find(entry_title, 1, true)
                or entry_title:find(session_title, 1, true)
            then
                if #entry_authors == 0
                    or #session_authors == 0
                    or sharesAuthor(entry_authors, session_authors)
                then
                    matched = true
                end
            end
        end
        if matched and (not best or session_timestamp > (Status.num(best.timestamp) or 0)) then
            best = session
        end
    end
    return best
end

--- Annotates OPDS entries with their reading session.
-- The book-id index is built once here, for the whole page, and shared by
-- every entry: a page of N entries costs one session scan instead of N.
-- @tparam table entries OPDS entries
-- @tparam table sessions normalized sessions
-- @treturn table the same entries, each with an optional `.status` session
function Status.merge(entries, sessions)
    local by_id = Status.indexByBookId(sessions)
    for entry_index = 1, #(entries or {}) do
        local entry = entries[entry_index]
        entry.status = Status.findSession(entry, sessions, by_id)
    end
    return entries
end

--- Renders a compact progress bar, e.g. "████░░░░ 45%".
-- @number percentage 0..1 ratio
-- @int slots number of blocks (default 8)
-- @treturn string
function Status.progressBar(percentage, slots)
    slots = slots or 8
    local ratio = Status.clampPercentage(percentage)
    local filled = math.floor(ratio * slots + 0.5)
    if filled > slots then filled = slots end
    if filled < 0 then filled = 0 end
    return string.rep("█", filled)
        .. string.rep("░", slots - filled)
        .. string.format(" %d%%", math.floor(ratio * 100 + 0.5))
end

--- Human readable reading status for one catalog entry.
-- @tparam table entry OPDS entry
-- @treturn string e.g. "████░░░░ 45% · Paperwhite", or "Unread"
function Status.statusLabel(entry)
    -- `entry.status` is a table or nothing: a sentinel or a table-shaped
    -- impostor must not be indexed below.
    if type(entry) ~= "table" or type(entry.status) ~= "table" then
        return "Unread"
    end
    local session = entry.status
    local percentage = Status.clampPercentage(Status.num(session.percentage))
    local label = Status.progressBar(percentage)
    if percentage >= 0.99 then
        label = label .. " · Finished"
    elseif percentage <= 0 then
        label = label .. " · Opened"
    end
    -- `..` on a non-string raises just as hard as gsub does, so the device
    -- name is coerced before it is concatenated: an entry annotated by
    -- `Status.merge` may have been built by a caller that never normalized it.
    local device = Status.str(session.device)
    if device ~= "" then
        label = label .. " · " .. device
    end
    return label
end

--- Renders a Calibre rating (0..10 scale) as a 5-star label.
-- @number rating Calibre rating, may be nil
-- @treturn string e.g. "4.0 / 5", or "Not rated"
function Status.ratingLabel(rating)
    local value = tonumber(rating)
    if not value or value <= 0 then return "Not rated" end
    if value > 10 then value = 10 end
    return string.format("%.1f / 5", value / 2)
end

--- Renders five star glyphs for a Calibre rating.
-- Grounds on the nearest whole star (Calibre's 0–10 scale maps to halves) and
-- sticks to ★/☆ so any device font can render it.
-- @number rating Calibre rating, may be nil
-- @treturn string e.g. "★★★★☆"
function Status.ratingStars(rating)
    local value = tonumber(rating)
    if not value or value <= 0 then return "☆☆☆☆☆" end
    if value > 10 then value = 10 end
    local full = math.floor(value / 2 + 0.5)
    if full > 5 then full = 5 end
    return string.rep("★", full) .. string.rep("☆", 5 - full)
end


--- Normalizes the library's author/series groupings.
--
-- One grouping row is `{ name, author, books, read, coverId }`; the device only
-- ever formats these, so every field is coerced here once and a row without a
-- usable name is dropped rather than drawn as a blank line.
-- @tparam table groups array of raw grouping rows
-- @treturn table array of normalized rows, order preserved
function Status.normalizeGroups(groups)
    local list = {}
    if type(groups) ~= "table" then return list end
    for group_index = 1, #groups do
        local group = groups[group_index]
        if type(group) == "table" then
            local name = Status.str(group.name)
            if name ~= "" then
                list[#list + 1] = {
                    name = name,
                    author = Status.str(group.author),
                    books = Status.num(group.books),
                    read = Status.num(group.read),
                    coverId = Status.num(group.coverId),
                }
            end
        end
    end
    return list
end

return Status
