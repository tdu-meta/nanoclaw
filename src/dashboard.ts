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

// ---------------------------------------------------------------------------
// Time windows
// ---------------------------------------------------------------------------

const WINDOWS = {
  '1': { label: '1h', ms: 60 * 60 * 1000 },
  '6': { label: '6h', ms: 6 * 60 * 60 * 1000 },
  d: { label: '24h', ms: 24 * 60 * 60 * 1000 },
  w: { label: '7d', ms: 7 * 24 * 60 * 60 * 1000 },
};

type WindowKey = keyof typeof WINDOWS;

let currentWindow: WindowKey = '1';

// ---------------------------------------------------------------------------
// Helper functions
// ---------------------------------------------------------------------------

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

// ---------------------------------------------------------------------------
// Render
// ---------------------------------------------------------------------------

function render(): string {
  const width = Math.min(process.stdout.columns || 100, 100);
  const halfWidth = Math.floor(width / 2);
  const win = WINDOWS[currentWindow];

  const now = new Date();
  const timeStr = now.toLocaleString([], {
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  });

  // Open DB (read-only, may not exist)
  const dbPath = path.join(STORE_DIR, 'messages.db');
  let db: Database.Database | null = null;
  if (fs.existsSync(dbPath)) {
    try {
      db = new Database(dbPath, { readonly: true });
    } catch {
      db = null;
    }
  }

  // --- Status heartbeat ---
  const status = readStatusHeartbeat(DATA_DIR);

  // --- Group activity ---
  const groups = db ? queryGroupActivity(db, win.ms) : [];

  // --- Message volume ---
  const BUCKET_COUNT = 20;
  const buckets = db ? queryMessageVolume(db, win.ms, BUCKET_COUNT) : [];
  const totalMessages = buckets.reduce((s, b) => s + b.count, 0);

  // --- Container logs & latency ---
  const logEntries = parseContainerLogs(GROUPS_DIR, win.ms);
  const successEntries = logEntries.filter(
    (e) => !e.timedOut && e.exitCode === 0,
  );
  const latencyStats = computeLatencyStats(successEntries.map((e) => e.durationMs));

  // Container counts
  const totalContainers = logEntries.length;
  const errorEntries = logEntries.filter((e) => e.exitCode !== 0 && !e.timedOut);
  const timeoutEntries = logEntries.filter((e) => e.timedOut && !e.hadStreamingOutput);
  const idleCleanupEntries = logEntries.filter((e) => e.timedOut && e.hadStreamingOutput);

  // --- Errors ---
  const taskErrors = db ? queryTaskRunErrors(db, win.ms) : [];

  // --- Scheduled tasks ---
  const taskSummary = db ? queryScheduledTasksSummary(db) : null;

  // Close DB
  if (db) {
    db.close();
  }

  // ---- Build output ----
  const lines: string[] = [];

  // Header
  const headerTitle = `NanoClaw Dashboard`;
  const windowLabel = colorize(`[${win.label}]`, Color.Cyan);
  const timeLabel = colorize(timeStr, Color.Gray);
  const headerInner = ` ${colorize(headerTitle, Color.Bold)}  ${windowLabel}  ${timeLabel} `;
  const headerInnerVisible = ` ${headerTitle}  [${win.label}]  ${timeStr} `;
  const topFill = Math.max(0, width - 2 - headerInnerVisible.length);
  lines.push(
    '\u250c' + headerInner + '\u2500'.repeat(topFill) + '\u2510',
  );

  // --- STATUS / CHANNELS / GROUPS row ---
  const statusLines: string[] = [];
  const channelLines: string[] = [];
  const groupLines: string[] = [];

  // STATUS column
  statusLines.push(colorize('  STATUS', Color.Bold));
  if (!status) {
    statusLines.push(`  ${colorize('●', Color.Red)} Down`);
    statusLines.push('  No heartbeat');
  } else if (status.stale) {
    statusLines.push(`  ${colorize('●', Color.Yellow)} Stale`);
    statusLines.push(`  PID: ${status.pid}`);
    statusLines.push(`  Last seen: ${formatAgo(status.updatedAt)}`);
  } else {
    const uptime = Date.now() - new Date(status.startedAt).getTime();
    statusLines.push(`  ${colorize('●', Color.Green)} Running`);
    statusLines.push(`  PID: ${status.pid}`);
    statusLines.push(`  Up: ${formatDuration(uptime)}`);
  }

  // CHANNELS column
  channelLines.push(colorize('  CHANNELS', Color.Bold));
  if (!status || status.channels.length === 0) {
    channelLines.push(colorize('  (none)', Color.Gray));
  } else {
    for (const ch of status.channels) {
      const dot = ch.connected
        ? colorize('●', Color.Green)
        : colorize('●', Color.Red);
      channelLines.push(`  ${dot} ${ch.name}`);
    }
  }

  // GROUPS column
  groupLines.push(colorize('  GROUPS', Color.Bold));
  if (groups.length === 0) {
    groupLines.push(colorize('  (no activity)', Color.Gray));
  } else {
    for (const g of groups.slice(0, 5)) {
      const ago = formatAgo(g.lastMessage);
      groupLines.push(`  ${g.name} (${g.messageCount} msgs, ${ago})`);
    }
  }

  // Combine status/channels/groups as a 3-column layout inside the box
  const colWidth = Math.floor(width / 3);
  const maxStatusRows = Math.max(statusLines.length, channelLines.length, groupLines.length);
  for (let i = 0; i < maxStatusRows; i++) {
    const s = padRight(statusLines[i] ?? '', colWidth);
    const c = padRight(channelLines[i] ?? '', colWidth);
    const g = padRight(groupLines[i] ?? '', width - 2 * colWidth - 2);
    lines.push('\u2502' + s + c + g + '\u2502');
  }

  // Divider
  lines.push('\u251c' + '\u2500'.repeat(width - 2) + '\u2524');

  // --- MESSAGE VOLUME | LATENCY ---
  const volumeContent: string[] = [];
  if (buckets.length === 0 || totalMessages === 0) {
    volumeContent.push('  ' + colorize('No messages', Color.Gray));
  } else {
    const spark = sparkline(buckets.map((b) => b.count));
    volumeContent.push('  ' + spark);
    volumeContent.push('  ' + colorize(`Total: ${totalMessages}`, Color.Cyan));
  }

  const latencyContent: string[] = [];
  if (latencyStats.count === 0) {
    latencyContent.push('  ' + colorize('No data', Color.Gray));
  } else {
    latencyContent.push(`  P50: ${formatDuration(latencyStats.p50)}`);
    latencyContent.push(`  P95: ${formatDuration(latencyStats.p95)}`);
    latencyContent.push(`  Avg: ${formatDuration(latencyStats.avg)}`);
    latencyContent.push(`  Max: ${formatDuration(latencyStats.max)}`);
    latencyContent.push(colorize(`  n=${latencyStats.count}`, Color.Gray));
  }

  const volumeBox = box(`MESSAGE VOLUME (${win.label})`, volumeContent, halfWidth);
  const latencyBox = box(`RESPONSE LATENCY (${win.label})`, latencyContent, halfWidth);
  for (const row of sideBySide(volumeBox, latencyBox, halfWidth, halfWidth)) {
    lines.push(row);
  }

  // Divider
  lines.push('\u251c' + '\u2500'.repeat(width - 2) + '\u2524');

  // --- CONTAINERS | ERRORS ---
  const containerContent: string[] = [
    `  Total runs:     ${totalContainers}`,
    `  Success:        ${successEntries.length}`,
    `  Errors:         ${colorize(String(errorEntries.length), errorEntries.length > 0 ? Color.Red : Color.Green)}`,
    `  Timeouts:       ${colorize(String(timeoutEntries.length), timeoutEntries.length > 0 ? Color.Yellow : Color.Green)}`,
    `  Idle cleanups:  ${idleCleanupEntries.length}`,
  ];

  const errorContent: string[] = [];
  if (taskErrors.length === 0) {
    errorContent.push(`  ${colorize('0 errors ✓', Color.Green)}`);
  } else {
    for (const e of taskErrors.slice(0, 5)) {
      const ago = formatAgo(e.runAt);
      errorContent.push(`  ${colorize('✗', Color.Red)} [${ago}] ${e.error.slice(0, 30)}`);
    }
    if (taskErrors.length > 5) {
      errorContent.push(colorize(`  ...and ${taskErrors.length - 5} more`, Color.Gray));
    }
  }

  const containerBox = box('CONTAINERS', containerContent, halfWidth);
  const errorsBox = box('ERRORS', errorContent, halfWidth);
  for (const row of sideBySide(containerBox, errorsBox, halfWidth, halfWidth)) {
    lines.push(row);
  }

  // Divider
  lines.push('\u251c' + '\u2500'.repeat(width - 2) + '\u2524');

  // --- SCHEDULED TASKS ---
  const taskContent: string[] = [];
  if (!taskSummary) {
    taskContent.push(colorize('  No database', Color.Gray));
  } else {
    taskContent.push(
      `  Active: ${colorize(String(taskSummary.active), Color.Green)}  ` +
        `Paused: ${taskSummary.paused}  ` +
        `Completed: ${taskSummary.completed}`,
    );
    if (taskSummary.nextRun) {
      const nextAgo = new Date(taskSummary.nextRun.next_run).toLocaleString([], {
        month: '2-digit',
        day: '2-digit',
        hour: '2-digit',
        minute: '2-digit',
      });
      const prompt = taskSummary.nextRun.prompt.slice(0, 50);
      taskContent.push(`  Next: ${nextAgo}  "${prompt}"`);
    } else {
      taskContent.push(colorize('  No upcoming tasks', Color.Gray));
    }
  }

  const taskBox = box('SCHEDULED TASKS', taskContent, width);
  for (const row of taskBox) {
    lines.push(row);
  }

  // Footer with key hints
  const footerHints = colorize(
    ' [1] 1h  [6] 6h  [d] 24h  [w] 7d  [q] quit ',
    Color.Gray,
  );
  const footerFill = Math.max(0, width - 2 - ' [1] 1h  [6] 6h  [d] 24h  [w] 7d  [q] quit '.length);
  lines.push('\u2514' + footerHints + ' '.repeat(footerFill) + '\u2518');

  return clearScreen() + hideCursor() + lines.join('\n') + '\n';
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

function main(): void {
  process.stdout.write(hideCursor());

  const cleanup = (): void => {
    process.stdout.write(showCursor());
    process.exit(0);
  };

  process.on('SIGINT', cleanup);
  process.on('SIGTERM', cleanup);

  // Raw mode for keypress detection
  if (process.stdin.isTTY) {
    process.stdin.setRawMode(true);
  }
  process.stdin.resume();
  process.stdin.setEncoding('utf8');

  process.stdin.on('data', (key: string) => {
    if (key === 'q' || key === '\u0003') {
      // q or Ctrl+C
      cleanup();
    } else if (key in WINDOWS) {
      currentWindow = key as WindowKey;
      process.stdout.write(render());
    }
  });

  // Initial render
  process.stdout.write(render());

  // Refresh every 5 seconds
  setInterval(() => {
    process.stdout.write(render());
  }, 5000);
}

main();
