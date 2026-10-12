/**
 * uploader/obsidian.ts
 *
 * LightHouse Local Obsidian Vault Note Ingestion Engine:
 *   - Parses Obsidian URIs:
 *       * obsidian://open?vault=<vault>&file=<file> (with or without .md, URL-decoded)
 *       * obsidian://open?file=<file> (resolves against active or default vault)
 *       * obsidian://open?path=<absolute_path> (URL-decoded path with containment safety)
 *       * obsidian://vault/<vault>/<path> (URL path segments)
 *   - Vault discovery & resolution:
 *       * Inspects macOS/Linux obsidian.json configuration files
 *       * Fallbacks: OBSIDIAN_VAULT_PATH, ~/Obsidian, ~/MAS, ~/Documents/Obsidian Vault
 *       * Enforces path containment within authorized vaults; blocks path traversal
 *   - Note loading & Obsidian syntax transformation:
 *       * Parses YAML frontmatter (title, author/authors, tags, date)
 *       * Cleans wikilinks: [[Target|Display]] -> Display, [[Target]] -> Target
 *       * Transforms callouts: > [!type] Title into semantic, readable blockquotes
 *       * Resolves embedded attachments: ![[image.png]] / ![alt](image.png) into base64 data URIs
 *   - Core ingestion function ingestObsidianNote(uri):
 *       * Upfront duplicate check in Calibre comments
 *       * Converts formatted HTML to EPUB with typographic cover
 *       * Ingests into Calibre library via calibredb add with Obsidian tags and source comments
 */

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";

import {
  buildStyledHtmlDocument,
  convertHtmlToEpub,
  generateTypographicCover,
  getCalibredbPath,
  getDropDir,
  markdownToHtml,
  stripTrackingParams,
  type IngestArticleResult,
} from "./article";
import {
  evaluateJunkGate,
  moveToQuarantine,
  resolveBookLanguageAndTags,
} from "./jev-shelf";
import { cleanString } from "./scraper";

export const CALIBRE_SERVER_URL =
  process.env.CALIBRE_SERVER_URL || "http://127.0.0.1:8088";

// ----------------------------------------------------------------------------
// Interfaces & Types
// ----------------------------------------------------------------------------

export type ObsidianUriType =
  | "open_vault_file"
  | "open_file"
  | "open_path"
  | "vault_path";

export interface ObsidianParsedUri {
  type: ObsidianUriType;
  vault?: string;
  file?: string;
  path?: string;
  rawUri: string;
}

export interface ObsidianFrontmatter {
  title?: string;
  author?: string | string[];
  authors?: string | string[];
  tags?: string | string[];
  date?: string;
  [key: string]: unknown;
}

export interface ObsidianNoteData {
  filePath: string;
  vaultPath: string;
  vaultName: string;
  rawContent: string;
  frontmatter: ObsidianFrontmatter;
  title: string;
  authors: string;
  tags: string[];
  date?: string;
  transformedHtml: string;
  wordCount: number;
  readTimeMinutes: number;
}

export interface ObsidianDependencies {
  spawnSync?: typeof spawnSync;
  calibredbPath?: string;
  serverUrl?: string;
  vaultMap?: Map<string, string>;
  defaultVaultPath?: string;
}

// ----------------------------------------------------------------------------
// 1. URI Parsing
// ----------------------------------------------------------------------------

/**
 * Clean fragment anchors (#heading or ^block) from Obsidian note filenames.
 */
