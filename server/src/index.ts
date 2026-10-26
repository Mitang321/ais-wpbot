/** Entry point: config -> SQLite (+ seed) -> HTTP server. */
import { serve } from '@hono/node-server';
import { loadConfig, type Config } from './config.js';
import { openStore } from './db.js';
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
if (store.seedIfEmpty({ seedDemo: config.seedDemo })) {
  const n = store.storeCounts();
  log.info(`seeded ${n.products} products, ${n.runs} runs, ${n.orders} orders`);
}
const wa = new WhatsAppClient({
  graphBaseUrl: config.graphBaseUrl,
  phoneNumberId: config.waPhoneNumberId,
  token: config.waToken,
});
const bot = new Bot({
  store,
  wa,
  storeName: config.storeName,
  geminiApiKey: config.geminiApiKey,
  geminiModel: config.geminiModel,
  geminiApi: config.geminiApi,
  log,
});
const { app, idle } = createApp({ config, store, bot, log });

const server = serve({ fetch: app.fetch, port: config.port }, (info) => {
  log.info(`wa-server listening on :${info.port} (data: ${config.dataDir}, parser: ${config.geminiApiKey ? config.geminiModel : 'rules'})`);
});

let shuttingDown = false;
async function shutdown(signal: string) {
  if (shuttingDown) return;
  shuttingDown = true;
  log.info(`${signal}: shutting down`);
  const force = setTimeout(() => process.exit(1), 8000);
  force.unref();
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
