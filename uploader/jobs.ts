// @ts-expect-error
import { Database } from "bun:sqlite";
import crypto from "node:crypto";
import fs from "node:fs";
// @ts-expect-error
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { sanitizeErrorMessage, getCacheDb } from "./security";

export const DEFAULT_JOBS_DB_PATH =
  process.env.JOBS_DB_PATH ||
  process.env.CACHE_DB_PATH ||
  path.join(os.tmpdir(), "reading-hq", "cache.db");
export const CALIBRE_LOCK_FILE =
  process.env.CALIBRE_LOCK_FILE || path.join(os.tmpdir(), "calibre_execution.lock");

export type JobType =
  | "file_ingest"
  | "archive_ingest"
  | "archive_extract"
  | "url_ingest"
  | "url_article_ingest"
  | "metadata_enrich"
  | "cover_backfill";

export type JobStatus = "pending" | "processing" | "completed" | "failed";

export interface JobRecord<T = any, R = any> {
  id: string;
  type: JobType;
  payload: T;
  status: JobStatus;
  retries: number;
  max_retries: number;
  created_at: number;
  updated_at: number;
  next_run_at: number;
  result: R | null;
  error: string | null;
  worker_id?: string | null;
  lease_expires_at?: number | null;
  heartbeat_at?: number | null;
}

export type JobHandler<T = any, R = any> = (
  payload: T,
  job: JobRecord<T, R>,
) => Promise<R>;

// ---------------------------------------------------------------------------
// Global Calibre Execution Mutex & Cross-Process Lock
// ---------------------------------------------------------------------------

class AsyncMutex {
  private queue: Array<() => void> = [];
  private locked = false;

  acquire(): Promise<() => void> {
    return new Promise((resolve) => {
      const release = () => {
        if (this.queue.length > 0) {
          const next = this.queue.shift()!;
          next();
        } else {
          this.locked = false;
        }
      };

      if (this.locked) {
        this.queue.push(() => resolve(release));
      } else {
        this.locked = true;
        resolve(release);
      }
    });
  }
}

const globalCalibreMutex = new AsyncMutex();

/**
 * Global Calibre execution lock/queue.
 * Protects against concurrent `calibredb` write operations both in-process
 * and across separate processes (web server, telegram bot, background queue).
 */
export async function withCalibreLock<T>(fn: () => Promise<T> | T): Promise<T> {
  const releaseInProcess = await globalCalibreMutex.acquire();

  let fd: number | null = null;
  const startTime = Date.now();
  const maxWaitMs = 60000;

  try {
    while (Date.now() - startTime < maxWaitMs) {
      try {
        fd = fs.openSync(
          CALIBRE_LOCK_FILE,
          fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_RDWR,
        );
        fs.writeSync(fd, String(process.pid));
        break;
      } catch (err: any) {
        if (err.code === "EEXIST") {
          // Check for stale lock file older than 60 seconds
          try {
            const stat = fs.statSync(CALIBRE_LOCK_FILE);
            if (Date.now() - stat.mtimeMs > 60000) {
              try {
                fs.unlinkSync(CALIBRE_LOCK_FILE);
              } catch (_unlinkErr) {
                void _unlinkErr;
              }
              continue;
            }
          } catch {
            continue;
          }
          await new Promise((r) => setTimeout(r, 100));
        } else {
          throw err;
        }
      }
    }

    if (fd === null) {
      throw new Error("Timed out waiting to acquire Calibre lock file");
    }

    return await fn();
  } finally {
    if (fd !== null) {
      try {
        fs.closeSync(fd);
      } catch (_closeErr) {
        void _closeErr;
      }
      try {
        if (fs.existsSync(CALIBRE_LOCK_FILE)) {
          fs.unlinkSync(CALIBRE_LOCK_FILE);
        }
      } catch (_unlinkErr) {
        void _unlinkErr;
      }
    }
    releaseInProcess();
  }
}

/**
 * Synchronous variant of global Calibre execution lock.
 * Uses atomic file locking with bounded retry.
 */
