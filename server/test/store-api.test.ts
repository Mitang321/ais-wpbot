import { test } from 'node:test';
import assert from 'node:assert/strict';
import { setup, login, postWebhook, inboundPayload, RUN } from './helpers.js';

const json = (h: Record<string, string>, method: string, body: unknown) => ({ method, headers: h, body: JSON.stringify(body) });

test('health reports store counts', async () => {
  const { app } = setup({ shop: true });
  const j = (await (await app.request('/health')).json()) as any;
  assert.equal(j.ok, true);
  assert.deepEqual(j.store, { products: 5, runs: 1, orders: 0 });
  assert.equal(j.catalog, undefined);
});

test('CORS allows DELETE', async () => {
  const { app } = setup();
  const pre = await app.request('/api/products', {
    method: 'OPTIONS',
    headers: { Origin: 'http://localhost:5173', 'Access-Control-Request-Method': 'DELETE' },
  });
  assert.match(pre.headers.get('access-control-allow-methods') ?? '', /DELETE/);
});

test('products: list, create with unique slug, update, validation', async () => {
  const { app } = setup({ shop: true });
  const h = await login(app);
  assert.equal((await app.request('/api/products')).status, 401);
  const list = (await (await app.request('/api/products', { headers: h })).json()) as any;
  assert.equal(list.products.length, 5);
  assert.deepEqual(list.products.map((p: any) => p.id).slice(0, 2), ['okra', 'curry-leaves']);

  let r = await app.request('/api/products', json(h, 'POST', { name: 'Okra', category: 'Vegetables', unit: 'kg', priceCents: 500, aliases: [' Bhindi '] }));
  assert.equal(r.status, 200);
  const p = ((await r.json()) as any).product;
  assert.equal(p.id, 'okra-2');
  assert.deepEqual(p.aliases, ['bhindi']);
  assert.equal(p.active, true);
  assert.equal(p.packLabel, null);

  r = await app.request(`/api/products/${p.id}`, json(h, 'PUT', { priceCents: 550, active: false }));
  const u = ((await r.json()) as any).product;
  assert.equal(u.priceCents, 550);
  assert.equal(u.active, false);
  assert.equal(u.name, 'Okra');

  r = await app.request('/api/products', json(h, 'POST', { name: 'X', category: 'Y', unit: 'litre', priceCents: 1 }));
  assert.equal(r.status, 400);
  assert.equal(((await r.json()) as any).error, 'bad_request');
  r = await app.request('/api/products', json(h, 'POST', { name: 'X', category: 'Y', unit: 'kg', priceCents: 1.5 }));
  assert.equal(r.status, 400);
  r = await app.request('/api/products/nope', json(h, 'PUT', { priceCents: 1 }));
  assert.equal(r.status, 404);
});

test('runs: create, list summaries, update, validation', async () => {
  const { app, run } = setup({ shop: true });
  const h = await login(app);
  let r = await app.request('/api/runs', json(h, 'POST', { ...RUN, deliveryDate: '2026-11-20', status: undefined }));
  assert.equal(r.status, 200);
  const created = ((await r.json()) as any).run;
  assert.equal(created.status, 'open');
  assert.equal(created.deliveryDate, '2026-11-20');

  const list = (await (await app.request('/api/runs', { headers: h })).json()) as any;
  assert.deepEqual(list.runs.map((x: any) => x.id), [created.id, run!.id]);
  assert.deepEqual(
    { orderCount: list.runs[1].orderCount, totalCents: list.runs[1].totalCents, paidCents: list.runs[1].paidCents },
    { orderCount: 0, totalCents: 0, paidCents: 0 },
  );

  r = await app.request(`/api/runs/${created.id}`, json(h, 'PUT', { status: 'closed', vegCutoffAt: null }));
  const upd = ((await r.json()) as any).run;
  assert.equal(upd.status, 'closed');
  assert.equal(upd.vegCutoffAt, null);

  r = await app.request('/api/runs', json(h, 'POST', { ...RUN, deliveryDate: '2026-02-30' }));
  assert.equal(r.status, 400);
  r = await app.request(`/api/runs/${created.id}`, json(h, 'PUT', { status: 'done' }));
  assert.equal(r.status, 400);
  assert.equal((await app.request('/api/runs/999', json(h, 'PUT', { town: 'X' }))).status, 404);
  assert.equal((await app.request('/api/runs/999/orders', { headers: h })).status, 404);
});

