# Feishu Channel Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Add Feishu as a full messaging channel to NanoClaw with WebSocket transport, text/image/file support, and no @mention requirement.

**Architecture:** Feishu messages arrive via WebSocket (Long Connection Mode), are routed through NanoClaw to Claude Agent SDK containers, and responses are sent back to Feishu. Uses skill-based installation pattern (like add-telegram, add-slack).

**Tech Stack:** TypeScript, `@larksuiteoapi/node-sdk`, vitest for testing

---

## Task 1: Create Skill Manifest

**Files:**
- Create: `.claude/skills/add-feishu/manifest.yaml`

**Step 1: Create the manifest file**

```yaml
skill: feishu
version: 1.0.0
description: "Feishu/Lark messaging integration via WebSocket"
core_version: 0.1.0
adds:
  - src/channels/feishu.ts
  - src/channels/feishu.test.ts
modifies:
  - src/index.ts
  - src/config.ts
  - src/routing.test.ts
structured:
  npm_dependencies:
    "@larksuiteoapi/node-sdk": "^1.33.0"
  env_additions:
    - FEISHU_APP_ID
    - FEISHU_APP_SECRET
    - FEISHU_ONLY
conflicts: []
depends: []
test: "npx vitest run src/channels/feishu.test.ts"
```

**Step 2: Commit**

```bash
git add .claude/skills/add-feishu/manifest.yaml
git commit -m "feat(feishu): add skill manifest"
```

---

## Task 2: Create Feishu Channel - Core Structure

**Files:**
- Create: `.claude/skills/add-feishu/add/src/channels/feishu.ts`

**Step 1: Write the failing test for channel interface**

Create `.claude/skills/add-feishu/add/src/channels/feishu.test.ts`:

```typescript
import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';

// --- Mocks ---

vi.mock('../config.js', () => ({
  ASSISTANT_NAME: 'Andy',
  TRIGGER_PATTERN: /^@Andy\b/i,
}));

vi.mock('../logger.js', () => ({
  logger: {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
}));

// Mock Feishu SDK
const mockWsClient = {
  start: vi.fn().mockResolvedValue(undefined),
  stop: vi.fn(),
};

const mockClient = {
  im: {
    message: {
      create: vi.fn().mockResolvedValue({ data: { message_id: 'msg_123' } }),
    },
    file: {
      create: vi.fn().mockResolvedValue({ data: { file_key: 'file_123' } }),
    },
    image: {
      create: vi.fn().mockResolvedValue({ data: { image_key: 'img_123' } }),
    },
  },
};

vi.mock('@larksuiteoapi/node-sdk', () => ({
  Client: vi.fn(() => mockClient),
  WSClient: vi.fn(() => mockWsClient),
}));

import { FeishuChannel, FeishuChannelOpts } from './feishu.js';

// --- Test helpers ---

function createTestOpts(overrides?: Partial<FeishuChannelOpts>): FeishuChannelOpts {
  return {
    onMessage: vi.fn(),
    onChatMetadata: vi.fn(),
    registeredGroups: vi.fn(() => ({
      'feishu:oc_123456': {
        name: 'Test Group',
        folder: 'test-group',
        trigger: '@Andy',
        added_at: '2024-01-01T00:00:00.000Z',
      },
    })),
    ...overrides,
  };
}

// --- Tests ---

describe('FeishuChannel', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe('channel properties', () => {
    it('has name "feishu"', () => {
      const channel = new FeishuChannel('app_id', 'app_secret', createTestOpts());
      expect(channel.name).toBe('feishu');
    });
  });

  describe('ownsJid', () => {
    it('owns feishu: JIDs', () => {
      const channel = new FeishuChannel('app_id', 'app_secret', createTestOpts());
      expect(channel.ownsJid('feishu:oc_123456')).toBe(true);
    });

    it('does not own WhatsApp JIDs', () => {
      const channel = new FeishuChannel('app_id', 'app_secret', createTestOpts());
      expect(channel.ownsJid('12345@g.us')).toBe(false);
    });

    it('does not own Telegram JIDs', () => {
      const channel = new FeishuChannel('app_id', 'app_secret', createTestOpts());
      expect(channel.ownsJid('tg:123456')).toBe(false);
    });
  });

  describe('connection lifecycle', () => {
    it('isConnected() returns false before connect', () => {
      const opts = createTestOpts();
      const channel = new FeishuChannel('app_id', 'app_secret', opts);
      expect(channel.isConnected()).toBe(false);
    });

    it('resolves connect() when WebSocket starts', async () => {
      const opts = createTestOpts();
      const channel = new FeishuChannel('app_id', 'app_secret', opts);

      await channel.connect();

      expect(channel.isConnected()).toBe(true);
      expect(mockWsClient.start).toHaveBeenCalled();
    });

    it('disconnects cleanly', async () => {
      const opts = createTestOpts();
      const channel = new FeishuChannel('app_id', 'app_secret', opts);

      await channel.connect();
      expect(channel.isConnected()).toBe(true);

      await channel.disconnect();
      expect(channel.isConnected()).toBe(false);
      expect(mockWsClient.stop).toHaveBeenCalled();
    });
  });
});
```

