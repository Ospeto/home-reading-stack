local _ = require("gettext")

return {
    fullname = _("LightHouse library"),
    description = _([[Browse, search, sort and download books from your LightHouse Reading HQ library, with cover thumbnails, on-device reading progress, reading statistics and ratings.

Browse library is one screen with a Books / Authors / Series switch, header Search, interactive sort/filter and A-Z letter jump, and an explicit footer pager. Every row shows a cover thumbnail (or compact text row when covers are off), the title, a secondary line carrying author, series and on-device badge, and a right-hand value column carrying progress and rating stars over a pixel progress bar. The reading statistics screen is ONE page: the headline numbers, the library and year bands side by side, the currently-reading rows, a square-tile 52-week activity heatmap with month axis and shade legend, the recent sessions and one footer line, with no scrolling and no paging.

Progress and highlights are read from this device first: KOReader's own sidecar files (`<book>.sdr`) already hold each book's percentage, highlights and notes, so the Highlights view works with no connection, lets you read full quotes and notes before opening a book, and local progress is preferred over the server's for any book on this device. Nothing is ever written back to those files.

Generated and pre-configured by your LightHouse server: no URL or password entry is required on this device. The plugin reads the existing OPDS catalog, library grouping, KOSync progress and KOSync statistics endpoints, so it keeps working when the server is updated.]]),
}
