import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import process from "node:process";
import crypto from "node:crypto";
import { spawn, spawnSync } from "node:child_process";
import { Database } from "bun:sqlite";

export interface ExternalDrive {
  name: string;
  mountPath: string;
  freeBytes: number;
  totalBytes: number;
  freeGb: number;
  totalGb: number;
  isPreferred: boolean;
  isWritable: boolean;
}

export interface LastBackupReport {
  timestamp: string | null;
  booksCount: number;
  sizeBytes: number;
  durationSeconds: number;
  success: boolean;
  error?: string | null;
  target?: string | null;
}

export interface SsdBackupConfig {
  enabled: boolean;
  scheduleTime: string; // "HH:MM" e.g. "03:00"
  targetMount: string; // e.g. "/Volumes/Ospeto_SSD"
  lastBackup: LastBackupReport | null;
}

export interface SsdBackupResult {
  success: boolean;
  skipped?: boolean;
  reason?: string;
  target?: string;
  booksCount?: number;
  sizeBytes?: number;
  durationSeconds?: number;
  databases?: Array<{ name: string; sizeBytes: number; sha256: string }>;
  manifestPath?: string;
  error?: string;
}

export interface SsdBackupStatus {
  drives: ExternalDrive[];
  config: SsdBackupConfig;
  defaultTarget: string | null;
  targetMounted: boolean;
  lastBackup: LastBackupReport | null;
}

export const DEFAULT_CONFIG: SsdBackupConfig = {
  enabled: false,
  scheduleTime: "03:00",
  targetMount: "/Volumes/Ospeto_SSD",
  lastBackup: null,
};

export const EXCLUDED_VOLUME_NAMES = new RegExp(
  "^(Macintosh HD.*|Recovery|Preboot|VM|Update|Kindle.*|Kobo.*|KOReader.*|\\d{1,3}\\.\\d{1,3}\\.\\d{1,3}\\.\\d{1,3}.*|.*Time ?Machine.*)$",
  "i"
);

// Minimum 100 MB free space required on destination drive before running rsync
export const MIN_FREE_SPACE_BYTES = 100 * 1024 * 1024;

export function escapeXml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

export function validateScheduleTime(scheduleTime: string): { hour: number; minute: number; normalizedTime: string } {
  if (typeof scheduleTime !== "string") {
    throw new Error("Invalid scheduleTime: value must be a string");
  }
  const match = scheduleTime.trim().match(/^(\d{1,2}):(\d{2})$/);
  if (!match) {
    throw new Error(`Invalid scheduleTime format: '${scheduleTime}'. Expected 'HH:MM'.`);
  }
  const hour = parseInt(match[1], 10);
  const minute = parseInt(match[2], 10);
  if (hour < 0 || hour > 23 || minute < 0 || minute > 59) {
    throw new Error(`Schedule time out of range: '${scheduleTime}'. Hour must be 0-23, minute 0-59.`);
  }
  const normalizedTime = `${String(hour).padStart(2, "0")}:${String(minute).padStart(2, "0")}`;
  return { hour, minute, normalizedTime };
}

export function getLighthouseRoot(): string {
  if (process.env.LIGHTHOUSE_ROOT) {
    return path.resolve(process.env.LIGHTHOUSE_ROOT);
  }
  const currentDir = typeof (import.meta as any).dir === "string" ? (import.meta as any).dir : process.cwd();
  return path.resolve(path.join(currentDir, ".."));
}

export function getConfigPath(customPath?: string): string {
  if (customPath) return path.resolve(customPath);
  if (process.env.SSD_BACKUP_CONFIG_PATH) {
    return path.resolve(process.env.SSD_BACKUP_CONFIG_PATH);
  }
  return path.join(getLighthouseRoot(), "data", "ssd-backup-config.json");
}

export function getLockFilePath(): string {
  if (process.env.SSD_BACKUP_LOCK_PATH) {
    return path.resolve(process.env.SSD_BACKUP_LOCK_PATH);
  }
  return path.join(getLighthouseRoot(), "data", "ssd-backup.lock");
}

export function getCalibreLibraryDir(): string {
  if (process.env.CALIBRE_LIBRARY_DIR) {
    return path.resolve(process.env.CALIBRE_LIBRARY_DIR);
  }
  if (process.env.CALIBRE_DB_PATH) {
    return path.dirname(path.resolve(process.env.CALIBRE_DB_PATH));
  }
  const defaultAgentDir = path.join(os.homedir(), "Calibre Libraries", "Agent Library");
  if (fs.existsSync(defaultAgentDir)) return defaultAgentDir;
  return path.join(os.homedir(), "Calibre Library");
}

export function getCalibreDbPath(): string {
  if (process.env.CALIBRE_DB_PATH) {
    return path.resolve(process.env.CALIBRE_DB_PATH);
  }
  return path.join(getCalibreLibraryDir(), "metadata.db");
}

/**
 * Validate that a target path is strictly confined to /Volumes (or test fixture directory)
 * and does not overlap with the Calibre library source or critical system paths.
 */
/**
 * Validate that a target path is strictly confined to /Volumes (or test fixture directory),
 * rejects the root /Volumes directory itself, verifies no symlink escapes,
 * and does not overlap with the Calibre library source or critical system paths.
 */
