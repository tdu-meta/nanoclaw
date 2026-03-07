import fs from 'fs';
import path from 'path';

import type Database from 'better-sqlite3';

import type { StatusHeartbeat } from '../status-heartbeat.js';

// --- Interfaces ---

export interface DashboardStatus extends StatusHeartbeat {
  stale: boolean;
}

export interface TimeBucket {
  label: string;
  count: number;
}

export interface GroupActivity {
  jid: string;
  name: string;
  messageCount: number;
  lastMessage: string;
}

export interface TaskSummary {
  active: number;
  paused: number;
  completed: number;
  nextRun: { prompt: string; next_run: string } | null;
}

export interface LatencyStats {
  p50: number;
  p95: number;
  avg: number;
  max: number;
  count: number;
}

// --- Functions ---

const STALE_THRESHOLD_MS = 30_000;

/**
 * Reads `data/status.json`, parses JSON.
 * Returns null if file doesn't exist.
 * Sets `stale: true` if `updatedAt` is older than 30 seconds.
 */
export function readStatusHeartbeat(dataDir: string): DashboardStatus | null {
  const filePath = path.join(dataDir, 'status.json');
  try {
    const raw = fs.readFileSync(filePath, 'utf-8');
    const heartbeat: StatusHeartbeat = JSON.parse(raw);
    const updatedAt = new Date(heartbeat.updatedAt).getTime();
    const stale = Date.now() - updatedAt > STALE_THRESHOLD_MS;
    return { ...heartbeat, stale };
  } catch {
    return null;
  }
}

/**
 * Queries `messages` table for timestamps within window.
 * Groups into time buckets. Each bucket has a `label` (time string) and `count`.
 */
export function queryMessageVolume(
  db: Database.Database,
  windowMs: number,
  bucketCount: number,
): TimeBucket[] {
  const now = Date.now();
  const start = now - windowMs;
  const bucketSize = windowMs / bucketCount;

  // Get all message timestamps within window
  const cutoff = new Date(start).toISOString();
  const rows = db
    .prepare('SELECT timestamp FROM messages WHERE timestamp >= ?')
    .all(cutoff) as Array<{ timestamp: string }>;

  // Initialize buckets
  const buckets: TimeBucket[] = [];
  for (let i = 0; i < bucketCount; i++) {
    const bucketStart = new Date(start + i * bucketSize);
    buckets.push({
      label: bucketStart.toLocaleTimeString([], {
        hour: '2-digit',
        minute: '2-digit',
      }),
      count: 0,
    });
  }

  // Place messages into buckets
  for (const row of rows) {
    const ts = new Date(row.timestamp).getTime();
    const bucketIndex = Math.min(
      Math.floor((ts - start) / bucketSize),
      bucketCount - 1,
    );
    if (bucketIndex >= 0 && bucketIndex < bucketCount) {
      buckets[bucketIndex].count++;
    }
  }

  return buckets;
}

/**
 * Joins `messages` and `chats` tables.
 * Groups by `chat_jid`, gets count and max timestamp.
 * Orders by most recent.
 */
export function queryGroupActivity(
  db: Database.Database,
  windowMs: number,
): GroupActivity[] {
  const cutoff = new Date(Date.now() - windowMs).toISOString();

  const rows = db
    .prepare(
      `SELECT m.chat_jid AS jid, COALESCE(c.name, m.chat_jid) AS name,
              COUNT(*) AS messageCount, MAX(m.timestamp) AS lastMessage
       FROM messages m
       LEFT JOIN chats c ON m.chat_jid = c.jid
       WHERE m.timestamp >= ?
       GROUP BY m.chat_jid
       ORDER BY lastMessage DESC`,
    )
    .all(cutoff) as GroupActivity[];

  return rows;
}

/**
 * Counts tasks by status.
 * Gets next upcoming active task.
 */
export function queryScheduledTasksSummary(db: Database.Database): TaskSummary {
  const counts = db
    .prepare(
      `SELECT status, COUNT(*) AS cnt FROM scheduled_tasks GROUP BY status`,
    )
    .all() as Array<{ status: string; cnt: number }>;

  let active = 0;
  let paused = 0;
  let completed = 0;
  for (const row of counts) {
    if (row.status === 'active') active = row.cnt;
    else if (row.status === 'paused') paused = row.cnt;
    else if (row.status === 'completed') completed = row.cnt;
  }

  const nextRow = db
    .prepare(
      `SELECT prompt, next_run FROM scheduled_tasks
       WHERE status = 'active' AND next_run IS NOT NULL
       ORDER BY next_run ASC LIMIT 1`,
    )
    .get() as { prompt: string; next_run: string } | undefined;

  return {
    active,
    paused,
    completed,
    nextRun: nextRow
      ? { prompt: nextRow.prompt, next_run: nextRow.next_run }
      : null,
  };
}

/**
 * Queries `task_run_logs` where `status = 'error'` within window.
 * Returns up to 10 most recent.
 */
export function queryTaskRunErrors(
  db: Database.Database,
  windowMs: number,
): Array<{ taskId: string; runAt: string; error: string }> {
  const cutoff = new Date(Date.now() - windowMs).toISOString();

  const rows = db
    .prepare(
      `SELECT task_id, run_at, error FROM task_run_logs
       WHERE status = 'error' AND run_at >= ?
       ORDER BY run_at DESC LIMIT 10`,
    )
    .all(cutoff) as Array<{ task_id: string; run_at: string; error: string }>;

  return rows.map((r) => ({
    taskId: r.task_id,
    runAt: r.run_at,
    error: r.error,
  }));
}

/**
 * Sort durations, compute P50 (index at 50%), P95 (index at 95%).
 * Compute avg, max, count.
 * Empty array returns all zeros.
 */
export function computeLatencyStats(durations: number[]): LatencyStats {
  if (durations.length === 0) {
    return { p50: 0, p95: 0, avg: 0, max: 0, count: 0 };
  }

  const sorted = [...durations].sort((a, b) => a - b);
  const count = sorted.length;
  const p50 = sorted[Math.floor(count * 0.5)];
  const p95 = sorted[Math.floor(count * 0.95)];
  const max = sorted[count - 1];
  const avg = sorted.reduce((sum, v) => sum + v, 0) / count;

  return { p50, p95, avg, max, count };
}
