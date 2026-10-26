import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseOrder, parseOrderRules, type ParseResult } from '../src/parser.js';
import { SEED_PRODUCTS, DEMO_ORDERS, demoRun } from '../src/seed.js';
import type { Logger } from '../src/log.js';

const P = SEED_PRODUCTS;
const simple = (r: ParseResult) => r.lines.map((l) => [l.productId, l.qty]);
const rules = (t: string) => parseOrderRules(t, P);

test('seed: unique ids, valid demo orders and run', () => {
  const ids = P.map((p) => p.id);
  assert.equal(new Set(ids).size, ids.length);
  assert.ok(P.length >= 40);
  for (const p of P) {
    assert.match(p.id, /^[a-z0-9]+(-[a-z0-9]+)*$/);
    assert.ok(p.priceCents > 0 && Number.isInteger(p.priceCents));
    assert.ok(p.aliases.every((a) => a === a.toLowerCase()));
  }
  for (const o of DEMO_ORDERS) for (const it of o.items) assert.ok(ids.includes(it.productId), it.productId);
  const run = demoRun();
  assert.equal(new Date(run.cutoffAt).toISOString(), '2026-11-05T17:00:00.000Z');
  assert.equal(new Date(run.vegCutoffAt!).toISOString(), '2026-10-31T17:00:00.000Z');
});

test('real messages', () => {
  assert.deepEqual(simple(rules('1 pack broken basmati Rice (20Kg)')), [['broken-basmati-20kg', 1]]);
  assert.deepEqual(simple(rules('Ashirwad Atta ( No multi grain)  5 kg.')), [['aashirvaad-atta-5kg', 1]]);
  assert.deepEqual(simple(rules('Kaju katli        250g')), [['kaju-katli-250g', 1]]);
  const r = rules('kaju katli 500g, okra 1kg, curry leaves');
  assert.deepEqual(simple(r), [['kaju-katli-250g', 2], ['okra', 1], ['curry-leaves', 1]]);
  assert.deepEqual(r.unmatched, []);
  assert.deepEqual(simple(rules('2kg bhindi and 1 karela')), [['okra', 2], ['bitter-gourd', 1]]);
});

test('pack size chosen from stated weight', () => {
  assert.deepEqual(simple(rules('atta 10kg')), [['aashirvaad-atta-10kg', 1]]);
  assert.deepEqual(simple(rules('aashirvaad atta 20 kg')), [['aashirvaad-atta-10kg', 2]]);
  assert.deepEqual(simple(rules('basmati rice 5kg')), [['basmati-5kg', 1]]);
  assert.deepEqual(simple(rules('2 x 250g kaju katli')), [['kaju-katli-250g', 2]]);
});

test('quantities: decimals, fractions, words, grams for kg products', () => {
  assert.deepEqual(simple(rules('okra 500g')), [['okra', 0.5]]);
  assert.deepEqual(simple(rules('1,5 kg dudhi')), [['dudhi', 1.5]]);
  assert.deepEqual(simple(rules('1.5kg lauki')), [['dudhi', 1.5]]);
  assert.deepEqual(simple(rules('1/2 kg karela')), [['bitter-gourd', 0.5]]);
  assert.deepEqual(simple(rules('half kg mirchi')), [['green-chilli', 0.5]]);
  assert.deepEqual(simple(rules('two packets toor dal')), [['toor-dal-1kg', 2]]);
  assert.deepEqual(simple(rules('do paneer')), [['paneer-200g', 2]]);
  assert.deepEqual(simple(rules('3 bunch curry leaves')), [['curry-leaves', 3]]);
  assert.deepEqual(simple(rules('maggi x2')), [['maggi-12', 2]]);
});

test('typos and Hindi/Gujarati aliases', () => {
  assert.deepEqual(simple(rules('1kg tendly')), [['tendli', 1]]);
  assert.deepEqual(simple(rules('drumstik 1 kg')), [['drumsticks', 1]]);
  assert.deepEqual(simple(rules('saragva 2kg')), [['drumsticks', 2]]);
  assert.deepEqual(simple(rules('ringan 1kg, gavar 500 gm, valor papdi 1 kg, arbi')), [
    ['brinjal', 1], ['cluster-beans', 0.5], ['flat-beans', 1], ['taro', 1],
  ]);
  assert.deepEqual(simple(rules('lasun 250 g; haldi; jeera')), [['indian-garlic', 0.3], ['turmeric-200g', 1], ['jeera-200g', 1]]);
  assert.deepEqual(simple(rules('tuvar dal 2, moong dal 1, gulab jamun')), [
    ['toor-dal-1kg', 2], ['moong-dal-1kg', 1], ['gulab-jamun-1kg', 1],
  ]);
  assert.deepEqual(simple(rules('drumstick leaves')), [['drumstick-leaves', 1]]);
  assert.deepEqual(simple(rules('chana masala, chana dal, kabuli chana')), [
    ['mdh-chana-masala', 1], ['chana-dal-1kg', 1], ['kabuli-chana-1kg', 1],
  ]);
  assert.deepEqual(simple(rules('soan papdi')), [['soan-papdi-250g', 1]]);
});

