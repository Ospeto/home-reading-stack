import { afterEach, describe, expect, it } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  DEFAULT_LIBRARY_PROBE_TIMEOUT_MS,
  LIBRARY_PROBE_TIMEOUT_ENV,
  checkLibraryAccess,
  classifyProbeRun,
  describeLibraryAccessFailure,
  directoryProbeArgv,
  evaluateLibraryStartupGate,
  fileProbeArgv,
  formatStartupGateMessage,
  isFatalLibraryStatus,
  probePath,
  resolveProbeTimeoutMs,
} from "./library-preflight";
import type { ProbeRun, ProbeRunner } from "./library-preflight";

/**
 * INC-11 regression coverage: a library on a removable volume.
 *
 * The bug these tests lock down is not "the library is missing" - it is the
 * silent wedge. Under launchd, `ls`/`cat` of a removable volume either get
 * `Operation not permitted` (no TCC entitlement) or never return at all (the
 * device stopped answering, or a consent request nobody can answer). `bun`
 * blocks inside the syscall, so the server bound its port, logged `listening`,
 * kept a live PID, and served nothing - which reads as a lost startup race.
 *
 * The preflight must therefore (a) run out of process, so a blocked syscall
 * cannot take the event loop with it, (b) bound that child with a hard kill, and
 * (c) exit non-zero with an actionable message instead of serving nothing.
 */

const scratchDirs: string[] = [];

function scratchDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "lighthouse-preflight-test-"));
  scratchDirs.push(dir);
  return dir;
}

