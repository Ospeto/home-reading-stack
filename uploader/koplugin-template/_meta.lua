local _ = require("gettext")

return {
    fullname = _("LightHouse library"),
    description = _([[Browse, search and download books from your LightHouse Reading HQ library, with on-device reading progress and ratings.

Generated and pre-configured by your LightHouse server: no URL or password entry is required on this device. The plugin reads the existing OPDS catalog and KOSync progress endpoints, so it keeps working when the server is updated.]]),
}
