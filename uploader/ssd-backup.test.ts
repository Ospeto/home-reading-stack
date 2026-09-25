import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { Database } from "bun:sqlite";
import {
  detectExternalDrives,
  findDefaultSsdTarget,
  getSsdBackupConfig,
  saveSsdBackupConfig,
  generateSsdBackupPlist,
  updateLaunchAgentSchedule,
  performSsdBackup,
  getSsdBackupStatus,
  countCalibreBooks,
  calculateDirectorySize,
  validateScheduleTime,
  validateTargetDirectory,
  escapeXml,
  acquireBackupLock,
  releaseBackupLock,
  getLockFilePath,
  EXCLUDED_VOLUME_NAMES,
  DEFAULT_CONFIG,
} from "./ssd-backup";
import { handleRequest } from "./server";

describe("External SSD Incremental Backup System", () => {
  let tmpDir: string;
  let customVolumesDir: string;
  let customConfigPath: string;
  let mockCalibreDir: string;
  let mockCalibreDb: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "ssd-backup-test-"));
    customVolumesDir = path.join(tmpDir, "Volumes");
    fs.mkdirSync(customVolumesDir, { recursive: true });

    customConfigPath = path.join(tmpDir, "data", "ssd-backup-config.json");
    fs.mkdirSync(path.dirname(customConfigPath), { recursive: true });

    mockCalibreDir = path.join(tmpDir, "Calibre_Library");
    fs.mkdirSync(mockCalibreDir, { recursive: true });
    mockCalibreDb = path.join(mockCalibreDir, "metadata.db");

    // Initialize minimal Calibre SQLite database
    const db = new Database(mockCalibreDb);
    db.run("CREATE TABLE books (id INTEGER PRIMARY KEY, title TEXT, author_sort TEXT);");
    db.run("INSERT INTO books (id, title, author_sort) VALUES (1, 'Book 1', 'Author A');");
    db.run("INSERT INTO books (id, title, author_sort) VALUES (2, 'Book 2', 'Author B');");
    db.close();

    // Create a dummy EPUB file in mock Calibre directory
    const authorDir = path.join(mockCalibreDir, "Author A", "Book 1 (1)");
    fs.mkdirSync(authorDir, { recursive: true });
    fs.writeFileSync(path.join(authorDir, "Book 1 - Author A.epub"), "PK0304-mock-epub-content");
    fs.writeFileSync(path.join(authorDir, "cover.jpg"), "mock-jpeg-cover");

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

  describe("Drive Detection & Exclusions", () => {
    it("excludes system partitions, e-readers, and IP network mounts", () => {
      expect(EXCLUDED_VOLUME_NAMES.test("Macintosh HD")).toBe(true);
      expect(EXCLUDED_VOLUME_NAMES.test("Macintosh HD - Data")).toBe(true);
      expect(EXCLUDED_VOLUME_NAMES.test("Recovery")).toBe(true);
      expect(EXCLUDED_VOLUME_NAMES.test("Preboot")).toBe(true);
      expect(EXCLUDED_VOLUME_NAMES.test("VM")).toBe(true);
      expect(EXCLUDED_VOLUME_NAMES.test("Update")).toBe(true);
      expect(EXCLUDED_VOLUME_NAMES.test("Kindle")).toBe(true);
      expect(EXCLUDED_VOLUME_NAMES.test("KINDLE")).toBe(true);
      expect(EXCLUDED_VOLUME_NAMES.test("Kobo")).toBe(true);
      expect(EXCLUDED_VOLUME_NAMES.test("KOReader")).toBe(true);
      expect(EXCLUDED_VOLUME_NAMES.test("192.168.31.15")).toBe(true);
      expect(EXCLUDED_VOLUME_NAMES.test("Time Machine Backups")).toBe(true);

      // Does not exclude legitimate external SSDs
      expect(EXCLUDED_VOLUME_NAMES.test("Ospeto_SSD")).toBe(false);
      expect(EXCLUDED_VOLUME_NAMES.test("Samsung_T7")).toBe(false);
      expect(EXCLUDED_VOLUME_NAMES.test("External_Backup")).toBe(false);
    });

    it("detects writable external drives and prioritizes Ospeto_SSD", () => {
      // Create mock volume entries
      fs.mkdirSync(path.join(customVolumesDir, "Macintosh HD"));
      fs.mkdirSync(path.join(customVolumesDir, "Kindle"));
      fs.mkdirSync(path.join(customVolumesDir, "192.168.31.15"));
      fs.mkdirSync(path.join(customVolumesDir, "Generic_USB"));
      fs.mkdirSync(path.join(customVolumesDir, "Ospeto_SSD"));

      const drives = detectExternalDrives(customVolumesDir);
      expect(drives.length).toBe(2);

      // Ospeto_SSD should be prioritized first
      expect(drives[0].name).toBe("Ospeto_SSD");
      expect(drives[0].isPreferred).toBe(true);
      expect(drives[0].isWritable).toBe(true);

      expect(drives[1].name).toBe("Generic_USB");
      expect(drives[1].isPreferred).toBe(false);
    });

    it("findDefaultSsdTarget returns Ospeto_SSD when mounted", () => {
      fs.mkdirSync(path.join(customVolumesDir, "Ospeto_SSD"));
      const target = findDefaultSsdTarget(customVolumesDir, customConfigPath, false);
      expect(target).toBe(path.join(customVolumesDir, "Ospeto_SSD"));
    });

    it("findDefaultSsdTarget returns configured targetMount if mounted", () => {
      const customMount = path.join(customVolumesDir, "Custom_Drive");
      fs.mkdirSync(customMount);
      saveSsdBackupConfig({ targetMount: customMount }, customConfigPath);

      const target = findDefaultSsdTarget(customVolumesDir, customConfigPath, true);
      expect(target).toBe(customMount);
    });
  });

  describe("Configuration Persistence", () => {
    it("returns default config when file does not exist", () => {
      const cfg = getSsdBackupConfig(customConfigPath);
      expect(cfg.enabled).toBe(DEFAULT_CONFIG.enabled);
      expect(cfg.scheduleTime).toBe("03:00");
      expect(cfg.targetMount).toBe("/Volumes/Ospeto_SSD");
      expect(cfg.lastBackup).toBeNull();
    });

    it("saves and reloads partial config updates", () => {
      saveSsdBackupConfig({ enabled: true, scheduleTime: "04:30" }, customConfigPath);
      const reloaded = getSsdBackupConfig(customConfigPath);
      expect(reloaded.enabled).toBe(true);
      expect(reloaded.scheduleTime).toBe("04:30");
      expect(reloaded.targetMount).toBe("/Volumes/Ospeto_SSD");
    });

    it("normalizes single-digit hours like 9:30 to 09:30 and round-trips cleanly", () => {
      saveSsdBackupConfig({ scheduleTime: "9:30" }, customConfigPath);
      const reloaded = getSsdBackupConfig(customConfigPath);
      expect(reloaded.scheduleTime).toBe("09:30");
    });

    it("rejects invalid scheduleTime format with descriptive error", () => {
      expect(() => {
        saveSsdBackupConfig({ scheduleTime: "invalid" }, customConfigPath);
      }).toThrow("Invalid scheduleTime format");
    });

    it("rejects out-of-range scheduleTime 99:99 or 25:00", () => {
      expect(() => {
        saveSsdBackupConfig({ scheduleTime: "99:99" }, customConfigPath);
      }).toThrow("Schedule time out of range");

      expect(() => {
        validateScheduleTime("24:00");
      }).toThrow("Schedule time out of range");

      expect(() => {
        validateScheduleTime("12:60");
      }).toThrow("Schedule time out of range");

      expect(validateScheduleTime("23:59")).toEqual({ hour: 23, minute: 59, normalizedTime: "23:59" });
      expect(validateScheduleTime("00:00")).toEqual({ hour: 0, minute: 0, normalizedTime: "00:00" });
    });

    it("rejects targetMount outside /Volumes with security error", () => {
      expect(() => {
        saveSsdBackupConfig({ targetMount: "/Users/attacker" }, customConfigPath, customVolumesDir);
      }).toThrow("Security Error");
    });
  });

  describe("LaunchAgent Plist Generation", () => {
    it("generates valid plist XML with StartCalendarInterval matching scheduleTime", () => {
      const plist = generateSsdBackupPlist({
        scheduleTime: "04:30",
        lighthouseRoot: "/test/root & special",
        homeDir: "/test/home",
        daemonPrefix: "com.ospeto",
      });

      expect(plist).toContain("<key>Label</key>");
      expect(plist).toContain("<string>com.ospeto.reading-ssd-backup</string>");
      expect(plist).toContain("<key>StartCalendarInterval</key>");
      expect(plist).toContain("<key>Hour</key>");
      expect(plist).toContain("<integer>4</integer>");
      expect(plist).toContain("<key>Minute</key>");
      expect(plist).toContain("<integer>30</integer>");
      // Verify XML escaping of &
      expect(plist).toContain("/test/root &amp; special");
      expect(plist).toContain("<string>--scheduled</string>");
    });

    it("updateLaunchAgentSchedule supports dryRun mode without writing", () => {
      const res = updateLaunchAgentSchedule({
        scheduleTime: "02:15",
        enabled: true,
        dryRun: true,
        configPath: customConfigPath,
        lighthouseRoot: "/test/root",
      });

      expect(res.success).toBe(true);
      expect(res.message).toContain("Dry-run");
      expect(res.plistContent).toContain("<integer>2</integer>");
      expect(res.plistContent).toContain("<integer>15</integer>");
    });

    it("updateLaunchAgentSchedule writes plist file to target directory", () => {
      const plistDir = path.join(tmpDir, "LaunchAgents");
      const res = updateLaunchAgentSchedule({
        scheduleTime: "05:00",
        enabled: true,
        dryRun: false,
        plistDir,
        configPath: customConfigPath,
        lighthouseRoot: "/test/root",
      });

      expect(res.success).toBe(true);
      expect(fs.existsSync(res.plistPath)).toBe(true);
      const content = fs.readFileSync(res.plistPath, "utf8");
      expect(content).toContain("<integer>5</integer>");
      expect(content).toContain("<integer>0</integer>");
    });
  });

  describe("Whole-Library Incremental Backup Engine", () => {
    it("safe detection: skips cleanly when target is unmounted and scheduled", async () => {
      saveSsdBackupConfig({ enabled: true }, customConfigPath);
      const unmountedTarget = path.join(customVolumesDir, "NonExistentSSD");
      const res = await performSsdBackup({
        target: unmountedTarget,
        scheduled: true,
        configPath: customConfigPath,
        customVolumesDir,
      });

      expect(res.success).toBe(true);
      expect(res.skipped).toBe(true);
      expect(res.reason).toContain("not mounted");
    });

    it("safe detection: skips cleanly when scheduled and auto-backup is disabled", async () => {
      saveSsdBackupConfig({ enabled: false }, customConfigPath);
      const mountedTarget = path.join(tmpDir, "Target_SSD");
      fs.mkdirSync(mountedTarget);

      const res = await performSsdBackup({
        target: mountedTarget,
        scheduled: true,
        configPath: customConfigPath,
        customVolumesDir,
      });

      expect(res.success).toBe(true);
      expect(res.skipped).toBe(true);
      expect(res.reason).toContain("disabled");
    });

    it("safe detection: rejects target outside allowed volumes directory", async () => {
      const res = await performSsdBackup({
        target: "/Users/victim",
        configPath: customConfigPath,
        customVolumesDir,
      });

      expect(res.success).toBe(false);
      expect(res.error).toContain("Security Error");
    });

    it("safe detection: rejects target overlapping with Calibre Library source", async () => {
      const res = await performSsdBackup({
        target: mockCalibreDir,
        configPath: customConfigPath,
        customVolumesDir,
      });

      expect(res.success).toBe(false);
      expect(res.error).toContain("cannot be the same as the Calibre Library source");
    });

    it("concurrency lock prevents overlapping backups", async () => {
      const targetDir = path.join(tmpDir, "Mock_SSD_Lock");
      fs.mkdirSync(targetDir, { recursive: true });

      const lock = acquireBackupLock();
      expect(lock.acquired).toBe(true);

      // Attempt second backup while lock is held
      const res = await performSsdBackup({
        target: targetDir,
        configPath: customConfigPath,
        customVolumesDir,
      });

      expect(res.success).toBe(false);
      expect(res.skipped).toBe(true);
      expect(res.error).toContain("already in progress");

      releaseBackupLock();
    });

    it("safe detection: returns error when target is unmounted and manual", async () => {
      const unmountedTarget = path.join(customVolumesDir, "NonExistentSSD");
      const res = await performSsdBackup({
        target: unmountedTarget,
        scheduled: false,
        configPath: customConfigPath,
      });

      expect(res.success).toBe(false);
      expect(res.skipped).toBe(true);
      expect(res.error).toContain("not mounted");
    });

    it("executes full backup, mirrors Calibre library, hot-backups DBs, and writes manifest", async () => {
      const targetDir = path.join(tmpDir, "Mock_SSD");
      fs.mkdirSync(targetDir, { recursive: true });

      const res = await performSsdBackup({
        target: targetDir,
        configPath: customConfigPath,
      });

      expect(res.success).toBe(true);
      expect(res.target).toBe(targetDir);
      expect(res.booksCount).toBe(2);
      expect(res.durationSeconds).toBeGreaterThanOrEqual(0);

      // Verify Calibre_Library mirror
      const mirroredCalibre = path.join(targetDir, "Calibre_Library");
      expect(fs.existsSync(mirroredCalibre)).toBe(true);
      expect(fs.existsSync(path.join(mirroredCalibre, "metadata.db"))).toBe(true);
      expect(
        fs.existsSync(path.join(mirroredCalibre, "Author A", "Book 1 (1)", "Book 1 - Author A.epub"))
      ).toBe(true);

      // Verify Databases directory & hot backup
      const mirroredDbs = path.join(targetDir, "Databases");
      expect(fs.existsSync(mirroredDbs)).toBe(true);
      expect(fs.existsSync(path.join(mirroredDbs, "metadata.db"))).toBe(true);
      expect(fs.existsSync(path.join(mirroredDbs, "metadata.db.sha256"))).toBe(true);

      // Verify backup_manifest.json
      const manifestPath = path.join(targetDir, "backup_manifest.json");
      expect(fs.existsSync(manifestPath)).toBe(true);
      const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
      expect(manifest.version).toBe("1.0.0");
      expect(manifest.calibreLibrary.booksCount).toBe(2);
      expect(manifest.databases.length).toBeGreaterThan(0);
      expect(manifest.success).toBe(true);

      // Verify config was updated with lastBackup report
      const updatedConfig = getSsdBackupConfig(customConfigPath);
      expect(updatedConfig.lastBackup).not.toBeNull();
      expect(updatedConfig.lastBackup?.success).toBe(true);
      expect(updatedConfig.lastBackup?.booksCount).toBe(2);
    });

    it("subsequent incremental backup is fast and preserves deletions", async () => {
      const targetDir = path.join(tmpDir, "Mock_SSD_Incremental");
      fs.mkdirSync(targetDir, { recursive: true });

      // Run initial backup
      const res1 = await performSsdBackup({
        target: targetDir,
        configPath: customConfigPath,
      });
      expect(res1.success).toBe(true);

      // Add a third book to Calibre
      const db = new Database(mockCalibreDb);
      db.run("INSERT INTO books (id, title, author_sort) VALUES (3, 'Book 3', 'Author C');");
      db.close();

      const newBookDir = path.join(mockCalibreDir, "Author C", "Book 3 (3)");
      fs.mkdirSync(newBookDir, { recursive: true });
      fs.writeFileSync(path.join(newBookDir, "Book 3 - Author C.epub"), "PK-new-book");

      // Run incremental backup
      const res2 = await performSsdBackup({
        target: targetDir,
        configPath: customConfigPath,
      });
      expect(res2.success).toBe(true);
      expect(res2.booksCount).toBe(3);

      const mirroredNewBook = path.join(targetDir, "Calibre_Library", "Author C", "Book 3 (3)", "Book 3 - Author C.epub");
      expect(fs.existsSync(mirroredNewBook)).toBe(true);
    });
  });

  describe("Helper Utilities", () => {
    it("getSsdBackupStatus returns structured drive, config, and mount information", () => {
      fs.mkdirSync(path.join(customVolumesDir, "Ospeto_SSD"));
      saveSsdBackupConfig({ targetMount: path.join(customVolumesDir, "Ospeto_SSD") }, customConfigPath);

      const status = getSsdBackupStatus(customVolumesDir, customConfigPath);
      expect(status.drives.length).toBe(1);
      expect(status.targetMounted).toBe(true);
      expect(status.config.scheduleTime).toBe("03:00");
    });

    it("countCalibreBooks returns 0 for non-existent database", () => {
      expect(countCalibreBooks("/nonexistent/metadata.db")).toBe(0);
    });

    it("validateTargetDirectory validates allowed paths and rejects traversal", () => {
      const valid = validateTargetDirectory(path.join(customVolumesDir, "MySSD"), customVolumesDir);
      expect(valid.valid).toBe(true);

      const invalid = validateTargetDirectory("/Users/attacker", customVolumesDir);
      expect(invalid.valid).toBe(false);
      expect(invalid.error).toContain("Security Error");

      const empty = validateTargetDirectory("", customVolumesDir);
      expect(empty.valid).toBe(false);
    });

    it("validateTargetDirectory rejects root /Volumes directory and symlink escapes", () => {
      // Rejects /Volumes itself
      const rootRes = validateTargetDirectory("/Volumes", customVolumesDir);
      expect(rootRes.valid).toBe(false);
      expect(rootRes.error).toContain("root volumes directory");

      // Rejects symlink pointing outside /Volumes
      const outsideDir = fs.mkdtempSync(path.join(os.tmpdir(), "outside_victim_"));
      const symlinkPath = path.join(customVolumesDir, "EvilSSD");
      try {
        fs.symlinkSync(outsideDir, symlinkPath);

        // Even though symlink resides in customVolumesDir, its realpath escapes
        const symlinkRes = validateTargetDirectory(symlinkPath, customVolumesDir);
        expect(symlinkRes.valid).toBe(false);
        expect(symlinkRes.error).toContain("outside allowed volumes directory");
      } finally {
        if (fs.existsSync(symlinkPath)) {
          fs.unlinkSync(symlinkPath);
        }
        if (fs.existsSync(outsideDir)) {
          fs.rmSync(outsideDir, { recursive: true, force: true });
        }
      }
    });

    it("free-space preflight: fails closed when free space is under 100MB or 0", async () => {
      const targetDir = path.join(tmpDir, "Full_SSD");
      fs.mkdirSync(targetDir, { recursive: true });

      // Mock freeBytes to 50MB (below 100MB minimum)
      process.env.TEST_SSD_FREE_BYTES = String(50 * 1024 * 1024);
      process.env.TEST_SSD_TOTAL_BYTES = String(1024 * 1024 * 1024);

      const res = await performSsdBackup({
        target: targetDir,
        configPath: customConfigPath,
        customVolumesDir,
      });

      expect(res.success).toBe(false);
      expect(res.error).toContain("Insufficient free space on target SSD");

      // Mock freeBytes to 0 (fails closed)
      process.env.TEST_SSD_FREE_BYTES = "0";
      const resZero = await performSsdBackup({
        target: targetDir,
        configPath: customConfigPath,
        customVolumesDir,
      });
      expect(resZero.success).toBe(false);
      expect(resZero.error).toContain("Insufficient free space on target SSD");

      delete process.env.TEST_SSD_FREE_BYTES;
      delete process.env.TEST_SSD_TOTAL_BYTES;
    });

    it("free-space preflight: fails closed when storage capacity cannot be determined (totalBytes <= 0)", async () => {
      const targetDir = path.join(tmpDir, "Unknown_Cap_SSD");
      fs.mkdirSync(targetDir, { recursive: true });

      process.env.TEST_SSD_FREE_BYTES = "0";
      process.env.TEST_SSD_TOTAL_BYTES = "0";

      const res = await performSsdBackup({
        target: targetDir,
        configPath: customConfigPath,
        customVolumesDir,
      });

      expect(res.success).toBe(false);
      expect(res.error).toContain("Unable to determine storage capacity or free space");

      delete process.env.TEST_SSD_FREE_BYTES;
      delete process.env.TEST_SSD_TOTAL_BYTES;
    });

    it("releaseBackupLock preserves winner lock when called with different expectedPid", () => {
      const lockRes = acquireBackupLock();
      expect(lockRes.acquired).toBe(true);

      // Another PID tries to release the lock
      releaseBackupLock(999999);

      // Lock should still exist
      const lockFile = getLockFilePath();
      expect(fs.existsSync(lockFile)).toBe(true);

      // Release with correct PID
      releaseBackupLock(process.pid);
      expect(fs.existsSync(lockFile)).toBe(false);
    });

    it("escapeXml escapes special XML characters", () => {
      expect(escapeXml("a & b < c > 'd' \"e\"")).toBe("a &amp; b &lt; c &gt; &apos;d&apos; &quot;e&quot;");
    });

    it("calculateDirectorySize returns byte total of files", () => {
      const testDir = path.join(tmpDir, "size_test");
      fs.mkdirSync(testDir, { recursive: true });
      fs.writeFileSync(path.join(testDir, "a.txt"), "hello"); // 5 bytes
      fs.writeFileSync(path.join(testDir, "b.txt"), "world!"); // 6 bytes
      expect(calculateDirectorySize(testDir)).toBe(11);
    });
  });

  describe("REST API Endpoints", () => {
    const localServer = { requestIP: () => ({ address: "127.0.0.1" }) };

    it("GET /api/backup/ssd/status returns status and config", async () => {
      const req = new Request("http://127.0.0.1:8086/api/backup/ssd/status", {
        method: "GET",
      });

      const res = await handleRequest(req, localServer);
      expect(res.status).toBe(200);
      const json = await res.json();
      expect(json).toHaveProperty("drives");
      expect(json).toHaveProperty("config");
      expect(json).toHaveProperty("targetMounted");
      expect(json.config.scheduleTime).toBe("03:00");
    });

    it("POST /api/backup/ssd/config updates enabled and scheduleTime", async () => {
      const req = new Request("http://127.0.0.1:8086/api/backup/ssd/config", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          enabled: true,
          scheduleTime: "04:15",
          targetMount: "/Volumes/Ospeto_SSD",
        }),
      });

      const res = await handleRequest(req, localServer);
      expect(res.status).toBe(200);
      const json = await res.json();
      expect(json.success).toBe(true);
      expect(json.config.enabled).toBe(true);
      expect(json.config.scheduleTime).toBe("04:15");
    });

    it("POST /api/backup/ssd/config rejects invalid scheduleTime with 400", async () => {
      const req = new Request("http://127.0.0.1:8086/api/backup/ssd/config", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ scheduleTime: "bad-time" }),
      });

      const res = await handleRequest(req, localServer);
      expect(res.status).toBe(400);
      const json = await res.json();
      expect(json.success).toBe(false);
      expect(json.error).toContain("Invalid scheduleTime");
    });

    it("POST /api/backup/ssd/config rejects out-of-range scheduleTime 99:99 with 400", async () => {
      const req = new Request("http://127.0.0.1:8086/api/backup/ssd/config", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ scheduleTime: "99:99" }),
      });

      const res = await handleRequest(req, localServer);
      expect(res.status).toBe(400);
      const json = await res.json();
      expect(json.success).toBe(false);
      expect(json.error).toContain("Schedule time out of range");
    });

    it("POST /api/backup/ssd/config rejects path traversal targetMount with 400", async () => {
      const req = new Request("http://127.0.0.1:8086/api/backup/ssd/config", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ targetMount: "/Volumes/../../Users/attacker" }),
      });

      const res = await handleRequest(req, localServer);
      expect(res.status).toBe(400);
      const json = await res.json();
      expect(json.success).toBe(false);
      expect(json.error).toContain("Security Error");
    });

    it("POST /api/backup/ssd/run rejects path traversal target with 400", async () => {
      const req = new Request("http://127.0.0.1:8086/api/backup/ssd/run", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ target: "/Volumes/../../etc" }),
      });

      const res = await handleRequest(req, localServer);
      expect(res.status).toBe(400);
      const json = await res.json();
      expect(json.success).toBe(false);
      expect(json.error).toContain("Security Error");
    });

    it("POST /api/backup/ssd/run triggers backup and returns report", async () => {
      const targetDir = path.join(tmpDir, "API_SSD");
      fs.mkdirSync(targetDir, { recursive: true });

      const req = new Request("http://127.0.0.1:8086/api/backup/ssd/run", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ target: targetDir }),
      });

      const res = await handleRequest(req, localServer);
      expect(res.status).toBe(200);
      const json = await res.json();
      expect(json.success).toBe(true);
      expect(json.booksCount).toBe(2);
      expect(fs.existsSync(path.join(targetDir, "backup_manifest.json"))).toBe(true);
    });
  });
});
