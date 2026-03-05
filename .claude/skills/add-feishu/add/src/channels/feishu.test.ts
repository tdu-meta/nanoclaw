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

// Create mock functions that we can reference after import
const mockStart = vi.fn().mockResolvedValue(undefined);
const mockStop = vi.fn();
const mockMessageCreate = vi.fn().mockResolvedValue({ data: { message_id: 'msg_123' } });
const mockFileCreate = vi.fn().mockResolvedValue({ data: { file_key: 'file_123' } });
const mockImageCreate = vi.fn().mockResolvedValue({ data: { image_key: 'img_123' } });

// Mock Feishu SDK with inline class definitions
vi.mock('@larksuiteoapi/node-sdk', () => {
  return {
    Client: class MockClient {
      im = {
        message: {
          create: mockMessageCreate,
        },
        file: {
          create: mockFileCreate,
        },
        image: {
          create: mockImageCreate,
        },
      };
    },
    WSClient: class MockWSClient {
      start = mockStart;
      stop = mockStop;
    },
  };
});

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
      expect(mockStart).toHaveBeenCalled();
    });

    it('disconnects cleanly', async () => {
      const opts = createTestOpts();
      const channel = new FeishuChannel('app_id', 'app_secret', opts);

      await channel.connect();
      expect(channel.isConnected()).toBe(true);

      await channel.disconnect();
      expect(channel.isConnected()).toBe(false);
      expect(mockStop).toHaveBeenCalled();
    });
  });

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

  describe('sendMessage', () => {
    it('sends message via Feishu API', async () => {
      const opts = createTestOpts();
      const channel = new FeishuChannel('app_id', 'app_secret', opts);
      await channel.connect();

      await channel.sendMessage('feishu:oc_123456', 'Hello');

      expect(mockMessageCreate).toHaveBeenCalledWith({
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

      expect(mockMessageCreate).toHaveBeenCalledWith(
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

      mockMessageCreate.mockRejectedValueOnce(new Error('Network error'));

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

      expect(mockMessageCreate).not.toHaveBeenCalled();
    });
  });
});