test('orders: manual create, re-priced update, run summary totals', async () => {
  const { app, run, store } = setup({ shop: true });
  const h = await login(app);
  let r = await app.request('/api/orders', json(h, 'POST', {
    runId: run!.id, customerName: 'Hema', phone: '+33 6 00 00 00 01', items: [{ productId: 'kaju-katli', qty: 2 }, { productId: 'okra', qty: 0.5 }],
  }));
  assert.equal(r.status, 200);
  const o = ((await r.json()) as any).order;
  assert.equal(o.source, 'manual');
  assert.equal(o.status, 'confirmed');
  assert.equal(o.phone, '33600000001');
  assert.equal(o.totalCents, 1200 + 225);
  assert.equal(o.items[1].lineTotalCents, 225);

  store.updateProduct('kaju-katli', { priceCents: 700 });
  r = await app.request(`/api/orders/${o.id}`, json(h, 'PUT', { paid: true, note: 'call first', items: [{ productId: 'kaju-katli', qty: 1 }] }));
  const u = ((await r.json()) as any).order;
  assert.equal(u.totalCents, 700);
  assert.equal(u.paid, true);
  assert.equal(u.note, 'call first');

  const runs = (await (await app.request('/api/runs', { headers: h })).json()) as any;
  assert.deepEqual([runs.runs[0].orderCount, runs.runs[0].totalCents, runs.runs[0].paidCents], [1, 700, 700]);

  await app.request(`/api/orders/${o.id}`, json(h, 'PUT', { status: 'cancelled' }));
  const det = (await (await app.request(`/api/runs/${run!.id}/orders`, { headers: h })).json()) as any;
  assert.equal(det.run.id, run!.id);
  assert.equal(det.orders.length, 1, 'cancelled orders are still listed');
  const runs2 = (await (await app.request('/api/runs', { headers: h })).json()) as any;
  assert.equal(runs2.runs[0].orderCount, 0);

  r = await app.request('/api/orders', json(h, 'POST', { runId: run!.id, customerName: 'X', items: [{ productId: 'nope', qty: 1 }] }));
  assert.equal(r.status, 400);
  r = await app.request('/api/orders', json(h, 'POST', { runId: run!.id, customerName: 'X', items: [] }));
  assert.equal(r.status, 400);
  r = await app.request('/api/orders', json(h, 'POST', { runId: run!.id, customerName: '', items: [{ productId: 'okra', qty: 1 }] }));
  assert.equal(r.status, 400);
  r = await app.request('/api/orders', json(h, 'POST', { runId: 999, customerName: 'X', items: [{ productId: 'okra', qty: 1 }] }));
  assert.equal(r.status, 404);
  r = await app.request(`/api/orders/${o.id}`, json(h, 'PUT', { status: 'lost' }));
  assert.equal(r.status, 400);
  assert.equal((await app.request('/api/orders/999', json(h, 'PUT', { paid: true }))).status, 404);
});

test('broadcast sends to open-window phones only, skips the rest', async () => {
  const { app, idle, run, store, graph } = setup({ shop: true });
  const h = await login(app);
  await postWebhook(app, inboundPayload({ id: 'wamid.BC1', from: '33600000001' }));
  await idle();
  const items = store.priceItems([{ productId: 'okra', qty: 1 }]).items;
  store.createOrder({ runId: run!.id, phone: '33600000001', customerName: 'A', items, source: 'manual' });
  store.createOrder({ runId: run!.id, phone: '33600000002', customerName: 'B', items, source: 'manual' }); // no window
  store.createOrder({ runId: run!.id, phone: '', customerName: 'C', items, source: 'manual' }); // no phone
  const cancelled = store.createOrder({ runId: run!.id, phone: '33600000003', customerName: 'D', items, source: 'manual' });
  store.updateOrder(cancelled.id, { status: 'cancelled' });

  const r = await app.request(`/api/runs/${run!.id}/broadcast`, json(h, 'POST', { text: 'Van arrives at 6pm 🚚' }));
  assert.deepEqual(await r.json(), { ok: true, sent: 1, skipped: 2, failed: 0 });
  assert.equal(graph.calls.length, 1);
  assert.equal(graph.calls[0]!.body.to, '33600000001');
  assert.equal(graph.calls[0]!.body.text.body, 'Van arrives at 6pm 🚚');

  assert.equal((await app.request(`/api/runs/${run!.id}/broadcast`, json(h, 'POST', { text: ' ' }))).status, 400);
  assert.equal((await app.request('/api/runs/999/broadcast', json(h, 'POST', { text: 'x' }))).status, 404);
});
