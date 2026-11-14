--[[--
HTTP client for the LightHouse plugin.

Wraps LuaSocket the same way KOReader's own plugins do
(`socket.http` + `ltn12` + `socketutil` timeouts) so HTTPS, redirects and the
device's proxy settings keep working without adding a dependency.

Authentication reuses the server's existing scheme: the plugin sends the
API key as `X-API-Key` (one of the methods `authenticateRequest()` already
accepts). The key lives in the generated `lighthouse_config.lua`, never in a
URL query string, and is never written to the KOReader log.
]]

local http = require("socket.http")
local lfs = require("libs/libkoreader-lfs")
local ltn12 = require("ltn12")
local socket = require("socket")
local socketutil = require("socketutil")

local Client = {}

--- Strips a trailing slash so paths can be appended safely.
-- @string url
-- @treturn string
local function trimTrailingSlash(url)
    return (tostring(url or ""):gsub("/+$", ""))
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

--- GETs a URL and returns the response body.
-- @tparam table config generated config table
-- @string path absolute URL or path relative to base_url
-- @treturn string|nil body
-- @treturn string|nil error description
function Client.get(config, path)
    if not Client.isConfigured(config) then
        return nil, "not_configured"
    end

    local chunks = {}
    socketutil:set_timeout(
        config.request_block_timeout or 10,
        config.request_total_timeout or 40
    )
    local ok, code = pcall(function()
        return socket.skip(1, http.request({
            url = Client.buildUrl(config, path),
            method = "GET",
            headers = Client.buildHeaders(config),
            sink = ltn12.sink.table(chunks),
        }))
    end)
    socketutil:reset_timeout()

    if not ok then
        return nil, tostring(code)
    end
    -- LuaSocket returns (nil, errmsg) when the transport itself failed.
    if type(code) ~= "number" then
        return nil, "network_error"
    end
    if code ~= 200 then
        return nil, string.format("http_%d", code)
    end
    return table.concat(chunks), nil
end

--- Downloads a URL into a local file.
-- @tparam table config generated config table
-- @string url absolute URL
-- @string filepath destination path
-- @treturn boolean|nil success
-- @treturn string|nil error description
function Client.download(config, url, filepath)
    if not Client.isConfigured(config) then
        return nil, "not_configured"
    end

    local handle, open_err = io.open(filepath, "wb")
    if not handle then
        return nil, tostring(open_err or "cannot_open_file")
    end

    socketutil:set_timeout(
        config.download_block_timeout or 10,
        config.download_total_timeout or 300
    )
    local ok, code = pcall(function()
        return socket.skip(1, http.request({
            url = url,
            method = "GET",
            headers = Client.buildHeaders(config),
            sink = ltn12.sink.file(handle),
        }))
    end)
    socketutil:reset_timeout()
    pcall(function() handle:close() end)

    if not ok then
        os.remove(filepath)
        return nil, tostring(code)
    end
    if type(code) ~= "number" then
        os.remove(filepath)
        return nil, "network_error"
    end
    if code ~= 200 then
        os.remove(filepath)
        return nil, string.format("http_%d", code)
    end

    -- Guard against a zero-byte or HTML error page masquerading as an EPUB.
    local size = lfs.attributes(filepath, "size") or 0
    if size < 256 then
        os.remove(filepath)
        return nil, "empty_response"
    end
    return true
end

return Client
