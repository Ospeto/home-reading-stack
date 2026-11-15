/**
 * Bounded startup preflight for the Calibre library root.
 *
 * The library is not guaranteed to live on local storage. This deployment
 * symlinks `~/Calibre Libraries/Agent Library` onto an external volume
 * (`/Volumes/Ospeto_SSD/Lighthouse_Agent_Library`), and two macOS behaviours
 * then bite any process that is not an interacted-with GUI app:
 *
 *  1. TCC protects removable volumes (`kTCCServiceSystemPolicyRemovableVolumes`).
 *     A launchd agent is its own TCC client with no grant, so its accesses are
 *     denied: `ls` reports `Operation not permitted`.
 *  2. When the volume stops answering real I/O (a flaky enclosure, or a consent
 *     request nobody can answer) the kernel never returns from `openat`, so
 *     `bun` wedges *inside the syscall* instead of failing. The process binds
 *     its port, logs `listening`, keeps a live PID in `launchctl list`, and
 *     serves nothing. That is the silent failure INC-11 documents: it looks
 *     exactly like a lost startup race, and it is not one.
 *
 * An in-process check cannot help - it would block in the very same syscall. So
 * the probe runs in a **killable child process** with a hard SIGKILL deadline,
 * and both outcomes become one loud, actionable message *before* the port is
 * bound. A process that cannot read its library is a process that must not
 * pretend to be up.
 *
 * Exit-code contract: `ok` is the only non-fatal verdict. Denied, unresponsive,
 * unreadable and absent all exit non-zero so launchd reports a real failure
 * instead of a live PID serving no catalog.
 */

/** Default hard deadline for one probe child, in milliseconds. */
export const DEFAULT_LIBRARY_PROBE_TIMEOUT_MS = 5000;

/** Environment override for the probe deadline, in milliseconds. */
export const LIBRARY_PROBE_TIMEOUT_ENV = "LIGHTHOUSE_LIBRARY_PROBE_TIMEOUT_MS";

/**
 * Status of one probed path.
 *
 * - `ok` - the child read it.
 * - `permission-denied` - the OS refused (TCC removable-volume denial).
 * - `missing` - nothing is mounted at that path right now.
 * - `unresponsive` - the child never returned and was killed: the volume is not
 *   answering, or a consent request is pending forever.
 * - `error` - the child failed for some other reported reason.
 */
export type PathProbeStatus =
  | "ok"
  | "permission-denied"
  | "missing"
  | "unresponsive"
  | "error";

/** Raw outcome of running one bounded probe child. */
export interface ProbeRun {
  timedOut: boolean;
  code: number | null;
  stderr: string;
}

/** Injectable probe runner, so tests can drive classification without I/O. */
export type ProbeRunner = (
  argv: string[],
  timeoutMs: number,
) => Promise<ProbeRun>;

/** Result of probing a single path. */
export interface PathProbeResult {
  status: PathProbeStatus;
  target: string;
  timeoutMs: number;
  /** Child stderr, or the explanation of the deadline that was hit. */
  detail: string;
}

/** Aggregate result for every path the library needs. */
export interface LibraryAccessReport {
  /** Worst status across all probes, in severity order. */
  status: Exclude<PathProbeStatus, "ok"> | "ok";
  libraryDir: string;
  dbPath: string | null;
  probes: PathProbeResult[];
}

export interface LibraryAccessOptions {
  timeoutMs?: number;
  runner?: ProbeRunner;
}

/** Startup gate output: what to print, and whether to stop. */
export interface LibraryStartupGate {
  exitCode: number;
  lines: string[];
}

/** Marker so a probe failure is distinguishable from any other stderr text. */
const PROBE_ARGV0 = "lighthouse-library-probe";

/**
 * One bounded directory read. `exec` keeps the child a single process: there is
 * never a grandchild that could outlive the SIGKILL, so the deadline always
 * takes effect.
 */
export function directoryProbeArgv(dir: string): string[] {
  return ["/bin/sh", "-c", 'exec /bin/ls -1 "$1"', PROBE_ARGV0, dir];
}

/**
 * One bounded file read of the catalog database header. Reads a few bytes only:
 * the question is whether the volume answers at all, not how big the file is.
 */
export function fileProbeArgv(filePath: string): string[] {
  return ["/bin/sh", "-c", 'exec /usr/bin/head -c 16 "$1"', PROBE_ARGV0, filePath];
}

