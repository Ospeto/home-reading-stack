import { describe, expect, it } from "bun:test";
import {
  handleRequest,
  validateAndCanonicalizeProxyPath,
  setServerDependenciesForTest,
  resetServerDependenciesForTest,
} from "./server";
import { validateUrlForSSRF } from "./security";

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

    it("blocks unauthenticated WAN requests with 401", async () => {
      const req = new Request("http://127.0.0.1:8086/api/lnori/ingest", {
        method: "POST",
        headers: {
          host: "reading.wavypremium.xyz",
          origin: "https://reading.wavypremium.xyz",
          "content-type": "application/json",
        },
        body: JSON.stringify({ url: "https://lnori.com/series/8046" }),
      });
      const res = await handleRequest(req);
      expect(res.status).toBe(401);
      const data = (await res.json()) as any;
      expect(data.success).toBe(false);
      expect(data.error).toContain("Authentication required");
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
  });
});
