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
    const senderName = data.sender?.sender_id?.open_id || 'Unknown';

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