export function withCalibreLockSync<T>(fn: () => T): T {
  let fd: number | null = null;
  const startTime = Date.now();
  const maxWaitMs = 30000;

  while (Date.now() - startTime < maxWaitMs) {
    try {
      fd = fs.openSync(
        CALIBRE_LOCK_FILE,
        fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_RDWR,
      );
      fs.writeSync(fd, String(process.pid));
      break;
    } catch (err: any) {
      if (err.code === "EEXIST") {
        try {
          const stat = fs.statSync(CALIBRE_LOCK_FILE);
          if (Date.now() - stat.mtimeMs > 60000) {
            try {
              fs.unlinkSync(CALIBRE_LOCK_FILE);
            } catch (_unlinkErr) {
              void _unlinkErr;
            }
            continue;
          }
        } catch {
          continue;
        }
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 50);
      } else {
        throw err;
      }
    }
  }

  if (fd === null) {
    throw new Error("Timed out waiting to acquire Calibre lock file");
  }

  try {
    return fn();
  } finally {
    if (fd !== null) {
      try {
        fs.closeSync(fd);
      } catch (_closeErr) {
        void _closeErr;
      }
      try {
        if (fs.existsSync(CALIBRE_LOCK_FILE)) {
          fs.unlinkSync(CALIBRE_LOCK_FILE);
        }
      } catch (_unlinkErr) {
        void _unlinkErr;
      }
    }
  }
}

// ---------------------------------------------------------------------------
// Durable Job Queue Implementation
// ---------------------------------------------------------------------------

export class DurableJobQueue {
  private db: Database;
  private handlers: Map<JobType, JobHandler> = new Map();
  private timer: ReturnType<typeof setTimeout> | null = null;
  private isProcessing = false;
  private isStopping = false;
  private workerId: string;

  constructor(dbOrPath?: Database | string) {
    this.workerId = `worker_${process.pid}_${crypto.randomBytes(4).toString("hex")}`;
    if (dbOrPath instanceof Database) {
      this.db = dbOrPath;
    } else {
      this.db = getCacheDb(typeof dbOrPath === "string" ? dbOrPath : undefined);
    }

    this.initSchema();
  }

  private initSchema() {
    this.db.run("PRAGMA busy_timeout = 5000;");
    this.db.run(`
      CREATE TABLE IF NOT EXISTS jobs (
        id TEXT PRIMARY KEY,
        type TEXT NOT NULL,
        payload TEXT NOT NULL,
        status TEXT NOT NULL,
        retries INTEGER NOT NULL DEFAULT 0,
        max_retries INTEGER NOT NULL DEFAULT 3,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        next_run_at INTEGER NOT NULL,
        result TEXT,
        error TEXT,
        worker_id TEXT,
        lease_expires_at INTEGER,
        heartbeat_at INTEGER
      );
    `);
    try {
      this.db.run("ALTER TABLE jobs ADD COLUMN worker_id TEXT;");
    } catch (_e) {
      void _e;
    }
    try {
      this.db.run("ALTER TABLE jobs ADD COLUMN lease_expires_at INTEGER;");
    } catch (_e) {
      void _e;
    }
    try {
      this.db.run("ALTER TABLE jobs ADD COLUMN heartbeat_at INTEGER;");
    } catch (_e) {
      void _e;
    }
    this.db.run(
      "CREATE INDEX IF NOT EXISTS idx_jobs_status_next_run ON jobs(status, next_run_at);",
    );
    this.db.run(
      "CREATE INDEX IF NOT EXISTS idx_jobs_created_at ON jobs(created_at DESC);",
    );
  }

  /**
   * Registers an execution handler for a specific job type.
   */
  public registerHandler<T = any, R = any>(
    type: JobType,
    handler: JobHandler<T, R>,
  ) {
    this.handlers.set(type, handler);
  }

  private resolveHandler(type: JobType): JobHandler | undefined {
    if (this.handlers.has(type)) {
      return this.handlers.get(type);
    }
    // Aliases
    if (type === "archive_ingest" && this.handlers.has("archive_extract")) {
      return this.handlers.get("archive_extract");
    }
    if (type === "archive_extract" && this.handlers.has("archive_ingest")) {
      return this.handlers.get("archive_ingest");
    }
    if (type === "url_ingest" && this.handlers.has("url_article_ingest")) {
      return this.handlers.get("url_article_ingest");
    }
    if (type === "url_article_ingest" && this.handlers.has("url_ingest")) {
      return this.handlers.get("url_ingest");
    }
    return undefined;
  }

