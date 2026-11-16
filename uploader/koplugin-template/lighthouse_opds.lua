--[[--
Minimal, dependency-free OPDS 1.2 (Atom) parser for the LightHouse plugin.

KOReader ships a luxl-based Atom parser (`plugins/opds.koplugin/opdsparser.lua`)
that is bound to the built-in OPDS browser internals via ffi. A generated
external plugin cannot rely on that module's internal shape, so this parser
implements the small Atom subset the LightHouse feed actually emits and stays
pure Lua: no ffi, no sockets, no KOReader UI modules. That keeps it runnable
(and unit-testable) outside a device.

Parsed feed shape:

    {
        title       = "LightHouse OPDS Catalog",
        updated     = "2026-11-14T12:54:05.980Z",
        next_href   = "http://host/api/opds?start=40&count=40" | nil,
        search_href = "http://host/api/opds?search={searchTerms}" | nil,
        start_href  = "http://host/opds" | nil,
        links       = { { rel = ..., href = ..., type = ... }, ... },
        entries     = {
            {
                id          = "urn:calibre:book:553",
                book_id     = 553,
                title       = "Chapterhouse: Dune",
                authors     = "Frank Herbert",
                summary     = "plain text synopsis",
                content     = "html synopsis",
                published   = "2020-07-06T00:00:00.000Z",
                series      = "Dune" | nil,
                series_index = 6 | nil,
                tags        = { "Science Fiction", ... },
                categories  = { { term = ..., label = ... }, ... },
                rating      = 8 | nil,       -- Calibre scale 0..10 (lighthouse:rating)
                cover_href  = "http://host/api/books/553/cover",
                thumbnail_href = "http://host/api/books/553/cover?w=360",
                download_href  = "http://host/api/books/553/download/epub",
                download_type  = "application/epub+zip",
            },
            ...
        },
    }
]]

local OPDS = {}

local entity_map = {
    lt = "<",
    gt = ">",
    amp = "&",
    quot = '"',
    apos = "'",
}

--- Encodes a Unicode code point as UTF-8.
-- @int cp code point
-- @treturn string UTF-8 bytes (empty string when the code point is invalid)
local function codepointToUtf8(cp)
    if not cp or cp < 0 or cp > 0x10FFFF then return "" end
    if cp < 0x80 then
        return string.char(cp)
    elseif cp < 0x800 then
        return string.char(
            0xC0 + math.floor(cp / 0x40),
            0x80 + cp % 0x40
        )
    elseif cp < 0x10000 then
        return string.char(
            0xE0 + math.floor(cp / 0x1000),
            0x80 + math.floor(cp / 0x40) % 0x40,
            0x80 + cp % 0x40
        )
    end
    return string.char(
        0xF0 + math.floor(cp / 0x40000),
        0x80 + math.floor(cp / 0x1000) % 0x40,
        0x80 + math.floor(cp / 0x40) % 0x40,
        0x80 + cp % 0x40
    )
end

--- Expands XML entities (named and numeric) in text content or attribute values.
-- @string str
-- @treturn string
function OPDS.unescape(str)
    if type(str) ~= "string" or str == "" then return "" end
    return (str:gsub("&(#?)([%w]+);", function(hash, name)
        if hash == "#" then
            local cp
            if name:sub(1, 1):lower() == "x" then
                cp = tonumber(name:sub(2), 16)
            else
                cp = tonumber(name, 10)
            end
            return codepointToUtf8(cp)
        end
        return entity_map[name] or ("&" .. name .. ";")
    end))
end

--- Collapses runs of whitespace (including newlines) into single spaces.
-- @string str
-- @treturn string
function OPDS.collapse(str)
    if type(str) ~= "string" then return "" end
    str = str:gsub("%s+", " ")
    str = str:gsub("^%s+", "")
    return (str:gsub("%s+$", ""))
end

--- Parses the attribute set of a single tag into a key/value table.
-- XML allows both double- and single-quoted attribute values (Lua patterns
-- have no backreferences, so the two shapes are matched in separate passes).
-- @string attrs raw attribute text (everything between the tag name and ">")
-- @treturn table
local function parseAttrs(attrs)
    local parsed = {}
    if type(attrs) ~= "string" or attrs == "" then return parsed end
    for name, value in attrs:gmatch("([%w:_%-%.]+)%s*=%s*\"([^\"]*)\"") do
        parsed[name] = OPDS.unescape(value)
    end
    for name, value in attrs:gmatch("([%w:_%-%.]+)%s*=%s*'([^']*)'") do
        if parsed[name] == nil then
            parsed[name] = OPDS.unescape(value)
        end
    end
    return parsed
end

