/** HTTP routes (CONTRACT §1). Built as a factory so tests can inject fakes. */
import { Hono, type Context } from 'hono';
import { cors } from 'hono/cors';
import type { ContentfulStatusCode } from 'hono/utils/http-status';
import { getConnInfo } from '@hono/node-server/conninfo';
import type { Config } from './config.js';
import type { Store } from './db.js';
import type { Bot } from './bot.js';
import { issueToken, verifyToken, safeEqual, RateLimiter } from './auth.js';
import { verifyMetaSignature } from './whatsapp.js';
import { errMsg, type Logger } from './log.js';
import type { Conversation, OrderStatus, ProductUnit, RunStatus, Settings } from './types.js';
import type { ItemInput, ProductInput, RunInput } from './db.js';

export interface AppDeps {
  config: Config;
  store: Store;
  bot: Bot;
  log: Logger;
  startedAt?: number;
}

const MAX_WEBHOOK_BYTES = 1024 * 1024;
const MAX_TEXT = 4096;
const PHONE_RE = /^\d{8,15}$/;

class BadRequest extends Error {}

const UNITS: ProductUnit[] = ['kg', 'pack', 'pc', 'bunch'];
const RUN_STATUSES: RunStatus[] = ['open', 'closed', 'delivered'];
const ORDER_STATUSES: OrderStatus[] = ['confirmed', 'packed', 'collected', 'cancelled'];

const intId = (s: string) => (/^\d{1,12}$/.test(s) ? Number(s) : 0);

/** Trimmed string; required (non-empty) unless allowEmpty. */
function str(v: unknown, field: string, max: number, allowEmpty = false): string {
  if (typeof v !== 'string') throw new BadRequest(`"${field}" must be a string.`);
  const s = v.trim();
  if (!s && !allowEmpty) throw new BadRequest(`"${field}" is required.`);
  if (s.length > max) throw new BadRequest(`"${field}" is longer than ${max} characters.`);
  return s;
}

/** Validates product fields; with `partial` only the keys present are checked. */
function productFields(b: Record<string, any>, partial: boolean): Record<string, any> {
  const out: Record<string, any> = {};
  const has = (k: string) => k in b && b[k] !== undefined;
  if (!partial || has('name')) out.name = str(b.name, 'name', 100);
  if (!partial || has('category')) out.category = str(b.category, 'category', 50);
  if (!partial || has('unit')) {
    if (!UNITS.includes(b.unit)) throw new BadRequest(`"unit" must be one of ${UNITS.join(', ')}.`);
    out.unit = b.unit;
  }
  if (!partial || has('priceCents')) {
    if (!Number.isInteger(b.priceCents) || b.priceCents < 0 || b.priceCents > 10_000_000) {
      throw new BadRequest('"priceCents" must be a whole number of cents (0 or more).');
    }
    out.priceCents = b.priceCents;
  }
  if (has('packLabel')) out.packLabel = b.packLabel === null ? null : str(b.packLabel, 'packLabel', 50, true) || null;
  if (has('packGrams')) {
    if (b.packGrams !== null && (!Number.isInteger(b.packGrams) || b.packGrams <= 0)) {
      throw new BadRequest('"packGrams" must be a positive whole number or null.');
    }
    out.packGrams = b.packGrams;
  }
  if (has('aliases')) {
    if (!Array.isArray(b.aliases) || b.aliases.some((a: unknown) => typeof a !== 'string') || b.aliases.length > 100) {
      throw new BadRequest('"aliases" must be an array of strings.');
    }
    out.aliases = [...new Set<string>(b.aliases.map((a: string) => a.trim().toLowerCase()).filter(Boolean))];
  }
  if (has('active')) {
    if (typeof b.active !== 'boolean') throw new BadRequest('"active" must be a boolean.');
    out.active = b.active;
  }
  if (has('sort')) {
    if (!Number.isInteger(b.sort)) throw new BadRequest('"sort" must be a whole number.');
    out.sort = b.sort;
  }
  return out;
}