**Step 2: Run test to verify it fails**

Run: `npx vitest run .claude/skills/add-feishu/add/src/channels/feishu.test.ts`
Expected: FAIL with "Cannot find module './feishu.js'"

**Step 3: Write minimal implementation**

Create `.claude/skills/add-feishu/add/src/channels/feishu.ts`:

```typescript
import { Client, WSClient } from '@larksuiteoapi/node-sdk';

import { logger } from '../logger.js';
import {
  Channel,
  OnChatMetadata,
  OnInboundMessage,
  RegisteredGroup,
} from '../types.js';

export interface FeishuChannelOpts {
  onMessage: OnInboundMessage;
  onChatMetadata: OnChatMetadata;
  registeredGroups: () => Record<string, RegisteredGroup>;
}

export class FeishuChannel implements Channel {
  name = 'feishu';

  private client: Client | null = null;
  private wsClient: WSClient | null = null;
  private opts: FeishuChannelOpts;
  private appId: string;
  private appSecret: string;
  private connected = false;

  constructor(appId: string, appSecret: string, opts: FeishuChannelOpts) {
    this.appId = appId;
    this.appSecret = appSecret;
    this.opts = opts;
  }

  async connect(): Promise<void> {
    this.client = new Client({
      appId: this.appId,
      appSecret: this.appSecret,
    });

    this.wsClient = new WSClient({
      appId: this.appId,
      appSecret: this.appSecret,
    });

    await this.wsClient.start();
    this.connected = true;
    logger.info('Feishu WebSocket connected');
  }

  async sendMessage(jid: string, text: string): Promise<void> {
    if (!this.client) {
      logger.warn('Feishu client not initialized');
      return;
    }

    try {
      const chatId = jid.replace(/^feishu:/, '');
      await this.client.im.message.create({
        params: { receive_id_type: 'chat_id' },
        data: {
          receive_id: chatId,
          msg_type: 'text',
          content: JSON.stringify({ text }),
        },
      });
      logger.info({ jid, length: text.length }, 'Feishu message sent');
    } catch (err) {
      logger.error({ jid, err }, 'Failed to send Feishu message');
    }
  }

  isConnected(): boolean {
    return this.connected;
  }

  ownsJid(jid: string): boolean {
    return jid.startsWith('feishu:');
  }

  async disconnect(): Promise<void> {
    if (this.wsClient) {
      this.wsClient.stop();
      this.wsClient = null;
    }
    this.client = null;
    this.connected = false;
    logger.info('Feishu channel disconnected');
  }
}
```

**Step 4: Run test to verify it passes**

Run: `npx vitest run .claude/skills/add-feishu/add/src/channels/feishu.test.ts`
Expected: PASS

**Step 5: Commit**

```bash
git add .claude/skills/add-feishu/add/src/channels/feishu.ts .claude/skills/add-feishu/add/src/channels/feishu.test.ts
git commit -m "feat(feishu): add channel core structure with tests"
```

---

## Task 3: Add Message Handling

**Files:**
- Modify: `.claude/skills/add-feishu/add/src/channels/feishu.ts`
- Modify: `.claude/skills/add-feishu/add/src/channels/feishu.test.ts`

**Step 1: Write the failing test for message handling**

Add to `feishu.test.ts`:

