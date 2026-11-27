/**
 * uploader/koplugin-ownership.test.ts
 *
 * Proof for the two device-side fixes the Discover/Download audit found on the
 * KOReader plugin's library and series behaviour:
 *
 *  - `lighthouse_ownership.lua` records which Calibre book is already on the
 *    device, keyed on the OPDS `book_id`. Presence used to be decided only by a
 *    filename derived from live metadata, so a Calibre edit (a series index
 *    correction, an author respelling) renamed the derived file and the volume
 *    flipped from owned to missing — offering a duplicate download, or hiding a
 *    volume that was there.
 *  - `lighthouse_sync.lua`'s batch runner now reports *which* items failed, and
 *    separates the items a cancel never attempted (`pending`) from the ones
 *    that are still not on the device (`remaining`). A bare failure count told
 *    the reader nothing to retry.
 *
 * Both modules are pure Lua with no widgets, sockets, or KOReader globals, so
 * they are driven through a bare interpreter against a plain settings table.
 * Skipped when no Lua interpreter is available, like the rest of the Lua tests.
 */

import { describe, expect, it } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";

import { KOPLUGIN_TEMPLATE_DIR } from "./koplugin";

const LUA_BINARY = Bun.which("luajit") || Bun.which("lua5.1") || Bun.which("lua");

