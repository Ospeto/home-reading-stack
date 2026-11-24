--[[--
Bounded in-memory LRU+TTL cache and disk directory quota manager for LightHouse.

Keeps catalog pages and author/series groupings fast on repeated navigation while
ensuring cached cover thumbnails never grow without bound on small e-ink storage.

@module koplugin.lighthouse_cache
]]

local Cache = {}

--- Creates a bounded LRU cache with optional TTL expiry.
-- @number[opt=12] max_entries maximum items retained
-- @number[opt=120] ttl_seconds entry time-to-live in seconds (0 disables expiry)
-- @treturn table cache instance
function Cache.new(max_entries, ttl_seconds)
    local cap = math.max(math.floor(tonumber(max_entries) or 12), 1)
    local ttl = tonumber(ttl_seconds)
    if ttl == nil or ttl ~= ttl or ttl < 0 then ttl = 120 end

    local nodes = {}
    local head = nil -- MRU
    local tail = nil -- LRU
    local size = 0
    local hits = 0
    local misses = 0

    local function detach(node)
        if not node then return end
        local prev_node = node.prev
        local next_node = node.next
        if prev_node then
            prev_node.next = next_node
        else
            head = next_node
        end
        if next_node then
            next_node.prev = prev_node
        else
            tail = prev_node
        end
        node.prev = nil
        node.next = nil
    end

    local function attachFront(node)
        node.prev = nil
        node.next = head
        if head then
            head.prev = node
        end
        head = node
        if not tail then
            tail = node
        end
    end

    local function removeNode(node)
        if not node or not nodes[node.key] then return end
        detach(node)
        nodes[node.key] = nil
        size = size - 1
    end

    local instance = {}

    --- Fetches a non-expired cached value and promotes it to MRU.
    -- @param key cache key
    -- @number[opt] now current unix timestamp
    -- @return cached value or nil
    -- @return optional metadata passed to `set`
    function instance:get(key, now)
        if key == nil then
            misses = misses + 1
            return nil
        end
        local node = nodes[key]
        if not node then
            misses = misses + 1
            return nil
        end
        local ts = tonumber(now) or os.time()
        if ttl > 0 and (ts - node.at > ttl or ts < node.at) then
            removeNode(node)
            misses = misses + 1
            return nil
        end
        detach(node)
        attachFront(node)
        hits = hits + 1
        return node.value, node.meta
    end

    --- Stores or refreshes an entry at MRU position, evicting LRU entries past cap.
    -- @param key cache key
    -- @param value cached value
    -- @number[opt] now current unix timestamp
    -- @param[opt] meta optional metadata table
    function instance:set(key, value, now, meta)
        if key == nil then return end
        local ts = tonumber(now) or os.time()
        local node = nodes[key]
        if node then
            node.value = value
            node.meta = meta
            node.at = ts
            detach(node)
            attachFront(node)
            return
        end
        node = {
            key = key,
            value = value,
            meta = meta,
            at = ts,
        }
        nodes[key] = node
        attachFront(node)
        size = size + 1
        while size > cap and tail do
            removeNode(tail)
        end
    end

    --- Removes one key from the cache.
    -- @param key cache key
    function instance:delete(key)
        if key == nil then return end
        local node = nodes[key]
        if node then removeNode(node) end
    end

    --- Clears all cached entries and resets hit/miss counters.
    function instance:clear()
        nodes = {}
        head = nil
        tail = nil
        size = 0
        hits = 0
        misses = 0
    end

    --- Returns usage statistics for diagnostics.
    -- @treturn table { hits, misses, size, max_entries }
    function instance:stats()
        return {
            hits = hits,
            misses = misses,
            size = size,
            max_entries = cap,
        }
    end

    return instance
end

local function loadLfs()
    local ok, lfs = pcall(require, "libs/libkoreader-lfs")
    if ok and type(lfs) == "table" and type(lfs.dir) == "function" then
        return lfs
    end
    ok, lfs = pcall(require, "lfs")
    if ok and type(lfs) == "table" and type(lfs.dir) == "function" then
        return lfs
    end
    return nil
end

