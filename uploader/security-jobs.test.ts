import { describe, expect, it } from "bun:test";
import { Database } from "bun:sqlite";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import {
  isPrivateOrInternalIp,
  isPrivateIPv4,
  validateUrlForSSRF,
  isWanRequest,
  authenticateRequest,
  isAllowedOrigin,
  validateOriginAndCsrf,
  validateIntegerId,
  validateBookFormat,
  isCanonicalEpub,
  sanitizeFilename,
  getDownloadFilename,
  sanitizeErrorMessage,
  validateTelegramWebAppData,
  cleanString,
  redactJobRecord,
  validateEpubContent,
  meterStream,
  safeFetchWithSsrf,
  isSameBookIdentity,
} from "./security";
import {
  inspectArchiveSafety,
  unpackArchive,
  isArchiveFile,
  isSupportedBook,
  MAX_ARCHIVE_ENTRIES,
} from "./archive";
import { DurableJobQueue, withCalibreLock, withCalibreLockSync } from "./jobs";
import { handleRequest } from "./server";
import { isAllowedCoverUrl, isSameBook } from "./scraper";
import { generateTypographicCover, getDropDir } from "./article";

describe("Public WAN & API Surface Hardening — SSRF Protection", () => {
  it("blocks IPv4 loopback and local addresses", () => {
    expect(isPrivateOrInternalIp("127.0.0.1")).toBe(true);
    expect(isPrivateOrInternalIp("127.0.0.2")).toBe(true);
    expect(isPrivateOrInternalIp("127.255.255.254")).toBe(true);
    expect(isPrivateOrInternalIp("0.0.0.0")).toBe(true);
  });

  it("blocks IPv4 RFC 1918 private subnets", () => {
    expect(isPrivateOrInternalIp("10.0.0.1")).toBe(true);
    expect(isPrivateOrInternalIp("10.255.255.255")).toBe(true);
    expect(isPrivateOrInternalIp("172.16.0.1")).toBe(true);
    expect(isPrivateOrInternalIp("172.31.255.255")).toBe(true);
    expect(isPrivateOrInternalIp("192.168.0.1")).toBe(true);
    expect(isPrivateOrInternalIp("192.168.31.15")).toBe(true);
  });

  it("blocks cloud metadata & link-local addresses (169.254.169.254)", () => {
    expect(isPrivateOrInternalIp("169.254.169.254")).toBe(true);
    expect(isPrivateOrInternalIp("169.254.0.1")).toBe(true);
  });

  it("blocks IPv6 loopback, link-local, and unique local addresses", () => {
    expect(isPrivateOrInternalIp("::1")).toBe(true);
    expect(isPrivateOrInternalIp("::")).toBe(true);
    expect(isPrivateOrInternalIp("fe80::1")).toBe(true);
    expect(isPrivateOrInternalIp("fc00::1")).toBe(true);
    expect(isPrivateOrInternalIp("fd00::1234")).toBe(true);
    expect(isPrivateOrInternalIp("::ffff:127.0.0.1")).toBe(true);
    expect(isPrivateOrInternalIp("::ffff:192.168.1.1")).toBe(true);
  });

  it("normalizes and blocks decimal, hex, and octal IP representations", () => {
    // 127.0.0.1 in decimal integer: 2130706433
    expect(isPrivateOrInternalIp("2130706433")).toBe(true);
    // 127.0.0.1 in hex: 0x7f000001
    expect(isPrivateOrInternalIp("0x7f000001")).toBe(true);
    // 127.0.0.1 in octal: 0177.0.0.1
    expect(isPrivateOrInternalIp("0177.0.0.1")).toBe(true);
  });

  it("allows standard public internet IPv4 addresses", () => {
    expect(isPrivateOrInternalIp("8.8.8.8")).toBe(false);
    expect(isPrivateOrInternalIp("1.1.1.1")).toBe(false);
    expect(isPrivateOrInternalIp("104.21.5.19")).toBe(false);
  });

  it("validateUrlForSSRF rejects non-http protocols and embedded credentials", async () => {
    const fileRes = await validateUrlForSSRF("file:///etc/passwd");
    expect(fileRes.safe).toBe(false);

    const ftpRes = await validateUrlForSSRF("ftp://example.com/file");
    expect(ftpRes.safe).toBe(false);

    const credRes = await validateUrlForSSRF("http://user:pass@example.com");
    expect(credRes.safe).toBe(false);
  });

  it("validateUrlForSSRF blocks local and internal hostnames", async () => {
    const local1 = await validateUrlForSSRF("http://localhost:8088/test");
    expect(local1.safe).toBe(false);

    const local2 = await validateUrlForSSRF("http://sub.localhost/api");
    expect(local2.safe).toBe(false);

    const internal = await validateUrlForSSRF("http://router.lan/admin");
    expect(internal.safe).toBe(false);

    const homeArpa = await validateUrlForSSRF("http://server.home.arpa/");
    expect(homeArpa.safe).toBe(false);
  });

  it("validateUrlForSSRF blocks direct private IP literals and metadata endpoints", async () => {
    const meta = await validateUrlForSSRF(
      "http://169.254.169.254/latest/meta-data/",
    );
    expect(meta.safe).toBe(false);

    const loop = await validateUrlForSSRF("http://127.0.0.1:8088/calibre");
    expect(loop.safe).toBe(false);

    const priv = await validateUrlForSSRF("http://192.168.31.15:8086/api");
    expect(priv.safe).toBe(false);
  });

  it("validateUrlForSSRF accepts valid public URLs with allowProxyBypass", async () => {
    const pub = await validateUrlForSSRF(
      "https://en.wikipedia.org/wiki/E-book",
      { allowProxyBypass: true },
    );
    expect(pub.safe).toBe(true);
  });
});

