import { test } from 'node:test';
import assert from 'node:assert/strict';
import { setup, postWebhook, inboundPayload, NOW } from './helpers.js';
import { formatCutoff, formatDay, itemLine, euros, labelSuffix } from '../src/bot.js';
import { Store } from '../src/db.js';
import { SEED_PRODUCTS, DEMO_ORDERS } from '../src/seed.js';

const PHONE = '919812345678';
let seq = 0;

/** A shop bot with a fixed clock; `say` sends one inbound message and returns the Graph bodies it produced. */
function shop(now = NOW) {
  const s = setup({ bot: true, shop: true, now: () => now });
  const say = async (text: string, opts: { buttonId?: string; from?: string } = {}) => {
    const before = s.graph.calls.length;
    const id = `wamid.T${++seq}`;
    const payload = opts.buttonId
      ? inboundPayload({ id, from: opts.from, type: 'interactive', ts: now, extra: { interactive: { type: 'button_reply', button_reply: { id: opts.buttonId, title: text } } } })
      : inboundPayload({ id, from: opts.from, text, ts: now });
    await postWebhook(s.app, payload);
    await s.idle();
    return s.graph.calls.slice(before).map((c) => c.body).filter((b) => b?.status !== 'read');
  };
  const textOf = (b: any) => (b.type === 'interactive' ? b.interactive.body.text : b.text.body) as string;
  return { ...s, say, textOf };
}

test('date and money formatting', () => {
  assert.equal(formatDay('2026-11-06'), 'Friday 6 November');
  assert.equal(formatCutoff(Date.UTC(2026, 9, 31, 17)), 'Sat 31 Oct, 6pm');
  assert.equal(formatCutoff(Date.UTC(2026, 9, 20, 7, 30)), 'Tue 20 Oct, 9:30am'); // CEST (UTC+2)
  assert.equal(euros(1200), '€12.00');
  const base = { productId: 'x', category: 'c', unitPriceCents: 0 };
  assert.equal(itemLine({ ...base, name: 'Okra', qty: 0.5, unit: 'kg', packLabel: null, lineTotalCents: 225 }), '0.5 kg Okra — €2.25');
  assert.equal(
    itemLine({ ...base, name: 'Kaju katli', qty: 2, unit: 'pack', packLabel: '250 g box', lineTotalCents: 1200 }),
    '2 × Kaju katli (250 g box) — €12.00',
  );
  assert.equal(labelSuffix('Kaju katli 250 g', '250 g box'), '');
  assert.equal(labelSuffix('Coconut', '1 pc'), '');
  assert.equal(labelSuffix('Parle-G', 'family pack'), ' (family pack)');
});

test('reply gating: autoReply off -> silent; allowedPhones non-empty -> only those', async () => {
  const s = shop();
  s.store.saveSettings({ autoReply: false, allowedPhones: [] });
  assert.equal((await s.say('hi')).length, 0);
  s.store.saveSettings({ autoReply: true, allowedPhones: ['911111111111'] });
  assert.equal((await s.say('hi')).length, 0);
  s.store.saveSettings({ autoReply: true, allowedPhones: [PHONE] });
  assert.equal((await s.say('hi')).length, 1);
  s.store.saveSettings({ autoReply: true, allowedPhones: [] });
  assert.equal((await s.say('hi')).length, 1);
});

test('greeting shows store, run, cutoffs and how to order', async () => {
  const s = shop();
  const [b] = await s.say('Namaste!');
  const t = s.textOf(b);
  assert.match(t, /Indian Store Marseille/);
  assert.match(t, /Manosque/);
  assert.match(t, /Friday 6 November, evening, around 6pm/);
  assert.match(t, /School parking/);
  assert.match(t, /Vegetables: order before Sat 31 Oct, 6pm/);
  assert.match(t, /Everything else: before Thu 5 Nov, 6pm/);
  assert.match(t, /\*list\*/);
  assert.match(t, /\*my order\*/);
  assert.match(t, /\*cancel\*/);
});

test('greeting with no active run says no delivery', async () => {
  const s = shop();
  s.store.updateRun(s.run!.id, { status: 'closed' });
  const [b] = await s.say('hello');
  assert.match(s.textOf(b), /No delivery scheduled right now/);
});

test('list shows active products grouped, with prices; inactive hidden', async () => {
  const s = shop();
  const [b] = await s.say('List');
  const t = s.textOf(b);
  assert.match(t, /\*Vegetables\*/);
  assert.match(t, /• Okra – €4\.50\/kg/);
  assert.match(t, /• Kaju katli \(250 g box\) – €6\.00/);
  assert.doesNotMatch(t, /Old thing/);
  assert.doesNotMatch(t, /\(closed\)/);
});

