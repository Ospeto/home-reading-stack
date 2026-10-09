import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { spawnSync, spawn } from "node:child_process";
import type { Buffer } from "node:buffer";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";

const REPO_ROOT = path.resolve(import.meta.dir, "..");
const WATCHDOG_SCRIPT = path.join(REPO_ROOT, "scripts", "tunnel-watchdog.sh");

interface MockConfig {
  localStatus?: string;
  sgEndpointsStatus?: string;
  sgReprobeStatus?: string;
  usEndpointStatus?: string;
  usReprobeStatus?: string;
  telegramStatus?: string;
}

function setupMockEnvironment(tempDir: string, config: MockConfig = {}) {
  const binDir = path.join(tempDir, "bin");
  const logsDir = path.join(tempDir, "logs");
  const markersDir = path.join(tempDir, "markers");
  fs.mkdirSync(binDir, { recursive: true });
  fs.mkdirSync(logsDir, { recursive: true });
  fs.mkdirSync(markersDir, { recursive: true });

  const localStatus = config.localStatus ?? "200";
  const sgEndpointsStatus = config.sgEndpointsStatus ?? "200";
  const sgReprobeStatus = config.sgReprobeStatus ?? sgEndpointsStatus;
  const usEndpointStatus = config.usEndpointStatus ?? "200";
  const usReprobeStatus = config.usReprobeStatus ?? usEndpointStatus;
  const telegramStatus = config.telegramStatus ?? '{"ok":true}';

  // Mock curl to isolate network probes and Telegram alerts
  const curlScript = `#!/bin/bash
TARGET_URL=""
for arg in "$@"; do
  if [[ "$arg" == http* ]]; then
    TARGET_URL="$arg"
  fi
done

# Telegram alert call
if [[ "$TARGET_URL" == *"api.telegram.org"* ]]; then
  echo '${telegramStatus}'
  exit 0
fi

# Local prerequisite health probes (127.0.0.1)
if [[ "$TARGET_URL" == *"127.0.0.1"* ]]; then
  echo -n "${localStatus}"
  exit 0
fi

# US tunnel probes
if [[ "$TARGET_URL" == *"reading.wavypremium.xyz"* ]]; then
  if [ -f "${tempDir}/in_reprobe_us" ]; then
    echo -n "${usReprobeStatus}"
  else
    echo -n "${usEndpointStatus}"
  fi
  exit 0
fi

# SG re-probe after auto-heal
if [ -f "${tempDir}/in_reprobe" ]; then
  echo -n "${sgReprobeStatus}"
  exit 0
fi

# Default SG WAN endpoints probe
echo -n "${sgEndpointsStatus}"
exit 0
`;
  fs.writeFileSync(path.join(binDir, "curl"), curlScript, { mode: 0o755 });

  // Mock nc to report ports open
  fs.writeFileSync(
    path.join(binDir, "nc"),
    `#!/bin/bash\nexit 0\n`,
    { mode: 0o755 }
  );

  // Mock launchctl
  fs.writeFileSync(
    path.join(binDir, "launchctl"),
    `#!/bin/bash\nexit 0\n`,
    { mode: 0o755 }
  );

  // Mock ssh
  fs.writeFileSync(
    path.join(binDir, "ssh"),
    `#!/bin/bash\nexit 0\n`,
    { mode: 0o755 }
  );

  // Mock pkill
  fs.writeFileSync(
    path.join(binDir, "pkill"),
    `#!/bin/bash\nexit 0\n`,
    { mode: 0o755 }
  );

  // Mock sleep to run instantly
  fs.writeFileSync(
    path.join(binDir, "sleep"),
    `#!/bin/bash\ntouch "${tempDir}/in_reprobe" "${tempDir}/in_reprobe_us"\nexit 0\n`,
    { mode: 0o755 }
  );

  const envFile = path.join(tempDir, "test.env");
  fs.writeFileSync(
    envFile,
    `TELEGRAM_BOT_TOKEN="mock-token"\nTELEGRAM_BACKUP_CHAT_ID="mock-chat"\n`
  );

  return {
    binDir,
    logsDir,
    markersDir,
    envFile,
    logFile: path.join(logsDir, "watchdog.log"),
    sgFailFile: path.join(markersDir, "sg-failures"),
    sgAlertFile: path.join(markersDir, "sg-alerted"),
    usFailFile: path.join(markersDir, "us-failures"),
    usAlertFile: path.join(markersDir, "us-alerted"),
    legacyFailFile: path.join(markersDir, "legacy-failures"),
  };
}

