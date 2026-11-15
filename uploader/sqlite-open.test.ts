import { describe, expect, it } from "bun:test";
import { Database } from "bun:sqlite";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  DEFAULT_BUSY_TIMEOUT_MS,
  applyWritableStartupPragmas,
  isInMemoryDatabase,
  isSqliteBusyError,
  openSqliteForStartup,
  retryWhileSqliteBusy,
} from "./sqlite-open";

/**
 * Regression coverage for the uploader/bot restart race.
 *
 * The Reading HQ server and the Telegram bot both open cache.db at start.
 * The original code ran `PRAGMA journal_mode = WAL` BEFORE `PRAGMA
 * busy_timeout`, so the WAL switch had no busy handler and whichever process
 * arrived second died instantly with SQLITE_BUSY / SQLITE_BUSY_RECOVERY,
 * leaving a launchd KeepAlive respawn loop.
 */

function tmpDbPath(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "lighthouse-sqlite-open-"));
  return path.join(dir, "cache.db");
}

function cleanup(dbPath: string) {
  for (const suffix of ["", "-wal", "-shm"]) {
    try {
      fs.rmSync(dbPath + suffix, { force: true });
    } catch {
      /* ignore */
    }
  }
  try {
    fs.rmSync(path.dirname(dbPath), { recursive: true, force: true });
  } catch {
    /* ignore */
  }
}

async function waitForFile(filePath: string, timeoutMs = 15000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (fs.existsSync(filePath)) return true;
    await Bun.sleep(5);
  }
  return false;
}

/**
 * Child process that holds a real write lock on a rollback-journal database
 * for `holdMs` and then commits and disconnects - the state whichever process
 * arrives second at startup used to die on.
 */
const LOCK_HOLDER_SCRIPT = `
import fs from "node:fs";
import { Database } from "bun:sqlite";
const [, , dbPath, readyFlag, holdMs] = process.argv;
const db = new Database(dbPath);
db.run("CREATE TABLE IF NOT EXISTS holder (id INTEGER PRIMARY KEY, v TEXT);");
db.run("BEGIN IMMEDIATE;");
db.run("INSERT INTO holder (v) VALUES ('held');");
fs.writeFileSync(readyFlag, "ready");
await Bun.sleep(Number(holdMs));
db.run("COMMIT;");
db.close();
`;

describe("sqlite-open: startup pragma ordering", () => {
  it("installs busy_timeout before switching to WAL", () => {
    const dbPath = tmpDbPath();
    let db: Database | null = null;
    try {
      db = new Database(dbPath);
      applyWritableStartupPragmas(db);

      expect((db.query("PRAGMA journal_mode;").get() as any)?.journal_mode).toBe("wal");
      expect((db.query("PRAGMA busy_timeout;").get() as any)?.timeout).toBe(
        DEFAULT_BUSY_TIMEOUT_MS,
      );
    } finally {
      db?.close();
      cleanup(dbPath);
    }
  });

  it("has the busy handler armed at the moment the WAL switch is attempted", () => {
    const dbPath = tmpDbPath();
    let db: Database | null = null;
    try {
      db = new Database(dbPath);
      const realRun = db.run.bind(db);
      const timeoutAtSwitch: number[] = [];
      (db as any).run = (sql: string, ...rest: any[]) => {
        if (/journal_mode\s*=\s*WAL/i.test(sql)) {
          // Observe what SQLite reports for the installed busy handler at the
          // exact moment the switch statement runs.
          const row = db!.query("PRAGMA busy_timeout;").get() as { timeout?: number } | null;
          timeoutAtSwitch.push(Number(row?.timeout ?? -1));
        }
        return realRun(sql, ...rest);
      };

      applyWritableStartupPragmas(db);

      expect(timeoutAtSwitch).toEqual([DEFAULT_BUSY_TIMEOUT_MS]);
    } finally {
      db?.close();
      cleanup(dbPath);
    }
  });

  it("opens a prepared WAL database with the busy handler already set", () => {
    const dbPath = tmpDbPath();
    let db: Database | null = null;
    try {
      db = openSqliteForStartup(dbPath);
      expect((db.query("PRAGMA journal_mode;").get() as any)?.journal_mode).toBe("wal");
      expect((db.query("PRAGMA busy_timeout;").get() as any)?.timeout).toBe(
        DEFAULT_BUSY_TIMEOUT_MS,
      );
    } finally {
      db?.close();
      cleanup(dbPath);
    }
  });

  it("is idempotent across repeated opens of the same file", () => {
    const dbPath = tmpDbPath();
    let a: Database | null = null;
    let b: Database | null = null;
    try {
      a = openSqliteForStartup(dbPath);
      b = openSqliteForStartup(dbPath);
      expect((b.query("PRAGMA journal_mode;").get() as any)?.journal_mode).toBe("wal");
    } finally {
      a?.close();
      b?.close();
      cleanup(dbPath);
    }
  });
});

