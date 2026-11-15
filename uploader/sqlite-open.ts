/**
 * Shared SQLite startup helper.
 *
 * Every process in this project (the Reading HQ server, the Telegram bot, the
 * durable job queue, backup tooling) opens the same `cache.db`. On a cold
 * start - or right after a crash, when a hot `-wal` file still needs recovery -
 * SQLite needs an exclusive lock to switch the database into WAL mode.
 *
 * Two ordering rules make startup race-free:
 *
 *  1. `PRAGMA busy_timeout` MUST be set BEFORE `PRAGMA journal_mode = WAL`.
 *     The WAL switch takes a lock, and without a busy handler installed the
 *     very first contention returns `SQLITE_BUSY` / `SQLITE_BUSY_RECOVERY`
 *     immediately. Setting the timeout afterwards means it never applies to
 *     the statement that actually needs it, which is exactly how a second
 *     process used to die on startup.
 *
 *  2. The WAL switch (and the open itself) MUST be retried a bounded number of
 *     times. `SQLITE_BUSY_RECOVERY` means another connection is mid-recovery
 *     of a hot WAL; that is transient, but it can outlast a single retry, so we
 *     back off and try again several times before giving up. Waiting is the
 *     only correct answer here - there is no start order to enforce, and
 *     whichever process arrives second must still come up.
 *
 * If the database genuinely cannot be opened, these helpers throw. Callers at
 * process start must let that failure terminate the process with a non-zero
 * exit rather than binding a port and serving nothing.
 */
import { Database } from "bun:sqlite";

/** Default `PRAGMA busy_timeout` for writable connections, in milliseconds. */
export const DEFAULT_BUSY_TIMEOUT_MS = 5000;

/** How many times a busy/locked WAL switch (or open) is retried. */
export const DEFAULT_WAL_RETRY_ATTEMPTS = 8;

/** First backoff delay between WAL retries, in milliseconds. */
export const DEFAULT_WAL_RETRY_BASE_DELAY_MS = 150;

/** Upper bound for a single backoff delay between WAL retries, in milliseconds. */
export const DEFAULT_WAL_RETRY_MAX_DELAY_MS = 1500;

export interface SqliteStartupOptions {
  /** `PRAGMA busy_timeout` value in milliseconds. Defaults to 5000. */
  busyTimeoutMs?: number;
  /** Total attempts for a busy/locked open or WAL switch. Defaults to 8. */
  retryAttempts?: number;
  /** First retry backoff, in milliseconds. Defaults to 150. */
  retryBaseDelayMs?: number;
  /** Maximum retry backoff, in milliseconds. Defaults to 1500. */
  retryMaxDelayMs?: number;
  /** Blocking sleep implementation. Injectable so tests stay fast. */
  sleep?: (ms: number) => void;
  /** Called before each retry, for structured startup logging. */
  onRetry?: (info: { attempt: number; delayMs: number; error: unknown }) => void;
}

/** SQLite error codes that represent transient lock contention. */
const BUSY_CODES = new Set([
  "SQLITE_BUSY",
  "SQLITE_BUSY_RECOVERY",
  "SQLITE_BUSY_SNAPSHOT",
  "SQLITE_BUSY_TIMEOUT",
  "SQLITE_LOCKED",
  "SQLITE_LOCKED_SHAREDCACHE",
]);

/** Minimal shape of a thrown SQLite error; both fields are optional. */
interface SqliteErrorLike {
  code?: unknown;
  message?: unknown;
}

/** True when an error is SQLite transient lock contention worth retrying. */
export function isSqliteBusyError(err: unknown): boolean {
  if (err && typeof err === "object") {
    const { code, message } = err as SqliteErrorLike;
    if (typeof code === "string" && BUSY_CODES.has(code.toUpperCase())) return true;
    if (typeof message === "string" && /SQLITE_BUSY|SQLITE_LOCKED/i.test(message)) {
      return true;
    }
  }
  const text = typeof err === "string" ? err : String((err as Error | undefined)?.message ?? "");
  return /SQLITE_BUSY|SQLITE_LOCKED|database is locked|database table is locked/i.test(text);
}

/** The subset of `Bun` used here, so the global access is not `any`. */
interface BunGlobals {
  Bun?: { sleepSync?: (ms: number) => void };
}

/** Blocking sleep. Startup is synchronous, so this must not be async. */
export function sleepSync(ms: number): void {
  if (ms <= 0) return;
  const bunSleep = (globalThis as BunGlobals).Bun?.sleepSync;
  if (typeof bunSleep === "function") {
    bunSleep(ms);
    return;
  }
  const view = new Int32Array(new SharedArrayBuffer(4));
  Atomics.wait(view, 0, 0, ms);
}

interface ResolvedOptions {
  busyTimeoutMs: number;
  retryAttempts: number;
  retryBaseDelayMs: number;
  retryMaxDelayMs: number;
  sleep: (ms: number) => void;
  onRetry?: (info: { attempt: number; delayMs: number; error: unknown }) => void;
}

