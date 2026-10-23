import { test } from 'node:test';
import assert from 'node:assert/strict';
import { setup, postWebhook, inboundPayload, login, PASSWORD } from './helpers.js';
import { issueToken, verifyToken } from '../src/auth.js';

const PHONE = '919812345678';
const loginReq = (password: string, ip: string) => ({
  method: 'POST',
  headers: { 'content-type': 'application/json', 'x-forwarded-for': ip },
  body: JSON.stringify({ password }),
});

test('login issues a 12h token; wrong password is 401; rate limited after 10/min', async () => {
  const { app } = setup();
  const res = await app.request('/api/login', loginReq(PASSWORD, '1.1.1.1'));
  assert.equal(res.status, 200);
  const j = (await res.json()) as any;
  assert.equal(j.ok, true);
  assert.match(j.token, /^\d+\.[0-9a-f]{64}$/);
  assert.ok(Math.abs(j.expiresAt - (Date.now() + 12 * 3600_000)) < 5000);

  const bad = await app.request('/api/login', loginReq('nope', '2.2.2.2'));
  assert.equal(bad.status, 401);
  assert.equal(((await bad.json()) as any).ok, false);

  let last = 0;
  for (let i = 0; i < 10; i++) last = (await app.request('/api/login', loginReq('nope', '3.3.3.3'))).status;
  assert.equal(last, 401);
  assert.equal((await app.request('/api/login', loginReq(PASSWORD, '3.3.3.3'))).status, 429);
  // Other IPs are unaffected.
  assert.equal((await app.request('/api/login', loginReq(PASSWORD, '4.4.4.4'))).status, 200);
});

test('auth guard: /api/* needs a valid, unexpired, correctly signed token', async () => {
  const { app } = setup();
  assert.equal((await app.request('/api/conversations')).status, 401);
  assert.equal((await app.request('/api/conversations', { headers: { Authorization: 'Bearer garbage' } })).status, 401);
  const expired = issueToken('sess-secret', Date.now() - 13 * 3600_000).token;
  assert.equal((await app.request('/api/conversations', { headers: { Authorization: `Bearer ${expired}` } })).status, 401);
  const forged = issueToken('other-secret').token;
  assert.equal(verifyToken('sess-secret', forged), false);
  assert.equal((await app.request('/api/conversations', { headers: { Authorization: `Bearer ${forged}` } })).status, 401);
  const h = await login(app);
  const ok = await app.request('/api/conversations', { headers: h });
  assert.equal(ok.status, 200);
  assert.deepEqual(await ok.json(), { ok: true, conversations: [] });
  // health stays public
  assert.equal((await app.request('/health')).status, 200);
});

test('CORS allows only DASHBOARD_ORIGIN', async () => {
  const { app } = setup();
  const pre = await app.request('/api/send', {
    method: 'OPTIONS',
    headers: { Origin: 'http://localhost:5173', 'Access-Control-Request-Method': 'POST' },
  });
  assert.equal(pre.headers.get('access-control-allow-origin'), 'http://localhost:5173');
  const evil = await app.request('/api/send', {
    method: 'OPTIONS',
    headers: { Origin: 'https://evil.example', 'Access-Control-Request-Method': 'POST' },
  });
  assert.equal(evil.headers.get('access-control-allow-origin'), null);
});

test('conversations list + detail (marks read)', async () => {
  const { app, idle } = setup();
  await postWebhook(app, inboundPayload({ id: 'wamid.C1', text: 'one' }));
  await postWebhook(app, inboundPayload({ id: 'wamid.C2', text: 'two', from: '447700900123', name: 'Sam' }));
  await idle();
  const h = await login(app);
  const list = (await (await app.request('/api/conversations', { headers: h })).json()) as any;
  assert.equal(list.conversations.length, 2);
  const c = list.conversations.find((x: any) => x.phone === PHONE);
  assert.deepEqual(Object.keys(c).sort(), [
    'allowed', 'lastInboundAt', 'lastMessageAt', 'lastMessagePreview', 'name', 'phone', 'unread', 'windowOpen',
  ]);
  assert.equal(c.unread, 1);

  const det = (await (await app.request(`/api/conversations/${PHONE}`, { headers: h })).json()) as any;
  assert.equal(det.ok, true);
  assert.equal(det.contact.phone, PHONE);
  assert.equal(det.messages.length, 1);
  assert.equal(det.messages[0].text, 'one');
  const after = (await (await app.request('/api/conversations', { headers: h })).json()) as any;
  assert.equal(after.conversations.find((x: any) => x.phone === PHONE).unread, 0);

  const before = (await (await app.request(`/api/conversations/${PHONE}?before=${det.messages[0].ts}`, { headers: h })).json()) as any;
  assert.deepEqual(before.messages, []);

  const empty = (await (await app.request('/api/conversations/911111111111', { headers: h })).json()) as any;
  assert.equal(empty.ok, true);
  assert.deepEqual(empty.messages, []);
  assert.equal(empty.contact.windowOpen, false);
});