local function defaultIoAdapter()
    local lfs = loadLfs()
    return {
        list = function(dir)
            if not lfs or type(dir) ~= "string" or dir == "" then return nil end
            local listed, iter, dir_obj = pcall(lfs.dir, dir)
            if not listed or type(iter) ~= "function" then return nil end
            local names = {}
            pcall(function()
                for name in iter, dir_obj do
                    if name ~= "." and name ~= ".." then
                        names[#names + 1] = name
                    end
                end
            end)
            if type(dir_obj) == "table" and type(dir_obj.close) == "function" then
                pcall(dir_obj.close, dir_obj)
            end
            return names
        end,
        attributes = function(path, field)
            if not lfs or type(path) ~= "string" or path == "" then return nil end
            local ok, value = pcall(lfs.attributes, path, field)
            if ok then return value end
            return nil
        end,
        remove = function(path)
            if type(path) ~= "string" or path == "" then return false end
            return os.remove(path) == true
        end,
    }
end

local function collectRegularFiles(dir, io_adapter)
    local adapter = type(io_adapter) == "table" and io_adapter or defaultIoAdapter()
    if type(dir) ~= "string" or dir == "" or type(adapter.list) ~= "function" then
        return {}, 0, adapter
    end
    local clean = dir:gsub("/+$", "")
    local names = adapter.list(clean)
    if type(names) ~= "table" then
        return {}, 0, adapter
    end
    local files = {}
    local total_bytes = 0
    for idx = 1, #names do
        local name = names[idx]
        if type(name) == "string" and name ~= "." and name ~= ".." then
            local full = clean .. "/" .. name
            local mode = adapter.attributes and adapter.attributes(full, "mode") or nil
            if mode == "file" then
                local sz = tonumber(adapter.attributes and adapter.attributes(full, "size")) or 0
                if sz < 0 or sz ~= sz then sz = 0 end
                local mtime = tonumber(adapter.attributes and adapter.attributes(full, "modification")) or 0
                if mtime ~= mtime then mtime = 0 end
                files[#files + 1] = {
                    path = full,
                    size = sz,
                    mtime = mtime,
                }
                total_bytes = total_bytes + sz
            end
        end
    end
    return files, total_bytes, adapter
end

--- Summarizes regular file count and total bytes inside `dir`.
-- @string dir directory path
-- @tparam[opt] table io_adapter { list, attributes, remove }
-- @treturn table { files = number, bytes = number }
function Cache.dirStats(dir, io_adapter)
    local files, total_bytes = collectRegularFiles(dir, io_adapter)
    return {
        files = #files,
        bytes = total_bytes,
    }
end

--- Enforces file-count and total-byte caps by deleting oldest-mtime files first.
-- @string dir directory path
-- @tparam[opt] table opts { max_files = 400, max_bytes = 30*1024*1024 }
-- @tparam[opt] table io_adapter { list, attributes, remove }
-- @treturn table { removed, bytes_freed, remaining_files, remaining_bytes }
function Cache.pruneDir(dir, opts, io_adapter)
    opts = type(opts) == "table" and opts or {}
    local max_files = math.max(math.floor(tonumber(opts.max_files) or 400), 0)
    local max_bytes = math.max(math.floor(tonumber(opts.max_bytes) or (30 * 1024 * 1024)), 0)

    local files, total_bytes, adapter = collectRegularFiles(dir, io_adapter)
    local count = #files
    if count <= max_files and total_bytes <= max_bytes then
        return {
            removed = 0,
            bytes_freed = 0,
            remaining_files = count,
            remaining_bytes = total_bytes,
        }
    end

    table.sort(files, function(a, b)
        if a.mtime ~= b.mtime then
            return a.mtime < b.mtime
        end
        return a.path < b.path
    end)

    local removed = 0
    local bytes_freed = 0
    local remove_fn = type(adapter.remove) == "function" and adapter.remove or os.remove
    for idx = 1, #files do
        if count <= max_files and total_bytes <= max_bytes then
            break
        end
        local item = files[idx]
        if pcall(remove_fn, item.path) then
            removed = removed + 1
            bytes_freed = bytes_freed + item.size
            count = count - 1
            total_bytes = math.max(total_bytes - item.size, 0)
        end
    end

    return {
        removed = removed,
        bytes_freed = bytes_freed,
        remaining_files = count,
        remaining_bytes = total_bytes,
    }
end

--- Deletes all regular files in `dir`.
-- @string dir directory path
-- @tparam[opt] table io_adapter { list, attributes, remove }
-- @treturn table { removed, bytes_freed }
function Cache.clearDir(dir, io_adapter)
    local files, _, adapter = collectRegularFiles(dir, io_adapter)
    local removed = 0
    local bytes_freed = 0
    local remove_fn = type(adapter.remove) == "function" and adapter.remove or os.remove
    for idx = 1, #files do
        local item = files[idx]
        if pcall(remove_fn, item.path) then
            removed = removed + 1
            bytes_freed = bytes_freed + item.size
        end
    end
    return {
        removed = removed,
        bytes_freed = bytes_freed,
    }
end

return Cache
