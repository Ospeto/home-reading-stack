import { describe, it, expect, beforeEach } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import zlib from "node:zlib";
import { PassThrough } from "node:stream";
import {
  isElscioneUrl,
  parseElscioneUrl,
  cleanAndNormalizeNovelUrl,
  extractVolumeNumberFromFilename,
  parseAnubisChallenge,
  solveAnubisChallenge,
  submitAnubisSolution,
  fetchWithAnubis,
  extractElscioneManifest,
  extractAndConvertEpubCover,
  downloadElscioneEpub,
  ingestElscioneSeries,
  getElscioneSessionCookies,
  setElscioneSessionCookies,
  resetElscioneSessionForTest,
  formatElscioneProgress,
  runElscioneHelperManifest,
  runElscioneHelperDownload,
  getElscioneHelperPath,
  getPythonPath,
  listPythonCandidates,
  browserRequestHeaders,
  isCloudflareInterstitial,
  isElscioneBlockedError,
  isElscioneDependencyError,
  isElscioneProxyUsable,
  resetElscioneProxyHealthCacheForTest,
  resetElscionePythonCacheForTest,
  ELSCIONE_BLOCKED_CODE,
  ELSCIONE_PYTHON_DEPENDENCY_CODE,
  ELSCIONE_PYTHON_DEPENDENCY_MESSAGE,
  type AnubisChallenge,
  type ElscioneProgressEvent,
} from "./elscione";
import {
  areMatchingElscioneUrls,
  areMatchingNovelUrls,
  areMatchingLnoriUrls,
} from "./server";

