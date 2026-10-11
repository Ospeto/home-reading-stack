import { describe, test, expect, beforeAll, afterAll, afterEach } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { spawnSync } from "node:child_process";
import {
  isPaywallOrGarbage,
  cleanMarkdownNoise,
  cleanDirectHtml,
  PAYWALL_ERROR_MESSAGE,
  extractArticle,
  extractArticleViaJina,
  wrapText,
  escapeXml,
  generateTypographicCover,
  parseJinaMarkdown,
  convertHtmlToEpub,
  ingestArticleFromUrl,
  extractUrlFromText,
  isBotChallengeTitle,
  isCloudflareChallenge,
  stripTrackingParams,
  validateArticleUrl,
  TRACKING_PARAMS,
} from "./article";
import { isElscioneUrl } from "./elscione";
import { evaluateJunkGate } from "./jev-shelf";
import { setFirecrawlEnabled } from "./firecrawl";

let originalFetch = globalThis.fetch;
let mockArticleFetch: any = null;
let mockConvertScript: string | null = null;
let origEbookConvertPath: string | undefined;
let lastJinaRequest: { url: string; headers: any } | null = null;

function getHeaderValue(headers: any, name: string): string | null {
  if (!headers) return null;
  if (typeof headers.get === "function") {
    return headers.get(name);
  }
  const target = name.toLowerCase();
  for (const [key, val] of Object.entries(headers)) {
    if (key.toLowerCase() === target) return val as string;
  }
  return null;
}

beforeAll(() => {
  // Disable Firecrawl by default for standard hermetic article tests
  setFirecrawlEnabled(false);

  // 1. Isolate external article and Jina network access
  mockArticleFetch = (async (input: any, init?: any) => {
    const urlStr = typeof input === "string" ? input : input?.url || "";
    const hostHeader =
      init?.headers instanceof Headers
        ? init.headers.get("host")
        : (init?.headers?.host || "");

    // Intercept Paul Graham article fetch
    if (
      urlStr.includes("paulgraham.com/foundermode.html") ||
      (hostHeader?.includes("paulgraham.com") &&
        urlStr.includes("/foundermode.html"))
    ) {
      const dummyEssay =
        "At a YC event recently Brian Chesky gave a talk that everyone who was there is still talking about. Most founder advice is wrong because modularizing companies when they grow breaks the core vision. Founders need to stay deeply involved in details. ".repeat(
          25,
        );
      const html = `<!DOCTYPE html>
<html>
<head><title>Founder Mode</title></head>
<body>
  <header><nav><a href="/">Home</a></nav></header>
  <map name="navmap"><area shape="rect" coords="0,0,10,10" href="/maplink"></map>
  <img src="banner.jpg" usemap="#navmap" />
  <h1>Founder Mode</h1>
  <p>${dummyEssay}</p>
  <footer>Copyright 2024</footer>
</body>
</html>`;
      return new Response(html, {
        status: 200,
        headers: { "Content-Type": "text/html; charset=utf-8" },
      });
    }

    // Intercept FT article paywall & Jina fallback
    if (
      urlStr.includes("ft.com") ||
      hostHeader?.includes("ft.com") ||
      urlStr.includes("r.jina.ai") ||
      hostHeader?.includes("r.jina.ai")
    ) {
      if (urlStr.includes("r.jina.ai") || hostHeader?.includes("r.jina.ai")) {
        lastJinaRequest = {
          url: urlStr,
          headers: init?.headers,
        };

        if (urlStr.includes("ft.com") || hostHeader?.includes("ft.com")) {
          const jinaPaywall = `Title: Financial Times
URL Source: https://www.ft.com/content/sample
Markdown Content:
Standard Digital subscription required. Explore more offers. Save over 40% on subscription.`;
          return new Response(jinaPaywall, {
            status: 200,
            headers: { "Content-Type": "text/markdown; charset=utf-8" },
          });
        }

        const dummyEssay =
          "In modern software development, designing resilient and maintainable systems requires careful consideration of trade-offs. Architecture is not about finding the perfect solution, but rather about choosing the right compromises. ".repeat(
            20,
          );
        const jinaValid = `Title: Authenticated Article Title
URL Source: ${urlStr}
Markdown Content:
${dummyEssay}`;
        return new Response(jinaValid, {
          status: 200,
          headers: { "Content-Type": "text/markdown; charset=utf-8" },
        });
      }
      return new Response("Paywall Access Denied", { status: 403 });
    }

    return originalFetch(input, init);
  });
  globalThis.fetch = mockArticleFetch;

  // 2. Isolate machine-specific ebook-convert via hermetic mock script
  mockConvertScript = path.join("/tmp", `mock_ebook_convert_${Date.now()}.sh`);
  fs.writeFileSync(
    mockConvertScript,
    `#!/bin/sh
OUT="$2"
printf "PK\\003\\004mock_hermetic_epub_archive" > "$OUT"
head -c 3000 /dev/zero >> "$OUT"
exit 0
`,
    { mode: 0o755 },
  );
  origEbookConvertPath = process.env.EBOOK_CONVERT_PATH;
  process.env.EBOOK_CONVERT_PATH = mockConvertScript;
});

afterAll(() => {
  globalThis.fetch = originalFetch;

  if (origEbookConvertPath === undefined) {
    delete process.env.EBOOK_CONVERT_PATH;
  } else {
    process.env.EBOOK_CONVERT_PATH = origEbookConvertPath;
  }

  if (mockConvertScript && fs.existsSync(mockConvertScript)) {
    try {
      fs.unlinkSync(mockConvertScript);
    } catch {}
  }
});

describe("Paywall Barrier & Content Quality Detection", () => {
  test("flags content with link density > 50% when totalTextLen > 200", () => {
    // 250 total chars, 150 link chars => 60% link density
    const text =
      "A".repeat(100) +
      "[Link Text](" +
      "https://example.com/".repeat(5) +
      ")" +
      "B".repeat(50);
    const linkLen = 150;
    const totalLen = 250;
    const result = isPaywallOrGarbage(text, linkLen, totalLen);
    expect(result.isPaywall).toBe(true);
    expect(result.reason).toContain("Link density too high");
  });

  test("flags content with prose word count < 150 words", () => {
    const text = `
# Short Announcement
Here is a very brief notice about a website update. It has only twenty words or so.
`;
    const result = isPaywallOrGarbage(text);
    expect(result.isPaywall).toBe(true);
    expect(result.reason).toContain("Insufficient prose content");
  });

  test("flags content containing subscription/paywall pricing markers", () => {
    const markers = [
      "Explore more offers",
      "Standard Digital",
      "Save over 40%",
      "Choose your subscription",
      "Subscribe to unlock",
      "Subscribe for full access",
      "Already a subscriber? Sign in",
      "To continue reading, please subscribe",
    ];

    for (const marker of markers) {
      // 200 words of dummy text + marker
      const dummyProse =
        "The financial markets saw substantial trading activity across all major global asset classes today. ".repeat(
          20,
        );
      const text = `${dummyProse}\n\n${marker}\n\n${dummyProse}`;
      const result = isPaywallOrGarbage(text);
      expect(result.isPaywall).toBe(true);
      expect(result.reason).toContain("Subscription paywall marker detected");
    }
  });

  test("allows legitimate articles with sufficient prose and low link density", () => {
    const paragraphs = [
      "In modern software development, designing resilient and maintainable systems requires careful consideration of trade-offs. Architecture is not about finding the perfect solution, but rather about choosing the right compromises.",
      "When building distributed platforms, networks are inherently unreliable. Packets can be delayed, duplicated, or dropped altogether. Therefore, systems must be built to anticipate failure at every boundary layer.",
      "Observability plays a fundamental role in understanding system health during unexpected failure modes. Structured logging, metrics aggregation, and distributed tracing work together to form a comprehensive diagnostic framework.",
      "Furthermore, caching strategies must account for eventual consistency, cache invalidation storms, and cold start latency. Using write-through or cache-aside topologies depends strictly on the application's read-to-write ratio.",
      "Security cannot be treated as an afterthought in modern cloud architectures. Zero-trust principles require that every service boundary verifies and authorizes each incoming request, regardless of whether it originates within the internal private network or across the public internet.",
      "Ultimately, successful engineering organizations cultivate strong engineering hygiene through automated testing, continuous integration, and disciplined operational runbooks that allow teams to recover rapidly from outages.",
    ];
    const fullArticle = paragraphs.join("\n\n");
    const result = isPaywallOrGarbage(fullArticle);
    expect(result.isPaywall).toBe(false);
  });
});

