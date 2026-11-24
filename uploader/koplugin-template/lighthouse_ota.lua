--[[--
Pure-Lua Over-The-Air (OTA) update helper for LightHouse.

Unpacks the stored ZIP archive produced by `buildStoredZip()` in memory,
verifies every entry name stays inside `lighthouse.koplugin/`, compile-checks
every `.lua` payload before anything reaches disk, and stages `.ota_tmp` writes
before swapping them over the live plugin files. Zero `os.execute` calls and
zero external binary dependencies.

@module koplugin.lighthouse_ota
]]

local Ota = {}

local ROOT_PREFIX = "lighthouse.koplugin/"
local LOCAL_HEADER_SIG = "PK\003\004"
local CENTRAL_DIR_SIG = "PK\001\002"
local EOCD_SIG = "PK\005\006"

--- Reads a little-endian 16-bit unsigned integer at 1-based byte index `pos`.
local function u16(bytes, pos)
    local b1, b2 = bytes:byte(pos, pos + 1)
    if not b1 or not b2 then return nil end
    return b1 + b2 * 256
end

--- Reads a little-endian 32-bit unsigned integer at 1-based byte index `pos`.
local function u32(bytes, pos)
    local b1, b2, b3, b4 = bytes:byte(pos, pos + 3)
    if not b1 or not b2 or not b3 or not b4 then return nil end
    return b1 + b2 * 256 + b3 * 65536 + b4 * 16777216
end

local bit_ok, bitlib = pcall(require, "bit")
local bit32_ok, bit32lib = false, nil
if not bit_ok then
    bit32_ok, bit32lib = pcall(require, "bit32")
end

local function bxor32(a, b)
    if bit_ok then
        local v = bitlib.bxor(a, b)
        if v < 0 then v = v + 4294967296 end
        return v
    elseif bit32_ok then
        return bit32lib.bxor(a, b)
    end
    local r, p = 0, 1
    local x, y = a % 4294967296, b % 4294967296
    for _bit = 1, 32 do
        if (x % 2) ~= (y % 2) then r = r + p end
        x = math.floor(x / 2)
        y = math.floor(y / 2)
        p = p * 2
    end
    return r
end

local function band32(a, b)
    if bit_ok then
        local v = bitlib.band(a, b)
        if v < 0 then v = v + 4294967296 end
        return v
    elseif bit32_ok then
        return bit32lib.band(a, b)
    end
    local r, p = 0, 1
    local x, y = a % 4294967296, b % 4294967296
    for _bit = 1, 32 do
        if (x % 2 == 1) and (y % 2 == 1) then r = r + p end
        x = math.floor(x / 2)
        y = math.floor(y / 2)
        p = p * 2
    end
    return r
end

local function rshift32(a, n)
    if bit_ok then
        local v = bitlib.rshift(a, n)
        if v < 0 then v = v + 4294967296 end
        return v
    elseif bit32_ok then
        return bit32lib.rshift(a, n)
    end
    return math.floor((a % 4294967296) / (2 ^ n))
end

local CRC32_TABLE = {}
for i = 0, 255 do
    local c = i
    for _bit = 1, 8 do
        if band32(c, 1) ~= 0 then
            c = bxor32(rshift32(c, 1), 0xEDB88320)
        else
            c = rshift32(c, 1)
        end
    end
    CRC32_TABLE[i] = c
end

--- Computes IEEE 802.3 CRC-32 for raw bytes, matching PKZIP and Node/Bun `crc32()`.
-- @string data raw binary payload
-- @treturn number unsigned 32-bit CRC
function Ota.crc32(data)
    local crc = 0xFFFFFFFF
    local len = type(data) == "string" and #data or 0
    if bit_ok then
        local tbl = CRC32_TABLE
        for idx = 1, len do
            local byte = data:byte(idx)
            crc = bitlib.bxor(tbl[bitlib.band(bitlib.bxor(crc, byte), 0xFF)], bitlib.rshift(crc, 8))
        end
        crc = bitlib.bxor(crc, 0xFFFFFFFF)
        if crc < 0 then crc = crc + 4294967296 end
        return crc
    end
    local tbl = CRC32_TABLE
    for idx = 1, len do
        local byte = data:byte(idx)
        crc = bxor32(tbl[band32(bxor32(crc, byte), 0xFF)], rshift32(crc, 8))
    end
    return bxor32(crc, 0xFFFFFFFF)
end

