--[[--
Background metadata indexing helpers for LightHouse.

Queues newly downloaded and unindexed local books for KOReader CoverBrowser's
`BookInfoManager:extractInBackground()` in bounded chunks so KOReader's 300s
subprocess watchdog never terminates large local libraries.

@module koplugin.lighthouse_indexer
]]

local Indexer = {}

Indexer.BATCH_SIZE = 50
Indexer.BUSY_MAX_RETRIES = 70
Indexer.BOOK_EXTS = {
    epub = true,
    pdf = true,
    mobi = true,
    azw3 = true,
    cbz = true,
    cbr = true,
    fb2 = true,
    djvu = true,
    txt = true,
}

--- Loads KOReader CoverBrowser's BookInfoManager if installed and active.
-- @treturn table|nil BookInfoManager module
function Indexer.loadBookInfoManager()
    local ok, bim = pcall(require, "bookinfomanager")
    if not ok or type(bim) ~= "table" or type(bim.extractInBackground) ~= "function" then
        return nil
    end
    return bim
end

--- Queues book filepaths for fast metadata-only background indexing.
-- Splits large queues into batches of at most `Indexer.BATCH_SIZE` and waits for
-- `BookInfoManager:isExtractingInBackground()` to clear between chunks so
-- KOReader's 300s subprocess watchdog never terminates large runs.
-- @tparam table state mutable plugin state holding `_pending_index_queue` and `_index_pump_scheduled`
-- @tparam table filepaths array of absolute book file paths
-- @tparam[opt] table ui_manager KOReader UIManager providing `scheduleIn`
-- @treturn number count of newly queued files
-- @treturn string|nil error code ("unavailable")
function Indexer.indexBookFiles(state, filepaths, ui_manager)
    if type(state) ~= "table" or type(filepaths) ~= "table" or #filepaths == 0 then
        return 0
    end
    local bim = Indexer.loadBookInfoManager()
    if not bim then return 0, "unavailable" end

    local existing_pending = {}
    state._pending_index_queue = state._pending_index_queue or {}
    for idx = 1, #state._pending_index_queue do
        local item = state._pending_index_queue[idx]
        if type(item) == "table" and type(item.filepath) == "string" then
            existing_pending[item.filepath] = true
        end
    end

    local queued = 0
    for idx = 1, #filepaths do
        local filepath = filepaths[idx]
        if type(filepath) == "string" and filepath ~= "" and not existing_pending[filepath] then
            existing_pending[filepath] = true
            state._pending_index_queue[#state._pending_index_queue + 1] = {
                filepath = filepath,
                cover_specs = false,
            }
            queued = queued + 1
        end
    end
    if queued == 0 then return 0 end

    local busy_retries = 0
    local function dispatchNextBatch()
        if not state._pending_index_queue or #state._pending_index_queue == 0 then
            state._index_pump_scheduled = false
            return
        end
        local active_bim = Indexer.loadBookInfoManager()
        if not active_bim then
            state._pending_index_queue = {}
            state._index_pump_scheduled = false
            return
        end
        local busy = type(active_bim.isExtractingInBackground) == "function"
            and active_bim:isExtractingInBackground() == true
        if busy then
            busy_retries = busy_retries + 1
            if busy_retries > Indexer.BUSY_MAX_RETRIES then
                state._index_pump_scheduled = false
                return
            end
            if type(ui_manager) == "table" and type(ui_manager.scheduleIn) == "function" then
                state._index_pump_scheduled = true
                ui_manager:scheduleIn(5, dispatchNextBatch)
            else
                state._index_pump_scheduled = false
            end
            return
        end
        busy_retries = 0
        local chunk = {}
        local rest = {}
        for idx = 1, #state._pending_index_queue do
            if idx <= Indexer.BATCH_SIZE then
                chunk[#chunk + 1] = state._pending_index_queue[idx]
            else
                rest[#rest + 1] = state._pending_index_queue[idx]
            end
        end
        state._pending_index_queue = rest
        pcall(function() active_bim:extractInBackground(chunk) end)
        if #state._pending_index_queue > 0 and type(ui_manager) == "table" and type(ui_manager.scheduleIn) == "function" then
            state._index_pump_scheduled = true
            ui_manager:scheduleIn(5, dispatchNextBatch)
        else
            state._index_pump_scheduled = false
        end
    end

    if not state._index_pump_scheduled then
        dispatchNextBatch()
    end
    return queued
end

--- Finds supported local books missing metadata in KOReader's bookinfo DB.
-- Scans `download_dir`, `/mnt/us/books`, and `/mnt/us/documents` (deduplicated,
-- skipping `.sdr` sidecars and hidden/AppleDouble entries).
-- @string[opt] download_dir active LightHouse download folder
-- @tparam[opt] table sidecar Sidecar module exposing `DEVICE_DIRS` and `io`
-- @treturn table|nil sorted array of unindexed filepaths
-- @treturn string|nil error code ("unavailable")
function Indexer.findUnindexedLocalBooks(download_dir, sidecar)
    local bim = Indexer.loadBookInfoManager()
    if not bim or type(bim.getBookInfo) ~= "function" then
        return nil, "unavailable"
    end
    local Sidecar = sidecar or require("lighthouse_sidecar")

    local roots = {}
    local seen_roots = {}
    local function addRoot(dir)
        if type(dir) ~= "string" or dir == "" then return end
        local clean = dir:gsub("\\", "/"):gsub("/+$", "")
        if clean ~= "" and not seen_roots[clean] then
            seen_roots[clean] = true
            roots[#roots + 1] = clean
        end
    end
    addRoot(download_dir)
    if type(Sidecar.DEVICE_DIRS) == "table" then
        for idx = 1, #Sidecar.DEVICE_DIRS do
            addRoot(Sidecar.DEVICE_DIRS[idx])
        end
    end

    local missing = {}
    local seen_files = {}
    local function walk(dir, depth)
        if depth > 8 then return end
        local names = Sidecar.io.list(dir)
        if type(names) ~= "table" then return end
        table.sort(names)
        for idx = 1, #names do
            local name = names[idx]
            if type(name) == "string" and name ~= "." and name ~= ".."
                and not name:match("^%.") and not name:match("^%._")
                and not name:match("%.sdr$") then
                local filepath = dir .. "/" .. name
                local mode = Sidecar.io.attributes(filepath, "mode")
                if mode == "directory" then
                    walk(filepath, depth + 1)
                elseif mode == "file" and not seen_files[filepath] then
                    local ext = name:match("%.([%w_]+)$")
                    if ext and Indexer.BOOK_EXTS[ext:lower()] then
                        seen_files[filepath] = true
                        local ok_info, info = pcall(function()
                            return bim:getBookInfo(filepath, false)
                        end)
                        if not ok_info or type(info) ~= "table"
                            or (info.has_meta ~= "Y" and not info.ignore_meta and not info.unsupported) then
                            missing[#missing + 1] = filepath
                        end
                    end
                end
            end
        end
    end

    for idx = 1, #roots do
        local root = roots[idx]
        if Sidecar.io.attributes(root, "mode") == "directory" then
            walk(root, 0)
        end
    end
    return missing
end

return Indexer