/** Resolve the probe deadline, honouring the documented env override. */
export function resolveProbeTimeoutMs(
  override?: number,
  env: NodeJS.ProcessEnv = process.env,
): number {
  if (typeof override === "number" && Number.isFinite(override) && override > 0) {
    return Math.floor(override);
  }
  const raw = env[LIBRARY_PROBE_TIMEOUT_ENV];
  const parsed = raw ? Number.parseInt(raw, 10) : Number.NaN;
  if (Number.isFinite(parsed) && parsed > 0) return parsed;
  return DEFAULT_LIBRARY_PROBE_TIMEOUT_MS;
}

/**
 * Default runner: spawn the probe, race it against the deadline, and SIGKILL it
 * when the deadline wins. A child blocked in `openat` cannot be relied upon to
 * react to SIGTERM, so the kill is unconditional and the wait afterwards is
 * bounded too.
 */
export const spawnProbe: ProbeRunner = async (argv, timeoutMs) => {
  let child: ReturnType<typeof Bun.spawn>;
  try {
    child = Bun.spawn(argv, {
      stdin: "ignore",
      stdout: "ignore",
      stderr: "pipe",
    });
  } catch (err) {
    return {
      timedOut: false,
      code: null,
      stderr: err instanceof Error ? err.message : String(err),
    };
  }

  // Drain stderr concurrently: reading it after exit can deadlock a full pipe.
  const stderrPromise: Promise<string> = child.stderr
    ? new Response(child.stderr as ReadableStream<Uint8Array>)
        .text()
        .catch(() => "")
    : Promise.resolve("");

  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<"timeout">((resolve) => {
    timer = setTimeout(() => resolve("timeout"), timeoutMs);
  });
  const exited = child.exited.then(() => "exited" as const).catch(() => "exited" as const);
  const reached = await Promise.race([exited, deadline]);
  if (timer) clearTimeout(timer);
  const timedOut = reached === "timeout";

  if (timedOut) {
    try {
      child.kill(9);
    } catch {
      // Already gone; the deadline verdict stands either way.
    }
    return { timedOut: true, code: null, stderr: "" };
  }

  const code = await child.exited;
  const stderr = await stderrPromise;
  return { timedOut: false, code, stderr };
};

/**
 * Classify one probe run.
 *
 * `Operation not permitted` is the removable-volume denial (EPERM); `Permission
 * denied` is the same class of refusal from a plain permission check. A run that
 * never came back is reported as `unresponsive` rather than guessed at, because
 * both an unanswering device and a pending TCC consent look identical from here.
 */
export function classifyProbeRun(
  run: ProbeRun,
  target: string,
  timeoutMs: number,
): PathProbeResult {
  if (run.timedOut) {
    return {
      status: "unresponsive",
      target,
      timeoutMs,
      detail:
        `no answer within ${timeoutMs}ms; the probe child was killed while ` +
        "blocked in the filesystem call",
    };
  }
  const detail = run.stderr.trim();
  if (run.code === 0) {
    return { status: "ok", target, timeoutMs, detail };
  }
  if (/operation not permitted/i.test(detail) || /permission denied/i.test(detail)) {
    return { status: "permission-denied", target, timeoutMs, detail };
  }
  if (/no such file or directory/i.test(detail)) {
    return { status: "missing", target, timeoutMs, detail };
  }
  return {
    status: "error",
    target,
    timeoutMs,
    detail: detail || `probe exited with code ${run.code ?? "unknown"}`,
  };
}

/** Probe one path through the injectable runner. */
export async function probePath(
  target: string,
  kind: "directory" | "file",
  options: LibraryAccessOptions = {},
): Promise<PathProbeResult> {
  const timeoutMs = resolveProbeTimeoutMs(options.timeoutMs);
  const runner = options.runner ?? spawnProbe;
  const argv = kind === "directory" ? directoryProbeArgv(target) : fileProbeArgv(target);
  let run: ProbeRun;
  try {
    run = await runner(argv, timeoutMs);
  } catch (err) {
    run = {
      timedOut: false,
      code: null,
      stderr: err instanceof Error ? err.message : String(err),
    };
  }
  return classifyProbeRun(run, target, timeoutMs);
}

const SEVERITY: Record<Exclude<PathProbeStatus, "ok"> | "ok", number> = {
  ok: 0,
  missing: 1,
  error: 2,
  "permission-denied": 3,
  unresponsive: 4,
};

/**
 * Probe everything the library needs: the library root, then the catalog
 * database only if the root answered. Probing the database after a failed root
 * probe would only queue a second child that cannot succeed either.
 */
