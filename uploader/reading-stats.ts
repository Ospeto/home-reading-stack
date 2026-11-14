/**
 * LightHouse Reading Statistics & Telemetry Engine
 *
 * Derives discrete reading sessions from raw KOSync progress records, computes
 * daily reading time, reading streaks (current & longest), activity heatmap,
 * library health (unread / in-progress / finished distribution and stale reads),
 * and strictly additive yearly reading goals.
 *
 * Read-only over existing KOSync data (koreader-sync.db).
 */

import { Database } from "bun:sqlite";
import fs from "fs";
import os from "os";
import path from "path";

// ----------------------------------------------------------------------------
// Types & Interfaces
// ----------------------------------------------------------------------------

export interface RawProgressRecord {
  id?: number;
  document: string;
  progress?: string | null;
  percentage: number | string;
  device?: string | null;
  device_id?: string | null;
  timestamp: number;
  title?: string | null;
  authors?: string | null;
  filename?: string | null;
  bookId?: number | null;
}

export interface ReadingSession {
  id: string;
  document: string;
  bookId: number | null;
  title: string;
  authors: string;
  device: string;
  startTime: number; // epoch seconds
  endTime: number; // epoch seconds
  durationSeconds: number;
  startPercentage: number;
  endPercentage: number;
  progressDelta: number;
  updatesCount: number;
  date: string; // YYYY-MM-DD (UTC start date)
}

export interface ReadingStreaks {
  currentStreak: number;
  longestStreak: number;
  readingDaysCount: number;
  lastReadingDate: string | null;
  isActiveToday: boolean;
}

export interface DailyReadingEntry {
  date: string;
  seconds: number;
  minutes: number;
  sessionsCount: number;
  bookCount: number;
  books: string[];
}

export interface ReadingTimeSummary {
  days: DailyReadingEntry[];
  todaySeconds: number;
  todayMinutes: number;
  thisWeekSeconds: number;
  thisWeekMinutes: number;
  thisMonthSeconds: number;
  thisMonthMinutes: number;
  totalSeconds: number;
  totalHours: number;
  dailyAverageMinutes: number;
}

export interface HeatmapDay {
  date: string; // YYYY-MM-DD
  count: number;
  seconds: number;
  minutes: number;
  level: 0 | 1 | 2 | 3 | 4;
  bookCount: number;
  books: string[];
}

export interface StaleRead {
  bookId: number | null;
  document: string;
  title: string;
  authors: string;
  percentage: number;
  lastReadDate: string;
  daysInactive: number;
}

export interface LibraryHealth {
  totalBooks: number;
  unreadCount: number;
  inProgressCount: number;
  finishedCount: number;
  unreadPercentage: number;
  inProgressPercentage: number;
  finishedPercentage: number;
  staleCount: number;
  staleThresholdDays: number;
  staleReads: StaleRead[];
}

export interface ReadingGoalConfig {
  year: number;
  targetBooks?: number | null;
  targetHours?: number | null;
}

export interface ReadingGoalProgress {
  year: number;
  targetBooks: number | null;
  targetHours: number | null;
  currentBooks: number;
  currentHours: number;
  booksPercent: number | null;
  hoursPercent: number | null;
  isConfigured: boolean;
}

export interface ReadingStatsPayload {
  // Existing backwards-compatible fields
  totalSessions: number;
  readingDaysCount: number;
  finishedCount: number;
  finishedBooks: any[];
  activeBooks: any[];

  // Extended statistics
  streaks: ReadingStreaks;
  dailyReadingTime: ReadingTimeSummary;
  heatmap: HeatmapDay[];
  libraryHealth: LibraryHealth;
  goal: ReadingGoalProgress;
  recentSessions: ReadingSession[];
  summary: {
    totalSessionsCount: number;
    totalReadingSeconds: number;
    totalReadingHours: number;
    todayReadingSeconds: number;
    thisWeekReadingSeconds: number;
    averageDailyMinutes: number;
    currentStreak: number;
    longestStreak: number;
  };
}

// ----------------------------------------------------------------------------
// Constants & Configuration
// ----------------------------------------------------------------------------

