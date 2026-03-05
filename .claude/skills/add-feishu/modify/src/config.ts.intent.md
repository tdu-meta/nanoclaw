# Config Modification Intent

Add Feishu configuration variables:

1. Add `FEISHU_APP_ID`, `FEISHU_APP_SECRET`, `FEISHU_ONLY` to `readEnvFile()` array
2. Export `FEISHU_APP_ID` - Feishu app ID from developer console
3. Export `FEISHU_APP_SECRET` - Feishu app secret from developer console
4. Export `FEISHU_ONLY` - When true, only run Feishu channel (disable WhatsApp)

Pattern follows existing TELEGRAM_* variables.