describe("Public WAN & API Surface Hardening — WAN vs LAN & Authentication", () => {
  it("classifies requests by host and proxy headers", () => {
    // LAN request
    const lanReq = new Request("http://192.168.31.15:8086/api/books", {
      headers: { host: "192.168.31.15:8086" },
    });
    expect(isWanRequest(lanReq)).toBe(false);

    // WAN request via domain
    const wanReq1 = new Request("http://127.0.0.1:8086/api/books", {
      headers: { host: "reading.wavypremium.xyz" },
    });
    expect(isWanRequest(wanReq1)).toBe(true);

    // WAN request via X-Forwarded-Host
    const wanReq2 = new Request("http://127.0.0.1:8086/api/books", {
      headers: {
        host: "127.0.0.1:8086",
        "x-forwarded-host": "reading.wavypremium.xyz",
      },
    });
    expect(isWanRequest(wanReq2)).toBe(true);

    // WAN request via public client X-Forwarded-For
    const wanReq3 = new Request("http://127.0.0.1:8086/api/books", {
      headers: {
        host: "127.0.0.1:8086",
        "x-forwarded-for": "8.8.8.8",
      },
    });
    expect(isWanRequest(wanReq3)).toBe(true);
  });

  it("authenticateRequest passes local LAN requests without credentials", () => {
    const lanReq = new Request("http://192.168.31.15:8086/api/upload", {
      method: "POST",
      headers: { host: "192.168.31.15:8086" },
    });
    const result = authenticateRequest(lanReq, { apiKey: "secret123" });
    expect(result.authenticated).toBe(true);
    expect(result.method).toBe("lan");
  });

  it("authenticateRequest blocks unauthenticated WAN requests", () => {
    const wanReq = new Request("http://127.0.0.1:8086/api/upload", {
      method: "POST",
      headers: { host: "reading.wavypremium.xyz" },
    });
    const result = authenticateRequest(wanReq, { apiKey: "secret123" });
    expect(result.authenticated).toBe(false);
  });

  it("authenticateRequest accepts Bearer token or X-API-Key matching apiKey", () => {
    const bearerReq = new Request("http://127.0.0.1:8086/api/upload", {
      method: "POST",
      headers: {
        host: "reading.wavypremium.xyz",
        authorization: "Bearer my-secret-key-123",
      },
    });
    expect(
      authenticateRequest(bearerReq, { apiKey: "my-secret-key-123" })
        .authenticated,
    ).toBe(true);

    const headerReq = new Request("http://127.0.0.1:8086/api/upload", {
      method: "POST",
      headers: {
        host: "reading.wavypremium.xyz",
        "x-api-key": "my-secret-key-123",
      },
    });
    expect(
      authenticateRequest(headerReq, { apiKey: "my-secret-key-123" })
        .authenticated,
    ).toBe(true);
  });

  it("validateTelegramWebAppData correctly verifies valid HMAC-SHA256 signatures and rejects tampered data", () => {
    const botToken = "123456:ABC-DEF1234ghIkl-zyx57W2v1u123ew11";
    const authDate = Math.floor(Date.now() / 1000);
    const userJson = JSON.stringify({ id: 998877, first_name: "ReadingMate" });

    const checkString = `auth_date=${authDate}\nquery_id=AAHdF6IQAAAAAN0XohDhrOrc\nuser=${userJson}`;
    const secretKey = crypto
      .createHmac("sha256", "WebAppData")
      .update(botToken)
      .digest();
    const validHash = crypto
      .createHmac("sha256", secretKey)
      .update(checkString)
      .digest("hex");

    const validInitData = `query_id=AAHdF6IQAAAAAN0XohDhrOrc&user=${encodeURIComponent(userJson)}&auth_date=${authDate}&hash=${validHash}`;

    const validResult = validateTelegramWebAppData(validInitData, botToken);
    expect(validResult.valid).toBe(true);
    expect(validResult.user?.id).toBe(998877);

    // Tampered user data
    const tamperedInitData = `query_id=AAHdF6IQAAAAAN0XohDhrOrc&user=${encodeURIComponent(JSON.stringify({ id: 111 }))}&auth_date=${authDate}&hash=${validHash}`;
    const invalidResult = validateTelegramWebAppData(
      tamperedInitData,
      botToken,
    );
    expect(invalidResult.valid).toBe(false);

    // Expired initData (older than maxAgeSec)
    const oldDate = authDate - 100000;
    const oldCheckString = `auth_date=${oldDate}\nquery_id=AAHdF6IQAAAAAN0XohDhrOrc`;
    const oldHash = crypto
      .createHmac("sha256", secretKey)
      .update(oldCheckString)
      .digest("hex");
    const expiredInitData = `query_id=AAHdF6IQAAAAAN0XohDhrOrc&auth_date=${oldDate}&hash=${oldHash}`;
    const expiredResult = validateTelegramWebAppData(
      expiredInitData,
      botToken,
      3600,
    );
    expect(expiredResult.valid).toBe(false);
  });
});

