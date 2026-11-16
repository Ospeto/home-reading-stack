local _ = require("gettext")

return {
    fullname = _("LightHouse library"),
    description = _([[Browse, search and download books from your LightHouse Reading HQ library, with cover thumbnails, on-device reading progress, reading statistics and ratings.

Catalog rows follow one layout everywhere - the title leads the row and one right-hand metadata column carries author, series, progress and rating, so nothing needs opening the book - and the reading statistics screen leads with the numbers you check daily before the activity heatmap and library health.

Progress and highlights are read from this device first: KOReader's own sidecar files (`<book>.sdr`) already hold each book's percentage, highlights and notes, so the Highlights view works with no connection, and local progress is preferred over the server's for any book on this device. Nothing is ever written back to those files.

Generated and pre-configured by your LightHouse server: no URL or password entry is required on this device. The plugin reads the existing OPDS catalog, KOSync progress and KOSync statistics endpoints, so it keeps working when the server is updated.]]),
}
