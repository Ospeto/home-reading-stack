/**
 * uploader/obsidian.test.ts
 *
 * Comprehensive test suite for LightHouse Obsidian note ingestion engine:
 *   - URI Parsing (open?vault&file, open?file, open?path, vault/vault/path, fragments, errors)
 *   - Vault discovery & mapping (obsidian.json, fallbacks, OBSIDIAN_VAULT_PATH, default vault)
 *   - Path safety & containment (path traversal blocking, unauthorized absolute paths)
 *   - YAML frontmatter parsing & defaults
 *   - Wikilink cleaning ([[Target|Display]] -> Display, [[Target]] -> Target)
 *   - Callout transformation (> [!type] Title -> semantic blockquote)
 *   - Embedded attachments (![[image.png]] and ![alt](img.png) into base64 data URIs)
 *   - Calibre duplicate checking & core ingestion (ingestObsidianNote)
 *   - Article pipeline integration (validateArticleUrl, extractAllUrlsFromText, ingestArticleFromUrl)
 */

import { describe, expect, it, beforeEach, afterEach } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";

import {
  parseObsidianUri,
  getObsidianVaultMap,
  getDefaultVaultPath,
  resolveObsidianNotePath,
  parseObsidianFrontmatter,
  cleanObsidianWikilinks,
  transformObsidianCallouts,
  resolveAndEmbedAttachments,
  loadObsidianNote,
  ingestObsidianNote,
  CALIBRE_SERVER_URL,
} from "./obsidian";
import {
  validateArticleUrl,
  extractUrlFromText,
  extractAllUrlsFromText,
  ingestArticleFromUrl,
} from "./article";

describe("Obsidian URI Parsing (parseObsidianUri)", () => {
  it("parses obsidian://open?vault=<vault>&file=<file> with URL-encoded parameters", () => {
    const uri = "obsidian://open?vault=My%20Vault&file=Projects%2FRoadmap";
    const res = parseObsidianUri(uri);
    expect(res.type).toBe("open_vault_file");
    expect(res.vault).toBe("My Vault");
    expect(res.file).toBe("Projects/Roadmap");
    expect(res.rawUri).toBe(uri);
  });

  it("parses obsidian://open?vault=<vault>&file=<file> with .md extension", () => {
    const uri = "obsidian://open?vault=Personal&file=Ideas%202026.md";
    const res = parseObsidianUri(uri);
    expect(res.type).toBe("open_vault_file");
    expect(res.vault).toBe("Personal");
    expect(res.file).toBe("Ideas 2026.md");
  });

  it("parses obsidian://open?file=<file> without vault (default vault)", () => {
    const uri = "obsidian://open?file=QuickNote.md";
    const res = parseObsidianUri(uri);
    expect(res.type).toBe("open_file");
    expect(res.vault).toBeUndefined();
    expect(res.file).toBe("QuickNote.md");
  });

  it("parses obsidian://open?path=<absolute_path>", () => {
    const uri =
      "obsidian://open?path=%2FUsers%2Fmacbookair%2FObsidian%2FTech%2FDistributed.md";
    const res = parseObsidianUri(uri);
    expect(res.type).toBe("open_path");
    expect(res.path).toBe("/Users/macbookair/Obsidian/Tech/Distributed.md");
  });

  it("parses obsidian://vault/<vault>/<path> URL path format", () => {
    const uri = "obsidian://vault/Work%20Vault/Engineering/Backend/API%20Design.md";
    const res = parseObsidianUri(uri);
    expect(res.type).toBe("vault_path");
    expect(res.vault).toBe("Work Vault");
    expect(res.file).toBe("Engineering/Backend/API Design.md");
  });

  it("strips heading fragments and block anchors from file paths", () => {
    const uriWithHeading =
      "obsidian://open?vault=Notes&file=Guide%23Getting%20Started";
    const resHeading = parseObsidianUri(uriWithHeading);
    expect(resHeading.file).toBe("Guide");

    const uriWithBlock = "obsidian://open?vault=Notes&file=Daily%5Eref123";
    const resBlock = parseObsidianUri(uriWithBlock);
    expect(resBlock.file).toBe("Daily");
  });

  it("parses notes and vaults containing % characters without URIError", () => {
    // URL with percent in query parameters
    const uri1 = "obsidian://open?vault=Vault%20100%25&file=Task%2050%25%20Done";
    const res1 = parseObsidianUri(uri1);
    expect(res1.type).toBe("open_vault_file");
    expect(res1.vault).toBe("Vault 100%");
    expect(res1.file).toBe("Task 50% Done");

    // URL with raw/unencoded % in query parameters (URLSearchParams leaves as-is, no URIError)
    const uri2 = "obsidian://open?file=Progress%20100%%20Done.md";
    const res2 = parseObsidianUri(uri2);
    expect(res2.file).toBe("Progress 100% Done.md");

    // URL with invalid percent sequences in vault pathname segments does not throw URIError
    const uri3 = "obsidian://vault/Vault%20100%/Projects/50%%20Design.md";
    const res3 = parseObsidianUri(uri3);
    expect(res3.type).toBe("vault_path");
    expect(res3.vault).toBe("Vault%20100%");
    expect(res3.file).toBe("Projects/50%%20Design.md");

    // URL with validly encoded percent in vault pathname segments
    const uri4 = "obsidian://vault/Vault%20100%25/Projects/50%25%20Design.md";
    const res4 = parseObsidianUri(uri4);
    expect(res4.type).toBe("vault_path");
    expect(res4.vault).toBe("Vault 100%");
    expect(res4.file).toBe("Projects/50% Design.md");
  });

  it("throws on missing file or path parameters", () => {
    expect(() => parseObsidianUri("obsidian://open?vault=OnlyVault")).toThrow(
      "missing required 'file' or 'path' parameter",
    );
  });

  it("throws on empty or non-obsidian protocol URIs", () => {
    expect(() => parseObsidianUri("")).toThrow("Missing or empty");
    expect(() => parseObsidianUri("https://example.com/note")).toThrow(
      "Expected \"obsidian:\"",
    );
    expect(() => parseObsidianUri("invalid-uri")).toThrow("Invalid URL format");
  });
});

