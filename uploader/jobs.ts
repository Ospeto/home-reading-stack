import { Database } from "bun:sqlite";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { sanitizeErrorMessage } from "./security";

export const DEFAULT_JOBS_DB_PATH =
  process.env.JOBS_DB_PATH ||
  process.env.CACHE_DB_PATH ||
  path.resolve((import.meta as any).dir || process.cwd(), "cache.db");

export type JobType =
  | "file_ingest"
  | "archive_extract"
  | "url_article_ingest"
  | "metadata_enrich"
  | "cover_backfill";

export type JobStatus = "pending" | "processing" | "running" | "completed" | "failed";

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
}

export type JobHandler<T = any, R = any> = (payload: T, job: JobRecord<T, R>) => Promise<R>;

export class DurableJobQueue {
  private db: Database;
  private handlers: Map<JobType, JobHandler> = new Map();
  private timer: ReturnType<typeof setTimeout> | null = null;
  private isProcessing = false;
  private isStopping = false;

  constructor(dbOrPath?: Database | string) {
    if (dbOrPath instanceof Database) {
      this.db = dbOrPath;
    } else {
      const dbPath = dbOrPath || DEFAULT_JOBS_DB_PATH;
      const dir = path.dirname(dbPath);
      if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
      }
      this.db = new Database(dbPath);
    }