describe("Public WAN & API Surface Hardening — CORS & CSRF Guards", () => {
  it("allows configured production WAN and local LAN origins", () => {
    expect(isAllowedOrigin("https://reading.wavypremium.xyz")).toBe(true);
    expect(isAllowedOrigin("https://kosync.wavypremium.xyz")).toBe(true);
    expect(isAllowedOrigin("http://localhost:8086")).toBe(true);
    expect(isAllowedOrigin("http://127.0.0.1:8086")).toBe(true);
    expect(isAllowedOrigin("http://192.168.31.15:8086")).toBe(true);
    expect(isAllowedOrigin("https://evil-attacker.com")).toBe(false);
  });

  it("validateOriginAndCsrf blocks mutating requests with untrusted origins", () => {
    const maliciousPost = new Request("http://127.0.0.1:8086/api/books/1", {
      method: "DELETE",
      headers: {
        origin: "https://attacker.site",
      },
    });
    const check = validateOriginAndCsrf(maliciousPost);
    expect(check.valid).toBe(false);
  });

  it("validateOriginAndCsrf allows mutating requests from permitted origins", () => {
    const validPost = new Request("http://127.0.0.1:8086/api/books/1", {
      method: "DELETE",
      headers: {
        origin: "https://reading.wavypremium.xyz",
      },
    });
    const check = validateOriginAndCsrf(validPost);
    expect(check.valid).toBe(true);
  });
});

describe("Public WAN & API Surface Hardening — ID, Format & Filename Sanitization", () => {
  it("validateIntegerId strictly requires positive integers", () => {
    expect(validateIntegerId(1)).toBe(1);
    expect(validateIntegerId("42")).toBe(42);
    expect(validateIntegerId(0)).toBeNull();
    expect(validateIntegerId(-5)).toBeNull();
    expect(validateIntegerId("abc")).toBeNull();
    expect(validateIntegerId("1; DROP TABLE books")).toBeNull();
    expect(validateIntegerId(3.14)).toBeNull();
  });

  it("validateBookFormat validates formats and enforces allowed extensions", () => {
    expect(validateBookFormat("epub")).toBe("epub");
    expect(validateBookFormat(".EPUB")).toBe("epub");
    expect(validateBookFormat("exe")).toBeNull();
    expect(validateBookFormat("sh")).toBeNull();
  });

  it("isCanonicalEpub enforces EPUB-only canonical files and rejects hidden files", () => {
    expect(isCanonicalEpub("Clean Book.epub")).toBe(true);
    expect(isCanonicalEpub("Book.PDF")).toBe(false);
    expect(isCanonicalEpub("._Book.epub")).toBe(false);
    expect(isCanonicalEpub(".hidden.epub")).toBe(false);
  });

  it("sanitizeFilename strips path traversal, illegal chars, and control characters", () => {
    expect(sanitizeFilename("../../etc/passwd")).toBe("etc passwd");
    expect(sanitizeFilename("Title: Subtitle? *Awesome* <Book>")).toBe(
      "Title Subtitle Awesome Book",
    );
    expect(sanitizeFilename("   Lots   of   spaces   ")).toBe("Lots of spaces");
    expect(sanitizeFilename(".hidden")).toBe("hidden");
  });

  it("getDownloadFilename produces clean 'Title - Author.epub' and avoids Calibre internal paths", () => {
    const book = {
      title: "The Great Gatsby",
      authors: "F. Scott Fitzgerald",
    };
    expect(getDownloadFilename(book, "epub")).toBe(
      "The Great Gatsby - F. Scott Fitzgerald.epub",
    );

    const seriesBook = {
      title: "Dune Messiah",
      authors: "Frank Herbert",
      series: "Dune",
      series_index: 2,
    };
    expect(getDownloadFilename(seriesBook, "epub")).toBe(
      "[Dune 2] Dune Messiah - Frank Herbert.epub",
    );

    // Book with malicious characters in title
    const unsafeBook = {
      title: "Hackers: /..//etc/passwd *Edition*?",
      authors: "Anonymous <Hacker>",
    };
    const cleanName = getDownloadFilename(unsafeBook, "epub");
    expect(cleanName).not.toContain("/");
    expect(cleanName).not.toContain("..");
    expect(cleanName).toContain(".epub");
  });

  it("sanitizeErrorMessage redacts server file paths and secrets", () => {
    const errWithPath = new Error(
      "ENOENT: no such file or directory, open '/Users/ospeto/uploader/secret.txt'",
    );
    const sanitized = sanitizeErrorMessage(errWithPath);
    expect(sanitized).not.toContain("/Users/ospeto");
    expect(sanitized).toContain("[path]");
  });
});

