import { describe, expect, it, beforeEach, afterEach } from "bun:test";
import { Database } from "bun:sqlite";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import {
  handleRequest,
  withKosyncDb,
  parseJsonBody,
  purgeCoverCache,
  getCoverCacheDir,
} from "./server";
import { DurableJobQueue } from "./jobs";
import { inspectArchiveSafety } from "./archive";
import { validateEpubContent } from "./security";
import { downloadCoverImage } from "./article";
import { getFirecrawlActivityDir } from "./firecrawl";

describe("LightHouse Ingestion & API Hardening Audit Regressions", () => {
  const origEnv = { ...process.env };
  const localServer = { requestIP: () => ({ address: "127.0.0.1" }) };
  let tempDir: string;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "lh-audit-test-"));
  });

  afterEach(() => {
    for (const k of Object.keys(process.env)) {
      if (!(k in origEnv)) {
        delete process.env[k];
      }
    }
    Object.assign(process.env, origEnv);
    if (fs.existsSync(tempDir)) {
      try {
        fs.rmSync(tempDir, { recursive: true, force: true });
      } catch (_err) {
        void _err;
      }
    }
  });

  describe("API Route Strict Matching & Accidental Deletion Protection", () => {
    it("DELETE /api/books/123/metadata does NOT trigger book deletion", async () => {
      const req = new Request("http://127.0.0.1:8086/api/books/123/metadata", {
        method: "DELETE",
        headers: { Origin: "http://127.0.0.1:8086" },
      });
      const res = await handleRequest(req, localServer);
      const text = await res.text();
      expect(text).not.toContain("Removed book 123");
    });

    it("DELETE /api/books/123/cover does NOT trigger book deletion", async () => {
      const req = new Request("http://127.0.0.1:8086/api/books/123/cover", {
        method: "DELETE",
        headers: { Origin: "http://127.0.0.1:8086" },
      });
      const res = await handleRequest(req, localServer);
      const text = await res.text();
      expect(text).not.toContain("Removed book 123");
    });

    it("GET /api/jobs/recent/extra returns 404 and does not match single job route", async () => {
      const req = new Request("http://127.0.0.1:8086/api/jobs/recent/extra", {
        method: "GET",
      });
      const res = await handleRequest(req, localServer);
      expect(res.status).toBe(404);
      const body = await res.json();
      expect(body.success).toBe(false);
      expect(body.error).toContain("API endpoint not found");
    });

    it("POST /api/jobs/123/extra/retry returns 404 and does not match job retry route", async () => {
      const req = new Request("http://127.0.0.1:8086/api/jobs/123/extra/retry", {
        method: "POST",
      });
      const res = await handleRequest(req, localServer);
      expect(res.status).toBe(404);
    });
  });

  describe("Malformed Client JSON Payload Resilience (HTTP 400 Bad Request)", () => {
    it("POST /api/ingest-url returns 400 Bad Request on invalid JSON", async () => {
      const req = new Request("http://127.0.0.1:8086/api/ingest-url", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: "{ malformed json",
      });
      const res = await handleRequest(req, localServer);
      expect(res.status).toBe(400);
      const body = await res.json();
      expect(body.success).toBe(false);
      expect(body.error).toContain("Malformed or invalid JSON payload");
    });

    it("POST /api/books/bulk-delete returns 400 Bad Request on invalid JSON", async () => {
      const req = new Request("http://127.0.0.1:8086/api/books/bulk-delete", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: "not a json string at all",
      });
      const res = await handleRequest(req, localServer);
      expect(res.status).toBe(400);
      const body = await res.json();
      expect(body.success).toBe(false);
      expect(body.error).toContain("Malformed or invalid JSON payload");
    });

    it("POST /api/metadata/lookup returns 400 Bad Request on invalid JSON", async () => {
      const req = new Request("http://127.0.0.1:8086/api/metadata/lookup", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: "invalid{json",
      });
      const res = await handleRequest(req, localServer);
      expect(res.status).toBe(400);
      const body = await res.json();
      expect(body.success).toBe(false);
      expect(body.error).toContain("Malformed or invalid JSON payload");
    });

    it("POST /api/books/123/metadata returns 400 Bad Request on invalid JSON", async () => {
      const req = new Request("http://127.0.0.1:8086/api/books/123/metadata", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: "{ bad: [json",
      });
      const res = await handleRequest(req, localServer);
      expect(res.status).toBe(400);
      const body = await res.json();
      expect(body.success).toBe(false);
      expect(body.error).toContain("Malformed or invalid JSON payload");
    });

    it("POST /api/kosync/link-document returns 400 Bad Request on invalid JSON", async () => {
      const req = new Request("http://127.0.0.1:8086/api/kosync/link-document", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: "invalid: json",
      });
      const res = await handleRequest(req, localServer);
      expect(res.status).toBe(400);
      const body = await res.json();
      expect(body.success).toBe(false);
      expect(body.error).toContain("Malformed or invalid JSON payload");
    });

    it("parseJsonBody parses valid JSON and gracefully handles empty text", async () => {
      const validReq = new Request("http://localhost", {
        method: "POST",
        body: JSON.stringify({ key: "value" }),
      });
      const parsed = await parseJsonBody(validReq);
      expect(parsed.data).toEqual({ key: "value" });
      expect(parsed.error).toBeNull();

      const emptyReq = new Request("http://localhost", { method: "POST", body: "   " });
      const emptyParsed = await parseJsonBody(emptyReq);
      expect(emptyParsed.data).toEqual({});
      expect(emptyParsed.error).toBeNull();
    });
  });

  describe("Cover Cache Invalidation & SSRF / Content Verification", () => {
    it("purgeCoverCache correctly deletes all width and master variants", () => {
      const cacheDir = getCoverCacheDir();
      fs.mkdirSync(cacheDir, { recursive: true });

      const bookId = 99999;
      const file1 = path.join(cacheDir, `${bookId}_360.webp`);
      const file2 = path.join(cacheDir, `${bookId}_600.jpg`);
      const file3 = path.join(cacheDir, `master_${bookId}.webp`);
      const fileOther = path.join(cacheDir, `88888_360.webp`);

      fs.writeFileSync(file1, "test");
      fs.writeFileSync(file2, "test");
      fs.writeFileSync(file3, "test");
      fs.writeFileSync(fileOther, "other");

      const purged = purgeCoverCache(bookId);
      expect(purged).toBe(3);
      expect(fs.existsSync(file1)).toBe(false);
      expect(fs.existsSync(file2)).toBe(false);
      expect(fs.existsSync(file3)).toBe(false);
      expect(fs.existsSync(fileOther)).toBe(true);

      fs.unlinkSync(fileOther);
    });

    it("POST /api/books/123/metadata rejects disallowed cover domains", async () => {
      const req = new Request("http://127.0.0.1:8086/api/books/123/metadata", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          title: "Test Book",
          coverUrl: "https://evil-untrusted-domain.com/avatar.jpg",
        }),
      });
      const res = await handleRequest(req, localServer);
      expect(res.status).toBe(400);
      const body = await res.json();
      expect(body.success).toBe(false);
      expect(body.error).toContain("Cover domain not permitted");
    });
  });

  describe("KOSync Database Safe Helper & Connection Leak Prevention", () => {
    it("withKosyncDb safely executes queries and closes connection", () => {
      const dbPath = path.join(tempDir, "test-kosync.db");
      process.env.KOSYNC_DB_PATH = dbPath;

      const initDb = new Database(dbPath);
      initDb.run("CREATE TABLE progress (id INTEGER PRIMARY KEY, document TEXT);");
      initDb.run("INSERT INTO progress (document) VALUES ('doc1');");
      initDb.close();

      const result = withKosyncDb((db) => {
        return db.query("SELECT * FROM progress;").all();
      });

      expect(result).toHaveLength(1);
      expect((result as any)[0].document).toBe("doc1");
    });

    it("withKosyncDb returns null cleanly if database file does not exist", () => {
      process.env.KOSYNC_DB_PATH = path.join(tempDir, "nonexistent.db");
      const result = withKosyncDb((db) => db.query("SELECT 1").all());
      expect(result).toBeNull();
    });
  });

  describe("Durable Job Queue Hardening", () => {
    it("retryJob resets retries to 0 for fresh attempt budget", () => {
      const dbPath = path.join(tempDir, "jobs.db");
      const queue = new DurableJobQueue(dbPath);

      try {
        const job = queue.enqueue("cover_backfill", { candidateBookIds: [1] }, { maxRetries: 2 });
        const db = (queue as any).db as Database;
        db.prepare("UPDATE jobs SET status = 'failed', retries = 2 WHERE id = ?").run(job.id);

        const retried = queue.retryJob(job.id);
        expect(retried).not.toBeNull();
        expect(retried!.status).toBe("pending");
        expect(retried!.retries).toBe(0);
      } finally {
        queue.close();
      }
    });

    it("getRecentJobs handles negative, zero, and non-finite limits gracefully", () => {
      const dbPath = path.join(tempDir, "jobs-limit.db");
      const queue = new DurableJobQueue(dbPath);

      try {
        queue.enqueue("cover_backfill", {});
        const jobsNeg = queue.getRecentJobs({ limit: -10 });
        expect(jobsNeg.length).toBeGreaterThanOrEqual(1);

        const jobsNan = queue.getRecentJobs({ limit: NaN });
        expect(jobsNan.length).toBeGreaterThanOrEqual(1);

        const jobsLarge = queue.getRecentJobs({ limit: 10000 });
        expect(jobsLarge.length).toBeGreaterThanOrEqual(1);
      } finally {
        queue.close();
      }
    });
  });

  describe("Archive & EPUB File Descriptor Leak Prevention", () => {
    it("inspectArchiveSafety rejects 0-byte empty archives cleanly", () => {
      const emptyFile = path.join(tempDir, "empty.zip");
      fs.writeFileSync(emptyFile, "");

      const res = inspectArchiveSafety(emptyFile);
      expect(res.safe).toBe(false);
      expect(res.error).toContain("empty (0 bytes)");
      expect(() => fs.unlinkSync(emptyFile)).not.toThrow();
    });

    it("validateEpubContent closes fd even when file is invalid", () => {
      const badEpub = path.join(tempDir, "bad.epub");
      fs.writeFileSync(badEpub, "PK\x03\x04" + "A".repeat(100));

      const res = validateEpubContent(badEpub);
      expect(res.valid).toBe(false);
      expect(() => fs.unlinkSync(badEpub)).not.toThrow();
    });
  });

  describe("Cover Image Download Limits & Temp Cleanup", () => {
    it("downloadCoverImage returns null on disallowed domain and leaves no temp files", async () => {
      const res = await downloadCoverImage("https://disallowed.com/cover.jpg", "https://example.com/article");
      expect(res).toBeNull();
    });
  });

  describe("Firecrawl Dynamic Activity Directory", () => {
    it("getFirecrawlActivityDir respects process.env.FIRECRAWL_ACTIVITY_DIR", () => {
      const customDir = path.join(tempDir, "custom-fc-activity");
      process.env.FIRECRAWL_ACTIVITY_DIR = customDir;
      expect(getFirecrawlActivityDir()).toBe(customDir);
    });
  });

  describe("Server Top-Level Error Boundary", () => {
    it("handleRequest returns 500 JSON with CORS headers if unhandled error occurs", async () => {
      const crashReq = {
        method: "GET",
        url: "http://127.0.0.1:8086/api/books",
        get headers() {
          throw new Error("Unexpected critical pipeline failure");
        },
      } as unknown as Request;

      const res = await handleRequest(crashReq, localServer);
      expect(res.status).toBe(500);
      expect(res.headers.get("Content-Type")).toContain("application/json");
      const json = await res.json();
      expect(json.success).toBe(false);
      expect(json.error).toContain("Unexpected critical pipeline failure");
    });
  });
});
