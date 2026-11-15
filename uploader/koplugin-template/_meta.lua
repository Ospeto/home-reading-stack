local _ = require("gettext")

return {
    fullname = _("LightHouse library"),
    description = _([[Browse, search and download books from your LightHouse Reading HQ library, with cover thumbnails, on-device reading progress, reading statistics and ratings.

Catalog rows follow one layout everywhere - title first, author and series underneath, and one compact progress/rating column you can read without opening the book - and the reading statistics screen leads with the numbers you check daily before the activity heatmap and library health.

Generated and pre-configured by your LightHouse server: no URL or password entry is required on this device. The plugin reads the existing OPDS catalog, KOSync progress and KOSync statistics endpoints, so it keeps working when the server is updated.]]),
}
