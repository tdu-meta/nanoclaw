import makeWASocket, { useMultiFileAuthState, makeCacheableSignalKeyStore, Browsers } from '@whiskeysockets/baileys';
import pino from 'pino';

const logger = pino({ level: 'silent' });
const { state, saveCreds } = await useMultiFileAuthState('store/auth');

const sock = makeWASocket({
  auth: { creds: state.creds, keys: makeCacheableSignalKeyStore(state.keys, logger) },
  printQRInTerminal: false,
  logger,
  browser: Browsers.macOS('Chrome'),
});

const timeout = setTimeout(() => {
  console.error('TIMEOUT');
  process.exit(1);
}, 30000);

sock.ev.on('creds.update', saveCreds);

sock.ev.on('connection.update', async (update) => {
  if (update.connection === 'open') {
    try {
      const groups = await sock.groupFetchAllParticipating();
      for (const [jid, metadata] of Object.entries(groups)) {
        console.log(`${jid}|${metadata.subject}`);
      }
    } catch (err) {
      console.error('FETCH_ERROR:', err.message);
    } finally {
      clearTimeout(timeout);
      sock.end(undefined);
      process.exit(0);
    }
  } else if (update.connection === 'close') {
    clearTimeout(timeout);
    console.error('CONNECTION_CLOSED');
    process.exit(1);
  }
});