export const DEFAULT_IDLE_GAP_SECONDS = 1800; // 30 minutes
export const DEFAULT_MIN_SESSION_DURATION = 60; // 1 minute nominal for single ping
export const DEFAULT_STALE_DAYS_THRESHOLD = 30; // 30 days of inactivity

export function getLighthouseRoot(): string {
  if (process.env.LIGHTHOUSE_ROOT) {
    return process.env.LIGHTHOUSE_ROOT;
  }
  return path.resolve(import.meta.dir, "..");
}

export function getKosyncDbPath(): string {
  if (process.env.KOSYNC_DB_PATH) {
    return path.isAbsolute(process.env.KOSYNC_DB_PATH)
      ? process.env.KOSYNC_DB_PATH
      : path.resolve(getLighthouseRoot(), process.env.KOSYNC_DB_PATH);
  }
  const home = process.env.HOME || os.homedir();
  return path.join(home, "kosync-server", "data", "koreader-sync.db");
}

export function getReadingGoalsConfigPath(): string {
  if (process.env.READING_GOAL_CONFIG_PATH) {
    return path.isAbsolute(process.env.READING_GOAL_CONFIG_PATH)
      ? process.env.READING_GOAL_CONFIG_PATH
      : path.resolve(getLighthouseRoot(), process.env.READING_GOAL_CONFIG_PATH);
  }
  return path.join(getLighthouseRoot(), "data", "reading-goals.json");
}

// ----------------------------------------------------------------------------
// Normalization & Date Utilities
// ----------------------------------------------------------------------------

export function normalizePercentage(raw: any): number {
  if (raw === null || raw === undefined) return 0;
  let val = typeof raw === "number" ? raw : parseFloat(String(raw));
  if (isNaN(val)) return 0;
  if (val > 1) val = val / 100;
  return Math.max(0, Math.min(1, val));
}

export function normalizeTimestamp(raw: any): number {
  if (typeof raw !== "number") {
    raw = parseInt(String(raw || 0), 10);
  }
  if (isNaN(raw) || raw <= 0) return 0;
  // If in milliseconds, convert to seconds
  if (raw > 1e11) {
    return Math.floor(raw / 1000);
  }
  return raw;
}

export function formatEpochDate(epochSec: number): string {
  if (!epochSec || epochSec <= 0) return "1970-01-01";
  return new Date(epochSec * 1000).toISOString().split("T")[0];
}

export function dayNumberFromDateString(dateStr: string): number {
  const parts = dateStr.split("-").map(Number);
  if (parts.length !== 3 || parts.some(isNaN)) return 0;
  return Math.floor(Date.UTC(parts[0], parts[1] - 1, parts[2]) / 86400000);
}

export function dateStringToAdjacentDay(dateStr: string, offsetDays: number): string {
  const parts = dateStr.split("-").map(Number);
  if (parts.length !== 3 || parts.some(isNaN)) return dateStr;
  const ms = Date.UTC(parts[0], parts[1] - 1, parts[2]) + offsetDays * 86400000;
  return new Date(ms).toISOString().split("T")[0];
}

export function dateDiffInDays(d1: string, d2: string): number {
  return dayNumberFromDateString(d2) - dayNumberFromDateString(d1);
}

// ----------------------------------------------------------------------------
// Core Session Derivation Logic
// ----------------------------------------------------------------------------

/**
 * Derives discrete reading sessions from raw sequential progress updates.
 * Groups records per document, then walks updates chronologically.
 * If consecutive updates are within `idleGapSeconds` (default 30 mins), they
 * extend the current session. If the gap exceeds the threshold, the session closes
 * and a new one begins. Single-ping updates receive `minDurationSeconds`.
 */