describe("Aggressive Navigation & Noise Stripping", () => {
  test("Markdown cleaner strips boilerplate sections and navigation lists", () => {
    const mdInput = `
Title: Tech Analysis
URL Source: https://example.com/tech

Markdown Content:
[Accessibility help](https://example.com/a11y)
* [Home](https://example.com)
* [World](https://example.com/world)
* [Sign in](https://example.com/login)
* [Subscribe](https://example.com/sub)

# Tech Analysis: The Evolution of Cloud Computing

Cloud computing has fundamentally altered the infrastructure landscape over the last two decades. Organizations that once operated physical data centers now deploy global services within minutes.

This shift has enabled unprecedented agility and developer productivity. However, managing distributed systems at scale introduces unique challenges regarding consistency, observability, and network partitions.

Engineering teams must master techniques such as distributed tracing, circuit breaking, and rate limiting to ensure continuous availability under unpredictable traffic conditions.

## Most Read
* [Article 1](https://example.com/1)
* [Article 2](https://example.com/2)

## Explore more offers
Subscribe today for $1.

* [Privacy Policy](https://example.com/privacy)
* [Terms of Service](https://example.com/terms)
`;
    const cleaned = cleanMarkdownNoise(mdInput);
    expect(cleaned).not.toContain("Accessibility help");
    expect(cleaned).not.toContain("## Most Read");
    expect(cleaned).not.toContain("## Explore more offers");
    expect(cleaned).not.toContain("Terms of Service");
    expect(cleaned).toContain("The Evolution of Cloud Computing");
    expect(cleaned).toContain("Cloud computing has fundamentally altered");
  });

  test("HTML cleaner strips <nav>, <header>, <footer>, <aside>, <form>, <map>, <area>, <script>, <iframe>", () => {
    const htmlInput = `
<html>
<head><title>Test Page</title><style>body{color:red;}</style></head>
<body>
  <header><h1>Site Header</h1></header>
  <nav><a href="/">Home</a></nav>
  <map name="navmap"><area shape="rect" coords="0,0,10,10" href="/maplink"></map>
  <img src="banner.jpg" usemap="#navmap" />
  <aside class="sidebar">Sidebar contents</aside>
  <main>
    <article>
      <h1>Real Article Title</h1>
      <p>This is the real article body containing meaningful prose.</p>
    </article>
  </main>
  <form action="/newsletter"><input type="email" /></form>
  <div class="share-buttons">Share on Twitter</div>
  <div class="related-posts">Read more stories</div>
  <footer>Footer copyright 2026</footer>
  <script>console.log("bad script");</script>
  <noscript>Please enable JS</noscript>
  <iframe></iframe>
</body>
</html>
`;
    const cleaned = cleanDirectHtml(htmlInput);
    expect(cleaned).not.toContain("<map");
    expect(cleaned).not.toContain("<area");
    expect(cleaned).not.toContain("usemap");
    expect(cleaned).not.toContain("<nav");
    expect(cleaned).not.toContain("<header");
    expect(cleaned).not.toContain("<footer");
    expect(cleaned).not.toContain("<aside");
    expect(cleaned).not.toContain("<form");
    expect(cleaned).not.toContain("<script");
    expect(cleaned).not.toContain("<style");
    expect(cleaned).not.toContain("<noscript");
    expect(cleaned).not.toContain("<iframe");
    expect(cleaned).not.toContain("share-buttons");
    expect(cleaned).not.toContain("related-posts");
    expect(cleaned).toContain("Real Article Title");
    expect(cleaned).toContain("This is the real article body");
  });
});

describe("End-to-End Extraction & Paywall Rejection", () => {
  test("Paul Graham article cleans cleanly without <map> or <area> tags", async () => {
    const article = await extractArticle(
      "https://paulgraham.com/foundermode.html",
    );
    expect(article.title).toBe("Founder Mode");
    expect(article.wordCount).toBeGreaterThan(500);
    expect(article.cleanedHtml).not.toContain("<map");
    expect(article.cleanedHtml).not.toContain("<area");
    expect(article.cleanedHtml).not.toContain("usemap");
  }, 15000);

  test("Financial Times paywall page is cleanly rejected with PAYWALL_ERROR_MESSAGE", async () => {
    const ftUrl =
      "https://www.ft.com/content/4564e6a5-69e9-40a6-bf0f-a888f2f4f002";
    let thrownError: Error | null = null;
    try {
      await extractArticle(ftUrl);
    } catch (err: any) {
      thrownError = err;
    }
    expect(thrownError).not.toBeNull();
    expect(thrownError?.message).toBe(PAYWALL_ERROR_MESSAGE);
  }, 15000);
});

describe("Automatic Cover Generation & Typography Pipeline", () => {
  test("wrapText wraps long titles into lines within character limits", () => {
    const shortTitle = "Short Title";
    expect(wrapText(shortTitle, 22, 5)).toEqual(["Short Title"]);

    const longTitle =
      "How to Do Great Work and Build Remarkable Things Across Multiple Decades";
    const wrapped = wrapText(longTitle, 22, 5);
    expect(wrapped.length).toBeGreaterThanOrEqual(3);
    for (const line of wrapped) {
      expect(line.length).toBeLessThanOrEqual(26);
    }
  });

  test("escapeXml correctly escapes XML entity characters", () => {
    const raw = `Tom & Jerry <cartoon> "best" 'show'`;
    const escaped = escapeXml(raw);
    expect(escaped).toBe(
      "Tom &amp; Jerry &lt;cartoon&gt; &quot;best&quot; &apos;show&apos;",
    );
  });

  test("generateTypographicCover creates a valid 600x900 JPEG cover via macOS sips", () => {
    const title = "What I Wish Someone Had Told Me";
    const author = "Sam Altman";
    const siteName = "Sam Altman";
    const coverPath = generateTypographicCover(title, author, siteName, 12);

    try {
      expect(fs.existsSync(coverPath)).toBe(true);
      const stat = fs.statSync(coverPath);
      expect(stat.size).toBeGreaterThan(1024);

      // Verify with sips that it's a valid JPEG image with 600x900 dimensions
      const sipsProbe = spawnSync(
        "/usr/bin/sips",
        ["-g", "format", "-g", "pixelWidth", "-g", "pixelHeight", coverPath],
        { encoding: "utf8" },
      );
      expect(sipsProbe.status).toBe(0);
      expect(sipsProbe.stdout).toContain("format: jpeg");
      expect(sipsProbe.stdout).toContain("pixelWidth: 600");
      expect(sipsProbe.stdout).toContain("pixelHeight: 900");
    } finally {
      if (fs.existsSync(coverPath)) {
        try {
          fs.unlinkSync(coverPath);
        } catch (_err) {
          void _err;
        }
      }
    }
  });

  test("parseJinaMarkdown extracts image from Image: header or lead markdown syntax", () => {
    const rawWithHeader = `Title: Article Title
URL Source: https://example.com/story
Image: https://example.com/cover.jpg

Markdown Content:
Body text goes here.`;
    const parsedHeader = parseJinaMarkdown(
      rawWithHeader,
      "https://example.com/story",
    );
    expect(parsedHeader.imageUrl).toBe("https://example.com/cover.jpg");

    const rawWithLeadImg = `Title: Story Title
URL Source: https://example.com/story2

Markdown Content:
![Hero Image](https://example.com/lead.png)
More body text.`;
    const parsedLead = parseJinaMarkdown(
      rawWithLeadImg,
      "https://example.com/story2",
    );
    expect(parsedLead.imageUrl).toBe("https://example.com/lead.png");
  });

  test("convertHtmlToEpub attaches generated cover to EPUB", () => {
    const coverPath = generateTypographicCover(
      "Test Book With Cover",
      "Author",
      "Example.com",
    );
    try {
      const epubPath = convertHtmlToEpub(
        "<h1>Hello</h1><p>Test content for epub conversion.</p>",
        "Test Book With Cover",
        "Author",
        "Example.com",
        "https://example.com/article",
        coverPath,
      );

      expect(fs.existsSync(epubPath)).toBe(true);
      expect(fs.statSync(epubPath).size).toBeGreaterThan(2048);

      // Clean up temp epub
      try {
        fs.unlinkSync(epubPath);
      } catch (_err) {
        void _err;
      }
    } finally {
      if (fs.existsSync(coverPath)) {
        try {
          fs.unlinkSync(coverPath);
        } catch (_err) {
          void _err;
        }
      }
    }
  });
});

