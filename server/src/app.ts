/** HTTP routes (CONTRACT §1). Built as a factory so tests can inject fakes. */
import { Hono, type Context } from 'hono';
import { cors } from 'hono/cors';
import type { ContentfulStatusCode } from 'hono/utils/http-status';
import { getConnInfo } from '@hono/node-server/conninfo';
import type { Config } from './config.js';
import type { Store } from './db.js';
import type { CatalogClient } from './catalog.js';
import type { Bot } from './bot.js';
import { issueToken, verifyToken, safeEqual, RateLimiter } from './auth.js';
import { verifyMetaSignature } from './whatsapp.js';
import { errMsg, type Logger } from './log.js';
import type { Conversation, Settings } from './types.js';

export interface AppDeps {
  config: Config;
  store: Store;
  catalog: CatalogClient;
  bot: Bot;
  log: Logger;
  startedAt?: number;
}

const MAX_WEBHOOK_BYTES = 1024 * 1024;
const MAX_TEXT = 4096;
const PHONE_RE = /^\d{8,15}$/;

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
  const { config, store, catalog, bot, log } = deps;
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
    const snap = catalog.snapshot;
    return c.json({
      ok: true,
      uptimeSec: Math.round((Date.now() - startedAt) / 1000),
      rssMb: Math.round((process.memoryUsage.rss() / 1024 / 1024) * 10) / 10,
      catalog: { products: snap.products.length, categories: snap.categories.length, loadedAt: snap.loadedAt },
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
      origin: (origin) => (origins.has(origin) ? origin : null),
      allowMethods: ['GET', 'POST', 'PUT', 'OPTIONS'],
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

  /** Resolves once all in-flight webhook processing is done (tests, shutdown). */
  const idle = async () => {
    while (pending.size) await Promise.allSettled([...pending]);
  };

  return { app, idle };
}