function runFields(b: Record<string, any>, partial: boolean): Partial<RunInput> {
  const out: Partial<RunInput> = {};
  const has = (k: string) => k in b && b[k] !== undefined;
  if (!partial || has('town')) out.town = str(b.town, 'town', 100);
  if (!partial || has('deliveryDate')) {
    const d = typeof b.deliveryDate === 'string' ? b.deliveryDate.trim() : '';
    const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(d);
    const dt = m ? new Date(Date.UTC(+m[1]!, +m[2]! - 1, +m[3]!)) : null;
    if (!dt || dt.toISOString().slice(0, 10) !== d) throw new BadRequest('"deliveryDate" must be a date like 2026-11-06.');
    out.deliveryDate = d;
  }
  if (!partial || has('deliveryTime')) out.deliveryTime = str(b.deliveryTime, 'deliveryTime', 100);
  if (!partial || has('pickupSpot')) out.pickupSpot = str(b.pickupSpot, 'pickupSpot', 200);
  if (!partial || has('cutoffAt')) {
    if (!Number.isInteger(b.cutoffAt) || b.cutoffAt <= 0) throw new BadRequest('"cutoffAt" must be a timestamp in ms.');
    out.cutoffAt = b.cutoffAt;
  }
  if (has('vegCutoffAt')) {
    if (b.vegCutoffAt !== null && (!Number.isInteger(b.vegCutoffAt) || b.vegCutoffAt <= 0)) {
      throw new BadRequest('"vegCutoffAt" must be a timestamp in ms or null.');
    }
    out.vegCutoffAt = b.vegCutoffAt;
  }
  return out;
}

export function fail(c: Context, status: ContentfulStatusCode, error: string, message: string) {
  return c.json({ ok: false as const, error, message }, status);
}

/** Digits only ("+91 98123-45678" -> "919812345678"). */
const normPhone = (v: unknown) => (typeof v === 'string' || typeof v === 'number' ? String(v).replace(/\D/g, '') : '');

function clientIp(c: Context): string {
  // Behind Coolify's Traefik the real client is the right-most X-Forwarded-For hop.
  const xff = c.req.header('x-forwarded-for');
  if (xff) {
    const parts = xff.split(',').map((s) => s.trim()).filter(Boolean);
    if (parts.length) return parts[parts.length - 1]!;
  }
  try {
    return getConnInfo(c).remote.address ?? 'unknown';
  } catch {
    return 'unknown';
  }
}

