import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import fs from 'fs';
import os from 'os';
import path from 'path';

import {
  readStatusHeartbeat,
  queryMessageVolume,
  queryGroupActivity,
  queryScheduledTasksSummary,
  queryTaskRunErrors,
  computeLatencyStats,
} from './data.js';

// --- readStatusHeartbeat ---

describe('readStatusHeartbeat', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dashboard-data-'));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('reads a valid status.json and returns DashboardStatus', () => {
    const now = new Date().toISOString();
    const status = {
      pid: 1234,
      startedAt: '2024-01-01T00:00:00.000Z',
      channels: [{ name: 'whatsapp', connected: true }],
      updatedAt: now,
    };
    fs.writeFileSync(path.join(tmpDir, 'status.json'), JSON.stringify(status));

    const result = readStatusHeartbeat(tmpDir);
    expect(result).not.toBeNull();
    expect(result!.pid).toBe(1234);
    expect(result!.channels).toHaveLength(1);
    expect(result!.stale).toBe(false);
  });

  it('returns null when status.json does not exist', () => {
    const result = readStatusHeartbeat(tmpDir);
    expect(result).toBeNull();
  });

  it('marks stale when updatedAt is older than 30 seconds', () => {
    const oldDate = new Date(Date.now() - 60_000).toISOString();
    const status = {
      pid: 5678,
      startedAt: '2024-01-01T00:00:00.000Z',
      channels: [],
      updatedAt: oldDate,
    };
    fs.writeFileSync(path.join(tmpDir, 'status.json'), JSON.stringify(status));

    const result = readStatusHeartbeat(tmpDir);
    expect(result).not.toBeNull();
    expect(result!.stale).toBe(true);
  });
});

// --- Helper to create in-memory DB with schema ---

function createTestDb(): Database.Database {
  const db = new Database(':memory:');
  db.exec(`
    CREATE TABLE chats (
      jid TEXT PRIMARY KEY, name TEXT, last_message_time TEXT,
      channel TEXT, is_group INTEGER DEFAULT 0
    );
    CREATE TABLE messages (
      id TEXT, chat_jid TEXT, sender TEXT, sender_name TEXT,
      content TEXT, timestamp TEXT, is_from_me INTEGER,
      is_bot_message INTEGER DEFAULT 0,
      PRIMARY KEY (id, chat_jid)
    );
    CREATE INDEX idx_timestamp ON messages(timestamp);
    CREATE TABLE scheduled_tasks (
      id TEXT PRIMARY KEY, group_folder TEXT NOT NULL, chat_jid TEXT NOT NULL,
      prompt TEXT NOT NULL, schedule_type TEXT NOT NULL, schedule_value TEXT NOT NULL,
      next_run TEXT, last_run TEXT, last_result TEXT,
      status TEXT DEFAULT 'active', created_at TEXT NOT NULL
    );
    CREATE TABLE task_run_logs (
      id INTEGER PRIMARY KEY AUTOINCREMENT, task_id TEXT NOT NULL,
      run_at TEXT NOT NULL, duration_ms INTEGER NOT NULL,
      status TEXT NOT NULL, result TEXT, error TEXT
    );
  `);
  return db;
}

// --- queryMessageVolume ---

describe('queryMessageVolume', () => {
  let db: Database.Database;

  beforeEach(() => {
    db = createTestDb();
  });

  afterEach(() => {
    db.close();
  });

  it('returns buckets with correct counts', () => {
    const now = Date.now();
    const windowMs = 60_000; // 1 minute
    const bucketCount = 4;

    // Insert messages spread across the window
    const insert = db.prepare(
      'INSERT INTO messages (id, chat_jid, sender, sender_name, content, timestamp, is_from_me) VALUES (?, ?, ?, ?, ?, ?, ?)',
    );
    for (let i = 0; i < 8; i++) {
      const ts = new Date(now - windowMs + (i * windowMs) / 8).toISOString();
      insert.run(`m${i}`, 'g@g.us', 'u', 'User', 'hi', ts, 0);
    }

    const buckets = queryMessageVolume(db, windowMs, bucketCount);
    expect(buckets).toHaveLength(bucketCount);

    // Total count across buckets should equal 8
    const total = buckets.reduce((sum, b) => sum + b.count, 0);
    expect(total).toBe(8);

    // Each bucket should have a label
    for (const b of buckets) {
      expect(typeof b.label).toBe('string');
      expect(b.label.length).toBeGreaterThan(0);
    }
  });

  it('returns empty buckets when no messages exist', () => {
    const buckets = queryMessageVolume(db, 60_000, 4);
    expect(buckets).toHaveLength(4);
    const total = buckets.reduce((sum, b) => sum + b.count, 0);
    expect(total).toBe(0);
  });
});

// --- queryGroupActivity ---

