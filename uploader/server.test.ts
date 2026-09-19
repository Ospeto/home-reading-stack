import { describe, expect, it } from "bun:test";
import { handleRequest } from "./server";

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
});
