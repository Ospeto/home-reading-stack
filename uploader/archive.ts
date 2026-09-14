import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";

export interface ExtractedBook {
  tempPath: string;
  originalName: string;
}

export interface UnpackResult {
  success: boolean;
  books: ExtractedBook[];
  error?: string;
  cleanup: () => void;
}

export function isArchiveFile(filename: string): boolean {
  const ext = path.extname(filename).toLowerCase();
  return [".zip", ".rar", ".tar", ".7z", ".gz", ".bz2"].includes(ext);
}

export function isSupportedBook(filename: string): boolean {
  const ext = path.extname(filename).toLowerCase();
  const base = path.basename(filename);
  return [".epub", ".pdf", ".mobi", ".azw3", ".cbz", ".cbr"].includes(ext) &&
         !base.startsWith(".") &&
         !base.startsWith("._");
}

export function unpackArchive(archivePath: string): UnpackResult {
  const tempExtractDir = path.join("/tmp", `archive_unpack_${Date.now()}_${Math.random().toString(36).substring(2, 7)}`);
  fs.mkdirSync(tempExtractDir, { recursive: true });

  const cleanup = () => {
    try {
      if (fs.existsSync(tempExtractDir)) {
        fs.rmSync(tempExtractDir, { recursive: true, force: true });
      }
    } catch (e) {
      console.error(`[ArchiveUnpack] Cleanup error for ${tempExtractDir}:`, e);
    }
  };

  // Run native bsdtar (extracts .zip, .rar, .tar, .7z)
  const tarRes = spawnSync("/usr/bin/bsdtar", [
    "-xf",
    archivePath,
    "-C",
    tempExtractDir
  ], { encoding: "utf8" });

  if (tarRes.status !== 0) {
    cleanup();
    return {
      success: false,
      books: [],
      error: tarRes.stderr?.trim() || "Archive extraction failed (unsupported or corrupted archive format)",
      cleanup: () => {}
    };
  }

  // Recursively scan for supported eBook files, discarding junk
  const foundBooks: ExtractedBook[] = [];
  function scan(dir: string) {
    const entries = fs.readdirSync(dir, { withFileTypes: true });
    for (const entry of entries) {
      const fullPath = path.join(dir, entry.name);
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

  return {
    success: true,
    books: foundBooks,
    cleanup
  };
}