describe("Obsidian Vault Discovery & Mapping", () => {
  let tempDir: string;
  let mockConfigFile: string;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "obsidian-test-vault-"));
    mockConfigFile = path.join(tempDir, "obsidian.json");
  });

  afterEach(() => {
    try {
      fs.rmSync(tempDir, { recursive: true, force: true });
    } catch {
      // ignore
    }
  });

  it("discovers vaults from obsidian.json config", () => {
    const vaultAPath = path.join(tempDir, "VaultA");
    const vaultBPath = path.join(tempDir, "VaultB");
    fs.mkdirSync(vaultAPath, { recursive: true });
    fs.mkdirSync(vaultBPath, { recursive: true });

    const mockConfig = {
      vaults: {
        id_vault_a: {
          path: vaultAPath,
          ts: 1000,
          open: true,
        },
        id_vault_b: {
          path: vaultBPath,
          ts: 2000,
        },
      },
    };
    fs.writeFileSync(mockConfigFile, JSON.stringify(mockConfig), "utf8");

    const map = getObsidianVaultMap([mockConfigFile]);
    expect(map.get("id_vault_a")).toBe(vaultAPath);
    expect(map.get("VaultA")).toBe(vaultAPath);
    expect(map.get("vaulta")).toBe(vaultAPath);
    expect(map.get("id_vault_b")).toBe(vaultBPath);
    expect(map.get("VaultB")).toBe(vaultBPath);
  });

  it("identifies active vault marked open: true as default vault", () => {
    const vaultAPath = path.join(tempDir, "VaultA");
    const vaultBPath = path.join(tempDir, "VaultB");
    fs.mkdirSync(vaultAPath, { recursive: true });
    fs.mkdirSync(vaultBPath, { recursive: true });

    const mockConfig = {
      vaults: {
        id_a: { path: vaultAPath, ts: 1000, open: true },
        id_b: { path: vaultBPath, ts: 5000 },
      },
    };
    fs.writeFileSync(mockConfigFile, JSON.stringify(mockConfig), "utf8");

    const map = getObsidianVaultMap([mockConfigFile]);
    const defaultPath = getDefaultVaultPath(map, [mockConfigFile]);
    expect(defaultPath).toBe(vaultAPath);
  });

  it("falls back to highest ts timestamp if none is marked open: true", () => {
    const vaultAPath = path.join(tempDir, "VaultA");
    const vaultBPath = path.join(tempDir, "VaultB");
    fs.mkdirSync(vaultAPath, { recursive: true });
    fs.mkdirSync(vaultBPath, { recursive: true });

    const mockConfig = {
      vaults: {
        id_a: { path: vaultAPath, ts: 1000 },
        id_b: { path: vaultBPath, ts: 5000 },
      },
    };
    fs.writeFileSync(mockConfigFile, JSON.stringify(mockConfig), "utf8");

    const map = getObsidianVaultMap([mockConfigFile]);
    const defaultPath = getDefaultVaultPath(map, [mockConfigFile]);
    expect(defaultPath).toBe(vaultBPath);
  });

  it("prioritizes OBSIDIAN_VAULT_PATH environment override", () => {
    const customVault = path.join(tempDir, "CustomVault");
    fs.mkdirSync(customVault, { recursive: true });

    const prevEnv = process.env.OBSIDIAN_VAULT_PATH;
    process.env.OBSIDIAN_VAULT_PATH = customVault;

    try {
      const defaultPath = getDefaultVaultPath();
      expect(defaultPath).toBe(customVault);
    } finally {
      if (prevEnv !== undefined) {
        process.env.OBSIDIAN_VAULT_PATH = prevEnv;
      } else {
        delete process.env.OBSIDIAN_VAULT_PATH;
      }
    }
  });
});