describe("Archive Extraction Hardening & Resource Limits", () => {
  it("detects archive formats", () => {
    expect(isArchiveFile("collection.zip")).toBe(true);
    expect(isArchiveFile("bundle.tar")).toBe(true);
    expect(isArchiveFile("archive.7z")).toBe(true);
    expect(isArchiveFile("book.epub")).toBe(false);
  });

  it("isSupportedBook accepts only canonical EPUBs", () => {
    expect(isSupportedBook("book.epub")).toBe(true);
    expect(isSupportedBook("document.pdf")).toBe(false);
    expect(isSupportedBook("comic.cbz")).toBe(false);
  });

  it("inspectArchiveSafety rejects archives with path traversal entries", () => {
    const tempZip = `/tmp/test_traversal_${Date.now()}.zip`;
    // Create zip with traversal path
    const pythonScript = `
import zipfile
with zipfile.ZipFile("${tempZip}", "w") as z:
    z.writestr("../../etc/cron.d/pwn", "malicious payload")
`;
    Bun.spawnSync(["python3", "-c", pythonScript]);

    try {
      const inspection = inspectArchiveSafety(tempZip);
      expect(inspection.safe).toBe(false);
      expect(inspection.error).toContain("Path traversal");
    } finally {
      if (fs.existsSync(tempZip)) fs.unlinkSync(tempZip);
    }
  });

  it("unpackArchive extracts canonical EPUBs and quarantines non-EPUB files", () => {
    const tempZip = `/tmp/test_mixed_${Date.now()}.zip`;
    const pythonScript = `
import zipfile
with zipfile.ZipFile("${tempZip}", "w") as z:
    z.writestr("book1.epub", "epub data")
    z.writestr("manual.pdf", "pdf data")
    z.writestr("manga.cbz", "cbz data")
`;
    Bun.spawnSync(["python3", "-c", pythonScript]);

    try {
      const res = unpackArchive(tempZip);
      expect(res.success).toBe(true);
      expect(res.books.length).toBe(1);
      expect(res.books[0].originalName).toBe("book1.epub");
      expect(res.quarantined?.length).toBe(2);
      expect(res.quarantined?.map((q) => q.originalName)).toContain(
        "manual.pdf",
      );
      expect(res.quarantined?.map((q) => q.originalName)).toContain(
        "manga.cbz",
      );
      res.cleanup();
    } finally {
      if (fs.existsSync(tempZip)) fs.unlinkSync(tempZip);
    }
  });

  it("unpackArchive rejects archives containing no canonical EPUBs", () => {
    const tempZip = `/tmp/test_nonepub_${Date.now()}.zip`;
    const pythonScript = `
import zipfile
with zipfile.ZipFile("${tempZip}", "w") as z:
    z.writestr("document.pdf", "pdf data")
`;
    Bun.spawnSync(["python3", "-c", pythonScript]);

    try {
      const res = unpackArchive(tempZip);
      expect(res.success).toBe(false);
      expect(res.error).toContain("Only EPUB format is accepted");
      res.cleanup();
    } finally {
      if (fs.existsSync(tempZip)) fs.unlinkSync(tempZip);
    }
  });
});

describe("Durable Ingestion Job Queue Lifecycle & Crash Recovery", () => {
  it("enqueues jobs into SQLite with initial pending status", () => {
    const testDb = new Database(":memory:");
    const queue = new DurableJobQueue(testDb);

    const job = queue.enqueue("file_ingest", {
      filePath: "/tmp/test.epub",
      originalFileName: "test.epub",
    });

    expect(job.id).toBeDefined();
    expect(job.status).toBe("pending");
    expect(job.retries).toBe(0);

    const retrieved = queue.getJob(job.id);
    expect(retrieved?.id).toBe(job.id);
    expect(retrieved?.payload.originalFileName).toBe("test.epub");
  });

  it("processes jobs sequentially and updates status to completed", async () => {
    const testDb = new Database(":memory:");
    const queue = new DurableJobQueue(testDb);

    let handlerExecuted = false;
    queue.registerHandler("metadata_enrich", async (payload) => {
      handlerExecuted = true;
      return { enriched: true, bookId: payload.bookId };
    });

    const job = queue.enqueue("metadata_enrich", {
      bookId: 42,
      title: "Test Title",
    });
    const processed = await queue.processNextJob();

    expect(processed).toBe(true);
    expect(handlerExecuted).toBe(true);

    const completedJob = queue.getJob(job.id);
    expect(completedJob?.status).toBe("completed");
    expect(completedJob?.result?.enriched).toBe(true);
  });

  it("handles handler errors with bounded exponential backoff retries and eventual failure", async () => {
    const testDb = new Database(":memory:");
    const queue = new DurableJobQueue(testDb);

    let attempts = 0;
    queue.registerHandler("url_article_ingest", async () => {
      attempts++;
      throw new Error("Network timeout contacting target host");
    });

    const job = queue.enqueue(
      "url_article_ingest",
      { url: "https://example.com/fail" },
      { maxRetries: 2 },
    );

    // Attempt 1 -> pending retry
    await queue.processNextJob();
    const jobAfter1 = queue.getJob(job.id);
    expect(jobAfter1?.status).toBe("pending");
    expect(jobAfter1?.retries).toBe(1);
    expect(jobAfter1?.next_run_at).toBeGreaterThan(Date.now() - 100);

    // Fast-forward next_run_at to simulate backoff passing
    testDb
      .prepare("UPDATE jobs SET next_run_at = ? WHERE id = ?")
      .run(Date.now() - 1000, job.id);

    // Attempt 2 (max retries reached) -> status failed
    await queue.processNextJob();
    expect(attempts).toBe(2);
    const jobAfter2 = queue.getJob(job.id);
    expect(jobAfter2?.status).toBe("failed");
    expect(jobAfter2?.retries).toBe(2);
    expect(jobAfter2?.error).toContain("Network timeout");
  });

  it("recovers interrupted jobs on startup after an unexpected crash", () => {
    const testDb = new Database(":memory:");
    const queue = new DurableJobQueue(testDb);

    // Insert a job directly in 'processing' state simulating crash mid-execution
    testDb
      .prepare(
        `INSERT INTO jobs (id, type, payload, status, retries, max_retries, created_at, updated_at, next_run_at)
         VALUES ('crash_job_1', 'file_ingest', '{"file":"test"}', 'processing', 0, 3, 1000, 1000, 1000)`,
      )
      .run();

    const recoveredCount = queue.recoverInterruptedJobs();
    expect(recoveredCount).toBe(1);

    const job = queue.getJob("crash_job_1");
    expect(job?.status).toBe("pending");
    expect(job?.retries).toBe(1);
    expect(job?.error).toContain("Recovered from unexpected process restart");
  });

  it("inspects recent jobs and retries failed jobs via API helper", () => {
    const testDb = new Database(":memory:");
    const queue = new DurableJobQueue(testDb);

    queue.enqueue("file_ingest", { name: "book1" });
    queue.enqueue("metadata_enrich", { id: 10 });
    const failedJob = queue.enqueue("cover_backfill", {});

    testDb
      .prepare(
        "UPDATE jobs SET status = 'failed', error = 'Disk full' WHERE id = ?",
      )
      .run(failedJob.id);

    const recent = queue.getRecentJobs({ limit: 10 });
    expect(recent.length).toBe(3);

    const retried = queue.retryJob(failedJob.id);
    expect(retried?.status).toBe("pending");
    expect(retried?.error).toBeNull();
  });
});

