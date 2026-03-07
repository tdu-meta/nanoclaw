import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';

import { writeStatusHeartbeat } from './status-heartbeat.js';

let tmpDir: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'heartbeat-test-'));
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe('writeStatusHeartbeat', () => {
  it('writes status.json with channel info', () => {
    const channels = [
      { name: 'whatsapp', connected: true },
      { name: 'feishu', connected: false },
    ];

    writeStatusHeartbeat(tmpDir, channels);

    const raw = fs.readFileSync(path.join(tmpDir, 'status.json'), 'utf-8');
    const status = JSON.parse(raw);

    expect(status.pid).toBe(process.pid);
    expect(status.channels).toEqual([
      { name: 'whatsapp', connected: true },
      { name: 'feishu', connected: false },
    ]);
    expect(status.startedAt).toBeTruthy();
    expect(status.updatedAt).toBeTruthy();
    // startedAt and updatedAt should be valid ISO dates
    expect(new Date(status.startedAt).toISOString()).toBe(status.startedAt);
    expect(new Date(status.updatedAt).toISOString()).toBe(status.updatedAt);
  });

  it('uses atomic write (temp file + rename)', () => {
    const renameSpy = vi.spyOn(fs, 'renameSync');
    const writeSpy = vi.spyOn(fs, 'writeFileSync');

    const channels = [{ name: 'whatsapp', connected: true }];
    writeStatusHeartbeat(tmpDir, channels);

    // Should have written to a .tmp file first
    const tmpWriteCall = writeSpy.mock.calls.find((call) =>
      String(call[0]).endsWith('.tmp'),
    );
    expect(tmpWriteCall).toBeTruthy();

    // Should have renamed .tmp to status.json
    const renameCall = renameSpy.mock.calls.find(
      (call) =>
        String(call[0]).endsWith('.tmp') &&
        String(call[1]).endsWith('status.json'),
    );
    expect(renameCall).toBeTruthy();

    renameSpy.mockRestore();
    writeSpy.mockRestore();
  });

  it('keeps startedAt constant across multiple writes', () => {
    const channels = [{ name: 'whatsapp', connected: true }];

    writeStatusHeartbeat(tmpDir, channels);
    const first = JSON.parse(
      fs.readFileSync(path.join(tmpDir, 'status.json'), 'utf-8'),
    );

    // Small delay to ensure updatedAt differs
    writeStatusHeartbeat(tmpDir, channels);
    const second = JSON.parse(
      fs.readFileSync(path.join(tmpDir, 'status.json'), 'utf-8'),
    );

    expect(first.startedAt).toBe(second.startedAt);
  });
});
