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
