# Observability Dashboard Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Build a terminal-based observability dashboard that shows NanoClaw health at a glance: uptime, channel status, message volume, response latency, container errors, and scheduled tasks.

**Architecture:** A standalone CLI (`npm run dashboard`) that reads from the existing SQLite database, container log files, and a new `data/status.json` heartbeat file. The only core change is adding a ~15-line heartbeat writer to `src/index.ts`. The dashboard uses raw ANSI escape codes for rendering (no TUI library).

**Tech Stack:** TypeScript, better-sqlite3 (read-only), fs for log parsing, ANSI escape codes for TUI rendering.

---

### Task 1: Status Heartbeat Writer (core change)

**Files:**
- Create: `src/status-heartbeat.ts`
- Modify: `src/index.ts:471-588` (main function)
- Test: `src/status-heartbeat.test.ts`

**Step 1: Write the failing test**

Create `src/status-heartbeat.test.ts`:

```typescript
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import path from 'path';
import os from 'os';

import { writeStatusHeartbeat, StatusHeartbeat } from './status-heartbeat.js';

describe('writeStatusHeartbeat', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nanoclaw-test-'));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('writes status.json with channel info', () => {
    const channels = [
      { name: 'whatsapp', connected: true },
      { name: 'feishu', connected: false },
    ];

    writeStatusHeartbeat(tmpDir, channels);

    const content = JSON.parse(
      fs.readFileSync(path.join(tmpDir, 'status.json'), 'utf-8'),
    ) as StatusHeartbeat;

    expect(content.pid).toBe(process.pid);
    expect(content.channels).toHaveLength(2);
    expect(content.channels[0].name).toBe('whatsapp');
    expect(content.channels[0].connected).toBe(true);
    expect(content.channels[1].connected).toBe(false);
    expect(content.updatedAt).toBeDefined();
    expect(content.startedAt).toBeDefined();
  });

  it('uses atomic write (temp file + rename)', () => {
    writeStatusHeartbeat(tmpDir, []);

    // File should exist and be valid JSON
    const content = JSON.parse(
      fs.readFileSync(path.join(tmpDir, 'status.json'), 'utf-8'),
    );
    expect(content.pid).toBe(process.pid);
  });
});
```

**Step 2: Run test to verify it fails**

Run: `npx vitest run src/status-heartbeat.test.ts`
Expected: FAIL — module `./status-heartbeat.js` not found

**Step 3: Write minimal implementation**

Create `src/status-heartbeat.ts`:

```typescript
import fs from 'fs';
import path from 'path';

export interface StatusChannel {
  name: string;
  connected: boolean;
}

export interface StatusHeartbeat {
  pid: number;
  startedAt: string;
  channels: StatusChannel[];
  updatedAt: string;
}

const startedAt = new Date().toISOString();

export function writeStatusHeartbeat(
  dataDir: string,
  channels: Array<{ name: string; connected: boolean }>,
): void {
  fs.mkdirSync(dataDir, { recursive: true });

  const heartbeat: StatusHeartbeat = {
    pid: process.pid,
    startedAt,
    channels: channels.map((ch) => ({
      name: ch.name,
      connected: ch.connected,
    })),
    updatedAt: new Date().toISOString(),
  };

  const filePath = path.join(dataDir, 'status.json');
  const tempPath = `${filePath}.tmp`;
  fs.writeFileSync(tempPath, JSON.stringify(heartbeat, null, 2));
  fs.renameSync(tempPath, filePath);
}
```

**Step 4: Run test to verify it passes**

Run: `npx vitest run src/status-heartbeat.test.ts`
Expected: PASS

**Step 5: Wire into main**

Modify `src/index.ts`. After all channels are connected (after the `for` loop at ~line 527-545), add:

```typescript
import { writeStatusHeartbeat } from './status-heartbeat.js';
import { DATA_DIR } from './config.js';

// ... inside main(), after channels are connected:

// Status heartbeat — write channel status every 10s for the dashboard
const heartbeatInterval = setInterval(() => {
  writeStatusHeartbeat(
    DATA_DIR,
    channels.map((ch) => ({ name: ch.name, connected: ch.isConnected() })),
  );
}, 10_000);
// Write once immediately
writeStatusHeartbeat(
  DATA_DIR,
  channels.map((ch) => ({ name: ch.name, connected: ch.isConnected() })),
);

// Clean up on shutdown (add to shutdown handler):
// clearInterval(heartbeatInterval);
```

Also update the `shutdown` function to clear the interval and delete the status file:

```typescript
const shutdown = async (signal: string) => {
  logger.info({ signal }, 'Shutdown signal received');
  clearInterval(heartbeatInterval);
  // Remove status file so dashboard shows "Down"
  try { fs.unlinkSync(path.join(DATA_DIR, 'status.json')); } catch {}
  await queue.shutdown(10000);
  for (const ch of channels) await ch.disconnect();
  process.exit(0);
};
```

**Step 6: Run all tests**

Run: `npx vitest run`
Expected: All tests PASS

**Step 7: Commit**

```bash
git add src/status-heartbeat.ts src/status-heartbeat.test.ts src/index.ts
git commit -m "feat: add status heartbeat writer for dashboard"
```