export function validateTargetDirectory(
  target: string,
  customVolumesDir?: string
): { valid: boolean; resolvedPath: string; error?: string } {
  if (!target || typeof target !== "string" || target.trim().length === 0) {
    return { valid: false, resolvedPath: "", error: "Target path must be a non-empty string" };
  }

  const resolved = path.resolve(target.trim());

  // Allowed volumes root
  const defaultVolumesRoot = path.resolve("/Volumes");
  const volumesRoot = path.resolve(customVolumesDir || process.env.LIGHTHOUSE_VOLUMES_DIR || "/Volumes");
  const allowedTestDir = process.env.TEST_ALLOWED_TARGET_DIR
    ? path.resolve(process.env.TEST_ALLOWED_TARGET_DIR)
    : null;

  // Security guard: Target cannot be the root /Volumes directory itself! Must be a mounted volume subdirectory
  if (resolved === volumesRoot || resolved === defaultVolumesRoot) {
    return {
      valid: false,
      resolvedPath: resolved,
      error: `Security Error: Target path cannot be the root volumes directory '${resolved}'. Must be a specific volume under /Volumes.`,
    };
  }

  // Security guard: Check symlink escape using realpath
  let realTarget = resolved;
  try {
    if (fs.existsSync(resolved)) {
      realTarget = fs.realpathSync(resolved);
    } else {
      const parent = path.dirname(resolved);
      if (fs.existsSync(parent)) {
        realTarget = path.join(fs.realpathSync(parent), path.basename(resolved));
      }
    }
  } catch {
    // If realpath resolution fails, keep resolved
  }

  const realVolumesRoot = fs.existsSync(volumesRoot) ? fs.realpathSync(volumesRoot) : volumesRoot;
  const realDefaultVolumesRoot = fs.existsSync(defaultVolumesRoot) ? fs.realpathSync(defaultVolumesRoot) : defaultVolumesRoot;
  const realTestDir = allowedTestDir && fs.existsSync(allowedTestDir) ? fs.realpathSync(allowedTestDir) : allowedTestDir;

  const isInsideVolumes =
    (resolved.startsWith(volumesRoot + path.sep) && realTarget.startsWith(realVolumesRoot + path.sep)) ||
    (resolved.startsWith(defaultVolumesRoot + path.sep) && realTarget.startsWith(realDefaultVolumesRoot + path.sep));

  const isInsideTestDir =
    realTestDir &&
    (resolved === allowedTestDir || resolved.startsWith(allowedTestDir + path.sep)) &&
    (realTarget === realTestDir || realTarget.startsWith(realTestDir + path.sep));

  if (!isInsideVolumes && !isInsideTestDir) {
    return {
      valid: false,
      resolvedPath: resolved,
      error: `Security Error: Target path '${resolved}' is outside allowed volumes directory '${volumesRoot}'`,
    };
  }

  // Refuse root / system directory targets
  const disallowedRoots = [
    "/",
    "/System",
    "/usr",
    "/bin",
    "/sbin",
    "/Library",
    "/Users",
    "/Applications",
    "/private",
    "/etc",
    "/var",
    "/Volumes",
  ];
  if (disallowedRoots.includes(realTarget) && !isInsideTestDir) {
    return {
      valid: false,
      resolvedPath: resolved,
      error: `Security Error: Target path '${resolved}' cannot be a root or system directory`,
    };
  }

  // Overlap guard: Destination cannot equal or be nested inside Calibre Library, and Calibre Library cannot be inside destination
  try {
    const calibreDir = fs.existsSync(getCalibreLibraryDir())
      ? fs.realpathSync(getCalibreLibraryDir())
      : path.resolve(getCalibreLibraryDir());

    if (realTarget === calibreDir) {
      return {
        valid: false,
        resolvedPath: resolved,
        error: "Destination path cannot be the same as the Calibre Library source",
      };
    }
    if (realTarget.startsWith(calibreDir + path.sep)) {
      return {
        valid: false,
        resolvedPath: resolved,
        error: "Destination path cannot be located inside the Calibre Library source",
      };
    }
    if (calibreDir.startsWith(realTarget + path.sep)) {
      return {
        valid: false,
        resolvedPath: resolved,
        error: "Calibre Library source cannot be located inside the destination path",
      };
    }
  } catch (err: any) {
    // Fail-closed on path resolution error for safety
    return {
      valid: false,
      resolvedPath: resolved,
      error: `Security Error: Failed to resolve Calibre source directory: ${err?.message || String(err)}`,
    };
  }

  return { valid: true, resolvedPath: resolved };
}

/**
 * Concurrency Lock Management: ensures only one backup runs at a time using atomic file creation.
 */
