import { describe, expect, it, beforeEach, afterEach } from "bun:test";
import { Database } from "bun:sqlite";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import {
  handleRequest,
  validateAndCanonicalizeProxyPath,
  setServerDependenciesForTest,
  resetServerDependenciesForTest,
  resetActiveLnoriStateForTest,
  ingestBookFile,
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
});