export function deriveReadingSessions(
  records: RawProgressRecord[],
  options?: {
    idleGapSeconds?: number;
    minDurationSeconds?: number;
  },
): ReadingSession[] {
  const idleGapSec = options?.idleGapSeconds ?? DEFAULT_IDLE_GAP_SECONDS;
  const minDurationSec = options?.minDurationSeconds ?? DEFAULT_MIN_SESSION_DURATION;

  // Filter valid records with timestamps
  const validRecords = records
    .map((r) => ({
      ...r,
      timestamp: normalizeTimestamp(r.timestamp),
      percentage: normalizePercentage(r.percentage),
      document: (r.document || "").trim(),
    }))
    .filter((r) => r.timestamp > 0 && r.document.length > 0);

  // Group by document
  const byDoc = new Map<string, typeof validRecords>();
  for (const r of validRecords) {
    if (!byDoc.has(r.document)) byDoc.set(r.document, []);
    byDoc.get(r.document)!.push(r);
  }

  const sessions: ReadingSession[] = [];

  for (const [doc, docRows] of byDoc.entries()) {
    // Sort chronologically ascending
    docRows.sort((a, b) => a.timestamp - b.timestamp);

    let cur: {
      document: string;
      bookId: number | null;
      title: string;
      authors: string;
      device: string;
      startTime: number;
      endTime: number;
      startPercentage: number;
      endPercentage: number;
      updatesCount: number;
    } | null = null;

    for (const r of docRows) {
      const docTitle = r.title || (r.filename ? r.filename.replace(/\.(epub|kepub\.epub)$/i, "") : "Unknown");
      const docAuthors = r.authors || "";
      const deviceName = r.device || "KOReader";

      if (!cur) {
        cur = {
          document: doc,
          bookId: r.bookId ?? null,
          title: docTitle,
          authors: docAuthors,
          device: deviceName,
          startTime: r.timestamp,
          endTime: r.timestamp,
          startPercentage: r.percentage,
          endPercentage: r.percentage,
          updatesCount: 1,
        };
      } else {
        const gap = r.timestamp - cur.endTime;
        if (gap <= idleGapSec) {
          // Extend session
          cur.endTime = Math.max(cur.endTime, r.timestamp);
          cur.endPercentage = r.percentage;
          cur.updatesCount++;
          if (r.device) cur.device = r.device;
          if (r.bookId && !cur.bookId) cur.bookId = r.bookId;
          if (docTitle !== "Unknown" && cur.title === "Unknown") cur.title = docTitle;
          if (docAuthors && !cur.authors) cur.authors = docAuthors;
        } else {
          // Close session and start new
          const duration = cur.endTime > cur.startTime
            ? Math.max(minDurationSec, cur.endTime - cur.startTime)
            : minDurationSec;
          const progressDelta = Math.max(0, cur.endPercentage - cur.startPercentage);

          sessions.push({
            id: `sess_${cur.document.slice(0, 8)}_${cur.startTime}`,
            document: cur.document,
            bookId: cur.bookId,
            title: cur.title,
            authors: cur.authors,
            device: cur.device,
            startTime: cur.startTime,
            endTime: cur.endTime,
            durationSeconds: duration,
            startPercentage: cur.startPercentage,
            endPercentage: cur.endPercentage,
            progressDelta,
            updatesCount: cur.updatesCount,
            date: formatEpochDate(cur.startTime),
          });

          cur = {
            document: doc,
            bookId: r.bookId ?? null,
            title: docTitle,
            authors: docAuthors,
            device: deviceName,
            startTime: r.timestamp,
            endTime: r.timestamp,
            startPercentage: r.percentage,
            endPercentage: r.percentage,
            updatesCount: 1,
          };
        }
      }
    }

    if (cur) {
      const duration = cur.endTime > cur.startTime
        ? Math.max(minDurationSec, cur.endTime - cur.startTime)
        : minDurationSec;
      const progressDelta = Math.max(0, cur.endPercentage - cur.startPercentage);

      sessions.push({
        id: `sess_${cur.document.slice(0, 8)}_${cur.startTime}`,
        document: cur.document,
        bookId: cur.bookId,
        title: cur.title,
        authors: cur.authors,
        device: cur.device,
        startTime: cur.startTime,
        endTime: cur.endTime,
        durationSeconds: duration,
        startPercentage: cur.startPercentage,
        endPercentage: cur.endPercentage,
        progressDelta,
        updatesCount: cur.updatesCount,
        date: formatEpochDate(cur.startTime),
      });
    }
  }

  // Sort globally by startTime DESC (most recent first)
  sessions.sort((a, b) => b.startTime - a.startTime);
  return sessions;
}

// ----------------------------------------------------------------------------
// Reading Streaks Computation
// ----------------------------------------------------------------------------

