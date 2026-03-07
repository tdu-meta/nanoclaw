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
  const status: StatusHeartbeat = {
    pid: process.pid,
    startedAt,
    channels,
    updatedAt: new Date().toISOString(),
  };

  const filePath = path.join(dataDir, 'status.json');
  const tmpPath = filePath + '.tmp';

  fs.mkdirSync(dataDir, { recursive: true });
  fs.writeFileSync(tmpPath, JSON.stringify(status, null, 2));
  fs.renameSync(tmpPath, filePath);
}
