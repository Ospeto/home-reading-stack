import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { spawnSync } from "node:child_process";
import { Database } from "bun:sqlite";

describe("scripts/backup-ssd.sh & bin/lighthouse backup-ssd CLI", () => {
  let tmpDir: string;
  let customVolumesDir: string;
  let customConfigPath: string;
  let mockCalibreDir: string;
  let mockCalibreDb: string;
  const lighthouseRoot = path.resolve(path.join(__dirname, ".."));

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "ssd-cli-test-"));
    customVolumesDir = path.join(tmpDir, "Volumes");
    fs.mkdirSync(customVolumesDir, { recursive: true });

    customConfigPath = path.join(tmpDir, "data", "ssd-backup-config.json");
    fs.mkdirSync(path.dirname(customConfigPath), { recursive: true });

    mockCalibreDir = path.join(tmpDir, "Calibre_Library");
    fs.mkdirSync(mockCalibreDir, { recursive: true });
    mockCalibreDb = path.join(mockCalibreDir, "metadata.db");

    const db = new Database(mockCalibreDb);
    db.run("CREATE TABLE books (id INTEGER PRIMARY KEY, title TEXT, author_sort TEXT);");
    db.run("INSERT INTO books (id, title, author_sort) VALUES (1, 'Test Book', 'Author');");
    db.close();

    process.env.CALIBRE_LIBRARY_DIR = mockCalibreDir;
    process.env.CALIBRE_DB_PATH = mockCalibreDb;
    process.env.SSD_BACKUP_CONFIG_PATH = customConfigPath;
    process.env.LIGHTHOUSE_VOLUMES_DIR = customVolumesDir;
    process.env.TEST_ALLOWED_TARGET_DIR = tmpDir;
    process.env.SSD_BACKUP_LOCK_PATH = path.join(tmpDir, "ssd-backup.lock");
    process.env.TEST_NO_LAUNCHCTL = "1";
  });

  afterEach(() => {
    delete process.env.CALIBRE_LIBRARY_DIR;
    delete process.env.CALIBRE_DB_PATH;
    delete process.env.SSD_BACKUP_CONFIG_PATH;
    delete process.env.LIGHTHOUSE_VOLUMES_DIR;
    delete process.env.TEST_ALLOWED_TARGET_DIR;
    delete process.env.SSD_BACKUP_LOCK_PATH;
    delete process.env.TEST_SSD_FREE_BYTES;
    delete process.env.TEST_SSD_TOTAL_BYTES;
    delete process.env.TEST_BYPASS_DISK_SPACE;
    delete process.env.TEST_NO_LAUNCHCTL;

    try {
      if (fs.existsSync(tmpDir)) {
        fs.rmSync(tmpDir, { recursive: true, force: true });
      }
    } catch {}
  });

  it("scripts/backup-ssd.sh status returns JSON with config and drives", () => {
    const res = spawnSync(
      path.join(lighthouseRoot, "scripts", "backup-ssd.sh"),
      ["status"],
      {
        encoding: "utf8",
        env: { ...process.env },
      }
    );

    expect(res.status).toBe(0);
    const parsed = JSON.parse(res.stdout);
    expect(parsed).toHaveProperty("drives");
    expect(parsed).toHaveProperty("config");
    expect(parsed).toHaveProperty("targetMounted");
  });

  it("scripts/backup-ssd.sh set-time updates scheduleTime in config", () => {
    const res = spawnSync(
      path.join(lighthouseRoot, "scripts", "backup-ssd.sh"),
      ["set-time", "05:15"],
      {
        encoding: "utf8",
        env: { ...process.env },
      }
    );

    expect(res.status).toBe(0);
    expect(res.stdout).toContain("05:15");

    const cfg = JSON.parse(fs.readFileSync(customConfigPath, "utf8"));
    expect(cfg.scheduleTime).toBe("05:15");
  });

  it("scripts/backup-ssd.sh --target <dir> --dry-run verifies paths without writing", () => {
    const targetDir = path.join(tmpDir, "Target_SSD");
    fs.mkdirSync(targetDir);

    const res = spawnSync(
      path.join(lighthouseRoot, "scripts", "backup-ssd.sh"),
      ["--target", targetDir, "--dry-run"],
      {
        encoding: "utf8",
        env: { ...process.env },
      }
    );

    expect(res.status).toBe(0);
    expect(res.stdout).toContain("Dry run mode");
    // Manifest should not be created in dry-run
    expect(fs.existsSync(path.join(targetDir, "backup_manifest.json"))).toBe(false);
  });

  it("bin/lighthouse backup-ssd status executes via unified CLI", () => {
    const res = spawnSync(
      path.join(lighthouseRoot, "bin", "lighthouse"),
      ["backup-ssd", "status"],
      {
        encoding: "utf8",
        env: { ...process.env },
      }
    );

    expect(res.status).toBe(0);
    const parsed = JSON.parse(res.stdout);
    expect(parsed).toHaveProperty("config");
  });

  it("bin/lighthouse backup-ssd --target <dir> executes full backup and writes manifest", () => {
    const targetDir = path.join(tmpDir, "Lighthouse_CLI_SSD");
    fs.mkdirSync(targetDir);

    const res = spawnSync(
      path.join(lighthouseRoot, "bin", "lighthouse"),
      ["backup-ssd", "--target", targetDir],
      {
        encoding: "utf8",
        env: { ...process.env },
      }
    );

    expect(res.status).toBe(0);
    expect(fs.existsSync(path.join(targetDir, "backup_manifest.json"))).toBe(true);
    expect(fs.existsSync(path.join(targetDir, "Calibre_Library", "metadata.db"))).toBe(true);
    expect(fs.existsSync(path.join(targetDir, "Databases", "metadata.db"))).toBe(true);
  });
});