test('send: 409 window_closed without a recent inbound message', async () => {
  const { app, idle, graph } = setup();
  const h = await login(app);
  let r = await app.request('/api/send', { method: 'POST', headers: h, body: JSON.stringify({ to: PHONE, text: 'hi' }) });
  assert.equal(r.status, 409);
  assert.equal(((await r.json()) as any).error, 'window_closed');

  await postWebhook(app, inboundPayload({ id: 'wamid.OLD', ts: Date.now() - 25 * 3600_000 }));
  await idle();
  r = await app.request('/api/send', { method: 'POST', headers: h, body: JSON.stringify({ to: PHONE, text: 'hi' }) });
  assert.equal(r.status, 409);
  assert.equal(graph.calls.length, 0);
});

test('send inside the window calls Graph and stores the outbound message', async () => {
  const { app, idle, graph, store } = setup();
  await postWebhook(app, inboundPayload({ id: 'wamid.IN1' }));
  await idle();
  const h = await login(app);
  const r = await app.request('/api/send', { method: 'POST', headers: h, body: JSON.stringify({ to: `+${PHONE}`, text: 'Hello Ravi' }) });
  assert.equal(r.status, 200);
  const j = (await r.json()) as any;
  assert.equal(j.message.direction, 'out');
  assert.equal(j.message.status, 'sent');
  assert.equal(j.message.auto, false);
  assert.match(j.message.id, /^wamid\.OUT/);
  assert.equal(graph.calls.length, 1);
  const call = graph.calls[0]!;
  assert.equal(call.url, 'https://graph.facebook.com/v23.0/12345/messages');
  assert.equal((call.init.headers as any).authorization, 'Bearer tok');
  assert.equal(call.body.messaging_product, 'whatsapp');
  assert.equal(call.body.to, PHONE);
  assert.deepEqual(call.body.text, { body: 'Hello Ravi', preview_url: true });
  assert.equal(store.getMessages(PHONE).length, 2);
});

test('Graph error -> 502 with the Meta message, stored as failed', async () => {
  const { app, idle, store } = setup({
    graph: () => ({
      status: 400,
      json: { error: { message: '(#131030) Recipient phone number not in allowed list', type: 'OAuthException', code: 131030 } },
    }),
  });
  await postWebhook(app, inboundPayload({ id: 'wamid.IN2' }));
  await idle();
  const h = await login(app);
  const r = await app.request('/api/send', { method: 'POST', headers: h, body: JSON.stringify({ to: PHONE, text: 'x' }) });
  assert.equal(r.status, 502);
  const j = (await r.json()) as any;
  assert.equal(j.ok, false);
  assert.equal(j.error, 'send_failed');
  assert.match(j.message, /Recipient phone number not in allowed list/);
  const out = store.getMessages(PHONE).find((m) => m.direction === 'out')!;
  assert.equal(out.status, 'failed');
  assert.match(out.error!, /not in allowed list/);
  assert.match(out.id, /^local-/);
});

test('send-template works without a window and defaults language to en_US', async () => {
  const { app, graph, store } = setup();
  const h = await login(app);
  const r = await app.request('/api/send-template', { method: 'POST', headers: h, body: JSON.stringify({ to: PHONE, template: 'hello_world' }) });
  assert.equal(r.status, 200);
  const j = (await r.json()) as any;
  assert.equal(j.message.type, 'template');
  assert.equal(j.message.text, 'hello_world');
  assert.deepEqual(graph.calls[0]!.body.template, { name: 'hello_world', language: { code: 'en_US' } });
  assert.equal(store.getConversation(PHONE)!.windowOpen, false);
});

test('settings: defaults, partial update, validation', async () => {
  const { app } = setup();
  const h = await login(app);
  assert.deepEqual(await (await app.request('/api/settings', { headers: h })).json(), {
    ok: true,
    settings: { autoReply: false, allowedPhones: [] },
  });
  let r = await app.request('/api/settings', { method: 'PUT', headers: h, body: JSON.stringify({ autoReply: true }) });
  assert.deepEqual(await r.json(), { ok: true, settings: { autoReply: true, allowedPhones: [] } });
  r = await app.request('/api/settings', { method: 'PUT', headers: h, body: JSON.stringify({ allowedPhones: ['+91 98123 45678', PHONE] }) });
  assert.deepEqual(await r.json(), { ok: true, settings: { autoReply: true, allowedPhones: [PHONE] } });
  r = await app.request('/api/settings', { method: 'PUT', headers: h, body: JSON.stringify({ autoReply: 'yes' }) });
  assert.equal(r.status, 400);
  r = await app.request('/api/settings', { method: 'PUT', headers: h, body: JSON.stringify({ allowedPhones: ['abc'] }) });
  assert.equal(r.status, 400);
});
