import { test } from 'node:test';
import assert from 'node:assert/strict';
import { webcrypto } from 'node:crypto';
import { search, toProduct, signWorkerRequest, CatalogClient, tokenize } from '../src/catalog.js';
import { silentLogger } from '../src/log.js';
import { fakeFetch } from './helpers.js';

const P = (id: string, modelNumber: string, extra: Record<string, unknown> = {}) =>
  toProduct('LAPTOP', { id, modelNumber, ...extra } as any)!;

test('search: every token must match; ranked by number of fields hit', () => {
  const products = [
    P('a', 'Vostro 3520', { series: 'Dell Vostro', attrs: [{ k: 'CPU', v: 'i5-1235U' }], rowIndex: 1 }),
    P('b', 'Dell Inspiron 3520', { series: 'Dell Inspiron', sectionTitle: 'Dell i5 Laptops', attrs: [{ k: 'CPU', v: 'i5-1235U' }], rowIndex: 2 }),
    P('c', 'Dell Latitude 3440', { series: 'Latitude', attrs: [{ k: 'CPU', v: 'i3-1215U' }], rowIndex: 3 }),
    P('d', 'HP 250 G9', { partNo: '6Q8M8PA', attrs: [{ k: 'CPU', v: 'i5-1235U' }], rowIndex: 4 }),
  ];
  assert.deepEqual(search(products, 'dell i5').map((p) => p.id), ['b', 'a']);
  assert.deepEqual(search(products, 'DELL').map((p) => p.id), ['b', 'c', 'a']);
  assert.deepEqual(search(products, '6q8m8pa').map((p) => p.id), ['d']);
  assert.deepEqual(search(products, 'dell i7'), []);
  assert.deepEqual(search(products, '   '), []);
  assert.equal(search(products, 'u', 3).length, 3);
  assert.deepEqual(tokenize(' HP  i5, hp '), ['hp', 'i5']);
});

test('signWorkerRequest = lowercase hex HMAC-SHA256(secret, "<ts>.<body>") and verifies like the worker', async () => {
  const secret = 'shh';
  const ts = '1761200000000';
  const body = '{"action":"bot_catalog"}';
  const sig = signWorkerRequest(secret, ts, body);
  assert.match(sig, /^[0-9a-f]{64}$/);
  // Same check the worker does (WebCrypto verify over "<ts>.<raw body>").
  const key = await webcrypto.subtle.importKey('raw', new TextEncoder().encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['verify']);
  const ok = await webcrypto.subtle.verify('HMAC', key, Buffer.from(sig, 'hex'), new TextEncoder().encode(`${ts}.${body}`));
  assert.equal(ok, true);
});

test('CatalogClient: signed requests, loads categories, skips 404, keeps old catalog on failure', async () => {
  let down = false;
  const worker = fakeFetch((c) => {
    if (down) return { status: 500, json: { ok: false } };
    if (!c.body.category) return { json: { ok: true, categories: ['LAPTOP', 'DESKTOP'] } };
    if (c.body.category === 'DESKTOP') return { status: 404, json: { ok: false } };
    return { json: { category: 'LAPTOP', version: 1, products: [{ id: 'p1', modelNumber: 'X1', attrs: [], rowIndex: 1, updatedAt: 1 }] } };
  });
  const now = 1761200000000;
  const client = new CatalogClient({ workerUrl: 'https://worker.test', secret: 'shh', log: silentLogger, fetch: worker.fetch, now: () => now });
  await client.refresh();
  assert.equal(client.snapshot.products.length, 1);
  assert.deepEqual(client.snapshot.categories, ['LAPTOP']);
  assert.ok(client.snapshot.loadedAt);
  assert.equal(worker.calls.length, 3);
  assert.deepEqual(worker.calls[1]!.body, { action: 'bot_catalog', category: 'LAPTOP' });

  const first = worker.calls[0]!;
  const h = first.init.headers as Record<string, string>;
  assert.equal(first.url, 'https://worker.test');
  assert.equal(first.init.method, 'POST');
  assert.equal(String(first.init.body), '{"action":"bot_catalog"}');
  assert.equal(h['x-bot-timestamp'], String(now));
  assert.equal(h['x-bot-signature'], signWorkerRequest('shh', String(now), '{"action":"bot_catalog"}'));

  down = true;
  await client.refresh();
  assert.equal(client.snapshot.products.length, 1, 'old catalog kept');
});

test('CatalogClient without WORKER_URL stays empty', async () => {
  const client = new CatalogClient({ workerUrl: null, secret: null, log: silentLogger });
  await client.refresh();
  assert.equal(client.snapshot.products.length, 0);
  assert.equal(client.enabled, false);
});