describe("Jina Reader API Key Authentication (JINA_API_KEY & JEV_API_KEY)", () => {
  const origJinaKey = process.env.JINA_API_KEY;
  const origJevKey = process.env.JEV_API_KEY;

  afterEach(() => {
    setFirecrawlEnabled(false);
    if (origJinaKey !== undefined) {
      process.env.JINA_API_KEY = origJinaKey;
    } else {
      delete process.env.JINA_API_KEY;
    }
    if (origJevKey !== undefined) {
      process.env.JEV_API_KEY = origJevKey;
    } else {
      delete process.env.JEV_API_KEY;
    }
    lastJinaRequest = null;
  });

  test("attaches x-api-key and Authorization Bearer headers when JINA_API_KEY is configured", async () => {
    delete process.env.JEV_API_KEY;
    process.env.JINA_API_KEY = "jina_test_secret_123";

    const article = await extractArticleViaJina(
      "https://example.com/jina-auth-test",
    );
    expect(article.title).toBe("Authenticated Article Title");
    expect(lastJinaRequest).not.toBeNull();
    expect(getHeaderValue(lastJinaRequest?.headers, "x-api-key")).toBe(
      "jina_test_secret_123",
    );
    expect(getHeaderValue(lastJinaRequest?.headers, "authorization")).toBe(
      "Bearer jina_test_secret_123",
    );
    expect(getHeaderValue(lastJinaRequest?.headers, "x-return-format")).toBe(
      "markdown",
    );
  });

  test("does not reuse Jev key as Jina article key", async () => {
    delete process.env.JINA_API_KEY;
    process.env.JEV_API_KEY = "jev_test_secret_456";

    const article = await extractArticleViaJina(
      "https://example.com/jev-auth-test",
    );
    expect(article.title).toBe("Authenticated Article Title");
    expect(lastJinaRequest).not.toBeNull();
    // JEV key should NOT be attached to Jina request
    expect(getHeaderValue(lastJinaRequest?.headers, "x-api-key")).toBeNull();
    expect(getHeaderValue(lastJinaRequest?.headers, "authorization")).toBeNull();
  });

  test("prioritizes JINA_API_KEY and ignores JEV_API_KEY", async () => {
    process.env.JINA_API_KEY = "primary_jina_key";
    process.env.JEV_API_KEY = "secondary_jev_key";

    await extractArticleViaJina("https://example.com/both-keys-test");
    expect(lastJinaRequest).not.toBeNull();
    expect(getHeaderValue(lastJinaRequest?.headers, "x-api-key")).toBe(
      "primary_jina_key",
    );
    expect(getHeaderValue(lastJinaRequest?.headers, "authorization")).toBe(
      "Bearer primary_jina_key",
    );
  });

  test("omits x-api-key and Authorization headers when neither key is configured", async () => {
    delete process.env.JINA_API_KEY;
    delete process.env.JEV_API_KEY;

    await extractArticleViaJina("https://example.com/no-key-test");
    expect(lastJinaRequest).not.toBeNull();
    expect(getHeaderValue(lastJinaRequest?.headers, "x-api-key")).toBeNull();
    expect(getHeaderValue(lastJinaRequest?.headers, "authorization")).toBeNull();
    expect(getHeaderValue(lastJinaRequest?.headers, "x-return-format")).toBe(
      "markdown",
    );
  });

  test("trims whitespace from API keys and ignores empty strings", async () => {
    delete process.env.JEV_API_KEY;
    process.env.JINA_API_KEY = "  \t \n ";

    await extractArticleViaJina("https://example.com/empty-key-test");
    expect(lastJinaRequest).not.toBeNull();
    expect(getHeaderValue(lastJinaRequest?.headers, "x-api-key")).toBeNull();
    expect(getHeaderValue(lastJinaRequest?.headers, "authorization")).toBeNull();

    process.env.JINA_API_KEY = "   trimmed_key_789   ";
    await extractArticleViaJina("https://example.com/trimmed-key-test");
    expect(getHeaderValue(lastJinaRequest?.headers, "x-api-key")).toBe(
      "trimmed_key_789",
    );
    expect(getHeaderValue(lastJinaRequest?.headers, "authorization")).toBe(
      "Bearer trimmed_key_789",
    );
  });

  test("ingestArticleFromUrl executes end-to-end and respects junk gate quarantine", async () => {
    const testTempDir = fs.mkdtempSync(path.join(os.tmpdir(), "article-quarantine-test-"));
    const testDropDir = path.join(testTempDir, "drop");
    const testQuarantineDir = path.join(testTempDir, "quarantine");
    fs.mkdirSync(testDropDir, { recursive: true });
    fs.mkdirSync(testQuarantineDir, { recursive: true });

    const prevDropEnv = process.env.BOOKS_DROP_DIR;
    const prevQuarantineEnv = process.env.BOOKS_QUARANTINE_DIR;
    process.env.BOOKS_DROP_DIR = testDropDir;
    process.env.BOOKS_QUARANTINE_DIR = testQuarantineDir;

    try {
      // Generate >150 words of real prose content
      const prose = "Cloud computing and distributed architectures require resilient service design. ".repeat(25);
      globalThis.fetch = async () => {
        return new Response(
          `<html><head><title>truncated_12345678_abcd</title></head><body><article><p>${prose}</p></article></body></html>`,
          { status: 200, headers: { "Content-Type": "text/html; charset=utf-8" } },
        );
      };

      const junkUrl = "https://example.com/truncated_12345678_abcd";
      const res = await ingestArticleFromUrl(junkUrl);
      expect(res.success).toBe(false);
      expect(res.error).toContain("Quarantined by junk ingest gate");

      // Verify files stayed out of Books_Drop
      const dropFiles = fs.readdirSync(testDropDir);
      expect(dropFiles.length).toBe(0);

      // Verify quarantined file is in test quarantine directory
      const quarantineFiles = fs.readdirSync(testQuarantineDir);
      expect(quarantineFiles.length).toBe(1);
      expect(quarantineFiles[0]).toContain("truncated_12345678_abcd");
    } finally {
      globalThis.fetch = mockArticleFetch;
      if (prevDropEnv !== undefined) process.env.BOOKS_DROP_DIR = prevDropEnv;
      else delete process.env.BOOKS_DROP_DIR;
      if (prevQuarantineEnv !== undefined) process.env.BOOKS_QUARANTINE_DIR = prevQuarantineEnv;
      else delete process.env.BOOKS_QUARANTINE_DIR;
      try {
        fs.rmSync(testTempDir, { recursive: true, force: true });
      } catch (_err) {
        void _err;
      }
    }
  });
});

