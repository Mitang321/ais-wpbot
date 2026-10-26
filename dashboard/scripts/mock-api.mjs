// In-memory mock of the wa-server REST API (CONTRACT.md §1 + GROCERY-CONTRACT.md §1) for local dashboard work.
// Usage: node scripts/mock-api.mjs   (PORT=3000, MOCK_PASSWORD=test by default)
//
// Extras for manual testing:
//   - a fake WhatsApp bot order arrives every ~40 s (MOCK_ORDER_EVERY_MS, 0 = off) in the active delivery,
//     with the matching chat messages in the inbox
//   - sending text containing "fail" returns 502 and stores a failed message
//   - outbound statuses advance sent -> delivered (2s) -> read (5s)
//   - POST /mock/inbound { phone, text, name? } simulates a webhook message
//   - POST /mock/order simulates one bot order right now
import http from 'node:http';
import crypto from 'node:crypto';

const PORT = Number(process.env.PORT || 3000);
const PASSWORD = process.env.MOCK_PASSWORD || 'test';
const ORDER_EVERY_MS = Number(process.env.MOCK_ORDER_EVERY_MS ?? 40_000);
const STORE_NAME = 'Indian Store Marseille';
const H = 3_600_000;
const now = Date.now();

const tokens = new Map(); // token -> expiresAt
const settings = { autoReply: true, allowedPhones: [] };
const contacts = new Map(); // phone -> { phone, name, lastInboundAt, unread }
const messages = []; // Message[]

let seq = 0;
const wamid = () => `wamid.MOCK${Date.now()}${++seq}`;

function addContact(phone, name, lastInboundAt, unread = 0) {
  contacts.set(phone, { phone, name, lastInboundAt, unread });
}
function addMsg(m) {
  const msg = { id: wamid(), auto: false, type: 'text', ...m };
  messages.push(msg);
  return msg;
}

// --- products (mirrors the server seed) ------------------------------------------
const slug = (s) =>
  s
    .toLowerCase()
    .replace(/\(.*?\)/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '');

const P = (name, category, unit, priceEuro, extra = {}) => ({
  id: extra.id ?? slug(name + (extra.packLabel && unit !== 'kg' ? ` ${extra.packLabel}` : '')),
  name,
  category,
  unit,
  packLabel: extra.packLabel ?? null,
  packGrams: extra.packGrams ?? null,
  priceCents: Math.round(priceEuro * 100),
  aliases: extra.aliases ?? [],
  active: extra.active ?? true,
  sort: 0,
});