afterEach(() => {
  while (scratchDirs.length) {
    const dir = scratchDirs.pop()!;
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

function runnerReturning(run: ProbeRun): ProbeRunner {
  return async () => run;
}

describe("probe classification", () => {
  it("treats a clean child exit as readable", () => {
    const result = classifyProbeRun({ timedOut: false, code: 0, stderr: "" }, "/lib", 500);
    expect(result.status).toBe("ok");
  });

  it("classifies Operation not permitted as a TCC-style denial", () => {
    const result = classifyProbeRun(
      {
        timedOut: false,
        code: 1,
        stderr: "ls: /Volumes/Ospeto_SSD/Lighthouse_Agent_Library: Operation not permitted",
      },
      "/Volumes/Ospeto_SSD/Lighthouse_Agent_Library",
      500,
    );
    expect(result.status).toBe("permission-denied");
    expect(result.detail).toContain("Operation not permitted");
  });

  it("classifies Permission denied as the same refusal", () => {
    const result = classifyProbeRun(
      { timedOut: false, code: 1, stderr: "head: /lib/metadata.db: Permission denied" },
      "/lib/metadata.db",
      500,
    );
    expect(result.status).toBe("permission-denied");
  });

  it("classifies a missing path as missing, not as a denial", () => {
    const result = classifyProbeRun(
      {
        timedOut: false,
        code: 1,
        stderr: "ls: /Volumes/Ospeto_SSD: No such file or directory",
      },
      "/Volumes/Ospeto_SSD",
      500,
    );
    expect(result.status).toBe("missing");
  });

  it("classifies a killed child as an unresponsive volume, never as ok", () => {
    const result = classifyProbeRun({ timedOut: true, code: null, stderr: "" }, "/lib", 500);
    expect(result.status).toBe("unresponsive");
    expect(result.detail).toContain("500ms");
  });

  it("keeps an unclassified failure as a reported error", () => {
    const result = classifyProbeRun(
      { timedOut: false, code: 2, stderr: "ls: input/output error" },
      "/lib",
      500,
    );
    expect(result.status).toBe("error");
    expect(result.detail).toContain("input/output error");
  });
});

describe("probe deadline configuration", () => {
  it("defaults to the documented deadline", () => {
    expect(resolveProbeTimeoutMs(undefined, {})).toBe(DEFAULT_LIBRARY_PROBE_TIMEOUT_MS);
  });

  it("honours the explicit override", () => {
    expect(resolveProbeTimeoutMs(1234, {})).toBe(1234);
  });

  it("honours the environment override and ignores junk", () => {
    expect(resolveProbeTimeoutMs(undefined, { [LIBRARY_PROBE_TIMEOUT_ENV]: "900" })).toBe(900);
    expect(resolveProbeTimeoutMs(undefined, { [LIBRARY_PROBE_TIMEOUT_ENV]: "not-a-number" })).toBe(
      DEFAULT_LIBRARY_PROBE_TIMEOUT_MS,
    );
    expect(resolveProbeTimeoutMs(undefined, { [LIBRARY_PROBE_TIMEOUT_ENV]: "-5" })).toBe(
      DEFAULT_LIBRARY_PROBE_TIMEOUT_MS,
    );
  });
});

describe("probe argv keeps the killed child the only process", () => {
  it("execs the directory probe so nothing outlives the kill", () => {
    const argv = directoryProbeArgv("/tmp/lib");
    expect(argv[0]).toBe("/bin/sh");
    expect(argv[2]).toContain("exec ");
    expect(argv[argv.length - 1]).toBe("/tmp/lib");
  });

  it("execs the file probe and reads only a header", () => {
    const argv = fileProbeArgv("/tmp/lib/metadata.db");
    expect(argv[2]).toContain("exec ");
    expect(argv[2]).toContain("-c 16");
    expect(argv[argv.length - 1]).toBe("/tmp/lib/metadata.db");
  });
});

describe("real probe against local storage", () => {
  it("reports a readable library directory as ok", async () => {
    const dir = scratchDir();
    fs.writeFileSync(path.join(dir, "metadata.db"), "SQLite format 3\u0000");
    const report = await checkLibraryAccess({
      libraryDir: dir,
      dbPath: path.join(dir, "metadata.db"),
    });
    expect(report.status).toBe("ok");
    expect(report.probes.map((p) => p.status)).toEqual(["ok", "ok"]);
  });

  it("reports a readable library as ok and says nothing about it", async () => {
    const dir = scratchDir();
    fs.writeFileSync(path.join(dir, "metadata.db"), "SQLite format 3\u0000");
    const gate = await evaluateLibraryStartupGate({
      libraryDir: dir,
      dbPath: path.join(dir, "metadata.db"),
    });
    expect(gate.exitCode).toBe(0);
    // A healthy start is silent: the gate renders no message, so nothing is
    // written to the agent's log (~/Library/Logs/uploader.log).
    expect(gate.lines).toEqual([]);
    expect(formatStartupGateMessage(gate)).toBeNull();
  });

  it("reports an unmounted library path as missing and refuses to start", async () => {
    const dir = path.join(scratchDir(), "not-mounted");
    const report = await checkLibraryAccess({ libraryDir: dir, dbPath: path.join(dir, "metadata.db") });
    expect(report.status).toBe("missing");
    expect(isFatalLibraryStatus(report.status)).toBe(true);
    // The database probe is skipped: a second child could not succeed either.
    expect(report.probes).toHaveLength(1);

    const gate = await evaluateLibraryStartupGate({ libraryDir: dir });
    expect(gate.exitCode).toBe(1);
    const message = formatStartupGateMessage(gate);
    expect(message).toContain(`missing: ${dir}`);
    expect(message).toContain("Fatal");
    expect(message).toContain("Move the live library onto local storage");
    expect(message).toContain("Full Disk Access");
  });

  it("refuses to start when the root is readable but metadata.db is gone", async () => {
    const dir = scratchDir();
    const missingDb = path.join(dir, "metadata.db");
    const gate = await evaluateLibraryStartupGate({ libraryDir: dir, dbPath: missingDb });
    expect(gate.exitCode).toBe(1);
    expect(formatStartupGateMessage(gate)).toContain(`missing: ${missingDb}`);
  });

  it("refuses to start when the probe fails for an unclassified reason", async () => {
    const dir = scratchDir();
    const gate = await evaluateLibraryStartupGate(
      { libraryDir: dir },
      {
        runner: runnerReturning({
          timedOut: false,
          code: 2,
          stderr: `ls: ${dir}: Input/output error`,
        }),
      },
    );
    expect(gate.exitCode).toBe(1);
    const message = formatStartupGateMessage(gate);
    expect(message).toContain("Fatal");
    expect(message).toContain("Input/output error");
  });

  /**
   * The wedge itself. A FIFO with no writer blocks the reader inside the open
   * call - exactly what a volume that stopped answering does - so this asserts
   * the deadline really kills the child and the caller is never blocked.
   */
  it("kills a probe blocked in the filesystem call and calls it unresponsive", async () => {
    const dir = scratchDir();
    const fifo = path.join(dir, "stuck");
    const made = Bun.spawnSync(["/usr/bin/mkfifo", fifo]);
    expect(made.exitCode).toBe(0);

    const startedAt = Date.now();
    const result = await probePath(fifo, "file", { timeoutMs: 250 });
    const elapsed = Date.now() - startedAt;

    expect(result.status).toBe("unresponsive");
    expect(elapsed).toBeGreaterThanOrEqual(200);
    // Bounded: a wedged child must never hold the caller for long.
    expect(elapsed).toBeLessThan(5000);
  }, 15000);

  it("reports a denied read as permission-denied through the startup gate", async () => {
    const dir = scratchDir();
    const gate = await evaluateLibraryStartupGate(
      { libraryDir: dir },
      {
        runner: runnerReturning({
          timedOut: false,
          code: 1,
          stderr: `ls: ${dir}: Operation not permitted`,
        }),
      },
    );
    expect(gate.exitCode).toBe(1);
    expect(gate.lines.join("\n")).toContain("Operation not permitted");
  });

  it("stops with a non-zero exit when the volume never answers", async () => {
    const gate = await evaluateLibraryStartupGate(
      { libraryDir: "/Volumes/Ospeto_SSD/Lighthouse_Agent_Library" },
      { runner: runnerReturning({ timedOut: true, code: null, stderr: "" }) },
    );
    expect(gate.exitCode).toBe(1);
  });
});

describe("operator-facing failure message", () => {
  const deniedReport = {
    status: "permission-denied" as const,
    libraryDir: "/Volumes/Ospeto_SSD/Lighthouse_Agent_Library",
    dbPath: null,
    probes: [
      {
        status: "permission-denied" as const,
        target: "/Volumes/Ospeto_SSD/Lighthouse_Agent_Library",
        timeoutMs: 500,
        detail: "Operation not permitted",
      },
    ],
  };

  it("names the TCC cause and both remedies, in order of durability", () => {
    const text = describeLibraryAccessFailure(deniedReport).join("\n");
    expect(text).toContain("Operation not permitted");
    expect(text).toContain("removable-volume entitlement");
    expect(text).toContain("Move the live library onto local storage");
    expect(text).toContain("Full Disk Access");
    // Recommended remedy first.
    expect(text.indexOf("Move the live library")).toBeLessThan(text.indexOf("Full Disk Access"));
    expect(text).toContain(LIBRARY_PROBE_TIMEOUT_ENV);
  });

  it("distinguishes an unresponsive volume from a denial", () => {
    const text = describeLibraryAccessFailure({
      status: "unresponsive",
      libraryDir: "/Volumes/Ospeto_SSD/Lighthouse_Agent_Library",
      dbPath: null,
      probes: [
        {
          status: "unresponsive",
          target: "/Volumes/Ospeto_SSD/Lighthouse_Agent_Library",
          timeoutMs: 500,
          detail: "no answer",
        },
      ],
    }).join("\n");
    expect(text).toContain("did not answer");
    expect(text).toContain("hung");
    expect(text).not.toContain("macOS refused access");
  });

  it("keeps each verdict, path and remedy on its own line", () => {
    const text = formatStartupGateMessage({
      exitCode: 1,
      lines: describeLibraryAccessFailure(deniedReport),
    });
    expect(text).not.toBeNull();
    const lines = text!.split("\n");
    expect(lines[0]).toContain("Fatal");
    expect(lines).toContain(
      "  permission-denied: /Volumes/Ospeto_SSD/Lighthouse_Agent_Library (Operation not permitted)",
    );
    expect(lines.some((line) => line.startsWith("   1. "))).toBe(true);
    expect(lines.some((line) => line.startsWith("  Probe deadline: "))).toBe(true);
  });
});