describe("Article Extraction: Firecrawl Tier 1 & Fail-Open Fallback", () => {
  const origEnv = { ...process.env };

  afterEach(() => {
    setFirecrawlEnabled(false);
    for (const k of Object.keys(process.env)) {
      if (!(k in origEnv)) delete process.env[k];
    }
    Object.assign(process.env, origEnv);
    if (mockConvertScript) {
      process.env.EBOOK_CONVERT_PATH = mockConvertScript;
    }
  });

  test("uses Firecrawl Tier 1 when available and content is valid", async () => {
    process.env.EBOOK_CONVERT_PATH = mockConvertScript!;
    const mockServer = Bun.serve({
      port: 49992,
      fetch(req) {
        if (req.method === "GET" && new URL(req.url).pathname === "/") {
          return new Response("OK", { status: 200 });
        }
        if (req.method === "POST" && new URL(req.url).pathname === "/v1/scrape") {
          return new Response(
            JSON.stringify({
              success: true,
              data: {
                markdown: "# Distributed Systems at Scale\n\n".concat(
                  "High-availability clusters and state synchronization protocols ensure zero data loss. ".repeat(25),
                ),
                metadata: {
                  title: "Distributed Systems at Scale",
                  author: "Dr. Network",
                  "og:site_name": "Cluster Engineering",
                },
              },
            }),
            { headers: { "Content-Type": "application/json" } },
          );
        }
        return new Response("Not Found", { status: 404 });
      },
    });

    process.env.FIRECRAWL_URL = "http://127.0.0.1:49992";
    setFirecrawlEnabled(true);

    try {
      const article = await extractArticle("https://techjournal.org/distributed-systems");
      expect(article.title).toBe("Distributed Systems at Scale");
      expect(article.author).toBe("Dr. Network");
      expect(article.siteName).toBe("Cluster Engineering");
      expect(article.wordCount).toBeGreaterThan(150);
    } finally {
      mockServer.stop(true);
    }
  });

  test("fails open to Tier 2 when Firecrawl is offline, disabled, or fails", async () => {
    // Point Firecrawl to an unreachable port with nonexistent compose dir to prevent real wake
    process.env.FIRECRAWL_URL = "http://127.0.0.1:49991";
    process.env.FIRECRAWL_COMPOSE_DIR = "/nonexistent/fc/dir";
    setFirecrawlEnabled(true);

    // Paul Graham mock is in place for Tier 2 fallback
    const article = await extractArticle("https://paulgraham.com/foundermode.html");
    expect(article.title).toBe("Founder Mode");
    expect(article.wordCount).toBeGreaterThan(150);
  });

  test("falls open to Tier 2 when Firecrawl content fails paywall check", async () => {
    process.env.EBOOK_CONVERT_PATH = mockConvertScript!;
    const mockServer = Bun.serve({
      port: 49990,
      fetch(req) {
        if (req.method === "GET" && new URL(req.url).pathname === "/") {
          return new Response("OK", { status: 200 });
        }
        if (req.method === "POST" && new URL(req.url).pathname === "/v1/scrape") {
          return new Response(
            JSON.stringify({
              success: true,
              data: {
                markdown: "Subscribe now to read this exclusive content.",
                metadata: { title: "Paywalled Story" },
              },
            }),
            { headers: { "Content-Type": "application/json" } },
          );
        }
        return new Response("Not Found", { status: 404 });
      },
    });

    process.env.FIRECRAWL_URL = "http://127.0.0.1:49990";
    setFirecrawlEnabled(true);

    try {
      // Should fall through Firecrawl paywall failure to Tier 2 Paul Graham mock
      const article = await extractArticle("https://paulgraham.com/foundermode.html");
      expect(article.title).toBe("Founder Mode");
    } finally {
      mockServer.stop(true);
    }
  });

  test("blocks SSRF targets upfront before any network egress", async () => {
    const ssrfTargets = [
      "http://169.254.169.254/latest/meta-data/",
      "http://localhost:8088/calibre",
      "http://127.0.0.1:8086/api/books",
      "http://host.docker.internal:8086/",
      "http://metadata.google.internal/",
      "http://[::1]/secret",
    ];

    for (const target of ssrfTargets) {
      let err: Error | null = null;
      try {
        await extractArticle(target);
      } catch (e: any) {
        err = e;
      }
      expect(err).not.toBeNull();
      expect(err?.message).toMatch(/Internal or local network URLs|SSRF guard blocked/);
    }
  });
});

