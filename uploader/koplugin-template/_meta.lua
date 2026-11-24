local _ = require("gettext")

return {
    fullname = _("LightHouse library"),
    version = "1.14.0",
    description = _([[Browse, search, sort and download books from your LightHouse Reading HQ library, with cover thumbnails, on-device reading progress, reading statistics and ratings.

Browse library, Book details, Currently reading, Highlights, Device storage and Reading stats all share one square-cornered e-ink PageWidget shell with header Search / Next unread / Sync badges, 1-tap full series batch downloads & Download Later queue with per-volume progress and tap-to-cancel, speculative next-page prefetch & progressive covers, sort/filter & A-Z letter jump, long-press quick actions, auto highlight sync + offline outbox to Obsidian, next-volume suggestions on finish, active-book sync across Kindles, bounded cover & OPDS LRU caches, atomic EPUB downloads & HTTP retries, 1-tap OTA self-updates with CRC-32 & rollback, 1-tap local metadata indexing, and Diagnostics.]]),
}