/**
 * Computes current reading streak, longest streak, and total reading days.
 * An active streak requires reading today OR yesterday (yesterday keeps the
 * streak active while today is still in progress).
 */
export function computeReadingStreaks(
  activeDays: Iterable<string>,
  referenceDate?: string,
): ReadingStreaks {
  const uniqueDates = Array.from(new Set(activeDays))
    .filter((d) => /^\d{4}-\d{2}-\d{2}$/.test(d))
    .sort((a, b) => a.localeCompare(b));

  if (uniqueDates.length === 0) {
    return {
      currentStreak: 0,
      longestStreak: 0,
      readingDaysCount: 0,
      lastReadingDate: null,
      isActiveToday: false,
    };
  }

  const dateSet = new Set(uniqueDates);
  const ref = referenceDate || new Date().toISOString().split("T")[0];
  const yesterday = dateStringToAdjacentDay(ref, -1);

  // 1. Longest streak
  let longestStreak = 1;
  let currentRun = 1;
  for (let i = 1; i < uniqueDates.length; i++) {
    const diff = dateDiffInDays(uniqueDates[i - 1], uniqueDates[i]);
    if (diff === 1) {
      currentRun++;
    } else if (diff > 1) {
      longestStreak = Math.max(longestStreak, currentRun);
      currentRun = 1;
    }
  }
  longestStreak = Math.max(longestStreak, currentRun);

  // 2. Current streak
  let currentStreak = 0;
  const isActiveToday = dateSet.has(ref);
  const isActiveYesterday = dateSet.has(yesterday);

  if (isActiveToday) {
    let checkDay = ref;
    while (dateSet.has(checkDay)) {
      currentStreak++;
      checkDay = dateStringToAdjacentDay(checkDay, -1);
    }
  } else if (isActiveYesterday) {
    let checkDay = yesterday;
    while (dateSet.has(checkDay)) {
      currentStreak++;
      checkDay = dateStringToAdjacentDay(checkDay, -1);
    }
  }

  return {
    currentStreak,
    longestStreak,
    readingDaysCount: uniqueDates.length,
    lastReadingDate: uniqueDates[uniqueDates.length - 1],
    isActiveToday,
  };
}

// ----------------------------------------------------------------------------
// Daily Reading Time Summary
// ----------------------------------------------------------------------------

export function computeDailyReadingTime(
  sessions: ReadingSession[],
  referenceDate?: string,
): ReadingTimeSummary {
  const ref = referenceDate || new Date().toISOString().split("T")[0];
  const refParts = ref.split("-").map(Number);
  const curMonthPrefix = `${refParts[0]}-${String(refParts[1]).padStart(2, "0")}`;

  // Days in past 7 days: [ref - 6 days, ..., ref]
  const past7Days = new Set<string>();
  for (let i = 0; i < 7; i++) {
    past7Days.add(dateStringToAdjacentDay(ref, -i));
  }

  const byDay = new Map<string, { seconds: number; sessionsCount: number; books: Set<string> }>();

  for (const s of sessions) {
    const d = s.date;
    if (!byDay.has(d)) {
      byDay.set(d, { seconds: 0, sessionsCount: 0, books: new Set() });
    }
    const entry = byDay.get(d)!;
    entry.seconds += s.durationSeconds;
    entry.sessionsCount++;
    if (s.title && s.title !== "Unknown") {
      entry.books.add(s.title);
    }
  }

  let totalSeconds = 0;
  let todaySeconds = 0;
  let thisWeekSeconds = 0;
  let thisMonthSeconds = 0;

  const days: DailyReadingEntry[] = [];
  const sortedDays = Array.from(byDay.keys()).sort((a, b) => b.localeCompare(a)); // DESC

  for (const d of sortedDays) {
    const st = byDay.get(d)!;
    const booksList = Array.from(st.books);
    days.push({
      date: d,
      seconds: st.seconds,
      minutes: Math.round(st.seconds / 60),
      sessionsCount: st.sessionsCount,
      bookCount: booksList.length,
      books: booksList,
    });

    totalSeconds += st.seconds;
    if (d === ref) {
      todaySeconds += st.seconds;
    }
    if (past7Days.has(d)) {
      thisWeekSeconds += st.seconds;
    }
    if (d.startsWith(curMonthPrefix)) {
      thisMonthSeconds += st.seconds;
    }
  }

  const distinctDaysCount = byDay.size;
  const dailyAverageMinutes = distinctDaysCount > 0
    ? Math.round((totalSeconds / 60) / distinctDaysCount)
    : 0;

  return {
    days,
    todaySeconds,
    todayMinutes: Math.round(todaySeconds / 60),
    thisWeekSeconds,
    thisWeekMinutes: Math.round(thisWeekSeconds / 60),
    thisMonthSeconds,
    thisMonthMinutes: Math.round(thisMonthSeconds / 60),
    totalSeconds,
    totalHours: Math.round((totalSeconds / 3600) * 10) / 10,
    dailyAverageMinutes,
  };
}

