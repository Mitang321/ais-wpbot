/** Entry point: config -> SQLite -> catalog -> HTTP server. */
import { serve } from '@hono/node-server';
import { loadConfig, type Config } from './config.js';
import { openStore } from './db.js';
import { CatalogClient } from './catalog.js';
import { WhatsAppClient } from './whatsapp.js';
import { Bot } from './bot.js';
import { createApp } from './app.js';
import { consoleLogger as log, errMsg } from './log.js';

let config: Config;
try {
  config = loadConfig();
} catch (err) {
  log.error(errMsg(err));
  process.exit(1);
}

const store = openStore(config.dataDir);
const catalog = new CatalogClient({ workerUrl: config.workerUrl, secret: config.botSharedSecret, log });
const wa = new WhatsAppClient({
  graphBaseUrl: config.graphBaseUrl,
  phoneNumberId: config.waPhoneNumberId,
  token: config.waToken,
});
const bot = new Bot({ store, wa, catalog, appBaseUrl: config.appBaseUrl, log });
const { app, idle } = createApp({ config, store, catalog, bot, log });

const server = serve({ fetch: app.fetch, port: config.port }, (info) => {
  log.info(`wa-server listening on :${info.port} (data: ${config.dataDir})`);
});
catalog.start();

let shuttingDown = false;
async function shutdown(signal: string) {
  if (shuttingDown) return;
  shuttingDown = true;
  log.info(`${signal}: shutting down`);
  const force = setTimeout(() => process.exit(1), 8000);
  force.unref();
  catalog.stop();
  server.close();
  try {
    await idle();
  } catch {
    /* ignore */
  }
  store.close();
  log.info('bye');
  process.exit(0);
}
process.on('SIGTERM', () => void shutdown('SIGTERM'));
process.on('SIGINT', () => void shutdown('SIGINT'));