---

### Task 2: Container Log Parser

**Files:**
- Create: `src/dashboard/log-parser.ts`
- Test: `src/dashboard/log-parser.test.ts`

**Step 1: Write the failing test**

Create `src/dashboard/log-parser.test.ts`:

```typescript
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import path from 'path';
import os from 'os';

import { parseContainerLogs, ContainerLogEntry } from './log-parser.js';

describe('parseContainerLogs', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nanoclaw-logs-'));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('parses a successful container log', () => {
    const logDir = path.join(tmpDir, 'test-group', 'logs');
    fs.mkdirSync(logDir, { recursive: true });
    fs.writeFileSync(
      path.join(logDir, 'container-2026-03-06T14-00-00-000Z.log'),
      [
        '=== Container Run Log ===',
        'Timestamp: 2026-03-06T14:00:00.000Z',
        'Group: test-group',
        'IsMain: false',
        'Duration: 5823ms',
        'Exit Code: 0',
      ].join('\n'),
    );

    const entries = parseContainerLogs(tmpDir);
    expect(entries).toHaveLength(1);
    expect(entries[0].group).toBe('test-group');
    expect(entries[0].durationMs).toBe(5823);
    expect(entries[0].exitCode).toBe(0);
    expect(entries[0].timedOut).toBe(false);
  });

  it('parses a timeout log', () => {
    const logDir = path.join(tmpDir, 'test-group', 'logs');
    fs.mkdirSync(logDir, { recursive: true });
    fs.writeFileSync(
      path.join(logDir, 'container-2026-03-06T14-00-00-000Z.log'),
      [
        '=== Container Run Log (TIMEOUT) ===',
        'Timestamp: 2026-03-06T14:00:00.000Z',
        'Group: test-group',
        'Container: nanoclaw-test-123',
        'Duration: 1800000ms',
        'Exit Code: 137',
        'Had Streaming Output: true',
      ].join('\n'),
    );

    const entries = parseContainerLogs(tmpDir);
    expect(entries[0].timedOut).toBe(true);
    expect(entries[0].exitCode).toBe(137);
  });

  it('filters by time window', () => {
    const logDir = path.join(tmpDir, 'test-group', 'logs');
    fs.mkdirSync(logDir, { recursive: true });

    // Old log (outside 1h window)
    fs.writeFileSync(
      path.join(logDir, 'container-2026-03-05T10-00-00-000Z.log'),
      [
        '=== Container Run Log ===',
        'Timestamp: 2026-03-05T10:00:00.000Z',
        'Group: test-group',
        'Duration: 1000ms',
        'Exit Code: 0',
      ].join('\n'),
    );

    // Recent log (within 1h window)
    const recent = new Date();
    const ts = recent.toISOString().replace(/[:.]/g, '-');
    fs.writeFileSync(
      path.join(logDir, `container-${ts}.log`),
      [
        '=== Container Run Log ===',
        `Timestamp: ${recent.toISOString()}`,
        'Group: test-group',
        'Duration: 2000ms',
        'Exit Code: 0',
      ].join('\n'),
    );

    const entries = parseContainerLogs(tmpDir, 60 * 60 * 1000); // 1h
    expect(entries).toHaveLength(1);
    expect(entries[0].durationMs).toBe(2000);
  });

  it('returns empty array when no logs exist', () => {
    const entries = parseContainerLogs(tmpDir);
    expect(entries).toEqual([]);
  });
});
```

**Step 2: Run test to verify it fails**

Run: `npx vitest run src/dashboard/log-parser.test.ts`
Expected: FAIL — module not found

**Step 3: Write implementation**

Create `src/dashboard/log-parser.ts`:

```typescript
import fs from 'fs';
import path from 'path';

export interface ContainerLogEntry {
  timestamp: string;
  group: string;
  durationMs: number;
  exitCode: number;
  timedOut: boolean;
  hadStreamingOutput: boolean;
}

/**
 * Parse container log files from groups/*/logs/container-*.log.
 * Optionally filter to logs within `windowMs` milliseconds of now.
 */
export function parseContainerLogs(
  groupsDir: string,
  windowMs?: number,
): ContainerLogEntry[] {
  const entries: ContainerLogEntry[] = [];
  const cutoff = windowMs ? Date.now() - windowMs : 0;

  let groupDirs: string[];
  try {
    groupDirs = fs.readdirSync(groupsDir).filter((d) => {
      try {
        return fs.statSync(path.join(groupsDir, d)).isDirectory();
      } catch {
        return false;
      }
    });
  } catch {
    return [];
  }

  for (const groupDir of groupDirs) {
    const logsDir = path.join(groupsDir, groupDir, 'logs');
    let logFiles: string[];
    try {
      logFiles = fs
        .readdirSync(logsDir)
        .filter((f) => f.startsWith('container-') && f.endsWith('.log'));
    } catch {
      continue;
    }

    for (const logFile of logFiles) {
      // Quick time filter from filename: container-YYYY-MM-DDTHH-MM-SS-SSSZ.log
      if (windowMs) {
        const tsMatch = logFile.match(
          /container-(\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-\d{3}Z)\.log/,
        );
        if (tsMatch) {
          const fileTs = tsMatch[1]
            .replace(/(\d{2})-(\d{2})-(\d{3})Z/, '$1:$2.$3Z')
            .replace(/T(\d{2})-/, 'T$1:');
          const fileTime = new Date(fileTs).getTime();
          if (!isNaN(fileTime) && fileTime < cutoff) continue;
        }
      }

      try {
        const content = fs.readFileSync(path.join(logsDir, logFile), 'utf-8');
        const entry = parseLogContent(content);
        if (entry) entries.push(entry);
      } catch {
        continue;
      }
    }
  }

  return entries.sort((a, b) => a.timestamp.localeCompare(b.timestamp));
}

function parseLogContent(content: string): ContainerLogEntry | null {
  const lines = content.split('\n');

  const timedOut = lines[0]?.includes('(TIMEOUT)') ?? false;

  let timestamp = '';
  let group = '';
  let durationMs = 0;
  let exitCode = 0;
  let hadStreamingOutput = false;

  for (const line of lines) {
    const tsMatch = line.match(/^Timestamp:\s*(.+)/);
    if (tsMatch) timestamp = tsMatch[1].trim();

    const groupMatch = line.match(/^Group:\s*(.+)/);
    if (groupMatch) group = groupMatch[1].trim();

    const durMatch = line.match(/^Duration:\s*(\d+)ms/);
    if (durMatch) durationMs = parseInt(durMatch[1], 10);

    const exitMatch = line.match(/^Exit Code:\s*(\d+)/);
    if (exitMatch) exitCode = parseInt(exitMatch[1], 10);

    const streamMatch = line.match(/^Had Streaming Output:\s*(true|false)/);
    if (streamMatch) hadStreamingOutput = streamMatch[1] === 'true';
  }

  if (!timestamp || !group) return null;

  return { timestamp, group, durationMs, exitCode, timedOut, hadStreamingOutput };
}
```

**Step 4: Run test to verify it passes**

Run: `npx vitest run src/dashboard/log-parser.test.ts`
Expected: PASS

**Step 5: Commit**

```bash
git add src/dashboard/log-parser.ts src/dashboard/log-parser.test.ts
git commit -m "feat(dashboard): add container log parser"
```

---

### Task 3: Dashboard Data Layer

**Files:**
- Create: `src/dashboard/data.ts`
- Test: `src/dashboard/data.test.ts`

**Step 1: Write the failing test**

Create `src/dashboard/data.test.ts`:

```typescript
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import path from 'path';
import os from 'os';
import Database from 'better-sqlite3';

import {
  readStatusHeartbeat,
  queryMessageVolume,
  queryGroupActivity,
  queryScheduledTasksSummary,
  queryTaskRunErrors,
  computeLatencyStats,
} from './data.js';

describe('readStatusHeartbeat', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nanoclaw-dash-'));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('reads a valid status.json', () => {
    fs.writeFileSync(
      path.join(tmpDir, 'status.json'),
      JSON.stringify({
        pid: 123,
        startedAt: '2026-03-06T10:00:00Z',
        channels: [{ name: 'whatsapp', connected: true }],
        updatedAt: new Date().toISOString(),
      }),
    );

    const status = readStatusHeartbeat(tmpDir);
    expect(status).not.toBeNull();
    expect(status!.pid).toBe(123);
    expect(status!.stale).toBe(false);
  });

  it('returns null when file does not exist', () => {
    expect(readStatusHeartbeat(tmpDir)).toBeNull();
  });

  it('marks as stale when updatedAt is old', () => {
    fs.writeFileSync(
      path.join(tmpDir, 'status.json'),
      JSON.stringify({
        pid: 123,
        startedAt: '2026-03-06T10:00:00Z',
        channels: [],
        updatedAt: '2026-01-01T00:00:00Z',
      }),
    );

    const status = readStatusHeartbeat(tmpDir);
    expect(status!.stale).toBe(true);
  });
});

describe('queryMessageVolume', () => {
  let db: Database.Database;

  beforeEach(() => {
    db = new Database(':memory:');
    db.exec(`
      CREATE TABLE messages (
        id TEXT, chat_jid TEXT, sender TEXT, sender_name TEXT,
        content TEXT, timestamp TEXT, is_from_me INTEGER,
        is_bot_message INTEGER DEFAULT 0,
        PRIMARY KEY (id, chat_jid)
      );
    `);
  });

  afterEach(() => {
    db.close();
  });

  it('returns message counts grouped by time bucket', () => {
    const now = new Date();
    const stmt = db.prepare(
      'INSERT INTO messages (id, chat_jid, sender, sender_name, content, timestamp, is_from_me) VALUES (?, ?, ?, ?, ?, ?, ?)',
    );
    for (let i = 0; i < 5; i++) {
      const ts = new Date(now.getTime() - i * 60_000).toISOString();
      stmt.run(`msg-${i}`, 'group1', 'user', 'User', 'hello', ts, 0);
    }

    const buckets = queryMessageVolume(db, 60 * 60 * 1000, 10);
    expect(buckets.length).toBeGreaterThan(0);
    const total = buckets.reduce((sum, b) => sum + b.count, 0);
    expect(total).toBe(5);
  });
});

describe('computeLatencyStats', () => {
  it('computes percentiles correctly', () => {
    const durations = [100, 200, 300, 400, 500, 600, 700, 800, 900, 1000];
    const stats = computeLatencyStats(durations);
    expect(stats.p50).toBe(500);
    expect(stats.p95).toBe(1000);
    expect(stats.avg).toBe(550);
    expect(stats.max).toBe(1000);
    expect(stats.count).toBe(10);
  });

  it('handles empty array', () => {
    const stats = computeLatencyStats([]);
    expect(stats.count).toBe(0);
    expect(stats.p50).toBe(0);
  });
});
```

