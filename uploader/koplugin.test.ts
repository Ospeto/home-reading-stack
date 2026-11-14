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
  KOPLUGIN_TEMPLATE_DIR,
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
  pluginVersion: "1.0.0",
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

  it("declares the plugin metadata KOReader reads from _meta.lua", () => {
    const meta = fs.readFileSync(
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
 * Loads the *extracted* generated plugin with KOReader's own module names
 * stubbed out, and asserts the real plugin tree boots and builds its menu.
 *
 * This is the closest verification available without a device: KOReader's
 * PluginLoader does exactly `dofile(plugin_root .. "/main.lua")` with
 * `plugin_root` on `package.path`, which is what this harness reproduces.
 */
const KOREADER_STUB_HARNESS = String.raw`
local plugin_root = assert(arg[1], "plugin root argument required")
local expected_base_url = assert(arg[2], "expected base url argument required")
package.path = plugin_root .. "/?.lua;" .. package.path

-- ---------------------------------------------------------------- KOReader stubs
local shown = {}
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
  return { dbg = function() end, info = function() end,
           warn = function() end, err = function() end }
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

-- ------------------------------------------------------------- load the plugin
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
