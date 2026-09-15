# PR13 Combined-Tree Oracle Review — durable evidence

## Review provenance

The authorized PR13 starting head was `f6e1719dce96952f48de3c67639efe1fe2e89048` from `https://github.com/Ospeto/home-reading-stack/pull/13`. The originally referenced report was not present in that commit or in the checked-out tree, so this durable report records the complete finding set supplied in the launch brief and the implementation evidence for this repair pass.

## Findings repaired

- **F1 — Retry race / duplicate execution:** manual retry previously updated any job by ID. It now uses an atomic compare-and-set restricted to `status = 'failed'`; active `processing` jobs retain their worker and lease and the API returns `409`.
- **F2 — EPUB fail-open inspection:** marker bytes no longer establish EPUB validity. File inputs require successful, nonempty, parseable `tar -tvf` inspection; nonzero status, signal/timeout, spawn failure, empty output, malformed output, and resource violations fail closed. Buffer inputs fail closed because they cannot receive the same archive inspection gate.
- **F3 — Stable identity conflicts:** `isSameBookIdentity` and `isSameBook` require corresponding stable identifiers on both records and normalized equality. One-sided or conflicting import IDs, Calibre IDs, and ISBNs cannot fall through to title-plus-author matching.
- **F4 — KOSync identity ordering:** KOSync alias resolution is attempted before title lookup, aliases require canonical identity or title-plus-author identity, and title lookup requires author agreement when a KOSync author is present. Same-title/different-author matches are rejected.
- **F5 — Lease recovery race:** recovery updates re-check processing state, expiry, and the originally observed worker identity in the atomic `UPDATE`; live lease renewal or completion prevents recovery.
- **F6 — SQLite handle closure:** KOSync progress, health-dashboard, and active-reading shelf paths close SQLite handles in `finally` blocks on both success and failure.
- **F7 — External-volume portability:** external-volume status probing is omitted when unset and uses `EXTERNAL_VOLUME_STATUS_PATH` (or `EXTERNAL_VOLUME_PATH`) when configured; no host-specific mount is required. `.env.example` documents the optional variable.

## Regression coverage

`uploader/security-jobs.test.ts` covers active-processing retry with a blocked handler and single execution, expired-lease recovery plus live-lease race protection, truncated/fake EPUB markers, one-sided stable identifiers, same-title/different-author KOSync resolution, and optional external-volume configuration. Existing archive, WAN, SSRF, authorization, CSRF, queue, and Calibre-lock tests remain in the suite.

## Security invariants preserved

Public GET/read-only WAN routes remain public. Mutating WAN routes remain authenticated and CSRF-protected. SSRF validation, archive traversal/link/bomb protections, durable queue routing, and migration safety were not weakened.
