--[[--
Highlight sync, active-session matching, and batch download runner for LightHouse.

Extracts highlight payload construction, outbox flushing, cross-device active
session filtering, and per-item progress/cancellable batch downloads (via
KOReader `ui/trapper` when available, with per-item `InfoMessage` fallback)
out of `main.lua` so they stay modular and independently testable.

@module koplugin.lighthouse_sync
]]

local Outbox = require("lighthouse_outbox")
local Sidecar = require("lighthouse_sidecar")
local Status = require("lighthouse_status")

local Sync = {}

--- Builds the `/api/highlights/sync` payload for one sidecar record.
-- @tparam table record normalized record from `Sidecar`
-- @treturn table|nil JSON-serializable payload, or nil when empty
function Sync.buildHighlightSyncPayload(record)
    if type(record) ~= "table" or type(record.annotations) ~= "table" then return nil end
    local entries = {}
    for idx = 1, #record.annotations do
        local ann = record.annotations[idx]
        if type(ann) == "table" then
            local text = Sidecar.annotationText(ann)
            local notes = Sidecar.annotationNote(ann)
            if text ~= "" or notes ~= "" then
                entries[#entries + 1] = {
                    text = text,
                    notes = notes ~= "" and notes or nil,
                    chapter = Status.str(ann.chapter) ~= "" and Status.str(ann.chapter) or nil,
                    page = Sidecar.annotationPage(ann),
                    datetime = Status.str(ann.datetime) ~= "" and Status.str(ann.datetime) or nil,
                }
            end
        end
    end
    if #entries == 0 then return nil end
    local title = Status.str(record.title)
    if title == "" then title = Sidecar.displayTitle(record) end
    local author = Status.str(record.authors)
    if author == "" then author = "Unknown" end
    return {
        title = title,
        author = author,
        progress = Status.num(record.percent_finished),
        entries = entries,
    }
end

--- Deterministic fingerprint `<count>:<newest_datetime>:<total_chars>` for deduping auto-sync.
-- @tparam table record normalized record from `Sidecar`
-- @treturn string
function Sync.highlightFingerprint(record)
    if type(record) ~= "table" or type(record.annotations) ~= "table" then return "0::0" end
    local count = 0
    local newest = ""
    local chars = 0
    for idx = 1, #record.annotations do
        local ann = record.annotations[idx]
        if type(ann) == "table" then
            local text = Sidecar.annotationText(ann)
            local notes = Sidecar.annotationNote(ann)
            if text ~= "" or notes ~= "" then
                count = count + 1
                chars = chars + #text + #notes
                local dt = Status.str(ann.datetime)
                if dt > newest then newest = dt end
            end
        end
    end
    return string.format("%d:%s:%d", count, newest, chars)
end

--- Sends one book's highlights to `/api/highlights/sync` if new or forced.
-- @tparam table deps { config, Client, JSON, settings, logger }
-- @tparam table record normalized sidecar record
-- @tparam[opt] table options { force = boolean, silent = boolean, timeout = number }
-- @treturn boolean ok
-- @treturn string status "synced" | "unchanged" | "empty" | error string
-- @treturn number synced annotation count
function Sync.syncBookHighlights(deps, record, options)
    options = type(options) == "table" and options or {}
    local Client = deps.Client
    local config = deps.config
    local settings = deps.settings
    local JSON = deps.JSON
    local logger = deps.logger

    local payload = Sync.buildHighlightSyncPayload(record)
    if not payload then return false, "empty", 0 end
    if not Client.isConfigured(config) then return false, "not_configured", 0 end

    local book_path = Status.str(record.book_path)
    local fp = Sync.highlightFingerprint(record)
    local raw_map = type(settings) == "table" and settings:readSetting("lighthouse_synced_highlights") or nil
    local map = {}
    if type(raw_map) == "table" then
        for k, v in pairs(raw_map) do map[k] = v end
    end
    if options.force ~= true and book_path ~= "" and map[book_path] == fp then
        Outbox.remove(settings, book_path)
        return true, "unchanged", 0
    end

    local encoded_ok, body = pcall(JSON.encode, payload)
    if not encoded_ok or type(body) ~= "string" then
        return false, "invalid_json", 0
    end

    local res_body, err = Client.postJson(config, "/api/highlights/sync", body, options.timeout or 10)
    if not res_body then
        if options.silent and type(logger) == "table" and type(logger.info) == "function" then
            logger.info("LightHouse: silent highlight sync skipped:", tostring(err))
        end
        return false, err or "network_error", 0
    end

    if book_path ~= "" and type(settings) == "table" and type(settings.saveSetting) == "function" then
        map[book_path] = fp
        settings:saveSetting("lighthouse_synced_highlights", map)
        Outbox.remove(settings, book_path)
    end
    return true, "synced", #payload.entries