function runWatchdog(
  env: ReturnType<typeof setupMockEnvironment>,
  overrides: Record<string, string> = {}
) {
  const customEnv: NodeJS.ProcessEnv = {
    ...process.env,
    PATH: `${env.binDir}:${process.env.PATH || ""}`,
    ENV_FILE: env.envFile,
    LOG_FILE: env.logFile,
    SG_FAIL_COUNT_FILE: env.sgFailFile,
    SG_ALERT_TRACK_FILE: env.sgAlertFile,
    US_FAIL_COUNT_FILE: env.usFailFile,
    US_ALERT_TRACK_FILE: env.usAlertFile,
    LEGACY_FAIL_COUNT_FILE: env.legacyFailFile,
    ENABLE_US_TUNNEL: "0",
    ...overrides,
  };

  return spawnSync("bash", [WATCHDOG_SCRIPT], {
    env: customEnv,
    encoding: "utf8",
  });
}

describe("tunnel-watchdog.sh marker sanitization & bounded arithmetic (U24)", () => {
  let tempTestDir: string;

  beforeEach(() => {
    tempTestDir = fs.mkdtempSync(path.join(os.tmpdir(), "lh-watchdog-u24-"));
  });

  afterEach(() => {
    if (fs.existsSync(tempTestDir)) {
      fs.rmSync(tempTestDir, { recursive: true, force: true });
    }
  });

  describe("1. Baseline Healthy & Missing/Empty Markers", () => {
    it("handles missing failure marker on healthy probe: initializes to 0 with no stderr error", () => {
      const env = setupMockEnvironment(tempTestDir, { sgEndpointsStatus: "200" });
      expect(fs.existsSync(env.sgFailFile)).toBe(false);

      const res = runWatchdog(env);
      expect(res.status).toBe(0);
      expect(res.stderr).not.toContain("integer expected");
      expect(res.stderr).not.toContain("syntax error");

      expect(fs.existsSync(env.sgFailFile)).toBe(true);
      expect(fs.readFileSync(env.sgFailFile, "utf8").trim()).toBe("0");
    });

    it("handles empty failure marker on healthy probe (E14 regression): safely resets to 0 without integer error", () => {
      const env = setupMockEnvironment(tempTestDir, { sgEndpointsStatus: "200" });
      fs.writeFileSync(env.sgFailFile, ""); // 0 bytes empty marker

      const res = runWatchdog(env);
      expect(res.status).toBe(0);
      expect(res.stderr).not.toContain("integer expected");
      expect(res.stderr).not.toContain("syntax error");

      expect(fs.readFileSync(env.sgFailFile, "utf8").trim()).toBe("0");
      const logContent = fs.readFileSync(env.logFile, "utf8");
      expect(logContent).toContain("empty");
    });

    it("resets previous failure counter upon successful recovery and logs prior count", () => {
      const env = setupMockEnvironment(tempTestDir, { sgEndpointsStatus: "200" });
      fs.writeFileSync(env.sgFailFile, "7\n");
      fs.writeFileSync(env.sgAlertFile, "3\n");

      const res = runWatchdog(env);
      expect(res.status).toBe(0);
      expect(fs.readFileSync(env.sgFailFile, "utf8").trim()).toBe("0");
      expect(fs.existsSync(env.sgAlertFile)).toBe(false); // alert tracker purged on recovery

      const logContent = fs.readFileSync(env.logFile, "utf8");
      expect(logContent).toContain("was 7");
    });
  });

  describe("2. Failing Probes & Malformed/Octal/Junk Markers", () => {
    it("increments cleanly from missing marker on failure", () => {
      const env = setupMockEnvironment(tempTestDir, {
        sgEndpointsStatus: "502",
        sgReprobeStatus: "502",
      });

      const res = runWatchdog(env);
      expect(res.status).toBe(0);
      expect(res.stderr).not.toContain("integer expected");
      expect(res.stderr).not.toContain("syntax error");

      expect(fs.readFileSync(env.sgFailFile, "utf8").trim()).toBe("1");
    });

    it("handles octal-looking markers (08, 09) without octal syntax errors", () => {
      const env = setupMockEnvironment(tempTestDir, {
        sgEndpointsStatus: "502",
        sgReprobeStatus: "502",
      });
      fs.writeFileSync(env.sgFailFile, "08\n");

      const res = runWatchdog(env);
      expect(res.status).toBe(0);
      expect(res.stderr).not.toContain("value too great for base");
      expect(res.stderr).not.toContain("syntax error");

      // 8 + 1 = 9, written canonically as 9
      expect(fs.readFileSync(env.sgFailFile, "utf8").trim()).toBe("9");

      // Test 09 -> 10
      fs.writeFileSync(env.sgFailFile, "09\n");
      const res2 = runWatchdog(env);
      expect(res2.status).toBe(0);
      expect(res2.stderr).not.toContain("value too great for base");
      expect(fs.readFileSync(env.sgFailFile, "utf8").trim()).toBe("10");
    });

    it("handles non-numeric junk markers safely with diagnostic fallback to 0", () => {
      const env = setupMockEnvironment(tempTestDir, {
        sgEndpointsStatus: "502",
        sgReprobeStatus: "502",
      });
      fs.writeFileSync(env.sgFailFile, "corrupted_garbage_text\n");

      const res = runWatchdog(env);
      expect(res.status).toBe(0);
      expect(res.stderr).not.toContain("unbound variable");
      expect(res.stderr).not.toContain("syntax error");

      // Safe default 0 -> incremented to 1
      expect(fs.readFileSync(env.sgFailFile, "utf8").trim()).toBe("1");
      const logContent = fs.readFileSync(env.logFile, "utf8");
      expect(logContent).toContain("non-numeric");
    });

    it("handles negative numeric markers safely with diagnostic fallback to 0", () => {
      const env = setupMockEnvironment(tempTestDir, {
        sgEndpointsStatus: "502",
        sgReprobeStatus: "502",
      });
      fs.writeFileSync(env.sgFailFile, "-42\n");

      const res = runWatchdog(env);
      expect(res.status).toBe(0);
      expect(res.stderr).not.toContain("syntax error");

      // Safe default 0 -> incremented to 1
      expect(fs.readFileSync(env.sgFailFile, "utf8").trim()).toBe("1");
      const logContent = fs.readFileSync(env.logFile, "utf8");
      expect(logContent).toContain("negative");
    });

    it("handles huge / overflow numeric markers safely without bash arithmetic errors", () => {
      const env = setupMockEnvironment(tempTestDir, {
        sgEndpointsStatus: "502",
        sgReprobeStatus: "502",
      });
      fs.writeFileSync(env.sgFailFile, "9999999999999999999999999999999999999999999\n");

      const res = runWatchdog(env);
      expect(res.status).toBe(0);
      expect(res.stderr).not.toContain("value too great for base");
      expect(res.stderr).not.toContain("overflow");

      // Safe default 0 -> incremented to 1
      expect(fs.readFileSync(env.sgFailFile, "utf8").trim()).toBe("1");
      const logContent = fs.readFileSync(env.logFile, "utf8");
      expect(logContent).toContain("length");
    });

    it("enforces bounded marker ceiling (clamping) to prevent uncontrolled overflow", () => {
      const env = setupMockEnvironment(tempTestDir, {
        sgEndpointsStatus: "502",
        sgReprobeStatus: "502",
      });
      fs.writeFileSync(env.sgFailFile, "10\n");

      // Run with MAX_MARKER_VAL=10
      const res = runWatchdog(env, { MAX_MARKER_VAL: "10" });
      expect(res.status).toBe(0);
      // Clamped to 10 instead of growing beyond max
      expect(fs.readFileSync(env.sgFailFile, "utf8").trim()).toBe("10");
    });
  });

  describe("3. Alert Escalation Cadence & Alert Marker Tracking", () => {
    it("escalates alert on failure >= 3 and updates alert marker file", () => {
      const env = setupMockEnvironment(tempTestDir, {
        sgEndpointsStatus: "502",
        sgReprobeStatus: "502",
      });
      fs.writeFileSync(env.sgFailFile, "2\n"); // Next failure will be 3

      const res = runWatchdog(env);
      expect(res.status).toBe(0);
      expect(fs.readFileSync(env.sgFailFile, "utf8").trim()).toBe("3");
      expect(fs.existsSync(env.sgAlertFile)).toBe(true);
      expect(fs.readFileSync(env.sgAlertFile, "utf8").trim()).toBe("3");

      const logContent = fs.readFileSync(env.logFile, "utf8");
      expect(logContent).toContain("Escalating: Sending failure alert to Telegram");
    });

    it("suppresses repeat alerts when difference < 10 failures", () => {
      const env = setupMockEnvironment(tempTestDir, {
        sgEndpointsStatus: "502",
        sgReprobeStatus: "502",
      });
      fs.writeFileSync(env.sgFailFile, "3\n");
      fs.writeFileSync(env.sgAlertFile, "3\n"); // Already alerted at failure 3

      const res = runWatchdog(env);
      expect(res.status).toBe(0);
      expect(fs.readFileSync(env.sgFailFile, "utf8").trim()).toBe("4");
      // Alert marker stays at 3
      expect(fs.readFileSync(env.sgAlertFile, "utf8").trim()).toBe("3");

      const logContent = fs.readFileSync(env.logFile, "utf8");
      expect(logContent).not.toContain("Escalating: Sending failure alert to Telegram");
    });

    it("re-escalates alert when difference reaches >= 10 failures (e.g. failure 13)", () => {
      const env = setupMockEnvironment(tempTestDir, {
        sgEndpointsStatus: "502",
        sgReprobeStatus: "502",
      });
      fs.writeFileSync(env.sgFailFile, "12\n");
      fs.writeFileSync(env.sgAlertFile, "3\n"); // Alerted at 3; 13 - 3 = 10 -> triggers!

      const res = runWatchdog(env);
      expect(res.status).toBe(0);
      expect(fs.readFileSync(env.sgFailFile, "utf8").trim()).toBe("13");
      // Updated alert marker
      expect(fs.readFileSync(env.sgAlertFile, "utf8").trim()).toBe("13");

      const logContent = fs.readFileSync(env.logFile, "utf8");
      expect(logContent).toContain("Escalating: Sending failure alert to Telegram");
    });

    it("recovers gracefully if alert marker is corrupt or empty", () => {
      const env = setupMockEnvironment(tempTestDir, {
        sgEndpointsStatus: "502",
        sgReprobeStatus: "502",
      });
      fs.writeFileSync(env.sgFailFile, "4\n"); // failures = 5 (>= 3)
      fs.writeFileSync(env.sgAlertFile, ""); // empty alert tracker

      const res = runWatchdog(env);
      expect(res.status).toBe(0);
      expect(res.stderr).not.toContain("integer expected");
      expect(res.stderr).not.toContain("syntax error");

      expect(fs.readFileSync(env.sgFailFile, "utf8").trim()).toBe("5");
      expect(fs.readFileSync(env.sgAlertFile, "utf8").trim()).toBe("5");
    });

    it("prevents lost escalation when alert marker exceeds current failure count", () => {
      const env = setupMockEnvironment(tempTestDir, {
        sgEndpointsStatus: "502",
        sgReprobeStatus: "502",
      });
      fs.writeFileSync(env.sgFailFile, "2\n"); // failures = 3 (>= 3)
      fs.writeFileSync(env.sgAlertFile, "50\n"); // Desynchronized / stale alert tracker > 3

      const res = runWatchdog(env);
      expect(res.status).toBe(0);
      expect(fs.readFileSync(env.sgFailFile, "utf8").trim()).toBe("3");
      // Reset and updated to 3, escalation not lost
      expect(fs.readFileSync(env.sgAlertFile, "utf8").trim()).toBe("3");

      const logContent = fs.readFileSync(env.logFile, "utf8");
      expect(logContent).toContain("Escalating: Sending failure alert to Telegram");
    });
  });

  describe("4. Atomic Marker Writes & Concurrency / Truncation Resilience", () => {
    it("recovers cleanly from truncated (0-byte) marker file left by interrupted write", () => {
      const env = setupMockEnvironment(tempTestDir, {
        sgEndpointsStatus: "502",
        sgReprobeStatus: "502",
      });
      // Simulate interrupted truncate
      fs.closeSync(fs.openSync(env.sgFailFile, "w"));

      const res = runWatchdog(env);
      expect(res.status).toBe(0);
      expect(fs.readFileSync(env.sgFailFile, "utf8").trim()).toBe("1");
    });

    it("maintains consistent valid markers across rapid repeated runs", () => {
      const env = setupMockEnvironment(tempTestDir, {
        sgEndpointsStatus: "502",
        sgReprobeStatus: "502",
      });

      for (let i = 1; i <= 6; i++) {
        const res = runWatchdog(env);
        expect(res.status).toBe(0);
        expect(fs.readFileSync(env.sgFailFile, "utf8").trim()).toBe(String(i));
      }

      // Now recover
      const envHealthy = setupMockEnvironment(tempTestDir, {
        sgEndpointsStatus: "200",
      });
      const resRecovery = runWatchdog(envHealthy);
      expect(resRecovery.status).toBe(0);
      expect(fs.readFileSync(envHealthy.sgFailFile, "utf8").trim()).toBe("0");
    });

    it("handles concurrent watchdog fixture runs without leaving corrupted or truncated markers", async () => {
      const env = setupMockEnvironment(tempTestDir, {
        sgEndpointsStatus: "502",
        sgReprobeStatus: "502",
      });

      // Spawn 4 genuinely concurrent background processes targeting the same fixture markers
      const customEnv: NodeJS.ProcessEnv = {
        ...process.env,
        PATH: `${env.binDir}:${process.env.PATH || ""}`,
        ENV_FILE: env.envFile,
        LOG_FILE: env.logFile,
        SG_FAIL_COUNT_FILE: env.sgFailFile,
        SG_ALERT_TRACK_FILE: env.sgAlertFile,
        US_FAIL_COUNT_FILE: env.usFailFile,
        US_ALERT_TRACK_FILE: env.usAlertFile,
        LEGACY_FAIL_COUNT_FILE: env.legacyFailFile,
        ENABLE_US_TUNNEL: "0",
      };

      const promises = Array.from({ length: 4 }).map(() => {
        return new Promise<number>((resolve, reject) => {
          let stderr = "";
          const child = spawn("bash", [WATCHDOG_SCRIPT], { env: customEnv });
          child.stderr.on("data", (data: Buffer | string) => {
            stderr += data.toString();
          });
          child.on("close", (code: number | null) => {
            expect(stderr).not.toContain("syntax error");
            expect(stderr).not.toContain("integer expected");
            resolve(code ?? 0);
          });
          child.on("error", reject);
        });
      });

      const statuses = await Promise.all(promises);
      for (const st of statuses) {
        expect(st).toBe(0);
      }

      // Read final marker on disk: must be valid canonical decimal between 1 and 4
      const finalMarker = fs.readFileSync(env.sgFailFile, "utf8").trim();
      expect(/^\d+$/.test(finalMarker)).toBe(true);
      const parsed = parseInt(finalMarker, 10);
      expect(parsed).toBeGreaterThanOrEqual(1);
      expect(parsed).toBeLessThanOrEqual(4);
    });
  });

  describe("5. US Tunnel Path & Legacy Marker Mirroring", () => {
    it("handles US tunnel failures and mirrors to legacy failure file", () => {
      const env = setupMockEnvironment(tempTestDir, {
        usEndpointStatus: "502",
        usReprobeStatus: "502",
      });

      // Enable US tunnel and provide dummy plist
      const dummyPlist = path.join(tempTestDir, "us-tunnel.plist");
      fs.writeFileSync(dummyPlist, "<plist></plist>");

      const res = runWatchdog(env, {
        ENABLE_US_TUNNEL: "1",
        US_PLIST: dummyPlist,
      });

      expect(res.status).toBe(0);
      expect(fs.readFileSync(env.usFailFile, "utf8").trim()).toBe("1");
      expect(fs.readFileSync(env.legacyFailFile, "utf8").trim()).toBe("1");
    });

    it("resets US tunnel markers and legacy failure file upon recovery", () => {
      const env = setupMockEnvironment(tempTestDir, {
        usEndpointStatus: "200",
      });

      const dummyPlist = path.join(tempTestDir, "us-tunnel.plist");
      fs.writeFileSync(dummyPlist, "<plist></plist>");
      fs.writeFileSync(env.usFailFile, "4\n");
      fs.writeFileSync(env.legacyFailFile, "4\n");

      const res = runWatchdog(env, {
        ENABLE_US_TUNNEL: "1",
        US_PLIST: dummyPlist,
      });

      expect(res.status).toBe(0);
      expect(fs.readFileSync(env.usFailFile, "utf8").trim()).toBe("0");
      expect(fs.readFileSync(env.legacyFailFile, "utf8").trim()).toBe("0");
    });
  });
});
