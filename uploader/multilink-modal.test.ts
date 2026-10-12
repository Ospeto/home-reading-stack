import { describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";

describe("Web Uploader Batch Multi-Link Ingestion (#urlModal)", () => {
  const htmlPath = path.join(import.meta.dir, "index.html");
  const html = fs.readFileSync(htmlPath, "utf8");

  it("index.html contains #urlModal with segmented mode controls for single vs batch links", () => {
    expect(html).toContain('id="urlModal"');
    expect(html).toContain('id="urlModeSingleBtn"');
    expect(html).toContain('id="urlModeBatchBtn"');
    expect(html).toContain('id="urlSingleInputContainer"');
    expect(html).toContain('id="urlBatchInputContainer"');
    expect(html).toContain('id="articleUrlInput"');
    expect(html).toContain('placeholder="https://example.com/article... or obsidian://open?..."');
    expect(html).toContain('inputmode="url"');
    expect(html).toContain('id="urlIngestForm" novalidate');
    expect(html).toContain('id="articleUrlsTextarea"');
    expect(html).toContain('id="batchUrlCountBadge"');
    expect(html).toContain('id="urlIngestStatus"');
    expect(html).toContain('id="urlIngestBtn"');
    expect(html).toContain('id="urlCancelBtn"');
  });

  it("index.html defines extractUrlsFromText, isLightNovelUrl, and setUrlIngestMode", () => {
    expect(html).toContain("function setUrlIngestMode(mode)");
    expect(html).toContain("function updateBatchUrlCountBadge()");
    expect(html).toContain("function extractUrlsFromText(text)");
    expect(html).toContain("function isLightNovelUrl(targetUrl)");
    expect(html).toContain("async function ingestSingleArticleUrl(targetUrl, onSubstatus)");
    expect(html).toContain("async function handleUrlIngest(e)");
  });

  it("index.html displays sequential live progress indicators and completion cards", () => {
    expect(html).toContain("Ingesting link ${step} of ${total}");
    expect(html).toContain("Processed so far (${results.length}/${total})");
    expect(html).toContain("Batch Complete: All ${successCount} articles saved to library");
    expect(html).toContain("Processed ${total} URLs sequentially. EPUB files synced to your Calibre library.");
    expect(html).toContain("Batch Ingestion Error");
    expect(html).toContain("View Book Details");
  });

  it("openUrlModal allows reopening without resetting state when ingestion is active", () => {
    expect(html).toContain("if (isUrlIngesting) {\n        openModalAnimated('urlModal', false);\n        return;\n      }");
  });

  it("index.html preserves Light Novel routing for single Lnori / Elscione URLs", () => {
    expect(html).toContain("if (urls.length === 1 && isLightNovelUrl(urls[0])) {");
    expect(html).toContain("closeUrlModal();");
    expect(html).toContain("openLnoriModal(urls[0]);");
    expect(html).toContain("showToast('Switched to Light Novel Ingestion');");
  });

  it("index.html connection guide documents multi-link batch URL ingestion", () => {
    expect(html).toContain("Batch Multi-Link Reading Lists");
    expect(html).toContain("#urlModal");
    expect(html).toContain("Ingesting link X of Y");
  });

  it("extractUrlsFromText matches expected parsing logic from index.html", () => {
    const fnMatch = html.match(/function extractUrlsFromText\(text\) \{([\s\S]*?)\n {4}\}/);
    expect(fnMatch).not.toBeNull();
    const extractFn = new Function("text", fnMatch![1]) as (text: string) => string[];

    // Single URL
    expect(extractFn("https://example.com/article")).toEqual([
      "https://example.com/article"
    ]);

    // Multi-line list with comments, empty lines, and brackets
    const multilineInput = `
      # Morning Reading List
      https://example.com/article-1
      
      // Secondary link
      <https://example.com/article-2>
      (https://example.com/article-3)
      [Read this](https://example.com/article-4)
      bare-domain.org/essay.html
      https://example.com/article-1 # Duplicate link
      https://example.com/article-5 # inline comment with trailing http://ignored.com
    `;
    const extracted = extractFn(multilineInput);
    expect(extracted).toEqual([
      "https://example.com/article-1",
      "https://example.com/article-2",
      "https://example.com/article-3",
      "https://example.com/article-4",
      "https://bare-domain.org/essay.html",
      "https://example.com/article-5"
    ]);

    // Non-URL text and whitespace-only
    expect(extractFn("")).toEqual([]);
    expect(extractFn("   \n\n  ")).toEqual([]);
    expect(extractFn("random notes without any urls")).toEqual([]);
  });

  it("isLightNovelUrl detects Lnori and Elscione domains and distinguishes general articles", () => {
    const fnMatch = html.match(/function isLightNovelUrl\(targetUrl\) \{([\s\S]*?)\n {4}\}/);
    expect(fnMatch).not.toBeNull();
    const isNovelFn = new Function("targetUrl", fnMatch![1]) as (url: string) => boolean;

    expect(isNovelFn("https://lnori.com/series/8046/the-genius-prince")).toBe(true);
    expect(isNovelFn("https://www.lnori.com/book/1234/volume-1")).toBe(true);
    expect(isNovelFn("https://server.elscione.com/Officially%20Translated%20Light%20Novels/Overlord/")).toBe(true);
    expect(isNovelFn("https://elsci.one/novels/test")).toBe(true);
    expect(isNovelFn("https://server.elsci.one/novels/test")).toBe(true);

    expect(isNovelFn("https://paulgraham.com/lesson.html")).toBe(false);
    expect(isNovelFn("https://medium.com/@author/tech-post")).toBe(false);
    expect(isNovelFn("https://news.ycombinator.com")).toBe(false);
  });

  it("extractHttpUrl in index.html recognizes obsidian:// URIs and standard HTTP URLs", () => {
    const fnMatch = html.match(/function extractHttpUrl\(text\) \{([\s\S]*?)\n {4}\}/);
    expect(fnMatch).not.toBeNull();
    const extractHttpUrlFn = new Function("text", fnMatch![1]) as (text: string) => string | null;

    expect(extractHttpUrlFn("obsidian://open?vault=Obsidian&file=Notes%2FTest")).toBe(
      "obsidian://open?vault=Obsidian&file=Notes%2FTest"
    );
    expect(extractHttpUrlFn("Check this out: obsidian://open?vault=MAS&file=Doc.md!")).toBe(
      "obsidian://open?vault=MAS&file=Doc.md"
    );
    expect(extractHttpUrlFn("<obsidian://open?vault=Obsidian&file=DeepLearning>")).toBe(
      "obsidian://open?vault=Obsidian&file=DeepLearning"
    );
    expect(extractHttpUrlFn("https://example.com/article")).toBe("https://example.com/article");
  });

  it("extractUrlsFromText parses obsidian:// URIs in single, batch, and mixed markdown text", () => {
    const fnMatch = html.match(/function extractUrlsFromText\(text\) \{([\s\S]*?)\n {4}\}/);
    expect(fnMatch).not.toBeNull();
    const extractFn = new Function("text", fnMatch![1]) as (text: string) => string[];

    // Single obsidian:// URI
    expect(extractFn("obsidian://open?vault=Obsidian&file=Articles%2FDeepLearning")).toEqual([
      "obsidian://open?vault=Obsidian&file=Articles%2FDeepLearning"
    ]);

    // Batch list with obsidian links, comments, angle brackets, and duplicates
    const batchObsidian = `
      # Obsidian Reading List
      obsidian://open?vault=Obsidian&file=Reading%2FArticle1
      <obsidian://open?vault=MAS&file=Books%2FBook2>
      [Research Note](obsidian://open?vault=Obsidian&file=Research%2FPaper)
      obsidian://open?vault=Obsidian&file=Reading%2FArticle1 # Duplicate link
      obsidian://open?path=%2FUsers%2Fospeto%2FNote.md
    `;
    expect(extractFn(batchObsidian)).toEqual([
      "obsidian://open?vault=Obsidian&file=Reading%2FArticle1",
      "obsidian://open?vault=MAS&file=Books%2FBook2",
      "obsidian://open?vault=Obsidian&file=Research%2FPaper",
      "obsidian://open?path=%2FUsers%2Fospeto%2FNote.md"
    ]);

    // Mixed HTTP and obsidian URLs in markdown text
    const mixedMarkdown = `
      Check out [Web Article](https://example.com/post) alongside [Obsidian Note](obsidian://open?vault=Obsidian&file=Notes%2FPostSummary)
      And this reference: https://news.ycombinator.com/item?id=123
      obsidian://vault/Work/Daily/2026-10-12
    `;
    expect(extractFn(mixedMarkdown)).toEqual([
      "https://example.com/post",
      "obsidian://open?vault=Obsidian&file=Notes%2FPostSummary",
      "https://news.ycombinator.com/item?id=123",
      "obsidian://vault/Work/Daily/2026-10-12"
    ]);
  });
});