describe("sqlite-open: second opener survives a WAL-holding connection", () => {
  it("does not fail when another connection already holds the database in WAL mode", () => {
    const dbPath = tmpDbPath();
    let holder: Database | null = null;
    let second: Database | null = null;
    try {
      // First opener: exactly what the server or bot does at startup.
      holder = openSqliteForStartup(dbPath);
      holder.run(
        "CREATE TABLE IF NOT EXISTS file_hashes (filepath TEXT PRIMARY KEY, mtime INTEGER, hash TEXT);",
      );
      // Keep an uncheckpointed write in the WAL so the file is genuinely hot
      // (this is the state a crash leaves behind).
      holder.run("PRAGMA wal_autocheckpoint = 0;");
      holder.run("INSERT OR REPLACE INTO file_hashes VALUES ('a', 1, 'h1');");

      // Second opener races the same file while the first still holds it.
      expect(() => {
        second = openSqliteForStartup(dbPath);
      }).not.toThrow();

      expect(second!.query("SELECT filepath FROM file_hashes;").all()).toEqual([
        { filepath: "a" },
      ]);
      expect((second!.query("PRAGMA journal_mode;").get() as any)?.journal_mode).toBe("wal");
    } finally {
      holder?.close();
      second?.close();
      cleanup(dbPath);
    }
  });

  it("opens many handles against one hot WAL database", () => {
    const dbPath = tmpDbPath();
    const dbs: Database[] = [];
    try {
      const writer = openSqliteForStartup(dbPath);
      writer.run(
        "CREATE TABLE IF NOT EXISTS t (id INTEGER PRIMARY KEY, v TEXT);",
      );
      writer.run("PRAGMA wal_autocheckpoint = 0;");
      for (let i = 0; i < 100; i++) {
        writer.run("INSERT INTO t (v) VALUES (?)", [`row-${i}`.padEnd(200, "x")]);
      }

      // Eight successive startup openers against the same hot file: none may fail.
      for (let i = 0; i < 8; i++) {
        dbs.push(openSqliteForStartup(dbPath));
      }
      for (const db of dbs) {
        expect((db.query("PRAGMA journal_mode;").get() as any)?.journal_mode).toBe("wal");
      }

      writer.close();
    } finally {
      for (const db of dbs) {
        try {
          db.close();
        } catch {
          /* ignore */
        }
      }
      cleanup(dbPath);
    }
  });
});

describe("sqlite-open: second opener survives a cold lock held by another process", () => {
  it("waits out a real cross-process write lock on a rollback-mode file and still reaches WAL", async () => {
    const dbPath = tmpDbPath();
    const dir = path.dirname(dbPath);
    const holderScript = path.join(dir, "lock-holder.ts");
    const readyFlag = path.join(dir, "lock-holder.ready");
    fs.writeFileSync(holderScript, LOCK_HOLDER_SCRIPT);

    const child = Bun.spawn(["bun", holderScript, dbPath, readyFlag, "300"], {
      stdout: "ignore",
      stderr: "ignore",
    });

    let second: Database | null = null;
    try {
      // The flag is written only after BEGIN IMMEDIATE, so the lock is held
      // before this process starts opening the file.
      expect(await waitForFile(readyFlag)).toBe(true);

      const startedAt = Date.now();
      second = openSqliteForStartup(dbPath);
      const elapsedMs = Date.now() - startedAt;

      const exitCode = await child.exited;
      expect(exitCode).toBe(0);

      expect((second.query("PRAGMA journal_mode;").get() as any)?.journal_mode).toBe("wal");
      expect(second.query("SELECT v FROM holder;").all()).toEqual([{ v: "held" }]);
      // Proves this process really waited for the other one to release instead
      // of opening a database nobody was holding.
      expect(elapsedMs).toBeGreaterThanOrEqual(100);
    } finally {
      if (child.exitCode === null) child.kill();
      second?.close();
      cleanup(dbPath);
    }
  });
});

