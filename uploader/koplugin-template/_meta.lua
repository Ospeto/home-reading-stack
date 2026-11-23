local _ = require("gettext")

return {
    fullname = _("LightHouse library"),
    description = _([[Browse, search, sort and download books from your LightHouse Reading HQ library, with cover thumbnails, on-device reading progress, reading statistics and ratings.

Browse library, Book details, Currently reading, Highlights and Reading stats all share one square-cornered e-ink PageWidget shell with header Search / Next unread actions, sort/filter & A-Z letter jump, long-press quick actions, and a 3-zone footer pager. Every Book Detail card shows the large cover thumbnail, interactive Author/Series links, star rating, pixel progress bar, action buttons and multi-line synopsis.

Progress and highlights are read from this device first: KOReader's own sidecar files (`<book>.sdr`) already hold each book's percentage, highlights and notes, so the Highlights reader displays full multi-line quotes with no connection and lets you review quotes and notes before jumping to the page. Nothing is ever written back to those files.

Generated and pre-configured by your LightHouse server: no URL or password entry is required on this device. The plugin reads the existing OPDS catalog, library grouping, KOSync progress and KOSync statistics endpoints, so it keeps working when the server is updated.]]),
}