    this.initSchema();
  }

  private initSchema() {
    this.db.run("PRAGMA busy_timeout = 5000;");
    this.db.run("PRAGMA journal_mode = WAL;");
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
        error TEXT
      );
    `);
    this.db.run("CREATE INDEX IF NOT EXISTS idx_jobs_status_next_run ON jobs(status, next_run_at);");
    this.db.run("CREATE INDEX IF NOT EXISTS idx_jobs_created_at ON jobs(created_at DESC);");
  }

  /**
   * Registers an execution handler for a specific job type.
   */
  public registerHandler<T = any, R = any>(type: JobType, handler: JobHandler<T, R>) {
    this.handlers.set(type, handler);
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
    } = {}
  ): JobRecord<T> {
    const id = options.id || `job_${Date.now()}_${crypto.randomBytes(4).toString("hex")}`;
    const now = Date.now();
    const delayMs = options.delayMs || 0;
    const maxRetries = options.maxRetries ?? 3;
    const nextRunAt = now + delayMs;
    const payloadStr = JSON.stringify(payload);

    this.db
      .prepare(
        `INSERT INTO jobs (id, type, payload, status, retries, max_retries, created_at, updated_at, next_run_at, result, error)
         VALUES (?, ?, ?, 'pending', 0, ?, ?, ?, ?, NULL, NULL)`
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
      error: null
    };
  }

  /**
   * Recovers jobs that were interrupted in 'processing' state during an unexpected
   * process restart or system reboot.
   */
  public recoverInterruptedJobs(): number {
    const now = Date.now();
    const interrupted = this.db
      .prepare("SELECT * FROM jobs WHERE status = 'processing'")
      .all() as any[];

    let recoveredCount = 0;
    for (const row of interrupted) {
      if (row.retries >= row.max_retries) {
        this.db
          .prepare(
            `UPDATE jobs
             SET status = 'failed',
                 updated_at = ?,
                 error = 'Interrupted by process restart and exceeded max retry limit'
             WHERE id = ?`
          )
          .run(now, row.id);
      } else {
        const retries = row.retries + 1;
        const backoffMs = Math.min(60000, 2000 * 2 ** (retries - 1));
        this.db
          .prepare(
            `UPDATE jobs
             SET status = 'pending',
                 retries = ?,
                 next_run_at = ?,
                 updated_at = ?,
                 error = 'Recovered from unexpected process restart'
             WHERE id = ?`
          )
          .run(retries, now + backoffMs, now, row.id);
        recoveredCount++;
      }
    }

    return recoveredCount;
  }

  /**
   * Retrieves a single job by its ID.
   */
  public getJob<T = any, R = any>(id: string): JobRecord<T, R> | null {
    const row = this.db.prepare("SELECT * FROM jobs WHERE id = ?").get(id) as any;
    if (!row) return null;
    return this.mapRowToRecord<T, R>(row);
  }

  /**
   * Retrieves a list of recent jobs for inspection and status monitoring.
   */
  public getRecentJobs(options: { limit?: number; status?: JobStatus; type?: JobType } = {}): JobRecord[] {
    const rawLimit = options.limit ?? 50;
    const limit = Math.max(
      1,
      Math.min(Number.isFinite(rawLimit) ? Math.floor(rawLimit) : 50, 200),
    );
    const conditions: string[] = [];
    const params: any[] = [];

    if (options.status) {
      if (options.status === "running") {
        conditions.push("(status = 'processing' OR status = 'running')");
      } else {
        conditions.push("status = ?");
        params.push(options.status);
      }
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
   * Only jobs with status === 'failed' can be retried.
   */
  public retryJob(id: string): JobRecord | null {
    const job = this.getJob(id);
    if (!job || job.status !== "failed") return null;

    const now = Date.now();
    const updateRes = this.db
      .prepare(
        `UPDATE jobs
         SET status = 'pending',
             retries = 0,
             next_run_at = ?,
             updated_at = ?,
             error = NULL
         WHERE id = ? AND status = 'failed'`
      )
      .run(now, now, id);

    if (updateRes.changes === 0) return null;

    return this.getJob(id);
  }

  /**
   * Processes the next due pending job in the queue.
   * Returns true if a job was found and processed, false otherwise.
   */
  public async processNextJob(): Promise<boolean> {
    if (this.isProcessing || this.isStopping) return false;
    if (this.handlers.size === 0) return false;

    const handlerTypes = Array.from(this.handlers.keys());
    const placeholders = handlerTypes.map(() => "?").join(", ");
    const now = Date.now();

    // Select the oldest pending job that is ready to run and supported by this worker
    const candidate = this.db
      .prepare(
        `SELECT * FROM jobs
         WHERE status = 'pending' AND next_run_at <= ? AND type IN (${placeholders})
         ORDER BY created_at ASC
         LIMIT 1`
      )
      .get(now, ...handlerTypes) as any;

    if (!candidate) return false;

    // Atomically transition status from pending to processing
    const updateRes = this.db
      .prepare(
        `UPDATE jobs
         SET status = 'processing', updated_at = ?
         WHERE id = ? AND status = 'pending'`
      )
      .run(now, candidate.id);

    if (updateRes.changes === 0) {
      // Race condition with another worker or transition; try again next tick
      return false;
    }

    const job = this.mapRowToRecord(candidate);
    const handler = this.handlers.get(job.type);

    this.isProcessing = true;
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
               error = NULL
           WHERE id = ? AND status = 'processing'`
        )
        .run(resultStr, finishedAt, job.id);

      return true;
    } catch (err: any) {
      const failedAt = Date.now();
      const nextRetry = job.retries + 1;
      const sanitizedErr = sanitizeErrorMessage(err);
      const failResult =
        err && typeof err === "object" && "result" in err ? (err as any).result : null;
      const failResultStr =
        failResult !== undefined && failResult !== null ? JSON.stringify(failResult) : null;

      if (nextRetry < job.max_retries) {
        // Bounded exponential backoff: 2s, 4s, 8s, 16s... capped at 60s
        const backoffMs = Math.min(60000, 2000 * 2 ** (nextRetry - 1));
        const nextRunAt = failedAt + backoffMs;

        this.db
          .prepare(
            `UPDATE jobs
             SET status = 'pending',
                 retries = ?,
                 next_run_at = ?,
                 updated_at = ?,
                 error = ?,
                 result = COALESCE(?, result)
             WHERE id = ? AND status = 'processing'`
          )
          .run(nextRetry, nextRunAt, failedAt, sanitizedErr, failResultStr, job.id);
      } else {
        // Max retries exhausted
        this.db
          .prepare(
            `UPDATE jobs
             SET status = 'failed',
                 retries = ?,
                 updated_at = ?,
                 error = ?,
                 result = COALESCE(?, result)
             WHERE id = ? AND status = 'processing'`
          )
          .run(nextRetry, failedAt, sanitizedErr, failResultStr, job.id);
      }

      return true;
    } finally {
      this.isProcessing = false;
    }
  }

  /**
   * Starts the background worker loop.
   */
  public startWorker(intervalMs = 1000): void {
    if (this.timer) return;
    this.isStopping = false;

    // Immediately run crash recovery on startup
    const recovered = this.recoverInterruptedJobs();
    if (recovered > 0) {
      console.log(`[JobQueue] Recovered ${recovered} interrupted job(s) from previous run.`);
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

  /**
   * Closes the worker loop and the underlying database connection.
   */
  public close(): void {
    this.stopWorker();
    try {
      this.db.close();
    } catch {
      // ignore
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
      error: row.error || null
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