describe("sqlite-open: in-memory databases are first-class, not failures", () => {
  // WAL is impossible for an in-memory database, so the startup helper must
  // never treat `journal_mode=memory` as a reason to throw. Test harnesses and
  // the job-queue tests rely on this.
  it("detects in-memory databases by handle", () => {
    const mem = new Database(":memory:");
    const empty = new Database("");
    const dbPath = tmpDbPath();
    let file: Database | null = null;
    try {
      file = new Database(dbPath);
      expect(isInMemoryDatabase(mem)).toBe(true);
      expect(isInMemoryDatabase(empty)).toBe(true);
      expect(isInMemoryDatabase(file)).toBe(false);
    } finally {
      mem.close();
      empty.close();
      file?.close();
      cleanup(dbPath);
    }
  });

  it("does not throw for a :memory: handle and still sets busy_timeout", () => {
    const mem = new Database(":memory:");
    try {
      const result = applyWritableStartupPragmas(mem);
      expect(result.inMemory).toBe(true);
      // The journal stays `memory` - that is correct, not a failure.
      expect(result.journalMode).toBe("memory");
      expect((mem.query("PRAGMA busy_timeout;").get() as any)?.timeout).toBe(
        DEFAULT_BUSY_TIMEOUT_MS,
      );
      // The handle is still perfectly usable.
      mem.run("CREATE TABLE t (id INTEGER);");
      mem.run("INSERT INTO t VALUES (1);");
      expect(mem.query("SELECT id FROM t;").all()).toEqual([{ id: 1 }]);
    } finally {
      mem.close();
    }
  });

  it("never attempts the WAL switch for :memory: (no retry, no throw)", () => {
    const mem = new Database(":memory:");
    const retries: number[] = [];
    try {
      const result = applyWritableStartupPragmas(mem, {
        sleep: () => {},
        onRetry: (info) => retries.push(info.attempt),
      });
      expect(result.retries).toBe(0);
      expect(retries).toEqual([]);
    } finally {
      mem.close();
    }
  });

  it("also opens an empty-path (temp) database without throwing", () => {
    const db = openSqliteForStartup("");
    try {
      expect((db.query("PRAGMA busy_timeout;").get() as any)?.timeout).toBe(
        DEFAULT_BUSY_TIMEOUT_MS,
      );
      db.run("CREATE TABLE t (id INTEGER);");
      expect(db.query("SELECT name FROM sqlite_master;").all()).toEqual([{ name: "t" }]);
    } finally {
      db.close();
    }
  });

  it("opens a :memory: path without throwing", () => {
    const db = openSqliteForStartup(":memory:");
    try {
      expect((db.query("PRAGMA busy_timeout;").get() as any)?.timeout).toBe(
        DEFAULT_BUSY_TIMEOUT_MS,
      );
      db.run("CREATE TABLE t (id INTEGER);");
      expect(db.query("SELECT name FROM sqlite_master;").all()).toEqual([{ name: "t" }]);
    } finally {
      db.close();
    }
  });

  it("STILL fails loudly for a file-backed database that cannot reach WAL", () => {
    const dbPath = tmpDbPath();
    let db: Database | null = null;
    const retries: number[] = [];
    try {
      db = new Database(dbPath);
      // Simulate a file-backed database that refuses to enter WAL mode.
      const realRun = db.run.bind(db);
      (db as any).run = (sql: string, ...rest: any[]) => {
        if (sql.includes("journal_mode = WAL")) {
          // Pretend the switch silently reports `delete`.
          return realRun("PRAGMA journal_mode = DELETE;", ...rest);
        }
        return realRun(sql, ...rest);
      };

      const err = (() => {
        try {
          applyWritableStartupPragmas(db!, {
            sleep: () => {},
            retryAttempts: 3,
            onRetry: (info) => retries.push(info.attempt),
          });
          return null;
        } catch (e) {
          return e as Error;
        }
      })();

      expect(err?.message).toMatch(/refused to switch to WAL mode/);
      // A silently refused switch is transient like SQLITE_BUSY, so it must be
      // retried up to the attempt bound instead of failing on the first try.
      expect(retries).toEqual([1, 2]);
    } finally {
      db?.close();
      cleanup(dbPath);
    }
  });
});

