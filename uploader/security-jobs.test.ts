import { describe, expect, it } from "bun:test";
import { Database } from "bun:sqlite";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import {
  isPrivateOrInternalIp,
  validateUrlForSSRF,
  safeFetchWithSsrf,
  isWanRequest,
  authenticateRequest,
  isAllowedOrigin,
  validateOriginAndCsrf,
  validateIntegerId,
  validateBookFormat,
  isCanonicalEpub,
  validateEpubContent,
  repairTruncatedEpub,
  parseStrictXml,
  sanitizeFilename,
  getDownloadFilename,
  sanitizeErrorMessage,
  validateTelegramWebAppData,
  getBsdtarPath,
} from "./security";
import zlib from "node:zlib";
import {
  inspectArchiveSafety,
  unpackArchive,
  isArchiveFile,
  isSupportedBook,
} from "./archive";
import { DurableJobQueue } from "./jobs";
import { handleRequest } from "./server";

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
    expect(isPrivateOrInternalIp("::ffff:8.8.8.8")).toBe(false);
    expect(isPrivateOrInternalIp("::ffff:7f00:1")).toBe(true);
    expect(isPrivateOrInternalIp("::ffff:c0a8:101")).toBe(true);
    expect(isPrivateOrInternalIp("0:0:0:0:0:ffff:7f00:1")).toBe(true);
  });

  it("normalizes and blocks decimal, hex, and octal IP representations", () => {
    // 127.0.0.1 in decimal integer: 2130706433
    expect(isPrivateOrInternalIp("2130706433")).toBe(true);
    // 127.0.0.1 in hex: 0x7f000001
    expect(isPrivateOrInternalIp("0x7f000001")).toBe(true);
    // 127.0.0.1 in octal: 0177.0.0.1
    expect(isPrivateOrInternalIp("0177.0.0.1")).toBe(true);
  });

  it("allows standard public internet IPv4 and IPv6 addresses", () => {
    expect(isPrivateOrInternalIp("8.8.8.8")).toBe(false);
    expect(isPrivateOrInternalIp("1.1.1.1")).toBe(false);
    expect(isPrivateOrInternalIp("104.21.5.19")).toBe(false);
    expect(isPrivateOrInternalIp("2001:4860:4860::8888")).toBe(false);
    expect(isPrivateOrInternalIp("2606:4700:4700::1111")).toBe(false);
    expect(isPrivateOrInternalIp("ff02::1")).toBe(true);
    expect(isPrivateOrInternalIp("2001:db8::1")).toBe(true);
  });

  it("validates every A and AAAA result and preserves an allowed IPv6 snapshot", async () => {
    const safe = await validateUrlForSSRF("http://dualstack.example.test/", {
      dnsLookup: async () => [
        { address: "198.51.100.20", family: 4 },
        { address: "2001:4860:4860::8888", family: 6 },
      ],
    });
    expect(safe.safe).toBe(false);

    const publicOnly = await validateUrlForSSRF(
      "http://dualstack.example.test/",
      {
        dnsLookup: async () => [
          { address: "93.184.216.34", family: 4 },
          { address: "2001:4860:4860::8888", family: 6 },
        ],
      },
    );
    expect(publicOnly.safe).toBe(true);
    expect(publicOnly.resolvedAddresses?.map((entry) => entry.family)).toEqual([
      4, 6,
    ]);
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

  it("allowInternalServices enables only the explicit loopback service allowlist", async () => {
    const enabled = await validateUrlForSSRF("http://127.0.0.1:8088/status", {
      allowInternalServices: true,
    });
    expect(enabled.safe).toBe(true);
    expect(enabled.resolvedIp).toBe("127.0.0.1");

    const disabled = await validateUrlForSSRF("http://127.0.0.1:8088/status");
    expect(disabled.safe).toBe(false);

    const wrongPort = await validateUrlForSSRF("http://127.0.0.1:8089/status", {
      allowInternalServices: true,
    });
    expect(wrongPort.safe).toBe(false);
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

  it("safeFetchWithSsrf blocks redirects targeting internal or link-local endpoints", async () => {
    let thrownError: Error | null = null;
    try {
      await safeFetchWithSsrf("http://169.254.169.254/latest/meta-data/");
    } catch (err: any) {
      thrownError = err;
    }
    expect(thrownError).not.toBeNull();
    expect(thrownError?.message).toContain("SSRF");
  });

  it("enforces that safeFetchWithSsrf is the only production outbound fetch entry point in uploader/", () => {
    const uploaderDir = path.resolve(__dirname);
    const files = fs
      .readdirSync(uploaderDir)
      .filter((f) => f.endsWith(".ts") && !f.endsWith(".test.ts"));

    const violations: string[] = [];

    for (const f of files) {
      if (f === "security.ts") continue; // The single helper is defined here
      const fullPath = path.join(uploaderDir, f);
      const content = fs.readFileSync(fullPath, "utf8");
      const lines = content.split("\n");

      lines.forEach((line, idx) => {
        const trimmed = line.trim();
        if (trimmed.startsWith("//") || trimmed.startsWith("*")) return;
        // Bun server export: fetch(req: any, server: any)
        if (/fetch\s*\(\s*req\b/.test(trimmed)) return;

        // Check for raw fetch( or globalThis.fetch
        // Matches fetch( when NOT preceded by 'safe'
        if (
          /(?<!safe)fetch\s*\(/.test(trimmed) ||
          /globalThis\.fetch\b/.test(trimmed)
        ) {
          violations.push(`${f}:${idx + 1}: ${trimmed}`);
        }
      });
    }

    expect(violations).toEqual([]);
  });

  it("safeFetchWithSsrf successfully fetches public URLs with IP binding", async () => {
    const res = await safeFetchWithSsrf(
      "https://en.wikipedia.org/wiki/E-book",
      {
        method: "HEAD",
        headers: { "User-Agent": "ReadingHQ-Test/1.0" },
        signal: AbortSignal.timeout(10000),
      },
    );
    expect(res.status).toBe(200);
  }, 15000);

  it("safeFetchWithSsrf preserves the original hostname while binding a validated address", async () => {
    const server = Bun.serve({
      hostname: "127.0.0.1",
      port: 8088,
      fetch(req: Request) {
        return new Response(new URL(req.url).host);
      },
    });

    try {
      const res = await safeFetchWithSsrf(
        "http://localhost:8088/bound",
        { signal: AbortSignal.timeout(3000) },
        5,
        {
          allowInternalServices: true,
          dnsLookup: async () => [{ address: "127.0.0.1", family: 4 }],
        },
      );
      expect(res.status).toBe(200);
      expect(await res.text()).toBe("localhost:8088");
    } finally {
      server.stop(true);
    }
  });

  it("safeFetchWithSsrf rejects redirects to localhost or private IPs", async () => {
    const redirectServer = Bun.serve({
      port: 0,
      fetch(req: any) {
        const u = new URL(req.url);
        if (u.pathname === "/init") {
          return new Response(null, {
            status: 302,
            headers: { Location: "http://127.0.0.1:8089/admin-secret" },
          });
        }
        return new Response("OK");
      },
    });

    try {
      let err: Error | null = null;
      try {
        await safeFetchWithSsrf(
          `http://127.0.0.1:${redirectServer.port}/init`,
          { signal: AbortSignal.timeout(3000) },
          5,
          { allowInternalServices: true },
        );
      } catch (e: any) {
        err = e;
      }
      expect(err).not.toBeNull();
      expect(err?.message).toContain("SSRF guard blocked target");
    } finally {
      redirectServer.stop(true);
    }
  });

  it("safeFetchWithSsrf rejects redirect re-binding targeting internal/loopback addresses", async () => {
    const redirectServer = Bun.serve({
      port: 0,
      fetch(req: any) {
        const u = new URL(req.url);
        if (u.pathname === "/rebind") {
          return new Response(null, {
            status: 302,
            headers: { Location: "http://localhost:8089/secret" },
          });
        }
        return new Response("OK");
      },
    });

    try {
      let err: Error | null = null;
      try {
        await safeFetchWithSsrf(
          `http://127.0.0.1:${redirectServer.port}/rebind`,
          { signal: AbortSignal.timeout(3000) },
          5,
          { allowInternalServices: true },
        );
      } catch (e: any) {
        err = e;
      }
      expect(err).not.toBeNull();
      expect(err?.message).toContain("SSRF guard blocked target");
    } finally {
      redirectServer.stop(true);
    }
  });

  it("safeFetchWithSsrf enforces proxy rejection for internal, metadata, or unauthorized proxy targets", async () => {
    // 1. Direct private IP target rejected even if proxy is supplied
    let err1: Error | null = null;
    try {
      await safeFetchWithSsrf("http://127.0.0.1:8088/secret", {
        proxy: "http://127.0.0.1:7890",
      } as any);
    } catch (e: any) {
      err1 = e;
    }
    expect(err1).not.toBeNull();
    expect(err1?.message).toContain("SSRF guard blocked target");

    // 2. Malicious proxy pointing to cloud metadata (169.254.169.254) rejected
    let err2: Error | null = null;
    try {
      await safeFetchWithSsrf("https://en.wikipedia.org/wiki/E-book", {
        proxy: "http://169.254.169.254:80",
      } as any);
    } catch (e: any) {
      err2 = e;
    }
    expect(err2).not.toBeNull();
    expect(err2?.message).toContain("SSRF guard blocked proxy target");

    // 3. allowProxyBypass cannot bypass cloud metadata or link-local endpoints
    const metaCheck = await validateUrlForSSRF(
      "http://169.254.169.254/latest/meta-data/",
      { allowProxyBypass: true },
    );
    expect(metaCheck.safe).toBe(false);
  });
});

describe("Public WAN & API Surface Hardening — WAN vs LAN & Authentication", () => {
  it("classifies requests by host and proxy headers", () => {
    // LAN request with verified local peer address
    const lanReq = new Request("http://192.168.31.15:8086/api/books", {
      headers: { host: "192.168.31.15:8086" },
    });
    expect(isWanRequest(lanReq, { remoteAddress: "192.168.31.15" })).toBe(
      false,
    );

    // Unverified request without socket address fails closed to WAN
    expect(isWanRequest(lanReq)).toBe(true);

    // WAN request via domain with local tunnel socket
    const wanReq1 = new Request("http://127.0.0.1:8086/api/books", {
      headers: { host: "reading.wavypremium.xyz" },
    });
    expect(isWanRequest(wanReq1, { remoteAddress: "127.0.0.1" })).toBe(true);

    // WAN request via X-Forwarded-Host with local tunnel socket
    const wanReq2 = new Request("http://127.0.0.1:8086/api/books", {
      headers: {
        host: "127.0.0.1:8086",
        "x-forwarded-host": "reading.wavypremium.xyz",
      },
    });
    expect(isWanRequest(wanReq2, { remoteAddress: "127.0.0.1" })).toBe(true);

    // WAN request via public client X-Forwarded-For through local tunnel socket
    const wanReq3 = new Request("http://127.0.0.1:8086/api/books", {
      headers: {
        host: "127.0.0.1:8086",
        "x-forwarded-for": "8.8.8.8",
      },
    });
    expect(isWanRequest(wanReq3, { remoteAddress: "127.0.0.1" })).toBe(true);

    // Direct public client (93.184.216.34) fails closed to WAN
    expect(isWanRequest(lanReq, { remoteAddress: "93.184.216.34" })).toBe(true);
  });

  it("authenticateRequest passes local LAN requests without credentials", () => {
    const lanReq = new Request("http://192.168.31.15:8086/api/upload", {
      method: "POST",
      headers: { host: "192.168.31.15:8086" },
    });
    const result = authenticateRequest(lanReq, {
      remoteAddress: "192.168.31.15",
      apiKey: "secret123",
    });
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

  it("authenticateRequest blocks public client spoofing LAN host header", () => {
    // Public client (93.184.216.34) connecting directly, sending spoofed LAN Host header
    const spoofedReq = new Request("http://192.168.31.15:8086/api/upload", {
      method: "POST",
      headers: { host: "192.168.31.15:8086" },
    });
    const result = authenticateRequest(spoofedReq, {
      remoteAddress: "93.184.216.34",
      apiKey: "secret123",
    });
    expect(result.authenticated).toBe(false);
    expect(result.error).toContain(
      "Authentication required for public WAN access",
    );
  });

  it("authenticateRequest never accepts query-string credentials", () => {
    const queryReq = new Request(
      "http://127.0.0.1:8086/api/upload?token=my-secret-key-123",
      {
        method: "POST",
        headers: { host: "reading.wavypremium.xyz" },
      },
    );
    const result = authenticateRequest(queryReq, {
      apiKey: "my-secret-key-123",
    });
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
    expect(isAllowedOrigin("http://kosync-sg.wavypremium.xyz")).toBe(true);
    expect(isAllowedOrigin("https://kosync-sg.wavypremium.xyz:8443")).toBe(true);
    expect(isAllowedOrigin("http://opds.wavypremium.xyz")).toBe(true);
    expect(isAllowedOrigin("https://opds.wavypremium.xyz:8443")).toBe(true);
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

  it("validateOriginAndCsrf rejects mutating request with cookie auth when both Origin and Referer are absent", () => {
    const cookiePost = new Request("http://127.0.0.1:8086/api/books/1", {
      method: "DELETE",
      headers: {
        cookie: "reading_token=secret123",
      },
    });
    const check = validateOriginAndCsrf(cookiePost);
    expect(check.valid).toBe(false);
    expect(check.error).toContain("Origin or Referer");
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

    const errWithSecret = new Error(
      "Failed connecting with token=abc12345secret and key=mySecretKey",
    );
    const sanitizedSecret = sanitizeErrorMessage(errWithSecret);
    expect(sanitizedSecret).toContain("token=[REDACTED]");
    expect(sanitizedSecret).toContain("key=[REDACTED]");
    expect(sanitizedSecret).not.toContain("abc12345secret");
  });

  it("validateEpubContent validates ZIP magic bytes, mimetype, and required container", () => {
    const tempDir = path.join("/tmp", `test_epub_val_${Date.now()}`);
    const metaDir = path.join(tempDir, "META-INF");
    fs.mkdirSync(metaDir, { recursive: true });

    fs.writeFileSync(path.join(tempDir, "mimetype"), "application/epub+zip");
    fs.writeFileSync(path.join(metaDir, "container.xml"), "<container/>");

    const validEpub = path.join("/tmp", `valid_${Date.now()}.epub`);
    const { spawnSync } = require("node:child_process");
    spawnSync(getBsdtarPath(), [
      "--format",
      "zip",
      "-cf",
      validEpub,
      "-C",
      tempDir,
      "mimetype",
      "META-INF",
    ]);

    try {
      const validRes = validateEpubContent(validEpub);
      expect(validRes.valid).toBe(true);

      const fakeEpub = path.join("/tmp", `fake_${Date.now()}.epub`);
      fs.writeFileSync(
        fakeEpub,
        "not a zip file at all - this text simulates a corrupted non-zip file claiming to be an epub",
      );
      const fakeRes = validateEpubContent(fakeEpub);
      expect(fakeRes.valid).toBe(false);
      expect(fakeRes.error).toContain("magic bytes");
      if (fs.existsSync(fakeEpub)) {
        fs.unlinkSync(fakeEpub);
      }
    } finally {
      if (fs.existsSync(validEpub)) {
        fs.unlinkSync(validEpub);
      }
      if (fs.existsSync(tempDir)) {
        fs.rmSync(tempDir, { recursive: true, force: true });
      }
    }
  });

  it("parses EPUB with trailing bytes / non-zero bsdtar warning successfully via fallback", () => {
    const tempDir = path.join("/tmp", `test_epub_fallback_${Date.now()}`);
    const metaDir = path.join(tempDir, "META-INF");
    fs.mkdirSync(metaDir, { recursive: true });

    fs.writeFileSync(path.join(tempDir, "mimetype"), "application/epub+zip");
    fs.writeFileSync(path.join(metaDir, "container.xml"), "<container/>");

    const testEpub = path.join("/tmp", `fallback_${Date.now()}.epub`);
    const { spawnSync } = require("node:child_process");
    spawnSync(getBsdtarPath(), [
      "--format",
      "zip",
      "-cf",
      testEpub,
      "-C",
      tempDir,
      "mimetype",
      "META-INF",
    ]);

    // Append trailing bytes to simulate extra data / signatures after central directory
    fs.appendFileSync(
      testEpub,
      Buffer.from("\n\nEXTRA_TRAILING_DATA_KOBO_SIGNATURE_PADDING\n"),
    );

    // Mock bsdtar to exit with code 1 and warning to ensure fallback to unzip is exercised
    const mockBsdtarScript = path.join("/tmp", `mock_bsdtar_${Date.now()}.sh`);
    fs.writeFileSync(
      mockBsdtarScript,
      "#!/bin/sh\necho 'bsdtar: warning: damaged or non-standard zip entries' >&2\nexit 1\n",
    );
    fs.chmodSync(mockBsdtarScript, 0o755);

    const origBsdtar = process.env.BSDTAR_PATH;
    try {
      // 1. Direct validation with trailing bytes
      const resWithTrailing = validateEpubContent(testEpub);
      expect(resWithTrailing.valid).toBe(true);

      // 2. Validation when bsdtar fails with exit code 1 (simulating libarchive warning/failure)
      process.env.BSDTAR_PATH = mockBsdtarScript;
      const resFallback = validateEpubContent(testEpub);
      expect(resFallback.valid).toBe(true);
    } finally {
      if (origBsdtar === undefined) {
        delete process.env.BSDTAR_PATH;
      } else {
        process.env.BSDTAR_PATH = origBsdtar;
      }
      if (fs.existsSync(mockBsdtarScript)) {
        fs.unlinkSync(mockBsdtarScript);
      }
      if (fs.existsSync(testEpub)) {
        fs.unlinkSync(testEpub);
      }
      if (fs.existsSync(tempDir)) {
        fs.rmSync(tempDir, { recursive: true, force: true });
      }
    }
  });

  it("validateEpubContent returns descriptive error on unparseable non-ZIP file", () => {
    // 1. Completely non-ZIP file (without PK magic bytes)
    const nonZipFile = path.join("/tmp", `non_zip_${Date.now()}.epub`);
    fs.writeFileSync(
      nonZipFile,
      "This is plain text with no zip header or structure whatsoever.",
    );

    try {
      const resNonZip = validateEpubContent(nonZipFile);
      expect(resNonZip.valid).toBe(false);
      expect(resNonZip.error).toContain("Invalid magic bytes");

      // 2. File starting with PK\x03\x04 magic bytes but followed by unparseable corrupt bytes
      const corruptZipFile = path.join("/tmp", `corrupt_pk_${Date.now()}.epub`);
      fs.writeFileSync(
        corruptZipFile,
        Buffer.concat([
          Buffer.from([0x50, 0x4b, 0x03, 0x04]),
          Buffer.alloc(200, 0),
        ]),
      );

      try {
        const resCorrupt = validateEpubContent(corruptZipFile);
        expect(resCorrupt.valid).toBe(false);
        // Returns descriptive error containing process output rather than bare generic string
        expect(resCorrupt.error).toContain("Failed to read EPUB ZIP entries");
        expect(
          resCorrupt.error?.includes("bsdtar:") ||
            resCorrupt.error?.includes("unzip:"),
        ).toBe(true);
      } finally {
        if (fs.existsSync(corruptZipFile)) {
          fs.unlinkSync(corruptZipFile);
        }
      }
    } finally {
      if (fs.existsSync(nonZipFile)) {
        fs.unlinkSync(nonZipFile);
      }
    }
  });

  describe("In-Process ZIP Auto-Healer (repairTruncatedEpub)", () => {
    function buildSyntheticZipEntry(
      name: string,
      data: Buffer,
      compMethod = 0,
      compData: Buffer | null = null,
    ): Buffer {
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

    function buildCoreEpubEntries(): Buffer[] {
      const mimeData = Buffer.from("application/epub+zip");
      const mimePart = buildSyntheticZipEntry("mimetype", mimeData, 0);

      const containerXml = Buffer.from(
        '<?xml version="1.0"?><container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container"><rootfiles><rootfile full-path="content.opf" media-type="application/oebps-package+xml"/></rootfiles></container>',
      );
      const containerDef = zlib.deflateRawSync(containerXml);
      const containerPart = buildSyntheticZipEntry(
        "META-INF/container.xml",
        containerXml,
        8,
        containerDef,
      );

      const opfXml = Buffer.from(
        '<?xml version="1.0"?><package xmlns="http://www.idpf.org/2007/opf" version="3.0"><metadata><dc:title>Test Title</dc:title></metadata><manifest/><spine/></package>',
      );
      const opfDef = zlib.deflateRawSync(opfXml);
      const opfPart = buildSyntheticZipEntry("content.opf", opfXml, 8, opfDef);

      return [mimePart, containerPart, opfPart];
    }

    it("auto-heals a synthetic EPUB missing its central directory and validates successfully", () => {
      const parts = buildCoreEpubEntries();
      const testPath = path.join("/tmp", `test_autoheal_${Date.now()}.epub`);
      // Concatenate entries with NO Central Directory or EOCD
      fs.writeFileSync(testPath, Buffer.concat(parts));

      try {
        // Initial validation fails due to missing central directory
        const initialVal = validateEpubContent(testPath);
        expect(initialVal.valid).toBe(false);
        expect(initialVal.error).toContain("Failed to read EPUB ZIP entries");

        // Repair in-process
        const start = performance.now();
        const healed = repairTruncatedEpub(testPath);
        const durationMs = performance.now() - start;

        expect(healed).toBe(true);
        expect(durationMs).toBeLessThan(50); // fast <50ms bound

        // Validation now passes
        const afterVal = validateEpubContent(testPath);
        expect(afterVal.valid).toBe(true);
      } finally {
        if (fs.existsSync(testPath)) fs.unlinkSync(testPath);
      }
    });

    it("auto-heals a synthetic EPUB with trailing zero padding from interrupted upload", () => {
      const parts = buildCoreEpubEntries();
      const testPath = path.join("/tmp", `test_padding_${Date.now()}.epub`);
      // Entries + 4KB trailing null bytes
      fs.writeFileSync(
        testPath,
        Buffer.concat([...parts, Buffer.alloc(4096, 0)]),
      );

      try {
        const initialVal = validateEpubContent(testPath);
        expect(initialVal.valid).toBe(false);

        const healed = repairTruncatedEpub(testPath);
        expect(healed).toBe(true);

        const afterVal = validateEpubContent(testPath);
        expect(afterVal.valid).toBe(true);
      } finally {
        if (fs.existsSync(testPath)) fs.unlinkSync(testPath);
      }
    });

    it("discards trailing incomplete compressed entry while keeping core EPUB metadata", () => {
      const parts = buildCoreEpubEntries();

      // Create an incomplete/corrupted trailing chapter
      const chapXml = Buffer.from('<!DOCTYPE html><html><body><h1>Chapter 1</h1></body></html>');
      const chapDef = zlib.deflateRawSync(chapXml);
      // Cut compressed stream to only 4 bytes (truncated deflate stream)
      const chapIncomplete = chapDef.subarray(0, 4);
      const chapPart = buildSyntheticZipEntry("chapter1.xhtml", chapXml, 8, chapIncomplete);

      const testPath = path.join("/tmp", `test_trailing_incomplete_${Date.now()}.epub`);
      fs.writeFileSync(
        testPath,
        Buffer.concat([...parts, chapPart, Buffer.alloc(1024, 0)]),
      );

      try {
        const initialVal = validateEpubContent(testPath);
        expect(initialVal.valid).toBe(false);

        const healed = repairTruncatedEpub(testPath);
        expect(healed).toBe(true);

        const afterVal = validateEpubContent(testPath);
        expect(afterVal.valid).toBe(true);
      } finally {
        if (fs.existsSync(testPath)) fs.unlinkSync(testPath);
      }
    });

    it("fails cleanly without hanging on non-zip, corrupted, or non-EPUB files", () => {
      // 1. Non-existent file
      expect(repairTruncatedEpub("/tmp/nonexistent_file_12345.epub")).toBe(false);

      // 2. Non-ZIP text file
      const textPath = path.join("/tmp", `text_${Date.now()}.epub`);
      fs.writeFileSync(textPath, "Just plain text");
      try {
        const start = performance.now();
        expect(repairTruncatedEpub(textPath)).toBe(false);
        expect(performance.now() - start).toBeLessThan(20);
      } finally {
        if (fs.existsSync(textPath)) fs.unlinkSync(textPath);
      }

      // 3. Null bytes starting with PK magic but no valid entries
      const corruptPath = path.join("/tmp", `corrupt_${Date.now()}.epub`);
      fs.writeFileSync(
        corruptPath,
        Buffer.concat([Buffer.from([0x50, 0x4b, 0x03, 0x04]), Buffer.alloc(100, 0)]),
      );
      try {
        const start = performance.now();
        expect(repairTruncatedEpub(corruptPath)).toBe(false);
        expect(performance.now() - start).toBeLessThan(20);
      } finally {
        if (fs.existsSync(corruptPath)) fs.unlinkSync(corruptPath);
      }

      // 4. Valid ZIP entries but missing core EPUB metadata (missing container.xml and opf)
      const nonEpubPath = path.join("/tmp", `non_epub_${Date.now()}.epub`);
      const fooData = Buffer.from("hello world");
      const fooPart = buildSyntheticZipEntry("foo.txt", fooData, 0);
      fs.writeFileSync(nonEpubPath, fooPart);
      try {
        expect(repairTruncatedEpub(nonEpubPath)).toBe(false);
      } finally {
        if (fs.existsSync(nonEpubPath)) fs.unlinkSync(nonEpubPath);
      }
    });

    it("rejects malformed core XML (container.xml not XML, OPF missing rootfile, incomplete OPF, unclosed tags)", () => {
      const mimeData = Buffer.from("application/epub+zip");
      const mimePart = buildSyntheticZipEntry("mimetype", mimeData, 0);

      // Case A: container.xml is non-XML plaintext
      const badContainerXml = Buffer.from("Not XML container data");
      const badContainerPart = buildSyntheticZipEntry(
        "META-INF/container.xml",
        badContainerXml,
        8,
        zlib.deflateRawSync(badContainerXml),
      );
      const testPathA = path.join("/tmp", `bad_container_${Date.now()}.epub`);
      fs.writeFileSync(testPathA, Buffer.concat([mimePart, badContainerPart]));
      try {
        expect(repairTruncatedEpub(testPathA)).toBe(false);
      } finally {
        if (fs.existsSync(testPathA)) fs.unlinkSync(testPathA);
      }

      // Case B: container.xml is valid XML but lacks <rootfile full-path="..."/>
      const noRootfileXml = Buffer.from(
        '<?xml version="1.0"?><container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container"><rootfiles></rootfiles></container>',
      );
      const noRootfilePart = buildSyntheticZipEntry(
        "META-INF/container.xml",
        noRootfileXml,
        8,
        zlib.deflateRawSync(noRootfileXml),
      );
      const testPathB = path.join("/tmp", `no_rootfile_${Date.now()}.epub`);
      fs.writeFileSync(testPathB, Buffer.concat([mimePart, noRootfilePart]));
      try {
        expect(repairTruncatedEpub(testPathB)).toBe(false);
      } finally {
        if (fs.existsSync(testPathB)) fs.unlinkSync(testPathB);
      }

      // Case C: OPF XML lacks required <spine> element
      const validContainerXml = Buffer.from(
        '<?xml version="1.0"?><container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container"><rootfiles><rootfile full-path="OEBPS/content.opf"/></rootfiles></container>',
      );
      const validContainerPart = buildSyntheticZipEntry(
        "META-INF/container.xml",
        validContainerXml,
        8,
        zlib.deflateRawSync(validContainerXml),
      );
      const incompleteOpfXml = Buffer.from(
        '<?xml version="1.0"?><package xmlns="http://www.idpf.org/2007/opf" version="3.0"><metadata><dc:title>Test</dc:title></metadata><manifest/></package>',
      );
      const incompleteOpfPart = buildSyntheticZipEntry(
        "OEBPS/content.opf",
        incompleteOpfXml,
        8,
        zlib.deflateRawSync(incompleteOpfXml),
      );
      const testPathC = path.join("/tmp", `incomplete_opf_${Date.now()}.epub`);
      fs.writeFileSync(testPathC, Buffer.concat([mimePart, validContainerPart, incompleteOpfPart]));
      try {
        expect(repairTruncatedEpub(testPathC)).toBe(false);
      } finally {
        if (fs.existsSync(testPathC)) fs.unlinkSync(testPathC);
      }

      // Case D: container.xml has unclosed tag (<container><rootfiles><rootfile full-path="foo.opf"></container>)
      const unclosedContainerXml = Buffer.from(
        '<container><rootfiles><rootfile full-path="content.opf"></container>',
      );
      const unclosedContainerPart = buildSyntheticZipEntry(
        "META-INF/container.xml",
        unclosedContainerXml,
        8,
        zlib.deflateRawSync(unclosedContainerXml),
      );
      const testPathD = path.join("/tmp", `unclosed_container_${Date.now()}.epub`);
      fs.writeFileSync(testPathD, Buffer.concat([mimePart, unclosedContainerPart]));
      try {
        expect(repairTruncatedEpub(testPathD)).toBe(false);
      } finally {
        if (fs.existsSync(testPathD)) fs.unlinkSync(testPathD);
      }

      // Case E: OPF XML has unclosed tag (<package><metadata>...</package>)
      const unclosedOpfXml = Buffer.from(
        '<package><metadata><dc:title>Test</dc:title></package>',
      );
      const unclosedOpfPart = buildSyntheticZipEntry(
        "OEBPS/content.opf",
        unclosedOpfXml,
        8,
        zlib.deflateRawSync(unclosedOpfXml),
      );
      const testPathE = path.join("/tmp", `unclosed_opf_${Date.now()}.epub`);
      fs.writeFileSync(testPathE, Buffer.concat([mimePart, validContainerPart, unclosedOpfPart]));
      try {
        expect(repairTruncatedEpub(testPathE)).toBe(false);
      } finally {
        if (fs.existsSync(testPathE)) fs.unlinkSync(testPathE);
      }

      // Case F: container.xml has trailing unparsed tag fragment (<container>...</container><broken)
      const trailingBrokenContainerXml = Buffer.from(
        '<?xml version="1.0"?><container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container"><rootfiles><rootfile full-path="OEBPS/content.opf"/></rootfiles></container><broken',
      );
      const trailingBrokenContainerPart = buildSyntheticZipEntry(
        "META-INF/container.xml",
        trailingBrokenContainerXml,
        8,
        zlib.deflateRawSync(trailingBrokenContainerXml),
      );
      const validOpfXml = Buffer.from(
        '<?xml version="1.0"?><package xmlns="http://www.idpf.org/2007/opf" version="3.0"><metadata><dc:title>Test</dc:title></metadata><manifest/><spine/></package>',
      );
      const validOpfPart = buildSyntheticZipEntry(
        "OEBPS/content.opf",
        validOpfXml,
        8,
        zlib.deflateRawSync(validOpfXml),
      );
      const testPathF = path.join("/tmp", `trailing_broken_container_${Date.now()}.epub`);
      fs.writeFileSync(testPathF, Buffer.concat([mimePart, trailingBrokenContainerPart, validOpfPart]));
      try {
        expect(repairTruncatedEpub(testPathF)).toBe(false);
      } finally {
        if (fs.existsSync(testPathF)) fs.unlinkSync(testPathF);
      }

      // Case G: OPF XML has trailing unparsed tag fragment (<package>...</package><broken)
      const trailingBrokenOpfXml = Buffer.from(
        '<?xml version="1.0"?><package xmlns="http://www.idpf.org/2007/opf" version="3.0"><metadata><dc:title>Test</dc:title></metadata><manifest/><spine/></package><broken',
      );
      const trailingBrokenOpfPart = buildSyntheticZipEntry(
        "OEBPS/content.opf",
        trailingBrokenOpfXml,
        8,
        zlib.deflateRawSync(trailingBrokenOpfXml),
      );
      const testPathG = path.join("/tmp", `trailing_broken_opf_${Date.now()}.epub`);
      fs.writeFileSync(testPathG, Buffer.concat([mimePart, validContainerPart, trailingBrokenOpfPart]));
      try {
        expect(repairTruncatedEpub(testPathG)).toBe(false);
      } finally {
        if (fs.existsSync(testPathG)) fs.unlinkSync(testPathG);
      }
    });

    it("preserves original file untouched when candidate validation fails", () => {
      const mimeData = Buffer.from("application/epub+zip");
      const mimePart = buildSyntheticZipEntry("mimetype", mimeData, 0);
      const badContainerXml = Buffer.from("Corrupted container data");
      const badContainerPart = buildSyntheticZipEntry(
        "META-INF/container.xml",
        badContainerXml,
        8,
        zlib.deflateRawSync(badContainerXml),
      );

      const originalBuffer = Buffer.concat([mimePart, badContainerPart]);
      const targetPath = path.join("/tmp", `candidate_fail_${Date.now()}.epub`);
      fs.writeFileSync(targetPath, originalBuffer);

      try {
        const repaired = repairTruncatedEpub(targetPath);
        expect(repaired).toBe(false);

        // Target file must remain untouched with original content
        expect(fs.existsSync(targetPath)).toBe(true);
        const onDisk = fs.readFileSync(targetPath);
        expect(Buffer.compare(onDisk, originalBuffer)).toBe(0);

        // No leftover .repair.tmp file
        expect(fs.existsSync(`${targetPath}.repair.tmp`)).toBe(false);
      } finally {
        if (fs.existsSync(targetPath)) fs.unlinkSync(targetPath);
      }
    });

    it("bounds descriptorless streaming input scan to <50ms on sparse 64MB input without hanging", () => {
      // Entry with flag bit 3 (0x0008) set, compSize = 0, followed by 64MB sparse null bytes
      const h = Buffer.alloc(30 + 8);
      h.writeUInt32LE(0x04034b50, 0);
      h.writeUInt16LE(20, 4);
      h.writeUInt16LE(0x0008, 6); // flag bit 3 set
      h.writeUInt16LE(8, 8);
      h.writeUInt16LE(0, 10);
      h.writeUInt16LE(0, 12);
      h.writeUInt32LE(0, 14);
      h.writeUInt32LE(0, 18); // compSize = 0
      h.writeUInt32LE(0, 22); // uncompSize = 0
      h.writeUInt16LE(8, 26); // name length
      h.writeUInt16LE(0, 28); // extra length
      Buffer.from("test.txt").copy(h, 30);

      // 64MB file with sparse null padding
      const testPath = path.join("/tmp", `sparse_64mb_${Date.now()}.epub`);
      const fd = fs.openSync(testPath, "w");
      fs.writeSync(fd, h);
      fs.ftruncateSync(fd, 64 * 1024 * 1024);
      fs.closeSync(fd);

      try {
        const start = performance.now();
        const res = repairTruncatedEpub(testPath);
        const elapsed = performance.now() - start;

        expect(res).toBe(false);
        expect(elapsed).toBeLessThan(50); // Under 50ms bound
      } finally {
        if (fs.existsSync(testPath)) fs.unlinkSync(testPath);
      }
    });

    it("bounds marker-dense 64MB repeated PK input search to <50ms with probe cap", () => {
      // Create local header with bit 3 set, followed by repeated PK bytes (adversarial dense pattern)
      const h = Buffer.alloc(30 + 8);
      h.writeUInt32LE(0x04034b50, 0);
      h.writeUInt16LE(20, 4);
      h.writeUInt16LE(0x0008, 6); // flag bit 3 set
      h.writeUInt16LE(8, 8);
      h.writeUInt16LE(0, 10);
      h.writeUInt16LE(0, 12);
      h.writeUInt32LE(0, 14);
      h.writeUInt32LE(0, 18); // compSize = 0
      h.writeUInt32LE(0, 22); // uncompSize = 0
      h.writeUInt16LE(8, 26);
      h.writeUInt16LE(0, 28);
      Buffer.from("test.txt").copy(h, 30);

      // Create 64MB file with dense PK markers: repeated [0x50, 0x4b, 0x00, 0x00]
      const densePkBuf = Buffer.alloc(64 * 1024 * 1024);
      h.copy(densePkBuf, 0);
      for (let i = 38; i < densePkBuf.length; i += 4) {
        densePkBuf[i] = 0x50;
        densePkBuf[i + 1] = 0x4b;
      }

      const testPath = path.join("/tmp", `dense_pk_${Date.now()}.epub`);
      fs.writeFileSync(testPath, densePkBuf);

      try {
        const start = performance.now();
        const res = repairTruncatedEpub(testPath);
        const elapsed = performance.now() - start;

        expect(res).toBe(false);
        expect(elapsed).toBeLessThan(50); // Under 50ms bound guaranteed by MAX_DESCRIPTOR_PROBES = 128
      } finally {
        if (fs.existsSync(testPath)) fs.unlinkSync(testPath);
      }
    });

    it("strictly parses XML tags, attributes, and declaration positions", () => {
      // 1. Tag-end scanning is quote-aware: '>' inside attribute values is allowed
      expect(parseStrictXml('<root a="x>y"/>')).not.toBeNull();
      expect(parseStrictXml('<root a="x>y"></root>')).not.toBeNull();

      // 2. Attribute tokenizer requires whitespace before each attribute (rejects glued attributes)
      expect(parseStrictXml('<root a="1"b="2"/>')).toBeNull();

      // 3. Rejects duplicate attribute names on the same element
      expect(parseStrictXml('<root a="1" a="2"/>')).toBeNull();

      // 4. Rejects duplicate __proto__ attributes while accepting valid single __proto__
      expect(parseStrictXml('<root __proto__="1" __proto__="2"/>')).toBeNull();
      expect(parseStrictXml('<root __proto__="1"/>')).not.toBeNull();

      // 5. Allows valid CDATA containing '<?xml'
      expect(parseStrictXml('<root><![CDATA[<?xml fake?>]]></root>')).not.toBeNull();

      // 6. Rejects <?xml ...?> with leading whitespace or placed inside elements
      expect(parseStrictXml('\n<?xml version="1.0"?><root/>')).toBeNull();
      expect(parseStrictXml('<root><?xml version="1.0"?></root>')).toBeNull();

      // 7. Rejects malformed processing instructions like <?xml-stuff?>
      expect(parseStrictXml('<?xml-stuff?><root/>')).toBeNull();

      // 8. Allows valid <?xml ...?> strictly at index 0
      expect(parseStrictXml('<?xml version="1.0"?><root a="1" b="2"/>')).not.toBeNull();
    });
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
import zipfile, io
epub_buf = io.BytesIO()
with zipfile.ZipFile(epub_buf, "w") as ez:
    ez.writestr("mimetype", "application/epub+zip")
    ez.writestr("META-INF/container.xml", "<container/>")
with zipfile.ZipFile("${tempZip}", "w") as z:
    z.writestr("book1.epub", epub_buf.getvalue())
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
    const jobAfter2 = queue.getJob(job.id);
    expect(jobAfter2?.status).toBe("failed");
    expect(jobAfter2?.retries).toBe(2);
    expect(attempts).toBe(2);
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
  const localServer = { requestIP: () => ({ address: "127.0.0.1" }) };

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

    const res = await handleRequest(req, localServer);
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

    const res = await handleRequest(req, localServer);
    expect(res.status).toBe(400);
    const data = (await res.json()) as any;
    expect(data.success).toBe(false);
    expect(data.error).toContain("SSRF");
  });

  it("keeps read-only job inspection public on LAN and WAN", async () => {
    const lanReq = new Request("http://127.0.0.1:8086/api/jobs/recent", {
      method: "GET",
      headers: {
        host: "127.0.0.1:8086",
      },
    });

    const lanRes = await handleRequest(lanReq, localServer);
    expect(lanRes.status).toBe(200);
    const data = (await lanRes.json()) as any;
    expect(data.success).toBe(true);
    expect(Array.isArray(data.jobs)).toBe(true);

    // Captain-approved read-only reading-data boundary remains public on WAN.
    const wanReq = new Request("http://127.0.0.1:8086/api/jobs/recent", {
      method: "GET",
      headers: {
        host: "reading.wavypremium.xyz",
      },
    });
    const wanRes = await handleRequest(wanReq, localServer);
    expect(wanRes.status).toBe(200);
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
});
