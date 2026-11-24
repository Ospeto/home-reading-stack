--[[--
Persistent offline highlight sync queue for LightHouse.

Stores book file paths whose highlights could not be synced (for example while
reading in airplane mode or when the server was temporarily unreachable) inside
`G_reader_settings`, deduplicated and bounded so retries are safe and fast when
Wi-Fi reconnects.

@module koplugin.lighthouse_outbox
]]

local Outbox = {}

Outbox.SETTING_KEY = "lighthouse_highlight_outbox"
Outbox.MAX_ITEMS = 100

local function normalizeList(raw)
    if type(raw) ~= "table" then return {} end
    local out = {}
    local seen = {}
    for idx = 1, #raw do
        local item = raw[idx]
        if type(item) == "string" and item ~= "" and not seen[item] then
            seen[item] = true
            out[#out + 1] = item
        end
    end
    return out
end

--- Returns the deduplicated array of pending book paths.
-- @tparam table settings G_reader_settings-compatible store
-- @treturn table array of file paths
function Outbox.list(settings)
    if type(settings) ~= "table" or type(settings.readSetting) ~= "function" then
        return {}
    end
    return normalizeList(settings:readSetting(Outbox.SETTING_KEY))
end

--- Returns the number of queued books awaiting highlight sync.
-- @tparam table settings G_reader_settings-compatible store
-- @treturn number
function Outbox.count(settings)
    return #Outbox.list(settings)
end

--- Adds a book path to the offline sync queue without duplicates.
-- Drops the oldest entries if the queue exceeds `Outbox.MAX_ITEMS`.
-- @tparam table settings G_reader_settings-compatible store
-- @string book_path absolute book file path
-- @treturn boolean true when persisted
-- @treturn number current queue length
function Outbox.enqueue(settings, book_path)
    if type(settings) ~= "table" or type(settings.saveSetting) ~= "function" then
        return false, 0
    end
    if type(book_path) ~= "string" or book_path == "" then
        return false, Outbox.count(settings)
    end
    local items = Outbox.list(settings)
    for idx = 1, #items do
        if items[idx] == book_path then
            return true, #items
        end
    end
    items[#items + 1] = book_path
    while #items > Outbox.MAX_ITEMS do
        table.remove(items, 1)
    end
    settings:saveSetting(Outbox.SETTING_KEY, items)
    return true, #items
end

--- Removes a book path from the offline sync queue.
-- @tparam table settings G_reader_settings-compatible store
-- @string book_path absolute book file path
-- @treturn boolean true if the path was removed
-- @treturn number remaining queue length
function Outbox.remove(settings, book_path)
    if type(settings) ~= "table" or type(settings.saveSetting) ~= "function" then
        return false, 0
    end
    local items = Outbox.list(settings)
    if type(book_path) ~= "string" or book_path == "" then
        return false, #items
    end
    local next_items = {}
    local removed = false
    for idx = 1, #items do
        if items[idx] == book_path then
            removed = true
        else
            next_items[#next_items + 1] = items[idx]
        end
    end
    if removed then
        settings:saveSetting(Outbox.SETTING_KEY, next_items)
    end
    return removed, #next_items
end

--- Clears the entire offline highlight sync queue.
-- @tparam table settings G_reader_settings-compatible store
-- @treturn boolean
function Outbox.clear(settings)
    if type(settings) ~= "table" or type(settings.saveSetting) ~= "function" then
        return false
    end
    settings:saveSetting(Outbox.SETTING_KEY, {})
    return true
end

return Outbox
