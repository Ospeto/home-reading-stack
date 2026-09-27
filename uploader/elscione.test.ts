import { describe, it, expect, beforeEach } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import zlib from "node:zlib";
import {
  isElscioneUrl,
  parseElscioneUrl,
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
  });
});
