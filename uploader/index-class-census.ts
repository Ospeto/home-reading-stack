/**
 * uploader/index-class-census.ts
 *
 * The drift guard for `uploader/index.html`.
 *
 * That file ships one hand-pasted compiled Tailwind sheet followed by hand-written CSS. There is no
 * build step and no package.json, so nothing regenerates the compiled line when the markup asks for
 * a new utility. The result was measurable: 11.3% of the class tokens inside `#discoverView` and 8%
 * inside `#discoverModal` resolved to nothing, which is why a status badge never painted, a modal
 * cover swallowed its own text column and two search fields rendered white-on-white.
 *
 * This module is the census those defects needed. It reads the sheet, reads every class the markup
 * and scripts request, and reports the difference. `index-class-census.test.ts` turns that
 * difference into a failing assertion so the sheet cannot drift silently again.
 *
 * Pure functions over strings only - no DOM, no browser, no dependency.
 */

/** CSS identifiers escape `/`, `:`, `.`, `[` etc. as `\/`, `\:`, `\.`, `\[`. */
const CSS_ESCAPE = /\\([0-9a-fA-F]{1,6}\s?|.)/g;

/** Class names that are behavioural hooks rather than styling and are intentionally unstyled. */
export const HOOK_CLASSES: ReadonlySet<string> = new Set([
  // Toggled from JS to find cards / grids. Styled by descendant selectors if ever needed.
  "discover-card",
  "books-grid",
  // Query hooks used by clearSearch(), the stats heatmap renderer and the upload retry control.
  "clear-search-btn",
  "stats-heatmap",
  "retry-upload-btn",
  // Markers the library card logic looks for (hideHoverPopover, updateUploadProgress).
  "popup-active",
  // Horizontal scrollers that syncEdgeFades() measures and then decorates with `.edge-fade-x`.
  "edge-fade-tabs",
  "edge-fade-scope",
  "card-popup-content",
  "card-popup-subtitle",
]);

/** Attribute values that are template placeholders rather than class requests. */
function stripInterpolations(value: string): string {
  let out = "";
  for (let i = 0; i < value.length; i += 1) {
    if (value[i] === "$" && value[i + 1] === "{") {
      i += 2;
      let depth = 1;
      while (i < value.length && depth > 0) {
        const ch = value[i];
        if (ch === "{") depth += 1;
        else if (ch === "}") depth -= 1;
        i += 1;
      }
      i -= 1; // the for-loop increment consumes the closing brace
      out += " ";
      continue;
    }
    out += value[i];
  }
  return out;
}

export function decodeCssIdentifier(raw: string): string {
  return raw.replace(CSS_ESCAPE, (_match, escaped: string) => {
    if (/^[0-9a-fA-F]/.test(escaped)) {
      const code = parseInt(escaped.trim(), 16);
      return code ? String.fromCodePoint(code) : "";
    }
    return escaped;
  });
}

/**
 * Every class name a selector in `css` defines. Selector preludes are the text between a block
 * boundary and the next `{`, which covers both top-level rules and rules nested in `@media`.
 */
export function collectDefinedClasses(css: string): Set<string> {
  const withoutComments = css.replace(/\/\*[\s\S]*?\*\//g, "");
  const defined = new Set<string>();
  // A prelude starts after the previous block's `}`/`;` or after an at-rule's opening `{`, which is
  // how the first rule inside `@media (...) { ... }` is reached. The boundary character is consumed by
  // the previous match, so it is matched with a lookbehind instead of as part of the prelude match.
  for (const block of withoutComments.matchAll(/(?:^|(?<=[{};]))\s*([^{};]*)\{/g)) {
    const prelude = block[1];
    if (!prelude) continue;
    for (const cls of prelude.matchAll(/\.((?:\\.|[^\\\s,>+~:.[\]()"'=])+)/g)) {
      defined.add(decodeCssIdentifier(cls[1]));
    }
  }
  return defined;
}

/** Split a class attribute value into the tokens a browser would treat as class names. */
export function splitClassTokens(value: string): string[] {
  return stripInterpolations(value)
    .split(/\s+/)
    .map((token) => token.replace(/^['"`]|['"`]$/g, ""))
    .filter((token) => token.length > 0)
    // A token that still carries quote or brace debris came from an expression, not a real class.
    .filter((token) => !/['"`${}]/.test(token) && token !== "?");
}

/**
 * Every class token the document requests, mapped to the number of times it is requested.
 *
 * Four request shapes are collected, because all four appear in this file:
 *  - `class="..."` / `class='...'` in static markup and inside template strings,
 *  - `element.className = '...'` (a whole class list built as one literal),
 *  - `classList.add|remove|toggle('a', 'b')` (single-class mutations),
 *  - `setAttribute('class', '...')`.
 */
export function collectRequestedClasses(html: string): Map<string, number> {
  const requested = new Map<string, number>();
  const add = (token: string) => {
    if (!token) return;
    requested.set(token, (requested.get(token) ?? 0) + 1);
  };
  const addList = (value: string) => {
    for (const token of splitClassTokens(value)) add(token);
  };

  for (const match of html.matchAll(/\bclass\s*=\s*(?:"([^"]*)"|'([^']*)')/g)) {
    addList(match[1] ?? match[2] ?? "");
  }
  for (const match of html.matchAll(/\.className\s*=\s*(?:"([^"]*)"|'([^']*)')/g)) {
    addList(match[1] ?? match[2] ?? "");
  }
  for (const match of html.matchAll(/classList\.(?:add|remove|toggle)\(([^)]*)\)/g)) {
    // Only a bare string-literal argument names a class; `toggle('hidden', tab === 'all')` does not.
    for (const argument of match[1].split(",")) {
      const literal = argument.trim().match(/^(?:'([^'\\]*)'|"([^"\\]*)")$/);
      if (literal) addList(literal[1] ?? literal[2] ?? "");
    }
  }
  for (const match of html.matchAll(/setAttribute\(\s*['"]class['"]\s*,\s*(?:"([^"]*)"|'([^']*)')/g)) {
    addList(match[1] ?? match[2] ?? "");
  }

  return requested;
}

export interface ClassCensusReport {
  definedCount: number;
  requestedCount: number;
  /** Requested classes with no selector anywhere in the document's stylesheets. */
  missing: Array<{ token: string; count: number }>;
  /** Requested classes that are unstyled on purpose (behavioural hooks). */
  hooks: string[];
}

/** The census. `missing` is empty when the sheet covers every class the document requests. */
export function runClassCensus(html: string, hooks: ReadonlySet<string> = HOOK_CLASSES): ClassCensusReport {
  const styleBlocks = [...html.matchAll(/<style[^>]*>([\s\S]*?)<\/style>/g)].map((m) => m[1]);
  const defined = collectDefinedClasses(styleBlocks.join("\n"));
  const requested = collectRequestedClasses(html);

  const missing: Array<{ token: string; count: number }> = [];
  const hookHits: string[] = [];
  for (const [token, count] of requested) {
    if (defined.has(token)) continue;
    if (hooks.has(token)) {
      hookHits.push(token);
      continue;
    }
    missing.push({ token, count });
  }
  missing.sort((a, b) => b.count - a.count || a.token.localeCompare(b.token));

  return {
    definedCount: defined.size,
    requestedCount: requested.size,
    missing,
    hooks: hookHits.sort(),
  };
}