  /**
   * Enqueues a new durable job into SQLite.
   */
  public enqueue<T = any>(
    type: JobType,
    payload: T,
    options: {
      id?: string;
      maxRetries?: number;
      delayMs?: number;
    } = {},
  ): JobRecord<T> {
    const id =
      options.id ||
      `job_${Date.now()}_${crypto.randomBytes(4).toString("hex")}`;
    const now = Date.now();
    const delayMs = options.delayMs || 0;
    const maxRetries = options.maxRetries ?? 3;
    const nextRunAt = now + delayMs;
    const payloadStr = JSON.stringify(payload);

    this.db
      .prepare(
        `INSERT INTO jobs (id, type, payload, status, retries, max_retries, created_at, updated_at, next_run_at, result, error, worker_id, lease_expires_at, heartbeat_at)
         VALUES (?, ?, ?, 'pending', 0, ?, ?, ?, ?, NULL, NULL, NULL, NULL, NULL)`,
      )
      .run(id, type, payloadStr, maxRetries, now, now, nextRunAt);

    return {
      id,
      type,
      payload,
      status: "pending",
      retries: 0,
      max_retries: maxRetries,
      created_at: now,
      updated_at: now,
      next_run_at: nextRunAt,
      result: null,
      error: null,
      worker_id: null,
      lease_expires_at: null,
      heartbeat_at: null,
    };
  }

  /**
   * Recovers jobs that were interrupted in 'processing' state during an unexpected
   * process restart, system reboot, or hung worker with expired lease.
   */
  public recoverInterruptedJobs(): number {
    const now = Date.now();
    const interrupted = this.db
      .prepare(
        `SELECT * FROM jobs
         WHERE status = 'processing'
           AND (lease_expires_at IS NULL OR lease_expires_at <= ?)`,
      )
      .all(now) as any[];

    let recoveredCount = 0;
    for (const row of interrupted) {
      // The initial SELECT is only a candidate scan. Re-check every lease
      // predicate in the UPDATE so a live worker cannot be recovered after it
      // renews its lease (or finishes) between the two statements.
      const workerPredicate = row.worker_id === null
        ? "worker_id IS NULL"
        : "worker_id = ?";
      const workerParams = row.worker_id === null ? [] : [row.worker_id];

      if (row.retries >= row.max_retries) {
        const result = this.db
          .prepare(
            `UPDATE jobs
             SET status = 'failed',
                 updated_at = ?,
                 worker_id = NULL,
                 lease_expires_at = NULL,
                 heartbeat_at = NULL,
                 error = 'Job lease expired and exceeded max retry limit'
             WHERE id = ?
               AND status = 'processing'
               AND (lease_expires_at IS NULL OR lease_expires_at <= ?)
               AND ${workerPredicate}`,
          )
          .run(now, row.id, now, ...workerParams);
        if (result.changes > 0) recoveredCount++;
      } else {
        const retries = row.retries + 1;
        const backoffMs = Math.min(60000, 2000 * 2 ** (retries - 1));
        const result = this.db
          .prepare(
            `UPDATE jobs
             SET status = 'pending',
                 retries = ?,
                 next_run_at = ?,
                 updated_at = ?,
                 worker_id = NULL,
                 lease_expires_at = NULL,
                 heartbeat_at = NULL,
                 error = 'Recovered from unexpected process restart or expired worker lease'
             WHERE id = ?
               AND status = 'processing'
               AND (lease_expires_at IS NULL OR lease_expires_at <= ?)
               AND ${workerPredicate}`,
          )
          .run(retries, now + backoffMs, now, row.id, now, ...workerParams);
        if (result.changes > 0) recoveredCount++;
      }
    }

    return recoveredCount;
  }

  /**
   * Retrieves a single job by its ID.
   */
  public getJob<T = any, R = any>(id: string): JobRecord<T, R> | null {
    const row = this.db
      .prepare("SELECT * FROM jobs WHERE id = ?")
      .get(id) as any;
    if (!row) return null;
    return this.mapRowToRecord<T, R>(row);
  }

