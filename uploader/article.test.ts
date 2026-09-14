import { describe, test, expect } from "bun:test";
import {
  isPaywallOrGarbage,
  cleanMarkdownNoise,
  cleanDirectHtml,
  PAYWALL_ERROR_MESSAGE,
  extractArticle
} from "./article";

describe("Paywall Barrier & Content Quality Detection", () => {
  test("flags content with link density > 50% when totalTextLen > 200", () => {
    // 250 total chars, 150 link chars => 60% link density
    const text = "A".repeat(100) + "[Link Text](" + "https://example.com/".repeat(5) + ")" + "B".repeat(50);
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
      "To continue reading, please subscribe"
    ];

    for (const marker of markers) {
      // 200 words of dummy text + marker
      const dummyProse = "The financial markets saw substantial trading activity across all major global asset classes today. ".repeat(20);
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
      "Ultimately, successful engineering organizations cultivate strong engineering hygiene through automated testing, continuous integration, and disciplined operational runbooks that allow teams to recover rapidly from outages."
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
    const article = await extractArticle("https://paulgraham.com/foundermode.html");
    expect(article.title).toBe("Founder Mode");
    expect(article.wordCount).toBeGreaterThan(500);
    expect(article.cleanedHtml).not.toContain("<map");
    expect(article.cleanedHtml).not.toContain("<area");
    expect(article.cleanedHtml).not.toContain("usemap");
  }, 30000);

  test("Financial Times paywall page is cleanly rejected with PAYWALL_ERROR_MESSAGE", async () => {
    const ftUrl = "https://www.ft.com/content/4564e6a5-69e9-40a6-bf0f-a888f2f4f002";
    let thrownError: Error | null = null;
    try {
      await extractArticle(ftUrl);
    } catch (err: any) {
      thrownError = err;
    }
    expect(thrownError).not.toBeNull();
    expect(thrownError?.message).toBe(PAYWALL_ERROR_MESSAGE);
  }, 30000);
});
