import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";

// Resource Limits & Safety Thresholds
export const MAX_ARCHIVE_SIZE_BYTES = 100 * 1024 * 1024; // 100MB compressed
export const MAX_TOTAL_UNCOMPRESSED_BYTES = 500 * 1024 * 1024; // 500MB uncompressed limit
export const MAX_SINGLE_FILE_SIZE_BYTES = 250 * 1024 * 1024; // 250MB single file limit
export const MAX_ARCHIVE_ENTRIES = 2000; // Cap total files in archive
export const MAX_COMPRESSION_RATIO = 50; // Zip-bomb detection: max 50:1 uncompressed:compressed ratio

export interface ExtractedBook {
  tempPath: string;
  originalName: string;
}

export interface QuarantinedFile {
  name: string;
  originalName?: string;
  format: string;
  reason: string;
}

export type QuarantinedBook = QuarantinedFile;

export interface UnpackResult {
  success: boolean;
  books: ExtractedBook[];
  quarantined: QuarantinedFile[];
  error?: string;
  cleanup: () => void;
}

export const ARCHIVE_EXTENSIONS = [".zip", ".rar", ".tar", ".7z", ".gz", ".bz2"];

export const REJECTED_BOOK_EXTENSIONS = [
  ".pdf", ".mobi", ".azw3", ".azw", ".cbz", ".cbr",
  ".fb2", ".djvu", ".ibooks", ".lit", ".prc", ".txt", ".docx"
];

export function isArchiveFile(filename: string): boolean {
  const ext = path.extname(filename).toLowerCase();
  return ARCHIVE_EXTENSIONS.includes(ext);
}

/**
 * EPUB-Only Collection Rule:
 * Only .epub files are accepted for import into home-reading-stack.
 */
export function isSupportedBook(filename: string): boolean {
  const ext = path.extname(filename).toLowerCase();
  const base = path.basename(filename);
  return ext === ".epub" &&
         !base.startsWith(".") &&
         !base.startsWith("._");
}

export const isCanonicalEpub = isSupportedBook;

/**
 * Identify known non-EPUB eBook formats for clear rejection or quarantine.
 */
export function isNonEpubBook(filename: string): boolean {
  const ext = path.extname(filename).toLowerCase();
  const base = path.basename(filename);
  return REJECTED_BOOK_EXTENSIONS.includes(ext) &&
         !base.startsWith(".") &&
         !base.startsWith("._");
}

export const isLegacyOrNonCanonicalFormat = isNonEpubBook;

export interface ArchiveInspection {
  safe: boolean;
  error?: string;
  entryCount: number;
  totalUncompressedBytes: number;
}

/**
 * Inspects archive entries before extraction to guard against:
 * - Path traversal (e.g. ../, /etc/passwd, C:\...)
 * - Zip bombs (excessive compression ratios)
 * - Tar bombs (excessive entry count or giant uncompressed byte sizes)
 */
export function inspectArchiveSafety(archivePath: string): ArchiveInspection {
  try {
    const stat = fs.statSync(archivePath);
    if (stat.size > MAX_ARCHIVE_SIZE_BYTES) {
      return {
        safe: false,
        error: `Archive file size (${Math.round(stat.size / 1024 / 1024)}MB) exceeds maximum allowed size (${MAX_ARCHIVE_SIZE_BYTES / 1024 / 1024}MB)`,
        entryCount: 0,
        totalUncompressedBytes: 0
      };
    }

    // Run bsdtar -tvf to inspect entry headers and sizes
    const listRes = spawnSync("/usr/bin/bsdtar", ["-tvf", archivePath], {
      encoding: "utf8",
      timeout: 15000
    });

    if (listRes.status !== 0) {
      return {
        safe: false,
        error: listRes.stderr?.trim() || "Failed to inspect archive (corrupted or unsupported archive format)",
        entryCount: 0,
        totalUncompressedBytes: 0
      };
    }

    const lines = (listRes.stdout || "").split("\n").filter((l: string) => l.trim().length > 0);
    if (lines.length > MAX_ARCHIVE_ENTRIES) {
      return {
        safe: false,
        error: `Archive contains ${lines.length} entries, exceeding limit of ${MAX_ARCHIVE_ENTRIES}`,
        entryCount: lines.length,
        totalUncompressedBytes: 0
      };
    }

    let totalUncompressedBytes = 0;

    for (const line of lines) {
      // bsdtar -tvf format: mode links uid gid size month day time/year filename
      const tokens = line.trim().split(/\s+/);
      if (tokens.length >= 9) {
        const size = parseInt(tokens[4], 10);
        const entryName = tokens.slice(8).join(" ");

        // Check for path traversal guards:
        // Reject any entry with '..' components, starting with '/', '\', or containing null bytes
        if (
          entryName.includes("..") ||
          entryName.startsWith("/") ||
          entryName.startsWith("\\") ||
          /^[a-zA-Z]:[\\/]/.test(entryName) ||
          entryName.includes("\0")
        ) {
          return {
            safe: false,
            error: `Path traversal detected in archive entry: "${entryName}"`,
            entryCount: lines.length,
            totalUncompressedBytes
          };
        }

        if (!isNaN(size) && size > 0) {
          if (size > MAX_SINGLE_FILE_SIZE_BYTES) {
            return {
              safe: false,
              error: `Archive entry "${entryName}" uncompressed size (${Math.round(size / 1024 / 1024)}MB) exceeds limit (${MAX_SINGLE_FILE_SIZE_BYTES / 1024 / 1024}MB)`,
              entryCount: lines.length,
              totalUncompressedBytes
            };
          }
          totalUncompressedBytes += size;
        }
      }
    }

    if (totalUncompressedBytes > MAX_TOTAL_UNCOMPRESSED_BYTES) {
      return {
        safe: false,
        error: `Total uncompressed archive size (${Math.round(totalUncompressedBytes / 1024 / 1024)}MB) exceeds limit (${MAX_TOTAL_UNCOMPRESSED_BYTES / 1024 / 1024}MB)`,
        entryCount: lines.length,
        totalUncompressedBytes
      };
    }

    // Zip bomb ratio check: only apply if uncompressed size is meaningfully large (> 5MB)
    if (stat.size > 0 && totalUncompressedBytes > 5 * 1024 * 1024) {
      const ratio = totalUncompressedBytes / stat.size;
      if (ratio > MAX_COMPRESSION_RATIO) {
        return {
          safe: false,
          error: `Decompression bomb detected: compression ratio ${Math.round(ratio)}:1 exceeds limit of ${MAX_COMPRESSION_RATIO}:1`,
          entryCount: lines.length,
          totalUncompressedBytes
        };
      }
    }

    return {
      safe: true,
      entryCount: lines.length,
      totalUncompressedBytes
    };
  } catch (err: any) {
    return {
      safe: false,
      error: `Archive inspection error: ${err?.message || err}`,
      entryCount: 0,
      totalUncompressedBytes: 0
    };
  }
}