  /**
   * Retrieves a list of recent jobs for inspection and status monitoring.
   */
  public getRecentJobs(
    options: { limit?: number; status?: JobStatus; type?: JobType } = {},
  ): JobRecord[] {
    const limit = Math.min(options.limit || 50, 200);
    const conditions: string[] = [];
    const params: any[] = [];

    if (options.status) {
      conditions.push("status = ?");
      params.push(options.status);
    }
    if (options.type) {
      conditions.push("type = ?");
      params.push(options.type);
    }

    let sql = "SELECT * FROM jobs";
    if (conditions.length > 0) {
      sql += " WHERE " + conditions.join(" AND ");
    }
    sql += " ORDER BY created_at DESC LIMIT ?";
    params.push(limit);

    const rows = this.db.prepare(sql).all(...params) as any[];
    return rows.map((r) => this.mapRowToRecord(r));
  }

  /**
   * Manually resets a failed job back to 'pending' state for immediate retry.
   * Explicitly resets the retry counter to 0 so the job receives full retry attempts.
   */
  public retryJob(id: string): JobRecord | null {
    const now = Date.now();
    const result = this.db
      .prepare(
        `UPDATE jobs
         SET status = 'pending',
             retries = 0,
             next_run_at = ?,
             updated_at = ?,
             worker_id = NULL,
             lease_expires_at = NULL,
             heartbeat_at = NULL,
             error = NULL
         WHERE id = ? AND status = 'failed'`,
      )
      .run(now, now, id);

    // Atomic CAS: processing jobs, including jobs with an active lease, are
    // never reset or made eligible for duplicate execution.
    return result.changes > 0 ? this.getJob(id) : null;
  }

