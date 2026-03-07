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
 * Convert a log filename timestamp back to a Date.
 * Filename format: container-YYYY-MM-DDTHH-MM-SS-SSSZ.log
 * We need to restore colons and the dot: 2026-03-06T07-22-33-998Z → 2026-03-06T07:22:33.998Z
 */
function filenameToDate(filename: string): Date | null {
  // Extract the timestamp portion: everything between "container-" and ".log"
  const match = filename.match(
    /^container-(\d{4}-\d{2}-\d{2}T\d{2})-(\d{2})-(\d{2})-(\d{3})Z\.log$/,
  );
  if (!match) return null;
  // Reconstruct: YYYY-MM-DDTHH:MM:SS.mmmZ
  const iso = `${match[1]}:${match[2]}:${match[3]}.${match[4]}Z`;
  const d = new Date(iso);
  return isNaN(d.getTime()) ? null : d;
}

function parseLogContent(content: string): Omit<ContainerLogEntry, 'group'> & { group: string } | null {
  const lines = content.split('\n');
  if (lines.length === 0) return null;

  const firstLine = lines[0];
  const timedOut = firstLine.includes('(TIMEOUT)');

  const headers = new Map<string, string>();
  for (const line of lines) {
    const colonIdx = line.indexOf(': ');
    if (colonIdx === -1) continue;
    const key = line.slice(0, colonIdx).trim();
    const value = line.slice(colonIdx + 2).trim();
    headers.set(key, value);
  }

  const timestamp = headers.get('Timestamp');
  const group = headers.get('Group');
  const durationRaw = headers.get('Duration');

  if (!timestamp || !group || !durationRaw) return null;

  const durationMs = parseInt(durationRaw.replace('ms', ''), 10);
  const exitCode = parseInt(headers.get('Exit Code') ?? '0', 10);
  const hadStreamingOutput = headers.get('Had Streaming Output') === 'true';

  return {
    timestamp,
    group,
    durationMs,
    exitCode,
    timedOut,
    hadStreamingOutput,
  };
}

/**
 * Scan groupsDir for container log files and parse them into structured entries.
 * @param groupsDir - Path to the groups directory (e.g., "groups/")
 * @param windowMs - Optional time window in ms; only include logs newer than Date.now() - windowMs
 */
export function parseContainerLogs(
  groupsDir: string,
  windowMs?: number,
): ContainerLogEntry[] {
  const entries: ContainerLogEntry[] = [];

  let groupFolders: string[];
  try {
    groupFolders = fs.readdirSync(groupsDir, { withFileTypes: true })
      .filter((d) => d.isDirectory())
      .map((d) => d.name);
  } catch {
    return [];
  }

  const cutoff = windowMs != null ? Date.now() - windowMs : null;

  for (const folder of groupFolders) {
    const logDir = path.join(groupsDir, folder, 'logs');
    let logFiles: string[];
    try {
      logFiles = fs.readdirSync(logDir).filter((f) => f.startsWith('container-') && f.endsWith('.log'));
    } catch {
      continue;
    }

    for (const file of logFiles) {
      // Time window filtering based on filename timestamp
      if (cutoff != null) {
        const fileDate = filenameToDate(file);
        if (fileDate && fileDate.getTime() < cutoff) continue;
      }

      const content = fs.readFileSync(path.join(logDir, file), 'utf-8');
      const entry = parseLogContent(content);
      if (entry) {
        entries.push(entry);
      }
    }
  }

  entries.sort((a, b) => a.timestamp.localeCompare(b.timestamp));
  return entries;
}