const HARNESS = String.raw`
package.path = assert(arg[1], "template dir required") .. "/?.lua;" .. package.path
local Ownership = assert(loadfile(arg[1] .. "/lighthouse_ownership.lua"))()
local Sync = assert(loadfile(arg[1] .. "/lighthouse_sync.lua"))()

local function report(label, value)
  print(label .. "=" .. tostring(value))
end

-- A settings table shaped like KOReader's G_reader_settings, in memory so each
-- case is isolated.
local function new_settings()
  local store = {}
  return {
    store = store,
    readSetting = function(_, key) return store[key] end,
    saveSetting = function(_, key, value) store[key] = value end,
  }
end

-- ------------------------------------------------------- ownership ledger
local settings = new_settings()
local present = {}
local exists = function(p) return present[p] == true end

-- The audit's §2.9 case: a volume downloaded under one derived filename, then
-- corrected in Calibre. The derived name changes; the book id does not.
local original_entry = { book_id = 501, title = "Spice and Wolf, Vol. 1", authors = "Isuna Hasekura", series = "Spice and Wolf", series_index = 1 }
local edited_entry = { book_id = 501, title = "Spice and Wolf, Vol. 1", authors = "Isuna Hasekura", series = "Spice and Wolf", series_index = 2 }
report("key_of_entry", Ownership.key(original_entry))
report("key_missing", tostring(Ownership.key({ title = "No id" })))
local recorded = Ownership.record(settings, original_entry, "/downloads/old name.epub")
present["/downloads/old name.epub"] = true
report("recorded", recorded)
report("resolves_after_rename", tostring(Ownership.resolve(settings, edited_entry, exists)))
report("resolves_without_predicate", tostring(Ownership.pathFor(settings, edited_entry)))

-- A record whose file disappeared is pruned on the next lookup, so the caller
-- falls back to its filename rule instead of trusting a ghost.
local pruned_settings = new_settings()
Ownership.record(pruned_settings, original_entry, "/downloads/deleted.epub")
report("stale_resolves", tostring(Ownership.resolve(pruned_settings, original_entry, exists)))
report("stale_pruned", tostring(#Ownership.load(pruned_settings)))

-- Deleting a book locally forgets it, so a later catalogue view does not report
-- a file that is not there as owned.
local forget_settings = new_settings()
present["/downloads/gone.epub"] = true
Ownership.record(forget_settings, { book_id = 77, title = "Gone" }, "/downloads/gone.epub")
local forgot = Ownership.forgetPath(forget_settings, "/downloads/gone.epub")
report("forget_path", tostring(forgot and #Ownership.load(forget_settings) == 0))
Ownership.record(forget_settings, { book_id = 78, title = "By id" }, "/downloads/byid.epub")
report("forget_by_id", tostring(Ownership.forget(forget_settings, { book_id = 78 }) and #Ownership.load(forget_settings) == 0))

-- Re-recording the same id moves it to the newest slot rather than duplicating.
local rerecord_settings = new_settings()
Ownership.record(rerecord_settings, original_entry, "/downloads/first.epub")
Ownership.record(rerecord_settings, original_entry, "/downloads/second.epub")
report("rerecord_single", tostring(#Ownership.load(rerecord_settings)))
report("rerecord_newest", tostring(Ownership.pathFor(rerecord_settings, original_entry)))

-- The ledger is capped so a library of thousands cannot grow the settings file
-- without bound, and the oldest entry is the one dropped.
local cap_settings = new_settings()
for id = 1, Ownership.MAX_ENTRIES + 5 do
  Ownership.record(cap_settings, { book_id = id }, "/downloads/" .. id .. ".epub")
end
local capped = Ownership.load(cap_settings)
report("cap_len", tostring(#capped == Ownership.MAX_ENTRIES))
report("cap_oldest_dropped", tostring(Ownership.pathFor(cap_settings, { book_id = 1 }) == nil))
report("cap_newest_kept", tostring(Ownership.pathFor(cap_settings, { book_id = Ownership.MAX_ENTRIES + 5 }) ~= nil))

-- A hand-edited or half-written setting must read as "nothing owned".
local junk_settings = new_settings()
junk_settings.store[Ownership.SETTING_KEY] = "not a table"
report("junk_read", tostring(#Ownership.load(junk_settings)))
junk_settings.store[Ownership.SETTING_KEY] = { { id = "nonsense" }, { path = "/x.epub" }, 42 }
report("junk_records", tostring(#Ownership.load(junk_settings)))
report("no_settings", tostring(#Ownership.load(nil)))

-- ------------------------------------------------------- batch runner results
local function formatMessage(tpl, ...)
  local values = { ... }
  return (tpl:gsub("%%(%d+)", function(index) return tostring(values[tonumber(index)]) end))
end

local function fake_client(behaviour)
  return {
    download = function(_, url)
      local outcome = behaviour[url] or "ok"
      if outcome == "ok" then return true, nil end
      return nil, outcome
    end,
  }
end

local batch_items = {
  { key = "id:1", book_id = 1, label = "Volume One", url = "/one", filepath = "/dl/one.epub" },
  { key = "id:2", book_id = 2, label = "Volume Two", url = "/two", filepath = "/dl/two.epub" },
  { key = "id:3", book_id = 3, label = "Volume Three", url = "/three", filepath = "/dl/three.epub" },
}

local owned = {}
local failed_res = Sync.runBatchDownloads({
  config = {},
  Client = fake_client({ ["/one"] = "ok", ["/two"] = "truncated_download", ["/three"] = "http_404" }),
  formatMessage = formatMessage,
  gettext = function(text) return text end,
  record_owned = function(book_id, filepath) owned[#owned + 1] = tostring(book_id) .. "=" .. filepath end,
}, batch_items, { use_trapper = false })

report("failed_count", tostring(failed_res.failed))
report("failed_labels", table.concat(failed_res.failed_labels, "|"))
report("failed_codes", tostring(failed_res.failed_items[1].code) .. "|" .. tostring(failed_res.failed_items[2].code))
report("failed_keys", table.concat(failed_res.failed_keys, "|"))
report("failed_no_pending", tostring(failed_res.pending == 0 and failed_res.remaining == 2))
report("recorded_ownership", table.concat(owned, ","))

-- A cancel leaves the untouched items pending; they were never attempted, so
-- they are neither downloaded nor failed, and the reader can tell what to
-- resume from what to retry.
local info_calls = 0
local cancel_trapper = {
  wrap = function(_, fn) fn() end,
  setPausedText = function() end,
  clear = function() end,
  info = function()
    info_calls = info_calls + 1
    -- pause text is not counted here; the second info is item 2's.
    return info_calls < 2
  end,
}
local cancelled_res = Sync.runBatchDownloads({
  config = {},
  Client = fake_client({ ["/one"] = "ok" }),
  formatMessage = formatMessage,
  gettext = function(text) return text end,
}, batch_items, { trapper = cancel_trapper })
report("cancelled_flag", tostring(cancelled_res.cancelled))
report("cancelled_downloaded", tostring(cancelled_res.downloaded))
report("cancelled_failed", tostring(cancelled_res.failed))
report("cancelled_pending", tostring(cancelled_res.pending))
-- remaining stays "not on this device" (pending plus failed) and never
-- conflates the cancelled tail with a failure.
report("cancelled_remaining", tostring(cancelled_res.remaining))

-- A failed item with no error detail still carries a code the caller can word.
local blank_res = Sync.runBatchDownloads({
  config = {},
  Client = { download = function() return nil end },
  formatMessage = formatMessage,
  gettext = function(text) return text end,
}, {
  { key = "id:9", label = "No reason", url = "/nine", filepath = "/dl/nine.epub" },
}, { use_trapper = false })
report("blank_code", tostring(blank_res.failed_items[1].code))
report("blank_label", blank_res.failed_labels[1])
`;