  /**
   * Waits for an enqueued job to reach completed or failed status.
   * Periodically checks job status while driving worker processing via processNextJob.
   */
  public async waitForJob<T = any, R = any>(
    id: string,
    timeoutMs = 30000,
  ): Promise<JobRecord<T, R>> {
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
      const job = this.getJob<T, R>(id);
      if (!job) {
        throw new Error(`Job ${id} not found`);
      }
      if (job.status === "completed" || job.status === "failed") {
        return job;
      }
      if (job.status === "pending") {
        await this.processNextJob();
      } else {
        await new Promise((r) => setTimeout(r, 100));
      }
    }
    const finalJob = this.getJob<T, R>(id);
    if (!finalJob) throw new Error(`Job ${id} not found`);
    return finalJob;
  }

  /**
   * Directly executes a single job by ID within the durable queue lifecycle.
   * Sets worker lease and heartbeat, and saves results or errors durably.
   */
  public async executeJob<T = any, R = any>(
    id: string,
  ): Promise<JobRecord<T, R>> {
    this.recoverInterruptedJobs();
    const candidate = this.db
      .prepare("SELECT * FROM jobs WHERE id = ?")
      .get(id) as any;
    if (!candidate) {
      throw new Error(`Job ${id} not found`);
    }

    if (candidate.status === "completed") {
      return this.mapRowToRecord<T, R>(candidate);
    }

    const now = Date.now();
    if (
      candidate.status === "processing" &&
      candidate.worker_id &&
      candidate.worker_id !== this.workerId &&
      candidate.lease_expires_at > now
    ) {
      return this.mapRowToRecord<T, R>(candidate);
    }

    const LEASE_DURATION_MS = 60000;
    const leaseExpiresAt = now + LEASE_DURATION_MS;

    const updateRes = this.db
      .prepare(
        `UPDATE jobs
         SET status = 'processing',
             worker_id = ?,
             lease_expires_at = ?,
             heartbeat_at = ?,
             updated_at = ?
         WHERE id = ?
           AND (status = 'pending' OR (status = 'processing' AND worker_id = ?))`,
      )
      .run(this.workerId, leaseExpiresAt, now, now, id, this.workerId);

    if (updateRes.changes === 0) {
      return this.getJob<T, R>(id)!;
    }

    const claimedRow = this.db
      .prepare("SELECT * FROM jobs WHERE id = ?")
      .get(id) as any;
    const job = this.mapRowToRecord<T, R>(claimedRow);
    const handler = this.resolveHandler(job.type);

    const heartbeatTimer = setInterval(() => {
      try {
        const hbNow = Date.now();
        this.db
          .prepare(
            `UPDATE jobs
             SET heartbeat_at = ?,
                 lease_expires_at = ?,
                 updated_at = ?
             WHERE id = ? AND status = 'processing' AND worker_id = ?`,
          )
          .run(
            hbNow,
            hbNow + LEASE_DURATION_MS,
            hbNow,
            job.id,
            this.workerId,
          );
      } catch (_hbErr) {
        void _hbErr;
      }
    }, 10000);

    try {
      if (!handler) {
        throw new Error(`No handler registered for job type: ${job.type}`);
      }

      const result = await handler(job.payload, job);
      const finishedAt = Date.now();
      const resultStr = result === undefined ? null : JSON.stringify(result);

      this.db
        .prepare(
          `UPDATE jobs
           SET status = 'completed',
               result = ?,
               updated_at = ?,
               worker_id = NULL,
               lease_expires_at = NULL,
               error = NULL
           WHERE id = ? AND status = 'processing' AND worker_id = ?`,
        )
        .run(resultStr, finishedAt, job.id, this.workerId);

      return this.getJob<T, R>(job.id)!;
    } catch (err: any) {
      const failedAt = Date.now();
      const nextRetry = job.retries + 1;
      const sanitizedErr = sanitizeErrorMessage(err);
      const isFinal = nextRetry >= job.max_retries;

      const backoffMs = Math.min(60000, 2000 * 2 ** (nextRetry - 1));
      const nextRunAt = failedAt + backoffMs;

      this.db
        .prepare(
          `UPDATE jobs
           SET status = ?,
               retries = ?,
               next_run_at = ?,
               updated_at = ?,
               worker_id = NULL,
               lease_expires_at = NULL,
               error = ?
           WHERE id = ? AND status = 'processing' AND worker_id = ?`,
        )
        .run(
          isFinal ? "failed" : "pending",
          nextRetry,
          isFinal ? failedAt : nextRunAt,
          failedAt,
          sanitizedErr,
          job.id,
          this.workerId,
        );

      return this.getJob<T, R>(job.id)!;
    } finally {
      clearInterval(heartbeatTimer);
    }
  }

  /**
   * Processes the next due pending job in the queue.
   * Returns true if a job was found and processed, false otherwise.
   */
  public async processNextJob(): Promise<boolean> {
    if (this.isProcessing || this.isStopping) return false;

    const now = Date.now();
    // 1. First recover any hung jobs with expired leases
    this.recoverInterruptedJobs();

    // 2. Select the oldest pending job that is ready to run
    const candidates = this.db
      .prepare(
        `SELECT * FROM jobs
         WHERE status = 'pending' AND next_run_at <= ?
         ORDER BY created_at ASC
         LIMIT 100`,
      )
      .all(now) as any[];

    // Multiple processes may share one queue database but register different
    // handlers. Never claim a job this worker cannot execute; leave it for the
    // process that owns its handler instead of converting it into a false failure.
    const candidate = candidates.find((row) => !!this.resolveHandler(row.type));
    if (!candidate) return false;

    const LEASE_DURATION_MS = 60000;
    const leaseExpiresAt = now + LEASE_DURATION_MS;

    // Atomically transition status from pending to processing with worker lease
    const updateRes = this.db
      .prepare(
        `UPDATE jobs
         SET status = 'processing',
             worker_id = ?,
             lease_expires_at = ?,
             heartbeat_at = ?,
             updated_at = ?
         WHERE id = ? AND status = 'pending'`,
      )
      .run(this.workerId, leaseExpiresAt, now, now, candidate.id);

    if (updateRes.changes === 0) {
      return false;
    }

    const claimedRow = this.db
      .prepare("SELECT * FROM jobs WHERE id = ?")
      .get(candidate.id) as any;
    const job = this.mapRowToRecord(claimedRow);
    const handler = this.resolveHandler(job.type);

    this.isProcessing = true;
    const heartbeatTimer = setInterval(() => {
      try {
        const hbNow = Date.now();
        this.db
          .prepare(
            `UPDATE jobs
             SET heartbeat_at = ?,
                 lease_expires_at = ?,
                 updated_at = ?
             WHERE id = ? AND status = 'processing' AND worker_id = ?`,
          )
          .run(hbNow, hbNow + LEASE_DURATION_MS, hbNow, job.id, this.workerId);
      } catch (_hbErr) {
        void _hbErr;
      }
    }, 10000);

    try {
      if (!handler) {
        throw new Error(`No handler registered for job type: ${job.type}`);
      }

      const result = await handler(job.payload, job);
      const finishedAt = Date.now();
      const resultStr = result === undefined ? null : JSON.stringify(result);

      this.db
        .prepare(
          `UPDATE jobs
           SET status = 'completed',
               result = ?,
               updated_at = ?,
               worker_id = NULL,
               lease_expires_at = NULL,
               error = NULL
           WHERE id = ? AND status = 'processing' AND worker_id = ?`,
        )
        .run(resultStr, finishedAt, job.id, this.workerId);

      return true;
    } catch (err: any) {
      const failedAt = Date.now();
      const nextRetry = job.retries + 1;
      const sanitizedErr = sanitizeErrorMessage(err);
      const isFinal = nextRetry >= job.max_retries;

      const backoffMs = Math.min(60000, 2000 * 2 ** (nextRetry - 1));
      const nextRunAt = failedAt + backoffMs;

      this.db
        .prepare(
          `UPDATE jobs
           SET status = ?,
               retries = ?,
               next_run_at = ?,
               updated_at = ?,
               worker_id = NULL,
               lease_expires_at = NULL,
               error = ?
           WHERE id = ? AND status = 'processing' AND worker_id = ?`,
        )
        .run(
          isFinal ? "failed" : "pending",
          nextRetry,
          isFinal ? failedAt : nextRunAt,
          failedAt,
          sanitizedErr,
          job.id,
          this.workerId,
        );

      return true;
    } finally {
      clearInterval(heartbeatTimer);
      this.isProcessing = false;
    }
  }

  /**
   * Starts the background worker loop.
   */
  public startWorker(intervalMs = 1000): void {
    if (this.timer) return;
    this.isStopping = false;

    // Immediately run crash & expired lease recovery on startup
    const recovered = this.recoverInterruptedJobs();
    if (recovered > 0) {
      console.log(
        `[JobQueue] Recovered ${recovered} interrupted job(s) from previous run.`,
      );
    }

    const loop = async () => {
      if (this.isStopping) return;
      try {
        let hasMore = true;
        while (hasMore && !this.isStopping) {
          hasMore = await this.processNextJob();
        }
      } catch (err) {
        console.error("[JobQueue] Worker loop error:", err);
      }

      if (!this.isStopping) {
        this.timer = setTimeout(loop, intervalMs);
      }
    };

    this.timer = setTimeout(loop, intervalMs);
  }

  /**
   * Stops the background worker loop.
   */
  public stopWorker(): void {
    this.isStopping = true;
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
  }

  private mapRowToRecord<T = any, R = any>(row: any): JobRecord<T, R> {
    let payload: T = row.payload;
    try {
      payload = JSON.parse(row.payload);
    } catch (_e) {
      void _e;
    }

    let result: R | null = null;
    if (row.result) {
      try {
        result = JSON.parse(row.result);
      } catch (_e) {
        void _e;
        result = row.result;
      }
    }

    return {
      id: row.id,
      type: row.type as JobType,
      payload,
      status: row.status as JobStatus,
      retries: row.retries,
      max_retries: row.max_retries,
      created_at: row.created_at,
      updated_at: row.updated_at,
      next_run_at: row.next_run_at,
      result,
      error: row.error || null,
      worker_id: row.worker_id || null,
      lease_expires_at: row.lease_expires_at || null,
      heartbeat_at: row.heartbeat_at || null,
    };
  }
}

// Global default singleton queue instance
let defaultQueue: DurableJobQueue | null = null;

export function getJobQueue(dbOrPath?: Database | string): DurableJobQueue {
  if (!defaultQueue || dbOrPath) {
    const queue = new DurableJobQueue(dbOrPath);
    if (!defaultQueue) defaultQueue = queue;
    return queue;
  }
  return defaultQueue;
}