const products = [
  // Vegetables (kg unless noted)
  P('Okra (Bhindi)', 'Vegetables', 'kg', 4.5, { id: 'okra', aliases: ['bhindi', 'lady finger', 'ladyfinger'] }),
  P('Drumsticks (Saragva)', 'Vegetables', 'kg', 6.5, { id: 'drumsticks', aliases: ['drumstick', 'saragva', 'moringa'] }),
  P('Tendli (Ivy gourd)', 'Vegetables', 'kg', 5.5, { id: 'tendli', aliases: ['tindora', 'ivy gourd', 'tondli'] }),
  P('Dudhi (Bottle gourd)', 'Vegetables', 'kg', 3.5, { id: 'dudhi', aliases: ['lauki', 'bottle gourd', 'doodhi'] }),
  P('Green chilli', 'Vegetables', 'kg', 7.0, { id: 'green-chilli', aliases: ['mirchi', 'chilli', 'chili'] }),
  P('Curry leaves', 'Vegetables', 'bunch', 1.5, { id: 'curry-leaves', aliases: ['limdo', 'kadi patta', 'curry patta'] }),
  P('Coconut', 'Vegetables', 'pc', 2.0, { id: 'coconut', aliases: ['nariyal'] }),
  P('Suran (Elephant yam)', 'Vegetables', 'kg', 4.0, { id: 'suran', aliases: ['yam', 'elephant foot yam'] }),
  P('Taro (Arbi)', 'Vegetables', 'kg', 4.0, { id: 'taro', aliases: ['arbi', 'arvi', 'colocasia'] }),
  P('Small onion (Shallot)', 'Vegetables', 'kg', 3.5, { id: 'small-onion', aliases: ['sambar onion', 'shallots'] }),
  P('Raw banana', 'Vegetables', 'kg', 3.5, { id: 'raw-banana', aliases: ['kacha kela', 'plantain'] }),
  P('Flat beans (Papdi)', 'Vegetables', 'kg', 6.0, { id: 'flat-beans', aliases: ['papdi', 'valor', 'surti papdi'] }),
  P('Bitter gourd (Karela)', 'Vegetables', 'kg', 5.0, { id: 'bitter-gourd', aliases: ['karela', 'karela'] }),
  P('Parwal (Pointed gourd)', 'Vegetables', 'kg', 7.5, { id: 'parwal', aliases: ['parval', 'pointed gourd'] }),
  P('Cluster beans (Guvar)', 'Vegetables', 'kg', 6.0, { id: 'cluster-beans', aliases: ['guvar', 'gavar'] }),
  P('Brinjal (small)', 'Vegetables', 'kg', 4.5, { id: 'brinjal', aliases: ['ringan', 'baingan', 'eggplant'] }),
  P('Garlic', 'Vegetables', 'kg', 6.0, { id: 'garlic', aliases: ['lasan', 'lahsun'] }),
  P('Green papaya', 'Vegetables', 'kg', 3.5, { id: 'green-papaya', aliases: ['kacha papaya', 'papaya'] }),
  P('Drumstick leaves', 'Vegetables', 'bunch', 2.5, { id: 'drumstick-leaves', aliases: ['moringa leaves'] }),
  // Sweets
  P('Kaju katli', 'Sweets', 'pack', 6.0, { id: 'kaju-katli-250g', packLabel: '250 g box', packGrams: 250, aliases: ['kaju katri', 'kaju barfi'] }),
  P('Gulab jamun', 'Sweets', 'pack', 4.5, { id: 'gulab-jamun-1kg', packLabel: '1 kg tin', packGrams: 1000, aliases: ['gulabjamun'] }),
  P('Soan papdi', 'Sweets', 'pack', 3.5, { id: 'soan-papdi-250g', packLabel: '250 g box', packGrams: 250, aliases: ['son papdi'] }),
  P('Motichoor ladoo', 'Sweets', 'pack', 5.5, { id: 'motichoor-ladoo-400g', packLabel: '400 g box', packGrams: 400, aliases: ['ladoo', 'laddu'] }),
  // Rice & Atta
  P('Broken basmati rice', 'Rice & Atta', 'pack', 32.0, { id: 'broken-basmati-20kg', packLabel: '20 kg bag', packGrams: 20000, aliases: ['basmati', 'rice', 'chawal'] }),
  P('Basmati rice (premium)', 'Rice & Atta', 'pack', 14.0, { id: 'basmati-5kg', packLabel: '5 kg bag', packGrams: 5000, aliases: ['india gate'] }),
  P('Aashirvaad atta', 'Rice & Atta', 'pack', 9.5, { id: 'aashirvaad-atta-5kg', packLabel: '5 kg bag', packGrams: 5000, aliases: ['atta', 'flour', 'chakki atta'] }),
  P('Sona masoori rice', 'Rice & Atta', 'pack', 13.0, { id: 'sona-masoori-5kg', packLabel: '5 kg bag', packGrams: 5000, aliases: ['sona masuri'] }),
  P('Besan (gram flour)', 'Rice & Atta', 'pack', 3.0, { id: 'besan-1kg', packLabel: '1 kg', packGrams: 1000, aliases: ['gram flour', 'chana flour'] }),
  // Dal & Pulses
  P('Toor dal', 'Dal & Pulses', 'pack', 4.5, { id: 'toor-dal-1kg', packLabel: '1 kg', packGrams: 1000, aliases: ['tuvar dal', 'arhar'] }),
  P('Moong dal', 'Dal & Pulses', 'pack', 4.0, { id: 'moong-dal-1kg', packLabel: '1 kg', packGrams: 1000, aliases: ['mung dal'] }),
  P('Chana dal', 'Dal & Pulses', 'pack', 3.5, { id: 'chana-dal-1kg', packLabel: '1 kg', packGrams: 1000 }),
  P('Urad dal', 'Dal & Pulses', 'pack', 4.5, { id: 'urad-dal-1kg', packLabel: '1 kg', packGrams: 1000, aliases: ['udad dal'] }),
  P('Masoor dal', 'Dal & Pulses', 'pack', 3.5, { id: 'masoor-dal-1kg', packLabel: '1 kg', packGrams: 1000 }),
  P('Kabuli chana', 'Dal & Pulses', 'pack', 3.5, { id: 'kabuli-chana-1kg', packLabel: '1 kg', packGrams: 1000, aliases: ['chickpeas', 'chole'] }),
  // Spices
  P('Turmeric powder', 'Spices', 'pack', 2.5, { id: 'turmeric-200g', packLabel: '200 g', packGrams: 200, aliases: ['haldi'] }),
  P('Kashmiri chilli powder', 'Spices', 'pack', 3.0, { id: 'kashmiri-chilli-200g', packLabel: '200 g', packGrams: 200, aliases: ['lal mirch'] }),
  P('Garam masala (MDH)', 'Spices', 'pack', 2.5, { id: 'garam-masala-100g', packLabel: '100 g', packGrams: 100 }),
  P('Hing (asafoetida)', 'Spices', 'pack', 3.5, { id: 'hing-50g', packLabel: '50 g', packGrams: 50, aliases: ['asafoetida'] }),
  P('Jeera (cumin seeds)', 'Spices', 'pack', 3.0, { id: 'jeera-200g', packLabel: '200 g', packGrams: 200, aliases: ['cumin'] }),
  // Snacks
  P('Haldiram bhujia', 'Snacks', 'pack', 3.0, { id: 'bhujia-400g', packLabel: '400 g', packGrams: 400, aliases: ['sev', 'aloo bhujia'] }),
  P('Khakhra (methi)', 'Snacks', 'pack', 2.5, { id: 'khakhra-200g', packLabel: '200 g', packGrams: 200 }),
  P('Parle-G biscuits', 'Snacks', 'pack', 1.5, { id: 'parle-g', packLabel: 'family pack', aliases: ['parle'] }),
  // Dairy
  P('Paneer', 'Dairy', 'pack', 4.5, { id: 'paneer-400g', packLabel: '400 g block', packGrams: 400 }),
  P('Amul ghee', 'Dairy', 'pack', 12.0, { id: 'ghee-1l', packLabel: '1 L tin', aliases: ['ghee'] }),
  P('Dahi (homemade style)', 'Dairy', 'pack', 3.0, { id: 'dahi-1kg', packLabel: '1 kg tub', packGrams: 1000, aliases: ['curd', 'yogurt'] }),
  // Pickles
  P('Mango pickle', 'Pickles', 'pack', 4.0, { id: 'mango-pickle-500g', packLabel: '500 g jar', packGrams: 500, aliases: ['keri athanu', 'achar'] }),
  P('Frozen methi', 'Frozen', 'pack', 2.0, { id: 'frozen-methi', packLabel: '400 g', packGrams: 400, active: false }),
];
products.forEach((p, i) => (p.sort = (i + 1) * 10));
const productById = (id) => products.find((p) => p.id === id);

