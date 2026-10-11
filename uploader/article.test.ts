import { describe, test, expect, beforeAll, afterAll, afterEach } from "bun:test";
import { Buffer } from "node:buffer";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import process from "node:process";
import { spawnSync } from "node:child_process";
import {
  isPaywallOrGarbage,
  cleanMarkdownNoise,
  cleanDirectHtml,
  COOKIE_BANNER_PATTERNS,
  NEWSLETTER_PATTERNS,
  PROMO_SOCIAL_PATTERNS,
  isCookieBannerBlock,
  isNewsletterBlock,
  isPromoSocialBlock,
  isArticleNoise,
  PAYWALL_ERROR_MESSAGE,
  extractArticle,
  extractArticleViaJina,
  wrapText,
  escapeXml,
  generateTypographicCover,
  parseJinaMarkdown,
  convertHtmlToEpub,
  markdownToHtml,
  buildStyledHtmlDocument,
  ingestArticleFromUrl,
  extractUrlFromText,
  extractAllUrlsFromText,
  isBotChallengeTitle,
  isCloudflareChallenge,
  stripTrackingParams,
  validateArticleUrl,
  TRACKING_PARAMS,
  FAST_FAIL_ARTICLE_DOMAINS,
  isFastFailArticleDomain,
  isFastFailDomain,
  compute429BackoffMs,
  decodeAndSaveBase64Image,
  extractAndSaveBase64Images,
  isTrackingOrSpacerPixel,
  isValidImageBuffer,
  hasSips,
  detectImageFormat,
  downloadCoverImage,
} from "./article";
import { isElscioneUrl } from "./elscione";
import { evaluateJunkGate } from "./jev-shelf";
import { setFirecrawlEnabled, scrapeArticleWithFirecrawl } from "./firecrawl";

let originalFetch = globalThis.fetch;
let mockArticleFetch: any = null;
let mockConvertScript: string | null = null;
let origEbookConvertPath: string | undefined;
let lastJinaRequest: { url: string; headers: any } | null = null;

const SAMPLE_JPEG_B64 =
  "/9j/4AAQSkZJRgABAQAASABIAAD/4QBMRXhpZgAATU0AKgAAAAgAAYdpAAQAAAABAAAAGgAAAAAAA6ABAAMAAAABAAEAAKACAAQAAAABAAAAUKADAAQAAAABAAAAUAAAAAD/7QA4UGhvdG9zaG9wIDMuMAA4QklNBAQAAAAAAAA4QklNBCUAAAAAABDUHYzZjwCyBOmACZjs+EJ+/8AAEQgAUABQAwEiAAIRAQMRAf/EAB8AAAEFAQEBAQEBAAAAAAAAAAABAgMEBQYHCAkKC//EALUQAAIBAwMCBAMFBQQEAAABfQECAwAEEQUSITFBBhNRYQcicRQygZGhCCNCscEVUtHwJDNicoIJChYXGBkaJSYnKCkqNDU2Nzg5OkNERUZHSElKU1RVVldYWVpjZGVmZ2hpanN0dXZ3eHl6g4SFhoeIiYqSk5SVlpeYmZqio6Slpqeoqaqys7S1tre4ubrCw8TFxsfIycrS09TV1tfY2drh4uPk5ebn6Onq8fLz9PX29/j5+v/EAB8BAAMBAQEBAQEBAQEAAAAAAAABAgMEBQYHCAkKC//EALURAAIBAgQEAwQHBQQEAAECdwABAgMRBAUhMQYSQVEHYXETIjKBCBRCkaGxwQkjM1LwFWJy0QoWJDThJfEXGBkaJicoKSo1Njc4OTpDREVGR0hJSlNUVVZXWFlaY2RlZmdoaWpzdHV2d3h5eoKDhIWGh4iJipKTlJWWl5iZmqKjpKWmp6ipqrKztLW2t7i5usLDxMXGx8jJytLT1NXW19jZ2uLj5OXm5+jp6vLz9PX29/j5+v/bAEMAAgICAgICAwICAwUDAwMFBgUFBQUGCAYGBgYGCAoICAgICAgKCgoKCgoKCgwMDAwMDA4ODg4ODw8PDw8PDw8PD//bAEMBAgICBAQEBwQEBxALCQsQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEP/dAAQABf/aAAwDAQACEQMRAD8A/Jeiiivyc/0ACiiigAooooAKKKKACiiigD//0PyXoor6A+D/AOz5qvxk8NeKvFGleK9D0K38GWzX2pRao18syWark3CC2tLhXXOV2qxkyPuYKk/lVOnKb5Y7n974vGU6EPaVXZf56LbzPn+ivtNf2IfGt2fC1to3jrwnqWo+OLH+0NCso7q+gn1CDGf3RurGGJX4PySOjZGMZrgdP/Ze8aWvhWbxx8StY0v4daGl9PpsM2uSXHnXV1au0dwltbWcFzNIInUq77AgP8Rwa2eDqrdHnQ4iwUlpUV9ra3e60VrvVPZdH2PmqivX/i58HdT+EUvh37Zrul+I7TxPpw1OzvNIllmtngM0sGN0sUTBw0R3KVBXocMCB5BWM4OLtI9PDYmFaCqU3dMKKKKg3CiiigD/0fyXr9E/2c/BPiLwJ+zZ8Yvir4pgjsfC/jPwrc6fpV208RFxeJd+QYNgYushcHarAFgCwyOa/Oyn+Y5QRFjsBJC54yepx68V+XYesqcua1z+7M3y+WKpKipcqum9L3Sd7LVWd0tdfQ/Xr40eMvG/7N3ww/Z98Zx/Dq2k8R6T4cW0h1fWYLxjpV24LeQIFligW4KEuBMjOMHA+U48/wDjbp/jD9rL4AfCjxx8MY5fGGueDbW7sPEul2a+dqMF7O8bm7NrHmR0uWRnLopGSPRgv5hVJFNNA4lgdo3HRlJB59xXXPMOa8WvdaWnpbXbyPn8NwgqPs6sJr2sJSfNZ2alze7bm0XvO1mtdbb3+4P2xfDPhXwXoPwq0LTfClj4V8R3egJfa5awPOZ7e8lcgwvFNNIYVyGcIQDuY5NfDdKSScnkmkrjxFVTm5JWPo8qwMsNQjRlPmavq79W31bel7LVhRRRWJ6IUUUUAf/S/Jeiiivyc/0ACiiigAooooAKKKKACiiigD//0/yXooor8nP9AAooooAKKKKACiiigAooooA//9k=";

const SAMPLE_PNG_B64 =
  "iVBORw0KGgoAAAANSUhEUgAAAFAAAABQCAYAAACOEfKtAAAAAXNSR0IArs4c6QAAAERlWElmTU0AKgAAAAgAAYdpAAQAAAABAAAAGgAAAAAAA6ABAAMAAAABAAEAAKACAAQAAAABAAAAUKADAAQAAAABAAAAUAAAAAAx4ExPAAAE4ElEQVR4Ae2ba0iWZxjH/6+n0jczzXSvqSmNlIRR6SBjBUaHEZRNsAP7MDZo+FkIBu1DK+yDzFqMirIDgQVGxRgxqKSwAl2m2WA5aBaWMw+V5jwfu66bnmePLznevAye4rrg9blP/+fwe/73fd3PBz3YvXscGlMmEDRlpQoNAQUoNIICVIBCAkK5OlABCgkI5epABSgkIJSrAxWgkIBQrg5UgEICQrk6UAEKCQjl6kAFKCQglKsDFaCQgFCuDlSAQgJCuTpQAQoJCOXqQAUoJCCUqwMVoJCAUK4OFAIMEeqnVf6R14vQ4GB0DQzg36EhxEVEmPO39/VN63Wm82QBA/ynsBAJkZETrv2cHuy3Bw9woaEBM+jBT23ejIjQUIyOjeHzsjJUPHpkxocFBaF9505EzZxp6sOjo1h+/DjqWlsRGRaGH9etQ25aGuJnzbLP/+TlS4TTuX6qrkbRzZt2u9sKAU/h5AMHUNvSYu7/cE0NVpw4gf1VVdiSkYFftm3DwpgYLD50CJ39/QgmYOX5+VgYHW3GDxHQ2OJiXGlsRHN3N3wlJQbex9R/r6AA32Zmou7pU2QePQpvURGyjh1DY2cnYsmB/ELcHAEDHB0fx58dHeZZ2B1Vzc3Yd+sWSuvqTNs3S5eiidq7BwdNPSY8HL9u324cxg0jpL9DL6CBzvGcIHuo7WRuLlIJ4lUCu+HsWQO1b2QEtQRzw5kz+PvFiw8HIEMYJwj+0UNrlTOGaHqW1tZihFy3eN48lOXlGVg8hqfuMLVzfJacjJULFpjydxUV5uj8008g88+dw+n6emez68oBO9D/zkNpmq5JTUVBVpbpOn//vj2ksqkJhZcvm/omWtv25uTYfVbhk/h4U+SXYjnb6stOTMTGRYuQFBVlfpk+n9XlumPAScR557tWrcIPBCWMEsdfz57h5N27+P7aNecQ/Hz7NvjBv1qyBDz+j7a2Cf3zXycknvKD5ExnrEhKQmF2tp209lES4WntxpgSwIqHD3GEEglDae3tnfS5Ci5dQkZcHLISEkyGZp0VvL5xcGb2UqLoHR62ulBCyWmMnLl//XpzjV1+L8ce6ILClKbw75RArhCM/4PHzzZAzsorL0c7QeZsytPZinrawlixmpYC/+BszdHW0+Pf5ar6WwHkTS4Hb1MmixkhIQinnxVPCAQnA04gzmCA11/vE4vXrp2gcY5ze3lyEn53zpvhDMqqHMtobeNtiH+kzZ0LH22GeQ1znvjG48d2UrE0nIu/vHgRreSw9NhY1OzYgZyUFEQQfF4fnW61NG48egL9N4cW+hLxOb5Emrq6kHLwoP1MeenpuLB1q13nPd+npaV2nQunaN83h9a8L2haWxFDdU5IX1Oy8dJXSR+thTzdeepW01Kxp7LS7A+t8W47BgxwOm6cP/eiCdib1k52dOLs2Qj2eExC6XDx96+TxX+LlbP1HZV5u/ImeHw53qLzevm+hXOpet/u3RX3qwCFr0EBKkAhAaFcHagAhQSEcnWgAhQSEMrVgQpQSEAoVwcqQCEBoVwdqACFBIRydaACFBIQytWBClBIQChXBypAIQGhXB2oAIUEhHJ1oAIUEhDK1YEKUEhAKFcHKkAhAaFcHagAhQSEcnWgAhQSEMrVgQpQSEAoVwcqQCEBoVwdqACFBITyV+LRZz6kyfXiAAAAAElFTkSuQmCC";