**Step 2: Run test to verify it fails**

Run: `npx vitest run src/dashboard/data.test.ts`
Expected: FAIL — module not found

**Step 3: Write implementation**

Create `src/dashboard/data.ts`:

```typescript
import Database from 'better-sqlite3';
import fs from 'fs';
import path from 'path';

import { StatusHeartbeat } from '../status-heartbeat.js';

const STALE_THRESHOLD_MS = 30_000;

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

export function readStatusHeartbeat(dataDir: string): DashboardStatus | null {
  const filePath = path.join(dataDir, 'status.json');
  try {
    const content = fs.readFileSync(filePath, 'utf-8');
    const heartbeat: StatusHeartbeat = JSON.parse(content);
    const age = Date.now() - new Date(heartbeat.updatedAt).getTime();
    return { ...heartbeat, stale: age > STALE_THRESHOLD_MS };
  } catch {
    return null;
  }
}

export function queryMessageVolume(
  db: Database.Database,
  windowMs: number,
  bucketCount: number,
): TimeBucket[] {
  const now = Date.now();
  const cutoff = new Date(now - windowMs).toISOString();
  const bucketSize = windowMs / bucketCount;

  const rows = db
    .prepare(
      `SELECT timestamp FROM messages WHERE timestamp > ? ORDER BY timestamp`,
    )
    .all(cutoff) as Array<{ timestamp: string }>;

  const buckets: TimeBucket[] = [];
  for (let i = 0; i < bucketCount; i++) {
    const bucketStart = now - windowMs + i * bucketSize;
    const bucketEnd = bucketStart + bucketSize;
    const label = new Date(bucketStart).toLocaleTimeString('en-US', {
      hour: '2-digit',
      minute: '2-digit',
      hour12: false,
    });
    const count = rows.filter((r) => {
      const t = new Date(r.timestamp).getTime();
      return t >= bucketStart && t < bucketEnd;
    }).length;
    buckets.push({ label, count });
  }

  return buckets;
}

export function queryGroupActivity(
  db: Database.Database,
  windowMs: number,
): GroupActivity[] {
  const cutoff = new Date(Date.now() - windowMs).toISOString();

  return db
    .prepare(
      `
      SELECT m.chat_jid as jid,
             COALESCE(c.name, m.chat_jid) as name,
             COUNT(*) as messageCount,
             MAX(m.timestamp) as lastMessage
      FROM messages m
      LEFT JOIN chats c ON c.jid = m.chat_jid
      WHERE m.timestamp > ?
      GROUP BY m.chat_jid
      ORDER BY lastMessage DESC
    `,
    )
    .all(cutoff) as GroupActivity[];
}

export function queryScheduledTasksSummary(
  db: Database.Database,
): TaskSummary {
  const counts = db
    .prepare(
      `SELECT status, COUNT(*) as count FROM scheduled_tasks GROUP BY status`,
    )
    .all() as Array<{ status: string; count: number }>;

  const summary: TaskSummary = {
    active: 0,
    paused: 0,
    completed: 0,
    nextRun: null,
  };

  for (const row of counts) {
    if (row.status === 'active') summary.active = row.count;
    else if (row.status === 'paused') summary.paused = row.count;
    else if (row.status === 'completed') summary.completed = row.count;
  }

  const next = db
    .prepare(
      `SELECT prompt, next_run FROM scheduled_tasks
       WHERE status = 'active' AND next_run IS NOT NULL
       ORDER BY next_run LIMIT 1`,
    )
    .get() as { prompt: string; next_run: string } | undefined;

  if (next) summary.nextRun = next;

  return summary;
}

export function queryTaskRunErrors(
  db: Database.Database,
  windowMs: number,
): Array<{ taskId: string; runAt: string; error: string }> {
  const cutoff = new Date(Date.now() - windowMs).toISOString();

  return db
    .prepare(
      `SELECT task_id as taskId, run_at as runAt, error
       FROM task_run_logs
       WHERE status = 'error' AND run_at > ? AND error IS NOT NULL
       ORDER BY run_at DESC
       LIMIT 10`,
    )
    .all(cutoff) as Array<{ taskId: string; runAt: string; error: string }>;
}

export function computeLatencyStats(durations: number[]): LatencyStats {
  if (durations.length === 0) {
    return { p50: 0, p95: 0, avg: 0, max: 0, count: 0 };
  }

  const sorted = [...durations].sort((a, b) => a - b);
  const p50Idx = Math.floor(sorted.length * 0.5);
  const p95Idx = Math.min(Math.floor(sorted.length * 0.95), sorted.length - 1);
  const sum = sorted.reduce((a, b) => a + b, 0);

  return {
    p50: sorted[p50Idx],
    p95: sorted[p95Idx],
    avg: Math.round(sum / sorted.length),
    max: sorted[sorted.length - 1],
    count: sorted.length,
  };
}
```

