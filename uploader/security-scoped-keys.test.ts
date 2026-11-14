import { describe, expect, it, afterEach } from "bun:test";
import {
  authenticateRequest,
  parseScopedKeys,
  resolveScopedKeys,
  resetScopedKeyCacheForTest,
  normalizeScope,
  scopeSatisfies,
  requiredScopeForRequest,
  describeScope,
  isAdminRoute,
  apiResourceForPath,
  secretsMatch,
  matchScopedKey,
  FULL_ACCESS_SCOPES,
  type ScopedApiKey,
} from "./security";

const WAN_HOST = "reading.wavypremium.xyz";

/** Builds a request that classifies as WAN (host-based, no verified socket peer). */
function wanRequest(
  path: string,
  init: RequestInit & { headers?: Record<string, string> } = {},
): Request {
  return new Request(`http://127.0.0.1:8086${path}`, {
    ...init,
    headers: { host: WAN_HOST, ...(init.headers || {}) },
  });
}

const READ_ONLY: ScopedApiKey[] = [
  { name: "koreader-read", key: "ro-secret-123", scopes: ["read"] },
];
const WRITE_KEY: ScopedApiKey[] = [
  { name: "ci-writer", key: "rw-secret-456", scopes: ["write"] },
];
const ADMIN_KEY: ScopedApiKey[] = [
  { name: "ops-admin", key: "admin-secret-789", scopes: ["admin"] },
];

describe("Scoped API keys — configuration parsing", () => {
  it("parses the JSON object form", () => {
    const keys = parseScopedKeys(
      JSON.stringify({
        "koreader-read": { key: "ro-secret", scopes: ["read"] },
        "ci-writer": { key: "rw-secret", scopes: "write,books:read" },
      }),
    );
    expect(keys).toHaveLength(2);
    expect(keys[0]).toEqual({
      name: "koreader-read",
      key: "ro-secret",
      scopes: ["read"],
    });
    expect(keys[1]?.scopes).toEqual(["write", "books:read"]);
  });

  it("parses the JSON array form and the JSON shorthand form", () => {
    const arrayForm = parseScopedKeys(
      JSON.stringify([
        { name: "ci", key: "s3cr3t", scopes: ["read"] },
        { name: "ops", key: "s3cr3t2", scopes: ["admin"] },
      ]),
    );
    expect(arrayForm.map((k) => k.name)).toEqual(["ci", "ops"]);

    const shorthand = parseScopedKeys(JSON.stringify({ ci: "shorthand-1:read" }));
    expect(shorthand).toEqual([
      { name: "ci", key: "shorthand-1", scopes: ["read"] },
    ]);
  });

  it("parses the compact environment form with and without a label", () => {
    const keys = parseScopedKeys(
      "koreader-read=ro-secret:read;ci-writer=rw-secret:write,books:read\nunlabelled-secret:read,kosync:read",
    );
    expect(keys).toHaveLength(3);
    expect(keys[0]).toEqual({
      name: "koreader-read",
      key: "ro-secret",
      scopes: ["read"],
    });
    expect(keys[1]?.scopes).toEqual(["write", "books:read"]);
    expect(keys[2]?.name).toBe("scoped-3");
    expect(keys[2]?.scopes).toEqual(["read", "kosync:read"]);
  });

  it("drops entries with no valid scope and malformed entries, never widening access", () => {
    const keys = parseScopedKeys(
      "broken-no-colon;no-scopes=secret:;bad-scope=secret2:superuser",
    );
    expect(keys).toEqual([]);
  });

  it("keeps the first definition when a secret is configured twice", () => {
    const keys = parseScopedKeys("first=dup-secret:read;second=dup-secret:admin");
    expect(keys).toHaveLength(1);
    expect(keys[0]?.name).toBe("first");
    expect(keys[0]?.scopes).toEqual(["read"]);
  });

  it("returns an empty registry for missing or invalid configuration", () => {
    expect(parseScopedKeys("")).toEqual([]);
    expect(parseScopedKeys(undefined)).toEqual([]);
    expect(parseScopedKeys("   ")).toEqual([]);
    expect(parseScopedKeys("{not-json")).toEqual([]);
  });

  it("resolves the registry from the environment and caches per value", () => {
    resetScopedKeyCacheForTest();
    const first = resolveScopedKeys(undefined, {
      READING_SCOPED_KEYS: "ci=env-secret:read",
    });
    expect(first).toHaveLength(1);
    expect(first[0]?.key).toBe("env-secret");

    // Same raw value returns the cached registry object.
    const cached = resolveScopedKeys(undefined, {
      READING_SCOPED_KEYS: "ci=env-secret:read",
    });
    expect(cached).toBe(first);

    // A changed value re-parses.
    const reparsed = resolveScopedKeys(undefined, {
      READING_SCOPED_KEYS: "ci=env-secret-2:write",
    });
    expect(reparsed[0]?.key).toBe("env-secret-2");
    resetScopedKeyCacheForTest();
  });

  it("accepts an explicit registry array", () => {
    expect(resolveScopedKeys(READ_ONLY)).toBe(READ_ONLY);
  });
});