export function acquireBackupLock(): { acquired: boolean; pid?: number; error?: string } {
  const lockFile = getLockFilePath();
  const dir = path.dirname(lockFile);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }

  const payload = JSON.stringify({ pid: process.pid, timestamp: new Date().toISOString() });

  // Attempt atomic file creation (O_CREAT | O_EXCL)
  try {
    fs.writeFileSync(lockFile, payload, { encoding: "utf8", flag: "wx" });
    return { acquired: true, pid: process.pid };
  } catch (err: any) {
    if (err.code !== "EEXIST") {
      return { acquired: false, error: err?.message || String(err) };
    }
  }

  // Lock exists: inspect whether owner PID is alive
  try {
    const raw = fs.readFileSync(lockFile, "utf8");
    const parsed = JSON.parse(raw);
    const pid = Number(parsed.pid);
    if (pid && pid > 0) {
      try {
        process.kill(pid, 0);
        // Process is genuinely still running
        return {
          acquired: false,
          pid,
          error: `A whole-library SSD backup is already in progress (PID ${pid})`,
        };
      } catch {
        // PID is dead; stale lock can be reclaimed
      }
    }
  } catch {
    // Corrupted lock content; reclaim
  }

  // Atomically unlink stale lock and retry once
  try {
    fs.unlinkSync(lockFile);
  } catch {
    // Ignore unlink errors
  }

  try {
    fs.writeFileSync(lockFile, payload, { encoding: "utf8", flag: "wx" });
    return { acquired: true, pid: process.pid };
  } catch (retryErr: any) {
    return {
      acquired: false,
      error: `Failed to acquire lock after reclaiming stale lock: ${retryErr?.message || String(retryErr)}`,
    };
  }
}

export function releaseBackupLock(expectedPid?: number): void {
  const lockFile = getLockFilePath();
  const targetPid = expectedPid || process.pid;
  try {
    if (fs.existsSync(lockFile)) {
      try {
        const raw = fs.readFileSync(lockFile, "utf8");
        const parsed = JSON.parse(raw);
        if (parsed.pid && Number(parsed.pid) !== targetPid) {
          // Do not unlink lock owned by another process
          return;
        }
      } catch {
        // If unparseable, allow cleanup
      }
      fs.unlinkSync(lockFile);
    }
  } catch {
    // Ignore cleanup errors
  }
}

/**
 * Asynchronous Command Execution helper (non-blocking).
 */
export async function runCommandAsync(
  cmd: string,
  args: string[],
  options?: { timeoutMs?: number }
): Promise<{ status: number; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    const proc = spawn(cmd, args, {
      stdio: ["ignore", "pipe", "pipe"],
    });

    let stdout = "";
    let stderr = "";
    proc.stdout?.on("data", (d: any) => {
      stdout += d.toString();
    });
    proc.stderr?.on("data", (d: any) => {
      stderr += d.toString();
    });

    let timer: ReturnType<typeof setTimeout> | null = null;
    if (options?.timeoutMs) {
      timer = setTimeout(() => {
        try {
          proc.kill("SIGKILL");
        } catch {
          // Ignore kill error if process already terminated
        }
        resolve({
          status: 124,
          stdout,
          stderr: stderr + `\nTimed out after ${options.timeoutMs}ms`,
        });
      }, options.timeoutMs);
    }

    proc.on("close", (code: any) => {
      if (timer) clearTimeout(timer);
      resolve({ status: code ?? 1, stdout, stderr });
    });

    proc.on("error", (err: any) => {
      if (timer) clearTimeout(timer);
      resolve({ status: 1, stdout, stderr: stderr + "\n" + (err?.message || String(err)) });
    });
  });
}

export function getVolumeDiskSpace(mountPath: string): { freeBytes: number; totalBytes: number } {
  if (process.env.TEST_SSD_FREE_BYTES !== undefined) {
    const rawFree = Number(process.env.TEST_SSD_FREE_BYTES);
    const free = Number.isFinite(rawFree) ? Math.max(0, rawFree) : 0;
    const rawTotal = process.env.TEST_SSD_TOTAL_BYTES !== undefined
      ? Number(process.env.TEST_SSD_TOTAL_BYTES)
      : Math.max(free * 2, 1024 * 1024);
    const total = Number.isFinite(rawTotal) ? Math.max(0, rawTotal) : 0;
    return { freeBytes: free, totalBytes: total };
  }

  try {
    if (!fs.existsSync(mountPath)) {
      return { freeBytes: 0, totalBytes: 0 };
    }
    // SAFETY: Node.js 19.6+ and Bun provide fs.statfsSync which may not be present in standard ambient Node definitions
    const fsAny = fs as unknown as {
      statfsSync?: (p: string) => { bsize: number; bavail: number; bfree: number; blocks: number };
    };
    if (typeof fsAny.statfsSync === "function") {
      try {
        const stats = fsAny.statfsSync(mountPath);
        const bsize = Number(stats.bsize || 4096);
        const freeBytes = Number(stats.bavail || stats.bfree || 0) * bsize;
        const totalBytes = Number(stats.blocks || 0) * bsize;
        if (totalBytes > 0) {
          return { freeBytes, totalBytes };
        }
      } catch {
        // Fall back to df -k
      }
    }

    const dfRes = spawnSync("df", ["-k", mountPath], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
      timeout: 5000,
    });
    if (dfRes.status === 0 && dfRes.stdout) {
      const lines = dfRes.stdout.trim().split("\n");
      if (lines.length >= 2) {
        const tokens = lines[1].trim().split(/\s+/);
        if (tokens.length >= 4) {
          const total1024 = parseInt(tokens[1], 10);
          const avail1024 = parseInt(tokens[3], 10);
          if (!Number.isNaN(total1024) && !Number.isNaN(avail1024)) {
            return {
              totalBytes: total1024 * 1024,
              freeBytes: avail1024 * 1024,
            };
          }
        }
      }
    }
  } catch {
    // Fail-open
  }
  return { freeBytes: 0, totalBytes: 0 };
}