/**
 * Safely unpacks an archive, applying zip-bomb, tar-bomb, and path traversal guards.
 * Strictly separates canonical EPUB books from quarantined legacy formats.
 */
export function unpackArchive(archivePath: string): UnpackResult {
  const tempExtractDir = path.join(
    "/tmp",
    `archive_unpack_${Date.now()}_${Math.random().toString(36).substring(2, 7)}`
  );

  const cleanup = () => {
    try {
      if (fs.existsSync(tempExtractDir)) {
        fs.rmSync(tempExtractDir, { recursive: true, force: true });
      }
    } catch (e) {
      console.error(`[ArchiveUnpack] Cleanup error for ${tempExtractDir}:`, e);
    }
  };

  // 1. Pre-extraction safety inspection
  const inspection = inspectArchiveSafety(archivePath);
  if (!inspection.safe) {
    cleanup();
    return {
      success: false,
      books: [],
      quarantined: [],
      error: inspection.error || "Archive rejected by security inspection",
      cleanup: () => {}
    };
  }

  // 2. Safe extraction using bsdtar with strip-components guards
  fs.mkdirSync(tempExtractDir, { recursive: true });

  const tarRes = spawnSync(
    "/usr/bin/bsdtar",
    [
      "-xf",
      archivePath,
      "-C",
      tempExtractDir
    ],
    { encoding: "utf8", timeout: 45000 }
  );

  if (tarRes.status !== 0) {
    cleanup();
    return {
      success: false,
      books: [],
      quarantined: [],
      error: tarRes.stderr?.trim() || "Archive extraction failed (unsupported or corrupted archive format)",
      cleanup: () => {}
    };
  }

  // 3. Recursively scan extracted contents, enforcing canonical EPUB filtering
  const foundBooks: ExtractedBook[] = [];
  const quarantined: QuarantinedFile[] = [];

  function scan(dir: string) {
    const entries = fs.readdirSync(dir, { withFileTypes: true });
    for (const entry of entries) {
      const fullPath = path.join(dir, entry.name);

      // Symlink guard: Do not follow symlinks inside extracted archives
      try {
        const lstat = fs.lstatSync(fullPath);
        if (lstat.isSymbolicLink()) {
          console.warn(`[ArchiveUnpack] Skipping extracted symbolic link: ${fullPath}`);
          continue;
        }
      } catch {
        continue;
      }

      if (entry.isDirectory()) {
        // Skip macOS resource fork folder or hidden directories
        if (entry.name !== "__MACOSX" && !entry.name.startsWith(".")) {
          scan(fullPath);
        }
      } else if (entry.isFile()) {
        if (isSupportedBook(entry.name)) {
          foundBooks.push({
            tempPath: fullPath,
            originalName: entry.name
          });
        } else if (isNonEpubBook(entry.name)) {
          const ext = path.extname(entry.name).replace(/^\./, "").toUpperCase();
          quarantined.push({
            name: entry.name,
            originalName: entry.name,
            format: ext,
            reason: `Non-EPUB format (${ext}) rejected. home-reading-stack is an EPUB-only collection.`
          });
        }
      }
    }
  }

  try {
    scan(tempExtractDir);
  } catch (e: any) {
    cleanup();
    return {
      success: false,
      books: [],
      quarantined: [],
      error: `Failed to scan archive contents: ${e.message}`,
      cleanup: () => {}
    };
  }

  if (foundBooks.length === 0) {
    let errorMsg = "No .epub files found inside archive. Only EPUB format is accepted for the canonical collection.";
    if (quarantined.length > 0) {
      const qNames = quarantined.map(q => `${q.name} (${q.format})`).join(", ");
      errorMsg = `Only EPUB format is accepted. Archive contains no EPUBs. Quarantined non-EPUB files: ${qNames}. home-reading-stack is an EPUB-only collection.`;
    }
    cleanup();
    return {
      success: false,
      books: [],
      quarantined,
      error: errorMsg,
      cleanup: () => {}
    };
  }

  return {
    success: true,
    books: foundBooks,
    quarantined,
    cleanup
  };
}
