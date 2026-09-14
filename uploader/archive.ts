import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";

export const MAX_ARCHIVE_SIZE_BYTES = 100 * 1024 * 1024; // 100MB
export const MAX_SINGLE_FILE_SIZE_BYTES = 150 * 1024 * 1024; // 150MB
export const MAX_TOTAL_UNCOMPRESSED_BYTES = 500 * 1024 * 1024; // 500MB
export const MAX_ARCHIVE_ENTRIES = 500;
export const MAX_COMPRESSION_RATIO = 100; // 100:1 expansion ratio

export interface ExtractedBook {
  tempPath: string;
  originalName: string;
}

export interface QuarantinedBook {
  originalName: string;
  format: string;
  reason: string;
}

export interface UnpackResult {
  success: boolean;
  books: ExtractedBook[];
  quarantined?: QuarantinedBook[];
  error?: string;
  cleanup: () => void;
}

export function isArchiveFile(filename: string): boolean {
  const ext = path.extname(filename).toLowerCase();
  return [".zip", ".rar", ".tar", ".7z", ".gz", ".bz2"].includes(ext);
}

/**
 * Checks whether a file is a canonical eBook format (EPUB-only).
 */
export function isCanonicalEpub(filename: string): boolean {
  const ext = path.extname(filename).toLowerCase();
  const base = path.basename(filename);
  return ext === ".epub" && !base.startsWith(".") && !base.startsWith("._");
}

/**
 * Recognizes legacy/non-canonical eBook formats that should be rejected or quarantined.
 */
export function isLegacyOrNonCanonicalFormat(filename: string): boolean {
  const ext = path.extname(filename).toLowerCase();
  const base = path.basename(filename);
  return (
    [".pdf", ".mobi", ".azw3", ".cbz", ".cbr", ".azw", ".djvu", ".fb2"].includes(ext) &&
    !base.startsWith(".") &&
    !base.startsWith("._")
  );
}

/**
 * Main validator for supported books on ingestion.
 * Strictly enforces EPUB-only canonical collection.
 */
export function isSupportedBook(filename: string): boolean {
  return isCanonicalEpub(filename);
}

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

  // 1. Inspect archive headers and check resource limits prior to extraction
  const inspection = inspectArchiveSafety(archivePath);
  if (!inspection.safe) {
    return {
      success: false,
      books: [],
      error: inspection.error || "Archive rejected by safety scanner",
      cleanup: () => {}
    };
  }

  fs.mkdirSync(tempExtractDir, { recursive: true });

  // 2. Run bsdtar with non-privileged flags into isolated sandbox directory
  const tarRes = spawnSync(
    "/usr/bin/bsdtar",
    [
      "-xf",
      archivePath,
      "-C",
      tempExtractDir,
      "--no-same-owner",
      "--no-same-permissions"
    ],
    { encoding: "utf8", timeout: 30000 }
  );

  if (tarRes.status !== 0) {
    cleanup();
    return {
      success: false,
      books: [],
      error: tarRes.stderr?.trim() || "Archive extraction failed (unsupported or corrupted archive format)",
      cleanup: () => {}
    };
  }

  // 3. Recursively scan extracted contents, enforcing canonical EPUB filtering
  const canonicalDir = path.resolve(tempExtractDir);
  const foundBooks: ExtractedBook[] = [];
  const quarantined: QuarantinedBook[] = [];

  function scan(dir: string) {
    const entries = fs.readdirSync(dir, { withFileTypes: true });
    for (const entry of entries) {
      const fullPath = path.join(dir, entry.name);
      // Containment guard: ensure realpath never escapes tempExtractDir
      const resolvedPath = path.resolve(fullPath);
      if (!resolvedPath.startsWith(canonicalDir)) {
        console.warn(`[ArchiveUnpack] Path escape detected for entry: ${entry.name}`);
        continue;
      }

      if (entry.isDirectory()) {
        if (entry.name !== "__MACOSX" && !entry.name.startsWith(".")) {
          scan(fullPath);
        }
      } else if (entry.isFile()) {
        if (isCanonicalEpub(entry.name)) {
          foundBooks.push({
            tempPath: fullPath,
            originalName: entry.name
          });
        } else if (isLegacyOrNonCanonicalFormat(entry.name)) {
          quarantined.push({
            originalName: entry.name,
            format: path.extname(entry.name).toLowerCase(),
            reason: "Non-canonical format (collection is EPUB-only)"
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
      error: `Failed to scan archive contents: ${e.message}`,
      cleanup: () => {}
    };
  }

  if (foundBooks.length === 0) {
    let errorMsg = "No valid .epub files found inside archive.";
    if (quarantined.length > 0) {
      const formats = Array.from(new Set(quarantined.map((q) => q.format))).join(", ");
      errorMsg = `Rejected non-canonical formats (${formats}): Only EPUB format is accepted for the canonical collection. ${quarantined.length} non-EPUB file(s) were rejected.`;
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
