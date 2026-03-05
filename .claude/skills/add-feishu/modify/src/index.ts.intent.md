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