describe("Server Integration Endpoints & Hardened API Surface", () => {
  it("rejects non-EPUB direct file uploads", async () => {
    const formData = new FormData();
    const pdfBlob = new Blob(["%PDF-1.4 mock pdf"], {
      type: "application/pdf",
    });
    formData.append("file", pdfBlob, "manual.pdf");

    const req = new Request("http://127.0.0.1:8086/api/upload", {
      method: "POST",
      headers: {
        host: "127.0.0.1:8086",
      },
      body: formData,
    });

    const res = await handleRequest(req);
    expect(res.status).toBe(400);
    const data = (await res.json()) as any;
    expect(data.success).toBe(false);
    expect(data.error).toContain("Only EPUB format is accepted");
  });

  it("rejects SSRF target on ingest-url endpoint", async () => {
    const req = new Request("http://127.0.0.1:8086/api/ingest-url", {
      method: "POST",
      headers: {
        host: "127.0.0.1:8086",
        "content-type": "application/json",
      },
      body: JSON.stringify({ url: "http://169.254.169.254/latest/meta-data/" }),
    });

    const res = await handleRequest(req);
    expect(res.status).toBe(400);
    const data = (await res.json()) as any;
    expect(data.success).toBe(false);
    expect(data.error).toContain("SSRF");
  });

  it("exposes job inspection endpoint GET /api/jobs/recent", async () => {
    const req = new Request("http://127.0.0.1:8086/api/jobs/recent", {
      method: "GET",
      headers: {
        host: "127.0.0.1:8086",
      },
    });

    const res = await handleRequest(req);
    expect(res.status).toBe(200);
    const data = (await res.json()) as any;
    expect(data.success).toBe(true);
    expect(Array.isArray(data.jobs)).toBe(true);
  });

  it("blocks unauthenticated WAN mutating requests with 401", async () => {
    const wanDelete = new Request("http://127.0.0.1:8086/api/books/999", {
      method: "DELETE",
      headers: {
        host: "reading.wavypremium.xyz",
        origin: "https://reading.wavypremium.xyz",
      },
    });

    const res = await handleRequest(wanDelete);
    expect(res.status).toBe(401);
    const data = (await res.json()) as any;
    expect(data.success).toBe(false);
    expect(data.error).toContain("Authentication required");
  });

  it("preserves Calibre internal paths and constructs metadata-derived download names", () => {
    // Simulated Calibre book record
    const calibreBook = {
      id: 42,
      title: "Clean Architecture: A Craftsman's Guide",
      authors: "Robert C. Martin",
      series: "Robert C. Martin Series",
      series_index: 1,
    };

    // Internal path simulated: /Users/ospeto/Calibre Libraries/Agent Library/Robert C. Martin/Clean Architecture (42)/Clean Architecture - Robert C. Martin.epub
    const simulatedInternalPath =
      "/Users/ospeto/Calibre Libraries/Agent Library/Robert C. Martin/Clean Architecture (42)/Clean Architecture - Robert C. Martin.epub";

    // User-facing download name
    const downloadName = getDownloadFilename(calibreBook, "epub");

    // Must not contain directory paths, internal library folder names, or internal ID paths
    expect(downloadName).not.toContain(path.dirname(simulatedInternalPath));
    expect(downloadName).not.toContain("/Users/ospeto");
    expect(downloadName).not.toContain("Agent Library");
    expect(downloadName).toBe(
      "[Robert C. Martin Series 1] Clean Architecture A Craftsman's Guide - Robert C. Martin.epub",
    );
  });

  it("rejects lookalike IP/domain patterns across private-origin checks", () => {
    expect(isPrivateIPv4("192.168.attacker.example")).toBe(false);
    expect(isPrivateIPv4("10.attacker.com")).toBe(false);
    expect(isPrivateIPv4("172.16.attacker.com")).toBe(false);
    expect(isPrivateIPv4("127.0.0.1.attacker.com")).toBe(false);
    expect(isPrivateIPv4("192.168.1.1")).toBe(true);
    expect(isPrivateIPv4("10.0.0.1")).toBe(true);
    expect(isPrivateIPv4("172.16.0.1")).toBe(true);

    // isAllowedOrigin must reject lookalike domains
    expect(isAllowedOrigin("http://192.168.attacker.example:8086")).toBe(false);
    expect(isAllowedOrigin("http://10.attacker.com:8086")).toBe(false);
    expect(isAllowedOrigin("http://172.16.attacker.com:8086")).toBe(false);
    expect(isAllowedOrigin("http://127.0.0.1.attacker.com")).toBe(false);
  });

  it("fails closed for isWanRequest on missing, ambiguous, or lookalike host headers", () => {
    // Missing host -> fails closed (WAN)
    const emptyHostReq = new Request("http://localhost:8086/api/books", {
      headers: { host: "" },
    });
    expect(isWanRequest(emptyHostReq)).toBe(true);

    // Lookalike host -> fails closed (WAN)
    const lookalikeReq = new Request("http://127.0.0.1:8086/api/books", {
      headers: { host: "192.168.attacker.example:8086" },
    });
    expect(isWanRequest(lookalikeReq)).toBe(true);

    // Non-private client IP -> fails closed (WAN)
    const publicClientReq = new Request("http://127.0.0.1:8086/api/books", {
      headers: { host: "127.0.0.1:8086" },
    });
    expect(isWanRequest(publicClientReq, { clientIp: "8.8.8.8" })).toBe(true);

    // Legitimate private client IP with private host -> LAN
    const lanClientReq = new Request("http://192.168.31.15:8086/api/books", {
      headers: { host: "192.168.31.15:8086" },
    });
    expect(isWanRequest(lanClientReq, { clientIp: "192.168.31.20" })).toBe(
      false,
    );
  });

  it("rejects API keys and tokens in query strings", () => {
    const queryReq1 = new Request(
      "http://127.0.0.1:8086/api/upload?token=my-secret-key-123",
      {
        method: "POST",
        headers: { host: "reading.wavypremium.xyz" },
      },
    );
    expect(
      authenticateRequest(queryReq1, { apiKey: "my-secret-key-123" })
        .authenticated,
    ).toBe(false);

    const queryReq2 = new Request(
      "http://127.0.0.1:8086/api/upload?auth=my-secret-key-123",
      {
        method: "POST",
        headers: { host: "reading.wavypremium.xyz" },
      },
    );
    expect(
      authenticateRequest(queryReq2, { apiKey: "my-secret-key-123" })
        .authenticated,
    ).toBe(false);
  });

  it("strictly enforces Origin or Referer for cookie-authenticated mutating requests", () => {
    const cookieReqNoOrigin = new Request("http://127.0.0.1:8086/api/books/1", {
      method: "DELETE",
      headers: {
        host: "reading.wavypremium.xyz",
        cookie: "reading_token=my-secret-key-123",
      },
    });
    const check1 = validateOriginAndCsrf(cookieReqNoOrigin, {
      isCookieAuth: true,
    });
    expect(check1.valid).toBe(false);
    expect(check1.error).toContain("Origin or Referer");

    const cookieReqWithOrigin = new Request(
      "http://127.0.0.1:8086/api/books/1",
      {
        method: "DELETE",
        headers: {
          host: "reading.wavypremium.xyz",
          cookie: "reading_token=my-secret-key-123",
          origin: "https://reading.wavypremium.xyz",
        },
      },
    );
    const check2 = validateOriginAndCsrf(cookieReqWithOrigin, {
      isCookieAuth: true,
    });
    expect(check2.valid).toBe(true);
  });

  it("isAllowedCoverUrl blocks private and internal IP targets", () => {
    expect(isAllowedCoverUrl("http://169.254.169.254/latest/meta-data")).toBe(
      false,
    );
    expect(isAllowedCoverUrl("http://127.0.0.1:8088/cover.jpg")).toBe(false);
    expect(isAllowedCoverUrl("http://192.168.1.1/admin.jpg")).toBe(false);
    expect(isAllowedCoverUrl("http://router.lan/cover.png")).toBe(false);
    expect(isAllowedCoverUrl("ftp://example.com/cover.jpg")).toBe(false);
    expect(isAllowedCoverUrl("http://user:pass@example.com/cover.jpg")).toBe(
      false,
    );
    expect(isAllowedCoverUrl("https://images.example.com/cover.jpg")).toBe(
      true,
    );
  });

  it("safeFetchWithSsrf blocks requests to private IPs and redirects to internal endpoints", async () => {
    await expect(safeFetchWithSsrf("http://127.0.0.1:8088/")).rejects.toThrow(
      "SSRF",
    );
    await expect(
      safeFetchWithSsrf("http://169.254.169.254/latest/meta-data/"),
    ).rejects.toThrow("SSRF");
  });

  it("meterStream enforces byte limits on streaming bodies", async () => {
    const chunk = new Uint8Array(1024 * 1024); // 1MB
    const stream = new ReadableStream({
      start(controller) {
        controller.enqueue(chunk);
        controller.enqueue(chunk);
        controller.close();
      },
    });

    const metered = await meterStream(stream, 1.5 * 1024 * 1024); // 1.5MB limit
    expect(metered.exceeded).toBe(true);
  });

  it("validateEpubContent validates genuine EPUB zip archives and rejects fake files", () => {
    const tempEpub = `/tmp/test_valid_${Date.now()}.epub`;
    const pythonScript = `
import zipfile
with zipfile.ZipFile("${tempEpub}", "w") as z:
    z.writestr("mimetype", "application/epub+zip")
    z.writestr("META-INF/container.xml", "<?xml version='1.0'?><container/>")
`;
    Bun.spawnSync(["python3", "-c", pythonScript]);

    try {
      const validCheck = validateEpubContent(tempEpub);
      expect(validCheck.valid).toBe(true);

      const fakeEpub = `/tmp/test_fake_${Date.now()}.epub`;
      fs.writeFileSync(
        fakeEpub,
        "This is not a zip file, just plain text. ".repeat(5),
      );
      const fakeCheck = validateEpubContent(fakeEpub);
      expect(fakeCheck.valid).toBe(false);
      expect(fakeCheck.error).toContain("Missing ZIP container");
      fs.unlinkSync(fakeEpub);
    } finally {
      if (fs.existsSync(tempEpub)) fs.unlinkSync(tempEpub);
    }
  });

  it("handleRequest rejects fake EPUB direct upload with 400", async () => {
    const formData = new FormData();
    const fakeEpubBlob = new Blob(
      ["This is a shell script or text disguised as epub"],
      { type: "application/epub+zip" },
    );
    formData.append("file", fakeEpubBlob, "malicious.epub");

    const req = new Request("http://127.0.0.1:8086/api/upload", {
      method: "POST",
      headers: { host: "127.0.0.1:8086" },
      body: formData,
    });

    const res = await handleRequest(req);
    expect(res.status).toBe(400);
    const data = (await res.json()) as any;
    expect(data.success).toBe(false);
    expect(data.error).toContain("valid EPUB archive");
  });

  it("redactJobRecord redacts filesystem paths and secrets from payloads and results", () => {
    const rawJob = {
      id: "job_123",
      type: "file_ingest",
      payload: {
        filePath: "/Users/ospeto/Books_Drop/test_book.epub",
        apiKey: "super-secret-token",
        authHeader: "Bearer token-12345",
      },
      status: "completed",
      retries: 0,
      max_retries: 3,
      created_at: 1000,
      updated_at: 2000,
      next_run_at: 1000,
      result: {
        success: true,
        calibrePath: "/Users/ospeto/Calibre Libraries/Agent Library/book.epub",
      },
      error: "Error opening /Users/ospeto/secret.txt with key=abc12345",
    };

    const redacted = redactJobRecord(rawJob);
    expect(redacted.payload.filePath).not.toContain("/Users/ospeto");
    expect(redacted.payload.filePath).toContain("[path]/test_book.epub");
    expect(redacted.payload.apiKey).toBe("[REDACTED]");
    expect(redacted.payload.authHeader).toBe("[REDACTED]");
    expect(redacted.result.calibrePath).not.toContain("/Users/ospeto");
    expect(redacted.error).not.toContain("/Users/ospeto");
    expect(redacted.error).toContain("[path]");
    expect(redacted.error).toContain("[REDACTED]");
  });

  it("resets retry counter to 0 on manual retry", () => {
    const testDb = new Database(":memory:");
    const queue = new DurableJobQueue(testDb);

    const job = queue.enqueue(
      "file_ingest",
      { name: "test" },
      { maxRetries: 3 },
    );
    testDb
      .prepare(
        "UPDATE jobs SET status = 'failed', retries = 3, error = 'Exhausted' WHERE id = ?",
      )
      .run(job.id);

    const retried = queue.retryJob(job.id);
    expect(retried?.status).toBe("pending");
    expect(retried?.retries).toBe(0);
    expect(retried?.error).toBeNull();
  });

  it("recovers hung worker jobs with expired leases", () => {
    const testDb = new Database(":memory:");
    const queue = new DurableJobQueue(testDb);

    const expiredTime = Date.now() - 100000;
    testDb
      .prepare(
        `INSERT INTO jobs (id, type, payload, status, retries, max_retries, created_at, updated_at, next_run_at, worker_id, lease_expires_at)
       VALUES ('hung_job_1', 'file_ingest', '{"name":"hung"}', 'processing', 0, 3, 1000, 1000, 1000, 'worker_dead', ?)`,
      )
      .run(expiredTime);

    const recovered = queue.recoverInterruptedJobs();
    expect(recovered).toBe(1);

    const recoveredJob = queue.getJob("hung_job_1");
    expect(recoveredJob?.status).toBe("pending");
    expect(recoveredJob?.retries).toBe(1);
    expect(recoveredJob?.worker_id).toBeNull();
  });

  it("withCalibreLock serializes concurrent write executions", async () => {
    const order: number[] = [];
    const task1 = withCalibreLock(async () => {
      await new Promise((r) => setTimeout(r, 50));
      order.push(1);
    });
    const task2 = withCalibreLock(async () => {
      order.push(2);
    });

    await Promise.all([task1, task2]);
    expect(order).toEqual([1, 2]);

    const syncRes = withCalibreLockSync(() => 42);
    expect(syncRes).toBe(42);
  });

  it("routes URL ingestion through durable queue end-to-end", async () => {
    const testDb = new Database(":memory:");
    const queue = new DurableJobQueue(testDb);

    let handlerInvoked = false;
    queue.registerHandler("url_ingest", async (payload) => {
      handlerInvoked = true;
      return { success: true, title: "Test Article", url: payload.url };
    });

    const job = queue.enqueue("url_ingest", {
      url: "https://example.com/article",
    });
    expect(job.id).toBeDefined();
    expect(job.status).toBe("pending");

    const outcome = await queue.executeJob(job.id);
    expect(outcome.status).toBe("completed");
    expect(outcome.result.title).toBe("Test Article");
    expect(handlerInvoked).toBe(true);
  });

  it("routes file uploads through durable queue end-to-end", async () => {
    const testDb = new Database(":memory:");
    const queue = new DurableJobQueue(testDb);

    let handlerInvoked = false;
    queue.registerHandler("file_ingest", async (payload) => {
      handlerInvoked = true;
      return {
        success: true,
        bookId: 101,
        displayTitle: payload.originalFileName,
      };
    });

    const job = queue.enqueue("file_ingest", {
      filePath: "/tmp/mock.epub",
      originalFileName: "mock.epub",
    });
    const outcome = await queue.executeJob(job.id);
    expect(outcome.status).toBe("completed");
    expect(outcome.result.bookId).toBe(101);
    expect(handlerInvoked).toBe(true);
  });

  it("inspectArchiveSafety strictly rejects archives containing symlink entries", () => {
    const tempZip = `/tmp/test_symlink_${Date.now()}.zip`;
    const pythonScript = `
import zipfile
zinfo = zipfile.ZipInfo("bad_link.epub")
zinfo.create_system = 3
zinfo.external_attr = 0o120777 << 16
with zipfile.ZipFile("${tempZip}", "w") as z:
    z.writestr(zinfo, "/etc/passwd")
`;
    Bun.spawnSync(["python3", "-c", pythonScript]);

    try {
      const inspection = inspectArchiveSafety(tempZip);
      expect(inspection.safe).toBe(false);
      expect(inspection.error).toContain("symlink");
    } finally {
      if (fs.existsSync(tempZip)) fs.unlinkSync(tempZip);
    }
  });

  it("isSameBookIdentity and isSameBook require author matching and never match on title alone", () => {
    // 1. Stable import ID match
    expect(
      isSameBookIdentity(
        { id: 10, importId: "imp-123", title: "Book A", author: "Author A" },
        {
          id: 20,
          importId: "imp-123",
          title: "Different Title",
          author: "Different Author",
        },
      ),
    ).toBe(true);

    // 2. ISBN match & conflict
    expect(
      isSameBookIdentity(
        { isbn: "978-0-12345-678-9", title: "Book A", author: "Author A" },
        { isbn: "9780123456789", title: "Book B", author: "Author B" },
      ),
    ).toBe(true);

    expect(
      isSameBookIdentity(
        { isbn: "978-0-11111-111-1", title: "Book A", author: "Author A" },
        { isbn: "978-0-22222-222-2", title: "Book A", author: "Author A" },
      ),
    ).toBe(false);

    // 3. Same title but DIFFERENT author must NEVER match!
    expect(
      isSameBookIdentity(
        { title: "The Odyssey", author: "Homer" },
        { title: "The Odyssey", author: "John Smith" },
      ),
    ).toBe(false);

    expect(
      isSameBook(
        { title: "The Odyssey", authors: "Homer" },
        { title: "The Odyssey", author: "John Smith" },
      ),
    ).toBe(false);

    // 4. Same title and matching author
    expect(
      isSameBookIdentity(
        { title: "The Odyssey", author: "Homer" },
        { title: "The Odyssey", author: "Homer" },
      ),
    ).toBe(true);

    expect(
      isSameBook(
        { title: "The Odyssey", authors: "Homer" },
        { title: "The Odyssey", author: "Homer" },
      ),
    ).toBe(true);

    // 5. Unknown author must not match by title alone
    expect(
      isSameBookIdentity(
        { title: "Common Title", author: "Unknown" },
        { title: "Common Title", author: "Unknown" },
      ),
    ).toBe(false);
  });

  it("generateTypographicCover provides hermetic SVG cover fallback", () => {
    // Generate cover - works regardless of whether macOS sips is present
    const coverPath = generateTypographicCover(
      "Hermetic Article",
      "Portable Author",
      "Security News",
    );
    expect(fs.existsSync(coverPath)).toBe(true);
    expect(coverPath.endsWith(".jpg") || coverPath.endsWith(".svg")).toBe(true);
    if (fs.existsSync(coverPath)) {
      fs.unlinkSync(coverPath);
    }
  });

  it("getDropDir is configurable via environment and safely falls back without throwing", () => {
    const originalEnv = process.env.BOOKS_DROP_DIR;
    try {
      const tempDrop = `/tmp/test_custom_drop_${Date.now()}`;
      process.env.BOOKS_DROP_DIR = tempDrop;
      const resolved = getDropDir();
      expect(resolved).toBe(tempDrop);
      expect(fs.existsSync(tempDrop)).toBe(true);
      fs.rmdirSync(tempDrop);
    } finally {
      if (originalEnv) {
        process.env.BOOKS_DROP_DIR = originalEnv;
      } else {
        delete process.env.BOOKS_DROP_DIR;
      }
    }
  });

  it("safeFetchWithSsrf rejects unresolvable domains and strictly validates proxy targets", async () => {
    // Unresolvable domain must be rejected, not bypassed
    await expect(
      safeFetchWithSsrf("https://nonexistent-fake-domain-123456.example/"),
    ).rejects.toThrow("DNS resolution failed");
  });
});