interface HarnessOutput {
  [key: string]: string;
}

function runHarness(): HarnessOutput {
  const workdir = fs.mkdtempSync(path.join(os.tmpdir(), "koplugin-ownership-"));
  const harnessPath = path.join(workdir, "ownership_harness.lua");
  fs.writeFileSync(harnessPath, HARNESS);
  const res = spawnSync(LUA_BINARY as string, [harnessPath, KOPLUGIN_TEMPLATE_DIR], {
    encoding: "utf8",
  });
  expect(res.stderr).toBe("");
  expect(res.status).toBe(0);
  return Object.fromEntries(
    res.stdout
      .split("\n")
      .filter((line: string) => line.includes("="))
      .map((line: string) => {
        const index = line.indexOf("=");
        return [line.slice(0, index), line.slice(index + 1)];
      }),
  );
}

describe("plugin ownership ledger", () => {
  it("keys ownership on the Calibre book id, not the derived filename", () => {
    if (!LUA_BINARY) return;
    const out = runHarness();
    expect(out.key_of_entry).toBe("id:501");
    expect(out.key_missing).toBe("nil");
    expect(out.recorded).toBe("true");
    // The entry's metadata was edited (series index 1 -> 2) between download
    // and this lookup; the id still resolves to the file on the device.
    expect(out.resolves_after_rename).toBe("/downloads/old name.epub");
    expect(out.resolves_without_predicate).toBe("/downloads/old name.epub");
  });

  it("prunes a record whose file is gone instead of reporting a ghost", () => {
    if (!LUA_BINARY) return;
    const out = runHarness();
    expect(out.stale_resolves).toBe("nil");
    expect(out.stale_pruned).toBe("0");
  });

  it("forgets a book when it is deleted locally, by path or by id", () => {
    if (!LUA_BINARY) return;
    const out = runHarness();
    expect(out.forget_path).toBe("true");
    expect(out.forget_by_id).toBe("true");
  });

  it("re-records a re-downloaded book in place instead of duplicating it", () => {
    if (!LUA_BINARY) return;
    const out = runHarness();
    expect(out.rerecord_single).toBe("1");
    expect(out.rerecord_newest).toBe("/downloads/second.epub");
  });

  it("caps the ledger and drops the oldest entry first", () => {
    if (!LUA_BINARY) return;
    const out = runHarness();
    expect(out.cap_len).toBe("true");
    expect(out.cap_oldest_dropped).toBe("true");
    expect(out.cap_newest_kept).toBe("true");
  });

  it("reads a malformed ledger as nothing owned instead of raising", () => {
    if (!LUA_BINARY) return;
    const out = runHarness();
    expect(out.junk_read).toBe("0");
    expect(out.junk_records).toBe("0");
    expect(out.no_settings).toBe("0");
  });
});

describe("plugin batch download results", () => {
  it("names every failed volume and keeps its error code", () => {
    if (!LUA_BINARY) return;
    const out = runHarness();
    expect(out.failed_count).toBe("2");
    // The volume titles, in order, so the reader knows what to retry.
    expect(out.failed_labels).toBe("Volume Two|Volume Three");
    expect(out.failed_codes).toBe("truncated_download|http_404");
    expect(out.failed_keys).toBe("id:2|id:3");
  });

  it("records ownership by book id for each volume it actually downloaded", () => {
    if (!LUA_BINARY) return;
    const out = runHarness();
    // Only the volume that arrived is recorded; the two failures are not, so
    // the series view keeps offering them.
    expect(out.recorded_ownership).toBe("1=/dl/one.epub");
  });

  it("separates cancelled-pending items from still-missing ones", () => {
    if (!LUA_BINARY) return;
    const out = runHarness();
    expect(out.cancelled_flag).toBe("true");
    expect(out.cancelled_downloaded).toBe("1");
    expect(out.cancelled_failed).toBe("0");
    // Two volumes were never attempted; neither is a failure.
    expect(out.cancelled_pending).toBe("2");
    // Still not on the device: pending plus failed, for the shelf badge.
    expect(out.cancelled_remaining).toBe("2");
    expect(out.failed_no_pending).toBe("true");
  });

  it("gives a failure with no error detail a wordable code and its label", () => {
    if (!LUA_BINARY) return;
    const out = runHarness();
    expect(out.blank_code).toBe("network_error");
    expect(out.blank_label).toBe("No reason");
  });
});