// --- runs & orders ----------------------------------------------------------------
const runs = [];
const orders = [];
let runSeq = 0;
let orderSeq = 0;

function addRun(r) {
  const run = { id: ++runSeq, status: 'open', createdAt: Date.now(), vegCutoffAt: null, ...r };
  runs.push(run);
  return run;
}

function priceItems(items) {
  const out = [];
  for (const { productId, qty } of items) {
    const p = productById(productId);
    const q = Number(qty);
    if (!p || !(q > 0)) continue;
    const existing = out.find((x) => x.productId === p.id);
    if (existing) {
      existing.qty += q;
      existing.lineTotalCents = Math.round(existing.qty * p.priceCents);
      continue;
    }
    out.push({
      productId: p.id,
      name: p.name,
      category: p.category,
      qty: q,
      unit: p.unit,
      packLabel: p.packLabel,
      unitPriceCents: p.priceCents,
      lineTotalCents: Math.round(q * p.priceCents),
    });
  }
  return out;
}

function addOrder(o) {
  const items = priceItems(o.items);
  const t = o.createdAt ?? Date.now();
  const order = {
    id: ++orderSeq,
    runId: o.runId,
    phone: o.phone ?? '',
    customerName: o.customerName,
    items,
    totalCents: items.reduce((s, x) => s + x.lineTotalCents, 0),
    status: o.status ?? 'confirmed',
    paid: o.paid ?? false,
    note: o.note ?? '',
    source: o.source ?? 'manual',
    createdAt: t,
    updatedAt: t,
  };
  orders.push(order);
  return order;
}

// Paris is UTC+2 until 25 Oct 2026, UTC+1 after.
const pastRun = addRun({
  town: 'Manosque',
  deliveryDate: '2026-10-16',
  deliveryTime: 'evening, around 6pm',
  pickupSpot: 'School parking',
  cutoffAt: Date.UTC(2026, 9, 15, 16), // Thu 15 Oct 18:00 Paris
  vegCutoffAt: Date.UTC(2026, 9, 10, 16), // Sat 10 Oct 18:00 Paris
  status: 'delivered',
  createdAt: Date.UTC(2026, 9, 1, 8),
});
const run = addRun({
  town: 'Manosque',
  deliveryDate: '2026-11-06',
  deliveryTime: 'evening, around 6pm',
  pickupSpot: 'School parking',
  cutoffAt: Date.UTC(2026, 10, 5, 17), // Thu 5 Nov 18:00 Paris
  vegCutoffAt: Date.UTC(2026, 9, 31, 17), // Sat 31 Oct 18:00 Paris
  createdAt: Date.UTC(2026, 9, 20, 8),
});

