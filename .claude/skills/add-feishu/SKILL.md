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
