import { createHmac } from 'node:crypto';
import { Store } from '../src/db.js';
import { CatalogClient, toProduct, type RawProduct } from '../src/catalog.js';
import { WhatsAppClient } from '../src/whatsapp.js';
import { Bot } from '../src/bot.js';
import { createApp } from '../src/app.js';
import { loadConfig } from '../src/config.js';
import { silentLogger } from '../src/log.js';

export const APP_SECRET = 'test-app-secret';
export const PASSWORD = 'correct horse';

export interface FetchCall { url: string; init: RequestInit; body: any }

/** A fetch fake: records calls, answers with `respond(call)`. */
export function fakeFetch(respond: (call: FetchCall) => { status?: number; json: unknown }) {
  const calls: FetchCall[] = [];
  const f = (async (input: any, init: RequestInit = {}) => {
    const call: FetchCall = { url: String(input), init, body: init.body ? JSON.parse(String(init.body)) : null };
    calls.push(call);
    const r = respond(call);
    return new Response(JSON.stringify(r.json), { status: r.status ?? 200, headers: { 'content-type': 'application/json' } });
  }) as typeof fetch;
  return { fetch: f, calls };
}

let seq = 0;
export const graphOk = () => ({ json: { messaging_product: 'whatsapp', messages: [{ id: `wamid.OUT${++seq}` }] } });

export function setup(opts: { graph?: (c: FetchCall) => { status?: number; json: unknown }; products?: RawProduct[] } = {}) {
  const config = loadConfig({
    WA_TOKEN: 'tok', WA_PHONE_NUMBER_ID: '12345', WA_APP_SECRET: APP_SECRET, WA_VERIFY_TOKEN: 'verify-me',
    DASHBOARD_PASSWORD: PASSWORD, SESSION_SECRET: 'sess-secret', DASHBOARD_ORIGIN: 'http://localhost:5173',
  });
  const store = new Store(':memory:');
  const graph = fakeFetch(opts.graph ?? graphOk);
  const wa = new WhatsAppClient({ graphBaseUrl: config.graphBaseUrl, phoneNumberId: config.waPhoneNumberId, token: config.waToken, fetch: graph.fetch });
  const catalog = new CatalogClient({ workerUrl: null, secret: null, log: silentLogger });
  if (opts.products) {
    catalog.snapshot = {
      categories: ['LAPTOP'],
      products: opts.products.map((p) => toProduct('LAPTOP', p)!),
      loadedAt: Date.now(),
    };
  }
  const bot = new Bot({ store, wa, catalog, appBaseUrl: config.appBaseUrl, log: silentLogger });
  const { app, idle } = createApp({ config, store, catalog, bot, log: silentLogger });
  return { app, idle, store, graph, config, bot, catalog };
}

export function sign(body: string, secret = APP_SECRET) {
  return 'sha256=' + createHmac('sha256', secret).update(body).digest('hex');
}

export async function postWebhook(app: { request: (...a: any[]) => Response | Promise<Response> }, payload: unknown, sig?: string) {
  const body = JSON.stringify(payload);
  return app.request('/webhook', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-hub-signature-256': sig ?? sign(body) },
    body,
  });
}

export function inboundPayload(opts: { id: string; from?: string; text?: string; name?: string; ts?: number; type?: string; extra?: any }) {
  const from = opts.from ?? '919812345678';
  const type = opts.type ?? 'text';
  const msg: any = { from, id: opts.id, timestamp: String(Math.floor((opts.ts ?? Date.now()) / 1000)), type };
  if (type === 'text') msg.text = { body: opts.text ?? 'hello' };
  Object.assign(msg, opts.extra ?? {});
  return {
    object: 'whatsapp_business_account',
    entry: [{
      id: 'WABA',
      changes: [{
        field: 'messages',
        value: {
          messaging_product: 'whatsapp',
          metadata: { display_phone_number: '15550000000', phone_number_id: '12345' },
          contacts: [{ profile: { name: opts.name ?? 'Ravi' }, wa_id: from }],
          messages: [msg],
        },
      }],
    }],
  };
}

export function statusPayload(id: string, status: string, errors?: unknown[]) {
  return {
    object: 'whatsapp_business_account',
    entry: [{ id: 'WABA', changes: [{ field: 'messages', value: {
      messaging_product: 'whatsapp',
      statuses: [{ id, status, timestamp: String(Math.floor(Date.now() / 1000)), recipient_id: '919812345678', ...(errors ? { errors } : {}) }],
    } }] }],
  };
}

export async function login(app: { request: (...a: any[]) => Response | Promise<Response> }) {
  const res = await app.request('/api/login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ password: PASSWORD }) });
  const j = (await res.json()) as { token: string };
  return { Authorization: `Bearer ${j.token}`, 'content-type': 'application/json' };
}
