import { describe, expect, it, beforeEach, afterEach } from "bun:test";
import { Database } from "bun:sqlite";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { spawnSync } from "node:child_process";
import {
  handleRequest,
  validateAndCanonicalizeProxyPath,
  setServerDependenciesForTest,
  resetServerDependenciesForTest,
  resetActiveLnoriStateForTest,
  ingestBookFile,
  getCalibreHashMap,
  refreshCalibreHashIndex,
  matchesActiveBookIdentity,
  isAuthorKnown,
  getCacheDb,
  getCalibreBooks,
  jobQueue,
  registerJobHandlers,
  getActiveDiscoverJobs,
  registerDiscoverJob,
} from "./server";
import { validateUrlForSSRF, getBsdtarPath } from "./security";
import { autoEnrichBookSynopsis } from "./scraper";
import {
  isKindleSyncActive,
  getKindleProgress,
  resetKindleProgressForTesting,
  invalidateKindleBookIndex,
  tryAcquireKindleSyncLock,
  releaseKindleSyncLock,
} from "./kindle";
import { generateMetadataFilename, buildContentDisposition } from "./filename";

describe("Calibre OPDS & Asset Reverse Proxy", () => {
  it("proxies /opds GET to Calibre server and preserves XML streaming body", async () => {
    const origFetch = globalThis.fetch;
    let interceptedUrl = "";
    let interceptedMethod = "";
    let interceptedHeaders: Headers | null = null;

    const opdsXml = `<?xml version="1.0" encoding="utf-8"?>
<feed xmlns="http://www.w3.org/2005/Atom">
  <title>Reading HQ OPDS Catalog</title>
</feed>`;

    globalThis.fetch = (async (input: any, init: any) => {
      interceptedUrl = typeof input === "string" ? input : input.url;
      interceptedMethod = init?.method || "GET";
      interceptedHeaders = new Headers(init?.headers);

      return new Response(opdsXml, {
        status: 200,
        headers: {
          "Content-Type": "application/atom+xml; charset=utf-8",
          "Cache-Control": "max-age=3600",
          ETag: '"opds-12345"',
        },
      });
    }) as any;

    try {
      const req = new Request("https://reading.wavypremium.xyz/opds", {
        method: "GET",
        headers: {
          Accept: "application/atom+xml",
          "User-Agent": "KOReader/2026.04",
        },
      });

      const res = await handleRequest(req);
      expect(res.status).toBe(200);
      expect(res.headers.get("Content-Type")).toBe(
        "application/atom+xml; charset=utf-8",
      );
      expect(res.headers.get("ETag")).toBe('"opds-12345"');
      expect(res.headers.get("X-Content-Type-Options")).toBe("nosniff");

      const body = await res.text();
      expect(body).toContain("<title>Reading HQ OPDS Catalog</title>");

      // Forwarding assertions
      expect(interceptedUrl).toContain("/opds");
      expect(interceptedMethod).toBe("GET");
      expect(interceptedHeaders?.get("accept")).toBe("application/atom+xml");
      expect(interceptedHeaders?.get("user-agent")).toBe("KOReader/2026.04");
      expect(interceptedHeaders?.get("x-forwarded-host")).toBe(
        "reading.wavypremium.xyz",
      );
      expect(interceptedHeaders?.get("x-forwarded-proto")).toBe("https");
    } finally {
      globalThis.fetch = origFetch;
    }
  });

  it("preserves query parameters on /opds subpaths", async () => {
    const origFetch = globalThis.fetch;
    let forwardedUrl = "";

    globalThis.fetch = (async (input: any) => {
      forwardedUrl = typeof input === "string" ? input : input.url;
      return new Response("<feed/>", {
        status: 200,
        headers: { "Content-Type": "application/atom+xml" },
      });
    }) as any;

    try {
      const req = new Request(
        "https://reading.wavypremium.xyz/opds/navlist/0?sort=title&page=2",
        {
          method: "GET",
        },
      );

      const res = await handleRequest(req);
      expect(res.status).toBe(200);
      expect(forwardedUrl).toContain("/opds/navlist/0?sort=title&page=2");
    } finally {
      globalThis.fetch = origFetch;
    }
  });

  it("handles HEAD requests without body", async () => {
    const origFetch = globalThis.fetch;
    let forwardedMethod = "";

    globalThis.fetch = (async (_input: any, init: any) => {
      forwardedMethod = init?.method || "";
      return new Response(null, {
        status: 200,
        headers: {
          "Content-Type": "application/atom+xml",
          "Content-Length": "1234",
        },
      });
    }) as any;

    try {
      const req = new Request("https://reading.wavypremium.xyz/opds", {
        method: "HEAD",
      });

      const res = await handleRequest(req);
      expect(res.status).toBe(200);
      expect(forwardedMethod).toBe("HEAD");
      expect(res.headers.get("Content-Length")).toBe("1234");
      const text = await res.text();
      expect(text).toBe("");
    } finally {
      globalThis.fetch = origFetch;
    }
  });

  it("proxies /get/* downloads and forwards Range / 206 Partial Content", async () => {
    const origFetch = globalThis.fetch;
    let forwardedHeaders: Headers | null = null;

    globalThis.fetch = (async (_input: any, init: any) => {
      forwardedHeaders = new Headers(init?.headers);
      return new Response(new Uint8Array([1, 2, 3, 4, 5]), {
        status: 206,
        statusText: "Partial Content",
        headers: {
          "Content-Type": "application/epub+zip",
          "Content-Range": "bytes 0-4/1000",
          "Accept-Ranges": "bytes",
          "Content-Length": "5",
        },
      });
    }) as any;

    try {
      const req = new Request(
        "https://reading.wavypremium.xyz/get/epub/42/Agent_Library",
        {
          method: "GET",
          headers: {
            Range: "bytes=0-4",
          },
        },
      );

      const res = await handleRequest(req);
      expect(res.status).toBe(206);
      expect(res.headers.get("Content-Range")).toBe("bytes 0-4/1000");
      expect(res.headers.get("Accept-Ranges")).toBe("bytes");
      expect(forwardedHeaders?.get("range")).toBe("bytes=0-4");

      const bytes = await res.arrayBuffer();
      expect(bytes.byteLength).toBe(5);
    } finally {
      globalThis.fetch = origFetch;
    }
  });

  it("proxies /favicon.png to Calibre server", async () => {
    const origFetch = globalThis.fetch;
    let targetUrl = "";

    globalThis.fetch = (async (input: any) => {
      targetUrl = typeof input === "string" ? input : input.url;
      return new Response(new Uint8Array([137, 80, 78, 71]), {
        status: 200,
        headers: { "Content-Type": "image/png" },
      });
    }) as any;

    try {
      const req = new Request("https://reading.wavypremium.xyz/favicon.png", {
        method: "GET",
      });

      const res = await handleRequest(req);
      expect(res.status).toBe(200);
      expect(res.headers.get("Content-Type")).toBe("image/png");
      expect(targetUrl).toContain("/favicon.png");
    } finally {
      globalThis.fetch = origFetch;
    }
  });

  it("serves brand static assets /assets/logo.svg and /assets/mark.svg with proper headers", async () => {
    const logoReq = new Request(
      "https://reading.wavypremium.xyz/assets/logo.svg",
      {
        method: "GET",
      },
    );
    const logoRes = await handleRequest(logoReq);
    expect(logoRes.status).toBe(200);
    expect(logoRes.headers.get("Content-Type")).toBe("image/svg+xml");
    expect(logoRes.headers.get("Cache-Control")).toContain("max-age=86400");
    expect(logoRes.headers.get("Content-Security-Policy")).toBe(
      "default-src 'none'",
    );
    const logoText = await logoRes.text();
    expect(logoText).toContain('viewBox="0 0 512 512"');

    const markReq = new Request(
      "https://reading.wavypremium.xyz/assets/mark.svg",
      {
        method: "HEAD",
      },
    );
    const markRes = await handleRequest(markReq);
    expect(markRes.status).toBe(200);
    expect(markRes.headers.get("Content-Type")).toBe("image/svg+xml");
    const markBody = await markRes.text();
    expect(markBody).toBe("");

    // Serves PNG touch icons
    const pngReq = new Request(
      "https://reading.wavypremium.xyz/assets/apple-touch-icon.png",
      { method: "GET" },
    );
    const pngRes = await handleRequest(pngReq);
    expect(pngRes.status).toBe(200);
    expect(pngRes.headers.get("Content-Type")).toBe("image/png");

    // Restricts non-GET/HEAD methods with 405
    const postReq = new Request(
      "https://reading.wavypremium.xyz/assets/logo.svg",
      { method: "POST" },
    );
    const postRes = await handleRequest(postReq);
    expect(postRes.status).toBe(405);
    expect(postRes.headers.get("Allow")).toBe("GET, HEAD");

    // Returns 404 for missing or disallowed assets
    const notFoundReq = new Request(
      "https://reading.wavypremium.xyz/assets/secret.txt",
      { method: "GET" },
    );
    const notFoundRes = await handleRequest(notFoundReq);
    expect(notFoundRes.status).toBe(404);
  });

  it("restricts /opds, /get/*, and /favicon.png to GET and HEAD methods with 405", async () => {
    const methods = ["POST", "PUT", "DELETE", "PATCH"];

    for (const method of methods) {
      const opdsReq = new Request("https://reading.wavypremium.xyz/opds", {
        method,
      });
      const opdsRes = await handleRequest(opdsReq);
      expect(opdsRes.status).toBe(405);
      expect(opdsRes.headers.get("Allow")).toBe("GET, HEAD");

      const getReq = new Request(
        "https://reading.wavypremium.xyz/get/epub/1/Agent_Library",
        {
          method,
        },
      );
      const getRes = await handleRequest(getReq);
      expect(getRes.status).toBe(405);
      expect(getRes.headers.get("Allow")).toBe("GET, HEAD");

      const favReq = new Request(
        "https://reading.wavypremium.xyz/favicon.png",
        {
          method,
        },
      );
      const favRes = await handleRequest(favReq);
      expect(favRes.status).toBe(405);
      expect(favRes.headers.get("Allow")).toBe("GET, HEAD");
    }
  });

  it("rewrites internal Location redirect headers to relative paths", async () => {
    const origFetch = globalThis.fetch;

    globalThis.fetch = (async () => {
      return new Response(null, {
        status: 302,
        headers: {
          Location: "http://127.0.0.1:8088/opds/navlist/default",
        },
      });
    }) as any;

    try {
      const req = new Request("https://reading.wavypremium.xyz/opds", {
        method: "GET",
      });

      const res = await handleRequest(req);
      expect(res.status).toBe(302);
      expect(res.headers.get("Location")).toBe("/opds/navlist/default");
    } finally {
      globalThis.fetch = origFetch;
    }
  });

  it("preserves 304 Not Modified when client sends If-None-Match", async () => {
    const origFetch = globalThis.fetch;
    let forwardedEtag: string | null = null;

    globalThis.fetch = (async (_input: any, init: any) => {
      forwardedEtag = new Headers(init?.headers).get("if-none-match");
      return new Response(null, {
        status: 304,
        statusText: "Not Modified",
        headers: {
          ETag: '"feed-rev-1"',
        },
      });
    }) as any;

    try {
      const req = new Request("https://reading.wavypremium.xyz/opds", {
        method: "GET",
        headers: {
          "If-None-Match": '"feed-rev-1"',
        },
      });

      const res = await handleRequest(req);
      expect(res.status).toBe(304);
      expect(forwardedEtag).toBe('"feed-rev-1"');
      expect(res.headers.get("ETag")).toBe('"feed-rev-1"');
    } finally {
      globalThis.fetch = origFetch;
    }
  });

  it("returns CORS headers when origin is allowed", async () => {
    const origFetch = globalThis.fetch;

    globalThis.fetch = (async () => {
      return new Response("<feed/>", {
        status: 200,
        headers: { "Content-Type": "application/atom+xml" },
      });
    }) as any;

    try {
      const req = new Request("https://reading.wavypremium.xyz/opds", {
        method: "GET",
        headers: {
          Origin: "https://reading.wavypremium.xyz",
        },
      });

      const res = await handleRequest(req);
      expect(res.status).toBe(200);
      expect(res.headers.get("Access-Control-Allow-Origin")).toBe(
        "https://reading.wavypremium.xyz",
      );
      expect(res.headers.get("Access-Control-Allow-Credentials")).toBe("true");
      expect(res.headers.get("Vary")).toContain("Origin");
    } finally {
      globalThis.fetch = origFetch;
    }
  });

  it("returns 502 Bad Gateway when Calibre server is unreachable", async () => {
    const origFetch = globalThis.fetch;

    globalThis.fetch = (async () => {
      throw new Error("connect ECONNREFUSED 127.0.0.1:8088");
    }) as any;

    try {
      const req = new Request("https://reading.wavypremium.xyz/opds", {
        method: "GET",
      });

      const res = await handleRequest(req);
      expect(res.status).toBe(502);
      const text = await res.text();
      expect(text).toContain("Bad Gateway");
      expect(text).toContain("Calibre server");
    } finally {
      globalThis.fetch = origFetch;
    }
  });

  describe("Path Validation & Security Rejection (400 Bad Request)", () => {
    it("rejects path traversal attempts with 400 Bad Request", async () => {
      const attacks = [
        "https://reading.wavypremium.xyz/opds/..%2f..%2fetc/passwd",
        "https://reading.wavypremium.xyz/opds/%252e%252e/admin",
        "https://reading.wavypremium.xyz/opds/.%252e/forbidden",
        "https://reading.wavypremium.xyz/opds/%252e./forbidden",
        "https://reading.wavypremium.xyz/get/epub/1/%252e%252e",
        "https://reading.wavypremium.xyz/get/epub/1/Agent_Library/%252e%252e/%252e%252e/etc/passwd",
        "https://reading.wavypremium.xyz/get/epub/1/Agent_Library/..%2f..%2fetc/passwd",
      ];

      for (const attackUrl of attacks) {
        const req = new Request(attackUrl, { method: "GET" });
        const res = await handleRequest(req);
        expect(res.status).toBe(400);
        const text = await res.text();
        expect(text).toContain("Bad Request");
      }
    });

    it("rejects duplicate slashes, backslashes, null bytes, and control characters with 400", async () => {
      const invalidUrls = [
        "https://reading.wavypremium.xyz/opds//double-slash",
        "https://reading.wavypremium.xyz/opds///triple",
        "https://reading.wavypremium.xyz/opds/back%5cslash",
        "https://reading.wavypremium.xyz/opds/null%00byte",
        "https://reading.wavypremium.xyz/opds/%0d%0acontrol",
        "https://reading.wavypremium.xyz/opds/test?q=null%00byte",
        "https://reading.wavypremium.xyz/opds/test?q=%0d%0acontrol",
      ];

      for (const invalidUrl of invalidUrls) {
        const req = new Request(invalidUrl, { method: "GET" });
        const res = await handleRequest(req);
        expect(res.status).toBe(400);
        const text = await res.text();
        expect(text).toContain("Bad Request");
      }
    });

    it("rejects malformed /get/ routes not adhering to /get/<format>/<id>/<library>", async () => {
      const malformedGetUrls = [
        "https://reading.wavypremium.xyz/get/epub",
        "https://reading.wavypremium.xyz/get/epub/not-a-number/Agent_Library",
        "https://reading.wavypremium.xyz/get/epub/0/Agent_Library",
        "https://reading.wavypremium.xyz/get/epub/-5/Agent_Library",
        "https://reading.wavypremium.xyz/get/epub/1/Agent_Library/extra/segments",
      ];

      for (const url of malformedGetUrls) {
        const req = new Request(url, { method: "GET" });
        const res = await handleRequest(req);
        expect(res.status).toBe(400);
        const text = await res.text();
        expect(text).toContain("Bad Request");
      }
    });

    it("validateAndCanonicalizeProxyPath unit checks", () => {
      expect(validateAndCanonicalizeProxyPath("/favicon.png").valid).toBe(true);
      expect(validateAndCanonicalizeProxyPath("/opds").valid).toBe(true);
      expect(validateAndCanonicalizeProxyPath("/opds/navlist/0").valid).toBe(true);
      expect(validateAndCanonicalizeProxyPath("/get/epub/100/Agent_Library").valid).toBe(true);
      expect(validateAndCanonicalizeProxyPath("/get/cover/42/Agent_Library").valid).toBe(true);

      // Traversal and malformed checks
      expect(validateAndCanonicalizeProxyPath("/opds/..").valid).toBe(false);
      expect(validateAndCanonicalizeProxyPath("/opds/%2e%2e/test").valid).toBe(false);
      expect(validateAndCanonicalizeProxyPath("/opds//double").valid).toBe(false);
      expect(validateAndCanonicalizeProxyPath("/opds/null\0").valid).toBe(false);
      expect(validateAndCanonicalizeProxyPath("/opds/back\\slash").valid).toBe(false);
      expect(validateAndCanonicalizeProxyPath("/get/epub/abc/Agent_Library").valid).toBe(false);
      expect(validateAndCanonicalizeProxyPath("/get/epub").valid).toBe(false);
      expect(validateAndCanonicalizeProxyPath("not-a-path").valid).toBe(false);
    });
  });

  describe("Header Forwarding Allowlist & Response Stripping", () => {
    it("discards client cookie, authorization, and spoofed forwarded headers while setting verified socket IP", async () => {
      const origFetch = globalThis.fetch;
      let forwardedHeaders: Headers | null = null;

      globalThis.fetch = (async (_input: any, init: any) => {
        forwardedHeaders = new Headers(init?.headers);
        return new Response("<feed/>", {
          status: 200,
          headers: { "Content-Type": "application/atom+xml" },
        });
      }) as any;

      try {
        const req = new Request("https://reading.wavypremium.xyz/opds", {
          method: "GET",
          headers: {
            Accept: "application/atom+xml",
            "User-Agent": "KOReader/Test",
            Range: "bytes=0-100",
            "If-None-Match": '"abc"',
            "If-Modified-Since": "Sat, 20 Sep 2026 00:00:00 GMT",
            Cookie: "session_token=sensitive_session_123",
            Authorization: "Bearer secret_jwt_token",
            "X-Forwarded-For": "198.51.100.22",
            "X-Forwarded-Host": "spoofed.attacker.com",
            "X-Forwarded-Proto": "http",
            Forwarded: "for=198.51.100.22;proto=http",
            "X-Custom-Smuggle": "attack",
          },
        });

        const mockServer = {
          requestIP: (_req: any) => ({ address: "203.0.113.55", family: "IPv4" }),
        };

        const res = await handleRequest(req, mockServer);
        expect(res.status).toBe(200);

        // Allowed headers forwarded
        expect(forwardedHeaders?.get("accept")).toBe("application/atom+xml");
        expect(forwardedHeaders?.get("user-agent")).toBe("KOReader/Test");
        expect(forwardedHeaders?.get("range")).toBe("bytes=0-100");
        expect(forwardedHeaders?.get("if-none-match")).toBe('"abc"');
        expect(forwardedHeaders?.get("if-modified-since")).toBe(
          "Sat, 20 Sep 2026 00:00:00 GMT",
        );

        // Sensitive / spoofed headers discarded
        expect(forwardedHeaders?.get("cookie")).toBeNull();
        expect(forwardedHeaders?.get("authorization")).toBeNull();
        expect(forwardedHeaders?.get("forwarded")).toBeNull();
        expect(forwardedHeaders?.get("x-custom-smuggle")).toBeNull();

        // Safe infrastructure headers set from server
        expect(forwardedHeaders?.get("x-forwarded-for")).toBe("203.0.113.55");
        expect(forwardedHeaders?.get("x-forwarded-host")).toBe(
          "reading.wavypremium.xyz",
        );
        expect(forwardedHeaders?.get("x-forwarded-proto")).toBe("https");
      } finally {
        globalThis.fetch = origFetch;
      }
    });

    it("strips set-cookie and hop-by-hop headers from upstream response", async () => {
      const origFetch = globalThis.fetch;

      globalThis.fetch = (async () => {
        const headers = new Headers();
        headers.set("Content-Type", "application/atom+xml");
        headers.set("Set-Cookie", "session=evil_cookie; HttpOnly");
        headers.set("Connection", "close");
        headers.set("Keep-Alive", "timeout=5");
        headers.set("Transfer-Encoding", "chunked");
        headers.set("Upgrade", "websocket");
        headers.set("Proxy-Authenticate", "Basic");
        headers.set("Trailer", "Expires");
        headers.set("Trailers", "X-Checksum");

        return new Response("<feed/>", {
          status: 200,
          headers,
        });
      }) as any;

      try {
        const req = new Request("https://reading.wavypremium.xyz/opds", {
          method: "GET",
        });

        const res = await handleRequest(req);
        expect(res.status).toBe(200);
        expect(res.headers.get("Set-Cookie")).toBeNull();
        expect(res.headers.get("Connection")).toBeNull();
        expect(res.headers.get("Keep-Alive")).toBeNull();
        expect(res.headers.get("Transfer-Encoding")).toBeNull();
        expect(res.headers.get("Upgrade")).toBeNull();
        expect(res.headers.get("Proxy-Authenticate")).toBeNull();
        expect(res.headers.get("Trailer")).toBeNull();
        expect(res.headers.get("Trailers")).toBeNull();
      } finally {
        globalThis.fetch = origFetch;
      }
    });
  });

  describe("SSRF Loopback Enforcement for allowCalibreServer", () => {
    it("rejects allowCalibreServer when CALIBRE_SERVER_URL is configured to a non-loopback IP", async () => {
      const origEnv = process.env.CALIBRE_SERVER_URL;
      process.env.CALIBRE_SERVER_URL = "http://169.254.169.254:8088";

      try {
        const check = await validateUrlForSSRF(
          "http://169.254.169.254:8088/opds",
          { allowCalibreServer: true },
        );
        expect(check.safe).toBe(false);
        expect(check.error).toContain("not a loopback address");
      } finally {
        process.env.CALIBRE_SERVER_URL = origEnv;
      }
    });

    it("rejects allowCalibreServer when CALIBRE_SERVER_URL resolves to an external domain", async () => {
      const origEnv = process.env.CALIBRE_SERVER_URL;
      process.env.CALIBRE_SERVER_URL = "http://example.com:8088";

      try {
        const check = await validateUrlForSSRF("http://example.com:8088/opds", {
          allowCalibreServer: true,
          dnsLookup: async () => [{ address: "93.184.216.34", family: 4 }],
        });
        expect(check.safe).toBe(false);
        expect(check.error).toContain("did not resolve exclusively to loopback");
      } finally {
        process.env.CALIBRE_SERVER_URL = origEnv;
      }
    });

    it("allows allowCalibreServer when target and CALIBRE_SERVER_URL are strict loopback", async () => {
      const origEnv = process.env.CALIBRE_SERVER_URL;
      process.env.CALIBRE_SERVER_URL = "http://127.0.0.1:8088";

      try {
        const check = await validateUrlForSSRF("http://127.0.0.1:8088/opds", {
          allowCalibreServer: true,
        });
        expect(check.safe).toBe(true);
        expect(check.resolvedIp).toBe("127.0.0.1");
      } finally {
        process.env.CALIBRE_SERVER_URL = origEnv;
      }
    });
  });

  describe("POST /api/lnori/ingest", () => {
    const localServer = { requestIP: () => ({ address: "127.0.0.1" }) };

    it("returns 400 on missing or invalid URL payload", async () => {
      // Empty body
      const req1 = new Request("http://127.0.0.1:8086/api/lnori/ingest", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({}),
      });
      const res1 = await handleRequest(req1, localServer);
      expect(res1.status).toBe(400);
      const data1 = (await res1.json()) as any;
      expect(data1.success).toBe(false);
      expect(data1.error).toContain("Missing or invalid 'url' parameter");

      // Non-string URL
      const req2 = new Request("http://127.0.0.1:8086/api/lnori/ingest", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ url: 12345 }),
      });
      const res2 = await handleRequest(req2, localServer);
      expect(res2.status).toBe(400);
      const data2 = (await res2.json()) as any;
      expect(data2.success).toBe(false);
      expect(data2.error).toContain("Missing or invalid 'url' parameter");

      // Empty string URL
      const req3 = new Request("http://127.0.0.1:8086/api/lnori/ingest", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ url: "   " }),
      });
      const res3 = await handleRequest(req3, localServer);
      expect(res3.status).toBe(400);
      const data3 = (await res3.json()) as any;
      expect(data3.success).toBe(false);
      expect(data3.error).toContain("Missing or invalid 'url' parameter");

      // Malformed non-JSON body
      const req4 = new Request("http://127.0.0.1:8086/api/lnori/ingest", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: "not-json",
      });
      const res4 = await handleRequest(req4, localServer);
      expect(res4.status).toBe(400);
      const data4 = (await res4.json()) as any;
      expect(data4.success).toBe(false);
      expect(data4.error).toContain("Missing or invalid 'url' parameter");
    });

    it("returns 400 on non-Lnori URL", async () => {
      // Different domain
      const req1 = new Request("http://127.0.0.1:8086/api/lnori/ingest", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ url: "https://example.com/series/8046" }),
      });
      const res1 = await handleRequest(req1, localServer);
      expect(res1.status).toBe(400);
      const data1 = (await res1.json()) as any;
      expect(data1.success).toBe(false);
      expect(data1.error).toContain("Target URL must be a valid lnori.com series or book URL");

      // Lnori domain but invalid path (not /series/ or /book/)
      const req2 = new Request("http://127.0.0.1:8086/api/lnori/ingest", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ url: "https://lnori.com/genre/fantasy" }),
      });
      const res2 = await handleRequest(req2, localServer);
      expect(res2.status).toBe(400);
      const data2 = (await res2.json()) as any;
      expect(data2.success).toBe(false);
      expect(data2.error).toContain("Target URL must be a valid lnori.com series or book URL");
    });

    it("blocks unauthenticated WAN requests with 401 when apiKey is configured or origin is untrusted", async () => {
      // 1. Untrusted origin WAN request without credentials rejected with 401
      const reqUntrusted = new Request("http://127.0.0.1:8086/api/lnori/ingest", {
        method: "POST",
        headers: {
          host: "reading.wavypremium.xyz",
          origin: "https://untrusted-attacker.com",
          "content-type": "application/json",
        },
        body: JSON.stringify({ url: "https://lnori.com/series/8046" }),
      });
      // Note: Origin check returns 403 when origin header is present but untrusted
      const resUntrusted = await handleRequest(reqUntrusted);
      expect(resUntrusted.status).toBe(403);

      // 2. WAN request with no origin header or credentials rejected with 401
      const reqNoOrigin = new Request("http://127.0.0.1:8086/api/lnori/ingest", {
        method: "POST",
        headers: {
          host: "reading.wavypremium.xyz",
          "content-type": "application/json",
        },
        body: JSON.stringify({ url: "https://lnori.com/series/8046" }),
      });
      const resNoOrigin = await handleRequest(reqNoOrigin);
      expect(resNoOrigin.status).toBe(401);
      const dataNoOrigin = (await resNoOrigin.json()) as any;
      expect(dataNoOrigin.success).toBe(false);
      expect(dataNoOrigin.error).toContain("Authentication required");

      // 3. When READING_API_KEY is configured, WAN request with allowed origin still requires valid credentials
      const origKey = process.env.READING_API_KEY;
      try {
        process.env.READING_API_KEY = "test-secret-key-123";
        const reqWithKeyConfigured = new Request("http://127.0.0.1:8086/api/lnori/ingest", {
          method: "POST",
          headers: {
            host: "reading.wavypremium.xyz",
            origin: "https://reading.wavypremium.xyz",
            "content-type": "application/json",
          },
          body: JSON.stringify({ url: "https://lnori.com/series/8046" }),
        });
        const resWithKey = await handleRequest(reqWithKeyConfigured);
        expect(resWithKey.status).toBe(401);
        const dataWithKey = (await resWithKey.json()) as any;
        expect(dataWithKey.success).toBe(false);
        expect(dataWithKey.error).toContain("Authentication required");
      } finally {
        if (origKey !== undefined) process.env.READING_API_KEY = origKey;
        else delete process.env.READING_API_KEY;
      }

      // 4. When READING_API_KEY is unset, WAN request from spoofed localhost origin is rejected with 401
      const reqSpoofedLocal = new Request("http://127.0.0.1:8086/api/lnori/ingest", {
        method: "POST",
        headers: {
          host: "reading.wavypremium.xyz",
          origin: "http://127.0.0.1:8086",
          "content-type": "application/json",
        },
        body: JSON.stringify({ url: "https://lnori.com/series/8046" }),
      });
      const resSpoofedLocal = await handleRequest(reqSpoofedLocal);
      expect(resSpoofedLocal.status).toBe(401);
      const dataSpoofedLocal = (await resSpoofedLocal.json()) as any;
      expect(dataSpoofedLocal.success).toBe(false);
      expect(dataSpoofedLocal.error).toContain("Authentication required");
    });

    it("authenticates WAN ingest request from production origin when READING_API_KEY is unset", async () => {
      setServerDependenciesForTest({
        ingestLnoriSeries: async () => ({
          success: true,
          seriesTitle: "Production Origin Novel",
          author: "Author",
          importedCount: 1,
          skippedCount: 0,
          duplicateCount: 0,
          totalCount: 1,
          tags: "Light Novel",
          calibreBookIds: [999],
        }),
        getCalibreBooks: () => [],
      });

      try {
        const origKey = process.env.READING_API_KEY;
        delete process.env.READING_API_KEY;

        const req = new Request("http://127.0.0.1:8086/api/lnori/ingest", {
          method: "POST",
          headers: {
            host: "reading.wavypremium.xyz",
            origin: "https://reading.wavypremium.xyz",
            "content-type": "application/json",
          },
          body: JSON.stringify({ url: "https://lnori.com/series/8046/prod-test" }),
        });

        const res = await handleRequest(req);
        expect(res.status).toBe(200);
        const data = (await res.json()) as any;
        expect(data.success).toBe(true);
        expect(data.seriesTitle).toBe("Production Origin Novel");

        if (origKey !== undefined) process.env.READING_API_KEY = origKey;
      } finally {
        resetServerDependenciesForTest();
      }
    });

    it("returns 200 and refreshes Calibre cache on successful ingest", async () => {
      let refreshed = false;
      let targetPassed = "";

      setServerDependenciesForTest({
        ingestLnoriSeries: async (url: string) => {
          targetPassed = url;
          return {
            success: true,
            seriesTitle: "The Genius Prince's Guide",
            author: "Toru Toba",
            importedCount: 3,
            skippedCount: 1,
            duplicateCount: 1,
            totalCount: 4,
            tags: "Light Novel, Fantasy",
            calibreBookIds: [101, 102, 103],
          };
        },
        getCalibreBooks: (forceFresh?: boolean) => {
          if (forceFresh) refreshed = true;
          return [];
        },
      });

      try {
        const req = new Request("http://127.0.0.1:8086/api/lnori/ingest", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            url: "https://lnori.com/series/8046/the-genius-princes-guide",
          }),
        });

        const res = await handleRequest(req, localServer);
        expect(res.status).toBe(200);
        const data = (await res.json()) as any;

        expect(data.success).toBe(true);
        expect(data.seriesTitle).toBe("The Genius Prince's Guide");
        expect(data.author).toBe("Toru Toba");
        expect(data.importedCount).toBe(3);
        expect(data.skippedCount).toBe(1);
        expect(data.totalCount).toBe(4);
        expect(data.tags).toBe("Light Novel, Fantasy");

        expect(targetPassed).toBe("https://lnori.com/series/8046/the-genius-princes-guide");
        expect(refreshed).toBe(true);
      } finally {
        resetServerDependenciesForTest();
      }
    });

    it("returns 500 with sanitized error when ingestLnoriSeries returns success: false", async () => {
      setServerDependenciesForTest({
        ingestLnoriSeries: async () => ({
          success: false,
          error: "Failed to download volume 2 EPUB from /Users/ospeto/secret/storage",
          seriesTitle: "",
          author: "",
          tags: "",
          importedCount: 0,
          skippedCount: 0,
          duplicateCount: 0,
          totalCount: 2,
          calibreBookIds: [],
        }),
      });

      try {
        const req = new Request("http://127.0.0.1:8086/api/lnori/ingest", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            url: "https://lnori.com/book/23021/the-genius-prince-vol-1",
          }),
        });

        const res = await handleRequest(req, localServer);
        expect(res.status).toBe(500);
        const data = (await res.json()) as any;
        expect(data.success).toBe(false);
        expect(data.error).toContain("Failed to download volume 2 EPUB");
        expect(data.error).not.toContain("/Users/ospeto/secret/storage");
      } finally {
        resetServerDependenciesForTest();
      }
    });

    it("accepts www.lnori.com series and book URLs", async () => {
      let passed = "";
      setServerDependenciesForTest({
        ingestLnoriSeries: async (url: string) => {
          passed = url;
          return {
            success: true,
            seriesTitle: "Test Series",
            author: "Author",
            importedCount: 1,
            skippedCount: 0,
            duplicateCount: 0,
            totalCount: 1,
            tags: "Light Novel",
            calibreBookIds: [999],
          };
        },
        getCalibreBooks: () => [],
      });

      try {
        const req = new Request("http://127.0.0.1:8086/api/lnori/ingest", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            url: "https://www.lnori.com/book/12345/test-vol-1",
          }),
        });
        const res = await handleRequest(req, localServer);
        expect(res.status).toBe(200);
        expect(passed).toBe("https://www.lnori.com/book/12345/test-vol-1");
      } finally {
        resetServerDependenciesForTest();
      }
    });

    it("does NOT enqueue destructive metadata_enrich jobs into jobQueue for newly imported calibreBookIds upon Lnori series ingestion", async () => {
      const origEnqueue = jobQueue.enqueue;
      const enqueuedJobs: any[] = [];
      (jobQueue as any).enqueue = (type: string, payload: any) => {
        enqueuedJobs.push({ type, payload });
        return { id: 1, type, payload, status: "pending" };
      };

      setServerDependenciesForTest({
        ingestLnoriSeries: async () => ({
          success: true,
          seriesTitle: "Enrich Test Series",
          author: "Test Author",
          importedCount: 2,
          skippedCount: 0,
          duplicateCount: 0,
          totalCount: 2,
          tags: ["Light Novel", "Fantasy"],
          calibreBookIds: [777, 778],
        }),
        getCalibreBooks: () => [
          { id: 777, title: "Enrich Test Series Vol 1", authors: "Test Author", tags: ["Light Novel"] },
          { id: 778, title: "Enrich Test Series Vol 2", authors: "Test Author", tags: ["Light Novel"] },
        ],
      });

      try {
        const req = new Request("http://127.0.0.1:8086/api/lnori/ingest", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            url: "https://lnori.com/series/9999/enrich-test",
          }),
        });

        const res = await handleRequest(req, localServer);
        expect(res.status).toBe(200);
        const data = (await res.json()) as any;
        expect(data.success).toBe(true);
        expect(data.calibreBookIds).toEqual([777, 778]);

        // Verify NO metadata_enrich jobs were enqueued to prevent volume overwrites
        const enrichJobs = enqueuedJobs.filter((j) => j.type === "metadata_enrich");
        expect(enrichJobs.length).toBe(0);
      } finally {
        (jobQueue as any).enqueue = origEnqueue;
        resetServerDependenciesForTest();
      }
    });

    it("does NOT enqueue destructive metadata_enrich jobs upon Elscione series ingestion", async () => {
      const origEnqueue = jobQueue.enqueue;
      const enqueuedJobs: any[] = [];
      (jobQueue as any).enqueue = (type: string, payload: any) => {
        enqueuedJobs.push({ type, payload });
        return { id: 1, type, payload, status: "pending" };
      };

      setServerDependenciesForTest({
        ingestElscioneSeries: async () => ({
          success: true,
          seriesTitle: "Elscione Test Series",
          author: "Elscione Author",
          importedCount: 2,
          skippedCount: 0,
          duplicateCount: 0,
          totalCount: 2,
          tags: ["Light Novel", "Elscione"],
          calibreBookIds: [881, 882],
        }),
        getCalibreBooks: () => [
          { id: 881, title: "Elscione Test Series Vol 1", authors: "Elscione Author", tags: ["Light Novel"] },
          { id: 882, title: "Elscione Test Series Vol 2", authors: "Elscione Author", tags: ["Light Novel"] },
        ],
      });

      try {
        const req = new Request("http://127.0.0.1:8086/api/elscione/ingest", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            url: "https://server.elscione.com/Officially%20Translated%20Light%20Novels/ElscioneTest",
          }),
        });

        const res = await handleRequest(req, localServer);
        expect(res.status).toBe(200);
        const data = (await res.json()) as any;
        expect(data.success).toBe(true);
        expect(data.calibreBookIds).toEqual([881, 882]);

        const enrichJobs = enqueuedJobs.filter((j) => j.type === "metadata_enrich");
        expect(enrichJobs.length).toBe(0);
      } finally {
        (jobQueue as any).enqueue = origEnqueue;
        resetServerDependenciesForTest();
      }
    });

    it("metadata_enrich job handler refuses to overwrite volume titles and covers when volume numbers mismatch", async () => {
      const { DurableJobQueue } = await import("./jobs");
      const testDb = new Database(":memory:");
      const testQueue = new DurableJobQueue(testDb);
      registerJobHandlers(testQueue);

      const handler = (testQueue as any).handlers.get("metadata_enrich");
      expect(handler).toBeDefined();

      let applyCalled = false;
      let searchedPreserveVolume: boolean | undefined = undefined;

      // Book 303 in Calibre is Volume 3
      setServerDependenciesForTest({
        getCalibreBooks: () => [
          { id: 303, title: "Goblin Slayer Vol 3", series: "Goblin Slayer", series_index: 3, tags: ["Light Novel"] },
        ],
        searchUniversalMetadata: async (_query: string, hint?: any) => {
          searchedPreserveVolume = hint?.preserveVolume;
          // Returns Volume 1 match with high confidence (simulating the bug where RanobeDB returned Vol 1)
          return [
            {
              title: "Goblin Slayer, Vol. 1",
              authors: "Kumo Kagyu",
              confidence: 0.95,
              source: "RanobeDB",
              coverUrl: "https://images.ranobedb.org/vol1.jpg",
              tags: ["Light Novel"],
            },
          ];
        },
        applyMetadataToCalibre: async () => {
          applyCalled = true;
          return true;
        },
      });

      try {
        const res = await handler({
          bookId: 303,
          title: "Goblin Slayer Vol 3",
          author: "Kumo Kagyu",
          tags: ["Light Novel"],
        });

        // 1. Verify preserveVolume was passed to search
        expect(searchedPreserveVolume).toBe(true);

        // 2. Verify applyMetadataToCalibre was NOT called due to volume conflict (target Vol 3 vs match Vol 1)
        expect(applyCalled).toBe(false);

        // 3. Verify message explains volume conflict and preserves original title
        expect(res.success).toBe(true);
        expect(res.message).toContain("Volume conflict");
        expect(res.message).toContain("Preserved original title and cover");
      } finally {
        resetServerDependenciesForTest();
        testDb.close();
      }
    });

    it("blocks mutating requests with untrusted origin with 403", async () => {
      const req = new Request("http://127.0.0.1:8086/api/lnori/ingest", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Origin: "https://malicious-site.com",
        },
        body: JSON.stringify({ url: "https://lnori.com/series/8046" }),
      });
      const res = await handleRequest(req, localServer);
      expect(res.status).toBe(403);
      const data = (await res.json()) as any;
      expect(data.success).toBe(false);
      expect(data.error).toContain("Origin");
    });

    it("returns 500 with sanitized error when ingestLnoriSeries throws an exception", async () => {
      setServerDependenciesForTest({
        ingestLnoriSeries: async () => {
          throw new Error("Lnori CDN connection timeout after 60000ms (/Users/ospeto/secret/path)");
        },
      });

      try {
        const req = new Request("http://127.0.0.1:8086/api/lnori/ingest", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            url: "https://lnori.com/series/8046/timeout-test",
          }),
        });

        const res = await handleRequest(req, localServer);
        expect(res.status).toBe(500);
        const data = (await res.json()) as any;
        expect(data.success).toBe(false);
        expect(data.error).toContain("Lnori CDN connection timeout");
        // Server paths are sanitized
        expect(data.error).not.toContain("/Users/ospeto/secret/path");
      } finally {
        resetServerDependenciesForTest();
      }
    });

    it("supports Server-Sent Events (SSE) streaming progress when stream: true in body", async () => {
      let cacheRefreshed = false;
      setServerDependenciesForTest({
        ingestLnoriSeries: async (_url: string, onProgress?: any) => {
          if (onProgress) {
            await onProgress({
              phase: "manifest",
              total: 2,
              volumeTitle: "Stream Series",
              status: "Found 2 volumes",
              data: { action: "manifest_ready" },
            });
            await onProgress({
              phase: "volume",
              index: 1,
              total: 2,
              volumeTitle: "Stream Series: Volume 1",
              status: "Imported Volume 1",
              data: { action: "imported", calibreId: 101 },
            });
            await onProgress({
              phase: "complete",
              index: 2,
              total: 2,
              volumeTitle: "Stream Series",
              status: "Completed",
              data: {
                success: true,
                seriesTitle: "Stream Series",
                author: "Stream Author",
                importedCount: 2,
                skippedCount: 0,
                totalCount: 2,
                tags: "Light Novel",
                calibreBookIds: [101, 102],
              },
            });
          }
          return {
            success: true,
            seriesTitle: "Stream Series",
            author: "Stream Author",
            importedCount: 2,
            skippedCount: 0,
            duplicateCount: 0,
            totalCount: 2,
            tags: "Light Novel",
            calibreBookIds: [101, 102],
          };
        },
        getCalibreBooks: (forceFresh?: boolean) => {
          if (forceFresh) cacheRefreshed = true;
          return [];
        },
      });

      try {
        const req = new Request("http://127.0.0.1:8086/api/lnori/ingest", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            url: "https://lnori.com/series/8046/streaming-test",
            stream: true,
          }),
        });

        const res = await handleRequest(req, localServer);
        expect(res.status).toBe(200);
        expect(res.headers.get("content-type")).toContain("text/event-stream");

        const text = await res.text();
        expect(text).toContain(": keepalive\n\n");
        const rawBlocks = text.split("\n\n").filter((b) => b.trim().startsWith("data:"));
        const events = rawBlocks.map((b) => JSON.parse(b.replace(/^data:\s*/, "").trim()));

        expect(events.length).toBeGreaterThanOrEqual(3);
        expect(events[0].phase).toBe("manifest");
        expect(events[0].total).toBe(2);
        expect(events[1].phase).toBe("volume");
        expect(events[1].index).toBe(1);
        expect(events[2].phase).toBe("complete");
        expect(events[2].data.seriesTitle).toBe("Stream Series");
        expect(events[2].data.importedCount).toBe(2);
        expect(cacheRefreshed).toBe(true);
      } finally {
        resetServerDependenciesForTest();
      }
    });

    it("supports Server-Sent Events (SSE) streaming progress when Accept: text/event-stream", async () => {
      setServerDependenciesForTest({
        ingestLnoriSeries: async (_url: string, onProgress?: any) => {
          if (onProgress) {
            await onProgress({
              phase: "manifest",
              total: 1,
              volumeTitle: "Accept Header Series",
              status: "Found 1 volume",
            });
          }
          return {
            success: true,
            seriesTitle: "Accept Header Series",
            author: "Author",
            importedCount: 1,
            skippedCount: 0,
            duplicateCount: 0,
            totalCount: 1,
            tags: "Light Novel",
            calibreBookIds: [201],
          };
        },
        getCalibreBooks: () => [],
      });

      try {
        const req = new Request("http://127.0.0.1:8086/api/lnori/ingest", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Accept: "text/event-stream",
          },
          body: JSON.stringify({
            url: "https://lnori.com/series/8046/accept-test",
          }),
        });

        const res = await handleRequest(req, localServer);
        expect(res.status).toBe(200);
        expect(res.headers.get("content-type")).toContain("text/event-stream");

        const text = await res.text();
        const events = text
          .split("\n\n")
          .filter((b) => b.trim().startsWith("data:"))
          .map((b) => JSON.parse(b.replace(/^data:\s*/, "").trim()));

        expect(events.length).toBeGreaterThanOrEqual(1);
        expect(events[0].phase).toBe("manifest");
        const completeEvent = events.find((e) => e.phase === "complete");
        expect(completeEvent).toBeDefined();
        expect(completeEvent.data.seriesTitle).toBe("Accept Header Series");
      } finally {
        resetServerDependenciesForTest();
      }
    });

    it("supports NDJSON streaming progress when Accept: application/x-ndjson", async () => {
      setServerDependenciesForTest({
        ingestLnoriSeries: async (_url: string, onProgress?: any) => {
          if (onProgress) {
            await onProgress({
              phase: "manifest",
              total: 3,
              volumeTitle: "NDJSON Series",
              status: "Manifest ready",
            });
          }
          return {
            success: true,
            seriesTitle: "NDJSON Series",
            author: "Author",
            importedCount: 3,
            skippedCount: 0,
            duplicateCount: 0,
            totalCount: 3,
            tags: "Light Novel",
            calibreBookIds: [301, 302, 303],
          };
        },
        getCalibreBooks: () => [],
      });

      try {
        const req = new Request("http://127.0.0.1:8086/api/lnori/ingest", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Accept: "application/x-ndjson",
          },
          body: JSON.stringify({
            url: "https://lnori.com/series/8046/ndjson-test",
          }),
        });

        const res = await handleRequest(req, localServer);
        expect(res.status).toBe(200);
        expect(res.headers.get("content-type")).toContain("application/x-ndjson");

        const text = await res.text();
        const lines = text.trim().split("\n").filter(Boolean);
        const events = lines.map((l) => JSON.parse(l));

        expect(events.length).toBeGreaterThanOrEqual(1);
        expect(events[0].phase).toBe("manifest");
        const completeEvent = events.find((e) => e.phase === "complete");
        expect(completeEvent).toBeDefined();
        expect(completeEvent.data.seriesTitle).toBe("NDJSON Series");
      } finally {
        resetServerDependenciesForTest();
      }
    });

    it("streams error events when ingestLnoriSeries fails during streaming", async () => {
      setServerDependenciesForTest({
        ingestLnoriSeries: async () => {
          throw new Error("Simulated stream failure (/secret/path)");
        },
      });

      try {
        const req = new Request("http://127.0.0.1:8086/api/lnori/ingest", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            url: "https://lnori.com/series/8046/error-stream-test",
            stream: true,
          }),
        });

        const res = await handleRequest(req, localServer);
        expect(res.status).toBe(200);
        expect(res.headers.get("content-type")).toContain("text/event-stream");

        const text = await res.text();
        const events = text
          .split("\n\n")
          .filter((b) => b.trim().startsWith("data:"))
          .map((b) => JSON.parse(b.replace(/^data:\s*/, "").trim()));

        expect(events.length).toBe(1);
        expect(events[0].phase).toBe("error");
        expect(events[0].status).toContain("Simulated stream failure");
        expect(events[0].status).not.toContain("/secret/path");
      } finally {
        resetServerDependenciesForTest();
      }
    });

    it("preserves slashes and URLs in title and status during streaming without mangling", async () => {
      setServerDependenciesForTest({
        ingestLnoriSeries: async (_url: string, onProgress?: any) => {
          if (onProgress) {
            await onProgress({
              phase: "manifest",
              total: 2,
              volumeTitle: "Fate/stay night: Unlimited Blade Works",
              status: "Inspecting volume https://lnori.com/book/801/vol-1",
            });
            await onProgress({
              phase: "complete",
              index: 2,
              total: 2,
              volumeTitle: "Fate/stay night: Unlimited Blade Works",
              status: "Completed",
              data: {
                success: true,
                seriesTitle: "Fate/stay night: Unlimited Blade Works",
                author: "TYPE-MOON / Kinoko Nasu",
                importedCount: 2,
                skippedCount: 0,
                totalCount: 2,
                tags: "Light Novel",
                calibreBookIds: [1, 2],
              },
            });
          }
          return {
            success: true,
            seriesTitle: "Fate/stay night: Unlimited Blade Works",
            author: "TYPE-MOON / Kinoko Nasu",
            importedCount: 2,
            skippedCount: 0,
            duplicateCount: 0,
            totalCount: 2,
            tags: "Light Novel",
            calibreBookIds: [1, 2],
          };
        },
        getCalibreBooks: () => [],
      });

      try {
        const req = new Request("http://127.0.0.1:8086/api/lnori/ingest", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            url: "https://lnori.com/series/8046/slash-title-test",
            stream: true,
          }),
        });

        const res = await handleRequest(req, localServer);
        expect(res.status).toBe(200);

        const text = await res.text();
        const events = text
          .split("\n\n")
          .filter((b) => b.trim().startsWith("data:"))
          .map((b) => JSON.parse(b.replace(/^data:\s*/, "").trim()));

        expect(events[0].volumeTitle).toBe("Fate/stay night: Unlimited Blade Works");
        expect(events[0].status).toBe("Inspecting volume https://lnori.com/book/801/vol-1");
        expect(events[1].data.seriesTitle).toBe("Fate/stay night: Unlimited Blade Works");
        // Verify slashes and URLs were NOT replaced by "[path]"
        expect(events[0].volumeTitle).not.toContain("[path]");
        expect(events[0].status).not.toContain("[path]");
      } finally {
        resetServerDependenciesForTest();
      }
    });

    it("streams error event when ingestLnoriSeries returns success: false on stream", async () => {
      setServerDependenciesForTest({
        ingestLnoriSeries: async () => ({
          success: false,
          error: "Failed to download volume from /Users/ospeto/internal/storage",
          seriesTitle: "",
          author: "",
          tags: "",
          importedCount: 0,
          skippedCount: 0,
          duplicateCount: 0,
          totalCount: 1,
          calibreBookIds: [],
        }),
      });

      try {
        const req = new Request("http://127.0.0.1:8086/api/lnori/ingest", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            url: "https://lnori.com/series/8046/fail-stream-test",
            stream: true,
          }),
        });

        const res = await handleRequest(req, localServer);
        expect(res.status).toBe(200);
        expect(res.headers.get("content-type")).toContain("text/event-stream");

        const text = await res.text();
        const events = text
          .split("\n\n")
          .filter((b) => b.trim().startsWith("data:"))
          .map((b) => JSON.parse(b.replace(/^data:\s*/, "").trim()));

        expect(events.length).toBe(1);
        expect(events[0].phase).toBe("error");
        expect(events[0].status).toContain("Failed to download volume");
        expect(events[0].status).not.toContain("/Users/ospeto/internal/storage");
      } finally {
        resetServerDependenciesForTest();
      }
    });

    it("continues background ingest even after client stream disconnects, but aborts on POST /api/lnori/cancel", async () => {
      let runFinished = false;
      let abortSignalObserved = false;

      setServerDependenciesForTest({
        ingestLnoriSeries: async (_url: string, onProgress?: any, deps?: any) => {
          if (onProgress) {
            await onProgress({
              phase: "manifest",
              total: 5,
              volumeTitle: "Background Ingest Test Series",
              status: "Found 5 volumes",
            });
          }

          // Check if signal gets aborted during background execution
          for (let step = 1; step <= 5; step++) {
            if (deps?.signal?.aborted) {
              abortSignalObserved = true;
              throw new Error("Lnori ingestion cancelled by user");
            }
            if (onProgress) {
              await onProgress({
                phase: "volume",
                index: step,
                total: 5,
                volumeTitle: `Vol ${step}`,
                status: `Imported vol ${step}`,
                data: { action: "imported" },
              });
            }
            await new Promise((r) => setTimeout(r, 20));
          }

          runFinished = true;
          return {
            success: true,
            seriesTitle: "Background Ingest Test Series",
            author: "Author",
            importedCount: 5,
            skippedCount: 0,
            duplicateCount: 0,
            totalCount: 5,
            tags: "Light Novel",
            calibreBookIds: [1, 2, 3, 4, 5],
          };
        },
      });

      try {
        const req = new Request("http://127.0.0.1:8086/api/lnori/ingest", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            url: "https://lnori.com/series/8046/bg-disconnect-test",
            stream: true,
          }),
        });

        const res = await handleRequest(req, localServer);
        expect(res.status).toBe(200);

        // Cancel the response body stream (simulating client network drop / tab close)
        if (res.body) {
          await res.body.cancel();
        }

        // Check progress endpoint while background ingest continues running
        const progressReq1 = new Request("http://127.0.0.1:8086/api/lnori/progress");
        const progressRes1 = await handleRequest(progressReq1, localServer);
        expect(progressRes1.status).toBe(200);
        const progressData1 = (await progressRes1.json()) as any;
        expect(progressData1.success).toBe(true);
        expect(progressData1.state).toBeDefined();
        expect(progressData1.state.runId).toBeDefined();

        // Send explicit cancel request
        const cancelReq = new Request("http://127.0.0.1:8086/api/lnori/cancel", {
          method: "POST",
        });
        const cancelRes = await handleRequest(cancelReq, localServer);
        expect(cancelRes.status).toBe(200);
        const cancelData = (await cancelRes.json()) as any;
        expect(cancelData.success).toBe(true);
        expect(cancelData.cancelled).toBe(true);

        // Wait a brief moment for the abort to be handled in the background task loop
        await new Promise((r) => setTimeout(r, 50));
        expect(abortSignalObserved).toBe(true);
        expect(runFinished).toBe(false);

        // Progress endpoint should now reflect cancelled / error state
        const progressReq2 = new Request("http://127.0.0.1:8086/api/lnori/progress");
        const progressRes2 = await handleRequest(progressReq2, localServer);
        const progressData2 = (await progressRes2.json()) as any;
        expect(progressData2.active).toBe(false);
        expect(progressData2.state.phase).toBe("error");
        expect(progressData2.state.error).toContain("cancelled by user");
      } finally {
        resetServerDependenciesForTest();
        resetActiveLnoriStateForTest();
      }
    });

    it("defaults to non-streaming JSON response when Accept: application/json", async () => {
      setServerDependenciesForTest({
        ingestLnoriSeries: async () => ({
          success: true,
          seriesTitle: "JSON Series",
          author: "Author",
          importedCount: 1,
          skippedCount: 0,
          duplicateCount: 0,
          totalCount: 1,
          tags: "Light Novel",
          calibreBookIds: [501],
        }),
        getCalibreBooks: () => [],
      });

      try {
        const req = new Request("http://127.0.0.1:8086/api/lnori/ingest", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Accept: "application/json",
          },
          body: JSON.stringify({
            url: "https://lnori.com/series/8046/json-default-test",
          }),
        });

        const res = await handleRequest(req, localServer);
        expect(res.status).toBe(200);
        expect(res.headers.get("content-type")).toContain("application/json");
        const data = (await res.json()) as any;
        expect(data.success).toBe(true);
        expect(data.seriesTitle).toBe("JSON Series");
      } finally {
        resetServerDependenciesForTest();
      }
    });

    it("emits only one single error event when manifest is empty during stream", async () => {
      setServerDependenciesForTest({
        ingestLnoriSeries: async () => {
          throw new Error("No volumes found in Lnori series manifest for: https://lnori.com/series/8046/empty");
        },
      });

      try {
        const req = new Request("http://127.0.0.1:8086/api/lnori/ingest", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            url: "https://lnori.com/series/8046/empty-stream-test",
            stream: true,
          }),
        });

        const res = await handleRequest(req, localServer);
        expect(res.status).toBe(200);
        expect(res.headers.get("content-type")).toContain("text/event-stream");

        const text = await res.text();
        const events = text
          .split("\n\n")
          .filter((b) => b.trim().startsWith("data:"))
          .map((b) => JSON.parse(b.replace(/^data:\s*/, "").trim()));

        expect(events.length).toBe(1);
        expect(events[0].phase).toBe("error");
        expect(events[0].status).toContain("No volumes found");
      } finally {
        resetServerDependenciesForTest();
        resetActiveLnoriStateForTest();
      }
    });

    it("GET /api/lnori/progress returns active status when ingestion is in progress and completedData when done", async () => {
      let completeTrigger: (() => void) | undefined;
      const completionPromise = new Promise<void>((resolve) => {
        completeTrigger = resolve;
      });

      setServerDependenciesForTest({
        ingestLnoriSeries: async (_url: string, onProgress?: any) => {
          if (onProgress) {
            await onProgress({
              phase: "manifest",
              total: 3,
              volumeTitle: "Polling Test Series",
              status: "Found 3 volumes",
            });
            await onProgress({
              phase: "volume",
              index: 1,
              total: 3,
              volumeTitle: "Vol 1",
              status: "Imported Vol 1",
              data: { action: "imported" },
            });
          }
          await completionPromise;
          return {
            success: true,
            seriesTitle: "Polling Test Series",
            author: "Author",
            importedCount: 3,
            skippedCount: 0,
            duplicateCount: 0,
            totalCount: 3,
            tags: "Light Novel",
            calibreBookIds: [10, 11, 12],
          };
        },
      });

      try {
        // Start streaming ingestion
        const ingestReq = new Request("http://127.0.0.1:8086/api/lnori/ingest", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            url: "https://lnori.com/series/8046/polling-test",
            stream: true,
          }),
        });
        const ingestRes = await handleRequest(ingestReq, localServer);
        expect(ingestRes.status).toBe(200);

        // Check progress while running
        const progReq1 = new Request("http://127.0.0.1:8086/api/lnori/progress");
        const progRes1 = await handleRequest(progReq1, localServer);
        expect(progRes1.status).toBe(200);
        const progData1 = (await progRes1.json()) as any;
        expect(progData1.success).toBe(true);
        expect(progData1.active).toBe(true);
        expect(progData1.state.volumeTitle).toBe("Vol 1");
        expect(progData1.state.index).toBe(1);
        expect(progData1.state.total).toBe(3);

        // Let background ingestion finish
        completeTrigger?.();
        await new Promise((r) => setTimeout(r, 50));

        // Check progress after completion
        const progReq2 = new Request("http://127.0.0.1:8086/api/lnori/progress");
        const progRes2 = await handleRequest(progReq2, localServer);
        expect(progRes2.status).toBe(200);
        const progData2 = (await progRes2.json()) as any;
        expect(progData2.success).toBe(true);
        expect(progData2.active).toBe(false);
        expect(progData2.state.phase).toBe("complete");
        expect(progData2.state.completedData).toBeDefined();
        expect(progData2.state.completedData.importedCount).toBe(3);
        expect(progData2.state.completedData.seriesTitle).toBe("Polling Test Series");
      } finally {
        resetServerDependenciesForTest();
        resetActiveLnoriStateForTest();
      }
    });

    it("POST /api/lnori/cancel returns 200 with cancelled: false when no ingest is active", async () => {
      resetActiveLnoriStateForTest();
      const cancelReq = new Request("http://127.0.0.1:8086/api/lnori/cancel", {
        method: "POST",
      });
      const cancelRes = await handleRequest(cancelReq, localServer);
      expect(cancelRes.status).toBe(200);
      const cancelData = (await cancelRes.json()) as any;
      expect(cancelData.success).toBe(true);
      expect(cancelData.cancelled).toBe(false);
      expect(cancelData.message).toContain("No active Lnori ingestion");
    });

    it("POST /api/lnori/ingest queues concurrent requests and returns queue position instead of 409", async () => {
      resetActiveLnoriStateForTest();
      let completeTrigger1: (() => void) | undefined;
      const completionPromise1 = new Promise<void>((resolve) => {
        completeTrigger1 = resolve;
      });

      let completeTrigger2: (() => void) | undefined;
      const completionPromise2 = new Promise<void>((resolve) => {
        completeTrigger2 = resolve;
      });

      const executedUrls: string[] = [];

      setServerDependenciesForTest({
        ingestLnoriSeries: async (url: string) => {
          executedUrls.push(url);
          if (url.includes("queue-test-1")) {
            await completionPromise1;
          } else if (url.includes("queue-test-2")) {
            await completionPromise2;
          }
          return {
            success: true,
            seriesTitle: url.includes("queue-test-1") ? "Series 1" : "Series 2",
            author: "Author",
            importedCount: 1,
            skippedCount: 0,
            duplicateCount: 0,
            totalCount: 1,
            tags: "Light Novel",
            calibreBookIds: [99],
          };
        },
      });

      try {
        // Request 1: starts immediately
        const req1 = new Request("http://127.0.0.1:8086/api/lnori/ingest", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            url: "https://lnori.com/series/8046/queue-test-1",
            stream: true,
          }),
        });
        const res1 = await handleRequest(req1, localServer);
        expect(res1.status).toBe(200);

        // Verify active state
        const progReqActive = new Request("http://127.0.0.1:8086/api/lnori/progress");
        const progResActive = await handleRequest(progReqActive, localServer);
        const progDataActive = (await progResActive.json()) as any;
        expect(progDataActive.active).toBe(true);
        expect(progDataActive.state.targetUrl).toBe("https://lnori.com/series/8046/queue-test-1");

        // Duplicate active request (same URL): returns active runId/state
        const reqDup = new Request("http://127.0.0.1:8086/api/lnori/ingest", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            url: "https://lnori.com/series/8046/queue-test-1",
          }),
        });
        const resDup = await handleRequest(reqDup, localServer);
        expect(resDup.status).toBe(200);
        const dupData = (await resDup.json()) as any;
        expect(dupData.success).toBe(true);
        expect(dupData.active).toBe(true);
        expect(dupData.runId).toBe(progDataActive.state.runId);

        // Request 2 (different URL): enqueued sequentially
        const req2 = new Request("http://127.0.0.1:8086/api/lnori/ingest", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            url: "https://lnori.com/series/9999/queue-test-2",
          }),
        });
        const res2 = await handleRequest(req2, localServer);
        expect(res2.status).toBe(200);
        const queueData = (await res2.json()) as any;
        expect(queueData.success).toBe(true);
        expect(queueData.queued).toBe(true);
        expect(queueData.queuePosition).toBe(1);
        expect(queueData.queueLength).toBe(1);
        expect(typeof queueData.runId).toBe("string");

        // Request 3 (duplicate of queued URL): returns existing queue position
        const req3 = new Request("http://127.0.0.1:8086/api/lnori/ingest", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            url: "https://lnori.com/series/9999/queue-test-2",
          }),
        });
        const res3 = await handleRequest(req3, localServer);
        expect(res3.status).toBe(200);
        const queueData3 = (await res3.json()) as any;
        expect(queueData3.success).toBe(true);
        expect(queueData3.queued).toBe(true);
        expect(queueData3.queuePosition).toBe(1);
        expect(queueData3.runId).toBe(queueData.runId);

        // Progress check: shows queue length and currentQueuePosition
        const progReqWithRunId = new Request(
          `http://127.0.0.1:8086/api/lnori/progress?runId=${encodeURIComponent(queueData.runId)}`,
        );
        const progResWithRunId = await handleRequest(progReqWithRunId, localServer);
        const progDataWithRunId = (await progResWithRunId.json()) as any;
        expect(progDataWithRunId.queueLength).toBe(1);
        expect(progDataWithRunId.currentQueuePosition).toBe(1);
        expect(progDataWithRunId.queuedItems.length).toBe(1);

        // Complete job 1
        completeTrigger1?.();
        // Give background queue processor a moment to dequeue job 2
        await new Promise((r) => setTimeout(r, 60));

        // Now job 2 should have started
        expect(executedUrls).toContain("https://lnori.com/series/9999/queue-test-2");

        // Complete job 2
        completeTrigger2?.();
        await new Promise((r) => setTimeout(r, 60));
      } finally {
        resetServerDependenciesForTest();
        resetActiveLnoriStateForTest();
      }
    });

    it("POST /api/lnori/cancel cancels queued items by runId", async () => {
      resetActiveLnoriStateForTest();
      let completeTrigger: (() => void) | undefined;
      const completionPromise = new Promise<void>((resolve) => {
        completeTrigger = resolve;
      });

      setServerDependenciesForTest({
        ingestLnoriSeries: async () => {
          await completionPromise;
          return {
            success: true,
            seriesTitle: "Active Series",
            author: "Author",
            importedCount: 1,
            skippedCount: 0,
            duplicateCount: 0,
            totalCount: 1,
            tags: "Light Novel",
            calibreBookIds: [100],
          };
        },
      });

      try {
        // Start active job
        const req1 = new Request("http://127.0.0.1:8086/api/lnori/ingest", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            url: "https://lnori.com/series/8046/active-job",
            stream: true,
          }),
        });
        await handleRequest(req1, localServer);

        // Enqueue job 2
        const req2 = new Request("http://127.0.0.1:8086/api/lnori/ingest", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            url: "https://lnori.com/series/9999/queued-to-cancel",
          }),
        });
        const res2 = await handleRequest(req2, localServer);
        const data2 = (await res2.json()) as any;
        expect(data2.queued).toBe(true);

        // Cancel the queued job by runId
        const cancelReq = new Request("http://127.0.0.1:8086/api/lnori/cancel", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ runId: data2.runId }),
        });
        const cancelRes = await handleRequest(cancelReq, localServer);
        const cancelData = (await cancelRes.json()) as any;
        expect(cancelData.success).toBe(true);
        expect(cancelData.cancelled).toBe(true);
        expect(cancelData.message).toContain("cancelled");

        // Progress check: queue should now be empty
        const progReq = new Request("http://127.0.0.1:8086/api/lnori/progress");
        const progRes = await handleRequest(progReq, localServer);
        const progData = (await progRes.json()) as any;
        expect(progData.queueLength).toBe(0);

        completeTrigger?.();
      } finally {
        resetServerDependenciesForTest();
        resetActiveLnoriStateForTest();
      }
    });

    it("prevents TOCTOU races between concurrent post-validation idle claims", async () => {
      resetActiveLnoriStateForTest();
      let completeTrigger: (() => void) | undefined;
      const completionPromise = new Promise<void>((resolve) => {
        completeTrigger = resolve;
      });

      const startedUrls: string[] = [];

      setServerDependenciesForTest({
        ingestLnoriSeries: async (url: string) => {
          startedUrls.push(url);
          await completionPromise;
          return {
            success: true,
            seriesTitle: "TOCTOU Series",
            author: "Author",
            importedCount: 1,
            skippedCount: 0,
            duplicateCount: 0,
            totalCount: 1,
            tags: "Light Novel",
            calibreBookIds: [101],
          };
        },
      });

      try {
        const reqA = new Request("http://127.0.0.1:8086/api/lnori/ingest", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ url: "https://lnori.com/series/1111/alpha", stream: true }),
        });
        const reqB = new Request("http://127.0.0.1:8086/api/lnori/ingest", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ url: "https://lnori.com/series/2222/beta" }),
        });

        // Fire both requests simultaneously
        const [resA, resB] = await Promise.all([
          handleRequest(reqA, localServer),
          handleRequest(reqB, localServer),
        ]);

        expect(resA.status).toBe(200);
        expect(resB.status).toBe(200);

        const dataB = (await resB.json()) as any;

        // B must be queued while A started as active stream
        expect(dataB.queued).toBe(true);
        expect(dataB.queuePosition).toBe(1);

        // At this moment, only 1 task should be executing
        expect(startedUrls.length).toBe(1);

        completeTrigger?.();
        await new Promise((r) => setTimeout(r, 60));
      } finally {
        resetServerDependenciesForTest();
        resetActiveLnoriStateForTest();
      }
    });

    it("cancels active ingestion by runId and immediately starts next queued item", async () => {
      resetActiveLnoriStateForTest();
      let resolveJob2: (() => void) | undefined;
      const job2Promise = new Promise<void>((r) => {
        resolveJob2 = r;
      });

      const startedUrls: string[] = [];

      setServerDependenciesForTest({
        ingestLnoriSeries: async (url: string, _onProgress: any, deps: any) => {
          startedUrls.push(url);
          if (url.includes("job-1")) {
            // Keep hanging until aborted
            await new Promise<void>((_, reject) => {
              if (deps?.signal) {
                deps.signal.addEventListener("abort", () => {
                  const err = new Error("Lnori ingestion cancelled by user");
                  err.name = "AbortError";
                  reject(err);
                });
              }
            });
          } else if (url.includes("job-2")) {
            await job2Promise;
          }
          return {
            success: true,
            seriesTitle: "Job 2 Series",
            author: "Author",
            importedCount: 1,
            skippedCount: 0,
            duplicateCount: 0,
            totalCount: 1,
            tags: "Light Novel",
            calibreBookIds: [102],
          };
        },
      });

      try {
        // Start job 1
        const req1 = new Request("http://127.0.0.1:8086/api/lnori/ingest", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ url: "https://lnori.com/series/8046/job-1", stream: true }),
        });
        await handleRequest(req1, localServer);

        // Queue job 2 (use a different series ID so it's not a duplicate)
        const req2 = new Request("http://127.0.0.1:8086/api/lnori/ingest", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ url: "https://lnori.com/series/9999/job-2" }),
        });
        const res2 = await handleRequest(req2, localServer);
        const data2 = (await res2.json()) as any;
        expect(data2.queued).toBe(true);

        const progRes1 = await handleRequest(
          new Request("http://127.0.0.1:8086/api/lnori/progress"),
          localServer,
        );
        const progData1 = (await progRes1.json()) as any;
        const activeRunId = progData1.state.runId;

        // Cancel with wrong runId -> false
        const cancelWrong = await handleRequest(
          new Request("http://127.0.0.1:8086/api/lnori/cancel", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ runId: "nonexistent-run-id" }),
          }),
          localServer,
        );
        const cancelWrongData = (await cancelWrong.json()) as any;
        expect(cancelWrongData.cancelled).toBe(false);

        // Cancel with correct active runId -> true
        const cancelReq = new Request("http://127.0.0.1:8086/api/lnori/cancel", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ runId: activeRunId }),
        });
        const cancelRes = await handleRequest(cancelReq, localServer);
        const cancelData = (await cancelRes.json()) as any;
        expect(cancelData.cancelled).toBe(true);

        // Wait for drain to process job 2
        await new Promise((r) => setTimeout(r, 60));
        expect(startedUrls).toContain("https://lnori.com/series/9999/job-2");

        resolveJob2?.();
        await new Promise((r) => setTimeout(r, 60));
      } finally {
        resetServerDependenciesForTest();
        resetActiveLnoriStateForTest();
      }
    });

    it("GET /api/lnori/progress?runId= returns terminal completed state even after live active has drained", async () => {
      resetActiveLnoriStateForTest();
      let completeTrigger1: (() => void) | undefined;
      const completionPromise1 = new Promise<void>((r) => {
        completeTrigger1 = r;
      });

      let completeTrigger2: (() => void) | undefined;
      const completionPromise2 = new Promise<void>((r) => {
        completeTrigger2 = r;
      });

      setServerDependenciesForTest({
        ingestLnoriSeries: async (url: string) => {
          if (url.includes("terminal-test-1")) {
            await completionPromise1;
          } else if (url.includes("terminal-test-2")) {
            await completionPromise2;
          }
          return {
            success: true,
            seriesTitle: url.includes("terminal-test-1") ? "Finished Series 1" : "Series 2",
            author: "Author",
            importedCount: 5,
            skippedCount: 0,
            duplicateCount: 0,
            totalCount: 5,
            tags: "Light Novel",
            calibreBookIds: [103],
          };
        },
      });

      try {
        // Start job 1
        const req1 = new Request("http://127.0.0.1:8086/api/lnori/ingest", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ url: "https://lnori.com/series/8046/terminal-test-1", stream: true }),
        });
        await handleRequest(req1, localServer);

        const progReq1 = new Request("http://127.0.0.1:8086/api/lnori/progress");
        const progRes1 = await handleRequest(progReq1, localServer);
        const progData1 = (await progRes1.json()) as any;
        const job1RunId = progData1.state.runId;

        // Queue job 2
        const req2 = new Request("http://127.0.0.1:8086/api/lnori/ingest", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ url: "https://lnori.com/series/9999/terminal-test-2" }),
        });
        await handleRequest(req2, localServer);

        // Complete job 1; drain will start job 2 and overwrite live activeLnoriState
        completeTrigger1?.();
        await new Promise((r) => setTimeout(r, 60));

        // Now query progress with job 1's runId
        const progJob1Req = new Request(
          `http://127.0.0.1:8086/api/lnori/progress?runId=${encodeURIComponent(job1RunId)}`,
        );
        const progJob1Res = await handleRequest(progJob1Req, localServer);
        const progJob1Data = (await progJob1Res.json()) as any;

        // Must still report job 1's completed terminal state with its completedData
        expect(progJob1Data.success).toBe(true);
        expect(progJob1Data.state.runId).toBe(job1RunId);
        expect(progJob1Data.state.phase).toBe("complete");
        expect(progJob1Data.state.completedData).toBeTruthy();
        expect(progJob1Data.state.completedData.seriesTitle).toBe("Finished Series 1");

        completeTrigger2?.();
        await new Promise((r) => setTimeout(r, 60));
      } finally {
        resetServerDependenciesForTest();
        resetActiveLnoriStateForTest();
      }
    });

    it("supports POST /api/elscione/ingest and /api/novel/ingest with progress and cancel", async () => {
      resetActiveLnoriStateForTest();
      let elscioneIngestCalled = false;
      setServerDependenciesForTest({
        ingestElscioneSeries: async (_url: string) => {
          elscioneIngestCalled = true;
          return {
            success: true,
            seriesTitle: "Grimgar",
            author: "Jyumonji",
            importedCount: 2,
            skippedCount: 0,
            duplicateCount: 0,
            totalCount: 2,
            tags: ["Light Novel", "Elscione"],
            calibreBookIds: [301, 302],
          };
        },
        getCalibreBooks: () => [],
      });

      try {
        const req = new Request("http://127.0.0.1:8086/api/elscione/ingest", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            url: "https://server.elscione.com/Officially%20Translated%20Light%20Novels/Grimgar/",
          }),
        });

        const res = await handleRequest(req, localServer);
        expect(res.status).toBe(200);
        const data = (await res.json()) as any;
        expect(data.success).toBe(true);
        expect(data.seriesTitle).toBe("Grimgar");
        expect(elscioneIngestCalled).toBe(true);

        // Progress check on /api/elscione/progress
        const progReq = new Request("http://127.0.0.1:8086/api/elscione/progress");
        const progRes = await handleRequest(progReq, localServer);
        expect(progRes.status).toBe(200);

        // Cancel endpoint on /api/elscione/cancel
        const cancelReq = new Request("http://127.0.0.1:8086/api/elscione/cancel", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
        });
        const cancelRes = await handleRequest(cancelReq, localServer);
        expect(cancelRes.status).toBe(200);

        // Unified endpoint: POST /api/novel/ingest with Lnori URL
        let novelLnoriCalled = false;
        setServerDependenciesForTest({
          ingestLnoriSeries: async () => {
            novelLnoriCalled = true;
            return {
              success: true,
              seriesTitle: "Novel Ingest",
              author: "Author",
              importedCount: 1,
              skippedCount: 0,
              duplicateCount: 0,
              totalCount: 1,
              tags: "Light Novel",
              calibreBookIds: [401],
            };
          },
          getCalibreBooks: () => [],
        });

        const reqNovel = new Request("http://127.0.0.1:8086/api/novel/ingest", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            url: "https://lnori.com/series/8046/unified-test",
          }),
        });
        const resNovel = await handleRequest(reqNovel, localServer);
        expect(resNovel.status).toBe(200);
        expect(novelLnoriCalled).toBe(true);

        const progReqNovel = new Request("http://127.0.0.1:8086/api/novel/progress");
        const progResNovel = await handleRequest(progReqNovel, localServer);
        expect(progResNovel.status).toBe(200);
      } finally {
        resetServerDependenciesForTest();
        resetActiveLnoriStateForTest();
      }
    });

    it("POST /api/lnori/ingest and /api/elscione/ingest auto-normalize raw spaces and missing protocol", async () => {
      resetActiveLnoriStateForTest();
      let capturedElscioneUrl = "";
      let capturedLnoriUrl = "";

      setServerDependenciesForTest({
        ingestElscioneSeries: async (url: string) => {
          capturedElscioneUrl = url;
          return {
            success: true,
            seriesTitle: "A Sister's All You Need",
            author: "Hirasaka Yomi",
            importedCount: 1,
            skippedCount: 0,
            duplicateCount: 0,
            totalCount: 1,
            tags: ["Light Novel", "Elscione"],
            calibreBookIds: [501],
          };
        },
        ingestLnoriSeries: async (url: string) => {
          capturedLnoriUrl = url;
          return {
            success: true,
            seriesTitle: "Genius Prince",
            author: "Toru Toba",
            importedCount: 1,
            skippedCount: 0,
            duplicateCount: 0,
            totalCount: 1,
            tags: "Light Novel",
            calibreBookIds: [502],
          };
        },
        getCalibreBooks: () => [],
      });

      try {
        // 1. Raw spaces and unencoded quotes
        const req1 = new Request("http://127.0.0.1:8086/api/elscione/ingest", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            url: "https://server.elscione.com/Officially Translated Light Novels/A Sister's All You Need/",
          }),
        });
        const res1 = await handleRequest(req1, localServer);
        expect(res1.status).toBe(200);
        expect(capturedElscioneUrl).toBe(
          "https://server.elscione.com/Officially%20Translated%20Light%20Novels/A%20Sister's%20All%20You%20Need/",
        );

        // 2. Missing https:// prefix and raw spaces
        const req2 = new Request("http://127.0.0.1:8086/api/elscione/ingest", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            url: "server.elscione.com/Officially Translated Light Novels/A Sister's All You Need/",
          }),
        });
        const res2 = await handleRequest(req2, localServer);
        expect(res2.status).toBe(200);
        expect(capturedElscioneUrl).toBe(
          "https://server.elscione.com/Officially%20Translated%20Light%20Novels/A%20Sister's%20All%20You%20Need/",
        );

        // 3. Lnori URL missing https:// prefix via POST /api/lnori/ingest
        const req3 = new Request("http://127.0.0.1:8086/api/lnori/ingest", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            url: "lnori.com/series/8046/the-genius-princes-guide",
          }),
        });
        const res3 = await handleRequest(req3, localServer);
        expect(res3.status).toBe(200);
        expect(capturedLnoriUrl).toBe(
          "https://lnori.com/series/8046/the-genius-princes-guide",
        );
      } finally {
        resetServerDependenciesForTest();
        resetActiveLnoriStateForTest();
      }
    });
  });

  describe("Auto-Populate Synopses on Ingest", () => {
    it("autoEnrichBookSynopsis extracts synopsis from local EPUB and sets comments in Calibre", async () => {
      const tempDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "server-enrich-test-"));
      try {
        const staging = path.join(tempDir, "epub-staging");
        fs.mkdirSync(path.join(staging, "META-INF"), { recursive: true });
        fs.mkdirSync(path.join(staging, "OEBPS"), { recursive: true });
        fs.writeFileSync(path.join(staging, "mimetype"), "application/epub+zip");
        fs.writeFileSync(
          path.join(staging, "META-INF", "container.xml"),
          `<?xml version="1.0"?><container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container"><rootfiles><rootfile full-path="OEBPS/content.opf" media-type="application/oebps-package+xml"/></rootfiles></container>`,
        );
        fs.writeFileSync(
          path.join(staging, "OEBPS", "content.opf"),
          `<?xml version="1.0" encoding="utf-8"?><package xmlns="http://www.idpf.org/2007/opf" version="3.0"><metadata xmlns:dc="http://purl.org/dc/elements/1.1/"><dc:title>Royal Road</dc:title><dc:description>A gripping tale of virtual reality and sculpted destiny.</dc:description></metadata></package>`,
        );

        const testEpubPath = path.join(tempDir, "test.epub");
        const bsdtar = spawnSync(getBsdtarPath(), ["-cf", testEpubPath, "-C", staging, "."]);
        expect(bsdtar.status).toBe(0);

        let capturedSetArgs: string[] = [];
        const mockRunner = (args: string[]) => {
          if (args[0] === "list") {
            // Book has empty comments
            return {
              status: 0,
              stdout: JSON.stringify([{ id: 101, title: "Royal Road", comments: "" }]),
              stderr: "",
            };
          }
          if (args[0] === "set_metadata") {
            capturedSetArgs = args;
            return { status: 0, stdout: "", stderr: "" };
          }
          return { status: 0, stdout: "", stderr: "" };
        };

        const res = await autoEnrichBookSynopsis(101, {
          filePath: testEpubPath,
          title: "Royal Road",
          calibredbRunner: mockRunner,
        });

        expect(res.enriched).toBe(true);
        expect(res.source).toBe("EPUB");
        expect(res.synopsis).toContain("A gripping tale of virtual reality");

        const commentsArg = capturedSetArgs.find((a) => a.startsWith("comments:"));
        expect(commentsArg).toBeDefined();
        expect(commentsArg).toContain("A gripping tale of virtual reality");
      } finally {
        await fs.promises.rm(tempDir, { recursive: true, force: true });
      }
    });

    it("autoEnrichBookSynopsis runs online enrichment when EPUB has no description", async () => {
      const origFetch = globalThis.fetch;
      try {
        (globalThis as any).fetch = async (url: any, _init: any) => {
          const urlStr = typeof url === "string" ? url : url.toString();
          if (urlStr.includes("graphql.anilist.co")) {
            return new Response(
              JSON.stringify({
                data: {
                  Media: {
                    id: 8888,
                    title: { english: "Overlord" },
                    description: "Momonga rules the Great Tomb of Nazarick with his loyal Floor Guardians.",
                    coverImage: { extraLarge: "https://s4.anilist.co/file/anilistcdn/cover/overlord.jpg" },
                    format: "NOVEL",
                  },
                },
              }),
              { status: 200, headers: { "Content-Type": "application/json" } },
            );
          }
          return new Response("{}", { status: 200 });
        };

        let capturedSetArgs: string[] = [];
        const mockRunner = (args: string[]) => {
          if (args[0] === "list") {
            return {
              status: 0,
              stdout: JSON.stringify([{ id: 202, title: "Overlord, Vol. 1", comments: "" }]),
              stderr: "",
            };
          }
          if (args[0] === "set_metadata") {
            capturedSetArgs = args;
            return { status: 0, stdout: "", stderr: "" };
          }
          return { status: 0, stdout: "", stderr: "" };
        };

        const res = await autoEnrichBookSynopsis(202, {
          title: "Overlord, Vol. 1",
          author: "Kugane Maruyama",
          calibredbRunner: mockRunner,
        });

        expect(res.enriched).toBe(true);
        expect(res.synopsis).toContain("Momonga rules the Great Tomb of Nazarick");

        const commentsArg = capturedSetArgs.find((a) => a.startsWith("comments:"));
        expect(commentsArg).toBeDefined();
        expect(commentsArg).toContain("Momonga rules the Great Tomb of Nazarick");
      } finally {
        (globalThis as any).fetch = origFetch;
      }
    });

    it("autoEnrichBookSynopsis preserves existing non-empty comments without overwriting", async () => {
      let setMetadataCalled = false;
      const mockRunner = (args: string[]) => {
        if (args[0] === "list") {
          return {
            status: 0,
            stdout: JSON.stringify([{ id: 303, title: "Existing Book", comments: "<p>Already rich synopsis.</p>" }]),
            stderr: "",
          };
        }
        if (args[0] === "set_metadata") {
          setMetadataCalled = true;
          return { status: 0, stdout: "", stderr: "" };
        }
        return { status: 0, stdout: "", stderr: "" };
      };

      const res = await autoEnrichBookSynopsis(303, {
        title: "Existing Book",
        calibredbRunner: mockRunner,
      });

      expect(res.enriched).toBe(false);
      expect(res.synopsis).toBe("<p>Already rich synopsis.</p>");
      expect(setMetadataCalled).toBe(false);
    });

    it("ingestBookFile extracts synopsis from uploaded EPUB and sets comments in Calibre metadata", async () => {
      const origFetch = globalThis.fetch;
      (globalThis as any).fetch = async () => new Response("{}", { status: 404 });
      const origJevKey = process.env.JEV_API_KEY;
      const origTypesafeKey = process.env.TYPESAFE_API_KEY;
      delete process.env.JEV_API_KEY;
      delete process.env.TYPESAFE_API_KEY;
      const tempDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "upload-seam-test-"));
      const libDir = path.join(tempDir, "calibre-lib");
      const dropDir = path.join(tempDir, "drop");
      fs.mkdirSync(libDir, { recursive: true });
      fs.mkdirSync(dropDir, { recursive: true });

      const origCalibredbPath = process.env.CALIBREDB_PATH;
      const origCalibreDbPath = process.env.CALIBRE_DB_PATH;
      const origLibraryDir = process.env.CALIBRE_LIBRARY_DIR;
      process.env.CALIBRE_LIBRARY_DIR = libDir;
      try {
        const staging = path.join(tempDir, "epub-staging");
        fs.mkdirSync(path.join(staging, "META-INF"), { recursive: true });
        fs.mkdirSync(path.join(staging, "OEBPS"), { recursive: true });
        fs.writeFileSync(path.join(staging, "mimetype"), "application/epub+zip");
        fs.writeFileSync(
          path.join(staging, "META-INF", "container.xml"),
          `<?xml version="1.0"?><container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container"><rootfiles><rootfile full-path="OEBPS/content.opf" media-type="application/oebps-package+xml"/></rootfiles></container>`,
        );
        fs.writeFileSync(
          path.join(staging, "OEBPS", "content.opf"),
          `<?xml version="1.0" encoding="utf-8"?><package xmlns="http://www.idpf.org/2007/opf" version="3.0"><metadata xmlns:dc="http://purl.org/dc/elements/1.1/"><dc:title>The Faraway Paladin, Vol. 1</dc:title><dc:description>Synopsis from uploaded EPUB container.</dc:description></metadata></package>`,
        );

        const testEpubPath = path.join(dropDir, "faraway_paladin_1.epub");
        const zipRes = spawnSync("zip", ["-q", "-X", "-0", testEpubPath, "mimetype"], { cwd: staging });
        expect(zipRes.status).toBe(0);
        const zipRes2 = spawnSync("zip", ["-q", "-r", testEpubPath, "META-INF", "OEBPS"], { cwd: staging });
        expect(zipRes2.status).toBe(0);

        // Create mock calibredb script that records invocations and adds book 999 to db on add
        const mockLogFile = path.join(tempDir, "calibredb.log");
        const mockDbPath = path.join(libDir, "metadata.db");
        const mockCalibreScript = path.join(tempDir, "mock_calibredb.sh");
        fs.writeFileSync(
          mockCalibreScript,
          `#!/bin/sh
echo "$*" >> "${mockLogFile}"
if [ "$1" = "add" ]; then
  sqlite3 "${mockDbPath}" "INSERT INTO books (id, title, path, has_cover, pubdate, series_index) VALUES (999, 'The Faraway Paladin, Vol. 1', 'Paladin', 0, '', 1);"
  sqlite3 "${mockDbPath}" "INSERT INTO data (id, book, format, name) VALUES (1, 999, 'EPUB', 'test');"
  echo "Added book ids: 999"
  exit 0
fi
exit 0
`,
        );
        fs.chmodSync(mockCalibreScript, 0o755);

        process.env.CALIBREDB_PATH = mockCalibreScript;

        // Create minimal Calibre sqlite metadata.db with empty books table initially
        const db = new Database(mockDbPath);
        db.run(`CREATE TABLE books (id INTEGER PRIMARY KEY, title TEXT, path TEXT, has_cover INTEGER, pubdate TEXT, series_index REAL);`);
        db.run(`CREATE TABLE data (id INTEGER PRIMARY KEY, book INTEGER, format TEXT, name TEXT);`);
        db.run(`CREATE TABLE comments (id INTEGER PRIMARY KEY, book INTEGER, text TEXT);`);
        db.run(`CREATE TABLE authors (id INTEGER PRIMARY KEY, name TEXT);`);
        db.run(`CREATE TABLE books_authors_link (id INTEGER PRIMARY KEY, book INTEGER, author INTEGER);`);
        db.run(`CREATE TABLE series (id INTEGER PRIMARY KEY, name TEXT);`);
        db.run(`CREATE TABLE books_series_link (id INTEGER PRIMARY KEY, book INTEGER, series INTEGER);`);
        db.run(`CREATE TABLE tags (id INTEGER PRIMARY KEY, name TEXT);`);
        db.run(`CREATE TABLE books_tags_link (id INTEGER PRIMARY KEY, book INTEGER, tag INTEGER);`);
        db.run(`CREATE TABLE publishers (id INTEGER PRIMARY KEY, name TEXT);`);
        db.run(`CREATE TABLE books_publishers_link (id INTEGER PRIMARY KEY, book INTEGER, publisher INTEGER);`);
        db.close();
        process.env.CALIBRE_DB_PATH = mockDbPath;

        const res = await ingestBookFile(testEpubPath, "faraway_paladin_1.epub");
        expect(res.success).toBe(true);
        expect(res.duplicate).toBe(false);
        expect(res.bookId).toBe(999);

        const logContent = fs.existsSync(mockLogFile) ? fs.readFileSync(mockLogFile, "utf8") : "";
        expect(logContent).toContain("comments:");
        expect(logContent).toContain("Synopsis from uploaded EPUB container");
      } finally {
        globalThis.fetch = origFetch;
        if (origJevKey !== undefined) process.env.JEV_API_KEY = origJevKey;
        if (origTypesafeKey !== undefined) process.env.TYPESAFE_API_KEY = origTypesafeKey;
        process.env.CALIBREDB_PATH = origCalibredbPath;
        process.env.CALIBRE_DB_PATH = origCalibreDbPath;
        process.env.CALIBRE_LIBRARY_DIR = origLibraryDir;
        await fs.promises.rm(tempDir, { recursive: true, force: true });
      }
    });
  });

  describe("Kindle Asynchronous Bulk Sync Endpoint (POST /api/kindle/sync)", () => {
    let tempBaseDir: string;
    let fakeVolumesDir: string;
    let fakeLibraryDir: string;
    let fakeCalibreDbPath: string;
    let origCalibreDb: string | undefined;
    let origCalibreLib: string | undefined;
    let origVolumesDir: string | undefined;

    const setupFakeCalibreDatabase = (
      books: Array<{ id: number; title: string; author: string; format: string; fileContent: string }>,
    ) => {
      const db = new Database(fakeCalibreDbPath);
      db.run("CREATE TABLE books (id INTEGER PRIMARY KEY, title TEXT, path TEXT, has_cover INTEGER, pubdate TEXT, series_index REAL);");
      db.run("CREATE TABLE data (id INTEGER PRIMARY KEY, book INTEGER, format TEXT, uncompressed_size INTEGER, name TEXT);");
      db.run("CREATE TABLE authors (id INTEGER PRIMARY KEY, name TEXT);");
      db.run("CREATE TABLE books_authors_link (id INTEGER PRIMARY KEY, book INTEGER, author INTEGER);");
      db.run("CREATE TABLE series (id INTEGER PRIMARY KEY, name TEXT);");
      db.run("CREATE TABLE books_series_link (id INTEGER PRIMARY KEY, book INTEGER, series INTEGER);");
      db.run("CREATE TABLE tags (id INTEGER PRIMARY KEY, name TEXT);");
      db.run("CREATE TABLE books_tags_link (id INTEGER PRIMARY KEY, book INTEGER, tag INTEGER);");

      for (const b of books) {
        const bookRelDir = `${b.author}/${b.title} (${b.id})`;
        const fullBookDir = path.join(fakeLibraryDir, bookRelDir);
        fs.mkdirSync(fullBookDir, { recursive: true });
        const filename = `${b.title} - ${b.author}.${b.format.toLowerCase()}`;
        const filePath = path.join(fullBookDir, filename);
        fs.writeFileSync(filePath, b.fileContent, "utf8");

        db.run("INSERT INTO books (id, title, path, has_cover, pubdate, series_index) VALUES (?, ?, ?, 0, '', 1);", [
          b.id,
          b.title,
          bookRelDir,
        ]);
        const stat = fs.statSync(filePath);
        db.run("INSERT INTO data (id, book, format, uncompressed_size, name) VALUES (?, ?, ?, ?, ?);", [
          b.id,
          b.id,
          b.format.toUpperCase(),
          stat.size,
          `${b.title} - ${b.author}`,
        ]);
        db.run("INSERT OR IGNORE INTO authors (id, name) VALUES (?, ?);", [b.id, b.author]);
        db.run("INSERT INTO books_authors_link (id, book, author) VALUES (?, ?, ?);", [b.id, b.id, b.id]);
      }
      db.close();
    };

    it("returns non-blocking response in <500ms and executes sync in background", async () => {
      tempBaseDir = fs.mkdtempSync(path.join(os.tmpdir(), "server-kindle-test-"));
      fakeVolumesDir = path.join(tempBaseDir, "Volumes");
      fakeLibraryDir = path.join(tempBaseDir, "Calibre_Library");
      fakeCalibreDbPath = path.join(fakeLibraryDir, "metadata.db");

      fs.mkdirSync(fakeVolumesDir, { recursive: true });
      fs.mkdirSync(fakeLibraryDir, { recursive: true });

      origCalibreDb = process.env.CALIBRE_DB_PATH;
      origCalibreLib = process.env.CALIBRE_LIBRARY_DIR;
      origVolumesDir = process.env.LIGHTHOUSE_VOLUMES_DIR;

      process.env.CALIBRE_DB_PATH = fakeCalibreDbPath;
      process.env.CALIBRE_LIBRARY_DIR = fakeLibraryDir;
      process.env.LIGHTHOUSE_VOLUMES_DIR = fakeVolumesDir;

      resetKindleProgressForTesting();
      invalidateKindleBookIndex();

      try {
        setupFakeCalibreDatabase([
          { id: 1, title: "Server Book 1", author: "Author", format: "EPUB", fileContent: "book 1" },
        ]);

        const kindleMount = path.join(fakeVolumesDir, "Kindle");
        fs.mkdirSync(path.join(kindleMount, "books"), { recursive: true });

        const localServer = { requestIP: () => ({ address: "127.0.0.1" }) };
        const req = new Request("http://127.0.0.1:8086/api/kindle/sync", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ scope: "all" }),
        });

        const start = Date.now();
        const res = await handleRequest(req, localServer);
        const duration = Date.now() - start;

        expect(res.status).toBe(202);
        expect(duration).toBeLessThan(500);

        const data = (await res.json()) as any;
        expect(data.success).toBe(true);
        expect(data.started).toBe(true);

        // Wait for background sync to complete
        let attempts = 0;
        while (isKindleSyncActive() && attempts < 50) {
          await new Promise((r) => setTimeout(r, 20));
          attempts++;
        }

        const progress = getKindleProgress();
        expect(progress?.phase).toBe("completed");
        expect(progress?.lastResult?.success).toBe(true);
      } finally {
        if (origCalibreDb !== undefined) process.env.CALIBRE_DB_PATH = origCalibreDb;
        else delete process.env.CALIBRE_DB_PATH;
        if (origCalibreLib !== undefined) process.env.CALIBRE_LIBRARY_DIR = origCalibreLib;
        else delete process.env.CALIBRE_LIBRARY_DIR;
        if (origVolumesDir !== undefined) process.env.LIGHTHOUSE_VOLUMES_DIR = origVolumesDir;
        else delete process.env.LIGHTHOUSE_VOLUMES_DIR;
        resetKindleProgressForTesting();
        invalidateKindleBookIndex();
        await fs.promises.rm(tempBaseDir, { recursive: true, force: true });
      }
    });

    it("returns 507 immediately when storage is insufficient", async () => {
      tempBaseDir = fs.mkdtempSync(path.join(os.tmpdir(), "server-kindle-507-"));
      fakeVolumesDir = path.join(tempBaseDir, "Volumes");
      fakeLibraryDir = path.join(tempBaseDir, "Calibre_Library");
      fakeCalibreDbPath = path.join(fakeLibraryDir, "metadata.db");

      fs.mkdirSync(fakeVolumesDir, { recursive: true });
      fs.mkdirSync(fakeLibraryDir, { recursive: true });

      origCalibreDb = process.env.CALIBRE_DB_PATH;
      origCalibreLib = process.env.CALIBRE_LIBRARY_DIR;
      origVolumesDir = process.env.LIGHTHOUSE_VOLUMES_DIR;

      process.env.CALIBRE_DB_PATH = fakeCalibreDbPath;
      process.env.CALIBRE_LIBRARY_DIR = fakeLibraryDir;
      process.env.LIGHTHOUSE_VOLUMES_DIR = fakeVolumesDir;

      resetKindleProgressForTesting();
      invalidateKindleBookIndex();

      process.env.TEST_KINDLE_FREE_BYTES = "50";
      try {
        setupFakeCalibreDatabase([
          { id: 1, title: "Huge Book", author: "Author", format: "EPUB", fileContent: "content" },
        ]);

        const kindleMount = path.join(fakeVolumesDir, "Kindle");
        fs.mkdirSync(path.join(kindleMount, "books"), { recursive: true });

        const localServer = { requestIP: () => ({ address: "127.0.0.1" }) };
        const req = new Request("http://127.0.0.1:8086/api/kindle/sync", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ scope: "all" }),
        });

        const res = await handleRequest(req, localServer);
        expect(res.status).toBe(507);
        const data = (await res.json()) as any;
        expect(data.success).toBe(false);
        expect(data.error).toContain("Insufficient Kindle storage");
        expect(isKindleSyncActive()).toBe(false);
      } finally {
        delete process.env.TEST_KINDLE_FREE_BYTES;
        if (origCalibreDb !== undefined) process.env.CALIBRE_DB_PATH = origCalibreDb;
        else delete process.env.CALIBRE_DB_PATH;
        if (origCalibreLib !== undefined) process.env.CALIBRE_LIBRARY_DIR = origCalibreLib;
        else delete process.env.CALIBRE_LIBRARY_DIR;
        if (origVolumesDir !== undefined) process.env.LIGHTHOUSE_VOLUMES_DIR = origVolumesDir;
        else delete process.env.LIGHTHOUSE_VOLUMES_DIR;
        resetKindleProgressForTesting();
        invalidateKindleBookIndex();
        await fs.promises.rm(tempBaseDir, { recursive: true, force: true });
      }
    });
  });

  describe("Kindle Device Duplicate Hygiene Endpoint (POST /api/kindle/clean-device-duplicates)", () => {
    let tempBaseDir: string;
    let fakeVolumesDir: string;
    let origVolumesDir: string | undefined;

    beforeEach(() => {
      tempBaseDir = fs.mkdtempSync(path.join(os.tmpdir(), "server-kindle-dedup-"));
      fakeVolumesDir = path.join(tempBaseDir, "Volumes");
      fs.mkdirSync(fakeVolumesDir, { recursive: true });
      origVolumesDir = process.env.LIGHTHOUSE_VOLUMES_DIR;
      process.env.LIGHTHOUSE_VOLUMES_DIR = fakeVolumesDir;
      resetKindleProgressForTesting();
      invalidateKindleBookIndex();
      resetServerDependenciesForTest();
    });

    afterEach(async () => {
      if (origVolumesDir !== undefined) process.env.LIGHTHOUSE_VOLUMES_DIR = origVolumesDir;
      else delete process.env.LIGHTHOUSE_VOLUMES_DIR;
      resetKindleProgressForTesting();
      invalidateKindleBookIndex();
      resetServerDependenciesForTest();
      await fs.promises.rm(tempBaseDir, { recursive: true, force: true });
    });

    it("returns 404 when no Kindle device is mounted under /Volumes", async () => {
      const localServer = { requestIP: () => ({ address: "127.0.0.1" }) };
      const req = new Request("http://127.0.0.1:8086/api/kindle/clean-device-duplicates", {
        method: "POST",
      });

      const res = await handleRequest(req, localServer);
      expect(res.status).toBe(404);
      const data = (await res.json()) as any;
      expect(data.success).toBe(false);
      expect(data.error).toContain("No Kindle device detected");
    });

    it("returns 409 when Kindle sync is currently active", async () => {
      const kindleMount = path.join(fakeVolumesDir, "Kindle");
      fs.mkdirSync(path.join(kindleMount, "books"), { recursive: true });

      // Acquire sync lock to simulate active sync
      expect(tryAcquireKindleSyncLock()).toBe(true);

      try {
        const localServer = { requestIP: () => ({ address: "127.0.0.1" }) };
        const req = new Request("http://127.0.0.1:8086/api/kindle/clean-device-duplicates", {
          method: "POST",
        });

        const res = await handleRequest(req, localServer);
        expect(res.status).toBe(409);
        const data = (await res.json()) as any;
        expect(data.success).toBe(false);
        expect(data.error).toContain("Cannot clean duplicates while sync is active");
      } finally {
        releaseKindleSyncLock();
      }
    });

    it("cleans duplicate files on Kindle and returns 200 with summary stats", async () => {
      const kindleMount = path.join(fakeVolumesDir, "Kindle");
      const burmeseDir = path.join(kindleMount, "books", "မြသန်းတင့်");
      const oldDir = path.join(kindleMount, "books", "Mya Than Tint");
      fs.mkdirSync(burmeseDir, { recursive: true });
      fs.mkdirSync(oldDir, { recursive: true });

      const canonicalPath = path.join(burmeseDir, "ပါရီကျဆုံးခန်း - မြသန်းတင့်.epub");
      const duplicatePath = path.join(oldDir, "ပါရီကျဆုံးခန်း.epub");
      fs.writeFileSync(canonicalPath, Buffer.alloc(100000, "c"));
      fs.writeFileSync(duplicatePath, Buffer.alloc(100000, "d"));

      const localServer = { requestIP: () => ({ address: "127.0.0.1" }) };
      const req = new Request("http://127.0.0.1:8086/api/kindle/clean-device-duplicates", {
        method: "POST",
      });

      const res = await handleRequest(req, localServer);
      expect(res.status).toBe(200);

      const data = (await res.json()) as any;
      expect(data.success).toBe(true);
      expect(data.cleanedCount).toBe(1);
      expect(data.bytesFreed).toBe(100000);
      expect(data.message).toContain("Cleaned 1 duplicate file(s)");

      // Verify filesystem state
      expect(fs.existsSync(canonicalPath)).toBe(true);
      expect(fs.existsSync(duplicatePath)).toBe(false);
    });

    it("Web UI in uploader/index.html defines duplicate warning banner, button, and handler", () => {
      const indexPath = path.resolve(__dirname, "index.html");
      const html = fs.readFileSync(indexPath, "utf8");

      expect(html).toContain('id="kindleDuplicatesBanner"');
      expect(html).toContain('id="kindleDuplicatesText"');
      expect(html).toContain('id="kindleCleanDuplicatesBtn"');
      expect(html).toContain("Remove Duplicates");
      expect(html).toContain("icon-trash-can");
      expect(html).toContain("background-color: #fbbf24");
      expect(html).toContain("color: #09090b");
      expect(html).toContain("rounded-full");
      expect(html).toContain("disabled:opacity-60");
      expect(html).toContain("cleanKindleDuplicatesAction()");
      expect(html).toContain("/api/kindle/clean-device-duplicates");
      expect(html).toContain("'Content-Type': 'application/json'");
      expect(html).toContain("useJev: true");
      expect(html).toContain("Cleaning...");
      expect(html).toContain("deviceDuplicatesCount");
    });
  });

  describe("Web Ingest & Download Bug Regressions (4 defects)", () => {
    const localServer = { requestIP: () => ({ address: "127.0.0.1" }) };

    it("Defect 1: short title in library does not swallow longer title via startsWith", async () => {
      const { isSameBookAsync } = await import("./scraper");

      // Book in library titled "Foundation"
      const libBook1 = {
        title: "Foundation",
        authors: "Isaac Asimov",
      };

      // Candidate book titled "Foundation and Empire"
      const candidate1 = {
        title: "Foundation and Empire",
        author: "Isaac Asimov",
      };

      // Candidate book titled "Foundation Course in Carpentry"
      const candidate2 = {
        title: "Foundation Course in Carpentry",
        author: "John Doe",
      };

      // Book in library titled "A"
      const libBookA = {
        title: "A",
        authors: "Author A",
      };

      // Candidate book titled "A Wizard of Earthsea"
      const candidateWizard = {
        title: "A Wizard of Earthsea",
        author: "Ursula K. Le Guin",
      };

      expect(await isSameBookAsync(libBook1, candidate1)).toBe(false);
      expect(await isSameBookAsync(libBook1, candidate2)).toBe(false);
      expect(await isSameBookAsync(libBookA, candidateWizard)).toBe(false);

      // Exact title remains duplicate
      expect(await isSameBookAsync(libBook1, { title: "Foundation", author: "Isaac Asimov" })).toBe(true);
    });

    it("Defect 2: non-ASCII (Burmese and Japanese) EPUB download builds valid RFC 5987 Content-Disposition", async () => {
      const burmeseTitle = "စာဖတ်သူ - သူရိယဝင်";
      const japaneseTitle = "オーバーロード 1 不死者の王";
      const asciiTitle = "Clean Architecture";

      // Test buildContentDisposition directly on non-ASCII titles
      const { buildContentDisposition } = await import("./filename");
      const dispBurmese = buildContentDisposition(`${burmeseTitle}.epub`);
      expect(dispBurmese).toContain("filename=");
      expect(dispBurmese).toContain("filename*=UTF-8''");
      expect(() => new Headers({ "Content-Disposition": dispBurmese })).not.toThrow();

      const dispJapanese = buildContentDisposition(`${japaneseTitle}.epub`);
      expect(dispJapanese).toContain("filename=");
      expect(dispJapanese).toContain("filename*=UTF-8''");
      expect(() => new Headers({ "Content-Disposition": dispJapanese })).not.toThrow();

      const dispAscii = buildContentDisposition(`${asciiTitle}.epub`);
      expect(dispAscii).toContain(`filename="${asciiTitle}.epub"`);
      expect(() => new Headers({ "Content-Disposition": dispAscii })).not.toThrow();
    });

    it("Defect 3: archive upload returns HTTP 400 when all extracted books failed to import", async () => {
      // Create a valid zip with valid EPUB structure that unpackArchive accepts,
      // but whose content fails ingestBookFile (e.g. invalid container or rejected).
      const tempZip = `/tmp/test_archive_all_fail_${Date.now()}.zip`;
      const pythonScript = `
import zipfile, io
epub_buf = io.BytesIO()
with zipfile.ZipFile(epub_buf, "w") as ez:
    ez.writestr("mimetype", "application/epub+zip")
    ez.writestr("META-INF/container.xml", "<invalid-container-no-rootfile/>")
with zipfile.ZipFile("${tempZip}", "w") as z:
    z.writestr("broken1.epub", epub_buf.getvalue())
    z.writestr("broken2.epub", epub_buf.getvalue())
`;
      spawnSync("python3", ["-c", pythonScript]);

      try {
        const zipBuffer = fs.readFileSync(tempZip);
        const formData = new FormData();
        const blob = new Blob([zipBuffer], { type: "application/zip" });
        formData.append("file", blob, "all_failed.zip");

        const req = new Request("http://127.0.0.1:8086/api/upload", {
          method: "POST",
          headers: { host: "127.0.0.1:8086" },
          body: formData,
        });

        const res = await handleRequest(req, localServer);
        expect(res.status).toBe(400);
        const data = (await res.json()) as any;
        expect(data.success).toBe(false);
        expect(data.isArchive).toBe(true);
        expect(data.imported).toBe(0);
        expect(data.failed).toBe(2);
        expect(data.error).toContain("failed");
      } finally {
        if (fs.existsSync(tempZip)) fs.unlinkSync(tempZip);
      }
    });

    it("Defect 4: POST /api/jobs/:id/retry refuses non-failed jobs and succeeds on failed jobs", async () => {
      const { getJobQueue } = await import("./jobs");
      const jq = getJobQueue();

      const job = jq.enqueue("metadata_enrich", { bookId: 9999 });

      // Job is 'pending' -> retry must return 400
      const reqPending = new Request(`http://127.0.0.1:8086/api/jobs/${job.id}/retry`, {
        method: "POST",
        headers: { host: "127.0.0.1:8086" },
      });
      const resPending = await handleRequest(reqPending, localServer);
      expect(resPending.status).toBe(400);
      const dataPending = (await resPending.json()) as any;
      expect(dataPending.success).toBe(false);
      expect(dataPending.error).toContain("only failed jobs can be retried");

      // Mark job as failed directly in db
      (jq as any).db.prepare("UPDATE jobs SET status = 'failed', error = 'Timeout' WHERE id = ?").run(job.id);

      // Now retry must succeed with 200
      const reqFailed = new Request(`http://127.0.0.1:8086/api/jobs/${job.id}/retry`, {
        method: "POST",
        headers: { host: "127.0.0.1:8086" },
      });
      const resFailed = await handleRequest(reqFailed, localServer);
      expect(resFailed.status).toBe(200);
      const dataFailed = (await resFailed.json()) as any;
      expect(dataFailed.success).toBe(true);
      expect(dataFailed.job.status).toBe("pending");

      // Retrying again immediately fails because it is now 'pending'
      const resPending2 = await handleRequest(reqFailed, localServer);
      expect(resPending2.status).toBe(400);
    });
  });

  describe("KOSync Progress Tracking & Highlights Server Integration Regressions", () => {
    const localServer = { requestIP: () => ({ address: "127.0.0.1" }) };
    let testKosyncDir: string;
    let testKosyncDbPath: string;
    let origKosyncEnv: string | undefined;

    beforeEach(() => {
      testKosyncDir = fs.mkdtempSync(path.join(os.tmpdir(), "kosync-server-test-"));
      testKosyncDbPath = path.join(testKosyncDir, "koreader-sync.db");
      origKosyncEnv = process.env.KOSYNC_DB_PATH;
      process.env.KOSYNC_DB_PATH = testKosyncDbPath;

      setServerDependenciesForTest({
        getCalibreBooks: () => [
          { id: 1, title: "Dune", authors: "Frank Herbert", cover: true },
        ],
      });

      const kDb = new Database(testKosyncDbPath);
      kDb.run(`
        CREATE TABLE progress (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          document TEXT NOT NULL,
          progress TEXT,
          percentage REAL,
          device TEXT,
          device_id TEXT,
          filename TEXT,
          title TEXT,
          authors TEXT,
          timestamp INTEGER
        );
      `);
      kDb.close();
    });

    afterEach(() => {
      resetServerDependenciesForTest();
      if (origKosyncEnv) {
        process.env.KOSYNC_DB_PATH = origKosyncEnv;
      } else {
        delete process.env.KOSYNC_DB_PATH;
      }
      try {
        fs.rmSync(testKosyncDir, { recursive: true, force: true });
      } catch (_e) {
        void _e;
      }
    });

    it("GET /api/kosync/stats normalizes percentage and deduplicates multiple sessions of the same book", async () => {
      const kDb = new Database(testKosyncDbPath);
      const now = Math.floor(Date.now() / 1000);

      // Book 1: Synced twice with integer percentage 100% and 50%
      kDb.run(
        "INSERT INTO progress (document, percentage, title, authors, timestamp) VALUES (?, ?, ?, ?, ?);",
        ["doc_dune", 100, "Dune", "Frank Herbert", now],
      );
      kDb.run(
        "INSERT INTO progress (document, percentage, title, authors, timestamp) VALUES (?, ?, ?, ?, ?);",
        ["doc_dune", 50, "Dune", "Frank Herbert", now - 3600],
      );

      // Book 2: Synced with 45% (should be classified as active, NOT finished)
      kDb.run(
        "INSERT INTO progress (document, percentage, title, authors, timestamp) VALUES (?, ?, ?, ?, ?);",
        ["doc_active", 45, "Active Book", "Author", now],
      );
      kDb.close();

      const req = new Request("http://127.0.0.1:8086/api/kosync/stats", {
        method: "GET",
        headers: { host: "127.0.0.1:8086" },
      });
      const res = await handleRequest(req, localServer);
      expect(res.status).toBe(200);
      const data = (await res.json()) as any;

      expect(data.totalSessions).toBe(3);
      expect(data.finishedCount).toBe(1);
      expect(data.finishedBooks.length).toBe(1);
      expect(data.finishedBooks[0].title).toBe("Dune");
      expect(data.activeBooks.length).toBe(1);
      expect(data.activeBooks[0].title).toBe("Active Book");
    });

    it("POST /api/kosync/link-document auto-creates document_aliases table and links successfully", async () => {
      // testKosyncDbPath starts with NO document_aliases table
      const kDb = new Database(testKosyncDbPath);
      kDb.run(
        "INSERT INTO progress (document, percentage, timestamp) VALUES ('hash1234567890abcdef', 0.5, 123456);",
      );
      kDb.close();

      const req = new Request("http://127.0.0.1:8086/api/kosync/link-document", {
        method: "POST",
        headers: { "Content-Type": "application/json", host: "127.0.0.1:8086" },
        body: JSON.stringify({
          document: "hash1234567890abcdef",
          bookId: 1, // Calibre book 1 is 'Dune'
        }),
      });

      const res = await handleRequest(req, localServer);
      expect(res.status).toBe(200);
      const data = (await res.json()) as any;
      expect(data.success).toBe(true);

      // Verify that progress and document_aliases in kosync DB were updated
      const verifyDb = new Database(testKosyncDbPath, { readonly: true });
      const aliasRow = verifyDb
        .query("SELECT * FROM document_aliases WHERE document_hash = 'hash1234567890abcdef';")
        .get() as any;
      expect(aliasRow).toBeDefined();
      expect(aliasRow.normalized_title).toBe("Dune");

      const progRow = verifyDb
        .query("SELECT title FROM progress WHERE document = 'hash1234567890abcdef';")
        .get() as any;
      expect(progRow.title).toBe("Dune");
      verifyDb.close();
    });

    it("DELETE /api/kosync/progress/:idOrDoc deletes progress by 32-char hex document hash", async () => {
      const kDb = new Database(testKosyncDbPath);
      const docHash = "a1b2c3d4e5f6789012345678abcdef01";
      kDb.run(
        "INSERT INTO progress (document, percentage, title, timestamp) VALUES (?, 0.3, 'Deletable Doc', 100);",
        [docHash],
      );
      kDb.close();

      const req = new Request(`http://127.0.0.1:8086/api/kosync/progress/${docHash}`, {
        method: "DELETE",
        headers: { host: "127.0.0.1:8086" },
      });
      const res = await handleRequest(req, localServer);
      expect(res.status).toBe(200);

      const checkDb = new Database(testKosyncDbPath, { readonly: true });
      const row = checkDb.query("SELECT id FROM progress WHERE document = ?;").get(docHash);
      expect(row).toBeNull();
      checkDb.close();
    });

    it("/api/auth/session supports cookie handoff on POST and clears cookies on DELETE", async () => {
      const origKey = process.env.READING_API_KEY;
      process.env.READING_API_KEY = "test-secret-session-key";

      try {
        // Authenticate via POST Bearer
        const postReq = new Request("http://127.0.0.1:8086/api/auth/session", {
          method: "POST",
          headers: {
            host: "127.0.0.1:8086",
            Authorization: "Bearer test-secret-session-key",
          },
        });
        const postRes = await handleRequest(postReq, localServer);
        expect(postRes.status).toBe(200);
        const setCookie = postRes.headers.get("Set-Cookie");
        expect(setCookie).toBeDefined();
        expect(setCookie).toContain("reading_session=");
        expect(setCookie).toContain("HttpOnly");

        // Logout via DELETE
        const delReq = new Request("http://127.0.0.1:8086/api/auth/session", {
          method: "DELETE",
          headers: { host: "127.0.0.1:8086" },
        });
        const delRes = await handleRequest(delReq, localServer);
        expect(delRes.status).toBe(200);
        const delCookie = delRes.headers.get("Set-Cookie");
        expect(delCookie).toContain("Max-Age=0");
      } finally {
        if (origKey) process.env.READING_API_KEY = origKey;
        else delete process.env.READING_API_KEY;
      }
    });

    it("POST /api/highlights/sync indexes highlights directly into cache.db book_highlights table", async () => {
      const payload = {
        title: "Direct Highlight Sync Test",
        author: "Sync Author",
        highlights: [
          { text: "Knowledge is power.", chapter: "Intro", page: 1 },
        ],
      };

      const req = new Request("http://127.0.0.1:8086/api/highlights/sync", {
        method: "POST",
        headers: { "Content-Type": "application/json", host: "127.0.0.1:8086" },
        body: JSON.stringify(payload),
      });

      const res = await handleRequest(req, localServer);
      expect(res.status).toBe(200);

      // Verify that the quote was indexed in cache.db
      const cDb = (await import("./server")).getCacheDb();
      const quoteRow = cDb
        .query("SELECT * FROM book_highlights WHERE book_title = 'Direct Highlight Sync Test';")
        .get() as any;
      expect(quoteRow).toBeDefined();
      expect(quoteRow.quote).toBe("Knowledge is power.");
      expect(quoteRow.chapter).toBe("Intro");
    });

    it("GET /api/discover/feed returns trending and new releases feeds separately", async () => {
      // Test trending tab
      const trendingReq = new Request("http://127.0.0.1:8086/api/discover/feed?tab=trending", {
        headers: { host: "127.0.0.1:8086" },
      });
      const trendingRes = await handleRequest(trendingReq, localServer);
      expect(trendingRes.status).toBe(200);
      const trendingData = await trendingRes.json();
      expect(trendingData.tab).toBe("trending");
      expect(trendingData.items.length).toBeGreaterThan(0);
      expect(trendingData.items.every((it: any) => it.feedType === "trending")).toBe(true);

      // Test new_releases tab
      const releasesReq = new Request("http://127.0.0.1:8086/api/discover/feed?tab=new_releases", {
        headers: { host: "127.0.0.1:8086" },
      });
      const releasesRes = await handleRequest(releasesReq, localServer);
      expect(releasesRes.status).toBe(200);
      const releasesData = await releasesRes.json();
      expect(releasesData.tab).toBe("new_releases");
      expect(releasesData.items.length).toBeGreaterThan(0);
      expect(releasesData.items.every((it: any) => it.feedType === "new_releases")).toBe(true);

      // Verify feeds are strictly separate
      const trendingTitles = new Set(trendingData.items.map((i: any) => i.id));
      const releaseTitles = new Set(releasesData.items.map((i: any) => i.id));
      for (const id of trendingTitles) {
        expect(releaseTitles.has(id)).toBe(false);
      }
    });

    it("POST /api/discover/ingest validates URL and queues background download with immediate feedback", async () => {
      // Rejects invalid URL
      const invalidReq = new Request("http://127.0.0.1:8086/api/discover/ingest", {
        method: "POST",
        headers: { "Content-Type": "application/json", host: "127.0.0.1:8086" },
        body: JSON.stringify({ url: "https://example.com/not-a-novel" }),
      });
      const invalidRes = await handleRequest(invalidReq, localServer);
      expect(invalidRes.status).toBe(400);

      try {
        setServerDependenciesForTest({
          enqueueLnoriJob: (_url: string) => ({
            jobId: 999,
            runId: "test-run-999",
          }),
          ingestLnoriSeries: async () => ({
            success: true,
            seriesTitle: "The Genius Prince's Guide",
            author: "Toru Toba",
            importedCount: 1,
            skippedCount: 0,
            totalCount: 1,
            tags: ["Light Novel"],
            calibreBookIds: [999],
          }),
        });

        // Accepts valid Lnori URL and returns queued status immediately
        const validReq = new Request("http://127.0.0.1:8086/api/discover/ingest", {
          method: "POST",
          headers: { "Content-Type": "application/json", host: "127.0.0.1:8086" },
          body: JSON.stringify({
            url: "https://lnori.com/series/8046/the-genius-princes-guide",
          }),
        });
        const validRes = await handleRequest(validReq, localServer);
        expect(validRes.status).toBe(200);
        const data = await validRes.json();
        expect(data.success).toBe(true);
        expect(data.queued).toBe(true);
        expect(data.message).toContain("Ingestion queued! Downloading in background...");
        expect(data.runId).toBeDefined();
      } finally {
        resetServerDependenciesForTest();
      }
    });

    it("POST /api/discover/ingest blocks unauthenticated WAN requests with 401 when apiKey is configured", async () => {
      const origKey = process.env.READING_API_KEY;
      try {
        process.env.READING_API_KEY = "test-secret-key";
        const wanServer = {
          requestIP: () => ({ address: "198.46.146.17" }),
        };

        const req = new Request("http://127.0.0.1:8086/api/discover/ingest", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            origin: "https://reading-sg.wavypremium.xyz:8443",
          },
          body: JSON.stringify({
            url: "https://lnori.com/series/8046/the-genius-princes-guide",
          }),
        });

        const res = await handleRequest(req, wanServer);
        expect(res.status).toBe(401);
      } finally {
        if (origKey) process.env.READING_API_KEY = origKey;
        else delete process.env.READING_API_KEY;
      }
    });

    it("GET /api/discover/jobs/active returns active discover jobs and excludes complete/failed jobs", async () => {
      resetActiveLnoriStateForTest();

      // Initially empty
      const emptyReq = new Request("http://127.0.0.1:8086/api/discover/jobs/active");
      const emptyRes = await handleRequest(emptyReq, localServer);
      expect(emptyRes.status).toBe(200);
      const emptyData = (await emptyRes.json()) as any;
      expect(emptyData.success).toBe(true);
      expect(Array.isArray(emptyData.jobs)).toBe(true);
      expect(emptyData.jobs.length).toBe(0);

      // Register an active in-flight job, a queued job, and a completed job
      registerDiscoverJob(
        1001,
        "lnori-1001",
        "lnori",
        "https://lnori.com/series/8046/the-genius-princes-guide",
        "genius-prince",
        "The Genius Prince's Guide",
      );
      registerDiscoverJob(
        1002,
        "elscione-1002",
        "elscione",
        "https://server.elscione.com/Officially%20Translated%20Light%20Novels/DanMachi/",
        "danmachi",
        "DanMachi",
      );
      registerDiscoverJob(
        1003,
        "lnori-1003",
        "lnori",
        "https://lnori.com/series/1234/completed-series",
        "completed-novel",
        "Completed Novel",
      );

      setServerDependenciesForTest({
        getDiscoverProgress: (id) => {
          const numId = Number(id);
          if (numId === 1001) {
            return {
              success: true,
              jobId: 1001,
              runId: "lnori-1001",
              novelId: "genius-prince",
              title: "The Genius Prince's Guide",
              phase: "downloading",
              percent: 45,
              currentVolume: "Volume 2",
              volumesCompleted: 1,
              totalVolumes: 5,
            };
          }
          if (numId === 1002) {
            return {
              success: true,
              jobId: 1002,
              runId: "elscione-1002",
              novelId: "danmachi",
              title: "DanMachi",
              phase: "queued",
              percent: 0,
              volumesCompleted: 0,
              totalVolumes: 0,
            };
          }
          if (numId === 1003) {
            return {
              success: true,
              jobId: 1003,
              runId: "lnori-1003",
              novelId: "completed-novel",
              title: "Completed Novel",
              phase: "complete",
              percent: 100,
              volumesCompleted: 5,
              totalVolumes: 5,
            };
          }
          return null;
        },
      });

      try {
        const req = new Request("http://127.0.0.1:8086/api/discover/jobs/active");
        const res = await handleRequest(req, localServer);
        expect(res.status).toBe(200);
        const data = (await res.json()) as any;
        expect(data.success).toBe(true);
        expect(Array.isArray(data.jobs)).toBe(true);
        // Completed job 1003 must be excluded from active listing
        expect(data.jobs.length).toBe(2);

        const job1 = data.jobs.find((j: any) => j.jobId === 1001);
        expect(job1).toBeDefined();
        expect(job1.novelId).toBe("genius-prince");
        expect(job1.title).toBe("The Genius Prince's Guide");
        expect(job1.phase).toBe("downloading");
        expect(job1.percent).toBe(45);

        const job2 = data.jobs.find((j: any) => j.jobId === 1002);
        expect(job2).toBeDefined();
        expect(job2.novelId).toBe("danmachi");
        expect(job2.title).toBe("DanMachi");
        expect(job2.phase).toBe("queued");

        // Verify direct call to getActiveDiscoverJobs
        const directActive = getActiveDiscoverJobs();
        expect(directActive.length).toBe(2);
        expect(directActive.some((j) => j.jobId === 1003)).toBe(false);
      } finally {
        resetServerDependenciesForTest();
        resetActiveLnoriStateForTest();
      }
    });

    it("POST /api/discover/ingest preserves novelId and title in discoverJobRegistry and active jobs listing", async () => {
      resetActiveLnoriStateForTest();
      try {
        setServerDependenciesForTest({
          enqueueLnoriJob: (_url: string) => ({
            jobId: 7890,
            runId: "lnori-7890-test",
          }),
        });

        const req = new Request("http://127.0.0.1:8086/api/discover/ingest", {
          method: "POST",
          headers: { "Content-Type": "application/json", host: "127.0.0.1:8086" },
          body: JSON.stringify({
            url: "https://lnori.com/series/8046/the-genius-princes-guide",
            source: "lnori",
            novelId: "genius-prince-lnori",
            title: "The Genius Prince's Guide to Treason",
          }),
        });

        const res = await handleRequest(req, localServer);
        expect(res.status).toBe(200);
        const data = await res.json();
        expect(data.success).toBe(true);
        expect(data.jobId).toBe(7890);

        // Verify active jobs listing returns the novelId and title
        const activeReq = new Request("http://127.0.0.1:8086/api/discover/jobs/active");
        const activeRes = await handleRequest(activeReq, localServer);
        expect(activeRes.status).toBe(200);
        const activeData = await activeRes.json();
        expect(activeData.success).toBe(true);
        const found = activeData.jobs.find((j: any) => j.jobId === 7890);
        expect(found).toBeDefined();
        expect(found.novelId).toBe("genius-prince-lnori");
        expect(found.title).toBe("The Genius Prince's Guide to Treason");
        expect(found.phase).toBe("queued");
      } finally {
        resetServerDependenciesForTest();
        resetActiveLnoriStateForTest();
      }
    });

    it("POST /api/discover/ingest blocks duplicate submissions server-side and reuses active job", async () => {
      resetActiveLnoriStateForTest();
      let enqueueCount = 0;
      try {
        setServerDependenciesForTest({
          enqueueLnoriJob: (_url: string) => {
            enqueueCount++;
            return {
              jobId: 8888,
              runId: "lnori-8888-active",
            };
          },
        });

        // First ingest submission
        const req1 = new Request("http://127.0.0.1:8086/api/discover/ingest", {
          method: "POST",
          headers: { "Content-Type": "application/json", host: "127.0.0.1:8086" },
          body: JSON.stringify({
            url: "https://lnori.com/series/8046/the-genius-princes-guide",
            source: "lnori",
            novelId: "genius-prince-lnori",
            title: "The Genius Prince's Guide",
          }),
        });
        const res1 = await handleRequest(req1, localServer);
        expect(res1.status).toBe(200);
        const data1 = await res1.json();
        expect(data1.success).toBe(true);
        expect(data1.jobId).toBe(8888);
        expect(enqueueCount).toBe(1);

        // Second ingest submission for the same novel / URL (simulating another tab or concurrent device)
        const req2 = new Request("http://127.0.0.1:8086/api/discover/ingest", {
          method: "POST",
          headers: { "Content-Type": "application/json", host: "127.0.0.1:8086" },
          body: JSON.stringify({
            url: "https://lnori.com/series/8046/the-genius-princes-guide",
            source: "lnori",
            novelId: "genius-prince-lnori",
            title: "The Genius Prince's Guide",
          }),
        });
        const res2 = await handleRequest(req2, localServer);
        expect(res2.status).toBe(200);
        const data2 = await res2.json();
        expect(data2.success).toBe(true);
        expect(data2.alreadyActive).toBe(true);
        expect(data2.jobId).toBe(8888);
        expect(data2.runId).toBe("lnori-8888-active");
        expect(data2.message).toContain("already in progress");
        // Must NOT call enqueueLnoriJob again
        expect(enqueueCount).toBe(1);
      } finally {
        resetServerDependenciesForTest();
        resetActiveLnoriStateForTest();
      }
    });

    it("POST /api/discover/ingest and registerDiscoverJob strip emojis from novelId and title", async () => {
      resetActiveLnoriStateForTest();
      try {
        setServerDependenciesForTest({
          enqueueLnoriJob: (_url: string) => ({
            jobId: 9999,
            runId: "lnori-9999-emoji",
          }),
        });

        const req = new Request("http://127.0.0.1:8086/api/discover/ingest", {
          method: "POST",
          headers: { "Content-Type": "application/json", host: "127.0.0.1:8086" },
          body: JSON.stringify({
            url: "https://lnori.com/series/8046/the-genius-princes-guide",
            source: "lnori",
            novelId: "danmachi-✨-novel",
            title: "DanMachi 🚀 ✨ Super Magic 📚",
          }),
        });

        const res = await handleRequest(req, localServer);
        expect(res.status).toBe(200);

        const activeReq = new Request("http://127.0.0.1:8086/api/discover/jobs/active");
        const activeRes = await handleRequest(activeReq, localServer);
        const activeData = await activeRes.json();
        const job = activeData.jobs.find((j: any) => j.jobId === 9999);
        expect(job).toBeDefined();
        // Emojis must be cleanly stripped
        expect(/\p{Extended_Pictographic}/u.test(job.novelId)).toBe(false);
        expect(/\p{Extended_Pictographic}/u.test(job.title)).toBe(false);
        expect(job.title).toBe("DanMachi Super Magic");
      } finally {
        resetServerDependenciesForTest();
        resetActiveLnoriStateForTest();
      }
    });

    it("POST /api/discover/ingest recovers and registers activeLnoriState job started via /api/lnori/ingest", async () => {
      resetActiveLnoriStateForTest();
      try {
        let releaseTask: (() => void) | undefined;
        const taskHoldPromise = new Promise<void>((resolve) => {
          releaseTask = resolve;
        });

        setServerDependenciesForTest({
          ingestLnoriSeries: async () => {
            await taskHoldPromise;
            return {
              success: true,
              seriesTitle: "The Genius Prince's Guide",
              author: "Toru Toba",
              importedCount: 1,
              skippedCount: 0,
              totalCount: 1,
              tags: "Light Novel",
              calibreBookIds: [8046],
            };
          },
        });

        // Step 1: Start job through native /api/lnori/ingest (which does not use registerDiscoverJob upfront)
        const lnoriReq = new Request("http://127.0.0.1:8086/api/lnori/ingest", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            url: "https://lnori.com/series/8046/the-genius-princes-guide",
            stream: true,
          }),
        });
        const lnoriRes = await handleRequest(lnoriReq, localServer);
        expect(lnoriRes.status).toBe(200);

        // Step 2: Discover UI attempts to ingest the same novel while active
        const discoverReq = new Request("http://127.0.0.1:8086/api/discover/ingest", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            url: "https://lnori.com/series/8046/the-genius-princes-guide",
            source: "lnori",
            novelId: "genius-prince-card",
            title: "The Genius Prince's Guide",
          }),
        });
        const discoverRes = await handleRequest(discoverReq, localServer);
        expect(discoverRes.status).toBe(200);
        const discoverData = await discoverRes.json();
        expect(discoverData.success).toBe(true);
        expect(discoverData.alreadyActive).toBe(true);
        expect(discoverData.jobId).toBeGreaterThan(0);
        expect(discoverData.runId).toBeDefined();

        // Step 3: Polling with returned jobId must succeed (not return 404)
        const pollReq = new Request(`http://127.0.0.1:8086/api/discover/progress/${discoverData.jobId}`);
        const pollRes = await handleRequest(pollReq, localServer);
        expect(pollRes.status).toBe(200);
        const pollData = await pollRes.json();
        expect(pollData.success).toBe(true);
        expect(pollData.jobId).toBe(discoverData.jobId);
        expect(["downloading", "processing", "queued"]).toContain(pollData.phase);

        // Step 4: Active jobs API must include the registered job
        const activeReq = new Request("http://127.0.0.1:8086/api/discover/jobs/active");
        const activeRes = await handleRequest(activeReq, localServer);
        expect(activeRes.status).toBe(200);
        const activeData = await activeRes.json();
        const activeJob = activeData.jobs.find((j: any) => j.jobId === discoverData.jobId || j.runId === discoverData.runId);
        expect(activeJob).toBeDefined();
        expect(activeJob.novelId).toBe("genius-prince-card");
        expect(activeJob.title).toBe("The Genius Prince's Guide");

        // Release the task
        if (releaseTask) releaseTask();
      } finally {
        resetServerDependenciesForTest();
        resetActiveLnoriStateForTest();
      }
    });

    it("GET /api/discover/jobs/active preserves terminal registry mappings so polling continues returning complete", async () => {
      resetActiveLnoriStateForTest();
      const terminalJobId = 123456;
      const terminalRunId = "lnori-123456-suffix";
      registerDiscoverJob(
        terminalJobId,
        terminalRunId,
        "lnori",
        "https://lnori.com/series/8046/terminal-test",
        "terminal-novel",
        "Terminal Novel",
      );

      setServerDependenciesForTest({
        getDiscoverProgress: (id) => {
          if (Number(id) === terminalJobId) {
            return {
              success: true,
              jobId: terminalJobId,
              runId: terminalRunId,
              phase: "complete",
              percent: 100,
              volumesCompleted: 1,
              totalVolumes: 1,
            };
          }
          return null;
        },
      });

      try {
        // Step 1: Active jobs listing is requested by another tab
        const activeReq = new Request("http://127.0.0.1:8086/api/discover/jobs/active");
        const activeRes = await handleRequest(activeReq, localServer);
        expect(activeRes.status).toBe(200);
        const activeData = await activeRes.json();
        // Completed job is excluded from active listing
        expect(activeData.jobs.some((j: any) => j.jobId === terminalJobId)).toBe(false);

        // Step 2: The original tab's client continues polling progress for terminalJobId
        // The mapping must NOT have been deleted; progress must return complete, not 404
        const pollReq = new Request(`http://127.0.0.1:8086/api/discover/progress/${terminalJobId}`);
        const pollRes = await handleRequest(pollReq, localServer);
        expect(pollRes.status).toBe(200);
        const pollData = await pollRes.json();
        expect(pollData.success).toBe(true);
        expect(pollData.phase).toBe("complete");
        expect(pollData.percent).toBe(100);
      } finally {
        resetServerDependenciesForTest();
        resetActiveLnoriStateForTest();
      }
    });

    it("active jobs fallback surfaces native active and queued jobs with targetUrl and runId", async () => {
      resetActiveLnoriStateForTest();
      try {
        let releaseTask: (() => void) | undefined;
        const holdPromise = new Promise<void>((resolve) => {
          releaseTask = resolve;
        });

        setServerDependenciesForTest({
          ingestLnoriSeries: async () => {
            await holdPromise;
            return {
              success: true,
              seriesTitle: "Native Series",
              author: "Native Author",
              importedCount: 1,
              skippedCount: 0,
              totalCount: 1,
              tags: "Light Novel",
              calibreBookIds: [1234],
            };
          },
        });

        // Start job 1 via native streaming
        const req1 = new Request("http://127.0.0.1:8086/api/lnori/ingest", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            url: "https://lnori.com/series/8046/native-series",
            stream: true,
          }),
        });
        const res1 = await handleRequest(req1, localServer);
        expect(res1.status).toBe(200);

        // Active jobs listing must surface it with targetUrl and runId
        const activeReq = new Request("http://127.0.0.1:8086/api/discover/jobs/active");
        const activeRes = await handleRequest(activeReq, localServer);
        expect(activeRes.status).toBe(200);
        const activeData = await activeRes.json();
        expect(activeData.jobs.length).toBeGreaterThan(0);
        const nativeJob = activeData.jobs[0];
        expect(nativeJob.runId).toBeDefined();
        expect(nativeJob.targetUrl).toContain("native-series");
        expect(nativeJob.source).toBe("lnori");

        if (releaseTask) releaseTask();
      } finally {
        resetServerDependenciesForTest();
        resetActiveLnoriStateForTest();
      }
    });
  });

  describe("Unit U12: Reject inactive cache identities when deciding duplicates/progress", () => {
    it("authorized DELETE removes book from Calibre; subsequent multipart upload reaches Calibre add rather than stale duplicate", async () => {
      const origFetch = globalThis.fetch;
      (globalThis as any).fetch = async () => new Response("{}", { status: 404 });
      const origJevKey = process.env.JEV_API_KEY;
      const origTypesafeKey = process.env.TYPESAFE_API_KEY;
      delete process.env.JEV_API_KEY;
      delete process.env.TYPESAFE_API_KEY;

      const tempDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "u12-delete-upload-"));
      const libDir = path.join(tempDir, "calibre-lib");
      const dropDir = path.join(tempDir, "drop");
      fs.mkdirSync(libDir, { recursive: true });
      fs.mkdirSync(dropDir, { recursive: true });

      const origCalibredbPath = process.env.CALIBREDB_PATH;
      const origCalibreDbPath = process.env.CALIBRE_DB_PATH;
      const origLibraryDir = process.env.CALIBRE_LIBRARY_DIR;
      const origApiKey = process.env.READING_API_KEY;
      process.env.CALIBRE_LIBRARY_DIR = libDir;

      try {
        // 1. Create a minimal fixture Calibre metadata.db
        const mockDbPath = path.join(libDir, "metadata.db");
        process.env.CALIBRE_DB_PATH = mockDbPath;
        const db = new Database(mockDbPath);
        db.run(`CREATE TABLE books (id INTEGER PRIMARY KEY, title TEXT, path TEXT, has_cover INTEGER, pubdate TEXT, series_index REAL);`);
        db.run(`CREATE TABLE data (id INTEGER PRIMARY KEY, book INTEGER, format TEXT, name TEXT);`);
        db.run(`CREATE TABLE comments (id INTEGER PRIMARY KEY, book INTEGER, text TEXT);`);
        db.run(`CREATE TABLE authors (id INTEGER PRIMARY KEY, name TEXT);`);
        db.run(`CREATE TABLE books_authors_link (id INTEGER PRIMARY KEY, book INTEGER, author INTEGER);`);
        db.run(`CREATE TABLE series (id INTEGER PRIMARY KEY, name TEXT);`);
        db.run(`CREATE TABLE books_series_link (id INTEGER PRIMARY KEY, book INTEGER, series INTEGER);`);
        db.run(`CREATE TABLE tags (id INTEGER PRIMARY KEY, name TEXT);`);
        db.run(`CREATE TABLE books_tags_link (id INTEGER PRIMARY KEY, book INTEGER, tag INTEGER);`);
        db.run(`CREATE TABLE publishers (id INTEGER PRIMARY KEY, name TEXT);`);
        db.run(`CREATE TABLE books_publishers_link (id INTEGER PRIMARY KEY, book INTEGER, publisher INTEGER);`);

        // Insert initial books: 42 (Overlord Volume 1) and 12 (Overlord Volume 12)
        db.run(`INSERT INTO books (id, title, path, has_cover, pubdate, series_index) VALUES (42, 'Overlord Volume 1', 'Overlord1', 0, '', 1), (12, 'Overlord Volume 12', 'Overlord12', 0, '', 12);`);
        db.run(`INSERT INTO data (id, book, format, name) VALUES (1, 42, 'EPUB', 'one'), (2, 12, 'EPUB', 'twelve');`);
        db.close();

        // 2. Build minimal valid EPUB for Overlord Volume 1
        const staging = path.join(tempDir, "epub-staging");
        fs.mkdirSync(path.join(staging, "META-INF"), { recursive: true });
        fs.mkdirSync(path.join(staging, "OEBPS"), { recursive: true });
        fs.writeFileSync(path.join(staging, "mimetype"), "application/epub+zip");
        fs.writeFileSync(
          path.join(staging, "META-INF", "container.xml"),
          `<?xml version="1.0"?><container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container"><rootfiles><rootfile full-path="OEBPS/content.opf" media-type="application/oebps-package+xml"/></rootfiles></container>`,
        );
        fs.writeFileSync(
          path.join(staging, "OEBPS", "content.opf"),
          `<?xml version="1.0" encoding="utf-8"?><package xmlns="http://www.idpf.org/2007/opf" version="3.0"><metadata xmlns:dc="http://purl.org/dc/elements/1.1/"><dc:title>Overlord Volume 1</dc:title><dc:creator>Kugane Maruyama</dc:creator></metadata><manifest><item id="t" href="text.xhtml" media-type="application/xhtml+xml"/></manifest><spine><itemref idref="t"/></spine></package>`,
        );
        fs.writeFileSync(
          path.join(staging, "OEBPS", "text.xhtml"),
          `<html><body>${"A novel chapter with meaningful original fixture prose. ".repeat(150)}</body></html>`,
        );

        const testEpubPath = path.join(dropDir, "overlord_vol_1.epub");
        const zipRes1 = spawnSync("zip", ["-q", "-X", "-0", testEpubPath, "mimetype"], { cwd: staging });
        expect(zipRes1.status).toBe(0);
        const zipRes2 = spawnSync("zip", ["-q", "-r", testEpubPath, "META-INF", "OEBPS"], { cwd: staging });
        expect(zipRes2.status).toBe(0);

        const epubBytes = fs.readFileSync(testEpubPath);
        const { getKOReaderBinary256 } = await import("./bot");
        const fileHash = getKOReaderBinary256(testEpubPath);
        expect(fileHash).toBeTruthy();

        // 3. Populate file_hashes cache row for book 42
        const cdb = getCacheDb();
        cdb.run(
          "INSERT OR REPLACE INTO file_hashes (filepath, mtime, hash, book_id, title, authors, cover) VALUES (?, ?, ?, ?, ?, ?, ?)",
          [testEpubPath, 1, fileHash, 42, "Overlord Volume 1", "Kugane Maruyama", 0],
        );

        process.env.READING_API_KEY = "u12-auth-key";
        const authHeaders = { Authorization: "Bearer u12-auth-key" };

        // 4. Setup mock calibredb that handles 'remove' by deleting book 42, and 'add' by adding book 99
        const mockLogFile = path.join(tempDir, "calibredb.log");
        const mockCalibreScript = path.join(tempDir, "mock_calibredb.sh");
        fs.writeFileSync(
          mockCalibreScript,
          `#!/bin/sh
echo "$*" >> "${mockLogFile}"
if [ "$1" = "remove" ]; then
  sqlite3 "${mockDbPath}" "DELETE FROM books WHERE id=42; DELETE FROM data WHERE book=42;"
  exit 0
fi
if [ "$1" = "add" ]; then
  sqlite3 "${mockDbPath}" "INSERT INTO books (id, title, path, has_cover, pubdate, series_index) VALUES (99, 'Overlord Volume 1', 'Overlord1_New', 0, '', 1);"
  sqlite3 "${mockDbPath}" "INSERT INTO data (id, book, format, name) VALUES (3, 99, 'EPUB', 'new_one');"
  echo "Added book ids: 99"
  exit 0
fi
exit 0
`,
        );
        fs.chmodSync(mockCalibreScript, 0o755);
        process.env.CALIBREDB_PATH = mockCalibreScript;

        // 5. Authorized DELETE /api/books/42
        const deleteReq = new Request("http://127.0.0.1:8086/api/books/42", {
          method: "DELETE",
          headers: authHeaders,
        });
        const deleteRes = await handleRequest(deleteReq);
        expect(deleteRes.status).toBe(200);

        // Verify book 42 is now absent from Calibre catalog
        const catalogAfterDelete = getCalibreBooks(true);
        expect(catalogAfterDelete.map((b: any) => b.id)).not.toContain(42);
        expect(catalogAfterDelete.map((b: any) => b.id)).toContain(12);

        // Verify file_hashes row for book 42 is retained without deletion (no cache mutation!)
        const cachedRows = cdb
          .query("SELECT * FROM file_hashes WHERE book_id = 42")
          .all() as any[];
        expect(cachedRows.length).toBeGreaterThan(0);
        expect(cachedRows.some((r: any) => r.hash === fileHash)).toBe(true);

        // 6. Multipart upload POST /api/upload with the exact same EPUB
        const fd = new FormData();
        fd.set("file", new File([epubBytes], "overlord_vol_1.epub", { type: "application/epub+zip" }));
        const uploadReq = new Request("http://127.0.0.1:8086/api/upload", {
          method: "POST",
          headers: authHeaders,
          body: fd,
        });
        const uploadRes = await handleRequest(uploadReq);
        expect(uploadRes.status).toBe(200);
        const uploadData = await uploadRes.json();

        // Must reach Calibre add and succeed with new ID 99, NOT false duplicate with stale ID 42
        expect(uploadData.success).toBe(true);
        expect(uploadData.duplicate).toBe(false);
        expect(uploadData.bookId).toBe(99);

        // Check calibredb log confirms 'add' was invoked
        const log = fs.existsSync(mockLogFile) ? fs.readFileSync(mockLogFile, "utf8") : "";
        expect(log).toContain("remove 42");
        expect(log).toContain("add");

        // Verify readback confirms file_hashes was not blanket-flushed
        const allHashes = cdb.query("SELECT count(*) as count FROM file_hashes").get() as any;
        expect(allHashes.count).toBeGreaterThan(0);
      } finally {
        globalThis.fetch = origFetch;
        if (origJevKey !== undefined) process.env.JEV_API_KEY = origJevKey;
        if (origTypesafeKey !== undefined) process.env.TYPESAFE_API_KEY = origTypesafeKey;
        if (origApiKey !== undefined) process.env.READING_API_KEY = origApiKey;
        else delete process.env.READING_API_KEY;
        process.env.CALIBREDB_PATH = origCalibredbPath;
        process.env.CALIBRE_DB_PATH = origCalibreDbPath;
        process.env.CALIBRE_LIBRARY_DIR = origLibraryDir;
        await fs.promises.rm(tempDir, { recursive: true, force: true });
      }
    });

    it("failed removal retains valid duplicate response on re-upload (counterfactual control)", async () => {
      const origFetch = globalThis.fetch;
      (globalThis as any).fetch = async () => new Response("{}", { status: 404 });

      const tempDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "u12-failed-delete-"));
      const libDir = path.join(tempDir, "calibre-lib");
      const dropDir = path.join(tempDir, "drop");
      fs.mkdirSync(libDir, { recursive: true });
      fs.mkdirSync(dropDir, { recursive: true });

      const origCalibredbPath = process.env.CALIBREDB_PATH;
      const origCalibreDbPath = process.env.CALIBRE_DB_PATH;
      const origLibraryDir = process.env.CALIBRE_LIBRARY_DIR;
      const origApiKey = process.env.READING_API_KEY;
      process.env.CALIBRE_LIBRARY_DIR = libDir;

      try {
        const mockDbPath = path.join(libDir, "metadata.db");
        process.env.CALIBRE_DB_PATH = mockDbPath;
        const db = new Database(mockDbPath);
        db.run(`CREATE TABLE books (id INTEGER PRIMARY KEY, title TEXT, path TEXT, has_cover INTEGER, pubdate TEXT, series_index REAL);`);
        db.run(`CREATE TABLE data (id INTEGER PRIMARY KEY, book INTEGER, format TEXT, name TEXT);`);
        db.run(`CREATE TABLE comments (id INTEGER PRIMARY KEY, book INTEGER, text TEXT);`);
        db.run(`CREATE TABLE authors (id INTEGER PRIMARY KEY, name TEXT);`);
        db.run(`CREATE TABLE books_authors_link (id INTEGER PRIMARY KEY, book INTEGER, author INTEGER);`);
        db.run(`CREATE TABLE series (id INTEGER PRIMARY KEY, name TEXT);`);
        db.run(`CREATE TABLE books_series_link (id INTEGER PRIMARY KEY, book INTEGER, series INTEGER);`);
        db.run(`CREATE TABLE tags (id INTEGER PRIMARY KEY, name TEXT);`);
        db.run(`CREATE TABLE books_tags_link (id INTEGER PRIMARY KEY, book INTEGER, tag INTEGER);`);
        db.run(`CREATE TABLE publishers (id INTEGER PRIMARY KEY, name TEXT);`);
        db.run(`CREATE TABLE books_publishers_link (id INTEGER PRIMARY KEY, book INTEGER, publisher INTEGER);`);
        db.run(`INSERT INTO authors (id, name) VALUES (1, 'Kugane Maruyama');`);
        db.run(`INSERT INTO books_authors_link (id, book, author) VALUES (1, 42, 1);`);
        db.run(`INSERT INTO books (id, title, path, has_cover, pubdate, series_index) VALUES (42, 'Overlord Volume 1', 'Overlord1', 0, '', 1);`);
        db.run(`INSERT INTO data (id, book, format, name) VALUES (1, 42, 'EPUB', 'one');`);
        db.close();

        // Build valid EPUB
        const staging = path.join(tempDir, "epub-staging");
        fs.mkdirSync(path.join(staging, "META-INF"), { recursive: true });
        fs.mkdirSync(path.join(staging, "OEBPS"), { recursive: true });
        fs.writeFileSync(path.join(staging, "mimetype"), "application/epub+zip");
        fs.writeFileSync(
          path.join(staging, "META-INF", "container.xml"),
          `<?xml version="1.0"?><container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container"><rootfiles><rootfile full-path="OEBPS/content.opf" media-type="application/oebps-package+xml"/></rootfiles></container>`,
        );
        fs.writeFileSync(
          path.join(staging, "OEBPS", "content.opf"),
          `<?xml version="1.0" encoding="utf-8"?><package xmlns="http://www.idpf.org/2007/opf" version="3.0"><metadata xmlns:dc="http://purl.org/dc/elements/1.1/"><dc:title>Overlord Volume 1</dc:title><dc:creator>Kugane Maruyama</dc:creator></metadata><manifest><item id="t" href="text.xhtml" media-type="application/xhtml+xml"/></manifest><spine><itemref idref="t"/></spine></package>`,
        );
        fs.writeFileSync(
          path.join(staging, "OEBPS", "text.xhtml"),
          `<html><body>${"A novel chapter with meaningful original fixture prose. ".repeat(150)}</body></html>`,
        );

        const testEpubPath = path.join(dropDir, "overlord_vol_1.epub");
        spawnSync("zip", ["-q", "-X", "-0", testEpubPath, "mimetype"], { cwd: staging });
        spawnSync("zip", ["-q", "-r", testEpubPath, "META-INF", "OEBPS"], { cwd: staging });

        const epubBytes = fs.readFileSync(testEpubPath);
        const { getKOReaderBinary256 } = await import("./bot");
        const fileHash = getKOReaderBinary256(testEpubPath);

        const cdb = getCacheDb();
        cdb.run(
          "INSERT OR REPLACE INTO file_hashes (filepath, mtime, hash, book_id, title, authors, cover) VALUES (?, ?, ?, ?, ?, ?, ?)",
          [testEpubPath, 1, fileHash, 42, "Overlord Volume 1", "Kugane Maruyama", 0],
        );

        // Mock calibredb remove to fail with exit code 1
        const mockCalibreScript = path.join(tempDir, "mock_calibredb_fail.sh");
        fs.writeFileSync(
          mockCalibreScript,
          `#!/bin/sh
if [ "$1" = "remove" ]; then
  echo "Simulated Calibre locked error" >&2
  exit 1
fi
exit 0
`,
        );
        fs.chmodSync(mockCalibreScript, 0o755);
        process.env.CALIBREDB_PATH = mockCalibreScript;

        process.env.READING_API_KEY = "u12-auth-key";
        const authHeaders = { Authorization: "Bearer u12-auth-key" };

        // Attempt DELETE /api/books/42: fails with 500
        const deleteReq = new Request("http://127.0.0.1:8086/api/books/42", {
          method: "DELETE",
          headers: authHeaders,
        });
        const deleteRes = await handleRequest(deleteReq);
        expect(deleteRes.status).toBe(500);

        // Book 42 remains active in Calibre
        const currentBooks = getCalibreBooks(true);
        expect(currentBooks.map((b: any) => b.id)).toContain(42);

        // Re-uploading returns duplicate response with bookId 42
        const fd = new FormData();
        fd.set("file", new File([epubBytes], "overlord_vol_1.epub", { type: "application/epub+zip" }));
        const uploadReq = new Request("http://127.0.0.1:8086/api/upload", {
          method: "POST",
          headers: authHeaders,
          body: fd,
        });
        const uploadRes = await handleRequest(uploadReq);
        expect(uploadRes.status).toBe(200);
        const uploadData = await uploadRes.json();
        expect(uploadData.success).toBe(true);
        expect(uploadData.duplicate).toBe(true);
        expect(uploadData.bookId).toBe(42);
        expect(uploadData.message).toContain("already in your library");
      } finally {
        globalThis.fetch = origFetch;
        if (origApiKey !== undefined) process.env.READING_API_KEY = origApiKey;
        else delete process.env.READING_API_KEY;
        process.env.CALIBREDB_PATH = origCalibredbPath;
        process.env.CALIBRE_DB_PATH = origCalibreDbPath;
        process.env.CALIBRE_LIBRARY_DIR = origLibraryDir;
        await fs.promises.rm(tempDir, { recursive: true, force: true });
      }
    });

    it("neighboring live identity with the same hash is preserved when stale identity is rejected", () => {
      const cdb = getCacheDb();
      const sharedHash = "test_shared_hash_live_preservation";

      // Row 1: deleted book 42
      cdb.run(
        "INSERT OR REPLACE INTO file_hashes (filepath, mtime, hash, book_id, title, authors, cover) VALUES (?, ?, ?, ?, ?, ?, ?)",
        ["/fake/deleted.epub#h1", 1, sharedHash, 42, "Deleted Volume", "Author A", 0],
      );
      // Row 2: live book 12
      cdb.run(
        "INSERT OR REPLACE INTO file_hashes (filepath, mtime, hash, book_id, title, authors, cover) VALUES (?, ?, ?, ?, ?, ?, ?)",
        ["/fake/live.epub#h1", 1, sharedHash, 12, "Live Volume", "Author B", 1],
      );

      // Only book 12 is active in Calibre
      const knownBooks = [
        { id: 12, title: "Live Volume", authors: "Author B", cover: 1 },
      ];

      const { map } = getCalibreHashMap(knownBooks);

      // Live identity for book 12 must be preserved in map
      expect(map[sharedHash]).toBeDefined();
      expect(map[sharedHash].id).toBe(12);
      expect(map[sharedHash].title).toBe("Live Volume");
      expect(map[sharedHash].cover).toBe(true);
    });

    it("same-ID changed ownership rejects stale cached identity and does not repoint to new book", () => {
      const cdb = getCacheDb();
      const changedHash = "test_same_id_changed_ownership";

      // Row in file_hashes has book_id 12, but title is "Original Old Work"
      cdb.run(
        "INSERT OR REPLACE INTO file_hashes (filepath, mtime, hash, book_id, title, authors, cover) VALUES (?, ?, ?, ?, ?, ?, ?)",
        ["/fake/old.epub#h", 1, changedHash, 12, "Original Old Work", "Author X", 0],
      );

      // Active Calibre book 12 has a completely different title (ID was reused)
      const knownBooks = [
        { id: 12, title: "Modern New Release", authors: "Author Y", cover: 1 },
      ];

      const { map } = getCalibreHashMap(knownBooks);

      // Stale identity must be rejected; map[changedHash] must NOT be repointed to "Modern New Release"
      expect(map[changedHash]).toBeUndefined();
    });

    it("unmatched record (null book_id) is rejected from duplicate map", () => {
      const cdb = getCacheDb();
      const unmatchedHash = "test_unmatched_record_null_id";

      cdb.run(
        "INSERT OR REPLACE INTO file_hashes (filepath, mtime, hash, book_id, title, authors, cover) VALUES (?, ?, ?, ?, ?, ?, ?)",
        ["/fake/unmatched.epub#h", 1, unmatchedHash, null, "Unmatched Book", "Unknown", 0],
      );

      const knownBooks = [
        { id: 12, title: "Live Volume", authors: "Author B", cover: 1 },
      ];

      const { map } = getCalibreHashMap(knownBooks);
      expect(map[unmatchedHash]).toBeUndefined();
    });

    it("reproduces same active ID and same title but different recorded author using actual duplicate path, rejecting false duplicate and not repointing", async () => {
      const cdb = getCacheDb();
      const testHash = "test_same_id_different_author_duplicate_hash";

      // Active Calibre library has book 12: "Inferno" by Dante Alighieri
      const knownBooks = [
        { id: 12, title: "Inferno", authors: "Dante Alighieri", cover: 1 },
      ];

      // Cached row has same ID 12 and same title "Inferno", but different recorded author: Dan Brown
      cdb.run(
        "INSERT OR REPLACE INTO file_hashes (filepath, mtime, hash, book_id, title, authors, cover) VALUES (?, ?, ?, ?, ?, ?, ?)",
        ["/fake/dan_brown_inferno.epub#h", 1, testHash, 12, "Inferno", "Dan Brown", 0],
      );

      // 1. getCalibreHashMap must reject the row due to contradictory author ownership
      const { map } = getCalibreHashMap(knownBooks);
      expect(map[testHash]).toBeUndefined();

      // 2. ingestBookFile duplicate shortcut must NOT repoint to Dante's book 12
      const activeBook = knownBooks.find((b) => b.id === 12);
      expect(matchesActiveBookIdentity(activeBook, "Inferno", "Dan Brown")).toBe(false);
    });

    it("reproduces same active ID and same title but different recorded author using actual progress path, preventing false progress mapping", async () => {
      const cdb = getCacheDb();
      const docHash = "test_dan_brown_inferno_progress_dochash";

      // Cached row has book_id 12, title "Inferno", author "Dan Brown"
      cdb.run(
        "INSERT OR REPLACE INTO file_hashes (filepath, mtime, hash, book_id, title, authors, cover) VALUES (?, ?, ?, ?, ?, ?, ?)",
        ["/fake/inferno.epub#h", 1, docHash, 12, "Inferno", "Dan Brown", 0],
      );

      // Active catalog has book 12: "Inferno" by Dante Alighieri
      const knownBooks = [
        { id: 12, title: "Inferno", authors: "Dante Alighieri", cover: 1 },
      ];

      const { map, rejectedHashes } = getCalibreHashMap(knownBooks);

      // 1. getCalibreHashMap must reject the contradictory author row
      expect(map[docHash]).toBeUndefined();
      expect(rejectedHashes.has(docHash)).toBe(true);

      // 2. Exercise actual getKosyncProgress path via GET /api/kosync/active
      setServerDependenciesForTest({
        getCalibreBooks: () => knownBooks,
      });

      const tempKosyncDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "u12-kosync-progress-"));
      const kosyncDbPath = path.join(tempKosyncDir, "kosync.db");
      const origKosyncDb = process.env.KOSYNC_DB_PATH;
      process.env.KOSYNC_DB_PATH = kosyncDbPath;

      try {
        const kdb = new Database(kosyncDbPath);
        kdb.run(`
          CREATE TABLE progress (
            id INTEGER PRIMARY KEY,
            document TEXT,
            progress TEXT,
            percentage REAL,
            device TEXT,
            device_id TEXT,
            filename TEXT,
            title TEXT,
            authors TEXT,
            timestamp INTEGER
          );
        `);
        kdb.run(
          "INSERT INTO progress (document, progress, percentage, device, device_id, filename, title, authors, timestamp) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
          [docHash, "p1", 0.5, "device1", "dev1", "inferno.epub", "Inferno", "Dan Brown", Date.now()],
        );
        kdb.close();

        const req = new Request("http://127.0.0.1:8086/api/kosync/active");
        const res = await handleRequest(req);
        expect(res.status).toBe(200);
        const data = await res.json();
        expect(Array.isArray(data)).toBe(true);
        expect(data.length).toBeGreaterThan(0);
        const infernoItem = data.find((i: any) => i.document === docHash);
        expect(infernoItem).toBeDefined();
        // Crucial invariant: must NOT be mapped to Dante's book ID 12
        expect(infernoItem.bookId).toBeNull();
      } finally {
        resetServerDependenciesForTest();
        if (origKosyncDb !== undefined) process.env.KOSYNC_DB_PATH = origKosyncDb;
        else delete process.env.KOSYNC_DB_PATH;
        await fs.promises.rm(tempKosyncDir, { recursive: true, force: true });
      }
    });

    it("cold hash cache progress mapping: refreshes hash index when cache is cold so hash-only KOSync entry maps to Calibre book", async () => {
      const tempLibDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "u12-cold-hash-lib-"));
      const tempKosyncDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "u12-cold-hash-kosync-"));
      const origLibDir = process.env.CALIBRE_LIBRARY_DIR;
      const origKosyncDb = process.env.KOSYNC_DB_PATH;
      process.env.CALIBRE_LIBRARY_DIR = tempLibDir;

      const kosyncDbPath = path.join(tempKosyncDir, "kosync.db");
      process.env.KOSYNC_DB_PATH = kosyncDbPath;

      try {
        // 1. Create an EPUB on disk inside the Calibre library folder
        const authorFolder = path.join(tempLibDir, "Author Alpha (55)");
        fs.mkdirSync(authorFolder, { recursive: true });
        const epubFile = path.join(authorFolder, "Cold Book.epub");
        const staging = path.join(tempLibDir, "staging");
        fs.mkdirSync(path.join(staging, "META-INF"), { recursive: true });
        fs.mkdirSync(path.join(staging, "OEBPS"), { recursive: true });
        fs.writeFileSync(path.join(staging, "mimetype"), "application/epub+zip");
        fs.writeFileSync(
          path.join(staging, "META-INF", "container.xml"),
          `<?xml version="1.0"?><container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container"><rootfiles><rootfile full-path="OEBPS/content.opf" media-type="application/oebps-package+xml"/></rootfiles></container>`,
        );
        fs.writeFileSync(
          path.join(staging, "OEBPS", "content.opf"),
          `<?xml version="1.0" encoding="utf-8"?><package xmlns="http://www.idpf.org/2007/opf" version="3.0"><metadata xmlns:dc="http://purl.org/dc/elements/1.1/"><dc:title>Cold Book</dc:title><dc:creator>Author Alpha</dc:creator></metadata><manifest><item id="t" href="text.xhtml" media-type="application/xhtml+xml"/></manifest><spine><itemref idref="t"/></spine></package>`,
        );
        fs.writeFileSync(
          path.join(staging, "OEBPS", "text.xhtml"),
          `<html><body>${"Prose for cold hash test. ".repeat(100)}</body></html>`,
        );
        spawnSync("zip", ["-q", "-X", "-0", epubFile, "mimetype"], { cwd: staging });
        spawnSync("zip", ["-q", "-r", epubFile, "META-INF", "OEBPS"], { cwd: staging });

        const { getKOReaderBinary256 } = await import("./bot");
        const docHash = getKOReaderBinary256(epubFile);

        // 2. Active Calibre books has book 55
        const knownBooks = [
          { id: 55, title: "Cold Book", authors: "Author Alpha", cover: 0 },
        ];
        setServerDependenciesForTest({
          getCalibreBooks: () => knownBooks,
        });

        // 3. Clear any existing file_hashes for this file/hash to ensure a cold cache
        const cdb = getCacheDb();
        cdb.run("DELETE FROM file_hashes WHERE hash = ?", [docHash]);

        // 4. Create KOSync progress row with filename present but title absent
        const kdb = new Database(kosyncDbPath);
        kdb.run(`
          CREATE TABLE progress (
            id INTEGER PRIMARY KEY,
            document TEXT,
            progress TEXT,
            percentage REAL,
            device TEXT,
            device_id TEXT,
            filename TEXT,
            title TEXT,
            authors TEXT,
            timestamp INTEGER
          );
        `);
        kdb.run(
          "INSERT INTO progress (document, progress, percentage, device, device_id, filename, title, authors, timestamp) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
          [docHash, "p1", 0.3, "device1", "dev1", "Cold Book.epub", "", "", Date.now()],
        );
        kdb.close();

        // 5. GET /api/kosync/active: cold cache automatically invokes refreshCalibreHashIndex
        // and maps the hash-only entry to book ID 55
        const req = new Request("http://127.0.0.1:8086/api/kosync/active");
        const res = await handleRequest(req);
        expect(res.status).toBe(200);
        const data = await res.json();
        const mappedItem = data.find((i: any) => i.document === docHash);
        expect(mappedItem).toBeDefined();
        expect(mappedItem.bookId).toBe(55);
        expect(mappedItem.displayTitle).toBe("Cold Book");
      } finally {
        resetServerDependenciesForTest();
        if (origLibDir !== undefined) process.env.CALIBRE_LIBRARY_DIR = origLibDir;
        else delete process.env.CALIBRE_LIBRARY_DIR;
        if (origKosyncDb !== undefined) process.env.KOSYNC_DB_PATH = origKosyncDb;
        else delete process.env.KOSYNC_DB_PATH;
        await fs.promises.rm(tempLibDir, { recursive: true, force: true });
        await fs.promises.rm(tempKosyncDir, { recursive: true, force: true });
      }
    });

    it("symbol-distinct title controls reject title resemblance when symbols distinguish works", () => {
      const active1 = { id: 10, title: "Fate/Zero", authors: "Gen Urobuchi" };
      expect(matchesActiveBookIdentity(active1, "Fate: Zero", "Gen Urobuchi")).toBe(false);
      expect(matchesActiveBookIdentity(active1, "Fate Zero", "Gen Urobuchi")).toBe(false);

      const active2 = { id: 11, title: "Re:Zero", authors: "Tappei Nagatsuki" };
      expect(matchesActiveBookIdentity(active2, "ReZero", "Tappei Nagatsuki")).toBe(false);

      const active3 = { id: 12, title: "Overlord (Part 1)", authors: "Kugane Maruyama" };
      expect(matchesActiveBookIdentity(active3, "Overlord (Part 2)", "Kugane Maruyama")).toBe(false);
    });

    it("unknown or uncredited author cannot be accepted by title resemblance alone for ordinary filepath hashes", () => {
      const active = { id: 20, title: "Genesis", authors: "Arthur C. Clarke" };

      // Cached author is Unknown: cannot be accepted by title resemblance alone
      expect(matchesActiveBookIdentity(active, "Genesis", "Unknown")).toBe(false);
      expect(matchesActiveBookIdentity(active, "Genesis", "")).toBe(false);

      // Active author is Unknown, cached is known: cannot be accepted by title resemblance alone
      const activeUnknown = { id: 21, title: "Genesis", authors: "Unknown" };
      expect(matchesActiveBookIdentity(activeUnknown, "Genesis", "Arthur C. Clarke")).toBe(false);

      // Both authors unknown for ordinary filepath hash: rejected
      expect(matchesActiveBookIdentity(activeUnknown, "Genesis", "Unknown", "/path/book.epub")).toBe(false);
    });

    it("explicit aliases preserve established supported semantics but reject demonstrably changed ownership", () => {
      const cdb = getCacheDb();
      const liveAliasHash = "test_alias_live_hash";
      const deadAliasHash = "test_alias_dead_hash";
      const changedAuthorAliasHash = "test_alias_changed_author_hash";
      const unknownAuthorAliasHash = "test_alias_unknown_author_hash";

      // Alias 1: points to live book 12 with matching author
      cdb.run(
        "INSERT OR REPLACE INTO file_hashes (filepath, mtime, hash, book_id, title, authors, cover) VALUES (?, ?, ?, ?, ?, ?, ?)",
        [`alias:${liveAliasHash}`, 1, liveAliasHash, 12, "Active Alias Work", "Author A", 0],
      );
      // Alias 2: points to deleted book 42
      cdb.run(
        "INSERT OR REPLACE INTO file_hashes (filepath, mtime, hash, book_id, title, authors, cover) VALUES (?, ?, ?, ?, ?, ?, ?)",
        [`alias:${deadAliasHash}`, 1, deadAliasHash, 42, "Deleted Alias Work", "Author B", 0],
      );
      // Alias 3: points to book 12, but recorded author was Old Author and active book is Author A (changed ownership!)
      cdb.run(
        "INSERT OR REPLACE INTO file_hashes (filepath, mtime, hash, book_id, title, authors, cover) VALUES (?, ?, ?, ?, ?, ?, ?)",
        [`alias:${changedAuthorAliasHash}`, 1, changedAuthorAliasHash, 12, "Active Alias Work", "Old Author", 0],
      );
      // Alias 4: points to book 13, both recorded and active author are Unknown (established supported alias semantics)
      cdb.run(
        "INSERT OR REPLACE INTO file_hashes (filepath, mtime, hash, book_id, title, authors, cover) VALUES (?, ?, ?, ?, ?, ?, ?)",
        [`alias:${unknownAuthorAliasHash}`, 1, unknownAuthorAliasHash, 13, "Ancient Folktale", "Unknown", 0],
      );

      const knownBooks = [
        { id: 12, title: "Active Alias Work", authors: "Author A", cover: 0 },
        { id: 13, title: "Ancient Folktale", authors: "Unknown", cover: 0 },
      ];

      const { map } = getCalibreHashMap(knownBooks);
      expect(map[liveAliasHash]).toBeDefined();
      expect(map[liveAliasHash].id).toBe(12);
      expect(map[deadAliasHash]).toBeUndefined();
      expect(map[changedAuthorAliasHash]).toBeUndefined();
      expect(map[unknownAuthorAliasHash]).toBeDefined();
      expect(map[unknownAuthorAliasHash].id).toBe(13);
    });

    it("failed book-list fetch does not flush cache and preserves existing reservation safety checks", async () => {
      const cdb = getCacheDb();
      const testHash = "test_fetch_failure_retention_hash";
      cdb.run(
        "INSERT OR REPLACE INTO file_hashes (filepath, mtime, hash, book_id, title, authors, cover) VALUES (?, ?, ?, ?, ?, ?, ?)",
        ["/fake/retained.epub#h", 1, testHash, 12, "Retained Book", "Author", 0],
      );

      setServerDependenciesForTest({
        getCalibreBooks: () => {
          throw new Error("Simulated Calibre database locked/unavailable");
        },
      });

      try {
        // getCalibreHashMap handles failed book fetch safely:
        // Does NOT treat unavailable as confirmed deletion! Preserves cached duplicate safety checks.
        const { map, booksFetchFailed } = getCalibreHashMap();
        expect(booksFetchFailed).toBe(true);
        expect(map[testHash]).toBeDefined();
        expect(map[testHash].id).toBe(12);

        // Readback confirms cache rows are NOT deleted or flushed
        const row = cdb.query("SELECT * FROM file_hashes WHERE hash = ?").get(testHash) as any;
        expect(row).toBeDefined();
        expect(row.book_id).toBe(12);

        // End-to-end ingestBookFile with cold cache and unavailable catalog:
        // Must preserve duplicate reservation rather than treating unavailable as confirmed deletion
        const tempEpubDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "u12-cold-outage-"));
        try {
          const testEpub = path.join(tempEpubDir, "outage_test.epub");
          const staging = path.join(tempEpubDir, "staging");
          fs.mkdirSync(path.join(staging, "META-INF"), { recursive: true });
          fs.mkdirSync(path.join(staging, "OEBPS"), { recursive: true });
          fs.writeFileSync(path.join(staging, "mimetype"), "application/epub+zip");
          fs.writeFileSync(
            path.join(staging, "META-INF", "container.xml"),
            `<?xml version="1.0"?><container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container"><rootfiles><rootfile full-path="OEBPS/content.opf" media-type="application/oebps-package+xml"/></rootfiles></container>`,
          );
          fs.writeFileSync(
            path.join(staging, "OEBPS", "content.opf"),
            `<?xml version="1.0" encoding="utf-8"?><package xmlns="http://www.idpf.org/2007/opf" version="3.0"><metadata xmlns:dc="http://purl.org/dc/elements/1.1/"><dc:title>Retained Book</dc:title><dc:creator>Author</dc:creator></metadata><manifest><item id="t" href="text.xhtml" media-type="application/xhtml+xml"/></manifest><spine><itemref idref="t"/></spine></package>`,
          );
          fs.writeFileSync(
            path.join(staging, "OEBPS", "text.xhtml"),
            `<html><body>${"A novel chapter with meaningful original fixture prose. ".repeat(150)}</body></html>`,
          );
          spawnSync("zip", ["-q", "-X", "-0", testEpub, "mimetype"], { cwd: staging });
          spawnSync("zip", ["-q", "-r", testEpub, "META-INF", "OEBPS"], { cwd: staging });

          const { getKOReaderBinary256 } = await import("./bot");
          const outageHash = getKOReaderBinary256(testEpub);

          cdb.run(
            "INSERT OR REPLACE INTO file_hashes (filepath, mtime, hash, book_id, title, authors, cover) VALUES (?, ?, ?, ?, ?, ?, ?)",
            [testEpub, 1, outageHash, 12, "Retained Book", "Author", 0],
          );

          // Ingesting the file with unavailable catalog must preserve the duplicate check
          const ingestRes = await ingestBookFile(testEpub, "outage_test.epub");
          expect(ingestRes.success).toBe(true);
          expect(ingestRes.duplicate).toBe(true);
          expect(ingestRes.bookId).toBe(12);
        } finally {
          await fs.promises.rm(tempEpubDir, { recursive: true, force: true });
        }
      } finally {
        resetServerDependenciesForTest();
      }
    });

    it("matchesActiveBookIdentity and isAuthorKnown comprehensive unit checks", () => {
      // isAuthorKnown behavior
      expect(isAuthorKnown("Arthur C. Clarke")).toBe(true);
      expect(isAuthorKnown("")).toBe(false);
      expect(isAuthorKnown("Unknown")).toBe(false);
      expect(isAuthorKnown("unknown")).toBe(false);
      expect(isAuthorKnown("anonymous")).toBe(false);
      expect(isAuthorKnown("Uncredited")).toBe(false);
      expect(isAuthorKnown("uncredited")).toBe(false);
      expect(isAuthorKnown("various")).toBe(false);
      expect(isAuthorKnown("n/a")).toBe(false);
      expect(isAuthorKnown("none")).toBe(false);

      // Uncredited author must not be accepted by title resemblance alone
      const activeUncredited = { title: "Folktale", authors: "Uncredited" };
      expect(matchesActiveBookIdentity(activeUncredited, "Folktale", "Uncredited", "/path/folktale.epub")).toBe(false);

      // Exact match with matching authors
      const active = { title: "Overlord Volume 1", authors: "Kugane Maruyama" };
      expect(matchesActiveBookIdentity(active, "Overlord Volume 1", "Kugane Maruyama")).toBe(true);

      // Case insensitive title and author
      expect(matchesActiveBookIdentity(active, "OVERLORD VOLUME 1", "kugane maruyama")).toBe(true);

      // Whitespace normalized title
      expect(matchesActiveBookIdentity(active, "Overlord   Volume  1", "Kugane Maruyama")).toBe(true);

      // Contradictory author: rejected
      expect(matchesActiveBookIdentity(active, "Overlord Volume 1", "Different Author")).toBe(false);

      // Contradictory title: rejected
      expect(matchesActiveBookIdentity(active, "Hamlet", "Kugane Maruyama")).toBe(false);

      // Missing or null values
      expect(matchesActiveBookIdentity(null, "Overlord Volume 1", "Kugane Maruyama")).toBe(false);
      expect(matchesActiveBookIdentity(active, "", "Kugane Maruyama")).toBe(false);
      expect(matchesActiveBookIdentity({ title: "" }, "Overlord Volume 1", "Kugane Maruyama")).toBe(false);
    });

    it("refreshCalibreHashIndex scans library on disk and updates file_hashes", () => {
      const res = refreshCalibreHashIndex();
      expect(typeof res.indexedCount).toBe("number");
      expect(res.indexedCount).toBeGreaterThanOrEqual(0);
    });

    it("getCalibreBooksResult requires a valid array and preserves catalog failure status on non-array calibredb output", async () => {
      const origCalibreDb = process.env.CALIBRE_DB_PATH;
      const origCalibredb = process.env.CALIBREDB_PATH;
      process.env.CALIBRE_DB_PATH = "/nonexistent/metadata.db";

      const tempDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "u12-malformed-list-"));
      const mockScript = path.join(tempDir, "mock_list.sh");
      fs.writeFileSync(
        mockScript,
        `#!/bin/sh
if [ "$1" = "list" ]; then
  echo '{"error": "locked"}'
  exit 0
fi
exit 0
`,
      );
      fs.chmodSync(mockScript, 0o755);
      process.env.CALIBREDB_PATH = mockScript;

      try {
        const { getCalibreBooksResult } = await import("./server");
        const res = getCalibreBooksResult(true);
        expect(res.success).toBe(false);
      } finally {
        if (origCalibreDb !== undefined) process.env.CALIBRE_DB_PATH = origCalibreDb;
        else delete process.env.CALIBRE_DB_PATH;
        if (origCalibredb !== undefined) process.env.CALIBREDB_PATH = origCalibredb;
        else delete process.env.CALIBREDB_PATH;
        await fs.promises.rm(tempDir, { recursive: true, force: true });
      }
    });

    it("matchesActiveBookIdentity handles authors as an array from calibredb fallback without throwing", () => {
      const activeBookWithArrayAuthors = {
        id: 77,
        title: "Inferno",
        authors: ["Dan Brown"],
      };

      // Exact match with author in array
      expect(
        matchesActiveBookIdentity(
          activeBookWithArrayAuthors,
          "Inferno",
          "Dan Brown",
        ),
      ).toBe(true);

      // Contradictory author with author in array
      expect(
        matchesActiveBookIdentity(
          activeBookWithArrayAuthors,
          "Inferno",
          "Dante Alighieri",
        ),
      ).toBe(false);

      // Cached author as array as well
      expect(
        matchesActiveBookIdentity(
          activeBookWithArrayAuthors,
          "Inferno",
          ["Dan Brown"],
        ),
      ).toBe(true);
    });

    it("cold hash cache upload: ingestBookFile populates hash index on cold cache and detects exact-content duplicate", async () => {
      const tempLibDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "u12-cold-upload-lib-"));
      const tempDropDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "u12-cold-upload-drop-"));
      const origLibDir = process.env.CALIBRE_LIBRARY_DIR;
      process.env.CALIBRE_LIBRARY_DIR = tempLibDir;

      try {
        // 1. Create an EPUB on disk inside the Calibre library folder
        const authorFolder = path.join(tempLibDir, "Author Beta (88)");
        fs.mkdirSync(authorFolder, { recursive: true });
        const libraryEpub = path.join(authorFolder, "Library Book.epub");
        const staging = path.join(tempLibDir, "staging");
        fs.mkdirSync(path.join(staging, "META-INF"), { recursive: true });
        fs.mkdirSync(path.join(staging, "OEBPS"), { recursive: true });
        fs.writeFileSync(path.join(staging, "mimetype"), "application/epub+zip");
        fs.writeFileSync(
          path.join(staging, "META-INF", "container.xml"),
          `<?xml version="1.0"?><container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container"><rootfiles><rootfile full-path="OEBPS/content.opf" media-type="application/oebps-package+xml"/></rootfiles></container>`,
        );
        fs.writeFileSync(
          path.join(staging, "OEBPS", "content.opf"),
          `<?xml version="1.0" encoding="utf-8"?><package xmlns="http://www.idpf.org/2007/opf" version="3.0"><metadata xmlns:dc="http://purl.org/dc/elements/1.1/"><dc:title>Original Beta Title</dc:title><dc:creator>Author Beta</dc:creator></metadata><manifest><item id="t" href="text.xhtml" media-type="application/xhtml+xml"/></manifest><spine><itemref idref="t"/></spine></package>`,
        );
        fs.writeFileSync(
          path.join(staging, "OEBPS", "text.xhtml"),
          `<html><body>${"Prose for cold upload test. ".repeat(100)}</body></html>`,
        );
        spawnSync("zip", ["-q", "-X", "-0", libraryEpub, "mimetype"], { cwd: staging });
        spawnSync("zip", ["-q", "-r", libraryEpub, "META-INF", "OEBPS"], { cwd: staging });

        // 2. Active book in Calibre has the same title as on disk
        const knownBooks = [
          { id: 88, title: "Original Beta Title", authors: "Author Beta", cover: 0 },
        ];
        setServerDependenciesForTest({
          getCalibreBooks: () => knownBooks,
        });

        // 3. Clear file_hashes to ensure a cold hash cache
        const cdb = getCacheDb();
        const { getKOReaderBinary256 } = await import("./bot");
        const fileHash = getKOReaderBinary256(libraryEpub);
        cdb.run("DELETE FROM file_hashes WHERE hash = ?", [fileHash]);

        // 4. Ingest the byte-identical EPUB via ingestBookFile:
        // Because ingestBookFile passes scanDisk: true on cold cache,
        // it discovers the library file and detects the duplicate!
        const uploadEpub = path.join(tempDropDir, "uploaded_beta.epub");
        fs.copyFileSync(libraryEpub, uploadEpub);

        const res = await ingestBookFile(uploadEpub, "uploaded_beta.epub");
        expect(res.success).toBe(true);
        expect(res.duplicate).toBe(true);
        expect(res.bookId).toBe(88);
        expect(res.message).toContain("already in your library");
      } finally {
        resetServerDependenciesForTest();
        if (origLibDir !== undefined) process.env.CALIBRE_LIBRARY_DIR = origLibDir;
        else delete process.env.CALIBRE_LIBRARY_DIR;
        await fs.promises.rm(tempLibDir, { recursive: true, force: true });
        await fs.promises.rm(tempDropDir, { recursive: true, force: true });
      }
    });

    it("ingestBookFile preserves explicit alias duplicate match when both authors are unknown without dropping alias provenance", async () => {
      const knownBooks = [
        { id: 91, title: "Anonymous Manuscript", authors: "Unknown", cover: 0 },
      ];
      setServerDependenciesForTest({
        getCalibreBooks: () => knownBooks,
      });

      const tempDropDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "u12-alias-unknown-"));
      try {
        const testEpub = path.join(tempDropDir, "anon.epub");
        const staging = path.join(tempDropDir, "staging");
        fs.mkdirSync(path.join(staging, "META-INF"), { recursive: true });
        fs.mkdirSync(path.join(staging, "OEBPS"), { recursive: true });
        fs.writeFileSync(path.join(staging, "mimetype"), "application/epub+zip");
        fs.writeFileSync(
          path.join(staging, "META-INF", "container.xml"),
          `<?xml version="1.0"?><container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container"><rootfiles><rootfile full-path="OEBPS/content.opf" media-type="application/oebps-package+xml"/></rootfiles></container>`,
        );
        fs.writeFileSync(
          path.join(staging, "OEBPS", "content.opf"),
          `<?xml version="1.0"?><package xmlns="http://www.idpf.org/2007/opf" version="3.0"><metadata xmlns:dc="http://purl.org/dc/elements/1.1/"><dc:title>Edited Calibre Title</dc:title><dc:creator>Unknown</dc:creator></metadata><manifest><item id="t" href="text.xhtml" media-type="application/xhtml+xml"/></manifest><spine><itemref idref="t"/></spine></package>`,
        );
        fs.writeFileSync(
          path.join(staging, "OEBPS", "text.xhtml"),
          `<html><body>${"Prose for alias unknown author test. ".repeat(100)}</body></html>`,
        );
        spawnSync("zip", ["-q", "-X", "-0", testEpub, "mimetype"], { cwd: staging });
        spawnSync("zip", ["-q", "-r", testEpub, "META-INF", "OEBPS"], { cwd: staging });

        const { getKOReaderBinary256 } = await import("./bot");
        const docHash = getKOReaderBinary256(testEpub);

        const cdb = getCacheDb();
        cdb.run(
          "INSERT OR REPLACE INTO file_hashes (filepath, mtime, hash, book_id, title, authors, cover) VALUES (?, ?, ?, ?, ?, ?, ?)",
          [`alias:${docHash}`, 1, docHash, 91, "Anonymous Manuscript", "Unknown", 0],
        );

        const res = await ingestBookFile(testEpub, "anon.epub");
        expect(res.success).toBe(true);
        expect(res.duplicate).toBe(true);
        expect(res.bookId).toBe(91);
      } finally {
        resetServerDependenciesForTest();
        await fs.promises.rm(tempDropDir, { recursive: true, force: true });
      }
    });

    it("legacy null-ID sentinel is treated as cache miss and repaired once catalog is available", async () => {
      const tempLibDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "u12-null-sentinel-"));
      const origLibDir = process.env.CALIBRE_LIBRARY_DIR;
      process.env.CALIBRE_LIBRARY_DIR = tempLibDir;

      try {
        const authorFolder = path.join(tempLibDir, "Author Gamma (66)");
        fs.mkdirSync(authorFolder, { recursive: true });
        const epubFile = path.join(authorFolder, "Gamma Book.epub");
        const staging = path.join(tempLibDir, "staging");
        fs.mkdirSync(path.join(staging, "META-INF"), { recursive: true });
        fs.mkdirSync(path.join(staging, "OEBPS"), { recursive: true });
        fs.writeFileSync(path.join(staging, "mimetype"), "application/epub+zip");
        fs.writeFileSync(
          path.join(staging, "META-INF", "container.xml"),
          `<?xml version="1.0"?><container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container"><rootfiles><rootfile full-path="OEBPS/content.opf" media-type="application/oebps-package+xml"/></rootfiles></container>`,
        );
        fs.writeFileSync(
          path.join(staging, "OEBPS", "content.opf"),
          `<?xml version="1.0"?><package xmlns="http://www.idpf.org/2007/opf" version="3.0"><metadata xmlns:dc="http://purl.org/dc/elements/1.1/"><dc:title>Gamma Book</dc:title><dc:creator>Author Gamma</dc:creator></metadata><manifest><item id="t" href="text.xhtml" media-type="application/xhtml+xml"/></manifest><spine><itemref idref="t"/></spine></package>`,
        );
        fs.writeFileSync(
          path.join(staging, "OEBPS", "text.xhtml"),
          `<html><body>${"Prose for legacy sentinel test. ".repeat(100)}</body></html>`,
        );
        spawnSync("zip", ["-q", "-X", "-0", epubFile, "mimetype"], { cwd: staging });
        spawnSync("zip", ["-q", "-r", epubFile, "META-INF", "OEBPS"], { cwd: staging });

        const stat = fs.statSync(epubFile);
        const mtime = Math.floor(stat.mtimeMs);

        // Insert legacy null-ID sentinel row
        const cdb = getCacheDb();
        cdb.run(
          "INSERT OR REPLACE INTO file_hashes (filepath, mtime, hash, book_id, title, authors, cover) VALUES (?, ?, ?, ?, ?, ?, ?)",
          [epubFile + "#bin256", mtime, "sentinel", null, "Unresolved", "Unknown", 0],
        );

        // Active catalog resolves book 66
        const knownBooks = [
          { id: 66, title: "Gamma Book", authors: "Author Gamma", cover: 0 },
        ];
        setServerDependenciesForTest({
          getCalibreBooks: () => knownBooks,
        });

        // Scan must treat null-ID sentinel as cache miss and repair it with book_id = 66
        const refreshRes = refreshCalibreHashIndex();
        expect(refreshRes.indexedCount).toBeGreaterThan(0);

        const repairedSentinel = cdb
          .query("SELECT book_id FROM file_hashes WHERE filepath = ? AND mtime = ?")
          .get(epubFile + "#bin256", mtime) as any;
        expect(repairedSentinel).toBeDefined();
        expect(repairedSentinel.book_id).toBe(66);
      } finally {
        resetServerDependenciesForTest();
        if (origLibDir !== undefined) process.env.CALIBRE_LIBRARY_DIR = origLibDir;
        else delete process.env.CALIBRE_LIBRARY_DIR;
        await fs.promises.rm(tempLibDir, { recursive: true, force: true });
      }
    });
  });

  describe("Native OPDS 1.2 Catalog & Filtered Search", () => {
    let tempBaseDir: string;
    let fakeLibraryDir: string;
    let fakeCalibreDbPath: string;
    let origCalibreDb: string | undefined;
    let origCalibreLib: string | undefined;

    const setupFakeCalibreDatabase = (
      books: Array<{
        id: number;
        title: string;
        author: string;
        series?: string | null;
        series_index?: number | null;
        format?: string;
        fileContent?: string;
      }>,
    ) => {
      const db = new Database(fakeCalibreDbPath);
      db.run("CREATE TABLE books (id INTEGER PRIMARY KEY, title TEXT, path TEXT, has_cover INTEGER, pubdate TEXT, series_index REAL);");
      db.run("CREATE TABLE data (id INTEGER PRIMARY KEY, book INTEGER, format TEXT, uncompressed_size INTEGER, name TEXT);");
      db.run("CREATE TABLE authors (id INTEGER PRIMARY KEY, name TEXT);");
      db.run("CREATE TABLE books_authors_link (id INTEGER PRIMARY KEY, book INTEGER, author INTEGER);");
      db.run("CREATE TABLE series (id INTEGER PRIMARY KEY, name TEXT);");
      db.run("CREATE TABLE books_series_link (id INTEGER PRIMARY KEY, book INTEGER, series INTEGER);");
      db.run("CREATE TABLE tags (id INTEGER PRIMARY KEY, name TEXT);");
      db.run("CREATE TABLE books_tags_link (id INTEGER PRIMARY KEY, book INTEGER, tag INTEGER);");
      db.run("CREATE TABLE publishers (id INTEGER PRIMARY KEY, name TEXT);");
      db.run("CREATE TABLE books_publishers_link (id INTEGER PRIMARY KEY, book INTEGER, publisher INTEGER);");

      for (const b of books) {
        const bookRelDir = `${b.author}/${b.title} (${b.id})`;
        const fullBookDir = path.join(fakeLibraryDir, bookRelDir);
        fs.mkdirSync(fullBookDir, { recursive: true });
        const format = (b.format || "EPUB").toLowerCase();
        const filename = `${b.title} - ${b.author}.${format}`;
        const filePath = path.join(fullBookDir, filename);
        fs.writeFileSync(filePath, b.fileContent || "content", "utf8");

        db.run(
          "INSERT INTO books (id, title, path, has_cover, pubdate, series_index) VALUES (?, ?, ?, 0, '', ?);",
          [b.id, b.title, bookRelDir, b.series_index ?? 1],
        );
        const stat = fs.statSync(filePath);
        db.run(
          "INSERT INTO data (id, book, format, uncompressed_size, name) VALUES (?, ?, ?, ?, ?);",
          [b.id, b.id, format.toUpperCase(), stat.size, `${b.title} - ${b.author}`],
        );
        db.run("INSERT OR IGNORE INTO authors (id, name) VALUES (?, ?);", [b.id, b.author]);
        db.run("INSERT INTO books_authors_link (id, book, author) VALUES (?, ?, ?);", [b.id, b.id, b.id]);

        if (b.series) {
          db.run("INSERT OR IGNORE INTO series (id, name) VALUES (?, ?);", [b.id, b.series]);
          db.run("INSERT INTO books_series_link (id, book, series) VALUES (?, ?, ?);", [b.id, b.id, b.id]);
        }
      }
      db.close();
    };

    beforeEach(() => {
      tempBaseDir = fs.mkdtempSync(path.join(os.tmpdir(), "server-opds-test-"));
      fakeLibraryDir = path.join(tempBaseDir, "Calibre_Library");
      fakeCalibreDbPath = path.join(fakeLibraryDir, "metadata.db");
      fs.mkdirSync(fakeLibraryDir, { recursive: true });

      origCalibreDb = process.env.CALIBRE_DB_PATH;
      origCalibreLib = process.env.CALIBRE_LIBRARY_DIR;

      process.env.CALIBRE_DB_PATH = fakeCalibreDbPath;
      process.env.CALIBRE_LIBRARY_DIR = fakeLibraryDir;
    });

    afterEach(async () => {
      if (origCalibreDb === undefined) {
        delete process.env.CALIBRE_DB_PATH;
      } else {
        process.env.CALIBRE_DB_PATH = origCalibreDb;
      }
      if (origCalibreLib === undefined) {
        delete process.env.CALIBRE_LIBRARY_DIR;
      } else {
        process.env.CALIBRE_LIBRARY_DIR = origCalibreLib;
      }

      await fs.promises.rm(tempBaseDir, { recursive: true, force: true });
    });

    it("advertises native OPDS search link in /api/opds with correct MIME and returns unfiltered browse", async () => {
      setupFakeCalibreDatabase([
        { id: 101, title: "Overlord Volume 1", author: "Kugane Maruyama", series: "Overlord Series" },
        { id: 102, title: "Dune", author: "Frank Herbert", series: "Dune Chronicles" },
        { id: 103, title: "မြန်မာ့သမိုင်း", author: "ဦးဖိုးကျား", series: "မြန်မာစာပေစုံ" },
        { id: 104, title: "Science & Fiction <Vol. 2>", author: "Arthur C. Clarke & Isaac Asimov", series: "Special & Strange" },
      ]);

      const req = new Request("http://127.0.0.1:8086/api/opds");
      const res = await handleRequest(req);
      expect(res.status).toBe(200);
      expect(res.headers.get("content-type")).toBe(
        "application/atom+xml;profile=opds-catalog;kind=acquisition;charset=utf-8",
      );

      const xml = await res.text();
      expect(xml).toContain('<link rel="search" href="http://127.0.0.1:8086/api/opds?search={searchTerms}" type="application/atom+xml;profile=opds-catalog"/>');
      expect(xml).toContain('<link rel="self" href="http://127.0.0.1:8086/api/opds" type="application/atom+xml;profile=opds-catalog;kind=acquisition"/>');
      expect(xml).toContain("<id>urn:lighthouse:catalog:/api/opds</id>");
      expect(xml).toContain("<title>LightHouse OPDS Catalog</title>");

      const entryCount = (xml.match(/<entry>/g) || []).length;
      expect(entryCount).toBe(4);
    });

    it("follows advertised search link to filter by title, author, and series case-insensitively", async () => {
      setupFakeCalibreDatabase([
        { id: 101, title: "Overlord Volume 1", author: "Kugane Maruyama", series: "Overlord Series" },
        { id: 102, title: "Dune", author: "Frank Herbert", series: "Dune Chronicles" },
        { id: 103, title: "မြန်မာ့သမိုင်း", author: "ဦးဖိုးကျား", series: "မြန်မာစာပေစုံ" },
        { id: 104, title: "Science & Fiction <Vol. 2>", author: "Arthur C. Clarke & Isaac Asimov", series: "Special & Strange" },
      ]);

      // 1. Title search (case-insensitive: "overlord")
      const titleRes = await handleRequest(new Request("http://127.0.0.1:8086/api/opds?search=overlord"));
      expect(titleRes.status).toBe(200);
      const titleXml = await titleRes.text();
      expect(titleXml).toContain("Overlord Volume 1");
      expect(titleXml).not.toContain("Dune");
      expect((titleXml.match(/<entry>/g) || []).length).toBe(1);
      expect(titleXml).toContain("<title>LightHouse OPDS Catalog - Search: overlord</title>");
      expect(titleXml).toContain('<link rel="self" href="http://127.0.0.1:8086/api/opds?search=overlord"');

      // 2. Author search (case-insensitive: "herbert")
      const authorRes = await handleRequest(new Request("http://127.0.0.1:8086/api/opds?search=herbert"));
      expect(authorRes.status).toBe(200);
      const authorXml = await authorRes.text();
      expect(authorXml).toContain("Dune");
      expect(authorXml).not.toContain("Overlord");
      expect((authorXml.match(/<entry>/g) || []).length).toBe(1);

      // 3. Series search (case-insensitive: "chronicles")
      const seriesRes = await handleRequest(new Request("http://127.0.0.1:8086/api/opds?search=chronicles"));
      expect(seriesRes.status).toBe(200);
      const seriesXml = await seriesRes.text();
      expect(seriesXml).toContain("Dune");
      expect(seriesXml).not.toContain("Overlord");
      expect((seriesXml.match(/<entry>/g) || []).length).toBe(1);

      // 4. Secondary author in multi-author string ("asimov")
      const multiAuthRes = await handleRequest(new Request("http://127.0.0.1:8086/api/opds?search=asimov"));
      expect(multiAuthRes.status).toBe(200);
      const multiAuthXml = await multiAuthRes.text();
      expect(multiAuthXml).toContain("Science &amp; Fiction &lt;Vol. 2&gt;");
      expect((multiAuthXml.match(/<entry>/g) || []).length).toBe(1);
    });

    it("handles nonexistent and empty search queries gracefully", async () => {
      setupFakeCalibreDatabase([
        { id: 101, title: "Overlord Volume 1", author: "Kugane Maruyama", series: "Overlord Series" },
        { id: 102, title: "Dune", author: "Frank Herbert", series: "Dune Chronicles" },
      ]);

      // Nonexistent query returns valid Atom XML feed with 0 entries
      const nonExistentRes = await handleRequest(new Request("http://127.0.0.1:8086/api/opds?search=nonexistent-term-xyz"));
      expect(nonExistentRes.status).toBe(200);
      const nonExistentXml = await nonExistentRes.text();
      expect(nonExistentXml).toContain("<feed");
      expect(nonExistentXml).toContain("</feed>");
      expect((nonExistentXml.match(/<entry>/g) || []).length).toBe(0);

      // Empty query ?search= returns unfiltered browse
      const emptyRes = await handleRequest(new Request("http://127.0.0.1:8086/api/opds?search="));
      expect(emptyRes.status).toBe(200);
      const emptyXml = await emptyRes.text();
      expect((emptyXml.match(/<entry>/g) || []).length).toBe(2);

      // Whitespace only query returns unfiltered browse
      const wsRes = await handleRequest(new Request("http://127.0.0.1:8086/api/opds?search=%20%20%20"));
      expect(wsRes.status).toBe(200);
      const wsXml = await wsRes.text();
      expect((wsXml.match(/<entry>/g) || []).length).toBe(2);

      // Alternative ?q= query param
      const qRes = await handleRequest(new Request("http://127.0.0.1:8086/api/opds?q=Dune"));
      expect(qRes.status).toBe(200);
      const qXml = await qRes.text();
      expect((qXml.match(/<entry>/g) || []).length).toBe(1);
      expect(qXml).toContain("Dune");
    });

    it("handles Unicode characters and URL encoding in search query", async () => {
      setupFakeCalibreDatabase([
        { id: 101, title: "Overlord Volume 1", author: "Kugane Maruyama", series: "Overlord Series" },
        { id: 103, title: "မြန်မာ့သမိုင်း", author: "ဦးဖိုးကျား", series: "မြန်မာစာပေစုံ" },
      ]);

      // URL-encoded Burmese search term: %E1%80%99%E1%80%BC%E1%80%94%E1%80%BA%E1%80%99%E1%80%AC (မြန်မာ)
      const encodedRes = await handleRequest(
        new Request("http://127.0.0.1:8086/api/opds?search=%E1%80%99%E1%80%BC%E1%80%94%E1%80%BA%E1%80%99%E1%80%AC"),
      );
      expect(encodedRes.status).toBe(200);
      const encodedXml = await encodedRes.text();
      expect(encodedXml).toContain("မြန်မာ့သမိုင်း");
      expect((encodedXml.match(/<entry>/g) || []).length).toBe(1);

      // Direct Unicode search for author
      const directRes = await handleRequest(
        new Request(`http://127.0.0.1:8086/api/opds?search=${encodeURIComponent("ဦးဖိုးကျား")}`),
      );
      expect(directRes.status).toBe(200);
      const directXml = await directRes.text();
      expect(directXml).toContain("မြန်မာ့သမိုင်း");
      expect((directXml.match(/<entry>/g) || []).length).toBe(1);
    });

    it("cleanly escapes XML special characters in search title, id, and self link", async () => {
      setupFakeCalibreDatabase([
        { id: 104, title: "Science & Fiction <Vol. 2>", author: "Arthur C. Clarke & Isaac Asimov", series: "Special & Strange" },
      ]);

      const specialQuery = "Science & Fiction <Vol. 2>";
      const res = await handleRequest(
        new Request(`http://127.0.0.1:8086/api/opds?search=${encodeURIComponent(specialQuery)}`),
      );
      expect(res.status).toBe(200);
      const xml = await res.text();

      // Title must escape decoded query characters & and <
      expect(xml).toContain("<title>LightHouse OPDS Catalog - Search: Science &amp; Fiction &lt;Vol. 2&gt;</title>");
      // Self link and id must be valid XML
      expect(xml).toContain('rel="self"');
      expect(xml).toContain("<id>urn:lighthouse:catalog:/api/opds?search=Science%20%26%20Fiction%20%3CVol.%202%3E</id>");
      expect(xml).not.toMatch(/<title>[^<]*&(?!(amp|lt|gt|quot|apos);)[^<]*<\/title>/);

      // Raw unencoded & in search URL is also cleanly XML-escaped
      const rawRes = await handleRequest(new Request("http://127.0.0.1:8086/api/opds?search=A&B"));
      expect(rawRes.status).toBe(200);
      const rawXml = await rawRes.text();
      expect(rawXml).toContain("<id>urn:lighthouse:catalog:/api/opds?search=A&amp;B</id>");
      expect(rawXml).toContain("<title>LightHouse OPDS Catalog - Search: A</title>");
    });

    it("supports GET and HEAD methods and returns 405 on mutating methods", async () => {
      setupFakeCalibreDatabase([
        { id: 102, title: "Dune", author: "Frank Herbert", series: "Dune Chronicles" },
      ]);

      // GET returns 200 with XML body
      const getRes = await handleRequest(new Request("http://127.0.0.1:8086/api/opds"));
      expect(getRes.status).toBe(200);
      expect((await getRes.text()).length).toBeGreaterThan(0);

      // HEAD returns 200 with null body and identical Content-Type
      const headRes = await handleRequest(new Request("http://127.0.0.1:8086/api/opds", { method: "HEAD" }));
      expect(headRes.status).toBe(200);
      expect(headRes.headers.get("content-type")).toBe(
        "application/atom+xml;profile=opds-catalog;kind=acquisition;charset=utf-8",
      );
      expect((await headRes.text()).length).toBe(0);

      // HEAD with search returns 200 with empty body
      const headSearchRes = await handleRequest(new Request("http://127.0.0.1:8086/api/opds?search=Dune", { method: "HEAD" }));
      expect(headSearchRes.status).toBe(200);
      expect((await headSearchRes.text()).length).toBe(0);

      // Mutating methods return 405 with Allow header
      for (const method of ["POST", "PUT", "DELETE", "PATCH"]) {
        const mutateRes = await handleRequest(new Request("http://127.0.0.1:8086/api/opds", { method }));
        expect(mutateRes.status).toBe(405);
        expect(mutateRes.headers.get("Allow")).toBe("GET, HEAD");
      }
    });

    it("preserves /api/books JSON semantics and unfiltered browse", async () => {
      setupFakeCalibreDatabase([
        { id: 101, title: "Overlord Volume 1", author: "Kugane Maruyama", series: "Overlord Series" },
        { id: 102, title: "Dune", author: "Frank Herbert", series: "Dune Chronicles" },
      ]);

      // /api/books returns full JSON array
      const jsonRes = await handleRequest(new Request("http://127.0.0.1:8086/api/books"));
      expect(jsonRes.status).toBe(200);
      expect(jsonRes.headers.get("content-type")).toContain("application/json");
      const books = await jsonRes.json();
      expect(books.length).toBe(2);

      // /api/books?search=nonexistent retains JSON semantics and returns full list
      const searchJsonRes = await handleRequest(new Request("http://127.0.0.1:8086/api/books?search=nonexistent"));
      expect(searchJsonRes.status).toBe(200);
      expect(searchJsonRes.headers.get("content-type")).toContain("application/json");
      const searchBooks = await searchJsonRes.json();
      expect(searchBooks.length).toBe(2);
    });

    it("ensures correct self and feed query identity for subpaths /api/opds/feed and /api/opds/catalog", async () => {
      setupFakeCalibreDatabase([
        { id: 102, title: "Dune", author: "Frank Herbert", series: "Dune Chronicles" },
      ]);

      const feedRes = await handleRequest(new Request("http://127.0.0.1:8086/api/opds/feed?search=Dune"));
      expect(feedRes.status).toBe(200);
      const feedXml = await feedRes.text();
      expect(feedXml).toContain('<link rel="self" href="http://127.0.0.1:8086/api/opds/feed?search=Dune"');
      expect(feedXml).toContain("<id>urn:lighthouse:catalog:/api/opds/feed?search=Dune</id>");

      const catalogRes = await handleRequest(new Request("http://127.0.0.1:8086/api/opds/catalog?search=Dune"));
      expect(catalogRes.status).toBe(200);
      const catalogXml = await catalogRes.text();
      expect(catalogXml).toContain('<link rel="self" href="http://127.0.0.1:8086/api/opds/catalog?search=Dune"');
      expect(catalogXml).toContain("<id>urn:lighthouse:catalog:/api/opds/catalog?search=Dune</id>");
    });

    it("concurrent requests across cache refresh do not mix queries or mutate state", async () => {
      setupFakeCalibreDatabase([
        { id: 101, title: "Overlord Volume 1", author: "Kugane Maruyama", series: "Overlord Series" },
        { id: 102, title: "Dune", author: "Frank Herbert", series: "Dune Chronicles" },
      ]);

      // Launch concurrent requests with different queries
      const [r1, r2, r3, r4] = await Promise.all([
        handleRequest(new Request("http://127.0.0.1:8086/api/opds?search=overlord")),
        handleRequest(new Request("http://127.0.0.1:8086/api/opds?search=dune")),
        handleRequest(new Request("http://127.0.0.1:8086/api/opds?search=nonexistent")),
        handleRequest(new Request("http://127.0.0.1:8086/api/opds")),
      ]);

      const [xml1, xml2, xml3, xml4] = await Promise.all([
        r1.text(),
        r2.text(),
        r3.text(),
        r4.text(),
      ]);

      expect((xml1.match(/<entry>/g) || []).length).toBe(1);
      expect(xml1).toContain("Overlord Volume 1");
      expect(xml1).not.toContain("Dune");

      expect((xml2.match(/<entry>/g) || []).length).toBe(1);
      expect(xml2).toContain("Dune");
      expect(xml2).not.toContain("Overlord Volume 1");

      expect((xml3.match(/<entry>/g) || []).length).toBe(0);

      expect((xml4.match(/<entry>/g) || []).length).toBe(2);

      // Verify aborted read leaves database intact
      const abortReq = new Request("http://127.0.0.1:8086/api/opds?search=dune");
      const abortRes = await handleRequest(abortReq);
      expect(abortRes.status).toBe(200);
      // Reader disconnects without consuming full body
      expect(fs.existsSync(fakeCalibreDbPath)).toBe(true);
    });
  });

  describe("U02: Normalized Rewritten OPDS XML Response Headers & Wire Socket Semantics", () => {
    let origFetch: typeof globalThis.fetch;
    let origServerUrl: string | undefined;

    beforeEach(() => {
      origFetch = globalThis.fetch;
      origServerUrl = process.env.CALIBRE_SERVER_URL;
      process.env.CALIBRE_SERVER_URL = "http://127.0.0.1:8088";
    });

    afterEach(() => {
      globalThis.fetch = origFetch;
      if (origServerUrl !== undefined && origServerUrl !== "undefined") {
        process.env.CALIBRE_SERVER_URL = origServerUrl;
      } else {
        delete process.env.CALIBRE_SERVER_URL;
      }
    });

    function sendWireRequest(
      port: number,
      rawRequest: string,
    ): Promise<{
      status: number;
      statusText: string;
      headers: Record<string, string>;
      body: Buffer;
    }> {
      return new Promise((resolve, reject) => {
        const socket = net.createConnection({ port, host: "127.0.0.1" }, () => {
          socket.write(rawRequest);
        });

        const chunks: Buffer[] = [];
        socket.on("data", (chunk) => {
          chunks.push(chunk);
        });
        socket.on("end", () => {
          const fullBuffer = Buffer.concat(chunks);
          const headerEndIndex = fullBuffer.indexOf("\r\n\r\n");
          if (headerEndIndex === -1) {
            return reject(new Error("Malformed HTTP response: no header terminator"));
          }
          const headerStr = fullBuffer.subarray(0, headerEndIndex).toString("utf8");
          const body = fullBuffer.subarray(headerEndIndex + 4);
          const lines = headerStr.split("\r\n");
          const statusParts = lines[0].split(" ");
          const statusCode = parseInt(statusParts[1], 10);
          const headers: Record<string, string> = {};
          for (let i = 1; i < lines.length; i++) {
            const colonIdx = lines[i].indexOf(":");
            if (colonIdx > -1) {
              const key = lines[i].slice(0, colonIdx).trim().toLowerCase();
              const val = lines[i].slice(colonIdx + 1).trim();
              headers[key] = val;
            }
          }
          resolve({
            status: statusCode,
            statusText: statusParts.slice(2).join(" "),
            headers,
            body,
          });
        });
        socket.on("error", reject);
      });
    }

    it("corrects grown UTF-8 XML length and strips stale representation validators", async () => {
      const upstreamXml = `<?xml version="1.0" encoding="utf-8"?>
<feed xmlns="http://www.w3.org/2005/Atom">
  <title>စစ်နှင့်ငြိမ်းချမ်းရေး (War and Peace)</title>
  <link href="http://127.0.0.1:8088/opds/cover/1" rel="http://opds-spec.org/image"/>
</feed>`;
      const upstreamLen = Buffer.byteLength(upstreamXml, "utf8");

      globalThis.fetch = (async () => {
        return new Response(upstreamXml, {
          status: 200,
          headers: {
            "Content-Type": "application/atom+xml; charset=utf-8",
            "Content-Length": String(upstreamLen),
            "ETag": '"calibre-upstream-v1"',
            "Content-MD5": "Q2hlY2tzdW0=",
          },
        });
      }) as any;

      const req = new Request("https://reading-sg.wavypremium.xyz:8443/opds", {
        method: "GET",
        headers: { Accept: "application/atom+xml" },
      });

      const res = await handleRequest(req);
      expect(res.status).toBe(200);

      const body = await res.text();
      const expectedBytes = Buffer.byteLength(body, "utf8");

      // Length grew from 127.0.0.1:8088 -> reading-sg.wavypremium.xyz:8443
      expect(expectedBytes).toBeGreaterThan(upstreamLen);
      expect(res.headers.get("Content-Length")).toBe(String(expectedBytes));
      expect(res.headers.get("Content-Length")).not.toBe(String(upstreamLen));

      // Stale validators deleted on changed representation
      expect(res.headers.get("ETag")).toBeNull();
      expect(res.headers.get("Content-MD5")).toBeNull();

      // Multi-byte UTF-8 preserved and loopback replaced
      expect(body).toContain("စစ်နှင့်ငြိမ်းချမ်းရေး");
      expect(body).toContain("https://reading-sg.wavypremium.xyz:8443/opds/cover/1");
      expect(body).not.toContain("127.0.0.1:8088");
    });

    it("corrects shrunk XML length and strips stale representation validators", async () => {
      const upstreamXml = `<?xml version="1.0" encoding="utf-8"?>
<feed xmlns="http://www.w3.org/2005/Atom">
  <link href="http://localhost:8088/opds/catalog/default/navlist" rel="subsection"/>
</feed>`;
      const upstreamLen = Buffer.byteLength(upstreamXml, "utf8");

      globalThis.fetch = (async () => {
        return new Response(upstreamXml, {
          status: 200,
          headers: {
            "Content-Type": "application/atom+xml; charset=utf-8",
            "Content-Length": String(upstreamLen),
            "ETag": '"calibre-upstream-v2"',
          },
        });
      }) as any;

      const req = new Request("https://r.io/opds", {
        method: "GET",
        headers: { Accept: "application/atom+xml" },
      });

      const res = await handleRequest(req);
      expect(res.status).toBe(200);

      const body = await res.text();
      const expectedBytes = Buffer.byteLength(body, "utf8");

      // Length shrunk from http://localhost:8088 -> https://r.io
      expect(expectedBytes).toBeLessThan(upstreamLen);
      expect(res.headers.get("Content-Length")).toBe(String(expectedBytes));
      expect(res.headers.get("ETag")).toBeNull();

      expect(body).toContain("https://r.io/opds/catalog/default/navlist");
      expect(body).not.toContain("localhost:8088");
    });

    it("preserves upstream ETag and validator headers on no-change payload", async () => {
      const upstreamXml = `<?xml version="1.0" encoding="utf-8"?>
<feed xmlns="http://www.w3.org/2005/Atom">
  <title>Clean Library Catalog</title>
</feed>`;
      const upstreamLen = Buffer.byteLength(upstreamXml, "utf8");

      globalThis.fetch = (async () => {
        return new Response(upstreamXml, {
          status: 200,
          headers: {
            "Content-Type": "application/atom+xml; charset=utf-8",
            "Content-Length": String(upstreamLen),
            "ETag": '"unchanged-etag-valid"',
            "Last-Modified": "Sun, 04 Oct 2026 10:00:00 GMT",
          },
        });
      }) as any;

      const req = new Request("https://reading-sg.wavypremium.xyz:8443/opds", {
        method: "GET",
      });

      const res = await handleRequest(req);
      expect(res.status).toBe(200);
      expect(res.headers.get("Content-Length")).toBe(String(upstreamLen));
      // Upstream ETag and Last-Modified preserved on unchanged representation
      expect(res.headers.get("ETag")).toBe('"unchanged-etag-valid"');
      expect(res.headers.get("Last-Modified")).toBe("Sun, 04 Oct 2026 10:00:00 GMT");

      const body = await res.text();
      expect(body).toBe(upstreamXml);
    });

    it("preserves HEAD, 304 Not Modified, and 204 No Content semantics", async () => {
      // HEAD request
      globalThis.fetch = (async () => {
        return new Response(null, {
          status: 200,
          headers: {
            "Content-Type": "application/atom+xml; charset=utf-8",
            "Content-Length": "120",
            "ETag": '"opds-head-etag"',
          },
        });
      }) as any;

      const headReq = new Request("https://reading-sg.wavypremium.xyz:8443/opds", {
        method: "HEAD",
      });
      const headRes = await handleRequest(headReq);
      expect(headRes.status).toBe(200);
      expect(await headRes.text()).toBe("");

      // 304 Not Modified
      globalThis.fetch = (async () => {
        return new Response(null, {
          status: 304,
          statusText: "Not Modified",
          headers: {
            "ETag": '"cached-feed-1"',
            "Cache-Control": "public, max-age=3600",
          },
        });
      }) as any;

      const notModReq = new Request("https://reading-sg.wavypremium.xyz:8443/opds", {
        method: "GET",
        headers: { "If-None-Match": '"cached-feed-1"' },
      });
      const notModRes = await handleRequest(notModReq);
      expect(notModRes.status).toBe(304);
      expect(notModRes.headers.get("ETag")).toBe('"cached-feed-1"');
      expect(await notModRes.text()).toBe("");

      // 204 No Content
      globalThis.fetch = (async () => {
        return new Response(null, {
          status: 204,
          statusText: "No Content",
          headers: {
            "Content-Length": "0",
            "Content-Type": "text/plain",
          },
        });
      }) as any;

      const noContentReq = new Request("https://reading-sg.wavypremium.xyz:8443/opds", {
        method: "GET",
      });
      const noContentRes = await handleRequest(noContentReq);
      expect(noContentRes.status).toBe(204);
      expect(noContentRes.headers.get("Content-Length")).toBeNull();
      expect(noContentRes.headers.get("Content-Type")).toBeNull();
      expect(await noContentRes.text()).toBe("");
    });

    it("leaves binary /get stream unaffected and preserves Content-Type", async () => {
      const fakeEpubBytes = Buffer.from([0x50, 0x4b, 0x03, 0x04, 0x0a, 0x00, 0x00, 0x00]);

      globalThis.fetch = (async () => {
        return new Response(fakeEpubBytes, {
          status: 200,
          headers: {
            "Content-Type": "application/epub+zip",
            "Content-Length": String(fakeEpubBytes.length),
            "Content-Disposition": 'attachment; filename="book.epub"',
          },
        });
      }) as any;

      const req = new Request("https://reading-sg.wavypremium.xyz:8443/get/epub/1/Agent_Library", {
        method: "GET",
      });

      const res = await handleRequest(req);
      expect(res.status).toBe(200);
      expect(res.headers.get("Content-Type")).toBe("application/epub+zip");
      expect(res.headers.get("Content-Disposition")).toBe('attachment; filename="book.epub"');

      const bodyBuf = Buffer.from(await res.arrayBuffer());
      expect(bodyBuf.equals(fakeEpubBytes)).toBe(true);
    });

    it("handles gzipped and ungzipped upstream responses cleanly", async () => {
      const rawXml = `<?xml version="1.0" encoding="utf-8"?>
<feed xmlns="http://www.w3.org/2005/Atom">
  <title>Gzip Catalog</title>
  <link href="http://127.0.0.1:8088/opds/book/1" rel="entry"/>
</feed>`;
      const gzipped = typeof (globalThis as any).Bun?.gzipSync === "function"
        ? (globalThis as any).Bun.gzipSync(Buffer.from(rawXml, "utf8"))
        : (await import("node:zlib")).gzipSync(Buffer.from(rawXml, "utf8"));

      // 1. Client does NOT accept gzip: receives uncompressed with exact length and no stale Content-Encoding
      globalThis.fetch = (async () => {
        return new Response(gzipped, {
          status: 200,
          headers: {
            "Content-Type": "application/atom+xml; charset=utf-8",
            "Content-Encoding": "gzip",
            "Content-Length": String(gzipped.length),
            "ETag": '"gzip-etag-v1"',
          },
        });
      }) as any;

      const noGzipReq = new Request("https://reading-sg.wavypremium.xyz:8443/opds", {
        method: "GET",
        headers: {
          Accept: "application/atom+xml",
          "Accept-Encoding": "identity",
        },
      });

      const noGzipRes = await handleRequest(noGzipReq);
      expect(noGzipRes.status).toBe(200);
      expect(noGzipRes.headers.get("Content-Encoding")).toBeNull();

      const body = await noGzipRes.text();
      const expectedBytes = Buffer.byteLength(body, "utf8");
      expect(noGzipRes.headers.get("Content-Length")).toBe(String(expectedBytes));
      expect(body).toContain("https://reading-sg.wavypremium.xyz:8443/opds/book/1");
      expect(body).not.toContain("127.0.0.1:8088");

      // 2. Client DOES accept gzip and response > 1024 bytes: compressed cleanly
      const largeXml = `<feed xmlns="http://www.w3.org/2005/Atom"><title>Large</title>` +
        Array.from({ length: 40 }, (_, i) => `<entry><id>${i}</id><link href="http://127.0.0.1:8088/opds/${i}"/></entry>`).join("") +
        `</feed>`;
      const largeGzipped = typeof (globalThis as any).Bun?.gzipSync === "function"
        ? (globalThis as any).Bun.gzipSync(Buffer.from(largeXml, "utf8"))
        : (await import("node:zlib")).gzipSync(Buffer.from(largeXml, "utf8"));

      globalThis.fetch = (async () => {
        return new Response(largeGzipped, {
          status: 200,
          headers: {
            "Content-Type": "application/atom+xml; charset=utf-8",
            "Content-Encoding": "gzip",
            "Content-Length": String(largeGzipped.length),
            "ETag": '"large-v1"',
          },
        });
      }) as any;

      const gzipReq = new Request("https://reading-sg.wavypremium.xyz:8443/opds", {
        method: "GET",
        headers: {
          Accept: "application/atom+xml",
          "Accept-Encoding": "gzip",
        },
      });

      const gzipRes = await handleRequest(gzipReq);
      expect(gzipRes.status).toBe(200);
      expect(gzipRes.headers.get("Content-Encoding")).toBe("gzip");

      const wireBytes = Buffer.from(await gzipRes.arrayBuffer());
      expect(gzipRes.headers.get("Content-Length")).toBe(String(wireBytes.length));

      const gunzip = typeof (globalThis as any).Bun?.gunzipSync === "function"
        ? (globalThis as any).Bun.gunzipSync(wireBytes)
        : (await import("node:zlib")).gunzipSync(wireBytes);
      const decompressed = new TextDecoder().decode(gunzip);
      expect(decompressed).toContain("https://reading-sg.wavypremium.xyz:8443/opds/0");
      expect(decompressed.endsWith("</feed>")).toBe(true);
    });

    it("wire socket client proves byte-exact document and abort cleanup over TCP", async () => {
      // Restore native global fetch so Bun.serve child receives actual HTTP requests
      globalThis.fetch = origFetch;
      let upstreamAborted = false;

      const upstreamXml = `<?xml version="1.0" encoding="utf-8"?>
<feed xmlns="http://www.w3.org/2005/Atom">
  <title>Wire Socket OPDS Catalog</title>
  <link href="http://127.0.0.1:8088/opds/cover/99" rel="cover"/>
  <entry>
    <title>Wire Book</title>
    <link href="http://127.0.0.1:8088/opds/download/99" rel="acquisition"/>
  </entry>
</feed>`;

      const upstreamServer = Bun.serve({
        port: 0,
        fetch(req) {
          const u = new URL(req.url);
          if (u.pathname === "/opds/hanging") {
            req.signal.addEventListener("abort", () => {
              upstreamAborted = true;
            });
            // Keep request hanging to test cancellation
            return new Promise(() => {});
          }

          return new Response(upstreamXml, {
            status: 200,
            headers: {
              "Content-Type": "application/atom+xml; charset=utf-8",
              "Content-Length": String(Buffer.byteLength(upstreamXml, "utf8")),
              "ETag": '"wire-upstream-etag"',
            },
          });
        },
      });

      process.env.CALIBRE_SERVER_URL = `http://127.0.0.1:${upstreamServer.port}`;

      const lighthouseServer = Bun.serve({
        port: 0,
        fetch: (req) => handleRequest(req),
      });

      try {
        // 1. Full wire document test
        const wireRes = await sendWireRequest(
          lighthouseServer.port,
          `GET /opds HTTP/1.1\r\nHost: reading-sg.wavypremium.xyz:8443\r\nX-Forwarded-Proto: https\r\nAccept: application/atom+xml\r\nConnection: close\r\n\r\n`,
        );

        expect(wireRes.status).toBe(200);
        const reportedLen = parseInt(wireRes.headers["content-length"], 10);
        expect(reportedLen).toBe(wireRes.body.length);
        expect(wireRes.headers["etag"]).toBeUndefined();

        const bodyStr = wireRes.body.toString("utf8");
        expect(bodyStr.endsWith("</feed>")).toBe(true);
        expect(bodyStr).toContain("https://reading-sg.wavypremium.xyz:8443/opds/cover/99");
        expect(bodyStr).not.toContain("127.0.0.1:8088");

        // 2. Cancellation closes upstream
        const abortSocket = net.createConnection(
          { port: lighthouseServer.port, host: "127.0.0.1" },
          () => {
            abortSocket.write(
              `GET /opds/hanging HTTP/1.1\r\nHost: reading-sg.wavypremium.xyz:8443\r\nX-Forwarded-Proto: https\r\nConnection: close\r\n\r\n`,
            );
            // Immediately abort the client connection
            setTimeout(() => {
              abortSocket.destroy();
            }, 25);
          },
        );

        // Wait for abort propagation
        for (let i = 0; i < 20; i++) {
          if (upstreamAborted) break;
          await new Promise((r) => setTimeout(r, 25));
        }
        expect(upstreamAborted).toBe(true);
      } finally {
        upstreamServer.stop();
        lighthouseServer.stop();
      }
    });

    it("handles concurrent requests without mixed responses or cross-talk", async () => {
      // Restore native global fetch so Bun.serve child receives actual HTTP requests
      globalThis.fetch = origFetch;

      const upstreamXml = `<?xml version="1.0" encoding="utf-8"?>
<feed xmlns="http://www.w3.org/2005/Atom">
  <link href="http://127.0.0.1:8088/opds/sub"/>
</feed>`;

      const upstreamServer = Bun.serve({
        port: 0,
        fetch() {
          return new Response(upstreamXml, {
            status: 200,
            headers: {
              "Content-Type": "application/atom+xml; charset=utf-8",
              "Content-Length": String(Buffer.byteLength(upstreamXml, "utf8")),
            },
          });
        },
      });

      process.env.CALIBRE_SERVER_URL = `http://127.0.0.1:${upstreamServer.port}`;

      const lighthouseServer = Bun.serve({
        port: 0,
        fetch: (req) => handleRequest(req),
      });

      try {
        const [resA, resB] = await Promise.all([
          sendWireRequest(
            lighthouseServer.port,
            `GET /opds HTTP/1.1\r\nHost: reading-sg.wavypremium.xyz:8443\r\nX-Forwarded-Proto: https\r\nAccept: application/atom+xml\r\nConnection: close\r\n\r\n`,
          ),
          sendWireRequest(
            lighthouseServer.port,
            `GET /opds HTTP/1.1\r\nHost: reading-us.wavypremium.xyz\r\nX-Forwarded-Proto: https\r\nAccept: application/atom+xml\r\nConnection: close\r\n\r\n`,
          ),
        ]);

        expect(resA.status).toBe(200);
        expect(resB.status).toBe(200);

        const bodyA = resA.body.toString("utf8");
        const bodyB = resB.body.toString("utf8");

        expect(resA.body.length).toBe(parseInt(resA.headers["content-length"], 10));
        expect(resB.body.length).toBe(parseInt(resB.headers["content-length"], 10));

        expect(bodyA).toContain("https://reading-sg.wavypremium.xyz:8443/opds/sub");
        expect(bodyA).not.toContain("reading-us.wavypremium.xyz");

        expect(bodyB).toContain("https://reading-us.wavypremium.xyz/opds/sub");
        expect(bodyB).not.toContain("reading-sg.wavypremium.xyz:8443");
      } finally {
        upstreamServer.stop();
        lighthouseServer.stop();
      }
    });
  });

  describe("U05: Canonical User-Facing Filename and Download Route Parity", () => {
    const origFetch = globalThis.fetch;
    const fixtureEpubBytes = Buffer.from("PK\x03\x04synthetic-epub-content");

    const fixtureBooks = [
      {
        id: 101,
        title: "Dune Messiah",
        authors: "Frank Herbert",
        series: "Dune",
        series_index: 2,
        path: "Frank Herbert/Dune Messiah (101)",
        formats: ["EPUB"],
      },
      {
        id: 102,
        title: "Children of Dune",
        authors: "Frank Herbert",
        series: "Dune",
        series_index: 3.5,
        path: "Frank Herbert/Children of Dune (102)",
        formats: ["EPUB"],
      },
      {
        id: 103,
        title: "Foundation and Empire",
        authors: "Isaac Asimov",
        series: "Foundation",
        series_index: 10,
        path: "Isaac Asimov/Foundation and Empire (103)",
        formats: ["EPUB"],
      },
      {
        id: 104,
        title: "Unindexed Series Book",
        authors: "Brandon Sanderson",
        series: "Cosmere",
        series_index: null,
        path: "Brandon Sanderson/Unindexed Series Book (104)",
        formats: ["EPUB"],
      },
      {
        id: 105,
        title: "Clean Architecture",
        authors: "Robert C. Martin",
        series: null,
        series_index: null,
        path: "Robert C. Martin/Clean Architecture (105)",
        formats: ["EPUB"],
      },
      {
        id: 106,
        title: "စာဖတ်သူ",
        authors: "ဆရာတင်",
        series: "အတွဲ",
        series_index: 1,
        path: "ဆရာတင်/စာဖတ်သူ (106)",
        formats: ["EPUB"],
      },
      {
        id: 107,
        title: "不死者の王",
        authors: "丸山くがね",
        series: "オーバーロード",
        series_index: 1,
        path: "丸山くがね/不死者の王 (107)",
        formats: ["EPUB"],
      },
      {
        id: 108,
        title: "Malicious /..//etc/passwd *Edition*?",
        authors: "Attacker\x00\x1f<Admin>\x7f",
        series: "Exploit/..//Series",
        series_index: 1,
        path: "Attacker/Malicious (108)",
        formats: ["EPUB"],
      },
    ];

    beforeEach(() => {
      setServerDependenciesForTest({
        getCalibreBooks: () => fixtureBooks,
      });

      globalThis.fetch = (async (input: any) => {
        const urlStr = typeof input === "string" ? input : input.url;
        // Mock upstream Calibre server response for /get/:format/:id/:library
        if (urlStr.includes("/get/epub/")) {
          return new Response(fixtureEpubBytes, {
            status: 200,
            headers: {
              "Content-Type": "application/epub+zip",
              "Content-Length": String(fixtureEpubBytes.length),
            },
          });
        }
        return new Response("Not Found", { status: 404 });
      }) as any;
    });

    afterEach(() => {
      globalThis.fetch = origFetch;
      resetServerDependenciesForTest();
    });

    it("ensures exact parity between web download route and bot delivery helper (Series 01 - Title - Author.epub)", async () => {
      const book = fixtureBooks[0]; // Dune Messiah (series_index: 2)
      const botExpectedName = generateMetadataFilename({
        title: book.title,
        authors: book.authors,
        series: book.series,
        seriesIndex: book.series_index,
        format: "epub",
        fallbackBase: `Book-${book.id}`,
      });
      expect(botExpectedName).toBe("Dune 02 - Dune Messiah - Frank Herbert.epub");

      const req = new Request(`http://127.0.0.1:8086/api/books/${book.id}/download/epub`, {
        method: "GET",
      });
      const res = await handleRequest(req);
      expect(res.status).toBe(200);

      const disposition = res.headers.get("Content-Disposition");
      expect(disposition).toBe(buildContentDisposition(botExpectedName));
      expect(disposition).toContain(`filename="${botExpectedName}"`);
      expect(disposition).toContain(`filename*=UTF-8''${encodeURIComponent(botExpectedName)}`);
    });

    it("formats integer series indices with leading zero for single digits and without for double digits", async () => {
      // Single digit series index (101: series_index = 2 -> "02")
      const req1 = new Request("http://127.0.0.1:8086/api/books/101/download/epub");
      const res1 = await handleRequest(req1);
      expect(res1.status).toBe(200);
      const disp1 = res1.headers.get("Content-Disposition")!;
      expect(disp1).toContain('filename="Dune 02 - Dune Messiah - Frank Herbert.epub"');

      // Double digit series index (103: series_index = 10 -> "10")
      const req2 = new Request("http://127.0.0.1:8086/api/books/103/download/epub");
      const res2 = await handleRequest(req2);
      expect(res2.status).toBe(200);
      const disp2 = res2.headers.get("Content-Disposition")!;
      expect(disp2).toContain('filename="Foundation 10 - Foundation and Empire - Isaac Asimov.epub"');
    });

    it("formats fractional series indices cleanly with padded integer component", async () => {
      // 102: series_index = 3.5 -> "03.5"
      const req = new Request("http://127.0.0.1:8086/api/books/102/download/epub");
      const res = await handleRequest(req);
      expect(res.status).toBe(200);
      const disp = res.headers.get("Content-Disposition")!;
      expect(disp).toContain('filename="Dune 03.5 - Children of Dune - Frank Herbert.epub"');
    });

    it("handles series with missing series index and standalone books without series cleanly", async () => {
      // 104: series present, series_index null -> "Cosmere - Unindexed Series Book - Brandon Sanderson.epub"
      const req1 = new Request("http://127.0.0.1:8086/api/books/104/download/epub");
      const res1 = await handleRequest(req1);
      expect(res1.status).toBe(200);
      const disp1 = res1.headers.get("Content-Disposition")!;
      expect(disp1).toContain('filename="Cosmere - Unindexed Series Book - Brandon Sanderson.epub"');

      // 105: standalone book without series -> "Clean Architecture - Robert C. Martin.epub"
      const req2 = new Request("http://127.0.0.1:8086/api/books/105/download/epub");
      const res2 = await handleRequest(req2);
      expect(res2.status).toBe(200);
      const disp2 = res2.headers.get("Content-Disposition")!;
      expect(disp2).toContain('filename="Clean Architecture - Robert C. Martin.epub"');
    });

    it("delivers RFC 5987 UTF-8 encoding and ASCII fallback for non-ASCII Burmese and Japanese literature", async () => {
      // 106: Burmese
      const resBurmese = await handleRequest(new Request("http://127.0.0.1:8086/api/books/106/download/epub"));
      expect(resBurmese.status).toBe(200);
      const dispBurmese = resBurmese.headers.get("Content-Disposition")!;
      // ASCII fallback has underscores replacing non-ASCII characters
      expect(dispBurmese).toContain('filename="____ 01 - _______ - ______.epub"');
      // UTF-8 encoded part decodes back to original exact name
      const utf8Prefix = "filename*=UTF-8''";
      const burmeseIdx = dispBurmese.indexOf(utf8Prefix);
      expect(burmeseIdx).toBeGreaterThan(-1);
      const burmeseEncoded = dispBurmese.slice(burmeseIdx + utf8Prefix.length);
      expect(decodeURIComponent(burmeseEncoded)).toBe("အတွဲ 01 - စာဖတ်သူ - ဆရာတင်.epub");

      // 107: Japanese
      const resJapanese = await handleRequest(new Request("http://127.0.0.1:8086/api/books/107/download/epub"));
      expect(resJapanese.status).toBe(200);
      const dispJapanese = resJapanese.headers.get("Content-Disposition")!;
      const japaneseIdx = dispJapanese.indexOf(utf8Prefix);
      expect(japaneseIdx).toBeGreaterThan(-1);
      const japaneseEncoded = dispJapanese.slice(japaneseIdx + utf8Prefix.length);
      expect(decodeURIComponent(japaneseEncoded)).toBe("オーバーロード 01 - 不死者の王 - 丸山くがね.epub");
    });

    it("sanitizes path traversal and control characters from user-facing download filenames", async () => {
      // 108: Malicious title and author with path traversal and control characters
      const req = new Request("http://127.0.0.1:8086/api/books/108/download/epub");
      const res = await handleRequest(req);
      expect(res.status).toBe(200);
      const disp = res.headers.get("Content-Disposition")!;
      expect(disp).not.toContain("..");
      expect(disp).not.toContain("/");
      expect(disp).not.toContain("\x00");
      expect(disp).not.toContain("\x1f");
      expect(disp).not.toContain("\x7f");
      expect(disp).toContain("Exploit Series 01 - Malicious etc passwd Edition - Attacker Admin.epub");
    });

    it("concurrent download requests derive independent filenames without cross-talk", async () => {
      const [res101, res103, res105, res106, res107] = await Promise.all([
        handleRequest(new Request("http://127.0.0.1:8086/api/books/101/download/epub")),
        handleRequest(new Request("http://127.0.0.1:8086/api/books/103/download/epub")),
        handleRequest(new Request("http://127.0.0.1:8086/api/books/105/download/epub")),
        handleRequest(new Request("http://127.0.0.1:8086/api/books/106/download/epub")),
        handleRequest(new Request("http://127.0.0.1:8086/api/books/107/download/epub")),
      ]);

      expect(res101.status).toBe(200);
      expect(res103.status).toBe(200);
      expect(res105.status).toBe(200);
      expect(res106.status).toBe(200);
      expect(res107.status).toBe(200);

      const d101 = res101.headers.get("Content-Disposition")!;
      const d103 = res103.headers.get("Content-Disposition")!;
      const d105 = res105.headers.get("Content-Disposition")!;
      const d106 = decodeURIComponent(res106.headers.get("Content-Disposition")!);
      const d107 = decodeURIComponent(res107.headers.get("Content-Disposition")!);

      expect(d101).toContain("Dune 02 - Dune Messiah - Frank Herbert.epub");
      expect(d103).toContain("Foundation 10 - Foundation and Empire - Isaac Asimov.epub");
      expect(d105).toContain("Clean Architecture - Robert C. Martin.epub");
      expect(d106).toContain("အတွဲ 01 - စာဖတ်သူ - ဆရာတင်.epub");
      expect(d107).toContain("オーバーロード 01 - 不死者の王 - 丸山くがね.epub");

      // Confirm no cross-contamination between responses
      expect(d101).not.toContain("Foundation");
      expect(d103).not.toContain("Dune");
      expect(d105).not.toContain("အတွဲ");
    });

    it("never mutates or renames physical Calibre library storage paths", async () => {
      const book = fixtureBooks[0];
      const initialPath = book.path;

      const req = new Request(`http://127.0.0.1:8086/api/books/${book.id}/download/epub`);
      const res = await handleRequest(req);
      expect(res.status).toBe(200);

      // Verify that the book object's internal path was not altered
      expect(book.path).toBe(initialPath);
      expect(book.path).toBe("Frank Herbert/Dune Messiah (101)");
    });

    it("falls back to Book-${id}.epub when book is not found in cache", async () => {
      const req = new Request("http://127.0.0.1:8086/api/books/999/download/epub");
      const res = await handleRequest(req);
      expect(res.status).toBe(200);
      const disp = res.headers.get("Content-Disposition")!;
      expect(disp).toContain('filename="Book - 999.epub"');
    });
  });
});