const SAMPLE_WEBP_B64 =
  "UklGRgwEAABXRUJQVlA4IAAEAADQHgCdASrIAMgAPpFIokulpKOhpDI4KLASCWVu4XPxA1k/aBsSHYvxi/HbkWe6H4jdLsePqh/GfZ3vCP+W+x3hAfqz1M/0A/wHuAfrN1lfoAfq56U/6s/Br+vH66e0vFQjAOwIMCVA9yT4AQwJASAkBICQEgJASAkBICQEgJARh7VWLvCh+ZwlpOC2KSVdlFrua/LP4bwldbDpIsQWHRfygo4X5Z/aBWMza/UFYkFYrJ0fnoBvctI0Beze7Fj7WAHyAOdgItJVk4DqxnvGSFFXLNIsAUGP7z6SRidk6QYm2cXON3nqDqOAEiNpJ2T7SZWS4lxLiXEuJcS4lxLiWcAA/v7K8/U8hmUR1fzDFuiRZmL+AAFBpNuoM6SQ/+iR9MP4SZIS0AqMGQL5vUo4QL1ZHEpYDmdtwCkn+7mKdlePD05Y8HL+nzjO+zbxpBeZpEaLAStK09Usc+iwDWoOOaJxMc1+0LNtlkf+DXhUidfDcknbQtN2rNfAV5nQoXqvLoQI0h6FFVOcp0bNRrSYNAjjkxOLGOeaiJtmCj8CFJ/H8THMUmO8rXxs/2dPwwXX5VFxShNYF9o1zrR5EETXBsZIQI7AfIOBxpj2+mqjtuRrDrhH5BeQ7j3vTsUEuqC2Qgjz0ek8VTx3QFKXjsLYyUza74OX4JgqHxp//PC5DDW8vPshVF8WCbuSGKbHWspFaM2rz5XyqTNYKiTsTFtYRMFPJdvCg386yFIUQfxld5LqJZc023lHZTHDOMMlqu5Qd4rlpg6JyMvX91sfzGF047iV98hPceDvC5y8lgUbBYtFxEljupP4yxS/YUaltykQ861r6LTvTk2M227q4wTb9wekJUDwWo7//onGi2AodAtz5TntYQTo2vGX4HoI55wgUal9JgKss20EskBwX8cNiEZNPoSb/vbuWGzXxbeTykTYGZvwRzyUlEVq11HPE/+1J7pbnbVkXI4uljEcgwLxYVXhV+TvPk3jvXjPQSrai5XwTJ70NMJt3ChIf5w72WXIEeio4ua/Aar5+CNVn9Ji5iRV7oxuZLhhy+afSuRlrYeE+Wp7O3aMQXeE8z6tDPfDvBUycPDQUVpa5UJYJMN60OCHepdS+Rr43XkrWk/S8azO2WJM/OvChrgnzNaSC2AucBqaJmhjwgAJovIIdCutFJI2qGX39mt9ihg8dsLyaf6MDN84AjSqCjR6d887rDR0m3giSPl/TGou0+Z+xZ1BBd2obNWdg1u38TqmEqH8RS1SZlSTf+TvglDP/BTTvqkqiMoLTxbnS9S9J9Y7sq8BK/iwWcSft4TYcjufQbSMB1yd63+ALw6r1R/54R1xmtzng15IPVgfhnWO/8CYAAAAAAAA";

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

    // Intercept cover image test requests on allowed cover domains
    if (urlStr.includes("covers.openlibrary.org")) {
      if (urlStr.includes(".jpg")) {
        return new Response(Buffer.from(SAMPLE_JPEG_B64, "base64"), {
          status: 200,
          headers: { "Content-Type": "image/jpeg" },
        });
      }
      if (urlStr.includes(".png")) {
        return new Response(Buffer.from(SAMPLE_PNG_B64, "base64"), {
          status: 200,
          headers: { "Content-Type": "image/png" },
        });
      }
      if (urlStr.includes(".webp")) {
        return new Response(Buffer.from(SAMPLE_WEBP_B64, "base64"), {
          status: 200,
          headers: { "Content-Type": "image/webp" },
        });
      }
      if (urlStr.includes(".avif")) {
        const avifHeader = Buffer.from([0x00, 0x00, 0x00, 0x20, 0x66, 0x74, 0x79, 0x70, 0x61, 0x76, 0x69, 0x66]);
        const avifBuf = Buffer.concat([avifHeader, Buffer.alloc(1100, 0x5a)]);
        return new Response(avifBuf, {
          status: 200,
          headers: { "Content-Type": "image/avif" },
        });
      }
      if (urlStr.includes(".unknown")) {
        return new Response(Buffer.alloc(1200, 0x42), {
          status: 200,
          headers: { "Content-Type": "application/octet-stream" },
        });
      }
      if (urlStr.includes(".mislabeled")) {
        return new Response(Buffer.from("<html><body>Error 404 page content</body></html>".repeat(30)), {
          status: 200,
          headers: { "Content-Type": "image/jpeg" },
        });
      }
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
if [ -n "$MOCK_EBOOK_CONVERT_LOG" ]; then
  printf "%s\n" "$@" > "$MOCK_EBOOK_CONVERT_LOG"
fi
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

describe("GDPR Cookie Banner, Newsletter & Promo Social Noise Cleanup", () => {
  test("Markdown cleaner strips cookie consent notices, newsletter callouts, and promo social lines", () => {
    const mdInput = `
Title: Modern Systems Architecture
URL Source: https://example.com/arch

Markdown Content:
We use cookies to improve your experience. By continuing to visit this site you agree to our use of cookies. [Accept All Cookies](https://example.com/accept) [Cookie Policy](https://example.com/cookies)

[Accept all cookies](https://example.com/accept) | [Manage cookie preferences](https://example.com/cookies)

# Modern Systems Architecture

Modern software architecture increasingly favors decoupled services with explicit domain boundaries. Each component exposes clearly defined APIs while maintaining isolated data persistence layers.

High-throughput systems require careful attention to tail latencies, event-driven backpressure mechanisms, and graceful degradation during network partitions.

Sign up for our newsletter to get weekly architecture insights delivered to your inbox every Monday!

Subscribe for daily updates from our engineering editors.

Observability remains a critical pillar of production readiness, encompassing distributed tracing, metrics aggregation, and actionable alerting thresholds.

Follow us on Twitter: @systemsarch or LinkedIn: in/systemsarch for daily diagrams.

If you enjoyed this breakdown, follow me on X (@devarchitect) for more engineering essays!
`;

    const cleaned = cleanMarkdownNoise(mdInput);

    // Cookie banner removal
    expect(cleaned).not.toContain("We use cookies to improve your experience");
    expect(cleaned).not.toContain("Accept All Cookies");
    expect(cleaned).not.toContain("Manage cookie preferences");

    // Newsletter callouts removal
    expect(cleaned).not.toContain("Sign up for our newsletter");
    expect(cleaned).not.toContain("delivered to your inbox");
    expect(cleaned).not.toContain("Subscribe for daily updates");

    // Promo social follow lines removal
    expect(cleaned).not.toContain("Follow us on Twitter");
    expect(cleaned).not.toContain("follow me on X");
    expect(cleaned).not.toContain("in/systemsarch");

    // Main article prose retention
    expect(cleaned).toContain("# Modern Systems Architecture");
    expect(cleaned).toContain(
      "Modern software architecture increasingly favors decoupled services",
    );
    expect(cleaned).toContain(
      "Observability remains a critical pillar of production readiness",
    );
  });

  test("HTML cleaner strips cookie banners, newsletter popovers, and promo social lines", () => {
    const htmlInput = `
<html>
<head><title>Architecture Review</title></head>
<body>
  <div class="cookie-banner">
    <p>We use cookies to enhance your browsing experience. <button>Accept all cookies</button> <a href="/cookies">Cookie Policy</a></p>
  </div>
  <div role="dialog" aria-label="cookie consent">
    <p>Please review and manage cookie preferences before continuing.</p>
  </div>
  <p>We use cookies to optimize site functionality and deliver the best experience on our website. <a href="#">Manage preferences</a></p>
  <main>
    <article>
      <h1>Distributed Cache Topologies</h1>
      <p>Distributed caching strategies play a vital role in reducing database load and improving response times across high-traffic microservices.</p>
      <div class="newsletter-popover">
        <h3>Stay Connected</h3>
        <p>Sign up for our newsletter to get the latest tech insights delivered to your inbox.</p>
      </div>
      <p>Cache invalidation protocols such as lease-based expiration and write-through caching ensure consistency across geographically distributed nodes.</p>
      <p>Subscribe for daily updates on cloud infrastructure and performance tuning.</p>
      <p>Follow us on Twitter: @cachetech or LinkedIn: /in/cachetech</p>
    </article>
  </main>
</body>
</html>
`;

    const cleaned = cleanDirectHtml(htmlInput);

    // Verify cookie banners removed
    expect(cleaned).not.toContain("cookie-banner");
    expect(cleaned).not.toContain("Accept all cookies");
    expect(cleaned).not.toContain("manage cookie preferences");
    expect(cleaned).not.toContain("We use cookies to optimize site functionality");

    // Verify newsletter callouts removed
    expect(cleaned).not.toContain("newsletter-popover");
    expect(cleaned).not.toContain("Sign up for our newsletter");
    expect(cleaned).not.toContain("delivered to your inbox");
    expect(cleaned).not.toContain("Subscribe for daily updates");

    // Verify promo social follow lines removed
    expect(cleaned).not.toContain("Follow us on Twitter");
    expect(cleaned).not.toContain("@cachetech");

    // Verify article content retained
    expect(cleaned).toContain("Distributed Cache Topologies");
    expect(cleaned).toContain(
      "Distributed caching strategies play a vital role",
    );
    expect(cleaned).toContain(
      "Cache invalidation protocols such as lease-based expiration",
    );
  });

  test("Technical articles discussing HTTP cookies, web browsers, and privacy regulations are preserved without false-positive removal", () => {
    const techMdInput = `
Title: Web Security: Deep Dive into Cookie Authentication
URL Source: https://example.com/security/cookies

Markdown Content:
# Web Security: Deep Dive into Cookie Authentication

HTTP cookies remain the foundational mechanism for maintaining user identity across stateless web protocols. When an HTTP server authenticates credentials, it issues a Set-Cookie response header containing an opaque session token.

In modern web development, we use cookies to maintain user session state across distributed services and authenticate incoming API requests. However, security considerations such as HttpOnly and SameSite flags are critical to prevent cross-site scripting (XSS) and cross-site request forgery (CSRF).

A robust cookie policy ensures that sensitive authentication tokens are never exposed to client-side scripts. Organizations operating under GDPR and privacy regulations must design their systems to comply with data protection standards while preserving application performance.

In this architecture, we use cookies to store session tokens across stateless HTTP requests.

A strict cookie policy prevents unauthorized cross-origin requests by enforcing SameSite=Strict on all mutating API endpoints.

Compliance with GDPR and privacy regulations requires engineering teams to document session lifecycles and ensure consent boundaries are respected.

\`\`\`javascript
// Configure secure cookie policy in Express
app.use(session({
  cookie: {
    httpOnly: true,
    secure: true,
    sameSite: 'strict',
    maxAge: 86400000,
  }
}));
\`\`\`
`;

    const cleaned = cleanMarkdownNoise(techMdInput);

    // Confirm all technical discussions mentioning cookies are intact
    expect(cleaned).toContain("Web Security: Deep Dive into Cookie Authentication");
    expect(cleaned).toContain("HTTP cookies remain the foundational mechanism");
    expect(cleaned).toContain(
      "we use cookies to maintain user session state across distributed services",
    );
    expect(cleaned).toContain(
      "A robust cookie policy ensures that sensitive authentication tokens are never exposed",
    );
    expect(cleaned).toContain(
      "Organizations operating under GDPR and privacy regulations must design their systems",
    );
    expect(cleaned).toContain(
      "we use cookies to store session tokens across stateless HTTP requests",
    );
    expect(cleaned).toContain(
      "A strict cookie policy prevents unauthorized cross-origin requests",
    );
    expect(cleaned).toContain(
      "Compliance with GDPR and privacy regulations requires engineering teams",
    );
    expect(cleaned).toContain("sameSite: 'strict'");
  });

  test("Technical HTML articles discussing browser cookies and cookie policy are preserved intact", () => {
    const techHtmlInput = `
<article>
  <h1>HTTP Cookies and Web Architecture</h1>
  <p>In modern web applications, we use cookies to persist session tokens between stateless HTTP requests across backend services.</p>
  <p>A strict cookie policy prevents unauthorized cross-origin requests by enforcing SameSite=Strict on all mutating API endpoints.</p>
  <p>Under GDPR and privacy regulations, web browsers restrict third-party tracking while permitting essential functional cookies.</p>
  <pre><code>Set-Cookie: session=xyz; HttpOnly; Secure; SameSite=Strict</code></pre>
</article>
`;

    const cleaned = cleanDirectHtml(techHtmlInput);

    expect(cleaned).toContain("HTTP Cookies and Web Architecture");
    expect(cleaned).toContain(
      "we use cookies to persist session tokens between stateless HTTP requests",
    );
    expect(cleaned).toContain(
      "A strict cookie policy prevents unauthorized cross-origin requests",
    );
    expect(cleaned).toContain(
      "Under GDPR and privacy regulations, web browsers restrict third-party tracking",
    );
    expect(cleaned).toContain(
      "Set-Cookie: session=xyz; HttpOnly; Secure; SameSite=Strict",
    );
  });

  test("Targeted noise regex patterns and helper functions correctly identify noise and preserve technical context", () => {
    // Cookie banner patterns
    expect(
      COOKIE_BANNER_PATTERNS.some((p) =>
        p.test("We use cookies to improve your experience"),
      ),
    ).toBe(true);
    expect(
      COOKIE_BANNER_PATTERNS.some((p) => p.test("Accept all cookies")),
    ).toBe(true);
    expect(
      COOKIE_BANNER_PATTERNS.some((p) =>
        p.test("Manage cookie preferences"),
      ),
    ).toBe(true);
    expect(
      COOKIE_BANNER_PATTERNS.some((p) => p.test("Manage preferences")),
    ).toBe(true);
    expect(
      COOKIE_BANNER_PATTERNS.some((p) => p.test("Review our Cookie Policy")),
    ).toBe(true);

    // Newsletter patterns
    expect(
      NEWSLETTER_PATTERNS.some((p) => p.test("Sign up for our newsletter")),
    ).toBe(true);
    expect(
      NEWSLETTER_PATTERNS.some((p) =>
        p.test("Delivered to your inbox every morning"),
      ),
    ).toBe(true);
    expect(
      NEWSLETTER_PATTERNS.some((p) => p.test("Subscribe for daily updates")),
    ).toBe(true);

    // Social promo patterns
    expect(
      PROMO_SOCIAL_PATTERNS.some((p) =>
        p.test("Follow us on Twitter: @user"),
      ),
    ).toBe(true);
    expect(
      PROMO_SOCIAL_PATTERNS.some((p) =>
        p.test("Follow me on X (@developer)"),
      ),
    ).toBe(true);
    expect(
      PROMO_SOCIAL_PATTERNS.some((p) => p.test("Follow us on LinkedIn")),
    ).toBe(true);

    // Helper functions: cookie banners vs technical prose
    expect(
      isCookieBannerBlock(
        "We use cookies to improve your experience. [Accept All Cookies]",
      ),
    ).toBe(true);
    expect(isCookieBannerBlock("Accept all cookies")).toBe(true);
    expect(isCookieBannerBlock("Manage cookie preferences")).toBe(true);
    expect(
      isCookieBannerBlock(
        "We use cookies to store session tokens across stateless HTTP requests.",
      ),
    ).toBe(false);
    expect(
      isCookieBannerBlock(
        "A strict cookie policy prevents unauthorized cross-origin requests with SameSite.",
      ),
    ).toBe(false);

    // Helper functions: newsletters
    expect(
      isNewsletterBlock(
        "Sign up for our newsletter to get weekly updates delivered to your inbox.",
      ),
    ).toBe(true);
    expect(
      isNewsletterBlock("Subscribe for daily updates on machine learning."),
    ).toBe(true);

    // Helper functions: promo social
    expect(isPromoSocialBlock("Follow us on Twitter: @team")).toBe(true);
    expect(isPromoSocialBlock("Follow me on LinkedIn: in/dev")).toBe(true);

    // Article noise unified check
    expect(isArticleNoise("Sign up for our newsletter today!")).toBe(true);
    expect(isArticleNoise("Follow us on Twitter: @hello")).toBe(true);
    expect(isArticleNoise("Accept all cookies")).toBe(true);
    expect(
      isArticleNoise(
        "This is genuine article prose explaining distributed systems algorithms.",
      ),
    ).toBe(false);
  });
});

describe("Adversarial Noise Regression: Lelouch Review Findings", () => {
  test("preserves inline code and fenced code blocks in cookie discussions with single newline intro", () => {
    const mdInput = `
# Session Authentication Architecture

We use cookies to set \`token\` authentication.
Here is the client request configuration:
\`\`\`javascript
const sessionToken = getCookie("token");
api.setAuthHeader(sessionToken);
\`\`\`

The server inspects the cookie token on every incoming request.
`;

    const cleaned = cleanMarkdownNoise(mdInput);

    expect(cleaned).toContain("We use cookies to set `token` authentication.");
    expect(cleaned).toContain("Here is the client request configuration:");
    expect(cleaned).toContain("```javascript");
    expect(cleaned).toContain('const sessionToken = getCookie("token");');
    expect(cleaned).toContain("api.setAuthHeader(sessionToken);");
    expect(cleaned).toContain("```");
    expect(cleaned).toContain("The server inspects the cookie token on every incoming request.");
  });

  test("preserves headings discussing newsletter architecture, network walkthroughs, and protocol updates", () => {
    const mdInput = `
# Engineering Deep Dives

## Newsletter Service Architecture
Designing high-throughput asynchronous email dispatch pipelines using Redis streams and worker pools.

## Follow me through the kernel network stack
Tracing packet traversal from the physical NIC through driver rings, netfilter hooks, and socket receive queues.

## Stay updated on RFC 9114
The HTTP/3 specification defines transport over QUIC to eliminate head-of-line blocking in modern browsers.
`;

    const cleaned = cleanMarkdownNoise(mdInput);

    expect(cleaned).toContain("## Newsletter Service Architecture");
    expect(cleaned).toContain(
      "Designing high-throughput asynchronous email dispatch pipelines using Redis streams and worker pools.",
    );
    expect(cleaned).toContain("## Follow me through the kernel network stack");
    expect(cleaned).toContain(
      "Tracing packet traversal from the physical NIC through driver rings, netfilter hooks, and socket receive queues.",
    );
    expect(cleaned).toContain("## Stay updated on RFC 9114");
    expect(cleaned).toContain(
      "The HTTP/3 specification defines transport over QUIC to eliminate head-of-line blocking in modern browsers.",
    );
  });

  test("preserves HTML sections and divs with semantic IDs and classes like gdpr-compliance, cookie-security, subscriber-handler", () => {
    const htmlInput = `
<article>
  <h1>Privacy and Messaging Infrastructure</h1>
  <section id="gdpr-compliance">
    <h2>GDPR Compliance Framework</h2>
    <p>Articles 6 and 7 govern lawful processing requirements and user data subject rights across European jurisdictions.</p>
  </section>
  <div class="cookie-security">
    <h2>Cookie Security Architecture</h2>
    <p>Enforcing SameSite=Strict and HttpOnly attributes prevents token theft via cross-site scripting and forgery vectors.</p>
  </div>
  <div class="subscriber-handler">
    <h2>Subscriber Handler Implementation</h2>
    <p>The event dispatcher consumes Kafka topics and pushes notifications to registered subscriber worker processes.</p>
  </div>
</article>
`;

    const cleaned = cleanDirectHtml(htmlInput);

    expect(cleaned).toContain('id="gdpr-compliance"');
    expect(cleaned).toContain("GDPR Compliance Framework");
    expect(cleaned).toContain(
      "Articles 6 and 7 govern lawful processing requirements and user data subject rights across European jurisdictions.",
    );
    expect(cleaned).toContain('class="cookie-security"');
    expect(cleaned).toContain("Cookie Security Architecture");
    expect(cleaned).toContain(
      "Enforcing SameSite=Strict and HttpOnly attributes prevents token theft via cross-site scripting and forgery vectors.",
    );
    expect(cleaned).toContain('class="subscriber-handler"');
    expect(cleaned).toContain("Subscriber Handler Implementation");
    expect(cleaned).toContain(
      "The event dispatcher consumes Kafka topics and pushes notifications to registered subscriber worker processes.",
    );
  });

  test("drops only noise items in mixed bullet lists while preserving valid content items", () => {
    const mdInput = `
# Operational Runbook

Perform the following steps during initial deployment:

- Read docs
- Sign up for our newsletter
- Deploy app

Ensure database migrations finish before opening public traffic.
`;

    const cleaned = cleanMarkdownNoise(mdInput);

    expect(cleaned).toContain("- Read docs");
    expect(cleaned).toContain("- Deploy app");
    expect(cleaned).not.toContain("Sign up for our newsletter");
    expect(cleaned).toContain("Ensure database migrations finish before opening public traffic.");
  });

  test("preserves multi-paragraph blockquotes discussing newsletters or cookies", () => {
    const mdInput = `
# Architecture Retrospective

> When designing scalable notification systems, newsletter service distribution requires durable partition queues.
>
> In stateful authentication workflows, we use cookies to persist session tokens between client requests across distributed edge nodes.
>
> Both patterns highlight decoupled processing boundaries in distributed cloud software.

These architectural considerations informed our overall platform redesign.
`;

    const cleaned = cleanMarkdownNoise(mdInput);

    expect(cleaned).toContain(
      "newsletter service distribution requires durable partition queues",
    );
    expect(cleaned).toContain(
      "we use cookies to persist session tokens between client requests across distributed edge nodes",
    );
    expect(cleaned).toContain(
      "Both patterns highlight decoupled processing boundaries in distributed cloud software",
    );
    expect(cleaned).toContain(
      "These architectural considerations informed our overall platform redesign.",
    );
  });

  test("preserves legal and regulatory sentences discussing cookie policy", () => {
    const mdInput = `
# Privacy Regulatory Overview

The EU requires every site to maintain an updated cookie policy.

What should be included in a GDPR cookie policy?

Organizations must clearly document all functional, analytical, and third-party tracking mechanisms.
`;

    const cleanedMd = cleanMarkdownNoise(mdInput);

    expect(cleanedMd).toContain(
      "The EU requires every site to maintain an updated cookie policy.",
    );
    expect(cleanedMd).toContain(
      "What should be included in a GDPR cookie policy?",
    );
    expect(cleanedMd).toContain(
      "Organizations must clearly document all functional, analytical, and third-party tracking mechanisms.",
    );

    const htmlInput = `
<article>
  <p>The EU requires every site to maintain an updated cookie policy.</p>
  <p>What should be included in a GDPR cookie policy?</p>
  <p>Organizations must clearly document all functional, analytical, and third-party tracking mechanisms.</p>
</article>
`;

    const cleanedHtml = cleanDirectHtml(htmlInput);

    expect(cleanedHtml).toContain(
      "The EU requires every site to maintain an updated cookie policy.",
    );
    expect(cleanedHtml).toContain(
      "What should be included in a GDPR cookie policy?",
    );
    expect(cleanedHtml).toContain(
      "Organizations must clearly document all functional, analytical, and third-party tracking mechanisms.",
    );

    expect(
      isCookieBannerBlock(
        "The EU requires every site to maintain an updated cookie policy.",
      ),
    ).toBe(false);
    expect(
      isCookieBannerBlock("What should be included in a GDPR cookie policy?"),
    ).toBe(false);
  });

  test("cleanly strips HTML social promo containing anchor tags", () => {
    const htmlInput = `
<article>
  <h1>High-Performance Key-Value Stores</h1>
  <p>LSM-trees optimize write throughput by appending incoming mutations to an in-memory memtable.</p>
  <p>Follow us on <a href="https://twitter.com/systems_eng">Twitter</a></p>
  <p>Follow me on <a href="https://x.com/lead_architect">X</a> for daily distributed systems diagrams.</p>
  <p>Follow us on <a href="https://linkedin.com/company/systems">LinkedIn</a></p>
  <p>Compaction routines asynchronously merge SSTables into sorted immutable runs on disk.</p>
</article>
`;

    const cleaned = cleanDirectHtml(htmlInput);

    expect(cleaned).not.toContain("Follow us on");
    expect(cleaned).not.toContain("Follow me on");
    expect(cleaned).not.toContain("https://twitter.com/systems_eng");
    expect(cleaned).not.toContain("https://x.com/lead_architect");
    expect(cleaned).not.toContain("https://linkedin.com/company/systems");
    expect(cleaned).toContain("High-Performance Key-Value Stores");
    expect(cleaned).toContain(
      "LSM-trees optimize write throughput by appending incoming mutations to an in-memory memtable.",
    );
    expect(cleaned).toContain(
      "Compaction routines asynchronously merge SSTables into sorted immutable runs on disk.",
    );
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

  test("detectImageFormat correctly identifies formats from magic byte signatures", () => {
    const jpgBuf = Buffer.from(SAMPLE_JPEG_B64, "base64");
    const pngBuf = Buffer.from(SAMPLE_PNG_B64, "base64");
    const webpBuf = Buffer.from(SAMPLE_WEBP_B64, "base64");
    const gifBuf = Buffer.from("R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7", "base64");
    const avifBuf = Buffer.concat([
      Buffer.from([0x00, 0x00, 0x00, 0x20, 0x66, 0x74, 0x79, 0x70, 0x61, 0x76, 0x69, 0x66]),
      Buffer.alloc(50),
    ]);
    const svgBuf = Buffer.from("<svg xmlns=\"http://www.w3.org/2000/svg\"><rect width=\"10\" height=\"10\"/></svg>");
    const randBuf = Buffer.from("this is a plain text file without image header");

    expect(detectImageFormat(jpgBuf)).toBe("jpeg");
    expect(detectImageFormat(pngBuf)).toBe("png");
    expect(detectImageFormat(webpBuf)).toBe("webp");
    expect(detectImageFormat(gifBuf)).toBe("gif");
    expect(detectImageFormat(avifBuf)).toBe("avif");
    expect(detectImageFormat(svgBuf)).toBe("svg");
    expect(detectImageFormat(randBuf)).toBe("unknown");
  });

  test("hasSips respects SIPS_PATH override and reports availability", () => {
    const origSips = process.env.SIPS_PATH;
    try {
      process.env.SIPS_PATH = "/nonexistent/sips/path";
      expect(hasSips()).toBe(false);

      process.env.SIPS_PATH = "";
      expect(hasSips()).toBe(false);

      delete process.env.SIPS_PATH;
      // On macOS running these tests, sips is present
      if (fs.existsSync("/usr/bin/sips")) {
        expect(hasSips()).toBe(true);
      }
    } finally {
      if (origSips !== undefined) process.env.SIPS_PATH = origSips;
      else delete process.env.SIPS_PATH;
    }
  });

  test("generateTypographicCover returns SVG directly when sips and external rasterizers are absent", () => {
    const origSips = process.env.SIPS_PATH;
    const origRsvg = process.env.RSVG_CONVERT_PATH;
    const origMagick = process.env.MAGICK_PATH;

    process.env.SIPS_PATH = "/nonexistent/sips";
    process.env.RSVG_CONVERT_PATH = "/nonexistent/rsvg";
    process.env.MAGICK_PATH = "/nonexistent/magick";

    let coverPath: string | null = null;
    try {
      coverPath = generateTypographicCover(
        "Autonomous Systems & Robust Infrastructure",
        "Alan Kay",
        "Smalltalk Digest",
        8,
      );

      expect(coverPath.endsWith(".svg")).toBe(true);
      expect(fs.existsSync(coverPath)).toBe(true);

      const content = fs.readFileSync(coverPath, "utf8");
      expect(content).toContain("<svg");
      expect(content).toContain("Autonomous Systems");
      expect(content).toContain("Alan Kay");
      expect(content).toContain("SMALLTALK DIGEST");
      expect(content).toContain("8 MIN READ");
    } finally {
      if (coverPath && fs.existsSync(coverPath)) {
        try {
          fs.unlinkSync(coverPath);
        } catch (_err) {
          void _err;
        }
      }
      if (origSips !== undefined) process.env.SIPS_PATH = origSips;
      else delete process.env.SIPS_PATH;
      if (origRsvg !== undefined) process.env.RSVG_CONVERT_PATH = origRsvg;
      else delete process.env.RSVG_CONVERT_PATH;
      if (origMagick !== undefined) process.env.MAGICK_PATH = origMagick;
      else delete process.env.MAGICK_PATH;
    }
  });

  test("generateTypographicCover converts SVG via rsvg-convert or magick when sips is absent", () => {
    const origSips = process.env.SIPS_PATH;
    const origRsvg = process.env.RSVG_CONVERT_PATH;

    process.env.SIPS_PATH = "/nonexistent/sips";

    // Create a mock rsvg-convert script
    const mockRsvgScript = path.join(
      os.tmpdir(),
      `mock_rsvg_${Date.now()}_${Math.random().toString(36).slice(2)}.sh`,
    );
    fs.writeFileSync(
      mockRsvgScript,
      `#!/bin/sh
# Arguments: -f jpeg -o <outJpg> <inSvg>
outJpg="$4"
cat << 'EOF' | base64 -d > "$outJpg"
${SAMPLE_JPEG_B64}
EOF
exit 0
`,
      { mode: 0o755 },
    );
    process.env.RSVG_CONVERT_PATH = mockRsvgScript;

    let coverPath: string | null = null;
    try {
      coverPath = generateTypographicCover(
        "Compilers and Virtual Machines",
        "Niklaus Wirth",
        "Oberon Systems",
        15,
      );

      expect(coverPath.endsWith(".jpg")).toBe(true);
      expect(fs.existsSync(coverPath)).toBe(true);
      expect(fs.statSync(coverPath).size).toBe(1490);
    } finally {
      if (coverPath && fs.existsSync(coverPath)) {
        try {
          fs.unlinkSync(coverPath);
        } catch (_err) {
          void _err;
        }
      }
      if (fs.existsSync(mockRsvgScript)) {
        try {
          fs.unlinkSync(mockRsvgScript);
        } catch (_err) {
          void _err;
        }
      }
      if (origSips !== undefined) process.env.SIPS_PATH = origSips;
      else delete process.env.SIPS_PATH;
      if (origRsvg !== undefined) process.env.RSVG_CONVERT_PATH = origRsvg;
      else delete process.env.RSVG_CONVERT_PATH;
    }
  });

  test("downloadCoverImage passes through JPEG images cleanly without sips", async () => {
    const origSips = process.env.SIPS_PATH;
    process.env.SIPS_PATH = "/nonexistent/sips";

    let downloadedPath: string | null = null;
    try {
      downloadedPath = await downloadCoverImage(
        "https://covers.openlibrary.org/b/id/test-cover-jpeg.jpg",
        "https://example.com/article",
      );

      expect(downloadedPath).toBeTruthy();
      expect(downloadedPath?.endsWith(".jpg")).toBe(true);
      expect(fs.existsSync(downloadedPath!)).toBe(true);
      expect(fs.statSync(downloadedPath!).size).toBe(1490);
    } finally {
      if (downloadedPath && fs.existsSync(downloadedPath)) {
        try {
          fs.unlinkSync(downloadedPath);
        } catch (_err) {
          void _err;
        }
      }
      if (origSips !== undefined) process.env.SIPS_PATH = origSips;
      else delete process.env.SIPS_PATH;
    }
  });

  test("downloadCoverImage passes through PNG images cleanly without sips", async () => {
    const origSips = process.env.SIPS_PATH;
    process.env.SIPS_PATH = "/nonexistent/sips";

    let downloadedPath: string | null = null;
    try {
      downloadedPath = await downloadCoverImage(
        "https://covers.openlibrary.org/b/id/test-cover-png.png",
        "https://example.com/article",
      );

      expect(downloadedPath).toBeTruthy();
      expect(downloadedPath?.endsWith(".png")).toBe(true);
      expect(fs.existsSync(downloadedPath!)).toBe(true);
      expect(fs.statSync(downloadedPath!).size).toBe(1398);
    } finally {
      if (downloadedPath && fs.existsSync(downloadedPath)) {
        try {
          fs.unlinkSync(downloadedPath);
        } catch (_err) {
          void _err;
        }
      }
      if (origSips !== undefined) process.env.SIPS_PATH = origSips;
      else delete process.env.SIPS_PATH;
    }
  });

  test("downloadCoverImage converts WebP via dwebp or retains directly without sips", async () => {
    const origSips = process.env.SIPS_PATH;
    const origDwebp = process.env.DWEBP_PATH;
    process.env.SIPS_PATH = "/nonexistent/sips";

    // 1. Test direct WebP retention when dwebp is absent
    process.env.DWEBP_PATH = "/nonexistent/dwebp";
    let downloadedWebp: string | null = null;
    try {
      downloadedWebp = await downloadCoverImage(
        "https://covers.openlibrary.org/b/id/test-cover-webp.webp",
        "https://example.com/article",
      );

      expect(downloadedWebp).toBeTruthy();
      expect(downloadedWebp?.endsWith(".webp")).toBe(true);
      expect(fs.existsSync(downloadedWebp!)).toBe(true);
      expect(fs.statSync(downloadedWebp!).size).toBe(1044);
    } finally {
      if (downloadedWebp && fs.existsSync(downloadedWebp)) {
        try {
          fs.unlinkSync(downloadedWebp);
        } catch (_err) {
          void _err;
        }
      }
    }

    // 2. Test dwebp conversion when dwebp is available
    const mockDwebpScript = path.join(
      os.tmpdir(),
      `mock_dwebp_${Date.now()}_${Math.random().toString(36).slice(2)}.sh`,
    );
    fs.writeFileSync(
      mockDwebpScript,
      `#!/bin/sh
# Arguments: inWebp -o outPng
outPng="$3"
cat << 'EOF' | base64 -d > "$outPng"
${SAMPLE_PNG_B64}
EOF
exit 0
`,
      { mode: 0o755 },
    );
    process.env.DWEBP_PATH = mockDwebpScript;

    let downloadedPng: string | null = null;
    try {
      downloadedPng = await downloadCoverImage(
        "https://covers.openlibrary.org/b/id/test-cover-webp.webp",
        "https://example.com/article",
      );

      expect(downloadedPng).toBeTruthy();
      expect(downloadedPng?.endsWith(".png")).toBe(true);
      expect(fs.existsSync(downloadedPng!)).toBe(true);
      expect(fs.statSync(downloadedPng!).size).toBe(1398);
    } finally {
      if (downloadedPng && fs.existsSync(downloadedPng)) {
        try {
          fs.unlinkSync(downloadedPng);
        } catch (_err) {
          void _err;
        }
      }
      if (fs.existsSync(mockDwebpScript)) {
        try {
          fs.unlinkSync(mockDwebpScript);
        } catch (_err) {
          void _err;
        }
      }
      if (origSips !== undefined) process.env.SIPS_PATH = origSips;
      else delete process.env.SIPS_PATH;
      if (origDwebp !== undefined) process.env.DWEBP_PATH = origDwebp;
      else delete process.env.DWEBP_PATH;
    }
  });

  test("downloadCoverImage returns null on unsupported or unrecognized image formats without sips", async () => {
    const origSips = process.env.SIPS_PATH;
    const origMagick = process.env.MAGICK_PATH;
    process.env.SIPS_PATH = "/nonexistent/sips";
    process.env.MAGICK_PATH = "/nonexistent/magick";

    try {
      // 1. Unknown arbitrary payload should return null so typographic cover fallback runs
      const resUnknown = await downloadCoverImage(
        "https://covers.openlibrary.org/b/id/test-cover-unknown.unknown",
        "https://example.com/article",
      );
      expect(resUnknown).toBeNull();

      // 2. AVIF without a rasterizer should return null so typographic cover fallback runs
      const resAvif = await downloadCoverImage(
        "https://covers.openlibrary.org/b/id/test-cover-avif.avif",
        "https://example.com/article",
      );
      expect(resAvif).toBeNull();

      // 3. Mislabeled non-image payload claiming image/jpeg content-type should be rejected
      const resMislabeled = await downloadCoverImage(
        "https://covers.openlibrary.org/b/id/test-cover-mislabeled.mislabeled",
        "https://example.com/article",
      );
      expect(resMislabeled).toBeNull();
    } finally {
      if (origSips !== undefined) process.env.SIPS_PATH = origSips;
      else delete process.env.SIPS_PATH;
      if (origMagick !== undefined) process.env.MAGICK_PATH = origMagick;
      else delete process.env.MAGICK_PATH;
    }
  });

  test("downloadCoverImage cleans up failed dwebp output and does not leak partial files", async () => {
    const origSips = process.env.SIPS_PATH;
    const origDwebp = process.env.DWEBP_PATH;
    process.env.SIPS_PATH = "/nonexistent/sips";

    // Create a mock dwebp script that creates a partial PNG and exits non-zero (fails)
    const mockFailingDwebpScript = path.join(
      os.tmpdir(),
      `mock_fail_dwebp_${Date.now()}_${Math.random().toString(36).slice(2)}.sh`,
    );
    fs.writeFileSync(
      mockFailingDwebpScript,
      `#!/bin/sh
outPng="$3"
echo "partial corrupted png bytes" > "$outPng"
exit 1
`,
      { mode: 0o755 },
    );
    process.env.DWEBP_PATH = mockFailingDwebpScript;

    let res: string | null = null;
    try {
      res = await downloadCoverImage(
        "https://covers.openlibrary.org/b/id/test-cover-webp.webp",
        "https://example.com/article",
      );

      // Should fall back to returning WebP directly
      expect(res).toBeTruthy();
      expect(res?.endsWith(".webp")).toBe(true);
      expect(fs.existsSync(res!)).toBe(true);

      // Verify that no lingering failed partial PNG with matching prefix exists
      const basePrefix = res!.replace(/\.webp$/, "");
      const possibleLeakedPng = `${basePrefix}.png`;
      expect(fs.existsSync(possibleLeakedPng)).toBe(false);
    } finally {
      if (res && fs.existsSync(res)) {
        try {
          fs.unlinkSync(res);
        } catch (_err) {
          void _err;
        }
      }
      if (fs.existsSync(mockFailingDwebpScript)) {
        try {
          fs.unlinkSync(mockFailingDwebpScript);
        } catch (_err) {
          void _err;
        }
      }
      if (origSips !== undefined) process.env.SIPS_PATH = origSips;
      else delete process.env.SIPS_PATH;
      if (origDwebp !== undefined) process.env.DWEBP_PATH = origDwebp;
      else delete process.env.DWEBP_PATH;
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

describe("Table of Contents (TOC) & Chapter Navigation in Article EPUBs", () => {
  test("convertHtmlToEpub passes --chapter, --level1-toc, and --toc-threshold arguments to ebook-convert", () => {
    const logPath = path.join(
      os.tmpdir(),
      `mock_convert_args_${Date.now()}_${Math.random().toString(36).slice(2)}.log`,
    );
    process.env.MOCK_EBOOK_CONVERT_LOG = logPath;

    try {
      const epubPath = convertHtmlToEpub(
        "<h2>Section 1</h2><p>Content 1</p><h2>Section 2</h2><p>Content 2</p>",
        "Navigable Essay",
        "Essayist",
        "Example Site",
        "https://example.com/essay",
      );

      expect(fs.existsSync(epubPath)).toBe(true);
      expect(fs.existsSync(logPath)).toBe(true);

      const capturedArgs = fs
        .readFileSync(logPath, "utf8")
        .split("\n")
        .filter(Boolean);

      // Verify Calibre ebook-convert navigation arguments
      expect(capturedArgs).toContain("--chapter");
      const chapterIdx = capturedArgs.indexOf("--chapter");
      expect(capturedArgs[chapterIdx + 1]).toBe(
        "//*[re:test(local-name(), '^h[12]$', 'i')]",
      );

      expect(capturedArgs).toContain("--level1-toc");
      const tocIdx = capturedArgs.indexOf("--level1-toc");
      expect(capturedArgs[tocIdx + 1]).toBe("//h2");

      expect(capturedArgs).toContain("--toc-threshold");
      const thresholdIdx = capturedArgs.indexOf("--toc-threshold");
      expect(capturedArgs[thresholdIdx + 1]).toBe("2");

      expect(capturedArgs).toContain("--dont-split-on-page-breaks");

      try {
        fs.unlinkSync(epubPath);
      } catch (_err) {
        void _err;
      }
    } finally {
      delete process.env.MOCK_EBOOK_CONVERT_LOG;
      if (fs.existsSync(logPath)) {
        try {
          fs.unlinkSync(logPath);
        } catch (_err) {
          void _err;
        }
      }
    }
  });

  test("markdownToHtml and cleanDirectHtml preserve section headings (h2, h3)", () => {
    const markdownInput = `
# Article Heading
Introduction prose.

## Section 1: Foundations
Detailed discussion on foundations.

### 1.1 First Principle
Deep dive into first principle.

## Section 2: Implementation
Technical implementation details.

### 2.1 Code Patterns
Pattern analysis and examples.
`;

    const htmlFromMd = markdownToHtml(markdownInput);
    expect(htmlFromMd).toContain("<h1>Article Heading</h1>");
    expect(htmlFromMd).toContain("<h2>Section 1: Foundations</h2>");
    expect(htmlFromMd).toContain("<h3>1.1 First Principle</h3>");
    expect(htmlFromMd).toContain("<h2>Section 2: Implementation</h2>");
    expect(htmlFromMd).toContain("<h3>2.1 Code Patterns</h3>");

    const directHtmlInput = `
<article>
  <header class="post-header">
    <nav class="breadcrumb"><a href="/">Home</a> &gt; Articles</nav>
    <h1>Web Article Title</h1>
  </header>
  <h2>Background & Context</h2>
  <p>Context prose for testing direct HTML cleaning with sufficient length.</p>
  <h3>Early Experiments</h3>
  <p>Subsection text about early experiments.</p>
  <h2>Architecture Decisions</h2>
  <p>Architecture description with robust prose.</p>
  <div class="share-buttons">Share on Social</div>
  <footer class="post-footer">Comments and copyright</footer>
</article>
`;

    const cleaned = cleanDirectHtml(directHtmlInput);
    expect(cleaned).toContain("<h2>Background & Context</h2>");
    expect(cleaned).toContain("<h3>Early Experiments</h3>");
    expect(cleaned).toContain("<h2>Architecture Decisions</h2>");
    expect(cleaned).not.toContain("breadcrumb");
    expect(cleaned).not.toContain("share-buttons");
    expect(cleaned).not.toContain("post-footer");
  });

  test("buildStyledHtmlDocument maintains semantic heading hierarchy and isolates title in header", () => {
    const styledDoc = buildStyledHtmlDocument({
      title: "Deep Architecture Guide",
      author: "System Architect",
      siteName: "Tech Journal",
      url: "https://example.com/guide",
      readTimeMinutes: 10,
      wordCount: 2000,
      contentHtml:
        "<h2>Chapter 1: Overview</h2><p>Text</p><h3>1.1 Details</h3><p>More</p><h2>Chapter 2: Deep Dive</h2><p>Text</p>",
    });

    // Verify title header uses h1.article-title inside <header>
    expect(styledDoc).toContain(
      '<h1 class="article-title">Deep Architecture Guide</h1>',
    );
    expect(styledDoc).not.toContain(
      '<h2 class="article-title">Deep Architecture Guide</h2>',
    );

    // Verify body content retains semantic section headings for XPath //h2
    expect(styledDoc).toContain('<div class="article-content">');
    expect(styledDoc).toContain("<h2>Chapter 1: Overview</h2>");
    expect(styledDoc).toContain("<h3>1.1 Details</h3>");
    expect(styledDoc).toContain("<h2>Chapter 2: Deep Dive</h2>");

    // Verify that the title in the metadata banner does not match //h2 (avoiding duplicate chapter marker)
    const h2Matches = Array.from(
      styledDoc.matchAll(/<h2\b[^>]*>(.*?)<\/h2>/gi),
    ).map((m) => m[1]);
    expect(h2Matches).toEqual([
      "Chapter 1: Overview",
      "Chapter 2: Deep Dive",
    ]);
    expect(h2Matches).not.toContain("Deep Architecture Guide");
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
      port: 0,
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

    process.env.FIRECRAWL_PORT = String(mockServer.port);
    process.env.FIRECRAWL_URL = `http://127.0.0.1:${mockServer.port}`;
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
      port: 0,
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

    process.env.FIRECRAWL_URL = `http://127.0.0.1:${mockServer.port}`;
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

describe("Multi-URL Extraction (extractAllUrlsFromText)", () => {
  test("extracts multiple URLs across separate lines preserving order", () => {
    const text = [
      "https://paulgraham.com/foundermode.html",
      "https://danluu.com/sounds-easy/",
      "https://blog.samaltman.com/what-i-wish-i-knew",
    ].join("\n");

    const urls = extractAllUrlsFromText(text);
    expect(urls).toEqual([
      "https://paulgraham.com/foundermode.html",
      "https://danluu.com/sounds-easy/",
      "https://blog.samaltman.com/what-i-wish-i-knew",
    ]);
  });

  test("extracts URLs mixed with conversational prose", () => {
    const text =
      "Take a look at https://paulgraham.com/foundermode.html for startup thoughts, and also read https://danluu.com/sounds-easy/ when you have time!";
    const urls = extractAllUrlsFromText(text);
    expect(urls).toEqual([
      "https://paulgraham.com/foundermode.html",
      "https://danluu.com/sounds-easy/",
    ]);
  });

  test("filters duplicate URLs within the same message while preserving first-seen order", () => {
    const text =
      "Check https://paulgraham.com/foundermode.html and https://danluu.com/sounds-easy/ or again https://paulgraham.com/foundermode.html then https://example.com/third";
    const urls = extractAllUrlsFromText(text);
    expect(urls).toEqual([
      "https://paulgraham.com/foundermode.html",
      "https://danluu.com/sounds-easy/",
      "https://example.com/third",
    ]);
  });

  test("extracts multiple URLs with command syntax (/read, /article, /epub, /url)", () => {
    const readCmd =
      "/read https://paulgraham.com/foundermode.html https://danluu.com/sounds-easy/";
    expect(extractAllUrlsFromText(readCmd)).toEqual([
      "https://paulgraham.com/foundermode.html",
      "https://danluu.com/sounds-easy/",
    ]);

    const articleCmd =
      "/article https://paulgraham.com/foundermode.html\nhttps://danluu.com/sounds-easy/";
    expect(extractAllUrlsFromText(articleCmd)).toEqual([
      "https://paulgraham.com/foundermode.html",
      "https://danluu.com/sounds-easy/",
    ]);

    expect(extractAllUrlsFromText("/epub not-a-url")).toEqual([]);
    expect(extractAllUrlsFromText("/read")).toEqual([]);
  });

  test("excludes internal Telegram URLs while extracting regular URLs", () => {
    const text =
      "Join https://t.me/reading_stack and read https://paulgraham.com/foundermode.html and also https://telegram.me/updates";
    const urls = extractAllUrlsFromText(text);
    expect(urls).toEqual(["https://paulgraham.com/foundermode.html"]);
  });

  test("extracts mixed standard URLs and Elscione space-containing URLs in document order", () => {
    const text =
      "Read https://paulgraham.com/foundermode.html first, then https://server.elscione.com/Officially Translated Light Novels/A Sister's All You Need/ and finally https://danluu.com/sounds-easy/";
    const urls = extractAllUrlsFromText(text);
    expect(urls).toEqual([
      "https://paulgraham.com/foundermode.html",
      "https://server.elscione.com/Officially%20Translated%20Light%20Novels/A%20Sister's%20All%20You%20Need/",
      "https://danluu.com/sounds-easy/",
    ]);
  });

  test("handles empty string, whitespace, and nullish inputs gracefully", () => {
    expect(extractAllUrlsFromText("")).toEqual([]);
    expect(extractAllUrlsFromText("   ")).toEqual([]);
    expect(extractAllUrlsFromText(null as any)).toEqual([]);
    expect(extractAllUrlsFromText(undefined as any)).toEqual([]);
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

describe("Fast-Fail Article Domains & Tier 2 Bypass Routing", () => {
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

  test("FAST_FAIL_ARTICLE_DOMAINS contains the required 10 bot-protected / JS-rendered domains", () => {
    const requiredDomains = [
      "substack.com",
      "medium.com",
      "bloomberg.com",
      "nytimes.com",
      "ft.com",
      "wsj.com",
      "theinformation.com",
      "x.com",
      "twitter.com",
      "wired.com",
    ];

    for (const d of requiredDomains) {
      expect(FAST_FAIL_ARTICLE_DOMAINS.has(d)).toBe(true);
    }
    expect(FAST_FAIL_ARTICLE_DOMAINS.size).toBe(10);
  });

  test("isFastFailArticleDomain accurately matches exact domains, subdomains, and full URLs", () => {
    // Exact domains
    expect(isFastFailArticleDomain("substack.com")).toBe(true);
    expect(isFastFailArticleDomain("medium.com")).toBe(true);
    expect(isFastFailArticleDomain("bloomberg.com")).toBe(true);
    expect(isFastFailArticleDomain("nytimes.com")).toBe(true);
    expect(isFastFailArticleDomain("ft.com")).toBe(true);
    expect(isFastFailArticleDomain("wsj.com")).toBe(true);
    expect(isFastFailArticleDomain("theinformation.com")).toBe(true);
    expect(isFastFailArticleDomain("x.com")).toBe(true);
    expect(isFastFailArticleDomain("twitter.com")).toBe(true);
    expect(isFastFailArticleDomain("wired.com")).toBe(true);

    // Subdomains
    expect(isFastFailArticleDomain("astralcodexten.substack.com")).toBe(true);
    expect(isFastFailArticleDomain("author.newsletter.substack.com")).toBe(true);
    expect(isFastFailArticleDomain("towardsdatascience.medium.com")).toBe(true);
    expect(isFastFailArticleDomain("www.bloomberg.com")).toBe(true);
    expect(isFastFailArticleDomain("asia.bloomberg.com")).toBe(true);
    expect(isFastFailArticleDomain("www.nytimes.com")).toBe(true);
    expect(isFastFailArticleDomain("m.ft.com")).toBe(true);
    expect(isFastFailArticleDomain("markets.ft.com")).toBe(true);
    expect(isFastFailArticleDomain("www.wsj.com")).toBe(true);
    expect(isFastFailArticleDomain("www.theinformation.com")).toBe(true);
    expect(isFastFailArticleDomain("mobile.x.com")).toBe(true);
    expect(isFastFailArticleDomain("mobile.twitter.com")).toBe(true);
    expect(isFastFailArticleDomain("www.wired.com")).toBe(true);

    // Full URLs
    expect(
      isFastFailArticleDomain("https://astralcodexten.substack.com/p/my-post"),
    ).toBe(true);
    expect(isFastFailArticleDomain("https://medium.com/@user/story-slug")).toBe(
      true,
    );
    expect(
      isFastFailArticleDomain(
        "https://www.nytimes.com/2026/10/article.html?utm_source=news",
      ),
    ).toBe(true);
    expect(
      isFastFailArticleDomain("https://x.com/tech_insider/status/123456789"),
    ).toBe(true);

    // Case-insensitivity
    expect(isFastFailArticleDomain("SUBSTACK.COM")).toBe(true);
    expect(isFastFailArticleDomain("Medium.Com")).toBe(true);
    expect(isFastFailArticleDomain("https://WWW.WIRED.COM/story/test")).toBe(
      true,
    );

    // Trailing dot FQDN
    expect(isFastFailArticleDomain("substack.com.")).toBe(true);
    expect(isFastFailArticleDomain("https://author.substack.com./post")).toBe(
      true,
    );

    // isFastFailDomain alias equality
    expect(isFastFailDomain("substack.com")).toBe(true);
    expect(isFastFailDomain("example.com")).toBe(false);
  });

  test("isFastFailArticleDomain correctly rejects unrelated domains and spoof attempts", () => {
    expect(isFastFailArticleDomain("paulgraham.com")).toBe(false);
    expect(isFastFailArticleDomain("example.com")).toBe(false);
    expect(isFastFailArticleDomain("github.com")).toBe(false);
    expect(isFastFailArticleDomain("fake-substack.com")).toBe(false);
    expect(isFastFailArticleDomain("notmedium.com")).toBe(false);
    expect(isFastFailArticleDomain("substack.com.attacker.org")).toBe(false);
    expect(isFastFailArticleDomain("medium.com.evil.com")).toBe(false);
    expect(isFastFailArticleDomain("ft.com.fake.net")).toBe(false);
    expect(isFastFailArticleDomain("x.com.hacker.io")).toBe(false);
    expect(isFastFailArticleDomain("my-wired.com")).toBe(false);
  });

  test("isFastFailArticleDomain safely handles null, undefined, empty, or invalid inputs", () => {
    expect(isFastFailArticleDomain("")).toBe(false);
    expect(isFastFailArticleDomain("   ")).toBe(false);
    expect(isFastFailArticleDomain(null as any)).toBe(false);
    expect(isFastFailArticleDomain(undefined as any)).toBe(false);
    expect(isFastFailArticleDomain("not a valid url at all :// ??")).toBe(false);
  });

  test("extractArticle bypasses Tier 2 direct fetch for fast-fail domains directly to Jina Reader", async () => {
    let directFetchAttempted = false;
    let jinaFetchAttempted = false;
    const origFetch = globalThis.fetch;

    const dummyProse =
      "Distributed consensus protocols and leader election algorithms are essential for modern databases. ".repeat(
        25,
      );
    const jinaArticleMd = `Title: The Future of Distributed Systems
Author: Distributed Systems Lead
URL Source: https://author.substack.com/p/future-distributed-systems
Markdown Content:
${dummyProse}`;

    globalThis.fetch = (async (input: any) => {
      const urlStr = typeof input === "string" ? input : input?.url || "";
      if (urlStr.includes("r.jina.ai")) {
        jinaFetchAttempted = true;
        return new Response(jinaArticleMd, {
          status: 200,
          headers: { "Content-Type": "text/markdown; charset=utf-8" },
        });
      }

      if (urlStr.includes("author.substack.com")) {
        directFetchAttempted = true;
        return new Response("Direct fetch should not be called", { status: 403 });
      }

      return origFetch(input);
    }) as any;

    try {
      const article = await extractArticle(
        "https://author.substack.com/p/future-distributed-systems",
      );

      expect(directFetchAttempted).toBe(false);
      expect(jinaFetchAttempted).toBe(true);
      expect(article.title).toBe("The Future of Distributed Systems");
      expect(article.author).toBe("Distributed Systems Lead");
      expect(article.wordCount).toBeGreaterThan(150);
    } finally {
      globalThis.fetch = origFetch;
    }
  });

  test("extractArticle still uses Firecrawl Tier 1 when Firecrawl is available for fast-fail domains", async () => {
    const server = Bun.serve({
      port: 0,
      fetch(req) {
        if (req.method === "GET") return new Response("OK", { status: 200 });
        if (req.method === "POST" && new URL(req.url).pathname === "/v1/scrape") {
          return new Response(
            JSON.stringify({
              success: true,
              data: {
                markdown: "# Substack via Firecrawl\n\n".concat(
                  "Deep dive article extracted with Firecrawl headless browser rendering. ".repeat(25),
                ),
                metadata: {
                  title: "Substack via Firecrawl",
                  author: "Firecrawl Scraper",
                  "og:site_name": "Tech Substack",
                },
              },
            }),
            { headers: { "Content-Type": "application/json" } },
          );
        }
        return new Response("Not Found", { status: 404 });
      },
    });

    process.env.FIRECRAWL_PORT = String(server.port);
    process.env.FIRECRAWL_URL = `http://127.0.0.1:${server.port}`;
    setFirecrawlEnabled(true);

    let jinaCalled = false;
    let directCalled = false;
    const origFetch = globalThis.fetch;
    globalThis.fetch = (async (input: any, init?: any) => {
      const urlStr = typeof input === "string" ? input : input?.url || "";
      if (urlStr.includes("r.jina.ai")) jinaCalled = true;
      if (urlStr.includes("author.substack.com")) directCalled = true;
      return origFetch(input, init);
    }) as any;

    try {
      const article = await extractArticle(
        "https://author.substack.com/p/firecrawl-test",
      );
      expect(article.title).toBe("Substack via Firecrawl");
      expect(article.author).toBe("Firecrawl Scraper");
      expect(jinaCalled).toBe(false);
      expect(directCalled).toBe(false);
    } finally {
      server.stop(true);
      setFirecrawlEnabled(false);
      globalThis.fetch = origFetch;
    }
  });

  test("extractArticle continues to use Tier 2 direct fetch for standard non-fast-fail domains", async () => {
    let directFetchCalled = false;
    let jinaCalled = false;
    const origFetch = globalThis.fetch;

    const prose =
      "Software architecture requires continuous refinement and balanced trade-offs across components. ".repeat(
        25,
      );
    const html = `<!DOCTYPE html>
<html>
<head><title>Architecture Essay</title><meta name="author" content="Independent Engineer"></head>
<body><article><h1>Architecture Essay</h1><p>${prose}</p></article></body>
</html>`;

    globalThis.fetch = (async (input: any, init?: any) => {
      const urlStr = typeof input === "string" ? input : input?.url || "";
      if (urlStr.includes("example.com/standard-architecture-essay")) {
        directFetchCalled = true;
        return new Response(html, {
          status: 200,
          headers: { "Content-Type": "text/html; charset=utf-8" },
        });
      }
      if (urlStr.includes("r.jina.ai")) {
        jinaCalled = true;
      }
      return origFetch(input, init);
    }) as any;

    try {
      const article = await extractArticle(
        "https://example.com/standard-architecture-essay",
      );
      expect(directFetchCalled).toBe(true);
      expect(jinaCalled).toBe(false);
      expect(article.title).toBe("Architecture Essay");
      expect(article.author).toBe("Independent Engineer");
    } finally {
      globalThis.fetch = origFetch;
    }
  });
});

describe("HTTP 429 Rate Limit Single-Retry Backoff", () => {
  test("compute429BackoffMs parses Retry-After header and bounds to fallback range", () => {
    // Integer seconds
    expect(compute429BackoffMs("3")).toBe(3000);
    expect(compute429BackoffMs("0")).toBe(0);
    expect(compute429BackoffMs("10")).toBe(10000);

    // Float seconds
    expect(compute429BackoffMs("2.5")).toBe(2500);
    expect(compute429BackoffMs("1.2")).toBe(1200);

    // Capped at 60_000ms
    expect(compute429BackoffMs("120")).toBe(60000);

    // Fallback when header is missing / empty / null / undefined
    for (const val of [null, undefined, "", "   "]) {
      const ms = compute429BackoffMs(val as any);
      expect(ms).toBeGreaterThanOrEqual(1500);
      expect(ms).toBeLessThanOrEqual(3000);
    }

    // Fallback when header is invalid string or negative
    for (const invalid of ["not-a-number", "-5", "invalid-date-string-xyz"]) {
      const ms = compute429BackoffMs(invalid);
      expect(ms).toBeGreaterThanOrEqual(1500);
      expect(ms).toBeLessThanOrEqual(3000);
    }

    // HTTP Date parsing
    const futureDate = new Date(Date.now() + 5000).toUTCString();
    const dateMs = compute429BackoffMs(futureDate);
    expect(dateMs).toBeGreaterThan(0);
    expect(dateMs).toBeLessThanOrEqual(60000);
  });

  test("extractArticleViaJina backs off on HTTP 429 with Retry-After and succeeds on retry", async () => {
    let callCount = 0;
    let sleptDurationMs = 0;
    const origFetch = globalThis.fetch;

    const dummyProse =
      "Testing resilient rate limit handling with automated retry backoffs ensures stability. ".repeat(
        25,
      );
    const jinaMd = `Title: Rate Limit Handled
Author: Resilient Agent
URL Source: https://example.com/rate-limit-test
Markdown Content:
${dummyProse}`;

    globalThis.fetch = (async (input: any) => {
      const urlStr = typeof input === "string" ? input : input?.url || "";
      if (urlStr.includes("r.jina.ai")) {
        callCount++;
        if (callCount === 1) {
          return new Response("Too Many Requests", {
            status: 429,
            statusText: "Too Many Requests",
            headers: {
              "Retry-After": "2",
              "Content-Type": "text/plain",
            },
          });
        }
        return new Response(jinaMd, {
          status: 200,
          headers: { "Content-Type": "text/markdown; charset=utf-8" },
        });
      }
      return origFetch(input);
    }) as any;

    try {
      const article = await extractArticleViaJina(
        "https://example.com/rate-limit-test",
        undefined,
        {
          sleepFn: async (ms) => {
            sleptDurationMs = ms;
          },
        },
      );

      expect(callCount).toBe(2);
      expect(sleptDurationMs).toBe(2000);
      expect(article.title).toBe("Rate Limit Handled");
      expect(article.author).toBe("Resilient Agent");
    } finally {
      globalThis.fetch = origFetch;
    }
  });

  test("extractArticleViaJina backs off on HTTP 429 without Retry-After and succeeds on retry", async () => {
    let callCount = 0;
    let sleptDurationMs = 0;
    const origFetch = globalThis.fetch;

    const dummyProse =
      "Fallback jittered backoff without Retry-After header protects external endpoints. ".repeat(
        25,
      );
    const jinaMd = `Title: Fallback Backoff Success
Author: Rate Limit Specialist
URL Source: https://example.com/fallback-backoff
Markdown Content:
${dummyProse}`;

    globalThis.fetch = (async (input: any) => {
      const urlStr = typeof input === "string" ? input : input?.url || "";
      if (urlStr.includes("r.jina.ai")) {
        callCount++;
        if (callCount === 1) {
          return new Response("Too Many Requests", {
            status: 429,
            statusText: "Too Many Requests",
            headers: { "Content-Type": "text/plain" },
          });
        }
        return new Response(jinaMd, {
          status: 200,
          headers: { "Content-Type": "text/markdown; charset=utf-8" },
        });
      }
      return origFetch(input);
    }) as any;

    try {
      const article = await extractArticleViaJina(
        "https://example.com/fallback-backoff",
        undefined,
        {
          sleepFn: async (ms) => {
            sleptDurationMs = ms;
          },
        },
      );

      expect(callCount).toBe(2);
      expect(sleptDurationMs).toBeGreaterThanOrEqual(1500);
      expect(sleptDurationMs).toBeLessThanOrEqual(3000);
      expect(article.title).toBe("Fallback Backoff Success");
    } finally {
      globalThis.fetch = origFetch;
    }
  });

  test("extractArticleViaJina stops after 1 retry and throws if HTTP 429 persists", async () => {
    let callCount = 0;
    let sleptDurationMs = 0;
    const origFetch = globalThis.fetch;

    globalThis.fetch = (async (input: any) => {
      const urlStr = typeof input === "string" ? input : input?.url || "";
      if (urlStr.includes("r.jina.ai")) {
        callCount++;
        return new Response("Too Many Requests", {
          status: 429,
          statusText: "Too Many Requests",
          headers: {
            "Retry-After": "1",
            "Content-Type": "text/plain",
          },
        });
      }
      return origFetch(input);
    }) as any;

    try {
      let threw = false;
      try {
        await extractArticleViaJina(
          "https://example.com/persistent-429",
          undefined,
          {
            sleepFn: async (ms) => {
              sleptDurationMs = ms;
            },
          },
        );
      } catch (err: any) {
        threw = true;
        expect(err.message).toContain("Jina Reader fallback failed (HTTP 429");
      }

      expect(threw).toBe(true);
      expect(callCount).toBe(2);
      expect(sleptDurationMs).toBe(1000);
    } finally {
      globalThis.fetch = origFetch;
    }
  });

  test("scrapeArticleWithFirecrawl backs off on HTTP 429 and succeeds on single retry", async () => {
    let scrapeAttempts = 0;
    let sleptMs = 0;

    const server = Bun.serve({
      port: 0,
      fetch(req) {
        if (req.method === "GET") return new Response("OK", { status: 200 });
        if (req.method === "POST" && new URL(req.url).pathname === "/v1/scrape") {
          scrapeAttempts++;
          if (scrapeAttempts === 1) {
            return new Response("Rate limit exceeded", {
              status: 429,
              statusText: "Too Many Requests",
              headers: {
                "Retry-After": "3",
                "Content-Type": "text/plain",
              },
            });
          }
          return new Response(
            JSON.stringify({
              success: true,
              data: {
                markdown: "# Firecrawl Retried Article\n\n".concat(
                  "Article successfully scraped following HTTP 429 rate limit backoff. ".repeat(25),
                ),
                metadata: {
                  title: "Firecrawl Retried Article",
                  author: "Firecrawl Rate Tester",
                  "og:site_name": "Test Cluster",
                },
              },
            }),
            { headers: { "Content-Type": "application/json" } },
          );
        }
        return new Response("Not Found", { status: 404 });
      },
    });

    process.env.FIRECRAWL_PORT = String(server.port);
    process.env.FIRECRAWL_URL = `http://127.0.0.1:${server.port}`;
    setFirecrawlEnabled(true);

    try {
      const article = await scrapeArticleWithFirecrawl(
        "https://example.com/firecrawl-429-retry",
        {
          sleepFn: async (ms) => {
            sleptMs = ms;
          },
        },
      );

      expect(scrapeAttempts).toBe(2);
      expect(sleptMs).toBe(3000);
      expect(article).not.toBeNull();
      expect(article?.title).toBe("Firecrawl Retried Article");
    } finally {
      server.stop(true);
      setFirecrawlEnabled(false);
    }
  });

  test("scrapeArticleWithFirecrawl fails open (returns null) if HTTP 429 persists after 1 retry", async () => {
    let scrapeAttempts = 0;
    let sleptMs = 0;

    const server = Bun.serve({
      port: 0,
      fetch(req) {
        if (req.method === "GET") return new Response("OK", { status: 200 });
        if (req.method === "POST" && new URL(req.url).pathname === "/v1/scrape") {
          scrapeAttempts++;
          return new Response("Rate limit exceeded", {
            status: 429,
            statusText: "Too Many Requests",
            headers: {
              "Retry-After": "2",
              "Content-Type": "text/plain",
            },
          });
        }
        return new Response("Not Found", { status: 404 });
      },
    });

    process.env.FIRECRAWL_PORT = String(server.port);
    process.env.FIRECRAWL_URL = `http://127.0.0.1:${server.port}`;
    setFirecrawlEnabled(true);

    try {
      const article = await scrapeArticleWithFirecrawl(
        "https://example.com/firecrawl-persistent-429",
        {
          sleepFn: async (ms) => {
            sleptMs = ms;
          },
        },
      );

      expect(scrapeAttempts).toBe(2);
      expect(sleptMs).toBe(2000);
      expect(article).toBeNull();
    } finally {
      server.stop(true);
      setFirecrawlEnabled(false);
    }
  });
});

describe("Inline & Base64-Encoded Images in Article Extraction & EPUB Generation", () => {
  // Valid sample image payloads (2x2 pixels)
  const VALID_PNG_2X2_BASE64 =
    "iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAYAAABytg0kAAAAFElEQVR42mNk+M9QzwAEjDAGACUcAfs80K0AAAAASUVORK5CYII=";
  const VALID_PNG_DATA_URI = `data:image/png;base64,${VALID_PNG_2X2_BASE64}`;

  const VALID_GIF_2X2_BASE64 =
    "R0lGODlhAgACAIABAAAAAP///yH5BAEAAAEALAAAAAACAAIAAAICRF4AOw==";
  const VALID_GIF_DATA_URI = `data:image/gif;base64,${VALID_GIF_2X2_BASE64}`;

  // 1x1 spacer / tracking pixel payloads
  const TRACKING_GIF_1X1_DATA_URI =
    "data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7";
  const TRACKING_PNG_1X1_DATA_URI =
    "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=";
  const TRACKING_WEBP_1X1_DATA_URI =
    "data:image/webp;base64,UklGRhoAAABXRUJQVlA4TA0AAAAvAAAAEAcQERGIiP4HAA==";

  test("decodeAndSaveBase64Image decodes valid PNG and GIF images and creates temporary files", () => {
    const pngResult = decodeAndSaveBase64Image(VALID_PNG_DATA_URI);
    expect(pngResult).not.toBeNull();
    expect(pngResult!.ext).toBe("png");
    expect(pngResult!.filePath).toMatch(/^\/tmp\/article_img_[a-f0-9]+\.png$/);
    expect(fs.existsSync(pngResult!.filePath)).toBe(true);
    expect(fs.statSync(pngResult!.filePath).size).toBeGreaterThan(0);

    const gifResult = decodeAndSaveBase64Image(VALID_GIF_DATA_URI);
    expect(gifResult).not.toBeNull();
    expect(gifResult!.ext).toBe("gif");
    expect(gifResult!.filePath).toMatch(/^\/tmp\/article_img_[a-f0-9]+\.gif$/);
    expect(fs.existsSync(gifResult!.filePath)).toBe(true);

    // Clean up
    try {
      if (fs.existsSync(pngResult!.filePath)) fs.unlinkSync(pngResult!.filePath);
      if (fs.existsSync(gifResult!.filePath)) fs.unlinkSync(gifResult!.filePath);
    } catch (_err) {
      void _err;
    }
  });

  test("decodeAndSaveBase64Image rejects 1x1 tracking and spacer pixels gracefully", () => {
    const gif1x1 = decodeAndSaveBase64Image(TRACKING_GIF_1X1_DATA_URI);
    expect(gif1x1).toBeNull();

    const png1x1 = decodeAndSaveBase64Image(TRACKING_PNG_1X1_DATA_URI);
    expect(png1x1).toBeNull();

    const webp1x1 = decodeAndSaveBase64Image(TRACKING_WEBP_1X1_DATA_URI);
    expect(webp1x1).toBeNull();
  });

  test("decodeAndSaveBase64Image rejects corrupt or malformed data URIs safely", () => {
    // Direct image buffer validation checks
    expect(isValidImageBuffer(Buffer.from(VALID_PNG_2X2_BASE64, "base64"), "png")).toBe(true);
    expect(isValidImageBuffer(Buffer.from(VALID_GIF_2X2_BASE64, "base64"), "gif")).toBe(true);
    expect(isValidImageBuffer(Buffer.from("invalid-header", "utf8"), "png")).toBe(false);

    // Spacer pixel check
    expect(isTrackingOrSpacerPixel(Buffer.from(VALID_PNG_2X2_BASE64, "base64"), "png")).toBe(false);
    expect(isTrackingOrSpacerPixel(Buffer.from(VALID_GIF_2X2_BASE64, "base64"), "gif")).toBe(false);

    // Corrupt base64 (not valid image magic bytes)
    expect(decodeAndSaveBase64Image("data:image/png;base64,corrupt_not_an_image")).toBeNull();

    // Empty payload
    expect(decodeAndSaveBase64Image("data:image/jpeg;base64,")).toBeNull();

    // Unsupported mime types (e.g. svg, text)
    expect(decodeAndSaveBase64Image("data:image/svg+xml;base64,PHN2Zz48L3N2Zz4=")).toBeNull();
    expect(decodeAndSaveBase64Image("data:text/html;base64,PGgxPkhlbGxvPC9oMT4=")).toBeNull();

    // Malformed strings
    expect(decodeAndSaveBase64Image("")).toBeNull();
    expect(decodeAndSaveBase64Image(undefined as any)).toBeNull();
    expect(decodeAndSaveBase64Image("not-a-data-uri")).toBeNull();
  });

  test("extractAndSaveBase64Images decodes inline images and replaces src attributes", () => {
    const inputHtml = `
      <article>
        <h1>Diagram Article</h1>
        <p>Here is an inline architecture diagram:</p>
        <img src="${VALID_PNG_DATA_URI}" alt="System Architecture" />
        <p>And here is a spacer pixel that should be stripped:</p>
        <img src="${TRACKING_GIF_1X1_DATA_URI}" alt="Spacer" />
        <p>And a corrupt data URI that should fail open safely:</p>
        <img src="data:image/png;base64,corrupt_garbage" alt="Corrupt" />
      </article>
    `;

    const { html, tempImagePaths } = extractAndSaveBase64Images(inputHtml);

    expect(tempImagePaths.length).toBe(1);
    const savedPath = tempImagePaths[0];
    expect(savedPath).toMatch(/^\/tmp\/article_img_[a-f0-9]+\.png$/);
    expect(fs.existsSync(savedPath)).toBe(true);

    // HTML contains replaced path and preserves alt text
    expect(html).toContain(`<img src="${savedPath}" alt="System Architecture" />`);

    // Tracking and corrupt images are stripped
    expect(html).not.toContain(TRACKING_GIF_1X1_DATA_URI);
    expect(html).not.toContain("corrupt_garbage");
    expect(html).not.toContain('alt="Spacer"');
    expect(html).not.toContain('alt="Corrupt"');

    // Clean up
    try {
      if (fs.existsSync(savedPath)) fs.unlinkSync(savedPath);
    } catch (_err) {
      void _err;
    }
  });

  test("cleanDirectHtml preserves base64 images whose payload contains 1x1 while stripping actual tracking pixels", () => {
    // Construct base64 payload containing "1x1" substring
    const base64With1x1 = `data:image/png;base64,iVBORw0KGgoAAA1x1AAANSUhEUgAAAAIAAAACCAYAAABytg0kAAAAFElEQVR42mNk+M9QzwAEjDAGACUcAfs80K0AAAAASUVORK5CYII=`;
    const htmlWithImages = `
      <article>
        <img src="${base64With1x1}" alt="Valid Diagram With 1x1 substring" />
        <img src="https://example.com/spacer.gif" alt="spacer" />
        <img src="https://example.com/1x1.png" alt="tracking" />
        <img src="data:image/gif;base64,R0lGODlh" width="1" height="1" />
      </article>
    `;

    const cleaned = cleanDirectHtml(htmlWithImages);

    // Preserves base64 image tag
    expect(cleaned).toContain(`src="${base64With1x1}"`);
    expect(cleaned).toContain('alt="Valid Diagram With 1x1 substring"');

    // Strips tracking images
    expect(cleaned).not.toContain("spacer.gif");
    expect(cleaned).not.toContain("1x1.png");
    expect(cleaned).not.toContain('width="1" height="1"');
  });

  test("extractArticle preserves inline base64 images and embeds temporary file paths in output", async () => {
    const dummyProse =
      "Distributed consensus algorithms like Paxos and Raft ensure state machine replication across unreliable networks. ".repeat(
        25,
      );

    const articleHtml = `<!DOCTYPE html>
<html>
<head><title>Consensus Protocols</title></head>
<body>
  <article>
    <h1>Consensus Protocols</h1>
    <p>${dummyProse}</p>
    <figure>
      <img src="${VALID_PNG_DATA_URI}" alt="Raft Architecture Diagram" />
      <figcaption>Raft Cluster States</figcaption>
    </figure>
    <p>Trailing discussion on leader election and log compaction.</p>
  </article>
</body>
</html>`;

    const origFetch = globalThis.fetch;
    let extractedArticle: any = null;

    try {
      globalThis.fetch = (async (input: any) => {
        const urlStr = typeof input === "string" ? input : input?.url || "";
        if (urlStr.includes("consensus-protocols")) {
          return new Response(articleHtml, {
            status: 200,
            headers: { "Content-Type": "text/html; charset=utf-8" },
          });
        }
        return origFetch(input);
      }) as any;

      extractedArticle = await extractArticle("https://example.com/consensus-protocols");

      expect(extractedArticle).not.toBeNull();
      expect(extractedArticle.title).toBe("Consensus Protocols");
      expect(extractedArticle.cleanedHtml).toContain("/tmp/article_img_");
      expect(extractedArticle.cleanedHtml).toContain('alt="Raft Architecture Diagram"');
      expect(extractedArticle.styledDocument).toContain("/tmp/article_img_");

      expect(extractedArticle.tempImagePaths).toBeDefined();
      expect(extractedArticle.tempImagePaths.length).toBeGreaterThanOrEqual(1);

      const imgPath = extractedArticle.tempImagePaths[0];
      expect(fs.existsSync(imgPath)).toBe(true);
      expect(fs.statSync(imgPath).size).toBeGreaterThan(0);
    } finally {
      globalThis.fetch = origFetch;
      if (extractedArticle?.tempImagePaths) {
        for (const p of extractedArticle.tempImagePaths) {
          if (fs.existsSync(p)) {
            try {
              fs.unlinkSync(p);
            } catch (_err) {
              void _err;
            }
          }
        }
      }
      if (extractedArticle?.coverImagePath && fs.existsSync(extractedArticle.coverImagePath)) {
        try {
          fs.unlinkSync(extractedArticle.coverImagePath);
        } catch (_err) {
          void _err;
        }
      }
    }
  });

  test("extractArticle fails open safely on malformed and 1x1 data URIs without crashing", async () => {
    const dummyProse =
      "Event-driven architectures decouple microservices through durable message logs and event sourcing streams. ".repeat(
        25,
      );

    const articleHtml = `<!DOCTYPE html>
<html>
<head><title>Event Sourcing Patterns</title></head>
<body>
  <article>
    <h1>Event Sourcing Patterns</h1>
    <p>${dummyProse}</p>
    <img src="data:image/png;base64,corrupt_junk_data" alt="Broken Diagram" />
    <img src="${TRACKING_GIF_1X1_DATA_URI}" alt="Tracking Beacon" />
    <p>Final considerations regarding snapshots and schema evolution.</p>
  </article>
</body>
</html>`;

    const origFetch = globalThis.fetch;
    let extractedArticle: any = null;

    try {
      globalThis.fetch = (async (input: any) => {
        const urlStr = typeof input === "string" ? input : input?.url || "";
        if (urlStr.includes("event-sourcing")) {
          return new Response(articleHtml, {
            status: 200,
            headers: { "Content-Type": "text/html; charset=utf-8" },
          });
        }
        return origFetch(input);
      }) as any;

      // Must succeed without throwing
      extractedArticle = await extractArticle("https://example.com/event-sourcing");

      expect(extractedArticle).not.toBeNull();
      expect(extractedArticle.title).toBe("Event Sourcing Patterns");
      expect(extractedArticle.wordCount).toBeGreaterThan(150);

      // Broken and tracking images are omitted
      expect(extractedArticle.cleanedHtml).not.toContain("corrupt_junk_data");
      expect(extractedArticle.cleanedHtml).not.toContain("Tracking Beacon");
      expect(extractedArticle.cleanedHtml).not.toContain(TRACKING_GIF_1X1_DATA_URI);
    } finally {
      globalThis.fetch = origFetch;
      if (extractedArticle?.coverImagePath && fs.existsSync(extractedArticle.coverImagePath)) {
        try {
          fs.unlinkSync(extractedArticle.coverImagePath);
        } catch (_err) {
          void _err;
        }
      }
    }
  });

  test("convertHtmlToEpub extracts base64 images, bundles into EPUB, and cleans up temp files in finally block", () => {
    const htmlWithBase64 = `
      <h1>Substack Tech Post</h1>
      <p>Here is an embedded diagram that should be decoded and bundled into the EPUB:</p>
      <img src="${VALID_PNG_DATA_URI}" alt="Database Sharding Topology" />
      <p>Discussion on partition keys and consistent hashing.</p>
    `;

    // Track which /tmp/article_img_ files were created
    let generatedImagePath: string | null = null;
    const { tempImagePaths } = extractAndSaveBase64Images(htmlWithBase64);
    if (tempImagePaths.length > 0) {
      generatedImagePath = tempImagePaths[0];
    }

    // Run convertHtmlToEpub with the raw HTML containing base64 data URI
    const epubPath = convertHtmlToEpub(
      htmlWithBase64,
      "Substack Tech Post",
      "Tech Author",
      "Substack",
      "https://example.substack.com/p/sharding",
    );

    try {
      expect(fs.existsSync(epubPath)).toBe(true);
      expect(fs.statSync(epubPath).size).toBeGreaterThan(1024);

      // In finally block, convertHtmlToEpub unlinked temporary image files
      if (generatedImagePath) {
        expect(fs.existsSync(generatedImagePath)).toBe(false);
      }
    } finally {
      if (fs.existsSync(epubPath)) {
        try {
          fs.unlinkSync(epubPath);
        } catch (_err) {
          void _err;
        }
      }
      if (generatedImagePath && fs.existsSync(generatedImagePath)) {
        try {
          fs.unlinkSync(generatedImagePath);
        } catch (_err) {
          void _err;
        }
      }
    }
  });

  test("ingestArticleFromUrl cleans up temporary images in finally block", async () => {
    const testTempDir = fs.mkdtempSync(
      path.join(os.tmpdir(), "article-base64-ingest-test-"),
    );
    const mockCalibreScript = path.join(testTempDir, "mock_calibredb.sh");

    fs.writeFileSync(
      mockCalibreScript,
      `#!/bin/bash
if [ "$1" = "list" ]; then
  echo "[]"
  exit 0
elif [ "$1" = "add" ]; then
  echo "Added book ids: 202"
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
      "Modern cloud infrastructure scales horizontally through container orchestration and ingress controllers. ".repeat(
        25,
      );

    const articleHtml = `<html><head><title>Cloud Scaling</title></head><body><article><p>${prose}</p><img src="${VALID_PNG_DATA_URI}" alt="Cloud Architecture" /></article></body></html>`;

    const origFetch = globalThis.fetch;

    try {
      globalThis.fetch = (async () => {
        return new Response(articleHtml, {
          status: 200,
          headers: { "Content-Type": "text/html; charset=utf-8" },
        });
      }) as any;

      const res = await ingestArticleFromUrl("https://example.com/cloud-scaling");

      expect(res.success).toBe(true);
      expect(res.bookId).toBe(202);

      // Verify that any temporary image files were cleaned up
      const hash = crypto
        .createHash("sha256")
        .update(Buffer.from(VALID_PNG_2X2_BASE64, "base64"))
        .digest("hex")
        .slice(0, 16);
      const expectedPath = `/tmp/article_img_${hash}.png`;
      expect(fs.existsSync(expectedPath)).toBe(false);
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

