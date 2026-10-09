import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import * as process from "node:process";
import { Database } from "bun:sqlite";

const REPO_ROOT = path.resolve(import.meta.dir, "..");
const LIGHTHOUSE_BIN = path.join(REPO_ROOT, "bin", "lighthouse");

describe("LightHouse Unified Architecture & Control CLI", () => {
  let tempTestDir: string;

  beforeEach(() => {
    tempTestDir = fs.mkdtempSync(path.join(os.tmpdir(), "lh-test-"));
  });

  afterEach(() => {
    if (fs.existsSync(tempTestDir)) {
      fs.rmSync(tempTestDir, { recursive: true, force: true });
    }
  });

  describe("1. Binary & Root Resolution", () => {
    it("bin/lighthouse exists and has executable permissions", () => {
      expect(fs.existsSync(LIGHTHOUSE_BIN)).toBe(true);
      const stat = fs.statSync(LIGHTHOUSE_BIN);
      // Check user executable bit
      expect(stat.mode & 0o111).toBeGreaterThan(0);
    });

    it("bin/lighthouse prints help with all supported commands", () => {
      const res = spawnSync(LIGHTHOUSE_BIN, ["--help"], {
        encoding: "utf8",
        cwd: tempTestDir,
      });
      expect(res.status).toBe(0);
      const stdout = res.stdout;
      expect(stdout).toContain("LightHouse Reading Stack CLI");
      expect(stdout).toContain("status");
      expect(stdout).toContain("up");
      expect(stdout).toContain("down");
      expect(stdout).toContain("health");
      expect(stdout).toContain("categorize");
      expect(stdout).toContain("enrich-synopsis");
      expect(stdout).toContain("heal-covers");
      expect(stdout).toContain("sync-obsidian");
      expect(stdout).toContain("sync-kindle");
      expect(stdout).toContain("install-daemons");
      expect(stdout).toContain("backup");
      expect(stdout).toContain("restore");
    });

    it("bin/lighthouse categorize --help outputs categorize options", () => {
      const res = spawnSync(LIGHTHOUSE_BIN, ["categorize", "--help"], {
        encoding: "utf8",
        cwd: tempTestDir,
      });
      expect(res.status).toBe(0);
      expect(res.stdout).toContain("LightHouse Library Categorization & Language Fix Tool");
      expect(res.stdout).toContain("--dry-run");
      expect(res.stdout).toContain("--apply");
      expect(res.stdout).toContain("--limit");
    });

    it("bin/lighthouse enrich-synopsis --help outputs enrich-synopsis options", () => {
      const res = spawnSync(LIGHTHOUSE_BIN, ["enrich-synopsis", "--help"], {
        encoding: "utf8",
        cwd: tempTestDir,
      });
      expect(res.status).toBe(0);
      expect(res.stdout).toContain("LightHouse Synopsis Enrichment Tool");
      expect(res.stdout).toContain("--dry-run");
      expect(res.stdout).toContain("--apply");
      expect(res.stdout).toContain("--limit");
      expect(res.stdout).toContain("--source");
    });
    it("bin/lighthouse heal-covers --help outputs heal-covers options", () => {
      const res = spawnSync(LIGHTHOUSE_BIN, ["heal-covers", "--help"], {
        encoding: "utf8",
        cwd: tempTestDir,
      });
      expect(res.status).toBe(0);
      expect(res.stdout).toContain("LightHouse Cover Cache & Volume Integrity Healer");
      expect(res.stdout).toContain("--dry-run");
      expect(res.stdout).toContain("--apply");
      expect(res.stdout).toContain("--series");
      expect(res.stdout).toContain("--book-id");
    });

    it("bin/lighthouse sync-obsidian --help outputs sync-obsidian options", () => {
      const res = spawnSync(LIGHTHOUSE_BIN, ["sync-obsidian", "--help"], {
        encoding: "utf8",
        cwd: tempTestDir,
      });
      expect(res.status).toBe(0);
      expect(res.stdout).toContain("LightHouse Obsidian Highlight & Note Sync CLI");
      expect(res.stdout).toContain("--vault-path");
      expect(res.stdout).toContain("--dry-run");
      expect(res.stdout).toContain("--apply");
      expect(res.stdout).toContain("--watch");
    });

    it("bin/lighthouse sync-kindle --help outputs sync-kindle options", () => {
      const res = spawnSync(LIGHTHOUSE_BIN, ["sync-kindle", "--help"], {
        encoding: "utf8",
        cwd: tempTestDir,
      });
      expect(res.status).toBe(0);
      expect(res.stdout).toContain("LightHouse Type-C Kindle Two-Way Synchronization CLI");
      expect(res.stdout).toContain("--apply");
      expect(res.stdout).toContain("--dry-run");
      expect(res.stdout).toContain("--all");
      expect(res.stdout).toContain("--mount");
      expect(res.stdout).toContain("--vault-path");
      expect(res.stdout).toContain("--eject");
    });
    it("bin/lighthouse version outputs current version", () => {
      const res = spawnSync(LIGHTHOUSE_BIN, ["version"], {
        encoding: "utf8",
        cwd: tempTestDir,
      });
      expect(res.status).toBe(0);
      expect(res.stdout).toContain("lighthouse version 1.0.0");
    });

    it("resolves LIGHTHOUSE_ROOT accurately when called from outside the repo", () => {
      const res = spawnSync(LIGHTHOUSE_BIN, ["status"], {
        encoding: "utf8",
        cwd: tempTestDir, // running from /tmp
        env: {
          ...process.env,
          US_WAN_HQ_URL: "http://127.0.0.1:1",
          SG_OPDS_80_URL: "http://127.0.0.1:1",
        },
      });
      expect(res.status).toBe(0);
      expect(res.stdout).toContain(`Root: ${REPO_ROOT}`);
    });

    it("all scripts in scripts/ define LIGHTHOUSE_ROOT", () => {
      const scripts = [
        "backup-daily.sh",
        "clean-duplicates.sh",
        "enrich-synopses.sh",
        "migration-preflight.sh",
        "sync-series-metadata.sh",
        "tunnel-watchdog.sh",
      ];
      for (const s of scripts) {
        const scriptPath = path.join(REPO_ROOT, "scripts", s);
        expect(fs.existsSync(scriptPath)).toBe(true);
        const content = fs.readFileSync(scriptPath, "utf8");
        expect(content).toContain('LIGHTHOUSE_ROOT=');
      }
    });

    it("creates defensive uploader symlink in flattened deployment layout", () => {
      const flattenedDir = fs.mkdtempSync(path.join(os.tmpdir(), "lighthouse-flattened-"));
      try {
        fs.mkdirSync(path.join(flattenedDir, "bin"), { recursive: true });
        fs.mkdirSync(path.join(flattenedDir, "scripts"), { recursive: true });
        fs.copyFileSync(LIGHTHOUSE_BIN, path.join(flattenedDir, "bin", "lighthouse"));
        fs.chmodSync(path.join(flattenedDir, "bin", "lighthouse"), 0o755);

        const res = spawnSync(path.join(flattenedDir, "bin", "lighthouse"), ["version"], {
          encoding: "utf8",
          cwd: flattenedDir,
        });
        expect(res.status).toBe(0);
        const linkPath = path.join(flattenedDir, "uploader");
        expect(fs.existsSync(linkPath)).toBe(true);
        expect(fs.lstatSync(linkPath).isSymbolicLink()).toBe(true);
        expect(fs.readlinkSync(linkPath)).toBe(".");
      } finally {
        fs.rmSync(flattenedDir, { recursive: true, force: true });
      }
    });
  });

  describe("2. Status Command Dashboard", () => {
    it("displays one-screen dashboard with all 4 core ports and sections", () => {
      const res = spawnSync(LIGHTHOUSE_BIN, ["status"], {
        encoding: "utf8",
        cwd: REPO_ROOT,
        env: {
          ...process.env,
          US_WAN_HQ_URL: "http://127.0.0.1:1",
          SG_OPDS_80_URL: "http://127.0.0.1:1",
        },
      });
      expect(res.status).toBe(0);
      const out = res.stdout;

      expect(out).toContain("LightHouse Reading Stack — System Status");
      expect(out).toContain("LOCAL PORT LISTENERS");
      expect(out).toContain("Port 8086");
      expect(out).toContain("Port 7200");
      expect(out).toContain("Port 8088");
      expect(out).toContain("Port 7890");
      expect(out).toContain("WAN REVERSE TUNNELS");
      expect(out).toContain("STORAGE & DATABASES");
    });
  });

  describe("3. Dynamic LaunchAgent Generator (install-daemons)", () => {
    it("generates valid launchd plists without hardcoded user paths", () => {
      const outputDir = path.join(tempTestDir, "agents");
      const res = spawnSync(
        LIGHTHOUSE_BIN,
        ["install-daemons", "--dry-run", "--output-dir", outputDir],
        {
          encoding: "utf8",
          cwd: REPO_ROOT,
        },
      );
      expect(res.status).toBe(0);
      expect(fs.existsSync(outputDir)).toBe(true);

      const files = fs.readdirSync(outputDir);
      expect(files.length).toBe(7);

      const uploaderPlist = files.find((f: string) => f.includes("book-uploader"));
      const botPlist = files.find((f: string) => f.includes("reading-telegram-bot"));
      const watchdogPlist = files.find((f: string) => f.includes("reading-tunnel-watchdog"));
      const vlessPlist = files.find((f: string) => f.includes("reading-vless-tunnel"));
      const sgPlist = files.find((f: string) => f.includes("reading-sg-tunnel"));
      const backupPlist = files.find((f: string) => f.includes("reading-stack-backup"));
      const ssdBackupPlist = files.find((f: string) => f.includes("reading-ssd-backup"));

      expect(uploaderPlist).toBeDefined();
      expect(botPlist).toBeDefined();
      expect(watchdogPlist).toBeDefined();
      expect(vlessPlist).toBeDefined();
      expect(sgPlist).toBeDefined();
      expect(backupPlist).toBeDefined();
      expect(ssdBackupPlist).toBeDefined();

      // Check contents of book-uploader plist
      const uploaderContent = fs.readFileSync(
        path.join(outputDir, uploaderPlist!),
        "utf8",
      );
      expect(uploaderContent).toContain(REPO_ROOT);
      expect(uploaderContent).toContain("server.ts");
      expect(uploaderContent).toContain("--env-file=");

      // Verify all generated plists include /usr/sbin:/sbin on PATH
      for (const f of files) {
        const content = fs.readFileSync(path.join(outputDir, f), "utf8");
        expect(content).toContain(
          "<string>/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin</string>",
        );
      }

      // Validate each plist using plutil if on macOS
      if (os.platform() === "darwin") {
        for (const f of files) {
          const check = spawnSync("plutil", [
            "-lint",
            path.join(outputDir, f),
          ]);
          expect(check.status).toBe(0);
        }
      }
    });

    it("escapes XML special characters in generated plists", () => {
      const outputDir = path.join(tempTestDir, "xml_escape_agents");
      const res = spawnSync(
        LIGHTHOUSE_BIN,
        ["install-daemons", "--dry-run", "--output-dir", outputDir],
        {
          encoding: "utf8",
          cwd: REPO_ROOT,
          env: {
            ...process.env,
            LOG_DIR: path.join(tempTestDir, "logs&more<dir>"),
          },
        },
      );
      expect(res.status).toBe(0);

      const files = fs.readdirSync(outputDir);
      const uploaderPlist = files.find((f: string) => f.includes("book-uploader"));
      expect(uploaderPlist).toBeDefined();

      const content = fs.readFileSync(path.join(outputDir, uploaderPlist!), "utf8");
      expect(content).toContain("logs&amp;more&lt;dir&gt;");
      expect(content).not.toContain("logs&more<dir>");
    });

    it("rejects DAEMON_PREFIX containing slashes or path traversal", () => {
      const outputDir = path.join(tempTestDir, "bad_prefix_agents");
      const res = spawnSync(
        LIGHTHOUSE_BIN,
        ["install-daemons", "--dry-run", "--output-dir", outputDir],
        {
          encoding: "utf8",
          cwd: REPO_ROOT,
          env: {
            ...process.env,
            LIGHTHOUSE_DAEMON_PREFIX: "../evil/prefix",
          },
        },
      );
      expect(res.status).toBe(1);
      expect(res.stderr).toContain("Invalid DAEMON_PREFIX");
    });
  });

  describe("4. One-Command Backup & Migration Kit", () => {
    it("creates hot SQLite backup bundle with checksum and manifest", () => {
      const mockCalibre = path.join(tempTestDir, "calibre", "metadata.db");
      const mockKosync = path.join(tempTestDir, "kosync", "koreader-sync.db");
      const mockCache = path.join(tempTestDir, "cache.db");
      const mockEnv = path.join(tempTestDir, ".env");
      const backupDir = path.join(tempTestDir, "backups");

      fs.mkdirSync(path.dirname(mockCalibre), { recursive: true });
      fs.mkdirSync(path.dirname(mockKosync), { recursive: true });

      // Create test SQLite databases
      const cDb = new Database(mockCalibre);
      cDb.run("CREATE TABLE books (id INTEGER PRIMARY KEY, title TEXT);");
      cDb.run("INSERT INTO books (title) VALUES ('Dune'), ('Neuromancer');");
      cDb.close();

      const kDb = new Database(mockKosync);
      kDb.run("CREATE TABLE progress (document TEXT PRIMARY KEY, percentage REAL);");
      kDb.run("INSERT INTO progress VALUES ('doc_dune', 0.85);");
      kDb.close();

      const chDb = new Database(mockCache);
      chDb.run("CREATE TABLE jobs (id INTEGER PRIMARY KEY, status TEXT);");
      chDb.run("INSERT INTO jobs (status) VALUES ('completed');");
      chDb.close();

      fs.writeFileSync(mockEnv, "READING_API_KEY=test_secret_key_123\n");

      // Run backup command
      const res = spawnSync(
        LIGHTHOUSE_BIN,
        ["backup", "--output-dir", backupDir],
        {
          encoding: "utf8",
          env: {
            ...process.env,
            CALIBRE_DB_PATH: mockCalibre,
            KOSYNC_DB_PATH: mockKosync,
            CACHE_DB_PATH: mockCache,
            ENV_FILE: mockEnv,
          },
        },
      );
      expect(res.status).toBe(0);

      // Verify created bundle and checksum
      const files = fs.readdirSync(backupDir);
      const bundle = files.find((f: string) => f.startsWith("lighthouse-backup-") && !f.endsWith(".sha256"));
      const shaFile = files.find((f: string) => f.endsWith(".sha256"));

      expect(bundle).toBeDefined();
      expect(shaFile).toBeDefined();

      const bundlePath = path.join(backupDir, bundle!);
      const shaPath = path.join(backupDir, shaFile!);

      // Verify SHA256 checksum matches
      const shaCheck = spawnSync("shasum", ["-a", "256", "-c", path.basename(shaPath)], {
        cwd: backupDir,
      });
      expect(shaCheck.status).toBe(0);

      // Verify tarball contents
      const listTar = spawnSync("tar", ["-tf", bundlePath], { encoding: "utf8" });
      expect(listTar.status).toBe(0);
      expect(listTar.stdout).toContain("metadata.db");
      expect(listTar.stdout).toContain("koreader-sync.db");
      expect(listTar.stdout).toContain("cache.db");
      expect(listTar.stdout).toContain("manifest.json");
      expect(listTar.stdout).toContain(".env");
    });

    it("verifies and restores complete stack from backup bundle", () => {
      const mockCalibre = path.join(tempTestDir, "source_calibre", "metadata.db");
      const mockKosync = path.join(tempTestDir, "source_kosync", "koreader-sync.db");
      const mockCache = path.join(tempTestDir, "source_cache.db");
      const backupDir = path.join(tempTestDir, "backups");
      const restoreDir = path.join(tempTestDir, "restored_library");

      fs.mkdirSync(path.dirname(mockCalibre), { recursive: true });
      fs.mkdirSync(path.dirname(mockKosync), { recursive: true });
      fs.mkdirSync(restoreDir, { recursive: true });

      const cDb = new Database(mockCalibre);
      cDb.run("CREATE TABLE books (id INTEGER PRIMARY KEY, title TEXT);");
      cDb.run("INSERT INTO books (title) VALUES ('Foundation'), ('Hyperion');");
      cDb.close();

      const kDb = new Database(mockKosync);
      kDb.run("CREATE TABLE progress (document TEXT PRIMARY KEY, percentage REAL);");
      kDb.run("INSERT INTO progress VALUES ('doc_hyperion', 0.42);");
      kDb.close();

      const chDb = new Database(mockCache);
      chDb.run("CREATE TABLE jobs (id INTEGER PRIMARY KEY, status TEXT);");
      chDb.run("INSERT INTO jobs (status) VALUES ('completed');");
      chDb.close();

      // 1. Create backup
      const backupRes = spawnSync(
        LIGHTHOUSE_BIN,
        ["backup", "--output-dir", backupDir],
        {
          encoding: "utf8",
          env: {
            ...process.env,
            CALIBRE_DB_PATH: mockCalibre,
            KOSYNC_DB_PATH: mockKosync,
            CACHE_DB_PATH: mockCache,
          },
        },
      );
      expect(backupRes.status).toBe(0);

      const files = fs.readdirSync(backupDir);
      const bundle = files.find((f: string) => f.startsWith("lighthouse-backup-") && !f.endsWith(".sha256"));
      expect(bundle).toBeDefined();
      const bundlePath = path.join(backupDir, bundle!);

      // 2. Test restore --dry-run
      const dryRunRes = spawnSync(
        LIGHTHOUSE_BIN,
        ["restore", bundlePath, "--dry-run"],
        { encoding: "utf8" },
      );
      expect(dryRunRes.status).toBe(0);
      expect(dryRunRes.stdout).toContain("Dry-run mode: All verification checks passed");

      // 3. Test restore to target directory
      const restoreCalibre = path.join(restoreDir, "metadata.db");
      const restoreKosync = path.join(restoreDir, "koreader-sync.db");
      const restoreCache = path.join(restoreDir, "cache.db");

      const restoreRes = spawnSync(
        LIGHTHOUSE_BIN,
        [
          "restore",
          bundlePath,
          "--force",
          "--target",
          restoreDir,
        ],
        {
          encoding: "utf8",
          env: {
            ...process.env,
            CALIBRE_DB_PATH: restoreCalibre,
            KOSYNC_DB_PATH: restoreKosync,
            CACHE_DB_PATH: restoreCache,
          },
        },
      );
      expect(restoreRes.status).toBe(0);
      expect(restoreRes.stdout).toContain("Restoration complete");

      // 4. Verify restored databases
      expect(fs.existsSync(restoreCalibre)).toBe(true);
      expect(fs.existsSync(restoreKosync)).toBe(true);
      expect(fs.existsSync(restoreCache)).toBe(true);

      const rCdb = new Database(restoreCalibre, { readonly: true });
      const books = rCdb.query("SELECT title FROM books ORDER BY id;").all() as any[];
      expect(books.length).toBe(2);
      expect(books[0].title).toBe("Foundation");
      expect(books[1].title).toBe("Hyperion");
      rCdb.close();

      const rKdb = new Database(restoreKosync, { readonly: true });
      const progress = rKdb.query("SELECT percentage FROM progress WHERE document = 'doc_hyperion';").get() as any;
      expect(progress.percentage).toBe(0.42);
      rKdb.close();
    }, 30000);

    it("restore rejects corrupted archive or tampered checksum", () => {
      const backupDir = path.join(tempTestDir, "corrupted_backups");
      fs.mkdirSync(backupDir, { recursive: true });

      const fakeBundle = path.join(backupDir, "lighthouse-backup-fake.tar.gz");
      const fakeSha = `${fakeBundle}.sha256`;

      fs.writeFileSync(fakeBundle, "not-a-tarball");
      fs.writeFileSync(fakeSha, "0000000000000000000000000000000000000000000000000000000000000000  lighthouse-backup-fake.tar.gz\n");

      const res = spawnSync(LIGHTHOUSE_BIN, ["restore", fakeBundle, "--dry-run"], {
        encoding: "utf8",
      });
      expect(res.status).toBe(1);
      expect(res.stdout + res.stderr).toContain("Checksum mismatch");
    });

    it("restore fails if checksum file is missing", () => {
      const backupDir = path.join(tempTestDir, "no_checksum_backups");
      fs.mkdirSync(backupDir, { recursive: true });

      const fakeBundle = path.join(backupDir, "lighthouse-backup-nochecksum.tar.gz");
      fs.writeFileSync(fakeBundle, "mock-tarball-content");

      const res = spawnSync(LIGHTHOUSE_BIN, ["restore", fakeBundle, "--dry-run"], {
        encoding: "utf8",
      });
      expect(res.status).toBe(1);
      expect(res.stdout + res.stderr).toContain("Checksum file not found");
    });

    it("restore fails if checksum file references a different bundle filename", () => {
      const backupDir = path.join(tempTestDir, "mismatched_name_backups");
      fs.mkdirSync(backupDir, { recursive: true });

      const fakeBundle = path.join(backupDir, "lighthouse-backup-actual.tar.gz");
      const fakeSha = `${fakeBundle}.sha256`;

      fs.writeFileSync(fakeBundle, "mock-tarball-content");
      fs.writeFileSync(fakeSha, "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855  lighthouse-backup-different.tar.gz\n");

      const res = spawnSync(LIGHTHOUSE_BIN, ["restore", fakeBundle, "--dry-run"], {
        encoding: "utf8",
      });
      expect(res.status).toBe(1);
      expect(res.stdout + res.stderr).toContain("Checksum references");
    });

    it("restore fails if archive contains disallowed member or path traversal", () => {
      const backupDir = path.join(tempTestDir, "disallowed_backups");
      fs.mkdirSync(backupDir, { recursive: true });

      const fakeBundle = path.join(backupDir, "lighthouse-backup-disallowed.tar.gz");
      const fakeSha = `${fakeBundle}.sha256`;

      // Create a tarball containing an unauthorized file name
      const stageDir = path.join(tempTestDir, "bad_archive_stage");
      fs.mkdirSync(stageDir, { recursive: true });
      fs.writeFileSync(path.join(stageDir, "unauthorized_script.sh"), "echo evil");
      spawnSync("tar", ["-czf", fakeBundle, "-C", stageDir, "."], { encoding: "utf8" });

      // Generate sha256 for the bundle
      const shaRes = spawnSync("shasum", ["-a", "256", path.basename(fakeBundle)], {
        cwd: backupDir,
        encoding: "utf8",
      });
      fs.writeFileSync(fakeSha, shaRes.stdout);

      const res = spawnSync(LIGHTHOUSE_BIN, ["restore", fakeBundle, "--dry-run"], {
        encoding: "utf8",
      });
      expect(res.status).toBe(1);
      expect(res.stdout + res.stderr).toContain("Security Error: Archive member");
    });

    it("restore rejects archive containing symbolic links", () => {
      const backupDir = path.join(tempTestDir, "symlink_backups");
      fs.mkdirSync(backupDir, { recursive: true });

      const fakeBundle = path.join(backupDir, "lighthouse-backup-symlink.tar.gz");
      const fakeSha = `${fakeBundle}.sha256`;

      const stageDir = path.join(tempTestDir, "symlink_stage");
      fs.mkdirSync(stageDir, { recursive: true });
      fs.writeFileSync(path.join(stageDir, "manifest.json"), "{}");
      fs.symlinkSync("manifest.json", path.join(stageDir, "metadata.db"));
      spawnSync("tar", ["-czf", fakeBundle, "-C", stageDir, "."], { encoding: "utf8" });

      const shaRes = spawnSync("shasum", ["-a", "256", path.basename(fakeBundle)], {
        cwd: backupDir,
        encoding: "utf8",
      });
      fs.writeFileSync(fakeSha, shaRes.stdout);

      const res = spawnSync(LIGHTHOUSE_BIN, ["restore", fakeBundle, "--dry-run"], {
        encoding: "utf8",
      });
      expect(res.status).toBe(1);
      expect(res.stdout + res.stderr).toContain("Security Error: Archive contains symbolic links");
    });

    it("hermetic WAL restore: prevents WAL replay from overwriting restored data", () => {
      const sourceCalibre = path.join(tempTestDir, "src_calibre_wal", "metadata.db");
      const targetCalibre = path.join(tempTestDir, "tgt_calibre_wal", "metadata.db");
      const backupDir = path.join(tempTestDir, "wal_backups");

      fs.mkdirSync(path.dirname(sourceCalibre), { recursive: true });
      fs.mkdirSync(path.dirname(targetCalibre), { recursive: true });

      // 1. Create clean source DB with 1 book
      const sDb = new Database(sourceCalibre);
      sDb.run("CREATE TABLE books (id INTEGER PRIMARY KEY, title TEXT);");
      sDb.run("INSERT INTO books (title) VALUES ('Source Book Clean');");
      sDb.close();

      // Backup source
      const bRes = spawnSync(LIGHTHOUSE_BIN, ["backup", "--output-dir", backupDir], {
        encoding: "utf8",
        env: {
          ...process.env,
          CALIBRE_DB_PATH: sourceCalibre,
          KOSYNC_DB_PATH: path.join(tempTestDir, "dummy_ko.db"),
          CACHE_DB_PATH: path.join(tempTestDir, "dummy_cache.db"),
        },
      });
      expect(bRes.status).toBe(0);

      const files = fs.readdirSync(backupDir);
      const bundle = files.find((f: string) => f.startsWith("lighthouse-backup-") && !f.endsWith(".sha256"))!;
      const bundlePath = path.join(backupDir, bundle);

      // 2. Create target DB in WAL mode with uncheckpointed row in WAL journal
      const tDb = new Database(targetCalibre);
      tDb.run("PRAGMA journal_mode = WAL;");
      tDb.run("CREATE TABLE books (id INTEGER PRIMARY KEY, title TEXT);");
      tDb.run("INSERT INTO books (title) VALUES ('Dirty Pre-Restore Book in WAL');");
      tDb.close();

      // Verify -wal exists
      const walPath = `${targetCalibre}-wal`;
      if (!fs.existsSync(walPath)) {
        fs.writeFileSync(walPath, "dummy-wal-bytes");
      }

      // 3. Run restore over the active WAL database with isolated fake HOME
      const fakeHome = path.join(tempTestDir, "fake_home");
      fs.mkdirSync(fakeHome, { recursive: true });
      const rRes = spawnSync(
        LIGHTHOUSE_BIN,
        ["restore", bundlePath, "--force"],
        {
          encoding: "utf8",
          env: {
            ...process.env,
            HOME: fakeHome,
            CALIBRE_DB_PATH: targetCalibre,
            KOSYNC_DB_PATH: path.join(tempTestDir, "restored_ko.db"),
            CACHE_DB_PATH: path.join(tempTestDir, "restored_cache.db"),
          },
        },
      );
      expect(rRes.status).toBe(0);

      // Verify orphan wal and shm files were deleted and not left to corrupt/replay
      expect(fs.existsSync(targetCalibre)).toBe(true);
      const verifyDb = new Database(targetCalibre, { readonly: true });
      const books = verifyDb.query("SELECT title FROM books;").all() as any[];
      expect(books.length).toBe(1);
      expect(books[0].title).toBe("Source Book Clean");
      verifyDb.close();
    }, 30000);

    it("removes orphaned WAL/SHM sidecars even when destination main DB is missing", () => {
      const sourceCalibre = path.join(tempTestDir, "src_calibre_orphan", "metadata.db");
      const targetCalibre = path.join(tempTestDir, "tgt_calibre_orphan", "metadata.db");
      const backupDir = path.join(tempTestDir, "orphan_backups");

      fs.mkdirSync(path.dirname(sourceCalibre), { recursive: true });
      fs.mkdirSync(path.dirname(targetCalibre), { recursive: true });

      const sDb = new Database(sourceCalibre);
      sDb.run("CREATE TABLE books (id INTEGER PRIMARY KEY, title TEXT);");
      sDb.run("INSERT INTO books (title) VALUES ('Restored From Backup');");
      sDb.close();

      const bRes = spawnSync(LIGHTHOUSE_BIN, ["backup", "--output-dir", backupDir], {
        encoding: "utf8",
        env: {
          ...process.env,
          CALIBRE_DB_PATH: sourceCalibre,
          KOSYNC_DB_PATH: path.join(tempTestDir, "dummy_ko.db"),
          CACHE_DB_PATH: path.join(tempTestDir, "dummy_cache.db"),
        },
      });
      expect(bRes.status).toBe(0);

      const files = fs.readdirSync(backupDir);
      const bundle = files.find((f: string) => f.startsWith("lighthouse-backup-") && !f.endsWith(".sha256"))!;
      const bundlePath = path.join(backupDir, bundle);

      // Create target directory with NO metadata.db, but orphan -wal and -shm files
      fs.writeFileSync(`${targetCalibre}-wal`, "orphaned-wal-data");
      fs.writeFileSync(`${targetCalibre}-shm`, "orphaned-shm-data");
      expect(fs.existsSync(targetCalibre)).toBe(false);
      expect(fs.existsSync(`${targetCalibre}-wal`)).toBe(true);

      const rRes = spawnSync(
        LIGHTHOUSE_BIN,
        ["restore", bundlePath, "--force", "--target", path.dirname(targetCalibre)],
        {
          encoding: "utf8",
          env: {
            ...process.env,
            CALIBRE_DB_PATH: targetCalibre,
            KOSYNC_DB_PATH: path.join(tempTestDir, "restored_ko.db"),
            CACHE_DB_PATH: path.join(tempTestDir, "restored_cache.db"),
          },
        },
      );
      expect(rRes.status).toBe(0);

      // Verify orphan wal and shm files were deleted and not left to corrupt/replay
      expect(fs.existsSync(targetCalibre)).toBe(true);
      expect(fs.existsSync(`${targetCalibre}-wal`)).toBe(false);
      expect(fs.existsSync(`${targetCalibre}-shm`)).toBe(false);

      const verifyDb = new Database(targetCalibre, { readonly: true });
      const books = verifyDb.query("SELECT title FROM books;").all() as any[];
      expect(books.length).toBe(1);
      expect(books[0].title).toBe("Restored From Backup");
      verifyDb.close();
    }, 30000);

    it("daily backup produced by scripts/backup-daily.sh restores cleanly via bin/lighthouse restore", () => {
      const mockCalibre = path.join(tempTestDir, "daily_calibre", "metadata.db");
      const mockKosync = path.join(tempTestDir, "daily_kosync", "koreader-sync.db");
      const mockCache = path.join(tempTestDir, "daily_cache.db");
      const backupDir = path.join(tempTestDir, "daily_backups");
      const restoreDir = path.join(tempTestDir, "daily_restored");

      fs.mkdirSync(path.dirname(mockCalibre), { recursive: true });
      fs.mkdirSync(path.dirname(mockKosync), { recursive: true });
      fs.mkdirSync(restoreDir, { recursive: true });

      const cDb = new Database(mockCalibre);
      cDb.run("CREATE TABLE books (id INTEGER PRIMARY KEY, title TEXT);");
      cDb.run("INSERT INTO books (title) VALUES ('Daily Book A'), ('Daily Book B');");
      cDb.close();

      const kDb = new Database(mockKosync);
      kDb.run("CREATE TABLE progress (document TEXT PRIMARY KEY, percentage REAL);");
      kDb.run("INSERT INTO progress VALUES ('doc_daily', 0.99);");
      kDb.close();

      const chDb = new Database(mockCache);
      chDb.run("CREATE TABLE jobs (id INTEGER PRIMARY KEY, status TEXT);");
      chDb.run("INSERT INTO jobs (status) VALUES ('completed');");
      chDb.close();

      // 1. Run scripts/backup-daily.sh
      const dailyScript = path.join(REPO_ROOT, "scripts", "backup-daily.sh");
      const backupRes = spawnSync(dailyScript, [], {
        encoding: "utf8",
        env: {
          ...process.env,
          LOCAL_BACKUP_DIR: backupDir,
          CALIBRE_DB_PATH: mockCalibre,
          KOSYNC_DB_PATH: mockKosync,
          CACHE_DB_PATH: mockCache,
          LOG_DIR: path.join(tempTestDir, "daily_logs"),
        },
      });
      expect(backupRes.status).toBe(0);

      // Find the created backup archive
      const files = fs.readdirSync(backupDir);
      const bundle = files.find((f: string) => f.startsWith("reading-stack-backup-") && !f.endsWith(".sha256"));
      expect(bundle).toBeDefined();
      const bundlePath = path.join(backupDir, bundle!);

      // 2. Restore with bin/lighthouse restore --target
      const restoreRes = spawnSync(
        LIGHTHOUSE_BIN,
        ["restore", bundlePath, "--force", "--target", restoreDir],
        {
          encoding: "utf8",
          env: {
            ...process.env,
            CALIBRE_DB_PATH: path.join(restoreDir, "metadata.db"),
            KOSYNC_DB_PATH: path.join(restoreDir, "koreader-sync.db"),
            CACHE_DB_PATH: path.join(restoreDir, "cache.db"),
          },
        },
      );
      expect(restoreRes.status).toBe(0);
      expect(restoreRes.stdout).toContain("Restoration complete");

      // Verify restored content
      const rCdb = new Database(path.join(restoreDir, "metadata.db"), { readonly: true });
      const books = rCdb.query("SELECT title FROM books;").all() as any[];
      expect(books.length).toBe(2);
      rCdb.close();
    }, 30000);
  });

  describe("5. Standby Docker Compose Alignment", () => {
    it("docker-compose.yml uses synchronized paths and valid service definitions", () => {
      const composePath = path.join(REPO_ROOT, "docker-compose.yml");
      expect(fs.existsSync(composePath)).toBe(true);

      const content = fs.readFileSync(composePath, "utf8");
      // Must mount ./uploader, not ./src/uploader
      expect(content).toContain("${UPLOADER_DIR:-./uploader}:/app");
      expect(content).not.toContain("./src/uploader");

      // Must define core services
      expect(content).toContain("container_name: reading-hq");
      expect(content).toContain("container_name: reading-kosync");
      expect(content).toContain("container_name: reading-calibre-web");
      expect(content).toContain("container_name: reading-bot");

      // Verify compose syntax with docker compose config if docker is available
      const dockerCheck = spawnSync("docker", ["compose", "config"], {
        cwd: REPO_ROOT,
        encoding: "utf8",
      });
      if (dockerCheck.status === 0) {
        expect(dockerCheck.stdout).toContain("reading-hq");
      }
    });
  });

  describe("6. Shell Scripts Shellcheck & Syntax Hygiene", () => {
    const scriptsToLint = [
      LIGHTHOUSE_BIN,
      path.join(REPO_ROOT, "scripts", "backup-daily.sh"),
      path.join(REPO_ROOT, "scripts", "backup-ssd.sh"),
      path.join(REPO_ROOT, "scripts", "clean-duplicates.sh"),
      path.join(REPO_ROOT, "scripts", "migration-preflight.sh"),
      path.join(REPO_ROOT, "scripts", "sync-series-metadata.sh"),
      path.join(REPO_ROOT, "scripts", "tunnel-watchdog.sh"),
    ];

    it("passes bash -n syntax validation on all scripts", () => {
      for (const script of scriptsToLint) {
        const check = spawnSync("bash", ["-n", script]);
        expect(check.status).toBe(0);
      }
    });

    it("passes shellcheck cleanly when shellcheck is installed", () => {
      const whichShellcheck = spawnSync("which", ["shellcheck"]);
      if (whichShellcheck.status !== 0) {
        console.warn("[Skip] shellcheck binary not found on PATH in this environment.");
        return;
      }

      for (const script of scriptsToLint) {
        const lint = spawnSync("shellcheck", [script], { encoding: "utf8" });
        if (lint.status !== 0) {
          console.error(`Shellcheck failed on ${script}:\n${lint.stderr || lint.stdout}`);
        }
        expect(lint.status).toBe(0);
      }
    }, 30000);
  });

  describe("7. Tunnel Health & Watchdog Auto-Healing Invariants", () => {
    const watchdogScript = path.join(REPO_ROOT, "scripts", "tunnel-watchdog.sh");

    it("lighthouse health skips US tunnel healing when ENABLE_US_TUNNEL is unset or 0 even if probe returns 502 or 000", () => {
      const mockBinDir = fs.mkdtempSync(path.join(os.tmpdir(), "lh-health-mocks-"));
      const invocationLog = path.join(mockBinDir, "calls.log");

      // Stub ssh: record any call, but do not actually connect
      fs.writeFileSync(
        path.join(mockBinDir, "ssh"),
        `#!/bin/bash\necho "ssh: $@" >> "${invocationLog}"\nexit 0\n`,
        { mode: 0o755 },
      );
      // Stub launchctl: record kickstart/unload/load
      fs.writeFileSync(
        path.join(mockBinDir, "launchctl"),
        `#!/bin/bash\necho "launchctl: $@" >> "${invocationLog}"\nexit 0\n`,
        { mode: 0o755 },
      );
      // Stub curl: return 502 for US endpoint and 200 for others
      fs.writeFileSync(
        path.join(mockBinDir, "curl"),
        `#!/bin/bash
for arg in "$@"; do
  if [[ "$arg" == *"reading.wavypremium.xyz"* ]]; then
    printf "502"
    exit 0
  fi
done
printf "200"
exit 0
`,
        { mode: 0o755 },
      );
      // Stub nc to report listening ports for local services
      fs.writeFileSync(
        path.join(mockBinDir, "nc"),
        `#!/bin/bash\nexit 0\n`,
        { mode: 0o755 },
      );

      try {
        const res = spawnSync(LIGHTHOUSE_BIN, ["health"], {
          encoding: "utf8",
          env: {
            ...process.env,
            PATH: `${mockBinDir}:${process.env.PATH}`,
            ENABLE_US_TUNNEL: "0",
            US_WAN_HQ_URL: "https://reading.wavypremium.xyz",
            SG_OPDS_80_URL: "http://opds.wavypremium.xyz/opds",
          },
        });

        expect(res.status).toBe(0);
        expect(res.stdout).toContain("HTTP 502 WARN (Decommissioned, ENABLE_US_TUNNEL=0)");
        expect(res.stdout).toContain("Health check passed: All services healthy.");

        const calls = fs.existsSync(invocationLog) ? fs.readFileSync(invocationLog, "utf8") : "";
        expect(calls).not.toContain("panel");
        expect(calls).not.toContain("fuser -k");
        expect(calls).not.toContain("reading-vless-tunnel");
      } finally {
        fs.rmSync(mockBinDir, { recursive: true, force: true });
      }
    });

    it("lighthouse health skips US tunnel healing when ENABLE_US_TUNNEL is unset and probe returns 000", () => {
      const mockBinDir = fs.mkdtempSync(path.join(os.tmpdir(), "lh-health-mocks-"));
      const invocationLog = path.join(mockBinDir, "calls.log");

      fs.writeFileSync(
        path.join(mockBinDir, "ssh"),
        `#!/bin/bash\necho "ssh: $@" >> "${invocationLog}"\nexit 0\n`,
        { mode: 0o755 },
      );
      fs.writeFileSync(
        path.join(mockBinDir, "launchctl"),
        `#!/bin/bash\necho "launchctl: $@" >> "${invocationLog}"\nexit 0\n`,
        { mode: 0o755 },
      );
      fs.writeFileSync(
        path.join(mockBinDir, "curl"),
        `#!/bin/bash
for arg in "$@"; do
  if [[ "$arg" == *"reading.wavypremium.xyz"* ]]; then
    printf "000"
    exit 0
  fi
done
printf "200"
exit 0
`,
        { mode: 0o755 },
      );
      fs.writeFileSync(
        path.join(mockBinDir, "nc"),
        `#!/bin/bash\nexit 0\n`,
        { mode: 0o755 },
      );

      const cleanEnv = { ...process.env };
      delete cleanEnv.ENABLE_US_TUNNEL;

      try {
        const res = spawnSync(LIGHTHOUSE_BIN, ["health"], {
          encoding: "utf8",
          env: {
            ...cleanEnv,
            PATH: `${mockBinDir}:${process.env.PATH}`,
            US_WAN_HQ_URL: "https://reading.wavypremium.xyz",
            SG_OPDS_80_URL: "http://opds.wavypremium.xyz/opds",
          },
        });

        expect(res.status).toBe(0);
        expect(res.stdout).toContain("HTTP 000 WARN (Decommissioned, ENABLE_US_TUNNEL=0)");
        expect(res.stdout).toContain("Health check passed: All services healthy.");

        const calls = fs.existsSync(invocationLog) ? fs.readFileSync(invocationLog, "utf8") : "";
        expect(calls).not.toContain("panel");
        expect(calls).not.toContain("fuser -k");
        expect(calls).not.toContain("reading-vless-tunnel");
      } finally {
        fs.rmSync(mockBinDir, { recursive: true, force: true });
      }
    });

    it("lighthouse health reports healthy without healing when ENABLE_US_TUNNEL=1 and probe is 200", () => {
      const mockBinDir = fs.mkdtempSync(path.join(os.tmpdir(), "lh-health-mocks-"));
      const invocationLog = path.join(mockBinDir, "calls.log");

      fs.writeFileSync(
        path.join(mockBinDir, "ssh"),
        `#!/bin/bash\necho "ssh: $@" >> "${invocationLog}"\nexit 0\n`,
        { mode: 0o755 },
      );
      fs.writeFileSync(
        path.join(mockBinDir, "launchctl"),
        `#!/bin/bash\necho "launchctl: $@" >> "${invocationLog}"\nexit 0\n`,
        { mode: 0o755 },
      );
      fs.writeFileSync(
        path.join(mockBinDir, "curl"),
        `#!/bin/bash\nprintf "200"\nexit 0\n`,
        { mode: 0o755 },
      );
      fs.writeFileSync(
        path.join(mockBinDir, "nc"),
        `#!/bin/bash\nexit 0\n`,
        { mode: 0o755 },
      );

      try {
        const res = spawnSync(LIGHTHOUSE_BIN, ["health"], {
          encoding: "utf8",
          env: {
            ...process.env,
            PATH: `${mockBinDir}:${process.env.PATH}`,
            ENABLE_US_TUNNEL: "1",
            US_WAN_HQ_URL: "https://reading.wavypremium.xyz",
            SG_OPDS_80_URL: "http://opds.wavypremium.xyz/opds",
          },
        });

        expect(res.status).toBe(0);
        expect(res.stdout).toContain("Probing US WAN Endpoint (https://reading.wavypremium.xyz)... HTTP 200 OK");
        expect(res.stdout).toContain("Health check passed: All services healthy.");

        const calls = fs.existsSync(invocationLog) ? fs.readFileSync(invocationLog, "utf8") : "";
        expect(calls).not.toContain("panel");
        expect(calls).not.toContain("fuser -k");
        expect(calls).not.toContain("reading-vless-tunnel");
      } finally {
        fs.rmSync(mockBinDir, { recursive: true, force: true });
      }
    });

    it("tunnel watchdog accepts HTTP 302 on OPDS port 80 URL and 200/200/200 without triggering pkill or fuser -k", () => {
      const mockDir = fs.mkdtempSync(path.join(os.tmpdir(), "watchdog-probe-test-"));
      const tempLog = path.join(mockDir, "watchdog.log");
      const tempEnv = path.join(mockDir, ".env");
      const mockBinDir = path.join(mockDir, "bin");
      const invocationLog = path.join(mockDir, "calls.log");

      fs.mkdirSync(mockBinDir, { recursive: true });

      // Stub pkill
      fs.writeFileSync(
        path.join(mockBinDir, "pkill"),
        `#!/bin/bash\necho "pkill: $@" >> "${invocationLog}"\nexit 0\n`,
        { mode: 0o755 },
      );
      // Stub ssh
      fs.writeFileSync(
        path.join(mockBinDir, "ssh"),
        `#!/bin/bash\necho "ssh: $@" >> "${invocationLog}"\nexit 0\n`,
        { mode: 0o755 },
      );
      // Stub launchctl
      fs.writeFileSync(
        path.join(mockBinDir, "launchctl"),
        `#!/bin/bash\necho "launchctl: $@" >> "${invocationLog}"\nexit 0\n`,
        { mode: 0o755 },
      );
      // Stub curl: returns 200 for local, 302 for SG_OPDS_80, 200 for SG_OPDS_8443 and KOSync
      fs.writeFileSync(
        path.join(mockBinDir, "curl"),
        `#!/bin/bash
for arg in "$@"; do
  if [[ "$arg" == *"opds.wavypremium.xyz/opds"* && "$arg" == http://* ]]; then
    printf "302"
    exit 0
  fi
done
printf "200"
exit 0
`,
        { mode: 0o755 },
      );
      // Stub nc
      fs.writeFileSync(
        path.join(mockBinDir, "nc"),
        `#!/bin/bash\nexit 0\n`,
        { mode: 0o755 },
      );

      fs.writeFileSync(
        tempEnv,
        `ENABLE_US_TUNNEL=0
LOCAL_HTTP_PORT=8086
LOCAL_KOSYNC_PORT=7200
SG_REMOTE_HOST=sg-vps
SG_OPDS_80_URL=http://opds.wavypremium.xyz/opds
SG_OPDS_8443_URL=https://opds.wavypremium.xyz:8443/opds
SG_KOSYNC_URL=http://kosync-sg.wavypremium.xyz/health
`,
      );

      try {
        const res = spawnSync(watchdogScript, [], {
          encoding: "utf8",
          env: {
            ...process.env,
            PATH: `${mockBinDir}:${process.env.PATH}`,
            ENV_FILE: tempEnv,
            LOG_FILE: tempLog,
            SG_FAIL_COUNT_FILE: path.join(mockDir, "sg-fail"),
            SG_ALERT_TRACK_FILE: path.join(mockDir, "sg-alert"),
          },
        });

        expect(res.status).toBe(0);

        const calls = fs.existsSync(invocationLog) ? fs.readFileSync(invocationLog, "utf8") : "";
        expect(calls).not.toContain("pkill");
        expect(calls).not.toContain("fuser -k");
        expect(calls).not.toContain("kickstart");

        const logContent = fs.existsSync(tempLog) ? fs.readFileSync(tempLog, "utf8") : "";
        expect(logContent).not.toContain("health check failed");
      } finally {
        fs.rmSync(mockDir, { recursive: true, force: true });
      }
    });

    it("tunnel watchdog pkill pattern matches Singapore tunnel argv and does NOT match operator forward ssh -L", () => {
      const scriptContent = fs.readFileSync(watchdogScript, "utf8");
      // Find the pkill command used for Singapore tunnel
      const match = scriptContent.match(/pkill -f "([^"]+)"/g);
      expect(match).toBeDefined();

      // The Singapore pkill pattern
      const sgPkillLine = scriptContent
        .split("\n")
        .find((l) => l.includes("pkill -f") && l.includes("SG_REMOTE_HOST"));
      expect(sgPkillLine).toBeDefined();

      const patternMatch = sgPkillLine!.match(/pkill -f "([^"]+)"/);
      expect(patternMatch).toBeDefined();

      const rawPattern = patternMatch![1];
      // Convert bash regex to JS RegExp
      const jsRegexStr = rawPattern
        .replace(/\$\{LOCAL_HTTP_PORT\}/g, "8086")
        .replace(/\$\{SG_REMOTE_HOST\}/g, "sg-vps");
      const regex = new RegExp(jsRegexStr);

      // 1. Plist program arguments for com.ospeto.reading-sg-tunnel
      const tunnelCommand =
        "/usr/bin/ssh -N -R 127.0.0.1:8086:127.0.0.1:8086 -R 127.0.0.1:7200:127.0.0.1:7200 -o ServerAliveInterval=15 -o ServerAliveCountMax=3 -o ExitOnForwardFailure=yes -o BatchMode=yes -o ConnectTimeout=8 sg-vps";
      expect(regex.test(tunnelCommand)).toBe(true);

      // 2. Operator forward
      const operatorCommand = "ssh -L 8086:127.0.0.1:8086 user@sg-vps";
      expect(regex.test(operatorCommand)).toBe(false);
    });

    it("tunnel watchdog retries via proxy when direct probe returns 000 and proxy returns 200, avoiding auto-heal", () => {
      const mockDir = fs.mkdtempSync(path.join(os.tmpdir(), "watchdog-proxy-fallback-test-"));
      const tempLog = path.join(mockDir, "watchdog.log");
      const tempEnv = path.join(mockDir, ".env");
      const mockBinDir = path.join(mockDir, "bin");
      const invocationLog = path.join(mockDir, "calls.log");

      fs.mkdirSync(mockBinDir, { recursive: true });

      // Stub pkill
      fs.writeFileSync(
        path.join(mockBinDir, "pkill"),
        `#!/bin/bash\necho "pkill: $@" >> "${invocationLog}"\nexit 0\n`,
        { mode: 0o755 },
      );
      // Stub ssh
      fs.writeFileSync(
        path.join(mockBinDir, "ssh"),
        `#!/bin/bash\necho "ssh: $@" >> "${invocationLog}"\nexit 0\n`,
        { mode: 0o755 },
      );
      // Stub launchctl
      fs.writeFileSync(
        path.join(mockBinDir, "launchctl"),
        `#!/bin/bash\necho "launchctl: $@" >> "${invocationLog}"\nexit 0\n`,
        { mode: 0o755 },
      );
      // Stub nc: returns 0 (proxy reachable)
      fs.writeFileSync(
        path.join(mockBinDir, "nc"),
        `#!/bin/bash\nexit 0\n`,
        { mode: 0o755 },
      );
      // Stub curl:
      // If direct request to SG endpoints (no --proxy flag), return 000 (simulating ISP DPI block).
      // If --proxy flag is present, return 200 (healthy via proxy).
      // Local probes (127.0.0.1) return 200.
      fs.writeFileSync(
        path.join(mockBinDir, "curl"),
        `#!/bin/bash
has_proxy=0
is_sg=0
is_local=0
for arg in "$@"; do
  if [ "$arg" = "--proxy" ]; then
    has_proxy=1
  fi
  if [[ "$arg" == *"wavypremium.xyz"* ]]; then
    is_sg=1
  fi
  if [[ "$arg" == *"127.0.0.1"* ]]; then
    is_local=1
  fi
done

if [ "$is_local" -eq 1 ]; then
  printf "200"
  exit 0
fi

if [ "$is_sg" -eq 1 ]; then
  if [ "$has_proxy" -eq 1 ]; then
    printf "200"
  else
    printf "000"
  fi
  exit 0
fi

printf "200"
exit 0
`,
        { mode: 0o755 },
      );

      fs.writeFileSync(
        tempEnv,
        `ENABLE_US_TUNNEL=0
LOCAL_HTTP_PORT=8086
LOCAL_KOSYNC_PORT=7200
PROXY_URL=http://127.0.0.1:7890
SG_REMOTE_HOST=sg-vps
SG_OPDS_80_URL=http://opds.wavypremium.xyz/opds
SG_OPDS_8443_URL=https://opds.wavypremium.xyz:8443/opds
SG_KOSYNC_URL=http://kosync-sg.wavypremium.xyz/health
`,
      );

      try {
        const res = spawnSync(watchdogScript, [], {
          encoding: "utf8",
          env: {
            ...process.env,
            PATH: `${mockBinDir}:${process.env.PATH}`,
            ENV_FILE: tempEnv,
            LOG_FILE: tempLog,
            SG_FAIL_COUNT_FILE: path.join(mockDir, "sg-fail"),
            SG_ALERT_TRACK_FILE: path.join(mockDir, "sg-alert"),
          },
        });

        expect(res.status).toBe(0);

        const calls = fs.existsSync(invocationLog) ? fs.readFileSync(invocationLog, "utf8") : "";
        expect(calls).not.toContain("pkill");
        expect(calls).not.toContain("fuser -k");
        expect(calls).not.toContain("kickstart");

        const logContent = fs.existsSync(tempLog) ? fs.readFileSync(tempLog, "utf8") : "";
        expect(logContent).toContain("retrying via proxy");
        expect(logContent).not.toContain("health check failed");

        // Verify fail count remains 0
        const failCount = fs.readFileSync(path.join(mockDir, "sg-fail"), "utf8").trim();
        expect(failCount).toBe("0");
      } finally {
        fs.rmSync(mockDir, { recursive: true, force: true });
      }
    });

    it("tunnel watchdog records failure when both direct and proxy probes return 000", () => {
      const mockDir = fs.mkdtempSync(path.join(os.tmpdir(), "watchdog-proxy-fail-test-"));
      const tempLog = path.join(mockDir, "watchdog.log");
      const tempEnv = path.join(mockDir, ".env");
      const mockBinDir = path.join(mockDir, "bin");
      const invocationLog = path.join(mockDir, "calls.log");

      fs.mkdirSync(mockBinDir, { recursive: true });

      // Stub pkill
      fs.writeFileSync(
        path.join(mockBinDir, "pkill"),
        `#!/bin/bash\necho "pkill: $@" >> "${invocationLog}"\nexit 0\n`,
        { mode: 0o755 },
      );
      // Stub ssh
      fs.writeFileSync(
        path.join(mockBinDir, "ssh"),
        `#!/bin/bash\necho "ssh: $@" >> "${invocationLog}"\nexit 0\n`,
        { mode: 0o755 },
      );
      // Stub launchctl
      fs.writeFileSync(
        path.join(mockBinDir, "launchctl"),
        `#!/bin/bash\necho "launchctl: $@" >> "${invocationLog}"\nexit 0\n`,
        { mode: 0o755 },
      );
      // Stub nc: returns 0 (proxy reachable)
      fs.writeFileSync(
        path.join(mockBinDir, "nc"),
        `#!/bin/bash\nexit 0\n`,
        { mode: 0o755 },
      );
      // Stub curl:
      // Local probes return 200 (target URL contains 127.0.0.1 and not --proxy).
      // SG probes always return 000 (even with --proxy).
      fs.writeFileSync(
        path.join(mockBinDir, "curl"),
        `#!/bin/bash
has_proxy=0
for arg in "$@"; do
  if [ "$arg" = "--proxy" ]; then
    has_proxy=1
  fi
done

if [ "$has_proxy" -eq 0 ]; then
  for arg in "$@"; do
    if [[ "$arg" == *"127.0.0.1"* ]]; then
      printf "200"
      exit 0
    fi
  done
fi

printf "000"
exit 0
`,
        { mode: 0o755 },
      );

      fs.writeFileSync(
        tempEnv,
        `ENABLE_US_TUNNEL=0
LOCAL_HTTP_PORT=8086
LOCAL_KOSYNC_PORT=7200
PROXY_URL=http://127.0.0.1:7890
SG_REMOTE_HOST=sg-vps
SG_OPDS_80_URL=http://opds.wavypremium.xyz/opds
SG_OPDS_8443_URL=https://opds.wavypremium.xyz:8443/opds
SG_KOSYNC_URL=http://kosync-sg.wavypremium.xyz/health
`,
      );

      try {
        const res = spawnSync(watchdogScript, [], {
          encoding: "utf8",
          env: {
            ...process.env,
            PATH: `${mockBinDir}:${process.env.PATH}`,
            ENV_FILE: tempEnv,
            LOG_FILE: tempLog,
            SG_FAIL_COUNT_FILE: path.join(mockDir, "sg-fail"),
            SG_ALERT_TRACK_FILE: path.join(mockDir, "sg-alert"),
          },
        });

        expect(res.status).toBe(0);

        const calls = fs.existsSync(invocationLog) ? fs.readFileSync(invocationLog, "utf8") : "";
        expect(calls).toContain("pkill");
        expect(calls).toContain("fuser -k");

        const logContent = fs.existsSync(tempLog) ? fs.readFileSync(tempLog, "utf8") : "";
        expect(logContent).toContain("health check failed");

        // Verify fail count incremented to 1
        const failCount = fs.readFileSync(path.join(mockDir, "sg-fail"), "utf8").trim();
        expect(failCount).toBe("1");
      } finally {
        fs.rmSync(mockDir, { recursive: true, force: true });
      }
    }, 15000);

    it("bin/lighthouse health retries via proxy when direct probe returns 000 and marks endpoint healthy", () => {
      const mockBinDir = fs.mkdtempSync(path.join(os.tmpdir(), "lh-health-proxy-mocks-"));
      const invocationLog = path.join(mockBinDir, "calls.log");

      fs.writeFileSync(
        path.join(mockBinDir, "ssh"),
        `#!/bin/bash\necho "ssh: $@" >> "${invocationLog}"\nexit 0\n`,
        { mode: 0o755 },
      );
      fs.writeFileSync(
        path.join(mockBinDir, "launchctl"),
        `#!/bin/bash\necho "launchctl: $@" >> "${invocationLog}"\nexit 0\n`,
        { mode: 0o755 },
      );
      fs.writeFileSync(
        path.join(mockBinDir, "nc"),
        `#!/bin/bash\nexit 0\n`,
        { mode: 0o755 },
      );
      // Stub curl:
      // Direct SG request returns 000; when --proxy is passed, returns 200.
      fs.writeFileSync(
        path.join(mockBinDir, "curl"),
        `#!/bin/bash
has_proxy=0
for arg in "$@"; do
  if [ "$arg" = "--proxy" ]; then
    has_proxy=1
  fi
done

if [ "$has_proxy" -eq 1 ]; then
  printf "200"
else
  printf "000"
fi
exit 0
`,
        { mode: 0o755 },
      );

      try {
        const res = spawnSync(LIGHTHOUSE_BIN, ["health"], {
          encoding: "utf8",
          env: {
            ...process.env,
            PATH: `${mockBinDir}:${process.env.PATH}`,
            ENABLE_US_TUNNEL: "0",
            PROXY_PORT: "7890",
            SG_OPDS_80_URL: "http://opds.wavypremium.xyz/opds",
          },
        });

        expect(res.status).toBe(0);
        expect(res.stdout).toContain("Probing Singapore OPDS Endpoint (http://opds.wavypremium.xyz/opds)... HTTP 200 OK");
        expect(res.stdout).toContain("Health check passed: All services healthy.");

        const calls = fs.existsSync(invocationLog) ? fs.readFileSync(invocationLog, "utf8") : "";
        expect(calls).not.toContain("sg-vps");
        expect(calls).not.toContain("fuser -k");
        expect(calls).not.toContain("reading-sg-tunnel");
      } finally {
        fs.rmSync(mockBinDir, { recursive: true, force: true });
      }
    }, 15000);

    it("bin/lighthouse health fails and triggers auto-healing when both direct and proxy return 000", () => {
      const mockBinDir = fs.mkdtempSync(path.join(os.tmpdir(), "lh-health-proxy-fail-mocks-"));
      const invocationLog = path.join(mockBinDir, "calls.log");

      fs.writeFileSync(
        path.join(mockBinDir, "ssh"),
        `#!/bin/bash\necho "ssh: $@" >> "${invocationLog}"\nexit 0\n`,
        { mode: 0o755 },
      );
      fs.writeFileSync(
        path.join(mockBinDir, "launchctl"),
        `#!/bin/bash\necho "launchctl: $@" >> "${invocationLog}"\nexit 0\n`,
        { mode: 0o755 },
      );
      fs.writeFileSync(
        path.join(mockBinDir, "nc"),
        `#!/bin/bash\nexit 0\n`,
        { mode: 0o755 },
      );
      // Stub curl: always returns 000
      fs.writeFileSync(
        path.join(mockBinDir, "curl"),
        `#!/bin/bash\nprintf "000"\nexit 0\n`,
        { mode: 0o755 },
      );

      try {
        const res = spawnSync(LIGHTHOUSE_BIN, ["health"], {
          encoding: "utf8",
          env: {
            ...process.env,
            PATH: `${mockBinDir}:${process.env.PATH}`,
            ENABLE_US_TUNNEL: "0",
            PROXY_PORT: "7890",
            SG_OPDS_80_URL: "http://opds.wavypremium.xyz/opds",
          },
        });

        expect(res.status).toBe(1);
        expect(res.stdout).toContain("Probing Singapore OPDS Endpoint (http://opds.wavypremium.xyz/opds)... HTTP 000 FAIL");
        expect(res.stdout).toContain("Auto-healing SG Tunnel: clearing remote listeners on sg-vps...");

        const calls = fs.existsSync(invocationLog) ? fs.readFileSync(invocationLog, "utf8") : "";
        expect(calls).toContain("sg-vps");
        expect(calls).toContain("fuser -k");
        expect(calls).toContain("reading-sg-tunnel");
      } finally {
        fs.rmSync(mockBinDir, { recursive: true, force: true });
      }
    }, 15000);
  });

  describe("8. CLI Option Argument Validation & Pre-Side-Effect Bounds (U23)", () => {
    it("handles --help and -h cleanly for backup, install-daemons, and restore", () => {
      for (const cmd of ["backup", "install-daemons", "restore"]) {
        for (const flag of ["--help", "-h"]) {
          const res = spawnSync(LIGHTHOUSE_BIN, [cmd, flag], {
            encoding: "utf8",
            cwd: tempTestDir,
          });
          expect(res.status).toBe(0);
          expect(res.stdout).toContain(`Usage: bin/lighthouse ${cmd}`);
          expect(res.stderr).toBe("");
        }
      }
    });

    it("rejects absent, empty, and next-option arguments for install-daemons --output-dir with friendly diagnostics", () => {
      // 1. Missing argument (end of argv)
      const resMissing = spawnSync(LIGHTHOUSE_BIN, ["install-daemons", "--output-dir"], {
        encoding: "utf8",
        cwd: tempTestDir,
      });
      expect(resMissing.status).toBe(1);
      expect(resMissing.stderr).toContain("Error: --output-dir requires a non-empty directory path argument");
      expect(resMissing.stderr).not.toContain("unbound variable");

      // 2. Empty argument
      const resEmpty = spawnSync(LIGHTHOUSE_BIN, ["install-daemons", "--output-dir", ""], {
        encoding: "utf8",
        cwd: tempTestDir,
      });
      expect(resEmpty.status).toBe(1);
      expect(resEmpty.stderr).toContain("Error: --output-dir requires a non-empty directory path argument");

      // 3. Next option argument
      const resNext = spawnSync(LIGHTHOUSE_BIN, ["install-daemons", "--output-dir", "--dry-run"], {
        encoding: "utf8",
        cwd: tempTestDir,
      });
      expect(resNext.status).toBe(1);
      expect(resNext.stderr).toContain("Error: --output-dir requires a non-empty directory path argument");

      // 4. Unknown option
      const resUnknown = spawnSync(LIGHTHOUSE_BIN, ["install-daemons", "--bogus-flag"], {
        encoding: "utf8",
        cwd: tempTestDir,
      });
      expect(resUnknown.status).toBe(1);
      expect(resUnknown.stderr).toContain("Unknown option for install-daemons: --bogus-flag");
    });

    it("accepts legitimate quoted paths with spaces for install-daemons --output-dir", () => {
      const quotedDir = path.join(tempTestDir, "custom agents dir with spaces");
      const res = spawnSync(
        LIGHTHOUSE_BIN,
        ["install-daemons", "--dry-run", "--output-dir", quotedDir],
        {
          encoding: "utf8",
          cwd: REPO_ROOT,
        },
      );
      expect(res.status).toBe(0);
      expect(fs.existsSync(quotedDir)).toBe(true);
      const generated = fs.readdirSync(quotedDir);
      expect(generated.length).toBe(7);
      expect(generated.some((f: string) => f.includes("book-uploader"))).toBe(true);
    });

    it("rejects absent, empty, and next-option arguments for backup options with friendly diagnostics", () => {
      // 1. --output missing
      const resOutMissing = spawnSync(LIGHTHOUSE_BIN, ["backup", "--output"], {
        encoding: "utf8",
        cwd: tempTestDir,
      });
      expect(resOutMissing.status).toBe(1);
      expect(resOutMissing.stderr).toContain("Error: --output requires a non-empty file path argument");
      expect(resOutMissing.stderr).not.toContain("unbound variable");

      // 2. -o missing
      const resShortMissing = spawnSync(LIGHTHOUSE_BIN, ["backup", "-o"], {
        encoding: "utf8",
        cwd: tempTestDir,
      });
      expect(resShortMissing.status).toBe(1);
      expect(resShortMissing.stderr).toContain("Error: --output requires a non-empty file path argument");

      // 3. --output empty
      const resOutEmpty = spawnSync(LIGHTHOUSE_BIN, ["backup", "--output", ""], {
        encoding: "utf8",
        cwd: tempTestDir,
      });
      expect(resOutEmpty.status).toBe(1);
      expect(resOutEmpty.stderr).toContain("Error: --output requires a non-empty file path argument");

      // 4. --output followed by another flag
      const resOutNext = spawnSync(LIGHTHOUSE_BIN, ["backup", "--output", "--output-dir"], {
        encoding: "utf8",
        cwd: tempTestDir,
      });
      expect(resOutNext.status).toBe(1);
      expect(resOutNext.stderr).toContain("Error: --output requires a non-empty file path argument");

      // 5. --output-dir missing
      const resDirMissing = spawnSync(LIGHTHOUSE_BIN, ["backup", "--output-dir"], {
        encoding: "utf8",
        cwd: tempTestDir,
      });
      expect(resDirMissing.status).toBe(1);
      expect(resDirMissing.stderr).toContain("Error: --output-dir requires a non-empty directory path argument");
      expect(resDirMissing.stderr).not.toContain("unbound variable");

      // 6. --output-dir empty
      const resDirEmpty = spawnSync(LIGHTHOUSE_BIN, ["backup", "--output-dir", ""], {
        encoding: "utf8",
        cwd: tempTestDir,
      });
      expect(resDirEmpty.status).toBe(1);
      expect(resDirEmpty.stderr).toContain("Error: --output-dir requires a non-empty directory path argument");

      // 7. --output-dir followed by another flag
      const resDirNext = spawnSync(LIGHTHOUSE_BIN, ["backup", "--output-dir", "--output"], {
        encoding: "utf8",
        cwd: tempTestDir,
      });
      expect(resDirNext.status).toBe(1);
      expect(resDirNext.stderr).toContain("Error: --output-dir requires a non-empty directory path argument");

      // 8. Unknown option
      const resUnknown = spawnSync(LIGHTHOUSE_BIN, ["backup", "--invalid-option"], {
        encoding: "utf8",
        cwd: tempTestDir,
      });
      expect(resUnknown.status).toBe(1);
      expect(resUnknown.stderr).toContain("Unknown option for backup: --invalid-option");
    });

    it("accepts legitimate quoted paths for backup --output-dir and --output", () => {
      const backupDir = path.join(tempTestDir, "custom backup destination with spaces");
      const mockCalibre = path.join(tempTestDir, "source", "metadata.db");
      const mockEnv = path.join(tempTestDir, "source", ".env");
      fs.mkdirSync(path.dirname(mockCalibre), { recursive: true });

      const cDb = new Database(mockCalibre);
      cDb.run("CREATE TABLE books (id INTEGER PRIMARY KEY, title TEXT);");
      cDb.run("INSERT INTO books (title) VALUES ('Book A');");
      cDb.close();
      fs.writeFileSync(mockEnv, "READING_API_KEY=test_key\n");

      const res = spawnSync(
        LIGHTHOUSE_BIN,
        ["backup", "--output-dir", backupDir],
        {
          encoding: "utf8",
          env: {
            ...process.env,
            CALIBRE_DB_PATH: mockCalibre,
            KOSYNC_DB_PATH: path.join(tempTestDir, "nonexistent-kosync.db"),
            CACHE_DB_PATH: path.join(tempTestDir, "nonexistent-cache.db"),
            ENV_FILE: mockEnv,
          },
        },
      );
      expect(res.status).toBe(0);
      expect(fs.existsSync(backupDir)).toBe(true);
      const files = fs.readdirSync(backupDir);
      expect(files.some((f: string) => f.startsWith("lighthouse-backup-"))).toBe(true);
    });

    it("rejects absent, empty, and next-option arguments for restore --target and missing bundle", () => {
      const fakeBundle = path.join(tempTestDir, "fake-backup.tar.gz");
      fs.writeFileSync(fakeBundle, "not a real tar");

      // 1. Restore without arguments prints usage
      const resNoArgs = spawnSync(LIGHTHOUSE_BIN, ["restore"], {
        encoding: "utf8",
        cwd: tempTestDir,
      });
      expect(resNoArgs.status).toBe(1);
      expect(resNoArgs.stderr).toContain("Usage: bin/lighthouse restore");

      // 2. Restore with only options and no bundle file
      const resNoBundle = spawnSync(LIGHTHOUSE_BIN, ["restore", "--target", tempTestDir], {
        encoding: "utf8",
        cwd: tempTestDir,
      });
      expect(resNoBundle.status).toBe(1);
      expect(resNoBundle.stderr).toContain("Error: Missing required backup bundle file argument");

      // 3. --target missing argument
      const resMissing = spawnSync(LIGHTHOUSE_BIN, ["restore", fakeBundle, "--target"], {
        encoding: "utf8",
        cwd: tempTestDir,
      });
      expect(resMissing.status).toBe(1);
      expect(resMissing.stderr).toContain("Error: --target requires a non-empty directory path argument");
      expect(resMissing.stderr).not.toContain("unbound variable");

      // 4. --target empty argument
      const resEmpty = spawnSync(LIGHTHOUSE_BIN, ["restore", fakeBundle, "--target", ""], {
        encoding: "utf8",
        cwd: tempTestDir,
      });
      expect(resEmpty.status).toBe(1);
      expect(resEmpty.stderr).toContain("Error: --target requires a non-empty directory path argument");

      // 5. --target next option argument
      const resNext = spawnSync(LIGHTHOUSE_BIN, ["restore", fakeBundle, "--target", "--dry-run"], {
        encoding: "utf8",
        cwd: tempTestDir,
      });
      expect(resNext.status).toBe(1);
      expect(resNext.stderr).toContain("Error: --target requires a non-empty directory path argument");

      // 6. Unknown option
      const resUnknown = spawnSync(LIGHTHOUSE_BIN, ["restore", fakeBundle, "--bogus-opt"], {
        encoding: "utf8",
        cwd: tempTestDir,
      });
      expect(resUnknown.status).toBe(1);
      expect(resUnknown.stderr).toContain("Unknown option for restore: --bogus-opt");
    });

    it("ensures simultaneous malformed commands produce zero writes or side effects", () => {
      const cleanMonitoredDir = path.join(tempTestDir, "isolated-monitored-clean");
      fs.mkdirSync(cleanMonitoredDir, { recursive: true });

      const malformedCmds = [
        ["install-daemons", "--output-dir"],
        ["install-daemons", "--output-dir", ""],
        ["install-daemons", "--output-dir", "--dry-run"],
        ["backup", "--output"],
        ["backup", "-o", ""],
        ["backup", "--output-dir"],
        ["backup", "--output-dir", ""],
        ["backup", "--output-dir", "--output"],
        ["restore", "--target"],
        ["restore", path.join(cleanMonitoredDir, "fake.tar.gz"), "--target"],
        ["restore", path.join(cleanMonitoredDir, "fake.tar.gz"), "--target", ""],
        ["restore", path.join(cleanMonitoredDir, "fake.tar.gz"), "--target", "--dry-run"],
      ];

      // Run all simultaneously
      const results = malformedCmds.map((args) =>
        spawnSync(LIGHTHOUSE_BIN, args, {
          encoding: "utf8",
          cwd: cleanMonitoredDir,
        })
      );

      // Verify all failed cleanly with exit code 1 and bounded friendly diagnostic
      for (let i = 0; i < results.length; i++) {
        const res = results[i];
        expect(res.status).toBe(1);
        expect(res.stderr.length).toBeGreaterThan(0);
        expect(res.stderr).not.toContain("unbound variable");
      }

      // Assert zero writes: clean directory must remain completely empty
      const contents = fs.readdirSync(cleanMonitoredDir);
      expect(contents.length).toBe(0);
    });
  });

  describe("9. Optional Schema Restore & Verification Invariants (U13)", () => {
    it("restores cleanly when optional jobs table is absent, verifying highlights and file_hashes content", () => {
      const stageDir = path.join(tempTestDir, "no_jobs_stage");
      const backupDir = path.join(tempTestDir, "no_jobs_backup");
      const restoreDir = path.join(tempTestDir, "no_jobs_restore");
      fs.mkdirSync(stageDir, { recursive: true });
      fs.mkdirSync(backupDir, { recursive: true });
      fs.mkdirSync(restoreDir, { recursive: true });

      // 1. Create metadata.db with books
      const cDb = new Database(path.join(stageDir, "metadata.db"));
      cDb.run("CREATE TABLE books (id INTEGER PRIMARY KEY, title TEXT);");
      cDb.run("INSERT INTO books (title) VALUES ('Hyperion'), ('Endymion');");
      cDb.close();

      // 2. Create koreader-sync.db with progress
      const kDb = new Database(path.join(stageDir, "koreader-sync.db"));
      kDb.run("CREATE TABLE progress (document TEXT PRIMARY KEY, percentage REAL);");
      kDb.run("INSERT INTO progress VALUES ('doc_hyperion', 0.88);");
      kDb.close();

      // 3. Create cache.db with highlights and file_hashes, but WITHOUT jobs table
      const chDb = new Database(path.join(stageDir, "cache.db"));
      chDb.run("CREATE TABLE highlights (id INTEGER PRIMARY KEY, quote TEXT);");
      chDb.run("INSERT INTO highlights (quote) VALUES ('Quote Alpha'), ('Quote Beta');");
      chDb.run("CREATE TABLE file_hashes (filepath TEXT PRIMARY KEY, hash TEXT);");
      chDb.run("INSERT INTO file_hashes (filepath, hash) VALUES ('/books/vol1.epub', 'sha256_mock_hash_123');");
      chDb.close();

      fs.writeFileSync(
        path.join(stageDir, "manifest.json"),
        JSON.stringify({
          version: "1.0.0",
          databases: { calibre: { books: 2 }, kosync: { progress: 1 }, cache: { jobs: 0 } },
        }),
      );

      // Package tarball bundle
      const bundlePath = path.join(backupDir, "lighthouse-backup-no-jobs.tar.gz");
      const bundleSha = `${bundlePath}.sha256`;
      spawnSync("tar", ["-czf", bundlePath, "-C", stageDir, "."], { encoding: "utf8" });
      const shaRes = spawnSync("shasum", ["-a", "256", path.basename(bundlePath)], {
        cwd: backupDir,
        encoding: "utf8",
      });
      fs.writeFileSync(bundleSha, shaRes.stdout);

      // Restore bundle into target directory
      const res = spawnSync(
        LIGHTHOUSE_BIN,
        ["restore", bundlePath, "--force", "--target", restoreDir],
        { encoding: "utf8" },
      );
      expect(res.status).toBe(0);
      expect(res.stdout).toContain("Restoration complete");
      expect(res.stdout).toContain("Restored Cache DB");

      // Verify readback of data-bearing tables
      const rCdb = new Database(path.join(restoreDir, "metadata.db"), { readonly: true });
      const books = rCdb.query("SELECT title FROM books ORDER BY id;").all() as any[];
      expect(books.length).toBe(2);
      expect(books[0].title).toBe("Hyperion");
      rCdb.close();

      const rKdb = new Database(path.join(restoreDir, "koreader-sync.db"), { readonly: true });
      const progress = rKdb.query("SELECT percentage FROM progress WHERE document = 'doc_hyperion';").get() as any;
      expect(progress.percentage).toBe(0.88);
      rKdb.close();

      const rChDb = new Database(path.join(restoreDir, "cache.db"), { readonly: true });
      const hl = rChDb.query("SELECT quote FROM highlights ORDER BY id;").all() as any[];
      expect(hl.length).toBe(2);
      expect(hl[0].quote).toBe("Quote Alpha");
      expect(hl[1].quote).toBe("Quote Beta");

      const hashes = rChDb.query("SELECT hash FROM file_hashes;").all() as any[];
      expect(hashes.length).toBe(1);
      expect(hashes[0].hash).toBe("sha256_mock_hash_123");

      // Verify jobs table was not spuriously created
      const jobsTable = rChDb.query("SELECT count(*) as count FROM sqlite_master WHERE type='table' AND name='jobs';").get() as any;
      expect(jobsTable.count).toBe(0);
      rChDb.close();
    }, 30000);

    it("restores cleanly when jobs table is present with data or empty", () => {
      const backupDir = path.join(tempTestDir, "jobs_backups");
      fs.mkdirSync(backupDir, { recursive: true });

      // Case A: jobs present with data
      const stageA = path.join(tempTestDir, "jobs_stage_a");
      const restoreA = path.join(tempTestDir, "jobs_restore_a");
      fs.mkdirSync(stageA, { recursive: true });
      fs.mkdirSync(restoreA, { recursive: true });

      const cA = new Database(path.join(stageA, "metadata.db"));
      cA.run("CREATE TABLE books (id INTEGER PRIMARY KEY, title TEXT);");
      cA.run("INSERT INTO books (title) VALUES ('Book A');");
      cA.close();

      const chA = new Database(path.join(stageA, "cache.db"));
      chA.run("CREATE TABLE jobs (id INTEGER PRIMARY KEY, status TEXT);");
      chA.run("INSERT INTO jobs (status) VALUES ('completed'), ('pending');");
      chA.run("CREATE TABLE highlights (id INTEGER PRIMARY KEY, quote TEXT);");
      chA.run("INSERT INTO highlights (quote) VALUES ('Quote In A');");
      chA.close();

      const bundleA = path.join(backupDir, "bundle-a.tar.gz");
      spawnSync("tar", ["-czf", bundleA, "-C", stageA, "."], { encoding: "utf8" });
      const shaResA = spawnSync("shasum", ["-a", "256", path.basename(bundleA)], {
        cwd: backupDir,
        encoding: "utf8",
      });
      fs.writeFileSync(`${bundleA}.sha256`, shaResA.stdout);

      const resA = spawnSync(
        LIGHTHOUSE_BIN,
        ["restore", bundleA, "--force", "--target", restoreA],
        { encoding: "utf8" },
      );
      expect(resA.status).toBe(0);
      expect(resA.stdout).toContain("Restoration complete");

      const rChA = new Database(path.join(restoreA, "cache.db"), { readonly: true });
      const jobsA = rChA.query("SELECT status FROM jobs ORDER BY id;").all() as any[];
      expect(jobsA.length).toBe(2);
      expect(jobsA[0].status).toBe("completed");
      expect(jobsA[1].status).toBe("pending");
      rChA.close();

      // Case B: jobs table present but empty (0 rows)
      const stageB = path.join(tempTestDir, "jobs_stage_b");
      const restoreB = path.join(tempTestDir, "jobs_restore_b");
      fs.mkdirSync(stageB, { recursive: true });
      fs.mkdirSync(restoreB, { recursive: true });

      const cB = new Database(path.join(stageB, "metadata.db"));
      cB.run("CREATE TABLE books (id INTEGER PRIMARY KEY, title TEXT);");
      cB.run("INSERT INTO books (title) VALUES ('Book B');");
      cB.close();

      const chB = new Database(path.join(stageB, "cache.db"));
      chB.run("CREATE TABLE jobs (id INTEGER PRIMARY KEY, status TEXT);");
      chB.run("CREATE TABLE highlights (id INTEGER PRIMARY KEY, quote TEXT);");
      chB.run("INSERT INTO highlights (quote) VALUES ('Quote In B');");
      chB.close();

      const bundleB = path.join(backupDir, "bundle-b.tar.gz");
      spawnSync("tar", ["-czf", bundleB, "-C", stageB, "."], { encoding: "utf8" });
      const shaResB = spawnSync("shasum", ["-a", "256", path.basename(bundleB)], {
        cwd: backupDir,
        encoding: "utf8",
      });
      fs.writeFileSync(`${bundleB}.sha256`, shaResB.stdout);

      const resB = spawnSync(
        LIGHTHOUSE_BIN,
        ["restore", bundleB, "--force", "--target", restoreB],
        { encoding: "utf8" },
      );
      expect(resB.status).toBe(0);
      expect(resB.stdout).toContain("Restoration complete");

      const rChB = new Database(path.join(restoreB, "cache.db"), { readonly: true });
      const jobsB = rChB.query("SELECT count(*) as cnt FROM jobs;").get() as any[];
      expect((jobsB as any).cnt).toBe(0);
      rChB.close();
    }, 30000);

    it("handles optional jobs count metadata during backup command", () => {
      const backupDir = path.join(tempTestDir, "meta_backups");
      fs.mkdirSync(backupDir, { recursive: true });

      // 1. Backup cache.db WITHOUT jobs table
      const mockCacheNoJobs = path.join(tempTestDir, "cache_no_jobs.db");
      const db1 = new Database(mockCacheNoJobs);
      db1.run("CREATE TABLE highlights (quote TEXT);");
      db1.run("INSERT INTO highlights VALUES ('Single Quote');");
      db1.close();

      const resNoJobs = spawnSync(
        LIGHTHOUSE_BIN,
        ["backup", "--output-dir", backupDir],
        {
          encoding: "utf8",
          env: {
            ...process.env,
            CACHE_DB_PATH: mockCacheNoJobs,
            CALIBRE_DB_PATH: path.join(tempTestDir, "absent_calibre.db"),
            KOSYNC_DB_PATH: path.join(tempTestDir, "absent_kosync.db"),
          },
        },
      );
      expect(resNoJobs.status).toBe(0);
      expect(resNoJobs.stdout).toContain("jobs table optional/absent");

      // Verify manifest.json has jobs: 0
      const files1 = fs.readdirSync(backupDir).filter((f: string) => f.endsWith(".tar.gz"));
      expect(files1.length).toBeGreaterThan(0);
      const manifestRes1 = spawnSync("tar", ["-xzf", path.join(backupDir, files1[0]), "-O", "manifest.json"], {
        encoding: "utf8",
      });
      expect(manifestRes1.status).toBe(0);
      const manifest1 = JSON.parse(manifestRes1.stdout);
      expect(manifest1.databases.cache.jobs).toBe(0);

      // 2. Backup cache.db WITH jobs table
      const backupDir2 = path.join(tempTestDir, "meta_backups_with_jobs");
      fs.mkdirSync(backupDir2, { recursive: true });
      const mockCacheWithJobs = path.join(tempTestDir, "cache_with_jobs.db");
      const db2 = new Database(mockCacheWithJobs);
      db2.run("CREATE TABLE jobs (id INTEGER PRIMARY KEY, status TEXT);");
      db2.run("INSERT INTO jobs VALUES (1, 'done'), (2, 'pending');");
      db2.close();

      const resWithJobs = spawnSync(
        LIGHTHOUSE_BIN,
        ["backup", "--output-dir", backupDir2],
        {
          encoding: "utf8",
          env: {
            ...process.env,
            CACHE_DB_PATH: mockCacheWithJobs,
            CALIBRE_DB_PATH: path.join(tempTestDir, "absent_calibre.db"),
            KOSYNC_DB_PATH: path.join(tempTestDir, "absent_kosync.db"),
          },
        },
      );
      expect(resWithJobs.status).toBe(0);
      expect(resWithJobs.stdout).toContain("2 jobs");

      const files2 = fs.readdirSync(backupDir2).filter((f: string) => f.endsWith(".tar.gz"));
      const manifestRes2 = spawnSync("tar", ["-xzf", path.join(backupDir2, files2[0]), "-O", "manifest.json"], {
        encoding: "utf8",
      });
      const manifest2 = JSON.parse(manifestRes2.stdout);
      expect(manifest2.databases.cache.jobs).toBe(2);
    });

    it("fails restoration and never coerces SQL error to success when present table query errors", () => {
      const testDir = path.join(tempTestDir, "query_error_lab");
      const mockBinDir = path.join(testDir, "mock_bin");
      fs.mkdirSync(path.join(testDir, "src"), { recursive: true });
      fs.mkdirSync(path.join(testDir, "dest"), { recursive: true });
      fs.mkdirSync(mockBinDir, { recursive: true });

      const srcDb = path.join(testDir, "src", "cache.db");
      const destDb = path.join(testDir, "dest", "cache.db");

      // Case 1: highlights table is present, but querying record count fails with simulated SQL error
      const s1 = new Database(srcDb);
      s1.run("CREATE TABLE highlights (id INTEGER PRIMARY KEY, quote TEXT);");
      s1.run("INSERT INTO highlights VALUES (1, 'Quote In DB');");
      s1.close();

      const mockSqlite = path.join(mockBinDir, "sqlite3");
      fs.writeFileSync(
        mockSqlite,
        `#!/bin/bash
real_bin=$(type -a -p sqlite3 | grep -v "$0" | head -n1)
if [[ "$*" == *"SELECT count(*) FROM \\"highlights\\""* ]]; then
  echo "Error: simulated SQL error on highlights table" >&2
  exit 1
fi
exec "$real_bin" "$@"
`,
      );
      fs.chmodSync(mockSqlite, 0o755);

      const res1 = spawnSync(
        "bash",
        ["-c", `LIGHTHOUSE_SOURCE_ONLY=1 source "${LIGHTHOUSE_BIN}"; restore_single_db "${srcDb}" "${destDb}" "" "20261009_120000" "Cache DB"`],
        {
          encoding: "utf8",
          env: { ...process.env, PATH: `${mockBinDir}:${process.env.PATH}` },
        },
      );
      expect(res1.status).toBe(1);
      expect(res1.stderr).toContain("Error: Failed to query record count for table 'highlights'");
      expect(res1.stdout).not.toContain("Restored Cache DB");

      // Case 2: jobs table is present, but primary count_sql query fails
      const s2 = new Database(srcDb);
      s2.run("CREATE TABLE jobs (id INTEGER PRIMARY KEY, status TEXT);");
      s2.run("INSERT INTO jobs VALUES (1, 'pending');");
      s2.close();

      fs.writeFileSync(
        mockSqlite,
        `#!/bin/bash
real_bin=$(type -a -p sqlite3 | grep -v "$0" | head -n1)
if [[ "$*" == *"SELECT count(*) FROM jobs;"* ]]; then
  echo "Error: simulated failure on jobs table query" >&2
  exit 1
fi
exec "$real_bin" "$@"
`,
      );
      fs.chmodSync(mockSqlite, 0o755);

      const res2 = spawnSync(
        "bash",
        ["-c", `LIGHTHOUSE_SOURCE_ONLY=1 source "${LIGHTHOUSE_BIN}"; restore_single_db "${srcDb}" "${destDb}" "SELECT count(*) FROM jobs;" "20261009_120000" "Cache DB"`],
        {
          encoding: "utf8",
          env: { ...process.env, PATH: `${mockBinDir}:${process.env.PATH}` },
        },
      );
      expect(res2.status).toBe(1);
      expect(res2.stderr).toContain("Error: Query failed on source Cache DB");
      expect(res2.stdout).not.toContain("Restored Cache DB");
    });

    it("detects same-count differing content in data-bearing tables and rejects restoration", () => {
      // Test that content verification in restore_single_db rejects same-count differing content
      const testDir = path.join(tempTestDir, "content_mismatch_lab");
      const mockBinDir = path.join(testDir, "mock_bin");
      fs.mkdirSync(path.join(testDir, "src"), { recursive: true });
      fs.mkdirSync(path.join(testDir, "dest"), { recursive: true });
      fs.mkdirSync(mockBinDir, { recursive: true });

      const srcDb = path.join(testDir, "src", "cache.db");
      const destDb = path.join(testDir, "dest", "cache.db");

      const s = new Database(srcDb);
      s.run("CREATE TABLE highlights (id INTEGER PRIMARY KEY, quote TEXT);");
      s.run("INSERT INTO highlights VALUES (1, 'Legitimate Source Quote');");
      s.close();

      const mockSqlite = path.join(mockBinDir, "sqlite3");
      fs.writeFileSync(
        mockSqlite,
        `#!/bin/bash
real_bin=$(type -a -p sqlite3 | grep -v "$0" | head -n1)
if [[ "$*" == *".restore"* ]]; then
  "$real_bin" "$1" "CREATE TABLE highlights (id INTEGER PRIMARY KEY, quote TEXT); INSERT INTO highlights VALUES (1, 'Tampered Dest Quote');"
  exit 0
fi
exec "$real_bin" "$@"
`,
      );
      fs.chmodSync(mockSqlite, 0o755);

      const res = spawnSync(
        "bash",
        ["-c", `LIGHTHOUSE_SOURCE_ONLY=1 source "${LIGHTHOUSE_BIN}"; restore_single_db "${srcDb}" "${destDb}" "SELECT count(*) FROM jobs;" "20261009_120000" "Cache DB"`],
        {
          encoding: "utf8",
          env: { ...process.env, PATH: `${mockBinDir}:${process.env.PATH}` },
        },
      );
      expect(res.status).toBe(1);
      expect(res.stderr).toContain("Error: Content mismatch on restored Cache DB table 'highlights'");
    });

    it("preserves complete rollback snapshots and fails without reporting success on interrupted copy", () => {
      const testDir = path.join(tempTestDir, "interrupted_copy_lab");
      const mockBinDir = path.join(testDir, "mock_bin");
      fs.mkdirSync(path.join(testDir, "src"), { recursive: true });
      fs.mkdirSync(path.join(testDir, "dest"), { recursive: true });
      fs.mkdirSync(mockBinDir, { recursive: true });

      const srcDb = path.join(testDir, "src", "metadata.db");
      const destDb = path.join(testDir, "dest", "metadata.db");

      // Pre-existing destination database with original content
      const d = new Database(destDb);
      d.run("CREATE TABLE books (id INTEGER PRIMARY KEY, title TEXT);");
      d.run("INSERT INTO books VALUES (1, 'Precious Original Book');");
      d.close();

      // Source database to restore
      const s = new Database(srcDb);
      s.run("CREATE TABLE books (id INTEGER PRIMARY KEY, title TEXT);");
      s.run("INSERT INTO books VALUES (1, 'New Incoming Book');");
      s.close();

      const mockSqlite = path.join(mockBinDir, "sqlite3");
      fs.writeFileSync(
        mockSqlite,
        `#!/bin/bash
real_bin=$(type -a -p sqlite3 | grep -v "$0" | head -n1)
if [[ "$*" == *".restore"* ]]; then
  exit 1
fi
exec "$real_bin" "$@"
`,
      );
      fs.chmodSync(mockSqlite, 0o755);

      const res = spawnSync(
        "bash",
        ["-c", `LIGHTHOUSE_SOURCE_ONLY=1 source "${LIGHTHOUSE_BIN}"; restore_single_db "${srcDb}" "${destDb}" "SELECT count(*) FROM books;" "20261009_999999" "Calibre DB"`],
        {
          encoding: "utf8",
          env: { ...process.env, PATH: `${mockBinDir}:${process.env.PATH}` },
        },
      );
      expect(res.status).toBe(1);
      expect(res.stderr).toContain("Error: Failed to restore Calibre DB: .restore command failed");
      expect(res.stdout).not.toContain("Restoration complete");

      // Verify that rollback backup file exists and contains the precious original data
      const rollbackFile = `${destDb}.bak.20261009_999999`;
      expect(fs.existsSync(rollbackFile)).toBe(true);

      const rDb = new Database(rollbackFile, { readonly: true });
      const books = rDb.query("SELECT title FROM books;").all() as any[];
      expect(books.length).toBe(1);
      expect(books[0].title).toBe("Precious Original Book");
      rDb.close();
    });

    it("rejects identical source and destination paths to prevent unlinking source", () => {
      const sameDb = path.join(tempTestDir, "same_path.db");
      const d = new Database(sameDb);
      d.run("CREATE TABLE books (id INTEGER PRIMARY KEY, title TEXT);");
      d.run("INSERT INTO books VALUES (1, 'Preserve Me');");
      d.close();

      const res = spawnSync(
        "bash",
        ["-c", `LIGHTHOUSE_SOURCE_ONLY=1 source "${LIGHTHOUSE_BIN}"; restore_single_db "${sameDb}" "${sameDb}" "SELECT count(*) FROM books;" "20261009_120000" "Calibre DB"`],
        { encoding: "utf8" },
      );
      expect(res.status).toBe(1);
      expect(res.stderr).toContain("Error: Source and destination cannot be the same file");

      // Verify file was NOT unlinked or destroyed
      expect(fs.existsSync(sameDb)).toBe(true);
      const verifyDb = new Database(sameDb, { readonly: true });
      const books = verifyDb.query("SELECT title FROM books;").all() as any[];
      expect(books.length).toBe(1);
      expect(books[0].title).toBe("Preserve Me");
      verifyDb.close();
    });

    it("withstands destination active WAL busy checkpoint and restores cleanly", () => {
      const stageDir = path.join(tempTestDir, "busy_wal_stage");
      const backupDir = path.join(tempTestDir, "busy_wal_backup");
      const restoreDir = path.join(tempTestDir, "busy_wal_restore");
      fs.mkdirSync(stageDir, { recursive: true });
      fs.mkdirSync(backupDir, { recursive: true });
      fs.mkdirSync(restoreDir, { recursive: true });

      // Source clean DB
      const s = new Database(path.join(stageDir, "metadata.db"));
      s.run("CREATE TABLE books (id INTEGER PRIMARY KEY, title TEXT);");
      s.run("INSERT INTO books VALUES (1, 'Clean Source Book');");
      s.close();

      const bundle = path.join(backupDir, "bundle-wal.tar.gz");
      spawnSync("tar", ["-czf", bundle, "-C", stageDir, "."], { encoding: "utf8" });
      const shaRes = spawnSync("shasum", ["-a", "256", path.basename(bundle)], {
        cwd: backupDir,
        encoding: "utf8",
      });
      fs.writeFileSync(`${bundle}.sha256`, shaRes.stdout);

      // Pre-create destination in WAL mode with an active open transaction
      const destDb = path.join(restoreDir, "metadata.db");
      const d = new Database(destDb);
      d.run("PRAGMA journal_mode = WAL;");
      d.run("CREATE TABLE books (id INTEGER PRIMARY KEY, title TEXT);");
      d.run("INSERT INTO books VALUES (1, 'Stale WAL Row');");
      // Keep an active read transaction open so PRAGMA wal_checkpoint(TRUNCATE) encounters busy reader
      d.run("BEGIN;");
      d.query("SELECT * FROM books;").all();

      // Verify that checkpoint on this active connection confirms busy state (busy=1)
      const busyCheckRes = spawnSync("sqlite3", [destDb, "PRAGMA wal_checkpoint(TRUNCATE);"], { encoding: "utf8" });
      expect(busyCheckRes.stdout).toMatch(/^1\|/);

      try {
        // Restore over active WAL destination
        const res = spawnSync(
          LIGHTHOUSE_BIN,
          ["restore", bundle, "--force", "--target", restoreDir],
          { encoding: "utf8" },
        );
        expect(res.status).toBe(0);
        expect(res.stdout).toContain("Restoration complete");

        // Verify that rollback backup snapshots exist and hold the pre-restore data
        const bakFiles = fs.readdirSync(restoreDir).filter((f: string) => f.includes(".bak."));
        expect(bakFiles.length).toBeGreaterThan(0);
        const mainBak = bakFiles.find((f: string) => f.startsWith("metadata.db.bak.") && !f.includes("-wal") && !f.includes("-shm"));
        const walBak = bakFiles.find((f: string) => f.includes("-wal.bak."));
        expect(mainBak).toBeDefined();
        expect(walBak).toBeDefined();
        expect(fs.statSync(path.join(restoreDir, mainBak!)).size).toBeGreaterThan(0);
        expect(fs.statSync(path.join(restoreDir, walBak!)).size).toBeGreaterThan(0);

        // Reassemble snapshot pair under standard filenames in scratch directory and verify pre-restore content
        const inspectDir = path.join(tempTestDir, "inspect_wal_snapshots");
        fs.mkdirSync(inspectDir, { recursive: true });
        fs.copyFileSync(path.join(restoreDir, mainBak!), path.join(inspectDir, "metadata.db"));
        fs.copyFileSync(path.join(restoreDir, walBak!), path.join(inspectDir, "metadata.db-wal"));

        const bakDb = new Database(path.join(inspectDir, "metadata.db"), { readonly: true });
        const bakBooks = bakDb.query("SELECT title FROM books;").all() as any[];
        expect(bakBooks.length).toBe(1);
        expect(bakBooks[0].title).toBe("Stale WAL Row");
        bakDb.close();

        // Verify restored content is Clean Source Book, and destination is verified
        const rDb = new Database(destDb, { readonly: true });
        const books = rDb.query("SELECT title FROM books;").all() as any[];
        expect(books.length).toBe(1);
        expect(books[0].title).toBe("Clean Source Book");
        rDb.close();
      } finally {
        d.close();
      }
    });

    it("rejects archives containing malicious table identifiers or embedded newlines before mutation or dry-run", () => {
      const stageDir = path.join(tempTestDir, "malicious_table_stage");
      const backupDir = path.join(tempTestDir, "malicious_table_backup");
      const restoreDir = path.join(tempTestDir, "malicious_table_restore");
      fs.mkdirSync(stageDir, { recursive: true });
      fs.mkdirSync(backupDir, { recursive: true });
      fs.mkdirSync(restoreDir, { recursive: true });

      // Pre-existing safe destination database
      const safeDest = new Database(path.join(restoreDir, "metadata.db"));
      safeDest.run("CREATE TABLE books (id INTEGER PRIMARY KEY, title TEXT);");
      safeDest.run("INSERT INTO books VALUES (1, 'Unmodified Safe Original');");
      safeDest.close();

      // 1. Archive with SQL injection attempt in table name
      const c = new Database(path.join(stageDir, "metadata.db"));
      c.run("CREATE TABLE books (id INTEGER PRIMARY KEY, title TEXT);");
      c.run("INSERT INTO books VALUES (1, 'Legit Book');");
      c.run('CREATE TABLE "victim""; DROP TABLE books; --" (id INTEGER PRIMARY KEY, note TEXT);');
      c.run('INSERT INTO "victim""; DROP TABLE books; --" VALUES (1, "evil");');
      c.close();

      const bundle1 = path.join(backupDir, "bundle-malicious-tbl.tar.gz");
      spawnSync("tar", ["-czf", bundle1, "-C", stageDir, "."], { encoding: "utf8" });
      const shaRes1 = spawnSync("shasum", ["-a", "256", path.basename(bundle1)], {
        cwd: backupDir,
        encoding: "utf8",
      });
      fs.writeFileSync(`${bundle1}.sha256`, shaRes1.stdout);

      // Verify --dry-run rejects the malicious bundle upfront
      const resDry = spawnSync(
        LIGHTHOUSE_BIN,
        ["restore", bundle1, "--dry-run"],
        { encoding: "utf8" },
      );
      expect(resDry.status).toBe(1);
      expect(resDry.stderr).toContain("Security Error: Database metadata.db contains non-canonical table identifiers");

      // Verify active restore rejects before destination mutation
      const res1 = spawnSync(
        LIGHTHOUSE_BIN,
        ["restore", bundle1, "--force", "--target", restoreDir],
        { encoding: "utf8" },
      );
      expect(res1.status).toBe(1);
      expect(res1.stderr).toContain("Security Error: Database metadata.db contains non-canonical table identifiers");
      expect(res1.stdout).not.toContain("Restoration complete");

      // Destination database must remain completely unmutated
      const verifySafe = new Database(path.join(restoreDir, "metadata.db"), { readonly: true });
      const safeBooks = verifySafe.query("SELECT title FROM books;").all() as any[];
      expect(safeBooks.length).toBe(1);
      expect(safeBooks[0].title).toBe("Unmodified Safe Original");
      verifySafe.close();

      // 2. Table with embedded newline a\nb
      const stageDir2 = path.join(tempTestDir, "newline_table_stage");
      fs.mkdirSync(stageDir2, { recursive: true });
      const c2 = new Database(path.join(stageDir2, "metadata.db"));
      c2.run("CREATE TABLE books (id INTEGER PRIMARY KEY, title TEXT);");
      c2.run('CREATE TABLE "a\nb" (id INTEGER PRIMARY KEY, note TEXT);');
      c2.close();

      const bundle2 = path.join(backupDir, "bundle-newline-tbl.tar.gz");
      spawnSync("tar", ["-czf", bundle2, "-C", stageDir2, "."], { encoding: "utf8" });
      const shaRes2 = spawnSync("shasum", ["-a", "256", path.basename(bundle2)], {
        cwd: backupDir,
        encoding: "utf8",
      });
      fs.writeFileSync(`${bundle2}.sha256`, shaRes2.stdout);

      const res2 = spawnSync(
        LIGHTHOUSE_BIN,
        ["restore", bundle2, "--force", "--target", restoreDir],
        { encoding: "utf8" },
      );
      expect(res2.status).toBe(1);
      expect(res2.stderr).toContain("Security Error: Database metadata.db contains non-canonical table identifiers");
      expect(res2.stdout).not.toContain("Restoration complete");
    });

    it("restores database with case-insensitive JOBS table identifiers", () => {
      const stageDir = path.join(tempTestDir, "upper_jobs_stage");
      const backupDir = path.join(tempTestDir, "upper_jobs_backup");
      const restoreDir = path.join(tempTestDir, "upper_jobs_restore");
      fs.mkdirSync(stageDir, { recursive: true });
      fs.mkdirSync(backupDir, { recursive: true });
      fs.mkdirSync(restoreDir, { recursive: true });

      const c = new Database(path.join(stageDir, "metadata.db"));
      c.run("CREATE TABLE books (id INTEGER PRIMARY KEY, title TEXT);");
      c.run("INSERT INTO books VALUES (1, 'Book Upper');");
      c.close();

      const ch = new Database(path.join(stageDir, "cache.db"));
      ch.run('CREATE TABLE "JOBS" (id INTEGER PRIMARY KEY, status TEXT);');
      ch.run('INSERT INTO "JOBS" VALUES (1, "done");');
      ch.close();

      const bundle = path.join(backupDir, "bundle-upper-jobs.tar.gz");
      spawnSync("tar", ["-czf", bundle, "-C", stageDir, "."], { encoding: "utf8" });
      const shaRes = spawnSync("shasum", ["-a", "256", path.basename(bundle)], {
        cwd: backupDir,
        encoding: "utf8",
      });
      fs.writeFileSync(`${bundle}.sha256`, shaRes.stdout);

      const res = spawnSync(
        LIGHTHOUSE_BIN,
        ["restore", bundle, "--force", "--target", restoreDir],
        { encoding: "utf8" },
      );
      expect(res.status).toBe(0);
      expect(res.stdout).toContain("Restoration complete");

      const rCh = new Database(path.join(restoreDir, "cache.db"), { readonly: true });
      const rows = rCh.query("SELECT status FROM jobs;").all() as any[];
      expect(rows.length).toBe(1);
      expect(rows[0].status).toBe("done");
      rCh.close();
    });

    it("verifies and restores user tables with sqlite prefix like sqliteXdata without omitting them", () => {
      const stageDir = path.join(tempTestDir, "sqlitex_stage");
      const backupDir = path.join(tempTestDir, "sqlitex_backup");
      const restoreDir = path.join(tempTestDir, "sqlitex_restore");
      fs.mkdirSync(stageDir, { recursive: true });
      fs.mkdirSync(backupDir, { recursive: true });
      fs.mkdirSync(restoreDir, { recursive: true });

      const c = new Database(path.join(stageDir, "metadata.db"));
      c.run("CREATE TABLE books (id INTEGER PRIMARY KEY, title TEXT);");
      c.run("INSERT INTO books VALUES (1, 'Book Main');");
      c.run("CREATE TABLE sqliteXdata (id INTEGER PRIMARY KEY, info TEXT);");
      c.run("INSERT INTO sqliteXdata VALUES (1, 'Custom Sqlite Prefix Table');");
      c.close();

      const bundle = path.join(backupDir, "bundle-sqlitex.tar.gz");
      spawnSync("tar", ["-czf", bundle, "-C", stageDir, "."], { encoding: "utf8" });
      const shaRes = spawnSync("shasum", ["-a", "256", path.basename(bundle)], {
        cwd: backupDir,
        encoding: "utf8",
      });
      fs.writeFileSync(`${bundle}.sha256`, shaRes.stdout);

      const res = spawnSync(
        LIGHTHOUSE_BIN,
        ["restore", bundle, "--force", "--target", restoreDir],
        { encoding: "utf8" },
      );
      expect(res.status).toBe(0);
      expect(res.stdout).toContain("Restoration complete");

      const rC = new Database(path.join(restoreDir, "metadata.db"), { readonly: true });
      const rows = rC.query("SELECT info FROM sqliteXdata;").all() as any[];
      expect(rows.length).toBe(1);
      expect(rows[0].info).toBe("Custom Sqlite Prefix Table");
      rC.close();
    });

    it("performs predictable, idempotent repeated restores to the same target directory", () => {
      const stageDir = path.join(tempTestDir, "repeat_stage");
      const backupDir = path.join(tempTestDir, "repeat_backup");
      const restoreDir = path.join(tempTestDir, "repeat_restore");
      fs.mkdirSync(stageDir, { recursive: true });
      fs.mkdirSync(backupDir, { recursive: true });
      fs.mkdirSync(restoreDir, { recursive: true });

      const s = new Database(path.join(stageDir, "metadata.db"));
      s.run("CREATE TABLE books (id INTEGER PRIMARY KEY, title TEXT);");
      s.run("INSERT INTO books VALUES (1, 'Idempotent Volume 1'), (2, 'Idempotent Volume 2');");
      s.close();

      const bundle = path.join(backupDir, "repeat-bundle.tar.gz");
      spawnSync("tar", ["-czf", bundle, "-C", stageDir, "."], { encoding: "utf8" });
      const shaRes = spawnSync("shasum", ["-a", "256", path.basename(bundle)], {
        cwd: backupDir,
        encoding: "utf8",
      });
      fs.writeFileSync(`${bundle}.sha256`, shaRes.stdout);

      // Run restore round 1
      const res1 = spawnSync(
        LIGHTHOUSE_BIN,
        ["restore", bundle, "--force", "--target", restoreDir],
        { encoding: "utf8" },
      );
      expect(res1.status).toBe(0);
      expect(res1.stdout).toContain("Restoration complete");

      // Run restore round 2 over already-restored target
      const res2 = spawnSync(
        LIGHTHOUSE_BIN,
        ["restore", bundle, "--force", "--target", restoreDir],
        { encoding: "utf8" },
      );
      expect(res2.status).toBe(0);
      expect(res2.stdout).toContain("Restoration complete");

      // Verify readback remains identical
      const rDb = new Database(path.join(restoreDir, "metadata.db"), { readonly: true });
      const books = rDb.query("SELECT title FROM books ORDER BY id;").all() as any[];
      expect(books.length).toBe(2);
      expect(books[0].title).toBe("Idempotent Volume 1");
      expect(books[1].title).toBe("Idempotent Volume 2");
      rDb.close();
    });
  });
});