describe("Path Safety & Containment (resolveObsidianNotePath)", () => {
  let tempDir: string;
  let vaultPath: string;
  let vaultMap: Map<string, string>;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "obsidian-safe-test-"));
    vaultPath = path.join(tempDir, "MainVault");
    fs.mkdirSync(vaultPath, { recursive: true });

    vaultMap = new Map<string, string>();
    vaultMap.set("MainVault", vaultPath);
    vaultMap.set("mainvault", vaultPath);
  });

  afterEach(() => {
    try {
      fs.rmSync(tempDir, { recursive: true, force: true });
    } catch {
      // ignore
    }
  });

  it("resolves existing note in specified vault with or without .md extension", () => {
    const noteFile = path.join(vaultPath, "DeepWork.md");
    fs.writeFileSync(noteFile, "# Deep Work Content", "utf8");

    const parsed1 = parseObsidianUri("obsidian://open?vault=MainVault&file=DeepWork");
    const res1 = resolveObsidianNotePath(parsed1, { vaultMap });
    expect(res1.filePath).toBe(noteFile);
    expect(res1.vaultPath).toBe(vaultPath);

    const parsed2 = parseObsidianUri("obsidian://open?vault=MainVault&file=DeepWork.md");
    const res2 = resolveObsidianNotePath(parsed2, { vaultMap });
    expect(res2.filePath).toBe(noteFile);
  });

  it("resolves nested folder note paths correctly", () => {
    const subDir = path.join(vaultPath, "Projects", "2026");
    fs.mkdirSync(subDir, { recursive: true });
    const noteFile = path.join(subDir, "Vision.md");
    fs.writeFileSync(noteFile, "# 2026 Vision", "utf8");

    const parsed = parseObsidianUri(
      "obsidian://vault/MainVault/Projects/2026/Vision",
    );
    const res = resolveObsidianNotePath(parsed, { vaultMap });
    expect(res.filePath).toBe(noteFile);
  });

  it("blocks path traversal attempts (.. escaping the vault)", () => {
    const parsed = parseObsidianUri(
      "obsidian://open?vault=MainVault&file=../../../../etc/passwd",
    );
    expect(() => resolveObsidianNotePath(parsed, { vaultMap })).toThrow(
      "path traversal detected",
    );
  });

  it("blocks relative directory targets like . or ./ attempting to escape to vault root", () => {
    const parsedDot = parseObsidianUri("obsidian://open?vault=MainVault&file=.");
    expect(() => resolveObsidianNotePath(parsedDot, { vaultMap })).toThrow(
      "path traversal detected",
    );

    const parsedDotSlash = parseObsidianUri("obsidian://open?vault=MainVault&file=./");
    expect(() => resolveObsidianNotePath(parsedDotSlash, { vaultMap })).toThrow(
      "path traversal detected",
    );
  });

  it("blocks relative target escaping to sibling vault.md file", () => {
    const siblingMd = `${vaultPath}.md`;
    fs.writeFileSync(siblingMd, "# Sibling Vault Note", "utf8");

    const parsed = parseObsidianUri("obsidian://open?vault=MainVault&file=.");
    expect(() => resolveObsidianNotePath(parsed, { vaultMap })).toThrow(
      "path traversal detected",
    );

    const parsedSlash = parseObsidianUri("obsidian://open?vault=MainVault&file=./");
    expect(() => resolveObsidianNotePath(parsedSlash, { vaultMap })).toThrow(
      "path traversal detected",
    );
  });

  it("resolves vault with % in identifier without throwing URIError", () => {
    const percentVaultPath = path.join(tempDir, "Vault 100%");
    fs.mkdirSync(percentVaultPath, { recursive: true });
    const noteFile = path.join(percentVaultPath, "Progress.md");
    fs.writeFileSync(noteFile, "# Progress 100%", "utf8");

    const percentVaultMap = new Map<string, string>();
    percentVaultMap.set("Vault 100%", percentVaultPath);

    const parsed = parseObsidianUri(
      "obsidian://open?vault=Vault%20100%25&file=Progress",
    );
    const res = resolveObsidianNotePath(parsed, { vaultMap: percentVaultMap });
    expect(res.filePath).toBe(noteFile);
    expect(res.vaultPath).toBe(percentVaultPath);
  });

  it("blocks open_path URIs outside authorized vaults", () => {
    const outsideFile = path.join(tempDir, "outside.md");
    fs.writeFileSync(outsideFile, "# Secret", "utf8");

    const parsed = parseObsidianUri(
      `obsidian://open?path=${encodeURIComponent(outsideFile)}`,
    );
    expect(() =>
      resolveObsidianNotePath(parsed, {
        vaultMap,
        defaultVaultPath: vaultPath,
      }),
    ).toThrow("not within an authorized Obsidian vault");
  });

  it("permits open_path URIs within authorized vaults", () => {
    const insideFile = path.join(vaultPath, "AuthorizedNote.md");
    fs.writeFileSync(insideFile, "# Allowed", "utf8");

    const parsed = parseObsidianUri(
      `obsidian://open?path=${encodeURIComponent(insideFile)}`,
    );
    const res = resolveObsidianNotePath(parsed, {
      vaultMap,
      defaultVaultPath: vaultPath,
    });
    expect(res.filePath).toBe(insideFile);
    expect(res.vaultPath).toBe(vaultPath);
  });

  it("throws clear error when note does not exist on disk", () => {
    const parsed = parseObsidianUri(
      "obsidian://open?vault=MainVault&file=NonExistentNote",
    );
    expect(() => resolveObsidianNotePath(parsed, { vaultMap })).toThrow(
      "Obsidian note not found",
    );
  });
});

