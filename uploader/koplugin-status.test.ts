/**
 * uploader/koplugin-status.test.ts
 *
 * Proof for the KOReader plugin's reading-status merge: `Status.merge` used to
 * call `Status.indexByBookId` once per catalog entry, so rendering a page of N
 * entries rebuilt the whole book-id index N times. The merger now builds it
 * once per page and hands it to `Status.findSession`.
 *
 * These tests drive the real template (`koplugin-template/lighthouse_status.lua`)
 * through a Lua interpreter so the claim is measured rather than asserted:
 *  - the book-id index is built exactly once per page render, at any page size,
 *  - the per-entry path (the old shape) builds it once per matching entry, so
 *    the counter really does distinguish the two,
 *  - both paths resolve every entry to the identical session table, so the
 *    merge is behaviour-identical, not merely similar,
 *  - `Status.indexByBookId` stays the single owner of index construction: an
 *    injected builder changes what the page render matches,
 *  - the page render is not slower than the per-entry path it replaced.
 *
 * Skipped when no Lua interpreter is available, like the rest of the Lua tests.
 */

import { describe, expect, it } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";

import { KOPLUGIN_TEMPLATE_DIR } from "./koplugin";

const LUA_BINARY = Bun.which("luajit") || Bun.which("lua5.1") || Bun.which("lua");
const STATUS_PATH = path.join(KOPLUGIN_TEMPLATE_DIR, "lighthouse_status.lua");

/** Writes a harness script to a scratch directory outside the worktree. */
function writeHarness(name: string, source: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "lighthouse-status-"));
  const file = path.join(dir, name);
  fs.writeFileSync(file, source);
  return file;
}

interface HarnessResult {
  values: Record<string, string>;
  entries: string[];
}

/** Runs a Lua harness and splits its stdout into `key=value` and `entry=` lines. */
function runHarness(source: string): HarnessResult {
  const res = spawnSync(LUA_BINARY as string, [writeHarness("harness.lua", source)], {
    encoding: "utf8",
  });
  expect(res.stderr).toBe("");
  expect(res.status).toBe(0);

  const values: Record<string, string> = {};
  const entries: string[] = [];
  for (const line of res.stdout.split("\n")) {
    if (!line) continue;
    const split = line.indexOf("=");
    expect(split).toBeGreaterThan(0);
    const key = line.slice(0, split);
    const value = line.slice(split + 1);
    if (key === "entry") entries.push(value);
    else values[key] = value;
  }
  return { values, entries };
}

/**
 * Fixture shared by every scenario: a 305-session library plus a 40/200-entry
 * page. Entries cover a book-id hit, a book-id miss that falls through to the
 * title rule, a title-only match, a miss, and a duplicate book id where the
 * newer session must win.
 */
const FIXTURE = `
local Status = assert(loadfile(${JSON.stringify(STATUS_PATH)}))()

local function buildSessions()
    local raw = {
        { bookId = 101, document = "doc-101-newest", percentage = 0.45, timestamp = 1794633720,
          title = "Spice and Wolf, Vol. 1", authors = "Isuna Hasekura", device = "Paperwhite",
          filename = "01 - Spice and Wolf, Vol. 1.epub" },
        { bookId = 101, document = "doc-101-stale", percentage = 0.10, timestamp = 1794000000,
          title = "Spice and Wolf, Vol. 1", authors = "Isuna Hasekura", device = "Kindle",
          filename = "01 - Spice and Wolf, Vol. 1.epub" },
        { bookId = nil, document = "doc-dune", percentage = 0.2, timestamp = 1794633700,
          title = "Dune & Sons", authors = "Frank Herbert", device = "Kobo",
          filename = "Dune & Sons.epub" },
        { bookId = 77, document = "doc-77", percentage = 0.99, timestamp = 1794500000,
          title = "Piranesi", authors = "Susanna Clarke", device = "Paperwhite",
          filename = "Piranesi.epub" },
        { bookId = 999, document = "doc-999", percentage = 0.5, timestamp = 1794600000,
          title = "Bulk Title 7", authors = "Bulk Author 7", device = "Kobo",
          filename = "bulk 7.epub" },
    }
    -- Session-list size is what one index build costs, so keep it realistic.
    for n = 1, 300 do
        raw[#raw + 1] = {
            bookId = 1000 + n,
            document = "bulk-" .. n,
            percentage = (n % 100) / 100,
            timestamp = 1794400000 + n,
            title = "Bulk Title " .. n,
            authors = "Bulk Author " .. n,
            device = "Kobo",
            filename = "bulk " .. n .. ".epub",
        }
    end
    return Status.normalizeSessions(raw)
end

local function buildEntries(count)
    local entries = {
        { book_id = 101, title = "Whatever Else", authors = "Nobody" },
        { book_id = 555, title = "Dune & Sons", authors = "Frank Herbert" },
        { title = "Piranesi", authors = "Susanna Clarke" },
        { title = "Completely Different Book", authors = "No One" },
        { book_id = 77, title = "Piranesi" },
        { book_id = 101, title = "Spice and Wolf, Vol. 1" },
    }
    for n = 1, count - #entries do
        entries[#entries + 1] = {
            book_id = 1000 + n,
            title = "Bulk Title " .. n,
            authors = "Bulk Author " .. n,
        }
    end
    return entries
end

-- Counts every construction of the book-id index, whoever asks for it.
local realIndexByBookId = Status.indexByBookId
local indexBuilds = 0
Status.indexByBookId = function(sessions)
    indexBuilds = indexBuilds + 1
    return realIndexByBookId(sessions)
end
local function resetCounter() indexBuilds = 0 end
`;

