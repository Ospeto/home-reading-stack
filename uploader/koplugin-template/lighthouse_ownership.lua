--[[--
Ownership ledger for books already on this device, keyed by Calibre book id.

Presence used to be decided only by a filename derived from live metadata
(`buildFilename`): correcting a series index in Calibre, respelling an author,
or side-loading a book under another name changed the derived name, so the
plugin reported the volume as missing and offered a duplicate download — and a
stale file that happened to match the derived name looked owned even when it
was a different edition. The OPDS feed already carries the Calibre book id and
that id survives every metadata edit, so the id is the durable key and the path
is only where the file currently sits.

Entries are stored newest-last and capped, like the download queue, so an old
entry is dropped first when the ledger fills up. A recorded path is only
trusted while the file it names is still readable; a stale entry is pruned the
first time it is consulted.

@module koplugin.lighthouse_ownership
]]

local Status = require("lighthouse_status")

local Ownership = {}

Ownership.SETTING_KEY = "lighthouse_owned_books"
Ownership.MAX_ENTRIES = 500

local function trim(value)
    local text = Status.str(value)
    return (text:gsub("^%s+", ""):gsub("%s+$", ""))
end

--- The durable ownership key for an entry, or nil when it carries no book id.
-- Entries without an id (a side-loaded local book, an older feed) keep the
-- filename behaviour the caller falls back to on its own.
-- @tparam table|number|string entry catalog entry, session, or raw book id
-- @treturn string|nil `"id:<n>"`
function Ownership.key(entry)
    local book_id
    if type(entry) == "table" then
        book_id = Status.num(entry.book_id)
    else
        book_id = Status.num(entry)
    end
    if not book_id then return nil end
    return "id:" .. tostring(math.floor(book_id))
end

--- Reads the ledger as a list of `{ id, path }` records, newest last.
-- Only well-formed records survive a read: a hand-edited or half-written
-- setting must mean "nothing owned", never a raised error on screen.
-- @tparam table settings `G_reader_settings`
-- @treturn table array of `{ id = string, path = string }`
function Ownership.load(settings)
    local records = {}
    if type(settings) ~= "table" or type(settings.readSetting) ~= "function" then
        return records
    end
    local raw = settings:readSetting(Ownership.SETTING_KEY)
    if type(raw) ~= "table" then return records end
    for index = 1, #raw do
        local item = raw[index]
        if type(item) == "table" then
            local id = trim(item.id)
            local path = trim(item.path)
            if id:sub(1, 3) == "id:" and path ~= "" then
                records[#records + 1] = { id = id, path = path }
            end
        end
    end
    return records
end

--- Writes the ledger back, dropping the oldest records past the cap.
-- @tparam table settings `G_reader_settings`
-- @tparam table records array of `{ id, path }`
-- @treturn boolean saved
function Ownership.save(settings, records)
    if type(settings) ~= "table" or type(settings.saveSetting) ~= "function" then
        return false
    end
    local trimmed = {}
    if type(records) == "table" then
        local first = math.max(#records - Ownership.MAX_ENTRIES + 1, 1)
        for index = first, #records do
            local item = records[index]
            if type(item) == "table" then
                trimmed[#trimmed + 1] = { id = trim(item.id), path = trim(item.path) }
            end
        end
    end
    settings:saveSetting(Ownership.SETTING_KEY, trimmed)
    return true
end

--- The recorded path for an entry, whether or not the file still exists.
-- @tparam table settings `G_reader_settings`
-- @tparam table entry catalog entry or session
-- @treturn string|nil path
function Ownership.pathFor(settings, entry)
    local key = Ownership.key(entry)
    if not key then return nil end
    local records = Ownership.load(settings)
    for index = #records, 1, -1 do
        if records[index].id == key then return records[index].path end
    end
    return nil
end

--- Records that `filepath` on this device is the entry's book.
-- Re-recording the same id moves it to the newest position, so a book the
-- reader re-downloaded after a manual delete keeps its fresh path.
-- @tparam table settings `G_reader_settings`
-- @tparam table entry catalog entry or session
-- @string filepath local path of the EPUB
-- @treturn boolean recorded
function Ownership.record(settings, entry, filepath)
    local key = Ownership.key(entry)
    local path = trim(filepath)
    if not key or path == "" then return false end
    if type(settings) ~= "table" or type(settings.saveSetting) ~= "function" then
        return false
    end
    local records = Ownership.load(settings)
    local kept = {}
    for index = 1, #records do
        if records[index].id ~= key then kept[#kept + 1] = records[index] end
    end
    kept[#kept + 1] = { id = key, path = path }
    return Ownership.save(settings, kept)
end

--- Drops the ledger entry for one book id.
-- @tparam table settings `G_reader_settings`
-- @tparam table|string|number entry catalog entry, session, or key string
-- @treturn boolean changed
function Ownership.forget(settings, entry)
    local key = trim(entry)
    if key:sub(1, 3) ~= "id:" then key = Ownership.key(entry) end
    if not key then return false end
    local records = Ownership.load(settings)
    local kept = {}
    for index = 1, #records do
        if records[index].id ~= key then kept[#kept + 1] = records[index] end
    end
    if #kept == #records then return false end
    return Ownership.save(settings, kept)
end

--- Drops every ledger entry that pointed at `filepath` (book deleted locally).
-- @tparam table settings `G_reader_settings`
-- @string filepath local path that is no longer a book
-- @treturn boolean changed
function Ownership.forgetPath(settings, filepath)
    local path = trim(filepath)
    if path == "" then return false end
    local records = Ownership.load(settings)
    local kept = {}
    for index = 1, #records do
        if records[index].path ~= path then kept[#kept + 1] = records[index] end
    end
    if #kept == #records then return false end
    return Ownership.save(settings, kept)
end

--- Resolves the entry's recorded path, pruning it when the file is gone.
-- @tparam table settings `G_reader_settings`
-- @tparam table entry catalog entry or session
-- @function[opt] exists_fn predicate deciding whether a path is a readable book
-- @treturn string|nil path of the file on this device
function Ownership.resolve(settings, entry, exists_fn)
    local key = Ownership.key(entry)
    if not key then return nil end
    local records = Ownership.load(settings)
    for index = #records, 1, -1 do
        if records[index].id == key then
            local path = records[index].path
            local is_present = type(exists_fn) ~= "function" or exists_fn(path) == true
            if is_present then return path end
            -- The book was deleted or moved behind the plugin's back: forget
            -- the record so the next lookup costs nothing and the caller falls
            -- back to its filename rule.
            local kept = {}
            for other = 1, #records do
                if other ~= index then kept[#kept + 1] = records[other] end
            end
            Ownership.save(settings, kept)
            return nil
        end
    end
    return nil
end

return Ownership