describe("URL Extraction from Conversational Text (extractUrlFromText)", () => {
  test("extracts server.elscione.com URLs with spaces in path and normalizes them", () => {
    const text =
      "Check this out: https://server.elscione.com/Officially Translated Light Novels/A Sister's All You Need/";
    const url = extractUrlFromText(text);
    expect(url).toBe(
      "https://server.elscione.com/Officially%20Translated%20Light%20Novels/A%20Sister's%20All%20You%20Need/",
    );
  });

  test("extracts server.elsci.one URLs with spaces in path and normalizes them", () => {
    const text =
      "Check this out: https://server.elsci.one/Officially Translated Light Novels/Are You Okay With a Slightly Older Girlfriend/";
    const url = extractUrlFromText(text);
    expect(url).toBe(
      "https://server.elsci.one/Officially%20Translated%20Light%20Novels/Are%20You%20Okay%20With%20a%20Slightly%20Older%20Girlfriend/",
    );
  });

  test("extracts server.elsci.one URLs missing https:// protocol and prepends it", () => {
    const text =
      "server.elsci.one/Officially Translated Light Novels/Are You Okay With a Slightly Older Girlfriend/";
    const url = extractUrlFromText(text);
    expect(url).toBe(
      "https://server.elsci.one/Officially%20Translated%20Light%20Novels/Are%20You%20Okay%20With%20a%20Slightly%20Older%20Girlfriend/",
    );
  });

  test("extracts server.elscione.com URLs missing https:// protocol and prepends it", () => {
    const text =
      "server.elscione.com/Officially Translated Light Novels/A Sister's All You Need/";
    const url = extractUrlFromText(text);
    expect(url).toBe(
      "https://server.elscione.com/Officially%20Translated%20Light%20Novels/A%20Sister's%20All%20You%20Need/",
    );
  });

  test("extracts space-containing Elscione URLs enclosed in delimiters (markdown brackets, angle brackets, quotes)", () => {
    const inBrackets =
      "[https://server.elscione.com/Officially Translated Light Novels/A Sister's All You Need/]";
    expect(extractUrlFromText(inBrackets)).toBe(
      "https://server.elscione.com/Officially%20Translated%20Light%20Novels/A%20Sister's%20All%20You%20Need/",
    );

    const inAngles =
      "<https://server.elscione.com/Officially Translated Light Novels/A Sister's All You Need/>";
    expect(extractUrlFromText(inAngles)).toBe(
      "https://server.elscione.com/Officially%20Translated%20Light%20Novels/A%20Sister's%20All%20You%20Need/",
    );

    const inQuotes =
      "\"https://server.elscione.com/Officially Translated Light Novels/A Sister's All You Need/\"";
    expect(extractUrlFromText(inQuotes)).toBe(
      "https://server.elscione.com/Officially%20Translated%20Light%20Novels/A%20Sister's%20All%20You%20Need/",
    );

    const onNewline =
      "Here is the series:\nhttps://server.elscione.com/Officially Translated Light Novels/A Sister's All You Need/\nEnjoy reading!";
    expect(extractUrlFromText(onNewline)).toBe(
      "https://server.elscione.com/Officially%20Translated%20Light%20Novels/A%20Sister's%20All%20You%20Need/",
    );
  });

  test("handles /epub and /read commands with space-containing URLs and missing protocols", () => {
    const cmdWithSpaces =
      "/epub https://server.elscione.com/Officially Translated Light Novels/A Sister's All You Need/";
    expect(extractUrlFromText(cmdWithSpaces)).toBe(
      "https://server.elscione.com/Officially%20Translated%20Light%20Novels/A%20Sister's%20All%20You%20Need/",
    );

    const cmdNoProto =
      "/read server.elscione.com/Officially Translated Light Novels/A Sister's All You Need/";
    expect(extractUrlFromText(cmdNoProto)).toBe(
      "https://server.elscione.com/Officially%20Translated%20Light%20Novels/A%20Sister's%20All%20You%20Need/",
    );

    // Standard URL command stops at whitespace and does not absorb trailing words
    const cmdWithTrailingProse =
      "/article https://paulgraham.com/foundermode.html please";
    expect(extractUrlFromText(cmdWithTrailingProse)).toBe(
      "https://paulgraham.com/foundermode.html",
    );

    // Bare non-URL words are rejected and not converted to https://
    expect(extractUrlFromText("/epub not-a-url")).toBeNull();
  });

  test("properly bounds space-containing Elscione URLs and does not eat trailing prose", () => {
    // Trailing exclamation or prose after slash
    const textWithThanks =
      "Here: https://server.elscione.com/Officially Translated Light Novels/A Sister's All You Need/ thanks!";
    expect(extractUrlFromText(textWithThanks)).toBe(
      "https://server.elscione.com/Officially%20Translated%20Light%20Novels/A%20Sister's%20All%20You%20Need/",
    );

    // Trailing comma and prose
    const textWithComma =
      "Check out https://server.elscione.com/Officially Translated Light Novels/A Sister's All You Need/, and more";
    expect(extractUrlFromText(textWithComma)).toBe(
      "https://server.elscione.com/Officially%20Translated%20Light%20Novels/A%20Sister's%20All%20You%20Need/",
    );

    // .epub file followed by prose
    const textWithEpubProse =
      "Download server.elscione.com/Officially Translated/Overlord/bar.epub is ready";
    expect(extractUrlFromText(textWithEpubProse)).toBe(
      "https://server.elscione.com/Officially%20Translated/Overlord/bar.epub",
    );

    // Folder with trailing slash followed by prose
    const textWithFolderProse =
      "Please grab server.elscione.com/Officially Translated Light Novels/Grimgar/ please read";
    expect(extractUrlFromText(textWithFolderProse)).toBe(
      "https://server.elscione.com/Officially%20Translated%20Light%20Novels/Grimgar/",
    );

    // .epub followed by exclamation mark
    const textWithEpubExclamation =
      "Download https://server.elscione.com/Officially Translated/Overlord/vol 01.epub!";
    expect(extractUrlFromText(textWithEpubExclamation)).toBe(
      "https://server.elscione.com/Officially%20Translated/Overlord/vol%2001.epub",
    );

    // Folder followed by hyphen / dash and commentary
    const textWithDashCommentary =
      "Check out https://server.elscione.com/Officially Translated Light Novels/Grimgar/ - great series";
    expect(extractUrlFromText(textWithDashCommentary)).toBe(
      "https://server.elscione.com/Officially%20Translated%20Light%20Novels/Grimgar/",
    );

    // Wrapped in Unicode double curly quotes (“...”)
    const textWithDoubleCurly =
      "“https://server.elscione.com/Officially Translated Light Novels/Grimgar/”";
    expect(extractUrlFromText(textWithDoubleCurly)).toBe(
      "https://server.elscione.com/Officially%20Translated%20Light%20Novels/Grimgar/",
    );

    // Wrapped in Unicode single curly quotes (‘...’)
    const textWithSingleCurly =
      "‘https://server.elscione.com/Officially Translated Light Novels/Grimgar/’";
    expect(extractUrlFromText(textWithSingleCurly)).toBe(
      "https://server.elscione.com/Officially%20Translated%20Light%20Novels/Grimgar/",
    );

    // .epub followed by extension like .backup is preserved, not truncated early
    const textWithBackup =
      "https://server.elscione.com/files/file.epub.backup";
    expect(extractUrlFromText(textWithBackup)).toBe(
      "https://server.elscione.com/files/file.epub.backup",
    );

    // Folder followed by em-dash without space
    const textWithEmDash =
      "Check out https://server.elscione.com/Officially Translated Light Novels/Grimgar/—great";
    expect(extractUrlFromText(textWithEmDash)).toBe(
      "https://server.elscione.com/Officially%20Translated%20Light%20Novels/Grimgar/",
    );

    // Spaced URL without trailing slash followed by dash commentary
    const textWithNoSlashDash =
      "Check https://server.elscione.com/Officially Translated Light Novels/Grimgar - great series";
    expect(extractUrlFromText(textWithNoSlashDash)).toBe(
      "https://server.elscione.com/Officially%20Translated%20Light%20Novels/Grimgar",
    );

    // Spaced URL without trailing slash followed by em-dash commentary
    const textWithNoSlashEmDash =
      "Check https://server.elscione.com/Officially Translated Light Novels/Grimgar — great series";
    expect(extractUrlFromText(textWithNoSlashEmDash)).toBe(
      "https://server.elscione.com/Officially%20Translated%20Light%20Novels/Grimgar",
    );
  });

  test("preserves standard web URLs and ignores internal Telegram URLs", () => {
    const webArticle = "Check this: https://paulgraham.com/foundermode.html";
    expect(extractUrlFromText(webArticle)).toBe("https://paulgraham.com/foundermode.html");

    const tMeLink = "Join our channel https://t.me/reading_stack";
    expect(extractUrlFromText(tMeLink)).toBeNull();
  });

  test("preserves URLs with apostrophes and balanced parentheses without truncating (Schrödinger's cat, C_(programming_language), path(1)/page)", () => {
    // 1. URL with apostrophe (Schrödinger's cat)
    const schrodinger = "Check out https://en.wikipedia.org/wiki/Schrödinger's_cat for quantum mechanics";
    expect(extractUrlFromText(schrodinger)).toBe("https://en.wikipedia.org/wiki/Schrödinger's_cat");
    expect(extractUrlFromText("https://en.wikipedia.org/wiki/Schrödinger's_cat")).toBe(
      "https://en.wikipedia.org/wiki/Schrödinger's_cat",
    );

    // 2. URL with closing parenthesis balancing a parenthesis inside the URL (C_(programming_language))
    const cLang = "Learn https://en.wikipedia.org/wiki/C_(programming_language) today";
    expect(extractUrlFromText(cLang)).toBe("https://en.wikipedia.org/wiki/C_(programming_language)");
    expect(extractUrlFromText("https://en.wikipedia.org/wiki/C_(programming_language)")).toBe(
      "https://en.wikipedia.org/wiki/C_(programming_language)",
    );

    // 3. URL with parenthesized component in the middle of path (path(1)/page)
    const numberedPath = "Visit https://example.com/path(1)/page now";
    expect(extractUrlFromText(numberedPath)).toBe("https://example.com/path(1)/page");
    expect(extractUrlFromText("https://example.com/path(1)/page")).toBe("https://example.com/path(1)/page");

    // 4. Enclosing conversational parentheses: strips outer parenthesis while keeping inner closing parenthesis
    const enclosedCLang = "(see https://en.wikipedia.org/wiki/C_(programming_language))";
    expect(extractUrlFromText(enclosedCLang)).toBe("https://en.wikipedia.org/wiki/C_(programming_language)");

    const enclosedNumbered = "(see https://example.com/path(1)/page)";
    expect(extractUrlFromText(enclosedNumbered)).toBe("https://example.com/path(1)/page");

    // 5. Parentheses with trailing conversational punctuation (period, question mark)
    expect(extractUrlFromText("Did you read https://en.wikipedia.org/wiki/C_(programming_language)?")).toBe(
      "https://en.wikipedia.org/wiki/C_(programming_language)",
    );
    expect(extractUrlFromText("Check https://en.wikipedia.org/wiki/Schrödinger's_cat.")).toBe(
      "https://en.wikipedia.org/wiki/Schrödinger's_cat",
    );

    // 6. Explicit command formats
    expect(extractUrlFromText("/article https://en.wikipedia.org/wiki/C_(programming_language)")).toBe(
      "https://en.wikipedia.org/wiki/C_(programming_language)",
    );
    expect(extractUrlFromText("/read https://en.wikipedia.org/wiki/Schrödinger's_cat")).toBe(
      "https://en.wikipedia.org/wiki/Schrödinger's_cat",
    );
  });

  test("rejects bot challenge pages in article ingestion and evaluateJunkGate (including HTML entities)", async () => {
    const challengeTitles = [
      "Making sure you're not a bot!",
      "Making sure you’re not a bot!",
      "Making sure you&#39;re not a bot!",
      "Making sure you&#x27;re not a bot!",
      "Making sure you&apos;re not a bot!",
      "Making sure you&rsquo;re not a bot!",
      "Attention Required! | Cloudflare",
      "Just a moment...",
      "Just a moment…",
      "Just a moment&hellip;",
      "Anubis Challenge",
    ];

    for (const title of challengeTitles) {
      expect(isBotChallengeTitle(title)).toBe(true);
      const gateResult = await evaluateJunkGate(title, "challenge.epub", "Unknown");
      expect(gateResult.quarantined).toBe(true);
      expect(gateResult.action).toBe("deterministic_quarantine");
    }

    expect(isBotChallengeTitle("Normal Light Novel Title")).toBe(false);
    expect(isBotChallengeTitle("Just a moment... of peace")).toBe(false);
    expect(isBotChallengeTitle("Just a moment… of peace")).toBe(false);
  });

  test("isCloudflareChallenge detects Anubis and Cloudflare challenge variants", () => {
    expect(isCloudflareChallenge("<title>Making sure you&#x27;re not a bot!</title>")).toBe(true);
    expect(isCloudflareChallenge("<title>Making sure you&#39;re not a bot!</title>")).toBe(true);
    expect(isCloudflareChallenge("<title>Just a moment...</title>")).toBe(true);
    expect(isCloudflareChallenge("<title>Just a moment…</title>")).toBe(true);
    expect(isCloudflareChallenge("<title>Just a moment&hellip;</title>")).toBe(true);
    expect(isCloudflareChallenge("<title>Anubis Challenge</title>")).toBe(true);
    expect(isCloudflareChallenge("<p>Normal article content</p>")).toBe(false);
  });

  test("extracts space-containing Elscione URLs after colon or equals delimiter", () => {
    const afterColon =
      "Read:https://server.elsci.one/Officially Translated Light Novels/Are You Okay With a Slightly Older Girlfriend/";
    expect(extractUrlFromText(afterColon)).toBe(
      "https://server.elsci.one/Officially%20Translated%20Light%20Novels/Are%20You%20Okay%20With%20a%20Slightly%20Older%20Girlfriend/",
    );

    const afterEquals =
      "url=https://server.elsci.one/Officially Translated Light Novels/Are You Okay With a Slightly Older Girlfriend/";
    expect(extractUrlFromText(afterEquals)).toBe(
      "https://server.elsci.one/Officially%20Translated%20Light%20Novels/Are%20You%20Okay%20With%20a%20Slightly%20Older%20Girlfriend/",
    );
  });

  test("does not match Elscione domain mid-label or mid-path", () => {
    const notElsci = "https://notelsci.one/path";
    const evilElsci = "https://evil-elsci.one/secret";
    const notElscione = "https://notelscione.com/story";
    const whyLeft = "https://example.com/why-i-left-elscione.com/story";

    expect(isElscioneUrl(notElsci)).toBe(false);
    expect(isElscioneUrl(evilElsci)).toBe(false);
    expect(isElscioneUrl(notElscione)).toBe(false);
    expect(isElscioneUrl(whyLeft)).toBe(false);

    expect(extractUrlFromText(`Check ${notElsci}`)).toBe(notElsci);
    expect(extractUrlFromText(`Check ${evilElsci}`)).toBe(evilElsci);
    expect(extractUrlFromText(`Check ${notElscione}`)).toBe(notElscione);
    expect(extractUrlFromText(`Check ${whyLeft}`)).toBe(whyLeft);
  });
});