--- Collects every author name in one entry, in document order.
-- Real OPDS feeds carry one <author> element per contributor, and some carry a
-- single <name> at entry level; both shapes are handled without losing names.
-- @string block entry XML
-- @treturn string authors joined with ", " (empty string when absent)
local function parseAuthors(block)
    local names, seen = {}, {}

    local function add(raw)
        if type(raw) ~= "string" then return end
        local name = OPDS.collapse(OPDS.unescape(raw))
        if name == "" or seen[name] then return end
        seen[name] = true
        names[#names + 1] = name
    end

    for author_block in block:gmatch("<author[^>]*>(.-)</author>") do
        for name in author_block:gmatch("<name[^>]*>(.-)</name>") do
            add(name)
        end
        -- dc:creator is the other common shape when <author> is self-closing.
        for creator in author_block:gmatch("<dc:creator[^>]*>(.-)</dc:creator>") do
            add(creator)
        end
    end
    -- Entry-level contributors, in case the feed skips <author> entirely.
    for creator in block:gmatch("<dc:creator[^>]*>(.-)</dc:creator>") do
        add(creator)
    end
    if #names == 0 then
        -- Last resort: bare <name> elements directly inside the entry.
        for name in block:gmatch("<name[^>]*>(.-)</name>") do
            add(name)
        end
    end

    return table.concat(names, ", ")
end

--- Extracts the Calibre book id from a LightHouse/Calibre Atom entry id.
-- @string id e.g. "urn:calibre:book:553"
-- @treturn int|nil
function OPDS.bookId(id)
    if type(id) ~= "string" then return nil end
    local n = id:match("^urn:calibre:book:(%d+)$")
        or id:match("^urn:lighthouse:book:(%d+)$")
    return n and tonumber(n) or nil
end

--- Parses one <entry>…</entry> block.
-- @string block
-- @treturn table entry
local function parseEntry(block)
    local entry = {
        links = {},
        categories = {},
        tags = {},
    }

    entry.id = OPDS.collapse(OPDS.unescape(block:match("<id[^>]*>(.-)</id>") or ""))
    entry.title = OPDS.collapse(OPDS.unescape(block:match("<title[^>]*>(.-)</title>") or ""))
    entry.authors = parseAuthors(block)
    entry.summary = OPDS.collapse(OPDS.unescape(block:match("<summary[^>]*>(.-)</summary>") or ""))
    entry.published = OPDS.collapse(OPDS.unescape(block:match("<published[^>]*>(.-)</published>") or ""))

    local raw_content = block:match("<content[^>]*>(.-)</content>")
    if raw_content then
        entry.content = OPDS.collapse(OPDS.unescape(raw_content))
    end

    local raw_rating = block:match("<lighthouse:rating[^>]*>([%d%.]+)<")
    if raw_rating then
        entry.rating = tonumber(raw_rating)
    end

    for attrs in block:gmatch("<link%s+([^>]-)/?>") do
        entry.links[#entry.links + 1] = parseAttrs(attrs)
    end
    for attrs in block:gmatch("<category%s+([^>]-)/?>") do
        entry.categories[#entry.categories + 1] = parseAttrs(attrs)
    end

    for category_index = 1, #entry.categories do
        local category = entry.categories[category_index]
        local term = category.term
        if term and term ~= "" then
            local volume = category.label and category.label:match("^Volume%s+([%d%.]+)$")
            if volume and not entry.series then
                entry.series = term
                entry.series_index = tonumber(volume)
            else
                entry.tags[#entry.tags + 1] = term
            end
        end
    end

    for link_index = 1, #entry.links do
        local link = entry.links[link_index]
        local rel = link.rel or ""
        if rel == "http://opds-spec.org/acquisition" and not entry.download_href then
            entry.download_href = link.href
            entry.download_type = link.type
        elseif rel == "http://opds-spec.org/image/thumbnail" and not entry.thumbnail_href then
            entry.thumbnail_href = link.href
        elseif rel == "http://opds-spec.org/image" and not entry.cover_href then
            entry.cover_href = link.href
        end
    end

    entry.book_id = OPDS.bookId(entry.id)
    return entry
end

--- Parses an OPDS/Atom acquisition or navigation feed.
-- @string xml raw feed text
-- @treturn table feed (never nil; an empty entry list when the input is unusable)
function OPDS.parse(xml)
    local feed = {
        entries = {},
        links = {},
        title = "",
        updated = "",
    }
    if type(xml) ~= "string" or xml == "" then
        return feed
    end

    local text = xml:gsub("<!%[CDATA%[(.-)%]%]>", "%1")

    local first_entry = text:find("<entry", 1, true)
    local head = first_entry and text:sub(1, first_entry - 1) or text
    local body = first_entry and text:sub(first_entry) or ""

    feed.title = OPDS.collapse(OPDS.unescape(head:match("<title[^>]*>(.-)</title>") or ""))
    feed.updated = OPDS.collapse(OPDS.unescape(head:match("<updated[^>]*>(.-)</updated>") or ""))

    -- How many books the whole match holds, not just this page. The library's
    -- sub-line names the shelf size, and the feed is the only place that knows
    -- it without a second request.
    local total_text = head:match("<lighthouse:total[^>]*>(%d+)</lighthouse:total>")
    if total_text then
        local total = tonumber(total_text)
        if total and total >= 0 then feed.total = total end
    end

    for attrs in head:gmatch("<link%s+([^>]-)/?>") do
        local link = parseAttrs(attrs)
        feed.links[#feed.links + 1] = link
        if link.rel == "next" and link.href then
            feed.next_href = link.href
        elseif link.rel == "search" and link.href then
            feed.search_href = link.href
        elseif link.rel == "start" and link.href then
            feed.start_href = link.href
        end
    end

    -- Drop any attributes on <entry> so the block pattern stays simple.
    body = (body:gsub("<entry%s+[^>]->", "<entry>"))
    for block in body:gmatch("<entry>(.-)</entry>") do
        feed.entries[#feed.entries + 1] = parseEntry(block)
    end

    -- A feed cut off mid-transfer (dropped Wi-Fi, truncated response) still
    -- carries usable entries; keep the ones that closed and salvage a trailing
    -- open entry instead of showing an empty catalog.
    if #feed.entries == 0 then
        local trailing = body:match("<entry>(.+)$")
        if trailing then
            feed.entries[1] = parseEntry(trailing)
        end
    end

    return feed
end

return OPDS
