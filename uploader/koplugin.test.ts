/**
 * uploader/koplugin.test.ts
 *
 * Covers the KOReader plugin generator end to end:
 *  - the committed template carries no credentials,
 *  - the generated archive has the layout KOReader's PluginLoader requires,
 *  - the archive is a genuine ZIP (verified with the system unzip binary),
 *  - the per-download configuration is injected and never leaks into headers,
 *  - the `/api/koplugin/download` route authenticates using the existing scheme,
 *  - the OPDS feed contract the plugin parses (paging + rating) still holds,
 *  - the plugin's pure-Lua OPDS parser and status merger behave correctly
 *    (when a Lua interpreter is available; skipped otherwise).
 */

import { describe, expect, it, beforeEach, afterEach } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";

import {
  KOPLUGIN_CONFIG_FILE,
  KOPLUGIN_DIR_NAME,
  KOPLUGIN_DOWNLOAD_FILENAME,
  KOPLUGIN_DOWNLOAD_BLOCK_TIMEOUT,
  KOPLUGIN_DOWNLOAD_TOTAL_TIMEOUT,
  KOPLUGIN_REQUEST_BLOCK_TIMEOUT,
  KOPLUGIN_REQUEST_TOTAL_TIMEOUT,
  KOPLUGIN_TEMPLATE_DIR,
  KOPLUGIN_VERSION,
  buildStoredZip,
  crc32,
  generateKoplugin,
  kopluginDownloadHeaders,
  luaStringLiteral,
  normalizeBaseUrl,
  renderConfigLua,
  resolvePluginBaseUrl,
  type KopluginSettings,
} from "./koplugin";
import { generateOpdsFeed } from "./opds";
import { resetScopedKeyCacheForTest } from "./security";
import {
  handleRequest,
  setServerDependenciesForTest,
  resetServerDependenciesForTest,
} from "./server";

const LUA_BINARY = Bun.which("luajit") || Bun.which("lua5.1") || Bun.which("lua");
const UNZIP_BINARY = Bun.which("unzip");

const SAMPLE_SETTINGS: KopluginSettings = {
  baseUrl: "http://192.168.31.15:8086",
  apiKey: "test-api-key-not-a-real-secret",
  pageSize: 40,
  generatedAt: "2026-11-14T00:00:00.000Z",
  pluginVersion: "1.1.1",
  requestBlockTimeout: KOPLUGIN_REQUEST_BLOCK_TIMEOUT,
  requestTotalTimeout: KOPLUGIN_REQUEST_TOTAL_TIMEOUT,
  downloadBlockTimeout: KOPLUGIN_DOWNLOAD_BLOCK_TIMEOUT,
  downloadTotalTimeout: KOPLUGIN_DOWNLOAD_TOTAL_TIMEOUT,
};

/** Writes bytes to a scratch file outside the worktree and returns the path. */
function writeScratch(name: string, data: Buffer | string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "lighthouse-koplugin-"));
  const file = path.join(dir, name);
  fs.writeFileSync(file, data);
  return file;
}

function unzipList(zipPath: string): string[] {
  const res = spawnSync(UNZIP_BINARY as string, ["-Z1", zipPath], {
    encoding: "utf8",
  });
  expect(res.status).toBe(0);
  return res.stdout.split("\n").map((line) => line.trim()).filter(Boolean);
}

function unzipEntry(zipPath: string, entry: string): string {
  const res = spawnSync(UNZIP_BINARY as string, ["-p", zipPath, entry], {
    encoding: "utf8",
  });
  expect(res.status).toBe(0);
  return res.stdout;
}

