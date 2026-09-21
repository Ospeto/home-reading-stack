import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
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
      expect(stdout).toContain("install-daemons");
      expect(stdout).toContain("backup");
      expect(stdout).toContain("restore");
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
      });
      expect(res.status).toBe(0);
      expect(res.stdout).toContain(`Root: ${REPO_ROOT}`);
    });

    it("all scripts in scripts/ define LIGHTHOUSE_ROOT", () => {
      const scripts = [
        "backup-daily.sh",
        "clean-duplicates.sh",
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
  });

  describe("2. Status Command Dashboard", () => {
    it("displays one-screen dashboard with all 4 core ports and sections", () => {
      const res = spawnSync(LIGHTHOUSE_BIN, ["status"], {
        encoding: "utf8",
        cwd: REPO_ROOT,
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
      expect(files.length).toBe(6);

      const uploaderPlist = files.find((f: string) => f.includes("book-uploader"));
      const botPlist = files.find((f: string) => f.includes("reading-telegram-bot"));
      const watchdogPlist = files.find((f: string) => f.includes("reading-tunnel-watchdog"));
      const vlessPlist = files.find((f: string) => f.includes("reading-vless-tunnel"));
      const sgPlist = files.find((f: string) => f.includes("reading-sg-tunnel"));
      const backupPlist = files.find((f: string) => f.includes("reading-stack-backup"));

      expect(uploaderPlist).toBeDefined();
      expect(botPlist).toBeDefined();
      expect(watchdogPlist).toBeDefined();
      expect(vlessPlist).toBeDefined();
      expect(sgPlist).toBeDefined();
      expect(backupPlist).toBeDefined();

      // Check contents of book-uploader plist
      const uploaderContent = fs.readFileSync(
        path.join(outputDir, uploaderPlist!),
        "utf8",
      );
      expect(uploaderContent).toContain(REPO_ROOT);
      expect(uploaderContent).toContain("server.ts");

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
    });

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

  describe("6. Shell Scripts Shellcheck Hygiene", () => {
    it("passes shellcheck cleanly across bin/lighthouse and all scripts/*.sh", () => {
      const scriptsToLint = [
        LIGHTHOUSE_BIN,
        path.join(REPO_ROOT, "scripts", "backup-daily.sh"),
        path.join(REPO_ROOT, "scripts", "clean-duplicates.sh"),
        path.join(REPO_ROOT, "scripts", "migration-preflight.sh"),
        path.join(REPO_ROOT, "scripts", "sync-series-metadata.sh"),
        path.join(REPO_ROOT, "scripts", "tunnel-watchdog.sh"),
      ];

      for (const script of scriptsToLint) {
        const lint = spawnSync("shellcheck", [script], { encoding: "utf8" });
        if (lint.status !== 0) {
          console.error(`Shellcheck failed on ${script}:\n${lint.stderr || lint.stdout}`);
        }
        expect(lint.status).toBe(0);
      }
    });
  });
});