describe("sqlite-open: busy detection and bounded retry", () => {
  it("recognises SQLite lock contention errors", () => {
    expect(isSqliteBusyError(new Error("database is locked"))).toBe(true);
    expect(isSqliteBusyError(new Error("SQLITE_BUSY_RECOVERY"))).toBe(true);
    expect(isSqliteBusyError(new Error("database table is locked"))).toBe(true);
    expect(isSqliteBusyError({ code: "SQLITE_BUSY" })).toBe(true);
    expect(isSqliteBusyError(new Error("no such table: nope"))).toBe(false);
    expect(isSqliteBusyError(new Error("database disk image is malformed"))).toBe(false);
  });

  it("retries transient contention and then succeeds", () => {
    let calls = 0;
    const sleeps: number[] = [];
    const result = retryWhileSqliteBusy(
      () => {
        calls++;
        if (calls < 3) throw new Error("database is locked");
        return "ok";
      },
      { sleep: (ms) => sleeps.push(ms), retryBaseDelayMs: 10, retryMaxDelayMs: 100 },
    );

    expect(result).toBe("ok");
    expect(calls).toBe(3);
    // Exponential backoff: 10ms then 20ms.
    expect(sleeps).toEqual([10, 20]);
  });

  it("does not retry non-busy errors", () => {
    let calls = 0;
    expect(() =>
      retryWhileSqliteBusy(
        () => {
          calls++;
          throw new Error("database disk image is malformed");
        },
        { sleep: () => {} },
      ),
    ).toThrow("database disk image is malformed");
    expect(calls).toBe(1);
  });

  it("gives up after the bounded attempt count and rethrows the busy error", () => {
    let calls = 0;
    const sleeps: number[] = [];
    expect(() =>
      retryWhileSqliteBusy(
        () => {
          calls++;
          throw new Error("database is locked");
        },
        {
          retryAttempts: 4,
          sleep: (ms) => sleeps.push(ms),
          retryBaseDelayMs: 10,
          retryMaxDelayMs: 15,
        },
      ),
    ).toThrow("database is locked");
    expect(calls).toBe(4);
    // Backoff is capped by retryMaxDelayMs.
    expect(sleeps).toEqual([10, 15, 15]);
  });

  it("retries the WAL switch when the first attempt sees SQLITE_BUSY", () => {
    const dbPath = tmpDbPath();
    let db: Database | null = null;
    const retries: number[] = [];
    try {
      db = new Database(dbPath);
      // Wrap run so the very first WAL switch fails like a recovery race.
      const realRun = db.run.bind(db);
      let failedOnce = false;
      (db as any).run = (sql: string, ...rest: any[]) => {
        if (sql.includes("journal_mode = WAL") && !failedOnce) {
          failedOnce = true;
          throw new Error("database is locked");
        }
        return realRun(sql, ...rest);
      };

      const result = applyWritableStartupPragmas(db, {
        sleep: () => {},
        retryBaseDelayMs: 1,
        onRetry: (info) => retries.push(info.attempt),
      });

      expect(result.journalMode).toBe("wal");
      expect(retries).toEqual([1]);
    } finally {
      db?.close();
      cleanup(dbPath);
    }
  });
});