```typescript
describe('message handling', () => {
  it('delivers text message for registered group', async () => {
    const opts = createTestOpts();
    const channel = new FeishuChannel('app_id', 'app_secret', opts);
    await channel.connect();

    // Simulate incoming message via the event handler
    channel._handleMessage({
      message: {
        chat_id: 'oc_123456',
        message_id: 'msg_001',
        message_type: 'text',
        content: JSON.stringify({ text: 'Hello from Feishu' }),
        create_time: '1704067200000',
      },
      sender: {
        sender_id: { open_id: 'ou_user123' },
        sender_type: 'user',
      },
      event: { sender: { sender_id: { open_id: 'ou_user123' } } },
    });

    expect(opts.onMessage).toHaveBeenCalledWith(
      'feishu:oc_123456',
      expect.objectContaining({
        id: 'msg_001',
        chat_jid: 'feishu:oc_123456',
        content: 'Hello from Feishu',
        is_from_me: false,
      }),
    );
  });

  it('ignores messages from unregistered chats', async () => {
    const opts = createTestOpts();
    const channel = new FeishuChannel('app_id', 'app_secret', opts);
    await channel.connect();

    channel._handleMessage({
      message: {
        chat_id: 'oc_unknown',
        message_id: 'msg_002',
        message_type: 'text',
        content: JSON.stringify({ text: 'Unregistered chat' }),
        create_time: '1704067200000',
      },
      sender: {
        sender_id: { open_id: 'ou_user123' },
        sender_type: 'user',
      },
      event: { sender: { sender_id: { open_id: 'ou_user123' } } },
    });

    expect(opts.onMessage).not.toHaveBeenCalled();
  });
});
```

**Step 2: Run test to verify it fails**

Run: `npx vitest run .claude/skills/add-feishu/add/src/channels/feishu.test.ts`
Expected: FAIL with "_handleMessage is not a function"

**Step 3: Implement message handling**

Add to `feishu.ts` in the `FeishuChannel` class:

```typescript
  async connect(): Promise<void> {
    this.client = new Client({
      appId: this.appId,
      appSecret: this.appSecret,
    });

    this.wsClient = new WSClient({
      appId: this.appId,
      appSecret: this.appSecret,
      eventDispatcher: {
        'im.message.receive_v1': (data: any) => this._handleMessage(data),
      },
    });

    await this.wsClient.start();
    this.connected = true;
    logger.info('Feishu WebSocket connected');
    console.log('\n  Feishu bot connected');
    console.log('  Send a message in a registered group to test\n');
  }

  /** @internal - exposed for testing */
  _handleMessage(data: any): void {
    const msg = data.message;
    const chatJid = `feishu:${msg.chat_id}`;

    // Check if this chat is registered
    const group = this.opts.registeredGroups()[chatJid];

    // Always emit metadata for discovery
    const timestamp = new Date(parseInt(msg.create_time, 10)).toISOString();
    this.opts.onChatMetadata(chatJid, timestamp, undefined, 'feishu', true);

    if (!group) {
      logger.debug({ chatJid }, 'Message from unregistered Feishu chat');
      return;
    }

    // Parse content based on message type
    let content = '';
    try {
      if (msg.message_type === 'text') {
        const parsed = JSON.parse(msg.content);
        content = parsed.text || '';
      } else if (msg.message_type === 'image') {
        content = '[Image]';
      } else if (msg.message_type === 'file') {
        const parsed = JSON.parse(msg.content);
        content = `[File: ${parsed.file_name || 'file'}]`;
      } else {
        content = `[${msg.message_type}]`;
      }
    } catch {
      content = msg.content || '';
    }

    const senderId = data.sender?.sender_id?.open_id || '';
    const senderName = data.sender?.sender_id?.open_id || 'Unknown'; // Will enhance later with user lookup

    this.opts.onMessage(chatJid, {
      id: msg.message_id,
      chat_jid: chatJid,
      sender: senderId,
      sender_name: senderName,
      content,
      timestamp,
      is_from_me: false,
    });

    logger.info({ chatJid, sender: senderName }, 'Feishu message stored');
  }
```

**Step 4: Run test to verify it passes**

Run: `npx vitest run .claude/skills/add-feishu/add/src/channels/feishu.test.ts`
Expected: PASS

**Step 5: Commit**

```bash
git add .claude/skills/add-feishu/add/src/channels/feishu.ts .claude/skills/add-feishu/add/src/channels/feishu.test.ts
git commit -m "feat(feishu): add message handling"
```

---

## Task 4: Add Media Support

