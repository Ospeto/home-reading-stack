--[[--
LightHouse plugin configuration.

THIS TEMPLATE COPY CONTAINS NO CREDENTIALS. It is committed with empty values
so the template stays readable and the plugin degrades to a clear
"not configured" message if someone copies the folder by hand.

The LightHouse server regenerates this file for every download
(`GET /api/koplugin/download`) with the server origin the request arrived on
and the current server API key, so the device never has to type a URL or a
password.

Fields:
    base_url    LightHouse Reading HQ origin, e.g. "http://192.168.31.15:8086"
                or "https://reading-sg.wavypremium.xyz:8443" (the client picks
                socket.https for https:// and socket.http for http://).
    api_key     Server API key (READING_API_KEY); empty when the server has none
    page_size   Catalog entries requested per page
    plugin_version  Version of the generated plugin payload
    generated_at    ISO 8601 timestamp of the download, for the Connection view

Timeouts, in seconds. Each request has a per-socket-operation limit (block) and
a whole-request budget (total); the total is generous because the first catalog
page over the WAN tunnel on slow Wi-Fi is much larger than an API call.

    request_block_timeout   Per-operation limit for catalog/progress requests
    request_total_timeout   Whole-request budget for catalog/progress requests
    download_block_timeout  Per-operation limit for EPUB downloads
    download_total_timeout  Whole-request budget for EPUB downloads
]]

return {
    base_url = "",
    api_key = "",
    page_size = 40,
    plugin_version = "1.6.4",
    generated_at = "",
    request_block_timeout = 10,
    request_total_timeout = 90,
    download_block_timeout = 15,
    download_total_timeout = 300,
}