// ----------------------------------------------------------------------------
// Heatmap Generation (Activity Per Day)
// ----------------------------------------------------------------------------

export function computeReadingHeatmap(
  sessions: ReadingSession[],
  options?: {
    days?: number;
    endDate?: string;
  },
): HeatmapDay[] {
  const numDays = options?.days ?? 365;
  const endDateStr = options?.endDate || new Date().toISOString().split("T")[0];

  // Aggregate sessions by date
  const byDate = new Map<string, { seconds: number; count: number; books: Set<string> }>();
  for (const s of sessions) {
    if (!byDate.has(s.date)) {
      byDate.set(s.date, { seconds: 0, count: 0, books: new Set() });
    }
    const cur = byDate.get(s.date)!;
    cur.seconds += s.durationSeconds;
    cur.count++;
    if (s.title && s.title !== "Unknown") {
      cur.books.add(s.title);
    }
  }

  // Generate sequence of dates from (endDate - (numDays - 1)) to endDate
  const heatmap: HeatmapDay[] = [];
  for (let i = numDays - 1; i >= 0; i--) {
    const curDate = dateStringToAdjacentDay(endDateStr, -i);
    const activity = byDate.get(curDate);
    if (!activity || activity.seconds <= 0) {
      heatmap.push({
        date: curDate,
        count: 0,
        seconds: 0,
        minutes: 0,
        level: 0,
        bookCount: 0,
        books: [],
      });
    } else {
      const minutes = Math.round(activity.seconds / 60);
      let level: 0 | 1 | 2 | 3 | 4 = 1;
      if (minutes >= 60) level = 4;
      else if (minutes >= 30) level = 3;
      else if (minutes >= 15) level = 2;
      else if (minutes >= 1) level = 1;
      else level = 0;

      const booksList = Array.from(activity.books);
      heatmap.push({
        date: curDate,
        count: activity.count,
        seconds: activity.seconds,
        minutes,
        level,
        bookCount: booksList.length,
        books: booksList,
      });
    }
  }

  return heatmap;
}

// ----------------------------------------------------------------------------
// Library Health Calculation
// ----------------------------------------------------------------------------