function resolveOptions(options?: SqliteStartupOptions): ResolvedOptions {
  const retryAttempts = Math.max(1, options?.retryAttempts ?? DEFAULT_WAL_RETRY_ATTEMPTS);
  return {
    busyTimeoutMs: Math.max(0, options?.busyTimeoutMs ?? DEFAULT_BUSY_TIMEOUT_MS),
    retryAttempts,
    retryBaseDelayMs: Math.max(0, options?.retryBaseDelayMs ?? DEFAULT_WAL_RETRY_BASE_DELAY_MS),
    retryMaxDelayMs: Math.max(0, options?.retryMaxDelayMs ?? DEFAULT_WAL_RETRY_MAX_DELAY_MS),
    sleep: options?.sleep ?? sleepSync,
    onRetry: options?.onRetry,
  };
}

function backoffDelay(attempt: number, opts: ResolvedOptions): number {
  const exponential = opts.retryBaseDelayMs * 2 ** (attempt - 1);
  return Math.min(exponential, opts.retryMaxDelayMs);
}

/**
 * Runs `action`, retrying while SQLite reports transient lock contention.
 * Any other error propagates immediately - corruption or permission failures
 * are not fixed by waiting.
 */
export function retryWhileSqliteBusy<T>(
  action: () => T,
  options?: SqliteStartupOptions,
): T {
  const opts = resolveOptions(options);
  let lastError: unknown;
  for (let attempt = 1; attempt <= opts.retryAttempts; attempt++) {
    try {
      return action();
    } catch (err) {
      if (!isSqliteBusyError(err)) throw err;
      lastError = err;
      if (attempt === opts.retryAttempts) break;
      const delayMs = backoffDelay(attempt, opts);
      try {
        opts.onRetry?.({ attempt, delayMs, error: err });
      } catch {
        // Startup logging must never mask the real failure.
      }
      opts.sleep(delayMs);
    }
  }
  throw lastError;
}

/**
 * True for an already-open handle that lives entirely in memory.
 *
 * SQLite reports an empty `main` file in `PRAGMA database_list` for in-memory
 * databases and a real path for file-backed ones, so this needs no unsafe
 * access to driver internals.
 */
export function isInMemoryDatabase(db: Database): boolean {
  try {
    const rows = db.query("PRAGMA database_list;").all() as Array<{
      name?: string;
      file?: string;
    }>;
    const main = rows.find((r) => r?.name === "main");
    if (main) return !main.file;
  } catch {
    // If the pragma cannot run, fall through and assume a file-backed database
    // so the caller still attempts WAL rather than silently skipping it.
  }
  return false;
}

/**
 * Applies the writable-connection startup pragmas to an already-open handle:
 * `busy_timeout` first, then WAL with bounded retry.
 *
 * In-memory databases get `busy_timeout` and skip WAL entirely - WAL cannot be
 * enabled for them, and that is not an error.
 *
 * Safe to call on a handle that is already in WAL mode; the pragma is then a
 * cheap no-op that still honours the busy handler.
 */
export function applyWritableStartupPragmas(
  db: Database,
  options?: SqliteStartupOptions,
): { journalMode: string; retries: number; inMemory: boolean } {
  const opts = resolveOptions(options);
  db.run(`PRAGMA busy_timeout = ${opts.busyTimeoutMs};`);

  if (isInMemoryDatabase(db)) {
    // No lock contention is possible and WAL is undefined; do not attempt the
    // switch and do not treat the resulting `memory` journal as a failure.
    const memRow = db.query("PRAGMA journal_mode;").get() as { journal_mode?: string } | null;
    return {
      journalMode: String(memRow?.journal_mode ?? "memory").toLowerCase(),
      retries: 0,
      inMemory: true,
    };
  }

  let retries = 0;
  let journalMode = "";
  retryWhileSqliteBusy(
    () => {
      db.run("PRAGMA journal_mode = WAL;");
      // A refused switch is signalled by the previous mode coming back, not by
      // a thrown error, so the mode must be read inside the retried action.
      const row = db.query("PRAGMA journal_mode;").get() as { journal_mode?: string } | null;
      journalMode = String(row?.journal_mode ?? "").toLowerCase();
      if (journalMode !== "wal") {
        // A real file-backed database that cannot reach WAL is a genuine
        // startup failure: the process must not come up half-ready.
        throw new Error(
          "SQLITE_BUSY: SQLite refused to switch to WAL mode " +
            `(journal_mode=${journalMode || "unknown"}). ` +
            "Writable startup requires a WAL-capable database file.",
        );
      }
    },
    {
      ...options,
      onRetry: (info) => {
        retries = info.attempt;
        options?.onRetry?.(info);
      },
    },
  );

  return { journalMode, retries, inMemory: false };
}

/**
 * Opens a database for a long-lived process: retries a busy open, installs
 * `busy_timeout` before switching to WAL, and retries the switch.
 *
 * Throws (closing the handle first) when the database genuinely cannot be
 * prepared, so callers can exit non-zero instead of running half-ready.
 */
export function openSqliteForStartup(
  dbPath: string,
  options?: SqliteStartupOptions,
): Database {
  let db: Database | null = null;
  try {
    db = retryWhileSqliteBusy(() => new Database(dbPath), options);
    applyWritableStartupPragmas(db, options);
    return db;
  } catch (err) {
    try {
      db?.close();
    } catch {
      // Ignore close failures; the original error is the useful one.
    }
    throw err;
  }
}