describe('queryGroupActivity', () => {
  let db: Database.Database;

  beforeEach(() => {
    db = createTestDb();
  });

  afterEach(() => {
    db.close();
  });

  it('returns groups ordered by most recent message', () => {
    const now = Date.now();
    db.exec(
      `INSERT INTO chats (jid, name) VALUES ('g1@g.us', 'Group 1'), ('g2@g.us', 'Group 2')`,
    );
    const insert = db.prepare(
      'INSERT INTO messages (id, chat_jid, sender, sender_name, content, timestamp, is_from_me) VALUES (?, ?, ?, ?, ?, ?, ?)',
    );
    // g1 has 2 older messages
    insert.run(
      'm1',
      'g1@g.us',
      'u',
      'U',
      'a',
      new Date(now - 50_000).toISOString(),
      0,
    );
    insert.run(
      'm2',
      'g1@g.us',
      'u',
      'U',
      'b',
      new Date(now - 40_000).toISOString(),
      0,
    );
    // g2 has 1 newer message
    insert.run(
      'm3',
      'g2@g.us',
      'u',
      'U',
      'c',
      new Date(now - 10_000).toISOString(),
      0,
    );

    const activity = queryGroupActivity(db, 60_000);
    expect(activity).toHaveLength(2);
    expect(activity[0].jid).toBe('g2@g.us');
    expect(activity[0].messageCount).toBe(1);
    expect(activity[1].jid).toBe('g1@g.us');
    expect(activity[1].messageCount).toBe(2);
  });
});

// --- queryScheduledTasksSummary ---

describe('queryScheduledTasksSummary', () => {
  let db: Database.Database;

  beforeEach(() => {
    db = createTestDb();
  });

  afterEach(() => {
    db.close();
  });

  it('counts tasks by status and finds next run', () => {
    const insertTask = db.prepare(
      `INSERT INTO scheduled_tasks (id, group_folder, chat_jid, prompt, schedule_type, schedule_value, next_run, status, created_at)
       VALUES (?, 'main', 'g@g.us', ?, 'once', '2024-01-01', ?, ?, '2024-01-01')`,
    );
    insertTask.run('t1', 'task 1', '2099-01-01T00:00:00.000Z', 'active');
    insertTask.run('t2', 'task 2', '2099-06-01T00:00:00.000Z', 'active');
    insertTask.run('t3', 'task 3', null, 'paused');
    insertTask.run('t4', 'task 4', null, 'completed');

    const summary = queryScheduledTasksSummary(db);
    expect(summary.active).toBe(2);
    expect(summary.paused).toBe(1);
    expect(summary.completed).toBe(1);
    expect(summary.nextRun).not.toBeNull();
    expect(summary.nextRun!.prompt).toBe('task 1');
    expect(summary.nextRun!.next_run).toBe('2099-01-01T00:00:00.000Z');
  });

  it('returns null nextRun when no active tasks with next_run', () => {
    const summary = queryScheduledTasksSummary(db);
    expect(summary.active).toBe(0);
    expect(summary.nextRun).toBeNull();
  });
});

// --- queryTaskRunErrors ---

describe('queryTaskRunErrors', () => {
  let db: Database.Database;

  beforeEach(() => {
    db = createTestDb();
  });

  afterEach(() => {
    db.close();
  });

  it('returns recent errors within window', () => {
    const now = Date.now();
    const insert = db.prepare(
      `INSERT INTO task_run_logs (task_id, run_at, duration_ms, status, error) VALUES (?, ?, 100, ?, ?)`,
    );
    insert.run('t1', new Date(now - 5_000).toISOString(), 'error', 'boom');
    insert.run('t1', new Date(now - 3_000).toISOString(), 'success', null);
    insert.run('t2', new Date(now - 1_000).toISOString(), 'error', 'fail');

    const errors = queryTaskRunErrors(db, 60_000);
    expect(errors).toHaveLength(2);
    // Most recent first
    expect(errors[0].error).toBe('fail');
    expect(errors[1].error).toBe('boom');
  });
});

// --- computeLatencyStats ---

describe('computeLatencyStats', () => {
  it('computes percentiles correctly', () => {
    // 1..100
    const durations = Array.from({ length: 100 }, (_, i) => i + 1);
    const stats = computeLatencyStats(durations);
    expect(stats.count).toBe(100);
    expect(stats.p50).toBe(51); // index 50 in sorted 1..100
    expect(stats.p95).toBe(96); // index 95 in sorted 1..100
    expect(stats.avg).toBe(50.5);
    expect(stats.max).toBe(100);
  });

  it('handles empty array', () => {
    const stats = computeLatencyStats([]);
    expect(stats).toEqual({ p50: 0, p95: 0, avg: 0, max: 0, count: 0 });
  });

  it('handles single element', () => {
    const stats = computeLatencyStats([42]);
    expect(stats.count).toBe(1);
    expect(stats.p50).toBe(42);
    expect(stats.p95).toBe(42);
    expect(stats.avg).toBe(42);
    expect(stats.max).toBe(42);
  });

  it('sorts unsorted input', () => {
    const stats = computeLatencyStats([100, 1, 50, 25, 75]);
    expect(stats.max).toBe(100);
    expect(stats.p50).toBe(50);
    expect(stats.count).toBe(5);
  });
});
