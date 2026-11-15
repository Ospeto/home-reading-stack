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
  pluginVersion: "1.1.0",
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

local function report(label, value)
  print(label .. "=" .. tostring(value))
end

local function make_transport(calls, key_log, handler)
  return {
    request = function(request)
      calls[#calls + 1] = request.url
      key_log[#key_log + 1] = (request.headers or {})["X-API-Key"] and "Y" or "N"
      return handler(request)
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

package.preload["socket.http"] = function() return make_transport(http_urls, http_keys, handler) end
package.preload["socket.https"] = function() return make_transport(https_urls, https_keys, handler) end
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
  });

  it("keeps X-API-Key when a download redirect stays on the same host", () => {
    if (!LUA_BINARY) return;
    const out = runClientScenario("download");
    // Both https hops resolve under https://wan.test, so the key survives.
    expect(out.https_keys).toBe("YY");
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
    template = function(text, ...)
      local values = { ... }
      return (text:gsub("%%(%d)", function(index)
        return tostring(values[tonumber(index)] or "")
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
local row = LightHouse:buildCatalogItem({
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
})
print("row_text=" .. row.text)
print("row_mandatory=" .. row.mandatory)
local detail_labels = {}
for _, item in ipairs(row.sub_item_table) do detail_labels[#detail_labels + 1] = item.text end
print("detail=" .. table.concat(detail_labels, "|"))

-- Connection screen must expose the baked-in origin and endpoint paths.
LightHouse:showConnection(true)
local connection = shown[#shown]
assert(connection and connection.__kind == "textviewer", "connection view must be a TextViewer")
print("connection_has_origin=" .. tostring(connection.text:find(expected_base_url, 1, true) ~= nil))
print("connection_has_opds=" .. tostring(connection.text:find("/api/opds", 1, true) ~= nil))
print("connection_has_progress=" .. tostring(connection.text:find("/api/kosync/active", 1, true) ~= nil))

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
    expect(submenu).toContain("Choose download folder…");
    expect(submenu).toContain("Connection");

    expect(out.row_text).toBe("★★★★☆ Spice and Wolf, Vol. 1");
    expect(out.row_mandatory).toContain("Isuna Hasekura");
    expect(out.row_mandatory).toContain("45%");

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
    expect(res.stdout.trimEnd().endsWith("OK")).toBe(true);
  });
});
