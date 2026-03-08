import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { parseContainerLogs } from './log-parser.js';

let tmpDir: string;

function makeGroupLogDir(groupFolder: string): string {
  const logDir = path.join(tmpDir, groupFolder, 'logs');
  fs.mkdirSync(logDir, { recursive: true });
  return logDir;
}

function writeLog(groupFolder: string, filename: string, content: string) {
  const logDir = makeGroupLogDir(groupFolder);
  fs.writeFileSync(path.join(logDir, filename), content);
}

describe('parseContainerLogs', () => {
  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'log-parser-test-'));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('parses a successful container log', () => {
    writeLog(
      'main',
      'container-2026-03-06T07-22-33-998Z.log',
      [
        '=== Container Run Log ===',
        'Timestamp: 2026-03-06T07:22:33.998Z',
        'Group: Main',
        'IsMain: false',
        'Duration: 3557139ms',
        'Exit Code: 0',
        'Stdout Truncated: false',
        'Stderr Truncated: false',
      ].join('\n'),
    );

    const entries = parseContainerLogs(tmpDir);
    expect(entries).toHaveLength(1);
    expect(entries[0]).toEqual({
      timestamp: '2026-03-06T07:22:33.998Z',
      group: 'Main',
      durationMs: 3557139,
      exitCode: 0,
      timedOut: false,
      hadStreamingOutput: false,
    });
  });

  it('parses a timeout log and detects TIMEOUT in first line', () => {
    writeLog(
      'feishu-main',
      'container-2026-03-06T01-07-59-651Z.log',
      [
        '=== Container Run Log (TIMEOUT) ===',
        'Timestamp: 2026-03-06T01:07:59.651Z',
        'Group: Feishu Main',
        'Container: nanoclaw-feishu-main-1772756555264',
        'Duration: 2724390ms',
        'Exit Code: 137',
        'Had Streaming Output: true',
      ].join('\n'),
    );

    const entries = parseContainerLogs(tmpDir);
    expect(entries).toHaveLength(1);
    expect(entries[0]).toEqual({
      timestamp: '2026-03-06T01:07:59.651Z',
      group: 'Feishu Main',
      durationMs: 2724390,
      exitCode: 137,
      timedOut: true,
      hadStreamingOutput: true,
    });
  });

  it('filters by time window (old logs excluded, recent logs included)', () => {
    // "Old" log: filename timestamp far in the past
    writeLog(
      'main',
      'container-2020-01-01T00-00-00-000Z.log',
      [
        '=== Container Run Log ===',
        'Timestamp: 2020-01-01T00:00:00.000Z',
        'Group: Main',
        'Duration: 1000ms',
        'Exit Code: 0',
      ].join('\n'),
    );

    // "Recent" log: filename timestamp = now
    const now = new Date();
    const fname =
      'container-' + now.toISOString().replace(/[:.]/g, '-') + '.log';
    writeLog(
      'main',
      fname,
      [
        '=== Container Run Log ===',
        `Timestamp: ${now.toISOString()}`,
        'Group: Main',
        'Duration: 2000ms',
        'Exit Code: 0',
      ].join('\n'),
    );

    // Window of 1 hour — should only include the recent log
    const entries = parseContainerLogs(tmpDir, 60 * 60 * 1000);
    expect(entries).toHaveLength(1);
    expect(entries[0].durationMs).toBe(2000);
  });

  it('returns empty array when no logs exist', () => {
    // tmpDir exists but has no group subdirectories
    const entries = parseContainerLogs(tmpDir);
    expect(entries).toEqual([]);
  });

  it('returns entries sorted by timestamp', () => {
    writeLog(
      'main',
      'container-2026-03-06T10-00-00-000Z.log',
      [
        '=== Container Run Log ===',
        'Timestamp: 2026-03-06T10:00:00.000Z',
        'Group: Main',
        'Duration: 1000ms',
        'Exit Code: 0',
      ].join('\n'),
    );

    writeLog(
      'main',
      'container-2026-03-06T08-00-00-000Z.log',
      [
        '=== Container Run Log ===',
        'Timestamp: 2026-03-06T08:00:00.000Z',
        'Group: Main',
        'Duration: 2000ms',
        'Exit Code: 0',
      ].join('\n'),
    );

    writeLog(
      'other',
      'container-2026-03-06T09-00-00-000Z.log',
      [
        '=== Container Run Log ===',
        'Timestamp: 2026-03-06T09:00:00.000Z',
        'Group: Other',
        'Duration: 3000ms',
        'Exit Code: 0',
      ].join('\n'),
    );

    const entries = parseContainerLogs(tmpDir);
    expect(entries).toHaveLength(3);
    expect(entries[0].timestamp).toBe('2026-03-06T08:00:00.000Z');
    expect(entries[1].timestamp).toBe('2026-03-06T09:00:00.000Z');
    expect(entries[2].timestamp).toBe('2026-03-06T10:00:00.000Z');
  });
});
