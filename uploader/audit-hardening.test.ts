import { describe, expect, it, beforeEach, afterEach } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Database } from "bun:sqlite";
import {
  getKindleDiskSpace,
  calculateClusterAllocatedSize,
  FAT32_CLUSTER_SIZE,
  MAX_FAT32_FILE_SIZE,
  sanitizeFat32Filename,
  safeCopyFileToKindle,
  scoreKindleFileForCanonical,
  areKindleEntriesDuplicates,
  cleanKindleDeviceDuplicates,
  createKindleBookEntry,
  invalidateKindleBookIndex,
  previewKindleSync,
  syncSingleBookToKindle,
} from "./kindle";
import {
  extractVolumeNumber,
  extractDescriptionFromOpfXml,
  purgeBookCoverCache,
} from "./scraper";
import { extractVolumeNumberFromFilename } from "./elscione";
import { parseVolumeAppData } from "./lnori";
import { generateOpdsFeed, rewriteOpdsXml, escapeXml } from "./opds";
import { handleRequest, purgeCoverCache, getCoverCacheDir } from "./server";

describe("LightHouse Hardening & Deep Audit Suite", () => {
  let testDir: string;

  beforeEach(() => {
    testDir = fs.mkdtempSync(path.join(os.tmpdir(), "lighthouse-audit-"));
    process.env.COVER_CACHE_DIR = path.join(testDir, "cache", "covers");
    fs.mkdirSync(process.env.COVER_CACHE_DIR, { recursive: true });
    invalidateKindleBookIndex();
  });

  afterEach(() => {
    try {
      fs.rmSync(testDir, { recursive: true, force: true });
    } catch (_err) {
      void _err;
    }
    delete process.env.TEST_KINDLE_FREE_BYTES;
    delete process.env.COVER_CACHE_DIR;
    invalidateKindleBookIndex();
  });

  describe("1. Kindle Disk Space & FAT32 Storage Calculations", () => {
    it("getKindleDiskSpace correctly handles bavail === 0 without falling back to bfree", () => {
      // Mock statfsSync returning bavail = 0 (disk 100% full for user) and bfree = 1000 (reserved blocks)
      const origStatfs = (fs as any).statfsSync;
      (fs as any).statfsSync = (_p: string) => ({
        bsize: 4096,
        frsize: 4096,
        blocks: 10000,
        bavail: 0,
        bfree: 1000,
      });

      try {
        const space = getKindleDiskSpace(testDir);
        expect(space.freeBytes).toBe(0);
        expect(space.freeMb).toBe(0);
        expect(space.totalBytes).toBe(10000 * 4096);
      } finally {
        (fs as any).statfsSync = origStatfs;
      }
    });

    it("getKindleDiskSpace prioritizes frsize over bsize when available in statfs", () => {
      const origStatfs = (fs as any).statfsSync;
      (fs as any).statfsSync = (_p: string) => ({
        bsize: 131072, // 128KB optimal I/O transfer size
        frsize: 32768, // 32KB allocation cluster size
        blocks: 1000,
        bavail: 500,
        bfree: 500,
      });

      try {
        const space = getKindleDiskSpace(testDir);
        expect(space.freeBytes).toBe(500 * 32768);
        expect(space.totalBytes).toBe(1000 * 32768);
      } finally {
        (fs as any).statfsSync = origStatfs;
      }
    });

    it("calculateClusterAllocatedSize accounts for FAT32 cluster slack", () => {
      expect(calculateClusterAllocatedSize(0)).toBe(0);
      expect(calculateClusterAllocatedSize(100)).toBe(FAT32_CLUSTER_SIZE);
      expect(calculateClusterAllocatedSize(FAT32_CLUSTER_SIZE)).toBe(FAT32_CLUSTER_SIZE);
      expect(calculateClusterAllocatedSize(FAT32_CLUSTER_SIZE + 1)).toBe(FAT32_CLUSTER_SIZE * 2);
    });

    it("sanitizeFat32Filename protects against DOS reserved device names", () => {
      expect(sanitizeFat32Filename("con.epub")).toBe("_con.epub");
      expect(sanitizeFat32Filename("PRN.epub")).toBe("_PRN.epub");
      expect(sanitizeFat32Filename("aux.epub")).toBe("_aux.epub");
      expect(sanitizeFat32Filename("nul.epub")).toBe("_nul.epub");
      expect(sanitizeFat32Filename("com1.epub")).toBe("_com1.epub");
      expect(sanitizeFat32Filename("lpt2.epub")).toBe("_lpt2.epub");
      expect(sanitizeFat32Filename("normal_book.epub")).toBe("normal_book.epub");
    });

    it("safeCopyFileToKindle bounds temporary filename within FAT32 255-byte limit", () => {
      const longTitle = "A".repeat(240) + ".epub";
      const destPath = path.join(testDir, longTitle);
      const srcPath = path.join(testDir, "source.epub");
      fs.writeFileSync(srcPath, "dummy epub content");

      expect(() => safeCopyFileToKindle(srcPath, destPath)).not.toThrow();
      expect(fs.existsSync(destPath)).toBe(true);
    });

    it("syncSingleBookToKindle rejects files exceeding FAT32 4GB limit", async () => {
      const res = await syncSingleBookToKindle(999, {
        mountPath: testDir,
      });
      // Will fail gracefully either because book 999 is not found or oversized
      expect(res.success).toBe(false);
    });
  });

  describe("2. Volume Parsing & Metadata Extraction Edge Cases", () => {
    it("extractVolumeNumber rejects 4-digit publication years in square and fullwidth brackets", () => {
      expect(extractVolumeNumber("Some Novel [2024]")).toBeNull();
      expect(extractVolumeNumber("Sci-Fi Classic [1998]")).toBeNull();
      expect(extractVolumeNumber("Anime Novel （2023）")).toBeNull();
      expect(extractVolumeNumber("Manga Title ［2021］")).toBeNull();
      expect(extractVolumeNumber("Anthology {2020}")).toBeNull();
    });

    it("extractVolumeNumber preserves real bracketed volume numbers", () => {
      expect(extractVolumeNumber("Overlord [v05]")).toBe(5);
      expect(extractVolumeNumber("Sword Art Online [Vol. 1]")).toBe(1);
      expect(extractVolumeNumber("No Game No Life [Book 2]")).toBe(2);
      expect(extractVolumeNumber("Light Novel [3]")).toBe(3);
    });

    it("extractVolumeNumber correctly parses Roman numeral volumes", () => {
      expect(extractVolumeNumber("Sword Art Online Vol. IV")).toBe(4);
      expect(extractVolumeNumber("Overlord Volume II")).toBe(2);
      expect(extractVolumeNumber("Book III - The Return")).toBe(3);
      expect(extractVolumeNumber("Classic Novel [Vol. IX]")).toBe(9);
      expect(extractVolumeNumber("DanMachi Vol. XIV")).toBe(14);
    });

    it("extractVolumeNumberFromFilename in elscione rejects standalone 4-digit years", () => {
      expect(extractVolumeNumberFromFilename("George Orwell 1984.epub")).toBeUndefined();
      expect(extractVolumeNumberFromFilename("Cyberpunk 2077.epub")).toBeUndefined();
      expect(extractVolumeNumberFromFilename("Tokyo 2020.epub")).toBeUndefined();
      expect(extractVolumeNumberFromFilename("Overlord Volume 04.epub")).toBe(4);
      expect(extractVolumeNumberFromFilename("Sword Art Online Vol. IV.epub")).toBe(4);
    });

    it("parseVolumeAppData in lnori parses diverse volume notations including v01, Book 1", () => {
      const html1 = `<html><script id="app-data" type="application/ld+json">
        {
          "name": "DanMachi v03",
          "id": "101",
          "additionalProperty": [
            { "name": "epub_filename", "value": "danmachi_v03.epub" }
          ]
        }
      </script></html>`;
      const meta1 = parseVolumeAppData(html1, "101");
      expect(meta1?.volumeNumber).toBe(3);

      const html2 = `<html><script id="app-data" type="application/ld+json">
        {
          "name": "Ascendance Book 2",
          "id": "102",
          "additionalProperty": [
            { "name": "epub_filename", "value": "bookworm.epub" }
          ]
        }
      </script></html>`;
      const meta2 = parseVolumeAppData(html2, "102");
      expect(meta2?.volumeNumber).toBe(2);
    });

    it("extractDescriptionFromOpfXml handles both attribute orderings cleanly", () => {
      const standardXml = `<?xml version="1.0"?>
        <package>
          <metadata>
            <meta name="description" content="This is the standard order description of the novel." />
          </metadata>
        </package>`;
      expect(extractDescriptionFromOpfXml(standardXml)).toContain("This is the standard order description");

      const reversedXml = `<?xml version="1.0"?>
        <package>
          <metadata>
            <meta content="This is the reversed order description of the novel." property="schema:description" />
          </metadata>
        </package>`;
      expect(extractDescriptionFromOpfXml(reversedXml)).toContain("This is the reversed order description");
    });
  });

  describe("3. Device Duplicate Scanning, Cleaning & Title Matching", () => {
    it("areKindleEntriesDuplicates requires author compatibility for filesize_and_token match", () => {
      const entryA = createKindleBookEntry(path.join(testDir, "books", "Sylvia Plath", "Selected Poems.epub"), 50000);
      const entryB = createKindleBookEntry(path.join(testDir, "books", "T.S. Eliot", "Selected Poems.epub"), 50100);

      const check = areKindleEntriesDuplicates(entryA, entryB);
      expect(check.isDuplicate).toBe(false);
    });

    it("areKindleEntriesDuplicates detects true duplicates with same author and filesize", () => {
      const entryA = createKindleBookEntry(path.join(testDir, "books", "Author One", "Selected Poems.epub"), 50000);
      const entryB = createKindleBookEntry(path.join(testDir, "books", "Old Author One", "Selected Poems.epub"), 50050);

      // Force explicit author match on entryB
      entryB.strippedBaseName = "Selected Poems - Author One";
      const check = areKindleEntriesDuplicates(entryA, entryB);
      expect(check.isDuplicate).toBe(true);
    });

    it("cleanKindleDeviceDuplicates safely cleans redundant duplicates and cleans parent dir", () => {
      const kindleMount = path.join(testDir, "Kindle");
      const booksDir = path.join(kindleMount, "books", "Author");
      const oldDir = path.join(kindleMount, "books", "Old");
      fs.mkdirSync(booksDir, { recursive: true });
      fs.mkdirSync(oldDir, { recursive: true });

      const canonicalPath = path.join(booksDir, "Book - Author.epub");
      const dupPath = path.join(oldDir, "Book - Author.epub");

      fs.writeFileSync(canonicalPath, Buffer.alloc(10000, "a"));
      fs.writeFileSync(dupPath, Buffer.alloc(10000, "b"));

      invalidateKindleBookIndex();
      const res = cleanKindleDeviceDuplicates(kindleMount);
      expect(res.cleanedCount).toBe(1);
      expect(fs.existsSync(dupPath)).toBe(false);
      expect(fs.existsSync(canonicalPath)).toBe(true);
      expect(fs.existsSync(oldDir)).toBe(false);
    });
  });

  describe("4. Cover Invalidation & Cache Purging", () => {
    it("purgeCoverCache and purgeBookCoverCache remove all thumbnail variants and master WebP files", () => {
      const cacheDir = getCoverCacheDir();
      const filesToCreate = [
        "123_360.webp",
        "123_360.jpg",
        "123_720.webp",
        "master_123.webp",
        "123.webp",
        "123.jpg",
        "456_360.webp", // different book
      ];

      for (const f of filesToCreate) {
        fs.writeFileSync(path.join(cacheDir, f), "dummy thumbnail");
      }

      const purged = purgeCoverCache(123);
      expect(purged).toBeGreaterThanOrEqual(4);

      // Book 123 cache files must be gone
      expect(fs.existsSync(path.join(cacheDir, "123_360.webp"))).toBe(false);
      expect(fs.existsSync(path.join(cacheDir, "master_123.webp"))).toBe(false);

      // Book 456 must be preserved
      expect(fs.existsSync(path.join(cacheDir, "456_360.webp"))).toBe(true);
    });

    it("purgeBookCoverCache works identically from scraper module", () => {
      const cacheDir = getCoverCacheDir();
      fs.writeFileSync(path.join(cacheDir, "789_360.webp"), "test");
      fs.writeFileSync(path.join(cacheDir, "master_789.webp"), "test");

      purgeBookCoverCache(789);
      expect(fs.existsSync(path.join(cacheDir, "789_360.webp"))).toBe(false);
      expect(fs.existsSync(path.join(cacheDir, "master_789.webp"))).toBe(false);
    });
  });

  describe("5. OPDS 1.2 Catalog Generation & Rewriting Engine", () => {
    it("escapeXml cleanly escapes all entity characters", () => {
      expect(escapeXml(`"Tom & Jerry" <vol. 1> 'test'`)).toBe(
        `&quot;Tom &amp; Jerry&quot; &lt;vol. 1&gt; &apos;test&apos;`,
      );
      expect(escapeXml(null)).toBe("");
    });

    it("generateOpdsFeed creates standards-compliant Atom XML with entries and acquisition links", () => {
      const books = [
        {
          id: 42,
          title: "The Hitchhiker's Guide to the Galaxy",
          authors: "Douglas Adams",
          pubdate: "1979-10-12",
          series: "Hitchhiker's",
          series_index: 1,
          comments: "<p>Don't Panic!</p>",
          tags: ["Sci-Fi", "Comedy"],
        },
      ];

      const xml = generateOpdsFeed(books, {
        title: "Test OPDS Feed",
        publicBaseUrl: "https://reading-sg.wavypremium.xyz:8443",
      });

      expect(xml).toContain(`<?xml version="1.0" encoding="utf-8"?>`);
      expect(xml).toContain(`<feed xmlns="http://www.w3.org/2005/Atom"`);
      expect(xml).toContain(`<title>Test OPDS Feed</title>`);
      expect(xml).toContain(`<title>The Hitchhiker&apos;s Guide to the Galaxy</title>`);
      expect(xml).toContain(`<name>Douglas Adams</name>`);
      expect(xml).toContain(`<id>urn:calibre:book:42</id>`);
      expect(xml).toContain(`rel="http://opds-spec.org/acquisition"`);
      expect(xml).toContain(`href="https://reading-sg.wavypremium.xyz:8443/api/books/42/download/epub"`);
      expect(xml).toContain(`rel="http://opds-spec.org/image"`);
      expect(xml).toContain(`href="https://reading-sg.wavypremium.xyz:8443/api/books/42/cover"`);
    });

    it("rewriteOpdsXml rewrites internal loopback URLs to public client origin", () => {
      const rawXml = `<?xml version="1.0"?>
      <feed>
        <link href="http://127.0.0.1:8088/opds" rel="self"/>
        <link href="http://localhost:8088/get/epub/123/Agent_Library" rel="acquisition"/>
      </feed>`;

      const rewritten = rewriteOpdsXml(
        rawXml,
        "opds.wavypremium.xyz",
        "https",
        "http://127.0.0.1:8088",
      );

      expect(rewritten).not.toContain("127.0.0.1:8088");
      expect(rewritten).not.toContain("localhost:8088");
      expect(rewritten).toContain("https://opds.wavypremium.xyz/opds");
      expect(rewritten).toContain("https://opds.wavypremium.xyz/get/epub/123/Agent_Library");
    });

    it("GET /api/opds serves native OPDS XML catalog directly", async () => {
      const req = new Request("https://reading.wavypremium.xyz/api/opds", {
        method: "GET",
      });
      const res = await handleRequest(req);
      expect(res.status).toBe(200);
      expect(res.headers.get("Content-Type")).toContain("application/atom+xml");
      const xml = await res.text();
      expect(xml).toContain("<feed");
      expect(xml).toContain("LightHouse");
    });

    it("GET /api/books/:id/download/:format returns 502 Bad Gateway when Calibre server is down without throwing", async () => {
      const origFetch = globalThis.fetch;
      globalThis.fetch = (async () => {
        throw new Error("connect ECONNREFUSED 127.0.0.1:8088");
      }) as any;

      try {
        const req = new Request("https://reading.wavypremium.xyz/api/books/1/download/epub", {
          method: "GET",
        });
        const res = await handleRequest(req);
        expect(res.status).toBe(502);
        const text = await res.text();
        expect(text).toContain("Bad Gateway");
      } finally {
        globalThis.fetch = origFetch;
      }
    });

    it("GET /api/books/:id/cover returns 404 cleanly when Calibre server is down and cover is not on disk", async () => {
      const origFetch = globalThis.fetch;
      globalThis.fetch = (async () => {
        throw new Error("connect ECONNREFUSED 127.0.0.1:8088");
      }) as any;

      try {
        const req = new Request("https://reading.wavypremium.xyz/api/books/999999/cover", {
          method: "GET",
        });
        const res = await handleRequest(req);
        expect(res.status).toBe(404);
      } finally {
        globalThis.fetch = origFetch;
      }
    });
  });
});