test('order -> buttons -> confirm creates an order; a second order merges into it', async () => {
  const s = shop();
  const [ask] = await s.say('okra 1kg, 2 kaju katli, foobar');
  assert.equal(ask.type, 'interactive');
  assert.equal(ask.interactive.type, 'button');
  assert.deepEqual(
    ask.interactive.action.buttons.map((x: any) => x.reply.id),
    ['confirm', 'change'],
  );
  const body = s.textOf(ask);
  assert.match(body, /1 kg Okra — €4\.50/);
  assert.match(body, /2 × Kaju katli \(250 g box\) — €12\.00/);
  assert.match(body, /Total: €16\.50/);
  assert.match(body, /Not found: foobar/);
  const stored = s.store.getMessages(PHONE).filter((m) => m.direction === 'out').at(-1)!;
  assert.equal(stored.type, 'interactive');
  assert.equal(stored.text, body);

  const [done] = await s.say('✅ Confirm', { buttonId: 'confirm' });
  assert.match(s.textOf(done), /✅ Order #\d+ confirmed!/);
  assert.match(s.textOf(done), /Pickup: School parking/);
  assert.match(s.textOf(done), /Pay at pickup/);
  let orders = s.store.listOrders(s.run!.id);
  assert.equal(orders.length, 1);
  assert.equal(orders[0]!.source, 'bot');
  assert.equal(orders[0]!.customerName, 'Ravi');
  assert.equal(orders[0]!.totalCents, 1650);
  assert.equal(s.store.getSession(PHONE), null);

  // Second order: typed "yes" also confirms; quantities are summed.
  const [ask2] = await s.say('1 kaju katli, okra 0.5 kg');
  assert.match(s.textOf(ask2), /Adding to your order #/);
  const [done2] = await s.say('Yes');
  assert.match(s.textOf(done2), /confirmed/);
  orders = s.store.listOrders(s.run!.id);
  assert.equal(orders.length, 1);
  const byId = Object.fromEntries(orders[0]!.items.map((i) => [i.productId, i]));
  assert.equal(byId['okra']!.qty, 1.5);
  assert.equal(byId['kaju-katli']!.qty, 3);
  assert.equal(orders[0]!.totalCents, 675 + 1800);

  const [mine] = await s.say('my order');
  assert.match(s.textOf(mine), /Your order #\d+/);
  assert.match(s.textOf(mine), /1\.5 kg Okra/);
});

test('change clears the draft; confirm without a draft is harmless', async () => {
  const s = shop();
  await s.say('2 kaju');
  const [r] = await s.say('✏️ Change', { buttonId: 'change' });
  assert.match(s.textOf(r), /send your full order again/i);
  assert.equal(s.store.getSession(PHONE), null);
  const [r2] = await s.say('yes');
  assert.match(s.textOf(r2), /nothing waiting/i);
  assert.equal(s.store.listOrders(s.run!.id).length, 0);
});

test('drafts expire after 2 hours', async () => {
  const s = shop();
  await s.say('2 kaju');
  s.store.setSession(PHONE, s.store.getSession(PHONE)!.state, NOW - 3 * 3600_000);
  const [r] = await s.say('yes');
  assert.match(s.textOf(r), /nothing waiting/i);
  assert.equal(s.store.listOrders(s.run!.id).length, 0);
});

test('nothing matched -> sorry message', async () => {
  const s = shop();
  const [r] = await s.say('xyz foo');
  assert.equal(r.type, 'text');
  assert.match(s.textOf(r), /couldn't find "xyz foo"/);
  assert.match(s.textOf(r), /\*list\*/);
});

test('vegetables closed after vegCutoffAt: dropped with a note, others still ordered', async () => {
  const after = Date.UTC(2026, 10, 2, 10); // Mon 2 Nov: after veg cutoff, before general cutoff
  const s = shop(after);
  const [list] = await s.say('list');
  assert.match(s.textOf(list), /\*Vegetables\* \(closed\)/);

  const [ask] = await s.say('okra 1kg, 2 kaju katli');
  const body = s.textOf(ask);
  assert.doesNotMatch(body, /1 kg Okra/);
  assert.match(body, /2 × Kaju katli/);
  assert.match(body, /Vegetables are closed/);
  await s.say('ok');
  const [o] = s.store.listOrders(s.run!.id);
  assert.deepEqual(o!.items.map((i) => i.productId), ['kaju-katli']);

  const [onlyVeg] = await s.say('okra 1kg');
  assert.equal(onlyVeg.type, 'text');
  assert.match(s.textOf(onlyVeg), /Vegetables are closed/);
});

test('cancel cancels the order unless packed', async () => {
  const s = shop();
  await s.say('2 kaju');
  await s.say('confirm', { buttonId: 'confirm' });
  const [o] = s.store.listOrders(s.run!.id);
  s.store.updateOrder(o!.id, { status: 'packed' });
  const [no] = await s.say('cancel');
  assert.match(s.textOf(no), /already packed/);
  s.store.updateOrder(o!.id, { status: 'confirmed' });
  const [yes] = await s.say('Cancel.');
  assert.match(s.textOf(yes), /cancelled/);
  assert.equal(s.store.getOrder(o!.id)!.status, 'cancelled');
  const [none] = await s.say('my order');
  assert.match(s.textOf(none), /No order yet/);
});

test('seedIfEmpty inserts seed products, a demo run and demo orders once', () => {
  const store = new Store(':memory:');
  assert.equal(store.seedIfEmpty({ seedDemo: true, now: NOW }), true);
  const c = store.storeCounts();
  assert.equal(c.products, SEED_PRODUCTS.length);
  assert.equal(c.runs, 1);
  assert.equal(c.orders, DEMO_ORDERS.length);
  assert.ok(store.listOrders(store.listRunSummaries()[0]!.id).every((o) => o.source === 'manual' && o.totalCents > 0));
  assert.equal(store.seedIfEmpty({ seedDemo: true, now: NOW }), false);

  const bare = new Store(':memory:');
  bare.seedIfEmpty({ seedDemo: false });
  assert.deepEqual(bare.storeCounts(), { products: SEED_PRODUCTS.length, runs: 0, orders: 0 });
});
