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
    for leftIndex, leftAuthor in ipairs(left) do
        for rightIndex, rightAuthor in ipairs(right) do
            if leftAuthor == rightAuthor then return true end
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
    local title = session.displayTitle or session.title or ""
    local authors = session.displayAuthors or session.authors or ""
    local normalized = {
        document = session.document,
        filename = session.filename,
        device = session.device,
        timestamp = tonumber(session.timestamp) or 0,
        percentage = Status.clampPercentage(session.percentage),
        book_id = tonumber(session.bookId) or tonumber(session.book_id),
        title = title,
        authors = authors,
        normalized_title = Status.normalize(title),
        normalized_authors = Status.authorList(authors),
        normalized_filename = Status.normalize(session.filename or ""),
    }
    return normalized
end

--- Normalizes a whole /api/kosync/active payload.
-- @tparam table sessions array of raw records
-- @treturn table array of normalized sessions, newest first
function Status.normalizeSessions(sessions)
    local list = {}
    if type(sessions) ~= "table" then return list end
    for sessionIndex, session in ipairs(sessions) do
        local normalized = Status.normalizeSession(session)
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
    for sessionIndex, session in ipairs(sessions or {}) do
        if session.book_id then
            local current = index[session.book_id]
            if not current or session.timestamp > current.timestamp then
                index[session.book_id] = session
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

    if entry.book_id then
        local by_id = (index or Status.indexByBookId(sessions))[entry.book_id]
        if by_id then return by_id end
    end

    local entry_title = Status.normalize(entry.title)
    local entry_authors = Status.authorList(entry.authors)
    local best
    for sessionIndex, session in ipairs(sessions) do
        local matched = false
        if entry_title ~= "" then
            if session.normalized_filename == entry_title
                or session.normalized_filename == entry_title .. " epub"
                or session.normalized_title == entry_title then
                matched = true
            end
        end
        if not matched and entry_title ~= "" and session.normalized_title ~= "" then
            -- Tolerate "01 - Title" / "Title (Author)" style filename prefixes.
            if session.normalized_title:find(entry_title, 1, true)
                or entry_title:find(session.normalized_title, 1, true)
            then
                if #entry_authors == 0
                    or #session.normalized_authors == 0
                    or sharesAuthor(entry_authors, session.normalized_authors)
                then
                    matched = true
                end
            end
        end
        if matched and (not best or session.timestamp > best.timestamp) then
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
    for entryIndex, entry in ipairs(entries or {}) do
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
    if type(entry) ~= "table" or not entry.status then
        return "Unread"
    end
    local session = entry.status
    local label = Status.progressBar(session.percentage)
    if session.percentage >= 0.99 then
        label = label .. " · Finished"
    elseif session.percentage <= 0 then
        label = label .. " · Opened"
    end
    if session.device and session.device ~= "" then
        label = label .. " · " .. session.device
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

return Status
