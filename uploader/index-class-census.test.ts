import { describe, expect, it } from "bun:test";
import fs from "node:fs";
import path from "node:path";
import {
  HOOK_CLASSES,
  collectDefinedClasses,
  collectRequestedClasses,
  decodeCssIdentifier,
  runClassCensus,
  splitClassTokens,
} from "./index-class-census";

const HTML_PATH = path.join((import.meta as any).dir, "index.html");
const html = fs.readFileSync(HTML_PATH, "utf8");

/** Delete one `selector { ... }` rule (and any trailing newline) from a stylesheet string. */
function removeRule(css: string, selector: string): string {
  const start = css.indexOf(`${selector} {`);
  if (start === -1) throw new Error(`removeRule: ${selector} is not in the sheet`);
  const end = css.indexOf("}", start);
  if (end === -1) throw new Error(`removeRule: unterminated rule for ${selector}`);
  return css.slice(0, start) + css.slice(end + 1);
}

describe("class census: the rendered sheet covers every class the document asks for", () => {
  it("defines every requested utility, so no control renders half-styled", () => {
    const report = runClassCensus(html);
    // The failure message lists the tokens *and* how often each is used, which is what a future
    // author needs in order to decide whether to define the utility or drop the class.
    const summary = report.missing.map((m) => `${m.token} (x${m.count})`).join(", ");
    expect(summary).toBe("");
    expect(report.missing).toEqual([]);
  });

  it("reports the census totals it measured, so a silent regression in parsing is visible", () => {
    const report = runClassCensus(html);
    // Both sides must be large: a parser that stopped seeing template-string markup would still
    // report zero missing classes, and this assertion is what catches that.
    expect(report.requestedCount).toBeGreaterThan(700);
    expect(report.definedCount).toBeGreaterThan(900);
  });

  it("keeps the unstyled behavioural hooks out of the missing list", () => {
    const report = runClassCensus(html);
    expect(report.hooks).toContain("discover-card");
    expect(report.hooks).toContain("books-grid");
    for (const hook of report.hooks) expect(HOOK_CLASSES.has(hook)).toBe(true);
  });
});

describe("class census: the guard actually fails when a utility goes missing", () => {
  it("flags a high-traffic utility as soon as its rule is removed", () => {
    // bg-zinc-950/80 is the exact class that rendered #discoverSearchInput and #discoverSortSelect
    // white-on-white before this block existed, so it doubles as the regression case.
    const broken = removeRule(html, ".bg-zinc-950\\/80");
    const report = runClassCensus(broken);
    const tokens = report.missing.map((m) => m.token);
    expect(tokens).toContain("bg-zinc-950/80");
    // And it is reported with its real usage count, not a placeholder.
    expect(report.missing.find((m) => m.token === "bg-zinc-950/80")!.count).toBeGreaterThan(1);
  });

  it("flags a class requested only inside a JS template string", () => {
    // The original drift was invisible to a naive check because most classes are built in JS.
    const broken = removeRule(html, ".animate-ping");
    const report = runClassCensus(broken);
    expect(report.missing.map((m) => m.token)).toContain("animate-ping");
  });

  it("flags the modal cover width, which is why the cover used to swallow its text column", () => {
    const broken = removeRule(html, ".w-36");
    const report = runClassCensus(broken);
    expect(report.missing.map((m) => m.token)).toContain("w-36");
  });
});

describe("class census: collection rules", () => {
  it("decodes the CSS identifier escapes Tailwind emits", () => {
    expect(decodeCssIdentifier("bg-zinc-950\\/80")).toBe("bg-zinc-950/80");
    expect(decodeCssIdentifier("w-1\\/2")).toBe("w-1/2");
    expect(decodeCssIdentifier("active\\:scale-\\[0\\.97\\]")).toBe("active:scale-[0.97]");
    // Tailwind escapes a leading digit as a hex code point: `2xl:` is emitted as `\32xl\:`.
    expect(decodeCssIdentifier("\\32xl\\:grid-cols-7")).toBe("2xl:grid-cols-7");
  });

  it("reads classes out of static markup, template strings, className and classList", () => {
    const requested = collectRequestedClasses(`
      <div class="flex gap-2 bg-zinc-950/80"></div>
      <script>
        const card = \`<span class="animate-ping text-xs">x</span>\`;
        el.className = 'px-2 rounded-lg';
        el.classList.add('hidden');
        el.classList.toggle('hidden', tab === 'all' || tab === 'other');
        el.setAttribute('class', 'sr-only');
      </script>
    `);
    expect([...requested.keys()].sort()).toEqual([
      "animate-ping",
      "bg-zinc-950/80",
      "flex",
      "gap-2",
      "hidden",
      "px-2",
      "rounded-lg",
      "sr-only",
      "text-xs",
    ]);
  });

  it("never mistakes a classList condition for a class name", () => {
    // `classList.toggle('hidden', tab === 'all')` used to inject a bogus "all" token, which hid a
    // genuinely missing utility behind a phantom one.
    const requested = collectRequestedClasses(
      `section.classList.toggle('hidden', !(tab === 'all' || tab === tabId));`,
    );
    expect([...requested.keys()]).toEqual(["hidden"]);
  });

  it("does not split on template holes inside a class attribute", () => {
    expect(splitClassTokens("px-2 ${isSelected ? 'bg-sky-500' : 'opacity-50'} truncate")).toEqual([
      "px-2",
      "truncate",
    ]);
  });

  it("collects selectors nested inside @media as well as top-level ones", () => {
    const defined = collectDefinedClasses(`
      .w-36 { width: 9rem; }
      @media (min-width: 640px) {
        .sm\\:w-48 { width: 12rem; }
        .sm\\:p-5 { padding: 1.25rem; }
      }
      @media (min-width: 1536px) {
        .\\32xl\\:grid-cols-7 { grid-template-columns: repeat(7, minmax(0, 1fr)); }
      }
    `);
    expect(defined.has("w-36")).toBe(true);
    expect(defined.has("sm:w-48")).toBe(true);
    expect(defined.has("sm:p-5")).toBe(true);
    expect(defined.has("2xl:grid-cols-7")).toBe(true);
  });

  it("ignores class-like text inside CSS comments", () => {
    const defined = collectDefinedClasses(`/* .fake-utility { color: red; } */ .real { color: blue; }`);
    expect(defined.has("fake-utility")).toBe(false);
    expect(defined.has("real")).toBe(true);
  });
});
