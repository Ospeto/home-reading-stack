import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import fs from "fs";
import os from "os";
import path from "path";

import {
  buildReadingStatsPayload,
  computeDailyReadingTime,
  computeLibraryHealth,
  computeReadingHeatmap,
  computeReadingStreaks,
  computeYearlyGoalProgress,
  dateDiffInDays,
  dateStringToAdjacentDay,
  deriveReadingSessions,
  getReadingGoal,
  getReadingGoalsConfig,
  normalizePercentage,
  normalizeTimestamp,
  queryKosyncRecords,
  setReadingGoal,
  type RawProgressRecord,
} from "./reading-stats";
import { handleRequest, setServerDependenciesForTest, resetServerDependenciesForTest } from "./server";

describe("Reading Statistics & Telemetry Engine (uploader/reading-stats.ts)", () => {
  let tmpDir: string;
  let origGoalEnv: string | undefined;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "reading-stats-test-"));
    origGoalEnv = process.env.READING_GOAL_CONFIG_PATH;
    process.env.READING_GOAL_CONFIG_PATH = path.join(tmpDir, "reading-goals.json");
  });

  afterEach(() => {
    if (origGoalEnv !== undefined) {
      process.env.READING_GOAL_CONFIG_PATH = origGoalEnv;
    } else {
      delete process.env.READING_GOAL_CONFIG_PATH;
    }
    try {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    } catch (_e) {
      void _e;
    }
  });

  describe("Normalization & Date Utilities", () => {
    it("normalizes float and integer percentages", () => {
      expect(normalizePercentage(0.45)).toBeCloseTo(0.45);
      expect(normalizePercentage(45)).toBeCloseTo(0.45);
      expect(normalizePercentage("0.75")).toBeCloseTo(0.75);
      expect(normalizePercentage("100")).toBe(1.0);
      expect(normalizePercentage(1.0)).toBe(1.0);
      expect(normalizePercentage(-5)).toBe(0);
      expect(normalizePercentage(150)).toBe(1.0);
      expect(normalizePercentage(null)).toBe(0);
      expect(normalizePercentage(undefined)).toBe(0);
      expect(normalizePercentage("invalid")).toBe(0);
    });

    it("normalizes seconds and millisecond timestamps", () => {
      expect(normalizeTimestamp(1794633720)).toBe(1794633720);
      expect(normalizeTimestamp(1794633720000)).toBe(1794633720);
      expect(normalizeTimestamp("1794633720")).toBe(1794633720);
      expect(normalizeTimestamp(0)).toBe(0);
      expect(normalizeTimestamp(-100)).toBe(0);
    });

    it("calculates date differences across month and year boundaries", () => {
      expect(dateDiffInDays("2026-11-14", "2026-11-15")).toBe(1);
      expect(dateDiffInDays("2026-10-31", "2026-11-01")).toBe(1);
      expect(dateDiffInDays("2025-12-31", "2026-01-01")).toBe(1);
      expect(dateDiffInDays("2026-11-15", "2026-11-14")).toBe(-1);
      expect(dateDiffInDays("2026-11-10", "2026-11-15")).toBe(5);
    });

    it("offsets date strings by delta days accurately", () => {
      expect(dateStringToAdjacentDay("2026-11-15", -1)).toBe("2026-11-14");
      expect(dateStringToAdjacentDay("2026-11-01", -1)).toBe("2026-10-31");
      expect(dateStringToAdjacentDay("2026-01-01", -1)).toBe("2025-12-31");
      expect(dateStringToAdjacentDay("2026-11-14", 1)).toBe("2026-11-15");
    });
  });

  describe("Deriving Discrete Reading Sessions", () => {
    it("derives a single session for sequential updates within idle threshold", () => {
      const records: RawProgressRecord[] = [
        {
          document: "doc_dune",
          percentage: 0.1,
          timestamp: 1700000000,
          title: "Dune",
          device: "Paperwhite",
        },
        {
          document: "doc_dune",
          percentage: 0.12,
          timestamp: 1700000120, // +2 min
          title: "Dune",
          device: "Paperwhite",
        },
        {
          document: "doc_dune",
          percentage: 0.15,
          timestamp: 1700000420, // +5 min
          title: "Dune",
          device: "Paperwhite",
        },
      ];

      const sessions = deriveReadingSessions(records, { idleGapSeconds: 1800 });
      expect(sessions.length).toBe(1);
      const s = sessions[0];
      expect(s.document).toBe("doc_dune");
      expect(s.title).toBe("Dune");
      expect(s.startTime).toBe(1700000000);
      expect(s.endTime).toBe(1700000420);
      expect(s.durationSeconds).toBe(420); // 7 minutes
      expect(s.startPercentage).toBeCloseTo(0.1);
      expect(s.endPercentage).toBeCloseTo(0.15);
      expect(s.progressDelta).toBeCloseTo(0.05);
      expect(s.updatesCount).toBe(3);
    });

    it("splits updates into distinct sessions when gap exceeds idle threshold", () => {
      const records: RawProgressRecord[] = [
        // Session 1: 10:00 to 10:20
        {
          document: "doc_dune",
          percentage: 0.2,
          timestamp: 1700000000,
          title: "Dune",
        },
        {
          document: "doc_dune",
          percentage: 0.25,
          timestamp: 1700001200, // +20 min (1200s <= 1800s)
          title: "Dune",
        },
        // Session 2: 12:00 to 12:15 (gap is 6000s > 1800s)
        {
          document: "doc_dune",
          percentage: 0.25,
          timestamp: 1700007200,
          title: "Dune",
        },
        {
          document: "doc_dune",
          percentage: 0.3,
          timestamp: 1700008100, // +15 min
          title: "Dune",
        },
      ];

      const sessions = deriveReadingSessions(records, { idleGapSeconds: 1800 });
      expect(sessions.length).toBe(2);

      // Sessions are sorted by startTime DESC
      const [s2, s1] = sessions;
      expect(s1.startTime).toBe(1700000000);
      expect(s1.endTime).toBe(1700001200);
      expect(s1.durationSeconds).toBe(1200);
      expect(s1.progressDelta).toBeCloseTo(0.05);

      expect(s2.startTime).toBe(1700007200);
      expect(s2.endTime).toBe(1700008100);
      expect(s2.durationSeconds).toBe(900);
      expect(s2.progressDelta).toBeCloseTo(0.05);
    });

    it("assigns nominal duration to single-update sessions", () => {
      const records: RawProgressRecord[] = [
        {
          document: "doc_quick",
          percentage: 0.5,
          timestamp: 1700000000,
          title: "Quick Read",
        },
      ];

      const sessions = deriveReadingSessions(records, { minDurationSeconds: 60 });
      expect(sessions.length).toBe(1);
      expect(sessions[0].startTime).toBe(1700000000);
      expect(sessions[0].endTime).toBe(1700000000);
      expect(sessions[0].durationSeconds).toBe(60);
      expect(sessions[0].updatesCount).toBe(1);
    });

    it("handles multiple documents independently without cross-document interference", () => {
      const records: RawProgressRecord[] = [
        {
          document: "doc_a",
          percentage: 0.1,
          timestamp: 1700000000,
          title: "Book A",
        },
        {
          document: "doc_b",
          percentage: 0.5,
          timestamp: 1700000100,
          title: "Book B",
        },
        {
          document: "doc_a",
          percentage: 0.15,
          timestamp: 1700000200,
          title: "Book A",
        },
        {
          document: "doc_b",
          percentage: 0.55,
          timestamp: 1700000300,
          title: "Book B",
        },
      ];

      const sessions = deriveReadingSessions(records);
      expect(sessions.length).toBe(2);

      const sessA = sessions.find((s) => s.document === "doc_a")!;
      const sessB = sessions.find((s) => s.document === "doc_b")!;

      expect(sessA).toBeDefined();
      expect(sessA.title).toBe("Book A");
      expect(sessA.durationSeconds).toBe(200);

      expect(sessB).toBeDefined();
      expect(sessB.title).toBe("Book B");
      expect(sessB.durationSeconds).toBe(200);
    });
  });

  describe("Reading Streaks Calculation", () => {
    it("returns 0 for empty active days", () => {
      const streaks = computeReadingStreaks([], "2026-11-15");
      expect(streaks.currentStreak).toBe(0);
      expect(streaks.longestStreak).toBe(0);
      expect(streaks.readingDaysCount).toBe(0);
      expect(streaks.lastReadingDate).toBeNull();
      expect(streaks.isActiveToday).toBe(false);
    });

    it("calculates active streak when user read today", () => {
      const days = ["2026-11-13", "2026-11-14", "2026-11-15"];
      const streaks = computeReadingStreaks(days, "2026-11-15");

      expect(streaks.currentStreak).toBe(3);
      expect(streaks.longestStreak).toBe(3);
      expect(streaks.readingDaysCount).toBe(3);
      expect(streaks.lastReadingDate).toBe("2026-11-15");
      expect(streaks.isActiveToday).toBe(true);
    });

    it("keeps streak active when user read yesterday but not yet today", () => {
      const days = ["2026-11-12", "2026-11-13", "2026-11-14"];
      const streaks = computeReadingStreaks(days, "2026-11-15");

      expect(streaks.currentStreak).toBe(3);
      expect(streaks.longestStreak).toBe(3);
      expect(streaks.readingDaysCount).toBe(3);
      expect(streaks.lastReadingDate).toBe("2026-11-14");
      expect(streaks.isActiveToday).toBe(false);
    });

    it("resets current streak to 0 when user missed both today and yesterday", () => {
      const days = ["2026-11-10", "2026-11-11", "2026-11-12"];
      const streaks = computeReadingStreaks(days, "2026-11-15");

      expect(streaks.currentStreak).toBe(0);
      expect(streaks.longestStreak).toBe(3);
      expect(streaks.readingDaysCount).toBe(3);
      expect(streaks.lastReadingDate).toBe("2026-11-12");
      expect(streaks.isActiveToday).toBe(false);
    });

    it("tracks longest streak across historical periods", () => {
      const days = [
        // Past 5-day streak
        "2026-09-01",
        "2026-09-02",
        "2026-09-03",
        "2026-09-04",
        "2026-09-05",
        // Gap
        "2026-10-01",
        "2026-10-02",
        // Current 2-day streak
        "2026-11-14",
        "2026-11-15",
      ];
      const streaks = computeReadingStreaks(days, "2026-11-15");

      expect(streaks.longestStreak).toBe(5);
      expect(streaks.currentStreak).toBe(2);
      expect(streaks.readingDaysCount).toBe(9);
    });
  });

  describe("Daily Reading Time Summary", () => {
    it("aggregates daily totals, averages, and time windows", () => {
      const sessions = [
        {
          id: "1",
          document: "doc_1",
          bookId: 1,
          title: "Book 1",
          authors: "Author 1",
          device: "Paperwhite",
          startTime: 1763164800, // 2025-11-15 00:00:00 UTC
          endTime: 1763166600, // +30m (1800s)
          durationSeconds: 1800,
          startPercentage: 0,
          endPercentage: 0.1,
          progressDelta: 0.1,
          updatesCount: 5,
          date: "2025-11-15",
        },
        {
          id: "2",
          document: "doc_2",
          bookId: 2,
          title: "Book 2",
          authors: "Author 2",
          device: "Paperwhite",
          startTime: 1763170000,
          endTime: 1763171200, // +20m (1200s)
          durationSeconds: 1200,
          startPercentage: 0.2,
          endPercentage: 0.25,
          progressDelta: 0.05,
          updatesCount: 3,
          date: "2025-11-15",
        },
        {
          id: "3",
          document: "doc_1",
          bookId: 1,
          title: "Book 1",
          authors: "Author 1",
          device: "Paperwhite",
          startTime: 1763078400, // 2025-11-14
          endTime: 1763082000, // +60m (3600s)
          durationSeconds: 3600,
          startPercentage: 0.1,
          endPercentage: 0.2,
          progressDelta: 0.1,
          updatesCount: 10,
          date: "2025-11-14",
        },
      ];

      const summary = computeDailyReadingTime(sessions, "2025-11-15");

      expect(summary.days.length).toBe(2);
      expect(summary.todaySeconds).toBe(3000); // 1800 + 1200
      expect(summary.todayMinutes).toBe(50);
      expect(summary.thisWeekSeconds).toBe(6600); // 3000 + 3600
      expect(summary.totalSeconds).toBe(6600);
      expect(summary.totalHours).toBeCloseTo(1.8, 1);
      expect(summary.dailyAverageMinutes).toBe(55); // 6600 / 2 / 60 = 55m

      const day15 = summary.days.find((d) => d.date === "2025-11-15")!;
      expect(day15.bookCount).toBe(2);
      expect(day15.books).toContain("Book 1");
      expect(day15.books).toContain("Book 2");
      expect(day15.sessionsCount).toBe(2);
    });
  });

  describe("Heatmap Generation", () => {
    it("generates exactly 365 days of activity up to endDate", () => {
      const sessions = [
        {
          id: "1",
          document: "d1",
          bookId: 1,
          title: "Novels",
          authors: "A",
          device: "K",
          startTime: 1763164800,
          endTime: 1763168400,
          durationSeconds: 3600, // 60 mins -> Level 4
          startPercentage: 0,
          endPercentage: 0.1,
          progressDelta: 0.1,
          updatesCount: 1,
          date: "2025-11-15",
        },
        {
          id: "2",
          document: "d1",
          bookId: 1,
          title: "Novels",
          authors: "A",
          device: "K",
          startTime: 1763078400,
          endTime: 1763079600,
          durationSeconds: 1200, // 20 mins -> Level 2
          startPercentage: 0,
          endPercentage: 0.1,
          progressDelta: 0.1,
          updatesCount: 1,
          date: "2025-11-14",
        },
      ];

      const heatmap = computeReadingHeatmap(sessions, { days: 365, endDate: "2025-11-15" });
      expect(heatmap.length).toBe(365);
      expect(heatmap[heatmap.length - 1].date).toBe("2025-11-15");
      expect(heatmap[heatmap.length - 1].level).toBe(4);
      expect(heatmap[heatmap.length - 1].minutes).toBe(60);

      expect(heatmap[heatmap.length - 2].date).toBe("2025-11-14");
      expect(heatmap[heatmap.length - 2].level).toBe(2);
      expect(heatmap[heatmap.length - 2].minutes).toBe(20);

      // Inactive day
      expect(heatmap[heatmap.length - 3].date).toBe("2025-11-13");
      expect(heatmap[heatmap.length - 3].level).toBe(0);
      expect(heatmap[heatmap.length - 3].minutes).toBe(0);
    });
  });

  describe("Library Health Calculation", () => {
    it("accurately categorizes unread, in-progress, finished, and stale reads", () => {
      const nowEpoch = 1763164800; // 2025-11-15
      const calibreBooks = [
        { id: 1, title: "Finished Book", authors: "Author A" },
        { id: 2, title: "Active Book", authors: "Author B" },
        { id: 3, title: "Stale Inactive Book", authors: "Author C" },
        { id: 4, title: "Unread Book", authors: "Author D" },
      ];

      const latestProgress = [
        {
          bookId: 1,
          title: "Finished Book",
          percentage: 1.0,
          timestamp: nowEpoch,
        },
        {
          bookId: 2,
          title: "Active Book",
          percentage: 0.45,
          timestamp: nowEpoch - 86400 * 5, // 5 days ago
        },
        {
          bookId: 3,
          title: "Stale Inactive Book",
          percentage: 0.30,
          timestamp: nowEpoch - 86400 * 45, // 45 days ago (> 30 days)
        },
        // Book 4 has no sync progress record
      ];

      const health = computeLibraryHealth(calibreBooks, latestProgress, {
        staleDaysThreshold: 30,
        referenceDate: "2025-11-15",
      });

      expect(health.totalBooks).toBe(4);
      expect(health.finishedCount).toBe(1);
      expect(health.inProgressCount).toBe(2);
      expect(health.unreadCount).toBe(1);

      expect(health.finishedPercentage).toBe(25);
      expect(health.inProgressPercentage).toBe(50);
      expect(health.unreadPercentage).toBe(25);

      expect(health.staleCount).toBe(1);
      expect(health.staleReads.length).toBe(1);
      expect(health.staleReads[0].title).toBe("Stale Inactive Book");
      expect(health.staleReads[0].daysInactive).toBe(45);
    });
  });

  describe("Yearly Reading Goals", () => {
    it("reads and writes goal config without errors", () => {
      expect(getReadingGoalsConfig()).toEqual({});
      const goal2026 = getReadingGoal(2026);
      expect(goal2026.targetBooks).toBeNull();
      expect(goal2026.targetHours).toBeNull();

      setReadingGoal(2026, { targetBooks: 24, targetHours: 100 });
      const updated = getReadingGoal(2026);
      expect(updated.targetBooks).toBe(24);
      expect(updated.targetHours).toBe(100);

      const all = getReadingGoalsConfig();
      expect(all["2026"].targetBooks).toBe(24);
      expect(all["2026"].targetHours).toBe(100);
    });

    it("computes goal progress and percentage completion accurately", () => {
      const goalConfig = { year: 2026, targetBooks: 10, targetHours: 50 };
      const sessions = [
        {
          id: "s1",
          document: "d1",
          bookId: 1,
          title: "T1",
          authors: "A1",
          device: "K",
          startTime: 1767225600, // 2026-01-01
          endTime: 1767232800, // 2 hours (7200s)
          durationSeconds: 7200,
          startPercentage: 0,
          endPercentage: 1,
          progressDelta: 1,
          updatesCount: 10,
          date: "2026-01-01",
        },
      ];
      const finishedBooks = [
        { percentage: 1.0, timestamp: 1767232800 }, // in 2026
        { percentage: 1.0, timestamp: 1767232800 }, // in 2026
      ];

      const progress = computeYearlyGoalProgress(2026, goalConfig, sessions, finishedBooks);
      expect(progress.targetBooks).toBe(10);
      expect(progress.currentBooks).toBe(2);
      expect(progress.booksPercent).toBe(20); // 2 / 10 = 20%

      expect(progress.targetHours).toBe(50);
      expect(progress.currentHours).toBe(2);
      expect(progress.hoursPercent).toBe(4); // 2 / 50 = 4%
      expect(progress.isConfigured).toBe(true);
    });

    it("handles unconfigured goal safely as additive non-gate", () => {
      const progress = computeYearlyGoalProgress(2026, { year: 2026 }, [], []);
      expect(progress.targetBooks).toBeNull();
      expect(progress.targetHours).toBeNull();
      expect(progress.booksPercent).toBeNull();
      expect(progress.hoursPercent).toBeNull();
      expect(progress.isConfigured).toBe(false);
    });
  });

  describe("Database Querying & Assembly", () => {
    it("queries progress and progress_history tables correctly", () => {
      const dbPath = path.join(tmpDir, "test-kosync.db");
      const db = new Database(dbPath);

      db.run(`
        CREATE TABLE progress (
          id INTEGER PRIMARY KEY,
          document TEXT NOT NULL,
          progress TEXT,
          percentage REAL,
          device TEXT,
          device_id TEXT,
          filename TEXT,
          title TEXT,
          authors TEXT,
          timestamp INTEGER
        );
      `);

      db.run(`
        CREATE TABLE progress_history (
          id INTEGER PRIMARY KEY,
          document TEXT NOT NULL,
          progress TEXT,
          percentage REAL,
          device TEXT,
          device_id TEXT,
          timestamp INTEGER,
          is_rollback INTEGER DEFAULT 0
        );
      `);

      const now = 1763164800;
      db.run(
        "INSERT INTO progress (document, percentage, title, authors, timestamp) VALUES (?, ?, ?, ?, ?);",
        ["doc_1", 1.0, "Dune", "Frank Herbert", now],
      );
      db.run(
        "INSERT INTO progress_history (document, percentage, timestamp) VALUES (?, ?, ?);",
        ["doc_1", 0.5, now - 600],
      );
      db.run(
        "INSERT INTO progress_history (document, percentage, timestamp) VALUES (?, ?, ?);",
        ["doc_1", 1.0, now],
      );

      const { rawRecords, latestByBook } = queryKosyncRecords(db);
      expect(rawRecords.length).toBe(2);
      expect(latestByBook.length).toBe(1);
      expect(latestByBook[0].title).toBe("Dune");
      expect(latestByBook[0].percentage).toBe(1.0);

      const payload = buildReadingStatsPayload({
        rawRecords,
        latestBooks: latestByBook,
        calibreBooks: [{ id: 1, title: "Dune", authors: "Frank Herbert" }],
        referenceDate: "2025-11-15",
      });

      // Assert backwards compatibility contract
      expect(payload.totalSessions).toBeGreaterThanOrEqual(1);
      expect(payload.finishedCount).toBe(1);
      expect(payload.finishedBooks.length).toBe(1);
      expect(payload.activeBooks.length).toBe(0);

      // Assert extended metrics
      expect(payload.streaks).toBeDefined();
      expect(payload.dailyReadingTime).toBeDefined();
      expect(payload.heatmap).toBeDefined();
      expect(payload.heatmap.length).toBe(365);
      expect(payload.libraryHealth).toBeDefined();
      expect(payload.goal).toBeDefined();
      expect(payload.summary).toBeDefined();

      db.close();
    });
  });

  describe("HTTP API Endpoints Integration", () => {
    let testDbPath: string;
    let origKosyncEnv: string | undefined;
    const localServer = { requestIP: () => ({ address: "127.0.0.1" }) };

    beforeEach(() => {
      testDbPath = path.join(tmpDir, "koreader-sync.db");
      origKosyncEnv = process.env.KOSYNC_DB_PATH;
      process.env.KOSYNC_DB_PATH = testDbPath;

      const db = new Database(testDbPath);
      db.run(`
        CREATE TABLE progress (
          id INTEGER PRIMARY KEY,
          document TEXT NOT NULL,
          progress TEXT,
          percentage REAL,
          device TEXT,
          device_id TEXT,
          filename TEXT,
          title TEXT,
          authors TEXT,
          timestamp INTEGER
        );
      `);
      db.run(`
        CREATE TABLE progress_history (
          id INTEGER PRIMARY KEY,
          document TEXT NOT NULL,
          progress TEXT,
          percentage REAL,
          device TEXT,
          device_id TEXT,
          timestamp INTEGER,
          is_rollback INTEGER DEFAULT 0
        );
      `);

      const now = Math.floor(Date.now() / 1000);
      db.run(
        "INSERT INTO progress (document, percentage, title, authors, timestamp) VALUES (?, ?, ?, ?, ?);",
        ["doc_spice", 0.5, "Spice and Wolf, Vol. 1", "Isuna Hasekura", now],
      );
      db.run(
        "INSERT INTO progress_history (document, percentage, timestamp) VALUES (?, ?, ?);",
        ["doc_spice", 0.4, now - 300],
      );
      db.run(
        "INSERT INTO progress_history (document, percentage, timestamp) VALUES (?, ?, ?);",
        ["doc_spice", 0.5, now],
      );
      db.close();

      setServerDependenciesForTest({
        getCalibreBooks: () => [
          { id: 10, title: "Spice and Wolf, Vol. 1", authors: "Isuna Hasekura", cover: true },
          { id: 20, title: "Unread Novel", authors: "Author X", cover: false },
        ],
      });
    });

    afterEach(() => {
      resetServerDependenciesForTest();
      if (origKosyncEnv !== undefined) {
        process.env.KOSYNC_DB_PATH = origKosyncEnv;
      } else {
        delete process.env.KOSYNC_DB_PATH;
      }
    });

    it("GET /api/kosync/stats returns backwards-compatible and extended metrics", async () => {
      const req = new Request("http://127.0.0.1:8086/api/kosync/stats", {
        method: "GET",
        headers: { host: "127.0.0.1:8086" },
      });
      const res = await handleRequest(req, localServer);
      expect(res.status).toBe(200);

      const data = (await res.json()) as any;
      // Backwards-compatible fields
      expect(data.totalSessions).toBeGreaterThanOrEqual(1);
      expect(data.readingDaysCount).toBeGreaterThanOrEqual(1);
      expect(data.finishedCount).toBe(0);
      expect(Array.isArray(data.finishedBooks)).toBe(true);
      expect(Array.isArray(data.activeBooks)).toBe(true);
      expect(data.activeBooks.length).toBe(1);
      expect(data.activeBooks[0].title).toBe("Spice and Wolf, Vol. 1");

      // Extended fields
      expect(data.streaks).toBeDefined();
      expect(data.streaks.currentStreak).toBeGreaterThanOrEqual(1);
      expect(data.streaks.readingDaysCount).toBeGreaterThanOrEqual(1);

      expect(data.dailyReadingTime).toBeDefined();
      expect(data.dailyReadingTime.todaySeconds).toBeGreaterThan(0);

      expect(data.heatmap).toBeDefined();
      expect(data.heatmap.length).toBe(365);

      expect(data.libraryHealth).toBeDefined();
      expect(data.libraryHealth.totalBooks).toBe(2);
      expect(data.libraryHealth.inProgressCount).toBe(1);
      expect(data.libraryHealth.unreadCount).toBe(1);

      expect(data.goal).toBeDefined();
      expect(data.goal.isConfigured).toBe(false);

      expect(Array.isArray(data.recentSessions)).toBe(true);
      expect(data.recentSessions.length).toBe(1);
      expect(data.recentSessions[0].title).toBe("Spice and Wolf, Vol. 1");
      expect(data.recentSessions[0].durationSeconds).toBe(300);
    });

    it("GET and POST /api/kosync/goal manages yearly reading target additively", async () => {
      // 1. GET default goal (unconfigured)
      const getReq = new Request("http://127.0.0.1:8086/api/kosync/goal?year=2026", {
        method: "GET",
        headers: { host: "127.0.0.1:8086" },
      });
      const getRes = await handleRequest(getReq, localServer);
      expect(getRes.status).toBe(200);
      const getData = (await getRes.json()) as any;
      expect(getData.year).toBe(2026);
      expect(getData.targetBooks).toBeNull();
      expect(getData.targetHours).toBeNull();

      // 2. POST set goal
      const postReq = new Request("http://127.0.0.1:8086/api/kosync/goal", {
        method: "POST",
        headers: {
          host: "127.0.0.1:8086",
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ year: 2026, targetBooks: 30, targetHours: 120 }),
      });
      const postRes = await handleRequest(postReq, localServer);
      expect(postRes.status).toBe(200);
      const postData = (await postRes.json()) as any;
      expect(postData.success).toBe(true);
      expect(postData.goal.targetBooks).toBe(30);
      expect(postData.goal.targetHours).toBe(120);

      // 3. GET /api/kosync/stats now reflects the configured goal
      const statsReq = new Request("http://127.0.0.1:8086/api/kosync/stats?year=2026", {
        method: "GET",
        headers: { host: "127.0.0.1:8086" },
      });
      const statsRes = await handleRequest(statsReq, localServer);
      const statsData = (await statsRes.json()) as any;
      expect(statsData.goal.isConfigured).toBe(true);
      expect(statsData.goal.targetBooks).toBe(30);
      expect(statsData.goal.targetHours).toBe(120);
    });

    it("POST /api/kosync/goal rejects invalid JSON payloads with HTTP 400", async () => {
      const badReq = new Request("http://127.0.0.1:8086/api/kosync/goal", {
        method: "POST",
        headers: {
          host: "127.0.0.1:8086",
          "Content-Type": "application/json",
        },
        body: "NOT_VALID_JSON{",
      });
      const res = await handleRequest(badReq, localServer);
      expect(res.status).toBe(400);
      const data = (await res.json()) as any;
      expect(data.success).toBe(false);
    });
  });
});