export function createApp(deps: AppDeps) {
  const { config, store, bot, log } = deps;
  const startedAt = deps.startedAt ?? Date.now();
  const loginLimiter = new RateLimiter(10, 60_000);
  const pending = new Set<Promise<void>>();

  const app = new Hono();

  app.onError((err, c) => {
    log.error(`${c.req.method} ${c.req.path}: ${errMsg(err)}`);
    return fail(c, 500, 'internal', 'Internal server error.');
  });
  app.notFound((c) => fail(c, 404, 'not_found', 'Not found.'));

  // ---------- health ----------
  app.get('/health', (c) => {
    return c.json({
      ok: true,
      uptimeSec: Math.round((Date.now() - startedAt) / 1000),
      rssMb: Math.round((process.memoryUsage.rss() / 1024 / 1024) * 10) / 10,
      store: store.storeCounts(),
    });
  });

  // ---------- Meta webhook ----------
  app.get('/webhook', (c) => {
    const mode = c.req.query('hub.mode');
    const token = c.req.query('hub.verify_token') ?? '';
    const challenge = c.req.query('hub.challenge') ?? '';
    if (mode === 'subscribe' && safeEqual(token, config.waVerifyToken)) {
      log.info('webhook: verification succeeded');
      return c.text(challenge, 200);
    }
    log.warn('webhook: verification rejected');
    return c.text('Forbidden', 403);
  });

  app.post('/webhook', async (c) => {
    const len = Number(c.req.header('content-length') ?? 0);
    if (len > MAX_WEBHOOK_BYTES) return fail(c, 413, 'too_large', 'Payload too large.');
    const raw = new Uint8Array(await c.req.arrayBuffer());
    if (raw.byteLength > MAX_WEBHOOK_BYTES) return fail(c, 413, 'too_large', 'Payload too large.');
    if (!verifyMetaSignature(config.waAppSecret, raw, c.req.header('x-hub-signature-256'))) {
      log.warn('webhook: bad signature');
      return fail(c, 401, 'bad_signature', 'Invalid X-Hub-Signature-256.');
    }
    let payload: unknown;
    try {
      payload = JSON.parse(Buffer.from(raw).toString('utf8'));
    } catch {
      return fail(c, 400, 'bad_request', 'Body must be JSON.');
    }
    // Answer Meta right away; process after the response is sent.
    const p = new Promise<void>((resolve) => setImmediate(resolve))
      .then(() => bot.handleWebhook(payload))
      .catch((err) => log.error(`webhook: ${errMsg(err)}`))
      .finally(() => pending.delete(p));
    pending.add(p);
    return c.text('OK', 200);
  });

  // ---------- dashboard API ----------
  const origins = new Set(config.dashboardOrigins);
  app.use(
    '/api/*',
    cors({
      // Auth is a bearer token (no cookies), so Vercel preview/production URLs are safe to allow.
      origin: (origin) => (origins.has(origin) || /^https:\/\/[a-z0-9-]+\.vercel\.app$/.test(origin) ? origin : null),
      allowMethods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
      allowHeaders: ['Authorization', 'Content-Type'],
      maxAge: 86400,
    }),
  );

  app.post('/api/login', async (c) => {
    if (!loginLimiter.take(clientIp(c))) {
      return fail(c, 429, 'rate_limited', 'Too many login attempts. Try again in a minute.');
    }
    const body = await c.req.json().catch(() => null);
    const password = typeof body?.password === 'string' ? body.password : '';
    if (!password || !safeEqual(password, config.dashboardPassword)) {
      log.warn('login: wrong password');
      return fail(c, 401, 'invalid_password', 'Wrong password.');
    }
    const { token, expiresAt } = issueToken(config.sessionSecret);
    return c.json({ ok: true, token, expiresAt });
  });

  app.use('/api/*', async (c, next) => {
    if (c.req.method === 'OPTIONS' || c.req.path === '/api/login') return next();
    const h = c.req.header('authorization') ?? '';
    const token = h.startsWith('Bearer ') ? h.slice(7).trim() : '';
    if (!verifyToken(config.sessionSecret, token)) {
      return fail(c, 401, 'unauthorized', 'Sign in again.');
    }
    return next();
  });

  app.get('/api/conversations', (c) => c.json({ ok: true, conversations: store.listConversations() }));

  app.get('/api/conversations/:phone', (c) => {
    const phone = normPhone(c.req.param('phone'));
    if (!PHONE_RE.test(phone)) return fail(c, 400, 'bad_request', 'Invalid phone number.');
    const beforeRaw = c.req.query('before');
    let before: number | undefined;
    if (beforeRaw !== undefined && beforeRaw !== '') {
      before = Number(beforeRaw);
      if (!Number.isFinite(before)) return fail(c, 400, 'bad_request', 'Invalid "before" timestamp.');
    }
    store.markRead(phone);
    const contact: Conversation = store.getConversation(phone) ?? {
      phone,
      name: null,
      lastMessageAt: 0,
      lastMessagePreview: '',
      lastInboundAt: null,
      windowOpen: false,
      unread: 0,
      allowed: store.getSettings().allowedPhones.includes(phone),
    };
    return c.json({ ok: true, contact, messages: store.getMessages(phone, before, 200) });
  });

  app.post('/api/send', async (c) => {
    const body = await c.req.json().catch(() => null);
    const to = normPhone(body?.to);
    const text = typeof body?.text === 'string' ? body.text.trim() : '';
    if (!PHONE_RE.test(to)) return fail(c, 400, 'bad_request', '"to" must be a phone number with country code.');
    if (!text) return fail(c, 400, 'bad_request', '"text" is required.');
    if (text.length > MAX_TEXT) return fail(c, 400, 'bad_request', `"text" is longer than ${MAX_TEXT} characters.`);
    const conv = store.getConversation(to);
    if (!conv?.windowOpen) {
      return fail(c, 409, 'window_closed', 'The 24-hour window is closed. Send a template message instead.');
    }
    const r = await bot.sendText(to, text);
    if (!r.ok) return fail(c, 502, 'send_failed', r.error);
    return c.json({ ok: true, message: r.message });
  });

  app.post('/api/send-template', async (c) => {
    const body = await c.req.json().catch(() => null);
    const to = normPhone(body?.to);
    const template = typeof body?.template === 'string' ? body.template.trim() : '';
    const language = typeof body?.language === 'string' && body.language.trim() ? body.language.trim() : 'en_US';
    if (!PHONE_RE.test(to)) return fail(c, 400, 'bad_request', '"to" must be a phone number with country code.');
    if (!/^[a-z0-9_]{1,512}$/.test(template)) return fail(c, 400, 'bad_request', '"template" must be a template name.');
    if (!/^[a-zA-Z]{2,3}(_[a-zA-Z]{2,4})?$/.test(language)) return fail(c, 400, 'bad_request', 'Invalid "language".');
    const r = await bot.sendTemplate(to, template, language);
    if (!r.ok) return fail(c, 502, 'send_failed', r.error);
    return c.json({ ok: true, message: r.message });
  });

  app.get('/api/settings', (c) => c.json({ ok: true, settings: store.getSettings() }));

  app.put('/api/settings', async (c) => {
    const body = await c.req.json().catch(() => null);
    if (!body || typeof body !== 'object' || Array.isArray(body)) {
      return fail(c, 400, 'bad_request', 'Body must be a JSON object.');
    }
    const next: Settings = { ...store.getSettings() };
    if ('autoReply' in body) {
      if (typeof body.autoReply !== 'boolean') return fail(c, 400, 'bad_request', '"autoReply" must be a boolean.');
      next.autoReply = body.autoReply;
    }
    if ('allowedPhones' in body) {
      if (!Array.isArray(body.allowedPhones)) return fail(c, 400, 'bad_request', '"allowedPhones" must be an array.');
      const phones = body.allowedPhones.map(normPhone);
      const bad = phones.findIndex((p: string) => !PHONE_RE.test(p));
      if (bad !== -1) return fail(c, 400, 'bad_request', `Invalid phone number: ${String(body.allowedPhones[bad])}`);
      next.allowedPhones = [...new Set<string>(phones)];
    }
    const saved = store.saveSettings(next);
    log.info(`settings: autoReply=${saved.autoReply}, allowedPhones=${saved.allowedPhones.length}`);
    return c.json({ ok: true, settings: saved });
  });

  // ---------- grocery store (GROCERY-CONTRACT §1) ----------

  const jsonBody = async (c: Context): Promise<Record<string, any>> => {
    const body = await c.req.json().catch(() => null);
    if (!body || typeof body !== 'object' || Array.isArray(body)) throw new BadRequest('Body must be a JSON object.');
    return body;
  };
  /** Runs a handler that validates input: BadRequest -> 400 bad_request. */
  const guard = (fn: (c: Context) => Promise<Response> | Response) => async (c: Context) => {
    try {
      return await fn(c);
    } catch (err) {
      if (err instanceof BadRequest) return fail(c, 400, 'bad_request', err.message);
      throw err;
    }
  };

  app.get('/api/products', (c) => c.json({ ok: true, products: store.listProducts() }));

  app.post('/api/products', guard(async (c) => {
    const input = productFields(await jsonBody(c), false) as ProductInput;
    const product = store.createProduct(input);
    log.info(`product created: ${product.id}`);
    return c.json({ ok: true, product });
  }));

  app.put('/api/products/:id', guard(async (c) => {
    const id = c.req.param('id') ?? '';
    if (!store.getProduct(id)) return fail(c, 404, 'not_found', `Product "${id}" not found.`);
    const product = store.updateProduct(id, productFields(await jsonBody(c), true));
    return c.json({ ok: true, product });
  }));

  app.get('/api/runs', (c) => c.json({ ok: true, runs: store.listRunSummaries() }));

  app.post('/api/runs', guard(async (c) => {
    const f = runFields(await jsonBody(c), false);
    const run = store.createRun({ vegCutoffAt: null, ...f, status: 'open' } as RunInput);
    log.info(`run created: #${run.id} ${run.town} ${run.deliveryDate}`);
    return c.json({ ok: true, run });
  }));

  app.put('/api/runs/:id', guard(async (c) => {
    const id = intId(c.req.param('id') ?? '');
    if (!id || !store.getRun(id)) return fail(c, 404, 'not_found', 'Run not found.');
    const body = await jsonBody(c);
    const patch = runFields(body, true);
    if ('status' in body) {
      if (!RUN_STATUSES.includes(body.status)) throw new BadRequest(`"status" must be one of ${RUN_STATUSES.join(', ')}.`);
      patch.status = body.status;
    }
    return c.json({ ok: true, run: store.updateRun(id, patch) });
  }));

  app.get('/api/runs/:id/orders', (c) => {
    const id = intId(c.req.param('id') ?? '');
    const run = id ? store.getRun(id) : null;
    if (!run) return fail(c, 404, 'not_found', 'Run not found.');
    return c.json({ ok: true, run, orders: store.listOrders(run.id) });
  });

  /** [{productId, qty}] -> priced OrderItem[] (400 on bad shape or unknown product). */
  const pricedItems = (v: unknown) => {
    if (!Array.isArray(v) || !v.length) throw new BadRequest('"items" must be a non-empty array of { productId, qty }.');
    if (v.length > 100) throw new BadRequest('Too many items (max 100).');
    const lines: ItemInput[] = v.map((it: any, i: number) => {
      const productId = typeof it?.productId === 'string' ? it.productId.trim() : '';
      const qty = it?.qty;
      if (!productId) throw new BadRequest(`items[${i}].productId is required.`);
      if (typeof qty !== 'number' || !Number.isFinite(qty) || qty <= 0 || qty > 1000) {
        throw new BadRequest(`items[${i}].qty must be a number between 0 and 1000.`);
      }
      return { productId, qty };
    });
    const { items, missing } = store.priceItems(lines);
    if (missing.length) throw new BadRequest(`Unknown product: ${missing.join(', ')}`);
    return items;
  };

  app.post('/api/orders', guard(async (c) => {
    const body = await jsonBody(c);
    const runId = typeof body.runId === 'number' && Number.isInteger(body.runId) ? body.runId : 0;
    if (!runId) throw new BadRequest('"runId" is required.');
    if (!store.getRun(runId)) return fail(c, 404, 'not_found', 'Run not found.');
    const customerName = str(body.customerName, 'customerName', 100);
    if (!customerName) throw new BadRequest('"customerName" is required.');
    let phone = '';
    if (body.phone !== undefined && body.phone !== null && body.phone !== '') {
      phone = normPhone(body.phone);
      if (!PHONE_RE.test(phone)) throw new BadRequest('"phone" must be a phone number with country code.');
    }
    const note = body.note === undefined || body.note === null ? '' : str(body.note, 'note', 1000, true);
    const items = pricedItems(body.items);
    const order = store.createOrder({ runId, phone, customerName, items, note, source: 'manual' });
    log.info(`order #${order.id} created manually (run #${runId})`);
    return c.json({ ok: true, order });
  }));

  app.put('/api/orders/:id', guard(async (c) => {
    const id = intId(c.req.param('id') ?? '');
    if (!id || !store.getOrder(id)) return fail(c, 404, 'not_found', 'Order not found.');
    const body = await jsonBody(c);
    const patch: { status?: OrderStatus; paid?: boolean; note?: string; items?: ReturnType<typeof pricedItems> } = {};
    if ('status' in body) {
      if (!ORDER_STATUSES.includes(body.status)) throw new BadRequest(`"status" must be one of ${ORDER_STATUSES.join(', ')}.`);
      patch.status = body.status;
    }
    if ('paid' in body) {
      if (typeof body.paid !== 'boolean') throw new BadRequest('"paid" must be a boolean.');
      patch.paid = body.paid;
    }
    if ('note' in body) patch.note = str(body.note ?? '', 'note', 1000, true);
    if ('items' in body) patch.items = pricedItems(body.items);
    return c.json({ ok: true, order: store.updateOrder(id, patch) });
  }));

  app.post('/api/runs/:id/broadcast', guard(async (c) => {
    const id = intId(c.req.param('id') ?? '');
    const run = id ? store.getRun(id) : null;
    if (!run) return fail(c, 404, 'not_found', 'Run not found.');
    const body = await jsonBody(c);
    const text = typeof body.text === 'string' ? body.text.trim() : '';
    if (!text) throw new BadRequest('"text" is required.');
    if (text.length > MAX_TEXT) throw new BadRequest(`"text" is longer than ${MAX_TEXT} characters.`);
    let sent = 0;
    let skipped = 0;
    let failed = 0;
    const phones = new Set<string>();
    for (const o of store.listOrders(run.id)) {
      if (o.status === 'cancelled') continue;
      if (o.phone) phones.add(o.phone);
      else skipped++;
    }
    for (const phone of phones) {
      if (!store.getConversation(phone)?.windowOpen) {
        skipped++;
        continue;
      }
      const r = await bot.sendText(phone, text);
      if (r.ok) sent++;
      else failed++;
    }
    log.info(`broadcast run #${run.id}: sent=${sent} skipped=${skipped} failed=${failed}`);
    return c.json({ ok: true, sent, skipped, failed });
  }));

  /** Resolves once all in-flight webhook processing is done (tests, shutdown). */
  const idle = async () => {
    while (pending.size) await Promise.allSettled([...pending]);
  };

  return { app, idle };
}
