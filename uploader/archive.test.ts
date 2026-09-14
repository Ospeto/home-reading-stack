import { describe, it, expect } from "bun:test";
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import {
  isSupportedBook,
  isNonEpubBook,
  isArchiveFile,
  unpackArchive,
  inspectArchiveSafety,
} from "./archive";

describe("EPUB-Only Archive & Format Quarantine", () => {
  describe("isSupportedBook", () => {
    it("accepts only .epub files (case-insensitive)", () => {
      expect(isSupportedBook("book.epub")).toBe(true);
      expect(isSupportedBook("novel.EPUB")).toBe(true);
      expect(isSupportedBook("myanmar_စာဖတ်သူ.epub")).toBe(true);
    });

    it("rejects non-EPUB eBook and document formats", () => {
      expect(isSupportedBook("manual.pdf")).toBe(false);
      expect(isSupportedBook("kindle.mobi")).toBe(false);
      expect(isSupportedBook("amazon.azw3")).toBe(false);
      expect(isSupportedBook("comic.cbz")).toBe(false);
      expect(isSupportedBook("manga.cbr")).toBe(false);
      expect(isSupportedBook("notes.txt")).toBe(false);
      expect(isSupportedBook("document.docx")).toBe(false);
    });

    it("rejects hidden and macOS resource fork files", () => {
      expect(isSupportedBook(".hidden.epub")).toBe(false);
      expect(isSupportedBook("._resource.epub")).toBe(false);
    });
  });

  describe("isNonEpubBook", () => {
    it("identifies known non-EPUB eBook formats for quarantine", () => {
      expect(isNonEpubBook("doc.pdf")).toBe(true);
      expect(isNonEpubBook("book.mobi")).toBe(true);
      expect(isNonEpubBook("kindle.azw3")).toBe(true);
      expect(isNonEpubBook("comic.cbz")).toBe(true);
      expect(isNonEpubBook("comic.cbr")).toBe(true);
      expect(isNonEpubBook("scanned.djvu")).toBe(true);
      expect(isNonEpubBook("archive.fb2")).toBe(true);
    });

    it("does not flag .epub as non-epub", () => {
      expect(isNonEpubBook("book.epub")).toBe(false);
    });
  });

  describe("isArchiveFile", () => {
    it("recognizes standard archive formats", () => {
      expect(isArchiveFile("pack.zip")).toBe(true);
      expect(isArchiveFile("books.rar")).toBe(true);
      expect(isArchiveFile("collection.7z")).toBe(true);
      expect(isArchiveFile("library.tar")).toBe(true);
      expect(isArchiveFile("single.epub")).toBe(false);
    });
  });

  describe("unpackArchive & Archive Safety Regression", () => {
    const tempDir = path.join("/tmp", `test_archive_${Date.now()}`);

    it("extracts EPUBs and quarantines non-EPUB files from mixed archives", () => {
      fs.mkdirSync(tempDir, { recursive: true });

      const epubFile = path.join(tempDir, "valid_book.epub");
      const pdfFile = path.join(tempDir, "manual.pdf");
      const mobiFile = path.join(tempDir, "old.mobi");
      const txtFile = path.join(tempDir, "readme.txt");

      // Create a valid minimal EPUB container
      const minDir = path.join(tempDir, "min_epub_content");
      const metaDir = path.join(minDir, "META-INF");
      fs.mkdirSync(metaDir, { recursive: true });
      fs.writeFileSync(path.join(minDir, "mimetype"), "application/epub+zip");
      fs.writeFileSync(path.join(metaDir, "container.xml"), "<container/>");
      spawnSync("/usr/bin/bsdtar", ["--format", "zip", "-cf", epubFile, "-C", minDir, "mimetype", "META-INF"]);
      fs.rmSync(minDir, { recursive: true, force: true });

      fs.writeFileSync(pdfFile, "mock pdf content");
      fs.writeFileSync(mobiFile, "mock mobi content");
      fs.writeFileSync(txtFile, "plain text");

      const zipPath = path.join("/tmp", `test_pack_${Date.now()}.zip`);
      spawnSync("/usr/bin/bsdtar", ["-cf", zipPath, "-C", tempDir, "."]);

      const res = unpackArchive(zipPath);
      try {
        expect(res.success).toBe(true);
        expect(res.books.length).toBe(1);
        expect(res.books[0].originalName).toBe("valid_book.epub");

        // Non-EPUB files must be quarantined
        const quarantinedNames = res.quarantined.map((q) => q.name);
        expect(quarantinedNames).toContain("manual.pdf");
        expect(quarantinedNames).toContain("old.mobi");
        expect(quarantinedNames).toContain("readme.txt");
      } finally {
        res.cleanup();
        if (fs.existsSync(zipPath)) {
          fs.unlinkSync(zipPath);
        }
        if (fs.existsSync(tempDir)) {
          fs.rmSync(tempDir, { recursive: true, force: true });
        }
      }
    });

    it("quarantines corrupted .epub files inside archives that fail physical container validation", () => {
      const corruptDir = path.join("/tmp", `test_corrupt_archive_${Date.now()}`);
      fs.mkdirSync(corruptDir, { recursive: true });

      const fakeEpub = path.join(corruptDir, "fake_corrupt.epub");
      fs.writeFileSync(fakeEpub, "not a real epub container at all");

      const zipPath = path.join("/tmp", `test_corrupt_pack_${Date.now()}.zip`);
      spawnSync("/usr/bin/bsdtar", ["-cf", zipPath, "-C", corruptDir, "."]);

      const res = unpackArchive(zipPath);
      try {
        expect(res.success).toBe(false);
        expect(res.books.length).toBe(0);
        expect(res.quarantined.length).toBe(1);
        expect(res.quarantined[0].name).toBe("fake_corrupt.epub");
        expect(res.quarantined[0].reason).toContain("Invalid or corrupted EPUB container");
      } finally {
        res.cleanup();
        if (fs.existsSync(zipPath)) fs.unlinkSync(zipPath);
        if (fs.existsSync(corruptDir)) fs.rmSync(corruptDir, { recursive: true, force: true });
      }
    });

    it("rejects archives that contain zero EPUB files with informative message", () => {
      const nonEpubDir = path.join("/tmp", `test_nonepub_${Date.now()}`);
      fs.mkdirSync(nonEpubDir, { recursive: true });

      const pdfFile = path.join(nonEpubDir, "report.pdf");
      const cbzFile = path.join(nonEpubDir, "comic.cbz");
      fs.writeFileSync(pdfFile, "pdf content");
      fs.writeFileSync(cbzFile, "cbz content");

      const zipPath = path.join("/tmp", `test_nonepub_${Date.now()}.zip`);
      spawnSync("/usr/bin/bsdtar", ["-cf", zipPath, "-C", nonEpubDir, "."]);

      const res = unpackArchive(zipPath);
      try {
        expect(res.success).toBe(false);
        expect(res.books.length).toBe(0);
        expect(res.quarantined.length).toBe(2);
        expect(res.error).toContain("Archive contains no EPUBs");
        expect(res.error).toContain("report.pdf");
        expect(res.error).toContain("comic.cbz");
      } finally {
        res.cleanup();
        if (fs.existsSync(zipPath)) {
          fs.unlinkSync(zipPath);
        }
        if (fs.existsSync(nonEpubDir)) {
          fs.rmSync(nonEpubDir, { recursive: true, force: true });
        }
      }
    });

    it("rejects archives with path traversal entries via inspectArchiveSafety", () => {
      const traversalZip = path.join(
        "/tmp",
        `test_traversal_${Date.now()}.zip`,
      );
      const pythonScript = `
import zipfile
with zipfile.ZipFile("${traversalZip}", "w") as zf:
    zf.writestr("../../etc/passwd", "root:x:0:0:root:/root:/bin/bash")
    zf.writestr("normal.epub", "content")
`;
      spawnSync("python3", ["-c", pythonScript]);

      try {
        const inspection = inspectArchiveSafety(traversalZip);
        expect(inspection.safe).toBe(false);
        expect(inspection.error).toContain("Path traversal detected");

        const unp = unpackArchive(traversalZip);
        expect(unp.success).toBe(false);
        expect(unp.error).toContain("Path traversal detected");
      } finally {
        if (fs.existsSync(traversalZip)) {
          fs.unlinkSync(traversalZip);
        }
      }
    });

    it("detects decompression bomb ratio exceeding limits", () => {
      const bombZip = path.join("/tmp", `test_bomb_${Date.now()}.zip`);
      // Create a zip with 10MB of zeroes that compresses down to ~10KB (> 50:1 ratio)
      const pythonScript = `
import zipfile
with zipfile.ZipFile("${bombZip}", "w", compression=zipfile.ZIP_DEFLATED) as zf:
    zf.writestr("huge_sparse.epub", b"0" * (12 * 1024 * 1024))
`;
      spawnSync("python3", ["-c", pythonScript]);

      try {
        const inspection = inspectArchiveSafety(bombZip);
        expect(inspection.safe).toBe(false);
        expect(inspection.error).toContain("Decompression bomb detected");

        const unp = unpackArchive(bombZip);
        expect(unp.success).toBe(false);
        expect(unp.error).toContain("Decompression bomb detected");
      } finally {
        if (fs.existsSync(bombZip)) {
          fs.unlinkSync(bombZip);
        }
      }
    });

    it("rejects archives containing symbolic links before extraction (symlink safety guard)", () => {
      const symlinkDir = path.join("/tmp", `test_symlink_dir_${Date.now()}`);
      fs.mkdirSync(symlinkDir, { recursive: true });

      const realEpub = path.join(symlinkDir, "legit.epub");
      fs.writeFileSync(realEpub, "real epub data");

      // Create a relative symlink pointing to /etc/passwd or similar
      const linkPath = path.join(symlinkDir, "evil_link.epub");
      try {
        fs.symlinkSync("/etc/hosts", linkPath);
      } catch {
        // If symlink creation fails due to permissions, skip test gracefully
      }

      const symlinkTar = path.join("/tmp", `test_symlink_${Date.now()}.tar`);
      spawnSync("/usr/bin/bsdtar", ["-cf", symlinkTar, "-C", symlinkDir, "."]);

      const unp = unpackArchive(symlinkTar);
      try {
        expect(unp.success).toBe(false);
        expect(unp.error).toContain("Symbolic link detected");
      } finally {
        unp.cleanup();
        if (fs.existsSync(symlinkTar)) fs.unlinkSync(symlinkTar);
        if (fs.existsSync(symlinkDir))
          fs.rmSync(symlinkDir, { recursive: true, force: true });
      }
    });
  });
});
