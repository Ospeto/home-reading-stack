--[[--
Local reading data, read straight out of KOReader's own sidecar files.

Every book KOReader has opened gets a sidecar directory beside it:

    <book>.sdr/metadata.<extension>.lua

and that file is a plain Lua table holding `percent_finished` (a 0..1 ratio),
`annotations` (an integer-keyed list of highlights and notes) and `stats` (the
document's own bookkeeping). It is the same data the server only learns about
after a KOSync upload, so reading it here makes progress and highlights
available on a device that has never synced, and fresh, because the file is
rewritten as the reader reads.

Verified on a live Kindle before this module was written (`/mnt/us/books` and
`/mnt/us/documents`, 13 sidecar directories): `percent_finished` is a 0..1
float, `annotations` is integer-keyed with `chapter`, `datetime`, `page`,
`pageno` and `text` in each entry, and `stats` is a table. That book's
annotations carried NO `drawer` and NO `color` key at all, which is why colour
and style are treated as optional here and never as a given.

Three properties this module is built around:

  * STRICTLY READ-ONLY. Nothing in this file opens a sidecar for writing and
    nothing writes progress anywhere. Every open is `"rb"`, and the one
    consumer of a parsed sidecar is a local variable.
  * A CRASH HERE KILLS KOREADER. A sidecar is written while a book is open, so
    a half-written file is a normal state, not an exceptional one. Every read
    and every parse goes through `pcall`, and a file that will not parse is
    reported as `malformed` and treated as "no local data" - never as an error
    the reader has to see. Nothing in this module raises on a bad file.
  * THE FILE IS UNTRUSTED INPUT. Everything parsed is normalized at this
    boundary: text fields are ALWAYS strings after `read()`, and ratios are
    always finite numbers in 0..1 or nil. That is what keeps a sidecar value
    from reaching `gsub`, `..` or a menu row as a table or a callable.

@module koplugin.lighthouse_sidecar
]]

local Sidecar = {}

--- Suffix KOReader appends to the book path to name its sidecar directory.
Sidecar.SIDECAR_SUFFIX = ".sdr"

--- Stem of every metadata file inside a sidecar directory.
Sidecar.METADATA_PREFIX = "metadata"

--- Directories searched for books and their sidecars on a Kindle.
-- Sideloaded books land in either one depending on how they arrived, so both
-- are walked. `/mnt/onboard` on a Kobo and the plugin's own download folder are
-- added by the caller (see `localSearchDirs` in main.lua).
Sidecar.DEVICE_DIRS = { "/mnt/us/books", "/mnt/us/documents" }

--- Bounds on one device scan.
-- A whole-library walk on a slow e-ink device has to finish in the time it
-- takes a menu to open, so it is capped rather than trusted to be small:
-- `depth` covers `books/<author>/<series>/<file>.epub.sdr`, `sidecars` is how
-- many records are read (the expensive part), and `directories` bounds the
-- walk itself.
Sidecar.SCAN_LIMITS = { depth = 6, directories = 2000, sidecars = 200 }

--- Environment a sidecar is evaluated in.
-- A sidecar is a data file, so it gets no `os`, no `io` and no `load*`: a
-- corrupt or hostile file can return a table and nothing else. Kept minimal on
-- purpose - every name missing here is a capability the file does not have.
local PARSE_ENV = {
    string = string,
    table = table,
    math = math,
    tostring = tostring,
    tonumber = tonumber,
    type = type,
    pairs = pairs,
    ipairs = ipairs,
    next = next,
    select = select,
    setmetatable = setmetatable,
    getmetatable = getmetatable,
    rawget = rawget,
    rawset = rawset,
    error = error,
    assert = assert,
}

--- THE string guard for this module.
-- The same contract as `Status.str` (always a string, never nil) but local, so
-- this module stays loadable on its own: it is the one file the tests drive
-- without the rest of the plugin. A sidecar field may be a table, a number, a
-- boolean or nothing at all; after this it is always text.
-- @param value untrusted value of any type
-- @string[opt] fallback text for anything unusable (default "")
-- @treturn string never nil
local function textOf(value, fallback)
    if type(value) == "string" then return value end
    if type(value) == "number" then
        -- NaN and the infinities have no reader-facing spelling.
        if value ~= value or value == math.huge or value == -math.huge then
            return fallback or ""
        end
        return tostring(value)
    end
    return fallback or ""
end

--- THE number guard for this module, the `textOf` counterpart.
-- Untrusted values become a finite number or nil - never a boolean, a table or
-- NaN - so `>` comparisons and `%d` formatting further down stay safe.
-- @param value untrusted value of any type
-- @treturn number|nil finite number, or nil for anything unusable
local function numberOf(value)
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

--- Clamps a raw ratio into 0..1, leaving "no value" as nil.
-- A sidecar writes `percent_finished` as a 0..1 float; anything else (a
-- missing key, a table, a string of words) is genuinely unknown and stays nil
-- rather than silently reading as 0%, which would look like an unopened book.
-- @param value untrusted value
-- @treturn number|nil 0..1 ratio
local function clampRatio(value)
    local ratio = numberOf(value)
    if not ratio then return nil end
    if ratio < 0 then return 0 end
    if ratio > 1 then return 1 end
    return ratio
end

--- LuaFileSystem, or nil when the build does not ship it.
-- Wrapped because `require` raises on a module this build does not have, and a
-- missing directory lister must cost the scan, not the process.
-- @treturn table|nil
local function fileSystem()
    local loaded, lfs = pcall(require, "libs/libkoreader-lfs")
    if loaded and type(lfs) == "table" and type(lfs.dir) == "function" then return lfs end
    loaded, lfs = pcall(require, "lfs")
    if loaded and type(lfs) == "table" and type(lfs.dir) == "function" then return lfs end
    return nil
end

--- Lists one directory, or nil when it cannot be listed.
-- Returns names only (no paths), dot-entries removed. The directory handle is
-- closed even when iteration raises, because a scan opens thousands of these
-- and a leaked handle would exhaust the device's descriptors.
--
-- The generic-for is given TWO values on purpose: KOReader's bundled
-- LuaFileSystem returns `(iterator, directory_object)` and its iterator needs
-- the directory as its state. Verified on the Kindle - iterating the function
-- alone raises `bad argument #1 to '(for generator)' (directory metatable
-- expected, got nil)`, which `pcall` below turned into "no directories" and an
-- empty scan. Passing the state explicitly is also harmless on builds whose
-- `lfs.dir` returns a self-contained closure.
-- @string path
-- @treturn table|nil array of entry names
local function defaultList(path)
    if type(path) ~= "string" or path == "" then return nil end
    local lfs = fileSystem()
    if not lfs then return nil end
    -- `lfs.dir` raises on a missing or unreadable directory; `pcall` turns that
    -- into "nothing here", which is exactly how a caller should read it.
    local listed, iterator, directory = pcall(lfs.dir, path)
    if not listed or type(iterator) ~= "function" then return nil end
    local names = {}
    local walked = pcall(function()
        for name in iterator, directory do
            if name ~= "." and name ~= ".." then names[#names + 1] = name end
        end
    end)
    if type(directory) == "table" and type(directory.close) == "function" then
        pcall(directory.close, directory)
    end
    if not walked then return nil end
    return names
end

--- One `lfs.attributes` field, or nil.
-- @string path
-- @string field "mode", "modification", "size"
-- @treturn string|number|nil
local function defaultAttributes(path, field)
    if type(path) ~= "string" or path == "" then return nil end
    local lfs = fileSystem()
    if not lfs then return nil end
    local read, value = pcall(lfs.attributes, path, field)
    if not read then return nil end
    return value
end

--- Every filesystem touch this module makes, in one overridable table.
-- Defaults are all read-only: `open` is only ever called with `"rb"`, `list`
-- and `attributes` go through LuaFileSystem, and `loadfile` compiles a sidecar
-- inside `pcall`. Tests replace this table to inject an in-memory filesystem,
-- so the scanner and the reader are exercised off-device without mocking `io`.
Sidecar.io = {
    open = function(path, mode) return io.open(path, mode) end,
    loadfile = function(path) return loadfile(path) end,
    list = defaultList,
    attributes = defaultAttributes,
}

--- Trims leading and trailing whitespace and collapses runs of it.
-- @string text
-- @treturn string
local function collapse(text)
    local value = textOf(text)
    value = value:gsub("^%s+", "")
    return (value:gsub("%s+", " "))
end

--- Normalizes free text for tolerant comparison.
-- Lowercases, turns punctuation into spaces and collapses whitespace, so
-- "01 - Spice and Wolf, Vol. 1" matches "spice and wolf vol 1".
-- @string text
-- @treturn string
function Sidecar.normalize(text)
    local value = textOf(text):lower()
    value = value:gsub("&amp;", "and")
    value = value:gsub("&", "and")
    value = value:gsub("&apos;", "'")
    value = value:gsub("[%p%c]", " ")
    value = value:gsub("^%s+", "")
    return (value:gsub("%s+", " "))
end

--- Splits a sidecar authors string into a normalized list.
-- Sidecars separate authors with a newline (KOReader's own writing) or a
-- comma; both are accepted, and empty chunks are dropped.
-- @string authors
-- @treturn table array of normalized author names
function Sidecar.authorList(authors)
    local list = {}
    for chunk in textOf(authors):gmatch("[^\n,;]+") do
        local normalized = Sidecar.normalize(chunk)
        if normalized ~= "" then list[#list + 1] = normalized end
    end
    return list
end

--- True when the two normalized author lists share at least one name.
-- @tparam table left
-- @tparam table right
-- @treturn boolean
function Sidecar.sharesAuthor(left, right)
    if type(left) ~= "table" or type(right) ~= "table" then return false end
    for left_index = 1, #left do
        for right_index = 1, #right do
            if left[left_index] == right[right_index] then return true end
        end
    end
    return false
end

--- File name (with extension) of a path, without the directory part.
-- @string path
-- @treturn string
function Sidecar.fileName(path)
    local value = textOf(path)
    return (value:gsub("^.*/", ""))
end

--- File name without its last extension: "01 - Dune.epub" -> "01 - Dune".
-- Displayable as written, because a book whose sidecar carries no title is
-- still best labelled by its own file name.
-- @string path
-- @treturn string
function Sidecar.fileStem(path)
    local name = Sidecar.fileName(path)
    local stem = name:gsub("%.[^.]+$", "")
    if stem == "" then return name end
    return stem
end

--- Normalized key for a book file: the comparison form of `fileStem`.
-- @string path
-- @treturn string
function Sidecar.stemKey(path)
    return Sidecar.normalize(Sidecar.fileStem(path))
end

--- The document extension used in a sidecar's file name (".epub" -> "epub").
-- Only a short alphanumeric extension is accepted: the value is spliced into a
-- file name, so anything else is treated as "no extension" rather than joined.
-- @string book_path
-- @treturn string lowercase extension, or ""
local function documentExtension(book_path)
    local name = Sidecar.fileName(book_path)
    local extension = name:match("%.([^.]+)$")
    extension = textOf(extension):lower()
    if extension == "" or #extension > 8 then return "" end
    if not extension:match("^[%w]+$") then return "" end
    return extension
end

--- Sidecar paths for one book, in the order they are trusted.
-- The exact-extension name comes first because that is what KOReader writes
-- beside `<book>.epub`; `metadata.lua` is the second write and is tried next.
-- Neither needs a directory listing, so this half works even on a build
-- without LuaFileSystem.
-- @string book_path path of the book file on the device
-- @treturn table array of candidate paths (possibly empty)
function Sidecar.metadataCandidates(book_path)
    local candidates = {}
    if type(book_path) ~= "string" or book_path == "" then return candidates end
    local directory = book_path .. Sidecar.SIDECAR_SUFFIX
    local extension = documentExtension(book_path)
    if extension ~= "" then
        candidates[#candidates + 1] = directory
            .. "/" .. Sidecar.METADATA_PREFIX .. "." .. extension .. ".lua"
    end
    candidates[#candidates + 1] = directory .. "/" .. Sidecar.METADATA_PREFIX .. ".lua"
    return candidates
end

--- Every metadata file that could belong to one book.
-- The deterministic candidates first, then any other `metadata.*.lua` the
-- sidecar directory holds - the format only promises `metadata.<something>.lua`,
-- and the entry a device writes can disagree with the file's current extension
-- (a `.kepub.epub`, a renamed download).
-- @string book_path
-- @treturn table array of paths, deduplicated
function Sidecar.metadataFiles(book_path)
    local files = Sidecar.metadataCandidates(book_path)
    local seen = {}
    for file_index = 1, #files do seen[files[file_index]] = true end
    local directory = textOf(book_path) .. Sidecar.SIDECAR_SUFFIX
    local names = Sidecar.io.list(directory)
    for name_index = 1, #(names or {}) do
        local name = textOf(names[name_index])
        if name:match("^" .. Sidecar.METADATA_PREFIX .. "%.[%w%-_]+%.lua$") then
            local path = directory .. "/" .. name
            if not seen[path] then
                seen[path] = true
                files[#files + 1] = path
            end
        end
    end
    return files
end

--- Parses a sidecar's `datetime` field into a sortable unix time.
-- KOReader writes `"2025-11-14 21:03:11"`. Anything else (a missing field, a
-- hand-edited string, an out-of-range date) returns nil so the caller can fall
-- back to the file's own order instead of dropping the annotation.
-- @string value
-- @treturn number|nil
function Sidecar.parseDatetime(value)
    local text = textOf(value)
    local year, month, day, hour, minute, second =
        text:match("^(%d%d%d%d)-(%d%d)-(%d%d)[ T](%d%d):(%d%d):(%d%d)")
    if not year then return nil end
    local built, stamp = pcall(os.time, {
        year = tonumber(year),
        month = tonumber(month),
        day = tonumber(day),
        hour = tonumber(hour),
        min = tonumber(minute),
        sec = tonumber(second),
    })
    if not built or type(stamp) ~= "number" then return nil end
    return stamp
end

--- Reads and parses one sidecar metadata file. NEVER mutates it.
--
-- `loadfile` inside `pcall` is the mandatory boundary: a partially written
-- sidecar (the writer is mid-save when a crash or a bad unplug interrupts it)
-- is either a syntax error at compile time or a raise while building the
-- table, and either one unwinding to the top level kills KOReader's process.
-- @string path candidate metadata path
-- @treturn table|nil the table the sidecar returns
-- @treturn string|nil reason "missing" | "unreadable" | "malformed"
function Sidecar.readFile(path)
    if type(path) ~= "string" or path == "" then return nil, "missing" end
    local adapter = Sidecar.io

    -- Open first, so "the file is not there" and "the file will not parse" stay
    -- different answers: the reader-facing difference is "no sidecar yet"
    -- versus "this book's notes are unreadable".
    local handle = adapter.open(path, "rb")
    if not handle then return nil, "missing" end
    if type(handle.close) == "function" then pcall(handle.close, handle) end

    local loaded, chunk = pcall(adapter.loadfile, path)
    if not loaded or type(chunk) ~= "function" then return nil, "malformed" end
    -- Sandboxed: see PARSE_ENV. `setfenv` is LuaJIT's (Lua 5.1) mechanism and
    -- is absent on 5.2+, where the chunk simply keeps its default environment.
    if type(setfenv) == "function" then pcall(setfenv, chunk, PARSE_ENV) end
    local ran, doc = pcall(chunk)
    if not ran or type(doc) ~= "table" then return nil, "malformed" end
    return doc
end

--- Newest first, with the sidecar's own order as the tie-break.
-- KOReader appends annotations, so the highest index is the most recent one;
-- that keeps hand-edited or date-less entries in a sane order.
local function annotationBefore(left, right)
    local left_stamp = numberOf(left.timestamp)
    local right_stamp = numberOf(right.timestamp)
    if left_stamp and right_stamp and left_stamp ~= right_stamp then
        return left_stamp > right_stamp
    end
    if left_stamp and not right_stamp then return true end
    if right_stamp and not left_stamp then return false end
    return (numberOf(left.index) or 0) > (numberOf(right.index) or 0)
end

--- Normalizes one annotation entry, or nil when it has nothing to show.
-- Colour and style are OPTIONAL: the verified device book carried neither
-- `drawer` nor `color`, and that is normal, not broken. Both normalize to ""
-- so a row can ask "is there a style?" without a nil guard.
-- @tparam table raw one `annotations` entry
-- @number index position in the sidecar's list
-- @treturn table|nil normalized annotation
function Sidecar.normalizeAnnotation(raw, index)
    if type(raw) ~= "table" then return nil end
    local text = textOf(raw.text)
    local note = textOf(raw.note)
    if text == "" then text = note end
    -- A bookmark with neither a quote nor a note has nothing to render in a
    -- highlights list; it is not an error, it is just not a highlight.
    if text == "" then return nil end
    return {
        text = text,
        note = note,
        chapter = collapse(raw.chapter),
        -- The xpointer the sidecar records as `page` is not a page number and
        -- is never shown; `pageno` is the number a reader recognizes.
        page = textOf(raw.page),
        pageno = numberOf(raw.pageno),
        pos0 = textOf(raw.pos0),
        pos1 = textOf(raw.pos1),
        datetime = textOf(raw.datetime),
        timestamp = Sidecar.parseDatetime(raw.datetime),
        color = textOf(raw.color),
        drawer = textOf(raw.drawer),
        index = numberOf(index) or 0,
    }
end

--- Normalizes a parsed sidecar into the plugin's reading record.
-- This is the boundary where untrusted file contents become the shape every
-- screen downstream can index, compare and concatenate without a guard. Named
-- apart from `Sidecar.normalize` (the text comparison key) on purpose: the two
-- do different jobs and one silently replacing the other would break matching.
-- @tparam table doc table returned by a sidecar
-- @treturn table|nil normalized record
function Sidecar.normalizeRecord(doc)
    if type(doc) ~= "table" then return nil end

    local record = {
        percent_finished = clampRatio(doc.percent_finished),
        annotations = {},
        annotation_count = 0,
        stats = {},
        title = "",
        authors = "",
        series = "",
        doc_pages = numberOf(doc.doc_pages),
        partial_md5 = textOf(doc.partial_md5_checksum),
    }

    -- Integer keys collected with `pairs` rather than trusting `#`: a hole or
    -- a stray string key in a hand-edited file must not silently drop or
    -- misorder the entries a reader's highlights live in.
    local raw_annotations = doc.annotations
    if type(raw_annotations) == "table" then
        local keys = {}
        for key, entry in pairs(raw_annotations) do
            if type(key) == "number" and type(entry) == "table" then keys[#keys + 1] = key end
        end
        for key_index = 1, #keys do
            local annotation = Sidecar.normalizeAnnotation(
                raw_annotations[keys[key_index]],
                keys[key_index]
            )
            if annotation then record.annotations[#record.annotations + 1] = annotation end
        end
        table.sort(record.annotations, annotationBefore)
        record.annotation_count = #record.annotations
    end

    local stats = doc.stats
    if type(stats) == "table" then
        record.stats = {
            title = collapse(stats.title),
            authors = collapse(stats.authors),
            series = collapse(stats.series),
            language = textOf(stats.language),
            pages = numberOf(stats.pages),
            md5 = textOf(stats.md5),
        }
    end

    -- `doc_props` is the document's own metadata as KOReader read it; `stats`
    -- repeats some of it. Prefer `doc_props`, fall back to `stats`.
    local props = doc.doc_props
    if type(props) == "table" then
        record.title = collapse(props.title)
        record.authors = collapse(props.authors)
        record.series = collapse(props.series)
    end
    if record.title == "" then record.title = record.stats.title end
    if record.authors == "" then record.authors = record.stats.authors end
    if record.series == "" then record.series = record.stats.series end

    return record
end

--- Reads this device's local reading data for one book.
-- Candidate order is trusted order: a malformed first candidate does not stop
-- the next one from being tried, because a half-written `metadata.epub.lua`
-- beside a good `metadata.lua` is exactly the state a crashed save leaves.
-- @string book_path path of the book file on the device
-- @treturn table|nil record (see `Sidecar.normalizeRecord`) with `book_path` and
--                   `sidecar_path` attached
-- @treturn string|nil reason "missing" | "malformed"
function Sidecar.read(book_path)
    if type(book_path) ~= "string" or book_path == "" then return nil, "missing" end
    local files = Sidecar.metadataFiles(book_path)
    local reason = "missing"
    for file_index = 1, #files do
        local path = files[file_index]
        local doc, file_reason = Sidecar.readFile(path)
        if doc then
            local record = Sidecar.normalizeRecord(doc)
            if record then
                record.book_path = book_path
                record.sidecar_path = path
                record.modified = numberOf(Sidecar.io.attributes(path, "modification"))
                return record
            end
            reason = "malformed"
        elseif file_reason == "malformed" then
            -- Keep the sighting: if no other candidate parses, this is why.
            reason = "malformed"
        end
    end
    return nil, reason
end

--- True when the book file itself is still on this device.
-- A deleted book can leave its sidecar behind; the highlights are still worth
-- showing, but there is nothing to open.
-- @string book_path
-- @treturn boolean
function Sidecar.bookExists(book_path)
    if type(book_path) ~= "string" or book_path == "" then return false end
    local adapter = Sidecar.io
    local mode = adapter.attributes(book_path, "mode")
    if mode ~= nil then return mode == "file" end
    local handle = adapter.open(book_path, "rb")
    if not handle then return false end
    if type(handle.close) == "function" then pcall(handle.close, handle) end
    return true
end

--- Walks the device's book roots and returns one record per sidecar.
--
-- ONE directory walk per call, no network, no polling: the caller caches the
-- result for the session (see `localRecords` in main.lua). Bounded by
-- `Sidecar.SCAN_LIMITS` so a very large library cannot stall a menu.
--
-- Records are returned newest-read first. A book whose file has been deleted
-- but whose sidecar remains is included on purpose - its highlights still
-- exist - and `bookExists` tells the caller whether it can be opened.
-- @tparam[opt] table options { dirs = {paths}, max_depth, max_sidecars }
-- @treturn table array of records
function Sidecar.scan(options)
    options = options or {}
    local roots = options.dirs or Sidecar.DEVICE_DIRS
    local max_depth = numberOf(options.max_depth) or Sidecar.SCAN_LIMITS.depth
    local max_sidecars = numberOf(options.max_sidecars) or Sidecar.SCAN_LIMITS.sidecars
    local suffix_length = #Sidecar.SIDECAR_SUFFIX

    local records = {}
    local visited = {}
    local pending = {}
    for root_index = 1, #(roots or {}) do
        local root = textOf(roots[root_index])
        if root ~= "" then
            root = root:gsub("/+$", "")
            if root ~= "" then pending[#pending + 1] = { path = root, depth = 0 } end
        end
    end

    local cursor = 1
    local directories = 0
    while cursor <= #pending and #records < max_sidecars do
        local node = pending[cursor]
        cursor = cursor + 1
        if not visited[node.path] and directories < Sidecar.SCAN_LIMITS.directories then
            visited[node.path] = true
            directories = directories + 1
            local names = Sidecar.io.list(node.path)
            for name_index = 1, #(names or {}) do
                local name = textOf(names[name_index])
                if name ~= "" and name:sub(1, 1) ~= "." then
                    local child = node.path .. "/" .. name
                    if #name > suffix_length
                        and name:sub(-suffix_length) == Sidecar.SIDECAR_SUFFIX
                    then
                        -- A sidecar directory names its book by the same path
                        -- without the suffix, whether or not the file is still
                        -- there.
                        local book_path = child:sub(1, #child - suffix_length)
                        local record = Sidecar.read(book_path)
                        if record then
                            record.sidecar_dir = child
                            records[#records + 1] = record
                        end
                    elseif node.depth < max_depth then
                        -- Only real directories are queued: on a Kindle the
                        -- roots also hold book files, and queueing those would
                        -- cost one failed directory open each. Without
                        -- LuaFileSystem the mode is unknown, so queue and let
                        -- `list` answer nil.
                        local mode = Sidecar.io.attributes(child, "mode")
                        if mode == "directory" or mode == nil then
                            pending[#pending + 1] = { path = child, depth = node.depth + 1 }
                        end
                    end
                end
            end
        end
    end

    -- Newest-read first: the last book opened is the one a reader looks for.
    table.sort(records, function(left, right)
        local left_stamp = numberOf(left.modified) or 0
        local right_stamp = numberOf(right.modified) or 0
        if left_stamp ~= right_stamp then return left_stamp > right_stamp end
        return Sidecar.fileName(left.book_path) < Sidecar.fileName(right.book_path)
    end)
    return records
end

--- Best available title for one record: its own metadata, then its file name.
-- @tparam table record
-- @treturn string never nil
function Sidecar.displayTitle(record)
    if type(record) ~= "table" then return "" end
    local title = textOf(record.title)
    if title ~= "" then return title end
    return Sidecar.fileStem(record.book_path)
end

--- Indexes records for catalog/session matching.
-- Built once per scan and shared by every row of every view, so matching N
-- entries costs one table lookup instead of N record scans.
-- @tparam table records result of `Sidecar.scan`
-- @treturn table { by_stem = {}, by_title = {}, records = {} }
function Sidecar.index(records)
    local index = { by_stem = {}, by_title = {}, records = {} }
    for record_index = 1, #(records or {}) do
        local record = records[record_index]
        if type(record) == "table" then
            record.normalized_stem = Sidecar.stemKey(record.book_path)
            record.normalized_title = Sidecar.normalize(record.title)
            record.normalized_authors = Sidecar.authorList(record.authors)
            if record.normalized_stem ~= "" then
                index.by_stem[record.normalized_stem] = record
            end
            if record.normalized_title ~= "" then
                index.by_title[record.normalized_title] = record
            end
            index.records[#index.records + 1] = record
        end
    end
    -- `records` stays in the scan's newest-first order, so the partial-match
    -- pass below prefers the book read most recently when two books share a
    -- title prefix.
    return index
end

--- True when `title` appears in `stem` as whole words rather than as a prefix.
--
-- A plain substring test is not good enough on a light-novel device: "spice and
-- wolf vol 1" is a prefix of "spice and wolf vol 11 isuna hasekura", so Vol. 1
-- would inherit Vol. 11's progress, its highlight count and its "Open book"
-- target. The match therefore has to begin and end on a non-word boundary.
-- @string stem normalized file stem
-- @string title normalized title
-- @treturn boolean
local function containsWholeTitle(stem, title)
    if stem == "" or title == "" then return false end
    local from_index = 1
    while true do
        local found_start, found_end = stem:find(title, from_index, true)
        if not found_start then return false end
        local before = ""
        if found_start > 1 then before = stem:sub(found_start - 1, found_start - 1) end
        local after = ""
        if found_end < #stem then after = stem:sub(found_end + 1, found_end + 1) end
        local before_is_boundary = before == "" or before == " " or not before:match("%w")
        local after_is_boundary = after == "" or after == " " or not after:match("%w")
        if before_is_boundary and after_is_boundary then return true end
        from_index = found_end + 1
    end
end

--- Finds the local record for one catalog entry or server session.
--
-- Precedence mirrors `Status.findSession`: the exact file name this plugin
-- would have downloaded, then the document's own title, then a title contained
-- in a file name with an author in common when both sides name authors. A false
-- match is worse than no match here - it would show a different book's
-- progress and highlights - so the last rule stays conservative.
-- @tparam table index result of `Sidecar.index`
-- @tparam table keys { stem = string, title = string, authors = table }
-- @treturn table|nil record
function Sidecar.find(index, keys)
    if type(index) ~= "table" or type(keys) ~= "table" then return nil end
    local stem = textOf(keys.stem)
    if stem ~= "" and type(index.by_stem) == "table" and index.by_stem[stem] then
        return index.by_stem[stem]
    end
    local title = textOf(keys.title)
    if title == "" then return nil end
    local authors = type(keys.authors) == "table" and keys.authors or {}

    -- A title match still has to agree on the author when both sides name one:
    -- two different books can share a title entirely (a generic "Collected
    -- Poems", a same-named translation), and inheriting another book's progress
    -- is worse than showing none.
    local function authorsAgree(record)
        local record_authors = record.normalized_authors or {}
        if #authors == 0 or #record_authors == 0 then return true end
        return Sidecar.sharesAuthor(authors, record_authors)
    end

    local exact = type(index.by_title) == "table" and index.by_title[title] or nil
    if exact and authorsAgree(exact) then return exact end

    local candidates = index.records or {}
    for record_index = 1, #candidates do
        local record = candidates[record_index]
        if containsWholeTitle(textOf(record.normalized_stem), title)
            and authorsAgree(record)
        then
            return record
        end
    end
    return nil
end

--- Groups records into one entry per book that actually has highlights.
-- Books with no annotations are left out, so the view says "no highlights"
-- instead of listing every book that has none. Groups are ordered by their
-- newest highlight, and each group's own annotations are already newest first
-- (see `Sidecar.normalizeRecord`).
-- @tparam table records result of `Sidecar.scan`
-- @treturn table array of { book_path, sidecar_path, title, authors,
--                           annotations, annotation_count, newest }
function Sidecar.highlightGroups(records)
    local groups = {}
    for record_index = 1, #(records or {}) do
        local record = records[record_index]
        if type(record) == "table"
            and type(record.annotations) == "table"
            and #record.annotations > 0
        then
            local newest_annotation = record.annotations[1]
            groups[#groups + 1] = {
                book_path = textOf(record.book_path),
                sidecar_path = textOf(record.sidecar_path),
                title = Sidecar.displayTitle(record),
                authors = textOf(record.authors),
                annotations = record.annotations,
                annotation_count = #record.annotations,
                newest = numberOf(newest_annotation.timestamp) or 0,
            }
        end
    end
    table.sort(groups, function(left, right)
        if left.newest ~= right.newest then return left.newest > right.newest end
        return left.title < right.title
    end)
    return groups
end

--- The quote one highlight row shows, proven to be a string.
-- @tparam table annotation
-- @treturn string never nil
function Sidecar.annotationText(annotation)
    if type(annotation) ~= "table" then return "" end
    local text = textOf(annotation.text)
    if text == "" then text = textOf(annotation.note) end
    return text
end

--- The note attached to one highlight, or "".
-- @tparam table annotation
-- @treturn string never nil
function Sidecar.annotationNote(annotation)
    if type(annotation) ~= "table" then return "" end
    return textOf(annotation.note)
end

--- Colour or style marker for one highlight, or "" when it has neither.
-- Verified absent on the device: this book's annotations carried no `color`
-- and no `drawer` at all. "" therefore means "default highlight", and a row
-- must render without it rather than print "unknown".
-- @tparam table annotation
-- @treturn string e.g. "yellow" / "strikeout" / ""
function Sidecar.styleLabel(annotation)
    if type(annotation) ~= "table" then return "" end
    local color = textOf(annotation.color)
    if color ~= "" then return color end
    return textOf(annotation.drawer)
end

--- Page number of one highlight, when the sidecar recorded one.
-- @tparam table annotation
-- @treturn number|nil
function Sidecar.annotationPage(annotation)
    if type(annotation) ~= "table" then return nil end
    local page = numberOf(annotation.pageno)
    if not page or page < 1 then return nil end
    return math.floor(page)
end

return Sidecar