// Past delivery: all collected and paid.
for (const [name, phone, items] of [
  ['Tapan', '33612345678', [{ productId: 'okra', qty: 1 }, { productId: 'kaju-katli-250g', qty: 2 }]],
  ['Hema', '33645112233', [{ productId: 'broken-basmati-20kg', qty: 1 }, { productId: 'toor-dal-1kg', qty: 2 }]],
  ['Ravi', '', [{ productId: 'drumsticks', qty: 1 }, { productId: 'paneer-400g', qty: 2 }, { productId: 'curry-leaves', qty: 2 }]],
  ['Meera', '33611002200', [{ productId: 'aashirvaad-atta-5kg', qty: 2 }, { productId: 'gulab-jamun-1kg', qty: 1 }]],
])
  addOrder({ runId: pastRun.id, customerName: name, phone, items, status: 'collected', paid: true, createdAt: Date.UTC(2026, 9, 12, 9) });

// Current delivery: the 5 demo orders.
const DEMO = [
  {
    customerName: 'Tapan',
    phone: '33612345678',
    source: 'bot',
    items: [
      { productId: 'kaju-katli-250g', qty: 2 },
      { productId: 'okra', qty: 1 },
      { productId: 'broken-basmati-20kg', qty: 1 },
      { productId: 'curry-leaves', qty: 2 },
    ],
    createdAt: now - 46 * H,
  },
  {
    customerName: 'Soham',
    phone: '33698765432',
    source: 'bot',
    items: [
      { productId: 'drumsticks', qty: 1 },
      { productId: 'tendli', qty: 1.5 },
      { productId: 'aashirvaad-atta-5kg', qty: 1 },
      { productId: 'toor-dal-1kg', qty: 2 },
    ],
    createdAt: now - 30 * H,
    paid: true,
  },
  {
    customerName: 'Hema',
    phone: '33645112233',
    source: 'manual',
    items: [
      { productId: 'okra', qty: 2 },
      { productId: 'dudhi', qty: 1 },
      { productId: 'green-chilli', qty: 0.5 },
      { productId: 'gulab-jamun-1kg', qty: 1 },
      { productId: 'paneer-400g', qty: 2 },
    ],
    note: 'Called on the phone',
    createdAt: now - 20 * H,
  },
  {
    customerName: 'Priya',
    phone: '33677889900',
    source: 'bot',
    items: [
      { productId: 'okra', qty: 1.5 },
      { productId: 'small-onion', qty: 1 },
      { productId: 'coconut', qty: 2 },
      { productId: 'kaju-katli-250g', qty: 1 },
      { productId: 'moong-dal-1kg', qty: 1 },
    ],
    createdAt: now - 6 * H,
    status: 'packed',
  },
  {
    customerName: 'Ravi',
    phone: '',
    source: 'manual',
    items: [
      { productId: 'bitter-gourd', qty: 1 },
      { productId: 'brinjal', qty: 1 },
      { productId: 'sona-masoori-5kg', qty: 1 },
    ],
    note: 'Asked in the group',
    createdAt: now - 2 * H,
  },
];
for (const d of DEMO) addOrder({ runId: run.id, ...d });

// --- chats ------------------------------------------------------------------------
function botOrderChat(phone, name, text, order, ts) {
  if (!contacts.has(phone)) addContact(phone, name, ts, 0);
  const c = contacts.get(phone);
  c.lastInboundAt = ts;
  c.name = name;
  addMsg({ phone, direction: 'in', text, status: 'received', ts });
  const summary = order.items
    .map((i) => (i.unit === 'kg' ? `${i.qty} kg ${i.name}` : `${i.qty} × ${i.name}${i.packLabel ? ` (${i.packLabel})` : ''}`))
    .join('\n');
  addMsg({ phone, direction: 'out', type: 'interactive', text: `${summary}\n\nTotal: €${(order.totalCents / 100).toFixed(2)}`, status: 'read', auto: true, ts: ts + 2000 });
  addMsg({ phone, direction: 'in', type: 'interactive', text: '✅ Confirm', status: 'received', ts: ts + 30_000 });
  addMsg({
    phone,
    direction: 'out',
    text: `✅ Order #${order.id} confirmed!\n${summary}\nTotal: €${(order.totalCents / 100).toFixed(2)}\nPickup: ${run.pickupSpot}, Fri 6 Nov evening, around 6pm. Pay at pickup 🙏`,
    status: 'read',
    auto: true,
    ts: ts + 32_000,
  });
  c.lastInboundAt = ts + 30_000;
}