--- Parses numeric `major.minor.patch` version components.
-- @param value string|nil e.g. "1.10.0" or "v1.10.0"
-- @treturn table { major, minor, patch }
function Ota.parseVersion(value)
    local text = tostring(value or ""):gsub("^%s*[vV]?", ""):gsub("%s+$", "")
    local maj, min, pat = text:match("^(%d+)%.(%d+)%.?(%d*)")
    if not maj then
        maj, min = text:match("^(%d+)%.(%d+)")
        pat = "0"
    end
    if not maj then
        local single = text:match("^(%d+)$")
        if single then return { tonumber(single) or 0, 0, 0 } end
        return { 0, 0, 0 }
    end
    return {
        tonumber(maj) or 0,
        tonumber(min) or 0,
        tonumber(pat ~= "" and pat or "0") or 0,
    }
end

--- Compares two semantic version strings.
-- @string left
-- @string right
-- @treturn number -1 if left < right, 0 if equal, 1 if left > right
function Ota.compareVersions(left, right)
    local a = Ota.parseVersion(left)
    local b = Ota.parseVersion(right)
    for idx = 1, 3 do
        if a[idx] < b[idx] then return -1 end
        if a[idx] > b[idx] then return 1 end
    end
    return 0
end

--- True when `latest` is strictly newer than `current`.
-- @string current installed plugin version
-- @string latest remote server version
-- @treturn boolean
function Ota.isUpdateAvailable(current, latest)
    if type(latest) ~= "string" or latest == "" then return false end
    return Ota.compareVersions(current, latest) < 0
end

