import { test } from 'node:test';
import assert from 'node:assert/strict';
import { setup, postWebhook, inboundPayload, statusPayload, sign } from './helpers.js';

test('GET /webhook returns the challenge for the right verify token, 403 otherwise', async () => {
  const { app } = setup();
  const ok = await app.request('/webhook?hub.mode=subscribe&hub.verify_token=verify-me&hub.challenge=12345');
  assert.equal(ok.status, 200);
  assert.equal(await ok.text(), '12345');
  const bad = await app.request('/webhook?hub.mode=subscribe&hub.verify_token=nope&hub.challenge=12345');
  assert.equal(bad.status, 403);
});

test('POST /webhook accepts a valid signature and rejects bad/missing/tampered ones', async () => {
  const { app, idle, store } = setup();
  const payload = inboundPayload({ id: 'wamid.A1' });
  const body = JSON.stringify(payload);

  assert.equal((await postWebhook(app, payload)).status, 200);

  assert.equal((await postWebhook(app, payload, sign(body, 'wrong-secret'))).status, 401);
  assert.equal((await postWebhook(app, payload, 'sha256=deadbeef')).status, 401);
  const missing = await app.request('/webhook', { method: 'POST', body, headers: { 'content-type': 'application/json' } });
  assert.equal(missing.status, 401);
  // Signature of the original body, but a different body.
  const tampered = await app.request('/webhook', {
    method: 'POST',
    body: body.replace('hello', 'HELLO'),
    headers: { 'content-type': 'application/json', 'x-hub-signature-256': sign(body) },
  });
  assert.equal(tampered.status, 401);
  const err = (await tampered.json()) as any;
  assert.equal(err.ok, false);
  assert.equal(err.error, 'bad_signature');

  await idle();
  assert.equal(store.getMessages('919812345678').length, 1);
});

test('inbound text is stored with contact name, unread and window; Meta retries are deduped', async () => {
  const { app, idle, store } = setup();
  const payload = inboundPayload({ id: 'wamid.B1', text: 'hp i5', name: 'Ravi Kumar' });
  await postWebhook(app, payload);
  await postWebhook(app, payload); // retry
  await idle();

  const msgs = store.getMessages('919812345678');
  assert.equal(msgs.length, 1);
  const m = msgs[0]!;
  assert.deepEqual(
    { id: m.id, direction: m.direction, type: m.type, text: m.text, status: m.status, auto: m.auto },
    { id: 'wamid.B1', direction: 'in', type: 'text', text: 'hp i5', status: 'received', auto: false },
  );
  const conv = store.getConversation('919812345678')!;
  assert.equal(conv.name, 'Ravi Kumar');
  assert.equal(conv.unread, 1);
  assert.equal(conv.windowOpen, true);
  assert.equal(conv.lastMessagePreview, 'hp i5');
  assert.equal(conv.lastInboundAt, m.ts);
});

test('image, interactive and other types get placeholder text', async () => {
  const { app, idle, store } = setup();
  await postWebhook(app, inboundPayload({ id: 'wamid.I1', type: 'image', extra: { image: { id: 'media1', caption: 'this one?' } } }));
  await postWebhook(app, inboundPayload({ id: 'wamid.I2', type: 'interactive', extra: { interactive: { type: 'button_reply', button_reply: { id: 'b1', title: 'Yes' } } } }));
  await postWebhook(app, inboundPayload({ id: 'wamid.I3', type: 'sticker', extra: { sticker: { id: 's1' } } }));
  await idle();
  const byId = Object.fromEntries(store.getMessages('919812345678').map((m) => [m.id, m]));
  assert.equal(byId['wamid.I1']!.type, 'image');
  assert.equal(byId['wamid.I1']!.text, '[image] this one?');
  assert.equal(byId['wamid.I2']!.type, 'interactive');
  assert.equal(byId['wamid.I2']!.text, 'Yes');
  assert.equal(byId['wamid.I3']!.type, 'other');
  assert.equal(byId['wamid.I3']!.text, '[sticker]');
});

test('status updates: sent -> delivered -> read, never downgraded; failed stores the error', async () => {
  const { app, idle, store } = setup();
  const base = { phone: '919812345678', direction: 'out' as const, type: 'text' as const, text: 'hi', auto: false, ts: Date.now() };
  store.addMessage({ ...base, id: 'wamid.S1', status: 'sent' });
  store.addMessage({ ...base, id: 'wamid.S2', status: 'sent' });

  await postWebhook(app, statusPayload('wamid.S1', 'delivered'));
  await idle();
  assert.equal(store.getMessage('wamid.S1')!.status, 'delivered');
  await postWebhook(app, statusPayload('wamid.S1', 'read'));
  await idle();
  await postWebhook(app, statusPayload('wamid.S1', 'delivered')); // late, out of order
  await idle();
  assert.equal(store.getMessage('wamid.S1')!.status, 'read');

  await postWebhook(
    app,
    statusPayload('wamid.S2', 'failed', [
      { code: 131047, title: 'Re-engagement message', message: 'Re-engagement message', error_data: { details: 'More than 24 hours have passed.' } },
    ]),
  );
  await idle();
  const failed = store.getMessage('wamid.S2')!;
  assert.equal(failed.status, 'failed');
  assert.match(failed.error!, /Re-engagement message/);
  assert.match(failed.error!, /More than 24 hours/);

  // Unknown ids are ignored without errors.
  assert.equal((await postWebhook(app, statusPayload('wamid.UNKNOWN', 'read'))).status, 200);
  await idle();
});