**Files:**
- Modify: `.claude/skills/add-feishu/add/src/channels/feishu.ts`
- Modify: `.claude/skills/add-feishu/add/src/channels/feishu.test.ts`

**Step 1: Write the failing test for media messages**

Add to `feishu.test.ts`:

```typescript
describe('media messages', () => {
  it('handles image messages with placeholder', async () => {
    const opts = createTestOpts();
    const channel = new FeishuChannel('app_id', 'app_secret', opts);
    await channel.connect();

    channel._handleMessage({
      message: {
        chat_id: 'oc_123456',
        message_id: 'msg_img',
        message_type: 'image',
        content: JSON.stringify({ image_key: 'img_key_123' }),
        create_time: '1704067200000',
      },
      sender: { sender_id: { open_id: 'ou_user123' } },
    });

    expect(opts.onMessage).toHaveBeenCalledWith(
      'feishu:oc_123456',
      expect.objectContaining({ content: '[Image]' }),
    );
  });

  it('handles file messages with filename', async () => {
    const opts = createTestOpts();
    const channel = new FeishuChannel('app_id', 'app_secret', opts);
    await channel.connect();

    channel._handleMessage({
      message: {
        chat_id: 'oc_123456',
        message_id: 'msg_file',
        message_type: 'file',
        content: JSON.stringify({ file_key: 'file_key_123', file_name: 'report.pdf' }),
        create_time: '1704067200000',
      },
      sender: { sender_id: { open_id: 'ou_user123' } },
    });

    expect(opts.onMessage).toHaveBeenCalledWith(
      'feishu:oc_123456',
      expect.objectContaining({ content: '[File: report.pdf]' }),
    );
  });

  it('handles unknown message types gracefully', async () => {
    const opts = createTestOpts();
    const channel = new FeishuChannel('app_id', 'app_secret', opts);
    await channel.connect();

    channel._handleMessage({
      message: {
        chat_id: 'oc_123456',
        message_id: 'msg_unknown',
        message_type: 'interactive',
        content: '{}',
        create_time: '1704067200000',
      },
      sender: { sender_id: { open_id: 'ou_user123' } },
    });

    expect(opts.onMessage).toHaveBeenCalledWith(
      'feishu:oc_123456',
      expect.objectContaining({ content: '[interactive]' }),
    );
  });
});
```

**Step 2: Run test to verify it passes (already implemented)**

Run: `npx vitest run .claude/skills/add-feishu/add/src/channels/feishu.test.ts`
Expected: PASS (media handling was included in Task 3)

**Step 3: Commit**

```bash
git add .claude/skills/add-feishu/add/src/channels/feishu.test.ts
git commit -m "test(feishu): add media message tests"
```

---

## Task 5: Add sendMessage Tests

**Files:**
- Modify: `.claude/skills/add-feishu/add/src/channels/feishu.test.ts`

**Step 1: Write the failing test for sendMessage**

Add to `feishu.test.ts`:

```typescript
describe('sendMessage', () => {
  it('sends message via Feishu API', async () => {
    const opts = createTestOpts();
    const channel = new FeishuChannel('app_id', 'app_secret', opts);
    await channel.connect();

    await channel.sendMessage('feishu:oc_123456', 'Hello');

    expect(mockClient.im.message.create).toHaveBeenCalledWith({
      params: { receive_id_type: 'chat_id' },
      data: {
        receive_id: 'oc_123456',
        msg_type: 'text',
        content: JSON.stringify({ text: 'Hello' }),
      },
    });
  });

  it('strips feishu: prefix from JID', async () => {
    const opts = createTestOpts();
    const channel = new FeishuChannel('app_id', 'app_secret', opts);
    await channel.connect();

    await channel.sendMessage('feishu:oc_987654', 'Test message');

    expect(mockClient.im.message.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          receive_id: 'oc_987654',
        }),
      }),
    );
  });

  it('handles send failure gracefully', async () => {
    const opts = createTestOpts();
    const channel = new FeishuChannel('app_id', 'app_secret', opts);
    await channel.connect();

    mockClient.im.message.create.mockRejectedValueOnce(new Error('Network error'));

    // Should not throw
    await expect(
      channel.sendMessage('feishu:oc_123456', 'Will fail'),
    ).resolves.toBeUndefined();
  });

  it('does nothing when client is not initialized', async () => {
    const opts = createTestOpts();
    const channel = new FeishuChannel('app_id', 'app_secret', opts);

    // Don't connect — client is null
    await channel.sendMessage('feishu:oc_123456', 'No client');

    expect(mockClient.im.message.create).not.toHaveBeenCalled();
  });
});
```