describe("YAML Frontmatter Parsing (parseObsidianFrontmatter)", () => {
  it("parses YAML frontmatter with title, authors, tags, and date", () => {
    const raw = `---
title: Designing Data-Intensive Applications
authors:
  - Martin Kleppmann
tags:
  - distributed-systems
  - databases
date: 2026-10-12
---

# Overview
This note covers storage engines.`;

    const { frontmatter, body } = parseObsidianFrontmatter(raw);
    expect(frontmatter.title).toBe("Designing Data-Intensive Applications");
    expect(frontmatter.authors).toEqual(["Martin Kleppmann"]);
    expect(frontmatter.tags).toEqual(["distributed-systems", "databases"]);
    expect(frontmatter.date).toBe("2026-10-12");
    expect(body.trim()).toBe("# Overview\nThis note covers storage engines.");
  });

  it("handles string author and comma-separated tags", () => {
    const raw = `---
title: Simple Note
author: Jane Doe
tags: tech, reading, research
---
Note body here.`;

    const { frontmatter, body } = parseObsidianFrontmatter(raw);
    expect(frontmatter.title).toBe("Simple Note");
    expect(frontmatter.author).toBe("Jane Doe");
    expect(frontmatter.tags).toBe("tech, reading, research");
    expect(body.trim()).toBe("Note body here.");
  });

  it("returns raw content as body when no frontmatter exists", () => {
    const raw = "# Just a Heading\n\nNo frontmatter here.";
    const { frontmatter, body } = parseObsidianFrontmatter(raw);
    expect(frontmatter).toEqual({});
    expect(body).toBe(raw);
  });

  it("handles malformed YAML gracefully without crashing", () => {
    const raw = `---
title: Broken YAML
author: [unclosed array
---
Body text`;
    const { frontmatter, body } = parseObsidianFrontmatter(raw);
    expect(frontmatter.title).toBe("Broken YAML");
    expect(body).toBe("Body text");
  });
});

describe("Obsidian Wikilink Cleaning (cleanObsidianWikilinks)", () => {
  it("cleans wikilinks with display aliases: [[Target|Display]] -> Display", () => {
    const input =
      "Check out [[Deep Work|Cal Newport's book]] for focus strategies.";
    expect(cleanObsidianWikilinks(input)).toBe(
      "Check out Cal Newport's book for focus strategies.",
    );
  });

  it("cleans simple wikilinks: [[Target]] -> Target", () => {
    const input = "Refer to [[Productivity Systems]] and [[Habits]].";
    expect(cleanObsidianWikilinks(input)).toBe(
      "Refer to Productivity Systems and Habits.",
    );
  });

  it("cleans wikilinks with heading anchors: [[Target#Heading|Alias]] and [[Target#Heading]]", () => {
    const input =
      "See [[System Architecture#Storage|Storage Specs]] and [[System Architecture#Networking]].";
    expect(cleanObsidianWikilinks(input)).toBe(
      "See Storage Specs and System Architecture.",
    );
  });

  it("does not modify image embeds ![[image.png]]", () => {
    const input =
      "Here is a diagram ![[architecture.png]] and a link to [[Overview]].";
    expect(cleanObsidianWikilinks(input)).toBe(
      "Here is a diagram ![[architecture.png]] and a link to Overview.",
    );
  });
});