describe("Scoped API keys — scope vocabulary", () => {
  it("normalizes known scopes and rejects unknown ones", () => {
    expect(normalizeScope("*")).toBe("*");
    expect(normalizeScope("all")).toBe("*");
    expect(normalizeScope("READ")).toBe("read");
    expect(normalizeScope("Admin")).toBe("admin");
    expect(normalizeScope("books:WRITE")).toBe("books:write");
    expect(normalizeScope("  read  ")).toBe("read");
    expect(normalizeScope("books")).toBe("");
    expect(normalizeScope("books:delete")).toBe("");
    expect(normalizeScope("")).toBe("");
  });

  it("treats wildcard and admin scopes as unrestricted", () => {
    for (const scope of ["*", "admin"]) {
      expect(scopeSatisfies([scope], { action: "read" })).toBe(true);
      expect(scopeSatisfies([scope], { action: "write" })).toBe(true);
      expect(scopeSatisfies([scope], { action: "admin" })).toBe(true);
    }
    expect(scopeSatisfies(FULL_ACCESS_SCOPES, { action: "admin" })).toBe(true);
  });

  it("lets write imply read but never admin", () => {
    expect(scopeSatisfies(["write"], { action: "read" })).toBe(true);
    expect(scopeSatisfies(["write"], { action: "write" })).toBe(true);
    expect(scopeSatisfies(["write"], { action: "admin" })).toBe(false);
    expect(scopeSatisfies(["read"], { action: "write" })).toBe(false);
    expect(scopeSatisfies(["read"], { action: "admin" })).toBe(false);
  });

  it("confines resource-qualified scopes to their resource", () => {
    const books = { action: "read" as const, resource: "books" };
    expect(scopeSatisfies(["books:read"], books)).toBe(true);
    expect(scopeSatisfies(["books:write"], books)).toBe(true);
    expect(scopeSatisfies(["kosync:read"], books)).toBe(false);
    expect(scopeSatisfies(["books:read"], { action: "read", resource: "kosync" })).toBe(
      false,
    );
    // A resource-qualified scope never covers an unqualified route.
    expect(scopeSatisfies(["books:read"], { action: "read" })).toBe(false);
  });

  it("denies everything for an empty or missing scope list", () => {
    expect(scopeSatisfies([], { action: "read" })).toBe(false);
    expect(scopeSatisfies(undefined, { action: "read" })).toBe(false);
    expect(scopeSatisfies(["bogus"], { action: "read" })).toBe(false);
  });

  it("compares secrets in constant time and tolerates length mismatch", () => {
    expect(secretsMatch("same-secret", "same-secret")).toBe(true);
    expect(secretsMatch("same-secret", "other-secret")).toBe(false);
    expect(secretsMatch("short", "much-longer-secret")).toBe(false);
    expect(secretsMatch("", "anything")).toBe(false);
    expect(secretsMatch("anything", "")).toBe(false);
  });

  it("matches scoped keys by secret", () => {
    expect(matchScopedKey(READ_ONLY, "ro-secret-123")?.name).toBe("koreader-read");
    expect(matchScopedKey(READ_ONLY, "nope")).toBeUndefined();
    expect(matchScopedKey([], "ro-secret-123")).toBeUndefined();
  });
});

