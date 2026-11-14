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
    api_key     Server API key (READING_API_KEY); empty when the server has none
    page_size   Catalog entries requested per page
    plugin_version  Version of the generated plugin payload
    generated_at    ISO 8601 timestamp of the download, for the Connection view
]]

return {
    base_url = "",
    api_key = "",
    page_size = 40,
    plugin_version = "1.0.0",
    generated_at = "",
}