end

--- Flushes any pending offline highlight syncs queued when closing books offline.
-- @tparam table deps { config, Client, JSON, settings, logger, NetworkMgr, Sidecar }
-- @tparam[opt] table options { silent = boolean, timeout = number }
-- @tparam[opt] function syncOne optional callback `(record, opts) -> ok, reason, count`
-- @treturn number flushed book count
-- @treturn number remaining queued count
function Sync.flushHighlightOutbox(deps, options, syncOne)
    options = type(options) == "table" and options or {}
    local Client = deps.Client
    local config = deps.config
    local settings = deps.settings
    local NetworkMgr = deps.NetworkMgr
    local sidecar = deps.Sidecar or Sidecar
    local sync_fn = type(syncOne) == "function" and syncOne
        or function(rec, opts) return Sync.syncBookHighlights(deps, rec, opts) end

    if not Client.isConfigured(config) then
        return 0, Outbox.count(settings)
    end
    local pending = Outbox.list(settings)
    if #pending == 0 then return 0, 0 end
    if type(NetworkMgr) == "table" and type(NetworkMgr.isOnline) == "function" and not NetworkMgr:isOnline() then
        return 0, #pending
    end

    local flushed = 0
    for idx = 1, #pending do
        local book_path = pending[idx]
        if not sidecar.bookExists(book_path) then
            Outbox.remove(settings, book_path)
        else
            local record = sidecar.read(book_path)
            if not record or type(record.annotations) ~= "table" or #record.annotations == 0 then
                Outbox.remove(settings, book_path)
            else
                local ok, reason = sync_fn(record, {
                    silent = true,
                    timeout = options.timeout or 10,
                })
                if ok then
                    Outbox.remove(settings, book_path)
                    if reason == "synced" then
                        flushed = flushed + 1
                    end
                end
            end
        end
    end

    return flushed, Outbox.count(settings)
end

--- Counts normalized server sessions that do not yet exist locally on this device.
-- @tparam table sessions normalized KOSync sessions from `/api/kosync/active`
-- @tparam function resolveLocalPath `(session) -> string|nil`
-- @tparam[opt] table sidecar optional Sidecar module override
-- @treturn number
function Sync.countMissingActiveFromSessions(sessions, resolveLocalPath, sidecar)
    if type(sessions) ~= "table" then return 0 end
    local sc = sidecar or Sidecar
    local count = 0
    for idx = 1, #sessions do
        local session = sessions[idx]
        if type(session) == "table" and Status.num(session.book_id) then
            local resolved = (type(resolveLocalPath) == "function" and resolveLocalPath(session))
                or Status.str(session.book_path)
            if resolved == "" or not sc.bookExists(resolved) then
                count = count + 1
                if count >= 10 then break end
            end
        end
    end
    return count
end