export function computeLibraryHealth(
  calibreBooks: Array<{ id: number; title: string; authors?: string }>,
  latestProgressList: Array<{
    bookId?: number | null;
    document?: string;
    percentage: number;
    timestamp: number;
    title?: string;
    authors?: string;
  }>,
  options?: {
    staleDaysThreshold?: number;
    referenceDate?: string;
  },
): LibraryHealth {
  const thresholdDays = options?.staleDaysThreshold ?? DEFAULT_STALE_DAYS_THRESHOLD;
  const refDateStr = options?.referenceDate || new Date().toISOString().split("T")[0];
  const refDayNumber = dayNumberFromDateString(refDateStr);

  // Index latest progress by bookId and by title/document
  const progressByBookId = new Map<number, (typeof latestProgressList)[0]>();
  const progressByTitle = new Map<string, (typeof latestProgressList)[0]>();

  for (const p of latestProgressList) {
    if (p.bookId && !progressByBookId.has(p.bookId)) {
      progressByBookId.set(p.bookId, p);
    }
    const cleanT = (p.title || "").trim().toLowerCase();
    if (cleanT && !progressByTitle.has(cleanT)) {
      progressByTitle.set(cleanT, p);
    }
  }

  let unreadCount = 0;
  let inProgressCount = 0;
  let finishedCount = 0;
  const staleReads: StaleRead[] = [];

  for (const b of calibreBooks) {
    const sync = progressByBookId.get(b.id) || progressByTitle.get((b.title || "").trim().toLowerCase());
    const pct = sync ? normalizePercentage(sync.percentage) : 0;

    if (pct >= 0.99) {
      finishedCount++;
    } else if (pct > 0) {
      inProgressCount++;
      const lastReadDateStr = sync.timestamp ? formatEpochDate(sync.timestamp) : "1970-01-01";
      const lastReadDayNum = dayNumberFromDateString(lastReadDateStr);
      const daysInactive = Math.max(0, refDayNumber - lastReadDayNum);

      if (daysInactive >= thresholdDays) {
        staleReads.push({
          bookId: b.id,
          document: sync.document || "",
          title: b.title,
          authors: b.authors || sync.authors || "",
          percentage: Math.round(pct * 1000) / 10,
          lastReadDate: lastReadDateStr,
          daysInactive,
        });
      }
    } else {
      unreadCount++;
    }
  }

  // Sort stale reads by daysInactive DESC (longest neglected first)
  staleReads.sort((a, b) => b.daysInactive - a.daysInactive);

  const total = calibreBooks.length;
  const unreadPercentage = total > 0 ? Math.round((unreadCount / total) * 1000) / 10 : 0;
  const inProgressPercentage = total > 0 ? Math.round((inProgressCount / total) * 1000) / 10 : 0;
  const finishedPercentage = total > 0 ? Math.round((finishedCount / total) * 1000) / 10 : 0;

  return {
    totalBooks: total,
    unreadCount,
    inProgressCount,
    finishedCount,
    unreadPercentage,
    inProgressPercentage,
    finishedPercentage,
    staleCount: staleReads.length,
    staleThresholdDays: thresholdDays,
    staleReads,
  };
}

// ----------------------------------------------------------------------------
// Yearly Reading Goals Store & Progress
// ----------------------------------------------------------------------------

export function getReadingGoalsConfig(): Record<string, ReadingGoalConfig> {
  const p = getReadingGoalsConfigPath();
  try {
    if (fs.existsSync(p)) {
      const raw = fs.readFileSync(p, "utf-8");
      const parsed = JSON.parse(raw);
      if (parsed && typeof parsed.goals === "object") {
        return parsed.goals;
      }
    }
  } catch (e) {
    console.warn("[Reading Goals] Failed to read goals config:", e);
  }
  return {};
}

export function saveReadingGoalsConfig(goals: Record<string, ReadingGoalConfig>): boolean {
  const p = getReadingGoalsConfigPath();
  try {
    const dir = path.dirname(p);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
    const tmp = `${p}.tmp.${Date.now()}`;
    fs.writeFileSync(tmp, JSON.stringify({ goals }, null, 2), "utf-8");
    fs.renameSync(tmp, p);
    return true;
  } catch (e) {
    console.error("[Reading Goals] Failed to save goals config:", e);
    return false;
  }
}

export function getReadingGoal(year: number): ReadingGoalConfig {
  const all = getReadingGoalsConfig();
  const cfg = all[String(year)];
  return {
    year,
    targetBooks: typeof cfg?.targetBooks === "number" ? cfg.targetBooks : null,
    targetHours: typeof cfg?.targetHours === "number" ? cfg.targetHours : null,
  };
}

export function setReadingGoal(
  year: number,
  goal: { targetBooks?: number | null; targetHours?: number | null },
): ReadingGoalConfig {
  const all = getReadingGoalsConfig();
  const targetBooks = typeof goal.targetBooks === "number" && goal.targetBooks > 0 ? Math.round(goal.targetBooks) : null;
  const targetHours = typeof goal.targetHours === "number" && goal.targetHours > 0 ? Math.round(goal.targetHours) : null;

  const updated: ReadingGoalConfig = {
    year,
    targetBooks,
    targetHours,
  };

  all[String(year)] = updated;
  saveReadingGoalsConfig(all);
  return updated;
}