describe("Regression: Open Graph Metadata Attribute Ordering", () => {
  test("extractArticle accepts content before property/name for og:title, og:site_name, author, and published_time", async () => {
    const htmlWithContentFirst = `<!DOCTYPE html>
<html>
<head>
  <title>Generic Home Page</title>
  <meta content="Special OG Article Title" property="og:title">
  <meta content="The Custom Publication" property="og:site_name">
  <meta content="Jane Doe" name="author">
  <meta content="2026-05-15T08:00:00Z" property="article:published_time">
  <meta content="https://example.com/cover.jpg" property="og:image">
</head>
<body>
  <article>
    <p>${"In-depth analysis of open metadata protocols and attribute parsing robustness. ".repeat(20)}</p>
  </article>
</body>
</html>`;

    const origFetch = globalThis.fetch;
    try {
      globalThis.fetch = (async () => {
        return new Response(htmlWithContentFirst, {
          status: 200,
          headers: { "Content-Type": "text/html; charset=utf-8" },
        });
      }) as any;

      const article = await extractArticle("https://example.com/content-first-test");
      expect(article.title).toBe("Special OG Article Title");
      expect(article.siteName).toBe("The Custom Publication");
      expect(article.author).toBe("Jane Doe");
      expect(article.publishedDate).toContain("2026");
    } finally {
      globalThis.fetch = origFetch;
    }
  });

  test("extractArticle preserves property-first and name-first metadata attributes", async () => {
    const htmlWithPropertyFirst = `<!DOCTYPE html>
<html>
<head>
  <title>Generic Home Page</title>
  <meta property="og:title" content="Property First Title">
  <meta property="og:site_name" content="Property First Site">
  <meta property="article:author" content="John Smith">
  <meta property="article:published_time" content="2026-09-01T12:00:00Z">
</head>
<body>
  <article>
    <p>${"Understanding standard HTML meta attribute ordering in modern syndication engines. ".repeat(20)}</p>
  </article>
</body>
</html>`;

    const origFetch = globalThis.fetch;
    try {
      globalThis.fetch = (async () => {
        return new Response(htmlWithPropertyFirst, {
          status: 200,
          headers: { "Content-Type": "text/html; charset=utf-8" },
        });
      }) as any;

      const article = await extractArticle("https://example.com/property-first-test");
      expect(article.title).toBe("Property First Title");
      expect(article.siteName).toBe("Property First Site");
      expect(article.author).toBe("John Smith");
      expect(article.publishedDate).toContain("2026");
    } finally {
      globalThis.fetch = origFetch;
    }
  });
});