describe("Obsidian Callout Transformation (transformObsidianCallouts)", () => {
  it("transforms callouts with custom titles into semantic blockquotes", () => {
    const md = `> [!note] Project Architecture
> This system uses Calibre and EPUB containers.
> Everything is local-first.`;

    const res = transformObsidianCallouts(md);
    expect(res).toContain('<blockquote class="callout callout-note">');
    expect(res).toContain(
      '<p class="callout-title"><strong>[NOTE] Project Architecture</strong></p>',
    );
    expect(res).toContain(
      "This system uses Calibre and EPUB containers.<br />Everything is local-first.",
    );
    expect(res).toContain("</blockquote>");
  });

  it("transforms callouts without custom titles into uppercase type titles", () => {
    const md = `> [!warning]
> Do not expose internal ports to the public WAN.`;

    const res = transformObsidianCallouts(md);
    expect(res).toContain('<blockquote class="callout callout-warning">');
    expect(res).toContain(
      '<p class="callout-title"><strong>[WARNING]</strong></p>',
    );
    expect(res).toContain("Do not expose internal ports to the public WAN.");
  });

  it("handles foldable callout markers [!tip]+ and [!info]-", () => {
    const md1 = `> [!tip]+ Expandable Tip
> Useful advice here.`;
    const res1 = transformObsidianCallouts(md1);
    expect(res1).toContain('<blockquote class="callout callout-tip">');
    expect(res1).toContain("[TIP] Expandable Tip");

    const md2 = `> [!info]- Collapsed Info
> Hidden detail.`;
    const res2 = transformObsidianCallouts(md2);
    expect(res2).toContain('<blockquote class="callout callout-info">');
    expect(res2).toContain("[INFO] Collapsed Info");
  });

  it("escapes HTML entities in callout titles (<, >, &, \")", () => {
    const md = `> [!tip] Latency < 10ms & Throughput > "1000 QPS"
> Performance benchmarks.`;
    const res = transformObsidianCallouts(md);
    expect(res).toContain("&lt; 10ms &amp; Throughput &gt; &quot;1000 QPS&quot;");
    expect(res).not.toContain("Latency < 10ms");
  });

  it("preserves following regular markdown paragraphs intact", () => {
    const md = `> [!success] Completed
> All unit tests pass.

Here is a standard paragraph after the callout.`;

    const res = transformObsidianCallouts(md);
    expect(res).toContain("callout-success");
    expect(res).toContain("All unit tests pass.");
    expect(res).toContain("Here is a standard paragraph after the callout.");
  });
});