--- Validates that an archive entry name is a safe file inside `lighthouse.koplugin/`.
-- @string raw_name entry name from PKZIP local header
-- @treturn string|nil relative path inside plugin dir
-- @treturn boolean|nil true when entry is a directory marker
local function validateEntryName(raw_name)
    if type(raw_name) ~= "string" or raw_name == "" then return nil, false end
    if raw_name:find("\\", 1, true) or raw_name:find("\0", 1, true) then
        return nil, false
    end
    if raw_name == ROOT_PREFIX then
        return "", true
    end
    if raw_name:sub(1, #ROOT_PREFIX) ~= ROOT_PREFIX then
        return nil, false
    end
    local rel = raw_name:sub(#ROOT_PREFIX + 1)
    if rel == "" or rel:sub(1, 1) == "/" then
        return nil, false
    end
    if rel:sub(-1) == "/" then
        for seg in rel:gmatch("[^/]+") do
            if seg == ".." or seg == "." then return nil, false end
        end
        return rel, true
    end
    for seg in rel:gmatch("[^/]+") do
        if seg == ".." or seg == "." then return nil, false end
    end
    return rel, false
end

--- Extracts and validates a stored-only `.koplugin` ZIP archive in memory.
-- Every `.lua` entry is compiled before returning so broken Lua never reaches disk.
-- @string bytes raw ZIP bytes
-- @treturn table|nil array of { name = rel_path, data = string }
-- @treturn string|nil error code
function Ota.unpackStoredZip(bytes)
    if type(bytes) ~= "string" or #bytes < 30 then
        return nil, "invalid_zip"
    end

    local loader = loadstring or load
    local entries = {}
    local seen = {}
    local pos = 1
    local len = #bytes

    while pos + 3 <= len do
        local sig = bytes:sub(pos, pos + 3)
        if sig == CENTRAL_DIR_SIG or sig == EOCD_SIG then
            break
        end
        if sig ~= LOCAL_HEADER_SIG then
            return nil, "invalid_zip"
        end
        if pos + 29 > len then
            return nil, "invalid_zip"
        end

        local flags = u16(bytes, pos + 6)
        local method = u16(bytes, pos + 8)
        local expected_crc = u32(bytes, pos + 14)
        local comp_size = u32(bytes, pos + 18)
        local uncomp_size = u32(bytes, pos + 22)
        local name_len = u16(bytes, pos + 26)
        local extra_len = u16(bytes, pos + 28)

        if not flags or not method or not expected_crc or not comp_size or not uncomp_size or not name_len or not extra_len then
            return nil, "invalid_zip"
        end
        if method ~= 0 or comp_size ~= uncomp_size or math.floor(flags / 8) % 2 == 1 then
            return nil, "unsupported_zip_compression"
        end

        local name_start = pos + 30
        local data_start = name_start + name_len + extra_len
        if name_start + name_len - 1 > len or data_start + comp_size - 1 > len then
            return nil, "invalid_zip"
        end

        local raw_name = bytes:sub(name_start, name_start + name_len - 1)
        local data = comp_size > 0 and bytes:sub(data_start, data_start + comp_size - 1) or ""
        pos = data_start + comp_size

        if Ota.crc32(data) ~= expected_crc then
            return nil, "crc_mismatch"
        end

        local rel_name, is_dir = validateEntryName(raw_name)
        if not rel_name then
            return nil, "unsafe_archive_path"
        end
        if not is_dir then
            if rel_name:match("%.lua$") then
                if type(loader) ~= "function" then
                    return nil, "lua_loader_unavailable"
                end
                local chunk = loader(data, "@" .. rel_name)
                if not chunk then
                    return nil, "lua_syntax_error"
                end
            end
            seen[rel_name] = true
            entries[#entries + 1] = {
                name = rel_name,
                data = data,
            }
        end
    end

    if #entries == 0 or not seen["main.lua"] or not seen["_meta.lua"] or not seen["lighthouse_config.lua"] then
        return nil, "incomplete_archive"
    end

    return entries, nil
end

--- Writes validated entries into `plugin_dir` via `.ota_tmp` staging files.
-- @string plugin_dir path to `.../lighthouse.koplugin`
-- @tparam table entries array from `Ota.unpackStoredZip`
-- @treturn boolean|nil true on success
-- @treturn string|nil error description
function Ota.installEntries(plugin_dir, entries)
    if type(plugin_dir) ~= "string" or plugin_dir == "" then
        return nil, "invalid_plugin_dir"
    end
    if type(entries) ~= "table" or #entries == 0 then
        return nil, "incomplete_archive"
    end

    local base_dir = plugin_dir:gsub("/+$", "")
    local lfs_ok, lfs = pcall(require, "libs/libkoreader-lfs")
    local staged = {}

    local function cleanupStaged()
        for idx = 1, #staged do
            pcall(os.remove, staged[idx].tmp)
        end
    end

    for idx = 1, #entries do
        local entry = entries[idx]
        if type(entry) ~= "table" or type(entry.name) ~= "string" or type(entry.data) ~= "string" then
            cleanupStaged()
            return nil, "invalid_entry"
        end
        if entry.name:find("/", 1, true) and lfs_ok and type(lfs.mkdir) == "function" then
            local acc = base_dir
            for part in entry.name:gmatch("([^/]+)/") do
                acc = acc .. "/" .. part
                pcall(lfs.mkdir, acc)
            end
        end
        local target = base_dir .. "/" .. entry.name
        local tmp = target .. ".ota_tmp"
        local handle, open_err = io.open(tmp, "wb")
        if not handle then
            cleanupStaged()
            return nil, string.format("file_error: %s", tostring(open_err or "open_failed"))
        end
        local ok_write, write_err = handle:write(entry.data)
        local ok_close, close_err = handle:close()
        staged[#staged + 1] = { tmp = tmp, target = target }
        if not ok_write or ok_close == nil then
            cleanupStaged()
            return nil, string.format("file_error: %s", tostring(write_err or close_err or "write_failed"))
        end
    end

    local swapped = {}
    local function rollbackSwapped()
        for idx = #swapped, 1, -1 do
            local item = swapped[idx]
            if item.bak then
                pcall(os.remove, item.target)
                pcall(os.rename, item.bak, item.target)
            else
                pcall(os.remove, item.target)
            end
        end
    end

    for idx = 1, #staged do
        local item = staged[idx]
        local bak = item.target .. ".ota_bak"
        local existed = false
        local probe = io.open(item.target, "rb")
        if probe then
            probe:close()
            existed = true
            pcall(os.remove, bak)
            local ok_bak, bak_err = os.rename(item.target, bak)
            if not ok_bak then
                rollbackSwapped()
                cleanupStaged()
                return nil, string.format("file_error: %s", tostring(bak_err or "backup_failed"))
            end
        end

        local ok_rename, rename_err = os.rename(item.tmp, item.target)
        if not ok_rename then
            if existed then
                pcall(os.rename, bak, item.target)
            end
            rollbackSwapped()
            cleanupStaged()
            return nil, string.format("file_error: %s", tostring(rename_err or "rename_failed"))
        end
        swapped[#swapped + 1] = {
            target = item.target,
            bak = existed and bak or nil,
        }
    end

    for idx = 1, #swapped do
        if swapped[idx].bak then
            pcall(os.remove, swapped[idx].bak)
        end
    end

    return true, nil
end

return Ota