test('unmatched, greetings, Order Name lines, duplicates', () => {
  const r = rules('Hi\nOrder Name: Tapan\n1 pack broken basmati rice (20kg)\nwhisky 1 bottle\nthanks');
  assert.deepEqual(simple(r), [['broken-basmati-20kg', 1]]);
  assert.deepEqual(r.unmatched, ['whisky 1 bottle']);
  assert.equal(r.engine, 'rules');
  const d = rules('okra 1kg\nbhindi 500g');
  assert.deepEqual(simple(d), [['okra', 1.5]]);
  assert.deepEqual(rules('').lines, []);
  assert.deepEqual(rules('hello').unmatched, []);
});

// ---------- Gemini path ----------

function fake(respond: () => { status?: number; json: unknown }) {
  const calls: Array<{ url: string; init: RequestInit }> = [];
  const f = (async (url: any, init: RequestInit = {}) => {
    calls.push({ url: String(url), init });
    const r = respond();
    return new Response(JSON.stringify(r.json), { status: r.status ?? 200, headers: { 'content-type': 'application/json' } });
  }) as typeof fetch;
  return { f, calls };
}
function captureLog() {
  const warns: string[] = [];
  const log: Logger = { info() {}, warn: (m) => warns.push(m), error: (m) => warns.push(m) };
  return { log, warns };
}
const gem = (obj: unknown) => ({ json: { candidates: [{ content: { parts: [{ text: JSON.stringify(obj) }] } }] } });
const KEY = 'test-key-123';

test('gemini: valid response is used, normalized and summed', async () => {
  const { f, calls } = fake(() => gem({
    lines: [
      { productId: 'okra', qty: 1.04, raw: 'bhindi 1kg' },
      { productId: 'okra', qty: 0.5, raw: 'okra 500g' },
      { productId: 'kaju-katli-250g', qty: 2.2, raw: 'kaju 500g' },
    ],
    unmatched: ['whisky'],
  }));
  const { log, warns } = captureLog();
  const r = await parseOrder('bhindi 1kg, okra 500g, kaju 500g, whisky', P, { geminiApiKey: KEY, geminiModel: 'gemini-2.5-flash-lite', log, fetch: f });
  assert.equal(r.engine, 'gemini');
  assert.deepEqual(simple(r), [['okra', 1.5], ['kaju-katli-250g', 2]]);
  assert.deepEqual(r.unmatched, ['whisky']);
  assert.equal(calls.length, 1);
  assert.equal(calls[0]!.url, 'https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash-lite:generateContent');
  assert.equal((calls[0]!.init.headers as Record<string, string>)['x-goog-api-key'], KEY);
  const body = JSON.parse(String(calls[0]!.init.body));
  assert.equal(body.generationConfig.responseMimeType, 'application/json');
  assert.equal(body.generationConfig.temperature, 0);
  assert.deepEqual(warns, []);
});

test('gemini: invalid productId falls back to rules', async () => {
  const { f } = fake(() => gem({ lines: [{ productId: 'nope', qty: 1, raw: 'x' }], unmatched: [] }));
  const { log, warns } = captureLog();
  const r = await parseOrder('2kg bhindi and 1 karela', P, { geminiApiKey: KEY, geminiModel: 'm', log, fetch: f });
  assert.equal(r.engine, 'rules');
  assert.deepEqual(simple(r), [['okra', 2], ['bitter-gourd', 1]]);
  assert.equal(warns.length, 1);
  assert.ok(!warns[0]!.includes(KEY));
});

test('gemini: HTTP error, bad JSON, thrown fetch and empty lines fall back to rules', async () => {
  const opts = (f: typeof fetch) => ({ geminiApiKey: KEY, geminiModel: 'm', log: captureLog().log, fetch: f });
  const http = await parseOrder('kaju katli 500g', P, opts(fake(() => ({ status: 500, json: { error: 'x' } })).f));
  assert.equal(http.engine, 'rules');
  assert.deepEqual(simple(http), [['kaju-katli-250g', 2]]);
  const bad = await parseOrder('kaju katli 500g', P, opts(fake(() => ({ json: { candidates: [{ content: { parts: [{ text: 'not json' }] } }] } })).f));
  assert.equal(bad.engine, 'rules');
  const thrown = await parseOrder('kaju katli 500g', P, opts((async () => { throw new Error('network down'); }) as typeof fetch));
  assert.equal(thrown.engine, 'rules');
  const empty = await parseOrder('kaju katli 500g', P, opts(fake(() => gem({ lines: [], unmatched: [] })).f));
  assert.equal(empty.engine, 'rules');
  assert.deepEqual(simple(empty), [['kaju-katli-250g', 2]]);
});

test('no key: rules only, no fetch', async () => {
  const { f, calls } = fake(() => gem({ lines: [], unmatched: [] }));
  const r = await parseOrder('okra 1kg', P, { geminiApiKey: null, geminiModel: 'm', log: captureLog().log, fetch: f });
  assert.equal(r.engine, 'rules');
  assert.equal(calls.length, 0);
  assert.deepEqual(simple(r), [['okra', 1]]);
});