/**
 * Scan /Volumes/ (or custom directory) to discover attached writable external drives.
 */
export function detectExternalDrives(customVolumesDir?: string): ExternalDrive[] {
  const targetDir = customVolumesDir || process.env.LIGHTHOUSE_VOLUMES_DIR || "/Volumes";
  const drives: ExternalDrive[] = [];

  try {
    if (!fs.existsSync(targetDir)) return drives;
    const entries = fs.readdirSync(targetDir, { withFileTypes: true });

    for (const ent of entries) {
      if (!ent.isDirectory() && !ent.isSymbolicLink()) continue;
      if (ent.name.startsWith(".")) continue;
      if (EXCLUDED_VOLUME_NAMES.test(ent.name)) continue;

      const mountPath = path.join(targetDir, ent.name);
      let isWritable = false;
      try {
        fs.accessSync(mountPath, fs.constants.W_OK);
        isWritable = true;
      } catch {
        isWritable = false;
      }

      const { freeBytes, totalBytes } = getVolumeDiskSpace(mountPath);
      const isPreferred = /ospeto.*ssd/i.test(ent.name) || /^ospeto_ssd$/i.test(ent.name);

      drives.push({
        name: ent.name,
        mountPath,
        freeBytes,
        totalBytes,
        freeGb: Math.round((freeBytes / (1024 * 1024 * 1024)) * 10) / 10,
        totalGb: Math.round((totalBytes / (1024 * 1024 * 1024)) * 10) / 10,
        isPreferred,
        isWritable,
      });
    }

    // Sort drives: preferred (Ospeto_SSD) first, then writable, then by free space descending
    drives.sort((a, b) => {
      if (a.isPreferred && !b.isPreferred) return -1;
      if (!a.isPreferred && b.isPreferred) return 1;
      if (a.isWritable && !b.isWritable) return -1;
      if (!a.isWritable && b.isWritable) return 1;
      return b.freeBytes - a.freeBytes;
    });
  } catch {
    // Fail-open returning whatever was found
  }

  return drives;
}

/**
 * Determine default SSD target mount directory.
 */
export function findDefaultSsdTarget(
  customVolumesDir?: string,
  configPath?: string,
  preferConfigured = true
): string | null {
  const config = getSsdBackupConfig(configPath);
  if (config.targetMount) {
    if (fs.existsSync(config.targetMount)) {
      try {
        fs.accessSync(config.targetMount, fs.constants.W_OK);
        return config.targetMount;
      } catch {
        // Configured target mount exists but is not writable
      }
    } else if (preferConfigured) {
      // Configured target is not mounted; return it so caller detects unmounted state
      return config.targetMount;
    }
  }

  const drives = detectExternalDrives(customVolumesDir);
  const preferred = drives.find((d) => d.isPreferred && d.isWritable);
  if (preferred) return preferred.mountPath;

  const writable = drives.find((d) => d.isWritable);
  return writable ? writable.mountPath : (config.targetMount || null);
}

/**
 * Read configuration from data/ssd-backup-config.json.
 */
export function getSsdBackupConfig(customConfigPath?: string): SsdBackupConfig {
  const cfgPath = getConfigPath(customConfigPath);
  try {
    if (fs.existsSync(cfgPath)) {
      const raw = fs.readFileSync(cfgPath, "utf8");
      const parsed = JSON.parse(raw);
      let scheduleTime = DEFAULT_CONFIG.scheduleTime;
      if (typeof parsed.scheduleTime === "string") {
        try {
          scheduleTime = validateScheduleTime(parsed.scheduleTime).normalizedTime;
        } catch {
          scheduleTime = DEFAULT_CONFIG.scheduleTime;
        }
      }
      return {
        enabled: typeof parsed.enabled === "boolean" ? parsed.enabled : DEFAULT_CONFIG.enabled,
        scheduleTime,
        targetMount: typeof parsed.targetMount === "string" && parsed.targetMount.trim().length > 0
          ? parsed.targetMount
          : DEFAULT_CONFIG.targetMount,
        lastBackup: parsed.lastBackup || null,
      };
    }
  } catch {
    // Return default on parse failure
  }
  return { ...DEFAULT_CONFIG };
}

/**
 * Save configuration to data/ssd-backup-config.json with strict validation and normalization.
 */
export function saveSsdBackupConfig(
  patch: Partial<SsdBackupConfig>,
  customConfigPath?: string,
  customVolumesDir?: string
): SsdBackupConfig {
  const cfgPath = getConfigPath(customConfigPath);
  const current = getSsdBackupConfig(customConfigPath);

  let normalizedScheduleTime = current.scheduleTime;
  if (patch.scheduleTime !== undefined) {
    const { normalizedTime } = validateScheduleTime(patch.scheduleTime);
    normalizedScheduleTime = normalizedTime;
  }

  let validatedTargetMount = current.targetMount;
  if (patch.targetMount !== undefined) {
    const valRes = validateTargetDirectory(patch.targetMount, customVolumesDir);
    if (!valRes.valid) {
      throw new Error(valRes.error || `Invalid targetMount: '${patch.targetMount}'`);
    }
    validatedTargetMount = valRes.resolvedPath;
  }

  const updated: SsdBackupConfig = {
    ...current,
    ...patch,
    scheduleTime: normalizedScheduleTime,
    targetMount: validatedTargetMount,
  };

  const dir = path.dirname(cfgPath);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }

  fs.writeFileSync(cfgPath, JSON.stringify(updated, null, 2), "utf8");
  return updated;
}