describe("Scoped API keys — route scope requirements", () => {
  it("requires read for safe methods", () => {
    expect(requiredScopeForRequest("GET", "/api/books")).toEqual({
      action: "read",
      resource: "books",
    });
    expect(requiredScopeForRequest("HEAD", "/api/annotations")).toEqual({
      action: "read",
      resource: "annotations",
    });
    expect(requiredScopeForRequest("get", "/api/books/12")).toEqual({
      action: "read",
      resource: "books",
    });
  });

  it("requires write for ordinary mutations", () => {
    expect(requiredScopeForRequest("POST", "/api/upload")).toEqual({
      action: "write",
      resource: "upload",
    });
    expect(requiredScopeForRequest("POST", "/api/lnori/ingest")).toEqual({
      action: "write",
      resource: "lnori",
    });
    expect(requiredScopeForRequest("DELETE", "/api/books/12")).toEqual({
      action: "write",
      resource: "books",
    });
    expect(requiredScopeForRequest("PUT", "/api/kosync/goal")).toEqual({
      action: "write",
      resource: "kosync",
    });
  });

  it("requires admin for host-wide administration routes", () => {
    expect(requiredScopeForRequest("POST", "/api/backup/ssd/run")).toEqual({
      action: "admin",
      resource: "backup",
    });
    expect(requiredScopeForRequest("POST", "/api/system/restart")).toEqual({
      action: "admin",
      resource: "system",
    });
    // Reads never require admin.
    expect(requiredScopeForRequest("GET", "/api/backup/ssd/status").action).toBe(
      "read",
    );
  });

  it("requires only read for the authentication probe, even when it mutates", () => {
    // POST /api/auth/session verifies a credential and hands off a cookie; it
    // never touches stored library data, so a read-only key may use it.
    expect(requiredScopeForRequest("POST", "/api/auth/session")).toEqual({
      action: "read",
      resource: "auth",
    });
    expect(requiredScopeForRequest("DELETE", "/api/auth/session")).toEqual({
      action: "read",
      resource: "auth",
    });
    // The exemption is exact, not a prefix bleed.
    expect(requiredScopeForRequest("POST", "/api/auth/session/evil").action).toBe(
      "read",
    );
    expect(requiredScopeForRequest("POST", "/api/authx/session").action).toBe(
      "write",
    );
  });

  it("omits the resource for non-API paths", () => {
    expect(requiredScopeForRequest("POST", "/upload")).toEqual({
      action: "write",
    });
  });

  it("identifies admin routes and resources", () => {
    expect(isAdminRoute("/api/backup")).toBe(true);
    expect(isAdminRoute("/api/backup/ssd/run")).toBe(true);
    expect(isAdminRoute("/api/backups")).toBe(false);
    expect(isAdminRoute("/api/books")).toBe(false);
    expect(apiResourceForPath("/api/books/12/highlights?x=1")).toBe("books");
    expect(apiResourceForPath("/opds")).toBeUndefined();
    expect(describeScope({ action: "write", resource: "books" })).toBe(
      "books:write",
    );
    expect(describeScope({ action: "read" })).toBe("read");
  });
});