describe("Attachment Embedding (resolveAndEmbedAttachments)", () => {
  let tempVaultDir: string;
  let notePath: string;

  beforeEach(() => {
    tempVaultDir = fs.mkdtempSync(path.join(os.tmpdir(), "obsidian-embed-test-"));
    const notesDir = path.join(tempVaultDir, "notes");
    fs.mkdirSync(notesDir, { recursive: true });
    notePath = path.join(notesDir, "Sample.md");

    // Create attachments folder in vault root
    const attachDir = path.join(tempVaultDir, "attachments");
    fs.mkdirSync(attachDir, { recursive: true });

    // Write a dummy 1x1 PNG
    const dummyPng = Buffer.from(
      "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==",
      "base64",
    );
    fs.writeFileSync(path.join(attachDir, "diagram.png"), dummyPng);

    // Write a local image next to the note
    fs.writeFileSync(path.join(notesDir, "local_chart.png"), dummyPng);
  });

  afterEach(() => {
    try {
      fs.rmSync(tempVaultDir, { recursive: true, force: true });
    } catch {
      // ignore
    }
  });

  it("resolves ![[diagram.png]] from attachments folder into base64 data URI", () => {
    const content = "Look at this visual:\n![[diagram.png|System Diagram]]";
    const res = resolveAndEmbedAttachments(content, notePath, tempVaultDir);
    expect(res).toContain('<figure><img src="data:image/png;base64,');
    expect(res).toContain('alt="System Diagram"');
    expect(res).toContain("<figcaption>System Diagram</figcaption>");
  });

  it("resolves local images in the same directory as the note", () => {
    const content = "Local image embed:\n![[local_chart.png]]";
    const res = resolveAndEmbedAttachments(content, notePath, tempVaultDir);
    expect(res).toContain('<figure><img src="data:image/png;base64,');
    expect(res).toContain('alt="local_chart.png"');
  });

  it("ignores width dimension markers like ![[diagram.png|400]] without using width as caption", () => {
    const content = "Resized embed:\n![[diagram.png|400]]";
    const res = resolveAndEmbedAttachments(content, notePath, tempVaultDir);
    expect(res).toContain('<figure><img src="data:image/png;base64,');
    expect(res).toContain('alt=""');
    expect(res).not.toContain("<figcaption>400</figcaption>");
  });

  it("resolves standard markdown local image references ![Alt Text](diagram.png)", () => {
    const content = "Markdown reference: ![Architecture](diagram.png)";
    const res = resolveAndEmbedAttachments(content, notePath, tempVaultDir);
    expect(res).toContain('<figure><img src="data:image/png;base64,');
    expect(res).toContain('alt="Architecture"');
    expect(res).toContain("<figcaption>Architecture</figcaption>");
  });

  it("renders a missing attachment placeholder when the file cannot be located", () => {
    const content = "Missing file:\n![[ghost_file.png]]";
    const res = resolveAndEmbedAttachments(content, notePath, tempVaultDir);
    expect(res).toContain('<p class="missing-attachment">');
    expect(res).toContain("Attachment not found: ghost_file.png");
  });

  it("rejects attachments in sibling directories outside the vault", () => {
    const siblingDir = path.join(path.dirname(tempVaultDir), `${path.basename(tempVaultDir)}-sibling`);
    fs.mkdirSync(siblingDir, { recursive: true });
    const secretPng = path.join(siblingDir, "secret.png");
    fs.writeFileSync(secretPng, "secret");

    const content = "Sibling leak: ![[../" + path.basename(siblingDir) + "/secret.png]]";
    const res = resolveAndEmbedAttachments(content, notePath, tempVaultDir);
    expect(res).toContain('<p class="missing-attachment">');
    expect(res).not.toContain("data:image");
  });

  it("escapes HTML entities in attachment alt text and captions", () => {
    const content = '![Architecture "V2" & Design <Draft>](diagram.png)';
    const res = resolveAndEmbedAttachments(content, notePath, tempVaultDir);
    expect(res).toContain('alt="Architecture &quot;V2&quot; &amp; Design &lt;Draft&gt;"');
    expect(res).toContain("<figcaption>Architecture &quot;V2&quot; &amp; Design &lt;Draft&gt;</figcaption>");
  });

  it("leaves external and existing data URIs untouched", () => {
    const content =
      "Web image: ![External](https://example.com/photo.jpg)\nData URI: ![Data](data:image/png;base64,abc)";
    const res = resolveAndEmbedAttachments(content, notePath, tempVaultDir);
    expect(res).toBe(content);
  });
});

describe("End-to-End Note Loading (loadObsidianNote)", () => {
  let tempVault: string;
  let vaultMap: Map<string, string>;

  beforeEach(() => {
    tempVault = fs.mkdtempSync(path.join(os.tmpdir(), "obsidian-load-test-"));
    vaultMap = new Map();
    vaultMap.set("Research", tempVault);
  });

  afterEach(() => {
    try {
      fs.rmSync(tempVault, { recursive: true, force: true });
    } catch {
      // ignore
    }
  });

  it("loads and transforms note with frontmatter, callouts, and wikilinks", () => {
    const noteFile = path.join(tempVault, "QuantumComputing.md");
    const rawNote = `---
title: Principles of Quantum Computing
author: Richard Feynman
tags:
  - physics
  - quantum
date: 2026-10-12
---

# Quantum Mechanics

> [!note] Superposition
> A qubit can exist in a linear combination of states.

Read more in [[Qubit Theory|Fundamentals]] and [[Entanglement]].
`;
    fs.writeFileSync(noteFile, rawNote, "utf8");

    const data = loadObsidianNote(
      "obsidian://open?vault=Research&file=QuantumComputing",
      { vaultMap },
    );

    expect(data.title).toBe("Principles of Quantum Computing");
    expect(data.authors).toBe("Richard Feynman");
    expect(data.tags).toEqual(["physics", "quantum"]);
    expect(data.date).toBe("2026-10-12");
    expect(data.wordCount).toBeGreaterThan(10);
    expect(data.readTimeMinutes).toBe(1);

    // Verify transformed HTML
    expect(data.transformedHtml).toContain("<h1>Quantum Mechanics</h1>");
    expect(data.transformedHtml).toContain("callout-note");
    expect(data.transformedHtml).toContain("[NOTE] Superposition");
    expect(data.transformedHtml).toContain("Read more in Fundamentals and Entanglement.");
  });

  it("handles list of authors specified under singular author: in frontmatter", () => {
    const noteFile = path.join(tempVault, "MultiAuthor.md");
    const rawNote = `---
title: Pair Programming
author:
  - Martin Fowler
  - Kent Beck
---
# Content`;
    fs.writeFileSync(noteFile, rawNote, "utf8");

    const data = loadObsidianNote(
      "obsidian://open?vault=Research&file=MultiAuthor",
      { vaultMap },
    );
    expect(data.authors).toBe("Martin Fowler, Kent Beck");
  });

  it("falls back to note filename when frontmatter title is missing", () => {
    const noteFile = path.join(tempVault, "UntypedNotes.md");
    fs.writeFileSync(noteFile, "# Just plain text", "utf8");

    const data = loadObsidianNote(
      "obsidian://open?vault=Research&file=UntypedNotes",
      { vaultMap },
    );
    expect(data.title).toBe("UntypedNotes");
    expect(data.authors).toBe("Obsidian");
  });
});