describe("Elscione Light Novel Ingestion Module", () => {
  function createSyntheticEpub(): Buffer {
    function makeEntry(name: string, data: Buffer, compMethod = 0, compData: Buffer | null = null): Buffer {
      const nameBuf = Buffer.from(name);
      const payload = compData || data;
      const crc = zlib.crc32(data);
      const h = Buffer.alloc(30 + nameBuf.length);
      h.writeUInt32LE(0x04034b50, 0);
      h.writeUInt16LE(20, 4);
      h.writeUInt16LE(0, 6);
      h.writeUInt16LE(compMethod, 8);
      h.writeUInt16LE(0, 10);
      h.writeUInt16LE(0, 12);
      h.writeUInt32LE(crc, 14);
      h.writeUInt32LE(payload.length, 18);
      h.writeUInt32LE(data.length, 22);
      h.writeUInt16LE(nameBuf.length, 26);
      h.writeUInt16LE(0, 28);
      nameBuf.copy(h, 30);
      return Buffer.concat([h, payload]);
    }

    const mimeData = Buffer.from("application/epub+zip");
    const mimePart = makeEntry("mimetype", mimeData, 0);
    const containerXml = Buffer.from(
      '<?xml version="1.0"?><container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container"><rootfiles><rootfile full-path="content.opf" media-type="application/oebps-package+xml"/></rootfiles></container>',
    );
    const containerPart = makeEntry("META-INF/container.xml", containerXml, 8, zlib.deflateRawSync(containerXml));
    const opfXml = Buffer.from(
      '<?xml version="1.0"?><package xmlns="http://www.idpf.org/2007/opf" version="3.0"><metadata><dc:title>DanMachi Vol 1</dc:title><dc:creator>Fujino Omori</dc:creator></metadata><manifest/><spine/></package>',
    );
    const opfPart = makeEntry("content.opf", opfXml, 8, zlib.deflateRawSync(opfXml));
    return Buffer.concat([mimePart, containerPart, opfPart, Buffer.alloc(512, 0)]);
  }

  beforeEach(() => {
    resetElscioneSessionForTest();
  });

  describe("URL Recognition & Parsing", () => {
    it("cleanAndNormalizeNovelUrl handles spaces, quotes, missing protocols, and preserves encoded characters", () => {
      // Spaces in path auto-encoded as %20
      expect(
        cleanAndNormalizeNovelUrl(
          "https://server.elscione.com/Officially Translated Light Novels/A Sister's All You Need/",
        ),
      ).toBe(
        "https://server.elscione.com/Officially%20Translated%20Light%20Novels/A%20Sister's%20All%20You%20Need/",
      );

      // Missing protocol prefix prepends https://
      expect(
        cleanAndNormalizeNovelUrl(
          "server.elscione.com/Officially Translated Light Novels/A Sister's All You Need/",
        ),
      ).toBe(
        "https://server.elscione.com/Officially%20Translated%20Light%20Novels/A%20Sister's%20All%20You%20Need/",
      );

      // // prefix prepends https:
      expect(
        cleanAndNormalizeNovelUrl(
          "//server.elscione.com/Officially Translated Light Novels/DanMachi/",
        ),
      ).toBe(
        "https://server.elscione.com/Officially%20Translated%20Light%20Novels/DanMachi/",
      );

      // Preserves already-encoded %20 and %27 without double-encoding
      expect(
        cleanAndNormalizeNovelUrl(
          "https://server.elscione.com/Officially%20Translated%20Light%20Novels/A%20Sister%27s%20All%20You%20Need/?tag=test%20query&page=1#heading",
        ),
      ).toBe(
        "https://server.elscione.com/Officially%20Translated%20Light%20Novels/A%20Sister%27s%20All%20You%20Need/?tag=test%20query&page=1#heading",
      );

      // Mixed encoded and unencoded spaces
      expect(
        cleanAndNormalizeNovelUrl(
          "https://server.elscione.com/Officially%20Translated%20Light%20Novels/A Sister's All You Need/",
        ),
      ).toBe(
        "https://server.elscione.com/Officially%20Translated%20Light%20Novels/A%20Sister's%20All%20You%20Need/",
      );

      // Direct .epub with spaces
      expect(
        cleanAndNormalizeNovelUrl(
          "server.elscione.com/Officially Translated/Overlord/Overlord Volume 01.epub",
        ),
      ).toBe(
        "https://server.elscione.com/Officially%20Translated/Overlord/Overlord%20Volume%2001.epub",
      );

      // Non-breaking space (NBSP) is converted to %20
      expect(
        cleanAndNormalizeNovelUrl(
          "https://server.elscione.com/Officially\u00A0Translated/DanMachi/",
        ),
      ).toBe(
        "https://server.elscione.com/Officially%20Translated/DanMachi/",
      );

      // Strips wrapping quotes and brackets
      expect(
        cleanAndNormalizeNovelUrl(
          "\"https://server.elscione.com/Officially Translated Light Novels/Grimgar/\"",
        ),
      ).toBe(
        "https://server.elscione.com/Officially%20Translated%20Light%20Novels/Grimgar/",
      );
      expect(
        cleanAndNormalizeNovelUrl(
          "<https://server.elscione.com/Officially Translated Light Novels/Grimgar/>",
        ),
      ).toBe(
        "https://server.elscione.com/Officially%20Translated%20Light%20Novels/Grimgar/",
      );
      expect(
        cleanAndNormalizeNovelUrl(
          "'https://server.elscione.com/Officially Translated Light Novels/Grimgar/'",
        ),
      ).toBe(
        "https://server.elscione.com/Officially%20Translated%20Light%20Novels/Grimgar/",
      );

      // Normalizes lnori URLs missing protocol
      expect(
        cleanAndNormalizeNovelUrl("lnori.com/series/8046/the-genius-princes-guide"),
      ).toBe("https://lnori.com/series/8046/the-genius-princes-guide");

      // Empty and invalid inputs
      expect(cleanAndNormalizeNovelUrl("")).toBe("");
      expect(cleanAndNormalizeNovelUrl(null as any)).toBe("");
      expect(cleanAndNormalizeNovelUrl(undefined as any)).toBe("");
    });

    it("isElscioneUrl correctly identifies server.elscione.com URLs", () => {
      expect(
        isElscioneUrl(
          "https://server.elscione.com/Officially%20Translated%20Light%20Novels/Grimgar%20of%20Fantasy%20and%20Ash/",
        ),
      ).toBe(true);
      expect(
        isElscioneUrl(
          "https://server.elscione.com/Officially%20Translated%20Light%20Novels/Grimgar/Volume%2001.epub",
        ),
      ).toBe(true);
      expect(isElscioneUrl("http://server.elscione.com/test")).toBe(true);
      expect(isElscioneUrl("https://mirror.server.elscione.com/folder/")).toBe(true);
      // Spaces, raw quotes, and missing protocol
      expect(
        isElscioneUrl(
          "https://server.elscione.com/Officially Translated Light Novels/A Sister's All You Need/",
        ),
      ).toBe(true);
      expect(
        isElscioneUrl(
          "server.elscione.com/Officially Translated Light Novels/A Sister's All You Need/",
        ),
      ).toBe(true);
      expect(
        isElscioneUrl(
          "server.elscione.com/Officially Translated/Overlord Volume 01.epub",
        ),
      ).toBe(true);
    });

    it("isElscioneUrl correctly identifies server.elsci.one and elsci.one mirror URLs", () => {
      expect(
        isElscioneUrl(
          "https://server.elsci.one/Officially%20Translated%20Light%20Novels/Are%20You%20Okay%20With%20a%20Slightly%20Older%20Girlfriend/",
        ),
      ).toBe(true);
      expect(
        isElscioneUrl(
          "https://server.elsci.one/Officially%20Translated%20Light%20Novels/Are%20You%20Okay%20With%20a%20Slightly%20Older%20Girlfriend/Volume%2001.epub",
        ),
      ).toBe(true);
      expect(isElscioneUrl("http://server.elsci.one/test")).toBe(true);
      expect(isElscioneUrl("https://mirror.server.elsci.one/folder/")).toBe(true);
      expect(isElscioneUrl("https://elsci.one/folder/")).toBe(true);
      expect(
        isElscioneUrl(
          "server.elsci.one/Officially Translated Light Novels/Are You Okay With a Slightly Older Girlfriend/",
        ),
      ).toBe(true);
    });

    it("isElscioneUrl rejects non-Elscione or invalid URLs", () => {
      expect(isElscioneUrl("https://lnori.com/series/8046")).toBe(false);
      expect(isElscioneUrl("https://example.com/books/")).toBe(false);
      expect(isElscioneUrl("not-a-url")).toBe(false);
      expect(isElscioneUrl("")).toBe(false);
    });

    it("parseElscioneUrl correctly parses series folder URLs", () => {
      const parsed = parseElscioneUrl(
        "https://server.elscione.com/Officially%20Translated%20Light%20Novels/Grimgar%20of%20Fantasy%20and%20Ash/",
      );
      expect(parsed).not.toBeNull();
      expect(parsed!.isEpub).toBe(false);
      expect(parsed!.seriesTitle).toBe("Grimgar of Fantasy and Ash");
      expect(parsed!.folderPath).toBe(
        "/Officially%20Translated%20Light%20Novels/Grimgar%20of%20Fantasy%20and%20Ash/",
      );
    });

    it("parseElscioneUrl correctly parses direct .epub URLs", () => {
      const parsed = parseElscioneUrl(
        "https://server.elscione.com/Officially%20Translated%20Light%20Novels/Overlord/Overlord%20-%20Volume%2004.epub",
      );
      expect(parsed).not.toBeNull();
      expect(parsed!.isEpub).toBe(true);
      expect(parsed!.filename).toBe("Overlord - Volume 04.epub");
      expect(parsed!.seriesTitle).toBe("Overlord");
      expect(parsed!.folderPath).toBe(
        "/Officially%20Translated%20Light%20Novels/Overlord/",
      );
    });

    it("parseElscioneUrl correctly parses server.elsci.one URLs", () => {
      const parsed = parseElscioneUrl(
        "https://server.elsci.one/Officially%20Translated%20Light%20Novels/Are%20You%20Okay%20With%20a%20Slightly%20Older%20Girlfriend/",
      );
      expect(parsed).not.toBeNull();
      expect(parsed!.hostname).toBe("server.elsci.one");
      expect(parsed!.isEpub).toBe(false);
      expect(parsed!.seriesTitle).toBe("Are You Okay With a Slightly Older Girlfriend");
      expect(parsed!.folderPath).toBe(
        "/Officially%20Translated%20Light%20Novels/Are%20You%20Okay%20With%20a%20Slightly%20Older%20Girlfriend/",
      );
    });

    it("parseElscioneUrl returns null for invalid URLs", () => {
      expect(parseElscioneUrl("https://google.com")).toBeNull();
      expect(parseElscioneUrl("not a url")).toBeNull();
    });

    it("extractVolumeNumberFromFilename parses various standard LN volume conventions", () => {
      expect(
        extractVolumeNumberFromFilename(
          "Grimgar of Fantasy and Ash - Volume 01.epub",
        ),
      ).toBe(1);
      expect(
        extractVolumeNumberFromFilename(
          "Grimgar of Fantasy and Ash - Volume 14.5.epub",
        ),
      ).toBe(14.5);
      expect(
        extractVolumeNumberFromFilename("Overlord, Vol. 04.epub"),
      ).toBe(4);
      expect(
        extractVolumeNumberFromFilename(
          "Sword Art Online - 01 - Aincrad.epub",
        ),
      ).toBe(1);
      expect(
        extractVolumeNumberFromFilename("Ascendance of a Bookworm Book 3.epub"),
      ).toBe(3);
      expect(
        extractVolumeNumberFromFilename("No Game No Life #02.epub"),
      ).toBe(2);
      expect(
        extractVolumeNumberFromFilename("Mushoku Tensei 12.epub"),
      ).toBe(12);
      expect(
        extractVolumeNumberFromFilename("Standalone Novel.epub"),
      ).toBeUndefined();
    });

    it("parseElscioneUrl handles URL variations with quotes, encoded characters, spaces, and subseries", () => {
      // Encoded %27 and raw quote
      const p1 = parseElscioneUrl(
        "https://server.elscione.com/Officially%20Translated%20Light%20Novels/A%20Sister%27s%20All%20You%20Need/",
      );
      expect(p1).not.toBeNull();
      expect(p1!.seriesTitle).toBe("A Sister's All You Need");

      const p2 = parseElscioneUrl(
        "https://server.elscione.com/Officially Translated Light Novels/A Sister's All You Need/",
      );
      expect(p2).not.toBeNull();
      expect(p2!.seriesTitle).toBe("A Sister's All You Need");

      // Missing trailing slash
      const p3 = parseElscioneUrl(
        "https://server.elscione.com/Officially%20Translated%20Light%20Novels/A%20Sister%27s%20All%20You%20Need",
      );
      expect(p3).not.toBeNull();
      expect(p3!.folderPath).toBe(
        "/Officially%20Translated%20Light%20Novels/A%20Sister%27s%20All%20You%20Need/",
      );

      // Subseries like "NT"
      const p4 = parseElscioneUrl(
        "https://server.elscione.com/Officially%20Translated%20Light%20Novels/A%20Certain%20Magical%20Index%20NT/",
      );
      expect(p4).not.toBeNull();
      expect(p4!.seriesTitle).toBe("A Certain Magical Index NT");
      expect(p4!.folderPath).toBe(
        "/Officially%20Translated%20Light%20Novels/A%20Certain%20Magical%20Index%20NT/",
      );
    });

    it("extractVolumeNumberFromFilename handles generalized volume conventions (Volume 01, v01, Part X Volume Y)", () => {
      expect(
        extractVolumeNumberFromFilename(
          "Ascendance of a Bookworm - Part 1 Volume 2.epub",
        ),
      ).toBe(2);
      expect(
        extractVolumeNumberFromFilename(
          "Ascendance of a Bookworm - Part 1 Daughter of a Soldier v02.epub",
        ),
      ).toBe(2);
      expect(extractVolumeNumberFromFilename("Toradora! v01.epub")).toBe(1);
      expect(extractVolumeNumberFromFilename("Series - v03.epub")).toBe(3);
      expect(
        extractVolumeNumberFromFilename(
          "Classroom of the Elite: Year 2 Vol. 4.5.epub",
        ),
      ).toBe(4.5);
    });
  });

  describe("Anubis Proof-of-Work Challenge Solver", () => {
    it("parseAnubisChallenge parses valid JSON challenge from HTML", () => {
      const mockHtml = `
        <!DOCTYPE html>
        <html>
        <head>
          <title>Anubis Challenge</title>
          <script id="anubis_challenge" type="application/json">
            {"id":"ch_98765","difficulty":3,"randomData":"test_random_seed_123"}
          </script>
        </head>
        <body><p>Please wait while computing challenge...</p></body>
        </html>
      `;
      const challenge = parseAnubisChallenge(mockHtml);
      expect(challenge).not.toBeNull();
      expect(challenge!.id).toBe("ch_98765");
      expect(challenge!.difficulty).toBe(3);
      expect(challenge!.randomData).toBe("test_random_seed_123");
    });

    it("parseAnubisChallenge parses stock Anubis nested { rules, challenge } JSON format", () => {
      const stockHtml = `
        <!DOCTYPE html>
        <html>
        <head>
          <script id="anubis_challenge" type="application/json">
            {
              "rules": { "difficulty": 4, "algorithm": "fast" },
              "challenge": {
                "id": "ch_stock_555",
                "randomData": "stock_anubis_random_bytes_777",
                "difficulty": 4
              }
            }
          </script>
        </head>
        </html>
      `;
      const challenge = parseAnubisChallenge(stockHtml);
      expect(challenge).not.toBeNull();
      expect(challenge!.id).toBe("ch_stock_555");
      expect(challenge!.difficulty).toBe(4);
      expect(challenge!.randomData).toBe("stock_anubis_random_bytes_777");
    });

    it("parseAnubisChallenge handles reversed attribute order in script tag", () => {
      const mockHtml = `
        <script type="application/json" id="anubis_challenge">
          {"id":"ch_rev_123","difficulty":2,"randomData":"seed_abc"}
        </script>
      `;
      const challenge = parseAnubisChallenge(mockHtml);
      expect(challenge).not.toBeNull();
      expect(challenge!.id).toBe("ch_rev_123");
      expect(challenge!.difficulty).toBe(2);
      expect(challenge!.randomData).toBe("seed_abc");
    });

    it("parseAnubisChallenge returns null for non-challenge HTML", () => {
      expect(parseAnubisChallenge("<html><body>Hello World</body></html>")).toBeNull();
      expect(parseAnubisChallenge("")).toBeNull();
      expect(
        parseAnubisChallenge(
          `<script id="anubis_challenge" type="application/json">{invalid json}</script>`,
        ),
      ).toBeNull();
    });

    it("solveAnubisChallenge satisfies leading zero half-bytes", async () => {
      const challenge: AnubisChallenge = {
        id: "ch_test_1",
        difficulty: 3,
        randomData: "test_seed_pow_solver",
      };

      const solution = await solveAnubisChallenge(challenge);
      expect(solution.id).toBe("ch_test_1");
      expect(typeof solution.nonce).toBe("number");
      expect(solution.hash.startsWith("000")).toBe(true);

      // Verify that sha256(randomData + nonce) matches the solution hash
      const computedHash = crypto
        .createHash("sha256")
        .update(challenge.randomData + solution.nonce)
        .digest("hex");
      expect(computedHash).toBe(solution.hash);
      expect(computedHash.startsWith("000")).toBe(true);
    });

    it("solveAnubisChallenge handles difficulty 0 immediately without looping", async () => {
      const challenge: AnubisChallenge = {
        id: "ch_zero",
        difficulty: 0,
        randomData: "any_data",
      };
      const solution = await solveAnubisChallenge(challenge);
      expect(solution.nonce).toBe(0);
      expect(solution.hash).toBeDefined();
    });

    it("setElscioneSessionCookies and getElscioneSessionCookies cache and retrieve cookies", () => {
      setElscioneSessionCookies("custom_token=secret_val; Path=/; HttpOnly");
      expect(getElscioneSessionCookies()).toContain("custom_token=secret_val");
    });

    it("solveAnubisChallenge aborts when signal is already aborted", async () => {
      const controller = new AbortController();
      controller.abort();
      const challenge: AnubisChallenge = {
        id: "ch_abort",
        difficulty: 6,
        randomData: "seed",
      };
      await expect(
        solveAnubisChallenge(challenge, controller.signal),
      ).rejects.toThrow(/aborted/i);
    });

    it("submitAnubisSolution submits pass-challenge and captures session cookies", async () => {
      let passUrlRequested = "";
      const mockFetch = async (url: string) => {
        passUrlRequested = url;
        return new Response("OK", {
          status: 200,
          headers: new Headers({
            "set-cookie": "PHPSESSID=sess_123; anubis-auth=auth_token_456; download_token=dl_789",
          }),
        });
      };

      const solution = {
        id: "ch_test",
        hash: "0000abc123",
        nonce: 42,
        elapsedTime: 15,
      };

      const passResult = await submitAnubisSolution(
        "https://server.elscione.com/folder/",
        solution,
        "/folder/",
        { fetch: mockFetch as any },
      );
      expect(passResult.cookies).toContain("PHPSESSID=sess_123");

      expect(passUrlRequested).toContain("/.within.website/x/cmd/anubis/api/pass-challenge");
      expect(passUrlRequested).toContain("id=ch_test");
      expect(passUrlRequested).toContain("response=0000abc123");
      expect(passUrlRequested).toContain("nonce=42");
      expect(passUrlRequested).toContain("redir=%2Ffolder%2F");

      const cookies = getElscioneSessionCookies();
      expect(cookies).toContain("PHPSESSID=sess_123");
      expect(cookies).toContain("anubis-auth=auth_token_456");
      expect(cookies).toContain("download_token=dl_789");
    });

    it("fetchWithAnubis intercepts Anubis challenge, solves PoW, and retries with cookies", async () => {
      let fetchCount = 0;
      const mockFetch = async (url: string, init?: RequestInit) => {
        fetchCount++;
        if (url.includes("pass-challenge")) {
          return new Response("Passed", {
            status: 200,
            headers: new Headers({
              "set-cookie": "anubis-auth=solved_auth_cookie",
            }),
          });
        }

        // First attempt returns Anubis challenge HTML
        if (fetchCount === 1) {
          const challengeHtml = `
            <!DOCTYPE html>
            <html>
            <script id="anubis_challenge" type="application/json">
              {"id":"ch_live","difficulty":2,"randomData":"seed123"}
            </script>
            </html>
          `;
          return new Response(challengeHtml, {
            status: 403,
            headers: { "Content-Type": "text/html" },
          });
        }

        // Retry attempt verifies cookie was attached
        const cookie = (init?.headers as any)?.["Cookie"] || "";
        expect(cookie).toContain("anubis-auth=solved_auth_cookie");

        return new Response(JSON.stringify({ success: true, items: [] }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      };

      const res = await fetchWithAnubis(
        "https://server.elscione.com/Officially%20Translated%20Light%20Novels/Grimgar/",
        { method: "POST" },
        { fetch: mockFetch as any },
      );

      expect(res.status).toBe(200);
      const json = await res.json();
      expect(json.success).toBe(true);
      expect(fetchCount).toBe(3); // 1: initial 403, 2: pass-challenge, 3: retry with cookie
    });

    it("fetchWithAnubis never clones or buffers binary EPUB payloads on 200 OK", async () => {
      let cloneCalled = false;
      let textCalled = false;

      const mockBody = new ReadableStream({
        start(controller) {
          controller.enqueue(new Uint8Array([0x50, 0x4b, 0x03, 0x04]));
          controller.close();
        },
      });

      const mockResponse = new Response(mockBody, {
        status: 200,
        headers: {
          "Content-Type": "application/epub+zip",
          "Content-Length": "4",
        },
      });

      // Spy on clone and text
      const origClone = mockResponse.clone.bind(mockResponse);
      mockResponse.clone = () => {
        cloneCalled = true;
        return origClone();
      };
      mockResponse.text = async () => {
        textCalled = true;
        return "";
      };

      const mockFetch = async () => mockResponse;

      const res = await fetchWithAnubis(
        "https://server.elscione.com/download/book.epub",
        undefined,
        { fetch: mockFetch as any },
      );

      expect(res.status).toBe(200);
      expect(cloneCalled).toBe(false);
      expect(textCalled).toBe(false);
    });
  });

  describe("Folder & Manifest Extraction", () => {
    it("extractElscioneManifest handles direct .epub file URL", async () => {
      const manifest = await extractElscioneManifest(
        "https://server.elscione.com/Officially%20Translated%20Light%20Novels/Overlord/Overlord%20-%20Volume%2001.epub",
      );

      expect(manifest.isSingleVolume).toBe(true);
      expect(manifest.seriesTitle).toBe("Overlord");
      expect(manifest.volumes.length).toBe(1);
      expect(manifest.volumes[0].volumeNumber).toBe(1);
      expect(manifest.volumes[0].filename).toBe("Overlord - Volume 01.epub");
      expect(manifest.volumes[0].downloadUrl).toContain("Overlord%20-%20Volume%2001.epub");
    });

    it("extractElscioneManifest preserves partNumber on direct .epub file URL", async () => {
      const manifest = await extractElscioneManifest(
        "https://server.elscione.com/Officially%20Translated%20Light%20Novels/Ascendance%20of%20a%20Bookworm/Ascendance%20of%20a%20Bookworm%20-%20Part%202%20Volume%201.epub",
      );

      expect(manifest.isSingleVolume).toBe(true);
      expect(manifest.seriesTitle).toBe("Ascendance of a Bookworm");
      expect(manifest.volumes.length).toBe(1);
      expect(manifest.volumes[0].volumeNumber).toBe(1);
      expect(manifest.volumes[0].partNumber).toBe(2);
      expect(manifest.volumes[0].title).toBe("Ascendance of a Bookworm: Part 2 Volume 1");
    });

    it("extractElscioneManifest extracts and numerically sorts volumes from _h5ai directory API", async () => {
      const mockItems = [
        {
          href: "/Officially%20Translated%20Light%20Novels/Grimgar/Grimgar%20Volume%2010.epub",
          size: 15000000,
        },
        {
          href: "/Officially%20Translated%20Light%20Novels/Grimgar/Grimgar%20Volume%201.epub",
          size: 12000000,
        },
        {
          href: "/Officially%20Translated%20Light%20Novels/Grimgar/Grimgar%20Volume%202.epub",
          size: 13000000,
        },
        {
          href: "/Officially%20Translated%20Light%20Novels/Grimgar/other-file.pdf",
          size: 5000000,
        },
      ];

      const mockFetch = async (_url: string, init?: RequestInit) => {
        expect(init?.method).toBe("POST");
        const body = JSON.parse((init?.body as string) || "{}");
        expect(body.action).toBe("get");
        expect(body.items.what).toBe(1);

        return new Response(JSON.stringify({ items: mockItems }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      };

      const manifest = await extractElscioneManifest(
        "https://server.elscione.com/Officially%20Translated%20Light%20Novels/Grimgar/",
        { fetch: mockFetch as any },
      );

      expect(manifest.isSingleVolume).toBe(false);
      expect(manifest.seriesTitle).toBe("Grimgar");
      expect(manifest.volumes.length).toBe(3); // filtered out .pdf

      // Numerical order: Volume 1, Volume 2, Volume 10 (not lexicographical 1, 10, 2)
      expect(manifest.volumes[0].volumeNumber).toBe(1);
      expect(manifest.volumes[1].volumeNumber).toBe(2);
      expect(manifest.volumes[2].volumeNumber).toBe(10);
    });

    it("extractElscioneManifest handles _h5ai items object map format", async () => {
      const mockItemsMap = {
        item1: {
          href: "/Series/Book%20Volume%2001.epub",
          size: 10000000,
        },
        item2: {
          href: "/Series/Book%20Volume%2002.epub",
          size: 11000000,
        },
      };

      const mockFetch = async () => {
        return new Response(JSON.stringify({ items: mockItemsMap }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      };

      const manifest = await extractElscioneManifest(
        "https://server.elscione.com/Series/",
        { fetch: mockFetch as any },
      );

      expect(manifest.volumes.length).toBe(2);
      expect(manifest.volumes[0].volumeNumber).toBe(1);
      expect(manifest.volumes[1].volumeNumber).toBe(2);
    });

    it("extractElscioneManifest preserves Volume 0 and assigns non-colliding indices for unnumbered files", async () => {
      const mockItems = [
        { href: "/Series/Series%20Volume%200.epub", size: 1000 },
        { href: "/Series/Series%20Volume%201.epub", size: 1000 },
        { href: "/Series/Series%20Volume%202.epub", size: 1000 },
        { href: "/Series/Extra%20Story%20A.epub", size: 1000 },
        { href: "/Series/Extra%20Story%20B.epub", size: 1000 },
      ];

      const mockFetch = async () => {
        return new Response(JSON.stringify({ items: mockItems }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      };

      const manifest = await extractElscioneManifest(
        "https://server.elscione.com/Series/",
        { fetch: mockFetch as any },
      );

      expect(manifest.volumes.length).toBe(5);
      // Volume 0 is preserved as 0
      expect(manifest.volumes[0].volumeNumber).toBe(0);
      expect(manifest.volumes[1].volumeNumber).toBe(1);
      expect(manifest.volumes[2].volumeNumber).toBe(2);
      // Unnumbered extras are assigned maxNumbered+1, maxNumbered+2 without colliding
      expect(manifest.volumes[3].volumeNumber).toBe(3);
      expect(manifest.volumes[4].volumeNumber).toBe(4);
    });

    it("extractElscioneManifest truncates volumes to MAX_VOLUMES_PER_REQUEST = 50", async () => {
      const mockItems: any[] = [];
      for (let i = 1; i <= 60; i++) {
        mockItems.push({
          href: `/Series/Volume%20${i}.epub`,
          size: 1000,
        });
      }

      const mockFetch = async () => {
        return new Response(JSON.stringify({ items: mockItems }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      };

      const manifest = await extractElscioneManifest(
        "https://server.elscione.com/Series/",
        { fetch: mockFetch as any },
      );

      expect(manifest.volumes.length).toBe(50);
      expect(manifest.volumes[49].volumeNumber).toBe(50);
    });

    it("extractElscioneManifest throws if no EPUB files found in folder", async () => {
      const mockFetch = async () => {
        return new Response(
          JSON.stringify({
            items: [{ href: "/Series/readme.txt" }, { href: "/Series/cover.jpg" }],
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      };

      expect(
        extractElscioneManifest("https://server.elscione.com/Series/", {
          fetch: mockFetch as any,
        }),
      ).rejects.toThrow(/no epub volumes found/i);
    });

    it("extractElscioneManifest strictly scopes items to target folder and rejects sibling/parent folders", async () => {
      const mockH5aiResponse = {
        items: [
          // Sibling subseries folder items (must be excluded)
          {
            href: "/Officially%20Translated%20Light%20Novels/A%20Certain%20Magical%20Index%20NT/Index%20NT%20Vol%201.epub",
            size: 1000,
          },
          // Target series folder items
          {
            href: "/Officially%20Translated%20Light%20Novels/A%20Certain%20Magical%20Index/Index%20Vol%201.epub",
            size: 1000,
          },
          {
            href: "/Officially%20Translated%20Light%20Novels/A%20Certain%20Magical%20Index/Index%20Vol%202.epub",
            size: 2000,
          },
          // Parent folder non-epub
          { href: "/Officially%20Translated%20Light%20Novels/", size: 0 },
        ],
      };

      const mockFetch = async (_url: string, init?: any) => {
        if (init?.method === "POST") {
          return new Response(JSON.stringify(mockH5aiResponse), {
            status: 200,
            headers: { "Content-Type": "application/json" },
          });
        }
        return new Response("OK", { status: 200 });
      };

      const manifest = await extractElscioneManifest(
        "https://server.elscione.com/Officially%20Translated%20Light%20Novels/A%20Certain%20Magical%20Index/",
        { fetch: mockFetch as any },
      );

      expect(manifest.volumes.length).toBe(2);
      expect(manifest.volumes[0].filename).toBe("Index Vol 1.epub");
      expect(manifest.volumes[1].filename).toBe("Index Vol 2.epub");
      expect(
        manifest.volumes.some((v) => v.filename.includes("Index NT")),
      ).toBe(false);
    });

    it("extractElscioneManifest rejects scheme-absolute off-host hrefs and other-folder hrefs", async () => {
      const mockH5aiResponse = {
        items: [
          // Scheme-absolute off-host malware href (must be dropped)
          {
            href: "https://evil.example/malware.epub",
            size: 500,
          },
          // Protocol-relative off-host href (must be dropped)
          {
            href: "//evil.example/phishing.epub",
            size: 500,
          },
          // Scheme-absolute sibling series href (must be dropped)
          {
            href: "https://server.elscione.com/Officially%20Translated%20Light%20Novels/Other%20Series/Other.epub",
            size: 1500,
          },
          // Scheme-absolute mirror host sibling series href (must be dropped)
          {
            href: "https://server.elsci.one/Officially%20Translated%20Light%20Novels/Other%20Series/Other.epub",
            size: 1500,
          },
          // Root-relative sibling folder href (must be dropped)
          {
            href: "/Officially%20Translated%20Light%20Novels/Other%20Series/Secret.epub",
            size: 1200,
          },
          // Double-encoded path traversal attempt (must be dropped)
          {
            href: "/Officially%20Translated%20Light%20Novels/A%20Certain%20Magical%20Index/%252e%252e/Other%20Series/Bypass.epub",
            size: 1100,
          },
          // Backslash traversal attempt (must be dropped)
          {
            href: "/Officially%20Translated%20Light%20Novels/A%20Certain%20Magical%20Index/..\\Other%20Series\\BypassBackslash.epub",
            size: 1100,
          },
          // Encoded backslash traversal attempt (must be dropped)
          {
            href: "..%5c..%5cOther.epub",
            size: 1100,
          },
          // Valid in-folder root-relative EPUB (must be kept)
          {
            href: "/Officially%20Translated%20Light%20Novels/A%20Certain%20Magical%20Index/Index%20Vol%201.epub",
            size: 1000,
          },
          // Valid in-folder relative EPUB (must be kept)
          {
            href: "Index%20Vol%202.epub",
            size: 2000,
          },
          // Valid in-folder scheme-absolute same-folder EPUB (must be kept)
          {
            href: "https://server.elscione.com/Officially%20Translated%20Light%20Novels/A%20Certain%20Magical%20Index/Index%20Vol%203.epub",
            size: 3000,
          },
        ],
      };

      const mockFetch = async (_url: string, init?: any) => {
        if (init?.method === "POST") {
          return new Response(JSON.stringify(mockH5aiResponse), {
            status: 200,
            headers: { "Content-Type": "application/json" },
          });
        }
        return new Response("OK", { status: 200 });
      };

      const manifest = await extractElscioneManifest(
        "https://server.elscione.com/Officially%20Translated%20Light%20Novels/A%20Certain%20Magical%20Index/",
        { fetch: mockFetch as any },
      );

      expect(manifest.volumes.length).toBe(3);
      expect(manifest.volumes.map((v) => v.filename)).toEqual([
        "Index Vol 1.epub",
        "Index Vol 2.epub",
        "Index Vol 3.epub",
      ]);
      expect(manifest.volumes.some((v) => v.filename.includes("malware"))).toBe(false);
      expect(manifest.volumes.some((v) => v.filename.includes("phishing"))).toBe(false);
      expect(manifest.volumes.some((v) => v.filename.includes("Other"))).toBe(false);
      expect(manifest.volumes.some((v) => v.filename.includes("Secret"))).toBe(false);
      for (const vol of manifest.volumes) {
        expect(isElscioneUrl(vol.downloadUrl)).toBe(true);
        expect(vol.downloadUrl.includes("A%20Certain%20Magical%20Index")).toBe(true);
      }
    });
  });

  describe("Cover & Metadata Extraction", () => {
    it("extractAndConvertEpubCover extracts cover and uses sips for conversion", async () => {
      const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "elscione-test-"));
      const dummyEpub = path.join(tempDir, "dummy.epub");
      fs.writeFileSync(dummyEpub, "dummy epub content");

      let sipsCalledWith: string[] = [];

      const mockSpawnSync = (bin: string, args: string[]) => {
        if (bin === "bsdtar" || bin.includes("bsdtar")) {
          // container.xml query
          if (args.includes("META-INF/container.xml")) {
            return {
              status: 0,
              stdout: `<container><rootfiles><rootfile full-path="OEBPS/content.opf"/></rootfiles></container>`,
            };
          }
          // OPF query
          if (args.includes("OEBPS/content.opf")) {
            return {
              status: 0,
              stdout: `
                <package>
                  <manifest>
                    <item id="cover-img" href="images/cover.jpg" media-type="image/jpeg" properties="cover-image"/>
                  </manifest>
                </package>
              `,
            };
          }
          // Cover extraction query
          if (args.includes("OEBPS/images/cover.jpg")) {
            return {
              status: 0,
              stdout: Buffer.from("dummy image bytes"),
            };
          }
        }

        if (bin === "sips" || bin.includes("sips")) {
          sipsCalledWith = args;
          const outIdx = args.indexOf("--out");
          if (outIdx !== -1 && args[outIdx + 1]) {
            fs.writeFileSync(args[outIdx + 1], "converted cover bytes");
            return { status: 0, stdout: "converted" };
          }
        }

        return { status: 0, stdout: "" };
      };

      const result = await extractAndConvertEpubCover(dummyEpub, tempDir, {
        spawnSync: mockSpawnSync as any,
        sipsPath: "sips",
        bsdtarPath: "bsdtar",
      });

      expect(result).not.toBeNull();
      expect(fs.existsSync(result!)).toBe(true);
      expect(sipsCalledWith).toContain("-s");
      expect(sipsCalledWith).toContain("format");
      expect(sipsCalledWith).toContain("jpeg");

      fs.rmSync(tempDir, { recursive: true, force: true });
    });
  });

  describe("End-to-End Ingestion Flow", () => {
    it("ingestElscioneSeries orchestrates manifest, download, Calibre add, and metadata", async () => {
      const mockItems = [
        {
          href: "/Officially%20Translated%20Light%20Novels/DanMachi/DanMachi%20Volume%2001.epub",
          size: 1000000,
        },
        {
          href: "/Officially%20Translated%20Light%20Novels/DanMachi/DanMachi%20Volume%2002.epub",
          size: 1000000,
        },
      ];

      const progressEvents: ElscioneProgressEvent[] = [];
      const syntheticEpub = createSyntheticEpub();

      const mockFetch = async (_url: string, init?: RequestInit) => {
        // Manifest request
        if (init?.method === "POST") {
          return new Response(JSON.stringify({ items: mockItems }), {
            status: 200,
            headers: { "Content-Type": "application/json" },
          });
        }
        // EPUB download request
        return new Response(syntheticEpub, {
          status: 200,
          headers: {
            "Content-Type": "application/epub+zip",
            "Content-Length": String(syntheticEpub.length),
          },
        });
      };

      const calibreCommands: string[][] = [];
      const mockSpawnSync = (bin: string, args: string[]) => {
        if (bin === "calibredb" || bin.includes("calibredb")) {
          calibreCommands.push(args);
          if (args[0] === "add") {
            return { status: 0, stdout: "Added book ids: 42" };
          }
          if (args[0] === "set_metadata") {
            return { status: 0, stdout: "Metadata set" };
          }
        }
        if (bin === "bsdtar" || bin.includes("bsdtar")) {
          return { status: 0, stdout: "" };
        }
        return { status: 0, stdout: "" };
      };

      // Mock duplicate check: Vol 1 is new, Vol 2 already in Calibre
      const mockIsVolumeInLibrary = (_seriesTitle: string, volumeIndex: number) => {
        return volumeIndex === 2;
      };

      const result = await ingestElscioneSeries(
        "https://server.elscione.com/Officially%20Translated%20Light%20Novels/DanMachi/",
        (event) => {
          progressEvents.push(event);
        },
        {
          fetch: mockFetch as any,
          spawnSync: mockSpawnSync as any,
          isVolumeInLibrary: mockIsVolumeInLibrary,
        },
      );

      expect(result.success).toBe(true);
      expect(result.seriesTitle).toBe("DanMachi");
      expect(result.author).toBe("Fujino Omori");
      expect(result.totalCount).toBe(2);
      expect(result.importedCount).toBe(1);
      expect(result.skippedCount).toBe(1);
      expect(result.calibreBookIds).toEqual([42]);

      // Verify Calibre was called with add and set_metadata
      expect(calibreCommands.some((c) => c[0] === "add")).toBe(true);
      expect(
        calibreCommands.some((c) => c[0] === "set_metadata" && c.includes("series:DanMachi")),
      ).toBe(true);
      expect(
        calibreCommands.some((c) => c[0] === "set_metadata" && c.includes("authors:Fujino Omori")),
      ).toBe(true);

      // Verify progress events
      expect(progressEvents.some((e) => e.phase === "manifest")).toBe(true);
      expect(progressEvents.some((e) => e.phase === "volume" && e.data?.action === "skipped")).toBe(true);
      expect(progressEvents.some((e) => e.phase === "volume" && e.data?.action === "imported")).toBe(true);
      expect(progressEvents.some((e) => e.phase === "complete")).toBe(true);
    });

    it("formatElscioneProgress formats status strings accurately", () => {
      expect(
        formatElscioneProgress({
          phase: "manifest",
          total: 5,
          volumeTitle: "Grimgar",
        }),
      ).toContain("Found 5 volumes in series \"Grimgar\"");

      expect(
        formatElscioneProgress({
          phase: "volume",
          index: 2,
          total: 10,
          volumeTitle: "Volume 2",
        }),
      ).toContain("[Volume 2/10]");

      expect(
        formatElscioneProgress({
          phase: "complete",
          data: { importedCount: 3, skippedCount: 2 },
        }),
      ).toContain("Completed: 3 imported, 2 skipped");
    });

    it("falls back to fetchOnlineSynopsis and populates seriesCache across volumes when EPUB lacks description", async () => {
      const mockItems = [
        {
          href: "/Officially%20Translated%20Light%20Novels/DanMachi/DanMachi%20Volume%2001.epub",
          size: 1000000,
        },
        {
          href: "/Officially%20Translated%20Light%20Novels/DanMachi/DanMachi%20Volume%2002.epub",
          size: 1000000,
        },
      ];

      const syntheticEpub = createSyntheticEpub();

      const mockFetch = async (_url: string, init?: RequestInit) => {
        if (init?.method === "POST") {
          return new Response(JSON.stringify({ items: mockItems }), {
            status: 200,
            headers: { "Content-Type": "application/json" },
          });
        }
        return new Response(syntheticEpub, {
          status: 200,
          headers: {
            "Content-Type": "application/epub+zip",
            "Content-Length": String(syntheticEpub.length),
          },
        });
      };

      let bookIdCounter = 100;
      const calibreCommands: string[][] = [];
      const mockSpawnSync = (bin: string, args: string[]) => {
        if (bin === "calibredb" || bin.includes("calibredb")) {
          calibreCommands.push(args);
          if (args[0] === "add") {
            bookIdCounter++;
            return { status: 0, stdout: `Added book ids: ${bookIdCounter}` };
          }
          if (args[0] === "set_metadata") {
            return { status: 0, stdout: "Metadata set" };
          }
        }
        return { status: 0, stdout: "" };
      };

      const onlineCalls: any[] = [];
      const mockFetchOnlineSynopsis = async (book: any, options?: any) => {
        onlineCalls.push({ book, options });
        // Check seriesCache
        const seriesKey = (book.series || "").toLowerCase();
        if (options?.seriesCache?.has(seriesKey)) {
          const cached = options.seriesCache.get(seriesKey);
          return { description: cached.description, source: cached.source };
        }
        // First volume sets series overview in seriesCache
        const desc = `Synopsis for ${book.series}: ${book.title}`;
        if (options?.seriesCache) {
          options.seriesCache.set(seriesKey, { description: desc, source: "RanobeDB" });
        }
        return { description: desc, source: "RanobeDB" };
      };

      const result = await ingestElscioneSeries(
        "https://server.elscione.com/Officially%20Translated%20Light%20Novels/DanMachi/",
        undefined,
        {
          fetch: mockFetch as any,
          spawnSync: mockSpawnSync as any,
          fetchOnlineSynopsis: mockFetchOnlineSynopsis as any,
        },
      );

      expect(result.success).toBe(true);
      expect(result.importedCount).toBe(2);
      expect(onlineCalls.length).toBe(2);

      // Verify second volume had access to seriesCache populated by the first volume
      const call1SeriesCache = onlineCalls[0].options?.seriesCache;
      const call2SeriesCache = onlineCalls[1].options?.seriesCache;
      expect(call1SeriesCache).toBeDefined();
      expect(call2SeriesCache).toBe(call1SeriesCache);
      expect(call2SeriesCache.has("danmachi")).toBe(true);

      // Verify comments were set via set_metadata
      const commentsCommands = calibreCommands.filter(
        (c) => c[0] === "set_metadata" && c.some((arg) => arg.startsWith("comments:")),
      );
      expect(commentsCommands.length).toBe(2);
      expect(commentsCommands[0].find((arg) => arg.startsWith("comments:"))).toContain(
        "Synopsis for DanMachi: DanMachi: Volume 1",
      );
      expect(commentsCommands[1].find((arg) => arg.startsWith("comments:"))).toContain(
        "Synopsis for DanMachi: DanMachi: Volume 1",
      );
    });
  });

  describe("Server & Queue Integration", () => {
    it("areMatchingElscioneUrls compares folder paths and EPUB filenames", () => {
      const url1 =
        "https://server.elscione.com/Officially%20Translated%20Light%20Novels/Grimgar/";
      const url2 =
        "https://server.elscione.com/Officially%20Translated%20Light%20Novels/Grimgar";
      expect(areMatchingElscioneUrls(url1, url2)).toBe(true);

      const url3 =
        "https://server.elscione.com/Officially%20Translated%20Light%20Novels/Overlord/";
      expect(areMatchingElscioneUrls(url1, url3)).toBe(false);

      const epub1 =
        "https://server.elscione.com/Officially%20Translated%20Light%20Novels/Grimgar/Vol1.epub";
      const epub2 =
        "https://server.elscione.com/Officially%20Translated%20Light%20Novels/Grimgar/Vol1.epub";
      const epub3 =
        "https://server.elscione.com/Officially%20Translated%20Light%20Novels/Grimgar/Vol2.epub";
      expect(areMatchingElscioneUrls(epub1, epub2)).toBe(true);
      expect(areMatchingElscioneUrls(epub1, epub3)).toBe(false);

      // Mixed folder vs EPUB volume must NOT match!
      expect(areMatchingElscioneUrls(url1, epub1)).toBe(false);
      expect(areMatchingElscioneUrls(epub1, url1)).toBe(false);

      // Space-containing raw URL matches already-encoded URL
      const rawSpaceUrl =
        "https://server.elscione.com/Officially Translated Light Novels/Grimgar/";
      expect(areMatchingElscioneUrls(rawSpaceUrl, url1)).toBe(true);

      // URL with raw single quote matches URL with encoded %27
      const rawQuoteUrl =
        "https://server.elscione.com/Officially Translated Light Novels/A Sister's All You Need/";
      const encodedQuoteUrl =
        "https://server.elscione.com/Officially%20Translated%20Light%20Novels/A%20Sister%27s%20All%20You%20Need/";
      expect(areMatchingElscioneUrls(rawQuoteUrl, encodedQuoteUrl)).toBe(true);

      // Missing protocol prefix matches full https URL
      const noProtoUrl =
        "server.elscione.com/Officially Translated Light Novels/Grimgar/";
      expect(areMatchingElscioneUrls(noProtoUrl, url1)).toBe(true);

      // Malformed % sequence does not throw URIError
      const malformedUrl1 = "https://server.elscione.com/folder%invalid/";
      const malformedUrl2 = "https://server.elscione.com/folder%invalid/";
      expect(areMatchingElscioneUrls(malformedUrl1, malformedUrl2)).toBe(true);
      expect(areMatchingElscioneUrls(malformedUrl1, url1)).toBe(false);
    });

    it("areMatchingNovelUrls routes across Elscione and Lnori", () => {
      const el1 =
        "https://server.elscione.com/Officially%20Translated%20Light%20Novels/Grimgar/";
      const el2 =
        "https://server.elscione.com/Officially%20Translated%20Light%20Novels/Grimgar/";
      const ln1 = "https://lnori.com/series/8046/title";
      const ln2 = "https://lnori.com/series/8046";

      expect(areMatchingNovelUrls(el1, el2)).toBe(true);
      expect(areMatchingNovelUrls(ln1, ln2)).toBe(true);
      expect(areMatchingNovelUrls(el1, ln1)).toBe(false);
      expect(areMatchingLnoriUrls(ln1, ln2)).toBe(true);
    });

    it("downloadElscioneEpub downloads and validates EPUB to file", async () => {
      const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "elscione-dl-"));
      const destPath = path.join(tempDir, "downloaded.epub");
      const syntheticEpub = createSyntheticEpub();

      const mockFetch = async () => {
        return new Response(syntheticEpub, {
          status: 200,
          headers: {
            "Content-Type": "application/epub+zip",
            "Content-Length": String(syntheticEpub.length),
          },
        });
      };

      await downloadElscioneEpub(
        "https://server.elscione.com/file.epub",
        destPath,
        undefined,
        { fetch: mockFetch as any },
      );

      expect(fs.existsSync(destPath)).toBe(true);
      fs.rmSync(tempDir, { recursive: true, force: true });
    });

    it("downloadElscioneEpub rejects off-host URLs and never attaches cookies to off-host requests", async () => {
      const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "elscione-sec-dl-"));
      const destPath = path.join(tempDir, "malware.epub");
      setElscioneSessionCookies("anubis-auth=secret_token_12345");

      let receivedHeaders: Record<string, string> = {};
      const mockFetch = async (_url: string, init?: RequestInit) => {
        receivedHeaders = (init?.headers || {}) as Record<string, string>;
        return new Response(createSyntheticEpub(), {
          status: 200,
          headers: { "Content-Type": "application/epub+zip" },
        });
      };

      // 1. Direct downloadElscioneEpub with off-host URL must throw and not fetch
      await expect(
        downloadElscioneEpub(
          "https://evil.example/malware.epub",
          destPath,
          undefined,
          { fetch: mockFetch as any },
        ),
      ).rejects.toThrow(/non-Elscione host/i);

      // 2. Direct fetchWithAnubis on off-host URL must never attach Elscione Cookie header
      await fetchWithAnubis("https://evil.example/info.json", {}, { fetch: mockFetch as any });
      expect(receivedHeaders["Cookie"]).toBeUndefined();

      // 3. fetchWithAnubis on valid Elscione URL attaches the Cookie header
      await fetchWithAnubis("https://server.elscione.com/test.json", {}, { fetch: mockFetch as any });
      expect(receivedHeaders["Cookie"]).toBe("anubis-auth=secret_token_12345");

      // 4. fetchWithAnubis following redirect to off-host target must be refused and not leak cookies
      const redirectFetch = async (url: string, init?: RequestInit) => {
        receivedHeaders = (init?.headers || {}) as Record<string, string>;
        if (url === "https://server.elscione.com/redirect-to-evil") {
          return new Response("", {
            status: 302,
            headers: { Location: "https://evil.example/intercepted" },
          });
        }
        return new Response("OK", { status: 200 });
      };
      await expect(
        fetchWithAnubis(
          "https://server.elscione.com/redirect-to-evil",
          {},
          { fetch: redirectFetch as any },
        ),
      ).rejects.toThrow(/off-host target/i);

      // 5. fetchWithAnubis on off-host challenge response must never submit solution with Elscione cookies
      let passChallengeHeaders: Record<string, string> = {};
      const evilChallengeFetch = async (url: string, init?: RequestInit) => {
        if (url.includes("pass-challenge")) {
          passChallengeHeaders = (init?.headers || {}) as Record<string, string>;
          return new Response("OK", { status: 200 });
        }
        const challengeHtml = `
          <!DOCTYPE html>
          <html>
          <script id="anubis_challenge" type="application/json">
            {"id":"ch_evil","difficulty":0,"randomData":"seed"}
          </script>
          </html>
        `;
        return new Response(challengeHtml, {
          status: 403,
          headers: { "Content-Type": "text/html" },
        });
      };
      await fetchWithAnubis(
        "https://evil.example/challenge",
        {},
        { fetch: evilChallengeFetch as any },
      );
      expect(passChallengeHeaders["Cookie"]).toBeUndefined();

      resetElscioneSessionForTest();
      fs.rmSync(tempDir, { recursive: true, force: true });
    });
  });

  describe("Elscione Python Helper CLI Integration", () => {
    it("getElscioneHelperPath resolves existing helper script", () => {
      const helperPath = getElscioneHelperPath();
      expect(fs.existsSync(helperPath)).toBe(true);
      expect(getPythonPath()).toBeDefined();
    });

    it("runElscioneHelperManifest executes helper for direct epub URL", async () => {
      const manifest = await runElscioneHelperManifest(
        "https://server.elscione.com/Officially%20Translated%20Light%20Novels/Overlord/Overlord%20-%20Volume%2004.epub",
      );
      expect(manifest.isSingleVolume).toBe(true);
      expect(manifest.totalCount).toBe(1);
      expect(manifest.volumes[0].volumeNumber).toBe(4);
      expect(manifest.volumes[0].filename).toBe("Overlord - Volume 04.epub");
    });

    it("runElscioneHelperManifest parses mocked spawnSync output", async () => {
      const mockSpawnSync = () => ({
        status: 0,
        stdout: JSON.stringify({
          success: true,
          seriesTitle: "Test Series",
          url: "https://server.elscione.com/Test%20Series/",
          isSingleVolume: false,
          totalCount: 1,
          volumes: [
            {
              volumeNumber: 1,
              filename: "Test - Volume 01.epub",
              downloadUrl:
                "https://server.elscione.com/Test%20Series/Test%20-%20Volume%2001.epub",
              title: "Test Series: Volume 1",
            },
          ],
        }),
        stderr: "",
      });

      const manifest = await runElscioneHelperManifest(
        "https://server.elscione.com/Test%20Series/",
        { spawnSync: mockSpawnSync as any },
      );
      expect(manifest.seriesTitle).toBe("Test Series");
      expect(manifest.volumes.length).toBe(1);
      expect(manifest.volumes[0].volumeNumber).toBe(1);
    });

    it("runElscioneHelperManifest drops off-host items returned by helper", async () => {
      const mockSpawnSync = () => ({
        status: 0,
        stdout: JSON.stringify({
          success: true,
          seriesTitle: "Test Series",
          url: "https://server.elscione.com/Test%20Series/",
          isSingleVolume: false,
          totalCount: 2,
          volumes: [
            {
              volumeNumber: 1,
              filename: "Test - Volume 01.epub",
              downloadUrl:
                "https://server.elscione.com/Test%20Series/Test%20-%20Volume%2001.epub",
              title: "Test Series: Volume 1",
            },
            {
              volumeNumber: 2,
              filename: "malware.epub",
              downloadUrl: "https://evil.example/malware.epub",
              title: "Malware",
            },
          ],
        }),
        stderr: "",
      });

      const manifest = await runElscioneHelperManifest(
        "https://server.elscione.com/Test%20Series/",
        { spawnSync: mockSpawnSync as any },
      );
      expect(manifest.volumes.length).toBe(1);
      expect(manifest.volumes[0].filename).toBe("Test - Volume 01.epub");
      expect(manifest.volumes.some((v) => v.downloadUrl.includes("evil.example"))).toBe(false);
      expect(manifest.totalCount).toBe(1);
    });

    it("runElscioneHelperManifest drops other-folder items returned by helper", async () => {
      const mockSpawnSync = () => ({
        status: 0,
        stdout: JSON.stringify({
          success: true,
          seriesTitle: "Test Series",
          url: "https://server.elscione.com/Test%20Series/",
          isSingleVolume: false,
          totalCount: 2,
          volumes: [
            {
              volumeNumber: 1,
              filename: "Test - Volume 01.epub",
              downloadUrl:
                "https://server.elscione.com/Test%20Series/Test%20-%20Volume%2001.epub",
              title: "Test Series: Volume 1",
            },
            {
              volumeNumber: 2,
              filename: "Other.epub",
              downloadUrl:
                "https://server.elscione.com/Other%20Series/Other.epub",
              title: "Other",
            },
          ],
        }),
        stderr: "",
      });

      const manifest = await runElscioneHelperManifest(
        "https://server.elscione.com/Test%20Series/",
        { spawnSync: mockSpawnSync as any },
      );
      expect(manifest.volumes.length).toBe(1);
      expect(manifest.volumes[0].filename).toBe("Test - Volume 01.epub");
      expect(manifest.volumes.some((v) => v.downloadUrl.includes("Other%20Series"))).toBe(false);
      expect(manifest.totalCount).toBe(1);
    });

    it("runElscioneHelperManifest throws on non-zero exit or invalid JSON", async () => {
      const mockFail = () => ({
        status: 1,
        stdout: "",
        stderr: "Failed to connect",
      });
      expect(
        runElscioneHelperManifest("https://server.elscione.com/test", {
          spawnSync: mockFail as any,
        }),
      ).rejects.toThrow("Elscione helper manifest exited with status 1");

      const mockBadJson = () => ({
        status: 0,
        stdout: "not-json",
        stderr: "",
      });
      expect(
        runElscioneHelperManifest("https://server.elscione.com/test", {
          spawnSync: mockBadJson as any,
        }),
      ).rejects.toThrow("Failed to parse Elscione helper JSON");
    });

    it("runElscioneHelperDownload reports progress and creates validated file", async () => {
      const tempDir = fs.mkdtempSync(
        path.join(os.tmpdir(), "elscione-dl-helper-"),
      );
      const destPath = path.join(tempDir, "test.epub");
      const syntheticEpub = createSyntheticEpub();

      const mockSpawn = (_bin: string, args: string[]) => {
        const dest = args[args.length - 1];
        fs.writeFileSync(dest, syntheticEpub);

        const stdout = new PassThrough();
        const stderr = new PassThrough();

        const listeners: Record<string, Function[]> = {};
        const proc: any = {
          stdout,
          stderr,
          on: (event: string, cb: Function) => {
            if (!listeners[event]) listeners[event] = [];
            listeners[event].push(cb);
            if (event === "close") {
              setTimeout(() => {
                stdout.write(
                  "PROGRESS: 50.0% (500/1000)\nPROGRESS: 100.0% (1000/1000)\n",
                );
                stdout.end();
                setTimeout(() => cb(0), 10);
              }, 10);
            }
          },
        };
        return proc;
      };

      const progressEvents: number[] = [];
      await runElscioneHelperDownload(
        "https://server.elscione.com/book.epub",
        destPath,
        (pct) => progressEvents.push(pct),
        { spawn: mockSpawn as any },
      );

      expect(fs.existsSync(destPath)).toBe(true);
      expect(progressEvents.length).toBeGreaterThan(0);
      expect(progressEvents).toContain(100);
      fs.rmSync(tempDir, { recursive: true, force: true });
    });

    it("downloadElscioneEpub retries via helper on transient failure and succeeds", async () => {
      const tempDir = fs.mkdtempSync(
        path.join(os.tmpdir(), "elscione-dl-retry-"),
      );
      const destPath = path.join(tempDir, "retry-test.epub");
      const syntheticEpub = createSyntheticEpub();

      let attempts = 0;
      const mockSpawn = (_bin: string, args: string[]) => {
        attempts++;
        const dest = args[args.length - 1];
        const stdout = new PassThrough();
        const stderr = new PassThrough();

        const listeners: Record<string, Function[]> = {};
        const proc: any = {
          stdout,
          stderr,
          on: (event: string, cb: Function) => {
            if (!listeners[event]) listeners[event] = [];
            listeners[event].push(cb);
            if (event === "close") {
              setTimeout(() => {
                if (attempts < 2) {
                  stderr.write("curl: (28) Operation timed out");
                  stdout.end();
                  stderr.end();
                  setTimeout(() => cb(1), 5);
                } else {
                  fs.writeFileSync(dest, syntheticEpub);
                  stdout.write("PROGRESS: 100.0% (1000/1000)\n");
                  stdout.end();
                  stderr.end();
                  setTimeout(() => cb(0), 5);
                }
              }, 5);
            }
          },
        };
        return proc;
      };

      await downloadElscioneEpub(
        "https://server.elscione.com/retry-book.epub",
        destPath,
        undefined,
        {
          spawn: mockSpawn as any,
          sleep: async () => {},
        },
      );

      expect(attempts).toBe(2);
      expect(fs.existsSync(destPath)).toBe(true);
      fs.rmSync(tempDir, { recursive: true, force: true });
    });

    it("ingestElscioneSeries continues to next volume when one volume download fails", async () => {
      const mockItems = [
        {
          href: "/Officially%20Translated%20Light%20Novels/Sister/Sister%20Volume%2007.epub",
          size: 1000000,
        },
        {
          href: "/Officially%20Translated%20Light%20Novels/Sister/Sister%20Volume%2008.epub",
          size: 1000000,
        },
      ];

      const progressEvents: ElscioneProgressEvent[] = [];
      const syntheticEpub = createSyntheticEpub();

      const mockFetch = async (_url: string, init?: RequestInit) => {
        // Manifest request
        if (init?.method === "POST") {
          return new Response(JSON.stringify({ items: mockItems }), {
            status: 200,
            headers: { "Content-Type": "application/json" },
          });
        }
        // Vol 7 fails with 403 / timeout, Vol 8 succeeds
        if (_url.includes("Volume%2007") || _url.includes("Volume 07")) {
          return new Response("Forbidden", { status: 403 });
        }
        return new Response(syntheticEpub, {
          status: 200,
          headers: {
            "Content-Type": "application/epub+zip",
            "Content-Length": String(syntheticEpub.length),
          },
        });
      };

      const calibreCommands: string[][] = [];
      const mockSpawnSync = (bin: string, args: string[]) => {
        if (bin === "calibredb" || bin.includes("calibredb")) {
          calibreCommands.push(args);
          if (args[0] === "add") {
            return { status: 0, stdout: "Added book ids: 77" };
          }
          if (args[0] === "set_metadata") {
            return { status: 0, stdout: "Metadata set" };
          }
        }
        return { status: 0, stdout: "" };
      };

      const result = await ingestElscioneSeries(
        "https://server.elscione.com/Officially%20Translated%20Light%20Novels/Sister/",
        (event) => {
          progressEvents.push(event);
        },
        {
          fetch: mockFetch as any,
          spawnSync: mockSpawnSync as any,
          isVolumeInLibrary: () => false,
          sleep: async () => {},
        },
      );

      // Series ingestion succeeded partially (1 imported, 1 skipped) without throwing or crashing
      expect(result.success).toBe(true);
      expect(result.totalCount).toBe(2);
      expect(result.importedCount).toBe(1);
      expect(result.skippedCount).toBe(1);
      expect(result.calibreBookIds).toEqual([77]);

      // Progress reported warning for volume 7
      const skippedWarning = progressEvents.find(
        (e) => e.phase === "volume" && e.data?.action === "skipped" && e.data?.reason === "download_error",
      );
      expect(skippedWarning).toBeDefined();
      expect(skippedWarning?.status).toContain("Skipped volume due to download error");

      // Progress reported import for volume 8
      const importedVol = progressEvents.find(
        (e) => e.phase === "volume" && e.data?.action === "imported" && e.data?.calibreId === 77,
      );
      expect(importedVol).toBeDefined();
    });

    it("downloadElscioneEpub fails when helper exhausted and never falls back to in-process fetch", async () => {
      const tempDir = fs.mkdtempSync(
        path.join(os.tmpdir(), "elscione-dl-no-fallback-"),
      );
      const destPath = path.join(tempDir, "fail.epub");

      const mockSpawn = () => {
        const stdout = new PassThrough();
        const stderr = new PassThrough();

        const listeners: Record<string, Function[]> = {};
        const proc: any = {
          stdout,
          stderr,
          on: (event: string, cb: Function) => {
            if (!listeners[event]) listeners[event] = [];
            listeners[event].push(cb);
            if (event === "close") {
              setTimeout(() => {
                stderr.write("Cloudflare challenge / TLS block");
                stdout.end();
                stderr.end();
                setTimeout(() => cb(1), 5);
              }, 5);
            }
          },
        };
        return proc;
      };

      let fetchCalled = false;
      const forbiddenFetch = async () => {
        fetchCalled = true;
        throw new Error("fetch should not be called when helper is used");
      };

      await expect(
        downloadElscioneEpub(
          "https://server.elscione.com/fail-book.epub",
          destPath,
          undefined,
          {
            spawn: mockSpawn as any,
            fetch: forbiddenFetch as any, // Even if passed, useHelper=true forces helper path
            useHelper: true,
            sleep: async () => {},
          },
        ),
      ).rejects.toThrow("Cloudflare challenge / TLS block");

      expect(fetchCalled).toBe(false);
      fs.rmSync(tempDir, { recursive: true, force: true });
    });

    it("downloadElscioneEpub does not retry a permanent 4xx and honours Retry-After on 429", async () => {
      const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "elscione-dl-permanent-"));
      const notFoundPath = path.join(tempDir, "not-found.epub");
      const throttledPath = path.join(tempDir, "throttled.epub");

      // 1. A 404 answers the same way every time: one attempt, no retry budget burned.
      let notFoundCalls = 0;
      await expect(
        downloadElscioneEpub(
          "https://server.elscione.com/missing-book.epub",
          notFoundPath,
          undefined,
          {
            sleep: async () => {},
            fetch: (async () => {
              notFoundCalls++;
              return new Response("Not Found", { status: 404 });
            }) as any,
          },
        ),
      ).rejects.toThrow(/Failed to download EPUB \(404\)/);
      expect(notFoundCalls).toBe(1);

      // 2. A 429 states when to come back, so the backoff follows the header, not 1s/2s/4s.
      let throttledCalls = 0;
      const sleeps: number[] = [];
      await expect(
        downloadElscioneEpub(
          "https://server.elscione.com/throttled-book.epub",
          throttledPath,
          undefined,
          {
            sleep: async (ms: number) => {
              sleeps.push(ms);
            },
            fetch: (async () => {
              throttledCalls++;
              return new Response("slow down", {
                status: 429,
                headers: { "retry-after": "5" },
              });
            }) as any,
          },
        ),
      ).rejects.toThrow(/Failed to download EPUB \(429\)/);
      expect(throttledCalls).toBeGreaterThan(1);
      expect(sleeps.length).toBeGreaterThan(0);
      expect(sleeps.every((ms) => ms === 5000)).toBe(true);
      expect(sleeps).not.toContain(1000);

      fs.rmSync(tempDir, { recursive: true, force: true });
    });

    it("ingestElscioneSeries returns success: false when all volumes fail to download", async () => {
      const mockItems = [
        {
          href: "/Officially%20Translated%20Light%20Novels/Sister/Sister%20Volume%2007.epub",
          size: 1000000,
        },
      ];

      const mockFetch = async (_url: string, init?: RequestInit) => {
        if (init?.method === "POST") {
          return new Response(JSON.stringify({ items: mockItems }), {
            status: 200,
            headers: { "Content-Type": "application/json" },
          });
        }
        return new Response("Forbidden", { status: 403 });
      };

      const result = await ingestElscioneSeries(
        "https://server.elscione.com/Officially%20Translated%20Light%20Novels/Sister/",
        undefined,
        {
          fetch: mockFetch as any,
          isVolumeInLibrary: () => false,
          sleep: async () => {},
        },
      );

      expect(result.success).toBe(false);
      expect(result.importedCount).toBe(0);
      expect(result.skippedCount).toBe(1);
      expect(result.duplicateCount).toBe(0);
    });

    it("ingestElscioneSeries continues to next volume when Calibre add fails (import_error)", async () => {
      const mockItems = [
        {
          href: "/Officially%20Translated%20Light%20Novels/Sister/Sister%20Volume%2001.epub",
          size: 1000000,
        },
        {
          href: "/Officially%20Translated%20Light%20Novels/Sister/Sister%20Volume%2002.epub",
          size: 1000000,
        },
      ];

      const syntheticEpub = createSyntheticEpub();
      const mockFetch = async (_url: string, init?: RequestInit) => {
        if (init?.method === "POST") {
          return new Response(JSON.stringify({ items: mockItems }), {
            status: 200,
            headers: { "Content-Type": "application/json" },
          });
        }
        return new Response(syntheticEpub, {
          status: 200,
          headers: {
            "Content-Type": "application/epub+zip",
            "Content-Length": String(syntheticEpub.length),
          },
        });
      };

      let addAttempts = 0;
      const mockSpawnSync = (bin: string, args: string[]) => {
        if (bin === "calibredb" || bin.includes("calibredb")) {
          if (args[0] === "add") {
            addAttempts++;
            if (addAttempts === 1) {
              return { status: 1, stdout: "", stderr: "Database locked" };
            }
            return { status: 0, stdout: "Added book ids: 99" };
          }
          if (args[0] === "set_metadata") {
            return { status: 0, stdout: "Metadata set" };
          }
        }
        return { status: 0, stdout: "" };
      };

      const result = await ingestElscioneSeries(
        "https://server.elscione.com/Officially%20Translated%20Light%20Novels/Sister/",
        undefined,
        {
          fetch: mockFetch as any,
          spawnSync: mockSpawnSync as any,
          isVolumeInLibrary: () => false,
          sleep: async () => {},
        },
      );

      expect(result.success).toBe(true);
      expect(result.totalCount).toBe(2);
      expect(result.importedCount).toBe(1);
      expect(result.skippedCount).toBe(1);
      expect(result.duplicateCount).toBe(0);
      expect(result.calibreBookIds).toEqual([99]);
    });
  });

  describe("Python interpreter capability selection", () => {
    beforeEach(() => {
      resetElscionePythonCacheForTest();
    });

    it("skips an interpreter whose curl_cffi import fails and selects one that succeeds", () => {
      const probed: string[] = [];
      const chosen = getPythonPath({
        pythonProbe: (candidate: string) => {
          probed.push(candidate);
          // The first existing candidate on this host is Homebrew python3, which lacks curl_cffi.
          return candidate === "/usr/local/bin/python3";
        },
      });

      expect(chosen).toBe("/usr/local/bin/python3");
      expect(probed).toContain("/opt/homebrew/bin/python3");
      expect(probed.indexOf("/opt/homebrew/bin/python3")).toBeLessThan(
        probed.indexOf("/usr/local/bin/python3"),
      );
    });

    it("treats a probe that throws as an incapable interpreter instead of crashing", () => {
      const chosen = getPythonPath({
        pythonProbe: (candidate: string) => {
          if (candidate === "/opt/homebrew/bin/python3.14") throw new Error("probe exploded");
          return candidate === "python3";
        },
      });
      expect(chosen).toBe("python3");
    });

    it("honours an explicit pythonPath verbatim without probing", () => {
      let probes = 0;
      const chosen = getPythonPath({
        pythonPath: "/custom/bin/python3.99",
        pythonProbe: () => {
          probes++;
          return false;
        },
      });
      expect(chosen).toBe("/custom/bin/python3.99");
      expect(probes).toBe(0);
    });

    it("lists the explicit env override first and includes remaining Homebrew minors", () => {
      const candidates = listPythonCandidates({ ELSCIONE_PYTHON_PATH: "/env/python3" } as any);
      expect(candidates[0]).toBe("/env/python3");
      expect(new Set(candidates).size).toBe(candidates.length);
    });

    it("surfaces the missing curl_cffi dependency when no interpreter has it", () => {
      expect(() => getPythonPath({ pythonProbe: () => false })).toThrow(/curl_cffi/i);
      let caught: any;
      try {
        getPythonPath({ pythonProbe: () => false });
      } catch (err) {
        caught = err;
      }
      expect(caught?.code).toBe(ELSCIONE_PYTHON_DEPENDENCY_CODE);
      expect(isElscioneDependencyError(caught)).toBe(true);
      expect(String(caught?.message)).toContain("pip3 install curl_cffi");
      expect(String(caught?.message)).toContain(ELSCIONE_PYTHON_DEPENDENCY_MESSAGE.slice(0, 30));
    });

    it("maps a helper exit-1 curl_cffi failure to the dependency error, not a network error", async () => {
      const mockSpawnSync = () => ({
        status: 1,
        stdout: "",
        stderr:
          "Error: curl_cffi is required for Elscione network operations. Install with 'pip3 install curl_cffi'.\n",
      });

      let caught: any;
      try {
        await runElscioneHelperManifest("https://server.elscione.com/Test%20Series/", {
          pythonPath: "python3",
          spawnSync: mockSpawnSync as any,
        });
      } catch (err: any) {
        caught = err;
      }

      expect(caught).toBeDefined();
      expect(caught.code).toBe(ELSCIONE_PYTHON_DEPENDENCY_CODE);
      // A dependency fault must never be reported as the reader's connection being down.
      expect(String(caught.message)).not.toMatch(/failed to fetch|network error/i);
    });

    it("does not silently fall back to the in-process fetch when the dependency is missing", async () => {
      // No fetch mock is injected: if the code fell through to the in-process path it would either
      // hit the real network or fail with a transport error. It must do neither.
      let caught: any;
      try {
        await extractElscioneManifest(
          "https://server.elscione.com/Officially%20Translated%20Light%20Novels/Mushoku%20Tensei/",
          { pythonProbe: () => false },
        );
      } catch (err: any) {
        caught = err;
      }
      expect(caught).toBeDefined();
      expect(isElscioneDependencyError(caught)).toBe(true);
      expect(caught.code).toBe(ELSCIONE_PYTHON_DEPENDENCY_CODE);
      expect(String(caught.message)).toContain("pip3 install curl_cffi");
    });
  });

  describe("Browser-shaped requests and blocked-source outcomes", () => {
    beforeEach(() => {
      resetElscioneSessionForTest();
      resetElscioneProxyHealthCacheForTest();
    });

    it("browserRequestHeaders carries the same-origin fetch headers the source requires", () => {
      const headers = browserRequestHeaders("https://server.elscione.com/a/b/");
      expect(headers["Accept-Language"]).toBe("en-US,en;q=0.9");
      expect(headers["Sec-Fetch-Mode"]).toBe("cors");
      expect(headers["Sec-Fetch-Site"]).toBe("same-origin");
      expect(headers["Sec-Fetch-Dest"]).toBe("empty");
      expect(headers["Referer"]).toBe("https://server.elscione.com/a/b/");
      expect(headers["Origin"]).toBe("https://server.elscione.com");
    });

    it("the manifest POST sends browser-shaped headers including Accept-Language", async () => {
      let sentHeaders: Record<string, string> = {};
      let sentMethod = "";
      const mockFetch = async (_url: string, init?: RequestInit) => {
        sentMethod = String(init?.method || "GET");
        sentHeaders = (init?.headers || {}) as Record<string, string>;
        return new Response(
          JSON.stringify({
            items: [
              {
                href: "https://server.elscione.com/Officially%20Translated%20Light%20Novels/Mushoku%20Tensei/Mushoku%20Tensei%20-%20Volume%2001.epub",
              },
            ],
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      };

      const manifest = await extractElscioneManifest(
        "https://server.elscione.com/Officially%20Translated%20Light%20Novels/Mushoku%20Tensei/",
        { fetch: mockFetch as any, useHelper: false },
      );

      expect(sentMethod).toBe("POST");
      expect(sentHeaders["Accept-Language"]).toBe("en-US,en;q=0.9");
      expect(sentHeaders["Sec-Fetch-Mode"]).toBe("cors");
      expect(sentHeaders["Accept"]).toContain("application/json");
      expect(sentHeaders["Content-Type"]).toContain("application/json");
      expect(manifest.volumes.length).toBe(1);
    });

    it("a Cloudflare interstitial on pass-challenge fails closed as blocked and never loops", async () => {
      let fetches = 0;
      const mockFetch = async (url: string) => {
        fetches++;
        if (url.includes("pass-challenge")) {
          return new Response(
            "<html><head><title>Just a moment...</title></head><body>cf_chl_opt</body></html>",
            { status: 403, headers: { "Content-Type": "text/html" } },
          );
        }
        return new Response(
          `<html><script id="anubis_challenge" type="application/json">{"id":"ch_cf","difficulty":0,"randomData":"seed"}</script></html>`,
          { status: 403, headers: { "Content-Type": "text/html" } },
        );
      };

      let caught: any;
      try {
        await fetchWithAnubis(
          "https://server.elscione.com/Officially%20Translated%20Light%20Novels/Mushoku%20Tensei/",
          { method: "POST" },
          { fetch: mockFetch as any, proxyProbe: () => false },
        );
      } catch (err: any) {
        caught = err;
      }

      expect(caught).toBeDefined();
      expect(caught.code).toBe(ELSCIONE_BLOCKED_CODE);
      expect(isElscioneBlockedError(caught)).toBe(true);
      expect(String(caught.message)).toContain("browser only");
      expect(String(caught.message)).not.toMatch(/failed to fetch|check your connection/i);
      // initial request + one pass-challenge attempt, and no retry into the same wall
      expect(fetches).toBe(2);
    });

    it("a challenge that survives the solved cookie is reported as blocked, not retried", async () => {
      let fetches = 0;
      const challengeHtml =
        `<html><script id="anubis_challenge" type="application/json">{"id":"ch_loop","difficulty":0,"randomData":"seed"}</script></html>`;
      const mockFetch = async (url: string) => {
        fetches++;
        if (url.includes("pass-challenge")) {
          return new Response("Passed", { status: 200 });
        }
        return new Response(challengeHtml, {
          status: 403,
          headers: { "Content-Type": "text/html" },
        });
      };

      await expect(
        fetchWithAnubis(
          "https://server.elscione.com/Officially%20Translated%20Light%20Novels/Mushoku%20Tensei/",
          { method: "POST" },
          { fetch: mockFetch as any, proxyProbe: () => false },
        ),
      ).rejects.toThrow(/blocked the automated request/i);

      expect(fetches).toBe(3);
    });

    it("a non-JSON challenge body becomes a blocked error instead of an unverified source", async () => {
      const mockFetch = async (url: string) => {
        if (url.includes("pass-challenge")) {
          return new Response("Passed", { status: 200 });
        }
        return new Response(
          "<html><head><title>Attention Required! | Cloudflare</title></head></html>",
          { status: 403, headers: { "Content-Type": "text/html" } },
        );
      };

      await expect(
        extractElscioneManifest(
          "https://server.elscione.com/Officially%20Translated%20Light%20Novels/Mushoku%20Tensei/",
          { fetch: mockFetch as any, useHelper: false, proxyProbe: () => false },
        ),
      ).rejects.toThrow(/blocked the automated request/i);
    });

    it("isCloudflareInterstitial distinguishes a Cloudflare wall from an Anubis challenge", () => {
      expect(isCloudflareInterstitial("<title>Just a moment...</title>")).toBe(true);
      expect(isCloudflareInterstitial("Attention Required! | Cloudflare")).toBe(true);
      expect(
        isCloudflareInterstitial(
          `<script id="anubis_challenge" type="application/json">{"id":"ch","difficulty":4}</script>`,
        ),
      ).toBe(false);
      expect(isCloudflareInterstitial("{\"items\":[]}")).toBe(false);
    });
  });

  describe("Proxy fallback discipline", () => {
    beforeEach(() => {
      resetElscioneSessionForTest();
      resetElscioneProxyHealthCacheForTest();
    });

    it("a dead local proxy never turns a direct success into a failure", async () => {
      let fetches = 0;
      const mockFetch = async () => {
        fetches++;
        return new Response(JSON.stringify({ ok: true }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      };

      const res = await fetchWithAnubis(
        "https://server.elscione.com/folder/",
        {},
        { fetch: mockFetch as any, proxyProbe: () => false },
      );

      expect(res.status).toBe(200);
      expect(fetches).toBe(1);
      expect(await isElscioneProxyUsable({ proxyProbe: () => false })).toBe(false);
    });

    it("skips the proxy entirely when it is unusable and reports both facts", async () => {
      let fetches = 0;
      const mockFetch = async () => {
        fetches++;
        throw new Error("connect ECONNREFUSED 45.139.226.179:443");
      };

      await expect(
        fetchWithAnubis(
          "https://server.elscione.com/folder/",
          {},
          { fetch: mockFetch as any, proxyProbe: () => false },
        ),
      ).rejects.toThrow(/local proxy is not usable/i);
      expect(fetches).toBe(1);
    });

    it("uses the proxy as a bounded fallback when it is actually healthy", async () => {
      let proxyFetches = 0;
      const mockFetch = async (_url: string, init?: any) => {
        if (init?.proxy) {
          proxyFetches++;
          expect(init.proxy).toBe("http://127.0.0.1:7890");
          return new Response(JSON.stringify({ ok: true }), {
            status: 200,
            headers: { "Content-Type": "application/json" },
          });
        }
        throw new Error("direct route refused");
      };

      const res = await fetchWithAnubis(
        "https://server.elscione.com/folder/",
        {},
        { fetch: mockFetch as any, proxyProbe: () => true },
      );
      expect(res.status).toBe(200);
      expect(proxyFetches).toBe(1);
    });
  });

  describe("Reader-facing error classification in index.html", () => {
    function loadClassifier(): (raw: any) => { kind: string; message: string } {
      const html = fs.readFileSync(path.join((import.meta as any).dir, "index.html"), "utf8");
      const fnMatch = html.match(/function classifyErrorCause\(raw\) \{([\s\S]*?)\n {4}\}/);
      expect(fnMatch).not.toBeNull();
      return new Function("raw", fnMatch![1]) as (raw: any) => { kind: string; message: string };
    }

    it("maps a missing dependency, a block, an HTTP status, and a real outage to four messages", () => {
      const classify = loadClassifier();

      const dependency = classify(
        "Elsci.one needs the Python curl_cffi package on the server, which is not installed. Install it with 'pip3 install curl_cffi' and retry.",
      );
      const blocked = classify(
        "Elscione source blocked the automated request; this source is verified via browser only.",
      );
      const http = classify("Failed to fetch directory manifest from Elscione (403): remote source");
      const offline = classify("error: Failed to fetch");

      expect(dependency.kind).toBe("dependency");
      expect(blocked.kind).toBe("blocked");
      expect(http.kind).toBe("http");
      expect(offline.kind).toBe("offline");

      const messages = [dependency.message, blocked.message, http.message, offline.message];
      expect(new Set(messages).size).toBe(4);
      for (const msg of messages) {
        expect(msg.length).toBeGreaterThan(10);
        expect(msg).not.toMatch(/curl_cffi|anubis|\.ts\b|\/Users\//i);
      }
      expect(dependency.message).not.toMatch(/check your connection/i);
      expect(blocked.message).not.toMatch(/check your connection/i);
      expect(offline.message).toMatch(/check your connection/i);
    });

    it("gives rate limiting its own message distinct from a plain refusal", () => {
      const classify = loadClassifier();
      const limited = classify("Elscione request failed (429)");
      const refused = classify("Elscione request failed (403)");
      expect(limited.kind).toBe("http");
      expect(refused.kind).toBe("http");
      expect(limited.message).not.toBe(refused.message);
      expect(limited.message).toMatch(/rate limit/i);
    });
  });
});