describe("Scoped API keys — authenticateRequest", () => {
  afterEach(() => {
    resetScopedKeyCacheForTest();
  });

  it("keeps full backward compatibility for the legacy READING_API_KEY", () => {
    const bearer = authenticateRequest(wanRequest("/api/upload", { method: "POST", headers: { authorization: "Bearer legacy-secret" } }), {
      apiKey: "legacy-secret",
      scopedKeys: READ_ONLY,
      requiredScope: { action: "write", resource: "upload" },
    });
    expect(bearer.authenticated).toBe(true);
    expect(bearer.method).toBe("bearer");
    expect(bearer.scopes).toEqual(["*"]);
    expect(bearer.keyName).toBeUndefined();

    const xApiKey = authenticateRequest(
      wanRequest("/api/upload", {
        method: "POST",
        headers: { "x-api-key": "legacy-secret" },
      }),
      {
        apiKey: "legacy-secret",
        scopedKeys: READ_ONLY,
        requiredScope: { action: "admin" },
      },
    );
    expect(xApiKey.authenticated).toBe(true);
    expect(xApiKey.method).toBe("api_key");

    const cookie = authenticateRequest(
      wanRequest("/api/upload", {
        method: "POST",
        headers: { cookie: "reading_session=legacy-secret" },
      }),
      {
        apiKey: "legacy-secret",
        scopedKeys: READ_ONLY,
        requiredScope: { action: "write" },
      },
    );
    expect(cookie.authenticated).toBe(true);
    expect(cookie.method).toBe("cookie");

    // The legacy key always wins over a scoped entry holding the same secret.
    const overlapping = authenticateRequest(
      wanRequest("/api/backup/ssd/run", {
        method: "POST",
        headers: { authorization: "Bearer shared-secret" },
      }),
      {
        apiKey: "shared-secret",
        scopedKeys: [{ name: "ro", key: "shared-secret", scopes: ["read"] }],
        requiredScope: { action: "admin", resource: "backup" },
      },
    );
    expect(overlapping.authenticated).toBe(true);
    expect(overlapping.keyName).toBeUndefined();
  });

  it("authenticates scoped keys via Bearer and X-API-Key", () => {
    const bearer = authenticateRequest(
      wanRequest("/api/books", {
        headers: { authorization: "Bearer ro-secret-123" },
      }),
      {
        apiKey: "legacy-secret",
        scopedKeys: READ_ONLY,
        requiredScope: { action: "read", resource: "books" },
      },
    );
    expect(bearer.authenticated).toBe(true);
    expect(bearer.forbidden).toBeUndefined();
    expect(bearer.method).toBe("bearer");
    expect(bearer.keyName).toBe("koreader-read");
    expect(bearer.scopes).toEqual(["read"]);

    const header = authenticateRequest(
      wanRequest("/api/annotations", { headers: { "x-api-key": "ro-secret-123" } }),
      {
        apiKey: "legacy-secret",
        scopedKeys: READ_ONLY,
        requiredScope: { action: "read", resource: "annotations" },
      },
    );
    expect(header.authenticated).toBe(true);
    expect(header.method).toBe("api_key");
    expect(header.keyName).toBe("koreader-read");
  });

  it("authenticates scoped keys from the session cookie without escalating scopes", () => {
    const result = authenticateRequest(
      wanRequest("/api/books", {
        headers: { cookie: "reading_token=ro-secret-123" },
      }),
      {
        apiKey: "legacy-secret",
        scopedKeys: READ_ONLY,
        requiredScope: { action: "write", resource: "books" },
      },
    );
    expect(result.authenticated).toBe(false);
    expect(result.forbidden).toBe(true);
    expect(result.method).toBe("cookie");
    expect(result.keyName).toBe("koreader-read");
  });

  it("refuses read-only keys on mutating routes with a 403 signal", () => {
    for (const [method, path, required] of [
      ["POST", "/api/upload", { action: "write", resource: "upload" }],
      ["PUT", "/api/books/12", { action: "write", resource: "books" }],
      ["DELETE", "/api/annotations/7", { action: "write", resource: "annotations" }],
      ["POST", "/api/lnori/ingest", { action: "write", resource: "lnori" }],
    ] as const) {
      const result = authenticateRequest(
        wanRequest(path, {
          method,
          headers: { authorization: "Bearer ro-secret-123" },
        }),
        {
          apiKey: "legacy-secret",
          scopedKeys: READ_ONLY,
          requiredScope: required,
        },
      );
      expect(result.authenticated).toBe(false);
      expect(result.forbidden).toBe(true);
      expect(result.code).toBe("insufficient_scope");
      expect(result.keyName).toBe("koreader-read");
      expect(result.requiredScope).toBe(`${required.resource}:${required.action}`);
      expect(result.error).toContain("lacks the required scope");
    }
  });

  it("refuses write-scoped keys on admin routes but allows admin keys", () => {
    const denied = authenticateRequest(
      wanRequest("/api/backup/ssd/run", {
        method: "POST",
        headers: { "x-api-key": "rw-secret-456" },
      }),
      {
        apiKey: "legacy-secret",
        scopedKeys: WRITE_KEY,
        requiredScope: { action: "admin", resource: "backup" },
      },
    );
    expect(denied.forbidden).toBe(true);
    expect(denied.code).toBe("insufficient_scope");

    const allowed = authenticateRequest(
      wanRequest("/api/backup/ssd/run", {
        method: "POST",
        headers: { "x-api-key": "admin-secret-789" },
      }),
      {
        apiKey: "legacy-secret",
        scopedKeys: ADMIN_KEY,
        requiredScope: { action: "admin", resource: "backup" },
      },
    );
    expect(allowed.authenticated).toBe(true);
    expect(allowed.keyName).toBe("ops-admin");
  });

  it("enforces resource-qualified scopes per route", () => {
    const scopedKeys: ScopedApiKey[] = [
      { name: "books-only", key: "books-secret", scopes: ["books:write"] },
    ];
    const books = authenticateRequest(
      wanRequest("/api/books", {
        method: "POST",
        headers: { authorization: "Bearer books-secret" },
      }),
      {
        apiKey: "legacy-secret",
        scopedKeys,
        requiredScope: { action: "write", resource: "books" },
      },
    );
    expect(books.authenticated).toBe(true);

    const kosync = authenticateRequest(
      wanRequest("/api/kosync/goal", {
        method: "POST",
        headers: { authorization: "Bearer books-secret" },
      }),
      {
        apiKey: "legacy-secret",
        scopedKeys,
        requiredScope: { action: "write", resource: "kosync" },
      },
    );
    expect(kosync.forbidden).toBe(true);
  });

  it("rejects unknown or revoked keys with a 401 signal", () => {
    const unknown = authenticateRequest(
      wanRequest("/api/books", { headers: { authorization: "Bearer revoked-key" } }),
      { apiKey: "legacy-secret", scopedKeys: READ_ONLY },
    );
    expect(unknown.authenticated).toBe(false);
    expect(unknown.forbidden).toBeUndefined();
    expect(unknown.code).toBe("missing_credentials");
    expect(unknown.error).toContain("Authentication required for public WAN access");

    // Revoking a key (removing it from the registry) is an immediate 401.
    const revoked = authenticateRequest(
      wanRequest("/api/books", { headers: { "x-api-key": "ro-secret-123" } }),
      { apiKey: "legacy-secret", scopedKeys: [], requiredScope: { action: "read" } },
    );
    expect(revoked.authenticated).toBe(false);
    expect(revoked.code).toBe("missing_credentials");

    const noCredentials = authenticateRequest(wanRequest("/api/books"), {
      apiKey: "legacy-secret",
      scopedKeys: READ_ONLY,
      requiredScope: { action: "read", resource: "books" },
    });
    expect(noCredentials.authenticated).toBe(false);
  });

  it("continues to reject query-string credentials, including scoped keys", () => {
    const queryRequests = [
      "/api/books?api_key=ro-secret-123",
      "/api/books?token=ro-secret-123",
      "/api/books?key=ro-secret-123",
      "/api/books?x-api-key=ro-secret-123",
      "/api/upload?auth=legacy-secret",
    ];
    for (const path of queryRequests) {
      const result = authenticateRequest(
        wanRequest(path, { method: "POST", headers: { "content-type": "application/json" } }),
        {
          apiKey: "legacy-secret",
          scopedKeys: READ_ONLY,
          requiredScope: { action: "write" },
        },
      );
      expect(result.authenticated).toBe(false);
      expect(result.code).toBe("missing_credentials");
    }
  });

  it("leaves LAN requests friction-free and unscoped", () => {
    const lanReq = new Request("http://192.168.31.15:8086/api/upload", {
      method: "POST",
      headers: { host: "192.168.31.15:8086" },
    });
    const result = authenticateRequest(lanReq, {
      remoteAddress: "192.168.31.15",
      apiKey: "legacy-secret",
      scopedKeys: READ_ONLY,
      requiredScope: { action: "admin", resource: "backup" },
    });
    expect(result.authenticated).toBe(true);
    expect(result.method).toBe("lan");
    expect(result.forbidden).toBeUndefined();
  });

  it("reads the scoped registry from READING_SCOPED_KEYS when no registry is passed", () => {
    const original = process.env.READING_SCOPED_KEYS;
    const originalKey = process.env.READING_API_KEY;
    try {
      resetScopedKeyCacheForTest();
      process.env.READING_SCOPED_KEYS = "env-reader=env-ro-secret:read";
      process.env.READING_API_KEY = "legacy-secret";

      const allowed = authenticateRequest(
        wanRequest("/api/books", {
          headers: { authorization: "Bearer env-ro-secret" },
        }),
        { requiredScope: { action: "read", resource: "books" } },
      );
      expect(allowed.authenticated).toBe(true);
      expect(allowed.keyName).toBe("env-reader");

      const denied = authenticateRequest(
        wanRequest("/api/upload", {
          method: "POST",
          headers: { authorization: "Bearer env-ro-secret" },
        }),
        { requiredScope: { action: "write", resource: "upload" } },
      );
      expect(denied.forbidden).toBe(true);
    } finally {
      if (original === undefined) delete process.env.READING_SCOPED_KEYS;
      else process.env.READING_SCOPED_KEYS = original;
      if (originalKey === undefined) delete process.env.READING_API_KEY;
      else process.env.READING_API_KEY = originalKey;
      resetScopedKeyCacheForTest();
    }
  });

  it("does not enforce scopes when the caller passes no required scope", () => {
    const result = authenticateRequest(
      wanRequest("/api/backup/ssd/run", {
        method: "POST",
        headers: { authorization: "Bearer ro-secret-123" },
      }),
      { apiKey: "legacy-secret", scopedKeys: READ_ONLY },
    );
    expect(result.authenticated).toBe(true);
    expect(result.requiredScope).toBeUndefined();
  });
});