function stripNoteFragment(filename: string): string {
  if (!filename) return "";
  return filename.replace(/[#^].*$/, "").trim();
}

/**
 * Parse an Obsidian URI string into structured parameters.
 * Supports:
 *   - obsidian://open?vault=<vault>&file=<file>
 *   - obsidian://open?file=<file>
 *   - obsidian://open?path=<absolute_path>
 *   - obsidian://vault/<vault>/<path>
 */
export function parseObsidianUri(uri: string): ObsidianParsedUri {
  if (!uri || typeof uri !== "string") {
    throw new Error("Missing or empty Obsidian URI");
  }

  const trimmed = uri.trim();
  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch (_err) {
    void _err;
    throw new Error(`Invalid URL format: "${trimmed}"`);
  }

  if (parsed.protocol !== "obsidian:") {
    throw new Error(
      `Unsupported protocol: "${parsed.protocol}". Expected "obsidian:"`,
    );
  }

  const hostname = parsed.hostname.toLowerCase();

  // Pattern: obsidian://open?...
  if (hostname === "open") {
    const rawPath = parsed.searchParams.get("path");
    if (rawPath && rawPath.trim()) {
      return {
        type: "open_path",
        path: stripNoteFragment(rawPath.trim()),
        rawUri: trimmed,
      };
    }

    const rawFile = parsed.searchParams.get("file");
    const rawVault = parsed.searchParams.get("vault");

    if (!rawFile || !rawFile.trim()) {
      throw new Error(
        "Obsidian URI missing required 'file' or 'path' parameter",
      );
    }

    const file = stripNoteFragment(rawFile.trim());
    if (!file) {
      throw new Error("Obsidian URI specifies an empty note file path");
    }

    if (rawVault && rawVault.trim()) {
      return {
        type: "open_vault_file",
        vault: rawVault.trim(),
        file,
        rawUri: trimmed,
      };
    }

    return {
      type: "open_file",
      file,
      rawUri: trimmed,
    };
  }

  // Pattern: obsidian://vault/<vault>/<path>
  if (hostname === "vault") {
    const pathname = parsed.pathname.replace(/^\/+/, "");
    const segments = pathname.split("/").filter(Boolean);

    if (segments.length < 2) {
      throw new Error(
        `Invalid obsidian://vault/ URI: expected at least vault and file segments in "${trimmed}"`,
      );
    }

    const safeDecode = (segment: string): string => {
      try {
        return decodeURIComponent(segment);
      } catch {
        return segment;
      }
    };

    const vault = safeDecode(segments[0]);
    const file = stripNoteFragment(
      segments.slice(1).map(safeDecode).join("/"),
    );

    if (!file) {
      throw new Error("Obsidian URI specifies an empty note file path");
    }

    return {
      type: "vault_path",
      vault,
      file,
      rawUri: trimmed,
    };
  }

  throw new Error(`Unrecognized Obsidian URI action: "${hostname}"`);
}

// ----------------------------------------------------------------------------
// 2. Vault Discovery & Resolution
// ----------------------------------------------------------------------------

export function getObsidianConfigPaths(): string[] {
  const home = os.homedir();
  return [
    path.join(home, "Library", "Application Support", "obsidian", "obsidian.json"),
    path.join(home, ".config", "obsidian", "obsidian.json"),
  ];
}

/**
 * Discover known Obsidian vaults from configuration files and standard fallback paths.
 * Maps vault IDs, folder names, and lowercased variants to absolute directory paths.
 */
export function getObsidianVaultMap(customConfigPaths?: string[]): Map<string, string> {
  const vaultMap = new Map<string, string>();
  const configPaths = customConfigPaths && customConfigPaths.length > 0
    ? customConfigPaths
    : getObsidianConfigPaths();

  for (const cfgPath of configPaths) {
    if (fs.existsSync(cfgPath)) {
      try {
        const raw = fs.readFileSync(cfgPath, "utf8");
        const parsed = JSON.parse(raw);
        if (parsed?.vaults && typeof parsed.vaults === "object") {
          for (const [vaultId, info] of Object.entries(parsed.vaults)) {
            const vPath = (info as any)?.path;
            if (typeof vPath === "string" && vPath.trim()) {
              const absPath = path.resolve(vPath.trim());
              const folderName = path.basename(absPath);

              vaultMap.set(vaultId, absPath);
              vaultMap.set(vaultId.toLowerCase(), absPath);
              vaultMap.set(folderName, absPath);
              vaultMap.set(folderName.toLowerCase(), absPath);
            }
          }
        }
      } catch (_err) {
        void _err;
      }
    }
  }

  // Fallback candidate directories
  const home = os.homedir();
  const fallbackCandidates: string[] = [
    process.env.OBSIDIAN_VAULT_PATH,
    path.join(home, "Obsidian"),
    path.join(home, "Documents", "Obsidian Vault"),
    path.join(home, "MAS"),
    path.join(home, "obsidian", "Obsidian"),
    path.join(home, "obsidian", "MAS"),
  ].filter(Boolean) as string[];

  for (const cand of fallbackCandidates) {
    const resolved = path.resolve(cand);
    try {
      if (fs.existsSync(resolved) && fs.statSync(resolved).isDirectory()) {
        const folderName = path.basename(resolved);
        if (!vaultMap.has(folderName)) {
          vaultMap.set(folderName, resolved);
        }
        if (!vaultMap.has(folderName.toLowerCase())) {
          vaultMap.set(folderName.toLowerCase(), resolved);
        }
      }
    } catch (_err) {
      void _err;
    }
  }

  return vaultMap;
}

/**
 * Resolve the default or currently active Obsidian vault path.
 */
export function getDefaultVaultPath(
  vaultMap?: Map<string, string>,
  customConfigPaths?: string[],
): string {
  // 1. Explicit environment override
  if (process.env.OBSIDIAN_VAULT_PATH && process.env.OBSIDIAN_VAULT_PATH.trim()) {
    const envPath = path.resolve(process.env.OBSIDIAN_VAULT_PATH.trim());
    if (fs.existsSync(envPath) && fs.statSync(envPath).isDirectory()) {
      return envPath;
    }
  }

  // 2. Open vault in obsidian.json
  const configPaths = customConfigPaths && customConfigPaths.length > 0
    ? customConfigPaths
    : getObsidianConfigPaths();

  for (const cfgPath of configPaths) {
    if (fs.existsSync(cfgPath)) {
      try {
        const raw = fs.readFileSync(cfgPath, "utf8");
        const parsed = JSON.parse(raw);
        if (parsed?.vaults && typeof parsed.vaults === "object") {
          let latestVaultPath: string | null = null;
          let latestTs = -1;

          for (const info of Object.values(parsed.vaults)) {
            const vPath = (info as any)?.path;
            const isOpen = (info as any)?.open === true;
            const ts = typeof (info as any)?.ts === "number" ? (info as any).ts : 0;

            if (typeof vPath === "string" && vPath.trim()) {
              const absPath = path.resolve(vPath.trim());
              if (fs.existsSync(absPath) && fs.statSync(absPath).isDirectory()) {
                if (isOpen) {
                  return absPath;
                }
                if (ts > latestTs) {
                  latestTs = ts;
                  latestVaultPath = absPath;
                }
              }
            }
          }

          if (latestVaultPath) {
            return latestVaultPath;
          }
        }
      } catch (_err) {
        void _err;
      }
    }
  }

  // 3. First existing vault in map
  const map = vaultMap ?? getObsidianVaultMap(customConfigPaths);
  for (const vPath of map.values()) {
    if (fs.existsSync(vPath) && fs.statSync(vPath).isDirectory()) {
      return vPath;
    }
  }

  // 4. Standard default fallback
  return path.join(os.homedir(), "Obsidian");
}

export interface ResolveNoteOptions {
  vaultMap?: Map<string, string>;
  defaultVaultPath?: string;
  allowedVaultPaths?: string[];
  configPaths?: string[];
}

/**
 * Resolve an Obsidian URI to a verified local note file path.
 * Enforces path containment within authorized vaults and rejects path traversal.
 */
export function resolveObsidianNotePath(
  parsed: ObsidianParsedUri,
  options: ResolveNoteOptions = {},
): { filePath: string; vaultPath: string; vaultName: string } {
  const vaultMap = options.vaultMap ?? getObsidianVaultMap(options.configPaths);
  const defaultVault =
    options.defaultVaultPath ?? getDefaultVaultPath(vaultMap, options.configPaths);

  // Helper: check that a path resides strictly within an authorized directory
  const isContained = (target: string, parentDir: string): boolean => {
    const rel = path.relative(path.resolve(parentDir), path.resolve(target));
    return rel !== "" && !rel.startsWith("..") && !path.isAbsolute(rel);
  };

  // Helper: check if file exists directly or with .md suffix
  const verifyFileExists = (targetPath: string): string => {
    if (fs.existsSync(targetPath) && fs.statSync(targetPath).isFile()) {
      return targetPath;
    }
    if (!targetPath.endsWith(".md")) {
      const withMd = targetPath + ".md";
      if (fs.existsSync(withMd) && fs.statSync(withMd).isFile()) {
        return withMd;
      }
    }
    throw new Error(`Obsidian note not found: "${targetPath}"`);
  };

  // Case A: obsidian://open?path=<absolute_path>
  if (parsed.type === "open_path") {
    if (!parsed.path) {
      throw new Error("Missing 'path' parameter in Obsidian URI");
    }

    const absTarget = path.resolve(parsed.path);

    // Build list of all authorized vault directories
    const authorizedVaults = new Set<string>();
    if (defaultVault) authorizedVaults.add(path.resolve(defaultVault));
    for (const v of vaultMap.values()) {
      authorizedVaults.add(path.resolve(v));
    }
    if (options.allowedVaultPaths) {
      for (const av of options.allowedVaultPaths) {
        authorizedVaults.add(path.resolve(av));
      }
    }

    let matchingVault: string | null = null;
    for (const vPath of authorizedVaults) {
      if (isContained(absTarget, vPath)) {
        matchingVault = vPath;
        break;
      }
    }

    if (!matchingVault) {
      throw new Error(
        `Access denied: path "${absTarget}" is not within an authorized Obsidian vault`,
      );
    }

    const verified = verifyFileExists(absTarget);
    if (
      path.resolve(verified) === path.resolve(matchingVault) ||
      !isContained(verified, matchingVault)
    ) {
      throw new Error(
        `Access denied: path "${absTarget}" is not within an authorized Obsidian vault`,
      );
    }
    return {
      filePath: verified,
      vaultPath: matchingVault,
      vaultName: path.basename(matchingVault),
    };
  }

  // Case B: vault specified (open_vault_file or vault_path)
  if (parsed.type === "open_vault_file" || parsed.type === "vault_path") {
    const vaultIdentifier = parsed.vault;
    if (!vaultIdentifier) {
      throw new Error("Missing vault identifier in Obsidian URI");
    }

    const decodedVault = (() => {
      try {
        return decodeURIComponent(vaultIdentifier);
      } catch {
        return vaultIdentifier;
      }
    })();

    const vaultPath =
      vaultMap.get(vaultIdentifier) ||
      vaultMap.get(vaultIdentifier.toLowerCase()) ||
      vaultMap.get(decodedVault) ||
      vaultMap.get(decodedVault.toLowerCase());

    if (!vaultPath) {
      throw new Error(
        `Obsidian vault "${vaultIdentifier}" not found in known vaults`,
      );
    }

    const resolvedVault = path.resolve(vaultPath);
    const targetFile = parsed.file!;

    // Block path traversal attempts
    const targetPath = path.resolve(resolvedVault, targetFile);
    if (!isContained(targetPath, resolvedVault)) {
      throw new Error(
        `Access denied: path traversal detected in note path "${targetFile}"`,
      );
    }

    const verified = verifyFileExists(targetPath);
    if (
      path.resolve(verified) === path.resolve(resolvedVault) ||
      !isContained(verified, resolvedVault)
    ) {
      throw new Error(
        `Access denied: path traversal detected in note path "${targetFile}"`,
      );
    }

    return {
      filePath: verified,
      vaultPath: resolvedVault,
      vaultName: path.basename(resolvedVault),
    };
  }

  // Case C: obsidian://open?file=<file> (default vault)
  if (parsed.type === "open_file") {
    const resolvedVault = path.resolve(defaultVault);
    const targetFile = parsed.file!;

    const targetPath = path.resolve(resolvedVault, targetFile);
    if (!isContained(targetPath, resolvedVault)) {
      throw new Error(
        `Access denied: path traversal detected in note path "${targetFile}"`,
      );
    }

    const verified = verifyFileExists(targetPath);
    if (
      path.resolve(verified) === path.resolve(resolvedVault) ||
      !isContained(verified, resolvedVault)
    ) {
      throw new Error(
        `Access denied: path traversal detected in note path "${targetFile}"`,
      );
    }

    return {
      filePath: verified,
      vaultPath: resolvedVault,
      vaultName: path.basename(resolvedVault),
    };
  }

  throw new Error(`Unsupported Obsidian URI type: "${(parsed as any).type}"`);
}

// ----------------------------------------------------------------------------
// 3. Note Loading & Syntax Transformation
// ----------------------------------------------------------------------------

export type YamlParsedValue = string | string[];

/**
 * Lightweight, zero-dependency YAML parser for note frontmatter.
 */
export function parseYamlSimple(rawYaml: string): Record<string, YamlParsedValue> {
  const result: Record<string, YamlParsedValue> = {};
  const lines = rawYaml.replace(/\r\n/g, "\n").split("\n");
  let currentKey: string | null = null;
  let currentList: string[] | null = null;

  const cleanVal = (val: string): YamlParsedValue => {
    let v = val.trim();
    if (
      (v.startsWith('"') && v.endsWith('"')) ||
      (v.startsWith("'") && v.endsWith("'"))
    ) {
      v = v.slice(1, -1);
    }
    // inline array: [a, b, c]
    if (v.startsWith("[") && v.endsWith("]")) {
      return v
        .slice(1, -1)
        .split(",")
        .map((s) => {
          let item = s.trim();
          if (
            (item.startsWith('"') && item.endsWith('"')) ||
            (item.startsWith("'") && item.endsWith("'"))
          ) {
            item = item.slice(1, -1);
          }
          return item;
        })
        .filter(Boolean);
    }
    return v;
  };

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;

    // List item: - value
    if (trimmed.startsWith("-") && currentKey) {
      const parsed = cleanVal(trimmed.replace(/^-\s*/, ""));
      const itemVal = Array.isArray(parsed) ? parsed.join(", ") : parsed;
      if (!currentList) {
        currentList = [];
        result[currentKey] = currentList;
      }
      currentList.push(itemVal);
      continue;
    }

    // Key-value pair: key: value
    const colonIdx = line.indexOf(":");
    if (colonIdx !== -1) {
      const key = line.slice(0, colonIdx).trim();
      const rawValue = line.slice(colonIdx + 1).trim();

      currentKey = key;
      currentList = null;

      if (!rawValue) {
        result[key] = [];
        currentList = result[key] as string[];
      } else {
        result[key] = cleanVal(rawValue);
      }
    }
  }

  return result;
}

/**
 * Parse YAML frontmatter block from raw note content.
 */
export function parseObsidianFrontmatter(rawContent: string): {
  frontmatter: ObsidianFrontmatter;
  body: string;
} {
  if (!rawContent) {
    return { frontmatter: {}, body: "" };
  }

  const match = rawContent.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?/);
  if (!match) {
    return { frontmatter: {}, body: rawContent };
  }

  const rawYaml = match[1];
  const body = rawContent.slice(match[0].length);

  try {
    const parsed = parseYamlSimple(rawYaml);
    if (parsed && typeof parsed === "object") {
      return { frontmatter: parsed, body };
    }
  } catch (_err) {
    void _err;
  }

  return { frontmatter: {}, body };
}