for (const o of orders.filter((x) => x.runId === run.id && x.source === 'bot')) {
  const text = o.items.map((i) => (i.unit === 'kg' ? `${i.name.split(' (')[0].toLowerCase()} ${i.qty}kg` : `${i.qty} ${i.name.toLowerCase()}`)).join(', ');
  addMsg({ phone: o.phone, direction: 'in', text: 'Hi', status: 'received', ts: o.createdAt - 120_000 });
  botOrderChat(o.phone, o.customerName, text, o, o.createdAt - 60_000);
}
addContact('33645112233', 'Hema', now - 21 * H, 1);
addMsg({ phone: '33645112233', direction: 'in', text: 'Namaste bhai, can I get paneer this time?', status: 'received', ts: now - 21 * H });

// --- fake live bot orders -----------------------------------------------------------
const FAKE_PEOPLE = [
  ['Anita', '33623456781'],
  ['Kiran', '33634567812'],
  ['Deepak', '33656781234'],
  ['Neha', '33667812345'],
  ['Arjun', '33678123456'],
  ['Pooja', '33689234567'],
  ['Vikram', '33690345678'],
  ['Sunita', '33601456789'],
];
const FAKE_BASKETS = [
  [['okra', 1], ['kaju-katli-250g', 2]],
  [['aashirvaad-atta-5kg', 1], ['toor-dal-1kg', 1], ['green-chilli', 0.5]],
  [['broken-basmati-20kg', 1], ['paneer-400g', 1]],
  [['drumsticks', 0.5], ['tendli', 1], ['curry-leaves', 1], ['coconut', 2]],
  [['gulab-jamun-1kg', 1], ['bhujia-400g', 2], ['parwal', 1]],
  [['flat-beans', 1], ['cluster-beans', 0.5], ['ghee-1l', 1]],
];
let fakeIdx = 0;
function fakeBotOrder() {
  const active = runs.find((r) => r.status === 'open');
  if (!active) return null;
  const [name, phone] = FAKE_PEOPLE[fakeIdx % FAKE_PEOPLE.length];
  const basket = FAKE_BASKETS[fakeIdx % FAKE_BASKETS.length];
  fakeIdx++;
  const ts = Date.now() - 32_000;
  const order = addOrder({
    runId: active.id,
    customerName: name,
    phone,
    source: 'bot',
    items: basket.map(([productId, qty]) => ({ productId, qty })),
    createdAt: Date.now(),
  });
  const text = basket.map(([id, q]) => `${productById(id).name.split(' (')[0].toLowerCase()} ${productById(id).unit === 'kg' ? `${q}kg` : q}`).join(', ');
  botOrderChat(phone, name, text, order, ts);
  contacts.get(phone).unread += 2;
  console.log(`[mock] new bot order #${order.id} from ${name}`);
  return order;
}
if (ORDER_EVERY_MS > 0) setInterval(fakeBotOrder, ORDER_EVERY_MS);

// --- helpers -----------------------------------------------------------------------
function conversation(phone) {
  const c = contacts.get(phone);
  const msgs = messages.filter((m) => m.phone === phone);
  const last = msgs.reduce((a, b) => (!a || b.ts > a.ts ? b : a), null);
  return {
    phone,
    name: c.name,
    lastMessageAt: last ? last.ts : 0,
    lastMessagePreview: last ? last.text.split('\n')[0].slice(0, 80) : '',
    lastInboundAt: c.lastInboundAt,
    windowOpen: c.lastInboundAt != null && Date.now() - c.lastInboundAt < 24 * H,
    unread: c.unread,
    allowed: settings.allowedPhones.includes(phone),
  };
}

function advanceStatus(msg) {
  setTimeout(() => msg.status === 'sent' && (msg.status = 'delivered'), 2000);
  setTimeout(() => msg.status === 'delivered' && (msg.status = 'read'), 5000);
}

function inbound(phone, text, name) {
  if (!contacts.has(phone)) addContact(phone, name ?? null, null, 0);
  const c = contacts.get(phone);
  if (name) c.name = name;
  c.lastInboundAt = Date.now();
  c.unread += 1;
  addMsg({ phone, direction: 'in', text, status: 'received', ts: Date.now() });
  if (settings.autoReply && (settings.allowedPhones.length === 0 || settings.allowedPhones.includes(phone))) {
    const reply = /^(hi|hello|hey|namaste|menu|help)$/i.test(text.trim())
      ? `Namaste 🙏 Welcome to ${STORE_NAME}!\nWe deliver to Manosque on Friday 6 November, evening around 6pm (School parking).\nJust type your order, e.g. *kaju katli 250g, okra 1kg*`
      : `Sorry, I couldn't find "${text}" in our list. Type *list* to see products.`;
    advanceStatus(addMsg({ phone, direction: 'out', text: reply, status: 'sent', auto: true, ts: Date.now() + 500 }));
  }
}