export function computeYearlyGoalProgress(
  year: number,
  goalConfig: ReadingGoalConfig,
  sessions: ReadingSession[],
  finishedBooks: Array<{ percentage: number; timestamp?: number }>,
): ReadingGoalProgress {
  const yearPrefix = `${year}-`;

  // Hours read in this year
  let yearSeconds = 0;
  for (const s of sessions) {
    if (s.date.startsWith(yearPrefix)) {
      yearSeconds += s.durationSeconds;
    }
  }
  const currentHours = Math.round((yearSeconds / 3600) * 10) / 10;

  // Finished books in this year
  let currentBooks = 0;
  for (const b of finishedBooks) {
    if (b.timestamp) {
      const finishYear = new Date(b.timestamp * 1000).getFullYear();
      if (finishYear === year) currentBooks++;
    } else {
      currentBooks++;
    }
  }

  const targetBooks = goalConfig.targetBooks ?? null;
  const targetHours = goalConfig.targetHours ?? null;

  const booksPercent = targetBooks && targetBooks > 0
    ? Math.min(100, Math.round((currentBooks / targetBooks) * 100))
    : null;

  const hoursPercent = targetHours && targetHours > 0
    ? Math.min(100, Math.round((currentHours / targetHours) * 100))
    : null;

  return {
    year,
    targetBooks,
    targetHours,
    currentBooks,
    currentHours,
    booksPercent,
    hoursPercent,
    isConfigured: Boolean(targetBooks || targetHours),
  };
}

// ----------------------------------------------------------------------------
// Database Querying & Full Statistics Assembly
// ----------------------------------------------------------------------------

export function queryKosyncRecords(
  db: Database,
  options?: {
    calibreHashMap?: Record<string, { id: number; title: string; authors: string; cover: boolean }>;
  },
): {
  rawRecords: RawProgressRecord[];
  latestByBook: any[];
} {
  const map = options?.calibreHashMap || {};

  // Check table presence
  const hasHistory = !!db.query(
    "SELECT name FROM sqlite_master WHERE type='table' AND name='progress_history';",
  ).get();
  const hasProgress = !!db.query(
    "SELECT name FROM sqlite_master WHERE type='table' AND name='progress';",
  ).get();

  const rawRecords: RawProgressRecord[] = [];
  const latestByDoc = new Map<string, any>();

  if (hasHistory) {
    try {
      const historyRows = db
        .query(
          `SELECT
            h.id,
            h.document,
            h.progress,
            h.percentage,
            h.device,
            h.device_id,
            h.timestamp,
            p.title,
            p.authors,
            p.filename
          FROM progress_history h
          LEFT JOIN progress p ON h.document = p.document
          WHERE (h.is_rollback IS NULL OR h.is_rollback = 0)
          ORDER BY h.timestamp ASC;`,
        )
        .all() as any[];

      for (const r of historyRows) {
        let title = r.title || r.filename;
        let authors = r.authors;
        let bookId: number | null = null;

        if (map[r.document]) {
          title = map[r.document].title;
          authors = map[r.document].authors;
          bookId = map[r.document].id;
        }

        rawRecords.push({
          id: r.id,
          document: r.document,
          progress: r.progress,
          percentage: r.percentage,
          device: r.device,
          device_id: r.device_id,
          timestamp: r.timestamp,
          title,
          authors,
          filename: r.filename,
          bookId,
        });

        // Track latest
        const curLatest = latestByDoc.get(r.document);
        if (!curLatest || r.timestamp > curLatest.timestamp) {
          latestByDoc.set(r.document, {
            ...r,
            title,
            authors,
            bookId,
            percentage: normalizePercentage(r.percentage),
          });
        }
      }
    } catch (e) {
      console.warn("[Reading Stats] Error reading progress_history:", e);
    }
  }

  // Also query progress table (or if history wasn't available)
  if (hasProgress) {
    try {
      const progressRows = db
        .query(
          "SELECT id, document, progress, percentage, device, device_id, filename, title, authors, timestamp FROM progress ORDER BY timestamp ASC;",
        )
        .all() as any[];

      for (const r of progressRows) {
        let title = r.title || r.filename;
        let authors = r.authors;
        let bookId: number | null = null;

        if (map[r.document]) {
          title = map[r.document].title;
          authors = map[r.document].authors;
          bookId = map[r.document].id;
        }

        const normalizedPct = normalizePercentage(r.percentage);
        const curLatest = latestByDoc.get(r.document);

        // If history didn't exist or progress has newer timestamp, update latest
        if (!curLatest || r.timestamp >= curLatest.timestamp) {
          latestByDoc.set(r.document, {
            ...r,
            title,
            authors,
            bookId,
            percentage: normalizedPct,
          });
        }

        // If history wasn't used or had 0 rows, use progress table for raw records
        if (!hasHistory || rawRecords.length === 0) {
          rawRecords.push({
            id: r.id,
            document: r.document,
            progress: r.progress,
            percentage: r.percentage,
            device: r.device,
            device_id: r.device_id,
            timestamp: r.timestamp,
            title,
            authors,
            filename: r.filename,
            bookId,
          });
        }
      }
    } catch (e) {
      console.warn("[Reading Stats] Error reading progress table:", e);
    }
  }

  return {
    rawRecords,
    latestByBook: Array.from(latestByDoc.values()),
  };
}

