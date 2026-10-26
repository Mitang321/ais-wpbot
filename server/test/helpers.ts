import { createHmac } from 'node:crypto';
import { Store } from '../src/db.js';
import { WhatsAppClient } from '../src/whatsapp.js';
import { Bot } from '../src/bot.js';
import { createApp } from '../src/app.js';
import { loadConfig } from '../src/config.js';
import { silentLogger } from '../src/log.js';
import type { Product, Run } from '../src/types.js';
import type { ParseResult } from '../src/parser.js';

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

/** A small fixed catalogue so tests don't depend on seed.ts. */
export const PRODUCTS: Product[] = [
  { id: 'okra', name: 'Okra', category: 'Vegetables', unit: 'kg', packLabel: null, packGrams: null, priceCents: 450, aliases: ['bhindi'], active: true, sort: 1 },
  { id: 'curry-leaves', name: 'Curry leaves', category: 'Vegetables', unit: 'bunch', packLabel: null, packGrams: null, priceCents: 199, aliases: ['kadi patta'], active: true, sort: 2 },
  { id: 'kaju-katli', name: 'Kaju katli', category: 'Sweets', unit: 'pack', packLabel: '250 g box', packGrams: 250, priceCents: 600, aliases: ['kaju'], active: true, sort: 3 },
  { id: 'basmati-5kg', name: 'Basmati rice', category: 'Rice & Atta', unit: 'pack', packLabel: '5 kg bag', packGrams: 5000, priceCents: 1499, aliases: ['basmati', 'rice'], active: true, sort: 4 },
  { id: 'old-thing', name: 'Old thing', category: 'Snacks', unit: 'pc', packLabel: null, packGrams: null, priceCents: 100, aliases: [], active: false, sort: 5 },
];

/** Fixed clock: Wed 28 Oct 2026, 12:00 Paris (11:00 UTC). */
export const NOW = Date.UTC(2026, 9, 28, 11, 0, 0);

export const RUN: Omit<Run, 'id' | 'createdAt'> = {
  town: 'Manosque',
  deliveryDate: '2026-11-06',
  deliveryTime: 'evening, around 6pm',
  pickupSpot: 'School parking',
  cutoffAt: Date.UTC(2026, 10, 5, 17, 0, 0), // Thu 5 Nov, 6pm Paris
  vegCutoffAt: Date.UTC(2026, 9, 31, 17, 0, 0), // Sat 31 Oct, 6pm Paris
  status: 'open',
};

export interface SetupOpts {
  graph?: (c: FetchCall) => { status?: number; json: unknown };
  /** Keep the stored default settings (autoReply on). Otherwise tests start with autoReply off. */
  bot?: boolean;
  /** Insert PRODUCTS and RUN. */
  shop?: boolean;
  now?: () => number;
  parse?: (text: string, products: Product[]) => Promise<ParseResult>;
}

export function setup(opts: SetupOpts = {}) {
  const config = loadConfig({
    WA_TOKEN: 'tok', WA_PHONE_NUMBER_ID: '12345', WA_APP_SECRET: APP_SECRET, WA_VERIFY_TOKEN: 'verify-me',
    DASHBOARD_PASSWORD: PASSWORD, SESSION_SECRET: 'sess-secret', DASHBOARD_ORIGIN: 'http://localhost:5173',
  });
  const store = new Store(':memory:');
  if (!opts.bot) store.saveSettings({ autoReply: false, allowedPhones: [] });
  let run: Run | null = null;
  if (opts.shop) {
    for (const p of PRODUCTS) store.insertProduct(p);
    run = store.createRun(RUN, NOW - 86_400_000);
  }
  const graph = fakeFetch(opts.graph ?? graphOk);
  const wa = new WhatsAppClient({ graphBaseUrl: config.graphBaseUrl, phoneNumberId: config.waPhoneNumberId, token: config.waToken, fetch: graph.fetch });
  const bot = new Bot({
    store, wa, storeName: config.storeName, geminiApiKey: null, geminiModel: config.geminiModel, log: silentLogger,
    now: opts.now, parse: opts.parse,
  });
  const { app, idle } = createApp({ config, store, bot, log: silentLogger });
  return { app, idle, store, graph, config, bot, run };
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
