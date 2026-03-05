# Feishu Channel Design

**Date**: 2026-03-04
**Status**: Approved

## Overview

Add Feishu as a full messaging channel to NanoClaw. Messages received via Feishu are routed to Claude Agent SDK (running in containers), with responses sent back to Feishu.

## Requirements

- Full bidirectional messaging (receive and respond)
- Text, images, and files - both send and receive
- No @mention required - bot responds to all messages in registered groups
- Completely isolated from WhatsApp channel
- WebSocket-based transport (no public URL needed)

## Architecture

```
[Feishu App] ←WebSocket→ [FeishuChannel] → [NanoClaw Orchestrator] → [Claude Agent Container]
                                ↓
                         [SQLite DB]
```

- **Transport**: WebSocket (Long Connection Mode)
- **JID Format**: `feishu:{chat_id}`
- **Trigger**: All messages (no mention required)
- **Media**: Full send/receive support
- **Isolation**: Separate from WhatsApp

## Key Components

| Component | Purpose |
|-----------|---------|
| `src/channels/feishu.ts` | Channel implementation |
| `src/config.ts` | Add `FEISHU_APP_ID`, `FEISHU_APP_SECRET` |
| `src/index.ts` | Initialize channel if configured |
| `.env` | Store credentials |

## Channel Interface

```typescript
// src/channels/feishu.ts
export class FeishuChannel implements Channel {
  name = 'feishu';

  connect(): Promise<void>           // Establish WebSocket to Feishu
  sendMessage(jid, text): Promise<void>  // Send to chat_id
  sendMedia(jid, file): Promise<void>    // Upload & send media
  isConnected(): boolean
  ownsJid(jid): boolean              // jid.startsWith('feishu:')
  disconnect(): Promise<void>
}
```

## Message Handling

### Incoming Messages

| Type | Processing |
|------|------------|
| Text | Pass directly to agent |
| Image | Download, save to temp, pass path to agent |
| File | Download, save to temp, pass `[File: name]` + path |

### Outgoing Messages

| Type | Processing |
|------|------------|
| Text | Send via Feishu API |
| Image path | Upload to Feishu, send as image message |
| File path | Upload to Feishu, send as file message |

## Configuration

```bash
# .env
FEISHU_APP_ID=cli_xxx
FEISHU_APP_SECRET=xxx
FEISHU_ONLY=false  # true = disable WhatsApp
```

## Dependencies

- `@larksuiteoapi/node-sdk` - Official Feishu/Lark SDK

## Skill Structure

```
.claude/skills/add-feishu/
├── SKILL.md           # Setup instructions
├── manifest.yaml
└── add/
    └── src/channels/feishu.ts
```

## Error Handling

| Scenario | Handling |
|----------|----------|
| WebSocket disconnect | Auto-reconnect with exponential backoff (1s, 2s, 4s... max 60s) |
| Message send failure | Log error, queue for retry (3 attempts) |
| Media download failure | Log warning, pass `[Media unavailable]` to agent |
| Media upload failure | Log error, send text fallback: "Failed to send file: {name}" |
| Invalid credentials | Log error, mark channel disconnected, don't crash |
| Rate limiting | Respect Feishu's rate limits, queue excess messages |

## Testing Strategy

| Test | Method |
|------|--------|
| Unit tests | Mock Feishu SDK, test message parsing/routing |
| Integration | Test against Feishu sandbox app |
| E2E | Send message in Feishu group, verify agent response |

## Security

- Credentials stored in `.env`, read via `readEnvFile()` (not `process.env`)
- Media files saved to temp dir, cleaned up after processing
- No credentials passed to containers