**Step 2: Run test to verify it passes**

Run: `npx vitest run .claude/skills/add-feishu/add/src/channels/feishu.test.ts`
Expected: PASS

**Step 3: Commit**

```bash
git add .claude/skills/add-feishu/add/src/channels/feishu.test.ts
git commit -m "test(feishu): add sendMessage tests"
```

---

## Task 6: Add Config Modification Intent

**Files:**
- Create: `.claude/skills/add-feishu/modify/src/config.ts`
- Create: `.claude/skills/add-feishu/modify/src/config.ts.intent.md`

**Step 1: Create config modification file**

Create `.claude/skills/add-feishu/modify/src/config.ts`:

```typescript
import os from 'os';
import path from 'path';

import { readEnvFile } from './env.js';

// Read config values from .env (falls back to process.env).
// Secrets are NOT read here — they stay on disk and are loaded only
// where needed (container-runner.ts) to avoid leaking to child processes.
const envConfig = readEnvFile([
  'ASSISTANT_NAME',
  'ASSISTANT_HAS_OWN_NUMBER',
  'FEISHU_APP_ID',
  'FEISHU_APP_SECRET',
  'FEISHU_ONLY',
]);

export const ASSISTANT_NAME =
  process.env.ASSISTANT_NAME || envConfig.ASSISTANT_NAME || 'Andy';
export const ASSISTANT_HAS_OWN_NUMBER =
  (process.env.ASSISTANT_HAS_OWN_NUMBER || envConfig.ASSISTANT_HAS_OWN_NUMBER) === 'true';
export const POLL_INTERVAL = 2000;
export const SCHEDULER_POLL_INTERVAL = 60000;

// Absolute paths needed for container mounts
const PROJECT_ROOT = process.cwd();
const HOME_DIR = process.env.HOME || os.homedir();

// Mount security: allowlist stored OUTSIDE project root, never mounted into containers
export const MOUNT_ALLOWLIST_PATH = path.join(
  HOME_DIR,
  '.config',
  'nanoclaw',
  'mount-allowlist.json',
);
export const STORE_DIR = path.resolve(PROJECT_ROOT, 'store');
export const GROUPS_DIR = path.resolve(PROJECT_ROOT, 'groups');
export const DATA_DIR = path.resolve(PROJECT_ROOT, 'data');
export const MAIN_GROUP_FOLDER = 'main';

export const CONTAINER_IMAGE =
  process.env.CONTAINER_IMAGE || 'nanoclaw-agent:latest';
export const CONTAINER_TIMEOUT = parseInt(
  process.env.CONTAINER_TIMEOUT || '1800000',
  10,
);
export const CONTAINER_MAX_OUTPUT_SIZE = parseInt(
  process.env.CONTAINER_MAX_OUTPUT_SIZE || '10485760',
  10,
); // 10MB default
export const IPC_POLL_INTERVAL = 1000;
export const IDLE_TIMEOUT = parseInt(process.env.IDLE_TIMEOUT || '1800000', 10); // 30min default — how long to keep container alive after last result
export const MAX_CONCURRENT_CONTAINERS = Math.max(
  1,
  parseInt(process.env.MAX_CONCURRENT_CONTAINERS || '5', 10) || 5,
);

function escapeRegex(str: string): string {
  return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

export const TRIGGER_PATTERN = new RegExp(
  `^@${escapeRegex(ASSISTANT_NAME)}\\b`,
  'i',
);

// Timezone for scheduled tasks (cron expressions, etc.)
// Uses system timezone by default
export const TIMEZONE =
  process.env.TZ || Intl.DateTimeFormat().resolvedOptions().timeZone;

// Feishu configuration
export const FEISHU_APP_ID =
  process.env.FEISHU_APP_ID || envConfig.FEISHU_APP_ID || '';
export const FEISHU_APP_SECRET =
  process.env.FEISHU_APP_SECRET || envConfig.FEISHU_APP_SECRET || '';
export const FEISHU_ONLY =
  (process.env.FEISHU_ONLY || envConfig.FEISHU_ONLY) === 'true';
```

**Step 2: Create config intent file**

Create `.claude/skills/add-feishu/modify/src/config.ts.intent.md`:

```markdown
# Config Modification Intent

Add Feishu configuration variables:

1. Add `FEISHU_APP_ID`, `FEISHU_APP_SECRET`, `FEISHU_ONLY` to `readEnvFile()` array
2. Export `FEISHU_APP_ID` - Feishu app ID from developer console
3. Export `FEISHU_APP_SECRET` - Feishu app secret from developer console
4. Export `FEISHU_ONLY` - When true, only run Feishu channel (disable WhatsApp)

Pattern follows existing TELEGRAM_* variables.
```

**Step 3: Commit**

```bash
git add .claude/skills/add-feishu/modify/src/config.ts .claude/skills/add-feishu/modify/src/config.ts.intent.md
git commit -m "feat(feishu): add config modification intent"
```

---

## Task 7: Add Index.ts Modification Intent

**Files:**
- Create: `.claude/skills/add-feishu/modify/src/index.ts`
- Create: `.claude/skills/add-feishu/modify/src/index.ts.intent.md`

**Step 1: Create index.ts modification file**

This file should show the full index.ts with Feishu integration. Key changes:
- Import `FEISHU_APP_ID`, `FEISHU_APP_SECRET`, `FEISHU_ONLY` from config
- Import `FeishuChannel` from channels
- Create and connect Feishu channel if credentials exist

Create `.claude/skills/add-feishu/modify/src/index.ts.intent.md`:

```markdown
# Index.ts Modification Intent

Add Feishu channel initialization to main():

1. Import `FEISHU_APP_ID`, `FEISHU_APP_SECRET`, `FEISHU_ONLY` from `./config.js`
2. Import `FeishuChannel` from `./channels/feishu.js`
3. In `main()`, after channel callbacks setup, before WhatsApp:

```typescript
// Create and connect channels
if (FEISHU_APP_ID && FEISHU_APP_SECRET) {
  const feishu = new FeishuChannel(FEISHU_APP_ID, FEISHU_APP_SECRET, channelOpts);
  channels.push(feishu);
  await feishu.connect();
}

if (!FEISHU_ONLY) {
  whatsapp = new WhatsAppChannel(channelOpts);
  channels.push(whatsapp);
  await whatsapp.connect();
}
```

Pattern follows existing Telegram integration.
```

**Step 2: Commit**

```bash
git add .claude/skills/add-feishu/modify/src/index.ts.intent.md
git commit -m "feat(feishu): add index.ts modification intent"
```

---

## Task 8: Add Routing Tests

**Files:**
- Create: `.claude/skills/add-feishu/modify/src/routing.test.ts`
- Create: `.claude/skills/add-feishu/modify/src/routing.test.ts.intent.md`

**Step 1: Create routing test intent**

Create `.claude/skills/add-feishu/modify/src/routing.test.ts.intent.md`:

```markdown
# Routing Test Modification Intent

Add test for Feishu JID routing:

```typescript
it('routes feishu: JIDs to Feishu channel', () => {
  const mockFeishu = {
    name: 'feishu',
    ownsJid: (jid: string) => jid.startsWith('feishu:'),
    isConnected: () => true,
  };
  const channels = [mockWhatsApp, mockFeishu];

  expect(findChannel(channels, 'feishu:oc_123456')).toBe(mockFeishu);
  expect(findChannel(channels, '12345@g.us')).toBe(mockWhatsApp);
});
```

Pattern follows existing Telegram routing test.
```

**Step 2: Commit**

```bash
git add .claude/skills/add-feishu/modify/src/routing.test.ts.intent.md
git commit -m "test(feishu): add routing test intent"
```

---

## Task 9: Create SKILL.md User Guide

**Files:**
- Create: `.claude/skills/add-feishu/SKILL.md`

**Step 1: Write the skill guide**

```markdown
# Add Feishu Channel

Add Feishu (Lark) as a messaging channel for NanoClaw.

## Prerequisites

- Feishu developer account
- Feishu app with bot capabilities enabled
- App ID and App Secret from Feishu developer console

## Setup

### Phase 1: Create Feishu App

1. Go to [Feishu Open Platform](https://open.feishu.cn/app)
2. Create a new app or use existing
3. Enable "Bot" capability
4. Note your **App ID** and **App Secret**

### Phase 2: Configure Permissions

In your Feishu app settings, add these permissions:
- `im:message` - Send and receive messages
- `im:message:send_as_bot` - Send messages as bot
- `im:resource` - Access files and images
- `contact:user.base:readonly` - Read user info for sender names

### Phase 3: Install to NanoClaw

Add to your `.env` file:

```bash
FEISHU_APP_ID=cli_xxxx
FEISHU_APP_SECRET=xxxx