/**
 * Clean Obsidian wikilinks:
 *   [[Target Note|Display Text]] -> Display Text
 *   [[Target Note#Heading|Display Text]] -> Display Text
 *   [[Target Note]] -> Target Note
 *   [[Target Note#Heading]] -> Target Note
 * Embeds (![[...]]) are intentionally left untouched.
 */
export function cleanObsidianWikilinks(text: string): string {
  if (!text) return "";
  return text.replace(
    /(?<!\!)\[\[([^\]|#]+)(?:#[^\]|]+)?(?:\|([^\]]+))?\]\]/g,
    (_match, target, alias) => {
      if (alias && alias.trim()) {
        return alias.trim();
      }
      return target.trim();
    },
  );
}

/**
 * Escape special HTML entity characters to prevent XML/HTML injection.
 */
function escapeHtml(text: string): string {
  if (!text) return "";
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

/**
 * Transform Obsidian callouts into semantic, readable HTML blockquotes.
 * Format:
 *   > [!type] Title
 *   > Callout content...
 */
export function transformObsidianCallouts(markdown: string): string {
  if (!markdown) return "";
  const lines = markdown.replace(/\r\n/g, "\n").split("\n");
  const result: string[] = [];
  let i = 0;

  while (i < lines.length) {
    const line = lines[i];
    const calloutHeaderMatch = line.match(
      /^>\s*\[!([a-zA-Z0-9_-]+)\]([+-]?)(?:\s+(.*))?$/,
    );

    if (calloutHeaderMatch) {
      const calloutType = calloutHeaderMatch[1].toLowerCase();
      const customTitle = calloutHeaderMatch[3]?.trim();
      const typeLabel = calloutType.toUpperCase();
      const safeCustomTitle = customTitle ? escapeHtml(customTitle) : "";
      const titleText = safeCustomTitle
        ? `[${typeLabel}] ${safeCustomTitle}`
        : `[${typeLabel}]`;

      const bodyLines: string[] = [];
      i++;
      while (i < lines.length) {
        const nextLine = lines[i];
        if (nextLine.startsWith(">")) {
          const stripped = nextLine.replace(/^>\s?/, "");
          bodyLines.push(stripped);
          i++;
        } else {
          break;
        }
      }

      const bodyContent = bodyLines.join("\n").trim();
      const bodyHtml = bodyContent
        ? `<p>${bodyContent.replace(/\n\n+/g, "</p><p>").replace(/\n/g, "<br />")}</p>`
        : "";

      const calloutHtml = [
        `<blockquote class="callout callout-${calloutType}">`,
        `  <p class="callout-title"><strong>${titleText}</strong></p>`,
        bodyHtml ? `  ${bodyHtml}` : "",
        `</blockquote>`,
      ]
        .filter(Boolean)
        .join("\n");

      result.push(calloutHtml);
    } else {
      result.push(line);
      i++;
    }
  }

  return result.join("\n");
}

const ATTACHMENT_MIME_MAP: Record<string, string> = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
  ".gif": "image/gif",
  ".svg": "image/svg+xml",
  ".bmp": "image/bmp",
  ".ico": "image/x-icon",
};

/**
 * Locate and embed attachments into base64 data URIs.
 * Resolves ![[attachment.png]] and ![alt](attachment.png) from:
 *   1. Note's local directory
 *   2. Vault root
 *   3. Standard attachment subfolders (attachments, assets, 03-Resources, _resources, images, media, files)
 */
export function resolveAndEmbedAttachments(
  content: string,
  noteFilePath: string,
  vaultPath: string,
): string {
  if (!content) return "";

  const noteDir = path.dirname(noteFilePath);
  const resolvedVault = path.resolve(vaultPath);

  const searchAttachment = (rawName: string): string | null => {
    const cleaned = rawName.trim();
    if (!cleaned) return null;

    const decoded = (() => {
      try {
        return decodeURIComponent(cleaned);
      } catch {
        return cleaned;
      }
    })();

    const namesToTry = Array.from(new Set([cleaned, decoded]));
    const candidateDirs = [
      noteDir,
      resolvedVault,
      path.join(resolvedVault, "attachments"),
      path.join(resolvedVault, "assets"),
      path.join(resolvedVault, "03-Resources"),
      path.join(resolvedVault, "_resources"),
      path.join(resolvedVault, "images"),
      path.join(resolvedVault, "media"),
      path.join(resolvedVault, "files"),
      path.join(noteDir, "attachments"),
      path.join(noteDir, "assets"),
    ];

    for (const name of namesToTry) {
      for (const dir of candidateDirs) {
        const full = path.resolve(dir, name);
        // Path containment check
        const rel = path.relative(resolvedVault, full);
        if (rel.startsWith("..") || path.isAbsolute(rel)) {
          continue;
        }
        if (fs.existsSync(full) && fs.statSync(full).isFile()) {
          return full;
        }
      }
    }
    return null;
  };

  const toEmbedHtml = (filePath: string, altText: string): string => {
    const ext = path.extname(filePath).toLowerCase();
    const mime = ATTACHMENT_MIME_MAP[ext];
    if (mime) {
      try {
        const bytes = fs.readFileSync(filePath);
        const dataUri = `data:${mime};base64,${bytes.toString("base64")}`;
        const safeAlt = altText ? altText.trim() : "";
        const escapedAlt = escapeHtml(safeAlt);
        const caption = safeAlt
          ? `<figcaption>${escapedAlt}</figcaption>`
          : "";
        return `<figure><img src="${dataUri}" alt="${escapedAlt}" />${caption}</figure>`;
      } catch (_err) {
        void _err;
      }
    }
    return `<p class="attachment-reference"><strong>[Attachment: ${escapeHtml(path.basename(filePath))}]</strong></p>`;
  };

  // 1. Transform Obsidian embeds: ![[filename|altOrWidth]]
  let transformed = content.replace(
    /!\[\[([^\]|]+)(?:\|([^\]]+))?\]\]/g,
    (_match, rawFile, opt) => {
      const fileName = rawFile.trim();
      const isWidth = /^\d+(?:x\d+)?$/.test(opt?.trim() || "");
      const alt = isWidth ? "" : (opt?.trim() || fileName);

      const foundPath = searchAttachment(fileName);
      if (foundPath) {
        return toEmbedHtml(foundPath, alt);
      }
      return `<p class="missing-attachment"><em>[Attachment not found: ${fileName}]</em></p>`;
    },
  );

  // 2. Transform Markdown local image references: ![alt](local_file.ext)
  transformed = transformed.replace(
    /!\[([^\]]*)\]\(([^)]+)\)/g,
    (match, alt, url) => {
      const cleanUrl = url.trim();
      // Keep external and data URLs intact
      if (/^(?:https?:|data:)/i.test(cleanUrl)) {
        return match;
      }
      const foundPath = searchAttachment(cleanUrl);
      if (foundPath) {
        return toEmbedHtml(foundPath, alt);
      }
      return `<p class="missing-attachment"><em>[Attachment not found: ${cleanUrl}]</em></p>`;
    },
  );

  return transformed;
}

