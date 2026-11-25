--[[--
Persistent "Download Later" reading queue basket for LightHouse.

Stores queued catalog entries inside `G_reader_settings` as compact normalized
records, deduplicated by Calibre book id or download URL and capped at
`Queue.MAX_ITEMS`, so readers can collect books while browsing and download the
batch in one tap.

@module koplugin.lighthouse_queue
]]

local Status = require("lighthouse_status")

local Queue = {}

Queue.SETTING_KEY = "lighthouse_download_queue"
Queue.MAX_ITEMS = 100

local function trim(value)
    local str = Status.str(value)
    str = str:gsub("^%s+", ""):gsub("%s+$", "")
    return str
end

--- Computes the stable deduplication key for a catalog entry or raw key string.
-- Uses `"id:<book_id>"` when a numeric Calibre book id is present, falling back
-- to the trimmed `download_href` or `key`.
-- @tparam table|string entry catalog entry or key string
-- @treturn string|nil deduplication key
function Queue.entryKey(entry)
    if type(entry) == "string" then
        local clean = trim(entry)
        return clean ~= "" and clean or nil
    end
    if type(entry) ~= "table" then return nil end
    local book_id = Status.num(entry.book_id)
    if book_id then
        return "id:" .. tostring(math.floor(book_id))
    end
    local href = trim(entry.download_href)
    if href ~= "" then
        return href
    end
    local raw_key = trim(entry.key)
    if raw_key ~= "" then
        return raw_key
    end
    return nil
end

local function normalizeEntry(raw)
    if type(raw) ~= "table" then return nil end
    local key = Queue.entryKey(raw)
    if not key then return nil end
    local book_id = Status.num(raw.book_id)
    local href = trim(raw.download_href)
    local series_index = Status.num(raw.series_index)
    return {
        key = key,
        book_id = book_id and math.floor(book_id) or nil,
        title = trim(raw.title),
        authors = trim(raw.authors),
        series = trim(raw.series),
        series_index = series_index,
        download_href = href ~= "" and href or nil,
    }
end

local function normalizeList(raw)
    if type(raw) ~= "table" then return {} end
    local out = {}
    local seen = {}
    for idx = 1, #raw do
        local item = normalizeEntry(raw[idx])
        if item and not seen[item.key] then
            seen[item.key] = true
            out[#out + 1] = item
        end
    end
    return out
end

--- Returns the deduplicated array of queued books.
-- @tparam table settings G_reader_settings-compatible store
-- @treturn table array of normalized queue entries
function Queue.list(settings)
    if type(settings) ~= "table" or type(settings.readSetting) ~= "function" then
        return {}
    end
    return normalizeList(settings:readSetting(Queue.SETTING_KEY))
end

--- Returns the number of books currently in the download queue.
-- @tparam table settings G_reader_settings-compatible store
-- @treturn number
function Queue.count(settings)
    return #Queue.list(settings)
end

--- Returns true when `entry_or_key` is already in the download queue.
-- @tparam table settings G_reader_settings-compatible store
-- @tparam table|string entry_or_key catalog entry or key
-- @treturn boolean
function Queue.has(settings, entry_or_key)
    local key = Queue.entryKey(entry_or_key)
    if not key then return false end
    local items = Queue.list(settings)
    for idx = 1, #items do
        if items[idx].key == key then
            return true
        end
    end
    return false
end

--- Adds a book to the download queue without duplicates.
-- Drops the oldest entries when the queue exceeds `Queue.MAX_ITEMS`.
-- @tparam table settings G_reader_settings-compatible store
-- @tparam table entry catalog entry
-- @treturn boolean true when newly added (false when invalid or already present)
-- @treturn number current queue length
function Queue.add(settings, entry)
    if type(settings) ~= "table" or type(settings.saveSetting) ~= "function" then
        return false, 0
    end
    local item = normalizeEntry(entry)
    local items = Queue.list(settings)
    if not item then
        return false, #items
    end
    for idx = 1, #items do
        if items[idx].key == item.key then
            return false, #items
        end
    end
    items[#items + 1] = item
    while #items > Queue.MAX_ITEMS do
        table.remove(items, 1)
    end
    settings:saveSetting(Queue.SETTING_KEY, items)
    return true, #items
end

--- Removes a single book from the download queue.
-- @tparam table settings G_reader_settings-compatible store
-- @tparam table|string entry_or_key catalog entry or key
-- @treturn boolean true when removed
-- @treturn number remaining queue length
function Queue.remove(settings, entry_or_key)
    if type(settings) ~= "table" or type(settings.saveSetting) ~= "function" then
        return false, 0
    end
    local items = Queue.list(settings)
    local key = Queue.entryKey(entry_or_key)
    if not key then
        return false, #items
    end
    local next_items = {}
    local removed = false
    for idx = 1, #items do
        if items[idx].key == key then
            removed = true
        else
            next_items[#next_items + 1] = items[idx]
        end
    end
    if removed then
        settings:saveSetting(Queue.SETTING_KEY, next_items)
    end
    return removed, #next_items
end

--- Toggles membership of `entry` in the download queue.
-- @tparam table settings G_reader_settings-compatible store
-- @tparam table entry catalog entry
-- @treturn boolean true when now queued, false when removed or invalid
-- @treturn number current queue length
function Queue.toggle(settings, entry)
    if Queue.has(settings, entry) then
        local _, remaining = Queue.remove(settings, entry)
        return false, remaining
    end
    local added, count = Queue.add(settings, entry)
    return added, count
end

--- Removes multiple keys from the download queue in one write.
-- @tparam table settings G_reader_settings-compatible store
-- @tparam table keys_set map of `{ [key] = true }` or array of key strings
-- @treturn number removed count
-- @treturn number remaining queue length
function Queue.removeMany(settings, keys_set)
    if type(settings) ~= "table" or type(settings.saveSetting) ~= "function" then
        return 0, 0
    end
    local items = Queue.list(settings)
    if type(keys_set) ~= "table" then
        return 0, #items
    end
    local lookup = {}
    for k, v in pairs(keys_set) do
        if type(k) == "string" and v == true then
            lookup[k] = true
        elseif type(k) == "number" and type(v) == "string" and v ~= "" then
            lookup[v] = true
        end
    end
    local next_items = {}
    local removed = 0
    for idx = 1, #items do
        if lookup[items[idx].key] then
            removed = removed + 1
        else
            next_items[#next_items + 1] = items[idx]
        end
    end
    if removed > 0 then
        settings:saveSetting(Queue.SETTING_KEY, next_items)
    end
    return removed, #next_items
end

--- Clears the entire download queue.
-- @tparam table settings G_reader_settings-compatible store
-- @treturn boolean
function Queue.clear(settings)
    if type(settings) ~= "table" or type(settings.saveSetting) ~= "function" then
        return false
    end
    settings:saveSetting(Queue.SETTING_KEY, {})
    return true
end

return Queue