# Optional: run Feishu only (disable WhatsApp)
FEISHU_ONLY=false
```

### Phase 4: Register Groups

Send `/chatid` in any Feishu group to get the chat ID for registration.

Register via the admin group:
```
@Andy register group feishu:oc_xxxxx as "Project Team" folder project-team
```

## Testing

1. Start NanoClaw: `npm run dev`
2. Send a message in a registered Feishu group
3. Verify the agent responds

## Features

- **Full messaging**: Text, images, files
- **No @mention required**: Bot responds to all messages in registered groups
- **WebSocket transport**: No public URL needed
- **Isolated**: Runs independently of WhatsApp

## Troubleshooting

### Bot doesn't respond
- Check `FEISHU_APP_ID` and `FEISHU_APP_SECRET` are correct
- Verify bot is added to the group
- Check permissions are approved in Feishu admin console

### Connection errors
- Feishu requires the app to be published (at least internally)
- Check network connectivity to Feishu servers

### Permission denied
- Ensure all required permissions are added and approved
- For enterprise accounts, admin approval may be required
```

**Step 2: Commit**

```bash
git add .claude/skills/add-feishu/SKILL.md
git commit -m "docs(feishu): add user setup guide"
```

---

## Task 10: Final Integration Test

**Files:**
- Create: `.claude/skills/add-feishu/tests/feishu.test.ts`

**Step 1: Create skill integration test**

```typescript
import { describe, it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';
import yaml from 'yaml';

const SKILL_DIR = path.resolve(__dirname, '..');

describe('add-feishu skill', () => {
  it('has valid manifest', () => {
    const manifestPath = path.join(SKILL_DIR, 'manifest.yaml');
    expect(fs.existsSync(manifestPath)).toBe(true);

    const manifest = yaml.parse(fs.readFileSync(manifestPath, 'utf-8'));
    expect(manifest.skill).toBe('feishu');
    expect(manifest.adds).toContain('src/channels/feishu.ts');
    expect(manifest.adds).toContain('src/channels/feishu.test.ts');
  });

  it('has SKILL.md', () => {
    const skillMdPath = path.join(SKILL_DIR, 'SKILL.md');
    expect(fs.existsSync(skillMdPath)).toBe(true);
  });

  it('has channel implementation', () => {
    const channelPath = path.join(SKILL_DIR, 'add/src/channels/feishu.ts');
    expect(fs.existsSync(channelPath)).toBe(true);
  });

  it('has channel tests', () => {
    const testPath = path.join(SKILL_DIR, 'add/src/channels/feishu.test.ts');
    expect(fs.existsSync(testPath)).toBe(true);
  });

  it('has config modification', () => {
    const configPath = path.join(SKILL_DIR, 'modify/src/config.ts');
    const configContent = fs.readFileSync(configPath, 'utf-8');
    expect(configContent).toContain('FEISHU_APP_ID');
    expect(configContent).toContain('FEISHU_APP_SECRET');
    expect(configContent).toContain('FEISHU_ONLY');
  });
});
```

**Step 2: Run all tests**

Run: `npx vitest run .claude/skills/add-feishu/`
Expected: PASS

**Step 3: Final commit**

```bash
git add .claude/skills/add-feishu/tests/feishu.test.ts
git commit -m "test(feishu): add skill integration tests"
```

---

## Summary

After completing all tasks, the skill structure will be:

```
.claude/skills/add-feishu/
├── SKILL.md                           # User guide
├── manifest.yaml                      # Skill metadata
├── add/
│   └── src/channels/
│       ├── feishu.ts                  # Channel implementation
│       └── feishu.test.ts             # Unit tests
├── modify/
│   └── src/
│       ├── config.ts                  # Full config with Feishu vars
│       ├── config.ts.intent.md        # Merge intent
│       └── index.ts.intent.md         # Merge intent
│       └── routing.test.ts.intent.md  # Test intent
└── tests/
    └── feishu.test.ts                 # Skill integration tests
```

To apply the skill: Run the skills engine or manually merge the files following the intent docs.