/**
 * Computes full reading statistics payload.
 */
export function buildReadingStatsPayload(params: {
  rawRecords: RawProgressRecord[];
  latestBooks: any[];
  calibreBooks?: Array<{ id: number; title: string; authors?: string }>;
  referenceDate?: string;
  year?: number;
}): ReadingStatsPayload {
  const refDate = params.referenceDate || new Date().toISOString().split("T")[0];
  const targetYear = params.year || parseInt(refDate.split("-")[0], 10) || new Date().getFullYear();

  // 1. Derive sessions
  const sessions = deriveReadingSessions(params.rawRecords);

  // 2. Daily reading time
  const dailyReadingTime = computeDailyReadingTime(sessions, refDate);

  // 3. Streaks
  const activeDaysSet = new Set(dailyReadingTime.days.map((d) => d.date));
  // Also include timestamps from latestBooks if any
  for (const b of params.latestBooks) {
    if (b.timestamp) {
      activeDaysSet.add(formatEpochDate(b.timestamp));
    }
  }
  const streaks = computeReadingStreaks(activeDaysSet, refDate);

  // 4. Heatmap
  const heatmap = computeReadingHeatmap(sessions, { days: 365, endDate: refDate });

  // 5. Finished and active books from latest
  const finishedBooks = params.latestBooks.filter((b) => normalizePercentage(b.percentage) >= 0.99);
  const activeBooks = params.latestBooks.filter((b) => {
    const p = normalizePercentage(b.percentage);
    return p > 0 && p < 0.99;
  });

  // 6. Library health
  const calibreBooks = params.calibreBooks || [];
  const libraryHealth = computeLibraryHealth(calibreBooks, params.latestBooks, {
    referenceDate: refDate,
  });

  // 7. Yearly reading goal
  const goalConfig = getReadingGoal(targetYear);
  const goal = computeYearlyGoalProgress(targetYear, goalConfig, sessions, finishedBooks);

  // 8. Backwards-compatible session count & days
  const totalSessionsCount = sessions.length > 0 ? sessions.length : params.latestBooks.length;
  const readingDaysCount = streaks.readingDaysCount;

  return {
    // Backwards-compatible fields matching GET /api/kosync/stats
    totalSessions: totalSessionsCount,
    readingDaysCount,
    finishedCount: finishedBooks.length,
    finishedBooks,
    activeBooks,

    // Extended fields
    streaks,
    dailyReadingTime,
    heatmap,
    libraryHealth,
    goal,
    recentSessions: sessions.slice(0, 20),
    summary: {
      totalSessionsCount,
      totalReadingSeconds: dailyReadingTime.totalSeconds,
      totalReadingHours: dailyReadingTime.totalHours,
      todayReadingSeconds: dailyReadingTime.todaySeconds,
      thisWeekReadingSeconds: dailyReadingTime.thisWeekSeconds,
      averageDailyMinutes: dailyReadingTime.dailyAverageMinutes,
      currentStreak: streaks.currentStreak,
      longestStreak: streaks.longestStreak,
    },
  };
}
