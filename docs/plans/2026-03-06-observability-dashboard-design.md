# Observability Dashboard Design

## Goal

A terminal-based (TUI) dashboard for quick visual health checks of a running NanoClaw instance. Separate CLI tool that reads existing data sources. Personal use — avoids needing to open Claude Code for routine status checks.

## Data Sources

| Metric | Source | Method |
|--------|--------|--------|
| Process status & uptime | `data/status.json` heartbeat | Read file, check staleness |
| Channel connection status | `data/status.json` heartbeat | Live connected state per channel |
| Message volume | SQLite `messages` table | `COUNT(*) GROUP BY time_bucket` |
| Last activity per group | SQLite `messages` table | `MAX(timestamp) WHERE chat_jid = ?` |
| Response latency | Container log files | Parse `Duration: Xms` from `groups/*/logs/container-*.log` |
| Container success/error | Container log files | Parse `Exit Code:` lines |
| Container timeouts | Container log files | `(TIMEOUT)` marker in log header |
| Scheduled tasks | SQLite `scheduled_tasks` + `task_run_logs` | Direct queries |
| Error details | Container log files + `task_run_logs` | Aggregate from both |

## Layout

```
+-- NanoClaw Dashboard ---------------------- [1h v] -- 2026-03-06 14:32 --+
|                                                                           |
|  STATUS          CHANNELS           GROUPS                                |
|  * Running       * whatsapp         main (12 msgs, last 3m ago)           |
|  Uptime: 4d 2h   * feishu           family (5 msgs, last 1h ago)         |
|  PID: 42318                         work (2 msgs, last 6h ago)           |
|                                                                           |
+------ MESSAGE VOLUME --------------------+-- RESPONSE LATENCY -----------+
|  (last 1h)                               |  P50: 4.2s  P95: 12.1s       |
|  ####==##==#====####==##==#====           |  avg: 5.8s  max: 18.3s       |
|  12:00        12:30        13:00          |  (sparkline chart)            |
|                                           |                               |
+------ CONTAINERS ------------------------+-- ERRORS --------------------+
|  Spawned: 15  Success: 14                |  0 errors                     |
|  Errors:   1  Timeouts: 0                |                               |
|  Avg duration: 5.8s                      |  (or: list of recent errors)  |
|                                           |                               |
+------ SCHEDULED TASKS ---------------------------------------------------+
|  active: 3  completed: 12  failed: 1                                     |
|  Next run: "daily-briefing" in 2h                                         |
+--------------------------------------------------------------------------+
```

### Interactions

- Time window: `1` = 1h, `6` = 6h, `d` = 24h, `w` = 7d
- `q` to quit
- Auto-refresh every 5 seconds

## Architecture

### Files

```
src/dashboard.ts              Entry point, TUI rendering, refresh loop
src/dashboard/
  data.ts                     Reads SQLite, parses container logs, reads status.json
  layout.ts                   Terminal layout engine (panels, box drawing)
  charts.ts                   ASCII sparkline/bar charts for volume & latency
```

### Core Change (minimal)

Add a status heartbeat to `src/index.ts`: a `writeStatusHeartbeat()` function called on a 10-second interval after channels connect, writing to `data/status.json`:

```json
{
  "pid": 42318,
  "startedAt": "2026-03-06T10:00:00Z",
  "channels": [
    { "name": "whatsapp", "connected": true, "connectedSince": "2026-03-06T10:00:05Z" },
    { "name": "feishu", "connected": true, "connectedSince": "2026-03-06T10:00:03Z" }
  ],
  "updatedAt": "2026-03-06T14:32:10Z"
}
```

### TUI Rendering

Raw ANSI escape codes — no TUI library dependency. The dashboard is simple enough (colored text, box-drawing characters, sparklines) that a library would be overkill. Aligns with NanoClaw's minimal-dependency philosophy.

### npm script

```json
"dashboard": "tsx src/dashboard.ts"
```

Run with `npm run dashboard`.

### Container Log Parsing

Container log files in `groups/*/logs/container-*.log` have structured headers:

```
=== Container Run Log ===
Timestamp: 2026-03-06T14:00:00.000Z
Group: main
Duration: 5823ms
Exit Code: 0
```

Parse these for latency distribution and error rates. File timestamps in the filename (`container-YYYY-MM-DDTHH-MM-SS-SSSZ.log`) enable time-window filtering without reading every file.

### SQLite Access

Read-only connection to `store/messages.db`. NanoClaw uses synchronous `better-sqlite3`, so concurrent reads from the dashboard are safe (SQLite supports multiple readers).

## Design Decisions

- **No new dependencies**: Raw ANSI rendering, reuse existing `better-sqlite3` for reads
- **Zero runtime coupling**: Dashboard can run while NanoClaw is stopped (shows last known state)
- **Heartbeat staleness**: If `status.json` is older than 30 seconds, mark process as "Down"
- **Log file time filtering**: Use filename timestamps to skip files outside the selected window
- **Percentile calculation**: Sort durations, pick P50/P95 indices. Good enough for personal use.

## Out of Scope

- Alerting or notifications
- Remote access (network-exposed server)
- Persistent metrics storage beyond what SQLite + logs already provide
- Historical data beyond what log files retain
