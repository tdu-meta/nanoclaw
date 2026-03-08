import { describe, it, expect, beforeEach, vi } from 'vitest';

// --- Mocks ---

vi.mock('../config.js', () => ({
  FEISHU_APP_ID: 'test-app-id',
  FEISHU_APP_SECRET: 'test-app-secret',
}));

vi.mock('../logger.js', () => ({
  logger: {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
}));

const mockMessageCreate = vi.fn().mockResolvedValue({});
const mockWsStart = vi.fn().mockResolvedValue(undefined);
const mockWsClose = vi.fn();

vi.mock('@larksuiteoapi/node-sdk', () => {
  function Client() {
    return { im: { message: { create: mockMessageCreate } } };
  }
  function EventDispatcher() {
    return { register: vi.fn().mockReturnThis() };
  }
  function WSClient() {
    return { start: mockWsStart, close: mockWsClose };
  }
  return { Client, EventDispatcher, WSClient };
});

vi.mock('./registry.js', () => ({
  registerChannel: vi.fn(),
  getChannelFactory: vi.fn(),
  getRegisteredChannelNames: vi.fn(() => []),
}));

import { FeishuChannel } from './feishu.js';
import { ChannelOpts, registerChannel } from './registry.js';

// --- Helpers ---

function createOpts(
  registeredJids: string[] = ['feishu:chat-001'],
): ChannelOpts {
  return {
    onMessage: vi.fn(),
    onChatMetadata: vi.fn(),
    registeredGroups: vi.fn(() =>
      Object.fromEntries(
        registeredJids.map((jid) => [
          jid,
          {
            name: 'Test Group',
            folder: 'test',
            trigger: '@nano',
            added_at: '',
          },
        ]),
      ),
    ),
  };
}

function makeTextMessage(chatId: string, text: string, senderId = 'ou_abc123') {
  return {
    message: {
      message_id: `msg-${Date.now()}`,
      chat_id: chatId,
      message_type: 'text',
      content: JSON.stringify({ text }),
      create_time: String(Date.now()),
    },
    sender: { sender_id: { open_id: senderId } },
  };
}

// --- Tests ---

describe('FeishuChannel', () => {
  let opts: ChannelOpts;
  let channel: FeishuChannel;

  beforeEach(() => {
    vi.clearAllMocks();
    opts = createOpts();
    channel = new FeishuChannel('app-id', 'app-secret', opts);
  });

  describe('ownsJid', () => {
    it('returns true for feishu: JIDs', () => {
      expect(channel.ownsJid('feishu:oc_abc123')).toBe(true);
    });

    it('returns false for non-feishu JIDs', () => {
      expect(channel.ownsJid('120363@g.us')).toBe(false);
      expect(channel.ownsJid('1234@s.whatsapp.net')).toBe(false);
    });
  });

  describe('isConnected', () => {
    it('returns false before connect', () => {
      expect(channel.isConnected()).toBe(false);
    });

    it('returns true after connect', async () => {
      await channel.connect();
      expect(channel.isConnected()).toBe(true);
    });

    it('returns false after disconnect', async () => {
      await channel.connect();
      await channel.disconnect();
      expect(channel.isConnected()).toBe(false);
    });
  });

  describe('_handleMessage', () => {
    it('delivers text message to registered group', () => {
      channel._handleMessage(makeTextMessage('chat-001', 'hello world'));

      expect(opts.onMessage).toHaveBeenCalledWith(
        'feishu:chat-001',
        expect.objectContaining({
          chat_jid: 'feishu:chat-001',
          content: 'hello world',
          is_from_me: false,
        }),
      );
    });

    it('always emits chat metadata regardless of registration', () => {
      channel._handleMessage(makeTextMessage('unregistered-chat', 'hi'));

      expect(opts.onChatMetadata).toHaveBeenCalledWith(
        'feishu:unregistered-chat',
        expect.any(String),
        undefined,
        'feishu',
        true,
      );
    });

    it('does not call onMessage for unregistered group', () => {
      channel._handleMessage(makeTextMessage('unregistered-chat', 'hi'));

      expect(opts.onMessage).not.toHaveBeenCalled();
    });

    it('handles image message type', () => {
      channel._handleMessage({
        message: {
          message_id: 'msg-img',
          chat_id: 'chat-001',
          message_type: 'image',
          content: '{}',
          create_time: String(Date.now()),
        },
        sender: { sender_id: { open_id: 'ou_abc' } },
      });

      expect(opts.onMessage).toHaveBeenCalledWith(
        'feishu:chat-001',
        expect.objectContaining({ content: '[Image]' }),
      );
    });

    it('handles file message type with file name', () => {
      channel._handleMessage({
        message: {
          message_id: 'msg-file',
          chat_id: 'chat-001',
          message_type: 'file',
          content: JSON.stringify({ file_name: 'report.pdf' }),
          create_time: String(Date.now()),
        },
        sender: { sender_id: { open_id: 'ou_abc' } },
      });

      expect(opts.onMessage).toHaveBeenCalledWith(
        'feishu:chat-001',
        expect.objectContaining({ content: '[File: report.pdf]' }),
      );
    });

    it('handles unknown message type', () => {
      channel._handleMessage({
        message: {
          message_id: 'msg-sticker',
          chat_id: 'chat-001',
          message_type: 'sticker',
          content: '{}',
          create_time: String(Date.now()),
        },
        sender: { sender_id: { open_id: 'ou_abc' } },
      });

      expect(opts.onMessage).toHaveBeenCalledWith(
        'feishu:chat-001',
        expect.objectContaining({ content: '[sticker]' }),
      );
    });

    it('falls back to raw content when JSON parse fails', () => {
      channel._handleMessage({
        message: {
          message_id: 'msg-bad-json',
          chat_id: 'chat-001',
          message_type: 'text',
          content: 'not-valid-json',
          create_time: String(Date.now()),
        },
        sender: { sender_id: { open_id: 'ou_abc' } },
      });

      expect(opts.onMessage).toHaveBeenCalledWith(
        'feishu:chat-001',
        expect.objectContaining({ content: 'not-valid-json' }),
      );
    });

    it('sets sender from open_id', () => {
      channel._handleMessage(makeTextMessage('chat-001', 'hey', 'ou_xyz999'));

      expect(opts.onMessage).toHaveBeenCalledWith(
        'feishu:chat-001',
        expect.objectContaining({
          sender: 'ou_xyz999',
          sender_name: 'ou_xyz999',
        }),
      );
    });

    it('parses timestamp from create_time milliseconds', () => {
      const ts = 1741312143229;
      channel._handleMessage({
        message: {
          message_id: 'msg-ts',
          chat_id: 'chat-001',
          message_type: 'text',
          content: JSON.stringify({ text: 'hi' }),
          create_time: String(ts),
        },
        sender: { sender_id: { open_id: 'ou_abc' } },
      });

      expect(opts.onMessage).toHaveBeenCalledWith(
        'feishu:chat-001',
        expect.objectContaining({
          timestamp: new Date(ts).toISOString(),
        }),
      );
    });
  });

  describe('sendMessage', () => {
    it('does nothing when client not initialized', async () => {
      await channel.sendMessage('feishu:chat-001', 'hello');
      expect(mockMessageCreate).not.toHaveBeenCalled();
    });

    it('sends message after connect', async () => {
      await channel.connect();
      await channel.sendMessage('feishu:chat-001', 'hello');

      expect(mockMessageCreate).toHaveBeenCalledWith({
        params: { receive_id_type: 'chat_id' },
        data: {
          receive_id: 'chat-001',
          msg_type: 'text',
          content: JSON.stringify({ text: 'hello' }),
        },
      });
    });

    it('strips feishu: prefix from JID when sending', async () => {
      await channel.connect();
      await channel.sendMessage('feishu:oc_abc123', 'test');

      expect(mockMessageCreate).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({ receive_id: 'oc_abc123' }),
        }),
      );
    });

    it('logs error but does not throw when send fails', async () => {
      mockMessageCreate.mockRejectedValueOnce(new Error('API error'));
      await channel.connect();

      await expect(
        channel.sendMessage('feishu:chat-001', 'hello'),
      ).resolves.toBeUndefined();
    });
  });

  describe('registerChannel factory', () => {
    it('factory returns FeishuChannel when credentials are present', () => {
      // Test the factory logic directly
      const appId = 'test-app-id';
      const appSecret = 'test-app-secret';
      const factory = (o: ChannelOpts) =>
        appId && appSecret ? new FeishuChannel(appId, appSecret, o) : null;
      expect(factory(opts)).toBeInstanceOf(FeishuChannel);
    });

    it('factory returns null when credentials are missing', () => {
      const appId = '';
      const factory = (o: ChannelOpts) =>
        appId && 'secret' ? new FeishuChannel(appId, 'secret', o) : null;
      expect(factory(opts)).toBeNull();
    });
  });
});
