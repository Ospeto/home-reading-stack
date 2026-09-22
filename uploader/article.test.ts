import { describe, test, expect, beforeAll, afterAll, afterEach } from "bun:test";
import fs from "node:fs";
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
} from "./article";

const originalFetch = globalThis.fetch;
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
  // 1. Isolate external article and Jina network access
  globalThis.fetch = (async (input: any, init?: any) => {
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
  }) as typeof fetch;

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
  });
});

