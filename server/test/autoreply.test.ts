import { test } from 'node:test';
import assert from 'node:assert/strict';
import { setup, postWebhook, inboundPayload } from './helpers.js';

const PHONE = '919812345678';
const products = [
  {
    id: 'p1',
    modelNumber: 'HP 15s-fq5111TU',
    series: 'HP 15s',
    sectionTitle: 'HP Laptops',
    attrs: [
      { k: 'CPU', v: 'Intel Core i5-1235U' },
      { k: 'RAM', v: '8GB' },
      { k: 'SSD', v: '512GB' },
      { k: 'Warranty', v: '1 year' },
    ],
    rowIndex: 1,
  },
  { id: 'p2', modelNumber: 'Dell Vostro 3520', series: 'Vostro', attrs: [{ k: 'CPU', v: 'Intel Core i3-1215U' }], rowIndex: 2 },
];

test('auto-reply is off by default, and never replies to senders outside allowedPhones', async () => {
  const { app, idle, graph, store } = setup({ products });
  await postWebhook(app, inboundPayload({ id: 'wamid.X1', text: 'hi' }));
  await idle();
  assert.equal(graph.calls.length, 0);
  store.saveSettings({ autoReply: true, allowedPhones: ['911111111111'] });
  await postWebhook(app, inboundPayload({ id: 'wamid.X2', text: 'hi' }));
  await idle();
  assert.equal(graph.calls.length, 0);
  assert.equal(store.getMessages(PHONE).length, 2, 'still stored for the inbox');
});

test('greeting lists categories; search replies top results with link; retries do not double-reply', async () => {
  const { app, idle, graph, store } = setup({ products });
  store.saveSettings({ autoReply: true, allowedPhones: [PHONE] });

  await postWebhook(app, inboundPayload({ id: 'wamid.G1', text: 'Hello!' }));
  await idle();
  assert.equal(graph.calls.length, 1);
  const greet = graph.calls[0]!.body.text.body as string;
  assert.match(greet, /LAPTOP/);
  assert.match(greet, /type a model to search/i);

  const p = inboundPayload({ id: 'wamid.G2', text: 'hp i5' });
  await postWebhook(app, p);
  await postWebhook(app, p);
  await idle();
  assert.equal(graph.calls.length, 2);
  const reply = graph.calls[1]!.body.text.body as string;
  assert.equal(
    reply,
    '*HP 15s-fq5111TU*  (LAPTOP)\nCPU: Intel Core i5-1235U\nRAM: 8GB\nSSD: 512GB\nhttps://ais.mitangs.tech/product/p1',
  );

  const out = store.getMessages(PHONE).filter((m) => m.direction === 'out');
  assert.equal(out.length, 2);
  assert.ok(out.every((m) => m.auto && m.status === 'sent'));

  await postWebhook(app, inboundPayload({ id: 'wamid.G3', text: 'macbook' }));
  await idle();
  assert.equal(graph.calls[2]!.body.text.body, 'No match for "macbook". Try a model number, or type *menu*.');
});