describe("Regression: Calibre Add Failure Handling in ingestArticleFromUrl", () => {
  test("ingestArticleFromUrl returns success: false with stderr when calibredb add exits non-zero", async () => {
    process.env.EBOOK_CONVERT_PATH = mockConvertScript!;
    const testTempDir = fs.mkdtempSync(path.join(os.tmpdir(), "article-add-fail-test-"));
    const testDropDir = path.join(testTempDir, "drop");
    fs.mkdirSync(testDropDir, { recursive: true });

    // Mock calibredb runner script that fails on add
    const mockCalibreScript = path.join(testTempDir, "mock_calibredb.sh");
    fs.writeFileSync(
      mockCalibreScript,
      `#!/bin/bash
if [ "$1" = "add" ]; then
  echo "calibredb: database is locked or corrupted" >&2
  exit 1
fi
echo "[]"
exit 0
`,
      { mode: 0o755 },
    );

    const prevDropEnv = process.env.BOOKS_DROP_DIR;
    const prevCalibrePath = process.env.CALIBREDB_PATH;
    process.env.BOOKS_DROP_DIR = testDropDir;
    process.env.CALIBREDB_PATH = mockCalibreScript;

    const prose = "Resilient ingestion services must abort immediately upon database write failures. ".repeat(25);
    const origFetch = globalThis.fetch;

    try {
      globalThis.fetch = (async () => {
        return new Response(
          `<html><head><title>Add Failure Test Article</title></head><body><article><p>${prose}</p></article></body></html>`,
          { status: 200, headers: { "Content-Type": "text/html; charset=utf-8" } },
        );
      }) as any;

      const res = await ingestArticleFromUrl("https://example.com/add-fail-test");
      expect(res.success).toBe(false);
      expect(res.error).toContain("database is locked or corrupted");
      expect(res.bookId).toBeUndefined();
    } finally {
      globalThis.fetch = origFetch;
      if (prevDropEnv !== undefined) process.env.BOOKS_DROP_DIR = prevDropEnv;
      else delete process.env.BOOKS_DROP_DIR;
      if (prevCalibrePath !== undefined) process.env.CALIBREDB_PATH = prevCalibrePath;
      else delete process.env.CALIBREDB_PATH;
      try {
        fs.rmSync(testTempDir, { recursive: true, force: true });
      } catch (_err) {
        void _err;
      }
    }
  });

  test("ingestArticleFromUrl retains parsed bookId from Added book ids: 99 without falling back to title search", async () => {
    process.env.EBOOK_CONVERT_PATH = mockConvertScript!;
    const testTempDir = fs.mkdtempSync(path.join(os.tmpdir(), "article-add-success-test-"));
    const testDropDir = path.join(testTempDir, "drop");
    fs.mkdirSync(testDropDir, { recursive: true });

    // Mock calibredb runner script: add succeeds with ID 99; if list was called by title, it would return ID 1
    const mockCalibreScript = path.join(testTempDir, "mock_calibredb.sh");
    fs.writeFileSync(
      mockCalibreScript,
      `#!/bin/bash
if [ "$1" = "add" ]; then
  echo "Added book ids: 99"
  exit 0
elif [ "$1" = "list" ]; then
  for arg in "$@"; do
    if [[ "$arg" =~ ^title: ]]; then
      echo '[{"id": 1, "title": "Added Book Test", "authors": "Author"}]'
      exit 0
    fi
  done
  echo "[]"
  exit 0
elif [ "$1" = "set_metadata" ]; then
  exit 0
fi
echo "[]"
exit 0
`,
      { mode: 0o755 },
    );

    const prevDropEnv = process.env.BOOKS_DROP_DIR;
    const prevCalibrePath = process.env.CALIBREDB_PATH;
    process.env.BOOKS_DROP_DIR = testDropDir;
    process.env.CALIBREDB_PATH = mockCalibreScript;

    const prose = "Consistent book ID allocation maintains library relational integrity. ".repeat(25);
    const origFetch = globalThis.fetch;

    try {
      globalThis.fetch = (async () => {
        return new Response(
          `<html><head><title>Added Book Test</title></head><body><article><p>${prose}</p></article></body></html>`,
          { status: 200, headers: { "Content-Type": "text/html; charset=utf-8" } },
        );
      }) as any;

      const res = await ingestArticleFromUrl("https://example.com/add-success-test");
      expect(res.success).toBe(true);
      expect(res.bookId).toBe(99);
      expect(res.duplicate).toBe(false);
    } finally {
      globalThis.fetch = origFetch;
      if (prevDropEnv !== undefined) process.env.BOOKS_DROP_DIR = prevDropEnv;
      else delete process.env.BOOKS_DROP_DIR;
      if (prevCalibrePath !== undefined) process.env.CALIBREDB_PATH = prevCalibrePath;
      else delete process.env.CALIBREDB_PATH;
      try {
        fs.rmSync(testTempDir, { recursive: true, force: true });
      } catch (_err) {
        void _err;
      }
    }
  });
});

describe("Article URL Sanitization & Tracking Parameter Stripping (stripTrackingParams)", () => {
  test("TRACKING_PARAMS set contains all specified marketing and analytics parameters", () => {
    const requiredKeys = [
      "utm_source",
      "utm_medium",
      "utm_campaign",
      "utm_term",
      "utm_content",
      "utm_id",
      "utm_source_platform",
      "fbclid",
      "gclid",
      "gclsrc",
      "dclid",
      "wbraid",
      "gbraid",
      "mc_eid",
      "mc_cid",
      "igshid",
      "_hsenc",
      "_hsmi",
      "ref",
      "ref_src",
      "source",
      "feature",
      "twclid",
      "si",
      "spm",
      "mkt_tok",
      "trk",
    ];
    for (const key of requiredKeys) {
      expect(TRACKING_PARAMS.has(key)).toBe(true);
    }
  });

  test("strips standard Google Analytics UTM parameters", () => {
    const input =
      "https://example.com/article?utm_source=twitter&utm_medium=social&utm_campaign=launch&utm_term=reading&utm_content=button&utm_id=456&utm_source_platform=ios";
    expect(stripTrackingParams(input)).toBe("https://example.com/article");
  });

  test("strips major ad click identifiers (fbclid, gclid, dclid, twclid, etc.)", () => {
    const input =
      "https://news.ycombinator.com/item?id=12345&fbclid=fb_123&gclid=g_456&gclsrc=aw.ds&dclid=d_789&wbraid=w_012&gbraid=g_345&twclid=tw_678";
    expect(stripTrackingParams(input)).toBe(
      "https://news.ycombinator.com/item?id=12345",
    );
  });

  test("strips newsletter and platform tracking tokens (mc_eid, igshid, hsenc, si, spm, trk, mkt_tok)", () => {
    const input =
      "https://newsletter.example.org/digest?mc_eid=abc1234&mc_cid=def5678&igshid=ig_xyz&_hsenc=hs_enc1&_hsmi=hs_mi2&mkt_tok=token123&trk=track_code&spm=100.200&si=spotify_si";
    expect(stripTrackingParams(input)).toBe(
      "https://newsletter.example.org/digest",
    );
  });

  test("strips referral and navigational tracking (ref, ref_src, source, feature)", () => {
    const input =
      "https://youtube.com/watch?v=dQw4w9WgXcQ&feature=share&ref=producthunt&ref_src=twsrc&source=feed_card";
    expect(stripTrackingParams(input)).toBe(
      "https://youtube.com/watch?v=dQw4w9WgXcQ",
    );
  });

  test("strips tracking parameters case-insensitively", () => {
    const input =
      "https://example.com/post?UTM_SOURCE=promo&FbClId=abc&GCLID=def&ID=999";
    expect(stripTrackingParams(input)).toBe("https://example.com/post?ID=999");
  });

  test("strips arbitrary custom parameters starting with utm_", () => {
    const input =
      "https://example.com/page?utm_custom_tag=test&utm_creative=banner_v2&article=tech-news";
    expect(stripTrackingParams(input)).toBe(
      "https://example.com/page?article=tech-news",
    );
  });

  test("preserves all legitimate functional query parameters", () => {
    const input =
      "https://example.com/search?q=distributed+systems&page=2&sort=recent&category=tech&filter=open-access&tab=all&lang=en";
    expect(stripTrackingParams(input)).toBe(input);
  });

  test("preserves functional parameters while stripping interspersed tracking parameters", () => {
    const input =
      "https://example.com/read?book=10&utm_source=mastodon&chapter=3&fbclid=xyz&offset=150#section-2";
    expect(stripTrackingParams(input)).toBe(
      "https://example.com/read?book=10&chapter=3&offset=150#section-2",
    );
  });

  test("preserves URL hash/fragment identifiers without tracking parameters", () => {
    const input =
      "https://example.com/essay.html?utm_campaign=newsletter#conclusion";
    expect(stripTrackingParams(input)).toBe(
      "https://example.com/essay.html#conclusion",
    );
  });

  test("returns unchanged string for clean URLs without query parameters", () => {
    const input = "https://paulgraham.com/foundermode.html";
    expect(stripTrackingParams(input)).toBe(input);
  });

  test("safely handles invalid, malformed, or empty inputs without throwing", () => {
    expect(stripTrackingParams("")).toBe("");
    expect(stripTrackingParams("not a valid url")).toBe("not a valid url");
    expect(stripTrackingParams("http://")).toBe("http://");
    expect(stripTrackingParams(null as any)).toBe("");
    expect(stripTrackingParams(undefined as any)).toBe("");
  });

  test("extractUrlFromText cleans tracking parameters from extracted text URLs", () => {
    const text =
      "Check this article: https://example.com/great-post?id=42&utm_source=twitter&utm_medium=feed and let me know!";
    expect(extractUrlFromText(text)).toBe("https://example.com/great-post?id=42");
  });

  test("validateArticleUrl strips tracking parameters on returned URL href", () => {
    const validated = validateArticleUrl(
      "https://example.com/clean-test?utm_campaign=fall&id=77",
    );
    expect(validated.href).toBe("https://example.com/clean-test?id=77");
    expect(validated.searchParams.get("utm_campaign")).toBeNull();
    expect(validated.searchParams.get("id")).toBe("77");
  });
});