/**
 * Load, parse, and format an Obsidian note for EPUB rendering.
 */
export function loadObsidianNote(
  uriOrParsed: string | ObsidianParsedUri,
  options: ResolveNoteOptions = {},
): ObsidianNoteData {
  const parsed =
    typeof uriOrParsed === "string"
      ? parseObsidianUri(uriOrParsed)
      : uriOrParsed;

  const { filePath, vaultPath, vaultName } = resolveObsidianNotePath(
    parsed,
    options,
  );

  const rawContent = fs.readFileSync(filePath, "utf8");
  const { frontmatter, body } = parseObsidianFrontmatter(rawContent);

  // Title resolution
  const fallbackTitle = path.basename(filePath, ".md");
  const rawTitle = frontmatter.title || fallbackTitle;
  const title = cleanString(String(rawTitle)) || "Obsidian Note";

  // Author resolution
  let authorStr = "Obsidian";
  if (typeof frontmatter.author === "string") {
    authorStr = cleanString(frontmatter.author);
  } else if (Array.isArray(frontmatter.author)) {
    authorStr = frontmatter.author
      .map((a: string) => cleanString(String(a)))
      .filter(Boolean)
      .join(", ");
  } else if (Array.isArray(frontmatter.authors)) {
    authorStr = frontmatter.authors
      .map((a: string) => cleanString(String(a)))
      .filter(Boolean)
      .join(", ");
  } else if (typeof frontmatter.authors === "string") {
    authorStr = cleanString(frontmatter.authors);
  }
  const authors = authorStr || "Obsidian";

  // Tags resolution
  const tagsSet = new Set<string>();
  if (Array.isArray(frontmatter.tags)) {
    for (const t of frontmatter.tags) {
      if (t) {
        tagsSet.add(String(t).replace(/^#/, "").trim());
      }
    }
  } else if (typeof frontmatter.tags === "string") {
    for (const t of frontmatter.tags.split(/[,;\s]+/)) {
      if (t) {
        tagsSet.add(t.replace(/^#/, "").trim());
      }
    }
  }
  const tags = Array.from(tagsSet).filter(Boolean);

  // Date resolution
  let date = frontmatter.date;
  if (!date) {
    try {
      const stat = fs.statSync(filePath);
      date = stat.mtime.toISOString().split("T")[0];
    } catch {
      date = new Date().toISOString().split("T")[0];
    }
  }

  // Transformation pipeline
  const wikilinksCleaned = cleanObsidianWikilinks(body);
  const calloutsTransformed = transformObsidianCallouts(wikilinksCleaned);
  const attachmentsEmbedded = resolveAndEmbedAttachments(
    calloutsTransformed,
    filePath,
    vaultPath,
  );
  const transformedHtml = markdownToHtml(attachmentsEmbedded);

  // Word count & read time
  const textOnly = body
    .replace(/```[\s\S]*?```/g, "")
    .replace(/<[^>]+>/g, " ");
  const wordCount = Math.max(1, textOnly.split(/\s+/).filter(Boolean).length);
  const readTimeMinutes = Math.max(1, Math.ceil(wordCount / 200));

  return {
    filePath,
    vaultPath,
    vaultName,
    rawContent,
    frontmatter,
    title,
    authors,
    tags,
    date,
    transformedHtml,
    wordCount,
    readTimeMinutes,
  };
}

// ----------------------------------------------------------------------------
// 4. Core Ingestion Engine
// ----------------------------------------------------------------------------

export function runCalibredb(
  args: string[],
  dependencies?: ObsidianDependencies,
): { status: number | null; stdout: string; stderr: string } {
  const env: any = { ...process.env };
  delete env.HTTP_PROXY;
  delete env.http_proxy;
  delete env.HTTPS_PROXY;
  delete env.https_proxy;
  delete env.ALL_PROXY;
  delete env.all_proxy;
  env.PATH = `/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:${env.PATH || ""}`;

  const runSpawnSync = dependencies?.spawnSync ?? spawnSync;
  const calibredbBin = dependencies?.calibredbPath ?? getCalibredbPath();
  const res = runSpawnSync(calibredbBin, args, {
    encoding: "utf8",
    env,
    timeout: 30000,
  });

  return {
    status: res.status,
    stdout: res.stdout || "",
    stderr: res.stderr || "",
  };
}

/**
 * Ingest an Obsidian note referenced by an Obsidian URI into Calibre as an EPUB.
 */
export async function ingestObsidianNote(
  uri: string,
  dependencies?: ObsidianDependencies,
): Promise<IngestArticleResult> {
  const cleanUri = stripTrackingParams(uri).trim();
  const serverUrl = dependencies?.serverUrl ?? CALIBRE_SERVER_URL;

  // 1. Parse URI and load note
  let noteData: ObsidianNoteData;
  try {
    noteData = loadObsidianNote(cleanUri, {
      vaultMap: dependencies?.vaultMap,
      defaultVaultPath: dependencies?.defaultVaultPath,
    });
  } catch (err: any) {
    return {
      success: false,
      title: "Obsidian Note",
      authors: "Obsidian",
      siteName: "Obsidian",
      wordCount: 0,
      readTimeMinutes: 0,
      format: "EPUB",
      error: err.message || "Failed to load Obsidian note",
    };
  }

  // 2. Upfront Calibre duplicate check via comments search (URI or normalized file path)
  try {
    let listRes = runCalibredb(
      [
        "list",
        "--with-library",
        serverUrl,
        "--search",
        `comments:"${cleanUri}"`,
        "--fields",
        "id,title,authors",
        "--for-machine",
      ],
      dependencies,
    );

    let parsedList: any[] = [];
    if (listRes.status === 0 && listRes.stdout) {
      try {
        const p = JSON.parse(listRes.stdout.trim());
        if (Array.isArray(p)) parsedList = p;
      } catch {
        parsedList = [];
      }
    }

    // Fallback: search comments for normalized physical note path
    if (parsedList.length === 0 && noteData.filePath) {
      const pathListRes = runCalibredb(
        [
          "list",
          "--with-library",
          serverUrl,
          "--search",
          `comments:"${noteData.filePath}"`,
          "--fields",
          "id,title,authors",
          "--for-machine",
        ],
        dependencies,
      );
      if (pathListRes.status === 0 && pathListRes.stdout) {
        try {
          const p = JSON.parse(pathListRes.stdout.trim());
          if (Array.isArray(p)) parsedList = p;
        } catch {
          parsedList = [];
        }
      }
    }

    if (
      parsedList.length > 0 &&
      parsedList[0]?.id !== undefined &&
      parsedList[0]?.id !== null
    ) {
      const existing = parsedList[0];
      const authors = Array.isArray(existing.authors)
        ? existing.authors.join(", ")
        : existing.authors || noteData.authors;

      return {
        success: true,
        duplicate: true,
        bookId: existing.id,
        title: existing.title || noteData.title,
        authors,
        siteName: "Obsidian",
        wordCount: noteData.wordCount,
        readTimeMinutes: noteData.readTimeMinutes,
        format: "EPUB",
        message: `Note already exists in Calibre (ID: ${existing.id})`,
      };
    }
  } catch (_err) {
    void _err;
  }

  // 3. Build Kindle-optimized styled HTML document
  const styledDocument = buildStyledHtmlDocument({
    title: noteData.title,
    author: noteData.authors,
    siteName: "Obsidian",
    url: cleanUri,
    publishedDate: noteData.date || new Date().toISOString().split("T")[0],
    readTimeMinutes: noteData.readTimeMinutes,
    wordCount: noteData.wordCount,
    contentHtml: noteData.transformedHtml,
  });

  // 4. Typographic cover generation
  let coverImagePath: string | undefined;
  try {
    coverImagePath = generateTypographicCover(
      noteData.title,
      noteData.authors,
      "Obsidian",
      noteData.readTimeMinutes,
    );
  } catch (_coverErr) {
    void _coverErr;
  }

  let tempEpub: string | undefined;

  try {
    // 5. Convert HTML to EPUB
    tempEpub = convertHtmlToEpub(
      styledDocument,
      noteData.title,
      noteData.authors,
      "Obsidian",
      cleanUri,
      coverImagePath,
    );

    // 6. Filename sanitization & Books_Drop path
    const safeFilenameBase =
      cleanString(noteData.title)
        .replace(/[^a-zA-Z0-9_\u00A0-\uFFFF -]/g, "")
        .replace(/\s+/g, "_")
        .slice(0, 60)
        .trim() || "Obsidian_Note";

    // 7. Junk gate evaluation
    const junkCheck = await evaluateJunkGate(
      noteData.title,
      "",
      noteData.authors,
    );
    if (junkCheck.quarantined) {
      moveToQuarantine(tempEpub, `${safeFilenameBase}.epub`);
      return {
        success: false,
        title: noteData.title,
        authors: noteData.authors,
        siteName: "Obsidian",
        wordCount: noteData.wordCount,
        readTimeMinutes: noteData.readTimeMinutes,
        format: "EPUB",
        error: `Quarantined by junk ingest gate: ${junkCheck.reason || "Artifact quarantined"}`,
      };
    }

    const dropFileName = `${safeFilenameBase}_${Date.now()}.epub`;
    const dropFilePath = path.join(getDropDir(), dropFileName);

    fs.copyFileSync(tempEpub, dropFilePath);
    try {
      fs.unlinkSync(tempEpub);
    } catch (_err) {
      void _err;
    }

    // 8. Pre-add language & category detection
    const mergedTags = Array.from(
      new Set(["Obsidian", "Notes", ...noteData.tags]),
    ).filter(Boolean);

    const classification = await resolveBookLanguageAndTags({
      title: noteData.title,
      author: noteData.authors,
      comments: styledDocument,
      tags: mergedTags,
    });
    const tagsStr = classification.tags.join(",");

    const addArgs = [
      "add",
      dropFilePath,
      "--with-library",
      serverUrl,
      "--title",
      noteData.title,
      "--authors",
      noteData.authors,
      "--tags",
      tagsStr,
      "--automerge",
      "ignore",
    ];
    if (classification.language && classification.language !== "other") {
      addArgs.push("--languages", classification.language);
    }
    if (coverImagePath && fs.existsSync(coverImagePath)) {
      addArgs.push("--cover", coverImagePath);
    }

    const addRes = runCalibredb(addArgs, dependencies);

    if (addRes.status !== 0) {
      return {
        success: false,
        title: noteData.title,
        authors: noteData.authors,
        siteName: "Obsidian",
        wordCount: noteData.wordCount,
        readTimeMinutes: noteData.readTimeMinutes,
        format: "EPUB",
        error:
          addRes.stderr ||
          addRes.stdout ||
          "Failed to add Obsidian note to Calibre",
      };
    }

    let bookId: number | null = null;
    let isDuplicate = false;

    const match = addRes.stdout?.match(/Added book ids?:?\s*([0-9]+)/i);
    if (match) {
      bookId = parseInt(match[1], 10);
    }

    if (!bookId) {
      const searchRes = runCalibredb(
        [
          "list",
          "--with-library",
          serverUrl,
          "--search",
          `title:"=${noteData.title}"`,
          "--fields",
          "id,title,authors",
          "--for-machine",
        ],
        dependencies,
      );

      if (searchRes.status === 0 && searchRes.stdout) {
        try {
          const parsedList = JSON.parse(searchRes.stdout.trim());
          if (Array.isArray(parsedList) && parsedList.length > 0) {
            bookId = parsedList[0].id;
            isDuplicate = true;
          }
        } catch (_err) {
          void _err;
        }
      }
    }

    // 9. Attach metadata comments and cover
    if (bookId) {
      const commentsText = `Saved from ${cleanUri}\nSource: ${noteData.filePath}`;
      const setArgs = [
        "set_metadata",
        String(bookId),
        "--with-library",
        serverUrl,
        "--field",
        `comments:${commentsText}`,
      ];
      if (coverImagePath && fs.existsSync(coverImagePath)) {
        setArgs.push("--field", `cover:${coverImagePath}`);
      }
      runCalibredb(setArgs, dependencies);
      if (coverImagePath && fs.existsSync(coverImagePath)) {
        try {
          const { purgeCoverCache } = await import("./server");
          purgeCoverCache(bookId);
        } catch {
          // ignore
        }
      }
    }

    return {
      success: true,
      duplicate: isDuplicate,
      bookId,
      title: noteData.title,
      authors: noteData.authors,
      siteName: "Obsidian",
      wordCount: noteData.wordCount,
      readTimeMinutes: noteData.readTimeMinutes,
      epubPath: dropFilePath,
      format: "EPUB",
      message: isDuplicate
        ? `Note already exists in Calibre (ID: ${bookId})`
        : `Successfully ingested Obsidian note "${noteData.title}" into library`,
    };
  } finally {
    if (tempEpub && fs.existsSync(tempEpub)) {
      try {
        fs.unlinkSync(tempEpub);
      } catch (_err) {
        void _err;
      }
    }
    if (coverImagePath && fs.existsSync(coverImagePath)) {
      try {
        fs.unlinkSync(coverImagePath);
      } catch (_err) {
        void _err;
      }
    }
  }
}