describe("Calibre Ingestion Engine (ingestObsidianNote)", () => {
  let tempDir: string;
  let vaultDir: string;
  let dropDir: string;
  let vaultMap: Map<string, string>;
  let mockConvertScript: string;
  let prevEbookConvertPath: string | undefined;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "obsidian-ingest-test-"));
    vaultDir = path.join(tempDir, "Vault");
    dropDir = path.join(tempDir, "Drop");
    fs.mkdirSync(vaultDir, { recursive: true });
    fs.mkdirSync(dropDir, { recursive: true });

    vaultMap = new Map();
    vaultMap.set("TestVault", vaultDir);

    process.env.BOOKS_DROP_DIR = dropDir;

    prevEbookConvertPath = process.env.EBOOK_CONVERT_PATH;
    mockConvertScript = path.join(tempDir, "mock_ebook_convert.sh");
    fs.writeFileSync(
      mockConvertScript,
      `#!/bin/bash
touch "$2"
exit 0
`,
      { mode: 0o755 },
    );
    process.env.EBOOK_CONVERT_PATH = mockConvertScript;
  });

  afterEach(() => {
    if (prevEbookConvertPath !== undefined) {
      process.env.EBOOK_CONVERT_PATH = prevEbookConvertPath;
    } else {
      delete process.env.EBOOK_CONVERT_PATH;
    }
    try {
      fs.rmSync(tempDir, { recursive: true, force: true });
    } catch {
      // ignore
    }
  });

  it("detects existing duplicate notes via Calibre comments query", async () => {
    const noteFile = path.join(vaultDir, "DuplicateNote.md");
    fs.writeFileSync(noteFile, "# Duplicate Note Content", "utf8");
    const uri = "obsidian://open?vault=TestVault&file=DuplicateNote";

    // Mock spawnSync that returns an existing book when searching comments
    const mockSpawnSync = ((_cmd: string, args: string[]) => {
      if (args.includes("list") && args.includes(`comments:"${uri}"`)) {
        return {
          status: 0,
          stdout: JSON.stringify([
            {
              id: 777,
              title: "Duplicate Note",
              authors: ["Obsidian"],
            },
          ]),
          stderr: "",
        };
      }
      return { status: 0, stdout: "[]", stderr: "" };
    }) as any;

    const res = await ingestObsidianNote(uri, {
      spawnSync: mockSpawnSync,
      vaultMap,
    });

    expect(res.success).toBe(true);
    expect(res.duplicate).toBe(true);
    expect(res.bookId).toBe(777);
    expect(res.message).toContain("Note already exists in Calibre (ID: 777)");
  });

  it("detects duplicates via fallback query on physical file path", async () => {
    const noteFile = path.join(vaultDir, "PathDuplicateNote.md");
    fs.writeFileSync(noteFile, "# Path Duplicate Note", "utf8");
    const uri = "obsidian://open?vault=TestVault&file=PathDuplicateNote";

    // Mock spawnSync that returns empty for cleanUri, but finds duplicate for filePath
    const mockSpawnSync = ((_cmd: string, args: string[]) => {
      if (args.includes("list")) {
        if (args.includes(`comments:"${uri}"`)) {
          return { status: 0, stdout: "[]", stderr: "" };
        }
        if (args.includes(`comments:"${noteFile}"`)) {
          return {
            status: 0,
            stdout: JSON.stringify([
              {
                id: 999,
                title: "Path Duplicate Note",
                authors: ["Original Author"],
              },
            ]),
            stderr: "",
          };
        }
      }
      return { status: 0, stdout: "[]", stderr: "" };
    }) as any;

    const res = await ingestObsidianNote(uri, {
      spawnSync: mockSpawnSync,
      vaultMap,
    });

    expect(res.success).toBe(true);
    expect(res.duplicate).toBe(true);
    expect(res.bookId).toBe(999);
    expect(res.message).toContain("Note already exists in Calibre (ID: 999)");
  });

  it("handles Calibre add failure gracefully", async () => {
    const noteFile = path.join(vaultDir, "FailedNote.md");
    fs.writeFileSync(noteFile, "# Failed Note Content", "utf8");
    const uri = "obsidian://open?vault=TestVault&file=FailedNote";

    // Mock calibredb runner that fails on add
    const mockSpawnSync = ((_cmd: string, args: string[]) => {
      if (args.includes("list")) {
        return { status: 0, stdout: "[]", stderr: "" };
      }
      if (args[0] === "add") {
        return {
          status: 1,
          stdout: "",
          stderr: "calibredb: database write lock timeout",
        };
      }
      return { status: 0, stdout: "", stderr: "" };
    }) as any;

    const res = await ingestObsidianNote(uri, {
      spawnSync: mockSpawnSync,
      vaultMap,
    });

    expect(res.success).toBe(false);
    expect(res.error).toContain("database write lock timeout");
  });

  it("ingests note successfully into Calibre and creates drop file", async () => {
    const noteFile = path.join(vaultDir, "SuccessNote.md");
    fs.writeFileSync(
      noteFile,
      `---
title: Success Note
author: Test Author
tags:
  - testing
---
# Success Note Content
This is an authentic test note for Calibre ingestion.`,
      "utf8",
    );
    const uri = "obsidian://open?vault=TestVault&file=SuccessNote";

    // Mock calibredb runner that succeeds on add and returns bookId 123
    const mockSpawnSync = ((_cmd: string, args: string[]) => {
      if (args.includes("list")) {
        return { status: 0, stdout: "[]", stderr: "" };
      }
      if (args[0] === "add") {
        return {
          status: 0,
          stdout: "Added book ids: 123",
          stderr: "",
        };
      }
      if (args[0] === "set_metadata") {
        return { status: 0, stdout: "", stderr: "" };
      }
      return { status: 0, stdout: "", stderr: "" };
    }) as any;

    const res = await ingestObsidianNote(uri, {
      spawnSync: mockSpawnSync,
      vaultMap,
    });

    expect(res.success).toBe(true);
    expect(res.bookId).toBe(123);
    expect(res.title).toBe("Success Note");
    expect(res.authors).toBe("Test Author");
    expect(res.siteName).toBe("Obsidian");
    expect(res.epubPath).toBeDefined();
    expect(fs.existsSync(res.epubPath!)).toBe(true);
    expect(res.message).toContain("Successfully ingested Obsidian note");
  });
});