describe("Upfront Calibre URL Duplicate Detection in ingestArticleFromUrl", () => {
  test("returns existing record early without network extraction when article URL is found in Calibre comments", async () => {
    const testTempDir = fs.mkdtempSync(
      path.join(os.tmpdir(), "article-dup-early-test-"),
    );
    const mockCalibreScript = path.join(testTempDir, "mock_calibredb.sh");

    fs.writeFileSync(
      mockCalibreScript,
      `#!/bin/bash
if [ "$1" = "list" ]; then
  # Echo matching record if comments search matches target clean URL
  for arg in "$@"; do
    if [[ "$arg" =~ comments:.*https://example.com/already-ingested ]]; then
      echo '[{"id": 42, "title": "Previously Ingested Architecture Guide", "authors": "Martin Fowler"}]'
      exit 0
    fi
  done
  echo "[]"
  exit 0
fi
echo "[]"
exit 0
`,
      { mode: 0o755 },
    );

    const prevCalibrePath = process.env.CALIBREDB_PATH;
    process.env.CALIBREDB_PATH = mockCalibreScript;

    let networkFetchCalled = false;
    const origFetch = globalThis.fetch;
    globalThis.fetch = (async () => {
      networkFetchCalled = true;
      throw new Error("Network fetch should not be called for duplicate articles");
    }) as any;

    try {
      const urlWithTracking =
        "https://example.com/already-ingested?utm_source=twitter&utm_medium=social&utm_campaign=summer#intro";

      const res = await ingestArticleFromUrl(urlWithTracking);

      expect(res.success).toBe(true);
      expect(res.duplicate).toBe(true);
      expect(res.bookId).toBe(42);
      expect(res.title).toBe("Previously Ingested Architecture Guide");
      expect(res.authors).toBe("Martin Fowler");
      expect(res.siteName).toBe("example.com");
      expect(res.wordCount).toBe(0);
      expect(res.readTimeMinutes).toBe(0);
      expect(res.format).toBe("EPUB");
      expect(res.message).toBe("Article already exists in Calibre (ID: 42)");
      expect(networkFetchCalled).toBe(false);
    } finally {
      globalThis.fetch = origFetch;
      if (prevCalibrePath !== undefined) {
        process.env.CALIBREDB_PATH = prevCalibrePath;
      } else {
        delete process.env.CALIBREDB_PATH;
      }
      try {
        fs.rmSync(testTempDir, { recursive: true, force: true });
      } catch (_err) {
        void _err;
      }
    }
  });

  test("handles array authors returned by calibredb list in duplicate detection", async () => {
    const testTempDir = fs.mkdtempSync(
      path.join(os.tmpdir(), "article-dup-authors-array-"),
    );
    const mockCalibreScript = path.join(testTempDir, "mock_calibredb.sh");

    fs.writeFileSync(
      mockCalibreScript,
      `#!/bin/bash
if [ "$1" = "list" ]; then
  for arg in "$@"; do
    if [[ "$arg" =~ comments:.*https://example.com/multi-author ]]; then
      echo '[{"id": 88, "title": "Collaborative Design Patterns", "authors": ["Alice Smith", "Bob Jones"]}]'
      exit 0
    fi
  done
fi
echo "[]"
exit 0
`,
      { mode: 0o755 },
    );

    const prevCalibrePath = process.env.CALIBREDB_PATH;
    process.env.CALIBREDB_PATH = mockCalibreScript;

    let networkFetchCalled = false;
    const origFetch = globalThis.fetch;
    globalThis.fetch = (async () => {
      networkFetchCalled = true;
      throw new Error("Network fetch should not be called for duplicate articles");
    }) as any;

    try {
      const res = await ingestArticleFromUrl(
        "https://example.com/multi-author?fbclid=track123",
      );

      expect(res.success).toBe(true);
      expect(res.duplicate).toBe(true);
      expect(res.bookId).toBe(88);
      expect(res.title).toBe("Collaborative Design Patterns");
      expect(res.authors).toBe("Alice Smith, Bob Jones");
      expect(res.siteName).toBe("example.com");
      expect(res.message).toBe("Article already exists in Calibre (ID: 88)");
      expect(networkFetchCalled).toBe(false);
    } finally {
      globalThis.fetch = origFetch;
      if (prevCalibrePath !== undefined) {
        process.env.CALIBREDB_PATH = prevCalibrePath;
      } else {
        delete process.env.CALIBREDB_PATH;
      }
      try {
        fs.rmSync(testTempDir, { recursive: true, force: true });
      } catch (_err) {
        void _err;
      }
    }
  });

  test("falls through to extraction when calibredb list finds no duplicate", async () => {
    const testTempDir = fs.mkdtempSync(
      path.join(os.tmpdir(), "article-dup-none-test-"),
    );
    const mockCalibreScript = path.join(testTempDir, "mock_calibredb.sh");

    fs.writeFileSync(
      mockCalibreScript,
      `#!/bin/bash
if [ "$1" = "list" ]; then
  echo "[]"
  exit 0
elif [ "$1" = "add" ]; then
  echo "Added book ids: 101"
  exit 0
elif [ "$1" = "set_metadata" ]; then
  exit 0
fi
echo "[]"
exit 0
`,
      { mode: 0o755 },
    );

    const testDropDir = path.join(testTempDir, "drop");
    fs.mkdirSync(testDropDir, { recursive: true });

    const prevDropEnv = process.env.BOOKS_DROP_DIR;
    const prevCalibrePath = process.env.CALIBREDB_PATH;
    process.env.BOOKS_DROP_DIR = testDropDir;
    process.env.CALIBREDB_PATH = mockCalibreScript;

    const prose =
      "Modern backend architectures require continuous monitoring and robust duplicate checking. ".repeat(
        25,
      );
    const origFetch = globalThis.fetch;

    try {
      globalThis.fetch = (async () => {
        return new Response(
          `<html><head><title>Fresh Ingest Article</title></head><body><article><p>${prose}</p></article></body></html>`,
          {
            status: 200,
            headers: { "Content-Type": "text/html; charset=utf-8" },
          },
        );
      }) as any;

      const res = await ingestArticleFromUrl(
        "https://example.com/fresh-article?utm_source=hackernews",
      );

      expect(res.success).toBe(true);
      expect(res.duplicate).toBe(false);
      expect(res.bookId).toBe(101);
      expect(res.title).toBe("Fresh Ingest Article");
    } finally {
      globalThis.fetch = origFetch;
      if (prevDropEnv !== undefined) {
        process.env.BOOKS_DROP_DIR = prevDropEnv;
      } else {
        delete process.env.BOOKS_DROP_DIR;
      }
      if (prevCalibrePath !== undefined) {
        process.env.CALIBREDB_PATH = prevCalibrePath;
      } else {
        delete process.env.CALIBREDB_PATH;
      }
      try {
        fs.rmSync(testTempDir, { recursive: true, force: true });
      } catch (_err) {
        void _err;
      }
    }
  });
});


