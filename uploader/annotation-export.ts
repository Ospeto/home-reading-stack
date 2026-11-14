/**
 * uploader/annotation-export.ts
 *
 * Renders the annotation store (uploader/annotation-store.ts) as Markdown, CSV,
 * or JSON.
 *
 * Every exporter reads the same filtered view, so an annotation that leaves the
 * store leaves every export with it - there is no second copy of the data here.
 *
 * Credential hygiene: exports may carry user-authored note text, and a pasted
 * URL or a stray clipboard line can hold a token. Configured tokens are scrubbed
 * from every format before it is returned, so an export can be shared or logged
 * without leaking a credential. Nothing in this module reads or emits a token
 * value other than to redact it.
 */

import type { Database } from "bun:sqlite";

import {
  annotationsToNoteEntries,
  type AnnotationFilter,
  type AnnotationRecord,
  queryAnnotations,
} from "./annotation-store";
import { getJoplinToken } from "./joplin";

export const ANNOTATION_EXPORT_FORMATS = ["markdown", "csv", "json"] as const;

export type AnnotationExportFormat = (typeof ANNOTATION_EXPORT_FORMATS)[number];

export const REDACTED_PLACEHOLDER = "[redacted]";

/** Query-parameter and env-style secrets that must never reach an export. */
const SECRET_PATTERNS: RegExp[] = [
  // token=... / tok=... / api_key=... / access_token=... in a URL or query string
  /((?:^|[?&\s])(?:token|tok|api[_-]?key|apikey|access[_-]?token|auth|password|secret)=)([^\s&#]+)/gi,
  // Authorization: Bearer ...
  /(authorization\s*:\s*bearer\s+)([^\s"',;]+)/gi,
  // Standalone bearer tokens
  /\b(bearer\s+)([A-Za-z0-9._~+/=-]{12,})/g,
];

export function isAnnotationExportFormat(
  value: unknown,
): value is AnnotationExportFormat {
  return (
    typeof value === "string" &&
    (ANNOTATION_EXPORT_FORMATS as readonly string[]).includes(value)
  );
}

/**
 * Removes credentials from arbitrary text.
 *
 * The configured JOPLIN_TOKEN is redacted by exact value as well as by shape, so
 * a token that does not look like a token is still caught.
 */
export function redactSecrets(
  text: string,
  extraSecrets: Array<string | null | undefined> = [],
): string {
  if (!text) return text;
  let out = text;

  const secrets = [getJoplinToken(), ...extraSecrets]
    .map((s) => (typeof s === "string" ? s.trim() : ""))
    .filter((s) => s.length >= 4)
    // Longest first so a token that contains a shorter one is fully replaced.
    .sort((a, b) => b.length - a.length);

  for (const secret of secrets) {
    out = out.split(secret).join(REDACTED_PLACEHOLDER);
  }

  for (const pattern of SECRET_PATTERNS) {
    out = out.replace(pattern, (_match, prefix: string) => `${prefix}${REDACTED_PLACEHOLDER}`);
  }

  return out;
}

export interface AnnotationExportOptions {
  format: AnnotationExportFormat;
  filter?: AnnotationFilter;
  /** Injected clock for deterministic filenames and headers in tests. */
  now?: Date;
}

export interface AnnotationExportResult {
  format: AnnotationExportFormat;
  content: string;
  contentType: string;
  filename: string;
  count: number;
}

const CSV_COLUMNS = [
  "book_id",
  "book_title",
  "author",
  "chapter",
  "page",
  "quote",
  "note",
  "color",
  "style",
  "sources",
  "timestamp",
  "created_at",
] as const;

/** RFC 4180 quoting plus a formula-injection guard for spreadsheet consumers. */
export function csvCell(value: unknown): string {
  if (value === null || value === undefined) return "";
  let text = String(value);
  // A leading =, +, -, @ makes Excel treat the cell as a formula.
  if (/^[=+\-@\t\r]/.test(text)) {
    text = `'${text}`;
  }
  if (/["\r\n,]/.test(text)) {
    return `"${text.replace(/"/g, '""')}"`;
  }
  return text;
}

function groupByBook(records: AnnotationRecord[]): Map<string, AnnotationRecord[]> {
  const grouped = new Map<string, AnnotationRecord[]>();
  for (const row of records) {
    const list = grouped.get(row.book_title);
    if (list) list.push(row);
    else grouped.set(row.book_title, [row]);
  }
  return new Map(
    Array.from(grouped.entries()).sort(([a], [b]) =>
      a.localeCompare(b, undefined, { sensitivity: "base" }),
    ),
  );
}

function describeAnnotation(row: AnnotationRecord): string {
  const parts: string[] = [];
  if (row.chapter) parts.push(`*${row.chapter}*`);
  if (row.page !== null && row.page !== undefined) parts.push(`Page ${row.page}`);
  if (row.color) parts.push(`color: ${row.color}`);
  if (row.style) parts.push(`style: ${row.style}`);
  if (row.sources.length > 0) parts.push(`source: ${row.sources.join("+")}`);
  if (row.timestamp) parts.push(row.timestamp);
  return parts.join(" · ");
}

export function renderMarkdownExport(
  records: AnnotationRecord[],
  options: { generatedAt?: Date } = {},
): string {
  const generatedAt = (options.generatedAt ?? new Date()).toISOString();
  const lines: string[] = [
    "---",
    `title: ${JSON.stringify("LightHouse Annotations")}`,
    `generated_at: ${generatedAt}`,
    `annotation_count: ${records.length}`,
    "tags:",
    "  - lighthouse",
    "  - annotations",
    "---",
    "",
    "# LightHouse Annotations",
    "",
  ];

  if (records.length === 0) {
    lines.push("*No annotations matched these filters.*", "");
    return redactSecrets(lines.join("\n"));
  }

  for (const [title, rows] of groupByBook(records)) {
    lines.push(`## ${title}`, "");
    for (const row of rows) {
      const quote = row.quote.split("\n").map((line) => `> ${line.trim()}`);
      lines.push(...quote);
      const meta = describeAnnotation(row);
      if (meta) lines.push("", meta);
      if (row.note) {
        const note = row.note.split("\n").map((line) => line.trim()).join(" ");
        lines.push("", `**Note:** ${note}`);
      }
      lines.push("");
    }
  }

  return redactSecrets(lines.join("\n").replace(/\n{3,}/g, "\n\n"));
}

export function renderCsvExport(records: AnnotationRecord[]): string {
  const lines: string[] = [CSV_COLUMNS.join(",")];
  for (const row of records) {
    lines.push(
      [
        csvCell(row.book_id),
        csvCell(row.book_title),
        csvCell(""),
        csvCell(row.chapter),
        csvCell(row.page),
        csvCell(row.quote),
        csvCell(row.note),
        csvCell(row.color),
        csvCell(row.style),
        csvCell(row.sources.join("|")),
        csvCell(row.timestamp),
        csvCell(row.created_at),
      ].join(","),
    );
  }
  // Trailing newline keeps a POSIX text file well formed.
  return redactSecrets(`${lines.join("\r\n")}\r\n`);
}

export function renderJsonExport(
  records: AnnotationRecord[],
  options: { generatedAt?: Date } = {},
): string {
  const generatedAt = (options.generatedAt ?? new Date()).toISOString();
  const payload = {
    generated_at: generatedAt,
    count: records.length,
    annotations: records.map((row) => ({
      id: row.id,
      book_id: row.book_id,
      book_title: row.book_title,
      chapter: row.chapter,
      page: row.page,
      quote: row.quote,
      note: row.note,
      color: row.color,
      style: row.style,
      sources: row.sources,
      timestamp: row.timestamp,
      created_at: row.created_at,
    })),
  };
  return redactSecrets(JSON.stringify(payload, null, 2));
}

function sanitizeFilenamePart(raw: string): string {
  return raw
    .normalize("NFC")
    .replace(/[\u0000-\u001f<>:"/\\|?*]+/g, "")
    .replace(/\s+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60);
}

export function annotationExportFilename(
  format: AnnotationExportFormat,
  options: { bookTitle?: string | null; generatedAt?: Date } = {},
): string {
  const stamp = (options.generatedAt ?? new Date()).toISOString().slice(0, 10);
  const scope = options.bookTitle ? `${sanitizeFilenamePart(options.bookTitle)}-` : "";
  const extension = format === "markdown" ? "md" : format;
  return `lighthouse-annotations-${scope}${stamp}.${extension}`;
}

/**
 * Reads the store through one filter and renders it in the requested format.
 * This is the single entry point the HTTP API and the CLI both use.
 */
export function exportAnnotations(
  db: Database,
  options: AnnotationExportOptions,
): AnnotationExportResult {
  const records = queryAnnotations(db, options.filter ?? {});
  const generatedAt = options.now ?? new Date();
  const bookTitle = options.filter?.title ?? null;

  let content: string;
  let contentType: string;
  switch (options.format) {
    case "csv":
      content = renderCsvExport(records);
      contentType = "text/csv; charset=utf-8";
      break;
    case "json":
      content = renderJsonExport(records, { generatedAt });
      contentType = "application/json; charset=utf-8";
      break;
    case "markdown":
    default:
      content = renderMarkdownExport(records, { generatedAt });
      contentType = "text/markdown; charset=utf-8";
      break;
  }

  return {
    format: options.format,
    content,
    contentType,
    filename: annotationExportFilename(options.format, { bookTitle, generatedAt }),
    count: records.length,
  };
}

/** Shared with the Obsidian exporter so both describe a highlight the same way. */
export { annotationsToNoteEntries };