--- Selects active reading sessions missing a local EPUB copy on this device (capped at 10).
-- @tparam table shelf normalized reading shelf sessions
-- @treturn table array of downloadable missing sessions
function Sync.missingActiveSessions(shelf)
    local missing = {}
    if type(shelf) ~= "table" then return missing end
    for idx = 1, #shelf do
        local session = shelf[idx]
        if type(session) == "table" and not session.has_local_file and Status.num(session.book_id) then
            missing[#missing + 1] = session
            if #missing >= 10 then break end
        end
    end
    return missing
end

local function fileExistsOnDisk(lfs_mod, filepath)
    if type(filepath) ~= "string" or filepath == "" then return false end
    if type(lfs_mod) == "table" and type(lfs_mod.attributes) == "function" then
        return lfs_mod.attributes(filepath, "mode") == "file"
    end
    return Sidecar.io.attributes(filepath, "mode") == "file"
end

--- Downloads a batch of EPUB items sequentially with per-volume progress and tap-to-cancel.
-- Uses KOReader `ui/trapper` when present so tapping the screen stops the batch cleanly
-- after the active transfer, and falls back to per-item `InfoMessage` updates otherwise.
-- Invokes `on_complete(result)` inside the runner context (async-safe with `Trapper:wrap`).
-- @tparam table deps { config, Client, UIManager, InfoMessage, squareWidget, formatMessage, gettext, lfs, record_owned }
-- @tparam table items array of `{ label, url, filepath, key, book_id, skip_if_exists }`
-- @tparam[opt] table options { trapper = table, use_trapper = boolean, paused_text = string }
-- @tparam[opt] function on_complete callback receiving `{ total, downloaded, failed, cancelled, pending, remaining, failed_labels, failed_keys, newly_downloaded, completed_keys }`
-- @treturn table|nil result when execution ran synchronously
function Sync.runBatchDownloads(deps, items, options, on_complete)
    options = type(options) == "table" and options or {}
    local total = type(items) == "table" and #items or 0
    if total == 0 then
        local empty_result = {
            total = 0,
            downloaded = 0,
            failed = 0,
            cancelled = false,
            pending = 0,
            remaining = 0,
            failed_labels = {},
            failed_keys = {},
            newly_downloaded = {},
            completed_keys = {},
        }
        if type(on_complete) == "function" then
            on_complete(empty_result)
        end
        return empty_result
    end

    local config = deps.config
    local Client = deps.Client
    local UIManager = deps.UIManager
    local InfoMessage = deps.InfoMessage
    local squareWidget = deps.squareWidget or function(cls, opts) return cls:new(opts) end
    local gettext_fn = deps.gettext or function(s) return s end
    local T_fn = deps.formatMessage or function(tpl, ...) return tpl end
    local lfs_mod = deps.lfs
    local record_owned = deps.record_owned

    local trapper = options.trapper
    if trapper == nil and options.use_trapper ~= false then
        local ok_t, mod_t = pcall(require, "ui/trapper")
        if ok_t and type(mod_t) == "table" then
            trapper = mod_t
        end
    end
    local has_trapper = type(trapper) == "table"
        and type(trapper.wrap) == "function"
        and type(trapper.info) == "function"

    -- A failure has to name the item it belonged to: "3 failed" tells the
    -- reader nothing to retry, while the volume titles do. The error code is
    -- kept too, because the caller knows how to word it (see `describeError`).
    local function downloadOne(item)
        if item.skip_if_exists and fileExistsOnDisk(lfs_mod, item.filepath) then
            return true, false, nil
        end
        if type(item.url) ~= "string" or item.url == "" or type(item.filepath) ~= "string" or item.filepath == "" then
            return false, false, "invalid_response"
        end
        local ok_call, ok_dl, dl_err = pcall(function()
            return Client.download(config, item.url, item.filepath)
        end)
        if ok_call and ok_dl then
            -- Ownership is recorded by id while the batch runs, so a volume
            -- pulled here is owned exactly like one from the detail screen.
            if type(record_owned) == "function" and item.book_id ~= nil then
                pcall(record_owned, item.book_id, item.filepath)
            end
            return true, true, nil
        end
        local err_text
        if ok_call then
            err_text = dl_err
        else
            err_text = "exception: " .. tostring(ok_dl)
        end
        -- An empty code is a failed download with no reason attached; the
        -- caller words it from the error code, so never hand it nil.
        if Status.str(err_text) == "" then err_text = "network_error" end
        return false, false, Status.str(err_text)
    end

    local sync_result

    if has_trapper then
        trapper:wrap(function()
            local downloaded = 0
            local failed = 0
            local cancelled = false
            local pending = 0
            local failed_labels = {}
            local failed_keys = {}
            local failed_items = {}
            local newly_downloaded = {}
            local completed_keys = {}

            pcall(function()
                if type(trapper.setPausedText) == "function" then
                    trapper:setPausedText(Status.str(
                        options.paused_text,
                        gettext_fn("Batch download paused. Stop remaining downloads?")
                    ))
                end
            end)

            for idx = 1, total do
                local item = items[idx]
                local label = Status.str(item and item.label)
                if label == "" then label = gettext_fn("Untitled") end
                local progress_text = T_fn(
                    gettext_fn("Downloading %1/%2: %3\n(Tap screen to cancel)"),
                    tostring(idx),
                    tostring(total),
                    label
                )
                local ok_info, go_on = pcall(function()
                    return trapper:info(progress_text)
                end)
                if (not ok_info) or go_on == false then
                    cancelled = true
                    -- Everything from this item onward was never attempted: it
                    -- is pending, not failed, and not downloaded either.
                    pending = total - idx + 1
                    break
                end

                local ok_item, is_new, item_err = downloadOne(item)
                if ok_item then
                    downloaded = downloaded + 1
                    if is_new then
                        newly_downloaded[#newly_downloaded + 1] = item.filepath
                    end
                    if item.key ~= nil then
                        completed_keys[item.key] = true
                    end
                else
                    failed = failed + 1
                    failed_labels[#failed_labels + 1] = label
                    if item.key ~= nil then failed_keys[#failed_keys + 1] = item.key end
                    failed_items[#failed_items + 1] = { label = label, key = item.key, code = item_err }
                end
            end

            pcall(function()
                if type(trapper.clear) == "function" then
                    trapper:clear()
                end
            end)

            local result = {
                total = total,
                downloaded = downloaded,
                failed = failed,
                cancelled = cancelled,
                -- `pending` counts only the items the cancel left untouched, and
                -- `remaining` stays "still not on this device" (pending plus
                -- failed), so a caller can tell what to retry from what it
                -- could not start.
                pending = pending,
                remaining = math.max(total - downloaded, 0),
                failed_labels = failed_labels,
                failed_keys = failed_keys,
                failed_items = failed_items,
                newly_downloaded = newly_downloaded,
                completed_keys = completed_keys,
            }
            sync_result = result
            if type(on_complete) == "function" then
                on_complete(result)
            end
        end)
        return sync_result
    end

    local downloaded = 0
    local failed = 0
    local pending = 0
    local failed_labels = {}
    local failed_keys = {}
    local failed_items = {}
    local newly_downloaded = {}
    local completed_keys = {}

    for idx = 1, total do
        local item = items[idx]
        local label = Status.str(item and item.label)
        if label == "" then label = gettext_fn("Untitled") end
        local progress_text = T_fn(
            gettext_fn("Downloading %1/%2: %3…"),
            tostring(idx),
            tostring(total),
            label
        )
        local info
        if type(UIManager) == "table" and InfoMessage ~= nil then
            info = squareWidget(InfoMessage, { text = progress_text, dismissable = false })
            pcall(function()
                UIManager:show(info)
                if type(UIManager.forceRePaint) == "function" then
                    UIManager:forceRePaint()
                end
            end)
        end

        local ok_item, is_new, item_err = downloadOne(item)

        if info and type(UIManager) == "table" then
            pcall(function() UIManager:close(info) end)
        end

        if ok_item then
            downloaded = downloaded + 1
            if is_new then
                newly_downloaded[#newly_downloaded + 1] = item.filepath
            end
            if item.key ~= nil then
                completed_keys[item.key] = true
            end
        else
            failed = failed + 1
            failed_labels[#failed_labels + 1] = label
            if item.key ~= nil then failed_keys[#failed_keys + 1] = item.key end
            failed_items[#failed_items + 1] = { label = label, key = item.key, code = item_err }
        end
    end

    local result = {
        total = total,
        downloaded = downloaded,
        failed = failed,
        cancelled = false,
        pending = pending,
        remaining = math.max(total - downloaded, 0),
        failed_labels = failed_labels,
        failed_keys = failed_keys,
        failed_items = failed_items,
        newly_downloaded = newly_downloaded,
        completed_keys = completed_keys,
    }
    if type(on_complete) == "function" then
        on_complete(result)
    end
    return result
end

return Sync