describe("KOReader plugin template", () => {
  it("ships every file KOReader's PluginLoader requires", () => {
    const names = fs.readdirSync(KOPLUGIN_TEMPLATE_DIR).sort();
    expect(names).toContain("main.lua");
    expect(names).toContain("_meta.lua");
    expect(names).toContain(KOPLUGIN_CONFIG_FILE);
    expect(names).toContain("lighthouse_client.lua");
    expect(names).toContain("lighthouse_opds.lua");
    expect(names).toContain("lighthouse_status.lua");
    expect(names).toContain("lighthouse_stats.lua");
  });

  it("carries no credentials in any committed template file", () => {
    for (const name of fs.readdirSync(KOPLUGIN_TEMPLATE_DIR)) {
      const content = fs.readFileSync(
        path.join(KOPLUGIN_TEMPLATE_DIR, name),
        "utf8",
      );
      // The template must never contain a populated base_url or api_key.
      expect(content).not.toMatch(/base_url\s*=\s*"https?:\/\//);
      expect(content).not.toMatch(/api_key\s*=\s*"[^"]+"/);
      // No secret-ish assignments smuggled in through other names either.
      expect(content).not.toMatch(/READING_API_KEY\s*=/);
    }
  });

  it("stamps the current plugin version into the template and the archive", () => {
    const template = fs.readFileSync(
      path.join(KOPLUGIN_TEMPLATE_DIR, KOPLUGIN_CONFIG_FILE),
      "utf8",
    );
    // The template's placeholder must track the generator so a manual copy and a
    // generated copy never report different versions on the Connection screen.
    expect(template).toContain(`plugin_version = "${KOPLUGIN_VERSION}"`);
    const generated = generateKoplugin({
      baseUrl: "http://192.168.31.15:8086",
      generatedAt: SAMPLE_SETTINGS.generatedAt,
    });
    expect(generated.settings.pluginVersion).toBe(KOPLUGIN_VERSION);
  });

  it("declares the plugin metadata KOReader reads from _meta.lua", () => {    const meta = fs.readFileSync(
      path.join(KOPLUGIN_TEMPLATE_DIR, "_meta.lua"),
      "utf8",
    );
    expect(meta).toContain("fullname");
    expect(meta).toContain("description");
    expect(meta).toContain('require("gettext")');
  });

  it("returns a plugin table with a stable name from main.lua", () => {
    const main = fs.readFileSync(
      path.join(KOPLUGIN_TEMPLATE_DIR, "main.lua"),
      "utf8",
    );
    expect(main).toContain("WidgetContainer:extend{");
    expect(main).toContain('name = "lighthouse"');
    expect(main).toContain("is_doc_only = false");
    expect(main).toContain("registerToMainMenu(self)");
  });
});

describe("normalizeBaseUrl", () => {
  it("accepts plain http and https origins", () => {
    expect(normalizeBaseUrl("http://192.168.31.15:8086")).toBe(
      "http://192.168.31.15:8086",
    );
    expect(normalizeBaseUrl("https://reading-sg.wavypremium.xyz:8443/")).toBe(
      "https://reading-sg.wavypremium.xyz:8443",
    );
  });

  it("rejects credentials, query strings, fragments and sub-paths", () => {
    expect(normalizeBaseUrl("http://user:pass@host:8086")).toBeNull();
    expect(normalizeBaseUrl("http://host:8086/?key=abc")).toBeNull();
    expect(normalizeBaseUrl("http://host:8086/#frag")).toBeNull();
    expect(normalizeBaseUrl("http://host:8086/sub")).toBeNull();
  });

  it("rejects non-http schemes and garbage", () => {
    expect(normalizeBaseUrl("ftp://host:21")).toBeNull();
    expect(normalizeBaseUrl("javascript:alert(1)")).toBeNull();
    expect(normalizeBaseUrl("not a url")).toBeNull();
    expect(normalizeBaseUrl("")).toBeNull();
    expect(normalizeBaseUrl(null)).toBeNull();
  });
});

describe("resolvePluginBaseUrl", () => {
  const url = new URL("http://127.0.0.1:8086/api/koplugin/download");

  it("uses the Host header for direct LAN requests", () => {
    const req = new Request(url, { headers: { host: "192.168.31.15:8086" } });
    expect(resolvePluginBaseUrl(req, url, { trustForwarded: false })).toBe(
      "http://192.168.31.15:8086",
    );
  });

  it("honours X-Forwarded-* only for the trusted loopback tunnel", () => {
    const req = new Request(url, {
      headers: {
        host: "127.0.0.1:8086",
        "x-forwarded-host": "reading-sg.wavypremium.xyz:8443",
        "x-forwarded-proto": "https",
      },
    });
    expect(resolvePluginBaseUrl(req, url, { trustForwarded: true })).toBe(
      "https://reading-sg.wavypremium.xyz:8443",
    );
    // Untrusted peer: forwarded headers are ignored, Host wins.
    expect(resolvePluginBaseUrl(req, url, { trustForwarded: false })).toBe(
      "http://127.0.0.1:8086",
    );
  });
});

describe("renderConfigLua", () => {
  it("emits a data-only Lua module with the injected values", () => {
    const lua = renderConfigLua(SAMPLE_SETTINGS);
    expect(lua).toContain(`base_url = "http://192.168.31.15:8086"`);
    expect(lua).toContain(`api_key = "test-api-key-not-a-real-secret"`);
    expect(lua).toContain("page_size = 40");
    expect(lua).toContain(`generated_at = "2026-11-14T00:00:00.000Z"`);
    expect(lua.trimEnd().endsWith("}")).toBe(true);
  });

  it("emits every timeout field the Lua client reads", () => {
    const lua = renderConfigLua(SAMPLE_SETTINGS);
    expect(lua).toContain(`request_block_timeout = ${KOPLUGIN_REQUEST_BLOCK_TIMEOUT}`);
    expect(lua).toContain(`request_total_timeout = ${KOPLUGIN_REQUEST_TOTAL_TIMEOUT}`);
    expect(lua).toContain(`download_block_timeout = ${KOPLUGIN_DOWNLOAD_BLOCK_TIMEOUT}`);
    expect(lua).toContain(`download_total_timeout = ${KOPLUGIN_DOWNLOAD_TOTAL_TIMEOUT}`);
    // The catalog budget must be generous enough for a first page over slow Wi-Fi.
    expect(KOPLUGIN_REQUEST_TOTAL_TIMEOUT).toBeGreaterThan(40);
  });

  it("keeps the timeout fields viable when a caller passes junk", () => {
    const lua = renderConfigLua({
      ...SAMPLE_SETTINGS,
      requestTotalTimeout: Number.NaN,
      downloadTotalTimeout: -5,
    });
    expect(lua).toContain(`request_total_timeout = ${KOPLUGIN_REQUEST_TOTAL_TIMEOUT}`);
    expect(lua).toContain(`download_total_timeout = ${KOPLUGIN_DOWNLOAD_TOTAL_TIMEOUT}`);
  });

  it("declares the same timeout keys in the committed template", () => {
    const template = fs.readFileSync(
      path.join(KOPLUGIN_TEMPLATE_DIR, KOPLUGIN_CONFIG_FILE),
      "utf8",
    );
    for (const key of [
      "request_block_timeout",
      "request_total_timeout",
      "download_block_timeout",
      "download_total_timeout",
    ]) {
      expect(template).toContain(`${key} =`);
    }
  });

  it("escapes quotes, backslashes and newlines so the module cannot break", () => {
    const lua = renderConfigLua({
      ...SAMPLE_SETTINGS,
      apiKey: 'we"ird\\key\nreturn nil --',
    });
    expect(lua).toContain('api_key = "we\\"ird\\\\key\\nreturn nil --"');
    // No raw newline may appear inside the literal.
    const keyLine = lua.split("\n").find((line) => line.includes("api_key ="));
    expect(keyLine).toBeDefined();
    // The rendered assignment is a single closed literal followed by a comma.
    expect(keyLine!.trimEnd().endsWith('",')).toBe(true);
  });

  it("luaStringLiteral round-trips through a Lua interpreter", () => {
    if (!LUA_BINARY) return; // no interpreter available in this environment
    const value = 'quote" back\\slash\nnewline\ttab';
    const script = `io.write(${luaStringLiteral(value)})`;
    const res = spawnSync(LUA_BINARY, ["-e", script], { encoding: "utf8" });
    expect(res.status).toBe(0);
    expect(res.stdout).toBe(value);
  });
});

describe("buildStoredZip", () => {
  it("computes CRC-32 for known vectors", () => {
    expect(crc32(Buffer.from(""))).toBe(0);
    expect(crc32(Buffer.from("123456789"))).toBe(0xcbf43926);
    expect(crc32(Buffer.from("The quick brown fox jumps over the lazy dog"))).toBe(
      0x414fa339,
    );
  });

  it("produces a reproducible archive", () => {
    const entries = [
      { name: "a.txt", data: Buffer.from("alpha") },
      { name: "b/c.txt", data: Buffer.from("charlie") },
    ];
    const first = buildStoredZip(entries);
    const second = buildStoredZip(entries);
    expect(first.equals(second)).toBe(true);
    expect(first.subarray(0, 4).toString("hex")).toBe("504b0304");
    expect(first.subarray(-22).subarray(0, 4).toString("hex")).toBe("504b0506");
  });
});

describe("generateKoplugin archive layout", () => {
  it("ships the reading-stats module and a bumped version so devices re-download", () => {
    const { entryNames, zip } = generateKoplugin({
      baseUrl: "http://192.168.31.15:8086",
      apiKey: "secret-key",
      generatedAt: SAMPLE_SETTINGS.generatedAt,
    });

    // The stats view is a new template module: an archive without it would keep
    // the old main menu and the "Reading stats" entry would fail to require.
    expect(entryNames).toContain(`${KOPLUGIN_DIR_NAME}/lighthouse_stats.lua`);

    if (!UNZIP_BINARY) return;
    const zipPath = writeScratch("stats.koplugin", zip);
    const config = unzipEntry(zipPath, `${KOPLUGIN_DIR_NAME}/${KOPLUGIN_CONFIG_FILE}`);
    expect(config).toContain(`plugin_version = "${KOPLUGIN_VERSION}"`);
  });

  it("roots everything at lighthouse.koplugin/ as KOReader requires", () => {
    const { zip, entryNames } = generateKoplugin({
      baseUrl: "http://192.168.31.15:8086",
      apiKey: "secret-key",
      generatedAt: SAMPLE_SETTINGS.generatedAt,
    });

    expect(zip.length).toBeGreaterThan(1000);
    for (const name of entryNames) {
      expect(name.startsWith(`${KOPLUGIN_DIR_NAME}/`)).toBe(true);
    }
    expect(entryNames).toContain(`${KOPLUGIN_DIR_NAME}/main.lua`);
    expect(entryNames).toContain(`${KOPLUGIN_DIR_NAME}/_meta.lua`);
    expect(entryNames).toContain(`${KOPLUGIN_DIR_NAME}/${KOPLUGIN_CONFIG_FILE}`);
  });

  it("writes a ZIP the system unzip binary validates and lists", () => {
    if (!UNZIP_BINARY) return;
    const { zip, entryNames } = generateKoplugin({
      baseUrl: "http://192.168.31.15:8086",
      apiKey: "secret-key",
      generatedAt: SAMPLE_SETTINGS.generatedAt,
    });
    const zipPath = writeScratch("lighthouse.koplugin", zip);

    const test = spawnSync(UNZIP_BINARY as string, ["-t", zipPath], {
      encoding: "utf8",
    });
    expect(test.status).toBe(0);
    expect(test.stdout).toContain("No errors detected");

    const listed = unzipList(zipPath);
    expect(listed.sort()).toEqual([...entryNames].sort());
  });

  it("injects the live settings instead of the template placeholders", () => {
    if (!UNZIP_BINARY) return;
    const { zip } = generateKoplugin({
      baseUrl: "https://reading-sg.wavypremium.xyz:8443",
      apiKey: "download-specific-key",
      generatedAt: SAMPLE_SETTINGS.generatedAt,
    });
    const zipPath = writeScratch("lighthouse.koplugin", zip);
    const config = unzipEntry(
      zipPath,
      `${KOPLUGIN_DIR_NAME}/${KOPLUGIN_CONFIG_FILE}`,
    );

    expect(config).toContain(
      'base_url = "https://reading-sg.wavypremium.xyz:8443"',
    );
    expect(config).toContain('api_key = "download-specific-key"');
    expect(config).not.toMatch(/base_url\s*=\s*""/);

    // main.lua is shipped verbatim: the plugin logic is not templated.
    const main = unzipEntry(zipPath, `${KOPLUGIN_DIR_NAME}/main.lua`);
    const templateMain = fs.readFileSync(
      path.join(KOPLUGIN_TEMPLATE_DIR, "main.lua"),
      "utf8",
    );
    expect(main).toBe(templateMain);
  });

  it("regenerating after a settings change yields a working, different archive", () => {
    const first = generateKoplugin({
      baseUrl: "http://192.168.31.15:8086",
      apiKey: "key-one",
      generatedAt: SAMPLE_SETTINGS.generatedAt,
    });
    const second = generateKoplugin({
      baseUrl: "https://reading-sg.wavypremium.xyz:8443",
      apiKey: "key-two",
      generatedAt: SAMPLE_SETTINGS.generatedAt,
    });

    expect(first.zip.equals(second.zip)).toBe(false);
    expect(first.entryNames).toEqual(second.entryNames);

    if (!UNZIP_BINARY) return;
    const zipPath = writeScratch("lighthouse.koplugin", second.zip);
    const config = unzipEntry(
      zipPath,
      `${KOPLUGIN_DIR_NAME}/${KOPLUGIN_CONFIG_FILE}`,
    );
    expect(config).toContain('api_key = "key-two"');
    expect(config).not.toContain("key-one");
  });

  it("refuses to build from an invalid base URL", () => {
    expect(() => generateKoplugin({ baseUrl: "http://user:pass@host:8086" })).toThrow();
    expect(() => generateKoplugin({ baseUrl: "nonsense" })).toThrow();
  });

  it("stays within node:path source of truth (template dir exists)", () => {
    expect(fs.existsSync(KOPLUGIN_TEMPLATE_DIR)).toBe(true);
    expect(fs.existsSync(path.join(KOPLUGIN_TEMPLATE_DIR, "main.lua"))).toBe(true);
  });

  it("declares no-store cache headers so a credential is never cached", () => {
    const headers = kopluginDownloadHeaders();
    expect(headers["Cache-Control"]).toContain("no-store");
    expect(headers["Cache-Control"]).toContain("private");
    expect(headers["Content-Disposition"]).toBe(
      `attachment; filename="${KOPLUGIN_DOWNLOAD_FILENAME}"`,
    );
    expect(headers["X-Content-Type-Options"]).toBe("nosniff");
  });
});

describe("Lua sources compile", () => {
  const luaFiles = fs
    .readdirSync(KOPLUGIN_TEMPLATE_DIR)
    .filter((name) => name.endsWith(".lua"));

  for (const name of luaFiles) {
    it(`${name} is valid Lua`, () => {
      if (!LUA_BINARY) return; // interpreter unavailable; skip silently
      const file = path.join(KOPLUGIN_TEMPLATE_DIR, name);
      const res = spawnSync(
        LUA_BINARY,
        ["-e", `assert(loadfile(${JSON.stringify(file)}))`],
        { encoding: "utf8" },
      );
      expect(res.stderr).toBe("");
      expect(res.status).toBe(0);
    });
  }
});

describe("generated plugin config compiles under Lua", () => {
  it("loads the rendered config module", () => {
    if (!LUA_BINARY) return;
    const lua = renderConfigLua(SAMPLE_SETTINGS);
    const file = writeScratch("lighthouse_config.lua", lua);
    const res = spawnSync(
      LUA_BINARY,
      [
        "-e",
        `local c = assert(loadfile(${JSON.stringify(file)}))()` +
          `; assert(c.base_url == "http://192.168.31.15:8086", c.base_url)` +
          `; assert(c.api_key == "test-api-key-not-a-real-secret")`,
      ],
      { encoding: "utf8" },
    );
    expect(res.stderr).toBe("");
    expect(res.status).toBe(0);
  });
});

describe("plugin OPDS parser against a generated feed", () => {
  const books = [
    {
      id: 101,
      title: "Spice and Wolf, Vol. 1",
      authors: "Isuna Hasekura",
      series: "Spice and Wolf",
      series_index: 1,
      tags: ["Fantasy", "Light Novel"],
      comments: "<p>A merchant meets a wolf.</p>",
      pubdate: "2008-01-01T00:00:00+00:00",
      cover: 1,
      rating: 8,
    },
    {
      id: 102,
      title: "Dune & Sons <Deluxe>",
      authors: "Frank Herbert",
      series: null,
      series_index: null,
      tags: [],
      comments: null,
      pubdate: "1965-08-01T00:00:00+00:00",
      cover: 0,
      rating: null,
    },
  ];

  it("emits the Atom shapes the Lua parser reads, including rating and next page", () => {
    const xml = generateOpdsFeed(books as any, {
      title: "LightHouse test feed",
      feedUrl: "/api/opds?start=0&count=2",
      publicBaseUrl: "http://192.168.31.15:8086",
      nextHref: "/api/opds?search=&start=2&count=2",
      startIndex: 0,
      totalResults: 4,
    });

    expect(xml).toContain("xmlns:lighthouse=");
    expect(xml).toContain('<link rel="next" href="http://192.168.31.15:8086/api/opds?search=&amp;start=2&amp;count=2"');
    expect(xml).toContain("<lighthouse:rating>8</lighthouse:rating>");
    // Unrated book must not emit an empty rating element.
    expect(xml.match(/<lighthouse:rating>/g)?.length).toBe(1);
    expect(xml).toContain("<lighthouse:total>4</lighthouse:total>");
    expect(xml).toContain('<category term="Spice and Wolf" label="Volume 1"/>');
    expect(xml).toContain("<title>Dune &amp; Sons &lt;Deluxe&gt;</title>");
    expect(xml).toContain(
      'href="http://192.168.31.15:8086/api/books/101/download/epub"',
    );
  });

  it("parses that feed with the plugin's own parser", () => {
    if (!LUA_BINARY) return;
    const xml = generateOpdsFeed(books as any, {
      title: "LightHouse test feed",
      feedUrl: "/api/opds?start=0&count=2",
      publicBaseUrl: "http://192.168.31.15:8086",
      nextHref: "/api/opds?search=&start=2&count=2",
      startIndex: 0,
      totalResults: 4,
    });
    const xmlPath = writeScratch("feed.xml", xml);
    const parserPath = path.join(KOPLUGIN_TEMPLATE_DIR, "lighthouse_opds.lua");
    const harnessPath = writeScratch(
      "parse_harness.lua",
      `
local OPDS = assert(loadfile(${JSON.stringify(parserPath)}))()
local handle = assert(io.open(${JSON.stringify(xmlPath)}, "rb"))
local xml = handle:read("*a")
handle:close()
local feed = OPDS.parse(xml)
print("title=" .. feed.title)
print("next=" .. tostring(feed.next_href))
print("count=" .. tostring(#feed.entries))
for index, entry in ipairs(feed.entries) do
  print(string.format(
    "entry%d=%s\\t%s\\t%s\\t%s\\t%s\\t%s\\t%s",
    index,
    tostring(entry.book_id),
    entry.title,
    entry.authors,
    tostring(entry.series),
    tostring(entry.series_index),
    tostring(entry.rating),
    tostring(entry.download_href)
  ))
end
`,
    );

    const res = spawnSync(LUA_BINARY, [harnessPath], { encoding: "utf8" });
    expect(res.stderr).toBe("");
    expect(res.status).toBe(0);

    const lines = res.stdout.split("\n").filter(Boolean);
    expect(lines[0]).toBe("title=LightHouse test feed");
    expect(lines[1]).toBe("next=http://192.168.31.15:8086/api/opds?search=&start=2&count=2");
    expect(lines[2]).toBe("count=2");

    const first = lines[3].split("\t");
    expect(first[0]).toBe("entry1=101");
    expect(first[1]).toBe("Spice and Wolf, Vol. 1");
    expect(first[2]).toBe("Isuna Hasekura");
    expect(first[3]).toBe("Spice and Wolf");
    expect(first[4]).toBe("1");
    expect(first[5]).toBe("8");
    expect(first[6]).toBe("http://192.168.31.15:8086/api/books/101/download/epub");

    // XML entities must be unescaped exactly once on the second entry.
    const second = lines[4].split("\t");
    expect(second[0]).toBe("entry2=102");
    expect(second[1]).toBe("Dune & Sons <Deluxe>");
    expect(second[5]).toBe("nil");
  });
});

describe("plugin status merger", () => {
  it("matches sessions by id, filename and title, and renders progress", () => {
    if (!LUA_BINARY) return;
    const statusPath = path.join(KOPLUGIN_TEMPLATE_DIR, "lighthouse_status.lua");
    const harnessPath = writeScratch(
      "status_harness.lua",
      `
local Status = assert(loadfile(${JSON.stringify(statusPath)}))()

-- Shape mirrors GET /api/kosync/active for a linked and an unlinked session.
local sessions = Status.normalizeSessions({
  {
    bookId = 101,
    document = "d6df0b1e0c6dec84dd52e6616fa669d8",
    percentage = 0.45,
    timestamp = 1794633720,
    title = "Spice and Wolf, Vol. 1",
    authors = "Isuna Hasekura",
    device = "Paperwhite",
    filename = "01 - Spice and Wolf, Vol. 1.epub",
  },
  {
    bookId = nil,
    document = "aaaabbbbccccdddd",
    percentage = 0.2,
    timestamp = 1794633700,
    title = "dune and sons deluxe",
    authors = "Frank Herbert",
    device = "Kobo",
    filename = "Dune & Sons.epub",
  },
})

local byId = Status.findSession({ book_id = 101, title = "whatever" }, sessions)
print("by_id=" .. tostring(byId and byId.percentage))

local byTitle = Status.findSession({ title = "Dune & Sons <Deluxe>", authors = "Frank Herbert" }, sessions)
print("by_title=" .. tostring(byTitle and byTitle.percentage))

local byFilename = Status.findSession({ title = "Spice and Wolf, Vol. 1" }, sessions)
print("by_filename=" .. tostring(byFilename and byFilename.percentage))

local missing = Status.findSession({ title = "Completely Different Book" }, sessions)
print("missing=" .. tostring(missing))

print("bar=" .. Status.progressBar(0.45))
print("label=" .. Status.statusLabel({ status = byId }))
print("rating=" .. Status.ratingLabel(8))
print("stars=" .. Status.ratingStars(8))
print("unrated=" .. Status.ratingLabel(nil))
print("clamp=" .. tostring(Status.clampPercentage(45)) .. "," .. tostring(Status.clampPercentage(0.45)))
`,
    );

    const res = spawnSync(LUA_BINARY, [harnessPath], { encoding: "utf8" });
    expect(res.stderr).toBe("");
    expect(res.status).toBe(0);

    const out = Object.fromEntries(
      res.stdout
        .split("\n")
        .filter(Boolean)
        .map((line) => {
          const index = line.indexOf("=");
          return [line.slice(0, index), line.slice(index + 1)];
        }),
    );

    expect(out.by_id).toBe("0.45");
    expect(out.by_title).toBe("0.2");
    expect(out.by_filename).toBe("0.45");
    expect(out.missing).toBe("nil");
    expect(out.bar).toBe("████░░░░ 45%");
    expect(out.label).toBe("████░░░░ 45% · Paperwhite");
    expect(out.rating).toBe("4.0 / 5");
    expect(out.stars).toBe("★★★★☆");
    expect(out.unrated).toBe("Not rated");
    expect(out.clamp).toBe("0.45,0.45");
  });
});

describe("GET /api/koplugin/download", () => {
  const books = [
    {
      id: 7,
      title: "Plugin Route Book",
      authors: "Someone",
      series: null,
      series_index: null,
      tags: [],
      comments: null,
      pubdate: "2020-01-01T00:00:00+00:00",
      cover: 0,
      rating: 4,
    },
  ];

  beforeEach(() => {
    setServerDependenciesForTest({ getCalibreBooks: () => books as any } as any);
  });

  afterEach(() => {
    resetServerDependenciesForTest();
    delete process.env.READING_API_KEY;
  });

  const lanServer = () => ({ requestIP: () => ({ address: "192.168.31.15" }) });
  const tunnelServer = () => ({ requestIP: () => ({ address: "127.0.0.1" }) });

  it("serves a pre-configured archive to a LAN request without credentials", async () => {
    const req = new Request("http://192.168.31.15:8086/api/koplugin/download", {
      headers: { host: "192.168.31.15:8086" },
    });
    const res = await handleRequest(req, lanServer());

    expect(res.status).toBe(200);
    expect(res.headers.get("content-disposition")).toBe(
      `attachment; filename="${KOPLUGIN_DOWNLOAD_FILENAME}"`,
    );
    expect(res.headers.get("cache-control") || "").toContain("no-store");

    const bytes = Buffer.from(await res.arrayBuffer());
    const zipPath = writeScratch("lan.koplugin", bytes);
    if (!UNZIP_BINARY) return;
    const config = unzipEntry(zipPath, `${KOPLUGIN_DIR_NAME}/${KOPLUGIN_CONFIG_FILE}`);
    expect(config).toContain('base_url = "http://192.168.31.15:8086"');
  });

  it("rejects unauthenticated WAN requests", async () => {
    const req = new Request("http://127.0.0.1:8086/api/koplugin/download", {
      headers: {
        host: "reading.wavypremium.xyz",
        origin: "https://evil.example",
      },
    });
    const res = await handleRequest(req);
    expect(res.status).toBe(401);
    const payload = (await res.json()) as any;
    expect(payload.success).toBe(false);
    expect(payload.error).toContain("Authentication required");
  });

  it("refuses a scoped API key, which would otherwise leak the global key", async () => {
    // The generated archive embeds READING_API_KEY, so a limited credential must
    // never be able to trade itself for the master key.
    process.env.READING_API_KEY = "unit-test-master-key";
    process.env.READING_SCOPED_KEYS = "ro-reader=unit-test-ro-key:read";
    resetScopedKeyCacheForTest();
    try {
      const req = new Request("http://127.0.0.1:8086/api/koplugin/download", {
        headers: {
          host: "127.0.0.1:8086",
          "x-forwarded-host": "reading-sg.wavypremium.xyz:8443",
          "x-forwarded-proto": "https",
          authorization: "Bearer unit-test-ro-key",
        },
      });
      const res = await handleRequest(req, tunnelServer());
      expect(res.status).toBe(403);
      const payload = (await res.json()) as any;
      expect(payload.success).toBe(false);
      expect(payload.code).toBe("insufficient_scope");
      expect(payload.keyName).toBe("ro-reader");
      // The master key must never appear in the refusal.
      expect(JSON.stringify(payload)).not.toContain("unit-test-master-key");
    } finally {
      delete process.env.READING_SCOPED_KEYS;
      resetScopedKeyCacheForTest();
    }
  });

  it("accepts an authenticated WAN request and bakes in the tunnel origin", async () => {
    process.env.READING_API_KEY = "unit-test-wan-key";
    const req = new Request("http://127.0.0.1:8086/api/koplugin/download", {
      headers: {
        host: "127.0.0.1:8086",
        "x-forwarded-host": "reading-sg.wavypremium.xyz:8443",
        "x-forwarded-proto": "https",
        authorization: "Bearer unit-test-wan-key",
      },
    });
    const res = await handleRequest(req, tunnelServer());
    expect(res.status).toBe(200);

    const bytes = Buffer.from(await res.arrayBuffer());
    if (!UNZIP_BINARY) return;
    const zipPath = writeScratch("wan.koplugin", bytes);
    const config = unzipEntry(zipPath, `${KOPLUGIN_DIR_NAME}/${KOPLUGIN_CONFIG_FILE}`);
    expect(config).toContain('base_url = "https://reading-sg.wavypremium.xyz:8443"');
    expect(config).toContain('api_key = "unit-test-wan-key"');
  });

  it("never echoes the credential in response headers", async () => {
    process.env.READING_API_KEY = "unit-test-secret-key";
    const req = new Request("http://192.168.31.15:8086/api/koplugin/download", {
      headers: { host: "192.168.31.15:8086" },
    });
    const res = await handleRequest(req, lanServer());
    expect(res.status).toBe(200);
    const headerBlob = JSON.stringify([...res.headers.entries()]);
    expect(headerBlob).not.toContain("unit-test-secret-key");
  });

  it("answers HEAD with headers only and supports the compatibility alias", async () => {
    const head = await handleRequest(
      new Request("http://192.168.31.15:8086/api/koplugin/download", {
        method: "HEAD",
        headers: { host: "192.168.31.15:8086" },
      }),
      lanServer(),
    );
    expect(head.status).toBe(200);
    expect(head.headers.get("content-type")).toBe("application/zip");

    const alias = await handleRequest(
      new Request("http://192.168.31.15:8086/api/koreader/plugin/download", {
        headers: { host: "192.168.31.15:8086" },
      }),
      lanServer(),
    );
    expect(alias.status).toBe(200);
  });

  it("rejects non-GET methods", async () => {
    const res = await handleRequest(
      new Request("http://192.168.31.15:8086/api/koplugin/download", {
        method: "POST",
        headers: { host: "192.168.31.15:8086", origin: "http://192.168.31.15:8086" },
      }),
      lanServer(),
    );
    // POST falls through to the generic mutating pipeline, which is not a 200.
    expect(res.status).not.toBe(200);
  });
});

describe("OPDS paging contract used by the plugin", () => {
  const books = Array.from({ length: 5 }, (_, index) => ({
    id: 200 + index,
    title: `Paged Book ${index + 1}`,
    authors: "Author",
    series: null,
    series_index: null,
    tags: [],
    comments: null,
    pubdate: "2020-01-01T00:00:00+00:00",
    cover: 0,
    rating: index === 0 ? 6 : null,
  }));

  beforeEach(() => {
    setServerDependenciesForTest({ getCalibreBooks: () => books as any } as any);
  });

  afterEach(() => {
    resetServerDependenciesForTest();
  });

  it("returns the whole catalog when no paging parameters are supplied", async () => {
    const res = await handleRequest(
      new Request("http://192.168.31.15:8086/api/opds"),
    );
    const xml = await res.text();
    expect(xml.match(/<entry>/g)?.length).toBe(5);
    expect(xml).not.toContain('rel="next"');
  });

  it("slices with start/count and advertises the next page", async () => {
    const res = await handleRequest(
      new Request("http://192.168.31.15:8086/api/opds?start=0&count=2"),
    );
    const xml = await res.text();
    expect(xml.match(/<entry>/g)?.length).toBe(2);
    expect(xml).toContain("<title>Paged Book 1</title>");
    expect(xml).toContain("<lighthouse:total>5</lighthouse:total>");
    expect(xml).toContain('rel="next"');
    expect(xml).toContain("start=2");
  });

  it("omits rel=next on the final page and clamps count", async () => {
    const res = await handleRequest(
      new Request("http://192.168.31.15:8086/api/opds?start=4&count=2"),
    );
    const xml = await res.text();
    expect(xml.match(/<entry>/g)?.length).toBe(1);
    expect(xml).not.toContain('rel="next"');

    const clamped = await handleRequest(
      new Request("http://192.168.31.15:8086/api/opds?start=0&count=9999"),
    );
    const clampedXml = await clamped.text();
    expect(clampedXml.match(/<entry>/g)?.length).toBe(5);
  });

  it("keeps search working together with paging", async () => {
    const res = await handleRequest(
      new Request("http://192.168.31.15:8086/api/opds?search=Paged%20Book%203&count=10"),
    );
    const xml = await res.text();
    expect(xml.match(/<entry>/g)?.length).toBe(1);
    expect(xml).toContain("<title>Paged Book 3</title>");
  });

  it("exposes the Calibre rating for rated books only", async () => {
    const res = await handleRequest(
      new Request("http://192.168.31.15:8086/api/opds"),
    );
    const xml = await res.text();
    expect(xml.match(/<lighthouse:rating>/g)?.length).toBe(1);
    expect(xml).toContain("<lighthouse:rating>6</lighthouse:rating>");
  });
});

/**
 * Harness for `lighthouse_client.lua`.
 *
 * LuaSocket is replaced by a stub whose `request` handler is chosen by the
 * scenario argument, so transport selection, redirect handling, streaming and
 * error reporting can be asserted off-device. `ltn12` and `lfs` are real
 * enough implementations that the client's own sink/size logic is exercised.
 */
const LIGHTHOUSE_CLIENT_HARNESS = String.raw`
local client_path = assert(arg[1], "client path required")
local scenario = assert(arg[2], "scenario required")
local workdir = assert(arg[3], "workdir required")

local http_urls, https_urls, timeouts = {}, {}, {}
-- Per-hop record of whether the request carried X-API-Key ("Y"/"N"), so the
-- cross-host stripping behavior can be asserted without guessing at headers.
local http_keys, https_keys = {}, {}
-- Per-request record of whether the caller disabled LuaSocket's internal
-- redirect following ("false" or "nil"), so the transport contract can be
-- asserted directly.
local http_redirect, https_redirect = {}, {}

local function report(label, value)
  print(label .. "=" .. tostring(value))
end

-- Resolves a Location header the way an HTTP client would, for the internal
-- redirect emulation below (absolute, root-relative, directory-relative, and
-- query-only targets).
local function resolve_url(base, loc)
  if loc:match("^%a[%w+%-%.]*://") then return loc end
  local authority = base:match("^(%a[%w+%-%.]+://[^/#?]*)")
  if not authority then return loc end
  if loc:sub(1, 1) == "?" then
    return base:match("^([^#?]*)") .. loc
  end
  if loc:sub(1, 1) == "/" then return authority .. loc end
  return (base:match("^(.*/)") or authority .. "/") .. loc
end

-- Emulates real LuaSocket's internal redirect following (verified live with
-- LuaSocket 3.1.0, the line KOReader bundles): a 3xx response with a Location
-- header is re-requested with the SAME header table -- leaking any auth
-- header across hosts -- and the caller's sink only receives the final
-- response's body. Without this emulation the stub silently disagrees with
-- the real transport and cannot catch the header-forwarding regression.
local function internal_follow(handler, request)
  local current = request
  for _ = 1, 10 do
    local buffered = {}
    local first, code, rheaders = handler({
      url = current.url,
      method = "GET",
      headers = current.headers,
      sink = function(chunk)
        if chunk then buffered[#buffered + 1] = chunk end
        return 1
      end,
    })
    local location = type(rheaders) == "table" and rheaders.location
    if first == nil or type(code) ~= "number" or code < 300 or code >= 400
        or not location then
      -- Final response (or transport failure): deliver the buffered body now.
      for _, chunk in ipairs(buffered) do
        local ok, err = request.sink(chunk)
        if not ok then return nil, err end
      end
      return first, code, rheaders
    end
    current = {
      url = resolve_url(current.url, location),
      method = "GET",
      headers = current.headers, -- same header table: the real-leak shape
      sink = request.sink,
    }
  end
  return nil, "too many internal redirects"
end

local function make_transport(calls, key_log, redirect_log, handler)
  return {
    request = function(request)
      redirect_log[#redirect_log + 1] = tostring(request.redirect)
      calls[#calls + 1] = request.url
      key_log[#key_log + 1] = (request.headers or {})["X-API-Key"] and "Y" or "N"
      if request.redirect == false then
        -- Disabled: hand the raw response to the caller, which owns hops.
        return handler(request)
      end
      return internal_follow(handler, request)
    end,
  }
end

local function emit(request, payload)
  if request.sink and payload then request.sink(payload) end
  return 1, 200, {}
end

local function redirect(location, code)
  return 1, code or 302, location and { location = location } or {}
end

local handler
if scenario == "schemes" or scenario == "https_missing" then
  handler = function(request)
    local scheme = request.url:match("^(%a[%w+%-%.]*)://")
    return emit(request, "body-for-" .. tostring(scheme))
  end
elseif scenario == "redirect" then
  handler = function(request)
    if request.url == "http://lan.test/api/opds" then
      return redirect("https://wan.test/api/opds", 301)
    elseif request.url == "https://wan.test/api/opds" then
      return redirect("/v2/opds")
    elseif request.url == "https://wan.test/v2/opds" then
      return emit(request, "final-body")
    end
    return 1, 404, {}
  end
elseif scenario == "relative" then
  handler = function(request)
    if request.url == "http://lan.test/api/opds" then
      return redirect("opds?start=40")
    end
    return emit(request, "second")
  end
elseif scenario == "query_redirect" then
  handler = function(request)
    if request.url == "http://lan.test/api/opds" then
      return redirect("?start=40")
    end
    return emit(request, "second")
  end
elseif scenario == "too_many" then
  handler = function() return redirect("/loop", 307) end
elseif scenario == "missing_location" then
  handler = function() return 1, 302, {} end
elseif scenario == "transport_error" then
  handler = function() return nil, "timeout" end
elseif scenario == "html" then
  handler = function(request)
    return emit(request,
      "<!DOCTYPE html><html><body>" .. string.rep("x", 400) .. "</body></html>")
  end
elseif scenario == "small_file" then
  handler = function(request) return emit(request, "x") end
elseif scenario == "download" then
  handler = function(request)
    if request.url == "https://wan.test/api/books/7/download/epub" then
      -- A redirect whose interstitial body already landed in the file.
      request.sink(string.rep("R", 1000))
      return redirect("/moved/epub")
    end
    return emit(request, string.rep("E", 900))
  end
elseif scenario == "plain_download" then
  handler = function(request) return emit(request, string.rep("E", 900)) end
elseif scenario == "sink_write_failure" then
  -- Two chunks per hop: the first write lands, the second hits a full disk.
  -- Mirrors real LuaSocket, which reports a failing sink as (nil, errmsg).
  handler = function(request)
    if request.url == "https://wan.test/api/books/7/download/epub" then
      local ok1, err1 = request.sink(string.rep("E", 400))
      if not ok1 then return nil, err1 end
      local ok2, err2 = request.sink(string.rep("E", 400))
      if not ok2 then return nil, err2 end
      return 1, 200, {}
    end
    return 1, 404, {}
  end
end

package.preload["socket.http"] = function() return make_transport(http_urls, http_keys, http_redirect, handler) end
package.preload["socket.https"] = function() return make_transport(https_urls, https_keys, https_redirect, handler) end
package.preload["socketutil"] = function()
  return {
    set_timeout = function(_, block, total)
      timeouts[#timeouts + 1] = tostring(block) .. "/" .. tostring(total)
    end,
    reset_timeout = function() end,
  }
end
package.preload["ltn12"] = function()
  return {
    sink = {
      table = function(chunks)
        chunks = chunks or {}
        return function(chunk)
          if chunk then chunks[#chunks + 1] = chunk end
          return 1
        end
      end,
      file = function() return function() return 1 end end,
    },
  }
end
package.preload["libs/libkoreader-lfs"] = function()
  return {
    attributes = function(target, field)
      local handle = io.open(target, "rb")
      if not handle then return nil end
      local content = handle:read("*a") or ""
      handle:close()
      if field == "size" then return #content end
      return "file"
    end,
    mkdir = function() return true end,
  }
end

if scenario == "https_missing" then
  package.preload["socket.https"] = function() error("no TLS in this build") end
end

if scenario == "sink_write_failure" then
  -- Replace the wb file with a handle whose write fails after one chunk, so
  -- the client's own fileSink sees a mid-stream write failure (disk full).
  local real_io = io
  local writes_left = 1
  _G.io = {
    open = function(target, mode)
      if mode == "wb" then
        return {
          write = function(_, chunk)
            if writes_left > 0 then
              writes_left = writes_left - 1
              return #chunk
            end
            return nil, "No space left on device"
          end,
          close = function() return true end,
        }
      end
      return real_io.open(target, mode)
    end,
  }
end

local Client = assert(loadfile(client_path))()

local config_http = { base_url = "http://lan.test", api_key = "test-key", plugin_version = "test" }
local config_https = {
  base_url = "https://wan.test",
  api_key = "test-key",
  plugin_version = "test",
  request_block_timeout = 7,
  request_total_timeout = 123,
  download_block_timeout = 11,
  download_total_timeout = 456,
}

if scenario == "schemes" or scenario == "https_missing" then
  local http_body, http_err = Client.get(config_http, "/api/opds")
  local https_body, https_err = Client.get(config_https, "/api/opds")
  report("http_body", http_body)
  report("http_err", http_err)
  report("https_body", https_body)
  report("https_err", https_err)
  report("http_calls", #http_urls)
  report("https_calls", #https_urls)
  report("http_keys", table.concat(http_keys, ""))
  report("https_keys", table.concat(https_keys, ""))
  report("http_url", http_urls[1])
  report("https_url", https_urls[1])
  report("http_redirect", table.concat(http_redirect, ""))
  report("https_redirect", table.concat(https_redirect, ""))
  report("timeouts", table.concat(timeouts, "|"))
elseif scenario == "download" or scenario == "html" or scenario == "small_file"
    or scenario == "plain_download" or scenario == "sink_write_failure" then
  local target = workdir .. "/book.epub"
  local config_used = config_http
  if scenario ~= "plain_download" then
    config_used = config_https
  end
  local ok, err = Client.download(config_used, "/api/books/7/download/epub", target)
  report("ok", ok)
  report("err", err)
  local handle = io.open(target, "rb")
  local content = ""
  if handle then
    content = handle:read("*a") or ""
    handle:close()
  end
  report("file_exists", handle ~= nil)
  report("file_size", #content)
  report("file_only_final", content ~= "" and content:match("^E+$") ~= nil)
  report("http_calls", #http_urls)
  report("https_calls", #https_urls)
  report("http_keys", table.concat(http_keys, ""))
  report("https_keys", table.concat(https_keys, ""))
  report("http_redirect", table.concat(http_redirect, ""))
  report("https_redirect", table.concat(https_redirect, ""))
  report("timeouts", table.concat(timeouts, "|"))
else
  local body, err = Client.get(config_http, "/api/opds")
  report("body", body)
  report("err", err)
  report("http_calls", #http_urls)
  report("https_calls", #https_urls)
  report("http_keys", table.concat(http_keys, ""))
  report("https_keys", table.concat(https_keys, ""))
  report("http_last", http_urls[#http_urls])
  report("https_last", https_urls[#https_urls])
  report("http_redirect", table.concat(http_redirect, ""))
  report("https_redirect", table.concat(https_redirect, ""))
end
`;

/** Runs one client-harness scenario and returns its key=value output. */
function runClientScenario(scenario: string): Record<string, string> {
  const workdir = fs.mkdtempSync(path.join(os.tmpdir(), `koplugin-client-${scenario}-`));
  const harnessPath = path.join(workdir, "client_harness.lua");
  fs.writeFileSync(harnessPath, LIGHTHOUSE_CLIENT_HARNESS);
  const res = spawnSync(
    LUA_BINARY as string,
    [
      harnessPath,
      path.join(KOPLUGIN_TEMPLATE_DIR, "lighthouse_client.lua"),
      scenario,
      workdir,
    ],
    { encoding: "utf8" },
  );
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

describe("plugin HTTP client transport selection", () => {
  it("uses socket.http for http:// and socket.https for https://", () => {
    if (!LUA_BINARY) return;
    const out = runClientScenario("schemes");
    expect(out.http_body).toBe("body-for-http");
    expect(out.http_err).toBe("nil");
    expect(out.https_body).toBe("body-for-https");
    expect(out.https_err).toBe("nil");
    // Exactly one call per transport: the scheme alone picks the transport.
    expect(out.http_calls).toBe("1");
    expect(out.https_calls).toBe("1");
    expect(out.http_url).toBe("http://lan.test/api/opds");
    expect(out.https_url).toBe("https://wan.test/api/opds");
    // Transport contract (LuaSocket's request table): the plugin must disable
    // LuaSocket's internal redirect following on every request. Real LuaSocket
    // otherwise follows 3xx hops itself, forwarding the same header table —
    // including X-API-Key — to every host, which defeats the plugin's own
    // cross-host stripping loop (verified live with LuaSocket 3.1.0).
    expect(out.http_redirect).toBe("false");
    expect(out.https_redirect).toBe("false");
  });

  it("passes the configured timeouts to socketutil", () => {
    if (!LUA_BINARY) return;
    const out = runClientScenario("schemes");
    // Defaults for the plain config, then the configured values for the https one.
    expect(out.timeouts).toContain("10/90");
    expect(out.timeouts).toContain("7/123");
  });

  it("reports https_unavailable instead of failing obscurely without TLS", () => {
    if (!LUA_BINARY) return;
    const out = runClientScenario("https_missing");
    expect(out.https_body).toBe("nil");
    expect(out.https_err).toBe("https_unavailable");
    // Plain LAN HTTP keeps working on a TLS-less build.
    expect(out.http_body).toBe("body-for-http");
    expect(out.http_calls).toBe("1");
  });
});

describe("plugin HTTP client redirect handling", () => {
  it("follows 301 and 302 hops, switching transport when the scheme changes", () => {
    if (!LUA_BINARY) return;
    const out = runClientScenario("redirect");
    expect(out.body).toBe("final-body");
    expect(out.err).toBe("nil");
    expect(out.http_calls).toBe("1");
    // Hop 2 is https://wan.test/api/opds, hop 3 is the relative /v2/opds.
    expect(out.https_calls).toBe("2");
    expect(out.https_last).toBe("https://wan.test/v2/opds");
  });

  it("strips X-API-Key on a cross-host hop but keeps it on the first request", () => {
    if (!LUA_BINARY) return;
    const out = runClientScenario("redirect");
    // Hop 1 (same origin as the config) carries the server API key.
    expect(out.http_keys).toBe("Y");
    // Hop 2 crosses to wan.test (captive-portal style) and hop 3 stays there:
    // the key must be dropped at the cross-host boundary and never restored.
    expect(out.https_keys).toBe("NN");
    // The plugin's redirect loop can only enforce that boundary if the real
    // transport is not following hops (and re-sending the key) itself.
    // One entry per hop: 1 http hop, then 2 https hops, all with redirect
    // following disabled.
    expect(out.http_redirect).toBe("false");
    expect(out.https_redirect).toBe("falsefalse");
  });

  it("keeps X-API-Key when a download redirect stays on the same host", () => {
    if (!LUA_BINARY) return;
    const out = runClientScenario("download");
    // Both https hops resolve under https://wan.test, so the key survives.
    expect(out.https_keys).toBe("YY");
    // Same transport contract as GETs: internal following disabled on both
    // hops (one entry per hop).
    expect(out.https_redirect).toBe("falsefalse");
  });

  it("resolves a relative Location against the request directory", () => {
    if (!LUA_BINARY) return;
    const out = runClientScenario("relative");
    expect(out.body).toBe("second");
    expect(out.err).toBe("nil");
    expect(out.http_calls).toBe("2");
    expect(out.http_last).toBe("http://lan.test/api/opds?start=40");
  });

  it("keeps the current path for a query-only Location", () => {
    if (!LUA_BINARY) return;
    const out = runClientScenario("query_redirect");
    expect(out.body).toBe("second");
    expect(out.err).toBe("nil");
    expect(out.http_last).toBe("http://lan.test/api/opds?start=40");
  });

  it("stops after the redirect budget with an actionable error", () => {
    if (!LUA_BINARY) return;
    const out = runClientScenario("too_many");
    expect(out.body).toBe("nil");
    expect(out.err).toBe("too_many_redirects");
    // The initial request plus five followed hops, never an endless loop.
    expect(out.http_calls).toBe("6");
  });

  it("reports a redirect with no usable Location header", () => {
    if (!LUA_BINARY) return;
    const out = runClientScenario("missing_location");
    expect(out.err).toBe("invalid_redirect");
    expect(out.http_calls).toBe("1");
  });

  it("keeps the transport error detail for diagnosis", () => {
    if (!LUA_BINARY) return;
    const out = runClientScenario("transport_error");
    expect(out.body).toBe("nil");
    expect(out.err).toBe("network_error: timeout");
  });
});

describe("plugin EPUB download", () => {
  it("follows a redirect and keeps only the final payload in the file", () => {
    if (!LUA_BINARY) return;
    const out = runClientScenario("download");
    expect(out.ok).toBe("true");
    expect(out.err).toBe("nil");
    expect(out.https_calls).toBe("2");
    expect(out.file_exists).toBe("true");
    // 900 bytes of the final hop: the 1000-byte redirect body was truncated.
    expect(out.file_size).toBe("900");
    expect(out.file_only_final).toBe("true");
    // Download timeouts come from the configuration, not the defaults.
    expect(out.timeouts).toContain("11/456");
  });

  it("refuses to save a web page as an EPUB", () => {
    if (!LUA_BINARY) return;
    const out = runClientScenario("html");
    expect(out.ok).toBe("nil");
    expect(out.err).toBe("html_response");
    expect(out.file_exists).toBe("false");
  });

  it("rejects a payload too small to be a book", () => {
    if (!LUA_BINARY) return;
    const out = runClientScenario("small_file");
    expect(out.ok).toBe("nil");
    expect(out.err).toBe("empty_response");
    expect(out.file_exists).toBe("false");
  });

  it("keeps plain LAN HTTP downloads working with no redirect", () => {
    if (!LUA_BINARY) return;
    const out = runClientScenario("plain_download");
    expect(out.ok).toBe("true");
    expect(out.err).toBe("nil");
    // One plain-HTTP request, no TLS hop, and the default download budget.
    expect(out.http_calls).toBe("1");
    expect(out.https_calls).toBe("0");
    expect(out.file_size).toBe("900");
    expect(out.timeouts).toBe("15/300");
  });

  it("labels a mid-stream sink write failure as file_error, not a network error", () => {
    if (!LUA_BINARY) return;
    const out = runClientScenario("sink_write_failure");
    expect(out.ok).toBe("nil");
    // A full disk is a storage failure: the client must keep the sink's own
    // file_error code instead of relabeling it network_error (wrong advice).
    expect((out.err ?? "").startsWith("file_error:")).toBe(true);
    expect(out.err).toContain("No space left on device");
    // The partial download must not survive as a broken book.
    expect(out.file_exists).toBe("false");
  });
});

/**
 * Parses one XML document with the plugin's own OPDS parser and returns the
 * flattened first-entry fields.
 */
function parseOpdsWithPlugin(xml: string): Record<string, string> {
  const xmlPath = writeScratch("feed.xml", xml);
  const parserPath = path.join(KOPLUGIN_TEMPLATE_DIR, "lighthouse_opds.lua");
  const harnessPath = writeScratch(
    "attrs_harness.lua",
    `
local OPDS = assert(loadfile(${JSON.stringify(parserPath)}))()
local handle = assert(io.open(${JSON.stringify(xmlPath)}, "rb"))
local xml = handle:read("*a")
handle:close()
local feed = OPDS.parse(xml)
print("count=" .. tostring(#feed.entries))
local entry = feed.entries[1]
if entry then
  print("authors=" .. tostring(entry.authors))
  print("title=" .. tostring(entry.title))
  print("download=" .. tostring(entry.download_href))
  print("thumbnail=" .. tostring(entry.thumbnail_href))
  print("cover=" .. tostring(entry.cover_href))
  print("book_id=" .. tostring(entry.book_id))
  print("series=" .. tostring(entry.series))
  print("tags=" .. table.concat(entry.tags, ","))
end
`,
  );
  const res = spawnSync(LUA_BINARY as string, [harnessPath], { encoding: "utf8" });
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

describe("plugin OPDS parser hardening", () => {
  it("parses single-quoted attributes so a strict feed still offers downloads", () => {
    if (!LUA_BINARY) return;
    const out = parseOpdsWithPlugin(`<?xml version="1.0" encoding="utf-8"?>
<feed xmlns="http://www.w3.org/2005/Atom"><title>Quoted</title>
<entry><title>Quoted Book</title><id>urn:calibre:book:9</id>
<link rel='http://opds-spec.org/acquisition' href='http://h/api/books/9/download/epub' type='application/epub+zip'/>
<link rel='http://opds-spec.org/image' href='http://h/api/books/9/cover' type='image/jpeg'/>
<category term='Saga' label='Volume 3'/>
</entry></feed>`);
    expect(out.count).toBe("1");
    expect(out.download).toBe("http://h/api/books/9/download/epub");
    expect(out.cover).toBe("http://h/api/books/9/cover");
    expect(out.series).toBe("Saga");
    expect(out.book_id).toBe("9");
  });

  it("joins every contributor instead of keeping only the first name", () => {
    if (!LUA_BINARY) return;
    const out = parseOpdsWithPlugin(`<feed><title>Authors</title>
<entry><title>Two Authors</title><id>urn:calibre:book:3</id>
<author><name>Ann One</name></author><author><name>Bob Two</name></author>
</entry></feed>`);
    expect(out.count).toBe("1");
    expect(out.authors).toBe("Ann One, Bob Two");
  });

  it("falls back to dc:creator and never repeats a contributor", () => {
    if (!LUA_BINARY) return;
    const dc = parseOpdsWithPlugin(`<feed><title>DC</title>
<entry><title>DC Book</title><id>urn:calibre:book:4</id><dc:creator>Cy Creator</dc:creator>
</entry></feed>`);
    expect(dc.authors).toBe("Cy Creator");

    const duplicate = parseOpdsWithPlugin(`<feed><title>Dup</title>
<entry><title>Dup Book</title><id>urn:calibre:book:5</id>
<author><name>Ann One</name></author><author><name>Ann One</name></author>
</entry></feed>`);
    expect(duplicate.authors).toBe("Ann One");
  });

  it("salvages a trailing entry from a truncated feed", () => {
    if (!LUA_BINARY) return;
    const out = parseOpdsWithPlugin(`<feed><title>Cut</title>
<entry><title>Half Book</title><id>urn:calibre:book:6</id>
<author><name>Trunc Author</name></author>
<link rel="http://opds-spec.org/acquisition" href="http://h/api/books/6/download/epub" type="application/epub+zip"/>`);
    expect(out.count).toBe("1");
    expect(out.title).toBe("Half Book");
    expect(out.book_id).toBe("6");
    expect(out.download).toBe("http://h/api/books/6/download/epub");
  });
});

/**
 * Harness for the pure helpers in `main.lua` (filename building, error mapping,
 * spinner error reporting), loaded with the same KOReader stubs as the boot test.
 * The prelude is concatenated at run time because it is declared below.
 *
 * Non-ASCII never appears inside a `String.raw` template: the transpiler escapes
 * it to `\uXXXX`, which `String.raw` then keeps literally and Lua rejects. The
 * Burmese probe is therefore injected as decimal byte escapes, which is how Lua
 * 5.1 spells raw UTF-8 bytes inside a string literal.
 */
const BURMESE_PROBE = "မြန်မာစာ";

/** Renders a UTF-8 string as a Lua literal of decimal byte escapes. */
function luaByteEscapes(text: string): string {
  return Array.from(Buffer.from(text, "utf8"))
    .map((byte) => `\\${byte}`)
    .join("");
}

const LIGHTHOUSE_HELPERS_BODY = String.raw`
local LightHouse = assert(loadfile(plugin_root .. "/main.lua"))()
local build = assert(LightHouse.buildFilename, "buildFilename must be reachable")

print("fn_int=" .. build({ title = "Book", authors = "Author", series = "Saga", series_index = 1 }))
print("fn_frac=" .. build({ title = "Book", authors = "Author", series = "Saga", series_index = 1.5 }))
print("fn_str=" .. build({ title = "Book", authors = "Author", series = "Saga", series_index = "7" }))
print("fn_missing=" .. build({ title = "Book", authors = "Author", series = "Saga" }))
print("fn_junk=" .. build({ title = "Book", authors = "Author", series = "Saga", series_index = "abc" }))
print("fn_zero=" .. build({ title = "Book", authors = "Author", series = "Saga", series_index = 0 }))
print("fn_neg=" .. build({ title = "Book", authors = "Author", series = "Saga", series_index = -3 }))
print("fn_nan=" .. build({ title = "Book", authors = "Author", series = "Saga", series_index = 0/0 }))
print("fn_huge=" .. build({ title = "Book", authors = "Author", series = "Saga", series_index = 1e12 }))
print("fn_noauthor=" .. build({ title = "Book", authors = "", series = "Saga", series_index = 2 }))
print("fn_untitled=" .. build({ book_id = 55 }))
print("fn_seriesonly=" .. build({ series = "Saga", series_index = 3, authors = "Author" }))
print("fn_sanitized=" .. build({ title = "A/B:C", authors = "D|E" }))
print("fn_numeric=" .. build({ title = 42, authors = 7 }))
local mrtitle = "${luaByteEscapes(BURMESE_PROBE)}"
print("fn_burmese=" .. build({ title = string.rep(mrtitle, 40), authors = "Author" }))
print("fn_burmese_bytes=" .. #build({ title = string.rep(mrtitle, 40), authors = "Author" }))

print("idx_2=" .. tostring(LightHouse.formatSeriesIndex(2)))
print("idx_2_5=" .. tostring(LightHouse.formatSeriesIndex(2.5)))
print("idx_nil=" .. tostring(LightHouse.formatSeriesIndex(nil)))

local logs = _G.__lighthouse_logs
local _, spin_err = LightHouse:withSpinner("loading", function() error("boom") end)
print("spin_err=" .. tostring(spin_err))
print("spin_log_count=" .. tostring(#logs))
print("spin_log_has_detail=" .. tostring(table.concat(logs, "|"):find("boom", 1, true) ~= nil))

local body, request_err = LightHouse:withSpinner("loading", function() return nil, "network_error: timeout" end)
print("spin_body=" .. tostring(body))
print("spin_request_err=" .. tostring(request_err))
print("spin_failure_logged=" .. tostring(#logs == 2))
print("spin_ok=" .. tostring(LightHouse:withSpinner("loading", function() return "payload" end)))

print("err_https=" .. LightHouse.describeError("https_unavailable"))
print("err_network=" .. LightHouse.describeError("network_error: timeout"))
print("err_exception=" .. LightHouse.describeError("exception: boom"))
print("err_file=" .. LightHouse.describeError("file_error: cannot write /tmp/x.epub"))
print("err_html=" .. LightHouse.describeError("html_response"))
print("err_redirects=" .. LightHouse.describeError("too_many_redirects"))
print("err_unknown=" .. LightHouse.describeError("something_else"))
`;

/** Runs the pure-helper harness against the committed template. */
function runHelperHarness(): Record<string, string> {
  const workdir = fs.mkdtempSync(path.join(os.tmpdir(), "koplugin-helpers-"));
  const harnessPath = path.join(workdir, "helpers_harness.lua");
  fs.writeFileSync(harnessPath, KOREADER_STUB_PRELUDE + LIGHTHOUSE_HELPERS_BODY);
  const res = spawnSync(
    LUA_BINARY as string,
    [harnessPath, KOPLUGIN_TEMPLATE_DIR],
    { encoding: "utf8" },
  );
  // error("boom") inside the pcall must not reach the harness stderr.
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

describe("plugin filename building", () => {
  it("formats an integer series index with two digits", () => {
    if (!LUA_BINARY) return;
    const out = runHelperHarness();
    expect(out.fn_int).toBe("Saga 01 - Book - Author.epub");
    expect(out.fn_str).toBe("Saga 07 - Book - Author.epub");
    expect(out.fn_zero).toBe("Saga 00 - Book - Author.epub");
  });

  it("keeps a fractional Calibre index instead of crashing on %02d", () => {
    if (!LUA_BINARY) return;
    const out = runHelperHarness();
    expect(out.fn_frac).toBe("Saga 01.5 - Book - Author.epub");
    expect(out.idx_2).toBe("02");
    expect(out.idx_2_5).toBe("02.5");
  });

  it("degrades safely for a missing, junk, negative, NaN or huge index", () => {
    if (!LUA_BINARY) return;
    const out = runHelperHarness();
    expect(out.fn_missing).toBe("Saga - Book - Author.epub");
    expect(out.fn_junk).toBe("Saga - Book - Author.epub");
    expect(out.fn_nan).toBe("Saga - Book - Author.epub");
    expect(out.fn_neg).toBe("Saga 00 - Book - Author.epub");
    expect(out.fn_huge).toBe("Saga 9999 - Book - Author.epub");
    expect(out.idx_nil).toBe("nil");
  });

  it("sanitizes metadata and falls back to the book id", () => {
    if (!LUA_BINARY) return;
    const out = runHelperHarness();
    expect(out.fn_sanitized).toBe("A_B_C - D_E.epub");
    expect(out.fn_noauthor).toBe("Saga 02 - Book.epub");
    expect(out.fn_untitled).toBe("lighthouse-55.epub");
    expect(out.fn_seriesonly).toBe("Saga 03 - Author.epub");
    expect(out.fn_numeric).toBe("42 - 7.epub");
  });

  it("truncates a long Burmese title on a UTF-8 boundary", () => {
    if (!LUA_BINARY) return;
    const out = runHelperHarness();
    expect(Number(out.fn_burmese_bytes)).toBeLessThanOrEqual(125);
    expect(out.fn_burmese.endsWith(".epub")).toBe(true);
    // A split multi-byte sequence would decode as U+FFFD here.
    expect(out.fn_burmese).not.toContain("\uFFFD");
    expect(out.fn_burmese).toContain(BURMESE_PROBE);
  });
});

describe("plugin error reporting", () => {
  it("keeps the raised error detail instead of collapsing to 'exception'", () => {
    if (!LUA_BINARY) return;
    const out = runHelperHarness();
    expect(out.spin_err.startsWith("exception: ")).toBe(true);
    expect(out.spin_err).toContain("boom");
    expect(out.spin_err).not.toBe("exception");
    expect(out.spin_log_count).toBe("1");
    expect(out.spin_log_has_detail).toBe("true");
  });

  it("logs a returned request error while passing it through", () => {
    if (!LUA_BINARY) return;
    const out = runHelperHarness();
    expect(out.spin_body).toBe("nil");
    expect(out.spin_request_err).toBe("network_error: timeout");
    expect(out.spin_failure_logged).toBe("true");
    expect(out.spin_ok).toBe("payload");
  });

  it("maps every client error to a distinct, actionable message", () => {
    if (!LUA_BINARY) return;
    const out = runHelperHarness();
    expect(out.err_https).toContain("TLS");
    expect(out.err_network).toContain("Wi-Fi");
    expect(out.err_exception).toBe("The request failed: boom");
    expect(out.err_file).toContain("/tmp/x.epub");
    expect(out.err_html).toContain("web page");
    expect(out.err_redirects).toContain("too many times");
    expect(out.err_unknown).toBe("Something went wrong.");
    const messages = new Set([
      out.err_https,
      out.err_network,
      out.err_exception,
      out.err_file,
      out.err_html,
      out.err_redirects,
      out.err_unknown,
    ]);
    expect(messages.size).toBe(7);
  });
});

/**
 * Loads the *extracted* generated plugin with KOReader's own module names
 * stubbed out, and asserts the real plugin tree boots and builds its menu.
 *
 * This is the closest verification available without a device: KOReader's
 * PluginLoader does exactly `dofile(plugin_root .. "/main.lua")` with
 * `plugin_root` on `package.path`, which is what this harness reproduces.
 *
 * `KOREADER_STUB_PRELUDE` is shared with the filename/spinner harness below so
 * both run against the same stubs.
 */
const KOREADER_STUB_PRELUDE = String.raw`
local plugin_root = assert(arg[1], "plugin root argument required")
package.path = plugin_root .. "/?.lua;" .. package.path

-- ---------------------------------------------------------------- KOReader stubs
local shown = {}
local logs = {}
_G.__lighthouse_logs = logs

-- KOReader widgets are constructed with Widget:new{...} (colon call), so the
-- stub must accept (self, options) and hand the options table back with a tag.
local function stub_widget(kind)
  local widget = {}
  function widget:new(options)
    options = options or {}
    options.__kind = kind
    return options
  end
  return widget
end

package.preload["datastorage"] = function()
  return {
    getDataDir = function() return "/tmp/lighthouse-data" end,
    getSettingsDir = function() return "/tmp/lighthouse-settings" end,
  }
end
-- The plugin asks the device for the screen height and scale so one layout
-- rule serves every e-ink size; the stub reports a plain 600x800 screen.
package.preload["device"] = function()
  return {
    screen = {
      getWidth = function() return 600 end,
      getHeight = function() return 800 end,
      scaleBySize = function(_, size) return size end,
    },
  }
end
-- Cover slots are widgets; the plugin builds them only when covers are on and
-- a catalog row is drawn, so the stubs only need to accept the options table.
package.preload["ui/widget/imagewidget"] = function() return stub_widget("imagewidget") end
package.preload["ui/widget/container/framecontainer"] = function() return stub_widget("framecontainer") end
package.preload["ui/widget/container/centercontainer"] = function() return stub_widget("centercontainer") end
package.preload["ui/widget/textwidget"] = function() return stub_widget("textwidget") end
package.preload["ui/font"] = function()
  return { getFace = function(_, name) return "face:" .. tostring(name) end }
end
-- main.lua reads the padding menu.lua subtracts from a row's content width,
-- so the stubs report the same tokens a 160-dpi device reports.
package.preload["ui/size"] = function()
  return {
    padding = { fullscreen = 10 },
    border = { window = 2 },
    span = { horizontal_default = 7, horizontal_small = 4 },
  }
end
package.preload["ui/geometry"] = function()
  local geom = {}
  function geom:new(options)
    options = options or {}
    options.__kind = "geom"
    return options
  end
  return geom
end
package.preload["ui/downloadmgr"] = function()
  local manager = {}
  function manager:new(options)
    options = options or {}
    setmetatable(options, { __index = manager })
    return options
  end
  function manager:chooseDir() end
  return manager
end
package.preload["ui/widget/infomessage"] = function() return stub_widget("infomessage") end
package.preload["ui/widget/inputdialog"] = function()
  local dialog = {}
  function dialog:new(options)
    options = options or {}
    options.__kind = "inputdialog"
    options.getInputText = function() return options.__text or "dune" end
    options.onShowKeyboard = function() end
    return options
  end
  return dialog
end
package.preload["ui/widget/confirmbox"] = function() return stub_widget("confirmbox") end
package.preload["ui/widget/textviewer"] = function() return stub_widget("textviewer") end
package.preload["json"] = function()
  return { decode = function() return {} end }
end
package.preload["ui/widget/menu"] = function()
  local menu = {}
  function menu:new(options)
    options = options or {}
    options.__kind = "menu"
    options.switched = {}
    function options:switchItemTable(title, items)
      self.switched[#self.switched + 1] = { title = title, items = items }
    end
    return options
  end
  return menu
end
package.preload["ui/network/manager"] = function()
  return {
    isOnline = function() return true end,
    willRerunWhenOnline = function(_, func) func() end,
  }
end
package.preload["ui/uimanager"] = function()
  return {
    show = function(_, widget) shown[#shown + 1] = widget end,
    close = function() end,
    forceRePaint = function() end,
  }
end
package.preload["ui/widget/container/widgetcontainer"] = function()
  return { extend = function(_, object) return object end }
end
package.preload["ffi/util"] = function()
  return {
    -- Faithful to KOReader's 'T' (frontend/ffi/util.lua template): the
    -- substitutions go to string.gsub as the replacement value, exactly as
    -- they do on the device. That is what raised
    --   ./luajit: ./ffi/util.lua:779: invalid replacement value (a function)
    -- and killed the process, so the harness has to reproduce it. A stub that
    -- formats its arguments would report this crash class as fixed while the
    -- device still dies.
    template = function(text, ...)
      local values = { ... }
      -- KOReader also accepts a single table of substitutions.
      if type(values[1]) == "table" then values = values[1] end
      -- The callback returns the value it was given, so a function, a table or
      -- a userdata substitution makes gsub itself raise
      -- "invalid replacement value (a function)" - the device crash. Numbers
      -- are converted by gsub, which is why a series index still prints.
      return (text:gsub("%%(%d+)", function(index)
        return values[tonumber(index)]
      end))
    end,
  }
end
package.preload["libs/libkoreader-lfs"] = function()
  return { attributes = function() return nil end, mkdir = function() return true end }
end
package.preload["logger"] = function()
  -- Warnings are recorded instead of printed so a harness can assert on them
  -- without polluting the key=value output these harnesses parse.
  return {
    dbg = function() end,
    info = function() end,
    err = function() end,
    warn = function(...)
      local parts = {}
      for index = 1, select("#", ...) do
        parts[#parts + 1] = tostring((select(index, ...)))
      end
      logs[#logs + 1] = table.concat(parts, " ")
    end,
  }
end
package.preload["util"] = function()
  return { urlEncode = function(value) return tostring(value) end }
end
package.preload["gettext"] = function()
  -- KOReader's gettext module is a table with a __call metamethod, not a bare
  -- function, so both the callable form and .ngettext keep working.
  local gettext = setmetatable({}, { __call = function(_, text) return text end })
  gettext.ngettext = function(single, plural, count) return count == 1 and single or plural end
  return gettext
end
package.preload["socket.http"] = function() return { request = function() return 1, 200 end } end
package.preload["socket"] = function() return { skip = function(_, ...) return ... end } end
package.preload["ltn12"] = function()
  return { sink = { table = function() end, file = function() end } }
end
package.preload["socketutil"] = function()
  return { set_timeout = function() end, reset_timeout = function() end }
end

_G.G_reader_settings = {
  readSetting = function() return nil end,
  saveSetting = function() end,
}
`;

const KOREADER_STUB_HARNESS = KOREADER_STUB_PRELUDE + String.raw`
local expected_base_url = assert(arg[2], "expected base url argument required")
local LightHouse = assert(loadfile(plugin_root .. "/main.lua"))()
local config = require("lighthouse_config")

assert(type(LightHouse) == "table", "main.lua must return a plugin table")
print("name=" .. tostring(LightHouse.name))
print("doc_only=" .. tostring(LightHouse.is_doc_only))
print("base_url=" .. tostring(config.base_url))
print("api_key_configured=" .. tostring(config.api_key ~= nil and config.api_key ~= ""))
assert(config.base_url == expected_base_url,
  "generated config must target the request origin, got " .. tostring(config.base_url))

-- PluginLoader contract: init() must register the plugin in the main menu.
local registered = 0
LightHouse.ui = { menu = { registerToMainMenu = function() registered = registered + 1 end } }
LightHouse:init()
print("registered=" .. tostring(registered))

-- Menu structure
local menu_items = {}
LightHouse:addToMainMenu(menu_items)
local entry = assert(menu_items.lighthouse, "plugin must add a 'lighthouse' main-menu entry")
assert(entry.text == "LightHouse library", "unexpected menu text: " .. tostring(entry.text))
assert(entry.sorting_hint == "search", "unexpected sorting hint")
local labels = {}
for _, item in ipairs(entry.sub_item_table) do labels[#labels + 1] = item.text end
print("submenu=" .. table.concat(labels, "|"))

-- Catalog row rendering, including rating + progress from a merged session.
local entry = {
  book_id = 101,
  title = "Spice and Wolf, Vol. 1",
  authors = "Isuna Hasekura",
  series = "Spice and Wolf",
  series_index = 1,
  tags = { "Fantasy" },
  summary = "A merchant meets a wolf.",
  download_href = "http://host/api/books/101/download/epub",
  rating = 8,
  status = { percentage = 0.45, device = "Paperwhite", timestamp = 1 },
}
-- The row language: the title is the row text, and the metadata column
-- carries author, series, progress and rating so none of them needs a tap.
local layout = LightHouse:layoutFor(true)
print("layout_rows=" .. tostring(layout.rows))
print("layout_cover=" .. tostring(layout.cover_width) .. "x" .. tostring(layout.cover_height))
print("layout_gutter=" .. tostring(layout.gutter))
local row = LightHouse:buildCatalogItem(entry, layout)
print("row_text=" .. tostring(row.text))
print("row_text_has_newline=" .. tostring(tostring(row.text):find("\n", 1, true) ~= nil))
print("row_mandatory=" .. tostring(row.mandatory))
print("row_state=" .. tostring(type(row.state) == "table" and row.state.__kind or "none"))
local no_cover_row = LightHouse:buildCatalogItem(entry)
print("row_nocover_text=" .. tostring(no_cover_row.text))
print("row_nocover_mandatory=" .. tostring(no_cover_row.mandatory))
local detail_labels = {}
for detail_index = 1, #row.sub_item_table do
  detail_labels[#detail_labels + 1] = row.sub_item_table[detail_index].text
end
print("detail=" .. table.concat(detail_labels, "|"))

-- A long author and series run must never push the progress bar, the finished
-- check or the stars out of the metadata column.
local long_row = LightHouse:buildCatalogItem({
  book_id = 102,
  title = "The Way of Kings",
  authors = "Brandon Sanderson",
  series = "The Stormlight Archive",
  series_index = 1,
  rating = 8,
  status = { percentage = 1, device = "Kobo", timestamp = 1 },
}, layout)
print("long_text=" .. tostring(long_row.text))
print("long_mandatory=" .. tostring(long_row.mandatory))
print("long_limit=" .. tostring(require("lighthouse_ui").tokens.meta_max_chars))

-- Connection screen must expose the baked-in origin and endpoint paths.
LightHouse:showConnection(true)
local connection = shown[#shown]
assert(connection and connection.__kind == "textviewer", "connection view must be a TextViewer")
print("connection_has_origin=" .. tostring(connection.text:find(expected_base_url, 1, true) ~= nil))
print("connection_has_opds=" .. tostring(connection.text:find("/api/opds", 1, true) ~= nil))
print("connection_has_progress=" .. tostring(connection.text:find("/api/kosync/active", 1, true) ~= nil))
print("connection_has_covers=" .. tostring(connection.text:find("Cover thumbnails:", 1, true) ~= nil))

print("OK")
`;

describe("generated plugin tree boots like a real KOReader plugin", () => {
  it("extracts into koreader/plugins/lighthouse.koplugin and loads main.lua", () => {
    if (!LUA_BINARY || !UNZIP_BINARY) return;

    const { zip } = generateKoplugin({
      baseUrl: "http://192.168.31.15:8086",
      apiKey: "harness-api-key",
      generatedAt: "2026-11-14T00:00:00.000Z",
    });

    const workdir = fs.mkdtempSync(path.join(os.tmpdir(), "koplugin-tree-"));
    const zipPath = path.join(workdir, "lighthouse.koplugin");
    fs.writeFileSync(zipPath, zip);

    // Reproduce the documented install step: unzip into the plugins directory.
    const pluginsDir = path.join(workdir, "plugins");
    fs.mkdirSync(pluginsDir, { recursive: true });
    const extract = spawnSync(
      UNZIP_BINARY as string,
      ["-q", zipPath, "-d", pluginsDir],
      { encoding: "utf8" },
    );
    expect(extract.status).toBe(0);

    const pluginRoot = path.join(pluginsDir, KOPLUGIN_DIR_NAME);
    expect(fs.statSync(pluginRoot).isDirectory()).toBe(true);
    expect(fs.existsSync(path.join(pluginRoot, "main.lua"))).toBe(true);
    expect(fs.existsSync(path.join(pluginRoot, "_meta.lua"))).toBe(true);
    // The config inside the tree is the generated one, not the template.
    const config = fs.readFileSync(
      path.join(pluginRoot, KOPLUGIN_CONFIG_FILE),
      "utf8",
    );
    expect(config).toContain('base_url = "http://192.168.31.15:8086"');

    const harnessPath = path.join(workdir, "boot_harness.lua");
    fs.writeFileSync(harnessPath, KOREADER_STUB_HARNESS);

    const res = spawnSync(
      LUA_BINARY,
      [harnessPath, pluginRoot, "http://192.168.31.15:8086"],
      { encoding: "utf8" },
    );
    expect(res.stderr).toBe("");
    expect(res.status).toBe(0);

    const out = Object.fromEntries(
      res.stdout
        .split("\n")
        .filter((line) => line.includes("="))
        .map((line) => {
          const index = line.indexOf("=");
          return [line.slice(0, index), line.slice(index + 1)];
        }),
    );

    expect(out.name).toBe("lighthouse");
    expect(out.doc_only).toBe("false");
    expect(out.base_url).toBe("http://192.168.31.15:8086");
    expect(out.api_key_configured).toBe("true");
    expect(out.registered).toBe("1");

    const submenu = out.submenu.split("|");
    expect(submenu).toContain("Browse library");
    expect(submenu).toContain("Search library…");
    expect(submenu).toContain("Currently reading");
    expect(submenu).toContain("Show cover thumbnails");
    expect(submenu).toContain("Choose download folder…");
    expect(submenu).toContain("Connection");

    // Row anatomy: the title is the row text, and the right-hand metadata
    // column carries author, series, progress and rating together. KOReader's
    // MenuItem flattens newlines out of the row text, so the metadata must not
    // be a second line in `text`.
    expect(out.row_text).toBe("Spice and Wolf, Vol. 1");
    expect(out.row_text_has_newline).toBe("false");
    expect(out.row_mandatory).toContain("Isuna Hasekura");
    expect(out.row_mandatory).toContain("Spice and Wolf 01");
    expect(out.row_mandatory).toContain("45%");
    expect(out.row_mandatory).toContain("★★★★☆");
    expect(out.row_mandatory).not.toContain("\n");

    // A long author and series run must keep the whole glance: the bar, the
    // finished check and all five stars. Capping the composed metadata string
    // would leave this row showing three stars.
    expect(out.long_text).toBe("The Way of Kings");
    expect(out.long_mandatory).toContain("Brandon Sanderson");
    expect(out.long_mandatory).toContain("100%");
    expect(out.long_mandatory).toContain("✓");
    expect(out.long_mandatory.endsWith("★★★★☆")).toBe(true);
    expect(Array.from(out.long_mandatory).length).toBeLessThanOrEqual(
      Number(out.long_limit),
    );

    // Covers: one geometry rule drives the page, and a row whose cover is not on
    // disk yet draws the neutral placeholder rather than a blank hole.
    const layoutRows = Number(out.layout_rows);
    const [layoutCoverW, layoutCoverH] = out.layout_cover.split("x").map(Number);
    expect(layoutRows).toBeGreaterThanOrEqual(4);
    expect(layoutRows).toBeLessThanOrEqual(9);
    expect(layoutCoverW).toBeGreaterThan(0);
    // Calibre cover art is portrait: a cover box wider than it is tall would
    // squash every thumbnail on the page.
    expect(layoutCoverH).toBeGreaterThan(layoutCoverW);
    expect(Number(out.layout_gutter)).toBeGreaterThan(layoutCoverW);
    expect(out.row_state).toBe("framecontainer");
    // Without a layout (a caller that does not draw covers) the row keeps the
    // same shape: title in the row text, metadata in the column.
    expect(out.row_nocover_text).toBe("Spice and Wolf, Vol. 1");
    expect(out.row_nocover_mandatory).toBe(out.row_mandatory);

    const detail = out.detail.split("|");
    expect(detail[0]).toBe("Download EPUB");
    expect(detail).toContain("Author: Isuna Hasekura");
    expect(detail).toContain("Series: Spice and Wolf #1");
    expect(detail).toContain("Rating: 4.0 / 5");
    expect(detail).toContain("Progress: ████░░░░ 45% · Paperwhite");
    expect(detail).toContain("Synopsis");
    expect(detail).toContain("Tags: Fantasy");

    expect(out.connection_has_origin).toBe("true");
    expect(out.connection_has_opds).toBe("true");
    expect(out.connection_has_progress).toBe("true");
    expect(out.connection_has_covers).toBe("true");
    expect(res.stdout.trimEnd().endsWith("OK")).toBe(true);
  });
});

/**
 * The device crash this guards against (KOReader `crash.log`, 11/15/26):
 *
 *   main.lua:569: attempt to call local '_' (a number value)
 *   main.lua:569: in function 'showReading'
 *   main.lua:248: in function 'callback'
 *
 * `showReading` used `for _, session in ipairs(sessions)`, which shadowed the
 * module-level gettext `_` for the whole loop body, so every `_("…")` inside
 * it indexed a number. The error escaped the menu callback and aborted the
 * process instead of showing a notice — tapping "Currently reading" dropped the
 * device back to the stock Kindle shell.
 *
 * A shadowed upvalue is invisible to `loadfile` compile checks, so the only
 * honest guard is running the shipped `showReading` against a realistic
 * `/api/kosync/active` payload and asserting it renders.
 */
const CURRENTLY_READING_HARNESS = (KOREADER_STUB_PRELUDE + String.raw`
local expected_base_url = assert(arg[2], "expected base url argument required")

-- Flips the transport into a link that answers nothing, for the failure case.
local failure = false

-- Field-for-field shape of GET /api/kosync/active (koreader-sync.db rows joined
-- against the Calibre library), newest first after normalization.
local payload = {
  {
    id = 41,
    document = "d6df0b1e0c6dec84dd52e6616fa669d8",
    progress = "/body/DocFragment[3]/body/div/p[12]",
    percentage = 0.45,
    device = "Paperwhite",
    device_id = "G000PP1234567890",
    filename = "01 - Spice and Wolf, Vol. 1.epub",
    title = "Spice and Wolf, Vol. 1",
    authors = "Isuna Hasekura",
    timestamp = 1794633720,
    bookId = 101,
    cover = "/api/books/101/cover",
    displayTitle = "Spice and Wolf, Vol. 1",
    displayAuthors = "Isuna Hasekura",
  },
  {
    id = 42,
    document = "aaaabbbbccccdddd0000111122223333",
    progress = "/body/DocFragment[2]/body/div/p[4]",
    percentage = 0.2,
    device = "Kindle",
    device_id = "G000K0987654321",
    filename = "Dune & Sons.epub",
    title = "dune and sons deluxe",
    authors = "Frank Herbert",
    timestamp = 1794633700,
    bookId = nil,
    cover = nil,
    displayTitle = "Dune & Sons <Deluxe>",
    displayAuthors = "Frank Herbert",
  },
  {
    -- An untitled session with no authors, device or filename: every fallback
    -- in the shelf has to render instead of concatenating nil.
    id = 43,
    document = "ffff0000ffff0000ffff0000ffff0000",
    progress = "",
    percentage = 0,
    device = nil,
    device_id = nil,
    filename = "",
    title = "",
    authors = nil,
    timestamp = 1794633600,
    bookId = nil,
    cover = nil,
    displayTitle = nil,
    displayAuthors = nil,
  },
  {
    -- Titled but uncredited: only the author fallback fires.
    id = 44,
    document = "11112222333344445555666677778888",
    progress = "",
    percentage = 1,
    device = "Kobo",
    device_id = nil,
    filename = "burmese-book.epub",
    title = "__BURMESE_PROBE__",
    authors = nil,
    timestamp = 1794633500,
    bookId = 202,
    cover = nil,
    displayTitle = "__BURMESE_PROBE__",
    displayAuthors = nil,
  },
}

-- Swap the transport stubs so the real
-- Client.get -> JSON.decode -> Status.normalizeSessions path runs against
-- the payload instead of the network. The payload stays an upvalue so an
-- empty shelf can be exercised with the same plugin instance.
package.preload["json"] = function()
  return { decode = function() return payload end }
end
package.preload["ltn12"] = function()
  return {
    sink = {
      table = function(target)
        return function(chunk)
          if chunk then target[#target + 1] = chunk end
          return 1
        end
      end,
      file = function() end,
    },
  }
end
package.preload["socket.http"] = function()
  return {
    request = function(request)
      if failure then return nil, "timeout" end
      if request and request.sink then
        request.sink('{"active":[]}')
        request.sink(nil)
      end
      return 1, 200, {}
    end,
  }
end

local LightHouse = assert(loadfile(plugin_root .. "/main.lua"))()
local config = require("lighthouse_config")
assert(config.base_url == expected_base_url,
  "harness needs the generated config, got " .. tostring(config.base_url))

local registered = 0
LightHouse.ui = { menu = { registerToMainMenu = function() registered = registered + 1 end } }
LightHouse:init()
print("registered=" .. tostring(registered))

-- Record what a "Download EPUB" tap would fetch, without touching the disk.
local tapped
LightHouse.downloadBookId = function(_, session) tapped = session end

-- Tap the real menu entry, exactly as KOReader's menu callback does.
local menu_items = {}
LightHouse:addToMainMenu(menu_items)
local entry = assert(menu_items.lighthouse, "plugin must add a 'lighthouse' entry")
local tap
for _index, item in ipairs(entry.sub_item_table) do
  if item.text == "Currently reading" then tap = item.callback end
end
assert(type(tap) == "function", "'Currently reading' menu entry must have a callback")

local ok, raised = pcall(tap)
print("ok=" .. tostring(ok))
print("raised=" .. tostring(raised))

local menu = shown[#shown]
assert(menu and menu.__kind == "menu", "tapping 'Currently reading' must open a menu")
print("title=" .. tostring(menu.title))
print("items=" .. tostring(#menu.item_table))
-- The plugin reuses one Menu widget and switches its item table, so a later
-- view (the empty shelf) must be read from either place.
local function current_menu()
  local widget = shown[#shown]
  if widget and widget.item_table and widget.__kind == "menu" then return widget end
  local reused = LightHouse.menu and LightHouse.menu.switched
  if reused and reused[#reused] then
    return { title = reused[#reused].title, item_table = reused[#reused].items }
  end
  return widget
end
-- Rows carry the plugin's shared one-line anatomy, so each row is printed as
-- row text / metadata column / detail labels.
for item_index = 1, #menu.item_table do
  local item = menu.item_table[item_index]
  local labels = {}
  for detail_index = 1, #(item.sub_item_table or {}) do
    labels[#labels + 1] = tostring(item.sub_item_table[detail_index].text)
  end
  print(string.format("item%d=%s\t%s\t%s", item_index, tostring(item.text), tostring(item.mandatory), table.concat(labels, "|")))
end
local rows_with_newlines = 0
for item_index = 1, #menu.item_table do
  if tostring(menu.item_table[item_index].text):find("\n", 1, true) then
    rows_with_newlines = rows_with_newlines + 1
  end
end
print("rows_with_newlines=" .. tostring(rows_with_newlines))

-- Book-id downloads must still be wired to the tapped session.
menu.item_table[1].sub_item_table[1].callback()
print("tapped_book_id=" .. tostring(tapped and tapped.book_id))
print("tapped_title=" .. tostring(tapped and tapped.title))

-- An empty shelf must show a designed empty view rather than raise.
payload = {}
local empty_ok, empty_raised = pcall(tap)
print("empty_ok=" .. tostring(empty_ok))
print("empty_raised=" .. tostring(empty_raised))
local empty = current_menu()
print("empty_view=" .. tostring(empty and empty.title))
local headline = tostring(empty and empty.item_table and empty.item_table[1] and empty.item_table[1].text)
print("empty_headline=" .. (headline:gsub("\n", "\\n")))
local actions = {}
for action_index = 2, #(empty and empty.item_table or {}) do
  actions[#actions + 1] = tostring(empty.item_table[action_index].text)
end
print("empty_actions=" .. table.concat(actions, "|"))

-- A failed request must open the designed failure screen instead of claiming
-- there is nothing in progress.
failure = true
local fail_ok, fail_raised = pcall(tap)
print("fail_ok=" .. tostring(fail_ok))
print("fail_raised=" .. tostring(fail_raised))
local failed = current_menu()
print("fail_view=" .. tostring(failed and failed.title))
print("fail_headline=" .. tostring(failed and failed.item_table and failed.item_table[1] and failed.item_table[1].text))
local fail_actions = {}
for action_index = 2, #(failed and failed.item_table or {}) do
  fail_actions[#fail_actions + 1] = tostring(failed.item_table[action_index].text)
end
print("fail_actions=" .. table.concat(fail_actions, "|"))

-- A 200 whose body cannot be read must name no other resource: the shelf asks
-- /api/kosync/active, not the statistics endpoint.
failure = false
payload = "not a session list"
local bad_ok, bad_raised = pcall(tap)
print("bad_body_ok=" .. tostring(bad_ok) .. " " .. tostring(bad_raised))
local bad = current_menu()
print("bad_body_headline=" .. tostring(bad and bad.item_table and bad.item_table[1] and bad.item_table[1].text))
print("bad_body_detail=" .. tostring(bad and bad.item_table and bad.item_table[2] and bad.item_table[2].text))

-- A long device name must not cost the reader the progress bar, the finished
-- check or the "opened" marker in the shelf's metadata column.
payload = {
  {
    id = 45,
    document = "2222333344445555666677778888aaaa",
    progress = "",
    percentage = 1,
    device = "Kindle Paperwhite Signature Edition",
    device_id = nil,
    filename = "the-way-of-kings.epub",
    title = "The Way of Kings",
    authors = "Brandon Sanderson",
    timestamp = 1794633400,
    bookId = 303,
    cover = nil,
    displayTitle = "The Way of Kings",
    displayAuthors = "Brandon Sanderson",
  },
}
local long_ok = pcall(tap)
local long_menu = current_menu()
local long_row = long_menu and long_menu.item_table and long_menu.item_table[1]
print("shelf_long_ok=" .. tostring(long_ok))
print("shelf_long_mandatory=" .. tostring(long_row and long_row.mandatory))
print("shelf_long_limit=" .. tostring(require("lighthouse_ui").tokens.meta_max_chars))

print("OK")
`)
  // Non-ASCII inside a `String.raw` template is escaped to `\uXXXX` by the
  // transpiler and then rejected by Lua, so the Burmese probe goes in as
  // decimal byte escapes (same trick as LIGHTHOUSE_HELPERS_BODY above).
  .split("__BURMESE_PROBE__")
  .join(luaByteEscapes(BURMESE_PROBE));

describe("plugin currently-reading shelf", () => {
  it("renders /api/kosync/active instead of calling the gettext `_` as a number", () => {
    if (!LUA_BINARY || !UNZIP_BINARY) return;

    const { zip } = generateKoplugin({
      baseUrl: "http://192.168.31.15:8086",
      apiKey: "harness-api-key",
      generatedAt: "2026-11-14T00:00:00.000Z",
    });

    // Run the shipped artifact, unpacked the documented way, so the harness
    // exercises exactly what a device downloads.
    const workdir = fs.mkdtempSync(path.join(os.tmpdir(), "koplugin-reading-"));
    const zipPath = path.join(workdir, "lighthouse.koplugin");
    fs.writeFileSync(zipPath, zip);
    const pluginsDir = path.join(workdir, "plugins");
    fs.mkdirSync(pluginsDir, { recursive: true });
    const extract = spawnSync(
      UNZIP_BINARY as string,
      ["-q", zipPath, "-d", pluginsDir],
      { encoding: "utf8" },
    );
    expect(extract.status).toBe(0);

    const pluginRoot = path.join(pluginsDir, KOPLUGIN_DIR_NAME);
    const harnessPath = path.join(workdir, "reading_harness.lua");
    fs.writeFileSync(harnessPath, CURRENTLY_READING_HARNESS);

    const res = spawnSync(
      LUA_BINARY,
      [harnessPath, pluginRoot, "http://192.168.31.15:8086"],
      { encoding: "utf8" },
    );
    expect(res.stderr).toBe("");
    expect(res.status).toBe(0);

    const out = Object.fromEntries(
      res.stdout
        .split("\n")
        .filter((line) => line.includes("="))
        .map((line) => {
          const index = line.indexOf("=");
          return [line.slice(0, index), line.slice(index + 1)];
        }),
    );

    // The actual regression: no raised error from the tap.
    expect(out.ok).toBe("true");
    expect(out.raised).toBe("nil");
    expect(out.registered).toBe("1");

    expect(out.title).toBe("Currently reading");
    expect(out.items).toBe("4");

    // Row 1: linked session, newest first. The title is the row text and the
    // metadata column carries author, device and progress - no tap needed.
    expect(out.rows_with_newlines).toBe("0");
    const first = out.item1.split("\t");
    expect(first[0]).toBe("Spice and Wolf, Vol. 1");
    expect(first[1]).toContain("Isuna Hasekura · Paperwhite");
    expect(first[1]).toContain("45%");
    const firstDetails = first[2].split("|");
    expect(firstDetails[0]).toBe("Download EPUB");
    expect(firstDetails).toContain("Progress: ████░░░░ 45%");
    expect(firstDetails).toContain("Device: Paperwhite");
    expect(firstDetails).toContain("File: 01 - Spice and Wolf, Vol. 1.epub");

    // Row 2: no Calibre match, so the download row is replaced, not dropped.
    const second = out.item2.split("\t");
    expect(second[0]).toBe("Dune & Sons <Deluxe>");
    expect(second[1]).toContain("Frank Herbert · Kindle");
    expect(second[1]).toContain("20%");
    const secondDetails = second[2].split("|");
    expect(secondDetails[0]).toBe("No matching book in the library");
    expect(secondDetails).toContain("Progress: ██░░░░░░ 20%");
    expect(secondDetails).toContain("Device: Kindle");
    expect(secondDetails).toContain("File: Dune & Sons.epub");

    // Row 3: every fallback fires (no title, no authors, no device, no file).
    const third = out.item3.split("\t");
    expect(third[0]).toBe("Untitled");
    expect(third[1]).toContain("Unknown");
    expect(third[1]).toContain("0%");
    const thirdDetails = third[2].split("|");
    expect(thirdDetails).toEqual([
      "No matching book in the library",
      "Progress: ░░░░░░░░ 0%",
    ]);

    // Row 4: authored fallback only, Burmese title preserved byte for byte,
    // and a finished book is marked with a check glyph, not a colour.
    const fourth = out.item4.split("\t");
    expect(fourth[0]).toBe(BURMESE_PROBE);
    expect(fourth[1]).toContain("Unknown · Kobo");
    expect(fourth[1]).toContain("100%");
    expect(fourth[1]).toContain("✓");
    expect(fourth[2].split("|")[0]).toBe("Download EPUB");

    // Tapping "Download EPUB" still resolves the session's Calibre id.
    expect(out.tapped_book_id).toBe("101");
    expect(out.tapped_title).toBe("Spice and Wolf, Vol. 1");

    // Empty shelf: a designed empty view with a next step, never a bare notice
    // and never a raised error.
    expect(out.empty_ok).toBe("true");
    expect(out.empty_raised).toBe("nil");
    expect(out.empty_view).toBe("Currently reading");
    expect(out.empty_headline).toBe("Nothing in progress yet");
    expect(out.empty_actions).toContain("Refresh");
    expect(out.empty_actions).toContain("Browse library");

    // A failed request is not an empty shelf: it opens the failure screen with
    // the reason and a retry, instead of telling the reader nothing is in
    // progress.
    expect(out.fail_ok).toBe("true");
    expect(out.fail_raised).toBe("nil");
    expect(out.fail_view).toBe("Currently reading");
    expect(out.fail_headline).toBe("Can't reach the LightHouse server");
    expect(out.fail_actions).toContain("Try again");

    // An unreadable body on the shelf's own endpoint must not be described as
    // reading statistics, and the detail must not repeat the headline.
    expect(out.bad_body_ok).toBe("true nil");
    expect(out.bad_body_headline).toBe("The server response could not be read");
    expect(out.bad_body_detail).not.toContain("statistics");
    expect(out.bad_body_detail).toContain("Try again");

    // A long device name still renders the whole glance: the full bar, the
    // percent and the finished check.
    expect(out.shelf_long_ok).toBe("true");
    expect(out.shelf_long_mandatory).toContain("100%");
    expect(out.shelf_long_mandatory).toContain("✓");
    expect(
      Array.from(out.shelf_long_mandatory).length,
    ).toBeLessThanOrEqual(Number(out.shelf_long_limit));

    expect(res.stdout.trimEnd().endsWith("OK")).toBe(true);
  });
});

/**
 * `lighthouse_stats.lua` is pure formatting/parsing, so it is exercised on its
 * own with a bare Lua interpreter — no KOReader stubs, no sockets. Every value
 * the payload does not carry must come back as nil so the view can print
 * "unavailable" instead of a confident zero.
 */
const STATS_HELPER_HARNESS = String.raw`
local Stats = assert(loadfile(assert(arg[1], "stats module path required"))())

-- Durations -------------------------------------------------------------------
print("dur_zero=" .. tostring(Stats.formatDuration(0)))
print("dur_sub_minute=" .. tostring(Stats.formatDuration(30)))
print("dur_minutes=" .. tostring(Stats.formatDuration(2700)))
print("dur_week=" .. tostring(Stats.formatDuration(15000)))
print("dur_exact_hour=" .. tostring(Stats.formatDuration(7200)))
print("dur_total=" .. tostring(Stats.formatDuration(477000)))
print("dur_nil=" .. tostring(Stats.formatDuration(nil)))
print("dur_junk=" .. tostring(Stats.formatDuration("abc")))
print("dur_nan=" .. tostring(Stats.formatDuration(0/0)))
print("mins=" .. tostring(Stats.formatMinutes(45)))
print("hours_frac=" .. tostring(Stats.formatHours(132.5)))
print("hours_whole=" .. tostring(Stats.formatHours(100)))
print("days_one=" .. tostring(Stats.formatDays(1)))
print("days_many=" .. tostring(Stats.formatDays(5)))
print("count_float=" .. tostring(Stats.formatCount(12.0)))
print("count_zero=" .. tostring(Stats.formatCount(0)))
print("count_nil=" .. tostring(Stats.formatCount(nil)))

-- Dates and glyphs ------------------------------------------------------------
print("date_short=" .. tostring(Stats.shortDate("2026-11-15")))
print("date_passthrough=" .. tostring(Stats.shortDate("whenever")))
print("date_nil=" .. tostring(Stats.shortDate(nil)))
local glyphs = {}
for level = 0, 4 do glyphs[#glyphs + 1] = Stats.heatmapGlyph(level) end
print("glyphs=" .. table.concat(glyphs, ""))
print("glyph_unknown=" .. tostring(Stats.heatmapGlyph(nil)) .. tostring(Stats.heatmapGlyph(9)))

-- Level mapping: a validated read of the server's own level, never derived --
print("level_server=" .. tostring(Stats.heatmapLevel({ level = 4, minutes = 1 })))
print("level_string=" .. tostring(Stats.heatmapLevel({ level = "2", minutes = 60 })))
print("level_no_level=" .. tostring(Stats.heatmapLevel({ minutes = 60 })))
print("level_nontable=" .. tostring(Stats.heatmapLevel(nil)))

-- Normalization --------------------------------------------------------------
local payload = {
  streaks = {
    currentStreak = 5, longestStreak = 12, readingDaysCount = 63,
    lastReadingDate = "2026-11-15", isActiveToday = true,
  },
  dailyReadingTime = {
    todaySeconds = 2700, thisWeekSeconds = 15000,
    totalSeconds = 477000, totalHours = 132.5,
  },
  libraryHealth = { unreadCount = 120, inProgressCount = 0, finishedCount = 34 },
  goal = {
    year = 2026, targetBooks = 25, targetHours = 100,
    currentBooks = 12, currentHours = 34,
    booksPercent = 48, hoursPercent = 34, isConfigured = true,
  },
  heatmap = {
    { date = "2026-11-13", minutes = 0, level = 0 },
    { date = "2026-11-14", minutes = 20 },
    { date = "not-a-date" },
    { date = "2026-11-15", minutes = 45, level = "3", count = 2, bookCount = 1 },
  },
  finishedCount = 55,
}
local stats = assert(Stats.normalize(payload))
print("norm_streak_current=" .. tostring(stats.streaks.current))
print("norm_streak_best=" .. tostring(stats.streaks.best))
print("norm_today=" .. tostring(stats.time.todaySeconds))
print("norm_week=" .. tostring(stats.time.thisWeekSeconds))
print("norm_total_hours=" .. tostring(stats.time.totalHours))
print("norm_finished_year=" .. tostring(stats.finishedThisYear))
print("norm_unread=" .. tostring(stats.health.unread))
print("norm_reading_zero=" .. tostring(stats.health.reading))
print("norm_finished=" .. tostring(stats.health.finished))
print("norm_goal_ratio=" .. tostring(stats.goal.booksRatio))
print("norm_hours_ratio=" .. tostring(stats.goal.hoursRatio))
print("norm_heatmap_len=" .. tostring(#stats.heatmap))
print("norm_heatmap_level3=" .. tostring(stats.heatmap[3].level))
print("norm_heatmap_no_level=" .. tostring(stats.heatmap[2].level))

-- Missing sections stay nil, never zero.
local bare = assert(Stats.normalize({}))
print("bare_streaks=" .. tostring(bare.streaks))
print("bare_time=" .. tostring(bare.time))
print("bare_health=" .. tostring(bare.health))
print("bare_goal=" .. tostring(bare.goal))
print("bare_heatmap=" .. tostring(bare.heatmap))
print("bare_finished=" .. tostring(bare.finishedThisYear))
print("normalize_nontable=" .. tostring(Stats.normalize("nope")))
print("normalize_nil=" .. tostring(Stats.normalize(nil)))

-- A goal with no target is not a goal; a target is, even with no percentage.
print("goal_untargeted=" .. tostring(Stats.normalize({
  goal = { year = 2026, targetBooks = 0, targetHours = nil, currentBooks = 4 },
}).goal))
local targeted = assert(Stats.normalize({
  goal = { year = 2026, targetBooks = 20, currentBooks = 5 },
}).goal)
print("goal_unpercented_ratio=" .. tostring(targeted.booksRatio))
print("goal_books_label=" .. tostring(Stats.goalBooksLabel(targeted)))
print("ratio_clamped=" .. tostring(Stats.goalRatio(150)))
print("ratio_missing=" .. tostring(Stats.goalRatio(nil)))

-- Labels ---------------------------------------------------------------------
print("streak_label=" .. tostring(Stats.streakLabel(stats.streaks)))
print("streak_none=" .. tostring(Stats.streakLabel({ current = 0, best = 12 })))
print("streak_missing=" .. tostring(Stats.streakLabel(nil)))
print("goal_books=" .. tostring(Stats.goalBooksLabel(stats.goal)))
print("goal_hours=" .. tostring(Stats.goalHoursLabel(stats.goal)))

-- A single-target goal still shows both metrics: the untargeted one is the
-- plain count the server sent, never "unavailable".
local books_only = assert(Stats.normalize({
  goal = { year = 2026, targetBooks = 20, currentBooks = 5, currentHours = 12.5, booksPercent = 25 },
}).goal)
print("goal_books_only_books=" .. tostring(Stats.goalBooksLabel(books_only)))
print("goal_books_only_hours=" .. tostring(Stats.goalHoursLabel(books_only)))
print("goal_books_only_hours_ratio=" .. tostring(books_only.hoursRatio))
local hours_only = assert(Stats.normalize({
  goal = { year = 2026, targetHours = 100, currentBooks = 7, currentHours = 34, hoursPercent = 34 },
}).goal)
print("goal_hours_only_books=" .. tostring(Stats.goalBooksLabel(hours_only)))
print("goal_hours_only_hours=" .. tostring(Stats.goalHoursLabel(hours_only)))
print("goal_hours_only_books_ratio=" .. tostring(hours_only.booksRatio))
-- "unavailable" is reserved for a count the server did not send at all.
print("goal_missing_count_books=" .. tostring(Stats.goalBooksLabel({ targetHours = 10 })))
print("goal_missing_count_hours=" .. tostring(Stats.goalHoursLabel({ targetBooks = 10 })))
-- A target with no count is unavailable too, never a fabricated zero.
print("goal_missing_count_targeted_books=" .. tostring(Stats.goalBooksLabel({ targetBooks = 25 })))
print("goal_missing_count_targeted_hours=" .. tostring(Stats.goalHoursLabel({ targetHours = 100 })))
print("day_duration=" .. tostring(Stats.dayDurationLabel(stats.heatmap[3])))
print("day_duration_seconds=" .. tostring(Stats.dayDurationLabel({ seconds = 2700 })))
print("day_duration_missing=" .. tostring(Stats.dayDurationLabel({})))

-- Heatmap rows: seven days per row, newest row last, no horizontal scroll.
local week = {}
for day_index = 1, 10 do
  week[#week + 1] = { date = string.format("2026-01-%02d", day_index), level = 1, minutes = 20 }
end
local week_rows = Stats.heatmapRows(week)
print("rows_count=" .. tostring(#week_rows))
print("rows_first=" .. tostring(#week_rows[1]))
print("rows_last=" .. tostring(#week_rows[#week_rows]))
print("rows_newest=" .. tostring(week_rows[#week_rows][#week_rows[#week_rows]].date))
print("rows_empty=" .. tostring(#Stats.heatmapRows({})))
print("rows_nil=" .. tostring(#Stats.heatmapRows(nil)))

local year = {}
for day_index = 1, 365 do
  year[#year + 1] = { date = "2026-01-01", level = day_index % 5, minutes = day_index }
end
local year_rows = Stats.heatmapRows(year)
print("year_rows_count=" .. tostring(#year_rows))
print("year_rows_first_cells=" .. tostring(#year_rows[1]))
print("year_rows_text_bytes=" .. tostring(#Stats.heatmapRowText(year_rows[1])))
print("row_text=" .. tostring(Stats.heatmapRowText({
  { level = 0 }, { level = 1 }, { level = 2 }, { level = 3 }, { level = 4 },
})))
print("row_text_nil=" .. tostring(Stats.heatmapRowText(nil)))

print("OK")
`;

/** Runs the stats-helper harness against the committed template module. */
function runStatsHarness(): Record<string, string> {
  const workdir = fs.mkdtempSync(path.join(os.tmpdir(), "koplugin-stats-"));
  const harnessPath = path.join(workdir, "stats_harness.lua");
  fs.writeFileSync(harnessPath, STATS_HELPER_HARNESS);
  const res = spawnSync(
    LUA_BINARY as string,
    [harnessPath, path.join(KOPLUGIN_TEMPLATE_DIR, "lighthouse_stats.lua")],
    { encoding: "utf8" },
  );
  expect(res.stderr).toBe("");
  expect(res.status).toBe(0);
  expect(res.stdout.trimEnd().endsWith("OK")).toBe(true);
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

describe("plugin reading-stats formatting", () => {
  it("formats reading time compactly and honestly", () => {
    if (!LUA_BINARY) return;
    const out = runStatsHarness();
    expect(out.dur_zero).toBe("0m");
    // A real but tiny session must not read as zero.
    expect(out.dur_sub_minute).toBe("1m");
    expect(out.dur_minutes).toBe("45m");
    expect(out.dur_week).toBe("4h 10m");
    expect(out.dur_exact_hour).toBe("2h");
    expect(out.dur_total).toBe("132h 30m");
    expect(out.dur_nil).toBe("nil");
    expect(out.dur_junk).toBe("nil");
    expect(out.dur_nan).toBe("nil");
    expect(out.mins).toBe("45m");
    expect(out.hours_frac).toBe("132.5h");
    expect(out.hours_whole).toBe("100h");
    expect(out.days_one).toBe("1 day");
    expect(out.days_many).toBe("5 days");
    expect(out.count_float).toBe("12");
    expect(out.count_zero).toBe("0");
    expect(out.count_nil).toBe("nil");
  });

  it("renders monochrome heatmap levels instead of a colour ramp", () => {
    if (!LUA_BINARY) return;
    const out = runStatsHarness();
    // Five visually distinct, density-ordered glyphs: no colour, no rainbow.
    expect(out.glyphs).toBe("\u00b7\u2591\u2592\u2593\u2588");
    expect(out.glyph_unknown).toBe("??");
    expect(out.row_text).toBe("\u00b7\u2591\u2592\u2593\u2588");
    expect(out.row_text_nil).toBe("");
  });

  it("reads the server's heatmap level and never derives one", () => {
    if (!LUA_BINARY) return;
    const out = runStatsHarness();
    expect(out.level_server).toBe("4");
    expect(out.level_string).toBe("2");
    // A day the server did not shade is not shaded here either, however many
    // minutes it carries: the ramp belongs to the server.
    expect(out.level_no_level).toBe("nil");
    expect(out.level_nontable).toBe("nil");
  });

  it("normalizes the stats payload without inventing numbers", () => {
    if (!LUA_BINARY) return;
    const out = runStatsHarness();
    expect(out.norm_streak_current).toBe("5");
    expect(out.norm_streak_best).toBe("12");
    expect(out.norm_today).toBe("2700");
    expect(out.norm_week).toBe("15000");
    expect(out.norm_total_hours).toBe("132.5");
    expect(out.norm_finished_year).toBe("12");
    expect(out.norm_unread).toBe("120");
    // Zero is a real value when the server sends it.
    expect(out.norm_reading_zero).toBe("0");
    expect(out.norm_finished).toBe("34");
    expect(out.norm_goal_ratio).toBe("0.48");
    expect(out.norm_hours_ratio).toBe("0.34");
    // The malformed date is dropped; a day the server did not shade stays unshaded.
    expect(out.norm_heatmap_len).toBe("3");
    expect(out.norm_heatmap_level3).toBe("3");
    expect(out.norm_heatmap_no_level).toBe("nil");

    // Sections the server did not send stay unavailable.
    expect(out.bare_streaks).toBe("nil");
    expect(out.bare_time).toBe("nil");
    expect(out.bare_health).toBe("nil");
    expect(out.bare_goal).toBe("nil");
    expect(out.bare_heatmap).toBe("nil");
    expect(out.bare_finished).toBe("nil");
    expect(out.normalize_nontable).toBe("nil");
    expect(out.normalize_nil).toBe("nil");

    expect(out.goal_untargeted).toBe("nil");
    expect(out.goal_unpercented_ratio).toBe("nil");
    expect(out.goal_books_label).toBe("5/20");
    expect(out.ratio_clamped).toBe("1");
    expect(out.ratio_missing).toBe("nil");
  });

  it("builds streak and goal labels the view can print directly", () => {
    if (!LUA_BINARY) return;
    const out = runStatsHarness();
    expect(out.streak_label).toBe("5 days \u00b7 best 12 days");
    expect(out.streak_none).toBe("No streak yet \u00b7 best 12 days");
    expect(out.streak_missing).toBe("nil");
    expect(out.goal_books).toBe("12/25");
    expect(out.goal_hours).toBe("34h/100h");
    // `computeYearlyGoalProgress` always sends currentBooks and currentHours,
    // so a single-target goal must print the other metric as a plain count.
    expect(out.goal_books_only_books).toBe("5/20");
    expect(out.goal_books_only_hours).toBe("12.5h read");
    expect(out.goal_books_only_hours_ratio).toBe("nil");
    expect(out.goal_hours_only_books).toBe("7 read");
    expect(out.goal_hours_only_hours).toBe("34h/100h");
    expect(out.goal_hours_only_books_ratio).toBe("nil");
    // Absent count: no number to show, so the view says unavailable.
    expect(out.goal_missing_count_books).toBe("nil");
    expect(out.goal_missing_count_hours).toBe("nil");
    expect(out.goal_missing_count_targeted_books).toBe("nil");
    expect(out.goal_missing_count_targeted_hours).toBe("nil");
    expect(out.day_duration).toBe("45m");
    expect(out.day_duration_seconds).toBe("45m");
    expect(out.day_duration_missing).toBe("nil");
    expect(out.date_short).toBe("Nov 15");
    expect(out.date_passthrough).toBe("whenever");
    expect(out.date_nil).toBe("nil");
  });

  it("packs the heatmap into bounded rows that end on the newest day", () => {
    if (!LUA_BINARY) return;
    const out = runStatsHarness();
    expect(out.rows_count).toBe("2");
    expect(out.rows_first).toBe("3");
    expect(out.rows_last).toBe("7");
    expect(out.rows_newest).toBe("2026-01-10");
    expect(out.rows_empty).toBe("0");
    expect(out.rows_nil).toBe("0");
    // A year of days packs into rows of seven and never exercises a scroll.
    expect(out.year_rows_first_cells).toBe("7");
    // Byte length: block glyphs are 3 bytes each in UTF-8.
    expect(Number(out.year_rows_text_bytes)).toBeLessThanOrEqual(21);
    // The window is a fixed 26 weeks, whatever the payload length.
    expect(out.year_rows_count).toBe("26");
  });
});

/**
 * Full-view harness: taps the real "Reading stats" menu entry on the shipped
 * artifact with KOReader's widgets stubbed, and prints every row so the test
 * can assert order, values and degradation.
 *
 * The device crash this guards against is the same trap the currently-reading
 * shelf hit: `_` is gettext in main.lua, so a `for _, x in ipairs(...)` in the
 * view would shadow it and abort the whole KOReader process on tap.
 */
const READING_STATS_HARNESS = (KOREADER_STUB_PRELUDE + String.raw`
local expected_base_url = assert(arg[2], "expected base url argument required")

-- Field-for-field shape of GET /api/kosync/stats.
local stats_payload = {
  totalSessions = 412,
  readingDaysCount = 63,
  finishedCount = 55,
  finishedBooks = {},
  activeBooks = {},
  streaks = {
    currentStreak = 5, longestStreak = 12, readingDaysCount = 63,
    lastReadingDate = "2026-11-15", isActiveToday = true,
  },
  dailyReadingTime = {
    todaySeconds = 2700, todayMinutes = 45,
    thisWeekSeconds = 15000, thisWeekMinutes = 250,
    thisMonthSeconds = 30000, thisMonthMinutes = 500,
    totalSeconds = 477000, totalHours = 132.5, dailyAverageMinutes = 32,
    days = {},
  },
  heatmap = {
    { date = "2026-11-13", count = 0, seconds = 0, minutes = 0, level = 0, bookCount = 0 },
    { date = "2026-11-14", count = 1, seconds = 1200, minutes = 20, level = 2, bookCount = 1 },
    { date = "2026-11-15", count = 2, seconds = 2700, minutes = 45, level = 3, bookCount = 1 },
  },
  libraryHealth = {
    totalBooks = 162, unreadCount = 120, inProgressCount = 8,
    finishedCount = 34, staleCount = 3,
  },
  goal = {
    year = 2026, targetBooks = 25, targetHours = 100,
    currentBooks = 12, currentHours = 34,
    booksPercent = 48, hoursPercent = 34, isConfigured = true,
  },
  recentSessions = {},
  summary = {
    totalSessionsCount = 412, totalReadingSeconds = 477000,
    totalReadingHours = 132.5, todayReadingSeconds = 2700,
    thisWeekReadingSeconds = 15000, averageDailyMinutes = 32,
    currentStreak = 5, longestStreak = 12,
  },
}

-- The transport returns a JSON body; the decode stub hands back the payload
-- above, so the real Stats.normalize path runs. The stats_payload upvalue
-- lets the degraded and broken cases reuse the same plugin instance. It raises
-- on an empty body like KOReader's own json.decode, so the zero-length-200 case
-- exercises the real guard instead of silently decoding nothing.
package.preload["json"] = function()
  return {
    decode = function(body)
      if type(body) ~= "string" or body == "" then
        error("json.decode: unexpected end of input", 0)
      end
      return stats_payload
    end,
  }
end
package.preload["ltn12"] = function()
  return {
    sink = {
      table = function(target)
        return function(chunk)
          if chunk then target[#target + 1] = chunk end
          return 1
        end
      end,
      file = function() end,
    },
  }
end
package.preload["socket.http"] = function()
  return {
    request = function(request)
      if request and request.sink then
        request.sink('{"streaks":{}}')
        request.sink(nil)
      end
      return 1, 200, {}
    end,
  }
end

local LightHouse = assert(loadfile(plugin_root .. "/main.lua"))()
local config = require("lighthouse_config")
assert(config.base_url == expected_base_url,
  "harness needs the generated config, got " .. tostring(config.base_url))

LightHouse.ui = { menu = { registerToMainMenu = function() end } }
LightHouse:init()

local menu_items = {}
LightHouse:addToMainMenu(menu_items)
local entry = assert(menu_items.lighthouse, "plugin must add a 'lighthouse' entry")
local tap
for entry_index = 1, #entry.sub_item_table do
  local item = entry.sub_item_table[entry_index]
  if item.text == "Reading stats" then tap = item.callback end
end
assert(type(tap) == "function", "'Reading stats' menu entry must have a callback")

local function dump_rows(menu, prefix)
  for row_index = 1, #menu.item_table do
    local item = menu.item_table[row_index]
    print(string.format("%s%d=%s\t%s", prefix, row_index, tostring(item.text), tostring(item.mandatory)))
  end
end

-- The plugin reuses one Menu widget across opens and calls switchItemTable
-- instead of showing a new one, so the visible rows come from either place.
local function current_menu()
  local widget = shown[#shown]
  if widget and widget.item_table then return widget end
  local reused = LightHouse.menu and LightHouse.menu.switched
  if reused and reused[#reused] then
    return { title = reused[#reused].title, item_table = reused[#reused].items }
  end
  return widget
end

-- 1. Full payload -------------------------------------------------------------
local ok, raised = pcall(tap)
print("ok=" .. tostring(ok))
print("raised=" .. tostring(raised))

local menu = current_menu()
assert(menu and menu.item_table, "tapping 'Reading stats' must open a menu")
print("title=" .. tostring(menu.title))
print("rows=" .. tostring(#menu.item_table))
-- The view must fill the screen it is drawn on: a text page follows the height
-- left after the title bar, so a 15-row stats list is one page, not two.
local per_page = tonumber(LightHouse.menu and LightHouse.menu.items_per_page) or #menu.item_table
print("per_page=" .. tostring(per_page))
print("pages=" .. tostring(math.ceil(#menu.item_table / per_page)))
dump_rows(menu, "row")

-- 2. Heatmap weeks are tappable down to a single day --------------------------
local week, week_index
for row_index = 1, #menu.item_table do
  if menu.item_table[row_index].sub_item_table then
    week = menu.item_table[row_index]
    week_index = row_index
    break
  end
end
assert(week, "the heatmap must expose tappable week rows")
print("week_text=" .. tostring(week.text))
print("week_mandatory=" .. tostring(week.mandatory))
print("week_days=" .. tostring(#week.sub_item_table))
print("week_day1=" .. tostring(week.sub_item_table[1].text))
print("week_day3=" .. tostring(week.sub_item_table[3].text))
week.sub_item_table[3].callback()
local day_view = shown[#shown]
print("day_view=" .. tostring(day_view and day_view.__kind))
print("day_text=" .. tostring(day_view and day_view.text:gsub("\n", " / ")))

-- 3. Degraded payload: absent sections read "unavailable", never zero --------
stats_payload = {}
local deg_ok, deg_raised = pcall(tap)
print("deg_ok=" .. tostring(deg_ok))
print("deg_raised=" .. tostring(deg_raised))
local deg = current_menu()
print("deg_rows=" .. tostring(deg and deg.item_table and #deg.item_table))
if deg then dump_rows(deg, "deg_row") end

-- 3b. Single-target goal: the untargeted row is the count, not "unavailable"
stats_payload = {
  goal = {
    year = 2026, targetBooks = 25, currentBooks = 12,
    currentHours = 34, booksPercent = 48,
  },
}
local one_ok, one_raised = pcall(tap)
print("one_ok=" .. tostring(one_ok))
print("one_raised=" .. tostring(one_raised))
local one = current_menu()
print("one_rows=" .. tostring(one and one.item_table and #one.item_table))
if one then dump_rows(one, "one_row") end

-- 3c. Single-target goal the other way: an hours target, books untargeted ----
stats_payload = {
  goal = {
    year = 2026, targetHours = 100, currentBooks = 12,
    currentHours = 34, hoursPercent = 34,
  },
}
local hours_ok, hours_raised = pcall(tap)
print("hours_only_ok=" .. tostring(hours_ok))
print("hours_only_raised=" .. tostring(hours_raised))
local hours_menu = current_menu()
print("hours_only_rows=" .. tostring(hours_menu and hours_menu.item_table and #hours_menu.item_table))
if hours_menu then dump_rows(hours_menu, "hours_only_row") end

-- 4. Unreadable body ---------------------------------------------------------
stats_payload = "not a stats payload"
local bad_ok, bad_raised = pcall(tap)
print("bad_ok=" .. tostring(bad_ok))
print("bad_raised=" .. tostring(bad_raised))
local bad = shown[#shown]
-- A failure is a designed screen: what failed, then what to do, then actions.
local function dump_problem(prefix)
  local view = current_menu()
  print(prefix .. "_view=" .. tostring(view and view.title))
  local items = (view and view.item_table) or {}
  print(prefix .. "_headline=" .. tostring(items[1] and items[1].text))
  print(prefix .. "_detail=" .. tostring(items[2] and items[2].text))
  local actions = {}
  for action_index = 3, #items do
    actions[#actions + 1] = tostring(items[action_index].text)
  end
  print(prefix .. "_actions=" .. table.concat(actions, "|"))
end
dump_problem("bad")

-- 4b. A 200 with a zero-length body: the same screen, not a raise -----------
local http = require("socket.http")
local working_request = http.request
http.request = function() return 1, 200, {} end
local empty_ok, empty_raised = pcall(tap)
print("empty_ok=" .. tostring(empty_ok))
print("empty_raised=" .. tostring(empty_raised))
dump_problem("empty")
http.request = working_request

-- 5. Transport failure maps through the plugin's existing error style --------
stats_payload = {
  streaks = { currentStreak = 5, longestStreak = 12 },
}
http.request = function() return nil, "timeout" end
local fail_ok, fail_raised = pcall(tap)
print("fail_ok=" .. tostring(fail_ok))
print("fail_raised=" .. tostring(fail_raised))
dump_problem("fail")
http.request = working_request

print("OK")
`);

describe("plugin reading stats view", () => {
  /** Extracts the generated archive the documented way and runs a harness on it. */
  function runHarness(harness: string): Record<string, string> {
    const { zip } = generateKoplugin({
      baseUrl: "http://192.168.31.15:8086",
      apiKey: "harness-api-key",
      generatedAt: "2026-11-14T00:00:00.000Z",
    });

    const workdir = fs.mkdtempSync(path.join(os.tmpdir(), "koplugin-stats-view-"));
    const zipPath = path.join(workdir, "lighthouse.koplugin");
    fs.writeFileSync(zipPath, zip);
    const pluginsDir = path.join(workdir, "plugins");
    fs.mkdirSync(pluginsDir, { recursive: true });
    const extract = spawnSync(
      UNZIP_BINARY as string,
      ["-q", zipPath, "-d", pluginsDir],
      { encoding: "utf8" },
    );
    expect(extract.status).toBe(0);

    const pluginRoot = path.join(pluginsDir, KOPLUGIN_DIR_NAME);
    const harnessPath = path.join(workdir, "stats_view_harness.lua");
    fs.writeFileSync(harnessPath, harness);

    const res = spawnSync(
      LUA_BINARY,
      [harnessPath, pluginRoot, "http://192.168.31.15:8086"],
      { encoding: "utf8" },
    );
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

  it("leads with the headline numbers, then activity, then supporting detail", () => {
    if (!LUA_BINARY || !UNZIP_BINARY) return;
    const out = runHarness(READING_STATS_HARNESS);

    // The tap must render, not raise: a shadowed gettext `_` would crash here.
    expect(out.ok).toBe("true");
    expect(out.raised).toBe("nil");
    expect(out.title).toBe("Reading stats");
    expect(Number(out.rows)).toBeGreaterThan(9);
    // A text page is fitted to the screen, so the whole stats view fits on one
    // page instead of paging twice through a half-empty screen.
    expect(Number(out.per_page)).toBeGreaterThan(9);
    expect(Number(out.per_page)).toBeGreaterThanOrEqual(Number(out.rows));
    expect(out.pages).toBe("1");
    expect(out.rows).toBe("15");

    // 1. Headline numbers, first thing the reader sees, with no heading row
    //    above them: the answer before the supporting detail.
    expect(out.row1).toBe("Current streak\t5 days · best 12 days");
    expect(out.row2).toBe("Read today\t45m");
    expect(out.row3).toBe("Read this week\t4h 10m");
    expect(out.row4).toBe("Total reading time\t132.5h");
    expect(out.row5).toBe("Books finished this year\t12");

    // 2. The yearly goal keeps both targets, with the bars drawn by the
    //    plugin's single bar renderer.
    expect(out.row6).toBe("▍ Yearly goal 2026\tnil");
    expect(out.row7).toBe("Books\t███░░░ 48% · 12/25");
    expect(out.row8).toBe("Hours\t██░░░░ 34% · 34h/100h");

    // 3. The activity picture, then its key, before the supporting detail.
    expect(out.row9).toBe("▍ Activity (newest week last)\tnil");
    expect(out.row10).toBe("·▒▓\tNov 15");
    // The key is computed from the level thresholds, so pin the whole string:
    // the ramp it must mirror is the server's (>=1m, >=15m, >=30m, >=60m).
    expect(out.row11).toBe(
      "▍ Shade key: · none · ░ under 15m · ▒ under 30m · ▓ under 1h · █ 1h or more\tnil",
    );

    // 4. Supporting detail last: library health as three counts.
    expect(out.row12).toBe("▍ Library health\tnil");
    expect(out.row13).toBe("Unread\t120");
    expect(out.row14).toBe("Reading\t8");
    expect(out.row15).toBe("Finished\t34");

    expect(out.week_days).toBe("3");
    expect(out.week_day1).toBe("Nov 13 · 0m");
    expect(out.week_day3).toBe("Nov 15 · 45m");

    // Tapping a day shows that day's reading time.
    expect(out.day_view).toBe("textviewer");
    expect(out.day_text).toBe("2026-11-15 / Reading time: 45m / Sessions: 2 / Books: 1");
  });

  it("degrades to 'unavailable' instead of zero when fields are missing", () => {
    if (!LUA_BINARY || !UNZIP_BINARY) return;
    const out = runHarness(READING_STATS_HARNESS);

    expect(out.deg_ok).toBe("true");
    expect(out.deg_raised).toBe("nil");
    // The goal section disappears entirely; nothing else does.
    expect(out.deg_rows).toBe("12");
    expect(out.deg_row1).toBe("Current streak\tunavailable");
    expect(out.deg_row2).toBe("Read today\tunavailable");
    expect(out.deg_row3).toBe("Read this week\tunavailable");
    expect(out.deg_row4).toBe("Total reading time\tunavailable");
    expect(out.deg_row5).toBe("Books finished this year\tunavailable");
    expect(out.deg_row6).toBe("▍ Activity (newest week last)\tnil");
    expect(out.deg_row7).toBe("Heatmap\tunavailable");
    // A missing heatmap still renders the same key row rather than an empty
    // picture, and the key does not depend on the payload.
    expect(out.deg_row8).toBe(
      "▍ Shade key: · none · ░ under 15m · ▒ under 30m · ▓ under 1h · █ 1h or more\tnil",
    );
    expect(out.deg_row9).toBe("▍ Library health\tnil");
    expect(out.deg_row10).toBe("Unread\tunavailable");
  });

  it("shows the untargeted metric of a single-target goal as its count", () => {
    if (!LUA_BINARY || !UNZIP_BINARY) return;
    const out = runHarness(READING_STATS_HARNESS);

    expect(out.one_ok).toBe("true");
    expect(out.one_raised).toBe("nil");
    expect(out.one_rows).toBe("15");
    // The configured target keeps its bar; the other metric keeps its number.
    expect(out.one_row7).toBe("Books\t███░░░ 48% · 12/25");
    expect(out.one_row8).toBe("Hours\t34h read");
  });

  it("labels the untargeted books metric without repeating the row label", () => {
    if (!LUA_BINARY || !UNZIP_BINARY) return;
    const out = runHarness(READING_STATS_HARNESS);

    expect(out.hours_only_ok).toBe("true");
    expect(out.hours_only_raised).toBe("nil");
    expect(out.hours_only_rows).toBe("15");
    // The row label is already "Books", so the value must not say it again.
    expect(out.hours_only_row7).toBe("Books\t12 read");
    expect(out.hours_only_row8).toBe("Hours\t██░░░░ 34% · 34h/100h");
  });

  it("reports an unreadable payload and a network failure on a designed failure screen", () => {
    if (!LUA_BINARY || !UNZIP_BINARY) return;
    const out = runHarness(READING_STATS_HARNESS);

    // A failed request opens a real screen: a one-line headline saying what
    // failed, the actionable detail, and a retry - not a vanishing notice.
    expect(out.bad_ok).toBe("true");
    expect(out.bad_raised).toBe("nil");
    expect(out.bad_view).toBe("Reading stats");
    expect(out.bad_headline).toBe("The server response could not be read");
    // The detail says what to do without naming a resource: the same copy is
    // shown for the catalog, the shelf and the download notice.
    expect(out.bad_detail).toBe(
      "Try again. If it keeps happening, download the plugin again from the LightHouse web app (Guide → KOReader plugin).",
    );
    expect(out.bad_detail).not.toContain("statistics");
    expect(out.bad_actions).toContain("Try again");

    // A proxy answering before the app sends 200 with no body: same screen.
    expect(out.empty_ok).toBe("true");
    expect(out.empty_raised).toBe("nil");
    expect(out.empty_headline).toBe("The server response could not be read");

    expect(out.fail_ok).toBe("true");
    expect(out.fail_raised).toBe("nil");
    expect(out.fail_headline).toBe("Can't reach the LightHouse server");
    expect(out.fail_detail).toBe(
      "Could not reach the LightHouse server. Check Wi-Fi and the server address in the Connection screen.",
    );
    expect(out.fail_actions).toContain("Try again");
  });
});

/**
 * Cover prefetch behaviour.
 *
 * Covers are the one part of the catalog that costs network and disk, so the
 * rules that keep a slow link usable are worth proving rather than trusting:
 * the per-page fetch cap, the on-disk cache that makes a second open free, the
 * negative cache that remembers a book the server has no cover for (and only
 * that), and the per-fetch timeout ceiling the page budget imposes.
 */
const COVER_PREFETCH_HARNESS = KOREADER_STUB_PRELUDE + String.raw`
local data_dir = assert(arg[2], "data dir argument required")
local requests = {}
local timeouts = {}
-- Set by section 7: the final cache path a download is watched at, and whether
-- that path was already visible to a reader while the bytes were streaming in.
local watched_path
local visible_mid_write = false

package.preload["datastorage"] = function()
  return {
    getDataDir = function() return data_dir end,
    getSettingsDir = function() return data_dir end,
  }
end
-- A real existence check plus a real (current) mtime, so the on-disk cache and
-- the negative cache are exercised rather than the stub's "no such file".
package.preload["libs/libkoreader-lfs"] = function()
  return {
    attributes = function(path, field)
      local handle = io.open(path, "rb")
      if not handle then return nil end
      if field == "size" then
        local size = handle:seek("end")
        handle:close()
        return size
      end
      handle:close()
      if field == "mode" then return "file" end
      if field == "modification" then return os.time() end
      return nil
    end,
    mkdir = function() return true end,
  }
end
package.preload["socketutil"] = function()
  return {
    set_timeout = function(_, block, total)
      timeouts[#timeouts + 1] = { block = tonumber(block), total = tonumber(total) }
    end,
    reset_timeout = function() end,
  }
end

package.preload["socket.http"] = function()
  return {
    request = function(request)
      local url = tostring(request and request.url or "")
      requests[#requests + 1] = url
      -- Book 999 has no cover on the server: a definitive answer.
      if url:find("999", 1, true) then
        return 1, 404, {}
      end
      -- Book 998 loses the link mid-request.
      if url:find("998", 1, true) then
        return nil, "timeout"
      end
      -- Book 997 fails for a reason that says nothing about its cover.
      if url:find("997", 1, true) then
        return 1, 500, {}
      end
      if request and request.sink then
        -- A whole JPEG, as the server sends it (SOI ... EOI).
        request.sink("\255\216")
        if watched_path then
          local probe = io.open(watched_path, "rb")
          visible_mid_write = probe ~= nil
          if probe then probe:close() end
        end
        request.sink(string.rep("coverbytes", 40))
        request.sink("\255\217")
        request.sink(nil)
      end
      return 1, 200, {}
    end,
  }
end

local LightHouse = assert(loadfile(plugin_root .. "/main.lua"))()
local Ui = require("lighthouse_ui")
LightHouse.ui = { menu = { registerToMainMenu = function() end } }
LightHouse:init()
local function entry(book_id, href)
  return { book_id = book_id, thumbnail_href = href }
end

local base = "http://192.168.31.15:8086/api/books/%d/cover?w=360"
local function href(book_id) return string.format(base, book_id) end

local function count_files(ids, suffix)
  local count = 0
  local directory = data_dir .. "/cache/lighthouse-covers"
  -- No directory listing outside KOReader's lfs, so probe the names we expect.
  for id_index = 1, #ids do
    local name = Ui.coverCacheName(ids[id_index]) .. (suffix or "")
    local handle = io.open(directory .. "/" .. name, "rb")
    if handle then handle:close() count = count + 1 end
  end
  return count
end

-- 1. A page of two books is fetched once and then served from disk --------
local page = { entry(101, href(101)), entry(102, href(102)) }
LightHouse:prefetchCovers(page)
print("first_requests=" .. tostring(#requests))
print("cached_covers=" .. tostring(count_files({ 101, 102 })))

requests = {}
LightHouse:prefetchCovers(page)
print("second_requests=" .. tostring(#requests))

-- 2. Only a definitive 404 is remembered; every other failure is retried -----
requests = {}
local mixed = {
  entry(999, href(999)), -- no cover on the server (HTTP 404)
  entry(998, href(998)), -- link dropped mid-request
  entry(997, href(997)), -- server error, nothing to do with the cover
}
LightHouse:prefetchCovers(mixed)
print("mixed_requests=" .. tostring(#requests))
print("miss_markers=" .. tostring(count_files({ 999 }, ".miss")))
print("transient_markers=" .. tostring(count_files({ 997, 998 }, ".miss")))

-- The transient failures stay retryable on the next open; the coverless book
-- and the definitive answer do not cost another request.
requests = {}
LightHouse:prefetchCovers(mixed)
print("mixed_retry_requests=" .. tostring(#requests))

-- 3. The per-page cap holds when a page is larger than the budget ------------
requests = {}
local big_page = {}
for book_id = 201, 230 do big_page[#big_page + 1] = entry(book_id, href(book_id)) end
LightHouse:prefetchCovers(big_page)
print("capped_requests=" .. tostring(#requests))
print("cap=" .. tostring(Ui.tokens.cover_fetch_max))

-- 4. An entry with no cover link and no id never costs a request ------------
requests = {}
LightHouse:prefetchCovers({ { book_id = 301 }, { thumbnail_href = href(302) }, {} })
print("noop_requests=" .. tostring(#requests))

-- 5. No cover request may outlive the per-page budget ----------------------
local max_block, max_total = 0, 0
for timeout_index = 1, #timeouts do
  if timeouts[timeout_index].block > max_block then max_block = timeouts[timeout_index].block end
  if timeouts[timeout_index].total > max_total then max_total = timeouts[timeout_index].total end
end
print("max_cover_block=" .. tostring(max_block))
print("max_cover_total=" .. tostring(max_total))
print("budget_seconds=" .. tostring(Ui.tokens.cover_fetch_seconds))

-- 6. A half-written cover left behind is never handed to the image widget ----
-- A process that dies mid-download leaves a file with a valid JPEG header and
-- a fresh mtime, so only a whole-file check keeps it out of the paint pass.
local layout = Ui.layout(800, 1, true)
local function cover_file(book_id, bytes)
  local path = data_dir .. "/cache/lighthouse-covers/" .. Ui.coverCacheName(book_id)
  local handle = assert(io.open(path, "wb"))
  handle:write(bytes)
  handle:close()
  return path
end
local leftover = entry(401, href(401))
cover_file(401, "\255\216" .. string.rep("coverbytes", 40))
local leftover_slot = LightHouse:coverSlot(leftover, layout)
print("truncated_slot=" .. tostring(leftover_slot and leftover_slot.__kind))
requests = {}
LightHouse:prefetchCovers({ leftover })
print("truncated_refetched=" .. tostring(#requests))
local repaired_slot = LightHouse:coverSlot(leftover, layout)
print("repaired_slot=" .. tostring(repaired_slot and repaired_slot.__kind))
requests = {}
LightHouse:prefetchCovers({ leftover })
print("repaired_requests=" .. tostring(#requests))

-- 7. A cover only takes its final name once its bytes are complete ----------
watched_path = data_dir .. "/cache/lighthouse-covers/" .. Ui.coverCacheName(402)
LightHouse:prefetchCovers({ entry(402, href(402)) })
print("visible_mid_write=" .. tostring(visible_mid_write))
local final_handle = io.open(watched_path, "rb")
print("final_exists=" .. tostring(final_handle ~= nil))
if final_handle then
  local content = final_handle:read("*a") or ""
  final_handle:close()
  print("final_whole=" .. tostring(content:sub(1, 2) == "\255\216" and content:sub(-2) == "\255\217"))
end

print("OK")
`;

describe("plugin cover prefetch", () => {
  it("caps fetches per page, caches on disk, and remembers a missing cover", () => {
    if (!LUA_BINARY || !UNZIP_BINARY) return;

    const { zip } = generateKoplugin({
      baseUrl: "http://192.168.31.15:8086",
      apiKey: "harness-api-key",
      generatedAt: "2026-11-14T00:00:00.000Z",
    });

    const workdir = fs.mkdtempSync(path.join(os.tmpdir(), "koplugin-covers-"));
    const dataDir = path.join(workdir, "data");
    fs.mkdirSync(path.join(dataDir, "cache", "lighthouse-covers"), { recursive: true });

    const zipPath = path.join(workdir, "lighthouse.koplugin");
    fs.writeFileSync(zipPath, zip);
    const pluginsDir = path.join(workdir, "plugins");
    fs.mkdirSync(pluginsDir, { recursive: true });
    const extract = spawnSync(UNZIP_BINARY as string, ["-q", zipPath, "-d", pluginsDir], {
      encoding: "utf8",
    });
    expect(extract.status).toBe(0);

    const pluginRoot = path.join(pluginsDir, KOPLUGIN_DIR_NAME);
    const harnessPath = path.join(workdir, "cover_harness.lua");
    fs.writeFileSync(harnessPath, COVER_PREFETCH_HARNESS);

    const res = spawnSync(LUA_BINARY, [harnessPath, pluginRoot, dataDir], { encoding: "utf8" });
    expect(res.stderr).toBe("");
    expect(res.status).toBe(0);

    const out = Object.fromEntries(
      res.stdout
        .split("\n")
        .filter((line) => line.includes("="))
        .map((line) => {
          const index = line.indexOf("=");
          return [line.slice(0, index), line.slice(index + 1)];
        }),
    );

    // One request per book, and the coverless book is remembered rather than
    // retried forever.
    expect(out.first_requests).toBe("2");
    expect(out.cached_covers).toBe("2");

    // Re-opening the page costs no network at all: this is what keeps scrolling
    // smooth on a 40-book page.
    expect(out.second_requests).toBe("0");

    // A definitive 404 is the only failure that earns a negative-cache marker;
    // a dropped link or a server error stays retryable, because a marker would
    // make that book look coverless for the whole cover TTL.
    expect(out.mixed_requests).toBe("3");
    expect(out.miss_markers).toBe("1");
    expect(out.transient_markers).toBe("0");
    expect(out.mixed_retry_requests).toBe("2");

    // A page bigger than the per-page budget stops at the budget.
    expect(out.capped_requests).toBe(out.cap);

    // Rows with no cover link or no book id never reach the network.
    expect(out.noop_requests).toBe("0");

    // One stalled cover cannot outlive the page's cover budget: every request
    // is issued under the cover budget, not the 300s EPUB download budget.
    expect(Number(out.max_cover_block)).toBeLessThanOrEqual(Number(out.budget_seconds));
    expect(Number(out.max_cover_total)).toBeLessThanOrEqual(Number(out.budget_seconds));

    // A cover file left half-written by a dead process is not a cache hit: it
    // must not reach the image widget (which decodes at paint time, outside any
    // pcall), and it must be refetched rather than trusted because its mtime is
    // fresh.
    expect(out.truncated_slot).toBe("framecontainer");
    expect(out.truncated_refetched).toBe("1");
    expect(out.repaired_slot).toBe("imagewidget");
    expect(out.repaired_requests).toBe("0");

    // A cover takes its final cache name only once every byte arrived, so a
    // process death mid-download cannot leave a truncated file behind a valid
    // cover name.
    expect(out.visible_mid_write).toBe("false");
    expect(out.final_exists).toBe("true");
    expect(out.final_whole).toBe("true");

    expect(res.stdout.trimEnd().endsWith("OK")).toBe(true);
  });
});

/**
 * Unconfigured plugin behaviour.
 *
 * The committed template carries no server URL, which is exactly the state a
 * reader lands in after copying the folder by hand or losing the baked key.
 * Every view has to say what is wrong and offer the one screen that can fix it,
 * so the first-run dead end is not a screen with no way forward.
 */
const NOT_CONFIGURED_HARNESS = KOREADER_STUB_PRELUDE + String.raw`
local LightHouse = assert(loadfile(plugin_root .. "/main.lua"))()
local config = require("lighthouse_config")
assert(config.base_url == "", "this harness needs the unconfigured template")

LightHouse.ui = { menu = { registerToMainMenu = function() end } }
LightHouse:init()

-- The plugin reuses one Menu widget and switches it, so the visible rows come
-- from either the shown widget or the table it was switched to.
local function current_items()
  local switched = LightHouse.menu and LightHouse.menu.switched
  if switched and switched[#switched] then return switched[#switched].items end
  local widget = shown[#shown]
  if widget and widget.item_table then return widget.item_table end
  return {}
end

local function dump_screen(prefix, open)
  local ok, raised = pcall(open)
  print(prefix .. "_ok=" .. tostring(ok) .. " " .. tostring(raised))
  local items = current_items()
  local texts = {}
  local connection
  for item_index = 1, #items do
    texts[#texts + 1] = tostring(items[item_index].text)
    if items[item_index].text == "Connection" then connection = items[item_index] end
  end
  print(prefix .. "_rows=" .. table.concat(texts, " | "))
  print(prefix .. "_detail=" .. tostring(items[2] and items[2].text))
  print(prefix .. "_has_connection=" .. tostring(connection ~= nil))
  if not connection then return end
  local tapped, tap_raised = pcall(connection.callback)
  local widget = shown[#shown]
  local kind = type(widget) == "table" and tostring(widget.__kind) or "none"
  local text = type(widget) == "table" and tostring(widget.text) or ""
  print(prefix .. "_tap_ok=" .. tostring(tapped) .. " " .. tostring(tap_raised))
  print(prefix .. "_view=" .. kind)
  print(prefix .. "_shows_not_set=" .. tostring(text:find("(not set)", 1, true) ~= nil))
end

dump_screen("browse", function() LightHouse:openCatalog("", 0, 1) end)
dump_screen("reading", function() LightHouse:showReading() end)
dump_screen("stats", function() LightHouse:showStats() end)

print("OK")
`;

describe("unconfigured plugin failures", () => {
  it("offers the Connection screen on every not-configured failure", () => {
    if (!LUA_BINARY) return;

    const workdir = fs.mkdtempSync(path.join(os.tmpdir(), "koplugin-unconfigured-"));
    const harnessPath = path.join(workdir, "not_configured_harness.lua");
    fs.writeFileSync(harnessPath, NOT_CONFIGURED_HARNESS);

    const res = spawnSync(LUA_BINARY, [harnessPath, KOPLUGIN_TEMPLATE_DIR], {
      encoding: "utf8",
    });
    expect(res.stderr).toBe("");
    expect(res.status).toBe(0);

    const out = Object.fromEntries(
      res.stdout
        .split("\n")
        .filter((line) => line.includes("="))
        .map((line) => {
          const index = line.indexOf("=");
          return [line.slice(0, index), line.slice(index + 1)];
        }),
    );

    for (const screen of ["browse", "reading", "stats"]) {
      // Compute from the token so the assertion cannot drift from the scale.
      expect(out[`${screen}_ok`]).toBe("true nil");
      expect(out[`${screen}_rows`]).toContain("This plugin is not configured");
      // The detail says what to do and does not repeat the headline it sits
      // under.
      expect(out[`${screen}_detail`]).not.toContain("This plugin is not configured");
      expect(out[`${screen}_detail`]).toContain("Download the plugin again");
      // The only screen that can fix a missing key has to be one tap away.
      expect(out[`${screen}_has_connection`]).toBe("true");
      expect(out[`${screen}_tap_ok`]).toBe("true nil");
      expect(out[`${screen}_view`]).toBe("textviewer");
      expect(out[`${screen}_shows_not_set`]).toBe("true");
    }

    expect(res.stdout.trimEnd().endsWith("OK")).toBe(true);
  });
});

/**
 * The device crash this guards against (KOReader `crash.log`, both Kindles,
 * plugin 1.3.0):
 *
 *   ./luajit: ./ffi/util.lua:779: invalid replacement value (a function)
 *   ./ffi/util.lua:779: in function 'T'
 *   main.lua:1102: in function 'showReading'
 *   main.lua:624: in function 'callback'
 *   Source line: text = T(_("File: %1"), session.filename)
 *
 * `T()` hands its substitutions to `string.gsub` through a callback, so a
 * substitution that is not a string - here the truthy callable sentinel
 * KOReader's JSON decoder substitutes for a `null` field - makes gsub raise and
 * the process die. The same shape crashed "Browse library" one line earlier, at
 * `T(_("Last device: %1"), entry.status.device)`.
 *
 * The stub `template` above is faithful on purpose (`gsub` over a callback, not
 * a formatter), so these cases fail against the shipped 1.3.0 template and pass
 * only once every substitution is coerced to a string.
 */
const NULL_FIELD_SAFETY_HARNESS = (KOREADER_STUB_PRELUDE + String.raw`
local expected_base_url = assert(arg[2], "expected base url argument required")

-- KOReader's JSON decoder maps a nested null to a truthy callable sentinel
-- rather than nil, which is why "if value and value ~= ''" let it through.
local null = function() end

-- Field-for-field a /api/kosync/active record whose columns were all NULL
-- (firstmate pulled the live payload: 8 of 30 rows carry a null filename,
-- 7 a null title, 11 a null bookId).
local null_session = {
  id = 51,
  document = null, progress = null, percentage = null, device = null,
  device_id = null, filename = null, title = null, authors = null,
  timestamp = null, bookId = null, cover = null,
  displayTitle = null, displayAuthors = null,
}
local string_session = {
  id = 52,
  document = "d6df0b1e0c6dec84dd52e6616fa669d8",
  percentage = 0.45,
  device = "Paperwhite",
  filename = "dune.epub",
  title = "Dune",
  authors = "Frank Herbert",
  timestamp = 1794633720,
  bookId = 101,
  displayTitle = "Dune",
  displayAuthors = "Frank Herbert",
}
local payload = { null_session, string_session }

-- A real OPDS entry pair, so the catalogue path runs end to end.
local opds_body = '<?xml version="1.0" encoding="utf-8"?><feed xmlns="http://www.w3.org/2005/Atom"><title>LightHouse</title><entry><id>urn:calibre:book:101</id><title>Spice and Wolf</title><author><name>Isuna Hasekura</name></author></entry><entry><id>urn:calibre:book:102</id><title>Dune</title><author><name>Frank Herbert</name></author></entry></feed>'

-- The transport stubs run the REAL Client.get -> JSON.decode ->
-- Status.normalizeSessions -> row-build path against the payload.
package.preload["json"] = function()
  return { decode = function() return payload end }
end
package.preload["ltn12"] = function()
  return {
    sink = {
      table = function(target)
        return function(chunk)
          if chunk then target[#target + 1] = chunk end
          return 1
        end
      end,
      file = function() end,
    },
  }
end
package.preload["socket.http"] = function()
  return {
    request = function(request)
      local url = tostring(request and request.url or "")
      local body = url:find("/api/opds", 1, true) and opds_body or "[]"
      if request and request.sink then
        request.sink(body)
        request.sink(nil)
      end
      return 1, 200, {}
    end,
  }
end

local LightHouse = assert(loadfile(plugin_root .. "/main.lua"))()
local config = require("lighthouse_config")
assert(config.base_url == expected_base_url,
  "harness needs the generated config, got " .. tostring(config.base_url))
local Status = require("lighthouse_status")

LightHouse.ui = { menu = { registerToMainMenu = function() end } }
LightHouse:init()
-- These assertions are about text, not images; the cover path has its own
-- cases below.
LightHouse.coversEnabled = function() return false end

local function bracket(value) return "[" .. tostring(value) .. "]" end

-- 1. The guard's contract ---------------------------------------------------
print("str_nil=" .. bracket(Status.str(nil)))
print("str_string=" .. bracket(Status.str("dune.epub")))
print("str_number=" .. bracket(Status.str(42)))
print("str_table=" .. bracket(Status.str({ 1, 2 })))
print("str_function=" .. bracket(Status.str(null)))
print("str_boolean=" .. bracket(Status.str(true)))
print("str_nan=" .. bracket(Status.str(0 / 0)))
print("str_infinity=" .. bracket(Status.str(math.huge)))
print("str_negative_infinity=" .. bracket(Status.str(-math.huge)))
print("str_infinity_fallback=" .. bracket(Status.str(math.huge, "Unknown")))
print("str_fallback=" .. bracket(Status.str(null, "Unknown")))
print("str_fallback_keeps_string=" .. bracket(Status.str("real", "Unknown")))
print("num_number=" .. tostring(Status.num(7)))
print("num_numeric_string=" .. tostring(Status.num("12")))
print("num_function=" .. tostring(Status.num(null)))
print("num_table=" .. tostring(Status.num({ 1 })))
print("num_nan=" .. tostring(Status.num(0 / 0)))
print("num_infinity=" .. tostring(Status.num(math.huge)))

-- 2. A row whose fields are nil, a table, a function and a number -----------
local cases = {
  { name = "nil", value = nil },
  { name = "table", value = { 1, 2 } },
  { name = "function", value = null },
  { name = "number", value = 42 },
  { name = "string", value = "dune.epub" },
}
for case_index = 1, #cases do
  local case = cases[case_index]
  local ok, message = pcall(LightHouse.formatMessage, "File: %1", case.value)
  print("message_" .. case.name .. "=" .. tostring(ok) .. " " .. bracket(message))
end
local multi_ok, multi_text = pcall(LightHouse.formatMessage, "Page %1 of %2", 2, null)
print("message_multi=" .. tostring(multi_ok) .. " " .. bracket(multi_text))

-- 3. Normalization at the boundary -----------------------------------------
local sessions = Status.normalizeSessions(payload)
print("sessions=" .. tostring(#sessions))
local newest = sessions[1]
local nulls = sessions[2]
print("newest_filename=" .. bracket(newest.filename))
print("newest_book_id=" .. tostring(newest.book_id))
print("newest_percentage=" .. tostring(newest.percentage))
print("nulls_filename_type=" .. type(nulls.filename))
print("nulls_filename=" .. bracket(nulls.filename))
print("nulls_title_type=" .. type(nulls.title))
print("nulls_title=" .. bracket(nulls.title))
print("nulls_authors_type=" .. type(nulls.authors))
print("nulls_device_type=" .. type(nulls.device))
print("nulls_document_type=" .. type(nulls.document))
print("nulls_book_id=" .. tostring(nulls.book_id))
print("nulls_timestamp=" .. tostring(nulls.timestamp))
print("nulls_percentage=" .. tostring(nulls.percentage))

-- 4. The exact device traceback: the shelf row for a null-bearing session ----
local layout = LightHouse:layoutFor(false)
local reading_ok, reading_row = pcall(LightHouse.buildReadingItem, LightHouse, nulls, layout)
print("reading_row_ok=" .. tostring(reading_ok))
if reading_ok then
  print("reading_row_text=" .. bracket(reading_row.text))
  local labels = {}
  for detail_index = 1, #(reading_row.sub_item_table or {}) do
    labels[#labels + 1] = tostring(reading_row.sub_item_table[detail_index].text)
  end
  print("reading_row_details=" .. table.concat(labels, "|"))
else
  print("reading_row_error=" .. bracket(reading_row))
end
local good_ok, good_row = pcall(LightHouse.buildReadingItem, LightHouse, newest, layout)
print("reading_good_ok=" .. tostring(good_ok))
if good_ok then
  local labels = {}
  for detail_index = 1, #(good_row.sub_item_table or {}) do
    labels[#labels + 1] = tostring(good_row.sub_item_table[detail_index].text)
  end
  print("reading_good_details=" .. table.concat(labels, "|"))
end

-- 5. The catalogue row for an entry whose fields are all unusable ------------
local hostile_entry = {
  book_id = null, title = null, authors = null, series = null,
  series_index = null, rating = null, tags = null, summary = null,
  status = { device = null, percentage = null, timestamp = null },
  download_href = nil,
}
local catalog_ok, catalog_row = pcall(LightHouse.buildCatalogItem, LightHouse, hostile_entry, layout)
print("catalog_null_ok=" .. tostring(catalog_ok))
if catalog_ok then
  print("catalog_null_text=" .. bracket(catalog_row.text))
  local labels = {}
  for detail_index = 1, #(catalog_row.sub_item_table or {}) do
    labels[#labels + 1] = tostring(catalog_row.sub_item_table[detail_index].text)
  end
  print("catalog_null_details=" .. table.concat(labels, "|"))
else
  print("catalog_null_error=" .. bracket(catalog_row))
end
-- A tag list carrying a table and a sentinel must not reach table.concat raw.
local tagged_entry = {
  book_id = 103, title = "Tagged", authors = "An Author",
  tags = { "Fantasy", { nested = true }, null, 7 },
}
local tagged_ok, tagged_row = pcall(LightHouse.buildCatalogItem, LightHouse, tagged_entry, layout)
print("catalog_tags_ok=" .. tostring(tagged_ok))
if tagged_ok then
  local labels = {}
  for detail_index = 1, #(tagged_row.sub_item_table or {}) do
    labels[#labels + 1] = tostring(tagged_row.sub_item_table[detail_index].text)
  end
  print("catalog_tags_details=" .. table.concat(labels, "|"))
end
-- The detail view is where the reader goes to see WHO wrote the book, so it
-- keeps every name the feed carries; only the row's metadata column truncates.
local coauthored_entry = {
  book_id = 104, title = "Coauthored",
  authors = "Ann One, Bob Two, Cyd Three",
}
local coauthored_ok, coauthored_row = pcall(LightHouse.buildCatalogItem, LightHouse, coauthored_entry, layout)
print("catalog_coauthored_ok=" .. tostring(coauthored_ok))
if coauthored_ok then
  local labels = {}
  for detail_index = 1, #(coauthored_row.sub_item_table or {}) do
    labels[#labels + 1] = tostring(coauthored_row.sub_item_table[detail_index].text)
  end
  print("catalog_coauthored_details=" .. table.concat(labels, "|"))
  print("catalog_coauthored_mandatory=" .. bracket(coauthored_row.mandatory))
end

-- 6. The pcall fallback: one bad row renders a safe row, never the process --
local fallback = LightHouse:buildSafeRow(function() error("row builder exploded") end)
print("fallback_type=" .. type(fallback))
print("fallback_text=" .. bracket(fallback.text))
print("fallback_select_enabled=" .. tostring(fallback.select_enabled))
print("fallback_callback=" .. type(fallback.callback))
local odd = LightHouse:buildSafeRow(function() return "not a row" end)
print("fallback_from_string=" .. bracket(odd.text))

-- 7. A cover failure never propagates out of the row build ------------------
local real_cover = LightHouse.coverSlot
LightHouse.coverSlot = function() error("cover widget exploded") end
local cover_ok, cover_row = pcall(LightHouse.buildRow, LightHouse, {
  cover_entry = { book_id = 101 },
  primary = "Covered row",
  layout = LightHouse:layoutFor(true),
})
print("cover_row_ok=" .. tostring(cover_ok))
if cover_ok then
  print("cover_row_text=" .. bracket(cover_row.text))
else
  print("cover_row_error=" .. bracket(cover_row))
end
local real_fetch = LightHouse.fetchOneCover
LightHouse.fetchOneCover = function() error("cover fetch exploded") end
local prefetch_ok = pcall(LightHouse.prefetchCovers, LightHouse, {
  { book_id = 101, thumbnail_href = "http://host/api/books/101/cover?w=360" },
  { book_id = 102, thumbnail_href = "http://host/api/books/102/cover?w=360" },
})
print("prefetch_ok=" .. tostring(prefetch_ok))
LightHouse.fetchOneCover = real_fetch
LightHouse.coverSlot = real_cover

-- 8. The whole shelf and the whole catalogue, through the real views ---------
local function current_menu()
  local widget = shown[#shown]
  if widget and widget.item_table and widget.__kind == "menu" then return widget end
  local reused = LightHouse.menu and LightHouse.menu.switched
  if reused and reused[#reused] then
    return { title = reused[#reused].title, item_table = reused[#reused].items }
  end
  return widget
end

local shelf_ok, shelf_err = pcall(function() LightHouse:showReading() end)
print("shelf_ok=" .. tostring(shelf_ok) .. " " .. tostring(shelf_err))
local shelf = current_menu()
print("shelf_title=" .. tostring(shelf and shelf.title))
print("shelf_rows=" .. tostring(shelf and #(shelf.item_table or {})))
local shelf_types = {}
for row_index = 1, #(shelf and shelf.item_table or {}) do
  shelf_types[#shelf_types + 1] = type(shelf.item_table[row_index].text)
end
print("shelf_row_text_types=" .. table.concat(shelf_types, ","))

local browse_ok, browse_err = pcall(function() LightHouse:openCatalog("", 0, 1) end)
print("browse_ok=" .. tostring(browse_ok) .. " " .. tostring(browse_err))
local browse = current_menu()
print("browse_rows=" .. tostring(browse and #(browse.item_table or {})))
local browse_types = {}
local browse_texts = {}
for row_index = 1, #(browse and browse.item_table or {}) do
  browse_types[#browse_types + 1] = type(browse.item_table[row_index].text)
  browse_texts[#browse_texts + 1] = tostring(browse.item_table[row_index].text)
end
print("browse_row_text_types=" .. table.concat(browse_types, ","))
print("browse_texts=" .. table.concat(browse_texts, "|"))

print("OK")
`);

describe("plugin row safety against JSON nulls and malformed fields", () => {
  function runNullHarness(): Record<string, string> {
    if (!LUA_BINARY || !UNZIP_BINARY) return {};

    const { zip } = generateKoplugin({
      baseUrl: "http://192.168.31.15:8086",
      apiKey: "harness-api-key",
      generatedAt: "2026-11-14T00:00:00.000Z",
    });

    const workdir = fs.mkdtempSync(path.join(os.tmpdir(), "koplugin-nulls-"));
    const zipPath = path.join(workdir, "lighthouse.koplugin");
    fs.writeFileSync(zipPath, zip);
    const pluginsDir = path.join(workdir, "plugins");
    fs.mkdirSync(pluginsDir, { recursive: true });
    const extract = spawnSync(
      UNZIP_BINARY as string,
      ["-q", zipPath, "-d", pluginsDir],
      { encoding: "utf8" },
    );
    expect(extract.status).toBe(0);

    const pluginRoot = path.join(pluginsDir, KOPLUGIN_DIR_NAME);
    const harnessPath = path.join(workdir, "null_safety_harness.lua");
    fs.writeFileSync(harnessPath, NULL_FIELD_SAFETY_HARNESS);

    const res = spawnSync(
      LUA_BINARY,
      [harnessPath, pluginRoot, "http://192.168.31.15:8086"],
      { encoding: "utf8" },
    );
    expect(res.stderr).toBe("");
    expect(res.status).toBe(0);
    return Object.fromEntries(
      res.stdout
        .split("\n")
        .filter((line: string) => line.includes("="))
        .map((line) => {
          const index = line.indexOf("=");
          return [line.slice(0, index), line.slice(index + 1)];
        }),
    );
  }

  it("coerces every untrusted value to a string and never to nil", () => {
    if (!LUA_BINARY || !UNZIP_BINARY) return;
    const out = runNullHarness();

    expect(out.str_nil).toBe("[]");
    expect(out.str_string).toBe("[dune.epub]");
    expect(out.str_number).toBe("[42]");
    expect(out.str_table).toBe("[]");
    expect(out.str_function).toBe("[]");
    expect(out.str_boolean).toBe("[]");
    expect(out.str_nan).toBe("[]");
    // An infinite number has no reader-facing spelling either: the documented
    // contract says it takes the fallback, so it must never render "inf".
    expect(out.str_infinity).toBe("[]");
    expect(out.str_negative_infinity).toBe("[]");
    expect(out.str_infinity_fallback).toBe("[Unknown]");
    expect(out.str_fallback).toBe("[Unknown]");
    expect(out.str_fallback_keeps_string).toBe("[real]");

    expect(out.num_number).toBe("7");
    expect(out.num_numeric_string).toBe("12");
    expect(out.num_function).toBe("nil");
    expect(out.num_table).toBe("nil");
    expect(out.num_nan).toBe("nil");
    expect(out.num_infinity).toBe("nil");
  });

  it("renders a row whose substituted field is nil, a table, a function or a number", () => {
    if (!LUA_BINARY || !UNZIP_BINARY) return;
    const out = runNullHarness();

    // Every case must format instead of raising inside gsub.
    expect(out.message_nil).toBe("true [File: ]");
    expect(out.message_table).toBe("true [File: ]");
    expect(out.message_function).toBe("true [File: ]");
    expect(out.message_number).toBe("true [File: 42]");
    expect(out.message_string).toBe("true [File: dune.epub]");
    expect(out.message_multi).toBe("true [Page 2 of ]");
  });

  it("normalizes a null-bearing session instead of passing the sentinel on", () => {
    if (!LUA_BINARY || !UNZIP_BINARY) return;
    const out = runNullHarness();

    expect(out.sessions).toBe("2");
    // The readable session is untouched; it is only sorted newest first.
    expect(out.newest_filename).toBe("[dune.epub]");
    expect(out.newest_book_id).toBe("101");
    expect(out.newest_percentage).toBe("0.45");
    // The null-bearing session holds strings and numbers, never sentinels.
    expect(out.nulls_filename_type).toBe("string");
    expect(out.nulls_filename).toBe("[]");
    expect(out.nulls_title_type).toBe("string");
    expect(out.nulls_title).toBe("[]");
    expect(out.nulls_authors_type).toBe("string");
    expect(out.nulls_device_type).toBe("string");
    expect(out.nulls_document_type).toBe("string");
    expect(out.nulls_book_id).toBe("nil");
    expect(out.nulls_timestamp).toBe("0");
    expect(out.nulls_percentage).toBe("0");
  });

  it("builds the shelf row that killed the device (File: %1 with a null filename)", () => {
    if (!LUA_BINARY || !UNZIP_BINARY) return;
    const out = runNullHarness();

    expect(out.reading_row_ok).toBe("true");
    expect(out.reading_row_text).toBe("[Untitled]");
    // No "File:" and no "Device:" row for values the server sent as null, but
    // the progress row and the book-less notice still render.
    expect(out.reading_row_details).toContain("No matching book in the library");
    expect(out.reading_row_details).toContain("Progress:");
    expect(out.reading_row_details).not.toContain("File:");
    expect(out.reading_row_details).not.toContain("Device:");

    // A complete session still shows its own detail rows.
    expect(out.reading_good_ok).toBe("true");
    expect(out.reading_good_details).toContain("Device: Paperwhite");
    expect(out.reading_good_details).toContain("File: dune.epub");
  });

  it("hardens the browse row for an entry whose fields are all unusable", () => {
    if (!LUA_BINARY || !UNZIP_BINARY) return;
    const out = runNullHarness();

    // Browse is hardened by construction: no device traceback was captured for
    // it (both Kindles are off SSH), so this asserts the construction, not the
    // device.
    expect(out.catalog_null_ok).toBe("true");
    expect(out.catalog_null_text).toBe("[Untitled]");
    expect(out.catalog_null_details).toContain("Author: Unknown");
    expect(out.catalog_null_details).toContain("Rating: Not rated");
    expect(out.catalog_null_details).toContain("Progress:");

    // A tag list with a table and a sentinel in it degrades to the real names.
    expect(out.catalog_tags_ok).toBe("true");
    expect(out.catalog_tags_details).toContain("Tags: Fantasy, 7");

    // The detail view keeps every co-author; the row column still truncates.
    expect(out.catalog_coauthored_ok).toBe("true");
    expect(out.catalog_coauthored_details).toContain(
      "Author: Ann One, Bob Two, Cyd Three",
    );
    expect(out.catalog_coauthored_mandatory).toContain(
      "Ann One, Bob Two +1 more",
    );
  });

  it("renders a safe fallback row when a row builder raises", () => {
    if (!LUA_BINARY || !UNZIP_BINARY) return;
    const out = runNullHarness();

    expect(out.fallback_type).toBe("table");
    expect(out.fallback_text).toBe("[Row unavailable]");
    expect(out.fallback_select_enabled).toBe("false");
    expect(out.fallback_callback).toBe("function");
    // A builder that returns a non-row is also a bad row, not a crash.
    expect(out.fallback_from_string).toBe("[Row unavailable]");
  });

  it("keeps a cover failure inside the row build and inside the page prefetch", () => {
    if (!LUA_BINARY || !UNZIP_BINARY) return;
    const out = runNullHarness();

    expect(out.cover_row_ok).toBe("true");
    expect(out.cover_row_text).toBe("[Covered row]");
    expect(out.prefetch_ok).toBe("true");
  });

  it("renders the whole shelf and the whole catalogue on a null-bearing payload", () => {
    if (!LUA_BINARY || !UNZIP_BINARY) return;
    const out = runNullHarness();

    // Tapping "Currently reading" must render, not raise: this is the crash.
    expect(out.shelf_ok).toBe("true nil");
    expect(out.shelf_rows).toBe("2");
    expect(out.shelf_row_text_types).toBe("string,string");

    // And browsing must still show every entry, one row each plus the search
    // row.
    expect(out.browse_ok).toBe("true nil");
    expect(out.browse_rows).toBe("3");
    expect(out.browse_row_text_types).toBe("string,string,string");
    expect(out.browse_texts).toContain("Spice and Wolf");
    expect(out.browse_texts).toContain("Dune");
  });
});

/**
 * Row-width regression (plugin 1.4.1).
 *
 * 1.4.0 fixed the null-sentinel crash and exposed a second one: on both Kindles,
 * opening Browse library or Currently reading killed KOReader with
 *
 *   ./luajit: frontend/ui/widget/textboxwidget.lua:394:
 *     bad argument #2 to 'makeLine' (width must be strictly positive)
 *
 * `menu.lua` computes
 *
 *   available_width = content_width - state_width
 *                                 - text_mandatory_padding - mandatory_w
 *
 * and hands it straight to a TextBoxWidget. `Ui.metaColumn` budgeted that
 * column in *graphemes* (64 chars), which is not a pixel bound: the same 64
 * characters are two to three times wider in Burmese than in Latin, and the
 * block glyphs in the progress bar are wider still. Measured on the Paperwhite
 * (screen 1236x1648, real faces, 1166px of content, 266px cover gutter) a real
 * row's metadata column was 1564px, leaving available_width = -685.
 *
 * The width model below is deliberately hostile in the same direction as the
 * device, so a character budget cannot pass it by luck.
 */
const ROW_WIDTH_HARNESS = KOREADER_STUB_PRELUDE + String.raw`
-- Distance the width model charges, in pixels: Latin per character, and per
-- code point for everything else (Burmese, CJK, the block glyphs of the bar).
local WIDTH_ASCII = 9
local WIDTH_WIDE = 30

local function model_width(text)
    if type(text) ~= "string" then return 0 end
    local total, index = 0, 1
    while index <= #text do
        local byte = text:byte(index)
        local step = 1
        if byte >= 0xF0 then step = 4
        elseif byte >= 0xE0 then step = 3
        elseif byte >= 0xC0 then step = 2 end
        if step == 1 then total = total + WIDTH_ASCII else total = total + WIDTH_WIDE end
        index = index + step
    end
    return total
end

-- The prelude's TextWidget stub cannot measure; replace it before main.lua
-- loads, because the plugin builds its measurer from this class.
package.preload["ui/widget/textwidget"] = function()
    local widget = {}
    function widget:new(options)
        options = options or {}
        options.__kind = "textwidget"
        function options:getWidth() return model_width(self.text) end
        function options:free() end
        return options
    end
    return widget
end

local LightHouse = assert(loadfile(plugin_root .. "/main.lua"))()
local Ui = require("lighthouse_ui")

-- makeLine, exactly as TextBoxWidget raises it on the device.
local function makeLine(width)
    if type(width) ~= "number" or width <= 0 then
        error("bad argument #2 to 'makeLine' (width must be strictly positive)", 2)
    end
    return width
end

-- The device arithmetic from menu.lua: the stub reports a 600x800 screen with
-- Size.padding.fullscreen = 10 and Size.border.window = 2, so a row's content
-- box is 600 - 2*2 - 2*10 = 576px, and 7px of mandatory padding.
local CONTENT_WIDTH = 600 - 2 * 2 - 2 * 10
local MANDATORY_PADDING = 7

local function report(label, item, layout)
    local state_width = layout.gutter or 0
    local mandatory_w = model_width(item.mandatory or "")
    local available = CONTENT_WIDTH - state_width - MANDATORY_PADDING - mandatory_w
    local ok, err = pcall(makeLine, available)
    print(string.format("%s_text=%s", label, tostring(item.text)))
    print(string.format("%s_text_len=%d", label, #tostring(item.text)))
    print(string.format("%s_mandatory_w=%d", label, mandatory_w))
    print(string.format("%s_available=%d", label, available))
    print(string.format("%s_makeline_ok=%s", label, tostring(ok)))
    print(string.format("%s_state_w=%d", label, state_width))
    print(string.format("%s_cover_width=%d", label, layout.cover_width or 0))
    if not ok then print(string.format("%s_err=%s", label, tostring(err))) end
    return available
end

-- A real catalogue row: three Burmese authors, a Burmese title, progress.
local burmese_title = "\224\128\188\224\128\128\224\128\172\224\128\172\224\128\155\224\128\172\224\128\172\224\128\183\224\128\133\224\128\185\224\128\133\224\128\172"
local burmese_authors = "\224\128\161\224\128\177\224\128\172\224\128\175\224\128\172\224\128\128\224\128\153\224\128\175\224\128\172\224\128\154\224\128\172\224\128\155\224\128\172\224\128\184\224\128\155\224\128\140\224\128\101\224\128\171\224\128\172\224\128\173\224\128\172\224\128\170\224\128\149\224\128\140\224\128\186\224\128\128\224\128\172\224\128\172\224\128\180\224\128\176\224\128\175\224\128\132\224\128\186\224\128\128\224\128\172\224\128\181\224\128\172\224\128\156\224\128\172\224\128\175\224\128\179\224\128\129\224\128\172\224\128\172\224\128\136\224\128\172\224\128\172\224\128\131\224\128\172\224\128\130"

-- 1. A very wide mandatory string, covers on (the gutter is present too).
local covers_layout = LightHouse:layoutFor(true)
local wide_row = LightHouse:buildRow{
    layout = covers_layout,
    primary = burmese_title,
    secondary = burmese_authors,
    glance = Ui.glanceProgress(require("lighthouse_status"), 0.45),
    cover_glyph = "#",
    callback = function() end,
}
report("wide_mandatory", wide_row, covers_layout)

-- The same row without covers: no gutter, so the metadata column has more room
-- and must still fit it.
local plain_layout = LightHouse:layoutFor(false)
local wide_plain = LightHouse:buildRow{
    layout = plain_layout,
    primary = burmese_title,
    secondary = burmese_authors,
    glance = Ui.glanceProgress(require("lighthouse_status"), 0.45),
    callback = function() end,
}
report("wide_plain", wide_plain, plain_layout)

-- 2. An empty title must not become a zero-width line.
local empty_title = LightHouse:buildRow{
    layout = covers_layout,
    primary = "   ",
    secondary = "Isuna Hasekura",
    glance = "45%",
    cover_glyph = "#",
    callback = function() end,
}
report("empty_title", empty_title, covers_layout)

-- 3. The old character budget, measured the same way: this is the width the
-- device actually received, and the assertion below proves the fixture
-- overflows instead of passing by luck.
local legacy_meta = Ui.metaColumn(burmese_authors, Ui.glanceProgress(require("lighthouse_status"), 0.45))
print(string.format("legacy_mandatory_w=%d", model_width(legacy_meta)))
print(string.format("legacy_available=%d",
    CONTENT_WIDTH - (covers_layout.gutter or 0) - MANDATORY_PADDING - model_width(legacy_meta)))

print("OK")
`;

/**
 * The pure geometry half of the same fix: the cover slot gives up pixels before
 * the title column does, and a pixel fit is a pixel fit.
 *
 * `lighthouse_ui.lua` has no `require`s, so this harness loads it directly and
 * needs none of the KOReader stubs.
 */
const ROW_GEOMETRY_HARNESS = String.raw`
local Ui = assert(loadfile(assert(arg[1]) .. "/lighthouse_ui.lua"))()

-- A screen too narrow for a full-size cover keeps the row: the slot shrinks.
local shrunk = Ui.layout(800, 1, true)
Ui.clampLayout(shrunk, { content_width = 160, padding = 7, scale = 1, name_min = 40 })
print(string.format("clamp_shrunk_gutter=%d", shrunk.gutter))
print(string.format("clamp_shrunk_cover_w=%d", shrunk.cover_width))
print(string.format("clamp_shrunk_text_w=%d", 160 - shrunk.gutter - 7))

-- A screen where no cover at all leaves a usable title column drops the slot
-- rather than the row.
local dropped = Ui.layout(800, 1, true)
Ui.clampLayout(dropped, { content_width = 90, padding = 7, scale = 1, name_min = 40 })
print(string.format("clamp_dropped_gutter=%d", dropped.gutter))
print(string.format("clamp_dropped_cover_w=%d", dropped.cover_width))

-- A layout with room for its cover is left exactly as it was.
local kept = Ui.layout(800, 1, true)
local kept_gutter = kept.gutter
Ui.clampLayout(kept, { content_width = 576, padding = 7, scale = 1, name_min = 40 })
print(string.format("clamp_kept_gutter=%d", kept.gutter - kept_gutter))

-- fitToWidth is a genuine pixel fit, not a character count.
local function width(text)
    local total, index = 0, 1
    while index <= #text do
        local byte = text:byte(index)
        local step = 1
        if byte >= 0xF0 then step = 4
        elseif byte >= 0xE0 then step = 3
        elseif byte >= 0xC0 then step = 2 end
        total = total + (step == 1 and 9 or 30)
        index = index + step
    end
    return total
end
local wide = string.rep("\224\128\128", 40)
print(string.format("fit_wide=%d", #Ui.fitToWidth(wide, width, 120)))
print(string.format("fit_wide_width=%d", width(Ui.fitToWidth(wide, width, 120))))
print(string.format("fit_kept=%s", tostring(Ui.fitToWidth("abc", width, 100) == "abc")))
print(string.format("fit_too_tight=%s", tostring(Ui.fitToWidth("abc", width, 2) == "")))
print("OK")
`;

describe("plugin row width", () => {
  it("never hands TextBoxWidget a width that is not strictly positive", () => {
    if (!LUA_BINARY || !UNZIP_BINARY) return;

    const { zip } = generateKoplugin({
      baseUrl: "http://192.168.31.15:8086",
      apiKey: "row-width-key",
      generatedAt: "2026-11-14T00:00:00.000Z",
    });
    const workdir = fs.mkdtempSync(path.join(os.tmpdir(), "koplugin-rowwidth-"));
    const zipPath = path.join(workdir, "lighthouse.koplugin");
    fs.writeFileSync(zipPath, zip);
    const pluginsDir = path.join(workdir, "plugins");
    fs.mkdirSync(pluginsDir, { recursive: true });
    const extract = spawnSync(UNZIP_BINARY as string, ["-q", zipPath, "-d", pluginsDir], {
      encoding: "utf8",
    });
    expect(extract.status).toBe(0);

    const pluginRoot = path.join(pluginsDir, KOPLUGIN_DIR_NAME);
    const harnessPath = path.join(workdir, "row_width_harness.lua");
    fs.writeFileSync(harnessPath, ROW_WIDTH_HARNESS);

    const res = spawnSync(LUA_BINARY, [harnessPath, pluginRoot], { encoding: "utf8" });
    expect(res.stderr).toBe("");
    expect(res.status).toBe(0);

    const out = Object.fromEntries(
      res.stdout
        .split("\n")
        .filter((line) => line.includes("="))
        .map((line) => {
          const index = line.indexOf("=");
          return [line.slice(0, index), line.slice(index + 1)];
        }),
    );

    // The fixture is a real overflow: the 1.4.0 character budget produced this
    // exact row, and this exact width, on the device.
    expect(Number(out.legacy_available)).toBeLessThanOrEqual(0);
    expect(Number(out.legacy_mandatory_w)).toBeGreaterThan(500 - 21);

    // Wide mandatory string, covers on: the metadata column fits its budget and
    // the title keeps a drawable width.
    expect(out.wide_mandatory_makeline_ok).toBe("true");
    expect(Number(out.wide_mandatory_available)).toBeGreaterThan(0);
    expect(Number(out.wide_mandatory_available)).toBeGreaterThanOrEqual(40);
    // The cover gutter survives - the fix narrows the column, never the covers.
    expect(Number(out.wide_mandatory_state_w)).toBeGreaterThan(0);
    expect(Number(out.wide_mandatory_cover_width)).toBeGreaterThan(0);

    // Wide mandatory plus a cover gutter without covers: still fits.
    expect(out.wide_plain_makeline_ok).toBe("true");
    expect(Number(out.wide_plain_available)).toBeGreaterThan(0);
    expect(Number(out.wide_plain_state_w)).toBe(0);

    // An empty title never becomes a zero-width line.
    expect(out.empty_title_makeline_ok).toBe("true");
    expect(Number(out.empty_title_text_len)).toBeGreaterThan(0);
    expect(Number(out.empty_title_available)).toBeGreaterThan(0);

    expect(res.stdout.trimEnd().endsWith("OK")).toBe(true);
  });

  it("shrinks the cover slot, never the row, and fits text in pixels", () => {
    if (!LUA_BINARY) return;

    const harnessPath = writeScratch("row_geometry_harness.lua", ROW_GEOMETRY_HARNESS);
    const res = spawnSync(LUA_BINARY, [harnessPath, KOPLUGIN_TEMPLATE_DIR], {
      encoding: "utf8",
    });
    expect(res.stderr).toBe("");
    expect(res.status).toBe(0);

    const out = Object.fromEntries(
      res.stdout
        .split("\n")
        .filter((line) => line.includes("="))
        .map((line) => {
          const index = line.indexOf("=");
          return [line.slice(0, index), line.slice(index + 1)];
        }),
    );

    // The slot shrinks before the row does, and only disappears when no cover
    // can leave a usable title column.
    expect(Number(out.clamp_shrunk_gutter)).toBeLessThan(89);
    expect(Number(out.clamp_shrunk_cover_w)).toBeGreaterThan(0);
    expect(Number(out.clamp_shrunk_text_w)).toBeGreaterThanOrEqual(80);
    expect(Number(out.clamp_dropped_gutter)).toBe(0);
    expect(Number(out.clamp_dropped_cover_w)).toBe(0);
    // A page with room for its cover keeps the cover untouched.
    expect(Number(out.clamp_kept_gutter)).toBe(0);

    // fitToWidth shortens until the *measured* width fits, and leaves text that
    // already fits alone.
    expect(Number(out.fit_wide)).toBeLessThan(40);
    expect(Number(out.fit_wide_width)).toBeLessThanOrEqual(120);
    expect(out.fit_kept).toBe("true");
    expect(out.fit_too_tight).toBe("true");

    expect(res.stdout.trimEnd().endsWith("OK")).toBe(true);
  });
});