describe("plugin status merger: book-id index is built once per page", () => {
  it("builds the index once per page render, not once per entry", () => {
    if (!LUA_BINARY) return;
    const { values } = runHarness(`
${FIXTURE}

local sessions = buildSessions()

-- The old shape: one findSession per entry, no shared index.
local page40Old = buildEntries(40)
resetCounter()
for position, entry in ipairs(page40Old) do
    entry.status = Status.findSession(entry, sessions)
end
print("per_entry_builds_40=" .. indexBuilds)
local withId = 0
for position, entry in ipairs(page40Old) do
    if entry.book_id then withId = withId + 1 end
end
print("entries_with_id_40=" .. withId)

-- One page render.
resetCounter()
Status.merge(buildEntries(40), sessions)
print("page_render_builds_40=" .. indexBuilds)

-- A page render four times the size must still build it once.
resetCounter()
Status.merge(buildEntries(200), sessions)
print("page_render_builds_200=" .. indexBuilds)

-- Callers that already hold an index pay nothing.
local prebuilt = Status.indexByBookId(sessions)
resetCounter()
for position, entry in ipairs(page40Old) do
    Status.findSession(entry, sessions, prebuilt)
end
print("explicit_index_builds=" .. indexBuilds)

resetCounter()
Status.merge(buildEntries(40), sessions, prebuilt)
print("merge_with_index_builds=" .. indexBuilds)

-- The two-argument signature devices already run keeps working.
resetCounter()
Status.merge(buildEntries(40), sessions)
print("legacy_merge_builds=" .. indexBuilds)
`);

    expect(values.entries_with_id_40).toBe("38");
    // Old shape: one build for every entry carrying a resolved Calibre id.
    expect(values.per_entry_builds_40).toBe("38");
    // New shape: one for the whole page, whatever the page size.
    expect(values.page_render_builds_40).toBe("1");
    expect(values.page_render_builds_200).toBe("1");
    expect(values.explicit_index_builds).toBe("0");
    expect(values.merge_with_index_builds).toBe("0");
    expect(values.legacy_merge_builds).toBe("1");
  });

  it("resolves every entry to the same session table as the per-entry path", () => {
    if (!LUA_BINARY) return;
    const { values, entries } = runHarness(`
${FIXTURE}

local sessions = buildSessions()

-- Ordinal in the session list, so a duplicate book id proves which one won.
local ordinal = {}
for position, session in ipairs(sessions) do ordinal[session] = position end

-- Every rendered field of every entry, keyed by the session table itself.
local function fingerprint(page)
    local out = {}
    for position, entry in ipairs(page) do
        local status = entry.status
        if status == nil then
            out[#out + 1] = "entry=" .. position .. ":nil"
        else
            out[#out + 1] = "entry=" .. position .. ":" .. table.concat({
                tostring(ordinal[status]),
                tostring(status.document),
                string.format("%.6f", status.percentage),
                tostring(status.timestamp),
                tostring(status.book_id),
                tostring(status.title),
                tostring(status.device),
                tostring(#status.normalized_authors),
            }, ":")
        end
    end
    return table.concat(out, "\\n")
end

local pageOld = buildEntries(40)
for position, entry in ipairs(pageOld) do
    entry.status = Status.findSession(entry, sessions)
end
print(fingerprint(pageOld))

local pageNew = buildEntries(40)
Status.merge(pageNew, sessions)
local fingerprintNew = fingerprint(pageNew)

-- The shipped two-argument signature and the explicit-index form must both
-- agree with the per-entry path, byte for byte.
local pageLegacy = buildEntries(40)
Status.merge(pageLegacy, sessions)
local fingerprintLegacy = fingerprint(pageLegacy)

local pageExplicit = buildEntries(40)
Status.merge(pageExplicit, sessions, Status.indexByBookId(sessions))
local fingerprintExplicit = fingerprint(pageExplicit)

print("identical=" .. tostring(fingerprint(pageNew) == fingerprint(pageOld)))
print("legacy_identical=" .. tostring(fingerprintLegacy == fingerprint(pageOld)))
print("explicit_identical=" .. tostring(fingerprintExplicit == fingerprint(pageOld)))
local unmatched = 0
for position, entry in ipairs(pageNew) do
    if entry.status == nil then unmatched = unmatched + 1 end
end
print("unmatched=" .. unmatched)
`);

    expect(values.identical).toBe("true");
    expect(values.legacy_identical).toBe("true");
    expect(values.explicit_identical).toBe("true");
    // Every fixture entry matches something except entry 4, which exists to
    // prove a miss stays a miss; an all-nil page would make "identical" true
    // for the wrong reason.
    expect(values.unmatched).toBe("1");
    expect(entries[3]).toBe("4:nil");
    expect(entries).toHaveLength(40);

    // Anchors so a change that breaks both paths identically cannot pass.
    // Entry 1 asks by id, so the newest session for book 101 wins.
    expect(entries[0].split(":").slice(0, 3)).toEqual(["1", "1", "doc-101-newest"]);
    // Entry 2's id is unknown, so it falls through to the title rule and lands
    // on the session that has no Calibre id at all.
    expect(entries[1].split(":").slice(0, 3)).toEqual(["2", "2", "doc-dune"]);
    // Entry 3 supplies no id: title match only.
    expect(entries[2].split(":").slice(0, 3)).toEqual(["3", "4", "doc-77"]);
  });

  it("keeps indexByBookId the single owner of index construction", () => {
    if (!LUA_BINARY) return;
    const { values } = runHarness(`
${FIXTURE}

local sessions = buildSessions()
local injected = { document = "injected-by-the-index-builder", percentage = 0.5 }
local injectedCalls = 0
Status.indexByBookId = function(list)
    injectedCalls = injectedCalls + 1
    return { [101] = injected }
end

local page = buildEntries(40)
Status.merge(page, sessions)
print("injected_calls=" .. injectedCalls)
print("honoured_by_merge=" .. tostring(page[1].status == injected))
print("honoured_by_findSession=" ..
    tostring(Status.findSession({ book_id = 101, title = "Whatever Else" }, sessions, Status.indexByBookId(sessions)) == injected))
`);
    // One build for the page, and the id rule answers from that build alone:
    // nothing scans the session list for ids behind indexByBookId's back.
    expect(values.injected_calls).toBe("1");
    expect(values.honoured_by_merge).toBe("true");
    expect(values.honoured_by_findSession).toBe("true");
  });

  it("renders a page no slower than the per-entry path it replaced", () => {
    if (!LUA_BINARY) return;
    const { values } = runHarness(`
${FIXTURE}

local sessions = buildSessions()
local page = buildEntries(40)
local WARMUP, PASSES = 20, 200

-- Both paths pay the same real cost here: the counter wrapper is gone.
Status.indexByBookId = realIndexByBookId
for pass = 1, WARMUP do
    for position, entry in ipairs(page) do
        entry.status = Status.findSession(entry, sessions)
    end
    Status.merge(page, sessions)
end

-- The old page render, spelled out: one findSession per entry.
local start = os.clock()
for pass = 1, PASSES do
    for position, entry in ipairs(page) do
        entry.status = Status.findSession(entry, sessions)
    end
end
local perEntryMs = (os.clock() - start) * 1000

start = os.clock()
for pass = 1, PASSES do
    Status.merge(page, sessions)
end
local mergedMs = (os.clock() - start) * 1000

print(string.format("per_entry_ms=%.3f", perEntryMs))
print(string.format("merged_ms=%.3f", mergedMs))
print("sessions=" .. #sessions)
print("page_entries=" .. #page)
`);

    const perEntryMs = Number(values.per_entry_ms);
    const mergedMs = Number(values.merged_ms);
    expect(Number.isFinite(perEntryMs)).toBe(true);
    expect(Number.isFinite(mergedMs)).toBe(true);
    expect(values.sessions).toBe("305");
    expect(values.page_entries).toBe("40");
    // The only difference between the two loops is how often the index is
    // rebuilt, so the margin is algorithmic rather than machine-specific: the
    // per-entry path scans the session list twice per entry (build + match)
    // while the page render scans it once per page plus once per entry, a
    // floor of ~1.95x before allocation and GC costs are counted. Measured on
    // a Mac mini it is ~13x.
    expect(perEntryMs / mergedMs).toBeGreaterThan(1.5);
  });
});
