# PR13 Independent Oracle Re-Review — final repair

## Review provenance

- Repository: `https://github.com/Ospeto/home-reading-stack/pull/13`
- Exact reviewed head: `108a55b8376f2919d4c0d7bab3661be1734deb07`
- Reviewer: fresh independent Oracle worker (`oracle-final-pr13-v6`), review-only
- Review scope: `origin/main...108a55b8376f2919d4c0d7bab3661be1734deb07`

## Verdict

**PASS — authorized findings repaired.**

### SQLite lifecycle

The reviewer enumerated all request-scoped production `new Database(...)` sites for KOSync and related public reads:

- `uploader/bot.ts`: lines 618, 791, 1138, 1187, 1391, 1462, 1615
- `uploader/server.ts`: lines 808, 1730, 1800, 1833

All close deterministically in `finally` blocks (with the existing guarded normal-path close in recent-books), covering success, empty results, and thrown errors. Regression coverage exercises a successful empty `progress` table and a missing-schema thrown-query path, asserting one close for each.

### Job-record URL redaction

`redactJobRecord` now protects URL structure while sanitizing surrounding strings, uses callback replacements, preserves literal `$1`, and fully redacts ordinary, encoded, slash-containing, dollar-containing, `api_key`, `api-key`, and `authorization` query values plus password and username-only URL userinfo credentials. Exact URL assertions cover these cases in `uploader/security-jobs.test.ts`.

## Verification cited by reviewer

- Focused suite: 65 passed, 0 failed
- Full suite: 154 passed, 0 failed
- Worktree clean at reviewed head
- No material out-of-scope findings reported

The prior durable report remains preserved at `report.md`.