describe("Pipeline Integration (article.ts & server.ts)", () => {
  it("allows obsidian:// URLs in validateArticleUrl without SSRF rejection", () => {
    const uri = "obsidian://open?vault=Vault&file=Note";
    const validated = validateArticleUrl(uri);
    expect(validated.protocol).toBe("obsidian:");
    expect(validated.href).toContain("open?vault=Vault&file=Note");
  });

  it("rejects unsupported non-http protocols in validateArticleUrl", () => {
    expect(() => validateArticleUrl("ftp://example.com/file.epub")).toThrow(
      "Unsupported URL protocol: ftp:",
    );
  });

  it("extracts obsidian:// URIs in extractAllUrlsFromText and extractUrlFromText", () => {
    const conversationalText = `Hey team, please ingest this note:
obsidian://open?vault=Knowledge&file=DistributedSystems.md
and check https://example.com/article for reference.`;

    const allUrls = extractAllUrlsFromText(conversationalText);
    expect(allUrls).toHaveLength(2);
    expect(allUrls[0]).toBe(
      "obsidian://open?vault=Knowledge&file=DistributedSystems.md",
    );
    expect(allUrls[1]).toBe("https://example.com/article");

    const singleUrl = extractUrlFromText(conversationalText);
    expect(singleUrl).toBe(
      "obsidian://open?vault=Knowledge&file=DistributedSystems.md",
    );
  });

  it("extractUrlFromText handles commands with obsidian URIs (/read obsidian://...)", () => {
    const cmd =
      "/read obsidian://vault/MAS/03-Resources/Books/Founder%20Mode.md";
    const extracted = extractUrlFromText(cmd);
    expect(extracted).toBe(
      "obsidian://vault/MAS/03-Resources/Books/Founder%20Mode.md",
    );
  });

  it("routes obsidian:// URIs directly to ingestObsidianNote in ingestArticleFromUrl", async () => {
    // If an invalid note path is given, it should return an Obsidian Note error rather than SSRF rejection
    const invalidUri = "obsidian://open?vault=NonExistentVault&file=MissingNote";
    const res = await ingestArticleFromUrl(invalidUri);
    expect(res.success).toBe(false);
    expect(res.siteName).toBe("Obsidian");
    expect(res.error).toContain("Obsidian vault \"NonExistentVault\" not found");
  });
});