**Step 4: Run test to verify it passes**

Run: `npx vitest run src/dashboard/data.test.ts`
Expected: PASS

**Step 5: Commit**

```bash
git add src/dashboard/data.ts src/dashboard/data.test.ts
git commit -m "feat(dashboard): add data layer for reading metrics"
```

---

### Task 4: ASCII Charts

**Files:**
- Create: `src/dashboard/charts.ts`
- Test: `src/dashboard/charts.test.ts`

**Step 1: Write the failing test**

Create `src/dashboard/charts.test.ts`:

```typescript
import { describe, it, expect } from 'vitest';

import { sparkline, barChart } from './charts.js';

describe('sparkline', () => {
  it('renders values as block chars', () => {
    const result = sparkline([0, 1, 2, 3, 4, 5, 6, 7]);
    // Should produce 8 characters using Unicode block elements
    expect(result).toHaveLength(8);
    expect(result[0]).toBe('\u2581'); // lowest block
    expect(result[7]).toBe('\u2588'); // full block
  });

  it('handles empty array', () => {
    expect(sparkline([])).toBe('');
  });

  it('handles all zeros', () => {
    const result = sparkline([0, 0, 0]);
    expect(result).toHaveLength(3);
  });
});

describe('barChart', () => {
  it('renders labeled bars', () => {
    const data = [
      { label: '12:00', count: 5 },
      { label: '12:10', count: 10 },
      { label: '12:20', count: 3 },
    ];
    const lines = barChart(data, 20);
    expect(lines.length).toBe(3);
    // Highest bar (10) should have the longest bar
    expect(lines[1].length).toBeGreaterThan(lines[2].length);
  });
});
```

**Step 2: Run test to verify it fails**

Run: `npx vitest run src/dashboard/charts.test.ts`
Expected: FAIL

**Step 3: Write implementation**

Create `src/dashboard/charts.ts`:

```typescript
const BLOCKS = ['\u2581', '\u2582', '\u2583', '\u2584', '\u2585', '\u2586', '\u2587', '\u2588'];

export function sparkline(values: number[]): string {
  if (values.length === 0) return '';

  const max = Math.max(...values);
  if (max === 0) return BLOCKS[0].repeat(values.length);

  return values
    .map((v) => {
      const idx = Math.min(Math.floor((v / max) * (BLOCKS.length - 1)), BLOCKS.length - 1);
      return BLOCKS[idx];
    })
    .join('');
}

export function barChart(
  data: Array<{ label: string; count: number }>,
  maxWidth: number,
): string[] {
  const max = Math.max(...data.map((d) => d.count), 1);

  return data.map((d) => {
    const barLen = Math.round((d.count / max) * maxWidth);
    const bar = '\u2588'.repeat(barLen);
    return `${d.label} ${bar} ${d.count}`;
  });
}
```

**Step 4: Run test to verify it passes**

Run: `npx vitest run src/dashboard/charts.test.ts`
Expected: PASS

**Step 5: Commit**

```bash
git add src/dashboard/charts.ts src/dashboard/charts.test.ts
git commit -m "feat(dashboard): add ASCII sparkline and bar charts"
```

---

### Task 5: Terminal Layout Engine

**Files:**
- Create: `src/dashboard/layout.ts`
- Test: `src/dashboard/layout.test.ts`

**Step 1: Write the failing test**

Create `src/dashboard/layout.test.ts`:

```typescript
import { describe, it, expect } from 'vitest';

import { box, padRight, colorize, Color } from './layout.js';

describe('box', () => {
  it('wraps content in box-drawing chars', () => {
    const result = box('Title', ['Line 1', 'Line 2'], 30);
    expect(result[0]).toContain('Title');
    expect(result[0]).toContain('\u2500'); // horizontal line
    expect(result.some((l) => l.includes('Line 1'))).toBe(true);
  });
});

describe('padRight', () => {
  it('pads string to width', () => {
    expect(padRight('hi', 5)).toBe('hi   ');
  });

  it('truncates if longer than width', () => {
    expect(padRight('hello world', 5)).toBe('hello');
  });
});

describe('colorize', () => {
  it('wraps text in ANSI codes', () => {
    const result = colorize('ok', Color.Green);
    expect(result).toContain('\x1b[');
    expect(result).toContain('ok');
    expect(result).toContain('\x1b[0m');
  });
});
```

**Step 2: Run test to verify it fails**

Run: `npx vitest run src/dashboard/layout.test.ts`
Expected: FAIL

**Step 3: Write implementation**

Create `src/dashboard/layout.ts`:

```typescript
export enum Color {
  Red = '31',
  Green = '32',
  Yellow = '33',
  Blue = '34',
  Cyan = '36',
  Gray = '90',
  White = '37',
  Bold = '1',
  Dim = '2',
}

export function colorize(text: string, ...codes: Color[]): string {
  const prefix = codes.map((c) => `\x1b[${c}m`).join('');
  return `${prefix}${text}\x1b[0m`;
}

export function padRight(text: string, width: number): string {
  if (text.length > width) return text.slice(0, width);
  return text + ' '.repeat(width - text.length);
}

// Strip ANSI codes to get visible length
function visibleLength(text: string): number {
  return text.replace(/\x1b\[[0-9;]*m/g, '').length;
}

export function box(title: string, lines: string[], width: number): string[] {
  const result: string[] = [];
  const innerWidth = width - 2;

  // Top border with title
  const titleStr = ` ${title} `;
  const remaining = innerWidth - titleStr.length;
  const left = Math.floor(remaining / 2);
  const right = remaining - left;
  result.push(
    '\u250c' +
      '\u2500'.repeat(left) +
      colorize(titleStr, Color.Bold) +
      '\u2500'.repeat(right) +
      '\u2510',
  );

  // Content lines
  for (const line of lines) {
    const vLen = visibleLength(line);
    const pad = Math.max(0, innerWidth - vLen);
    result.push('\u2502' + line + ' '.repeat(pad) + '\u2502');
  }

  // Bottom border
  result.push('\u2514' + '\u2500'.repeat(innerWidth) + '\u2518');

  return result;
}

export function sideBySide(
  leftLines: string[],
  rightLines: string[],
  leftWidth: number,
  rightWidth: number,
): string[] {
  const maxLen = Math.max(leftLines.length, rightLines.length);
  const result: string[] = [];

  for (let i = 0; i < maxLen; i++) {
    const left = i < leftLines.length ? leftLines[i] : '';
    const right = i < rightLines.length ? rightLines[i] : '';
    const lVis = visibleLength(left);
    const lPad = Math.max(0, leftWidth - lVis);
    result.push(left + ' '.repeat(lPad) + right);
  }

  return result;
}

// Clear screen and move cursor to top-left
export function clearScreen(): string {
  return '\x1b[2J\x1b[H';
}

// Hide/show cursor
export function hideCursor(): string {
  return '\x1b[?25l';
}

export function showCursor(): string {
  return '\x1b[?25h';
}
```

**Step 4: Run test to verify it passes**

Run: `npx vitest run src/dashboard/layout.test.ts`
Expected: PASS

**Step 5: Commit**

```bash
git add src/dashboard/layout.ts src/dashboard/layout.test.ts
git commit -m "feat(dashboard): add terminal layout engine with ANSI rendering"
```

---

### Task 6: Dashboard Entry Point

**Files:**
- Create: `src/dashboard.ts`
- Modify: `package.json` (add `dashboard` script)

**Step 1: Write the dashboard entry point**

Create `src/dashboard.ts`:

```typescript
import Database from 'better-sqlite3';
import fs from 'fs';
import path from 'path';

import { DATA_DIR, GROUPS_DIR, STORE_DIR } from './config.js';
import { sparkline } from './dashboard/charts.js';
import {
  computeLatencyStats,
  queryGroupActivity,
  queryMessageVolume,
  queryScheduledTasksSummary,
  queryTaskRunErrors,
  readStatusHeartbeat,
} from './dashboard/data.js';
import {
  box,
  clearScreen,
  Color,
  colorize,
  hideCursor,
  padRight,
  showCursor,
  sideBySide,
} from './dashboard/layout.js';
import { parseContainerLogs } from './dashboard/log-parser.js';

const WINDOWS: Record<string, { label: string; ms: number }> = {
  '1': { label: '1h', ms: 60 * 60 * 1000 },
  '6': { label: '6h', ms: 6 * 60 * 60 * 1000 },
  d: { label: '24h', ms: 24 * 60 * 60 * 1000 },
  w: { label: '7d', ms: 7 * 24 * 60 * 60 * 1000 },
};

let currentWindow = '1';
const REFRESH_MS = 5000;
const BUCKET_COUNT = 20;

function formatDuration(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`;
  if (ms < 3_600_000) return `${Math.floor(ms / 60_000)}m`;
  const h = Math.floor(ms / 3_600_000);
  const m = Math.floor((ms % 3_600_000) / 60_000);
  return m > 0 ? `${h}h ${m}m` : `${h}h`;
}

function formatAgo(timestamp: string): string {
  const ms = Date.now() - new Date(timestamp).getTime();
  if (ms < 60_000) return `${Math.floor(ms / 1000)}s ago`;
  if (ms < 3_600_000) return `${Math.floor(ms / 60_000)}m ago`;
  if (ms < 86_400_000) return `${Math.floor(ms / 3_600_000)}h ago`;
  return `${Math.floor(ms / 86_400_000)}d ago`;
}

function render(): string {
  const width = Math.min(process.stdout.columns || 100, 100);
  const halfWidth = Math.floor(width / 2);
  const win = WINDOWS[currentWindow];
  const lines: string[] = [];

  // Header
  const now = new Date().toLocaleString();
  const header = ` NanoClaw Dashboard \u2500\u2500 [${win.label}] \u2500\u2500 ${now} `;
  lines.push(colorize(header, Color.Bold, Color.Cyan));
  lines.push('');

  // ---- Status row ----
  const status = readStatusHeartbeat(DATA_DIR);

  const statusLines: string[] = [];
  if (!status || status.stale) {
    statusLines.push(colorize('\u25cf Down', Color.Red));
    if (status) statusLines.push(colorize(`Last seen: ${formatAgo(status.updatedAt)}`, Color.Gray));
  } else {
    const uptime = Date.now() - new Date(status.startedAt).getTime();
    statusLines.push(colorize('\u25cf Running', Color.Green));
    statusLines.push(`Uptime: ${formatDuration(uptime)}`);
    statusLines.push(`PID: ${status.pid}`);
  }

  const channelLines: string[] = [];
  if (status) {
    for (const ch of status.channels) {
      const dot = ch.connected
        ? colorize('\u25cf', Color.Green)
        : colorize('\u25cf', Color.Red);
      channelLines.push(`${dot} ${ch.name}`);
    }
  }
  if (channelLines.length === 0) {
    channelLines.push(colorize('No channels', Color.Gray));
  }

  // Open DB for queries
  const dbPath = path.join(STORE_DIR, 'messages.db');
  let db: Database.Database | null = null;
  try {
    if (fs.existsSync(dbPath)) {
      db = new Database(dbPath, { readonly: true });
    }
  } catch {
    // DB locked or missing
  }

  const groupLines: string[] = [];
  if (db) {
    const groups = queryGroupActivity(db, win.ms);
    for (const g of groups.slice(0, 5)) {
      groupLines.push(
        `${g.name} (${g.messageCount} msgs, ${formatAgo(g.lastMessage)})`,
      );
    }
  }
  if (groupLines.length === 0) groupLines.push(colorize('No activity', Color.Gray));

  // Arrange status row as 3 columns
  const col1 = ['STATUS', ...statusLines];
  const col2 = ['CHANNELS', ...channelLines];
  const col3 = ['GROUPS', ...groupLines];
  const colW = Math.floor(width / 3);
  const maxRows = Math.max(col1.length, col2.length, col3.length);
  for (let i = 0; i < maxRows; i++) {
    const c1 = i < col1.length ? (i === 0 ? colorize(col1[i], Color.Bold) : col1[i]) : '';
    const c2 = i < col2.length ? (i === 0 ? colorize(col2[i], Color.Bold) : col2[i]) : '';
    const c3 = i < col3.length ? (i === 0 ? colorize(col3[i], Color.Bold) : col3[i]) : '';
    lines.push(`  ${padRight(c1, colW)}${padRight(c2, colW)}${c3}`);
  }
  lines.push('');

  // ---- Message volume ----
  const volumeContent: string[] = [];
  if (db) {
    const buckets = queryMessageVolume(db, win.ms, BUCKET_COUNT);
    const values = buckets.map((b) => b.count);
    const total = values.reduce((a, b) => a + b, 0);
    volumeContent.push(`  ${sparkline(values)}  total: ${total}`);
    const first = buckets[0]?.label ?? '';
    const last = buckets[buckets.length - 1]?.label ?? '';
    volumeContent.push(colorize(`  ${first}${' '.repeat(Math.max(0, BUCKET_COUNT - first.length - last.length))}${last}`, Color.Gray));
  } else {
    volumeContent.push(colorize('  No database', Color.Gray));
  }

  // ---- Latency ----
  const latencyContent: string[] = [];
  const logEntries = parseContainerLogs(GROUPS_DIR, win.ms);
  const durations = logEntries
    .filter((e) => !e.timedOut && e.exitCode === 0)
    .map((e) => e.durationMs);
  const stats = computeLatencyStats(durations);

  if (stats.count > 0) {
    latencyContent.push(`  P50: ${formatDuration(stats.p50)}  P95: ${formatDuration(stats.p95)}`);
    latencyContent.push(`  avg: ${formatDuration(stats.avg)}  max: ${formatDuration(stats.max)}`);
    latencyContent.push(`  ${sparkline(durations.slice(-BUCKET_COUNT))}`);
  } else {
    latencyContent.push(colorize('  No data', Color.Gray));
  }

  const volBox = box(`MESSAGE VOLUME (${win.label})`, volumeContent, halfWidth);
  const latBox = box(`RESPONSE LATENCY (${win.label})`, latencyContent, halfWidth);
  lines.push(...sideBySide(volBox, latBox, halfWidth, halfWidth));

  // ---- Containers ----
  const containerContent: string[] = [];
  const total = logEntries.length;
  const successes = logEntries.filter((e) => e.exitCode === 0 && !e.timedOut).length;
  const errors = logEntries.filter((e) => e.exitCode !== 0 && !e.timedOut).length;
  const timeouts = logEntries.filter((e) => e.timedOut && !e.hadStreamingOutput).length;
  const idleCleanups = logEntries.filter((e) => e.timedOut && e.hadStreamingOutput).length;

  containerContent.push(`  Spawned: ${total}  Success: ${successes}`);
  containerContent.push(`  Errors: ${errors}  Timeouts: ${timeouts}  Idle cleanups: ${idleCleanups}`);
  if (stats.count > 0) {
    containerContent.push(`  Avg duration: ${formatDuration(stats.avg)}`);
  }

  // ---- Errors ----
  const errorContent: string[] = [];
  if (errors === 0) {
    const taskErrors = db ? queryTaskRunErrors(db, win.ms) : [];
    if (taskErrors.length === 0) {
      errorContent.push(colorize('  0 errors \u2713', Color.Green));
    } else {
      for (const e of taskErrors.slice(0, 3)) {
        errorContent.push(
          colorize(`  ${formatAgo(e.runAt)}: ${e.error.slice(0, 40)}`, Color.Red),
        );
      }
    }
  } else {
    const errEntries = logEntries.filter((e) => e.exitCode !== 0 && !e.timedOut);
    for (const e of errEntries.slice(0, 3)) {
      errorContent.push(
        colorize(
          `  ${formatAgo(e.timestamp)}: ${e.group} exit=${e.exitCode}`,
          Color.Red,
        ),
      );
    }
  }

  const contBox = box('CONTAINERS', containerContent, halfWidth);
  const errBox = box('ERRORS', errorContent, halfWidth);
  lines.push(...sideBySide(contBox, errBox, halfWidth, halfWidth));

  // ---- Scheduled tasks ----
  const taskContent: string[] = [];
  if (db) {
    const tasks = queryScheduledTasksSummary(db);
    taskContent.push(
      `  active: ${tasks.active}  paused: ${tasks.paused}  completed: ${tasks.completed}`,
    );
    if (tasks.nextRun) {
      const until = new Date(tasks.nextRun.next_run).getTime() - Date.now();
      const prompt =
        tasks.nextRun.prompt.length > 50
          ? tasks.nextRun.prompt.slice(0, 47) + '...'
          : tasks.nextRun.prompt;
      taskContent.push(`  Next: "${prompt}" in ${formatDuration(Math.max(0, until))}`);
    }
  } else {
    taskContent.push(colorize('  No database', Color.Gray));
  }

  const taskBox = box('SCHEDULED TASKS', taskContent, width);
  lines.push(...taskBox);

  // Footer
  lines.push('');
  lines.push(
    colorize(
      `  [1] 1h  [6] 6h  [d] 24h  [w] 7d  [q] quit  \u2022 refreshing every ${REFRESH_MS / 1000}s`,
      Color.Gray,
    ),
  );

  db?.close();

  return clearScreen() + lines.join('\n');
}

function main(): void {
  process.stdout.write(hideCursor());

  // Raw mode for key input
  if (process.stdin.isTTY) {
    process.stdin.setRawMode(true);
    process.stdin.resume();
    process.stdin.setEncoding('utf-8');

    process.stdin.on('data', (key: string) => {
      if (key === 'q' || key === '\x03') {
        // q or Ctrl+C
        process.stdout.write(showCursor());
        process.exit(0);
      }
      if (key in WINDOWS) {
        currentWindow = key;
        process.stdout.write(render());
      }
    });
  }

  // Cleanup on exit
  process.on('exit', () => {
    process.stdout.write(showCursor());
  });

  // Initial render + refresh loop
  process.stdout.write(render());
  setInterval(() => {
    process.stdout.write(render());
  }, REFRESH_MS);
}

main();
```

**Step 2: Add npm script**

Add to `package.json` scripts:

```json
"dashboard": "tsx src/dashboard.ts"
```

**Step 3: Run the dashboard manually to verify**

Run: `npm run dashboard`
Expected: A full-screen terminal dashboard appears. Press `q` to exit.

**Step 4: Commit**

```bash
git add src/dashboard.ts package.json
git commit -m "feat: add terminal observability dashboard"
```

---

### Task 7: Integration Test & Polish

**Files:**
- Modify: `src/dashboard.ts` (fix any rendering issues found during manual testing)
- Modify: `package.json` (verify script works)

**Step 1: Run all tests**

Run: `npx vitest run`
Expected: All tests PASS

**Step 2: Run dashboard against live NanoClaw data**

Run: `npm run dashboard`

Verify:
- Status shows Running/Down correctly
- Channel indicators match running channels
- Message volume sparkline shows data
- Container latency stats populated from log files
- Time window switching works (press `1`, `6`, `d`, `w`)
- `q` exits cleanly

**Step 3: Fix any issues found**

Address rendering bugs, column alignment, or data parsing issues.

**Step 4: Run typecheck**

Run: `npx tsc --noEmit`
Expected: No errors

**Step 5: Final commit**

```bash
git add -A
git commit -m "feat(dashboard): polish and integration test"
```

---

Plan saved. Two execution options:

**1. Subagent-Driven (this session)** — I dispatch a fresh subagent per task, review between tasks, fast iteration

**2. Parallel Session (separate)** — Open a new session with executing-plans, batch execution with checkpoints

Which approach?