export async function checkLibraryAccess(
  targets: { libraryDir: string; dbPath?: string | null },
  options: LibraryAccessOptions = {},
): Promise<LibraryAccessReport> {
  const dbPath = targets.dbPath ?? null;
  const probes: PathProbeResult[] = [];

  const dirProbe = await probePath(targets.libraryDir, "directory", options);
  probes.push(dirProbe);

  if (dbPath && dirProbe.status === "ok") {
    probes.push(await probePath(dbPath, "file", options));
  }

  let status: LibraryAccessReport["status"] = "ok";
  for (const probe of probes) {
    if (SEVERITY[probe.status] > SEVERITY[status]) status = probe.status;
  }

  return { status, libraryDir: targets.libraryDir, dbPath, probes };
}

/** True when the report means "stop instead of serving nothing". */
export function isFatalLibraryStatus(status: LibraryAccessReport["status"]): boolean {
  return status !== "ok";
}

/**
 * Build the operator-facing explanation. Only a readable library has nothing to
 * report; every other verdict names the cause that was actually observed, then
 * both remedies in the order they are worth trying: move the library onto local
 * storage (robust) or grant the TCC entitlement (fragile).
 */
export function describeLibraryAccessFailure(report: LibraryAccessReport): string[] {
  if (report.status === "ok") return [];

  const failing = report.probes.filter((probe) => probe.status !== "ok");
  const lines: string[] = [];

  if (report.status === "unresponsive") {
    lines.push(
      "[Server] Fatal: the Calibre library did not answer and the probe was killed.",
    );
    lines.push(
      "  The filesystem call never returned, so this process would have hung " +
        "instead of serving HTTP.",
    );
    lines.push(
      "  That is either an unresponsive external volume, or a macOS TCC consent " +
        "request for a removable volume that nothing can answer.",
    );
  } else if (report.status === "permission-denied") {
    lines.push(
      "[Server] Fatal: macOS refused access to the Calibre library " +
        "(Operation not permitted).",
    );
    lines.push(
      "  A launchd-spawned process is its own TCC client and holds no " +
        "removable-volume entitlement, so it cannot read a library that lives on " +
        "an external volume.",
    );
  } else if (report.status === "error") {
    lines.push("[Server] Fatal: the Calibre library could not be read.");
  } else if (report.status === "missing") {
    lines.push(
      "[Server] Fatal: the Calibre library is not present, so this process " +
        "cannot serve a catalog.",
    );
    lines.push(
      "  Nothing is mounted at the library path, or an external volume mounted " +
        "after this agent started and left the path dangling. The gate runs once " +
        "at startup and never retries, so the process exits here instead of " +
        "binding its port with no catalog.",
    );
  }

  for (const probe of failing) {
    lines.push(`  ${probe.status}: ${probe.target} (${probe.detail})`);
  }

  lines.push("  Remedies, in order of durability:");
  lines.push(
    "   1. Move the live library onto local storage and keep the external " +
      "volume as a backup target only (recommended: no TCC dependency, and it " +
      "survives reboots and runtime upgrades).",
  );
  lines.push(
    "   2. Grant the runtime Full Disk Access in System Settings -> Privacy & " +
      "Security -> Full Disk Access (fragile: the grant is keyed to the " +
      "binary's hash and is lost on every upgrade), and confirm the volume is " +
      "mounted and actually answering I/O.",
  );
  lines.push(
    `  Probe deadline: ${failing[0]?.timeoutMs ?? resolveProbeTimeoutMs()}ms ` +
      `(override with ${LIBRARY_PROBE_TIMEOUT_ENV}).`,
  );

  return lines;
}

/**
 * Startup gate: the whole decision in one call, so the entry point stays a
 * three-line wiring and the behaviour is testable without spawning the server.
 */
export async function evaluateLibraryStartupGate(
  targets: { libraryDir: string; dbPath?: string | null },
  options: LibraryAccessOptions = {},
): Promise<LibraryStartupGate> {
  const report = await checkLibraryAccess(targets, options);
  const lines = describeLibraryAccessFailure(report);
  return { exitCode: isFatalLibraryStatus(report.status) ? 1 : 0, lines };
}

/**
 * Render the gate for the operator log, one verdict/detail/remedy per line. A
 * readable library renders nothing at all: the gate only has something to say
 * when something failed.
 */
export function formatStartupGateMessage(gate: LibraryStartupGate): string | null {
  if (gate.lines.length === 0) return null;
  return gate.lines.join("\n");
}