function runSummary(r) {
  const live = orders.filter((o) => o.runId === r.id && o.status !== 'cancelled');
  return {
    ...r,
    orderCount: live.length,
    totalCents: live.reduce((s, o) => s + o.totalCents, 0),
    paidCents: live.filter((o) => o.paid).reduce((s, o) => s + o.totalCents, 0),
  };
}

function send(res, status, body, origin) {
  res.writeHead(status, {
    'Content-Type': 'application/json',
    'Access-Control-Allow-Origin': origin || '*',
    'Access-Control-Allow-Methods': 'GET,POST,PUT,DELETE,OPTIONS',
    'Access-Control-Allow-Headers': 'Authorization, Content-Type',
    Vary: 'Origin',
  });
  res.end(status === 204 ? undefined : JSON.stringify(body));
}
const fail = (res, status, error, message, origin) => send(res, status, { ok: false, error, message }, origin);

async function readJson(req) {
  let raw = '';
  for await (const chunk of req) raw += chunk;
  if (!raw) return {};
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

const isStr = (v) => typeof v === 'string' && v.trim().length > 0;
const UNITS = ['kg', 'pack', 'pc', 'bunch'];

// --- server ------------------------------------------------------------------------------
const server = http.createServer(async (req, res) => {
  const origin = req.headers.origin;
  const url = new URL(req.url, `http://${req.headers.host}`);
  const path = url.pathname;
  if (!(req.method === 'GET' && /^\/api\/(conversations|runs)/.test(path))) console.log(req.method, req.url);

  if (req.method === 'OPTIONS') return send(res, 204, {}, origin);
  if (path === '/health')
    return send(res, 200, { ok: true, uptimeSec: Math.round(process.uptime()), rssMb: 30, store: { products: products.length, runs: runs.length, orders: orders.length } }, origin);

  const body = req.method === 'POST' || req.method === 'PUT' ? await readJson(req) : {};
  if (body === null) return fail(res, 400, 'bad_json', 'Body is not valid JSON.', origin);

  if (path === '/api/login' && req.method === 'POST') {
    if (body.password !== PASSWORD) return fail(res, 401, 'bad_password', 'Wrong password.', origin);
    const token = crypto.randomBytes(16).toString('hex');
    const expiresAt = Date.now() + 12 * H;
    tokens.set(token, expiresAt);
    return send(res, 200, { ok: true, token, expiresAt }, origin);
  }

  if (path === '/mock/inbound' && req.method === 'POST') {
    inbound(String(body.phone).replace(/\D/g, ''), String(body.text ?? ''), body.name);
    return send(res, 200, { ok: true }, origin);
  }
  if (path === '/mock/order' && req.method === 'POST') return send(res, 200, { ok: true, order: fakeBotOrder() }, origin);

  if (path.startsWith('/api/')) {
    const auth = req.headers.authorization || '';
    const tok = auth.startsWith('Bearer ') ? auth.slice(7) : '';
    const exp = tokens.get(tok);
    if (!exp || exp < Date.now()) return fail(res, 401, 'unauthorized', 'Missing or expired token.', origin);
  }

  // ---- inbox (CONTRACT.md) ----
  if (path === '/api/conversations' && req.method === 'GET') {
    const list = [...contacts.keys()].map(conversation).sort((a, b) => b.lastMessageAt - a.lastMessageAt);
    return send(res, 200, { ok: true, conversations: list }, origin);
  }

  let m = path.match(/^\/api\/conversations\/(\d+)$/);
  if (m && req.method === 'GET') {
    const phone = m[1];
    if (!contacts.has(phone)) return fail(res, 404, 'not_found', 'No conversation with this number.', origin);
    contacts.get(phone).unread = 0;
    const before = Number(url.searchParams.get('before')) || Infinity;
    const msgs = messages
      .filter((x) => x.phone === phone && x.ts < before)
      .sort((a, b) => a.ts - b.ts)
      .slice(-200);
    return send(res, 200, { ok: true, contact: conversation(phone), messages: msgs }, origin);
  }

  if (path === '/api/send' && req.method === 'POST') {
    const to = String(body.to ?? '').replace(/\D/g, '');
    const text = String(body.text ?? '').trim();
    if (!to || !text) return fail(res, 400, 'bad_request', '`to` and `text` are required.', origin);
    if (!contacts.has(to) || !conversation(to).windowOpen)
      return fail(res, 409, 'window_closed', 'The 24h window is closed. Send a template instead.', origin);
    if (/fail/i.test(text)) {
      addMsg({ phone: to, direction: 'out', text, status: 'failed', error: '(#131000) Something went wrong (mock)', ts: Date.now() });
      return fail(res, 502, 'whatsapp_error', 'WhatsApp API error: (#131000) Something went wrong (mock)', origin);
    }
    await new Promise((r) => setTimeout(r, 400));
    const msg = addMsg({ phone: to, direction: 'out', text, status: 'sent', ts: Date.now() });
    advanceStatus(msg);
    return send(res, 200, { ok: true, message: msg }, origin);
  }

  if (path === '/api/send-template' && req.method === 'POST') {
    const to = String(body.to ?? '').replace(/\D/g, '');
    const template = String(body.template ?? '').trim();
    if (!to || !template) return fail(res, 400, 'bad_request', '`to` and `template` are required.', origin);
    if (template !== 'hello_world')
      return fail(res, 502, 'whatsapp_error', `WhatsApp API error: (#132001) Template name does not exist in the translation (${template})`, origin);
    if (!contacts.has(to)) addContact(to, null, null, 0);
    const msg = addMsg({ phone: to, direction: 'out', type: 'template', text: template, status: 'sent', ts: Date.now() });
    advanceStatus(msg);
    return send(res, 200, { ok: true, message: msg }, origin);
  }

  if (path === '/api/settings' && req.method === 'GET') return send(res, 200, { ok: true, settings }, origin);
  if (path === '/api/settings' && req.method === 'PUT') {
    if (typeof body.autoReply === 'boolean') settings.autoReply = body.autoReply;
    if (Array.isArray(body.allowedPhones))
      settings.allowedPhones = [...new Set(body.allowedPhones.map((p) => String(p).replace(/\D/g, '')).filter(Boolean))];
    return send(res, 200, { ok: true, settings }, origin);
  }

  // ---- products ----
  if (path === '/api/products' && req.method === 'GET') {
    const list = [...products].sort((a, b) => a.sort - b.sort || a.name.localeCompare(b.name));
    return send(res, 200, { ok: true, products: list }, origin);
  }
  if (path === '/api/products' && req.method === 'POST') {
    if (!isStr(body.name) || !isStr(body.category) || !UNITS.includes(body.unit) || !Number.isInteger(body.priceCents) || body.priceCents < 0)
      return fail(res, 400, 'bad_request', 'name, category, unit and priceCents are required.', origin);
    let id = slug(body.name) || 'product';
    const base = id;
    for (let i = 2; productById(id); i++) id = `${base}-${i}`;
    const p = {
      id,
      name: body.name.trim(),
      category: body.category.trim(),
      unit: body.unit,
      packLabel: isStr(body.packLabel) ? body.packLabel.trim() : null,
      packGrams: Number.isFinite(body.packGrams) ? body.packGrams : null,
      priceCents: body.priceCents,
      aliases: Array.isArray(body.aliases) ? body.aliases.map((a) => String(a).toLowerCase().trim()).filter(Boolean) : [],
      active: true,
      sort: Math.max(0, ...products.map((x) => x.sort)) + 10,
    };
    products.push(p);
    return send(res, 200, { ok: true, product: p }, origin);
  }
  m = path.match(/^\/api\/products\/([^/]+)$/);
  if (m && req.method === 'PUT') {
    const p = productById(decodeURIComponent(m[1]));
    if (!p) return fail(res, 404, 'not_found', 'No such product.', origin);
    if (body.priceCents !== undefined && (!Number.isInteger(body.priceCents) || body.priceCents < 0))
      return fail(res, 400, 'bad_request', 'priceCents must be a non-negative integer.', origin);
    if (body.unit !== undefined && !UNITS.includes(body.unit)) return fail(res, 400, 'bad_request', 'Bad unit.', origin);
    for (const k of ['name', 'category', 'unit', 'packLabel', 'packGrams', 'priceCents', 'aliases', 'active'])
      if (body[k] !== undefined) p[k] = body[k];
    return send(res, 200, { ok: true, product: p }, origin);
  }

  // ---- runs ----
  if (path === '/api/runs' && req.method === 'GET') {
    const list = [...runs].sort((a, b) => b.deliveryDate.localeCompare(a.deliveryDate)).map(runSummary);
    return send(res, 200, { ok: true, runs: list }, origin);
  }
  if (path === '/api/runs' && req.method === 'POST') {
    if (!isStr(body.town) || !/^\d{4}-\d{2}-\d{2}$/.test(body.deliveryDate ?? '') || !isStr(body.deliveryTime) || !isStr(body.pickupSpot) || !Number.isFinite(body.cutoffAt))
      return fail(res, 400, 'bad_request', 'town, deliveryDate (YYYY-MM-DD), deliveryTime, pickupSpot and cutoffAt are required.', origin);
    const r = addRun({
      town: body.town.trim(),
      deliveryDate: body.deliveryDate,
      deliveryTime: body.deliveryTime.trim(),
      pickupSpot: body.pickupSpot.trim(),
      cutoffAt: body.cutoffAt,
      vegCutoffAt: Number.isFinite(body.vegCutoffAt) ? body.vegCutoffAt : null,
    });
    return send(res, 200, { ok: true, run: r }, origin);
  }
  m = path.match(/^\/api\/runs\/(\d+)$/);
  if (m && req.method === 'PUT') {
    const r = runs.find((x) => x.id === Number(m[1]));
    if (!r) return fail(res, 404, 'not_found', 'No such delivery.', origin);
    if (body.status !== undefined && !['open', 'closed', 'delivered'].includes(body.status))
      return fail(res, 400, 'bad_request', 'Bad status.', origin);
    for (const k of ['town', 'deliveryDate', 'deliveryTime', 'pickupSpot', 'cutoffAt', 'vegCutoffAt', 'status']) if (body[k] !== undefined) r[k] = body[k];
    return send(res, 200, { ok: true, run: r }, origin);
  }
  m = path.match(/^\/api\/runs\/(\d+)\/orders$/);
  if (m && req.method === 'GET') {
    const r = runs.find((x) => x.id === Number(m[1]));
    if (!r) return fail(res, 404, 'not_found', 'No such delivery.', origin);
    const list = orders.filter((o) => o.runId === r.id).sort((a, b) => a.createdAt - b.createdAt);
    return send(res, 200, { ok: true, run: r, orders: list }, origin);
  }
  m = path.match(/^\/api\/runs\/(\d+)\/broadcast$/);
  if (m && req.method === 'POST') {
    const r = runs.find((x) => x.id === Number(m[1]));
    if (!r) return fail(res, 404, 'not_found', 'No such delivery.', origin);
    const text = String(body.text ?? '').trim();
    if (!text) return fail(res, 400, 'bad_request', '`text` is required.', origin);
    let sent = 0;
    let skipped = 0;
    const done = new Set();
    for (const o of orders.filter((x) => x.runId === r.id && x.status !== 'cancelled')) {
      if (!o.phone || done.has(o.phone) || !contacts.has(o.phone) || !conversation(o.phone).windowOpen) {
        if (!done.has(o.phone)) skipped++;
        continue;
      }
      done.add(o.phone);
      advanceStatus(addMsg({ phone: o.phone, direction: 'out', text, status: 'sent', ts: Date.now() }));
      sent++;
    }
    await new Promise((res2) => setTimeout(res2, 600));
    return send(res, 200, { ok: true, sent, skipped, failed: 0 }, origin);
  }

  // ---- orders ----
  if (path === '/api/orders' && req.method === 'POST') {
    const r = runs.find((x) => x.id === Number(body.runId));
    if (!r) return fail(res, 400, 'bad_request', 'Unknown runId.', origin);
    if (!isStr(body.customerName)) return fail(res, 400, 'bad_request', 'customerName is required.', origin);
    if (!Array.isArray(body.items) || priceItems(body.items).length === 0) return fail(res, 400, 'bad_request', 'At least one valid item is required.', origin);
    const o = addOrder({
      runId: r.id,
      customerName: body.customerName.trim(),
      phone: String(body.phone ?? '').replace(/\D/g, ''),
      items: body.items,
      note: isStr(body.note) ? body.note.trim() : '',
      source: 'manual',
    });
    return send(res, 200, { ok: true, order: o }, origin);
  }
  m = path.match(/^\/api\/orders\/(\d+)$/);
  if (m && req.method === 'PUT') {
    const o = orders.find((x) => x.id === Number(m[1]));
    if (!o) return fail(res, 404, 'not_found', 'No such order.', origin);
    if (body.status !== undefined && !['confirmed', 'packed', 'collected', 'cancelled'].includes(body.status))
      return fail(res, 400, 'bad_request', 'Bad status.', origin);
    if (body.status !== undefined) o.status = body.status;
    if (typeof body.paid === 'boolean') o.paid = body.paid;
    if (typeof body.note === 'string') o.note = body.note;
    if (Array.isArray(body.items)) {
      o.items = priceItems(body.items);
      o.totalCents = o.items.reduce((s, x) => s + x.lineTotalCents, 0);
    }
    o.updatedAt = Date.now();
    return send(res, 200, { ok: true, order: o }, origin);
  }

  return fail(res, 404, 'not_found', `No route ${req.method} ${path}`, origin);
});

server.listen(PORT, () =>
  console.log(`mock wa-api on http://localhost:${PORT}  (password: ${PASSWORD}; fake bot order every ${ORDER_EVERY_MS / 1000}s)`),
);