/**
 * Generate launchd plist for scheduled SSD backup with safe XML escaping.
 */
export function generateSsdBackupPlist(options: {
  scheduleTime: string;
  lighthouseRoot?: string;
  homeDir?: string;
  daemonPrefix?: string;
  bashPath?: string;
}): string {
  const { scheduleTime } = options;
  const { hour, minute } = validateScheduleTime(scheduleTime);

  const root = options.lighthouseRoot || getLighthouseRoot();
  const home = options.homeDir || os.homedir();
  const prefix = options.daemonPrefix || process.env.LIGHTHOUSE_DAEMON_PREFIX || "com.ospeto";
  const bash = options.bashPath || "/bin/bash";
  const logDir = path.join(home, "Library", "Logs");

  const escPrefix = escapeXml(prefix);
  const escBash = escapeXml(bash);
  const escRoot = escapeXml(root);
  const escHome = escapeXml(home);
  const escLogDir = escapeXml(logDir);

  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>Label</key>
    <string>${escPrefix}.reading-ssd-backup</string>
    <key>ProgramArguments</key>
    <array>
        <string>${escBash}</string>
        <string>${escRoot}/scripts/backup-ssd.sh</string>
        <string>--scheduled</string>
    </array>
    <key>EnvironmentVariables</key>
    <dict>
        <key>PATH</key>
        <string>/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin</string>
        <key>LIGHTHOUSE_ROOT</key>
        <string>${escRoot}</string>
        <key>HOME</key>
        <string>${escHome}</string>
    </dict>
    <key>StartCalendarInterval</key>
    <dict>
        <key>Hour</key>
        <integer>${hour}</integer>
        <key>Minute</key>
        <integer>${minute}</integer>
    </dict>
    <key>StandardOutPath</key>
    <string>${escLogDir}/reading-ssd-backup.log</string>
    <key>StandardErrorPath</key>
    <string>${escLogDir}/reading-ssd-backup.log</string>
</dict>
</plist>
`;
}

/**
 * Install or update launchd LaunchAgent plist with the configured schedule.
 */
export function updateLaunchAgentSchedule(options: {
  scheduleTime: string;
  enabled: boolean;
  dryRun?: boolean;
  configPath?: string;
  plistDir?: string;
  lighthouseRoot?: string;
  homeDir?: string;
}): { success: boolean; message: string; plistPath: string; plistContent: string } {
  const home = options.homeDir || os.homedir();
  const targetDir = options.plistDir || path.join(home, "Library", "LaunchAgents");
  const prefix = process.env.LIGHTHOUSE_DAEMON_PREFIX || "com.ospeto";
  const plistPath = path.join(targetDir, `${prefix}.reading-ssd-backup.plist`);

  const plistContent = generateSsdBackupPlist({
    scheduleTime: options.scheduleTime,
    lighthouseRoot: options.lighthouseRoot,
    homeDir: home,
    daemonPrefix: prefix,
  });

  if (options.dryRun) {
    return {
      success: true,
      message: `Dry-run: LaunchAgent plist generated for ${options.scheduleTime} (enabled: ${options.enabled})`,
      plistPath,
      plistContent,
    };
  }

  if (!fs.existsSync(targetDir)) {
    fs.mkdirSync(targetDir, { recursive: true });
  }

  fs.writeFileSync(plistPath, plistContent, "utf8");

  // Manage launchctl registration if running on macOS
  if (process.platform === "darwin" && !process.env.TEST_NO_LAUNCHCTL) {
    try {
      spawnSync("launchctl", ["unload", plistPath], { stdio: "ignore" });
      if (options.enabled) {
        spawnSync("launchctl", ["load", "-w", plistPath], { stdio: "ignore" });
      }
    } catch {
      // Ignore launchctl errors in unprivileged or testing environments
    }
  }

  return {
    success: true,
    message: options.enabled
      ? `LaunchAgent registered for daily backup at ${options.scheduleTime}`
      : `LaunchAgent updated and disabled`,
    plistPath,
    plistContent,
  };
}

/**
 * Execute whole-library incremental backup to SSD (non-blocking async).
 */
export async function performSsdBackup(options?: {
  target?: string;
  dryRun?: boolean;
  scheduled?: boolean;
  configPath?: string;
  customVolumesDir?: string;
  onLog?: (msg: string) => void;
}): Promise<SsdBackupResult> {
  const startTime = Date.now();
  const log = (msg: string) => {
    if (options?.onLog) options.onLog(msg);
    else console.log(`[SSD-BACKUP] ${msg}`);
  };

  // 1. Scheduled Run Gate: Honor config.enabled
  if (options?.scheduled) {
    const cfg = getSsdBackupConfig(options?.configPath);
    if (!cfg.enabled) {
      const reason = "Daily auto-backup is disabled in configuration.";
      log(`Notice: ${reason} Scheduled backup skipped cleanly.`);
      return { success: true, skipped: true, reason };
    }
  }

  const rawTargetDir =
    options?.target ||
    findDefaultSsdTarget(options?.customVolumesDir, options?.configPath);

  if (!rawTargetDir) {
    const reason = "No writable external SSD found under /Volumes.";
    if (options?.scheduled) {
      log(`Notice: ${reason} Scheduled backup skipped cleanly.`);
      return { success: true, skipped: true, reason };
    }
    log(`Notice: ${reason}`);
    return { success: false, skipped: true, error: reason };
  }

  // 2. Security Validation & Path Confinement
  const valRes = validateTargetDirectory(rawTargetDir, options?.customVolumesDir);
  if (!valRes.valid) {
    const error = valRes.error || `Invalid target directory: '${rawTargetDir}'`;
    log(`Security Error: ${error}`);
    return { success: false, error };
  }
  const targetDir = valRes.resolvedPath;

  // 3. Safe Detection Check: if unmounted, handle cleanly
  if (!fs.existsSync(targetDir)) {
    const reason = `Target drive '${targetDir}' is not mounted.`;
    if (options?.scheduled) {
      log(`Notice: ${reason} Scheduled backup skipped cleanly.`);
      return { success: true, skipped: true, reason };
    }
    log(`Notice: ${reason}`);
    return { success: false, skipped: true, error: reason };
  }

  // Check target writability
  try {
    fs.accessSync(targetDir, fs.constants.W_OK);
  } catch {
    const error = `Target drive '${targetDir}' is mounted but not writable.`;
    log(`Error: ${error}`);
    return { success: false, error };
  }

  // 4. Source Calibre Library Validation
  const calibreLibDir = getCalibreLibraryDir();
  const calibreDbPath = getCalibreDbPath();

  if (!fs.existsSync(calibreLibDir)) {
    const error = `Calibre library directory not found at '${calibreLibDir}'.`;
    log(`Error: ${error}`);
    return { success: false, error };
  }
  if (!fs.existsSync(calibreDbPath)) {
    const error = `Calibre metadata.db not found at '${calibreDbPath}'. Directory is not a valid Calibre library.`;
    log(`Error: ${error}`);
    return { success: false, error };
  }

  // Refuse if Calibre source resolves to a system root
  const disallowedSources = ["/", "/System", "/usr", "/bin", "/sbin", "/Library", "/Users", "/Applications"];
  if (disallowedSources.includes(path.resolve(calibreLibDir))) {
    const error = `Security Error: Calibre library directory cannot be '${calibreLibDir}'`;
    log(`Error: ${error}`);
    return { success: false, error };
  }

  // 5. Free-Space Preflight (Fail closed: verify capacity and enforce reserve)
  const { freeBytes, totalBytes } = getVolumeDiskSpace(targetDir);
  if (process.env.TEST_BYPASS_DISK_SPACE !== "1") {
    if (totalBytes <= 0) {
      const error = `Unable to determine storage capacity or free space on target '${targetDir}'.`;
      log(`Error: ${error}`);
      return { success: false, error };
    }
    if (freeBytes < MIN_FREE_SPACE_BYTES) {
      const freeMb = Math.round(freeBytes / (1024 * 1024));
      const error = `Insufficient free space on target SSD (${freeMb} MB free, minimum 100 MB required).`;
      log(`Error: ${error}`);
      return { success: false, error };
    }
  }

  const root = getLighthouseRoot();
  const destCalibreDir = path.join(targetDir, "Calibre_Library");
  const destDatabasesDir = path.join(targetDir, "Databases");
  const manifestPath = path.join(targetDir, "backup_manifest.json");

  log(`Starting incremental backup to '${targetDir}'...`);
  log(`Source Calibre Library: '${calibreLibDir}'`);

  if (options?.dryRun) {
    log("Dry run mode: verifying paths and database connectivity without writing.");
    return {
      success: true,
      skipped: false,
      target: targetDir,
      booksCount: countCalibreBooks(calibreDbPath),
      sizeBytes: 0,
      durationSeconds: 0,
    };
  }

  // 6. Concurrency Lock
  const lock = acquireBackupLock();
  if (!lock.acquired) {
    const error = lock.error || "A backup process is already running";
    log(`Warning: ${error}`);
    return { success: false, skipped: true, error };
  }

  let stagingDir: string | null = null;
  const backedUpDbs: Array<{ name: string; sizeBytes: number; sha256: string }> = [];

  try {
    // Ensure destination directories exist
    fs.mkdirSync(destCalibreDir, { recursive: true });
    fs.mkdirSync(destDatabasesDir, { recursive: true });

    stagingDir = fs.mkdtempSync(path.join(os.tmpdir(), "reading-ssd-backup-"));
    // 7. Hot Backup SQLite Databases into Staging Directory (Non-blocking async)
    const dbTargets: Array<{ name: string; path: string }> = [
      { name: "metadata.db", path: calibreDbPath },
      {
        name: "koreader-sync.db",
        path: process.env.KOSYNC_DB_PATH || path.join(os.homedir(), "kosync-server", "data", "koreader-sync.db"),
      },
      {
        name: "cache.db",
        path: process.env.CACHE_DB_PATH || path.join(root, "cache.db"),
      },
      {
        name: "manga.db",
        path: process.env.MANGA_DB_PATH || path.join(os.homedir(), "manga-processor", "manga.db"),
      },
    ];

    for (const item of dbTargets) {
      if (!fs.existsSync(item.path)) {
        log(`Notice: Database ${item.name} not found at '${item.path}', skipping.`);
        continue;
      }

      const stagedPath = path.join(stagingDir, item.name);
      log(`Backing up ${item.name} (WAL checkpoint + .backup)...`);

      // SQLite WAL checkpoint & hot backup
      try {
        const db = new Database(item.path);
        try {
          db.run("PRAGMA wal_checkpoint(TRUNCATE);");
        } catch {
          // Ignore WAL checkpoint failure on read-only DBs
        }
        db.close();
      } catch {
        // Fall back to sqlite3 CLI directly
      }

      const backupRes = await runCommandAsync("sqlite3", [item.path, `.backup '${stagedPath}'`], {
        timeoutMs: 30000,
      });

      if (backupRes.status !== 0 || !fs.existsSync(stagedPath)) {
        throw new Error(`Failed to hot-backup database ${item.name}: ${backupRes.stderr}`);
      }

      // Quick check integrity
      const checkRes = await runCommandAsync("sqlite3", [stagedPath, "PRAGMA quick_check;"], {
        timeoutMs: 10000,
      });
      if (checkRes.status !== 0 || !checkRes.stdout.includes("ok")) {
        throw new Error(`Integrity check failed for backed-up ${item.name}`);
      }

      // Stream SHA256 checksum and calculate size
      const dbBuf = fs.readFileSync(stagedPath);
      const sha256 = crypto.createHash("sha256").update(dbBuf).digest("hex");
      backedUpDbs.push({
        name: item.name,
        sizeBytes: dbBuf.length,
        sha256,
      });

      // Write .sha256 file
      fs.writeFileSync(`${stagedPath}.sha256`, `${sha256}  ${item.name}\n`, "utf8");
    }

    // 8. Sync Staged Databases to SSD (WITHOUT --delete to preserve prior snapshots if a DB is missing)
    log(`Syncing database snapshots to '${destDatabasesDir}'...`);
    const rsyncDbRes = await runCommandAsync(
      "rsync",
      ["-av", `${stagingDir}/`, `${destDatabasesDir}/`],
      { timeoutMs: 60000 }
    );
    if (rsyncDbRes.status !== 0) {
      throw new Error(`Failed to sync databases to SSD: ${rsyncDbRes.stderr}`);
    }

    // 9. Incremental Sync of Whole Calibre Library via rsync -av --delete
    log(`Syncing Calibre Library incrementally to '${destCalibreDir}'...`);
    const srcWithSlash = calibreLibDir.endsWith("/") ? calibreLibDir : `${calibreLibDir}/`;
    const rsyncLibRes = await runCommandAsync(
      "rsync",
      ["-av", "--delete", "--exclude=.DS_Store", "--exclude=*~", srcWithSlash, `${destCalibreDir}/`],
      { timeoutMs: 600000 } // 10 minutes timeout
    );
    if (rsyncLibRes.status !== 0) {
      throw new Error(`rsync failed for Calibre Library: ${rsyncLibRes.stderr}`);
    }

    const booksCount = countCalibreBooks(calibreDbPath);
    const durationSeconds = Math.round(((Date.now() - startTime) / 1000) * 10) / 10;
    const totalSizeBytes = await calculateDirectorySizeAsync(destCalibreDir);

    // 10. Write Backup Manifest
    const manifest = {
      version: "1.0.0",
      timestamp: new Date().toISOString(),
      calibreLibrary: {
        source: calibreLibDir,
        destination: destCalibreDir,
        booksCount,
        totalSizeBytes,
      },
      databases: backedUpDbs,
      durationSeconds,
      success: true,
    };
    fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2), "utf8");

    // 11. Update Configuration with lastBackup report
    const lastBackupReport: LastBackupReport = {
      timestamp: manifest.timestamp,
      booksCount,
      sizeBytes: totalSizeBytes,
      durationSeconds,
      success: true,
      error: null,
      target: targetDir,
    };

    saveSsdBackupConfig(
      {
        lastBackup: lastBackupReport,
        targetMount: targetDir,
      },
      options?.configPath,
      options?.customVolumesDir
    );

    log(`Incremental backup completed successfully in ${durationSeconds}s (${booksCount} books).`);

    return {
      success: true,
      target: targetDir,
      booksCount,
      sizeBytes: totalSizeBytes,
      durationSeconds,
      databases: backedUpDbs,
      manifestPath,
    };
  } catch (err: any) {
    const errorMsg = err?.message || String(err);
    log(`Error during backup: ${errorMsg}`);

    // Update config with failed attempt
    const durationSeconds = Math.round(((Date.now() - startTime) / 1000) * 10) / 10;
    saveSsdBackupConfig(
      {
        lastBackup: {
          timestamp: new Date().toISOString(),
          booksCount: 0,
          sizeBytes: 0,
          durationSeconds,
          success: false,
          error: errorMsg,
          target: targetDir,
        },
      },
      options?.configPath,
      options?.customVolumesDir
    );

    return {
      success: false,
      error: errorMsg,
    };
  } finally {
    releaseBackupLock(process.pid);
    // Clean up temporary staging directory if created
    try {
      if (stagingDir && fs.existsSync(stagingDir)) {
        fs.rmSync(stagingDir, { recursive: true, force: true });
      }
    } catch {
      // Ignore temporary directory cleanup error
    }
  }
}

/**
 * Return current status of external SSD backup system.
 */
export function getSsdBackupStatus(
  customVolumesDir?: string,
  configPath?: string
): SsdBackupStatus {
  const drives = detectExternalDrives(customVolumesDir);
  const config = getSsdBackupConfig(configPath);
  const defaultTarget = findDefaultSsdTarget(customVolumesDir, configPath);
  const targetMounted = Boolean(
    config.targetMount
      ? fs.existsSync(config.targetMount)
      : defaultTarget && fs.existsSync(defaultTarget)
  );

  return {
    drives,
    config,
    defaultTarget,
    targetMounted,
    lastBackup: config.lastBackup,
  };
}

/**
 * Count total books in Calibre database.
 */
export function countCalibreBooks(dbPath: string): number {
  try {
    if (!fs.existsSync(dbPath)) return 0;
    const db = new Database(dbPath, { readonly: true });
    const row = db.query("SELECT count(*) as count FROM books;").get() as { count: number };
    db.close();
    return row?.count || 0;
  } catch {
    return 0;
  }
}

/**
 * Calculate total size of directory in bytes recursively (asynchronous, non-blocking).
 */
export async function calculateDirectorySizeAsync(dirPath: string): Promise<number> {
  let total = 0;
  try {
    if (!fs.existsSync(dirPath)) return 0;
    const entries = await fs.promises.readdir(dirPath, { withFileTypes: true });
    for (const ent of entries) {
      const fullPath = path.join(dirPath, ent.name);
      try {
        if (ent.isDirectory()) {
          total += await calculateDirectorySizeAsync(fullPath);
        } else if (ent.isFile()) {
          const stats = await fs.promises.stat(fullPath);
          total += stats.size;
        }
      } catch {
        // Skip unreadable files or directory entries
      }
    }
  } catch {
    // Fail-open returning 0
  }
  return total;
}

/**
 * Calculate total size of directory in bytes recursively (synchronous fallback).
 */
export function calculateDirectorySize(dirPath: string): number {
  let total = 0;
  try {
    if (!fs.existsSync(dirPath)) return 0;
    const entries = fs.readdirSync(dirPath, { withFileTypes: true });
    for (const ent of entries) {
      const fullPath = path.join(dirPath, ent.name);
      try {
        if (ent.isDirectory()) {
          total += calculateDirectorySize(fullPath);
        } else if (ent.isFile()) {
          const stats = fs.statSync(fullPath);
          total += stats.size;
        }
      } catch {
        // Skip unreadable files or directory entries
      }
    }
  } catch {
    // Fail-open returning 0
  }
  return total;
}

// CLI Execution entry point when invoked directly: bun run uploader/ssd-backup.ts [subcommand]
if ((import.meta as any).main) {
  const args = process.argv.slice(2);
  const cmd = args[0] || "run";

  if (cmd === "status") {
    const status = getSsdBackupStatus();
    console.log(JSON.stringify(status, null, 2));
    process.exit(0);
  }

  if (cmd === "set-time") {
    const time = args[1];
    if (!time) {
      console.error("Usage: bun run uploader/ssd-backup.ts set-time <HH:MM>");
      process.exit(1);
    }
    try {
      validateScheduleTime(time);
      const cfg = saveSsdBackupConfig({ scheduleTime: time });
      updateLaunchAgentSchedule({
        scheduleTime: cfg.scheduleTime,
        enabled: cfg.enabled,
      });
      console.log(`Updated schedule time to ${time} (enabled: ${cfg.enabled})`);
      process.exit(0);
    } catch (err: any) {
      console.error(`Error: ${err.message}`);
      process.exit(1);
    }
  }

  if (cmd === "enable" || cmd === "disable") {
    const enabled = cmd === "enable";
    const cfg = saveSsdBackupConfig({ enabled });
    updateLaunchAgentSchedule({
      scheduleTime: cfg.scheduleTime,
      enabled,
    });
    console.log(`Auto-backup ${enabled ? "enabled" : "disabled"}`);
    process.exit(0);
  }

  // cmd === "run" or immediate backup
  const targetIdx = args.indexOf("--target");
  const target = targetIdx !== -1 ? args[targetIdx + 1] : undefined;
  const isScheduled = args.includes("--scheduled");
  const isDryRun = args.includes("--dry-run");

  performSsdBackup({
    target,
    scheduled: isScheduled,
    dryRun: isDryRun,
  }).then((res) => {
    if (!res.success && !res.skipped) {
      console.error(`Backup failed: ${res.error}`);
      process.exit(1);
    }
    process.exit(0);
  });
}
