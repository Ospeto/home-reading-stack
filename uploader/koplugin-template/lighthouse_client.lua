--[[--
HTTP client for the LightHouse plugin.

Wraps LuaSocket the same way KOReader's own plugins do
(`socket.http` / `socket.https` + `ltn12` + `socketutil` timeouts) so the
device's proxy settings keep working without adding a dependency.

The transport is chosen from the configured URL scheme: `https://` goes through
`socket.https` (LuaSocket's TLS wrapper) and `http://` stays on plain
`socket.http`. A device build without TLS support gets a clear
`https_unavailable` error instead of a connection that silently goes nowhere.

Redirects (`301/302/303/307/308`) are followed up to `MAX_REDIRECTS` hops, with
relative `Location` headers resolved against the request URL, so a server or
reverse proxy that moves a route does not break downloads on the device.

Authentication reuses the server's existing scheme: the plugin sends the
API key as `X-API-Key` (one of the methods `authenticateRequest()` already
accepts). The key lives in the generated `lighthouse_config.lua`, never in a
URL query string, and is never written to the KOReader log.
]]

local http = require("socket.http")
local lfs = require("libs/libkoreader-lfs")
local ltn12 = require("ltn12")
local socketutil = require("socketutil")

local Client = {}

--- Redirects followed before giving up, matching a browser's budget.
local MAX_REDIRECTS = 5

--- Smallest plausible EPUB payload, in bytes.
local MIN_DOWNLOAD_BYTES = 256

--- Status codes that mean "read the Location header instead of the body".
local REDIRECT_CODES = {
    [301] = true,
    [302] = true,
    [303] = true,
    [307] = true,
    [308] = true,
}

--- Status codes on POST that replay the same method/body at Location.
local POST_REDIRECT_CODES = {
    [307] = true,
    [308] = true,
}

-- Kept in sync with the values the generator writes into lighthouse_config.lua.
local DEFAULT_REQUEST_BLOCK_TIMEOUT = 10
local DEFAULT_REQUEST_TOTAL_TIMEOUT = 90
local DEFAULT_DOWNLOAD_BLOCK_TIMEOUT = 15
local DEFAULT_DOWNLOAD_TOTAL_TIMEOUT = 300
local DEFAULT_GET_RETRIES = 1
local DEFAULT_DOWNLOAD_RETRIES = 1
local DEFAULT_RETRY_DELAY_SECONDS = 0.4

--- Longest `Retry-After` the plugin will actually wait for, in seconds.
-- A server that asks for minutes is asking the reader to hold a spinner that
-- long; one bounded retry after this ceiling is still better than none.
local MAX_RETRY_AFTER_SECONDS = 10

-- `429 Too Many Requests` is a retry-later signal, not a permanent refusal, so
-- it belongs here with the gateway errors rather than with the 4xx the plugin
-- must not replay (401/403/404 mean the request itself is wrong).
local RETRYABLE_HTTP_CODES = {
    [429] = true,
    [502] = true,
    [503] = true,
    [504] = true,
}

--- True when a failed request looks transient and safe to replay.
-- @number|nil code HTTP status code (nil on socket failure)
-- @string|nil err internal error code
-- @treturn boolean
local function isTransientFailure(code, err)
    if code then
        return RETRYABLE_HTTP_CODES[code] == true
    end
    local msg = tostring(err or ""):lower()
    if msg == "not_configured" or msg == "https_unavailable"
        or msg == "too_many_redirects" or msg == "invalid_redirect"
        or msg:sub(1, 11) == "file_error:"
        or msg:find("unexpected status", 1, true) ~= nil then
        return false
    end
    return msg:find("timeout", 1, true) ~= nil
        or msg:find("closed", 1, true) ~= nil
        or msg:find("reset", 1, true) ~= nil
        or msg:find("refused", 1, true) ~= nil
        or msg:find("temporarily", 1, true) ~= nil
        or msg:find("unreachable", 1, true) ~= nil
        or msg:find("broken pipe", 1, true) ~= nil
end

--- Sleeps briefly before retrying when LuaSocket is available.
-- @number seconds
local function sleepSeconds(seconds)
    local delay = tonumber(seconds)
    if not delay or delay <= 0 then return end
    pcall(function()
        local sock = require("socket")
        if type(sock) == "table" and type(sock.sleep) == "function" then
            sock.sleep(delay)
        end
    end)
end

--- Strips a trailing slash so paths can be appended safely.
-- @string url
-- @treturn string
local function trimTrailingSlash(url)
    return (tostring(url or ""):gsub("/+$", ""))
end

--- Returns a positive timeout, or the fallback when the value is unusable.
-- @param value configured timeout (number or numeric string)
-- @number fallback
-- @treturn number
local function numberOr(value, fallback)
    local parsed = tonumber(value)
    if not parsed or parsed ~= parsed or parsed <= 0 then return fallback end
    return parsed
end

--- Returns true when the plugin has a usable server URL baked in.
-- @tparam table config generated config table
-- @treturn boolean
function Client.isConfigured(config)
    return type(config) == "table"
        and type(config.base_url) == "string"
        and config.base_url:match("^https?://") ~= nil
end

--- Builds an absolute request URL from the configured base URL.
-- @tparam table config generated config table
-- @string path e.g. "/api/opds?start=0"
-- @treturn string
function Client.buildUrl(config, path)
    if type(path) ~= "string" or path == "" then
        return trimTrailingSlash(config and config.base_url)
    end
    if path:match("^https?://") then
        return path
    end
    if path:sub(1, 1) ~= "/" then
        path = "/" .. path
    end
    return trimTrailingSlash(config and config.base_url) .. path
end

--- Builds the request headers, including the pre-configured API key.
-- @tparam table config generated config table
-- @treturn table headers
function Client.buildHeaders(config)
    local headers = {
        ["Accept"] = "application/atom+xml,application/json;q=0.9,*/*;q=0.8",
        ["User-Agent"] = "LightHouse-KOReader/" .. tostring(config and config.plugin_version or "0"),
    }
    local api_key = config and config.api_key
    if type(api_key) == "string" and api_key ~= "" then
        headers["X-API-Key"] = api_key
    end
    return headers
end

--- Returns the LuaSocket transport that speaks the URL's scheme.
-- LuaSocket's TLS wrapper is loaded lazily so a device build without it can
-- still reach a LAN server over plain HTTP.
-- @string url
-- @treturn table|nil transport module (`socket.http` or `socket.https`)
-- @treturn string|nil error description
local https_transport
local function pickTransport(url)
    if type(url) == "string" and url:lower():match("^https://") then
        if https_transport == nil then
            local ok, loaded = pcall(require, "socket.https")
            if not ok or type(loaded) ~= "table" or type(loaded.request) ~= "function" then
                return nil, "https_unavailable"
            end
            https_transport = loaded
        end
        return https_transport
    end
    return http
end

--- Case-insensitive response-header lookup.
-- @tparam table headers
-- @string name
-- @treturn string|nil
local function headerValue(headers, name)
    if type(headers) ~= "table" or type(name) ~= "string" then return nil end
    local wanted = name:lower()
    for key, value in pairs(headers) do
        if type(key) == "string" and key:lower() == wanted then
            return tostring(value)
        end
    end
    return nil
end

--- Reads a `Retry-After` header as a bounded number of seconds.
-- Only the delta-seconds form is understood; an HTTP-date needs a wall clock
-- the plugin does not carry, so it falls back to the caller's own delay. The
-- ceiling keeps a server asking for minutes from pinning a spinner that long.
-- @tparam table|nil response_headers headers of the refusal
-- @treturn number|nil seconds to wait, when the header carried a usable value
local function retryAfterSeconds(response_headers)
    local raw = tonumber(headerValue(response_headers, "retry-after"))
    if not raw or raw ~= raw then return nil end
    if raw < 0 then return 0 end
    if raw > MAX_RETRY_AFTER_SECONDS then return MAX_RETRY_AFTER_SECONDS end
    return raw
end

--- Resolves a (possibly relative) Location header against the request URL.
-- @string base URL the request was made against
-- @string location raw Location header
-- @treturn string|nil absolute URL
function Client.resolveRedirect(base, location)
    if type(location) ~= "string" then return nil end
    location = location:gsub("^%s+", ""):gsub("%s+$", "")
    if location == "" then return nil end
    if location:match("^%a[%w+%-%.]*://") then return location end

    local scheme, authority = tostring(base):match("^(%a[%w+%-%.]*)://([^/]*)")
    if not scheme or authority == "" then return nil end

    if location:sub(1, 2) == "//" then
        return scheme .. ":" .. location
    end
    if location:sub(1, 1) == "/" then
        return scheme .. "://" .. authority .. location
    end

    -- A query-only reference (`?start=40`) keeps the current path.
    if location:sub(1, 1) == "?" then
        local query_path = tostring(base):gsub("^%a[%w+%-%.]*://[^/]*", ""):gsub("[?#].*$", "")
        if query_path == "" then query_path = "/" end
        return scheme .. "://" .. authority .. query_path .. location
    end

    -- Relative path: resolve against the directory of the request URL, ignoring
    -- any query string or fragment it carries.
    local path = tostring(base):gsub("^%a[%w+%-%.]*://[^/]*", ""):gsub("[?#].*$", "")
    path = path:gsub("/[^/]*$", "/")
    if path == "" or path:sub(1, 1) ~= "/" then path = "/" end
    return scheme .. "://" .. authority .. path .. location
end

--- Returns true when the payload is a web page rather than a feed or a book.
-- A captive portal or a login page answered with HTTP 200 otherwise ends up
-- saved as a broken `.epub` on the device.
-- @string text beginning of the payload
-- @treturn boolean
local function looksLikeHtmlDocument(text)
    if type(text) ~= "string" or text == "" then return false end
    local head = text:sub(1, 512):gsub("^\239\187\191", ""):lower()
    head = head:gsub("^%s+", "")
    return head:match("^<!doctype%s+html") ~= nil
        or head:match("^<html") ~= nil
        or head:match("^<head") ~= nil
end

--- Builds an ltn12 sink that streams into an already-open file handle.
-- `ltn12.sink.file` closes the handle at end of stream, which would make
-- redirect handling impossible, so the caller keeps ownership of the file.
-- @param handle writable file handle
-- @treturn function sink
local function fileSink(handle)
    return function(chunk, err)
        if chunk then
            local written, write_err = handle:write(chunk)
            if not written then
                return nil, string.format("file_error: %s", tostring(write_err or err or "write_error"))
            end
        end
        return 1
    end
end

--- Performs one HTTP request (`GET` by default, or `POST` with `source`).
-- @string url absolute URL
-- @param sink ltn12 sink
-- @tparam table headers request headers
-- @string[opt="GET"] method HTTP method
-- @param[opt] source ltn12 source for request body
-- @treturn number|nil status code
-- @treturn table|nil response headers
-- @treturn string|nil error description
local function requestOnce(url, sink, headers, method, source)
    local transport, transport_err = pickTransport(url)
    if not transport then
        return nil, nil, transport_err
    end

    local ok, leading, code, response_headers = pcall(transport.request, {
        url = url,
        method = method or "GET",
        headers = headers,
        source = source,
        sink = sink,
        -- LuaSocket follows redirects internally when unset, forwarding the
        -- full header set (including X-API-Key) to every hop and returning
        -- only the final response — which would bypass stripApiKeyCrossHost.
        -- Disable it so Client.get/Client.download/Client.postJson's own
        -- redirect loop is authoritative.
        redirect = false,
    })
    if not ok then
        return nil, nil, string.format("network_error: %s", tostring(leading))
    end
    -- LuaSocket reports its own failures as (nil, errmsg), even though a
    -- successful request returns (1, code, headers).
    if leading == nil then
        -- Sink write failures already carry their own code; do not relabel a
        -- full disk as a network outage.
        local detail = tostring(code or "unknown")
        -- Plain-string prefix check: string.find with plain=true treats "^"
        -- as a literal caret, so an anchored find would never match here.
        if detail:sub(1, 11) == "file_error:" then
            return nil, nil, detail
        end
        return nil, nil, string.format("network_error: %s", detail)
    end

    local status = tonumber(code)
    if not status then
        return nil, nil, string.format("network_error: unexpected status %s", tostring(code))
    end
    return status, type(response_headers) == "table" and response_headers or {}, nil
end

--- Follows one redirect hop, or reports why it cannot.
-- @string current URL just requested
-- @tparam table response_headers headers of the redirect response
-- @number redirects hops already taken
-- @treturn string|nil absolute URL of the next hop
-- @treturn string|nil error description
local function nextHop(current, response_headers, redirects)
    if redirects >= MAX_REDIRECTS then
        return nil, "too_many_redirects"
    end
    local next_url = Client.resolveRedirect(current, headerValue(response_headers, "location"))
    if not next_url then
        return nil, "invalid_redirect"
    end
    return next_url
end

--- Extracts the authority (scheme-host-port) of an absolute URL.
-- @string url
-- @treturn string|nil
local function urlAuthority(url)
    if type(url) ~= "string" then return nil end
    return url:lower():match("^%a[%w+%-%.]+://([^/#?]*)")
end

--- Drops the API key when a redirect crosses to a different host.
-- Browsers never forward auth headers to another origin while following a
-- redirect; a captive portal or login host must not receive the server key.
-- @tparam table headers request headers (mutated)
-- @string current URL just requested
-- @string next_url redirect target
local function stripApiKeyCrossHost(headers, current, next_url)
    local current_authority = urlAuthority(current)
    local next_authority = urlAuthority(next_url)
    if current_authority and next_authority and current_authority ~= next_authority then
        headers["X-API-Key"] = nil
    end
end

--- GETs a URL and returns the response body.
-- Retries once on transient socket/5xx errors unless `options.max_retries == 0`.
-- Supports conditional requests via `options.etag` (`If-None-Match` -> `"not_modified"`).
-- @tparam table config generated config table
-- @string path absolute URL or path relative to base_url
-- @tparam[opt] table options { etag = string, max_retries = number, retry_delay = number }
-- @treturn string|nil body
-- @treturn string|nil error description (or `"not_modified"` on 304)
-- @treturn table|nil { status = number, etag = string|nil }
function Client.get(config, path, options)
    if not Client.isConfigured(config) then
        return nil, "not_configured"
    end

    options = type(options) == "table" and options or {}
    local max_retries = DEFAULT_GET_RETRIES
    if options.max_retries ~= nil then
        local parsed_retries = tonumber(options.max_retries)
        if parsed_retries and parsed_retries >= 0 then
            max_retries = math.floor(parsed_retries)
        end
    end
    local retry_delay = DEFAULT_RETRY_DELAY_SECONDS
    if options.retry_delay ~= nil then
        local parsed_delay = tonumber(options.retry_delay)
        if parsed_delay and parsed_delay >= 0 then
            retry_delay = parsed_delay
        end
    end

    local block_timeout = numberOr(config.request_block_timeout, DEFAULT_REQUEST_BLOCK_TIMEOUT)
    local total_timeout = numberOr(config.request_total_timeout, DEFAULT_REQUEST_TOTAL_TIMEOUT)
    local chunks, code, response_headers, err

    for attempt = 0, max_retries do
        if attempt > 0 then
            sleepSeconds(retry_delay)
        end
        local headers = Client.buildHeaders(config)
        if type(options.etag) == "string" and options.etag ~= "" then
            headers["If-None-Match"] = options.etag
        end
        local current = Client.buildUrl(config, path)
        local redirects = 0

        socketutil:set_timeout(block_timeout, total_timeout)
        while true do
            chunks = {}
            code, response_headers, err = requestOnce(current, ltn12.sink.table(chunks), headers)
            if not code or not REDIRECT_CODES[code] then
                break
            end
            local next_url, redirect_err = nextHop(current, response_headers, redirects)
            if not next_url then
                code, err = nil, redirect_err
                break
            end
            redirects = redirects + 1
            stripApiKeyCrossHost(headers, current, next_url)
            current = next_url
        end
        socketutil:reset_timeout()

        if code == 200 or code == 304 then
            break
        end
        if attempt >= max_retries or not isTransientFailure(code, err) then
            break
        end
    end

    if not code then
        return nil, err or "network_error"
    end
    local response_etag = headerValue(response_headers, "etag")
    if code == 304 then
        return nil, "not_modified", { status = 304, etag = response_etag }
    end
    if code ~= 200 then
        return nil, string.format("http_%d", code), { status = code, etag = response_etag }
    end

    local body = table.concat(chunks)
    if looksLikeHtmlDocument(body) then
        return nil, "html_response"
    end
    return body, nil, { status = 200, etag = response_etag }
end

--- POSTs a JSON payload and returns the response body.
-- Follows only `307`/`308` redirects so the method and JSON body are preserved
-- across hops, and strips `X-API-Key` if a redirect crosses hosts.
-- @tparam table config generated config table
-- @string path absolute URL or path relative to base_url
-- @string json_body serialized JSON payload
-- @number[opt] max_seconds ceiling for block/total timeouts
-- @treturn string|nil body
-- @treturn string|nil error description
function Client.postJson(config, path, json_body, max_seconds)
    if not Client.isConfigured(config) then
        return nil, "not_configured"
    end

    local payload = type(json_body) == "string" and json_body or ""
    local headers = Client.buildHeaders(config)
    headers["Content-Type"] = "application/json"
    headers["Content-Length"] = tostring(#payload)

    local current = Client.buildUrl(config, path)
    local redirects = 0
    local chunks = {}
    local code, response_headers, err

    local block_timeout = numberOr(config.request_block_timeout, DEFAULT_REQUEST_BLOCK_TIMEOUT)
    local total_timeout = numberOr(config.request_total_timeout, DEFAULT_REQUEST_TOTAL_TIMEOUT)
    local ceiling = tonumber(max_seconds)
    if ceiling and ceiling > 0 then
        if block_timeout > ceiling then block_timeout = ceiling end
        if total_timeout > ceiling then total_timeout = ceiling end
    end

    socketutil:set_timeout(block_timeout, total_timeout)
    while true do
        chunks = {}
        code, response_headers, err = requestOnce(
            current,
            ltn12.sink.table(chunks),
            headers,
            "POST",
            ltn12.source.string(payload)
        )
        if not code or not POST_REDIRECT_CODES[code] then
            break
        end
        local next_url, redirect_err = nextHop(current, response_headers, redirects)
        if not next_url then
            code, err = nil, redirect_err
            break
        end
        redirects = redirects + 1
        stripApiKeyCrossHost(headers, current, next_url)
        current = next_url
    end
    socketutil:reset_timeout()

    if not code then
        return nil, err or "network_error"
    end
    if code ~= 200 and code ~= 201 and code ~= 204 then
        return nil, string.format("http_%d", code)
    end

    local body = table.concat(chunks)
    if looksLikeHtmlDocument(body) then
        return nil, "html_response"
    end
    return body, nil
end

--- Downloads a URL into a local file.
-- @tparam table config generated config table
-- @string url absolute URL (a path relative to base_url also works)
-- @string filepath destination path
-- @number[opt] max_seconds ceiling for both timeouts, for a caller with a
--   smaller budget of its own than a whole EPUB download (cover thumbnails)
-- @treturn boolean|nil success
-- @treturn string|nil error description
function Client.download(config, url, filepath, max_seconds)
    if not Client.isConfigured(config) then
        return nil, "not_configured"
    end

    local part_path = tostring(filepath) .. ".part"
    local block_timeout = numberOr(config.download_block_timeout, DEFAULT_DOWNLOAD_BLOCK_TIMEOUT)
    local total_timeout = numberOr(config.download_total_timeout, DEFAULT_DOWNLOAD_TOTAL_TIMEOUT)
    -- One number caps both, so a caller cannot accidentally leave a stalled
    -- socket operation with more time than its whole budget.
    local ceiling = tonumber(max_seconds)
    if ceiling and ceiling > 0 then
        if block_timeout > ceiling then block_timeout = ceiling end
        if total_timeout > ceiling then total_timeout = ceiling end
    end

    local code, response_headers, err

    -- A caller that passed its own budget (a cover thumbnail, which has a
    -- per-page time allowance shared with every other cover on that page) gets
    -- one attempt: a second attempt would spend the page's budget twice, and a
    -- cover that misses is refetched on the next open anyway. The EPUB path
    -- has no such allowance, so it earns the retry.
    local max_attempts = (ceiling and ceiling > 0) and 0 or DEFAULT_DOWNLOAD_RETRIES

    -- ONE bounded retry, gated exactly like `Client.get`: a Wi-Fi blip or a
    -- 502/503/504/429 from the tunnel must not cost the reader the volume.
    -- A permanent failure (401/403/404, a redirect loop, a local write error)
    -- is never replayed, and every attempt starts from a clean `.part` file so
    -- a half-written body can never be mixed into the finished EPUB.
    for attempt = 0, max_attempts do
        if attempt > 0 then
            sleepSeconds(retryAfterSeconds(response_headers) or DEFAULT_RETRY_DELAY_SECONDS)
        end

        local handle = io.open(part_path, "wb")
        if not handle then
            return nil, string.format("file_error: cannot write %s", tostring(filepath))
        end

        local headers = Client.buildHeaders(config)
        local current = Client.buildUrl(config, url)
        local redirects = 0

        socketutil:set_timeout(block_timeout, total_timeout)
        while true do
            code, response_headers, err = requestOnce(current, fileSink(handle), headers)
            if not code or not REDIRECT_CODES[code] then
                break
            end
            local next_url, redirect_err = nextHop(current, response_headers, redirects)
            if not next_url then
                code, err = nil, redirect_err
                break
            end
            redirects = redirects + 1
            stripApiKeyCrossHost(headers, current, next_url)
            current = next_url
            -- The redirect body is already in the `.part` file; restart the next hop
            -- cleanly so an interstitial page is never mixed into the EPUB.
            pcall(function() handle:close() end)
            handle = io.open(part_path, "wb")
            if not handle then
                socketutil:reset_timeout()
                os.remove(part_path)
                return nil, string.format("file_error: cannot rewrite %s", tostring(filepath))
            end
        end
        socketutil:reset_timeout()
        pcall(function() handle:close() end)

        local ok_status = code == 200
        if ok_status or attempt >= max_attempts then
            break
        end
        if not isTransientFailure(code, err) then
            break
        end
    end

    if not code then
        os.remove(part_path)
        return nil, err or "network_error"
    end
    if code ~= 200 then
        os.remove(part_path)
        return nil, string.format("http_%d", code)
    end

    -- Guard against a zero-byte, truncated, or HTML interstitial payload.
    local size = lfs.attributes(part_path, "size") or 0
    if size < MIN_DOWNLOAD_BYTES then
        os.remove(part_path)
        return nil, "empty_response"
    end

    local expected_len = tonumber(headerValue(response_headers, "content-length"))
    if expected_len and expected_len > 0 and size < expected_len then
        os.remove(part_path)
        return nil, "truncated_download"
    end

    local probe = io.open(part_path, "rb")
    if probe then
        local head = probe:read(512)
        probe:close()
        if looksLikeHtmlDocument(head) then
            os.remove(part_path)
            return nil, "html_response"
        end
    end

    local ok_rename, rename_err = os.rename(part_path, filepath)
    if not ok_rename then
        os.remove(part_path)
        return nil, string.format("file_error: %s", tostring(rename_err or "rename_failed"))
    end

    return true, nil
end

return Client
